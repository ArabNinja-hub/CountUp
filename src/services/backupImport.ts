import { z } from 'zod';
import { CreditPayment, Customer, Expense, Item, Sale, StockMovement } from '../types';
import { fromNgwee } from '../utils/money';

export const MAX_BACKUP_FILE_BYTES = 5_000_000; // 5 MB
/**
 * Cap on primary ledger entities (`items + sales + customers + expenses + creditPayments`),
 * sized to comfortably restore 2+ years of normal daily sales (~15,000–30,000 sales).
 */
export const MAX_BACKUP_PRIMARY_RECORDS = 50_000;
/**
 * Cap on total expanded database rows, which EXPLICITLY includes `sale_lines` and
 * `stock_movements` (including synthesized `:opening` movements):
 * `items + sales + sale_lines + customers + expenses + creditPayments + stockMovements`.
 */
export const MAX_BACKUP_TOTAL_RECORDS = 200_000;
export const BACKUP_CHUNK_MAX_ROWS = 500;
export const MAX_NGWEE_AMOUNT = 10_000_000_000; // K100,000,000.00

export type SupportedBackupFormat = 'shopbook-backup-v1' | 'countup-backup-v2';

export type BackupChunkSection =
  | 'items'
  | 'archivedItems'
  | 'customers'
  | 'sales'
  | 'creditPayments'
  | 'expenses'
  | 'stockMovements';

export interface StagedBackupChunkDescriptor {
  chunkIndex: number;
  section: BackupChunkSection;
  records: Array<Record<string, unknown>>;
}

export interface ShopBackupPreview {
  format: SupportedBackupFormat;
  sourceShopName: string;
  itemsCount: number;
  activeItemsCount: number;
  archivedItemsCount: number;
  salesCount: number;
  saleLinesCount?: number;
  customersCount: number;
  expensesCount: number;
  creditPaymentsCount: number;
  stockMovementsCount: number;
  primaryRecordsCount?: number;
  totalRecordsCount: number;
  totalStockValueNgwee: number;
  totalOwedNgwee: number;
}

export interface LegacyBackupImport {
  sourceShopName: string;
  items: Item[];
  sales: Sale[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  stockMovements: StockMovement[];
}

export interface PreparedShopBackup extends LegacyBackupImport {
  format: SupportedBackupFormat;
  expenses: Expense[];
  preview: ShopBackupPreview;
  parsedJson: Record<string, unknown>;
}

/**
 * Scans raw JSON text before `JSON.parse` so numeric literals with > 2 decimal
 * places (even `12.500`) or scientific notation (`1e5`) are rejected instead of
 * being silently rounded or normalized by IEEE-754 float parsing.
 */
export function assertSafeRawJsonNumbers(raw: string): void {
  let inString = false;
  let escaped = false;
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let end = i + 1;
      while (end < len && /[0-9.eE+-]/.test(raw[end])) {
        end += 1;
      }
      const token = raw.slice(i, end);
      if (/[eE]/.test(token)) {
        throw new Error(
          `Invalid numeric value "${token.slice(0, 32)}": scientific notation is not allowed in backups.`
        );
      }
      const dotIdx = token.indexOf('.');
      if (dotIdx !== -1) {
        const decimals = token.slice(dotIdx + 1);
        if (decimals.length > 2) {
          throw new Error(
            `Invalid monetary precision "${token.slice(0, 32)}": at most 2 decimal places are allowed.`
          );
        }
      }
      i = end;
      continue;
    }

    i += 1;
  }
}

/**
 * Converts a Kwacha decimal (`number` or `string`, e.g. `12.5` or `"12.50"`) to
 * exact integer ngwee using pure string + BigInt decimal handling (NEVER
 * floating-point multiplication). Rejects > 2 decimal places, negatives,
 * non-numeric values, and absurd numbers (`> K100,000,000.00`).
 */
