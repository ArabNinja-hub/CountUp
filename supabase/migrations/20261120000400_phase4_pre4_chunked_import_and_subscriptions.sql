-- =============================================================================
-- CountUp Pre-4 Checks + Phase 4 — Chunked Backup Import, Low-Priority Late
-- Offline Sync Notes, Server-Enforced Subscriptions & Manual Mobile-Money
-- Payment Review (`SECURITY DEFINER` RPCs + Reconciliation)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pre-4 Check 4: Widen `public.platform_alerts` so legitimate >72h offline
--    sales on an active/grace plan raise a low-priority `info` / `sync_note`
--    admin note rather than a security warning, and return a calm neutral
--    `'Synced late, kept'` notice to the shopkeeper.
-- -----------------------------------------------------------------------------
ALTER TABLE public.platform_alerts
  DROP CONSTRAINT IF EXISTS platform_alerts_severity_check,
  DROP CONSTRAINT IF EXISTS platform_alerts_category_check;

ALTER TABLE public.platform_alerts
  ADD CONSTRAINT platform_alerts_severity_check
    CHECK (severity IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT platform_alerts_category_check
    CHECK (category IN ('sms_cap', 'sms_abuse', 'security', 'sync_note'));

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
  v_window_secs integer := GREATEST(60, LEAST(COALESCE(p_offline_window_seconds, 259200), 604800));
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_sale_id text := pg_catalog.btrim(COALESCE(p_sale_id, ''));
  v_receipt text := pg_catalog.btrim(COALESCE(p_receipt_number, ''));
  v_flagged boolean := false;
  v_flag_reason text := NULL;
  v_effective_created_at timestamptz;
  v_line_count integer;
  v_items_count integer := 0;
  v_total_amount_ngwee bigint := 0;
  v_total_cost_ngwee bigint := 0;
  v_missing_cost_revenue_ngwee bigint := 0;
  v_profit_ngwee bigint := 0;
  v_line record;
  v_item public.items;
  v_customer public.customers;
  v_line_buying_ngwee bigint;
  v_line_buying_known boolean;
  v_line_total_ngwee bigint;
  v_prev_qty integer;
  v_next_qty integer;
  v_shortfall integer;
  v_delta integer;
  v_movement_id text;
  v_conflict_id text;
  v_line_id text;
  v_conflicts_created integer := 0;
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
      'sale_id', COALESCE(v_existing_op.sale_id, v_sale_id),
      'shopkeeper_notice', CASE WHEN v_existing_op.outcome = 'flagged' THEN 'Synced late, kept' ELSE NULL END
    );
  END IF;

  IF v_shop.is_deactivated OR v_shop.plan_status = 'suspended' THEN
    RAISE EXCEPTION 'New sales are locked because this shop is suspended.'
      USING ERRCODE = '42501', DETAIL = 'SHOP_SUSPENDED';
  END IF;

  IF COALESCE(p_is_offline_sync, false) THEN
    IF v_now > v_shop.sales_access_until AND (
      v_shop.last_server_contact_at > v_shop.sales_access_until
      OR p_client_created_at IS NULL
      OR p_client_created_at > v_shop.sales_access_until
      OR (v_now - p_client_created_at) > pg_catalog.make_interval(secs => v_window_secs)
    ) THEN
      RAISE EXCEPTION 'Subscription and grace period have expired. Renew your plan to record sales.'
        USING ERRCODE = '42501', DETAIL = 'PLAN_EXPIRED';
    END IF;

    IF p_client_created_at IS NULL THEN
      v_effective_created_at := v_now;
      v_flagged := true;
      v_flag_reason := 'missing_client_timestamp';
    ELSIF (v_now - p_client_created_at) > pg_catalog.make_interval(secs => v_window_secs)
       OR (v_now - v_shop.last_server_contact_at) > pg_catalog.make_interval(secs => v_window_secs)
    THEN
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

  IF p_payment_type NOT IN ('cash', 'momo', 'credit') THEN
    RAISE EXCEPTION 'Invalid payment type.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_TYPE';
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

  IF (
    SELECT COUNT(DISTINCT pg_catalog.btrim(elem ->> 'item_id'))
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  ) <> v_line_count THEN
    RAISE EXCEPTION 'A product appears more than once in the cart.'
      USING ERRCODE = '22023', DETAIL = 'DUPLICATE_SALE_ITEM';
  END IF;

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
    CASE WHEN p_payment_type = 'momo' THEN NULLIF(pg_catalog.btrim(COALESCE(p_momo_operator, '')), '') ELSE NULL END,
    CASE WHEN p_payment_type = 'credit' THEN v_customer.id ELSE NULL END,
    CASE
      WHEN p_payment_type = 'credit' THEN COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_customer_name, '')), ''), v_customer.name)
      ELSE NULLIF(pg_catalog.btrim(COALESCE(p_customer_name, '')), '')
    END,
    NULLIF(pg_catalog.btrim(COALESCE(p_customer_phone, '')), ''),
    v_receipt,
    NULLIF(pg_catalog.btrim(COALESCE(p_payment_reference, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_local_date, '')), ''),
    p_cash_tendered_ngwee,
    CASE
      WHEN p_cash_tendered_ngwee IS NOT NULL THEN p_cash_tendered_ngwee - v_total_amount_ngwee
      ELSE NULL
    END,
    false,
    COALESCE(p_is_offline_sync, false),
    v_flagged,
    v_flag_reason,
    p_client_created_at,
    v_effective_created_at
  );

  FOR v_line IN
    SELECT
      (ord - 1)::integer AS idx,
      NULLIF(pg_catalog.btrim(COALESCE(elem ->> 'line_id', '')), '') AS line_id,
      pg_catalog.btrim(COALESCE(elem ->> 'item_id', '')) AS item_id,
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

    v_line_id := COALESCE(v_line.line_id, v_sale_id || ':' || v_line.idx::text);
    IF pg_catalog.char_length(v_line_id) > 160 THEN
      v_line_id := 'sl_' || pg_catalog.md5(v_sale_id || ':' || v_line.idx::text);
    END IF;

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
      v_line_id,
      v_sale_id,
      v_line.idx,
      v_item.id,
      COALESCE(v_line.item_name, v_item.name),
      COALESCE(v_line.unit_label, v_item.unit_label, ''),
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
    IF pg_catalog.char_length(v_movement_id) > 128 OR pg_catalog.strpos(v_movement_id, '/') > 0 THEN
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
      COALESCE(v_line.reason, 'Sale ' || v_receipt),
      v_sale_id,
      CASE WHEN v_shortfall > 0 THEN v_line.quantity ELSE NULL END,
      v_shortfall > 0,
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
        v_effective_created_at
      );

      v_conflicts_created := v_conflicts_created + 1;
    END IF;
  END LOOP;

  IF p_payment_type = 'credit' THEN
    UPDATE public.customers
       SET total_owed_ngwee = total_owed_ngwee + v_total_amount_ngwee
     WHERE shop_id = p_shop_id
       AND id = v_customer.id;
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
    applied_at
  ) VALUES (
    p_shop_id,
    v_op_id,
    'sale',
    CASE WHEN v_flagged THEN 'flagged' ELSE 'applied' END,
    v_sale_id,
    v_now
  );

  IF v_flagged THEN
    INSERT INTO public.platform_alerts (
      alert_key,
      severity,
      category,
      title,
      detail,
      metadata
    ) VALUES (
      pg_catalog.left('offline_window:' || p_shop_id::text || ':' || v_sale_id, 120),
      'info',
      'sync_note',
      'Late offline sale synced and kept',
      pg_catalog.left(
        'Offline sale ' || v_sale_id || ' synced outside the 72h offline window on an active plan and was kept (' ||
        COALESCE(v_flag_reason, 'flagged') || ').',
        500
      ),
      pg_catalog.jsonb_build_object(
        'shop_id', p_shop_id,
        'sale_id', v_sale_id,
        'operation_id', v_op_id,
        'reason', v_flag_reason
      )
    )
    ON CONFLICT (alert_key) DO NOTHING;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'idempotent', false,
    'outcome', CASE WHEN v_flagged THEN 'flagged' ELSE 'applied' END,
    'sale_id', v_sale_id,
    'total_amount_ngwee', v_total_amount_ngwee,
    'profit_ngwee', v_profit_ngwee,
    'stock_conflicts_created', v_conflicts_created,
    'offline_window_flagged', v_flagged,
    'offline_flag_reason', v_flag_reason,
    'shopkeeper_notice', CASE WHEN v_flagged THEN 'Synced late, kept' ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_sale(
  uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sale(
  uuid, text, text, jsonb, text, text, text, text, text, text, text, text, text, bigint, bigint, timestamptz, boolean, integer
) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Pre-4 Checks 1–3: Signed Kwacha helper + Raised Record Caps (50,000
--    primary records / 200,000 total rows explicitly counting `sale_lines` and
--    `stock_movements`) + Fast Set-Based Validation + Staged Chunked Backup
--    Import (`begin_shop_backup_import` -> `append_shop_backup_chunk` ->
--    `finalize_shop_backup_import` / `abort_shop_backup_import`)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_strict_signed_kwacha_to_ngwee(
  p_val jsonb,
  p_field text
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_type text;
  v_txt text;
BEGIN
  IF p_val IS NULL THEN
    RAISE EXCEPTION 'Missing monetary value for %.', p_field
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  v_type := pg_catalog.jsonb_typeof(p_val);
  IF v_type = 'number' THEN
    v_txt := p_val::text;
  ELSIF v_type = 'string' THEN
    v_txt := pg_catalog.btrim(p_val #>> '{}');
  ELSE
    RAISE EXCEPTION 'Invalid monetary value for %.', p_field
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  IF pg_catalog.left(v_txt, 1) = '-' THEN
    RETURN -public.parse_strict_kwacha_to_ngwee(
      pg_catalog.to_jsonb(pg_catalog.substr(v_txt, 2)),
      p_field,
      true
    );
  END IF;

  RETURN public.parse_strict_kwacha_to_ngwee(p_val, p_field, true);
END;
$$;

REVOKE ALL ON FUNCTION public.parse_strict_signed_kwacha_to_ngwee(jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_strict_signed_kwacha_to_ngwee(jsonb, text)
  TO service_role;

-- Internal shared validator + atomic committer operating on populated
-- `pg_temp.tmp_backup_*` tables inside the caller's transaction.
CREATE OR REPLACE FUNCTION public.commit_populated_backup_temp_tables(
  p_shop_id uuid,
  p_actor_uid uuid,
  p_op_id text,
  p_effective_sha text,
  p_format text,
  p_source_shop_name text,
  p_dry_run boolean,
  p_allow_non_empty_shop boolean,
  p_already_imported boolean,
  p_shop_has_data boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_sha_marker_id text := 'backup_sha256:' || p_effective_sha;
  v_items_count integer;
  v_active_items_count integer;
  v_archived_items_count integer;
  v_sales_count integer;
  v_sale_lines_count integer;
  v_customers_count integer;
  v_expenses_count integer;
  v_payments_count integer;
  v_movements_count integer;
  v_primary_records integer;
  v_total_records integer;
  v_total_stock_value_ngwee bigint;
  v_total_owed_ngwee bigint;
  v_preview jsonb;
  v_recon jsonb;
BEGIN
  -- 1. Cross-collection reference & invariant validation
  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_sale_lines sl
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales s WHERE s.id = sl.sale_id)
        OR NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items i WHERE i.id = sl.item_id)
  ) THEN
    RAISE EXCEPTION 'Backup has a sale line referring to a missing sale or product.'
      USING ERRCODE = '23503', DETAIL = 'MISMATCHED_REFERENCE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_sales s
      LEFT JOIN pg_temp.tmp_backup_sale_lines sl ON sl.sale_id = s.id
     GROUP BY s.id, s.items_count, s.total_amount_ngwee, s.total_cost_ngwee, s.missing_cost_revenue_ngwee, s.profit_ngwee
    HAVING COUNT(sl.id) = 0
        OR s.items_count <> COALESCE(SUM(sl.quantity), 0)
        OR s.total_amount_ngwee <> COALESCE(SUM(sl.line_total_ngwee), 0)
        OR s.total_cost_ngwee <> COALESCE(SUM(CASE WHEN sl.buying_price_known THEN sl.buying_price_ngwee * sl.quantity ELSE 0 END), 0)
        OR s.missing_cost_revenue_ngwee <> COALESCE(SUM(CASE WHEN NOT sl.buying_price_known THEN sl.line_total_ngwee ELSE 0 END), 0)
        OR s.profit_ngwee <> (s.total_amount_ngwee - s.total_cost_ngwee - s.missing_cost_revenue_ngwee)
  ) THEN
    RAISE EXCEPTION 'One or more receipts in the backup have totals or profit that do not match their items.'
      USING ERRCODE = '22023', DETAIL = 'SALE_MATH_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_sales s
     WHERE s.payment_type = 'credit'
       AND (s.customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers c WHERE c.id = s.customer_id))
  ) THEN
    RAISE EXCEPTION 'A credit sale in the backup refers to a missing customer.'
      USING ERRCODE = '23503', DETAIL = 'MISMATCHED_REFERENCE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_payments cp
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers c WHERE c.id = cp.customer_id)
  ) THEN
    RAISE EXCEPTION 'A credit repayment in the backup refers to a missing customer.'
      USING ERRCODE = '23503', DETAIL = 'MISMATCHED_REFERENCE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_customers c
     WHERE c.computed_owed_ngwee < 0
        OR (c.expected_owed_ngwee IS NOT NULL AND c.expected_owed_ngwee <> c.computed_owed_ngwee)
  ) THEN
    RAISE EXCEPTION 'A customer credit balance in the backup is negative or does not match credit sales minus repayments.'
      USING ERRCODE = '23514', DETAIL = 'CREDIT_LEDGER_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_movements m
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items i WHERE i.id = m.item_id)
        OR (m.related_sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales s WHERE s.id = m.related_sale_id))
  ) THEN
    RAISE EXCEPTION 'Backup has a stock movement referring to a missing product or sale.'
      USING ERRCODE = '23503', DETAIL = 'MISMATCHED_REFERENCE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_movements m
     WHERE GREATEST(0, m.previous_quantity + m.delta) <> m.new_quantity
  ) THEN
    RAISE EXCEPTION 'Backup has an inconsistent stock movement (previous + delta <> new).'
      USING ERRCODE = '23514', DETAIL = 'STOCK_MOVEMENT_MISMATCH';
  END IF;

  -- Set-based check & synthesis of deterministic opening stock movements
  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_items i
      LEFT JOIN pg_temp.tmp_backup_movements m ON m.item_id = i.id
     GROUP BY i.id, i.quantity
    HAVING COALESCE(SUM(m.delta), 0) <> i.quantity
       AND (
         COALESCE(BOOL_OR(m.type = 'initial'), false)
         OR (i.quantity - COALESCE(SUM(m.delta), 0)) < 0
       )
  ) THEN
    RAISE EXCEPTION 'Stock movement history for one or more products does not match their quantity.'
      USING ERRCODE = '23514', DETAIL = 'STOCK_LEDGER_MISMATCH';
  END IF;

  INSERT INTO pg_temp.tmp_backup_movements (
    id, item_id, item_name, type, delta, previous_quantity, new_quantity,
    reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
  )
  SELECT
    CASE
      WHEN pg_catalog.char_length(i.id || ':opening') <= 128 THEN i.id || ':opening'
      ELSE 'open_' || pg_catalog.md5(i.id)
    END,
    i.id,
    i.name,
    'initial',
    (i.quantity - COALESCE(SUM(m.delta), 0))::integer,
    0,
    (i.quantity - COALESCE(SUM(m.delta), 0))::integer,
    'Opening stock from backup restore',
    NULL,
    NULL,
    false,
    i.is_demo,
    i.created_at
  FROM pg_temp.tmp_backup_items i
  LEFT JOIN pg_temp.tmp_backup_movements m ON m.item_id = i.id
  GROUP BY i.id, i.name, i.quantity, i.is_demo, i.created_at
  HAVING COALESCE(SUM(m.delta), 0) <> i.quantity;

  -- 2. Enforce clarified record caps:
  --    - Primary ledger entities (`items + sales + customers + expenses + credit_payments`) <= 50,000
  --    - Total expanded rows (explicitly including `sale_lines` and `stock_movements`) <= 200,000
  SELECT
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_items),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_items WHERE NOT is_deleted),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_items WHERE is_deleted),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_sales),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_sale_lines),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_customers),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_expenses),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_payments),
    (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_movements),
    COALESCE((SELECT SUM(quantity::bigint * selling_price_ngwee) FROM pg_temp.tmp_backup_items WHERE NOT is_deleted), 0)::bigint,
    COALESCE((SELECT SUM(computed_owed_ngwee) FROM pg_temp.tmp_backup_customers), 0)::bigint
    INTO
      v_items_count,
      v_active_items_count,
      v_archived_items_count,
      v_sales_count,
      v_sale_lines_count,
      v_customers_count,
      v_expenses_count,
      v_payments_count,
      v_movements_count,
      v_total_stock_value_ngwee,
      v_total_owed_ngwee;

  v_primary_records :=
    v_items_count + v_sales_count + v_customers_count + v_expenses_count + v_payments_count;
  v_total_records :=
    v_primary_records + v_sale_lines_count + v_movements_count;

  IF v_primary_records > 50000 OR v_total_records > 200000 THEN
    RAISE EXCEPTION 'Backup contains % primary records (% total rows including sale lines and stock movements), exceeding the 50,000 primary / 200,000 total restore limit.',
      v_primary_records, v_total_records
      USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
  END IF;

  v_preview := pg_catalog.jsonb_build_object(
    'format', p_format,
    'source_shop_name', p_source_shop_name,
    'items_count', v_items_count,
    'active_items_count', v_active_items_count,
    'archived_items_count', v_archived_items_count,
    'sales_count', v_sales_count,
    'sale_lines_count', v_sale_lines_count,
    'customers_count', v_customers_count,
    'expenses_count', v_expenses_count,
    'credit_payments_count', v_payments_count,
    'stock_movements_count', v_movements_count,
    'primary_records_count', v_primary_records,
    'total_records_count', v_total_records,
    'total_stock_value_ngwee', v_total_stock_value_ngwee,
    'total_owed_ngwee', v_total_owed_ngwee
  );

  IF COALESCE(p_dry_run, true) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'preview',
      'dry_run', true,
      'idempotent', p_already_imported,
      'already_imported', p_already_imported,
      'shop_has_existing_data', p_shop_has_data,
      'file_sha256', p_effective_sha,
      'preview', v_preview
    );
  END IF;

  IF p_already_imported THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'dry_run', false,
      'idempotent', true,
      'already_imported', true,
      'shop_has_existing_data', p_shop_has_data,
      'file_sha256', p_effective_sha,
      'preview', v_preview
    );
  END IF;

  IF p_shop_has_data AND NOT COALESCE(p_allow_non_empty_shop, false) THEN
    RAISE EXCEPTION 'This shop already has records. Restore is only allowed into a new or empty shop unless you explicitly choose to merge into an existing shop.'
      USING ERRCODE = '23514', DETAIL = 'SHOP_NOT_EMPTY';
  END IF;

  IF p_shop_has_data THEN
    IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items t JOIN public.items x ON x.shop_id = p_shop_id AND x.id = t.id)
       OR EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers t JOIN public.customers x ON x.shop_id = p_shop_id AND x.id = t.id)
       OR EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales t JOIN public.sales x ON x.shop_id = p_shop_id AND x.id = t.id)
       OR EXISTS (SELECT 1 FROM pg_temp.tmp_backup_payments t JOIN public.credit_payments x ON x.shop_id = p_shop_id AND x.id = t.id)
       OR EXISTS (SELECT 1 FROM pg_temp.tmp_backup_expenses t JOIN public.expenses x ON x.shop_id = p_shop_id AND x.id = t.id)
       OR EXISTS (SELECT 1 FROM pg_temp.tmp_backup_movements t JOIN public.stock_movements x ON x.shop_id = p_shop_id AND x.id = t.id)
    THEN
      RAISE EXCEPTION 'Some records in this backup already exist in this shop. Nothing was imported.'
        USING ERRCODE = '23505', DETAIL = 'RECORD_ID_CONFLICT';
    END IF;
  END IF;

  INSERT INTO public.items (
    shop_id, id, name, unit_label, buying_price_ngwee, buying_price_known,
    selling_price_ngwee, quantity, low_stock_threshold, is_deleted,
    is_demo, last_sold_at, created_at, updated_at
  )
  SELECT
    p_shop_id, id, name, unit_label, buying_price_ngwee, buying_price_known,
    selling_price_ngwee, quantity, low_stock_threshold, is_deleted,
    is_demo, last_sold_at, created_at, updated_at
  FROM pg_temp.tmp_backup_items;

  INSERT INTO public.customers (
    shop_id, id, name, phone, notes, total_owed_ngwee,
    is_demo, created_at, updated_at
  )
  SELECT
    p_shop_id, id, name, phone, notes, computed_owed_ngwee,
    is_demo, created_at, updated_at
  FROM pg_temp.tmp_backup_customers;

  INSERT INTO public.sales (
    shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
    missing_cost_revenue_ngwee, payment_type, momo_operator, customer_id,
    customer_name, customer_phone, receipt_number, payment_reference,
    note, local_date, cash_tendered_ngwee, change_given_ngwee,
    is_deleted, is_demo, created_at, updated_at
  )
  SELECT
    p_shop_id, id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
    missing_cost_revenue_ngwee, payment_type, momo_operator, customer_id,
    customer_name, customer_phone, receipt_number, payment_reference,
    note, local_date, cash_tendered_ngwee, change_given_ngwee,
    is_deleted, is_demo, created_at, updated_at
  FROM pg_temp.tmp_backup_sales;

  INSERT INTO public.sale_lines (
    shop_id, id, sale_id, line_index, item_id, item_name, unit_label,
    quantity, buying_price_ngwee, buying_price_known,
    selling_price_ngwee, line_total_ngwee, created_at
  )
  SELECT
    p_shop_id, id, sale_id, line_index, item_id, item_name, unit_label,
    quantity, buying_price_ngwee, buying_price_known,
    selling_price_ngwee, line_total_ngwee, created_at
  FROM pg_temp.tmp_backup_sale_lines;

  INSERT INTO public.credit_payments (
    shop_id, id, customer_id, customer_name, amount_ngwee, payment_method,
    note, local_date, is_demo, created_at
  )
  SELECT
    p_shop_id, id, customer_id, customer_name, amount_ngwee, payment_method,
    note, local_date, is_demo, created_at
  FROM pg_temp.tmp_backup_payments;

  INSERT INTO public.expenses (
    shop_id, id, category, amount_ngwee, note, is_deleted, created_at
  )
  SELECT
    p_shop_id, id, category, amount_ngwee, note, is_deleted, created_at
  FROM pg_temp.tmp_backup_expenses;

  INSERT INTO public.stock_movements (
    shop_id, id, item_id, item_name, type, delta, previous_quantity, new_quantity,
    reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
  )
  SELECT
    p_shop_id, id, item_id, item_name, type, delta, previous_quantity, new_quantity,
    reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
  FROM pg_temp.tmp_backup_movements;

  v_recon := public.reconcile_shop_ledger(p_shop_id);
  IF COALESCE((v_recon ->> 'total_differences')::integer, 1) <> 0 THEN
    RAISE EXCEPTION 'Backup restore failed ledger reconciliation (% difference(s)); rolled back.',
      COALESCE(v_recon ->> 'total_differences', '?')
      USING ERRCODE = '23514', DETAIL = 'RECONCILIATION_FAILED';
  END IF;

  INSERT INTO public.sync_operations (
    shop_id, operation_id, operation_type, outcome, applied_at
  ) VALUES (
    p_shop_id, p_op_id, 'backup_import', 'applied', v_now
  ) ON CONFLICT (shop_id, operation_id) DO NOTHING;

  INSERT INTO public.sync_operations (
    shop_id, operation_id, operation_type, outcome, applied_at
  ) VALUES (
    p_shop_id, v_sha_marker_id, 'backup_import', 'applied', v_now
  ) ON CONFLICT (shop_id, operation_id) DO NOTHING;

  INSERT INTO public.platform_audit (
    action,
    actor_user_id,
    shop_id,
    reason,
    metadata,
    created_at
  ) VALUES (
    'shop_backup_imported',
    p_actor_uid,
    p_shop_id,
    'Backup restored (' || p_format || ')',
    pg_catalog.jsonb_build_object(
      'format', p_format,
      'file_sha256', p_effective_sha,
      'operation_id', p_op_id,
      'allow_non_empty_shop', COALESCE(p_allow_non_empty_shop, false),
      'preview', v_preview
    ),
    v_now
  );

  UPDATE public.shops
     SET last_server_contact_at = GREATEST(last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'imported',
    'dry_run', false,
    'idempotent', false,
    'already_imported', false,
    'shop_has_existing_data', p_shop_has_data,
    'file_sha256', p_effective_sha,
    'preview', v_preview,
    'reconciliation', v_recon
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commit_populated_backup_temp_tables(
  uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_populated_backup_temp_tables(
  uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean
) TO service_role;

-- Internal helper: creates/truncates `pg_temp.tmp_backup_*` tables for the
-- current transaction.
CREATE OR REPLACE FUNCTION public.ensure_backup_temp_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_items (
    id text PRIMARY KEY,
    name text NOT NULL,
    unit_label text NOT NULL,
    buying_price_ngwee bigint NOT NULL,
    buying_price_known boolean NOT NULL,
    selling_price_ngwee bigint NOT NULL,
    quantity integer NOT NULL,
    low_stock_threshold integer NOT NULL,
    is_deleted boolean NOT NULL,
    is_demo boolean NOT NULL,
    last_sold_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_customers (
    id text PRIMARY KEY,
    name text NOT NULL,
    phone text NOT NULL,
    notes text NOT NULL,
    expected_owed_ngwee bigint,
    computed_owed_ngwee bigint NOT NULL DEFAULT 0,
    is_demo boolean NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_sales (
    id text PRIMARY KEY,
    items_count integer NOT NULL,
    total_amount_ngwee bigint NOT NULL,
    total_cost_ngwee bigint NOT NULL,
    profit_ngwee bigint NOT NULL,
    missing_cost_revenue_ngwee bigint NOT NULL,
    payment_type text NOT NULL,
    momo_operator text,
    customer_id text,
    customer_name text,
    customer_phone text,
    receipt_number text NOT NULL,
    payment_reference text,
    note text,
    local_date text,
    cash_tendered_ngwee bigint,
    change_given_ngwee bigint,
    is_deleted boolean NOT NULL,
    is_demo boolean NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_sale_lines (
    id text PRIMARY KEY,
    sale_id text NOT NULL,
    line_index integer NOT NULL,
    item_id text NOT NULL,
    item_name text NOT NULL,
    unit_label text NOT NULL,
    quantity integer NOT NULL,
    buying_price_ngwee bigint NOT NULL,
    buying_price_known boolean NOT NULL,
    selling_price_ngwee bigint NOT NULL,
    line_total_ngwee bigint NOT NULL,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_payments (
    id text PRIMARY KEY,
    customer_id text NOT NULL,
    customer_name text NOT NULL,
    amount_ngwee bigint NOT NULL,
    payment_method text NOT NULL,
    note text NOT NULL,
    local_date text,
    is_demo boolean NOT NULL,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_expenses (
    id text PRIMARY KEY,
    category text NOT NULL,
    amount_ngwee bigint NOT NULL,
    note text NOT NULL,
    is_deleted boolean NOT NULL,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.tmp_backup_movements (
    id text PRIMARY KEY,
    item_id text NOT NULL,
    item_name text NOT NULL,
    type text NOT NULL,
    delta integer NOT NULL,
    previous_quantity integer NOT NULL,
    new_quantity integer NOT NULL,
    reason text NOT NULL,
    related_sale_id text,
    requested_quantity integer,
    recount_needed boolean NOT NULL,
    is_demo boolean NOT NULL,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  TRUNCATE
    pg_temp.tmp_backup_items,
    pg_temp.tmp_backup_customers,
    pg_temp.tmp_backup_sales,
    pg_temp.tmp_backup_sale_lines,
    pg_temp.tmp_backup_payments,
    pg_temp.tmp_backup_expenses,
    pg_temp.tmp_backup_movements;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_backup_temp_tables()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_backup_temp_tables()
  TO service_role;

-- Internal set-based loader for canonical v2 arrays (used by BOTH single-call
-- `import_shop_backup` on `countup-backup-v2` AND chunked `finalize_shop_backup_import`).
CREATE OR REPLACE FUNCTION public.load_v2_json_arrays_into_temp_tables(
  p_items jsonb,
  p_archived_items jsonb,
  p_customers jsonb,
  p_sales jsonb,
  p_credit_payments jsonb,
  p_expenses jsonb,
  p_stock_movements jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 1. Items + archivedItems
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT elem FROM pg_catalog.jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS a(elem)
        UNION ALL
        SELECT elem FROM pg_catalog.jsonb_array_elements(COALESCE(p_archived_items, '[]'::jsonb)) AS b(elem)
      ) c
     WHERE pg_catalog.jsonb_typeof(c.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(c.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR pg_catalog.btrim(COALESCE(c.elem ->> 'name', '')) = ''
        OR pg_catalog.char_length(c.elem ->> 'name') > 200
  ) THEN
    RAISE EXCEPTION 'Invalid item record, ID, or name in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_items (
      id, name, unit_label, buying_price_ngwee, buying_price_known,
      selling_price_ngwee, quantity, low_stock_threshold, is_deleted,
      is_demo, last_sold_at, created_at, updated_at
    )
    SELECT
      pg_catalog.btrim(c.elem ->> 'id'),
      pg_catalog.btrim(c.elem ->> 'name'),
      pg_catalog.left(COALESCE(c.elem ->> 'unitLabel', ''), 60),
      CASE
        WHEN CASE
          WHEN (c.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(c.elem -> 'buyingPriceKnown') = 'boolean'
            THEN (c.elem -> 'buyingPriceKnown')::boolean
          ELSE true
        END THEN public.parse_strict_kwacha_to_ngwee(COALESCE(c.elem -> 'buyingPrice', '0'::jsonb), 'items.buyingPrice', true)
        ELSE 0
      END,
      CASE
        WHEN (c.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(c.elem -> 'buyingPriceKnown') = 'boolean'
          THEN (c.elem -> 'buyingPriceKnown')::boolean
        ELSE true
      END,
      public.parse_strict_kwacha_to_ngwee(c.elem -> 'sellingPrice', 'items.sellingPrice', false),
      public.parse_strict_bounded_int(c.elem -> 'quantity', 'items.quantity', 0, 1000000),
      public.parse_strict_bounded_int(COALESCE(c.elem -> 'lowStockThreshold', '5'::jsonb), 'items.lowStockThreshold', 0, 1000000),
      c.is_arch OR COALESCE((c.elem -> 'isDeleted')::boolean, false),
      COALESCE((c.elem -> 'isDemo')::boolean, false),
      CASE WHEN NULLIF(c.elem ->> 'lastSoldAt', '') IS NOT NULL THEN (c.elem ->> 'lastSoldAt')::timestamptz ELSE NULL END,
      (c.elem ->> 'createdAt')::timestamptz,
      COALESCE((c.elem ->> 'updatedAt')::timestamptz, (c.elem ->> 'createdAt')::timestamptz)
    FROM (
      SELECT elem, false AS is_arch FROM pg_catalog.jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS a(elem)
      UNION ALL
      SELECT elem, true AS is_arch FROM pg_catalog.jsonb_array_elements(COALESCE(p_archived_items, '[]'::jsonb)) AS b(elem)
    ) c;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate item IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;

  -- 2. Customers
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_customers, '[]'::jsonb)) AS t(elem)
     WHERE pg_catalog.jsonb_typeof(t.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'name', '')) = ''
        OR pg_catalog.char_length(t.elem ->> 'name') > 200
  ) THEN
    RAISE EXCEPTION 'Invalid customer record, ID, or name in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_customers (
      id, name, phone, notes, expected_owed_ngwee, computed_owed_ngwee,
      is_demo, created_at, updated_at
    )
    SELECT
      pg_catalog.btrim(t.elem ->> 'id'),
      pg_catalog.btrim(t.elem ->> 'name'),
      pg_catalog.left(COALESCE(t.elem ->> 'phone', ''), 40),
      pg_catalog.left(COALESCE(t.elem ->> 'notes', ''), 500),
      public.parse_strict_kwacha_to_ngwee(t.elem -> 'totalOwed', 'customers.totalOwed', true),
      0,
      COALESCE((t.elem -> 'isDemo')::boolean, false),
      (t.elem ->> 'createdAt')::timestamptz,
      COALESCE((t.elem ->> 'updatedAt')::timestamptz, (t.elem ->> 'createdAt')::timestamptz)
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_customers, '[]'::jsonb)) AS t(elem);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate customer IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;

  -- 3. Sales + embedded sale lines
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_sales, '[]'::jsonb)) AS t(elem)
     WHERE pg_catalog.jsonb_typeof(t.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR pg_catalog.jsonb_typeof(t.elem -> 'items') <> 'array'
        OR pg_catalog.jsonb_array_length(t.elem -> 'items') < 1
        OR pg_catalog.jsonb_array_length(t.elem -> 'items') > 160
        OR COALESCE(t.elem ->> 'paymentType', '') NOT IN ('cash', 'momo', 'credit')
        OR (
          NULLIF(pg_catalog.btrim(COALESCE(t.elem ->> 'momoOperator', '')), '') IS NOT NULL
          AND pg_catalog.btrim(t.elem ->> 'momoOperator') NOT IN ('airtel', 'mtn', 'zamtel')
        )
  ) THEN
    RAISE EXCEPTION 'Invalid sale record, line count, paymentType, or momoOperator in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_sales (
      id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
      missing_cost_revenue_ngwee, payment_type, momo_operator, customer_id,
      customer_name, customer_phone, receipt_number, payment_reference,
      note, local_date, cash_tendered_ngwee, change_given_ngwee,
      is_deleted, is_demo, created_at, updated_at
    )
    SELECT
      s.sale_id,
      s.items_count,
      s.total_ngwee,
      s.cost_ngwee,
      CASE
        WHEN s.declared_profit_ngwee IS NOT NULL THEN s.declared_profit_ngwee
        ELSE (s.total_ngwee - s.cost_ngwee - s.missing_ngwee)
      END,
      s.missing_ngwee,
      s.pay_type,
      CASE WHEN s.pay_type = 'momo' THEN s.momo_op ELSE NULL END,
      s.cust_id,
      NULLIF(pg_catalog.left(COALESCE(s.elem ->> 'customerName', ''), 200), ''),
      NULLIF(pg_catalog.left(COALESCE(s.elem ->> 'customerPhone', ''), 40), ''),
      pg_catalog.left(pg_catalog.btrim(COALESCE(NULLIF(s.elem ->> 'receiptNumber', ''), s.sale_id)), 120),
      NULLIF(pg_catalog.left(COALESCE(s.elem ->> 'paymentReference', ''), 120), ''),
      NULLIF(pg_catalog.left(COALESCE(s.elem ->> 'note', ''), 500), ''),
      NULLIF(pg_catalog.btrim(COALESCE(s.elem ->> 'localDate', '')), ''),
      s.cash_tendered,
      CASE WHEN s.cash_tendered IS NOT NULL THEN s.cash_tendered - s.total_ngwee ELSE NULL END,
      COALESCE((s.elem -> 'isDeleted')::boolean, false),
      COALESCE((s.elem -> 'isDemo')::boolean, false),
      s.created_at,
      s.created_at
    FROM (
      SELECT
        t.elem,
        pg_catalog.btrim(t.elem ->> 'id') AS sale_id,
        t.elem ->> 'paymentType' AS pay_type,
        NULLIF(pg_catalog.btrim(COALESCE(t.elem ->> 'momoOperator', '')), '') AS momo_op,
        NULLIF(pg_catalog.btrim(COALESCE(t.elem ->> 'customerId', '')), '') AS cust_id,
        public.parse_strict_bounded_int(t.elem -> 'itemsCount', 'sales.itemsCount', 1, 1000000) AS items_count,
        public.parse_strict_kwacha_to_ngwee(t.elem -> 'totalAmount', 'sales.totalAmount', false) AS total_ngwee,
        public.parse_strict_kwacha_to_ngwee(COALESCE(t.elem -> 'totalCost', '0'::jsonb), 'sales.totalCost', true) AS cost_ngwee,
        public.parse_strict_kwacha_to_ngwee(COALESCE(t.elem -> 'missingCostRevenue', '0'::jsonb), 'sales.missingCostRevenue', true) AS missing_ngwee,
        CASE
          WHEN (t.elem ? 'profit') AND (t.elem -> 'profit') IS NOT NULL AND pg_catalog.jsonb_typeof(t.elem -> 'profit') <> 'null'
            THEN public.parse_strict_signed_kwacha_to_ngwee(t.elem -> 'profit', 'sales.profit')
          ELSE NULL
        END AS declared_profit_ngwee,
        CASE
          WHEN (t.elem ? 'cashTendered') AND (t.elem -> 'cashTendered') IS NOT NULL AND pg_catalog.jsonb_typeof(t.elem -> 'cashTendered') <> 'null'
            THEN public.parse_strict_kwacha_to_ngwee(t.elem -> 'cashTendered', 'sales.cashTendered', false)
          ELSE NULL
        END AS cash_tendered,
        (t.elem ->> 'createdAt')::timestamptz AS created_at
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_sales, '[]'::jsonb)) AS t(elem)
    ) s;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate sale IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_sales s
     WHERE s.cash_tendered_ngwee IS NOT NULL
       AND s.cash_tendered_ngwee < s.total_amount_ngwee
  ) THEN
    RAISE EXCEPTION 'A sale in backup has cashTendered less than totalAmount.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_CASH_TENDERED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_sales, '[]'::jsonb)) AS s(elem)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(s.elem -> 'items') AS l(elem)
     WHERE pg_catalog.jsonb_typeof(l.elem) <> 'object'
        OR (
          (l.elem ? 'total')
          AND (l.elem -> 'total') IS NOT NULL
          AND pg_catalog.jsonb_typeof(l.elem -> 'total') <> 'null'
          AND public.parse_strict_kwacha_to_ngwee(l.elem -> 'total', 'sale.items.total', false)
              <> (
                public.parse_strict_kwacha_to_ngwee(l.elem -> 'sellingPrice', 'sale.items.sellingPrice', false)
                * public.parse_strict_bounded_int(l.elem -> 'quantity', 'sale.items.quantity', 1, 1000000)
              )
        )
  ) THEN
    RAISE EXCEPTION 'A line item on a sale is invalid or its total does not match sellingPrice * quantity.'
      USING ERRCODE = '22023', DETAIL = 'SALE_LINE_TOTAL_MISMATCH';
  END IF;

  INSERT INTO pg_temp.tmp_backup_sale_lines (
    id, sale_id, line_index, item_id, item_name, unit_label,
    quantity, buying_price_ngwee, buying_price_known,
    selling_price_ngwee, line_total_ngwee, created_at
  )
  SELECT
    CASE
      WHEN pg_catalog.char_length(sl.sale_id || ':' || sl.idx::text) <= 160
        THEN sl.sale_id || ':' || sl.idx::text
      ELSE 'sl_' || pg_catalog.md5(sl.sale_id || ':' || sl.idx::text)
    END,
    sl.sale_id,
    sl.idx,
    sl.item_id,
    pg_catalog.left(pg_catalog.btrim(COALESCE(sl.line_elem ->> 'name', 'Item')), 200),
    pg_catalog.left(COALESCE(sl.line_elem ->> 'unitLabel', ''), 60),
    sl.qty,
    CASE WHEN sl.buying_known THEN sl.buying_ngwee ELSE 0 END,
    sl.buying_known,
    sl.selling_ngwee,
    sl.selling_ngwee * sl.qty,
    sl.created_at
  FROM (
    SELECT
      pg_catalog.btrim(s.elem ->> 'id') AS sale_id,
      (s.elem ->> 'createdAt')::timestamptz AS created_at,
      (l.ord - 1)::integer AS idx,
      l.elem AS line_elem,
      pg_catalog.btrim(COALESCE(l.elem ->> 'itemId', '')) AS item_id,
      public.parse_strict_bounded_int(l.elem -> 'quantity', 'sale.items.quantity', 1, 1000000) AS qty,
      public.parse_strict_kwacha_to_ngwee(l.elem -> 'sellingPrice', 'sale.items.sellingPrice', false) AS selling_ngwee,
      CASE
        WHEN (l.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(l.elem -> 'buyingPriceKnown') = 'boolean'
          THEN (l.elem -> 'buyingPriceKnown')::boolean
        ELSE true
      END AS buying_known,
      CASE
        WHEN CASE
          WHEN (l.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(l.elem -> 'buyingPriceKnown') = 'boolean'
            THEN (l.elem -> 'buyingPriceKnown')::boolean
          ELSE true
        END THEN public.parse_strict_kwacha_to_ngwee(COALESCE(l.elem -> 'buyingPrice', '0'::jsonb), 'sale.items.buyingPrice', true)
        ELSE 0
      END AS buying_ngwee
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_sales, '[]'::jsonb)) AS s(elem)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(s.elem -> 'items') WITH ORDINALITY AS l(elem, ord)
  ) sl;

  -- 4. Credit payments
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_credit_payments, '[]'::jsonb)) AS t(elem)
     WHERE pg_catalog.jsonb_typeof(t.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR COALESCE(t.elem ->> 'paymentMethod', 'cash') NOT IN ('cash', 'momo')
  ) THEN
    RAISE EXCEPTION 'Invalid creditPayment record, ID, or paymentMethod in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_payments (
      id, customer_id, customer_name, amount_ngwee, payment_method,
      note, local_date, is_demo, created_at
    )
    SELECT
      pg_catalog.btrim(t.elem ->> 'id'),
      pg_catalog.btrim(COALESCE(t.elem ->> 'customerId', '')),
      pg_catalog.left(pg_catalog.btrim(COALESCE(t.elem ->> 'customerName', 'Customer')), 200),
      public.parse_strict_kwacha_to_ngwee(t.elem -> 'amount', 'creditPayments.amount', false),
      COALESCE(t.elem ->> 'paymentMethod', 'cash'),
      pg_catalog.left(COALESCE(t.elem ->> 'note', ''), 500),
      NULLIF(pg_catalog.btrim(COALESCE(t.elem ->> 'localDate', '')), ''),
      COALESCE((t.elem -> 'isDemo')::boolean, false),
      (t.elem ->> 'createdAt')::timestamptz
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_credit_payments, '[]'::jsonb)) AS t(elem);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate creditPayment IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;

  -- Set-based customer credit balance computation (credit sales - repayments)
  UPDATE pg_temp.tmp_backup_customers c
     SET computed_owed_ngwee =
       COALESCE((
         SELECT SUM(s.total_amount_ngwee)
           FROM pg_temp.tmp_backup_sales s
          WHERE s.customer_id = c.id
            AND s.payment_type = 'credit'
            AND NOT s.is_deleted
       ), 0)
       - COALESCE((
         SELECT SUM(cp.amount_ngwee)
           FROM pg_temp.tmp_backup_payments cp
          WHERE cp.customer_id = c.id
       ), 0);

  -- 5. Expenses
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_expenses, '[]'::jsonb)) AS t(elem)
     WHERE pg_catalog.jsonb_typeof(t.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR COALESCE(t.elem ->> 'category', '') NOT IN ('rent', 'transport', 'restock', 'council_fee', 'helper_wage', 'other')
  ) THEN
    RAISE EXCEPTION 'Invalid expense record, ID, or category in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_EXPENSE_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_expenses (
      id, category, amount_ngwee, note, is_deleted, created_at
    )
    SELECT
      pg_catalog.btrim(t.elem ->> 'id'),
      t.elem ->> 'category',
      public.parse_strict_kwacha_to_ngwee(t.elem -> 'amount', 'expenses.amount', false),
      pg_catalog.left(COALESCE(t.elem ->> 'note', ''), 500),
      COALESCE((t.elem -> 'isDeleted')::boolean, false),
      (t.elem ->> 'createdAt')::timestamptz
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_expenses, '[]'::jsonb)) AS t(elem);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate expense IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;

  -- 6. Stock movements
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_stock_movements, '[]'::jsonb)) AS t(elem)
     WHERE pg_catalog.jsonb_typeof(t.elem) <> 'object'
        OR pg_catalog.btrim(COALESCE(t.elem ->> 'id', '')) !~ '^[A-Za-z0-9_:-]{1,120}$'
        OR COALESCE(t.elem ->> 'type', '') NOT IN ('initial', 'sale', 'restock', 'adjustment', 'void')
  ) THEN
    RAISE EXCEPTION 'Invalid stockMovement record, ID, or type in backup.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_RECORD';
  END IF;

  BEGIN
    INSERT INTO pg_temp.tmp_backup_movements (
      id, item_id, item_name, type, delta, previous_quantity, new_quantity,
      reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
    )
    SELECT
      pg_catalog.btrim(t.elem ->> 'id'),
      pg_catalog.btrim(COALESCE(t.elem ->> 'itemId', '')),
      pg_catalog.left(pg_catalog.btrim(COALESCE(t.elem ->> 'itemName', 'Item')), 200),
      t.elem ->> 'type',
      public.parse_strict_bounded_int(t.elem -> 'delta', 'stockMovements.delta', -1000000, 1000000),
      public.parse_strict_bounded_int(t.elem -> 'previousQuantity', 'stockMovements.previousQuantity', 0, 1000000),
      public.parse_strict_bounded_int(t.elem -> 'newQuantity', 'stockMovements.newQuantity', 0, 1000000),
      pg_catalog.left(COALESCE(t.elem ->> 'reason', ''), 500),
      NULLIF(pg_catalog.btrim(COALESCE(t.elem ->> 'relatedSaleId', '')), ''),
      CASE
        WHEN (t.elem ? 'requestedQuantity') AND (t.elem -> 'requestedQuantity') IS NOT NULL AND pg_catalog.jsonb_typeof(t.elem -> 'requestedQuantity') <> 'null'
          THEN public.parse_strict_bounded_int(t.elem -> 'requestedQuantity', 'stockMovements.requestedQuantity', 0, 1000000)
        ELSE NULL
      END,
      COALESCE((t.elem -> 'recountNeeded')::boolean, false),
      COALESCE((t.elem -> 'isDemo')::boolean, false),
      (t.elem ->> 'createdAt')::timestamptz
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_stock_movements, '[]'::jsonb)) AS t(elem);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Backup has duplicate stockMovement IDs.'
        USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.load_v2_json_arrays_into_temp_tables(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_v2_json_arrays_into_temp_tables(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) TO service_role;

-- Update single-call `public.import_shop_backup` to use raised 2-year+ caps
-- (50,000 primary / 200,000 total rows including `sale_lines` + `stock_movements`)
-- and fast set-based loading for `countup-backup-v2`.
CREATE OR REPLACE FUNCTION public.import_shop_backup(
  p_shop_id uuid,
  p_operation_id text,
  p_file_sha256 text,
  p_backup jsonb,
  p_dry_run boolean DEFAULT true,
  p_allow_non_empty_shop boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '60s'
AS $$
DECLARE
  v_shop public.shops;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor_uid uuid := auth.uid();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_raw_sha text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_file_sha256, '')));
  v_effective_sha text;
  v_sha_marker_id text;
  v_already_imported boolean := false;
  v_shop_has_data boolean := false;
  v_recent_hour_imports integer := 0;
  v_recent_day_imports integer := 0;
  v_payload_bytes integer;
  v_format text;
  v_source_shop_name text := '';
  v_bad_key text;
  v_rec record;
  v_line record;
  v_item_id text;
  v_cust_id text;
  v_sale_id text;
  v_line_id text;
  v_pay_id text;
  v_mv_id text;
  v_buying_known boolean;
  v_buying_ngwee bigint;
  v_selling_ngwee bigint;
  v_qty integer;
  v_threshold integer;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_pay_type text;
  v_total_ngwee bigint;
  v_cost_ngwee bigint;
  v_missing_ngwee bigint;
  v_profit_ngwee bigint;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid backup operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  IF p_backup IS NULL OR pg_catalog.jsonb_typeof(p_backup) <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: expected a JSON object.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_ROOT';
  END IF;

  v_payload_bytes := pg_catalog.octet_length(p_backup::text);
  IF v_payload_bytes > 5000000 THEN
    RAISE EXCEPTION 'The backup exceeds the 5 MB maximum size limit.'
      USING ERRCODE = '22023', DETAIL = 'PAYLOAD_TOO_LARGE';
  END IF;

  IF v_raw_sha <> '' THEN
    IF v_raw_sha !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid backup SHA-256 checksum.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_FILE_HASH';
    END IF;
    v_effective_sha := v_raw_sha;
  ELSE
    v_effective_sha := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_backup::text, 'UTF8')),
      'hex'
    );
  END IF;
  v_sha_marker_id := 'backup_sha256:' || v_effective_sha;

  SELECT EXISTS (
    SELECT 1
      FROM public.sync_operations so
     WHERE so.shop_id = p_shop_id
       AND so.operation_id IN (v_op_id, v_sha_marker_id)
  ) INTO v_already_imported;

  SELECT (
    EXISTS (SELECT 1 FROM public.items i WHERE i.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.sales s WHERE s.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.customers c WHERE c.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.credit_payments cp WHERE cp.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.shop_id = p_shop_id)
  ) INTO v_shop_has_data;

  IF NOT v_already_imported AND NOT COALESCE(p_dry_run, true) THEN
    SELECT
      COUNT(*) FILTER (WHERE pa.created_at >= v_now - interval '1 hour')::integer,
      COUNT(*)::integer
      INTO v_recent_hour_imports, v_recent_day_imports
      FROM public.platform_audit pa
     WHERE pa.shop_id = p_shop_id
       AND pa.action = 'shop_backup_imported'
       AND pa.created_at >= v_now - interval '24 hours';

    IF v_recent_hour_imports >= 5 OR v_recent_day_imports >= 10 THEN
      RAISE EXCEPTION 'Too many backup restore attempts for this shop. Please wait before trying again.'
        USING ERRCODE = 'P0001', DETAIL = 'BACKUP_IMPORT_RATE_LIMITED';
    END IF;
  END IF;

  v_format := COALESCE(p_backup ->> 'format', '');
  IF v_format NOT IN ('shopbook-backup-v1', 'countup-backup-v2') THEN
    RAISE EXCEPTION 'Unsupported backup format. Choose a shopbook-backup-v1 or countup-backup-v2 JSON file.'
      USING ERRCODE = '22023', DETAIL = 'UNSUPPORTED_BACKUP_FORMAT';
  END IF;

  IF v_format = 'shopbook-backup-v1' THEN
    SELECT k
      INTO v_bad_key
      FROM pg_catalog.jsonb_object_keys(p_backup) AS k
     WHERE k NOT IN (
       'format', 'exportedAt', 'shopSettings', 'products', 'customers',
       'sales', 'saleItems', 'stockMovements', 'creditTransactions', 'expenses'
     )
     LIMIT 1;
  ELSE
    SELECT k
      INTO v_bad_key
      FROM pg_catalog.jsonb_object_keys(p_backup) AS k
     WHERE k NOT IN (
       'format', 'version', 'exportedAt', 'shop', 'subscription', 'items',
       'archivedItems', 'sales', 'customers', 'creditPayments', 'expenses',
       'stockMovements', 'stockConflicts'
     )
     LIMIT 1;
  END IF;

  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Backup contains an unsupported record type "%".', pg_catalog.left(v_bad_key, 40)
      USING ERRCODE = '22023', DETAIL = 'UNKNOWN_RECORD_TYPE';
  END IF;

  PERFORM public.ensure_backup_temp_tables();

  IF v_format = 'shopbook-backup-v1' THEN
    IF pg_catalog.jsonb_typeof(p_backup -> 'shopSettings') <> 'object'
       OR pg_catalog.jsonb_typeof(p_backup -> 'products') <> 'array'
       OR pg_catalog.jsonb_typeof(p_backup -> 'customers') <> 'array'
       OR pg_catalog.jsonb_typeof(p_backup -> 'sales') <> 'array'
       OR pg_catalog.jsonb_typeof(p_backup -> 'saleItems') <> 'array'
       OR pg_catalog.jsonb_typeof(p_backup -> 'stockMovements') <> 'array'
       OR pg_catalog.jsonb_typeof(p_backup -> 'creditTransactions') <> 'array'
    THEN
      RAISE EXCEPTION 'Invalid shopbook-backup-v1 structure: missing required arrays.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;

    IF (p_backup ? 'expenses') AND pg_catalog.jsonb_typeof(p_backup -> 'expenses') <> 'array' THEN
      RAISE EXCEPTION 'Invalid expenses collection in backup.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;

    IF pg_catalog.jsonb_array_length(p_backup -> 'products') > 5000
       OR pg_catalog.jsonb_array_length(p_backup -> 'customers') > 5000
       OR pg_catalog.jsonb_array_length(p_backup -> 'sales') > 30000
       OR pg_catalog.jsonb_array_length(p_backup -> 'saleItems') > 80000
       OR pg_catalog.jsonb_array_length(p_backup -> 'stockMovements') > 80000
       OR pg_catalog.jsonb_array_length(p_backup -> 'creditTransactions') > 40000
    THEN
      RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
        USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
    END IF;

    v_source_shop_name := pg_catalog.left(
      pg_catalog.btrim(COALESCE(p_backup #>> '{shopSettings,shopName}', '')),
      120
    );

    FOR v_rec IN
      SELECT elem, ord
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'products') WITH ORDINALITY AS t(elem, ord)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid product record at index %.', v_rec.ord - 1
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_RECORD';
      END IF;
      v_item_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_item_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
        RAISE EXCEPTION 'Invalid product ID "%".', pg_catalog.left(v_item_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_ID';
      END IF;
      v_item_id := 'shopbook_' || v_item_id;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items WHERE id = v_item_id) THEN
        RAISE EXCEPTION 'Backup has duplicate product IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;
      IF pg_catalog.btrim(COALESCE(v_rec.elem ->> 'name', '')) = ''
         OR pg_catalog.char_length(v_rec.elem ->> 'name') > 200
      THEN
        RAISE EXCEPTION 'Invalid product name on "%".', v_item_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_NAME';
      END IF;

      v_selling_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'sellingPriceNgwee', 'products.sellingPriceNgwee', false);
      IF (v_rec.elem -> 'costPriceNgwee') IS NULL OR pg_catalog.jsonb_typeof(v_rec.elem -> 'costPriceNgwee') = 'null' THEN
        v_buying_known := false;
        v_buying_ngwee := 0;
      ELSE
        v_buying_known := true;
        v_buying_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'costPriceNgwee', 'products.costPriceNgwee', true);
      END IF;

      v_qty := public.parse_strict_bounded_int(v_rec.elem -> 'stockQty', 'products.stockQty', 0, 1000000);
      v_threshold := public.parse_strict_bounded_int(v_rec.elem -> 'lowStockThreshold', 'products.lowStockThreshold', 0, 1000000);
      IF pg_catalog.jsonb_typeof(v_rec.elem -> 'isArchived') <> 'boolean' THEN
        RAISE EXCEPTION 'Invalid isArchived flag on product "%".', v_item_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_BOOLEAN';
      END IF;
      v_created_at := (v_rec.elem ->> 'createdAt')::timestamptz;
      v_updated_at := (v_rec.elem ->> 'updatedAt')::timestamptz;

      INSERT INTO pg_temp.tmp_backup_items (
        id, name, unit_label, buying_price_ngwee, buying_price_known,
        selling_price_ngwee, quantity, low_stock_threshold, is_deleted,
        is_demo, last_sold_at, created_at, updated_at
      ) VALUES (
        v_item_id,
        pg_catalog.btrim(v_rec.elem ->> 'name'),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'unitLabel', ''), 60),
        v_buying_ngwee,
        v_buying_known,
        v_selling_ngwee,
        v_qty,
        v_threshold,
        (v_rec.elem -> 'isArchived')::boolean,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        NULL,
        v_created_at,
        v_updated_at
      );
    END LOOP;

    FOR v_rec IN
      SELECT elem, ord
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'customers') WITH ORDINALITY AS t(elem, ord)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid customer record at index %.', v_rec.ord - 1
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_RECORD';
      END IF;
      v_cust_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_cust_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
        RAISE EXCEPTION 'Invalid customer ID "%".', pg_catalog.left(v_cust_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_ID';
      END IF;
      v_cust_id := 'shopbook_' || v_cust_id;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers WHERE id = v_cust_id) THEN
        RAISE EXCEPTION 'Backup has duplicate customer IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;
      IF pg_catalog.btrim(COALESCE(v_rec.elem ->> 'name', '')) = ''
         OR pg_catalog.char_length(v_rec.elem ->> 'name') > 200
      THEN
        RAISE EXCEPTION 'Invalid customer name on "%".', v_cust_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_NAME';
      END IF;

      INSERT INTO pg_temp.tmp_backup_customers (
        id, name, phone, notes, expected_owed_ngwee, computed_owed_ngwee,
        is_demo, created_at, updated_at
      ) VALUES (
        v_cust_id,
        pg_catalog.btrim(v_rec.elem ->> 'name'),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'phone', ''), 40),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'notes', ''), 500),
        NULL,
        0,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz,
        (v_rec.elem ->> 'updatedAt')::timestamptz
      );
    END LOOP;

    FOR v_rec IN
      SELECT elem, ord
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'sales') WITH ORDINALITY AS t(elem, ord)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid sale record at index %.', v_rec.ord - 1
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_RECORD';
      END IF;
      v_sale_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_sale_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
        RAISE EXCEPTION 'Invalid sale ID "%".', pg_catalog.left(v_sale_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_ID';
      END IF;
      v_sale_id := 'shopbook_' || v_sale_id;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales WHERE id = v_sale_id) THEN
        RAISE EXCEPTION 'Backup has duplicate sale IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;

      v_pay_type := COALESCE(v_rec.elem ->> 'paymentMethod', '');
      IF v_pay_type = 'mobile_money' THEN
        v_pay_type := 'momo';
      ELSIF v_pay_type NOT IN ('cash', 'credit') THEN
        RAISE EXCEPTION 'Invalid sale paymentMethod "%".', pg_catalog.left(v_pay_type, 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_TYPE';
      END IF;

      v_cust_id := NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerId', '')), '');
      IF v_cust_id IS NOT NULL THEN
        v_cust_id := 'shopbook_' || v_cust_id;
      END IF;

      v_total_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'totalNgwee', 'sales.totalNgwee', false);
      v_qty := public.parse_strict_bounded_int(v_rec.elem -> 'totalUnits', 'sales.totalUnits', 1, 1000000);
      v_cost_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'knownCostTotalNgwee', 'sales.knownCostTotalNgwee', true);
      v_missing_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'missingCostRevenueNgwee', 'sales.missingCostRevenueNgwee', true);
      IF public.parse_strict_integer_ngwee(v_rec.elem -> 'knownCostRevenueNgwee', 'sales.knownCostRevenueNgwee', true) + v_missing_ngwee <> v_total_ngwee THEN
        RAISE EXCEPTION 'The totals or cost snapshots on receipt % do not match its items.', COALESCE(v_rec.elem ->> 'receiptNumber', v_sale_id)
          USING ERRCODE = '22023', DETAIL = 'SALE_MATH_MISMATCH';
      END IF;
      v_profit_ngwee := v_total_ngwee - v_cost_ngwee - v_missing_ngwee;
      v_created_at := (v_rec.elem ->> 'createdAt')::timestamptz;

      INSERT INTO pg_temp.tmp_backup_sales (
        id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
        missing_cost_revenue_ngwee, payment_type, momo_operator, customer_id,
        customer_name, customer_phone, receipt_number, payment_reference,
        note, local_date, cash_tendered_ngwee, change_given_ngwee,
        is_deleted, is_demo, created_at, updated_at
      ) VALUES (
        v_sale_id, v_qty, v_total_ngwee, v_cost_ngwee, v_profit_ngwee,
        v_missing_ngwee, v_pay_type, NULL, v_cust_id,
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'customerNameSnapshot', ''), 200), ''),
        NULL,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'receiptNumber', v_sale_id)), 120),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'paymentReference', ''), 120), ''),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500), ''),
        NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'localDate', '')), ''),
        NULL, NULL, false,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        v_created_at, v_created_at
      );
    END LOOP;

    FOR v_line IN
      SELECT elem, (ord - 1)::integer AS idx
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'saleItems') WITH ORDINALITY AS t(elem, ord)
    LOOP
      IF pg_catalog.jsonb_typeof(v_line.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid sale item at index %.', v_line.idx
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINE';
      END IF;
      v_line_id := pg_catalog.btrim(COALESCE(v_line.elem ->> 'id', ''));
      IF v_line_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
        RAISE EXCEPTION 'Invalid sale item ID "%".', pg_catalog.left(v_line_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINE_ID';
      END IF;
      v_line_id := 'shopbook_' || v_line_id;
      v_sale_id := 'shopbook_' || pg_catalog.btrim(COALESCE(v_line.elem ->> 'saleId', ''));
      v_item_id := 'shopbook_' || pg_catalog.btrim(COALESCE(v_line.elem ->> 'productId', ''));

      v_selling_ngwee := public.parse_strict_integer_ngwee(v_line.elem -> 'sellingPriceAtSaleNgwee', 'saleItems.sellingPriceAtSaleNgwee', false);
      IF (v_line.elem -> 'costPriceAtSaleNgwee') IS NULL OR pg_catalog.jsonb_typeof(v_line.elem -> 'costPriceAtSaleNgwee') = 'null' THEN
        v_buying_known := false;
        v_buying_ngwee := 0;
      ELSE
        v_buying_known := true;
        v_buying_ngwee := public.parse_strict_integer_ngwee(v_line.elem -> 'costPriceAtSaleNgwee', 'saleItems.costPriceAtSaleNgwee', true);
      END IF;
      v_qty := public.parse_strict_bounded_int(v_line.elem -> 'quantity', 'saleItems.quantity', 1, 1000000);
      v_total_ngwee := public.parse_strict_integer_ngwee(v_line.elem -> 'lineTotalNgwee', 'saleItems.lineTotalNgwee', false);

      IF v_selling_ngwee * v_qty <> v_total_ngwee THEN
        RAISE EXCEPTION 'Sale item "%" total does not match selling price * quantity.', v_line_id
          USING ERRCODE = '22023', DETAIL = 'SALE_LINE_TOTAL_MISMATCH';
      END IF;

      INSERT INTO pg_temp.tmp_backup_sale_lines (
        id, sale_id, line_index, item_id, item_name, unit_label,
        quantity, buying_price_ngwee, buying_price_known,
        selling_price_ngwee, line_total_ngwee, created_at
      ) VALUES (
        v_line_id, v_sale_id, v_line.idx, v_item_id,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_line.elem ->> 'productNameAtSale', '')), 200),
        pg_catalog.left(COALESCE(v_line.elem ->> 'unitLabelAtSale', ''), 60),
        v_qty, v_buying_ngwee, v_buying_known, v_selling_ngwee, v_total_ngwee,
        (v_line.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;

    FOR v_rec IN
      SELECT elem, ord
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'creditTransactions') WITH ORDINALITY AS t(elem, ord)
        ORDER BY (elem ->> 'createdAt') ASC,
                 CASE WHEN (elem ->> 'type') = 'credit_sale' THEN 0 ELSE 1 END,
                 (elem ->> 'id') ASC
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid credit transaction at index %.', v_rec.ord - 1
          USING ERRCODE = '22023', DETAIL = 'INVALID_CREDIT_TX';
      END IF;
      v_cust_id := 'shopbook_' || pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerId', ''));
      IF NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers WHERE id = v_cust_id) THEN
        RAISE EXCEPTION 'Credit transaction refers to missing customer "%".', v_cust_id
          USING ERRCODE = '23503', DETAIL = 'MISSING_CUSTOMER_REF';
      END IF;
      v_total_ngwee := public.parse_strict_integer_ngwee(v_rec.elem -> 'amountNgwee', 'creditTransactions.amountNgwee', false);

      IF COALESCE(v_rec.elem ->> 'type', '') = 'credit_sale' THEN
        v_sale_id := 'shopbook_' || pg_catalog.btrim(COALESCE(v_rec.elem ->> 'relatedSaleId', ''));
        IF NOT EXISTS (
          SELECT 1
            FROM pg_temp.tmp_backup_sales s
           WHERE s.id = v_sale_id
             AND s.payment_type = 'credit'
             AND s.customer_id = v_cust_id
             AND s.total_amount_ngwee = v_total_ngwee
        ) THEN
          RAISE EXCEPTION 'Credit sale transaction does not match credit sale "%".', v_sale_id
            USING ERRCODE = '22023', DETAIL = 'CREDIT_TX_MISMATCH';
        END IF;
        UPDATE pg_temp.tmp_backup_customers
           SET computed_owed_ngwee = computed_owed_ngwee + v_total_ngwee
         WHERE id = v_cust_id;
      ELSIF COALESCE(v_rec.elem ->> 'type', '') = 'repayment' THEN
        v_pay_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
        IF v_pay_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
          RAISE EXCEPTION 'Invalid repayment ID "%".', pg_catalog.left(v_pay_id, 40)
            USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_ID';
        END IF;
        v_pay_id := 'shopbook_' || v_pay_id;
        v_pay_type := COALESCE(v_rec.elem ->> 'paymentMethod', '');
        IF v_pay_type = 'mobile_money' THEN
          v_pay_type := 'momo';
        ELSIF v_pay_type <> 'cash' THEN
          RAISE EXCEPTION 'Repayment "%" has invalid paymentMethod "%".', v_pay_id, pg_catalog.left(v_pay_type, 30)
            USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_METHOD';
        END IF;

        UPDATE pg_temp.tmp_backup_customers
           SET computed_owed_ngwee = computed_owed_ngwee - v_total_ngwee
         WHERE id = v_cust_id;

        IF (SELECT computed_owed_ngwee FROM pg_temp.tmp_backup_customers WHERE id = v_cust_id) < 0 THEN
          RAISE EXCEPTION 'Customer "%" has a negative credit balance in backup.', v_cust_id
            USING ERRCODE = '23514', DETAIL = 'NEGATIVE_CREDIT_BALANCE';
        END IF;

        INSERT INTO pg_temp.tmp_backup_payments (
          id, customer_id, customer_name, amount_ngwee, payment_method,
          note, local_date, is_demo, created_at
        ) VALUES (
          v_pay_id, v_cust_id,
          pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerNameSnapshot', 'Customer')), 200),
          v_total_ngwee, v_pay_type,
          pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500),
          NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'localDate', '')), ''),
          COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
          (v_rec.elem ->> 'createdAt')::timestamptz
        );
      ELSE
        RAISE EXCEPTION 'Unknown credit transaction type "%".', pg_catalog.left(COALESCE(v_rec.elem ->> 'type', ''), 40)
          USING ERRCODE = '22023', DETAIL = 'UNKNOWN_RECORD_TYPE';
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
        FROM pg_temp.tmp_backup_sales s
       WHERE s.payment_type = 'credit'
         AND (
           SELECT COUNT(*)
             FROM pg_catalog.jsonb_array_elements(p_backup -> 'creditTransactions') AS t(elem)
            WHERE (elem ->> 'type') = 'credit_sale'
              AND ('shopbook_' || COALESCE(elem ->> 'relatedSaleId', '')) = s.id
         ) <> 1
    ) THEN
      RAISE EXCEPTION 'A credit sale in backup is missing its matching credit ledger entry.'
        USING ERRCODE = '22023', DETAIL = 'CREDIT_TX_MISMATCH';
    END IF;

    FOR v_rec IN
      SELECT elem, ord
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'stockMovements') WITH ORDINALITY AS t(elem, ord)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid stock movement at index %.', v_rec.ord - 1
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_RECORD';
      END IF;
      v_mv_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_mv_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
        RAISE EXCEPTION 'Invalid stock movement ID "%".', pg_catalog.left(v_mv_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_ID';
      END IF;
      v_mv_id := 'shopbook_' || v_mv_id;
      v_item_id := 'shopbook_' || pg_catalog.btrim(COALESCE(v_rec.elem ->> 'productId', ''));
      v_sale_id := NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'relatedSaleId', '')), '');
      IF v_sale_id IS NOT NULL THEN
        v_sale_id := 'shopbook_' || v_sale_id;
      END IF;
      IF COALESCE(v_rec.elem ->> 'type', '') NOT IN ('initial', 'sale', 'restock', 'adjustment', 'void') THEN
        RAISE EXCEPTION 'Invalid stock movement type "%".', pg_catalog.left(COALESCE(v_rec.elem ->> 'type', ''), 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_TYPE';
      END IF;

      INSERT INTO pg_temp.tmp_backup_movements (
        id, item_id, item_name, type, delta, previous_quantity, new_quantity,
        reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
      ) VALUES (
        v_mv_id, v_item_id,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'productNameSnapshot', 'Item')), 200),
        v_rec.elem ->> 'type',
        public.parse_strict_bounded_int(v_rec.elem -> 'deltaQty', 'stockMovements.deltaQty', -1000000, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'previousQty', 'stockMovements.previousQty', 0, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'newQty', 'stockMovements.newQty', 0, 1000000),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'reason', ''), 500),
        v_sale_id, NULL, false,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;
  ELSE
    IF pg_catalog.jsonb_typeof(COALESCE(p_backup -> 'items', 'null'::jsonb)) <> 'array'
       OR pg_catalog.jsonb_typeof(COALESCE(p_backup -> 'sales', 'null'::jsonb)) <> 'array'
       OR pg_catalog.jsonb_typeof(COALESCE(p_backup -> 'customers', 'null'::jsonb)) <> 'array'
    THEN
      RAISE EXCEPTION 'Invalid countup-backup-v2 structure: items, sales, and customers arrays are required.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;

    IF (p_backup ? 'archivedItems') AND pg_catalog.jsonb_typeof(p_backup -> 'archivedItems') <> 'array' THEN
      RAISE EXCEPTION 'Invalid archivedItems array in backup.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;
    IF (p_backup ? 'creditPayments') AND pg_catalog.jsonb_typeof(p_backup -> 'creditPayments') <> 'array' THEN
      RAISE EXCEPTION 'Invalid creditPayments array in backup.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;
    IF (p_backup ? 'expenses') AND pg_catalog.jsonb_typeof(p_backup -> 'expenses') <> 'array' THEN
      RAISE EXCEPTION 'Invalid expenses array in backup.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;
    IF (p_backup ? 'stockMovements') AND pg_catalog.jsonb_typeof(p_backup -> 'stockMovements') <> 'array' THEN
      RAISE EXCEPTION 'Invalid stockMovements array in backup.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_STRUCTURE';
    END IF;

    IF pg_catalog.jsonb_array_length(p_backup -> 'items')
         + pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'archivedItems', '[]'::jsonb)) > 5000
       OR pg_catalog.jsonb_array_length(p_backup -> 'customers') > 5000
       OR pg_catalog.jsonb_array_length(p_backup -> 'sales') > 30000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'creditPayments', '[]'::jsonb)) > 25000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'expenses', '[]'::jsonb)) > 15000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'stockMovements', '[]'::jsonb)) > 80000
    THEN
      RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
        USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
    END IF;

    v_source_shop_name := pg_catalog.left(
      pg_catalog.btrim(COALESCE(p_backup #>> '{shop,name}', '')),
      120
    );

    PERFORM public.load_v2_json_arrays_into_temp_tables(
      p_backup -> 'items',
      COALESCE(p_backup -> 'archivedItems', '[]'::jsonb),
      p_backup -> 'customers',
      p_backup -> 'sales',
      COALESCE(p_backup -> 'creditPayments', '[]'::jsonb),
      COALESCE(p_backup -> 'expenses', '[]'::jsonb),
      COALESCE(p_backup -> 'stockMovements', '[]'::jsonb)
    );
  END IF;

  RETURN public.commit_populated_backup_temp_tables(
    p_shop_id,
    v_actor_uid,
    v_op_id,
    v_effective_sha,
    v_format,
    v_source_shop_name,
    p_dry_run,
    p_allow_non_empty_shop,
    v_already_imported,
    v_shop_has_data
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_shop_backup(uuid, text, text, jsonb, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_shop_backup(uuid, text, text, jsonb, boolean, boolean)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2B. Staged Chunked Backup Import (`backup_import_sessions`, `backup_import_chunks`)
--     Allows uploading multi-MB / 2+ year backups in small HTTP chunks (<250 KB
--     each) while keeping 100% all-or-nothing transactional validation +
--     `reconcile_shop_ledger` inside `finalize_shop_backup_import`.
-- -----------------------------------------------------------------------------
CREATE TABLE public.backup_import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (
    char_length(pg_catalog.btrim(operation_id)) BETWEEN 1 AND 160
    AND pg_catalog.strpos(operation_id, '/') = 0
  ),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  format text NOT NULL CHECK (format IN ('shopbook-backup-v1', 'countup-backup-v2')),
  source_shop_name text NOT NULL DEFAULT '' CHECK (char_length(source_shop_name) <= 120),
  allow_non_empty_shop boolean NOT NULL DEFAULT false,
  expected_chunks integer NOT NULL CHECK (expected_chunks BETWEEN 1 AND 500),
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 2 AND 5000000),
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'committed', 'aborted')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_import_sessions_shop_status
  ON public.backup_import_sessions (shop_id, status, expires_at);

CREATE TRIGGER trg_backup_import_sessions_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.backup_import_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.backup_import_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.backup_import_sessions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.backup_import_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.backup_import_sessions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.backup_import_sessions TO service_role;
  END IF;
END;
$$;

CREATE TABLE public.backup_import_chunks (
  session_id uuid NOT NULL REFERENCES public.backup_import_sessions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 499),
  section text NOT NULL CHECK (
    section IN ('items', 'archivedItems', 'customers', 'sales', 'creditPayments', 'expenses', 'stockMovements')
  ),
  records jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(records) = 'array'),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 2500),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 2 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chunk_index)
);

