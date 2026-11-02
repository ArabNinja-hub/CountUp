// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlanScreen } from './PlanScreen';

const fake = vi.hoisted(() => ({
  notify: vi.fn(),
  submitSubscriptionPayment: vi.fn(),
}));

vi.mock('../context/ShopContext', () => ({
  useShop: () => ({
    shop: {
      id: 'shop-test',
      name: 'Test shop',
      ownerPhone: '0977123456',
      pendingPaymentId: undefined,
    },
    subscription: {
      status: 'trial',
      daysRemaining: 20,
      graceDaysRemaining: 23,
      canRecordSales: true,
      isWarningPeriod: false,
    },
    t: {
      planTitle: 'Your Subscription Plan',
      close: 'Close',
      daysRemaining: 'days remaining',
      trialBadge: '30-Day Free Trial',
      planExpired: 'Plan Expired',
      planExpiredNotice: 'Plan ended.',
      existingDataSafe: 'Your records remain viewable and exportable.',
      selectPlan: 'Select a plan',
    },
    submitSubscriptionPayment: fake.submitSubscriptionPayment,
    subscriptionPayments: [],
  }),
}));
vi.mock('../services/subscriptionPayments', () => ({
  getManualPaymentInstructions: vi.fn().mockResolvedValue({
    mtn: '+260 test mtn',
    airtel: '+260 test airtel',
    verification: 'manual',
  }),
}));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: fake.notify }) }));

beforeEach(() => {
  fake.notify.mockReset();
  fake.submitSubscriptionPayment.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('manual subscription payment screen', () => {
  it('shows server-provided operator numbers, warns that activation waits for review, and submits a reference without activating', async () => {
    render(<PlanScreen onClose={vi.fn()} />);
    expect(await screen.findByText('+260 test mtn')).toBeTruthy();
    expect(screen.getByText('+260 test airtel')).toBeTruthy();
    expect(screen.getByText(/No immediate activation/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Transaction reference'), {
      target: { value: 'TXN-12345' },
    });
    fireEvent.change(screen.getByLabelText('Payer phone number'), {
      target: { value: '0977 123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for manual review' }));

    await waitFor(() =>
      expect(fake.submitSubscriptionPayment).toHaveBeenCalledWith({
        planId: 'monthly',
        network: 'mtn',
        transactionReference: 'TXN-12345',
        payerPhone: '0977 123 456',
        paymentDate: expect.any(String),
      })
    );
    expect(screen.getByText('Free trial')).toBeTruthy();
    expect(screen.getByText(/No subscription was activated/)).toBeTruthy();
  });
});
