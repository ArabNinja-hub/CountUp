// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { SyncConflictReview } from '../services/syncReview';
import { SyncReviewDialog } from './SyncReviewDialog';
import { OfflineNotice } from './OfflineNotice';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));
const load = vi.fn();
const resolve = vi.fn();
const sync = vi.fn();
const close = vi.fn();
const payment: SyncConflictReview = {
  actionId: 'action-1',
  kind: 'payment',
  customerName: 'Mwamba',
  originalAmount: 8,
  serverBalance: 5,
  queuedAt: '2026-10-30T10:00:00.000Z',
  alreadyProcessed: false,
  canRetry: false,
};

beforeEach(() => {
  load.mockResolvedValue(payment);
  resolve.mockResolvedValue('resolved');
  sync.mockResolvedValue(undefined);
  vi.mocked(useShop).mockReturnValue({
    loadSyncReview: load,
    resolveSyncReview: resolve,
    syncNow: sync,
    blockedSync: { actionId: 'action-1', kind: 'payment' },
    lastOfflineNotice: 'A repayment conflicts with a newer customer balance.',
    isOnline: true,
    pendingSyncCount: 2,
    isSyncing: false,
    clearOfflineNotice: vi.fn(),
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('Sync conflict review', () => {
  it('opens from the persistent sync notice and can be closed without changing anything', async () => {
    render(<OfflineNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Mwamba', { exact: false })).toBeTruthy();
    expect(screen.getByText(/server balance is lower/i)).toBeTruthy();
    expect(screen.getByText(/does not yet record overpayments or refunds/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close sync review' }));
    expect(resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires an entered amount, an acknowledgement and a second confirmation', async () => {
    render(<SyncReviewDialog actionId="action-1" onClose={close} />);
    await screen.findByText(/server balance is lower/i);
    fireEvent.click(screen.getByRole('radio', { name: /entered with the wrong amount/i }));
    const reviewButton = screen.getByRole('button', { name: 'Review my choice' });
    expect((reviewButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked the records/i }));
    fireEvent.change(screen.getByLabelText('Correct amount actually received (K)'), {
      target: { value: '6' },
    });
    fireEvent.click(reviewButton);
    expect(screen.getByRole('alert').textContent).toMatch(/no more than the server balance/i);
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Correct amount actually received (K)'), {
      target: { value: '4' },
    });
    fireEvent.click(reviewButton);
    expect(screen.getByText(/difference will not be recorded/i)).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(payment, { kind: 'correct-payment', amount: 4 })
    );
    expect(close).toHaveBeenCalled();
  });

  it('clearly confirms that cancelling a duplicate records no payment', async () => {
    render(<SyncReviewDialog actionId="action-1" onClose={close} />);
    await screen.findByText(/server balance is lower/i);
    fireEvent.click(screen.getByRole('radio', { name: /never made or is a duplicate/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked the records/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review my choice' }));
    expect(
      screen.getAllByText(/No payment will be recorded for it/i, { exact: false })
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(payment, { kind: 'cancel-payment' }));
  });

  it('warns that keeping a sale does not restore stock or record a refund', async () => {
    const sale = { ...payment, kind: 'void' as const, originalAmount: 10, receipt: 'CU-001' };
    load.mockResolvedValue(sale);
    render(<SyncReviewDialog actionId="action-1" onClose={close} />);
    await screen.findByText(/CU-001/i);
    fireEvent.click(screen.getByRole('radio', { name: /keep the sale; cancel this queued undo/i }));
    expect(screen.getByText(/No refund is recorded/i, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked the records/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review my choice' }));
    expect(
      screen.getByText(/stock restoration and credit reduction will not be applied/i)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(sale, { kind: 'keep-sale' }));
  });

  it('displays a stale-balance error and permits a fresh server review', async () => {
    resolve.mockRejectedValueOnce(
      new Error('The server balance changed. Close this review and check it again.')
    );
    render(<SyncReviewDialog actionId="action-1" onClose={close} />);
    await screen.findByText(/server balance is lower/i);
    fireEvent.click(screen.getByRole('radio', { name: /never made or is a duplicate/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked the records/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review my choice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/balance changed/i);
    load.mockResolvedValueOnce({ ...payment, serverBalance: 4 });
    fireEvent.click(screen.getByRole('button', { name: /Refresh server balance/i }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText(/current server balance/i).parentElement?.textContent).toContain(
        '4.00'
      )
    );
  });

  it('retries the unchanged entry if the balance has recovered', async () => {
    load.mockResolvedValue({ ...payment, serverBalance: 10, canRetry: true });
    render(<SyncReviewDialog actionId="action-1" onClose={close} />);
    fireEvent.click(await screen.findByRole('button', { name: /Retry sync without changing/i }));
    expect(resolve).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });
});