CREATE TRIGGER trg_backup_import_chunks_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.backup_import_chunks
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.backup_import_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.backup_import_chunks FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.backup_import_chunks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.backup_import_chunks FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.backup_import_chunks TO service_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_shop_backup_import(
  p_shop_id uuid,
  p_operation_id text,
  p_file_sha256 text,
  p_format text,
  p_total_bytes integer,
  p_expected_chunks integer,
  p_source_shop_name text DEFAULT '',
  p_allow_non_empty_shop boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor_uid uuid := auth.uid();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_sha text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_file_sha256, '')));
  v_sha_marker text;
  v_already_imported boolean := false;
  v_shop_has_data boolean := false;
  v_recent_hour integer := 0;
  v_recent_day integer := 0;
  v_existing public.backup_import_sessions;
  v_session_id uuid;
  v_uploaded jsonb;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid backup operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  IF v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid backup SHA-256 checksum.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_FILE_HASH';
  END IF;

  IF p_format NOT IN ('shopbook-backup-v1', 'countup-backup-v2') THEN
    RAISE EXCEPTION 'Unsupported backup format.'
      USING ERRCODE = '22023', DETAIL = 'UNSUPPORTED_BACKUP_FORMAT';
  END IF;

  IF p_total_bytes IS NULL OR p_total_bytes < 2 OR p_total_bytes > 5000000 THEN
    RAISE EXCEPTION 'The backup exceeds the 5 MB maximum size limit.'
      USING ERRCODE = '22023', DETAIL = 'PAYLOAD_TOO_LARGE';
  END IF;

  IF p_expected_chunks IS NULL OR p_expected_chunks < 1 OR p_expected_chunks > 500 THEN
    RAISE EXCEPTION 'Invalid chunk count (%).', COALESCE(p_expected_chunks::text, 'null')
      USING ERRCODE = '22023', DETAIL = 'INVALID_CHUNK_COUNT';
  END IF;

  -- Clean up expired/aborted staging sessions for this shop
  DELETE FROM public.backup_import_sessions
   WHERE shop_id = p_shop_id
     AND (expires_at < v_now OR status = 'aborted');

  v_sha_marker := 'backup_sha256:' || v_sha;

  SELECT EXISTS (
    SELECT 1
      FROM public.sync_operations so
     WHERE so.shop_id = p_shop_id
       AND so.operation_id IN (v_op_id, v_sha_marker)
  ) INTO v_already_imported;

  SELECT (
    EXISTS (SELECT 1 FROM public.items i WHERE i.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.sales s WHERE s.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.customers c WHERE c.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.credit_payments cp WHERE cp.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.shop_id = p_shop_id)
  ) INTO v_shop_has_data;

  IF v_already_imported THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'idempotent', true,
      'already_imported', true,
      'shop_has_existing_data', v_shop_has_data,
      'file_sha256', v_sha,
      'session_id', NULL
    );
  END IF;

  IF v_shop_has_data AND NOT COALESCE(p_allow_non_empty_shop, false) THEN
    RAISE EXCEPTION 'This shop already has records. Restore is only allowed into a new or empty shop unless you explicitly choose to merge into an existing shop.'
      USING ERRCODE = '23514', DETAIL = 'SHOP_NOT_EMPTY';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE pa.created_at >= v_now - interval '1 hour')::integer,
    COUNT(*)::integer
    INTO v_recent_hour, v_recent_day
    FROM public.platform_audit pa
   WHERE pa.shop_id = p_shop_id
     AND pa.action = 'shop_backup_imported'
     AND pa.created_at >= v_now - interval '24 hours';

  IF v_recent_hour >= 5 OR v_recent_day >= 10 THEN
    RAISE EXCEPTION 'Too many backup restore attempts for this shop. Please wait before trying again.'
      USING ERRCODE = 'P0001', DETAIL = 'BACKUP_IMPORT_RATE_LIMITED';
  END IF;

  -- Resume existing active staging session if identical operation_id + sha256
  SELECT s.*
    INTO v_existing
    FROM public.backup_import_sessions s
   WHERE s.shop_id = p_shop_id
     AND s.operation_id = v_op_id
     AND s.file_sha256 = v_sha
     AND s.status = 'staging'
     AND s.expires_at > v_now
   LIMIT 1;

  IF FOUND THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(c.chunk_index ORDER BY c.chunk_index), '[]'::jsonb)
      INTO v_uploaded
      FROM public.backup_import_chunks c
     WHERE c.session_id = v_existing.id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'staging',
      'idempotent', true,
      'already_imported', false,
      'shop_has_existing_data', v_shop_has_data,
      'file_sha256', v_sha,
      'session_id', v_existing.id,
      'uploaded_chunks', v_uploaded
    );
  END IF;

  INSERT INTO public.backup_import_sessions (
    shop_id,
    owner_user_id,
    operation_id,
    file_sha256,
    format,
    source_shop_name,
    allow_non_empty_shop,
    expected_chunks,
    total_bytes,
    status,
    expires_at
  ) VALUES (
    p_shop_id,
    v_actor_uid,
    v_op_id,
    v_sha,
    p_format,
    pg_catalog.left(pg_catalog.btrim(COALESCE(p_source_shop_name, '')), 120),
    COALESCE(p_allow_non_empty_shop, false),
    p_expected_chunks,
    p_total_bytes,
    'staging',
    v_now + interval '30 minutes'
  )
  RETURNING id INTO v_session_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'staging',
    'idempotent', false,
    'already_imported', false,
    'shop_has_existing_data', v_shop_has_data,
    'file_sha256', v_sha,
    'session_id', v_session_id,
    'uploaded_chunks', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_shop_backup_import(
  uuid, text, text, text, integer, integer, text, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_shop_backup_import(
  uuid, text, text, text, integer, integer, text, boolean
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.append_shop_backup_chunk(
  p_shop_id uuid,
  p_session_id uuid,
  p_chunk_index integer,
  p_section text,
  p_records jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_session public.backup_import_sessions;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_bytes integer;
  v_count integer;
  v_total_staged_bytes bigint;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  SELECT s.*
    INTO v_session
    FROM public.backup_import_sessions s
   WHERE s.id = p_session_id
     AND s.shop_id = p_shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backup import session not found.'
      USING ERRCODE = 'P0002', DETAIL = 'IMPORT_SESSION_NOT_FOUND';
  END IF;

  IF v_session.status <> 'staging' OR v_session.expires_at <= v_now THEN
    RAISE EXCEPTION 'Backup import session is no longer active.'
      USING ERRCODE = '23514', DETAIL = 'IMPORT_SESSION_INACTIVE';
  END IF;

  IF p_chunk_index IS NULL OR p_chunk_index < 0 OR p_chunk_index >= v_session.expected_chunks THEN
    RAISE EXCEPTION 'Chunk index % is out of bounds [0 .. %].', COALESCE(p_chunk_index::text, 'null'), v_session.expected_chunks - 1
      USING ERRCODE = '22023', DETAIL = 'INVALID_CHUNK_INDEX';
  END IF;

  IF p_section NOT IN ('items', 'archivedItems', 'customers', 'sales', 'creditPayments', 'expenses', 'stockMovements') THEN
    RAISE EXCEPTION 'Unsupported backup chunk section "%".', COALESCE(p_section, '')
      USING ERRCODE = '22023', DETAIL = 'INVALID_CHUNK_SECTION';
  END IF;

  IF p_records IS NULL OR pg_catalog.jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'Backup chunk records must be a JSON array.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_CHUNK_RECORDS';
  END IF;

  v_count := pg_catalog.jsonb_array_length(p_records);
  IF v_count > 2500 THEN
    RAISE EXCEPTION 'Backup chunk contains % records, exceeding the 2,500-record per-chunk limit.', v_count
      USING ERRCODE = '22023', DETAIL = 'CHUNK_TOO_LARGE';
  END IF;

  v_bytes := pg_catalog.octet_length(p_records::text);
  IF v_bytes > 1000000 THEN
    RAISE EXCEPTION 'Backup chunk exceeds the 1 MB per-chunk size limit.'
      USING ERRCODE = '22023', DETAIL = 'CHUNK_TOO_LARGE';
  END IF;

  INSERT INTO public.backup_import_chunks (
    session_id,
    chunk_index,
    section,
    records,
    record_count,
    byte_size
  ) VALUES (
    p_session_id,
    p_chunk_index,
    p_section,
    p_records,
    v_count,
    v_bytes
  )
  ON CONFLICT (session_id, chunk_index) DO UPDATE
    SET section = EXCLUDED.section,
        records = EXCLUDED.records,
        record_count = EXCLUDED.record_count,
        byte_size = EXCLUDED.byte_size;

  SELECT COALESCE(SUM(c.byte_size), 0)::bigint
    INTO v_total_staged_bytes
    FROM public.backup_import_chunks c
   WHERE c.session_id = p_session_id;

  -- Guard overall staged footprint (allow canonical JSONB pretty-print + normalized v2 expansion overhead up to 12 MB for a <= 5 MB raw backup file)
  IF v_total_staged_bytes > 12000000 THEN
    RAISE EXCEPTION 'Staged backup chunks exceed the maximum allowed size.'
      USING ERRCODE = '22023', DETAIL = 'PAYLOAD_TOO_LARGE';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'chunk_staged',
    'session_id', p_session_id,
    'chunk_index', p_chunk_index,
    'record_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.append_shop_backup_chunk(uuid, uuid, integer, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_shop_backup_chunk(uuid, uuid, integer, text, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.abort_shop_backup_import(
  p_shop_id uuid,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  DELETE FROM public.backup_import_chunks
   WHERE session_id = p_session_id
     AND EXISTS (
       SELECT 1 FROM public.backup_import_sessions s
        WHERE s.id = p_session_id AND s.shop_id = p_shop_id
     );

  UPDATE public.backup_import_sessions
     SET status = 'aborted'
   WHERE id = p_session_id
     AND shop_id = p_shop_id
     AND status = 'staging';

  RETURN pg_catalog.jsonb_build_object(
    'status', 'aborted',
    'session_id', p_session_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.abort_shop_backup_import(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abort_shop_backup_import(uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_shop_backup_import(
  p_shop_id uuid,
  p_session_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '60s'
AS $$
DECLARE
  v_shop public.shops;
  v_session public.backup_import_sessions;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor_uid uuid := auth.uid();
  v_already_imported boolean := false;
  v_shop_has_data boolean := false;
  v_chunk_count integer := 0;
  v_items_json jsonb;
  v_archived_items_json jsonb;
  v_customers_json jsonb;
  v_sales_json jsonb;
  v_payments_json jsonb;
  v_expenses_json jsonb;
  v_movements_json jsonb;
  v_result jsonb;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  SELECT s.*
    INTO v_session
    FROM public.backup_import_sessions s
   WHERE s.id = p_session_id
     AND s.shop_id = p_shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backup import session not found.'
      USING ERRCODE = 'P0002', DETAIL = 'IMPORT_SESSION_NOT_FOUND';
  END IF;

  SELECT (
    EXISTS (SELECT 1 FROM public.items i WHERE i.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.sales s WHERE s.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.customers c WHERE c.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.credit_payments cp WHERE cp.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.shop_id = p_shop_id)
  ) INTO v_shop_has_data;

  SELECT EXISTS (
    SELECT 1
      FROM public.sync_operations so
     WHERE so.shop_id = p_shop_id
       AND so.operation_id IN (v_session.operation_id, 'backup_sha256:' || v_session.file_sha256)
  ) INTO v_already_imported;

  IF v_session.status = 'committed' OR (v_already_imported AND NOT COALESCE(p_dry_run, false)) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'dry_run', false,
      'idempotent', true,
      'already_imported', true,
      'shop_has_existing_data', v_shop_has_data,
      'file_sha256', v_session.file_sha256
    );
  END IF;

  IF v_session.status <> 'staging' OR v_session.expires_at <= v_now THEN
    RAISE EXCEPTION 'Backup import session has expired or was aborted.'
      USING ERRCODE = '23514', DETAIL = 'IMPORT_SESSION_INACTIVE';
  END IF;

  SELECT COUNT(*)::integer
    INTO v_chunk_count
    FROM public.backup_import_chunks c
   WHERE c.session_id = p_session_id;

  IF v_chunk_count <> v_session.expected_chunks THEN
    RAISE EXCEPTION 'Incomplete backup upload: received % of % expected chunks.', v_chunk_count, v_session.expected_chunks
      USING ERRCODE = '22023', DETAIL = 'INCOMPLETE_BACKUP_CHUNKS';
  END IF;

  -- Concatenate chunks per section in deterministic chunk_index order
  SELECT
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'items'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'archivedItems'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'customers'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'sales'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'creditPayments'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'expenses'
    ), '[]'::jsonb),
    COALESCE((
      SELECT pg_catalog.jsonb_agg(elem ORDER BY c.chunk_index, e.ord)
        FROM public.backup_import_chunks c
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c.records) WITH ORDINALITY AS e(elem, ord)
       WHERE c.session_id = p_session_id AND c.section = 'stockMovements'
    ), '[]'::jsonb)
  INTO
    v_items_json,
    v_archived_items_json,
    v_customers_json,
    v_sales_json,
    v_payments_json,
    v_expenses_json,
    v_movements_json;

  IF pg_catalog.jsonb_array_length(v_items_json) + pg_catalog.jsonb_array_length(v_archived_items_json) > 5000
     OR pg_catalog.jsonb_array_length(v_customers_json) > 5000
     OR pg_catalog.jsonb_array_length(v_sales_json) > 30000
     OR pg_catalog.jsonb_array_length(v_payments_json) > 25000
     OR pg_catalog.jsonb_array_length(v_expenses_json) > 15000
     OR pg_catalog.jsonb_array_length(v_movements_json) > 80000
  THEN
    RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
      USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
  END IF;

  PERFORM public.ensure_backup_temp_tables();

  PERFORM public.load_v2_json_arrays_into_temp_tables(
    v_items_json,
    v_archived_items_json,
    v_customers_json,
    v_sales_json,
    v_payments_json,
    v_expenses_json,
    v_movements_json
  );

  v_result := public.commit_populated_backup_temp_tables(
    p_shop_id,
    v_actor_uid,
    v_session.operation_id,
    v_session.file_sha256,
    v_session.format,
    v_session.source_shop_name,
    p_dry_run,
    v_session.allow_non_empty_shop,
    v_already_imported,
    v_shop_has_data
  );

  IF NOT COALESCE(p_dry_run, false) THEN
    DELETE FROM public.backup_import_chunks
     WHERE session_id = p_session_id;

    UPDATE public.backup_import_sessions
       SET status = 'committed'
     WHERE id = p_session_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_shop_backup_import(uuid, uuid, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_shop_backup_import(uuid, uuid, boolean)
  TO authenticated, service_role;

-- =============================================================================
-- 3. Phase 4 — Server-Defined Subscription Plans, Shop Subscription Notice,
--    Manual Mobile-Money Payment Submission, `aal2` Admin Review, Race-Safe
--    Extend/Suspend & Subscription Reconciliation
-- =============================================================================

-- 3.1 Server-side plan catalog (client can NEVER choose or override amounts)
CREATE TABLE public.subscription_plans (
  id text PRIMARY KEY CHECK (id IN ('monthly', 'quarterly', 'biannual')),
  name text NOT NULL CHECK (char_length(pg_catalog.btrim(name)) BETWEEN 1 AND 60),
  months integer NOT NULL CHECK (months IN (1, 3, 6)),
  price_ngwee bigint NOT NULL CHECK (price_ngwee > 0 AND price_ngwee <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_subscription_plans_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.subscription_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.subscription_plans (id, name, months, price_ngwee)
VALUES
  ('monthly', '1 Month', 1, 9900),
  ('quarterly', '3 Months', 3, 26900),
  ('biannual', '6 Months', 6, 49900)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      months = EXCLUDED.months,
      price_ngwee = EXCLUDED.price_ngwee;

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_plans FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.subscription_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.subscription_plans FROM authenticated;
    GRANT SELECT ON TABLE public.subscription_plans TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.subscription_plans TO service_role;
  END IF;
END;
$$;

CREATE POLICY subscription_plans_select_authenticated
  ON public.subscription_plans
  FOR SELECT
  TO authenticated
  USING (true);

-- 3.2 Dedicated `subscription_notice` on `public.shops` so subscription actions
--     deliver a clear notice on next sync without overwriting urgent security
--     notices (such as 72-hour PIN reset alerts).
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS subscription_notice text CHECK (
    subscription_notice IS NULL OR char_length(subscription_notice) <= 500
  ),
  ADD COLUMN IF NOT EXISTS subscription_notice_at timestamptz;

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
      OR NEW.security_notice IS DISTINCT FROM OLD.security_notice
      OR NEW.security_notice_at IS DISTINCT FROM OLD.security_notice_at
      OR NEW.subscription_notice IS DISTINCT FROM OLD.subscription_notice
      OR NEW.subscription_notice_at IS DISTINCT FROM OLD.subscription_notice_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Insufficient privilege to modify protected shop fields.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_shop_privileged_columns() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.protect_shop_privileged_columns() FROM anon;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_shop_subscription_notice()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_shop_id uuid := public.request_shop_id();
BEGIN
  IF v_uid IS NULL OR v_shop_id IS NULL THEN
    RAISE EXCEPTION 'PIN-verified shop session required.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.shops
     SET subscription_notice = NULL,
         subscription_notice_at = NULL
   WHERE id = v_shop_id
     AND owner_user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop not found or not owned by caller.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_shop_subscription_notice() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.acknowledge_shop_subscription_notice() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.acknowledge_shop_subscription_notice() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.acknowledge_shop_subscription_notice() TO service_role;
  END IF;
END;
$$;

-- 3.3 Idempotency columns & indexes for payment submission and admin actions
ALTER TABLE public.subscription_payments
  ADD COLUMN IF NOT EXISTS operation_id text CHECK (
    operation_id IS NULL OR (
      char_length(pg_catalog.btrim(operation_id)) BETWEEN 1 AND 160
      AND pg_catalog.strpos(operation_id, '/') = 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_shop_op_id
  ON public.subscription_payments (shop_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_audit_admin_op_id
  ON public.platform_audit (action, (metadata ->> 'operation_id'))
  WHERE metadata ? 'operation_id';

-- 3.4 Pure validation & UTC calendar-month helpers
CREATE OR REPLACE FUNCTION public.normalize_zambian_payer_phone(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_cleaned text := pg_catalog.regexp_replace(COALESCE(p_raw, ''), '[\s()-]+', '', 'g');
BEGIN
  IF v_cleaned ~ '^0[0-9]{9}$' THEN
    v_cleaned := '+260' || pg_catalog.substr(v_cleaned, 2);
  ELSIF v_cleaned ~ '^260[0-9]{9}$' THEN
    v_cleaned := '+' || v_cleaned;
  END IF;

  IF v_cleaned !~ '^\+260[0-9]{9}$' THEN
    RAISE EXCEPTION 'Enter a valid Zambian mobile number (+2609XXXXXXXX or 09XXXXXXXX).'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYER_PHONE';
  END IF;

  RETURN v_cleaned;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_zambian_payer_phone(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.normalize_zambian_payer_phone(text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.normalize_zambian_payer_phone(text) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.normalize_zambian_payer_phone(text) TO service_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_utc_calendar_months(
  p_base timestamptz,
  p_months integer
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ((p_base AT TIME ZONE 'UTC') + pg_catalog.make_interval(months => p_months)) AT TIME ZONE 'UTC';
$$;

REVOKE ALL ON FUNCTION public.add_utc_calendar_months(timestamptz, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.add_utc_calendar_months(timestamptz, integer) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.add_utc_calendar_months(timestamptz, integer) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.add_utc_calendar_months(timestamptz, integer) TO service_role;
  END IF;
END;
$$;

-- 3.5 `public.submit_subscription_payment`
--     - Enforces server-defined plan pricing (`public.subscription_plans`);
--       rejects any mismatched `p_expected_amount_ngwee`.
--     - Validates network (`mtn` / `airtel`), reference format, Zambian payer
--       phone, and payment date.
--     - Enforces idempotent replay (`p_operation_id` or identical pending
--       submission), one pending submission per shop, per-shop rate limit, and
--       global active reference lock (`WHERE status IN ('pending', 'approved')`)
--       so rejected references can be corrected and resubmitted.
--     - Writes `public.platform_audit`.
CREATE OR REPLACE FUNCTION public.submit_subscription_payment(
  p_shop_id uuid,
  p_plan_id text,
  p_network text,
  p_transaction_reference text,
  p_payer_phone text,
  p_payment_date text,
  p_operation_id text DEFAULT NULL,
  p_expected_amount_ngwee bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_plan public.subscription_plans;
  v_existing public.subscription_payments;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor_uid uuid := auth.uid();
  v_op_id text := NULLIF(pg_catalog.btrim(COALESCE(p_operation_id, '')), '');
  v_network text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_network, '')));
  v_ref text := pg_catalog.upper(pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_transaction_reference, '')), '\s+', '', 'g'));
  v_payer_phone text;
  v_date_raw text := pg_catalog.btrim(COALESCE(p_payment_date, ''));
  v_payment_date date;
  v_today_utc date := (v_now AT TIME ZONE 'UTC')::date;
  v_recent_hour integer := 0;
  v_recent_day integer := 0;
  v_payment_id uuid;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  -- Defense-in-depth: if the shop has PIN credentials and the caller is an authenticated
  -- user session (not service_role), verify that the active session_id is still present in
  -- shop_verified_sessions so unverified or revoked sessions cannot submit payments.
  IF COALESCE(auth.role(), '') = 'authenticated'
     AND NOT public.is_platform_admin()
     AND EXISTS (
       SELECT 1 FROM public.shop_pin_credentials spc WHERE spc.shop_id = p_shop_id
     )
  THEN
    IF COALESCE(NULLIF(pg_catalog.btrim(COALESCE(auth.jwt() ->> 'session_id', '')), ''), '') = ''
       OR NOT EXISTS (
         SELECT 1
           FROM public.shop_verified_sessions svs
          WHERE svs.shop_id = p_shop_id
            AND svs.user_id = v_actor_uid
            AND svs.session_id = pg_catalog.btrim(auth.jwt() ->> 'session_id')
       )
    THEN
      RAISE EXCEPTION 'Unlock your shop with your PIN before submitting a payment.'
        USING ERRCODE = '42501', DETAIL = 'PIN_VERIFICATION_REQUIRED';
    END IF;
  END IF;

  IF v_op_id IS NOT NULL AND (pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0) THEN
    RAISE EXCEPTION 'Invalid payment operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  -- 1. Idempotent replay by operation_id
  IF v_op_id IS NOT NULL THEN
    SELECT sp.*
      INTO v_existing
      FROM public.subscription_payments sp
     WHERE sp.shop_id = p_shop_id
       AND sp.operation_id = v_op_id;

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'id', v_existing.id,
        'status', v_existing.status,
        'plan_id', v_existing.plan_id,
        'amount_ngwee', v_existing.amount_ngwee,
        'idempotent', true
      );
    END IF;
  END IF;

  -- 2. Server-defined plan & price check
  SELECT pl.*
    INTO v_plan
    FROM public.subscription_plans pl
   WHERE pl.id = pg_catalog.lower(pg_catalog.btrim(COALESCE(p_plan_id, '')));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose a valid subscription plan.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PLAN';
  END IF;

  IF p_expected_amount_ngwee IS NOT NULL AND p_expected_amount_ngwee <> v_plan.price_ngwee THEN
    RAISE EXCEPTION 'Payment amount does not match the server plan price (% ngwee).', v_plan.price_ngwee
      USING ERRCODE = '22023', DETAIL = 'AMOUNT_MISMATCH';
  END IF;

  -- 3. Validate network, transaction reference, payer phone, and payment date
  IF v_network NOT IN ('mtn', 'airtel') THEN
    RAISE EXCEPTION 'Choose MTN Mobile Money or Airtel Money.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_NETWORK';
  END IF;

  IF v_ref !~ '^[A-Z0-9][A-Z0-9._/-]{4,49}$' THEN
    RAISE EXCEPTION 'Enter a valid mobile money transaction reference (5 to 50 characters).'
      USING ERRCODE = '22023', DETAIL = 'INVALID_TRANSACTION_REFERENCE';
  END IF;

  v_payer_phone := public.normalize_zambian_payer_phone(p_payer_phone);

  IF v_date_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Choose a valid payment date (YYYY-MM-DD).'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_DATE';
  END IF;

  BEGIN
    v_payment_date := v_date_raw::date;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Choose a valid calendar payment date.'
        USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_DATE';
  END;

  IF v_payment_date > (v_today_utc + 1) OR v_payment_date < DATE '2024-01-01' THEN
    RAISE EXCEPTION 'Payment date cannot be in the future or before 2024.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_DATE';
  END IF;

  -- 4. One pending submission per shop (with idempotent replay if identical pending row)
  SELECT sp.*
    INTO v_existing
    FROM public.subscription_payments sp
   WHERE sp.shop_id = p_shop_id
     AND sp.status = 'pending'
   LIMIT 1;

  IF FOUND THEN
    IF v_existing.plan_id = v_plan.id
       AND v_existing.network = v_network
       AND v_existing.transaction_reference = v_ref
       AND v_existing.payer_phone = v_payer_phone
       AND v_existing.payment_date = v_payment_date
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'id', v_existing.id,
        'status', v_existing.status,
        'plan_id', v_existing.plan_id,
        'amount_ngwee', v_existing.amount_ngwee,
        'idempotent', true
      );
    END IF;

    RAISE EXCEPTION 'A payment for this shop is already awaiting review.'
      USING ERRCODE = '23505', DETAIL = 'ONE_PENDING_PER_SHOP';
  END IF;

  IF v_shop.pending_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'A payment for this shop is already awaiting review.'
      USING ERRCODE = '23505', DETAIL = 'ONE_PENDING_PER_SHOP';
  END IF;

  -- 5. Per-shop submission rate limit (max 3 / hour, max 5 / 24h)
  SELECT
    COUNT(*) FILTER (WHERE sp.submitted_at >= v_now - interval '1 hour')::integer,
    COUNT(*)::integer
    INTO v_recent_hour, v_recent_day
    FROM public.subscription_payments sp
   WHERE sp.shop_id = p_shop_id
     AND sp.submitted_at >= v_now - interval '24 hours';

  IF v_recent_hour >= 3 OR v_recent_day >= 5 THEN
    RAISE EXCEPTION 'Too many payment submissions for this shop. Please wait before submitting again.'
      USING ERRCODE = 'P0001', DETAIL = 'PAYMENT_RATE_LIMIT_EXCEEDED';
  END IF;

  -- 6. Check active reference lock (rejected references are NOT in ('pending','approved') and CAN be resubmitted!)
  IF EXISTS (
    SELECT 1
      FROM public.payment_reference_locks prl
     WHERE prl.network = v_network
       AND prl.transaction_reference = v_ref
       AND prl.status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'This transaction reference has already been submitted.'
      USING ERRCODE = '23505', DETAIL = 'REFERENCE_ALREADY_USED';
  END IF;

  -- 7. Insert payment, active reference lock, shop pointer update, and platform_audit
  INSERT INTO public.subscription_payments (
    shop_id,
    shop_name_snapshot,
    owner_user_id,
    provider,
    network,
    plan_id,
    transaction_reference,
    payer_phone,
    payment_date,
    amount_ngwee,
    status,
    operation_id,
    submitted_at
  ) VALUES (
    p_shop_id,
    v_shop.name,
    v_shop.owner_user_id,
    'manual_mobile_money',
    v_network,
    v_plan.id,
    v_ref,
    v_payer_phone,
    v_payment_date,
    v_plan.price_ngwee,
    'pending',
    v_op_id,
    v_now
  )
  RETURNING id INTO v_payment_id;

  BEGIN
    INSERT INTO public.payment_reference_locks (
      payment_id,
      shop_id,
      network,
      transaction_reference,
      status
    ) VALUES (
      v_payment_id,
      p_shop_id,
      v_network,
      v_ref,
      'pending'
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'This transaction reference has already been submitted.'
        USING ERRCODE = '23505', DETAIL = 'REFERENCE_ALREADY_USED';
  END;

  UPDATE public.shops
     SET pending_payment_id = v_payment_id,
         plan_status = CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'pending_payment' END,
         status_before_suspension = CASE
           WHEN v_shop.is_deactivated THEN 'pending_payment'
           ELSE v_shop.status_before_suspension
         END,
         last_server_contact_at = GREATEST(v_shop.last_server_contact_at, v_now)
   WHERE id = p_shop_id;

  INSERT INTO public.platform_audit (
    action,
    actor_user_id,
    target_user_id,
    shop_id,
    payment_id,
    transaction_reference,
    amount_ngwee,
    plan_id,
    metadata,
    created_at
  ) VALUES (
    'subscription_payment_submitted',
    v_actor_uid,
    v_shop.owner_user_id,
    p_shop_id,
    v_payment_id,
    v_ref,
    v_plan.price_ngwee,
    v_plan.id,
    pg_catalog.jsonb_build_object(
      'network', v_network,
      'payer_phone', v_payer_phone,
      'payment_date', v_payment_date::text
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'id', v_payment_id,
    'status', 'pending',
    'plan_status', CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'pending_payment' END,
    'plan_id', v_plan.id,
    'amount_ngwee', v_plan.price_ngwee,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_subscription_payment(
  uuid, text, text, text, text, text, text, bigint
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_subscription_payment(
  uuid, text, text, text, text, text, text, bigint
) TO authenticated, service_role;

-- 3.6 `public.review_subscription_payment`
--     - Requires `aal2` `platform_admin` (`public.is_platform_admin()`).
--     - Uses `SELECT ... FOR UPDATE` on BOTH `subscription_payments` and `shops`
--       so concurrent reviews or double-clicks can NEVER extend a shop twice.
--     - Same-decision replay returns `idempotent = true`; conflicting decision
--       raises `PAYMENT_ALREADY_REVIEWED`.
--     - Approval extends from `GREATEST(now, plan_expiry_at)` by calendar
--       months + 3-day grace, writes `platform_audit`, and posts a shop notice.
CREATE OR REPLACE FUNCTION public.review_subscription_payment(
  p_payment_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL,
  p_operation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_uid uuid := auth.uid();
  v_payment public.subscription_payments;
  v_shop public.shops;
  v_plan public.subscription_plans;
  v_lock public.payment_reference_locks;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_decision text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_decision, '')));
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_op_id text := NULLIF(pg_catalog.btrim(COALESCE(p_operation_id, '')), '');
  v_start_at timestamptz;
  v_expiry_at timestamptz;
  v_sales_access timestamptz;
  v_notice text;
BEGIN
  IF v_admin_uid IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator MFA (aal2) access is required.'
      USING ERRCODE = '42501', DETAIL = 'ADMIN_MFA_REQUIRED';
  END IF;

  IF p_payment_id IS NULL OR v_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Choose a payment and an approval or rejection action.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_REVIEW_DECISION';
  END IF;

  IF v_decision = 'reject' AND (pg_catalog.char_length(v_reason) < 3 OR pg_catalog.char_length(v_reason) > 500) THEN
    RAISE EXCEPTION 'Enter a rejection reason between 3 and 500 characters.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_REJECTION_REASON';
  END IF;

  -- Lock payment row first to serialize concurrent admin clicks
  SELECT sp.*
    INTO v_payment
    FROM public.subscription_payments sp
   WHERE sp.id = p_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment submission not found.'
      USING ERRCODE = 'P0002', DETAIL = 'PAYMENT_NOT_FOUND';
  END IF;

  -- Lock shop row
  SELECT sh.*
    INTO v_shop
    FROM public.shops sh
   WHERE sh.id = v_payment.shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The payment shop no longer exists.'
      USING ERRCODE = 'P0002', DETAIL = 'SHOP_NOT_FOUND';
  END IF;

  -- Idempotent replay on identical decision (double-click / network retry / second admin same decision)
  IF v_payment.status = 'approved' AND v_decision = 'approve' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'approved',
      'idempotent', true,
      'payment_id', v_payment.id,
      'shop_id', v_shop.id,
      'plan_status', v_shop.plan_status,
      'subscription_start_at', v_payment.subscription_start_at,
      'subscription_expiry_at', v_payment.subscription_expiry_at,
      'sales_access_until', v_shop.sales_access_until
    );
  END IF;

  IF v_payment.status = 'rejected' AND v_decision = 'reject' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'idempotent', true,
      'payment_id', v_payment.id,
      'shop_id', v_shop.id
    );
  END IF;

  IF v_payment.status <> 'pending' THEN
    RAISE EXCEPTION 'This payment has already been reviewed (%).', v_payment.status
      USING ERRCODE = '23514', DETAIL = 'PAYMENT_ALREADY_REVIEWED';
  END IF;

  SELECT pl.*
    INTO v_plan
    FROM public.subscription_plans pl
   WHERE pl.id = v_payment.plan_id;

  IF NOT FOUND OR v_payment.amount_ngwee <> v_plan.price_ngwee THEN
    RAISE EXCEPTION 'Payment amount does not match the server plan price.'
      USING ERRCODE = '22023', DETAIL = 'AMOUNT_MISMATCH';
  END IF;

  SELECT prl.*
    INTO v_lock
    FROM public.payment_reference_locks prl
   WHERE prl.payment_id = v_payment.id
   FOR UPDATE;

  IF NOT FOUND OR v_lock.status <> 'pending' THEN
    RAISE EXCEPTION 'The payment reference lock is missing or inconsistent.'
      USING ERRCODE = '23514', DETAIL = 'REFERENCE_LOCK_MISMATCH';
  END IF;

  IF v_shop.pending_payment_id IS DISTINCT FROM v_payment.id THEN
    RAISE EXCEPTION 'This is no longer the shop’s pending payment.'
      USING ERRCODE = '23514', DETAIL = 'PENDING_POINTER_MISMATCH';
  END IF;

  IF v_decision = 'approve' THEN
    v_start_at := GREATEST(v_now, v_shop.plan_expiry_at);
    v_expiry_at := public.add_utc_calendar_months(v_start_at, v_plan.months);
    v_sales_access := v_expiry_at + interval '3 days';
    v_notice := pg_catalog.left(
      'Subscription approved: your ' || v_plan.name || ' plan is active until ' ||
      pg_catalog.to_char(v_expiry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '.',
      500
    );

    UPDATE public.subscription_payments
       SET status = 'approved',
           reviewed_at = v_now,
           reviewed_by_user_id = v_admin_uid,
           subscription_start_at = v_start_at,
           subscription_expiry_at = v_expiry_at
     WHERE id = v_payment.id;

    UPDATE public.payment_reference_locks
       SET status = 'approved',
           reviewed_at = v_now
     WHERE id = v_lock.id;

    UPDATE public.shops
       SET plan_status = CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'active' END,
           status_before_suspension = CASE WHEN v_shop.is_deactivated THEN 'active' ELSE NULL END,
           plan_type = v_plan.id,
           plan_expiry_at = v_expiry_at,
           sales_access_until = v_sales_access,
           subscription_started_at = v_start_at,
           subscription_payment_id = v_payment.id,
           pending_payment_id = NULL,
           subscription_notice = v_notice,
           subscription_notice_at = v_now
     WHERE id = v_shop.id;

    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      target_user_id,
      shop_id,
      payment_id,
      transaction_reference,
      amount_ngwee,
      plan_id,
      metadata,
      created_at
    ) VALUES (
      'subscription_payment_approved',
      v_admin_uid,
      v_shop.owner_user_id,
      v_shop.id,
      v_payment.id,
      v_payment.transaction_reference,
      v_payment.amount_ngwee,
      v_plan.id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'operation_id', v_op_id,
        'network', v_payment.network,
        'subscription_start_at', v_start_at,
        'subscription_expiry_at', v_expiry_at,
        'sales_access_until', v_sales_access
      )),
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'approved',
      'idempotent', false,
      'payment_id', v_payment.id,
      'shop_id', v_shop.id,
      'plan_status', CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'active' END,
      'subscription_start_at', v_start_at,
      'subscription_expiry_at', v_expiry_at,
      'sales_access_until', v_sales_access
    );
  ELSE
    v_notice := pg_catalog.left(
      'Payment review update: reference ' || v_payment.transaction_reference ||
      ' was not approved (' || v_reason || '). Correct and resubmit when ready.',
      500
    );

    UPDATE public.subscription_payments
       SET status = 'rejected',
           rejection_reason = v_reason,
           reviewed_at = v_now,
           reviewed_by_user_id = v_admin_uid
     WHERE id = v_payment.id;

    UPDATE public.payment_reference_locks
       SET status = 'rejected',
           reviewed_at = v_now
     WHERE id = v_lock.id;

    UPDATE public.shops
       SET plan_status = CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'rejected' END,
           status_before_suspension = CASE WHEN v_shop.is_deactivated THEN 'rejected' ELSE v_shop.status_before_suspension END,
           pending_payment_id = NULL,
           subscription_notice = v_notice,
           subscription_notice_at = v_now
     WHERE id = v_shop.id;

    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      target_user_id,
      shop_id,
      payment_id,
      transaction_reference,
      amount_ngwee,
      plan_id,
      reason,
      metadata,
      created_at
    ) VALUES (
      'subscription_payment_rejected',
      v_admin_uid,
      v_shop.owner_user_id,
      v_shop.id,
      v_payment.id,
      v_payment.transaction_reference,
      v_payment.amount_ngwee,
      v_payment.plan_id,
      v_reason,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'operation_id', v_op_id,
        'network', v_payment.network
      )),
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'idempotent', false,
      'payment_id', v_payment.id,
      'shop_id', v_shop.id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_subscription_payment(uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_subscription_payment(uuid, text, text, text)
  TO authenticated, service_role;

-- 3.7 `public.admin_extend_shop_subscription`
--     - Requires `aal2` `platform_admin`.
--     - Race-safe (`FOR UPDATE` on `shops`) and idempotent on `p_operation_id`
--       so double-clicks or retries never extend a shop twice.
--     - Extends from `GREATEST(now, plan_expiry_at)` + `p_days`, writes
--       `platform_audit`, and posts `subscription_notice`.
CREATE OR REPLACE FUNCTION public.admin_extend_shop_subscription(
  p_shop_id uuid,
  p_days integer,
  p_operation_id text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_uid uuid := auth.uid();
  v_shop public.shops;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := pg_catalog.btrim(COALESCE(p_operation_id, ''));
  v_reason text := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  v_existing_audit public.platform_audit;
  v_start_at timestamptz;
  v_expiry_at timestamptz;
  v_sales_access timestamptz;
  v_notice text;
BEGIN
  IF v_admin_uid IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator MFA (aal2) access is required.'
      USING ERRCODE = '42501', DETAIL = 'ADMIN_MFA_REQUIRED';
  END IF;

  IF p_shop_id IS NULL OR p_days IS NULL OR p_days < 1 OR p_days > 3650 THEN
    RAISE EXCEPTION 'Choose a shop and a number of days from 1 to 3,650.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_EXTENSION_DAYS';
  END IF;

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid admin operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  SELECT sh.*
    INTO v_shop
    FROM public.shops sh
   WHERE sh.id = p_shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop not found.'
      USING ERRCODE = 'P0002', DETAIL = 'SHOP_NOT_FOUND';
  END IF;

  SELECT pa.*
    INTO v_existing_audit
    FROM public.platform_audit pa
   WHERE pa.action = 'subscription_extended'
     AND (pa.metadata ->> 'operation_id') = v_op_id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'extended', true,
      'idempotent', true,
      'shop_id', v_shop.id,
      'plan_expiry_at', v_shop.plan_expiry_at,
      'sales_access_until', v_shop.sales_access_until
    );
  END IF;

  v_start_at := GREATEST(v_now, v_shop.plan_expiry_at);
  v_expiry_at := v_start_at + pg_catalog.make_interval(days => p_days);
  v_sales_access := v_expiry_at + interval '3 days';
  v_notice := pg_catalog.left(
    'Subscription extended: +' || p_days::text || ' day(s) added. Your plan is active until ' ||
    pg_catalog.to_char(v_expiry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '.',
    500
  );

  UPDATE public.shops
     SET plan_status = CASE WHEN v_shop.is_deactivated THEN 'suspended' ELSE 'active' END,
         status_before_suspension = CASE
           WHEN v_shop.is_deactivated THEN 'active'
           ELSE NULL
         END,
         plan_expiry_at = v_expiry_at,
         sales_access_until = v_sales_access,
         subscription_started_at = v_start_at,
         subscription_notice = v_notice,
         subscription_notice_at = v_now
   WHERE id = v_shop.id;

  INSERT INTO public.platform_audit (
    action,
    actor_user_id,
    target_user_id,
    shop_id,
    days,
    reason,
    metadata,
    created_at
  ) VALUES (
    'subscription_extended',
    v_admin_uid,
    v_shop.owner_user_id,
    v_shop.id,
    p_days,
    v_reason,
    pg_catalog.jsonb_build_object(
      'operation_id', v_op_id,
      'previous_expiry_at', v_shop.plan_expiry_at,
      'start_at', v_start_at,
      'expiry_at', v_expiry_at,
      'sales_access_until', v_sales_access
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'extended', true,
    'idempotent', false,
    'shop_id', v_shop.id,
    'plan_expiry_at', v_expiry_at,
    'sales_access_until', v_sales_access
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_extend_shop_subscription(uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_extend_shop_subscription(uuid, integer, text, text)
  TO authenticated, service_role;

-- 3.8 `public.admin_set_shop_suspended`
--     - Requires `aal2` `platform_admin`.
--     - Race-safe (`FOR UPDATE`) and idempotent.
--     - Suspension remembers `status_before_suspension` and restoring returns
--       `plan_status` to that exact status (falling back to date-based status
--       only if `status_before_suspension` was null).
--     - Writes `platform_audit` and posts `subscription_notice`.
CREATE OR REPLACE FUNCTION public.admin_set_shop_suspended(
  p_shop_id uuid,
  p_suspended boolean,
  p_operation_id text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_uid uuid := auth.uid();
  v_shop public.shops;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_op_id text := NULLIF(pg_catalog.btrim(COALESCE(p_operation_id, '')), '');
  v_reason text := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  v_prev_status text;
  v_next_status text;
  v_notice text;
BEGIN
  IF v_admin_uid IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator MFA (aal2) access is required.'
      USING ERRCODE = '42501', DETAIL = 'ADMIN_MFA_REQUIRED';
  END IF;

  IF p_shop_id IS NULL OR p_suspended IS NULL THEN
    RAISE EXCEPTION 'Choose a shop and a valid suspension action.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_SUSPENSION_ACTION';
  END IF;

  SELECT sh.*
    INTO v_shop
    FROM public.shops sh
   WHERE sh.id = p_shop_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop not found.'
      USING ERRCODE = 'P0002', DETAIL = 'SHOP_NOT_FOUND';
  END IF;

  IF (p_suspended AND v_shop.is_deactivated) OR (NOT p_suspended AND NOT v_shop.is_deactivated) THEN
    RETURN pg_catalog.jsonb_build_object(
      'suspended', v_shop.is_deactivated,
      'idempotent', true,
      'shop_id', v_shop.id,
      'plan_status', v_shop.plan_status,
      'status_before_suspension', v_shop.status_before_suspension
    );
  END IF;

  IF p_suspended THEN
    v_prev_status := CASE
      WHEN v_shop.plan_status = 'suspended' THEN COALESCE(v_shop.status_before_suspension, 'expired')
      ELSE v_shop.plan_status
    END;
    v_notice := 'Account notice: your shop has been suspended by platform support. Existing records remain readable.';

    UPDATE public.shops
       SET is_deactivated = true,
           plan_status = 'suspended',
           status_before_suspension = v_prev_status,
           subscription_notice = v_notice,
           subscription_notice_at = v_now
     WHERE id = v_shop.id;

    UPDATE public.used_trial_phones
       SET was_suspended = true
     WHERE first_shop_id = v_shop.id;

    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      target_user_id,
      shop_id,
      reason,
      metadata,
      created_at
    ) VALUES (
      'shop_suspended',
      v_admin_uid,
      v_shop.owner_user_id,
      v_shop.id,
      v_reason,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'operation_id', v_op_id,
        'previous_status', v_prev_status
      )),
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'suspended', true,
      'idempotent', false,
      'shop_id', v_shop.id,
      'plan_status', 'suspended',
      'status_before_suspension', v_prev_status
    );
  ELSE
    v_next_status := COALESCE(
      v_shop.status_before_suspension,
      CASE
        WHEN v_shop.sales_access_until > v_now THEN
          CASE WHEN v_shop.plan_type = 'trial' THEN 'trial' ELSE 'active' END
        ELSE 'expired'
      END
    );
    IF v_next_status = 'suspended' THEN
      v_next_status := CASE WHEN v_shop.sales_access_until > v_now THEN 'active' ELSE 'expired' END;
    END IF;
    v_notice := 'Account notice: your shop suspension has been lifted.';

    UPDATE public.shops
       SET is_deactivated = false,
           plan_status = v_next_status,
           status_before_suspension = NULL,
           subscription_notice = v_notice,
           subscription_notice_at = v_now
     WHERE id = v_shop.id;

    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      target_user_id,
      shop_id,
      reason,
      metadata,
      created_at
    ) VALUES (
      'shop_reactivated',
      v_admin_uid,
      v_shop.owner_user_id,
      v_shop.id,
      v_reason,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'operation_id', v_op_id,
        'restored_status', v_next_status
      )),
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'suspended', false,
      'idempotent', false,
      'shop_id', v_shop.id,
      'plan_status', v_next_status,
      'status_before_suspension', NULL
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_shop_suspended(uuid, boolean, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_shop_suspended(uuid, boolean, text, text)
  TO authenticated, service_role;

-- 3.9 `public.reconcile_subscriptions`
--     Verifies that every shop's `plan_expiry_at` and `sales_access_until`
--     match its `trial_ends_at` + chronological approved `subscription_payments`
--     + `subscription_extended` audit entries, and checks plan amounts,
--     `payment_reference_locks`, and `pending_payment_id` pointers.
CREATE OR REPLACE FUNCTION public.reconcile_subscriptions(
  p_shop_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := COALESCE(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    (auth.jwt() ->> 'role'),
    ''
  );
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_shops_checked integer := 0;
  v_expiry_mismatches integer := 0;
  v_amount_mismatches integer := 0;
  v_lock_mismatches integer := 0;
  v_pointer_mismatches integer := 0;
  v_details jsonb := '[]'::jsonb;
  v_shop public.shops;
  v_ev record;
  v_expected_expiry timestamptz;
  v_expected_sales_access timestamptz;
  v_start timestamptz;
  v_event_count integer;
  v_pending_id uuid;
  v_pending_count integer;
  v_bad_amount_count integer;
  v_bad_lock_count integer;
BEGIN
  IF v_jwt_role <> 'service_role' AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator MFA (aal2) access is required to reconcile subscriptions.'
      USING ERRCODE = '42501', DETAIL = 'ADMIN_MFA_REQUIRED';
  END IF;

  FOR v_shop IN
    SELECT sh.*
      FROM public.shops sh
     WHERE p_shop_id IS NULL OR sh.id = p_shop_id
     ORDER BY sh.created_at ASC, sh.id ASC
  LOOP
    v_shops_checked := v_shops_checked + 1;
    v_expected_expiry := v_shop.trial_ends_at;
    v_event_count := 0;

    FOR v_ev IN
      SELECT
        ev.kind,
        ev.event_at,
        ev.event_id,
        ev.months,
        ev.days,
        ev.recorded_start_at,
        ev.recorded_expiry_at
      FROM (
        SELECT
          'payment'::text AS kind,
          COALESCE(sp.reviewed_at, sp.submitted_at) AS event_at,
          sp.id::text AS event_id,
          pl.months AS months,
          NULL::integer AS days,
          sp.subscription_start_at AS recorded_start_at,
          sp.subscription_expiry_at AS recorded_expiry_at
        FROM public.subscription_payments sp
        LEFT JOIN public.subscription_plans pl ON pl.id = sp.plan_id
        WHERE sp.shop_id = v_shop.id
          AND sp.status = 'approved'
        UNION ALL
        SELECT
          'extension'::text AS kind,
          pa.created_at AS event_at,
          pa.id::text AS event_id,
          NULL::integer AS months,
          pa.days AS days,
          CASE
            WHEN (pa.metadata ? 'start_at') THEN (pa.metadata ->> 'start_at')::timestamptz
            ELSE NULL
          END AS recorded_start_at,
          CASE
            WHEN (pa.metadata ? 'expiry_at') THEN (pa.metadata ->> 'expiry_at')::timestamptz
            ELSE NULL
          END AS recorded_expiry_at
        FROM public.platform_audit pa
        WHERE pa.shop_id = v_shop.id
          AND pa.action = 'subscription_extended'
      ) ev
      ORDER BY ev.event_at ASC, ev.kind ASC, ev.event_id ASC
    LOOP
      v_event_count := v_event_count + 1;
      v_start := GREATEST(v_ev.event_at, v_expected_expiry);

      IF v_ev.kind = 'payment' THEN
        IF v_ev.months IS NULL THEN
          v_expected_expiry := NULL;
          EXIT;
        END IF;
        v_expected_expiry := public.add_utc_calendar_months(v_start, v_ev.months);
      ELSE
        IF v_ev.days IS NULL THEN
          v_expected_expiry := NULL;
          EXIT;
        END IF;
        v_expected_expiry := v_start + pg_catalog.make_interval(days => v_ev.days);
      END IF;
    END LOOP;

    -- Expected sales_access_until:
    -- When events occurred, always `expected_expiry + 3 days`.
    -- On pure initial shops (`v_event_count = 0`), either `trial_ends_at + 3 days`
    -- (trial granted) or `trial_ends_at` (already-used phone starting expired).
    IF v_expected_expiry IS NULL THEN
      v_expiry_mismatches := v_expiry_mismatches + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'kind', 'expiry_mismatch',
          'shop_id', v_shop.id,
          'reason', 'invalid_plan_or_extension_history'
        )
      );
    ELSE
      v_expected_sales_access := v_expected_expiry + interval '3 days';
      IF v_shop.plan_expiry_at <> v_expected_expiry
         OR (
           v_event_count > 0 AND v_shop.sales_access_until <> v_expected_sales_access
         )
         OR (
           v_event_count = 0
           AND v_shop.sales_access_until NOT IN (v_expected_expiry, v_expected_sales_access)
         )
      THEN
        v_expiry_mismatches := v_expiry_mismatches + 1;
        v_details := v_details || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'kind', 'expiry_mismatch',
            'shop_id', v_shop.id,
            'actual_plan_expiry_at', v_shop.plan_expiry_at,
            'expected_plan_expiry_at', v_expected_expiry,
            'actual_sales_access_until', v_shop.sales_access_until,
            'expected_sales_access_until', v_expected_sales_access
          )
        );
      END IF;
    END IF;

    -- Payment amount vs server plan price check
    SELECT COUNT(*)::integer
      INTO v_bad_amount_count
      FROM public.subscription_payments sp
      LEFT JOIN public.subscription_plans pl ON pl.id = sp.plan_id
     WHERE sp.shop_id = v_shop.id
       AND (pl.id IS NULL OR sp.amount_ngwee <> pl.price_ngwee);

    IF v_bad_amount_count > 0 THEN
      v_amount_mismatches := v_amount_mismatches + v_bad_amount_count;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'kind', 'payment_amount_mismatch',
          'shop_id', v_shop.id,
          'count', v_bad_amount_count
        )
      );
    END IF;

    -- Reference lock consistency check
    SELECT COUNT(*)::integer
      INTO v_bad_lock_count
      FROM public.subscription_payments sp
      LEFT JOIN public.payment_reference_locks prl ON prl.payment_id = sp.id
     WHERE sp.shop_id = v_shop.id
       AND (
         prl.id IS NULL
         OR prl.status <> sp.status
         OR prl.network <> sp.network
         OR prl.transaction_reference <> sp.transaction_reference
       );

    IF v_bad_lock_count > 0 THEN
      v_lock_mismatches := v_lock_mismatches + v_bad_lock_count;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'kind', 'reference_lock_mismatch',
          'shop_id', v_shop.id,
          'count', v_bad_lock_count
        )
      );
    END IF;

    -- Shop pending pointer & suspension status consistency check
    SELECT COUNT(*)::integer, MAX(sp.id::text)::uuid
      INTO v_pending_count, v_pending_id
      FROM public.subscription_payments sp
     WHERE sp.shop_id = v_shop.id
       AND sp.status = 'pending';

    IF v_pending_count > 1
       OR v_shop.pending_payment_id IS DISTINCT FROM v_pending_id
       OR v_shop.is_deactivated <> (v_shop.plan_status = 'suspended')
    THEN
      v_pointer_mismatches := v_pointer_mismatches + 1;
      v_details := v_details || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'kind', 'shop_pointer_mismatch',
          'shop_id', v_shop.id,
          'shop_pending_payment_id', v_shop.pending_payment_id,
          'actual_pending_payment_id', v_pending_id,
          'is_deactivated', v_shop.is_deactivated,
          'plan_status', v_shop.plan_status
        )
      );
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'checked_at', v_now,
    'shops_checked', v_shops_checked,
    'total_differences', (v_expiry_mismatches + v_amount_mismatches + v_lock_mismatches + v_pointer_mismatches),
    'expiry_mismatch_count', v_expiry_mismatches,
    'payment_amount_mismatch_count', v_amount_mismatches,
    'reference_lock_mismatch_count', v_lock_mismatches,
    'shop_pointer_mismatch_count', v_pointer_mismatches,
    'details', v_details
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_subscriptions(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_subscriptions(uuid)
  TO authenticated, service_role;
