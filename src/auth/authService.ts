import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { normalizeZambianPhoneE164 } from '../../shared/authSecurity';
import type { DomainShopRecord, PendingPinResetSummary } from '../../shared/edgeAuthDomain';
import type { PlatformAlertRow } from '../data/database.types';
import { isSupabaseConfigured, supabase } from '../supabase/client';
import type { Shop } from '../types';

export class AuthServiceError extends Error {
  readonly code: string;

  constructor(message: string, code = 'auth_error') {
    super(message);
    this.code = code;
  }
}

export interface AuthUserIdentity {
  id: string;
  phone: string | null;
  email: string | null;
  aal?: 'aal1' | 'aal2';
  isPlatformAdmin: boolean;
  verifiedShopId: string | null;
}

export type AdminSignInOutcome =
  | { status: 'authenticated'; identity: AuthUserIdentity }
  | { status: 'mfa_verify_required'; factorId: string }
  | {
      status: 'mfa_enroll_required';
      factorId: string;
      qrCode: string;
      secret: string;
    };

export interface ShopUnlockStatus {
  hasShop: boolean;
  sessionVerified: boolean;
  isLockedOut: boolean;
  lockedUntil: string | null;
  isRecoveryLockedOut?: boolean;
  recoveryLockedUntil?: string | null;
  pendingPinReset?: PendingPinResetSummary | null;
}

function readClaimsFromSession(session: Session | null): {
  aal: 'aal1' | 'aal2';
  isPlatformAdmin: boolean;
  verifiedShopId: string | null;
} {
  if (!session) return { aal: 'aal1', isPlatformAdmin: false, verifiedShopId: null };
  let jwtAppMeta: Record<string, unknown> = {};
  let jwtAal: 'aal1' | 'aal2' = 'aal1';
  const parts = (session.access_token ?? '').split('.');
  if (parts.length === 3) {
    try {
      const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
      const parsed = JSON.parse(decoded) as {
        aal?: string;
        app_metadata?: Record<string, unknown>;
      };
      if (parsed.aal === 'aal2') {
        jwtAal = 'aal2';
      }
      if (parsed.app_metadata && typeof parsed.app_metadata === 'object') {
        jwtAppMeta = parsed.app_metadata;
      }
    } catch {
      // Ignore malformed token in non-JWT test doubles
    }
  }
  const userAppMeta = (session.user?.app_metadata ?? {}) as Record<string, unknown>;
  const hasAdminClaim = jwtAppMeta.platform_admin === true || userAppMeta.platform_admin === true;
  // Require TOTP MFA (aal2) for any session carrying platform_admin authority
  const isPlatformAdmin = hasAdminClaim && jwtAal === 'aal2';
  const rawShopId = jwtAppMeta.shop_id ?? userAppMeta.shop_id;
  const verifiedShopId = typeof rawShopId === 'string' && rawShopId ? rawShopId : null;
  return { aal: jwtAal, isPlatformAdmin, verifiedShopId };
}

export function mapSessionToIdentity(session: Session | null): AuthUserIdentity | null {
  if (!session?.user) return null;
  const { aal, isPlatformAdmin, verifiedShopId } = readClaimsFromSession(session);
  return {
    id: session.user.id,
    phone: session.user.phone ?? null,
    email: session.user.email ?? null,
    aal,
    isPlatformAdmin,
    verifiedShopId,
  };
}

