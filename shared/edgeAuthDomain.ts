import {
  calculateNewDeviceLockoutMs,
  deriveSecretHashHex,
  generateOneTimeRecoveryCode,
  generateSaltHex,
  hashPhoneForTrialGuard,
  hashRateLimitIdentifier,
  isValidFourDigitPin,
  normalizeRecoveryCode,
  normalizeZambianPhoneE164,
  SERVER_PBKDF2_ITERATIONS,
  validateIdentityCheckNote,
  validateShopName,
  verifySecretHash,
} from './authSecurity';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 30;
const GRACE_DAYS = 3;
const RECOVERY_DOMAIN = 'countup-recovery-v2';

export const PIN_RESET_WAITING_PERIOD_MS = 72 * 60 * 60 * 1000; // 72 hours
export const PIN_RESET_COMPLETION_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours after 72h wait

export type SmsRatePurpose =
  'otp' | 'otp_registration' | 'otp_signin' | 'pin_reset_notice' | 'recovery_code_notice';

export interface SmsRateLimitPolicy {
  maxPerPhone15m: number;
  maxPerPhone24h: number;
  maxPerIp15m: number;
  maxPerIp24h: number;
  dailyNewRegistrationCap: number;
  dailyExistingSignInCap: number;
  budgetWarningRatio: number;
  /** Optional combined cap override for legacy callers/tests. */
  globalDailyCap?: number;
}

/**
 * Tuned for Zambian mobile carrier CGNAT (MTN, Airtel, Zamtel share public IPv4
 * pools across many handsets) and split daily OTP budgets so registration bursts
 * never lock out existing paying shop owners or block security notice SMS.
 */
export const DEFAULT_SMS_RATE_LIMIT_POLICY: SmsRateLimitPolicy = {
  maxPerPhone15m: 3,
  maxPerPhone24h: 8,
  maxPerIp15m: 30,
  maxPerIp24h: 100,
  dailyNewRegistrationCap: 150,
  dailyExistingSignInCap: 200,
  budgetWarningRatio: 0.8,
};

