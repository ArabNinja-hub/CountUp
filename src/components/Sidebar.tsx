import React from 'react';
import { useShop } from '../context/ShopContext';
import {
  ShoppingBag,
  Boxes,
  BookUser,
  BarChart3,
  Wifi,
  WifiOff,
  CreditCard,
} from 'lucide-react';
import { ActiveTab } from '../types';

interface SidebarProps {
  onOpenPlan: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ onOpenPlan }) => {
  const {
    t,
    activeTab,
    setActiveTab,
    isOnline,
    pendingSyncCount,
    items,
    customers,
    subscription,
  } = useShop();

  const lowStockCount = items.filter(
    (i) => i.quantity <= i.lowStockThreshold
  ).length;
  const debtCustomerCount = customers.filter((c) => c.totalOwed > 0).length;

  const navItems: {
    id: ActiveTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'sell', label: t.tabSell, icon: ShoppingBag },
    { id: 'stock', label: t.tabStock, icon: Boxes, badge: lowStockCount > 0 ? lowStockCount : undefined },
    { id: 'credit', label: t.tabCredit, icon: BookUser, badge: debtCustomerCount > 0 ? debtCustomerCount : undefined },
    { id: 'reports', label: t.tabReports, icon: BarChart3 },
  ];

  const syncLabel = !isOnline
    ? 'Offline — saved locally'
    : pendingSyncCount > 0
    ? `${pendingSyncCount} pending sync`
    : 'Online & synced';

  return (
    <aside className="hidden md:flex md:flex-col md:w-64 lg:w-72 shrink-0 border-r border-slate-200 bg-white sticky top-0 h-screen">
      {/* Brand */}
      <div className="h-16 flex items-center gap-3 px-5 border-b border-slate-100">
        <div className="w-10 h-10 rounded-xl bg-emerald-900 flex items-center justify-center overflow-hidden shrink-0 shadow-sm">
          <img src="/brand/icon.png" alt="Countup" className="w-7 h-7 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="font-black text-slate-900 text-[15px] leading-tight truncate">
            Countup
          </p>
          <p className="text-[11px] text-emerald-700 font-semibold tracking-wide uppercase">
            Kiosk POS
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`group relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                isActive
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-7 bg-emerald-600 rounded-r-full" />
              )}
              <Icon
                className={`w-5 h-5 shrink-0 ${
                  isActive ? 'text-emerald-700' : 'text-slate-400 group-hover:text-slate-500'
                }`}
              />
              <span className="flex-1 text-left truncate">{item.label}</span>
              {item.badge !== undefined && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-950 leading-tight">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer: sync status + plan */}
      <div className="p-3 border-t border-slate-100 space-y-2">
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium ${
            isOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          {isOnline ? (
            <Wifi className="w-4 h-4 shrink-0" />
          ) : (
            <WifiOff className="w-4 h-4 shrink-0" />
          )}
          <span className="truncate">{syncLabel}</span>
        </div>

        <button
          onClick={onOpenPlan}
          className={`w-full min-h-[40px] flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
            subscription.status === 'expired'
              ? 'bg-rose-700 hover:bg-rose-800 text-white'
              : subscription.status === 'grace'
              ? 'bg-amber-600 hover:bg-amber-700 text-white'
              : 'bg-emerald-800 hover:bg-emerald-900 text-white'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>
            {subscription.status === 'trial'
              ? `Renew · ${subscription.daysRemaining}d left`
              : subscription.status === 'active'
              ? 'Manage Plan'
              : 'Renew Plan'}
          </span>
        </button>
      </div>
    </aside>
  );
};
