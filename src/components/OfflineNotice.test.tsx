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

it('keeps the reason for a blocked online sync visible while entries are pending', () => {
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
  expect(screen.queryByRole('button', { name: 'Dismiss sync notice' })).toBeNull();
});

it('shows entries waiting to sync online even before the sync starts', () => {
  vi.mocked(useShop).mockReturnValue({
    lastOfflineNotice: null,
    clearOfflineNotice: vi.fn(),
    isOnline: true,
    pendingSyncCount: 2,
    syncNow: vi.fn(),
    isSyncing: false,
  } as unknown as ReturnType<typeof useShop>);
  render(<OfflineNotice />);
  expect(screen.getByText('2 entries waiting to sync')).toBeTruthy();
  expect(screen.getByText(/Keep this browser’s data/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sync Now' })).toBeTruthy();
});

it('hides a stale offline notice after reconnecting with nothing left to sync', () => {
  vi.mocked(useShop).mockReturnValue({
    lastOfflineNotice: 'Saved on this phone.',
    clearOfflineNotice: vi.fn(),
    isOnline: true,
    pendingSyncCount: 0,
    syncNow: vi.fn(),
    isSyncing: false,
  } as unknown as ReturnType<typeof useShop>);
  render(<OfflineNotice />);
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows pending offline entries in the page flow without covering the main actions', () => {
  vi.mocked(useShop).mockReturnValue({
    lastOfflineNotice: null,
    clearOfflineNotice: vi.fn(),
    isOnline: false,
    pendingSyncCount: 3,
    syncNow: vi.fn(),
    isSyncing: false,
  } as unknown as ReturnType<typeof useShop>);
  render(<OfflineNotice />);
  expect(screen.getByText('Offline · 3 waiting to sync')).toBeTruthy();
  expect(screen.getByRole('status').className).not.toContain('fixed');
  expect(screen.getByText(/Keep this browser’s data/)).toBeTruthy();
});