export interface DomainShopRecord {
  id: string;
  owner_user_id: string;
  name: string;
  owner_phone: string;
  plan_status:
    'trial' | 'pending_payment' | 'active' | 'grace' | 'expired' | 'rejected' | 'suspended';
  plan_type: 'trial' | 'monthly' | 'quarterly' | 'biannual';
  trial_ends_at: string;
  plan_expiry_at: string;
  sales_access_until: string;
  pending_payment_id: string | null;
  subscription_started_at: string | null;
  subscription_payment_id: string | null;
  status_before_suspension:
    'trial' | 'pending_payment' | 'active' | 'grace' | 'expired' | 'rejected' | null;
  is_deactivated: boolean;
  currency: 'ZMW';
  momo_airtel_number: string | null;
  momo_mtn_number: string | null;
  momo_zamtel_number: string | null;
  security_notice: string | null;
  security_notice_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainPinCredentials {
  shop_id: string;
  pin_salt: string;
  pin_hash: string;
  pin_iterations: number;
  recovery_salt: string;
  recovery_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  last_failed_at: string | null;
  recovery_failed_attempts: number;
  recovery_locked_until: string | null;
  recovery_last_failed_at: string | null;
}

export interface DomainUsedTrialPhone {
  phone_hash: string;
  first_shop_id: string;
  first_user_id: string | null;
  was_suspended: boolean;
  last_deleted_at: string | null;
}

export interface DomainPinResetRequest {
  id: string;
  shop_id: string;
  initiated_by_admin_id: string | null;
  identity_check_note: string;
  status: 'pending_wait' | 'completed' | 'cancelled';
  initiated_at: string;
  available_at: string;
  expires_at: string;
  sms_notified_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_reason: string | null;
}

export interface PendingPinResetSummary {
  status: 'pending_wait' | 'ready';
  initiatedAt: string;
  availableAt: string;
  expiresAt: string;
}

export interface EdgeAuthRepository {
  findShopByOwnerUserId(userId: string): Promise<DomainShopRecord | null>;
  findShopByPhone(ownerPhone: string): Promise<DomainShopRecord | null>;
  findShopById(shopId: string): Promise<DomainShopRecord | null>;
  findUsedTrialPhone(phoneHash: string): Promise<DomainUsedTrialPhone | null>;
  createShopRegistration(params: {
    shop: Omit<DomainShopRecord, 'created_at' | 'updated_at'>;
    credentials: Pick<
      DomainPinCredentials,
      'shop_id' | 'pin_salt' | 'pin_hash' | 'pin_iterations' | 'recovery_salt' | 'recovery_hash'
    >;
    sessionId: string;
    trialPhoneHash: string | null;
  }): Promise<DomainShopRecord>;
  getPinCredentials(shopId: string): Promise<DomainPinCredentials | null>;
  updatePinAttemptState(params: {
    shopId: string;
    failedAttempts: number;
    lockedUntil: string | null;
    lastFailedAt: string | null;
  }): Promise<void>;
  updateRecoveryAttemptState(params: {
    shopId: string;
    recoveryFailedAttempts: number;
    recoveryLockedUntil: string | null;
    recoveryLastFailedAt: string | null;
  }): Promise<void>;
  updatePinAndRecoveryCredentials(params: {
    shopId: string;
    pinSalt: string;
    pinHash: string;
    pinIterations: number;
    recoverySalt?: string;
    recoveryHash?: string;
  }): Promise<void>;
  setShopSecurityNotice(params: {
    shopId: string;
    securityNotice: string | null;
    nowIso: string | null;
  }): Promise<void>;
  markSessionVerified(params: { shopId: string; userId: string; sessionId: string }): Promise<void>;
  isSessionVerified(params: {
    shopId: string;
    userId: string;
    sessionId: string;
  }): Promise<boolean>;
  revokeOtherVerifiedSessions(params: { shopId: string; keepSessionId: string }): Promise<number>;
  deleteShopAndRetainPhoneHistory(params: {
    shop: DomainShopRecord;
    phoneHash: string;
    actorUserId: string;
    wasSuspended: boolean;
    deletedAtIso: string;
  }): Promise<void>;
  grantPlatformAdminClaim(params: { userId: string }): Promise<void>;
  resetPinLockoutWithNotice(params: {
    shopId: string;
    adminUserId: string;
    identityCheckNote: string;
    securityNotice: string;
    nowIso: string;
  }): Promise<void>;
  getActivePinResetRequest(shopId: string): Promise<DomainPinResetRequest | null>;
  upsertPendingPinResetRequest(params: {
    shopId: string;
    adminUserId: string;
    identityCheckNote: string;
    initiatedAtIso: string;
    availableAtIso: string;
    expiresAtIso: string;
    smsNotifiedAtIso: string | null;
  }): Promise<DomainPinResetRequest>;
  updatePinResetRequestStatus(params: {
    requestId: string;
    status: 'completed' | 'cancelled';
    nowIso: string;
    reason?: string | null;
  }): Promise<void>;
  // SMS abuse rate-limiting & split daily OTP budgets
  getSmsUsageCounts(params: {
    phoneHash: string;
    ipHash: string | null;
    since15mIso: string;
    since24hIso: string;
    dayUtc: string;
  }): Promise<{
    dailySentCount: number;
    dailyNewRegistrationCount: number;
    dailyExistingSignInCount: number;
    phone15mCount: number;
    phone24hCount: number;
    ip15mCount: number;
    ip24hCount: number;
  }>;
  claimRecentOtpPrecheck(params: { phoneHash: string; sinceIso: string }): Promise<boolean>;
  recordSmsRateEvent(params: {
    phoneHash: string;
    ipHash: string | null;
    purpose: SmsRatePurpose;
    blocked: boolean;
    blockReason: string | null;
    dayUtc: string;
    createdAtIso: string;
  }): Promise<void>;
  upsertPlatformAlert(params: {
    alertKey: string;
    severity: 'warning' | 'critical';
    category: 'sms_cap' | 'sms_abuse' | 'security';
    title: string;
    detail: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  writeAudit(params: {
    action: string;
    actorUserId: string | null;
    targetUserId?: string | null;
    shopId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class EdgeDomainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requirePepper(pepper: string): string {
  const clean = pepper.trim();
  if (clean.length < 16) {
    throw new EdgeDomainError(
      500,
      'server_misconfigured',
      'Server PIN security secret is not configured.'
    );
  }
  return clean;
}

function requireSessionId(sessionId: string): string {
  const clean = sessionId.trim();
  if (!clean || clean.length > 128) {
    throw new EdgeDomainError(401, 'invalid_session', 'Sign in again to verify your session.');
  }
  return clean;
}

function requireAdminMfa(isPlatformAdmin: boolean, aal?: string | null): void {
  if (!isPlatformAdmin) {
    throw new EdgeDomainError(403, 'permission_denied', 'Administrator access is required.');
  }
  if (aal !== 'aal2') {
    throw new EdgeDomainError(
      403,
      'mfa_required',
      'Multi-factor authentication (6-digit authenticator code) is required for platform administration.'
    );
  }
}

function formatRemainingWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function maybeEmitBudgetWarningAlert(
  repo: EdgeAuthRepository,
  params: {
    bucketKey: 'new_registration' | 'existing_signin';
    bucketLabel: string;
    projectedCount: number;
    bucketCap: number;
    warningRatio: number;
    dayUtc: string;
  }
): Promise<void> {
  if (params.bucketCap <= 0) return;
  const ratio = params.projectedCount / params.bucketCap;
  if (ratio < params.warningRatio || params.projectedCount > params.bucketCap) return;
  const pct = Math.min(100, Math.round(ratio * 100));
  await repo
    .upsertPlatformAlert({
      alertKey: `sms_budget_80pct:${params.bucketKey}:${params.dayUtc}`,
      severity: 'warning',
      category: 'sms_cap',
      title: `Daily SMS budget at ${pct}% (${params.bucketLabel})`,
      detail: `${params.bucketLabel} OTP usage reached ${params.projectedCount}/${params.bucketCap} (${pct}%) on ${params.dayUtc} (UTC).`,
      metadata: {
        day_utc: params.dayUtc,
        bucket: params.bucketKey,
        sent_count: params.projectedCount,
        daily_cap: params.bucketCap,
        percent_used: pct,
      },
    })
    .catch(() => undefined);
}

/**
 * Enforces per-phone, per-IP (tuned for Zambian mobile CGNAT), and split daily
 * OTP budgets:
 *   - New registrations (`otp_registration` -> `dailyNewRegistrationCap`)
 *   - Existing-shop sign-ins (`otp_signin` -> `dailyExistingSignInCap`)
 *   - Security notice SMS (`pin_reset_notice`, `recovery_code_notice`) are
 *     audited in `sms_rate_events` but NEVER counted against or blocked by
 *     either OTP daily cap.
 * Emits a `warning` platform alert when any OTP budget reaches/passes 80%, and
 * fails safe (`503`) + emits a `critical` alert when a bucket hits 100% or if
 * the database ledger cannot be verified.
 */
export async function handleCheckAndRecordSmsAllowance(
  repo: EdgeAuthRepository,
  input: {
    phone: string;
    clientIp?: string | null;
    purpose: SmsRatePurpose;
    stage: 'precheck' | 'dispatch';
    pepper: string;
    policy?: Partial<SmsRateLimitPolicy>;
    actorUserId?: string | null;
    now?: Date;
  }
): Promise<{
  allowed: true;
  canonicalPhone: string;
  resolvedPurpose: SmsRatePurpose;
}> {
  const pepper = requirePepper(input.pepper);
  let canonicalPhone: string;
  try {
    canonicalPhone = normalizeZambianPhoneE164(input.phone);
  } catch (err) {
    throw new EdgeDomainError(
      400,
      'invalid_phone',
      err instanceof Error ? err.message : 'Enter a valid Zambian mobile number.'
    );
  }

  const policy: SmsRateLimitPolicy = {
    ...DEFAULT_SMS_RATE_LIMIT_POLICY,
    ...input.policy,
  };
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const dayUtc = formatUtcDay(now);
  const since15mIso = new Date(nowMs - 15 * 60_000).toISOString();
  const since24hIso = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  const since60sIso = new Date(nowMs - 60_000).toISOString();

  const phoneHash = await hashRateLimitIdentifier(canonicalPhone, pepper, 'phone');
  const cleanIp = input.clientIp?.trim() || null;
  const ipHash = cleanIp ? await hashRateLimitIdentifier(cleanIp, pepper, 'ip') : null;

  const isSecurityNotice =
    input.purpose === 'pin_reset_notice' || input.purpose === 'recovery_code_notice';

  // Security notice SMS (72h PIN reset warning & recovery-code usage alert) are
  // exempt from OTP daily caps and OTP per-IP/per-phone throttles so an OTP surge
  // can never silence owner anti-takeover warnings.
  if (isSecurityNotice) {
    try {
      await repo.recordSmsRateEvent({
        phoneHash,
        ipHash,
        purpose: input.purpose,
        blocked: false,
        blockReason: 'security_notice_dispatched',
        dayUtc,
        createdAtIso: nowIso,
      });
    } catch {
      throw new EdgeDomainError(
        503,
        'sms_failsafe_unavailable',
        'SMS security notifications are temporarily paused for safety. Please try again shortly.'
      );
    }
    return { allowed: true, canonicalPhone, resolvedPurpose: input.purpose };
  }

  let resolvedPurpose: 'otp_registration' | 'otp_signin';
  let counts: Awaited<ReturnType<EdgeAuthRepository['getSmsUsageCounts']>>;
  try {
    if (input.purpose === 'otp_registration' || input.purpose === 'otp_signin') {
      resolvedPurpose = input.purpose;
    } else {
      const existingShop = await repo.findShopByPhone(canonicalPhone);
      resolvedPurpose = existingShop ? 'otp_signin' : 'otp_registration';
    }

    const bucketCap =
      resolvedPurpose === 'otp_signin'
        ? policy.dailyExistingSignInCap
        : policy.dailyNewRegistrationCap;
    const bucketKey =
      resolvedPurpose === 'otp_signin'
        ? ('existing_signin' as const)
        : ('new_registration' as const);
    const bucketLabel =
      resolvedPurpose === 'otp_signin' ? 'Existing-shop sign-in' : 'New shop registration';

    // When GoTrue invokes `send-sms-hook` right after a browser `precheck`,
    // claim that recent precheck row so one OTP is counted once, while still
    // verifying the bucket cap has not been exceeded.
    if (input.stage === 'dispatch') {
      const claimed = await repo.claimRecentOtpPrecheck({
        phoneHash,
        sinceIso: since60sIso,
      });
      if (claimed) {
        counts = await repo.getSmsUsageCounts({
          phoneHash,
          ipHash: null,
          since15mIso,
          since24hIso,
          dayUtc,
        });
        const bucketCount =
          resolvedPurpose === 'otp_signin'
            ? counts.dailyExistingSignInCount
            : counts.dailyNewRegistrationCount;
        if (
          bucketCount > bucketCap ||
          (policy.globalDailyCap !== undefined && counts.dailySentCount > policy.globalDailyCap)
        ) {
          throw new EdgeDomainError(
            503,
            'sms_daily_cap_reached',
            'SMS verification is temporarily unavailable today. Try again later or contact support.'
          );
        }
        await maybeEmitBudgetWarningAlert(repo, {
          bucketKey,
          bucketLabel,
          projectedCount: bucketCount,
          bucketCap,
          warningRatio: policy.budgetWarningRatio,
          dayUtc,
        });
        return { allowed: true, canonicalPhone, resolvedPurpose };
      }
    }

    counts = await repo.getSmsUsageCounts({
      phoneHash,
      ipHash,
      since15mIso,
      since24hIso,
      dayUtc,
    });
  } catch (err) {
    if (err instanceof EdgeDomainError) throw err;
    // FAIL SAFE: never send SMS if rate-limit ledger cannot be verified.
    throw new EdgeDomainError(
      503,
      'sms_failsafe_unavailable',
      'SMS verification is temporarily paused for safety. Please try again shortly.'
    );
  }

  const bucketKey =
    resolvedPurpose === 'otp_signin' ? ('existing_signin' as const) : ('new_registration' as const);
  const bucketLabel =
    resolvedPurpose === 'otp_signin' ? 'Existing-shop sign-in' : 'New shop registration';
  const bucketCap =
    resolvedPurpose === 'otp_signin'
      ? policy.dailyExistingSignInCap
      : policy.dailyNewRegistrationCap;
  const bucketSentCount =
    resolvedPurpose === 'otp_signin'
      ? counts.dailyExistingSignInCount
      : counts.dailyNewRegistrationCount;

  const legacyGlobalReached =
    policy.globalDailyCap !== undefined && counts.dailySentCount >= policy.globalDailyCap;

  // 1. Split daily OTP budget cap (fail-safe stop for ONLY the exhausted bucket + critical Admin alert)
  if (bucketSentCount >= bucketCap || legacyGlobalReached) {
    const effectiveCap = legacyGlobalReached ? (policy.globalDailyCap ?? bucketCap) : bucketCap;
    const effectiveSent = legacyGlobalReached ? counts.dailySentCount : bucketSentCount;
    try {
      await repo.recordSmsRateEvent({
        phoneHash,
        ipHash,
        purpose: resolvedPurpose,
        blocked: true,
        blockReason: legacyGlobalReached ? 'global_daily_cap' : `${bucketKey}_daily_cap`,
        dayUtc,
        createdAtIso: nowIso,
      });
      await repo.upsertPlatformAlert({
        alertKey: `sms_daily_cap:${bucketKey}:${dayUtc}`,
        severity: 'critical',
        category: 'sms_cap',
        title: `${bucketLabel} daily SMS cap reached — paused`,
        detail: `CountUp reached ${effectiveSent}/${effectiveCap} ${bucketLabel.toLowerCase()} OTP messages on ${dayUtc} (UTC). This OTP bucket paused automatically to prevent billing abuse.`,
        metadata: {
          day_utc: dayUtc,
          bucket: bucketKey,
          daily_sent_count: effectiveSent,
          daily_cap: effectiveCap,
        },
      });
      await repo.writeAudit({
        action: 'sms_daily_cap_reached',
        actorUserId: input.actorUserId ?? null,
        reason: `${bucketLabel} daily SMS cap (${effectiveCap}) reached on ${dayUtc}`,
        metadata: {
          day_utc: dayUtc,
          bucket: bucketKey,
          daily_sent_count: effectiveSent,
          daily_cap: effectiveCap,
        },
      });
    } catch {
      // Even if alert persistence fails, fail safe and refuse to send SMS.
    }
    throw new EdgeDomainError(
      503,
      'sms_daily_cap_reached',
      resolvedPurpose === 'otp_registration'
        ? 'New shop SMS verification is temporarily paused because today’s registration SMS limit was reached. Existing shops can still sign in.'
        : 'SMS sign-in verification is temporarily paused because today’s daily SMS limit was reached. Please try again later.'
    );
  }

  // 2. Per-IP limits (tuned for Zambian mobile CGNAT: 30 / 15m, 100 / 24h)
  if (ipHash) {
    if (counts.ip15mCount >= policy.maxPerIp15m || counts.ip24hCount >= policy.maxPerIp24h) {
      const reason =
        counts.ip15mCount >= policy.maxPerIp15m ? 'ip_rate_limit_15m' : 'ip_rate_limit_24h';
      await repo
        .recordSmsRateEvent({
          phoneHash,
          ipHash,
          purpose: resolvedPurpose,
          blocked: true,
          blockReason: reason,
          dayUtc,
          createdAtIso: nowIso,
        })
        .catch(() => undefined);
      await repo
        .upsertPlatformAlert({
          alertKey: `sms_ip_abuse:${dayUtc}:${ipHash.slice(0, 12)}`,
          severity: 'warning',
          category: 'sms_abuse',
          title: 'Repeated SMS OTP requests blocked from one IP',
          detail: `Blocked excess OTP requests (${reason}) on ${dayUtc} (UTC).`,
          metadata: { reason, ip_hash_prefix: ipHash.slice(0, 12) },
        })
        .catch(() => undefined);
      throw new EdgeDomainError(
        429,
        'sms_ip_rate_limited',
        'Too many SMS requests from this connection. Wait 15 minutes before trying again.'
      );
    }
  }

  // 3. Per-phone limits
  if (
    counts.phone15mCount >= policy.maxPerPhone15m ||
    counts.phone24hCount >= policy.maxPerPhone24h
  ) {
    const reason =
      counts.phone15mCount >= policy.maxPerPhone15m
        ? 'phone_rate_limit_15m'
        : 'phone_rate_limit_24h';
    await repo
      .recordSmsRateEvent({
        phoneHash,
        ipHash,
        purpose: resolvedPurpose,
        blocked: true,
        blockReason: reason,
        dayUtc,
        createdAtIso: nowIso,
      })
      .catch(() => undefined);
    throw new EdgeDomainError(
      429,
      'sms_phone_rate_limited',
      counts.phone15mCount >= policy.maxPerPhone15m
        ? 'Too many SMS codes requested for this phone number. Wait 15 minutes and try again.'
        : 'Daily SMS verification limit reached for this phone number. Try again tomorrow.'
    );
  }

  try {
    await repo.recordSmsRateEvent({
      phoneHash,
      ipHash,
      purpose: resolvedPurpose,
      blocked: false,
      blockReason: input.stage === 'precheck' ? 'precheck_pending' : 'dispatched',
      dayUtc,
      createdAtIso: nowIso,
    });
  } catch {
    throw new EdgeDomainError(
      503,
      'sms_failsafe_unavailable',
      'SMS verification is temporarily paused for safety. Please try again shortly.'
    );
  }

  await maybeEmitBudgetWarningAlert(repo, {
    bucketKey,
    bucketLabel,
    projectedCount: bucketSentCount + 1,
    bucketCap,
    warningRatio: policy.budgetWarningRatio,
    dayUtc,
  });

  return { allowed: true, canonicalPhone, resolvedPurpose };
}

export async function handleRegisterShop(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    verifiedPhone: string | undefined | null;
    sessionId: string;
    shopName: string;
    pin: string;
    pepper: string;
    phoneHashSalt?: string;
    iterations?: number;
    now?: Date;
  }
): Promise<{ shop: DomainShopRecord; recoveryCode: string; trialGranted: boolean }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);
  if (!input.verifiedPhone) {
    throw new EdgeDomainError(
      400,
      'phone_not_verified',
      'Verify your phone number with the SMS code before creating a shop.'
    );
  }

  let canonicalPhone: string;
  let cleanName: string;
  try {
    canonicalPhone = normalizeZambianPhoneE164(input.verifiedPhone);
    cleanName = validateShopName(input.shopName);
  } catch (err) {
    throw new EdgeDomainError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Enter a valid shop name and Zambian phone number.'
    );
  }

  if (!isValidFourDigitPin(input.pin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'Enter a PIN with exactly 4 numbers.');
  }

  const iterations = input.iterations ?? SERVER_PBKDF2_ITERATIONS;
  const phoneHash = await hashPhoneForTrialGuard(canonicalPhone, pepper, {
    saltHex: input.phoneHashSalt,
    iterations,
  });

  const [byOwner, byPhone, usedPhone] = await Promise.all([
    repo.findShopByOwnerUserId(input.userId),
    repo.findShopByPhone(canonicalPhone),
    repo.findUsedTrialPhone(phoneHash),
  ]);
  if (byOwner || byPhone) {
    throw new EdgeDomainError(
      409,
      'shop_already_exists',
      'A shop is already registered for this phone number. Sign in instead.'
    );
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let trialGranted = false;
  let planStatus: DomainShopRecord['plan_status'];
  let statusBeforeSuspension: DomainShopRecord['status_before_suspension'] = null;
  let isDeactivated = false;
  let trialEndsIso: string;
  let planExpiryIso: string;
  let salesAccessIso: string;

  if (!usedPhone) {
    trialGranted = true;
    planStatus = 'trial';
    const trialEndsMs = nowMs + TRIAL_DAYS * DAY_MS;
    trialEndsIso = new Date(trialEndsMs).toISOString();
    planExpiryIso = trialEndsIso;
    salesAccessIso = new Date(trialEndsMs + GRACE_DAYS * DAY_MS).toISOString();
  } else if (usedPhone.was_suspended) {
    trialGranted = false;
    isDeactivated = true;
    planStatus = 'suspended';
    statusBeforeSuspension = 'expired';
    trialEndsIso = nowIso;
    planExpiryIso = nowIso;
    salesAccessIso = nowIso;
  } else {
    trialGranted = false;
    isDeactivated = false;
    planStatus = 'expired';
    trialEndsIso = nowIso;
    planExpiryIso = nowIso;
    salesAccessIso = nowIso;
  }

  const shopId = globalThis.crypto.randomUUID();
  const pinSalt = generateSaltHex();
  const pinHash = await deriveSecretHashHex(input.pin, pinSalt, { pepper, iterations });

  const recoveryCode = generateOneTimeRecoveryCode();
  const recoverySalt = generateSaltHex();
  const recoveryHash = await deriveSecretHashHex(recoveryCode, recoverySalt, {
    pepper,
    domain: RECOVERY_DOMAIN,
    iterations,
  });

  const shop = await repo.createShopRegistration({
    shop: {
      id: shopId,
      owner_user_id: input.userId,
      name: cleanName,
      owner_phone: canonicalPhone,
      plan_status: planStatus,
      plan_type: 'trial',
      trial_ends_at: trialEndsIso,
      plan_expiry_at: planExpiryIso,
      sales_access_until: salesAccessIso,
      pending_payment_id: null,
      subscription_started_at: null,
      subscription_payment_id: null,
      status_before_suspension: statusBeforeSuspension,
      is_deactivated: isDeactivated,
      currency: 'ZMW',
      momo_airtel_number: null,
      momo_mtn_number: null,
      momo_zamtel_number: null,
      security_notice: null,
      security_notice_at: null,
    },
    credentials: {
      shop_id: shopId,
      pin_salt: pinSalt,
      pin_hash: pinHash,
      pin_iterations: iterations,
      recovery_salt: recoverySalt,
      recovery_hash: recoveryHash,
    },
    sessionId,
    trialPhoneHash: usedPhone ? null : phoneHash,
  });

  return { shop, recoveryCode, trialGranted };
}

export async function handleCheckShopUnlockStatus(
  repo: EdgeAuthRepository,
  input: { userId: string; sessionId: string; now?: Date }
): Promise<{
  hasShop: boolean;
  sessionVerified: boolean;
  isLockedOut: boolean;
  lockedUntil: string | null;
  isRecoveryLockedOut: boolean;
  recoveryLockedUntil: string | null;
  pendingPinReset: PendingPinResetSummary | null;
}> {
  const sessionId = requireSessionId(input.sessionId);
  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    return {
      hasShop: false,
      sessionVerified: false,
      isLockedOut: false,
      lockedUntil: null,
      isRecoveryLockedOut: false,
      recoveryLockedUntil: null,
      pendingPinReset: null,
    };
  }
  const [creds, verified, resetReq] = await Promise.all([
    repo.getPinCredentials(shop.id),
    repo.isSessionVerified({ shopId: shop.id, userId: input.userId, sessionId }),
    repo.getActivePinResetRequest(shop.id),
  ]);
  const nowMs = (input.now ?? new Date()).getTime();
  const lockedMs = creds?.locked_until ? Date.parse(creds.locked_until) : 0;
  const isLockedOut = Number.isFinite(lockedMs) && lockedMs > nowMs;

  const recLockedMs = creds?.recovery_locked_until ? Date.parse(creds.recovery_locked_until) : 0;
  const isRecoveryLockedOut = Number.isFinite(recLockedMs) && recLockedMs > nowMs;

  let pendingPinReset: PendingPinResetSummary | null = null;
  if (resetReq && resetReq.status === 'pending_wait') {
    const availableMs = Date.parse(resetReq.available_at);
    const expiresMs = Date.parse(resetReq.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
      pendingPinReset = {
        status: nowMs >= availableMs ? 'ready' : 'pending_wait',
        initiatedAt: resetReq.initiated_at,
        availableAt: resetReq.available_at,
        expiresAt: resetReq.expires_at,
      };
    }
  }

  return {
    hasShop: true,
    sessionVerified: verified,
    isLockedOut,
    lockedUntil: isLockedOut ? creds!.locked_until : null,
    isRecoveryLockedOut,
    recoveryLockedUntil: isRecoveryLockedOut ? creds!.recovery_locked_until : null,
    pendingPinReset,
  };
}

export async function handleUnlockShopSession(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
    pin: string;
    pepper: string;
    now?: Date;
  }
): Promise<{ shop: DomainShopRecord }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);
  if (!isValidFourDigitPin(input.pin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'Enter your 4-digit shop PIN.');
  }

  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(
      404,
      'shop_not_found',
      'No shop is registered for this phone number yet. Create a new shop first.'
    );
  }
  const creds = await repo.getPinCredentials(shop.id);
  if (!creds) {
    throw new EdgeDomainError(
      500,
      'missing_pin_credentials',
      'Shop PIN security record is missing. Contact support.'
    );
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (creds.locked_until) {
    const lockedUntilMs = Date.parse(creds.locked_until);
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      throw new EdgeDomainError(
        429,
        'pin_locked_out',
        `Too many incorrect PIN attempts on a new device. Try again in ${formatRemainingWait(lockedUntilMs - nowMs)} or use your one-time recovery code.`
      );
    }
  }

  const ok = await verifySecretHash(input.pin, creds.pin_salt, creds.pin_hash, {
    pepper,
    iterations: creds.pin_iterations,
  });

  if (!ok) {
    const nextAttempts = creds.failed_attempts + 1;
    const lockoutMs = calculateNewDeviceLockoutMs(nextAttempts);
    const lockedUntil = lockoutMs > 0 ? new Date(nowMs + lockoutMs).toISOString() : null;
    await repo.updatePinAttemptState({
      shopId: shop.id,
      failedAttempts: nextAttempts,
      lockedUntil,
      lastFailedAt: now.toISOString(),
    });
    if (lockoutMs > 0) {
      throw new EdgeDomainError(
        429,
        'pin_locked_out',
        `Incorrect PIN. New-device sign-in is locked for ${formatRemainingWait(lockoutMs)}. You can also unlock with your one-time recovery code.`
      );
    }
    throw new EdgeDomainError(401, 'incorrect_pin', 'Incorrect PIN. Check your 4-digit PIN.');
  }

  if (creds.failed_attempts > 0 || creds.locked_until) {
    await repo.updatePinAttemptState({
      shopId: shop.id,
      failedAttempts: 0,
      lockedUntil: null,
      lastFailedAt: null,
    });
  }
  await repo.markSessionVerified({ shopId: shop.id, userId: input.userId, sessionId });
  return { shop };
}

