import React, { useState } from 'react';
import { ArrowLeft, KeyRound, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { Shop } from '../types';
import { useToast } from './Toast';
import { BrandMark } from './BrandMark';

function accountError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/operation-not-allowed')
    return 'Email/password sign-in is not enabled for this Firebase project. Ask the administrator to enable it.';
  if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use')
    return 'That email is already used by another account. Use a different email; existing accounts cannot be merged automatically.';
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  )
    return 'The email or password is incorrect.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (code === 'auth/weak-password') return 'Choose a stronger password.';
  if (code === 'auth/network-request-failed')
    return 'Could not reach Firebase. Check your connection.';
  return error instanceof Error ? error.message : 'Could not complete the account request.';
}

export const AccountAccess: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const {
    user,
    shop,
    linkEmailAccount,
    needsShopAccountRecovery,
    restoreShopAccount,
    resetEmailPassword,
    pendingSyncCount,
    isOnline,
  } = useShop();
  const { notify } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linked = user && !user.isAnonymous;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!needsShopAccountRecovery && password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (needsShopAccountRecovery) {
        await restoreShopAccount(email, password);
        notify('Shop account reconnected', { detail: 'Pending entries can now sync.' });
      } else {
        await linkEmailAccount(email, password);
        notify('Email access enabled', {
          detail: 'Your existing shop and Firebase ownership were kept.',
        });
      }
      setPassword('');
      setConfirm('');
      onClose();
    } catch (err) {
      setError(accountError(err));
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    const address = user?.email || (needsShopAccountRecovery ? email.trim() : '');
    if (!address) {
      setError('Enter your linked email address first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await resetEmailPassword(address);
      notify('Password reset email requested', { detail: 'Check your email inbox.' });
    } catch (err) {
      setError(accountError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-title"
    >
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-3xl p-5 shadow-2xl space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <h2 id="account-title" className="text-lg font-black text-slate-900">
              Account &amp; cloud access
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Your existing CountUp shop stays the source of truth.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close account settings"
            disabled={busy}
            className="p-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {needsShopAccountRecovery ? (
          <div className="space-y-3">
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded-xl">
              This shop's original cloud session is missing. Keep this browser's data; unsynced
              entries remain here. Sign in using the email already linked to this shop.
            </p>
            {user ? (
              <p className="text-xs text-slate-700">
                A different account is active on this device. Contact support before changing
                accounts so no local entries or anonymous identity are lost.
              </p>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <label className="block text-xs font-bold text-slate-700">
                  Linked email
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                  />
                </label>
                <label className="block text-xs font-bold text-slate-700">
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                  />
                </label>
                <button
                  disabled={busy || !isOnline}
                  className="w-full min-h-[44px] rounded-xl bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
                >
                  {busy ? 'Reconnecting…' : 'Reconnect shop account'}
                </button>
                <button
                  type="button"
                  onClick={() => void recover()}
                  disabled={busy || !isOnline}
                  className="w-full min-h-[44px] text-xs font-bold text-emerald-800 disabled:opacity-50"
                >
                  Forgot password?
                </button>
              </form>
            )}
            <p className="text-xs text-slate-600">
              If no email was linked, only the original Firebase session can open the cloud shop. Do
              not clear browser data; contact support for help.
            </p>
          </div>
        ) : linked ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              Signed in as <strong>{user.email || 'a Firebase account'}</strong>.
            </p>
            <p className="text-xs text-slate-600">
              Use this email and password on another device to open your CountUp shop. Email
              recovery requires access to your inbox.
            </p>
            {user.email && (
              <button
                onClick={() => void recover()}
                disabled={busy}
                className="min-h-[44px] w-full rounded-xl border border-emerald-300 text-emerald-800 text-xs font-bold"
              >
                Send password reset email
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-600 leading-relaxed">
              Add an email and password to this device's existing Firebase identity. That keeps
              ownership of <strong>{shop?.name}</strong> and lets you sign in on another device.
              Your shop PIN is preserved. After logging out, use email and password to sign back in.
            </p>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded-xl">
              Choose an email and password for this shop. Passwords and recovery keys from earlier
              accounts are not transferred automatically. Email/password sign-in must be enabled by
              the project administrator.
            </p>
            <form onSubmit={submit} className="space-y-3">
              <label className="block text-xs font-bold text-slate-700">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                />
              </label>
              <label className="block text-xs font-bold text-slate-700">
                Password (at least 8 characters)
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                />
              </label>
              <label className="block text-xs font-bold text-slate-700">
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                />
              </label>
              <button
                disabled={busy || !isOnline || pendingSyncCount > 0}
                className="w-full min-h-[44px] rounded-xl bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
              >
                {busy ? 'Enabling…' : 'Enable email access'}
              </button>
              {(!isOnline || pendingSyncCount > 0) && (
                <p className="text-xs text-amber-800">Connect and sync pending entries first.</p>
              )}
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-rose-800 bg-rose-50 rounded-xl p-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

export const EmailLoginPanel: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { loginWithEmail, cancelEmailLogin, selectEmailShop, resetEmailPassword } = useShop();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shops, setShops] = useState<Shop[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const owned = await loginWithEmail(email, password);
      if (owned.length === 1) selectEmailShop(owned[0]);
      else setShops(owned);
    } catch (err) {
      setError(accountError(err));
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await resetEmailPassword(email);
      setMessage('If this email has an account, check your inbox for a reset link.');
    } catch (err) {
      setError(accountError(err));
    } finally {
      setBusy(false);
    }
  };
  const back = async () => {
    setBusy(true);
    setError('');
    try {
      await cancelEmailLogin();
      onBack();
    } catch (err) {
      setError(accountError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4 sm:p-6 flex justify-center items-start">
      <div className="w-full max-w-md space-y-5">
        <button
          onClick={() => void back()}
          disabled={busy}
          className="min-h-[44px] text-xs font-bold text-emerald-800 flex gap-2 items-center"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to phone &amp; PIN
        </button>
        <div className="bg-white border border-slate-200 rounded-3xl shadow-sm p-5 sm:p-6 space-y-4">
          <BrandMark />
          <div className="text-center">
            <h1 className="text-xl font-black text-slate-900">Email account</h1>
            <p className="text-xs text-slate-500 mt-1">
              Sign in to a CountUp shop with email access enabled.
            </p>
          </div>
          {shops.length ? (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-700">Choose your shop</p>
              {shops.map((shop) => (
                <button
                  key={shop.id}
                  onClick={() => selectEmailShop(shop)}
                  className="w-full min-h-[48px] rounded-xl border border-slate-200 text-left px-3 text-sm font-bold text-slate-800"
                >
                  {shop.name}{' '}
                  <span className="block text-xs font-normal text-slate-500">
                    {shop.ownerPhone}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={login} className="space-y-3">
              <label className="block text-xs font-bold text-slate-700">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                />
              </label>
              <label className="block text-xs font-bold text-slate-700">
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                />
              </label>
              <button
                disabled={busy}
                className="w-full min-h-[48px] rounded-xl bg-emerald-800 text-white text-sm font-bold disabled:opacity-50"
              >
                {busy ? 'Connecting…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => void recover()}
                disabled={busy}
                className="w-full min-h-[44px] flex justify-center items-center gap-2 text-xs font-bold text-emerald-800"
              >
                <KeyRound className="w-4 h-4" />
                Forgot password?
              </button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-xs text-rose-800 bg-rose-50 rounded-xl p-3">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-xs text-emerald-800 bg-emerald-50 rounded-xl p-3">
              {message}
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            Use the email and password enabled for this shop. Passwords and recovery keys from
            earlier accounts are not transferred automatically.
          </p>
        </div>
      </div>
    </div>
  );
};
