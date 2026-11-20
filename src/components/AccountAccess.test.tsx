// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { AccountAccess } from './AccountAccess';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Cloud identity & SMS session recovery', () => {
  it('shows verified phone and PIN protection status when cloud session is active', () => {
    vi.mocked(useShop).mockReturnValue({
      user: { uid: 'owner-1', phone: '+260977123456' },
      shop: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'My Shop',
        ownerPhone: '+260977123456',
      },
      needsShopAccountRecovery: false,
      pendingSyncCount: 0,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);

    render(<AccountAccess onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Account & cloud access' })).toBeTruthy();
    expect(screen.getByText(/Verified phone & PIN protection active/i)).toBeTruthy();
    expect(screen.getByText('+260977123456')).toBeTruthy();
  });

  it('allows the original shop owner phone to reconnect via SMS OTP with pending entries', async () => {
    const sendPhoneVerificationCode = vi.fn().mockResolvedValue({ phoneE164: '+260977123456' });
    const restoreShopSessionWithOtp = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    vi.mocked(useShop).mockReturnValue({
      user: null,
      shop: { id: 'shop-1', name: 'My Shop', ownerPhone: '+260977123456' },
      needsShopAccountRecovery: true,
      sendPhoneVerificationCode,
      restoreShopSessionWithOtp,
      pendingSyncCount: 3,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);

    render(<AccountAccess onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Send SMS code to \+260977123456/i }));

    await waitFor(() =>
      expect(sendPhoneVerificationCode).toHaveBeenCalledWith('+260977123456', undefined)
    );

    fireEvent.change(screen.getByLabelText('6-digit SMS code'), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore cloud sync' }));

    await waitFor(() => expect(restoreShopSessionWithOtp).toHaveBeenCalledWith('246810'));
    expect(onClose).toHaveBeenCalled();
  });

  it('warns rather than replacing a different active account', () => {
    vi.mocked(useShop).mockReturnValue({
      user: { uid: 'other-user' },
      shop: { id: 'shop-1', name: 'My Shop', ownerPhone: '+260977123456' },
      needsShopAccountRecovery: true,
      pendingSyncCount: 1,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);

    render(<AccountAccess onClose={vi.fn()} />);
    expect(screen.getByText(/A different account is active/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send SMS code/i })).toBeNull();
  });
});
