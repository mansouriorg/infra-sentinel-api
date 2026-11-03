import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { assertOwned, notFound } from '../alerting/alert.helpers';
import { randomToken, sha256 } from '../common/crypto';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RANGE_SPECS,
  toDetail,
  toSummary,
  toTokenView,
  type SummaryExtras,
} from './server.format';
import {
  linkMonitorsSchema,
  parseWith,
  serverPatchSchema,
  tokenCreateSchema,
} from './server.schema';
import {
  METRIC_RANGES,
  type CreatedEnrollmentToken,
  type EnrollmentTokenRow,
  type EnrollmentTokenView,
  type LinkedMonitor,
  type MetricPoint,
  type MetricRange,
  type MetricSeries,
  type ServerDetail,
  type ServerRow,
  type ServerSummary,
} from './server.types';

export const MAX_SERVERS_PER_ORG = 200;
export const MAX_ACTIVE_TOKENS_PER_ORG = 50;
export const AGENT_PLATFORMS = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
] as const;

export interface AgentInfoView {
  apiUrl: string;
  binaries: { os: string; arch: string; size: number }[];
  buildCommand: string;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

@Injectable()
export class ServersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly bus: EventBus,
  ) {}

  agentDir(): string {
    return resolve(process.cwd(), this.config.get('AGENT_DIR'));
  }

  agentInfo(): AgentInfoView {
    const binaries = AGENT_PLATFORMS.flatMap(({ os, arch }) => {
      const file = resolve(
        this.agentDir(),
        'dist',
        `infra-sentinel-agent-${os}-${arch}`,
      );
      return existsSync(file) ? [{ os, arch, size: statSync(file).size }] : [];
    });
    return {
      apiUrl: this.config.get('PUBLIC_API_URL').replace(/\/+$/, ''),
      binaries,
      buildCommand: 'bash scripts/agent-build.sh',
    };
  }

  async list(auth: AuthContext): Promise<ServerSummary[]> {
    const rows = await this.db.rows<ServerRow>(
      'SELECT * FROM servers WHERE org_id = $1 ORDER BY lower(name), created_at',
      [auth.orgId],
    );
    const extras = await this.extras(
      auth.orgId,
      rows.map((row) => row.id),
    );
    const now = new Date();
    return rows.map((row) =>
      toSummary(row, extras.get(row.id) ?? emptyExtras(), now),
    );
  }

  async detail(auth: AuthContext, id: string): Promise<ServerDetail> {
    const row = await this.requireRow(auth.orgId, id);
    return this.detailOf(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<ServerDetail> {
    const patch = parseWith(serverPatchSchema, body);
    const row = await this.requireRow(auth.orgId, id);
    const updated = await this.db.row<ServerRow>(
      `UPDATE servers SET name = $3, tags = $4::text[], updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        patch.name ?? row.name,
        [...new Set(patch.tags ?? row.tags ?? [])],
      ],
    );
    if (!updated) throw notFound('Server');
    this.bus.publish(auth.orgId, {
      type: 'server',
      serverId: id,
      change: 'updated',
    });
    return this.detailOf(updated);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.requireRow(auth.orgId, id);
    await this.db.run('DELETE FROM servers WHERE id = $1 AND org_id = $2', [
      id,
      auth.orgId,
    ]);
    this.bus.publish(auth.orgId, {
      type: 'server',
      serverId: id,
      change: 'deleted',
    });
  }

  async setMonitors(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<ServerDetail> {
    const input = parseWith(linkMonitorsSchema, body);
    const row = await this.requireRow(auth.orgId, id);
    await assertOwned(this.db, 'monitors', auth.orgId, input.monitorIds);
    await this.db.tx(async (tx) => {
      await tx.run('DELETE FROM server_monitors WHERE server_id = $1', [id]);
      if (input.monitorIds.length > 0) {
        await tx.run(
          'INSERT INTO server_monitors (server_id, monitor_id) SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING',
          [id, input.monitorIds],
        );
      }
    });
    this.bus.publish(auth.orgId, {
      type: 'server',
      serverId: id,
      change: 'updated',
    });
    return this.detailOf(row);
  }

  async metrics(
    auth: AuthContext,
    id: string,
    range?: string,
  ): Promise<MetricSeries> {
    const chosen = (range ?? '1h') as MetricRange;
    if (!METRIC_RANGES.includes(chosen)) {
      throw new BadRequestException(
        `range must be one of ${METRIC_RANGES.join(', ')}`,
      );
    }
    await this.requireRow(auth.orgId, id);
    const spec = RANGE_SPECS[chosen];
    const rows = await this.db.rows<{
      t: string;
      cpu: number | null;
      mem: number | null;
      swap: number | null;
      load1: number | null;
      disk: number | null;
      net_in: number | null;
      net_out: number | null;
    }>(
      `SELECT (floor(extract(epoch FROM ts) / $3::int) * $3::int)::bigint AS t,
              avg(cpu)::float8 AS cpu, avg(mem)::float8 AS mem, avg(swap)::float8 AS swap,
              avg(load1)::float8 AS load1, avg(disk)::float8 AS disk,
              avg(net_in)::float8 AS net_in, avg(net_out)::float8 AS net_out
         FROM server_metrics
        WHERE server_id = $1 AND ts > now() - ($2::int * interval '1 second')
        GROUP BY 1 ORDER BY 1`,
      [id, spec.seconds, spec.bucketSec],
    );
    const points: MetricPoint[] = rows.map((row) => ({
      at: new Date(Number(row.t) * 1000).toISOString(),
      cpu: round(row.cpu),
      mem: round(row.mem),
      swap: round(row.swap),
      load1: round(row.load1),
      disk: round(row.disk),
      netIn: round(row.net_in, 0),
      netOut: round(row.net_out, 0),
    }));
    return { range: chosen, bucketSec: spec.bucketSec, points };
  }

  async listTokens(auth: AuthContext): Promise<EnrollmentTokenView[]> {
    const rows = await this.db.rows<EnrollmentTokenRow>(
      'SELECT * FROM enrollment_tokens WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100',
      [auth.orgId],
    );
    const now = new Date();
    return rows.map((row) => toTokenView(row, now));
  }

  async createToken(
    auth: AuthContext,
    body: unknown,
  ): Promise<CreatedEnrollmentToken> {
    const input = parseWith(tokenCreateSchema, body);
    const active = await this.db.row<{ n: number }>(
      `SELECT count(*)::int AS n FROM enrollment_tokens
        WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR uses < max_uses)`,
      [auth.orgId],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_TOKENS_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_ACTIVE_TOKENS_PER_ORG} active enrollment tokens`,
      );
    }
    const token = `ist_${randomToken(24)}`;
    const row = await this.db.row<EnrollmentTokenRow>(
      `INSERT INTO enrollment_tokens (org_id, name, token_hash, prefix, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5::int, now() + ($6::int * interval '1 day'), $7::uuid)
       RETURNING *`,
      [
        auth.orgId,
        input.name,
        sha256(token),
        token.slice(0, 8),
        input.maxUses ?? null,
        input.expiresInDays,
        auth.user.id,
      ],
    );
    if (!row) throw new Error('Token was not created');
    return {
      ...toTokenView(row, new Date()),
      token,
      apiUrl: this.agentInfo().apiUrl,
    };
  }

  async revokeToken(auth: AuthContext, id: string): Promise<void> {
    const count = await this.db.run(
      'UPDATE enrollment_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL',
      [id, auth.orgId],
    );
    if (count === 0) {
      const exists = await this.db.row(
        'SELECT 1 FROM enrollment_tokens WHERE id = $1 AND org_id = $2',
        [id, auth.orgId],
      );
      if (!exists) throw notFound('Token');
    }
  }

  private async detailOf(row: ServerRow): Promise<ServerDetail> {
    const [extras, linked] = await Promise.all([
      this.extras(row.org_id, [row.id]),
      this.db.rows<LinkedMonitor>(
        `SELECT m.id, m.name, m.status
           FROM server_monitors sm JOIN monitors m ON m.id = sm.monitor_id
          WHERE sm.server_id = $1 ORDER BY lower(m.name)`,
        [row.id],
      ),
    ]);
    return toDetail(
      row,
      extras.get(row.id) ?? emptyExtras(),
      linked,
      new Date(),
    );
  }

  private async extras(
    orgId: string,
    ids: string[],
  ): Promise<Map<string, SummaryExtras>> {
    const out = new Map<string, SummaryExtras>(
      ids.map((id) => [id, emptyExtras()]),
    );
    if (ids.length === 0) return out;
    const [incidents, links, history] = await Promise.all([
      this.db.rows<{ server_id: string; n: number }>(
        `SELECT server_id, count(*)::int AS n FROM incidents
          WHERE org_id = $1 AND source = 'server' AND status <> 'resolved' AND server_id = ANY($2::uuid[])
          GROUP BY server_id`,
        [orgId, ids],
      ),
      this.db.rows<{ server_id: string; monitor_id: string }>(
        'SELECT server_id, monitor_id FROM server_monitors WHERE server_id = ANY($1::uuid[])',
        [ids],
      ),
      this.db.rows<{ server_id: string; v: number | null }>(
        `SELECT server_id, avg(cpu)::float8 AS v
           FROM server_metrics
          WHERE server_id = ANY($1::uuid[]) AND ts > now() - interval '30 minutes'
          GROUP BY server_id, floor(extract(epoch FROM ts) / 75)
          ORDER BY server_id, floor(extract(epoch FROM ts) / 75)`,
        [ids],
      ),
    ]);
    for (const row of incidents) {
      const entry = out.get(row.server_id);
      if (entry) entry.openIncidents = Number(row.n);
    }
    for (const row of links)
      out.get(row.server_id)?.monitorIds.push(row.monitor_id);
    for (const row of history) {
      if (row.v !== null)
        out.get(row.server_id)?.cpuHistory.push(round(row.v, 1) ?? 0);
    }
    return out;
  }

  private async requireRow(orgId: string, id: string): Promise<ServerRow> {
    const row = await this.db.row<ServerRow>(
      'SELECT * FROM servers WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Server');
    return row;
  }
}

function emptyExtras(): SummaryExtras {
  return { openIncidents: 0, monitorIds: [], cpuHistory: [] };
}
