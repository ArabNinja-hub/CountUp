import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  ShieldCheck,
  Store,
  Users,
  CreditCard,
  AlertTriangle,
  TrendingUp,
  Search,
  CheckCircle,
  Ban,
  CalendarPlus,
  ArrowLeft,
  RefreshCw,
} from 'lucide-react';
import { getSubscriptionInfo, SUBSCRIPTION_PLANS } from '../config/plans';
import { Shop } from '../types';

interface AdminScreenProps {
  onBack: () => void;
}

export const AdminScreen: React.FC<AdminScreenProps> = ({ onBack }) => {
  const { allShops, shop, adminExtendShop, adminToggleDeactivate, user } = useShop();
  const [searchQuery, setSearchQuery] = useState('');
  const [isUpdating, setIsUpdating] = useState<string | null>(null);

  // If allShops is empty in single-user context, ensure current shop is included in view
  const shopList = useMemo(() => {
    let list = [...allShops];
    if (shop && !list.find((s) => s.id === shop.id)) {
      list.push(shop);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.ownerPhone.includes(q) ||
          s.id.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allShops, shop, searchQuery]);

  // Platform Metrics
  const stats = useMemo(() => {
    const total = shopList.length;
    let onTrial = 0;
    let paying = 0;
    let expiringSoon = 0;
    let estimatedMonthlyRevenue = 0;

    shopList.forEach((s) => {
      const sub = getSubscriptionInfo(s.createdAt, s.planExpiryDate, s.planStatus);
      if (sub.status === 'trial') {
        onTrial++;
      } else if (sub.status === 'active') {
        paying++;
        const plan = s.planType && s.planType !== 'trial' ? SUBSCRIPTION_PLANS[s.planType] : null;
        estimatedMonthlyRevenue += plan ? Math.round(plan.monthlyRateKwacha) : 99;
      }

      if (sub.isWarningPeriod || sub.status === 'grace') {
        expiringSoon++;
      }
    });

    return {
      total,
      onTrial,
      paying,
      expiringSoon,
      estimatedMonthlyRevenue,
    };
  }, [shopList]);

  const handleExtend = async (shopId: string, days: number) => {
    setIsUpdating(shopId);
    await adminExtendShop(shopId, days);
    setIsUpdating(null);
  };

  const handleToggleDeactivate = async (shopId: string) => {
    setIsUpdating(shopId);
    await adminToggleDeactivate(shopId);
    setIsUpdating(null);
  };

  return (
    <div className="w-full max-w-5xl mx-auto py-4 px-3 sm:px-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-200">
        <div className="flex items-center space-x-2.5">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-emerald-800" />
              <span>Platform Owner Administration</span>
            </h2>
            <p className="text-xs text-slate-500">
              Admin: <strong className="text-slate-800">Ronisher Bwalya</strong> · <span className="font-mono">ronisherbwalya@gmail.com</span> · <span className="font-mono">+260 96 283 8581</span>
            </p>
          </div>
        </div>

        <button
          onClick={onBack}
          className="text-xs bg-slate-900 hover:bg-slate-950 text-white font-bold px-3 py-1.5 rounded-lg transition-colors"
        >
          Exit Admin
        </button>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Total Shops */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Total Shops
          </span>
          <p className="text-2xl font-black text-slate-900 mt-1 tabular-nums">{stats.total}</p>
          <span className="text-xs text-slate-500">Registered kiosks</span>
        </div>

        {/* Estimated Monthly Revenue */}
        <div className="bg-emerald-900 border border-emerald-800 rounded-2xl p-4 shadow-xs text-white">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
            Est. Monthly Revenue
          </span>
          <p className="text-2xl font-black text-white mt-1 tabular-nums">
            K {stats.estimatedMonthlyRevenue.toLocaleString()}
          </p>
          <span className="text-xs text-emerald-200 font-medium">Paying subscribers</span>
        </div>

        {/* On Trial */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            On Trial
          </span>
          <p className="text-2xl font-black text-sky-700 mt-1 tabular-nums">{stats.onTrial}</p>
          <span className="text-xs text-slate-500">30-day trial period</span>
        </div>

        {/* Expiring Soon */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Expiring &lt;5d / Grace
          </span>
          <p className="text-2xl font-black text-amber-700 mt-1 tabular-nums">{stats.expiringSoon}</p>
          <span className="text-xs text-amber-700 font-semibold">Needs renewal</span>
        </div>
      </div>

      {/* Shops Search */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search kiosks by name, phone or shop ID..."
            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
          />
        </div>
      </div>

      {/* Shops Directory */}
      <div className="space-y-3">
        {shopList.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-xs text-slate-400">
            No shops found matching your search.
          </div>
        ) : (
          shopList.map((s) => {
            const sub = getSubscriptionInfo(s.createdAt, s.planExpiryDate, s.planStatus);
            const isTargetUpdating = isUpdating === s.id;

            return (
              <div
                key={s.id}
                className={`bg-white border rounded-2xl p-4 shadow-xs transition-all ${
                  s.isDeactivated ? 'border-rose-200 bg-rose-50/20 opacity-75' : 'border-slate-200/90'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center space-x-2">
                      <h3 className="font-bold text-base text-slate-900 truncate">
                        {s.name}
                      </h3>
                      {s.isDeactivated && (
                        <span className="text-[10px] font-bold bg-rose-600 text-white px-1.5 py-0.2 rounded-md">
                          Deactivated
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Phone: <strong className="text-slate-800 font-mono">{s.ownerPhone}</strong>
                      <span className="mx-2 text-slate-300">·</span>
                      Shop ID: <span className="font-mono text-[11px] text-slate-400">{s.id}</span>
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Created: {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="text-left sm:text-right shrink-0">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                        sub.status === 'trial'
                          ? 'bg-sky-100 text-sky-800'
                          : sub.status === 'active'
                          ? 'bg-emerald-100 text-emerald-800'
                          : sub.status === 'grace'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {sub.status} ({sub.daysRemaining > 0 ? `${sub.daysRemaining}d` : 'Ended'})
                    </span>
                    <span className="text-xs text-slate-500 font-medium block mt-0.5">
                      {s.planType ? `Plan: ${s.planType}` : 'Trial Plan'}
                    </span>
                  </div>
                </div>

                {/* Admin Actions */}
                <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between space-x-2">
                  <div className="flex items-center space-x-2">
                    <button
                      disabled={isTargetUpdating}
                      onClick={() => handleExtend(s.id, 30)}
                      className="bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs px-3 py-1.5 rounded-lg flex items-center space-x-1.5 active:scale-95 transition-all"
                    >
                      <CalendarPlus className="w-3.5 h-3.5" />
                      <span>+30 Days</span>
                    </button>

                    <button
                      disabled={isTargetUpdating}
                      onClick={() => handleExtend(s.id, 90)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-3 py-1.5 rounded-lg active:scale-95 transition-all"
                    >
                      +90 Days
                    </button>
                  </div>

                  <button
                    disabled={isTargetUpdating}
                    onClick={() => handleToggleDeactivate(s.id)}
                    className={`font-bold text-xs px-3 py-1.5 rounded-lg flex items-center space-x-1.5 border active:scale-95 transition-all ${
                      s.isDeactivated
                        ? 'bg-emerald-800 text-white border-emerald-800'
                        : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                    }`}
                  >
                    {s.isDeactivated ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>Reactivate Shop</span>
                      </>
                    ) : (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        <span>Deactivate</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
