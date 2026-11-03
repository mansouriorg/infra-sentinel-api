import {
  allowedDowntimeMs,
  clip,
  computeAvailability,
  dailyAvailability,
  dayStarts,
  expandWindow,
  formatAvailability,
  formatSpan,
  normalize,
  subtract,
  total,
  utcDayStart,
  type Interval,
} from './availability';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const at = (minutes: number) => T0 + minutes * MIN;
const span = (from: number, to: number): Interval => ({
  start: at(from),
  end: at(to),
});

describe('interval helpers', () => {
  it('merges overlapping and touching intervals and drops empty ones', () => {
    expect(
      normalize([
        span(10, 20),
        span(0, 5),
        span(5, 8),
        span(18, 30),
        span(40, 40),
      ]),
    ).toEqual([span(0, 8), span(10, 30)]);
  });

  it('clips to a range', () => {
    expect(
      clip([span(0, 10), span(20, 30), span(50, 60)], at(5), at(25)),
    ).toEqual([span(5, 10), span(20, 25)]);
  });

  it('subtracts intervals', () => {
    expect(subtract([span(0, 100)], [span(10, 20), span(30, 40)])).toEqual([
      span(0, 10),
      span(20, 30),
      span(40, 100),
    ]);
    expect(subtract([span(0, 10), span(20, 30)], [span(5, 25)])).toEqual([
      span(0, 5),
      span(25, 30),
    ]);
    expect(subtract([span(0, 10)], [span(0, 10)])).toEqual([]);
    expect(subtract([span(0, 10)], [span(20, 30)])).toEqual([span(0, 10)]);
    expect(subtract([span(10, 20)], [span(0, 100)])).toEqual([]);
  });

  it('adds up lengths', () => {
    expect(total([span(0, 10), span(20, 25)])).toBe(15 * MIN);
  });
});

describe('expandWindow', () => {
  const base = { startsAt: new Date(at(0)), durationSec: 3600 };

  it('returns a single occurrence for a one-off window', () => {
    expect(
      expandWindow({ ...base, repeat: 'none' }, at(-100), at(1000)),
    ).toEqual([span(0, 60)]);
    expect(expandWindow({ ...base, repeat: 'none' }, at(100), at(200))).toEqual(
      [],
    );
  });

  it('repeats daily and weekly from the start time', () => {
    const days = expandWindow(
      { ...base, repeat: 'daily' },
      T0 + 2 * DAY,
      T0 + 5 * DAY,
    );
    expect(days).toEqual([
      { start: T0 + 2 * DAY, end: T0 + 2 * DAY + HOUR },
      { start: T0 + 3 * DAY, end: T0 + 3 * DAY + HOUR },
      { start: T0 + 4 * DAY, end: T0 + 4 * DAY + HOUR },
    ]);
    const weeks = expandWindow(
      { ...base, repeat: 'weekly' },
      T0,
      T0 + 15 * DAY,
    );
    expect(weeks.map((item) => item.start)).toEqual([
      T0,
      T0 + 7 * DAY,
      T0 + 14 * DAY,
    ]);
  });

  it('includes an occurrence that began before the range and is still running', () => {
    const items = expandWindow(
      { startsAt: new Date(at(0)), durationSec: 7200, repeat: 'daily' },
      T0 + DAY + HOUR,
      T0 + DAY + 3 * HOUR,
    );
    expect(items).toEqual([{ start: T0 + DAY, end: T0 + DAY + 2 * HOUR }]);
  });

  it('does not start before the window was created', () => {
    expect(
      expandWindow(
        {
          startsAt: new Date(T0 + 3 * DAY),
          durationSec: 3600,
          repeat: 'daily',
        },
        T0,
        T0 + 2 * DAY,
      ),
    ).toEqual([]);
  });
});

