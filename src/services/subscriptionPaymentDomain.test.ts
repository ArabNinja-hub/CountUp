import { describe, expect, it } from 'vitest';
import {
  assertPlatformAdminMfaCaller,
  handleGetPaymentInstructions,
  parseExtendSubscriptionPayload,
  parseReviewPaymentPayload,
  parseSetSuspendedPayload,
  parseSubmitPaymentPayload,
  resolveServerPaymentNumbersFromEnv,
} from '../../shared/subscriptionPaymentDomain';

describe('shared/subscriptionPaymentDomain', () => {
  it('resolves server-configured MTN and Airtel numbers and rejects missing or misconfigured env vars', () => {
    expect(
      resolveServerPaymentNumbersFromEnv({
        mtnNumber: ' 0960 111 222 ',
        airtelNumber: ' 0977 333 444 ',
      })
    ).toEqual({
      mtn: '0960 111 222',
      airtel: '0977 333 444',
    });

    expect(() =>
      resolveServerPaymentNumbersFromEnv({ mtnNumber: '', airtelNumber: '0977333444' })
    ).toThrow(/not configured/i);
    expect(() =>
      resolveServerPaymentNumbersFromEnv({
        mtnNumber: 'x'.repeat(50),
        airtelNumber: '0977333444',
      })
    ).toThrow(/misconfigured/i);
  });

  it('enforces shop ownership and PIN-verified session on get-payment-instructions', async () => {
    const baseInput = {
      userId: 'user-owner',
      sessionId: 'sess-1',
      shopId: 'shop-1',
      mtnNumber: '0960111222',
      airtelNumber: '0977333444',
    };

    await expect(
      handleGetPaymentInstructions(
        {
          findShopOwnerAndSession: async () => ({
            exists: true,
            ownerMatches: false,
            hasPinCredentials: true,
            sessionVerified: true,
          }),
        },
        baseInput
      )
    ).rejects.toThrow(/Only the shop owner/i);

    await expect(
      handleGetPaymentInstructions(
        {
          findShopOwnerAndSession: async () => ({
            exists: true,
            ownerMatches: true,
            hasPinCredentials: true,
            sessionVerified: false,
          }),
        },
        baseInput
      )
    ).rejects.toThrow(/Unlock your shop with your PIN/i);

    const ok = await handleGetPaymentInstructions(
      {
        findShopOwnerAndSession: async () => ({
          exists: true,
          ownerMatches: true,
          hasPinCredentials: true,
          sessionVerified: true,
        }),
      },
      baseInput
    );
    expect(ok).toMatchObject({
      mtn: '0960111222',
      airtel: '0977333444',
      verification: 'manual',
    });
    expect(ok.plans.monthly.priceNgwee).toBe(9900);
    expect(ok.plans.quarterly.priceNgwee).toBe(26900);
    expect(ok.plans.biannual.priceNgwee).toBe(49900);
  });

  it('requires both platform_admin authorization and verified TOTP MFA (aal2)', () => {
    expect(() =>
      assertPlatformAdminMfaCaller({
        hasAdminClaim: false,
        aal: 'aal2',
        isPlatformAdmin: false,
      })
    ).toThrow(/Platform administrator access is required/i);

    expect(() =>
      assertPlatformAdminMfaCaller({
        hasAdminClaim: true,
        aal: 'aal1',
        isPlatformAdmin: true,
      })
    ).toThrow(/aal2/i);

    expect(() =>
      assertPlatformAdminMfaCaller({
        hasAdminClaim: true,
        aal: 'aal2',
        isPlatformAdmin: true,
      })
    ).not.toThrow();
  });

  it('validates submit, review, extend, and suspend Edge Function payloads and rejects amount mismatches', () => {
    expect(
      parseSubmitPaymentPayload({
        shopId: 'shop-1',
        planId: 'quarterly',
        network: 'mtn',
        transactionReference: 'MTN998877',
        payerPhone: '0966123456',
        paymentDate: '2026-11-20',
        operationId: 'op-sub-1',
        expectedAmountNgwee: 26900,
      })
    ).toEqual({
      shopId: 'shop-1',
      planId: 'quarterly',
      network: 'mtn',
      transactionReference: 'MTN998877',
      payerPhone: '0966123456',
      paymentDate: '2026-11-20',
      operationId: 'op-sub-1',
      expectedAmountNgwee: 26900,
    });

    expect(() =>
      parseSubmitPaymentPayload({
        shopId: 'shop-1',
        planId: 'monthly',
        network: 'mtn',
        transactionReference: 'MTN998877',
        payerPhone: '0966123456',
        paymentDate: '2026-11-20',
        expectedAmountNgwee: 100,
      })
    ).toThrow(/amount does not match/i);

    expect(
      parseReviewPaymentPayload({
        paymentId: 'pay-1',
        decision: 'reject',
        reason: 'Not in operator statement',
        operationId: 'op-rev-1',
      })
    ).toEqual({
      paymentId: 'pay-1',
      decision: 'reject',
      reason: 'Not in operator statement',
      operationId: 'op-rev-1',
    });

    expect(
      parseExtendSubscriptionPayload({
        shopId: 'shop-1',
        days: 30,
        operationId: 'op-ext-1',
        reason: 'Goodwill extension',
      })
    ).toEqual({
      shopId: 'shop-1',
      days: 30,
      operationId: 'op-ext-1',
      reason: 'Goodwill extension',
    });

    expect(() => parseExtendSubscriptionPayload({ shopId: 'shop-1', days: 30 })).toThrow(
      /operationId/i
    );

    expect(
      parseSetSuspendedPayload({
        shopId: 'shop-1',
        suspended: true,
        operationId: 'op-susp-1',
      })
    ).toEqual({
      shopId: 'shop-1',
      suspended: true,
      operationId: 'op-susp-1',
      reason: null,
    });
  });
});
