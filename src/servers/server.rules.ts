import { formatDuration } from '../alerting/alert.scope';
import type {
  Baselines,
  Breach,
  RuleMode,
  Sensitivity,
  ServerLatest,
  ServerMetric,
  ServerSnapshot,
  ServerStatus,
} from './server.types';

export interface RuleFacts {
  metric: ServerMetric;
  mode: RuleMode;
  threshold: number | null;
  sensitivity: Sensitivity;
  target: string;
}

export interface ServerFacts {
  status: ServerStatus;
  ageSec: number | null;
  cpuCount: number;
  docker: boolean;
  systemd: boolean;
  latest: ServerLatest;
  snapshot: ServerSnapshot;
}

export type Evaluation = { known: true; breaches: Breach[] } | { known: false };

export const MIN_BASELINE_SAMPLES = 120;
export const MIN_RECENT_SAMPLES = 3;

const UNKNOWN: Evaluation = { known: false };

const CLEAR: Evaluation = { known: true, breaches: [] };

const found = (breaches: Breach[]): Evaluation => ({ known: true, breaches });

const SIGMAS: Record<Sensitivity, number> = { low: 4, medium: 3, high: 2 };

const ANOMALY_LABEL: Record<string, string> = {
  cpu: 'CPU usage',
  memory: 'memory usage',
  load: 'load',
  net_in: 'inbound traffic',
  net_out: 'outbound traffic',
};

export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

