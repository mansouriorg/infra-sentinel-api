import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import type { Db } from '../database/executor';
import { MailService } from '../mail/mail.service';
import { EventBus } from '../monitors/event-bus';
import { describeTarget } from '../monitors/monitor.schema';
import type { MonitorType } from '../monitors/monitor.types';
import {
  buildMessage,
  renderEmail,
  type IncidentContext,
} from './alert.message';
import { toScope } from './alert.format';
import { loadMembers } from './alert.helpers';
import {
  formatDuration,
  maxSeverity,
  onCallAt,
  ruleMatches,
  scopeMatches,
  windowIsActive,
  type Window,
} from './alert.scope';
import type {
  ChannelType,
  IncidentRow,
  IncidentStatus,
  JobKind,
  MaintenanceRow,
  RuleRow,
  ScheduleRow,
  Scope,
  Severity,
  SilenceRow,
  Trigger,
} from './alert.types';
import { deliver } from './channels/adapters';
import {
  addIncidentEvent,
  closeIncident,
  type Resolution,
} from './incident.lifecycle';
import { scheduleFacts } from './alert.format';
import { createJobs, loadRouting, type RoutingContext } from './alert.jobs';

const TICK_MS = 2000;
const CONCURRENCY = 10;
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [30, 120];
const PURGE_EVERY_MS = 3_600_000;
const FIRST_PURGE_MS = 120_000;
const KEEP_INCIDENTS_DAYS = 400;

const CANDIDATES_SQL = `
  SELECT m.id, m.org_id, m.name, m.type, m.config, m.interval_sec, m.tags, m.status, m.status_since, m.last_message
    FROM monitors m
   WHERE m.status IN ('down', 'degraded')
     AND NOT m.paused
     AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.monitor_id = m.id AND i.status <> 'resolved')
     AND m.status_since > COALESCE((SELECT max(i.resolved_at) FROM incidents i WHERE i.monitor_id = m.id), '-infinity'::timestamptz)
   ORDER BY m.status_since
   LIMIT 50`;

const ENDED_SQL = `
  SELECT i.id, i.org_id, i.number, i.started_at, i.monitor_name, m.id AS monitor_id, m.status AS m_status, m.status_since AS m_since, m.paused AS m_paused
    FROM incidents i
    LEFT JOIN monitors m ON m.id = i.monitor_id
   WHERE i.status <> 'resolved'
     AND i.source = 'monitor'
     AND (m.id IS NULL OR m.paused OR m.status IN ('up', 'pending', 'paused'))
   ORDER BY i.started_at
   LIMIT 100`;

const CHANGED_SQL = `
  SELECT i.id, i.org_id, i.number, i.severity, i.trigger, i.started_at, i.monitor_name,
         m.id AS monitor_id, m.status AS m_status, m.tags AS m_tags, m.last_message
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
   WHERE i.status <> 'resolved'
     AND i.source = 'monitor'
     AND m.status IN ('down', 'degraded')
     AND m.status <> i.trigger
   LIMIT 100`;