export function mapDomainShopToClientShop(record: DomainShopRecord): Shop {
  const trialEndsMs = Date.parse(record.trial_ends_at);
  const planExpiryMs = Date.parse(record.plan_expiry_at);
  const salesAccessMs = Date.parse(record.sales_access_until);
  const startedMs = record.subscription_started_at
    ? Date.parse(record.subscription_started_at)
    : undefined;

  return {
    id: record.id,
    name: record.name,
    ownerPhone: record.owner_phone,
    ownerUid: record.owner_user_id,
    planStatus: record.plan_status,
    planType: record.plan_type,
    createdAt: record.created_at,
    trialEndsAt: record.trial_ends_at,
    planExpiryDate: record.plan_expiry_at,
    trialEndsAtMs: Number.isFinite(trialEndsMs) ? trialEndsMs : undefined,
    planExpiryAtMs: Number.isFinite(planExpiryMs) ? planExpiryMs : undefined,
    salesAccessUntilMs: Number.isFinite(salesAccessMs) ? salesAccessMs : undefined,
    ...(record.pending_payment_id ? { pendingPaymentId: record.pending_payment_id } : {}),
    ...(record.subscription_started_at
      ? {
          subscriptionStartedAt: record.subscription_started_at,
          ...(Number.isFinite(startedMs) ? { subscriptionStartedAtMs: startedMs } : {}),
        }
      : {}),
    ...(record.subscription_payment_id
      ? { subscriptionPaymentId: record.subscription_payment_id }
      : {}),
    ...(record.status_before_suspension
      ? { statusBeforeSuspension: record.status_before_suspension }
      : {}),
    isDeactivated: record.is_deactivated,
    currency: 'ZMW',
    ...(record.momo_airtel_number ? { momoAirtelNumber: record.momo_airtel_number } : {}),
    ...(record.momo_mtn_number ? { momoMtnNumber: record.momo_mtn_number } : {}),
    ...(record.momo_zamtel_number ? { momoZamtelNumber: record.momo_zamtel_number } : {}),
    securityNotice: record.security_notice ?? null,
    securityNoticeAt: record.security_notice_at ?? null,
    subscriptionNotice: record.subscription_notice ?? null,
    subscriptionNoticeAt: record.subscription_notice_at ?? null,
  };
}

async function invokeEdgeFunction<TResponse>(
  functionName: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) {
    const maybeContext = (error as { context?: Response }).context;
    if (maybeContext && typeof maybeContext.json === 'function') {
      try {
        const parsed = (await maybeContext.json()) as { error?: string; code?: string };
        if (parsed.error) {
          throw new AuthServiceError(parsed.error, parsed.code ?? 'edge_error');
        }
      } catch (inner) {
        if (inner instanceof AuthServiceError) throw inner;
      }
    }
    const code = (error as { code?: string }).code ?? 'edge_error';
    throw new AuthServiceError(
      error instanceof Error ? error.message : 'Could not complete server request.',
      code
    );
  }
  return data as TResponse;
}

export async function getActiveAuthIdentity(): Promise<AuthUserIdentity | null> {
  const { data } = await supabase.auth.getSession();
  return mapSessionToIdentity(data.session);
}

export function subscribeToAuthIdentity(
  listener: (identity: AuthUserIdentity | null, rawUser: SupabaseUser | null) => void
): () => void {
  let active = true;
  void supabase.auth
    .getSession()
    .then(({ data }) => {
      if (active) listener(mapSessionToIdentity(data.session), data.session?.user ?? null);
    })
    .catch(() => {
      if (active) listener(null, null);
    });

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    if (!active) return;
    listener(mapSessionToIdentity(session), session?.user ?? null);
  });

  return () => {
    active = false;
    data.subscription.unsubscribe();
  };
}

export async function requestPhoneOtp(
  rawPhone: string,
  captchaToken?: string
): Promise<{ phoneE164: string }> {
  const phoneE164 = normalizeZambianPhoneE164(rawPhone);

  // Enforce per-IP, per-phone, and fail-safe global daily SMS cap before GoTrue sends OTP
  if (isSupabaseConfigured()) {
    await invokeEdgeFunction<{ allowed: true; canonicalPhone: string }>('check-otp-rate-limit', {
      phone: phoneE164,
    });
  }

  const { error } = await supabase.auth.signInWithOtp({
    phone: phoneE164,
    options: captchaToken ? { captchaToken } : undefined,
  });
  if (error) {
    throw new AuthServiceError(error.message, error.code ?? 'otp_send_failed');
  }
  return { phoneE164 };
}

export async function verifyPhoneOtp(
  rawPhone: string,
  otpToken: string
): Promise<AuthUserIdentity> {
  const phoneE164 = normalizeZambianPhoneE164(rawPhone);
  const cleanCode = otpToken.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new AuthServiceError('Enter the 6-digit code sent by SMS.', 'invalid_otp');
  }
  const { data, error } = await supabase.auth.verifyOtp({
    phone: phoneE164,
    token: cleanCode,
    type: 'sms',
  });
  if (error || !data.session) {
    throw new AuthServiceError(
      error?.message ?? 'Invalid or expired SMS verification code.',
      error?.code ?? 'otp_verify_failed'
    );
  }
  const identity = mapSessionToIdentity(data.session);
  if (!identity) {
    throw new AuthServiceError('Could not establish verified phone session.', 'no_session');
  }
  return identity;
}

