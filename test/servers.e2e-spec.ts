import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { parseDotenv } from './../src/config/env';
import { DatabaseService } from './../src/database/database.service';
import { MailService } from './../src/mail/mail.service';
import { ServerEngine } from './../src/servers/server-engine.service';

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
const DOMAIN = 'servers.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;

const info = (name: string, machineId: string) => ({
  hostname: name,
  os: 'linux',
  platform: 'Ubuntu 24.04',
  kernel: '6.8.0-45-generic',
  arch: 'amd64',
  cpuCount: 4,
  memTotal: 8 * 2 ** 30,
  swapTotal: 0,
  bootTime: Math.floor(Date.now() / 1000) - 3600,
  ip: '10.0.0.1',
  machineId,
  docker: true,
  systemd: true,
  agentVersion: '0.5.0',
});

const samples = (cpu: number, count = 1, offsetSec = 0) =>
  Array.from({ length: count }, (_, index) => ({
    at: Math.floor(Date.now() / 1000) + offsetSec - (count - 1 - index) * 15,
    cpu,
    mem: 40,
    memUsed: 3 * 2 ** 30,
    swap: 0,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    disk: 55,
    netIn: 1000,
    netOut: 500,
  }));

const snapshot = {
  disks: [
    {
      mount: '/',
      device: '/dev/sda1',
      fs: 'ext4',
      total: 100e9,
      used: 55e9,
      pct: 55,
    },
  ],
  containers: [
    {
      id: 'c1',
      name: 'api-1',
      image: 'acme/api:1',
      state: 'running',
      health: 'healthy',
      status: 'Up 1 hour',
      createdAt: 1,
      cpu: 3.5,
      memUsed: 1000,
      memLimit: null,
      netIn: null,
      netOut: null,
    },
  ],
  processes: [
    {
      pid: 7,
      name: 'node',
      cmd: 'node main.js',
      user: 'app',
      cpu: 2,
      mem: 1,
      memBytes: 1000,
    },
  ],
  services: [],
  failedServices: [],
};

