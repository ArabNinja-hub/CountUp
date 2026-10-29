import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Store,
  Phone,
  KeyRound,
  ArrowRight,
  Shield,
  Lock,
  FileText,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { Language } from '../types';
import logo from '/brand/logo.png';
import { LegalPages } from './LegalPages';

export const AuthScreen: React.FC = () => {
  const {
    loginWithPhoneAndPin,
    registerNewShop,
    isLoading,
    t,
    language,
    setLanguage,
  } = useShop();

  const [mode, setMode] = useState<'login' | 'register'>('register'); // Default to register for new users
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showLegal, setShowLegal] = useState<'privacy' | 'terms' | 'security' | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    const cleanPhone = phone.trim();
    const cleanPin = pin.trim();

    if (!cleanPhone || cleanPhone.length < 8) {
      setErrorMessage('Please enter a valid Zambian phone number (e.g. 0977 123 456)');
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
        setErrorMessage(
          'Could not create this shop. That phone number may already be registered — log in instead, or check your connection and try again.'
        );
      }
    } else {
      const success = await loginWithPhoneAndPin(cleanPhone, cleanPin);
      if (!success) {
        setErrorMessage('Incorrect phone or PIN. New shop? Switch to "Create Shop" below.');
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex flex-col justify-between py-6 px-4 sm:px-6">
      {/* Legal Modal Overlay */}
      {showLegal && (
        <LegalPages onClose={() => setShowLegal(null)} />
      )}

      <div className="max-w-md w-full mx-auto space-y-5">
        {/* Top bar: language switch */}
        <div className="flex items-center justify-between">
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
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Brand hero */}
        <div className="flex flex-col items-center text-center pt-2">
          <div className="h-14 flex items-center justify-center">
            <img src={logo} alt="Countup" className="h-12 w-auto object-contain select-none" />
          </div>
          <p className="mt-2 text-[11px] text-slate-500 font-medium tracking-wide">
            Zambian Kiosk Sales & Stock Book
          </p>
          <p className="mt-1 text-[10px] text-emerald-700 font-semibold uppercase tracking-wider">
            Works Offline · Syncs Automatically · 30-Day Free Trial
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-6 shadow-sm">
          {/* Mode Indicator (simplified - no toggle tabs) */}
          <div className="mb-4">
            <h2 className="text-base font-bold text-slate-900">
              {mode === 'login' ? 'Welcome Back' : 'Create Your Shop'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'login'
                ? 'Enter your phone and 4-digit PIN to continue'
                : 'Get started in 30 seconds. Free 30-day trial included.'}
            </p>
          </div>

          {errorMessage && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-medium flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t.shopName} <span className="text-rose-500">*</span>
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
                    autoComplete="organization"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {t.phoneNumber} <span className="text-rose-500">*</span>
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
                  autoComplete="tel"
                  inputMode="tel"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {t.pin} (4 numbers) <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
                <input
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={4}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-12 py-2.5 text-base font-black tracking-widest text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono text-center"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full min-h-[48px] mt-2 bg-emerald-900 hover:bg-emerald-950 active:scale-[0.99] text-white py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-center space-x-2 shadow-xs disabled:opacity-50 transition-all cursor-pointer"
            >
              <span>{isLoading ? 'Connecting...' : mode === 'login' ? 'Log In' : 'Create Shop & Start Trial'}</span>
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {!isLoading && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          {/* Switch mode link */}
          <p className="text-center text-xs text-slate-500 mt-4">
            {mode === 'login' ? (
              <>
                Don&apos;t have a shop?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('register'); setErrorMessage(''); }}
                  className="text-emerald-700 font-bold underline hover:text-emerald-900"
                >
                  Create New Shop
                </button>
              </>
            ) : (
              <>
                Already have a shop?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('login'); setErrorMessage(''); }}
                  className="text-emerald-700 font-bold underline hover:text-emerald-900"
                >
                  Log In
                </button>
              </>
            )}
          </p>

          {/* Trust badges */}
          <div className="mt-4 pt-4 border-t border-slate-200 flex items-center justify-center space-x-4 text-[10px] text-slate-400">
            <span className="flex items-center space-x-1">
              <Shield className="w-3 h-3" />
              <span>Phone + PIN only</span>
            </span>
            <span className="flex items-center space-x-1">
              <Lock className="w-3 h-3" />
              <span>Encrypted Sync</span>
            </span>
            <span className="flex items-center space-x-1">
              <FileText className="w-3 h-3" />
              <span>Data Export</span>
            </span>
          </div>
        </div>

        {/* Legal Links Footer */}
        <div className="max-w-md w-full mx-auto text-center space-y-2 text-[10px] text-slate-400">
          <p>Countup Zambia · Works Offline & Syncs Automatically</p>
          <div className="flex items-center justify-center space-x-3">
            <button
              onClick={() => setShowLegal('privacy')}
              className="hover:text-emerald-700 underline transition-colors"
            >
              Privacy Policy
            </button>
            <span>·</span>
            <button
              onClick={() => setShowLegal('terms')}
              className="hover:text-emerald-700 underline transition-colors"
            >
              Terms of Service
            </button>
            <span>·</span>
            <button
              onClick={() => setShowLegal('security')}
              className="hover:text-emerald-700 underline transition-colors"
            >
              Security
            </button>
          </div>
          <p className="text-[9px] text-slate-400">
            By using Countup, you agree to our <span className="underline">Terms</span> and <span className="underline">Privacy Policy</span>.
          </p>
        </div>
      </div>
    </div>
  );
};