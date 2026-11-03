import {
  fillSeries,
  foldHistory,
  num,
  percent,
  toView,
} from './monitor.format';
import type { MonitorRow } from './monitor.types';

const row: MonitorRow = {
  id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  name: 'API',
  type: 'http',
  config: {
    url: 'https://api.example.com',
    headers: { Authorization: 'Bearer x' },
  },
  interval_sec: 60,
  timeout_ms: 10_000,
  failure_threshold: 2,
  tags: ['prod'],
  paused: false,
  status: 'up',
  status_since: new Date('2026-01-01T00:00:00Z'),
  consecutive_failures: 0,
  last_checked_at: new Date('2026-01-01T00:01:00Z'),
  last_response_ms: 120,
  last_message: 'HTTP 200',
  next_check_at: new Date('2026-01-01T00:02:00Z'),
  heartbeat_token: 'secret-token',
  ssl_expires_at: null,
  created_by: null,
  created_at: new Date('2025-12-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('number helpers', () => {
  it('reads numbers that the driver returns as strings', () => {
    expect(num('42')).toBe(42);
    expect(num(7)).toBe(7);
    expect(num(null)).toBeNull();
    expect(num('abc')).toBeNull();
  });

  it('computes percentages with two decimals', () => {
    expect(percent(9995, 10000)).toBe(99.95);
    expect(percent('1', '3')).toBe(33.33);
    expect(percent(0, 0)).toBeNull();
  });
});

describe('toView', () => {
  it('masks header values and hides the heartbeat link from viewers', () => {
    const asMember = toView(row, undefined, true);
    const asViewer = toView(row, undefined, false);

    expect(asMember.config.headers).toEqual({ Authorization: '********' });
    expect(asMember.heartbeatPath).toBe('/api/v1/heartbeat/secret-token');
    expect(asViewer.heartbeatPath).toBeNull();
    expect(asMember.target).toBe('https://api.example.com');
    expect(asMember.uptime24h).toBeNull();
  });

  it('derives uptime and the average from stats', () => {
    const view = toView(
      row,
      {
        checks24h: 10,
        ups24h: 9,
        checks30d: 100,
        ups30d: 100,
        sumMs30d: 5000,
        timed30d: 50,
        latency: [100, 120],
      },
      true,
    );

    expect(view.uptime24h).toBe(90);
    expect(view.uptime30d).toBe(100);
    expect(view.avgMs).toBe(100);
    expect(view.latency).toEqual([100, 120]);
  });
});

describe('fillSeries', () => {
  const now = Date.UTC(2026, 0, 10, 12, 7, 0);

  it('returns a regular grid with gaps as empty points', () => {
    const series = fillSeries(
      '24h',
      [
        {
          at: '2026-01-10T12:00:00.000Z',
          checks: '3',
          ups: '3',
          avg_ms: '150.4',
        },
      ],
      now,
    );

    expect(series.bucketSec).toBe(900);
    expect(series.points).toHaveLength(96);
    const last = series.points[series.points.length - 1];
    expect(last.at).toBe('2026-01-10T12:00:00.000Z');
    expect(last.avgMs).toBe(150);
    expect(last.checks).toBe(3);
    expect(series.points[0].avgMs).toBeNull();
    expect(series.points[0].checks).toBe(0);
  });

  it('sizes the other ranges', () => {
    expect(fillSeries('7d', [], now).points).toHaveLength(168);
    expect(fillSeries('30d', [], now).points).toHaveLength(120);
  });
});

describe('foldHistory', () => {
  it('places each day from oldest to newest', () => {
    const result = foldHistory([
      { ago: 0, checks: 100, ups: 100 },
      { ago: 1, checks: 100, ups: 90 },
      { ago: 10, checks: 50, ups: 50 },
      { ago: 120, checks: 5, ups: 5 },
    ]);

    expect(result.history).toHaveLength(90);
    expect(result.history[89]).toBe(100);
    expect(result.history[88]).toBe(90);
    expect(result.history[79]).toBe(100);
    expect(result.history[0]).toBeNull();
    expect(result.uptime7d).toBe(95);
    expect(result.uptime90d).toBe(96.0);
  });
});
