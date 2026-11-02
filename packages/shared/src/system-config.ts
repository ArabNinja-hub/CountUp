/**
 * Canonical keys for the `system_config` table (migration 0001).
 *
 * Business settings live in PostgreSQL, NOT in process environment variables: they are
 * runtime data that platform staff may change. Environment variables are reserved for
 * connection strings, secrets and deployment identity (see apps/api/src/config/env.ts).
 *
 * `isProvisional: true` means the value is a PROPOSED DEFAULT ONLY and is blocked by an
 * unresolved ADR. It must not be treated as an approved business decision.
 */
export interface SystemConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly isProvisional: boolean;
  readonly description: string;
}

export const SYSTEM_CONFIG_DEFAULTS: readonly SystemConfigEntry[] = Object.freeze([
  {
    key: 'trial_duration_days',
    value: 30,
    isProvisional: false,
    description: 'Mirrors src/config/plans.ts TRIAL_DURATION_DAYS.',
  },
  {
    key: 'expiry_warning_days',
    value: 5,
    isProvisional: false,
    description: 'Mirrors src/config/plans.ts EXPIRY_WARNING_DAYS.',
  },
  {
    key: 'grace_period_days',
    value: 3,
    isProvisional: false,
    description: 'Mirrors src/config/plans.ts GRACE_PERIOD_DAYS.',
  },
  {
    key: 'currency',
    value: 'ZMW',
    isProvisional: false,
    description: 'Mirrors src/types/index.ts currency literal.',
  },
  {
    key: 'sale_max_lines',
    value: 160,
    isProvisional: false,
    description: 'Firestore 500-write transaction headroom; backend ceiling for one sale.',
  },
  {
    key: 'timezone',
    value: 'Africa/Lusaka',
    isProvisional: true,
    description: 'PROVISIONAL ADR-09 — NOT APPROVED. Never exposed as an approved decision.',
  },
  {
    key: 'money_unit',
    value: 'ngwee',
    isProvisional: true,
    description: 'PROVISIONAL ADR-10 — NOT APPROVED. All money columns use BIGINT ngwee.',
  },
  {
    key: 'tenant_isolation',
    value: 'application_scoping',
    isProvisional: true,
    description: 'PROVISIONAL ADR-11 — NOT APPROVED. RLS is optional and disabled.',
  },
  {
    key: 'retain_zamtel_operator',
    value: true,
    isProvisional: true,
    description: 'PROVISIONAL ADR-14 — NOT APPROVED. Historical enum value kept for legacy rows.',
  },
]);

export const PROVISIONAL_CONFIG_KEYS: readonly string[] = Object.freeze(
  SYSTEM_CONFIG_DEFAULTS.filter((entry) => entry.isProvisional).map((entry) => entry.key)
);
