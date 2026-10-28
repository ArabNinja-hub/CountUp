import { PlanConfig } from '../types';

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
    name: '1 Month',
    months: 1,
    priceKwacha: 99, // K 99 per month
    monthlyRateKwacha: 99,
    description: 'Billed monthly. Cancel anytime.',
  },
  quarterly: {
    id: 'quarterly',
    name: '3 Months',
    months: 3,
    priceKwacha: 269, // K 269 total (~K 89.60/month, save 10%)
    monthlyRateKwacha: 89.67,
    discountBadge: 'Save 10%',
    description: 'Pay for 3 months upfront and save.',
  },
  biannual: {
    id: 'biannual',
    name: '6 Months',
    months: 6,
    priceKwacha: 499, // K 499 total (~K 83.15/month, save 16%)
    monthlyRateKwacha: 83.17,
    discountBadge: 'Save 16% (Best Value)',
    description: 'Half-year peace of mind with our biggest discount.',
  },
};

/**
 * Helper to calculate subscription status and days remaining
 */
export function getSubscriptionInfo(createdAt: string, expiryDate?: string, currentStatus?: string) {
  const now = new Date();
  
  // Use explicit expiryDate or default to 30 days from creation
  const effectiveExpiry = expiryDate 
    ? new Date(expiryDate) 
    : new Date(new Date(createdAt).getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  const diffMs = effectiveExpiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const graceMs = effectiveExpiry.getTime() + (GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000) - now.getTime();
  const graceDaysRemaining = Math.ceil(graceMs / (1000 * 60 * 60 * 24));

  let status: 'trial' | 'active' | 'grace' | 'expired' = 'active';

  if (currentStatus === 'trial' || (!currentStatus && !expiryDate)) {
    if (diffDays > 0) {
      status = 'trial';
    } else if (graceDaysRemaining > 0) {
      status = 'grace';
    } else {
      status = 'expired';
    }
  } else {
    if (diffDays > 0) {
      status = 'active';
    } else if (graceDaysRemaining > 0) {
      status = 'grace';
    } else {
      status = 'expired';
    }
  }

  const isWarningPeriod = diffDays > 0 && diffDays <= EXPIRY_WARNING_DAYS;
  const canRecordSales = status === 'trial' || status === 'active' || status === 'grace';

  return {
    daysRemaining: diffDays,
    graceDaysRemaining,
    effectiveExpiry,
    status,
    isWarningPeriod,
    canRecordSales, // Existing data is always viewable and exportable, recording sales requires active/trial/grace
  };
}
