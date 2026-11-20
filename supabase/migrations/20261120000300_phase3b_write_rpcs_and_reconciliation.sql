-- =============================================================================
-- CountUp Zambia — Phase 3b:
--   * Split SMS budget purpose constraint (otp_registration, otp_signin,
--     pin_reset_notice, recovery_code_notice)
--   * Atomic, idempotent (shop_id, operation_id) shop write RPCs:
--       - public.record_sale
--       - public.undo_sale
--       - public.record_repayment
--       - public.apply_stock_count
--       - public.resolve_stock_conflict
--       - public.upsert_shop_item
--       - public.upsert_shop_customer
--       - public.upsert_shop_expense
--       - public.resolve_sync_conflict
--       - public.apply_sync_batch (subtransaction-isolated batch queue apply)
--   * Server-time plan & 72-hour bounded offline window enforcement
--   * Ledger & stock reconciliation RPC: public.reconcile_shop_ledger
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Expand sms_rate_events.purpose check constraint for split daily SMS budgets
--    and exempt security notice SMS (PIN reset + recovery-code alerts)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sms_rate_events
  DROP CONSTRAINT IF EXISTS sms_rate_events_purpose_check;

ALTER TABLE public.sms_rate_events
  ADD CONSTRAINT sms_rate_events_purpose_check CHECK (
    purpose IN (
      'otp',
      'otp_registration',
      'otp_signin',
      'pin_reset_notice',
      'recovery_code_notice'
    )
  );

CREATE INDEX IF NOT EXISTS idx_sms_rate_events_daily_purpose
  ON public.sms_rate_events (day_utc, purpose)
  WHERE blocked = false;

-- -----------------------------------------------------------------------------
-- 2. Internal authorization + row-lock helper for shop write RPCs
--    Requires a PIN-verified session (`request_shop_id() = p_shop_id` and
--    `shops.owner_user_id = auth.uid()`), or `service_role` in server contexts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_authorized_shop_for_write(p_shop_id uuid)
RETURNS public.shops
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_jwt_role text;
  v_claim_shop_id uuid;
  v_shop public.shops;
BEGIN
  IF p_shop_id IS NULL THEN
    RAISE EXCEPTION 'Shop ID is required.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SHOP_ID';
  END IF;

  v_jwt_role := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    auth.jwt() ->> 'role',
    ''
  );

  IF v_jwt_role <> 'service_role' THEN
    v_uid := auth.uid();
    v_claim_shop_id := public.request_shop_id();

    IF v_uid IS NULL OR v_claim_shop_id IS NULL OR v_claim_shop_id <> p_shop_id THEN
      RAISE EXCEPTION 'Verified shop session is required before writing shop records.'
        USING ERRCODE = '42501', DETAIL = 'SHOP_SESSION_NOT_VERIFIED';
    END IF;
  END IF;

  SELECT s.*
    INTO v_shop
    FROM public.shops s
   WHERE s.id = p_shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop record was not found.'
      USING ERRCODE = 'P0002', DETAIL = 'SHOP_NOT_FOUND';
  END IF;

  IF v_jwt_role <> 'service_role' AND v_shop.owner_user_id <> v_uid THEN
    RAISE EXCEPTION 'You do not have permission to write to this shop.'
      USING ERRCODE = '42501', DETAIL = 'SHOP_OWNER_MISMATCH';
  END IF;

  RETURN v_shop;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. public.record_sale
