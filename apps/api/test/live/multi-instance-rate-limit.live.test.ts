import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { AuthService } from '../../src/auth/auth-service';
import { CSRF_HEADER } from '../../src/auth/constants';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { PostgresRateLimiter } from '../../src/auth/rate-limit';
import type { SecurityOverrides } from '../../src/auth/security';
import { migrateUp } from '../../src/db/migrations';
import {
  createPgClientExecutor,
  createPgPoolExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { TEST_AUTH_PEPPER, TEST_CSRF_SECRET, testEnv } from '../test-env';
import { createLiveDatabase, type LiveDatabase } from './live-database';
import { Client } from 'pg';

interface RunningApp {
  base: string;
  close(): Promise<void>;
}

interface CountRow extends QueryResultRow {
  count: number;
}

async function startApp(
  executor: QueryExecutor,
  overrides: SecurityOverrides
): Promise<RunningApp> {
  const app = createApp({
    env: testEnv(),
    db: executor,
    auth: new AuthService({
      executor,
      passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
      verifier: new AdminAssistedIdentityVerifier(),
    }),
    security: overrides,
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error('failed to bind');
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function postLogin(
  base: string,
  token: string,
  cookie: string,
  index: number
): Promise<number> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      cookie: `countup_csrf=${cookie}`,
      [CSRF_HEADER]: token,
    },
    body: JSON.stringify({
      identifier: `nobody-${index}@example.test`,
      password: 'wrong-password',
    }),
  });
  return response.status;
}

let live: LiveDatabase;
let setupClient: Client;
let poolA: Pool;
let poolB: Pool;
let appA: RunningApp;
let appB: RunningApp;
let allowedOrigins: string[];

beforeAll(async () => {
  live = await createLiveDatabase('ratelimit');
  setupClient = new Client({ connectionString: live.url });
  await setupClient.connect();
  await migrateUp(createPgClientExecutor(setupClient));
  await setupClient.end();

  poolA = new Pool({ connectionString: live.url, max: 2 });
  poolB = new Pool({ connectionString: live.url, max: 2 });
  const executorA = createPgPoolExecutor(poolA);
  const executorB = createPgPoolExecutor(poolB);
  allowedOrigins = [];
  const rules: SecurityOverrides['rules'] = {
    loginIp: { max: 2, windowMs: 60_000 },
    loginIdentity: { max: 100, windowMs: 60_000 },
    globalIp: { max: 100, windowMs: 60_000 },
  };
  const overrides = (limiter: PostgresRateLimiter): SecurityOverrides => ({
    limiter,
    pepper: TEST_AUTH_PEPPER,
    csrfSecret: TEST_CSRF_SECRET,
    allowedOrigins,
    rules,
  });
  appA = await startApp(executorA, overrides(new PostgresRateLimiter(executorA)));
  appB = await startApp(executorB, overrides(new PostgresRateLimiter(executorB)));
  allowedOrigins.push(appA.base, appB.base);
});

afterAll(async () => {
  await appA?.close();
  await appB?.close();
  await poolA?.end();
  await poolB?.end();
  await live?.close();
});

describe('C-03 — two real API instances share PostgreSQL rate-limit state', () => {
  it('alternating requests across the two instances hit one combined limit', async () => {
    const csrf = await fetch(`${appA.base}/auth/csrf`);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const csrfCookie = (csrf.headers.getSetCookie()[0] ?? '').split(';')[0]!.split('=')[1]!;
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const base = index % 2 === 0 ? appA.base : appB.base;
      statuses.push(await postLogin(base, csrfToken, csrfCookie, index));
    }
    // A per-process Map would give [401,401,401,401]. Shared state gives 429s.
    expect(statuses).toEqual([401, 401, 429, 429]);
  });

  it('the limiter state is visible in the shared table, not in process memory', async () => {
    const executor = createPgPoolExecutor(poolA);
    const { rows } = await executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM rate_limit_buckets'
    );
    expect(rows[0]?.count).toBeGreaterThan(0);
    const loginIp = await executor.query<{ bucket_key: string; hit_count: number }>(
      "SELECT bucket_key, hit_count FROM rate_limit_buckets WHERE bucket_key LIKE 'login-ip:%'"
    );
    expect(loginIp.rows[0]?.hit_count).toBeGreaterThan(2);
  });

  it('signup is rate limited on both instances', async () => {
    // Use a fresh key namespace by raising limits via a new pair of apps is not
    // needed: the global/login buckets are separate from the signup bucket.
    const csrf = await fetch(`${appB.base}/auth/csrf`);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const csrfCookie = (csrf.headers.getSetCookie()[0] ?? '').split(';')[0]!.split('=')[1]!;
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const base = index % 2 === 0 ? appA.base : appB.base;
      const response = await fetch(`${base}/auth/signup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          'sec-fetch-site': 'same-origin',
          cookie: `countup_csrf=${csrfCookie}`,
          [CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({
          email: `multi-${index}@example.test`,
          password: 'Str0ngPassw0rd!2026',
          displayName: 'Multi',
        }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
