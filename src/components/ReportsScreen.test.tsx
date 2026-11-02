// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { ReportsScreen } from './ReportsScreen';
import { localDateKey } from '../utils/money';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./TrendChart', () => ({ TrendChart: () => null }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));

const expense = {
  id: 'expense',
  shopId: 'shop',
  category: 'rent',
  amount: 1.5,
  createdAt: new Date().toISOString(),
};
const deleteExpense = vi.fn();
const restoreExpense = vi.fn();
beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    shop: { id: 'shop', name: 'Test' },
    sales: [],
    creditPayments: [],
    customers: [],
    items: [],
    expenses: [expense],
    deleteExpense,
    restoreExpense,
    voidSale: vi.fn(),
    t: translations.en,
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Reports ledger summaries', () => {
  it('shows the reconciled sales, repayments and current outstanding balance', () => {
    const today = new Date().toISOString();
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
      createdAt: today,
      localDate,
    });
    vi.mocked(useShop).mockReturnValue({
      shop: { id: 'shop', name: 'Test' },
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
          createdAt: today,
          localDate,
        },
      ],
      customers: [{ id: 'customer', name: 'Customer', totalOwed: 30 }],
      items: [],
      expenses: [],
      deleteExpense,
      restoreExpense,
      voidSale: vi.fn(),
      t: translations.en,
    } as unknown as ReturnType<typeof useShop>);

    render(<ReportsScreen />);
    fireEvent.click(screen.getByText('Day-by-day totals'));
    expect(
      screen.getByText(/Cash sale K 40\.00 · MoMo sale K 30\.00 · Credit K 50\.00/)
    ).toBeTruthy();
    expect(screen.getByText(/Cash repayment K 20\.00 · MoMo repayment K 0\.00/)).toBeTruthy();
    expect(screen.getByText('Money received K 90.00')).toBeTruthy();
    const outstandingLabel = screen.getByText('Outstanding credit');
    expect(outstandingLabel.nextElementSibling?.textContent).toBe('K 30.00');
  });
});

describe('Reports expense failure handling', () => {
  it('reports a failed delete and closes the confirmation', async () => {
    deleteExpense.mockRejectedValueOnce(new Error('Storage full'));
    render(<ReportsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete rent expense' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete expense' })
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Could not remove the expense',
        expect.objectContaining({ kind: 'error', detail: 'Storage full' })
      )
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a failure when an expense undo is attempted', async () => {
    deleteExpense.mockResolvedValueOnce(undefined);
    restoreExpense.mockRejectedValueOnce(new Error('Restore failed'));
    render(<ReportsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete rent expense' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete expense' })
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/Expense removed/),
        expect.anything()
      )
    );
    const options = notify.mock.calls[0][1] as { action: { onClick: () => void } };
    options.action.onClick();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Could not restore the expense',
        expect.objectContaining({ kind: 'error', detail: 'Restore failed' })
      )
    );
  });
});