--    Atomically enforces server-time plan/grace + bounded 72h offline window,
--    inserts sale + sale_lines, clamps stock >= 0, creates shortfall conflict
--    when concurrent/offline sales oversell the last unit, updates customer
--    credit balance, and records `(shop_id, operation_id)` idempotency.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_sale(
  p_shop_id uuid,
  p_operation_id text,
  p_sale_id text,
  p_lines jsonb,
  p_payment_type text,
  p_receipt_number text,
  p_momo_operator text DEFAULT NULL,
  p_customer_id text DEFAULT NULL,
  p_customer_name text DEFAULT NULL,
  p_customer_phone text DEFAULT NULL,
  p_payment_reference text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_local_date text DEFAULT NULL,
  p_cash_tendered_ngwee bigint DEFAULT NULL,
  p_change_given_ngwee bigint DEFAULT NULL,
  p_client_created_at timestamptz DEFAULT NULL,
  p_is_offline_sync boolean DEFAULT false,
  p_offline_window_seconds integer DEFAULT 259200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_sale_id text := pg_catalog.btrim(COALESCE(p_sale_id, ''));
  v_receipt text := pg_catalog.btrim(COALESCE(p_receipt_number, ''));
  v_effective_created_at timestamptz;
  v_flagged boolean := false;
  v_flag_reason text := NULL;
  v_window_secs integer := GREATEST(60, COALESCE(p_offline_window_seconds, 259200));
  v_line_count integer;
  v_items_count integer := 0;
  v_total_amount_ngwee bigint := 0;
  v_total_cost_ngwee bigint := 0;
  v_missing_cost_revenue_ngwee bigint := 0;
  v_profit_ngwee bigint := 0;
  v_customer public.customers;
  v_item public.items;
  v_line record;
  v_prev_qty integer;
  v_next_qty integer;
  v_shortfall integer;
  v_delta integer;
  v_line_total_ngwee bigint;
  v_line_buying_known boolean;
  v_line_buying_ngwee bigint;
  v_movement_id text;
  v_conflict_id text;
  v_conflicts_count integer := 0;
  v_outcome text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  -- Idempotency check BEFORE plan/stock mutations: replaying the same operation
  -- 10 times changes nothing after the first commit.
  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'sale_id', COALESCE(v_existing_op.sale_id, v_sale_id)
    );
  END IF;

  -- Server-time suspension & subscription enforcement
  IF v_shop.is_deactivated OR v_shop.plan_status = 'suspended' THEN
    RAISE EXCEPTION 'New sales are locked because this shop is suspended.'
      USING ERRCODE = '42501', DETAIL = 'SHOP_SUSPENDED';
  END IF;

  IF COALESCE(p_is_offline_sync, false) THEN
    -- If the shop had ALREADY contacted the server after its grace window ended,
    -- it was already expired before going offline: reject new sales.
    IF v_now > v_shop.sales_access_until AND v_shop.last_server_contact_at > v_shop.sales_access_until THEN
      RAISE EXCEPTION 'Subscription and grace period have expired. Renew your plan to record sales.'
        USING ERRCODE = '42501', DETAIL = 'PLAN_EXPIRED';
    END IF;

    IF p_client_created_at IS NULL THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'missing_client_timestamp';
    ELSIF (v_now - v_shop.last_server_contact_at) > pg_catalog.make_interval(secs => v_window_secs) THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'exceeded_bounded_offline_window';
    ELSIF p_client_created_at < (v_shop.last_server_contact_at - interval '10 minutes') THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'client_timestamp_before_last_server_contact';
    ELSIF p_client_created_at > (v_now + interval '10 minutes') THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'client_timestamp_in_future';
    ELSIF p_client_created_at > v_shop.sales_access_until THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'client_timestamp_after_sales_access_until';
    ELSE
      v_effective_created_at := p_client_created_at;
    END IF;
  ELSE
    IF v_now > v_shop.sales_access_until THEN
      RAISE EXCEPTION 'Subscription and grace period have expired. Renew your plan to record sales.'
        USING ERRCODE = '42501', DETAIL = 'PLAN_EXPIRED';
    END IF;

    IF p_client_created_at IS NOT NULL
       AND p_client_created_at >= (v_now - interval '10 minutes')
       AND p_client_created_at <= (v_now + interval '10 minutes')
    THEN
      v_effective_created_at := p_client_created_at;
    ELSE
      v_effective_created_at := v_now;
    END IF;
  END IF;

  IF v_sale_id = '' OR pg_catalog.char_length(v_sale_id) > 128 OR pg_catalog.strpos(v_sale_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sale ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_ID';
  END IF;

  IF v_receipt = '' THEN
    v_receipt := v_sale_id;
  END IF;

  IF p_lines IS NULL OR pg_catalog.jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'A sale must contain between 1 and 160 products.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINES';
  END IF;

  v_line_count := pg_catalog.jsonb_array_length(p_lines);
  IF v_line_count < 1 OR v_line_count > 160 THEN
    RAISE EXCEPTION 'A sale must contain between 1 and 160 products.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINES';
  END IF;

  -- Ensure no duplicate item_id in the same sale
  IF (
    SELECT COUNT(DISTINCT pg_catalog.btrim(elem ->> 'item_id'))
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  ) <> v_line_count THEN
    RAISE EXCEPTION 'A product appears more than once in the cart.'
      USING ERRCODE = '22023', DETAIL = 'DUPLICATE_SALE_ITEM';
  END IF;

  -- Lock all referenced items in deterministic item_id order to prevent deadlocks
  FOR v_item IN
    SELECT i.*
      FROM public.items i
     WHERE i.shop_id = p_shop_id
       AND i.id IN (
         SELECT pg_catalog.btrim(elem ->> 'item_id')
           FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
       )
     ORDER BY i.id
     FOR UPDATE
  LOOP
    NULL;
  END LOOP;

  -- Validate every line & compute integer ngwee totals
  FOR v_line IN
    SELECT
      (ord - 1)::integer AS idx,
      pg_catalog.btrim(COALESCE(elem ->> 'item_id', '')) AS item_id,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'item_name', '')), '') AS item_name,
      COALESCE(elem ->> 'unit_label', '') AS unit_label,
      (elem ->> 'quantity')::integer AS quantity,
      (elem ->> 'selling_price_ngwee')::bigint AS selling_price_ngwee,
      COALESCE((elem ->> 'buying_price_ngwee')::bigint, 0) AS buying_price_ngwee,
      COALESCE((elem ->> 'buying_price_known')::boolean, true) AS buying_price_known
    FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS t(elem, ord)
    ORDER BY ord
  LOOP
    SELECT i.*
      INTO v_item
      FROM public.items i
     WHERE i.shop_id = p_shop_id
       AND i.id = v_line.item_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product "%" is no longer in your stock book.', v_line.item_id
        USING ERRCODE = 'P0002', DETAIL = 'ITEM_NOT_FOUND';
    END IF;

    IF v_line.quantity IS NULL OR v_line.quantity <= 0 THEN
      RAISE EXCEPTION 'Sale line quantity must be a positive whole number.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_QUANTITY';
    END IF;

    IF v_line.selling_price_ngwee IS NULL OR v_line.selling_price_ngwee <= 0 THEN
      RAISE EXCEPTION 'Sale line selling price must be positive.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_PRICE';
    END IF;

    v_line_buying_known := v_line.buying_price_known;
    v_line_buying_ngwee := CASE WHEN v_line_buying_known THEN GREATEST(0, v_line.buying_price_ngwee) ELSE 0 END;
    v_line_total_ngwee := v_line.selling_price_ngwee * v_line.quantity;

    v_items_count := v_items_count + v_line.quantity;
    v_total_amount_ngwee := v_total_amount_ngwee + v_line_total_ngwee;

    IF v_line_buying_known THEN
      v_total_cost_ngwee := v_total_cost_ngwee + (v_line_buying_ngwee * v_line.quantity);
    ELSE
      v_missing_cost_revenue_ngwee := v_missing_cost_revenue_ngwee + v_line_total_ngwee;
    END IF;
  END LOOP;

  v_profit_ngwee := v_total_amount_ngwee - v_total_cost_ngwee - v_missing_cost_revenue_ngwee;

  -- Lock & validate credit customer before inserting sale
  IF p_payment_type = 'credit' THEN
    IF p_customer_id IS NULL OR pg_catalog.btrim(p_customer_id) = '' THEN
      RAISE EXCEPTION 'Choose a customer for a credit sale.'
        USING ERRCODE = '22023', DETAIL = 'CREDIT_CUSTOMER_REQUIRED';
    END IF;

    SELECT c.*
      INTO v_customer
      FROM public.customers c
     WHERE c.shop_id = p_shop_id
       AND c.id = pg_catalog.btrim(p_customer_id)
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The customer for this credit sale does not exist.'
        USING ERRCODE = 'P0002', DETAIL = 'CUSTOMER_NOT_FOUND';
    END IF;
  END IF;

  -- Insert sale header first (satisfies sale_lines and stock_movements FKs)
  INSERT INTO public.sales (
    shop_id,
    id,
    items_count,
    total_amount_ngwee,
    total_cost_ngwee,
    profit_ngwee,
    missing_cost_revenue_ngwee,
    payment_type,
    momo_operator,
    customer_id,
    customer_name,
    customer_phone,
    receipt_number,
    payment_reference,
    note,
    local_date,
    cash_tendered_ngwee,
    change_given_ngwee,
    is_deleted,
    is_demo,
    is_offline_sync,
    offline_window_flagged,
    offline_flag_reason,
    client_created_at,
    created_at
  ) VALUES (
    p_shop_id,
    v_sale_id,
    v_items_count,
    v_total_amount_ngwee,
    v_total_cost_ngwee,
    v_profit_ngwee,
    v_missing_cost_revenue_ngwee,
    p_payment_type,
    NULLIF(pg_catalog.btrim(COALESCE(p_momo_operator, '')), ''),
    CASE WHEN p_payment_type = 'credit' THEN v_customer.id ELSE NULLIF(pg_catalog.btrim(COALESCE(p_customer_id, '')), '') END,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_customer_name, '')), ''), v_customer.name),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_customer_phone, '')), ''), NULLIF(v_customer.phone, '')),
    v_receipt,
    NULLIF(pg_catalog.btrim(COALESCE(p_payment_reference, '')), ''),
    NULLIF(COALESCE(p_note, ''), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_local_date, '')), ''),
    p_cash_tendered_ngwee,
    CASE
      WHEN p_cash_tendered_ngwee IS NOT NULL THEN COALESCE(p_change_given_ngwee, p_cash_tendered_ngwee - v_total_amount_ngwee)
      ELSE NULL
    END,
    false,
    false,
    COALESCE(p_is_offline_sync, false),
    v_flagged,
    v_flag_reason,
    p_client_created_at,
    v_effective_created_at
  );

  -- Insert sale_lines, deduct stock (never below 0), write stock_movements & stock_conflicts
  FOR v_line IN
    SELECT
      (ord - 1)::integer AS idx,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'line_id', '')), '') AS line_id,
      pg_catalog.btrim(elem ->> 'item_id') AS item_id,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'item_name', '')), '') AS item_name,
      COALESCE(elem ->> 'unit_label', '') AS unit_label,
      (elem ->> 'quantity')::integer AS quantity,
      (elem ->> 'selling_price_ngwee')::bigint AS selling_price_ngwee,
      COALESCE((elem ->> 'buying_price_ngwee')::bigint, 0) AS buying_price_ngwee,
      COALESCE((elem ->> 'buying_price_known')::boolean, true) AS buying_price_known,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'movement_id', '')), '') AS movement_id,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'reason', '')), '') AS reason
    FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS t(elem, ord)
    ORDER BY ord
  LOOP
    SELECT i.*
      INTO v_item
      FROM public.items i
     WHERE i.shop_id = p_shop_id
       AND i.id = v_line.item_id;

    v_line_buying_known := v_line.buying_price_known;
    v_line_buying_ngwee := CASE WHEN v_line_buying_known THEN GREATEST(0, v_line.buying_price_ngwee) ELSE 0 END;
    v_line_total_ngwee := v_line.selling_price_ngwee * v_line.quantity;

    INSERT INTO public.sale_lines (
      shop_id,
      id,
      sale_id,
      line_index,
      item_id,
      item_name,
      unit_label,
      quantity,
      buying_price_ngwee,
      buying_price_known,
      selling_price_ngwee,
      line_total_ngwee,
      created_at
    ) VALUES (
      p_shop_id,
      COALESCE(v_line.line_id, v_sale_id || ':' || v_line.idx::text),
      v_sale_id,
      v_line.idx,
      v_item.id,
      COALESCE(v_line.item_name, v_item.name),
      COALESCE(v_line.unit_label, v_item.unit_label),
      v_line.quantity,
      v_line_buying_ngwee,
      v_line_buying_known,
      v_line.selling_price_ngwee,
      v_line_total_ngwee,
      v_effective_created_at
    );

    v_prev_qty := v_item.quantity;
    v_next_qty := GREATEST(0, v_prev_qty - v_line.quantity);
    v_shortfall := GREATEST(0, v_line.quantity - v_prev_qty);
    v_delta := v_next_qty - v_prev_qty;

    UPDATE public.items
       SET quantity = v_next_qty,
           last_sold_at = GREATEST(COALESCE(last_sold_at, v_effective_created_at), v_effective_created_at)
     WHERE shop_id = p_shop_id
       AND id = v_item.id;

    v_movement_id := COALESCE(v_line.movement_id, 'mv_' || v_op_id || '_' || v_line.idx::text);
    IF pg_catalog.char_length(v_movement_id) > 128 THEN
      v_movement_id := 'mv_' || pg_catalog.md5(v_op_id || ':' || v_line.idx::text);
    END IF;

    INSERT INTO public.stock_movements (
      shop_id,
      id,
      item_id,
      item_name,
      type,
      delta,
      previous_quantity,
      new_quantity,
      reason,
      related_sale_id,
      requested_quantity,
      recount_needed,
      created_at
    ) VALUES (
      p_shop_id,
      v_movement_id,
      v_item.id,
      COALESCE(v_line.item_name, v_item.name),
      'sale',
      v_delta,
      v_prev_qty,
      v_next_qty,
      CASE
        WHEN v_shortfall > 0 THEN
          COALESCE(v_line.reason, 'Sale ' || v_receipt) || ' (stock conflict: recount needed)'
        ELSE
          COALESCE(v_line.reason, 'Sale ' || v_receipt)
      END,
      v_sale_id,
      CASE WHEN v_shortfall > 0 THEN v_line.quantity ELSE NULL END,
      (v_shortfall > 0),
      v_effective_created_at
    );

    IF v_shortfall > 0 THEN
      v_conflict_id := v_op_id || '_' || v_line.idx::text;
      IF pg_catalog.char_length(v_conflict_id) > 160 THEN
        v_conflict_id := 'sc_' || pg_catalog.md5(v_op_id || ':' || v_line.idx::text);
      END IF;

      INSERT INTO public.stock_conflicts (
        shop_id,
        id,
        item_id,
        item_name,
        kind,
        observed,
        requested,
        available,
        shortfall,
        related_sale_id,
        resolved,
        created_at
      ) VALUES (
        p_shop_id,
        v_conflict_id,
        v_item.id,
        COALESCE(v_line.item_name, v_item.name),
        'shortfall',
        NULL,
        v_line.quantity,
        v_prev_qty,
        v_shortfall,
        v_sale_id,
        false,
        v_now
      );

      v_conflicts_count := v_conflicts_count + 1;
    END IF;
  END LOOP;

  -- Apply credit sale balance to customer
  IF p_payment_type = 'credit' THEN
    UPDATE public.customers
       SET total_owed_ngwee = total_owed_ngwee + v_total_amount_ngwee
     WHERE shop_id = p_shop_id
       AND id = v_customer.id;
  END IF;

  -- Advance shop server-contact watermark
  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  v_outcome := CASE WHEN v_flagged THEN 'flagged' ELSE 'applied' END;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    sale_id,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'sale',
    v_outcome,
    v_sale_id,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', v_outcome,
    'sale_id', v_sale_id,
    'total_amount_ngwee', v_total_amount_ngwee,
    'profit_ngwee', v_profit_ngwee,
    'stock_conflicts_created', v_conflicts_count,
    'offline_window_flagged', v_flagged,
    'offline_flag_reason', v_flag_reason
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. public.undo_sale
--    Safely handles:
--      - 10x replay of same operation_id (idempotent no-op)
--      - Undo twice from two different devices (`outcome = 'already-voided'`,
--        zero duplicate stock restoration or credit deduction)
--      - Undo a sale that never reached the server (`P0002`, `SALE_NOT_FOUND`)
--      - Undo a credit sale whose customer already repaid below sale amount
--        (`23514`, `CREDIT_BALANCE_CONFLICT`)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.undo_sale(
  p_shop_id uuid,
  p_operation_id text,
  p_sale_id text,
  p_movements jsonb DEFAULT NULL,
  p_expected_checks jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_sale public.sales;
  v_customer public.customers;
  v_item public.items;
  v_line public.sale_lines;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_sale_id text := pg_catalog.btrim(COALESCE(p_sale_id, ''));
  v_sale_movement_delta integer;
  v_restore_qty integer;
  v_prev_qty integer;
  v_next_qty integer;
  v_movement_id text;
  v_custom_movement_id text;
  v_custom_reason text;
  v_expected_credit boolean;
  v_expected_customer_id text;
  v_expected_credit_delta bigint;
  v_chk record;
  v_matched_line_qty integer;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'has_resolution', v_existing_op.has_resolution,
      'sale_id', COALESCE(v_existing_op.sale_id, v_sale_id)
    );
  END IF;

  SELECT s.*
    INTO v_sale
    FROM public.sales s
   WHERE s.shop_id = p_shop_id
     AND s.id = v_sale_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The sale needed by this undo no longer exists.'
      USING ERRCODE = 'P0002', DETAIL = 'SALE_NOT_FOUND';
  END IF;

  -- Second undo from another device: acknowledge safely without restoring stock
  -- or subtracting customer credit a second time.
  IF v_sale.is_deleted THEN
    UPDATE public.shops
       SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
     WHERE id = p_shop_id;

    INSERT INTO public.sync_operations (
      shop_id,
      operation_id,
      operation_type,
      outcome,
      sale_id,
      applied_at
    ) VALUES (
      p_shop_id,
      v_op_id,
      'void_sale',
      'already-voided',
      v_sale_id,
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_voided',
      'idempotent', false,
      'outcome', 'already-voided',
      'sale_id', v_sale_id
    );
  END IF;

  -- Optional client queue consistency checks against authoritative server sale
  IF p_expected_checks IS NOT NULL AND pg_catalog.jsonb_typeof(p_expected_checks) = 'object' THEN
    v_expected_credit := COALESCE((p_expected_checks ->> 'has_credit_adjustment')::boolean, false);
    v_expected_customer_id := NULLIF(pg_catalog.btrim(COALESCE(p_expected_checks ->> 'customer_id', '')), '');
    v_expected_credit_delta := CASE
      WHEN pg_catalog.jsonb_typeof(p_expected_checks -> 'credit_delta_ngwee') = 'number'
        THEN (p_expected_checks ->> 'credit_delta_ngwee')::bigint
      ELSE NULL
    END;

    IF (
      v_sale.payment_type = 'credit'
      AND (
        NOT v_expected_credit
        OR v_expected_customer_id IS DISTINCT FROM v_sale.customer_id
        OR v_expected_credit_delta IS DISTINCT FROM (-v_sale.total_amount_ngwee)
      )
    ) OR (
      v_sale.payment_type <> 'credit' AND v_expected_credit
    ) THEN
      RAISE EXCEPTION 'The sale or its customer changed; this undo needs manual review.'
        USING ERRCODE = '22023', DETAIL = 'UNDO_SALE_CHANGED';
    END IF;

    IF pg_catalog.jsonb_typeof(p_expected_checks -> 'stock_deltas') = 'array' THEN
      FOR v_chk IN
        SELECT
          pg_catalog.btrim(COALESCE(elem ->> 'item_id', '')) AS item_id,
          (elem ->> 'delta')::integer AS delta
        FROM pg_catalog.jsonb_array_elements(p_expected_checks -> 'stock_deltas') AS t(elem)
      LOOP
        SELECT sl.quantity
          INTO v_matched_line_qty
          FROM public.sale_lines sl
         WHERE sl.shop_id = p_shop_id
           AND sl.sale_id = v_sale_id
           AND sl.item_id = v_chk.item_id
         LIMIT 1;

        IF NOT FOUND OR v_matched_line_qty IS DISTINCT FROM v_chk.delta THEN
          RAISE EXCEPTION 'The sale items changed; this undo needs manual review.'
            USING ERRCODE = '22023', DETAIL = 'UNDO_SALE_ITEMS_CHANGED';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM public.items i WHERE i.shop_id = p_shop_id AND i.id = v_chk.item_id
        ) THEN
          RAISE EXCEPTION 'A stock item or customer needed by this entry no longer exists.'
            USING ERRCODE = 'P0002', DETAIL = 'ITEM_NOT_FOUND';
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- If credit sale, verify customer exists and still owes at least the sale total
  IF v_sale.payment_type = 'credit' THEN
    SELECT c.*
      INTO v_customer
      FROM public.customers c
     WHERE c.shop_id = p_shop_id
       AND c.id = v_sale.customer_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The customer for this credit sale is missing; the sale cannot be undone.'
        USING ERRCODE = 'P0002', DETAIL = 'CUSTOMER_NOT_FOUND';
    END IF;

    IF v_customer.total_owed_ngwee < v_sale.total_amount_ngwee THEN
      RAISE EXCEPTION 'This sale undo conflicts with a newer customer balance and needs review.'
        USING ERRCODE = '23514', DETAIL = 'CREDIT_BALANCE_CONFLICT';
    END IF;

    UPDATE public.customers
       SET total_owed_ngwee = total_owed_ngwee - v_sale.total_amount_ngwee
     WHERE shop_id = p_shop_id
       AND id = v_customer.id;
  END IF;

  UPDATE public.sales
     SET is_deleted = true
   WHERE shop_id = p_shop_id
     AND id = v_sale_id;

  -- Restore exact physical units deducted by the sale (handling oversold sales
  -- where actual deducted stock was < requested quantity)
  FOR v_line IN
    SELECT sl.*
      FROM public.sale_lines sl
     WHERE sl.shop_id = p_shop_id
       AND sl.sale_id = v_sale_id
     ORDER BY sl.line_index ASC, sl.id ASC
  LOOP
    SELECT i.*
      INTO v_item
      FROM public.items i
     WHERE i.shop_id = p_shop_id
       AND i.id = v_line.item_id
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT sm.delta
      INTO v_sale_movement_delta
      FROM public.stock_movements sm
     WHERE sm.shop_id = p_shop_id
       AND sm.related_sale_id = v_sale_id
       AND sm.item_id = v_line.item_id
       AND sm.type = 'sale'
     ORDER BY sm.created_at ASC
     LIMIT 1;

    IF FOUND THEN
      v_restore_qty := GREATEST(0, -v_sale_movement_delta);
    ELSE
      v_restore_qty := v_line.quantity;
    END IF;

    v_prev_qty := v_item.quantity;
    v_next_qty := v_prev_qty + v_restore_qty;

    UPDATE public.items
       SET quantity = v_next_qty
     WHERE shop_id = p_shop_id
       AND id = v_item.id;

    v_custom_movement_id := NULL;
    v_custom_reason := NULL;
    IF p_movements IS NOT NULL AND pg_catalog.jsonb_typeof(p_movements) = 'array' THEN
      SELECT
        NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'movement_id', '')), ''),
        NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'reason', '')), '')
        INTO v_custom_movement_id, v_custom_reason
        FROM pg_catalog.jsonb_array_elements(p_movements) AS t(elem)
       WHERE pg_catalog.btrim(COALESCE(elem ->> 'item_id', '')) = v_item.id
       LIMIT 1;
    END IF;

    v_movement_id := COALESCE(v_custom_movement_id, 'void_' || v_op_id || '_' || v_line.line_index::text);
    IF pg_catalog.char_length(v_movement_id) > 128 THEN
      v_movement_id := 'void_' || pg_catalog.md5(v_op_id || ':' || v_line.line_index::text);
    END IF;

    INSERT INTO public.stock_movements (
      shop_id,
      id,
      item_id,
      item_name,
      type,
      delta,
      previous_quantity,
      new_quantity,
      reason,
      related_sale_id,
      created_at
    ) VALUES (
      p_shop_id,
      v_movement_id,
      v_item.id,
      v_item.name,
      'void',
      v_restore_qty,
      v_prev_qty,
      v_next_qty,
      COALESCE(v_custom_reason, 'Undo sale ' || v_sale.receipt_number),
      v_sale_id,
      v_now
    );
  END LOOP;

  -- Any open stock shortfall raised solely by this undone sale is no longer active
  UPDATE public.stock_conflicts
     SET resolved = true
   WHERE shop_id = p_shop_id
     AND related_sale_id = v_sale_id
     AND resolved = false;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    sale_id,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'void_sale',
    'applied',
    v_sale_id,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'sale_id', v_sale_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. public.record_repayment
