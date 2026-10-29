import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  PieChart,
  Boxes,
  Users,
  Wallet,
  AlertTriangle,
  TrendingUp,
  MessageSquare,
  Sparkles,
  ArrowRight,
  ShieldAlert,
  CheckCircle2,
  Lock,
  Coins,
  Share2,
  Copy,
  ChevronRight,
  Info,
} from 'lucide-react';

export const CompanyHoldUpGraph: React.FC = () => {
  const { items, customers, sales, creditPayments, expenses, shop, t, setActiveTab } = useShop();

  const [activeSegment, setActiveSegment] = useState<'all' | 'stock' | 'credit' | 'liquid'>('all');
  const [copiedShare, setCopiedShare] = useState(false);

  // 1. Stock / Inventory Hold-Up Calculation (At wholesale buying price)
  const stockStats = useMemo(() => {
    let costHeldUp = 0;
    let retailPotential = 0;
    let totalUnits = 0;

    items.forEach((item) => {
      const qty = Math.max(0, item.quantity);
      costHeldUp += qty * item.buyingPrice;
      retailPotential += qty * item.sellingPrice;
      totalUnits += qty;
    });

    const potentialProfit = retailPotential - costHeldUp;

    // Top stock items holding up the most money (tied-up capital)
    const sortedItems = [...items]
      .map((item) => {
        const qty = Math.max(0, item.quantity);
        const capitalHeld = qty * item.buyingPrice;
        const retailValue = qty * item.sellingPrice;
        return {
          id: item.id,
          name: item.name,
          quantity: qty,
          buyingPrice: item.buyingPrice,
          sellingPrice: item.sellingPrice,
          capitalHeld,
          retailValue,
          profitPotential: retailValue - capitalHeld,
          isLowStock: qty <= item.lowStockThreshold,
        };
      })
      .filter((i) => i.capitalHeld > 0)
      .sort((a, b) => b.capitalHeld - a.capitalHeld);

    return {
      costHeldUp,
      retailPotential,
      potentialProfit,
      totalUnits,
      sortedItems,
    };
  }, [items]);

  // 2. Customer Credit Hold-Up Calculation (Kaloba / Uncollected Debts)
  const creditStats = useMemo(() => {
    const debtors = customers
      .filter((c) => (c.totalOwed || 0) > 0)
      .map((c) => ({
        ...c,
        owed: c.totalOwed || 0,
      }))
      .sort((a, b) => b.owed - a.owed);

    const totalCreditHeldUp = debtors.reduce((sum, d) => sum + d.owed, 0);

    return {
      totalCreditHeldUp,
      debtorsCount: debtors.length,
      debtors,
    };
  }, [customers]);

  // 3. Liquid Funds Calculation (Cash in Hand & Mobile Money)
  const liquidStats = useMemo(() => {
    const cashSales = sales
      .filter((s) => s.paymentType === 'cash')
      .reduce((sum, s) => sum + s.totalAmount, 0);

    const momoSales = sales
      .filter((s) => s.paymentType === 'momo')
      .reduce((sum, s) => sum + s.totalAmount, 0);

    const collectedDebt = creditPayments.reduce((sum, p) => sum + p.amount, 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

    // Liquid funds = all collected cash/momo minus recorded expenses
    // Floor at 0 to avoid negative capital representation
    const rawLiquid = cashSales + momoSales + collectedDebt - totalExpenses;
    const liquidCapital = Math.max(0, rawLiquid);

    const cashShare = Math.max(0, cashSales + collectedDebt - totalExpenses);
    const momoShare = momoSales;

    return {
      liquidCapital,
      cashShare,
      momoShare,
    };
  }, [sales, creditPayments, expenses]);

  // 4. Combined Working Capital & Hold-Up Ratio
  const capitalBreakdown = useMemo(() => {
    const stock = stockStats.costHeldUp;
    const credit = creditStats.totalCreditHeldUp;
    const liquid = liquidStats.liquidCapital;

    const totalTrapped = stock + credit;
    const totalWorkingCapital = totalTrapped + liquid;

    const stockPercent = totalWorkingCapital > 0 ? (stock / totalWorkingCapital) * 100 : 0;
    const creditPercent = totalWorkingCapital > 0 ? (credit / totalWorkingCapital) * 100 : 0;
    const liquidPercent = totalWorkingCapital > 0 ? (liquid / totalWorkingCapital) * 100 : 0;
    const holdUpRatio = totalWorkingCapital > 0 ? (totalTrapped / totalWorkingCapital) * 100 : 0;

    // Health Rating
    let healthStatus: 'healthy' | 'moderate' | 'critical' = 'healthy';
    let healthLabel = 'Healthy Cashflow';
    let healthDesc = 'Your business has ample liquid cash to restock and handle emergencies.';
    let healthColor = 'text-emerald-700 bg-emerald-50 border-emerald-200';

    if (holdUpRatio > 80) {
      healthStatus = 'critical';
      healthLabel = 'High Capital Hold-Up';
      healthDesc = 'Over 80% of your business money is trapped in unsold stock & unpaid credit.';
      healthColor = 'text-rose-700 bg-rose-50 border-rose-200';
    } else if (holdUpRatio > 60) {
      healthStatus = 'moderate';
      healthLabel = 'Moderate Capital Hold-Up';
      healthDesc = 'A large portion of your money is waiting on shelves or with customers.';
      healthColor = 'text-amber-700 bg-amber-50 border-amber-200';
    }

    return {
      stock,
      credit,
      liquid,
      totalTrapped,
      totalWorkingCapital,
      stockPercent,
      creditPercent,
      liquidPercent,
      holdUpRatio,
      healthStatus,
      healthLabel,
      healthDesc,
      healthColor,
    };
  }, [stockStats.costHeldUp, creditStats.totalCreditHeldUp, liquidStats.liquidCapital]);

  // Donut SVG Parameters
  const donutGeometry = useMemo(() => {
    const size = 260;
    const strokeWidth = 32;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    // Compute stroke dash offsets
    const stockDash = (capitalBreakdown.stockPercent / 100) * circumference;
    const creditDash = (capitalBreakdown.creditPercent / 100) * circumference;
    const liquidDash = (capitalBreakdown.liquidPercent / 100) * circumference;

    const stockOffset = 0;
    const creditOffset = -stockDash;
    const liquidOffset = -(stockDash + creditDash);

    return {
      size,
      strokeWidth,
      radius,
      circumference,
      stockDash,
      creditDash,
      liquidDash,
      stockOffset,
      creditOffset,
      liquidOffset,
    };
  }, [capitalBreakdown]);

  // WhatsApp Share Report
  const handleShareHoldUpReport = () => {
    const topStockNames = stockStats.sortedItems
      .slice(0, 3)
      .map((i) => `• ${i.name}: K ${i.capitalHeld.toLocaleString()} (${i.quantity} units)`)
      .join('\n');

    const topDebtors = creditStats.debtors
      .slice(0, 3)
      .map((d) => `• ${d.name}: K ${d.owed.toLocaleString()}`)
      .join('\n');

    const text = `🔒 *${shop?.name || 'My Kiosk'} - Capital Hold-Up Audit*
━━━━━━━━━━━━━━━━━━━━
💰 *Total Working Capital:* K ${capitalBreakdown.totalWorkingCapital.toLocaleString(undefined, { minimumFractionDigits: 2 })}
🚨 *Capital Held Up:* K ${capitalBreakdown.totalTrapped.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${capitalBreakdown.holdUpRatio.toFixed(1)}%)

📦 *Stock Hold-Up (At Cost):* K ${capitalBreakdown.stock.toLocaleString()} (${capitalBreakdown.stockPercent.toFixed(1)}%)
${topStockNames ? `Top stock holding money:\n${topStockNames}\n` : ''}
🤝 *Customer Credit (Kaloba):* K ${capitalBreakdown.credit.toLocaleString()} (${capitalBreakdown.creditPercent.toFixed(1)}%)
${topDebtors ? `Top debtors:\n${topDebtors}\n` : ''}
💵 *Liquid Funds (Cash & MoMo):* K ${capitalBreakdown.liquid.toLocaleString()} (${capitalBreakdown.liquidPercent.toFixed(1)}%)

📈 *Unrealized Gross Profit in Stock:* K ${stockStats.potentialProfit.toLocaleString()}
Status: *${capitalBreakdown.healthLabel}*

_Audited with Countup Zambia (Smart Kiosk POS)_`;

    navigator.clipboard.writeText(text);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2500);

    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
  };

  // WhatsApp Reminder Link for individual customer
  const getWhatsAppReminderUrl = (customerName: string, phone?: string, amount?: number) => {
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
    const formattedPhone = cleanPhone.startsWith('0')
      ? `260${cleanPhone.slice(1)}`
      : cleanPhone.startsWith('26')
      ? cleanPhone
      : `260${cleanPhone}`;

    const text = `Muli bwanji ba ${customerName}. Friendly reminder from ${shop?.name || 'our shop'}: you have an outstanding credit balance of K ${(amount || 0).toLocaleString()}. Kindly make a payment via Cash or Mobile Money when convenient. Zikomo kwambiri!`;

    return `https://wa.me/${formattedPhone}?text=${encodeURIComponent(text)}`;
  };

  return (
    <div className="w-full space-y-6">
      {/* Top Banner: Health Status & 1-Click WhatsApp Share */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <span className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700">
              <PieChart className="w-5 h-5" />
            </span>
            <h2 className="text-lg font-black text-slate-900 tracking-tight">
              {t.holdUpTitle}
            </h2>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${capitalBreakdown.healthColor}`}>
              {capitalBreakdown.healthLabel}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-xl">
            {t.holdUpSubtitle}. {capitalBreakdown.healthDesc}
          </p>
        </div>

        <button
          onClick={handleShareHoldUpReport}
          className="min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 transition-colors flex items-center space-x-2 shrink-0 self-stretch sm:self-auto justify-center"
        >
          <Share2 className="w-4 h-4 text-emerald-400" />
          <span>{copiedShare ? t.copiedToClipboard : 'Share Hold-Up Audit'}</span>
        </button>
      </div>

      {/* Primary Visual Section: Interactive SVG Donut + Key Metric Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left: Donut Chart Visualization */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs flex flex-col items-center justify-center">
          <div className="w-full flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Capital Distribution
            </h3>
            <span className="text-[11px] font-semibold text-slate-400">
              Interactive Ring
            </span>
          </div>

          <div className="relative flex items-center justify-center my-3">
            {/* SVG Donut */}
            <svg
              width={donutGeometry.size}
              height={donutGeometry.size}
              viewBox={`0 0 ${donutGeometry.size} ${donutGeometry.size}`}
              className="transform -rotate-90 origin-center drop-shadow-xs"
            >
              {/* Background circle track */}
              <circle
                cx={donutGeometry.size / 2}
                cy={donutGeometry.size / 2}
                r={donutGeometry.radius}
                fill="transparent"
                stroke="#f1f5f9"
                strokeWidth={donutGeometry.strokeWidth}
              />

              {/* Stock Arc (Indigo) */}
              {capitalBreakdown.stockPercent > 0 && (
                <circle
                  cx={donutGeometry.size / 2}
                  cy={donutGeometry.size / 2}
                  r={donutGeometry.radius}
                  fill="transparent"
                  stroke="#4f46e5"
                  strokeWidth={activeSegment === 'stock' ? donutGeometry.strokeWidth + 4 : donutGeometry.strokeWidth}
                  strokeDasharray={`${donutGeometry.stockDash} ${donutGeometry.circumference}`}
                  strokeDashoffset={donutGeometry.stockOffset}
                  strokeLinecap="round"
                  className="transition-all duration-300 cursor-pointer hover:opacity-90"
                  onClick={() => setActiveSegment(activeSegment === 'stock' ? 'all' : 'stock')}
                />
              )}

              {/* Credit Arc (Amber) */}
              {capitalBreakdown.creditPercent > 0 && (
                <circle
                  cx={donutGeometry.size / 2}
                  cy={donutGeometry.size / 2}
                  r={donutGeometry.radius}
                  fill="transparent"
                  stroke="#f59e0b"
                  strokeWidth={activeSegment === 'credit' ? donutGeometry.strokeWidth + 4 : donutGeometry.strokeWidth}
                  strokeDasharray={`${donutGeometry.creditDash} ${donutGeometry.circumference}`}
                  strokeDashoffset={donutGeometry.creditOffset}
                  strokeLinecap="round"
                  className="transition-all duration-300 cursor-pointer hover:opacity-90"
                  onClick={() => setActiveSegment(activeSegment === 'credit' ? 'all' : 'credit')}
                />
              )}

              {/* Liquid Arc (Emerald) */}
              {capitalBreakdown.liquidPercent > 0 && (
                <circle
                  cx={donutGeometry.size / 2}
                  cy={donutGeometry.size / 2}
                  r={donutGeometry.radius}
                  fill="transparent"
                  stroke="#059669"
                  strokeWidth={activeSegment === 'liquid' ? donutGeometry.strokeWidth + 4 : donutGeometry.strokeWidth}
                  strokeDasharray={`${donutGeometry.liquidDash} ${donutGeometry.circumference}`}
                  strokeDashoffset={donutGeometry.liquidOffset}
                  strokeLinecap="round"
                  className="transition-all duration-300 cursor-pointer hover:opacity-90"
                  onClick={() => setActiveSegment(activeSegment === 'liquid' ? 'all' : 'liquid')}
                />
              )}
            </svg>

            {/* Center Label inside Donut */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-4">
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
                {activeSegment === 'all'
                  ? 'Total Held Up'
                  : activeSegment === 'stock'
                  ? 'Stock Held Up'
                  : activeSegment === 'credit'
                  ? 'Credit Held Up'
                  : 'Liquid Available'}
              </span>
              <p className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight tabular-nums mt-0.5">
                {activeSegment === 'all' && `${capitalBreakdown.holdUpRatio.toFixed(0)}%`}
                {activeSegment === 'stock' && `${capitalBreakdown.stockPercent.toFixed(0)}%`}
                {activeSegment === 'credit' && `${capitalBreakdown.creditPercent.toFixed(0)}%`}
                {activeSegment === 'liquid' && `${capitalBreakdown.liquidPercent.toFixed(0)}%`}
              </p>
              <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                {activeSegment === 'all' && `K ${capitalBreakdown.totalTrapped.toLocaleString()}`}
                {activeSegment === 'stock' && `K ${capitalBreakdown.stock.toLocaleString()}`}
                {activeSegment === 'credit' && `K ${capitalBreakdown.credit.toLocaleString()}`}
                {activeSegment === 'liquid' && `K ${capitalBreakdown.liquid.toLocaleString()}`}
              </span>
            </div>
          </div>

          {/* Interactive Legend Pills */}
          <div className="w-full grid grid-cols-3 gap-2 mt-2 pt-3 border-t border-slate-100">
            <button
              onClick={() => setActiveSegment(activeSegment === 'stock' ? 'all' : 'stock')}
              className={`p-2 rounded-xl text-left border transition-all ${
                activeSegment === 'stock'
                  ? 'bg-indigo-50 border-indigo-300 ring-1 ring-indigo-300'
                  : 'bg-slate-50 border-slate-100 hover:bg-slate-100'
              }`}
            >
              <div className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 shrink-0" />
                <span className="text-[11px] font-bold text-slate-700 truncate">Stock</span>
              </div>
              <p className="text-xs font-black text-indigo-900 mt-1 tabular-nums">
                {capitalBreakdown.stockPercent.toFixed(0)}%
              </p>
            </button>

            <button
              onClick={() => setActiveSegment(activeSegment === 'credit' ? 'all' : 'credit')}
              className={`p-2 rounded-xl text-left border transition-all ${
                activeSegment === 'credit'
                  ? 'bg-amber-50 border-amber-300 ring-1 ring-amber-300'
                  : 'bg-slate-50 border-slate-100 hover:bg-slate-100'
              }`}
            >
              <div className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0" />
                <span className="text-[11px] font-bold text-slate-700 truncate">Credit</span>
              </div>
              <p className="text-xs font-black text-amber-900 mt-1 tabular-nums">
                {capitalBreakdown.creditPercent.toFixed(0)}%
              </p>
            </button>

            <button
              onClick={() => setActiveSegment(activeSegment === 'liquid' ? 'all' : 'liquid')}
              className={`p-2 rounded-xl text-left border transition-all ${
                activeSegment === 'liquid'
                  ? 'bg-emerald-50 border-emerald-300 ring-1 ring-emerald-300'
                  : 'bg-slate-50 border-slate-100 hover:bg-slate-100'
              }`}
            >
              <div className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 shrink-0" />
                <span className="text-[11px] font-bold text-slate-700 truncate">Liquid</span>
              </div>
              <p className="text-xs font-black text-emerald-900 mt-1 tabular-nums">
                {capitalBreakdown.liquidPercent.toFixed(0)}%
              </p>
            </button>
          </div>
        </div>

        {/* Right: Key 4 Metric Hold-Up Cards */}
        <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Card 1: Total Capital Held Up */}
          <div className="bg-slate-900 text-white rounded-2xl p-4.5 shadow-xs border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.totalHeldUp}
                </span>
                <Lock className="w-4 h-4 text-rose-400" />
              </div>
              <p className="text-2xl sm:text-3xl font-black text-white tracking-tight mt-1 tabular-nums">
                K {capitalBreakdown.totalTrapped.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-rose-300 font-semibold mt-1">
                {capitalBreakdown.holdUpRatio.toFixed(1)}% of your business money is non-liquid
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Total Working Capital:</span>
              <span className="font-bold text-white tabular-nums">
                K {capitalBreakdown.totalWorkingCapital.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Card 2: Stock Inventory Hold-Up */}
          <div className="bg-white rounded-2xl p-4.5 shadow-xs border border-slate-200/90 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-indigo-700">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.stockHoldUp}
                </span>
                <Boxes className="w-4 h-4" />
              </div>
              <p className="text-2xl sm:text-3xl font-black text-indigo-950 tracking-tight mt-1 tabular-nums">
                K {capitalBreakdown.stock.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Wholesale money sitting on shelves ({stockStats.totalUnits} items)
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-indigo-900 flex items-center justify-between font-semibold">
              <span>Retail Value:</span>
              <span className="font-black tabular-nums">
                K {stockStats.retailPotential.toLocaleString()} (+K{stockStats.potentialProfit.toLocaleString()})
              </span>
            </div>
          </div>

          {/* Card 3: Customer Credit Hold-Up */}
          <div className="bg-white rounded-2xl p-4.5 shadow-xs border border-slate-200/90 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-amber-700">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.creditHoldUp}
                </span>
                <Users className="w-4 h-4" />
              </div>
              <p className="text-2xl sm:text-3xl font-black text-amber-950 tracking-tight mt-1 tabular-nums">
                K {capitalBreakdown.credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Lent out to {creditStats.debtorsCount} customers (Kaloba)
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">Share of Capital:</span>
              <span className="font-bold text-amber-800 tabular-nums">
                {capitalBreakdown.creditPercent.toFixed(1)}%
              </span>
            </div>
          </div>

          {/* Card 4: Liquid Available Capital */}
          <div className="bg-white rounded-2xl p-4.5 shadow-xs border border-slate-200/90 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-emerald-700">
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t.liquidCapital}
                </span>
                <Wallet className="w-4 h-4" />
              </div>
              <p className="text-2xl sm:text-3xl font-black text-emerald-950 tracking-tight mt-1 tabular-nums">
                K {capitalBreakdown.liquid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Available drawer cash &amp; MoMo for quick restocking
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">Liquidity Share:</span>
              <span className="font-bold text-emerald-800 tabular-nums">
                {capitalBreakdown.liquidPercent.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Ranked Bar Graph Section: Top Stock Items Holding Up Your Money */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-black text-slate-900 flex items-center space-x-2">
              <Boxes className="w-4 h-4 text-indigo-700" />
              <span>{t.topStockHoldingUp}</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Wholesale capital locked in specific inventory lines sitting in your kiosk
            </p>
          </div>
          <button
            onClick={() => setActiveTab('stock')}
            className="text-xs font-bold text-indigo-700 hover:text-indigo-900 flex items-center space-x-1 shrink-0 self-start sm:self-auto"
          >
            <span>Manage Stock</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {stockStats.sortedItems.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No stock inventory logged yet. Add items in the Stock tab.
          </div>
        ) : (
          <div className="space-y-3.5">
            {stockStats.sortedItems.slice(0, 6).map((item, index) => {
              const maxStockHeld = stockStats.sortedItems[0]?.capitalHeld || 1;
              const barWidthPercent = Math.min(100, Math.max(8, (item.capitalHeld / maxStockHeld) * 100));
              const shareOfStock = stockStats.costHeldUp > 0 ? (item.capitalHeld / stockStats.costHeldUp) * 100 : 0;

              return (
                <div key={item.id} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center space-x-2 min-w-0 pr-2">
                      <span className="w-5 h-5 rounded-md bg-slate-100 text-slate-600 font-bold text-[10px] flex items-center justify-center shrink-0">
                        #{index + 1}
                      </span>
                      <span className="font-bold text-slate-900 truncate">
                        {item.name}
                      </span>
                      <span className="text-[11px] text-slate-400 shrink-0">
                        ({item.quantity} in stock @ K{item.buyingPrice})
                      </span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="font-black text-indigo-900 tabular-nums">
                        K {item.capitalHeld.toLocaleString()}
                      </span>
                      <span className="text-[10px] text-slate-400 ml-1.5 tabular-nums">
                        ({shareOfStock.toFixed(1)}%)
                      </span>
                    </div>
                  </div>

                  {/* Horizontal Bar */}
                  <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden flex items-center">
                    <div
                      className="bg-indigo-600 h-full rounded-full transition-all duration-500 ease-out flex items-center justify-end pr-1 text-[9px] text-white font-bold"
                      style={{ width: `${barWidthPercent}%` }}
                    />
                  </div>

                  {/* Mini status footer */}
                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                    <span>
                      Selling price: K{item.sellingPrice} • Retail potential: K{item.retailValue.toLocaleString()}
                    </span>
                    <span className="font-semibold text-emerald-800">
                      +K{item.profitPotential.toLocaleString()} profit when sold
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Two Column Section: Top Debtors Holding Cash & Action Tips */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* Top Debtors Breakdown (Kaloba) */}
        <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-sm font-black text-slate-900 flex items-center space-x-2">
                <Users className="w-4 h-4 text-amber-600" />
                <span>{t.topDebtorsHoldingUp}</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Customers owing you money with direct 1-tap WhatsApp reminders
              </p>
            </div>
            <button
              onClick={() => setActiveTab('credit')}
              className="text-xs font-bold text-amber-700 hover:text-amber-900 flex items-center space-x-1 shrink-0"
            >
              <span>Credit Book</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {creditStats.debtors.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No outstanding credit debt! All customers have cleared their accounts.
            </div>
          ) : (
            <div className="space-y-3">
              {creditStats.debtors.slice(0, 5).map((debtor, index) => {
                const maxOwed = creditStats.debtors[0]?.owed || 1;
                const barWidth = Math.min(100, Math.max(10, (debtor.owed / maxOwed) * 100));
                const shareOfDebt = creditStats.totalCreditHeldUp > 0 ? (debtor.owed / creditStats.totalCreditHeldUp) * 100 : 0;

                return (
                  <div key={debtor.id} className="p-3 rounded-xl bg-slate-50/80 border border-slate-100 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center space-x-2 min-w-0">
                        <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px] flex items-center justify-center shrink-0">
                          {index + 1}
                        </span>
                        <div>
                          <p className="font-bold text-slate-900 truncate">
                            {debtor.name}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            {debtor.phone || 'No phone recorded'}
                          </p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="font-black text-amber-900 tabular-nums">
                          K {debtor.owed.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                        <span className="text-[10px] text-amber-700 font-medium tabular-nums">
                          {shareOfDebt.toFixed(0)}% of total debt
                        </span>
                      </div>
                    </div>

                    {/* Mini Debt Bar */}
                    <div className="w-full bg-slate-200/80 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-amber-500 h-full rounded-full transition-all duration-300"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>

                    {/* 1-Click WhatsApp Reminder button */}
                    <div className="pt-1 flex items-center justify-end">
                      <a
                        href={getWhatsAppReminderUrl(debtor.name, debtor.phone, debtor.owed)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[32px] px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-700 text-white hover:bg-emerald-800 transition-colors inline-flex items-center space-x-1.5"
                      >
                        <MessageSquare className="w-3 h-3" />
                        <span>Send WhatsApp Nudge</span>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Actionable Kiosk Health Advice: How to Free Up Your Money */}
        <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-4">
          <div className="pb-3 border-b border-slate-100">
            <h3 className="text-sm font-black text-slate-900 flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-emerald-700" />
              <span>{t.unlockCapitalTips}</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Personalized steps to turn trapped stock &amp; credit into liquid cash
            </p>
          </div>

          <div className="space-y-3">
            {/* Advice 1: Credit Collection Priority */}
            {creditStats.debtors.length > 0 && (
              <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/70 flex items-start space-x-3">
                <span className="p-1.5 rounded-lg bg-amber-100 text-amber-800 shrink-0 mt-0.5">
                  <Coins className="w-4 h-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-amber-950">
                    Collect from Top {Math.min(3, creditStats.debtors.length)} Debtors
                  </h4>
                  <p className="text-xs text-amber-900/80 mt-0.5">
                    Your top {Math.min(3, creditStats.debtors.length)} customers hold{' '}
                    <span className="font-bold tabular-nums">
                      K{' '}
                      {creditStats.debtors
                        .slice(0, 3)
                        .reduce((s, d) => s + d.owed, 0)
                        .toLocaleString()}
                    </span>{' '}
                    in credit. Collecting just half would immediately inject liquid money into your drawer.
                  </p>
                </div>
              </div>
            )}

            {/* Advice 2: Slow Stock or Concentrated Stock */}
            {stockStats.sortedItems.length > 0 && (
              <div className="p-3.5 rounded-xl bg-indigo-50/70 border border-indigo-200/70 flex items-start space-x-3">
                <span className="p-1.5 rounded-lg bg-indigo-100 text-indigo-800 shrink-0 mt-0.5">
                  <Boxes className="w-4 h-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-indigo-950">
                    Pause Restocking {stockStats.sortedItems[0]?.name}
                  </h4>
                  <p className="text-xs text-indigo-900/80 mt-0.5">
                    This single item holds{' '}
                    <span className="font-bold tabular-nums">
                      K {stockStats.sortedItems[0]?.capitalHeld.toLocaleString()}
                    </span>{' '}
                    ({stockStats.costHeldUp > 0 ? ((stockStats.sortedItems[0]?.capitalHeld / stockStats.costHeldUp) * 100).toFixed(0) : 0}% of all your stock capital). Let this batch sell down before tying up more cash.
                  </p>
                </div>
              </div>
            )}

            {/* Advice 3: Profit Realization Motivation */}
            <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200/70 flex items-start space-x-3">
              <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800 shrink-0 mt-0.5">
                <TrendingUp className="w-4 h-4" />
              </span>
              <div>
                <h4 className="text-xs font-bold text-emerald-950">
                  K {stockStats.potentialProfit.toLocaleString()} in Gross Profit Waiting
                </h4>
                <p className="text-xs text-emerald-900/80 mt-0.5">
                  When you sell off your current inventory, you will unlock{' '}
                  <span className="font-bold tabular-nums">
                    K {stockStats.retailPotential.toLocaleString()}
                  </span>{' '}
                  in total revenue, putting K {stockStats.potentialProfit.toLocaleString()} in pure profit into your business.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
