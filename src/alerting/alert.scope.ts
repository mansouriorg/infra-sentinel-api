import type {
  Repeat,
  Scope,
  ScopedMonitor,
  Severity,
  Trigger,
} from './alert.types';

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

export function scopeMatches(scope: Scope, monitor: ScopedMonitor): boolean {
  if (scope.all) return true;
  if (scope.monitorIds.includes(monitor.id)) return true;
  return monitor.tags.some((tag) => scope.tags.includes(tag));
}

export function triggerMatches(trigger: Trigger, status: string): boolean {
  if (status === 'down') return true;
  return trigger === 'degraded' && status === 'degraded';
}

export interface MatchableRule {
  enabled: boolean;
  trigger: Trigger;
  scope: Scope;
}

export function ruleMatches(
  rule: MatchableRule,
  monitor: ScopedMonitor,
  status: string,
): boolean {
  return (
    rule.enabled &&
    triggerMatches(rule.trigger, status) &&
    scopeMatches(rule.scope, monitor)
  );
}

const REPEAT_SECONDS: Record<Exclude<Repeat, 'none'>, number> = {
  daily: 86_400,
  weekly: 604_800,
};

export interface Window {
  startsAt: Date;
  durationSec: number;
  repeat: Repeat;
}

export function windowIsActive(window: Window, now: Date): boolean {
  const elapsed = (now.getTime() - window.startsAt.getTime()) / 1000;
  if (elapsed < 0) return false;
  if (window.repeat === 'none') return elapsed < window.durationSec;
  const period = REPEAT_SECONDS[window.repeat];
  return elapsed % period < window.durationSec;
}

export function windowNextStart(window: Window, now: Date): Date | null {
  const elapsed = (now.getTime() - window.startsAt.getTime()) / 1000;
  if (elapsed < 0) return window.startsAt;
  if (window.repeat === 'none') return null;
  const period = REPEAT_SECONDS[window.repeat];
  const cycles = Math.floor(elapsed / period) + 1;
  return new Date(window.startsAt.getTime() + cycles * period * 1000);
}

export function maxWindowSeconds(repeat: Repeat): number {
  return repeat === 'none' ? 30 * 86_400 : REPEAT_SECONDS[repeat];
}

export interface Schedule {
  members: string[];
  anchorAt: Date;
  periodSec: number;
}

export function onCallAt(
  schedule: Schedule,
  now: Date,
  validMembers: ReadonlySet<string>,
): { userId: string | null; nextHandoffAt: Date } {
  const count = schedule.members.length;
  const slot = Math.floor(
    (now.getTime() - schedule.anchorAt.getTime()) / (schedule.periodSec * 1000),
  );
  const nextHandoffAt = new Date(
    schedule.anchorAt.getTime() + (slot + 1) * schedule.periodSec * 1000,
  );
  if (count === 0) return { userId: null, nextHandoffAt };
  const start = ((slot % count) + count) % count;
  for (let offset = 0; offset < count; offset += 1) {
    const candidate = schedule.members[(start + offset) % count];
    if (validMembers.has(candidate))
      return { userId: candidate, nextHandoffAt };
  }
  return { userId: null, nextHandoffAt };
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