export function parseStrictKwachaDecimalToNgwee(
  value: unknown,
  fieldLabel: string,
  options: { allowZero?: boolean } = {}
): number {
  const allowZero = options.allowZero !== false;

  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid monetary value for ${fieldLabel}.`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new Error(`Invalid monetary value for ${fieldLabel}: expected a Kwacha amount.`);
  }

  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) {
    if (/^[0-9]+\.[0-9]{3,}$/.test(text)) {
      throw new Error(
        `Invalid monetary precision for ${fieldLabel} ("${text}"): at most 2 decimal places are allowed.`
      );
    }
    throw new Error(`Invalid monetary value for ${fieldLabel} ("${text.slice(0, 40)}").`);
  }

  const [wholePart, fracPart = ''] = text.split('.');
  const fracPadded = fracPart.padEnd(2, '0');
  const ngweeBig = BigInt(wholePart) * 100n + BigInt(fracPadded);

  if (ngweeBig > BigInt(MAX_NGWEE_AMOUNT)) {
    throw new Error(
      `Monetary value for ${fieldLabel} exceeds the maximum allowed limit (K100,000,000.00).`
    );
  }
  const ngwee = Number(ngweeBig);
  if (!allowZero && ngwee <= 0) {
    throw new Error(`Monetary value for ${fieldLabel} must be greater than zero.`);
  }
  return ngwee;
}

export async function computeBackupSha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// Legacy `shopbook-backup-v1` validation & conversion
// =============================================================================
const v1Id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const v2Id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_:-]+$/);
const text = z.string().max(500);
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'Invalid timestamp');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const integer = z.number().int().min(0).max(1_000_000);
const money = z.number().int().min(0).max(MAX_NGWEE_AMOUNT);
const optionalText = text.nullable().optional();
const demo = z.boolean().optional();

const productSchema = z.object({
  id: v1Id,
  name: text.min(1).max(200),
  unitLabel: z.string().max(60).optional(),
  sellingPriceNgwee: money.positive(),
  costPriceNgwee: money.nullable().optional(),
  stockQty: integer,
  lowStockThreshold: integer,
  isArchived: z.boolean(),
  isDemo: demo,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const customerSchema = z.object({
  id: v1Id,
  name: text.min(1).max(200),
  phone: z.string().max(40).optional(),
  notes: text.optional(),
  isDemo: demo,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const saleSchema = z.object({
  id: v1Id,
  operationId: text.min(1),
  receiptNumber: z.string().min(1).max(120),
  paymentMethod: z.enum(['cash', 'mobile_money', 'credit']),
  paymentReference: optionalText,
  customerId: v1Id.nullable().optional(),
  customerNameSnapshot: optionalText,
  totalNgwee: money.positive(),
  totalUnits: integer.positive(),
  knownCostTotalNgwee: money,
  knownCostRevenueNgwee: money,
  missingCostLineCount: integer,
  missingCostRevenueNgwee: money,
  note: text.optional(),
  isDemo: demo,
  createdAt: timestamp,
  localDate: date,
});
const saleItemSchema = z.object({
  id: v1Id,
  saleId: v1Id,
  productId: v1Id,
  productNameAtSale: text.min(1).max(200),
  unitLabelAtSale: z.string().max(60).optional(),
  sellingPriceAtSaleNgwee: money.positive(),
  costPriceAtSaleNgwee: money.nullable().optional(),
  quantity: integer.positive(),
  lineTotalNgwee: money.positive(),
  isDemo: demo,
  createdAt: timestamp,
});
const movementSchema = z.object({
  id: v1Id,
  operationId: text.min(1),
  productId: v1Id,
  productNameSnapshot: text.min(1).max(200),
  type: z.enum(['initial', 'sale', 'restock', 'adjustment', 'void']),
  deltaQty: z.number().int().min(-1_000_000).max(1_000_000),
  previousQty: integer,
  newQty: integer,
  reason: text,
  relatedSaleId: v1Id.nullable().optional(),
  isDemo: demo,
  createdAt: timestamp,
});
const creditSchema = z.object({
  id: v1Id,
  operationId: text.min(1),
  customerId: v1Id,
  customerNameSnapshot: text.min(1).max(200),
  type: z.enum(['credit_sale', 'repayment']),
  amountNgwee: money.positive(),
  paymentMethod: z.enum(['cash', 'mobile_money']).nullable(),
  relatedSaleId: v1Id.nullable().optional(),
  note: text.optional(),
  isDemo: demo,
  createdAt: timestamp,
  localDate: date,
});
const v1BackupSchema = z
  .object({
    format: z.literal('shopbook-backup-v1'),
    exportedAt: timestamp,
    shopSettings: z.object({ shopName: text }).passthrough(),
    products: z.array(productSchema).max(5000),
    customers: z.array(customerSchema).max(5000),
    sales: z.array(saleSchema).max(30000),
    saleItems: z.array(saleItemSchema).max(80000),
    stockMovements: z.array(movementSchema).max(80000),
    creditTransactions: z.array(creditSchema).max(40000),
  })
  .strict();

const mappedId = (sourceId: string) => `shopbook_${sourceId}`;

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Backup has duplicate ${label}.`);
}

function ensureOpeningStockMovements(items: Item[], movements: StockMovement[]): StockMovement[] {
  const result = [...movements];
  const byItem = new Map<string, StockMovement[]>();
  for (const mv of movements) {
    const list = byItem.get(mv.itemId) ?? [];
    list.push(mv);
    byItem.set(mv.itemId, list);
  }

  for (const item of items) {
    const existing = byItem.get(item.id) ?? [];
    const sum = existing.reduce((acc, m) => acc + m.delta, 0);
    const hasInitial = existing.some((m) => m.type === 'initial');
    if (sum !== item.quantity) {
      const openingDelta = item.quantity - sum;
      if (hasInitial || openingDelta < 0) {
        throw new Error(
          `Stock movement history for product "${item.name}" (${sum}) does not match its quantity (${item.quantity}).`
        );
      }
      result.push({
        id: `${item.id}:opening`.slice(0, 128),
        shopId: item.shopId,
        itemId: item.id,
        itemName: item.name,
        type: 'initial',
        delta: openingDelta,
        previousQuantity: 0,
        newQuantity: openingDelta,
        reason: 'Opening stock from backup restore',
        isDemo: Boolean(item.isDemo),
        createdAt: item.createdAt,
      });
    }
  }
  return result;
}

