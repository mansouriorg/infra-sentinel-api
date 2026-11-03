export const CHANNEL_TYPES = [
  'email',
  'slack',
  'discord',
  'telegram',
  'ntfy',
  'gotify',
  'webhook',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const TRIGGERS = ['down', 'degraded'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const REPEATS = ['none', 'daily', 'weekly'] as const;
export type Repeat = (typeof REPEATS)[number];

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentSource = 'monitor' | 'server';
export type JobKind = 'alert' | 'escalation' | 'recovery';
export type JobStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export type IncidentEventKind =
  | 'opened'
  | 'status'
  | 'notified'
  | 'escalated'
  | 'notify_failed'
  | 'suppressed'
  | 'acknowledged'
  | 'assigned'
  | 'note'
  | 'postmortem'
  | 'resolved';

export interface Scope {
  all: boolean;
  monitorIds: string[];
  tags: string[];
}

export interface ScopedMonitor {
  id: string;
  tags: string[];
}

export interface EscalationStep {
  afterSec: number;
  channelIds: string[];
  scheduleId: string | null;
}

export interface ChannelRow {
  id: string;
  org_id: string;
  name: string;
  type: ChannelType;
  config: Record<string, any>;
  enabled: boolean;
  last_used_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RuleRow {
  id: string;
  org_id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  severity: Severity;
  for_sec: number;
  scope_all: boolean;
  monitor_ids: string[];
  tags: string[];
  channel_ids: string[];
  policy_id: string | null;
  notify_recovery: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PolicyRow {
  id: string;
  org_id: string;
  name: string;
  steps: EscalationStep[];
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleRow {
  id: string;
  org_id: string;
  name: string;
  members: string[];
  anchor_at: Date;
  period_sec: number;
  created_at: Date;
  updated_at: Date;
}

export interface SilenceRow {
  id: string;
  org_id: string;
  name: string;
  scope_all: boolean;
  monitor_ids: string[];
  tags: string[];
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
}

export interface MaintenanceRow {
  id: string;
  org_id: string;
  name: string;
  scope_all: boolean;
  monitor_ids: string[];
  tags: string[];
  starts_at: Date;
  duration_sec: number;
  repeat: Repeat;
  public: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface IncidentRow {
  id: string;
  org_id: string;
  number: number;
  monitor_id: string | null;
  monitor_name: string;
  source: IncidentSource;
  server_id: string | null;
  server_rule_id: string | null;
  subject: string;
  title: string;
  cause: string;
  severity: Severity;
  status: IncidentStatus;
  trigger: Trigger;
  started_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
  assignee_id: string | null;
  postmortem: string;
  postmortem_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelView {
  id: string;
  name: string;
  type: ChannelType;
  summary: string;
  config: Record<string, any>;
  enabled: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface RuleView {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  severity: Severity;
  forSec: number;
  scope: Scope;
  channelIds: string[];
  policyId: string | null;
  notifyRecovery: boolean;
  createdAt: string;
}

export interface PolicyView {
  id: string;
  name: string;
  steps: EscalationStep[];
  createdAt: string;
}

export interface MemberRef {
  id: string;
  name: string;
  email: string;
}

export interface ScheduleView {
  id: string;
  name: string;
  members: MemberRef[];
  anchorAt: string;
  periodSec: number;
  onCall: MemberRef | null;
  nextHandoffAt: string;
  createdAt: string;
}

export interface SilenceView {
  id: string;
  name: string;
  scope: Scope;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
}

export interface MaintenanceView {
  id: string;
  name: string;
  scope: Scope;
  startsAt: string;
  durationSec: number;
  repeat: Repeat;
  public: boolean;
  active: boolean;
  nextStartsAt: string | null;
  createdAt: string;
}

export interface IncidentView {
  id: string;
  number: number;
  source: IncidentSource;
  serverId: string | null;
  subject: string;
  monitorId: string | null;
  monitorName: string;
  title: string;
  cause: string;
  severity: Severity;
  status: IncidentStatus;
  trigger: Trigger;
  startedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: MemberRef | null;
  resolvedAt: string | null;
  resolution: string | null;
  assignee: MemberRef | null;
  notified: number;
}

export interface IncidentEventView {
  id: string;
  at: string;
  kind: IncidentEventKind;
  actor: MemberRef | null;
  message: string;
}

export interface NotificationView {
  id: string;
  kind: JobKind;
  step: number;
  target: string;
  status: JobStatus;
  attempts: number;
  runAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface IncidentDetail extends IncidentView {
  postmortem: string;
  postmortemUpdatedAt: string | null;
  events: IncidentEventView[];
  notifications: NotificationView[];
}

export interface IncidentSummary {
  open: number;
  acknowledged: number;
  resolved24h: number;
  active: IncidentView[];
}

export interface AlertMessage {
  event:
    | 'incident.opened'
    | 'incident.escalated'
    | 'incident.resolved'
    | 'test';
  severity: Severity;
  title: string;
  lines: string[];
  url: string | null;
  incident: {
    id: string;
    number: number;
    status: IncidentStatus;
    startedAt: string;
    resolvedAt: string | null;
  } | null;
  monitor: { id: string; name: string; target: string | null } | null;
  server?: { id: string; name: string; host: string | null } | null;
}
