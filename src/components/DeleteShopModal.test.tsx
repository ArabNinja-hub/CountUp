// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { DeleteShopModal } from './DeleteShopModal';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Shop deletion (server Edge Function with name + PIN)', () => {
  it('requires both exact shop name and 4-digit PIN before enabling deletion', () => {
    vi.mocked(useShop).mockReturnValue({
      shop: { name: 'My Shop' },
      deleteShopAccount: vi.fn(),
      isOnline: true,
      pendingSyncCount: 0,
      items: [],
      sales: [],
      customers: [],
      expenses: [],
    } as unknown as ReturnType<typeof useShop>);

    render(<DeleteShopModal onClose={vi.fn()} />);
    const deleteBtn = screen.getByRole('button', { name: 'Delete forever' }) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type My Shop to confirm/i), {
      target: { value: 'My Shop' },
    });
    expect(deleteBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Enter your 4-digit PIN/i), {
      target: { value: '1234' },
    });
    expect(deleteBtn.disabled).toBe(false);
  });

  it.each([false, new Error('network interrupted')])(
    'keeps modal open and shows actionable error when server deletion fails',
    async (result) => {
      const deleteShopAccount =
        result instanceof Error
          ? vi.fn().mockRejectedValue(result)
          : vi.fn().mockResolvedValue(result);
      const onClose = vi.fn();

      vi.mocked(useShop).mockReturnValue({
        shop: { name: 'My Shop' },
        deleteShopAccount,
        isOnline: true,
        pendingSyncCount: 0,
        items: [],
        sales: [],
        customers: [],
        expenses: [],
      } as unknown as ReturnType<typeof useShop>);

      render(<DeleteShopModal onClose={onClose} />);
      fireEvent.change(screen.getByLabelText(/Type My Shop to confirm/i), {
        target: { value: 'My Shop' },
      });
      fireEvent.change(screen.getByLabelText(/Enter your 4-digit PIN/i), {
        target: { value: '1234' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));

      await waitFor(() => expect(deleteShopAccount).toHaveBeenCalledWith('My Shop', '1234'));
      await waitFor(() => expect(screen.getByText(/Deletion did not finish/i)).toBeTruthy());
      expect(onClose).not.toHaveBeenCalled();
      expect(
        (screen.getByRole('button', { name: 'Delete forever' }) as HTMLButtonElement).disabled
      ).toBe(false);
    }
  );
});
