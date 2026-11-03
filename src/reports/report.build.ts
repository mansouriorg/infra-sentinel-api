import { scopeMatches } from '../alerting/alert.scope';
import {
  allowedDowntimeMs,
  clip,
  computeAvailability,
  expandWindow,
  normalize,
  total,
  DAY_MS,
  type Interval,
  type WindowSpec,
} from './availability';
import type {
  ReportPeriod,
  ResolvedPeriod,
  SlaIncidentRow,
  SlaReport,
  SlaSubjectRow,
  SlaSummary,
  SubjectKind,
} from './report.types';

export const MAX_REPORT_DAYS = 400;
export const MAX_INCIDENT_ROWS = 500;

export interface RawIncident {
  number: number;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  trigger: 'down' | 'degraded';
  startedAt: number;
  resolvedAt: number | null;
  countsAsDown: boolean;
  countsAsDegraded: boolean;
}

export interface ReportSubject {
  kind: SubjectKind;
  id: string;
  name: string;
  tags: string[];
  createdAt: number;
  paused: Interval[];
  incidents: RawIncident[];
}

export interface ReportWindow {
  spec: WindowSpec;
  scope: { all: boolean; monitorIds: string[]; tags: string[] };
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatDayTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${formatDay(ms)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function parseDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function resolvePeriod(
  period: ReportPeriod,
  now: number,
  custom: { from?: string; to?: string } = {},
): ResolvedPeriod | string {
  const rolling = (days: number, name: string): ResolvedPeriod => ({
    from: now - days * DAY_MS,
    to: now,
    label: `${name} (${formatDay(now - days * DAY_MS)} to ${formatDay(now)})`,
    days,
  });
  const finish = (from: number, to: number, label: string): ResolvedPeriod => ({
    from,
    to,
    label,
    days: Math.round(((to - from) / DAY_MS) * 10) / 10,
  });
  if (period === 'last7') return rolling(7, 'Last 7 days');
  if (period === 'last30') return rolling(30, 'Last 30 days');
  if (period === 'last90') return rolling(90, 'Last 90 days');
  const current = new Date(now);
  const monthStart = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    1,
  );
  if (period === 'thisMonth') {
    return finish(
      monthStart,
      now,
      `${MONTHS[current.getUTCMonth()]} ${current.getUTCFullYear()} so far`,
    );
  }
  if (period === 'lastMonth') {
    const previous = new Date(monthStart - 1);
    const start = Date.UTC(
      previous.getUTCFullYear(),
      previous.getUTCMonth(),
      1,
    );
    return finish(
      start,
      monthStart,
      `${MONTHS[previous.getUTCMonth()]} ${previous.getUTCFullYear()}`,
    );
  }
  const from = parseDay(custom.from);
  const toDay = parseDay(custom.to);
  if (from === null || toDay === null) return 'Choose a start and end date';
  if (toDay < from) return 'The end date must not be before the start date';
  if (from > now) return 'The start date is in the future';
  const to = Math.min(toDay + DAY_MS, now);
  if (to - from > MAX_REPORT_DAYS * DAY_MS)
    return `Choose a period of at most ${MAX_REPORT_DAYS} days`;
  return finish(from, to, `${formatDay(from)} to ${formatDay(toDay)}`);
}

export interface BuildInput {
  organization: string;
  period: ResolvedPeriod;
  now: number;
  target: number;
  includeDegraded: boolean;
  subjects: ReportSubject[];
  windows: ReportWindow[];
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

export function buildSlaReport(input: BuildInput): SlaReport {
  const { from, to } = input.period;
  const rows: SlaSubjectRow[] = [];
  const incidents: (SlaIncidentRow & { sort: number })[] = [];
  let countedTotal = 0;
  let downTotal = 0;
  let maintenanceTotal = 0;
  let incidentTotal = 0;

  for (const subject of input.subjects) {
    const scoped = input.windows.filter((window) =>
      scopeMatches(window.scope, { id: subject.id, tags: subject.tags }),
    );
    const maintenance = normalize(
      scoped.flatMap((window) => expandWindow(window.spec, from, to)),
    );
    const counted = subject.incidents.filter(
      (incident) =>
        incident.countsAsDown ||
        (input.includeDegraded && incident.countsAsDegraded),
    );
    const down: Interval[] = counted.map((incident) => ({
      start: incident.startedAt,
      end: incident.resolvedAt ?? input.now,
    }));
    const result = computeAvailability({
      from,
      to,
      existsFrom: subject.createdAt,
      down,
      maintenance,
      paused: subject.paused,
    });

    const overlapping = subject.incidents.filter(
      (incident) =>
        incident.startedAt < to && (incident.resolvedAt ?? input.now) > from,
    );
    const resolvedHere = counted.filter(
      (incident) =>
        incident.resolvedAt !== null &&
        incident.resolvedAt >= from &&
        incident.resolvedAt <= to,
    );
    const mttr =
      resolvedHere.length > 0
        ? resolvedHere.reduce(
            (sum, incident) =>
              sum + ((incident.resolvedAt as number) - incident.startedAt),
            0,
          ) / resolvedHere.length
        : null;
    const longest = counted.reduce((max, incident) => {
      const clipped = clip(
        [{ start: incident.startedAt, end: incident.resolvedAt ?? input.now }],
        from,
        to,
      );
      return Math.max(max, total(clipped));
    }, 0);
    const allowed = allowedDowntimeMs(result.countedMs, input.target);

    rows.push({
      kind: subject.kind,
      id: subject.id,
      name: subject.name,
      availability: result.availability,
      downtimeSec: seconds(result.downMs),
      maintenanceSec: seconds(result.maintenanceMs),
      pausedSec: seconds(result.pausedMs),
      countedSec: seconds(result.countedMs),
      allowedDowntimeSec: seconds(allowed),
      incidents: overlapping.length,
      longestSec: seconds(longest),
      mttrSec: mttr === null ? null : seconds(mttr),
      met:
        result.availability === null
          ? null
          : result.availability * 100 >= input.target - 1e-9,
    });

    if (result.countedMs > 0) {
      countedTotal += result.countedMs;
      downTotal += result.downMs;
    }
    maintenanceTotal += result.maintenanceMs;
    incidentTotal += overlapping.length;

    for (const incident of overlapping) {
      const end = incident.resolvedAt ?? input.now;
      incidents.push({
        number: incident.number,
        kind: subject.kind,
        subject: subject.name,
        title: incident.title,
        severity: incident.severity,
        trigger: incident.trigger,
        startedAt: new Date(incident.startedAt).toISOString(),
        resolvedAt:
          incident.resolvedAt === null
            ? null
            : new Date(incident.resolvedAt).toISOString(),
        durationSec: seconds(end - incident.startedAt),
        countedAsDowntime:
          incident.countsAsDown ||
          (input.includeDegraded && incident.countsAsDegraded),
        sort: incident.startedAt,
      });
    }
  }

  rows.sort((a, b) => {
    const left = a.availability ?? 2;
    const right = b.availability ?? 2;
    return left - right || a.name.localeCompare(b.name);
  });
  incidents.sort((a, b) => b.sort - a.sort);

  const evaluated = rows.filter((row) => row.met !== null);
  const worst = rows.find((row) => row.availability !== null);
  const summary: SlaSummary = {
    subjects: rows.length,
    availability:
      countedTotal > 0
        ? Math.max(0, Math.min(1, 1 - downTotal / countedTotal))
        : null,
    downtimeSec: seconds(downTotal),
    maintenanceSec: seconds(maintenanceTotal),
    incidents: incidentTotal,
    evaluated: evaluated.length,
    met: evaluated.filter((row) => row.met).length,
    worst:
      worst && worst.availability !== null
        ? { name: worst.name, availability: worst.availability }
        : null,
  };

  return {
    organization: input.organization,
    period: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      label: input.period.label,
      days: input.period.days,
    },
    target: input.target,
    includeDegraded: input.includeDegraded,
    generatedAt: new Date(input.now).toISOString(),
    summary,
    rows,
    incidents: incidents
      .slice(0, MAX_INCIDENT_ROWS)
      .map(({ sort: _sort, ...row }) => row),
    incidentsTruncated: incidents.length > MAX_INCIDENT_ROWS,
  };
}
