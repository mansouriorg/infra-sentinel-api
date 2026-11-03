import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { DatabaseService } from './../src/database/database.service';

process.env.SCHEDULER_ENABLED = 'false';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('GET /api/v1/health returns ok without signing in', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('infra-sentinel-api');
  });

  it('GET / is not exposed', () => {
    return request(app.getHttpServer()).get('/').expect(404);
  });

  it('protects everything else by default', () => {
    return request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
