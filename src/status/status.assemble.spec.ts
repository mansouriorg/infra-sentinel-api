import {
  assembleStatus,
  type AssembleInput,
  type ComponentInput,
  type IncidentInput,
} from './status.assemble';
import { publicIncidentId } from './status.model';
import type { PublicPageInfo } from './status.types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const page: PublicPageInfo = {
  slug: 'acme',
  name: 'Acme',
  headline: '',
  websiteUrl: '',
  logoUrl: '',
  accent: '#0e7490',
  theme: 'auto',
  footer: '',
  historyDays: 30,
};

const component = (over: Partial<ComponentInput> = {}): ComponentInput => ({
  kind: 'monitor',
  subjectId: 'm1',
  label: 'Checkout API',
  group: 'Core',
  position: 0,
  tags: [],
  createdAt: NOW - 100 * DAY,
  status: 'operational',
  paused: [],
  ...over,
});

const incident = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  id: 'i1',
  kind: 'monitor',
  subjectId: 'm1',
  trigger: 'down',
  resolved: true,
  startedAt: NOW - 2 * DAY - 2 * HOUR,
  resolvedAt: NOW - 2 * DAY - HOUR,
  publicTitle: '',
  ...over,
});

const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  pageId: 'p1',
  page,
  now: NOW,
  components: [component()],
  incidents: [],
  updates: [],
  windows: [],
  ...over,
});

