import { DAY_MS } from './availability';
import {
  buildSlaReport,
  resolvePeriod,
  type ReportSubject,
  type ReportWindow,
} from './report.build';
import {
  csvCell,
  incidentsCsv,
  reportFileName,
  subjectsCsv,
} from './report.csv';
import type { ResolvedPeriod } from './report.types';

const MIN = 60_000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

describe('resolvePeriod', () => {
  it('builds rolling periods that end now', () => {
    const result = resolvePeriod('last30', NOW) as ResolvedPeriod;
    expect(result.to).toBe(NOW);
    expect(result.from).toBe(NOW - 30 * DAY_MS);
    expect(result.days).toBe(30);
    expect(result.label).toBe('Last 30 days (16 May 2026 to 15 Jun 2026)');
  });

  it('builds calendar months in UTC', () => {
    const last = resolvePeriod('lastMonth', NOW) as ResolvedPeriod;
    expect(last.from).toBe(Date.UTC(2026, 4, 1));
    expect(last.to).toBe(Date.UTC(2026, 5, 1));
    expect(last.label).toBe('May 2026');
    const current = resolvePeriod('thisMonth', NOW) as ResolvedPeriod;
    expect(current.from).toBe(Date.UTC(2026, 5, 1));
    expect(current.to).toBe(NOW);
  });

  it('wraps over the year boundary', () => {
    const january = Date.UTC(2026, 0, 10);
    const last = resolvePeriod('lastMonth', january) as ResolvedPeriod;
    expect(last.from).toBe(Date.UTC(2025, 11, 1));
    expect(last.label).toBe('Dec 2025');
  });

  it('includes the whole end day of a custom period and caps it at now', () => {
    const result = resolvePeriod('custom', NOW, {
      from: '2026-06-01',
      to: '2026-06-03',
    }) as ResolvedPeriod;
    expect(result.from).toBe(Date.UTC(2026, 5, 1));
    expect(result.to).toBe(Date.UTC(2026, 5, 4));
    const capped = resolvePeriod('custom', NOW, {
      from: '2026-06-10',
      to: '2026-06-30',
    }) as ResolvedPeriod;
    expect(capped.to).toBe(NOW);
  });

  it('explains invalid custom periods', () => {
    expect(resolvePeriod('custom', NOW, {})).toBe(
      'Choose a start and end date',
    );
    expect(
      resolvePeriod('custom', NOW, { from: '2026-06-05', to: '2026-06-01' }),
    ).toBe('The end date must not be before the start date');
    expect(
      resolvePeriod('custom', NOW, { from: '2027-01-01', to: '2027-01-02' }),
    ).toBe('The start date is in the future');
    expect(
      resolvePeriod('custom', NOW, { from: '2024-01-01', to: '2026-06-01' }),
    ).toBe('Choose a period of at most 400 days');
    expect(
      resolvePeriod('custom', NOW, { from: 'nope', to: '2026-06-01' }),
    ).toBe('Choose a start and end date');
  });
});

const incident = (
  number: number,
  startMin: number,
  endMin: number | null,
  extra: Partial<ReportSubject['incidents'][number]> = {},
) => ({
  number,
  title: `Incident ${number}`,
  severity: 'critical' as const,
  trigger: 'down' as const,
  startedAt: NOW - 10 * DAY_MS + startMin * MIN,
  resolvedAt: endMin === null ? null : NOW - 10 * DAY_MS + endMin * MIN,
  countsAsDown: true,
  countsAsDegraded: false,
  ...extra,
});

const subject = (over: Partial<ReportSubject>): ReportSubject => ({
  kind: 'monitor',
  id: 'm1',
  name: 'Website',
  tags: [],
  createdAt: NOW - 100 * DAY_MS,
  paused: [],
  incidents: [],
  ...over,
});

