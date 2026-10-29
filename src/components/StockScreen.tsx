import React, { useMemo, useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Boxes,
  Plus,
  AlertTriangle,
  Search,
  Edit2,
  Trash2,
  X,
  PackagePlus,
  RotateCcw,
} from 'lucide-react';
import { Item } from '../types';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import {
  formatKwacha,
  formatKwachaCompact,
  sanitizeIntegerInput,
  sanitizeMoneyInput,
} from '../utils/format';

export const StockScreen: React.FC = () => {
  const { items, addItem, updateItem, quickRestock, deleteItem, restoreItem, t } = useShop();
  const { notify } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeSubTab, setActiveSubTab] = useState<'all' | 'low'>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [itemToDelete, setItemToDelete] = useState<Item | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    buyingPrice: '',
    sellingPrice: '',
    quantity: '',
    lowStockThreshold: '5',
  });

  // Calculate stock stats
  const totalStockValue = useMemo(() => {
    return items.reduce((sum, item) => sum + item.sellingPrice * item.quantity, 0);
  }, [items]);

  const totalCostValue = useMemo(() => {
    return items.reduce((sum, item) => sum + item.buyingPrice * item.quantity, 0);
  }, [items]);

  const lowStockItems = useMemo(() => {
    return items.filter((i) => i.quantity <= i.lowStockThreshold);
  }, [items]);

  const filteredItems = useMemo(() => {
    let result = activeSubTab === 'low' ? lowStockItems : items;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.name.toLowerCase().includes(q));
    }
    return result;
  }, [items, lowStockItems, activeSubTab, searchQuery]);

  // Open add modal
  const handleOpenAdd = () => {
    setEditingItem(null);
    setFormData({
      name: '',
      buyingPrice: '',
      sellingPrice: '',
      quantity: '',
      lowStockThreshold: '5',
    });
    setIsAddModalOpen(true);
  };

  // Open edit modal
  const handleOpenEdit = (item: Item) => {
    setEditingItem(item);
    setFormData({
      name: item.name,
      buyingPrice: item.buyingPrice.toString(),
      sellingPrice: item.sellingPrice.toString(),
      quantity: item.quantity.toString(),
      lowStockThreshold: item.lowStockThreshold.toString(),
    });
    setIsAddModalOpen(true);
  };

  // Save (add or edit), validating every field before anything is written
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFormError('');

    const name = formData.name.trim();
    const buyingPrice = parseFloat(formData.buyingPrice);
    const sellingPrice = parseFloat(formData.sellingPrice);
    const quantity = parseInt(formData.quantity, 10);
    const lowStockThreshold = parseInt(formData.lowStockThreshold, 10);

    // A blank price parses to NaN — treat it as "not filled in" rather than 0.
    const buying = Number.isFinite(buyingPrice) ? buyingPrice : 0;
    const selling = Number.isFinite(sellingPrice) ? sellingPrice : 0;
    const qty = Number.isFinite(quantity) ? quantity : 0;
    const threshold = Number.isFinite(lowStockThreshold) ? lowStockThreshold : 5;

    if (!name) {
      setFormError('Give the item a name — e.g. “Sugar 1kg”.');
      return;
    }
    if (!formData.sellingPrice.trim() || selling <= 0) {
      setFormError('Enter the selling price in Kwacha. It must be more than K 0.');
      return;
    }
    if (!formData.quantity.trim()) {
      setFormError('Enter how many you have in stock. Use 0 if it has run out.');
      return;
    }
    if (threshold < 0) {
      setFormError('The low-stock warning has to be 0 or more.');
      return;
    }

    setIsSaving(true);
    try {
      if (editingItem) {
        await updateItem(editingItem.id, {
          name,
          buyingPrice: buying,
          sellingPrice: selling,
          quantity: qty,
          lowStockThreshold: threshold,
        });
        notify(`${name} updated`, {
          kind: 'success',
          detail: `${qty} in stock · selling at ${formatKwacha(selling)}`,
        });
      } else {
        await addItem({
          name,
          buyingPrice: buying,
          sellingPrice: selling,
          quantity: qty,
          lowStockThreshold: threshold,
        });
        notify(`${name} added to your stock book`, {
          kind: 'success',
          detail: `${qty} in stock · selling at ${formatKwacha(selling)}`,
        });
      }
      setIsAddModalOpen(false);
    } catch (err) {
      notify('Could not save that item', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Delete with an undo, so a mis-tap cannot lose a product and its prices
  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);
    const removed = itemToDelete;
    await deleteItem(removed.id);
    setIsDeleting(false);
    setItemToDelete(null);
    notify(`${removed.name} removed from stock`, {
      kind: 'info',
      detail: 'Past sales that include it are kept for your reports.',
      action: { label: 'Undo', onClick: () => void restoreItem(removed) },
    });
  };

  const handleRestock = async (item: Item, amount: number) => {
    await quickRestock(item.id, amount);
    notify(`${item.name} restocked +${amount}`, {
      kind: 'success',
      detail: `Now ${item.quantity + amount} in stock`,
    });
  };

  const previewMargin = useMemo(() => {
    const buy = parseFloat(formData.buyingPrice);
    const sell = parseFloat(formData.sellingPrice);
    if (!Number.isFinite(sell) || sell <= 0) return null;
    const cost = Number.isFinite(buy) ? buy : 0;
    const profit = sell - cost;
    const pct = cost > 0 ? Math.round((profit / cost) * 100).toString() : '—';
    return { profit, pct, isLoss: profit < 0, missingCost: !Number.isFinite(buy) };
  }, [formData.buyingPrice, formData.sellingPrice]);

  return (
    <div className="w-full space-y-4">
      {/* Top Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Retail Value */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Stock Retail Value
          </span>
          <p className="text-2xl font-black text-emerald-900 tracking-tight mt-1 tabular-nums">
            K {totalStockValue.toLocaleString()}
          </p>
          <span className="text-xs text-slate-500 font-medium">
            Based on selling price
          </span>
        </div>

        {/* Cost Value */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Total Inventory Cost
          </span>
          <p className="text-2xl font-black text-slate-800 tracking-tight mt-1 tabular-nums">
            K {totalCostValue.toLocaleString()}
          </p>
          <span className="text-xs text-emerald-700 font-semibold">
            Potential Profit: K {(totalStockValue - totalCostValue).toLocaleString()}
          </span>
        </div>

        {/* Total Products & Low Stock Alert */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Inventory Status
            </span>
            <p className="text-2xl font-black text-slate-900 tracking-tight mt-1 tabular-nums">
              {items.length} <span className="text-xs font-semibold text-slate-500">items</span>
            </p>
            <span className={`text-xs font-bold ${lowStockItems.length > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
              {lowStockItems.length > 0
                ? `${lowStockItems.length} items low or out of stock`
                : 'All stock levels healthy'}
            </span>
          </div>

          <button
            onClick={handleOpenAdd}
            className="min-h-[44px] bg-emerald-800 hover:bg-emerald-900 active:scale-95 text-white font-bold text-xs px-3.5 py-2.5 rounded-xl flex items-center space-x-1.5 shadow-xs transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t.addItem}</span>
          </button>
        </div>
      </div>

      {/* Control Bar: Subtabs + Search */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Subtabs */}
        <div className="flex items-center space-x-1.5 bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveSubTab('all')}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'all'
                ? 'bg-white text-emerald-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.allStockTab} ({items.length})
          </button>

          <button
            onClick={() => setActiveSubTab('low')}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 ${
              activeSubTab === 'low'
                ? 'bg-amber-100 text-amber-900 shadow-xs'
                : 'text-slate-600 hover:text-amber-800'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            <span>{t.lowStockTab}</span>
            {lowStockItems.length > 0 && (
              <span className="bg-amber-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {lowStockItems.length}
              </span>
            )}
          </button>
        </div>

        {/* Search Input */}
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.searchItem}
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

      {/* Items List / Table */}
      {filteredItems.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-12 text-center">
          <Boxes className="w-12 h-12 text-slate-300 mx-auto mb-2" />
          {searchQuery.trim() ? (
            <>
              <h3 className="font-bold text-slate-800 text-sm">
                Nothing matches “{searchQuery.trim()}”
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                {items.length} {items.length === 1 ? 'item is' : 'items are'} in your stock book — try a
                shorter word, or add this product.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={() => setSearchQuery('')}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-4 py-2.5 rounded-xl transition-colors"
                >
                  Clear search
                </button>
                <button
                  onClick={handleOpenAdd}
                  className="bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-xs transition-colors"
                >
                  {t.addItem}
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="font-bold text-slate-800 text-sm">
                {activeSubTab === 'low' ? 'Nothing is running low' : t.noItemsYet}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                {activeSubTab === 'low'
                  ? 'Every product is above its warning level. You will see it here when stock drops.'
                  : t.noItemsYetHint}
              </p>
              {activeSubTab === 'all' && (
                <button
                  onClick={handleOpenAdd}
                  className="mt-4 bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs px-5 py-2.5 rounded-xl shadow-xs transition-colors"
                >
                  {t.addItem}
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden divide-y divide-slate-100">
          {/* Table Header (hidden on mobile, visible on sm+) */}
          <div className="hidden sm:grid grid-cols-12 gap-3 px-4 py-2.5 bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <div className="col-span-4">Product Name</div>
            <div className="col-span-2 text-right">Selling Price</div>
            <div className="col-span-2 text-right">Cost Price</div>
            <div className="col-span-2 text-center">In Stock</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>

          {filteredItems.map((item) => {
            const isOutOfStock = item.quantity === 0;
            const isLowStock = item.quantity <= item.lowStockThreshold;

            return (
              <div
                key={item.id}
                className="p-3.5 sm:px-4 sm:py-3 hover:bg-slate-50/70 transition-colors flex flex-col sm:grid sm:grid-cols-12 sm:gap-3 sm:items-center"
              >
                {/* Column 1: Name and low-stock badge */}
                <div className="sm:col-span-4 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-sm text-slate-900 truncate">
                      {item.name}
                    </span>
                    {isOutOfStock ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                        {t.outOfStock}
                      </span>
                    ) : isLowStock ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                        Low Stock (Warn &le; {item.lowStockThreshold})
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 sm:hidden flex items-center space-x-2">
                    <span>Cost: K {item.buyingPrice}</span>
                    <span>·</span>
                    <span className="text-emerald-700 font-medium">Profit: +K {item.sellingPrice - item.buyingPrice}</span>
                  </div>
                </div>

                {/* Column 2: Selling Price */}
                <div className="sm:col-span-2 sm:text-right mt-1 sm:mt-0 flex items-center justify-between sm:block">
                  <span className="text-xs text-slate-500 sm:hidden">Selling:</span>
                  <span className="text-sm font-black text-emerald-900 tabular-nums">
                    K {item.sellingPrice.toFixed(2)}
                  </span>
                </div>

                {/* Column 3: Buying Price */}
                <div className="hidden sm:block sm:col-span-2 sm:text-right">
                  <span className="text-xs font-semibold text-slate-600 tabular-nums">
                    K {item.buyingPrice.toFixed(2)}
                  </span>
                  <p className="text-[10px] text-emerald-700 font-medium tabular-nums">
                    +K {(item.sellingPrice - item.buyingPrice).toFixed(2)}
                  </p>
                </div>

                {/* Column 4: Quantity & Quick Restock buttons */}
                <div className="sm:col-span-2 mt-2 sm:mt-0 flex items-center justify-between sm:justify-center">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`text-sm font-extrabold tabular-nums px-2 py-0.5 rounded-lg border ${
                        isOutOfStock
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : isLowStock
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : 'bg-slate-100 text-slate-800 border-slate-200'
                      }`}
                    >
                      {item.quantity}
                    </span>

                    {/* Quick restock shortcuts */}
                    <div className="flex items-center space-x-1">
                      {[5, 10].map((amount) => (
                        <button
                          key={amount}
                          onClick={() => void handleRestock(item, amount)}
                          title={`Add ${amount} units to stock`}
                          className="text-[10px] font-bold bg-slate-100 hover:bg-emerald-100 hover:text-emerald-900 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 transition-colors"
                        >
                          +{amount}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Column 5: Edit & Delete Actions */}
                <div className="sm:col-span-2 mt-2 sm:mt-0 flex items-center justify-end space-x-1.5">
                  <button
                    onClick={() => handleOpenEdit(item)}
                    className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                    title="Edit item"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setItemToDelete(item)}
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                    title="Remove item"
                    aria-label={`Remove ${item.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Product Modal Sheet */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-5 sm:p-6 max-w-md w-full shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
                  <PackagePlus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900">
                    {editingItem ? 'Edit Product' : t.addItem}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    {editingItem ? 'Update prices and stock levels' : 'Add new merchandise to stock'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-3.5 mt-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t.itemName} *
                </label>
                <input
                  type="text"
                  required
                  autoFocus={!editingItem}
                  autoComplete="off"
                  placeholder="e.g. Sugar 1kg, Cooking Oil 2L, Panado"
                  value={formData.name}
                  onChange={(e) => { setFormData({ ...formData, name: e.target.value }); setFormError(''); }}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.sellingPrice} (K) *
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    placeholder="e.g. 25"
                    value={formData.sellingPrice}
                    onChange={(e) => {
                      setFormData({ ...formData, sellingPrice: sanitizeMoneyInput(e.target.value) });
                      setFormError('');
                    }}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono font-bold"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">What you sell it for</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.buyingPrice} (K)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="e.g. 18"
                    value={formData.buyingPrice}
                    onChange={(e) => setFormData({ ...formData, buyingPrice: sanitizeMoneyInput(e.target.value) })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">What you paid for it</p>
                </div>
              </div>

              {/* Profit preview — tells the shopkeeper, in words, what each sale earns */}
              {previewMargin && (
                previewMargin.isLoss ? (
                  <div className="p-2 bg-amber-50 rounded-xl border border-amber-300 text-[11px] text-amber-900 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      You would <strong>lose {formatKwacha(Math.abs(previewMargin.profit))}</strong> on
                      every sale at this price. Check the two prices.
                    </span>
                  </div>
                ) : (
                  <div className="p-2 bg-emerald-50 rounded-xl border border-emerald-200 text-[11px] text-emerald-900 flex items-center justify-between">
                    <span>Profit on each sale</span>
                    <span className="font-extrabold tabular-nums">
                      +{formatKwacha(previewMargin.profit)}
                      {previewMargin.missingCost ? '' : ` (${previewMargin.pct}%)`}
                    </span>
                  </div>
                )
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.inStock} ({t.qty}) *
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    placeholder="e.g. 50"
                    value={formData.quantity}
                    onChange={(e) => {
                      setFormData({ ...formData, quantity: sanitizeIntegerInput(e.target.value) });
                      setFormError('');
                    }}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono font-bold"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">How many you have now</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.lowStockWarning}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="e.g. 5"
                    value={formData.lowStockThreshold}
                    onChange={(e) =>
                      setFormData({ ...formData, lowStockThreshold: sanitizeIntegerInput(e.target.value) })
                    }
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">Warn me at or below this</p>
                </div>
              </div>

              {formError && (
                <p className="text-[11px] font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-2.5 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </p>
              )}

              <div className="pt-2 flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={isSaving}
                  className="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex-1 min-h-[44px] bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs py-2.5 rounded-xl shadow-xs transition-colors disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : editingItem ? 'Save Changes' : t.addItem}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {itemToDelete && (
        <ConfirmDialog
          title={`Remove ${itemToDelete.name}?`}
          description={
            <>
              <p>
                It disappears from the Sell screen and your stock list. Past sales that include it
                stay in your reports.
              </p>
              <p className="text-slate-500">
                You can undo this straight away from the message that follows.
              </p>
            </>
          }
          confirmLabel="Remove item"
          busy={isDeleting}
          onCancel={() => setItemToDelete(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </div>
  );
};
