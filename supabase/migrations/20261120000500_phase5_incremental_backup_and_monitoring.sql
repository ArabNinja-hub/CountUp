-- =============================================================================
-- Phase 5 & Pre-5 Hardening:
--   1. Timeout-Safe Incremental Chunked Backup Restore (NO reliance on
--      function-level `SET statement_timeout`):
--        - Explicitly resets `statement_timeout` on `import_shop_backup` and
--          `finalize_shop_backup_import` so no function assumes it can extend
--          hosted Supabase / PostgREST gateway timeouts.
--        - Moves per-row JSON validation, strict Kwacha-to-ngwee conversion,
--          and per-sale receipt/profit math reconciliation into
--          `append_shop_backup_chunk` (`normalized_records` + `aux_records`),
--          making `finalize_shop_backup_import` a fast C-level
--          `jsonb_populate_recordset` + cross-table set check + cheap final
--          aggregate parity verification.
--   2. Platform Monitoring & Alerts (`public.platform_alerts`):
--        - Expands `platform_alerts.category` to support `'sync_failure'`,
--          `'reconcile_diff'`, and `'client_error'` alongside `'sms_cap'`,
--          `'sms_abuse'`, `'security'`, and `'sync_note'`.
--        - `apply_sync_batch` automatically persists `'sync_failure'` alerts
--          whenever a queued operation fails with an unexpected/poison error.
--        - `reconcile_shop_ledger(NULL)` and `reconcile_subscriptions(NULL)`
--          automatically persist `'reconcile_diff'` critical alerts when any
--          discrepancy is detected (and auto-resolve them when 0 differences
--          remain).
--        - Adds `report_client_sync_alert` (session-bound, rate-limited) and
--          `resolve_platform_alert` (`aal2` platform admin only + audit log).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove function-level `SET statement_timeout` assumptions
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.import_shop_backup(uuid, text, text, jsonb, boolean, boolean)
  RESET statement_timeout;

ALTER FUNCTION public.finalize_shop_backup_import(uuid, uuid, boolean)
  RESET statement_timeout;

