import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Store,
  Phone,
  KeyRound,
  ArrowRight,
  Sparkles,
  Shield,
  Lock,
  FileText,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Building2,
  ShoppingBag,
} from 'lucide-react';
import { Language } from '../types';
import logo from '/brand/logo.png';
import { LegalPages } from './LegalPages';

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

  const [mode, setMode] = useState<'login' | 'register'>('register'); // Default to register for new users
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showLegal, setShowLegal] = useState<'privacy' | 'terms' | 'security' | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);

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
        setErrorMessage('Could not create shop. Check connection and try again.');
      }
    } else {
      const success = await loginWithPhoneAndPin(cleanPhone, cleanPin);
      if (!success) {
        setErrorMessage('Incorrect phone or PIN. New shop? Switch to "Create Shop" below.');
      }
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setErrorMessage('');
    try {
      // Use redirect for better mobile/preview compatibility
      const { signInWithRedirect, GoogleAuthProvider } = await import('firebase/auth');
      const { auth } = await import('../firebase/config');
      const provider = new GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');
      await signInWithRedirect(auth, provider);
      // Note: After redirect, the page reloads and onAuthStateChanged handles the rest
    } catch (err) {
      console.error('Google Sign-In error:', err);
      // Fallback to popup if redirect fails
      try {
        const { signInWithPopup, GoogleAuthProvider } = await import('firebase/auth');
        const { auth } = await import('../firebase/config');
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
      } catch (popupErr) {
        console.error('Google Sign-In popup error:', popupErr);
        setErrorMessage('Google Sign-In unavailable. Please use phone + PIN instead.');
      }
    } finally {
      setGoogleLoading(false);
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
              disabled={isLoading || googleLoading}
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

          {/* Google Sign-In */}
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <span className="relative bg-white px-3 text-[10px] uppercase font-bold text-slate-400">
              Or continue with
            </span>
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading || googleLoading}
            className="w-full min-h-[44px] bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 py-2.5 px-4 rounded-xl font-medium text-xs flex items-center justify-center space-x-2.5 shadow-xs active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>{googleLoading ? 'Redirecting...' : 'Continue with Google'}</span>
          </button>

          {/* Demo Shops */}
          <div className="mt-4 pt-4 border-t border-slate-200">
            <div className="flex items-center space-x-1.5 mb-2">
              <Sparkles className="w-4 h-4 text-emerald-700" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                {t.demoShops}
              </h3>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">{t.demoHint}</p>

            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'kiosk', name: 'Bwino Kiosk', location: 'Lusaka', icon: Store },
                { id: 'stall', name: 'Soweto Stall', location: 'Market', icon: Building2 },
                { id: 'minimart', name: 'Chilenje Shop', location: 'Grocer', icon: ShoppingBag },
              ].map((demo) => (
                <button
                  key={demo.id}
                  onClick={() => void loadDemoShop(demo.id as 'kiosk' | 'stall' | 'minimart')}
                  disabled={isLoading}
                  className="bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-800 hover:text-emerald-950 rounded-xl p-2.5 text-center active:scale-95 transition-all disabled:opacity-50"
                >
                  <demo.icon className="w-4 h-4 mx-auto mb-1 text-emerald-700" />
                  <span className="block text-xs font-bold leading-tight">{demo.name}</span>
                  <span className="text-[10px] text-slate-500">{demo.location}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Trust badges */}
          <div className="mt-4 pt-4 border-t border-slate-200 flex items-center justify-center space-x-4 text-[10px] text-slate-400">
            <span className="flex items-center space-x-1">
              <Shield className="w-3 h-3" />
              <span>Secure PIN</span>
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