function buildPreview(params: {
  format: SupportedBackupFormat;
  sourceShopName: string;
  items: Item[];
  itemSellingNgweeById: Map<string, number>;
  sales: Sale[];
  saleLinesCount: number;
  customers: Customer[];
  customerOwedNgweeById: Map<string, number>;
  expenses: Expense[];
  creditPayments: CreditPayment[];
  stockMovements: StockMovement[];
}): ShopBackupPreview {
  const activeItems = params.items.filter((i) => !i.isDeleted);
  const archivedItems = params.items.filter((i) => i.isDeleted);
  let totalStockValueNgwee = 0;
  for (const item of activeItems) {
    const sellNgwee = params.itemSellingNgweeById.get(item.id) ?? 0;
    totalStockValueNgwee += item.quantity * sellNgwee;
  }
  let totalOwedNgwee = 0;
  for (const cust of params.customers) {
    totalOwedNgwee += params.customerOwedNgweeById.get(cust.id) ?? 0;
  }

  const primaryRecordsCount =
    params.items.length +
    params.sales.length +
    params.customers.length +
    params.expenses.length +
    params.creditPayments.length;

  const totalRecordsCount =
    primaryRecordsCount + params.saleLinesCount + params.stockMovements.length;

  if (
    primaryRecordsCount > MAX_BACKUP_PRIMARY_RECORDS ||
    totalRecordsCount > MAX_BACKUP_TOTAL_RECORDS
  ) {
    throw new Error(
      `Backup contains ${primaryRecordsCount} primary records (${totalRecordsCount} total rows including sale lines and stock movements), exceeding the ${MAX_BACKUP_PRIMARY_RECORDS}-primary / ${MAX_BACKUP_TOTAL_RECORDS}-total restore limit.`
    );
  }

  return {
    format: params.format,
    sourceShopName: params.sourceShopName,
    itemsCount: params.items.length,
    activeItemsCount: activeItems.length,
    archivedItemsCount: archivedItems.length,
    salesCount: params.sales.length,
    saleLinesCount: params.saleLinesCount,
    customersCount: params.customers.length,
    expensesCount: params.expenses.length,
    creditPaymentsCount: params.creditPayments.length,
    stockMovementsCount: params.stockMovements.length,
    primaryRecordsCount,
    totalRecordsCount,
    totalStockValueNgwee,
    totalOwedNgwee,
  };
}

