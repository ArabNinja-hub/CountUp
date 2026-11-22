import { EdgeDomainError } from './edgeAuthDomain.ts';
import {
  SUBSCRIPTION_PLAN_TERMS,
  type ManualPaymentNetwork,
  type PlanBillingCycle,
} from './subscriptionPlans.ts';

export interface ManualPaymentInstructionsResponse extends Record<string, unknown> {
  mtn: string;
  airtel: string;
  verification: 'manual';
  plans: typeof SUBSCRIPTION_PLAN_TERMS;
}

export interface PaymentInstructionsShopLookup {
  findShopOwnerAndSession(input: { shopId: string; userId: string; sessionId: string }): Promise<{
    exists: boolean;
    ownerMatches: boolean;
    hasPinCredentials: boolean;
    sessionVerified: boolean;
  }>;
}

export function resolveServerPaymentNumbersFromEnv(env: {
  mtnNumber?: string | null;
  airtelNumber?: string | null;
}): { mtn: string; airtel: string } {
  const mtn = (env.mtnNumber ?? '').trim();
  const airtel = (env.airtelNumber ?? '').trim();
  if (!mtn || !airtel) {
    throw new EdgeDomainError(
      503,
      'payment_instructions_unconfigured',
      'Manual mobile money receiving numbers are not configured on the server.'
    );
  }
  if (mtn.length > 40 || airtel.length > 40) {
    throw new EdgeDomainError(
      500,
      'payment_instructions_invalid',
      'Server payment receiving numbers are misconfigured.'
    );
  }
  return { mtn, airtel };
}

export async function handleGetPaymentInstructions(
  repo: PaymentInstructionsShopLookup,
  input: {
    userId: string;
    sessionId: string;
    shopId: string;
    mtnNumber?: string | null;
    airtelNumber?: string | null;
  }
): Promise<ManualPaymentInstructionsResponse> {
  const cleanShopId = input.shopId.trim();
  if (!cleanShopId) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Sign in to your shop first.');
  }

  const numbers = resolveServerPaymentNumbersFromEnv({
    mtnNumber: input.mtnNumber,
    airtelNumber: input.airtelNumber,
  });

  const access = await repo.findShopOwnerAndSession({
    shopId: cleanShopId,
    userId: input.userId,
    sessionId: input.sessionId,
  });

  if (!access.exists || !access.ownerMatches) {
    throw new EdgeDomainError(
      403,
      'forbidden_shop',
      'Only the shop owner can view payment instructions.'
    );
  }

  if (access.hasPinCredentials && !access.sessionVerified) {
    throw new EdgeDomainError(
      403,
      'pin_verification_required',
      'Unlock your shop with your PIN first.'
    );
  }

  return {
    mtn: numbers.mtn,
    airtel: numbers.airtel,
    verification: 'manual',
    plans: SUBSCRIPTION_PLAN_TERMS,
  };
}

export function assertPlatformAdminMfaCaller(caller: {
  hasAdminClaim: boolean;
  aal: 'aal1' | 'aal2';
  isPlatformAdmin: boolean;
}): void {
  if (!caller.hasAdminClaim) {
    throw new EdgeDomainError(403, 'forbidden_admin', 'Platform administrator access is required.');
  }
  if (caller.aal !== 'aal2' || !caller.isPlatformAdmin) {
    throw new EdgeDomainError(
      403,
      'admin_mfa_required',
      'Platform administrator TOTP MFA (aal2) verification is required.'
    );
  }
}

