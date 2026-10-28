/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
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

const MainAppContent: React.FC = () => {
  const { shop, activeTab, setActiveTab, isLoading } = useShop();

  const [isPlanOpen, setIsPlanOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <img
            src="/brand/icon.png"
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
        <Sidebar onOpenPlan={() => setIsPlanOpen(true)} />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top Header */}
          <Header
            onOpenPlan={() => setIsPlanOpen(true)}
            onOpenAdmin={() => setIsAdminOpen(true)}
          />

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
    <ShopProvider>
      <MainAppContent />
    </ShopProvider>
  );
}
