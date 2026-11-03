import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { randomToken } from '../common/crypto';
import { RateLimiter } from '../common/rate-limiter';
import { DatabaseService } from '../database/database.service';
import { hasRole } from '../orgs/roles';
import { CheckRunner } from './checks/runner';
import { down, up } from './checks/outcome';
import { EventBus } from './event-bus';
import { iso, num, percent, toView } from './monitor.format';
import {
  assertLimits,
  createSchema,
  parseConfig,
  parseWith,
  restoreMasked,
  updateSchema,
} from './monitor.schema';
import { describeEvent } from './monitor.state';
import type {
  CheckView,
  EventView,
  MonitorDetail,
  MonitorRow,
  MonitorStatus,
  MonitorView,
  Overview,
  Series,
  SeriesRange,
} from './monitor.types';
import { SERIES_RANGES } from './monitor.types';
import {
  loadDetailExtras,
  loadOrgEvents,
  loadOrgLatency,
  loadSeries,
  loadStats,
} from './monitors.stats';
import { RecorderService } from './recorder.service';

export const MAX_MONITORS_PER_ORG = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSERT_MONITOR = `
  INSERT INTO monitors
    (org_id, name, type, config, interval_sec, timeout_ms, failure_threshold, tags, heartbeat_token, created_by, next_check_at)
  VALUES
    ($1, $2, $3, $4::jsonb, $5::int, $6::int, $7::int, $8::text[], $9, $10::uuid, now() + ($11::float8 * interval '1 second'))
  RETURNING id`;

const UPDATE_MONITOR = `
  UPDATE monitors SET
    name = $3,
    config = $4::jsonb,
    interval_sec = $5::int,
    timeout_ms = $6::int,
    failure_threshold = $7::int,
    tags = $8::text[],
    next_check_at = CASE
      WHEN paused OR $9::float8 IS NULL THEN next_check_at
      ELSE now() + ($9::float8 * interval '1 second')
    END,
    updated_at = now()
  WHERE id = $1 AND org_id = $2`;

const PAUSE_MONITOR = `
  UPDATE monitors SET paused = true, status = 'paused', status_since = now(),
         consecutive_failures = 0, updated_at = now()
   WHERE id = $1 AND org_id = $2`;

const RESUME_MONITOR = `
  UPDATE monitors SET paused = false, status = 'pending', status_since = now(),
         consecutive_failures = 0, next_check_at = now() + ($3::float8 * interval '1 second'),
         updated_at = now()
   WHERE id = $1 AND org_id = $2`;

function firstDelay(
  type: string,
  intervalSec: number,
  config: Record<string, any>,
): number {
  return type === 'heartbeat' ? intervalSec + Number(config.graceSec ?? 0) : 0;
}

function canSeeSecrets(auth: AuthContext): boolean {
  if (!hasRole(auth.role, 'member')) return false;
  return !auth.apiKey || auth.apiKey.scopes.includes('monitors:write');
}

