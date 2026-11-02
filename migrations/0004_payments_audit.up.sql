-- 0004: subscription payments, reference locks, proof evidence and platform audit.
-- Manual MTN/Airtel review is data only here; no payment workflow is implemented in M0/M1.

CREATE TYPE payment_network AS ENUM ('mtn', 'airtel', 'zamtel');
CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'expired');

CREATE TABLE subscription_payments (
  id                   UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              UUID             NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  user_id              UUID             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  plan_id              TEXT             NOT NULL REFERENCES plans (plan_id) ON DELETE RESTRICT,
  amount_ngwee         BIGINT           NOT NULL CHECK (amount_ngwee > 0),
  currency             TEXT             NOT NULL DEFAULT 'ZMW',
  payment_type         payment_type     NOT NULL DEFAULT 'momo',
  momo_operator        momo_operator,
  momo_number          TEXT,
  reference            TEXT             NOT NULL,
  provider_reference   TEXT,
  status               payment_status   NOT NULL DEFAULT 'pending',
  submitted_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  reviewed_at          TIMESTAMPTZ,
  reviewed_by          UUID             REFERENCES users (id) ON DELETE SET NULL,
  rejection_reason     TEXT,
  evidence             JSONB            NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT subscription_payments_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT subscription_payments_reference_uq UNIQUE (shop_id, reference),
  CONSTRAINT subscription_payments_reference_not_blank CHECK (length(btrim(reference)) > 0),
  CONSTRAINT subscription_payments_review_consistency
    CHECK ((status = 'pending') OR (reviewed_at IS NOT NULL))
);

CREATE INDEX subscription_payments_shop_submitted_idx
  ON subscription_payments (shop_id, submitted_at DESC);
CREATE INDEX subscription_payments_status_idx
  ON subscription_payments (status, submitted_at);

-- A payment reference may be claimed only once, across all shops.
CREATE TABLE payment_reference_locks (
  reference    TEXT        PRIMARY KEY,
  shop_id      UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  payment_id   UUID        NOT NULL REFERENCES subscription_payments (id) ON DELETE CASCADE,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_reference_locks_shop_uq UNIQUE (shop_id, reference),
  CONSTRAINT payment_reference_locks_payment_uq UNIQUE (payment_id, reference)
);

CREATE INDEX payment_reference_locks_shop_idx ON payment_reference_locks (shop_id);

CREATE TABLE payment_proofs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  payment_id    UUID        NOT NULL,
  storage_key   TEXT        NOT NULL,
  mime_type     TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL CHECK (size_bytes > 0),
  sha256        TEXT        NOT NULL CHECK (length(sha256) = 64),
  uploaded_by   UUID        REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_proofs_payment_fk
    FOREIGN KEY (shop_id, payment_id) REFERENCES subscription_payments (shop_id, id),
  CONSTRAINT payment_proofs_storage_key_uq UNIQUE (storage_key)
);

CREATE INDEX payment_proofs_payment_idx ON payment_proofs (shop_id, payment_id);

-- Append-only platform audit. BIGSERIAL keeps insert order even under concurrency.
CREATE TABLE platform_audit (
  id              BIGSERIAL    PRIMARY KEY,
  actor_user_id   UUID         REFERENCES users (id) ON DELETE SET NULL,
  actor_role      TEXT,
  actor_ip        INET,
  action          TEXT         NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  shop_id         UUID         REFERENCES shops (id) ON DELETE SET NULL,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT platform_audit_action_not_blank CHECK (length(btrim(action)) > 0)
);

CREATE INDEX platform_audit_shop_created_idx ON platform_audit (shop_id, created_at DESC);
CREATE INDEX platform_audit_action_idx ON platform_audit (action, created_at DESC);
CREATE INDEX platform_audit_payload_gin_idx ON platform_audit USING gin (payload);

CREATE TRIGGER platform_audit_deny_mutation
  BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE provider_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             TEXT        NOT NULL,
  event_type           TEXT        NOT NULL,
  external_id          TEXT        NOT NULL,
  payload              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  signature_verified   BOOLEAN     NOT NULL DEFAULT false,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at         TIMESTAMPTZ,
  error                TEXT,
  CONSTRAINT provider_events_external_uq UNIQUE (provider, external_id)
);

CREATE INDEX provider_events_pending_idx
  ON provider_events (provider, received_at) WHERE processed_at IS NULL;
