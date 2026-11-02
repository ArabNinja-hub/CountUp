import { createHash } from 'node:crypto';
import { SUBSCRIPTION_PLAN_TERMS, SubscriptionPlanId } from '../../shared/subscriptionPlans';

export type ManualPaymentNetwork = 'mtn' | 'airtel';
export type ManualPaymentStatus = 'pending' | 'approved' | 'rejected';
export type PaymentReviewDecision = 'approve' | 'reject';

export interface ManualPaymentInput {
  planId: string;
  network: string;
  transactionReference: string;
  payerPhone: string;
  paymentDate: string;
}

export interface NormalizedManualPayment {
  planId: SubscriptionPlanId;
  network: ManualPaymentNetwork;
  transactionReference: string;
  referenceKey: string;
  payerPhone: string;
  paymentDate: string;
  amountNgwee: number;
}

export interface PaymentRecordForReview {
  id: string;
  planId: string;
  status: ManualPaymentStatus;
  shopId: string;
  ownerUid: string;
  amountNgwee: number;
}

export interface ShopSubscriptionForReview {
  planExpiryAtMs?: number;
  planExpiryDate?: string;
  planType?: string;
  planStatus?: string;
  isDeactivated?: boolean;
}

export function referenceLockId(network: ManualPaymentNetwork, reference: string): string {
  return createHash('sha256').update(`${network}:${reference}`).digest('hex');
}

export function assertReferenceAvailable(lockExists: boolean): void {
  if (lockExists) throw new Error('This transaction reference has already been submitted.');
}

export function assertPaymentPending(status: ManualPaymentStatus): void {
  if (status !== 'pending') throw new Error('This payment has already been reviewed.');
}

export function assertPlatformAdminClaim(token?: Record<string, unknown> | null): void {
  if (token?.platformAdmin !== true) throw new Error('Administrator access is required.');
}

export function assertShopOwner(shopOwnerUid: string, shopId: string, requesterUid: string): void {
  if (shopOwnerUid !== requesterUid && shopId !== requesterUid)
    throw new Error('You can only access your own shop.');
}

export function normalizeManualPayment(
  input: ManualPaymentInput,
  now = new Date()
): NormalizedManualPayment {
  if (!Object.hasOwn(SUBSCRIPTION_PLAN_TERMS, input.planId))
    throw new Error('Choose a valid subscription plan.');
  if (input.network !== 'mtn' && input.network !== 'airtel')
    throw new Error('Choose MTN Mobile Money or Airtel Money.');

  const transactionReference = input.transactionReference.trim().replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{4,49}$/.test(transactionReference))
    throw new Error('Enter a valid transaction reference (5–50 letters or numbers).');

  const digits = input.payerPhone.replace(/\D/g, '');
  const canonicalPhone = digits.startsWith('260')
    ? `+${digits}`
    : digits.startsWith('0')
      ? `+260${digits.slice(1)}`
      : '';
  if (!/^\+260\d{9}$/.test(canonicalPhone))
    throw new Error('Enter the Zambian phone number used to make the payment.');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate))
    throw new Error('Enter the date the payment was made.');
  const paymentDate = new Date(`${input.paymentDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(paymentDate.getTime()) ||
    paymentDate.toISOString().slice(0, 10) !== input.paymentDate
  )
    throw new Error('Enter a valid payment date.');
  if (paymentDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000)
    throw new Error('Payment date cannot be in the future.');

  const planId = input.planId as SubscriptionPlanId;
  return {
    planId,
    network: input.network,
    transactionReference,
    referenceKey: `${input.network}:${transactionReference}`,
    payerPhone: canonicalPhone,
    paymentDate: input.paymentDate,
    amountNgwee: SUBSCRIPTION_PLAN_TERMS[planId].priceNgwee,
  };
}

/** Add calendar months without JavaScript's end-of-month rollover surprises. */
export function addCalendarMonths(startMs: number, months: number): number {
  const start = new Date(startMs);
  if (!Number.isFinite(startMs) || !Number.isInteger(months) || months < 1)
    throw new Error('Invalid subscription dates.');
  const targetMonth = start.getUTCMonth() + months;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const day = Math.min(
    start.getUTCDate(),
    new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()
  );
  return Date.UTC(
    targetYear,
    month,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds()
  );
}

export function deriveApprovedSubscription(
  payment: PaymentRecordForReview,
  shop: ShopSubscriptionForReview,
  nowMs: number
) {
  assertPaymentPending(payment.status);
  if (!Object.hasOwn(SUBSCRIPTION_PLAN_TERMS, payment.planId))
    throw new Error('The submitted plan is invalid.');
  if (
    payment.amountNgwee !== SUBSCRIPTION_PLAN_TERMS[payment.planId as SubscriptionPlanId].priceNgwee
  )
    throw new Error('The payment amount does not match the selected plan.');
  if (!Number.isFinite(nowMs)) throw new Error('Invalid approval time.');
  const previousExpiry = Number.isFinite(shop.planExpiryAtMs)
    ? (shop.planExpiryAtMs as number)
    : shop.planExpiryDate
      ? Date.parse(shop.planExpiryDate)
      : 0;
  const subscriptionStartAtMs = Math.max(
    nowMs,
    Number.isFinite(previousExpiry) ? previousExpiry : 0
  );
  const plan = SUBSCRIPTION_PLAN_TERMS[payment.planId as SubscriptionPlanId];
  const subscriptionExpiryAtMs = addCalendarMonths(subscriptionStartAtMs, plan.months);
  return {
    subscriptionStartAtMs,
    subscriptionExpiryAtMs,
    subscriptionExpiryDate: new Date(subscriptionExpiryAtMs).toISOString(),
    status: shop.isDeactivated ? 'suspended' : 'active',
    statusBeforeSuspension: shop.isDeactivated ? 'active' : undefined,
    planType: payment.planId,
  } as const;
}

export function validateRejectionReason(reason: string): string {
  const clean = reason.trim();
  if (clean.length < 3 || clean.length > 500)
    throw new Error('Enter a rejection reason between 3 and 500 characters.');
  return clean;
}
