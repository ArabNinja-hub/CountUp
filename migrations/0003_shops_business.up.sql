-- 0003: shops, membership, entitlements, inventory, sales, credit and expenses.
--
-- TENANT ISOLATION CONTRACT
--   * Every tenant table carries shop_id and a direct FK to shops(id).
--   * Every parent that a child can reference exposes UNIQUE (shop_id, id).
--   * Every cross-tenant reference is a COMPOSITE FK (shop_id, parent_id), so PostgreSQL
--     itself rejects a row that points at another shop's parent (SQLSTATE 23503).
--   * This is database-level containment in ADDITION to the (unapproved, ADR-11)
--     application-level shop_id scoping. RLS is optional and is NOT enabled.
--
-- All money columns are BIGINT ngwee (PROVISIONAL ADR-10 - NOT APPROVED).
-- local_date is derived by set_local_date() using Africa/Lusaka (PROVISIONAL ADR-09).

CREATE TYPE plan_status AS ENUM ('trial', 'manual_pending', 'active', 'grace', 'expired', 'suspended', 'rejected');
CREATE TYPE plan_type AS ENUM ('trial', 'monthly', 'quarterly', 'biannual');
CREATE TYPE payment_type AS ENUM ('cash', 'momo', 'card', 'bank_transfer', 'credit', 'other');
CREATE TYPE momo_operator AS ENUM ('mtn', 'airtel', 'zamtel');
CREATE TYPE payment_method AS ENUM ('cash', 'momo', 'bank_transfer', 'card', 'other');
CREATE TYPE stock_movement_type AS ENUM ('initial', 'sale', 'restock', 'adjustment', 'void');
CREATE TYPE stock_conflict_kind AS ENUM ('negative_stock', 'duplicate_sale', 'missing_item');
CREATE TYPE expense_category AS ENUM ('rent', 'transport', 'restock', 'council_fee', 'helper_wage', 'other');

CREATE TABLE shops (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name                    TEXT         NOT NULL,
  currency                TEXT         NOT NULL DEFAULT 'ZMW',
  timezone                TEXT         NOT NULL DEFAULT 'Africa/Lusaka',
  current_plan            plan_type    NOT NULL DEFAULT 'trial',
  plan_status             plan_status  NOT NULL DEFAULT 'trial',
  trial_ends_at           TIMESTAMPTZ,
  plan_expiry_at          TIMESTAMPTZ,
  access_until            TIMESTAMPTZ,
  sales_access_until_ms   BIGINT,
  legacy_owner_uid        TEXT,
  legacy_shop_id          TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ,
  CONSTRAINT shops_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX shops_legacy_shop_id_uq
  ON shops (legacy_shop_id) WHERE legacy_shop_id IS NOT NULL;
CREATE INDEX shops_owner_idx ON shops (owner_user_id);
CREATE INDEX shops_plan_status_idx ON shops (plan_status);

CREATE TABLE shop_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role         shop_role   NOT NULL DEFAULT 'staff',
  invited_by   UUID        REFERENCES users (id) ON DELETE SET NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT shop_members_shop_user_uq UNIQUE (shop_id, user_id)
);