const period = resolvePeriod('last7', NOW - 2 * DAY_MS) as ResolvedPeriod;
const base = {
  organization: 'Acme',
  period: {
    ...period,
    from: NOW - 30 * DAY_MS,
    to: NOW,
    days: 30,
    label: 'Last 30 days',
  },
  now: NOW,
  target: 99.9,
  includeDegraded: false,
  windows: [] as ReportWindow[],
};

describe('buildSlaReport', () => {
  it('computes availability, downtime, incidents and MTTR per subject', () => {
    const report = buildSlaReport({
      ...base,
      subjects: [
        subject({ incidents: [incident(1, 0, 30), incident(2, 1000, 1010)] }),
      ],
    });
    const row = report.rows[0];
    expect(row.downtimeSec).toBe(40 * 60);
    expect(row.incidents).toBe(2);
    expect(row.mttrSec).toBe(20 * 60);
    expect(row.longestSec).toBe(30 * 60);
    expect(row.availability).toBeCloseTo(1 - (40 * MIN) / (30 * DAY_MS), 9);
    expect(row.allowedDowntimeSec).toBe(Math.round(30 * 86400 * 0.001));
    expect(row.met).toBe(true);
    expect(report.summary.incidents).toBe(2);
    expect(report.incidents.map((entry) => entry.number)).toEqual([2, 1]);
  });

  it('marks the target as missed when downtime is above the allowance', () => {
    const report = buildSlaReport({
      ...base,
      subjects: [subject({ incidents: [incident(1, 0, 120)] })],
    });
    expect(report.rows[0].met).toBe(false);
    expect(report.summary.met).toBe(0);
    expect(report.summary.evaluated).toBe(1);
  });

  it('excludes maintenance from downtime and from the measured time', () => {
    const windows: ReportWindow[] = [
      {
        spec: {
          startsAt: new Date(NOW - 10 * DAY_MS + 10 * MIN),
          durationSec: 600,
          repeat: 'none',
        },
        scope: { all: true, monitorIds: [], tags: [] },
      },
    ];
    const report = buildSlaReport({
      ...base,
      windows,
      subjects: [subject({ incidents: [incident(1, 0, 30)] })],
    });
    expect(report.rows[0].downtimeSec).toBe(20 * 60);
    expect(report.rows[0].maintenanceSec).toBe(10 * 60);
    expect(report.rows[0].countedSec).toBe(30 * 86400 - 600);
  });

  it('only applies windows that match the subject by id or tag', () => {
    const windows: ReportWindow[] = [
      {
        spec: {
          startsAt: new Date(NOW - 10 * DAY_MS),
          durationSec: 3600,
          repeat: 'none',
        },
        scope: { all: false, monitorIds: [], tags: ['prod'] },
      },
      {
        spec: {
          startsAt: new Date(NOW - 9 * DAY_MS),
          durationSec: 3600,
          repeat: 'none',
        },
        scope: { all: false, monitorIds: ['m2'], tags: [] },
      },
    ];
    const report = buildSlaReport({
      ...base,
      windows,
      subjects: [
        subject({ id: 'm1', name: 'A', tags: ['prod'] }),
        subject({ id: 'm2', name: 'B' }),
        subject({ id: 'm3', name: 'C' }),
      ],
    });
    const byName = Object.fromEntries(
      report.rows.map((row) => [row.name, row.maintenanceSec]),
    );
    expect(byName).toEqual({ A: 3600, B: 3600, C: 0 });
  });

  it('treats an open incident as lasting until now and can include degraded incidents', () => {
    const open = incident(1, 0, null, { startedAt: NOW - 60 * MIN });
    const degraded = incident(2, 0, 0, {
      startedAt: NOW - 3 * DAY_MS,
      resolvedAt: NOW - 3 * DAY_MS + 10 * MIN,
      trigger: 'degraded',
      countsAsDown: false,
      countsAsDegraded: true,
    });
    const without = buildSlaReport({
      ...base,
      subjects: [subject({ incidents: [open, degraded] })],
    });
    expect(without.rows[0].downtimeSec).toBe(3600);
    const withDegraded = buildSlaReport({
      ...base,
      includeDegraded: true,
      subjects: [subject({ incidents: [open, degraded] })],
    });
    expect(withDegraded.rows[0].downtimeSec).toBe(3600 + 600);
    expect(
      without.incidents.find((entry) => entry.number === 2)?.countedAsDowntime,
    ).toBe(false);
    expect(
      withDegraded.incidents.find((entry) => entry.number === 2)
        ?.countedAsDowntime,
    ).toBe(true);
  });

  it('ignores incidents outside the period and measures only the time a subject existed', () => {
    const report = buildSlaReport({
      ...base,
      subjects: [
        subject({
          id: 'old',
          name: 'Old',
          incidents: [
            {
              ...incident(1, 0, 10),
              startedAt: NOW - 60 * DAY_MS,
              resolvedAt: NOW - 60 * DAY_MS + 10 * MIN,
            },
          ],
        }),
        subject({ id: 'new', name: 'New', createdAt: NOW - 3 * DAY_MS }),
      ],
    });
    const old = report.rows.find((row) => row.name === 'Old');
    const fresh = report.rows.find((row) => row.name === 'New');
    expect(old?.incidents).toBe(0);
    expect(old?.availability).toBe(1);
    expect(fresh?.countedSec).toBe(3 * 86400);
  });

  it('orders the worst subject first and weights the summary by time', () => {
    const report = buildSlaReport({
      ...base,
      subjects: [
        subject({ id: 'a', name: 'Good' }),
        subject({ id: 'b', name: 'Bad', incidents: [incident(1, 0, 300)] }),
        subject({ id: 'c', name: 'Young', createdAt: NOW + DAY_MS }),
      ],
    });
    expect(report.rows.map((row) => row.name)).toEqual([
      'Bad',
      'Good',
      'Young',
    ]);
    expect(report.rows[2].availability).toBeNull();
    expect(report.summary.worst?.name).toBe('Bad');
    expect(report.summary.evaluated).toBe(2);
    expect(report.summary.availability).toBeCloseTo(
      1 - (300 * MIN) / (60 * DAY_MS),
      9,
    );
  });
});

