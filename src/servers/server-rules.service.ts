import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { assertOwned, notFound } from '../alerting/alert.helpers';
import { DatabaseService } from '../database/database.service';
import { toRuleView } from './server.format';
import {
  parseWith,
  serverRulePatchSchema,
  serverRuleSchema,
  type ServerRuleInput,
} from './server.schema';
import type { ServerRuleRow, ServerRuleView } from './server.types';

export const MAX_SERVER_RULES_PER_ORG = 100;

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function ruleInput(row: ServerRuleRow): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    metric: row.metric,
    mode: row.mode,
    threshold: row.threshold,
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
  };
}

@Injectable()
export class ServerRulesService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: AuthContext): Promise<ServerRuleView[]> {
    const rows = await this.db.rows<ServerRuleRow>(
      'SELECT * FROM server_rules WHERE org_id = $1 ORDER BY created_at, name',
      [auth.orgId],
    );
    return rows.map(toRuleView);
  }

  async create(auth: AuthContext, body: unknown): Promise<ServerRuleView> {
    const input = parseWith(serverRuleSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM server_rules WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_SERVER_RULES_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_SERVER_RULES_PER_ORG} server rules`,
      );
    }
    await this.checkRefs(auth.orgId, input);
    const row = await this.db.row<ServerRuleRow>(
      `INSERT INTO server_rules
         (org_id, name, enabled, metric, mode, threshold, sensitivity, target, severity, for_sec,
          scope_all, server_ids, tags, channel_ids, policy_id, notify_recovery, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::float8, $7, $8, $9, $10::int, $11, $12::uuid[], $13::text[], $14::uuid[], $15::uuid, $16, $17::uuid)
       RETURNING *`,
      [
        auth.orgId,
        input.name,
        input.enabled,
        input.metric,
        input.mode,
        input.threshold,
        input.sensitivity,
        input.target,
        input.severity,
        input.forSec,
        input.scope.all,
        input.scope.serverIds,
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

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<ServerRuleView> {
    const patch = parseWith(serverRulePatchSchema, body);
    const row = await this.require(auth.orgId, id);
    const merged: Record<string, unknown> = {
      ...ruleInput(row),
      ...defined(patch),
    };
    if (
      patch.metric !== undefined &&
      patch.metric !== row.metric &&
      patch.threshold === undefined
    ) {
      merged.threshold = undefined;
    }
    if (patch.mode === 'anomaly') merged.threshold = undefined;
    const input = parseWith(serverRuleSchema, merged);
    await this.checkRefs(auth.orgId, input);
    const updated = await this.db.row<ServerRuleRow>(
      `UPDATE server_rules SET
         name = $3, enabled = $4, metric = $5, mode = $6, threshold = $7::float8, sensitivity = $8, target = $9,
         severity = $10, for_sec = $11::int, scope_all = $12, server_ids = $13::uuid[], tags = $14::text[],
         channel_ids = $15::uuid[], policy_id = $16::uuid, notify_recovery = $17, updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        input.name,
        input.enabled,
        input.metric,
        input.mode,
        input.threshold,
        input.sensitivity,
        input.target,
        input.severity,
        input.forSec,
        input.scope.all,
        input.scope.serverIds,
        input.scope.tags,
        input.channelIds,
        input.policyId,
        input.notifyRecovery,
      ],
    );
    if (!updated) throw notFound('Rule');
    return toRuleView(updated);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.require(auth.orgId, id);
    await this.db.run(
      'DELETE FROM server_rules WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
  }

  private async checkRefs(
    orgId: string,
    input: ServerRuleInput,
  ): Promise<void> {
    await assertOwned(this.db, 'servers', orgId, input.scope.serverIds);
    await assertOwned(this.db, 'channels', orgId, input.channelIds);
    if (input.policyId)
      await assertOwned(this.db, 'policies', orgId, [input.policyId]);
  }

  private async require(orgId: string, id: string): Promise<ServerRuleRow> {
    const row = await this.db.row<ServerRuleRow>(
      'SELECT * FROM server_rules WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Rule');
    return row;
  }
}
