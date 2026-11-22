import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';

interface DeleteShopModalProps {
  onClose: () => void;
}

/**
 * Permanent, owner-initiated shop deletion via server Edge Function.
 *
 * Deletion is irreversible, so both the exact shop name AND the 4-digit PIN
 * must be entered before the button unlocks.
 */
export const DeleteShopModal: React.FC<DeleteShopModalProps> = ({ onClose }) => {
  const { shop, deleteShopAccount, items, sales, customers, expenses, isOnline, pendingSyncCount } =
    useShop();
  const [confirmation, setConfirmation] = useState('');
  const [pin, setPin] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  const matches = confirmation.trim().toLowerCase() === (shop?.name || '').trim().toLowerCase();
  const pinValid = /^\d{4}$/.test(pin);
  const canDelete = matches && pinValid && isOnline && pendingSyncCount === 0 && !isDeleting;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    setError('');
    try {
      const ok = await deleteShopAccount(confirmation.trim(), pin);
      if (!ok) throw new Error('Deletion did not complete');
      onClose();
    } catch {
      setError(
        'Deletion did not finish. Check your 4-digit PIN and internet connection, then try again.'
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-shop-title"
    >
      <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 id="delete-shop-title" className="font-extrabold text-sm text-slate-900">
                Delete shop &amp; all data
              </h2>
              <p className="text-[11px] text-slate-500">This cannot be undone.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 text-xs text-slate-700 space-y-3">
          <p className="leading-relaxed">
            Deleting <strong className="text-slate-900">{shop?.name}</strong> permanently removes it
            from this phone and from the cloud:
          </p>

          <ul className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1 text-[11px] text-slate-600">
            <li>{items.length} stock items</li>
            <li>{sales.length} sales</li>
            <li>{customers.length} credit customers</li>
            <li>{expenses.length} expenses</li>
          </ul>
          <p className="text-rose-700 font-semibold text-[11px]">
            Export a backup first if you need these records — they cannot be recovered. Free trial
            history for this phone number is kept so trials cannot be repeated.
          </p>

          {!isOnline && (
            <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-2.5 text-[11px]">
              Connect to the internet to delete this shop from the cloud.
            </p>
          )}
          {pendingSyncCount > 0 && (
            <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-2.5 text-[11px]">
              Sync your {pendingSyncCount} waiting entr{pendingSyncCount === 1 ? 'y' : 'ies'} before
              deleting this shop.
            </p>
          )}

          <div>
            <label
              className="block text-[11px] font-bold text-slate-700 mb-1"
              htmlFor="delete-confirm"
            >
              Type <span className="font-mono">{shop?.name}</span> to confirm
            </label>
            <input
              id="delete-confirm"
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              disabled={isDeleting}
              autoComplete="off"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-600 focus:bg-white"
            />
          </div>

          <div>
            <label
              className="block text-[11px] font-bold text-slate-700 mb-1"
              htmlFor="delete-pin-confirm"
            >
              Enter your 4-digit PIN
            </label>
            <input
              id="delete-pin-confirm"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              disabled={isDeleting}
              autoComplete="off"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm font-mono tracking-widest text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-600 focus:bg-white"
            />
          </div>

          {error && (
            <p className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-2.5 text-[11px]">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={isDeleting}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={!canDelete}
              className="flex-1 bg-rose-700 hover:bg-rose-800 text-white font-bold py-2.5 rounded-xl text-xs flex items-center justify-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isDeleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              <span>{isDeleting ? 'Deleting…' : 'Delete forever'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
