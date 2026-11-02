import { PROVISIONAL_CONFIG_KEYS, SYSTEM_CONFIG_DEFAULTS } from '@countup/shared';
import { PLAN_CATALOG } from '@countup/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryResultRow } from '../src/db/query-executor';
import {
  createMigratedDatabase,
  expectSqlError,
  firstRow,
  type IsolatedDatabase,
} from './isolated-database';
import { createItem, createSale, createShop, createUser, seedTenant } from './fixtures';

interface CountRow extends QueryResultRow {
  count: number;
}

let db: IsolatedDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
});

afterEach(async () => {
  await db.close();
});

describe('seeded plan and system-config values', () => {
  it('seeds the three plans with the exact ngwee prices from the frontend catalogue', async () => {
    const { rows } = await db.executor.query<{
      plan_id: string;
      name: string;
      months: number;
      price_ngwee: number;
      active: boolean;
    }>('SELECT plan_id, name, months, price_ngwee, active FROM plans ORDER BY plan_id');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.plan_id)).toEqual(['biannual', 'monthly', 'quarterly']);
    const byId = new Map(rows.map((row) => [row.plan_id, row]));
    expect(byId.get('monthly')).toMatchObject({
      name: PLAN_CATALOG.monthly.name,
      months: PLAN_CATALOG.monthly.months,
      price_ngwee: PLAN_CATALOG.monthly.priceNgwee,
      active: true,
    });
    expect(byId.get('quarterly')).toMatchObject({
      months: PLAN_CATALOG.quarterly.months,
      price_ngwee: PLAN_CATALOG.quarterly.priceNgwee,
    });
    expect(byId.get('biannual')).toMatchObject({
      months: PLAN_CATALOG.biannual.months,
      price_ngwee: PLAN_CATALOG.biannual.priceNgwee,
    });
  });

  it('seeds trial 30 / warning 5 / grace 3 and keeps the four ADR defaults PROVISIONAL', async () => {
    const { rows } = await db.executor.query<{
      key: string;
      value: unknown;
      is_provisional: boolean;
    }>('SELECT key, value, is_provisional FROM system_config ORDER BY key');
    expect(rows).toHaveLength(SYSTEM_CONFIG_DEFAULTS.length);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('trial_duration_days')?.value).toBe(30);
    expect(byKey.get('expiry_warning_days')?.value).toBe(5);
    expect(byKey.get('grace_period_days')?.value).toBe(3);
    expect(byKey.get('currency')?.value).toBe('ZMW');
    expect(byKey.get('sale_max_lines')?.value).toBe(160);

    for (const key of PROVISIONAL_CONFIG_KEYS) {
      expect(byKey.get(key)?.is_provisional, `${key} must be flagged provisional`).toBe(true);
    }
    expect(PROVISIONAL_CONFIG_KEYS).toEqual(
      expect.arrayContaining([
        'timezone',
        'money_unit',
        'tenant_isolation',
        'retain_zamtel_operator',
      ])
    );
    expect(byKey.get('timezone')?.value).toBe('Africa/Lusaka');
    expect(byKey.get('money_unit')?.value).toBe('ngwee');
    expect(byKey.get('tenant_isolation')?.value).toBe('application_scoping');
    expect(byKey.get('retain_zamtel_operator')?.value).toBe(true);
  });

  it('rejects an unapproved plan id and duplicate plan ids', async () => {
    await expectSqlError(
      db.executor.query(
        'INSERT INTO plans (plan_id, name, months, price_ngwee) VALUES ($1, $2, $3, $4)',
        ['weekly', '1 Week', 1, 2500]
      ),
      '23514'
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO plans (plan_id, name, months, price_ngwee) VALUES ($1, $2, $3, $4)',
        ['monthly', 'Duplicate', 1, 9900]
      ),
      '23505'
    );
  });
});

