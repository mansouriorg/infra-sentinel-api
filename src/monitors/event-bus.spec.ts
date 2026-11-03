import { EventBus } from './event-bus';
import type { LiveEvent } from './monitor.types';

const event: LiveEvent = {
  type: 'monitor',
  monitorId: 'm1',
  change: 'created',
};

describe('EventBus', () => {
  it('delivers events only to the organization they belong to', () => {
    const bus = new EventBus();
    const a: LiveEvent[] = [];
    const b: LiveEvent[] = [];
    bus.subscribe('org-a', (e) => a.push(e));
    bus.subscribe('org-b', (e) => b.push(e));

    bus.publish('org-a', event);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('stops delivering after unsubscribe and cleans up', () => {
    const bus = new EventBus();
    const seen: LiveEvent[] = [];
    const stop = bus.subscribe('org', (e) => seen.push(e));

    bus.publish('org', event);
    stop();
    bus.publish('org', event);

    expect(seen).toHaveLength(1);
    expect(bus.listenerCount('org')).toBe(0);
  });

  it('keeps going when one listener throws', () => {
    const bus = new EventBus();
    const seen: LiveEvent[] = [];
    bus.subscribe('org', () => {
      throw new Error('broken client');
    });
    bus.subscribe('org', (e) => seen.push(e));

    bus.publish('org', event);

    expect(seen).toHaveLength(1);
    expect(bus.listenerCount('org')).toBe(1);
  });

  it('lets a tap see every event of every organization, and stop watching', () => {
    const bus = new EventBus();
    const seen: Array<[string, LiveEvent]> = [];
    const stop = bus.tap((orgId, e) => seen.push([orgId, e]));

    bus.publish('org-a', event);
    bus.publish('org-b', event);
    stop();
    bus.publish('org-a', event);

    expect(seen.map(([orgId]) => orgId)).toEqual(['org-a', 'org-b']);
  });

  it('keeps delivering when a tap throws', () => {
    const bus = new EventBus();
    const seen: LiveEvent[] = [];
    bus.tap(() => {
      throw new Error('broken');
    });
    bus.subscribe('org', (e) => seen.push(e));

    bus.publish('org', event);
    bus.publish('org', event);

    expect(seen).toHaveLength(2);
  });
});
