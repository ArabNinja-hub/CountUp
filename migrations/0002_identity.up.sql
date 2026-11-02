-- 0002: account identity and server-side sessions (tables only; M2 implements auth).
-- The existing Firebase Anonymous/Email auth is NOT changed by this migration.

CREATE TABLE users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_phone     TEXT        UNIQUE,
  primary_email     TEXT        UNIQUE,
  display_name      TEXT,
  role              user_role   NOT NULL DEFAULT 'owner',
  status            user_status NOT NULL DEFAULT 'active',
  legacy_owner_uid  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_legacy_owner_uid_uq
  ON users (legacy_owner_uid) WHERE legacy_owner_uid IS NOT NULL;
CREATE INDEX users_status_idx ON users (status);

CREATE TABLE auth_identities (
  id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         identity_kind  NOT NULL,
  identifier   TEXT           NOT NULL,
  is_primary   BOOLEAN        NOT NULL DEFAULT false,
  verified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_identifier_uq UNIQUE (kind, identifier),
  CONSTRAINT auth_identities_identifier_not_blank CHECK (length(btrim(identifier)) > 0)
);

CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);
CREATE UNIQUE INDEX auth_identities_one_primary_uq
  ON auth_identities (user_id) WHERE is_primary;

CREATE TABLE credentials (
  user_id              UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash        TEXT        NOT NULL,
  password_algo        TEXT        NOT NULL,
  password_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_attempts      INT         NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until         TIMESTAMPTZ
);

CREATE TABLE sessions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_token_hash    TEXT        NOT NULL UNIQUE,
  refresh_token_hash    TEXT        NOT NULL UNIQUE,
  device_label          TEXT,
  ip                    INET,
  user_agent            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at   TIMESTAMPTZ NOT NULL,
  idle_expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoke_reason         TEXT,
  CONSTRAINT sessions_expiry_order CHECK (absolute_expires_at > created_at)
);

CREATE INDEX sessions_user_active_idx
  ON sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_absolute_expiry_idx ON sessions (absolute_expires_at);

CREATE TABLE otp_challenges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   UUID        NOT NULL REFERENCES auth_identities (id) ON DELETE CASCADE,
  purpose       TEXT        NOT NULL,
  code_hash     TEXT        NOT NULL,
  salt          TEXT        NOT NULL,
  attempts      INT         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  INT         NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT otp_attempts_within_limit CHECK (attempts <= max_attempts)
);

CREATE INDEX otp_challenges_lookup_idx
  ON otp_challenges (identity_id, purpose, expires_at);
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges (expires_at);

CREATE TABLE password_reset_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
