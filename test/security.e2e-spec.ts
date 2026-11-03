import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { totpAt } from './../src/auth/two-factor';
import { parseDotenv } from './../src/config/env';
import { DatabaseService } from './../src/database/database.service';
import { MailService } from './../src/mail/mail.service';
import { verifySignature } from './../src/webhooks/webhook.events';

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
  sendNotice: async () => true,
  sendSecurityNotice: async () => true,
  send: async () => true,
  deliver: async () => undefined,
};

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'security.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;

async function until<T>(
  read: () => Promise<T | undefined | false>,
): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the condition');
}

describe('API keys, two-factor sign-in, webhooks, audit log and single sign-on (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let available = false;
  let receiver: Server;
  let receiverUrl = '';
  const received: {
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }[] = [];

  const server = () => app.getHttpServer();
  const agent = () => request.agent(server());

  async function signUp(label: string) {
    const client = agent();
    const address = email(label);
    const created = await client
      .post('/api/v1/auth/register')
      .send({ name: label, email: address, password: PASSWORD })
      .expect(201);
    return {
      client,
      address,
      userId: created.body.user.id as string,
      orgId: created.body.organization.id as string,
    };
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
      db = app.get(DatabaseService);

      receiver = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(204);
          res.end();
        });
      });
      await new Promise<void>((resolve) =>
        receiver.listen(0, '127.0.0.1', resolve),
      );
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping security tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    if (!available) return;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await db.run(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    await app.close();
  });

  it('gives API keys exactly the access of their scopes', async () => {
    if (!available) return;
    const owner = await signUp('keys');

    const scopes = await owner.client
      .get('/api/v1/api-keys/scopes')
      .expect(200);
    expect(scopes.body.map((scope: { id: string }) => scope.id)).toContain(
      'monitors:read',
    );

    const created = await owner.client
      .post('/api/v1/api-keys')
      .send({ name: 'Dashboard', scopes: ['monitors:read'] })
      .expect(201);
    const token = created.body.token as string;
    expect(token.startsWith('isk_')).toBe(true);
    expect(JSON.stringify(created.body.key)).not.toContain(token);

    const listed = await owner.client.get('/api/v1/api-keys').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const read = await request(server())
      .get('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Number(read.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    expect(read.headers['x-ratelimit-remaining']).toBeDefined();

    await request(server())
      .post('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'tcp',
        name: 'Nope',
        config: { host: '127.0.0.1', port: 5432 },
      })
      .expect(403);
    await request(server())
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(server())
      .get('/api/v1/audit-log')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(server())
      .get('/api/v1/sso')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(server())
      .get('/api/v1/monitors')
      .set('Authorization', 'Bearer isk_0000000000_wrong')
      .expect(401);

    await owner.client
      .delete(`/api/v1/api-keys/${created.body.key.id}`)
      .expect(200);
    await request(server())
      .get('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    await owner.client
      .post('/api/v1/api-keys')
      .send({ name: 'Bad', scopes: ['everything'] })
      .expect(400);
    await owner.client
      .post('/api/v1/api-keys')
      .send({ name: '', scopes: ['monitors:read'] })
      .expect(400);
  });

  it('asks for a second step when two-factor sign-in is on, and takes recovery codes once', async () => {
    if (!available) return;
    const person = await signUp('twofa');

    expect(
      (await person.client.get('/api/v1/two-factor').expect(200)).body.enabled,
    ).toBe(false);
    const setup = await person.client
      .post('/api/v1/two-factor/setup')
      .expect(200);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);

    await person.client
      .post('/api/v1/two-factor/enable')
      .send({ code: '000000', password: PASSWORD })
      .expect(400);
    const enabled = await person.client
      .post('/api/v1/two-factor/enable')
      .send({ code: totpAt(secret, Date.now()), password: PASSWORD })
      .expect(200);
    const recovery = enabled.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);

    const fresh = agent();
    const first = await fresh
      .post('/api/v1/auth/login')
      .send({ email: person.address, password: PASSWORD })
      .expect(200);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(first.headers['set-cookie']).toBeUndefined();
    await fresh.get('/api/v1/auth/me').expect(401);

    await fresh
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: 'short', code: '123456' })
      .expect(400);
    await fresh
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: first.body.challenge, code: '000000' })
      .expect(401);

    const nextCode = totpAt(secret, Date.now() + 30_000);
    const signedIn = await fresh
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: first.body.challenge, code: nextCode })
      .expect(200);
    expect(String(signedIn.headers['set-cookie'])).toContain(
      'sentinel_session=',
    );
    await fresh.get('/api/v1/auth/me').expect(200);

    const again = await agent()
      .post('/api/v1/auth/login')
      .send({ email: person.address, password: PASSWORD })
      .expect(200);
    await agent()
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: again.body.challenge, code: nextCode })
      .expect(401);

    const viaRecovery = await agent()
      .post('/api/v1/auth/login')
      .send({ email: person.address, password: PASSWORD })
      .expect(200);
    await agent()
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: viaRecovery.body.challenge, code: recovery[0] })
      .expect(200);
    const reuse = await agent()
      .post('/api/v1/auth/login')
      .send({ email: person.address, password: PASSWORD })
      .expect(200);
    await agent()
      .post('/api/v1/auth/login/2fa')
      .send({ challenge: reuse.body.challenge, code: recovery[0] })
      .expect(401);

    const status = await fresh.get('/api/v1/two-factor').expect(200);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 9 });

    await fresh
      .post('/api/v1/two-factor/disable')
      .send({ password: 'wrong-password', code: recovery[1] })
      .expect(400);
    await fresh
      .post('/api/v1/two-factor/disable')
      .send({ password: PASSWORD, code: recovery[1] })
      .expect(204);
    const plain = await agent()
      .post('/api/v1/auth/login')
      .send({ email: person.address, password: PASSWORD })
      .expect(200);
    expect(plain.body.user.email).toBe(person.address);
  });

  it('sends signed events to a webhook and keeps a record of each delivery', async () => {
    if (!available) return;
    const owner = await signUp('hooks');

    const events = await owner.client
      .get('/api/v1/webhooks/events')
      .expect(200);
    expect(events.body.map((event: { id: string }) => event.id)).toContain(
      'monitor.status_changed',
    );

    await owner.client
      .post('/api/v1/webhooks')
      .send({
        name: 'Bad',
        url: 'ftp://example.test/x',
        events: ['monitor.status_changed'],
      })
      .expect(400);

    const created = await owner.client
      .post('/api/v1/webhooks')
      .send({
        name: 'Receiver',
        url: receiverUrl,
        events: ['monitor.status_changed', 'incident.opened'],
      })
      .expect(201);
    const secret = created.body.secret as string;
    const id = created.body.endpoint.id as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(JSON.stringify(created.body.endpoint)).not.toContain(secret);

    const before = received.length;
    const tested = await owner.client
      .post(`/api/v1/webhooks/${id}/test`)
      .expect(200);
    expect(tested.body).toMatchObject({
      status: 'success',
      eventType: 'test.ping',
      responseStatus: 204,
    });

    const hit = await until(async () => received[before]);
    expect(hit.headers['x-sentinel-event']).toBe('test.ping');
    expect(hit.headers['content-type']).toContain('application/json');
    expect(
      verifySignature(
        secret,
        String(hit.headers['x-sentinel-signature']),
        hit.body,
      ),
    ).toBe(true);
    expect(
      verifySignature(
        secret,
        String(hit.headers['x-sentinel-signature']),
        `${hit.body} `,
      ),
    ).toBe(false);
    expect(
      verifySignature(
        'whsec_other',
        String(hit.headers['x-sentinel-signature']),
        hit.body,
      ),
    ).toBe(false);
    expect(JSON.parse(hit.body)).toMatchObject({
      type: 'test.ping',
      organizationId: owner.orgId,
    });

    const deliveries = await owner.client
      .get(`/api/v1/webhooks/${id}/deliveries`)
      .expect(200);
    expect(deliveries.body.items).toHaveLength(1);
    expect(deliveries.body.items[0].status).toBe('success');

    const rotated = await owner.client
      .post(`/api/v1/webhooks/${id}/secret`)
      .expect(200);
    expect(rotated.body.secret).not.toBe(secret);

    await owner.client.delete(`/api/v1/webhooks/${id}`).expect(204);
    await owner.client.get(`/api/v1/webhooks/${id}/deliveries`).expect(404);
  });

  it('records who did what, and exports it as CSV', async () => {
    if (!available) return;
    const owner = await signUp('audit');
    const made = await owner.client
      .post('/api/v1/api-keys')
      .send({ name: 'Audited key', scopes: ['monitors:read'] })
      .expect(201);
    await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'tcp',
        name: 'Database',
        config: { host: '127.0.0.1', port: 5432 },
      })
      .expect(201);

    const page = await until(async () => {
      const response = await owner.client.get('/api/v1/audit-log').expect(200);
      const actions = response.body.items.map(
        (item: { action: string }) => item.action,
      );
      return actions.includes('api-keys.create') &&
        actions.includes('monitors.create')
        ? response
        : undefined;
    });
    const entry = page.body.items.find(
      (item: { action: string }) => item.action === 'api-keys.create',
    );
    expect(entry.actor).toMatchObject({ type: 'user', label: owner.address });
    expect(JSON.stringify(page.body)).not.toContain(made.body.token);

    const csv = await owner.client
      .get('/api/v1/audit-log?format=csv')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('api-keys.create');

    const other = await signUp('other');
    const theirs = await other.client.get('/api/v1/audit-log').expect(200);
    expect(JSON.stringify(theirs.body)).not.toContain('Audited key');
  });

  it('keeps single sign-on closed until an administrator sets it up', async () => {
    if (!available) return;
    const owner = await signUp('sso');

    const view = await owner.client.get('/api/v1/sso').expect(200);
    expect(view.body).toMatchObject({ configured: false, enabled: false });
    expect(view.body.redirectUri).toContain('/api/v1/auth/sso/callback');

    const start = await request(server())
      .get('/api/v1/auth/sso/start?org=no-such-workspace')
      .expect(302);
    expect(String(start.headers.location)).toContain(
      'sso_error=not_configured',
    );
    expect(start.headers['set-cookie']).toBeUndefined();

    const found = await request(server())
      .get('/api/v1/auth/sso/lookup?email=someone@nowhere.example')
      .expect(200);
    expect(found.body.organizations).toEqual([]);

    await owner.client
      .put('/api/v1/sso')
      .send({
        issuer: 'https://login.example.test',
        clientId: 'x',
        clientSecret: 'y',
        allowedDomains: ['example.test'],
        defaultRole: 'owner',
        autoProvision: true,
        enabled: false,
      })
      .expect(400);
  });
});
