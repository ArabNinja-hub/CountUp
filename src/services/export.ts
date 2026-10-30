import { CreditPayment, Customer, Item, Sale, StockMovement } from '../types';

/** RFC 4180 quoting plus spreadsheet formula-injection protection for text cells. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function makeCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}
export type ExportKind =
  'products' | 'sales' | 'sale-items' | 'customers' | 'credit' | 'stock-movements';
export interface ExportLedger {
  items: Item[];
  sales: Sale[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  stockMovements: StockMovement[];
}

export function ledgerCsv(kind: ExportKind, ledger: ExportLedger): string {
  switch (kind) {
    case 'products':
      return makeCsv([
        [
          'ID',
          'Product',
          'Unit',
          'Selling price (K)',
          'Cost price (K)',
          'Stock',
          'Low stock threshold',
          'Archived',
        ],
        ...ledger.items.map((i) => [
          i.id,
          i.name,
          i.unitLabel,
          i.sellingPrice,
          i.buyingPriceKnown === false ? '' : i.buyingPrice,
          i.quantity,
          i.lowStockThreshold,
          i.isDeleted ? 'Yes' : 'No',
        ]),
      ]);
    case 'sales':
      return makeCsv([
        [
          'ID',
          'Receipt',
          'Date',
          'Payment',
          'Reference',
          'Customer',
          'Total (K)',
          'Known cost (K)',
          'Estimated profit (K)',
          'Unknown-cost revenue (K)',
          'Note',
        ],
        ...ledger.sales.map((s) => [
          s.id,
          s.receiptNumber,
          s.createdAt,
          s.paymentType,
          s.paymentReference,
          s.customerName,
          s.totalAmount,
          s.totalCost,
          s.profit,
          s.missingCostRevenue ?? 0,
          s.note,
        ]),
      ]);
    case 'sale-items':
      return makeCsv([
        [
          'Sale ID',
          'Receipt',
          'Product ID',
          'Product at sale',
          'Unit',
          'Quantity',
          'Selling price (K)',
          'Cost price (K)',
        ],
        ...ledger.sales.flatMap((sale) =>
          sale.items.map((i) => [
            sale.id,
            sale.receiptNumber,
            i.itemId,
            i.name,
            i.unitLabel,
            i.quantity,
            i.sellingPrice,
            i.buyingPriceKnown === false ? '' : i.buyingPrice,
          ])
        ),
      ]);
    case 'customers':
      return makeCsv([
        ['ID', 'Customer', 'Phone', 'Notes', 'Outstanding (K)'],
        ...ledger.customers.map((c) => [c.id, c.name, c.phone, c.notes, c.totalOwed]),
      ]);
    case 'credit':
      return makeCsv([
        ['ID', 'Date', 'Customer', 'Type', 'Amount (K)', 'Payment method', 'Note'],
        ...ledger.sales
          .filter((s) => s.paymentType === 'credit')
          .map((s) => [
            s.id,
            s.createdAt,
            s.customerName,
            'Credit sale',
            s.totalAmount,
            '',
            s.receiptNumber,
          ]),
        ...ledger.creditPayments.map((p) => [
          p.id,
          p.createdAt,
          p.customerName,
          'Repayment',
          p.amount,
          p.paymentMethod || 'cash',
          p.note,
        ]),
      ]);
    case 'stock-movements':
      return makeCsv([
        ['ID', 'Date', 'Product', 'Type', 'Change', 'Before', 'After', 'Reason', 'Sale ID'],
        ...ledger.stockMovements.map((m) => [
          m.id,
          m.createdAt,
          m.itemName,
          m.type,
          m.delta,
          m.previousQuantity,
          m.newQuantity,
          m.reason,
          m.relatedSaleId,
        ]),
      ]);
  }
}

export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
