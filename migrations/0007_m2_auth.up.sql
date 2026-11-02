-- 0007: M2 authentication (owner-approved ADR-01/02/03/13).
--
-- ADR-01  opaque database-managed sessions: session_version invalidation + rotation.
-- ADR-02  admin-assisted identity verification: explicit status + immutable audit.
-- ADR-03  password-only authentication: credentials hold ONLY Argon2id hashes.
--         The legacy plaintext POS PIN is NEVER copied into any column here.
-- ADR-13  owner-only pilot: no new staff/cashier grants are introduced.
--
-- No RLS is enabled (ADR-11 remains PROVISIONAL / NOT APPROVED).
-- No shop, inventory, sales, credit, expense or payment tables are added.

CREATE TYPE identity_verification_status AS ENUM
  ('unverified', 'pending_review', 'verified', 'rejected');

ALTER TABLE users
  ADD COLUMN session_version       INT      NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  ADD COLUMN identity_status       identity_verification_status NOT NULL DEFAULT 'unverified',
  ADD COLUMN identity_verified_at  TIMESTAMPTZ,
  ADD COLUMN identity_verified_by  UUID     REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE sessions
  ADD COLUMN session_version INT NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  ADD COLUMN rotated_at      TIMESTAMPTZ,
  ADD COLUMN last_ip         INET;

ALTER TABLE password_reset_tokens
  ADD COLUMN is_admin_initiated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN initiated_by       UUID    REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN requested_ip       INET,
  ADD CONSTRAINT password_reset_tokens_expiry CHECK (expires_at > created_at);

-- Immutable audit trail for admin-assisted verification decisions. A row is written
-- when a pilot owner requests verification and again when a platform admin decides.
CREATE TABLE identity_verifications (
  id           UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID                          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status       identity_verification_status  NOT NULL,
  decision     TEXT                          NOT NULL CHECK (decision IN ('requested', 'approved', 'rejected')),
  evidence     JSONB                         NOT NULL DEFAULT '{}'::jsonb,
  notes        TEXT,
  reviewed_by  UUID                          REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ                   NOT NULL DEFAULT now()
);

CREATE INDEX identity_verifications_user_idx
  ON identity_verifications (user_id, created_at DESC);

CREATE TRIGGER identity_verifications_deny_mutation
  BEFORE UPDATE OR DELETE ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
