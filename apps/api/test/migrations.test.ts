import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLAN_CATALOG } from '@countup/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  getMigrationStatus,
  loadMigrations,
  migrateDown,
  migrateUp,
} from '../src/db/migrations';
import type { QueryResultRow } from '../src/db/query-executor';
import {
  createIsolatedDatabase,
  expectSqlError,
  firstRow,
  type IsolatedDatabase,
} from './isolated-database';

interface CountRow extends QueryResultRow {
  count: number;
}

interface LedgerRow extends QueryResultRow {
  version: string;
  checksum: string;
}

const EXPECTED_VERSIONS = [
  '0001_foundation',
  '0002_identity',
  '0003_shops_business',
  '0004_payments_audit',
  '0005_sync',
  '0006_ops_migration',
  '0007_m2_auth',
  '0008_m2_security_remediation',
];

let db: IsolatedDatabase;

beforeEach(async () => {
  db = await createIsolatedDatabase();
});

afterEach(async () => {
  await db.close();
});

describe('versioned migration inventory', () => {
  it('discovers eight versions, each with a non-empty up AND down script', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual(EXPECTED_VERSIONS);
    for (const migration of migrations) {
      expect(migration.upSql.trim().length).toBeGreaterThan(0);
      expect(migration.downSql.trim().length).toBeGreaterThan(0);
      expect(migration.upChecksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('applies every version in order and is idempotent', async () => {
    expect(await migrateUp(db.executor)).toEqual(EXPECTED_VERSIONS);
    expect(await migrateUp(db.executor)).toEqual([]);
    const { rows } = await db.executor.query<LedgerRow>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    expect(rows.map((row) => row.version)).toEqual(EXPECTED_VERSIONS);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('reports pending / applied / checksum mismatch through status', async () => {
    expect((await getMigrationStatus(db.executor)).every((entry) => !entry.applied)).toBe(true);
    await migrateUp(db.executor);
    expect(
      (await getMigrationStatus(db.executor)).every(
        (entry) => entry.applied && entry.checksumMatches
      )
    ).toBe(true);
    await db.executor.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
      'tampered',
      EXPECTED_VERSIONS[0],
    ]);
    const status = await getMigrationStatus(db.executor);
    expect(status[0]?.checksumMatches).toBe(false);
    await expect(migrateUp(db.executor)).rejects.toThrow(/Checksum mismatch/);
  });

  it('creates all 41 M1/M2/remediation tables plus the schema_migrations ledger', async () => {
    await migrateUp(db.executor);
    const { rows } = await db.executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(firstRow(rows, 'public table count').count).toBe(42);
    const blueprintTables = [
      'users',
      'auth_identities',
      'credentials',
      'sessions',
      'otp_challenges',
      'password_reset_tokens',
      'plans',
      'system_config',
      'shops',
      'shop_members',
      'entitlement_snapshots',
      'items',
      'stock_movements',
      'stock_conflicts',
      'sales',
      'sale_items',
      'customers',
      'credit_payments',
      'credit_ledger_entries',
      'expenses',
      'subscription_payments',
      'payment_reference_locks',
      'payment_proofs',
      'platform_audit',
      'provider_events',
      'idempotency_keys',
      'sync_operations',
      'sync_conflict_reviews',
      'change_log',
      'migration_runs',
      'migration_shop_results',
      'legacy_id_map',
      'cutover_config',
      'backup_runs',
      'restore_drills',
      'export_jobs',
      'identity_verifications',
      'rate_limit_buckets',
      'refresh_token_history',
      'platform_bootstrap',
      'admin_recovery_grants',
    ];
    for (const table of blueprintTables) {
      const result = await db.executor.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`public.${table}`]
      );
      expect(firstRow(result.rows, table).present, `missing table ${table}`).toBe(true);
    }
  });
});

describe('up -> down -> up', () => {
  it('rolls back all eight versions in reverse order and re-applies cleanly', async () => {
    expect(await migrateUp(db.executor)).toEqual(EXPECTED_VERSIONS);

    const rolledBack: string[] = [];
    for (let index = 0; index < EXPECTED_VERSIONS.length; index += 1) {
      const version = await migrateDown(db.executor);
      if (version !== undefined) {
        rolledBack.push(version);
      }
    }
    expect(rolledBack).toEqual([...EXPECTED_VERSIONS].reverse());
    expect(await migrateDown(db.executor)).toBeUndefined();

    const remaining = await db.executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(firstRow(remaining.rows, 'tables after full rollback').count).toBe(1);
    const ledger = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM schema_migrations'
    );
    expect(firstRow(ledger.rows, 'ledger after full rollback').count).toBe(0);

    expect(await migrateUp(db.executor)).toEqual(EXPECTED_VERSIONS);
    const restored = await db.executor.query<CountRow>(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(firstRow(restored.rows, 'tables after re-apply').count).toBe(42);
  });

  it('keeps seeded data identical after a full down/up cycle', async () => {
    await migrateUp(db.executor);
    for (let index = 0; index < EXPECTED_VERSIONS.length; index += 1) {
      await migrateDown(db.executor);
    }
    await migrateUp(db.executor);
    const { rows } = await db.executor.query<{
      plan_id: string;
      months: number;
      price_ngwee: number;
    }>('SELECT plan_id, months, price_ngwee FROM plans ORDER BY plan_id');
    expect(rows.map((row) => [row.plan_id, row.months, row.price_ngwee])).toEqual([
      ['biannual', PLAN_CATALOG.biannual.months, PLAN_CATALOG.biannual.priceNgwee],
      ['monthly', PLAN_CATALOG.monthly.months, PLAN_CATALOG.monthly.priceNgwee],
      ['quarterly', PLAN_CATALOG.quarterly.months, PLAN_CATALOG.quarterly.priceNgwee],
    ]);
  });
});

describe('transactional failures', () => {
  it('rolls back DDL and the ledger row when a migration statement fails', async () => {
    const failures = await loadMigrations();
    expect(failures.length).toBe(8);

    // Inject a deliberately broken statement into a copy of migration 0001.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'countup-migrations-'));
    try {
      for (const file of await readdir(DEFAULT_MIGRATIONS_DIR)) {
        await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(tempDir, file));
      }
      const upPath = path.join(tempDir, '0001_foundation.up.sql');
      const original = await readFile(upPath, 'utf8');
      await writeFile(
        upPath,
        `${original}\nINSERT INTO system_config (key, value) VALUES ('dup', '1');\nINSERT INTO system_config (key, value) VALUES ('dup', '2');\n`
      );

      await expect(migrateUp(db.executor, tempDir)).rejects.toThrow();
      const tables = await db.executor.query<CountRow>(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
      );
      expect(firstRow(tables.rows, 'tables after failed migration').count).toBe(1);
      const ledger = await db.executor.query<CountRow>(
        'SELECT count(*)::int AS count FROM schema_migrations'
      );
      expect(firstRow(ledger.rows, 'ledger after failed migration').count).toBe(0);
      await expectSqlError(db.executor.query('SELECT 1 FROM system_config LIMIT 1'), '42P01');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rolls back earlier DML in the same explicit transaction', async () => {
    await migrateUp(db.executor);
    await expect(
      db.executor.transaction(async (tx) => {
        await tx.query('INSERT INTO platform_audit (action) VALUES ($1)', ['before']);
        await tx.query('INSERT INTO users (role) VALUES ($1)', ['not_a_role']);
      })
    ).rejects.toThrow();
    const { rows } = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM platform_audit'
    );
    expect(firstRow(rows, 'audit rows after rollback').count).toBe(0);
  });
});
