import type { Db } from '../database/executor';
import {
  fillSeries,
  foldHistory,
  num,
  SERIES_SPEC,
  toCheck,
  toEvent,
  type MonitorStats,
} from './monitor.format';
import type {
  CheckView,
  EventView,
  Series,
  SeriesRange,
} from './monitor.types';

const STATS_SQL = `
  SELECT r.monitor_id AS monitor_id,
         COALESCE(sum(r.checks) FILTER (WHERE r.bucket >= now() - interval '24 hours'), 0)::float8 AS checks24h,
         COALESCE(sum(r.ups) FILTER (WHERE r.bucket >= now() - interval '24 hours'), 0)::float8 AS ups24h,
         COALESCE(sum(r.checks), 0)::float8 AS checks30d,
         COALESCE(sum(r.ups), 0)::float8 AS ups30d,
         COALESCE(sum(r.sum_ms), 0)::float8 AS sum_ms30d,
         COALESCE(sum(r.timed), 0)::float8 AS timed30d
    FROM monitor_rollups r
    JOIN monitors m ON m.id = r.monitor_id
   WHERE m.org_id = $1
     AND ($2::uuid IS NULL OR m.id = $2::uuid)
     AND r.bucket >= now() - interval '30 days'
   GROUP BY r.monitor_id`;

const SPARK_SQL = `
  SELECT r.monitor_id AS monitor_id,
         array_agg((r.sum_ms::float8 / r.timed) ORDER BY r.bucket) AS latency
    FROM monitor_rollups r
    JOIN monitors m ON m.id = r.monitor_id
   WHERE m.org_id = $1
     AND ($2::uuid IS NULL OR m.id = $2::uuid)
     AND r.bucket >= now() - interval '24 hours'
     AND r.timed > 0
   GROUP BY r.monitor_id`;

export async function loadStats(
  db: Db,
  orgId: string,
  monitorId: string | null = null,
): Promise<Map<string, MonitorStats>> {
  const [totals, sparks] = await Promise.all([
    db.rows(STATS_SQL, [orgId, monitorId]),
    db.rows(SPARK_SQL, [orgId, monitorId]),
  ]);
  const result = new Map<string, MonitorStats>();
  for (const row of totals) {
    result.set(row.monitor_id, {
      checks24h: num(row.checks24h) ?? 0,
      ups24h: num(row.ups24h) ?? 0,
      checks30d: num(row.checks30d) ?? 0,
      ups30d: num(row.ups30d) ?? 0,
      sumMs30d: num(row.sum_ms30d) ?? 0,
      timed30d: num(row.timed30d) ?? 0,
      latency: [],
    });
  }
  for (const row of sparks) {
    const stats = result.get(row.monitor_id);
    if (!stats) continue;
    const values: unknown[] = Array.isArray(row.latency) ? row.latency : [];
    stats.latency = values.map((value) => Math.round(num(value) ?? 0));
  }
  return result;
}

const HISTORY_SQL = `
  SELECT (now()::date - r.bucket::date) AS ago,
         sum(r.checks)::float8 AS checks,
         sum(r.ups)::float8 AS ups
    FROM monitor_rollups r
   WHERE r.monitor_id = $1
     AND r.bucket >= (now()::date - 89)
   GROUP BY 1`;

const P95_SQL = `
  SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms)::float8 AS p95
    FROM check_results
   WHERE monitor_id = $1
     AND checked_at >= now() - interval '24 hours'
     AND response_ms IS NOT NULL`;

const RECENT_SQL = `
  SELECT checked_at, status, response_ms, status_code, message
    FROM check_results
   WHERE monitor_id = $1
   ORDER BY checked_at DESC, id DESC
   LIMIT $2::int`;

const MONITOR_EVENTS_SQL = `
  SELECT e.id::text AS id, e.monitor_id, m.name AS monitor_name, e.at, e.kind, e.message
    FROM monitor_events e
    JOIN monitors m ON m.id = e.monitor_id
   WHERE e.monitor_id = $1
   ORDER BY e.at DESC, e.id DESC
   LIMIT $2::int`;

