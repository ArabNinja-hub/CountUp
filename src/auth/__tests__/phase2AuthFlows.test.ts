import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainPinCredentials,
  DomainPinResetRequest,
  DomainShopRecord,
  DomainUsedTrialPhone,
  EdgeAuthRepository,
  handleAdminInitiatePinReset72h,
  handleAdminResetPinLockout,
  handleChangeShopPin,
  handleCheckAndRecordSmsAllowance,
  handleCheckShopUnlockStatus,
  handleCompleteApprovedPinReset,
  handleDeleteShop,
  handleRecoverShopPin,
  handleRegisterShop,
  handleRevokeOtherShopSessions,
  handleUnlockShopSession,
  handleVerifyPlatformAdmin,
  PIN_RESET_WAITING_PERIOD_MS,
} from '../../../shared/edgeAuthDomain';
import {
  LOCAL_PBKDF2_ITERATIONS,
  normalizeZambianPhoneE164,
  SERVER_PBKDF2_ITERATIONS,
} from '../../../shared/authSecurity';
import {
  measureLocalPbkdf2UnlockMs,
  saveLocalPinRecord,
  verifyLocalPin,
} from '../../utils/pinLock';
import { createTestSupabaseDb, TestIdentity } from '../../data/__tests__/supabaseTestHarness';

