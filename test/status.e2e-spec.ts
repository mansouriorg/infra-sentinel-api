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
import { DigestService } from './../src/reports/digest.service';
import { DomainService } from './../src/status/domain.service';
import { StatusMailer } from './../src/status/status-mailer.service';

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

const sent: {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}[] = [];
const capturingMail = {
  sendVerification: async () => true,
  sendPasswordReset: async () => true,
  sendInvitation: async () => true,
  deliver: async () => undefined,
  send: async (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }) => {
    sent.push(message);
    return true;
  },
};

const PASSWORD = 'Sup3r-secret!';
const DOMAIN = 'status.example.test';
const email = (label: string) =>
  `${label}-${randomBytes(4).toString('hex')}@${DOMAIN}`;

const binary = (
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Status pages, reports and digests (e2e)', () => {
  let app: INestApplication<App>;
  let db: DatabaseService;
  let mailer: StatusMailer;
  let domains: DomainService;
  let digest: DigestService;
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
    return {
      client,
      orgId: response.body.organization.id as string,
      userId: response.body.user.id as string,
    };
  }

  beforeAll(async () => {
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MailService)
        .useValue(capturingMail)
        .compile();
      app = moduleRef.createNestApplication();
      configureApp(app);
      await app.init();
      await app.listen(0);
      db = app.get(DatabaseService);
      mailer = app.get(StatusMailer);
      domains = app.get(DomainService);
      digest = app.get(DigestService);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping status tests, PostgreSQL is not reachable: ${(error as Error).message}`,
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

  it('needs a session for the console but not for the public page', async () => {
    if (!available) return;
    for (const path of ['status-pages', 'reports/sla', 'reports/digest']) {
      await request(server()).get(`/api/v1/${path}`).expect(401);
    }
    await request(server()).get('/status/does-not-exist').expect(404);
    await request(server())
      .get('/api/v1/public/status/does-not-exist')
      .expect(404);
    await request(server())
      .get('/status/does-not-exist/summary.json')
      .expect(404);
    await request(server())
      .get('/api/v1/public/domains/allowed?domain=nope.example.test')
      .expect(404);
  });

  it('builds a page, serves it through the /status rewrite and takes subscriptions from a plain form', async () => {
    if (!available) return;
    const owner = await signUp('Owner');
    const viewer = await signUp('Viewer');
    await db.run(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [owner.orgId, viewer.userId],
    );
    await viewer.client
      .post('/api/v1/orgs/switch')
      .send({ organizationId: owner.orgId })
      .expect(200);

    const monitor = await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'tcp',
        name: 'Internal DB name',
        config: { host: '127.0.0.1', port: 5432 },
      })
      .expect(201);
    const created = await owner.client
      .post('/api/v1/status-pages')
      .send({ name: 'Acme e2e' })
      .expect(201);
    const slug = created.body.slug as string;
    expect(slug).toBe('acme-e2e');
    await viewer.client
      .post('/api/v1/status-pages')
      .send({ name: 'Nope' })
      .expect(403);
    await viewer.client.get('/api/v1/status-pages').expect(200);

    await owner.client
      .put(`/api/v1/status-pages/${created.body.id}/components`)
      .send({
        components: [
          {
            kind: 'monitor',
            id: monitor.body.id,
            label: 'Database',
            group: 'Core',
          },
        ],
      })
      .expect(200);
    await request(server()).get(`/status/${slug}`).expect(404);
    await owner.client
      .patch(`/api/v1/status-pages/${created.body.id}`)
      .send({ published: true })
      .expect(200);

    const page = await request(server()).get(`/status/${slug}`).expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(page.text).toContain('Database');
    expect(page.text).not.toContain('Internal DB name');
    expect(page.text).toContain(`action="/status/${slug}/subscribe"`);

    const direct = await request(server())
      .get(`/api/v1/public/status/${slug}`)
      .expect(200);
    expect(direct.text).toContain(
      `action="/api/v1/public/status/${slug}/subscribe"`,
    );

    const summary = await request(server())
      .get(`/status/${slug}/summary.json`)
      .expect(200);
    expect(summary.headers['access-control-allow-origin']).toBe('*');
    expect(summary.body.components[0].name).toBe('Database');
    const rss = await request(server())
      .get(`/status/${slug}/rss.xml`)
      .expect(200);
    expect(rss.headers['content-type']).toContain('application/rss+xml');

    sent.length = 0;
    const subscribed = await request(server())
      .post(`/status/${slug}/subscribe`)
      .type('form')
      .send({ email: 'Reader@Example.test', company_url: '' })
      .expect(200);
    expect(subscribed.text).toContain('Check your inbox');
    expect(sent).toHaveLength(1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent[0].text)?.[1] as string;
    expect(token).toBeTruthy();
    await request(server())
      .get(`/status/${slug}/confirm?token=bogus`)
      .expect(400);
    const confirmed = await request(server())
      .get(`/status/${slug}/confirm?token=${token}`)
      .expect(200);
    expect(confirmed.text).toContain('You are subscribed');
    await request(server())
      .post(`/status/${slug}/subscribe`)
      .type('form')
      .send({ email: 'bad' })
      .expect(400);

    await db.run(
      `INSERT INTO incidents (org_id, number, monitor_id, monitor_name, title, severity, trigger, started_at, status)
       VALUES ($1, 1, $2, 'Internal DB name', 'raw title', 'critical', 'down', now() - interval '5 minutes', 'open')`,
      [owner.orgId, monitor.body.id],
    );
    const incident = await db.row<{ id: string }>(
      'SELECT id FROM incidents WHERE monitor_id = $1',
      [monitor.body.id],
    );
    const incidentId = incident?.id as string;
    await owner.client
      .post(`/api/v1/incidents/${incidentId}/status-updates`)
      .send({ state: 'identified', message: 'We know why.' })
      .expect(201);
    await viewer.client
      .post(`/api/v1/incidents/${incidentId}/status-updates`)
      .send({ state: 'identified', message: 'No' })
      .expect(403);
    const live = await request(server()).get(`/status/${slug}`).expect(200);
    expect(live.text).toContain('Database is unavailable');
    expect(live.text).toContain('We know why.');
    expect(live.text).not.toContain('raw title');

    sent.length = 0;
    expect(await mailer.tick()).toBeGreaterThanOrEqual(1);
    const readerMail = sent.filter(
      (message) => message.to === 'reader@example.test',
    );
    expect(readerMail).toHaveLength(1);
    expect(readerMail[0].headers?.['List-Unsubscribe']).toContain(
      `/status/${slug}/unsubscribe?token=${token}`,
    );
    const unsubscribePage = await request(server())
      .get(`/status/${slug}/unsubscribe?token=${token}`)
      .expect(200);
    expect(unsubscribePage.text).toContain('name="token"');
    await request(server())
      .post(`/status/${slug}/unsubscribe`)
      .type('form')
      .send({ token })
      .expect(200);
    const subscribers = await owner.client
      .get(`/api/v1/status-pages/${created.body.id}/subscribers`)
      .expect(200);
    expect(subscribers.body).toEqual([]);

    await owner.client
      .delete(`/api/v1/status-pages/${created.body.id}`)
      .expect(204);
    await request(server()).get(`/status/${slug}`).expect(404);
  });

  it('serves a verified custom domain at its root and blocks everything else on that host', async () => {
    if (!available) return;
    const owner = await signUp('Domain');
    const created = await owner.client
      .post('/api/v1/status-pages')
      .send({
        name: 'Custom domain e2e',
        slug: `custom-${randomBytes(3).toString('hex')}`,
      })
      .expect(201);
    await owner.client
      .patch(`/api/v1/status-pages/${created.body.id}`)
      .send({ published: true })
      .expect(200);
    const host = `status-${randomBytes(3).toString('hex')}.customer.test`;

    const set = await owner.client
      .put(`/api/v1/status-pages/${created.body.id}/domain`)
      .send({ domain: host })
      .expect(200);
    expect(set.body.domain.verified).toBe(false);
    await request(server()).get('/').set('Host', host).expect(404);
    await request(server())
      .get(`/api/v1/public/domains/allowed?domain=${host}`)
      .expect(404);
    await owner.client
      .post(`/api/v1/status-pages/${created.body.id}/domain/verify`)
      .expect(400);

    domains.resolveTxt = async () => [[set.body.domain.recordValue as string]];
    const verified = await owner.client
      .post(`/api/v1/status-pages/${created.body.id}/domain/verify`)
      .expect(200);
    expect(verified.body.domain.verified).toBe(true);
    expect(verified.body.publicUrl).toBe(`https://${host}`);
    await request(server())
      .get(`/api/v1/public/domains/allowed?domain=${host}`)
      .expect(200);

    const root = await request(server()).get('/').set('Host', host).expect(200);
    expect(root.text).toContain('action="/subscribe"');
    await request(server()).get('/rss.xml').set('Host', host).expect(200);
    await request(server()).get('/summary.json').set('Host', host).expect(200);
    await request(server())
      .get('/api/v1/auth/me')
      .set('Host', host)
      .expect(404);
    await request(server()).get('/docs').set('Host', host).expect(404);
    await request(server()).get('/api/v1/auth/me').expect(401);
  });

  it('exports the SLA report as JSON, CSV and PDF and keeps digest settings', async () => {
    if (!available) return;
    const owner = await signUp('Reports');
    const monitor = await owner.client
      .post('/api/v1/monitors')
      .send({
        type: 'tcp',
        name: '=HYPERLINK("x")',
        config: { host: '127.0.0.1', port: 5432 },
      })
      .expect(201);
    await db.run(
      `UPDATE monitors SET created_at = now() - interval '60 days' WHERE id = $1`,
      [monitor.body.id],
    );
    await db.run(
      `INSERT INTO incidents (org_id, number, monitor_id, monitor_name, title, severity, trigger, started_at, resolved_at, status)
       VALUES ($1, 1, $2, 'x', 'Outage', 'critical', 'down', now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', 'resolved')`,
      [owner.orgId, monitor.body.id],
    );

    const json = await owner.client
      .get('/api/v1/reports/sla?period=last30')
      .expect(200);
    expect(json.body.rows).toHaveLength(1);
    expect(json.body.rows[0].downtimeSec).toBe(1800);
    expect(json.body.rows[0].incidents).toBe(1);

    const csv = await owner.client
      .get('/api/v1/reports/sla?period=last30&format=csv')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(
      'attachment; filename="sla-',
    );
    expect(csv.text).toContain("'=HYPERLINK");
    const incidentsCsv = await owner.client
      .get('/api/v1/reports/sla?period=last30&format=csv-incidents')
      .expect(200);
    expect(incidentsCsv.text).toContain('Outage');

    const pdf = await owner.client
      .get('/api/v1/reports/sla?period=last30&format=pdf')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    );

    await owner.client
      .get('/api/v1/reports/sla?period=custom&from=2026-02-01')
      .expect(400);
    await owner.client.get('/api/v1/reports/sla?format=xlsx').expect(400);

    const settings = await owner.client
      .get('/api/v1/reports/digest')
      .expect(200);
    expect(settings.body.enabled).toBe(false);
    const saved = await owner.client
      .put('/api/v1/reports/digest')
      .send({
        enabled: true,
        weekday: 5,
        hour: 9,
        timeZone: 'Europe/Paris',
        recipients: 'everyone',
        extraEmails: ['boss@example.test'],
      })
      .expect(200);
    expect(saved.body.schedule).toBe('Friday at 09:00 (Europe/Paris)');
    await owner.client
      .put('/api/v1/reports/digest')
      .send({
        enabled: true,
        weekday: 5,
        hour: 9,
        timeZone: 'Nowhere/Land',
        recipients: 'everyone',
        extraEmails: [],
      })
      .expect(400);

    sent.length = 0;
    const test = await owner.client
      .post('/api/v1/reports/digest/test')
      .expect(200);
    expect(test.body.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Weekly report for');
    expect(await digest.tick()).toBeGreaterThanOrEqual(0);
  });
});
