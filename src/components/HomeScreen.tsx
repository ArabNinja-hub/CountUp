import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  BookUser,
  Boxes,
  Plus,
  ShoppingBag,
} from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { summarizeLedger } from '../utils/ledger';
import { localDateKey } from '../utils/money';
import { formatKwacha } from '../utils/format';

/** Action-first home, with the same ledger totals used in the other tabs. */
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
  const actions = [
    {
      label: 'Record a sale',
      detail: 'Cash, mobile money or credit',
      icon: ShoppingBag,
      run: () => setActiveTab('sell'),
    },
    { label: 'Add a product', detail: 'Name, price and stock', icon: Plus, run: onAddProduct },
    {
      label: 'View credit',
      detail: 'See who owes you',
      icon: BookUser,
      run: () => setActiveTab('credit'),
    },
    {
      label: 'View reports',
      detail: 'Sales and expenses',
      icon: BarChart3,
      run: () => setActiveTab('reports'),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Home</p>
          <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-900">
            Welcome, {shop?.name}
          </h2>
        </div>
        <span className="text-xs font-semibold text-slate-500">
          {!isOnline
            ? 'Offline'
            : pendingSyncCount
              ? `${pendingSyncCount} waiting to sync`
              : 'Up to date'}
        </span>
      </div>

      {conflicts.length > 0 && (
        <button
          onClick={() => setActiveTab('stock')}
          className="flex w-full items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-left text-xs font-semibold text-amber-950"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {conflicts.length} stock {conflicts.length === 1 ? 'item needs' : 'items need'} a recount
          after syncing. Review stock.
        </button>
      )}

      {items.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-emerald-900 p-4 text-white sm:p-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">
              Start here
            </p>
            <h3 className="mt-1 text-lg font-extrabold">Add your first product</h3>
            <p className="mt-1 text-sm text-emerald-100">Add a product before making a sale.</p>
          </div>
          <button
            onClick={onAddProduct}
            className="flex min-h-[44px] items-center gap-2 rounded-xl bg-white px-4 text-sm font-extrabold text-emerald-900 hover:bg-emerald-50"
          >
            <Plus className="h-4 w-4" />
            Add product
          </button>
        </div>
      )}

      <section aria-labelledby="home-actions-title">
        <h3 id="home-actions-title" className="mb-2 text-sm font-extrabold text-slate-900">
          What would you like to do?
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {actions.map(({ label, detail, icon: Icon, run }) => (
            <button
              key={label}
              onClick={run}
              className="flex min-h-[112px] flex-col items-start rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-xs transition-colors hover:border-emerald-400 hover:bg-emerald-50/40 sm:p-4"
            >
              <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-extrabold text-slate-900">{label}</span>
              <span className="mt-0.5 text-xs text-slate-500">{detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="home-summary-title">
        <h3 id="home-summary-title" className="mb-2 text-sm font-extrabold text-slate-900">
          Your shop today
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
          <div className="rounded-2xl bg-emerald-900 p-4 text-white shadow-xs">
            <p className="text-xs font-bold text-emerald-200">Sales today</p>
            <p className="mt-1 break-words text-xl font-black tabular-nums">
              {formatKwacha(totals.sales)}
            </p>
            <p className="mt-1 text-xs text-emerald-200">
              {todaySales.length} {todaySales.length === 1 ? 'sale' : 'sales'}
            </p>
          </div>
          <button
            onClick={() => setActiveTab('credit')}
            className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-xs hover:border-amber-300"
          >
            <p className="text-xs font-bold text-slate-500">Money owed</p>
            <p className="mt-1 break-words text-xl font-black tabular-nums text-amber-900">
              {formatKwacha(totals.outstanding)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {owingCustomers} {owingCustomers === 1 ? 'customer' : 'customers'}
            </p>
          </button>
          <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs sm:col-span-1">
            <p className="text-xs font-bold text-slate-500">Money received today</p>
            <p className="mt-1 break-words text-xl font-black tabular-nums text-slate-900">
              {formatKwacha(totals.moneyReceived)}
            </p>
            <p className="mt-1 text-xs text-slate-500">Cash + Mobile Money, including repayments</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <Boxes className="h-4 w-4 text-amber-700" />
            Low stock
          </h3>
          <button
            onClick={() => setActiveTab('stock')}
            className="min-h-[36px] text-xs font-bold text-emerald-700"
          >
            View stock
          </button>
        </div>
        {low.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No items are running low.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {low.slice(0, 5).map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                <span className="truncate font-semibold text-slate-800">
                  {item.name}
                  {item.unitLabel ? ` · ${item.unitLabel}` : ''}
                </span>
                <span className="shrink-0 text-xs font-bold text-amber-800">
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

      <button
        onClick={onOpenHelp}
        className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left hover:bg-emerald-100"
      >
        <BookOpen className="h-5 w-5 shrink-0 text-emerald-800" />
        <span className="flex-1 text-sm font-bold text-emerald-950">
          Need a hand? Open the guide
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-emerald-700" />
      </button>
    </div>
  );
};
