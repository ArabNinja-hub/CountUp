// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LegalPages } from './LegalPages';
import { AdminScreen } from './AdminScreen';
import { ToastProvider } from './Toast';

const reviewSubscriptionPaymentMock = vi.fn().mockResolvedValue(undefined);
const adminResolvePlatformAlertMock = vi.fn().mockResolvedValue(undefined);
const adminRefreshPlatformAlertsMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../context/ShopContext', () => ({
  useShop: () => ({
    allShops: [
      {
        id: 'shop-1',
        name: 'Chilenje Market Kiosk',
        ownerPhone: '+260977111222',
        planStatus: 'pending_payment',
        planExpiryDate: '2026-12-20',
        planExpiryAtMs: Date.parse('2026-12-20T00:00:00.000Z'),
        salesAccessUntilMs: Date.parse('2026-12-23T00:00:00.000Z'),
        isDeactivated: false,
        createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
      },
    ],
    subscriptionPayments: [
      {
        id: 'pay-req-1',
        shopId: 'shop-1',
        shopNameSnapshot: 'Chilenje Market Kiosk',
        ownerUid: 'owner-1',
        planId: 'quarterly',
        amountNgwee: 26_900,
        network: 'mtn',
        transactionReference: 'MTN99887766',
        payerPhone: '+260966554433',
        paymentDate: '2026-11-20',
        submittedAt: Date.parse('2026-11-20T09:15:00.000Z'),
        status: 'pending',
      },
    ],
    platformAlerts: [
      {
        id: 'alert-sms-1',
        alert_key: 'sms_cap:new_reg_80',
        severity: 'warning',
        category: 'sms_cap',
        title: 'Daily new-registration SMS cap reached 80%',
        detail: '120 of 150 daily OTP messages used.',
        metadata: {},
        resolved_at: null,
        resolved_by_user_id: null,
        created_at: '2026-11-20T08:00:00.000Z',
        updated_at: '2026-11-20T09:00:00.000Z',
      },
      {
        id: 'alert-sync-1',
        alert_key: 'sync_fail:shop-1:op_9',
        severity: 'warning',
        category: 'sync_failure',
        title: 'Sync batch halted on unexpected server error',
        detail: 'Shop shop-1 entry op_9 failed.',
        metadata: { shop_id: 'shop-1' },
        resolved_at: null,
        resolved_by_user_id: null,
        created_at: '2026-11-20T08:30:00.000Z',
        updated_at: '2026-11-20T08:30:00.000Z',
      },
    ],
    reviewSubscriptionPayment: reviewSubscriptionPaymentMock,
    adminExtendShop: vi.fn().mockResolvedValue(undefined),
    adminToggleDeactivate: vi.fn().mockResolvedValue(undefined),
    adminReconcileLedgers: vi.fn().mockResolvedValue({
      checkedAt: '2026-11-20T10:00:00.000Z',
      shopsChecked: 1,
      totalDifferences: 0,
      saleLineMismatchCount: 0,
      saleProfitMismatchCount: 0,
      customerBalanceMismatchCount: 0,
      stockMovementMismatchCount: 0,
      saleLineMismatches: [],
      saleProfitMismatches: [],
      customerBalanceMismatches: [],
      stockMovementMismatches: [],
    }),
    adminReconcileSubscriptions: vi.fn().mockResolvedValue({
      checkedAt: '2026-11-20T10:00:00.000Z',
      shopsChecked: 1,
      totalDifferences: 0,
      expiryMismatchCount: 0,
      paymentAmountMismatchCount: 0,
      referenceLockMismatchCount: 0,
      shopPointerMismatchCount: 0,
      details: [],
    }),
    adminResetPinLockout: vi.fn().mockResolvedValue(undefined),
    adminInitiatePinReset: vi.fn().mockResolvedValue({
      resetId: 'rst-1',
      executeAfter: '2026-11-23T10:00:00.000Z',
      smsWarningSent: true,
    }),
    adminRefreshPlatformAlerts: adminRefreshPlatformAlertsMock,
    adminResolvePlatformAlert: adminResolvePlatformAlertMock,
    shop: null,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Pre-5 Check #2 & Phase 5: AdminScreen Payment Review, Monitoring & Legal Pages', () => {
  it('shows shop, plan, amount, payer phone, reference & payment date side by side and requires a rejection reason', async () => {
    render(
      <ToastProvider>
        <AdminScreen onBack={vi.fn()} />
      </ToastProvider>
    );

    // Monitoring panel displays summary counts and resolves alerts
    expect(screen.getByText('Platform monitoring & alerts')).toBeTruthy();
    expect(screen.getByText('Daily new-registration SMS cap reached 80%')).toBeTruthy();
    expect(screen.getByText('Sync batch halted on unexpected server error')).toBeTruthy();

    const resolveButtons = screen.getAllByRole('button', { name: /Mark resolved/i });
    fireEvent.click(resolveButtons[0]);
    await waitFor(() => {
      expect(adminResolvePlatformAlertMock).toHaveBeenCalledWith('alert-sms-1');
    });

    // Manual payment review displays all 6 required verification fields side by side
    const detailsGrid = screen.getByLabelText('Payment verification details');
    expect(detailsGrid.className).toContain('lg:grid-cols-6');
    expect(within(detailsGrid).getByText('Shop')).toBeTruthy();
    expect(within(detailsGrid).getByText('Chilenje Market Kiosk')).toBeTruthy();
    expect(within(detailsGrid).getByText('Plan')).toBeTruthy();
    expect(within(detailsGrid).getByText(/3 Months/i)).toBeTruthy();
    expect(within(detailsGrid).getByText('Amount')).toBeTruthy();
    expect(within(detailsGrid).getByText('K 269.00')).toBeTruthy();
    expect(within(detailsGrid).getByText('Payer phone')).toBeTruthy();
    expect(within(detailsGrid).getByText('+260966554433')).toBeTruthy();
    expect(within(detailsGrid).getByText('Reference')).toBeTruthy();
    expect(within(detailsGrid).getByText('MTN99887766')).toBeTruthy();
    expect(within(detailsGrid).getByText('Payment date')).toBeTruthy();
    expect(within(detailsGrid).getByText('2026-11-20')).toBeTruthy();

    // Approve button works
    fireEvent.click(screen.getByRole('button', { name: /Approve & activate/i }));
    await waitFor(() => {
      expect(reviewSubscriptionPaymentMock).toHaveBeenCalledWith({
        paymentId: 'pay-req-1',
        decision: 'approve',
        operationId: 'review:pay-req-1:approve',
      });
    });

    // Reject requires a non-empty reason (>= 3 chars)
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    const reasonInput = screen.getByLabelText(/Rejection reason \(required\)/i);
    expect(reasonInput.getAttribute('aria-required')).toBe('true');

    const confirmRejectBtn = screen.getByRole('button', { name: /Confirm reject/i });
    expect((confirmRejectBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(reasonInput, { target: { value: 'No' } });
    expect((confirmRejectBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(reasonInput, { target: { value: 'Reference not found on MTN statement' } });
    expect((confirmRejectBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmRejectBtn);

    await waitFor(() => {
      expect(reviewSubscriptionPaymentMock).toHaveBeenCalledWith({
        paymentId: 'pay-req-1',
        decision: 'reject',
        operationId: 'review:pay-req-1:reject',
        reason: 'Reference not found on MTN statement',
      });
    });
  });

  it('updates Privacy Policy, Terms & Security pages for Supabase, Cloudflare, Turnstile, SMS, retention & deletion with zero Firebase/ShopBook copy', () => {
    const onClose = vi.fn();
    render(<LegalPages onClose={onClose} />);

    // Privacy Policy tab
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Supabase');
    expect(dialog.textContent).toContain('Cloudflare');
    expect(dialog.textContent).toContain('Turnstile');
    expect(dialog.textContent).toContain('PBKDF2-HMAC-SHA256');
    expect(dialog.textContent).toContain('Delete Shop');
    expect(dialog.textContent).not.toMatch(/Firebase|Firestore|ShopBook/i);

    // Terms of Service tab
    fireEvent.click(screen.getByRole('tab', { name: 'Terms of Service' }));
    expect(dialog.textContent).toContain('K99');
    expect(dialog.textContent).toContain('K269');
    expect(dialog.textContent).toContain('K499');
    expect(dialog.textContent).toContain('3-Day Grace Period');
    expect(dialog.textContent).not.toMatch(/Firebase|Firestore|ShopBook/i);

    // Security & Data Protection tab
    fireEvent.click(screen.getByRole('tab', { name: 'Security & Data Protection' }));
    expect(dialog.textContent).toContain('Row-Level Security');
    expect(dialog.textContent).toContain('Content-Security-Policy');
    expect(dialog.textContent).toContain('aal2');
    expect(dialog.textContent).not.toMatch(/Firebase|Firestore|ShopBook/i);
  });
});
