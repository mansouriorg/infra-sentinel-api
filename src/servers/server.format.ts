import type {
  ContainerInfo,
  EnrollmentTokenRow,
  EnrollmentTokenView,
  LinkedMonitor,
  MetricRange,
  ServerDetail,
  ServerRow,
  ServerRuleRow,
  ServerRuleView,
  ServerStatus,
  ServerSummary,
} from './server.types';

export const OFFLINE_FLOOR_SEC = 60;

export const RANGE_SPECS: Record<
  MetricRange,
  { seconds: number; bucketSec: number }
> = {
  '1h': { seconds: 3600, bucketSec: 30 },
  '6h': { seconds: 21_600, bucketSec: 120 },
  '24h': { seconds: 86_400, bucketSec: 600 },
  '7d': { seconds: 604_800, bucketSec: 3600 },
};

export function offlineAfter(intervalSec: number): number {
  return Math.max(OFFLINE_FLOOR_SEC, intervalSec * 4);
}

export function ageSeconds(lastSeen: Date | null, now: Date): number | null {
  if (!lastSeen) return null;
  return Math.max(0, (now.getTime() - new Date(lastSeen).getTime()) / 1000);
}

export function serverStatus(
  lastSeen: Date | null,
  intervalSec: number,
  now: Date,
): ServerStatus {
  const age = ageSeconds(lastSeen, now);
  if (age === null) return 'pending';
  return age <= offlineAfter(intervalSec) ? 'online' : 'offline';
}

export function containerSummary(
  containers: ContainerInfo[] | undefined,
  docker: boolean,
): { total: number; running: number; problems: number } | null {
  if (!docker || !containers) return null;
  const running = containers.filter(
    (container) => container.state === 'running',
  ).length;
  const problems = containers.filter(
    (container) =>
      container.state === 'restarting' ||
      container.health === 'unhealthy' ||
      container.state === 'dead',
  ).length;
  return { total: containers.length, running, problems };
}

export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export interface SummaryExtras {
  openIncidents: number;
  monitorIds: string[];
  cpuHistory: number[];
}

export function toSummary(
  row: ServerRow,
  extras: SummaryExtras,
  now: Date,
): ServerSummary {
  const disks = row.snapshot?.disks;
  const diskMax =
    disks && disks.length > 0
      ? Math.max(...disks.map((disk) => disk.pct))
      : (row.latest?.disk ?? null);
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    tags: row.tags ?? [],
    status: serverStatus(row.last_seen_at, row.interval_sec, now),
    lastSeenAt: isoOrNull(row.last_seen_at),
    os: row.os,
    platform: row.platform,
    arch: row.arch,
    cpuCount: row.cpu_count,
    memTotal: num(row.mem_total),
    ip: row.ip,
    agentVersion: row.agent_version,
    bootTime: isoOrNull(row.boot_time),
    docker: row.docker,
    systemd: row.systemd,
    latest: row.latest ?? {},
    diskMax,
    containers: containerSummary(row.snapshot?.containers, row.docker),
    openIncidents: extras.openIncidents,
    monitorIds: extras.monitorIds,
    cpuHistory: extras.cpuHistory,
    createdAt: iso(row.created_at),
  };
}

export function toDetail(
  row: ServerRow,
  extras: SummaryExtras,
  linked: LinkedMonitor[],
  now: Date,
): ServerDetail {
  const snapshot = row.snapshot ?? {};
  return {
    ...toSummary(row, extras, now),
    kernel: row.kernel,
    swapTotal: num(row.swap_total),
    intervalSec: row.interval_sec,
    disks: snapshot.disks ?? [],
    containerList: row.docker ? (snapshot.containers ?? null) : null,
    processes: snapshot.processes ?? [],
    services: snapshot.services ?? [],
    failedServices: snapshot.failedServices ?? [],
    linkedMonitors: linked,
  };
}

export function tokenActive(row: EnrollmentTokenRow, now: Date): boolean {
  if (row.revoked_at) return false;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return false;
  return row.max_uses === null || row.uses < row.max_uses;
}

export function toTokenView(
  row: EnrollmentTokenRow,
  now: Date,
): EnrollmentTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    uses: row.uses,
    maxUses: row.max_uses,
    expiresAt: iso(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    active: tokenActive(row, now),
    createdAt: iso(row.created_at),
  };
}

export function toRuleView(row: ServerRuleRow): ServerRuleView {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    metric: row.metric,
    mode: row.mode,
    threshold: row.threshold === null ? null : Number(row.threshold),
    sensitivity: row.sensitivity,
    target: row.target,
    severity: row.severity,
    forSec: row.for_sec,
    scope: {
      all: row.scope_all,
      serverIds: row.server_ids ?? [],
      tags: row.tags ?? [],
    },
    channelIds: row.channel_ids ?? [],
    policyId: row.policy_id,
    notifyRecovery: row.notify_recovery,
    createdAt: iso(row.created_at),
  };
}