export async function checkShopUnlockStatus(): Promise<ShopUnlockStatus> {
  return invokeEdgeFunction('unlock-shop-session', { action: 'status' });
}

export async function registerShopWithServer(input: {
  name: string;
  pin: string;
}): Promise<{ shop: Shop; recoveryCode: string; trialGranted: boolean }> {
  const res = await invokeEdgeFunction<{
    shop: DomainShopRecord;
    recoveryCode: string;
    trialGranted: boolean;
  }>('register-shop', input);

  // Refresh JWT so custom_access_token_hook injects app_metadata.shop_id for this verified session
  await supabase.auth.refreshSession().catch(() => undefined);

  return {
    shop: mapDomainShopToClientShop(res.shop),
    recoveryCode: res.recoveryCode,
    trialGranted: res.trialGranted,
  };
}

export async function unlockShopSessionWithPin(pin: string): Promise<{ shop: Shop }> {
  const res = await invokeEdgeFunction<{ shop: DomainShopRecord }>('unlock-shop-session', {
    action: 'unlock',
    pin,
  });

  await supabase.auth.refreshSession().catch(() => undefined);

  return { shop: mapDomainShopToClientShop(res.shop) };
}

export async function recoverShopPinWithCode(input: {
  recoveryCode: string;
  newPin: string;
}): Promise<{ shop: Shop; recoveryCode: string }> {
  const res = await invokeEdgeFunction<{
    shop: DomainShopRecord;
    recoveryCode: string;
  }>('recover-shop-pin', input);

  await supabase.auth.refreshSession().catch(() => undefined);

  return {
    shop: mapDomainShopToClientShop(res.shop),
    recoveryCode: res.recoveryCode,
  };
}

export async function completeApprovedShopPinReset(input: {
  newPin: string;
}): Promise<{ shop: Shop; recoveryCode: string }> {
  const res = await invokeEdgeFunction<{
    shop: DomainShopRecord;
    recoveryCode: string;
  }>('complete-approved-pin-reset', input);

  await supabase.auth.refreshSession().catch(() => undefined);

  return {
    shop: mapDomainShopToClientShop(res.shop),
    recoveryCode: res.recoveryCode,
  };
}

export async function changeShopPinOnServer(input: {
  currentPin: string;
  newPin: string;
}): Promise<void> {
  await invokeEdgeFunction<{ updated: true }>('change-shop-pin', input);
}

export async function revokeOtherShopSessionsOnServer(): Promise<{ revokedCount: number }> {
  const res = await invokeEdgeFunction<{ revokedCount: number }>('revoke-other-sessions', {});
  await supabase.auth.signOut({ scope: 'others' }).catch(() => undefined);
  return res;
}

export async function cancelPendingPinResetOnServer(): Promise<boolean> {
  const { data, error } = await supabase.rpc('cancel_pending_shop_pin_reset');
  if (error) {
    throw new AuthServiceError(error.message, error.code ?? 'rpc_failed');
  }
  return Boolean(data);
}

export async function deleteShopOnServer(input: {
  confirmationName: string;
  pin: string;
}): Promise<void> {
  await invokeEdgeFunction<{ deleted: true }>('delete-shop', input);
}

async function finalizeVerifiedAdminSession(): Promise<AuthUserIdentity> {
  const verifyRes = await invokeEdgeFunction<{ isAdmin: boolean }>('verify-platform-admin', {});
  if (!verifyRes.isAdmin) {
    throw new AuthServiceError(
      'This account is not authorized for platform administration.',
      'permission_denied'
    );
  }

  const refreshed = await supabase.auth.refreshSession();
  const identity = mapSessionToIdentity(refreshed.data.session);
  if (!identity || !identity.isPlatformAdmin) {
    throw new AuthServiceError(
      'Administrator MFA access could not be verified. Sign in again.',
      'permission_denied'
    );
  }
  return identity;
}

/**
 * Step 1 of Platform Admin Sign-In: verifies email + password, then requires
 * TOTP MFA (`aal2`). If the admin has not yet enrolled an authenticator app,
 * initiates TOTP enrollment and returns the QR code + secret.
 */
