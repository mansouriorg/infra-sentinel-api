import type { SlaReport } from './report.types';

export function csvCell(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
  header: string[],
  rows: (string | number | boolean | null)[][],
): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function percent(value: number | null): string {
  return value === null ? '' : (value * 100).toFixed(4);
}

export function subjectsCsv(report: SlaReport): string {
  return toCsv(
    [
      'Type',
      'Name',
      'Availability (%)',
      'Target (%)',
      'Target met',
      'Downtime (seconds)',
      'Scheduled maintenance (seconds)',
      'Paused (seconds)',
      'Measured period (seconds)',
      'Allowed downtime (seconds)',
      'Incidents',
      'Longest outage (seconds)',
      'Mean time to recover (seconds)',
    ],
    report.rows.map((row) => [
      row.kind,
      row.name,
      percent(row.availability),
      report.target,
      row.met === null ? '' : row.met ? 'yes' : 'no',
      row.downtimeSec,
      row.maintenanceSec,
      row.pausedSec,
      row.countedSec,
      row.allowedDowntimeSec,
      row.incidents,
      row.longestSec,
      row.mttrSec,
    ]),
  );
}

export function incidentsCsv(report: SlaReport): string {
  return toCsv(
    [
      'Number',
      'Type',
      'Subject',
      'Title',
      'Severity',
      'Trigger',
      'Started (UTC)',
      'Resolved (UTC)',
      'Duration (seconds)',
      'Counted as downtime',
    ],
    report.incidents.map((row) => [
      row.number,
      row.kind,
      row.subject,
      row.title,
      row.severity,
      row.trigger,
      row.startedAt,
      row.resolvedAt,
      row.durationSec,
      row.countedAsDowntime ? 'yes' : 'no',
    ]),
  );
}

export function reportFileName(
  report: SlaReport,
  extension: string,
  suffix = '',
): string {
  const day = (value: string) => value.slice(0, 10);
  const lastDay = (value: string) =>
    new Date(Date.parse(value) - 1).toISOString().slice(0, 10);
  const org =
    report.organization
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace';
  return `sla-${org}-${day(report.period.from)}-to-${lastDay(report.period.to)}${suffix}.${extension}`;
}
