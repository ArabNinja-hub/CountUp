import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertSafeIntegerNgwee,
  clearVersionedShopCache,
  computeOverlapQueryFloor,
  createShopReadSyncCoordinator,
  CursorSyncTableName,
  LEGACY_V1_KWACHA_CACHE_KEYS,
  mergeRowsByCursorDedupe,
  parseTimestampToEpochMicros,
  pullShopCursorSync,
  readShopDomainCache,
  shopCollectionCacheKey,
  ShopReadQuerySource,
} from '../index';
import { createTestSupabaseDb, TestIdentity } from './supabaseTestHarness';

class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

function normalizeRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Date) {
      out[k] = v.toISOString();
    }
  }
  return out as T;
}

describe('Phase 3a Data Read Path, (cursor - 120s) Overlap Sync, Realtime Wake-Up & Versioned Ngwee Cache', () => {
  let harness: Awaited<ReturnType<typeof createTestSupabaseDb>>;
  let owner: TestIdentity;
  const shopId = '11111111-2222-4333-8444-555555555555';

  beforeAll(async () => {
    harness = await createTestSupabaseDb();
    owner = await harness.createAuthUser({
      phone: '+260977001122',
      appMetadata: { shop_id: shopId },
    });

    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.shops (
           id, owner_user_id, name, owner_phone, plan_status, plan_type,
           trial_ends_at, plan_expiry_at, sales_access_until, currency
         ) VALUES (
           $1, $2, 'woodlands mini mart', '+260977001122', 'trial', 'trial',
           '2026-12-20T00:00:00Z', '2026-12-20T00:00:00Z', '2026-12-23T00:00:00Z', 'ZMW'
         )`,
        [shopId, owner.id]
      );
      await tx.query(
        `INSERT INTO public.shop_verified_sessions (shop_id, session_id, user_id)
         VALUES ($1, 'owner-session-3a', $2)`,
        [shopId, owner.id]
      );
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  function createPgliteQuerySource(): {
    querySource: ShopReadQuerySource;
    sinceQueries: Array<{ table: CursorSyncTableName; sinceIso: string | null }>;
  } {
    const sinceQueries: Array<{ table: CursorSyncTableName; sinceIso: string | null }> = [];

    const querySource: ShopReadQuerySource = {
      async fetchShop(targetShopId) {
        return harness.asUser(owner, async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shops WHERE id = $1 LIMIT 1`,
            [targetShopId]
          );
          return res.rows[0] ? (normalizeRowTimestamps(res.rows[0]) as never) : null;
        });
      },
      async fetchUpdatedRows(table, targetShopId, sinceIso) {
        sinceQueries.push({ table, sinceIso });
        return harness.asUser(owner, async (tx) => {
          if (sinceIso) {
            const res = await tx.query<Record<string, unknown>>(
              `SELECT * FROM public.${table}
               WHERE shop_id = $1 AND updated_at >= $2::timestamptz
               ORDER BY updated_at ASC, id ASC`,
              [targetShopId, sinceIso]
            );
            return res.rows.map((r) => normalizeRowTimestamps(r)) as never;
          }
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.${table}
             WHERE shop_id = $1
             ORDER BY updated_at ASC, id ASC`,
            [targetShopId]
          );
          return res.rows.map((r) => normalizeRowTimestamps(r)) as never;
        });
      },
      async fetchSaleLinesForSales(targetShopId, saleIds) {
        if (saleIds.length === 0) return [];
        return harness.asUser(owner, async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.sale_lines
             WHERE shop_id = $1 AND sale_id = ANY($2::text[])
             ORDER BY sale_id ASC, line_index ASC`,
            [targetShopId, [...saleIds]]
          );
          return res.rows.map((r) => normalizeRowTimestamps(r)) as never;
        });
      },
    };

    return { querySource, sinceQueries };
  }

  it('performs full initial load across all 9 shop tables, maps integer ngwee to domain Kwacha cleanly, and assembles sale_lines into Sale.items', async () => {
    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.items (
           id, shop_id, name, buying_price_ngwee, selling_price_ngwee, quantity, low_stock_threshold,
           created_at, updated_at
         ) VALUES
           ('item-bread', $1, 'Bread Loaf', 1800, 2500, 20, 4, '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z'),
           ('item-old',   $1, 'Discontinued Soap', 900, 1200, 0, 2, '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z')`,
        [shopId]
      );
      await tx.query(
        `UPDATE public.items SET is_deleted = true WHERE shop_id = $1 AND id = 'item-old'`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.customers (
           id, shop_id, name, phone, total_owed_ngwee, created_at, updated_at
         ) VALUES ('cust-banda', $1, 'Mr Banda', '+260971234567', 2500, '2026-11-20T10:01:00Z', '2026-11-20T10:01:00Z')`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.sales (
           id, shop_id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
           missing_cost_revenue_ngwee, payment_type, customer_id, receipt_number,
           created_at, updated_at
         ) VALUES (
           'sale-100', $1, 2, 5000, 3600, 1400, 0, 'credit', 'cust-banda', 'CU-20261120-001',
           '2026-11-20T10:02:00Z', '2026-11-20T10:02:00Z'
         )`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.sale_lines (
           id, shop_id, sale_id, line_index, item_id, item_name, quantity,
           buying_price_ngwee, selling_price_ngwee, line_total_ngwee,
           created_at, updated_at
         ) VALUES (
           'line-100-1', $1, 'sale-100', 0, 'item-bread', 'Bread Loaf', 2,
           1800, 2500, 5000, '2026-11-20T10:02:00Z', '2026-11-20T10:02:00Z'
         )`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.credit_payments (
           id, shop_id, customer_id, customer_name, amount_ngwee, payment_method,
           created_at, updated_at
         ) VALUES (
           'pay-100', $1, 'cust-banda', 'Mr Banda', 2500, 'cash',
           '2026-11-20T10:02:30Z', '2026-11-20T10:02:30Z'
         )`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.expenses (
           id, shop_id, category, amount_ngwee, note, created_at, updated_at
         ) VALUES (
           'exp-100', $1, 'transport', 3000, 'Minibus to town',
           '2026-11-20T10:03:00Z', '2026-11-20T10:03:00Z'
         )`,
        [shopId]
      );
      await tx.query(
        `INSERT INTO public.stock_movements (
           id, shop_id, item_id, item_name, type, delta, previous_quantity, new_quantity, reason, related_sale_id,
           created_at, updated_at
         ) VALUES (
           'mov-100', $1, 'item-bread', 'Bread Loaf', 'sale', -2, 22, 20, 'Sold', 'sale-100',
           '2026-11-20T10:02:00Z', '2026-11-20T10:02:00Z'
         )`,
        [shopId]
      );
    });

    const storage = new MemoryStorage();
    const { querySource, sinceQueries } = createPgliteQuerySource();
    const initial = await pullShopCursorSync({
      shopId,
      querySource,
      storage,
    });

    expect(sinceQueries.every((q) => q.sinceIso === null)).toBe(true);
    expect(initial.shop?.id).toBe(shopId);
    expect(initial.domain.items).toHaveLength(1);
    expect(initial.domain.items[0]).toMatchObject({
      id: 'item-bread',
      buyingPrice: 18,
      sellingPrice: 25,
      quantity: 20,
    });
    expect(initial.domain.archivedItems).toHaveLength(1);
    expect(initial.domain.archivedItems[0].id).toBe('item-old');
    expect(initial.domain.sales).toHaveLength(1);
    expect(initial.domain.sales[0]).toMatchObject({
      id: 'sale-100',
      totalAmount: 50,
      profit: 14,
      items: [{ itemId: 'item-bread', quantity: 2, buyingPrice: 18, sellingPrice: 25 }],
    });
    expect(initial.domain.customers[0].totalOwed).toBe(25);
    expect(initial.domain.creditPayments[0].amount).toBe(25);
    expect(initial.domain.expenses[0].amount).toBe(30);
  });

  it('re-fetches from (cursor - 120s) on reconnect, catches delayed server commits inside the overlap window, deduplicates by (id, updated_at), and propagates voids/archives/deletes', async () => {
    const storage = new MemoryStorage();
    const { querySource, sinceQueries } = createPgliteQuerySource();
    await pullShopCursorSync({ shopId, querySource, storage });

    // Advance items cursor to 2026-11-21T10:10:00Z via a new item (using superuser db handle to set deterministic timestamp)
    await harness.db.query(`ALTER TABLE public.items DISABLE TRIGGER trg_items_touch_updated_at`);
    await harness.db.query(
      `INSERT INTO public.items (
         id, shop_id, name, buying_price_ngwee, selling_price_ngwee, quantity, low_stock_threshold,
         created_at, updated_at
       ) VALUES (
         'item-cooking-oil', $1, 'Cooking Oil 2.5L', 8500, 10500, 8, 2,
         '2026-11-21T10:10:00Z', '2026-11-21T10:10:00Z'
       )`,
      [shopId]
    );
    await harness.db.query(`ALTER TABLE public.items ENABLE TRIGGER trg_items_touch_updated_at`);

    const secondPull = await pullShopCursorSync({ shopId, querySource, storage });
    expect(secondPull.cursors.items).toBe('2026-11-21T10:10:00.000Z');

    // Simulate:
    // 1. An out-of-order / delayed transaction that committed at updated_at = 2026-11-21T10:08:30Z
    //    (90s BEFORE the 10:10:00Z cursor — inside the 120s overlap window!)
    // 2. Voiding sale-100 (`is_deleted = true`)
    // 3. Soft-deleting expense exp-100 (`is_deleted = true`)
    await harness.db.query(`ALTER TABLE public.items DISABLE TRIGGER trg_items_touch_updated_at`);
    await harness.db.query(
      `INSERT INTO public.items (
         id, shop_id, name, buying_price_ngwee, selling_price_ngwee, quantity, low_stock_threshold,
         created_at, updated_at
       ) VALUES (
         'item-delayed-tx', $1, 'Salt 500g', 500, 800, 30, 5,
         '2026-11-21T10:08:30Z', '2026-11-21T10:08:30Z'
       )`,
      [shopId]
    );
    await harness.db.query(`ALTER TABLE public.items ENABLE TRIGGER trg_items_touch_updated_at`);

    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.sales SET is_deleted = true WHERE shop_id = $1 AND id = 'sale-100'`,
        [shopId]
      );
      await tx.query(
        `UPDATE public.expenses SET is_deleted = true WHERE shop_id = $1 AND id = 'exp-100'`,
        [shopId]
      );
    });

    sinceQueries.length = 0;
    const reconnectPull = await pullShopCursorSync({ shopId, querySource, storage });

    // Verify items query subtracted 120s from 10:10:00Z -> queried from 2026-11-21T10:08:00.000Z!
    const itemsQuery = sinceQueries.find((q) => q.table === 'items');
    expect(itemsQuery?.sinceIso).toBe(computeOverlapQueryFloor('2026-11-21T10:10:00.000Z'));
    expect(itemsQuery?.sinceIso).toBe('2026-11-21T10:08:00.000Z');

    // Delayed row at 10:08:30Z was caught AND item-cooking-oil (re-fetched in overlap) was deduplicated!
    const activeItemIds = reconnectPull.domain.items.map((i) => i.id).sort();
    expect(activeItemIds).toEqual(['item-bread', 'item-cooking-oil', 'item-delayed-tx']);
    expect(reconnectPull.stats.skippedDuplicateCount).toBeGreaterThanOrEqual(1);

    // Voided sale & deleted expense propagated via updated_at!
    const voidedSale = reconnectPull.domain.sales.find((s) => s.id === 'sale-100') as unknown as {
      isDeleted?: boolean;
    };
    expect(voidedSale?.isDeleted).toBe(true);
    const activeExpenses = reconnectPull.domain.expenses.filter(
      (e) => !(e as unknown as { isDeleted?: boolean }).isDeleted
    );
    expect(activeExpenses).toHaveLength(0);
  });

  it('preserves microsecond updated_at precision during rapid same-millisecond Postgres updates', () => {
    const t1 = '2026-11-20T12:00:00.123456+00:00';
    const t2 = '2026-11-20T12:00:00.123457+00:00'; // +1 microsecond from touch_updated_at()
    expect(parseTimestampToEpochMicros(t2)).toBe(parseTimestampToEpochMicros(t1) + 1n);

    const merged = mergeRowsByCursorDedupe(
      [{ id: 'item-1', updated_at: t2, qty: 9 }],
      [{ id: 'item-1', updated_at: t1, qty: 10 }],
      t2
    );
    expect(merged.rows[0].qty).toBe(9);
    expect(merged.skippedStaleCount).toBe(1);
    expect(merged.nextCursor).toBe(t2);
  });

  it('treats Realtime strictly as a debounced wake-up signal and coalesces rapid events + mid-flight bursts', async () => {
    vi.useFakeTimers();
    try {
      const reasons: string[] = [];
      let resolveInFlight: (() => void) | null = null;
      let emitWakeup: (() => void) | null = null;

      const coordinator = createShopReadSyncCoordinator({
        shopId,
        debounceMs: 100,
        realtimeSource: {
          subscribeToShopChanges(_id, onWakeup) {
            emitWakeup = onWakeup;
            return () => {
              emitWakeup = null;
            };
          },
        },
        runCursorPull: (reason) =>
          new Promise<void>((resolve) => {
            reasons.push(reason);
            resolveInFlight = resolve;
          }),
      });

      // Initial pull starts immediately
      expect(reasons).toEqual(['initial']);
      resolveInFlight?.();
      await Promise.resolve();

      // Fire 5 rapid Realtime events within 100ms -> coalesced into ONE cursor pull!
      emitWakeup?.();
      emitWakeup?.();
      emitWakeup?.();
      emitWakeup?.();
      emitWakeup?.();

      await vi.advanceTimersByTimeAsync(100);
      expect(reasons).toEqual(['initial', 'realtime']);

      // Fire another wake-up while the realtime pull is still in-flight
      emitWakeup?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(reasons).toEqual(['initial', 'realtime']); // still 1 in-flight

      // Completing the in-flight pull immediately runs ONE trailing catch-up pull so nothing is missed!
      resolveInFlight?.();
      await Promise.resolve();
      expect(reasons).toEqual(['initial', 'realtime', 'realtime']);
      resolveInFlight?.();

      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates versioned ngwee cache keys, purges legacy Kwacha keys on write/clear, and rejects non-integer floats', async () => {
    const storage = new MemoryStorage();

    // Seed legacy v1 Kwacha float keys in storage
    storage.setItem('countup_items', JSON.stringify([{ id: 'legacy', sellingPrice: 12.5 }]));
    storage.setItem('countup_sales', JSON.stringify([{ id: 'legacy-sale', totalAmount: 25.75 }]));

    const { querySource } = createPgliteQuerySource();
    await pullShopCursorSync({ shopId, querySource, storage });

    // Legacy Kwacha keys were actively purged so floats and ngwee can NEVER mix!
    for (const legacyKey of LEGACY_V1_KWACHA_CACHE_KEYS) {
      expect(storage.getItem(legacyKey)).toBeNull();
    }

    // Stored raw cache envelope holds integer ngwee (2500 ngwee = K25.00), never floats
    const itemsKey = shopCollectionCacheKey(shopId, 'items');
    const rawEnvelope = JSON.parse(storage.getItem(itemsKey)!);
    const breadRow = rawEnvelope.payload.find((r: { id: string }) => r.id === 'item-bread');
    expect(breadRow.selling_price_ngwee).toBe(2500);

    // Corrupting a cached money column with a Kwacha float causes safe rejection of that row
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    breadRow.selling_price_ngwee = 25.5;
    storage.setItem(itemsKey, JSON.stringify(rawEnvelope));
    const afterCorrupt = readShopDomainCache(shopId, storage);
    expect(afterCorrupt.items.find((i) => i.id === 'item-bread')).toBeUndefined();
    warnSpy.mockRestore();

    // Direct ngwee guard throws on non-integers
    expect(() => assertSafeIntegerNgwee(19.99, 'selling_price_ngwee')).toThrow(
      /Expected integer ngwee/
    );

    clearVersionedShopCache(shopId, storage);
    expect(storage.length).toBe(0);
  });
});