const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM notification_jobs
     WHERE status = 'pending' AND run_at <= now() AND (locked_until IS NULL OR locked_until <= now())
     ORDER BY run_at
     LIMIT $1::int
       FOR UPDATE SKIP LOCKED
  )
  UPDATE notification_jobs j
     SET attempts = j.attempts + 1,
         locked_until = now() + ($2::int * interval '1 second')
    FROM due
   WHERE j.id = due.id
  RETURNING j.id::text AS id`;

const JOB_SQL = `
  SELECT j.id::text AS id, j.org_id, j.incident_id, j.kind, j.step, j.channel_id, j.schedule_id, j.target_label,
         j.attempts, j.status,
         i.status AS i_status, i.number AS i_number, i.title AS i_title, i.severity AS i_severity,
         i.trigger AS i_trigger, i.started_at AS i_started, i.resolved_at AS i_resolved, i.cause AS i_cause,
         i.monitor_id AS i_monitor_id, i.monitor_name AS i_monitor_name,
         i.source AS i_source, i.server_id AS i_server_id,
         m.tags AS m_tags, m.type AS m_type, m.config AS m_config, m.interval_sec AS m_interval,
         sv.tags AS sv_tags, sv.hostname AS sv_hostname, sv.ip AS sv_ip,
         c.name AS c_name, c.type AS c_type, c.config AS c_config, c.enabled AS c_enabled
    FROM notification_jobs j
    JOIN incidents i ON i.id = j.incident_id
    LEFT JOIN monitors m ON m.id = i.monitor_id
    LEFT JOIN servers sv ON sv.id = i.server_id
    LEFT JOIN notification_channels c ON c.id = j.channel_id
   WHERE j.id = $1::bigint`;

interface Rule {
  id: string;
  enabled: boolean;
  trigger: Trigger;
  severity: Severity;
  forSec: number;
  scope: Scope;
  channelIds: string[];
  policyId: string | null;
}

interface OrgContext extends RoutingContext {
  rules: Rule[];
  windows: { name: string; scope: Scope; window: Window }[];
}

interface Candidate {
  id: string;
  org_id: string;
  name: string;
  type: MonitorType;
  config: Record<string, any>;
  interval_sec: number;
  tags: string[] | null;
  status: 'down' | 'degraded';
  status_since: Date;
  last_message: string | null;
}

interface JobContext {
  id: string;
  org_id: string;
  incident_id: string;
  kind: JobKind;
  step: number;
  channel_id: string | null;
  schedule_id: string | null;
  target_label: string;
  attempts: number;
  status: string;
  i_status: IncidentStatus;
  i_number: number;
  i_title: string;
  i_severity: Severity;
  i_trigger: Trigger;
  i_started: Date;
  i_resolved: Date | null;
  i_cause: string;
  i_monitor_id: string | null;
  i_monitor_name: string;
  i_source: 'monitor' | 'server';
  i_server_id: string | null;
  m_tags: string[] | null;
  m_type: MonitorType | null;
  m_config: Record<string, any> | null;
  m_interval: number | null;
  sv_tags: string[] | null;
  sv_hostname: string | null;
  sv_ip: string | null;
  c_name: string | null;
  c_type: ChannelType | null;
  c_config: Record<string, any> | null;
  c_enabled: boolean | null;
}

export interface TickResult {
  opened: number;
  updated: number;
  resolved: number;
  claimed: number;
}

class NoIncident extends Error {}
class Permanent extends Error {}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function severityFor(
  status: string,
  matched: { severity: Severity }[],
): Severity {
  if (matched.length === 0) return status === 'down' ? 'critical' : 'warning';
  return matched
    .map((rule) => rule.severity)
    .reduce((a, b) => maxSeverity(a, b));
}

export function titleFor(name: string, status: string): string {
  return status === 'down' ? `${name} is down` : `${name} is degraded`;
}

@Injectable()
export class AlertEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertEngine.name);
  private readonly inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private nextPurgeAt = Date.now() + FIRST_PURGE_MS;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly mail: MailService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Alert engine is off (SCHEDULER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.loop(), TICK_MS);
    this.timer.unref();
    this.logger.log('Alert engine running');
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain(10_000);
  }

  async tick(): Promise<TickResult> {
    const contexts = new Map<string, Promise<OrgContext>>();
    const context = (orgId: string) => {
      let loaded = contexts.get(orgId);
      if (!loaded) {
        loaded = this.loadContext(orgId);
        contexts.set(orgId, loaded);
      }
      return loaded;
    };

    const resolved = await this.resolveEnded();
    const updated = await this.syncChanged(context);
    const opened = await this.openNew(context);
    const claimed = await this.claimJobs();
    return { opened, updated, resolved, claimed };
  }

  async drain(timeoutMs = 15_000): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([
      Promise.allSettled([...this.inflight]).then(() => undefined),
      limit,
    ]);
    if (timer) clearTimeout(timer);
  }

  async purge(): Promise<void> {
    await this.db.run(
      `DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < now() - ($1::int * interval '1 day')`,
      [KEEP_INCIDENTS_DAYS],
    );
    await this.db.run(
      `DELETE FROM silences WHERE ends_at < now() - interval '30 days'`,
    );
    await this.db.run(
      `DELETE FROM maintenance_windows
        WHERE repeat = 'none' AND starts_at + (duration_sec * interval '1 second') < now() - interval '90 days'`,
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
        this.logger.error(`Alert engine tick failed: ${reason(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async loadContext(orgId: string): Promise<OrgContext> {
    const [rules, routing, windows] = await Promise.all([
      this.db.rows<RuleRow>(
        'SELECT * FROM alert_rules WHERE org_id = $1 AND enabled',
        [orgId],
      ),
      loadRouting(this.db, orgId),
      this.db.rows<MaintenanceRow>(
        'SELECT * FROM maintenance_windows WHERE org_id = $1',
        [orgId],
      ),
    ]);
    return {
      ...routing,
      rules: rules.map((row) => ({
        id: row.id,
        enabled: row.enabled,
        trigger: row.trigger,
        severity: row.severity,
        forSec: row.for_sec,
        scope: toScope(row),
        channelIds: row.channel_ids ?? [],
        policyId: row.policy_id,
      })),
      windows: windows.map((row) => ({
        name: row.name,
        scope: toScope(row),
        window: {
          startsAt: new Date(row.starts_at),
          durationSec: row.duration_sec,
          repeat: row.repeat,
        },
      })),
    };
  }

  private async resolveEnded(): Promise<number> {
    const rows = await this.db.rows<{
      id: string;
      org_id: string;
      number: number;
      started_at: Date;
      monitor_name: string | null;
      monitor_id: string | null;
      m_status: string | null;
      m_since: Date | null;
      m_paused: boolean | null;
    }>(ENDED_SQL);

    let count = 0;
    for (const row of rows) {
      try {
        let resolution: Resolution = 'recovered';
        let resolvedAt: Date | null = null;
        if (row.monitor_id === null) resolution = 'monitor_removed';
        else if (row.m_paused) resolution = 'monitor_paused';
        else if (row.m_status === 'up' && row.m_since)
          resolvedAt = new Date(row.m_since);

        const endedAt = resolvedAt ?? new Date();
        const lasted = formatDuration(
          Math.max(
            0,
            (endedAt.getTime() - new Date(row.started_at).getTime()) / 1000,
          ),
        );
        const name = row.monitor_name ?? 'The monitor';
        const message =
          resolution === 'recovered'
            ? `${name} recovered after ${lasted}`
            : resolution === 'monitor_paused'
              ? `Resolved because ${name} was paused`
              : `Resolved because ${name} was deleted`;

        const closed = await this.db.tx((tx) =>
          closeIncident(tx, row.id, {
            resolvedAt,
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
        }
      } catch (error) {
        this.logger.error(
          `Could not resolve incident ${row.id}: ${reason(error)}`,
        );
      }
    }
    return count;
  }

  private async syncChanged(
    context: (orgId: string) => Promise<OrgContext>,
  ): Promise<number> {
    const rows = await this.db.rows<{
      id: string;
      org_id: string;
      number: number;
      severity: Severity;
      trigger: Trigger;
      started_at: Date;
      monitor_name: string;
      monitor_id: string;
      m_status: 'down' | 'degraded';
      m_tags: string[] | null;
      last_message: string | null;
    }>(CHANGED_SQL);

    let count = 0;
    for (const row of rows) {
      try {
        const ctx = await context(row.org_id);
        const monitor = { id: row.monitor_id, tags: row.m_tags ?? [] };
        const matched = ctx.rules.filter((rule) =>
          ruleMatches(rule, monitor, row.m_status),
        );
        const worse = row.m_status === 'down';
        const severity = worse
          ? maxSeverity(row.severity, severityFor(row.m_status, matched))
          : row.severity;
        const title = titleFor(row.monitor_name, row.m_status);
        const cause = row.last_message ?? '';

        const changed = await this.db.tx(async (tx) => {
          const count = await tx.run(
            `UPDATE incidents SET trigger = $2, severity = $3, title = $4, cause = $5, updated_at = now()
              WHERE id = $1 AND status <> 'resolved' AND trigger <> $2`,
            [row.id, row.m_status, severity, title, cause],
          );
          if (count === 0) return false;
          await addIncidentEvent(
            tx,
            row.id,
            row.org_id,
            'status',
            worse
              ? `Got worse, ${row.monitor_name} is now down${cause ? `: ${cause}` : ''}`
              : `Improved, ${row.monitor_name} is now degraded${cause ? `: ${cause}` : ''}`,
          );
          if (worse)
            await this.createJobs(
              tx,
              row.id,
              row.org_id,
              new Date(row.started_at),
              matched,
              ctx,
            );
          return true;
        });
        if (changed) {
          count += 1;
          this.bus.publish(row.org_id, {
            type: 'incident',
            incidentId: row.id,
            number: row.number,
            change: 'updated',
          });
        }
      } catch (error) {
        this.logger.error(
          `Could not update incident ${row.id}: ${reason(error)}`,
        );
      }
    }
    return count;
  }

  private async openNew(
    context: (orgId: string) => Promise<OrgContext>,
  ): Promise<number> {
    const candidates = await this.db.rows<Candidate>(CANDIDATES_SQL);
    let count = 0;
    for (const candidate of candidates) {
      try {
        const ctx = await context(candidate.org_id);
        if (await this.openFor(candidate, ctx)) count += 1;
      } catch (error) {
        this.logger.error(
          `Could not open an incident for monitor ${candidate.id}: ${reason(error)}`,
        );
      }
    }
    return count;
  }

  private async openFor(
    candidate: Candidate,
    ctx: OrgContext,
  ): Promise<boolean> {
    const now = new Date();
    const monitor = { id: candidate.id, tags: candidate.tags ?? [] };
    const inMaintenance = ctx.windows.some(
      (entry) =>
        scopeMatches(entry.scope, monitor) && windowIsActive(entry.window, now),
    );
    if (inMaintenance) return false;

    const matched = ctx.rules.filter((rule) =>
      ruleMatches(rule, monitor, candidate.status),
    );
    if (candidate.status === 'degraded' && matched.length === 0) return false;

    const severity = severityFor(candidate.status, matched);
    const title = titleFor(candidate.name, candidate.status);
    const cause = candidate.last_message ?? '';

    try {
      const row = await this.db.tx(async (tx) => {
        const seq = await tx.row<{ n: number }>(
          'UPDATE organizations SET incident_seq = incident_seq + 1 WHERE id = $1 RETURNING incident_seq AS n',
          [candidate.org_id],
        );
        const incident = await tx.row<IncidentRow>(
          `INSERT INTO incidents (org_id, number, monitor_id, monitor_name, title, cause, severity, trigger, started_at)
           VALUES ($1, $2::int, $3, $4, $5, $6, $7, $8, $9::timestamptz)
           ON CONFLICT (monitor_id) WHERE status <> 'resolved' AND monitor_id IS NOT NULL DO NOTHING
           RETURNING *`,
          [
            candidate.org_id,
            seq?.n ?? 1,
            candidate.id,
            candidate.name,
            title,
            cause,
            severity,
            candidate.status,
            candidate.status_since,
          ],
        );
        if (!incident) throw new NoIncident();
        await addIncidentEvent(
          tx,
          incident.id,
          incident.org_id,
          'opened',
          `${title}${cause ? `: ${cause}` : ''}`,
        );
        await this.createJobs(
          tx,
          incident.id,
          incident.org_id,
          new Date(incident.started_at),
          matched,
          ctx,
        );
        return incident;
      });
      this.bus.publish(row.org_id, {
        type: 'incident',
        incidentId: row.id,
        number: row.number,
        change: 'opened',
      });
      return true;
    } catch (error) {
      if (error instanceof NoIncident) return false;
      throw error;
    }
  }

  private async createJobs(
    db: Db,
    incidentId: string,
    orgId: string,
    startedAt: Date,
    rules: Rule[],
    ctx: OrgContext,
  ): Promise<void> {
    await createJobs(
      db,
      ctx,
      orgId,
      incidentId,
      startedAt,
      rules.map((rule) => ({
        id: rule.id,
        source: 'monitor' as const,
        channelIds: rule.channelIds,
        policyId: rule.policyId,
        forSec: rule.forSec,
      })),
    );
  }

  private async claimJobs(): Promise<number> {
    const free = CONCURRENCY - this.inflight.size;
    if (free <= 0 || this.stopping) return 0;
    const claimed = await this.db.rows<{ id: string }>(CLAIM_SQL, [
      free,
      LEASE_SECONDS,
    ]);
    for (const { id } of claimed) this.launch(id);
    return claimed.length;
  }

  private launch(jobId: string): void {
    const task: Promise<void> = this.execute(jobId)
      .catch((error: unknown) => {
        if (!this.stopping)
          this.logger.error(
            `Notification job ${jobId} failed: ${reason(error)}`,
          );
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  private async finish(
    job: JobContext,
    status: 'sent' | 'failed' | 'skipped',
    error: string | null,
  ): Promise<void> {
    await this.db.run(
      `UPDATE notification_jobs SET status = $2, last_error = $3::text, finished_at = now() WHERE id = $1::bigint`,
      [job.id, status, error],
    );
  }

  private async event(
    job: JobContext,
    kind: Parameters<typeof addIncidentEvent>[3],
    message: string,
  ): Promise<void> {
    await addIncidentEvent(this.db, job.incident_id, job.org_id, kind, message);
    this.bus.publish(job.org_id, {
      type: 'incident',
      incidentId: job.incident_id,
      number: job.i_number,
      change: 'updated',
    });
  }

  private async execute(jobId: string): Promise<void> {
    const job = await this.db.row<JobContext>(JOB_SQL, [jobId]);
    if (!job || job.status !== 'pending') return;

    if (job.kind !== 'recovery' && job.i_status !== 'open') {
      await this.finish(
        job,
        'skipped',
        job.i_status === 'acknowledged'
          ? 'The incident was acknowledged'
          : 'The incident was resolved',
      );
      return;
    }
    if (!job.channel_id && !job.schedule_id) {
      await this.finish(job, 'skipped', 'The channel or schedule was deleted');
      return;
    }
    if (job.channel_id && job.c_enabled === false) {
      await this.finish(job, 'skipped', 'The channel is turned off');
      return;
    }

    const suppressed = await this.suppression(job);
    if (suppressed) {
      await this.finish(job, 'skipped', suppressed);
      await this.event(
        job,
        'suppressed',
        `Skipped ${job.target_label}: ${suppressed}`,
      );
      return;
    }

    const message = buildMessage(
      job.kind === 'recovery'
        ? 'incident.resolved'
        : job.kind === 'escalation' && job.step > 0
          ? 'incident.escalated'
          : 'incident.opened',
      this.incidentContext(job),
    );

    try {
      let label = job.target_label;
      if (job.channel_id && job.c_type) {
        await deliver(job.c_type, job.c_config ?? {}, message, {
          blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
          sendMail: (mail) => this.mail.deliver(mail),
        });
        await this.db.run(
          'UPDATE notification_channels SET last_used_at = now(), last_error = NULL WHERE id = $1',
          [job.channel_id],
        );
      } else if (job.schedule_id) {
        label = await this.page(job, message);
      }
      await this.finish(job, 'sent', null);
      if (job.kind === 'recovery')
        await this.event(
          job,
          'notified',
          `Told ${label} that the incident is resolved`,
        );
      else if (job.kind === 'escalation' && job.step > 0)
        await this.event(job, 'escalated', `Escalated to ${label}`);
      else await this.event(job, 'notified', `Notified ${label}`);
    } catch (error) {
      const text = reason(error);
      if (job.channel_id) {
        await this.db.run(
          'UPDATE notification_channels SET last_error = $2::text WHERE id = $1',
          [job.channel_id, text],
        );
      }
      if (error instanceof Permanent || job.attempts >= MAX_ATTEMPTS) {
        await this.finish(job, 'failed', text);
        await this.event(
          job,
          'notify_failed',
          `Could not notify ${job.target_label}: ${text}`,
        );
      } else {
        const delay =
          RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)];
        await this.db.run(
          `UPDATE notification_jobs
              SET status = 'pending', locked_until = NULL, run_at = now() + ($2::int * interval '1 second'), last_error = $3::text
            WHERE id = $1::bigint`,
          [job.id, delay, text],
        );
      }
    }
  }

  private incidentContext(job: JobContext): IncidentContext {
    return {
      id: job.incident_id,
      number: job.i_number,
      title: job.i_title,
      severity: job.i_severity,
      status: job.i_status,
      trigger: job.i_trigger,
      startedAt: new Date(job.i_started),
      resolvedAt: job.i_resolved ? new Date(job.i_resolved) : null,
      cause: job.i_cause,
      monitorId: job.i_monitor_id,
      monitorName: job.i_monitor_name,
      monitorTarget: job.m_type
        ? describeTarget(job.m_type, job.m_config ?? {}, job.m_interval ?? 60)
        : null,
      baseUrl: this.config.get('WEB_URL'),
      source: job.i_source,
      serverId: job.i_server_id,
      serverHost: job.sv_hostname
        ? job.sv_ip
          ? `${job.sv_hostname}, ${job.sv_ip}`
          : job.sv_hostname
        : (job.sv_ip ?? null),
    };
  }

  private async suppression(job: JobContext): Promise<string | null> {
    const [windows, silences] = await Promise.all([
      this.db.rows<MaintenanceRow>(
        'SELECT * FROM maintenance_windows WHERE org_id = $1',
        [job.org_id],
      ),
      this.db.rows<SilenceRow>(
        'SELECT * FROM silences WHERE org_id = $1 AND starts_at <= now() AND ends_at > now()',
        [job.org_id],
      ),
    ]);
    const monitor =
      job.i_source === 'server'
        ? { id: job.i_server_id ?? '', tags: job.sv_tags ?? [] }
        : { id: job.i_monitor_id ?? '', tags: job.m_tags ?? [] };
    const now = new Date();
    const window = windows.find(
      (row) =>
        scopeMatches(toScope(row), monitor) &&
        windowIsActive(
          {
            startsAt: new Date(row.starts_at),
            durationSec: row.duration_sec,
            repeat: row.repeat,
          },
          now,
        ),
    );
    if (window) return `maintenance window "${window.name}" is active`;
    const silence = silences.find((row) => scopeMatches(toScope(row), monitor));
    if (silence) return `silenced by "${silence.name}"`;
    return null;
  }

  private async page(
    job: JobContext,
    message: ReturnType<typeof buildMessage>,
  ): Promise<string> {
    const schedule = await this.db.row<ScheduleRow>(
      'SELECT * FROM oncall_schedules WHERE id = $1',
      [job.schedule_id],
    );
    if (!schedule) throw new Permanent('The on-call schedule was deleted');
    const members = await loadMembers(
      this.db,
      job.org_id,
      schedule.members ?? [],
    );
    const { userId } = onCallAt(
      scheduleFacts(schedule),
      new Date(),
      new Set(members.keys()),
    );
    const person = userId ? members.get(userId) : undefined;
    if (!person)
      throw new Permanent(`Nobody is on call for "${schedule.name}"`);
    await this.mail.deliver(renderEmail(message, person.email));
    return `${job.target_label} (${person.name})`;
  }
}
