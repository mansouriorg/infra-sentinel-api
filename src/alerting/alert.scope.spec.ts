import {
  formatDuration,
  maxSeverity,
  onCallAt,
  ruleMatches,
  scopeMatches,
  windowIsActive,
  windowNextStart,
} from './alert.scope';

const monitor = { id: 'm1', tags: ['prod', 'web'] };

describe('scopeMatches', () => {
  it('matches everything when all is set', () => {
    expect(scopeMatches({ all: true, monitorIds: [], tags: [] }, monitor)).toBe(
      true,
    );
  });

  it('matches by id or by tag', () => {
    expect(
      scopeMatches({ all: false, monitorIds: ['m1'], tags: [] }, monitor),
    ).toBe(true);
    expect(
      scopeMatches({ all: false, monitorIds: [], tags: ['web'] }, monitor),
    ).toBe(true);
    expect(
      scopeMatches({ all: false, monitorIds: ['m2'], tags: ['db'] }, monitor),
    ).toBe(false);
  });
});

describe('ruleMatches', () => {
  const scope = { all: true, monitorIds: [], tags: [] };

  it('fires on down for both triggers and on degraded only for the degraded trigger', () => {
    expect(
      ruleMatches({ enabled: true, trigger: 'down', scope }, monitor, 'down'),
    ).toBe(true);
    expect(
      ruleMatches(
        { enabled: true, trigger: 'down', scope },
        monitor,
        'degraded',
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        { enabled: true, trigger: 'degraded', scope },
        monitor,
        'degraded',
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        { enabled: true, trigger: 'degraded', scope },
        monitor,
        'down',
      ),
    ).toBe(true);
    expect(
      ruleMatches({ enabled: true, trigger: 'degraded', scope }, monitor, 'up'),
    ).toBe(false);
  });

  it('ignores disabled rules', () => {
    expect(
      ruleMatches({ enabled: false, trigger: 'down', scope }, monitor, 'down'),
    ).toBe(false);
  });
});

describe('maxSeverity', () => {
  it('keeps the more serious one', () => {
    expect(maxSeverity('info', 'warning')).toBe('warning');
    expect(maxSeverity('critical', 'warning')).toBe('critical');
    expect(maxSeverity('warning', 'warning')).toBe('warning');
  });
});

describe('maintenance windows', () => {
  const start = new Date('2026-03-01T02:00:00Z');

  it('handles one-time windows', () => {
    const window = {
      startsAt: start,
      durationSec: 3600,
      repeat: 'none' as const,
    };
    expect(windowIsActive(window, new Date('2026-03-01T01:59:59Z'))).toBe(
      false,
    );
    expect(windowIsActive(window, new Date('2026-03-01T02:30:00Z'))).toBe(true);
    expect(windowIsActive(window, new Date('2026-03-01T03:00:00Z'))).toBe(
      false,
    );
    expect(windowNextStart(window, new Date('2026-02-01T00:00:00Z'))).toEqual(
      start,
    );
    expect(
      windowNextStart(window, new Date('2026-03-05T00:00:00Z')),
    ).toBeNull();
  });

  it('repeats daily and weekly', () => {
    const daily = {
      startsAt: start,
      durationSec: 1800,
      repeat: 'daily' as const,
    };
    expect(windowIsActive(daily, new Date('2026-03-09T02:10:00Z'))).toBe(true);
    expect(windowIsActive(daily, new Date('2026-03-09T03:10:00Z'))).toBe(false);
    expect(windowNextStart(daily, new Date('2026-03-09T03:10:00Z'))).toEqual(
      new Date('2026-03-10T02:00:00Z'),
    );

    const weekly = {
      startsAt: start,
      durationSec: 7200,
      repeat: 'weekly' as const,
    };
    expect(windowIsActive(weekly, new Date('2026-03-08T03:00:00Z'))).toBe(true);
    expect(windowIsActive(weekly, new Date('2026-03-09T03:00:00Z'))).toBe(
      false,
    );
  });
});

describe('onCallAt', () => {
  const anchor = new Date('2026-01-05T09:00:00Z');
  const schedule = {
    members: ['ann', 'bob', 'cy'],
    anchorAt: anchor,
    periodSec: 7 * 86_400,
  };
  const everyone = new Set(['ann', 'bob', 'cy']);

  it('rotates through the members', () => {
    expect(
      onCallAt(schedule, new Date('2026-01-05T09:00:00Z'), everyone).userId,
    ).toBe('ann');
    expect(
      onCallAt(schedule, new Date('2026-01-13T09:00:00Z'), everyone).userId,
    ).toBe('bob');
    expect(
      onCallAt(schedule, new Date('2026-01-20T09:00:00Z'), everyone).userId,
    ).toBe('cy');
    expect(
      onCallAt(schedule, new Date('2026-01-27T09:00:00Z'), everyone).userId,
    ).toBe('ann');
  });

  it('reports the next handoff', () => {
    const result = onCallAt(
      schedule,
      new Date('2026-01-07T00:00:00Z'),
      everyone,
    );
    expect(result.nextHandoffAt).toEqual(new Date('2026-01-12T09:00:00Z'));
  });

  it('works before the anchor and skips people who left', () => {
    expect(
      onCallAt(schedule, new Date('2025-12-29T09:00:00Z'), everyone).userId,
    ).toBe('cy');
    const gone = new Set(['ann', 'cy']);
    expect(
      onCallAt(schedule, new Date('2026-01-13T09:00:00Z'), gone).userId,
    ).toBe('cy');
    expect(
      onCallAt(schedule, new Date('2026-01-13T09:00:00Z'), new Set()).userId,
    ).toBeNull();
    expect(
      onCallAt({ ...schedule, members: [] }, anchor, everyone).userId,
    ).toBeNull();
  });
});

describe('formatDuration', () => {
  it('writes short readable spans', () => {
    expect(formatDuration(12)).toBe('12s');
    expect(formatDuration(125)).toBe('2m');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(3 * 86_400 + 3600)).toBe('3d 1h');
  });
});
