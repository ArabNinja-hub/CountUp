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
  Smartphone,
} from 'lucide-react';
import type { AdminSignInOutcome } from '../auth/authService';
import { useShop } from '../context/ShopContext';
import { BrandMark } from './BrandMark';

function signInError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  if (
    [
      'invalid_credentials',
      'auth/invalid-credential',
      'auth/wrong-password',
      'auth/user-not-found',
    ].includes(code)
  )
    return 'The account or password is incorrect. Use the authorized platform account.';
  if (code === 'permission_denied' || code === 'functions/permission-denied')
    return 'This account is not authorized for platform administration.';
  if (code === 'mfa_required')
    return 'Complete two-factor verification (6-digit authenticator code) to enter admin.';
  if (code === 'weak_password' || code === 'auth/weak-password')
    return 'Choose a stronger password.';
  if (code === 'validation_failed' || code === 'auth/invalid-email')
    return 'Enter a valid email address.';
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'functions/unavailable' ||
    code === 'functions/deadline-exceeded'
  )
    return 'Could not verify administrator access. Check your internet connection and try again.';
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
  const { loginAsAdmin, completeAdminMfa, resetEmailPassword, cancelEmailLogin } = useShop();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mfaPrompt, setMfaPrompt] = useState<Exclude<
    AdminSignInOutcome,
    { status: 'authenticated' }
  > | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    if (!email.trim() || !password) {
      setError('Enter your authorized account email and password.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const outcome = await loginAsAdmin(email.trim(), password);
      if (
        outcome &&
        (outcome.status === 'mfa_verify_required' || outcome.status === 'mfa_enroll_required')
      ) {
        setMfaPrompt(outcome);
        setTotpCode('');
        return;
      }
      onSignedIn();
    } catch (err: unknown) {
      setError(signInError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleVerifyMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !mfaPrompt) return;
    if (!/^\d{6}$/.test(totpCode.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await completeAdminMfa(mfaPrompt.factorId, totpCode.trim());
      setMfaPrompt(null);
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
    if (!email.trim()) {
      setError('Enter your account email first.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await resetEmailPassword(email.trim());
      setMessage(
        'If that email is the authorized platform account, a password reset link will arrive shortly.'
      );
    } catch (err) {
      setError(signInError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto w-full max-w-md">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              if (mfaPrompt) {
                setMfaPrompt(null);
                setTotpCode('');
                void cancelEmailLogin();
              }
              onBack();
            }}
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

        <div className="pb-4 pt-3 text-center">
          <BrandMark />
          <p className="mt-1 text-xs font-medium text-slate-500">
            CountUp Zambia · Platform Administration
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-black tracking-tight text-slate-950">Admin sign in</h1>
          <p className="mt-1 text-sm text-slate-600">
            {mfaPrompt
              ? 'Two-factor authenticator verification (TOTP, aal2) is required for platform administration.'
              : 'Sign in with the pre-authorized platform account. Access requires two-factor verification.'}
          </p>

          {error && (
            <div
              role="alert"
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            >
              {error}
            </div>
          )}
          {message && (
            <div
              role="status"
              className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            >
              {message}
            </div>
          )}

          {mfaPrompt ? (
            <form onSubmit={(e) => void handleVerifyMfa(e)} className="mt-4 space-y-3">
              {mfaPrompt.status === 'mfa_enroll_required' && (
                <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                  <p className="font-bold">Set up your Authenticator App (one-time setup)</p>
                  <p>
                    Scan this QR code in Google Authenticator, Authy, or 1Password, then enter the
                    6-digit code below.
                  </p>
                  {mfaPrompt.qrCode && (
                    <div className="flex justify-center rounded-lg bg-white p-3">
                      <img
                        src={mfaPrompt.qrCode}
                        alt="TOTP Authenticator QR Code"
                        className="h-40 w-40"
                      />
                    </div>
                  )}
                  <p className="break-all font-mono text-[11px] text-slate-700">
                    Manual setup key: <strong>{mfaPrompt.secret}</strong>
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="admin-totp-code" className="block text-sm font-bold text-slate-700">
                  6-digit authenticator code
                </label>
                <div className="relative mt-1">
                  <Smartphone className="absolute left-3 top-3.5 h-4 w-4 text-emerald-700" />
                  <input
                    id="admin-totp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white py-2 pl-10 pr-3 text-center font-mono text-base tracking-widest text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy || totpCode.length !== 6}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-950 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                {busy ? 'Verifying 2FA…' : 'Verify 2FA & open admin console'}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleLogin(e)} className="mt-4 space-y-3">
              <div>
                <label htmlFor="admin-email" className="block text-sm font-bold text-slate-700">
                  Account email
                </label>
                <div className="relative mt-1">
                  <Mail className="absolute left-3 top-3.5 h-4 w-4 text-emerald-700" />
                  <input
                    id="admin-email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white py-2 pl-10 pr-3 text-sm text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="admin-password" className="block text-sm font-bold text-slate-700">
                  Password
                </label>
                <div className="relative mt-1">
                  <Lock className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <input
                    id="admin-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white py-2 pl-10 pr-11 text-sm text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1 top-0 flex h-11 w-11 items-center justify-center text-slate-500 hover:text-slate-800"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-950 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                {busy ? 'Verifying access…' : 'Open admin console'}
              </button>
              <button
                type="button"
                onClick={() => void recover()}
                disabled={busy}
                className="flex min-h-[40px] w-full items-center justify-center gap-2 text-sm font-bold text-emerald-800 hover:text-emerald-950 disabled:opacity-50"
              >
                <KeyRound className="h-4 w-4" />
                Forgot password?
              </button>
            </form>
          )}

          <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            Only a verified platform identity with active TOTP two-factor authentication (aal2) can
            enter the admin console.
          </p>
        </div>
      </div>
    </div>
  );
};
