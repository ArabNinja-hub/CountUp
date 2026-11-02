-- CountUp M1 baseline / 0001: enum types, trigger helpers, plans and system config.
--
-- ADR STATUS: the following are PROPOSED DEFAULTS ONLY and are NOT APPROVED.
--   ADR-09  local_date is derived with timezone('Africa/Lusaka', ...)
--   ADR-10  every monetary column is BIGINT ngwee (100 ngwee = K1.00)
--   ADR-11  tenant isolation = application-level shop_id scoping + composite FKs;
--           PostgreSQL RLS is optional and deliberately NOT enabled (see 0006)
--   ADR-14  momo_operator retains the historical 'zamtel' value
-- See docs/adr/ADR-REGISTER.md. Do not treat these as settled architecture.

CREATE TYPE user_role AS ENUM ('owner', 'staff', 'platform_admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE shop_role AS ENUM ('owner', 'staff');
CREATE TYPE identity_kind AS ENUM ('phone', 'email');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION set_local_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.local_date := timezone('Africa/Lusaka', NEW.created_at)::date;
  RETURN NEW;
END
$$;

CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: %', TG_TABLE_NAME;
END
$$;

-- Business settings. Values are JSONB so a config change is data, not a migration.
CREATE TABLE system_config (
  key             TEXT        PRIMARY KEY,
  value           JSONB       NOT NULL,
  is_provisional  BOOLEAN     NOT NULL DEFAULT false,
  description     TEXT        NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER system_config_set_updated_at
  BEFORE UPDATE ON system_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Values mirror shared/subscriptionPlans.ts (frontend) and packages/shared/src/plan-catalog.ts.
INSERT INTO system_config (key, value, is_provisional, description) VALUES
  ('trial_duration_days', '30'::jsonb, false, 'Mirrors src/config/plans.ts TRIAL_DURATION_DAYS.'),
  ('expiry_warning_days', '5'::jsonb, false, 'Mirrors src/config/plans.ts EXPIRY_WARNING_DAYS.'),
  ('grace_period_days', '3'::jsonb, false, 'Mirrors src/config/plans.ts GRACE_PERIOD_DAYS.'),
  ('currency', '"ZMW"'::jsonb, false, 'Mirrors src/types/index.ts currency literal.'),
  ('sale_max_lines', '160'::jsonb, false, 'Firestore 500-write transaction headroom; backend ceiling for one sale.'),
  ('timezone', '"Africa/Lusaka"'::jsonb, true, 'PROVISIONAL ADR-09 - NOT APPROVED.'),
  ('money_unit', '"ngwee"'::jsonb, true, 'PROVISIONAL ADR-10 - NOT APPROVED.'),
  ('tenant_isolation', '"application_scoping"'::jsonb, true, 'PROVISIONAL ADR-11 - NOT APPROVED. RLS optional and disabled.'),
  ('retain_zamtel_operator', 'true'::jsonb, true, 'PROVISIONAL ADR-14 - NOT APPROVED. Historical enum value kept for legacy rows.');

-- Platform-wide catalogue. No shop_id: this is shared reference data, not tenant data.
CREATE TABLE plans (
  plan_id       TEXT    PRIMARY KEY CHECK (plan_id IN ('monthly', 'quarterly', 'biannual')),
  name          TEXT    NOT NULL,
  months        INT     NOT NULL CHECK (months > 0),
  price_ngwee   BIGINT  NOT NULL CHECK (price_ngwee > 0),
  active        BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO plans (plan_id, name, months, price_ngwee, active) VALUES
  ('monthly',   '1 Month',  1, 9900,  true),
  ('quarterly', '3 Months', 3, 26900, true),
  ('biannual',  '6 Months', 6, 49900, true);
