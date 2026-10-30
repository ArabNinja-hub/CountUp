import { describe, expect, it } from 'vitest';
import { PendingSyncAction } from '../utils/sync';
import { reviewableAction, voidActionSaleId } from './syncReview';

const root = 'shops/shop-1';
const customer = `${root}/customers/customer-1`;
const payment = `${root}/credit_payments/pay-1`;
const sale = `${root}/sales/sale-1`;
const item = `${root}/items/item-1`;
const movement = `${root}/stock_movements/move-1`;
const now = '2026-10-30T09:00:00.000Z';

const paymentAction: PendingSyncAction = {
  id: 'q1',
  type: 'payment',
  path: payment,
  timestamp: Date.now(),
  data: {
    id: 'pay-1',
    shopId: 'shop-1',
    customerId: 'customer-1',
    customerName: 'Mwamba',
    amount: 8,
    createdAt: now,
  },
  writes: [
    {
      path: payment,
      data: {
        id: 'pay-1',
        shopId: 'shop-1',
        customerId: 'customer-1',
        customerName: 'Mwamba',
        amount: 8,
        createdAt: now,
      },
    },
    { path: customer, data: { id: 'customer-1', totalOwed: 2 } },
  ],
  adjustments: [{ kind: 'credit', path: customer, deltaNgwee: -800, updatedAt: now }],
};
const voidAction: PendingSyncAction = {
  id: 'q2',
  type: 'sale',
  path: sale,
  data: { isDeleted: true },
  timestamp: Date.now(),
  writes: [
    { path: sale, data: { isDeleted: true } },
    { path: item, data: { id: 'item-1', quantity: 10 } },
    { path: movement, data: { id: 'move-1' } },
    { path: customer, data: { id: 'customer-1', totalOwed: 0 } },
  ],
  adjustments: [
    {
      kind: 'stock',
      path: item,
      delta: 2,
      updatedAt: now,
      movement: {
        path: movement,
        data: {
          id: 'move-1',
          shopId: 'shop-1',
          itemId: 'item-1',
          itemName: 'Tea',
          type: 'void',
          delta: 2,
          previousQuantity: 8,
          newQuantity: 10,
          reason: 'Undo',
          relatedSaleId: 'sale-1',
          createdAt: now,
        },
      },
    },
    { kind: 'credit', path: customer, deltaNgwee: -1000, updatedAt: now },
  ],
};

describe('reviewable sync operations', () => {
  it('accepts the complete payment or void structure created by CountUp', () => {
    expect(reviewableAction(paymentAction, 'shop-1')).toMatchObject({
      kind: 'payment',
      amountNgwee: 800,
    });
    expect(reviewableAction(voidAction, 'shop-1')).toMatchObject({
      kind: 'void',
      amountNgwee: 1000,
    });
    expect(voidActionSaleId(voidAction, 'shop-1')).toBe('sale-1');
  });

  it('rejects foreign paths, mismatched amounts, unexpected writes and invalid IDs', () => {
    expect(reviewableAction(paymentAction, 'other-shop')).toBeNull();
    expect(reviewableAction({ ...paymentAction, id: 'invalid/path' }, 'shop-1')).toBeNull();
    expect(reviewableAction({ ...paymentAction, path: customer }, 'shop-1')).toBeNull();
    expect(
      reviewableAction(
        {
          ...paymentAction,
          adjustments: [{ kind: 'credit', path: customer, deltaNgwee: -700, updatedAt: now }],
        },
        'shop-1'
      )
    ).toBeNull();
    expect(
      reviewableAction(
        {
          ...paymentAction,
          writes: [...paymentAction.writes!, { path: `${root}/expenses/e`, data: { amount: 1 } }],
        },
        'shop-1'
      )
    ).toBeNull();
    const malformed = {
      ...voidAction,
      writes: [...voidAction.writes!, { path: `${root}/expenses/e`, data: { amount: 1 } }],
    };
    expect(reviewableAction(malformed, 'shop-1')).toBeNull();
    expect(voidActionSaleId(malformed, 'shop-1')).toBeNull();
  });

  it('does not treat an unrelated stock adjustment as a duplicate sale undo', () => {
    const [stock, credit] = voidAction.adjustments!;
    if (stock.kind !== 'stock') throw new Error('Expected stock');
    const malformed = {
      ...voidAction,
      adjustments: [{ ...stock, path: `${root}/items/another-item` }, credit],
    };
    expect(voidActionSaleId(malformed, 'shop-1')).toBeNull();
    expect(reviewableAction(malformed, 'shop-1')).toBeNull();
  });
});
