import type { QueryExecutor, QueryResultRow } from '../db/query-executor';

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

/**
 * C-03: the limiter is an interface, and the API runtime always receives the
 * PostgreSQL-backed implementation. `allow` is asynchronous because the counter
 * lives in shared infrastructure, not in this process's heap.
 */
export interface RateLimiter {
  allow(key: string, rule: RateLimitRule): Promise<boolean>;
  reset(key?: string): Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Test-only / DB-less-boot implementation. `createApp` injects
 * `PostgresRateLimiter` whenever a database executor is configured; the real
 * deployment therefore never relies on this per-instance Map.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async allow(key: string, rule: RateLimitRule): Promise<boolean> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= rule.max;
  }

  async reset(key?: string): Promise<void> {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

interface HitCountRow extends QueryResultRow {
  hit_count: number;
}

/**
 * Shared fixed-window limiter. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * is ONE atomic statement: two API instances incrementing the same key race on
 * the same row, and PostgreSQL serialises them. No Redis or new package needed.
 */
export class PostgresRateLimiter implements RateLimiter {
  private calls = 0;

  constructor(private readonly executor: QueryExecutor) {}

  async allow(key: string, rule: RateLimitRule): Promise<boolean> {
    // Best-effort, deterministic housekeeping so the shared bucket table does not
    // grow without bound. A cleanup failure must not fail the request (the
    // counter statement below is the authoritative, atomic one).
    if (++this.calls % 64 === 0) {
      await this.executor
        .query("DELETE FROM rate_limit_buckets WHERE window_started_at < now() - interval '1 day'")
        .catch(() => undefined);
    }
    const now = Date.now();
    const { rows } = await this.executor.query<HitCountRow>(
      `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, hit_count)
       VALUES ($1, $2::timestamptz, 1)
       ON CONFLICT (bucket_key) DO UPDATE
         SET hit_count = CASE
               WHEN rate_limit_buckets.window_started_at <= $3::timestamptz THEN 1
               ELSE rate_limit_buckets.hit_count + 1 END,
             window_started_at = CASE
               WHEN rate_limit_buckets.window_started_at <= $3::timestamptz
                 THEN $2::timestamptz
               ELSE rate_limit_buckets.window_started_at END
       RETURNING hit_count`,
      [key, new Date(now), new Date(now - rule.windowMs)]
    );
    const hits = rows[0]?.hit_count;
    return typeof hits === 'number' && hits <= rule.max;
  }

  async reset(key?: string): Promise<void> {
    if (key === undefined) {
      await this.executor.query('DELETE FROM rate_limit_buckets');
    } else {
      await this.executor.query('DELETE FROM rate_limit_buckets WHERE bucket_key = $1', [key]);
    }
  }
}

export interface RateLimitRules {
  globalIp: RateLimitRule;
  loginIp: RateLimitRule;
  loginIdentity: RateLimitRule;
  signupIp: RateLimitRule;
  signupIdentity: RateLimitRule;
  recoveryIp: RateLimitRule;
  recoveryConfirmIp: RateLimitRule;
  refreshIp: RateLimitRule;
  adminIp: RateLimitRule;
}

export const DEFAULT_RATE_RULES: RateLimitRules = {
  globalIp: { max: 240, windowMs: 15 * 60 * 1000 },
  loginIp: { max: 30, windowMs: 15 * 60 * 1000 },
  loginIdentity: { max: 10, windowMs: 15 * 60 * 1000 },
  signupIp: { max: 10, windowMs: 15 * 60 * 1000 },
  signupIdentity: { max: 5, windowMs: 15 * 60 * 1000 },
  recoveryIp: { max: 10, windowMs: 15 * 60 * 1000 },
  recoveryConfirmIp: { max: 20, windowMs: 15 * 60 * 1000 },
  refreshIp: { max: 60, windowMs: 15 * 60 * 1000 },
  adminIp: { max: 30, windowMs: 15 * 60 * 1000 },
};
