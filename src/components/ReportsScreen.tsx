import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  BarChart3,
  TrendingUp,
  Receipt,
  Download,
  Share2,
  Calendar,
  Check,
  ShoppingBag,
  Trash2,
  ArrowUpRight,
  Plus,
  Banknote,
  Smartphone,
  CreditCard,
  Copy,
  PieChart,
  Lock,
  ArrowRight,
} from 'lucide-react';
import { ExpensesModal } from './ExpensesModal';
import { CompanyHoldUpGraph } from './CompanyHoldUpGraph';
import { Expense } from '../types';

export const ReportsScreen: React.FC = () => {
  const { sales, creditPayments, expenses, deleteExpense, t, shop, items, customers } = useShop();

  const [reportSection, setReportSection] = useState<'sales' | 'holdup'>('sales');
  const [timeView, setTimeView] = useState<'day' | 'week' | 'month'>('day');
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  // Filter window based on timeView
  const { filteredSales, filteredPayments, filteredExpenses } = useMemo(() => {
    const now = new Date();
    let startDate: Date;

    if (timeView === 'day') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (timeView === 'week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Start on Monday
      startDate = new Date(now.setDate(diff));
      startDate.setHours(0, 0, 0, 0);
    } else {
      // Month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const startTime = startDate.getTime();

    const fSales = sales.filter((s) => new Date(s.createdAt).getTime() >= startTime);
    const fPayments = creditPayments.filter(
      (p) => new Date(p.createdAt).getTime() >= startTime
    );
    const fExpenses = expenses.filter(
      (e) => new Date(e.createdAt).getTime() >= startTime
    );

    return {
      filteredSales: fSales,
      filteredPayments: fPayments,
      filteredExpenses: fExpenses,
    };
  }, [sales, creditPayments, expenses, timeView]);

  // Calculations
  const totalSalesAmount = useMemo(() => {
    return filteredSales.reduce((sum, s) => sum + s.totalAmount, 0);
  }, [filteredSales]);

  const totalCost = useMemo(() => {
    return filteredSales.reduce((sum, s) => sum + s.totalCost, 0);
  }, [filteredSales]);

  const grossProfit = totalSalesAmount - totalCost;

  const totalExpensesAmount = useMemo(() => {
    return filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  }, [filteredExpenses]);

  // Net Profit = Gross Profit - Expenses
  const netProfit = grossProfit - totalExpensesAmount;

  // Cash Received = Cash Sales + Credit Payments received
  const cashSales = filteredSales
    .filter((s) => s.paymentType === 'cash')
    .reduce((sum, s) => sum + s.totalAmount, 0);

  // Mobile Money (MoMo) Received
  const momoSales = filteredSales
    .filter((s) => s.paymentType === 'momo')
    .reduce((sum, s) => sum + s.totalAmount, 0);

  const paymentsReceived = filteredPayments.reduce((sum, p) => sum + p.amount, 0);
  const totalCashInHand = cashSales + paymentsReceived;
  const totalMomoInWallet = momoSales;

  // Credit Given Out in period
  const creditSalesGiven = filteredSales
    .filter((s) => s.paymentType === 'credit')
    .reduce((sum, s) => sum + s.totalAmount, 0);

  // Top Selling Items
  const topSellingItems = useMemo(() => {
    const map = new Map<string, { name: string; quantity: number; revenue: number }>();

    filteredSales.forEach((sale) => {
      sale.items.forEach((item) => {
        const current = map.get(item.itemId) || {
          name: item.name,
          quantity: 0,
          revenue: 0,
        };
        current.quantity += item.quantity;
        current.revenue += item.sellingPrice * item.quantity;
        map.set(item.itemId, current);
      });
    });

    return Array.from(map.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);
  }, [filteredSales]);

  // Company Hold-Up quick summary
  const holdUpSummary = useMemo(() => {
    const stock = items.reduce((sum, i) => sum + Math.max(0, i.quantity) * i.buyingPrice, 0);
    const credit = customers.reduce((sum, c) => sum + Math.max(0, c.totalOwed || 0), 0);
    return {
      stock,
      credit,
      total: stock + credit,
    };
  }, [items, customers]);

  // Export to CSV
  const handleExportCSV = () => {
    if (sales.length === 0) {
      alert('No sales data available to export.');
      return;
    }

    const headers = ['Sale ID', 'Date', 'Items Count', 'Total (K)', 'Profit (K)', 'Payment Type', 'Customer Name'];
    const rows = sales.map((s) => [
      s.id,
      new Date(s.createdAt).toLocaleString(),
      s.itemsCount,
      s.totalAmount,
      s.profit,
      s.paymentType,
      s.customerName || 'Walk-in Cash',
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute(
      'download',
      `Countup_Sales_${shop?.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Generate WhatsApp-friendly summary text
  const handleShareSummary = () => {
    const periodLabel =
      timeView === 'day' ? 'Today' : timeView === 'week' ? 'This Week' : 'This Month';
    const text = `📊 *${shop?.name || 'Shop'} - ${periodLabel} Summary*
💰 Total Sales: K ${totalSalesAmount.toLocaleString()}
💵 Cash in Hand: K ${totalCashInHand.toLocaleString()}
📱 MoMo in Phone: K ${totalMomoInWallet.toLocaleString()}
🤝 Credit Given: K ${creditSalesGiven.toLocaleString()}
🧾 Expenses: K ${totalExpensesAmount.toLocaleString()}
📈 Net Profit: K ${netProfit.toLocaleString()}

_Recorded with Countup Zambia_`;

    navigator.clipboard.writeText(text);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2500);

    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
  };

  return (
    <div className="w-full space-y-4">
      {/* Primary View Switcher: Sales & Profit vs Capital Hold-Up Graph */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-1.5 shadow-xs flex items-center justify-between gap-2">
        <div className="flex items-center space-x-1.5 w-full sm:w-auto">
          <button
            onClick={() => setReportSection('sales')}
            className={`flex-1 sm:flex-initial min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-2 ${
              reportSection === 'sales'
                ? 'bg-emerald-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>{t.viewSalesTab}</span>
          </button>

          <button
            onClick={() => setReportSection('holdup')}
            className={`flex-1 sm:flex-initial min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-2 ${
              reportSection === 'holdup'
                ? 'bg-indigo-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <PieChart className="w-4 h-4 text-indigo-400" />
            <span>{t.viewHoldUpTab}</span>
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
                reportSection === 'holdup'
                  ? 'bg-indigo-700 text-indigo-100'
                  : 'bg-indigo-50 text-indigo-700'
              }`}
            >
              K {holdUpSummary.total.toLocaleString()}
            </span>
          </button>
        </div>

        {reportSection === 'sales' && (
          <div className="hidden sm:flex items-center space-x-2 pr-2 text-xs text-slate-500 font-medium">
            <span>Shop Performance Overview</span>
          </div>
        )}
      </div>

      {/* Render Active Section */}
      {reportSection === 'holdup' ? (
        <CompanyHoldUpGraph />
      ) : (
        <>
          {/* Quick Capital Hold-Up Discovery Notice in Sales Tab */}
          <div className="bg-linear-to-r from-indigo-950 to-slate-900 text-white rounded-2xl p-3.5 sm:p-4 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border border-indigo-900">
            <div className="flex items-center space-x-3">
              <span className="p-2 rounded-xl bg-indigo-800/80 text-indigo-200 shrink-0">
                <Lock className="w-4 h-4" />
              </span>
              <div>
                <p className="text-xs font-bold text-indigo-200">
                  Where is your business capital held up?
                </p>
                <p className="text-sm font-black text-white mt-0.5">
                  <span className="tabular-nums">K {holdUpSummary.total.toLocaleString()}</span> trapped in stock (K{holdUpSummary.stock.toLocaleString()}) &amp; customer credit (K{holdUpSummary.credit.toLocaleString()})
                </p>
              </div>
            </div>

            <button
              onClick={() => setReportSection('holdup')}
              className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold bg-white text-indigo-950 hover:bg-indigo-50 transition-colors flex items-center space-x-1 shrink-0 self-stretch sm:self-auto justify-center"
            >
              <span>View Hold-Up Graph</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Top Header: Period selector + Export/Share actions */}
          <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {/* Time Tabs */}
            <div className="flex items-center space-x-1 bg-slate-100 p-1 rounded-xl">
              <button
                onClick={() => setTimeView('day')}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  timeView === 'day'
                    ? 'bg-white text-emerald-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.dailyView}
              </button>
              <button
                onClick={() => setTimeView('week')}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  timeView === 'week'
                    ? 'bg-white text-emerald-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.weeklyView}
              </button>
              <button
                onClick={() => setTimeView('month')}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  timeView === 'month'
                    ? 'bg-white text-emerald-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.monthlyView}
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setIsExpenseModalOpen(true)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100 transition-colors flex items-center space-x-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t.addExpense}</span>
              </button>

              <button
                onClick={handleShareSummary}
                className="min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex items-center space-x-1"
                title="Share via WhatsApp"
              >
                <Share2 className="w-3.5 h-3.5 text-emerald-700" />
                <span className="hidden sm:inline">{copiedShare ? 'Copied!' : 'Share'}</span>
              </button>

              <button
                onClick={handleExportCSV}
                className="min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex items-center space-x-1"
                title="Export CSV"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">CSV</span>
              </button>
            </div>
          </div>

          {/* Primary 4-card Metric Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Total Sales */}
            <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.totalSales}
                </span>
                <TrendingUp className="w-4 h-4 text-emerald-700" />
              </div>
              <p className="text-2xl font-black text-slate-900 tracking-tight mt-1 tabular-nums">
                K {totalSalesAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <span className="text-xs text-slate-500 font-medium">
                {filteredSales.length} {filteredSales.length === 1 ? 'sale logged' : 'sales logged'}
              </span>
            </div>

            {/* Net Profit */}
            <div className="bg-emerald-900 border border-emerald-800 rounded-2xl p-4 shadow-xs text-white">
              <div className="flex items-center justify-between text-emerald-300">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.totalProfit} (Net)
                </span>
                <ArrowUpRight className="w-4 h-4 text-emerald-300" />
              </div>
              <p className="text-2xl font-black text-white tracking-tight mt-1 tabular-nums">
                K {netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <span className="text-xs text-emerald-200 font-medium">
                After K {totalExpensesAmount.toLocaleString()} expenses
              </span>
            </div>

            {/* Cash in Hand */}
            <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  Cash in Hand
                </span>
                <Banknote className="w-4 h-4 text-emerald-700" />
              </div>
              <p className="text-2xl font-black text-emerald-900 tracking-tight mt-1 tabular-nums">
                K {totalCashInHand.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <span className="text-xs text-slate-500 font-medium">
                Physical cash in drawer
              </span>
            </div>

            {/* MoMo in Phone */}
            <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  MoMo in Phone
                </span>
                <Smartphone className="w-4 h-4 text-sky-600" />
              </div>
              <p className="text-2xl font-black text-sky-900 tracking-tight mt-1 tabular-nums">
                K {totalMomoInWallet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <span className="text-xs text-slate-500 font-medium">
                Airtel, MTN &amp; Zamtel SIM
              </span>
            </div>
          </div>

          {/* Secondary Row: Credit Given & Expenses summary */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-amber-50/70 border border-amber-200/90 rounded-2xl p-3.5 shadow-xs flex items-center justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900">
                  New Credit Given Out
                </span>
                <p className="text-xl font-black text-amber-950 mt-0.5 tabular-nums">
                  K {creditSalesGiven.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <span className="text-xs font-semibold text-amber-800">
                Added to Credit Book
              </span>
            </div>

            <div className="bg-rose-50/70 border border-rose-200/90 rounded-2xl p-3.5 shadow-xs flex items-center justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-rose-900">
                  Recorded Expenses
                </span>
                <p className="text-xl font-black text-rose-950 mt-0.5 tabular-nums">
                  K {totalExpensesAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <button
                onClick={() => setIsExpenseModalOpen(true)}
                className="text-xs font-bold text-rose-800 hover:text-rose-950 underline"
              >
                + Record Expense
              </button>
            </div>
          </div>

          {/* Responsive 2-column detailed breakdown: Top Selling Items & Expenses List */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {/* Top Selling Items Card */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h3 className="font-bold text-sm text-slate-900 flex items-center space-x-1.5">
                  <ShoppingBag className="w-4 h-4 text-emerald-700" />
                  <span>{t.topSelling}</span>
                </h3>
                <span className="text-xs text-slate-400">By quantity</span>
              </div>

              {topSellingItems.length === 0 ? (
                <p className="text-xs text-slate-400 py-6 text-center">
                  No items sold in this period yet.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {topSellingItems.map((item, idx) => (
                    <div key={item.name} className="py-2.5 flex items-center justify-between text-xs">
                      <div className="flex items-center space-x-2.5 min-w-0 pr-2">
                        <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 font-bold text-[10px] flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <span className="font-bold text-slate-900 truncate">{item.name}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-black text-slate-900 tabular-nums block">
                          {item.quantity} sold
                        </span>
                        <span className="text-[11px] text-emerald-800 font-semibold tabular-nums">
                          K {item.revenue.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Expenses Ledger Card */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <h3 className="font-bold text-sm text-slate-900 flex items-center space-x-1.5">
                  <Receipt className="w-4 h-4 text-rose-600" />
                  <span>Recorded Expenses</span>
                </h3>
                <button
                  onClick={() => setIsExpenseModalOpen(true)}
                  className="text-xs font-bold text-emerald-800 hover:text-emerald-950"
                >
                  + Add
                </button>
              </div>

              {filteredExpenses.length === 0 ? (
                <p className="text-xs text-slate-400 py-6 text-center">
                  No expenses recorded in this period.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto pr-1">
                  {filteredExpenses.map((expense) => (
                    <div key={expense.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold text-slate-900 capitalize">
                          {expense.category.replace('_', ' ')}
                        </span>
                        {expense.note && (
                          <p className="text-[11px] text-slate-500">{expense.note}</p>
                        )}
                        <span className="text-[10px] text-slate-400">
                          {new Date(expense.createdAt).toLocaleDateString()}
                        </span>
                      </div>

                      <div className="flex items-center space-x-2">
                        <span className="font-black text-rose-800 tabular-nums">
                          -K {expense.amount.toFixed(2)}
                        </span>
                        <button
                          onClick={() => void deleteExpense(expense.id)}
                          className="p-1 text-slate-300 hover:text-rose-600 transition-colors"
                          title="Delete expense"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Expenses Modal */}
          <ExpensesModal
            isOpen={isExpenseModalOpen}
            onClose={() => setIsExpenseModalOpen(false)}
          />
        </>
      )}
    </div>
  );
};
