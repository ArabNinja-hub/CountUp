import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import { X, Receipt } from 'lucide-react';
import { ExpenseCategory } from '../types';

interface ExpensesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExpensesModal: React.FC<ExpensesModalProps> = ({ isOpen, onClose }) => {
  const { addExpense, t } = useShop();

  const [category, setCategory] = useState<ExpenseCategory>('rent');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      alert('Please enter a valid amount');
      return;
    }

    await addExpense(category, parsedAmount, note.trim() || undefined);
    setAmount('');
    setNote('');
    onClose();
  };

  const categories: { id: ExpenseCategory; label: string }[] = [
    { id: 'rent', label: t.categories.rent },
    { id: 'transport', label: t.categories.transport },
    { id: 'restock', label: t.categories.restock },
    { id: 'council_fee', label: t.categories.council_fee },
    { id: 'helper_wage', label: t.categories.helper_wage },
    { id: 'other', label: t.categories.other },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
      <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <h3 className="font-extrabold text-sm text-slate-900">{t.addExpense}</h3>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 mt-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t.expenseCategory}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t.expenseAmount} (K) *
            </label>
            <input
              type="number"
              step="any"
              required
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 15 (Council ticket), 40 (Transport)"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-base font-extrabold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t.expenseNote}
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Canter truck, helper lunch"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              className="w-full min-h-[44px] bg-emerald-800 hover:bg-emerald-900 text-white py-2.5 px-4 rounded-xl font-bold text-xs shadow-xs transition-colors cursor-pointer"
            >
              Save Expense
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
