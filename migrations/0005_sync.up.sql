-- 0005: idempotency, offline sync operations, conflict reviews and change feed.
-- Tables only. The IndexedDB outbox and sync endpoints belong to later milestones.

CREATE TYPE sync_decision AS ENUM ('keep_server', 'keep_client', 'merge', 'reject');
CREATE TYPE idempotency_status AS ENUM ('in_progress', 'completed', 'failed');

CREATE TABLE idempotency_keys (
  key           TEXT                PRIMARY KEY,
  shop_id       UUID                REFERENCES shops (id) ON DELETE CASCADE,
  user_id       UUID                REFERENCES users (id) ON DELETE SET NULL,
  request_hash  TEXT                NOT NULL,
  status        idempotency_status  NOT NULL DEFAULT 'in_progress',
  response      JSONB,
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ         NOT NULL,
  CONSTRAINT idempotency_keys_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_shop_created_idx
  ON idempotency_keys (shop_id, created_at);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE sync_operations (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  device_id              TEXT        NOT NULL,
  client_operation_id    TEXT        NOT NULL,
  operation_type         TEXT        NOT NULL,
  payload                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  local_created_at       TIMESTAMPTZ,
  received_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at           TIMESTAMPTZ,
  status                 TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'applied', 'duplicate', 'conflict', 'failed')),
  result                 JSONB,
  error                  TEXT,
  CONSTRAINT sync_operations_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT sync_operations_client_uq
    UNIQUE (shop_id, device_id, client_operation_id)
);

CREATE INDEX sync_operations_shop_status_idx
  ON sync_operations (shop_id, status, received_at);
CREATE INDEX sync_operations_payload_gin_idx
  ON sync_operations USING gin (payload);

CREATE TABLE sync_conflict_reviews (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID            NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  sync_operation_id   UUID            NOT NULL,
  decision            sync_decision   NOT NULL,
  resolved_by         UUID            REFERENCES users (id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  note                TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT sync_conflict_reviews_operation_fk
    FOREIGN KEY (shop_id, sync_operation_id) REFERENCES sync_operations (shop_id, id),
  CONSTRAINT sync_conflict_reviews_operation_uq UNIQUE (sync_operation_id)
);

CREATE INDEX sync_conflict_reviews_shop_idx
  ON sync_conflict_reviews (shop_id, created_at DESC);

CREATE TABLE change_log (
  id            BIGSERIAL    PRIMARY KEY,
  shop_id       UUID         REFERENCES shops (id) ON DELETE CASCADE,
  entity_type   TEXT         NOT NULL,
  entity_id     TEXT         NOT NULL,
  operation     TEXT         NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  version       BIGINT       NOT NULL DEFAULT 1 CHECK (version > 0),
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX change_log_shop_id_idx ON change_log (shop_id, id);
CREATE INDEX change_log_shop_entity_idx ON change_log (shop_id, entity_type, id);

CREATE TRIGGER change_log_deny_mutation
  BEFORE UPDATE OR DELETE ON change_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