-- -----------------------------------------------------------------------------
-- 2. Incremental Per-Chunk Normalization & Sale-Math Verification
-- -----------------------------------------------------------------------------
ALTER TABLE public.backup_import_chunks
  ADD COLUMN IF NOT EXISTS normalized_records jsonb,
  ADD COLUMN IF NOT EXISTS aux_records jsonb;

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
  p_shop_has_data boolean,
  p_sales_math_preverified boolean DEFAULT false
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
  v_expected_sales_total_ngwee bigint;
  v_expected_sales_profit_ngwee bigint;
  v_expected_lines_total_ngwee bigint;
  v_expected_stock_units bigint;
  v_expected_movements_delta bigint;
  v_actual_sales_total_ngwee bigint;
  v_actual_sales_profit_ngwee bigint;
  v_actual_lines_total_ngwee bigint;
  v_actual_owed_ngwee bigint;
  v_actual_stock_units bigint;
  v_actual_movements_delta bigint;
  v_c1 integer := 0;
  v_c2 integer := 0;
  v_c3 integer := 0;
  v_c4 integer := 0;
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

  -- Skip redundant 30k-sale GROUP BY re-join when per-chunk sale math was already verified
  IF NOT COALESCE(p_sales_math_preverified, false) THEN
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
  WITH movement_sums AS (
    SELECT
      m.item_id,
      SUM(m.delta)::bigint AS sum_delta,
      BOOL_OR(m.type = 'initial') AS has_initial
    FROM pg_temp.tmp_backup_movements m
    GROUP BY m.item_id
  )
  SELECT COUNT(*)::integer
    INTO v_c4
    FROM pg_temp.tmp_backup_items i
    LEFT JOIN movement_sums ms ON ms.item_id = i.id
   WHERE COALESCE(ms.sum_delta, 0) <> i.quantity
     AND (
       COALESCE(ms.has_initial, false)
       OR (i.quantity - COALESCE(ms.sum_delta, 0)) < 0
     );

  IF v_c4 > 0 THEN
    RAISE EXCEPTION 'Stock movement history for one or more products does not match their quantity.'
      USING ERRCODE = '23514', DETAIL = 'STOCK_LEDGER_MISMATCH';
  END IF;

  WITH movement_sums AS (
    SELECT m.item_id, SUM(m.delta)::integer AS sum_delta
      FROM pg_temp.tmp_backup_movements m
     GROUP BY m.item_id
  )
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
    (i.quantity - COALESCE(ms.sum_delta, 0))::integer,
    0,
    (i.quantity - COALESCE(ms.sum_delta, 0))::integer,
    'Opening stock from backup restore',
    NULL,
    NULL,
    false,
    i.is_demo,
    i.created_at
  FROM pg_temp.tmp_backup_items i
  LEFT JOIN movement_sums ms ON ms.item_id = i.id
  WHERE COALESCE(ms.sum_delta, 0) <> i.quantity;

  -- 2. Enforce record caps (50,000 primary / 200,000 total rows)
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

  -- Capture expected aggregate sums from pre-reconciled temp tables
  SELECT
    COALESCE((SELECT SUM(total_amount_ngwee) FROM pg_temp.tmp_backup_sales), 0)::bigint,
    COALESCE((SELECT SUM(profit_ngwee) FROM pg_temp.tmp_backup_sales), 0)::bigint,
    COALESCE((SELECT SUM(line_total_ngwee) FROM pg_temp.tmp_backup_sale_lines), 0)::bigint,
    COALESCE((SELECT SUM(quantity::bigint) FROM pg_temp.tmp_backup_items), 0)::bigint,
    COALESCE((SELECT SUM(delta::bigint) FROM pg_temp.tmp_backup_movements), 0)::bigint
  INTO
    v_expected_sales_total_ngwee,
    v_expected_sales_profit_ngwee,
    v_expected_lines_total_ngwee,
    v_expected_stock_units,
    v_expected_movements_delta;

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

  -- Final reconciliation check:
  -- When merging into a non-empty shop, run full `reconcile_shop_ledger(p_shop_id)`.
  -- When restoring into an empty shop (whose per-row math, foreign keys, credit
  -- balances, and stock movements were already reconciled above), run a cheap
  -- O(N) single-pass aggregate parity verification against the committed rows so
  -- large 2-year restores complete safely inside default PostgREST timeouts.
  IF p_shop_has_data THEN
    v_recon := public.reconcile_shop_ledger(p_shop_id);
    IF COALESCE((v_recon ->> 'total_differences')::integer, 1) <> 0 THEN
      RAISE EXCEPTION 'Backup restore failed ledger reconciliation (% difference(s)); rolled back.',
        COALESCE(v_recon ->> 'total_differences', '?')
        USING ERRCODE = '23514', DETAIL = 'RECONCILIATION_FAILED';
    END IF;
  ELSE
    SELECT
      COALESCE((SELECT SUM(total_amount_ngwee) FROM public.sales WHERE shop_id = p_shop_id), 0)::bigint,
      COALESCE((SELECT SUM(profit_ngwee) FROM public.sales WHERE shop_id = p_shop_id), 0)::bigint,
      COALESCE((SELECT SUM(line_total_ngwee) FROM public.sale_lines WHERE shop_id = p_shop_id), 0)::bigint,
      COALESCE((SELECT SUM(total_owed_ngwee) FROM public.customers WHERE shop_id = p_shop_id), 0)::bigint,
      COALESCE((SELECT SUM(quantity::bigint) FROM public.items WHERE shop_id = p_shop_id), 0)::bigint,
      COALESCE((SELECT SUM(delta::bigint) FROM public.stock_movements WHERE shop_id = p_shop_id), 0)::bigint
    INTO
      v_actual_sales_total_ngwee,
      v_actual_sales_profit_ngwee,
      v_actual_lines_total_ngwee,
      v_actual_owed_ngwee,
      v_actual_stock_units,
      v_actual_movements_delta;

    v_c1 := CASE
      WHEN v_actual_sales_total_ngwee <> v_expected_sales_total_ngwee
        OR v_actual_lines_total_ngwee <> v_expected_lines_total_ngwee
        OR v_actual_sales_total_ngwee <> v_actual_lines_total_ngwee
      THEN 1 ELSE 0
    END;
    v_c2 := CASE WHEN v_actual_sales_profit_ngwee <> v_expected_sales_profit_ngwee THEN 1 ELSE 0 END;
    v_c3 := CASE WHEN v_actual_owed_ngwee <> v_total_owed_ngwee THEN 1 ELSE 0 END;
    v_c4 := CASE
      WHEN v_actual_stock_units <> v_expected_stock_units
        OR v_actual_movements_delta <> v_expected_movements_delta
        OR v_actual_stock_units <> v_actual_movements_delta
      THEN 1 ELSE 0
    END;

    IF (v_c1 + v_c2 + v_c3 + v_c4) <> 0 THEN
      RAISE EXCEPTION 'Backup restore failed ledger reconciliation (% difference(s)); rolled back.',
        (v_c1 + v_c2 + v_c3 + v_c4)
        USING ERRCODE = '23514', DETAIL = 'RECONCILIATION_FAILED';
    END IF;

    v_recon := pg_catalog.jsonb_build_object(
      'checked_at', pg_catalog.clock_timestamp(),
      'shops_checked', 1,
      'total_differences', 0,
      'sale_line_mismatch_count', 0,
      'sale_profit_mismatch_count', 0,
      'customer_balance_mismatch_count', 0,
      'stock_movement_mismatch_count', 0,
      'sale_line_mismatches', '[]'::jsonb,
      'sale_profit_mismatches', '[]'::jsonb,
      'customer_balance_mismatches', '[]'::jsonb,
      'stock_movement_mismatches', '[]'::jsonb
    );
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

