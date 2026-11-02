import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryResultRow } from '../src/db/query-executor';
import {
  createMigratedDatabase,
  expectSqlError,
  firstRow,
  type IsolatedDatabase,
} from './isolated-database';
import { seedTenant, type Tenant } from './fixtures';

interface CountRow extends QueryResultRow {
  count: number;
}

interface NameRow extends QueryResultRow {
  table_name: string;
}

const TENANT_TABLES = [
  'change_log',
  'credit_ledger_entries',
  'credit_payments',
  'customers',
  'entitlement_snapshots',
  'expenses',
  'export_jobs',
  'idempotency_keys',
  'items',
  'legacy_id_map',
  'migration_shop_results',
  'payment_proofs',
  'payment_reference_locks',
  'platform_audit',
  'sale_items',
  'sales',
  'shop_members',
  'stock_conflicts',
  'stock_movements',
  'subscription_payments',
  'sync_conflict_reviews',
  'sync_operations',
];

const SCOPE_PARENTS = [
  'credit_payments',
  'customers',
  'items',
  'sales',
  'subscription_payments',
  'sync_operations',
];

let db: IsolatedDatabase;
let shopA: Tenant;
let shopB: Tenant;
let paymentAId: string;
let paymentBId: string;
let creditPaymentAId: string;
let syncOpAId: string;
let syncOpBId: string;

beforeEach(async () => {
  db = await createMigratedDatabase();
  shopA = await seedTenant(db.executor, 'A');
  shopB = await seedTenant(db.executor, 'B');

  const insertPayment = async (tenant: Tenant, reference: string): Promise<string> => {
    const { rows } = await db.executor.query<{ id: string }>(
      `INSERT INTO subscription_payments
         (shop_id, user_id, plan_id, amount_ngwee, reference)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant.shopId, tenant.userId, 'monthly', 9900, reference]
    );
    return firstRow(rows, `payment ${reference}`).id;
  };
  paymentAId = await insertPayment(shopA, 'REF-A');
  paymentBId = await insertPayment(shopB, 'REF-B');

  const creditPayment = await db.executor.query<{ id: string }>(
    'INSERT INTO credit_payments (shop_id, customer_id, amount_ngwee) VALUES ($1, $2, $3) RETURNING id',
    [shopA.shopId, shopA.customerId, 500]
  );
  creditPaymentAId = firstRow(creditPayment.rows, 'credit payment A').id;

  const insertSyncOp = async (tenant: Tenant, clientId: string): Promise<string> => {
    const { rows } = await db.executor.query<{ id: string }>(
      `INSERT INTO sync_operations (shop_id, device_id, client_operation_id, operation_type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.shopId, 'device-1', clientId, 'sale.create']
    );
    return firstRow(rows, `sync op ${clientId}`).id;
  };
  syncOpAId = await insertSyncOp(shopA, 'op-A');
  syncOpBId = await insertSyncOp(shopB, 'op-B');
});

afterEach(async () => {
  await db.close();
});

describe('schema-level tenant containment', () => {
  it('gives every tenant table a shop_id column and a direct FK to shops(id)', async () => {
    const { rows } = await db.executor.query<NameRow>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'shop_id' ORDER BY table_name`
    );
    expect(rows.map((row) => row.table_name)).toEqual(TENANT_TABLES);

    for (const table of TENANT_TABLES) {
      const result = await db.executor.query<CountRow>(
        `SELECT count(*)::int AS count FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype = 'f'
            AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id) REFERENCES shops(id)%'`,
        [`public.${table}`]
      );
      expect(
        firstRow(result.rows, `shops FK on ${table}`).count,
        `${table} must have a direct FK to shops(id)`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('exposes UNIQUE (shop_id, id) on every parent used by a composite FK', async () => {
    for (const table of SCOPE_PARENTS) {
      const result = await db.executor.query<CountRow>(
        `SELECT count(*)::int AS count FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%UNIQUE (shop_id, id)%'`,
        [`public.${table}`]
      );
      expect(
        firstRow(result.rows, `scope unique on ${table}`).count,
        `${table} needs UNIQUE (shop_id, id)`
      ).toBe(1);
    }
    const composite = await db.executor.query<CountRow>(
      `SELECT count(*)::int AS count FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace
          AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id,%'`
    );
    expect(firstRow(composite.rows, 'composite tenant FKs').count).toBe(13);
  });

  it('does NOT enable RLS (ADR-11 is provisional and not approved)', async () => {
    const { rows } = await db.executor.query<CountRow>(
      `SELECT count(*)::int AS count FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relrowsecurity`
    );
    expect(firstRow(rows, 'RLS-enabled tables').count).toBe(0);
    const policies = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM pg_policies'
    );
    expect(firstRow(policies.rows, 'RLS policies').count).toBe(0);
  });
});

