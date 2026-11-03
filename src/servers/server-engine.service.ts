import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { toScope } from '../alerting/alert.format';
import {
  createJobs,
  loadRouting,
  type RoutingContext,
} from '../alerting/alert.jobs';
import {
  formatDuration,
  scopeMatches,
  windowIsActive,
  type Window,
} from '../alerting/alert.scope';
import type {
  IncidentRow,
  MaintenanceRow,
  Scope,
  Severity,
} from '../alerting/alert.types';
import {
  addIncidentEvent,
  closeIncident,
  type Resolution,
} from '../alerting/incident.lifecycle';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import { ageSeconds, serverStatus } from './server.format';
import {
  breachKey,
  evaluateRule,
  ruleTitle,
  type RuleFacts,
} from './server.rules';
import type {
  Baseline,
  Baselines,
  Breach,
  RuleMode,
  Sensitivity,
  ServerLatest,
  ServerMetric,
  ServerSnapshot,
  ServerStatus,
} from './server.types';

const TICK_MS = 5000;
const PURGE_EVERY_MS = 3_600_000;
const FIRST_PURGE_MS = 180_000;
const BASELINE_TTL_MS = 30_000;
const OPEN_BATCH = 50;
const RESOLVE_BATCH = 100;
const SNAPSHOT_KEYS = [
  'processes',
  'containers',
  'services',
  'failedServices',
  'watchedProcesses',
];

const RULES_SQL = `
  SELECT id, org_id, name, metric, mode, threshold, sensitivity, target, severity, for_sec,
         scope_all, server_ids, tags, channel_ids, policy_id
    FROM server_rules
   WHERE enabled`;

const SERVERS_SQL = `
  SELECT id, org_id, name, tags, interval_sec, last_seen_at, cpu_count, docker, systemd, latest
    FROM servers`;

const SNAPSHOTS_SQL = `
  SELECT id, snapshot - $2::text[] AS snapshot
    FROM servers
   WHERE org_id = ANY($1::uuid[])`;

const BASELINE_SQL = `
  SELECT server_id,
         count(*) FILTER (WHERE ts <= now() - interval '10 minutes')::int AS samples,
         count(*) FILTER (WHERE ts > now() - interval '5 minutes')::int AS recent_samples,
         avg(cpu) FILTER (WHERE ts > now() - interval '5 minutes')::float8 AS cpu_recent,
         avg(cpu) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS cpu_mean,
         stddev_pop(cpu) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS cpu_std,
         avg(mem) FILTER (WHERE ts > now() - interval '5 minutes')::float8 AS mem_recent,
         avg(mem) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS mem_mean,
         stddev_pop(mem) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS mem_std,
         avg(load1) FILTER (WHERE ts > now() - interval '5 minutes')::float8 AS load_recent,
         avg(load1) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS load_mean,
         stddev_pop(load1) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS load_std,
         avg(net_in) FILTER (WHERE ts > now() - interval '5 minutes')::float8 AS net_in_recent,
         avg(net_in) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS net_in_mean,
         stddev_pop(net_in) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS net_in_std,
         avg(net_out) FILTER (WHERE ts > now() - interval '5 minutes')::float8 AS net_out_recent,
         avg(net_out) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS net_out_mean,
         stddev_pop(net_out) FILTER (WHERE ts <= now() - interval '10 minutes')::float8 AS net_out_std
    FROM server_metrics
   WHERE server_id = ANY($1::uuid[]) AND ts > now() - interval '24 hours'
   GROUP BY server_id`;

const STATE_SQL = 'SELECT rule_id, server_id, subject FROM server_rule_state';

const OPEN_SQL = `
  SELECT st.rule_id, st.server_id, st.subject, st.breach_since, st.value, st.detail,
         r.org_id, r.name AS rule_name, r.metric, r.mode, r.threshold, r.severity, r.channel_ids, r.policy_id,
         sv.name AS server_name, sv.tags AS server_tags
    FROM server_rule_state st
    JOIN server_rules r ON r.id = st.rule_id AND r.enabled
    JOIN servers sv ON sv.id = st.server_id
   WHERE st.breach_since <= now() - (r.for_sec * interval '1 second')
     AND NOT EXISTS (
       SELECT 1 FROM incidents i
        WHERE i.server_rule_id = st.rule_id AND i.server_id = st.server_id AND i.subject = st.subject AND i.status <> 'resolved')
     AND st.breach_since > COALESCE(
       (SELECT max(i.resolved_at) FROM incidents i
         WHERE i.server_rule_id = st.rule_id AND i.server_id = st.server_id AND i.subject = st.subject),
       '-infinity'::timestamptz)
   ORDER BY st.breach_since
   LIMIT ${OPEN_BATCH}`;