-- Drop old 10-arg signature so `pg_proc` only has the canonical 11-arg internal helper
DROP FUNCTION IF EXISTS public.commit_populated_backup_temp_tables(
  uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean
);

REVOKE ALL ON FUNCTION public.commit_populated_backup_temp_tables(
  uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_populated_backup_temp_tables(
  uuid, uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean
) TO service_role;

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
  v_normalized jsonb := NULL;
  v_aux jsonb := NULL;
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

  -- Incrementally validate, convert Kwacha -> integer ngwee, and reconcile
  -- receipt/profit math per chunk during upload so `finalize_shop_backup_import`
  -- never parses raw JSON or runs heavy scalar loops.
  IF v_session.format = 'countup-backup-v2' THEN
    PERFORM public.ensure_backup_temp_tables();

    PERFORM public.load_v2_json_arrays_into_temp_tables(
      CASE WHEN p_section = 'items' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'archivedItems' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'customers' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'sales' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'creditPayments' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'expenses' THEN p_records ELSE '[]'::jsonb END,
      CASE WHEN p_section = 'stockMovements' THEN p_records ELSE '[]'::jsonb END
    );

    CASE p_section
      WHEN 'items', 'archivedItems' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_items t;
      WHEN 'customers' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_customers t;
      WHEN 'sales' THEN
        -- Incremental per-chunk sale line & profit math reconciliation
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

        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_sales t;

        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(tl)), '[]'::jsonb)
          INTO v_aux
          FROM pg_temp.tmp_backup_sale_lines tl;
      WHEN 'creditPayments' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_payments t;
      WHEN 'expenses' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_expenses t;
      WHEN 'stockMovements' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
          INTO v_normalized
          FROM pg_temp.tmp_backup_movements t;
    END CASE;
  END IF;

  INSERT INTO public.backup_import_chunks (
    session_id,
    chunk_index,
    section,
    records,
    normalized_records,
    aux_records,
    record_count,
    byte_size
  ) VALUES (
    p_session_id,
    p_chunk_index,
    p_section,
    CASE WHEN v_normalized IS NOT NULL THEN '[]'::jsonb ELSE p_records END,
    v_normalized,
    v_aux,
    v_count,
    v_bytes
  )
  ON CONFLICT (session_id, chunk_index) DO UPDATE
    SET section = EXCLUDED.section,
        records = EXCLUDED.records,
        normalized_records = EXCLUDED.normalized_records,
        aux_records = EXCLUDED.aux_records,
        record_count = EXCLUDED.record_count,
        byte_size = EXCLUDED.byte_size;

  SELECT COALESCE(SUM(c.byte_size), 0)::bigint
    INTO v_total_staged_bytes
    FROM public.backup_import_chunks c
   WHERE c.session_id = p_session_id;

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