const PEPPER = 'test-server-secret-pin-pepper-at-least-16-chars';
const FAST_ITERATIONS = 100_000;

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => {
        store.set(key, String(val));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (idx: number) => Array.from(store.keys())[idx] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

function toIso(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function mapShopRow(row: Record<string, unknown>): DomainShopRecord {
  return {
    ...(row as unknown as DomainShopRecord),
    trial_ends_at: toIso(row.trial_ends_at),
    plan_expiry_at: toIso(row.plan_expiry_at),
    sales_access_until: toIso(row.sales_access_until),
    subscription_started_at: row.subscription_started_at
      ? toIso(row.subscription_started_at)
      : null,
    security_notice_at: row.security_notice_at ? toIso(row.security_notice_at) : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function mapCredsRow(row: Record<string, unknown>): DomainPinCredentials {
  return {
    ...(row as unknown as DomainPinCredentials),
    failed_attempts: Number(row.failed_attempts ?? 0),
    locked_until: row.locked_until ? toIso(row.locked_until) : null,
    last_failed_at: row.last_failed_at ? toIso(row.last_failed_at) : null,
    recovery_failed_attempts: Number(row.recovery_failed_attempts ?? 0),
    recovery_locked_until: row.recovery_locked_until ? toIso(row.recovery_locked_until) : null,
    recovery_last_failed_at: row.recovery_last_failed_at
      ? toIso(row.recovery_last_failed_at)
      : null,
  };
}

function mapPinResetRow(row: Record<string, unknown>): DomainPinResetRequest {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    initiated_by_admin_id: row.initiated_by_admin_id ? String(row.initiated_by_admin_id) : null,
    identity_check_note: String(row.identity_check_note),
    status: row.status as DomainPinResetRequest['status'],
    initiated_at: toIso(row.initiated_at),
    available_at: toIso(row.available_at),
    expires_at: toIso(row.expires_at),
    sms_notified_at: row.sms_notified_at ? toIso(row.sms_notified_at) : null,
    completed_at: row.completed_at ? toIso(row.completed_at) : null,
    cancelled_at: row.cancelled_at ? toIso(row.cancelled_at) : null,
    cancelled_by_reason: row.cancelled_by_reason ? String(row.cancelled_by_reason) : null,
  };
}

describe('Phase 2 + All 9 Follow-Ups: Auth, SIM-Swap, MFA, SMS Caps & PIN Security (Real PostgreSQL 17)', () => {
  let harness: Awaited<ReturnType<typeof createTestSupabaseDb>>;
  let repo: EdgeAuthRepository;
  let failNextSmsDbQuery = false;

  beforeAll(async () => {
    installMemoryLocalStorage();
    harness = await createTestSupabaseDb();

    repo = {
      async findShopByOwnerUserId(userId) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shops WHERE owner_user_id = $1 LIMIT 1`,
            [userId]
          );
          return res.rows[0] ? mapShopRow(res.rows[0]) : null;
        });
      },

      async findShopByPhone(ownerPhone) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shops WHERE owner_phone = $1 LIMIT 1`,
            [ownerPhone]
          );
          return res.rows[0] ? mapShopRow(res.rows[0]) : null;
        });
      },

      async findShopById(shopId) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shops WHERE id = $1 LIMIT 1`,
            [shopId]
          );
          return res.rows[0] ? mapShopRow(res.rows[0]) : null;
        });
      },

      async findUsedTrialPhone(phoneHash) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.used_trial_phones WHERE phone_hash = $1 LIMIT 1`,
            [phoneHash]
          );
          if (!res.rows[0]) return null;
          return {
            phone_hash: String(res.rows[0].phone_hash),
            first_shop_id: String(res.rows[0].first_shop_id),
            first_user_id: res.rows[0].first_user_id ? String(res.rows[0].first_user_id) : null,
            was_suspended: Boolean(res.rows[0].was_suspended),
            last_deleted_at: res.rows[0].last_deleted_at
              ? toIso(res.rows[0].last_deleted_at)
              : null,
          } satisfies DomainUsedTrialPhone;
        });
      },

      async createShopRegistration({ shop, credentials, sessionId, trialPhoneHash }) {
        return harness.asServiceRole(async (tx) => {
          if (trialPhoneHash) {
            await tx.query(
              `INSERT INTO public.used_trial_phones (phone_hash, first_shop_id, first_user_id, was_suspended)
               VALUES ($1, $2, $3, false)`,
              [trialPhoneHash, shop.id, shop.owner_user_id]
            );
          }

          const inserted = await tx.query<Record<string, unknown>>(
            `INSERT INTO public.shops (
               id, owner_user_id, name, owner_phone, plan_status, plan_type,
               trial_ends_at, plan_expiry_at, sales_access_until,
               status_before_suspension, is_deactivated, currency
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING *`,
            [
              shop.id,
              shop.owner_user_id,
              shop.name,
              shop.owner_phone,
              shop.plan_status,
              shop.plan_type,
              shop.trial_ends_at,
              shop.plan_expiry_at,
              shop.sales_access_until,
              shop.status_before_suspension,
              shop.is_deactivated,
              shop.currency,
            ]
          );

          await tx.query(
            `INSERT INTO public.shop_pin_credentials (
               shop_id, pin_salt, pin_hash, pin_iterations, recovery_salt, recovery_hash
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              credentials.shop_id,
              credentials.pin_salt,
              credentials.pin_hash,
              credentials.pin_iterations,
              credentials.recovery_salt,
              credentials.recovery_hash,
            ]
          );

          await tx.query(
            `INSERT INTO public.shop_verified_sessions (shop_id, session_id, user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (shop_id, session_id) DO UPDATE SET verified_at = now()`,
            [shop.id, sessionId, shop.owner_user_id]
          );

          return mapShopRow(inserted.rows[0]);
        });
      },

      async getPinCredentials(shopId) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shop_pin_credentials WHERE shop_id = $1 LIMIT 1`,
            [shopId]
          );
          return res.rows[0] ? mapCredsRow(res.rows[0]) : null;
        });
      },

      async updatePinAttemptState({ shopId, failedAttempts, lockedUntil, lastFailedAt }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE public.shop_pin_credentials
             SET failed_attempts = $2, locked_until = $3, last_failed_at = $4
             WHERE shop_id = $1`,
            [shopId, failedAttempts, lockedUntil, lastFailedAt]
          );
        });
      },

      async updateRecoveryAttemptState({
        shopId,
        recoveryFailedAttempts,
        recoveryLockedUntil,
        recoveryLastFailedAt,
      }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE public.shop_pin_credentials
             SET recovery_failed_attempts = $2,
                 recovery_locked_until = $3,
                 recovery_last_failed_at = $4
             WHERE shop_id = $1`,
            [shopId, recoveryFailedAttempts, recoveryLockedUntil, recoveryLastFailedAt]
          );
        });
      },

      async updatePinAndRecoveryCredentials({
        shopId,
        pinSalt,
        pinHash,
        pinIterations,
        recoverySalt,
        recoveryHash,
      }) {
        await harness.asServiceRole(async (tx) => {
          if (recoverySalt && recoveryHash) {
            await tx.query(
              `UPDATE public.shop_pin_credentials
               SET pin_salt = $2, pin_hash = $3, pin_iterations = $4,
                   recovery_salt = $5, recovery_hash = $6,
                   failed_attempts = 0, locked_until = NULL, last_failed_at = NULL,
                   recovery_failed_attempts = 0, recovery_locked_until = NULL, recovery_last_failed_at = NULL
               WHERE shop_id = $1`,
              [shopId, pinSalt, pinHash, pinIterations, recoverySalt, recoveryHash]
            );
          } else {
            await tx.query(
              `UPDATE public.shop_pin_credentials
               SET pin_salt = $2, pin_hash = $3, pin_iterations = $4,
                   failed_attempts = 0, locked_until = NULL, last_failed_at = NULL
               WHERE shop_id = $1`,
              [shopId, pinSalt, pinHash, pinIterations]
            );
          }
        });
      },

      async setShopSecurityNotice({ shopId, securityNotice, nowIso }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE public.shops SET security_notice = $2, security_notice_at = $3 WHERE id = $1`,
            [shopId, securityNotice, nowIso]
          );
        });
      },

      async markSessionVerified({ shopId, userId, sessionId }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `INSERT INTO public.shop_verified_sessions (shop_id, session_id, user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (shop_id, session_id) DO UPDATE SET verified_at = now()`,
            [shopId, sessionId, userId]
          );
        });
      },

      async isSessionVerified({ shopId, userId, sessionId }) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query(
            `SELECT 1 FROM public.shop_verified_sessions
             WHERE shop_id = $1 AND user_id = $2 AND session_id = $3 LIMIT 1`,
            [shopId, userId, sessionId]
          );
          return res.rows.length > 0;
        });
      },

      async revokeOtherVerifiedSessions({ shopId, keepSessionId }) {
        return harness.asServiceRole(async (tx) => {
          const deletedVerified = await tx.query(
            `DELETE FROM public.shop_verified_sessions
             WHERE shop_id = $1 AND session_id <> $2
             RETURNING session_id`,
            [shopId, keepSessionId]
          );
          return deletedVerified.rows.length;
        });
      },

      async deleteShopAndRetainPhoneHistory({
        shop,
        phoneHash,
        actorUserId,
        wasSuspended,
        deletedAtIso,
      }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `INSERT INTO public.used_trial_phones (phone_hash, first_shop_id, first_user_id, was_suspended, last_deleted_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (phone_hash) DO UPDATE
               SET was_suspended = $4, last_deleted_at = $5`,
            [phoneHash, shop.id, shop.owner_user_id, wasSuspended, deletedAtIso]
          );
          await tx.query(
            `INSERT INTO public.platform_audit (action, actor_user_id, shop_id, metadata)
             VALUES ('shop_deleted', $1, $2, $3::jsonb)`,
            [actorUserId, shop.id, JSON.stringify({ was_suspended: wasSuspended })]
          );
          await tx.query(`DELETE FROM public.shops WHERE id = $1`, [shop.id]);
        });
      },

      async grantPlatformAdminClaim({ userId }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE auth.users
             SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"platform_admin": true}'::jsonb
             WHERE id = $1`,
            [userId]
          );
        });
      },

      async resetPinLockoutWithNotice({
        shopId,
        adminUserId,
        identityCheckNote,
        securityNotice,
        nowIso,
      }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE public.shop_pin_credentials
             SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL,
                 recovery_failed_attempts = 0, recovery_locked_until = NULL, recovery_last_failed_at = NULL
             WHERE shop_id = $1`,
            [shopId]
          );
          await tx.query(
            `UPDATE public.shops
             SET security_notice = $2, security_notice_at = $3
             WHERE id = $1`,
            [shopId, securityNotice, nowIso]
          );
          await tx.query(
            `INSERT INTO public.platform_audit (action, actor_user_id, shop_id, reason, metadata)
             VALUES ('shop_pin_lockout_reset', $1, $2, $3, $4::jsonb)`,
            [
              adminUserId,
              shopId,
              identityCheckNote,
              JSON.stringify({ identity_check_note: identityCheckNote }),
            ]
          );
        });
      },

      async getActivePinResetRequest(shopId) {
        return harness.asServiceRole(async (tx) => {
          const res = await tx.query<Record<string, unknown>>(
            `SELECT * FROM public.shop_pin_reset_requests
             WHERE shop_id = $1 AND status = 'pending_wait'
             ORDER BY initiated_at DESC LIMIT 1`,
            [shopId]
          );
          return res.rows[0] ? mapPinResetRow(res.rows[0]) : null;
        });
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
        return harness.asServiceRole(async (tx) => {
          await tx.query(
            `UPDATE public.shop_pin_reset_requests
             SET status = 'cancelled', cancelled_at = $2, cancelled_by_reason = 'Superseded'
             WHERE shop_id = $1 AND status = 'pending_wait'`,
            [shopId, initiatedAtIso]
          );
          const inserted = await tx.query<Record<string, unknown>>(
            `INSERT INTO public.shop_pin_reset_requests (
               shop_id, initiated_by_admin_id, identity_check_note,
               status, initiated_at, available_at, expires_at, sms_notified_at
             ) VALUES ($1, $2, $3, 'pending_wait', $4, $5, $6, $7)
             RETURNING *`,
            [
              shopId,
              adminUserId,
              identityCheckNote,
              initiatedAtIso,
              availableAtIso,
              expiresAtIso,
              smsNotifiedAtIso,
            ]
          );
          return mapPinResetRow(inserted.rows[0]);
        });
      },

      async updatePinResetRequestStatus({ requestId, status, nowIso, reason }) {
        await harness.asServiceRole(async (tx) => {
          if (status === 'completed') {
            await tx.query(
              `UPDATE public.shop_pin_reset_requests
               SET status = 'completed', completed_at = $2
               WHERE id = $1`,
              [requestId, nowIso]
            );
          } else {
            await tx.query(
              `UPDATE public.shop_pin_reset_requests
               SET status = 'cancelled', cancelled_at = $2, cancelled_by_reason = $3
               WHERE id = $1`,
              [requestId, nowIso, reason ?? null]
            );
          }
        });
      },

      async getSmsUsageCounts({ phoneHash, ipHash, since15mIso, since24hIso, dayUtc }) {
        if (failNextSmsDbQuery) {
          failNextSmsDbQuery = false;
          throw new Error('Simulated sms_rate_events database outage');
        }
        return harness.asServiceRole(async (tx) => {
          const phone15mRes = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM public.sms_rate_events
             WHERE phone_hash = $1 AND blocked = false AND created_at >= $2`,
            [phoneHash, since15mIso]
          );
          const phone24hRes = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM public.sms_rate_events
             WHERE phone_hash = $1 AND blocked = false AND created_at >= $2`,
            [phoneHash, since24hIso]
          );
          let ip15mCount = 0;
          let ip24hCount = 0;
          if (ipHash) {
            const ip15Res = await tx.query<{ cnt: string }>(
              `SELECT COUNT(*)::text AS cnt FROM public.sms_rate_events
               WHERE ip_hash = $1 AND blocked = false AND created_at >= $2`,
              [ipHash, since15mIso]
            );
            const ip24Res = await tx.query<{ cnt: string }>(
              `SELECT COUNT(*)::text AS cnt FROM public.sms_rate_events
               WHERE ip_hash = $1 AND blocked = false AND created_at >= $2`,
              [ipHash, since24hIso]
            );
            ip15mCount = Number(ip15Res.rows[0]?.cnt ?? 0);
            ip24hCount = Number(ip24Res.rows[0]?.cnt ?? 0);
          }
          const globalDayRes = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM public.sms_rate_events
             WHERE blocked = false AND day_utc = $1::date`,
            [dayUtc]
          );
          return {
            dailySentCount: Number(globalDayRes.rows[0]?.cnt ?? 0),
            phone15mCount: Number(phone15mRes.rows[0]?.cnt ?? 0),
            phone24hCount: Number(phone24hRes.rows[0]?.cnt ?? 0),
            ip15mCount,
            ip24hCount,
          };
        });
      },

      async claimRecentOtpPrecheck({ phoneHash, sinceIso }) {
        return harness.asServiceRole(async (tx) => {
          const found = await tx.query<{ id: string }>(
            `SELECT id::text AS id FROM public.sms_rate_events
             WHERE phone_hash = $1
               AND purpose = 'otp'
               AND blocked = false
               AND block_reason = 'precheck_pending'
               AND created_at >= $2
             ORDER BY created_at DESC LIMIT 1`,
            [phoneHash, sinceIso]
          );
          if (!found.rows[0]) return false;
          await tx.query(
            `UPDATE public.sms_rate_events SET block_reason = 'dispatched' WHERE id = $1::bigint`,
            [found.rows[0].id]
          );
          return true;
        });
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
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `INSERT INTO public.sms_rate_events (
               phone_hash, ip_hash, purpose, blocked, block_reason, day_utc, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6::date, $7)`,
            [phoneHash, ipHash, purpose, blocked, blockReason, dayUtc, createdAtIso]
          );
        });
      },

      async upsertPlatformAlert({ alertKey, severity, category, title, detail, metadata }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `INSERT INTO public.platform_alerts (
               alert_key, severity, category, title, detail, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (alert_key) DO UPDATE
               SET severity = EXCLUDED.severity,
                   category = EXCLUDED.category,
                   title = EXCLUDED.title,
                   detail = EXCLUDED.detail,
                   metadata = EXCLUDED.metadata,
                   resolved_at = NULL`,
            [alertKey, severity, category, title, detail, JSON.stringify(metadata ?? {})]
          );
        });
      },

      async writeAudit({ action, actorUserId, targetUserId, shopId, reason, metadata }) {
        await harness.asServiceRole(async (tx) => {
          await tx.query(
            `INSERT INTO public.platform_audit (action, actor_user_id, target_user_id, shop_id, reason, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              action,
              actorUserId ?? null,
              targetUserId ?? null,
              shopId ?? null,
              reason ?? null,
              JSON.stringify(metadata ?? {}),
            ]
          );
        });
      },
    };
  });

  afterAll(async () => {
    await harness.close();
  });

  async function issueSessionClaims(
    user: TestIdentity,
    sessionId: string,
    aal: 'aal1' | 'aal2' = 'aal1'
  ): Promise<TestIdentity> {
    const res = await harness.db.query<{ hooked: { claims: Record<string, unknown> } }>(
      `SELECT public.custom_access_token_hook($1::jsonb) AS hooked`,
      [
        JSON.stringify({
          user_id: user.id,
          claims: {
            sub: user.id,
            role: 'authenticated',
            aal,
            session_id: sessionId,
            phone: user.phone,
            email: user.email,
            app_metadata: user.appMetadata ?? {},
          },
        }),
      ]
    );
    const nextClaims = res.rows[0].hooked.claims;
    return {
      ...user,
      aal,
      appMetadata: (nextClaims.app_metadata as Record<string, unknown>) ?? {},
    };
  }

  it('normalizes MTN (096/076), Airtel (097/077), and Zamtel (095/075) numbers and verifies PBKDF2 constants & benchmark helper', async () => {
    expect(normalizeZambianPhoneE164('096 123 4567')).toBe('+260961234567');
    expect(normalizeZambianPhoneE164('0761234567')).toBe('+260761234567');
    expect(normalizeZambianPhoneE164('+260 977-888-999')).toBe('+260977888999');
    expect(normalizeZambianPhoneE164('0771234567')).toBe('+260771234567');
    expect(normalizeZambianPhoneE164('0955111222')).toBe('+260955111222');
    expect(normalizeZambianPhoneE164('260755111222')).toBe('+260755111222');
    expect(() => normalizeZambianPhoneE164('0911234567')).toThrow(/Zambian mobile number/i);

    // Follow-up #8: Explicit server & local PBKDF2 iteration counts + unlock benchmark
    expect(SERVER_PBKDF2_ITERATIONS).toBe(210_000);
    expect(LOCAL_PBKDF2_ITERATIONS).toBe(120_000);
    const measured = await measureLocalPbkdf2UnlockMs(10_000);
    expect(measured.iterations).toBe(10_000);
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('Follow-ups #2 & #7: binds PIN verification strictly to session_id (preserving on refresh, isolating concurrent sessions) and revokes all other sessions', async () => {
    const owner = await harness.createAuthUser({ phone: '+260971000111' });

    const registered = await handleRegisterShop(repo, {
      userId: owner.id,
      verifiedPhone: owner.phone,
      sessionId: 'device-1-session',
      shopName: 'Chilenje Corner Store',
      pin: '4826',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
    });

    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.items (id, shop_id, name, selling_price_ngwee, quantity, low_stock_threshold)
         VALUES ('item-1', $1, '25kg Roller Meal', 22000, 14, 3)`,
        [registered.shop.id]
      );
    });

    // 1. Token refresh on device-1-session (same session_id) preserves shop_id binding
    const device1Initial = await issueSessionClaims(owner, 'device-1-session');
    const device1Refreshed = await issueSessionClaims(owner, 'device-1-session');
    expect(device1Initial.appMetadata?.shop_id).toBe(registered.shop.id);
    expect(device1Refreshed.appMetadata?.shop_id).toBe(registered.shop.id);

    // 2. Concurrent session for the SAME user (`attacker-session`) does NOT inherit PIN verification
    const attackerIdentity = await issueSessionClaims(owner, 'attacker-session');
    expect(attackerIdentity.appMetadata?.shop_id).toBeUndefined();
    expect(attackerIdentity.appMetadata?.pending_pin_verification).toBe(true);

    const leakedRows = await harness.asUser(attackerIdentity, async (tx) => {
      const shops = await tx.query(`SELECT id FROM public.shops`);
      const items = await tx.query(`SELECT id FROM public.items`);
      return [...shops.rows, ...items.rows];
    });
    expect(leakedRows).toHaveLength(0);

    // 3. Legitimate second phone (`device-2-session`) unlocks with PIN -> now both device-1 and device-2 are verified
    await handleUnlockShopSession(repo, {
      userId: owner.id,
      sessionId: 'device-2-session',
      pin: '4826',
      pepper: PEPPER,
    });
    expect((await issueSessionClaims(owner, 'device-2-session')).appMetadata?.shop_id).toBe(
      registered.shop.id
    );

    // 4. Follow-up #7: Owner taps "Sign out all other devices" on device-1-session
    const revoked = await handleRevokeOtherShopSessions(repo, {
      userId: owner.id,
      sessionId: 'device-1-session',
    });
    expect(revoked.revokedCount).toBe(1);

    // device-1 stays verified; device-2 immediately loses shop_id on next token refresh!
    expect((await issueSessionClaims(owner, 'device-1-session')).appMetadata?.shop_id).toBe(
      registered.shop.id
    );
    expect(
      (await issueSessionClaims(owner, 'device-2-session')).appMetadata?.shop_id
    ).toBeUndefined();
  });

  it('Follow-ups #4 & #9: enforces escalating per-shop lockout on recovery-code attempts and posts a security notice to existing devices when recovery succeeds', async () => {
    localStorage.clear();
    const owner = await harness.createAuthUser({ phone: '+260962000222' });
    const now = new Date('2026-11-20T09:00:00.000Z');

    const { shop, recoveryCode } = await handleRegisterShop(repo, {
      userId: owner.id,
      verifiedPhone: owner.phone,
      sessionId: 'trusted-session',
      shopName: 'Kalingalinga Groceries',
      pin: '1357',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
      now,
    });

    await saveLocalPinRecord(shop.id, '1357', { iterations: FAST_ITERATIONS });

    for (let i = 1; i <= 5; i += 1) {
      await handleUnlockShopSession(repo, {
        userId: owner.id,
        sessionId: 'new-phone-session',
        pin: '0000',
        pepper: PEPPER,
        now,
      }).catch(() => undefined);
    }

    expect((await verifyLocalPin(shop.id, '1357')).unlocked).toBe(true);

    // Follow-up #4a: 5 wrong recovery codes trigger escalating per-shop recovery lockout
    for (let i = 1; i <= 4; i += 1) {
      await expect(
        handleRecoverShopPin(repo, {
          userId: owner.id,
          sessionId: 'new-phone-session',
          recoveryCode: 'CU-WRNG-WRNG-WRNG',
          newPin: '9753',
          pepper: PEPPER,
          iterations: FAST_ITERATIONS,
          now,
        })
      ).rejects.toThrow(/does not match/i);
    }
    await expect(
      handleRecoverShopPin(repo, {
        userId: owner.id,
        sessionId: 'new-phone-session',
        recoveryCode: 'CU-WRNG-WRNG-WRNG',
        newPin: '9753',
        pepper: PEPPER,
        iterations: FAST_ITERATIONS,
        now,
      })
    ).rejects.toThrow(/locked/i);

    // Even the REAL recovery code is blocked during the recovery lockout window (2 min into 5-min cooldown)
    await expect(
      handleRecoverShopPin(repo, {
        userId: owner.id,
        sessionId: 'new-phone-session',
        recoveryCode,
        newPin: '9753',
        pepper: PEPPER,
        iterations: FAST_ITERATIONS,
        now: new Date(now.getTime() + 2 * 60_000),
      })
    ).rejects.toThrow(/Too many incorrect recovery/i);

    // After the cooldown passes, the real recovery code succeeds, rotates, and posts security_notice!
    const afterCooldown = new Date(now.getTime() + 31 * 60_000);
    const recovered = await handleRecoverShopPin(repo, {
      userId: owner.id,
      sessionId: 'new-phone-session',
      recoveryCode: recoveryCode.toLowerCase().replace(/-/g, ''),
      newPin: '9753',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
      now: afterCooldown,
    });
    expect(recovered.recoveryCode).not.toBe(recoveryCode);

    // Follow-up #9: Existing device sees security_notice warning that a recovery code was used
    const existingDeviceShop = await repo.findShopById(shop.id);
    expect(existingDeviceShop?.security_notice).toMatch(/recovery code/i);

    await expect(
      handleChangeShopPin(repo, {
        userId: owner.id,
        sessionId: 'new-phone-session',
        currentPin: '9753',
        newPin: '8642',
        pepper: PEPPER,
        iterations: FAST_ITERATIONS,
      })
    ).resolves.toEqual({ updated: true });
  });

  it('Follow-ups #4 & #5: enforces TOTP MFA (aal2) on platform_admin actions and enforces the 72-hour waiting period, owner SMS, and cancellation on admin-approved PIN reset', async () => {
    const owner = await harness.createAuthUser({ phone: '+260953000333' });
    const admin = await harness.createAuthUser({
      email: 'admin@countup.zm',
      emailVerified: true,
    });

    // Follow-up #5: Platform admin verification & privileged actions REJECT aal1 and REQUIRE aal2
    await expect(
      handleVerifyPlatformAdmin(repo, {
        userId: admin.id,
        email: admin.email,
        emailVerified: true,
        alreadyAdmin: false,
        aal: 'aal1',
        configuredAdminEmail: 'admin@countup.zm',
      })
    ).rejects.toThrow(/two-factor/i);

    const verifiedAdmin = await handleVerifyPlatformAdmin(repo, {
      userId: admin.id,
      email: admin.email,
      emailVerified: true,
      alreadyAdmin: false,
      aal: 'aal2',
      configuredAdminEmail: 'admin@countup.zm',
    });
    expect(verifiedAdmin).toEqual({ isAdmin: true, claimsUpdated: true });

    const { shop } = await handleRegisterShop(repo, {
      userId: owner.id,
      verifiedPhone: owner.phone,
      sessionId: 'owner-session',
      shopName: 'Matero Hardware',
      pin: '2580',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
    });

    const t0 = new Date('2026-11-20T10:00:00.000Z');
    const note = 'Video-called owner, verified NRC and last 3 supplier deliveries.';

    // Admin lockout reset rejects aal1, succeeds with aal2
    await expect(
      handleAdminResetPinLockout(repo, {
        adminUserId: admin.id,
        isPlatformAdmin: true,
        aal: 'aal1',
        shopId: shop.id,
        identityCheckNote: note,
        now: t0,
      })
    ).rejects.toThrow(/Multi-factor authentication/i);

    await expect(
      handleAdminResetPinLockout(repo, {
        adminUserId: admin.id,
        isPlatformAdmin: true,
        aal: 'aal2',
        shopId: shop.id,
        identityCheckNote: note,
        now: t0,
      })
    ).resolves.toEqual({ reset: true });

    // Follow-up #4b: Owner lost BOTH PIN and recovery code -> Admin initiates 72-hour PIN reset
    const sentSms: Array<{ toE164: string; message: string }> = [];
    const initiated = await handleAdminInitiatePinReset72h(repo, {
      adminUserId: admin.id,
      isPlatformAdmin: true,
      aal: 'aal2',
      shopId: shop.id,
      identityCheckNote: note,
      pepper: PEPPER,
      sendSms: async (msg) => {
        sentSms.push(msg);
      },
      now: t0,
    });
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0].toE164).toBe('+260953000333');
    expect(sentSms[0].message).toMatch(/72-hour PIN reset/i);
    expect(Date.parse(initiated.availableAt) - t0.getTime()).toBe(PIN_RESET_WAITING_PERIOD_MS);

    // Existing device sees urgent security notice AND can cancel if unauthorized!
    const ownerIdentity = await issueSessionClaims(owner, 'owner-session');
    const cancelledByOwner = await harness.asUser(ownerIdentity, async (tx) => {
      const res = await tx.query<{ cancelled: boolean }>(
        `SELECT public.cancel_pending_shop_pin_reset() AS cancelled`
      );
      return res.rows[0]?.cancelled;
    });
    expect(cancelledByOwner).toBe(true);

    // Re-initiate legitimately for the owner who truly lost their phone + PIN + recovery code
    await handleAdminInitiatePinReset72h(repo, {
      adminUserId: admin.id,
      isPlatformAdmin: true,
      aal: 'aal2',
      shopId: shop.id,
      identityCheckNote: note,
      pepper: PEPPER,
      sendSms: async (msg) => {
        sentSms.push(msg);
      },
      now: t0,
    });

    // Attempting to complete after 71 hours is strictly rejected
    const after71h = new Date(t0.getTime() + 71 * 3600 * 1000);
    const statusAt71h = await handleCheckShopUnlockStatus(repo, {
      userId: owner.id,
      sessionId: 'replacement-phone-session',
      now: after71h,
    });
    expect(statusAt71h.pendingPinReset?.status).toBe('pending_wait');

    await expect(
      handleCompleteApprovedPinReset(repo, {
        userId: owner.id,
        sessionId: 'replacement-phone-session',
        newPin: '7788',
        pepper: PEPPER,
        iterations: FAST_ITERATIONS,
        now: after71h,
      })
    ).rejects.toThrow(/72-hour PIN reset safety waiting period is still active/i);

    // After 72 hours + 1 minute, completion succeeds, issues a brand-new recovery code, and verifies session
    const after72h = new Date(t0.getTime() + PIN_RESET_WAITING_PERIOD_MS + 60_000);
    const statusAt72h = await handleCheckShopUnlockStatus(repo, {
      userId: owner.id,
      sessionId: 'replacement-phone-session',
      now: after72h,
    });
    expect(statusAt72h.pendingPinReset?.status).toBe('ready');

    const resetDone = await handleCompleteApprovedPinReset(repo, {
      userId: owner.id,
      sessionId: 'replacement-phone-session',
      newPin: '7788',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
      now: after72h,
    });
    expect(resetDone.shop.id).toBe(shop.id);
    expect(resetDone.recoveryCode).toMatch(/^CU-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(
      (await issueSessionClaims(owner, 'replacement-phone-session')).appMetadata?.shop_id
    ).toBe(shop.id);
  });

  it('Follow-up #3: enforces per-phone & per-IP OTP limits, deduplicates precheck->dispatch, and fails safe with a critical platform_alert when daily SMS cap is reached or DB fails', async () => {
    const baseTime = new Date('2026-11-21T08:00:00.000Z');

    // 1. Precheck + Hook dispatch within 60s counts as ONE SMS, not two
    await handleCheckAndRecordSmsAllowance(repo, {
      purpose: 'otp',
      stage: 'precheck',
      phone: '0978111222',
      clientIp: '196.46.214.10',
      pepper: PEPPER,
      now: baseTime,
    });
    await handleCheckAndRecordSmsAllowance(repo, {
      purpose: 'otp',
      stage: 'dispatch',
      phone: '+260978111222',
      pepper: PEPPER,
      now: new Date(baseTime.getTime() + 5_000),
    });

    // 2 more OTP requests for the same phone within 15 minutes succeed (maxPerPhone15m = 3), 4th is rate-limited
    for (let i = 1; i <= 2; i += 1) {
      await handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'precheck',
        phone: '+260978111222',
        clientIp: `196.46.214.${20 + i}`,
        pepper: PEPPER,
        now: new Date(baseTime.getTime() + i * 30_000),
      });
    }
    await expect(
      handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'precheck',
        phone: '+260978111222',
        clientIp: '196.46.214.99',
        pepper: PEPPER,
        now: new Date(baseTime.getTime() + 120_000),
      })
    ).rejects.toThrow(/Too many/i);

    // 2. Per-IP abuse limit (maxPerIp15m = 6) blocks 7th request from one IP and logs sms_abuse alert
    for (let i = 1; i <= 3; i += 1) {
      await handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'precheck',
        phone: `+26096000010${i}`,
        clientIp: '196.46.214.77',
        pepper: PEPPER,
        policy: { maxPerIp15m: 3 },
        now: new Date(baseTime.getTime() + 130_000 + i * 1_000),
      });
    }
    await expect(
      handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'precheck',
        phone: '+260960000199',
        clientIp: '196.46.214.77',
        pepper: PEPPER,
        policy: { maxPerIp15m: 3 },
        now: new Date(baseTime.getTime() + 140_000),
      })
    ).rejects.toMatchObject({ code: 'sms_ip_rate_limited', status: 429 });

    // 3. Global daily cap breach fails safe (503) and writes critical alert to platform_alerts
    await expect(
      handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'dispatch',
        phone: '+260969999888',
        pepper: PEPPER,
        policy: { globalDailyCap: 6 },
        now: new Date(baseTime.getTime() + 180_000),
      })
    ).rejects.toMatchObject({ code: 'sms_daily_cap_reached', status: 503 });

    // 4. DB error during cap check ALSO fails safe (never fails open)
    failNextSmsDbQuery = true;
    await expect(
      handleCheckAndRecordSmsAllowance(repo, {
        purpose: 'otp',
        stage: 'dispatch',
        phone: '+260951234321',
        pepper: PEPPER,
        policy: { globalDailyCap: 500 },
        now: new Date(baseTime.getTime() + 240_000),
      })
    ).rejects.toMatchObject({ code: 'sms_failsafe_unavailable', status: 503 });

    // Platform admin with aal2 sees the critical daily cap alert + IP abuse alert via RLS
    const admin = await harness.createAuthUser({
      email: 'alerts-admin@countup.zm',
      emailVerified: true,
      appMetadata: { platform_admin: true },
      aal: 'aal2',
    });
    const alerts = await harness.asUser(admin, async (tx) => {
      const res = await tx.query<{ category: string; severity: string }>(
        `SELECT category, severity FROM public.platform_alerts ORDER BY category`
      );
      return res.rows;
    });
    expect(alerts).toEqual(
      expect.arrayContaining([
        { category: 'sms_abuse', severity: 'warning' },
        { category: 'sms_cap', severity: 'critical' },
      ])
    );
  });

  it('Follow-up #6: stores used_trial_phones ONLY as a salted/peppered hash (zero raw phone numbers) while blocking second free trials and preserving suspension', async () => {
    const rawPhone = '+260774000444';
    const userA1 = await harness.createAuthUser({ phone: rawPhone });
    const reg1 = await handleRegisterShop(repo, {
      userId: userA1.id,
      verifiedPhone: rawPhone,
      sessionId: 'sess-a1',
      shopName: 'Kabwata Mini Mart',
      pin: '1122',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
    });
    expect(reg1.trialGranted).toBe(true);
    expect(reg1.shop.plan_status).toBe('trial');

    const trialRow = await harness.asServiceRole(async (tx) => {
      const res = await tx.query<Record<string, unknown>>(
        `SELECT * FROM public.used_trial_phones WHERE first_shop_id = $1`,
        [reg1.shop.id]
      );
      return res.rows[0];
    });
    expect(trialRow.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(trialRow)).not.toContain('260774000444');
    expect(JSON.stringify(trialRow)).not.toContain('0774000444');

    await handleDeleteShop(repo, {
      userId: userA1.id,
      sessionId: 'sess-a1',
      confirmationName: 'Kabwata Mini Mart',
      pin: '1122',
      pepper: PEPPER,
    });

    await harness.asServiceRole(async (tx) => {
      await tx.query(`DELETE FROM auth.users WHERE id = $1`, [userA1.id]);
    });
    const userA2 = await harness.createAuthUser({ phone: rawPhone });
    const reg2 = await handleRegisterShop(repo, {
      userId: userA2.id,
      verifiedPhone: '0774 000 444',
      sessionId: 'sess-a2',
      shopName: 'Kabwata Mini Mart Reopened',
      pin: '3344',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
    });
    expect(reg2.trialGranted).toBe(false);
    expect(reg2.shop.plan_status).toBe('expired');

    await harness.asServiceRole(async (tx) => {
      await tx.query(
        `UPDATE public.shops SET plan_status = 'suspended', is_deactivated = true WHERE id = $1`,
        [reg2.shop.id]
      );
    });
    await handleDeleteShop(repo, {
      userId: userA2.id,
      sessionId: 'sess-a2',
      confirmationName: 'Kabwata Mini Mart Reopened',
      pin: '3344',
      pepper: PEPPER,
    });
    await harness.asServiceRole(async (tx) => {
      await tx.query(`DELETE FROM auth.users WHERE id = $1`, [userA2.id]);
    });
    const userA3 = await harness.createAuthUser({ phone: rawPhone });
    const reg3 = await handleRegisterShop(repo, {
      userId: userA3.id,
      verifiedPhone: rawPhone,
      sessionId: 'sess-a3',
      shopName: 'Bypass Attempt Shop',
      pin: '5566',
      pepper: PEPPER,
      iterations: FAST_ITERATIONS,
    });
    expect(reg3.trialGranted).toBe(false);
    expect(reg3.shop.plan_status).toBe('suspended');
    expect(reg3.shop.is_deactivated).toBe(true);
  });
});
