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
 * Currently configured for free / unlocked full access ("for now remove the paying thing")
 */
export function getSubscriptionInfo(createdAt: string, expiryDate?: string, currentStatus?: string) {
  return {
    daysRemaining: 365,
    graceDaysRemaining: 0,
    effectiveExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    status: 'active' as const,
    isWarningPeriod: false,
    canRecordSales: true, // Always allow recording sales with full access
  };
}
