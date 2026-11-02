import { PlanConfig } from '../types';
import { SUBSCRIPTION_PLAN_TERMS } from '../../shared/subscriptionPlans';

/**
 * =====================================================================
 * SUBSCRIPTION & PRICING CONFIGURATION
 * =====================================================================
 * Edit prices and trial durations in one central place below.
 * All prices are in Zambian Kwacha (K).
 */

export const TRIAL_DURATION_DAYS = 30; // 30-day free trial for every new shop
export const EXPIRY_WARNING_DAYS = 5; // In-app reminder 5 days before plan ends
export const GRACE_PERIOD_DAYS = 3; // 3-day grace period after plan ends

export const SUBSCRIPTION_PLANS: Record<string, PlanConfig> = {
  monthly: {
    id: 'monthly',
    name: SUBSCRIPTION_PLAN_TERMS.monthly.name,
    months: SUBSCRIPTION_PLAN_TERMS.monthly.months,
    priceKwacha: SUBSCRIPTION_PLAN_TERMS.monthly.priceNgwee / 100,
    monthlyRateKwacha: SUBSCRIPTION_PLAN_TERMS.monthly.priceNgwee / 100,
    description: 'Billed monthly. Cancel anytime.',
  },
  quarterly: {
    id: 'quarterly',
    name: SUBSCRIPTION_PLAN_TERMS.quarterly.name,
    months: SUBSCRIPTION_PLAN_TERMS.quarterly.months,
    priceKwacha: SUBSCRIPTION_PLAN_TERMS.quarterly.priceNgwee / 100,
    monthlyRateKwacha: SUBSCRIPTION_PLAN_TERMS.quarterly.priceNgwee / 100 / 3,
    discountBadge: 'Save 10%',
    description: 'Pay for 3 months upfront and save.',
  },
  biannual: {
    id: 'biannual',
    name: SUBSCRIPTION_PLAN_TERMS.biannual.name,
    months: SUBSCRIPTION_PLAN_TERMS.biannual.months,
    priceKwacha: SUBSCRIPTION_PLAN_TERMS.biannual.priceNgwee / 100,
    monthlyRateKwacha: SUBSCRIPTION_PLAN_TERMS.biannual.priceNgwee / 100 / 6,
    discountBadge: 'Save 16% (Best Value)',
    description: 'Half-year peace of mind with our biggest discount.',
  },
};

/**
 * Helper to calculate subscription status and days remaining
 */
export type SubscriptionDisplayStatus =
  'trial' | 'pending_payment' | 'active' | 'grace' | 'expired' | 'rejected' | 'suspended';

export function getSubscriptionInfo(
  createdAt: string,
  expiryDate?: string,
  currentStatus?: string,
  isDeactivated = false,
  salesAccessUntilMs?: number,
  nowMs = Date.now(),
  planExpiryAtMs?: number
) {
  const now = nowMs;
  const effectiveExpiry = Number.isFinite(planExpiryAtMs)
    ? new Date(planExpiryAtMs as number)
    : expiryDate
      ? new Date(expiryDate)
      : new Date(new Date(createdAt).getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const expiryMs = effectiveExpiry.getTime();
  const diffMs = expiryMs - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const accessUntil = Number.isFinite(salesAccessUntilMs)
    ? (salesAccessUntilMs as number)
    : expiryMs + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const graceDaysRemaining = Math.max(0, Math.ceil((accessUntil - now) / (1000 * 60 * 60 * 24)));

  let status: SubscriptionDisplayStatus;
  if (isDeactivated || currentStatus === 'suspended') {
    status = 'suspended';
  } else if (now >= accessUntil) {
    status = 'expired';
  } else if (currentStatus === 'pending_payment' || currentStatus === 'rejected') {
    status = currentStatus;
  } else if (diffMs > 0) {
    status = currentStatus === 'trial' || (!currentStatus && !expiryDate) ? 'trial' : 'active';
  } else {
    status = 'grace';
  }

  const isWarningPeriod = diffDays > 0 && diffDays <= EXPIRY_WARNING_DAYS;
  const canRecordSales =
    status !== 'suspended' && now < accessUntil && (status !== 'expired' || now < accessUntil);

  return {
    daysRemaining: diffDays,
    graceDaysRemaining,
    effectiveExpiry,
    status,
    isWarningPeriod,
    canRecordSales,
  };
}
