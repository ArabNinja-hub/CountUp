import React, { useState } from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';

interface RecoveryCodeModalProps {
  recoveryCode: string;
  title?: string;
  onConfirmSaved: () => void;
}

export const RecoveryCodeModal: React.FC<RecoveryCodeModalProps> = ({
  recoveryCode,
  title = 'Save your one-time recovery code',
  onConfirmSaved,
}) => {
  const [copied, setCopied] = useState(false);
  const [confirmedSaved, setConfirmedSaved] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard may be unavailable in insecure contexts; manual write-down still works.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-3 backdrop-blur-xs sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-code-title"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
            <KeyRound className="h-6 w-6" />
          </div>
          <div>
            <h2 id="recovery-code-title" className="text-lg font-extrabold text-slate-900">
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              Shown once only. CountUp never saves a readable copy of this code.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border-2 border-emerald-700 bg-emerald-50/70 p-4 text-center">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">
            Your Shop Recovery Code
          </p>
          <p
            data-testid="one-time-recovery-code"
            className="mt-1.5 select-all font-mono text-xl font-black tracking-widest text-slate-950 sm:text-2xl"
          >
            {recoveryCode}
          </p>
          <button
            type="button"
            onClick={() => void copyCode()}
            className="mt-3 inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-emerald-700/40 bg-white px-3 py-1.5 text-xs font-bold text-emerald-900 hover:bg-emerald-100"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-700" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy code
              </>
            )}
          </button>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <p>
            Write this code in your paper cashbook or keep it somewhere safe away from your phone.
            If you forget your 4-digit PIN or get locked out on a new phone, you will need your SMS
            code <strong>plus</strong> this recovery code to unlock your shop.
          </p>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-800">
          <input
            type="checkbox"
            checked={confirmedSaved}
            onChange={(e) => setConfirmedSaved(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-800 focus:ring-emerald-500"
          />
          <span>I have written down or saved this recovery code in a safe place.</span>
        </label>

        <button
          type="button"
          disabled={!confirmedSaved}
          onClick={onConfirmSaved}
          className="mt-4 flex min-h-[48px] w-full items-center justify-center rounded-xl bg-emerald-900 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-950 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Continue to my shop
        </button>
      </div>
    </div>
  );
};
