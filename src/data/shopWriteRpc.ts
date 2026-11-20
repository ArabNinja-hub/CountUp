import { supabase } from '../supabase/client';
import type { CreditPayment, Customer, Expense, Item, Sale, StockMovement } from '../types';
import { fromNgwee, toNgwee } from '../utils/money';
import { PendingSyncAction, SyncProjectionDocument } from '../utils/sync';
import type { ShopBackupPreview } from '../services/backupImport';
import {
  CreditBalanceConflict,
  describeQueuedActionSummary,
  ReviewableSyncAction,
  SyncConflictReview,
  SyncResolutionAudit,
  SyncReviewDecision,
  voidActionSaleId,
} from '../services/syncReview';
import type {
  CreditPaymentRow,
  CustomerRow,
  ItemRow,
  LedgerReconciliationReport,
  SaleLineRow,
  SaleRow,
  StockMovementRow,
  SyncOperationRow,
} from './database.types';
import {
  creditPaymentRowToDomain,
  customerRowToDomain,
  itemRowToDomain,
  saleRowsToDomain,
  stockMovementRowToDomain,
} from './mappers';

/**
 * Maximum number of queued operations sent in a single `apply_sync_batch` RPC
 * round-trip (the database function allows up to 100; 50 keeps payloads well
 * within mobile 2G/3G packet timeouts in Zambia while syncing 500+ queued
 * operations in ~10 round-trips).
 */
export const SYNC_BATCH_CHUNK_SIZE = 50;

export type SyncOperation = PendingSyncAction;

function actionTouchedPaths(action: SyncOperation): string[] {
  const paths = new Set<string>([action.path]);
  for (const adjustment of action.adjustments ?? []) {
    paths.add(adjustment.path);
    if (adjustment.kind === 'stock') paths.add(adjustment.movement.path);
  }
  return [...paths];
}

export interface ShopRpcSelectBuilder extends PromiseLike<{ data: unknown; error: unknown }> {
  select: (columns?: string) => ShopRpcSelectBuilder;
  eq: (column: string, value: unknown) => ShopRpcSelectBuilder;
  order: (column: string, opts?: { ascending?: boolean }) => ShopRpcSelectBuilder;
  maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
}

export interface ShopRpcQueryClient {
  from: (table: string) => ShopRpcSelectBuilder;
  rpc: (
    fnName: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}

let testWriteClientOverride: ShopRpcQueryClient | null = null;

export function setShopWriteClientOverrideForTests(client: ShopRpcQueryClient | null): void {
  testWriteClientOverride = client;
}

export function getActiveShopWriteClient(): ShopRpcQueryClient {
  return testWriteClientOverride ?? (supabase as unknown as ShopRpcQueryClient);
}

export interface RpcSaleLinePayload {
  line_id?: string;
  item_id: string;
  item_name: string;
  unit_label: string;
  quantity: number;
  selling_price_ngwee: number;
  buying_price_ngwee: number;
  buying_price_known: boolean;
  movement_id?: string;
  reason?: string;
}

export type NormalizedSyncRpcDescriptor =
  | {
      rpc: 'record_sale';
      operation_id: string;
      sale_id: string;
      lines: RpcSaleLinePayload[];
      payment_type: Sale['paymentType'];
      receipt_number: string;
      momo_operator: Sale['momoOperator'] | null;
      customer_id: string | null;
      customer_name: string | null;
      customer_phone: string | null;
      payment_reference: string | null;
      note: string | null;
      local_date: string | null;
      cash_tendered_ngwee: number | null;
      change_given_ngwee: number | null;
      client_created_at: string | null;
      is_offline_sync: boolean;
      offline_window_seconds: number;
    }
  | {
      rpc: 'undo_sale';
      operation_id: string;
      sale_id: string;
      movements: Array<{ item_id: string; movement_id: string; reason: string }>;
      expected_checks: {
        has_credit_adjustment: boolean;
        customer_id: string | null;
        credit_delta_ngwee: number | null;
        stock_deltas: Array<{ item_id: string; delta: number }>;
      };
    }
  | {
      rpc: 'record_repayment';
      operation_id: string;
      payment_id: string;
      customer_id: string;
      amount_ngwee: number;
      payment_method: 'cash' | 'momo';
      note: string;
      local_date: string | null;
      created_at: string | null;
    }
  | {
      rpc: 'apply_stock_count';
      operation_id: string;
      item_id: string;
      mode: 'set' | 'delta';
      quantity: number;
      observed_quantity: number | null;
      movement_id: string | null;
      movement_type: StockMovement['type'];
      reason: string;
      metadata: Record<string, unknown> | null;
    }
  | {
      rpc: 'resolve_stock_conflict';
      operation_id: string;
      conflict_id: string;
    }
  | {
      rpc: 'upsert_shop_item';
      operation_id: string;
      item_id: string;
      patch: Record<string, unknown>;
      initial_movement: Record<string, unknown> | null;
    }
  | {
      rpc: 'upsert_shop_customer';
      operation_id: string;
      customer_id: string;
      patch: Record<string, unknown>;
    }
  | {
      rpc: 'upsert_shop_expense';
      operation_id: string;
      expense_id: string;
      patch: Record<string, unknown>;
    };

export class SupabaseSyncRpcError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(message: string, code = '', detail = '') {
    super(message);
    this.name = 'SupabaseSyncRpcError';
    this.code = code;
    this.detail = detail;
  }
}

