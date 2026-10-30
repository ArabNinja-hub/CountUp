import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Customer } from '../types';
import { useShop } from '../context/ShopContext';
import { sanitizePhoneInput } from '../utils/format';
import { useToast } from './Toast';

export const CustomerEditor: React.FC<{ customer: Customer; onClose: () => void }> = ({
  customer,
  onClose,
}) => {
  const { updateCustomer } = useShop();
  const { notify } = useToast();
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone || '');
  const [notes, setNotes] = useState(customer.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await updateCustomer(customer.id, { name, phone, notes });
      notify('Customer updated');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this customer.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-customer-title"
    >
      <form
        onSubmit={save}
        className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl space-y-4"
      >
        <div className="flex justify-between items-center">
          <h3 id="edit-customer-title" className="font-extrabold text-slate-900">
            Edit customer
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2">
            <X className="w-4 h-4" />
          </button>
        </div>
        <label className="block text-xs font-bold text-slate-700">
          Name
          <input
            required
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
          />
        </label>
        <label className="block text-xs font-bold text-slate-700">
          Phone
          <input
            value={phone}
            inputMode="tel"
            onChange={(e) => setPhone(sanitizePhoneInput(e.target.value))}
            className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
          />
        </label>
        <label className="block text-xs font-bold text-slate-700">
          Notes
          <textarea
            value={notes}
            maxLength={200}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-xl p-3 text-sm"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="w-full min-h-[44px] rounded-xl bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save customer'}
        </button>
      </form>
    </div>
  );
};
