import React, { useState } from 'react';
import { AlertTriangle, History, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { Item } from '../types';
import { formatWhen, sanitizeIntegerInput } from '../utils/format';
import { useToast } from './Toast';

export const StockTools: React.FC<{
  adjustingItem: Item | null;
  onCloseAdjustment: () => void;
}> = ({ adjustingItem, onCloseAdjustment }) => {
  const { stockMovements, stockConflicts, resolveStockConflict, adjustStock } = useShop();
  const { notify } = useToast();
  const [showHistory, setShowHistory] = useState(false);
  const [mode, setMode] = useState<'add' | 'subtract' | 'set'>('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const openConflicts = stockConflicts.filter((conflict) => !conflict.resolved);
  const markRecounted = async (conflictId: string) => {
    try {
      await resolveStockConflict(conflictId);
    } catch (err) {
      notify('Could not mark the recount', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };
  const close = () => {
    setQuantity('');
    setReason('');
    setError('');
    setMode('add');
    onCloseAdjustment();
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adjustingItem || busy) return;
    if (!quantity.trim()) {
      setError('Enter a whole quantity.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adjustStock(
        adjustingItem.id,
        mode,
        Number(quantity),
        reason || (mode === 'set' ? 'Physical recount' : 'Stock adjustment')
      );
      notify(`${adjustingItem.name} stock updated`, { kind: 'success' });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust stock.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {openConflicts.length > 0 && (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 space-y-3">
          <h3 className="text-sm font-bold text-amber-950 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Stock recount needed
          </h3>
          <p className="text-xs text-amber-900">
            Sales were kept, but another device recorded stock changes at the same time. Count the
            actual stock and use Adjust stock before marking the notice reviewed.
          </p>
          {openConflicts.map((conflict) => (
            <div key={conflict.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="flex-1 min-w-[150px] font-semibold">
                {conflict.itemName}: {conflict.shortfall}{' '}
                {conflict.shortfall === 1 ? 'unit' : 'units'} short (requested {conflict.requested},
                had {conflict.available})
              </span>
              <button
                onClick={() => void markRecounted(conflict.id)}
                className="min-h-[40px] px-3 rounded-lg bg-amber-900 text-white font-bold"
              >
                Mark recounted
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
        <button
          onClick={() => setShowHistory(!showHistory)}
          aria-expanded={showHistory}
          className="w-full flex items-center justify-between text-left text-sm font-bold text-slate-900"
        >
          <span className="flex items-center gap-2">
            <History className="w-4 h-4 text-emerald-700" />
            Stock movement history
          </span>
          <span className="text-xs text-emerald-700">{showHistory ? 'Hide' : 'Show'}</span>
        </button>
        {showHistory &&
          (stockMovements.length === 0 ? (
            <p className="text-xs text-slate-500 mt-3">
              New stock changes and imported history will appear here. Earlier CountUp changes were
              not recorded.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 mt-2 max-h-80 overflow-y-auto">
              {stockMovements
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 100)
                .map((movement) => (
                  <li
                    key={movement.id}
                    className="py-2.5 flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 truncate">
                        {movement.itemName} · {movement.reason}
                      </p>
                      <p className="text-slate-500 mt-0.5">
                        {formatWhen(movement.createdAt)} · {movement.previousQuantity} →{' '}
                        {movement.newQuantity}
                      </p>
                    </div>
                    <span className="font-bold tabular-nums shrink-0">
                      {movement.delta > 0 ? '+' : ''}
                      {movement.delta}
                    </span>
                  </li>
                ))}
            </ul>
          ))}
      </section>
      {adjustingItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="adjust-title"
        >
          <form
            onSubmit={save}
            className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 id="adjust-title" className="font-extrabold text-slate-900">
                  Adjust stock
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {adjustingItem.name} · {adjustingItem.quantity} on hand
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close adjustment"
                className="p-2 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <label className="block text-xs font-bold text-slate-700">
              Adjustment
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
              >
                <option value="add">Add stock</option>
                <option value="subtract">Remove stock</option>
                <option value="set">Set to physical count</option>
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-700">
              Quantity
              <input
                value={quantity}
                onChange={(e) => setQuantity(sanitizeIntegerInput(e.target.value))}
                inputMode="numeric"
                className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
                required
              />
            </label>
            <label className="block text-xs font-bold text-slate-700">
              Reason (optional)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                placeholder="e.g. delivery or damaged goods"
                className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs font-semibold text-rose-700">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-xl bg-slate-100 text-xs font-bold"
              >
                Cancel
              </button>
              <button
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-xl bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save adjustment'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
};
