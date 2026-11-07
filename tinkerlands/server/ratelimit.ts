/** A single token bucket, for per-connection limits. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(ratePerSecond: number, burst: number, now: number = Date.now()) {
    this.rate = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(now: number = Date.now(), amount = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }

  isFull(now: number): boolean {
    return this.tokens + ((now - this.last) / 1000) * this.rate >= this.burst;
  }
}

/** Per-key token buckets that forget idle keys, for limits keyed by IP. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly rate: number;
  private readonly burst: number;
  private lastSweep = Date.now();

  constructor(perWindow: number, windowMs: number) {
    this.rate = perWindow / (windowMs / 1000);
    this.burst = perWindow;
  }

  allow(key: string, now: number = Date.now()): boolean {
    if (now - this.lastSweep > 60_000) this.sweep(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.rate, this.burst, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) this.buckets.delete(key);
    }
  }
}
