-- =============================================================================
-- CountUp Zambia — Phase 1: Core Postgres Schema, Constraints, Triggers & RLS
-- =============================================================================
-- Key invariants enforced by this migration:
-- 1. All money values are stored in integer ngwee (bigint), never floats.
-- 2. Every child table carries shop_id (uuid), is indexed on shop_id and
--    (shop_id, updated_at), and enforces tenant isolation without joins in RLS.
-- 3. Every table maintains an authoritative server updated_at timestamp via
--    trigger for lossless reconnect cursor sync.
-- 4. Row Level Security is enabled on EVERY table with default deny.
-- 5. Clients can never modify plan/expiry/suspension fields, payment records,
--    reference locks, trial phone history, or audit logs (service_role only).
-- 6. Invariant-bearing data (stock quantity, customer balance, sales,
--    sale_lines, repayments, expenses, stock movements, conflicts, sync
--    markers) cannot be mutated directly by clients — only via server RPCs.
-- 7. payment_reference_locks uses a partial unique index on
--    (network, transaction_reference) WHERE status IN ('pending', 'approved')
--    so rejected references can be corrected and resubmitted.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Helper Functions (JWT Claim Extraction & Timestamp Maintenance)
-- -----------------------------------------------------------------------------

-- Platform admin authority comes strictly from server-set app_metadata.
-- Client-editable user_metadata and email claims are never trusted.
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    CASE
      WHEN pg_catalog.jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'platform_admin') = 'boolean'
        THEN (auth.jwt() -> 'app_metadata' -> 'platform_admin')::boolean
      ELSE false
    END,
    false
  );
$$;

-- Server-set shop ownership claim in app_metadata.shop_id.
-- Safely returns NULL when missing or malformed instead of raising 22P02.
CREATE OR REPLACE FUNCTION public.request_shop_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  raw_id text;
BEGIN
  IF pg_catalog.jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'shop_id') <> 'string' THEN
    RETURN NULL;
  END IF;
  raw_id := NULLIF(pg_catalog.btrim(auth.jwt() -> 'app_metadata' ->> 'shop_id'), '');
  IF raw_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw_id::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- Monotonically advancing server updated_at cursor on every insert and update.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := pg_catalog.clock_timestamp();
  ELSE
    NEW.updated_at := GREATEST(pg_catalog.clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;
  RETURN NEW;
END;
$$;

-- Defense-in-depth column guards (alongside column-level SQL GRANTs).
CREATE OR REPLACE FUNCTION public.protect_shop_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.owner_phone IS DISTINCT FROM OLD.owner_phone
      OR NEW.plan_status IS DISTINCT FROM OLD.plan_status
      OR NEW.plan_type IS DISTINCT FROM OLD.plan_type
      OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
      OR NEW.plan_expiry_at IS DISTINCT FROM OLD.plan_expiry_at
      OR NEW.sales_access_until IS DISTINCT FROM OLD.sales_access_until
      OR NEW.pending_payment_id IS DISTINCT FROM OLD.pending_payment_id
      OR NEW.subscription_started_at IS DISTINCT FROM OLD.subscription_started_at
      OR NEW.subscription_payment_id IS DISTINCT FROM OLD.subscription_payment_id
      OR NEW.status_before_suspension IS DISTINCT FROM OLD.status_before_suspension
      OR NEW.is_deactivated IS DISTINCT FROM OLD.is_deactivated
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.last_server_contact_at IS DISTINCT FROM OLD.last_server_contact_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Insufficient privilege to modify protected shop fields.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_item_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.last_sold_at IS DISTINCT FROM OLD.last_sold_at
      OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Stock quantity and item identity can only be changed via server RPC.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_customer_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
      OR NEW.total_owed_ngwee IS DISTINCT FROM OLD.total_owed_ngwee
      OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Customer balance and identity can only be changed via server RPC.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tables, Foreign Keys, CHECK Constraints & Indexes
-- -----------------------------------------------------------------------------

-- 2.1 shops
CREATE TABLE public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  owner_phone text NOT NULL CHECK (owner_phone ~ '^\+260[0-9]{9}$'),
  plan_status text NOT NULL DEFAULT 'trial' CHECK (
    plan_status IN (
      'trial',
      'pending_payment',
      'active',
      'grace',
      'expired',
      'rejected',
      'suspended'
    )
  ),
  plan_type text NOT NULL DEFAULT 'trial' CHECK (
    plan_type IN ('trial', 'monthly', 'quarterly', 'biannual')
  ),
  trial_ends_at timestamptz NOT NULL,
  plan_expiry_at timestamptz NOT NULL,
  sales_access_until timestamptz NOT NULL,
  pending_payment_id uuid,
  subscription_started_at timestamptz,
  subscription_payment_id uuid,
  status_before_suspension text CHECK (
    status_before_suspension IS NULL OR status_before_suspension IN (
      'trial',
      'pending_payment',
      'active',
      'grace',
      'expired',
      'rejected'
    )
  ),
  is_deactivated boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'ZMW' CHECK (currency = 'ZMW'),
  momo_airtel_number text CHECK (
    momo_airtel_number IS NULL OR char_length(momo_airtel_number) <= 30
  ),
  momo_mtn_number text CHECK (
    momo_mtn_number IS NULL OR char_length(momo_mtn_number) <= 30
  ),
  momo_zamtel_number text CHECK (
    momo_zamtel_number IS NULL OR char_length(momo_zamtel_number) <= 30
  ),
  last_server_contact_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shops_sales_access_after_expiry CHECK (sales_access_until >= plan_expiry_at)
);

