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
  CreditPayment,
  Customer,
  Expense,
  Item,
  Sale,
  SaleItem,
  Shop,
  StockConflict,
  StockMovement,
  SubscriptionPayment,
} from '../types';
import { fromNgwee, toNgwee } from '../utils/money';

/**
 * Validates that a persisted or server money value is an exact safe integer in
 * ngwee (never a floating-point Kwacha value, NaN, or Infinity).
 */
export function assertSafeIntegerNgwee(value: unknown, fieldName: string): number {
  const normalized =
    typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw new Error(`Expected integer ngwee for ${fieldName}, received ${String(value)}.`);
  }
  return normalized;
}

export function shopRowToDomain(
  row: ShopRow & {
    security_notice?: string | null;
    security_notice_at?: string | null;
    subscription_notice?: string | null;
    subscription_notice_at?: string | null;
  }
): Shop {
  const trialEndsMs = Date.parse(row.trial_ends_at);
  const planExpiryMs = Date.parse(row.plan_expiry_at);
  const salesAccessMs = Date.parse(row.sales_access_until);
  const startedMs = row.subscription_started_at
    ? Date.parse(row.subscription_started_at)
    : undefined;

  return {
    id: row.id,
    name: row.name,
    ownerPhone: row.owner_phone,
    ownerUid: row.owner_user_id,
    planStatus: row.plan_status,
    planType: row.plan_type,
    createdAt: row.created_at,
    trialEndsAt: row.trial_ends_at,
    planExpiryDate: row.plan_expiry_at,
    trialEndsAtMs: Number.isFinite(trialEndsMs) ? trialEndsMs : undefined,
    planExpiryAtMs: Number.isFinite(planExpiryMs) ? planExpiryMs : undefined,
    salesAccessUntilMs: Number.isFinite(salesAccessMs) ? salesAccessMs : undefined,
    ...(row.pending_payment_id ? { pendingPaymentId: row.pending_payment_id } : {}),
    ...(row.subscription_started_at
      ? {
          subscriptionStartedAt: row.subscription_started_at,
          ...(Number.isFinite(startedMs) ? { subscriptionStartedAtMs: startedMs } : {}),
        }
      : {}),
    ...(row.subscription_payment_id ? { subscriptionPaymentId: row.subscription_payment_id } : {}),
    ...(row.status_before_suspension
      ? { statusBeforeSuspension: row.status_before_suspension }
      : {}),
    isDeactivated: row.is_deactivated,
    currency: 'ZMW',
    ...(row.momo_airtel_number ? { momoAirtelNumber: row.momo_airtel_number } : {}),
    ...(row.momo_mtn_number ? { momoMtnNumber: row.momo_mtn_number } : {}),
    ...(row.momo_zamtel_number ? { momoZamtelNumber: row.momo_zamtel_number } : {}),
    securityNotice: row.security_notice ?? null,
    securityNoticeAt: row.security_notice_at ?? null,
    subscriptionNotice: row.subscription_notice ?? null,
    subscriptionNoticeAt: row.subscription_notice_at ?? null,
  };
}