CREATE OR REPLACE FUNCTION public.finalize_shop_backup_import(
  p_shop_id uuid,
  p_session_id uuid,
  p_dry_run boolean DEFAULT false
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
  v_actor_uid uuid := auth.uid();
  v_already_imported boolean := false;
  v_shop_has_data boolean := false;
  v_chunk_count integer := 0;
  v_has_unnormalized boolean := false;
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

  SELECT COUNT(*)::integer, COALESCE(BOOL_OR(c.normalized_records IS NULL), false)
    INTO v_chunk_count, v_has_unnormalized
    FROM public.backup_import_chunks c
   WHERE c.session_id = p_session_id;

  IF v_chunk_count <> v_session.expected_chunks THEN
    RAISE EXCEPTION 'Incomplete backup upload: received % of % expected chunks.', v_chunk_count, v_session.expected_chunks
      USING ERRCODE = '22023', DETAIL = 'INCOMPLETE_BACKUP_CHUNKS';
  END IF;

  PERFORM public.ensure_backup_temp_tables();

  IF v_session.format = 'countup-backup-v2' AND NOT v_has_unnormalized THEN
    -- Fast C-level bulk hydration from pre-validated, ngwee-normalized chunks
    BEGIN
      INSERT INTO pg_temp.tmp_backup_items
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_items, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section IN ('items', 'archivedItems')
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate item IDs across active or archived products.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_customers
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_customers, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'customers'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate customer IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_sales
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_sales, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'sales'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate sale IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_sale_lines
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_sale_lines, COALESCE(c.aux_records, '[]'::jsonb)) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'sales'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate sale line IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_payments
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_payments, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'creditPayments'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate creditPayment IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_expenses
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_expenses, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'expenses'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate expense IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    BEGIN
      INSERT INTO pg_temp.tmp_backup_movements
      SELECT r.*
        FROM public.backup_import_chunks c,
             LATERAL pg_catalog.jsonb_populate_recordset(NULL::pg_temp.tmp_backup_movements, c.normalized_records) AS r
       WHERE c.session_id = p_session_id
         AND c.section = 'stockMovements'
       ORDER BY c.chunk_index;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Backup has duplicate stockMovement IDs.'
          USING ERRCODE = '22023', DETAIL = 'DUPLICATE_ID';
    END;

    IF (SELECT COUNT(*) FROM pg_temp.tmp_backup_items) > 5000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_customers) > 5000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_sales) > 30000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_sale_lines) > 80000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_payments) > 25000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_expenses) > 15000
       OR (SELECT COUNT(*) FROM pg_temp.tmp_backup_movements) > 80000
    THEN
      RAISE EXCEPTION 'Backup exceeds the maximum supported collection record count.'
        USING ERRCODE = '22023', DETAIL = 'RECORD_LIMIT_EXCEEDED';
    END IF;

    -- Hash-aggregated customer credit balance computation (`pg_safeupdate` compliant)
    WITH credit_totals AS (
      SELECT s.customer_id, SUM(s.total_amount_ngwee) AS credit_ngwee
        FROM pg_temp.tmp_backup_sales s
       WHERE s.payment_type = 'credit'
         AND NOT s.is_deleted
         AND s.customer_id IS NOT NULL
       GROUP BY s.customer_id
    ),
    repayment_totals AS (
      SELECT cp.customer_id, SUM(cp.amount_ngwee) AS repaid_ngwee
        FROM pg_temp.tmp_backup_payments cp
       GROUP BY cp.customer_id
    )
    UPDATE pg_temp.tmp_backup_customers c
       SET computed_owed_ngwee =
         COALESCE(agg.credit_ngwee, 0) - COALESCE(agg.repaid_ngwee, 0)
      FROM (
        SELECT c2.id, ct.credit_ngwee, rt.repaid_ngwee
          FROM pg_temp.tmp_backup_customers c2
          LEFT JOIN credit_totals ct ON ct.customer_id = c2.id
          LEFT JOIN repayment_totals rt ON rt.customer_id = c2.id
      ) agg
     WHERE c.id = agg.id;

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
      v_shop_has_data,
      true
    );
  ELSE
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
      v_shop_has_data,
      false
    );
  END IF;

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

-- -----------------------------------------------------------------------------
-- 3. Platform Monitoring & Alerts (`sync_failure`, `reconcile_diff`, `client_error`)
-- -----------------------------------------------------------------------------
ALTER TABLE public.platform_alerts
  DROP CONSTRAINT IF EXISTS platform_alerts_category_check;

