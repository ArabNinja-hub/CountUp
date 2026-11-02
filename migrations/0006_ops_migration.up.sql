-- 0006: migration tracking / reconciliation, cutover config, backups and exports.
-- These are operational bookkeeping tables; no migration or cutover is executed here.

CREATE TYPE migration_status AS ENUM ('running', 'completed', 'failed', 'partial');
CREATE TYPE cutover_mode AS ENUM ('firestore', 'dual_write', 'postgres');

CREATE TABLE migration_runs (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        TIMESTAMPTZ       NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  status            migration_status   NOT NULL DEFAULT 'running',
  source_snapshot   TEXT,
  notes             TEXT
);

CREATE INDEX migration_runs_started_idx ON migration_runs (started_at DESC);

CREATE TABLE migration_shop_results (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID        NOT NULL REFERENCES migration_runs (id) ON DELETE CASCADE,
  shop_id             UUID        REFERENCES shops (id) ON DELETE SET NULL,
  legacy_shop_id      TEXT,
  status              TEXT        NOT NULL CHECK (status IN ('pending', 'migrated', 'skipped', 'failed')),
  records_migrated    INT         NOT NULL DEFAULT 0 CHECK (records_migrated >= 0),
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migration_shop_results_run_shop_uq UNIQUE (run_id, shop_id)
);

CREATE INDEX migration_shop_results_status_idx
  ON migration_shop_results (run_id, status);

CREATE TABLE legacy_id_map (
  legacy_type   TEXT        NOT NULL,
  legacy_id     TEXT        NOT NULL,
  new_id        UUID        NOT NULL,
  shop_id       UUID        REFERENCES shops (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legacy_id_map_pk PRIMARY KEY (legacy_type, legacy_id)
);

CREATE INDEX legacy_id_map_new_id_idx ON legacy_id_map (new_id);
CREATE INDEX legacy_id_map_shop_idx ON legacy_id_map (shop_id);

CREATE TABLE cutover_config (
  key           TEXT        PRIMARY KEY,
  value         JSONB       NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID        REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE backup_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  kind          TEXT        NOT NULL CHECK (kind IN ('full', 'incremental', 'wal')),
  storage_key   TEXT,
  size_bytes    BIGINT      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256        TEXT
);

CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);

CREATE TABLE restore_drills (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_run_id  UUID        NOT NULL REFERENCES backup_runs (id) ON DELETE RESTRICT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  status         TEXT        NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
  notes          TEXT
);

CREATE INDEX restore_drills_started_idx ON restore_drills (started_at DESC);

CREATE TABLE export_jobs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID        REFERENCES shops (id) ON DELETE SET NULL,
  requested_by   UUID        REFERENCES users (id) ON DELETE SET NULL,
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  format         TEXT        NOT NULL CHECK (format IN ('json', 'csv')),
  storage_key    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX export_jobs_shop_created_idx ON export_jobs (shop_id, created_at DESC);

-- ---------------------------------------------------------------------------------------
-- OPTIONAL RLS - NOT ENABLED. ADR-11 is PROVISIONAL AND NOT APPROVED.
--
-- Tenant isolation is currently enforced by (a) composite FKs that make cross-shop
-- references impossible and (b) application-level shop_id scoping in every query.
-- RLS is a defence-in-depth option, but enabling it requires a decision about which
-- PostgreSQL role the API connects as and how the shop claim is set per transaction.
-- That decision is blocked, so NO policy is created and NO table has RLS enabled.
--
-- -- ALTER TABLE items ENABLE ROW LEVEL SECURITY;
-- -- CREATE POLICY items_shop_isolation ON items
-- --   USING (shop_id = nullif(current_setting('app.current_shop_id', true), '')::uuid);
-- ---------------------------------------------------------------------------------------