export async function signInPlatformAdmin(
  email: string,
  password: string
): Promise<AdminSignInOutcome> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error || !data.session) {
    throw new AuthServiceError(
      'The account or password is incorrect. Use the authorized platform account.',
      error?.code ?? 'invalid_credentials'
    );
  }

  try {
    const aalCheck = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalCheck.error) {
      throw new AuthServiceError(aalCheck.error.message, 'mfa_error');
    }

    if (aalCheck.data.currentLevel === 'aal2') {
      const identity = await finalizeVerifiedAdminSession();
      return { status: 'authenticated', identity };
    }

    const factorsRes = await supabase.auth.mfa.listFactors();
    if (factorsRes.error) {
      throw new AuthServiceError(factorsRes.error.message, 'mfa_error');
    }

    const verifiedTotp = factorsRes.data.totp.find((f) => f.status === 'verified');
    if (verifiedTotp) {
      return { status: 'mfa_verify_required', factorId: verifiedTotp.id };
    }

    // Clean up any stale unverified factor from an abandoned enrollment before enrolling fresh
    for (const factor of factorsRes.data.all) {
      if (factor.status === 'unverified') {
        await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => undefined);
      }
    }

    const enrollRes = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'CountUp Platform Admin',
    });
    if (enrollRes.error || !enrollRes.data) {
      throw new AuthServiceError(
        enrollRes.error?.message ?? 'Could not set up two-factor authenticator.',
        'mfa_enroll_failed'
      );
    }

    return {
      status: 'mfa_enroll_required',
      factorId: enrollRes.data.id,
      qrCode: enrollRes.data.totp.qr_code,
      secret: enrollRes.data.totp.secret,
    };
  } catch (err) {
    await supabase.auth.signOut().catch(() => undefined);
    throw err;
  }
}

/**
 * Step 2 of Platform Admin Sign-In: verifies the 6-digit TOTP authenticator
 * code to elevate the session to `aal2`, then verifies platform_admin claim.
 */
export async function completePlatformAdminMfa(
  factorId: string,
  totpCode: string
): Promise<AuthUserIdentity> {
  const cleanCode = totpCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new AuthServiceError(
      'Enter the 6-digit code from your authenticator app.',
      'invalid_mfa_code'
    );
  }

  const verifyRes = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: cleanCode,
  });
  if (verifyRes.error) {
    throw new AuthServiceError(
      'Invalid or expired 6-digit authenticator code. Try the current code shown in your app.',
      verifyRes.error.code ?? 'invalid_mfa_code'
    );
  }

  try {
    return await finalizeVerifiedAdminSession();
  } catch (err) {
    await supabase.auth.signOut().catch(() => undefined);
    throw err;
  }
}

export async function sendAdminPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
  if (error) {
    throw new AuthServiceError(error.message, error.code ?? 'reset_failed');
  }
}

export async function adminResetShopPinLockout(input: {
  shopId: string;
  identityCheckNote: string;
}): Promise<void> {
  await invokeEdgeFunction<{ reset: true }>('admin-reset-pin-lockout', input);
}

export async function adminInitiateShopPinReset(input: {
  shopId: string;
  identityCheckNote: string;
}): Promise<{ availableAt: string; expiresAt: string }> {
  return invokeEdgeFunction<{
    initiated: true;
    availableAt: string;
    expiresAt: string;
  }>('admin-initiate-pin-reset', input);
}

export async function fetchActivePlatformAlerts(): Promise<PlatformAlertRow[]> {
  const { data, error } = await supabase
    .from('platform_alerts')
    .select('*')
    .is('resolved_at', null)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as PlatformAlertRow[];
}

export async function acknowledgeShopSecurityNoticeOnServer(): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_shop_security_notice');
  if (error) {
    throw new AuthServiceError(error.message, error.code ?? 'rpc_failed');
  }
}

export async function acknowledgeShopSubscriptionNoticeOnServer(): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_shop_subscription_notice');
  if (error) {
    throw new AuthServiceError(error.message, error.code ?? 'rpc_failed');
  }
}

export async function fetchVerifiedShopFromServer(shopId: string): Promise<Shop | null> {
  const { data, error } = await supabase.from('shops').select('*').eq('id', shopId).maybeSingle();
  if (error || !data) return null;
  return mapDomainShopToClientShop(data as DomainShopRecord);
}

export async function fetchAllShopsForAdmin(): Promise<Shop[]> {
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return (data as DomainShopRecord[]).map(mapDomainShopToClientShop);
}

export async function signOutSupabase(): Promise<void> {
  await supabase.auth.signOut();
}