interface CrossShopCase {
  label: string;
  sql: string;
  values: readonly unknown[];
}

function crossShopCases(): CrossShopCase[] {
  const B = shopB.shopId;
  const A = shopA;
  return [
    {
      label: 'sale_items -> sales',
      sql: `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, A.saleId, shopB.itemId, 1, 1000, 1000],
    },
    {
      label: 'sale_items -> items',
      sql: `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, shopB.saleId, A.itemId, 1, 1000, 1000],
    },
    {
      label: 'sales -> customers',
      sql: 'INSERT INTO sales (shop_id, customer_id, total_ngwee) VALUES ($1, $2, $3)',
      values: [B, A.customerId, 1000],
    },
    {
      label: 'credit_payments -> customers',
      sql: 'INSERT INTO credit_payments (shop_id, customer_id, amount_ngwee) VALUES ($1, $2, $3)',
      values: [B, A.customerId, 1000],
    },
    {
      label: 'credit_ledger_entries -> customers',
      sql: `INSERT INTO credit_ledger_entries
              (shop_id, customer_id, delta_ngwee, balance_after_ngwee, entry_type)
            VALUES ($1, $2, $3, $4, $5)`,
      values: [B, A.customerId, 100, 100, 'adjustment'],
    },
    {
      label: 'credit_ledger_entries -> credit_payments',
      sql: `INSERT INTO credit_ledger_entries
              (shop_id, customer_id, credit_payment_id, delta_ngwee, balance_after_ngwee, entry_type)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, shopB.customerId, creditPaymentAId, -100, 0, 'payment'],
    },
    {
      label: 'credit_ledger_entries -> sales',
      sql: `INSERT INTO credit_ledger_entries
              (shop_id, customer_id, sale_id, delta_ngwee, balance_after_ngwee, entry_type)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, shopB.customerId, A.saleId, 100, 100, 'sale'],
    },
    {
      label: 'stock_movements -> items',
      sql: `INSERT INTO stock_movements (shop_id, item_id, delta, balance_after, reason)
            VALUES ($1, $2, $3, $4, $5)`,
      values: [B, A.itemId, 1, 1, 'restock'],
    },
    {
      label: 'stock_movements -> sales',
      sql: `INSERT INTO stock_movements (shop_id, item_id, delta, balance_after, reason, related_sale_id)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, shopB.itemId, 1, 1, 'sale', A.saleId],
    },
    {
      label: 'stock_conflicts -> items',
      sql: 'INSERT INTO stock_conflicts (shop_id, item_id, kind) VALUES ($1, $2, $3)',
      values: [B, A.itemId, 'negative_stock'],
    },
    {
      label: 'stock_conflicts -> sales',
      sql: 'INSERT INTO stock_conflicts (shop_id, related_sale_id, kind) VALUES ($1, $2, $3)',
      values: [B, A.saleId, 'duplicate_sale'],
    },
    {
      label: 'payment_proofs -> subscription_payments',
      sql: `INSERT INTO payment_proofs
              (shop_id, payment_id, storage_key, mime_type, size_bytes, sha256)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      values: [B, paymentAId, 'proofs/cross-shop', 'image/png', 1024, 'a'.repeat(64)],
    },
    {
      label: 'sync_conflict_reviews -> sync_operations',
      sql: 'INSERT INTO sync_conflict_reviews (shop_id, sync_operation_id, decision) VALUES ($1, $2, $3)',
      values: [B, syncOpAId, 'reject'],
    },
  ];
}

