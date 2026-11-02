// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { HomeScreen } from './HomeScreen';
import { localDateKey } from '../utils/money';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Action-first home', () => {
  it('shows reconciled sales, received money, outstanding credit and known-cost profit', () => {
    const createdAt = new Date().toISOString();
    const localDate = localDateKey(new Date());
    const sale = (id: string, paymentType: 'cash' | 'momo' | 'credit', totalAmount: number) => ({
      id,
      shopId: 'shop',
      items: [],
      itemsCount: 1,
      totalAmount,
      totalCost: totalAmount * 0.6,
      profit: totalAmount * 0.4,
      paymentType,
      customerId: paymentType === 'credit' ? 'customer' : undefined,
      createdAt,
      localDate,
    });
    vi.mocked(useShop).mockReturnValue({
      shop: { name: 'Bwino' },
      sales: [
        sale('cash-sale', 'cash', 40),
        sale('momo-sale', 'momo', 30),
        sale('credit-sale', 'credit', 50),
      ],
      creditPayments: [
        {
          id: 'repayment',
          shopId: 'shop',
          customerId: 'customer',
          customerName: 'Customer',
          amount: 20,
          paymentMethod: 'cash',
          createdAt,
          localDate,
        },
      ],
      customers: [{ id: 'customer', name: 'Customer', totalOwed: 30 }],
      items: [],
      stockConflicts: [],
      setActiveTab: vi.fn(),
      isOnline: true,
      pendingSyncCount: 0,
    } as unknown as ReturnType<typeof useShop>);

    render(<HomeScreen onAddProduct={vi.fn()} onOpenHelp={vi.fn()} />);
    expect(screen.getByText('Sales', { selector: 'p' }).nextElementSibling?.textContent).toBe(
      'K 120.00'
    );
    expect(screen.getByText('Money received').nextElementSibling?.textContent).toBe('K 90.00');
    expect(screen.getByText(/Cash K 60\.00 · MoMo K 30\.00/)).toBeTruthy();
    expect(screen.getByText(/Credit sales K 50\.00 · Repayments K 20\.00/)).toBeTruthy();
    expect(
      screen.getByText('Credit outstanding').parentElement?.nextElementSibling?.textContent
    ).toBe('K 30.00');
    expect(screen.getByText('Gross profit').nextElementSibling?.textContent).toBe('K 48.00');
  });

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
    expect(screen.getByText('Sales', { selector: 'p' }).nextElementSibling?.textContent).toBe(
      'K 0.00'
    );
    expect(screen.getByText('Money received').nextElementSibling?.textContent).toBe('K 0.00');
    expect(screen.getByText(/Cash K 0\.00 · MoMo K 0\.00/)).toBeTruthy();
    expect(screen.getByText(/Credit sales K 0\.00 · Repayments K 0\.00/)).toBeTruthy();
    expect(
      screen.getByText('Credit outstanding').parentElement?.nextElementSibling?.textContent
    ).toBe('K 0.00');
    expect(screen.getByText('Gross profit').nextElementSibling?.textContent).toBe('K 0.00');
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
