import { createHash } from 'node:crypto';
import type {
  BarStatus,
  ComponentStatus,
  Impact,
  IncidentState,
  OverallStatus,
  PublicUpdate,
} from './status.types';

export const STATUS_LABELS: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  outage: 'Outage',
  maintenance: 'Under maintenance',
  unknown: 'No data',
};

export const STATE_LABELS: Record<IncidentState, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

export const OVERALL_LABELS: Record<OverallStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  major: 'Major outage',
  maintenance: 'Scheduled maintenance in progress',
  unknown: 'Status unavailable',
  empty: 'No components to show yet',
};

export function monitorComponentStatus(
  status: string,
  paused: boolean,
): ComponentStatus {
  if (paused) return 'unknown';
  if (status === 'up') return 'operational';
  if (status === 'degraded') return 'degraded';
  if (status === 'down') return 'outage';
  return 'unknown';
}

export function serverComponentStatus(
  status: 'pending' | 'online' | 'offline',
): ComponentStatus {
  if (status === 'online') return 'operational';
  if (status === 'offline') return 'outage';
  return 'unknown';
}

export function overallStatus(
  statuses: readonly ComponentStatus[],
): OverallStatus {
  if (statuses.length === 0) return 'empty';
  const outages = statuses.filter((status) => status === 'outage').length;
  if (outages > 0) return outages === statuses.length ? 'major' : 'partial';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('maintenance')) return 'maintenance';
  if (statuses.every((status) => status === 'unknown')) return 'unknown';
  return 'operational';
}

export function barStatus(
  availability: number | null,
  maintenanceMs: number,
): BarStatus {
  if (availability === null) return maintenanceMs > 0 ? 'maintenance' : 'none';
  if (availability >= 0.9995) return 'up';
  if (availability >= 0.99) return 'minor';
  return 'major';
}

export function impactOf(
  source: 'monitor' | 'server',
  trigger: 'down' | 'degraded',
): Impact {
  return source === 'monitor' && trigger === 'degraded' ? 'degraded' : 'outage';
}

export function suggestedTitle(label: string, impact: Impact): string {
  return impact === 'degraded'
    ? `${label} is experiencing degraded performance`
    : `${label} is unavailable`;
}

export function publicIncidentId(pageId: string, incidentId: string): string {
  return createHash('sha256')
    .update(`${pageId}:${incidentId}`)
    .digest('hex')
    .slice(0, 12);
}

export interface RawUpdate {
  state: IncidentState;
  message: string;
  at: number;
}

export function publicState(
  resolved: boolean,
  updates: readonly RawUpdate[],
): IncidentState {
  if (resolved) return 'resolved';
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    if (updates[index].state !== 'resolved') return updates[index].state;
  }
  return 'investigating';
}

export function publicTimeline(
  startedAt: number,
  resolvedAt: number | null,
  components: readonly string[],
  updates: readonly RawUpdate[],
): PublicUpdate[] {
  const where = components.length > 0 ? components.join(', ') : 'this service';
  const items: RawUpdate[] = [
    {
      state: 'investigating',
      message: `We detected a problem with ${where} and are looking into it.`,
      at: startedAt,
    },
    ...updates,
  ];
  if (
    resolvedAt !== null &&
    !updates.some(
      (update) => update.state === 'resolved' && update.at >= resolvedAt,
    )
  ) {
    items.push({
      state: 'resolved',
      message: 'This incident has been resolved.',
      at: resolvedAt,
    });
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at - b.item.at || a.index - b.index)
    .reverse()
    .map(({ item }) => ({
      state: item.state,
      message: item.message,
      at: new Date(item.at).toISOString(),
    }));
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/\/.*$/, '');
  value = value.replace(/\.$/, '');
  if (value.length === 0 || value.length > 253) return null;
  const labels = value.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,24}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld))
    return null;
  return value;
}

export function hostOf(header: string | undefined): string {
  if (!header) return '';
  let host = header.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(':');
  if (colon > -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
  return host.replace(/\.$/, '');
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function ownHosts(...urls: string[]): Set<string> {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  return hosts;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : '';
}

export function verificationRecord(
  domain: string,
  token: string,
): { name: string; value: string } {
  return {
    name: `_sentinel-verify.${domain}`,
    value: `sentinel-verify=${token}`,
  };
}
