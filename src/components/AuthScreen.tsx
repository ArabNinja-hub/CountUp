import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Store,
  Phone,
  KeyRound,
  ArrowRight,
  Sparkles,
  Globe,
  CheckCircle2,
  ShieldCheck,
  Building2,
  ShoppingBag,
} from 'lucide-react';
import { Language } from '../types';

export const AuthScreen: React.FC = () => {
  const {
    loginWithPhoneAndPin,
    loginWithGoogle,
    registerNewShop,
    loadDemoShop,
    isLoading,
    t,
    language,
    setLanguage,
  } = useShop();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    const cleanPhone = phone.trim();
    const cleanPin = pin.trim();

    if (!cleanPhone || cleanPhone.length < 8) {
      setErrorMessage('Please enter a valid phone number (e.g. 0977 123 456)');
      return;
    }

    if (!cleanPin || cleanPin.length !== 4 || !/^\d{4}$/.test(cleanPin)) {
      setErrorMessage('PIN must be exactly 4 numbers (e.g. 1234)');
      return;
    }

    if (mode === 'register') {
      if (!shopName.trim()) {
        setErrorMessage('Please enter your shop or kiosk name');
        return;
      }
      const success = await registerNewShop(shopName, cleanPhone, cleanPin);
      if (!success) {
        setErrorMessage('Could not register shop. Please check connection and try again.');
      }
    } else {
      const success = await loginWithPhoneAndPin(cleanPhone, cleanPin);
      if (!success) {
        setErrorMessage('Incorrect phone or PIN. If new, tap "Start 30-day free trial" below.');
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-100/70 flex flex-col justify-between py-8 px-4 sm:px-6">
      <div className="max-w-md w-full mx-auto space-y-4">
        {/* Brand Header & Language Switch */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-900 border border-emerald-800 text-white flex items-center justify-center shadow-xs">
              <Store className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <h1 className="text-xl font-black text-slate-900 tracking-tight leading-tight">
                Countup
              </h1>
              <p className="text-[11px] text-emerald-800 font-semibold tracking-wide">
                Zambian Kiosk Sales &amp; Stock Book
              </p>
            </div>
          </div>

          {/* Language Switch */}
          <div className="flex items-center space-x-1 bg-white border border-slate-200/90 rounded-xl p-1 shadow-xs">
            {(['en', 'bem', 'nya'] as Language[]).map((lang) => (
              <button
                key={lang}
                onClick={() => setLanguage(lang)}
                className={`min-h-[28px] px-2.5 py-1 rounded-lg text-xs font-bold uppercase transition-all ${
                  language === lang
                    ? 'bg-emerald-900 text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-sm">
          {/* Mode Switcher */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-2xl mb-5">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setErrorMessage('');
              }}
              className={`min-h-[38px] text-xs font-bold rounded-xl transition-all ${
                mode === 'login'
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.logInBtn}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setErrorMessage('');
              }}
              className={`min-h-[38px] text-xs font-bold rounded-xl transition-all ${
                mode === 'register'
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.registerBtn}
            </button>
          </div>

          <div className="mb-4">
            <h2 className="text-base font-bold text-slate-900">
              {mode === 'login' ? 'Sign in to your shop' : 'Set up your shop'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'login'
                ? 'Enter your Zambian phone number and 4-digit PIN'
                : '30-day free trial included. Fast 15-second sales recording.'}
            </p>
          </div>

          {errorMessage && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium">
              {errorMessage}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t.shopName} *
                </label>
                <div className="relative">
                  <Store className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    required
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    placeholder="e.g. Bwino Kiosk, Soweto Stall 4"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {t.phoneNumber} *
              </label>
              <div className="relative">
                <Phone className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 0977 123 456"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {t.pin} (4 numbers) *
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-base font-black tracking-widest text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono text-center"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full min-h-[46px] mt-2 bg-emerald-900 hover:bg-emerald-950 active:scale-[0.99] text-white py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-center space-x-2 shadow-xs disabled:opacity-50 transition-all cursor-pointer"
            >
              <span>{isLoading ? 'Connecting...' : mode === 'login' ? t.logInBtn : t.registerBtn}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Continue with Google */}
          <div className="relative my-4 text-center">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <span className="relative bg-white px-2.5 text-[10px] uppercase font-bold text-slate-400">
              Or
            </span>
          </div>

          <button
            type="button"
            onClick={() => void loginWithGoogle()}
            disabled={isLoading}
            className="w-full min-h-[44px] bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center space-x-2.5 shadow-xs active:scale-[0.99] transition-all cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>
        </div>

        {/* 1-Tap Demo Shops Section */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 shadow-xs">
          <div className="flex items-center space-x-1.5 mb-1.5">
            <Sparkles className="w-4 h-4 text-emerald-700" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
              {t.demoShops}
            </h3>
          </div>
          <p className="text-[11px] text-slate-500 mb-3">{t.demoHint}</p>

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => void loadDemoShop('kiosk')}
              className="bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-800 hover:text-emerald-950 rounded-xl p-2.5 text-center active:scale-95 transition-all"
            >
              <span className="block text-xs font-bold leading-tight">Bwino Kiosk</span>
              <span className="text-[10px] text-slate-500">Lusaka</span>
            </button>

            <button
              onClick={() => void loadDemoShop('stall')}
              className="bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-800 hover:text-emerald-950 rounded-xl p-2.5 text-center active:scale-95 transition-all"
            >
              <span className="block text-xs font-bold leading-tight">Soweto Stall</span>
              <span className="text-[10px] text-slate-500">Market</span>
            </button>

            <button
              onClick={() => void loadDemoShop('minimart')}
              className="bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-800 hover:text-emerald-950 rounded-xl p-2.5 text-center active:scale-95 transition-all"
            >
              <span className="block text-xs font-bold leading-tight">Chilenje Shop</span>
              <span className="text-[10px] text-slate-500">Grocer</span>
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="max-w-md w-full mx-auto text-center text-[11px] text-slate-400 mt-6">
        <p>Countup Zambia · Works Offline &amp; Syncs Automatically</p>
      </div>
    </div>
  );
};
