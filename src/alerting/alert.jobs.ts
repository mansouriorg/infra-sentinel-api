import type { Db } from '../database/executor';
import type { ChannelType, EscalationStep, JobKind } from './alert.types';

export const TYPE_LABEL: Record<ChannelType, string> = {
  email: 'Email',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  webhook: 'Webhook',
};

export interface RoutingContext {
  policies: Map<string, EscalationStep[]>;
  channels: Map<string, { name: string; type: ChannelType }>;
  schedules: Map<string, string>;
}

export interface JobRule {
  id: string;
  source: 'monitor' | 'server';
  channelIds: string[];
  policyId: string | null;
  forSec: number;
}

export async function loadRouting(
  db: Db,
  orgId: string,
): Promise<RoutingContext> {
  const [policies, channels, schedules] = await Promise.all([
    db.rows<{ id: string; steps: EscalationStep[] }>(
      'SELECT id, steps FROM escalation_policies WHERE org_id = $1',
      [orgId],
    ),
    db.rows<{ id: string; name: string; type: ChannelType }>(
      'SELECT id, name, type FROM notification_channels WHERE org_id = $1',
      [orgId],
    ),
    db.rows<{ id: string; name: string }>(
      'SELECT id, name FROM oncall_schedules WHERE org_id = $1',
      [orgId],
    ),
  ]);
  return {
    policies: new Map(policies.map((row) => [row.id, row.steps ?? []])),
    channels: new Map(
      channels.map((row) => [row.id, { name: row.name, type: row.type }]),
    ),
    schedules: new Map(schedules.map((row) => [row.id, row.name])),
  };
}

const INSERT_JOB = `
  INSERT INTO notification_jobs (org_id, incident_id, rule_id, server_rule_id, kind, step, channel_id, schedule_id, target_label, run_at)
  VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::int, $7::uuid, $8::uuid, $9,
          GREATEST(now(), $10::timestamptz + ($11::float8 * interval '1 second')))
  ON CONFLICT DO NOTHING`;

export async function createJobs(
  db: Db,
  routing: RoutingContext,
  orgId: string,
  incidentId: string,
  startedAt: Date,
  rules: JobRule[],
): Promise<void> {
  const add = async (
    rule: JobRule,
    kind: JobKind,
    step: number,
    target: { channelId?: string; scheduleId?: string },
    delaySec: number,
  ) => {
    let label: string | undefined;
    if (target.channelId) {
      const channel = routing.channels.get(target.channelId);
      if (channel) label = `${TYPE_LABEL[channel.type]}: ${channel.name}`;
    } else if (target.scheduleId) {
      const name = routing.schedules.get(target.scheduleId);
      if (name) label = `On-call: ${name}`;
    }
    if (!label) return;
    await db.run(INSERT_JOB, [
      orgId,
      incidentId,
      rule.source === 'monitor' ? rule.id : null,
      rule.source === 'server' ? rule.id : null,
      kind,
      step,
      target.channelId ?? null,
      target.scheduleId ?? null,
      label,
      startedAt,
      delaySec,
    ]);
  };

  for (const rule of rules) {
    for (const channelId of rule.channelIds)
      await add(rule, 'alert', 0, { channelId }, rule.forSec);
    const steps = rule.policyId
      ? (routing.policies.get(rule.policyId) ?? [])
      : [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const delay = rule.forSec + step.afterSec;
      for (const channelId of step.channelIds)
        await add(rule, 'escalation', index, { channelId }, delay);
      if (step.scheduleId)
        await add(
          rule,
          'escalation',
          index,
          { scheduleId: step.scheduleId },
          delay,
        );
    }
  }
}
