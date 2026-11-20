import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSupabaseDb, TestIdentity } from './supabaseTestHarness';

describe('Phase 1 — Postgres Schema, Constraints, Triggers & Row Level Security', () => {
  let ctx: Awaited<ReturnType<typeof createTestSupabaseDb>>;

  let ownerA: TestIdentity;
  let ownerB: TestIdentity;
  let attackerSpoofedMeta: TestIdentity;
  let adminUser: TestIdentity;
  let adminWithoutMfa: TestIdentity;

  const shopAId = randomUUID();
  const shopBId = randomUUID();
  let paymentAId = '';
  let paymentBId = '';

  const EXPECTED_TABLES = [
    'shops',
    'used_trial_phones',
    'shop_pin_credentials',
    'shop_verified_sessions',
    'shop_pin_reset_requests',
    'sms_rate_events',
    'platform_alerts',
    'items',
    'customers',
    'sales',
    'sale_lines',
    'credit_payments',
    'expenses',
    'stock_movements',
    'stock_conflicts',
    'sync_operations',
    'subscription_payments',
    'payment_reference_locks',
    'platform_audit',
  ];

  const CHILD_SHOP_TABLES = [
    'shop_pin_credentials',
    'shop_verified_sessions',
    'shop_pin_reset_requests',
    'items',
    'customers',
    'sales',
    'sale_lines',
    'credit_payments',
    'expenses',
    'stock_movements',
    'stock_conflicts',
    'sync_operations',
    'subscription_payments',
    'payment_reference_locks',
  ];

  beforeAll(async () => {
    ctx = await createTestSupabaseDb();

    ownerA = await ctx.createAuthUser({
      phone: '+260977111111',
      appMetadata: { shop_id: shopAId },
    });
    ownerB = await ctx.createAuthUser({
      phone: '+260977222222',
      appMetadata: { shop_id: shopBId },
    });
    // Attacker puts Shop B's ID and platform_admin in client-editable user_metadata
    // and also has a verified admin-looking email, WITHOUT server app_metadata.
    attackerSpoofedMeta = await ctx.createAuthUser({
      email: 'admin@countup.zm',
      emailVerified: true,
      appMetadata: {},
      userMetadata: { shop_id: shopBId, platform_admin: true },
    });
    adminUser = await ctx.createAuthUser({
      email: 'owner@countup.zm',
      emailVerified: true,
      aal: 'aal2',
      appMetadata: { platform_admin: true },
    });
    adminWithoutMfa = await ctx.createAuthUser({
      email: 'owner-no-mfa@countup.zm',
      emailVerified: true,
      aal: 'aal1',
      appMetadata: { platform_admin: true },
    });

    const now = new Date('2026-11-20T09:00:00.000Z');
    const trialEnds = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const accessUntil = new Date(now.getTime() + 33 * 86_400_000).toISOString();

    await ctx.asServiceRole(async (tx) => {
      for (const [shopId, owner, name, phone, phoneHash] of [
        [shopAId, ownerA, 'Chilenje Kiosk A', '+260977111111', 'a'.repeat(64)],
        [shopBId, ownerB, 'Matero Kiosk B', '+260977222222', 'b'.repeat(64)],
      ] as const) {
        await tx.query(
          `INSERT INTO public.shops (
             id, owner_user_id, name, owner_phone, plan_status, plan_type,
             trial_ends_at, plan_expiry_at, sales_access_until
           ) VALUES ($1, $2, $3, $4, 'trial', 'trial', $5, $5, $6)`,
          [shopId, owner.id, name, phone, trialEnds, accessUntil]
        );

        await tx.query(
          `INSERT INTO public.used_trial_phones (phone_hash, first_shop_id, first_user_id)
           VALUES ($1, $2, $3)`,
          [phoneHash, shopId, owner.id]
        );

        await tx.query(
          `INSERT INTO public.items (
             shop_id, id, name, buying_price_ngwee, buying_price_known,
             selling_price_ngwee, unit_label, quantity, low_stock_threshold
           ) VALUES ($1, 'item_1', 'Mealie Meal 25kg', 22000, true, 26000, 'bag', 10, 3)`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.customers (shop_id, id, name, phone, notes, total_owed_ngwee)
           VALUES ($1, 'cust_1', 'Banda', '0977000001', 'Regular', 26000)`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.sales (
             shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee,
             profit_ngwee, missing_cost_revenue_ngwee, payment_type, customer_id,
             customer_name, receipt_number, local_date
           ) VALUES ($1, 'sale_1', 1, 26000, 22000, 4000, 0, 'credit', 'cust_1', 'Banda', 'CU-20261120-001', '2026-11-20')`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.sale_lines (
             shop_id, id, sale_id, line_index, item_id, item_name, unit_label,
             quantity, buying_price_ngwee, buying_price_known, selling_price_ngwee, line_total_ngwee
           ) VALUES ($1, 'line_1', 'sale_1', 0, 'item_1', 'Mealie Meal 25kg', 'bag', 1, 22000, true, 26000, 26000)`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.credit_payments (
             shop_id, id, customer_id, customer_name, amount_ngwee, payment_method, local_date
           ) VALUES ($1, 'pay_1', 'cust_1', 'Banda', 10000, 'cash', '2026-11-20')`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.expenses (shop_id, id, category, amount_ngwee, note)
           VALUES ($1, 'exp_1', 'transport', 5000, 'Bus fare')`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.stock_movements (
             shop_id, id, item_id, item_name, type, delta, previous_quantity, new_quantity, reason, related_sale_id
           ) VALUES ($1, 'mov_1', 'item_1', 'Mealie Meal 25kg', 'sale', -1, 11, 10, 'Sale CU-20261120-001', 'sale_1')`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.stock_conflicts (
             shop_id, id, item_id, item_name, kind, requested, available, shortfall
           ) VALUES ($1, 'conf_1', 'item_1', 'Mealie Meal 25kg', 'shortfall', 3, 2, 1)`,
          [shopId]
        );

        await tx.query(
          `INSERT INTO public.sync_operations (
             shop_id, operation_id, operation_type, outcome
           ) VALUES ($1, 'op_1', 'sale', 'applied')`,
          [shopId]
        );
      }

      const payA = await tx.query<{ id: string }>(
        `INSERT INTO public.subscription_payments (
           shop_id, shop_name_snapshot, owner_user_id, network, plan_id,
           transaction_reference, payer_phone, payment_date, amount_ngwee, status
         ) VALUES ($1, 'Chilenje Kiosk A', $2, 'mtn', 'monthly', 'MTN-SHOPA-001', '+260977111111', '2026-11-20', 9900, 'pending')
         RETURNING id`,
        [shopAId, ownerA.id]
      );
      paymentAId = payA.rows[0].id;

      await tx.query(
        `INSERT INTO public.payment_reference_locks (
           payment_id, shop_id, network, transaction_reference, status
         ) VALUES ($1, $2, 'mtn', 'MTN-SHOPA-001', 'pending')`,
        [paymentAId, shopAId]
      );

      const payB = await tx.query<{ id: string }>(
        `INSERT INTO public.subscription_payments (
           shop_id, shop_name_snapshot, owner_user_id, network, plan_id,
           transaction_reference, payer_phone, payment_date, amount_ngwee, status
         ) VALUES ($1, 'Matero Kiosk B', $2, 'airtel', 'quarterly', 'AIR-SHOPB-001', '+260977222222', '2026-11-20', 26900, 'pending')
         RETURNING id`,
        [shopBId, ownerB.id]
      );
      paymentBId = payB.rows[0].id;

      await tx.query(
        `INSERT INTO public.payment_reference_locks (
           payment_id, shop_id, network, transaction_reference, status
         ) VALUES ($1, $2, 'airtel', 'AIR-SHOPB-001', 'pending')`,
        [paymentBId, shopBId]
      );

      await tx.query(
        `INSERT INTO public.platform_audit (
           action, actor_user_id, shop_id, days
         ) VALUES ('subscription_extended', $1, $2, 30)`,
        [adminUser.id, shopAId]
      );
    });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  it('enables RLS on every table, uses bigint ngwee for all money, indexes shop_id on every child table, and has zero joins in RLS policies', async () => {
    const tables = await ctx.db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity
         FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([...EXPECTED_TABLES].sort());
    for (const row of tables.rows) {
      expect(row.rowsecurity, `RLS must be enabled on ${row.tablename}`).toBe(true);
    }

    // No floating-point or decimal money columns anywhere in public
    const nonIntegerNumbers = await ctx.db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('numeric', 'decimal', 'real', 'double precision')`
    );
    expect(nonIntegerNumbers.rows).toEqual([]);

    // Every *_ngwee column uses bigint
    const ngweeCols = await ctx.db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name LIKE '%_ngwee'`
    );
    expect(ngweeCols.rows.length).toBeGreaterThanOrEqual(14);
    for (const col of ngweeCols.rows) {
      expect(col.data_type, `${col.table_name}.${col.column_name} must be bigint`).toBe('bigint');
    }

    // Every child table has shop_id (uuid) AND a B-tree index starting with shop_id
    for (const tbl of CHILD_SHOP_TABLES) {
      const col = await ctx.db.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'shop_id'`,
        [tbl]
      );
      expect(col.rows[0]?.data_type, `${tbl}.shop_id must be uuid`).toBe('uuid');

      const idx = await ctx.db.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = $1
            AND indexdef ~* 'USING btree \\(shop_id([,)])'`,
        [tbl]
      );
      expect(
        idx.rows.length,
        `${tbl} must have a B-tree index leading with shop_id`
      ).toBeGreaterThan(0);
    }

    // Every table has updated_at + touch_updated_at trigger
    for (const tbl of EXPECTED_TABLES) {
      const updCol = await ctx.db.query<{ is_nullable: string; data_type: string }>(
        `SELECT is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'updated_at'`,
        [tbl]
      );
      expect(updCol.rows[0]).toEqual({
        is_nullable: 'NO',
        data_type: 'timestamp with time zone',
      });

      const trig = await ctx.db.query<{ tgname: string }>(
        `SELECT t.tgname
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = $1
            AND NOT t.tgisinternal
            AND t.tgname LIKE '%touch_updated_at'`,
        [tbl]
      );
      expect(trig.rows.length, `${tbl} must have touch_updated_at trigger`).toBe(1);
    }

    // Every RLS policy expression has zero table joins or EXISTS subqueries
    const policies = await ctx.db.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public'`
    );
    expect(policies.rows.length).toBeGreaterThanOrEqual(14);
    for (const pol of policies.rows) {
      const combined = `${pol.qual ?? ''} ${pol.with_check ?? ''}`;
      expect(combined, `${pol.policyname} must not join or query tables`).not.toMatch(
        /\b(JOIN|EXISTS|FROM\s+public\.)\b/i
      );
    }
  });

  it('isolates Shop A from Shop B on reads across every shop-scoped table', async () => {
    await ctx.asUser(ownerA, async (tx) => {
      const shops = await tx.query<{ id: string }>(`SELECT id FROM public.shops`);
      expect(shops.rows.map((r) => r.id)).toEqual([shopAId]);

      const shopScopedReadable = [
        'items',
        'customers',
        'sales',
        'sale_lines',
        'credit_payments',
        'expenses',
        'stock_movements',
        'stock_conflicts',
        'sync_operations',
        'subscription_payments',
      ];
      for (const tbl of shopScopedReadable) {
        const allVisible = await tx.query<{ shop_id: string }>(`SELECT shop_id FROM public.${tbl}`);
        expect(allVisible.rows.length, `Shop A should see its own ${tbl} row`).toBe(1);
        expect(allVisible.rows[0].shop_id).toBe(shopAId);

        const explicitShopB = await tx.query(`SELECT 1 FROM public.${tbl} WHERE shop_id = $1`, [
          shopBId,
        ]);
        expect(explicitShopB.rows, `Shop A must never read Shop B rows in ${tbl}`).toEqual([]);
      }
    });
  });

  it('prevents Shop A from writing, updating, or deleting any Shop B record', async () => {
    // Direct UPDATE attempts targeting Shop B affect 0 rows and leave Shop B untouched
    await ctx.asUser(ownerA, async (tx) => {
      const shopUpdate = await tx.query(
        `UPDATE public.shops SET name = 'Hacked by A' WHERE id = $1`,
        [shopBId]
      );
      expect(shopUpdate.affectedRows).toBe(0);

      const itemUpdate = await tx.query(
        `UPDATE public.items SET name = 'Tampered Item', selling_price_ngwee = 100 WHERE shop_id = $1`,
        [shopBId]
      );
      expect(itemUpdate.affectedRows).toBe(0);

      const custUpdate = await tx.query(
        `UPDATE public.customers SET name = 'Tampered Customer' WHERE shop_id = $1`,
        [shopBId]
      );
      expect(custUpdate.affectedRows).toBe(0);
    });

    // INSERT for Shop B is rejected by RLS WITH CHECK
    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.customers (shop_id, id, name, phone, notes)
           VALUES ($1, 'injected_cust', 'Injected', '', '')`,
          [shopBId]
        )
      )
    ).rejects.toThrow(/row-level security|permission denied/i);

    // DELETE attempts on Shop B are rejected
    for (const tbl of ['shops', 'items', 'customers', 'sales', 'sale_lines']) {
      const col = tbl === 'shops' ? 'id' : 'shop_id';
      await expect(
        ctx.asUser(ownerA, (tx) =>
          tx.query(`DELETE FROM public.${tbl} WHERE ${col} = $1`, [shopBId])
        )
      ).rejects.toThrow(/permission denied/i);
    }

    // Confirm via service_role that Shop B's records were never altered
    await ctx.asServiceRole(async (tx) => {
      const shopB = await tx.query<{ name: string }>(
        `SELECT name FROM public.shops WHERE id = $1`,
        [shopBId]
      );
      expect(shopB.rows[0].name).toBe('Matero Kiosk B');

      const itemB = await tx.query<{ name: string; selling_price_ngwee: string | number }>(
        `SELECT name, selling_price_ngwee FROM public.items WHERE shop_id = $1 AND id = 'item_1'`,
        [shopBId]
      );
      expect(itemB.rows[0].name).toBe('Mealie Meal 25kg');
      expect(Number(itemB.rows[0].selling_price_ngwee)).toBe(26000);
    });
  });

  it('denies unauthenticated (anon) and spoofed user_metadata / email-only sessions across all tables', async () => {
    for (const tbl of EXPECTED_TABLES) {
      await expect(ctx.asAnon((tx) => tx.query(`SELECT * FROM public.${tbl}`))).rejects.toThrow(
        /permission denied/i
      );
    }

    // Attacker who put shop_id + platform_admin in client-writable user_metadata gets zero rows
    await ctx.asUser(attackerSpoofedMeta, async (tx) => {
      for (const tbl of [
        'shops',
        'items',
        'customers',
        'sales',
        'sale_lines',
        'subscription_payments',
        'platform_audit',
      ]) {
        const res = await tx.query(`SELECT * FROM public.${tbl}`);
        expect(res.rows, `Spoofed user_metadata must not read ${tbl}`).toEqual([]);
      }
    });
  });

  it('prevents clients (including shop owners and platform admins) from changing plan/expiry/suspension or writing payment/audit/lock tables', async () => {
    // Shop owner CAN update harmless profile fields and updated_at advances automatically
    const beforeUpdate = await ctx.asUser(ownerA, (tx) =>
      tx.query<{ updated_at: string }>(`SELECT updated_at FROM public.shops WHERE id = $1`, [
        shopAId,
      ])
    );

    await ctx.asUser(ownerA, async (tx) => {
      const updated = await tx.query(
        `UPDATE public.shops
            SET name = 'Chilenje Kiosk Updated',
                momo_mtn_number = '0966123456'
          WHERE id = $1`,
        [shopAId]
      );
      expect(updated.affectedRows).toBe(1);
    });

    const afterUpdate = await ctx.asUser(ownerA, (tx) =>
      tx.query<{ name: string; momo_mtn_number: string; updated_at: string }>(
        `SELECT name, momo_mtn_number, updated_at FROM public.shops WHERE id = $1`,
        [shopAId]
      )
    );
    expect(afterUpdate.rows[0].name).toBe('Chilenje Kiosk Updated');
    expect(afterUpdate.rows[0].momo_mtn_number).toBe('0966123456');
    expect(new Date(afterUpdate.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(beforeUpdate.rows[0].updated_at).getTime()
    );

    // Shop owner CANNOT create or delete shops directly, or change plan/expiry/suspension/owner
    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.shops (
             owner_user_id, name, owner_phone, plan_status, plan_type,
             trial_ends_at, plan_expiry_at, sales_access_until
           ) VALUES ($1, 'Extra Free Trial', '+260977999999', 'active', 'biannual', now(), now(), now())`,
          [ownerA.id]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    for (const forbiddenSet of [
      `plan_status = 'active'`,
      `plan_type = 'biannual'`,
      `plan_expiry_at = now() + interval '365 days'`,
      `sales_access_until = now() + interval '365 days'`,
      `is_deactivated = false`,
      `owner_user_id = '${ownerB.id}'`,
      `owner_phone = '+260977000000'`,
    ]) {
      await expect(
        ctx.asUser(ownerA, (tx) =>
          tx.query(`UPDATE public.shops SET ${forbiddenSet} WHERE id = $1`, [shopAId])
        )
      ).rejects.toThrow(/permission denied|Insufficient privilege/i);
    }

    // Even platform_admin client JWT cannot mutate plans, payments, locks, or audit directly
    await expect(
      ctx.asUser(adminUser, (tx) =>
        tx.query(`UPDATE public.shops SET plan_status = 'active' WHERE id = $1`, [shopAId])
      )
    ).rejects.toThrow(/permission denied|Insufficient privilege/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(`UPDATE public.subscription_payments SET status = 'approved' WHERE id = $1`, [
          paymentAId,
        ])
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(adminUser, (tx) =>
        tx.query(`UPDATE public.subscription_payments SET status = 'approved' WHERE id = $1`, [
          paymentAId,
        ])
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.subscription_payments (
             shop_id, shop_name_snapshot, owner_user_id, network, plan_id,
             transaction_reference, payer_phone, payment_date, amount_ngwee, status
           ) VALUES ($1, 'Fake', $2, 'mtn', 'monthly', 'FAKE-REF-999', '+260977111111', '2026-11-20', 9900, 'approved')`,
          [shopAId, ownerA.id]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    // Reference locks and used_trial_phones are completely hidden from ALL clients
    for (const actor of [ownerA, adminUser]) {
      await expect(
        ctx.asUser(actor, (tx) => tx.query(`SELECT * FROM public.payment_reference_locks`))
      ).rejects.toThrow(/permission denied/i);
      await expect(
        ctx.asUser(actor, (tx) => tx.query(`SELECT * FROM public.used_trial_phones`))
      ).rejects.toThrow(/permission denied/i);
    }

    // Audit trail is read-only for platform_admin and invisible to ordinary shop owners
    const ownerAudit = await ctx.asUser(ownerA, (tx) =>
      tx.query(`SELECT * FROM public.platform_audit`)
    );
    expect(ownerAudit.rows).toEqual([]);

    const adminAudit = await ctx.asUser(adminUser, (tx) =>
      tx.query(`SELECT action FROM public.platform_audit`)
    );
    expect(adminAudit.rows).toEqual([{ action: 'subscription_extended' }]);

    await expect(
      ctx.asUser(adminUser, (tx) =>
        tx.query(
          `INSERT INTO public.platform_audit (action, actor_user_id) VALUES ('forged', $1)`,
          [adminUser.id]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    // Platform admin can list all shops and all payment submissions for review
    await ctx.asUser(adminUser, async (tx) => {
      const allShops = await tx.query<{ id: string }>(`SELECT id FROM public.shops`);
      expect(allShops.rows.map((r) => r.id).sort()).toEqual([shopAId, shopBId].sort());

      const allPayments = await tx.query<{ id: string }>(
        `SELECT id FROM public.subscription_payments`
      );
      expect(allPayments.rows.map((r) => r.id).sort()).toEqual([paymentAId, paymentBId].sort());
    });
  });

  it('blocks direct client writes to invariant-bearing columns and ledger tables (RPC-only)', async () => {
    // Item catalog metadata is editable, but stock quantity & direct insert/delete are blocked
    await ctx.asUser(ownerA, async (tx) => {
      const res = await tx.query(
        `UPDATE public.items
            SET selling_price_ngwee = 27500, low_stock_threshold = 4
          WHERE shop_id = $1 AND id = 'item_1'`,
        [shopAId]
      );
      expect(res.affectedRows).toBe(1);
    });

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(`UPDATE public.items SET quantity = 999 WHERE shop_id = $1 AND id = 'item_1'`, [
          shopAId,
        ])
      )
    ).rejects.toThrow(/permission denied|Stock quantity/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.items (shop_id, id, name, selling_price_ngwee, quantity)
           VALUES ($1, 'item_direct', 'Cooking Oil', 5000, 20)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    // Customer contact fields & zero-balance creation work, but balance tampering is blocked
    await ctx.asUser(ownerA, async (tx) => {
      await tx.query(
        `INSERT INTO public.customers (shop_id, id, name, phone, notes)
         VALUES ($1, 'cust_zero', 'Mulenga', '0977333444', 'New')`,
        [shopAId]
      );
      const res = await tx.query(
        `UPDATE public.customers SET notes = 'Trusted neighbour' WHERE shop_id = $1 AND id = 'cust_1'`,
        [shopAId]
      );
      expect(res.affectedRows).toBe(1);
    });

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.customers (shop_id, id, name, total_owed_ngwee)
           VALUES ($1, 'cust_debt', 'Forged Debt', 50000)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `UPDATE public.customers SET total_owed_ngwee = 0 WHERE shop_id = $1 AND id = 'cust_1'`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied|Customer balance/i);

    // Direct writes to sales, sale_lines, repayments, expenses, stock_movements, stock_conflicts, sync_operations are denied
    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.sales (
             shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee,
             profit_ngwee, missing_cost_revenue_ngwee, payment_type, receipt_number
           ) VALUES ($1, 'sale_direct', 1, 1000, 500, 500, 0, 'cash', 'CU-DIRECT')`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(`UPDATE public.sales SET is_deleted = true WHERE shop_id = $1 AND id = 'sale_1'`, [
          shopAId,
        ])
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.sale_lines (
             shop_id, id, sale_id, item_id, item_name, quantity, selling_price_ngwee, line_total_ngwee
           ) VALUES ($1, 'line_direct', 'sale_1', 'item_1', 'Mealie Meal 25kg', 1, 26000, 26000)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.credit_payments (shop_id, id, customer_id, customer_name, amount_ngwee)
           VALUES ($1, 'pay_direct', 'cust_1', 'Banda', 1000)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.expenses (shop_id, id, category, amount_ngwee)
           VALUES ($1, 'exp_direct', 'rent', 10000)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.stock_movements (
             shop_id, id, item_id, item_name, type, delta, previous_quantity, new_quantity
           ) VALUES ($1, 'mov_direct', 'item_1', 'Mealie Meal 25kg', 'restock', 5, 10, 15)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `UPDATE public.stock_conflicts SET resolved = true WHERE shop_id = $1 AND id = 'conf_1'`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `INSERT INTO public.sync_operations (shop_id, operation_id, operation_type)
           VALUES ($1, 'op_direct', 'sale')`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it('enforces partial unique index on payment_reference_locks (blocks pending/approved, allows resubmit after rejected)', async () => {
    // 1. Duplicate while pending is rejected
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.payment_reference_locks (shop_id, network, transaction_reference, status)
           VALUES ($1, 'mtn', 'MTN-SHOPA-001', 'pending')`,
          [shopBId]
        )
      )
    ).rejects.toThrow(/duplicate key value/i);

    // 2. Rejecting the initial submission releases the partial unique lock while preserving history
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.subscription_payments
            SET status = 'rejected', rejection_reason = 'Wrong plan selected'
          WHERE id = $1`,
        [paymentAId]
      );
      await tx.query(
        `UPDATE public.payment_reference_locks
            SET status = 'rejected', reviewed_at = now()
          WHERE payment_id = $1`,
        [paymentAId]
      );
    });

    // 3. Resubmitting the exact same reference after rejection succeeds!
    let resubmittedLockId = '';
    await ctx.asServiceRole(async (tx) => {
      const resub = await tx.query<{ id: string }>(
        `INSERT INTO public.payment_reference_locks (shop_id, network, transaction_reference, status)
         VALUES ($1, 'mtn', 'MTN-SHOPA-001', 'pending')
         RETURNING id`,
        [shopAId]
      );
      resubmittedLockId = resub.rows[0].id;
      await tx.query(
        `UPDATE public.payment_reference_locks
            SET status = 'approved', reviewed_at = now()
          WHERE id = $1`,
        [resubmittedLockId]
      );
    });

    // 4. Once approved, any further submission of that reference is permanently blocked
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.payment_reference_locks (shop_id, network, transaction_reference, status)
           VALUES ($1, 'mtn', 'MTN-SHOPA-001', 'pending')`,
          [shopBId]
        )
      )
    ).rejects.toThrow(/duplicate key value/i);
  });

  it('enforces CHECK constraints, idempotency key uniqueness, composite cross-shop FKs, and custom_access_token_hook', async () => {
    // Negative stock rejected
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.items (shop_id, id, name, selling_price_ngwee, quantity)
           VALUES ($1, 'bad_qty', 'Soap', 1500, -1)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/check constraint/i);

    // Zero or negative money rejected
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.expenses (shop_id, id, category, amount_ngwee)
           VALUES ($1, 'bad_exp', 'other', 0)`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/check constraint/i);

    // Negative customer balance rejected
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `UPDATE public.customers SET total_owed_ngwee = -100 WHERE shop_id = $1 AND id = 'cust_1'`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/check constraint/i);

    // Inconsistent sale profit formula rejected
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.sales (
             shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee,
             profit_ngwee, missing_cost_revenue_ngwee, payment_type, receipt_number
           ) VALUES ($1, 'bad_profit', 1, 5000, 3000, 9999, 0, 'cash', 'CU-BAD')`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/sales_profit_formula/i);

    // Duplicate idempotency key in same shop rejected, while same string in Shop B already exists independently
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.sync_operations (shop_id, operation_id, operation_type)
           VALUES ($1, 'op_1', 'sale')`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/duplicate key value/i);

    // Composite FK prevents a Shop A sale from pointing to a customer ID that only exists in Shop B
    await ctx.asServiceRole((tx) =>
      tx.query(
        `INSERT INTO public.customers (shop_id, id, name) VALUES ($1, 'only_in_b', 'Chanda')`,
        [shopBId]
      )
    );
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.sales (
             shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee,
             profit_ngwee, missing_cost_revenue_ngwee, payment_type, customer_id, receipt_number
           ) VALUES ($1, 'cross_shop_sale', 1, 1000, 500, 500, 0, 'credit', 'only_in_b', 'CU-CROSS')`,
          [shopAId]
        )
      )
    ).rejects.toThrow(/foreign key constraint/i);

    // Custom Access Token Hook injects verified shop_id for ownerA and strips forged shop_id for attacker
    const hookForOwner = await ctx.db.query<{
      result: { claims: { app_metadata: { shop_id?: string } } };
    }>(`SELECT public.custom_access_token_hook($1::jsonb) AS result`, [
      JSON.stringify({ user_id: ownerA.id, claims: { app_metadata: {} } }),
    ]);
    expect(hookForOwner.rows[0].result.claims.app_metadata.shop_id).toBe(shopAId);

    const hookForAttacker = await ctx.db.query<{
      result: { claims: { app_metadata: Record<string, unknown> } };
    }>(`SELECT public.custom_access_token_hook($1::jsonb) AS result`, [
      JSON.stringify({
        user_id: attackerSpoofedMeta.id,
        claims: { app_metadata: { shop_id: shopBId } },
      }),
    ]);
    expect(hookForAttacker.rows[0].result.claims.app_metadata.shop_id).toBeUndefined();
  });

  it('handles malformed JWT claims safely, supports updated_at cursor sync, and retains trial/reference/audit locks across shop deletion', async () => {
    const malformedClaimsUser = await ctx.createAuthUser({
      appMetadata: { shop_id: 'not-a-valid-uuid', platform_admin: 'true' },
    });

    await ctx.asUser(malformedClaimsUser, async (tx) => {
      const items = await tx.query(`SELECT * FROM public.items`);
      expect(items.rows).toEqual([]);
      const audits = await tx.query(`SELECT * FROM public.platform_audit`);
      expect(audits.rows).toEqual([]);
    });

    // Cursor-based incremental sync check using updated_at
    const cursorBefore = await ctx.asUser(ownerA, (tx) =>
      tx.query<{ max_updated: string }>(
        `SELECT max(updated_at) AS max_updated FROM public.items WHERE shop_id = $1`,
        [shopAId]
      )
    );
    const cursor = cursorBefore.rows[0].max_updated;

    await ctx.asUser(ownerA, (tx) =>
      tx.query(
        `UPDATE public.items SET unit_label = '25kg sack' WHERE shop_id = $1 AND id = 'item_1'`,
        [shopAId]
      )
    );

    const changedRows = await ctx.asUser(ownerA, (tx) =>
      tx.query<{ id: string; unit_label: string }>(
        `SELECT id, unit_label FROM public.items WHERE shop_id = $1 AND updated_at > $2`,
        [shopAId, cursor]
      )
    );
    expect(changedRows.rows).toEqual([{ id: 'item_1', unit_label: '25kg sack' }]);

    // Create a temporary shop, approve a payment lock, delete the shop via service_role,
    // and prove operational records cascade while trial phone, approved reference lock & audit remain.
    const tempShopId = randomUUID();
    const tempOwner = await ctx.createAuthUser({
      phone: '+260955888777',
      appMetadata: { shop_id: tempShopId },
    });

    await ctx.asServiceRole(async (tx) => {
      const future = new Date('2026-12-25T00:00:00.000Z').toISOString();
      await tx.query(
        `INSERT INTO public.shops (
           id, owner_user_id, name, owner_phone, plan_status, plan_type,
           trial_ends_at, plan_expiry_at, sales_access_until
         ) VALUES ($1, $2, 'Temp Shop', '+260955888777', 'active', 'monthly', $3, $3, $3)`,
        [tempShopId, tempOwner.id, future]
      );
      await tx.query(
        `INSERT INTO public.used_trial_phones (phone_hash, first_shop_id, first_user_id, was_suspended)
         VALUES ($1, $2, $3, true)`,
        ['c'.repeat(64), tempShopId, tempOwner.id]
      );
      await tx.query(
        `INSERT INTO public.items (shop_id, id, name, selling_price_ngwee, quantity)
         VALUES ($1, 'temp_item', 'Bread', 2500, 5)`,
        [tempShopId]
      );
      const pay = await tx.query<{ id: string }>(
        `INSERT INTO public.subscription_payments (
           shop_id, shop_name_snapshot, owner_user_id, network, plan_id,
           transaction_reference, payer_phone, payment_date, amount_ngwee, status
         ) VALUES ($1, 'Temp Shop', $2, 'airtel', 'monthly', 'AIR-PERMANENT-LOCK', '+260955888777', '2026-11-20', 9900, 'approved')
         RETURNING id`,
        [tempShopId, tempOwner.id]
      );
      await tx.query(
        `INSERT INTO public.payment_reference_locks (
           payment_id, shop_id, network, transaction_reference, status
         ) VALUES ($1, $2, 'airtel', 'AIR-PERMANENT-LOCK', 'approved')`,
        [pay.rows[0].id, tempShopId]
      );
      await tx.query(
        `INSERT INTO public.platform_audit (action, actor_user_id, shop_id)
         VALUES ('shop_deleted', $1, $2)`,
        [tempOwner.id, tempShopId]
      );

      await tx.query(`DELETE FROM public.shops WHERE id = $1`, [tempShopId]);
    });

    await ctx.asServiceRole(async (tx) => {
      const remainingItems = await tx.query(`SELECT 1 FROM public.items WHERE shop_id = $1`, [
        tempShopId,
      ]);
      expect(remainingItems.rows).toEqual([]);

      const trialRecord = await tx.query<{ was_suspended: boolean }>(
        `SELECT was_suspended FROM public.used_trial_phones WHERE phone_hash = $1`,
        ['c'.repeat(64)]
      );
      expect(trialRecord.rows).toEqual([{ was_suspended: true }]);

      const auditRecord = await tx.query<{ action: string }>(
        `SELECT action FROM public.platform_audit WHERE actor_user_id = $1`,
        [tempOwner.id]
      );
      expect(auditRecord.rows).toEqual([{ action: 'shop_deleted' }]);
    });

    // Approved reference from the deleted shop still cannot be reused by any other shop!
    await expect(
      ctx.asServiceRole((tx) =>
        tx.query(
          `INSERT INTO public.payment_reference_locks (shop_id, network, transaction_reference, status)
           VALUES ($1, 'airtel', 'AIR-PERMANENT-LOCK', 'pending')`,
          [shopBId]
        )
      )
    ).rejects.toThrow(/duplicate key value/i);
  });

  it('passes strict security catalog audit: all policies TO authenticated, zero PUBLIC/anon table privileges, SECURITY DEFINER search_path="" and no PUBLIC/anon EXECUTE', async () => {
    // 1. Every RLS policy in public targets ONLY `{authenticated}`
    const policies = await ctx.db.query<{ policyname: string; roles: string[] | string }>(
      `SELECT policyname, roles::text AS roles
         FROM pg_policies
        WHERE schemaname = 'public'`
    );
    expect(policies.rows.length).toBeGreaterThanOrEqual(14);
    for (const pol of policies.rows) {
      expect(pol.roles, `${pol.policyname} must be TO authenticated only`).toBe('{authenticated}');
    }

    // 2. Neither PUBLIC (grantee = 0) nor anon has any table or column privileges in public
    const leakedGrants = await ctx.db.query<{
      table_name: string;
      grantee: string;
      privilege_type: string;
    }>(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee IN ('PUBLIC', 'anon')
       UNION ALL
       SELECT table_name, grantee, privilege_type
         FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND grantee IN ('PUBLIC', 'anon')`
    );
    expect(leakedGrants.rows).toEqual([]);

    for (const tbl of EXPECTED_TABLES) {
      const anonPriv = await ctx.db.query<{ has_table: boolean; has_col: boolean }>(
        `SELECT
           has_table_privilege('anon', format('public.%I', $1::text), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS has_table,
           has_any_column_privilege('anon', format('public.%I', $1::text), 'SELECT,INSERT,UPDATE,REFERENCES') AS has_col`,
        [tbl]
      );
      expect(anonPriv.rows[0], `anon must have zero privileges on ${tbl}`).toEqual({
        has_table: false,
        has_col: false,
      });
    }

    // 3. Every SECURITY DEFINER function in public sets search_path="" and revokes PUBLIC & anon EXECUTE
    const secDefFuncs = await ctx.db.query<{
      proname: string;
      proconfig: string[] | null;
      anon_exec: boolean;
      public_exec: boolean;
    }>(
      `SELECT
         p.proname,
         p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         EXISTS (
           SELECT 1
             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         ) AS public_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef = true`
    );
    expect(secDefFuncs.rows.length).toBeGreaterThanOrEqual(2);
    for (const fn of secDefFuncs.rows) {
      expect(
        fn.proconfig?.some((c) => c === 'search_path=""' || c === "search_path=''"),
        `${fn.proname} must set empty search_path`
      ).toBe(true);
      expect(fn.anon_exec, `anon must not EXECUTE ${fn.proname}`).toBe(false);
      expect(fn.public_exec, `PUBLIC must not EXECUTE ${fn.proname}`).toBe(false);
    }
  });

  it('enforces SIM-swap session gating in custom_access_token_hook and security-notice acknowledgement RPC', async () => {
    // Attach server PIN credentials to Shop A -> unverified new-device session must NOT get shop_id
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.shop_pin_credentials (
           shop_id, pin_salt, pin_hash, recovery_salt, recovery_hash
         ) VALUES ($1, $2, $3, $4, $5)`,
        [shopAId, 's'.repeat(32), 'h'.repeat(64), 'r'.repeat(32), 'k'.repeat(64)]
      );
      await tx.query(
        `UPDATE public.shops
            SET security_notice = 'New-device PIN lockout was reset by support.',
                security_notice_at = now()
          WHERE id = $1`,
        [shopAId]
      );
    });

    const unverifiedHook = await ctx.db.query<{
      result: { claims: { app_metadata: Record<string, unknown> } };
    }>(`SELECT public.custom_access_token_hook($1::jsonb) AS result`, [
      JSON.stringify({
        user_id: ownerA.id,
        claims: { session_id: 'sim_swap_session_999', app_metadata: {} },
      }),
    ]);
    expect(unverifiedHook.rows[0].result.claims.app_metadata.shop_id).toBeUndefined();
    expect(unverifiedHook.rows[0].result.claims.app_metadata.pending_pin_verification).toBe(true);

    // An unverified OTP-only session (no shop_id in JWT) cannot even read its own shops row
    const otpOnlyOwnerA: TestIdentity = {
      ...ownerA,
      appMetadata: { pending_pin_verification: true },
    };
    const hiddenShop = await ctx.asUser(otpOnlyOwnerA, (tx) =>
      tx.query(`SELECT * FROM public.shops`)
    );
    expect(hiddenShop.rows).toEqual([]);

    // Once the session verifies the PIN, custom_access_token_hook grants shop_id
    await ctx.asServiceRole((tx) =>
      tx.query(
        `INSERT INTO public.shop_verified_sessions (shop_id, session_id, user_id)
         VALUES ($1, 'verified_device_session_1', $2)`,
        [shopAId, ownerA.id]
      )
    );

    const verifiedHook = await ctx.db.query<{
      result: { claims: { app_metadata: Record<string, unknown> } };
    }>(`SELECT public.custom_access_token_hook($1::jsonb) AS result`, [
      JSON.stringify({
        user_id: ownerA.id,
        claims: { session_id: 'verified_device_session_1', app_metadata: {} },
      }),
    ]);
    expect(verifiedHook.rows[0].result.claims.app_metadata.shop_id).toBe(shopAId);
    expect(
      verifiedHook.rows[0].result.claims.app_metadata.pending_pin_verification
    ).toBeUndefined();

    // Shop owner cannot directly overwrite security_notice via UPDATE, but CAN dismiss via RPC
    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(`UPDATE public.shops SET security_notice = NULL WHERE id = $1`, [shopAId])
      )
    ).rejects.toThrow(/permission denied|Insufficient privilege/i);

    await ctx.asUser(ownerA, (tx) => tx.query(`SELECT public.acknowledge_shop_security_notice()`));

    const cleared = await ctx.asUser(ownerA, (tx) =>
      tx.query<{ security_notice: string | null }>(
        `SELECT security_notice FROM public.shops WHERE id = $1`,
        [shopAId]
      )
    );
    expect(cleared.rows[0].security_notice).toBeNull();
  });

  it('requires MFA (aal2) for platform_admin RLS policies and denies aal1 admin sessions across all admin tables', async () => {
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.platform_alerts (alert_key, severity, category, title, detail)
         VALUES ('sms_daily_cap:2026-11-20', 'critical', 'sms_cap', 'Daily SMS cap reached', 'SMS dispatch paused.')`
      );
    });

    // Admin with password-only (aal1) gets ZERO rows on shops, payments, audit, and alerts
    const aal1Results = await ctx.asUser(adminWithoutMfa, async (tx) => {
      const shops = await tx.query(`SELECT id FROM public.shops`);
      const payments = await tx.query(`SELECT id FROM public.subscription_payments`);
      const audits = await tx.query(`SELECT id FROM public.platform_audit`);
      const alerts = await tx.query(`SELECT id FROM public.platform_alerts`);
      return {
        shops: shops.rows.length,
        payments: payments.rows.length,
        audits: audits.rows.length,
        alerts: alerts.rows.length,
      };
    });
    expect(aal1Results).toEqual({ shops: 0, payments: 0, audits: 0, alerts: 0 });

    // Admin with TOTP MFA verified (aal2) sees all shops, payments, audits, and alerts
    const aal2Results = await ctx.asUser(adminUser, async (tx) => {
      const shops = await tx.query(`SELECT id FROM public.shops`);
      const payments = await tx.query(`SELECT id FROM public.subscription_payments`);
      const audits = await tx.query(`SELECT id FROM public.platform_audit`);
      const alerts = await tx.query(`SELECT id FROM public.platform_alerts`);
      return {
        shops: shops.rows.length,
        payments: payments.rows.length,
        audits: audits.rows.length,
        alerts: alerts.rows.length,
      };
    });
    expect(aal2Results.shops).toBeGreaterThanOrEqual(2);
    expect(aal2Results.payments).toBeGreaterThanOrEqual(2);
    expect(aal2Results.audits).toBeGreaterThanOrEqual(1);
    expect(aal2Results.alerts).toBe(1);
  });

  it('audits EVERY public function across Phases 1–3c: no EXECUTE for anon/PUBLIC, empty search_path on SECURITY DEFINER, and strict p_shop_id session binding', async () => {
    const audit = await ctx.db.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      args: string;
      anon_exec: boolean;
      public_exec: boolean;
      auth_exec: boolean;
      service_exec: boolean;
    }>(
      `SELECT
         p.proname,
         p.prosecdef,
         p.proconfig,
         pg_get_function_identity_arguments(p.oid) AS args,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         EXISTS (
           SELECT 1
             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         ) AS public_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
       ORDER BY p.proname`
    );

    const expectedPhase3Functions = [
      'lock_authorized_shop_for_write',
      'record_sale',
      'undo_sale',
      'record_repayment',
      'apply_stock_count',
      'resolve_stock_conflict',
      'upsert_shop_item',
      'upsert_shop_customer',
      'upsert_shop_expense',
      'resolve_sync_conflict',
      'apply_sync_batch',
      'reconcile_shop_ledger',
      'parse_strict_kwacha_to_ngwee',
      'parse_strict_integer_ngwee',
      'parse_strict_bounded_int',
      'import_shop_backup',
    ];

    const foundNames = new Set(audit.rows.map((r) => r.proname));
    expect(
      audit.rows.length,
      'no ambiguous duplicate function overloads should exist in public'
    ).toBe(foundNames.size);
    for (const expectedName of expectedPhase3Functions) {
      expect(foundNames.has(expectedName), `expected public.${expectedName} to exist`).toBe(true);
    }

    for (const fn of audit.rows) {
      expect(fn.anon_exec, `anon must NOT have EXECUTE on public.${fn.proname}`).toBe(false);
      expect(fn.public_exec, `PUBLIC must NOT have EXECUTE on public.${fn.proname}`).toBe(false);
      if (fn.prosecdef) {
        expect(
          fn.proconfig?.some((c) => c === 'search_path=""' || c === "search_path=''"),
          `SECURITY DEFINER public.${fn.proname} must set search_path = ''`
        ).toBe(true);
      }
    }

    // Internal helper functions must NOT be callable directly by authenticated clients
    for (const internalHelper of [
      'lock_authorized_shop_for_write',
      'parse_strict_kwacha_to_ngwee',
      'parse_strict_integer_ngwee',
      'parse_strict_bounded_int',
    ]) {
      const row = audit.rows.find((r) => r.proname === internalHelper);
      expect(
        row?.auth_exec,
        `authenticated must NOT EXECUTE internal helper ${internalHelper}`
      ).toBe(false);
    }

    // Cross-shop p_shop_id check: verifiedOwnerA (verified for shopAId) MUST be denied on every
    // p_shop_id RPC when passing shopBId, and an OTP-only session (no verified shop_id)
    // MUST be denied even when passing shopAId.
    const verifiedOwnerA: TestIdentity = {
      ...ownerA,
    };
    const otpOnlyOwnerA: TestIdentity = {
      ...ownerA,
      appMetadata: { pending_pin_verification: true },
    };

    console.info(
      '[PRIVILEGE AUDIT]\n' +
        audit.rows
          .map(
            (r) =>
              `${r.proname}(${r.args}) | secdef=${r.prosecdef} | search_path=${JSON.stringify(r.proconfig ?? [])} | anon=${r.anon_exec} | public=${r.public_exec} | auth=${r.auth_exec} | service=${r.service_exec}`
          )
          .join('\n')
    );

    const crossShopCalls: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: 'record_sale',
        sql: `SELECT public.record_sale($1::uuid, 'op_priv_1', 'sale_priv_1', '[]'::jsonb, 'cash', 'RCP-PRIV-1')`,
        params: [shopBId],
      },
      {
        label: 'undo_sale',
        sql: `SELECT public.undo_sale($1::uuid, 'op_priv_2', 'sale_b_1')`,
        params: [shopBId],
      },
      {
        label: 'record_repayment',
        sql: `SELECT public.record_repayment($1::uuid, 'op_priv_3', 'pay_priv_1', 'cust_b_1', 100)`,
        params: [shopBId],
      },
      {
        label: 'apply_stock_count',
        sql: `SELECT public.apply_stock_count($1::uuid, 'op_priv_4', 'item_1', 'delta', 1)`,
        params: [shopBId],
      },
      {
        label: 'resolve_stock_conflict',
        sql: `SELECT public.resolve_stock_conflict($1::uuid, 'op_priv_5', 'conf_1')`,
        params: [shopBId],
      },
      {
        label: 'upsert_shop_item',
        sql: `SELECT public.upsert_shop_item($1::uuid, 'op_priv_6', 'item_priv', '{"name":"X","selling_price_ngwee":100}'::jsonb)`,
        params: [shopBId],
      },
      {
        label: 'upsert_shop_customer',
        sql: `SELECT public.upsert_shop_customer($1::uuid, 'op_priv_7', 'cust_priv', '{"name":"Y"}'::jsonb)`,
        params: [shopBId],
      },
      {
        label: 'upsert_shop_expense',
        sql: `SELECT public.upsert_shop_expense($1::uuid, 'op_priv_8', 'exp_priv', '{"category":"other","amount_ngwee":100}'::jsonb)`,
        params: [shopBId],
      },
      {
        label: 'resolve_sync_conflict',
        sql: `SELECT public.resolve_sync_conflict($1::uuid, 'op_priv_9', 'discard-poison', '{}'::jsonb, NULL)`,
        params: [shopBId],
      },
      {
        label: 'apply_sync_batch',
        sql: `SELECT public.apply_sync_batch($1::uuid, '[]'::jsonb)`,
        params: [shopBId],
      },
      {
        label: 'reconcile_shop_ledger',
        sql: `SELECT public.reconcile_shop_ledger($1::uuid)`,
        params: [shopBId],
      },
      {
        label: 'import_shop_backup',
        sql: `SELECT public.import_shop_backup($1::uuid, 'op_priv_12', repeat('a', 64), '{"format":"shopbook-backup-v1"}'::jsonb, true, false)`,
        params: [shopBId],
      },
    ];

    for (const check of crossShopCalls) {
      await expect(
        ctx.asUser(verifiedOwnerA, (tx) => tx.query(check.sql, check.params)),
        `verifiedOwnerA must be denied cross-shop access on ${check.label}`
      ).rejects.toThrow(/Verified shop session|Not authorized|permission denied|MFA/i);

      await expect(
        ctx.asUser(otpOnlyOwnerA, (tx) => tx.query(check.sql, [shopAId])),
        `unverified OTP-only session must be denied on ${check.label}`
      ).rejects.toThrow(/Verified shop session|Not authorized|permission denied|MFA/i);
    }
  });
});