describe('monetary CHECK constraints (integer ngwee)', () => {
  it('rejects negative balances, zero/negative prices and zero ledger deltas', async () => {
    const tenant = await seedTenant(db.executor, 'money');
    const statements: Array<[string, readonly unknown[]]> = [
      [
        'INSERT INTO items (shop_id, name, sell_price_ngwee) VALUES ($1, $2, $3)',
        [tenant.shopId, 'bad-price', 0],
      ],
      [
        'INSERT INTO items (shop_id, name, sell_price_ngwee, quantity) VALUES ($1, $2, $3, $4)',
        [tenant.shopId, 'bad-qty', 1000, -1],
      ],
      ['INSERT INTO sales (shop_id, total_ngwee) VALUES ($1, $2)', [tenant.shopId, -1]],
      [
        'INSERT INTO credit_payments (shop_id, customer_id, amount_ngwee) VALUES ($1, $2, $3)',
        [tenant.shopId, tenant.customerId, 0],
      ],
      [
        'INSERT INTO expenses (shop_id, category, amount_ngwee) VALUES ($1, $2, $3)',
        [tenant.shopId, 'rent', -500],
      ],
      [
        `INSERT INTO credit_ledger_entries
           (shop_id, customer_id, delta_ngwee, balance_after_ngwee, entry_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant.shopId, tenant.customerId, 0, 0, 'adjustment'],
      ],
      [
        `INSERT INTO subscription_payments
           (shop_id, user_id, plan_id, amount_ngwee, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant.shopId, tenant.userId, 'monthly', -9900, 'REF-NEG'],
      ],
    ];
    for (const [sql, values] of statements) {
      await expectSqlError(db.executor.query(sql, values), '23514');
    }
  });

  it('rejects fractional money because all money columns are BIGINT', async () => {
    const tenant = await seedTenant(db.executor, 'fraction');
    await expectSqlError(
      db.executor.query('INSERT INTO sales (shop_id, total_ngwee) VALUES ($1, $2)', [
        tenant.shopId,
        99.5,
      ]),
      '22P02'
    );
  });

  it('enforces line_total_ngwee = quantity * unit_price_ngwee', async () => {
    const tenant = await seedTenant(db.executor, 'line');
    await expectSqlError(
      db.executor.query(
        `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant.shopId, tenant.saleId, tenant.itemId, 2, 1000, 1999]
      ),
      '23514'
    );
    const { rows } = await db.executor.query<{ id: string }>(
      `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.shopId, tenant.saleId, tenant.itemId, 2, 1000, 2000]
    );
    expect(firstRow(rows, 'valid sale item').id).toBeTypeOf('string');
  });
});

describe('unique constraints', () => {
  it('enforces per-shop SKU, one owner per shop, unique references and idempotent sync keys', async () => {
    const tenant = await seedTenant(db.executor, 'unique');
    const otherUser = await createUser(db.executor, 'second-owner');
    const sku = 'SKU-1';
    await db.executor.query(
      'INSERT INTO items (shop_id, sku, name, sell_price_ngwee) VALUES ($1, $2, $3, $4)',
      [tenant.shopId, sku, 'first', 1000]
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO items (shop_id, sku, name, sell_price_ngwee) VALUES ($1, $2, $3, $4)',
        [tenant.shopId, sku, 'second', 1000]
      ),
      '23505'
    );
    await db.executor.query(
      'INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)',
      [tenant.shopId, tenant.userId, 'owner']
    );
    await expectSqlError(
      db.executor.query('INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)', [
        tenant.shopId,
        otherUser,
        'owner',
      ]),
      '23505'
    );
    await expectSqlError(
      db.executor.query('INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)', [
        tenant.shopId,
        tenant.userId,
        'staff',
      ]),
      '23505'
    );

    await db.executor.query(
      `INSERT INTO sync_operations (shop_id, device_id, client_operation_id, operation_type)
       VALUES ($1, $2, $3, $4)`,
      [tenant.shopId, 'device-1', 'op-1', 'sale.create']
    );
    await expectSqlError(
      db.executor.query(
        `INSERT INTO sync_operations (shop_id, device_id, client_operation_id, operation_type)
         VALUES ($1, $2, $3, $4)`,
        [tenant.shopId, 'device-1', 'op-1', 'sale.create']
      ),
      '23505'
    );

    const payment = await db.executor.query<{ id: string }>(
      `INSERT INTO subscription_payments
         (shop_id, user_id, plan_id, amount_ngwee, reference)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant.shopId, tenant.userId, 'monthly', 9900, 'PAY-1']
    );
    await expectSqlError(
      db.executor.query(
        `INSERT INTO subscription_payments
           (shop_id, user_id, plan_id, amount_ngwee, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant.shopId, tenant.userId, 'monthly', 9900, 'PAY-1']
      ),
      '23505'
    );
    await db.executor.query(
      'INSERT INTO payment_reference_locks (reference, shop_id, payment_id) VALUES ($1, $2, $3)',
      ['PAY-1', tenant.shopId, firstRow(payment.rows, 'payment').id]
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO payment_reference_locks (reference, shop_id, payment_id) VALUES ($1, $2, $3)',
        ['PAY-1', tenant.shopId, firstRow(payment.rows, 'payment').id]
      ),
      '23505'
    );
  });

  it('enforces a single primary verified identity and unique provider events', async () => {
    const user = await createUser(db.executor, 'identity-owner');
    await db.executor.query(
      'INSERT INTO auth_identities (user_id, kind, identifier, is_primary) VALUES ($1, $2, $3, $4)',
      [user, 'phone', '+260970000001', true]
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO auth_identities (user_id, kind, identifier, is_primary) VALUES ($1, $2, $3, $4)',
        [user, 'phone', '+260970000001', false]
      ),
      '23505'
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO auth_identities (user_id, kind, identifier, is_primary) VALUES ($1, $2, $3, $4)',
        [user, 'email', 'second@example.test', true]
      ),
      '23505'
    );
    await db.executor.query(
      'INSERT INTO provider_events (provider, event_type, external_id) VALUES ($1, $2, $3)',
      ['mtn', 'payment', 'EVT-1']
    );
    await expectSqlError(
      db.executor.query(
        'INSERT INTO provider_events (provider, event_type, external_id) VALUES ($1, $2, $3)',
        ['mtn', 'payment', 'EVT-1']
      ),
      '23505'
    );
  });
});