function parseV1BackupObject(json: Record<string, unknown>, shopId: string): PreparedShopBackup {
  const parsed = v1BackupSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.code === 'unrecognized_keys') {
      throw new Error(`Backup contains an unknown top-level record type.`);
    }
    throw new Error(
      `Invalid backup at ${first?.path.join('.') || 'file'}: ${first?.message || 'check the file'}.`
    );
  }
  const data = parsed.data;
  for (const [label, records] of [
    ['product IDs', data.products],
    ['customer IDs', data.customers],
    ['sale IDs', data.sales],
    ['sale item IDs', data.saleItems],
    ['stock movement IDs', data.stockMovements],
    ['credit transaction IDs', data.creditTransactions],
  ] as const) {
    unique(
      records.map((r) => r.id),
      label
    );
  }
  unique(
    data.sales.map((s) => s.operationId),
    'sale operations'
  );
  unique(
    data.stockMovements.map((m) => m.operationId),
    'stock operations'
  );
  unique(
    data.creditTransactions.map((t) => t.operationId),
    'credit operations'
  );

  const products = new Map(data.products.map((p) => [p.id, p]));
  const customersById = new Map(data.customers.map((c) => [c.id, c]));
  const salesById = new Map(data.sales.map((s) => [s.id, s]));
  const linesBySale = new Map<string, typeof data.saleItems>();
  for (const line of data.saleItems) {
    if (!salesById.has(line.saleId) || !products.has(line.productId))
      throw new Error('Backup has a sale item referring to a missing sale or product.');
    if (line.sellingPriceAtSaleNgwee * line.quantity !== line.lineTotalNgwee)
      throw new Error('A sale item total does not match its price and quantity.');
    const lines = linesBySale.get(line.saleId) ?? [];
    lines.push(line);
    linesBySale.set(line.saleId, lines);
  }
  for (const sale of data.sales) {
    const lines = linesBySale.get(sale.id) ?? [];
    const sum = (f: (line: (typeof lines)[number]) => number) =>
      lines.reduce((total, line) => total + f(line), 0);
    if (
      !lines.length ||
      sum((l) => l.lineTotalNgwee) !== sale.totalNgwee ||
      sum((l) => l.quantity) !== sale.totalUnits ||
      sum((l) => (l.costPriceAtSaleNgwee == null ? 0 : l.costPriceAtSaleNgwee * l.quantity)) !==
        sale.knownCostTotalNgwee ||
      sum((l) => (l.costPriceAtSaleNgwee == null ? 0 : l.lineTotalNgwee)) !==
        sale.knownCostRevenueNgwee ||
      sum((l) => (l.costPriceAtSaleNgwee == null ? 1 : 0)) !== sale.missingCostLineCount ||
      sum((l) => (l.costPriceAtSaleNgwee == null ? l.lineTotalNgwee : 0)) !==
        sale.missingCostRevenueNgwee
    ) {
      throw new Error(
        `The totals or cost snapshots on receipt ${sale.receiptNumber} do not match its items.`
      );
    }
    if (
      sale.paymentMethod === 'credit' &&
      (!sale.customerId || !customersById.has(sale.customerId))
    )
      throw new Error(`Credit receipt ${sale.receiptNumber} has no valid customer.`);
  }
  for (const movement of data.stockMovements) {
    if (
      !products.has(movement.productId) ||
      (movement.relatedSaleId && !salesById.has(movement.relatedSaleId))
    )
      throw new Error('Backup has a stock movement referring to a missing product or sale.');
    if (Math.max(0, movement.previousQty + movement.deltaQty) !== movement.newQty)
      throw new Error('Backup has an inconsistent stock movement.');
  }
  const creditBySale = new Map<string, number>();
  const balance = new Map<string, number>();
  const orderedCredit = [...data.creditTransactions].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'credit_sale' ? -1 : 1)
  );
  for (const tx of orderedCredit) {
    if (!customersById.has(tx.customerId))
      throw new Error('A credit transaction refers to a missing customer.');
    if (tx.type === 'credit_sale') {
      const sale = tx.relatedSaleId ? salesById.get(tx.relatedSaleId) : undefined;
      if (
        !sale ||
        sale.paymentMethod !== 'credit' ||
        sale.customerId !== tx.customerId ||
        sale.totalNgwee !== tx.amountNgwee ||
        tx.paymentMethod !== null
      )
        throw new Error('A credit transaction does not match its sale.');
      creditBySale.set(sale.id, (creditBySale.get(sale.id) ?? 0) + 1);
    } else if (!tx.paymentMethod) throw new Error('A repayment is missing its payment method.');
    const next =
      (balance.get(tx.customerId) ?? 0) +
      (tx.type === 'credit_sale' ? tx.amountNgwee : -tx.amountNgwee);
    if (!Number.isSafeInteger(next) || next < 0)
      throw new Error('A customer has an inconsistent negative credit balance.');
    balance.set(tx.customerId, next);
  }
  for (const sale of data.sales) {
    if (sale.paymentMethod === 'credit' && creditBySale.get(sale.id) !== 1)
      throw new Error(`Credit receipt ${sale.receiptNumber} is missing its matching ledger entry.`);
  }

  const itemSellingNgweeById = new Map<string, number>();
  const items: Item[] = data.products.map((p) => {
    const id = mappedId(p.id);
    itemSellingNgweeById.set(id, p.sellingPriceNgwee);
    return {
      id,
      shopId,
      name: p.name,
      unitLabel: p.unitLabel || '',
      buyingPrice: fromNgwee(p.costPriceNgwee ?? 0),
      buyingPriceKnown: p.costPriceNgwee != null,
      sellingPrice: fromNgwee(p.sellingPriceNgwee),
      quantity: p.stockQty,
      lowStockThreshold: p.lowStockThreshold,
      isDeleted: p.isArchived,
      isDemo: Boolean(p.isDemo),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });

  const customerOwedNgweeById = new Map<string, number>();
  const customers: Customer[] = data.customers.map((c) => {
    const id = mappedId(c.id);
    const owed = balance.get(c.id) ?? 0;
    customerOwedNgweeById.set(id, owed);
    return {
      id,
      shopId,
      name: c.name,
      phone: c.phone || '',
      notes: c.notes || '',
      totalOwed: fromNgwee(owed),
      isDemo: Boolean(c.isDemo),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  const sales: Sale[] = data.sales.map((s) => ({
    id: mappedId(s.id),
    shopId,
    items: (linesBySale.get(s.id) ?? []).map((l) => ({
      itemId: mappedId(l.productId),
      name: l.productNameAtSale,
      unitLabel: l.unitLabelAtSale || '',
      quantity: l.quantity,
      buyingPrice: fromNgwee(l.costPriceAtSaleNgwee ?? 0),
      buyingPriceKnown: l.costPriceAtSaleNgwee != null,
      sellingPrice: fromNgwee(l.sellingPriceAtSaleNgwee),
    })),
    itemsCount: s.totalUnits,
    totalAmount: fromNgwee(s.totalNgwee),
    totalCost: fromNgwee(s.knownCostTotalNgwee),
    profit: fromNgwee(s.knownCostRevenueNgwee - s.knownCostTotalNgwee),
    missingCostRevenue: fromNgwee(s.missingCostRevenueNgwee),
    paymentType: s.paymentMethod === 'mobile_money' ? 'momo' : s.paymentMethod,
    ...(s.customerId ? { customerId: mappedId(s.customerId) } : {}),
    ...(s.customerNameSnapshot ? { customerName: s.customerNameSnapshot } : {}),
    ...(s.customerId && customersById.get(s.customerId)?.phone
      ? { customerPhone: customersById.get(s.customerId)!.phone }
      : {}),
    receiptNumber: s.receiptNumber,
    paymentReference: s.paymentReference || '',
    note: s.note || '',
    localDate: s.localDate,
    isDemo: Boolean(s.isDemo),
    createdAt: s.createdAt,
  }));

  const creditPayments: CreditPayment[] = data.creditTransactions
    .filter((tx) => tx.type === 'repayment')
    .map((tx) => ({
      id: mappedId(tx.id),
      shopId,
      customerId: mappedId(tx.customerId),
      customerName: tx.customerNameSnapshot,
      amount: fromNgwee(tx.amountNgwee),
      paymentMethod: tx.paymentMethod === 'mobile_money' ? 'momo' : 'cash',
      note: tx.note || '',
      localDate: tx.localDate,
      isDemo: Boolean(tx.isDemo),
      createdAt: tx.createdAt,
    }));

  const rawMovements: StockMovement[] = data.stockMovements.map((m) => ({
    id: mappedId(m.id),
    shopId,
    itemId: mappedId(m.productId),
    itemName: m.productNameSnapshot,
    type: m.type,
    delta: m.deltaQty,
    previousQuantity: m.previousQty,
    newQuantity: m.newQty,
    reason: m.reason,
    ...(m.relatedSaleId ? { relatedSaleId: mappedId(m.relatedSaleId) } : {}),
    isDemo: Boolean(m.isDemo),
    createdAt: m.createdAt,
  }));

  const stockMovements = ensureOpeningStockMovements(items, rawMovements);

  const preview = buildPreview({
    format: 'shopbook-backup-v1',
    sourceShopName: data.shopSettings.shopName,
    items,
    itemSellingNgweeById,
    sales,
    saleLinesCount: data.saleItems.length,
    customers,
    customerOwedNgweeById,
    expenses: [],
    creditPayments,
    stockMovements,
  });

  return {
    format: 'shopbook-backup-v1',
    sourceShopName: data.shopSettings.shopName,
    items,
    customers,
    sales,
    creditPayments,
    expenses: [],
    stockMovements,
    preview,
    parsedJson: json,
  };
}

// =============================================================================
// `countup-backup-v2` validation & conversion (Kwacha decimals -> integer ngwee)
// =============================================================================
const v2MoneyRaw = z.union([z.number(), z.string()]);

const v2ItemSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    name: z.string().min(1).max(200),
    unitLabel: z.string().max(60).optional(),
    buyingPrice: v2MoneyRaw.optional(),
    buyingPriceKnown: z.boolean().optional(),
    sellingPrice: v2MoneyRaw,
    quantity: integer,
    lowStockThreshold: integer.optional(),
    isDeleted: z.boolean().optional(),
    isDemo: demo,
    lastSoldAt: timestamp.nullable().optional(),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
  })
  .strict();

const v2CustomerSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    name: z.string().min(1).max(200),
    phone: z.string().max(40).optional(),
    notes: z.string().max(500).optional(),
    totalOwed: v2MoneyRaw,
    isDemo: demo,
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
  })
  .strict();

