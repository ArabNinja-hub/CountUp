/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ShopProvider, useShop } from './context/ShopContext';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Navigation } from './components/Navigation';
import { SellScreen } from './components/SellScreen';
import { StockScreen } from './components/StockScreen';
import { CreditBookScreen } from './components/CreditBookScreen';
import { ReportsScreen } from './components/ReportsScreen';
import { PlanScreen } from './components/PlanScreen';
import { AdminScreen } from './components/AdminScreen';
import { AuthScreen } from './components/AuthScreen';
import { OfflineNotice } from './components/OfflineNotice';
import { ToastProvider } from './components/Toast';
import { LegalPages } from './components/LegalPages';
import icon from '/brand/icon.png';

const MainAppContent: React.FC = () => {
  const { 
    shop, 
    activeTab, 
    setActiveTab, 
    isLoading,
    sales,
    items,
    customers,
    creditPayments,
    expenses,
    subscription,
    shop: shopData,
  } = useShop();

  const [isPlanOpen, setIsPlanOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [legalPage, setLegalPage] = useState<'privacy' | 'terms' | 'security' | null>(null);

  // Handle custom events from Header
  useEffect(() => {
    const handleOpenPlan = () => setIsPlanOpen(true);
    const handleOpenAdmin = () => setIsAdminOpen(true);
    const handleOpenLegal = (e: CustomEvent) => setLegalPage(e.detail as 'privacy' | 'terms' | 'security');
    const handleExportData = () => {
      // Export all data as JSON
      const exportData = {
        shop: shopData,
        subscription,
        items,
        sales,
        customers,
        creditPayments,
        expenses,
        exportedAt: new Date().toISOString(),
        version: '1.0',
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
  }, [shopData, subscription, items, sales, customers, creditPayments, expenses]);

  if (isLoading) {
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

  // Not logged into a shop
  if (!shop) {
    return <AuthScreen />;
  }

  // Legal Pages Modal
  if (legalPage) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <LegalPages onClose={() => setLegalPage(null)} />
      </div>
    );
  }

  // Admin Screen Mode
  if (isAdminOpen) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <AdminScreen onBack={() => setIsAdminOpen(false)} />
      </div>
    );
  }

  // Plan Screen Mode
  if (isPlanOpen) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <PlanScreen onClose={() => setIsPlanOpen(false)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900 font-sans">
      {/* Desktop sidebar + content shell */}
      <div className="md:flex md:min-h-screen">
        <Sidebar />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top Header */}
          <Header />

          {/* Offline sync notice toast */}
          <OfflineNotice />

          {/* Active Tab Screen */}
          <main className="flex-1 w-full max-w-5xl mx-auto px-3 sm:px-6 py-3 sm:py-5 pb-24 md:pb-8">
            {activeTab === 'sell' && (
              <SellScreen
                onOpenPlan={() => setIsPlanOpen(true)}
                onGoToStock={() => setActiveTab('stock')}
              />
            )}
            {activeTab === 'stock' && <StockScreen />}
            {activeTab === 'credit' && <CreditBookScreen />}
            {activeTab === 'reports' && <ReportsScreen />}
          </main>

          {/* Mobile-Only Bottom Navigation */}
          <Navigation />
        </div>
      </div>
    </div>
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