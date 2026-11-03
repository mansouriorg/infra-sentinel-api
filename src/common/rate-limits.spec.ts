import { RateLimits, rateHeaders } from './rate-limits';

describe('RateLimits', () => {
  it('allows the limit, then refuses until the window ends', () => {
    let now = 1_000_000;
    const limits = new RateLimits(() => now);
    const first = limits.hit('key', 3, 60_000);
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2 });
    expect(limits.hit('key', 3, 60_000).remaining).toBe(1);
    expect(limits.hit('key', 3, 60_000)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    const blocked = limits.hit('key', 3, 60_000);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 });
    expect(blocked.retryAfterSec).toBe(60);
    now += 30_000;
    expect(limits.hit('key', 3, 60_000).retryAfterSec).toBe(30);
    now += 30_001;
    expect(limits.hit('key', 3, 60_000)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it('counts keys separately and can reset one', () => {
    const limits = new RateLimits(() => 5);
    limits.hit('a', 1, 1000);
    expect(limits.hit('a', 1, 1000).allowed).toBe(false);
    expect(limits.hit('b', 1, 1000).allowed).toBe(true);
    limits.reset('a');
    expect(limits.hit('a', 1, 1000).allowed).toBe(true);
  });

  it('forgets old windows when it grows large', () => {
    let now = 0;
    const limits = new RateLimits(() => now);
    for (let i = 0; i < 10_001; i += 1) limits.hit(`k${i}`, 1, 1000);
    now = 5000;
    limits.hit('fresh', 1, 1000);
    expect(limits.size()).toBeLessThan(10_001);
  });

  it('never grows past its cap', () => {
    const limits = new RateLimits(() => 0, 5_000);
    for (let i = 0; i < 9_000; i += 1) limits.hit(`k${i}`, 1, 3_600_000);

    expect(limits.size()).toBeLessThanOrEqual(5_000);
    expect(limits.hit('k8999', 1, 3_600_000).allowed).toBe(false);
  });

  it('builds the response headers', () => {
    const ok = rateHeaders({
      allowed: true,
      limit: 600,
      remaining: 599,
      resetAt: 1_700_000_042_500,
      retryAfterSec: 30,
    });
    expect(ok).toEqual({
      'X-RateLimit-Limit': '600',
      'X-RateLimit-Remaining': '599',
      'X-RateLimit-Reset': '1700000043',
    });
    const blocked = rateHeaders({
      allowed: false,
      limit: 600,
      remaining: 0,
      resetAt: 1_700_000_042_500,
      retryAfterSec: 30,
    });
    expect(blocked['Retry-After']).toBe('30');
  });
});
