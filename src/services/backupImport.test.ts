import { describe, expect, it } from 'vitest';
import { prepareLegacyBackupImport } from './backupImport';

const at = '2026-10-23T10:00:00.000Z';
function backup() {
  return {
    format: 'shopbook-backup-v1',
    exportedAt: at,
    shopSettings: { shopName: 'Source shop' },
    products: [
      {
        id: 'p1',
        name: 'Sugar',
        unitLabel: '1kg',
        sellingPriceNgwee: 125,
        costPriceNgwee: null,
        stockQty: 8,
        lowStockThreshold: 5,
        isArchived: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'p2',
        name: 'Tea',
        unitLabel: '',
        sellingPriceNgwee: 500,
        costPriceNgwee: 300,
        stockQty: 2,
        lowStockThreshold: 5,
        isArchived: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
    customers: [
      {
        id: 'c1',
        name: 'Mwamba',
        phone: '0977000000',
        notes: 'Near market',
        createdAt: at,
        updatedAt: at,
      },
    ],
    sales: [
      {
        id: 's1',
        operationId: 'op1',
        receiptNumber: 'SB-20261023-001',
        paymentMethod: 'credit',
        paymentReference: null,
        customerId: 'c1',
        customerNameSnapshot: 'Mwamba',
        totalNgwee: 250,
        totalUnits: 2,
        knownCostTotalNgwee: 0,
        knownCostRevenueNgwee: 0,
        missingCostLineCount: 1,
        missingCostRevenueNgwee: 250,
        note: 'Later',
        createdAt: at,
        localDate: '2026-10-23',
      },
    ],
    saleItems: [
      {
        id: 'l1',
        saleId: 's1',
        productId: 'p1',
        productNameAtSale: 'Sugar',
        unitLabelAtSale: '1kg',
        sellingPriceAtSaleNgwee: 125,
        costPriceAtSaleNgwee: null,
        quantity: 2,
        lineTotalNgwee: 250,
        createdAt: at,
      },
    ],
    stockMovements: [
      {
        id: 'm1',
        operationId: 'mop1',
        productId: 'p1',
        productNameSnapshot: 'Sugar',
        type: 'initial',
        deltaQty: 10,
        previousQty: 0,
        newQty: 10,
        reason: 'Initial',
        relatedSaleId: null,
        createdAt: at,
      },
      {
        id: 'm2',
        operationId: 'mop2',
        productId: 'p1',
        productNameSnapshot: 'Sugar',
        type: 'sale',
        deltaQty: -2,
        previousQty: 10,
        newQty: 8,
        reason: 'Sale',
        relatedSaleId: 's1',
        createdAt: at,
      },
    ],
    creditTransactions: [
      {
        id: 't1',
        operationId: 'top1',
        customerId: 'c1',
        customerNameSnapshot: 'Mwamba',
        type: 'credit_sale',
        amountNgwee: 250,
        paymentMethod: null,
        relatedSaleId: 's1',
        note: 'Sale',
        createdAt: at,
        localDate: '2026-10-23',
      },
      {
        id: 't2',
        operationId: 'top2',
        customerId: 'c1',
        customerNameSnapshot: 'Mwamba',
        type: 'repayment',
        amountNgwee: 100,
        paymentMethod: 'mobile_money',
        relatedSaleId: null,
        note: 'MTN',
        createdAt: '2026-10-23T11:00:00.000Z',
        localDate: '2026-10-23',
      },
    ],
  };
}
const convert = (data: unknown) => prepareLegacyBackupImport(JSON.stringify(data), 'shop_dest');

describe('Legacy backup conversion', () => {
  it('preserves receipts, historical prices, missing costs, archives, stock history and transaction-derived balances', () => {
    const result = convert(backup());
    expect(result.sourceShopName).toBe('Source shop');
    expect(result.items[0]).toMatchObject({
      id: 'shopbook_p1',
      shopId: 'shop_dest',
      sellingPrice: 1.25,
      buyingPriceKnown: false,
      unitLabel: '1kg',
      quantity: 8,
    });
    expect(result.items[1]).toMatchObject({ id: 'shopbook_p2', isDeleted: true, buyingPrice: 3 });
    expect(result.sales[0]).toMatchObject({
      id: 'shopbook_s1',
      receiptNumber: 'SB-20261023-001',
      totalAmount: 2.5,
      profit: 0,
      missingCostRevenue: 2.5,
      customerId: 'shopbook_c1',
    });
    expect(result.sales[0].items[0]).toMatchObject({
      itemId: 'shopbook_p1',
      buyingPriceKnown: false,
      sellingPrice: 1.25,
    });
    expect(result.customers[0]).toMatchObject({ totalOwed: 1.5, notes: 'Near market' });
    expect(result.creditPayments[0]).toMatchObject({
      customerId: 'shopbook_c1',
      amount: 1,
      paymentMethod: 'momo',
    });
    expect(result.stockMovements[1]).toMatchObject({
      delta: -2,
      previousQuantity: 10,
      newQuantity: 8,
      relatedSaleId: 'shopbook_s1',
    });
  });
  it('rejects malformed, duplicate or orphaned records before any database write', () => {
    expect(() => prepareLegacyBackupImport('nope', 'shop_dest')).toThrow(/JSON/);
    const duplicate = backup();
    duplicate.products.push({ ...duplicate.products[0] });
    expect(() => convert(duplicate)).toThrow(/duplicate product/i);
    const orphan = backup();
    orphan.saleItems[0].productId = 'missing';
    expect(() => convert(orphan)).toThrow(/missing sale or product/i);
    const path = backup();
    path.products[0].id = '../unsafe';
    expect(() => convert(path)).toThrow(/Invalid backup/);
  });
  it('rejects tampered amounts, credit entries, negative balances and stock history', () => {
    const incorrect = backup();
    incorrect.saleItems[0].lineTotalNgwee = 249;
    expect(() => convert(incorrect)).toThrow(/total/i);
    const missingCredit = backup();
    missingCredit.creditTransactions.shift();
    expect(() => convert(missingCredit)).toThrow(/negative|ledger/i);
    const overpayment = backup();
    overpayment.creditTransactions[1].amountNgwee = 300;
    expect(() => convert(overpayment)).toThrow(/negative/i);
    const wrongStock = backup();
    wrongStock.stockMovements[1].newQty = 9;
    expect(() => convert(wrongStock)).toThrow(/stock movement/i);
  });
  it('preserves clamped stock conflict history rather than discarding a completed sale', () => {
    const data = backup();
    data.stockMovements[1].previousQty = 1;
    data.stockMovements[1].newQty = 0;
    expect(convert(data).stockMovements[1]).toMatchObject({
      delta: -2,
      previousQuantity: 1,
      newQuantity: 0,
    });
  });
});
