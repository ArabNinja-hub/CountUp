-- 0008: M2 security remediation (C-01, C-02, C-03, C-05, C-06, C-09, C-10).
--
-- This migration adds ONLY security infrastructure. No shop, inventory, sales,
-- credit, expense, payment, subscription, entitlement or M3 business table is
-- introduced. No RLS is enabled (ADR-11 remains PROVISIONAL / NOT APPROVED).
-- No admin credential, password, pepper, CSRF key or recovery share is seeded:
-- the one-time bootstrap is an explicit, audited CLI operation (see
-- docs/M2_SECURITY_REMEDIATION.md §"Administrator bootstrap and recovery").

-- ---------------------------------------------------------------------------
-- C-01: token families + an append-mostly ledger of issued refresh token hashes.
-- A presented hash that was already consumed is proof of reuse; the whole token
-- family is then revoked and the user's session_version is bumped.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN token_family_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX sessions_token_family_idx ON sessions (token_family_id);

CREATE TABLE refresh_token_history (
  token_hash         TEXT        PRIMARY KEY,
  session_id         UUID        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_family_id    UUID        NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at        TIMESTAMPTZ,
  reuse_detected_at  TIMESTAMPTZ,
  CONSTRAINT refresh_token_history_hash_len CHECK (length(token_hash) = 64)
);

CREATE INDEX refresh_token_history_session_idx ON refresh_token_history (session_id);
CREATE INDEX refresh_token_history_family_idx ON refresh_token_history (token_family_id);

-- Backfill any pre-existing session so reuse detection cannot be bypassed by a
-- token issued before this migration. A volatile default gave every existing
-- session row its own family id.
INSERT INTO refresh_token_history (token_hash, session_id, user_id, token_family_id)
SELECT refresh_token_hash, id, user_id, token_family_id FROM sessions
ON CONFLICT (token_hash) DO NOTHING;

-- ---------------------------------------------------------------------------
-- C-03: shared, atomic fixed-window rate limiter state. Every API instance uses
-- the same table; `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is a single
-- atomic statement, so two instances cannot each grant their own allowance.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_limit_buckets (
  bucket_key         TEXT        PRIMARY KEY,
  window_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count          INT         NOT NULL DEFAULT 1,
  CONSTRAINT rate_limit_buckets_key_not_blank CHECK (length(bucket_key) > 0),
  CONSTRAINT rate_limit_buckets_hit_count_positive CHECK (hit_count > 0)
);

CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets (window_started_at);

-- ---------------------------------------------------------------------------
-- C-02: one-time, auditable administrator bootstrap and dual-control break-glass.
-- `platform_bootstrap.singleton` can only ever hold one row; the UNIQUE index on
-- admin_recovery_grants permits exactly one unused grant at any time.
-- Only SHA-256 digests of the two operator shares are stored.
-- ---------------------------------------------------------------------------

CREATE TABLE platform_bootstrap (
  singleton              BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton),
  primary_admin_user_id  UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  admin_count            INT         NOT NULL CHECK (admin_count >= 2),
  bootstrapped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  bootstrap_ip           INET
);

CREATE TRIGGER platform_bootstrap_deny_mutation
  BEFORE UPDATE OR DELETE ON platform_bootstrap
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE admin_recovery_grants (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_a_hash            TEXT        NOT NULL,
  share_b_hash            TEXT        NOT NULL,
  primary_admin_user_id   UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  used_at                 TIMESTAMPTZ,
  used_ip                 INET,
  CONSTRAINT admin_recovery_grants_hash_len
    CHECK (length(share_a_hash) = 64 AND length(share_b_hash) = 64),
  CONSTRAINT admin_recovery_grants_shares_distinct CHECK (share_a_hash <> share_b_hash),
  CONSTRAINT admin_recovery_grants_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX admin_recovery_grants_one_active_uq
  ON admin_recovery_grants ((used_at IS NULL)) WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- C-06: `users.identity_status` is the ONE authoritative verification state.
-- Verified timestamps / verifier references must agree with it, and
-- auth_identities.verified_at may never be set for a non-verified identity.
-- ---------------------------------------------------------------------------

UPDATE users
   SET identity_verified_at = COALESCE(identity_verified_at, now())
 WHERE identity_status = 'verified';

UPDATE users
   SET identity_verified_at = NULL, identity_verified_by = NULL
 WHERE identity_status <> 'verified'
   AND (identity_verified_at IS NOT NULL OR identity_verified_by IS NOT NULL);

UPDATE auth_identities
   SET verified_at = NULL
 WHERE verified_at IS NOT NULL
   AND user_id IN (SELECT id FROM users WHERE identity_status <> 'verified');

ALTER TABLE users
  ADD CONSTRAINT users_verification_state_consistent CHECK (
    (identity_status = 'verified' AND identity_verified_at IS NOT NULL)
    OR
    (identity_status <> 'verified' AND identity_verified_at IS NULL
                                   AND identity_verified_by IS NULL)
  );

CREATE FUNCTION assert_verified_identity_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verified_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.identity_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'auth_identities.verified_at requires users.identity_status = verified'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER auth_identities_verified_at_guard
  BEFORE INSERT OR UPDATE OF verified_at ON auth_identities
  FOR EACH ROW EXECUTE FUNCTION assert_verified_identity_marker();
