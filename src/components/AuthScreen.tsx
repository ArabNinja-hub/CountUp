import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Globe,
  KeyRound,
  Lock,
  LogOut,
  MessageSquareCode,
  Phone,
  ShieldCheck,
  Store,
  WifiOff,
} from 'lucide-react';
import { Language } from '../types';
import type { PendingPinResetSummary } from '../../shared/edgeAuthDomain';
import { BrandMark } from './BrandMark';
import { LegalPages } from './LegalPages';
import { AdminLoginPanel } from './AdminLoginPanel';
import { TurnstileField } from './TurnstileField';

type CloudAuthStep =
  'phone' | 'otp' | 'register_details' | 'unlock_pin' | 'recover_pin' | 'complete_approved_reset';

function formatLockoutDuration(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.ceil(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export const AuthScreen: React.FC<{ onOpenHelp: () => void; onAdminSignedIn: () => void }> = ({
  onOpenHelp,
  onAdminSignedIn,
}) => {
  const {
    shop,
    isScreenLocked,
    unlockLocalScreen,
    logout,
    t,
    language,
    setLanguage,
    isOnline,
    sendPhoneVerificationCode,
    verifyPhoneVerificationCode,
    completeShopRegistration,
    unlockCloudShopWithPin,
    recoverCloudShopPin,
    completeApprovedCloudPinReset,
    cancelEmailLogin,
  } = useShop();

  const [isRegistering, setIsRegistering] = useState(true);
  const [step, setStep] = useState<CloudAuthStep>('phone');
  const [pendingPinReset, setPendingPinReset] = useState<PendingPinResetSummary | null>(null);
  const [phone, setPhone] = useState('');
  const [verifiedPhoneE164, setVerifiedPhoneE164] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [shopName, setShopName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [captchaReady, setCaptchaReady] = useState(true);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [legalDoc, setLegalDoc] = useState<'privacy' | 'terms' | 'security' | null>(null);
  const [showAdminSignIn, setShowAdminSignIn] = useState(false);

  const langOptions: { code: Language; label: string }[] = [
    { code: 'en', label: 'English' },
    { code: 'bem', label: 'Ichibemba' },
    { code: 'nya', label: 'Chinyanja' },
  ];

  // ---------------------------------------------------------------
  // MODE 1: OFFLINE SAME-DEVICE SCREEN LOCK
  // ---------------------------------------------------------------
  if (shop && isScreenLocked) {
    const handleLocalUnlock = async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      if (!/^\d{4}$/.test(pin)) {
        setError('Enter your 4-digit shop PIN.');
        return;
      }
      setBusy(true);
      try {
        const res = await unlockLocalScreen(pin);
        if (!res.unlocked) {
          setPin('');
          if (res.lockedOut && res.remainingLockoutMs > 0) {
            setError(
              `Too many incorrect PIN tries on this phone. Wait ${formatLockoutDuration(res.remainingLockoutMs)} before trying again.`
            );
          } else {
            setError('Incorrect PIN. Check your 4-digit PIN and try again.');
          }
        }
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 px-4 pt-3 sm:pt-5">
          <div className="flex items-center gap-1.5 rounded-xl bg-white/90 px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-xs ring-1 ring-slate-200/80">
            <Lock className="h-3.5 w-3.5 text-emerald-700" />
            <span>Screen locked</span>
          </div>
          <button
            type="button"
            onClick={onOpenHelp}
            className="flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
          >
            <BookOpen className="h-4 w-4" />
            <span>Help</span>
          </button>
        </div>

        <div className="px-4 pt-3 pb-4 text-center sm:pt-5 sm:pb-6">
          <BrandMark />
          <p className="mt-1 text-xs font-medium text-slate-500">
            Unlock works offline on this phone
          </p>
        </div>

        <div className="flex-1 flex flex-col justify-start px-4 pb-6">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-extrabold text-slate-900">Unlock {shop.name}</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">{shop.ownerPhone}</p>

            {error && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
              >
                {error}
              </div>
            )}

            <form onSubmit={(e) => void handleLocalUnlock(e)} className="mt-4 space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700" htmlFor="pin">
                  {t.pin}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
                  <input
                    id="pin"
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="4 digits"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 pl-10 pr-3.5 text-center font-mono text-base tracking-widest text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || pin.length !== 4}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-950 disabled:opacity-50"
              >
                <span>{busy ? 'Unlocking…' : 'Unlock shop'}</span>
                <ArrowRight className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => void logout()}
                disabled={busy}
                className="flex min-h-[40px] w-full items-center justify-center gap-1.5 text-xs font-semibold text-rose-700 hover:text-rose-900"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign out of this shop</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------
  // MODE 2: CLOUD SIGN-IN, REGISTRATION & ONE-TIME RECOVERY
  // ---------------------------------------------------------------
  if (showAdminSignIn) {
    return (
      <AdminLoginPanel
        onBack={() => {
          void cancelEmailLogin();
          setShowAdminSignIn(false);
        }}
        onSignedIn={() => {
          setShowAdminSignIn(false);
          onAdminSignedIn();
        }}
        onOpenHelp={onOpenHelp}
      />
    );
  }

  const resetToPhoneStep = () => {
    setStep('phone');
    setOtpCode('');
    setPin('');
    setConfirmPin('');
    setRecoveryCode('');
    setError('');
    setInfoMessage('');
    setCaptchaReset((n) => n + 1);
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMessage('');
    if (!isOnline) {
      setError('Connect to the internet to receive your SMS verification code.');
      return;
    }
    if (!captchaReady) {
      setError('Complete the security check first.');
      return;
    }
    setBusy(true);
    try {
      const { phoneE164 } = await sendPhoneVerificationCode(phone, captchaToken);
      setVerifiedPhoneE164(phoneE164);
      setStep('otp');
      setInfoMessage(`We sent a 6-digit SMS code to ${phoneE164}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send SMS code. Try again.');
      setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMessage('');
    if (!/^\d{6}$/.test(otpCode.trim())) {
      setError('Enter the 6-digit SMS verification code.');
      return;
    }
    setBusy(true);
    try {
      const status = await verifyPhoneVerificationCode(verifiedPhoneE164 || phone, otpCode);
      setOtpCode('');
      setPendingPinReset(status.pendingPinReset ?? null);
      if (status.hasShop) {
        setIsRegistering(false);
        if (status.pendingPinReset?.status === 'ready') {
          setStep('complete_approved_reset');
          setInfoMessage(
            'Your 72-hour support-approved PIN reset is ready. Choose a new 4-digit shop PIN below.'
          );
        } else if (status.isLockedOut) {
          setStep('recover_pin');
          setInfoMessage(
            status.isRecoveryLockedOut
              ? 'Both PIN and recovery-code entry are temporarily locked for this shop. Wait for the cooldown or contact support for a 72-hour PIN reset.'
              : 'New-device PIN sign-in is currently locked for this shop. Enter your one-time recovery code to set a new PIN.'
          );
        } else {
          setStep('unlock_pin');
          setInfoMessage('Phone verified. Enter your 4-digit shop PIN to unlock your shop.');
        }
      } else {
        setIsRegistering(true);
        setStep('register_details');
        setInfoMessage('Phone verified. Choose your shop name and 4-digit PIN.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid or expired SMS code.');
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!shopName.trim()) {
      setError('Enter your shop name.');
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setError('Choose a PIN with exactly 4 numbers.');
      return;
    }
    if (pin !== confirmPin) {
      setError('The two PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      await completeShopRegistration(shopName.trim(), pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register shop. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4}$/.test(pin)) {
      setError('Enter your 4-digit shop PIN.');
      return;
    }
    setBusy(true);
    try {
      await unlockCloudShopWithPin(pin);
    } catch (err) {
      setPin('');
      setError(err instanceof Error ? err.message : 'Incorrect PIN. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleRecoverPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!recoveryCode.trim()) {
      setError('Enter your one-time recovery code.');
      return;
    }
    if (!/^\d{4}$/.test(newPinValue(pin))) {
      setError('Choose a new PIN with exactly 4 numbers.');
      return;
    }
    if (pin !== confirmPin) {
      setError('The two new PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      await recoverCloudShopPin(recoveryCode, pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery code could not be verified.');
    } finally {
      setBusy(false);
    }
  };

  function newPinValue(val: string): string {
    return val.trim();
  }

  const handleCompleteApprovedReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4}$/.test(newPinValue(pin))) {
      setError('Choose a new PIN with exactly 4 numbers.');
      return;
    }
    if (pin !== confirmPin) {
      setError('The two new PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      await completeApprovedCloudPinReset(pin);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not complete approved PIN reset. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      {/* Top Bar: Language + Help */}
      <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 px-4 pt-3 sm:pt-5">
        <div className="flex items-center space-x-1 rounded-xl bg-white/90 p-1 shadow-xs ring-1 ring-slate-200/80">
          <Globe className="ml-2 h-3.5 w-3.5 text-slate-400" />
          {langOptions.map((opt) => (
            <button
              key={opt.code}
              type="button"
              onClick={() => setLanguage(opt.code)}
              className={`min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                language === opt.code
                  ? 'bg-emerald-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onOpenHelp}
          className="flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
        >
          <BookOpen className="h-4 w-4" />
          <span>Help</span>
        </button>
      </div>

      {/* Brand Header */}
      <div className="px-4 pt-3 pb-4 text-center sm:pt-5 sm:pb-6">
        <BrandMark />
        <p className="mt-1 text-xs font-medium text-slate-500">
          Simple sales, stock &amp; credit for Zambian shops
        </p>
      </div>

      <div className="flex-1 flex flex-col justify-start px-4 pb-6">
        <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm sm:p-6">
          {step === 'phone' && (
            <div className="mb-5 flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setIsRegistering(true);
                  setError('');
                }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                  isRegistering
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                New shop
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRegistering(false);
                  setError('');
                }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                  !isRegistering
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {t.logInBtn}
              </button>
            </div>
          )}

          {step !== 'phone' && (
            <button
              type="button"
              onClick={resetToPhoneStep}
              disabled={busy}
              className="mb-3 inline-flex min-h-[36px] items-center gap-1.5 text-xs font-bold text-emerald-800 hover:text-emerald-950"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Change phone number ({verifiedPhoneE164 || phone})</span>
            </button>
          )}

          <div className="mb-4">
            <h2 className="text-lg font-extrabold text-slate-900">
              {step === 'phone'
                ? isRegistering
                  ? 'Create your shop'
                  : 'Sign in to your shop'
                : step === 'otp'
                  ? 'Enter SMS verification code'
                  : step === 'register_details'
                    ? 'Set up your shop & PIN'
                    : step === 'unlock_pin'
                      ? 'Enter your shop PIN'
                      : 'Recover shop PIN'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {step === 'phone'
                ? isRegistering
                  ? 'Verify your MTN, Airtel, or Zamtel number to start your free trial.'
                  : 'Verify your mobile number with an SMS code, then enter your 4-digit PIN.'
                : step === 'otp'
                  ? 'Enter the 6-digit code sent to your phone.'
                  : step === 'register_details'
                    ? 'Choose a 4-digit PIN for fast daily offline unlocking.'
                    : step === 'unlock_pin'
                      ? 'Your PIN protects your shop even if someone swaps your SIM card.'
                      : 'Enter the one-time recovery code saved when you created your shop.'}
            </p>
          </div>

          {!isOnline && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
              <WifiOff className="h-4 w-4 shrink-0 text-amber-700" />
              <span>Connect to the internet for SMS verification on a new session.</span>
            </div>
          )}

          {infoMessage && (
            <div
              role="status"
              className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900"
            >
              {infoMessage}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
            >
              {error}
            </div>
          )}

          {/* STEP 1: PHONE + TURNSTILE */}
          {step === 'phone' && (
            <form onSubmit={(e) => void handleRequestOtp(e)} className="space-y-3.5">
              <div>
                <label
                  htmlFor="auth-phone"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  {t.phoneNumber}
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="auth-phone"
                    type="tel"
                    placeholder="0977 123 456"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white transition-all"
                    required
                  />
                </div>
              </div>

              <TurnstileField
                resetSignal={captchaReset}
                onTokenChange={(token, ready) => {
                  setCaptchaToken(token);
                  setCaptchaReady(ready);
                }}
              />

              <button
                type="submit"
                disabled={busy || !captchaReady}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Sending code…' : 'Send SMS code'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* STEP 2: 6-DIGIT SMS OTP */}
          {step === 'otp' && (
            <form onSubmit={(e) => void handleVerifyOtp(e)} className="space-y-3.5">
              <div>
                <label
                  htmlFor="auth-otp"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  6-digit SMS code
                </label>
                <div className="relative">
                  <MessageSquareCode className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="auth-otp"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="123456"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || otpCode.length !== 6}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Verifying…' : 'Verify SMS code'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* STEP 3A: UNLOCK EXISTING SHOP ON NEW DEVICE WITH PIN */}
          {step === 'unlock_pin' && (
            <form onSubmit={(e) => void handleUnlockPin(e)} className="space-y-3.5">
              <div>
                <label
                  htmlFor="unlock-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  {t.pin}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="unlock-pin"
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="4 digits"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || pin.length !== 4}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Unlocking…' : 'Open my shop'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPin('');
                  setConfirmPin('');
                  setError('');
                  setStep('recover_pin');
                }}
                className="flex min-h-[40px] w-full items-center justify-center gap-1.5 text-xs font-bold text-emerald-800 hover:text-emerald-950"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Forgot PIN or locked out? Use recovery code</span>
              </button>
            </form>
          )}

          {/* STEP 3B: COMPLETE NEW SHOP REGISTRATION */}
          {step === 'register_details' && (
            <form onSubmit={(e) => void handleCompleteRegistration(e)} className="space-y-3.5">
              <div>
                <label
                  htmlFor="register-shop-name"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  {t.shopName}
                </label>
                <div className="relative">
                  <Store className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="register-shop-name"
                    type="text"
                    placeholder="e.g., Bwalya's Grocery"
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="register-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Choose 4-Digit PIN
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="register-pin"
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="4 digits"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="register-confirm-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Repeat 4-Digit PIN
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="register-confirm-pin"
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="4 digits"
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || pin.length !== 4 || confirmPin.length !== 4}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Creating shop…' : t.registerBtn}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* STEP 3C: RECOVER SHOP PIN WITH ONE-TIME RECOVERY CODE */}
          {step === 'recover_pin' && (
            <form onSubmit={(e) => void handleRecoverPin(e)} className="space-y-3.5">
              <div>
                <label
                  htmlFor="recovery-code-input"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  One-time recovery code
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    id="recovery-code-input"
                    type="text"
                    placeholder="CU-XXXX-XXXX-XXXX"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-10 pr-3.5 py-2.5 text-sm font-mono uppercase tracking-wider text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                    required
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="recover-new-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  New 4-Digit PIN
                </label>
                <input
                  id="recover-new-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4 digits"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="recover-confirm-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Repeat New PIN
                </label>
                <input
                  id="recover-confirm-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4 digits"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={busy || pin.length !== 4 || confirmPin.length !== 4}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Resetting PIN…' : 'Reset PIN & open shop'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setStep('unlock_pin');
                }}
                className="flex min-h-[38px] w-full items-center justify-center text-xs font-semibold text-slate-600 hover:text-slate-900"
              >
                Back to 4-digit PIN entry
              </button>

              {pendingPinReset?.status === 'pending_wait' && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
                  <p className="font-bold">72-hour support PIN reset in waiting period</p>
                  <p className="mt-1">
                    You can set a new PIN without a recovery code after{' '}
                    <strong>{new Date(pendingPinReset.availableAt).toLocaleString()}</strong>.
                  </p>
                </div>
              )}

              {pendingPinReset?.status === 'ready' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setPin('');
                    setConfirmPin('');
                    setStep('complete_approved_reset');
                  }}
                  className="flex min-h-[40px] w-full items-center justify-center rounded-xl border border-emerald-300 bg-emerald-50 px-3 text-xs font-bold text-emerald-900 hover:bg-emerald-100"
                >
                  Complete 72-hour approved PIN reset
                </button>
              )}
            </form>
          )}

          {/* STEP 3D: COMPLETE ADMIN-APPROVED 72-HOUR PIN RESET */}
          {step === 'complete_approved_reset' && (
            <form onSubmit={(e) => void handleCompleteApprovedReset(e)} className="space-y-3.5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-950">
                <p className="font-bold">Approved 72-hour PIN reset ready</p>
                <p className="mt-1">
                  The 72-hour safety waiting period has finished. Choose a new 4-digit PIN below —
                  CountUp will also give you a brand-new one-time recovery code to write down.
                </p>
              </div>

              <div>
                <label
                  htmlFor="approved-reset-new-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  New 4-Digit PIN
                </label>
                <input
                  id="approved-reset-new-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4 digits"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="approved-reset-confirm-pin"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Repeat New PIN
                </label>
                <input
                  id="approved-reset-confirm-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4 digits"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-base font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={busy || pin.length !== 4 || confirmPin.length !== 4}
                className="w-full min-h-[48px] bg-emerald-900 hover:bg-emerald-950 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-sm flex items-center justify-center space-x-2 text-sm transition-colors"
              >
                <span>{busy ? 'Saving new PIN…' : 'Set new PIN & open shop'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>

        {/* Footer notes + legal links */}
        <div className="max-w-md w-full mx-auto mt-5 text-center space-y-2">
          <p className="text-xs text-slate-500">
            Works offline after setup · All amounts in ZMW (Kwacha)
          </p>
          <div className="flex items-center justify-center space-x-3 text-[11px] text-slate-500">
            <button
              type="button"
              onClick={() => setLegalDoc('privacy')}
              className="hover:text-emerald-700 underline"
            >
              Privacy Policy
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => setLegalDoc('terms')}
              className="hover:text-emerald-700 underline"
            >
              Terms
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => setLegalDoc('security')}
              className="hover:text-emerald-700 underline"
            >
              Security
            </button>
          </div>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowAdminSignIn(true)}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-500 hover:bg-white/70 hover:text-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Admin sign in
            </button>
          </div>
        </div>
      </div>

      {legalDoc && <LegalPages initialDoc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </div>
  );
};
