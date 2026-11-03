import { scopeMatches, windowIsActive } from '../alerting/alert.scope';
import type { Scope } from '../alerting/alert.types';
import {
  computeAvailability,
  dailyAvailability,
  dayStarts,
  DAY_MS,
  expandWindow,
  normalize,
  type Interval,
  type WindowSpec,
} from '../reports/availability';
import {
  barStatus,
  impactOf,
  OVERALL_LABELS,
  overallStatus,
  publicIncidentId,
  publicState,
  publicTimeline,
  suggestedTitle,
  type RawUpdate,
} from './status.model';
import type {
  ComponentKind,
  ComponentStatus,
  IncidentState,
  PublicComponent,
  PublicIncident,
  PublicMaintenance,
  PublicPageInfo,
  PublicStatus,
} from './status.types';

export const PAST_INCIDENT_DAYS = 14;
const MAX_ACTIVE = 20;
const MAX_PAST = 30;
const MAINTENANCE_LOOKAHEAD_DAYS = 14;

export interface ComponentInput {
  kind: ComponentKind;
  subjectId: string;
  label: string;
  group: string;
  position: number;
  tags: string[];
  createdAt: number;
  status: ComponentStatus;
  paused: Interval[];
}

export interface IncidentInput {
  id: string;
  kind: ComponentKind;
  subjectId: string;
  trigger: 'down' | 'degraded';
  resolved: boolean;
  startedAt: number;
  resolvedAt: number | null;
  publicTitle: string;
}

export interface UpdateInput {
  incidentId: string;
  state: IncidentState;
  message: string;
  at: number;
}

export interface WindowInput {
  id: string;
  name: string;
  spec: WindowSpec;
  scope: Scope;
}

export interface AssembleInput {
  pageId: string;
  page: PublicPageInfo;
  now: number;
  components: ComponentInput[];
  incidents: IncidentInput[];
  updates: UpdateInput[];
  windows: WindowInput[];
}

export function assembleStatus(input: AssembleInput): PublicStatus {
  const { now, page } = input;
  const days = dayStarts(now, page.historyDays);
  const firstDay = days[0];
  const ordered = [...input.components].sort(
    (a, b) => a.position - b.position || a.label.localeCompare(b.label),
  );
  const subjectKey = (kind: ComponentKind, id: string) => `${kind}:${id}`;
  const byKey = new Map(
    ordered.map((component) => [
      subjectKey(component.kind, component.subjectId),
      component,
    ]),
  );
  const matches = (window: WindowInput, component: ComponentInput) =>
    scopeMatches(window.scope, {
      id: component.subjectId,
      tags: component.tags,
    });
  const activeWindows = input.windows.filter((window) =>
    windowIsActive(
      {
        startsAt: window.spec.startsAt,
        durationSec: window.spec.durationSec,
        repeat: window.spec.repeat,
      },
      new Date(now),
    ),
  );

  const components: PublicComponent[] = ordered.map((component) => {
    const down: Interval[] = input.incidents
      .filter(
        (incident) =>
          incident.kind === component.kind &&
          incident.subjectId === component.subjectId &&
          impactOf(incident.kind, incident.trigger) === 'outage',
      )
      .map((incident) => ({
        start: incident.startedAt,
        end: incident.resolvedAt ?? now,
      }));
    const maintenance = normalize(
      input.windows
        .filter((window) => matches(window, component))
        .flatMap((window) => expandWindow(window.spec, firstDay, now)),
    );
    const base = {
      existsFrom: component.createdAt,
      down,
      maintenance,
      paused: component.paused,
    };
    const overall = computeAvailability({ ...base, from: firstDay, to: now });
    const bars = dailyAvailability(base, days, now).map((entry) => ({
      day: new Date(entry.day).toISOString().slice(0, 10),
      status: barStatus(entry.availability, entry.maintenanceMs),
      availability: entry.availability,
      downSec: Math.round(entry.downMs / 1000),
    }));
    const inMaintenance = activeWindows.some((window) =>
      matches(window, component),
    );
    return {
      label: component.label,
      group: component.group,
      kind: component.kind,
      status: inMaintenance ? 'maintenance' : component.status,
      uptime: overall.availability,
      bars,
    };
  });

  const updatesBy = new Map<string, RawUpdate[]>();
  for (const update of [...input.updates].sort((a, b) => a.at - b.at)) {
    const list = updatesBy.get(update.incidentId) ?? [];
    list.push({ state: update.state, message: update.message, at: update.at });
    updatesBy.set(update.incidentId, list);
  }

  const active: PublicIncident[] = [];
  const past: PublicIncident[] = [];
  const pastSince = now - PAST_INCIDENT_DAYS * DAY_MS;
  const incidents = [...input.incidents].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  for (const incident of incidents) {
    const component = byKey.get(subjectKey(incident.kind, incident.subjectId));
    if (!component) continue;
    if (
      incident.resolved &&
      (incident.resolvedAt ?? incident.startedAt) < pastSince
    )
      continue;
    const raw = updatesBy.get(incident.id) ?? [];
    const impact = impactOf(incident.kind, incident.trigger);
    const entry: PublicIncident = {
      id: publicIncidentId(input.pageId, incident.id),
      title: incident.publicTitle || suggestedTitle(component.label, impact),
      impact,
      state: publicState(incident.resolved, raw),
      startedAt: new Date(incident.startedAt).toISOString(),
      resolvedAt:
        incident.resolved && incident.resolvedAt !== null
          ? new Date(incident.resolvedAt).toISOString()
          : null,
      components: [component.label],
      updates: publicTimeline(
        incident.startedAt,
        incident.resolved ? incident.resolvedAt : null,
        [component.label],
        raw,
      ),
    };
    (incident.resolved ? past : active).push(entry);
  }

  const maintenance: PublicMaintenance[] = [];
  for (const window of input.windows) {
    const affected = ordered
      .filter((component) => matches(window, component))
      .map((component) => component.label);
    if (affected.length === 0) continue;
    const occurrences = expandWindow(
      window.spec,
      now,
      now + MAINTENANCE_LOOKAHEAD_DAYS * DAY_MS,
    ).sort((a, b) => a.start - b.start);
    const next = occurrences[0];
    if (!next) continue;
    maintenance.push({
      id: publicIncidentId(input.pageId, window.id),
      name: window.name,
      startsAt: new Date(next.start).toISOString(),
      endsAt: new Date(next.end).toISOString(),
      active: next.start <= now && now < next.end,
      components: affected,
    });
  }
  maintenance.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      a.startsAt.localeCompare(b.startsAt),
  );

  const overall = overallStatus(
    components.map((component) => component.status),
  );
  return {
    page,
    overall: { status: overall, label: OVERALL_LABELS[overall] },
    components,
    active: active
      .sort(
        (a, b) => Number(b.impact === 'outage') - Number(a.impact === 'outage'),
      )
      .slice(0, MAX_ACTIVE),
    past: past.slice(0, MAX_PAST),
    maintenance: maintenance.slice(0, 10),
    generatedAt: new Date(now).toISOString(),
  };
}
