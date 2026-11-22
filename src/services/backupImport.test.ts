import { describe, expect, it } from 'vitest';
import {
  assertSafeRawJsonNumbers,
  BACKUP_CHUNK_MAX_ROWS,
  buildBackupImportChunks,
  MAX_BACKUP_PRIMARY_RECORDS,
  MAX_BACKUP_TOTAL_RECORDS,
  parseStrictKwachaDecimalToNgwee,
  prepareLegacyBackupImport,
  prepareShopBackupImport,
} from './backupImport';

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

  it('converts Kwacha decimals via exact string/BigInt math and rejects >2 decimals (even raw 12.500), scientific notation, non-numeric, and negatives', () => {
    expect(parseStrictKwachaDecimalToNgwee(12.5, 'price')).toBe(1250);
    expect(parseStrictKwachaDecimalToNgwee('12.50', 'price')).toBe(1250);
    expect(parseStrictKwachaDecimalToNgwee('0.05', 'price')).toBe(5);
    expect(parseStrictKwachaDecimalToNgwee(0, 'cost', { allowZero: true })).toBe(0);

    expect(() => parseStrictKwachaDecimalToNgwee(12.505, 'price')).toThrow(
      /2 decimal places|monetary/i
    );
    expect(() => parseStrictKwachaDecimalToNgwee('12.505', 'price')).toThrow(
      /2 decimal places|monetary/i
    );
    expect(() => parseStrictKwachaDecimalToNgwee('12.500', 'price')).toThrow(
      /2 decimal places|monetary/i
    );
    expect(() => parseStrictKwachaDecimalToNgwee('abc', 'price')).toThrow(/monetary/i);
    expect(() => parseStrictKwachaDecimalToNgwee(-5, 'price')).toThrow(/monetary|negative/i);

    // Raw JSON token check catches trailing-zero 3rd decimal (`12.500`) and scientific notation BEFORE JSON.parse!
    expect(() => assertSafeRawJsonNumbers('{"sellingPrice": 12.500}')).toThrow(/2 decimal places/i);
    expect(() => assertSafeRawJsonNumbers('{"sellingPrice": 1e5}')).toThrow(/scientific notation/i);
  });

  it('prepares countup-backup-v2 with accurate preview totals, synthesized opening stock movements, and strict hostile-input rejection', () => {
    const v2Raw = JSON.stringify({
      format: 'countup-backup-v2',
      version: '2.0',
      exportedAt: at,
      shop: { id: 'old_shop', name: 'Matero Mart' },
      items: [
        {
          id: 'item_oil',
          name: 'Cooking Oil',
          buyingPrice: 30,
          buyingPriceKnown: true,
          sellingPrice: 42.5,
          unitLabel: 'bottle',
          quantity: 6,
          lowStockThreshold: 2,
          isDeleted: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
      archivedItems: [],
      customers: [
        {
          id: 'cust_1',
          name: 'Chanda',
          phone: '+260977001122',
          notes: '',
          totalOwed: 42.5,
          createdAt: at,
          updatedAt: at,
        },
      ],
      sales: [
        {
          id: 'sale_1',
          items: [
            {
              itemId: 'item_oil',
              name: 'Cooking Oil',
              quantity: 1,
              buyingPrice: 30,
              buyingPriceKnown: true,
              sellingPrice: 42.5,
              total: 42.5,
            },
          ],
          itemsCount: 1,
          totalAmount: 42.5,
          totalCost: 30,
          profit: 12.5,
          paymentType: 'credit',
          customerId: 'cust_1',
          receiptNumber: 'CU-01',
          createdAt: at,
        },
      ],
      creditPayments: [],
      expenses: [
        {
          id: 'exp_1',
          category: 'rent',
          amount: 150,
          note: 'Booth fee',
          createdAt: at,
        },
      ],
      stockMovements: [],
    });

    const prepared = prepareShopBackupImport(v2Raw, 'shop_dest');
    expect(prepared.format).toBe('countup-backup-v2');
    expect(prepared.preview).toMatchObject({
      format: 'countup-backup-v2',
      sourceShopName: 'Matero Mart',
      itemsCount: 1,
      salesCount: 1,
      customersCount: 1,
      expensesCount: 1,
      totalStockValueNgwee: 25500, // 6 * 4250 ngwee
      totalOwedNgwee: 4250,
    });
    // Opening + sale movements synthesized so stock reconciles to 6
    expect(prepared.stockMovements.length).toBeGreaterThanOrEqual(1);

    // Reject unknown top-level record types
    expect(() =>
      prepareShopBackupImport(
        JSON.stringify({ format: 'countup-backup-v2', exportedAt: at, items: [], unknownType: [] }),
        'shop_dest'
      )
    ).toThrow(/unknown|unsupported|Invalid backup/i);

    // Reject > 5 MB raw input
    expect(() => prepareShopBackupImport('x'.repeat(5_000_010), 'shop_dest')).toThrow(/5 MB/i);
  });

  it('supports multi-year shop backups up to 50k primary / 200k total rows and builds FK-ordered chunks', () => {
    expect(MAX_BACKUP_PRIMARY_RECORDS).toBe(50_000);
    expect(MAX_BACKUP_TOTAL_RECORDS).toBe(200_000);

    const baseMs = Date.parse('2025-01-01T08:00:00.000Z');
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `it_${i}`,
      name: `Item ${i}`,
      buyingPrice: 10,
      buyingPriceKnown: true,
      sellingPrice: 15,
      unitLabel: 'pack',
      quantity: 500,
      lowStockThreshold: 5,
      createdAt: '2025-01-01T08:00:00.000Z',
    }));

    // 7,500 sales (~10+ sales/day for 2 years) with 2 lines each = 15,000 sale_lines + synthesized movements
    const sales = Array.from({ length: 7_500 }, (_, s) => {
      const itemA = `it_${s % 40}`;
      const itemB = `it_${(s + 1) % 40}`;
      const atIso = new Date(baseMs + s * 60_000).toISOString();
      return {
        id: `sale_${s}`,
        items: [
          {
            itemId: itemA,
            name: `Item ${s % 40}`,
            quantity: 1,
            sellingPrice: 15,
            buyingPrice: 10,
            buyingPriceKnown: true,
            total: 15,
          },
          {
            itemId: itemB,
            name: `Item ${(s + 1) % 40}`,
            quantity: 1,
            sellingPrice: 15,
            buyingPrice: 10,
            buyingPriceKnown: true,
            total: 15,
          },
        ],
        itemsCount: 2,
        totalAmount: 30,
        totalCost: 20,
        profit: 10,
        paymentType: 'cash' as const,
        createdAt: atIso,
      };
    });

    const raw = JSON.stringify({
      format: 'countup-backup-v2',
      exportedAt: '2026-11-20T00:00:00.000Z',
      shop: { name: 'Two-Year Lusaka Store' },
      items,
      sales,
      customers: [],
      creditPayments: [],
      expenses: [],
      stockMovements: [],
    });

    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(5_000_000);

    const prepared = prepareShopBackupImport(raw, 'shop_two_year');
    expect(prepared.preview.salesCount).toBe(7_500);
    expect(prepared.sales.reduce((sum, s) => sum + s.items.length, 0)).toBe(15_000);
    expect(prepared.preview.totalRecordsCount).toBeGreaterThan(22_000);

    const chunks = buildBackupImportChunks(prepared, BACKUP_CHUNK_MAX_ROWS);
    expect(chunks.length).toBeGreaterThan(8);
    for (const chunk of chunks) {
      expect(chunk.records.length).toBeLessThanOrEqual(BACKUP_CHUNK_MAX_ROWS);
    }
    expect(chunks[0]?.section).toBe('items');
    expect(chunks[chunks.length - 1]?.section).toBe('stockMovements');
  });
});
