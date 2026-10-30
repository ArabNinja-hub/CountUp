// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { CreditBookScreen } from './CreditBookScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Credit customer entry', () => {
  it('prevents duplicate submissions and shows storage errors without closing the form', async () => {
    let rejectSave!: (error: Error) => void;
    const addCustomer = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        })
    );
    vi.mocked(useShop).mockReturnValue({
      customers: [],
      sales: [],
      creditPayments: [],
      addCustomer,
      recordCreditPayment: vi.fn(),
      t: translations.en,
      shop: { name: 'Test Shop' },
      language: 'en',
    } as unknown as ReturnType<typeof useShop>);
    render(<CreditBookScreen />);
    fireEvent.click(screen.getAllByRole('button', { name: /New Customer/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('e.g. Ba Bwalya, Mrs. Phiri'), {
      target: { value: 'Mwamba' },
    });
    const form = screen.getByRole('button', { name: 'Save Customer' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(addCustomer).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectSave(new Error('Storage full'));
    });
    expect(screen.getByRole('alert').textContent).toBe('Storage full');
    expect(screen.getByRole('button', { name: 'Save Customer' })).toBeTruthy();
  });
});
