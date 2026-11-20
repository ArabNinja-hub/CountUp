import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '@electric-sql/pglite';
import { createTestSupabaseDb, TestIdentity } from './supabaseTestHarness';
import { CreditBalanceConflict } from '../../services/syncReview';
import {
  executeSingleSyncRpc,
  executeSyncBatchChunk,
  loadShopSyncReviewFromServer,
  reconcileShopLedger,
  resolveShopSyncReviewOnServer,
  ShopRpcQueryClient,
  SYNC_BATCH_CHUNK_SIZE,
} from '../shopWriteRpc';
import type { PendingSyncAction } from '../../utils/sync';

/**
 * Wraps a PGlite harness + authenticated `TestIdentity` into a `ShopRpcQueryClient`
 * that executes real PostgreSQL 17 `public.*` RPCs and RLS-enforced table reads!
 */
function createPgLiteRpcClient(
  harness: Awaited<ReturnType<typeof createTestSupabaseDb>>,
  identity: TestIdentity
): ShopRpcQueryClient {
  return {
    from(table: string) {
      const filters: Array<{ col: string; val: unknown }> = [];
      let orderCol: string | null = null;
      let orderAsc = true;

      const runSelect = async () => {
        try {
          const rows = await harness.asUser(identity, async (tx) => {
            const whereParts = filters.map((f, idx) => `${f.col} = $${idx + 1}`);
            const sql = [
              `SELECT * FROM public.${table}`,
              whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
              orderCol ? `ORDER BY ${orderCol} ${orderAsc ? 'ASC' : 'DESC'}` : '',
            ]
              .filter(Boolean)
              .join(' ');
            const res = await tx.query<Record<string, unknown>>(
              sql,
              filters.map((f) => f.val)
            );
            // Normalize bigint strings from pg driver into safe numbers
            return res.rows.map((row) => {
              const copy: Record<string, unknown> = { ...row };
              for (const [k, v] of Object.entries(copy)) {
                if (typeof v === 'string' && k.endsWith('_ngwee') && /^-?\d+$/.test(v)) {
                  copy[k] = Number(v);
                }
                if (v instanceof Date) {
                  copy[k] = v.toISOString();
                }
              }
              return copy;
            });
          });
          return { data: rows, error: null };
        } catch (err) {
          const pgErr = err as { code?: string; detail?: string; message?: string };
          return {
            data: null,
            error: {
              code: pgErr.code ?? 'PGRST_ERR',
              detail: pgErr.detail ?? '',
              details: pgErr.detail ?? '',
              message: pgErr.message ?? String(err),
            },
          };
        }
      };

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        async maybeSingle() {
          const res = await runSelect();
          if (res.error) return { data: null, error: res.error };
          return { data: res.data?.[0] ?? null, error: null };
        },
        then(
          onFulfilled?: (v: { data: unknown; error: unknown }) => unknown,
          onRejected?: (e: unknown) => unknown
        ) {
          return runSelect().then(onFulfilled, onRejected);
        },
      };

      return builder as unknown as ReturnType<ShopRpcQueryClient['from']>;
    },

    async rpc(fnName: string, args: Record<string, unknown> = {}) {
      try {
        const result = await harness.asUser(identity, async (tx: Transaction) => {
          const entries = Object.entries(args);
          const namedArgs = entries
            .map(([k], idx) => {
              const val = args[k];
              const cast = val !== null && typeof val === 'object' ? '::jsonb' : '';
              return `${k} => $${idx + 1}${cast}`;
            })
            .join(', ');
          const values = entries.map(([, v]) =>
            v !== null && typeof v === 'object' ? JSON.stringify(v) : v
          );
          const sql = `SELECT public.${fnName}(${namedArgs}) AS payload`;
          const res = await tx.query<{ payload: Record<string, unknown> }>(sql, values);
          return res.rows[0]?.payload ?? null;
        });
        return { data: result, error: null } as unknown as ReturnType<ShopRpcQueryClient['rpc']>;
      } catch (err) {
        const pgErr = err as { code?: string; detail?: string; message?: string };
        return {
          data: null,
          error: {
            code: pgErr.code ?? 'PGRST_ERR',
            detail: pgErr.detail ?? '',
            details: pgErr.detail ?? '',
            message: pgErr.message ?? String(err),
          },
        } as unknown as ReturnType<ShopRpcQueryClient['rpc']>;
      }
    },
  };
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Phase 3b — Atomic Write RPCs, Concurrency, Bounded Offline Window & Ledger Reconciliation (Real PostgreSQL 17)', () => {
  let harness: Awaited<ReturnType<typeof createTestSupabaseDb>>;

  beforeAll(async () => {
    harness = await createTestSupabaseDb();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function provisionVerifiedShop(label: string) {
    const phoneSuffix = String(Math.floor(100_000_000 + Math.random() * 899_999_999));
    const user = await harness.createAuthUser({ phone: `+260${phoneSuffix}` });
    const shopId = crypto.randomUUID();
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.shops (
           id, owner_user_id, name, owner_phone, plan_status, plan_type,
           trial_ends_at, plan_expiry_at, sales_access_until, last_server_contact_at
         ) VALUES (
           $1, $2, $3, $4, 'active', 'monthly',
           now() + interval '30 days',
           now() + interval '30 days',
           now() + interval '33 days',
           now()
         )`,
        [shopId, user.id, label, user.phone]
      );
      await tx.query(
        `INSERT INTO public.shop_verified_sessions (shop_id, session_id, user_id)
         VALUES ($1, $2, $3)`,
        [shopId, `sess_${shopId}`, user.id]
      );
    });

    const verifiedIdentity: TestIdentity = {
      ...user,
      appMetadata: { shop_id: shopId },
    };
    const client = createPgLiteRpcClient(harness, verifiedIdentity);
    return { shopId, user: verifiedIdentity, client };
  }

  it('enforces verified shop session & MFA (aal2) authorization across all write RPCs and reconcile_shop_ledger', async () => {
    const shopA = await provisionVerifiedShop('Kalingalinga Grocery');
    const shopB = await provisionVerifiedShop('Woodlands Bakery');

    // OTP-only unverified session (no shop_id claim) is denied on write RPCs
    const otpOnlyClient = createPgLiteRpcClient(harness, {
      ...shopA.user,
      appMetadata: { pending_pin_verification: true },
    });
    await expect(
      executeSingleSyncRpc(
        shopA.shopId,
        {
          rpc: 'upsert_shop_item',
          operation_id: 'unauth_op_1',
          item_id: 'item_unauth',
          patch: { name: 'Bread', selling_price_ngwee: 2500, quantity: 5 },
          initial_movement: null,
        },
        otpOnlyClient
      )
    ).rejects.toThrow(/Verified shop session/i);

    // Shop B's verified session cannot write to Shop A
    await expect(
      executeSingleSyncRpc(
        shopA.shopId,
        {
          rpc: 'upsert_shop_item',
          operation_id: 'cross_shop_op_1',
          item_id: 'item_cross',
          patch: { name: 'Bread', selling_price_ngwee: 2500, quantity: 5 },
          initial_movement: null,
        },
        shopB.client
      )
    ).rejects.toThrow(/Verified shop session/i);

    // Shop A cannot run global (all-shop) reconciliation, and aal1 admin is also rejected
    await expect(reconcileShopLedger(null, shopA.client)).rejects.toThrow(/MFA \(aal2\)/i);

    const aal1Admin = await harness.createAuthUser({
      email: 'recon-aal1@countup.zm',
      emailVerified: true,
      appMetadata: { platform_admin: true },
      aal: 'aal1',
    });
    await expect(
      reconcileShopLedger(null, createPgLiteRpcClient(harness, aal1Admin))
    ).rejects.toThrow(/MFA \(aal2\)/i);

    const aal2Admin = await harness.createAuthUser({
      email: 'recon-aal2@countup.zm',
      emailVerified: true,
      appMetadata: { platform_admin: true },
      aal: 'aal2',
    });
    const globalReport = await reconcileShopLedger(null, createPgLiteRpcClient(harness, aal2Admin));
    expect(globalReport.total_differences).toBe(0);
    expect(globalReport.shops_checked).toBeGreaterThanOrEqual(2);
  });

  it('guarantees 10x replay idempotency across record_sale, undo_sale, record_repayment, apply_stock_count, and resolve_stock_conflict', async () => {
    const { shopId, client } = await provisionVerifiedShop('Idempotency Mart');

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_item',
        operation_id: 'op_seed_item',
        item_id: 'item_sugar',
        patch: {
          name: 'White Sugar 2kg',
          buying_price_ngwee: 4500,
          buying_price_known: true,
          selling_price_ngwee: 6000,
          quantity: 20,
        },
        initial_movement: { id: 'mv_init_sugar', reason: 'Initial stock' },
      },
      client
    );
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_customer',
        operation_id: 'op_seed_cust',
        customer_id: 'cust_banda',
        patch: { name: 'Mrs Banda', phone: '+260977111222', notes: '' },
      },
      client
    );

    // 1. Replay record_sale 10 times -> deducts 3 units ONCE (20 -> 17) and adds K180 credit ONCE
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_sale',
          operation_id: 'op_idem_sale_1',
          sale_id: 'sale_idem_1',
          lines: [
            {
              item_id: 'item_sugar',
              item_name: 'White Sugar 2kg',
              unit_label: 'bag',
              quantity: 3,
              selling_price_ngwee: 6000,
              buying_price_ngwee: 4500,
              buying_price_known: true,
              movement_id: 'mv_sale_idem_1',
            },
          ],
          payment_type: 'credit',
          receipt_number: 'R-IDEM-1',
          momo_operator: null,
          customer_id: 'cust_banda',
          customer_name: 'Mrs Banda',
          customer_phone: null,
          payment_reference: null,
          note: null,
          local_date: '2026-11-20',
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: '2026-11-20T10:00:00.000Z',
          is_offline_sync: false,
          offline_window_seconds: 259_200,
        },
        client
      );
      expect(res.idempotent).toBe(attempt > 0);
    }

    // 2. Replay record_repayment 10 times -> deducts K50 (5000 ngwee) ONCE (18000 -> 13000)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_repayment',
          operation_id: 'op_idem_repay_1',
          payment_id: 'pay_idem_1',
          customer_id: 'cust_banda',
          amount_ngwee: 5000,
          payment_method: 'cash',
          note: 'Part payment',
          local_date: '2026-11-20',
          created_at: '2026-11-20T10:05:00.000Z',
        },
        client
      );
      expect(res.idempotent).toBe(attempt > 0);
    }

    // 3. Record a second cash sale (2 units: 17 -> 15) and replay undo_sale 10 times -> restores 2 units ONCE (15 -> 17)
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_sale',
        operation_id: 'op_idem_sale_2',
        sale_id: 'sale_idem_2',
        lines: [
          {
            item_id: 'item_sugar',
            item_name: 'White Sugar 2kg',
            unit_label: 'bag',
            quantity: 2,
            selling_price_ngwee: 6000,
            buying_price_ngwee: 4500,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: 'R-IDEM-2',
        momo_operator: null,
        customer_id: null,
        customer_name: null,
        customer_phone: null,
        payment_reference: null,
        note: null,
        local_date: '2026-11-20',
        cash_tendered_ngwee: 12000,
        change_given_ngwee: 0,
        client_created_at: '2026-11-20T10:10:00.000Z',
        is_offline_sync: false,
        offline_window_seconds: 259_200,
      },
      client
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await executeSingleSyncRpc(
        shopId,
        {
          rpc: 'undo_sale',
          operation_id: 'op_idem_undo_2',
          sale_id: 'sale_idem_2',
          movements: [],
          expected_checks: {
            has_credit_adjustment: false,
            customer_id: null,
            credit_delta_ngwee: null,
            stock_deltas: [{ item_id: 'item_sugar', delta: 2 }],
          },
        },
        client
      );
      expect(res.idempotent).toBe(attempt > 0);
    }

    // 4. Replay apply_stock_count (+5 restock: 17 -> 22) 10 times -> adds 5 ONCE, plus trigger a stale recount conflict and replay resolve_stock_conflict 10 times
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await executeSingleSyncRpc(
        shopId,
        {
          rpc: 'apply_stock_count',
          operation_id: 'op_idem_stock_delta',
          item_id: 'item_sugar',
          mode: 'delta',
          quantity: 5,
          observed_quantity: null,
          movement_id: 'mv_idem_restock',
          movement_type: 'restock',
          reason: 'Supplier delivery',
          metadata: null,
        },
        client
      );
      expect(res.idempotent).toBe(attempt > 0);
    }

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'apply_stock_count',
        operation_id: 'op_stale_count_1',
        item_id: 'item_sugar',
        mode: 'set',
        quantity: 19,
        observed_quantity: 17, // stale! server has 22
        movement_id: 'mv_stale_count_1',
        movement_type: 'adjustment',
        reason: 'Shelf count',
        metadata: null,
      },
      client
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await executeSingleSyncRpc(
        shopId,
        {
          rpc: 'resolve_stock_conflict',
          operation_id: 'op_idem_resolve_conflict',
          conflict_id: 'op_stale_count_1_0',
        },
        client
      );
      expect(res.idempotent).toBe(attempt > 0);
    }

    const state = await harness.asServiceRole(async (tx) => {
      const item = await tx.query<{ quantity: number }>(
        `SELECT quantity FROM public.items WHERE shop_id = $1 AND id = 'item_sugar'`,
        [shopId]
      );
      const cust = await tx.query<{ total_owed_ngwee: string }>(
        `SELECT total_owed_ngwee::text FROM public.customers WHERE shop_id = $1 AND id = 'cust_banda'`,
        [shopId]
      );
      const conflict = await tx.query<{ resolved: boolean }>(
        `SELECT resolved FROM public.stock_conflicts WHERE shop_id = $1 AND id = 'op_stale_count_1_0'`,
        [shopId]
      );
      return {
        quantity: item.rows[0]?.quantity,
        owedNgwee: Number(cust.rows[0]?.total_owed_ngwee),
        resolved: conflict.rows[0]?.resolved,
      };
    });

    expect(state).toEqual({
      quantity: 22,
      owedNgwee: 13000,
      resolved: true,
    });

    const recon = await reconcileShopLedger(shopId, client);
    expect(recon.total_differences).toBe(0);
  });

  it('handles concurrent last-unit sales across two devices without negative stock or lost sales, flagging the loser as a stock_conflict', async () => {
    const { shopId, client } = await provisionVerifiedShop('Last Unit Butchery');

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_item',
        operation_id: 'op_last_unit_seed',
        item_id: 'item_oil',
        patch: {
          name: 'Cooking Oil 5L',
          buying_price_ngwee: 15000,
          buying_price_known: true,
          selling_price_ngwee: 19500,
          quantity: 1, // ONLY 1 UNIT LEFT!
        },
        initial_movement: { id: 'mv_init_oil', reason: 'Initial stock' },
      },
      client
    );

    // Two devices simultaneously submit a sale for the last 1 unit
    const [deviceARes, deviceBRes] = await Promise.all([
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_sale',
          operation_id: 'op_dev_a_last_unit',
          sale_id: 'sale_dev_a',
          lines: [
            {
              item_id: 'item_oil',
              item_name: 'Cooking Oil 5L',
              unit_label: 'bottle',
              quantity: 1,
              selling_price_ngwee: 19500,
              buying_price_ngwee: 15000,
              buying_price_known: true,
            },
          ],
          payment_type: 'cash',
          receipt_number: 'R-DEV-A',
          momo_operator: null,
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_reference: null,
          note: null,
          local_date: '2026-11-20',
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: '2026-11-20T11:00:00.000Z',
          is_offline_sync: true,
          offline_window_seconds: 259_200,
        },
        client
      ),
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_sale',
          operation_id: 'op_dev_b_last_unit',
          sale_id: 'sale_dev_b',
          lines: [
            {
              item_id: 'item_oil',
              item_name: 'Cooking Oil 5L',
              unit_label: 'bottle',
              quantity: 1,
              selling_price_ngwee: 19500,
              buying_price_ngwee: 15000,
              buying_price_known: true,
            },
          ],
          payment_type: 'momo',
          receipt_number: 'R-DEV-B',
          momo_operator: 'mtn',
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_reference: 'MTN-9911',
          note: null,
          local_date: '2026-11-20',
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: '2026-11-20T11:00:01.000Z',
          is_offline_sync: true,
          offline_window_seconds: 259_200,
        },
        client
      ),
    ]);

    expect(
      Number(deviceARes.stock_conflicts_created) + Number(deviceBRes.stock_conflicts_created)
    ).toBe(1);

    const dbVerify = await harness.asServiceRole(async (tx) => {
      const item = await tx.query<{ quantity: number }>(
        `SELECT quantity FROM public.items WHERE shop_id = $1 AND id = 'item_oil'`,
        [shopId]
      );
      const sales = await tx.query<{ id: string }>(
        `SELECT id FROM public.sales WHERE shop_id = $1 AND is_deleted = false ORDER BY id`,
        [shopId]
      );
      const conflicts = await tx.query<{
        kind: string;
        requested: number;
        available: number;
        shortfall: number;
        resolved: boolean;
      }>(
        `SELECT kind, requested, available, shortfall, resolved FROM public.stock_conflicts WHERE shop_id = $1`,
        [shopId]
      );
      return {
        quantity: item.rows[0]?.quantity,
        saleIds: sales.rows.map((r) => r.id),
        conflicts: conflicts.rows,
      };
    });

    // Stock is clamped at 0 (never -1), BOTH sales were preserved, and exactly 1 shortfall conflict exists
    expect(dbVerify.quantity).toBe(0);
    expect(dbVerify.saleIds).toEqual(['sale_dev_a', 'sale_dev_b']);
    expect(dbVerify.conflicts).toEqual([
      {
        kind: 'shortfall',
        requested: 1,
        available: 0,
        shortfall: 1,
        resolved: false,
      },
    ]);

    const recon = await reconcileShopLedger(shopId, client);
    expect(recon.total_differences).toBe(0);
  });

  it('handles undo-twice, undo-missing-sale, and repayment-larger-than-balance safely with SyncReview resolution', async () => {
    const { shopId, user, client } = await provisionVerifiedShop('Edge Case Kiosk');

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_item',
        operation_id: 'op_ec_item',
        item_id: 'item_soap',
        patch: {
          name: 'Bath Soap',
          buying_price_ngwee: 800,
          buying_price_known: true,
          selling_price_ngwee: 1200,
          quantity: 10,
        },
        initial_movement: { id: 'mv_ec_init', reason: 'Initial stock' },
      },
      client
    );
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_customer',
        operation_id: 'op_ec_cust',
        customer_id: 'cust_phiri',
        patch: { name: 'Mr Phiri', phone: '+260966222333', notes: '' },
      },
      client
    );

    // 1. Undo a sale that never reached the server -> rejected cleanly with SALE_NOT_FOUND, zero changes
    await expect(
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'undo_sale',
          operation_id: 'op_undo_ghost',
          sale_id: 'sale_never_existed',
          movements: [],
          expected_checks: {
            has_credit_adjustment: false,
            customer_id: null,
            credit_delta_ngwee: null,
            stock_deltas: [],
          },
        },
        client
      )
    ).rejects.toThrow(/no longer exists/i);

    // Record a credit sale of 4 soaps = K48.00 (4800 ngwee); stock 10 -> 6
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_sale',
        operation_id: 'op_ec_sale_1',
        sale_id: 'sale_ec_1',
        lines: [
          {
            item_id: 'item_soap',
            item_name: 'Bath Soap',
            unit_label: 'bar',
            quantity: 4,
            selling_price_ngwee: 1200,
            buying_price_ngwee: 800,
            buying_price_known: true,
          },
        ],
        payment_type: 'credit',
        receipt_number: 'R-EC-1',
        momo_operator: null,
        customer_id: 'cust_phiri',
        customer_name: 'Mr Phiri',
        customer_phone: null,
        payment_reference: null,
        note: null,
        local_date: '2026-11-20',
        cash_tendered_ngwee: null,
        change_given_ngwee: null,
        client_created_at: '2026-11-20T12:00:00.000Z',
        is_offline_sync: false,
        offline_window_seconds: 259_200,
      },
      client
    );

    // 2. Undo twice from two different devices -> 1st restores stock 6 -> 10 & credit 4800 -> 0;
    //    2nd gets `already-voided` and changes NOTHING!
    const undo1 = await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'undo_sale',
        operation_id: 'op_undo_dev_1',
        sale_id: 'sale_ec_1',
        movements: [],
        expected_checks: {
          has_credit_adjustment: true,
          customer_id: 'cust_phiri',
          credit_delta_ngwee: -4800,
          stock_deltas: [{ item_id: 'item_soap', delta: 4 }],
        },
      },
      client
    );
    expect(undo1.outcome).toBe('applied');

    const undo2 = await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'undo_sale',
        operation_id: 'op_undo_dev_2',
        sale_id: 'sale_ec_1',
        movements: [],
        expected_checks: {
          has_credit_adjustment: true,
          customer_id: 'cust_phiri',
          credit_delta_ngwee: -4800,
          stock_deltas: [{ item_id: 'item_soap', delta: 4 }],
        },
      },
      client
    );
    expect(undo2.outcome).toBe('already-voided');

    // 3. Repayment larger than customer's balance -> throws CreditBalanceConflict, then resolves via SyncReview
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_sale',
        operation_id: 'op_ec_sale_2',
        sale_id: 'sale_ec_2',
        lines: [
          {
            item_id: 'item_soap',
            item_name: 'Bath Soap',
            unit_label: 'bar',
            quantity: 3, // K36.00 = 3600 ngwee
            selling_price_ngwee: 1200,
            buying_price_ngwee: 800,
            buying_price_known: true,
          },
        ],
        payment_type: 'credit',
        receipt_number: 'R-EC-2',
        momo_operator: null,
        customer_id: 'cust_phiri',
        customer_name: 'Mr Phiri',
        customer_phone: null,
        payment_reference: null,
        note: null,
        local_date: '2026-11-20',
        cash_tendered_ngwee: null,
        change_given_ngwee: null,
        client_created_at: '2026-11-20T12:10:00.000Z',
        is_offline_sync: false,
        offline_window_seconds: 259_200,
      },
      client
    );

    // Another device already recorded a K20.00 repayment, leaving K16.00 (1600 ngwee) owed
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_repayment',
        operation_id: 'op_ec_repay_online',
        payment_id: 'pay_online_1',
        customer_id: 'cust_phiri',
        amount_ngwee: 2000,
        payment_method: 'cash',
        note: '',
        local_date: '2026-11-20',
        created_at: '2026-11-20T12:15:00.000Z',
      },
      client
    );

    // Offline device tries to apply a K30.00 (3000 ngwee) repayment when only K16.00 is owed
    await expect(
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_repayment',
          operation_id: 'op_ec_repay_over',
          payment_id: 'pay_over_1',
          customer_id: 'cust_phiri',
          amount_ngwee: 3000,
          payment_method: 'momo',
          note: 'Offline payment',
          local_date: '2026-11-20',
          created_at: '2026-11-20T12:16:00.000Z',
        },
        client
      )
    ).rejects.toBeInstanceOf(CreditBalanceConflict);

    // Shopkeeper reviews & adjusts payment to remaining K16.00 balance
    const overpayAction: PendingSyncAction = {
      id: 'op_ec_repay_over',
      type: 'payment',
      path: `shops/${shopId}/credit_payments/pay_over_1`,
      data: {},
      timestamp: Date.parse('2026-11-20T12:16:00.000Z'),
    };
    const description = {
      kind: 'payment' as const,
      action: overpayAction,
      customerPath: `shops/${shopId}/customers/cust_phiri`,
      paymentPath: `shops/${shopId}/credit_payments/pay_over_1`,
      payment: {
        id: 'pay_over_1',
        shopId,
        customerId: 'cust_phiri',
        customerName: 'Mr Phiri',
        amount: 30,
        paymentMethod: 'momo' as const,
        note: 'Offline payment',
        createdAt: '2026-11-20T12:16:00.000Z',
      },
      amountNgwee: 3000,
    };

    const review = await loadShopSyncReviewFromServer(
      {
        shopId,
        actionId: 'op_ec_repay_over',
        description,
      },
      client
    );
    expect(review.serverBalance).toBe(16);
    expect(review.canRetry).toBe(false);

    const outcome = await resolveShopSyncReviewOnServer(
      {
        shopId,
        userUid: user.id,
        review,
        decision: { kind: 'correct-payment', amount: 16 },
        description,
        expectedBalanceNgwee: 1600,
        correctedNgwee: 1600,
      },
      client
    );
    expect(outcome).toBe('resolved');

    const recon = await reconcileShopLedger(shopId, client);
    expect(recon.total_differences).toBe(0);
  });

  it('enforces server-time plan suspension/expiry and accepts or flags offline sales across the bounded 72h window without losing sales', async () => {
    const { shopId, client } = await provisionVerifiedShop('Window Policy Shop');

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_item',
        operation_id: 'op_win_seed',
        item_id: 'item_candle',
        patch: {
          name: 'Candles Pack',
          buying_price_ngwee: 1000,
          buying_price_known: true,
          selling_price_ngwee: 1500,
          quantity: 50,
        },
        initial_movement: { id: 'mv_win_init', reason: 'Initial stock' },
      },
      client
    );

    // 1. Suspended shop rejects BOTH online and offline sales
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops SET plan_status = 'suspended', is_deactivated = true WHERE id = $1`,
        [shopId]
      );
    });
    await expect(
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_sale',
          operation_id: 'op_win_suspended',
          sale_id: 'sale_win_suspended',
          lines: [
            {
              item_id: 'item_candle',
              item_name: 'Candles Pack',
              unit_label: 'pack',
              quantity: 1,
              selling_price_ngwee: 1500,
              buying_price_ngwee: 1000,
              buying_price_known: true,
            },
          ],
          payment_type: 'cash',
          receipt_number: 'R-SUSP',
          momo_operator: null,
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_reference: null,
          note: null,
          local_date: null,
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: new Date().toISOString(),
          is_offline_sync: true,
          offline_window_seconds: 259_200,
        },
        client
      )
    ).rejects.toThrow(/suspended/i);

    // 2. Active shop offline for 6 hours (within 72h window) -> accepted unflagged!
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops
            SET plan_status = 'active',
                is_deactivated = false,
                last_server_contact_at = $2::timestamptz,
                sales_access_until = now() + interval '10 days',
                plan_expiry_at = now() + interval '7 days'
          WHERE id = $1`,
        [shopId, sixHoursAgo]
      );
    });

    const inWindow = await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_sale',
        operation_id: 'op_win_valid_offline',
        sale_id: 'sale_win_valid',
        lines: [
          {
            item_id: 'item_candle',
            item_name: 'Candles Pack',
            unit_label: 'pack',
            quantity: 2,
            selling_price_ngwee: 1500,
            buying_price_ngwee: 1000,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: 'R-WIN-OK',
        momo_operator: null,
        customer_id: null,
        customer_name: null,
        customer_phone: null,
        payment_reference: null,
        note: null,
        local_date: null,
        cash_tendered_ngwee: null,
        change_given_ngwee: null,
        client_created_at: twoHoursAgo,
        is_offline_sync: true,
        offline_window_seconds: 259_200,
      },
      client
    );
    expect(inWindow.offline_window_flagged).toBe(false);
    expect(inWindow.outcome).toBe('applied');

    // 3. Offline > 72h (96h since last server contact) -> NEVER dropped; accepted & flagged!
    const ninetySixHoursAgo = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
    const eightyHoursAgo = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops SET last_server_contact_at = $2::timestamptz WHERE id = $1`,
        [shopId, ninetySixHoursAgo]
      );
    });

    const outOfWindow = await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'record_sale',
        operation_id: 'op_win_flagged_offline',
        sale_id: 'sale_win_flagged',
        lines: [
          {
            item_id: 'item_candle',
            item_name: 'Candles Pack',
            unit_label: 'pack',
            quantity: 1,
            selling_price_ngwee: 1500,
            buying_price_ngwee: 1000,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: 'R-WIN-FLAG',
        momo_operator: null,
        customer_id: null,
        customer_name: null,
        customer_phone: null,
        payment_reference: null,
        note: null,
        local_date: null,
        cash_tendered_ngwee: null,
        change_given_ngwee: null,
        client_created_at: eightyHoursAgo,
        is_offline_sync: true,
        offline_window_seconds: 259_200,
      },
      client
    );
    expect(outOfWindow.offline_window_flagged).toBe(true);
    expect(outOfWindow.offline_flag_reason).toBe('exceeded_bounded_offline_window');
    expect(outOfWindow.outcome).toBe('flagged');

    // 4. Online expired shop (`is_offline_sync = false`, `now() > sales_access_until`) -> rejected!
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops
            SET plan_status = 'expired',
                plan_expiry_at = now() - interval '5 days',
                sales_access_until = now() - interval '2 days',
                last_server_contact_at = now() - interval '1 day'
          WHERE id = $1`,
        [shopId]
      );
    });
    await expect(
      executeSingleSyncRpc(
        shopId,
        {
          rpc: 'record_sale',
          operation_id: 'op_win_expired_online',
          sale_id: 'sale_win_expired',
          lines: [
            {
              item_id: 'item_candle',
              item_name: 'Candles Pack',
              unit_label: 'pack',
              quantity: 1,
              selling_price_ngwee: 1500,
              buying_price_ngwee: 1000,
              buying_price_known: true,
            },
          ],
          payment_type: 'cash',
          receipt_number: 'R-EXP',
          momo_operator: null,
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_reference: null,
          note: null,
          local_date: null,
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: new Date().toISOString(),
          is_offline_sync: false,
          offline_window_seconds: 259_200,
        },
        client
      )
    ).rejects.toThrow(/expired/i);

    const recon = await reconcileShopLedger(shopId, client);
    expect(recon.total_differences).toBe(0);
  });

  it('processes 550+ pending queue operations in 50-op batches on real PostgreSQL 17 with strict FIFO stop-on-conflict and idempotent retry', async () => {
    const { shopId, client } = await provisionVerifiedShop('550 Queue Wholesale');
    const root = `shops/${shopId}`;
    const nowIso = '2026-11-20T13:00:00.000Z';

    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_item',
        operation_id: 'op_550_item',
        item_id: 'item_salt',
        patch: {
          name: 'Fine Salt 1kg',
          buying_price_ngwee: 600,
          buying_price_known: true,
          selling_price_ngwee: 1000,
          quantity: 1000,
        },
        initial_movement: { id: 'mv_550_init', reason: 'Initial stock' },
      },
      client
    );
    await executeSingleSyncRpc(
      shopId,
      {
        rpc: 'upsert_shop_customer',
        operation_id: 'op_550_cust',
        customer_id: 'cust_550',
        patch: { name: 'Bulk Buyer', phone: '+260955999000', notes: '' },
      },
      client
    );

    // Build 550 queued actions; inject an overpayment conflict at index 212 (inside batch #5)
    const queue: PendingSyncAction[] = [];
    for (let i = 0; i < 550; i += 1) {
      if (i === 212) {
        const pay = {
          id: 'pay_conflict_212',
          shopId,
          customerId: 'cust_550',
          customerName: 'Bulk Buyer',
          amount: 9999, // exceeds K0 balance -> CreditBalanceConflict!
          paymentMethod: 'cash' as const,
          note: '',
          createdAt: nowIso,
        };
        queue.push({
          id: 'op_q_212',
          type: 'payment',
          path: `${root}/credit_payments/pay_conflict_212`,
          data: pay,
          writes: [
            { path: `${root}/credit_payments/pay_conflict_212`, data: pay },
            { path: `${root}/customers/cust_550`, data: { totalOwed: 0 } },
          ],
          adjustments: [
            {
              kind: 'credit',
              path: `${root}/customers/cust_550`,
              deltaNgwee: -999_900,
              updatedAt: nowIso,
            },
          ],
          timestamp: Date.now() + i,
          queuedOffline: true,
        });
        continue;
      }

      const saleId = `s550_${i}`;
      const mvId = `mv550_${i}`;
      const sale = {
        id: saleId,
        shopId,
        items: [
          {
            itemId: 'item_salt',
            name: 'Fine Salt 1kg',
            quantity: 1,
            buyingPrice: 6,
            buyingPriceKnown: true,
            sellingPrice: 10,
            total: 10,
          },
        ],
        itemsCount: 1,
        totalAmount: 10,
        totalCost: 6,
        profit: 4,
        paymentType: 'cash' as const,
        receiptNumber: `R550-${i}`,
        createdAt: nowIso,
      };
      const mv = {
        id: mvId,
        shopId,
        itemId: 'item_salt',
        itemName: 'Fine Salt 1kg',
        type: 'sale' as const,
        delta: -1,
        previousQuantity: 1000,
        newQuantity: 999,
        reason: `Sale R550-${i}`,
        relatedSaleId: saleId,
        createdAt: nowIso,
      };
      queue.push({
        id: `op_q_${i}`,
        type: 'sale',
        path: `${root}/sales/${saleId}`,
        data: sale,
        writes: [
          { path: `${root}/sales/${saleId}`, data: sale },
          { path: `${root}/items/item_salt`, data: { quantity: 999 } },
          { path: `${root}/stock_movements/${mvId}`, data: mv },
        ],
        adjustments: [
          {
            kind: 'stock',
            path: `${root}/items/item_salt`,
            delta: -1,
            updatedAt: nowIso,
            movement: { path: `${root}/stock_movements/${mvId}`, data: mv },
          },
        ],
        timestamp: Date.now() + i,
        queuedOffline: true,
      });
    }

    // Drain chunks of 50 until hitting the conflict at index 212
    let working = [...queue];
    let hitConflict = false;
    while (working.length > 0) {
      const chunk = working.slice(0, SYNC_BATCH_CHUNK_SIZE);
      const outcomes = await executeSyncBatchChunk(shopId, chunk, { client });
      let stopped = false;
      for (const out of outcomes) {
        if (!out.ok) {
          expect(out.operation_id).toBe('op_q_212');
          expect(out.error).toBeInstanceOf(CreditBalanceConflict);
          hitConflict = true;
          stopped = true;
          break;
        }
        working = working.filter((a) => a.id !== out.operation_id);
      }
      if (stopped) break;
    }

    expect(hitConflict).toBe(true);
    // Exactly 212 operations committed; op_q_212 and all 337 subsequent operations remain untouched!
    expect(working).toHaveLength(550 - 212);

    // Replay already-applied ops #200..#211 + drop cancelled overpayment #212 + drain rest of 550!
    const retryWithOverlap = [...queue.slice(200, 212), ...working.slice(1)];
    while (retryWithOverlap.length > 0) {
      const chunk = retryWithOverlap.splice(0, SYNC_BATCH_CHUNK_SIZE);
      const outcomes = await executeSyncBatchChunk(shopId, chunk, { client });
      expect(outcomes.every((o) => o.ok)).toBe(true);
    }

    const finalQty = await harness.asServiceRole(async (tx) => {
      const res = await tx.query<{ quantity: number }>(
        `SELECT quantity FROM public.items WHERE shop_id = $1 AND id = 'item_salt'`,
        [shopId]
      );
      return res.rows[0]?.quantity;
    });
    // 549 sales of 1 unit each from 1000 -> 451 units remaining
    expect(finalQty).toBe(1000 - 549);

    const recon = await reconcileShopLedger(shopId, client);
    expect(recon.total_differences).toBe(0);
  });

  it('maintains 0 reconciliation differences across 360 randomized operation steps, duplicate replays, and out-of-order deliveries (plus catches 1-ngwee/1-unit tampering)', async () => {
    const shops = await Promise.all([
      provisionVerifiedShop('Prop Shop 1'),
      provisionVerifiedShop('Prop Shop 2'),
      provisionVerifiedShop('Prop Shop 3'),
    ]);
    const rand = mulberry32(20261120);

    const itemsByShop = new Map<string, string[]>();
    const custsByShop = new Map<string, string[]>();
    const salesByShop = new Map<string, string[]>();
    const historyForReplay: Array<{
      shopIdx: number;
      descriptor: Parameters<typeof executeSingleSyncRpc>[1];
    }> = [];

    // Seed 4 items (2 known cost, 2 unknown cost!) and 3 customers per shop
    for (let sIdx = 0; sIdx < shops.length; sIdx += 1) {
      const s = shops[sIdx];
      const itemIds: string[] = [];
      const custIds: string[] = [];

      for (let i = 0; i < 4; i += 1) {
        const itemId = `p_item_${i}`;
        const knownCost = i % 2 === 0;
        const buyNgwee = knownCost ? (10 + i * 5) * 100 : 0;
        const sellNgwee = (20 + i * 8) * 100 + 50; // includes odd 50-ngwee prices!
        const initQty = Math.floor(rand() * 12);
        await executeSingleSyncRpc(
          s.shopId,
          {
            rpc: 'upsert_shop_item',
            operation_id: `seed_item_${sIdx}_${i}`,
            item_id: itemId,
            patch: {
              name: `Item ${i}`,
              buying_price_ngwee: buyNgwee,
              buying_price_known: knownCost,
              selling_price_ngwee: sellNgwee,
              quantity: initQty,
            },
            initial_movement: { id: `seed_mv_${sIdx}_${i}`, reason: 'Initial' },
          },
          s.client
        );
        itemIds.push(itemId);
      }

      for (let c = 0; c < 3; c += 1) {
        const custId = `p_cust_${c}`;
        await executeSingleSyncRpc(
          s.shopId,
          {
            rpc: 'upsert_shop_customer',
            operation_id: `seed_cust_${sIdx}_${c}`,
            customer_id: custId,
            patch: { name: `Customer ${c}`, phone: '', notes: '' },
          },
          s.client
        );
        custIds.push(custId);
      }

      itemsByShop.set(s.shopId, itemIds);
      custsByShop.set(s.shopId, custIds);
      salesByShop.set(s.shopId, []);
    }

    // Run 360 randomized operations (sales, oversold sales, undos, repayments, overpayments,
    // stale & fresh physical stock counts, restocks, and random duplicate replays / out-of-order timestamps)
    for (let step = 0; step < 360; step += 1) {
      const shopIdx = Math.floor(rand() * shops.length);
      const target = shops[shopIdx];
      const itemIds = itemsByShop.get(target.shopId)!;
      const custIds = custsByShop.get(target.shopId)!;
      const saleIds = salesByShop.get(target.shopId)!;
      const roll = rand();

      // 15% chance: replay a random earlier operation (idempotency under out-of-order delivery)
      if (roll < 0.15 && historyForReplay.length > 0) {
        const pick = historyForReplay[Math.floor(rand() * historyForReplay.length)];
        await executeSingleSyncRpc(
          shops[pick.shopIdx].shopId,
          pick.descriptor,
          shops[pick.shopIdx].client
        ).catch(() => undefined);
        continue;
      }

      // 40% chance: record 1..3 line sale (cash, momo, or credit; sometimes overselling stock!)
      if (roll < 0.55) {
        const lineCount = 1 + Math.floor(rand() * 3);
        const shuffled = [...itemIds].sort(() => rand() - 0.5).slice(0, lineCount);
        const lines = shuffled.map((itemId, idx) => {
          const itemNum = Number(itemId.split('_').at(-1));
          const known = itemNum % 2 === 0;
          return {
            item_id: itemId,
            item_name: `Item ${itemNum}`,
            unit_label: 'unit',
            quantity: 1 + Math.floor(rand() * 4),
            selling_price_ngwee: (20 + itemNum * 8) * 100 + 50,
            buying_price_ngwee: known ? (10 + itemNum * 5) * 100 : 0,
            buying_price_known: known,
            movement_id: `pmv_${step}_${idx}`,
          };
        });
        const paymentTypes = ['cash', 'momo', 'credit'] as const;
        const pType = paymentTypes[Math.floor(rand() * paymentTypes.length)];
        const custId = pType === 'credit' ? custIds[Math.floor(rand() * custIds.length)] : null;
        const saleId = `psale_${step}`;
        // Random out-of-order offline client timestamp (-90h to +5m)
        const offsetMs = Math.floor((rand() * 92 - 90) * 3600 * 1000);
        const descriptor: Parameters<typeof executeSingleSyncRpc>[1] = {
          rpc: 'record_sale',
          operation_id: `pop_sale_${step}`,
          sale_id: saleId,
          lines,
          payment_type: pType,
          receipt_number: `PR-${step}`,
          momo_operator: pType === 'momo' ? 'airtel' : null,
          customer_id: custId,
          customer_name: custId ? `Customer ${custId}` : null,
          customer_phone: null,
          payment_reference: null,
          note: null,
          local_date: '2026-11-20',
          cash_tendered_ngwee: null,
          change_given_ngwee: null,
          client_created_at: new Date(Date.now() + offsetMs).toISOString(),
          is_offline_sync: rand() < 0.5,
          offline_window_seconds: 259_200,
        };
        await executeSingleSyncRpc(target.shopId, descriptor, target.client);
        saleIds.push(saleId);
        historyForReplay.push({ shopIdx, descriptor });
        continue;
      }

      // 15% chance: undo a random sale (or missing sale)
      if (roll < 0.7) {
        const saleId =
          saleIds.length > 0 && rand() < 0.85
            ? saleIds[Math.floor(rand() * saleIds.length)]
            : `missing_sale_${step}`;
        const descriptor: Parameters<typeof executeSingleSyncRpc>[1] = {
          rpc: 'undo_sale',
          operation_id: `pop_undo_${step}`,
          sale_id: saleId,
          movements: [],
          expected_checks: null as unknown as {
            has_credit_adjustment: boolean;
            customer_id: string | null;
            credit_delta_ngwee: number | null;
            stock_deltas: Array<{ item_id: string; delta: number }>;
          },
        };
        await executeSingleSyncRpc(target.shopId, descriptor, target.client).catch(() => undefined);
        historyForReplay.push({ shopIdx, descriptor });
        continue;
      }

      // 15% chance: customer repayment (valid partial, exact, or overpayment)
      if (roll < 0.85) {
        const custId = custIds[Math.floor(rand() * custIds.length)];
        const amountNgwee = (1 + Math.floor(rand() * 80)) * 100 + (rand() < 0.5 ? 50 : 0);
        const descriptor: Parameters<typeof executeSingleSyncRpc>[1] = {
          rpc: 'record_repayment',
          operation_id: `pop_pay_${step}`,
          payment_id: `ppay_${step}`,
          customer_id: custId,
          amount_ngwee: amountNgwee,
          payment_method: rand() < 0.5 ? 'cash' : 'momo',
          note: '',
          local_date: '2026-11-20',
          created_at: new Date().toISOString(),
        };
        await executeSingleSyncRpc(target.shopId, descriptor, target.client).catch(() => undefined);
        historyForReplay.push({ shopIdx, descriptor });
        continue;
      }

      // 15% chance: stock count (`set` with stale/matching observed, or `delta` +/-)
      const itemId = itemIds[Math.floor(rand() * itemIds.length)];
      const isSet = rand() < 0.5;
      const descriptor: Parameters<typeof executeSingleSyncRpc>[1] = {
        rpc: 'apply_stock_count',
        operation_id: `pop_stk_${step}`,
        item_id: itemId,
        mode: isSet ? 'set' : 'delta',
        quantity: isSet ? Math.floor(rand() * 20) : Math.floor(rand() * 15) - 6,
        observed_quantity: isSet ? (rand() < 0.5 ? Math.floor(rand() * 10) : null) : null,
        movement_id: `pstkmv_${step}`,
        movement_type: isSet ? 'adjustment' : 'restock',
        reason: 'Randomized count',
        metadata: null,
      };
      await executeSingleSyncRpc(target.shopId, descriptor, target.client);
      historyForReplay.push({ shopIdx, descriptor });
    }

    // Verify 0 reconciliation differences for EVERY shop individually AND globally across all shops!
    for (const s of shops) {
      const shopRecon = await reconcileShopLedger(s.shopId, s.client);
      expect(shopRecon.total_differences).toBe(0);
      expect(shopRecon.sale_line_mismatch_count).toBe(0);
      expect(shopRecon.sale_profit_mismatch_count).toBe(0);
      expect(shopRecon.customer_balance_mismatch_count).toBe(0);
      expect(shopRecon.stock_movement_mismatch_count).toBe(0);
    }

    const aal2Admin = await harness.createAuthUser({
      email: 'prop-admin@countup.zm',
      emailVerified: true,
      appMetadata: { platform_admin: true },
      aal: 'aal2',
    });
    const adminClient = createPgLiteRpcClient(harness, aal2Admin);
    const allRecon = await reconcileShopLedger(null, adminClient);
    expect(allRecon.total_differences).toBe(0);

    // Negative tamper check inside a rolled-back transaction: prove reconcile_shop_ledger
    // catches a 1-unit stock tamper AND a 1-ngwee customer balance tamper!
    const targetShopId = shops[0].shopId;
    await harness.asServiceRole(async (tx) => {
      await tx.exec(`SAVEPOINT tamper_check`);
      await tx.query(
        `UPDATE public.items SET quantity = quantity + 1 WHERE shop_id = $1 AND id = 'p_item_0'`,
        [targetShopId]
      );
      await tx.query(
        `UPDATE public.customers SET total_owed_ngwee = total_owed_ngwee + 1 WHERE shop_id = $1 AND id = 'p_cust_0'`,
        [targetShopId]
      );
      const tampered = await tx.query<{
        payload: {
          total_differences: number;
          stock_movement_mismatch_count: number;
          customer_balance_mismatch_count: number;
        };
      }>(`SELECT public.reconcile_shop_ledger($1::uuid) AS payload`, [targetShopId]);
      expect(tampered.rows[0].payload.stock_movement_mismatch_count).toBe(1);
      expect(tampered.rows[0].payload.customer_balance_mismatch_count).toBe(1);
      expect(tampered.rows[0].payload.total_differences).toBe(2);
      await tx.exec(`ROLLBACK TO SAVEPOINT tamper_check`);
    });
  });
});
