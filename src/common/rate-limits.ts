export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const SWEEP_AT = 10_000;
const SWEEP_EVERY_MS = 1000;
const MAX_KEYS = 50_000;

export class RateLimits {
  private readonly windows = new Map<string, Window>();
  private lastSweep = -Infinity;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  hit(key: string, limit: number, windowMs: number): RateDecision {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    this.maintain(now);
    return {
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  size(): number {
    return this.windows.size;
  }

  private maintain(now: number): void {
    if (
      this.windows.size > SWEEP_AT &&
      now - this.lastSweep >= SWEEP_EVERY_MS
    ) {
      this.lastSweep = now;
      for (const [key, entry] of this.windows) {
        if (entry.resetAt <= now) this.windows.delete(key);
      }
    }
    let excess = this.windows.size - this.maxKeys;
    if (excess <= 0) return;
    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      excess -= 1;
      if (excess <= 0) break;
    }
  }
}

export function rateHeaders(decision: RateDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
  };
  if (!decision.allowed)
    headers['Retry-After'] = String(decision.retryAfterSec);
  return headers;
}
