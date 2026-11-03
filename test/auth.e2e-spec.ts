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

type Captured = {
  kind: 'verify' | 'reset' | 'invite';
  to: string;
  url: string;
};

const mail = {
  sent: [] as Captured[],
  sendVerification: async (to: string, _name: string, url: string) => {
    mail.sent.push({ kind: 'verify', to, url });
    return true;
  },
  sendPasswordReset: async (to: string, _name: string, url: string) => {
    mail.sent.push({ kind: 'reset', to, url });
    return true;
  },
  sendInvitation: async (
    to: string,
    _by: string,
    _org: string,
    _role: string,
    url: string,
  ) => {
    mail.sent.push({ kind: 'invite', to, url });
    return true;
  },
};

const PASSWORD = 'Sup3r-secret!';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@example.test`;

async function waitForMail(
  kind: Captured['kind'],
  to: string,
): Promise<Captured> {
  for (let i = 0; i < 120; i += 1) {
    const found = mail.sent.filter((m) => m.kind === kind && m.to === to).pop();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No ${kind} email for ${to}`);
}

const queryToken = (url: string) =>
  new URL(url).searchParams.get('token') as string;
const pathToken = (url: string) =>
  new URL(url).pathname.split('/').pop() as string;

describe('Accounts and organizations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let available = false;

  const server = () => app.getHttpServer();
  const agent = () => request.agent(server());
  const register = (
    client: ReturnType<typeof agent>,
    name: string,
    address: string,
  ) =>
    client
      .post('/api/v1/auth/register')
      .send({ name, email: address, password: PASSWORD });

  beforeAll(async () => {
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MailService)
        .useValue(mail)
        .compile();
      app = moduleRef.createNestApplication();
      configureApp(app);
      await app.init();
      db = app.get(DatabaseService);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping account tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    if (!available) return;
    await db.run(`DELETE FROM users WHERE email LIKE '%@example.test'`);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    await app.close();
  });

  it('registers, confirms the email, and signs out', async () => {
    if (!available) return;
    const client = agent();
    const address = email('ada');

    const created = await register(client, 'Ada', address).expect(201);
    expect(created.body.user.email).toBe(address);
    expect(created.body.user.emailVerified).toBe(false);
    expect(created.body.organization.role).toBe('owner');
    const cookie = String(created.headers['set-cookie']);
    expect(cookie).toContain('sentinel_session=');
    expect(cookie).toContain('HttpOnly');

    const verify = await waitForMail('verify', address);
    await request(server())
      .post('/api/v1/auth/verify-email')
      .send({ token: queryToken(verify.url) })
      .expect(204);

    const me = await client.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.name).toBe('Ada');
    expect(me.body.user.emailVerified).toBe(true);
    expect(me.body.organizations).toHaveLength(1);

    await request(server())
      .post('/api/v1/auth/verify-email')
      .send({ token: queryToken(verify.url) })
      .expect(400);

    await client.post('/api/v1/auth/logout').expect(204);
    await client.get('/api/v1/auth/me').expect(401);
  });

  it('validates input and rejects duplicates', async () => {
    if (!available) return;
    const address = email('dup');

    await request(server())
      .post('/api/v1/auth/register')
      .send({ name: 'Short', email: address, password: 'short' })
      .expect(400);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ name: 'Extra', email: address, password: PASSWORD, admin: true })
      .expect(400);

    await register(agent(), 'First', address).expect(201);
    await register(agent(), 'Second', address.toUpperCase()).expect(409);
  });

  it('logs in case-insensitively and rejects wrong passwords', async () => {
    if (!available) return;
    const address = email('login');
    await register(agent(), 'Lin', address).expect(201);

    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'not-the-password' })
      .expect(401);

    const client = agent();
    await client
      .post('/api/v1/auth/login')
      .send({ email: address.toUpperCase(), password: PASSWORD })
      .expect(200);
    await client.get('/api/v1/auth/me').expect(200);
  });

  it('throttles repeated failed logins', async () => {
    if (!available) return;
    const address = email('brute');
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await request(server())
        .post('/api/v1/auth/login')
        .send({ email: address, password: 'guess-number-' + i });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('resets a forgotten password once', async () => {
    if (!available) return;
    const address = email('reset');
    await register(agent(), 'Reset', address).expect(201);

    await request(server())
      .post('/api/v1/auth/forgot-password')
      .send({ email: address })
      .expect(204);
    const reset = await waitForMail('reset', address);
    const token = queryToken(reset.url);

    await request(server())
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'New-passw0rd!' })
      .expect(204);
    await request(server())
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'Another-passw0rd!' })
      .expect(400);

    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: address, password: PASSWORD })
      .expect(401);
    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'New-passw0rd!' })
      .expect(200);

    const unknown = email('nobody');
    await request(server())
      .post('/api/v1/auth/forgot-password')
      .send({ email: unknown })
      .expect(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mail.sent.some((m) => m.to === unknown)).toBe(false);
  });

  it('changes a password and signs out other devices', async () => {
    if (!available) return;
    const address = email('change');
    const phone = agent();
    const laptop = agent();
    await register(phone, 'Change', address).expect(201);
    await laptop
      .post('/api/v1/auth/login')
      .send({ email: address, password: PASSWORD })
      .expect(200);

    await laptop
      .patch('/api/v1/auth/password')
      .send({
        currentPassword: 'wrong-password',
        newPassword: 'Brand-new-pass1',
      })
      .expect(400);
    await laptop
      .patch('/api/v1/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'Brand-new-pass1' })
      .expect(204);

    await laptop.get('/api/v1/auth/me').expect(200);
    await phone.get('/api/v1/auth/me').expect(401);
  });

  it('protects organization routes', async () => {
    if (!available) return;
    await request(server()).get('/api/v1/orgs/current/members').expect(401);
    await request(server())
      .get('/api/v1/invites/not-a-real-invitation-token')
      .expect(404);
  });

  it('runs the whole team flow: invite, accept, roles, removal', async () => {
    if (!available) return;
    const ownerEmail = email('owner');
    const guestEmail = email('guest');
    const strangerEmail = email('stranger');
    const owner = agent();
    const guest = agent();
    const stranger = agent();

    const ownerMe = await register(owner, 'Olivia Owner', ownerEmail).expect(
      201,
    );
    const orgId = ownerMe.body.organization.id as string;
    await register(guest, 'Gus Guest', guestEmail).expect(201);
    await register(stranger, 'Sam Stranger', strangerEmail).expect(201);

    await owner
      .post('/api/v1/orgs/current/invites')
      .send({ email: guestEmail, role: 'owner' })
      .expect(400);
    const invited = await owner
      .post('/api/v1/orgs/current/invites')
      .send({ email: guestEmail, role: 'member' })
      .expect(201);
    expect(invited.body.emailSent).toBe(true);
    expect(invited.body.invite.role).toBe('member');

    const pending = await owner.get('/api/v1/orgs/current/invites').expect(200);
    expect(pending.body).toHaveLength(1);

    const invite = await waitForMail('invite', guestEmail);
    const token = pathToken(invite.url);

    const preview = await request(server())
      .get(`/api/v1/invites/${token}`)
      .expect(200);
    expect(preview.body.email).toBe(guestEmail);
    expect(preview.body.invitedBy).toBe('Olivia Owner');

    await stranger.post('/api/v1/invites/accept').send({ token }).expect(403);
    const accepted = await guest
      .post('/api/v1/invites/accept')
      .send({ token })
      .expect(200);
    expect(accepted.body.id).toBe(orgId);
    await guest.post('/api/v1/invites/accept').send({ token }).expect(404);

    const guestMe = await guest.get('/api/v1/auth/me').expect(200);
    expect(guestMe.body.organization.id).toBe(orgId);
    expect(guestMe.body.organization.role).toBe('member');
    expect(guestMe.body.organizations).toHaveLength(2);

    await guest
      .post('/api/v1/orgs/current/invites')
      .send({ email: email('x'), role: 'viewer' })
      .expect(403);
    const members = await guest.get('/api/v1/orgs/current/members').expect(200);
    expect(members.body.map((m: { role: string }) => m.role)).toEqual([
      'owner',
      'member',
    ]);

    const guestId = guestMe.body.user.id as string;
    const ownerId = ownerMe.body.user.id as string;

    await owner
      .patch(`/api/v1/orgs/current/members/${guestId}`)
      .send({ role: 'admin' })
      .expect(204);
    await guest
      .patch(`/api/v1/orgs/current/members/${ownerId}`)
      .send({ role: 'viewer' })
      .expect(403);
    await guest
      .patch(`/api/v1/orgs/current/members/${guestId}`)
      .send({ role: 'owner' })
      .expect(403);

    await owner
      .patch(`/api/v1/orgs/current/members/${guestId}`)
      .send({ role: 'viewer' })
      .expect(204);
    await guest.get('/api/v1/orgs/current/invites').expect(403);
    await guest.get('/api/v1/orgs/current/members').expect(200);

    await owner
      .patch('/api/v1/orgs/current')
      .send({ name: 'Renamed Org' })
      .expect(204);
    const renamed = await owner.get('/api/v1/auth/me').expect(200);
    expect(renamed.body.organization.name).toBe('Renamed Org');

    await owner.delete(`/api/v1/orgs/current/members/${ownerId}`).expect(400);
    await owner
      .patch(`/api/v1/orgs/current/members/${ownerId}`)
      .send({ role: 'admin' })
      .expect(400);

    await owner.delete(`/api/v1/orgs/current/members/${guestId}`).expect(204);
    const after = await guest.get('/api/v1/auth/me').expect(200);
    expect(after.body.organization.id).not.toBe(orgId);
    expect(after.body.organization.role).toBe('owner');
    expect(after.body.organizations).toHaveLength(1);

    const created = await guest
      .post('/api/v1/orgs')
      .send({ name: 'Second Workspace' })
      .expect(201);
    expect(created.body.role).toBe('owner');
    const personal = after.body.organization.id as string;
    await guest
      .post('/api/v1/orgs/switch')
      .send({ organizationId: personal })
      .expect(200);
    const switched = await guest.get('/api/v1/auth/me').expect(200);
    expect(switched.body.organization.id).toBe(personal);
    expect(switched.body.organizations).toHaveLength(2);
    await guest
      .post('/api/v1/orgs/switch')
      .send({ organizationId: orgId })
      .expect(404);
  });
});
