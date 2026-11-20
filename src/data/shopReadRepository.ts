import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CreditPaymentRow,
  CustomerRow,
  ExpenseRow,
  ItemRow,
  SaleLineRow,
  SaleRow,
  ShopRow,
  StockConflictRow,
  StockMovementRow,
  SubscriptionPaymentRow,
} from './database.types';
import {
  computeOverlapQueryFloor,
  CURSOR_OVERLAP_WINDOW_MS,
  CursorTrackableRow,
  mergeRowsByCursorDedupe,
  ShopSyncCursors,
} from './cursorSync';
import {
  projectNgweeRowCacheToDomain,
  readShopNgweeRowCache,
  ShopDomainCacheSnapshot,
  ShopNgweeRowCache,
  writeShopNgweeRowCache,
  writeVersionedActiveShop,
} from './offlineCache';
import { shopRowToDomain } from './mappers';
import { supabase } from '../supabase/client';
import type { Shop } from '../types';

export type CursorSyncTableName =
  | 'items'
  | 'customers'
  | 'sales'
  | 'sale_lines'
  | 'credit_payments'
  | 'expenses'
  | 'stock_movements'
  | 'stock_conflicts'
  | 'subscription_payments';

export type ExtendedShopRow = ShopRow & {
  security_notice?: string | null;
  security_notice_at?: string | null;
};

export interface ShopReadQuerySource {
  fetchShop(shopId: string): Promise<ExtendedShopRow | null>;
  fetchUpdatedRows<TRow extends CursorTrackableRow>(
    table: CursorSyncTableName,
    shopId: string,
    sinceIso: string | null
  ): Promise<TRow[]>;
  fetchSaleLinesForSales(shopId: string, saleIds: readonly string[]): Promise<SaleLineRow[]>;
}

const PAGE_SIZE = 500;
const SALE_ID_CHUNK_SIZE = 200;

/**
 * PostgREST implementation of `ShopReadQuerySource` with deterministic
 * `(updated_at ASC, id ASC)` pagination so shops with >1,000 rows never truncate.
 */
export function createSupabaseShopReadQuerySource(
  client: SupabaseClient = supabase
): ShopReadQuerySource {
  return {
    async fetchShop(shopId) {
      const { data, error } = await client.from('shops').select('*').eq('id', shopId).maybeSingle();
      if (error) throw new Error(`Failed to load shop profile: ${error.message}`);
      return (data as ExtendedShopRow | null) ?? null;
    },

    async fetchUpdatedRows<TRow extends CursorTrackableRow>(
      table: CursorSyncTableName,
      shopId: string,
      sinceIso: string | null
    ): Promise<TRow[]> {
      const collected: TRow[] = [];
      let offset = 0;

      while (true) {
        let query = client.from(table).select('*').eq('shop_id', shopId);
        if (sinceIso) {
          query = query.gte('updated_at', sinceIso);
        }
        const { data, error } = await query
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
          throw new Error(`Failed to sync ${table}: ${error.message}`);
        }
        const batch = (data as TRow[] | null) ?? [];
        collected.push(...batch);
        if (batch.length < PAGE_SIZE) {
          break;
        }
        offset += PAGE_SIZE;
      }

      return collected;
    },

    async fetchSaleLinesForSales(shopId, saleIds) {
      if (saleIds.length === 0) return [];
      const collected: SaleLineRow[] = [];
      for (let i = 0; i < saleIds.length; i += SALE_ID_CHUNK_SIZE) {
        const slice = saleIds.slice(i, i + SALE_ID_CHUNK_SIZE);
        const { data, error } = await client
          .from('sale_lines')
          .select('*')
          .eq('shop_id', shopId)
          .in('sale_id', [...slice])
          .order('sale_id', { ascending: true })
          .order('line_index', { ascending: true });
        if (error) {
          throw new Error(`Failed to hydrate sale lines: ${error.message}`);
        }
        if (data) {
          collected.push(...(data as SaleLineRow[]));
        }
      }
      return collected;
    },
  };
}

export interface PullShopCursorSyncResult {
  shop: Shop | null;
  domain: ShopDomainCacheSnapshot;
  cursors: ShopSyncCursors;
  stats: {
    appliedCount: number;
    skippedDuplicateCount: number;
    skippedStaleCount: number;
  };
}

/**
 * Executes either an initial full load (when cursors are empty) or an
 * overlap-window incremental catch-up (`cursor - 120s`, deduplicated by
 * `(id, updated_at)`), persisting integer-ngwee rows and monotonic cursors to
 * the versioned local cache.
 */
