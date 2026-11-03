import {
  describeSchedule,
  isDue,
  latestScheduledAt,
  localParts,
} from './digest.schedule';

const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m - 1, d, h, min);

describe('digest schedule', () => {
  it('reads local weekday and hour in a time zone', () => {
    expect(localParts(utc(2026, 6, 15, 12, 30), 'UTC')).toEqual({
      weekday: 1,
      hour: 12,
      minute: 30,
    });
    expect(localParts(utc(2026, 6, 15, 23, 0), 'Africa/Tunis')).toEqual({
      weekday: 2,
      hour: 0,
      minute: 0,
    });
    expect(localParts(utc(2026, 6, 15, 0, 0), 'UTC').hour).toBe(0);
  });

  it('finds the most recent scheduled moment', () => {
    const monday8 = utc(2026, 6, 15, 8, 0);
    expect(latestScheduledAt(utc(2026, 6, 15, 8, 0), 1, 8, 'UTC')).toBe(
      monday8,
    );
    expect(latestScheduledAt(utc(2026, 6, 15, 9, 59), 1, 8, 'UTC')).toBe(
      monday8,
    );
    expect(latestScheduledAt(utc(2026, 6, 17, 3, 0), 1, 8, 'UTC')).toBe(
      monday8,
    );
    expect(latestScheduledAt(utc(2026, 6, 15, 7, 59), 1, 8, 'UTC')).toBe(
      utc(2026, 6, 8, 8, 0),
    );
  });

  it('respects time zones, including half hour offsets', () => {
    expect(
      latestScheduledAt(utc(2026, 6, 15, 10, 0), 1, 8, 'Africa/Tunis'),
    ).toBe(utc(2026, 6, 15, 7, 0));
    expect(
      latestScheduledAt(utc(2026, 6, 15, 10, 0), 1, 8, 'Asia/Kolkata'),
    ).toBe(utc(2026, 6, 15, 2, 30));
    expect(
      latestScheduledAt(utc(2026, 1, 12, 14, 0), 1, 8, 'America/New_York'),
    ).toBe(utc(2026, 1, 12, 13, 0));
    expect(
      latestScheduledAt(utc(2026, 7, 13, 14, 0), 1, 8, 'America/New_York'),
    ).toBe(utc(2026, 7, 13, 12, 0));
  });

  it('is due once per cycle and not long after the scheduled time', () => {
    const settings = { weekday: 1, hour: 8, timeZone: 'UTC' };
    const scheduled = utc(2026, 6, 15, 8, 0);
    expect(isDue(utc(2026, 6, 15, 8, 0), null, settings)).toEqual({
      due: true,
      scheduledAt: scheduled,
    });
    expect(isDue(utc(2026, 6, 15, 8, 0), scheduled, settings).due).toBe(false);
    expect(
      isDue(utc(2026, 6, 15, 8, 5), scheduled - 7 * 86_400_000, settings).due,
    ).toBe(true);
    expect(isDue(utc(2026, 6, 15, 7, 59), null, settings).due).toBe(false);
    expect(isDue(utc(2026, 6, 16, 3, 0), null, settings).due).toBe(false);
  });

  it('describes the schedule', () => {
    expect(describeSchedule(1, 8, 'UTC')).toBe('Monday at 08:00 (UTC)');
    expect(describeSchedule(0, 18, 'Africa/Tunis')).toBe(
      'Sunday at 18:00 (Africa/Tunis)',
    );
  });
});
