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
import { NotificationsService } from './../src/notifications/notifications.service';

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
const DOMAIN = 'inbox.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;

describe('notifications, language and the setup guide (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let notifications: NotificationsService;
  let available = false;

  const server = () => app.getHttpServer();

  async function signUp(label: string) {
    const client = request.agent(server());
    const created = await client
      .post('/api/v1/auth/register')
      .send({ name: label, email: email(label), password: PASSWORD })
      .expect(201);
    return {
      client,
      userId: created.body.user.id as string,
      orgId: created.body.organization.id as string,
      me: created.body,
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
      notifications = app.get(NotificationsService);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping inbox tests, PostgreSQL is not reachable: ${(error as Error).message}`,
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

  it('keeps a private list of notifications with read state', async () => {
    if (!available) return;
    const owner = await signUp('inbox');
    const other = await signUp('elsewhere');

    const empty = await owner.client.get('/api/v1/notifications').expect(200);
    expect(empty.body).toEqual({ items: [], unread: 0, nextBefore: null });

    await notifications.publish({
      orgId: owner.orgId,
      kind: 'server.offline',
      data: { serverId: 'abc', name: 'db-1' },
    });
    await notifications.publish({
      orgId: owner.orgId,
      kind: 'webhook.disabled',
      data: { name: 'Chat', reason: 'Too many failures' },
      dedupe: 'once',
    });
    await notifications.publish({
      orgId: owner.orgId,
      kind: 'webhook.disabled',
      data: { name: 'Chat', reason: 'Too many failures' },
      dedupe: 'once',
    });

    const page = await owner.client.get('/api/v1/notifications').expect(200);
    expect(page.body.unread).toBe(2);
    expect(page.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      'webhook.disabled',
      'server.offline',
    ]);
    expect(page.body.items[1].data).toEqual({ serverId: 'abc', name: 'db-1' });

    const strangerPage = await other.client
      .get('/api/v1/notifications')
      .expect(200);
    expect(strangerPage.body.items).toHaveLength(0);

    const firstId = page.body.items[0].id as string;
    const afterOne = await owner.client
      .post('/api/v1/notifications/read')
      .send({ ids: [firstId] })
      .expect(200);
    expect(afterOne.body).toEqual({ unread: 1 });
    const unreadOnly = await owner.client
      .get('/api/v1/notifications?unread=true')
      .expect(200);
    expect(unreadOnly.body.items).toHaveLength(1);

    const afterAll = await owner.client
      .post('/api/v1/notifications/read')
      .send({ all: true })
      .expect(200);
    expect(afterAll.body).toEqual({ unread: 0 });

    await owner.client.post('/api/v1/notifications/read').send({}).expect(400);
    await owner.client.get('/api/v1/notifications?limit=0').expect(400);
    await request(server()).get('/api/v1/notifications').expect(401);
  });

  it('turns categories off per person', async () => {
    if (!available) return;
    const owner = await signUp('categories');
    await notifications.publish({
      orgId: owner.orgId,
      kind: 'server.online',
      data: { serverId: 'x', name: 'web-1' },
    });
    await notifications.publish({
      orgId: owner.orgId,
      kind: 'incident.opened',
      data: {
        incidentId: 'i',
        number: 1,
        title: 'Down',
        severity: 'critical',
        monitor: 'Site',
      },
    });

    const saved = await owner.client
      .put('/api/v1/preferences')
      .send({ notifyCategories: ['incidents'] })
      .expect(200);
    expect(saved.body.notifyCategories).toEqual(['incidents']);
    const page = await owner.client.get('/api/v1/notifications').expect(200);
    expect(page.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      'incident.opened',
    ]);
    expect(page.body.unread).toBe(1);
  });

  it('remembers the language and returns it with the signed-in user', async () => {
    if (!available) return;
    const owner = await signUp('language');
    expect(owner.me.preferences).toEqual({ locale: null });
    const defaults = await owner.client.get('/api/v1/preferences').expect(200);
    expect(defaults.body).toEqual({
      locale: null,
      notifyCategories: ['incidents', 'servers', 'team', 'system'],
    });

    await owner.client
      .put('/api/v1/preferences')
      .send({ locale: 'ar' })
      .expect(200);
    const me = await owner.client.get('/api/v1/auth/me').expect(200);
    expect(me.body.preferences).toEqual({ locale: 'ar' });

    await owner.client
      .put('/api/v1/preferences')
      .send({ locale: 'de' })
      .expect(400);
    await owner.client.put('/api/v1/preferences').send({}).expect(400);
    await owner.client
      .put('/api/v1/preferences')
      .send({ locale: null })
      .expect(200);
    expect(
      (await owner.client.get('/api/v1/auth/me').expect(200)).body.preferences,
    ).toEqual({ locale: null });
  });

  it('follows setup progress and lets admins hide the guide', async () => {
    if (!available) return;
    const owner = await signUp('guide');
    const fresh = await owner.client.get('/api/v1/onboarding').expect(200);
    expect(fresh.body).toMatchObject({
      dismissed: false,
      doneCount: 0,
      total: 5,
    });

    await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'http',
        name: 'Site',
        config: { url: 'http://127.0.0.1:9/health' },
      })
      .expect(201);
    const after = await owner.client.get('/api/v1/onboarding').expect(200);
    expect(
      after.body.steps.find((step: { id: string }) => step.id === 'monitor')
        .done,
    ).toBe(true);
    expect(after.body.doneCount).toBe(1);

    const hidden = await owner.client
      .put('/api/v1/onboarding')
      .send({ dismissed: true })
      .expect(200);
    expect(hidden.body.dismissed).toBe(true);
    expect(
      (await owner.client.get('/api/v1/onboarding').expect(200)).body.dismissed,
    ).toBe(true);
    await owner.client
      .put('/api/v1/onboarding')
      .send({ dismissed: 'yes' })
      .expect(400);
  });

  it('is not reachable with an API key', async () => {
    if (!available) return;
    const owner = await signUp('keyed');
    const created = await owner.client
      .post('/api/v1/api-keys')
      .send({ name: 'Reader', scopes: ['monitors:read'] })
      .expect(201);
    const token = created.body.token as string;
    for (const path of [
      '/api/v1/notifications',
      '/api/v1/preferences',
      '/api/v1/onboarding',
    ]) {
      await request(server())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }
  });
});
