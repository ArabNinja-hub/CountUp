import {
  CreditPaymentRow,
  CustomerRow,
  ExpenseRow,
  ItemRow,
  SaleLineRow,
  SaleRow,
  StockConflictRow,
  StockMovementRow,
  SubscriptionPaymentRow,
} from './database.types';
import { ShopSyncCursors } from './cursorSync';
import {
  creditPaymentRowToDomain,
  customerRowToDomain,
  domainCreditPaymentToRow,
  domainCustomerToRow,
  domainExpenseToRow,
  domainItemToRow,
  domainSaleToRows,
  domainStockConflictToRow,
  domainStockMovementToRow,
  expenseRowToDomain,
  itemRowToDomain,
  saleRowsToDomain,
  stockConflictRowToDomain,
  stockMovementRowToDomain,
  subscriptionPaymentRowToDomain,
} from './mappers';
import {
  CreditPayment,
  Customer,
  Expense,
  Item,
  Sale,
  Shop,
  StockConflict,
  StockMovement,
  SubscriptionPayment,
} from '../types';

export const OFFLINE_CACHE_SCHEMA_VERSION = 'countup-cache-v2-ngwee' as const;
const KEY_PREFIX = 'countup:v2:ngwee';

/**
 * Legacy v1 unversioned localStorage keys stored Kwacha floats (`sellingPrice: 55.5`).
 * The v2 cache NEVER reads money-bearing records from these keys and actively
 * purges them so Kwacha floats and integer ngwee can never mix.
 */
export const LEGACY_V1_KWACHA_CACHE_KEYS = [
  'countup_items',
  'countup_archived_items',
  'countup_sales',
  'countup_customers',
  'countup_payments',
  'countup_expenses',
  'countup_stock_movements',
  'countup_stock_conflicts',
] as const;

export type ShopCacheCollection =
  | 'items'
  | 'sales'
  | 'customers'
  | 'credit_payments'
  | 'expenses'
  | 'stock_movements'
  | 'stock_conflicts'
  | 'subscription_payments'
  | 'cursors';

export function activeShopCacheKey(): string {
  return `${KEY_PREFIX}:active_shop`;
}

export function shopCollectionCacheKey(shopId: string, collection: ShopCacheCollection): string {
  return `${KEY_PREFIX}:${shopId}:${collection}`;
}

interface VersionedEnvelope<TPayload> {
  schema: typeof OFFLINE_CACHE_SCHEMA_VERSION;
  shopId: string;
  payload: TPayload;
}

export interface ShopNgweeRowCache {
  items: ItemRow[];
  sales: SaleRow[];
  saleLines: SaleLineRow[];
  customers: CustomerRow[];
  creditPayments: CreditPaymentRow[];
  expenses: ExpenseRow[];
  stockMovements: StockMovementRow[];
  stockConflicts: StockConflictRow[];
  subscriptionPayments: SubscriptionPaymentRow[];
  cursors: ShopSyncCursors;
}

export interface ShopDomainCacheSnapshot {
  items: Item[];
  archivedItems: Item[];
  sales: (Sale & { isDeleted?: boolean })[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  expenses: (Expense & { isDeleted?: boolean })[];
  stockMovements: StockMovement[];
  stockConflicts: StockConflict[];
  subscriptionPayments: SubscriptionPayment[];
  cursors: ShopSyncCursors;
}

function readEnvelope<TPayload>(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  expectedShopId: string
): TPayload | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VersionedEnvelope<TPayload>>;
    if (
      parsed.schema !== OFFLINE_CACHE_SCHEMA_VERSION ||
      parsed.shopId !== expectedShopId ||
      parsed.payload === undefined
    ) {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

function writeEnvelope<TPayload>(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  shopId: string,
  payload: TPayload
): void {
  const envelope: VersionedEnvelope<TPayload> = {
    schema: OFFLINE_CACHE_SCHEMA_VERSION,
    shopId,
    payload,
  };
  storage.setItem(key, JSON.stringify(envelope));
}

export function purgeLegacyKwachaCacheKeys(
  storage: Pick<Storage, 'removeItem'> = localStorage
): void {
  for (const legacyKey of LEGACY_V1_KWACHA_CACHE_KEYS) {
    storage.removeItem(legacyKey);
  }
}

function stripLegacyShopSecretFields(raw: Shop | null): Shop | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const copy = { ...(raw as Shop & { pin?: unknown }) };
  delete copy.pin;
  return copy;
}

export function readVersionedActiveShop(
  storage: Pick<Storage, 'getItem'> = localStorage
): Shop | null {
  const rawV2 = storage.getItem(activeShopCacheKey());
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as {
        schema?: string;
        shop?: Shop | null;
      };
      if (parsed.schema === OFFLINE_CACHE_SCHEMA_VERSION && parsed.shop) {
        return stripLegacyShopSecretFields(parsed.shop);
      }
    } catch {
      // Fall through
    }
  }

  // Shop profile metadata contains no Kwacha/ngwee prices; support seamless
  // reading of `countup_active_shop` while stripping any legacy plain-text PIN.
  const rawLegacyShop = storage.getItem('countup_active_shop');
  if (!rawLegacyShop) return null;
  try {
    return stripLegacyShopSecretFields(JSON.parse(rawLegacyShop) as Shop);
  } catch {
    return null;
  }
}

