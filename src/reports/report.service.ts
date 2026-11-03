import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Interval, WindowSpec } from './availability';
import {
  buildSlaReport,
  resolvePeriod,
  type RawIncident,
  type ReportSubject,
  type ReportWindow,
} from './report.build';
import {
  parseWith,
  reportQuerySchema,
  type ReportQuery,
} from './report.schema';
import type {
  ReportPeriod,
  ResolvedPeriod,
  SlaReport,
  SubjectKind,
} from './report.types';
import { toDate, toMs } from '../common/time';

export const MAX_SUBJECTS = 300;

export interface Selection {
  monitorIds: string[];
  serverIds: string[];
  tags: string[];
}

interface SubjectRow {
  id: string;
  name: string;
  tags: string[] | null;
  created_at: Date;
  paused?: boolean;
}

interface IncidentRow {
  monitor_id: string | null;
  server_id: string | null;
  source: 'monitor' | 'server';
  number: number;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  trigger: 'down' | 'degraded';
  started_at: Date;
  resolved_at: Date | null;
}

export interface PauseRow {
  monitor_id: string;
  kind: 'paused' | 'resumed';
  at: Date;
}

interface WindowRow {
  starts_at: Date;
  duration_sec: number;
  repeat: WindowSpec['repeat'];
  scope_all: boolean;
  monitor_ids: string[] | null;
  tags: string[] | null;
}

export function pausedIntervals(
  events: PauseRow[],
  stillPaused: boolean,
  now: number,
): Interval[] {
  const result: Interval[] = [];
  let openedAt: number | null = null;
  for (const event of events) {
    const at = toMs(event.at);
    if (event.kind === 'paused') {
      if (openedAt === null) openedAt = at;
    } else if (openedAt !== null) {
      result.push({ start: openedAt, end: at });
      openedAt = null;
    }
  }
  if (openedAt !== null) result.push({ start: openedAt, end: now });
  else if (stillPaused && events.length === 0)
    result.push({ start: 0, end: now });
  return result;
}

@Injectable()
export class ReportService {
  constructor(private readonly db: DatabaseService) {}

  parseQuery(raw: unknown): ReportQuery {
    return parseWith(reportQuerySchema, raw);
  }

  resolvePeriod(
    query: Pick<ReportQuery, 'period' | 'from' | 'to'>,
    now: number,
  ): ResolvedPeriod {
    const resolved = resolvePeriod(query.period as ReportPeriod, now, {
      from: query.from,
      to: query.to,
    });
    if (typeof resolved === 'string') throw new BadRequestException(resolved);
    return resolved;
  }

  async build(
    orgId: string,
    query: ReportQuery,
    now: number = Date.now(),
  ): Promise<SlaReport> {
    const period = this.resolvePeriod(query, now);
    return this.buildFor(
      orgId,
      period,
      query.target,
      query.includeDegraded,
      {
        monitorIds: query.monitorIds,
        serverIds: query.serverIds,
        tags: query.tags,
      },
      now,
    );
  }

  async buildFor(
    orgId: string,
    period: ResolvedPeriod,
    target: number,
    includeDegraded: boolean,
    selection: Selection,
    now: number = Date.now(),
  ): Promise<SlaReport> {
    const [org, loaded] = await Promise.all([
      this.db.row<{ name: string }>(
        'SELECT name FROM organizations WHERE id = $1',
        [orgId],
      ),
      this.load(orgId, selection, period, now),
    ]);
    return buildSlaReport({
      organization: org?.name ?? 'Workspace',
      period,
      now,
      target,
      includeDegraded,
      subjects: loaded.subjects,
      windows: loaded.windows,
    });
  }

