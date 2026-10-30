/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ShopProvider, useShop } from './context/ShopContext';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Navigation } from './components/Navigation';
import { SellScreen } from './components/SellScreen';
import { HomeScreen } from './components/HomeScreen';
import { StockScreen } from './components/StockScreen';
import { CreditBookScreen } from './components/CreditBookScreen';
import { ReportsScreen } from './components/ReportsScreen';
import { PlanScreen } from './components/PlanScreen';
import { AdminScreen } from './components/AdminScreen';
import { AuthScreen } from './components/AuthScreen';
import { OfflineNotice } from './components/OfflineNotice';
import { ToastProvider, useToast } from './components/Toast';
import { LegalPages } from './components/LegalPages';
import { HelpGuide } from './components/HelpGuide';
import icon from '/brand/icon.png';

const MainAppContent: React.FC = () => {
  const {
    shop,
    user,
    isAdmin,
    isOnline,
    cancelEmailLogin,
    activeTab,
    setActiveTab,
    isLoading,
    sales,
    items,
    archivedItems,
    stockMovements,
    stockConflicts,
    customers,
    creditPayments,
    expenses,
    subscription,
    shop: shopData,
  } = useShop();

  const { notify } = useToast();
  const [isPlanOpen, setIsPlanOpen] = useState(false);
  const [addProductFromHome, setAddProductFromHome] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [legalPage, setLegalPage] = useState<'privacy' | 'terms' | 'security' | null>(null);
  const openHelp = useCallback(() => setIsHelpOpen(true), []);
  const closeHelp = useCallback(() => setIsHelpOpen(false), []);

  // A closed or lost Firebase session must never reopen a previous admin view.
  useEffect(() => {
    if (!user) setIsAdminOpen(false);
  }, [user]);

  const exitAdmin = async () => {
    if (!shop) {
      try {
        await cancelEmailLogin();
      } catch {
        notify('Could not sign out', { kind: 'error', detail: 'Please try again.' });
        return;
      }
    }
    setIsAdminOpen(false);
  };

  const withHelp = (content: React.ReactNode) => (
    <>
      {content}
      {isHelpOpen && <HelpGuide onClose={closeHelp} />}
    </>
  );

  // Handle custom events from Header
  useEffect(() => {
    const handleOpenPlan = () => setIsPlanOpen(true);
    const handleOpenAdmin = () => {
      if (isAdmin && shopData) setIsAdminOpen(true);
    };
    const handleOpenLegal = (e: CustomEvent) =>
      setLegalPage(e.detail as 'privacy' | 'terms' | 'security');
    const handleExportData = () => {
      // Export all data as JSON
      const exportData = {
        format: 'countup-backup-v2',
        shop: shopData ? { ...shopData, pin: undefined } : null,
        subscription,
        items,
        archivedItems,
        stockMovements,
        stockConflicts,
        sales,
        customers,
        creditPayments,
        expenses,
        exportedAt: new Date().toISOString(),
        version: '2.0',
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `countup-backup-${shopData?.name || 'shop'}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    window.addEventListener('open-plan', handleOpenPlan as EventListener);
    window.addEventListener('open-admin', handleOpenAdmin as EventListener);
    window.addEventListener('open-legal', handleOpenLegal as EventListener);
    window.addEventListener('export-data', handleExportData as EventListener);

    return () => {
      window.removeEventListener('open-plan', handleOpenPlan as EventListener);
      window.removeEventListener('open-admin', handleOpenAdmin as EventListener);
      window.removeEventListener('open-legal', handleOpenLegal as EventListener);
      window.removeEventListener('export-data', handleExportData as EventListener);
    };
  }, [
    shopData,
    isAdmin,
    subscription,
    items,
    archivedItems,
    stockMovements,
    stockConflicts,
    sales,
    customers,
    creditPayments,
    expenses,
  ]);

  if (isLoading && !shop) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <img
            src={icon}
            alt="Countup"
            className="w-12 h-12 object-contain mx-auto mb-4 select-none"
          />
          <div className="w-10 h-10 border-4 border-emerald-700 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <h2 className="font-bold text-slate-900 text-sm tracking-tight">Countup Zambia</h2>
          <p className="text-xs text-slate-500 mt-1">Connecting to your kiosk...</p>
        </div>
      </div>
    );
  }

  // Explicit render-time authorization is required, including for the no-shop
  // admin sign-in. A custom browser event alone can never open the console.
  if (isAdminOpen && isAdmin && user) {
    return withHelp(
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <AdminScreen onBack={() => void exitAdmin()} exitLabel={shop ? 'Exit admin' : 'Sign out'} />
      </div>
    );
  }

  if (isAdminOpen && user && !shop && !isAdmin) {
    return withHelp(
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-extrabold text-slate-900">Admin access unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">
            {isOnline
              ? 'We could not verify admin access. Please sign in again.'
              : 'Connect to the internet to verify admin access.'}
          </p>
          <button
            onClick={() => void exitAdmin()}
            className="mt-4 min-h-[44px] w-full rounded-xl bg-emerald-900 px-4 text-sm font-bold text-white"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (!shop) {
    return withHelp(
      <AuthScreen onOpenHelp={openHelp} onAdminSignedIn={() => setIsAdminOpen(true)} />
    );
  }

  if (legalPage) {
    return withHelp(
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <LegalPages initialDoc={legalPage} onClose={() => setLegalPage(null)} />
      </div>
    );
  }

  if (isPlanOpen) {
    return withHelp(
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <PlanScreen onClose={() => setIsPlanOpen(false)} />
      </div>
    );
  }

  return withHelp(
    <>
      <div
        inert={isLoading}
        className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900 font-sans"
      >
        {/* Desktop sidebar + content shell */}
        <div className="md:flex md:min-h-screen">
          <Sidebar />

          <div className="flex-1 min-w-0 flex flex-col">
            {/* Top Header */}
            <Header onOpenHelp={openHelp} />

            {/* Offline sync notice toast */}
            <OfflineNotice />

            {/* Active Tab Screen */}
            <main className="flex-1 w-full max-w-5xl mx-auto px-3 sm:px-6 py-3 sm:py-5 pb-48 md:pb-8">
              {activeTab === 'home' && (
                <HomeScreen
                  onOpenHelp={openHelp}
                  onAddProduct={() => {
                    setAddProductFromHome(true);
                    setActiveTab('stock');
                  }}
                />
              )}
              {activeTab === 'sell' && (
                <SellScreen
                  onOpenPlan={() => setIsPlanOpen(true)}
                  onGoToStock={() => setActiveTab('stock')}
                />
              )}
              {activeTab === 'stock' && (
                <StockScreen
                  initialAdd={addProductFromHome}
                  onConsumedInitialAdd={() => setAddProductFromHome(false)}
                />
              )}
              {activeTab === 'credit' && <CreditBookScreen />}
              {activeTab === 'reports' && <ReportsScreen />}
            </main>

            {/* Mobile-Only Bottom Navigation */}
            <Navigation />
          </div>
        </div>
      </div>
      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4 text-center"
        >
          <div className="rounded-2xl bg-white p-6 text-sm font-bold text-slate-900 shadow-xl">
            Deleting shop and data… Please keep this page open.
          </div>
        </div>
      )}
    </>
  );
};

export default function App() {
  return (
    <ToastProvider>
      <ShopProvider>
        <MainAppContent />
      </ShopProvider>
    </ToastProvider>
  );
}
