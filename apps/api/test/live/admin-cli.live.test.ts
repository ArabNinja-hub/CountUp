import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth-service';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { migrateUp } from '../../src/db/migrations';
import {
  createPgClientExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { TEST_AUTH_PEPPER, TEST_CSRF_SECRET } from '../test-env';
import { createLiveDatabase, type LiveDatabase } from './live-database';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const cliPath = path.join(repoRoot, 'apps/api/src/admin/admin-cli.ts');
const PASSWORD_A = 'Str0ngPassw0rd!2026';
const PASSWORD_B = 'An0therStr0ngPassw0rd!2026';
const NEW_PASSWORD = 'Br3akGlassRecovered!2026';

interface CountRow extends QueryResultRow {
  count: number;
}
interface AuditRow extends QueryResultRow {
  action: string;
}

let live: LiveDatabase;
let client: Client;
let executor: QueryExecutor;

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    DATABASE_URL: live.url,
    AUTH_PEPPER: TEST_AUTH_PEPPER,
    CSRF_SECRET: TEST_CSRF_SECRET,
    ...extra,
  };
}

function runCli(command: 'bootstrap' | 'recover', extra: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, command], {
    cwd: repoRoot,
    env: cliEnv(extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function bootstrapEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COUNTUP_BOOTSTRAP_CONFIRM: 'I_UNDERSTAND_THIS_CREATES_PLATFORM_ADMINS',
    COUNTUP_BOOTSTRAP_ADMIN_EMAIL: 'cli-admin-one@example.test',
    COUNTUP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD_A,
    COUNTUP_BOOTSTRAP_ADMIN2_EMAIL: 'cli-admin-two@example.test',
    COUNTUP_BOOTSTRAP_ADMIN2_PASSWORD: PASSWORD_B,
    ...extra,
  };
}

function sharesFrom(output: string): [string, string] {
  const a = /COUNTUP_RECOVERY_SHARE_A=([^\s]+)/.exec(output)?.[1];
  const b = /COUNTUP_RECOVERY_SHARE_B=([^\s]+)/.exec(output)?.[1];
  if (a === undefined || b === undefined) {
    throw new Error(`CLI did not print both shares:\n${output}`);
  }
  return [a, b];
}

beforeAll(async () => {
  live = await createLiveDatabase('admincli');
  client = new Client({ connectionString: live.url });
  await client.connect();
  executor = createPgClientExecutor(client);
  await migrateUp(executor);
});

afterAll(async () => {
  await client?.end();
  await live?.close();
});

