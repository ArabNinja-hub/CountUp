import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import { KeyRound, Loader2, X } from 'lucide-react';

interface ChangePinModalProps {
  onClose: () => void;
}

/** Lets a shop owner replace their 4-digit login PIN. */
export const ChangePinModal: React.FC<ChangePinModalProps> = ({ onClose }) => {
  const { changePin } = useShop();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setError('');
    if (!/^\d{4}$/.test(newPin)) {
      setError('Your new PIN must be exactly 4 numbers.');
      return;
    }
    if (newPin !== confirmPin) {
      setError('The two new PINs do not match.');
      return;
    }
    if (newPin === currentPin) {
      setError('Choose a PIN different from your current one.');
      return;
    }

    setIsSaving(true);
    try {
      const ok = await changePin(currentPin, newPin);
      if (!ok) {
        setError('That is not your current PIN. Please try again.');
        return;
      }
      onClose();
    } catch {
      setError('Could not save the PIN on this device. Free some storage and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-base font-mono text-center tracking-widest text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white';

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-pin-title"
    >
      <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 id="change-pin-title" className="font-extrabold text-sm text-slate-900">
                Change your PIN
              </h2>
              <p className="text-[11px] text-slate-500">4 numbers you will remember</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label
              className="block text-[11px] font-bold text-slate-700 mb-1"
              htmlFor="current-pin"
            >
              Current PIN
            </label>
            <input
              id="current-pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))}
              disabled={isSaving}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-700 mb-1" htmlFor="new-pin">
              New PIN
            </label>
            <input
              id="new-pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              disabled={isSaving}
              className={inputClass}
            />
          </div>
          <div>
            <label
              className="block text-[11px] font-bold text-slate-700 mb-1"
              htmlFor="confirm-pin"
            >
              Repeat new PIN
            </label>
            <input
              id="confirm-pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              disabled={isSaving}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-2.5 text-[11px]">
              {error}
            </p>
          )}

          <p className="text-[10px] text-slate-500">
            Avoid 1234, 0000, or your birth year. Countup staff will never ask for your PIN.
          </p>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={isSaving}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={isSaving || currentPin.length !== 4 || newPin.length !== 4}
              className="flex-1 bg-emerald-800 hover:bg-emerald-900 text-white font-bold py-2.5 rounded-xl text-xs flex items-center justify-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isSaving ? 'Saving…' : 'Save PIN'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