const v2SaleLineSchema = z
  .object({
    itemId: v2Id,
    name: z.string().min(1).max(200),
    unitLabel: z.string().max(60).optional(),
    quantity: integer.positive(),
    buyingPrice: v2MoneyRaw.optional(),
    buyingPriceKnown: z.boolean().optional(),
    sellingPrice: v2MoneyRaw,
    total: v2MoneyRaw.optional(),
  })
  .strict();

const v2SaleSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    items: z.array(v2SaleLineSchema).min(1).max(160),
    itemsCount: integer.positive(),
    totalAmount: v2MoneyRaw,
    totalCost: v2MoneyRaw.optional(),
    profit: v2MoneyRaw.optional(),
    missingCostRevenue: v2MoneyRaw.optional(),
    paymentType: z.enum(['cash', 'momo', 'credit']),
    momoOperator: z.enum(['airtel', 'mtn', 'zamtel']).nullable().optional(),
    customerId: v2Id.nullable().optional(),
    customerName: z.string().max(200).nullable().optional(),
    customerPhone: z.string().max(40).nullable().optional(),
    receiptNumber: z.string().max(120).optional(),
    paymentReference: z.string().max(120).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    localDate: date.nullable().optional(),
    cashTendered: v2MoneyRaw.nullable().optional(),
    changeGiven: v2MoneyRaw.nullable().optional(),
    isDeleted: z.boolean().optional(),
    isDemo: demo,
    isOfflineSync: z.boolean().optional(),
    offlineWindowFlagged: z.boolean().optional(),
    offlineFlagReason: z.string().max(500).nullable().optional(),
    clientCreatedAt: timestamp.nullable().optional(),
    createdAt: timestamp,
  })
  .strict();

const v2CreditPaymentSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    customerId: v2Id,
    customerName: z.string().min(1).max(200),
    amount: v2MoneyRaw,
    paymentMethod: z.enum(['cash', 'momo']),
    note: z.string().max(500).optional(),
    localDate: date.nullable().optional(),
    isDemo: demo,
    syncCorrection: z.record(z.string(), z.unknown()).nullable().optional(),
    createdAt: timestamp,
  })
  .strict();

const v2ExpenseSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    category: z.enum(['rent', 'transport', 'restock', 'council_fee', 'helper_wage', 'other']),
    amount: v2MoneyRaw,
    note: z.string().max(500).optional(),
    isDeleted: z.boolean().optional(),
    createdAt: timestamp,
  })
  .strict();

const v2MovementSchema = z
  .object({
    id: v2Id,
    shopId: z.string().optional(),
    itemId: v2Id,
    itemName: z.string().min(1).max(200),
    type: z.enum(['initial', 'sale', 'restock', 'adjustment', 'void']),
    delta: z.number().int().min(-1_000_000).max(1_000_000),
    previousQuantity: integer,
    newQuantity: integer,
    reason: z.string().max(500).optional(),
    relatedSaleId: v2Id.nullable().optional(),
    requestedQuantity: integer.nullable().optional(),
    recountNeeded: z.boolean().optional(),
    isDemo: demo,
    createdAt: timestamp,
  })
  .strict();