describe('csv', () => {
  it('quotes cells and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5 degrees')).toBe("'-5 degrees");
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
  });

  it('writes the subject and incident tables', () => {
    const report = buildSlaReport({
      ...base,
      subjects: [
        subject({ name: 'Site, main', incidents: [incident(1, 0, 30)] }),
      ],
    });
    const subjects = subjectsCsv(report).replace('﻿', '').split('\r\n');
    expect(subjects[0].startsWith('Type,Name,Availability (%)')).toBe(true);
    expect(subjects[1].startsWith('monitor,"Site, main",99.9')).toBe(true);
    const incidents = incidentsCsv(report).replace('﻿', '').split('\r\n');
    expect(incidents[0].startsWith('Number,Type,Subject')).toBe(true);
    expect(
      incidents[1].startsWith(
        '1,monitor,"Site, main",Incident 1,critical,down,',
      ),
    ).toBe(true);
  });

  it('names files from the organization and period', () => {
    const report = buildSlaReport({ ...base, subjects: [] });
    expect(reportFileName(report, 'csv')).toBe(
      'sla-acme-2026-05-16-to-2026-06-15.csv',
    );
    expect(reportFileName(report, 'csv', '-incidents')).toBe(
      'sla-acme-2026-05-16-to-2026-06-15-incidents.csv',
    );
  });

  it('names a whole-day period by its last day, not the exclusive end', () => {
    const from = Date.UTC(2026, 8, 1);
    const to = Date.UTC(2026, 9, 1);
    const report = buildSlaReport({
      ...base,
      period: { ...base.period, from, to, days: 30, label: 'September' },
      now: to + 5 * DAY_MS,
      subjects: [],
    });
    expect(reportFileName(report, 'pdf')).toBe(
      'sla-acme-2026-09-01-to-2026-09-30.pdf',
    );
  });
});
