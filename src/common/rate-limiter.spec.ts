import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('blocks after the limit and recovers once the window passes', () => {
    let now = 1_000;
    const limiter = new RateLimiter(() => now);

    expect(limiter.attempt('k', 2, 1_000)).toBe(true);
    expect(limiter.attempt('k', 2, 1_000)).toBe(true);
    expect(limiter.attempt('k', 2, 1_000)).toBe(false);

    now += 1_001;
    expect(limiter.attempt('k', 2, 1_000)).toBe(true);
  });

  it('tracks keys separately and can be reset', () => {
    const limiter = new RateLimiter(() => 0);

    expect(limiter.attempt('a', 1, 1_000)).toBe(true);
    expect(limiter.attempt('a', 1, 1_000)).toBe(false);
    expect(limiter.attempt('b', 1, 1_000)).toBe(true);

    limiter.reset('a');
    expect(limiter.attempt('a', 1, 1_000)).toBe(true);
  });

  it('counts only recorded failures when asked to', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);

    expect(limiter.blocked('acct', 2, 1_000)).toBe(false);
    limiter.record('acct', 1_000);
    expect(limiter.blocked('acct', 2, 1_000)).toBe(false);
    limiter.record('acct', 1_000);
    expect(limiter.blocked('acct', 2, 1_000)).toBe(true);
    now += 1_001;
    expect(limiter.blocked('acct', 2, 1_000)).toBe(false);
  });

  it('keeps long windows alive when a short one sweeps', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.attempt('slow', 1, 3_600_000);
    for (let i = 0; i < 5_100; i += 1) limiter.attempt(`fast${i}`, 1, 1_000);
    now = 10_000;
    limiter.attempt('trigger', 1, 1_000);

    expect(limiter.attempt('slow', 1, 3_600_000)).toBe(false);
    expect(limiter.size()).toBeLessThan(100);
  });

  it('sweeps at most once a second and never grows past its cap', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 8_000);
    for (let i = 0; i < 12_000; i += 1) limiter.attempt(`k${i}`, 1, 3_600_000);

    expect(limiter.size()).toBeLessThanOrEqual(8_000);
    expect(limiter.attempt('k11999', 1, 3_600_000)).toBe(false);
  });
});