export function writeVersionedActiveShop(
  shop: Shop | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  const clean = stripLegacyShopSecretFields(shop);
  if (!clean) {
    storage.removeItem(activeShopCacheKey());
    storage.removeItem('countup_active_shop');
    return;
  }
  storage.setItem(
    activeShopCacheKey(),
    JSON.stringify({
      schema: OFFLINE_CACHE_SCHEMA_VERSION,
      shop: clean,
    })
  );
  storage.setItem('countup_active_shop', JSON.stringify(clean));
}

export function readShopNgweeRowCache(
  shopId: string,
  storage: Pick<Storage, 'getItem'> = localStorage
): ShopNgweeRowCache {
  if (!shopId) {
    return {
      items: [],
      sales: [],
      saleLines: [],
      customers: [],
      creditPayments: [],
      expenses: [],
      stockMovements: [],
      stockConflicts: [],
      subscriptionPayments: [],
      cursors: {},
    };
  }

  const salesBundle = readEnvelope<{ sales: SaleRow[]; lines: SaleLineRow[] }>(
    storage,
    shopCollectionCacheKey(shopId, 'sales'),
    shopId
  );

  return {
    items: readEnvelope<ItemRow[]>(storage, shopCollectionCacheKey(shopId, 'items'), shopId) ?? [],
    sales: salesBundle?.sales ?? [],
    saleLines: salesBundle?.lines ?? [],
    customers:
      readEnvelope<CustomerRow[]>(storage, shopCollectionCacheKey(shopId, 'customers'), shopId) ??
      [],
    creditPayments:
      readEnvelope<CreditPaymentRow[]>(
        storage,
        shopCollectionCacheKey(shopId, 'credit_payments'),
        shopId
      ) ?? [],
    expenses:
      readEnvelope<ExpenseRow[]>(storage, shopCollectionCacheKey(shopId, 'expenses'), shopId) ?? [],
    stockMovements:
      readEnvelope<StockMovementRow[]>(
        storage,
        shopCollectionCacheKey(shopId, 'stock_movements'),
        shopId
      ) ?? [],
    stockConflicts:
      readEnvelope<StockConflictRow[]>(
        storage,
        shopCollectionCacheKey(shopId, 'stock_conflicts'),
        shopId
      ) ?? [],
    subscriptionPayments:
      readEnvelope<SubscriptionPaymentRow[]>(
        storage,
        shopCollectionCacheKey(shopId, 'subscription_payments'),
        shopId
      ) ?? [],
    cursors:
      readEnvelope<ShopSyncCursors>(storage, shopCollectionCacheKey(shopId, 'cursors'), shopId) ??
      {},
  };
}

export function writeShopNgweeRowCache(
  shopId: string,
  cache: ShopNgweeRowCache,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  if (!shopId) return;
  purgeLegacyKwachaCacheKeys(storage);
  writeEnvelope(storage, shopCollectionCacheKey(shopId, 'items'), shopId, cache.items);
  writeEnvelope(storage, shopCollectionCacheKey(shopId, 'sales'), shopId, {
    sales: cache.sales,
    lines: cache.saleLines,
  });
  writeEnvelope(storage, shopCollectionCacheKey(shopId, 'customers'), shopId, cache.customers);
  writeEnvelope(
    storage,
    shopCollectionCacheKey(shopId, 'credit_payments'),
    shopId,
    cache.creditPayments
  );
  writeEnvelope(storage, shopCollectionCacheKey(shopId, 'expenses'), shopId, cache.expenses);
  writeEnvelope(
    storage,
    shopCollectionCacheKey(shopId, 'stock_movements'),
    shopId,
    cache.stockMovements
  );
  writeEnvelope(
    storage,
    shopCollectionCacheKey(shopId, 'stock_conflicts'),
    shopId,
    cache.stockConflicts
  );
  writeEnvelope(
    storage,
    shopCollectionCacheKey(shopId, 'subscription_payments'),
    shopId,
    cache.subscriptionPayments
  );
  writeEnvelope(storage, shopCollectionCacheKey(shopId, 'cursors'), shopId, cache.cursors);
}

