import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryResultRow } from '../src/db/query-executor';
import {
  createMigratedDatabase,
  expectSqlError,
  firstRow,
  type IsolatedDatabase,
} from './isolated-database';
import { seedTenant } from './fixtures';

interface CountRow extends QueryResultRow {
  count: number;
}

interface FlagRow extends QueryResultRow {
  present: boolean;
}

let db: IsolatedDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
});

afterEach(async () => {
  await db.close();
});

describe('append-only audit and ledgers', () => {
  it('accepts inserts into platform_audit and rejects UPDATE and DELETE', async () => {
    await db.executor.query(
      `INSERT INTO platform_audit (actor_ip, action, target_type, payload)
       VALUES ($1, $2, $3, $4)`,
      ['127.0.0.1', 'plan.approved', 'subscription_payment', { amount_ngwee: 9900 }]
    );
    const { rows } = await db.executor.query<{ id: number; action: string }>(
      'SELECT id, action FROM platform_audit ORDER BY id'
    );
    expect(firstRow(rows, 'audit row').action).toBe('plan.approved');

    await expectSqlError(
      db.executor.query('UPDATE platform_audit SET action = $1 WHERE id = $2', ['tampered', 1]),
      'P0001'
    );
    await expectSqlError(db.executor.query('DELETE FROM platform_audit'), 'P0001');
    const after = await db.executor.query<{ action: string }>(
      'SELECT action FROM platform_audit ORDER BY id'
    );
    expect(firstRow(after.rows, 'audit row after tamper').action).toBe('plan.approved');
  });

  it('assigns monotonic BIGSERIAL ids and preserves every audit entry', async () => {
    for (const action of ['first', 'second', 'third']) {
      await db.executor.query('INSERT INTO platform_audit (action) VALUES ($1)', [action]);
    }
    const { rows } = await db.executor.query<{ id: number; action: string }>(
      'SELECT id, action FROM platform_audit ORDER BY id'
    );
    expect(rows.map((row) => row.action)).toEqual(['first', 'second', 'third']);
    expect(Number(rows[0]?.id)).toBeLessThan(Number(rows[1]?.id));
    expect(Number(rows[1]?.id)).toBeLessThan(Number(rows[2]?.id));
  });

  it('makes stock_movements, credit_ledger_entries and change_log immutable', async () => {
    const tenant = await seedTenant(db.executor, 'append');
    await db.executor.query(
      `INSERT INTO stock_movements (shop_id, item_id, delta, balance_after, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.shopId, tenant.itemId, 5, 15, 'restock']
    );
    await db.executor.query(
      `INSERT INTO credit_ledger_entries
         (shop_id, customer_id, delta_ngwee, balance_after_ngwee, entry_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.shopId, tenant.customerId, 100, 100, 'adjustment']
    );
    await db.executor.query(
      `INSERT INTO change_log (shop_id, entity_type, entity_id, operation)
       VALUES ($1, $2, $3, $4)`,
      [tenant.shopId, 'items', tenant.itemId, 'insert']
    );

    const mutations: Array<[string, readonly unknown[]]> = [
      ['UPDATE stock_movements SET delta = $1', [99]],
      ['DELETE FROM stock_movements', []],
      ['UPDATE credit_ledger_entries SET delta_ngwee = $1', [99]],
      ['DELETE FROM credit_ledger_entries', []],
      ['UPDATE change_log SET operation = $1', ['delete']],
      ['DELETE FROM change_log', []],
    ];
    for (const [sql, values] of mutations) {
      await expectSqlError(db.executor.query(sql, values), 'P0001');
    }
    const counts = await db.executor.query<CountRow>(
      `SELECT (SELECT count(*) FROM stock_movements)::int
            + (SELECT count(*) FROM credit_ledger_entries)::int
            + (SELECT count(*) FROM change_log)::int AS count`
    );
    expect(firstRow(counts.rows, 'immutable rows').count).toBe(3);
  });

  it('does not apply deny_mutation triggers to mutable tables', async () => {
    const tenant = await seedTenant(db.executor, 'mutable');
    await db.executor.query('UPDATE items SET name = $1 WHERE id = $2', ['renamed', tenant.itemId]);
    const { rows } = await db.executor.query<{ name: string }>(
      'SELECT name FROM items WHERE id = $1',
      [tenant.itemId]
    );
    expect(firstRow(rows, 'mutable item').name).toBe('renamed');
  });
});

describe('rollback after failed transactions', () => {
  it('rolls back all DML in a failed multi-statement transaction', async () => {
    await expect(
      db.executor.transaction(async (tx) => {
        await tx.query('INSERT INTO platform_audit (action) VALUES ($1)', ['committed-never']);
        await tx.query('INSERT INTO users (display_name) VALUES ($1)', ['ok-so-far']);
        await tx.query('INSERT INTO shops (owner_user_id, name) VALUES ($1, $2)', [
          '00000000-0000-4000-8000-000000000000',
          'will-fail',
        ]);
      })
    ).rejects.toThrow();

    const audit = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM platform_audit'
    );
    expect(firstRow(audit.rows, 'audit after rollback').count).toBe(0);
    const users = await db.executor.query<CountRow>('SELECT count(*)::int AS count FROM users');
    expect(firstRow(users.rows, 'users after rollback').count).toBe(0);
  });

  it('rolls back DDL created earlier in the same transaction', async () => {
    await expect(
      db.executor.transaction(async (tx) => {
        await tx.exec('CREATE TABLE rollback_probe (id INT);');
        await tx.query('INSERT INTO rollback_probe (id) VALUES ($1)', [1]);
        await tx.query('INSERT INTO sales (shop_id, total_ngwee) VALUES ($1, $2)', [
          '00000000-0000-4000-8000-000000000000',
          10,
        ]);
      })
    ).rejects.toThrow();
    const { rows } = await db.executor.query<FlagRow>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      ['public.rollback_probe']
    );
    expect(firstRow(rows, 'rolled-back DDL').present).toBe(false);
  });

  it('commits a successful transaction and leaves the connection usable', async () => {
    const result = await db.executor.transaction(async (tx) => {
      await tx.query('INSERT INTO platform_audit (action) VALUES ($1)', ['committed']);
      const { rows } = await tx.query<CountRow>(
        'SELECT count(*)::int AS count FROM platform_audit'
      );
      return firstRow(rows, 'inside transaction').count;
    });
    expect(result).toBe(1);
    const { rows } = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM platform_audit'
    );
    expect(firstRow(rows, 'after commit').count).toBe(1);
    await expectSqlError(
      db.executor.query('INSERT INTO sales (shop_id, total_ngwee) VALUES ($1, $2)', [
        '00000000-0000-4000-8000-000000000000',
        10,
      ]),
      '23503'
    );
    const live = await db.executor.query<{ healthy: number }>('SELECT 1 AS healthy');
    expect(firstRow(live.rows, 'connection alive').healthy).toBe(1);
  });
});
