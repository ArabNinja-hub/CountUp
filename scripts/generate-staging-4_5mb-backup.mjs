#!/usr/bin/env node
/**
 * Generates a valid ~4.5 MB multi-year (`countup-backup-v2`) JSON backup file
 * (~14,600 sales, ~21,900 sale lines, ~37,000+ records before synthesized
 * stock movements) for the Pre-Production Staging Timeout Verification step
 * documented in `docs/STAGING_TEST.md` (Step 9 — "Verify on Staging").
 *
 * Usage:
 *   node scripts/generate-staging-4_5mb-backup.mjs [output-path]
 *
 * Default output: `/tmp/countup-staging-4_5mb-backup.json` (outside git working tree).
 */
import fs from 'node:fs';
import path from 'node:path';

const outputPath = path.resolve(process.argv[2] ?? '/tmp/countup-staging-4_5mb-backup.json');
const baseMs = Date.now() - 730 * 24 * 60 * 60 * 1000;
const baseIso = new Date(baseMs).toISOString();

const items = Array.from({ length: 50 }, (_, i) => ({
  id: `item_${i}`,
  name: `Staging Wholesale Item ${i}`,
  buyingPrice: 12,
  buyingPriceKnown: true,
  sellingPrice: 18,
  unitLabel: 'unit',
  quantity: 1_000,
  lowStockThreshold: 5,
  createdAt: baseIso,
}));

const customers = Array.from({ length: 20 }, (_, c) => ({
  id: `cust_${c}`,
  name: `Staging Customer ${c}`,
  phone: `+260966000${String(c).padStart(3, '0')}`,
  totalOwed: 18,
  createdAt: baseIso,
}));

const sales = Array.from({ length: 11_300 }, (_, s) => {
  const isCredit = s < 420;
  const custIdx = s % 20;
  const twoLines = s % 2 === 0 && !isCredit;
  const lines = twoLines
    ? [
        {
          itemId: `item_${s % 50}`,
          name: `Staging Wholesale Item ${s % 50}`,
          unitLabel: 'unit',
          quantity: 1,
          buyingPrice: 12,
          buyingPriceKnown: true,
          sellingPrice: 18,
          total: 18,
        },
        {
          itemId: `item_${(s + 1) % 50}`,
          name: `Staging Wholesale Item ${(s + 1) % 50}`,
          unitLabel: 'unit',
          quantity: 1,
          buyingPrice: 12,
          buyingPriceKnown: true,
          sellingPrice: 18,
          total: 18,
        },
      ]
    : [
        {
          itemId: `item_${s % 50}`,
          name: `Staging Wholesale Item ${s % 50}`,
          unitLabel: 'unit',
          quantity: 1,
          buyingPrice: 12,
          buyingPriceKnown: true,
          sellingPrice: 18,
          total: 18,
        },
      ];

  return {
    id: `sale_${s}`,
    receiptNumber: `STG-${s + 1}`,
    items: lines,
    itemsCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    totalAmount: lines.length * 18,
    totalCost: lines.length * 12,
    profit: lines.length * 6,
    paymentType: isCredit ? 'credit' : 'cash',
    ...(isCredit
      ? { customerId: `cust_${custIdx}`, customerName: `Staging Customer ${custIdx}` }
      : {}),
    createdAt: new Date(baseMs + s * 3_600_000).toISOString(),
  };
});

const creditPayments = Array.from({ length: 400 }, (_, p) => {
  const custIdx = p % 20;
  return {
    id: `cp_${p}`,
    customerId: `cust_${custIdx}`,
    customerName: `Staging Customer ${custIdx}`,
    amount: 18,
    paymentMethod: 'cash',
    createdAt: new Date(baseMs + (500 + p) * 3_600_000).toISOString(),
  };
});

const expenses = Array.from({ length: 300 }, (_, e) => ({
  id: `ex_${e}`,
  category: 'transport',
  amount: 25,
  note: `Market transport trip ${e + 1}`,
  createdAt: new Date(baseMs + e * 86_400_000).toISOString(),
}));

const payload = {
  format: 'countup-backup-v2',
  exportedAt: new Date().toISOString(),
  shop: { name: 'Staging Two-Year Benchmark Kiosk' },
  items,
  sales,
  customers,
  creditPayments,
  expenses,
  stockMovements: [],
};

const json = JSON.stringify(payload);
fs.writeFileSync(outputPath, json, 'utf8');
const bytes = Buffer.byteLength(json, 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`  Size: ${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString()} bytes)`);
console.log(
  `  Records: 50 items, 20 customers, ${sales.length.toLocaleString()} sales, 400 repayments, 300 expenses`
);
