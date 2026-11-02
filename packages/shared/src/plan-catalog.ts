/**
 * Server-safe mirror of `shared/subscriptionPlans.ts`.
 *
 * The existing frontend file is imported by the Vite app and cannot be rewritten in M0/M1.
 * This module deliberately duplicates its values (not its import) so the backend and the
 * migration tests have a dependency-free source of truth. If the frontend catalogue ever
 * changes, `apps/api/test/plans.test.ts` fails and forces the two to be reconciled.
 */
export const PLAN_CATALOG = {
  monthly: { name: '1 Month', months: 1, priceNgwee: 9900 },
  quarterly: { name: '3 Months', months: 3, priceNgwee: 26900 },
  biannual: { name: '6 Months', months: 6, priceNgwee: 49900 },
} as const;

export type PlanId = keyof typeof PLAN_CATALOG;

export const PLAN_IDS: readonly PlanId[] = Object.freeze(Object.keys(PLAN_CATALOG) as PlanId[]);