export async function handleRecoverShopPin(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
    recoveryCode: string;
    newPin: string;
    pepper: string;
    iterations?: number;
    smsPolicy?: Partial<SmsRateLimitPolicy>;
    sendSms?: (params: { toE164: string; message: string }) => Promise<void>;
    now?: Date;
  }
): Promise<{ shop: DomainShopRecord; recoveryCode: string }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);

  if (!isValidFourDigitPin(input.newPin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'Choose a new PIN with exactly 4 numbers.');
  }

  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'No shop found for this phone number.');
  }
  const creds = await repo.getPinCredentials(shop.id);
  if (!creds) {
    throw new EdgeDomainError(
      500,
      'missing_pin_credentials',
      'Shop PIN security record is missing. Contact support.'
    );
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  // Escalating per-shop recovery-code lockout check BEFORE evaluating the code
  if (creds.recovery_locked_until) {
    const recLockedUntilMs = Date.parse(creds.recovery_locked_until);
    if (Number.isFinite(recLockedUntilMs) && recLockedUntilMs > nowMs) {
      throw new EdgeDomainError(
        429,
        'recovery_locked_out',
        `Too many incorrect recovery-code attempts. Try again in ${formatRemainingWait(recLockedUntilMs - nowMs)} or contact support to request a 72-hour verified PIN reset.`
      );
    }
  }

  let canonicalCode: string | null = null;
  try {
    canonicalCode = normalizeRecoveryCode(input.recoveryCode);
  } catch {
    canonicalCode = null;
  }

  const validCode = canonicalCode
    ? await verifySecretHash(canonicalCode, creds.recovery_salt, creds.recovery_hash, {
        pepper,
        domain: RECOVERY_DOMAIN,
        iterations: creds.pin_iterations,
      })
    : false;

  if (!validCode) {
    const nextAttempts = (creds.recovery_failed_attempts ?? 0) + 1;
    const lockoutMs = calculateNewDeviceLockoutMs(nextAttempts);
    const lockedUntil = lockoutMs > 0 ? new Date(nowMs + lockoutMs).toISOString() : null;
    await repo.updateRecoveryAttemptState({
      shopId: shop.id,
      recoveryFailedAttempts: nextAttempts,
      recoveryLockedUntil: lockedUntil,
      recoveryLastFailedAt: now.toISOString(),
    });
    if (lockoutMs > 0) {
      throw new EdgeDomainError(
        429,
        'recovery_locked_out',
        `Incorrect recovery code. Recovery-code entry is locked for ${formatRemainingWait(lockoutMs)}. If you lost both your PIN and recovery code, contact support for a 72-hour PIN reset.`
      );
    }
    throw new EdgeDomainError(
      401,
      'invalid_recovery_code',
      'That recovery code does not match. Check every letter and number.'
    );
  }

  const iterations = input.iterations ?? creds.pin_iterations ?? SERVER_PBKDF2_ITERATIONS;
  const pinSalt = generateSaltHex();
  const pinHash = await deriveSecretHashHex(input.newPin, pinSalt, { pepper, iterations });

  // One-time use: rotate recovery code immediately so the used code cannot be replayed.
  const nextRecoveryCode = generateOneTimeRecoveryCode();
  const recoverySalt = generateSaltHex();
  const recoveryHash = await deriveSecretHashHex(nextRecoveryCode, recoverySalt, {
    pepper,
    domain: RECOVERY_DOMAIN,
    iterations,
  });

  const nowIso = now.toISOString();
  const securityNotice =
    'Security alert: Your one-time recovery code was used to sign in on a new device and change your shop PIN. If this was not you, open Settings and sign out all other devices immediately.';

  await repo.updatePinAndRecoveryCredentials({
    shopId: shop.id,
    pinSalt,
    pinHash,
    pinIterations: iterations,
    recoverySalt,
    recoveryHash,
  });
  await repo.setShopSecurityNotice({
    shopId: shop.id,
    securityNotice,
    nowIso,
  });

  const activeReset = await repo.getActivePinResetRequest(shop.id);
  if (activeReset) {
    await repo.updatePinResetRequestStatus({
      requestId: activeReset.id,
      status: 'cancelled',
      nowIso,
      reason: 'Superseded by valid one-time recovery code reset',
    });
  }

  await repo.markSessionVerified({ shopId: shop.id, userId: input.userId, sessionId });
  await repo.writeAudit({
    action: 'shop_pin_recovered_with_code',
    actorUserId: input.userId,
    shopId: shop.id,
  });

  if (input.sendSms) {
    try {
      await handleCheckAndRecordSmsAllowance(repo, {
        phone: shop.owner_phone,
        purpose: 'recovery_code_notice',
        stage: 'dispatch',
        pepper,
        policy: input.smsPolicy,
        actorUserId: input.userId,
        now,
      });
      await input.sendSms({
        toE164: shop.owner_phone,
        message: `CountUp Security Alert: Your one-time recovery code was used to unlock "${shop.name}" on a new device and change the PIN. If this was not you, open Settings in CountUp immediately to sign out other devices.`,
      });
    } catch {
      // Recovery itself already rotated secrets and posted in-app security_notice;
      // do not roll back valid recovery if carrier SMS gateway is unreachable.
    }
  }

  const updatedShop = (await repo.findShopById(shop.id)) ?? {
    ...shop,
    security_notice: securityNotice,
    security_notice_at: nowIso,
  };
  return { shop: updatedShop, recoveryCode: nextRecoveryCode };
}

