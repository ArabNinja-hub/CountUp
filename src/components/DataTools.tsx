import React, { useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import { useShop } from '../context/ShopContext';
import { prepareLegacyBackupImport, LegacyBackupImport } from '../services/backupImport';
import { downloadText, ExportKind, ledgerCsv } from '../services/export';
import { useToast } from './Toast';

export const DataTools: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const {
    shop,
    items,
    archivedItems,
    sales,
    customers,
    creditPayments,
    stockMovements,
    importLegacyBackup,
    isOnline,
    pendingSyncCount,
  } = useShop();
  const { notify } = useToast();
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<LegacyBackupImport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setError('');
    setPreview(null);
    setRaw('');
    if (!file || !shop) return;
    if (file.size > 5_000_000) {
      setError('The backup is larger than 5 MB. Contact support before importing it.');
      return;
    }
    try {
      const text = await file.text();
      const result = prepareLegacyBackupImport(text, shop.id);
      setRaw(text);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the backup.');
    }
  };
  const runImport = async () => {
    if (!raw || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await importLegacyBackup(raw);
      notify('Backup records imported', {
        detail: `${result.items.length} products, ${result.sales.length} sales and ${result.customers.length} customers added to CountUp.`,
      });
      setRaw('');
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed. No records were replaced.');
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
            Download your current records as JSON. Keep this private: it contains customer and sales
            information. CountUp does not yet restore this file in the app; keep your synced data
            and this export safe.
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
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-bold text-slate-900">Import an earlier backup</h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Choose a full legacy v1 JSON backup to add its products, receipts, credit history and
            stock movements to your shop. Existing records, your plan and PIN are not replaced.
            Duplicate imports are refused. The original backup is not changed.
          </p>
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
            Import requires an internet connection, an owner session and no pending sync. Files may
            be up to 5 MB and contain up to 400 resulting records. The current CountUp JSON export
            is not yet supported for restore.
          </p>
          <label className="min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-emerald-300 text-emerald-800 text-xs font-bold cursor-pointer hover:bg-emerald-50">
            <Upload className="w-4 h-4" />
            Choose legacy JSON backup
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => void chooseFile(event)}
              className="sr-only"
              disabled={busy}
            />
          </label>
          {preview && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-2">
              <p className="font-bold text-slate-900">
                Ready to import from {preview.sourceShopName}
              </p>
              <p>
                {preview.items.length} products ({preview.items.filter((i) => i.isDeleted).length}{' '}
                archived), {preview.sales.length} receipts, {preview.customers.length} customers,{' '}
                {preview.creditPayments.length} repayments and {preview.stockMovements.length} stock
                movements.
              </p>
              <button
                onClick={() => void runImport()}
                disabled={busy || !isOnline || pendingSyncCount > 0}
                className="w-full min-h-[44px] rounded-xl bg-emerald-800 text-white font-bold disabled:opacity-50"
              >
                {busy ? 'Importing…' : 'Add these records to CountUp'}
              </button>
              {(!isOnline || pendingSyncCount > 0) && (
                <p className="text-amber-800">Connect and sync all pending entries first.</p>
              )}
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
  );
};
