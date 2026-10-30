import { CreditPayment, Customer, Sale } from '../types';
import { fromNgwee, localDateKey, toNgwee } from './money';

/** Calendar periods are bounded on both sides; future records are not today's sales. */
export function reportPeriodBounds(period: 'day' | 'week' | 'month', now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') {
    const day = start.getDay();
    start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  } else if (period === 'month') {
    start.setDate(1);
  }
  const end = new Date(start);
  if (period === 'month') end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (period === 'week' ? 7 : 1));
  return { start: start.getTime(), end: end.getTime() };
}

export function isInReportPeriod(
  createdAt: string,
  localDate: string | undefined,
  bounds: { start: number; end: number }
): boolean {
  const time = new Date(localDate ? `${localDate}T12:00:00` : createdAt).getTime();
  return time >= bounds.start && time < bounds.end;
}

/** Credit sales are not money received; repayments are not new sales. */
export function summarizeLedger(sales: Sale[], payments: CreditPayment[], customers: Customer[]) {
  let cash = 0;
  let momo = 0;
  let credit = 0;
  let profit = 0;
  let missingCostRevenue = 0;
  for (const sale of sales) {
    const amount = toNgwee(sale.totalAmount);
    if (sale.paymentType === 'cash') cash += amount;
    else if (sale.paymentType === 'momo') momo += amount;
    else credit += amount;
    profit += toNgwee(sale.profit);
    missingCostRevenue += toNgwee(sale.missingCostRevenue ?? 0);
  }
  let cashRepayments = 0;
  let momoRepayments = 0;
  for (const payment of payments) {
    if (payment.paymentMethod === 'momo') momoRepayments += toNgwee(payment.amount);
    else cashRepayments += toNgwee(payment.amount); // older CountUp payments were cash
  }
  return {
    sales: fromNgwee(cash + momo + credit),
    cashSales: fromNgwee(cash),
    momoSales: fromNgwee(momo),
    creditSales: fromNgwee(credit),
    cashRepayments: fromNgwee(cashRepayments),
    momoRepayments: fromNgwee(momoRepayments),
    cashReceived: fromNgwee(cash + cashRepayments),
    momoReceived: fromNgwee(momo + momoRepayments),
    moneyReceived: fromNgwee(cash + momo + cashRepayments + momoRepayments),
    outstanding: fromNgwee(customers.reduce((sum, c) => sum + toNgwee(c.totalOwed), 0)),
    profit: fromNgwee(profit),
    missingCostRevenue: fromNgwee(missingCostRevenue),
  };
}

export function dailyLedger(sales: Sale[], payments: CreditPayment[]) {
  const days = new Map<string, { sales: Sale[]; payments: CreditPayment[] }>();
  const forDate = (date: string) => {
    if (!days.has(date)) days.set(date, { sales: [], payments: [] });
    return days.get(date)!;
  };
  for (const sale of sales)
    forDate(sale.localDate || localDateKey(new Date(sale.createdAt))).sales.push(sale);
  for (const payment of payments)
    forDate(payment.localDate || localDateKey(new Date(payment.createdAt))).payments.push(payment);
  return [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, entries]) => ({
      date,
      count: entries.sales.length,
      ...summarizeLedger(entries.sales, entries.payments, []),
    }));
}

export function customerStatement(customerId: string, sales: Sale[], payments: CreditPayment[]) {
  const entries = [
    ...sales
      .filter((sale) => sale.paymentType === 'credit' && sale.customerId === customerId)
      .map((sale) => ({
        id: sale.id,
        type: 'sale' as const,
        date: sale.createdAt,
        amount: sale.totalAmount,
        details: sale.items.map((item) => `${item.name} (x${item.quantity})`).join(', '),
      })),
    ...payments
      .filter((payment) => payment.customerId === customerId)
      .map((payment) => ({
        id: payment.id,
        type: 'payment' as const,
        date: payment.createdAt,
        amount: payment.amount,
        details:
          payment.note ||
          (payment.paymentMethod === 'momo'
            ? 'Mobile Money payment recorded'
            : 'Cash payment received'),
      })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'sale' ? -1 : 1)
  );
  let running = 0;
  return entries
    .map((entry) => {
      running += (entry.type === 'sale' ? 1 : -1) * toNgwee(entry.amount);
      return { ...entry, runningBalance: fromNgwee(running) };
    })
    .reverse();
}