export async function handleChangeShopPin(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
    currentPin: string;
    newPin: string;
    pepper: string;
    iterations?: number;
    now?: Date;
  }
): Promise<{ updated: true }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);

  if (!isValidFourDigitPin(input.currentPin) || !isValidFourDigitPin(input.newPin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'PINs must be exactly 4 numbers.');
  }
  if (input.currentPin === input.newPin) {
    throw new EdgeDomainError(400, 'same_pin', 'Choose a PIN different from your current one.');
  }

  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'Shop not found.');
  }

  const verified = await repo.isSessionVerified({
    shopId: shop.id,
    userId: input.userId,
    sessionId,
  });
  if (!verified) {
    throw new EdgeDomainError(
      403,
      'session_not_verified',
      'Unlock this device session with your PIN first.'
    );
  }

  const creds = await repo.getPinCredentials(shop.id);
  if (!creds) {
    throw new EdgeDomainError(
      500,
      'missing_pin_credentials',
      'Shop PIN security record is missing.'
    );
  }

  const matches = await verifySecretHash(input.currentPin, creds.pin_salt, creds.pin_hash, {
    pepper,
    iterations: creds.pin_iterations,
  });
  if (!matches) {
    throw new EdgeDomainError(401, 'incorrect_pin', 'That is not your current PIN.');
  }

  const iterations = input.iterations ?? creds.pin_iterations ?? SERVER_PBKDF2_ITERATIONS;
  const pinSalt = generateSaltHex();
  const pinHash = await deriveSecretHashHex(input.newPin, pinSalt, { pepper, iterations });

  await repo.updatePinAndRecoveryCredentials({
    shopId: shop.id,
    pinSalt,
    pinHash,
    pinIterations: iterations,
  });

  // Changing PIN from an already-trusted device cancels any pending 72-hour reset
  const activeReset = await repo.getActivePinResetRequest(shop.id);
  if (activeReset) {
    await repo.updatePinResetRequestStatus({
      requestId: activeReset.id,
      status: 'cancelled',
      nowIso: (input.now ?? new Date()).toISOString(),
      reason: 'Cancelled automatically when owner changed PIN on verified device',
    });
  }

  return { updated: true };
}

