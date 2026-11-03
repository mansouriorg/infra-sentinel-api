import {
  MAX_ATTEMPTS,
  MAX_PER_TICK,
  PENDING,
  planNotifications,
  type Candidate,
  type NotifiedRow,
} from './status.notify';
import type { IncidentState, PublicIncident } from './status.types';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function incident(
  id: string,
  over: Partial<PublicIncident> & {
    state?: IncidentState;
    startedMs?: number;
    resolvedMs?: number | null;
    lastMs?: number;
  } = {},
): Candidate {
  const startedMs = over.startedMs ?? NOW - HOUR;
  const resolvedMs = over.resolvedMs ?? null;
  const state = over.state ?? (resolvedMs ? 'resolved' : 'investigating');
  const lastMs = over.lastMs ?? resolvedMs ?? startedMs;
  return {
    incidentId: id,
    incident: {
      id: `pub-${id}`,
      title: `Incident ${id}`,
      impact: 'outage',
      state,
      startedAt: iso(startedMs),
      resolvedAt: resolvedMs ? iso(resolvedMs) : null,
      components: ['API'],
      updates: [
        { state, message: 'm', at: iso(lastMs) },
        { state: 'investigating', message: 'first', at: iso(startedMs) },
      ],
    },
  };
}

const row = (
  id: string,
  lastState: string,
  lastMs: number | null,
  attempts = 0,
): [string, NotifiedRow] => [
  id,
  { incidentId: id, lastState, lastUpdateAt: lastMs, attempts },
];

const CREATED = NOW - 30 * 24 * HOUR;

describe('planNotifications', () => {
  it('announces a new open incident once', () => {
    const first = planNotifications([incident('a')], new Map(), NOW, CREATED);
    expect(first.send.map((item) => item.kind)).toEqual(['opened']);
    const again = planNotifications(
      [incident('a')],
      new Map([row('a', 'investigating', NOW - HOUR)]),
      NOW,
      CREATED,
    );
    expect(again.send).toEqual([]);
    expect(again.seed).toEqual([]);
  });

  it('sends an update when a newer line appears or the state changes', () => {
    const next = incident('a', {
      state: 'identified',
      lastMs: NOW - 10 * 60_000,
    });
    const plan = planNotifications(
      [next],
      new Map([row('a', 'investigating', NOW - HOUR)]),
      NOW,
      CREATED,
    );
    expect(plan.send.map((item) => item.kind)).toEqual(['update']);
    expect(plan.send[0].state).toBe('identified');
  });

  it('sends one resolved mail when an announced incident closes', () => {
    const closed = incident('a', { resolvedMs: NOW - 5 * 60_000 });
    const plan = planNotifications(
      [closed],
      new Map([row('a', 'investigating', NOW - HOUR)]),
      NOW,
      CREATED,
    );
    expect(plan.send.map((item) => item.kind)).toEqual(['resolved']);
    const after = planNotifications(
      [closed],
      new Map([row('a', 'resolved', NOW - 5 * 60_000)]),
      NOW,
      CREATED,
    );
    expect(after.send).toEqual([]);
  });

  it('treats a note posted after resolution as an update', () => {
    const closed = incident('a', {
      resolvedMs: NOW - 2 * HOUR,
      lastMs: NOW - 10 * 60_000,
    });
    const plan = planNotifications(
      [closed],
      new Map([row('a', 'resolved', NOW - 2 * HOUR)]),
      NOW,
      CREATED,
    );
    expect(plan.send.map((item) => item.kind)).toEqual(['update']);
  });

  it('mentions an incident that opened and closed between two runs, but not old history', () => {
    const quick = incident('a', {
      startedMs: NOW - 20 * 60_000,
      resolvedMs: NOW - 10 * 60_000,
    });
    const old = incident('b', {
      startedMs: NOW - 30 * HOUR,
      resolvedMs: NOW - 29 * HOUR,
    });
    const plan = planNotifications([quick, old], new Map(), NOW, CREATED);
    expect(plan.send.map((item) => [item.incidentId, item.kind])).toEqual([
      ['a', 'resolved'],
    ]);
    expect(plan.seed.map((item) => item.incidentId)).toEqual(['b']);
  });

  it('skips incidents that started before the page existed when they are already resolved', () => {
    const before = incident('a', {
      startedMs: NOW - 3 * HOUR,
      resolvedMs: NOW - HOUR,
    });
    const plan = planNotifications([before], new Map(), NOW, NOW - HOUR);
    expect(plan.send).toEqual([]);
    expect(plan.seed.map((item) => item.incidentId)).toEqual(['a']);
  });

  it('retries after a failed send and gives up after the limit', () => {
    const pending = new Map([row('a', PENDING, 0, 2)]);
    expect(
      planNotifications([incident('a')], pending, NOW, CREATED).send.map(
        (item) => [item.kind, item.attempts],
      ),
    ).toEqual([['opened', 2]]);
    const exhausted = new Map([row('a', PENDING, 0, MAX_ATTEMPTS)]);
    const plan = planNotifications([incident('a')], exhausted, NOW, CREATED);
    expect(plan.send).toEqual([]);
    expect(plan.seed.map((item) => item.incidentId)).toEqual(['a']);
    const stuckUpdate = new Map([
      row('a', 'investigating', NOW - 2 * HOUR, MAX_ATTEMPTS),
    ]);
    const update = planNotifications(
      [incident('a', { state: 'identified', lastMs: NOW - 60_000 })],
      stuckUpdate,
      NOW,
      CREATED,
    );
    expect(update.send).toEqual([]);
    expect(update.seed.length).toBe(1);
  });

  it('limits how much one run sends, oldest first', () => {
    const many = Array.from({ length: MAX_PER_TICK + 5 }, (_, index) =>
      incident(`i${index}`, { startedMs: NOW - (100 - index) * 60_000 }),
    );
    const plan = planNotifications(many, new Map(), NOW, CREATED);
    expect(plan.send.length).toBe(MAX_PER_TICK);
    expect(plan.send[0].incidentId).toBe('i0');
  });
});
