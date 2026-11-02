import { describe, expect, it } from 'vitest';
import { getSubscriptionInfo } from '../config/plans';
import {
  addCalendarMonths,
  assertPaymentPending,
  assertPlatformAdminClaim,
  assertReferenceAvailable,
  assertShopOwner,
  deriveApprovedSubscription,
  normalizeManualPayment,
  referenceLockId,
  validateRejectionReason,
} from '../../functions/src/domain';

const input = {
  planId: 'monthly',
  network: 'mtn',
  transactionReference: ' ab 12345 ',
  payerPhone: '0977 123 456',
  paymentDate: '2026-10-31',
};

const ts = (date: string) => Date.parse(date);

describe('manual subscription-payment domain', () => {
  it('normalizes the operator reference and payer phone and derives price from shared plan terms', () => {
    expect(normalizeManualPayment(input, new Date('2026-11-01T00:00:00Z'))).toEqual({
      planId: 'monthly',
      network: 'mtn',
      transactionReference: 'AB12345',
      referenceKey: 'mtn:AB12345',
      payerPhone: '+260977123456',
      paymentDate: '2026-10-31',
      amountNgwee: 9900,
    });
  });

  it('enforces exact supported plan IDs, network, reference, Zambian phone and valid non-future dates', () => {
    for (const invalid of [
      { ...input, planId: 'toString' },
      { ...input, planId: 'weekly' },
      { ...input, network: 'zamtel' },
      { ...input, transactionReference: '1234' },
      { ...input, transactionReference: 'ABC!12345' },
      { ...input, payerPhone: '0977 123' },
      { ...input, paymentDate: '2026-02-30' },
      { ...input, paymentDate: '2026-11-03' },
    ]) {
      expect(() => normalizeManualPayment(invalid, new Date('2026-11-01T00:00:00Z'))).toThrow();
    }
  });

  it('uses an operator-scoped deterministic lock key and blocks reference reuse', () => {
    const normalized = normalizeManualPayment(input, new Date('2026-11-01T00:00:00Z'));
    expect(referenceLockId(normalized.network, normalized.transactionReference)).toBe(
      referenceLockId('mtn', 'AB12345')
    );
    expect(referenceLockId('mtn', 'AB12345')).not.toBe(referenceLockId('airtel', 'AB12345'));
    expect(() => assertReferenceAvailable(true)).toThrow(/already been submitted/);
    expect(() => assertReferenceAvailable(false)).not.toThrow();
  });

  it('requires a server-issued platform admin claim and restricts shop payment access to its owner', () => {
    expect(() => assertPlatformAdminClaim({ platformAdmin: true })).not.toThrow();
    expect(() =>
      assertPlatformAdminClaim({ email: 'platform-admin@example.test', email_verified: true })
    ).toThrow();
    expect(() => assertPlatformAdminClaim({ platformAdmin: false })).toThrow();
    expect(() => assertShopOwner('owner-1', 'shop-1', 'owner-1')).not.toThrow();
    expect(() => assertShopOwner('', 'owner-1', 'owner-1')).not.toThrow();
    expect(() => assertShopOwner('owner-1', 'shop-1', 'other-user')).toThrow();
  });

  it('only allows one review decision for a still-pending payment', () => {
    expect(() => assertPaymentPending('pending')).not.toThrow();
    expect(() => assertPaymentPending('approved')).toThrow(/already been reviewed/);
    expect(() => assertPaymentPending('rejected')).toThrow(/already been reviewed/);
  });

  it('uses calendar months and clamps end-of-month dates without rollover', () => {
    expect(new Date(addCalendarMonths(ts('2026-01-31T12:30:00Z'), 1)).toISOString()).toBe(
      '2026-02-28T12:30:00.000Z'
    );
    expect(new Date(addCalendarMonths(ts('2024-01-31T12:30:00Z'), 1)).toISOString()).toBe(
      '2024-02-29T12:30:00.000Z'
    );
    expect(new Date(addCalendarMonths(ts('2026-11-01T00:00:00Z'), 3)).toISOString()).toBe(
      '2027-02-01T00:00:00.000Z'
    );
  });

  it('approves pending payments with a recorded start/expiry and extends from an existing future expiry', () => {
    const payment = {
      id: 'p1',
      planId: 'quarterly',
      status: 'pending' as const,
      shopId: 's1',
      ownerUid: 'u1',
      amountNgwee: 26900,
    };
    const now = ts('2026-11-01T10:00:00.000Z');
    const approved = deriveApprovedSubscription(payment, {}, now);
    expect(approved.subscriptionStartAtMs).toBe(now);
    expect(approved.subscriptionExpiryDate).toBe('2027-02-01T10:00:00.000Z');
    expect(approved.status).toBe('active');

    const extended = deriveApprovedSubscription(
      payment,
      { planExpiryAtMs: ts('2027-01-31T10:00:00.000Z') },
      now
    );
    expect(extended.subscriptionStartAtMs).toBe(ts('2027-01-31T10:00:00.000Z'));
    expect(extended.subscriptionExpiryDate).toBe('2027-04-30T10:00:00.000Z');
    expect(() => deriveApprovedSubscription({ ...payment, status: 'approved' }, {}, now)).toThrow();
    expect(() => deriveApprovedSubscription({ ...payment, amountNgwee: 100 }, {}, now)).toThrow(
      /amount does not match/
    );
  });

  it('does not remove suspension when an admin approves a payment', () => {
    const result = deriveApprovedSubscription(
      {
        id: 'p2',
        planId: 'monthly',
        status: 'pending',
        shopId: 's2',
        ownerUid: 'u2',
        amountNgwee: 9900,
      },
      { isDeactivated: true },
      ts('2026-11-01T00:00:00.000Z')
    );
    expect(result.status).toBe('suspended');
    expect(result.statusBeforeSuspension).toBe('active');
  });

  it('requires an auditable rejection reason', () => {
    expect(validateRejectionReason('  Receipt not found  ')).toBe('Receipt not found');
    expect(() => validateRejectionReason('no')).toThrow();
    expect(() => validateRejectionReason('x'.repeat(501))).toThrow();
  });
});

