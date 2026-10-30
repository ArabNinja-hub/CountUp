// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { HomeScreen } from './HomeScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Action-first home', () => {
  it('helps a new shop add a product and exposes the main actions and guide', () => {
    const setActiveTab = vi.fn();
    const addProduct = vi.fn();
    const help = vi.fn();
    vi.mocked(useShop).mockReturnValue({
      shop: { name: 'Bwino' },
      sales: [],
      creditPayments: [],
      customers: [],
      items: [],
      stockConflicts: [],
      setActiveTab,
      isOnline: true,
      pendingSyncCount: 0,
    } as unknown as ReturnType<typeof useShop>);
    render(<HomeScreen onAddProduct={addProduct} onOpenHelp={help} />);
    expect(screen.getByText('Add your first product')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    expect(addProduct).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Record a sale/ }));
    expect(setActiveTab).toHaveBeenCalledWith('sell');
    fireEvent.click(screen.getByRole('button', { name: /View credit/ }));
    expect(setActiveTab).toHaveBeenCalledWith('credit');
    fireEvent.click(screen.getByRole('button', { name: /View reports/ }));
    expect(setActiveTab).toHaveBeenCalledWith('reports');
    fireEvent.click(screen.getByRole('button', { name: /Open the guide/ }));
    expect(help).toHaveBeenCalledOnce();
  });
});
