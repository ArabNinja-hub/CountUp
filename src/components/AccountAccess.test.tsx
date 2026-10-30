// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { AccountAccess, EmailLoginPanel } from './AccountAccess';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Unified account access', () => {
  it('offers one shop account while being honest about credentials from earlier accounts', () => {
    vi.mocked(useShop).mockReturnValue({
      user: { isAnonymous: true },
      shop: { name: 'My Shop' },
      linkEmailAccount: vi.fn(),
      resetEmailPassword: vi.fn(),
      pendingSyncCount: 0,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);
    render(<AccountAccess onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Account & cloud access' })).toBeTruthy();
    expect(
      screen.getByText(
        /passwords and recovery keys from earlier accounts are not transferred automatically/i
      )
    ).toBeTruthy();
    expect(screen.queryByText(/ShopBook/i)).toBeNull();
  });

  it('allows the original linked account to reconnect with pending entries', async () => {
    const restoreShopAccount = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    vi.mocked(useShop).mockReturnValue({
      user: null,
      shop: { name: 'My Shop' },
      needsShopAccountRecovery: true,
      restoreShopAccount,
      resetEmailPassword: vi.fn(),
      pendingSyncCount: 3,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);
    render(<AccountAccess onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Linked email'), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect shop account' }));
    await waitFor(() =>
      expect(restoreShopAccount).toHaveBeenCalledWith('owner@example.com', 'password123')
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('warns rather than replacing a different active Firebase account', () => {
    vi.mocked(useShop).mockReturnValue({
      user: { uid: 'other', isAnonymous: true },
      shop: { name: 'My Shop' },
      needsShopAccountRecovery: true,
      pendingSyncCount: 1,
      isOnline: true,
    } as unknown as ReturnType<typeof useShop>);
    render(<AccountAccess onClose={vi.fn()} />);
    expect(screen.getByText(/A different account is active/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect shop account' })).toBeNull();
  });

  it('presents email sign-in as access to the same shop', () => {
    vi.mocked(useShop).mockReturnValue({
      loginWithEmail: vi.fn(),
      cancelEmailLogin: vi.fn(),
      selectEmailShop: vi.fn(),
      resetEmailPassword: vi.fn(),
    } as unknown as ReturnType<typeof useShop>);
    render(<EmailLoginPanel onBack={vi.fn()} />);
    expect(screen.getByText(/Sign in to a CountUp shop with email access enabled/i)).toBeTruthy();
    expect(
      screen.getByText(
        /passwords and recovery keys from earlier accounts are not transferred automatically/i
      )
    ).toBeTruthy();
    expect(screen.queryByText(/ShopBook/i)).toBeNull();
  });
});
