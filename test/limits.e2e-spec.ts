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
process.env.SIGNUPS = 'open';

jest.setTimeout(120_000);

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'limits.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;
const quietMail = {
  sendVerification: async () => true,
  sendPasswordReset: async () => true,
  sendInvitation: async () => true,
};

describe('Limits that protect the server (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let available = false;

  const makeOwner = async (label: string) => {
    const address = email(label);
    const user = await db.row<{ id: string }>(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [address, label, await hashPassword(PASSWORD)],
    );
    const org = await db.row<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      [`Limits ${label}`, `limits-${randomBytes(4).toString('hex')}`],
    );
    await db.run(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [org?.id, user?.id],
    );
    const session = request.agent(app.getHttpServer());
    await session
      .post('/api/v1/auth/login')
      .send({ email: address, password: PASSWORD })
      .expect(200);
    return session;
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
      db = app.get(DatabaseService);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping limit tests, PostgreSQL is not reachable: ${(error as Error).message}`,
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

  it('limits how many invitations one person can send in an hour', async () => {
    if (!available) return;
    const owner = await makeOwner('inviter');
    for (let i = 0; i < 20; i += 1) {
      await owner
        .post('/api/v1/orgs/current/invites')
        .send({ email: email('guest'), role: 'member' })
        .expect(201);
    }
    const response = await owner
      .post('/api/v1/orgs/current/invites')
      .send({ email: email('guest'), role: 'member' })
      .expect(429);
    expect(response.body.message).toContain('a lot of invitations');
  });

  it('lets one person own ten workspaces and no more', async () => {
    if (!available) return;
    const owner = await makeOwner('hoarder');
    for (let i = 0; i < 9; i += 1) {
      await owner
        .post('/api/v1/orgs')
        .send({ name: `Workspace ${i}` })
        .expect(201);
    }
    const response = await owner
      .post('/api/v1/orgs')
      .send({ name: 'One too many' })
      .expect(400);
    expect(response.body.message).toContain('up to 10 workspaces');
  });

  it('stops an address that keeps sending unknown agent keys', async () => {
    if (!available) return;
    for (let i = 0; i < 60; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/agent/report')
        .set('Authorization', `Bearer isk_${'a'.repeat(20)}${i}`)
        .send({ samples: [] })
        .expect(401);
    }
    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/report')
      .set('Authorization', `Bearer isk_${'b'.repeat(24)}`)
      .send({ samples: [] })
      .expect(429);
    expect(response.body.message).toContain('Too many unknown agent keys');
  });

  it('limits how many accounts one address can create in an hour', async () => {
    if (!available) return;
    const create = () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          name: 'Bulk Person',
          email: email('bulk'),
          password: PASSWORD,
        });
    for (let i = 0; i < 20; i += 1) await create().expect(201);
    await create().expect(429);
  });
});