const v2BackupSchema = z
  .object({
    format: z.literal('countup-backup-v2'),
    version: z.string().max(20).optional(),
    exportedAt: timestamp.optional(),
    shop: z
      .object({
        name: z.string().max(120).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    subscription: z.record(z.string(), z.unknown()).nullable().optional(),
    items: z.array(v2ItemSchema).max(5000),
    archivedItems: z.array(v2ItemSchema).max(5000).optional(),
    sales: z.array(v2SaleSchema).max(30000),
    customers: z.array(v2CustomerSchema).max(5000),
    creditPayments: z.array(v2CreditPaymentSchema).max(25000).optional(),
    expenses: z.array(v2ExpenseSchema).max(15000).optional(),
    stockMovements: z.array(v2MovementSchema).max(80000).optional(),
    stockConflicts: z.array(z.record(z.string(), z.unknown())).max(10000).optional(),
  })
  .strict();

function parseSignedKwachaNgwee(value: unknown, fieldLabel: string): number {
  const str =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (str.startsWith('-')) {
    return -parseStrictKwachaDecimalToNgwee(str.slice(1), fieldLabel, { allowZero: true });
  }
  return parseStrictKwachaDecimalToNgwee(value, fieldLabel, { allowZero: true });
}

function parseV2BackupObject(json: Record<string, unknown>, shopId: string): PreparedShopBackup {
  const parsed = v2BackupSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.code === 'unrecognized_keys') {
      throw new Error('Invalid backup: contains an unknown record type or field.');
    }
    throw new Error(
      `Invalid backup at ${first?.path.join('.') || 'file'}: ${first?.message || 'check the file'}.`
    );
  }
  const data = parsed.data;
  const rawItems = [
    ...data.items.map((entry) => ({ entry, forceArchived: false })),
    ...(data.archivedItems ?? []).map((entry) => ({ entry, forceArchived: true })),
  ];
  if (rawItems.length > 2000) {
    throw new Error('Backup exceeds the 2,000-product limit.');
  }
  unique(
    rawItems.map((r) => r.entry.id),
    'product IDs'
  );
  unique(
    data.customers.map((c) => c.id),
    'customer IDs'
  );
  unique(
    data.sales.map((s) => s.id),
    'sale IDs'
  );
  unique(
    (data.creditPayments ?? []).map((p) => p.id),
    'credit payment IDs'
  );
  unique(
    (data.expenses ?? []).map((e) => e.id),
    'expense IDs'
  );
  unique(
    (data.stockMovements ?? []).map((m) => m.id),
    'stock movement IDs'
  );

  const itemSellingNgweeById = new Map<string, number>();
  const items: Item[] = rawItems.map(({ entry, forceArchived }) => {
    const sellingNgwee = parseStrictKwachaDecimalToNgwee(
      entry.sellingPrice,
      `items[${entry.id}].sellingPrice`,
      { allowZero: false }
    );
    const buyingKnown = entry.buyingPriceKnown !== false;
    const buyingNgwee = buyingKnown
      ? parseStrictKwachaDecimalToNgwee(entry.buyingPrice ?? 0, `items[${entry.id}].buyingPrice`, {
          allowZero: true,
        })
      : 0;
    itemSellingNgweeById.set(entry.id, sellingNgwee);
    return {
      id: entry.id,
      shopId,
      name: entry.name.trim(),
      unitLabel: entry.unitLabel ?? '',
      buyingPrice: fromNgwee(buyingNgwee),
      buyingPriceKnown: buyingKnown,
      sellingPrice: fromNgwee(sellingNgwee),
      quantity: entry.quantity,
      lowStockThreshold: entry.lowStockThreshold ?? 5,
      isDeleted: forceArchived || Boolean(entry.isDeleted),
      isDemo: Boolean(entry.isDemo),
      ...(entry.lastSoldAt ? { lastSoldAt: entry.lastSoldAt } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt ?? entry.createdAt,
    };
  });
  const itemsById = new Map(items.map((i) => [i.id, i]));

  const expectedCustomerOwed = new Map<string, number>();
  for (const c of data.customers) {
    expectedCustomerOwed.set(
      c.id,
      parseStrictKwachaDecimalToNgwee(c.totalOwed, `customers[${c.id}].totalOwed`, {
        allowZero: true,
      })
    );
  }
  const computedCustomerOwed = new Map<string, number>(data.customers.map((c) => [c.id, 0]));

  let saleLinesCount = 0;
  const sales: Sale[] = data.sales.map((s) => {
    const totalNgwee = parseStrictKwachaDecimalToNgwee(
      s.totalAmount,
      `sales[${s.id}].totalAmount`,
      { allowZero: false }
    );
    const costNgwee = parseStrictKwachaDecimalToNgwee(
      s.totalCost ?? 0,
      `sales[${s.id}].totalCost`,
      { allowZero: true }
    );
    const missingNgwee = parseStrictKwachaDecimalToNgwee(
      s.missingCostRevenue ?? 0,
      `sales[${s.id}].missingCostRevenue`,
      { allowZero: true }
    );

    let lineSumNgwee = 0;
    let lineCostNgwee = 0;
    let lineMissingNgwee = 0;
    let lineUnits = 0;

    const mappedLines = s.items.map((line) => {
      if (!itemsById.has(line.itemId)) {
        throw new Error(`Sale "${s.id}" refers to a missing product "${line.itemId}".`);
      }
      const lineSellingNgwee = parseStrictKwachaDecimalToNgwee(
        line.sellingPrice,
        `sales[${s.id}].items.sellingPrice`,
        { allowZero: false }
      );
      const lineBuyingKnown = line.buyingPriceKnown !== false;
      const lineBuyingNgwee = lineBuyingKnown
        ? parseStrictKwachaDecimalToNgwee(
            line.buyingPrice ?? 0,
            `sales[${s.id}].items.buyingPrice`,
            { allowZero: true }
          )
        : 0;
      const computedLineTotal = lineSellingNgwee * line.quantity;
      if (line.total !== undefined) {
        const declaredTotal = parseStrictKwachaDecimalToNgwee(
          line.total,
          `sales[${s.id}].items.total`,
          { allowZero: false }
        );
        if (declaredTotal !== computedLineTotal) {
          throw new Error(`Line item total on sale "${s.id}" does not match price × quantity.`);
        }
      }
      lineSumNgwee += computedLineTotal;
      lineUnits += line.quantity;
      if (lineBuyingKnown) lineCostNgwee += lineBuyingNgwee * line.quantity;
      else lineMissingNgwee += computedLineTotal;

      return {
        itemId: line.itemId,
        name: line.name.trim(),
        unitLabel: line.unitLabel ?? '',
        quantity: line.quantity,
        buyingPrice: fromNgwee(lineBuyingNgwee),
        buyingPriceKnown: lineBuyingKnown,
        sellingPrice: fromNgwee(lineSellingNgwee),
        total: fromNgwee(computedLineTotal),
      };
    });

    saleLinesCount += mappedLines.length;

    if (
      lineUnits !== s.itemsCount ||
      lineSumNgwee !== totalNgwee ||
      lineCostNgwee !== costNgwee ||
      lineMissingNgwee !== missingNgwee
    ) {
      throw new Error(
        `The totals or cost snapshots on receipt ${s.receiptNumber || s.id} do not match its items.`
      );
    }

    const expectedProfitNgwee = totalNgwee - costNgwee - missingNgwee;
    if (s.profit !== undefined) {
      const declaredProfitNgwee = parseSignedKwachaNgwee(s.profit, `sales[${s.id}].profit`);
      if (declaredProfitNgwee !== expectedProfitNgwee) {
        throw new Error(`Sale "${s.id}" profit does not equal revenue minus cost.`);
      }
    }

    if (s.paymentType === 'credit') {
      if (!s.customerId || !computedCustomerOwed.has(s.customerId)) {
        throw new Error(`Credit sale "${s.id}" refers to a missing customer.`);
      }
      if (!s.isDeleted) {
        computedCustomerOwed.set(
          s.customerId,
          (computedCustomerOwed.get(s.customerId) ?? 0) + totalNgwee
        );
      }
    }

    let cashTenderedKwacha: number | undefined;
    let changeGivenKwacha: number | undefined;
    if (s.cashTendered != null) {
      const tenderedNgwee = parseStrictKwachaDecimalToNgwee(
        s.cashTendered,
        `sales[${s.id}].cashTendered`,
        { allowZero: false }
      );
      if (tenderedNgwee < totalNgwee) {
        throw new Error(`Sale "${s.id}" cashTendered is less than totalAmount.`);
      }
      cashTenderedKwacha = fromNgwee(tenderedNgwee);
      changeGivenKwacha = fromNgwee(tenderedNgwee - totalNgwee);
    }

    return {
      id: s.id,
      shopId,
      items: mappedLines,
      itemsCount: s.itemsCount,
      totalAmount: fromNgwee(totalNgwee),
      totalCost: fromNgwee(costNgwee),
      profit: fromNgwee(expectedProfitNgwee),
      missingCostRevenue: fromNgwee(missingNgwee),
      paymentType: s.paymentType,
      ...(s.momoOperator ? { momoOperator: s.momoOperator } : {}),
      ...(s.customerId ? { customerId: s.customerId } : {}),
      ...(s.customerName ? { customerName: s.customerName } : {}),
      ...(s.customerPhone ? { customerPhone: s.customerPhone } : {}),
      receiptNumber: s.receiptNumber || s.id,
      paymentReference: s.paymentReference || '',
      note: s.note || '',
      ...(s.localDate ? { localDate: s.localDate } : {}),
      ...(cashTenderedKwacha !== undefined
        ? { cashTendered: cashTenderedKwacha, changeGiven: changeGivenKwacha }
        : {}),
      isDeleted: Boolean(s.isDeleted),
      isDemo: Boolean(s.isDemo),
      createdAt: s.createdAt,
    };
  });
  const salesById = new Map(sales.map((s) => [s.id, s]));

  const creditPayments: CreditPayment[] = (data.creditPayments ?? []).map((cp) => {
    if (!computedCustomerOwed.has(cp.customerId)) {
      throw new Error(`Credit payment "${cp.id}" refers to a missing customer.`);
    }
    const amtNgwee = parseStrictKwachaDecimalToNgwee(cp.amount, `creditPayments[${cp.id}].amount`, {
      allowZero: false,
    });
    computedCustomerOwed.set(
      cp.customerId,
      (computedCustomerOwed.get(cp.customerId) ?? 0) - amtNgwee
    );
    return {
      id: cp.id,
      shopId,
      customerId: cp.customerId,
      customerName: cp.customerName.trim(),
      amount: fromNgwee(amtNgwee),
      paymentMethod: cp.paymentMethod,
      note: cp.note ?? '',
      ...(cp.localDate ? { localDate: cp.localDate } : {}),
      isDemo: Boolean(cp.isDemo),
      createdAt: cp.createdAt,
    };
  });

  const customerOwedNgweeById = new Map<string, number>();
  const customers: Customer[] = data.customers.map((c) => {
    const computed = computedCustomerOwed.get(c.id) ?? 0;
    const expected = expectedCustomerOwed.get(c.id) ?? 0;
    if (computed < 0 || computed !== expected) {
      throw new Error(
        `Customer "${c.name}" credit balance does not match credit sales minus repayments.`
      );
    }
    customerOwedNgweeById.set(c.id, computed);
    return {
      id: c.id,
      shopId,
      name: c.name.trim(),
      phone: c.phone ?? '',
      notes: c.notes ?? '',
      totalOwed: fromNgwee(computed),
      isDemo: Boolean(c.isDemo),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt ?? c.createdAt,
    };
  });

  const expenses: Expense[] = (data.expenses ?? []).map((e) => {
    const amtNgwee = parseStrictKwachaDecimalToNgwee(e.amount, `expenses[${e.id}].amount`, {
      allowZero: false,
    });
    return {
      id: e.id,
      shopId,
      category: e.category,
      amount: fromNgwee(amtNgwee),
      note: e.note ?? '',
      isDeleted: Boolean(e.isDeleted),
      createdAt: e.createdAt,
    };
  });

  const rawMovements: StockMovement[] = (data.stockMovements ?? []).map((m) => {
    if (!itemsById.has(m.itemId)) {
      throw new Error(`Stock movement "${m.id}" refers to a missing product.`);
    }
    if (m.relatedSaleId && !salesById.has(m.relatedSaleId)) {
      throw new Error(`Stock movement "${m.id}" refers to a missing sale.`);
    }
    if (Math.max(0, m.previousQuantity + m.delta) !== m.newQuantity) {
      throw new Error(`Stock movement "${m.id}" has inconsistent previous/delta/new quantities.`);
    }
    return {
      id: m.id,
      shopId,
      itemId: m.itemId,
      itemName: m.itemName.trim(),
      type: m.type,
      delta: m.delta,
      previousQuantity: m.previousQuantity,
      newQuantity: m.newQuantity,
      reason: m.reason ?? '',
      ...(m.relatedSaleId ? { relatedSaleId: m.relatedSaleId } : {}),
      ...(m.requestedQuantity != null ? { requestedQuantity: m.requestedQuantity } : {}),
      ...(m.recountNeeded ? { recountNeeded: true } : {}),
      isDemo: Boolean(m.isDemo),
      createdAt: m.createdAt,
    };
  });

  const stockMovements = ensureOpeningStockMovements(items, rawMovements);
  const sourceShopName = data.shop?.name?.trim() || 'CountUp backup';

  const preview = buildPreview({
    format: 'countup-backup-v2',
    sourceShopName,
    items,
    itemSellingNgweeById,
    sales,
    saleLinesCount,
    customers,
    customerOwedNgweeById,
    expenses,
    creditPayments,
    stockMovements,
  });

  return {
    format: 'countup-backup-v2',
    sourceShopName,
    items,
    customers,
    sales,
    creditPayments,
    expenses,
    stockMovements,
    preview,
    parsedJson: json,
  };
}

/**
 * Validates and prepares either a `shopbook-backup-v1` or `countup-backup-v2`
 * JSON string without writing to storage or the server.
 */
export function prepareShopBackupImport(raw: string, shopId: string): PreparedShopBackup {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new Error('The backup is larger than 5 MB. Contact support before importing it.');
  }

  assertSafeRawJsonNumbers(raw);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Invalid backup format: expected a JSON object.');
  }
  const obj = json as Record<string, unknown>;
  if (obj.format === 'shopbook-backup-v1') {
    return parseV1BackupObject(obj, shopId);
  }
  if (obj.format === 'countup-backup-v2') {
    return parseV2BackupObject(obj, shopId);
  }
  throw new Error(
    'Unsupported backup format. Choose a shopbook-backup-v1 or countup-backup-v2 JSON backup.'
  );
}

