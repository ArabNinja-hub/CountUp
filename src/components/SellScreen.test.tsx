// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { Item, Sale, CreditPayment } from '../types';
import { SellScreen } from './SellScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));

const now = new Date().toISOString();
const item: Item = {
  id: 'sugar',
  shopId: 'shop',
  name: 'Sugar',
  quantity: 5,
  lowStockThreshold: 1,
  buyingPrice: 0,
  buyingPriceKnown: false,
  sellingPrice: 2.5,
  createdAt: now,
  updatedAt: now,
};
const sale: Sale = {
  id: 'sale',
  shopId: 'shop',
  items: [],
  itemsCount: 1,
  totalAmount: 5,
  totalCost: 2,
  profit: 3,
  paymentType: 'credit',
  createdAt: now,
};
const payment: CreditPayment = {
  id: 'payment',
  shopId: 'shop',
  customerId: 'customer',
  customerName: 'Customer',
  amount: 2,
  paymentMethod: 'momo',
  createdAt: now,
};

beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    items: [item],
    customers: [],
    addCustomer: vi.fn(),
    recordSale: vi.fn(),
    t: translations.en,
    subscription: { canRecordSales: true },
    isShopDeactivated: false,
    sales: [sale],
    creditPayments: [payment],
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Sell screen', () => {
  it('lets a mobile user adjust a cart and collapse checkout to add more items', () => {
    render(<SellScreen onOpenPlan={vi.fn()} onGoToStock={vi.fn()} />);
    fireEvent.click(screen.getByText('Sugar'));
    expect(document.getElementById('mobile-checkout')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review sale' }));
    const checkout = document.getElementById('mobile-checkout')!;
    fireEvent.click(within(checkout).getByRole('button', { name: 'Increase Sugar quantity' }));
    expect(within(checkout).getByText('2')).toBeTruthy();
    fireEvent.click(within(checkout).getByRole('button', { name: 'Decrease Sugar quantity' }));
    expect(within(checkout).getByText('1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add items' }));
    expect(document.getElementById('mobile-checkout')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review sale' }));
    expect(document.getElementById('mobile-checkout')).not.toBeNull();
  });

  it('allows keyboard users to add a product to the cart', () => {
    render(<SellScreen onOpenPlan={vi.fn()} onGoToStock={vi.fn()} />);
    const product = screen.getByRole('button', { name: 'Add Sugar to cart' });
    fireEvent.keyDown(product, { key: 'Enter' });
    expect(document.getElementById('mobile-checkout')).toBeNull();
    fireEvent.keyDown(product, { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Review sale' }));
    expect(within(document.getElementById('mobile-checkout')!).getByText('2')).toBeTruthy();
  });

  it('saves a mobile money sale with optional details from the simplified checkout', async () => {
    const recordSale = vi.fn().mockResolvedValue({ totalAmount: 5, receiptNumber: 'receipt-1' });
    vi.mocked(useShop).mockReturnValue({
      ...vi.mocked(useShop)(),
      recordSale,
    });
    render(<SellScreen onOpenPlan={vi.fn()} onGoToStock={vi.fn()} />);
    fireEvent.click(screen.getByText('Sugar'));
    fireEvent.click(screen.getByRole('button', { name: 'Review sale' }));
    const checkout = document.getElementById('mobile-checkout')!;
    fireEvent.click(within(checkout).getByRole('button', { name: 'Increase Sugar quantity' }));
    fireEvent.click(within(checkout).getByRole('button', { name: 'Mobile Money' }));
    fireEvent.click(within(checkout).getByRole('button', { name: 'MTN MoMo' }));
    fireEvent.click(within(checkout).getByText('More details (optional)'));
    fireEvent.change(within(checkout).getByLabelText('Mobile Money reference'), {
      target: { value: 'ref-123' },
    });
    fireEvent.change(within(checkout).getByLabelText('Sale note'), {
      target: { value: 'Delivery' },
    });
    const save = within(checkout).getByRole('button', { name: /Save Sale/ });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(recordSale).toHaveBeenCalledTimes(1));
    expect(recordSale).toHaveBeenCalledWith(
      expect.objectContaining({
        totalAmount: 5,
        paymentType: 'momo',
        momoOperator: 'mtn',
        paymentReference: 'ref-123',
        note: 'Delivery',
      })
    );
    await waitFor(() => expect(screen.getByText('Sale Recorded!')).toBeTruthy());
  });

  it('includes repayments in the received-today summary and does not invent profit for unknown costs', () => {
    render(<SellScreen onOpenPlan={vi.fn()} onGoToStock={vi.fn()} />);
    const received = screen.getByText('Received, including repayments').parentElement!;
    expect(within(received).getByText('K 2.00')).toBeTruthy();
    fireEvent.click(screen.getByText('Sugar'));
    expect(screen.getByText('Profit on known costs')).toBeTruthy();
    expect(screen.getByText(/Profit excludes K 2.50 in sales with unknown cost/)).toBeTruthy();
  });
});
