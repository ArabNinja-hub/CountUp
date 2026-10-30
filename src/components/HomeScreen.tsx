import React from 'react';
import { AlertTriangle, ArrowRight, BookUser, Boxes, Plus, ShoppingBag } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { summarizeLedger } from '../utils/ledger';
import { localDateKey } from '../utils/money';
import { formatKwacha } from '../utils/format';

/** ShopBook's at-a-glance home, using the same CountUp ledger as every other tab. */
export const HomeScreen: React.FC<{ onAddProduct: () => void }> = ({ onAddProduct }) => {
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

  const actions = [
    {
      label: 'Record a sale',
      detail: 'Cash, Mobile Money or credit',
      icon: ShoppingBag,
      run: () => setActiveTab('sell'),
    },
    {
      label: 'Add a product',
      detail: 'Keep your stock book up to date',
      icon: Plus,
      run: onAddProduct,
    },
    {
      label: 'View credit',
      detail: 'See who owes you',
      icon: BookUser,
      run: () => setActiveTab('credit'),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
            Your shop at a glance
          </p>
          <h2 className="text-2xl font-black text-slate-900 mt-1">Welcome, {shop?.name}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {new Date().toLocaleDateString('en-ZM', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        </div>
        <span className="text-xs font-semibold text-slate-600">
          {!isOnline
            ? 'Saved on this phone'
            : pendingSyncCount
              ? `${pendingSyncCount} waiting to sync`
              : 'No entries waiting to sync'}
        </span>
      </div>
      {conflicts.length > 0 && (
        <button
          onClick={() => setActiveTab('stock')}
          className="w-full text-left rounded-2xl border border-amber-300 bg-amber-50 text-amber-950 p-3 text-xs font-semibold flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {conflicts.length} stock {conflicts.length === 1 ? 'item needs' : 'items need'} a recount
          after syncing. Review stock.
        </button>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-emerald-900 text-white rounded-2xl p-4 shadow-xs">
          <p className="text-xs text-emerald-200 font-bold">Sales today</p>
          <p className="text-2xl font-black mt-1 tabular-nums">{formatKwacha(totals.sales)}</p>
          <p className="text-xs text-emerald-200 mt-1">
            {todaySales.length} {todaySales.length === 1 ? 'sale' : 'sales'} recorded
          </p>
        </div>
        <button
          onClick={() => setActiveTab('credit')}
          className="text-left bg-white border border-slate-200 rounded-2xl p-4 shadow-xs"
        >
          <p className="text-xs text-slate-500 font-bold">Money owed</p>
          <p className="text-2xl font-black text-amber-900 mt-1 tabular-nums">
            {formatKwacha(totals.outstanding)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {customers.filter((c) => c.totalOwed > 0).length} customers owe you
          </p>
        </button>
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <p className="text-xs text-slate-500 font-bold">Money received today</p>
          <p className="text-2xl font-black text-slate-900 mt-1 tabular-nums">
            {formatKwacha(totals.moneyReceived)}
          </p>
          <p className="text-xs text-slate-500 mt-1">Cash + Mobile Money, including repayments</p>
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <h3 className="font-extrabold text-sm text-slate-900 mb-2">What would you like to do?</h3>
          <div className="divide-y divide-slate-100">
            {actions.map(({ label, detail, icon: Icon, run }) => (
              <button
                key={label}
                onClick={run}
                className="w-full min-h-[64px] py-2 flex items-center gap-3 text-left hover:bg-slate-50 rounded-lg"
              >
                <span className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-bold text-slate-900">{label}</span>
                  <span className="block text-xs text-slate-500">{detail}</span>
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400" />
              </button>
            ))}
          </div>
        </section>
        <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
              <Boxes className="w-4 h-4 text-amber-700" />
              Low stock
            </h3>
            <button
              onClick={() => setActiveTab('stock')}
              className="text-xs font-bold text-emerald-700"
            >
              View stock
            </button>
          </div>
          {low.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No items are running low.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {low.slice(0, 5).map((item) => (
                <li
                  key={item.id}
                  className="py-2.5 flex items-center justify-between gap-2 text-xs"
                >
                  <span className="font-semibold text-slate-800 truncate">
                    {item.name}
                    {item.unitLabel ? ` · ${item.unitLabel}` : ''}
                  </span>
                  <span className="font-bold text-amber-800 shrink-0">{item.quantity} left</span>
                </li>
              ))}
            </ul>
          )}
          {low.length > 5 && (
            <p className="text-xs text-slate-500 mt-2">And {low.length - 5} more in Stock.</p>
          )}
        </section>
      </div>
    </div>
  );
};
