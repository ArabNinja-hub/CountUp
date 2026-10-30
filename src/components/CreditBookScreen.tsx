import React, { useState, useMemo, useRef } from 'react';
import { useShop } from '../context/ShopContext';
import {
  BookUser,
  Send,
  MessageSquare,
  CheckCircle2,
  X,
  Phone,
  Copy,
  ExternalLink,
  Search,
  UserPlus,
  Receipt,
} from 'lucide-react';
import { Customer } from '../types';
import { useToast } from './Toast';
import {
  formatKwacha,
  formatKwachaCompact,
  sanitizeMoneyInput,
  sanitizePhoneInput,
} from '../utils/format';
import { customerStatement } from '../utils/ledger';
import { parseKwachaToNgwee } from '../utils/money';
import { CustomerEditor } from './CustomerEditor';

export const CreditBookScreen: React.FC = () => {
  const { customers, sales, creditPayments, addCustomer, recordCreditPayment, t, shop, language } =
    useShop();
  const { notify } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [isAddCustomerOpen, setIsAddCustomerOpen] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [customerError, setCustomerError] = useState('');
  const [isCustomerSaving, setIsCustomerSaving] = useState(false);
  const customerSavingRef = useRef(false);

  // Payment recording state
  const [paymentModalCustomer, setPaymentModalCustomer] = useState<Customer | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'momo'>('cash');
  const [paymentError, setPaymentError] = useState('');
  const [isPaymentSaving, setIsPaymentSaving] = useState(false);
  const paymentSavingRef = useRef(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);

  // WhatsApp Reminder modal state
  const [reminderCustomer, setReminderCustomer] = useState<Customer | null>(null);
  const [customReminderText, setCustomReminderText] = useState('');
  const [copiedToast, setCopiedToast] = useState(false);

  // Selected customer for detailed ledger
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const customerDetailsRef = useRef<HTMLDivElement>(null);
  const selectCustomer = (id: string) => {
    setSelectedCustomerId(id);
    if (window.innerWidth < 1024) {
      window.requestAnimationFrame(() =>
        customerDetailsRef.current?.scrollIntoView?.({ block: 'start' })
      );
    }
  };

  // Total credit owed across all customers
  const totalMoneyOwed = useMemo(() => {
    return customers.reduce((sum, c) => sum + Math.max(0, c.totalOwed), 0);
  }, [customers]);
  const owingCustomerCount = customers.filter((customer) => customer.totalOwed > 0).length;

  const sortedCustomers = useMemo(() => {
    let result = [...customers];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(q) || (c.phone && c.phone.includes(q))
      );
    }
    // Customers with debt come first, sorted highest debt first
    return result.sort((a, b) => b.totalOwed - a.totalOwed);
  }, [customers, searchQuery]);

  const activeCustomer = useMemo(() => {
    if (selectedCustomerId) {
      return customers.find((c) => c.id === selectedCustomerId) || null;
    }
    return sortedCustomers[0] || null;
  }, [customers, selectedCustomerId, sortedCustomers]);

  // Generate polite pre-written WhatsApp message based on current language
  const getPrewrittenReminder = (customer: Customer): string => {
    const shopName = shop?.name || 'our shop';
    const amountStr = `K ${customer.totalOwed.toFixed(2)}`;

    if (language === 'bem') {
      return `Muli shani ba ${customer.name}, nine ba ${shopName}. Tusanshisheko ukumwibukishako pamakongole ya ${amountStr}. Nga kuli ifili bwino kuti mwatulipilako lelo. Natotela sana pakutushitako!`;
    } else if (language === 'nya') {
      return `Muli bwanji ba ${customer.name}, ndine a ${shopName}. Tikukukumbusani mwaulemu za ngawa yanu ya ${amountStr}. Ngati zingatheke mutithandizeko polipira lero. Zikomo kwambiri pogula pa shopu yathu!`;
    } else {
      return `Muli bwanji ${customer.name}, this is ${shopName}. Just a polite reminder that your credit balance is ${amountStr}. Whenever you are ready, please pass by to clear your account. Thank you for supporting our shop!`;
    }
  };

  // Open reminder modal
  const handleOpenReminder = (customer: Customer) => {
    setReminderCustomer(customer);
    setCustomReminderText(getPrewrittenReminder(customer));
  };

  // Launch WhatsApp
  const handleSendWhatsApp = () => {
    if (!reminderCustomer) return;
    const cleanPhone = reminderCustomer.phone ? reminderCustomer.phone.replace(/\D/g, '') : '';
    let formattedPhone = cleanPhone;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '260' + formattedPhone.slice(1);
    } else if (!formattedPhone.startsWith('260') && formattedPhone.length === 9) {
      formattedPhone = '260' + formattedPhone;
    }

    const encodedText = encodeURIComponent(customReminderText);
    const url = formattedPhone
      ? `https://wa.me/${formattedPhone}?text=${encodedText}`
      : `https://wa.me/?text=${encodedText}`;

    window.open(url, '_blank');
  };

  const handleCopyReminder = async () => {
    try {
      if (!navigator.clipboard)
        throw new Error('Clipboard access is not available on this device.');
      await navigator.clipboard.writeText(customReminderText);
      setCopiedToast(true);
      setTimeout(() => setCopiedToast(false), 2500);
    } catch (err) {
      notify('Could not copy the reminder', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please copy the text manually.',
      });
    }
  };

  // Save new customer
  const handleAddCustomerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim() || customerSavingRef.current) return;
    customerSavingRef.current = true;
    setIsCustomerSaving(true);
    setCustomerError('');
    try {
      const newCust = await addCustomer(newCustName.trim(), newCustPhone.trim() || undefined);
      notify(`${newCust.name} added to your credit book`, {
        kind: 'success',
        detail: newCust.phone
          ? 'You can send WhatsApp reminders from their statement.'
          : 'Add a phone number later to send WhatsApp reminders.',
      });
      setNewCustName('');
      setNewCustPhone('');
      setIsAddCustomerOpen(false);
      setSelectedCustomerId(newCust.id);
    } catch (err) {
      setCustomerError(err instanceof Error ? err.message : 'Could not save that customer.');
    } finally {
      customerSavingRef.current = false;
      setIsCustomerSaving(false);
    }
  };

  // Record payment submit — validates against the real balance and tells the
  // shopkeeper exactly what is left afterwards.
  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentModalCustomer || paymentSavingRef.current) return;
    setPaymentError('');

    let amount: number;
    try {
      amount = parseKwachaToNgwee(paymentAmount) / 100;
    } catch {
      setPaymentError('Enter a valid amount with at most two decimal places.');
      return;
    }
    if (amount > paymentModalCustomer.totalOwed) {
      setPaymentError(
        `${paymentModalCustomer.name} owes ${formatKwacha(paymentModalCustomer.totalOwed)}. Enter that amount or less.`
      );
      return;
    }

    paymentSavingRef.current = true;
    setIsPaymentSaving(true);
    try {
      const { applied, remaining } = await recordCreditPayment(
        paymentModalCustomer.id,
        amount,
        paymentNote.trim() || undefined,
        paymentMethod
      );
      notify(`Payment recorded — ${formatKwacha(applied)}`, {
        kind: 'success',
        detail:
          remaining > 0
            ? `${paymentModalCustomer.name} still owes ${formatKwacha(remaining)}`
            : `${paymentModalCustomer.name}'s account is now cleared`,
      });
      setPaymentModalCustomer(null);
      setPaymentAmount('');
      setPaymentNote('');
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Could not save that payment.');
    } finally {
      paymentSavingRef.current = false;
      setIsPaymentSaving(false);
    }
  };

  // Running balances are computed from the same sales and repayment ledger used in reports.
  const getCustomerTransactions = (customerId: string) =>
    customerStatement(customerId, sales, creditPayments);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-xs">
        <div>
          <p className="text-xs font-bold text-amber-900">{t.totalCreditOwed}</p>
          <p className="mt-1 text-2xl font-black tabular-nums tracking-tight text-amber-950">
            {formatKwacha(totalMoneyOwed)}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {owingCustomerCount} {owingCustomerCount === 1 ? 'customer owes' : 'customers owe'} you
            · {customers.filter((customer) => customer.totalOwed === 0).length} cleared
          </p>
        </div>
        <button
          onClick={() => {
            setCustomerError('');
            setIsAddCustomerOpen(true);
          }}
          className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-4 text-xs font-bold text-white shadow-xs transition-colors hover:bg-emerald-900"
        >
          <UserPlus className="h-4 w-4" />
          <span>{t.newCustomer.replace(/^\+\s*/, '')}</span>
        </button>
      </div>

      {/* Main Responsive Grid: Left customer list, Right detailed customer ledger statement */}
      <div className="lg:grid lg:grid-cols-12 lg:gap-6 items-start">
        {/* Left Column: Customer Search & List */}
        <div className="lg:col-span-6 xl:col-span-5 space-y-3">
          <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search customer by name or phone..."
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-xs font-bold text-slate-400 hover:text-slate-600"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {sortedCustomers.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
              <BookUser className="w-12 h-12 text-slate-300 mx-auto mb-2" />
              <p className="font-bold text-slate-800 text-sm">No customers found</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Add customers when recording credit sales
              </p>
              <button
                onClick={() => {
                  setCustomerError('');
                  setIsAddCustomerOpen(true);
                }}
                className="mt-3 bg-emerald-800 text-white font-bold text-xs px-4 py-2 rounded-xl"
              >
                {t.newCustomer}
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs divide-y divide-slate-100 overflow-hidden">
              {sortedCustomers.map((customer) => {
                const owesMoney = customer.totalOwed > 0;
                const isSelected = activeCustomer?.id === customer.id;

                return (
                  <div
                    key={customer.id}
                    className={`p-3.5 transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-emerald-50/80 border-l-4 border-l-emerald-700'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectCustomer(customer.id)}
                      aria-pressed={isSelected}
                      className="min-w-0 flex-1 pr-3 text-left"
                    >
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-sm text-slate-900 truncate">
                          {customer.name}
                        </span>
                        {owesMoney ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                            Owes
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            Cleared
                          </span>
                        )}
                      </div>
                      {customer.phone && (
                        <p className="text-xs text-slate-400 font-mono mt-0.5 flex items-center space-x-1">
                          <Phone className="w-3 h-3 text-slate-400" />
                          <span>{customer.phone}</span>
                        </p>
                      )}
                      <span className="mt-1 block text-[11px] font-semibold text-emerald-700">
                        View details
                      </span>
                    </button>

                    <div className="text-right shrink-0">
                      <span
                        className={`text-base font-extrabold tabular-nums block ${
                          owesMoney ? 'text-amber-900' : 'text-slate-400'
                        }`}
                      >
                        {formatKwacha(customer.totalOwed)}
                      </span>

                      <div className="mt-1 flex items-center justify-end space-x-1">
                        {owesMoney && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenReminder(customer);
                            }}
                            className="flex h-10 w-10 items-center justify-center rounded text-emerald-700 hover:bg-emerald-100 transition-colors"
                            title="Send WhatsApp Reminder"
                            aria-label={`Send ${customer.name} a WhatsApp reminder`}
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPaymentModalCustomer(customer);
                            setPaymentAmount('');
                            setPaymentNote('');
                            setPaymentMethod('cash');
                            setPaymentError('');
                          }}
                          aria-label={`Record payment from ${customer.name}`}
                          className="min-h-[40px] text-[11px] font-bold text-emerald-800 hover:text-emerald-950 px-2 rounded bg-emerald-100 hover:bg-emerald-200 transition-colors"
                        >
                          Record payment
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Customer Detailed Ledger Statement */}
        <div
          ref={customerDetailsRef}
          className="mt-4 scroll-mt-24 lg:mt-0 lg:col-span-6 xl:col-span-7"
        >
          {activeCustomer ? (
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-4 sm:p-5 space-y-4">
              {/* Customer Header Info */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2">
                <div>
                  <h3 className="text-lg font-black text-slate-900">{activeCustomer.name}</h3>
                  <p className="text-xs text-slate-500 font-mono flex items-center space-x-1">
                    <Phone className="w-3 h-3 text-slate-400" />
                    <span>{activeCustomer.phone || 'No phone number saved'}</span>
                  </p>
                  {activeCustomer.notes && (
                    <p className="text-xs text-slate-500 mt-1">{activeCustomer.notes}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setEditingCustomer(activeCustomer)}
                    className="min-h-[40px] px-3 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200"
                  >
                    Edit customer
                  </button>
                  {activeCustomer.totalOwed > 0 && (
                    <button
                      onClick={() => handleOpenReminder(activeCustomer)}
                      className="min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-100 text-emerald-900 hover:bg-emerald-200 flex items-center space-x-1.5 transition-colors"
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-emerald-700" />
                      <span>{t.sendReminder}</span>
                    </button>
                  )}

                  <button
                    onClick={() => {
                      setPaymentModalCustomer(activeCustomer);
                      setPaymentAmount('');
                      setPaymentNote('');
                      setPaymentMethod('cash');
                      setPaymentError('');
                    }}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-800 hover:bg-emerald-900 text-white flex items-center space-x-1.5 shadow-xs transition-colors"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{t.recordPayment}</span>
                  </button>
                </div>
              </div>

              {/* Balance Card */}
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Current Balance Due
                  </span>
                  <p className="text-2xl font-black text-amber-950 tabular-nums">
                    {formatKwacha(activeCustomer.totalOwed)}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block">Status</span>
                  <span
                    className={`text-xs font-bold ${activeCustomer.totalOwed > 0 ? 'text-amber-800' : 'text-emerald-700'}`}
                  >
                    {activeCustomer.totalOwed > 0 ? 'Outstanding Debt' : 'Fully Paid Up'}
                  </span>
                </div>
              </div>

              {/* Transaction Ledger List */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center space-x-1">
                  <Receipt className="w-3.5 h-3.5 text-slate-400" />
                  <span>Statement History</span>
                </h4>

                {getCustomerTransactions(activeCustomer.id).length === 0 ? (
                  <p className="text-xs text-slate-400 py-6 text-center">
                    No transactions recorded for this customer yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto pr-1">
                    {getCustomerTransactions(activeCustomer.id).map((tx) => (
                      <div key={tx.id} className="py-2.5 flex items-start justify-between text-xs">
                        <div>
                          <div className="flex items-center space-x-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                tx.type === 'sale'
                                  ? 'bg-amber-100 text-amber-900'
                                  : 'bg-emerald-100 text-emerald-800'
                              }`}
                            >
                              {tx.type === 'sale' ? 'Bought on Credit' : 'Payment Received'}
                            </span>
                            <span className="text-slate-400 text-[11px]">
                              {new Date(tx.date).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-slate-600 mt-1">{tx.details}</p>
                          <p className="text-slate-400 mt-0.5">
                            Balance after: {formatKwacha(tx.runningBalance)}
                          </p>
                        </div>
                        <span
                          className={`font-black tabular-nums ${
                            tx.type === 'sale' ? 'text-amber-900' : 'text-emerald-800'
                          }`}
                        >
                          {tx.type === 'sale'
                            ? `+${formatKwacha(tx.amount)}`
                            : `-${formatKwacha(tx.amount)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-8 text-center text-slate-400">
              Select a customer to view their complete credit statement.
            </div>
          )}
        </div>
      </div>

      {editingCustomer && (
        <CustomerEditor customer={editingCustomer} onClose={() => setEditingCustomer(null)} />
      )}

      {/* Record Payment Modal */}
      {paymentModalCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-extrabold text-sm text-slate-900">{t.recordPayment}</h3>
              <button
                onClick={() => setPaymentModalCustomer(null)}
                className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="my-3 p-3 bg-amber-50 rounded-xl border border-amber-200">
              <p className="text-xs text-amber-900 font-bold">{paymentModalCustomer.name}</p>
              <p className="text-sm font-black text-amber-950 tabular-nums">
                Current debt: {formatKwacha(paymentModalCustomer.totalOwed)}
              </p>
            </div>

            <form onSubmit={handlePaymentSubmit} className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-slate-700">
                    Amount received (K) *
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentAmount(String(paymentModalCustomer.totalOwed));
                      setPaymentError('');
                    }}
                    className="text-[10px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md px-1.5 py-0.5"
                  >
                    Full balance
                  </button>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus
                  required
                  placeholder={`e.g. ${paymentModalCustomer.totalOwed}`}
                  value={paymentAmount}
                  onChange={(e) => {
                    setPaymentAmount(sanitizeMoneyInput(e.target.value));
                    setPaymentError('');
                  }}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-base font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                />
                {(() => {
                  const typed = parseFloat(paymentAmount);
                  if (!Number.isFinite(typed) || typed <= 0) return null;
                  const left = Math.max(
                    0,
                    Number((paymentModalCustomer.totalOwed - typed).toFixed(2))
                  );
                  return (
                    <p className="text-[11px] mt-1 font-semibold text-slate-600">
                      After this payment:{' '}
                      <span className={left > 0 ? 'text-amber-800' : 'text-emerald-700'}>
                        {left > 0 ? `${formatKwacha(left)} still owed` : 'account cleared'}
                      </span>
                    </p>
                  );
                })()}
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  How did they pay?
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(
                    [
                      ['cash', 'Cash'],
                      ['momo', 'Mobile Money'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPaymentMethod(value)}
                      aria-pressed={paymentMethod === value}
                      className={`min-h-[40px] text-xs font-bold rounded-lg px-3 border ${paymentMethod === value ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white text-slate-600 border-slate-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Note (optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Paid cash at kiosk"
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
              </div>

              {paymentError && (
                <p className="text-[11px] font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                  {paymentError}
                </p>
              )}

              <div className="pt-2 flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => {
                    setPaymentModalCustomer(null);
                    setPaymentAmount('');
                    setPaymentNote('');
                    setPaymentError('');
                  }}
                  disabled={isPaymentSaving}
                  className="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPaymentSaving}
                  className="flex-1 min-h-[44px] bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs py-2.5 rounded-xl shadow-xs transition-colors disabled:opacity-50"
                >
                  {isPaymentSaving ? 'Saving…' : 'Save payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* WhatsApp Reminder Modal */}
      {reminderCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-5 sm:p-6 max-w-md w-full shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900">
                    WhatsApp Credit Reminder
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    For {reminderCustomer.name} ({formatKwachaCompact(reminderCustomer.totalOwed)}{' '}
                    owed)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setReminderCustomer(null)}
                className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="my-3">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Polite Message (You can edit before sending):
              </label>
              <textarea
                rows={4}
                value={customReminderText}
                onChange={(e) => setCustomReminderText(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white leading-relaxed"
              />
            </div>

            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={handleCopyReminder}
                className="min-h-[44px] px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl flex items-center space-x-1 transition-colors"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copiedToast ? 'Copied!' : 'Copy'}</span>
              </button>

              <button
                type="button"
                onClick={handleSendWhatsApp}
                className="flex-1 min-h-[44px] bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs py-2.5 rounded-xl flex items-center justify-center space-x-2 shadow-xs transition-colors"
              >
                <Send className="w-4 h-4" />
                <span>Open in WhatsApp</span>
                <ExternalLink className="w-3 h-3 opacity-70" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Customer Modal */}
      {isAddCustomerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-5 sm:p-6 max-w-sm w-full shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-extrabold text-sm text-slate-900">{t.newCustomer}</h3>
              <button
                onClick={() => setIsAddCustomerOpen(false)}
                disabled={isCustomerSaving}
                aria-label="Close new customer"
                className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddCustomerSubmit} className="space-y-3.5 mt-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Customer Full Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Ba Bwalya, Mrs. Phiri"
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Phone Number (For WhatsApp reminders)
                </label>
                <input
                  type="tel"
                  placeholder="e.g. 0977 123 456"
                  inputMode="tel"
                  value={newCustPhone}
                  onChange={(e) => setNewCustPhone(sanitizePhoneInput(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                />
              </div>

              {customerError && (
                <p
                  role="alert"
                  className="text-xs font-semibold text-rose-800 bg-rose-50 rounded-xl p-2"
                >
                  {customerError}
                </p>
              )}
              <div className="pt-2 flex items-center space-x-2">
                <button
                  type="button"
                  disabled={isCustomerSaving}
                  onClick={() => setIsAddCustomerOpen(false)}
                  className="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs py-2.5 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCustomerSaving}
                  className="flex-1 min-h-[44px] bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs py-2.5 rounded-xl shadow-xs transition-colors disabled:opacity-50"
                >
                  {isCustomerSaving ? 'Saving…' : 'Save Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