export async function handleRevokeOtherShopSessions(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
  }
): Promise<{ revokedCount: number }> {
  const sessionId = requireSessionId(input.sessionId);
  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'Shop not found.');
  }

  const verified = await repo.isSessionVerified({
    shopId: shop.id,
    userId: input.userId,
    sessionId,
  });
  if (!verified) {
    throw new EdgeDomainError(
      403,
      'session_not_verified',
      'Unlock this device session with your PIN first.'
    );
  }

  const revokedCount = await repo.revokeOtherVerifiedSessions({
    shopId: shop.id,
    keepSessionId: sessionId,
  });

  await repo.writeAudit({
    action: 'shop_revoked_other_sessions',
    actorUserId: input.userId,
    shopId: shop.id,
    metadata: { revoked_count: revokedCount },
  });

  return { revokedCount };
}

export async function handleDeleteShop(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
    confirmationName: string;
    pin: string;
    pepper: string;
    phoneHashSalt?: string;
    iterations?: number;
    now?: Date;
  }
): Promise<{ deleted: true }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);

  if (!isValidFourDigitPin(input.pin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'Enter your 4-digit PIN to confirm deletion.');
  }

  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'Shop not found.');
  }

  const verified = await repo.isSessionVerified({
    shopId: shop.id,
    userId: input.userId,
    sessionId,
  });
  if (!verified) {
    throw new EdgeDomainError(
      403,
      'session_not_verified',
      'Verify this device session before deleting the shop.'
    );
  }

  if (input.confirmationName.trim().toLowerCase() !== shop.name.trim().toLowerCase()) {
    throw new EdgeDomainError(
      400,
      'confirmation_mismatch',
      'Type the exact shop name to confirm permanent deletion.'
    );
  }

  const creds = await repo.getPinCredentials(shop.id);
  if (!creds) {
    throw new EdgeDomainError(
      500,
      'missing_pin_credentials',
      'Shop PIN security record is missing.'
    );
  }

  const matches = await verifySecretHash(input.pin, creds.pin_salt, creds.pin_hash, {
    pepper,
    iterations: creds.pin_iterations,
  });
  if (!matches) {
    throw new EdgeDomainError(401, 'incorrect_pin', 'Incorrect PIN. Shop was not deleted.');
  }

  const phoneHash = await hashPhoneForTrialGuard(shop.owner_phone, pepper, {
    saltHex: input.phoneHashSalt,
    iterations: input.iterations ?? creds.pin_iterations ?? SERVER_PBKDF2_ITERATIONS,
  });
  const existingTrial = await repo.findUsedTrialPhone(phoneHash);
  const wasSuspended = Boolean(
    existingTrial?.was_suspended || shop.is_deactivated || shop.plan_status === 'suspended'
  );
  const nowIso = (input.now ?? new Date()).toISOString();

  await repo.deleteShopAndRetainPhoneHistory({
    shop,
    phoneHash,
    actorUserId: input.userId,
    wasSuspended,
    deletedAtIso: nowIso,
  });

  return { deleted: true };
}