describe('assembleStatus', () => {
  it('shows all systems operational with 100% bars', () => {
    const model = assembleStatus(input());
    expect(model.overall).toEqual({
      status: 'operational',
      label: 'All systems operational',
    });
    expect(model.components[0].bars.length).toBe(30);
    expect(
      model.components[0].bars.every((entry) => entry.status === 'up'),
    ).toBe(true);
    expect(model.components[0].uptime).toBe(1);
    expect(model.active).toEqual([]);
    expect(model.past).toEqual([]);
  });

  it('turns the bar red for the day of an hour-long outage and lists the resolved incident', () => {
    const model = assembleStatus(input({ incidents: [incident()] }));
    const bar = model.components[0].bars[model.components[0].bars.length - 3];
    expect(bar.day).toBe('2026-10-22');
    expect(bar.status).toBe('major');
    expect(bar.downSec).toBe(3600);
    expect(model.components[0].uptime).toBeCloseTo(
      1 - (3600 / (29.5 * DAY)) * 1000,
      3,
    );
    expect(model.past.length).toBe(1);
    expect(model.past[0].title).toBe('Checkout API is unavailable');
    expect(model.past[0].state).toBe('resolved');
    expect(model.past[0].id).toBe(publicIncidentId('p1', 'i1'));
    expect(model.past[0].updates.map((update) => update.state)).toEqual([
      'resolved',
      'investigating',
    ]);
  });

  it('lists an open incident as active with its manual updates and a custom title', () => {
    const model = assembleStatus(
      input({
        components: [component({ status: 'outage' })],
        incidents: [
          incident({
            resolved: false,
            resolvedAt: null,
            startedAt: NOW - HOUR,
            publicTitle: 'Payments are failing',
          }),
        ],
        updates: [
          {
            incidentId: 'i1',
            state: 'identified',
            message: 'A bad deploy',
            at: NOW - 30 * 60_000,
          },
        ],
      }),
    );
    expect(model.overall.status).toBe('major');
    expect(model.active.length).toBe(1);
    expect(model.active[0].title).toBe('Payments are failing');
    expect(model.active[0].state).toBe('identified');
    expect(model.active[0].resolvedAt).toBeNull();
    expect(model.active[0].updates.map((update) => update.message)[0]).toBe(
      'A bad deploy',
    );
  });

  it('lists outages before degraded incidents, newest first within each', () => {
    const model = assembleStatus(
      input({
        components: [
          component({ subjectId: 'a', label: 'A' }),
          component({ subjectId: 'b', label: 'B' }),
          component({ subjectId: 'c', label: 'C' }),
        ],
        incidents: [
          incident({
            id: 'x1',
            subjectId: 'a',
            trigger: 'degraded',
            resolved: false,
            resolvedAt: null,
            startedAt: NOW - HOUR,
          }),
          incident({
            id: 'x2',
            subjectId: 'b',
            resolved: false,
            resolvedAt: null,
            startedAt: NOW - 3 * HOUR,
          }),
          incident({
            id: 'x3',
            subjectId: 'c',
            resolved: false,
            resolvedAt: null,
            startedAt: NOW - 2 * HOUR,
          }),
        ],
      }),
    );
    expect(model.active.map((item) => item.components[0])).toEqual([
      'C',
      'B',
      'A',
    ]);
  });

  it('keeps degraded incidents out of the uptime bars', () => {
    const model = assembleStatus(
      input({ incidents: [incident({ trigger: 'degraded' })] }),
    );
    expect(model.components[0].uptime).toBe(1);
    expect(model.past[0].impact).toBe('degraded');
    expect(model.past[0].title).toBe(
      'Checkout API is experiencing degraded performance',
    );
  });

  it('drops resolved incidents older than two weeks', () => {
    const model = assembleStatus(
      input({
        incidents: [
          incident({
            startedAt: NOW - 20 * DAY - HOUR,
            resolvedAt: NOW - 20 * DAY,
          }),
        ],
      }),
    );
    expect(model.past).toEqual([]);
    expect(
      model.components[0].bars.some((entry) => entry.status === 'major'),
    ).toBe(true);
  });

  it('ignores incidents on components that are not on the page', () => {
    expect(
      assembleStatus(input({ incidents: [incident({ subjectId: 'other' })] }))
        .past,
    ).toEqual([]);
  });

  it('shows an active announced window as maintenance and lists upcoming ones', () => {
    const active = {
      id: 'w1',
      name: 'Database upgrade',
      spec: {
        startsAt: new Date(NOW - HOUR),
        durationSec: 7200,
        repeat: 'none' as const,
      },
      scope: { all: false, monitorIds: ['m1'], tags: [] },
    };
    const later = {
      id: 'w2',
      name: 'Nightly patch',
      spec: {
        startsAt: new Date(NOW + 3 * DAY),
        durationSec: 1800,
        repeat: 'daily' as const,
      },
      scope: { all: true, monitorIds: [], tags: [] },
    };
    const unrelated = {
      id: 'w3',
      name: 'Other',
      spec: {
        startsAt: new Date(NOW + HOUR),
        durationSec: 600,
        repeat: 'none' as const,
      },
      scope: { all: false, monitorIds: ['zzz'], tags: [] },
    };
    const model = assembleStatus(
      input({ windows: [later, active, unrelated] }),
    );
    expect(model.components[0].status).toBe('maintenance');
    expect(model.overall.status).toBe('maintenance');
    expect(model.maintenance.map((item) => item.name)).toEqual([
      'Database upgrade',
      'Nightly patch',
    ]);
    expect(model.maintenance[0].active).toBe(true);
    expect(model.maintenance[0].components).toEqual(['Checkout API']);
    expect(model.maintenance[1].active).toBe(false);
    expect(model.maintenance[1].startsAt).toBe(
      new Date(NOW + 3 * DAY).toISOString(),
    );
  });

  it('does not count downtime inside announced maintenance', () => {
    const window = {
      id: 'w1',
      name: 'Upgrade',
      spec: {
        startsAt: new Date(NOW - 2 * DAY - 3 * HOUR),
        durationSec: 4 * 3600,
        repeat: 'none' as const,
      },
      scope: { all: true, monitorIds: [], tags: [] },
    };
    const model = assembleStatus(
      input({ windows: [window], incidents: [incident()] }),
    );
    expect(model.components[0].uptime).toBe(1);
  });

  it('orders by position then label and handles servers', () => {
    const model = assembleStatus(
      input({
        components: [
          component({ subjectId: 'a', label: 'B', position: 1, group: '' }),
          component({ subjectId: 'b', label: 'A', position: 1, group: '' }),
          component({
            subjectId: 's1',
            kind: 'server',
            label: 'Database host',
            position: 0,
            group: 'Infra',
            status: 'outage',
          }),
        ],
      }),
    );
    expect(model.components.map((item) => item.label)).toEqual([
      'Database host',
      'A',
      'B',
    ]);
    expect(model.overall.status).toBe('partial');
  });

  it('shows bars as having no data before the component existed', () => {
    const model = assembleStatus(
      input({ components: [component({ createdAt: NOW - 5 * DAY })] }),
    );
    const bars = model.components[0].bars;
    expect(bars[0].status).toBe('none');
    expect(bars[bars.length - 1].status).toBe('up');
    expect(bars.filter((entry) => entry.status === 'none').length).toBe(24);
  });
});
