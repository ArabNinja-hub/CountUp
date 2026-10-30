import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mail,
  Phone,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { Language } from '../types';
import { normalizeZambianPhone, sanitizePhoneInput } from '../utils/format';
import { BrandMark } from './BrandMark';
import { LegalPages } from './LegalPages';
import { EmailLoginPanel } from './AccountAccess';
import { AdminLoginPanel } from './AdminLoginPanel';

interface AuthScreenProps {
  onOpenHelp: () => void;
  onAdminSignedIn: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onOpenHelp, onAdminSignedIn }) => {
  const { loginWithPhoneAndPin, registerNewShop, isLoading, t, language, setLanguage } = useShop();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showLegal, setShowLegal] = useState<'privacy' | 'terms' | 'security' | null>(null);
  const [view, setView] = useState<'phone' | 'email' | 'admin'>('phone');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage('');
    const cleanPhone = phone.trim();
    const cleanPin = pin.trim();
    const national = normalizeZambianPhone(cleanPhone);
    if (!/^0(9[5-7]|7[5-7])\d{7}$/.test(national)) {
      setErrorMessage('Enter a Zambian mobile number, for example 0977 123 456.');
      return;
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      setErrorMessage('Enter a PIN with exactly 4 numbers.');
      return;
    }
    if (mode === 'register') {
      if (!shopName.trim()) {
        setErrorMessage('Enter your shop name.');
        return;
      }
      const success = await registerNewShop(shopName, cleanPhone, cleanPin);
      if (!success)
        setErrorMessage('Could not create this shop. Check your connection or try logging in.');
    } else {
      const success = await loginWithPhoneAndPin(cleanPhone, cleanPin);
      if (!success)
        setErrorMessage('Phone number or PIN not found on this device. Check them and try again.');
    }
  };

  if (view === 'email') return <EmailLoginPanel onBack={() => setView('phone')} />;
  if (view === 'admin')
    return (
      <AdminLoginPanel
        onBack={() => setView('phone')}
        onSignedIn={onAdminSignedIn}
        onOpenHelp={onOpenHelp}
      />
    );

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50/70 via-slate-50 to-slate-100 px-4 py-4 sm:px-6 sm:py-6">
      {showLegal && <LegalPages initialDoc={showLegal} onClose={() => setShowLegal(null)} />}
      <div className="mx-auto w-full max-w-md">
        <div className="flex items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Language"
            className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-xs"
          >
            {(['en', 'bem', 'nya'] as Language[]).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguage(lang)}
                aria-pressed={language === lang}
                className={`min-h-[32px] rounded-lg px-2.5 text-xs font-bold uppercase transition-colors ${
                  language === lang
                    ? 'bg-emerald-900 text-white'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onOpenHelp}
            className="flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-bold text-emerald-800 hover:bg-emerald-100"
          >
            <BookOpen className="h-4 w-4" />
            Help
          </button>
        </div>

        <div className="pb-4 pt-4 text-center sm:pb-5 sm:pt-6">
          <BrandMark />
          <p className="mt-1.5 text-sm text-slate-600">Your shop, in one place.</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div
            className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1"
            role="group"
            aria-label="Shop access"
          >
            {(
              [
                { value: 'register', label: 'New shop' },
                { value: 'login', label: 'Log in' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setMode(option.value);
                  setErrorMessage('');
                }}
                aria-pressed={mode === option.value}
                className={`min-h-[40px] rounded-lg text-sm font-bold transition-colors ${
                  mode === option.value
                    ? 'bg-white text-emerald-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <h1 className="text-xl font-extrabold tracking-tight text-slate-950">
            {mode === 'register' ? 'Create your shop' : 'Log in to your shop'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'register'
              ? 'Start with a 30-day free trial.'
              : 'Use your phone number and PIN.'}
          </p>

          {errorMessage && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            {mode === 'register' && (
              <label className="block text-sm font-bold text-slate-700">
                {t.shopName}
                <span className="relative mt-1 block">
                  <Store className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    required
                    value={shopName}
                    onChange={(event) => setShopName(event.target.value)}
                    placeholder="e.g. Bwino Kiosk"
                    autoComplete="organization"
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-3 text-base font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                  />
                </span>
              </label>
            )}
            <label className="block text-sm font-bold text-slate-700">
              {t.phoneNumber}
              <span className="relative mt-1 block">
                <Phone className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(event) => setPhone(sanitizePhoneInput(event.target.value))}
                  placeholder="0977 123 456"
                  autoComplete="tel"
                  inputMode="tel"
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-3 text-base font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                />
              </span>
            </label>
            <div>
              <label htmlFor="shop-pin" className="block text-sm font-bold text-slate-700">
                {t.pin}
              </label>
              <div className="relative mt-1">
                <KeyRound className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                <input
                  id="shop-pin"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={4}
                  required
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  autoComplete="off"
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-12 text-base tracking-widest text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  className="absolute right-1 top-0 flex h-11 w-11 items-center justify-center text-slate-500 hover:text-slate-800"
                >
                  {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="mt-1 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 px-4 text-sm font-bold text-white transition-colors hover:bg-emerald-950 disabled:opacity-50"
            >
              {isLoading ? 'Connecting…' : mode === 'login' ? 'Log in' : 'Create shop'}
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </button>
          </form>

          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setView('email')}
              className="flex min-h-[44px] items-center justify-center gap-1 whitespace-nowrap rounded-xl bg-slate-50 px-1 text-[11px] font-bold text-emerald-800 hover:bg-emerald-50 sm:text-xs"
            >
              <Mail className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
              Email sign in
            </button>
            <button
              type="button"
              onClick={() => setView('admin')}
              className="flex min-h-[44px] items-center justify-center gap-1 whitespace-nowrap rounded-xl bg-slate-50 px-1 text-[11px] font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-900 sm:text-xs"
            >
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
              Admin sign in
            </button>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pb-3 text-xs text-slate-500">
          {(
            [
              { label: 'Privacy', doc: 'privacy' },
              { label: 'Terms', doc: 'terms' },
              { label: 'Security', doc: 'security' },
            ] as const
          ).map(({ label, doc }) => (
            <button
              key={doc}
              type="button"
              onClick={() => setShowLegal(doc)}
              className="min-h-[32px] hover:text-emerald-800"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
