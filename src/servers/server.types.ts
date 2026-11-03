import type { Scope, Severity } from '../alerting/alert.types';

export const SERVER_METRICS = [
  'offline',
  'cpu',
  'memory',
  'swap',
  'disk',
  'load',
  'net_in',
  'net_out',
  'container',
  'service',
  'process',
] as const;
export type ServerMetric = (typeof SERVER_METRICS)[number];

export const RULE_MODES = ['threshold', 'anomaly'] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const SENSITIVITIES = ['low', 'medium', 'high'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const ANOMALY_METRICS: readonly ServerMetric[] = [
  'cpu',
  'memory',
  'load',
  'net_in',
  'net_out',
];
export const NAMED_METRICS: readonly ServerMetric[] = [
  'container',
  'service',
  'process',
];
export const PERCENT_METRICS: readonly ServerMetric[] = [
  'cpu',
  'memory',
  'swap',
  'disk',
];

export const METRIC_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export type ServerStatus = 'pending' | 'online' | 'offline';

export interface ServerLatest {
  at?: string;
  cpu?: number;
  mem?: number;
  memUsed?: number;
  swap?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  disk?: number;
  netIn?: number;
  netOut?: number;
}

export interface DiskInfo {
  mount: string;
  device: string;
  fs: string;
  total: number;
  used: number;
  pct: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string;
  status: string;
  createdAt: number;
  cpu: number | null;
  memUsed: number | null;
  memLimit: number | null;
  netIn: number | null;
  netOut: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmd: string;
  user: string;
  cpu: number;
  mem: number;
  memBytes: number;
}

export interface ServiceInfo {
  name: string;
  state: string;
}

export interface ServerSnapshot {
  disks?: DiskInfo[];
  containers?: ContainerInfo[];
  processes?: ProcessInfo[];
  services?: ServiceInfo[];
  failedServices?: string[];
  watchedProcesses?: Record<string, number>;
}

export interface ServerRow {
  id: string;
  org_id: string;
  name: string;
  hostname: string;
  tags: string[];
  machine_id: string | null;
  agent_key_hash: string;
  agent_version: string;
  os: string;
  platform: string;
  kernel: string;
  arch: string;
  cpu_count: number;
  mem_total: number | string;
  swap_total: number | string;
  boot_time: Date | null;
  ip: string;
  docker: boolean;
  systemd: boolean;
  interval_sec: number;
  last_seen_at: Date | null;
  latest: ServerLatest;
  snapshot: ServerSnapshot;
  created_at: Date;
  updated_at: Date;
}

export interface EnrollmentTokenRow {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  max_uses: number | null;
  uses: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

export interface ServerRuleRow {
  id: string;
  org_id: string;
  name: string;
  enabled: boolean;
  metric: ServerMetric;
  mode: RuleMode;
  threshold: number | null;
  sensitivity: Sensitivity;
  target: string;
  severity: Severity;
  for_sec: number;
  scope_all: boolean;
  server_ids: string[];
  tags: string[];
  channel_ids: string[];
  policy_id: string | null;
  notify_recovery: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ServerScope {
  all: boolean;
  serverIds: string[];
  tags: string[];
}

export function toAlertScope(scope: ServerScope): Scope {
  return { all: scope.all, monitorIds: scope.serverIds, tags: scope.tags };
}

export interface ServerSummary {
  id: string;
  name: string;
  hostname: string;
  tags: string[];
  status: ServerStatus;
  lastSeenAt: string | null;
  os: string;
  platform: string;
  arch: string;
  cpuCount: number;
  memTotal: number;
  ip: string;
  agentVersion: string;
  bootTime: string | null;
  docker: boolean;
  systemd: boolean;
  latest: ServerLatest;
  diskMax: number | null;
  containers: { total: number; running: number; problems: number } | null;
  openIncidents: number;
  monitorIds: string[];
  cpuHistory: number[];
  createdAt: string;
}

export interface LinkedMonitor {
  id: string;
  name: string;
  status: string;
}

export interface ServerDetail extends ServerSummary {
  kernel: string;
  swapTotal: number;
  intervalSec: number;
  disks: DiskInfo[];
  containerList: ContainerInfo[] | null;
  processes: ProcessInfo[];
  services: ServiceInfo[];
  failedServices: string[];
  linkedMonitors: LinkedMonitor[];
}

export interface MetricPoint {
  at: string;
  cpu: number | null;
  mem: number | null;
  swap: number | null;
  load1: number | null;
  disk: number | null;
  netIn: number | null;
  netOut: number | null;
}

export interface MetricSeries {
  range: MetricRange;
  bucketSec: number;
  points: MetricPoint[];
}

export interface EnrollmentTokenView {
  id: string;
  name: string;
  prefix: string;
  uses: number;
  maxUses: number | null;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface CreatedEnrollmentToken extends EnrollmentTokenView {
  token: string;
  apiUrl: string;
}

export interface ServerRuleView {
  id: string;
  name: string;
  enabled: boolean;
  metric: ServerMetric;
  mode: RuleMode;
  threshold: number | null;
  sensitivity: Sensitivity;
  target: string;
  severity: Severity;
  forSec: number;
  scope: ServerScope;
  channelIds: string[];
  policyId: string | null;
  notifyRecovery: boolean;
  createdAt: string;
}

export interface Breach {
  subject: string;
  value: number | null;
  detail: string;
}

export interface Baseline {
  recent: number | null;
  mean: number | null;
  std: number | null;
  samples: number;
  recentSamples: number;
}

export type Baselines = Partial<
  Record<'cpu' | 'memory' | 'load' | 'net_in' | 'net_out', Baseline>
>;