describe('computeAvailability', () => {
  const period = { from: at(0), to: at(1000), existsFrom: at(-5000) };

  it('is 100% with no downtime', () => {
    const result = computeAvailability({
      ...period,
      down: [],
      maintenance: [],
      paused: [],
    });
    expect(result.availability).toBe(1);
    expect(result.downMs).toBe(0);
    expect(result.countedMs).toBe(1000 * MIN);
  });

  it('counts downtime against the whole period', () => {
    const result = computeAvailability({
      ...period,
      down: [span(100, 110)],
      maintenance: [],
      paused: [],
    });
    expect(result.downMs).toBe(10 * MIN);
    expect(result.availability).toBeCloseTo(0.99, 6);
  });

  it('does not count downtime that happened during maintenance', () => {
    const result = computeAvailability({
      ...period,
      down: [span(100, 130)],
      maintenance: [span(110, 140)],
      paused: [],
    });
    expect(result.downMs).toBe(10 * MIN);
    expect(result.maintenanceMs).toBe(30 * MIN);
    expect(result.countedMs).toBe(970 * MIN);
    expect(result.availability).toBeCloseTo(1 - 10 / 970, 9);
  });

  it('removes paused time and never counts it twice with maintenance', () => {
    const result = computeAvailability({
      ...period,
      down: [span(500, 520)],
      maintenance: [span(100, 200)],
      paused: [span(150, 250), span(510, 600)],
    });
    expect(result.maintenanceMs).toBe(100 * MIN);
    expect(result.pausedMs).toBe(50 * MIN + 90 * MIN);
    expect(result.countedMs).toBe(1000 * MIN - 240 * MIN);
    expect(result.downMs).toBe(10 * MIN);
  });

  it('starts at the moment the subject was created', () => {
    const result = computeAvailability({
      from: at(0),
      to: at(1000),
      existsFrom: at(500),
      down: [span(600, 650)],
      maintenance: [],
      paused: [],
    });
    expect(result.periodMs).toBe(500 * MIN);
    expect(result.downMs).toBe(50 * MIN);
    expect(result.availability).toBeCloseTo(0.9, 9);
  });

  it('has no value when the subject did not exist yet or the whole period was maintenance', () => {
    expect(
      computeAvailability({
        from: at(0),
        to: at(100),
        existsFrom: at(200),
        down: [],
        maintenance: [],
        paused: [],
      }).availability,
    ).toBeNull();
    expect(
      computeAvailability({
        from: at(0),
        to: at(100),
        existsFrom: at(-1),
        down: [],
        maintenance: [span(-10, 200)],
        paused: [],
      }).availability,
    ).toBeNull();
  });

  it('clips downtime that began before the period and merges overlapping incidents', () => {
    const result = computeAvailability({
      ...period,
      down: [span(-60, 20), span(10, 30), span(990, 2000)],
      maintenance: [],
      paused: [],
    });
    expect(result.downMs).toBe(30 * MIN + 10 * MIN);
  });
});

describe('dailyAvailability', () => {
  it('returns one entry per day and treats today as a partial day', () => {
    const now = T0 + 2 * DAY + 6 * HOUR;
    const days = dayStarts(now, 3);
    expect(days).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
    const result = dailyAvailability(
      {
        existsFrom: T0 - 10 * DAY,
        down: [
          { start: T0 + DAY + HOUR, end: T0 + DAY + 2 * HOUR },
          { start: T0 + 2 * DAY, end: T0 + 2 * DAY + 3 * HOUR },
        ],
        maintenance: [],
        paused: [],
      },
      days,
      now,
    );
    expect(result.map((entry) => entry.availability)).toEqual([
      1,
      1 - 1 / 24,
      0.5,
    ]);
    expect(result[2].downMs).toBe(3 * HOUR);
  });

  it('marks days before the subject existed as having no data', () => {
    const now = T0 + 2 * DAY + 12 * HOUR;
    const result = dailyAvailability(
      {
        existsFrom: T0 + DAY + 12 * HOUR,
        down: [],
        maintenance: [],
        paused: [],
      },
      dayStarts(now, 3),
      now,
    );
    expect(result.map((entry) => entry.availability)).toEqual([null, 1, 1]);
  });
});

describe('formatting', () => {
  it('formats availability without rounding up to 100', () => {
    expect(formatAvailability(1)).toBe('100%');
    expect(formatAvailability(0.99999)).toBe('99.999%');
    expect(formatAvailability(0.9999999)).toBe('99.999%');
    expect(formatAvailability(0.9998)).toBe('99.98%');
    expect(formatAvailability(0.99987)).toBe('99.987%');
    expect(formatAvailability(0.5)).toBe('50.00%');
    expect(formatAvailability(null)).toBe('n/a');
  });

  it('formats spans', () => {
    expect(formatSpan(0)).toBe('0s');
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(5 * MIN)).toBe('5m');
    expect(formatSpan(5 * MIN + 30_000)).toBe('5m 30s');
    expect(formatSpan(95 * MIN)).toBe('1h 35m');
    expect(formatSpan(50 * HOUR)).toBe('2d 2h');
  });

  it('works out the allowed downtime for a target', () => {
    expect(allowedDowntimeMs(30 * DAY, 99.9)).toBeCloseTo(43.2 * MIN, 0);
    expect(allowedDowntimeMs(30 * DAY, 100)).toBe(0);
    expect(utcDayStart(T0 + 5 * HOUR)).toBe(T0);
  });
});
