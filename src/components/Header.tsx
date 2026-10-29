import React, { useState, useRef, useEffect } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Globe,
  Store,
  ShieldAlert,
  LogOut,
  CreditCard,
  UserCheck,
  ShoppingBag,
  Boxes,
  BookUser,
  BarChart3,
  ChevronDown,
  Sparkles,
  Clock,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import { SupportModal } from './SupportModal';
import { Language, ActiveTab } from '../types';

interface HeaderProps {
  onOpenPlan: () => void;
  onOpenAdmin: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPlan, onOpenAdmin }) => {
  const {
    shop,
    t,
    language,
    setLanguage,
    isOnline,
    pendingSyncCount,
    isSyncing,
    syncNow,
    subscription,
    logout,
    isAdmin,
    activeTab,
    setActiveTab,
    items,
    customers,
  } = useShop();

  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showShopMenu, setShowShopMenu] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const shopMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setShowLangMenu(false);
      }
      if (shopMenuRef.current && !shopMenuRef.current.contains(e.target as Node)) {
        setShowShopMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const langNames: Record<Language, { label: string; sub: string }> = {
    en: { label: 'English', sub: 'Default' },
    bem: { label: 'Ichibemba', sub: 'Bemba' },
    nya: { label: 'Chinyanja', sub: 'Nyanja' },
  };

  const lowStockCount = items.filter((i) => i.quantity <= i.lowStockThreshold).length;
  const debtCustomerCount = customers.filter((c) => c.totalOwed > 0).length;

  const navItems: { id: ActiveTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }[] = [
    { id: 'sell', label: t.tabSell, icon: ShoppingBag },
    { id: 'stock', label: t.tabStock, icon: Boxes, badge: lowStockCount > 0 ? lowStockCount : undefined },
    { id: 'credit', label: t.tabCredit, icon: BookUser, badge: debtCustomerCount > 0 ? debtCustomerCount : undefined },
    { id: 'reports', label: t.tabReports, icon: BarChart3 },
  ];

  return (
    <header className="sticky top-0 z-40 bg-emerald-900 border-b border-emerald-800 text-white shadow-sm">
      {/* Main Bar */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        {/* Left: Brand & Shop Info */}
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-emerald-800 border border-emerald-700/80 flex items-center justify-center shrink-0 shadow-xs">
            <Store className="w-5 h-5 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <h1 className="font-bold text-sm sm:text-base text-white tracking-tight truncate">
                {shop?.name || 'Countup'}
              </h1>
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-800/80 text-emerald-200 border border-emerald-700/60 uppercase tracking-wider">
                Kiosk POS
              </span>
            </div>
            <p className="text-[11px] text-emerald-200/90 truncate flex items-center space-x-1.5">
              <span>{shop?.ownerPhone}</span>
              <span className="text-emerald-500">·</span>
              <span className="text-emerald-300 font-medium">ZMW (K)</span>
            </p>
          </div>
        </div>

        {/* Center: Desktop Navigation Tabs (Visible on md+ viewports) */}
        <nav className="hidden md:flex items-center space-x-1 bg-emerald-950/60 p-1 rounded-xl border border-emerald-800/60">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`relative flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-emerald-200 hover:text-white hover:bg-emerald-800/50'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500 text-slate-950 leading-tight">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right: Actions (Sync status, Language, Plan button, Profile Menu) */}
        <div className="flex items-center space-x-2 shrink-0">
          {/* Connectivity / Sync Button */}
          <button
            onClick={() => void syncNow()}
            title={isOnline ? t.onlineSynced : `${t.offlineSaved} (${pendingSyncCount})`}
            className={`flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors border ${
              !isOnline
                ? 'bg-amber-950/80 text-amber-200 border-amber-600/60'
                : pendingSyncCount > 0
                ? 'bg-sky-950/80 text-sky-200 border-sky-600/60'
                : 'bg-emerald-800/60 text-emerald-200 border-emerald-700/60 hover:bg-emerald-800'
            }`}
          >
            {isSyncing ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-300" />
            ) : !isOnline ? (
              <WifiOff className="w-3.5 h-3.5 text-amber-300" />
            ) : (
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span className="hidden sm:inline text-[11px]">
              {!isOnline ? 'Offline' : pendingSyncCount > 0 ? `${pendingSyncCount} unsynced` : 'Synced'}
            </span>
          </button>

          {/* Plan / Access Status Pill */}
          <button
            onClick={onOpenPlan}
            className="hidden sm:flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all border bg-emerald-800/60 text-emerald-100 border-emerald-700/60 hover:bg-emerald-800"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
            <span className="text-[11px] font-semibold">
              Full Access
            </span>
          </button>

          {/* Developer & Support Contact Button */}
          <button
            onClick={() => setIsSupportOpen(true)}
            title="Need help? Contact Ronisher Bwalya (+260 96 283 8581)"
            className="flex items-center space-x-1.5 bg-emerald-800/60 hover:bg-emerald-800 border border-emerald-700/60 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-100 transition-colors"
          >
            <HelpCircle className="w-3.5 h-3.5 text-emerald-300" />
            <span className="hidden sm:inline text-[11px]">Support</span>
          </button>

          {/* Language Switcher Dropdown */}
          <div className="relative" ref={langMenuRef}>
            <button
              onClick={() => {
                setShowLangMenu(!showLangMenu);
                setShowShopMenu(false);
              }}
              className="flex items-center space-x-1 bg-emerald-800/60 hover:bg-emerald-800 border border-emerald-700/60 px-2.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider text-white"
            >
              <Globe className="w-3.5 h-3.5 text-emerald-300" />
              <span>{language}</span>
              <ChevronDown className="w-3 h-3 text-emerald-300 opacity-70" />
            </button>

            {showLangMenu && (
              <div className="absolute right-0 mt-2 w-44 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 text-slate-900 z-50">
                <div className="px-3 py-1.5 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Select Language
                  </span>
                </div>
                {(Object.keys(langNames) as Language[]).map((langKey) => (
                  <button
                    key={langKey}
                    onClick={() => {
                      setLanguage(langKey);
                      setShowLangMenu(false);
                    }}
                    className={`w-full text-left px-3.5 py-2 text-xs flex items-center justify-between hover:bg-slate-50 transition-colors ${
                      language === langKey
                        ? 'font-bold text-emerald-700 bg-emerald-50'
                        : 'text-slate-700'
                    }`}
                  >
                    <span>{langNames[langKey].label}</span>
                    <span className="text-[10px] text-slate-400 uppercase font-mono">{langKey}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Shop Profile Dropdown Menu */}
          <div className="relative" ref={shopMenuRef}>
            <button
              onClick={() => {
                setShowShopMenu(!showShopMenu);
                setShowLangMenu(false);
              }}
              className="w-8 h-8 rounded-lg bg-emerald-800 hover:bg-emerald-700 flex items-center justify-center border border-emerald-700/80 text-white transition-colors"
              aria-label="Shop Menu"
            >
              <Store className="w-4 h-4" />
            </button>

            {showShopMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 text-slate-900 z-50">
                <div className="px-3.5 py-2.5 border-b border-slate-100 bg-slate-50/60 rounded-t-xl">
                  <p className="text-xs font-bold text-slate-900 truncate">{shop?.name}</p>
                  <p className="text-[11px] text-slate-500 font-mono">{shop?.ownerPhone}</p>
                </div>

                <div className="py-1">
                  <button
                    onClick={() => {
                      setShowShopMenu(false);
                      onOpenPlan();
                    }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <CreditCard className="w-4 h-4 text-emerald-600" />
                    <div className="flex-1">
                      <p className="font-semibold">{t.planTitle}</p>
                      <p className="text-[10px] text-emerald-600 font-medium">
                        Full Free Access (Unlocked)
                      </p>
                    </div>
                  </button>

                  <button
                    onClick={() => {
                      setShowShopMenu(false);
                      setIsSupportOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <HelpCircle className="w-4 h-4 text-emerald-600" />
                    <div className="flex-1">
                      <p className="font-semibold">Support & Developer</p>
                      <p className="text-[10px] text-slate-400">
                        Ronisher · +260 96 283 8581
                      </p>
                    </div>
                  </button>

                  <button
                    onClick={() => {
                      setShowShopMenu(false);
                      onOpenAdmin();
                    }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-amber-50 text-amber-900 transition-colors font-semibold"
                  >
                    <UserCheck className="w-4 h-4 text-amber-600" />
                    <div className="flex-1">
                      <p>{t.adminTitle}</p>
                      <p className="text-[10px] text-amber-700/70 font-normal">Platform Owner Console</p>
                    </div>
                  </button>
                </div>

                <div className="my-1 border-t border-slate-100" />

                <button
                  onClick={() => {
                    setShowShopMenu(false);
                    void logout();
                  }}
                  className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 text-rose-600 hover:bg-rose-50 transition-colors font-medium"
                >
                  <LogOut className="w-4 h-4" />
                  <span>{t.logout}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Developer & Support Contact Modal */}
      <SupportModal
        isOpen={isSupportOpen}
        onClose={() => setIsSupportOpen(false)}
      />
    </header>
  );
};
