import { isUniqueViolation, toDate, toIso, toMs } from './time';

describe('time helpers', () => {
  it('accepts dates, ISO strings and numbers', () => {
    const date = new Date('2026-10-24T12:00:00.000Z');
    expect(toMs(date)).toBe(date.getTime());
    expect(toMs('2026-10-24T12:00:00.000Z')).toBe(date.getTime());
    expect(toMs('2026-10-24T13:00:00.123456+01:00')).toBe(date.getTime() + 123);
    expect(toMs(date.getTime())).toBe(date.getTime());
    expect(toIso('2026-10-24T13:00:00+01:00')).toBe('2026-10-24T12:00:00.000Z');
    expect(toDate(date)).toBe(date);
  });

  it('recognises unique violations from the driver or by message', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(
      isUniqueViolation(
        new Error('duplicate key value violates unique constraint "x_key"'),
      ),
    ).toBe(true);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
