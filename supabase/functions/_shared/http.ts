import { createClient, SupabaseClient, User } from 'npm:@supabase/supabase-js@2';
import {
  DomainPinCredentials,
  DomainPinResetRequest,
  DomainShopRecord,
  DomainUsedTrialPhone,
  EdgeAuthRepository,
  EdgeDomainError,
} from '../../../shared/edgeAuthDomain.ts';

/**
 * Strict CORS policy: only explicit origins listed in ALLOWED_ORIGIN (comma-separated,
 * e.g. "https://countup.pages.dev,http://localhost:3000") are permitted.
 * Never returns Access-Control-Allow-Origin: *.
 */
export function resolveCorsHeaders(req: Request): {
  allowed: boolean;
  headers: Record<string, string>;
} {
  const configured = (Deno.env.get('ALLOWED_ORIGIN') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const origin = req.headers.get('origin');
  const baseHeaders: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (!origin) {
    return { allowed: true, headers: baseHeaders };
  }
  if (configured.includes(origin)) {
    return {
      allowed: true,
      headers: {
        ...baseHeaders,
        'Access-Control-Allow-Origin': origin,
      },
    };
  }
  return { allowed: false, headers: baseHeaders };
}

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export function handlePreflightOrRejectOrigin(req: Request): {
  earlyResponse?: Response;
  headers: Record<string, string>;
} {
  const cors = resolveCorsHeaders(req);
  if (!cors.allowed) {
    return {
      headers: cors.headers,
      earlyResponse: jsonResponse(
        403,
        { error: 'Origin is not permitted.', code: 'forbidden_origin' },
        cors.headers
      ),
    };
  }
  if (req.method === 'OPTIONS') {
    return {
      headers: cors.headers,
      earlyResponse: new Response(null, { status: 204, headers: cors.headers }),
    };
  }
  if (req.method !== 'POST') {
    return {
      headers: cors.headers,
      earlyResponse: jsonResponse(
        405,
        { error: 'Method not allowed.', code: 'method_not_allowed' },
        cors.headers
      ),
    };
  }
  return { headers: cors.headers };
}

export async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new EdgeDomainError(400, 'invalid_json', 'Request body must be a JSON object.');
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof EdgeDomainError) throw err;
    throw new EdgeDomainError(400, 'invalid_json', 'Malformed JSON request body.');
  }
}

export function extractClientIp(req: Request): string | null {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  return realIp || null;
}

export function decodeVerifiedJwtClaims(bearerToken: string): Record<string, unknown> {
  const parts = bearerToken.split('.');
  if (parts.length !== 3) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createServiceRoleClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    throw new EdgeDomainError(
      500,
      'server_misconfigured',
      'Supabase server runtime not configured.'
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthenticatedContext {
  adminClient: SupabaseClient;
  user: User;
  sessionId: string;
  aal: 'aal1' | 'aal2';
  hasAdminClaim: boolean;
  isPlatformAdmin: boolean;
}

/**
 * Validates the caller's JWT via GoTrue and returns a server-only service_role
 * Supabase client. `isPlatformAdmin` is true ONLY when BOTH `app_metadata.platform_admin`
 * is true AND `aal === 'aal2'` (TOTP MFA verified).
 */
export async function requireAuthenticatedCaller(req: Request): Promise<AuthenticatedContext> {
  const adminClient = createServiceRoleClient();

  const authHeader = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    throw new EdgeDomainError(401, 'unauthenticated', 'Sign in first.');
  }
  const token = match[1].trim();

  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user) {
    throw new EdgeDomainError(401, 'unauthenticated', 'Your session expired. Sign in again.');
  }

  const claims = decodeVerifiedJwtClaims(token);
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : '';
  const aal: 'aal1' | 'aal2' = claims.aal === 'aal2' ? 'aal2' : 'aal1';
  const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  const claimAppMeta =
    typeof claims.app_metadata === 'object' && claims.app_metadata !== null
      ? (claims.app_metadata as Record<string, unknown>)
      : {};
  const hasAdminClaim = appMeta.platform_admin === true || claimAppMeta.platform_admin === true;

  return {
    adminClient,
    user: data.user,
    sessionId,
    aal,
    hasAdminClaim,
    isPlatformAdmin: hasAdminClaim && aal === 'aal2',
  };
}