export async function pullShopCursorSync(params: {
  shopId: string;
  querySource?: ShopReadQuerySource;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  overlapMs?: number;
}): Promise<PullShopCursorSyncResult> {
  const {
    shopId,
    querySource = createSupabaseShopReadQuerySource(),
    storage = localStorage,
    overlapMs = CURSOR_OVERLAP_WINDOW_MS,
  } = params;

  const currentCache = readShopNgweeRowCache(shopId, storage);
  const prevCursors = currentCache.cursors;

  const itemsFloor = computeOverlapQueryFloor(prevCursors.items, overlapMs);
  const customersFloor = computeOverlapQueryFloor(prevCursors.customers, overlapMs);
  const salesFloor = computeOverlapQueryFloor(prevCursors.sales, overlapMs);
  const saleLinesFloor = computeOverlapQueryFloor(prevCursors.sale_lines, overlapMs);
  const paymentsFloor = computeOverlapQueryFloor(prevCursors.credit_payments, overlapMs);
  const expensesFloor = computeOverlapQueryFloor(prevCursors.expenses, overlapMs);
  const movementsFloor = computeOverlapQueryFloor(prevCursors.stock_movements, overlapMs);
  const conflictsFloor = computeOverlapQueryFloor(prevCursors.stock_conflicts, overlapMs);
  const subPaymentsFloor = computeOverlapQueryFloor(prevCursors.subscription_payments, overlapMs);

  const [
    shopRow,
    incomingItems,
    incomingCustomers,
    incomingSales,
    incomingSaleLines,
    incomingPayments,
    incomingExpenses,
    incomingMovements,
    incomingConflicts,
    incomingSubPayments,
  ] = await Promise.all([
    querySource.fetchShop(shopId),
    querySource.fetchUpdatedRows<ItemRow>('items', shopId, itemsFloor),
    querySource.fetchUpdatedRows<CustomerRow>('customers', shopId, customersFloor),
    querySource.fetchUpdatedRows<SaleRow>('sales', shopId, salesFloor),
    querySource.fetchUpdatedRows<SaleLineRow>('sale_lines', shopId, saleLinesFloor),
    querySource.fetchUpdatedRows<CreditPaymentRow>('credit_payments', shopId, paymentsFloor),
    querySource.fetchUpdatedRows<ExpenseRow>('expenses', shopId, expensesFloor),
    querySource.fetchUpdatedRows<StockMovementRow>('stock_movements', shopId, movementsFloor),
    querySource.fetchUpdatedRows<StockConflictRow>('stock_conflicts', shopId, conflictsFloor),
    querySource.fetchUpdatedRows<SubscriptionPaymentRow>(
      'subscription_payments',
      shopId,
      subPaymentsFloor
    ),
  ]);

  // Ensure every fetched sale has its complete line-item set even if a sale's
  // `updated_at` bumped (e.g. voided or flagged) without touching `sale_lines`.
  const cachedSaleLineSaleIds = new Set(currentCache.saleLines.map((l) => l.sale_id));
  const incomingLineSaleIds = new Set(incomingSaleLines.map((l) => l.sale_id));
  const missingLineSaleIds = incomingSales
    .map((s) => s.id)
    .filter((id) => !cachedSaleLineSaleIds.has(id) && !incomingLineSaleIds.has(id));

  const hydratedSaleLines =
    missingLineSaleIds.length > 0
      ? await querySource.fetchSaleLinesForSales(shopId, missingLineSaleIds)
      : [];

  const itemsMerged = mergeRowsByCursorDedupe(
    currentCache.items,
    incomingItems,
    prevCursors.items ?? null
  );
  const customersMerged = mergeRowsByCursorDedupe(
    currentCache.customers,
    incomingCustomers,
    prevCursors.customers ?? null
  );
  const salesMerged = mergeRowsByCursorDedupe(
    currentCache.sales,
    incomingSales,
    prevCursors.sales ?? null
  );
  const saleLinesMerged = mergeRowsByCursorDedupe(
    currentCache.saleLines,
    [...incomingSaleLines, ...hydratedSaleLines],
    prevCursors.sale_lines ?? null
  );
  const paymentsMerged = mergeRowsByCursorDedupe(
    currentCache.creditPayments,
    incomingPayments,
    prevCursors.credit_payments ?? null
  );
  const expensesMerged = mergeRowsByCursorDedupe(
    currentCache.expenses,
    incomingExpenses,
    prevCursors.expenses ?? null
  );
  const movementsMerged = mergeRowsByCursorDedupe(
    currentCache.stockMovements,
    incomingMovements,
    prevCursors.stock_movements ?? null
  );
  const conflictsMerged = mergeRowsByCursorDedupe(
    currentCache.stockConflicts,
    incomingConflicts,
    prevCursors.stock_conflicts ?? null
  );
  const subPaymentsMerged = mergeRowsByCursorDedupe(
    currentCache.subscriptionPayments,
    incomingSubPayments,
    prevCursors.subscription_payments ?? null
  );

  const nextCursors: ShopSyncCursors = {
    items: itemsMerged.nextCursor,
    customers: customersMerged.nextCursor,
    sales: salesMerged.nextCursor,
    sale_lines: saleLinesMerged.nextCursor,
    credit_payments: paymentsMerged.nextCursor,
    expenses: expensesMerged.nextCursor,
    stock_movements: movementsMerged.nextCursor,
    stock_conflicts: conflictsMerged.nextCursor,
    subscription_payments: subPaymentsMerged.nextCursor,
  };

  const nextCache: ShopNgweeRowCache = {
    items: itemsMerged.rows,
    sales: salesMerged.rows,
    saleLines: saleLinesMerged.rows,
    customers: customersMerged.rows,
    creditPayments: paymentsMerged.rows,
    expenses: expensesMerged.rows,
    stockMovements: movementsMerged.rows,
    stockConflicts: conflictsMerged.rows,
    subscriptionPayments: subPaymentsMerged.rows,
    cursors: nextCursors,
  };

  writeShopNgweeRowCache(shopId, nextCache, storage);

  const mappedShop = shopRow ? shopRowToDomain(shopRow) : null;
  if (mappedShop) {
    writeVersionedActiveShop(mappedShop, storage);
  }

  const allMerges = [
    itemsMerged,
    customersMerged,
    salesMerged,
    saleLinesMerged,
    paymentsMerged,
    expensesMerged,
    movementsMerged,
    conflictsMerged,
    subPaymentsMerged,
  ];

  return {
    shop: mappedShop,
    domain: projectNgweeRowCacheToDomain(nextCache),
    cursors: nextCursors,
    stats: {
      appliedCount: allMerges.reduce((sum, m) => sum + m.appliedCount, 0),
      skippedDuplicateCount: allMerges.reduce((sum, m) => sum + m.skippedDuplicateCount, 0),
      skippedStaleCount: allMerges.reduce((sum, m) => sum + m.skippedStaleCount, 0),
    },
  };
}
