-- =============================================================================
-- CountUp Phase 3c — Backup Restore (`import_shop_backup`), Poison-Op Audit,
-- 72h Receive-Time Enforcement & Function Privilege Hardening
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tighten internal helper privileges (`lock_authorized_shop_for_write`)
--    Only SECURITY DEFINER RPCs (running as definer) and service_role need it;
--    neither PUBLIC, anon, nor direct authenticated callers need EXECUTE on it.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.lock_authorized_shop_for_write(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_authorized_shop_for_write(uuid)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Refine `public.record_sale` 72h offline window against server receive time
--    - If `server_receive_time - client_created_at > 72h` AND the shop's plan +
--      3-day grace (`sales_access_until`) has expired at receive time -> REJECT
--      (`PLAN_EXPIRED`).
--    - If `server_receive_time - client_created_at > 72h` while the shop's plan
--      is still active/grace -> SAVE & FLAG (`offline_window_flagged = true`,
--      `exceeded_bounded_offline_window`, `created_at` clamped to server time).
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
      'sale_id', COALESCE(v_existing_op.sale_id, v_sale_id)
    );
  END IF;

  IF v_shop.is_deactivated OR v_shop.plan_status = 'suspended' THEN
    RAISE EXCEPTION 'New sales are locked because this shop is suspended.'
      USING ERRCODE = '42501', DETAIL = 'SHOP_SUSPENDED';
  END IF;

  IF COALESCE(p_is_offline_sync, false) THEN
    -- Reject offline sales on an expired shop if the shop was already expired at
    -- last server contact, OR if the timestamp is missing / after access expiry /
    -- older than 72h before server receive time.
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
      'warning',
      'security',
      'Offline sale synced outside 72h window',
      pg_catalog.left(
        'Offline sale ' || v_sale_id || ' exceeded the 72h offline sync window (' ||
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
    'offline_flag_reason', v_flag_reason
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
-- 3. Extend `public.resolve_sync_conflict` with `'discard-poison'` audit trail
--    When a shopkeeper inspects and confirms discarding an unrecoverable head
--    operation, its original summary & rejection reason are recorded in
--    `public.sync_operations` so nothing is ever silently lost.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_sync_conflict(uuid, text, text, text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.resolve_sync_conflict(
  p_shop_id uuid,
  p_operation_id text,
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

  v_resolved_iso := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_resolution ->> 'resolvedAt', '')), ''),
    pg_catalog.to_json(v_now) #>> '{}'
  );

  IF p_decision = 'discard-poison' THEN
    v_final_resolution := COALESCE(p_resolution, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'kind', 'discard-poison',
      'resolvedAt', v_resolved_iso
    );

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
      'conflict_resolution',
      'resolved',
      NULL,
      true,
      v_final_resolution,
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'resolved',
      'idempotent', false,
      'outcome', 'resolved',
      'resolution', v_final_resolution
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
    'conflict_resolution',
    'resolved',
    CASE WHEN v_kind = 'void' THEN v_sale.id ELSE NULL END,
    true,
    v_final_resolution,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved',
    'idempotent', false,
    'outcome', 'resolved',
    'resolution', v_final_resolution
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_sync_conflict(uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_sync_conflict(uuid, text, text, jsonb, jsonb)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Strict server-side parsing helpers for hostile backup JSON
--    - Zero floating-point math.
--    - Rejects > 2 decimal places (`12.505`), negatives, strings like `"abc"`,
--      scientific notation, and absurd numbers (`> 10_000_000_000` ngwee = K100M).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_strict_kwacha_to_ngwee(
  p_val jsonb,
  p_field text,
  p_allow_zero boolean DEFAULT true
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
  v_whole numeric;
  v_frac_raw text;
  v_frac numeric;
  v_ngwee numeric;
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
    RAISE EXCEPTION 'Invalid monetary value for %: must be a Kwacha decimal number or string.', p_field
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  IF v_txt !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
    IF v_txt ~ '^[0-9]+\.[0-9]{3,}$' THEN
      RAISE EXCEPTION 'Invalid monetary precision for % ("%"): at most 2 decimal places are allowed.', p_field, v_txt
        USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_PRECISION';
    END IF;
    RAISE EXCEPTION 'Invalid monetary value for % ("%").', p_field, pg_catalog.left(v_txt, 40)
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  v_whole := pg_catalog.split_part(v_txt, '.', 1)::numeric;
  v_frac_raw := pg_catalog.split_part(v_txt, '.', 2);
  v_frac := pg_catalog.rpad(COALESCE(NULLIF(v_frac_raw, ''), '0'), 2, '0')::numeric;
  v_ngwee := (v_whole * 100) + v_frac;

  IF v_ngwee > 10000000000 THEN
    RAISE EXCEPTION 'Monetary value for % exceeds the maximum allowed limit (K100,000,000.00).', p_field
      USING ERRCODE = '22023', DETAIL = 'ABSURD_MONEY_VALUE';
  END IF;

  IF NOT p_allow_zero AND v_ngwee <= 0 THEN
    RAISE EXCEPTION 'Monetary value for % must be greater than zero.', p_field
      USING ERRCODE = '22023', DETAIL = 'NON_POSITIVE_MONEY_VALUE';
  END IF;

  RETURN v_ngwee::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.parse_strict_kwacha_to_ngwee(jsonb, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_strict_kwacha_to_ngwee(jsonb, text, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.parse_strict_integer_ngwee(
  p_val jsonb,
  p_field text,
  p_allow_zero boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_txt text;
  v_num numeric;
BEGIN
  IF p_val IS NULL OR pg_catalog.jsonb_typeof(p_val) <> 'number' THEN
    RAISE EXCEPTION 'Invalid integer ngwee value for %.', p_field
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  v_txt := p_val::text;
  IF v_txt !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid integer ngwee value for % ("%"): whole non-negative ngwee required.', p_field, pg_catalog.left(v_txt, 40)
      USING ERRCODE = '22023', DETAIL = 'INVALID_MONEY_VALUE';
  END IF;

  v_num := v_txt::numeric;
  IF v_num > 10000000000 THEN
    RAISE EXCEPTION 'Monetary value for % exceeds the maximum allowed limit.', p_field
      USING ERRCODE = '22023', DETAIL = 'ABSURD_MONEY_VALUE';
  END IF;

  IF NOT p_allow_zero AND v_num <= 0 THEN
    RAISE EXCEPTION 'Monetary value for % must be greater than zero.', p_field
      USING ERRCODE = '22023', DETAIL = 'NON_POSITIVE_MONEY_VALUE';
  END IF;

  RETURN v_num::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.parse_strict_integer_ngwee(jsonb, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_strict_integer_ngwee(jsonb, text, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.parse_strict_bounded_int(
  p_val jsonb,
  p_field text,
  p_min integer,
  p_max integer
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_txt text;
  v_num numeric;
BEGIN
  IF p_val IS NULL OR pg_catalog.jsonb_typeof(p_val) <> 'number' THEN
    RAISE EXCEPTION 'Invalid integer for %.', p_field
      USING ERRCODE = '22023', DETAIL = 'INVALID_INTEGER_VALUE';
  END IF;

  v_txt := p_val::text;
  IF v_txt !~ '^-?[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid integer for % ("%").', p_field, pg_catalog.left(v_txt, 40)
      USING ERRCODE = '22023', DETAIL = 'INVALID_INTEGER_VALUE';
  END IF;

  v_num := v_txt::numeric;
  IF v_num < p_min OR v_num > p_max THEN
    RAISE EXCEPTION 'Value for % (%) is outside the allowed range [% .. %].', p_field, v_txt, p_min, p_max
      USING ERRCODE = '22023', DETAIL = 'INTEGER_OUT_OF_RANGE';
  END IF;

  RETURN v_num::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.parse_strict_bounded_int(jsonb, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_strict_bounded_int(jsonb, text, integer, integer)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Phase 3c: `public.import_shop_backup`
--    - Supports `shopbook-backup-v1` and `countup-backup-v2`.
--    - Treats file as hostile: enforces 5 MB payload cap, strict top-level key
--      allowlist (rejects unknown record types), collection & total record count
--      limits, safe decimal -> integer ngwee conversion, non-negative/bounded
--      numbers, FK & receipt/profit/credit/stock ledger math.
--    - Supports `p_dry_run = true` preview (items, sales, customers, expenses,
--      total stock value, total owed, existing-data flag, duplicate flag).
--    - Refuses restoring into a non-empty shop unless `p_allow_non_empty_shop`.
--    - Idempotent by `(shop_id, operation_id)` AND `(shop_id, 'backup_sha256:' || hash)`.
--    - Generates opening stock movements & sale_lines so all 4 invariants hold,
--      runs `public.reconcile_shop_ledger(p_shop_id)` inside the transaction,
--      and rolls back completely if any difference appears.
--    - Rate-limited and writes a `public.platform_audit` entry.
-- -----------------------------------------------------------------------------
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
  v_total_records integer := 0;
  v_rec record;
  v_line record;
  v_item_id text;
  v_cust_id text;
  v_sale_id text;
  v_line_id text;
  v_pay_id text;
  v_exp_id text;
  v_mv_id text;
  v_buying_known boolean;
  v_buying_ngwee bigint;
  v_selling_ngwee bigint;
  v_qty integer;
  v_threshold integer;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_pay_type text;
  v_momo_op text;
  v_total_ngwee bigint;
  v_cost_ngwee bigint;
  v_missing_ngwee bigint;
  v_profit_ngwee bigint;
  v_cash_tendered bigint;
  v_change_given bigint;
  v_items_count integer;
  v_active_items_count integer;
  v_archived_items_count integer;
  v_sales_count integer;
  v_customers_count integer;
  v_expenses_count integer;
  v_payments_count integer;
  v_movements_count integer;
  v_total_stock_value_ngwee bigint;
  v_total_owed_ngwee bigint;
  v_preview jsonb;
  v_recon jsonb;
BEGIN
  -- 1. Ownership + session verification + advisory lock
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_op_id = '' OR pg_catalog.char_length(v_op_id) > 160 OR pg_catalog.strpos(v_op_id, '/') > 0 THEN
    RAISE EXCEPTION 'Invalid backup operation ID.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_OPERATION_ID';
  END IF;

  IF p_backup IS NULL OR pg_catalog.jsonb_typeof(p_backup) <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: expected a JSON object.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_BACKUP_ROOT';
  END IF;

  -- 2. Hostile file size check (5 MB max)
  v_payload_bytes := pg_catalog.octet_length(p_backup::text);
  IF v_payload_bytes > 5000000 THEN
    RAISE EXCEPTION 'The backup exceeds the 5 MB maximum size limit.'
      USING ERRCODE = '22023', DETAIL = 'PAYLOAD_TOO_LARGE';
  END IF;

  -- 3. Deterministic file hash + operation_id idempotency check
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

  -- Check if shop already contains any records
  SELECT (
    EXISTS (SELECT 1 FROM public.items i WHERE i.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.sales s WHERE s.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.customers c WHERE c.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.credit_payments cp WHERE cp.shop_id = p_shop_id)
    OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.shop_id = p_shop_id)
  ) INTO v_shop_has_data;

  -- 4. Rate limit committed imports per shop (max 5 / hour, 10 / 24h)
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

  -- 5. Format & unknown top-level record-type validation
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
       'format',
       'exportedAt',
       'shopSettings',
       'products',
       'customers',
       'sales',
       'saleItems',
       'stockMovements',
       'creditTransactions',
       'expenses'
     )
     LIMIT 1;
  ELSE
    SELECT k
      INTO v_bad_key
      FROM pg_catalog.jsonb_object_keys(p_backup) AS k
     WHERE k NOT IN (
       'format',
       'version',
       'exportedAt',
       'shop',
       'subscription',
       'items',
       'archivedItems',
       'sales',
       'customers',
       'creditPayments',
       'expenses',
       'stockMovements',
       'stockConflicts'
     )
     LIMIT 1;
  END IF;

  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Backup contains an unknown top-level record type ("%").', pg_catalog.left(v_bad_key, 60)
      USING ERRCODE = '22023', DETAIL = 'UNKNOWN_RECORD_TYPE';
  END IF;

  -- 6. Prepare transaction-scoped staging tables (truncated cleanly per call)
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

  -- ===========================================================================
  -- 7A. Parse & validate `shopbook-backup-v1`
  -- ===========================================================================
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

    IF pg_catalog.jsonb_array_length(p_backup -> 'products') > 2000
       OR pg_catalog.jsonb_array_length(p_backup -> 'customers') > 2000
       OR pg_catalog.jsonb_array_length(p_backup -> 'sales') > 5000
       OR pg_catalog.jsonb_array_length(p_backup -> 'saleItems') > 15000
       OR pg_catalog.jsonb_array_length(p_backup -> 'stockMovements') > 15000
       OR pg_catalog.jsonb_array_length(p_backup -> 'creditTransactions') > 10000
    THEN
      RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
        USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
    END IF;

    v_source_shop_name := pg_catalog.left(
      pg_catalog.btrim(COALESCE(p_backup #>> '{shopSettings,shopName}', '')),
      120
    );

    -- Products -> tmp_backup_items (`shopbook_<id>`)
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

    -- Customers -> tmp_backup_customers
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

    -- Sales -> tmp_backup_sales
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
      -- Also verify knownCostRevenueNgwee + missingCostRevenueNgwee = totalNgwee
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
        v_sale_id,
        v_qty,
        v_total_ngwee,
        v_cost_ngwee,
        v_profit_ngwee,
        v_missing_ngwee,
        v_pay_type,
        NULL,
        v_cust_id,
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'customerNameSnapshot', ''), 200), ''),
        NULL,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'receiptNumber', v_sale_id)), 120),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'paymentReference', ''), 120), ''),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500), ''),
        NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'localDate', '')), ''),
        NULL,
        NULL,
        false,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        v_created_at,
        v_created_at
      );
    END LOOP;

    -- SaleItems -> tmp_backup_sale_lines
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
        v_line_id,
        v_sale_id,
        v_line.idx,
        v_item_id,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_line.elem ->> 'productNameAtSale', '')), 200),
        pg_catalog.left(COALESCE(v_line.elem ->> 'unitLabelAtSale', ''), 60),
        v_qty,
        v_buying_ngwee,
        v_buying_known,
        v_selling_ngwee,
        v_total_ngwee,
        (v_line.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;

    -- CreditTransactions -> verify 1-to-1 credit_sale + extract repayments
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
          v_pay_id,
          v_cust_id,
          pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerNameSnapshot', 'Customer')), 200),
          v_total_ngwee,
          v_pay_type,
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

    -- Ensure every credit sale had a matching credit_sale transaction in v1
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

    -- StockMovements -> tmp_backup_movements
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
        v_mv_id,
        v_item_id,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'productNameSnapshot', 'Item')), 200),
        v_rec.elem ->> 'type',
        public.parse_strict_bounded_int(v_rec.elem -> 'deltaQty', 'stockMovements.deltaQty', -1000000, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'previousQty', 'stockMovements.previousQty', 0, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'newQty', 'stockMovements.newQty', 0, 1000000),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'reason', ''), 500),
        v_sale_id,
        NULL,
        false,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;

  -- ===========================================================================
  -- 7B. Parse & validate `countup-backup-v2` (Kwacha decimals -> strict ngwee)
  -- ===========================================================================
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
         + pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'archivedItems', '[]'::jsonb)) > 2000
       OR pg_catalog.jsonb_array_length(p_backup -> 'customers') > 2000
       OR pg_catalog.jsonb_array_length(p_backup -> 'sales') > 5000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'creditPayments', '[]'::jsonb)) > 5000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'expenses', '[]'::jsonb)) > 5000
       OR pg_catalog.jsonb_array_length(COALESCE(p_backup -> 'stockMovements', '[]'::jsonb)) > 15000
    THEN
      RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
        USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
    END IF;

    v_source_shop_name := pg_catalog.left(
      pg_catalog.btrim(COALESCE(p_backup #>> '{shop,name}', '')),
      120
    );

    -- Active + archived items
    FOR v_rec IN
      SELECT elem, is_arch
        FROM (
          SELECT elem, false AS is_arch
            FROM pg_catalog.jsonb_array_elements(p_backup -> 'items') AS a(elem)
          UNION ALL
          SELECT elem, true AS is_arch
            FROM pg_catalog.jsonb_array_elements(COALESCE(p_backup -> 'archivedItems', '[]'::jsonb)) AS b(elem)
        ) combined
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid item record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_RECORD';
      END IF;
      v_item_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_item_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid item ID "%".', pg_catalog.left(v_item_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items WHERE id = v_item_id) THEN
        RAISE EXCEPTION 'Backup has duplicate item ID "%".', v_item_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;
      IF pg_catalog.btrim(COALESCE(v_rec.elem ->> 'name', '')) = ''
         OR pg_catalog.char_length(v_rec.elem ->> 'name') > 200
      THEN
        RAISE EXCEPTION 'Invalid item name on "%".', v_item_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_ITEM_NAME';
      END IF;

      v_selling_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'sellingPrice', 'items.sellingPrice', false);
      v_buying_known := CASE
        WHEN (v_rec.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(v_rec.elem -> 'buyingPriceKnown') = 'boolean'
          THEN (v_rec.elem -> 'buyingPriceKnown')::boolean
        ELSE true
      END;
      IF v_buying_known THEN
        v_buying_ngwee := public.parse_strict_kwacha_to_ngwee(
          COALESCE(v_rec.elem -> 'buyingPrice', '0'::jsonb),
          'items.buyingPrice',
          true
        );
      ELSE
        v_buying_ngwee := 0;
      END IF;

      v_qty := public.parse_strict_bounded_int(v_rec.elem -> 'quantity', 'items.quantity', 0, 1000000);
      v_threshold := public.parse_strict_bounded_int(
        COALESCE(v_rec.elem -> 'lowStockThreshold', '5'::jsonb),
        'items.lowStockThreshold',
        0,
        1000000
      );
      v_created_at := (v_rec.elem ->> 'createdAt')::timestamptz;
      v_updated_at := COALESCE((v_rec.elem ->> 'updatedAt')::timestamptz, v_created_at);

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
        v_rec.is_arch OR COALESCE((v_rec.elem -> 'isDeleted')::boolean, false),
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        CASE WHEN NULLIF(v_rec.elem ->> 'lastSoldAt', '') IS NOT NULL THEN (v_rec.elem ->> 'lastSoldAt')::timestamptz ELSE NULL END,
        v_created_at,
        v_updated_at
      );
    END LOOP;

    -- Customers
    FOR v_rec IN
      SELECT elem
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'customers') AS t(elem)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid customer record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_RECORD';
      END IF;
      v_cust_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_cust_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid customer ID "%".', pg_catalog.left(v_cust_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_customers WHERE id = v_cust_id) THEN
        RAISE EXCEPTION 'Backup has duplicate customer ID "%".', v_cust_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;
      IF pg_catalog.btrim(COALESCE(v_rec.elem ->> 'name', '')) = ''
         OR pg_catalog.char_length(v_rec.elem ->> 'name') > 200
      THEN
        RAISE EXCEPTION 'Invalid customer name on "%".', v_cust_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_CUSTOMER_NAME';
      END IF;

      v_total_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'totalOwed', 'customers.totalOwed', true);
      v_created_at := (v_rec.elem ->> 'createdAt')::timestamptz;
      v_updated_at := COALESCE((v_rec.elem ->> 'updatedAt')::timestamptz, v_created_at);

      INSERT INTO pg_temp.tmp_backup_customers (
        id, name, phone, notes, expected_owed_ngwee, computed_owed_ngwee,
        is_demo, created_at, updated_at
      ) VALUES (
        v_cust_id,
        pg_catalog.btrim(v_rec.elem ->> 'name'),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'phone', ''), 40),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'notes', ''), 500),
        v_total_ngwee,
        0,
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        v_created_at,
        v_updated_at
      );
    END LOOP;

    -- Sales + embedded sale lines
    FOR v_rec IN
      SELECT elem
        FROM pg_catalog.jsonb_array_elements(p_backup -> 'sales') AS t(elem)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid sale record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_RECORD';
      END IF;
      v_sale_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_sale_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid sale ID "%".', pg_catalog.left(v_sale_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales WHERE id = v_sale_id) THEN
        RAISE EXCEPTION 'Backup has duplicate sale ID "%".', v_sale_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;

      IF pg_catalog.jsonb_typeof(v_rec.elem -> 'items') <> 'array'
         OR pg_catalog.jsonb_array_length(v_rec.elem -> 'items') < 1
         OR pg_catalog.jsonb_array_length(v_rec.elem -> 'items') > 160
      THEN
        RAISE EXCEPTION 'Sale "%" must contain between 1 and 160 line items.', v_sale_id
          USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINES';
      END IF;

      v_pay_type := COALESCE(v_rec.elem ->> 'paymentType', '');
      IF v_pay_type NOT IN ('cash', 'momo', 'credit') THEN
        RAISE EXCEPTION 'Sale "%" has invalid paymentType "%".', v_sale_id, pg_catalog.left(v_pay_type, 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_TYPE';
      END IF;

      v_momo_op := NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'momoOperator', '')), '');
      IF v_momo_op IS NOT NULL AND v_momo_op NOT IN ('airtel', 'mtn', 'zamtel') THEN
        RAISE EXCEPTION 'Sale "%" has invalid momoOperator "%".', v_sale_id, pg_catalog.left(v_momo_op, 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOMO_OPERATOR';
      END IF;

      v_cust_id := NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerId', '')), '');
      v_qty := public.parse_strict_bounded_int(v_rec.elem -> 'itemsCount', 'sales.itemsCount', 1, 1000000);
      v_total_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'totalAmount', 'sales.totalAmount', false);
      v_cost_ngwee := public.parse_strict_kwacha_to_ngwee(COALESCE(v_rec.elem -> 'totalCost', '0'::jsonb), 'sales.totalCost', true);
      v_missing_ngwee := public.parse_strict_kwacha_to_ngwee(
        COALESCE(v_rec.elem -> 'missingCostRevenue', '0'::jsonb),
        'sales.missingCostRevenue',
        true
      );
      -- Profit in v2 can be negative if sold below cost! Parse signed or compute & verify:
      IF (v_rec.elem ? 'profit') AND (v_rec.elem -> 'profit') IS NOT NULL THEN
        IF pg_catalog.btrim(COALESCE(v_rec.elem ->> 'profit', '')) ~ '^-' THEN
          v_profit_ngwee := -public.parse_strict_kwacha_to_ngwee(
            pg_catalog.to_jsonb(pg_catalog.substr(pg_catalog.btrim(v_rec.elem ->> 'profit'), 2)),
            'sales.profit',
            true
          );
        ELSE
          v_profit_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'profit', 'sales.profit', true);
        END IF;
        IF v_profit_ngwee <> (v_total_ngwee - v_cost_ngwee - v_missing_ngwee) THEN
          RAISE EXCEPTION 'Sale "%" profit does not equal revenue minus cost.', v_sale_id
            USING ERRCODE = '22023', DETAIL = 'SALE_PROFIT_MISMATCH';
        END IF;
      ELSE
        v_profit_ngwee := v_total_ngwee - v_cost_ngwee - v_missing_ngwee;
      END IF;

      IF (v_rec.elem ? 'cashTendered') AND (v_rec.elem -> 'cashTendered') IS NOT NULL AND pg_catalog.jsonb_typeof(v_rec.elem -> 'cashTendered') <> 'null' THEN
        v_cash_tendered := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'cashTendered', 'sales.cashTendered', false);
        IF v_cash_tendered < v_total_ngwee THEN
          RAISE EXCEPTION 'Sale "%" cashTendered is less than totalAmount.', v_sale_id
            USING ERRCODE = '22023', DETAIL = 'INVALID_CASH_TENDERED';
        END IF;
        v_change_given := v_cash_tendered - v_total_ngwee;
      ELSE
        v_cash_tendered := NULL;
        v_change_given := NULL;
      END IF;

      v_created_at := (v_rec.elem ->> 'createdAt')::timestamptz;

      INSERT INTO pg_temp.tmp_backup_sales (
        id, items_count, total_amount_ngwee, total_cost_ngwee, profit_ngwee,
        missing_cost_revenue_ngwee, payment_type, momo_operator, customer_id,
        customer_name, customer_phone, receipt_number, payment_reference,
        note, local_date, cash_tendered_ngwee, change_given_ngwee,
        is_deleted, is_demo, created_at, updated_at
      ) VALUES (
        v_sale_id,
        v_qty,
        v_total_ngwee,
        v_cost_ngwee,
        v_profit_ngwee,
        v_missing_ngwee,
        v_pay_type,
        CASE WHEN v_pay_type = 'momo' THEN v_momo_op ELSE NULL END,
        v_cust_id,
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'customerName', ''), 200), ''),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'customerPhone', ''), 40), ''),
        pg_catalog.left(pg_catalog.btrim(COALESCE(NULLIF(v_rec.elem ->> 'receiptNumber', ''), v_sale_id)), 120),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'paymentReference', ''), 120), ''),
        NULLIF(pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500), ''),
        NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'localDate', '')), ''),
        v_cash_tendered,
        v_change_given,
        COALESCE((v_rec.elem -> 'isDeleted')::boolean, false),
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        v_created_at,
        v_created_at
      );

      FOR v_line IN
        SELECT elem, (ord - 1)::integer AS idx
          FROM pg_catalog.jsonb_array_elements(v_rec.elem -> 'items') WITH ORDINALITY AS l(elem, ord)
      LOOP
        IF pg_catalog.jsonb_typeof(v_line.elem) <> 'object' THEN
          RAISE EXCEPTION 'Invalid line item on sale "%".', v_sale_id
            USING ERRCODE = '22023', DETAIL = 'INVALID_SALE_LINE';
        END IF;
        v_item_id := pg_catalog.btrim(COALESCE(v_line.elem ->> 'itemId', ''));
        v_selling_ngwee := public.parse_strict_kwacha_to_ngwee(v_line.elem -> 'sellingPrice', 'sale.items.sellingPrice', false);
        v_buying_known := CASE
          WHEN (v_line.elem ? 'buyingPriceKnown') AND pg_catalog.jsonb_typeof(v_line.elem -> 'buyingPriceKnown') = 'boolean'
            THEN (v_line.elem -> 'buyingPriceKnown')::boolean
          ELSE true
        END;
        IF v_buying_known THEN
          v_buying_ngwee := public.parse_strict_kwacha_to_ngwee(
            COALESCE(v_line.elem -> 'buyingPrice', '0'::jsonb),
            'sale.items.buyingPrice',
            true
          );
        ELSE
          v_buying_ngwee := 0;
        END IF;
        v_qty := public.parse_strict_bounded_int(v_line.elem -> 'quantity', 'sale.items.quantity', 1, 1000000);
        v_total_ngwee := v_selling_ngwee * v_qty;

        IF (v_line.elem ? 'total') AND (v_line.elem -> 'total') IS NOT NULL AND pg_catalog.jsonb_typeof(v_line.elem -> 'total') <> 'null' THEN
          IF public.parse_strict_kwacha_to_ngwee(v_line.elem -> 'total', 'sale.items.total', false) <> v_total_ngwee THEN
            RAISE EXCEPTION 'Line item total on sale "%" does not match sellingPrice * quantity.', v_sale_id
              USING ERRCODE = '22023', DETAIL = 'SALE_LINE_TOTAL_MISMATCH';
          END IF;
        END IF;

        v_line_id := v_sale_id || ':' || v_line.idx::text;
        IF pg_catalog.char_length(v_line_id) > 160 THEN
          v_line_id := 'sl_' || pg_catalog.md5(v_sale_id || ':' || v_line.idx::text);
        END IF;

        INSERT INTO pg_temp.tmp_backup_sale_lines (
          id, sale_id, line_index, item_id, item_name, unit_label,
          quantity, buying_price_ngwee, buying_price_known,
          selling_price_ngwee, line_total_ngwee, created_at
        ) VALUES (
          v_line_id,
          v_sale_id,
          v_line.idx,
          v_item_id,
          pg_catalog.left(pg_catalog.btrim(COALESCE(v_line.elem ->> 'name', 'Item')), 200),
          pg_catalog.left(COALESCE(v_line.elem ->> 'unitLabel', ''), 60),
          v_qty,
          v_buying_ngwee,
          v_buying_known,
          v_selling_ngwee,
          v_total_ngwee,
          v_created_at
        );
      END LOOP;

      IF NOT COALESCE((v_rec.elem -> 'isDeleted')::boolean, false) AND v_pay_type = 'credit' AND v_cust_id IS NOT NULL THEN
        UPDATE pg_temp.tmp_backup_customers
           SET computed_owed_ngwee = computed_owed_ngwee + (
             SELECT s.total_amount_ngwee FROM pg_temp.tmp_backup_sales s WHERE s.id = v_sale_id
           )
         WHERE id = v_cust_id;
      END IF;
    END LOOP;

    -- Credit payments
    FOR v_rec IN
      SELECT elem
        FROM pg_catalog.jsonb_array_elements(COALESCE(p_backup -> 'creditPayments', '[]'::jsonb)) AS t(elem)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid creditPayment record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_RECORD';
      END IF;
      v_pay_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_pay_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid creditPayment ID "%".', pg_catalog.left(v_pay_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_payments WHERE id = v_pay_id) THEN
        RAISE EXCEPTION 'Backup has duplicate creditPayment ID "%".', v_pay_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;

      v_cust_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerId', ''));
      v_total_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'amount', 'creditPayments.amount', false);
      v_pay_type := COALESCE(v_rec.elem ->> 'paymentMethod', 'cash');
      IF v_pay_type NOT IN ('cash', 'momo') THEN
        RAISE EXCEPTION 'creditPayment "%" has invalid paymentMethod "%".', v_pay_id, pg_catalog.left(v_pay_type, 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_PAYMENT_METHOD';
      END IF;

      INSERT INTO pg_temp.tmp_backup_payments (
        id, customer_id, customer_name, amount_ngwee, payment_method,
        note, local_date, is_demo, created_at
      ) VALUES (
        v_pay_id,
        v_cust_id,
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'customerName', 'Customer')), 200),
        v_total_ngwee,
        v_pay_type,
        pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500),
        NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'localDate', '')), ''),
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz
      );

      UPDATE pg_temp.tmp_backup_customers
         SET computed_owed_ngwee = computed_owed_ngwee - v_total_ngwee
       WHERE id = v_cust_id;
    END LOOP;

    -- Expenses
    FOR v_rec IN
      SELECT elem
        FROM pg_catalog.jsonb_array_elements(COALESCE(p_backup -> 'expenses', '[]'::jsonb)) AS t(elem)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid expense record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_EXPENSE_RECORD';
      END IF;
      v_exp_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_exp_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid expense ID "%".', pg_catalog.left(v_exp_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_EXPENSE_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_expenses WHERE id = v_exp_id) THEN
        RAISE EXCEPTION 'Backup has duplicate expense ID "%".', v_exp_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;

      IF COALESCE(v_rec.elem ->> 'category', '') NOT IN ('rent', 'transport', 'restock', 'council_fee', 'helper_wage', 'other') THEN
        RAISE EXCEPTION 'Expense "%" has invalid category "%".', v_exp_id, pg_catalog.left(COALESCE(v_rec.elem ->> 'category', ''), 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_EXPENSE_CATEGORY';
      END IF;

      v_total_ngwee := public.parse_strict_kwacha_to_ngwee(v_rec.elem -> 'amount', 'expenses.amount', false);

      INSERT INTO pg_temp.tmp_backup_expenses (
        id, category, amount_ngwee, note, is_deleted, created_at
      ) VALUES (
        v_exp_id,
        v_rec.elem ->> 'category',
        v_total_ngwee,
        pg_catalog.left(COALESCE(v_rec.elem ->> 'note', ''), 500),
        COALESCE((v_rec.elem -> 'isDeleted')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;

    -- Stock movements (optional in v2; opening movements generated below if absent/partial)
    FOR v_rec IN
      SELECT elem
        FROM pg_catalog.jsonb_array_elements(COALESCE(p_backup -> 'stockMovements', '[]'::jsonb)) AS t(elem)
    LOOP
      IF pg_catalog.jsonb_typeof(v_rec.elem) <> 'object' THEN
        RAISE EXCEPTION 'Invalid stockMovement record in backup.'
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_RECORD';
      END IF;
      v_mv_id := pg_catalog.btrim(COALESCE(v_rec.elem ->> 'id', ''));
      IF v_mv_id !~ '^[A-Za-z0-9_:-]{1,120}$' THEN
        RAISE EXCEPTION 'Invalid stockMovement ID "%".', pg_catalog.left(v_mv_id, 40)
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_ID';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_temp.tmp_backup_movements WHERE id = v_mv_id) THEN
        RAISE EXCEPTION 'Backup has duplicate stockMovement ID "%".', v_mv_id
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
      END IF;

      IF COALESCE(v_rec.elem ->> 'type', '') NOT IN ('initial', 'sale', 'restock', 'adjustment', 'void') THEN
        RAISE EXCEPTION 'stockMovement "%" has invalid type "%".', v_mv_id, pg_catalog.left(COALESCE(v_rec.elem ->> 'type', ''), 30)
          USING ERRCODE = '22023', DETAIL = 'INVALID_MOVEMENT_TYPE';
      END IF;

      v_sale_id := NULLIF(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'relatedSaleId', '')), '');

      INSERT INTO pg_temp.tmp_backup_movements (
        id, item_id, item_name, type, delta, previous_quantity, new_quantity,
        reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
      ) VALUES (
        v_mv_id,
        pg_catalog.btrim(COALESCE(v_rec.elem ->> 'itemId', '')),
        pg_catalog.left(pg_catalog.btrim(COALESCE(v_rec.elem ->> 'itemName', 'Item')), 200),
        v_rec.elem ->> 'type',
        public.parse_strict_bounded_int(v_rec.elem -> 'delta', 'stockMovements.delta', -1000000, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'previousQuantity', 'stockMovements.previousQuantity', 0, 1000000),
        public.parse_strict_bounded_int(v_rec.elem -> 'newQuantity', 'stockMovements.newQuantity', 0, 1000000),
        pg_catalog.left(COALESCE(v_rec.elem ->> 'reason', ''), 500),
        v_sale_id,
        CASE
          WHEN (v_rec.elem ? 'requestedQuantity') AND (v_rec.elem -> 'requestedQuantity') IS NOT NULL AND pg_catalog.jsonb_typeof(v_rec.elem -> 'requestedQuantity') <> 'null'
            THEN public.parse_strict_bounded_int(v_rec.elem -> 'requestedQuantity', 'stockMovements.requestedQuantity', 0, 1000000)
          ELSE NULL
        END,
        COALESCE((v_rec.elem -> 'recountNeeded')::boolean, false),
        COALESCE((v_rec.elem -> 'isDemo')::boolean, false),
        (v_rec.elem ->> 'createdAt')::timestamptz
      );
    END LOOP;
  END IF;

  -- ===========================================================================
  -- 8. Cross-collection reference & invariant validation (hostile-input checks)
  -- ===========================================================================

  -- 8.1 Sale lines must reference existing sales & items
  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_sale_lines sl
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_sales s WHERE s.id = sl.sale_id)
        OR NOT EXISTS (SELECT 1 FROM pg_temp.tmp_backup_items i WHERE i.id = sl.item_id)
  ) THEN
    RAISE EXCEPTION 'Backup has a sale line referring to a missing sale or product.'
      USING ERRCODE = '23503', DETAIL = 'MISMATCHED_REFERENCE';
  END IF;

  -- 8.2 Every sale must match its sale_lines totals, units, cost & profit
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

  -- 8.3 Credit sales & repayments must reference valid customers
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

  -- 8.4 Customer balances must be >= 0 and match (credit sales - repayments)
  IF EXISTS (
    SELECT 1
      FROM pg_temp.tmp_backup_customers c
     WHERE c.computed_owed_ngwee < 0
        OR (c.expected_owed_ngwee IS NOT NULL AND c.expected_owed_ngwee <> c.computed_owed_ngwee)
  ) THEN
    RAISE EXCEPTION 'A customer credit balance in the backup is negative or does not match credit sales minus repayments.'
      USING ERRCODE = '23514', DETAIL = 'CREDIT_LEDGER_MISMATCH';
  END IF;

  -- 8.5 Stock movements must reference valid items/sales & have consistent step math
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

  -- 8.6 Generate deterministic opening stock movements where needed so
  --     `items.quantity = COALESCE(SUM(stock_movements.delta), 0)` holds!
  FOR v_rec IN
    SELECT
      i.id AS item_id,
      i.name AS item_name,
      i.quantity AS target_qty,
      i.created_at,
      i.is_demo,
      COALESCE(SUM(m.delta), 0)::integer AS mv_sum,
      COUNT(m.id)::integer AS mv_count,
      COALESCE(BOOL_OR(m.type = 'initial'), false) AS has_initial
    FROM pg_temp.tmp_backup_items i
    LEFT JOIN pg_temp.tmp_backup_movements m ON m.item_id = i.id
    GROUP BY i.id, i.name, i.quantity, i.created_at, i.is_demo
  LOOP
    IF v_rec.mv_sum <> v_rec.target_qty THEN
      IF v_rec.has_initial OR (v_rec.target_qty - v_rec.mv_sum) < 0 THEN
        RAISE EXCEPTION 'Stock movement history for product "%" (%) does not match its quantity (%).',
          v_rec.item_name, v_rec.mv_sum, v_rec.target_qty
          USING ERRCODE = '23514', DETAIL = 'STOCK_LEDGER_MISMATCH';
      END IF;

      v_mv_id := v_rec.item_id || ':opening';
      IF pg_catalog.char_length(v_mv_id) > 128 THEN
        v_mv_id := 'open_' || pg_catalog.md5(v_rec.item_id);
      END IF;

      INSERT INTO pg_temp.tmp_backup_movements (
        id, item_id, item_name, type, delta, previous_quantity, new_quantity,
        reason, related_sale_id, requested_quantity, recount_needed, is_demo, created_at
      ) VALUES (
        v_mv_id,
        v_rec.item_id,
        v_rec.item_name,
        'initial',
        v_rec.target_qty - v_rec.mv_sum,
        0,
        v_rec.target_qty - v_rec.mv_sum,
        'Opening stock from backup restore',
        NULL,
        NULL,
        false,
        v_rec.is_demo,
        v_rec.created_at
      );
    END IF;
  END LOOP;

  -- 8.7 Enforce overall record count limit (<= 10,000 total rows)
  SELECT
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_items),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_items WHERE NOT is_deleted),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_items WHERE is_deleted),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_sales),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_customers),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_expenses),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_payments),
    (SELECT COUNT(*) FROM pg_temp.tmp_backup_movements),
    COALESCE((SELECT SUM(quantity::bigint * selling_price_ngwee) FROM pg_temp.tmp_backup_items WHERE NOT is_deleted), 0)::bigint,
    COALESCE((SELECT SUM(computed_owed_ngwee) FROM pg_temp.tmp_backup_customers), 0)::bigint
    INTO
      v_items_count,
      v_active_items_count,
      v_archived_items_count,
      v_sales_count,
      v_customers_count,
      v_expenses_count,
      v_payments_count,
      v_movements_count,
      v_total_stock_value_ngwee,
      v_total_owed_ngwee;

  v_total_records :=
    v_items_count + v_sales_count + v_customers_count + v_expenses_count + v_payments_count + v_movements_count
    + (SELECT COUNT(*)::integer FROM pg_temp.tmp_backup_sale_lines);

  IF v_total_records > 10000 THEN
    RAISE EXCEPTION 'Backup contains % records, exceeding the 10,000-record atomic restore limit.', v_total_records
      USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
  END IF;

  v_preview := pg_catalog.jsonb_build_object(
    'format', v_format,
    'source_shop_name', v_source_shop_name,
    'items_count', v_items_count,
    'active_items_count', v_active_items_count,
    'archived_items_count', v_archived_items_count,
    'sales_count', v_sales_count,
    'customers_count', v_customers_count,
    'expenses_count', v_expenses_count,
    'credit_payments_count', v_payments_count,
    'stock_movements_count', v_movements_count,
    'total_records_count', v_total_records,
    'total_stock_value_ngwee', v_total_stock_value_ngwee,
    'total_owed_ngwee', v_total_owed_ngwee
  );

  -- 9. Dry-run preview returns validated counts & totals with zero writes
  IF COALESCE(p_dry_run, true) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'preview',
      'dry_run', true,
      'idempotent', v_already_imported,
      'already_imported', v_already_imported,
      'shop_has_existing_data', v_shop_has_data,
      'file_sha256', v_effective_sha,
      'preview', v_preview
    );
  END IF;

  -- 10. Idempotent duplicate short-circuit (same operation_id OR same file_sha256)
  IF v_already_imported THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'dry_run', false,
      'idempotent', true,
      'already_imported', true,
      'shop_has_existing_data', v_shop_has_data,
      'file_sha256', v_effective_sha,
      'preview', v_preview
    );
  END IF;

  -- 11. Empty-shop default guard
  IF v_shop_has_data AND NOT COALESCE(p_allow_non_empty_shop, false) THEN
    RAISE EXCEPTION 'This shop already has records. Restore is only allowed into a new or empty shop unless you explicitly choose to merge into an existing shop.'
      USING ERRCODE = '23514', DETAIL = 'SHOP_NOT_EMPTY';
  END IF;

  -- Check ID collisions if merging into a non-empty shop
  IF v_shop_has_data THEN
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

  -- 12. Atomic all-or-nothing inserts
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

  -- 13. Mandatory in-transaction ledger reconciliation (rolls back on any difference!)
  v_recon := public.reconcile_shop_ledger(p_shop_id);
  IF COALESCE((v_recon ->> 'total_differences')::integer, 1) <> 0 THEN
    RAISE EXCEPTION 'Backup restore failed ledger reconciliation (% difference(s)); rolled back.',
      COALESCE(v_recon ->> 'total_differences', '?')
      USING ERRCODE = '23514', DETAIL = 'RECONCILIATION_FAILED';
  END IF;

  -- 14. Idempotency markers (operation_id + file_sha256) & platform_audit entry
  INSERT INTO public.sync_operations (
    shop_id, operation_id, operation_type, outcome, applied_at
  ) VALUES (
    p_shop_id, v_op_id, 'backup_import', 'applied', v_now
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
    v_actor_uid,
    p_shop_id,
    'Backup restored (' || v_format || ')',
    pg_catalog.jsonb_build_object(
      'format', v_format,
      'file_sha256', v_effective_sha,
      'operation_id', v_op_id,
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
    'shop_has_existing_data', v_shop_has_data,
    'file_sha256', v_effective_sha,
    'preview', v_preview,
    'reconciliation', v_recon
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_shop_backup(uuid, text, text, jsonb, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_shop_backup(uuid, text, text, jsonb, boolean, boolean)
  TO authenticated, service_role;
