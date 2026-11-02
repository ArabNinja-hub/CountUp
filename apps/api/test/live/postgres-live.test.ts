import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadEnv } from '../../src/config/env';
import {
  getMigrationStatus,
  loadMigrations,
  migrateDown,
  migrateUp,
} from '../../src/db/migrations';
import {
  createPgClientExecutor,
  createPgPoolExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { seedTenant } from '../fixtures';
import { createLiveDatabase, expectSqlState, type LiveDatabase } from './live-database';

interface CountRow extends QueryResultRow {
  count: number;
}

interface VersionRow extends QueryResultRow {
  version: string;
  server_version: string;
}

const EXPECTED_VERSIONS = [
  '0001_foundation',
  '0002_identity',
  '0003_shops_business',
  '0004_payments_audit',
  '0005_sync',
  '0006_ops_migration',
];

const EXPECTED_TABLES = [
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
];

const EXPECTED_ENUMS = [
  'user_role',
  'user_status',
  'shop_role',
  'identity_kind',
  'plan_status',
  'plan_type',
  'payment_type',
  'momo_operator',
  'payment_method',
  'stock_movement_type',
  'stock_conflict_kind',
  'expense_category',
  'payment_network',
  'payment_status',
  'sync_decision',
  'idempotency_status',
  'migration_status',
  'cutover_mode',
];

let live: LiveDatabase;
let client: Client;
let executor: QueryExecutor;

beforeAll(async () => {
  live = await createLiveDatabase('validation');
  client = new Client({ connectionString: live.url });
  await client.connect();
  executor = createPgClientExecutor(client);
});

afterAll(async () => {
  await client.end();
  await live.close();
});

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await executor.query<CountRow>(sql, values);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('count query returned no rows');
  }
  return row.count;
}