export function normalizeSupabaseError(err: unknown): Error {
  if (err instanceof CreditBalanceConflict || err instanceof SupabaseSyncRpcError) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const rec = err as {
      code?: unknown;
      details?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const code = typeof rec.code === 'string' ? rec.code : '';
    const detail =
      typeof rec.details === 'string'
        ? rec.details
        : typeof rec.detail === 'string'
          ? rec.detail
          : '';
    const message =
      typeof rec.message === 'string' && rec.message.trim()
        ? rec.message
        : err instanceof Error
          ? err.message
          : 'Sync request failed.';
    if (
      detail.includes('CREDIT_BALANCE_CONFLICT') ||
      message.includes('CREDIT_BALANCE_CONFLICT') ||
      message.includes('conflicts with a newer customer balance')
    ) {
      return new CreditBalanceConflict(message);
    }
    return new SupabaseSyncRpcError(message, code, detail);
  }
  return new Error(String(err));
}

export function isTransientSupabaseSyncError(error: unknown): boolean {
  if (error instanceof CreditBalanceConflict) return false;
  if (typeof error === 'object' && error !== null) {
    const rec = error as { code?: unknown; detail?: unknown; details?: unknown; message?: unknown };
    const code = String(rec.code ?? '');
    const detail = String(rec.detail ?? rec.details ?? '');
    const message = String(rec.message ?? '');

    // Transient Postgres serialization / deadlock / connection codes or legacy mock codes
    if (
      ['40001', '40P01', '08000', '08003', '08006', '53300', '57P03'].includes(code) ||
      ['unavailable', 'deadline-exceeded', 'aborted', 'resource-exhausted', 'internal'].includes(
        code.replace(/^firestore\//, '')
      )
    ) {
      return true;
    }

    // Explicit non-transient domain/validation/auth/plan errors
    if (
      ['42501', '22023', '23514', '23505', 'P0002'].includes(code) ||
      [
        'SHOP_SUSPENDED',
        'PLAN_EXPIRED',
        'SALE_NOT_FOUND',
        'ITEM_NOT_FOUND',
        'CUSTOMER_NOT_FOUND',
        'CREDIT_BALANCE_CONFLICT',
      ].some((tag) => detail.includes(tag))
    ) {
      return false;
    }

    if (
      /Failed to fetch|NetworkError|Load failed|network|timeout|ETIMEDOUT|ECONNRESET|HTTP 50[234]|503 Service Unavailable/i.test(
        message
      )
    ) {
      return true;
    }
  }
  return false;
}

function extractTailId(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const tail = path.slice(prefix.length);
  if (!tail || tail.includes('/')) return null;
  return tail;
}

function convertItemMetadataToRpc(meta: Partial<Item> | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  if (meta.name !== undefined) out.name = meta.name;
  if (meta.unitLabel !== undefined) out.unit_label = meta.unitLabel;
  if (meta.buyingPriceKnown !== undefined) out.buying_price_known = meta.buyingPriceKnown;
  if (meta.buyingPrice !== undefined) out.buying_price_ngwee = toNgwee(meta.buyingPrice);
  if (meta.sellingPrice !== undefined) out.selling_price_ngwee = toNgwee(meta.sellingPrice);
  if (meta.lowStockThreshold !== undefined) out.low_stock_threshold = meta.lowStockThreshold;
  if (meta.isDeleted !== undefined) out.is_deleted = meta.isDeleted;
  if (meta.createdAt !== undefined) out.created_at = meta.createdAt;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validates and translates a queued `SyncOperation` into a normalized atomic
 * Supabase RPC descriptor without losing any consistency invariants.
 */
export function translateSyncActionToRpc(
  action: SyncOperation,
  shopId: string,
  options?: { isOfflineSync?: boolean; offlineWindowSeconds?: number }
): NormalizedSyncRpcDescriptor {
  if (!action.id || action.id.includes('/')) {
    throw new Error('A waiting entry has an invalid ID. Keep this browser’s data.');
  }

  const root = `shops/${shopId}`;
  const writes = action.writes ?? [{ path: action.path, data: action.data }];
  const writePaths = writes.map((w) => w.path);
  const adjustments = action.adjustments ?? [];
  const adjustmentPaths = adjustments.map((a) => a.path);

  if (
    !writes.length ||
    writes[0].path !== action.path ||
    new Set(writePaths).size !== writes.length ||
    new Set(adjustmentPaths).size !== adjustmentPaths.length ||
    adjustments.some(
      (entry) =>
        !writePaths.includes(entry.path) ||
        (entry.kind === 'stock' && !writePaths.includes(entry.movement.path))
    )
  ) {
    throw new Error('A waiting entry is incomplete or inconsistent. Keep this browser’s data.');
  }

  const possibleVoid = writes.some(
    (w) =>
      w.path.startsWith(`${root}/sales/`) &&
      (w.data as { isDeleted?: boolean } | null)?.isDeleted === true
  );
  const voidSaleId = voidActionSaleId(action, shopId);
  if (possibleVoid && !voidSaleId) {
    throw new Error('This queued sale undo cannot be verified. Keep this browser’s data.');
  }

  // 1. Sale Undo (`undo_sale`)
  if (voidSaleId) {
    const creditAdj = adjustments.find((a) => a.kind === 'credit');
    const expectedCustomerId =
      creditAdj && creditAdj.kind === 'credit'
        ? extractTailId(creditAdj.path, `${root}/customers/`)
        : null;
    const stockAdjustments = adjustments.filter(
      (a): a is Extract<typeof a, { kind: 'stock' }> => a.kind === 'stock'
    );

    return {
      rpc: 'undo_sale',
      operation_id: action.id,
      sale_id: voidSaleId,
      movements: stockAdjustments.map((s) => ({
        item_id: s.movement.data.itemId,
        movement_id: s.movement.data.id,
        reason: s.movement.data.reason,
      })),
      expected_checks: {
        has_credit_adjustment: Boolean(creditAdj),
        customer_id: expectedCustomerId,
        credit_delta_ngwee: creditAdj && creditAdj.kind === 'credit' ? creditAdj.deltaNgwee : null,
        stock_deltas: stockAdjustments.map((s) => ({
          item_id: s.movement.data.itemId,
          delta: s.delta,
        })),
      },
    };
  }

  // 2. Record Sale (`record_sale`)
  const saleWrite = writes.find((w) => w.path.startsWith(`${root}/sales/`));
  if (action.type === 'sale' && saleWrite) {
    const saleId = extractTailId(saleWrite.path, `${root}/sales/`);
    if (!saleId) {
      throw new Error('Invalid sale path in sync queue.');
    }
    const sale = saleWrite.data as Sale;
    const stockByItemId = new Map<
      string,
      Extract<(typeof adjustments)[number], { kind: 'stock' }>
    >();
    for (const adj of adjustments) {
      if (adj.kind === 'stock') {
        stockByItemId.set(adj.movement.data.itemId, adj);
      }
    }

    const lines: RpcSaleLinePayload[] = (sale.items ?? []).map((line, idx) => {
      const stockAdj = stockByItemId.get(line.itemId);
      const buyingKnown = line.buyingPriceKnown !== false;
      return {
        line_id: `${saleId}:${idx}`,
        item_id: line.itemId,
        item_name: line.name,
        unit_label: line.unitLabel ?? '',
        quantity: line.quantity,
        selling_price_ngwee: toNgwee(line.sellingPrice),
        buying_price_ngwee: buyingKnown ? toNgwee(line.buyingPrice ?? 0) : 0,
        buying_price_known: buyingKnown,
        movement_id: stockAdj?.movement.data.id,
        reason: stockAdj?.movement.data.reason,
      };
    });

    return {
      rpc: 'record_sale',
      operation_id: action.id,
      sale_id: saleId,
      lines,
      payment_type: sale.paymentType,
      receipt_number: sale.receiptNumber || saleId,
      momo_operator: sale.momoOperator ?? null,
      customer_id: sale.customerId ?? null,
      customer_name: sale.customerName ?? null,
      customer_phone: sale.customerPhone ?? null,
      payment_reference: sale.paymentReference ?? null,
      note: sale.note ?? null,
      local_date: sale.localDate ?? null,
      cash_tendered_ngwee: sale.cashTendered !== undefined ? toNgwee(sale.cashTendered) : null,
      change_given_ngwee: sale.changeGiven !== undefined ? toNgwee(sale.changeGiven) : null,
      client_created_at: sale.createdAt ?? null,
      is_offline_sync: action.queuedOffline ?? options?.isOfflineSync ?? false,
      offline_window_seconds: options?.offlineWindowSeconds ?? 259_200,
    };
  }

  // 3. Record Credit Repayment (`record_repayment`)
  const paymentWrite = writes.find((w) => w.path.startsWith(`${root}/credit_payments/`));
  if (action.type === 'payment' && paymentWrite) {
    const paymentId = extractTailId(paymentWrite.path, `${root}/credit_payments/`);
    if (!paymentId) throw new Error('Invalid repayment path in sync queue.');
    const payment = paymentWrite.data as CreditPayment;
    return {
      rpc: 'record_repayment',
      operation_id: action.id,
      payment_id: paymentId,
      customer_id: payment.customerId,
      amount_ngwee: toNgwee(payment.amount),
      payment_method: payment.paymentMethod ?? 'cash',
      note: payment.note ?? '',
      local_date: payment.localDate ?? null,
      created_at: payment.createdAt ?? null,
    };
  }

  // 4. Stock Conflict Resolution (`resolve_stock_conflict`)
  const conflictWrite = writes.find((w) => w.path.startsWith(`${root}/stock_conflicts/`));
  if (conflictWrite) {
    const conflictId = extractTailId(conflictWrite.path, `${root}/stock_conflicts/`);
    if (!conflictId) throw new Error('Invalid stock conflict path in sync queue.');
    return {
      rpc: 'resolve_stock_conflict',
      operation_id: action.id,
      conflict_id: conflictId,
    };
  }

  // 5. Stock Count / Adjustment / Restock (`apply_stock_count`)
  if (
    action.type === 'stock_update' &&
    adjustments.length === 1 &&
    adjustments[0].kind === 'stock'
  ) {
    const stockAdj = adjustments[0];
    const itemId = extractTailId(stockAdj.path, `${root}/items/`);
    if (!itemId) throw new Error('Invalid item path in stock adjustment.');
    const isSet = stockAdj.setTo !== undefined;
    return {
      rpc: 'apply_stock_count',
      operation_id: action.id,
      item_id: itemId,
      mode: isSet ? 'set' : 'delta',
      quantity: isSet ? stockAdj.setTo! : stockAdj.delta,
      observed_quantity: isSet ? stockAdj.movement.data.previousQuantity : null,
      movement_id: stockAdj.movement.data.id,
      movement_type: stockAdj.movement.data.type,
      reason: stockAdj.movement.data.reason,
      metadata: convertItemMetadataToRpc(stockAdj.metadata),
    };
  }

  // 6. Item Create / Catalog Update / Archive / Restore (`upsert_shop_item`)
  const itemWrite = writes.find((w) => w.path.startsWith(`${root}/items/`));
  if (action.type === 'item' && itemWrite) {
    const itemId = extractTailId(itemWrite.path, `${root}/items/`);
    if (!itemId) throw new Error('Invalid item path in sync queue.');
    const itemData = itemWrite.data as Partial<Item>;
    const patch: Record<string, unknown> = {
      ...(convertItemMetadataToRpc(itemData) ?? {}),
    };
    if (itemData.quantity !== undefined) {
      patch.quantity = itemData.quantity;
    }

    const mvWrite = writes.find((w) => w.path.startsWith(`${root}/stock_movements/`));
    const mv = mvWrite ? (mvWrite.data as StockMovement) : null;
    return {
      rpc: 'upsert_shop_item',
      operation_id: action.id,
      item_id: itemId,
      patch,
      initial_movement: mv
        ? {
            id: mv.id,
            reason: mv.reason,
            created_at: mv.createdAt,
          }
        : null,
    };
  }

  // 7. Customer Create / Profile Update (`upsert_shop_customer`)
  const customerWrite = writes.find((w) => w.path.startsWith(`${root}/customers/`));
  if (action.type === 'customer' && customerWrite) {
    const customerId = extractTailId(customerWrite.path, `${root}/customers/`);
    if (!customerId) throw new Error('Invalid customer path in sync queue.');
    const customer = customerWrite.data as Partial<Customer>;
    const patch: Record<string, unknown> = {};
    if (customer.name !== undefined) patch.name = customer.name;
    if (customer.phone !== undefined) patch.phone = customer.phone;
    if (customer.notes !== undefined) patch.notes = customer.notes;
    if (customer.createdAt !== undefined) patch.created_at = customer.createdAt;
    return {
      rpc: 'upsert_shop_customer',
      operation_id: action.id,
      customer_id: customerId,
      patch,
    };
  }

  // 8. Expense Create / Delete (`upsert_shop_expense`)
  const expenseWrite = writes.find((w) => w.path.startsWith(`${root}/expenses/`));
  if (action.type === 'expense' && expenseWrite) {
    const expenseId = extractTailId(expenseWrite.path, `${root}/expenses/`);
    if (!expenseId) throw new Error('Invalid expense path in sync queue.');
    const expense = expenseWrite.data as Partial<Expense> & { isDeleted?: boolean };
    const patch: Record<string, unknown> = {};
    if (expense.category !== undefined) patch.category = expense.category;
    if (expense.amount !== undefined) patch.amount_ngwee = toNgwee(expense.amount);
    if (expense.note !== undefined) patch.note = expense.note;
    if (expense.isDeleted !== undefined) patch.is_deleted = expense.isDeleted;
    if (expense.createdAt !== undefined) patch.created_at = expense.createdAt;
    return {
      rpc: 'upsert_shop_expense',
      operation_id: action.id,
      expense_id: expenseId,
      patch,
    };
  }

  throw new Error('A waiting entry has an unsupported sync operation shape.');
}

/**
 * Reads authoritative server state for all documents touched by `action` so
 * `acknowledgeAction(action, base)` can rebase later optimistic queue entries
 * after a conflict resolution or duplicate `already-voided` sale undo.
 */
export async function readAuthoritativeResolutionBase(
  shopId: string,
  action: SyncOperation,
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<SyncProjectionDocument[]> {
  const root = `shops/${shopId}`;
  const paths = actionTouchedPaths(action);
  const docs: SyncProjectionDocument[] = [];

  for (const path of paths) {
    const itemId = extractTailId(path, `${root}/items/`);
    if (itemId) {
      const { data, error } = await client
        .from('items')
        .select('*')
        .eq('shop_id', shopId)
        .eq('id', itemId)
        .maybeSingle();
      if (error) throw normalizeSupabaseError(error);
      docs.push({
        path,
        data: data
          ? (itemRowToDomain(data as ItemRow) as unknown as Record<string, unknown>)
          : null,
      });
      continue;
    }

    const saleId = extractTailId(path, `${root}/sales/`);
    if (saleId) {
      const [{ data: saleData, error: saleErr }, { data: lineData, error: lineErr }] =
        await Promise.all([
          client.from('sales').select('*').eq('shop_id', shopId).eq('id', saleId).maybeSingle(),
          client
            .from('sale_lines')
            .select('*')
            .eq('shop_id', shopId)
            .eq('sale_id', saleId)
            .order('line_index', { ascending: true }),
        ]);
      if (saleErr) throw normalizeSupabaseError(saleErr);
      if (lineErr) throw normalizeSupabaseError(lineErr);
      if (!saleData) {
        docs.push({ path, data: null });
      } else {
        const mapped = saleRowsToDomain(saleData as SaleRow, (lineData ?? []) as SaleLineRow[]);
        docs.push({
          path,
          data: {
            ...mapped,
            isDeleted: Boolean((saleData as SaleRow).is_deleted),
          } as unknown as Record<string, unknown>,
        });
      }
      continue;
    }

    const customerId = extractTailId(path, `${root}/customers/`);
    if (customerId) {
      const { data, error } = await client
        .from('customers')
        .select('*')
        .eq('shop_id', shopId)
        .eq('id', customerId)
        .maybeSingle();
      if (error) throw normalizeSupabaseError(error);
      docs.push({
        path,
        data: data
          ? (customerRowToDomain(data as CustomerRow) as unknown as Record<string, unknown>)
          : null,
      });
      continue;
    }

    const paymentId = extractTailId(path, `${root}/credit_payments/`);
    if (paymentId) {
      const { data, error } = await client
        .from('credit_payments')
        .select('*')
        .eq('shop_id', shopId)
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw normalizeSupabaseError(error);
      docs.push({
        path,
        data: data
          ? (creditPaymentRowToDomain(data as CreditPaymentRow) as unknown as Record<
              string,
              unknown
            >)
          : null,
      });
      continue;
    }

    const movementId = extractTailId(path, `${root}/stock_movements/`);
    if (movementId) {
      const { data, error } = await client
        .from('stock_movements')
        .select('*')
        .eq('shop_id', shopId)
        .eq('id', movementId)
        .maybeSingle();
      if (error) throw normalizeSupabaseError(error);
      docs.push({
        path,
        data: data
          ? (stockMovementRowToDomain(data as StockMovementRow) as unknown as Record<
              string,
              unknown
            >)
          : null,
      });
      continue;
    }

    docs.push({ path, data: null });
  }

  return docs;
}

export async function executeSingleSyncRpc(
  shopId: string,
  descriptor: NormalizedSyncRpcDescriptor,
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<Record<string, unknown>> {
  let response: { data: unknown; error: unknown };

  switch (descriptor.rpc) {
    case 'record_sale':
      response = await client.rpc('record_sale', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_sale_id: descriptor.sale_id,
        p_lines: descriptor.lines,
        p_payment_type: descriptor.payment_type,
        p_receipt_number: descriptor.receipt_number,
        p_momo_operator: descriptor.momo_operator,
        p_customer_id: descriptor.customer_id,
        p_customer_name: descriptor.customer_name,
        p_customer_phone: descriptor.customer_phone,
        p_payment_reference: descriptor.payment_reference,
        p_note: descriptor.note,
        p_local_date: descriptor.local_date,
        p_cash_tendered_ngwee: descriptor.cash_tendered_ngwee,
        p_change_given_ngwee: descriptor.change_given_ngwee,
        p_client_created_at: descriptor.client_created_at,
        p_is_offline_sync: descriptor.is_offline_sync,
        p_offline_window_seconds: descriptor.offline_window_seconds,
      });
      break;

    case 'undo_sale':
      response = await client.rpc('undo_sale', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_sale_id: descriptor.sale_id,
        p_movements: descriptor.movements,
        p_expected_checks: descriptor.expected_checks,
      });
      break;

    case 'record_repayment':
      response = await client.rpc('record_repayment', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_payment_id: descriptor.payment_id,
        p_customer_id: descriptor.customer_id,
        p_amount_ngwee: descriptor.amount_ngwee,
        p_payment_method: descriptor.payment_method,
        p_note: descriptor.note,
        p_local_date: descriptor.local_date,
        p_created_at: descriptor.created_at,
      });
      break;

    case 'apply_stock_count':
      response = await client.rpc('apply_stock_count', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_item_id: descriptor.item_id,
        p_mode: descriptor.mode,
        p_quantity: descriptor.quantity,
        p_observed_quantity: descriptor.observed_quantity,
        p_movement_id: descriptor.movement_id,
        p_movement_type: descriptor.movement_type,
        p_reason: descriptor.reason,
        p_metadata: descriptor.metadata,
      });
      break;

    case 'resolve_stock_conflict':
      response = await client.rpc('resolve_stock_conflict', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_conflict_id: descriptor.conflict_id,
      });
      break;

    case 'upsert_shop_item':
      response = await client.rpc('upsert_shop_item', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_item_id: descriptor.item_id,
        p_patch: descriptor.patch,
        p_initial_movement: descriptor.initial_movement,
      });
      break;

    case 'upsert_shop_customer':
      response = await client.rpc('upsert_shop_customer', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_customer_id: descriptor.customer_id,
        p_patch: descriptor.patch,
      });
      break;

    case 'upsert_shop_expense':
      response = await client.rpc('upsert_shop_expense', {
        p_shop_id: shopId,
        p_operation_id: descriptor.operation_id,
        p_expense_id: descriptor.expense_id,
        p_patch: descriptor.patch,
      });
      break;
  }

  if (response.error) {
    throw normalizeSupabaseError(response.error);
  }
  return (response.data as Record<string, unknown> | null) ?? {};
}

