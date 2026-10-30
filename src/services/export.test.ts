import { describe, expect, it } from 'vitest';
import { csvCell, ledgerCsv } from './export';

describe('spreadsheet exports', () => {
  it('quotes separators and neutralizes formula-like user text without corrupting numeric negatives', () => {
    expect(csvCell('=CMD("bad")')).toBe('"\'=CMD(""bad"")"');
    expect(csvCell('  +SUM(A1)')).toBe('"\'  +SUM(A1)"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(-2)).toBe('"-2"');
  });
  it('exports a useful header even for an empty ledger', () => {
    const csv = ledgerCsv('credit', {
      items: [],
      sales: [],
      customers: [],
      creditPayments: [],
      stockMovements: [],
    });
    expect(csv).toContain('"Customer"');
    expect(csv).toContain('"Payment method"');
  });
});