CREATE INDEX shop_members_user_active_idx
  ON shop_members (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX shop_members_one_owner_uq
  ON shop_members (shop_id) WHERE role = 'owner' AND revoked_at IS NULL;

CREATE TABLE entitlement_snapshots (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID         NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  effective_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  plan            plan_type    NOT NULL,
  status          plan_status  NOT NULL,
  plan_expiry_at  TIMESTAMPTZ,
  access_until    TIMESTAMPTZ,
  source          TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX entitlement_snapshots_shop_latest_idx
  ON entitlement_snapshots (shop_id, effective_at DESC);

CREATE TABLE items (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  sku                 TEXT,
  name                TEXT        NOT NULL,
  unit                TEXT        NOT NULL DEFAULT 'each',
  quantity            INT         NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level       INT         NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  cost_price_ngwee    BIGINT      NOT NULL DEFAULT 0 CHECK (cost_price_ngwee >= 0),
  sell_price_ngwee    BIGINT      NOT NULL CHECK (sell_price_ngwee > 0),
  legacy_item_id      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT items_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT items_shop_sku_uq UNIQUE (shop_id, sku),
  CONSTRAINT items_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX items_shop_active_idx ON items (shop_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX items_legacy_id_uq
  ON items (shop_id, legacy_item_id) WHERE legacy_item_id IS NOT NULL;

CREATE TABLE customers (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  name                   TEXT        NOT NULL,
  phone                  TEXT,
  credit_balance_ngwee   BIGINT      NOT NULL DEFAULT 0 CHECK (credit_balance_ngwee >= 0),
  legacy_customer_id     TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  CONSTRAINT customers_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT customers_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX customers_shop_phone_idx ON customers (shop_id, phone);
CREATE UNIQUE INDEX customers_legacy_id_uq
  ON customers (shop_id, legacy_customer_id) WHERE legacy_customer_id IS NOT NULL;

CREATE TABLE credit_payments (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID            NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  customer_id         UUID            NOT NULL,
  amount_ngwee        BIGINT          NOT NULL CHECK (amount_ngwee > 0),
  payment_method      payment_method  NOT NULL DEFAULT 'cash',
  momo_operator       momo_operator,
  reference           TEXT,
  note                TEXT,
  legacy_payment_id   TEXT,
  created_by          UUID            REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
  local_date          DATE            NOT NULL DEFAULT (timezone('Africa/Lusaka', now())::date),
  CONSTRAINT credit_payments_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT credit_payments_customer_fk
    FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id),
  CONSTRAINT credit_payments_legacy_id_uq UNIQUE (shop_id, legacy_payment_id)
);

CREATE INDEX credit_payments_shop_date_idx
  ON credit_payments (shop_id, local_date DESC);

CREATE TABLE sales (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID          NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  sale_number      TEXT,
  customer_id      UUID,
  total_ngwee      BIGINT        NOT NULL CHECK (total_ngwee >= 0),
  discount_ngwee   BIGINT        NOT NULL DEFAULT 0 CHECK (discount_ngwee >= 0),
  paid_ngwee       BIGINT        NOT NULL DEFAULT 0 CHECK (paid_ngwee >= 0),
  payment_type     payment_type  NOT NULL DEFAULT 'cash',
  momo_operator    momo_operator,
  status           TEXT          NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  voided_at        TIMESTAMPTZ,
  voided_by        UUID          REFERENCES users (id) ON DELETE SET NULL,
  void_reason      TEXT,
  legacy_sale_id   TEXT,
  created_by       UUID          REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  local_date       DATE          NOT NULL DEFAULT (timezone('Africa/Lusaka', now())::date),
  CONSTRAINT sales_shop_scope_uq UNIQUE (shop_id, id),
  CONSTRAINT sales_customer_fk
    FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id),
  CONSTRAINT sales_legacy_id_uq UNIQUE (shop_id, legacy_sale_id),
  CONSTRAINT sales_void_consistency CHECK ((status = 'voided') = (voided_at IS NOT NULL))
);

CREATE INDEX sales_shop_date_idx ON sales (shop_id, local_date DESC);
CREATE INDEX sales_shop_customer_idx ON sales (shop_id, customer_id);

CREATE TABLE sale_items (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  sale_id             UUID        NOT NULL,
  item_id             UUID        NOT NULL,
  quantity            INT         NOT NULL CHECK (quantity > 0),
  unit_price_ngwee    BIGINT      NOT NULL CHECK (unit_price_ngwee > 0),
  line_total_ngwee    BIGINT      NOT NULL CHECK (line_total_ngwee >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sale_items_sale_fk
    FOREIGN KEY (shop_id, sale_id) REFERENCES sales (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT sale_items_item_fk
    FOREIGN KEY (shop_id, item_id) REFERENCES items (shop_id, id),
  CONSTRAINT sale_items_line_total CHECK (line_total_ngwee = quantity * unit_price_ngwee)
);

CREATE INDEX sale_items_sale_idx ON sale_items (shop_id, sale_id);
CREATE INDEX sale_items_item_idx ON sale_items (shop_id, item_id);

CREATE TABLE credit_ledger_entries (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               UUID        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  customer_id           UUID        NOT NULL,
  sale_id               UUID,
  credit_payment_id     UUID,
  delta_ngwee           BIGINT      NOT NULL CHECK (delta_ngwee <> 0),
  balance_after_ngwee   BIGINT      NOT NULL CHECK (balance_after_ngwee >= 0),
  entry_type            TEXT        NOT NULL CHECK (entry_type IN ('sale', 'payment', 'adjustment', 'reversal')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_customer_fk
    FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id),
  CONSTRAINT credit_ledger_payment_fk
    FOREIGN KEY (shop_id, credit_payment_id) REFERENCES credit_payments (shop_id, id),
  CONSTRAINT credit_ledger_sale_fk
    FOREIGN KEY (shop_id, sale_id) REFERENCES sales (shop_id, id)
);

CREATE INDEX credit_ledger_shop_customer_idx
  ON credit_ledger_entries (shop_id, customer_id, created_at);

CREATE TABLE stock_movements (
  id                   UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              UUID                 NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  item_id              UUID                 NOT NULL,
  delta                INT                  NOT NULL CHECK (delta <> 0),
  balance_after        INT                  NOT NULL CHECK (balance_after >= 0),
  reason               stock_movement_type  NOT NULL,
  related_sale_id      UUID,
  legacy_movement_id   TEXT,
  created_by           UUID                 REFERENCES users (id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ          NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_item_fk
    FOREIGN KEY (shop_id, item_id) REFERENCES items (shop_id, id),
  CONSTRAINT stock_movements_sale_fk
    FOREIGN KEY (shop_id, related_sale_id) REFERENCES sales (shop_id, id),
  CONSTRAINT stock_movements_legacy_id_uq UNIQUE (shop_id, legacy_movement_id)
);

CREATE INDEX stock_movements_item_idx
  ON stock_movements (shop_id, item_id, created_at);

CREATE TABLE stock_conflicts (
  id                 UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            UUID                   NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  item_id            UUID,
  related_sale_id    UUID,
  kind               stock_conflict_kind    NOT NULL,
  detail             JSONB                  NOT NULL DEFAULT '{}'::jsonb,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ            NOT NULL DEFAULT now(),
  CONSTRAINT stock_conflicts_item_fk
    FOREIGN KEY (shop_id, item_id) REFERENCES items (shop_id, id),
  CONSTRAINT stock_conflicts_sale_fk
    FOREIGN KEY (shop_id, related_sale_id) REFERENCES sales (shop_id, id)
);

CREATE INDEX stock_conflicts_open_idx
  ON stock_conflicts (shop_id) WHERE resolved_at IS NULL;

CREATE TABLE expenses (
  id                   UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              UUID              NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  category             expense_category  NOT NULL,
  amount_ngwee         BIGINT            NOT NULL CHECK (amount_ngwee >= 0),
  note                 TEXT,
  legacy_expense_id    TEXT,
  created_by           UUID              REFERENCES users (id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ       NOT NULL DEFAULT now(),
  local_date           DATE              NOT NULL DEFAULT (timezone('Africa/Lusaka', now())::date),
  CONSTRAINT expenses_legacy_id_uq UNIQUE (shop_id, legacy_expense_id)
);

CREATE INDEX expenses_shop_date_idx ON expenses (shop_id, local_date DESC);

-- Immutable ledger tables: no UPDATE and no DELETE, only INSERT.
CREATE TRIGGER credit_ledger_entries_deny_mutation
  BEFORE UPDATE OR DELETE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER stock_movements_deny_mutation
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER shops_set_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER items_set_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER sales_set_local_date
  BEFORE INSERT OR UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_local_date();

CREATE TRIGGER credit_payments_set_local_date
  BEFORE INSERT OR UPDATE ON credit_payments
  FOR EACH ROW EXECUTE FUNCTION set_local_date();

CREATE TRIGGER expenses_set_local_date
  BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_local_date();