--    Atomically applies a customer repayment in integer ngwee, rejecting
--    overpayments (`amount_ngwee > total_owed_ngwee`) with `CREDIT_BALANCE_CONFLICT`
--    so the client SyncReviewDialog can offer adjust-to-remaining-balance or cancel.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_repayment(
  p_shop_id uuid,
  p_operation_id text,
  p_payment_id text,
  p_customer_id text,
  p_amount_ngwee bigint,
  p_payment_method text DEFAULT 'cash',
  p_note text DEFAULT '',
  p_local_date text DEFAULT NULL,
  p_created_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_customer public.customers;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_payment_id text := pg_catalog.btrim(COALESCE(p_payment_id, ''));
  v_customer_id text := pg_catalog.btrim(COALESCE(p_customer_id, ''));
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'has_resolution', v_existing_op.has_resolution,
      'payment_id', v_payment_id
    );
  END IF;

  IF v_payment_id = '' OR pg_catalog.char_length(v_payment_id) > 128 OR pg_catalog.strpos(v_payment_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid repayment ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_ID';
  END IF;

  IF p_amount_ngwee IS NULL OR p_amount_ngwee <= 0 THEN
    RAISE EXCEPTION 'Enter a valid repayment amount.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_REPAYMENT_AMOUNT';
  END IF;

  SELECT c.*
    INTO v_customer
    FROM public.customers c
   WHERE c.shop_id = p_shop_id
     AND c.id = v_customer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The customer for this repayment no longer exists.'
      USING ERRCODE = 'P0002', DETAIL = 'CUSTOMER_NOT_FOUND';
  END IF;

  IF p_amount_ngwee > v_customer.total_owed_ngwee THEN
    RAISE EXCEPTION 'This repayment conflicts with a newer customer balance and needs review.'
      USING ERRCODE = '23514', DETAIL = 'CREDIT_BALANCE_CONFLICT';
  END IF;

  INSERT INTO public.credit_payments (
    shop_id,
    id,
    customer_id,
    customer_name,
    amount_ngwee,
    payment_method,
    note,
    local_date,
    created_at
  ) VALUES (
    p_shop_id,
    v_payment_id,
    v_customer.id,
    v_customer.name,
    p_amount_ngwee,
    COALESCE(NULLIF(pg_catalog.btrim(p_payment_method), ''), 'cash'),
    COALESCE(p_note, ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_local_date, '')), ''),
    COALESCE(p_created_at, v_now)
  );

  UPDATE public.customers
     SET total_owed_ngwee = total_owed_ngwee - p_amount_ngwee
   WHERE shop_id = p_shop_id
     AND id = v_customer.id;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'payment',
    'applied',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'payment_id', v_payment_id,
    'remaining_owed_ngwee', v_customer.total_owed_ngwee - p_amount_ngwee
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. public.apply_stock_count
--    Atomically applies either:
--      - `p_mode = 'set'`: physical stock count (if `p_observed_quantity` differs
--        from current server stock, preserves server stock and logs a `recount`
--        stock_conflict instead of silently overwriting newer sales!)
--      - `p_mode = 'delta'`: relative restock/subtraction (clamps at 0 and logs
--        a `shortfall` stock_conflict if subtraction exceeds on-hand stock)
--    Also applies optional catalog metadata edits in the same transaction.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_stock_count(
  p_shop_id uuid,
  p_operation_id text,
  p_item_id text,
  p_mode text,
  p_quantity integer,
  p_observed_quantity integer DEFAULT NULL,
  p_movement_id text DEFAULT NULL,
  p_movement_type text DEFAULT 'adjustment',
  p_reason text DEFAULT 'Stock adjustment',
  p_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_item public.items;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_item_id text := pg_catalog.btrim(COALESCE(p_item_id, ''));
  v_mode text := pg_catalog.btrim(COALESCE(p_mode, ''));
  v_prev_qty integer;
  v_next_qty integer;
  v_delta integer;
  v_shortfall integer := 0;
  v_stale_set boolean := false;
  v_recount_needed boolean := false;
  v_requested_qty integer := NULL;
  v_movement_id text;
  v_conflict_id text;
  v_effective_name text;
  v_effective_unit text;
  v_effective_buying_known boolean;
  v_effective_buying_ngwee bigint;
  v_effective_selling_ngwee bigint;
  v_effective_threshold integer;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'item_id', v_item_id
    );
  END IF;

  IF v_mode NOT IN ('set', 'delta') OR p_quantity IS NULL THEN
    RAISE EXCEPTION 'Stock count mode must be set or delta with an integer quantity.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_STOCK_COUNT_MODE';
  END IF;

  SELECT i.*
    INTO v_item
    FROM public.items i
   WHERE i.shop_id = p_shop_id
     AND i.id = v_item_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That product is no longer in your stock book.'
      USING ERRCODE = 'P0002', DETAIL = 'ITEM_NOT_FOUND';
  END IF;

  v_effective_name := v_item.name;
  v_effective_unit := v_item.unit_label;
  v_effective_buying_known := v_item.buying_price_known;
  v_effective_buying_ngwee := v_item.buying_price_ngwee;
  v_effective_selling_ngwee := v_item.selling_price_ngwee;
  v_effective_threshold := v_item.low_stock_threshold;

  IF p_metadata IS NOT NULL AND pg_catalog.jsonb_typeof(p_metadata) = 'object' THEN
    IF p_metadata ? 'name' AND NULLIF(pg_catalog.btrim(p_metadata ->> 'name'), '') IS NOT NULL THEN
      v_effective_name := pg_catalog.btrim(p_metadata ->> 'name');
    END IF;
    IF p_metadata ? 'unit_label' THEN
      v_effective_unit := COALESCE(p_metadata ->> 'unit_label', '');
    END IF;
    IF p_metadata ? 'buying_price_known' AND pg_catalog.jsonb_typeof(p_metadata -> 'buying_price_known') = 'boolean' THEN
      v_effective_buying_known := (p_metadata ->> 'buying_price_known')::boolean;
    END IF;
    IF p_metadata ? 'buying_price_ngwee' AND pg_catalog.jsonb_typeof(p_metadata -> 'buying_price_ngwee') = 'number' THEN
      v_effective_buying_ngwee := GREATEST(0, (p_metadata ->> 'buying_price_ngwee')::bigint);
    END IF;
    IF NOT v_effective_buying_known THEN
      v_effective_buying_ngwee := 0;
    END IF;
    IF p_metadata ? 'selling_price_ngwee' AND pg_catalog.jsonb_typeof(p_metadata -> 'selling_price_ngwee') = 'number' THEN
      v_effective_selling_ngwee := (p_metadata ->> 'selling_price_ngwee')::bigint;
    END IF;
    IF p_metadata ? 'low_stock_threshold' AND pg_catalog.jsonb_typeof(p_metadata -> 'low_stock_threshold') = 'number' THEN
      v_effective_threshold := GREATEST(0, (p_metadata ->> 'low_stock_threshold')::integer);
    END IF;
  END IF;

  v_prev_qty := v_item.quantity;

  IF v_mode = 'set' THEN
    IF p_quantity < 0 THEN
      RAISE EXCEPTION 'Physical stock count cannot be negative.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_QUANTITY';
    END IF;

    IF p_observed_quantity IS NOT NULL AND p_observed_quantity <> v_prev_qty THEN
      v_stale_set := true;
      v_next_qty := v_prev_qty;
      v_delta := 0;
      v_recount_needed := true;
      v_requested_qty := p_quantity;
    ELSE
      v_next_qty := p_quantity;
      v_delta := v_next_qty - v_prev_qty;
    END IF;
  ELSE
    IF v_prev_qty + p_quantity < 0 THEN
      v_next_qty := 0;
      v_delta := -v_prev_qty;
      v_shortfall := -(v_prev_qty + p_quantity);
      v_recount_needed := true;
      v_requested_qty := -p_quantity;
    ELSE
      v_next_qty := v_prev_qty + p_quantity;
      v_delta := p_quantity;
    END IF;
  END IF;

  UPDATE public.items
     SET name = v_effective_name,
         unit_label = v_effective_unit,
         buying_price_known = v_effective_buying_known,
         buying_price_ngwee = v_effective_buying_ngwee,
         selling_price_ngwee = v_effective_selling_ngwee,
         low_stock_threshold = v_effective_threshold,
         quantity = v_next_qty
   WHERE shop_id = p_shop_id
     AND id = v_item.id;

  v_movement_id := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_movement_id, '')), ''), 'scmv_' || v_op_id);
  IF pg_catalog.char_length(v_movement_id) > 128 THEN
    v_movement_id := 'scmv_' || pg_catalog.md5(v_op_id);
  END IF;

  INSERT INTO public.stock_movements (
    shop_id,
    id,
    item_id,
    item_name,
    type,
    delta,
    previous_quantity,
    new_quantity,
    reason,
    requested_quantity,
    recount_needed,
    created_at
  ) VALUES (
    p_shop_id,
    v_movement_id,
    v_item.id,
    v_effective_name,
    CASE
      WHEN p_movement_type IN ('restock', 'adjustment') THEN p_movement_type
      ELSE 'adjustment'
    END,
    v_delta,
    v_prev_qty,
    v_next_qty,
    CASE
      WHEN v_stale_set THEN COALESCE(NULLIF(pg_catalog.btrim(p_reason), ''), 'Stock adjustment') || ' (count not applied: stock changed on another device)'
      WHEN v_shortfall > 0 THEN COALESCE(NULLIF(pg_catalog.btrim(p_reason), ''), 'Stock adjustment') || ' (stock conflict: recount needed)'
      ELSE COALESCE(NULLIF(pg_catalog.btrim(p_reason), ''), 'Stock adjustment')
    END,
    v_requested_qty,
    v_recount_needed,
    v_now
  );

  IF v_stale_set OR v_shortfall > 0 THEN
    v_conflict_id := v_op_id || '_0';
    IF pg_catalog.char_length(v_conflict_id) > 160 THEN
      v_conflict_id := 'sc_' || pg_catalog.md5(v_op_id);
    END IF;

    INSERT INTO public.stock_conflicts (
      shop_id,
      id,
      item_id,
      item_name,
      kind,
      observed,
      requested,
      available,
      shortfall,
      related_sale_id,
      resolved,
      created_at
    ) VALUES (
      p_shop_id,
      v_conflict_id,
      v_item.id,
      v_effective_name,
      CASE WHEN v_stale_set THEN 'recount' ELSE 'shortfall' END,
      CASE WHEN v_stale_set THEN p_observed_quantity ELSE NULL END,
      COALESCE(v_requested_qty, 0),
      v_prev_qty,
      CASE WHEN v_stale_set THEN 0 ELSE v_shortfall END,
      NULL,
      false,
      v_now
    );
  END IF;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'stock_update',
    'applied',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'item_id', v_item.id,
    'new_quantity', v_next_qty,
    'conflict_created', (v_stale_set OR v_shortfall > 0)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. public.resolve_stock_conflict
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_stock_conflict(
  p_shop_id uuid,
  p_operation_id text,
  p_conflict_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_conflict_id text := pg_catalog.btrim(COALESCE(p_conflict_id, ''));
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'conflict_id', v_conflict_id
    );
  END IF;

  UPDATE public.stock_conflicts
     SET resolved = true
   WHERE shop_id = p_shop_id
     AND id = v_conflict_id;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'conflict_resolution',
    'resolved',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'resolved',
    'conflict_id', v_conflict_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Supporting Queue Write RPCs:
--    public.upsert_shop_item, public.upsert_shop_customer,
--    public.upsert_shop_expense, public.resolve_sync_conflict
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_shop_item(
  p_shop_id uuid,
  p_operation_id text,
  p_item_id text,
  p_patch jsonb,
  p_initial_movement jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_existing_item public.items;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_item_id text := pg_catalog.btrim(COALESCE(p_item_id, ''));
  v_name text;
  v_unit text;
  v_buying_known boolean;
  v_buying_ngwee bigint;
  v_selling_ngwee bigint;
  v_initial_qty integer;
  v_threshold integer;
  v_is_deleted boolean;
  v_movement_id text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'item_id', v_item_id
    );
  END IF;

  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Item payload is required.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_PAYLOAD';
  END IF;

  SELECT i.*
    INTO v_existing_item
    FROM public.items i
   WHERE i.shop_id = p_shop_id
     AND i.id = v_item_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Brand-new item creation + mandatory initial stock movement for ledger reconciliation
    v_name := pg_catalog.btrim(COALESCE(p_patch ->> 'name', ''));
    v_unit := COALESCE(p_patch ->> 'unit_label', '');
    v_buying_known := COALESCE((p_patch ->> 'buying_price_known')::boolean, true);
    v_buying_ngwee := CASE WHEN v_buying_known THEN GREATEST(0, COALESCE((p_patch ->> 'buying_price_ngwee')::bigint, 0)) ELSE 0 END;
    v_selling_ngwee := (p_patch ->> 'selling_price_ngwee')::bigint;
    v_initial_qty := GREATEST(0, COALESCE((p_patch ->> 'quantity')::integer, 0));
    v_threshold := GREATEST(0, COALESCE((p_patch ->> 'low_stock_threshold')::integer, 5));
    v_is_deleted := COALESCE((p_patch ->> 'is_deleted')::boolean, false);

    INSERT INTO public.items (
      shop_id,
      id,
      name,
      buying_price_ngwee,
      buying_price_known,
      selling_price_ngwee,
      unit_label,
      quantity,
      low_stock_threshold,
      is_deleted,
      created_at
    ) VALUES (
      p_shop_id,
      v_item_id,
      v_name,
      v_buying_ngwee,
      v_buying_known,
      v_selling_ngwee,
      v_unit,
      v_initial_qty,
      v_threshold,
      v_is_deleted,
      COALESCE((p_patch ->> 'created_at')::timestamptz, v_now)
    );

    v_movement_id := COALESCE(
      NULLIF(pg_catalog.btrim(COALESCE(p_initial_movement ->> 'id', '')), ''),
      'init_' || v_op_id
    );
    IF pg_catalog.char_length(v_movement_id) > 128 THEN
      v_movement_id := 'init_' || pg_catalog.md5(v_op_id);
    END IF;

    INSERT INTO public.stock_movements (
      shop_id,
      id,
      item_id,
      item_name,
      type,
      delta,
      previous_quantity,
      new_quantity,
      reason,
      created_at
    ) VALUES (
      p_shop_id,
      v_movement_id,
      v_item_id,
      v_name,
      'initial',
      v_initial_qty,
      0,
      v_initial_qty,
      COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_initial_movement ->> 'reason', '')), ''), 'Initial stock'),
      COALESCE((p_initial_movement ->> 'created_at')::timestamptz, v_now)
    );
  ELSE
    -- Existing item catalog metadata / archive update (never mutates quantity directly)
    v_name := CASE
      WHEN p_patch ? 'name' AND NULLIF(pg_catalog.btrim(p_patch ->> 'name'), '') IS NOT NULL
        THEN pg_catalog.btrim(p_patch ->> 'name')
      ELSE v_existing_item.name
    END;
    v_unit := CASE
      WHEN p_patch ? 'unit_label' THEN COALESCE(p_patch ->> 'unit_label', '')
      ELSE v_existing_item.unit_label
    END;
    v_buying_known := CASE
      WHEN p_patch ? 'buying_price_known' AND pg_catalog.jsonb_typeof(p_patch -> 'buying_price_known') = 'boolean'
        THEN (p_patch ->> 'buying_price_known')::boolean
      ELSE v_existing_item.buying_price_known
    END;
    v_buying_ngwee := CASE
      WHEN NOT v_buying_known THEN 0
      WHEN p_patch ? 'buying_price_ngwee' AND pg_catalog.jsonb_typeof(p_patch -> 'buying_price_ngwee') = 'number'
        THEN GREATEST(0, (p_patch ->> 'buying_price_ngwee')::bigint)
      ELSE v_existing_item.buying_price_ngwee
    END;
    v_selling_ngwee := CASE
      WHEN p_patch ? 'selling_price_ngwee' AND pg_catalog.jsonb_typeof(p_patch -> 'selling_price_ngwee') = 'number'
        THEN (p_patch ->> 'selling_price_ngwee')::bigint
      ELSE v_existing_item.selling_price_ngwee
    END;
    v_threshold := CASE
      WHEN p_patch ? 'low_stock_threshold' AND pg_catalog.jsonb_typeof(p_patch -> 'low_stock_threshold') = 'number'
        THEN GREATEST(0, (p_patch ->> 'low_stock_threshold')::integer)
      ELSE v_existing_item.low_stock_threshold
    END;
    v_is_deleted := CASE
      WHEN p_patch ? 'is_deleted' AND pg_catalog.jsonb_typeof(p_patch -> 'is_deleted') = 'boolean'
        THEN (p_patch ->> 'is_deleted')::boolean
      ELSE v_existing_item.is_deleted
    END;

    UPDATE public.items
       SET name = v_name,
           unit_label = v_unit,
           buying_price_known = v_buying_known,
           buying_price_ngwee = v_buying_ngwee,
           selling_price_ngwee = v_selling_ngwee,
           low_stock_threshold = v_threshold,
           is_deleted = v_is_deleted
     WHERE shop_id = p_shop_id
       AND id = v_item_id;
  END IF;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'item',
    'applied',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'item_id', v_item_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_shop_customer(
  p_shop_id uuid,
  p_operation_id text,
  p_customer_id text,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_existing_customer public.customers;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_customer_id text := pg_catalog.btrim(COALESCE(p_customer_id, ''));
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'customer_id', v_customer_id
    );
  END IF;

  SELECT c.*
    INTO v_existing_customer
    FROM public.customers c
   WHERE c.shop_id = p_shop_id
     AND c.id = v_customer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.customers (
      shop_id,
      id,
      name,
      phone,
      notes,
      total_owed_ngwee,
      created_at
    ) VALUES (
      p_shop_id,
      v_customer_id,
      pg_catalog.btrim(COALESCE(p_patch ->> 'name', '')),
      COALESCE(p_patch ->> 'phone', ''),
      COALESCE(p_patch ->> 'notes', ''),
      0,
      COALESCE((p_patch ->> 'created_at')::timestamptz, v_now)
    );
  ELSE
    UPDATE public.customers
       SET name = CASE
             WHEN p_patch ? 'name' AND NULLIF(pg_catalog.btrim(p_patch ->> 'name'), '') IS NOT NULL
               THEN pg_catalog.btrim(p_patch ->> 'name')
             ELSE v_existing_customer.name
           END,
           phone = CASE
             WHEN p_patch ? 'phone' THEN COALESCE(p_patch ->> 'phone', '')
             ELSE v_existing_customer.phone
           END,
           notes = CASE
             WHEN p_patch ? 'notes' THEN COALESCE(p_patch ->> 'notes', '')
             ELSE v_existing_customer.notes
           END
     WHERE shop_id = p_shop_id
       AND id = v_customer_id;
  END IF;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'customer',
    'applied',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'customer_id', v_customer_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_shop_expense(
  p_shop_id uuid,
  p_operation_id text,
  p_expense_id text,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_existing_expense public.expenses;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_expense_id text := pg_catalog.btrim(COALESCE(p_expense_id, ''));
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'expense_id', v_expense_id
    );
  END IF;

  SELECT e.*
    INTO v_existing_expense
    FROM public.expenses e
   WHERE e.shop_id = p_shop_id
     AND e.id = v_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    IF COALESCE((p_patch ->> 'is_deleted')::boolean, false)
       AND NOT (p_patch ? 'amount_ngwee')
    THEN
      -- Deleting an expense that never reached the server is a safe idempotent no-op
      NULL;
    ELSE
      INSERT INTO public.expenses (
        shop_id,
        id,
        category,
        amount_ngwee,
        note,
        is_deleted,
        created_at
      ) VALUES (
        p_shop_id,
        v_expense_id,
        COALESCE(p_patch ->> 'category', 'other'),
        (p_patch ->> 'amount_ngwee')::bigint,
        COALESCE(p_patch ->> 'note', ''),
        COALESCE((p_patch ->> 'is_deleted')::boolean, false),
        COALESCE((p_patch ->> 'created_at')::timestamptz, v_now)
      );
    END IF;
  ELSE
    UPDATE public.expenses
       SET category = CASE
             WHEN p_patch ? 'category' THEN COALESCE(p_patch ->> 'category', v_existing_expense.category)
             ELSE v_existing_expense.category
           END,
           amount_ngwee = CASE
             WHEN p_patch ? 'amount_ngwee' AND pg_catalog.jsonb_typeof(p_patch -> 'amount_ngwee') = 'number'
               THEN (p_patch ->> 'amount_ngwee')::bigint
             ELSE v_existing_expense.amount_ngwee
           END,
           note = CASE
             WHEN p_patch ? 'note' THEN COALESCE(p_patch ->> 'note', '')
             ELSE v_existing_expense.note
           END,
           is_deleted = CASE
             WHEN p_patch ? 'is_deleted' AND pg_catalog.jsonb_typeof(p_patch -> 'is_deleted') = 'boolean'
               THEN (p_patch ->> 'is_deleted')::boolean
             ELSE v_existing_expense.is_deleted
           END
     WHERE shop_id = p_shop_id
       AND id = v_expense_id;
  END IF;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'expense',
    'applied',
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', 'applied',
    'expense_id', v_expense_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. public.resolve_sync_conflict
