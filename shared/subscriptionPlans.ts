export const SUBSCRIPTION_PLAN_TERMS = {
  monthly: { name: '1 Month', months: 1, priceNgwee: 9900 },
  quarterly: { name: '3 Months', months: 3, priceNgwee: 26900 },
  biannual: { name: '6 Months', months: 6, priceNgwee: 49900 },
} as const;

export type SubscriptionPlanId = keyof typeof SUBSCRIPTION_PLAN_TERMS;