export async function handleVerifyPlatformAdmin(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    email: string | undefined | null;
    emailVerified: boolean;
    aal?: string | null;
    alreadyAdmin: boolean;
    configuredAdminEmail: string;
  }
): Promise<{ isAdmin: true; claimsUpdated: boolean }> {
  if (input.aal !== 'aal2') {
    throw new EdgeDomainError(
      403,
      'mfa_required',
      'Complete two-factor verification (6-digit authenticator code) to access platform administration.'
    );
  }
  if (input.alreadyAdmin) {
    return { isAdmin: true, claimsUpdated: false };
  }
  const allowedEmails = input.configuredAdminEmail
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length === 0) {
    throw new EdgeDomainError(
      500,
      'admin_not_configured',
      'Administrator identity is not configured on the server.'
    );
  }
  const actual = (input.email ?? '').trim().toLowerCase();
  if (!input.emailVerified || !actual || !allowedEmails.includes(actual)) {
    throw new EdgeDomainError(
      403,
      'permission_denied',
      'This account is not authorized for platform administration.'
    );
  }
  await repo.grantPlatformAdminClaim({ userId: input.userId });
  await repo.writeAudit({
    action: 'platform_admin_provisioned',
    actorUserId: input.userId,
    targetUserId: input.userId,
  });
  return { isAdmin: true, claimsUpdated: true };
}

