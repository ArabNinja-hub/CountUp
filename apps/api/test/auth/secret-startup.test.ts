import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEST_AUTH_PEPPER, TEST_CSRF_SECRET } from '../test-env';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const serverPath = path.join(repoRoot, 'apps/api/src/server.ts');

interface RunResult {
  code: number | null;
  signal: string | null;
  output: string;
  listened: boolean;
}

/**
 * Starts the REAL server entry point as a separate process. Resolves as soon as
 * it either exits (fail-closed) or logs that it is listening (success), then
 * terminates it. This tests actual startup, not just a helper function.
 */
function runServer(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let listened = false;
    let done = false;
    const finish = (code: number | null, signal: string | null) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, output, listened });
    };
    const timer = setTimeout(() => {
      if (listened) {
        finish(null, 'timeout');
      } else {
        child.kill('SIGKILL');
      }
    }, 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('[countup-api] listening')) {
        listened = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      output += String(error);
      finish(null, 'error');
    });
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    PORT: '0',
    AUTH_PEPPER: TEST_AUTH_PEPPER,
    CSRF_SECRET: TEST_CSRF_SECRET,
    ...overrides,
  };
}

// Process-level startup tests are database-independent; run them in the fast
// PGlite job only, so the live suite does not spawn the same process twice.
describe.runIf(process.env.TEST_DATABASE_URL === undefined)(
  'C-04 — real process startup fails closed on missing/unsafe secrets',
  () => {
    it('starts normally when strong, distinct secrets are supplied', async () => {
      const result = await runServer(baseEnv());
      expect(result.listened).toBe(true);
      expect(result.output).toContain('[countup-api] listening');
    });

    it.each([
      ['AUTH_PEPPER missing', { AUTH_PEPPER: undefined }, /AUTH_PEPPER is required/],
      ['CSRF_SECRET missing', { CSRF_SECRET: undefined }, /CSRF_SECRET is required/],
      [
        'both missing',
        { AUTH_PEPPER: undefined, CSRF_SECRET: undefined },
        /AUTH_PEPPER is required/,
      ],
      ['short secret', { AUTH_PEPPER: 'too-short' }, /AUTH_PEPPER must be 32-512/],
      [
        'placeholder secret',
        { AUTH_PEPPER: 'development_fallback_value_1234567890' },
        /example or development fallback/,
      ],
      [
        'low entropy secret',
        { AUTH_PEPPER: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        /too little entropy/,
      ],
      ['identical secrets', { CSRF_SECRET: TEST_AUTH_PEPPER }, /must be distinct values/],
      [
        'production without PUBLIC_APP_ORIGIN',
        { NODE_ENV: 'production' },
        /PUBLIC_APP_ORIGIN is required in production/,
      ],
      [
        'production with insecure cookies forced off',
        {
          NODE_ENV: 'production',
          PUBLIC_APP_ORIGIN: 'https://app.example.com',
          COOKIE_SECURE: 'false',
        },
        /COOKIE_SECURE=false is not permitted/,
      ],
      [
        'production with a non-HTTPS origin',
        {
          NODE_ENV: 'production',
          PUBLIC_APP_ORIGIN: 'http://app.example.com',
        },
        /must be HTTPS in production/,
      ],
    ])('refuses to listen: %s', async (_label, overrides, expected) => {
      const env = baseEnv(overrides);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
          delete env[key];
        }
      }
      const result = await runServer(env);
      expect(result.listened).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(expected);
    });
  }
);
