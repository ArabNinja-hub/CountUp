// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { OfflineNotice } from './OfflineNotice';

const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));
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

it('shows poison-blocked queue status and lets the owner review, retry, or confirm-discard the unsyncable entry', async () => {
  const discardBlockedSyncAction = vi.fn().mockResolvedValue(undefined);
  const syncNow = vi.fn();
  vi.mocked(useShop).mockReturnValue({
    lastOfflineNotice: '2 entries could not sync yet.',
    clearOfflineNotice: vi.fn(),
    isOnline: true,
    pendingSyncCount: 2,
    syncNow,
    isSyncing: false,
    discardBlockedSyncAction,
    loadSyncReview: vi.fn(),
    resolveSyncReview: vi.fn(),
    blockedSync: {
      actionId: 'op_poison_head',
      kind: 'poison',
      actionType: 'stock_update',
      summary: 'Stock update for deleted item',
      reason: 'A stock item or customer needed by this entry no longer exists.',
      queuedAt: '2026-11-20T10:00:00.000Z',
    },
  } as unknown as ReturnType<typeof useShop>);

  render(<OfflineNotice />);
  expect(screen.getByText(/Sync paused · 1 entry needs review \(2 waiting\)/i)).toBeTruthy();
  expect(screen.getByText(/Rejected entry: Stock update for deleted item/i)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(await screen.findByText(/Sync paused to protect later entries/i)).toBeTruthy();
  expect(
    screen.getByText(/A stock item or customer needed by this entry no longer exists/i)
  ).toBeTruthy();

  const discardTrigger = screen.getByRole('button', { name: 'Discard blocked entry…' });
  expect((discardTrigger as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(
    screen.getByLabelText(/I checked my shop records and want to discard this unsyncable entry/i)
  );
  expect((discardTrigger as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(discardTrigger);
  expect(await screen.findByText('Discard unsyncable entry?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard entry and resume sync' }));

  await waitFor(() => expect(discardBlockedSyncAction).toHaveBeenCalledWith('op_poison_head'));
});