export interface BatchSyncItemOutcome {
  operation_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: Error;
}

/**
 * Executes a slice of up to `SYNC_BATCH_CHUNK_SIZE` operations sequentially in
 * a single `apply_sync_batch` database round-trip, stopping at the first failed
 * operation so dependent downstream operations in the client queue are NOT run
 * out of order.
 */
export async function executeSyncBatchChunk(
  shopId: string,
  actions: SyncOperation[],
  options?: {
    client?: ShopRpcQueryClient;
    isOfflineSync?: boolean;
  }
): Promise<BatchSyncItemOutcome[]> {
  const client = options?.client ?? getActiveShopWriteClient();
  if (actions.length === 0) return [];

  // Validate and translate sequentially; if item `k` is malformed locally, execute
  // items `0..k-1` first, then report item `k`'s validation failure.
  const descriptors: NormalizedSyncRpcDescriptor[] = [];
  let localFailure: { actionId: string; error: Error } | null = null;

  for (const action of actions) {
    try {
      descriptors.push(
        translateSyncActionToRpc(action, shopId, {
          isOfflineSync: options?.isOfflineSync ?? true,
        })
      );
    } catch (err) {
      localFailure = {
        actionId: action.id,
        error: err instanceof Error ? err : new Error(String(err)),
      };
      break;
    }
  }

  const outcomes: BatchSyncItemOutcome[] = [];

  if (descriptors.length === 1) {
    const single = descriptors[0];
    try {
      const result = await executeSingleSyncRpc(shopId, single, client);
      outcomes.push({ operation_id: single.operation_id, ok: true, result });
    } catch (err) {
      outcomes.push({
        operation_id: single.operation_id,
        ok: false,
        error: normalizeSupabaseError(err),
      });
      return outcomes;
    }
  } else if (descriptors.length > 1) {
    // IMPORTANT: Within a batch, stop server execution if any operation fails so
    // dependent later operations in the same chunk stay untouched until the head
    // is resolved! Wait: in `apply_sync_batch`, let's check if any operation fails:
    // if descriptors inside the chunk are independent or sequential, stopping on
    // first failure in FIFO order guarantees strict queue causality!
    // Wait: let's check! In `apply_sync_batch`, if op #2 fails, should op #3 run?
    // NO! Look at `ShopContext.test.tsx`: "Sync failed; this and later entries remain queued"!
    // So if we either stop on first error inside `apply_sync_batch` OR only batch
    // up to `SYNC_BATCH_CHUNK_SIZE` when `stop_on_error = true` in `apply_sync_batch`,
    // then strict FIFO causality is preserved 100% EVEN INSIDE A 50-OP BATCH!
    const { data, error } = await client.rpc('apply_sync_batch', {
      p_shop_id: shopId,
      p_operations: descriptors,
    });
    if (error) {
      throw normalizeSupabaseError(error);
    }
    const rawResults = (data as { results?: Array<Record<string, unknown>> } | null)?.results ?? [];
    for (const item of rawResults) {
      const opId = String(item.operation_id ?? '');
      if (item.ok === true) {
        outcomes.push({
          operation_id: opId,
          ok: true,
          result: (item.result as Record<string, unknown> | undefined) ?? {},
        });
      } else {
        outcomes.push({
          operation_id: opId,
          ok: false,
          error: normalizeSupabaseError({
            code: item.error_code,
            detail: item.error_detail,
            message: item.error_message,
          }),
        });
        return outcomes;
      }
    }
  }

  if (localFailure) {
    outcomes.push({
      operation_id: localFailure.actionId,
      ok: false,
      error: localFailure.error,
    });
  }

  return outcomes;
}