export async function handleAdminResetPinLockout(
  repo: EdgeAuthRepository,
  input: {
    adminUserId: string;
    isPlatformAdmin: boolean;
    aal?: string | null;
    shopId: string;
    identityCheckNote: string;
    now?: Date;
  }
): Promise<{ reset: true }> {
  requireAdminMfa(input.isPlatformAdmin, input.aal);

  const cleanShopId = input.shopId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanShopId)) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Choose a valid shop.');
  }

  let cleanNote: string;
  try {
    cleanNote = validateIdentityCheckNote(input.identityCheckNote);
  } catch (err) {
    throw new EdgeDomainError(
      400,
      'invalid_identity_note',
      err instanceof Error ? err.message : 'Enter the identity verification note.'
    );
  }

  const shop = await repo.findShopById(cleanShopId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'Shop not found.');
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const securityNotice =
    'Security alert: Platform support reset your shop’s new-device PIN lockout after an identity check. If you did not request this, change your PIN immediately.';

  await repo.resetPinLockoutWithNotice({
    shopId: shop.id,
    adminUserId: input.adminUserId,
    identityCheckNote: cleanNote,
    securityNotice,
    nowIso,
  });

  return { reset: true };
}

/**
 * Initiates an admin-approved 72-hour PIN reset for an owner who lost BOTH
 * their 4-digit PIN and their one-time recovery code:
 *   1. Requires MFA (`aal2`) platform_admin + recorded identity check note.
 *   2. Enforces a 72-hour waiting period (`available_at = now + 72h`).
 *   3. Places an urgent `security_notice` on `shops` so the existing shop phone
 *      is alerted on next sync and can cancel if unauthorized.
 *   4. Sends a warning SMS to `shop.owner_phone` during the wait.
 */
