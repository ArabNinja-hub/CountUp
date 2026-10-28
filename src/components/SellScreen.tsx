import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Search,
  Plus,
  Minus,
  Check,
  AlertTriangle,
  UserPlus,
  ShoppingBag,
  Sparkles,
  ArrowRight,
  Trash2,
  Lock,
  Smartphone,
  Banknote,
  Clock,
  CheckCircle2,
  Receipt,
  X,
} from 'lucide-react';
import { Item, PaymentType, Customer } from '../types';

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
    shop,
  } = useShop();

  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentType, setPaymentType] = useState<PaymentType>('cash');
  const [momoOperator, setMomoOperator] = useState<'airtel' | 'mtn' | 'zamtel'>('airtel');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [isAddingNewCustomer, setIsAddingNewCustomer] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Success modal
  const [lastCompletedSale, setLastCompletedSale] = useState<{
    total: number;
    paymentType: PaymentType;
    momoOperator?: 'airtel' | 'mtn' | 'zamtel';
    customerName?: string;
  } | null>(null);

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

  // Cart helper functions
  const addToCart = (item: Item) => {
    setCart((prev) => {
      const existing = prev.find((ci) => ci.item.id === item.id);
      if (existing) {
        return prev.map((ci) =>
          ci.item.id === item.id ? { ...ci, quantity: ci.quantity + 1 } : ci
        );
      }
      return [...prev, { item, quantity: 1 }];
    });
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

  const clearCart = () => {
    setCart([]);
  };

  // Calculations
  const totalAmount = useMemo(() => {
    return cart.reduce((sum, ci) => sum + ci.item.sellingPrice * ci.quantity, 0);
  }, [cart]);

  const totalCost = useMemo(() => {
    return cart.reduce((sum, ci) => sum + ci.item.buyingPrice * ci.quantity, 0);
  }, [cart]);

  const totalItemsCount = useMemo(() => {
    return cart.reduce((sum, ci) => sum + ci.quantity, 0);
  }, [cart]);

  // Handle Save Sale
  const handleSaveSale = async () => {
    if (cart.length === 0 || isSaving) return;

    if (!subscription.canRecordSales) {
      onOpenPlan();
      return;
    }

    setIsSaving(true);
    try {
      let customerObj: Customer | undefined;

      if (paymentType === 'credit') {
        if (isAddingNewCustomer && newCustName.trim()) {
          customerObj = await addCustomer(newCustName.trim(), newCustPhone.trim());
        } else if (selectedCustomerId) {
          customerObj = customers.find((c) => c.id === selectedCustomerId);
        } else {
          alert('Please select or enter the customer name for credit');
          setIsSaving(false);
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

      await recordSale({
        items: saleItems,
        itemsCount: totalItemsCount,
        totalAmount,
        totalCost,
        profit: totalAmount - totalCost,
        paymentType,
        momoOperator: paymentType === 'momo' ? momoOperator : undefined,
        customerId: customerObj?.id,
        customerName: customerObj?.name,
        customerPhone: customerObj?.phone,
      });

      // Show instant receipt confirmation
      setLastCompletedSale({
        total: totalAmount,
        paymentType,
        momoOperator: paymentType === 'momo' ? momoOperator : undefined,
        customerName: customerObj?.name,
      });

      // Reset cart immediately
      setCart([]);
      setNewCustName('');
      setNewCustPhone('');
      setIsAddingNewCustomer(false);
      setSelectedCustomerId('');
    } catch (err) {
      console.error('Error saving sale:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Reusable Checkout Panel content (used in desktop sidebar AND mobile bottom sheet)
  const renderCheckoutControls = () => (
    <div className="space-y-3">
      {/* Payment Type Switcher */}
      <div>
        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
          Payment Method
        </label>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setPaymentType('cash')}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 border ${
              paymentType === 'cash'
                ? 'bg-emerald-800 text-white border-emerald-800 shadow-xs ring-1 ring-emerald-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Banknote className="w-4 h-4 text-emerald-400" />
            <span>{t.paidCash}</span>
          </button>

          <button
            type="button"
            onClick={() => setPaymentType('momo')}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 border ${
              paymentType === 'momo'
                ? 'bg-sky-800 text-white border-sky-800 shadow-xs ring-1 ring-sky-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Smartphone className="w-4 h-4 text-sky-400" />
            <span>{t.paidMomo}</span>
          </button>

          <button
            type="button"
            onClick={() => setPaymentType('credit')}
            className={`min-h-[44px] py-2 px-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 border ${
              paymentType === 'credit'
                ? 'bg-amber-800 text-white border-amber-800 shadow-xs ring-1 ring-amber-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Check className={`w-3.5 h-3.5 ${paymentType === 'credit' ? 'opacity-100 text-amber-300' : 'opacity-0'}`} />
            <span>{t.onCredit}</span>
          </button>
        </div>
      </div>

      {/* If MoMo is selected: Zambian Operator Selection */}
      {paymentType === 'momo' && (
        <div className="p-2.5 bg-sky-50/80 border border-sky-200 rounded-xl space-y-1.5">
          <span className="text-[11px] font-semibold text-sky-950 block">
            Select Mobile Money Network:
          </span>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setMomoOperator('airtel')}
              className={`min-h-[40px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-center border ${
                momoOperator === 'airtel'
                  ? 'bg-red-700 text-white border-red-700 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Airtel (*115#)
            </button>
            <button
              type="button"
              onClick={() => setMomoOperator('mtn')}
              className={`min-h-[40px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-center border ${
                momoOperator === 'mtn'
                  ? 'bg-amber-500 text-slate-950 border-amber-500 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              MTN (*303#)
            </button>
            <button
              type="button"
              onClick={() => setMomoOperator('zamtel')}
              className={`min-h-[40px] py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-center border ${
                momoOperator === 'zamtel'
                  ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Zamtel Kwacha
            </button>
          </div>
        </div>
      )}

      {/* If On Credit is selected: Customer Selection */}
      {paymentType === 'credit' && (
        <div className="p-3 bg-amber-50/80 border border-amber-200 rounded-xl space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-amber-950">
              {t.selectCustomer}
            </span>
            <button
              type="button"
              onClick={() => setIsAddingNewCustomer(!isAddingNewCustomer)}
              className="text-xs text-amber-800 font-bold hover:underline flex items-center space-x-1"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{isAddingNewCustomer ? 'Pick from list' : '+ New Customer'}</span>
            </button>
          </div>

          {isAddingNewCustomer ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder={t.customerName + ' *'}
                value={newCustName}
                onChange={(e) => setNewCustName(e.target.value)}
                className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
              <input
                type="tel"
                placeholder="Phone (optional, for WhatsApp reminders)"
                value={newCustPhone}
                onChange={(e) => setNewCustPhone(e.target.value)}
                className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
              />
            </div>
          ) : (
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-600"
            >
              <option value="">-- Choose existing customer --</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.totalOwed > 0 ? `(Owes K ${c.totalOwed})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Save Sale Primary CTA */}
      <button
        onClick={handleSaveSale}
        disabled={isSaving || cart.length === 0}
        className="w-full min-h-[48px] bg-emerald-800 hover:bg-emerald-900 active:scale-[0.99] text-white py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-between shadow-md transition-all cursor-pointer disabled:opacity-50"
      >
        <span className="flex items-center space-x-2">
          <span>{isSaving ? 'Recording sale...' : t.completeSale}</span>
          <span className="text-emerald-200 text-xs">({totalItemsCount} items)</span>
        </span>
        <span className="text-base font-extrabold tracking-tight tabular-nums">
          K {totalAmount.toFixed(2)}
        </span>
      </button>
    </div>
  );

  return (
    <div className="w-full">
      {/* Top Warning Banner if subscription expired */}
      {!subscription.canRecordSales && (
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

      {/* Responsive Grid: Left side catalog, Right side sticky receipt on desktop */}
      <div className="lg:grid lg:grid-cols-12 lg:gap-6 items-start">
        {/* Left Column: Search & Catalog */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-3">
          {/* Search Header */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-3 shadow-xs">
            <div className="relative">
              <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.searchItem}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-16 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2 text-xs font-semibold text-slate-400 hover:text-slate-700 px-2 py-0.5 rounded"
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
              <span>{t.recentItems}</span>
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
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
              {sortedItems.map((item) => {
                const inCart = cart.find((ci) => ci.item.id === item.id);
                const isLowStock = item.quantity <= item.lowStockThreshold;
                const isOutOfStock = item.quantity === 0;

                return (
                  <div
                    key={item.id}
                    onClick={() => !isOutOfStock && addToCart(item)}
                    className={`relative p-3 rounded-2xl border text-left flex flex-col justify-between transition-all select-none min-h-[120px] ${
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
                        K {item.sellingPrice}
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
                  <span className="px-1.5 py-0.2 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                    {totalItemsCount} items
                  </span>
                )}
              </div>
              {cart.length > 0 && (
                <button
                  onClick={clearCart}
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
                <p className="text-[11px] text-slate-400 mt-0.5">Tap any item from the catalog to add</p>
              </div>
            ) : (
              <>
                {/* Itemized Cart List */}
                <div className="max-h-56 overflow-y-auto space-y-2 pr-1 divide-y divide-slate-100">
                  {cart.map((ci) => (
                    <div key={ci.item.id} className="pt-2 first:pt-0 flex items-center justify-between text-xs">
                      <div className="min-w-0 flex-1 pr-2">
                        <p className="font-semibold text-slate-900 truncate">{ci.item.name}</p>
                        <p className="text-[11px] text-slate-400 tabular-nums">
                          K {ci.item.sellingPrice} each
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
                          K {(ci.item.sellingPrice * ci.quantity).toFixed(2)}
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
                    <span className="tabular-nums font-medium">K {totalAmount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>Est. Profit</span>
                    <span className="tabular-nums text-emerald-700 font-semibold">
                      +K {(totalAmount - totalCost).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-extrabold text-slate-900 pt-1 border-t border-slate-100">
                    <span>Total Due</span>
                    <span className="tabular-nums text-emerald-900 text-base">
                      K {totalAmount.toFixed(2)}
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
          <div className="fixed bottom-16 left-0 right-0 z-30 bg-white border-t border-slate-200 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] max-w-lg mx-auto rounded-t-2xl px-4 pt-3 pb-4">
            {/* Grab Handle */}
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-2" />

            {/* Header of Cart */}
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <span className="bg-emerald-100 text-emerald-800 text-xs font-extrabold px-2 py-0.5 rounded-md">
                  {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
                </span>
                <span className="text-xs font-extrabold text-slate-900 tabular-nums">
                  K {totalAmount.toFixed(2)}
                </span>
              </div>
              <button
                onClick={clearCart}
                className="text-xs text-slate-400 hover:text-rose-600 flex items-center space-x-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t.clearCart}</span>
              </button>
            </div>

            {/* Horizontal Cart chips */}
            <div className="flex overflow-x-auto space-x-2 pb-2 mb-2 no-scrollbar">
              {cart.map((ci) => (
                <div
                  key={ci.item.id}
                  className="shrink-0 bg-slate-100 border border-slate-200 text-slate-800 rounded-lg px-2.5 py-1 text-xs flex items-center space-x-1.5"
                >
                  <span className="font-semibold truncate max-w-[110px]">{ci.item.name}</span>
                  <span className="text-emerald-800 font-bold tabular-nums">x{ci.quantity}</span>
                  <button
                    onClick={() => deleteFromCart(ci.item.id)}
                    className="text-slate-400 hover:text-slate-700 ml-1 text-sm font-bold"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Mobile Checkout Controls */}
            {renderCheckoutControls()}
          </div>
        )}
      </div>

      {/* Sale Success Modal Toast */}
      {lastCompletedSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full text-center shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-black text-slate-900 tracking-tight">
              Sale Recorded!
            </h3>
            <p className="text-2xl font-black text-emerald-800 my-1 tabular-nums">
              K {lastCompletedSale.total.toFixed(2)}
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
