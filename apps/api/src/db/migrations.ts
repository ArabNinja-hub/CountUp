import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryExecutor, QueryResultRow } from './query-executor';

const UP_SUFFIX = '.up.sql';
const DOWN_SUFFIX = '.down.sql';
const VERSION_PATTERN = /^\d{4}_[a-z0-9_]+$/;

/**
 * Repo-root /migrations, found by walking up from the MODULE directory.
 * A fixed `../../../../` path only works for the unbundled source
 * (`src/db/migrations.ts`); the esbuild bundle lives in `apps/api/dist/` and
 * would otherwise resolve to `/home/user/migrations`. Walking up makes the
 * migration runner work under `tsx`, under vitest AND from the built CLI bundle.
 */
function findMigrationsDir(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(directory, 'migrations');
    if (existsSync(path.join(candidate, '0001_foundation.up.sql'))) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('Cannot locate the versioned migrations directory');
}

export const DEFAULT_MIGRATIONS_DIR = findMigrationsDir();

export interface Migration {
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  upChecksum: string;
}

export interface MigrationRecord {
  version: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  applied: boolean;
  checksumMatches: boolean;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const versions = entries
    .filter((entry) => entry.endsWith(UP_SUFFIX))
    .map((entry) => entry.slice(0, -UP_SUFFIX.length))
    .sort();

  return Promise.all(
    versions.map(async (version) => {
      if (!VERSION_PATTERN.test(version)) {
        throw new Error(`Invalid migration version: ${version}`);
      }
      const upPath = path.join(dir, `${version}${UP_SUFFIX}`);
      const downPath = path.join(dir, `${version}${DOWN_SUFFIX}`);
      let upSql: string;
      let downSql: string;
      try {
        [upSql, downSql] = await Promise.all([
          readFile(upPath, 'utf8'),
          readFile(downPath, 'utf8'),
        ]);
      } catch (error) {
        throw new Error(
          `Migration ${version} must have both ${UP_SUFFIX} and ${DOWN_SUFFIX}: ${String(error)}`
        );
      }
      if (upSql.trim().length === 0 || downSql.trim().length === 0) {
        throw new Error(`Migration ${version} has an empty up or down script`);
      }
      return {
        version,
        name: version.replace(/^\d+_/, ''),
        upSql,
        downSql,
        upChecksum: checksum(upSql),
      };
    })
  );
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
`;

export async function ensureMigrationLedger(executor: QueryExecutor): Promise<void> {
  await executor.exec(LEDGER_DDL);
}

interface AppliedRow extends QueryResultRow {
  version: string;
  checksum: string;
}

export async function fetchApplied(executor: QueryExecutor): Promise<Map<string, MigrationRecord>> {
  const { rows } = await executor.query<AppliedRow>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version'
  );
  return new Map(
    rows.map((row) => [row.version, { version: row.version, checksum: row.checksum }])
  );
}

export async function getMigrationStatus(
  executor: QueryExecutor,
  dir?: string
): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  await ensureMigrationLedger(executor);
  const applied = await fetchApplied(executor);
  return migrations.map((migration) => {
    const record = applied.get(migration.version);
    return {
      version: migration.version,
      applied: record !== undefined,
      checksumMatches: record === undefined || record.checksum === migration.upChecksum,
    };
  });
}

/**
 * Apply every pending migration, each in its own transaction (DDL is transactional in
 * PostgreSQL). A failed statement rolls the whole version back, including DDL.
 */
export async function migrateUp(executor: QueryExecutor, dir?: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  await ensureMigrationLedger(executor);
  const applied = await fetchApplied(executor);
  const appliedNow: string[] = [];

  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record !== undefined) {
      if (record.checksum !== migration.upChecksum) {
        throw new Error(
          `Checksum mismatch for ${migration.version}: applied ${record.checksum}, file ${migration.upChecksum}. Applied migrations are immutable.`
        );
      }
      continue;
    }
    await executor.transaction(async (tx) => {
      await tx.exec(migration.upSql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        migration.version,
        migration.upChecksum,
      ]);
    });
    appliedNow.push(migration.version);
  }
  return appliedNow;
}

/** Roll back exactly the most recently applied migration. */
export async function migrateDown(
  executor: QueryExecutor,
  dir?: string
): Promise<string | undefined> {
  const migrations = await loadMigrations(dir);
  await ensureMigrationLedger(executor);
  const applied = await fetchApplied(executor);
  const pending = migrations.filter((migration) => applied.has(migration.version));
  const target = pending.at(-1);
  if (target === undefined) {
    return undefined;
  }
  await executor.transaction(async (tx) => {
    await tx.exec(target.downSql);
    await tx.query('DELETE FROM schema_migrations WHERE version = $1', [target.version]);
  });
  return target.version;
}
