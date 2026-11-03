import { iso, isoOrNull, num } from '../monitors/monitor.format';
import { describeChannel, maskChannelConfig } from './alert.schema';
import { windowIsActive, windowNextStart } from './alert.scope';
import type {
  ChannelRow,
  ChannelView,
  IncidentRow,
  IncidentView,
  MaintenanceRow,
  MaintenanceView,
  MemberRef,
  PolicyRow,
  PolicyView,
  RuleRow,
  RuleView,
  Scope,
  ScheduleRow,
  SilenceRow,
  SilenceView,
} from './alert.types';

export function toScope(row: {
  scope_all: boolean;
  monitor_ids: string[] | null;
  tags: string[] | null;
}): Scope {
  return {
    all: row.scope_all,
    monitorIds: row.monitor_ids ?? [],
    tags: row.tags ?? [],
  };
}

export function toChannelView(row: ChannelRow): ChannelView {
  const config = row.config ?? {};
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    summary: describeChannel(row.type, config),
    config: maskChannelConfig(row.type, config),
    enabled: row.enabled,
    lastUsedAt: isoOrNull(row.last_used_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
  };
}

export function toRuleView(row: RuleRow): RuleView {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    severity: row.severity,
    forSec: row.for_sec,
    scope: toScope(row),
    channelIds: row.channel_ids ?? [],
    policyId: row.policy_id,
    notifyRecovery: row.notify_recovery,
    createdAt: iso(row.created_at),
  };
}

export function toPolicyView(row: PolicyRow): PolicyView {
  return {
    id: row.id,
    name: row.name,
    steps: (row.steps ?? []).map((step) => ({
      afterSec: Number(step.afterSec) || 0,
      channelIds: step.channelIds ?? [],
      scheduleId: step.scheduleId ?? null,
    })),
    createdAt: iso(row.created_at),
  };
}

export function toSilenceView(row: SilenceRow, now: Date): SilenceView {
  const startsAt = new Date(row.starts_at);
  const endsAt = new Date(row.ends_at);
  return {
    id: row.id,
    name: row.name,
    scope: toScope(row),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    active:
      startsAt.getTime() <= now.getTime() && now.getTime() < endsAt.getTime(),
    createdAt: iso(row.created_at),
  };
}

export function toMaintenanceView(
  row: MaintenanceRow,
  now: Date,
): MaintenanceView {
  const window = {
    startsAt: new Date(row.starts_at),
    durationSec: row.duration_sec,
    repeat: row.repeat,
  };
  const next = windowNextStart(window, now);
  return {
    id: row.id,
    name: row.name,
    scope: toScope(row),
    startsAt: window.startsAt.toISOString(),
    durationSec: row.duration_sec,
    repeat: row.repeat,
    public: Boolean(row.public),
    active: windowIsActive(window, now),
    nextStartsAt: next ? next.toISOString() : null,
    createdAt: iso(row.created_at),
  };
}

export interface IncidentJoinRow extends IncidentRow {
  assignee_name: string | null;
  assignee_email: string | null;
  ack_name: string | null;
  ack_email: string | null;
  notified: number | string | null;
}

export function memberRef(
  id: string | null,
  name: string | null,
  email: string | null,
): MemberRef | null {
  return id && name !== null && email !== null ? { id, name, email } : null;
}

export function toIncidentView(row: IncidentJoinRow): IncidentView {
  return {
    id: row.id,
    number: row.number,
    source: row.source ?? 'monitor',
    serverId: row.server_id ?? null,
    subject: row.subject ?? '',
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    title: row.title,
    cause: row.cause,
    severity: row.severity,
    status: row.status,
    trigger: row.trigger,
    startedAt: iso(row.started_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    acknowledgedBy: memberRef(row.acknowledged_by, row.ack_name, row.ack_email),
    resolvedAt: isoOrNull(row.resolved_at),
    resolution: row.resolution,
    assignee: memberRef(row.assignee_id, row.assignee_name, row.assignee_email),
    notified: num(row.notified) ?? 0,
  };
}

export const INCIDENT_SELECT = `
  SELECT i.*,
         au.name AS assignee_name, au.email AS assignee_email,
         ku.name AS ack_name, ku.email AS ack_email,
         (SELECT count(*)::int FROM notification_jobs j
           WHERE j.incident_id = i.id AND j.status = 'sent' AND j.kind <> 'recovery') AS notified
    FROM incidents i
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users ku ON ku.id = i.acknowledged_by`;

export function scheduleFacts(row: ScheduleRow): {
  members: string[];
  anchorAt: Date;
  periodSec: number;
} {
  return {
    members: row.members ?? [],
    anchorAt: new Date(row.anchor_at),
    periodSec: row.period_sec,
  };
}
