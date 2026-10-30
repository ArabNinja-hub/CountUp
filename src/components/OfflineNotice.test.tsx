// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { OfflineNotice } from './OfflineNotice';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps the reason for a blocked online sync visible until dismissed', () => {
  vi.mocked(useShop).mockReturnValue({
    lastOfflineNotice:
      '2 entries could not sync yet. A repayment conflicts with a newer customer balance.',
    clearOfflineNotice: vi.fn(),
    isOnline: true,
    pendingSyncCount: 2,
    syncNow: vi.fn(),
    isSyncing: false,
  } as unknown as ReturnType<typeof useShop>);
  render(<OfflineNotice />);
  expect(screen.getByText(/repayment conflicts with a newer customer balance/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sync Now' })).toBeTruthy();
});
