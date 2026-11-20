-- =============================================================================
-- CountUp Zambia — Phase 2: SIM-Swap Protection, Server PIN Hashes, One-Time
-- Recovery Codes, Session Verification & Security Notice Sync
-- =============================================================================

-- 1b. Retain phone trial / suspension history and immutable audit rows even if an auth.users record is deleted.
ALTER TABLE public.used_trial_phones
  ALTER COLUMN first_user_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS used_trial_phones_first_user_id_fkey,
  ADD CONSTRAINT used_trial_phones_first_user_id_fkey
    FOREIGN KEY (first_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.platform_audit
  ALTER COLUMN actor_user_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS platform_audit_actor_user_id_fkey,
  ADD CONSTRAINT platform_audit_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Add security notification fields on shops (notifies existing device when
--    platform support resets PIN lockout after an identity check).
ALTER TABLE public.shops
  ADD COLUMN security_notice text CHECK (
    security_notice IS NULL OR char_length(security_notice) <= 500
  ),
  ADD COLUMN security_notice_at timestamptz;

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

-- Authenticated owner RPC to dismiss a security notice after reading it.
CREATE OR REPLACE FUNCTION public.acknowledge_shop_security_notice()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_shop_id uuid;
BEGIN
  v_uid := auth.uid();
  v_shop_id := public.request_shop_id();
  IF v_uid IS NULL OR v_shop_id IS NULL THEN
    RAISE EXCEPTION 'Sign in and unlock your shop first.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.shops
     SET security_notice = NULL,
         security_notice_at = NULL
   WHERE id = v_shop_id
     AND owner_user_id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_shop_security_notice() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.acknowledge_shop_security_notice() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.acknowledge_shop_security_notice() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.acknowledge_shop_security_notice() TO service_role;
  END IF;
END;
$$;

-- 2. Server-only PBKDF2 + pepper PIN & one-time recovery hashes + per-shop lockout
CREATE TABLE public.shop_pin_credentials (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  pin_salt text NOT NULL CHECK (char_length(pin_salt) BETWEEN 16 AND 128),
  pin_hash text NOT NULL CHECK (char_length(pin_hash) BETWEEN 32 AND 256),
  pin_iterations integer NOT NULL DEFAULT 120000 CHECK (pin_iterations >= 100000),
  recovery_salt text NOT NULL CHECK (char_length(recovery_salt) BETWEEN 16 AND 128),
  recovery_hash text NOT NULL CHECK (char_length(recovery_hash) BETWEEN 32 AND 256),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_shop_pin_credentials_shop_id ON public.shop_pin_credentials (shop_id);

CREATE TRIGGER trg_shop_pin_credentials_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.shop_pin_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.shop_pin_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shop_pin_credentials FROM PUBLIC;

-- 3. Server-only verified sessions (gates app_metadata.shop_id for SIM-swap defense)
CREATE TABLE public.shop_verified_sessions (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (char_length(pg_catalog.btrim(session_id)) BETWEEN 1 AND 128),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, session_id)
);

CREATE INDEX idx_shop_verified_sessions_shop_id ON public.shop_verified_sessions (shop_id);
CREATE INDEX idx_shop_verified_sessions_user_id ON public.shop_verified_sessions (user_id);

CREATE TRIGGER trg_shop_verified_sessions_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.shop_verified_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.shop_verified_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shop_verified_sessions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.shop_pin_credentials FROM anon;
    REVOKE ALL ON TABLE public.shop_verified_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.shop_pin_credentials FROM authenticated;
    REVOKE ALL ON TABLE public.shop_verified_sessions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.shop_pin_credentials TO service_role;
    GRANT ALL ON TABLE public.shop_verified_sessions TO service_role;
  END IF;
END;
$$;

-- 4. Tighten shops SELECT policy so an unverified new-device SMS OTP session
--    cannot read shop details before passing server PIN / recovery verification.
DROP POLICY shops_select_own_or_admin ON public.shops;

CREATE POLICY shops_select_own_or_admin
  ON public.shops
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR (
      owner_user_id = (SELECT auth.uid())
      AND id = (SELECT public.request_shop_id())
    )
  );

-- 5. Update Custom Access Token Hook:
--    When a shop has server PIN credentials, app_metadata.shop_id is granted
--    ONLY after the current GoTrue session_id has verified the PIN or one-time
--    recovery code (stored in public.shop_verified_sessions).
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
  sid text;
  owned_shop_id uuid;
  has_pin_guard boolean;
  session_verified boolean;
BEGIN
  uid := (event ->> 'user_id')::uuid;
  claims := COALESCE(event -> 'claims', '{}'::jsonb);
  app_meta := COALESCE(claims -> 'app_metadata', '{}'::jsonb);
  sid := NULLIF(pg_catalog.btrim(COALESCE(claims ->> 'session_id', '')), '');

  SELECT s.id
    INTO owned_shop_id
    FROM public.shops s
   WHERE s.owner_user_id = uid
   LIMIT 1;

  IF owned_shop_id IS NULL THEN
    app_meta := (app_meta - 'shop_id') - 'pending_pin_verification';
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM public.shop_pin_credentials pc
       WHERE pc.shop_id = owned_shop_id
    ) INTO has_pin_guard;

    IF NOT has_pin_guard THEN
      app_meta := pg_catalog.jsonb_set(
        app_meta - 'pending_pin_verification',
        '{shop_id}',
        pg_catalog.to_jsonb(owned_shop_id::text),
        true
      );
    ELSE
      SELECT (
        sid IS NOT NULL AND EXISTS (
          SELECT 1
            FROM public.shop_verified_sessions vs
           WHERE vs.shop_id = owned_shop_id
             AND vs.user_id = uid
             AND vs.session_id = sid
        )
      ) INTO session_verified;

      IF session_verified THEN
        app_meta := pg_catalog.jsonb_set(
          app_meta - 'pending_pin_verification',
          '{shop_id}',
          pg_catalog.to_jsonb(owned_shop_id::text),
          true
        );
      ELSE
        app_meta := pg_catalog.jsonb_set(
          app_meta - 'shop_id',
          '{pending_pin_verification}',
          'true'::jsonb,
          true
        );
      END IF;
    END IF;
  END IF;

  claims := pg_catalog.jsonb_set(claims, '{app_metadata}', app_meta, true);
  RETURN pg_catalog.jsonb_set(event, '{claims}', claims, true);
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon;
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