const ENDED_SQL = `
  SELECT i.id, i.org_id, i.number, i.title, i.started_at, i.monitor_name,
         sv.id AS server_id, r.id AS rule_id, r.enabled AS rule_enabled
    FROM incidents i
    LEFT JOIN servers sv ON sv.id = i.server_id
    LEFT JOIN server_rules r ON r.id = i.server_rule_id
    LEFT JOIN server_rule_state st
      ON st.rule_id = i.server_rule_id AND st.server_id = i.server_id AND st.subject = i.subject
   WHERE i.status <> 'resolved' AND i.source = 'server' AND st.rule_id IS NULL
   ORDER BY i.started_at
   LIMIT ${RESOLVE_BATCH}`;

interface RuleEntry {
  id: string;
  org_id: string;
  name: string;
  metric: ServerMetric;
  mode: RuleMode;
  threshold: number | null;
  sensitivity: Sensitivity;
  target: string;
  severity: Severity;
  for_sec: number;
  scope_all: boolean;
  server_ids: string[] | null;
  tags: string[] | null;
}

interface ServerEntry {
  id: string;
  org_id: string;
  name: string;
  tags: string[] | null;
  interval_sec: number;
  last_seen_at: Date | null;
  cpu_count: number;
  docker: boolean;
  systemd: boolean;
  latest: ServerLatest | null;
}

interface StateKey {
  rule_id: string;
  server_id: string;
  subject: string;
}

interface StateWrite extends StateKey {
  value: number | null;
  detail: string;
}

interface OpenCandidate {
  rule_id: string;
  server_id: string;
  subject: string;
  breach_since: Date;
  value: number | null;
  detail: string;
  org_id: string;
  rule_name: string;
  metric: ServerMetric;
  mode: RuleMode;
  threshold: number | null;
  severity: Severity;
  channel_ids: string[] | null;
  policy_id: string | null;
  server_name: string;
  server_tags: string[] | null;
}

interface OrgContext extends RoutingContext {
  windows: { scope: Scope; window: Window }[];
}

export interface ServerTickResult {
  tracked: number;
  opened: number;
  resolved: number;
}

