import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { SyncConflictReview, SyncReviewDecision } from '../services/syncReview';
import { formatKwacha, formatWhen, sanitizeMoneyInput } from '../utils/format';
import { parseKwachaToNgwee, toNgwee } from '../utils/money';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

/** Never guesses whether a payment was duplicated, overpaid or refunded. */
export const SyncReviewDialog: React.FC<{ actionId: string; onClose: () => void }> = ({
  actionId,
  onClose,
}) => {
  const { loadSyncReview, resolveSyncReview, syncNow } = useShop();
  const { notify } = useToast();
  const [review, setReview] = useState<SyncConflictReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<'correct' | 'cancel' | 'keep' | ''>('');
  const [amount, setAmount] = useState('');
  const [checked, setChecked] = useState(false);
  const [decision, setDecision] = useState<SyncReviewDecision | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  // Context functions may change identity on other renders; use the current one
  // when the user explicitly reloads, rather than restarting the request.
  const loadRef = useRef(loadSyncReview);
  loadRef.current = loadSyncReview;
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    setReview(null);
    setChoice('');
    setChecked(false);
    setAmount('');
    try {
      setReview(await loadRef.current(actionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the latest server balance.');
    } finally {
      setLoading(false);
    }
  }, [actionId]);
  useEffect(() => {
    void reload();
    closeRef.current?.focus();
  }, [reload]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !decision) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, decision, onClose]);

  const prepare = () => {
    if (!review || !checked) return;
    setError('');
    if (choice === 'correct') {
      try {
        const cents = parseKwachaToNgwee(amount);
        if (cents > toNgwee(review.serverBalance) || cents >= toNgwee(review.originalAmount))
          throw new Error('Enter the amount actually received, no more than the server balance.');
        setDecision({ kind: 'correct-payment', amount: cents / 100 });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Enter a valid amount.');
      }
    } else if (choice === 'cancel') setDecision({ kind: 'cancel-payment' });
    else if (choice === 'keep') setDecision({ kind: 'keep-sale' });
  };
  const confirm = async () => {
    if (!review || !decision || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await resolveSyncReview(review, decision);
      notify(result === 'resolved' ? 'Sync review saved' : 'This entry was already processed', {
        kind: 'success',
        detail:
          result === 'resolved'
            ? 'The remaining entries will continue in order.'
            : 'No second change was made. The remaining entries will continue in order.',
      });
      onClose();
    } catch (err) {
      setDecision(null);
      setError(err instanceof Error ? err.message : 'Could not save this review.');
    } finally {
      setBusy(false);
    }
  };
  const description =
    decision?.kind === 'correct-payment'
      ? `Record ${formatKwacha(decision.amount)} as the payment instead of ${formatKwacha(review?.originalAmount ?? 0)}. The difference will not be recorded as money received or customer credit. The original entry and this decision are kept in sync review history.`
      : decision?.kind === 'cancel-payment'
        ? `Cancel the ${formatKwacha(review?.originalAmount ?? 0)} queued payment. No payment will be recorded for it. The original entry and this decision are kept in sync review history.`
        : 'Keep the sale and cancel this queued undo. Its stock restoration and credit reduction will not be applied. Check your physical stock. The original request and this decision are kept in sync review history.';

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/60 p-3 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-review-title"
      >
        <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="sync-review-title" className="text-lg font-black text-slate-900">
                Review waiting entry
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Check your records before making a choice.
              </p>
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              disabled={busy}
              aria-label="Close sync review"
              className="p-2 rounded-lg hover:bg-slate-100 disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {loading && <p className="text-sm text-slate-600">Checking the latest server balance…</p>}
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800"
            >
              {error}
            </p>
          )}
          {!loading && !review && (
            <button
              onClick={() => void reload()}
              className="min-h-[44px] w-full rounded-xl border border-slate-300 text-xs font-bold"
            >
              Try loading again
            </button>
          )}
          {review && (
            <>
              <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1.5">
                <p>
                  <strong>Customer:</strong> {review.customerName}
                </p>
                <p>
                  <strong>
                    {review.kind === 'payment'
                      ? 'Payment saved on this device'
                      : 'Sale undo requested'}
                    :
                  </strong>{' '}
                  {formatKwacha(review.originalAmount)}
                </p>
                {review.receipt && (
                  <p>
                    <strong>Receipt:</strong> {review.receipt}
                  </p>
                )}
                <p>
                  <strong>Saved:</strong> {formatWhen(review.queuedAt)}
                </p>
                {!review.alreadyProcessed && (
                  <p>
                    <strong>Current server balance:</strong> {formatKwacha(review.serverBalance)}
                  </p>
                )}
              </div>
              {review.alreadyProcessed || review.canRetry ? (
                <div className="space-y-3">
                  <p className="text-sm text-slate-700">
                    {review.alreadyProcessed
                      ? 'This entry was already processed, or this sale was already undone on another device. Retry sync to update this phone; no second change will be made.'
                      : 'The server balance has changed and this entry can now be retried without changing it.'}
                  </p>
                  <button
                    onClick={() => {
                      onClose();
                      void syncNow();
                    }}
                    className="min-h-[44px] w-full rounded-xl bg-emerald-800 text-white text-xs font-bold"
                  >
                    Retry sync without changing the entry
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950 space-y-2">
                    <p className="font-bold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" /> The server balance is lower than this
                      entry.
                    </p>
                    <p>
                      This entry and later entries are still on this device. Check payments and
                      receipts on every device. CountUp cannot tell if money was paid twice,
                      overpaid or refunded.
                    </p>
                    <p>
                      {review.kind === 'payment'
                        ? 'If the full original amount was really received, leave this payment waiting.'
                        : 'If the sale should still be undone or a refund is needed, leave this undo waiting.'}{' '}
                      CountUp does not yet record overpayments or refunds; reconcile outside the app
                      or seek support.
                    </p>
                  </div>
                  <fieldset className="space-y-2 text-xs text-slate-800">
                    <legend className="font-bold text-sm mb-2">What did you verify?</legend>
                    {review.kind === 'payment' ? (
                      <>
                        <label className="flex gap-2 rounded-xl border border-slate-200 p-3 cursor-pointer">
                          <input
                            type="radio"
                            name="sync-choice"
                            checked={choice === 'correct'}
                            onChange={() => {
                              setChoice('correct');
                              setChecked(false);
                            }}
                          />
                          <span>
                            <strong>The payment was entered with the wrong amount.</strong> Record
                            the correct amount actually received.
                          </span>
                        </label>
                        {choice === 'correct' && (
                          <div className="pl-4 space-y-2">
                            <label className="block font-bold">
                              Correct amount actually received (K)
                              <input
                                value={amount}
                                onChange={(event) =>
                                  setAmount(sanitizeMoneyInput(event.target.value))
                                }
                                inputMode="decimal"
                                className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm"
                              />
                            </label>
                            <p className="text-rose-800">
                              Only this amount will be recorded. The difference is not recorded as
                              money received or customer credit.
                            </p>
                          </div>
                        )}
                        <label className="flex gap-2 rounded-xl border border-slate-200 p-3 cursor-pointer">
                          <input
                            type="radio"
                            name="sync-choice"
                            checked={choice === 'cancel'}
                            onChange={() => {
                              setChoice('cancel');
                              setChecked(false);
                            }}
                          />
                          <span>
                            <strong>This payment was never made or is a duplicate.</strong> Cancel
                            this queued payment; no payment will be recorded for it.
                          </span>
                        </label>
                      </>
                    ) : (
                      <label className="flex gap-2 rounded-xl border border-slate-200 p-3 cursor-pointer">
                        <input
                          type="radio"
                          name="sync-choice"
                          checked={choice === 'keep'}
                          onChange={() => {
                            setChoice('keep');
                            setChecked(false);
                          }}
                        />
                        <span>
                          <strong>Keep the sale; cancel this queued undo.</strong> Stock will not be
                          restored by this undo. Count the actual stock and adjust it if needed. No
                          refund is recorded.
                        </span>
                      </label>
                    )}
                  </fieldset>
                  {choice && (
                    <>
                      <label className="flex gap-2 text-xs text-slate-800">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => setChecked(event.target.checked)}
                        />
                        <span>
                          I checked the records and understand what this choice will change.
                        </span>
                      </label>
                      <button
                        onClick={prepare}
                        disabled={!checked || busy}
                        className="min-h-[44px] w-full rounded-xl bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
                      >
                        Review my choice
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => void reload()}
                    disabled={busy}
                    className="min-h-[40px] w-full rounded-xl text-emerald-800 text-xs font-bold flex items-center justify-center gap-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh server balance
                  </button>
                  <p className="text-[11px] text-slate-500 text-center">
                    Close this screen to leave everything waiting unchanged.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {decision && (
        <ConfirmDialog
          title="Confirm sync review"
          description={<p>{description}</p>}
          confirmLabel="Confirm and continue"
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setDecision(null)}
        />
      )}
    </>,
    document.body
  );
};
