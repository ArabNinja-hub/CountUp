import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { AuthService } from '../../src/auth/auth-service';
import { CSRF_HEADER } from '../../src/auth/constants';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { PostgresRateLimiter } from '../../src/auth/rate-limit';
import type { SecurityOverrides } from '../../src/auth/security';
import type { QueryExecutor } from '../../src/db/query-executor';
import { createMigratedDatabase, type IsolatedDatabase } from '../isolated-database';
import { TEST_AUTH_PEPPER, TEST_CSRF_SECRET, testEnv } from '../test-env';
import { createAuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const EMAIL = 'owner@example.test';

interface RunningApp {
  base: string;
  close(): Promise<void>;
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
  csrfToken: string,
  csrfCookie: string,
  body: Record<string, unknown>
): Promise<number> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      cookie: `countup_csrf=${csrfCookie}`,
      [CSRF_HEADER]: csrfToken,
    },
    body: JSON.stringify(body),
  });
  return response.status;
}

describe('C-03 — shared PostgreSQL rate limiter', () => {
  it('two independent limiter instances share one atomic counter', async () => {
    const db = await createMigratedDatabase();
    try {
      const first = new PostgresRateLimiter(db.executor);
      const second = new PostgresRateLimiter(db.executor);
      const rule = { max: 2, windowMs: 60_000 };
      expect(await first.allow('shared-key', rule)).toBe(true);
      expect(await second.allow('shared-key', rule)).toBe(true);
      expect(await first.allow('shared-key', rule)).toBe(false);
      expect(await second.allow('shared-key', rule)).toBe(false);
      await second.reset('shared-key');
      expect(await first.allow('shared-key', rule)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('normalises identifiers before hashing so casing variants share a bucket', async () => {
    const h = await createAuthHarness({
      rules: {
        loginIp: { max: 100, windowMs: 60_000 },
        loginIdentity: { max: 2, windowMs: 60_000 },
        globalIp: { max: 100, windowMs: 60_000 },
      },
    });
    try {
      expect(
        (
          await h.client.call('POST', '/auth/signup', {
            body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
          })
        ).status
      ).toBe(201);
      const variants = ['Owner@Example.Test', 'OWNER@EXAMPLE.TEST', '  owner@example.test  '];
      const statuses: number[] = [];
      for (const identifier of variants) {
        statuses.push(
          (await h.client.call('POST', '/auth/login', { body: { identifier, password: 'wrong' } }))
            .status
        );
      }
      expect(statuses).toEqual([401, 401, 429]);
    } finally {
      await h.close();
    }
  });

  it('applies a shared limit to signup', async () => {
    const h = await createAuthHarness({
      rules: {
        signupIp: { max: 2, windowMs: 60_000 },
        signupIdentity: { max: 100, windowMs: 60_000 },
        globalIp: { max: 100, windowMs: 60_000 },
      },
    });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        statuses.push(
          (
            await h.client.call('POST', '/auth/signup', {
              body: {
                email: `signup-${index}@example.test`,
                password: PASSWORD,
                displayName: 'Signup',
              },
            })
          ).status
        );
      }
      expect(statuses).toEqual([201, 201, 429, 429]);
      expect(
        (await h.query<{ count: number }>('SELECT count(*)::int AS count FROM users'))[0]?.count
      ).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('two independent API instances share the same limits (PGlite shared store)', async () => {
    const db: IsolatedDatabase = await createMigratedDatabase();
    const allowedOrigins: string[] = [];
    const rules: SecurityOverrides['rules'] = {
      loginIp: { max: 2, windowMs: 60_000 },
      loginIdentity: { max: 100, windowMs: 60_000 },
      globalIp: { max: 100, windowMs: 60_000 },
    };
    const appA = await startApp(db.executor, {
      limiter: new PostgresRateLimiter(db.executor),
      pepper: TEST_AUTH_PEPPER,
      csrfSecret: TEST_CSRF_SECRET,
      allowedOrigins,
      rules,
    });
    const appB = await startApp(db.executor, {
      limiter: new PostgresRateLimiter(db.executor),
      pepper: TEST_AUTH_PEPPER,
      csrfSecret: TEST_CSRF_SECRET,
      allowedOrigins,
      rules,
    });
    try {
      allowedOrigins.push(appA.base, appB.base);
      const csrfResponse = await fetch(`${appA.base}/auth/csrf`);
      const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
      const csrfCookie = (csrfResponse.headers.getSetCookie()[0] ?? '')
        .split(';')[0]!
        .split('=')[1]!;
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const base = index % 2 === 0 ? appA.base : appB.base;
        statuses.push(
          await postLogin(base, csrfToken, csrfCookie, {
            identifier: `nobody-${index}@example.test`,
            password: 'wrong',
          })
        );
      }
      // With a per-instance Map each app would allow 2 -> [401,401,401,401].
      expect(statuses).toEqual([401, 401, 429, 429]);
    } finally {
      await appA.close();
      await appB.close();
      await db.close();
    }
  });
});