export async function handleAdminInitiatePinReset72h(
  repo: EdgeAuthRepository,
  input: {
    adminUserId: string;
    isPlatformAdmin: boolean;
    aal?: string | null;
    shopId: string;
    identityCheckNote: string;
    pepper: string;
    smsPolicy?: Partial<SmsRateLimitPolicy>;
    sendSms: (params: { toE164: string; message: string }) => Promise<void>;
    now?: Date;
  }
): Promise<{
  initiated: true;
  availableAt: string;
  expiresAt: string;
}> {
  requireAdminMfa(input.isPlatformAdmin, input.aal);
  const pepper = requirePepper(input.pepper);

  const cleanShopId = input.shopId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanShopId)) {
    throw new EdgeDomainError(400, 'invalid_shop_id', 'Choose a valid shop.');
  }

  let cleanNote: string;
  try {
    cleanNote = validateIdentityCheckNote(input.identityCheckNote);
  } catch (err) {
    throw new EdgeDomainError(
      400,
      'invalid_identity_note',
      err instanceof Error ? err.message : 'Enter the identity verification note.'
    );
  }

  const shop = await repo.findShopById(cleanShopId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'Shop not found.');
  }

  const now = input.now ?? new Date();
  const initiatedAtIso = now.toISOString();
  const availableAt = new Date(now.getTime() + PIN_RESET_WAITING_PERIOD_MS);
  const availableAtIso = availableAt.toISOString();
  const expiresAtIso = new Date(
    availableAt.getTime() + PIN_RESET_COMPLETION_WINDOW_MS
  ).toISOString();

  // Check global daily SMS cap & send owner warning SMS during the wait
  await handleCheckAndRecordSmsAllowance(repo, {
    phone: shop.owner_phone,
    purpose: 'pin_reset_notice',
    stage: 'dispatch',
    pepper,
    policy: input.smsPolicy,
    actorUserId: input.adminUserId,
    now,
  });

  const smsMessage = `CountUp Security Alert: Support approved a 72-hour PIN reset for "${shop.name}". A new PIN can be set after ${availableAtIso.slice(0, 16).replace('T', ' ')} UTC. If you did NOT request this, open CountUp on your shop phone to cancel immediately.`;
  await input.sendSms({
    toE164: shop.owner_phone,
    message: smsMessage,
  });

  const deviceSecurityNotice =
    'URGENT SECURITY ALERT: Support approved a 72-hour shop PIN reset. If you still have your shop phone and did NOT request this, tap "Cancel Reset" immediately or change your PIN.';

  const resetReq = await repo.upsertPendingPinResetRequest({
    shopId: shop.id,
    adminUserId: input.adminUserId,
    identityCheckNote: cleanNote,
    initiatedAtIso,
    availableAtIso,
    expiresAtIso,
    smsNotifiedAtIso: initiatedAtIso,
  });

  await repo.setShopSecurityNotice({
    shopId: shop.id,
    securityNotice: deviceSecurityNotice,
    nowIso: initiatedAtIso,
  });

  await repo.writeAudit({
    action: 'shop_pin_reset_initiated_72h',
    actorUserId: input.adminUserId,
    shopId: shop.id,
    reason: cleanNote,
    metadata: {
      reset_request_id: resetReq.id,
      available_at: availableAtIso,
      expires_at: expiresAtIso,
    },
  });

  return {
    initiated: true,
    availableAt: availableAtIso,
    expiresAt: expiresAtIso,
  };
}

export async function handleCompleteApprovedPinReset(
  repo: EdgeAuthRepository,
  input: {
    userId: string;
    sessionId: string;
    newPin: string;
    pepper: string;
    iterations?: number;
    now?: Date;
  }
): Promise<{ shop: DomainShopRecord; recoveryCode: string }> {
  const pepper = requirePepper(input.pepper);
  const sessionId = requireSessionId(input.sessionId);

  if (!isValidFourDigitPin(input.newPin)) {
    throw new EdgeDomainError(400, 'invalid_pin', 'Choose a new PIN with exactly 4 numbers.');
  }

  const shop = await repo.findShopByOwnerUserId(input.userId);
  if (!shop) {
    throw new EdgeDomainError(404, 'shop_not_found', 'No shop found for this phone number.');
  }

  const creds = await repo.getPinCredentials(shop.id);
  if (!creds) {
    throw new EdgeDomainError(
      500,
      'missing_pin_credentials',
      'Shop PIN security record is missing.'
    );
  }

  const resetReq = await repo.getActivePinResetRequest(shop.id);
  if (!resetReq || resetReq.status !== 'pending_wait') {
    throw new EdgeDomainError(
      404,
      'no_pending_pin_reset',
      'No approved PIN reset is pending for this shop. Contact support if you lost both your PIN and recovery code.'
    );
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const availableMs = Date.parse(resetReq.available_at);
  const expiresMs = Date.parse(resetReq.expires_at);

  if (nowMs < availableMs) {
    throw new EdgeDomainError(
      403,
      'pin_reset_waiting_period',
      `Your approved 72-hour PIN reset safety waiting period is still active. You can set a new PIN in ${formatRemainingWait(availableMs - nowMs)} (after ${resetReq.available_at}).`
    );
  }

  if (nowMs > expiresMs) {
    await repo.updatePinResetRequestStatus({
      requestId: resetReq.id,
      status: 'cancelled',
      nowIso,
      reason: 'Completion window expired',
    });
    throw new EdgeDomainError(
      410,
      'pin_reset_expired',
      'The 48-hour completion window for your approved PIN reset has expired. Contact support to request a new one.'
    );
  }

  const iterations = input.iterations ?? creds.pin_iterations ?? SERVER_PBKDF2_ITERATIONS;
  const pinSalt = generateSaltHex();
  const pinHash = await deriveSecretHashHex(input.newPin, pinSalt, { pepper, iterations });

  const nextRecoveryCode = generateOneTimeRecoveryCode();
  const recoverySalt = generateSaltHex();
  const recoveryHash = await deriveSecretHashHex(nextRecoveryCode, recoverySalt, {
    pepper,
    domain: RECOVERY_DOMAIN,
    iterations,
  });

  const completionNotice =
    'Security alert: Your 72-hour support-approved PIN reset was completed on a new device. If this was not you, open Settings and sign out all other devices immediately.';

  await repo.updatePinAndRecoveryCredentials({
    shopId: shop.id,
    pinSalt,
    pinHash,
    pinIterations: iterations,
    recoverySalt,
    recoveryHash,
  });
  await repo.updatePinResetRequestStatus({
    requestId: resetReq.id,
    status: 'completed',
    nowIso,
  });
  await repo.setShopSecurityNotice({
    shopId: shop.id,
    securityNotice: completionNotice,
    nowIso,
  });
  await repo.markSessionVerified({ shopId: shop.id, userId: input.userId, sessionId });
  await repo.writeAudit({
    action: 'shop_pin_reset_completed_72h',
    actorUserId: input.userId,
    shopId: shop.id,
    metadata: { reset_request_id: resetReq.id },
  });

  const updatedShop = (await repo.findShopById(shop.id)) ?? {
    ...shop,
    security_notice: completionNotice,
    security_notice_at: nowIso,
  };
  return { shop: updatedShop, recoveryCode: nextRecoveryCode };
}
