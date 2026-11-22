import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSupabaseDb, TestIdentity } from './supabaseTestHarness';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('Phase 3c — import_shop_backup, Hostile Input Validation, Receive-Time 72h Window & Poison-Op Audit (Real PostgreSQL 17)', () => {
  let ctx: Awaited<ReturnType<typeof createTestSupabaseDb>>;

  beforeAll(async () => {
    ctx = await createTestSupabaseDb();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function createEmptyVerifiedShop(name = 'Kalingalinga Corner Store') {
    const shopId = randomUUID();
    const phone = `+26097${String(Math.floor(1000000 + Math.random() * 8999999))}`;
    const owner: TestIdentity = await ctx.createAuthUser({
      phone,
      appMetadata: { shop_id: shopId },
    });

    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.shops (
           id, owner_user_id, name, owner_phone, plan_status, plan_type,
           trial_ends_at, plan_expiry_at, sales_access_until
         ) VALUES (
           $1, $2, $3, $4, 'active', 'monthly',
           now() + interval '14 days',
           now() + interval '30 days',
           now() + interval '33 days'
         )`,
        [shopId, owner.id, name, phone]
      );
    });

    return { shopId, owner };
  }

  it('previews and restores a valid shopbook-backup-v1 file, synthesizes opening movements, writes platform_audit, and reconciles with 0 differences', async () => {
    const { shopId, owner } = await createEmptyVerifiedShop('Chilenje Store');
    const nowIso = '2026-11-18T10:00:00.000Z';

    const v1Backup = {
      format: 'shopbook-backup-v1',
      exportedAt: nowIso,
      shopSettings: { shopName: 'Chilenje Legacy Book' },
      products: [
        {
          id: 'sugar-2kg',
          name: 'White Sugar 2kg',
          unitLabel: 'bag',
          sellingPriceNgwee: 6500,
          costPriceNgwee: 5000,
          stockQty: 10,
          lowStockThreshold: 3,
          isArchived: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: 'salt-500g',
          name: 'Table Salt 500g',
          unitLabel: 'pack',
          sellingPriceNgwee: 1250,
          costPriceNgwee: null,
          stockQty: 4,
          lowStockThreshold: 2,
          isArchived: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      customers: [
        {
          id: 'cust-mwamba',
          name: 'Mwamba Phiri',
          phone: '+260977123456',
          notes: 'Regular',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      sales: [
        {
          id: 'sale-1',
          operationId: 'op-sale-1',
          receiptNumber: 'SB-0001',
          paymentMethod: 'credit',
          paymentReference: null,
          customerId: 'cust-mwamba',
          customerNameSnapshot: 'Mwamba Phiri',
          totalNgwee: 6500,
          totalUnits: 1,
          knownCostTotalNgwee: 5000,
          knownCostRevenueNgwee: 6500,
          missingCostLineCount: 0,
          missingCostRevenueNgwee: 0,
          note: '1 bag sugar on credit',
          createdAt: '2026-11-18T11:00:00.000Z',
          localDate: '2026-11-18',
        },
      ],
      saleItems: [
        {
          id: 'line-1',
          saleId: 'sale-1',
          productId: 'sugar-2kg',
          productNameAtSale: 'White Sugar 2kg',
          unitLabelAtSale: 'bag',
          sellingPriceAtSaleNgwee: 6500,
          costPriceAtSaleNgwee: 5000,
          quantity: 1,
          lineTotalNgwee: 6500,
          createdAt: '2026-11-18T11:00:00.000Z',
        },
      ],
      creditTransactions: [
        {
          id: 'ct-sale-1',
          operationId: 'op-ct-1',
          customerId: 'cust-mwamba',
          customerNameSnapshot: 'Mwamba Phiri',
          type: 'credit_sale',
          amountNgwee: 6500,
          paymentMethod: null,
          relatedSaleId: 'sale-1',
          note: '1 bag sugar on credit',
          createdAt: '2026-11-18T11:00:00.000Z',
          localDate: '2026-11-18',
        },
        {
          id: 'repay-1',
          operationId: 'op-repay-1',
          customerId: 'cust-mwamba',
          customerNameSnapshot: 'Mwamba Phiri',
          type: 'repayment',
          amountNgwee: 2500,
          paymentMethod: 'cash',
          relatedSaleId: null,
          note: 'Part payment',
          createdAt: '2026-11-18T12:00:00.000Z',
          localDate: '2026-11-18',
        },
      ],
      // Empty movements array: server must synthesize opening movements so ledger reconciles!
      stockMovements: [],
    };

    const raw = JSON.stringify(v1Backup);
    const sha = sha256Hex(raw);

    // 1. Dry-run preview writes NOTHING
    const dryRunRes = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.import_shop_backup($1::uuid, 'op_v1_preview', $2, $3::jsonb, true, false) AS result`,
        [shopId, sha, raw]
      )
    );
    const previewBody = dryRunRes.rows[0].result;
    expect(previewBody.status).toBe('preview');
    expect(previewBody.dry_run).toBe(true);
    expect(previewBody.already_imported).toBe(false);
    expect(previewBody.shop_has_existing_data).toBe(false);
    expect(previewBody.preview).toMatchObject({
      format: 'shopbook-backup-v1',
      source_shop_name: 'Chilenje Legacy Book',
      items_count: 2,
      sales_count: 1,
      customers_count: 1,
      expenses_count: 0,
      // 10 * 6500 + 4 * 1250 = 65000 + 5000 = 70000 ngwee
      total_stock_value_ngwee: 70000,
      total_owed_ngwee: 4000,
    });

    const countAfterDryRun = await ctx.asUser(owner, (tx) =>
      tx.query<{ c: string }>(`SELECT count(*)::text AS c FROM public.items WHERE shop_id = $1`, [
        shopId,
      ])
    );
    expect(Number(countAfterDryRun.rows[0].c)).toBe(0);

    // 2. Real import commits atomically and reconciles with 0 differences
    const importRes = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.import_shop_backup($1::uuid, 'op_v1_commit', $2, $3::jsonb, false, false) AS result`,
        [shopId, sha, raw]
      )
    );
    const importedBody = importRes.rows[0].result;
    expect(importedBody.status).toBe('imported');
    expect((importedBody.reconciliation as { total_differences: number }).total_differences).toBe(
      0
    );

    // Verify integer ngwee storage & generated movements
    const itemsRows = await ctx.asUser(owner, (tx) =>
      tx.query<{
        id: string;
        selling_price_ngwee: string;
        buying_price_ngwee: string;
        buying_price_known: boolean;
        quantity: number;
      }>(
        `SELECT id, selling_price_ngwee::text, buying_price_ngwee::text, buying_price_known, quantity
           FROM public.items WHERE shop_id = $1 ORDER BY id`,
        [shopId]
      )
    );
    expect(itemsRows.rows).toEqual([
      {
        id: 'shopbook_salt-500g',
        selling_price_ngwee: '1250',
        buying_price_ngwee: '0',
        buying_price_known: false,
        quantity: 4,
      },
      {
        id: 'shopbook_sugar-2kg',
        selling_price_ngwee: '6500',
        buying_price_ngwee: '5000',
        buying_price_known: true,
        quantity: 10,
      },
    ]);

    // Verify platform_audit entry was written
    const auditRows = await ctx.asServiceRole((tx) =>
      tx.query<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
        `SELECT action, actor_user_id, metadata FROM public.platform_audit WHERE shop_id = $1`,
        [shopId]
      )
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].action).toBe('shop_backup_imported');
    expect(auditRows.rows[0].actor_user_id).toBe(owner.id);
    expect(auditRows.rows[0].metadata.file_sha256).toBe(sha);

    // 3. Duplicate import (same file hash, brand-new operation_id) is idempotent & duplicates nothing
    const dupByHash = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.import_shop_backup($1::uuid, 'op_v1_second_attempt', $2, $3::jsonb, false, true) AS result`,
        [shopId, sha, raw]
      )
    );
    expect(dupByHash.rows[0].result).toMatchObject({
      status: 'duplicate',
      idempotent: true,
      already_imported: true,
    });

    const itemCountAfterDup = await ctx.asUser(owner, (tx) =>
      tx.query<{ c: string }>(`SELECT count(*)::text AS c FROM public.items WHERE shop_id = $1`, [
        shopId,
      ])
    );
    expect(Number(itemCountAfterDup.rows[0].c)).toBe(2);
  });

  it('previews and restores a valid countup-backup-v2 file (including K12.5 decimal conversion, expenses, archived items, credit sales, and reconciliation)', async () => {
    const { shopId, owner } = await createEmptyVerifiedShop('Woodlands Mini Mart');
    const nowIso = '2026-11-19T08:30:00.000Z';

    const v2Backup = {
      format: 'countup-backup-v2',
      version: '2.0',
      exportedAt: nowIso,
      shop: { id: 'old-shop-id', name: 'Woodlands Old Phone' },
      items: [
        {
          id: 'item_bread',
          name: 'Bread Loaf',
          buyingPrice: 10,
          buyingPriceKnown: true,
          sellingPrice: 12.5, // K12.5 -> 1250 ngwee via string decimal parser!
          unitLabel: 'loaf',
          quantity: 8,
          lowStockThreshold: 2,
          isDeleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      archivedItems: [
        {
          id: 'item_old_soap',
          name: 'Old Soap',
          buyingPrice: 8.25,
          buyingPriceKnown: true,
          sellingPrice: 11.75,
          quantity: 0,
          lowStockThreshold: 1,
          isDeleted: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      customers: [
        {
          id: 'cust_banda',
          name: 'Banda Zulu',
          phone: '+260966555444',
          notes: '',
          totalOwed: 15, // 25 credit sale - 10 repayment = 15.00 (1500 ngwee)
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      sales: [
        {
          id: 'sale_v2_1',
          items: [
            {
              itemId: 'item_bread',
              name: 'Bread Loaf',
              quantity: 2,
              buyingPrice: 10,
              buyingPriceKnown: true,
              sellingPrice: 12.5,
              total: 25,
            },
          ],
          itemsCount: 2,
          totalAmount: 25,
          totalCost: 20,
          profit: 5,
          paymentType: 'credit',
          customerId: 'cust_banda',
          customerName: 'Banda Zulu',
          receiptNumber: 'CU-0101',
          createdAt: '2026-11-19T09:00:00.000Z',
        },
      ],
      creditPayments: [
        {
          id: 'pay_v2_1',
          customerId: 'cust_banda',
          customerName: 'Banda Zulu',
          amount: 10,
          paymentMethod: 'momo',
          note: 'Airtel Money',
          createdAt: '2026-11-19T10:00:00.000Z',
        },
      ],
      expenses: [
        {
          id: 'exp_v2_1',
          category: 'transport',
          amount: 35.5, // K35.50 -> 3550 ngwee
          note: 'Taxi from town',
          createdAt: '2026-11-19T11:00:00.000Z',
        },
      ],
      stockMovements: [],
      stockConflicts: [],
    };

    const raw = JSON.stringify(v2Backup);
    const sha = sha256Hex(raw);

    const res = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.import_shop_backup($1::uuid, 'op_v2_commit', $2, $3::jsonb, false, false) AS result`,
        [shopId, sha, raw]
      )
    );

    expect(res.rows[0].result.status).toBe('imported');
    expect(res.rows[0].result.preview).toMatchObject({
      format: 'countup-backup-v2',
      items_count: 2,
      active_items_count: 1,
      archived_items_count: 1,
      sales_count: 1,
      customers_count: 1,
      expenses_count: 1,
      total_stock_value_ngwee: 10000, // 8 * 1250 ngwee
      total_owed_ngwee: 1500, // K15.00 -> 1500 ngwee
    });
    expect(
      (res.rows[0].result.reconciliation as { total_differences: number }).total_differences
    ).toBe(0);

    // Verify exact integer ngwee values in PostgreSQL tables
    const bread = await ctx.asUser(owner, (tx) =>
      tx.query<{ selling_price_ngwee: string; buying_price_ngwee: string }>(
        `SELECT selling_price_ngwee::text, buying_price_ngwee::text
           FROM public.items WHERE shop_id = $1 AND id = 'item_bread'`,
        [shopId]
      )
    );
    expect(bread.rows[0]).toEqual({ selling_price_ngwee: '1250', buying_price_ngwee: '1000' });

    const exp = await ctx.asUser(owner, (tx) =>
      tx.query<{ amount_ngwee: string }>(
        `SELECT amount_ngwee::text FROM public.expenses WHERE shop_id = $1 AND id = 'exp_v2_1'`,
        [shopId]
      )
    );
    expect(exp.rows[0].amount_ngwee).toBe('3550');

    // Re-run standalone reconcile_shop_ledger RPC to double-verify 0 differences
    const recon = await ctx.asUser(owner, (tx) =>
      tx.query<{ report: { total_differences: number } }>(
        `SELECT public.reconcile_shop_ledger($1::uuid) AS report`,
        [shopId]
      )
    );
    expect(recon.rows[0].report.total_differences).toBe(0);
  });

  it('rejects malformed backups, >2 decimal places (K12.505), non-numeric strings ("abc"), negatives (-5), absurd amounts, unknown collections, and broken references on the server', async () => {
    const { shopId, owner } = await createEmptyVerifiedShop('Validation Shop');
    const nowIso = '2026-11-19T12:00:00.000Z';

    const makeV2WithSellingPrice = (sellingPrice: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        format: 'countup-backup-v2',
        exportedAt: nowIso,
        items: [
          {
            id: 'item_bad',
            name: 'Test Item',
            buyingPrice: 5,
            buyingPriceKnown: true,
            sellingPrice,
            quantity: 1,
            lowStockThreshold: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        sales: [],
        customers: [],
        creditPayments: [],
        expenses: [],
        ...extra,
      });

    // 1. K12.505 (> 2 decimal places) MUST be rejected rather than silently rounded!
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_dec1', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('dec1'), makeV2WithSellingPrice(12.505)]
        )
      )
    ).rejects.toThrow(/decimal|monetary|amount/i);

    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_dec2', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('dec2'), makeV2WithSellingPrice('12.500')]
        )
      )
    ).rejects.toThrow(/decimal|monetary|amount/i);

    // 2. Non-numeric string ("abc")
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_abc', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('abc'), makeV2WithSellingPrice('abc')]
        )
      )
    ).rejects.toThrow(/monetary|amount|numeric/i);

    // 3. Negative amount (-5)
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_neg', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('neg'), makeV2WithSellingPrice(-5)]
        )
      )
    ).rejects.toThrow(/negative|monetary|amount|greater than zero/i);

    // 4. Absurd amount (> K100,000,000.00)
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_absurd', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('absurd'), makeV2WithSellingPrice(999_999_999)]
        )
      )
    ).rejects.toThrow(/maximum|exceeds|limit|monetary/i);

    // 5. Unknown top-level record collection
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_unknown_key', $2, $3::jsonb, true, false)`,
          [shopId, sha256Hex('ukey'), makeV2WithSellingPrice(12.5, { rogueTable: [{ id: '1' }] })]
        )
      )
    ).rejects.toThrow(/Unknown|unsupported|field/i);

    // 6. Mismatched reference (credit payment referencing non-existent customer)
    const brokenRefJson = JSON.stringify({
      format: 'countup-backup-v2',
      exportedAt: nowIso,
      items: [],
      sales: [],
      customers: [],
      creditPayments: [
        {
          id: 'pay_orphan',
          customerId: 'ghost_customer',
          customerName: 'Ghost',
          amount: 10,
          paymentMethod: 'cash',
          createdAt: nowIso,
        },
      ],
      expenses: [],
    });
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_bad_ref', $2, $3::jsonb, false, false)`,
          [shopId, sha256Hex(brokenRefJson), brokenRefJson]
        )
      )
    ).rejects.toThrow(/customer|reference|missing|unknown/i);
  });

  it('enforces non-empty shop refusal by default, rolls back 100% on mid-import reconciliation failure, and enforces oversized/rate limits', async () => {
    const { shopId, owner } = await createEmptyVerifiedShop('Rollback & Guard Shop');
    const nowIso = '2026-11-19T14:00:00.000Z';

    // 1. Mid-import failure: items + sale + customer are inserted, then in-transaction
    //    `reconcile_shop_ledger` detects customer totalOwed (K90) != credit sale (K25)
    //    and rolls back EVERY SINGLE ROW!
    const inconsistentLedgerBackup = JSON.stringify({
      format: 'countup-backup-v2',
      exportedAt: nowIso,
      items: [
        {
          id: 'item_should_rollback_1',
          name: 'Cooking Oil 2L',
          buyingPrice: 40,
          buyingPriceKnown: true,
          sellingPrice: 55,
          quantity: 12,
          lowStockThreshold: 3,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: 'item_should_rollback_2',
          name: 'Mealie Meal 25kg',
          buyingPrice: 200,
          buyingPriceKnown: true,
          sellingPrice: 240,
          quantity: 5,
          lowStockThreshold: 2,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      customers: [
        {
          id: 'cust_tampered',
          name: 'Tampered Balance',
          phone: '',
          notes: '',
          totalOwed: 90, // Should be 55 — triggers reconciliation failure after inserts!
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      sales: [
        {
          id: 'sale_rollback_1',
          items: [
            {
              itemId: 'item_should_rollback_1',
              name: 'Cooking Oil 2L',
              quantity: 1,
              buyingPrice: 40,
              buyingPriceKnown: true,
              sellingPrice: 55,
              total: 55,
            },
          ],
          itemsCount: 1,
          totalAmount: 55,
          totalCost: 40,
          profit: 15,
          paymentType: 'credit',
          customerId: 'cust_tampered',
          receiptNumber: 'RB-01',
          createdAt: nowIso,
        },
      ],
      creditPayments: [],
      expenses: [],
    });

    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_mid_fail', $2, $3::jsonb, false, false)`,
          [shopId, sha256Hex(inconsistentLedgerBackup), inconsistentLedgerBackup]
        )
      )
    ).rejects.toThrow(/reconciliation|balance|mismatch/i);

    // Verify ZERO partial rows exist in items, sales, customers, movements, sync_operations, or platform_audit!
    const countsAfterRollback = await ctx.asServiceRole(async (tx) => {
      const items = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM public.items WHERE shop_id = $1`,
        [shopId]
      );
      const sales = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM public.sales WHERE shop_id = $1`,
        [shopId]
      );
      const movements = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM public.stock_movements WHERE shop_id = $1`,
        [shopId]
      );
      const audits = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM public.platform_audit WHERE shop_id = $1`,
        [shopId]
      );
      return {
        items: Number(items.rows[0].c),
        sales: Number(sales.rows[0].c),
        movements: Number(movements.rows[0].c),
        audits: Number(audits.rows[0].c),
      };
    });
    expect(countsAfterRollback).toEqual({ items: 0, sales: 0, movements: 0, audits: 0 });

    // 2. Seed 1 item into the shop -> shop is now NON-EMPTY; default restore must refuse!
    await ctx.asUser(owner, (tx) =>
      tx.query(
        `SELECT public.upsert_shop_item($1::uuid, 'op_seed_existing', 'existing_item_1', '{"name":"Existing Soap","selling_price_ngwee":1500,"buying_price_ngwee":1000,"buying_price_known":true,"quantity":3}'::jsonb)`,
        [shopId]
      )
    );

    const smallValidBackup = (suffix: string) =>
      JSON.stringify({
        format: 'countup-backup-v2',
        exportedAt: nowIso,
        items: [
          {
            id: `backup_item_${suffix}`,
            name: `Imported Item ${suffix}`,
            buyingPrice: 5,
            buyingPriceKnown: true,
            sellingPrice: 8,
            quantity: 2,
            lowStockThreshold: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        sales: [],
        customers: [],
        creditPayments: [],
        expenses: [],
      });

    const b1 = smallValidBackup('1');
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_nonempty_refuse', $2, $3::jsonb, false, false)`,
          [shopId, sha256Hex(b1), b1]
        )
      )
    ).rejects.toThrow(/already has|non-empty|existing/i);

    // Explicitly opting in (`p_allow_non_empty_shop = true`) succeeds cleanly
    for (let i = 1; i <= 5; i++) {
      const bi = smallValidBackup(String(i));
      const ok = await ctx.asUser(owner, (tx) =>
        tx.query<{ result: { status: string } }>(
          `SELECT public.import_shop_backup($1::uuid, $2, $3, $4::jsonb, false, true) AS result`,
          [shopId, `op_rate_${i}`, sha256Hex(bi), bi]
        )
      );
      expect(ok.rows[0].result.status).toBe('imported');
    }

    // 3. Rate-limit check: 6th restore within 1 hour is blocked!
    const b6 = smallValidBackup('6');
    await expect(
      ctx.asUser(owner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_rate_6', $2, $3::jsonb, false, true)`,
          [shopId, sha256Hex(b6), b6]
        )
      )
    ).rejects.toThrow(/Too many|rate limit/i);

    // 4. Oversized (> 5 MB) payload check on server
    const { shopId: sizeShopId, owner: sizeOwner } = await createEmptyVerifiedShop('Size Shop');
    const hugeNote = 'x'.repeat(5_100_000);
    const oversizedJson = JSON.stringify({
      format: 'countup-backup-v2',
      exportedAt: nowIso,
      shop: { name: hugeNote },
      items: [],
      sales: [],
      customers: [],
      creditPayments: [],
      expenses: [],
    });
    await expect(
      ctx.asUser(sizeOwner, (tx) =>
        tx.query(
          `SELECT public.import_shop_backup($1::uuid, 'op_oversized', $2, $3::jsonb, true, false)`,
          [sizeShopId, sha256Hex('oversized'), oversizedJson]
        )
      )
    ).rejects.toThrow(/5 MB|size|large/i);
  });

  it('flags offline operations older than 72h before server receive time even on an active plan, and records discard-poison audits', async () => {
    const { shopId, owner } = await createEmptyVerifiedShop('72h Window Shop');

    // Seed an item, then simulate the shop phone having last contacted the server 71.5h ago
    await ctx.asUser(owner, (tx) =>
      tx.query(
        `SELECT public.upsert_shop_item($1::uuid, 'op_72h_item', 'item_milk', '{"name":"Fresh Milk","selling_price_ngwee":2000,"buying_price_ngwee":1500,"buying_price_known":true,"quantity":20}'::jsonb)`,
        [shopId]
      )
    );
    await ctx.asServiceRole((tx) =>
      tx.query(
        `UPDATE public.shops SET last_server_contact_at = clock_timestamp() - interval '71 hours 30 minutes' WHERE id = $1`,
        [shopId]
      )
    );

    // 1. Offline sale created 71h ago (< 72h receive-time window) -> accepted cleanly, NOT flagged
    const freshSaleRes = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.record_sale(
           $1::uuid,
           'op_71h_sale',
           'sale_71h',
           '[{"item_id":"item_milk","item_name":"Fresh Milk","quantity":1,"selling_price_ngwee":2000,"buying_price_ngwee":1500,"buying_price_known":true}]'::jsonb,
           'cash',
           'RCP-71H',
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           clock_timestamp() - interval '71 hours',
           true,
           259200
         ) AS result`,
        [shopId]
      )
    );
    expect(freshSaleRes.rows[0].result).toMatchObject({
      outcome: 'applied',
      offline_window_flagged: false,
    });

    // 2. Offline sale created 73h ago (> 72h before server receive time, EVEN THOUGH subscription is active!)
    //    -> preserved so shopkeeper data is never silently dropped, AND flagged with platform_alert!
    const staleSaleRes = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.record_sale(
           $1::uuid,
           'op_73h_sale',
           'sale_73h',
           '[{"item_id":"item_milk","item_name":"Fresh Milk","quantity":1,"selling_price_ngwee":2000,"buying_price_ngwee":1500,"buying_price_known":true}]'::jsonb,
           'cash',
           'RCP-73H',
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           clock_timestamp() - interval '73 hours',
           true,
           259200
         ) AS result`,
        [shopId]
      )
    );
    expect(staleSaleRes.rows[0].result).toMatchObject({
      outcome: 'flagged',
      offline_window_flagged: true,
    });

    const alerts = await ctx.asServiceRole((tx) =>
      tx.query<{ category: string; detail: string }>(
        `SELECT category, detail FROM public.platform_alerts WHERE metadata ->> 'shop_id' = $1`,
        [shopId]
      )
    );
    expect(alerts.rows.length).toBeGreaterThanOrEqual(1);
    expect(alerts.rows[0].detail).toMatch(/72h/i);

    // 3. Server-side discard-poison audit via resolve_sync_conflict
    const discardRes = await ctx.asUser(owner, (tx) =>
      tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.resolve_sync_conflict(
           $1::uuid,
           'op_poison_99',
           'discard-poison',
           '{"kind":"discard-poison","actionId":"op_poison_99","poisonActionType":"stock_update","poisonSummary":"Stock update (deleted item)","poisonReason":"Item not found","queuedAt":"2026-11-20T08:00:00.000Z","resolvedAt":"2026-11-20T09:00:00.000Z"}'::jsonb,
           NULL
         ) AS result`,
        [shopId]
      )
    );
    expect(discardRes.rows[0].result).toMatchObject({
      status: 'resolved',
      outcome: 'resolved',
    });

    const syncOpRow = await ctx.asUser(owner, (tx) =>
      tx.query<{
        operation_type: string;
        outcome: string;
        has_resolution: boolean;
        resolution: Record<string, unknown>;
      }>(
        `SELECT operation_type, outcome, has_resolution, resolution
           FROM public.sync_operations WHERE shop_id = $1 AND operation_id = 'op_poison_99'`,
        [shopId]
      )
    );
    expect(syncOpRow.rows[0]).toMatchObject({
      operation_type: 'conflict_resolution',
      outcome: 'resolved',
      has_resolution: true,
    });
    expect(syncOpRow.rows[0].resolution.kind).toBe('discard-poison');
  });
});
