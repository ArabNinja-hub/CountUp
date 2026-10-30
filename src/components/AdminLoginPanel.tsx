import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { BrandMark } from './BrandMark';

function signInError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (
    ['auth/invalid-credential', 'auth/wrong-password'].includes(code ?? '')
  )
    return 'Incorrect passcode for ronisherbwalya@gmail.com. Check it or use "Set / Reset Passcode".';
  if (code === 'auth/user-not-found')
    return 'No passcode set yet for ronisherbwalya@gmail.com. Click "Set Passcode" tab below to create your passcode.';
  if (code === 'auth/weak-password')
    return 'Passcode is too weak. Please use at least 6 characters.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (code === 'auth/operation-not-allowed')
    return 'Email sign-in is not enabled for this app in Firebase console.';
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||
    code === 'deadline-exceeded'
  )
    return 'Could not check admin access. Check your internet connection and try again.';
  return error instanceof Error ? error.message : 'Could not sign in. Please try again.';
}

interface AdminLoginPanelProps {
  onBack: () => void;
  onSignedIn: () => void;
  onOpenHelp: () => void;
}

export const AdminLoginPanel: React.FC<AdminLoginPanelProps> = ({
  onBack,
  onSignedIn,
  onOpenHelp,
}) => {
  const { loginAsAdmin, setAdminPasscode, resetEmailPassword } = useShop();
  const [tab, setTab] = useState<'login' | 'set_passcode'>('login');
  const [email, setEmail] = useState('ronisherbwalya@gmail.com');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const OWNER_EMAIL = 'ronisherbwalya@gmail.com';

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!password) {
      setError('Please enter your passcode.');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await loginAsAdmin(cleanEmail, password);
      onSignedIn();
    } catch (err: unknown) {
      const msg = signInError(err);
      setError(msg);
      const code = (err as { code?: string })?.code;
      // If user not found, give a friendly hint to switch to set passcode
      if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
        setMessage('First time logging in? Click "Set Passcode" tab above to create your passcode.');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleSetPasscode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail !== OWNER_EMAIL) {
      setError(
        `Passcode setup is reserved for the app owner (${OWNER_EMAIL}).`
      );
      return;
    }
    if (password.length < 6) {
      setError('Passcode must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The passcodes do not match.');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await setAdminPasscode(cleanEmail, password);
      onSignedIn();
    } catch (err: unknown) {
      setError(signInError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const recover = async () => {
    if (busyRef.current) return;
    const cleanEmail = email.trim().toLowerCase() || OWNER_EMAIL;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await resetEmailPassword(cleanEmail);
      setMessage(`Check inbox for ${cleanEmail} for the password reset link.`);
    } catch (err) {
      setError(signInError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50/70 via-slate-50 to-slate-100 px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto w-full max-w-md">
        {/* Navigation Bar */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-emerald-800 hover:text-emerald-950 disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to shop sign in
          </button>
          <button
            type="button"
            onClick={onOpenHelp}
            className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm font-bold text-emerald-800 hover:bg-emerald-100"
          >
            <BookOpen className="h-4 w-4" />
            Help
          </button>
        </div>

        {/* Brand Header */}
        <div className="pb-4 pt-3 text-center">
          <BrandMark />
          <p className="mt-1 text-xs text-slate-500 font-medium">CountUp Zambia · Platform Administration</p>
        </div>

        {/* Main Card */}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          {/* Header Badge */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <span className="rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-[11px] font-extrabold text-emerald-800 uppercase tracking-wider">
              Owner Access Only
            </span>
          </div>

          <h1 className="text-xl font-black tracking-tight text-slate-950">
            {tab === 'login' ? 'Admin sign in' : 'Set your admin passcode'}
          </h1>
          <p className="mt-1 text-xs text-slate-600">
            {tab === 'login'
              ? 'Sign in as the app owner to manage shops and platform settings.'
              : 'Choose and confirm your private passcode for ronisherbwalya@gmail.com.'}
          </p>

          {/* Mode Switcher Tabs */}
          <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTab('login');
                setError('');
                setMessage('');
              }}
              className={`min-h-[38px] rounded-lg text-xs font-bold transition-colors ${
                tab === 'login'
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('set_passcode');
                setError('');
                setMessage('');
              }}
              className={`min-h-[38px] rounded-lg text-xs font-bold transition-colors ${
                tab === 'set_passcode'
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Set Passcode
            </button>
          </div>

          {/* Error & Success Messages */}
          {error && (
            <div
              role="alert"
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"
            >
              {error}
            </div>
          )}
          {message && (
            <div
              role="status"
              className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"
            >
              {message}
            </div>
          )}

          {/* Form */}
          <form onSubmit={tab === 'login' ? handleLogin : handleSetPasscode} className="mt-4 space-y-3">
            {/* Email Field - Pre-filled & Locked to Owner */}
            <div>
              <label htmlFor="admin-email" className="block text-xs font-bold text-slate-700">
                Email
              </label>
              <div className="relative mt-1">
                <Mail className="absolute left-3 top-3.5 h-4 w-4 text-emerald-700" />
                <input
                  id="admin-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="ronisherbwalya@gmail.com"
                  className="min-h-[44px] w-full rounded-xl border border-emerald-300 bg-emerald-50/40 py-2 pl-10 pr-3 text-sm font-semibold text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Email sign-in is exclusively for Ronisher Bwalya (ronisherbwalya@gmail.com).
              </p>
            </div>

            {/* Passcode Field */}
            <div>
              <label htmlFor="admin-passcode" className="block text-xs font-bold text-slate-700">
                {tab === 'login' ? 'Password' : 'Choose New Passcode (min 6 characters)'}
              </label>
              <div className="relative mt-1">
                <Lock className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                <input
                  id="admin-passcode"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-11 text-sm font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide passcode' : 'Show passcode'}
                  className="absolute right-1 top-0 flex h-11 w-11 items-center justify-center text-slate-500 hover:text-slate-800"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Passcode (in Set Passcode mode) */}
            {tab === 'set_passcode' && (
              <div>
                <label className="block text-xs font-bold text-slate-700">
                  Confirm Passcode
                </label>
                <div className="relative mt-1">
                  <Lock className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="••••••••"
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-3 text-sm font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={busy}
              className="mt-2 min-h-[48px] w-full rounded-xl bg-emerald-900 text-sm font-bold text-white hover:bg-emerald-950 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm"
            >
              {busy ? (
                'Connecting to Admin Console…'
              ) : tab === 'login' ? (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  <span>Open admin console</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 text-amber-300" />
                  <span>Set Passcode &amp; Open Console</span>
                </>
              )}
            </button>

            {/* Forgot Passcode / Help */}
            {tab === 'login' && (
              <button
                type="button"
                onClick={() => void recover()}
                disabled={busy}
                className="flex min-h-[40px] w-full items-center justify-center gap-2 text-xs font-bold text-emerald-800 hover:text-emerald-950 disabled:opacity-50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Forgot password?
              </button>
            )}
          </form>

          {/* Security Notice */}
          <div className="mt-4 rounded-2xl bg-slate-50 border border-slate-200/80 p-3 text-xs text-slate-600">
            <div className="flex items-center gap-1.5 font-bold text-slate-800 mb-1">
              <UserCheck className="h-4 w-4 text-emerald-700" />
              <span>Owner Credential Rule</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Only <strong>ronisherbwalya@gmail.com</strong> has platform administrator rights. Kiosks and stores log in using their 4-digit PIN.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