@Injectable()
export class MonitorsService {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly runner: CheckRunner,
    private readonly recorder: RecorderService,
    private readonly bus: EventBus,
  ) {}

  async list(auth: AuthContext): Promise<MonitorView[]> {
    const [rows, stats] = await Promise.all([
      this.rowsFor(auth.orgId),
      loadStats(this.db, auth.orgId),
    ]);
    const secrets = canSeeSecrets(auth);
    return rows.map((row) => toView(row, stats.get(row.id), secrets));
  }

  async detail(auth: AuthContext, id: string): Promise<MonitorDetail> {
    const row = await this.requireRow(auth.orgId, id);
    const [stats, extras] = await Promise.all([
      loadStats(this.db, auth.orgId, id),
      loadDetailExtras(this.db, id),
    ]);
    return { ...toView(row, stats.get(id), canSeeSecrets(auth)), ...extras };
  }

  async series(
    auth: AuthContext,
    id: string,
    range: string | undefined,
  ): Promise<Series> {
    const chosen = (range ?? '24h') as SeriesRange;
    if (!SERIES_RANGES.includes(chosen)) {
      throw new BadRequestException(
        `range must be one of ${SERIES_RANGES.join(', ')}`,
      );
    }
    await this.requireRow(auth.orgId, id);
    return loadSeries(this.db, id, chosen);
  }

  async overview(auth: AuthContext): Promise<Overview> {
    const [rows, stats, latency, events] = await Promise.all([
      this.rowsFor(auth.orgId),
      loadStats(this.db, auth.orgId),
      loadOrgLatency(this.db, auth.orgId),
      loadOrgEvents(this.db, auth.orgId, 10),
    ]);
    const secrets = canSeeSecrets(auth);
    const views = rows.map((row) => toView(row, stats.get(row.id), secrets));

    const counts: Record<MonitorStatus | 'total', number> = {
      total: views.length,
      up: 0,
      degraded: 0,
      down: 0,
      paused: 0,
      pending: 0,
    };
    for (const view of views) counts[view.status] += 1;

    let checks = 0;
    let ups = 0;
    let sumMs = 0;
    let timed = 0;
    for (const value of stats.values()) {
      checks += value.checks30d;
      ups += value.ups30d;
      sumMs += value.sumMs30d;
      timed += value.timed30d;
    }

    const rank = (status: MonitorStatus) => (status === 'down' ? 0 : 1);
    const problems = views
      .filter((view) => view.status === 'down' || view.status === 'degraded')
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          a.statusSince.localeCompare(b.statusSince),
      )
      .slice(0, 6);
    const slowest = views
      .filter(
        (view) =>
          view.lastResponseMs !== null &&
          (view.status === 'up' || view.status === 'degraded'),
      )
      .sort((a, b) => (b.lastResponseMs ?? 0) - (a.lastResponseMs ?? 0))
      .slice(0, 5);

    return {
      counts,
      uptime30d: percent(ups, checks),
      avgMs: timed > 0 ? Math.round(sumMs / timed) : null,
      latency,
      problems,
      slowest,
      events,
    };
  }

  events(auth: AuthContext, limit: number): Promise<EventView[]> {
    return loadOrgEvents(this.db, auth.orgId, limit);
  }

  async create(auth: AuthContext, body: unknown): Promise<MonitorDetail> {
    const input = parseWith(createSchema, body);
    assertLimits(input.type, input.intervalSec, input.timeoutMs);

    const existing = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM monitors WHERE org_id = $1',
      [auth.orgId],
    );
    if ((num(existing?.n) ?? 0) >= MAX_MONITORS_PER_ORG) {
      throw new ConflictException(
        `An organization can have up to ${MAX_MONITORS_PER_ORG} monitors`,
      );
    }

    const config = input.config as Record<string, any>;
    const token = input.type === 'heartbeat' ? randomToken(24) : null;
    const id = await this.db.tx(async (tx) => {
      const created = await tx.row<{ id: string }>(INSERT_MONITOR, [
        auth.orgId,
        input.name,
        input.type,
        JSON.stringify(config),
        input.intervalSec,
        input.timeoutMs,
        input.failureThreshold,
        input.tags,
        token,
        auth.user.id,
        firstDelay(input.type, input.intervalSec, config),
      ]);
      if (!created) throw new Error('Monitor was not created');
      await tx.run(
        `INSERT INTO monitor_events (monitor_id, org_id, kind, message) VALUES ($1, $2, 'created', $3)`,
        [created.id, auth.orgId, describeEvent('created', input.name, '', 0)],
      );
      return created.id;
    });

    this.bus.publish(auth.orgId, {
      type: 'monitor',
      monitorId: id,
      change: 'created',
    });
    return this.detail(auth, id);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<MonitorDetail> {
    const patch = parseWith(updateSchema, body);
    const row = await this.requireRow(auth.orgId, id);

    const intervalSec = patch.intervalSec ?? row.interval_sec;
    const timeoutMs = patch.timeoutMs ?? row.timeout_ms;
    assertLimits(row.type, intervalSec, timeoutMs);
    const config = patch.config
      ? parseConfig(row.type, restoreMasked(patch.config, row.config))
      : row.config;

    const reschedule =
      patch.config !== undefined ||
      patch.intervalSec !== undefined ||
      patch.timeoutMs !== undefined;
    await this.db.run(UPDATE_MONITOR, [
      id,
      auth.orgId,
      patch.name ?? row.name,
      JSON.stringify(config),
      intervalSec,
      timeoutMs,
      patch.failureThreshold ?? row.failure_threshold,
      patch.tags ?? row.tags,
      reschedule ? firstDelay(row.type, intervalSec, config) : null,
    ]);

    this.bus.publish(auth.orgId, {
      type: 'monitor',
      monitorId: id,
      change: 'updated',
    });
    return this.detail(auth, id);
  }

  async setPaused(
    auth: AuthContext,
    id: string,
    paused: boolean,
  ): Promise<MonitorDetail> {
    const row = await this.requireRow(auth.orgId, id);
    if (row.paused === paused) return this.detail(auth, id);

    const kind = paused ? 'paused' : 'resumed';
    await this.db.tx(async (tx) => {
      if (paused) {
        await tx.run(PAUSE_MONITOR, [id, auth.orgId]);
      } else {
        await tx.run(RESUME_MONITOR, [
          id,
          auth.orgId,
          firstDelay(row.type, row.interval_sec, row.config),
        ]);
      }
      await tx.run(
        `INSERT INTO monitor_events (monitor_id, org_id, kind, message) VALUES ($1, $2, $3, $4)`,
        [id, auth.orgId, kind, describeEvent(kind, row.name, '', 0)],
      );
    });

    const to: MonitorStatus = paused ? 'paused' : 'pending';
    this.bus.publish(auth.orgId, {
      type: 'status',
      monitorId: id,
      name: row.name,
      from: row.status,
      to,
      kind,
      message: describeEvent(kind, row.name, '', 0),
      at: iso(new Date()),
    });
    this.bus.publish(auth.orgId, {
      type: 'monitor',
      monitorId: id,
      change: 'updated',
    });
    return this.detail(auth, id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM monitors WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (removed === 0) throw new NotFoundException('Monitor not found');
    this.bus.publish(auth.orgId, {
      type: 'monitor',
      monitorId: id,
      change: 'deleted',
    });
  }

  async runNow(auth: AuthContext, id: string): Promise<MonitorDetail> {
    this.throttle(`run:${auth.user.id}`, 30, 60_000);
    const row = await this.requireRow(auth.orgId, id);
    if (row.type === 'heartbeat') {
      throw new BadRequestException(
        'Heartbeat monitors wait for your job to call their URL',
      );
    }
    if (row.paused)
      throw new BadRequestException(
        'Resume the monitor before running a check',
      );
    const result = await this.runner.run(row.type, row.config, row.timeout_ms);
    await this.recorder.record(id, result);
    return this.detail(auth, id);
  }

  async test(auth: AuthContext, body: unknown): Promise<CheckView> {
    this.throttle(`test:${auth.user.id}`, 20, 60_000);
    let source = body;
    const raw = (body ?? {}) as Record<string, any>;
    if (
      typeof raw.monitorId === 'string' &&
      UUID.test(raw.monitorId) &&
      raw.config &&
      typeof raw.config === 'object'
    ) {
      const row = await this.requireRow(auth.orgId, raw.monitorId);
      source = { ...raw, config: restoreMasked(raw.config, row.config) };
    }
    const input = parseWith(createSchema, source);
    if (input.type === 'heartbeat') {
      throw new BadRequestException(
        'Heartbeat monitors cannot be tested, they wait for your job',
      );
    }
    assertLimits(input.type, input.intervalSec, input.timeoutMs);

    const startedAt = new Date();
    const result = await this.runner.run(
      input.type,
      input.config as Record<string, any>,
      input.timeoutMs,
    );
    return {
      at: iso(startedAt),
      status: result.status,
      responseMs: result.responseMs,
      statusCode: result.statusCode,
      message: result.message,
    };
  }

  async heartbeat(
    token: string,
    ip: string,
    failed: boolean,
  ): Promise<{ ok: true; paused?: true }> {
    this.throttle(`hb-ip:${ip}`, 120, 60_000);
    const row = await this.db.row<{ id: string; paused: boolean }>(
      `SELECT id, paused FROM monitors WHERE heartbeat_token = $1 AND type = 'heartbeat'`,
      [token],
    );
    if (!row) {
      this.throttle(`hb-miss:${ip}`, 20, 60_000);
      throw new NotFoundException('Unknown heartbeat address');
    }
    this.throttle(`hb:${row.id}`, 30, 60_000);
    if (row.paused) return { ok: true, paused: true };
    await this.recorder.record(
      row.id,
      failed
        ? down('The job reported a failure')
        : up('Heartbeat received', null),
    );
    return { ok: true };
  }

  private throttle(key: string, limit: number, windowMs: number): void {
    if (!this.limiter.attempt(key, limit, windowMs)) {
      throw new HttpException(
        'Too many requests. Please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private rowsFor(orgId: string): Promise<MonitorRow[]> {
    return this.db.rows<MonitorRow>(
      'SELECT * FROM monitors WHERE org_id = $1 ORDER BY lower(name), created_at',
      [orgId],
    );
  }

  private async requireRow(orgId: string, id: string): Promise<MonitorRow> {
    const row = await this.db.row<MonitorRow>(
      'SELECT * FROM monitors WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw new NotFoundException('Monitor not found');
    return row;
  }
}
