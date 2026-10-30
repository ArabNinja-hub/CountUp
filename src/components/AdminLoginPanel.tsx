import React, { useRef, useState } from 'react';
import { ArrowLeft, BookOpen, KeyRound, ShieldCheck } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { BrandMark } from './BrandMark';

function signInError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (
    ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(code ?? '')
  )
    return 'The email or password is incorrect.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (code === 'auth/operation-not-allowed') return 'Email sign-in is not enabled for this app.';
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||
    code === 'deadline-exceeded'
  )
    return 'Could not check admin access. Check your internet connection and try again.';
  if (code === 'permission-denied')
    return 'Could not verify admin access. Contact your administrator.';
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
  const { loginAsAdmin, resetEmailPassword } = useShop();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await loginAsAdmin(email, password);
      onSignedIn();
    } catch (err) {
      setError(signInError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const recover = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await resetEmailPassword(email);
      setMessage('If this email has an account, check your inbox for a reset link.');
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
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-emerald-800 disabled:opacity-50"
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

        <div className="pb-5 pt-4">
          <BrandMark />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-950">Admin sign in</h1>
          <p className="mt-1 text-sm text-slate-600">Use an account with admin access.</p>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            >
              {error}
            </p>
          )}
          {message && (
            <p
              role="status"
              className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            >
              {message}
            </p>
          )}

          <form onSubmit={login} className="mt-4 space-y-3">
            <label className="block text-sm font-bold text-slate-700">
              Email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <label className="block text-sm font-bold text-slate-700">
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 outline-hidden focus:border-emerald-700 focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-1 min-h-[48px] w-full rounded-xl bg-emerald-900 text-sm font-bold text-white hover:bg-emerald-950 disabled:opacity-50"
            >
              {busy ? 'Checking access…' : 'Open admin console'}
            </button>
            <button
              type="button"
              onClick={() => void recover()}
              disabled={busy}
              className="flex min-h-[40px] w-full items-center justify-center gap-2 text-sm font-bold text-emerald-800 disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              Forgot password?
            </button>
          </form>
          <details className="mt-3 rounded-xl bg-slate-50 px-3 text-sm text-slate-600">
            <summary className="min-h-[44px] cursor-pointer py-3 font-bold text-slate-700">
              Need admin access?
            </summary>
            <p className="pb-3 leading-relaxed">
              Admin access must be granted to your account. If you use a shop PIN, log in to your
              shop and open <strong>Settings → Platform Admin</strong>.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
};