/** Convert a legacy v1 JSON backup into the existing ledger, without writes. */
export function prepareLegacyBackupImport(raw: string, shopId: string): LegacyBackupImport {
  assertSafeRawJsonNumbers(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Invalid backup format. Choose a full legacy v1 JSON backup.');
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'shopbook-backup-v1') {
    throw new Error('Invalid backup format. Choose a full legacy v1 JSON backup.');
  }
  const prepared = parseV1BackupObject(obj, shopId);
  return {
    sourceShopName: prepared.sourceShopName,
    items: prepared.items,
    customers: prepared.customers,
    sales: prepared.sales,
    creditPayments: prepared.creditPayments,
    stockMovements: prepared.stockMovements,
  };
}

/**
 * Splits a validated `PreparedShopBackup` (whether originally `shopbook-backup-v1`
 * or `countup-backup-v2`) into canonical v2 section chunks (`<= 500` records per
 * chunk by default) for staged upload via `begin_shop_backup_import` ->
 * `append_shop_backup_chunk` -> `finalize_shop_backup_import`.
 */
export function buildBackupImportChunks(
  prepared: PreparedShopBackup,
  maxRecordsPerChunk = 500
): StagedBackupChunkDescriptor[] {
  const chunkSize = Math.max(1, Math.min(2000, Math.floor(maxRecordsPerChunk)));
  const activeItems = prepared.items.filter((i) => !i.isDeleted);
  const archivedItems = prepared.items.filter((i) => i.isDeleted);

  const sections: Array<[BackupChunkSection, unknown[]]> = [
    ['items', activeItems],
    ['archivedItems', archivedItems],
    ['customers', prepared.customers],
    ['sales', prepared.sales],
    ['creditPayments', prepared.creditPayments],
    ['expenses', prepared.expenses],
    ['stockMovements', prepared.stockMovements],
  ];

  const chunks: StagedBackupChunkDescriptor[] = [];
  for (const [section, list] of sections) {
    if (list.length === 0) continue;
    for (let offset = 0; offset < list.length; offset += chunkSize) {
      chunks.push({
        chunkIndex: chunks.length,
        section,
        records: list.slice(offset, offset + chunkSize) as Array<Record<string, unknown>>,
      });
    }
  }

  // An empty backup still needs at least 1 chunk so expected_chunks >= 1
  if (chunks.length === 0) {
    chunks.push({
      chunkIndex: 0,
      section: 'items',
      records: [],
    });
  }

  return chunks;
}
