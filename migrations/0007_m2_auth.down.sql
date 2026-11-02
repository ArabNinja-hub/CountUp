-- Rollback 0007: M2 authentication schema only. No business data is touched.

DROP TABLE IF EXISTS identity_verifications;

ALTER TABLE password_reset_tokens
  DROP CONSTRAINT IF EXISTS password_reset_tokens_expiry,
  DROP COLUMN IF EXISTS requested_ip,
  DROP COLUMN IF EXISTS initiated_by,
  DROP COLUMN IF EXISTS is_admin_initiated;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS last_ip,
  DROP COLUMN IF EXISTS rotated_at,
  DROP COLUMN IF EXISTS session_version;

ALTER TABLE users
  DROP COLUMN IF EXISTS identity_verified_by,
  DROP COLUMN IF EXISTS identity_verified_at,
  DROP COLUMN IF EXISTS identity_status,
  DROP COLUMN IF EXISTS session_version;

DROP TYPE IF EXISTS identity_verification_status;
