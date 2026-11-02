import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface LiveDatabase {
  adminUrl: string;
  url: string;
  databaseName: string;
  close(): Promise<void>;
}

/**
 * The live suite requires an explicitly supplied ADMIN connection URL for a real
 * PostgreSQL server. It refuses non-loopback hosts unless the operator sets
 * COUNTUP_ALLOW_REMOTE_TEST_DB=1, and refuses to use the same URL as DATABASE_URL.
 * This is a hard guard against pointing validation at a production database.
 */
export function requireLiveAdminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is required for live PostgreSQL validation. It must be an admin URL for an isolated, disposable test server (e.g. postgresql://postgres@127.0.0.1:55432/postgres).'
    );
  }
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && process.env.COUNTUP_ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(
      `Refusing to run live validation against non-loopback host "${parsed.hostname}". Set COUNTUP_ALLOW_REMOTE_TEST_DB=1 only for an explicitly isolated test server.`
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
  }
  return url;
}

function safeIdentifier(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** Creates and later drops a brand-new, empty database on the real server. */
export async function createLiveDatabase(label: string): Promise<LiveDatabase> {
  const adminUrl = requireLiveAdminUrl();
  const databaseName = `countup_${safeIdentifier(label)}_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const urlObject = new URL(adminUrl);
  urlObject.pathname = `/${databaseName}`;
  const url = urlObject.toString();

  return {
    adminUrl,
    url,
    databaseName,
    async close() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [databaseName]
        );
        await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function expectSqlState(
  statement: Promise<unknown>,
  expectedCode: string
): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    if (actual !== expectedCode) {
      throw new Error(`Expected SQLSTATE ${expectedCode}, got ${String(actual)}: ${String(error)}`);
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected SQLSTATE ${expectedCode}, but the statement succeeded`);
}
