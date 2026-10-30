import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useShop } from '../context/ShopContext';
import { SUPPORT_CONTACT } from '../config/support';
import {
  Search,
  Plus,
  Minus,
  AlertTriangle,
  UserPlus,
  ShoppingBag,
  Sparkles,
  Trash2,
  Lock,
  Smartphone,
  Banknote,
  CheckCircle2,
  Receipt,
  HandCoins,
  UserRound,
} from 'lucide-react';
import { Item, PaymentType, Customer } from '../types';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { formatKwacha, formatKwachaCompact, sanitizePhoneInput } from '../utils/format';
import { addKwacha, localDateKey, multiplyKwacha } from '../utils/money';
import { summarizeLedger } from '../utils/ledger';

interface CartItem {
  item: Item;
  quantity: number;
}

interface SellScreenProps {
  onOpenPlan: () => void;
  onGoToStock: () => void;
}

export const SellScreen: React.FC<SellScreenProps> = ({ onOpenPlan, onGoToStock }) => {
  const {
    items,
    customers,
    addCustomer,
    recordSale,
    t,
    subscription,
    isShopDeactivated,
    sales,
    creditPayments,
  } = useShop();

  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [mobileCheckoutOpen, setMobileCheckoutOpen] = useState(false);
  const [paymentType, setPaymentType] = useState<PaymentType>('cash');
  const [momoOperator, setMomoOperator] = useState<'airtel' | 'mtn' | 'zamtel'>('airtel');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [isAddingNewCustomer, setIsAddingNewCustomer] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [paymentReference, setPaymentReference] = useState('');
  const [saleNote, setSaleNote] = useState('');
  const [creditError, setCreditError] = useState('');
  const [customerQuery, setCustomerQuery] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const { notify } = useToast();

  // Success modal
  const [lastCompletedSale, setLastCompletedSale] = useState<{
    total: number;
    receiptNumber?: string;
    paymentType: PaymentType;
    momoOperator?: 'airtel' | 'mtn' | 'zamtel';
    customerName?: string;
  } | null>(null);

  // Live "today" figures — recomputed from the sales collection, which the context
  // keeps in sync in real time, so the numbers change the instant a sale is saved.
  const today = useMemo(() => {
    const date = localDateKey();
    const todaySales = sales.filter(
      (sale) => (sale.localDate || localDateKey(new Date(sale.createdAt))) === date
    );
    const todayPayments = creditPayments.filter(
      (payment) => (payment.localDate || localDateKey(new Date(payment.createdAt))) === date
    );
    const summary = summarizeLedger(todaySales, todayPayments, []);
    return {
      count: todaySales.length,
      total: summary.sales,
      cash: summary.moneyReceived,
      credit: summary.creditSales,
      profit: summary.profit,
      missingCostRevenue: summary.missingCostRevenue,
    };
  }, [sales, creditPayments]);

  // Filter & sort items: Most recently sold items appear first!
  const sortedItems = useMemo(() => {
    let result = [...items];

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.name.toLowerCase().includes(q));
    }

    // Sort: items with lastSoldAt date come first (most recent first), then newly created items
    return result.sort((a, b) => {
      const timeA = a.lastSoldAt ? new Date(a.lastSoldAt).getTime() : 0;
      const timeB = b.lastSoldAt ? new Date(b.lastSoldAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [items, searchQuery]);

  // Cart helpers. Quantity can never exceed what is actually on the shelf, so the
  // stock book and the sale can't disagree — the shopkeeper gets a plain warning
  // instead of a silently impossible sale.
  const addToCart = (item: Item) => {
    const inCart = cart.find((ci) => ci.item.id === item.id);
    const current = inCart?.quantity ?? 0;
    if (item.quantity <= 0) {
      notify(`${item.name} is out of stock`, {
        kind: 'error',
        detail: 'Restock it in the Stock tab first.',
      });
      return;
    }
    if (current >= item.quantity) {
      notify(`Only ${item.quantity} of ${item.name} left`, {
        kind: 'info',
        detail: 'That is the whole stock on hand — you cannot sell more than you have.',
      });
      return;
    }
    setCart((prev) =>
      prev.some((ci) => ci.item.id === item.id)
        ? prev.map((ci) => (ci.item.id === item.id ? { ...ci, quantity: ci.quantity + 1 } : ci))
        : [...prev, { item, quantity: 1 }]
    );
  };

  const removeFromCart = (itemId: string) => {
    setCart((prev) => {
      const existing = prev.find((ci) => ci.item.id === itemId);
      if (existing && existing.quantity > 1) {
        return prev.map((ci) =>
          ci.item.id === itemId ? { ...ci, quantity: ci.quantity - 1 } : ci
        );
      }
      return prev.filter((ci) => ci.item.id !== itemId);
    });
  };

  const deleteFromCart = (itemId: string) => {
    setCart((prev) => prev.filter((ci) => ci.item.id !== itemId));
  };

  // If stock changes elsewhere (a restock, an item sold on another screen), trim the
  // cart so it always matches what is really available.
  useEffect(() => {
    setCart((prev) =>
      prev
        .map((ci) => {
          const live = items.find((i) => i.id === ci.item.id);
          if (!live) return null;
          return { item: live, quantity: Math.min(ci.quantity, live.quantity) };
        })
        .filter((ci): ci is CartItem => Boolean(ci) && ci!.quantity > 0)
    );
  }, [items]);

  // Calculations
  const totalAmount = useMemo(() => {
    return addKwacha(...cart.map((ci) => multiplyKwacha(ci.item.sellingPrice, ci.quantity)));
  }, [cart]);

  const totalCost = useMemo(() => {
    return addKwacha(
      ...cart.map((ci) =>
        ci.item.buyingPriceKnown === false ? 0 : multiplyKwacha(ci.item.buyingPrice, ci.quantity)
      )
    );
  }, [cart]);

  const missingCostRevenue = useMemo(() => {
    return addKwacha(
      ...cart.map((ci) =>
        ci.item.buyingPriceKnown === false ? multiplyKwacha(ci.item.sellingPrice, ci.quantity) : 0
      )
    );
  }, [cart]);
  const estimatedProfit = addKwacha(totalAmount, -totalCost, -missingCostRevenue);

  const totalItemsCount = useMemo(() => {
    return cart.reduce((sum, ci) => sum + ci.quantity, 0);
  }, [cart]);

  // Handle Save Sale
  const handleSaveSale = async () => {
    if (cart.length === 0 || savingRef.current) return;

    if (!subscription.canRecordSales) {
      onOpenPlan();
      return;
    }

    setCreditError('');

    // Credit sales need a named customer, otherwise the debt goes nowhere.
    if (paymentType === 'credit') {
      const hasNew = isAddingNewCustomer && newCustName.trim().length > 0;
      if (!hasNew && !selectedCustomerId) {
        setCreditError(
          'Choose who is buying on credit, or add them as a new customer, before saving.'
        );
        return;
      }
    }

    savingRef.current = true;
    setIsSaving(true);
    try {
      let customerObj: Customer | undefined;

      if (paymentType === 'credit') {
        if (isAddingNewCustomer && newCustName.trim()) {
          customerObj = await addCustomer(newCustName.trim(), newCustPhone.trim());
        } else if (selectedCustomerId) {
          customerObj = customers.find((c) => c.id === selectedCustomerId);
        }
        if (!customerObj) {
          setCreditError('That customer could not be found. Pick them again.');
          return;
        }
      }

      const saleItems = cart.map((ci) => ({
        itemId: ci.item.id,
        name: ci.item.name,
        quantity: ci.quantity,
        buyingPrice: ci.item.buyingPrice,
        sellingPrice: ci.item.sellingPrice,
      }));

      const recorded = await recordSale({
        items: saleItems,
        itemsCount: totalItemsCount,
        totalAmount,
        totalCost,
        profit: estimatedProfit,
        missingCostRevenue,
        paymentType,
        momoOperator: paymentType === 'momo' ? momoOperator : undefined,
        customerId: customerObj?.id,
        customerName: customerObj?.name,
        customerPhone: customerObj?.phone,
        paymentReference: paymentType === 'momo' ? paymentReference.trim() : '',
        note: saleNote.trim(),
      });

      // Show instant receipt confirmation
      setLastCompletedSale({
        total: recorded.totalAmount,
        receiptNumber: recorded.receiptNumber,
        paymentType,
        momoOperator: paymentType === 'momo' ? momoOperator : undefined,
        customerName: customerObj?.name,
      });

      notify(`Sale saved — ${formatKwacha(totalAmount)}`, {
        kind: 'success',
        detail:
          paymentType === 'credit'
            ? `Added to ${customerObj?.name}'s credit balance`
            : paymentType === 'momo'
              ? `Recorded as Mobile Money (${momoOperator})`
              : 'Recorded as cash in hand',
      });

      // Reset cart immediately
      setCart([]);
      setMobileCheckoutOpen(false);
      setNewCustName('');
      setNewCustPhone('');
      setIsAddingNewCustomer(false);
      setSelectedCustomerId('');
      setCustomerQuery('');
      setPaymentReference('');
      setSaleNote('');
    } catch (err) {
      // e.g. stock ran out between adding to the cart and saving
      notify('Sale not saved', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  // Reusable Checkout Panel content (used in desktop sidebar AND mobile bottom sheet)
  const renderCheckoutControls = () => (
    <div className="space-y-3">
      {/* Payment Method */}
      <div>
        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
          How is the customer paying?
        </label>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              setPaymentType('cash');
              setCreditError('');
            }}
            aria-pressed={paymentType === 'cash'}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-0.5 border ${
              paymentType === 'cash'
                ? 'bg-emerald-800 text-white border-emerald-800 shadow-xs ring-1 ring-emerald-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Banknote
              className={`w-4 h-4 ${paymentType === 'cash' ? 'text-emerald-300' : 'text-emerald-600'}`}
            />
            <span>{t.paidCash}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setPaymentType('momo');
              setCreditError('');
            }}
            aria-pressed={paymentType === 'momo'}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-0.5 border ${
              paymentType === 'momo'
                ? 'bg-sky-800 text-white border-sky-800 shadow-xs ring-1 ring-sky-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Smartphone
              className={`w-4 h-4 ${paymentType === 'momo' ? 'text-sky-300' : 'text-sky-600'}`}
            />
            <span>{t.paidMomo}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setPaymentType('credit');
              setCreditError('');
            }}
            aria-pressed={paymentType === 'credit'}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-0.5 border ${
              paymentType === 'credit'
                ? 'bg-amber-800 text-white border-amber-800 shadow-xs ring-1 ring-amber-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <HandCoins
              className={`w-4 h-4 ${paymentType === 'credit' ? 'text-amber-300' : 'text-amber-600'}`}
            />
            <span>{t.onCredit}</span>
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate-500 leading-snug">
          {paymentType === 'cash' && 'Money received now, in hand.'}
          {paymentType === 'momo' &&
            `Money received now via ${momoOperator === 'mtn' ? 'MTN MoMo' : momoOperator === 'zamtel' ? 'Zamtel Kwacha' : 'Airtel Money'}.`}
          {paymentType === 'credit' &&
            'Nothing received now — the balance is added to the customer’s credit book.'}
        </p>
      </div>

      {/* If MoMo is selected: Zambian Operator Selection */}
      {paymentType === 'momo' && (
        <div className="p-2.5 bg-sky-50/80 border border-sky-200 rounded-xl space-y-1.5">
          <span className="text-[11px] font-semibold text-sky-950 block">
            Which network sent the money?
          </span>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'airtel', label: 'Airtel', active: 'bg-red-700 border-red-700 text-white' },
                {
                  id: 'mtn',
                  label: 'MTN MoMo',
                  active: 'bg-amber-500 border-amber-500 text-slate-950',
                },
                {
                  id: 'zamtel',
                  label: 'Zamtel',
                  active: 'bg-emerald-700 border-emerald-700 text-white',
                },
              ] as const
            ).map((op) => (
              <button
                key={op.id}
                type="button"
                onClick={() => setMomoOperator(op.id)}
                aria-pressed={momoOperator === op.id}
                className={`min-h-[40px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-center border ${
                  momoOperator === op.id
                    ? op.active + ' shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {op.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* If On Credit is selected: Customer Selection */}
      {paymentType === 'credit' && (
        <div className="p-3 bg-amber-50/80 border border-amber-200 rounded-xl space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-amber-950 flex items-center gap-1">
              <UserRound className="w-3.5 h-3.5" />
              Who is buying on credit?
            </span>
            <button
              type="button"
              onClick={() => {
                setIsAddingNewCustomer(!isAddingNewCustomer);
                setCreditError('');
              }}
              className="text-[11px] text-amber-900 font-bold hover:underline flex items-center space-x-1 shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{isAddingNewCustomer ? 'Pick an existing customer' : 'New customer'}</span>
            </button>
          </div>

          {isAddingNewCustomer ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Customer name (required)"
                value={newCustName}
                onChange={(e) => {
                  setNewCustName(e.target.value);
                  setCreditError('');
                }}
                autoComplete="off"
                className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600"
              />
              <input
                type="tel"
                inputMode="tel"
                placeholder="Phone (optional, for WhatsApp reminders)"
                value={newCustPhone}
                onChange={(e) => setNewCustPhone(sanitizePhoneInput(e.target.value))}
                autoComplete="off"
                className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 font-mono"
              />

              {(() => {
                const typed = newCustName.trim().toLowerCase();
                const existing = typed
                  ? customers.find((c) => c.name.trim().toLowerCase() === typed)
                  : undefined;
                if (!existing) return null;
                return (
                  <div className="bg-white border border-amber-300 rounded-lg p-2 text-[11px] text-amber-900 leading-snug">
                    <strong>{existing.name}</strong> is already in your credit book
                    {existing.totalOwed > 0 ? ` and owes ${formatKwacha(existing.totalOwed)}` : ''}.
                    Add this sale to that account instead of starting a second one.
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCustomerId(existing.id);
                        setIsAddingNewCustomer(false);
                        setNewCustName('');
                        setNewCustPhone('');
                        setCreditError('');
                      }}
                      className="mt-1.5 block w-full bg-amber-800 hover:bg-amber-900 text-white font-bold text-[11px] py-1.5 rounded-md"
                    >
                      Use {existing.name}
                    </button>
                  </div>
                );
              })()}
            </div>
          ) : customers.length === 0 ? (
            <p className="text-[11px] text-amber-900 bg-white border border-amber-200 rounded-lg p-2.5 leading-snug">
              No credit customers yet. Tap <strong>New customer</strong> above and enter their name
              — it takes a few seconds.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="text"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Search customer…"
                  className="w-full bg-white border border-amber-300 rounded-lg pl-8 pr-2 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>
              <div className="max-h-40 overflow-y-auto bg-white border border-amber-200 rounded-lg divide-y divide-amber-50">
                {customers
                  .filter((c) => {
                    const q = customerQuery.trim().toLowerCase();
                    return !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q);
                  })
                  .sort((a, b) => b.totalOwed - a.totalOwed)
                  .map((c) => {
                    const isPicked = selectedCustomerId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedCustomerId(c.id);
                          setCreditError('');
                        }}
                        aria-pressed={isPicked}
                        className={`w-full flex items-center justify-between px-2.5 py-2 text-left transition-colors ${
                          isPicked ? 'bg-amber-100' : 'hover:bg-amber-50'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-xs font-bold text-slate-900 truncate">
                            {c.name}
                          </span>
                          {c.phone && (
                            <span className="block text-[10px] text-slate-500 font-mono">
                              {c.phone}
                            </span>
                          )}
                        </span>
                        <span
                          className={`text-[11px] font-bold tabular-nums shrink-0 ${c.totalOwed > 0 ? 'text-amber-900' : 'text-emerald-700'}`}
                        >
                          {c.totalOwed > 0 ? `owes ${formatKwachaCompact(c.totalOwed)}` : 'cleared'}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {creditError && (
            <p className="text-[11px] font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{creditError}</span>
            </p>
          )}
        </div>
      )}

      <details className="rounded-xl border border-slate-200 bg-slate-50 px-3">
        <summary className="min-h-[40px] cursor-pointer py-3 text-xs font-bold text-slate-600">
          More details (optional)
        </summary>
        <div className="space-y-3 pb-3">
          {paymentType === 'momo' && (
            <label className="block text-[11px] font-bold text-slate-600">
              Mobile Money reference
              <input
                value={paymentReference}
                maxLength={80}
                onChange={(e) => setPaymentReference(e.target.value)}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                placeholder="Transaction reference"
              />
            </label>
          )}
          <label className="block text-[11px] font-bold text-slate-600">
            Sale note
            <input
              value={saleNote}
              maxLength={200}
              onChange={(e) => setSaleNote(e.target.value)}
              className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
              placeholder="Add a note to this receipt"
            />
          </label>
        </div>
      </details>

      {/* Save Sale Primary CTA */}
      <button
        onClick={handleSaveSale}
        disabled={isSaving || cart.length === 0}
        className="w-full min-h-[52px] bg-emerald-800 hover:bg-emerald-900 active:scale-[0.99] text-white py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-between shadow-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex items-center space-x-2">
          <Receipt className="w-4 h-4" />
          <span>{isSaving ? 'Saving sale…' : t.completeSale}</span>
        </span>
        <span className="text-base font-extrabold tracking-tight tabular-nums">
          {formatKwacha(totalAmount)}
        </span>
      </button>
      <p className="text-[10px] text-slate-500 text-center -mt-1">
        {cart.length === 0
          ? 'Add an item to start a sale.'
          : paymentType === 'credit' && !selectedCustomerId && !newCustName.trim()
            ? 'Choose who is buying on credit above to save this sale.'
            : 'Offline entries stay on this device until they sync.'}
      </p>
    </div>
  );

  return (
    <div className="w-full">
      {/* Top Warning Banner if the shop is suspended by the platform owner */}
      {isShopDeactivated && (
        <div className="mb-4 p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-rose-950 flex items-start space-x-2.5 shadow-xs">
          <Lock className="w-5 h-5 text-rose-600 shrink-0" />
          <div className="text-xs">
            <p className="font-bold">This shop has been deactivated</p>
            <p className="text-rose-700">
              New sales are locked. Your records are safe and can still be viewed and exported. To
              reactivate your shop, contact support on{' '}
              <a
                href={`tel:${SUPPORT_CONTACT.phoneDial}`}
                className="font-bold underline decoration-rose-400 underline-offset-2"
              >
                {SUPPORT_CONTACT.phoneDisplay}
              </a>{' '}
              or email{' '}
              <a
                href={`mailto:${SUPPORT_CONTACT.supportEmail}`}
                className="font-bold underline decoration-rose-400 underline-offset-2"
              >
                {SUPPORT_CONTACT.supportEmail}
              </a>
              .
            </p>
          </div>
        </div>
      )}

      {/* Top Warning Banner if subscription expired */}
      {!isShopDeactivated && !subscription.canRecordSales && (
        <div className="mb-4 p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-rose-950 flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-2.5">
            <Lock className="w-5 h-5 text-rose-600 shrink-0" />
            <div className="text-xs">
              <p className="font-bold">{t.planExpired}</p>
              <p className="text-rose-700">{t.planExpiredNotice}</p>
            </div>
          </div>
          <button
            onClick={onOpenPlan}
            className="shrink-0 bg-rose-700 hover:bg-rose-800 text-white font-bold text-xs px-3.5 py-2 rounded-xl transition-colors cursor-pointer"
          >
            {t.payNow}
          </button>
        </div>
      )}

      <details className="mb-4 rounded-2xl border border-slate-200 bg-white px-3 shadow-xs">
        <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 py-2 text-sm font-bold text-slate-700">
          <span>Today’s summary</span>
          <span className="text-xs font-semibold text-slate-500">
            Sales: {formatKwacha(today.total)}
          </span>
        </summary>
        <div className="grid grid-cols-2 gap-2 pb-3 sm:grid-cols-4">
          <div className="bg-white border border-slate-200/90 rounded-xl px-3 py-2 shadow-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Today
            </span>
            <p className="text-sm font-black text-slate-900 tabular-nums leading-tight">
              {formatKwacha(today.total)}
            </p>
            <span className="text-[10px] text-slate-500">
              {today.count} {today.count === 1 ? 'sale' : 'sales'}
            </span>
          </div>
          <div className="bg-white border border-slate-200/90 rounded-xl px-3 py-2 shadow-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Cash & MoMo
            </span>
            <p className="text-sm font-black text-emerald-800 tabular-nums leading-tight">
              {formatKwacha(today.cash)}
            </p>
            <span className="text-[10px] text-slate-500">Received, including repayments</span>
          </div>
          <div className="bg-white border border-slate-200/90 rounded-xl px-3 py-2 shadow-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              On credit
            </span>
            <p className="text-sm font-black text-amber-800 tabular-nums leading-tight">
              {formatKwacha(today.credit)}
            </p>
            <span className="text-[10px] text-slate-500">New credit given</span>
          </div>
          <div className="bg-emerald-900 border border-emerald-800 rounded-xl px-3 py-2 shadow-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
              Profit
            </span>
            <p className="text-sm font-black text-white tabular-nums leading-tight">
              {formatKwacha(today.profit)}
            </p>
            <span className="text-[10px] text-emerald-200">
              {today.missingCostRevenue > 0 ? 'Excludes unknown costs' : 'Today'}
            </span>
          </div>
        </div>
      </details>

      {/* Responsive Grid: Left side catalog, Right side sticky receipt on desktop */}
      <div className="lg:grid lg:grid-cols-12 lg:gap-6 items-start">
        {/* Left Column: Search & Catalog */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-3">
          {/* Search Header */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-3 shadow-xs">
            <div className="relative">
              <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
              <input
                ref={searchRef}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchQuery('');
                }}
                placeholder="Search your items by name…"
                autoComplete="off"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-16 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    searchRef.current?.focus();
                  }}
                  className="absolute right-2.5 top-2 text-xs font-bold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md px-2 py-1"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Catalog Section Header */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-600 uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5 text-emerald-700" />
              <span>{t.pickItems}</span>
            </div>
            <span className="text-xs text-slate-400 font-medium">
              {sortedItems.length} {sortedItems.length === 1 ? 'item' : 'items'}
            </span>
          </div>

          {/* Products Grid */}
          {items.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center my-2">
              <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-2.5" />
              <p className="font-bold text-slate-800 text-sm mb-1">{t.noItemsYet}</p>
              <p className="text-xs text-slate-500 mb-4">{t.noItemsYetHint}</p>
              <button
                onClick={onGoToStock}
                className="bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs px-5 py-2.5 rounded-xl shadow-xs transition-colors cursor-pointer"
              >
                {t.addItem}
              </button>
            </div>
          ) : sortedItems.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center my-2">
              <Search className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="font-bold text-slate-800 text-sm mb-1">
                Nothing matches “{searchQuery.trim()}”
              </p>
              <p className="text-xs text-slate-500 mb-4">
                {items.length} {items.length === 1 ? 'item is' : 'items are'} in your stock book —
                try a shorter word, or check the spelling.
              </p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  searchRef.current?.focus();
                }}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-4 py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                Show all items
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
              {sortedItems.map((item) => {
                const inCart = cart.find((ci) => ci.item.id === item.id);
                const isLowStock = item.quantity <= item.lowStockThreshold;
                const isOutOfStock = item.quantity === 0;

                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={isOutOfStock ? -1 : 0}
                    aria-label={`Add ${item.name} to cart`}
                    aria-disabled={isOutOfStock}
                    onClick={() => !isOutOfStock && addToCart(item)}
                    onKeyDown={(event) => {
                      if (!isOutOfStock && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        addToCart(item);
                      }
                    }}
                    className={`relative p-3 rounded-2xl border text-left flex flex-col justify-between transition-all select-none min-h-[120px] focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                      isOutOfStock
                        ? 'bg-slate-50 border-slate-200 opacity-60 cursor-not-allowed'
                        : inCart
                          ? 'bg-emerald-50/70 border-emerald-600 shadow-xs ring-1 ring-emerald-600'
                          : 'bg-white border-slate-200/90 hover:border-emerald-300 hover:shadow-xs cursor-pointer'
                    }`}
                  >
                    <div>
                      {/* Name */}
                      <h3 className="font-bold text-sm text-slate-900 leading-snug line-clamp-2">
                        {item.name}
                      </h3>

                      {/* Stock Tag */}
                      <div className="mt-1 flex items-center">
                        {isOutOfStock ? (
                          <span className="text-[10px] font-semibold text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">
                            {t.outOfStock}
                          </span>
                        ) : isLowStock ? (
                          <span className="text-[10px] font-semibold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 flex items-center space-x-1">
                            <AlertTriangle className="w-2.5 h-2.5 text-amber-700" />
                            <span>{item.quantity} left</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500 font-medium">
                            {item.quantity} {t.stockLeft}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Price and Cart Stepper */}
                    <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-base font-extrabold text-emerald-900 tracking-tight tabular-nums">
                        {formatKwachaCompact(item.sellingPrice)}
                      </span>

                      {inCart ? (
                        <div
                          className="flex items-center space-x-1 bg-emerald-800 text-white rounded-lg p-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => removeFromCart(item.id)}
                            className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-900 active:scale-95"
                            aria-label="Decrease quantity"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-xs font-extrabold px-1 min-w-[18px] text-center tabular-nums">
                            {inCart.quantity}
                          </span>
                          <button
                            onClick={() => addToCart(item)}
                            className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-900 active:scale-95"
                            aria-label="Increase quantity"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 flex items-center justify-center">
                          <Plus className="w-4 h-4 font-bold" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column (Desktop): Sticky Current Order Panel */}
        <div className="hidden lg:block lg:col-span-5 xl:col-span-4 sticky top-16">
          <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-4 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <Receipt className="w-4 h-4 text-emerald-800" />
                <h2 className="font-bold text-sm text-slate-900">Current Sale</h2>
                {cart.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                    {totalItemsCount} items
                  </span>
                )}
              </div>
              {cart.length > 0 && (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="text-xs text-slate-400 hover:text-rose-600 flex items-center space-x-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t.clearCart}</span>
                </button>
              )}
            </div>

            {cart.length === 0 ? (
              <div className="py-12 text-center text-slate-400">
                <ShoppingBag className="w-10 h-10 mx-auto mb-2 opacity-40 text-slate-400" />
                <p className="text-xs font-semibold text-slate-600">Cart is empty</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Tap any item from the catalog to add
                </p>
              </div>
            ) : (
              <>
                {/* Itemized Cart List */}
                <div className="max-h-56 overflow-y-auto space-y-2 pr-1 divide-y divide-slate-100">
                  {cart.map((ci) => (
                    <div
                      key={ci.item.id}
                      className="pt-2 first:pt-0 flex items-center justify-between text-xs"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <p className="font-semibold text-slate-900 truncate">{ci.item.name}</p>
                        <p className="text-[11px] text-slate-400 tabular-nums">
                          {formatKwacha(ci.item.sellingPrice)} each
                        </p>
                      </div>

                      {/* Stepper */}
                      <div className="flex items-center space-x-1 shrink-0 mr-3">
                        <button
                          onClick={() => removeFromCart(ci.item.id)}
                          className="w-5 h-5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center font-bold"
                        >
                          -
                        </button>
                        <span className="font-bold px-1 text-center min-w-[20px] tabular-nums">
                          {ci.quantity}
                        </span>
                        <button
                          onClick={() => addToCart(ci.item)}
                          className="w-5 h-5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center font-bold"
                        >
                          +
                        </button>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="font-bold text-slate-900 tabular-nums">
                          {formatKwacha(ci.item.sellingPrice * ci.quantity)}
                        </p>
                        <button
                          onClick={() => deleteFromCart(ci.item.id)}
                          className="text-[10px] text-slate-400 hover:text-rose-600"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Bill Summary */}
                <div className="pt-3 border-t border-slate-100 space-y-1 text-xs">
                  <div className="flex justify-between text-slate-500">
                    <span>Subtotal</span>
                    <span className="tabular-nums font-medium">{formatKwacha(totalAmount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>
                      {missingCostRevenue > 0 ? 'Profit on known costs' : 'Profit on this sale'}
                    </span>
                    <span className="tabular-nums text-emerald-700 font-semibold">
                      {formatKwacha(estimatedProfit)}
                    </span>
                  </div>
                  {missingCostRevenue > 0 && (
                    <p className="text-[11px] text-amber-800">
                      Profit excludes {formatKwacha(missingCostRevenue)} in sales with unknown cost.
                    </p>
                  )}
                  <div className="flex justify-between text-sm font-extrabold text-slate-900 pt-1 border-t border-slate-100">
                    <span>Total Due</span>
                    <span className="tabular-nums text-emerald-900 text-base">
                      {formatKwacha(totalAmount)}
                    </span>
                  </div>
                </div>

                {/* Checkout Controls */}
                {renderCheckoutControls()}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mobile-Only Drawer / Bottom Sheet when cart has items */}
      <div className="lg:hidden">
        {cart.length > 0 && (
          <div className="fixed bottom-16 left-0 right-0 z-30 bg-white border-t border-slate-200 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] max-w-lg mx-auto rounded-t-2xl px-4 pt-3 pb-4 max-h-[72vh] overflow-y-auto overscroll-contain">
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-2" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex shrink-0 items-center gap-2">
                <span className="whitespace-nowrap bg-emerald-100 text-emerald-800 text-xs font-extrabold px-2 py-0.5 rounded-md">
                  {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
                </span>
                <span className="whitespace-nowrap text-xs font-extrabold text-slate-900 tabular-nums">
                  {formatKwacha(totalAmount)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:gap-3">
                <button
                  onClick={() => setMobileCheckoutOpen(!mobileCheckoutOpen)}
                  aria-expanded={mobileCheckoutOpen}
                  aria-controls="mobile-checkout"
                  className={`min-h-[44px] whitespace-nowrap rounded-xl px-3 text-xs font-bold ${
                    mobileCheckoutOpen
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-emerald-800 text-white shadow-sm'
                  }`}
                >
                  {mobileCheckoutOpen ? 'Add items' : 'Review sale'}
                </button>
                {mobileCheckoutOpen && (
                  <button
                    onClick={() => setShowClearConfirm(true)}
                    className="min-h-[40px] text-xs text-slate-500 hover:text-rose-600 flex items-center space-x-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{t.clearCart}</span>
                  </button>
                )}
              </div>
            </div>
            {mobileCheckoutOpen && (
              <div id="mobile-checkout" className="pt-2 border-t border-slate-100">
                <div className="flex overflow-x-auto space-x-2 pb-2 mb-2 no-scrollbar">
                  {cart.map((ci) => (
                    <div
                      key={ci.item.id}
                      className="shrink-0 bg-slate-100 border border-slate-200 text-slate-800 rounded-lg px-2 text-xs flex items-center gap-1"
                    >
                      <span className="font-semibold truncate max-w-[110px]">{ci.item.name}</span>
                      <button
                        type="button"
                        onClick={() => removeFromCart(ci.item.id)}
                        aria-label={`Decrease ${ci.item.name} quantity`}
                        className="w-9 h-9 flex items-center justify-center text-slate-600"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="text-emerald-800 font-bold tabular-nums">{ci.quantity}</span>
                      <button
                        type="button"
                        onClick={() => addToCart(ci.item)}
                        aria-label={`Increase ${ci.item.name} quantity`}
                        className="w-9 h-9 flex items-center justify-center text-emerald-800"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteFromCart(ci.item.id)}
                        aria-label={`Remove ${ci.item.name} from sale`}
                        className="w-9 h-9 flex items-center justify-center text-slate-500 text-base font-bold"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                {renderCheckoutControls()}
              </div>
            )}
          </div>
        )}
      </div>

      {showClearConfirm && (
        <ConfirmDialog
          title="Clear this sale?"
          description={
            <>
              <p>
                This removes the {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'} in the
                current sale. Nothing has been recorded yet, so no stock will change.
              </p>
              <p className="font-semibold text-slate-700">
                {items.length > 0 ? 'You can start a new sale straight away.' : ''}
              </p>
            </>
          }
          confirmLabel="Clear sale"
          onCancel={() => setShowClearConfirm(false)}
          onConfirm={() => {
            setCart([]);
            setMobileCheckoutOpen(false);
            setShowClearConfirm(false);
          }}
        />
      )}

      {/* Sale Success Modal Toast */}
      {lastCompletedSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full text-center shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-black text-slate-900 tracking-tight">Sale Recorded!</h3>
            {lastCompletedSale.receiptNumber && (
              <p className="mt-1 text-[10px] text-slate-500 break-all">
                Receipt {lastCompletedSale.receiptNumber}
              </p>
            )}
            <p className="text-2xl font-black text-emerald-800 my-1 tabular-nums">
              {formatKwacha(lastCompletedSale.total)}
            </p>
            <p className="text-xs text-slate-500 mb-4">
              {lastCompletedSale.paymentType === 'cash'
                ? 'Paid in Cash (In Hand)'
                : lastCompletedSale.paymentType === 'momo'
                  ? `Received via Mobile Money (${lastCompletedSale.momoOperator?.toUpperCase()})`
                  : `Recorded on Credit for ${lastCompletedSale.customerName || 'customer'}`}
            </p>

            <button
              onClick={() => setLastCompletedSale(null)}
              className="w-full bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs py-3 rounded-xl transition-colors cursor-pointer"
            >
              Continue Selling
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
