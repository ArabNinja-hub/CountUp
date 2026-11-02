import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { EnvironmentError, loadEnv } from '../src/config/env';
import { testEnv } from './test-env';
import { RequestValidationError, parseWith } from '../src/http/validate';
import {
  createIsolatedDatabase,
  createMigratedDatabase,
  type IsolatedDatabase,
} from './isolated-database';

interface RunningApp {
  url: string;
  close(): Promise<void>;
}

async function start(app: express.Express): Promise<RunningApp> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error('Failed to bind a test port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

let db: IsolatedDatabase;
let running: RunningApp;
let csrfToken: string;

beforeEach(async () => {
  db = await createIsolatedDatabase();
  running = await start(
    createApp({
      env: testEnv({ APP_VERSION: '0.1.0-test' }),
      db: db.executor,
    })
  );
  const csrfResponse = await fetch(`${running.url}/auth/csrf`);
  expect(csrfResponse.status).toBe(200);
  csrfToken = ((await csrfResponse.json()) as { csrfToken: string }).csrfToken;
});

/** All unsafe requests now pass the strict Origin + signed double-submit guards. */
function postHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: running.url,
    'sec-fetch-site': 'same-origin',
    cookie: `countup_csrf=${csrfToken}`,
    'x-csrf-token': csrfToken,
    ...extra,
  };
}

afterEach(async () => {
  await running.close();
  await db.close();
});

describe('Zod environment validation', () => {
  it('applies safe defaults and rejects invalid values', () => {
    expect(loadEnv({})).toMatchObject({ NODE_ENV: 'development', PORT: 3000 });
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow(EnvironmentError);
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/Invalid backend environment/);
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/postgres/);
    expect(loadEnv({ DATABASE_URL: 'postgresql://localhost/countup_test' }).DATABASE_URL).toBe(
      'postgresql://localhost/countup_test'
    );
  });

  it('never requires DATABASE_URL to boot the M0/M1 foundation', () => {
    expect(loadEnv({ NODE_ENV: 'test' }).DATABASE_URL).toBeUndefined();
  });
});

describe('Zod request validation', () => {
  it('parses valid data and throws a typed error with field paths', () => {
    const schema = z.object({ shop_id: z.string().uuid(), amount_ngwee: z.number().int().min(0) });
    const parsed = parseWith(schema, {
      shop_id: '00000000-0000-4000-8000-000000000000',
      amount_ngwee: 9900,
      ignored: true,
    });
    expect(parsed).toEqual({
      shop_id: '00000000-0000-4000-8000-000000000000',
      amount_ngwee: 9900,
    });
    try {
      parseWith(schema, { shop_id: 'not-a-uuid', amount_ngwee: -1 });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).details.join(' ')).toContain('shop_id');
    }
  });
});

describe('Express foundation routes', () => {
  it('answers /health/live without a database header leak', async () => {
    const response = await fetch(`${running.url}/health/live`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'countup-api',
      version: '0.1.0-test',
      environment: 'test',
    });
  });

  it('answers /health/ready against the isolated in-memory database', async () => {
    const response = await fetch(`${running.url}/health/ready?verbose=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', environment: 'test' });
  });

  it('returns 400 for an invalid query parameter', async () => {
    const response = await fetch(`${running.url}/health/ready?verbose=2`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; details: string[] };
    expect(body.error).toBe('validation_error');
    expect(body.details.join(' ')).toContain('verbose');
  });

  it('returns 503 when no database is configured', async () => {
    const withoutDb = await start(createApp({ env: testEnv() }));
    try {
      const response = await fetch(`${withoutDb.url}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'unavailable',
        database: 'not configured',
      });
    } finally {
      await withoutDb.close();
    }
  });

  it('validates request bodies, strips unknown keys and rejects bad input', async () => {
    const ok = await fetch(`${running.url}/v1/echo`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ message: 'hello', injected: 'DROP TABLE plans;' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message: 'hello' });

    const bad = await fetch(`${running.url}/v1/echo`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ message: '' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toEqual({
      error: 'validation_error',
      details: expect.any(Array),
    });
  });

  it('rejects malformed JSON, oversized bodies and unknown routes', async () => {
    const malformed = await fetch(`${running.url}/v1/echo`, {
      method: 'POST',
      headers: postHeaders(),
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as { error: string }).toEqual({ error: 'invalid_json' });

    const oversized = await fetch(`${running.url}/v1/echo`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ message: 'x'.repeat(40_000) }),
    });
    expect(oversized.status).toBe(413);

    const notFound = await fetch(`${running.url}/v1/does-not-exist`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'not_found' });
  });
});

describe('isolated test database guarantee', () => {
  it('never reads DATABASE_URL or TEST_DATABASE_URL', async () => {
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    };
    process.env.DATABASE_URL = 'postgresql://production.invalid/countup';
    process.env.TEST_DATABASE_URL = 'postgresql://production.invalid/countup';
    try {
      const migrated = await createMigratedDatabase();
      try {
        const { rows } = await migrated.executor.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM plans'
        );
        expect(rows[0]?.count).toBe(3);
      } finally {
        await migrated.close();
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