/**
 * Projects integer-ngwee rows from the v2 cache into UI domain records.
 * Rejects any record whose `*_ngwee` field is not a safe integer (never mixes
 * floating-point Kwacha with ngwee).
 */
export function projectNgweeRowCacheToDomain(cache: ShopNgweeRowCache): ShopDomainCacheSnapshot {
  const safeMap = <TRow, TOut>(rows: readonly TRow[], fn: (row: TRow) => TOut): TOut[] => {
    const out: TOut[] = [];
    for (const row of rows) {
      try {
        out.push(fn(row));
      } catch (err) {
        console.warn('Skipping malformed cached row:', err);
      }
    }
    return out;
  };

  const linesBySaleId = new Map<string, SaleLineRow[]>();
  for (const line of cache.saleLines) {
    const bucket = linesBySaleId.get(line.sale_id);
    if (bucket) {
      bucket.push(line);
    } else {
      linesBySaleId.set(line.sale_id, [line]);
    }
  }

  const allItems = safeMap(cache.items, itemRowToDomain);
  const allSales = safeMap(cache.sales, (saleRow) =>
    saleRowsToDomain(saleRow, linesBySaleId.get(saleRow.id) ?? [])
  );
  allSales.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const movements = safeMap(cache.stockMovements, stockMovementRowToDomain);
  movements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    items: allItems.filter((item) => !item.isDeleted),
    archivedItems: allItems.filter((item) => Boolean(item.isDeleted)),
    sales: allSales,
    customers: safeMap(cache.customers, customerRowToDomain),
    creditPayments: safeMap(cache.creditPayments, creditPaymentRowToDomain),
    expenses: safeMap(cache.expenses, expenseRowToDomain),
    stockMovements: movements,
    stockConflicts: safeMap(cache.stockConflicts, stockConflictRowToDomain),
    subscriptionPayments: safeMap(cache.subscriptionPayments, subscriptionPaymentRowToDomain),
    cursors: { ...cache.cursors },
  };
}

export function readShopDomainCache(
  shopId: string,
  storage: Pick<Storage, 'getItem'> = localStorage
): ShopDomainCacheSnapshot {
  return projectNgweeRowCacheToDomain(readShopNgweeRowCache(shopId, storage));
}

export function writeVersionedDomainCollection(
  shopId: string,
  collection:
    | 'items'
    | 'sales'
    | 'customers'
    | 'credit_payments'
    | 'expenses'
    | 'stock_movements'
    | 'stock_conflicts',
  records: unknown[],
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  if (!shopId) return;
  purgeLegacyKwachaCacheKeys(storage);

  switch (collection) {
    case 'items': {
      const rows = (records as Item[]).map(domainItemToRow);
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'items'), shopId, rows);
      return;
    }
    case 'sales': {
      const sales: SaleRow[] = [];
      const lines: SaleLineRow[] = [];
      for (const s of records as (Sale & { isDeleted?: boolean; updatedAt?: string })[]) {
        const mapped = domainSaleToRows(s);
        sales.push(mapped.sale);
        lines.push(...mapped.lines);
      }
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'sales'), shopId, { sales, lines });
      return;
    }
    case 'customers': {
      const rows = (records as Customer[]).map(domainCustomerToRow);
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'customers'), shopId, rows);
      return;
    }
    case 'credit_payments': {
      const rows = (records as CreditPayment[]).map(domainCreditPaymentToRow);
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'credit_payments'), shopId, rows);
      return;
    }
    case 'expenses': {
      const rows = (records as (Expense & { isDeleted?: boolean })[]).map(domainExpenseToRow);
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'expenses'), shopId, rows);
      return;
    }
    case 'stock_movements': {
      const rows = (records as StockMovement[]).map(domainStockMovementToRow);
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'stock_movements'), shopId, rows);
      return;
    }
    case 'stock_conflicts': {
      const rows = (records as StockConflict[]).map((c) => domainStockConflictToRow(c, shopId));
      writeEnvelope(storage, shopCollectionCacheKey(shopId, 'stock_conflicts'), shopId, rows);
      return;
    }
  }
}

export function clearVersionedShopCache(
  shopId: string | null | undefined,
  storage: Pick<Storage, 'removeItem'> = localStorage
): void {
  storage.removeItem(activeShopCacheKey());
  storage.removeItem('countup_active_shop');
  purgeLegacyKwachaCacheKeys(storage);
  if (!shopId) return;

  const collections: ShopCacheCollection[] = [
    'items',
    'sales',
    'customers',
    'credit_payments',
    'expenses',
    'stock_movements',
    'stock_conflicts',
    'subscription_payments',
    'cursors',
  ];
  for (const col of collections) {
    storage.removeItem(shopCollectionCacheKey(shopId, col));
  }
}
