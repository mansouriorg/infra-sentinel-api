export const MONITOR_TYPES = [
  'http',
  'keyword',
  'tcp',
  'ping',
  'dns',
  'ssl',
  'heartbeat',
] as const;

export type MonitorType = (typeof MONITOR_TYPES)[number];
export type MonitorStatus = 'pending' | 'up' | 'degraded' | 'down' | 'paused';
export type CheckStatus = 'up' | 'degraded' | 'down';
export type EventKind =
  | 'created'
  | 'down'
  | 'up'
  | 'degraded'
  | 'paused'
  | 'resumed';

export interface CheckOutcome {
  status: CheckStatus;
  responseMs: number | null;
  statusCode: number | null;
  message: string;
  sslExpiresAt: Date | null;
}

export interface MonitorRow {
  id: string;
  org_id: string;
  name: string;
  type: MonitorType;
  config: Record<string, any>;
  interval_sec: number;
  timeout_ms: number;
  failure_threshold: number;
  tags: string[];
  paused: boolean;
  status: MonitorStatus;
  status_since: Date;
  consecutive_failures: number;
  last_checked_at: Date | null;
  last_response_ms: number | null;
  last_message: string | null;
  next_check_at: Date;
  heartbeat_token: string | null;
  ssl_expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MonitorView {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  config: Record<string, any>;
  status: MonitorStatus;
  statusSince: string;
  intervalSec: number;
  timeoutMs: number;
  failureThreshold: number;
  tags: string[];
  createdAt: string;
  lastCheckedAt: string | null;
  lastResponseMs: number | null;
  lastMessage: string | null;
  sslExpiresAt: string | null;
  heartbeatPath: string | null;
  uptime24h: number | null;
  uptime30d: number | null;
  avgMs: number | null;
  latency: number[];
}

export interface CheckView {
  at: string;
  status: CheckStatus;
  responseMs: number | null;
  statusCode: number | null;
  message: string;
}

export interface EventView {
  id: string;
  monitorId: string;
  monitorName: string | null;
  at: string;
  kind: EventKind;
  message: string;
}

export interface MonitorDetail extends MonitorView {
  uptime7d: number | null;
  uptime90d: number | null;
  p95Ms: number | null;
  history: (number | null)[];
  recentChecks: CheckView[];
  events: EventView[];
}

export interface SeriesPoint {
  at: string;
  avgMs: number | null;
  checks: number;
  ups: number;
}

export interface Series {
  range: SeriesRange;
  bucketSec: number;
  points: SeriesPoint[];
}

export const SERIES_RANGES = ['24h', '7d', '30d'] as const;
export type SeriesRange = (typeof SERIES_RANGES)[number];

export interface Overview {
  counts: Record<MonitorStatus | 'total', number>;
  uptime30d: number | null;
  avgMs: number | null;
  latency: number[];
  problems: MonitorView[];
  slowest: MonitorView[];
  events: EventView[];
}

export type LiveEvent =
  | {
      type: 'check';
      monitorId: string;
      status: MonitorStatus;
      checkStatus: CheckStatus;
      responseMs: number | null;
      message: string;
      at: string;
    }
  | {
      type: 'status';
      monitorId: string;
      name: string;
      from: MonitorStatus;
      to: MonitorStatus;
      kind: EventKind;
      message: string;
      at: string;
    }
  | {
      type: 'monitor';
      monitorId: string;
      change: 'created' | 'updated' | 'deleted';
    }
  | {
      type: 'incident';
      incidentId: string;
      number: number;
      change: 'opened' | 'updated' | 'resolved';
    }
  | {
      type: 'server';
      serverId: string;
      change: 'created' | 'updated' | 'deleted' | 'status';
    }
  | { type: 'notification' };
