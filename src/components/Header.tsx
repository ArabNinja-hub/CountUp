import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useShop } from '../context/ShopContext';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Globe,
  Store,
  LogOut,
  ChevronDown,
  Settings,
  AlertTriangle,
  BookUser,
  Download,
  Lock,
  Shield,
  FileText,
  ShieldCheck,
  Trash2,
  KeyRound,
} from 'lucide-react';
import { Language } from '../types';
import { DeleteShopModal } from './DeleteShopModal';
import { ChangePinModal } from './ChangePinModal';
import icon from '/brand/icon.png';

interface HeaderProps {
  // No more onOpenPlan/onOpenAdmin - those are in Settings now
}

export const Header: React.FC<HeaderProps> = () => {
  const {
    shop,
    t,
    language,
    setLanguage,
    isOnline,
    pendingSyncCount,
    isSyncing,
    syncNow,
    logout,
    items,
    customers,
    isAdmin,
  } = useShop();

  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setShowLangMenu(false);
      }
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const langNames: Record<Language, { label: string }> = {
    en: { label: 'English' },
    bem: { label: 'Ichibemba' },
    nya: { label: 'Chinyanja' },
  };

  const lowStockCount = items.filter((i) => i.quantity <= i.lowStockThreshold).length;
  const debtCustomerCount = customers.filter((c) => c.totalOwed > 0).length;

  return (
    <header className="sticky top-0 z-40 bg-gradient-to-r from-emerald-950 via-emerald-900 to-emerald-800 border-b border-emerald-800/80 text-white shadow-sm">
      {/* Main Bar */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        {/* Left: Brand & Shop Info */}
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0 shadow-xs overflow-hidden backdrop-blur-sm">
            <img src={icon} alt="Countup" className="w-7 h-7 object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="font-bold text-sm sm:text-base text-white tracking-tight truncate">
              {shop?.name || 'Countup'}
            </h1>
            <p className="text-[11px] text-emerald-200/90 truncate flex items-center space-x-1.5">
              <span>{shop?.ownerPhone || shop?.ownerEmail || '—'}</span>
              <span className="text-emerald-500">·</span>
              <span className="text-emerald-300 font-medium">ZMW (K)</span>
            </p>
          </div>
        </div>

        {/* Right: Actions (Sync status, Language, Settings Menu) */}
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

          {/* Language Switcher Dropdown */}
          <div className="relative" ref={langMenuRef}>
            <button
              onClick={() => {
                setShowLangMenu(!showLangMenu);
                setShowSettingsMenu(false);
              }}
              className="flex items-center space-x-1 bg-emerald-800/60 hover:bg-emerald-800 border border-emerald-700/60 px-2.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider text-white"
            >
              <Globe className="w-3.5 h-3.5 text-emerald-300" />
              <span>{language.toUpperCase()}</span>
              <ChevronDown className="w-3 h-3 text-emerald-300 opacity-70" />
            </button>

            {showLangMenu && (
              <div className="absolute right-0 mt-2 w-40 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 text-slate-900 z-50">
                <div className="px-3 py-1.5 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Language
                  </span>
                </div>
                {(Object.keys(langNames) as Language[]).map((langKey) => (
                  <button
                    key={langKey}
                    onClick={() => {
                      setLanguage(langKey);
                      setShowLangMenu(false);
                    }}
                    className={`w-full text-left px-3.5 py-2 text-xs hover:bg-slate-50 transition-colors ${
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

          {/* Settings Menu (replaces Shop Profile Menu) */}
          <div className="relative" ref={settingsMenuRef}>
            <button
              onClick={() => {
                setShowSettingsMenu(!showSettingsMenu);
                setShowLangMenu(false);
              }}
              className="w-8 h-8 rounded-lg bg-emerald-800 hover:bg-emerald-700 flex items-center justify-center border border-emerald-700/80 text-white transition-colors"
              aria-label="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>

            {showSettingsMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 text-slate-900 z-50">
                <div className="px-3.5 py-2.5 border-b border-slate-100 bg-slate-50/60 rounded-t-xl">
                  <p className="text-xs font-bold text-slate-900 truncate">{shop?.name}</p>
                  <p className="text-[11px] text-slate-500 font-mono">{shop?.ownerPhone || shop?.ownerEmail}</p>
                </div>

                <div className="py-1">
                  {/* Subscription / Plan */}
                  <button
                    onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('open-plan')); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <Store className="w-4 h-4 text-emerald-600" />
                    <div className="flex-1">
                      <p className="font-semibold">Subscription Plan</p>
                      <p className="text-[10px] text-slate-400">Manage your plan & billing</p>
                    </div>
                  </button>

                  {/* Legal */}
                  <button
                    onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('open-legal', { detail: 'privacy' })); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <FileText className="w-4 h-4 text-slate-500" />
                    <span>Privacy Policy</span>
                  </button>

                  <button
                    onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('open-legal', { detail: 'terms' })); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <Shield className="w-4 h-4 text-slate-500" />
                    <span>Terms of Service</span>
                  </button>

                  <button
                    onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('open-legal', { detail: 'security' })); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <Lock className="w-4 h-4 text-slate-500" />
                    <span>Security</span>
                  </button>

                  {isAdmin && (
                    <button
                      onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('open-admin')); }}
                      className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-700" />
                      <div className="flex-1">
                        <p className="font-semibold">Platform Admin</p>
                        <p className="text-[10px] text-slate-400">Shops, plans & deactivation</p>
                      </div>
                    </button>
                  )}

                  {/* Change PIN */}
                  <button
                    onClick={() => { setShowSettingsMenu(false); setShowPinModal(true); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <KeyRound className="w-4 h-4 text-slate-500" />
                    <span>Change PIN</span>
                  </button>

                  {/* Export Data */}
                  <button
                    onClick={() => { setShowSettingsMenu(false); window.dispatchEvent(new CustomEvent('export-data')); }}
                    className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 hover:bg-slate-50 text-slate-700 transition-colors"
                  >
                    <Download className="w-4 h-4 text-slate-500" />
                    <span>Export My Data</span>
                  </button>
                </div>

                <div className="my-1 border-t border-slate-100" />

                <button
                  onClick={() => {
                    setShowSettingsMenu(false);
                    setShowDeleteModal(true);
                  }}
                  className="w-full text-left px-3.5 py-2 text-xs flex items-center space-x-2.5 text-slate-700 hover:bg-rose-50 hover:text-rose-700 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Delete Shop &amp; Data</span>
                </button>

                <button
                  onClick={() => {
                    setShowSettingsMenu(false);
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

      {/* Low Stock / Credit Alert Bar (only when there are alerts) */}
      {(lowStockCount > 0 || debtCustomerCount > 0) && (
        <div className="px-4 sm:px-6 py-1.5 bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto flex items-center space-x-3 text-xs">
            {lowStockCount > 0 && (
              <span className="flex items-center space-x-1 text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                <AlertTriangle className="w-3 h-3" />
                <span>{lowStockCount} item{lowStockCount > 1 ? 's' : ''} low on stock</span>
              </span>
            )}
            {debtCustomerCount > 0 && (
              <span className="flex items-center space-x-1 text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                <BookUser className="w-3 h-3" />
                <span>{debtCustomerCount} customer{debtCustomerCount > 1 ? 's' : ''} owe you money</span>
              </span>
            )}
          </div>
        </div>
      )}

      {showPinModal && <ChangePinModal onClose={() => setShowPinModal(false)} />}
      {showDeleteModal && <DeleteShopModal onClose={() => setShowDeleteModal(false)} />}
    </header>
  );
};