describe('C-02 — real administrator bootstrap / break-glass CLI runbook', () => {
  it('refuses to run without the explicit confirmation token', async () => {
    const env = bootstrapEnv();
    delete env.COUNTUP_BOOTSTRAP_CONFIRM;
    const result = runCli('bootstrap', env);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/COUNTUP_BOOTSTRAP_CONFIRM/);
    const admins = await executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin'"
    );
    expect(admins.rows[0]?.count).toBe(0);
  });

  it('bootstraps exactly two admins, prints two shares once, and audits it', async () => {
    const result = runCli('bootstrap', bootstrapEnv());
    expect(result.code, result.output).toBe(0);
    const [shareA, shareB] = sharesFrom(result.output);
    expect(shareA).not.toBe(shareB);
    expect(result.output).toContain('BOOTSTRAP COMPLETE');

    const admins = await executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin'"
    );
    expect(admins.rows[0]?.count).toBe(2);
    const bootstrap = await executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM platform_bootstrap'
    );
    expect(bootstrap.rows[0]?.count).toBe(1);
    const grants = await executor.query<{ share_a_hash: string; share_b_hash: string }>(
      'SELECT share_a_hash, share_b_hash FROM admin_recovery_grants WHERE used_at IS NULL'
    );
    expect(grants.rows).toHaveLength(1);
    expect(JSON.stringify(grants.rows)).not.toContain(shareA);
    expect(JSON.stringify(grants.rows)).not.toContain(shareB);
    const audits = await executor.query<AuditRow>('SELECT action FROM platform_audit');
    expect(audits.rows.map((row) => row.action)).toContain('auth.admin.bootstrap_completed');

    // The bootstrap admin can log in through the real API service with the
    // pepper that the CLI used.
    const service = new AuthService({
      executor,
      passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
      verifier: new AdminAssistedIdentityVerifier(),
    });
    const login = await service.login({
      identifier: 'cli-admin-one@example.test',
      password: PASSWORD_A,
    });
    expect(login.user.role).toBe('platform_admin');

    // Expose the shares to the following tests via a module-level holder.
    holder.shares = [shareA, shareB];
  });

  it('a repeated bootstrap is refused and audited, with no new accounts', async () => {
    const result = runCli('bootstrap', bootstrapEnv());
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/already completed/);
    const admins = await executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin'"
    );
    expect(admins.rows[0]?.count).toBe(2);
    const rejected = await executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.admin.bootstrap_rejected'"
    );
    expect(rejected.rows[0]?.count).toBe(1);
  });

  it('recovery needs BOTH shares, then rotates them and restores access', async () => {
    const [shareA, shareB] = holder.shares;
    const recoverEnv = (a: string, b: string): NodeJS.ProcessEnv => ({
      COUNTUP_RECOVERY_CONFIRM: 'I_UNDERSTAND_THIS_RESETS_THE_BOOTSTRAP_ADMIN_PASSWORD',
      COUNTUP_RECOVERY_SHARE_A: a,
      COUNTUP_RECOVERY_SHARE_B: b,
      COUNTUP_RECOVERY_NEW_PASSWORD: NEW_PASSWORD,
    });

    const wrong = runCli('recover', recoverEnv(shareA, 'incorrect-share-value-that-is-long'));
    expect(wrong.code).not.toBe(0);
    const activeBefore = await executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM admin_recovery_grants WHERE used_at IS NULL'
    );
    expect(activeBefore.rows[0]?.count).toBe(1);

    const success = runCli('recover', recoverEnv(shareA, shareB));
    expect(success.code, success.output).toBe(0);
    const [nextA, nextB] = sharesFrom(success.output);
    expect(nextA).not.toBe(shareA);
    expect(nextB).not.toBe(shareB);
    expect(success.output).toContain('NEW SINGLE-USE SHARES');

    const service = new AuthService({
      executor,
      passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
      verifier: new AdminAssistedIdentityVerifier(),
    });
    await expect(
      service.login({ identifier: 'cli-admin-one@example.test', password: PASSWORD_A })
    ).rejects.toThrow();
    const login = await service.login({
      identifier: 'cli-admin-one@example.test',
      password: NEW_PASSWORD,
    });
    expect(login.user.role).toBe('platform_admin');

    const audits = await executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.admin.break_glass_recovery'"
    );
    expect(audits.rows[0]?.count).toBe(1);
    const used = await executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM admin_recovery_grants WHERE used_at IS NOT NULL'
    );
    expect(used.rows[0]?.count).toBe(1);

    // Consumed shares cannot be replayed.
    const replay = runCli('recover', recoverEnv(shareA, shareB));
    expect(replay.code).not.toBe(0);
  });
  it('the built CLI bundle resolves migrations and bootstraps from dist/', async () => {
    const bundle = path.join(repoRoot, 'apps/api/dist/admin-cli.mjs');
    expect(existsSync(bundle), 'run `npm run api:build` before this suite').toBe(true);
    const bundledDb = await createLiveDatabase('clibundle');
    try {
      const setup = new Client({ connectionString: bundledDb.url });
      await setup.connect();
      await migrateUp(createPgClientExecutor(setup));
      await setup.end();
      const result = spawnSync(process.execPath, [bundle, 'bootstrap'], {
        cwd: repoRoot,
        env: { ...cliEnv(bootstrapEnv()), DATABASE_URL: bundledDb.url },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
      expect(result.stdout).toContain('BOOTSTRAP COMPLETE');
      const check = new Client({ connectionString: bundledDb.url });
      await check.connect();
      try {
        const admins = await check.query<CountRow>(
          "SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin'"
        );
        expect(admins.rows[0]?.count).toBe(2);
      } finally {
        await check.end();
      }
    } finally {
      await bundledDb.close();
    }
  });
});

const holder: { shares: [string, string] } = { shares: ['', ''] };
