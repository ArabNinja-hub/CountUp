import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKUP_CHUNK_MAX_ROWS,
  buildBackupImportChunks,
  prepareShopBackupImport,
} from '../../services/backupImport';
import { SYNC_BATCH_CHUNK_SIZE } from '../shopWriteRpc';
import { createTestSupabaseDb, TestIdentity } from './supabaseTestHarness';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('Pre-4 Benchmarks & Phase 4 Subscriptions / Manual Mobile-Money Payments (Real PostgreSQL 17)', () => {
  let ctx: Awaited<ReturnType<typeof createTestSupabaseDb>>;
  let adminAal2: TestIdentity;
  let adminAal1: TestIdentity;

  beforeAll(async () => {
    ctx = await createTestSupabaseDb();
    adminAal2 = await ctx.createAuthUser({
      email: 'admin-mfa@countup.zm',
      emailVerified: true,
      aal: 'aal2',
      appMetadata: { platform_admin: true },
    });
    adminAal1 = await ctx.createAuthUser({
      email: 'admin-no-mfa@countup.zm',
      emailVerified: true,
      aal: 'aal1',
      appMetadata: { platform_admin: true },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function createShopWithPinState(
    options: {
      name?: string;
      withPinCredentials?: boolean;
      sessionVerified?: boolean;
      planStatus?: 'trial' | 'active' | 'expired' | 'suspended';
      planExpiryAtIso?: string | null;
      salesAccessUntilIso?: string | null;
      isDeactivated?: boolean;
    } = {}
  ) {
    const shopId = randomUUID();
    const sessionId = randomUUID();
    const phone = `+26097${String(Math.floor(1000000 + Math.random() * 8999999))}`;
    const owner = await ctx.createAuthUser({
      phone,
      sessionId,
      appMetadata: { shop_id: shopId },
    });

    const status = options.planStatus ?? 'trial';
    const isDeactivated = Boolean(options.isDeactivated);
    const initialBaseIso =
      options.planExpiryAtIso ??
      (status === 'active' || status === 'trial'
        ? new Date(Date.now() + 30 * 86_400_000).toISOString()
        : new Date(Date.now() - 4 * 86_400_000).toISOString());
    const initialSalesAccessIso =
      options.salesAccessUntilIso ??
      new Date(Date.parse(initialBaseIso) + 3 * 86_400_000).toISOString();

    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.shops (
           id, owner_user_id, name, owner_phone, plan_status, plan_type,
           trial_ends_at, plan_expiry_at, sales_access_until, is_deactivated,
           status_before_suspension
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7::timestamptz,
           $7::timestamptz,
           $8::timestamptz,
           $9,
           $10
         )`,
        [
          shopId,
          owner.id,
          options.name ?? 'Lusaka Market Store',
          phone,
          status,
          'monthly',
          initialBaseIso,
          initialSalesAccessIso,
          isDeactivated,
          isDeactivated ? 'trial' : null,
        ]
      );

      if (options.withPinCredentials) {
        await tx.query(
          `INSERT INTO public.shop_pin_credentials (
             shop_id, pin_salt, pin_hash, recovery_salt, recovery_hash
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            shopId,
            '0123456789abcdef0123456789abcdef',
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'fedcba9876543210fedcba9876543210',
            'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          ]
        );
        if (options.sessionVerified !== false) {
          await tx.query(
            `INSERT INTO public.shop_verified_sessions (shop_id, user_id, session_id)
             VALUES ($1, $2, $3)`,
            [shopId, owner.id, sessionId]
          );
        }
      }
    });

    return { shopId, owner, phone, sessionId };
  }

  it('Pre-4 Check 1 & 5: benchmarks max-size apply_sync_batch (250 sales) and verifies >72h late-sync info note + calm shopkeeper_notice', async () => {
    const { shopId, owner } = await createShopWithPinState({
      name: 'Batch Benchmark Shop',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'active',
    });

    // Seed item with plenty of stock
    await ctx.asUser(owner, async (tx) => {
      await tx.query(
        `SELECT public.upsert_shop_item(
           $1::uuid,
           'op-seed-item',
           'bench-item-1',
           $2::jsonb,
           $3::jsonb
         )`,
        [
          shopId,
          JSON.stringify({
            name: 'Cooking Oil 2.5L',
            buying_price_ngwee: 8000,
            buying_price_known: true,
            selling_price_ngwee: 10000,
            unit_label: 'bottle',
            quantity: 5000,
            low_stock_threshold: 10,
          }),
          JSON.stringify({
            id: 'mov-seed-1',
            type: 'initial',
            quantity_delta: 5000,
            new_quantity: 5000,
          }),
        ]
      );
    });

    const operations = Array.from({ length: SYNC_BATCH_CHUNK_SIZE }, (_, idx) => {
      const isLateOfflineSale = idx === SYNC_BATCH_CHUNK_SIZE - 1;
      const clientCreatedAt = isLateOfflineSale
        ? new Date(Date.now() - 96 * 3600 * 1000).toISOString() // 96h old (>72h)
        : new Date(Date.now() - 60_000).toISOString();
      return {
        rpc: 'record_sale',
        operation_id: `op-bench-sale-${idx}`,
        sale_id: `sale-bench-${idx}`,
        lines: [
          {
            item_id: 'bench-item-1',
            item_name: 'Cooking Oil 2.5L',
            quantity: 1,
            selling_price_ngwee: 10000,
            buying_price_ngwee: 8000,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: `B-${idx + 1}`,
        local_date: '2026-11-20',
        client_created_at: clientCreatedAt,
        is_offline_sync: true,
        offline_window_seconds: 72 * 3600,
      };
    });

    const t0 = performance.now();
    const batchRes = await ctx.asUser(owner, async (tx) => {
      const r = await tx.query<{ result: { results: Array<Record<string, unknown>> } }>(
        `SELECT public.apply_sync_batch($1::uuid, $2::jsonb) AS result`,
        [shopId, JSON.stringify(operations)]
      );
      return r.rows[0]!.result;
    });
    const elapsedMs = Math.round(performance.now() - t0);

    expect(batchRes.results).toHaveLength(SYNC_BATCH_CHUNK_SIZE);
    expect(batchRes.results.every((entry) => entry.ok === true)).toBe(true);
    // Max-size 250-op batch should complete well below PostgREST statement timeout
    expect(elapsedMs).toBeLessThan(15_000);

    const lateOutcome = batchRes.results[SYNC_BATCH_CHUNK_SIZE - 1]!.result as Record<
      string,
      unknown
    >;
    expect(lateOutcome.offline_window_flagged).toBe(true);
    expect(lateOutcome.shopkeeper_notice).toBe('Synced late, kept');

    // Verify low-priority info/sync_note alert (NOT critical/warning security banner)
    const alertRows = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{
        severity: string;
        category: string;
        title: string;
        detail: string;
      }>(
        `SELECT severity, category, title, detail
         FROM public.platform_alerts
         WHERE (metadata ->> 'shop_id') = $1`,
        [shopId]
      );
      return r.rows;
    });
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]).toMatchObject({
      severity: 'info',
      category: 'sync_note',
    });
    expect(alertRows[0]!.detail).toContain('72h');
  }, 30_000);

  it('Pre-4 Check 1–4: restores a multi-year (~60k total rows, ~4.7 MB) CountUp v2 backup via staged chunked RPCs and reconciles with 0 differences', async () => {
    const { shopId, owner } = await createShopWithPinState({
      name: 'Two-Year Restore Target',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'active',
    });

    // Realistic 2+ years of shop history:
    // 50 items, 20 customers, 14,600 sales (20/day * 730 days), 22,000 sale_lines,
    // 400 credit repayments, 300 expenses, plus ~22,050 synthesized stock movements ≈ ~59,420 total rows (~4.6 MB JSON)
    const baseMs = Date.parse('2024-11-20T08:00:00.000Z');
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `item_${i}`,
      name: `Product ${i}`,
      buyingPrice: 12,
      buyingPriceKnown: true,
      sellingPrice: 18,
      unitLabel: 'unit',
      quantity: 1_000,
      lowStockThreshold: 5,
      createdAt: '2024-11-20T08:00:00.000Z',
    }));

    const customers = Array.from({ length: 20 }, (_, c) => ({
      id: `cust_${c}`,
      name: `Customer ${c}`,
      phone: `+260966000${String(c).padStart(3, '0')}`,
      totalOwed: 18, // 1 unpaid credit sale of K18 per customer after repayments
      createdAt: '2024-11-20T08:00:00.000Z',
    }));

    const sales = Array.from({ length: 14_600 }, (_, s) => {
      const secondLine = s < 7_400;
      const isCredit = s < 420; // 21 credit sales per customer = K378 total credit, minus 20 repayments of K18 = K18 owed!
      const custIdx = s % 20;
      const itemA = `item_${s % 50}`;
      const itemB = `item_${(s + 1) % 50}`;
      const lines =
        secondLine && !isCredit
          ? [
              {
                itemId: itemA,
                name: `Product ${s % 50}`,
                quantity: 1,
                sellingPrice: 18,
                buyingPrice: 12,
                buyingPriceKnown: true,
                total: 18,
              },
              {
                itemId: itemB,
                name: `Product ${(s + 1) % 50}`,
                quantity: 1,
                sellingPrice: 18,
                buyingPrice: 12,
                buyingPriceKnown: true,
                total: 18,
              },
            ]
          : [
              {
                itemId: itemA,
                name: `Product ${s % 50}`,
                quantity: 1,
                sellingPrice: 18,
                buyingPrice: 12,
                buyingPriceKnown: true,
                total: 18,
              },
            ];

      return {
        id: `s_${s}`,
        items: lines,
        itemsCount: lines.length,
        totalAmount: lines.length * 18,
        totalCost: lines.length * 12,
        profit: lines.length * 6,
        paymentType: isCredit ? ('credit' as const) : ('cash' as const),
        ...(isCredit ? { customerId: `cust_${custIdx}`, customerName: `Customer ${custIdx}` } : {}),
        createdAt: new Date(baseMs + s * 3_600_000).toISOString(),
      };
    });

    // 20 repayments of K18 per customer = 400 repayments
    const creditPayments = Array.from({ length: 400 }, (_, p) => {
      const custIdx = p % 20;
      return {
        id: `cp_${p}`,
        customerId: `cust_${custIdx}`,
        customerName: `Customer ${custIdx}`,
        amount: 18,
        paymentMethod: 'cash' as const,
        createdAt: new Date(baseMs + (500 + p) * 3_600_000).toISOString(),
      };
    });

    const expenses = Array.from({ length: 300 }, (_, e) => ({
      id: `ex_${e}`,
      category: 'transport',
      amount: 25,
      createdAt: new Date(baseMs + e * 86_400_000).toISOString(),
    }));

    const backupPayload = {
      format: 'countup-backup-v2',
      exportedAt: '2026-11-20T09:00:00.000Z',
      shop: { name: 'Matero Two-Year Wholesale' },
      items,
      sales,
      customers,
      creditPayments,
      expenses,
      stockMovements: [],
    };
    const rawJson = JSON.stringify(backupPayload);
    const rawBytes = new TextEncoder().encode(rawJson).byteLength;
    expect(rawBytes).toBeLessThan(5_000_000);
    expect(rawBytes).toBeGreaterThan(3_000_000);

    const prepared = prepareShopBackupImport(rawJson, shopId);
    expect(prepared.preview.primaryRecordsCount).toBe(50 + 14_600 + 20 + 400 + 300);
    expect(prepared.preview.totalRecordsCount).toBe(37_000);

    const chunks = buildBackupImportChunks(prepared, BACKUP_CHUNK_MAX_ROWS);
    const fileSha = sha256Hex(rawJson);

    const tStart = performance.now();
    const beginOut = await ctx.asUser(owner, async (tx) => {
      const r = await tx.query<{ res: Record<string, unknown> }>(
        `SELECT public.begin_shop_backup_import(
           $1::uuid,
           'op-chunked-2yr',
           $2,
           $3,
           $4::integer,
           $5::integer,
           $6,
           false
         ) AS res`,
        [shopId, fileSha, prepared.format, rawBytes, chunks.length, prepared.preview.sourceShopName]
      );
      return r.rows[0]!.res;
    });

    expect(beginOut.status).toBe('staging');
    const importSessionId = String(beginOut.session_id);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await ctx.asUser(owner, async (tx) => {
        await tx.query(
          `SELECT public.append_shop_backup_chunk(
             $1::uuid,
             $2::uuid,
             $3,
             $4,
             $5::jsonb
           )`,
          [shopId, importSessionId, chunk.chunkIndex, chunk.section, JSON.stringify(chunk.records)]
        );
      });
    }

    const finalOut = await ctx.asUser(owner, async (tx) => {
      const r = await tx.query<{ res: Record<string, unknown> }>(
        `SELECT public.finalize_shop_backup_import($1::uuid, $2::uuid, false) AS res`,
        [shopId, importSessionId]
      );
      return r.rows[0]!.res;
    });
    const chunkedElapsedMs = Math.round(performance.now() - tStart);

    expect(finalOut.status).toBe('imported');
    expect(finalOut.already_imported).toBe(false);
    expect(chunkedElapsedMs).toBeLessThan(45_000);

    // Verify reconciliation is 0 differences across all 59,000+ restored rows!
    const recon = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ rep: { total_differences: number } }>(
        `SELECT public.reconcile_shop_ledger($1::uuid) AS rep`,
        [shopId]
      );
      return r.rows[0]!.rep;
    });
    expect(recon.total_differences).toBe(0);

    // Idempotent duplicate replay on begin_shop_backup_import returns status = 'duplicate' immediately
    const dupBegin = await ctx.asUser(owner, async (tx) => {
      const r = await tx.query<{ res: Record<string, unknown> }>(
        `SELECT public.begin_shop_backup_import(
           $1::uuid,
           'op-chunked-2yr-retry',
           $2,
           $3,
           $4::integer,
           $5::integer,
           $6,
           false
         ) AS res`,
        [shopId, fileSha, prepared.format, rawBytes, chunks.length, prepared.preview.sourceShopName]
      );
      return r.rows[0]!.res;
    });
    expect(dupBegin.status).toBe('duplicate');
    expect(dupBegin.already_imported).toBe(true);
  }, 60_000);

  it('Phase 4: enforces server plan pricing, PIN-verified session, cross-shop isolation, operator-scoped reference lock, release-on-reject, and idempotent replay', async () => {
    const shopA = await createShopWithPinState({
      name: 'Shop A (Verified)',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'trial',
    });
    const shopUnverified = await createShopWithPinState({
      name: 'Shop Unverified Session',
      withPinCredentials: true,
      sessionVerified: false,
      planStatus: 'trial',
    });
    const shopB = await createShopWithPinState({
      name: 'Shop B',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'trial',
    });

    // 1. Unverified PIN session cannot submit subscription payment
    await expect(
      ctx.asUser(shopUnverified.owner, async (tx) => {
        await tx.query(
          `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'MTN10001', '0966123456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`,
          [shopUnverified.shopId]
        );
      })
    ).rejects.toThrow(/PIN/i);

    // 2. Cross-shop submission blocked
    await expect(
      ctx.asUser(shopA.owner, async (tx) => {
        await tx.query(
          `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'MTN10002', '0966123456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`,
          [shopB.shopId]
        );
      })
    ).rejects.toThrow(/Verified shop session is required|Only the shop owner/i);

    // 3. Client-supplied wrong expected amount rejected (server plan price is 9900 ngwee for monthly)
    await expect(
      ctx.asUser(shopA.owner, async (tx) => {
        await tx.query(
          `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'MTN10003', '0966123456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-bad-amt', 500)`,
          [shopA.shopId]
        );
      })
    ).rejects.toThrow(/amount does not match/i);

    // 4. Valid submission locks (mtn, TXREF999) and records canonical 9900 ngwee
    const sub1 = await ctx.asUser(shopA.owner, async (tx) => {
      const r = await tx.query<{
        res: { id: string; status: string; amount_ngwee: number; idempotent: boolean };
      }>(
        `SELECT public.submit_subscription_payment(
           $1::uuid, 'monthly', 'mtn', ' txref 999 ', '0966 123 456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-sub-a1', 9900
         ) AS res`,
        [shopA.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(sub1).toMatchObject({
      status: 'pending',
      amount_ngwee: 9900,
      idempotent: false,
    });

    // 5. Idempotent replay with same operation_id returns exact same payment without error
    const sub1Replay = await ctx.asUser(shopA.owner, async (tx) => {
      const r = await tx.query<{ res: { id: string; status: string; idempotent: boolean } }>(
        `SELECT public.submit_subscription_payment(
           $1::uuid, 'monthly', 'mtn', 'txref999', '0966123456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-sub-a1', 9900
         ) AS res`,
        [shopA.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(sub1Replay).toEqual(
      expect.objectContaining({ id: sub1.id, status: 'pending', idempotent: true })
    );

    // 6. Another shop submitting the SAME mtn reference is blocked while pending
    await expect(
      ctx.asUser(shopB.owner, async (tx) => {
        await tx.query(
          `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'TXREF999', '0977111222', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-sub-b-dup')`,
          [shopB.shopId]
        );
      })
    ).rejects.toThrow(/already been submitted/i);

    // 7. Same reference string on a DIFFERENT operator (airtel) is allowed!
    const airtelSameRef = await ctx.asUser(shopB.owner, async (tx) => {
      const r = await tx.query<{ res: { id: string; status: string; amount_ngwee: number } }>(
        `SELECT public.submit_subscription_payment($1::uuid, 'quarterly', 'airtel', 'TXREF999', '0977111222', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-sub-b-airtel') AS res`,
        [shopB.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(airtelSameRef.status).toBe('pending');
    expect(airtelSameRef.amount_ngwee).toBe(26900);

    // 8. Admin WITHOUT aal2 MFA is rejected!
    await expect(
      ctx.asUser(adminAal1, async (tx) => {
        await tx.query(
          `SELECT public.review_subscription_payment($1::uuid, 'approve', NULL, 'op-aal1-attempt')`,
          [sub1.id]
        );
      })
    ).rejects.toThrow(/aal2/i);

    // 9. Admin WITH aal2 rejects sub1 -> releases mtn:TXREF999 lock and posts subscription_notice
    const rejOut = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { status: string; idempotent: boolean } }>(
        `SELECT public.review_subscription_payment($1::uuid, 'reject', 'Reference typo in SMS', 'op-rev-rej-1') AS res`,
        [sub1.id]
      );
      return r.rows[0]!.res;
    });
    expect(rejOut).toMatchObject({ status: 'rejected', idempotent: false });

    // Verify subscription_notice is set (and security_notice is untouched), and owner can dismiss subscription_notice
    const shopANotices = await ctx.asUser(shopA.owner, async (tx) => {
      const r = await tx.query<{
        subscription_notice: string | null;
        security_notice: string | null;
      }>(`SELECT subscription_notice, security_notice FROM public.shops WHERE id = $1::uuid`, [
        shopA.shopId,
      ]);
      return r.rows[0]!;
    });
    expect(shopANotices.subscription_notice).toContain('Reference typo in SMS');
    expect(shopANotices.security_notice).toBeNull();

    await ctx.asUser(shopA.owner, async (tx) => {
      await tx.query(`SELECT public.acknowledge_shop_subscription_notice()`);
    });
    const clearedNotice = await ctx.asUser(shopA.owner, async (tx) => {
      const r = await tx.query<{ subscription_notice: string | null }>(
        `SELECT subscription_notice FROM public.shops WHERE id = $1::uuid`,
        [shopA.shopId]
      );
      return r.rows[0]!;
    });
    expect(clearedNotice.subscription_notice).toBeNull();

    // 10. Now that sub1 was rejected, mtn:TXREF999 is unlocked and can be resubmitted cleanly!
    const sub2 = await ctx.asUser(shopA.owner, async (tx) => {
      const r = await tx.query<{ res: { id: string; status: string } }>(
        `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'TXREF999', '0966123456', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-sub-a2') AS res`,
        [shopA.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(sub2.status).toBe('pending');
    expect(sub2.id).not.toBe(sub1.id);
  });

  it('Phase 4: clamps UTC end-of-month dates, stacks active plans vs expired now(), preserves suspension on approval, supports admin extend/suspend idempotency, and detects drift in reconcile_subscriptions', async () => {
    // Verify add_utc_calendar_months directly on Jan 31 (non-leap and leap year)
    const clampCheck = await ctx.asServiceRole(async (tx) => {
      const r = await tx.query<{ non_leap: string; leap: string }>(
        `SELECT
           to_char(public.add_utc_calendar_months('2026-01-31T12:30:00Z'::timestamptz, 1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS non_leap,
           to_char(public.add_utc_calendar_months('2028-01-31T12:30:00Z'::timestamptz, 1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS leap`
      );
      return r.rows[0]!;
    });
    expect(clampCheck.non_leap).toBe('2026-02-28T12:30:00Z');
    expect(clampCheck.leap).toBe('2028-02-29T12:30:00Z');

    // Shop with existing future expiry on 2027-01-31T12:30:00Z -> 1 month approval stacks & clamps to 2027-02-28T12:30:00Z!
    const futureShop = await createShopWithPinState({
      name: 'Future Stacking Shop',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'active',
      planExpiryAtIso: '2027-01-31T12:30:00.000Z',
      salesAccessUntilIso: '2027-02-03T12:30:00.000Z',
    });

    const stackPay = await ctx.asUser(futureShop.owner, async (tx) => {
      const r = await tx.query<{ res: { id: string } }>(
        `SELECT public.submit_subscription_payment($1::uuid, 'monthly', 'mtn', 'STACKJAN31', '0966999888', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-stack-1') AS res`,
        [futureShop.shopId]
      );
      return r.rows[0]!.res;
    });

    const stackApproved = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{
        res: {
          status: string;
          subscription_start_at: string;
          subscription_expiry_at: string;
          sales_access_until: string;
          idempotent: boolean;
        };
      }>(
        `SELECT public.review_subscription_payment($1::uuid, 'approve', NULL, 'op-approve-stack-1') AS res`,
        [stackPay.id]
      );
      return r.rows[0]!.res;
    });

    expect(new Date(stackApproved.subscription_start_at).toISOString()).toBe(
      '2027-01-31T12:30:00.000Z'
    );
    expect(new Date(stackApproved.subscription_expiry_at).toISOString()).toBe(
      '2027-02-28T12:30:00.000Z'
    );
    expect(new Date(stackApproved.sales_access_until).toISOString()).toBe(
      '2027-03-03T12:30:00.000Z'
    );

    // Idempotent replay of review_subscription_payment returns idempotent: true without adding another month!
    const stackApproveReplay = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { subscription_expiry_at: string; idempotent: boolean } }>(
        `SELECT public.review_subscription_payment($1::uuid, 'approve', NULL, 'op-approve-stack-1') AS res`,
        [stackPay.id]
      );
      return r.rows[0]!.res;
    });
    expect(stackApproveReplay.idempotent).toBe(true);
    expect(new Date(stackApproveReplay.subscription_expiry_at).toISOString()).toBe(
      '2027-02-28T12:30:00.000Z'
    );

    // Suspended shop payment approval does NOT lift suspension, but reactivating restores 'active'!
    const suspShop = await createShopWithPinState({
      name: 'Suspended Shop',
      withPinCredentials: true,
      sessionVerified: true,
      planStatus: 'expired',
      planExpiryAtIso: '2026-10-01T00:00:00.000Z',
      salesAccessUntilIso: '2026-10-04T00:00:00.000Z',
    });

    await ctx.asUser(adminAal2, async (tx) => {
      await tx.query(
        `SELECT public.admin_set_shop_suspended($1::uuid, true, 'op-susp-shop-1', 'Compliance review')`,
        [suspShop.shopId]
      );
    });

    const suspPay = await ctx.asUser(suspShop.owner, async (tx) => {
      const r = await tx.query<{ res: { id: string; plan_status: string } }>(
        `SELECT public.submit_subscription_payment($1::uuid, 'biannual', 'airtel', 'AIRTEL6M01', '0977222333', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'op-susp-pay-1') AS res`,
        [suspShop.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(suspPay.plan_status).toBe('suspended');

    const suspApprove = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { plan_status: string; status: string } }>(
        `SELECT public.review_subscription_payment($1::uuid, 'approve', NULL, 'op-susp-approve-1') AS res`,
        [suspPay.id]
      );
      return r.rows[0]!.res;
    });
    expect(suspApprove.status).toBe('approved');
    expect(suspApprove.plan_status).toBe('suspended');

    // Reactivate shop -> restores status_before_suspension ('active')!
    const reactivated = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { suspended: boolean; plan_status: string } }>(
        `SELECT public.admin_set_shop_suspended($1::uuid, false, 'op-unsusp-shop-1', 'Cleared') AS res`,
        [suspShop.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(reactivated).toMatchObject({ suspended: false, plan_status: 'active' });

    // Admin manual extension with idempotency
    const ext1 = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { plan_expiry_at: string; idempotent: boolean } }>(
        `SELECT public.admin_extend_shop_subscription($1::uuid, 10, 'op-ext-10d', 'Courtesy extension') AS res`,
        [futureShop.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(ext1.idempotent).toBe(false);
    expect(new Date(ext1.plan_expiry_at).toISOString()).toBe('2027-03-10T12:30:00.000Z');

    const ext1Replay = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ res: { plan_expiry_at: string; idempotent: boolean } }>(
        `SELECT public.admin_extend_shop_subscription($1::uuid, 10, 'op-ext-10d', 'Courtesy extension') AS res`,
        [futureShop.shopId]
      );
      return r.rows[0]!.res;
    });
    expect(ext1Replay.idempotent).toBe(true);
    expect(new Date(ext1Replay.plan_expiry_at).toISOString()).toBe('2027-03-10T12:30:00.000Z');

    // Verify reconcile_subscriptions reports 0 differences across all shops!
    const cleanSubRecon = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{ rep: { total_differences: number; shops_checked: number } }>(
        `SELECT public.reconcile_subscriptions(NULL) AS rep`
      );
      return r.rows[0]!.rep;
    });
    expect(cleanSubRecon.total_differences).toBe(0);
    expect(cleanSubRecon.shops_checked).toBeGreaterThanOrEqual(2);

    // Inject synthetic drift via service_role and verify reconcile_subscriptions catches it, then restore
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops
         SET sales_access_until = plan_expiry_at + interval '10 days'
         WHERE id = $1::uuid`,
        [futureShop.shopId]
      );
    });

    const driftedRecon = await ctx.asUser(adminAal2, async (tx) => {
      const r = await tx.query<{
        rep: { total_differences: number; expiry_mismatch_count: number };
      }>(`SELECT public.reconcile_subscriptions($1::uuid) AS rep`, [futureShop.shopId]);
      return r.rows[0]!.rep;
    });
    expect(driftedRecon.total_differences).toBe(1);
    expect(driftedRecon.expiry_mismatch_count).toBe(1);

    // Restore invariant
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops
         SET sales_access_until = plan_expiry_at + interval '3 days'
         WHERE id = $1::uuid`,
        [futureShop.shopId]
      );
    });
  });
});
