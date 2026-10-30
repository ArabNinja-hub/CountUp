// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
