import { AppConfig } from '../config/app-config';
import { validateEnv } from '../config/env';
import type { DatabaseService } from '../database/database.service';
import { MetricsService } from './metrics.service';

function fakeDb(options: { failing?: boolean } = {}) {
  const queries: string[] = [];
  const db = {
    poolStats: () => ({ total: 3, idle: 2, waiting: 0 }),
    row: async (text: string) => {
      queries.push(text);
      if (options.failing) throw new Error('connection refused');
      if (text.includes('pg_database_size'))
        return { size: '123456', organizations: 2, users: 5 };
      if (text.includes('notification_jobs')) return { n: 4, oldest: 12.5 };
      if (text.includes('check_results')) return { n: 9 };
      if (text.includes('webhook_deliveries')) return { n: 1 };
      return { n: 2 };
    },
    rows: async (text: string) => {
      queries.push(text);
      if (options.failing) throw new Error('connection refused');
      if (text.includes('FROM monitors'))
        return [
          { key: 'up', n: 7 },
          { key: 'down', n: 1 },
        ];
      if (text.includes('FROM incidents'))
        return [{ key: 'open', second: 'critical', n: 3 }];
      if (text.includes('FROM servers')) return [{ key: 'online', n: 2 }];
      return [{ key: 'failed', n: 6 }];
    },
  };
  return { db: db as unknown as DatabaseService, queries };
}

function service(db: DatabaseService, env: Record<string, string> = {}) {
  return new MetricsService(
    db,
    new AppConfig(validateEnv({ NODE_ENV: 'test', ...env })),
  );
}

describe('MetricsService', () => {
  it('is only enabled when a token is set', () => {
    const { db } = fakeDb();

    expect(service(db).enabled()).toBe(false);
    expect(service(db, { METRICS_TOKEN: 'x'.repeat(20) }).enabled()).toBe(true);
  });

  it('exposes database numbers with zero rows for empty groups', async () => {
    const { db } = fakeDb();

    const text = await service(db).render();

    expect(text).toContain('sentinel_database_up 1');
    expect(text).toContain('sentinel_database_size_bytes 123456');
    expect(text).toContain(
      'sentinel_database_pool_connections{state="idle"} 2',
    );
    expect(text).toContain('sentinel_organizations 2');
    expect(text).toContain('sentinel_users 5');
    expect(text).toContain('sentinel_monitors{status="up"} 7');
    expect(text).toContain('sentinel_monitors{status="down"} 1');
    expect(text).toContain('sentinel_monitors{status="paused"} 0');
    expect(text).toContain('sentinel_monitors_overdue 2');
    expect(text).toContain('sentinel_checks_last_minute 9');
    expect(text).toContain(
      'sentinel_incidents_active{severity="critical",status="open"} 3',
    );
    expect(text).toContain(
      'sentinel_incidents_active{severity="warning",status="open"} 0',
    );
    expect(text).toContain('sentinel_servers{status="online"} 2');
    expect(text).toContain('sentinel_servers{status="offline"} 0');
    expect(text).toContain('sentinel_alert_jobs_due 4');
    expect(text).toContain('sentinel_alert_jobs_oldest_age_seconds 12.5');
    expect(text).toContain(
      'sentinel_webhook_deliveries_last_hour{status="failed"} 6',
    );
    expect(text).toContain(
      'sentinel_webhook_deliveries_last_hour{status="success"} 0',
    );
    expect(text).toContain('sentinel_webhook_deliveries_due 1');
  });

  it('exposes process numbers', async () => {
    const { db } = fakeDb();

    const text = await service(db).render();

    expect(text).toMatch(/process_resident_memory_bytes \d+/);
    expect(text).toMatch(/process_cpu_seconds_total [\d.e-]+/);
    expect(text).toMatch(/process_start_time_seconds \d+/);
    expect(text).toContain('nodejs_eventloop_lag_seconds{quantile="0.99"}');
    expect(text).toContain('sentinel_build_info{');
  });

  it('records requests by method, route and status', async () => {
    const { db } = fakeDb();
    const metrics = service(db);
    metrics.observeRequest('GET', '/api/v1/health', 200, 0.02);
    metrics.observeRequest('GET', '/api/v1/health', 200, 0.3);
    metrics.observeRequest('POST', '/api/v1/auth/login', 401, 0.01);

    const text = await metrics.render();

    expect(text).toContain(
      'sentinel_http_requests_total{method="GET",route="/api/v1/health",status="200"} 2',
    );
    expect(text).toContain(
      'sentinel_http_requests_total{method="POST",route="/api/v1/auth/login",status="401"} 1',
    );
    expect(text).toContain(
      'sentinel_http_request_duration_seconds_count{method="GET",route="/api/v1/health"} 2',
    );
    expect(text).toContain(
      'sentinel_http_request_duration_seconds_bucket{method="GET",route="/api/v1/health",le="0.025"} 1',
    );
  });

  it('reports the database as down and drops stale numbers', async () => {
    const { db } = fakeDb({ failing: true });

    const text = await service(db).render();

    expect(text).toContain('sentinel_database_up 0');
    expect(text).not.toContain('sentinel_monitors{');
    expect(text).not.toContain('connection refused');
    expect(text).toContain('process_resident_memory_bytes');
  });

  it('reads the database at most once per refresh window', async () => {
    const { db, queries } = fakeDb();
    const metrics = service(db);

    await Promise.all([metrics.render(), metrics.render(), metrics.render()]);
    const first = queries.length;
    await metrics.render();

    expect(first).toBeGreaterThan(0);
    expect(queries.length).toBe(first);
  });
});
