import { CreditPayment } from '../types';
import { toNgwee } from '../utils/money';
import { PendingSyncAction, SyncAdjustment } from '../utils/sync';

/** Only well-formed operations created by CountUp can be reviewed in the app. */
export type ReviewableAction =
  | {
      kind: 'payment';
      action: PendingSyncAction;
      customerPath: string;
      paymentPath: string;
      payment: CreditPayment;
      amountNgwee: number;
    }
  | {
      kind: 'void';
      action: PendingSyncAction;
      customerPath: string;
      salePath: string;
      saleId: string;
      amountNgwee: number;
      stockAdjustments: Extract<SyncAdjustment, { kind: 'stock' }>[];
    };

export interface SyncConflictReview {
  actionId: string;
  kind: 'payment' | 'void';
  customerName: string;
  originalAmount: number;
  serverBalance: number;
  queuedAt: string;
  receipt?: string;
  alreadyProcessed: boolean;
  canRetry: boolean;
}

export type SyncReviewDecision =
  { kind: 'correct-payment'; amount: number } | { kind: 'cancel-payment' } | { kind: 'keep-sale' };

/** Stored in the same atomic transaction as the decision; never a replacement for a receipt. */
export interface SyncResolutionAudit {
  kind: 'correct-payment' | 'cancel-payment' | 'keep-sale';
  actionId: string;
  resolvedAt: string;
  resolvedBy: string;
  customerName: string;
  customerId: string;
  originalAmount: number;
  serverBalanceBefore: number;
  correctedAmount?: number;
  originalPayment?: CreditPayment;
  saleId?: string;
  receipt?: string;
  /** Preserve the proposed stock changes when a queued undo is cancelled. */
  stockRestorations?: { itemId: string; itemName: string; quantity: number }[];
  queuedAt: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Identify a complete queued undo before treating another device's undo as a duplicate. */
export function voidActionSaleId(action: PendingSyncAction, shopId: string): string | null {
  try {
    if (action.type !== 'sale' || !action.writes?.length) return null;
    const root = `shops/${shopId}`;
    const sale = action.writes.find(
      (write) =>
        write.path.startsWith(`${root}/sales/`) &&
        record(write.data) &&
        write.data.isDeleted === true
    );
    if (!sale || action.path !== sale.path) return null;
    const saleId = sale.path.slice(`${root}/sales/`.length);
    if (!saleId || saleId.includes('/')) return null;
    const expected = new Set([sale.path]);
    let creditCount = 0;
    for (const adjustment of action.adjustments ?? []) {
      if (adjustment.kind === 'credit') {
        if (
          ++creditCount > 1 ||
          !adjustment.path.startsWith(`${root}/customers/`) ||
          adjustment.path.slice(`${root}/customers/`.length).includes('/') ||
          !Number.isSafeInteger(adjustment.deltaNgwee) ||
          adjustment.deltaNgwee >= 0
        )
          return null;
        expected.add(adjustment.path);
      } else {
        if (
          !adjustment.path.startsWith(`${root}/items/`) ||
          adjustment.path.slice(`${root}/items/`.length).includes('/') ||
          !adjustment.movement.path.startsWith(`${root}/stock_movements/`) ||
          adjustment.movement.path.slice(`${root}/stock_movements/`.length).includes('/') ||
          adjustment.movement.data.type !== 'void' ||
          adjustment.movement.data.relatedSaleId !== saleId ||
          adjustment.movement.data.shopId !== shopId ||
          adjustment.path !== `${root}/items/${adjustment.movement.data.itemId}` ||
          adjustment.movement.path !== `${root}/stock_movements/${adjustment.movement.data.id}` ||
          !Number.isSafeInteger(adjustment.delta) ||
          adjustment.delta <= 0 ||
          adjustment.setTo !== undefined
        )
          return null;
        expected.add(adjustment.path);
        expected.add(adjustment.movement.path);
      }
    }
    const paths = action.writes.map((write) => write.path);
    return expected.size === paths.length && paths.every((path) => expected.has(path))
      ? saleId
      : null;
  } catch {
    return null;
  }
}

/**
 * Validate the complete operation, not just its type: a legacy or damaged queue
 * must never gain a button that silently skips unrelated writes.
 */
export function reviewableAction(
  action: PendingSyncAction,
  shopId: string
): ReviewableAction | null {
  try {
    const root = `shops/${shopId}`;
    const writes = action.writes;
    const adjustments = action.adjustments;
    if (
      !writes?.length ||
      !adjustments?.length ||
      !action.id ||
      action.id.includes('/') ||
      !Number.isFinite(new Date(action.timestamp).getTime())
    )
      return null;
    const credits = adjustments.filter(
      (entry): entry is Extract<SyncAdjustment, { kind: 'credit' }> => entry.kind === 'credit'
    );
    if (credits.length !== 1 || !Number.isSafeInteger(credits[0].deltaNgwee)) return null;
    const credit = credits[0];
    if (credit.deltaNgwee >= 0) return null;
    const customerPrefix = `${root}/customers/`;
    if (!credit.path.startsWith(customerPrefix)) return null;
    const customerId = credit.path.slice(customerPrefix.length);
    if (!customerId || customerId.includes('/')) return null;
    const amountNgwee = -credit.deltaNgwee;
    const paths = writes.map((write) => write.path);
    if (new Set(paths).size !== paths.length || !paths.includes(credit.path)) return null;

    if (action.type === 'payment' && adjustments.length === 1 && writes.length === 2) {
      const paymentWrite = writes.find((write) =>
        write.path.startsWith(`${root}/credit_payments/`)
      );
      if (!paymentWrite || action.path !== paymentWrite.path || !record(paymentWrite.data))
        return null;
      const paymentId = paymentWrite.path.slice(`${root}/credit_payments/`.length);
      const payment = paymentWrite.data;
      if (
        !paymentId ||
        paymentId.includes('/') ||
        payment.id !== paymentId ||
        payment.shopId !== shopId ||
        payment.customerId !== customerId ||
        typeof payment.customerName !== 'string' ||
        typeof payment.createdAt !== 'string' ||
        typeof payment.amount !== 'number' ||
        toNgwee(payment.amount) !== amountNgwee
      )
        return null;
      return {
        kind: 'payment',
        action,
        customerPath: credit.path,
        paymentPath: paymentWrite.path,
        payment: payment as unknown as CreditPayment,
        amountNgwee,
      };
    }

    if (action.type !== 'sale') return null;
    const saleWrite = writes.find((write) => write.path.startsWith(`${root}/sales/`));
    if (
      !saleWrite ||
      action.path !== saleWrite.path ||
      !record(saleWrite.data) ||
      saleWrite.data.isDeleted !== true
    )
      return null;
    const saleId = saleWrite.path.slice(`${root}/sales/`.length);
    if (!saleId || saleId.includes('/')) return null;
    const stock = adjustments.filter(
      (entry): entry is Extract<SyncAdjustment, { kind: 'stock' }> => entry.kind === 'stock'
    );
    if (stock.length + 1 !== adjustments.length) return null;
    const expected = new Set([saleWrite.path, credit.path]);
    for (const entry of stock) {
      const movement = entry.movement?.data;
      if (
        !entry.path.startsWith(`${root}/items/`) ||
        entry.path.slice(`${root}/items/`.length).includes('/') ||
        !entry.movement.path.startsWith(`${root}/stock_movements/`) ||
        entry.movement.path.slice(`${root}/stock_movements/`.length).includes('/') ||
        !movement ||
        movement.type !== 'void' ||
        movement.relatedSaleId !== saleId ||
        movement.shopId !== shopId ||
        entry.path !== `${root}/items/${movement.itemId}` ||
        entry.movement.path !== `${root}/stock_movements/${movement.id}` ||
        !Number.isSafeInteger(entry.delta) ||
        entry.delta <= 0 ||
        entry.setTo !== undefined
      )
        return null;
      expected.add(entry.path);
      expected.add(entry.movement.path);
    }
    if (expected.size !== writes.length || paths.some((path) => !expected.has(path))) return null;
    return {
      kind: 'void',
      action,
      customerPath: credit.path,
      salePath: saleWrite.path,
      saleId,
      amountNgwee,
      stockAdjustments: stock,
    };
  } catch {
    return null;
  }
}