export function itemRowToDomain(row: ItemRow): Item {
  const buyingNgwee = assertSafeIntegerNgwee(row.buying_price_ngwee, 'items.buying_price_ngwee');
  const sellingNgwee = assertSafeIntegerNgwee(row.selling_price_ngwee, 'items.selling_price_ngwee');
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    buyingPrice: fromNgwee(buyingNgwee),
    buyingPriceKnown: row.buying_price_known,
    sellingPrice: fromNgwee(sellingNgwee),
    ...(row.unit_label ? { unitLabel: row.unit_label } : {}),
    isDeleted: row.is_deleted,
    ...(row.is_demo ? { isDemo: true } : {}),
    quantity: row.quantity,
    lowStockThreshold: row.low_stock_threshold,
    ...(row.last_sold_at ? { lastSoldAt: row.last_sold_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function domainItemToRow(item: Item): ItemRow {
  const buyingPriceKnown = item.buyingPriceKnown !== false;
  return {
    shop_id: item.shopId,
    id: item.id,
    name: item.name,
    buying_price_ngwee: buyingPriceKnown ? toNgwee(item.buyingPrice) : 0,
    buying_price_known: buyingPriceKnown,
    selling_price_ngwee: toNgwee(item.sellingPrice),
    unit_label: item.unitLabel ?? '',
    quantity: item.quantity,
    low_stock_threshold: item.lowStockThreshold,
    is_deleted: Boolean(item.isDeleted),
    is_demo: Boolean(item.isDemo),
    last_sold_at: item.lastSoldAt ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

export function customerRowToDomain(row: CustomerRow): Customer {
  const owedNgwee = assertSafeIntegerNgwee(row.total_owed_ngwee, 'customers.total_owed_ngwee');
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.is_demo ? { isDemo: true } : {}),
    totalOwed: fromNgwee(owedNgwee),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function domainCustomerToRow(customer: Customer): CustomerRow {
  return {
    shop_id: customer.shopId,
    id: customer.id,
    name: customer.name,
    phone: customer.phone ?? '',
    notes: customer.notes ?? '',
    total_owed_ngwee: toNgwee(customer.totalOwed),
    is_demo: Boolean(customer.isDemo),
    created_at: customer.createdAt,
    updated_at: customer.updatedAt,
  };
}

export function saleLineRowToDomain(line: SaleLineRow): SaleItem {
  const buyingNgwee = assertSafeIntegerNgwee(
    line.buying_price_ngwee,
    'sale_lines.buying_price_ngwee'
  );
  const sellingNgwee = assertSafeIntegerNgwee(
    line.selling_price_ngwee,
    'sale_lines.selling_price_ngwee'
  );
  assertSafeIntegerNgwee(line.line_total_ngwee, 'sale_lines.line_total_ngwee');
  return {
    itemId: line.item_id,
    name: line.item_name,
    quantity: line.quantity,
    buyingPrice: fromNgwee(buyingNgwee),
    buyingPriceKnown: line.buying_price_known,
    sellingPrice: fromNgwee(sellingNgwee),
    ...(line.unit_label ? { unitLabel: line.unit_label } : {}),
  };
}

export function saleRowsToDomain(
  row: SaleRow,
  lines: readonly SaleLineRow[]
): Sale & { isDeleted?: boolean; updatedAt?: string } {
  const totalAmountNgwee = assertSafeIntegerNgwee(
    row.total_amount_ngwee,
    'sales.total_amount_ngwee'
  );
  const totalCostNgwee = assertSafeIntegerNgwee(row.total_cost_ngwee, 'sales.total_cost_ngwee');
  const profitNgwee = assertSafeIntegerNgwee(row.profit_ngwee, 'sales.profit_ngwee');
  const missingCostNgwee = assertSafeIntegerNgwee(
    row.missing_cost_revenue_ngwee,
    'sales.missing_cost_revenue_ngwee'
  );
  const cashTenderedNgwee =
    row.cash_tendered_ngwee !== null && row.cash_tendered_ngwee !== undefined
      ? assertSafeIntegerNgwee(row.cash_tendered_ngwee, 'sales.cash_tendered_ngwee')
      : null;
  const changeGivenNgwee =
    row.change_given_ngwee !== null && row.change_given_ngwee !== undefined
      ? assertSafeIntegerNgwee(row.change_given_ngwee, 'sales.change_given_ngwee')
      : null;

  const sortedLines = [...lines].sort((a, b) => a.line_index - b.line_index);

  return {
    id: row.id,
    shopId: row.shop_id,
    items: sortedLines.map(saleLineRowToDomain),
    itemsCount: row.items_count,
    totalAmount: fromNgwee(totalAmountNgwee),
    totalCost: fromNgwee(totalCostNgwee),
    profit: fromNgwee(profitNgwee),
    paymentType: row.payment_type,
    ...(row.momo_operator ? { momoOperator: row.momo_operator } : {}),
    ...(row.customer_id ? { customerId: row.customer_id } : {}),
    ...(row.customer_name ? { customerName: row.customer_name } : {}),
    ...(row.customer_phone ? { customerPhone: row.customer_phone } : {}),
    receiptNumber: row.receipt_number,
    ...(row.payment_reference ? { paymentReference: row.payment_reference } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.local_date ? { localDate: row.local_date } : {}),
    ...(missingCostNgwee > 0 ? { missingCostRevenue: fromNgwee(missingCostNgwee) } : {}),
    ...(cashTenderedNgwee !== null ? { cashTendered: fromNgwee(cashTenderedNgwee) } : {}),
    ...(changeGivenNgwee !== null ? { changeGiven: fromNgwee(changeGivenNgwee) } : {}),
    ...(row.is_demo ? { isDemo: true } : {}),
    ...(row.is_offline_sync ? { isOfflineSync: true } : {}),
    ...(row.offline_window_flagged ? { offlineWindowFlagged: true } : {}),
    ...(row.is_deleted ? { isDeleted: true } : {}),
    createdAt: row.client_created_at ?? row.created_at,
    updatedAt: row.updated_at,
  };
}

export function domainSaleToRows(sale: Sale & { isDeleted?: boolean; updatedAt?: string }): {
  sale: SaleRow;
  lines: SaleLineRow[];
} {
  const updatedAt = sale.updatedAt ?? sale.createdAt;
  const totalAmountNgwee = toNgwee(sale.totalAmount);
  const totalCostNgwee = toNgwee(sale.totalCost);
  const missingCostNgwee = sale.missingCostRevenue ? toNgwee(sale.missingCostRevenue) : 0;
  const profitNgwee = toNgwee(sale.profit);

  const saleRow: SaleRow = {
    shop_id: sale.shopId,
    id: sale.id,
    items_count: sale.itemsCount,
    total_amount_ngwee: totalAmountNgwee,
    total_cost_ngwee: totalCostNgwee,
    profit_ngwee: profitNgwee,
    missing_cost_revenue_ngwee: missingCostNgwee,
    payment_type: sale.paymentType,
    momo_operator: sale.momoOperator ?? null,
    customer_id: sale.customerId ?? null,
    customer_name: sale.customerName ?? null,
    customer_phone: sale.customerPhone ?? null,
    receipt_number: sale.receiptNumber ?? sale.id,
    payment_reference: sale.paymentReference ?? null,
    note: sale.note ?? null,
    local_date: sale.localDate ?? null,
    cash_tendered_ngwee: sale.cashTendered !== undefined ? toNgwee(sale.cashTendered) : null,
    change_given_ngwee: sale.changeGiven !== undefined ? toNgwee(sale.changeGiven) : null,
    is_deleted: Boolean(sale.isDeleted),
    is_demo: Boolean(sale.isDemo),
    is_offline_sync: Boolean(sale.isOfflineSync),
    offline_window_flagged: false,
    offline_flag_reason: null,
    client_created_at: sale.createdAt,
    created_at: sale.createdAt,
    updated_at: updatedAt,
  };

  const lines: SaleLineRow[] = (sale.items ?? []).map((line, index) => {
    const buyingPriceKnown = line.buyingPriceKnown !== false;
    const sellingNgwee = toNgwee(line.sellingPrice);
    return {
      shop_id: sale.shopId,
      id: `${sale.id}:${index}`,
      sale_id: sale.id,
      line_index: index,
      item_id: line.itemId,
      item_name: line.name,
      unit_label: line.unitLabel ?? '',
      quantity: line.quantity,
      buying_price_ngwee: buyingPriceKnown ? toNgwee(line.buyingPrice) : 0,
      buying_price_known: buyingPriceKnown,
      selling_price_ngwee: sellingNgwee,
      line_total_ngwee: sellingNgwee * line.quantity,
      created_at: sale.createdAt,
      updated_at: updatedAt,
    };
  });

  return { sale: saleRow, lines };
}

export function creditPaymentRowToDomain(row: CreditPaymentRow): CreditPayment {
  const amountNgwee = assertSafeIntegerNgwee(row.amount_ngwee, 'credit_payments.amount_ngwee');
  return {
    id: row.id,
    shopId: row.shop_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    amount: fromNgwee(amountNgwee),
    paymentMethod: row.payment_method,
    ...(row.note ? { note: row.note } : {}),
    ...(row.local_date ? { localDate: row.local_date } : {}),
    ...(row.is_demo ? { isDemo: true } : {}),
    createdAt: row.created_at,
  };
}

export function domainCreditPaymentToRow(
  payment: CreditPayment & { updatedAt?: string }
): CreditPaymentRow {
  return {
    shop_id: payment.shopId,
    id: payment.id,
    customer_id: payment.customerId,
    customer_name: payment.customerName,
    amount_ngwee: toNgwee(payment.amount),
    payment_method: payment.paymentMethod ?? 'cash',
    note: payment.note ?? '',
    local_date: payment.localDate ?? null,
    is_demo: Boolean(payment.isDemo),
    sync_correction: null,
    created_at: payment.createdAt,
    updated_at: payment.updatedAt ?? payment.createdAt,
  };
}

export function expenseRowToDomain(
  row: ExpenseRow
): Expense & { isDeleted?: boolean; updatedAt?: string } {
  const amountNgwee = assertSafeIntegerNgwee(row.amount_ngwee, 'expenses.amount_ngwee');
  return {
    id: row.id,
    shopId: row.shop_id,
    category: row.category as Expense['category'],
    amount: fromNgwee(amountNgwee),
    ...(row.note ? { note: row.note } : {}),
    ...(row.is_deleted ? { isDeleted: true } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function domainExpenseToRow(
  expense: Expense & { isDeleted?: boolean; updatedAt?: string }
): ExpenseRow {
  return {
    shop_id: expense.shopId,
    id: expense.id,
    category: expense.category,
    amount_ngwee: toNgwee(expense.amount),
    note: expense.note ?? '',
    is_deleted: Boolean(expense.isDeleted),
    created_at: expense.createdAt,
    updated_at: expense.updatedAt ?? expense.createdAt,
  };
}

export function stockMovementRowToDomain(row: StockMovementRow): StockMovement {
  return {
    id: row.id,
    shopId: row.shop_id,
    itemId: row.item_id,
    itemName: row.item_name,
    type: row.type,
    delta: row.delta,
    previousQuantity: row.previous_quantity,
    newQuantity: row.new_quantity,
    reason: row.reason ?? '',
    ...(row.related_sale_id ? { relatedSaleId: row.related_sale_id } : {}),
    ...(row.requested_quantity !== null && row.requested_quantity !== undefined
      ? { requestedQuantity: row.requested_quantity }
      : {}),
    ...(row.recount_needed ? { recountNeeded: true } : {}),
    ...(row.is_demo ? { isDemo: true } : {}),
    createdAt: row.created_at,
  };
}

export function domainStockMovementToRow(
  movement: StockMovement & { updatedAt?: string }
): StockMovementRow {
  return {
    shop_id: movement.shopId,
    id: movement.id,
    item_id: movement.itemId,
    item_name: movement.itemName,
    type: movement.type,
    delta: movement.delta,
    previous_quantity: movement.previousQuantity,
    new_quantity: movement.newQuantity,
    reason: movement.reason ?? '',
    related_sale_id: movement.relatedSaleId ?? null,
    requested_quantity: movement.requestedQuantity ?? null,
    recount_needed: Boolean(movement.recountNeeded),
    is_demo: Boolean(movement.isDemo),
    created_at: movement.createdAt,
    updated_at: movement.updatedAt ?? movement.createdAt,
  };
}

export function stockConflictRowToDomain(row: StockConflictRow): StockConflict {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    kind: row.kind as StockConflict['kind'],
    ...(row.observed !== null && row.observed !== undefined ? { observed: row.observed } : {}),
    requested: row.requested,
    available: row.available,
    shortfall: row.shortfall,
    ...(row.related_sale_id ? { relatedSaleId: row.related_sale_id } : {}),
    resolved: row.resolved,
    createdAt: row.created_at,
  };
}

export function domainStockConflictToRow(
  conflict: StockConflict & { shopId?: string; updatedAt?: string },
  fallbackShopId = ''
): StockConflictRow {
  return {
    shop_id: conflict.shopId ?? fallbackShopId,
    id: conflict.id,
    item_id: conflict.itemId,
    item_name: conflict.itemName,
    kind: conflict.kind ?? 'shortfall',
    observed: conflict.observed ?? null,
    requested: conflict.requested,
    available: conflict.available,
    shortfall: conflict.shortfall,
    related_sale_id: conflict.relatedSaleId ?? null,
    resolved: conflict.resolved,
    created_at: conflict.createdAt,
    updated_at: conflict.updatedAt ?? conflict.createdAt,
  };
}

export function subscriptionPaymentRowToDomain(row: SubscriptionPaymentRow): SubscriptionPayment {
  const amountNgwee = assertSafeIntegerNgwee(
    row.amount_ngwee,
    'subscription_payments.amount_ngwee'
  );
  const submittedAtMs = Date.parse(row.submitted_at);
  const reviewedAtMs = row.reviewed_at ? Date.parse(row.reviewed_at) : undefined;
  const startMs = row.subscription_start_at ? Date.parse(row.subscription_start_at) : undefined;
  const expiryMs = row.subscription_expiry_at ? Date.parse(row.subscription_expiry_at) : undefined;

  return {
    id: row.id,
    shopId: row.shop_id,
    shopNameSnapshot: row.shop_name_snapshot,
    ownerUid: row.owner_user_id,
    provider: 'manual_mobile_money',
    network: row.network,
    planId: row.plan_id,
    transactionReference: row.transaction_reference,
    payerPhone: row.payer_phone,
    paymentDate: row.payment_date,
    amountNgwee,
    status: row.status,
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    submittedAt: row.submitted_at,
    submittedAtMs: Number.isFinite(submittedAtMs) ? submittedAtMs : 0,
    ...(row.reviewed_at
      ? {
          reviewedAt: row.reviewed_at,
          ...(Number.isFinite(reviewedAtMs) ? { reviewedAtMs } : {}),
        }
      : {}),
    ...(row.reviewed_by_user_id ? { reviewedByUid: row.reviewed_by_user_id } : {}),
    ...(row.subscription_start_at
      ? {
          subscriptionStartAt: row.subscription_start_at,
          ...(Number.isFinite(startMs) ? { subscriptionStartAtMs: startMs } : {}),
        }
      : {}),
    ...(row.subscription_expiry_at
      ? {
          subscriptionExpiryAt: row.subscription_expiry_at,
          ...(Number.isFinite(expiryMs) ? { subscriptionExpiryAtMs: expiryMs } : {}),
        }
      : {}),
  };
}