describe('cross-shop references are rejected by the database', () => {
  it('rejects all 13 composite-FK cross-shop attempts with SQLSTATE 23503', async () => {
    const cases = crossShopCases();
    expect(cases).toHaveLength(13);
    for (const testCase of cases) {
      await expectSqlError(db.executor.query(testCase.sql, testCase.values), '23503').catch(
        (error: unknown) => {
          throw new Error(`${testCase.label}: ${String(error)}`);
        }
      );
    }
  });

  it('accepts the same 13 relationships when both sides belong to one shop', async () => {
    const B = shopB;
    const paymentB = paymentBId;
    const syncOpB = syncOpBId;
    const valid: CrossShopCase[] = [
      {
        label: 'sale_items',
        sql: `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        values: [B.shopId, B.saleId, B.itemId, 1, 1000, 1000],
      },
      {
        label: 'sales',
        sql: 'INSERT INTO sales (shop_id, customer_id, total_ngwee) VALUES ($1, $2, $3)',
        values: [B.shopId, B.customerId, 1000],
      },
      {
        label: 'credit_payments',
        sql: 'INSERT INTO credit_payments (shop_id, customer_id, amount_ngwee) VALUES ($1, $2, $3) RETURNING id',
        values: [B.shopId, B.customerId, 1000],
      },
      {
        label: 'credit_ledger_entries',
        sql: `INSERT INTO credit_ledger_entries
                (shop_id, customer_id, delta_ngwee, balance_after_ngwee, entry_type)
              VALUES ($1, $2, $3, $4, $5)`,
        values: [B.shopId, B.customerId, 100, 100, 'adjustment'],
      },
      {
        label: 'stock_movements',
        sql: `INSERT INTO stock_movements (shop_id, item_id, delta, balance_after, reason, related_sale_id)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        values: [B.shopId, B.itemId, 1, 1, 'sale', B.saleId],
      },
      {
        label: 'stock_conflicts',
        sql: 'INSERT INTO stock_conflicts (shop_id, item_id, related_sale_id, kind) VALUES ($1, $2, $3, $4)',
        values: [B.shopId, B.itemId, B.saleId, 'duplicate_sale'],
      },
      {
        label: 'payment_proofs',
        sql: `INSERT INTO payment_proofs
                (shop_id, payment_id, storage_key, mime_type, size_bytes, sha256)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        values: [B.shopId, paymentB, 'proofs/same-shop', 'image/png', 1024, 'b'.repeat(64)],
      },
      {
        label: 'sync_conflict_reviews',
        sql: 'INSERT INTO sync_conflict_reviews (shop_id, sync_operation_id, decision) VALUES ($1, $2, $3)',
        values: [B.shopId, syncOpB, 'keep_server'],
      },
    ];
    for (const testCase of valid) {
      await db.executor.query(testCase.sql, testCase.values);
    }
    const { rows } = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM sale_items WHERE shop_id = $1',
      [B.shopId]
    );
    expect(firstRow(rows, 'same-shop sale items').count).toBe(1);
  });

  it('scopes reads by shop_id so shop B rows are invisible to shop A queries', async () => {
    await db.executor.query(
      'INSERT INTO items (shop_id, name, sell_price_ngwee) VALUES ($1, $2, $3)',
      [shopB.shopId, 'shop-B-only', 500]
    );
    const { rows } = await db.executor.query<{ name: string }>(
      'SELECT name FROM items WHERE shop_id = $1 ORDER BY name',
      [shopA.shopId]
    );
    expect(rows.map((row) => row.name)).toEqual(['item-A']);
    const scopedB = await db.executor.query<{ name: string }>(
      'SELECT name FROM items WHERE shop_id = $1 ORDER BY name',
      [shopB.shopId]
    );
    expect(scopedB.rows.map((row) => row.name)).toEqual(['item-B', 'shop-B-only']);
  });
});
