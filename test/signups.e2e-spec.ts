import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { hashPassword } from './../src/common/crypto';
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
process.env.SIGNUPS = 'invite';

jest.setTimeout(60_000);

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'signups.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;
const quietMail = {
  sendVerification: async () => true,
  sendPasswordReset: async () => true,
  sendInvitation: async () => true,
};

describe('Sign-ups by invitation (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let available = false;
  let orgId = '';
  let ownerId = '';
  const ownerEmail = email('signup-owner');

  const register = (address: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'New Person', email: address, password: PASSWORD });

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
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping sign-up tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
      return;
    }
    const owner = await db.row<{ id: string }>(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [ownerEmail, 'Signup Owner', await hashPassword(PASSWORD)],
    );
    ownerId = owner?.id ?? '';
    const org = await db.row<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Signup tests', `signup-${randomBytes(4).toString('hex')}`],
    );
    orgId = org?.id ?? '';
    await db.run(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [orgId, ownerId],
    );
  });

  afterAll(async () => {
    if (!available) return;
    await db.run(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
    await db.run(
      `DELETE FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)`,
    );
    await app.close();
  });

  it('turns away people who were not invited', async () => {
    if (!available) return;
    const address = email('stranger');
    const response = await register(address).expect(403);
    expect(response.body.message).toContain('Sign-ups are closed');
    expect(
      await db.row('SELECT 1 FROM users WHERE email = $1', [address]),
    ).toBeUndefined();
  });

  it('lets an invited address create its account', async () => {
    if (!available) return;
    const address = email('invited');
    await db.run(
      `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'member', $3, $4, now() + interval '1 day')`,
      [orgId, address, randomBytes(16).toString('hex'), ownerId],
    );
    await register(address).expect(201);
  });

  it('keeps accepting sign-ins from existing accounts', async () => {
    if (!available) return;
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: PASSWORD })
      .expect(200);
  });
});