export function parseSubmitPaymentPayload(body: Record<string, unknown>): {
  shopId: string;
  planId: PlanBillingCycle;
  network: ManualPaymentNetwork;
  transactionReference: string;
  payerPhone: string;
  paymentDate: string;
  operationId: string | null;
  expectedAmountNgwee: number | null;
} {
  const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
  const planIdRaw = typeof body.planId === 'string' ? body.planId.trim().toLowerCase() : '';
  const networkRaw = typeof body.network === 'string' ? body.network.trim().toLowerCase() : '';
  const transactionReference =
    typeof body.transactionReference === 'string' ? body.transactionReference.trim() : '';
  const payerPhone = typeof body.payerPhone === 'string' ? body.payerPhone.trim() : '';
  const paymentDate = typeof body.paymentDate === 'string' ? body.paymentDate.trim() : '';
  const operationId =
    typeof body.operationId === 'string' && body.operationId.trim()
      ? body.operationId.trim()
      : null;

  let expectedAmountNgwee: number | null = null;
  if (body.expectedAmountNgwee !== undefined && body.expectedAmountNgwee !== null) {
    if (
      typeof body.expectedAmountNgwee !== 'number' ||
      !Number.isSafeInteger(body.expectedAmountNgwee)
    ) {
      throw new EdgeDomainError(
        400,
        'invalid_amount',
        'Expected plan amount must be an integer ngwee value.'
      );
    }
    expectedAmountNgwee = body.expectedAmountNgwee;
  }

  if (!shopId) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Sign in to your shop first.');
  }
  if (!(planIdRaw in SUBSCRIPTION_PLAN_TERMS)) {
    throw new EdgeDomainError(400, 'invalid_plan', 'Choose a valid subscription plan.');
  }
  if (networkRaw !== 'mtn' && networkRaw !== 'airtel') {
    throw new EdgeDomainError(400, 'invalid_network', 'Choose MTN Mobile Money or Airtel Money.');
  }

  const typedPlanId = planIdRaw as PlanBillingCycle;
  const plan = SUBSCRIPTION_PLAN_TERMS[typedPlanId];
  if (expectedAmountNgwee !== null && expectedAmountNgwee !== plan.priceNgwee) {
    throw new EdgeDomainError(
      400,
      'amount_mismatch',
      'Payment amount does not match the server plan price.'
    );
  }

  return {
    shopId,
    planId: typedPlanId,
    network: networkRaw,
    transactionReference,
    payerPhone,
    paymentDate,
    operationId,
    expectedAmountNgwee,
  };
}

export function parseReviewPaymentPayload(body: Record<string, unknown>): {
  paymentId: string;
  decision: 'approve' | 'reject';
  reason: string | null;
  operationId: string | null;
} {
  const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';
  const decisionRaw = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
  const operationId =
    typeof body.operationId === 'string' && body.operationId.trim()
      ? body.operationId.trim()
      : null;

  if (!paymentId) {
    throw new EdgeDomainError(400, 'invalid_payment_id', 'Choose a payment submission to review.');
  }
  if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
    throw new EdgeDomainError(
      400,
      'invalid_review_decision',
      'Choose an approval or rejection action.'
    );
  }
  if (decisionRaw === 'reject' && (!reason || reason.length < 3 || reason.length > 500)) {
    throw new EdgeDomainError(
      400,
      'invalid_rejection_reason',
      'Enter a rejection reason between 3 and 500 characters.'
    );
  }

  return {
    paymentId,
    decision: decisionRaw,
    reason,
    operationId,
  };
}

export function parseExtendSubscriptionPayload(body: Record<string, unknown>): {
  shopId: string;
  days: number;
  operationId: string;
  reason: string | null;
} {
  const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
  const days = typeof body.days === 'number' ? body.days : Number(body.days);
  const operationId =
    typeof body.operationId === 'string' && body.operationId.trim() ? body.operationId.trim() : '';
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

  if (!shopId) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Choose a shop to extend.');
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new EdgeDomainError(
      400,
      'invalid_extension_days',
      'Choose a whole number of days from 1 to 3,650.'
    );
  }
  if (!operationId || operationId.length > 160 || operationId.includes('/')) {
    throw new EdgeDomainError(
      400,
      'invalid_operation_id',
      'A valid operationId is required for idempotent subscription extension.'
    );
  }

  return { shopId, days, operationId, reason };
}

export function parseSetSuspendedPayload(body: Record<string, unknown>): {
  shopId: string;
  suspended: boolean;
  operationId: string | null;
  reason: string | null;
} {
  const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
  if (!shopId) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Choose a shop.');
  }
  if (typeof body.suspended !== 'boolean') {
    throw new EdgeDomainError(
      400,
      'invalid_suspension_action',
      'Specify whether the shop should be suspended.'
    );
  }
  const operationId =
    typeof body.operationId === 'string' && body.operationId.trim()
      ? body.operationId.trim()
      : null;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

  return {
    shopId,
    suspended: body.suspended,
    operationId,
    reason,
  };
}
