import type { NotifyKind } from './status.mail';
import type { IncidentState, PublicIncident } from './status.types';

export const PENDING = 'pending';
export const MAX_ATTEMPTS = 5;
export const MAX_PER_TICK = 10;
export const RESOLVED_WINDOW_MS = 6 * 3_600_000;

export interface Candidate {
  incidentId: string;
  incident: PublicIncident;
}

export interface NotifiedRow {
  incidentId: string;
  lastState: string;
  lastUpdateAt: number | null;
  attempts: number;
}

export interface Planned {
  incidentId: string;
  kind: NotifyKind;
  incident: PublicIncident;
  state: IncidentState;
  updateAt: number;
  attempts: number;
}

export interface Seed {
  incidentId: string;
  state: IncidentState;
  updateAt: number;
}

export interface Plan {
  send: Planned[];
  seed: Seed[];
}

export function newestAt(incident: PublicIncident): number {
  return incident.updates.reduce(
    (max, update) => Math.max(max, Date.parse(update.at)),
    Date.parse(incident.startedAt),
  );
}

export function planNotifications(
  candidates: readonly Candidate[],
  notified: ReadonlyMap<string, NotifiedRow>,
  now: number,
  pageCreatedAt: number,
): Plan {
  const send: Planned[] = [];
  const seed: Seed[] = [];
  const ordered = [...candidates].sort(
    (a, b) =>
      Date.parse(a.incident.startedAt) - Date.parse(b.incident.startedAt),
  );
  for (const { incidentId, incident } of ordered) {
    const updateAt = newestAt(incident);
    const state = incident.state;
    const row = notified.get(incidentId);
    const entry = (kind: NotifyKind, attempts: number): Planned => ({
      incidentId,
      kind,
      incident,
      state,
      updateAt,
      attempts,
    });

    if (!row || row.lastState === PENDING) {
      const attempts = row ? row.attempts : 0;
      if (attempts >= MAX_ATTEMPTS) {
        seed.push({ incidentId, state, updateAt });
        continue;
      }
      if (state === 'resolved') {
        const resolvedAt = incident.resolvedAt
          ? Date.parse(incident.resolvedAt)
          : updateAt;
        const fresh =
          now - resolvedAt <= RESOLVED_WINDOW_MS &&
          Date.parse(incident.startedAt) >= pageCreatedAt;
        if (fresh) send.push(entry('resolved', attempts));
        else seed.push({ incidentId, state, updateAt });
      } else {
        send.push(entry('opened', attempts));
      }
      continue;
    }

    const changed = row.lastState !== state;
    const newer = row.lastUpdateAt === null || updateAt > row.lastUpdateAt;
    if (!changed && !newer) continue;
    if (row.attempts >= MAX_ATTEMPTS) {
      seed.push({ incidentId, state, updateAt });
      continue;
    }
    if (state === 'resolved' && row.lastState !== 'resolved')
      send.push(entry('resolved', row.attempts));
    else send.push(entry('update', row.attempts));
  }
  return { send: send.slice(0, MAX_PER_TICK), seed };
}
