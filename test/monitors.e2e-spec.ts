import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { parseDotenv } from './../src/config/env';
import { DatabaseService } from './../src/database/database.service';
import { MailService } from './../src/mail/mail.service';
import { EventBus } from './../src/monitors/event-bus';
import { SchedulerService } from './../src/monitors/scheduler.service';

const fileEnv = (() => {
  try {
    return parseDotenv(readFileSync('.env', 'utf8'));
  } catch {
    return {} as Record<string, string>;
  }
})();

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  fileEnv.TEST_DATABASE_URL ??
  'postgres://sentinel:sentinel@localhost:5432/infra_sentinel_test';
process.env.MIGRATE_ON_BOOT = 'true';
process.env.SCHEDULER_ENABLED = 'false';

jest.setTimeout(60_000);

const quietMail = {
  sendVerification: async () => true,
  sendPasswordReset: async () => true,
  sendInvitation: async () => true,
};

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'monitoring.example.test';
const email = (label: string) => `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Chunk = { done: boolean; value?: Uint8Array };

async function readUntil(reader: { read(): Promise<Chunk> }, needle: string, limitMs = 8000): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + limitMs;
  let text = '';
  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for "${needle}", received: ${text}`);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<Chunk>((resolve) => {
      timer = setTimeout(() => resolve({ done: true, value: undefined }), remaining);
    });
    let chunk: Chunk;
    try {
      chunk = await Promise.race([reader.read(), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (chunk.done) throw new Error(`Stream ended while waiting for "${needle}", received: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe('Monitoring (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let scheduler: SchedulerService;
  let bus: EventBus;
  let available = false;
  let target: http.Server;
  let targetUrl = '';
  let targetHealthy = true;
  let port = 0;

  const server = () => app.getHttpServer();
  const agent = () => request.agent(server());

  async function signUp(label: string) {
    const client = agent();
    const response = await client
      .post('/api/v1/auth/register')
      .send({ name: label, email: email(label.toLowerCase()), password: PASSWORD })
      .expect(201);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    return { client, cookie, userId: response.body.user.id as string, orgId: response.body.organization.id as string };
  }

  beforeAll(async () => {
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MailService)
        .useValue(quietMail)
        .compile();
      app = moduleRef.createNestApplication();
      configureApp(app);
      await app.init();
      await app.listen(0);
      port = (server().address() as AddressInfo).port;
      db = app.get(DatabaseService);
      scheduler = app.get(SchedulerService);
      bus = app.get(EventBus);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping monitoring tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
      return;
    }

    target = http.createServer((incoming, outgoing) => {
      outgoing.statusCode = incoming.url === '/health' && targetHealthy ? 200 : 503;
      outgoing.end('target');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!available) return;
    await scheduler.drain(2000);
    await db.run(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await app.close();
  });

  it('requires a session for everything except heartbeats', async () => {
    if (!available) return;
    await request(server()).get('/api/v1/monitors').expect(401);
    await request(server()).get('/api/v1/overview').expect(401);
    await request(server()).get('/api/v1/stream').expect(401);
    await request(server()).get('/api/v1/heartbeat/unknown-token-value').expect(404);
  });

  it('runs a monitor through its whole life', async () => {
    if (!available) return;
    const owner = await signUp('Owner');

    const created = await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'http',
        name: 'Shop',
        failureThreshold: 2,
        config: { url: `${targetUrl}/health`, headers: { 'X-Token': 'abc' } },
      })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe('pending');
    expect(created.body.config.headers).toEqual({ 'X-Token': '********' });

    const first = await owner.client.post(`/api/v1/monitors/${id}/check`).expect(200);
    expect(first.body.status).toBe('up');
    expect(first.body.lastResponseMs).toBeGreaterThanOrEqual(1);

    targetHealthy = false;
    await owner.client.post(`/api/v1/monitors/${id}/check`).expect(200);
    const down = await owner.client.post(`/api/v1/monitors/${id}/check`).expect(200);
    expect(down.body.status).toBe('down');
    expect(down.body.events[0].kind).toBe('down');

    targetHealthy = true;
    const back = await owner.client.post(`/api/v1/monitors/${id}/check`).expect(200);
    expect(back.body.status).toBe('up');
    expect(back.body.events[0].kind).toBe('up');

    const list = await owner.client.get('/api/v1/monitors').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].uptime24h).toBeGreaterThan(0);

    const series = await owner.client.get(`/api/v1/monitors/${id}/series?range=24h`).expect(200);
    expect(series.body.points).toHaveLength(96);
    await owner.client.get(`/api/v1/monitors/${id}/series?range=2y`).expect(400);

    const overview = await owner.client.get('/api/v1/overview').expect(200);
    expect(overview.body.counts.total).toBe(1);
    expect(overview.body.counts.up).toBe(1);
    expect(overview.body.events.length).toBeGreaterThanOrEqual(3);

    await owner.client.post(`/api/v1/monitors/${id}/pause`).expect(200);
    await owner.client.post(`/api/v1/monitors/${id}/check`).expect(400);
    const resumed = await owner.client.post(`/api/v1/monitors/${id}/resume`).expect(200);
    expect(resumed.body.status).toBe('pending');

    const renamed = await owner.client
      .patch(`/api/v1/monitors/${id}`)
      .send({ name: 'Shop (EU)', config: { url: `${targetUrl}/health`, headers: { 'X-Token': '********' } } })
      .expect(200);
    expect(renamed.body.name).toBe('Shop (EU)');
    const stored = await db.row<{ config: { headers: Record<string, string> } }>(
      'SELECT config FROM monitors WHERE id = $1',
      [id],
    );
    expect(stored?.config.headers['X-Token']).toBe('abc');

    await owner.client.delete(`/api/v1/monitors/${id}`).expect(204);
    await owner.client.get(`/api/v1/monitors/${id}`).expect(404);
  });

  it('validates input', async () => {
    if (!available) return;
    const owner = await signUp('Validator');

    await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'http', name: 'Bad', config: { url: 'not a url' } })
      .expect(400);
    await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'ssl', name: 'Cert', intervalSec: 60, config: { host: 'example.com' } })
      .expect(400);
    await owner.client.get('/api/v1/monitors/not-a-uuid').expect(400);
    await owner.client
      .post('/api/v1/monitors/test')
      .send({ type: 'heartbeat', name: 'Job', intervalSec: 60, config: {} })
      .expect(400);
  });

  it('tests a check without saving it', async () => {
    if (!available) return;
    const owner = await signUp('Tester');

    const result = await owner.client
      .post('/api/v1/monitors/test')
      .send({ type: 'http', name: 'Try', config: { url: `${targetUrl}/health` } })
      .expect(200);
    expect(result.body.status).toBe('up');
    expect(result.body.statusCode).toBe(200);

    const list = await owner.client.get('/api/v1/monitors').expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('keeps organizations apart and enforces roles', async () => {
    if (!available) return;
    const owner = await signUp('Boss');
    const viewer = await signUp('Watcher');
    const stranger = await signUp('Outsider');

    const created = await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'tcp', name: 'DB', config: { host: '127.0.0.1', port } })
      .expect(201);
    const id = created.body.id as string;

    await db.run(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [
      owner.orgId,
      viewer.userId,
    ]);
    await viewer.client.post('/api/v1/orgs/switch').send({ organizationId: owner.orgId }).expect(200);

    const seen = await viewer.client.get('/api/v1/monitors').expect(200);
    expect(seen.body).toHaveLength(1);
    await viewer.client.get(`/api/v1/monitors/${id}`).expect(200);
    await viewer.client
      .post('/api/v1/monitors')
      .send({ type: 'ping', name: 'No', config: { host: 'example.com' } })
      .expect(403);
    await viewer.client.post(`/api/v1/monitors/${id}/pause`).expect(403);
    await viewer.client.delete(`/api/v1/monitors/${id}`).expect(403);

    await stranger.client.get(`/api/v1/monitors/${id}`).expect(404);
    await stranger.client.patch(`/api/v1/monitors/${id}`).send({ name: 'Mine now' }).expect(404);
    await stranger.client.delete(`/api/v1/monitors/${id}`).expect(404);
    const empty = await stranger.client.get('/api/v1/monitors').expect(200);
    expect(empty.body).toHaveLength(0);
  });

  it('accepts heartbeats and hides the secret link from viewers', async () => {
    if (!available) return;
    const owner = await signUp('Cron');
    const viewer = await signUp('Reader');

    const created = await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'heartbeat', name: 'Backup job', intervalSec: 300, config: { graceSec: 30 } })
      .expect(201);
    const id = created.body.id as string;
    const path = created.body.heartbeatPath as string;
    expect(path).toMatch(/^\/api\/v1\/heartbeat\/.{20,}$/);

    await db.run(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [
      owner.orgId,
      viewer.userId,
    ]);
    await viewer.client.post('/api/v1/orgs/switch').send({ organizationId: owner.orgId }).expect(200);
    const hidden = await viewer.client.get(`/api/v1/monitors/${id}`).expect(200);
    expect(hidden.body.heartbeatPath).toBeNull();

    await request(server()).get(path).expect(200, { ok: true });
    let detail = await owner.client.get(`/api/v1/monitors/${id}`).expect(200);
    expect(detail.body.status).toBe('up');

    await request(server()).post(`${path}/fail`).expect(200, { ok: true });
    detail = await owner.client.get(`/api/v1/monitors/${id}`).expect(200);
    expect(detail.body.status).toBe('down');

    await owner.client.post(`/api/v1/monitors/${id}/check`).expect(400);
  });

  it('lets the scheduler run due monitors', async () => {
    if (!available) return;
    const owner = await signUp('Scheduled');
    const created = await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'tcp', name: 'Port', config: { host: '127.0.0.1', port } })
      .expect(201);

    await db.run(`UPDATE monitors SET next_check_at = now() + interval '1 hour' WHERE id <> $1`, [created.body.id]);
    expect(await scheduler.tick()).toBe(1);
    await scheduler.drain();

    const detail = await owner.client.get(`/api/v1/monitors/${created.body.id}`).expect(200);
    expect(detail.body.status).toBe('up');
    expect(detail.body.recentChecks).toHaveLength(1);
  });

  it('streams live updates as server-sent events', async () => {
    if (!available) return;
    const owner = await signUp('Streamer');
    const created = await owner.client
      .post('/api/v1/monitors')
      .send({ type: 'http', name: 'Live', config: { url: `${targetUrl}/health` } })
      .expect(201);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, {
      headers: { cookie: owner.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    try {
      await readUntil(reader, 'retry: 3000');
      await owner.client.post(`/api/v1/monitors/${created.body.id}/check`).expect(200);
      const text = await readUntil(reader, 'event: check');
      expect(text).toContain(`"monitorId":"${created.body.id}"`);
    } finally {
      controller.abort();
    }

    for (let attempt = 0; attempt < 40 && bus.listenerCount(owner.orgId) > 0; attempt += 1) {
      await sleep(50);
    }
    expect(bus.listenerCount(owner.orgId)).toBe(0);
  });
});
