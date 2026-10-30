import { describe, expect, it } from 'vitest';
import { CreditPayment, Customer, Sale } from '../types';
import {
  customerStatement,
  dailyLedger,
  isInReportPeriod,
  reportPeriodBounds,
  summarizeLedger,
} from './ledger';
import { addKwacha, multiplyKwacha, parseKwachaToNgwee, toNgwee } from './money';

const at = '2026-10-23T10:00:00.000Z';
const sale = (id: string, type: Sale['paymentType'], amount: number): Sale => ({
  id,
  shopId: 's',
  items: [{ itemId: 'i', name: 'Sugar', quantity: 1, sellingPrice: amount, buyingPrice: 0 }],
  itemsCount: 1,
  totalAmount: amount,
  totalCost: 0,
  profit: amount,
  paymentType: type,
  customerId: type === 'credit' ? 'c' : undefined,
  createdAt: at,
  localDate: '2026-10-23',
});
const payment = (
  id: string,
  method: CreditPayment['paymentMethod'],
  amount: number
): CreditPayment => ({
  id,
  shopId: 's',
  customerId: 'c',
  customerName: 'Ada',
  amount,
  paymentMethod: method,
  createdAt: '2026-10-23T11:00:00.000Z',
  localDate: '2026-10-23',
});
const customer: Customer = {
  id: 'c',
  shopId: 's',
  name: 'Ada',
  totalOwed: 6,
  createdAt: at,
  updatedAt: at,
};

describe('money and integrated ledger', () => {
  it('calculates in whole ngwee and rejects fractions of a ngwee', () => {
    expect(parseKwachaToNgwee('K1,250.05')).toBe(125005);
    expect(addKwacha(0.1, 0.2)).toBe(0.3);
    expect(multiplyKwacha(1.05, 3)).toBe(3.15);
    expect(() => parseKwachaToNgwee('1.234')).toThrow();
    expect(() => toNgwee(1.001)).toThrow();
  });
  it('counts cash and mobile repayments as money received but not new sales', () => {
    const sales = [sale('a', 'cash', 10), sale('b', 'momo', 20), sale('c', 'credit', 10)];
    const payments = [payment('p1', 'cash', 1), payment('p2', 'momo', 3)];
    expect(summarizeLedger(sales, payments, [customer])).toMatchObject({
      sales: 40,
      cashReceived: 11,
      momoReceived: 23,
      moneyReceived: 34,
      creditSales: 10,
      outstanding: 6,
    });
    expect(dailyLedger(sales, payments)[0]).toMatchObject({
      date: '2026-10-23',
      count: 3,
      sales: 40,
      moneyReceived: 34,
    });
    expect(customerStatement('c', sales, payments).map((entry) => entry.runningBalance)).toEqual([
      6, 9, 10,
    ]);
  });
  it('bounds report periods and respects the recorded business date', () => {
    const now = new Date(2026, 9, 30, 15); // Friday
    const today = reportPeriodBounds('day', now);
    expect(isInReportPeriod(at, '2026-10-30', today)).toBe(true);
    expect(isInReportPeriod(at, '2026-10-31', today)).toBe(false);
    expect(isInReportPeriod(at, '2026-10-29', today)).toBe(false);
    const week = reportPeriodBounds('week', now);
    expect(isInReportPeriod(at, '2026-10-26', week)).toBe(true);
    expect(isInReportPeriod(at, '2026-11-01', week)).toBe(true);
    expect(isInReportPeriod(at, '2026-11-02', week)).toBe(false);
    const month = reportPeriodBounds('month', now);
    expect(isInReportPeriod(at, '2026-10-01', month)).toBe(true);
    expect(isInReportPeriod(at, '2026-11-01', month)).toBe(false);
  });
  it('treats older unlabelled repayments as cash and keeps unknown-cost revenue out of profit', () => {
    const unknown = { ...sale('a', 'cash', 2.5), profit: 0, missingCostRevenue: 2.5 };
    const summary = summarizeLedger([unknown], [payment('p', undefined, 1)], []);
    expect(summary).toMatchObject({ cashReceived: 3.5, profit: 0, missingCostRevenue: 2.5 });
  });
});
