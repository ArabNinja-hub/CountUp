import { z } from 'zod';
import { CreditPayment, Customer, Item, Sale, StockMovement } from '../types';
import { fromNgwee } from '../utils/money';

// A legacy backup is untrusted input. All validation and reconciliation happens
// before any write. IDs are namespaced so importing never replaces CountUp records.
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().max(500);
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'Invalid timestamp');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const integer = z.number().int().min(0).max(1_000_000);
const money = z.number().int().min(0).max(100_000_000_000);
const optionalText = text.nullable().optional();
const demo = z.boolean().optional();

const productSchema = z.object({
  id,
  name: text.min(1),
  unitLabel: text.optional(),
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
  id,
  name: text.min(1),
  phone: text.optional(),
  notes: text.optional(),
  isDemo: demo,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const saleSchema = z.object({
  id,
  operationId: text.min(1),
  receiptNumber: text.min(1),
  paymentMethod: z.enum(['cash', 'mobile_money', 'credit']),
  paymentReference: optionalText,
  customerId: id.nullable().optional(),
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
  id,
  saleId: id,
  productId: id,
  productNameAtSale: text.min(1),
  unitLabelAtSale: text.optional(),
  sellingPriceAtSaleNgwee: money.positive(),
  costPriceAtSaleNgwee: money.nullable().optional(),
  quantity: integer.positive(),
  lineTotalNgwee: money.positive(),
  isDemo: demo,
  createdAt: timestamp,
});
const movementSchema = z.object({
  id,
  operationId: text.min(1),
  productId: id,
  productNameSnapshot: text.min(1),
  type: z.enum(['initial', 'sale', 'restock', 'adjustment']),
  deltaQty: z.number().int().min(-1_000_000).max(1_000_000),
  previousQty: integer,
  newQty: integer,
  reason: text,
  relatedSaleId: id.nullable().optional(),
  isDemo: demo,
  createdAt: timestamp,
});
const creditSchema = z.object({
  id,
  operationId: text.min(1),
  customerId: id,
  customerNameSnapshot: text.min(1),
  type: z.enum(['credit_sale', 'repayment']),
  amountNgwee: money.positive(),
  paymentMethod: z.enum(['cash', 'mobile_money']).nullable(),
  relatedSaleId: id.nullable().optional(),
  note: text.optional(),
  isDemo: demo,
  createdAt: timestamp,
  localDate: date,
});
const backupSchema = z.object({
  format: z.literal('shopbook-backup-v1'),
  exportedAt: timestamp,
  shopSettings: z.object({ shopName: text }).passthrough(),
  products: z.array(productSchema),
  customers: z.array(customerSchema),
  sales: z.array(saleSchema),
  saleItems: z.array(saleItemSchema),
  stockMovements: z.array(movementSchema),
  creditTransactions: z.array(creditSchema),
});

export interface LegacyBackupImport {
  sourceShopName: string;
  items: Item[];
  sales: Sale[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  stockMovements: StockMovement[];
}

const mappedId = (sourceId: string) => `shopbook_${sourceId}`;

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Backup has duplicate ${label}.`);
}

/** Convert a legacy v1 JSON backup into the existing ledger, without writes. */
export function prepareLegacyBackupImport(raw: string, shopId: string): LegacyBackupImport {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.path[0] === 'format') {
      throw new Error('Invalid backup format. Choose a full legacy v1 JSON backup.');
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
  ] as const)
    unique(
      records.map((r) => r.id),
      label
    );
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
    // A legacy sync conflict can clamp stock at zero while retaining the requested delta.
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

  const items: Item[] = data.products.map((p) => ({
    id: mappedId(p.id),
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
  }));
  const customers: Customer[] = data.customers.map((c) => ({
    id: mappedId(c.id),
    shopId,
    name: c.name,
    phone: c.phone || '',
    notes: c.notes || '',
    totalOwed: fromNgwee(balance.get(c.id) ?? 0),
    isDemo: Boolean(c.isDemo),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
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
  const stockMovements: StockMovement[] = data.stockMovements.map((m) => ({
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
  return {
    sourceShopName: data.shopSettings.shopName,
    items,
    customers,
    sales,
    creditPayments,
    stockMovements,
  };
}
