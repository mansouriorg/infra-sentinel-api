interface Entry {
  times: number[];
  windowMs: number;
}

const SWEEP_AT = 5000;
const SWEEP_EVERY_MS = 1000;
const MAX_KEYS = 20_000;

export class RateLimiter {
  private readonly hits = new Map<string, Entry>();
  private lastSweep = -Infinity;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  attempt(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    const recent = this.recent(key, windowMs, now);
    if (recent.length >= limit) {
      this.store(key, recent, windowMs);
      return false;
    }
    recent.push(now);
    this.store(key, recent, windowMs);
    this.maintain(now);
    return true;
  }

  blocked(key: string, limit: number, windowMs: number): boolean {
    return this.recent(key, windowMs, this.now()).length >= limit;
  }

  record(key: string, windowMs: number): void {
    const now = this.now();
    const recent = this.recent(key, windowMs, now);
    recent.push(now);
    this.store(key, recent, windowMs);
    this.maintain(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  size(): number {
    return this.hits.size;
  }

  private recent(key: string, windowMs: number, now: number): number[] {
    return (this.hits.get(key)?.times ?? []).filter(
      (at) => now - at < windowMs,
    );
  }

  private store(key: string, times: number[], windowMs: number): void {
    const known = this.hits.get(key);
    this.hits.set(key, {
      times,
      windowMs: Math.max(windowMs, known?.windowMs ?? 0),
    });
  }

  private maintain(now: number): void {
    if (this.hits.size > SWEEP_AT && now - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = now;
      for (const [key, entry] of this.hits) {
        const newest = entry.times[entry.times.length - 1];
        if (newest === undefined || now - newest >= entry.windowMs)
          this.hits.delete(key);
      }
    }
    let excess = this.hits.size - this.maxKeys;
    if (excess <= 0) return;
    for (const key of this.hits.keys()) {
      this.hits.delete(key);
      excess -= 1;
      if (excess <= 0) break;
    }
  }
}