ALTER TABLE public.platform_alerts
  ADD CONSTRAINT platform_alerts_category_check
    CHECK (
      category IN (
        'sms_cap',
        'sms_abuse',
        'security',
        'sync_note',
        'sync_failure',
        'reconcile_diff',
        'client_error'
      )
    );

-- 3.1 `apply_sync_batch`: automatically records a `sync_failure` alert in
--     `public.platform_alerts` when a batch operation fails unexpectedly
--     (excluding routine user-reviewable business states).
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
  v_alert_key text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF p_operations IS NULL OR pg_catalog.jsonb_typeof(p_operations) <> 'array' THEN
    RAISE EXCEPTION 'Sync batch operations must be a JSON array.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_BATCH_PAYLOAD';
  END IF;

  IF pg_catalog.jsonb_array_length(p_operations) > 250 THEN
    RAISE EXCEPTION 'Sync batch exceeds maximum size of 250 operations per call.'
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

        -- Surface unexpected/poison sync batch failures to the Admin Screen
        IF COALESCE(v_detail, '') NOT IN (
          'OVERPAYMENT_CONFLICT',
          'CREDIT_VOID_CONFLICT',
          'STOCK_COUNT_CONFLICT',
          'PLAN_EXPIRED',
          'SHOP_SUSPENDED'
        ) THEN
          v_alert_key := pg_catalog.left(
            'sync_fail:' || p_shop_id::text || ':' || COALESCE(NULLIF(pg_catalog.btrim(v_op_id), ''), COALESCE(NULLIF(v_rpc, ''), 'op')),
            120
          );

          INSERT INTO public.platform_alerts (
            alert_key,
            severity,
            category,
            title,
            detail,
            metadata,
            resolved_at,
            resolved_by_user_id
          ) VALUES (
            v_alert_key,
            'warning',
            'sync_failure',
            pg_catalog.left('Failed sync batch (' || COALESCE(NULLIF(v_rpc, ''), 'unknown') || ')', 160),
            pg_catalog.left(
              'Shop "' || v_shop.name || '" (' || p_shop_id::text || ') failed on '
              || COALESCE(NULLIF(v_op_id, ''), '(missing id)') || ': '
              || COALESCE(NULLIF(v_detail, ''), v_sqlstate) || ' — ' || v_msg,
              500
            ),
            pg_catalog.jsonb_build_object(
              'shop_id', p_shop_id,
              'shop_name', v_shop.name,
              'operation_id', v_op_id,
              'rpc', v_rpc,
              'error_code', v_sqlstate,
              'error_detail', COALESCE(v_detail, '')
            ),
            NULL,
            NULL
          )
          ON CONFLICT (alert_key) DO UPDATE
            SET severity = EXCLUDED.severity,
                title = EXCLUDED.title,
                detail = EXCLUDED.detail,
                metadata = EXCLUDED.metadata,
                resolved_at = NULL,
                resolved_by_user_id = NULL;
        END IF;

        v_results := v_results || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'operation_id', v_op_id,
            'ok', false,
            'error_code', v_sqlstate,
            'error_detail', COALESCE(v_detail, ''),
            'error_message', v_msg
          )
        );
        EXIT;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_sync_batch(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_sync_batch(uuid, jsonb) TO authenticated, service_role;

-- 3.2 `reconcile_shop_ledger`: persists/auto-resolves `reconcile_diff:ledger`
--     alert when invoked across all shops (`p_shop_id IS NULL`).
CREATE OR REPLACE FUNCTION public.reconcile_shop_ledger(
  p_shop_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
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
  v_total_diffs integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
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

  v_total_diffs := v_c1 + v_c2 + v_c3 + v_c4;

  IF p_shop_id IS NULL THEN
    IF v_total_diffs > 0 THEN
      INSERT INTO public.platform_alerts (
        alert_key,
        severity,
        category,
        title,
        detail,
        metadata,
        resolved_at,
        resolved_by_user_id
      ) VALUES (
        'reconcile_diff:ledger',
        'critical',
        'reconcile_diff',
        'Ledger reconciliation discrepancy detected',
        pg_catalog.left(
          v_total_diffs::text || ' ledger difference(s) across ' || v_shops_checked::text
          || ' shop(s): sale lines=' || v_c1::text
          || ', profit=' || v_c2::text
          || ', credit=' || v_c3::text
          || ', stock=' || v_c4::text || '.',
          500
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'ledger',
          'shops_checked', v_shops_checked,
          'total_differences', v_total_diffs,
          'sale_line_mismatch_count', v_c1,
          'sale_profit_mismatch_count', v_c2,
          'customer_balance_mismatch_count', v_c3,
          'stock_movement_mismatch_count', v_c4
        ),
        NULL,
        NULL
      )
      ON CONFLICT (alert_key) DO UPDATE
        SET severity = 'critical',
            title = EXCLUDED.title,
            detail = EXCLUDED.detail,
            metadata = EXCLUDED.metadata,
            resolved_at = NULL,
            resolved_by_user_id = NULL;
    ELSE
      UPDATE public.platform_alerts
         SET resolved_at = v_now,
             resolved_by_user_id = auth.uid()
       WHERE alert_key = 'reconcile_diff:ledger'
         AND resolved_at IS NULL;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'checked_at', v_now,
    'shops_checked', v_shops_checked,
    'total_differences', v_total_diffs,
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

REVOKE ALL ON FUNCTION public.reconcile_shop_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_shop_ledger(uuid) TO authenticated, service_role;

-- 3.3 `reconcile_subscriptions`: persists/auto-resolves `reconcile_diff:subscriptions`
--     alert when invoked across all shops (`p_shop_id IS NULL`).
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
  v_total_diffs integer := 0;
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

  v_total_diffs := v_expiry_mismatches + v_amount_mismatches + v_lock_mismatches + v_pointer_mismatches;

  IF p_shop_id IS NULL THEN
    IF v_total_diffs > 0 THEN
      INSERT INTO public.platform_alerts (
        alert_key,
        severity,
        category,
        title,
        detail,
        metadata,
        resolved_at,
        resolved_by_user_id
      ) VALUES (
        'reconcile_diff:subscriptions',
        'critical',
        'reconcile_diff',
        'Subscription reconciliation discrepancy detected',
        pg_catalog.left(
          v_total_diffs::text || ' subscription difference(s) across ' || v_shops_checked::text
          || ' shop(s): expiry=' || v_expiry_mismatches::text
          || ', prices=' || v_amount_mismatches::text
          || ', locks=' || v_lock_mismatches::text
          || ', pointers=' || v_pointer_mismatches::text || '.',
          500
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'subscriptions',
          'shops_checked', v_shops_checked,
          'total_differences', v_total_diffs,
          'expiry_mismatch_count', v_expiry_mismatches,
          'payment_amount_mismatch_count', v_amount_mismatches,
          'reference_lock_mismatch_count', v_lock_mismatches,
          'shop_pointer_mismatch_count', v_pointer_mismatches
        ),
        NULL,
        NULL
      )
      ON CONFLICT (alert_key) DO UPDATE
        SET severity = 'critical',
            title = EXCLUDED.title,
            detail = EXCLUDED.detail,
            metadata = EXCLUDED.metadata,
            resolved_at = NULL,
            resolved_by_user_id = NULL;
    ELSE
      UPDATE public.platform_alerts
         SET resolved_at = v_now,
             resolved_by_user_id = auth.uid()
       WHERE alert_key = 'reconcile_diff:subscriptions'
         AND resolved_at IS NULL;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'checked_at', v_now,
    'shops_checked', v_shops_checked,
    'total_differences', v_total_diffs,
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

-- 3.4 `report_client_sync_alert`: session-bound, rate-limited telemetry RPC so
--     single-operation sync failures or unexpected client runtime errors can
--     surface cleanly in the Admin Screen without exposing write access on
--     `public.platform_alerts`.
CREATE OR REPLACE FUNCTION public.report_client_sync_alert(
  p_shop_id uuid,
  p_category text,
  p_key_suffix text,
  p_title text,
  p_detail text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop public.shops;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_cat text := pg_catalog.btrim(COALESCE(p_category, ''));
  v_suffix text := pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_key_suffix, 'err')), '[^A-Za-z0-9_.:-]', '_', 'g');
  v_clean_title text := pg_catalog.left(pg_catalog.btrim(COALESCE(p_title, '')), 160);
  v_clean_detail text := pg_catalog.left(pg_catalog.btrim(COALESCE(p_detail, '')), 500);
  v_recent_count integer := 0;
  v_alert_key text;
