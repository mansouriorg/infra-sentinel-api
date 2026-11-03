import {
  applyOutcome,
  describeEvent,
  formatDuration,
  nextDelaySeconds,
  RETRY_SECONDS,
} from './monitor.state';

describe('applyOutcome', () => {
  it('does not mark a monitor down until the failure threshold is reached', () => {
    const first = applyOutcome(
      { status: 'up', consecutiveFailures: 0 },
      'down',
      2,
    );
    expect(first.status).toBe('up');
    expect(first.consecutiveFailures).toBe(1);
    expect(first.event).toBeNull();

    const second = applyOutcome(
      { status: first.status, consecutiveFailures: first.consecutiveFailures },
      'down',
      2,
    );
    expect(second.status).toBe('down');
    expect(second.changed).toBe(true);
    expect(second.event).toBe('down');
  });

  it('reports a down event only once', () => {
    const again = applyOutcome(
      { status: 'down', consecutiveFailures: 5 },
      'down',
      2,
    );
    expect(again.status).toBe('down');
    expect(again.changed).toBe(false);
    expect(again.event).toBeNull();
    expect(again.consecutiveFailures).toBe(6);
  });

  it('recovers and resets the failure counter', () => {
    const result = applyOutcome(
      { status: 'down', consecutiveFailures: 4 },
      'up',
      2,
    );
    expect(result.status).toBe('up');
    expect(result.consecutiveFailures).toBe(0);
    expect(result.event).toBe('up');
  });

  it('stays quiet for the very first result', () => {
    const up = applyOutcome(
      { status: 'pending', consecutiveFailures: 0 },
      'up',
      2,
    );
    expect(up.status).toBe('up');
    expect(up.changed).toBe(true);
    expect(up.event).toBeNull();

    const slow = applyOutcome(
      { status: 'pending', consecutiveFailures: 0 },
      'degraded',
      2,
    );
    expect(slow.status).toBe('degraded');
    expect(slow.event).toBeNull();
  });

  it('keeps a pending monitor pending while failures are unconfirmed', () => {
    const result = applyOutcome(
      { status: 'pending', consecutiveFailures: 0 },
      'down',
      3,
    );
    expect(result.status).toBe('pending');
    expect(result.consecutiveFailures).toBe(1);
  });

  it('moves between up and degraded with events', () => {
    expect(
      applyOutcome({ status: 'up', consecutiveFailures: 0 }, 'degraded', 2)
        .event,
    ).toBe('degraded');
    expect(
      applyOutcome({ status: 'degraded', consecutiveFailures: 0 }, 'up', 2)
        .event,
    ).toBe('up');
    expect(
      applyOutcome(
        { status: 'degraded', consecutiveFailures: 0 },
        'degraded',
        2,
      ).changed,
    ).toBe(false);
  });

  it('marks down immediately with a threshold of one', () => {
    expect(
      applyOutcome({ status: 'up', consecutiveFailures: 0 }, 'down', 1).status,
    ).toBe('down');
  });
});

describe('nextDelaySeconds', () => {
  const base = { type: 'http', intervalSec: 300, graceSec: 60 } as const;

  it('retries quickly while a failure is unconfirmed', () => {
    expect(
      nextDelaySeconds({ ...base, outcome: 'down', confirmedDown: false }),
    ).toBe(RETRY_SECONDS);
  });

  it('never retries slower than the interval', () => {
    expect(
      nextDelaySeconds({
        ...base,
        intervalSec: 20,
        outcome: 'down',
        confirmedDown: false,
      }),
    ).toBe(20);
  });

  it('uses the normal interval otherwise', () => {
    expect(
      nextDelaySeconds({ ...base, outcome: 'up', confirmedDown: false }),
    ).toBe(300);
    expect(
      nextDelaySeconds({ ...base, outcome: 'down', confirmedDown: true }),
    ).toBe(300);
  });

  it('gives heartbeats their grace period after a ping', () => {
    expect(
      nextDelaySeconds({
        ...base,
        type: 'heartbeat',
        outcome: 'up',
        confirmedDown: false,
      }),
    ).toBe(360);
    expect(
      nextDelaySeconds({
        ...base,
        type: 'heartbeat',
        outcome: 'down',
        confirmedDown: true,
      }),
    ).toBe(300);
  });
});

describe('messages', () => {
  it('formats durations', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(180_000)).toBe('3m');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('describes events', () => {
    expect(describeEvent('down', 'API', 'HTTP 503', 0)).toBe(
      'API is down: HTTP 503',
    );
    expect(describeEvent('up', 'API', '', 240_000)).toBe(
      'API is back up after 4m',
    );
    expect(describeEvent('up', 'API', '', 300)).toBe('API is back up');
    expect(describeEvent('degraded', 'API', 'Slow response', 0)).toContain(
      'degraded',
    );
  });
});
