import type { CheckStatus, EventKind, MonitorStatus } from './monitor.types';

export const RETRY_SECONDS = 20;

export interface StateSnapshot {
  status: MonitorStatus;
  consecutiveFailures: number;
}

export interface Transition {
  status: MonitorStatus;
  consecutiveFailures: number;
  changed: boolean;
  event: EventKind | null;
}

export function applyOutcome(
  previous: StateSnapshot,
  outcome: CheckStatus,
  failureThreshold: number,
): Transition {
  if (outcome === 'down') {
    const failures = previous.consecutiveFailures + 1;
    if (failures >= failureThreshold) {
      const changed = previous.status !== 'down';
      return {
        status: 'down',
        consecutiveFailures: failures,
        changed,
        event: changed ? 'down' : null,
      };
    }
    return {
      status: previous.status,
      consecutiveFailures: failures,
      changed: false,
      event: null,
    };
  }

  const next: MonitorStatus = outcome;
  const changed = previous.status !== next;
  let event: EventKind | null = null;
  if (
    changed &&
    previous.status !== 'pending' &&
    previous.status !== 'paused'
  ) {
    event = next === 'degraded' ? 'degraded' : 'up';
  }
  return { status: next, consecutiveFailures: 0, changed, event };
}

export function nextDelaySeconds(options: {
  type: string;
  intervalSec: number;
  graceSec: number;
  outcome: CheckStatus;
  confirmedDown: boolean;
}): number {
  const { type, intervalSec, graceSec, outcome, confirmedDown } = options;
  if (type === 'heartbeat') {
    return outcome === 'down' ? intervalSec : intervalSec + graceSec;
  }
  if (outcome === 'down' && !confirmedDown)
    return Math.min(intervalSec, RETRY_SECONDS);
  return intervalSec;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function describeEvent(
  kind: EventKind,
  name: string,
  message: string,
  downForMs: number,
): string {
  switch (kind) {
    case 'down':
      return `${name} is down: ${message}`;
    case 'up':
      return downForMs >= 1000
        ? `${name} is back up after ${formatDuration(downForMs)}`
        : `${name} is back up`;
    case 'degraded':
      return `${name} is degraded: ${message}`;
    case 'paused':
      return `${name} was paused`;
    case 'resumed':
      return `${name} was resumed`;
    case 'created':
      return `${name} was added`;
  }
}