// These `it` blocks intentionally run in declaration order: they form one sequential
// validation run on ONE disposable database (empty -> up -> down -> up -> behaviour).
describe('A2 — live PostgreSQL validation', () => {
  it('1. the actual pg driver connects to a real PostgreSQL 18 server', async () => {
    const { rows } = await executor.query<VersionRow>(
      'SELECT version() AS version, current_setting($1) AS server_version',
      ['server_version']
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.version).toContain('PostgreSQL 18.6');
    expect(row?.server_version).toMatch(/^18\./);
    const db = await executor.query<{ current_database: string }>(
      'SELECT current_database() AS current_database'
    );
    expect(db.rows[0]?.current_database).toBe(live.databaseName);
  });

  it('2. the migration runner applies all six migrations to an empty database', async () => {
    expect(
      await count("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'")
    ).toBe(0);
    const applied = await migrateUp(executor);
    expect(applied).toEqual(EXPECTED_VERSIONS);
    expect(
      await count("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'")
    ).toBe(37);
  });

  it('3. all expected tables, enums, constraints, indexes and triggers exist', async () => {
    for (const table of EXPECTED_TABLES) {
      const result = await executor.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`public.${table}`]
      );
      expect(result.rows[0]?.present, `missing table ${table}`).toBe(true);
    }
    const enums = await executor.query<{ typname: string }>(
      "SELECT typname FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace ORDER BY typname"
    );
    expect(enums.rows.map((row) => row.typname).sort()).toEqual([...EXPECTED_ENUMS].sort());

    expect(
      await count(
        "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace"
      )
    ).toBe(60);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id,%'"
      )
    ).toBe(13);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace"
      )
    ).toBe(51);
    expect(
      await count("SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'")
    ).toBe(113);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) AND NOT tgisinternal"
      )
    ).toBe(12);
    const functions = await executor.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname"
    );
    expect(functions.rows.map((row) => row.proname)).toEqual([
      'deny_mutation',
      'set_local_date',
      'set_updated_at',
    ]);
    expect(await count('SELECT count(*)::int AS count FROM pg_policies')).toBe(0);
  });

  it('4. migration checksums are recorded correctly in PostgreSQL', async () => {
    const migrations = await loadMigrations();
    const ledger = await executor.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    expect(ledger.rows).toHaveLength(6);
    expect(ledger.rows.map((row) => row.version)).toEqual(EXPECTED_VERSIONS);
    for (const migration of migrations) {
      const record = ledger.rows.find((row) => row.version === migration.version);
      expect(record?.checksum).toBe(migration.upChecksum);
      expect(record?.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(
      (await getMigrationStatus(executor)).every((entry) => entry.applied && entry.checksumMatches)
    ).toBe(true);
  });

  it('5. running migrations a second time is safe and changes nothing', async () => {
    const before = {
      tables: await count(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
      ),
      indexes: await count(
        "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'"
      ),
      ledger: await count('SELECT count(*)::int AS count FROM schema_migrations'),
      plans: await count('SELECT count(*)::int AS count FROM plans'),
    };
    expect(await migrateUp(executor)).toEqual([]);
    const after = {
      tables: await count(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
      ),
      indexes: await count(
        "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'"
      ),
      ledger: await count('SELECT count(*)::int AS count FROM schema_migrations'),
      plans: await count('SELECT count(*)::int AS count FROM plans'),
    };
    expect(after).toEqual(before);
    expect(after.plans).toBe(3);
  });

  it('6. all down migrations execute in reverse order', async () => {
    const rolledBack: string[] = [];
    for (let index = 0; index < EXPECTED_VERSIONS.length; index += 1) {
      const version = await migrateDown(executor);
      if (version !== undefined) {
        rolledBack.push(version);
      }
    }
    expect(rolledBack).toEqual([...EXPECTED_VERSIONS].reverse());
    expect(await migrateDown(executor)).toBeUndefined();
    expect(
      await count("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'")
    ).toBe(1);
    expect(await count('SELECT count(*)::int AS count FROM schema_migrations')).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace"
      )
    ).toBe(0);
  });

  it('7. all up migrations execute again successfully after the full rollback', async () => {
    expect(await migrateUp(executor)).toEqual(EXPECTED_VERSIONS);
    expect(
      await count("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'")
    ).toBe(37);
    // NOTE: real `pg` returns int8/BIGINT as a STRING (to avoid precision loss),
    // while PGlite returned a JS number. Compare as text so the assertion is
    // driver-agnostic; see the dedicated compatibility test below.
    const plans = await executor.query<{ price_ngwee: string }>(
      'SELECT price_ngwee::text AS price_ngwee FROM plans ORDER BY plan_id'
    );
    expect(plans.rows.map((row) => row.price_ngwee)).toEqual(['49900', '9900', '26900']);
  });

  it('7b. documents the real pg int8/BIGINT parser difference vs PGlite', async () => {
    const raw = await executor.query<{ value: unknown }>('SELECT 9900::bigint AS value');
    const value = raw.rows[0]?.value;
    // node-postgres deliberately returns int8 as a string. Code that reads BIGINT
    // money columns must parse it explicitly (BigInt / Number) rather than assume
    // a JS number, otherwise arithmetic silently concatenates.
    expect(typeof value).toBe('string');
    expect(String(value)).toBe('9900');
    const count = await executor.query<{ value: unknown }>(
      'SELECT count(*)::int AS value FROM plans'
    );
    expect(typeof count.rows[0]?.value).toBe('number');
  });

  it('8. cross-shop composite foreign keys reject invalid references', async () => {
    const shopA = await seedTenant(executor, 'liveA');
    const shopB = await seedTenant(executor, 'liveB');
    await expectSqlState(
      executor.query(
        `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shopB.shopId, shopA.saleId, shopB.itemId, 1, 1000, 1000]
      ),
      '23503'
    );
    await expectSqlState(
      executor.query(
        `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shopB.shopId, shopB.saleId, shopA.itemId, 1, 1000, 1000]
      ),
      '23503'
    );
    const valid = await executor.query<{ id: string }>(
      `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [shopB.shopId, shopB.saleId, shopB.itemId, 1, 1000, 1000]
    );
    expect(valid.rows[0]?.id).toBeTypeOf('string');
  });

  it('9. append-only triggers reject UPDATE and DELETE', async () => {
    await executor.query('INSERT INTO platform_audit (action) VALUES ($1)', ['live.check']);
    await executor.query(
      'INSERT INTO change_log (entity_type, entity_id, operation) VALUES ($1, $2, $3)',
      ['items', 'live-1', 'insert']
    );
    const mutations: Array<[string, readonly unknown[]]> = [
      ['UPDATE platform_audit SET action = $1', ['tampered']],
      ['DELETE FROM platform_audit', []],
      ['UPDATE change_log SET operation = $1', ['delete']],
      ['DELETE FROM change_log', []],
    ];
    for (const [sql, values] of mutations) {
      await expectSqlState(executor.query(sql, values), 'P0001');
    }
    expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(1);
    expect(await count('SELECT count(*)::int AS count FROM change_log')).toBe(1);
  });

  it('10. failed transactions roll back DML and DDL', async () => {
    await expect(
      executor.transaction(async (tx) => {
        await tx.query('INSERT INTO platform_audit (action) VALUES ($1)', ['rolled-back']);
        await tx.query('INSERT INTO shops (owner_user_id, name) VALUES ($1, $2)', [
          '00000000-0000-4000-8000-000000000000',
          'invalid-parent',
        ]);
      })
    ).rejects.toThrow();
    expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(1);

    await expect(
      executor.transaction(async (tx) => {
        await tx.exec('CREATE TABLE live_rollback_probe (id INT);');
        await tx.query('INSERT INTO live_rollback_probe (id) VALUES ($1)', [1]);
        await tx.query('INSERT INTO sales (shop_id, total_ngwee) VALUES ($1, $2)', [
          '00000000-0000-4000-8000-000000000000',
          10,
        ]);
      })
    ).rejects.toThrow();
    const probe = await executor.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      ['public.live_rollback_probe']
    );
    expect(probe.rows[0]?.present).toBe(false);
    const alive = await executor.query<{ healthy: number }>('SELECT 1 AS healthy');
    expect(alive.rows[0]?.healthy).toBe(1);
  });

  it('11. connection acquisition, release and pool shutdown work correctly', async () => {
    const pool = new Pool({ connectionString: live.url, max: 2 });
    const poolExecutor = createPgPoolExecutor(pool);
    expect(pool.totalCount).toBe(0);

    const borrowed = await pool.connect();
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(0);
    borrowed.release();
    expect(pool.idleCount).toBe(1);

    const result = await poolExecutor.transaction(async (tx) => {
      const { rows } = await tx.query<{ database: string }>(
        'SELECT current_database() AS database'
      );
      return rows[0]?.database;
    });
    expect(result).toBe(live.databaseName);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBeGreaterThanOrEqual(1);

    await expect(
      poolExecutor.transaction(async (tx) => {
        await tx.query('INSERT INTO platform_audit (action) VALUES ($1)', ['pool-rollback']);
        await tx.query('INSERT INTO users (role) VALUES ($1)', ['not_a_role']);
      })
    ).rejects.toThrow();
    expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(1);

    await pool.end();
    expect(pool.totalCount).toBe(0);
    await expect(poolExecutor.query('SELECT 1')).rejects.toThrow();
  });

  it('12. the API uses the actual PostgreSQL adapter, not PGlite', async () => {
    const pool = new Pool({ connectionString: live.url, max: 2 });
    const poolExecutor = createPgPoolExecutor(pool);
    const app = createApp({ env: loadEnv({ NODE_ENV: 'test' }), db: poolExecutor });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        throw new Error('failed to bind');
      }
      const base = `http://127.0.0.1:${address.port}`;
      const liveResponse = await fetch(`${base}/health/live`);
      expect(liveResponse.status).toBe(200);
      const ready = await fetch(`${base}/health/ready?verbose=1`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ready', environment: 'test' });

      const { rows } = await poolExecutor.query<{ database: string; port: number }>(
        'SELECT current_database() AS database, inet_server_port() AS port'
      );
      expect(rows[0]?.database).toBe(live.databaseName);
      expect(rows[0]?.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  });
});