const ORG_EVENTS_SQL = `
  SELECT e.id::text AS id, e.monitor_id, m.name AS monitor_name, e.at, e.kind, e.message
    FROM monitor_events e
    JOIN monitors m ON m.id = e.monitor_id
   WHERE e.org_id = $1
   ORDER BY e.at DESC, e.id DESC
   LIMIT $2::int`;

export interface DetailExtras {
  uptime7d: number | null;
  uptime90d: number | null;
  p95Ms: number | null;
  history: (number | null)[];
  recentChecks: CheckView[];
  events: EventView[];
}

export async function loadDetailExtras(
  db: Db,
  monitorId: string,
): Promise<DetailExtras> {
  const [history, p95, recent, events] = await Promise.all([
    db.rows(HISTORY_SQL, [monitorId]),
    db.row(P95_SQL, [monitorId]),
    db.rows(RECENT_SQL, [monitorId, 30]),
    db.rows(MONITOR_EVENTS_SQL, [monitorId, 20]),
  ]);
  const folded = foldHistory(
    history as { ago: unknown; checks: unknown; ups: unknown }[],
  );
  const p95Value = num(p95?.p95);
  return {
    ...folded,
    p95Ms: p95Value === null ? null : Math.round(p95Value),
    recentChecks: recent.map(toCheck),
    events: events.map(toEvent),
  };
}

const SERIES_RAW_SQL = `
  SELECT to_timestamp(floor(extract(epoch FROM checked_at) / $2::float8) * $2::float8) AS at,
         count(*)::float8 AS checks,
         (count(*) FILTER (WHERE status <> 'down'))::float8 AS ups,
         avg(response_ms)::float8 AS avg_ms
    FROM check_results
   WHERE monitor_id = $1
     AND checked_at >= now() - ($3::float8 * interval '1 second')
   GROUP BY 1
   ORDER BY 1`;

const SERIES_ROLLUP_SQL = `
  SELECT to_timestamp(floor(extract(epoch FROM bucket) / $2::float8) * $2::float8) AS at,
         sum(checks)::float8 AS checks,
         sum(ups)::float8 AS ups,
         (sum(sum_ms)::float8 / NULLIF(sum(timed), 0)) AS avg_ms
    FROM monitor_rollups
   WHERE monitor_id = $1
     AND bucket >= now() - ($3::float8 * interval '1 second')
   GROUP BY 1
   ORDER BY 1`;

export async function loadSeries(
  db: Db,
  monitorId: string,
  range: SeriesRange,
): Promise<Series> {
  const { bucketSec, spanSec } = SERIES_SPEC[range];
  const sql = range === '24h' ? SERIES_RAW_SQL : SERIES_ROLLUP_SQL;
  const rows = await db.rows(sql, [monitorId, bucketSec, spanSec + bucketSec]);
  return fillSeries(
    range,
    rows as Parameters<typeof fillSeries>[1],
    Date.now(),
  );
}

export async function loadOrgEvents(
  db: Db,
  orgId: string,
  limit: number,
): Promise<EventView[]> {
  const rows = await db.rows(ORG_EVENTS_SQL, [orgId, limit]);
  return rows.map(toEvent);
}

const ORG_LATENCY_SQL = `
  SELECT (sum(r.sum_ms)::float8 / sum(r.timed)) AS avg_ms
    FROM monitor_rollups r
    JOIN monitors m ON m.id = r.monitor_id
   WHERE m.org_id = $1
     AND r.bucket >= now() - interval '24 hours'
   GROUP BY r.bucket
  HAVING sum(r.timed) > 0
   ORDER BY r.bucket`;

export async function loadOrgLatency(db: Db, orgId: string): Promise<number[]> {
  const rows = await db.rows(ORG_LATENCY_SQL, [orgId]);
  return rows.map((row) => Math.round(num(row.avg_ms) ?? 0));
}