class NoIncident extends Error {}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function incidentTrigger(
  metric: ServerMetric,
  mode: RuleMode,
): 'down' | 'degraded' {
  if (mode === 'anomaly') return 'degraded';
  return metric === 'offline' ||
    metric === 'container' ||
    metric === 'service' ||
    metric === 'process'
    ? 'down'
    : 'degraded';
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toBaselines(row: Record<string, any>): Baselines {
  const samples = Number(row.samples ?? 0);
  const recentSamples = Number(row.recent_samples ?? 0);
  const build = (prefix: string): Baseline => ({
    recent: toNumber(row[`${prefix}_recent`]),
    mean: toNumber(row[`${prefix}_mean`]),
    std: toNumber(row[`${prefix}_std`]),
    samples,
    recentSamples,
  });
  return {
    cpu: build('cpu'),
    memory: build('mem'),
    load: build('load'),
    net_in: build('net_in'),
    net_out: build('net_out'),
  };
}

@Injectable()
export class ServerEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServerEngine.name);
  private readonly baselines = new Map<
    string,
    { at: number; value: Baselines }
  >();
  private readonly statuses = new Map<string, ServerStatus>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private nextPurgeAt = Date.now() + FIRST_PURGE_MS;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Server engine is off (SCHEDULER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.loop(), TICK_MS);
    this.timer.unref();
    this.logger.log('Server engine running');
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<ServerTickResult> {
    const now = new Date();
    const tracked = await this.evaluateAll(now);
    const contexts = new Map<string, Promise<OrgContext>>();
    const context = (orgId: string) => {
      let loaded = contexts.get(orgId);
      if (!loaded) {
        loaded = this.loadContext(orgId);
        contexts.set(orgId, loaded);
      }
      return loaded;
    };
    const opened = await this.openNew(context);
    const resolved = await this.resolveEnded();
    return { tracked, opened, resolved };
  }

  async purge(): Promise<void> {
    await this.db.run(
      `DELETE FROM server_metrics WHERE ts < now() - ($1::int * interval '1 day')`,
      [this.config.get('METRIC_RETENTION_DAYS')],
    );
    await this.db.run(
      `DELETE FROM enrollment_tokens
        WHERE (expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days')
          AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.enrollment_token_id = enrollment_tokens.id)`,
    );
  }

  private async loop(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.tick();
      if (Date.now() >= this.nextPurgeAt) {
        this.nextPurgeAt = Date.now() + PURGE_EVERY_MS;
        await this.purge();
      }
    } catch (error) {
      if (!this.stopping)
        this.logger.error(`Server engine tick failed: ${reason(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async evaluateAll(now: Date): Promise<number> {
    const [rules, servers, existing] = await Promise.all([
      this.db.rows<RuleEntry>(RULES_SQL),
      this.db.rows<ServerEntry>(SERVERS_SQL),
      this.db.rows<StateKey>(STATE_SQL),
    ]);

    this.trackStatuses(servers, now);

    const orgsWithRules = [...new Set(rules.map((rule) => rule.org_id))];
    const snapshots = new Map<string, ServerSnapshot>();
    if (orgsWithRules.length > 0) {
      const wanted = new Set<string>(['disks']);
      for (const rule of rules) {
        if (rule.metric === 'container') wanted.add('containers');
        if (rule.metric === 'service') {
          wanted.add('services');
          wanted.add('failedServices');
        }
        if (rule.metric === 'process') wanted.add('watchedProcesses');
      }
      const drop = SNAPSHOT_KEYS.filter((key) => !wanted.has(key));
      const rows = await this.db.rows<{ id: string; snapshot: ServerSnapshot }>(
        SNAPSHOTS_SQL,
        [orgsWithRules, drop],
      );
      for (const row of rows) snapshots.set(row.id, row.snapshot ?? {});
    }

    const baselines = await this.loadBaselines(rules, servers, now);

    const writes: StateWrite[] = [];
    const scoped = new Set<string>();
    const known = new Set<string>();
    const breached = new Set<string>();

    for (const rule of rules) {
      const scope: Scope = {
        all: rule.scope_all,
        monitorIds: rule.server_ids ?? [],
        tags: rule.tags ?? [],
      };
      const facts: RuleFacts = {
        metric: rule.metric,
        mode: rule.mode,
        threshold: rule.threshold === null ? null : Number(rule.threshold),
        sensitivity: rule.sensitivity,
        target: rule.target,
      };
      for (const server of servers) {
        if (server.org_id !== rule.org_id) continue;
        if (!scopeMatches(scope, { id: server.id, tags: server.tags ?? [] }))
          continue;
        const pair = `${rule.id}|${server.id}`;
        scoped.add(pair);
        const evaluation = evaluateRule(
          facts,
          {
            status: serverStatus(server.last_seen_at, server.interval_sec, now),
            ageSec: ageSeconds(server.last_seen_at, now),
            cpuCount: server.cpu_count,
            docker: server.docker,
            systemd: server.systemd,
            latest: server.latest ?? {},
            snapshot: snapshots.get(server.id) ?? {},
          },
          baselines.get(server.id),
        );
        if (!evaluation.known) continue;
        known.add(pair);
        for (const breach of evaluation.breaches) {
          breached.add(breachKey(rule.id, server.id, breach.subject));
          writes.push(toWrite(rule.id, server.id, breach));
        }
      }
    }

    const stale = existing.filter((state) => {
      const pair = `${state.rule_id}|${state.server_id}`;
      if (!scoped.has(pair)) return true;
      if (!known.has(pair)) return false;
      return !breached.has(
        breachKey(state.rule_id, state.server_id, state.subject),
      );
    });

    if (stale.length > 0) {
      await this.db.run(
        `DELETE FROM server_rule_state st
          USING jsonb_to_recordset($1::jsonb) AS d(rule_id uuid, server_id uuid, subject text)
          WHERE st.rule_id = d.rule_id AND st.server_id = d.server_id AND st.subject = d.subject`,
        [JSON.stringify(stale)],
      );
    }
    for (let from = 0; from < writes.length; from += 500) {
      await this.db.run(
        `INSERT INTO server_rule_state (rule_id, server_id, subject, breach_since, value, detail)
         SELECT w.rule_id, w.server_id, w.subject, now(), w.value, w.detail
           FROM jsonb_to_recordset($1::jsonb) AS w(rule_id uuid, server_id uuid, subject text, value float8, detail text)
         ON CONFLICT (rule_id, server_id, subject)
         DO UPDATE SET value = EXCLUDED.value, detail = EXCLUDED.detail, updated_at = now()`,
        [JSON.stringify(writes.slice(from, from + 500))],
      );
    }
    return servers.length;
  }

  private trackStatuses(servers: ServerEntry[], now: Date): void {
    const seen = new Set<string>();
    for (const server of servers) {
      seen.add(server.id);
      const status = serverStatus(
        server.last_seen_at,
        server.interval_sec,
        now,
      );
      const previous = this.statuses.get(server.id);
      this.statuses.set(server.id, status);
      if (previous !== undefined && previous !== status) {
        this.bus.publish(server.org_id, {
          type: 'server',
          serverId: server.id,
          change: 'status',
        });
      }
    }
    for (const id of [...this.statuses.keys()]) {
      if (!seen.has(id)) this.statuses.delete(id);
    }
  }

  private async loadBaselines(
    rules: RuleEntry[],
    servers: ServerEntry[],
    now: Date,
  ): Promise<Map<string, Baselines>> {
    const out = new Map<string, Baselines>();
    const anomalies = rules.filter((rule) => rule.mode === 'anomaly');
    if (anomalies.length === 0) {
      this.baselines.clear();
      return out;
    }
    const needed = new Set<string>();
    for (const rule of anomalies) {
      const scope: Scope = {
        all: rule.scope_all,
        monitorIds: rule.server_ids ?? [],
        tags: rule.tags ?? [],
      };
      for (const server of servers) {
        if (server.org_id !== rule.org_id) continue;
        if (
          serverStatus(server.last_seen_at, server.interval_sec, now) !==
          'online'
        )
          continue;
        if (scopeMatches(scope, { id: server.id, tags: server.tags ?? [] }))
          needed.add(server.id);
      }
    }
    const stamp = now.getTime();
    const fetch: string[] = [];
    for (const id of needed) {
      const cached = this.baselines.get(id);
      if (cached && stamp - cached.at < BASELINE_TTL_MS)
        out.set(id, cached.value);
      else fetch.push(id);
    }
    if (fetch.length > 0) {
      const rows = await this.db.rows<Record<string, any>>(BASELINE_SQL, [
        fetch,
      ]);
      for (const row of rows) {
        const value = toBaselines(row);
        this.baselines.set(row.server_id, { at: stamp, value });
        out.set(row.server_id, value);
      }
    }
    for (const id of [...this.baselines.keys()]) {
      if (!needed.has(id)) this.baselines.delete(id);
    }
    return out;
  }

  private async loadContext(orgId: string): Promise<OrgContext> {
    const [routing, windows] = await Promise.all([
      loadRouting(this.db, orgId),
      this.db.rows<MaintenanceRow>(
        'SELECT * FROM maintenance_windows WHERE org_id = $1',
        [orgId],
      ),
    ]);
    return {
      ...routing,
      windows: windows.map((row) => ({
        scope: toScope(row),
        window: {
          startsAt: new Date(row.starts_at),
          durationSec: row.duration_sec,
          repeat: row.repeat,
        },
      })),
    };
  }

  private async openNew(
    context: (orgId: string) => Promise<OrgContext>,
  ): Promise<number> {
    const candidates = await this.db.rows<OpenCandidate>(OPEN_SQL);
    let count = 0;
    for (const candidate of candidates) {
      try {
        const ctx = await context(candidate.org_id);
        if (await this.openFor(candidate, ctx)) count += 1;
      } catch (error) {
        this.logger.error(
          `Could not open an incident for rule ${candidate.rule_id} on server ${candidate.server_id}: ${reason(error)}`,
        );
      }
    }
    return count;
  }

  private async openFor(
    candidate: OpenCandidate,
    ctx: OrgContext,
  ): Promise<boolean> {
    const now = new Date();
    const target = {
      id: candidate.server_id,
      tags: candidate.server_tags ?? [],
    };
    if (
      ctx.windows.some(
        (entry) =>
          scopeMatches(entry.scope, target) &&
          windowIsActive(entry.window, now),
      )
    ) {
      return false;
    }

    const title = ruleTitle(
      {
        metric: candidate.metric,
        mode: candidate.mode,
        threshold:
          candidate.threshold === null ? null : Number(candidate.threshold),
      },
      candidate.server_name,
      candidate.subject,
    );
    const trigger = incidentTrigger(candidate.metric, candidate.mode);

    try {
      const row = await this.db.tx(async (tx) => {
        const seq = await tx.row<{ n: number }>(
          'UPDATE organizations SET incident_seq = incident_seq + 1 WHERE id = $1 RETURNING incident_seq AS n',
          [candidate.org_id],
        );
        const incident = await tx.row<IncidentRow>(
          `INSERT INTO incidents (org_id, number, monitor_id, monitor_name, title, cause, severity, trigger, started_at,
                                  source, server_id, server_rule_id, subject, server_metric)
           VALUES ($1, $2::int, NULL, $3, $4, $5, $6, $7, $8::timestamptz, 'server', $9::uuid, $10::uuid, $11, $12)
           ON CONFLICT (server_rule_id, server_id, subject)
             WHERE status <> 'resolved' AND server_rule_id IS NOT NULL AND server_id IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [
            candidate.org_id,
            seq?.n ?? 1,
            candidate.server_name,
            title,
            candidate.detail,
            candidate.severity,
            trigger,
            candidate.breach_since,
            candidate.server_id,
            candidate.rule_id,
            candidate.subject,
            candidate.metric,
          ],
        );
        if (!incident) throw new NoIncident();
        await addIncidentEvent(
          tx,
          incident.id,
          incident.org_id,
          'opened',
          `${title}${candidate.detail ? `: ${candidate.detail}` : ''}`,
        );
        await createJobs(tx, ctx, incident.org_id, incident.id, now, [
          {
            id: candidate.rule_id,
            source: 'server',
            channelIds: candidate.channel_ids ?? [],
            policyId: candidate.policy_id,
            forSec: 0,
          },
        ]);
        return incident;
      });
      this.bus.publish(row.org_id, {
        type: 'incident',
        incidentId: row.id,
        number: row.number,
        change: 'opened',
      });
      this.bus.publish(row.org_id, {
        type: 'server',
        serverId: candidate.server_id,
        change: 'status',
      });
      return true;
    } catch (error) {
      if (error instanceof NoIncident) return false;
      throw error;
    }
  }

  private async resolveEnded(): Promise<number> {
    const rows = await this.db.rows<{
      id: string;
      org_id: string;
      number: number;
      title: string;
      started_at: Date;
      monitor_name: string;
      server_id: string | null;
      rule_id: string | null;
      rule_enabled: boolean | null;
    }>(ENDED_SQL);

    let count = 0;
    for (const row of rows) {
      try {
        let resolution: Resolution = 'recovered';
        let message: string;
        if (row.server_id === null) {
          resolution = 'server_removed';
          message = `Resolved because ${row.monitor_name} was removed`;
        } else if (row.rule_id === null || !row.rule_enabled) {
          resolution = 'rule_removed';
          message = 'Resolved because the alert rule was removed or turned off';
        } else {
          const lasted = formatDuration(
            Math.max(
              0,
              (Date.now() - new Date(row.started_at).getTime()) / 1000,
            ),
          );
          message = `${row.title} recovered after ${lasted}`;
        }
        const closed = await this.db.tx((tx) =>
          closeIncident(tx, row.id, {
            resolvedAt: null,
            by: null,
            resolution,
            message,
          }),
        );
        if (closed) {
          count += 1;
          this.bus.publish(row.org_id, {
            type: 'incident',
            incidentId: row.id,
            number: row.number,
            change: 'resolved',
          });
          if (row.server_id)
            this.bus.publish(row.org_id, {
              type: 'server',
              serverId: row.server_id,
              change: 'status',
            });
        }
      } catch (error) {
        this.logger.error(
          `Could not resolve incident ${row.id}: ${reason(error)}`,
        );
      }
    }
    return count;
  }
}

function toWrite(ruleId: string, serverId: string, breach: Breach): StateWrite {
  return {
    rule_id: ruleId,
    server_id: serverId,
    subject: breach.subject,
    value:
      breach.value === null || !Number.isFinite(breach.value)
        ? null
        : breach.value,
    detail: breach.detail.slice(0, 500),
  };
}
