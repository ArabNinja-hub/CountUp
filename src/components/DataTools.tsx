import React, { useState } from 'react';
import { AlertTriangle, Download, Upload, X } from 'lucide-react';
import { BackupPreviewOutcome, useShop } from '../context/ShopContext';
import { MAX_BACKUP_FILE_BYTES } from '../services/backupImport';
import { downloadText, ExportKind, ledgerCsv } from '../services/export';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';
import { SyncResolutionAudit } from '../services/syncReview';
import { formatKwacha, formatWhen } from '../utils/format';

export const DataTools: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const {
    shop,
    items,
    archivedItems,
    sales,
    customers,
    creditPayments,
    expenses,
    stockMovements,
    previewShopBackup,
    restoreShopBackup,
    loadSyncResolutionHistory,
    isOnline,
    pendingSyncCount,
  } = useShop();
  const { notify } = useToast();
  const [raw, setRaw] = useState('');
  const [previewOutcome, setPreviewOutcome] = useState<BackupPreviewOutcome | null>(null);
  const [allowNonEmptyShop, setAllowNonEmptyShop] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SyncResolutionAudit[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);

  const loadHistory = async () => {
    setLoadingHistory(true);
    setHistoryError('');
    try {
      setHistory(await loadSyncResolutionHistory());
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Could not load sync review history.');
    } finally {
      setLoadingHistory(false);
    }
  };

  const resetPreview = () => {
    setRaw('');
    setPreviewOutcome(null);
    setAllowNonEmptyShop(false);
    setConfirmingRestore(false);
  };

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setError('');
    resetPreview();
    if (!file || !shop) return;
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setError('The backup is larger than 5 MB. Contact support before importing it.');
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const outcome = await previewShopBackup(text);
      setRaw(text);
      setPreviewOutcome(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the backup.');
    } finally {
      setBusy(false);
    }
  };

  const localHasExistingData =
    items.length > 0 ||
    archivedItems.length > 0 ||
    sales.length > 0 ||
    customers.length > 0 ||
    expenses.length > 0;

  const shopHasExistingData = Boolean(previewOutcome?.shopHasExistingData || localHasExistingData);

  const canConfirmRestore = Boolean(
    previewOutcome &&
    !previewOutcome.alreadyImported &&
    isOnline &&
    pendingSyncCount === 0 &&
    (!shopHasExistingData || allowNonEmptyShop)
  );

  const runRestore = async () => {
    if (!raw || !previewOutcome || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await restoreShopBackup(raw, {
        allowNonEmptyShop: shopHasExistingData && allowNonEmptyShop,
      });
      if (result.alreadyImported || result.status === 'duplicate') {
        notify('Backup already restored', {
          detail:
            'This exact backup file was already imported into this shop; nothing was duplicated.',
        });
      } else {
        notify('Backup records restored', {
          kind: 'success',
          detail: `${result.preview.itemsCount} products, ${result.preview.salesCount} sales, ${result.preview.customersCount} customers and ${result.preview.expensesCount} expenses verified and saved.`,
        });
      }
      resetPreview();
    } catch (err) {
      setConfirmingRestore(false);
      setError(err instanceof Error ? err.message : 'Restore failed. No records were changed.');
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = (kind: ExportKind) => {
    const csv = ledgerCsv(kind, {
      items: [...items, ...archivedItems],
      sales,
      customers,
      creditPayments,
      stockMovements,
    });
    downloadText(
      `countup-${kind}-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
      'text/csv;charset=utf-8'
    );
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-3 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-tools-title"
      >
        <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl space-y-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 id="data-tools-title" className="text-lg font-black text-slate-900">
                Data &amp; backups
              </h2>
              <p className="text-xs text-slate-500 mt-1">Your CountUp records, all in one place.</p>
            </div>
            <button
              onClick={onClose}
              disabled={busy}
              aria-label="Close data and backups"
              className="p-2 rounded-lg hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-bold text-slate-900">Back up CountUp</h3>
            <p className="text-xs text-slate-600">
              Download your current records as JSON (`countup-backup-v2`). Keep this file private:
              it contains customer balances, stock values, expenses, and sales receipts.
            </p>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('export-data'))}
              className="min-h-[44px] w-full rounded-xl bg-emerald-800 text-white text-xs font-bold flex justify-center items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download CountUp backup
            </button>
          </section>

          <section className="space-y-2 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-bold text-slate-900">Export spreadsheets</h3>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['products', 'Products'],
                  ['sales', 'Sales'],
                  ['sale-items', 'Sale items'],
                  ['customers', 'Customers'],
                  ['credit', 'Credit history'],
                  ['stock-movements', 'Stock movements'],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  onClick={() => exportCsv(kind)}
                  className="min-h-[42px] rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold text-slate-700 hover:bg-slate-100"
                >
                  {label} CSV
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-bold text-slate-900">Sync review history</h3>
            <p className="text-xs text-slate-600">
              See the original entries and decisions made when resolving sync conflicts or
              discarding unsyncable entries. This history is stored with your cloud shop.
            </p>
            <button
              onClick={() => void loadHistory()}
              disabled={!isOnline || loadingHistory}
              className="min-h-[42px] w-full rounded-xl border border-slate-300 text-xs font-bold text-slate-800 disabled:opacity-50"
            >
              {loadingHistory
                ? 'Loading…'
                : history
                  ? 'Refresh sync review history'
                  : 'Load sync review history'}
            </button>
            {!isOnline && <p className="text-xs text-amber-800">Connect to load this history.</p>}
            {historyError && (
              <p role="alert" className="text-xs text-rose-700">
                {historyError}
              </p>
            )}
            {history?.length === 0 && (
              <p className="text-xs text-slate-500">No sync reviews found.</p>
            )}
            {history && history.length > 0 && (
              <ul className="max-h-72 overflow-y-auto divide-y divide-slate-200 rounded-xl border border-slate-200">
                {history.map((entry) => (
                  <li key={entry.actionId} className="p-3 text-xs space-y-1 text-slate-700">
                    {entry.kind === 'discard-poison' ? (
                      <>
                        <p className="font-bold text-slate-900">
                          Blocked entry discarded · {entry.poisonActionType || 'sync'}
                        </p>
                        {entry.poisonSummary && <p>Entry: {entry.poisonSummary}</p>}
                        {entry.poisonReason && <p>Reason: {entry.poisonReason}</p>}
                        <p className="text-slate-500">
                          Saved {formatWhen(entry.queuedAt)} · Discarded{' '}
                          {formatWhen(entry.resolvedAt)}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="font-bold text-slate-900">
                          {entry.kind === 'correct-payment'
                            ? 'Payment amount corrected'
                            : entry.kind === 'cancel-payment'
                              ? 'Queued payment cancelled'
                              : 'Queued sale undo cancelled'}{' '}
                          · {entry.customerName}
                        </p>
                        <p>
                          Original: {formatKwacha(entry.originalAmount)}
                          {entry.correctedAmount !== undefined &&
                            ` · Recorded: ${formatKwacha(entry.correctedAmount)}`}{' '}
                          · Server balance before review: {formatKwacha(entry.serverBalanceBefore)}
                        </p>
                        {entry.receipt && <p>Receipt: {entry.receipt}</p>}
                        {entry.originalPayment && (
                          <>
                            <p>
                              Original payment:{' '}
                              {entry.originalPayment.paymentMethod === 'momo'
                                ? 'Mobile Money'
                                : 'Cash'}
                              {entry.originalPayment.note && ` · ${entry.originalPayment.note}`}
                            </p>
                            <p>Payment reference: {entry.originalPayment.id}</p>
                          </>
                        )}
                        {entry.stockRestorations?.length ? (
                          <p>
                            Cancelled stock restoration:{' '}
                            {entry.stockRestorations
                              .map((item) => `${item.itemName} × ${item.quantity}`)
                              .join(', ')}
                          </p>
                        ) : null}
                        <p className="text-slate-500">
                          Saved {formatWhen(entry.queuedAt)} · Reviewed{' '}
                          {formatWhen(entry.resolvedAt)}
                        </p>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-bold text-slate-900">Restore from backup</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Choose a CountUp JSON backup (`countup-backup-v2`) or an earlier legacy v1 JSON
              backup. CountUp runs a dry-run check first so you can review counts, stock value, and
              credit balances before anything is saved.
            </p>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
              Restore requires an internet connection, an owner session, and no pending sync. Files
              may be up to 5 MB and 50,000 primary records (up to 200,000 total rows including sale
              lines and stock movements). By default, backups restore only into a new or empty shop;
              duplicate imports are detected automatically.
            </p>
            <label className="min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-emerald-300 text-emerald-800 text-xs font-bold cursor-pointer hover:bg-emerald-50">
              <Upload className="w-4 h-4" />
              Choose JSON backup file
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => void chooseFile(event)}
                className="sr-only"
                disabled={busy || !isOnline || pendingSyncCount > 0}
              />
            </label>
            {(!isOnline || pendingSyncCount > 0) && (
              <p className="text-xs text-amber-800">
                Connect to the internet and sync all pending entries before choosing a backup.
              </p>
            )}

            {previewOutcome && (
              <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-slate-900">
                      Backup preview · {previewOutcome.preview.sourceShopName}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Format:{' '}
                      {previewOutcome.preview.format === 'countup-backup-v2'
                        ? 'CountUp v2 JSON'
                        : 'Earlier v1 JSON'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={resetPreview}
                    disabled={busy}
                    className="text-[11px] font-bold text-slate-600 hover:text-slate-900"
                  >
                    Clear
                  </button>
                </div>

                <dl className="grid grid-cols-2 gap-2 rounded-xl bg-white border border-slate-200 p-2.5">
                  <div>
                    <dt className="text-[11px] text-slate-500">Products</dt>
                    <dd className="font-bold text-slate-900">
                      {previewOutcome.preview.itemsCount}
                      {previewOutcome.preview.archivedItemsCount > 0
                        ? ` (${previewOutcome.preview.archivedItemsCount} archived)`
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500">Sales</dt>
                    <dd className="font-bold text-slate-900">
                      {previewOutcome.preview.salesCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500">Customers</dt>
                    <dd className="font-bold text-slate-900">
                      {previewOutcome.preview.customersCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500">Expenses</dt>
                    <dd className="font-bold text-slate-900">
                      {previewOutcome.preview.expensesCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500">Total stock value</dt>
                    <dd className="font-bold text-emerald-800">
                      {formatKwacha(previewOutcome.preview.totalStockValueNgwee / 100)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500">Total credit owed</dt>
                    <dd className="font-bold text-amber-800">
                      {formatKwacha(previewOutcome.preview.totalOwedNgwee / 100)}
                    </dd>
                  </div>
                </dl>

                {previewOutcome.alreadyImported && (
                  <p
                    role="status"
                    className="rounded-xl bg-amber-50 border border-amber-200 p-2.5 text-amber-900 font-semibold"
                  >
                    This exact backup file was already imported into this shop. Restoring again is
                    blocked so records are never duplicated.
                  </p>
                )}

                {!previewOutcome.alreadyImported && shopHasExistingData && (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 space-y-2 text-amber-950">
                    <p className="font-bold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 shrink-0" /> This shop already has data
                    </p>
                    <p>
                      Backups restore into an empty shop by default. Check the option below only if
                      you want to merge non-conflicting records from this backup into your current
                      shop (any conflicting record ID will roll back the entire import).
                    </p>
                    <label className="flex items-start gap-2 cursor-pointer font-semibold">
                      <input
                        type="checkbox"
                        checked={allowNonEmptyShop}
                        onChange={(event) => setAllowNonEmptyShop(event.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        Allow importing into this non-empty shop without overwriting existing
                        records
                      </span>
                    </label>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setConfirmingRestore(true)}
                  disabled={busy || !canConfirmRestore}
                  className="w-full min-h-[44px] rounded-xl bg-emerald-800 text-white font-bold disabled:opacity-50"
                >
                  {busy ? 'Restoring…' : 'Review & confirm restore'}
                </button>
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="text-xs font-semibold text-rose-800 rounded-xl bg-rose-50 border border-rose-200 p-3"
              >
                {error}
              </p>
            )}
          </section>
        </div>
      </div>

      {confirmingRestore && previewOutcome && (
        <ConfirmDialog
          title="Confirm backup restore"
          description={
            <div className="space-y-2 text-xs text-slate-700">
              <p>
                Restore <strong>{previewOutcome.preview.itemsCount}</strong> products,{' '}
                <strong>{previewOutcome.preview.salesCount}</strong> sales,{' '}
                <strong>{previewOutcome.preview.customersCount}</strong> customers, and{' '}
                <strong>{previewOutcome.preview.expensesCount}</strong> expenses from{' '}
                <strong>{previewOutcome.preview.sourceShopName}</strong>?
              </p>
              <p>
                Total stock value:{' '}
                <strong>{formatKwacha(previewOutcome.preview.totalStockValueNgwee / 100)}</strong> ·
                Total owed:{' '}
                <strong>{formatKwacha(previewOutcome.preview.totalOwedNgwee / 100)}</strong>. All
                records and ledger invariants are verified atomically before saving.
              </p>
            </div>
          }
          confirmLabel="Confirm & restore backup"
          busy={busy}
          onConfirm={() => void runRestore()}
          onCancel={() => setConfirmingRestore(false)}
        />
      )}
    </>
  );
};