describe('foreign key enforcement', () => {
  it('rejects missing parents and protects referenced shops from deletion', async () => {
    const tenant = await seedTenant(db.executor, 'fk');
    await expectSqlError(
      db.executor.query(
        `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant.shopId, tenant.saleId, '00000000-0000-4000-8000-000000000000', 1, 1000, 1000]
      ),
      '23503'
    );
    // ON DELETE RESTRICT raises its own SQLSTATE (restrict_violation), not 23503.
    await expectSqlError(
      db.executor.query('DELETE FROM shops WHERE id = $1', [tenant.shopId]),
      '23001'
    );
    await expectSqlError(
      db.executor.query('INSERT INTO shops (owner_user_id, name) VALUES ($1, $2)', [
        '00000000-0000-4000-8000-000000000000',
        'orphan',
      ]),
      '23503'
    );
  });

  it('cascades sale_items when their parent sale disappears', async () => {
    const tenant = await seedTenant(db.executor, 'cascade');
    await db.executor.query(
      `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenant.shopId, tenant.saleId, tenant.itemId, 1, 1000, 1000]
    );
    await db.executor.query('DELETE FROM sales WHERE id = $1', [tenant.saleId]);
    const { rows } = await db.executor.query<CountRow>(
      'SELECT count(*)::int AS count FROM sale_items WHERE sale_id = $1',
      [tenant.saleId]
    );
    expect(firstRow(rows, 'cascaded sale items').count).toBe(0);
  });
});

describe('triggers and parameterised SQL', () => {
  it('derives local_date from Africa/Lusaka and maintains updated_at', async () => {
    const tenant = await seedTenant(db.executor, 'trigger');
    const { rows } = await db.executor.query<{
      local_date: Date;
      expected: Date;
    }>(
      `SELECT local_date, timezone('Africa/Lusaka', created_at)::date AS expected
         FROM sales WHERE id = $1`,
      [tenant.saleId]
    );
    expect(String(firstRow(rows, 'sale local date').local_date)).toBe(
      String(firstRow(rows, 'sale local date').expected)
    );

    const updated = await db.executor.query<{ updated_at: Date; created_at: Date }>(
      'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING created_at, updated_at',
      ['renamed', tenant.userId]
    );
    const row = firstRow(updated.rows, 'updated user');
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
  });

  it('treats injected SQL text as data, never as a statement', async () => {
    const user = await createUser(db.executor, 'inject');
    const shopId = await createShop(db.executor, user, "Robert'); DROP TABLE plans; --");
    const payload = "'); DROP TABLE plans; --";
    await db.executor.query(
      'INSERT INTO items (shop_id, name, sell_price_ngwee) VALUES ($1, $2, $3)',
      [shopId, payload, 1000]
    );
    const stored = await db.executor.query<{ name: string }>(
      'SELECT name FROM items WHERE shop_id = $1',
      [shopId]
    );
    expect(firstRow(stored.rows, 'stored name').name).toBe(payload);
    const { rows } = await db.executor.query<CountRow>('SELECT count(*)::int AS count FROM plans');
    expect(firstRow(rows, 'plans still present').count).toBe(3);
  });

  it('keeps valid same-shop relationships working', async () => {
    const tenant = await seedTenant(db.executor, 'valid');
    const itemId = await createItem(db.executor, tenant.shopId, 'second-item', 2500);
    const saleId = await createSale(db.executor, tenant.shopId, tenant.customerId, 2500);
    const { rows } = await db.executor.query<{ id: string }>(
      `INSERT INTO sale_items (shop_id, sale_id, item_id, quantity, unit_price_ngwee, line_total_ngwee)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.shopId, saleId, itemId, 1, 2500, 2500]
    );
    expect(firstRow(rows, 'same-shop sale item').id).toBeTypeOf('string');
  });
});
