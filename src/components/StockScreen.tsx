import React, { useEffect, useMemo, useState } from 'react';
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
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react';
import { Item } from '../types';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { formatKwacha, sanitizeIntegerInput, sanitizeMoneyInput } from '../utils/format';
import { parseKwachaToNgwee } from '../utils/money';
import { StockTools } from './StockTools';

export const StockScreen: React.FC<{ initialAdd?: boolean; onConsumedInitialAdd?: () => void }> = ({
  initialAdd,
  onConsumedInitialAdd,
}) => {
  const { items, archivedItems, addItem, updateItem, quickRestock, deleteItem, restoreItem, t } =
    useShop();
  const { notify } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeSubTab, setActiveSubTab] = useState<'all' | 'low' | 'archived'>('all');
  const [adjustingItem, setAdjustingItem] = useState<Item | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(Boolean(initialAdd));
  useEffect(() => {
    if (initialAdd) onConsumedInitialAdd?.();
  }, [initialAdd, onConsumedInitialAdd]);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [showItemOptions, setShowItemOptions] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<Item | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    unitLabel: '',
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
    let result =
      activeSubTab === 'archived' ? archivedItems : activeSubTab === 'low' ? lowStockItems : items;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.name.toLowerCase().includes(q));
    }
    return result;
  }, [items, archivedItems, lowStockItems, activeSubTab, searchQuery]);

  // Open add modal
  const handleOpenAdd = () => {
    setEditingItem(null);
    setFormError('');
    setShowItemOptions(false);
    setFormData({
      name: '',
      unitLabel: '',
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
    setFormError('');
    setShowItemOptions(false);
    setFormData({
      name: item.name,
      unitLabel: item.unitLabel || '',
      buyingPrice: item.buyingPriceKnown === false ? '' : item.buyingPrice.toString(),
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
    let buying: number;
    let selling: number;
    try {
      buying = formData.buyingPrice.trim()
        ? parseKwachaToNgwee(formData.buyingPrice, true) / 100
        : 0;
      selling = parseKwachaToNgwee(formData.sellingPrice) / 100;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Enter valid prices.');
      return;
    }
    const qty = Number(formData.quantity);
    const threshold = Number(formData.lowStockThreshold);
    if (!name) {
      setFormError('Give the item a name — e.g. “Sugar 1kg”.');
      return;
    }
    if (!formData.quantity.trim() || !Number.isSafeInteger(qty) || qty < 0 || qty > 1_000_000) {
      setFormError('Enter a whole stock quantity between 0 and 1,000,000.');
      return;
    }
    if (
      !formData.lowStockThreshold.trim() ||
      !Number.isSafeInteger(threshold) ||
      threshold < 0 ||
      threshold > 1_000_000
    ) {
      setShowItemOptions(true);
      setFormError('Enter a whole low-stock warning between 0 and 1,000,000.');
      return;
    }

    setIsSaving(true);
    try {
      if (editingItem) {
        await updateItem(editingItem.id, {
          name,
          unitLabel: formData.unitLabel.trim(),
          buyingPrice: buying,
          buyingPriceKnown: Boolean(formData.buyingPrice.trim()),
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
          unitLabel: formData.unitLabel.trim(),
          buyingPrice: buying,
          buyingPriceKnown: Boolean(formData.buyingPrice.trim()),
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

  const handleRestore = async (item: Item) => {
    try {
      await restoreItem(item);
      notify(`${item.name} restored to stock`);
    } catch (err) {
      notify('Could not restore this item', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  // Delete with an undo, so a mis-tap cannot lose a product and its prices
  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    setIsDeleting(true);
    const removed = itemToDelete;
    try {
      await deleteItem(removed.id);
      setItemToDelete(null);
      notify(`${removed.name} removed from stock`, {
        kind: 'info',
        detail: 'Past sales that include it are kept for your reports.',
        action: { label: 'Undo', onClick: () => void handleRestore(removed) },
      });
    } catch (err) {
      setItemToDelete(null);
      notify('Could not remove this item', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRestock = async (item: Item, amount: number) => {
    try {
      await quickRestock(item.id, amount);
      notify(`${item.name} restocked +${amount}`, {
        kind: 'success',
        detail: `Now ${item.quantity + amount} in stock`,
      });
    } catch (err) {
      notify('Could not restock this item', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  const previewMargin = useMemo(() => {
    const buy = parseFloat(formData.buyingPrice);
    const sell = parseFloat(formData.sellingPrice);
    if (!Number.isFinite(sell) || sell <= 0 || !Number.isFinite(buy)) return null;
    const cost = buy;
    const profit = sell - cost;
    const pct = cost > 0 ? Math.round((profit / cost) * 100).toString() : '—';
    return { profit, pct, isLoss: profit < 0, missingCost: !Number.isFinite(buy) };
  }, [formData.buyingPrice, formData.sellingPrice]);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">Stock</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {items.length} {items.length === 1 ? 'product' : 'products'}
            {lowStockItems.length > 0 ? ` · ${lowStockItems.length} running low` : ''}
          </p>
        </div>
        <button
          onClick={handleOpenAdd}
          className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-4 text-xs font-bold text-white shadow-xs transition-colors hover:bg-emerald-900"
        >
          <Plus className="w-4 h-4" />
          <span>{t.addItem.replace(/^\+\s*/, '')}</span>
        </button>
      </div>

      <details className="rounded-2xl border border-slate-200 bg-white px-4 shadow-xs">
        <summary className="min-h-[44px] cursor-pointer py-3 text-sm font-bold text-slate-700">
          Stock value &amp; details
        </summary>
        <div className="grid gap-3 pb-4 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs font-bold text-slate-600">Stock value at selling price</p>
            <p className="mt-1 text-xl font-black tabular-nums text-emerald-900">
              K {totalStockValue.toLocaleString()}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs font-bold text-slate-600">Stock cost</p>
            <p className="mt-1 text-xl font-black tabular-nums text-slate-900">
              K {totalCostValue.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {items.some((item) => item.buyingPriceKnown === false)
                ? 'Some costs are not recorded'
                : `Potential profit: K ${(totalStockValue - totalCostValue).toLocaleString()}`}
            </p>
          </div>
        </div>
      </details>

      {/* Control Bar: Subtabs + Search */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
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
          <button
            onClick={() => setActiveSubTab('archived')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeSubTab === 'archived' ? 'bg-white text-emerald-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
          >
            Archived ({archivedItems.length})
          </button>
        </div>

        {/* Search Input */}
        <div className="relative flex-1 lg:max-w-xs">
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

      <StockTools adjustingItem={adjustingItem} onCloseAdjustment={() => setAdjustingItem(null)} />

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
                {items.length} {items.length === 1 ? 'item is' : 'items are'} in your stock book —
                try a shorter word, or add this product.
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
                {activeSubTab === 'archived'
                  ? 'No archived products'
                  : activeSubTab === 'low'
                    ? 'Nothing is running low'
                    : t.noItemsYet}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                {activeSubTab === 'archived'
                  ? 'Archived products stay available here and can be restored at any time.'
                  : activeSubTab === 'low'
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
          {/* Table Header (hidden on mobile, visible on large screens) */}
          <div className="hidden lg:grid grid-cols-12 gap-3 px-4 py-2.5 bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-500">
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
                className="p-3.5 lg:px-4 lg:py-3 hover:bg-slate-50/70 transition-colors flex flex-col lg:grid lg:grid-cols-12 lg:gap-3 lg:items-center"
              >
                {/* Column 1: Name and low-stock badge */}
                <div className="lg:col-span-4 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-sm text-slate-900 truncate">
                      {item.name}
                      {item.unitLabel ? ` · ${item.unitLabel}` : ''}
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
                  <div className="text-[11px] text-slate-400 mt-0.5 lg:hidden flex items-center space-x-2">
                    {item.buyingPriceKnown === false ? (
                      <span>Cost not recorded</span>
                    ) : (
                      <>
                        <span>Cost: K {item.buyingPrice}</span>
                        <span>·</span>
                        <span className="text-emerald-700 font-medium">
                          Profit: K {(item.sellingPrice - item.buyingPrice).toFixed(2)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Column 2: Selling Price */}
                <div className="lg:col-span-2 lg:text-right mt-1 lg:mt-0 flex items-center justify-between lg:block">
                  <span className="text-xs text-slate-500 lg:hidden">Selling:</span>
                  <span className="text-sm font-black text-emerald-900 tabular-nums">
                    K {item.sellingPrice.toFixed(2)}
                  </span>
                </div>

                {/* Column 3: Buying Price */}
                <div className="hidden lg:block lg:col-span-2 lg:text-right">
                  {item.buyingPriceKnown === false ? (
                    <span className="text-xs text-slate-400">Not recorded</span>
                  ) : (
                    <>
                      <span className="text-xs font-semibold text-slate-600 tabular-nums">
                        K {item.buyingPrice.toFixed(2)}
                      </span>
                      <p className="text-[10px] text-emerald-700 font-medium tabular-nums">
                        K {(item.sellingPrice - item.buyingPrice).toFixed(2)}
                      </p>
                    </>
                  )}
                </div>

                {/* Column 4: Quantity & Quick Restock buttons */}
                <div className="lg:col-span-2 mt-2 lg:mt-0 flex items-center justify-between lg:justify-center">
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
                      {activeSubTab !== 'archived' &&
                        [5, 10].map((amount) => (
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
                <div className="lg:col-span-2 mt-2 lg:mt-0 flex items-center justify-end space-x-1.5">
                  {activeSubTab === 'archived' ? (
                    <button
                      onClick={() => void handleRestore(item)}
                      className="min-h-[40px] px-3 text-xs font-bold text-emerald-800 hover:bg-emerald-50 rounded-lg flex items-center gap-1"
                      aria-label={`Restore ${item.name}`}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restore
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setAdjustingItem(item)}
                        className="flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-xs font-bold text-slate-600 hover:bg-slate-100 hover:text-emerald-800"
                        title="Adjust stock"
                        aria-label={`Adjust stock for ${item.name}`}
                      >
                        <SlidersHorizontal className="w-4 h-4" />
                        <span>Adjust</span>
                      </button>
                      <button
                        onClick={() => handleOpenEdit(item)}
                        className="flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-xs font-bold text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                        title="Edit item"
                        aria-label={`Edit ${item.name}`}
                      >
                        <Edit2 className="w-4 h-4" />
                        <span>Edit</span>
                      </button>
                      <button
                        onClick={() => setItemToDelete(item)}
                        className="flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-xs font-bold text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                        title="Archive item"
                        aria-label={`Remove ${item.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>Archive</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Product Modal Sheet */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingItem ? 'Edit product' : 'Add product'}
            className="bg-white rounded-3xl p-5 sm:p-6 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95"
          >
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
                    {editingItem
                      ? 'Update prices and stock levels'
                      : 'Add new merchandise to stock'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                disabled={isSaving}
                aria-label="Close product form"
                className="h-10 w-10 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="mt-4 space-y-3.5">
              <label className="block text-xs font-bold text-slate-700">
                {t.itemName} *
                <input
                  type="text"
                  required
                  autoFocus={!editingItem}
                  autoComplete="off"
                  placeholder="e.g. Sugar 1kg"
                  value={formData.name}
                  onChange={(e) => {
                    setFormData({ ...formData, name: e.target.value });
                    setFormError('');
                  }}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-bold text-slate-700">
                  {t.sellingPrice} *
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    placeholder="e.g. 25"
                    value={formData.sellingPrice}
                    onChange={(e) => {
                      setFormData({
                        ...formData,
                        sellingPrice: sanitizeMoneyInput(e.target.value),
                      });
                      setFormError('');
                    }}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  />
                  <span className="mt-1 block text-[11px] font-normal text-slate-500">
                    What you sell it for
                  </span>
                </label>
                <label className="block text-xs font-bold text-slate-700">
                  {t.buyingPrice}
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="e.g. 18"
                    value={formData.buyingPrice}
                    onChange={(e) =>
                      setFormData({ ...formData, buyingPrice: sanitizeMoneyInput(e.target.value) })
                    }
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                  />
                  <span className="mt-1 block text-[11px] font-normal text-slate-500">
                    Optional; needed for profit
                  </span>
                </label>
              </div>

              {previewMargin &&
                (previewMargin.isLoss ? (
                  <div className="p-2 bg-amber-50 rounded-xl border border-amber-300 text-[11px] text-amber-900 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      You would <strong>lose {formatKwacha(Math.abs(previewMargin.profit))}</strong>{' '}
                      on every sale at this price. Check the two prices.
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
                ))}

              <label className="block text-xs font-bold text-slate-700">
                {t.inStock} ({t.qty}) *
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
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
                <span className="mt-1 block text-[11px] font-normal text-slate-500">
                  How many you have now
                </span>
              </label>

              <details
                open={showItemOptions}
                onToggle={(event) => setShowItemOptions(event.currentTarget.open)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3"
              >
                <summary className="min-h-[44px] cursor-pointer py-3 text-xs font-bold text-slate-700">
                  More options: pack size and low-stock alert
                </summary>
                <div className="space-y-3 pb-3">
                  <label className="block text-xs font-bold text-slate-700">
                    Unit or pack size (optional)
                    <input
                      type="text"
                      maxLength={40}
                      value={formData.unitLabel}
                      onChange={(e) => setFormData({ ...formData, unitLabel: e.target.value })}
                      placeholder="e.g. 500ml, 2kg bag"
                      className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-normal text-slate-900"
                    />
                  </label>
                  <label className="block text-xs font-bold text-slate-700">
                    Low-stock alert
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={formData.lowStockThreshold}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          lowStockThreshold: sanitizeIntegerInput(e.target.value),
                        })
                      }
                      className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-normal text-slate-900"
                    />
                    <span className="mt-1 block text-[11px] font-normal text-slate-500">
                      Warn me when stock is at or below this number.
                    </span>
                  </label>
                </div>
              </details>

              {formError && (
                <p
                  role="alert"
                  className="text-[11px] font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-2.5 flex items-start gap-1.5"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </p>
              )}
              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={isSaving}
                  className="min-h-[44px] flex-1 rounded-xl bg-slate-100 text-xs font-bold text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="min-h-[44px] flex-1 rounded-xl bg-emerald-800 text-xs font-bold text-white shadow-xs hover:bg-emerald-900 disabled:opacity-50"
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
