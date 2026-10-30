// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { Item } from '../types';
import { StockScreen } from './StockScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./StockTools', () => ({ StockTools: () => null }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));

const item: Item = {
  id: 'tea',
  shopId: 'shop',
  name: 'Tea',
  quantity: 3,
  lowStockThreshold: 1,
  buyingPrice: 1,
  sellingPrice: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const deleteItem = vi.fn();
const restoreItem = vi.fn();
const quickRestock = vi.fn();

beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    items: [item],
    archivedItems: [{ ...item, id: 'archived', name: 'Archived tea', isDeleted: true }],
    addItem: vi.fn(),
    updateItem: vi.fn(),
    quickRestock,
    deleteItem,
    restoreItem,
    t: translations.en,
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Stock failure handling', () => {
  it('reports a failed archive and releases the confirmation dialog', async () => {
    deleteItem.mockRejectedValueOnce(new Error('Storage full'));
    render(<StockScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tea' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove item' })
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Could not remove this item',
        expect.objectContaining({ kind: 'error', detail: 'Storage full' })
      )
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Tea' })).toBeTruthy();
  });

  it('adds a product with the simple form and a default low-stock alert', async () => {
    const addItem = vi.fn().mockResolvedValue('item-new');
    vi.mocked(useShop).mockReturnValue({ ...vi.mocked(useShop)(), addItem });
    render(<StockScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Add New Item' }));
    const form = screen.getByRole('dialog', { name: 'Add product' });
    const options = within(form)
      .getByText(/More options: pack size/)
      .closest('details')!;
    expect(options.open).toBe(false);
    fireEvent.change(within(form).getByLabelText(/Item Name/i), { target: { value: 'Rice' } });
    fireEvent.change(within(form).getByLabelText(/Selling Price/i), { target: { value: '25' } });
    fireEvent.change(within(form).getByLabelText(/Current Stock/i), { target: { value: '12' } });
    fireEvent.click(within(form).getByRole('button', { name: /Add New Item/i }));
    await waitFor(() =>
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Rice',
          sellingPrice: 25,
          buyingPriceKnown: false,
          quantity: 12,
          lowStockThreshold: 5,
        })
      )
    );
  });

  it('keeps pack size and low-stock options available while editing', async () => {
    const updateItem = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useShop).mockReturnValue({ ...vi.mocked(useShop)(), updateItem });
    render(<StockScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tea' }));
    const form = screen.getByRole('dialog', { name: 'Edit product' });
    fireEvent.click(within(form).getByText(/More options: pack size/));
    fireEvent.change(within(form).getByLabelText(/Unit or pack size/), {
      target: { value: '1kg' },
    });
    fireEvent.change(within(form).getByLabelText(/Low-stock alert/), { target: { value: '2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(updateItem).toHaveBeenCalledWith(
        'tea',
        expect.objectContaining({
          unitLabel: '1kg',
          lowStockThreshold: 2,
        })
      )
    );
  });

  it('opens the extra options when a hidden low-stock alert needs correcting', async () => {
    const updateItem = vi.fn();
    vi.mocked(useShop).mockReturnValue({ ...vi.mocked(useShop)(), updateItem });
    render(<StockScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tea' }));
    const form = screen.getByRole('dialog', { name: 'Edit product' });
    const summary = within(form).getByText(/More options: pack size/);
    const options = summary.closest('details')!;
    fireEvent.click(summary);
    fireEvent.change(within(form).getByLabelText(/Low-stock alert/), { target: { value: '' } });
    fireEvent.click(summary);
    expect(options.open).toBe(false);
    fireEvent.click(within(form).getByRole('button', { name: 'Save Changes' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(
      /whole low-stock warning/i
    );
    expect(options.open).toBe(true);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('reports failed restores and restocks instead of leaving unhandled rejections', async () => {
    restoreItem.mockRejectedValueOnce(new Error('Restore failed'));
    quickRestock.mockRejectedValueOnce(new Error('Restock failed'));
    render(<StockScreen />);
    fireEvent.click(screen.getByTitle('Add 5 units to stock'));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Could not restock this item',
        expect.objectContaining({ kind: 'error', detail: 'Restock failed' })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived tea' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Could not restore this item',
        expect.objectContaining({ kind: 'error', detail: 'Restore failed' })
      )
    );
  });
});