export function createSupabaseEdgeAuthRepository(admin: SupabaseClient): EdgeAuthRepository {
  return {
    async findShopByOwnerUserId(userId) {
      const { data, error } = await admin
        .from('shops')
        .select('*')
        .eq('owner_user_id', userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainShopRecord | null) ?? null;
    },

    async findShopByPhone(ownerPhone) {
      const { data, error } = await admin
        .from('shops')
        .select('*')
        .eq('owner_phone', ownerPhone)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainShopRecord | null) ?? null;
    },

    async findShopById(shopId) {
      const { data, error } = await admin.from('shops').select('*').eq('id', shopId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainShopRecord | null) ?? null;
    },

    async findUsedTrialPhone(phoneHash) {
      const { data, error } = await admin
        .from('used_trial_phones')
        .select('*')
        .eq('phone_hash', phoneHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainUsedTrialPhone | null) ?? null;
    },

    async createShopRegistration({ shop, credentials, sessionId, trialPhoneHash }) {
      if (trialPhoneHash) {
        const { error: trialErr } = await admin.from('used_trial_phones').insert({
          phone_hash: trialPhoneHash,
          first_shop_id: shop.id,
          first_user_id: shop.owner_user_id,
          was_suspended: false,
        });
        if (trialErr) throw new Error(trialErr.message);
      }

      const { data: createdShop, error: shopErr } = await admin
        .from('shops')
        .insert(shop)
        .select('*')
        .single();
      if (shopErr || !createdShop) {
        throw new Error(shopErr?.message ?? 'Failed to create shop.');
      }

      const { error: credErr } = await admin.from('shop_pin_credentials').insert(credentials);
      if (credErr) {
        await admin.from('shops').delete().eq('id', shop.id);
        throw new Error(credErr.message);
      }

      const { error: sessErr } = await admin.from('shop_verified_sessions').upsert({
        shop_id: shop.id,
        session_id: sessionId,
        user_id: shop.owner_user_id,
        verified_at: new Date().toISOString(),
      });
      if (sessErr) {
        await admin.from('shops').delete().eq('id', shop.id);
        throw new Error(sessErr.message);
      }

      return createdShop as DomainShopRecord;
    },

    async getPinCredentials(shopId) {
      const { data, error } = await admin
        .from('shop_pin_credentials')
        .select('*')
        .eq('shop_id', shopId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainPinCredentials | null) ?? null;
    },

    async updatePinAttemptState({ shopId, failedAttempts, lockedUntil, lastFailedAt }) {
      const { error } = await admin
        .from('shop_pin_credentials')
        .update({
          failed_attempts: failedAttempts,
          locked_until: lockedUntil,
          last_failed_at: lastFailedAt,
        })
        .eq('shop_id', shopId);
      if (error) throw new Error(error.message);
    },

    async updateRecoveryAttemptState({
      shopId,
      recoveryFailedAttempts,
      recoveryLockedUntil,
      recoveryLastFailedAt,
    }) {
      const { error } = await admin
        .from('shop_pin_credentials')
        .update({
          recovery_failed_attempts: recoveryFailedAttempts,
          recovery_locked_until: recoveryLockedUntil,
          recovery_last_failed_at: recoveryLastFailedAt,
        })
        .eq('shop_id', shopId);
      if (error) throw new Error(error.message);
    },

    async updatePinAndRecoveryCredentials({
      shopId,
      pinSalt,
      pinHash,
      pinIterations,
      recoverySalt,
      recoveryHash,
    }) {
      const patch: Record<string, unknown> = {
        pin_salt: pinSalt,
        pin_hash: pinHash,
        pin_iterations: pinIterations,
        failed_attempts: 0,
        locked_until: null,
        last_failed_at: null,
        recovery_failed_attempts: 0,
        recovery_locked_until: null,
        recovery_last_failed_at: null,
      };
      if (recoverySalt && recoveryHash) {
        patch.recovery_salt = recoverySalt;
        patch.recovery_hash = recoveryHash;
      }
      const { error } = await admin
        .from('shop_pin_credentials')
        .update(patch)
        .eq('shop_id', shopId);
      if (error) throw new Error(error.message);
    },

    async setShopSecurityNotice({ shopId, securityNotice, nowIso }) {
      const { error } = await admin
        .from('shops')
        .update({
          security_notice: securityNotice,
          security_notice_at: nowIso,
        })
        .eq('id', shopId);
      if (error) throw new Error(error.message);
    },

    async markSessionVerified({ shopId, userId, sessionId }) {
      const { error } = await admin.from('shop_verified_sessions').upsert({
        shop_id: shopId,
        session_id: sessionId,
        user_id: userId,
        verified_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    },

    async isSessionVerified({ shopId, userId, sessionId }) {
      const { data, error } = await admin
        .from('shop_verified_sessions')
        .select('session_id')
        .eq('shop_id', shopId)
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },

    async revokeOtherVerifiedSessions({ shopId, keepSessionId }) {
      const { data, error } = await admin
        .from('shop_verified_sessions')
        .delete()
        .eq('shop_id', shopId)
        .neq('session_id', keepSessionId)
        .select('session_id');
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data.length : 0;
    },

    async deleteShopAndRetainPhoneHistory({
      shop,
      phoneHash,
      actorUserId,
      wasSuspended,
      deletedAtIso,
    }) {
      const { error: upsertErr } = await admin.from('used_trial_phones').upsert(
        {
          phone_hash: phoneHash,
          first_shop_id: shop.id,
          first_user_id: shop.owner_user_id,
          was_suspended: wasSuspended,
          last_deleted_at: deletedAtIso,
        },
        { onConflict: 'phone_hash' }
      );
      if (upsertErr) throw new Error(upsertErr.message);

      const { error: auditErr } = await admin.from('platform_audit').insert({
        action: 'shop_deleted',
        actor_user_id: actorUserId,
        shop_id: shop.id,
        metadata: { was_suspended: wasSuspended },
      });
      if (auditErr) throw new Error(auditErr.message);

      const { error: delErr } = await admin.from('shops').delete().eq('id', shop.id);
      if (delErr) throw new Error(delErr.message);
    },

    async grantPlatformAdminClaim({ userId }) {
      const { data: existing, error: getErr } = await admin.auth.admin.getUserById(userId);
      if (getErr || !existing.user) throw new Error(getErr?.message ?? 'User not found.');
      const nextMeta = { ...(existing.user.app_metadata ?? {}), platform_admin: true };
      const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
        app_metadata: nextMeta,
      });
      if (updErr) throw new Error(updErr.message);
    },

    async resetPinLockoutWithNotice({
      shopId,
      adminUserId,
      identityCheckNote,
      securityNotice,
      nowIso,
    }) {
      const { error: credErr } = await admin
        .from('shop_pin_credentials')
        .update({
          failed_attempts: 0,
          locked_until: null,
          last_failed_at: null,
          recovery_failed_attempts: 0,
          recovery_locked_until: null,
          recovery_last_failed_at: null,
        })
        .eq('shop_id', shopId);
      if (credErr) throw new Error(credErr.message);

      const { error: shopErr } = await admin
        .from('shops')
        .update({
          security_notice: securityNotice,
          security_notice_at: nowIso,
        })
        .eq('id', shopId);
      if (shopErr) throw new Error(shopErr.message);

      const { error: auditErr } = await admin.from('platform_audit').insert({
        action: 'shop_pin_lockout_reset',
        actor_user_id: adminUserId,
        shop_id: shopId,
        reason: identityCheckNote,
        metadata: { identity_check_note: identityCheckNote },
      });
      if (auditErr) throw new Error(auditErr.message);
    },

    async getActivePinResetRequest(shopId) {
      const { data, error } = await admin
        .from('shop_pin_reset_requests')
        .select('*')
        .eq('shop_id', shopId)
        .eq('status', 'pending_wait')
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DomainPinResetRequest | null) ?? null;
    },

    async upsertPendingPinResetRequest({
      shopId,
      adminUserId,
      identityCheckNote,
      initiatedAtIso,
      availableAtIso,
      expiresAtIso,
      smsNotifiedAtIso,
    }) {
      await admin
        .from('shop_pin_reset_requests')
        .update({
          status: 'cancelled',
          cancelled_at: initiatedAtIso,
          cancelled_by_reason: 'Replaced by newer support-approved PIN reset',
        })
        .eq('shop_id', shopId)
        .eq('status', 'pending_wait');

      const { data, error } = await admin
        .from('shop_pin_reset_requests')
        .insert({
          shop_id: shopId,
          initiated_by_admin_id: adminUserId,
          identity_check_note: identityCheckNote,
          status: 'pending_wait',
          initiated_at: initiatedAtIso,
          available_at: availableAtIso,
          expires_at: expiresAtIso,
          sms_notified_at: smsNotifiedAtIso,
        })
        .select('*')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'Failed to create PIN reset request.');
      return data as DomainPinResetRequest;
    },

    async updatePinResetRequestStatus({ requestId, status, nowIso, reason }) {
      const patch: Record<string, unknown> = { status };
      if (status === 'completed') {
        patch.completed_at = nowIso;
      } else {
        patch.cancelled_at = nowIso;
        patch.cancelled_by_reason = reason ?? null;
      }
      const { error } = await admin
        .from('shop_pin_reset_requests')
        .update(patch)
        .eq('id', requestId);
      if (error) throw new Error(error.message);
    },

    async getSmsUsageCounts({ phoneHash, ipHash, since15mIso, since24hIso, dayUtc }) {
      const [dailyRes, phone15mRes, phone24hRes, ip15mRes, ip24hRes] = await Promise.all([
        admin
          .from('sms_rate_events')
          .select('id', { count: 'exact', head: true })
          .eq('day_utc', dayUtc)
          .eq('blocked', false),
        admin
          .from('sms_rate_events')
          .select('id', { count: 'exact', head: true })
          .eq('phone_hash', phoneHash)
          .eq('purpose', 'otp')
          .eq('blocked', false)
          .gte('created_at', since15mIso),
        admin
          .from('sms_rate_events')
          .select('id', { count: 'exact', head: true })
          .eq('phone_hash', phoneHash)
          .eq('purpose', 'otp')
          .eq('blocked', false)
          .gte('created_at', since24hIso),
        ipHash
          ? admin
              .from('sms_rate_events')
              .select('id', { count: 'exact', head: true })
              .eq('ip_hash', ipHash)
              .eq('purpose', 'otp')
              .eq('blocked', false)
              .gte('created_at', since15mIso)
          : Promise.resolve({ count: 0, error: null }),
        ipHash
          ? admin
              .from('sms_rate_events')
              .select('id', { count: 'exact', head: true })
              .eq('ip_hash', ipHash)
              .eq('purpose', 'otp')
              .eq('blocked', false)
              .gte('created_at', since24hIso)
          : Promise.resolve({ count: 0, error: null }),
      ]);

      const firstErr =
        dailyRes.error ||
        phone15mRes.error ||
        phone24hRes.error ||
        ip15mRes.error ||
        ip24hRes.error;
      if (firstErr) throw new Error(firstErr.message);

      return {
        dailySentCount: dailyRes.count ?? 0,
        phone15mCount: phone15mRes.count ?? 0,
        phone24hCount: phone24hRes.count ?? 0,
        ip15mCount: ip15mRes.count ?? 0,
        ip24hCount: ip24hRes.count ?? 0,
      };
    },

    async claimRecentOtpPrecheck({ phoneHash, sinceIso }) {
      const { data: existing, error: selErr } = await admin
        .from('sms_rate_events')
        .select('id')
        .eq('phone_hash', phoneHash)
        .eq('purpose', 'otp')
        .eq('blocked', false)
        .eq('block_reason', 'precheck_pending')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (selErr) throw new Error(selErr.message);
      if (!existing) return false;

      const { data: claimed, error: updErr } = await admin
        .from('sms_rate_events')
        .update({ block_reason: 'dispatched' })
        .eq('id', existing.id)
        .eq('block_reason', 'precheck_pending')
        .select('id')
        .maybeSingle();
      if (updErr) throw new Error(updErr.message);
      return Boolean(claimed);
    },

    async recordSmsRateEvent({
      phoneHash,
      ipHash,
      purpose,
      blocked,
      blockReason,
      dayUtc,
      createdAtIso,
    }) {
      const { error } = await admin.from('sms_rate_events').insert({
        phone_hash: phoneHash,
        ip_hash: ipHash,
        purpose,
        blocked,
        block_reason: blockReason,
        day_utc: dayUtc,
        created_at: createdAtIso,
      });
      if (error) throw new Error(error.message);
    },

    async upsertPlatformAlert({ alertKey, severity, category, title, detail, metadata }) {
      const { error } = await admin.from('platform_alerts').upsert(
        {
          alert_key: alertKey,
          severity,
          category,
          title,
          detail,
          metadata: metadata ?? {},
          resolved_at: null,
          resolved_by_user_id: null,
        },
        { onConflict: 'alert_key' }
      );
      if (error) throw new Error(error.message);
    },

    async writeAudit({ action, actorUserId, targetUserId, shopId, reason, metadata }) {
      const { error } = await admin.from('platform_audit').insert({
        action,
        actor_user_id: actorUserId ?? null,
        target_user_id: targetUserId ?? null,
        shop_id: shopId ?? null,
        reason: reason ?? null,
        metadata: metadata ?? {},
      });
      if (error) throw new Error(error.message);
    },
  };
}

export function errorResponse(err: unknown, headers: Record<string, string>): Response {
  if (err instanceof EdgeDomainError) {
    return jsonResponse(err.status, { error: err.message, code: err.code }, headers);
  }
  console.error('Edge Function internal error:', err);
  return jsonResponse(
    500,
    { error: 'The request could not be completed. Try again.', code: 'internal_error' },
    headers
  );
}