CREATE INDEX idx_shops_updated_at ON public.shops (updated_at);

-- 2.2 used_trial_phones (retained across shop deletions to prevent trial resets / suspension bypass)
CREATE TABLE public.used_trial_phones (
  owner_phone text PRIMARY KEY CHECK (owner_phone ~ '^\+260[0-9]{9}$'),
  first_shop_id uuid NOT NULL,
  first_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  trial_used_at timestamptz NOT NULL DEFAULT now(),
  was_suspended boolean NOT NULL DEFAULT false,
  last_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.3 items
CREATE TABLE public.items (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  buying_price_ngwee bigint NOT NULL DEFAULT 0 CHECK (
    buying_price_ngwee >= 0 AND buying_price_ngwee <= 9007199254740991
  ),
  buying_price_known boolean NOT NULL DEFAULT true,
  selling_price_ngwee bigint NOT NULL CHECK (
    selling_price_ngwee > 0 AND selling_price_ngwee <= 9007199254740991
  ),
  unit_label text NOT NULL DEFAULT '' CHECK (char_length(unit_label) <= 60),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  is_deleted boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  last_sold_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT items_unknown_cost_zero CHECK (buying_price_known OR buying_price_ngwee = 0)
);

CREATE INDEX idx_items_shop_id ON public.items (shop_id);
CREATE INDEX idx_items_shop_updated_at ON public.items (shop_id, updated_at);

-- 2.4 customers
CREATE TABLE public.customers (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  total_owed_ngwee bigint NOT NULL DEFAULT 0 CHECK (
    total_owed_ngwee >= 0 AND total_owed_ngwee <= 9007199254740991
  ),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE INDEX idx_customers_shop_id ON public.customers (shop_id);
CREATE INDEX idx_customers_shop_updated_at ON public.customers (shop_id, updated_at);

-- 2.5 sales
CREATE TABLE public.sales (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  items_count integer NOT NULL CHECK (items_count > 0),
  total_amount_ngwee bigint NOT NULL CHECK (
    total_amount_ngwee > 0 AND total_amount_ngwee <= 9007199254740991
  ),
  total_cost_ngwee bigint NOT NULL DEFAULT 0 CHECK (
    total_cost_ngwee >= 0 AND total_cost_ngwee <= 9007199254740991
  ),
  profit_ngwee bigint NOT NULL CHECK (
    profit_ngwee >= -9007199254740991 AND profit_ngwee <= 9007199254740991
  ),
  missing_cost_revenue_ngwee bigint NOT NULL DEFAULT 0 CHECK (
    missing_cost_revenue_ngwee >= 0 AND missing_cost_revenue_ngwee <= total_amount_ngwee
  ),
  payment_type text NOT NULL CHECK (payment_type IN ('cash', 'momo', 'credit')),
  momo_operator text CHECK (momo_operator IS NULL OR momo_operator IN ('airtel', 'mtn', 'zamtel')),
  customer_id text,
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 40),
  receipt_number text NOT NULL CHECK (char_length(btrim(receipt_number)) BETWEEN 1 AND 120),
  payment_reference text CHECK (payment_reference IS NULL OR char_length(payment_reference) <= 120),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  local_date text CHECK (local_date IS NULL OR local_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  cash_tendered_ngwee bigint CHECK (
    cash_tendered_ngwee IS NULL OR (
      cash_tendered_ngwee >= total_amount_ngwee AND cash_tendered_ngwee <= 9007199254740991
    )
  ),
  change_given_ngwee bigint CHECK (
    change_given_ngwee IS NULL OR (
      change_given_ngwee >= 0 AND change_given_ngwee <= 9007199254740991
    )
  ),
  is_deleted boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  is_offline_sync boolean NOT NULL DEFAULT false,
  offline_window_flagged boolean NOT NULL DEFAULT false,
  offline_flag_reason text CHECK (
    offline_flag_reason IS NULL OR char_length(offline_flag_reason) <= 500
  ),
  client_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT sales_customer_fk
    FOREIGN KEY (shop_id, customer_id)
    REFERENCES public.customers(shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT sales_credit_requires_customer
    CHECK (payment_type <> 'credit' OR customer_id IS NOT NULL),
  CONSTRAINT sales_profit_formula
    CHECK (profit_ngwee = total_amount_ngwee - total_cost_ngwee - missing_cost_revenue_ngwee),
  CONSTRAINT sales_cash_change_formula
    CHECK (
      (cash_tendered_ngwee IS NULL AND change_given_ngwee IS NULL) OR
      (cash_tendered_ngwee IS NOT NULL AND change_given_ngwee = cash_tendered_ngwee - total_amount_ngwee)
    )
);

CREATE INDEX idx_sales_shop_id ON public.sales (shop_id);
CREATE INDEX idx_sales_shop_updated_at ON public.sales (shop_id, updated_at);
CREATE INDEX idx_sales_shop_customer ON public.sales (shop_id, customer_id);

-- 2.6 sale_lines (carries shop_id directly for join-free RLS)
CREATE TABLE public.sale_lines (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 160 AND position('/' in id) = 0),
  sale_id text NOT NULL,
  line_index integer NOT NULL DEFAULT 0 CHECK (line_index >= 0),
  item_id text NOT NULL,
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200),
  unit_label text NOT NULL DEFAULT '' CHECK (char_length(unit_label) <= 60),
  quantity integer NOT NULL CHECK (quantity > 0),
  buying_price_ngwee bigint NOT NULL DEFAULT 0 CHECK (
    buying_price_ngwee >= 0 AND buying_price_ngwee <= 9007199254740991
  ),
  buying_price_known boolean NOT NULL DEFAULT true,
  selling_price_ngwee bigint NOT NULL CHECK (
    selling_price_ngwee > 0 AND selling_price_ngwee <= 9007199254740991
  ),
  line_total_ngwee bigint NOT NULL CHECK (
    line_total_ngwee > 0 AND line_total_ngwee <= 9007199254740991
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT sale_lines_sale_fk
    FOREIGN KEY (shop_id, sale_id)
    REFERENCES public.sales(shop_id, id)
    ON DELETE CASCADE,
  CONSTRAINT sale_lines_item_fk
    FOREIGN KEY (shop_id, item_id)
    REFERENCES public.items(shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT sale_lines_unknown_cost_zero
    CHECK (buying_price_known OR buying_price_ngwee = 0),
  CONSTRAINT sale_lines_total_formula
    CHECK (line_total_ngwee = selling_price_ngwee * quantity)
);

CREATE INDEX idx_sale_lines_shop_id ON public.sale_lines (shop_id);
CREATE INDEX idx_sale_lines_shop_sale_id ON public.sale_lines (shop_id, sale_id);
CREATE INDEX idx_sale_lines_shop_updated_at ON public.sale_lines (shop_id, updated_at);

-- 2.7 credit_payments
CREATE TABLE public.credit_payments (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  customer_id text NOT NULL,
  customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 200),
  amount_ngwee bigint NOT NULL CHECK (
    amount_ngwee > 0 AND amount_ngwee <= 9007199254740991
  ),
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'momo')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  local_date text CHECK (local_date IS NULL OR local_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  is_demo boolean NOT NULL DEFAULT false,
  sync_correction jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT credit_payments_customer_fk
    FOREIGN KEY (shop_id, customer_id)
    REFERENCES public.customers(shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_credit_payments_shop_id ON public.credit_payments (shop_id);
CREATE INDEX idx_credit_payments_shop_customer ON public.credit_payments (shop_id, customer_id);
CREATE INDEX idx_credit_payments_shop_updated_at ON public.credit_payments (shop_id, updated_at);

-- 2.8 expenses
CREATE TABLE public.expenses (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  category text NOT NULL CHECK (
    category IN ('rent', 'transport', 'restock', 'council_fee', 'helper_wage', 'other')
  ),
  amount_ngwee bigint NOT NULL CHECK (
    amount_ngwee > 0 AND amount_ngwee <= 9007199254740991
  ),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE INDEX idx_expenses_shop_id ON public.expenses (shop_id);
CREATE INDEX idx_expenses_shop_updated_at ON public.expenses (shop_id, updated_at);

-- 2.9 stock_movements
CREATE TABLE public.stock_movements (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128 AND position('/' in id) = 0),
  item_id text NOT NULL,
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('initial', 'sale', 'restock', 'adjustment', 'void')),
  delta integer NOT NULL,
  previous_quantity integer NOT NULL CHECK (previous_quantity >= 0),
  new_quantity integer NOT NULL CHECK (new_quantity >= 0),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  related_sale_id text,
  requested_quantity integer CHECK (requested_quantity IS NULL OR requested_quantity >= 0),
  recount_needed boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT stock_movements_item_fk
    FOREIGN KEY (shop_id, item_id)
    REFERENCES public.items(shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT stock_movements_sale_fk
    FOREIGN KEY (shop_id, related_sale_id)
    REFERENCES public.sales(shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_stock_movements_shop_id ON public.stock_movements (shop_id);
CREATE INDEX idx_stock_movements_shop_updated_at ON public.stock_movements (shop_id, updated_at);

-- 2.10 stock_conflicts
CREATE TABLE public.stock_conflicts (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 160 AND position('/' in id) = 0),
  item_id text NOT NULL,
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'shortfall' CHECK (kind IN ('shortfall', 'recount')),
  observed integer CHECK (observed IS NULL OR observed >= 0),
  requested integer NOT NULL CHECK (requested >= 0),
  available integer NOT NULL CHECK (available >= 0),
  shortfall integer NOT NULL CHECK (shortfall >= 0),
  related_sale_id text,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT stock_conflicts_item_fk
    FOREIGN KEY (shop_id, item_id)
    REFERENCES public.items(shop_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_stock_conflicts_shop_id ON public.stock_conflicts (shop_id);
CREATE INDEX idx_stock_conflicts_shop_updated_at ON public.stock_conflicts (shop_id, updated_at);

-- 2.11 sync_operations (unique per-shop idempotency keys & conflict resolution audit)
CREATE TABLE public.sync_operations (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (
    char_length(btrim(operation_id)) BETWEEN 1 AND 160 AND position('/' in operation_id) = 0
  ),
  operation_type text NOT NULL CHECK (
    operation_type IN (
      'sale',
      'void_sale',
      'item',
      'customer',
      'payment',
      'expense',
      'stock_update',
      'conflict_resolution',
      'backup_import'
    )
  ),
  outcome text NOT NULL DEFAULT 'applied' CHECK (
    outcome IN ('applied', 'already-voided', 'resolved', 'flagged')
  ),
  sale_id text,
  has_resolution boolean NOT NULL DEFAULT false,
  resolution jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, operation_id),
  CONSTRAINT sync_operations_resolution_present
    CHECK (NOT has_resolution OR resolution IS NOT NULL)
);

CREATE INDEX idx_sync_operations_shop_id ON public.sync_operations (shop_id);
CREATE INDEX idx_sync_operations_shop_updated_at ON public.sync_operations (shop_id, updated_at);
CREATE INDEX idx_sync_operations_resolutions
  ON public.sync_operations (shop_id, applied_at DESC)
  WHERE has_resolution = true;

-- 2.12 subscription_payments
CREATE TABLE public.subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  shop_name_snapshot text NOT NULL CHECK (char_length(btrim(shop_name_snapshot)) BETWEEN 1 AND 120),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'manual_mobile_money' CHECK (provider = 'manual_mobile_money'),
  network text NOT NULL CHECK (network IN ('mtn', 'airtel')),
  plan_id text NOT NULL CHECK (plan_id IN ('monthly', 'quarterly', 'biannual')),
  transaction_reference text NOT NULL CHECK (
    transaction_reference ~ '^[A-Z0-9][A-Z0-9._/-]{4,49}$'
  ),
  payer_phone text NOT NULL CHECK (payer_phone ~ '^\+260[0-9]{9}$'),
  payment_date date NOT NULL,
  amount_ngwee bigint NOT NULL CHECK (
    amount_ngwee > 0 AND amount_ngwee <= 9007199254740991
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason text CHECK (
    status <> 'rejected' OR (
      rejection_reason IS NOT NULL AND char_length(btrim(rejection_reason)) BETWEEN 3 AND 500
    )
  ),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subscription_start_at timestamptz,
  subscription_expiry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscription_payments_shop_id
  ON public.subscription_payments (shop_id);
CREATE INDEX idx_subscription_payments_shop_updated_at
  ON public.subscription_payments (shop_id, updated_at);
CREATE INDEX idx_subscription_payments_status_submitted
  ON public.subscription_payments (status, submitted_at DESC);

-- At most one pending payment submission per shop at a time.
CREATE UNIQUE INDEX idx_subscription_payments_one_pending_per_shop
  ON public.subscription_payments (shop_id)
  WHERE status = 'pending';

-- Wire shops payment pointers back to subscription_payments.
ALTER TABLE public.shops
  ADD CONSTRAINT shops_pending_payment_fk
    FOREIGN KEY (pending_payment_id)
    REFERENCES public.subscription_payments(id)
    ON DELETE SET NULL,
  ADD CONSTRAINT shops_subscription_payment_fk
    FOREIGN KEY (subscription_payment_id)
    REFERENCES public.subscription_payments(id)
    ON DELETE SET NULL;

-- 2.13 payment_reference_locks
-- Uses a partial unique index on status IN ('pending', 'approved') so a
-- rejected reference can be corrected and resubmitted, while pending/approved
-- references remain globally locked (even if a shop is later deleted).
CREATE TABLE public.payment_reference_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES public.subscription_payments(id) ON DELETE SET NULL,
  shop_id uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  network text NOT NULL CHECK (network IN ('mtn', 'airtel')),
  transaction_reference text NOT NULL CHECK (
    transaction_reference ~ '^[A-Z0-9][A-Z0-9._/-]{4,49}$'
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_reference_locks_shop_id
  ON public.payment_reference_locks (shop_id);
CREATE INDEX idx_payment_reference_locks_payment_id
  ON public.payment_reference_locks (payment_id);

CREATE UNIQUE INDEX idx_payment_reference_locks_active_ref
  ON public.payment_reference_locks (network, transaction_reference)
  WHERE status IN ('pending', 'approved');

-- 2.14 platform_audit
CREATE TABLE public.platform_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (char_length(btrim(action)) BETWEEN 1 AND 100),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shop_id uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.subscription_payments(id) ON DELETE SET NULL,
  transaction_reference text,
  amount_ngwee bigint CHECK (amount_ngwee IS NULL OR amount_ngwee > 0),
  plan_id text CHECK (plan_id IS NULL OR plan_id IN ('monthly', 'quarterly', 'biannual')),
  days integer CHECK (days IS NULL OR (days >= 1 AND days <= 3650)),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_audit_shop_id ON public.platform_audit (shop_id);
CREATE INDEX idx_platform_audit_created_at ON public.platform_audit (created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Attach Triggers (updated_at on ALL tables + invariant column guards)
-- -----------------------------------------------------------------------------

CREATE TRIGGER trg_shops_protect_columns
  BEFORE UPDATE ON public.shops
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_shop_privileged_columns();

CREATE TRIGGER trg_items_protect_invariants
  BEFORE UPDATE ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_item_invariants();

CREATE TRIGGER trg_customers_protect_invariants
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_customer_invariants();

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'shops',
    'used_trial_phones',
    'items',
    'customers',
    'sales',
    'sale_lines',
    'credit_payments',
    'expenses',
    'stock_movements',
    'stock_conflicts',
    'sync_operations',
    'subscription_payments',
    'payment_reference_locks',
    'platform_audit'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_touch_updated_at
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.touch_updated_at();',
      tbl,
      tbl
    );
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Supabase Custom Access Token Hook (injects verified shop_id into JWT)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claims jsonb;
  app_meta jsonb;
  uid uuid;
  owned_shop_id uuid;
BEGIN
  uid := (event ->> 'user_id')::uuid;
  claims := COALESCE(event -> 'claims', '{}'::jsonb);
  app_meta := COALESCE(claims -> 'app_metadata', '{}'::jsonb);

  SELECT s.id
    INTO owned_shop_id
    FROM public.shops s
   WHERE s.owner_user_id = uid
   LIMIT 1;

  IF owned_shop_id IS NOT NULL THEN
    app_meta := pg_catalog.jsonb_set(
      app_meta,
      '{shop_id}',
      pg_catalog.to_jsonb(owned_shop_id::text),
      true
    );
  ELSE
    app_meta := app_meta - 'shop_id';
  END IF;

  claims := pg_catalog.jsonb_set(claims, '{app_metadata}', app_meta, true);
  RETURN pg_catalog.jsonb_set(event, '{claims}', claims, true);
END;
$$;

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_shop_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_shop_privileged_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_item_invariants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_customer_invariants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Enable Row Level Security on EVERY Table & Apply Strict Privileges
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'shops',
    'used_trial_phones',
    'items',
    'customers',
    'sales',
    'sale_lines',
    'credit_payments',
    'expenses',
    'stock_movements',
    'stock_conflicts',
    'sync_operations',
    'subscription_payments',
    'payment_reference_locks',
    'platform_audit'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC;', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon;', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated;', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role;', tbl);
    END IF;
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_shop_id() TO authenticated, service_role;

-- Read grants for authenticated users (scoped row-by-row via RLS below).
-- Note: payment_reference_locks and used_trial_phones get NO client grants at all.
GRANT SELECT ON
  public.shops,
  public.items,
  public.customers,
  public.sales,
  public.sale_lines,
  public.credit_payments,
  public.expenses,
  public.stock_movements,
  public.stock_conflicts,
  public.sync_operations,
  public.subscription_payments,
  public.platform_audit
TO authenticated;

-- Direct client writes are strictly limited to harmless profile/catalog fields.
-- Stock quantities, customer balances, sales, sale_lines, repayments, expenses,
-- stock movements, conflicts, sync markers, plans, payments, and audits cannot
-- be written directly by clients.
GRANT UPDATE (name, momo_airtel_number, momo_mtn_number, momo_zamtel_number)
  ON public.shops TO authenticated;

GRANT UPDATE (
  name,
  unit_label,
  buying_price_ngwee,
  buying_price_known,
  selling_price_ngwee,
  low_stock_threshold,
  is_deleted
) ON public.items TO authenticated;

GRANT INSERT (shop_id, id, name, phone, notes)
  ON public.customers TO authenticated;

GRANT UPDATE (name, phone, notes)
  ON public.customers TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security Policies (Default Deny, Direct shop_id, Zero Joins)
-- -----------------------------------------------------------------------------

-- shops: owner reads own shop (or platform_admin reads all); owner updates own profile only.
CREATE POLICY shops_select_own_or_admin
  ON public.shops
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR owner_user_id = (SELECT auth.uid())
  );

CREATE POLICY shops_update_profile_own
  ON public.shops
  FOR UPDATE
  TO authenticated
  USING (
    owner_user_id = (SELECT auth.uid())
    AND id = (SELECT public.request_shop_id())
  )
  WITH CHECK (
    owner_user_id = (SELECT auth.uid())
    AND id = (SELECT public.request_shop_id())
  );

-- items: owner or platform_admin reads; owner updates catalog metadata only (quantity via RPC).
CREATE POLICY items_select_own_or_admin
  ON public.items
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY items_update_catalog_own
  ON public.items
  FOR UPDATE
  TO authenticated
  USING (shop_id = (SELECT public.request_shop_id()))
  WITH CHECK (shop_id = (SELECT public.request_shop_id()));

-- customers: owner or platform_admin reads; owner creates zero-balance profile or edits contact fields.
CREATE POLICY customers_select_own_or_admin
  ON public.customers
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY customers_insert_zero_balance_own
  ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    shop_id = (SELECT public.request_shop_id())
    AND total_owed_ngwee = 0
    AND is_demo = false
  );

CREATE POLICY customers_update_profile_own
  ON public.customers
  FOR UPDATE
  TO authenticated
  USING (shop_id = (SELECT public.request_shop_id()))
  WITH CHECK (shop_id = (SELECT public.request_shop_id()));

-- Invariant-bearing shop tables: SELECT only via RLS (mutations via RPC only).
CREATE POLICY sales_select_own_or_admin
  ON public.sales
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY sale_lines_select_own_or_admin
  ON public.sale_lines
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY credit_payments_select_own_or_admin
  ON public.credit_payments
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY expenses_select_own_or_admin
  ON public.expenses
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY stock_movements_select_own_or_admin
  ON public.stock_movements
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY stock_conflicts_select_own_or_admin
  ON public.stock_conflicts
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

CREATE POLICY sync_operations_select_own_or_admin
  ON public.sync_operations
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

-- subscription_payments: shop owner reads own shop's payments; platform_admin reads all; no client writes.
CREATE POLICY subscription_payments_select_own_or_admin
  ON public.subscription_payments
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR shop_id = (SELECT public.request_shop_id())
  );

-- platform_audit: platform_admin reads audit trail; no client writes.
CREATE POLICY platform_audit_select_admin
  ON public.platform_audit
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_platform_admin()));

-- payment_reference_locks & used_trial_phones intentionally have zero client
-- policies (default deny for anon and authenticated; service_role only).
