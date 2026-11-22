-- =============================================================================
-- CountUp Zambia — Phase 2 Follow-Ups:
--   * Require MFA (TOTP, aal2) for platform_admin authority
--   * Store used_trial_phones as salted/peppered hash (zero raw phone numbers)
--   * Per-phone, per-IP & fail-safe global daily SMS cap + platform_alerts
--   * Escalating per-shop recovery-code lockout + 72-hour admin-approved PIN
--     reset with device notice, owner SMS tracking & owner cancellation RPC
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Require MFA (TOTP, aal = 'aal2') for any platform_admin session
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    CASE
      WHEN pg_catalog.jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'platform_admin') = 'boolean'
        AND (auth.jwt() ->> 'aal') = 'aal2'
        THEN (auth.jwt() -> 'app_metadata' -> 'platform_admin')::boolean
      ELSE false
    END,
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.is_platform_admin() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO service_role;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Replace raw phone number in used_trial_phones with salted+peppered hash
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.used_trial_phones CASCADE;

CREATE TABLE public.used_trial_phones (
  phone_hash text PRIMARY KEY CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  first_shop_id uuid NOT NULL,
  first_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trial_used_at timestamptz NOT NULL DEFAULT now(),
  was_suspended boolean NOT NULL DEFAULT false,
  last_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_used_trial_phones_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.used_trial_phones
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.used_trial_phones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.used_trial_phones FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 3. Escalating per-shop recovery-code lockout counters on shop_pin_credentials
-- -----------------------------------------------------------------------------
ALTER TABLE public.shop_pin_credentials
  ADD COLUMN recovery_failed_attempts integer NOT NULL DEFAULT 0 CHECK (
    recovery_failed_attempts >= 0
  ),
  ADD COLUMN recovery_locked_until timestamptz,
  ADD COLUMN recovery_last_failed_at timestamptz;

-- -----------------------------------------------------------------------------
-- 4. SMS Abuse Rate-Limit Ledger & Fail-Safe Global Daily Cap + Platform Alerts
-- -----------------------------------------------------------------------------
CREATE TABLE public.sms_rate_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('otp', 'pin_reset_notice')),
  blocked boolean NOT NULL DEFAULT false,
  block_reason text CHECK (block_reason IS NULL OR char_length(block_reason) <= 120),
  day_utc date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sms_rate_events_phone_created
  ON public.sms_rate_events (phone_hash, created_at DESC);