export function formatNumber(value: number, digits = 1): string {
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function hasWildcard(pattern: string): boolean {
  return pattern.includes('*');
}

export function globMatch(pattern: string, value: string): boolean {
  if (!hasWildcard(pattern)) return pattern === value;
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function compareNumber(
  value: number | undefined,
  threshold: number,
  describe: (value: number) => string,
  subject = '',
): Evaluation {
  if (value === undefined || !Number.isFinite(value)) return UNKNOWN;
  if (value > threshold)
    return found([{ subject, value, detail: describe(value) }]);
  return CLEAR;
}

function anomaly(
  rule: RuleFacts,
  server: ServerFacts,
  baselines?: Baselines,
): Evaluation {
  const key = rule.metric as keyof Baselines;
  const baseline = baselines?.[key];
  if (!baseline || baseline.mean === null || baseline.recent === null)
    return UNKNOWN;
  if (
    baseline.samples < MIN_BASELINE_SAMPLES ||
    baseline.recentSamples < MIN_RECENT_SAMPLES
  )
    return UNKNOWN;

  const divisor = rule.metric === 'load' ? Math.max(1, server.cpuCount) : 1;
  const mean = baseline.mean / divisor;
  const recent = baseline.recent / divisor;
  const std = (baseline.std ?? 0) / divisor;
  const network = rule.metric === 'net_in' || rule.metric === 'net_out';

  let floor: number;
  let minimum: number;
  if (rule.metric === 'cpu') {
    floor = 3;
    minimum = 15;
  } else if (rule.metric === 'memory') {
    floor = 2;
    minimum = 10;
  } else if (rule.metric === 'load') {
    floor = 0.1;
    minimum = 0.5;
  } else {
    floor = Math.max(mean * 0.1, 10_240);
    minimum = Math.max(mean, 1_048_576);
  }

  const delta = recent - mean;
  const score = delta / Math.max(std, floor);
  if (score < SIGMAS[rule.sensitivity] || delta < minimum) return CLEAR;

  const show = (value: number) =>
    network
      ? formatRate(value)
      : rule.metric === 'load'
        ? `${formatNumber(value, 2)} per core`
        : `${formatNumber(value)}%`;
  const label = ANOMALY_LABEL[rule.metric] ?? rule.metric;
  const text = `${label.charAt(0).toUpperCase()}${label.slice(1)} is ${show(recent)}, usually about ${show(mean)}`;
  return found([{ subject: '', value: recent, detail: text }]);
}

export function evaluateRule(
  rule: RuleFacts,
  server: ServerFacts,
  baselines?: Baselines,
): Evaluation {
  if (rule.metric === 'offline') {
    if (server.status === 'pending' || server.ageSec === null) return CLEAR;
    const limit = rule.threshold ?? 90;
    if (server.ageSec <= limit) return CLEAR;
    return found([
      {
        subject: '',
        value: Math.round(server.ageSec),
        detail: `No data for ${formatDuration(server.ageSec)}`,
      },
    ]);
  }

  if (server.status !== 'online') return UNKNOWN;
  if (rule.mode === 'anomaly') return anomaly(rule, server, baselines);

  const threshold = rule.threshold ?? 0;
  const { latest, snapshot } = server;

  switch (rule.metric) {
    case 'cpu':
      return compareNumber(
        latest.cpu,
        threshold,
        (value) =>
          `CPU is at ${formatNumber(value)}%, the limit is ${formatNumber(threshold)}%`,
      );
    case 'memory':
      return compareNumber(
        latest.mem,
        threshold,
        (value) =>
          `Memory is at ${formatNumber(value)}%, the limit is ${formatNumber(threshold)}%`,
      );
    case 'swap':
      return compareNumber(
        latest.swap,
        threshold,
        (value) =>
          `Swap is at ${formatNumber(value)}%, the limit is ${formatNumber(threshold)}%`,
      );
    case 'load': {
      if (latest.load1 === undefined) return UNKNOWN;
      const perCore = latest.load1 / Math.max(1, server.cpuCount);
      return compareNumber(
        perCore,
        threshold,
        (value) =>
          `Load is ${formatNumber(value, 2)} per core, the limit is ${formatNumber(threshold, 2)}`,
      );
    }
    case 'disk': {
      if (!snapshot.disks) {
        return compareNumber(
          latest.disk,
          threshold,
          (value) =>
            `A disk is ${formatNumber(value)}% full, the limit is ${formatNumber(threshold)}%`,
        );
      }
      const full = snapshot.disks.filter((disk) => disk.pct > threshold);
      return found(
        full.map((disk) => ({
          subject: disk.mount,
          value: disk.pct,
          detail: `Disk ${disk.mount} is ${formatNumber(disk.pct)}% full, the limit is ${formatNumber(threshold)}%`,
        })),
      );
    }
    case 'container': {
      if (!server.docker || !snapshot.containers) return UNKNOWN;
      const matches = snapshot.containers.filter((container) =>
        globMatch(rule.target, container.name),
      );
      const problems = matches.filter(
        (container) =>
          container.state !== 'running' || container.health === 'unhealthy',
      );
      const breaches: Breach[] = problems.map((container) => ({
        subject: container.name,
        value: null,
        detail:
          container.state !== 'running'
            ? `Container ${container.name} is ${container.state}`
            : `Container ${container.name} is unhealthy`,
      }));
      if (!hasWildcard(rule.target) && matches.length === 0) {
        breaches.push({
          subject: rule.target,
          value: null,
          detail: `Container ${rule.target} was not found`,
        });
      }
      return found(breaches);
    }
    case 'service': {
      if (!server.systemd) return UNKNOWN;
      if (rule.target === '*') {
        if (!snapshot.failedServices) return UNKNOWN;
        return found(
          snapshot.failedServices.map((unit) => ({
            subject: unit,
            value: null,
            detail: `Service ${unit} has failed`,
          })),
        );
      }
      if (!snapshot.services) return UNKNOWN;
      const wanted = rule.target.replace(/\.service$/, '');
      const entry = snapshot.services.find(
        (service) => service.name === rule.target || service.name === wanted,
      );
      if (!entry || entry.state === 'unknown') return UNKNOWN;
      if (entry.state === 'active') return CLEAR;
      return found([
        {
          subject: rule.target,
          value: null,
          detail: `Service ${rule.target} is ${entry.state}`,
        },
      ]);
    }
    case 'process': {
      const counts = snapshot.watchedProcesses;
      if (!counts || counts[rule.target] === undefined) return UNKNOWN;
      if (counts[rule.target] > 0) return CLEAR;
      return found([
        {
          subject: rule.target,
          value: 0,
          detail: `Process ${rule.target} is not running`,
        },
      ]);
    }
    default:
      return UNKNOWN;
  }
}

export function ruleTitle(
  rule: Pick<RuleFacts, 'metric' | 'mode' | 'threshold'>,
  serverName: string,
  subject: string,
): string {
  if (rule.metric === 'offline') return `${serverName} is offline`;
  if (rule.mode === 'anomaly')
    return `${serverName}: unusual ${ANOMALY_LABEL[rule.metric] ?? rule.metric}`;
  const limit = rule.threshold === null ? '' : formatNumber(rule.threshold, 2);
  switch (rule.metric) {
    case 'cpu':
      return `${serverName}: CPU above ${limit}%`;
    case 'memory':
      return `${serverName}: memory above ${limit}%`;
    case 'swap':
      return `${serverName}: swap above ${limit}%`;
    case 'disk':
      return `${serverName}: disk ${subject} above ${limit}%`;
    case 'load':
      return `${serverName}: load above ${limit} per core`;
    case 'container':
      return `${serverName}: container ${subject} is not healthy`;
    case 'service':
      return `${serverName}: service ${subject} is not running`;
    case 'process':
      return `${serverName}: process ${subject} is not running`;
    default:
      return `${serverName}: ${rule.metric}`;
  }
}

export function breachKey(
  ruleId: string,
  serverId: string,
  subject: string,
): string {
  return `${ruleId}|${serverId}|${subject}`;
}
