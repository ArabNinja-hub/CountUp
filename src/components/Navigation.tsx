import React from 'react';
import { useShop } from '../context/ShopContext';
import { ShoppingBag, Boxes, BookUser, BarChart3 } from 'lucide-react';
import { ActiveTab } from '../types';

export const Navigation: React.FC = () => {
  const { activeTab, setActiveTab, t, items, customers } = useShop();

  // Low stock counter
  const lowStockCount = items.filter((i) => i.quantity <= i.lowStockThreshold).length;

  // Customers with outstanding credit
  const debtCustomerCount = customers.filter((c) => c.totalOwed > 0).length;

  const tabs: {
    id: ActiveTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    {
      id: 'sell',
      label: t.tabSell,
      icon: ShoppingBag,
    },
    {
      id: 'stock',
      label: t.tabStock,
      icon: Boxes,
      badge: lowStockCount > 0 ? lowStockCount : undefined,
    },
    {
      id: 'credit',
      label: t.tabCredit,
      icon: BookUser,
      badge: debtCustomerCount > 0 ? debtCustomerCount : undefined,
    },
    {
      id: 'reports',
      label: t.tabReports,
      icon: BarChart3,
    },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200/80 shadow-[0_-8px_30px_rgba(16,185,129,0.10)] pb-[env(safe-area-inset-bottom)]">
      <div className="grid grid-cols-4 h-[68px] max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center pt-1 transition-colors ${
                isActive
                  ? 'text-emerald-700 font-bold'
                  : 'text-slate-500 hover:text-slate-800 font-semibold'
              }`}
            >
              <div className="relative">
                <div
                  className={`w-11 h-8 rounded-xl flex items-center justify-center transition-all ${
                    isActive
                      ? 'bg-emerald-100 text-emerald-800 shadow-sm ring-1 ring-emerald-200/70'
                      : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>

                {/* Badge indicator */}
                {tab.badge !== undefined && (
                  <span className="absolute -top-1 -right-1 bg-amber-600 text-white text-[10px] font-bold rounded-full h-4 min-w-[16px] px-1 flex items-center justify-center border-2 border-white shadow-xs">
                    {tab.badge}
                  </span>
                )}
              </div>

              <span className="text-[11px] mt-1 tracking-tight leading-none">{tab.label}</span>

              {/* Active Tab Indicator */}
              {isActive && (
                <div className="absolute top-0 w-8 h-0.5 bg-emerald-700 rounded-b-full" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
