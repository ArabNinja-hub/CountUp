import React from 'react';
import { useShop } from '../context/ShopContext';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  BarChart3,
  BookOpen,
  BookUser,
  Clock3,
  Plus,
  ShoppingBag,
  Smartphone,
} from 'lucide-react';
import { CreditPayment, Sale } from '../types';
import { summarizeLedger } from '../utils/ledger';
import { addKwacha, localDateKey } from '../utils/money';
import { formatKwacha, formatWhen } from '../utils/format';

/** Practical shop overview built from the live ledger and inventory records. */
export const HomeScreen: React.FC<{ onAddProduct: () => void; onOpenHelp: () => void }> = ({
  onAddProduct,
  onOpenHelp,
}) => {
  const {
    shop,
    sales,
    creditPayments,
    customers,
    items,
    setActiveTab,
    isOnline,
    pendingSyncCount,
    stockConflicts,
  } = useShop();
  const today = localDateKey();
  const todaySales = sales.filter(
    (sale) => (sale.localDate || localDateKey(new Date(sale.createdAt))) === today
  );
  const todayPayments = creditPayments.filter(
    (payment) => (payment.localDate || localDateKey(new Date(payment.createdAt))) === today
  );
  const totals = summarizeLedger(todaySales, todayPayments, customers);
  const low = items
    .filter((item) => item.quantity <= item.lowStockThreshold)
    .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));
  const conflicts = stockConflicts.filter((conflict) => !conflict.resolved);
  const owingCustomers = customers.filter((customer) => customer.totalOwed > 0).length;
  const latestActivity = [
    ...sales.map((record) => ({ kind: 'sale' as const, record })),
    ...creditPayments.map((record) => ({ kind: 'payment' as const, record })),
  ]
    .sort((a, b) => new Date(b.record.createdAt).getTime() - new Date(a.record.createdAt).getTime())
    .slice(0, 5);
  const hasKnownProfit = totals.sales > 0 && totals.missingCostRevenue < totals.sales;

  const actions = [
    { label: 'Record a sale', icon: ShoppingBag, run: () => setActiveTab('sell'), primary: true },
    { label: 'Add a product', icon: Plus, run: onAddProduct },
    { label: 'View credit', icon: BookUser, run: () => setActiveTab('credit') },
    { label: 'View reports', icon: BarChart3, run: () => setActiveTab('reports') },
  ];

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-slate-200 pb-5">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
            Welcome, {shop?.name || 'back'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
        <div
          className={`flex min-h-9 items-center gap-2 border-l-2 pl-3 text-sm ${
            !isOnline
              ? 'border-amber-500 text-amber-900'
              : pendingSyncCount
                ? 'border-sky-600 text-sky-900'
                : 'border-emerald-700 text-slate-600'
          }`}
          aria-live="polite"
        >
          <span className="font-medium">
            {!isOnline
              ? 'Offline'
              : pendingSyncCount
                ? `${pendingSyncCount} waiting to sync`
                : 'All changes synced'}
          </span>
        </div>
      </header>

      {conflicts.length > 0 && (
        <button
          onClick={() => setActiveTab('stock')}
          className="flex min-h-11 w-full items-center gap-2 border-y border-amber-200 bg-amber-50/70 px-3 text-left text-sm text-amber-950"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-800" />
          <span className="flex-1">
            {conflicts.length} stock {conflicts.length === 1 ? 'item needs' : 'items need'} a
            recount after syncing.
          </span>
          <span className="font-semibold">Review stock</span>
          <ArrowRight className="h-4 w-4 shrink-0" />
        </button>
      )}

      {items.length === 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 border border-emerald-200 bg-emerald-50/60 px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Add your first product</h2>
            <p className="mt-0.5 text-sm text-slate-600">Your stock list is ready when you are.</p>
          </div>
          <button
            onClick={onAddProduct}
            className="flex min-h-11 items-center gap-2 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white hover:bg-emerald-900"
          >
            <Plus className="h-4 w-4" /> Add product
          </button>
        </section>
      )}

      <section aria-labelledby="home-summary-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="home-summary-title" className="text-base font-semibold text-slate-950">
              Today
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {todaySales.length} {todaySales.length === 1 ? 'sale' : 'sales'} recorded
            </p>
          </div>
          <button
            onClick={() => setActiveTab('reports')}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-emerald-800 hover:text-emerald-950"
          >
            Open report <ArrowRight className="h-4 w-4" />
          </button>
        </div>
        <div className="border-y border-slate-200 py-4 sm:flex sm:items-center sm:gap-8">
          <div className="min-w-0 flex-1 pb-4 sm:border-r sm:border-slate-200 sm:pb-0 sm:pr-8">
            <p className="text-sm font-medium text-slate-600">Sales</p>
            <p className="mt-1 break-words text-3xl font-semibold tracking-tight tabular-nums text-slate-950">
              {formatKwacha(totals.sales)}
            </p>
            <p className="mt-1 text-sm text-slate-500">Today’s recorded sales</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:flex sm:flex-1 sm:justify-between sm:gap-4">
            <div>
              <dt className="text-xs font-medium text-slate-500">Money received</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                {formatKwacha(totals.moneyReceived)}
              </dd>
              <div className="mt-1 space-y-0.5 text-xs leading-4 text-slate-500">
                <p>
                  Cash {formatKwacha(totals.cashReceived)} · MoMo{' '}
                  {formatKwacha(totals.momoReceived)}
                </p>
                <p>
                  Credit sales {formatKwacha(totals.creditSales)} · Repayments{' '}
                  {formatKwacha(addKwacha(totals.cashRepayments, totals.momoRepayments))}
                </p>
              </div>
            </div>
            <div>
              <dt>
                <button
                  className="text-left text-xs font-medium text-slate-500 hover:text-emerald-800"
                  onClick={() => setActiveTab('credit')}
                >
                  Credit outstanding
                </button>
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-amber-900">
                {formatKwacha(totals.outstanding)}
              </dd>
              <p className="mt-0.5 text-xs text-slate-500">
                {owingCustomers} {owingCustomers === 1 ? 'customer' : 'customers'} owing
              </p>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Gross profit</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                {totals.sales === 0 || hasKnownProfit ? formatKwacha(totals.profit) : '—'}
              </dd>
              <p className="mt-0.5 text-xs text-slate-500">
                {hasKnownProfit
                  ? totals.missingCostRevenue > 0
                    ? 'Partial · some costs unknown'
                    : 'Before expenses'
                  : totals.sales > 0
                    ? 'Add buying prices to calculate'
                    : 'No sales yet'}
              </p>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="home-actions-title">
        <div className="mb-2">
          <h2 id="home-actions-title" className="text-base font-semibold text-slate-950">
            Quick actions
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:flex sm:flex-wrap sm:gap-2">
          {actions.map(({ label, icon: Icon, run, primary }) => (
            <button
              key={label}
              onClick={run}
              className={`flex min-h-11 items-center justify-start gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors sm:justify-center ${
                primary
                  ? 'bg-emerald-800 text-white hover:bg-emerald-900'
                  : 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-7 border-t border-slate-200 pt-5 lg:grid-cols-2 lg:gap-10">
        <section aria-labelledby="low-stock-title">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2
              id="low-stock-title"
              className="flex items-center gap-2 text-base font-semibold text-slate-950"
            >
              Low stock <span className="text-sm font-medium text-slate-500">{low.length}</span>
            </h2>
            <button
              onClick={() => setActiveTab('stock')}
              className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-emerald-800"
            >
              View stock <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {low.length === 0 ? (
            <p className="py-3 text-sm text-slate-500">No items are running low.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {low.slice(0, 5).map((item) => (
                <li
                  key={item.id}
                  className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate font-medium text-slate-800">
                    {item.name}
                    {item.unitLabel ? ` · ${item.unitLabel}` : ''}
                  </span>
                  <span className="shrink-0 font-semibold text-amber-800">
                    {item.quantity} left
                  </span>
                </li>
              ))}
            </ul>
          )}
          {low.length > 5 && (
            <p className="mt-2 text-xs text-slate-500">And {low.length - 5} more in Stock.</p>
          )}
        </section>

        <section aria-labelledby="recent-sales-title">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2
              id="recent-sales-title"
              className="flex items-center gap-2 text-base font-semibold text-slate-950"
            >
              <Clock3 className="h-4 w-4 text-slate-500" /> Recent transactions
            </h2>
            <button
              onClick={() => setActiveTab('reports')}
              className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-emerald-800"
            >
              All reports <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {latestActivity.length === 0 ? (
            <p className="py-3 text-sm text-slate-500">Sales and repayments will appear here.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {latestActivity.map((activity) => (
                <RecentActivity
                  key={`${activity.kind}-${activity.record.id}`}
                  activity={activity}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <button
        onClick={onOpenHelp}
        className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-emerald-800 hover:text-emerald-950"
      >
        <BookOpen className="h-4 w-4" /> Need a hand? Open the guide{' '}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
};

type RecentActivityEntry =
  { kind: 'sale'; record: Sale } | { kind: 'payment'; record: CreditPayment };

const RecentActivity: React.FC<{ activity: RecentActivityEntry }> = ({ activity }) => {
  const isPayment = activity.kind === 'payment';
  const mode = isPayment
    ? `Repayment · ${activity.record.paymentMethod === 'momo' ? 'Mobile Money' : 'Cash'}`
    : activity.record.paymentType === 'momo'
      ? 'Mobile Money sale'
      : activity.record.paymentType === 'credit'
        ? 'Credit sale'
        : 'Cash sale';
  const Icon = isPayment
    ? activity.record.paymentMethod === 'momo'
      ? Smartphone
      : Banknote
    : activity.record.paymentType === 'momo'
      ? Smartphone
      : activity.record.paymentType === 'credit'
        ? BookUser
        : Banknote;
  const name = isPayment
    ? activity.record.customerName
    : activity.record.customerName ||
      `${activity.record.itemsCount} ${activity.record.itemsCount === 1 ? 'item' : 'items'}`;
  const amount = isPayment ? activity.record.amount : activity.record.totalAmount;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-slate-500">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">{name}</p>
        <p className="truncate text-xs text-slate-500">
          {mode} · {formatWhen(activity.record.createdAt)}
        </p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
        {formatKwacha(amount)}
      </span>
    </li>
  );
};