describe('subscription entitlement expiry', () => {
  const expiry = ts('2026-11-01T00:00:00.000Z');
  const graceEnds = expiry + 3 * 24 * 60 * 60 * 1000;

  it('allows active access before expiry and grace-only access within the grace period', () => {
    const active = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry).toISOString(),
      'active',
      false,
      graceEnds,
      expiry - 1
    );
    expect(active.status).toBe('active');
    expect(active.canRecordSales).toBe(true);
    const grace = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry).toISOString(),
      'active',
      false,
      graceEnds,
      expiry + 1
    );
    expect(grace.status).toBe('grace');
    expect(grace.canRecordSales).toBe(true);
  });

  it('locks expired, suspended and post-trial shops while retaining pending/rejected statuses during valid access', () => {
    const afterGrace = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry).toISOString(),
      'active',
      false,
      graceEnds,
      graceEnds
    );
    expect(afterGrace.status).toBe('expired');
    expect(afterGrace.canRecordSales).toBe(false);
    const canonicalExpiry = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      '2099-11-01T00:00:00.000Z',
      'active',
      false,
      graceEnds,
      graceEnds,
      expiry
    );
    expect(canonicalExpiry.status).toBe('expired');
    expect(canonicalExpiry.effectiveExpiry.getTime()).toBe(expiry);
    const suspended = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry + 86400000).toISOString(),
      'active',
      true,
      graceEnds,
      expiry + 1
    );
    expect(suspended.status).toBe('suspended');
    expect(suspended.canRecordSales).toBe(false);
    const pending = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry).toISOString(),
      'pending_payment',
      false,
      graceEnds,
      expiry - 1
    );
    expect(pending.status).toBe('pending_payment');
    expect(pending.canRecordSales).toBe(true);
    const rejected = getSubscriptionInfo(
      '2026-10-01T00:00:00.000Z',
      new Date(expiry).toISOString(),
      'rejected',
      false,
      graceEnds,
      expiry - 1
    );
    expect(rejected.status).toBe('rejected');
  });
});