BEGIN
  v_shop := public.lock_authorized_shop_for_write(p_shop_id);

  IF v_cat NOT IN ('sync_failure', 'client_error') THEN
    RAISE EXCEPTION 'Unsupported client alert category "%".', v_cat
      USING ERRCODE = '22023', DETAIL = 'INVALID_ALERT_CATEGORY';
  END IF;

  IF pg_catalog.char_length(v_clean_title) < 3 OR pg_catalog.char_length(v_clean_detail) < 3 THEN
    RAISE EXCEPTION 'Alert title and detail must be at least 3 characters.'
      USING ERRCODE = '22023', DETAIL = 'INVALID_ALERT_TEXT';
  END IF;

  SELECT COUNT(*)::integer
    INTO v_recent_count
    FROM public.platform_alerts pa
   WHERE pa.category IN ('sync_failure', 'client_error')
     AND (pa.metadata ->> 'shop_id') = p_shop_id::text
     AND pa.updated_at >= v_now - interval '1 hour';

  IF v_recent_count >= 15 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rate_limited',
      'recorded', false
    );
  END IF;

  v_alert_key := pg_catalog.left(
    v_cat || ':' || p_shop_id::text || ':' || COALESCE(NULLIF(v_suffix, ''), 'event'),
    120
  );

  INSERT INTO public.platform_alerts (
    alert_key,
    severity,
    category,
    title,
    detail,
    metadata,
    resolved_at,
    resolved_by_user_id
  ) VALUES (
    v_alert_key,
    'warning',
    v_cat,
    v_clean_title,
    v_clean_detail,
    COALESCE(p_metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'shop_id', p_shop_id,
      'shop_name', v_shop.name
    ),
    NULL,
    NULL
  )
  ON CONFLICT (alert_key) DO UPDATE
    SET title = EXCLUDED.title,
        detail = EXCLUDED.detail,
        metadata = EXCLUDED.metadata,
        resolved_at = NULL,
        resolved_by_user_id = NULL;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'recorded', true,
    'alert_key', v_alert_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_client_sync_alert(uuid, text, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_client_sync_alert(uuid, text, text, text, text, jsonb)
  TO authenticated, service_role;

-- 3.5 `resolve_platform_alert`: `aal2` platform admin marks an alert resolved.
CREATE OR REPLACE FUNCTION public.resolve_platform_alert(
  p_alert_id uuid
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
  v_alert public.platform_alerts;
BEGIN
  IF v_jwt_role <> 'service_role' AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator MFA (aal2) access is required to resolve alerts.'
      USING ERRCODE = '42501', DETAIL = 'ADMIN_MFA_REQUIRED';
  END IF;

  UPDATE public.platform_alerts
     SET resolved_at = v_now,
         resolved_by_user_id = auth.uid()
   WHERE id = p_alert_id
     AND resolved_at IS NULL
  RETURNING * INTO v_alert;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_resolved_or_missing',
      'alert_id', p_alert_id
    );
  END IF;

  IF auth.uid() IS NOT NULL THEN
    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      shop_id,
      reason,
      metadata,
      created_at
    ) VALUES (
      'platform_alert_resolved',
      auth.uid(),
      CASE
        WHEN (v_alert.metadata ? 'shop_id')
             AND (v_alert.metadata ->> 'shop_id') ~ '^[0-9a-fA-F-]{36}$'
             AND EXISTS (
               SELECT 1 FROM public.shops s
                WHERE s.id = (v_alert.metadata ->> 'shop_id')::uuid
             )
          THEN (v_alert.metadata ->> 'shop_id')::uuid
        ELSE NULL
      END,
      'Resolved alert ' || v_alert.alert_key,
      pg_catalog.jsonb_build_object(
        'alert_id', v_alert.id,
        'alert_key', v_alert.alert_key,
        'category', v_alert.category,
        'severity', v_alert.severity
      ),
      v_now
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved',
    'alert_id', v_alert.id,
    'alert_key', v_alert.alert_key,
    'resolved_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_platform_alert(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_platform_alert(uuid)
  TO authenticated, service_role;
