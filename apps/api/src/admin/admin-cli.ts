/**
 * Offline administrator bootstrap / break-glass CLI (C-02).
 *
 *   npm run admin:bootstrap   # one-time, creates >=2 platform admins + 2 shares
 *   npm run admin:recover     # dual-control password reset for the bootstrap admin
 *
 * Credentials and shares are read from the environment (or a secret manager that
 * injects env vars), NEVER from argv, NEVER from a committed file. The CLI prints
 * the recovery shares exactly once; only SHA-256 digests are stored in PostgreSQL.
 * It refuses to run until all versioned migrations are applied and refuses a
 * second bootstrap. Every attempt is recorded in the append-only audit table.
 */
import { Client } from 'pg';
import { AdminBootstrapService } from '../auth/admin-bootstrap';
import { PasswordHasher } from '../auth/password';
import { resolveSecrets } from '../auth/secrets';
import { loadEnv } from '../config/env';
import { getMigrationStatus } from '../db/migrations';
import {
  createPgClientExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../db/query-executor';

const BOOTSTRAP_CONFIRM = 'I_UNDERSTAND_THIS_CREATES_PLATFORM_ADMINS';
const RECOVERY_CONFIRM = 'I_UNDERSTAND_THIS_RESETS_THE_BOOTSTRAP_ADMIN_PASSWORD';

interface CountRow extends QueryResultRow {
  count: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function printShares(label: string, shares: readonly [string, string]): void {
  process.stdout.write(`\n[countup-admin] ${label}\n`);
  process.stdout.write(
    '[countup-admin] These two shares are shown ONCE. Store them with two different custodians,\n' +
      '[countup-admin] in a secret manager. They are never stored in the database or in Git.\n\n'
  );
  process.stdout.write(`COUNTUP_RECOVERY_SHARE_A=${shares[0]}\n`);
  process.stdout.write(`COUNTUP_RECOVERY_SHARE_B=${shares[1]}\n\n`);
}

async function assertSchemaReady(executor: QueryExecutor): Promise<void> {
  const status = await getMigrationStatus(executor);
  if (status.length === 0 || status.some((entry) => !entry.applied || !entry.checksumMatches)) {
    throw new Error('Database schema is not current. Run `npm run db:migrate` first.');
  }
}

async function assertNoUnrecordedAdmins(executor: QueryExecutor): Promise<void> {
  // Only refuse when admins were created by hand (no bootstrap record). A
  // repeated bootstrap is allowed through so the service can reject and AUDIT it.
  const { rows } = await executor.query<CountRow>(
    `SELECT (SELECT count(*)::int FROM users WHERE role = 'platform_admin') AS count,
            (SELECT count(*)::int FROM platform_bootstrap) AS bootstrapped`
  );
  if ((rows[0]?.count ?? 0) > 0 && (rows[0]?.bootstrapped ?? 0) === 0) {
    throw new Error(
      'platform_admin accounts already exist but bootstrap was not recorded. Refusing to proceed.'
    );
  }
}

async function bootstrap(service: AdminBootstrapService): Promise<void> {
  if (required('COUNTUP_BOOTSTRAP_CONFIRM') !== BOOTSTRAP_CONFIRM) {
    throw new Error('COUNTUP_BOOTSTRAP_CONFIRM has the wrong value');
  }
  const result = await service.bootstrap({
    confirm: true,
    admins: [
      {
        email: required('COUNTUP_BOOTSTRAP_ADMIN_EMAIL'),
        password: required('COUNTUP_BOOTSTRAP_ADMIN_PASSWORD'),
        displayName: process.env.COUNTUP_BOOTSTRAP_ADMIN_DISPLAY_NAME ?? 'Bootstrap Admin 1',
      },
      {
        email: required('COUNTUP_BOOTSTRAP_ADMIN2_EMAIL'),
        password: required('COUNTUP_BOOTSTRAP_ADMIN2_PASSWORD'),
        displayName: process.env.COUNTUP_BOOTSTRAP_ADMIN2_DISPLAY_NAME ?? 'Bootstrap Admin 2',
      },
    ],
  });
  process.stdout.write(
    `[countup-admin] created ${result.adminUserIds.length} platform admins; ` +
      `primary=${result.primaryAdminUserId}\n`
  );
  process.stdout.write(`[countup-admin] grant expires ${result.expiresAt.toISOString()}\n`);
  printShares('BOOTSTRAP COMPLETE', result.recoveryShares);
}

async function recover(service: AdminBootstrapService): Promise<void> {
  if (required('COUNTUP_RECOVERY_CONFIRM') !== RECOVERY_CONFIRM) {
    throw new Error('COUNTUP_RECOVERY_CONFIRM has the wrong value');
  }
  const result = await service.recover({
    confirm: true,
    shareA: required('COUNTUP_RECOVERY_SHARE_A'),
    shareB: required('COUNTUP_RECOVERY_SHARE_B'),
    newPassword: required('COUNTUP_RECOVERY_NEW_PASSWORD'),
  });
  process.stdout.write(
    `[countup-admin] break-glass recovery completed for ${result.userId}; ` +
      'all sessions revoked, session_version bumped\n'
  );
  printShares('NEW SINGLE-USE SHARES (old shares are now worthless)', result.recoveryShares);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'bootstrap' && command !== 'recover') {
    throw new Error('Usage: admin-cli <bootstrap|recover>');
  }
  const env = loadEnv();
  const { pepper } = resolveSecrets(env);
  if (env.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required (an isolated, operator-controlled database)');
  }
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const executor = createPgClientExecutor(client);
    await assertSchemaReady(executor);
    const service = new AdminBootstrapService(executor, new PasswordHasher(pepper));
    if (command === 'bootstrap') {
      await assertNoUnrecordedAdmins(executor);
      await bootstrap(service);
    } else {
      await recover(service);
    }
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[countup-admin] FAILED: ${message}\n`);
  process.exitCode = 1;
});