  async load(
    orgId: string,
    selection: Selection,
    period: ResolvedPeriod,
    now: number,
  ): Promise<{ subjects: ReportSubject[]; windows: ReportWindow[] }> {
    const everything =
      selection.monitorIds.length === 0 &&
      selection.serverIds.length === 0 &&
      selection.tags.length === 0;
    const [monitors, servers, windows] = await Promise.all([
      this.db.rows<SubjectRow>(
        `SELECT id, name, tags, created_at, paused FROM monitors
          WHERE org_id = $1 AND ($2::boolean OR id = ANY($3::uuid[]) OR tags && $4::text[])
          ORDER BY lower(name) LIMIT ${MAX_SUBJECTS + 1}`,
        [orgId, everything, selection.monitorIds, selection.tags],
      ),
      this.db.rows<SubjectRow>(
        `SELECT id, name, tags, created_at FROM servers
          WHERE org_id = $1 AND ($2::boolean OR id = ANY($3::uuid[]) OR tags && $4::text[])
          ORDER BY lower(name) LIMIT ${MAX_SUBJECTS + 1}`,
        [orgId, everything, selection.serverIds, selection.tags],
      ),
      this.db.rows<WindowRow>(
        'SELECT starts_at, duration_sec, repeat, scope_all, monitor_ids, tags FROM maintenance_windows WHERE org_id = $1',
        [orgId],
      ),
    ]);
    if (monitors.length + servers.length > MAX_SUBJECTS) {
      throw new BadRequestException(
        `A report can cover at most ${MAX_SUBJECTS} components, narrow it down with tags`,
      );
    }

    const monitorIds = monitors.map((row) => row.id);
    const serverIds = servers.map((row) => row.id);
    const [incidents, pauses] = await Promise.all([
      this.db.rows<IncidentRow>(
        `SELECT monitor_id, server_id, source, number, title, severity, trigger, started_at, resolved_at
           FROM incidents
          WHERE org_id = $1
            AND started_at < to_timestamp($3::float8 / 1000)
            AND COALESCE(resolved_at, now()) > to_timestamp($2::float8 / 1000)
            AND ((source = 'monitor' AND monitor_id = ANY($4::uuid[]))
              OR (source = 'server' AND server_metric = 'offline' AND server_id = ANY($5::uuid[])))
          ORDER BY started_at`,
        [orgId, period.from, period.to, monitorIds, serverIds],
      ),
      this.db.rows<PauseRow>(
        `SELECT monitor_id, kind, at FROM monitor_events
          WHERE monitor_id = ANY($1::uuid[]) AND kind IN ('paused', 'resumed') AND at < to_timestamp($2::float8 / 1000)
          ORDER BY monitor_id, at`,
        [monitorIds, period.to],
      ),
    ]);

    const incidentsBy = new Map<string, RawIncident[]>();
    for (const row of incidents) {
      const key = row.source === 'monitor' ? row.monitor_id : row.server_id;
      if (!key) continue;
      const list = incidentsBy.get(key) ?? [];
      list.push({
        number: row.number,
        title: row.title,
        severity: row.severity,
        trigger: row.trigger,
        startedAt: toMs(row.started_at),
        resolvedAt: row.resolved_at ? toMs(row.resolved_at) : null,
        countsAsDown: row.trigger === 'down',
        countsAsDegraded:
          row.source === 'monitor' && row.trigger === 'degraded',
      });
      incidentsBy.set(key, list);
    }
    const pausesBy = new Map<string, PauseRow[]>();
    for (const row of pauses) {
      const list = pausesBy.get(row.monitor_id) ?? [];
      list.push(row);
      pausesBy.set(row.monitor_id, list);
    }

    const subject = (kind: SubjectKind, row: SubjectRow): ReportSubject => ({
      kind,
      id: row.id,
      name: row.name,
      tags: row.tags ?? [],
      createdAt: toMs(row.created_at),
      paused:
        kind === 'monitor'
          ? pausedIntervals(
              pausesBy.get(row.id) ?? [],
              Boolean(row.paused),
              now,
            )
          : [],
      incidents: incidentsBy.get(row.id) ?? [],
    });

    return {
      subjects: [
        ...monitors.map((row) => subject('monitor', row)),
        ...servers.map((row) => subject('server', row)),
      ],
      windows: windows.map((row) => ({
        spec: {
          startsAt: toDate(row.starts_at),
          durationSec: row.duration_sec,
          repeat: row.repeat,
        },
        scope: {
          all: row.scope_all,
          monitorIds: row.monitor_ids ?? [],
          tags: row.tags ?? [],
        },
      })),
    };
  }
}
