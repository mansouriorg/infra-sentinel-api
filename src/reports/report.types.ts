export const REPORT_PERIODS = [
  'last7',
  'last30',
  'last90',
  'thisMonth',
  'lastMonth',
  'custom',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_FORMATS = ['json', 'csv', 'csv-incidents', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type SubjectKind = 'monitor' | 'server';

export interface ResolvedPeriod {
  from: number;
  to: number;
  label: string;
  days: number;
}

export interface SlaSubjectRow {
  kind: SubjectKind;
  id: string;
  name: string;
  availability: number | null;
  downtimeSec: number;
  maintenanceSec: number;
  pausedSec: number;
  countedSec: number;
  allowedDowntimeSec: number;
  incidents: number;
  longestSec: number;
  mttrSec: number | null;
  met: boolean | null;
}

export interface SlaIncidentRow {
  number: number;
  kind: SubjectKind;
  subject: string;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  trigger: 'down' | 'degraded';
  startedAt: string;
  resolvedAt: string | null;
  durationSec: number;
  countedAsDowntime: boolean;
}

export interface SlaSummary {
  subjects: number;
  availability: number | null;
  downtimeSec: number;
  maintenanceSec: number;
  incidents: number;
  evaluated: number;
  met: number;
  worst: { name: string; availability: number } | null;
}

export interface SlaReport {
  organization: string;
  period: { from: string; to: string; label: string; days: number };
  target: number;
  includeDegraded: boolean;
  generatedAt: string;
  summary: SlaSummary;
  rows: SlaSubjectRow[];
  incidents: SlaIncidentRow[];
  incidentsTruncated: boolean;
}
