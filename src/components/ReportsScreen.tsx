import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  TrendingUp,
  Receipt,
  Download,
  Share2,
  ShoppingBag,
  Trash2,
  ArrowUpRight,
  Plus,
  Banknote,
  Smartphone,
  Activity,
} from 'lucide-react';
import { ExpensesModal } from './ExpensesModal';
import { TrendChart, TrendPoint } from './TrendChart';
import { Expense, Sale } from '../types';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { formatKwacha, formatKwachaCompact, formatWhen, isToday } from '../utils/format';
import {
  dailyLedger,
  isInReportPeriod,
  reportPeriodBounds,
  summarizeLedger,
} from '../utils/ledger';
import { addKwacha } from '../utils/money';

export const ReportsScreen: React.FC = () => {
  const {
    sales,
    creditPayments,
    expenses,
    deleteExpense,
    restoreExpense,
    voidSale,
    t,
    shop,
    items,
  } = useShop();
  const { notify } = useToast();

  const [timeView, setTimeView] = useState<'day' | 'week' | 'month'>('day');
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null);
  const [isDeletingExpense, setIsDeletingExpense] = useState(false);
  const [saleToVoid, setSaleToVoid] = useState<Sale | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);

  // Filter window based on timeView
  const { filteredSales, filteredPayments, filteredExpenses } = useMemo(() => {
    const bounds = reportPeriodBounds(timeView);
    const fSales = sales.filter((s) => isInReportPeriod(s.createdAt, s.localDate, bounds));
    const fPayments = creditPayments.filter((p) =>
      isInReportPeriod(p.createdAt, p.localDate, bounds)
    );
    const fExpenses = expenses.filter((e) => isInReportPeriod(e.createdAt, undefined, bounds));

    return {
      filteredSales: fSales,
      filteredPayments: fPayments,
      filteredExpenses: fExpenses,
    };
  }, [sales, creditPayments, expenses, timeView]);

  // ShopBook's accounting rules: credit sales are not money received and
  // repayments are not another sale. Older CountUp payments default to cash.
  const ledger = useMemo(
    () => summarizeLedger(filteredSales, filteredPayments, []),
    [filteredSales, filteredPayments]
  );
  const totalSalesAmount = ledger.sales;
  const grossProfit = ledger.profit;
  const totalExpensesAmount = addKwacha(...filteredExpenses.map((expense) => expense.amount));
  const netProfit = addKwacha(grossProfit, -totalExpensesAmount);
  const totalCashInHand = ledger.cashReceived;
  const totalMomoInWallet = ledger.momoReceived;
  const creditSalesGiven = ledger.creditSales;
  const dailyRows = useMemo(
    () => dailyLedger(filteredSales, filteredPayments),
    [filteredSales, filteredPayments]
  );

  // ---- Business Health score -------------------------------------------------
  const health = useMemo(() => {
    const count = filteredSales.length;
    const target = timeView === 'day' ? 10 : timeView === 'week' ? 60 : 250;
    const salesScore = count === 0 ? 0 : Math.min(100, Math.round((count / target) * 100));

    const knownCostRevenue = addKwacha(totalSalesAmount, -ledger.missingCostRevenue);
    const margin = knownCostRevenue > 0 ? grossProfit / knownCostRevenue : 0;
    const profitScore =
      knownCostRevenue === 0 ? 0 : Math.max(0, Math.min(100, Math.round((margin / 0.35) * 100)));

    const creditRatio = totalSalesAmount > 0 ? creditSalesGiven / totalSalesAmount : 0;
    const cashScore =
      totalSalesAmount === 0
        ? 100
        : Math.max(0, Math.min(100, Math.round((1 - creditRatio) * 100)));

    const totalItems = items.length;
    const lowItems = items.filter((i) => i.quantity <= i.lowStockThreshold).length;
    const stockScore =
      totalItems === 0 ? 70 : Math.round(((totalItems - lowItems) / totalItems) * 100);

    const overall = Math.round(
      salesScore * 0.3 + profitScore * 0.25 + cashScore * 0.25 + stockScore * 0.2
    );
    return {
      salesScore,
      profitScore,
      cashScore,
      stockScore,
      overall,
      marginPct: Math.round(margin * 100),
      hasKnownCost: knownCostRevenue > 0,
    };
  }, [
    filteredSales,
    timeView,
    totalSalesAmount,
    grossProfit,
    creditSalesGiven,
    items,
    ledger.missingCostRevenue,
  ]);

  // ---- Trend series (sales & profit over the selected window) ----------------
  const trendData: TrendPoint[] = useMemo(() => {
    if (filteredSales.length === 0) return [];
    const now = new Date();

    if (timeView === 'day') {
      const arr = Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, sales: 0, profit: 0 }));
      filteredSales.forEach((s) => {
        const h = new Date(s.createdAt).getHours();
        arr[h].sales += s.totalAmount;
        arr[h].profit += s.profit;
      });
      return arr.map((p) => ({ ...p, label: `${p.label}:00` }));
    }

    if (timeView === 'week') {
      const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const arr = labels.map((label) => ({ label, sales: 0, profit: 0 }));
      filteredSales.forEach((s) => {
        const d = new Date(s.localDate ? `${s.localDate}T12:00:00` : s.createdAt);
        const idx = (d.getDay() + 6) % 7;
        if (idx >= 0 && idx < 7) {
          arr[idx].sales += s.totalAmount;
          arr[idx].profit += s.profit;
        }
      });
      return arr;
    }

    // Month
    const year = now.getFullYear();
    const month = now.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    const arr = Array.from({ length: days }, (_, i) => ({
      label: `${i + 1}`,
      sales: 0,
      profit: 0,
    }));
    filteredSales.forEach((s) => {
      const d = new Date(s.localDate ? `${s.localDate}T12:00:00` : s.createdAt);
      if (d.getMonth() === month && d.getFullYear() === year) {
        arr[d.getDate() - 1].sales += s.totalAmount;
        arr[d.getDate() - 1].profit += s.profit;
      }
    });
    return arr;
  }, [filteredSales, timeView]);

  // Health rating label + colour
  const healthMeta =
    health.overall >= 70
      ? {
          label: 'Healthy',
          color: 'emerald',
          ring: '#059669',
          text: 'text-emerald-700',
          bg: 'bg-emerald-50',
          bar: 'bg-emerald-500',
        }
      : health.overall >= 40
        ? {
            label: 'Needs Attention',
            color: 'amber',
            ring: '#d97706',
            text: 'text-amber-700',
            bg: 'bg-amber-50',
            bar: 'bg-amber-500',
          }
        : {
            label: 'At Risk',
            color: 'rose',
            ring: '#e11d48',
            text: 'text-rose-700',
            bg: 'bg-rose-50',
            bar: 'bg-rose-500',
          };

  const healthBars = [
    { key: 'sales', label: 'Sales Activity', value: health.salesScore },
    {
      key: 'profit',
      label: health.hasKnownCost
        ? `Profit Margin (${health.marginPct}%${ledger.missingCostRevenue > 0 ? ', known costs' : ''})`
        : totalSalesAmount > 0
          ? 'Profit Margin (costs needed)'
          : 'Profit Margin',
      value: health.profitScore,
    },
    { key: 'cash', label: 'Sales Paid Immediately', value: health.cashScore },
    { key: 'stock', label: 'Stock Health', value: health.stockScore },
  ];

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

  // Export to CSV — exports exactly the period currently on screen (the old
  // version silently exported every sale ever, whatever tab was selected)
  const periodLabel =
    timeView === 'day' ? 'Today' : timeView === 'week' ? 'This Week' : 'This Month';
  // Declared here (before the handlers) so the export/ share functions can use it.

  const handleExportCSV = () => {
    if (filteredSales.length === 0) {
      notify(`No sales to export for ${periodLabel.toLowerCase()}`, {
        kind: 'info',
        detail: 'Record a sale first, or switch to a longer period.',
      });
      return;
    }

    const headers = [
      'Sale ID',
      'Date',
      'Items',
      'Total (K)',
      'Cost (K)',
      'Profit (K)',
      'Payment',
      'Customer',
    ];
    const rows = filteredSales.map((s) => [
      s.id,
      new Date(s.createdAt).toLocaleString(),
      s.items.map((i) => `${i.name} x${i.quantity}`).join(' + '),
      s.totalAmount,
      s.totalCost,
      s.profit,
      s.paymentType,
      s.customerName || 'Walk-in',
    ]);

    // Quote every field so item names containing commas cannot break the columns,
    // and defuse spreadsheet formulas: a customer or item saved as `=CMD(...)`
    // would otherwise be executed when the CSV is opened in Excel.
    const safeCell = (cell: unknown) => {
      const text = String(cell);
      const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${neutralised.replace(/"/g, '""')}"`;
    };
    const csv = [headers, ...rows].map((row) => row.map(safeCell).join(',')).join('\r\n');

    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Countup_${(shop?.name || 'Shop').replace(/\s+/g, '_')}_${timeView}_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notify(`${filteredSales.length} sales exported`, {
      kind: 'success',
      detail: `Saved as a CSV file for ${periodLabel.toLowerCase()}.`,
    });
  };

  // Undo a sale recorded by mistake: puts stock back and clears the credit it created
  const handleVoidSale = async () => {
    if (!saleToVoid) return;
    setIsVoiding(true);
    try {
      const voided = await voidSale(saleToVoid.id);
      notify(`Sale of ${formatKwacha(voided.totalAmount)} undone`, {
        kind: 'success',
        detail: 'The stock is back on the shelf and any credit was removed from the customer.',
      });
      setSaleToVoid(null);
    } catch (err) {
      notify('Could not undo that sale', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
      setSaleToVoid(null);
    } finally {
      setIsVoiding(false);
    }
  };

  const handleRestoreExpense = async (expense: Expense) => {
    try {
      await restoreExpense(expense);
      notify('Expense restored');
    } catch (err) {
      notify('Could not restore the expense', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };
  const handleDeleteExpense = async () => {
    if (!expenseToDelete) return;
    setIsDeletingExpense(true);
    const removed = expenseToDelete;
    try {
      await deleteExpense(removed.id);
      setExpenseToDelete(null);
      notify(`Expense removed — ${formatKwacha(removed.amount)}`, {
        kind: 'info',
        detail: 'Your profit for this period has been recalculated.',
        action: { label: 'Undo', onClick: () => void handleRestoreExpense(removed) },
      });
    } catch (err) {
      setExpenseToDelete(null);
      notify('Could not remove the expense', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setIsDeletingExpense(false);
    }
  };

  // Generate WhatsApp-friendly summary text
  const handleShareSummary = () => {
    const text = `📊 *${shop?.name || 'Shop'} - ${periodLabel} Summary*
💰 Total Sales: ${formatKwacha(totalSalesAmount)}
💵 Cash & MoMo received: ${formatKwacha(totalCashInHand + totalMomoInWallet)}
🤝 Credit given: ${formatKwacha(creditSalesGiven)}
🧾 Expenses: ${formatKwacha(totalExpensesAmount)}
📈 Estimated net profit: ${filteredSales.length > 0 && ledger.missingCostRevenue === ledger.sales ? 'Not available (costs missing)' : formatKwacha(netProfit)}${ledger.missingCostRevenue > 0 ? ` (excludes ${formatKwacha(ledger.missingCostRevenue)} with unknown costs)` : ''}

_Recorded with Countup Zambia_`;

    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2500);
    notify('Summary copied', { kind: 'success', detail: 'Paste it into WhatsApp to share.' });

    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
  };

  return (
    <div className="w-full space-y-4">
      {/* Top Header: Period selector + Export/Share actions */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
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

      {/* Business Health + Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        {/* Health score card */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-1.5">
              <Activity className="w-4 h-4 text-emerald-700" />
              <h3 className="font-bold text-sm text-slate-900">Business Health</h3>
            </div>
            <span
              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${healthMeta.bg} ${healthMeta.text}`}
            >
              {healthMeta.label}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Score ring */}
            <div className="relative shrink-0">
              <svg viewBox="0 0 80 80" className="w-24 h-24 -rotate-90">
                <circle cx="40" cy="40" r="34" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                <circle
                  cx="40"
                  cy="40"
                  r="34"
                  fill="none"
                  stroke={healthMeta.ring}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 34}
                  strokeDashoffset={2 * Math.PI * 34 * (1 - health.overall / 100)}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-black text-slate-900 tabular-nums leading-none">
                  {health.overall}
                </span>
                <span className="text-[10px] text-slate-400 font-semibold">/ 100</span>
              </div>
            </div>

            {/* Breakdown bars */}
            <div className="flex-1 space-y-2 min-w-0">
              {healthBars.map((b) => (
                <div key={b.key}>
                  <div className="flex items-center justify-between text-[11px] mb-0.5">
                    <span className="text-slate-600 font-medium truncate">{b.label}</span>
                    <span className="text-slate-400 tabular-nums ml-2">{b.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        b.value >= 70
                          ? 'bg-emerald-500'
                          : b.value >= 40
                            ? 'bg-amber-500'
                            : 'bg-rose-500'
                      }`}
                      style={{ width: `${b.value}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Trend chart card */}
        <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold text-sm text-slate-900 flex items-center space-x-1.5">
              <TrendingUp className="w-4 h-4 text-emerald-700" />
              <span>Sales &amp; Profit Trend</span>
            </h3>
            <div className="flex items-center space-x-3 text-[11px] text-slate-500">
              <span className="flex items-center space-x-1">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" /> Sales
              </span>
              <span className="flex items-center space-x-1">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Profit
              </span>
            </div>
          </div>
          <TrendChart data={trendData} height={200} />
        </div>
      </div>

      {/* Primary 4-card Metric Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Total Sales */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">{t.totalSales}</span>
            <TrendingUp className="w-4 h-4 text-emerald-700" />
          </div>
          <p className="text-2xl font-black text-slate-900 tracking-tight mt-1 tabular-nums">
            {formatKwacha(totalSalesAmount)}
          </p>
          <span className="text-xs text-slate-500 font-medium">
            {filteredSales.length} {filteredSales.length === 1 ? 'sale logged' : 'sales logged'}
          </span>
        </div>

        {/* Net Profit */}
        <div className="bg-emerald-900 border border-emerald-800 rounded-2xl p-4 shadow-xs text-white">
          <div className="flex items-center justify-between text-emerald-300">
            <span className="text-[11px] font-bold uppercase tracking-wider">
              Estimated net profit
            </span>
            <ArrowUpRight className="w-4 h-4 text-emerald-300" />
          </div>
          <p className="text-2xl font-black text-white tracking-tight mt-1 tabular-nums">
            {filteredSales.length > 0 && ledger.missingCostRevenue === ledger.sales
              ? 'Not available'
              : formatKwacha(netProfit)}
          </p>
          <span className="text-xs text-emerald-200 font-medium">
            {ledger.missingCostRevenue > 0
              ? `${formatKwacha(ledger.missingCostRevenue)} of sales excluded — cost not recorded. `
              : ''}
            After {formatKwachaCompact(totalExpensesAmount)} expenses
          </span>
        </div>

        {/* Cash in Hand */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">Cash received</span>
            <Banknote className="w-4 h-4 text-emerald-700" />
          </div>
          <p className="text-2xl font-black text-emerald-900 tracking-tight mt-1 tabular-nums">
            K{' '}
            {totalCashInHand.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
          <span className="text-xs text-slate-500 font-medium">Sales and repayments recorded</span>
        </div>

        {/* MoMo in Phone */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">
              Mobile Money received
            </span>
            <Smartphone className="w-4 h-4 text-sky-600" />
          </div>
          <p className="text-2xl font-black text-sky-900 tracking-tight mt-1 tabular-nums">
            K{' '}
            {totalMomoInWallet.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
          <span className="text-xs text-slate-500 font-medium">
            Recorded manually; not a wallet balance
          </span>
        </div>
      </div>

      <details className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
        <summary className="cursor-pointer text-sm font-bold text-slate-900">
          Day-by-day totals
        </summary>
        <p className="text-xs text-slate-500 mt-2">
          Sales include credit; money received includes repayments but not credit sales.
        </p>
        {dailyRows.length === 0 ? (
          <p className="text-xs text-slate-500 mt-3">No activity yet.</p>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="w-full min-w-[560px] text-xs text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2">Date</th>
                  <th>Sales</th>
                  <th>Cash received</th>
                  <th>MoMo received</th>
                  <th>Credit given</th>
                </tr>
              </thead>
              <tbody>
                {dailyRows.map((row) => (
                  <tr key={row.date} className="border-b border-slate-100">
                    <td className="py-2 font-semibold">{row.date}</td>
                    <td>{formatKwacha(row.sales)}</td>
                    <td>{formatKwacha(row.cashReceived)}</td>
                    <td>{formatKwacha(row.momoReceived)}</td>
                    <td>{formatKwacha(row.creditSales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      {/* Secondary Row: Credit Given & Expenses summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-amber-50/70 border border-amber-200/90 rounded-2xl p-3.5 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900">
              New Credit Given Out
            </span>
            <p className="text-xl font-black text-amber-950 mt-0.5 tabular-nums">
              K{' '}
              {creditSalesGiven.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
          <span className="text-xs font-semibold text-amber-800">Added to Credit Book</span>
        </div>

        <div className="bg-rose-50/70 border border-rose-200/90 rounded-2xl p-3.5 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-rose-900">
              Recorded Expenses
            </span>
            <p className="text-xl font-black text-rose-950 mt-0.5 tabular-nums">
              K{' '}
              {totalExpensesAmount.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
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

        {/* Sales Ledger Card — every sale in the selected period, reversible today */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <h3 className="font-bold text-sm text-slate-900 flex items-center space-x-1.5">
              <ShoppingBag className="w-4 h-4 text-emerald-700" />
              <span>Sales ledger</span>
            </h3>
            <span className="text-[11px] font-semibold text-slate-500">
              {filteredSales.length} {filteredSales.length === 1 ? 'sale' : 'sales'}
            </span>
          </div>

          {filteredSales.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              No sales recorded in {periodLabel.toLowerCase()}. Record one from the Sell tab.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto pr-1">
              {filteredSales.map((sale) => {
                const canUndo = isToday(sale.createdAt);
                return (
                  <div
                    key={sale.id}
                    className="py-2.5 flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            sale.paymentType === 'cash'
                              ? 'bg-emerald-100 text-emerald-800'
                              : sale.paymentType === 'momo'
                                ? 'bg-sky-100 text-sky-800'
                                : 'bg-amber-100 text-amber-900'
                          }`}
                        >
                          {sale.paymentType === 'cash'
                            ? 'Cash'
                            : sale.paymentType === 'momo'
                              ? `MoMo${sale.momoOperator ? ` · ${sale.momoOperator}` : ''}`
                              : `Credit${sale.customerName ? ` · ${sale.customerName}` : ''}`}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {formatWhen(sale.createdAt)}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 mt-1 truncate">
                        {sale.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}
                      </p>
                      {sale.receiptNumber && (
                        <p className="text-[10px] text-slate-400 break-all">
                          Receipt {sale.receiptNumber}
                        </p>
                      )}
                      {(sale.paymentReference || sale.note) && (
                        <p className="text-[10px] text-slate-500">
                          {[sale.paymentReference, sale.note].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <span className="font-black text-slate-900 tabular-nums block">
                        {formatKwacha(sale.totalAmount)}
                      </span>
                      {canUndo ? (
                        <button
                          onClick={() => setSaleToVoid(sale)}
                          className="text-[10px] font-bold text-slate-400 hover:text-rose-600"
                        >
                          Undo sale
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-300">Past day</span>
                      )}
                    </div>
                  </div>
                );
              })}
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
                    {expense.note && <p className="text-[11px] text-slate-500">{expense.note}</p>}
                    <span className="text-[10px] text-slate-400">
                      {formatWhen(expense.createdAt)}
                    </span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span className="font-black text-rose-800 tabular-nums">
                      -{formatKwacha(expense.amount)}
                    </span>
                    <button
                      onClick={() => setExpenseToDelete(expense)}
                      className="p-1 text-slate-300 hover:text-rose-600 transition-colors"
                      title="Delete expense"
                      aria-label={`Delete ${expense.category} expense`}
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
      <ExpensesModal isOpen={isExpenseModalOpen} onClose={() => setIsExpenseModalOpen(false)} />

      {saleToVoid && (
        <ConfirmDialog
          title={`Undo this ${formatKwacha(saleToVoid.totalAmount)} sale?`}
          description={
            <>
              <p className="text-[11px] text-slate-600">
                {saleToVoid.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}
              </p>
              <p>The stock goes back on the shelf.</p>
              {saleToVoid.paymentType === 'credit' && saleToVoid.customerName && (
                <p>
                  {saleToVoid.customerName}&apos;s credit balance goes down by{' '}
                  {formatKwacha(saleToVoid.totalAmount)}.
                </p>
              )}
              <p className="text-slate-500">The sale disappears from your reports and totals.</p>
            </>
          }
          confirmLabel="Undo sale"
          busy={isVoiding}
          onCancel={() => setSaleToVoid(null)}
          onConfirm={() => void handleVoidSale()}
        />
      )}

      {expenseToDelete && (
        <ConfirmDialog
          title="Delete this expense?"
          description={
            <>
              <p>
                <strong className="capitalize">{expenseToDelete.category.replace('_', ' ')}</strong>{' '}
                — {formatKwacha(expenseToDelete.amount)}
                {expenseToDelete.note ? ` (${expenseToDelete.note})` : ''}
              </p>
              <p className="text-slate-500">
                It will no longer count against your profit. You can undo straight away.
              </p>
            </>
          }
          confirmLabel="Delete expense"
          busy={isDeletingExpense}
          onCancel={() => setExpenseToDelete(null)}
          onConfirm={() => void handleDeleteExpense()}
        />
      )}
    </div>
  );
};
