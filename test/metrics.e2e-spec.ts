import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { parseDotenv } from './../src/config/env';

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

const TOKEN = 'metrics-e2e-token-0123456789';

async function start(token: string): Promise<INestApplication<App>> {
  process.env.METRICS_TOKEN = token;
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

describe('Platform metrics (e2e)', () => {
  let app: INestApplication<App>;
  let available = false;

  beforeAll(async () => {
    try {
      app = await start(TOKEN);
      available = true;
    } catch (error) {
      if (process.env.REQUIRE_DB) throw error;
      console.warn(
        `Skipping metrics tests, PostgreSQL is not reachable: ${(error as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    if (available) await app.close();
  });

  it('asks for the token and never accepts it in the URL', async () => {
    if (!available) return;

    const none = await request(app.getHttpServer()).get('/metrics').expect(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
    await request(app.getHttpServer())
      .get(`/metrics?token=${TOKEN}`)
      .expect(401);
  });

  it('serves Prometheus text with database and process numbers', async () => {
    if (!available) return;

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('sentinel_database_up 1');
    expect(res.text).toMatch(/sentinel_monitors\{status="up"\} \d+/);
    expect(res.text).toMatch(/process_resident_memory_bytes \d+/);
    expect(res.text).toContain('# TYPE sentinel_build_info gauge');
  });

  it('counts requests by route template and keeps ids and unknown paths out of the labels', async () => {
    if (!available) return;
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/nothing/here/3f2a9c').expect(404);

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.text).toMatch(
      /sentinel_http_requests_total\{method="GET",route="\/api\/v1\/health",status="200"\} [2-9]/,
    );
    expect(res.text).toContain('route="/api/v1/auth/me",status="401"');
    expect(res.text).toContain('route="unmatched",status="404"');
    expect(res.text).not.toContain('3f2a9c');
    expect(res.text).not.toContain('route="/metrics"');
    expect(res.text).toMatch(
      /sentinel_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/health"\} [2-9]/,
    );
  });

  it('answers HEAD and refuses writes', async () => {
    if (!available) return;

    await request(app.getHttpServer())
      .head('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    const post = await request(app.getHttpServer())
      .post('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('does not exist when no token is configured', async () => {
    if (!available) return;
    const closed = await start('');

    await request(closed.getHttpServer()).get('/metrics').expect(404);
    await request(closed.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(404);
    await closed.close();
  });
});
