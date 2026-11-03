import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AlertEngine } from './../src/alerting/alert-engine.service';
import { configureApp } from './../src/app.setup';
import { parseDotenv } from './../src/config/env';
import { DatabaseService } from './../src/database/database.service';
import { MailService } from './../src/mail/mail.service';

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
  deliver: async () => undefined,
};

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'alerting.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;

describe('Alerting (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let engine: AlertEngine;
  let available = false;
  let target: http.Server;
  let targetUrl = '';
  let targetHealthy = true;
  let receiver: http.Server;
  let receiverUrl = '';
  const received: { url: string; event: string; body: any }[] = [];

  const server = () => app.getHttpServer();
  const agent = () => request.agent(server());

  async function signUp(label: string) {
    const client = agent();
    const response = await client
      .post('/api/v1/auth/register')
      .send({
        name: label,
        email: email(label.toLowerCase()),
        password: PASSWORD,
      })
      .expect(201);
    return { client, orgId: response.body.organization.id as string };
  }

  const listen = async (handler: http.RequestListener) => {
    const instance = http.createServer(handler);
    await new Promise<void>((resolve) =>
      instance.listen(0, '127.0.0.1', resolve),
    );
    return {
      instance,
      url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    };
  };

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
      db = app.get(DatabaseService);
      engine = app.get(AlertEngine);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping alerting tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
      return;
    }

    const health = await listen((incoming, outgoing) => {
      outgoing.statusCode =
        incoming.url === '/health' && targetHealthy ? 200 : 503;
      outgoing.end('target');
    });
    target = health.instance;
    targetUrl = health.url;

    const hooks = await listen((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        let body: any = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        received.push({
          url: incoming.url ?? '',
          event: String(incoming.headers['x-sentinel-event'] ?? ''),
          body,
        });
        outgoing.statusCode = 200;
        outgoing.end('ok');
      });
    });
    receiver = hooks.instance;
    receiverUrl = hooks.url;
  });

  afterAll(async () => {
    if (!available) return;
    await engine.drain(2000);
    await db.run(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    for (const instance of [target, receiver]) {
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
    await app.close();
  });

  it('requires a session for every alerting route', async () => {
    if (!available) return;
    for (const path of [
      'channels',
      'alert-rules',
      'escalation-policies',
      'oncall-schedules',
      'silences',
      'maintenance-windows',
      'incidents',
      'incidents/summary',
    ]) {
      await request(server()).get(`/api/v1/${path}`).expect(401);
    }
  });

  it('turns a failing monitor into an incident, notifies, and walks it to resolved', async () => {
    if (!available) return;
    const owner = await signUp('Owner');

    const channel = await owner.client
      .post('/api/v1/channels')
      .send({
        name: 'Hook',
        type: 'webhook',
        config: { url: `${receiverUrl}/alerts`, secret: 'topsecret' },
      })
      .expect(201);
    expect(channel.body.config.url).toBe('********');
    expect(channel.body.config.secret).toBe('********');

    const tested = await owner.client
      .post('/api/v1/channels/test')
      .send({ channelId: channel.body.id })
      .expect(200);
    expect(tested.body).toEqual({ ok: true });
    expect(received.some((entry) => entry.url === '/alerts')).toBe(true);

    await owner.client
      .post('/api/v1/alert-rules')
      .send({ name: 'Needs a target', scope: { all: true } })
      .expect(400);
    const rule = await owner.client
      .post('/api/v1/alert-rules')
      .send({
        name: 'Everything down',
        scope: { all: true },
        channelIds: [channel.body.id],
        severity: 'critical',
      })
      .expect(201);
    expect(rule.body.forSec).toBe(0);

    const monitor = await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'http',
        name: 'Storefront',
        failureThreshold: 2,
        config: { url: `${targetUrl}/health` },
      })
      .expect(201);
    const monitorId = monitor.body.id as string;

    await owner.client.post(`/api/v1/monitors/${monitorId}/check`).expect(200);
    await engine.tick();
    await engine.drain();
    const quiet = await owner.client
      .get('/api/v1/incidents?status=active')
      .expect(200);
    expect(quiet.body).toEqual([]);

    targetHealthy = false;
    await owner.client.post(`/api/v1/monitors/${monitorId}/check`).expect(200);
    const down = await owner.client
      .post(`/api/v1/monitors/${monitorId}/check`)
      .expect(200);
    expect(down.body.status).toBe('down');

    await engine.tick();
    await engine.drain();

    const active = await owner.client
      .get('/api/v1/incidents?status=active')
      .expect(200);
    expect(active.body).toHaveLength(1);
    const incident = active.body[0];
    expect(incident.number).toBe(1);
    expect(incident.title).toBe('Storefront is down');
    expect(incident.severity).toBe('critical');
    expect(incident.status).toBe('open');
    expect(incident.notified).toBe(1);
    const opened = received.filter(
      (entry) => entry.event === 'incident.opened',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0].body.incident.number).toBe(1);

    const summary = await owner.client
      .get('/api/v1/incidents/summary')
      .expect(200);
    expect(summary.body.open).toBe(1);
    expect(summary.body.active).toHaveLength(1);

    const detail = await owner.client
      .get(`/api/v1/incidents/${incident.id}`)
      .expect(200);
    expect(detail.body.events.map((event: any) => event.kind)).toEqual([
      'opened',
      'notified',
    ]);
    expect(detail.body.notifications).toHaveLength(1);
    expect(detail.body.notifications[0].status).toBe('sent');

    await request(server()).get(`/api/v1/incidents/${incident.id}`).expect(401);
    await owner.client.get('/api/v1/incidents/not-a-uuid').expect(400);
    await owner.client.get('/api/v1/incidents?monitorId=nope').expect(400);
    await owner.client.get('/api/v1/incidents?status=weird').expect(400);

    const acknowledged = await owner.client
      .post(`/api/v1/incidents/${incident.id}/acknowledge`)
      .send({ message: 'On it' })
      .expect(200);
    expect(acknowledged.body.status).toBe('acknowledged');
    expect(acknowledged.body.acknowledgedBy.name).toBe('Owner');

    await owner.client
      .post(`/api/v1/incidents/${incident.id}/notes`)
      .send({ message: 'Checking the CDN' })
      .expect(201);
    const postmortem = await owner.client
      .put(`/api/v1/incidents/${incident.id}/postmortem`)
      .send({ text: '## Summary\nThe origin returned 503.' })
      .expect(200);
    expect(postmortem.body.postmortem).toContain('origin returned 503');

    targetHealthy = true;
    await owner.client.post(`/api/v1/monitors/${monitorId}/check`).expect(200);
    await engine.tick();
    await engine.drain();

    const resolved = await owner.client
      .get('/api/v1/incidents?status=resolved')
      .expect(200);
    expect(resolved.body).toHaveLength(1);
    expect(resolved.body[0].resolution).toBe('recovered');
    expect(
      received.filter((entry) => entry.event === 'incident.resolved'),
    ).toHaveLength(1);

    const final = await owner.client
      .get(`/api/v1/incidents/${incident.id}`)
      .expect(200);
    const kinds = final.body.events.map((event: any) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'opened',
        'notified',
        'acknowledged',
        'note',
        'postmortem',
        'resolved',
      ]),
    );
  });

  it('protects channels and rules that are in use and keeps workspaces apart', async () => {
    if (!available) return;
    const first = await signUp('First');
    const second = await signUp('Second');

    const channel = await first.client
      .post('/api/v1/channels')
      .send({
        name: 'Hook',
        type: 'webhook',
        config: { url: `${receiverUrl}/other` },
      })
      .expect(201);
    const rule = await first.client
      .post('/api/v1/alert-rules')
      .send({
        name: 'Rule',
        scope: { tags: ['prod'] },
        channelIds: [channel.body.id],
      })
      .expect(201);

    await first.client
      .delete(`/api/v1/channels/${channel.body.id}`)
      .expect(409);
    await second.client
      .delete(`/api/v1/channels/${channel.body.id}`)
      .expect(404);
    await second.client
      .patch(`/api/v1/alert-rules/${rule.body.id}`)
      .send({ enabled: false })
      .expect(404);
    expect(
      (await second.client.get('/api/v1/channels').expect(200)).body,
    ).toEqual([]);

    const patched = await first.client
      .patch(`/api/v1/alert-rules/${rule.body.id}`)
      .send({ enabled: false, forSec: 120 })
      .expect(200);
    expect(patched.body.enabled).toBe(false);
    expect(patched.body.forSec).toBe(120);
    expect(patched.body.scope.tags).toEqual(['prod']);

    await first.client
      .delete(`/api/v1/alert-rules/${rule.body.id}`)
      .expect(204);
    await first.client
      .delete(`/api/v1/channels/${channel.body.id}`)
      .expect(204);
  });

  it('manages silences and maintenance windows', async () => {
    if (!available) return;
    const owner = await signUp('Planner');
    const silence = await owner.client
      .post('/api/v1/silences')
      .send({
        name: 'Deploy',
        scope: { all: true },
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);
    expect(silence.body.active).toBe(true);
    await owner.client
      .post('/api/v1/silences')
      .send({
        name: 'Backwards',
        scope: { all: true },
        endsAt: new Date(Date.now() - 1000).toISOString(),
      })
      .expect(400);

    const window = await owner.client
      .post('/api/v1/maintenance-windows')
      .send({
        name: 'Weekly patching',
        scope: { tags: ['db'] },
        startsAt: new Date().toISOString(),
        durationSec: 3600,
        repeat: 'weekly',
      })
      .expect(201);
    expect(window.body.repeat).toBe('weekly');
    await owner.client
      .patch(`/api/v1/maintenance-windows/${window.body.id}`)
      .send({ durationSec: 7200 })
      .expect(200);
    expect(
      (await owner.client.get('/api/v1/maintenance-windows').expect(200))
        .body[0].durationSec,
    ).toBe(7200);

    await owner.client
      .delete(`/api/v1/silences/${silence.body.id}`)
      .expect(204);
    await owner.client
      .delete(`/api/v1/maintenance-windows/${window.body.id}`)
      .expect(204);
    expect(
      (await owner.client.get('/api/v1/silences').expect(200)).body,
    ).toEqual([]);
  });
});