export async function loadShopSyncReviewFromServer(
  params: {
    shopId: string;
    actionId: string;
    description: ReviewableSyncAction;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<SyncConflictReview> {
  const { shopId, actionId, description } = params;
  const customerId = description.customerPath.split('/').at(-1) ?? '';

  const [markerRes, customerRes, targetRes] = await Promise.all([
    client
      .from('sync_operations')
      .select('*')
      .eq('shop_id', shopId)
      .eq('operation_id', actionId)
      .maybeSingle(),
    client.from('customers').select('*').eq('shop_id', shopId).eq('id', customerId).maybeSingle(),
    description.kind === 'payment'
      ? client
          .from('credit_payments')
          .select('*')
          .eq('shop_id', shopId)
          .eq('id', description.paymentPath.split('/').at(-1) ?? '')
          .maybeSingle()
      : client
          .from('sales')
          .select('*')
          .eq('shop_id', shopId)
          .eq('id', description.saleId)
          .maybeSingle(),
  ]);

  if (markerRes.error) throw normalizeSupabaseError(markerRes.error);
  if (customerRes.error) throw normalizeSupabaseError(customerRes.error);
  if (targetRes.error) throw normalizeSupabaseError(targetRes.error);

  const markerRow = markerRes.data as SyncOperationRow | null;
  const customerRow = customerRes.data as CustomerRow | null;
  const serverBalanceNgwee = customerRow ? Number(customerRow.total_owed_ngwee) : 0;
  if (customerRow && serverBalanceNgwee < 0) {
    throw new Error('The server has an invalid customer balance. Keep this browser’s data.');
  }
  const serverBalance = fromNgwee(serverBalanceNgwee);
  const customerName = customerRow?.name
    ? customerRow.name
    : description.kind === 'payment'
      ? description.payment.customerName
      : 'Customer';

  const saleRow = description.kind === 'void' ? (targetRes.data as SaleRow | null) : null;
  const paymentRow =
    description.kind === 'payment' ? (targetRes.data as CreditPaymentRow | null) : null;

  const alreadyProcessed = Boolean(markerRow) || Boolean(saleRow?.is_deleted);
  if (!alreadyProcessed) {
    if (!customerRow) {
      throw new Error('The customer no longer exists on the server. Keep this browser’s data.');
    }
    if (description.kind === 'payment' && paymentRow) {
      throw new Error(
        'A payment with this ID already exists without a sync marker. Keep this browser’s data.'
      );
    }
    if (
      description.kind === 'void' &&
      (!saleRow ||
        saleRow.payment_type !== 'credit' ||
        `shops/${shopId}/customers/${saleRow.customer_id}` !== description.customerPath ||
        Number(saleRow.total_amount_ngwee) !== description.amountNgwee)
    ) {
      throw new Error('The sale or its customer changed on the server. Keep this browser’s data.');
    }
  }

  return {
    actionId,
    kind: description.kind,
    customerName,
    originalAmount: description.amountNgwee / 100,
    serverBalance,
    queuedAt: new Date(description.action.timestamp).toISOString(),
    ...(saleRow ? { receipt: saleRow.receipt_number || saleRow.id } : {}),
    alreadyProcessed,
    canRetry: !alreadyProcessed && serverBalanceNgwee >= description.amountNgwee,
  };
}

export async function resolveShopSyncReviewOnServer(
  params: {
    shopId: string;
    userUid: string;
    review: SyncConflictReview;
    decision: SyncReviewDecision;
    description: ReviewableSyncAction;
    expectedBalanceNgwee: number;
    correctedNgwee: number;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<'resolved' | 'already-processed'> {
  const { shopId, userUid, review, decision, description, expectedBalanceNgwee, correctedNgwee } =
    params;
  const customerId = description.customerPath.split('/').at(-1) ?? '';
  const resolvedAt = new Date().toISOString();

  const audit: SyncResolutionAudit = {
    kind: decision.kind,
    actionId: review.actionId,
    resolvedAt,
    resolvedBy: userUid,
    customerName: review.customerName,
    customerId,
    originalAmount: description.amountNgwee / 100,
    serverBalanceBefore: expectedBalanceNgwee / 100,
    queuedAt: new Date(description.action.timestamp).toISOString(),
    ...(description.kind === 'payment'
      ? { originalPayment: description.payment }
      : {
          saleId: description.saleId,
          receipt: review.receipt ?? description.saleId,
          stockRestorations: description.stockAdjustments.map((entry) => ({
            itemId: entry.movement.data.itemId,
            itemName: entry.movement.data.itemName,
            quantity: entry.delta,
          })),
        }),
    ...(decision.kind === 'correct-payment' ? { correctedAmount: correctedNgwee / 100 } : {}),
  };

  const contextPayload: Record<string, unknown> = {
    kind: description.kind,
    customer_id: customerId,
    expected_balance_ngwee: expectedBalanceNgwee,
    original_amount_ngwee: description.amountNgwee,
    ...(description.kind === 'payment'
      ? {
          payment_id: description.paymentPath.split('/').at(-1) ?? description.payment.id,
          payment_method: description.payment.paymentMethod ?? 'cash',
          note: description.payment.note ?? '',
          local_date: description.payment.localDate ?? null,
          created_at: description.payment.createdAt ?? null,
          corrected_amount_ngwee: correctedNgwee,
        }
      : {
          sale_id: description.saleId,
        }),
  };

  const { data, error } = await client.rpc('resolve_sync_conflict', {
    p_shop_id: shopId,
    p_operation_id: review.actionId,
    p_decision: decision.kind,
    p_resolution: audit,
    p_context: contextPayload,
  });

  if (error) {
    throw normalizeSupabaseError(error);
  }

  const status = (data as { status?: string } | null)?.status;
  return status === 'already-processed' ? 'already-processed' : 'resolved';
}

export function isPermanentPoisonSyncError(error: unknown): boolean {
  if (error instanceof CreditBalanceConflict) return false;
  if (isTransientSupabaseSyncError(error)) return false;

  if (typeof error === 'object' && error !== null) {
    const rec = error as { code?: unknown; detail?: unknown; details?: unknown; message?: unknown };
    const code = String(rec.code ?? '');
    const detail = String(rec.detail ?? rec.details ?? '');
    const message = String(rec.message ?? '');

    // Auth / session / subscription blocks are recoverable once unlocked or renewed
    if (
      code === '42501' ||
      [
        'SHOP_SUSPENDED',
        'PLAN_EXPIRED',
        'SHOP_SESSION_NOT_VERIFIED',
        'SHOP_OWNER_MISMATCH',
        'PERMISSION_DENIED',
      ].some((tag) => detail.includes(tag)) ||
      /suspended|expired|sign in|verified shop session|permission denied/i.test(message)
    ) {
      return false;
    }

    if (
      ['P0002', '22023', '23514', '23503', '23505'].includes(code) ||
      [
        'SALE_NOT_FOUND',
        'ITEM_NOT_FOUND',
        'CUSTOMER_NOT_FOUND',
        'UNDO_SALE_CHANGED',
        'UNDO_SALE_ITEMS_CHANGED',
        'INVALID_',
      ].some((tag) => detail.includes(tag)) ||
      /no longer exists|needs manual review|invalid/i.test(message)
    ) {
      return true;
    }
  }
  if (
    error instanceof Error &&
    /waiting entry is incomplete or inconsistent|cannot be synced/i.test(error.message)
  ) {
    return true;
  }
  return false;
}

export async function discardPoisonSyncActionOnServer(
  params: {
    shopId: string;
    userUid: string;
    action: PendingSyncAction;
    reason: string;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<'resolved' | 'already-processed'> {
  const { shopId, userUid, action, reason } = params;
  const resolvedAt = new Date().toISOString();
  const summary = describeQueuedActionSummary(action);

  const audit: SyncResolutionAudit = {
    kind: 'discard-poison',
    actionId: action.id,
    resolvedAt,
    resolvedBy: userUid,
    customerName: summary,
    customerId: '',
    originalAmount: 0,
    serverBalanceBefore: 0,
    poisonActionType: action.type,
    poisonSummary: summary,
    poisonReason: reason,
    queuedAt: new Date(action.timestamp).toISOString(),
  };

  const { data, error } = await client.rpc('resolve_sync_conflict', {
    p_shop_id: shopId,
    p_operation_id: action.id,
    p_decision: 'discard-poison',
    p_resolution: audit,
    p_context: null,
  });

  if (error) {
    throw normalizeSupabaseError(error);
  }
  const status = (data as { status?: string } | null)?.status;
  return status === 'already-processed' ? 'already-processed' : 'resolved';
}

export interface ServerBackupRestoreResponse {
  status: 'preview' | 'imported' | 'duplicate';
  dryRun: boolean;
  idempotent: boolean;
  alreadyImported: boolean;
  shopHasExistingData: boolean;
  fileSha256: string;
  preview: ShopBackupPreview;
  reconciliation?: LedgerReconciliationReport;
}

function mapServerBackupPreview(raw: Record<string, unknown>): ShopBackupPreview {
  return {
    format: raw.format === 'countup-backup-v2' ? 'countup-backup-v2' : 'shopbook-backup-v1',
    sourceShopName: String(raw.source_shop_name ?? ''),
    itemsCount: Number(raw.items_count ?? 0),
    activeItemsCount: Number(raw.active_items_count ?? 0),
    archivedItemsCount: Number(raw.archived_items_count ?? 0),
    salesCount: Number(raw.sales_count ?? 0),
    customersCount: Number(raw.customers_count ?? 0),
    expensesCount: Number(raw.expenses_count ?? 0),
    creditPaymentsCount: Number(raw.credit_payments_count ?? 0),
    stockMovementsCount: Number(raw.stock_movements_count ?? 0),
    totalRecordsCount: Number(raw.total_records_count ?? 0),
    totalStockValueNgwee: Number(raw.total_stock_value_ngwee ?? 0),
    totalOwedNgwee: Number(raw.total_owed_ngwee ?? 0),
  };
}

function mapServerBackupResponse(data: Record<string, unknown>): ServerBackupRestoreResponse {
  const previewObj = (data.preview as Record<string, unknown> | undefined) ?? {};
  return {
    status: (data.status as 'preview' | 'imported' | 'duplicate') ?? 'preview',
    dryRun: Boolean(data.dry_run),
    idempotent: Boolean(data.idempotent),
    alreadyImported: Boolean(data.already_imported),
    shopHasExistingData: Boolean(data.shop_has_existing_data),
    fileSha256: String(data.file_sha256 ?? ''),
    preview: mapServerBackupPreview(previewObj),
    ...(data.reconciliation
      ? { reconciliation: data.reconciliation as LedgerReconciliationReport }
      : {}),
  };
}

export async function previewShopBackupOnServer(
  params: {
    shopId: string;
    operationId: string;
    fileSha256: string;
    backupJson: Record<string, unknown>;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<ServerBackupRestoreResponse> {
  const { data, error } = await client.rpc('import_shop_backup', {
    p_shop_id: params.shopId,
    p_operation_id: params.operationId,
    p_file_sha256: params.fileSha256,
    p_backup: params.backupJson,
    p_dry_run: true,
    p_allow_non_empty_shop: false,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  return mapServerBackupResponse((data ?? {}) as Record<string, unknown>);
}

export async function importShopBackupOnServer(
  params: {
    shopId: string;
    operationId: string;
    fileSha256: string;
    backupJson: Record<string, unknown>;
    allowNonEmptyShop?: boolean;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<ServerBackupRestoreResponse> {
  const { data, error } = await client.rpc('import_shop_backup', {
    p_shop_id: params.shopId,
    p_operation_id: params.operationId,
    p_file_sha256: params.fileSha256,
    p_backup: params.backupJson,
    p_dry_run: false,
    p_allow_non_empty_shop: Boolean(params.allowNonEmptyShop),
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  return mapServerBackupResponse((data ?? {}) as Record<string, unknown>);
}

export async function loadShopSyncResolutionHistoryFromServer(
  shopId: string,
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<SyncResolutionAudit[]> {
  const { data, error } = await client
    .from('sync_operations')
    .select('has_resolution, resolution, applied_at')
    .eq('shop_id', shopId)
    .eq('has_resolution', true)
    .order('applied_at', { ascending: false });

  if (error) {
    throw normalizeSupabaseError(error);
  }

  return ((data ?? []) as Array<Pick<SyncOperationRow, 'has_resolution' | 'resolution'>>)
    .filter((row) => row.has_resolution === true && row.resolution)
    .map((row) => row.resolution as unknown as SyncResolutionAudit)
    .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
}

export async function reconcileShopLedger(
  shopId: string | null = null,
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<LedgerReconciliationReport> {
  const { data, error } = await client.rpc('reconcile_shop_ledger', {
    p_shop_id: shopId,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  return data as LedgerReconciliationReport;
}
