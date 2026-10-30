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