--    Atomically resolves a SyncReviewDialog credit-balance conflict:
--      - `keep-sale` (keeps a credit sale whose customer already repaid)
--      - `cancel-payment` (discards an overpayment without writing a payment)
--      - `correct-payment` (applies exact corrected payment amount `0 < corrected <= current_owed`
--        and `< original_amount`, verifies expected balance & target invariants,
--        deducts from customer balance, and records sync_correction + audit trail)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_sync_conflict(
  p_shop_id uuid,
  p_operation_id text,
  p_operation_type text,
  p_decision text,
  p_resolution jsonb,
  p_context jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_existing_op public.sync_operations;
  v_customer public.customers;
  v_sale public.sales;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_customer_id text;
  v_expected_balance_ngwee bigint;
  v_original_amount_ngwee bigint;
  v_corrected_ngwee bigint := 0;
  v_payment_id text;
  v_sale_id text;
  v_kind text;
  v_final_resolution jsonb;
  v_resolved_iso text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid sync operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT so.*
    INTO v_existing_op
    FROM public.sync_operations so
   WHERE so.shop_id = p_shop_id
     AND so.operation_id = v_op_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already-processed',
      'idempotent', true,
      'outcome', v_existing_op.outcome,
      'resolution', v_existing_op.resolution
    );
  END IF;

  IF p_decision NOT IN ('keep-sale', 'cancel-payment', 'correct-payment') THEN
    RAISE EXCEPTION 'That choice does not apply to this entry.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_REVIEW_DECISION';
  END IF;

  v_kind := COALESCE(p_context ->> 'kind', CASE WHEN p_decision = 'keep-sale' THEN 'void' ELSE 'payment' END);
  v_customer_id := pg_catalog.btrim(COALESCE(p_context ->> 'customer_id', p_resolution ->> 'customerId', ''));
  v_expected_balance_ngwee := COALESCE((p_context ->> 'expected_balance_ngwee')::bigint, 0);
  v_original_amount_ngwee := COALESCE((p_context ->> 'original_amount_ngwee')::bigint, 0);

  SELECT c.*
    INTO v_customer
    FROM public.customers c
   WHERE c.shop_id = p_shop_id
     AND c.id = v_customer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The customer no longer exists on the server.'
      USING ERRCODE = 'P0002', DETAIL = 'CUSTOMER_NOT_FOUND';
  END IF;

  IF v_customer.total_owed_ngwee < 0 THEN
    RAISE EXCEPTION 'The server has an invalid customer balance.'
      USING ERRCODE = '23514', DETAIL = 'INVALID_CUSTOMER_BALANCE';
  END IF;

  IF v_kind = 'void' THEN
    v_sale_id := pg_catalog.btrim(COALESCE(p_context ->> 'sale_id', p_resolution ->> 'saleId', ''));
    SELECT s.*
      INTO v_sale
      FROM public.sales s
     WHERE s.shop_id = p_shop_id
       AND s.id = v_sale_id
     FOR UPDATE;

    IF FOUND AND v_sale.is_deleted THEN
      UPDATE public.shops
         SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
       WHERE id = p_shop_id;

      INSERT INTO public.sync_operations (
        shop_id,
        operation_id,
        operation_type,
        outcome,
        sale_id,
        applied_at
      ) VALUES (
        p_shop_id,
        v_op_id,
        'void_sale',
        'already-voided',
        v_sale_id,
        v_now
      );

      RETURN pg_catalog.jsonb_build_object(
        'status', 'already-processed',
        'idempotent', false,
        'outcome', 'already-voided',
        'sale_id', v_sale_id
      );
    END IF;
  END IF;

  IF p_context IS NOT NULL AND (
    v_customer.total_owed_ngwee <> v_expected_balance_ngwee
    OR v_customer.total_owed_ngwee >= v_original_amount_ngwee
  ) THEN
    RAISE EXCEPTION 'The server balance changed. Close this review and check it again.'
      USING ERRCODE = '23514', DETAIL = 'SERVER_BALANCE_CHANGED';
  END IF;

  IF v_kind = 'payment' THEN
    v_payment_id := pg_catalog.btrim(COALESCE(p_context ->> 'payment_id', ''));
    IF v_payment_id <> '' AND EXISTS (
      SELECT 1 FROM public.credit_payments cp WHERE cp.shop_id = p_shop_id AND cp.id = v_payment_id
    ) THEN
      RAISE EXCEPTION 'A payment with this ID already exists. Keep this browser’s data.'
        USING ERRCODE = '23505', DETAIL = 'PAYMENT_ALREADY_EXISTS';
    END IF;
  ELSIF v_kind = 'void' THEN
    IF NOT FOUND
       OR v_sale.payment_type <> 'credit'
       OR v_sale.customer_id IS DISTINCT FROM v_customer.id
       OR v_sale.total_amount_ngwee <> v_original_amount_ngwee
    THEN
      RAISE EXCEPTION 'The sale or its customer changed. Close this review and check it again.'
        USING ERRCODE = '23514', DETAIL = 'SALE_OR_CUSTOMER_CHANGED';
    END IF;
  END IF;

  v_resolved_iso := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_resolution ->> 'resolvedAt', '')), ''), pg_catalog.to_json(v_now) #>> '{}');
  v_final_resolution := COALESCE(p_resolution, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'customerName', v_customer.name,
    'serverBalanceBefore', ROUND((v_customer.total_owed_ngwee::numeric / 100.0), 2),
    'resolvedAt', v_resolved_iso
  );
  IF v_kind = 'void' AND v_sale.id IS NOT NULL THEN
    v_final_resolution := v_final_resolution || pg_catalog.jsonb_build_object(
      'receipt', COALESCE(v_sale.receipt_number, v_sale.id)
    );
  END IF;

  IF p_decision = 'correct-payment' THEN
    v_corrected_ngwee := COALESCE((p_context ->> 'corrected_amount_ngwee')::bigint, 0);
    IF v_corrected_ngwee <= 0
       OR v_corrected_ngwee > v_customer.total_owed_ngwee
       OR v_corrected_ngwee >= v_original_amount_ngwee
    THEN
      RAISE EXCEPTION 'Enter the correct payment, greater than zero and no more than the current balance.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_CORRECTED_PAYMENT';
    END IF;

    INSERT INTO public.credit_payments (
      shop_id,
      id,
      customer_id,
      customer_name,
      amount_ngwee,
      payment_method,
      note,
      local_date,
      sync_correction,
      created_at
    ) VALUES (
      p_shop_id,
      v_payment_id,
      v_customer.id,
      v_customer.name,
      v_corrected_ngwee,
      COALESCE(NULLIF(pg_catalog.btrim(p_context ->> 'payment_method'), ''), 'cash'),
      COALESCE(p_context ->> 'note', ''),
      NULLIF(pg_catalog.btrim(COALESCE(p_context ->> 'local_date', '')), ''),
      pg_catalog.jsonb_build_object(
        'actionId', v_op_id,
        'originalAmount', ROUND((v_original_amount_ngwee::numeric / 100.0), 2),
        'resolvedAt', v_resolved_iso
      ),
      COALESCE((p_context ->> 'created_at')::timestamptz, v_now)
    );

    UPDATE public.customers
       SET total_owed_ngwee = total_owed_ngwee - v_corrected_ngwee
     WHERE shop_id = p_shop_id
       AND id = v_customer.id;

    v_final_resolution := v_final_resolution || pg_catalog.jsonb_build_object(
      'correctedAmount', ROUND((v_corrected_ngwee::numeric / 100.0), 2)
    );
  END IF;

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.sync_operations (
    shop_id,
    operation_id,
    operation_type,
    outcome,
    sale_id,
    has_resolution,
    resolution,
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    CASE
      WHEN p_operation_type IN (
        'sale',
        'void_sale',
        'item',
        'customer',
        'payment',
        'expense',
        'stock_update',
        'conflict_resolution'
      ) THEN p_operation_type
      ELSE 'conflict_resolution'
    END,
    'resolved',
    v_sale_id,
    true,
    v_final_resolution,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved',
    'idempotent', false,
    'outcome', 'resolved',
    'applied_amount_ngwee', v_corrected_ngwee,
    'resolution', v_final_resolution
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. public.apply_sync_batch
--     Executes up to 100 normalized offline-queue operations per RPC call,
--     wrapping each operation in its own PL/pgSQL `BEGIN ... EXCEPTION`
--     subtransaction savepoint so a conflict/error on operation #37 rolls back
--     ONLY operation #37 while preserving operations #1..#36 and returning
--     per-operation structured outcomes to the client queue.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_sync_batch(
  p_shop_id uuid,
  p_operations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_op jsonb;
  v_rpc text;
  v_op_id text;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_msg text;
  v_detail text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF p_operations IS NULL OR pg_catalog.jsonb_typeof(p_operations) <> 'array' THEN
    RAISE EXCEPTION 'Sync batch operations must be a JSON array.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_BATCH_PAYLOAD';
  END IF;

  IF pg_catalog.jsonb_array_length(p_operations) > 100 THEN
    RAISE EXCEPTION 'Sync batch exceeds maximum size of 100 operations per call.'
      USING ERRCODE = '22023', DETAIL = 'BATCH_TOO_LARGE';
  END IF;

  FOR v_op IN
    SELECT elem
      FROM pg_catalog.jsonb_array_elements(p_operations) AS t(elem)
  LOOP
    v_rpc := COALESCE(v_op ->> 'rpc', '');
    v_op_id := COALESCE(v_op ->> 'operation_id', '');

    BEGIN
      CASE v_rpc
        WHEN 'record_sale' THEN
          v_res := public.record_sale(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_sale_id := v_op ->> 'sale_id',
            p_lines := v_op -> 'lines',
            p_payment_type := v_op ->> 'payment_type',
            p_receipt_number := v_op ->> 'receipt_number',
            p_momo_operator := v_op ->> 'momo_operator',
            p_customer_id := v_op ->> 'customer_id',
            p_customer_name := v_op ->> 'customer_name',
            p_customer_phone := v_op ->> 'customer_phone',
            p_payment_reference := v_op ->> 'payment_reference',
            p_note := v_op ->> 'note',
            p_local_date := v_op ->> 'local_date',
            p_cash_tendered_ngwee := CASE
              WHEN pg_catalog.jsonb_typeof(v_op -> 'cash_tendered_ngwee') = 'number'
                THEN (v_op ->> 'cash_tendered_ngwee')::bigint
              ELSE NULL
            END,
            p_change_given_ngwee := CASE
              WHEN pg_catalog.jsonb_typeof(v_op -> 'change_given_ngwee') = 'number'
                THEN (v_op ->> 'change_given_ngwee')::bigint
              ELSE NULL
            END,
            p_client_created_at := CASE
              WHEN NULLIF(v_op ->> 'client_created_at', '') IS NOT NULL
                THEN (v_op ->> 'client_created_at')::timestamptz
              ELSE NULL
            END,
            p_is_offline_sync := COALESCE((v_op ->> 'is_offline_sync')::boolean, true),
            p_offline_window_seconds := COALESCE((v_op ->> 'offline_window_seconds')::integer, 259200)
          );

        WHEN 'undo_sale' THEN
          v_res := public.undo_sale(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_sale_id := v_op ->> 'sale_id',
            p_movements := v_op -> 'movements',
            p_expected_checks := v_op -> 'expected_checks'
          );

        WHEN 'record_repayment' THEN
          v_res := public.record_repayment(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_payment_id := v_op ->> 'payment_id',
            p_customer_id := v_op ->> 'customer_id',
            p_amount_ngwee := (v_op ->> 'amount_ngwee')::bigint,
            p_payment_method := COALESCE(v_op ->> 'payment_method', 'cash'),
            p_note := COALESCE(v_op ->> 'note', ''),
            p_local_date := v_op ->> 'local_date',
            p_created_at := CASE
              WHEN NULLIF(v_op ->> 'created_at', '') IS NOT NULL
                THEN (v_op ->> 'created_at')::timestamptz
              ELSE NULL
            END
          );

        WHEN 'apply_stock_count' THEN
          v_res := public.apply_stock_count(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_item_id := v_op ->> 'item_id',
            p_mode := v_op ->> 'mode',
            p_quantity := (v_op ->> 'quantity')::integer,
            p_observed_quantity := CASE
              WHEN pg_catalog.jsonb_typeof(v_op -> 'observed_quantity') = 'number'
                THEN (v_op ->> 'observed_quantity')::integer
              ELSE NULL
            END,
            p_movement_id := v_op ->> 'movement_id',
            p_movement_type := COALESCE(v_op ->> 'movement_type', 'adjustment'),
            p_reason := COALESCE(v_op ->> 'reason', 'Stock adjustment'),
            p_metadata := v_op -> 'metadata'
          );

        WHEN 'resolve_stock_conflict' THEN
          v_res := public.resolve_stock_conflict(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_conflict_id := v_op ->> 'conflict_id'
          );

        WHEN 'upsert_shop_item' THEN
          v_res := public.upsert_shop_item(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_item_id := v_op ->> 'item_id',
            p_patch := v_op -> 'patch',
            p_initial_movement := v_op -> 'initial_movement'
          );

        WHEN 'upsert_shop_customer' THEN
          v_res := public.upsert_shop_customer(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_customer_id := v_op ->> 'customer_id',
            p_patch := v_op -> 'patch'
          );

        WHEN 'upsert_shop_expense' THEN
          v_res := public.upsert_shop_expense(
            p_shop_id := p_shop_id,
            p_operation_id := v_op_id,
            p_expense_id := v_op ->> 'expense_id',
            p_patch := v_op -> 'patch'
          );

        ELSE
          RAISE EXCEPTION 'Unsupported sync batch RPC "%".', v_rpc
            USING ERRCODE = '22023', DETAIL = 'UNSUPPORTED_BATCH_RPC';
      END CASE;

      v_results := v_results || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'operation_id', v_op_id,
          'ok', true,
          'result', v_res
        )
      );
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
          v_sqlstate = RETURNED_SQLSTATE,
          v_msg = MESSAGE_TEXT,
          v_detail = PG_EXCEPTION_DETAIL;

        v_results := v_results || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'operation_id', v_op_id,
            'ok', false,
            'error_code', v_sqlstate,
            'error_detail', COALESCE(v_detail, ''),
            'error_message', v_msg
          )
        );
        -- Preserve strict FIFO causality: stop batch at the first failed/conflicted
        -- entry while keeping all preceding entries in the batch committed.
        EXIT;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'results', v_results
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. public.reconcile_shop_ledger
--     Verifies all 4 core financial & stock invariants for a single shop or
--     across every shop in the database (when called by an `aal2` platform admin
--     or `service_role` with `p_shop_id = NULL`):
--       1. sale totals = sum of sale_lines
--       2. profit = revenue - cost (accounting for missing_cost_revenue_ngwee)
--       3. customer balance = active credit sales minus repayments
--       4. item stock = initial + sum of non-initial stock movements
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_shop_ledger(
  p_shop_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text;
  v_is_admin boolean;
  v_claim_shop_id uuid;
  v_shops_checked integer := 0;
  v_sale_line_mismatches jsonb := '[]'::jsonb;
  v_sale_profit_mismatches jsonb := '[]'::jsonb;
  v_customer_balance_mismatches jsonb := '[]'::jsonb;
  v_stock_movement_mismatches jsonb := '[]'::jsonb;
  v_c1 integer := 0;
  v_c2 integer := 0;
  v_c3 integer := 0;
  v_c4 integer := 0;
BEGIN
  v_jwt_role := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    auth.jwt() ->> 'role',
    ''
  );
  v_is_admin := public.is_platform_admin();
  v_claim_shop_id := public.request_shop_id();

  IF v_jwt_role <> 'service_role' AND NOT v_is_admin THEN
    IF p_shop_id IS NULL OR v_claim_shop_id IS NULL OR p_shop_id <> v_claim_shop_id THEN
      RAISE EXCEPTION 'Administrator MFA (aal2) or verified shop ownership is required to run reconciliation.'
        USING ERRCODE = '42501', DETAIL = 'RECONCILIATION_FORBIDDEN';
    END IF;
  END IF;

  SELECT COUNT(*)::integer
    INTO v_shops_checked
    FROM public.shops s
   WHERE p_shop_id IS NULL OR s.id = p_shop_id;

  -- 1. Sale totals = sum of lines
  SELECT
    COUNT(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'shop_id', m.shop_id,
          'sale_id', m.sale_id,
          'sale_total_ngwee', m.total_amount_ngwee,
          'lines_sum_ngwee', m.lines_sum_ngwee,
          'sale_items_count', m.items_count,
          'lines_qty_sum', m.lines_qty_sum
        )
      ),
      '[]'::jsonb
    )
    INTO v_c1, v_sale_line_mismatches
    FROM (
      SELECT
        s.shop_id,
        s.id AS sale_id,
        s.total_amount_ngwee,
        s.items_count,
        COALESCE(SUM(sl.line_total_ngwee), 0)::bigint AS lines_sum_ngwee,
        COALESCE(SUM(sl.quantity), 0)::integer AS lines_qty_sum,
        COALESCE(BOOL_OR(sl.line_total_ngwee <> sl.selling_price_ngwee * sl.quantity), false) AS bad_line_math
      FROM public.sales s
      LEFT JOIN public.sale_lines sl
        ON sl.shop_id = s.shop_id
       AND sl.sale_id = s.id
      WHERE p_shop_id IS NULL OR s.shop_id = p_shop_id
      GROUP BY s.shop_id, s.id, s.total_amount_ngwee, s.items_count
      HAVING s.total_amount_ngwee <> COALESCE(SUM(sl.line_total_ngwee), 0)
          OR s.items_count <> COALESCE(SUM(sl.quantity), 0)
          OR COALESCE(BOOL_OR(sl.line_total_ngwee <> sl.selling_price_ngwee * sl.quantity), false)
    ) m;

  -- 2. Profit = revenue - cost (respecting unknown-cost lines)
  SELECT
    COUNT(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'shop_id', m.shop_id,
          'sale_id', m.sale_id,
          'profit_ngwee', m.profit_ngwee,
          'expected_profit_ngwee', m.expected_profit_ngwee,
          'total_cost_ngwee', m.total_cost_ngwee,
          'expected_cost_ngwee', m.expected_cost_ngwee,
          'missing_cost_revenue_ngwee', m.missing_cost_revenue_ngwee,
          'expected_missing_cost_revenue_ngwee', m.expected_missing_ngwee
        )
      ),
      '[]'::jsonb
    )
    INTO v_c2, v_sale_profit_mismatches
    FROM (
      SELECT
        s.shop_id,
        s.id AS sale_id,
        s.profit_ngwee,
        s.total_cost_ngwee,
        s.missing_cost_revenue_ngwee,
        COALESCE(
          SUM(CASE WHEN sl.buying_price_known THEN sl.buying_price_ngwee * sl.quantity ELSE 0 END),
          0
        )::bigint AS expected_cost_ngwee,
        COALESCE(
          SUM(CASE WHEN NOT sl.buying_price_known THEN sl.line_total_ngwee ELSE 0 END),
          0
        )::bigint AS expected_missing_ngwee,
        (
          s.total_amount_ngwee
          - COALESCE(SUM(CASE WHEN sl.buying_price_known THEN sl.buying_price_ngwee * sl.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN NOT sl.buying_price_known THEN sl.line_total_ngwee ELSE 0 END), 0)
        )::bigint AS expected_profit_ngwee
      FROM public.sales s
      LEFT JOIN public.sale_lines sl
        ON sl.shop_id = s.shop_id
       AND sl.sale_id = s.id
      WHERE p_shop_id IS NULL OR s.shop_id = p_shop_id
      GROUP BY
        s.shop_id,
        s.id,
        s.total_amount_ngwee,
        s.profit_ngwee,
        s.total_cost_ngwee,
        s.missing_cost_revenue_ngwee
      HAVING s.total_cost_ngwee <> COALESCE(
               SUM(CASE WHEN sl.buying_price_known THEN sl.buying_price_ngwee * sl.quantity ELSE 0 END),
               0
             )
          OR s.missing_cost_revenue_ngwee <> COALESCE(
               SUM(CASE WHEN NOT sl.buying_price_known THEN sl.line_total_ngwee ELSE 0 END),
               0
             )
          OR s.profit_ngwee <> (
               s.total_amount_ngwee
               - COALESCE(SUM(CASE WHEN sl.buying_price_known THEN sl.buying_price_ngwee * sl.quantity ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN NOT sl.buying_price_known THEN sl.line_total_ngwee ELSE 0 END), 0)
             )
    ) m;

  -- 3. Customer balance = active credit sales minus repayments
  SELECT
    COUNT(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'shop_id', m.shop_id,
          'customer_id', m.customer_id,
          'total_owed_ngwee', m.total_owed_ngwee,
          'credit_sales_ngwee', m.credit_sales_ngwee,
          'repayments_ngwee', m.repayments_ngwee,
          'expected_owed_ngwee', m.expected_owed_ngwee
        )
      ),
      '[]'::jsonb
    )
    INTO v_c3, v_customer_balance_mismatches
    FROM (
      SELECT
        c.shop_id,
        c.id AS customer_id,
        c.total_owed_ngwee,
        COALESCE(cs.credit_sales_ngwee, 0)::bigint AS credit_sales_ngwee,
        COALESCE(cp.repayments_ngwee, 0)::bigint AS repayments_ngwee,
        (COALESCE(cs.credit_sales_ngwee, 0) - COALESCE(cp.repayments_ngwee, 0))::bigint AS expected_owed_ngwee
      FROM public.customers c
      LEFT JOIN (
        SELECT
          s.shop_id,
          s.customer_id,
          SUM(s.total_amount_ngwee)::bigint AS credit_sales_ngwee
        FROM public.sales s
        WHERE s.payment_type = 'credit'
          AND s.is_deleted = false
          AND (p_shop_id IS NULL OR s.shop_id = p_shop_id)
        GROUP BY s.shop_id, s.customer_id
      ) cs
        ON cs.shop_id = c.shop_id
       AND cs.customer_id = c.id
      LEFT JOIN (
        SELECT
          p.shop_id,
          p.customer_id,
          SUM(p.amount_ngwee)::bigint AS repayments_ngwee
        FROM public.credit_payments p
        WHERE p_shop_id IS NULL OR p.shop_id = p_shop_id
        GROUP BY p.shop_id, p.customer_id
      ) cp
        ON cp.shop_id = c.shop_id
       AND cp.customer_id = c.id
      WHERE (p_shop_id IS NULL OR c.shop_id = p_shop_id)
        AND c.total_owed_ngwee <> (COALESCE(cs.credit_sales_ngwee, 0) - COALESCE(cp.repayments_ngwee, 0))
    ) m;

  -- 4. Stock = initial + sum of movements
  SELECT
    COUNT(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'shop_id', m.shop_id,
          'item_id', m.item_id,
          'quantity', m.quantity,
          'initial_quantity', m.initial_quantity,
          'movements_delta', m.movements_delta,
          'expected_quantity', m.expected_quantity
        )
      ),
      '[]'::jsonb
    )
    INTO v_c4, v_stock_movement_mismatches
    FROM (
      SELECT
        i.shop_id,
        i.id AS item_id,
        i.quantity,
        COALESCE(SUM(sm.delta) FILTER (WHERE sm.type = 'initial'), 0)::integer AS initial_quantity,
        COALESCE(SUM(sm.delta) FILTER (WHERE sm.type <> 'initial'), 0)::integer AS movements_delta,
        COALESCE(SUM(sm.delta), 0)::integer AS expected_quantity
      FROM public.items i
      LEFT JOIN public.stock_movements sm
        ON sm.shop_id = i.shop_id
       AND sm.item_id = i.id
      WHERE p_shop_id IS NULL OR i.shop_id = p_shop_id
      GROUP BY i.shop_id, i.id, i.quantity
      HAVING i.quantity <> COALESCE(SUM(sm.delta), 0)
    ) m;

  RETURN pg_catalog.jsonb_build_object(
    'checked_at', pg_catalog.clock_timestamp(),
    'shops_checked', v_shops_checked,
    'total_differences', (v_c1 + v_c2 + v_c3 + v_c4),
    'sale_line_mismatch_count', v_c1,
    'sale_profit_mismatch_count', v_c2,
    'customer_balance_mismatch_count', v_c3,
    'stock_movement_mismatch_count', v_c4,
    'sale_line_mismatches', v_sale_line_mismatches,
    'sale_profit_mismatches', v_sale_profit_mismatches,
    'customer_balance_mismatches', v_customer_balance_mismatches,
    'stock_movement_mismatches', v_stock_movement_mismatches
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. Strict Function Privilege Hardening (No PUBLIC or anon execution)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.lock_authorized_shop_for_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_sale(
  uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_sale(uuid, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_repayment(
  uuid, text, text, text, bigint, text, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_stock_count(
  uuid, text, text, text, integer, integer, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_stock_conflict(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_shop_item(uuid, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_shop_customer(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_shop_expense(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_sync_conflict(uuid, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_sync_batch(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_shop_ledger(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.lock_authorized_shop_for_write(uuid) FROM anon;
    REVOKE ALL ON FUNCTION public.record_sale(
      uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
    ) FROM anon;
    REVOKE ALL ON FUNCTION public.undo_sale(uuid, text, text, jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.record_repayment(
      uuid, text, text, text, bigint, text, text, text, timestamptz
    ) FROM anon;
    REVOKE ALL ON FUNCTION public.apply_stock_count(
      uuid, text, text, text, integer, integer, text, text, text, jsonb
    ) FROM anon;
    REVOKE ALL ON FUNCTION public.resolve_stock_conflict(uuid, text, text) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_shop_item(uuid, text, text, jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_shop_customer(uuid, text, text, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_shop_expense(uuid, text, text, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.resolve_sync_conflict(uuid, text, text, text, jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.apply_sync_batch(uuid, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.reconcile_shop_ledger(uuid) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.lock_authorized_shop_for_write(uuid) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.record_sale(
      uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
    ) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.undo_sale(uuid, text, text, jsonb, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.record_repayment(
      uuid, text, text, text, bigint, text, text, text, timestamptz
    ) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.apply_stock_count(
      uuid, text, text, text, integer, integer, text, text, text, jsonb
    ) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.resolve_stock_conflict(uuid, text, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_item(uuid, text, text, jsonb, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_customer(uuid, text, text, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_expense(uuid, text, text, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.resolve_sync_conflict(uuid, text, text, text, jsonb, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.apply_sync_batch(uuid, jsonb) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.reconcile_shop_ledger(uuid) TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.lock_authorized_shop_for_write(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_sale(
      uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
    ) TO service_role;
    GRANT EXECUTE ON FUNCTION public.undo_sale(uuid, text, text, jsonb, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_repayment(
      uuid, text, text, text, bigint, text, text, text, timestamptz
    ) TO service_role;
    GRANT EXECUTE ON FUNCTION public.apply_stock_count(
      uuid, text, text, text, integer, integer, text, text, text, jsonb
    ) TO service_role;
    GRANT EXECUTE ON FUNCTION public.resolve_stock_conflict(uuid, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_item(uuid, text, text, jsonb, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_customer(uuid, text, text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_shop_expense(uuid, text, text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.resolve_sync_conflict(uuid, text, text, text, jsonb, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.apply_sync_batch(uuid, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.reconcile_shop_ledger(uuid) TO service_role;
  END IF;
END;
$$;
