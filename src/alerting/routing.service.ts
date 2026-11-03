import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { toPolicyView, toRuleView, scheduleFacts } from './alert.format';
import {
  assertMembers,
  assertOwned,
  inUse,
  loadMembers,
  notFound,
} from './alert.helpers';
import {
  parseWith,
  policyPatchSchema,
  policySchema,
  rulePatchSchema,
  ruleSchema,
  schedulePatchSchema,
  scheduleSchema,
} from './alert.schema';
import { onCallAt } from './alert.scope';
import type {
  EscalationStep,
  MemberRef,
  PolicyRow,
  PolicyView,
  RuleRow,
  RuleView,
  ScheduleRow,
  ScheduleView,
} from './alert.types';

export const MAX_RULES_PER_ORG = 100;
export const MAX_POLICIES_PER_ORG = 50;
export const MAX_SCHEDULES_PER_ORG = 20;

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function ruleInput(row: RuleRow): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    severity: row.severity,
    forSec: row.for_sec,
    scope: {
      all: row.scope_all,
      monitorIds: row.monitor_ids ?? [],
      tags: row.tags ?? [],
    },
    channelIds: row.channel_ids ?? [],
    policyId: row.policy_id,
    notifyRecovery: row.notify_recovery,
  };
}

@Injectable()
export class RoutingService {
  constructor(private readonly db: DatabaseService) {}

  async listRules(auth: AuthContext): Promise<RuleView[]> {
    const rows = await this.db.rows<RuleRow>(
      'SELECT * FROM alert_rules WHERE org_id = $1 ORDER BY created_at, name',
      [auth.orgId],
    );
    return rows.map(toRuleView);
  }

