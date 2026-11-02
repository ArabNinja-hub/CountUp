-- Rollback 0008: M2 security remediation schema only. No business data touched.

DROP TRIGGER IF EXISTS auth_identities_verified_at_guard ON auth_identities;
DROP FUNCTION IF EXISTS assert_verified_identity_marker();

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_verification_state_consistent;

DROP TRIGGER IF EXISTS platform_bootstrap_deny_mutation ON platform_bootstrap;
DROP INDEX IF EXISTS admin_recovery_grants_one_active_uq;
DROP TABLE IF EXISTS admin_recovery_grants;
DROP TABLE IF EXISTS platform_bootstrap;

DROP TABLE IF EXISTS rate_limit_buckets;

DROP TABLE IF EXISTS refresh_token_history;
DROP INDEX IF EXISTS sessions_token_family_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS token_family_id;
