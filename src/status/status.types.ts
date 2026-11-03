export const PAGE_THEMES = ['auto', 'light', 'dark'] as const;
export type PageTheme = (typeof PAGE_THEMES)[number];

export const INCIDENT_STATES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export type ComponentStatus =
  | 'operational'
  | 'degraded'
  | 'outage'
  | 'maintenance'
  | 'unknown';
export type OverallStatus =
  | 'operational'
  | 'degraded'
  | 'partial'
  | 'major'
  | 'maintenance'
  | 'unknown'
  | 'empty';
export type BarStatus = 'up' | 'minor' | 'major' | 'maintenance' | 'none';
export type ComponentKind = 'monitor' | 'server';
export type Impact = 'outage' | 'degraded';

export interface DayBar {
  day: string;
  status: BarStatus;
  availability: number | null;
  downSec: number;
}

export interface PublicComponent {
  label: string;
  group: string;
  kind: ComponentKind;
  status: ComponentStatus;
  uptime: number | null;
  bars: DayBar[];
}

export interface PublicUpdate {
  state: IncidentState;
  message: string;
  at: string;
}

export interface PublicIncident {
  id: string;
  title: string;
  impact: Impact;
  state: IncidentState;
  startedAt: string;
  resolvedAt: string | null;
  components: string[];
  updates: PublicUpdate[];
}

export interface PublicMaintenance {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  components: string[];
}

export interface PublicPageInfo {
  slug: string;
  name: string;
  headline: string;
  websiteUrl: string;
  logoUrl: string;
  accent: string;
  theme: PageTheme;
  footer: string;
  historyDays: number;
}

export interface PublicStatus {
  page: PublicPageInfo;
  overall: { status: OverallStatus; label: string };
  components: PublicComponent[];
  active: PublicIncident[];
  past: PublicIncident[];
  maintenance: PublicMaintenance[];
  generatedAt: string;
}

export interface DomainView {
  name: string;
  verified: boolean;
  verifiedAt: string | null;
  recordName: string;
  recordValue: string;
}

export interface StatusPageView {
  id: string;
  slug: string;
  name: string;
  headline: string;
  websiteUrl: string;
  logoUrl: string;
  accent: string;
  theme: PageTheme;
  footer: string;
  published: boolean;
  historyDays: number;
  publicUrl: string;
  domain: DomainView | null;
  componentCount: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StatusComponentView {
  id: string;
  kind: ComponentKind;
  subjectId: string;
  name: string;
  label: string;
  group: string;
  position: number;
}

export interface StatusPageDetail extends StatusPageView {
  components: StatusComponentView[];
}

export interface SubscriberView {
  id: string;
  email: string;
  confirmed: boolean;
  createdAt: string;
  confirmedAt: string | null;
}

export interface StatusUpdateView {
  id: string;
  state: IncidentState;
  message: string;
  createdAt: string;
  author: { id: string; name: string } | null;
}

export interface IncidentStatusView {
  incidentId: string;
  publicTitle: string;
  suggestedTitle: string;
  hidden: boolean;
  resolved: boolean;
  pages: {
    id: string;
    name: string;
    slug: string;
    published: boolean;
    publicUrl: string;
  }[];
  updates: StatusUpdateView[];
}