  async createRule(auth: AuthContext, body: unknown): Promise<RuleView> {
    const input = parseWith(ruleSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM alert_rules WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_RULES_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_RULES_PER_ORG} alert rules`,
      );
    }
    await this.checkRuleRefs(auth.orgId, input);
    const row = await this.db.row<RuleRow>(
      `INSERT INTO alert_rules
         (org_id, name, enabled, trigger, severity, for_sec, scope_all, monitor_ids, tags, channel_ids, policy_id, notify_recovery, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::int, $7, $8::uuid[], $9::text[], $10::uuid[], $11::uuid, $12, $13::uuid)
       RETURNING *`,
      [
        auth.orgId,
        input.name,
        input.enabled,
        input.trigger,
        input.severity,
        input.forSec,
        input.scope.all,
        input.scope.monitorIds,
        input.scope.tags,
        input.channelIds,
        input.policyId,
        input.notifyRecovery,
        auth.user.id,
      ],
    );
    if (!row) throw new Error('Rule was not created');
    return toRuleView(row);
  }

  async updateRule(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<RuleView> {
    const patch = parseWith(rulePatchSchema, body);
    const row = await this.requireRule(auth.orgId, id);
    const input = parseWith(ruleSchema, {
      ...ruleInput(row),
      ...defined(patch),
    });
    await this.checkRuleRefs(auth.orgId, input);
    const updated = await this.db.row<RuleRow>(
      `UPDATE alert_rules SET
         name = $3, enabled = $4, trigger = $5, severity = $6, for_sec = $7::int,
         scope_all = $8, monitor_ids = $9::uuid[], tags = $10::text[], channel_ids = $11::uuid[],
         policy_id = $12::uuid, notify_recovery = $13, updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        input.name,
        input.enabled,
        input.trigger,
        input.severity,
        input.forSec,
        input.scope.all,
        input.scope.monitorIds,
        input.scope.tags,
        input.channelIds,
        input.policyId,
        input.notifyRecovery,
      ],
    );
    if (!updated) throw notFound('Rule');
    return toRuleView(updated);
  }

  async removeRule(auth: AuthContext, id: string): Promise<void> {
    await this.requireRule(auth.orgId, id);
    await this.db.run('DELETE FROM alert_rules WHERE id = $1 AND org_id = $2', [
      id,
      auth.orgId,
    ]);
  }

  async listPolicies(auth: AuthContext): Promise<PolicyView[]> {
    const rows = await this.db.rows<PolicyRow>(
      'SELECT * FROM escalation_policies WHERE org_id = $1 ORDER BY created_at, name',
      [auth.orgId],
    );
    return rows.map(toPolicyView);
  }

  async createPolicy(auth: AuthContext, body: unknown): Promise<PolicyView> {
    const input = parseWith(policySchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM escalation_policies WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_POLICIES_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_POLICIES_PER_ORG} escalation policies`,
      );
    }
    await this.checkSteps(auth.orgId, input.steps);
    const row = await this.db.row<PolicyRow>(
      `INSERT INTO escalation_policies (org_id, name, steps) VALUES ($1, $2, $3::jsonb) RETURNING *`,
      [auth.orgId, input.name, JSON.stringify(input.steps)],
    );
    if (!row) throw new Error('Policy was not created');
    return toPolicyView(row);
  }

  async updatePolicy(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<PolicyView> {
    const patch = parseWith(policyPatchSchema, body);
    const row = await this.requirePolicy(auth.orgId, id);
    const input = parseWith(policySchema, {
      name: patch.name ?? row.name,
      steps: patch.steps ?? row.steps,
    });
    await this.checkSteps(auth.orgId, input.steps);
    const updated = await this.db.row<PolicyRow>(
      `UPDATE escalation_policies SET name = $3, steps = $4::jsonb, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, auth.orgId, input.name, JSON.stringify(input.steps)],
    );
    if (!updated) throw notFound('Policy');
    return toPolicyView(updated);
  }

  async removePolicy(auth: AuthContext, id: string): Promise<void> {
    await this.requirePolicy(auth.orgId, id);
    const rules = await this.db.rows<{ name: string }>(
      'SELECT name FROM alert_rules WHERE org_id = $1 AND policy_id = $2 ORDER BY name',
      [auth.orgId, id],
    );
    const serverRules = await this.db.rows<{ name: string }>(
      'SELECT name FROM server_rules WHERE org_id = $1 AND policy_id = $2 ORDER BY name',
      [auth.orgId, id],
    );
    const users = [
      ...rules.map((rule) => `rule "${rule.name}"`),
      ...serverRules.map((rule) => `server rule "${rule.name}"`),
    ];
    if (users.length > 0) throw inUse('This policy', users);
    await this.db.run(
      'DELETE FROM escalation_policies WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
  }

  async listSchedules(auth: AuthContext): Promise<ScheduleView[]> {
    const rows = await this.db.rows<ScheduleRow>(
      'SELECT * FROM oncall_schedules WHERE org_id = $1 ORDER BY created_at, name',
      [auth.orgId],
    );
    const everyone = await loadMembers(
      this.db,
      auth.orgId,
      rows.flatMap((row) => row.members ?? []),
    );
    const now = new Date();
    return rows.map((row) => this.scheduleView(row, everyone, now));
  }

  async createSchedule(
    auth: AuthContext,
    body: unknown,
  ): Promise<ScheduleView> {
    const input = parseWith(scheduleSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM oncall_schedules WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_SCHEDULES_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_SCHEDULES_PER_ORG} on-call schedules`,
      );
    }
    await assertMembers(this.db, auth.orgId, input.members);
    const row = await this.db.row<ScheduleRow>(
      `INSERT INTO oncall_schedules (org_id, name, members, anchor_at, period_sec)
       VALUES ($1, $2, $3::uuid[], $4::timestamptz, $5::int) RETURNING *`,
      [auth.orgId, input.name, input.members, input.anchorAt, input.periodSec],
    );
    if (!row) throw new Error('Schedule was not created');
    return this.viewOne(auth.orgId, row);
  }

  async updateSchedule(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<ScheduleView> {
    const patch = parseWith(schedulePatchSchema, body);
    const row = await this.requireSchedule(auth.orgId, id);
    const input = parseWith(scheduleSchema, {
      name: patch.name ?? row.name,
      members: patch.members ?? row.members,
      anchorAt: patch.anchorAt ?? row.anchor_at,
      periodSec: patch.periodSec ?? row.period_sec,
    });
    await assertMembers(this.db, auth.orgId, input.members);
    const updated = await this.db.row<ScheduleRow>(
      `UPDATE oncall_schedules
          SET name = $3, members = $4::uuid[], anchor_at = $5::timestamptz, period_sec = $6::int, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        input.name,
        input.members,
        input.anchorAt,
        input.periodSec,
      ],
    );
    if (!updated) throw notFound('Schedule');
    return this.viewOne(auth.orgId, updated);
  }

  async removeSchedule(auth: AuthContext, id: string): Promise<void> {
    await this.requireSchedule(auth.orgId, id);
    const policies = await this.db.rows<{ name: string }>(
      'SELECT name FROM escalation_policies WHERE org_id = $1 AND steps @> $2::jsonb ORDER BY name',
      [auth.orgId, JSON.stringify([{ scheduleId: id }])],
    );
    if (policies.length > 0)
      throw inUse(
        'This schedule',
        policies.map((policy) => `policy "${policy.name}"`),
      );
    await this.db.run(
      'DELETE FROM oncall_schedules WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
  }

  private async checkRuleRefs(
    orgId: string,
    input: {
      scope: { monitorIds: string[] };
      channelIds: string[];
      policyId: string | null;
    },
  ) {
    await assertOwned(this.db, 'monitors', orgId, input.scope.monitorIds);
    await assertOwned(this.db, 'channels', orgId, input.channelIds);
    if (input.policyId)
      await assertOwned(this.db, 'policies', orgId, [input.policyId]);
  }

  private async checkSteps(orgId: string, steps: EscalationStep[]) {
    await assertOwned(
      this.db,
      'channels',
      orgId,
      steps.flatMap((step) => step.channelIds),
    );
    await assertOwned(
      this.db,
      'schedules',
      orgId,
      steps.flatMap((step) => (step.scheduleId ? [step.scheduleId] : [])),
    );
  }

  private scheduleView(
    row: ScheduleRow,
    everyone: Map<string, MemberRef>,
    now: Date,
  ): ScheduleView {
    const facts = scheduleFacts(row);
    const { userId, nextHandoffAt } = onCallAt(
      facts,
      now,
      new Set(everyone.keys()),
    );
    return {
      id: row.id,
      name: row.name,
      members: facts.members.flatMap((memberId) => {
        const member = everyone.get(memberId);
        return member ? [member] : [];
      }),
      anchorAt: facts.anchorAt.toISOString(),
      periodSec: row.period_sec,
      onCall: userId ? (everyone.get(userId) ?? null) : null,
      nextHandoffAt: nextHandoffAt.toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private async viewOne(
    orgId: string,
    row: ScheduleRow,
  ): Promise<ScheduleView> {
    const everyone = await loadMembers(this.db, orgId, row.members ?? []);
    return this.scheduleView(row, everyone, new Date());
  }

  private async requireRule(orgId: string, id: string): Promise<RuleRow> {
    const row = await this.db.row<RuleRow>(
      'SELECT * FROM alert_rules WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Rule');
    return row;
  }

  private async requirePolicy(orgId: string, id: string): Promise<PolicyRow> {
    const row = await this.db.row<PolicyRow>(
      'SELECT * FROM escalation_policies WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Policy');
    return row;
  }

  private async requireSchedule(
    orgId: string,
    id: string,
  ): Promise<ScheduleRow> {
    const row = await this.db.row<ScheduleRow>(
      'SELECT * FROM oncall_schedules WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Schedule');
    return row;
  }
}