CREATE INDEX idx_sms_rate_events_ip_created
  ON public.sms_rate_events (ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;
CREATE INDEX idx_sms_rate_events_daily_sent
  ON public.sms_rate_events (day_utc)
  WHERE blocked = false;

CREATE TRIGGER trg_sms_rate_events_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.sms_rate_events
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sms_rate_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sms_rate_events FROM PUBLIC;

CREATE TABLE public.platform_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL UNIQUE CHECK (char_length(pg_catalog.btrim(alert_key)) BETWEEN 3 AND 120),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  category text NOT NULL CHECK (category IN ('sms_cap', 'sms_abuse', 'security')),
  title text NOT NULL CHECK (char_length(pg_catalog.btrim(title)) BETWEEN 3 AND 160),
  detail text NOT NULL CHECK (char_length(pg_catalog.btrim(detail)) BETWEEN 3 AND 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_alerts_unresolved
  ON public.platform_alerts (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE TRIGGER trg_platform_alerts_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.platform_alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.platform_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_alerts FROM PUBLIC;

CREATE POLICY platform_alerts_select_admin
  ON public.platform_alerts
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 5. Admin-Approved 72-Hour PIN Reset Requests + Owner Cancellation RPC
-- -----------------------------------------------------------------------------
CREATE TABLE public.shop_pin_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  initiated_by_admin_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  identity_check_note text NOT NULL CHECK (
    char_length(pg_catalog.btrim(identity_check_note)) BETWEEN 10 AND 500
  ),
  status text NOT NULL DEFAULT 'pending_wait' CHECK (
    status IN ('pending_wait', 'completed', 'cancelled')
  ),
  initiated_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  sms_notified_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_reason text CHECK (
    cancelled_by_reason IS NULL OR char_length(cancelled_by_reason) <= 300
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_pin_reset_requests_72h_window
    CHECK (available_at >= initiated_at + interval '72 hours' AND expires_at > available_at)
);

CREATE INDEX idx_shop_pin_reset_requests_shop_id
  ON public.shop_pin_reset_requests (shop_id);

CREATE UNIQUE INDEX idx_shop_pin_reset_requests_active_shop
  ON public.shop_pin_reset_requests (shop_id)
  WHERE status = 'pending_wait';

CREATE TRIGGER trg_shop_pin_reset_requests_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.shop_pin_reset_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.shop_pin_reset_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shop_pin_reset_requests FROM PUBLIC;

CREATE POLICY shop_pin_reset_requests_select
  ON public.shop_pin_reset_requests
  FOR SELECT
  TO authenticated
  USING (shop_id = public.request_shop_id() OR public.is_platform_admin());

-- Owner on an already-verified shop device can cancel an unauthorized 72h PIN reset immediately.
CREATE OR REPLACE FUNCTION public.cancel_pending_shop_pin_reset()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_shop_id uuid;
  v_cancelled_id uuid;
BEGIN
  v_uid := auth.uid();
  v_shop_id := public.request_shop_id();
  IF v_uid IS NULL OR v_shop_id IS NULL THEN
    RAISE EXCEPTION 'Sign in and unlock your shop first.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.shop_pin_reset_requests
     SET status = 'cancelled',
         cancelled_at = pg_catalog.clock_timestamp(),
         cancelled_by_reason = 'Cancelled by owner from verified shop device'
   WHERE shop_id = v_shop_id
     AND status = 'pending_wait'
  RETURNING id INTO v_cancelled_id;

  IF v_cancelled_id IS NOT NULL THEN
    UPDATE public.shops
       SET security_notice = NULL,
           security_notice_at = NULL
     WHERE id = v_shop_id
       AND owner_user_id = v_uid;

    INSERT INTO public.platform_audit (
      action,
      actor_user_id,
      shop_id,
      reason,
      metadata
    ) VALUES (
      'shop_pin_reset_cancelled_by_owner',
      v_uid,
      v_shop_id,
      'Cancelled by owner from verified shop device',
      pg_catalog.jsonb_build_object('reset_request_id', v_cancelled_id)
    );

    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_pending_shop_pin_reset() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 6. Strict Role Privileges on New Tables, Sequences & Functions
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.used_trial_phones FROM anon;
    REVOKE ALL ON TABLE public.sms_rate_events FROM anon;
    REVOKE ALL ON TABLE public.platform_alerts FROM anon;
    REVOKE ALL ON TABLE public.shop_pin_reset_requests FROM anon;
    REVOKE ALL ON FUNCTION public.cancel_pending_shop_pin_reset() FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.used_trial_phones FROM authenticated;
    REVOKE ALL ON TABLE public.sms_rate_events FROM authenticated;
    REVOKE ALL ON TABLE public.platform_alerts FROM authenticated;
    REVOKE ALL ON TABLE public.shop_pin_reset_requests FROM authenticated;

    GRANT SELECT ON TABLE public.platform_alerts TO authenticated;
    GRANT SELECT ON TABLE public.shop_pin_reset_requests TO authenticated;
    GRANT EXECUTE ON FUNCTION public.cancel_pending_shop_pin_reset() TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.used_trial_phones TO service_role;
    GRANT ALL ON TABLE public.sms_rate_events TO service_role;
    GRANT ALL ON SEQUENCE public.sms_rate_events_id_seq TO service_role;
    GRANT ALL ON TABLE public.platform_alerts TO service_role;
    GRANT ALL ON TABLE public.shop_pin_reset_requests TO service_role;
    GRANT EXECUTE ON FUNCTION public.cancel_pending_shop_pin_reset() TO service_role;
  END IF;
END;
$$;
