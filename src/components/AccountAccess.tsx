import React, { useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  MessageSquareCode,
  Phone,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { useToast } from './Toast';
import { TurnstileField } from './TurnstileField';

export const AccountAccess: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const {
    shop,
    user,
    isOnline,
    pendingSyncCount,
    needsShopAccountRecovery,
    sendPhoneVerificationCode,
    restoreShopSessionWithOtp,
    signOutOtherDevices,
  } = useShop();
  const { notify } = useToast();
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [captchaReady, setCaptchaReady] = useState(true);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleSendRecoveryOtp = async () => {
    if (!shop) return;
    setError('');
    setMessage('');
    if (!isOnline) {
      setError('Connect to the internet first to receive your SMS verification code.');
      return;
    }
    if (!captchaReady) {
      setError('Complete the security check first.');
      return;
    }
    setBusy(true);
    try {
      const { phoneE164 } = await sendPhoneVerificationCode(shop.ownerPhone, captchaToken);
      setOtpSent(true);
      setMessage(`Sent a 6-digit SMS verification code to ${phoneE164}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send SMS code. Please try again.');
      setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyRecoveryOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!/^\d{6}$/.test(otpCode.trim())) {
      setError('Enter the 6-digit SMS code.');
      return;
    }
    setBusy(true);
    try {
      await restoreShopSessionWithOtp(otpCode.trim());
      setOtpCode('');
      notify('Cloud session restored', {
        detail: 'Your waiting shop entries can now sync safely.',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid or expired SMS code.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-xs sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-access-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 text-slate-900 shadow-2xl sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
              Cloud identity &amp; security
            </p>
            <h2 id="account-access-title" className="text-lg font-extrabold text-slate-900">
              Account &amp; cloud access
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close account access"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!isOnline && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span>Offline right now. Daily shop work and PIN unlocking continue offline.</span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
          >
            {error}
          </div>
        )}

        {message && (
          <div
            role="status"
            className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800"
          >
            {message}
          </div>
        )}

        {needsShopAccountRecovery && user ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs leading-relaxed text-rose-900">
            <p className="font-bold">A different account is active on this device</p>
            <p className="mt-1">
              Keep this browser’s data safe ({pendingSyncCount} waiting). Sign out of the other
              session or contact support before reconnecting <strong>{shop?.ownerPhone}</strong>.
            </p>
          </div>
        ) : needsShopAccountRecovery ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-950">
              <p className="font-bold">Reconnect original shop phone</p>
              <p className="mt-1">
                Verify <strong>{shop?.ownerPhone}</strong> by SMS to resume cloud sync without
                losing any entries saved on this phone ({pendingSyncCount} waiting).
              </p>
            </div>

            {!otpSent ? (
              <div className="space-y-3">
                <TurnstileField
                  resetSignal={captchaReset}
                  onTokenChange={(token, ready) => {
                    setCaptchaToken(token);
                    setCaptchaReady(ready);
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !isOnline || !captchaReady}
                  onClick={() => void handleSendRecoveryOtp()}
                  className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 px-4 text-sm font-bold text-white hover:bg-emerald-950 disabled:opacity-50"
                >
                  <Phone className="h-4 w-4" />
                  <span>{busy ? 'Sending code…' : `Send SMS code to ${shop?.ownerPhone}`}</span>
                </button>
              </div>
            ) : (
              <form onSubmit={(e) => void handleVerifyRecoveryOtp(e)} className="space-y-3">
                <div>
                  <label
                    htmlFor="recovery-otp-code"
                    className="block text-xs font-bold text-slate-700"
                  >
                    6-digit SMS code
                  </label>
                  <div className="relative mt-1">
                    <MessageSquareCode className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
                    <input
                      id="recovery-otp-code"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-center font-mono text-base tracking-widest text-slate-900 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
                      required
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy || otpCode.length !== 6}
                  className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-900 px-4 text-sm font-bold text-white hover:bg-emerald-950 disabled:opacity-50"
                >
                  <KeyRound className="h-4 w-4" />
                  <span>{busy ? 'Verifying…' : 'Restore cloud sync'}</span>
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-start gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-950">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              <div className="space-y-1">
                <p className="font-bold">Verified phone &amp; PIN protection active</p>
                <p className="text-emerald-800">
                  Verified phone:{' '}
                  <span className="font-mono">{shop?.ownerPhone || user?.phone}</span>
                </p>
                <p className="text-emerald-800">
                  Shop ID: <span className="font-mono text-[11px]">{shop?.id}</span>
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
              <p>
                Signing in on a new phone requires both an SMS code and your 4-digit shop PIN (or
                your written one-time recovery code). Unlocking on this phone works offline.
              </p>
            </div>

            <button
              type="button"
              disabled={busy || !isOnline}
              onClick={async () => {
                setError('');
                setMessage('');
                setBusy(true);
                try {
                  const { revokedCount } = await signOutOtherDevices();
                  const summary =
                    revokedCount > 0
                      ? `Signed out ${revokedCount} other verified device${revokedCount === 1 ? '' : 's'}.`
                      : 'All other device sessions have been signed out.';
                  setMessage(summary);
                  notify('Other devices signed out', { detail: summary });
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : 'Could not sign out other devices.'
                  );
                } finally {
                  setBusy(false);
                }
              }}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 text-xs font-bold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              <span>{busy ? 'Revoking sessions…' : 'Sign out all other devices'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
