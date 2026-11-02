export interface RateLimitRule {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed-window limiter. Per-instance by design: M2 runs a single API
 * process and has no Redis. A multi-instance deployment MUST replace this with a
 * shared store (documented as a known limitation).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /** Increments the counter and returns true while the request is allowed. */
  allow(key: string, rule: RateLimitRule, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= rule.max;
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

export const DEFAULT_RATE_RULES = {
  globalIp: { max: 120, windowMs: 15 * 60 * 1000 },
  loginIp: { max: 30, windowMs: 15 * 60 * 1000 },
  loginIdentity: { max: 10, windowMs: 15 * 60 * 1000 },
  recoveryIp: { max: 10, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;
