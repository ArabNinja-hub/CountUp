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

describe('Shop deletion', () => {
  it.each([false, new Error('network interrupted')])(
    'warns that a failed deletion may have already removed records',
    async (result) => {
      const deleteShopAccount =
        result instanceof Error
          ? vi.fn().mockRejectedValue(result)
          : vi.fn().mockResolvedValue(result);
      vi.mocked(useShop).mockReturnValue({
        shop: { name: 'My Shop' },
        deleteShopAccount,
        items: [],
        sales: [],
        customers: [],
        expenses: [],
      } as unknown as ReturnType<typeof useShop>);
      render(<DeleteShopModal onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText(/Type My Shop to confirm/i), {
        target: { value: 'My Shop' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
      await waitFor(() =>
        expect(screen.getByText(/Some records may already have been removed/i)).toBeTruthy()
      );
      expect(screen.queryByText(/nothing has been removed/i)).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Delete forever' }) as HTMLButtonElement).disabled
      ).toBe(false);
    }
  );
});