describe('Servers and the agent (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let engine: ServerEngine;
  let available = false;

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

  async function enrollMachine(
    client: ReturnType<typeof agent>,
    name: string,
    machineId: string,
  ) {
    const token = await client
      .post('/api/v1/enrollment-tokens')
      .send({ name: `Token for ${name}`, expiresInDays: 7 })
      .expect(201);
    const enrolled = await request(server())
      .post('/api/v1/agent/enroll')
      .send({ token: token.body.token, name, info: info(name, machineId) })
      .expect(200);
    return {
      tokenId: token.body.id as string,
      token: token.body.token as string,
      serverId: enrolled.body.serverId as string,
      key: enrolled.body.agentKey as string,
    };
  }

  const report = (
    key: string,
    list: unknown[],
    extra: Record<string, unknown> = snapshot,
  ) =>
    request(server())
      .post('/api/v1/agent/report')
      .set('Authorization', `Bearer ${key}`)
      .send({ agentVersion: '0.5.0', samples: list, snapshot: extra });

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
      engine = app.get(ServerEngine);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping server tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    if (!available) return;
    await db.run(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    await app.close();
  });

  it('requires a session for the console routes and a key for the agent routes', async () => {
    if (!available) return;
    for (const path of [
      'servers',
      'servers/agent-info',
      'enrollment-tokens',
      'server-rules',
    ]) {
      await request(server()).get(`/api/v1/${path}`).expect(401);
    }
    await request(server())
      .post('/api/v1/agent/report')
      .send({ samples: [], snapshot: {} })
      .expect(401);
    await report('isk_not-a-real-key', samples(10)).expect(401);
    await request(server())
      .post('/api/v1/agent/enroll')
      .send({ token: 'ist_not-a-real-token', info: info('ghost', 'mid-ghost') })
      .expect(401);
  });

  it('serves the install script and describes the agent downloads', async () => {
    if (!available) return;
    const script = await request(server())
      .get('/api/v1/agent/install.sh')
      .expect(200);
    expect(String(script.headers['content-type'])).toContain(
      'text/x-shellscript',
    );
    expect(script.text.startsWith('#!/bin/sh')).toBe(true);
    expect(script.text).not.toContain('__API_URL__');
    await request(server())
      .get('/api/v1/agent/download?os=windows&arch=amd64')
      .expect(400);
    await request(server()).get('/api/v1/agent/download?os=linux').expect(400);

    const owner = await signUp('Installer');
    const agentInfo = await owner.client
      .get('/api/v1/servers/agent-info')
      .expect(200);
    expect(typeof agentInfo.body.apiUrl).toBe('string');
    expect(Array.isArray(agentInfo.body.binaries)).toBe(true);
    expect(agentInfo.body.buildCommand).toBe('bash scripts/agent-build.sh');
  });

  it('enrolls a machine, stores its metrics, and turns a breach into a server incident', async () => {
    if (!available) return;
    const owner = await signUp('Owner');

    await owner.client
      .post('/api/v1/enrollment-tokens')
      .send({ name: '' })
      .expect(400);
    const token = await owner.client
      .post('/api/v1/enrollment-tokens')
      .send({ name: 'Fleet', expiresInDays: 7 })
      .expect(201);
    expect(token.body.token).toMatch(/^ist_/);
    const tokens = await owner.client
      .get('/api/v1/enrollment-tokens')
      .expect(200);
    expect(tokens.body).toHaveLength(1);
    expect(tokens.body[0]).not.toHaveProperty('token');
    expect(tokens.body[0].active).toBe(true);

    const enrolled = await request(server())
      .post('/api/v1/agent/enroll')
      .send({
        token: token.body.token,
        name: 'Web one',
        info: info('web-1', 'mid-web-1'),
      })
      .expect(200);
    expect(enrolled.body.name).toBe('Web one');
    expect(enrolled.body.intervalSec).toBe(15);
    expect(enrolled.body.agentKey).toMatch(/^isk_/);
    const key = enrolled.body.agentKey as string;

    const waiting = await owner.client.get('/api/v1/servers').expect(200);
    expect(waiting.body).toHaveLength(1);
    expect(waiting.body[0]).toMatchObject({
      name: 'Web one',
      status: 'pending',
      containers: null,
    });

    const sent = await report(key, samples(50, 5)).expect(200);
    expect(sent.body).toMatchObject({ ok: true, intervalSec: 15 });
    await report(key, 'nope' as unknown as unknown[]).expect(400);

    const listed = await owner.client.get('/api/v1/servers').expect(200);
    expect(listed.body[0]).toMatchObject({
      name: 'Web one',
      status: 'online',
      docker: true,
    });
    expect(listed.body[0].latest.cpu).toBe(50);
    expect(listed.body[0].containers).toEqual({
      total: 1,
      running: 1,
      problems: 0,
    });
    const id = listed.body[0].id as string;

    const detail = await owner.client.get(`/api/v1/servers/${id}`).expect(200);
    expect(detail.body.disks).toHaveLength(1);
    expect(detail.body.containerList[0].name).toBe('api-1');
    expect(detail.body.processes[0].name).toBe('node');
    await owner.client.get('/api/v1/servers/not-a-uuid').expect(400);

    const series = await owner.client
      .get(`/api/v1/servers/${id}/metrics?range=1h`)
      .expect(200);
    expect(series.body.range).toBe('1h');
    expect(series.body.points.length).toBeGreaterThan(0);
    await owner.client
      .get(`/api/v1/servers/${id}/metrics?range=2h`)
      .expect(400);

    const renamed = await owner.client
      .patch(`/api/v1/servers/${id}`)
      .send({ name: 'Web 1', tags: ['prod'] })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Web 1', tags: ['prod'] });
    await owner.client
      .patch(`/api/v1/servers/${id}`)
      .send({ tags: ['Bad Tag!'] })
      .expect(400);

    const monitor = await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'tcp',
        name: 'Web port',
        config: { host: '127.0.0.1', port: 9 },
      })
      .expect(201);
    const linked = await owner.client
      .put(`/api/v1/servers/${id}/monitors`)
      .send({ monitorIds: [monitor.body.id] })
      .expect(200);
    expect(linked.body.linkedMonitors).toHaveLength(1);
    await owner.client
      .put(`/api/v1/servers/${id}/monitors`)
      .send({ monitorIds: ['nope'] })
      .expect(400);

    const channel = await owner.client
      .post('/api/v1/channels')
      .send({
        name: 'Hook',
        type: 'webhook',
        config: { url: 'http://127.0.0.1:9/server-alerts' },
      })
      .expect(201);
    await owner.client
      .post('/api/v1/server-rules')
      .send({
        name: 'No channel',
        metric: 'cpu',
        threshold: 40,
        scope: { all: true },
      })
      .expect(400);
    await owner.client
      .post('/api/v1/server-rules')
      .send({
        name: 'Too high',
        metric: 'cpu',
        threshold: 500,
        scope: { all: true },
        channelIds: [channel.body.id],
      })
      .expect(400);
    const rule = await owner.client
      .post('/api/v1/server-rules')
      .send({
        name: 'High CPU',
        metric: 'cpu',
        threshold: 40,
        forSec: 0,
        severity: 'critical',
        scope: { all: true },
        channelIds: [channel.body.id],
      })
      .expect(201);
    expect(rule.body).toMatchObject({
      metric: 'cpu',
      mode: 'threshold',
      threshold: 40,
      forSec: 0,
      enabled: true,
    });
    expect(
      (await owner.client.get('/api/v1/server-rules').expect(200)).body,
    ).toHaveLength(1);

    await engine.tick();
    const active = await owner.client
      .get(`/api/v1/incidents?status=active&serverId=${id}`)
      .expect(200);
    expect(active.body).toHaveLength(1);
    expect(active.body[0]).toMatchObject({
      source: 'server',
      serverId: id,
      title: 'Web 1: CPU above 40%',
      severity: 'critical',
      status: 'open',
      monitorId: null,
    });
    await owner.client.get('/api/v1/incidents?serverId=nope').expect(400);
    const overview = await owner.client.get('/api/v1/servers').expect(200);
    expect(overview.body[0].openIncidents).toBe(1);
    const second = await engine.tick();
    expect(second.opened).toBe(0);

    await report(key, samples(10, 1, 5)).expect(200);
    await engine.tick();
    const recovered = await owner.client
      .get(`/api/v1/incidents?status=resolved&serverId=${id}`)
      .expect(200);
    expect(recovered.body).toHaveLength(1);
    expect(recovered.body[0].resolution).toBe('recovered');

    await db.run(
      `UPDATE incidents SET resolved_at = now() - interval '10 minutes' WHERE server_id = $1`,
      [id],
    );
    await report(key, samples(90, 1, 10)).expect(200);
    await engine.tick();
    const again = await owner.client
      .get(`/api/v1/incidents?status=active&serverId=${id}`)
      .expect(200);
    expect(again.body).toHaveLength(1);

    await owner.client
      .delete(`/api/v1/server-rules/${rule.body.id}`)
      .expect(204);
    await engine.tick();
    const closed = await owner.client
      .get(`/api/v1/incidents?status=resolved&serverId=${id}`)
      .expect(200);
    expect(closed.body.map((row: any) => row.resolution).sort()).toEqual([
      'recovered',
      'rule_removed',
    ]);

    await owner.client
      .delete(`/api/v1/enrollment-tokens/${token.body.id}`)
      .expect(204);
    await request(server())
      .post('/api/v1/agent/enroll')
      .send({
        token: token.body.token,
        name: 'Late',
        info: info('late', 'mid-late'),
      })
      .expect(401);

    await owner.client.delete(`/api/v1/servers/${id}`).expect(204);
    await owner.client.get(`/api/v1/servers/${id}`).expect(404);
    await report(key, samples(10)).expect(401);
  });

  it('clamps strange numbers and keeps the same server when a machine enrolls twice', async () => {
    if (!available) return;
    const owner = await signUp('Clamp');
    const first = await enrollMachine(owner.client, 'Db one', 'mid-db-1');
    await report(first.key, [{ ...samples(0)[0], cpu: 900, mem: -5 }]).expect(
      200,
    );
    const listed = await owner.client.get('/api/v1/servers').expect(200);
    expect(listed.body[0].latest.cpu).toBeLessThanOrEqual(100);
    expect(listed.body[0].latest.mem).toBeGreaterThanOrEqual(0);

    const again = await request(server())
      .post('/api/v1/agent/enroll')
      .send({
        token: first.token,
        name: 'Another name',
        info: info('db-1', 'mid-db-1'),
      })
      .expect(200);
    expect(again.body.serverId).toBe(first.serverId);
    expect(again.body.agentKey).not.toBe(first.key);
    expect(
      (await owner.client.get('/api/v1/servers').expect(200)).body,
    ).toHaveLength(1);
    await report(first.key, samples(10)).expect(401);
    await report(again.body.agentKey, samples(10)).expect(200);
  });

  it('keeps workspaces apart', async () => {
    if (!available) return;
    const first = await signUp('Alpha');
    const second = await signUp('Beta');
    const machine = await enrollMachine(
      first.client,
      'Alpha one',
      'mid-alpha-1',
    );
    await report(machine.key, samples(20)).expect(200);

    expect(
      (await second.client.get('/api/v1/servers').expect(200)).body,
    ).toEqual([]);
    expect(
      (await second.client.get('/api/v1/enrollment-tokens').expect(200)).body,
    ).toEqual([]);
    await second.client.get(`/api/v1/servers/${machine.serverId}`).expect(404);
    await second.client
      .get(`/api/v1/servers/${machine.serverId}/metrics?range=1h`)
      .expect(404);
    await second.client
      .patch(`/api/v1/servers/${machine.serverId}`)
      .send({ name: 'Mine now' })
      .expect(404);
    await second.client
      .delete(`/api/v1/servers/${machine.serverId}`)
      .expect(404);
    await second.client
      .delete(`/api/v1/enrollment-tokens/${machine.tokenId}`)
      .expect(404);
    expect(
      (await first.client.get('/api/v1/servers').expect(200)).body,
    ).toHaveLength(1);
  });
});
