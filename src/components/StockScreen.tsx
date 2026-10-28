import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import {
  Boxes,
  Plus,
  AlertTriangle,
  Search,
  Edit2,
  Trash2,
  TrendingUp,
  X,
  Check,
  PackagePlus,
  ArrowUpDown,
} from 'lucide-react';
import { Item } from '../types';

export const StockScreen: React.FC = () => {
  const { items, addItem, updateItem, quickRestock, deleteItem, t } = useShop();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeSubTab, setActiveSubTab] = useState<'all' | 'low'>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);

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

  // Save (add or edit)
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formData.name.trim();
    const buyingPrice = parseFloat(formData.buyingPrice) || 0;
    const sellingPrice = parseFloat(formData.sellingPrice) || 0;
    const quantity = parseInt(formData.quantity, 10) || 0;
    const lowStockThreshold = parseInt(formData.lowStockThreshold, 10) || 5;

    if (!name || sellingPrice <= 0) {
      alert('Please enter item name and a valid selling price');
      return;
    }

    if (editingItem) {
      await updateItem(editingItem.id, {
        name,
        buyingPrice,
        sellingPrice,
        quantity,
        lowStockThreshold,
      });
    } else {
      await addItem({
        name,
        buyingPrice,
        sellingPrice,
        quantity,
        lowStockThreshold,
      });
    }

    setIsAddModalOpen(false);
  };

  const previewMargin = useMemo(() => {
    const buy = parseFloat(formData.buyingPrice) || 0;
    const sell = parseFloat(formData.sellingPrice) || 0;
    if (sell <= 0) return null;
    const profit = sell - buy;
    const pct = buy > 0 ? ((profit / buy) * 100).toFixed(0) : '100';
    return { profit, pct };
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
              <span className="bg-amber-600 text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full">
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
          <h3 className="font-bold text-slate-800 text-sm">
            {activeSubTab === 'low' ? 'No low stock items!' : t.noItemsYet}
          </h3>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            {activeSubTab === 'low'
              ? 'All products are currently stocked above their warning thresholds.'
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
                      <button
                        onClick={() => void quickRestock(item.id, 5)}
                        title="Restock +5 units"
                        className="text-[10px] font-bold bg-slate-100 hover:bg-emerald-100 hover:text-emerald-900 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 transition-colors"
                      >
                        +5
                      </button>
                      <button
                        onClick={() => void quickRestock(item.id, 10)}
                        title="Restock +10 units"
                        className="text-[10px] font-bold bg-slate-100 hover:bg-emerald-100 hover:text-emerald-900 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 transition-colors"
                      >
                        +10
                      </button>
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
                    onClick={() => {
                      if (confirm(`Delete "${item.name}" from your shop?`)) {
                        void deleteItem(item.id);
                      }
                    }}
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                    title="Delete item"
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
                  placeholder="e.g. Sugar 1kg, Cooking Oil 2L, Panado"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.sellingPrice} (K) *
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    required
                    placeholder="e.g. 25"
                    value={formData.sellingPrice}
                    onChange={(e) => setFormData({ ...formData, sellingPrice: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.buyingPrice} (K)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    placeholder="e.g. 18"
                    value={formData.buyingPrice}
                    onChange={(e) => setFormData({ ...formData, buyingPrice: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                  />
                </div>
              </div>

              {/* Profit margin preview */}
              {previewMargin && (
                <div className="p-2 bg-emerald-50 rounded-xl border border-emerald-200 text-[11px] text-emerald-900 flex items-center justify-between">
                  <span>Gross Profit Margin:</span>
                  <span className="font-extrabold tabular-nums">
                    +K {previewMargin.profit.toFixed(2)} ({previewMargin.pct}%)
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.inStock} ({t.qty}) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    placeholder="e.g. 50"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t.lowStockWarning}
                  </label>
                  <input
                    type="number"
                    min="1"
                    placeholder="e.g. 5"
                    value={formData.lowStockThreshold}
                    onChange={(e) => setFormData({ ...formData, lowStockThreshold: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs py-2.5 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 min-h-[44px] bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs py-2.5 rounded-xl shadow-xs transition-colors"
                >
                  {editingItem ? 'Save Changes' : t.addItem}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
