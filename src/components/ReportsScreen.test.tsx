// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { ReportsScreen } from './ReportsScreen';

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
