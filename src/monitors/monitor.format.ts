import { describeTarget, maskConfig } from './monitor.schema';
import type {
  CheckView,
  EventView,
  MonitorRow,
  MonitorView,
  Series,
  SeriesPoint,
  SeriesRange,
} from './monitor.types';

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function percent(good: unknown, total: unknown): number | null {
  const all = num(total);
  const ok = num(good);
  if (!all || ok === null) return null;
  return Math.round((ok / all) * 10_000) / 100;
}

export interface MonitorStats {
  checks24h: number;
  ups24h: number;
  checks30d: number;
  ups30d: number;
  sumMs30d: number;
  timed30d: number;
  latency: number[];
}

export const EMPTY_STATS: MonitorStats = {
  checks24h: 0,
  ups24h: 0,
  checks30d: 0,
  ups30d: 0,
  sumMs30d: 0,
  timed30d: 0,
  latency: [],
};

export function heartbeatPathFor(token: string | null): string | null {
  return token ? `/api/v1/heartbeat/${token}` : null;
}

export function toView(
  row: MonitorRow,
  stats: MonitorStats | undefined,
  canSeeSecrets: boolean,
): MonitorView {
  const s = stats ?? EMPTY_STATS;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    target: describeTarget(row.type, row.config, row.interval_sec),
    config: maskConfig(row.config),
    status: row.status,
    statusSince: iso(row.status_since),
    intervalSec: row.interval_sec,
    timeoutMs: row.timeout_ms,
    failureThreshold: row.failure_threshold,
    tags: row.tags ?? [],
    createdAt: iso(row.created_at),
    lastCheckedAt: isoOrNull(row.last_checked_at),
    lastResponseMs: num(row.last_response_ms),
    lastMessage: row.last_message,
    sslExpiresAt: isoOrNull(row.ssl_expires_at),
    heartbeatPath: canSeeSecrets ? heartbeatPathFor(row.heartbeat_token) : null,
    uptime24h: percent(s.ups24h, s.checks24h),
    uptime30d: percent(s.ups30d, s.checks30d),
    avgMs: s.timed30d > 0 ? Math.round(s.sumMs30d / s.timed30d) : null,
    latency: s.latency,
  };
}

export function toCheck(row: Record<string, any>): CheckView {
  return {
    at: iso(row.checked_at),
    status: row.status,
    responseMs: num(row.response_ms),
    statusCode: num(row.status_code),
    message: row.message ?? '',
  };
}

export function toEvent(row: Record<string, any>): EventView {
  return {
    id: String(row.id),
    monitorId: row.monitor_id,
    monitorName: row.monitor_name ?? null,
    at: iso(row.at),
    kind: row.kind,
    message: row.message,
  };
}

export const SERIES_SPEC: Record<
  SeriesRange,
  { bucketSec: number; spanSec: number }
> = {
  '24h': { bucketSec: 900, spanSec: 86_400 },
  '7d': { bucketSec: 3600, spanSec: 7 * 86_400 },
  '30d': { bucketSec: 21_600, spanSec: 30 * 86_400 },
};

export function fillSeries(
  range: SeriesRange,
  rows: { at: unknown; checks: unknown; ups: unknown; avg_ms: unknown }[],
  nowMs: number,
): Series {
  const { bucketSec, spanSec } = SERIES_SPEC[range];
  const step = bucketSec * 1000;
  const last = Math.floor(nowMs / step) * step;
  const count = Math.ceil(spanSec / bucketSec);
  const known = new Map<number, SeriesPoint>();
  for (const row of rows) {
    const at = new Date(row.at as string | Date).getTime();
    const avg = num(row.avg_ms);
    known.set(at, {
      at: new Date(at).toISOString(),
      avgMs: avg === null ? null : Math.round(avg),
      checks: num(row.checks) ?? 0,
      ups: num(row.ups) ?? 0,
    });
  }
  const points: SeriesPoint[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const at = last - index * step;
    points.push(
      known.get(at) ?? {
        at: new Date(at).toISOString(),
        avgMs: null,
        checks: 0,
        ups: 0,
      },
    );
  }
  return { range, bucketSec, points };
}

export function foldHistory(
  rows: { ago: unknown; checks: unknown; ups: unknown }[],
  days = 90,
): {
  history: (number | null)[];
  uptime7d: number | null;
  uptime90d: number | null;
} {
  const history: (number | null)[] = Array.from({ length: days }, () => null);
  let checks7 = 0;
  let ups7 = 0;
  let checksAll = 0;
  let upsAll = 0;
  for (const row of rows) {
    const ago = num(row.ago);
    const checks = num(row.checks) ?? 0;
    const ups = num(row.ups) ?? 0;
    if (ago === null || ago < 0 || ago >= days) continue;
    history[days - 1 - ago] = percent(ups, checks);
    checksAll += checks;
    upsAll += ups;
    if (ago < 7) {
      checks7 += checks;
      ups7 += ups;
    }
  }
  return {
    history,
    uptime7d: percent(ups7, checks7),
    uptime90d: percent(upsAll, checksAll),
  };
}
