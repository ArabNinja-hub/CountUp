import { randomUUID } from 'node:crypto';
import { getApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  ManualPaymentNetwork,
  assertPaymentPending,
  assertPlatformAdminClaim,
  assertReferenceAvailable,
  assertShopOwner,
  deriveApprovedSubscription,
  normalizeManualPayment,
  referenceLockId,
  PaymentRecordForReview,
  validateRejectionReason,
} from './domain';

initializeApp();

const DATABASE_ID = 'ai-studio-6763e195-ebd5-4984-ba25-2f9dabfe7719';
const REGION = 'us-central1';
const GRACE_PERIOD_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const db = getFirestore(getApp(), DATABASE_ID);
const configuredAdminEmail = defineSecret('COUNTUP_ADMIN_EMAIL');
const mtnPaymentNumber = defineSecret('COUNTUP_MTN_PAYMENT_NUMBER');
const airtelPaymentNumber = defineSecret('COUNTUP_AIRTEL_PAYMENT_NUMBER');

function requireAuth(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to your shop first.');
  return request.auth;
}

function requirePlatformAdmin(request: {
  auth?: { uid: string; token: Record<string, unknown> } | null;
}) {
  const auth = requireAuth(request);
  try {
    assertPlatformAdminClaim(auth.token);
  } catch {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
  return auth;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function mapDomainError(error: unknown): never {
  throw new HttpsError('invalid-argument', asMessage(error));
}

function auditRef() {
  return db.collection('platformAudit').doc(randomUUID());
}

function requireNonEmptySecret(value: string, label: string) {
  const clean = value.trim();
  if (!clean)
    throw new HttpsError(
      'failed-precondition',
      `${label} is not configured by the platform administrator.`
    );
  return clean;
}

/**
 * The only route that can grant the platformAdmin custom claim. It requires a
 * verified Firebase identity matching a value held in Secret Manager; there is
 * no client-side email allowlist and no user-writable Firestore admin registry.
 */
export const verifyPlatformAdmin = onCall(
  { region: REGION, secrets: [configuredAdminEmail] },
  async (request) => {
    const auth = requireAuth(request);
    if (auth.token.platformAdmin === true) return { isAdmin: true, claimsUpdated: false };

    const expectedEmail = requireNonEmptySecret(
      configuredAdminEmail.value(),
      'Administrator identity'
    ).toLowerCase();
    const tokenEmail = typeof auth.token.email === 'string' ? auth.token.email.toLowerCase() : '';
    if (auth.token.email_verified !== true || tokenEmail !== expectedEmail)
      throw new HttpsError(
        'permission-denied',
        'This account is not authorized for platform administration.'
      );

    const userRecord = await getAuth().getUser(auth.uid);
    if (!userRecord.emailVerified || userRecord.email?.toLowerCase() !== expectedEmail)
      throw new HttpsError(
        'permission-denied',
        'Verify the administrator email before continuing.'
      );

    const previousClaims = userRecord.customClaims ?? {};
    await getAuth().setCustomUserClaims(auth.uid, { ...previousClaims, platformAdmin: true });
    await db.collection('platformAudit').doc(randomUUID()).set({
      action: 'platform_admin_provisioned',
      actorUid: auth.uid,
      targetUid: auth.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { isAdmin: true, claimsUpdated: true };
  }
);

/** Payment instructions are read from private server configuration and returned
 * only to an authenticated shop session when the owner opens the plan screen. */
export const getManualPaymentInstructions = onCall(
  { region: REGION, secrets: [mtnPaymentNumber, airtelPaymentNumber] },
  async (request) => {
    const auth = requireAuth(request);
    const shopId = typeof request.data?.shopId === 'string' ? request.data.shopId.trim() : '';
    if (!shopId) throw new HttpsError('invalid-argument', 'The shop could not be identified.');
    const shopSnapshot = await db.collection('shops').doc(shopId).get();
    if (!shopSnapshot.exists) throw new HttpsError('not-found', 'Shop not found.');
    const shop = shopSnapshot.data()!;
    try {
      assertShopOwner(String(shop.ownerUid ?? ''), shopId, auth.uid);
    } catch {
      throw new HttpsError(
        'permission-denied',
        'You can only access payment instructions for your own shop.'
      );
    }
    return {
      mtn: requireNonEmptySecret(mtnPaymentNumber.value(), 'MTN payment number'),
      airtel: requireNonEmptySecret(airtelPaymentNumber.value(), 'Airtel payment number'),
      verification: 'manual',
    };
  }
);

export const submitManualSubscriptionPayment = onCall({ region: REGION }, async (request) => {
  const auth = requireAuth(request);
  let payment;
  try {
    payment = normalizeManualPayment(request.data ?? {});
  } catch (error) {
    mapDomainError(error);
  }

  const shopId = typeof request.data?.shopId === 'string' ? request.data.shopId.trim() : '';
  if (!shopId || shopId.length > 120)
    throw new HttpsError('invalid-argument', 'The shop could not be identified.');

  const shopRef = db.collection('shops').doc(shopId);
  const paymentId = randomUUID();
  const paymentRef = db.collection('subscriptionPayments').doc(paymentId);
  const lockRef = db
    .collection('paymentReferenceLocks')
    .doc(referenceLockId(payment.network, payment.transactionReference));
  const now = new Date();
  const paidAt = new Date(`${payment.paymentDate}T00:00:00.000Z`);

  try {
    await db.runTransaction(async (transaction) => {
      const [shopSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(shopRef),
        transaction.get(lockRef),
      ]);
      if (!shopSnapshot.exists)
        throw new HttpsError('not-found', 'Sync the shop before submitting a payment.');
      const shop = shopSnapshot.data()!;
      try {
        assertShopOwner(String(shop.ownerUid ?? ''), shopId, auth.uid);
      } catch {
        throw new HttpsError('permission-denied', 'You can only submit payment for your own shop.');
      }
      try {
        assertReferenceAvailable(lockSnapshot.exists);
      } catch (error) {
        throw new HttpsError('already-exists', asMessage(error));
      }
      if (shop.pendingPaymentId)
        throw new HttpsError(
          'failed-precondition',
          'A payment for this shop is already awaiting review.'
        );

      transaction.create(paymentRef, {
        id: paymentId,
        shopId,
        shopNameSnapshot: String(shop.name ?? '').slice(0, 120),
        ownerUid: auth.uid,
        provider: 'manual_mobile_money',
        network: payment.network,
        planId: payment.planId,
        transactionReference: payment.transactionReference,
        payerPhone: payment.payerPhone,
        paymentDate: payment.paymentDate,
        paymentDateAt: Timestamp.fromDate(paidAt),
        amountNgwee: payment.amountNgwee,
        status: 'pending',
        submittedAt: FieldValue.serverTimestamp(),
        submittedAtMs: now.getTime(),
      });
      transaction.create(lockRef, {
        paymentId,
        network: payment.network,
        status: 'pending',
        shopId,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(shopRef, {
        pendingPaymentId: paymentId,
        planStatus: shop.isDeactivated ? 'suspended' : 'pending_payment',
        ...(shop.isDeactivated ? { statusBeforeSuspension: 'pending_payment' } : {}),
      });
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Payment submission was not saved. Try again.');
  }
  return { id: paymentId, status: 'pending' as const };
});

export const reviewManualSubscriptionPayment = onCall({ region: REGION }, async (request) => {
  const admin = requirePlatformAdmin(request);
  const paymentId =
    typeof request.data?.paymentId === 'string' ? request.data.paymentId.trim() : '';
  const decision = request.data?.decision;
  if (!paymentId || !['approve', 'reject'].includes(decision))
    throw new HttpsError(
      'invalid-argument',
      'Choose a payment and an approval or rejection action.'
    );

  let rejectionReason = '';
  if (decision === 'reject') {
    try {
      rejectionReason = validateRejectionReason(String(request.data?.reason ?? ''));
    } catch (error) {
      mapDomainError(error);
    }
  }

  const paymentRef = db.collection('subscriptionPayments').doc(paymentId);
  const logRef = auditRef();
  const now = new Date();
  try {
    await db.runTransaction(async (transaction) => {
      const paymentSnapshot = await transaction.get(paymentRef);
      if (!paymentSnapshot.exists)
        throw new HttpsError('not-found', 'Payment submission not found.');
      const payment = paymentSnapshot.data()!;
      try {
        assertPaymentPending(payment.status);
      } catch (error) {
        throw new HttpsError('failed-precondition', asMessage(error));
      }
      const shopRef = db.collection('shops').doc(String(payment.shopId));
      const lockRef = db
        .collection('paymentReferenceLocks')
        .doc(
          referenceLockId(
            payment.network as ManualPaymentNetwork,
            String(payment.transactionReference)
          )
        );
      const [shopSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(shopRef),
        transaction.get(lockRef),
      ]);
      if (!shopSnapshot.exists)
        throw new HttpsError('not-found', 'The payment shop no longer exists.');
      if (!lockSnapshot.exists || lockSnapshot.data()?.paymentId !== paymentId)
        throw new HttpsError(
          'failed-precondition',
          'The reference lock is missing or inconsistent.'
        );
      const shop = shopSnapshot.data()!;
      if (shop.pendingPaymentId !== paymentId)
        throw new HttpsError(
          'failed-precondition',
          'This is no longer the shop’s pending payment.'
        );

      if (decision === 'approve') {
        const approved = deriveApprovedSubscription(
          payment as PaymentRecordForReview,
          shop,
          now.getTime()
        );
        if (lockSnapshot.data()?.status === 'approved')
          throw new HttpsError(
            'already-exists',
            'This transaction reference was already approved.'
          );
        transaction.update(paymentRef, {
          status: 'approved',
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedAtMs: now.getTime(),
          reviewedByUid: admin.uid,
          subscriptionStartAt: new Date(approved.subscriptionStartAtMs).toISOString(),
          subscriptionStartAtMs: approved.subscriptionStartAtMs,
          subscriptionExpiryAt: approved.subscriptionExpiryDate,
          subscriptionExpiryAtMs: approved.subscriptionExpiryAtMs,
        });
        transaction.update(shopRef, {
          planStatus: approved.status,
          ...(approved.statusBeforeSuspension
            ? { statusBeforeSuspension: approved.statusBeforeSuspension }
            : { statusBeforeSuspension: FieldValue.delete() }),
          planType: approved.planType,
          planExpiryDate: approved.subscriptionExpiryDate,
          planExpiryAtMs: approved.subscriptionExpiryAtMs,
          salesAccessUntilMs: approved.subscriptionExpiryAtMs + GRACE_PERIOD_DAYS * DAY_MS,
          subscriptionStartedAt: new Date(approved.subscriptionStartAtMs).toISOString(),
          subscriptionStartedAtMs: approved.subscriptionStartAtMs,
          subscriptionPaymentId: paymentId,
          pendingPaymentId: FieldValue.delete(),
        });
        transaction.update(lockRef, {
          status: 'approved',
          reviewedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(logRef, {
          action: 'subscription_payment_approved',
          actorUid: admin.uid,
          shopId: payment.shopId,
          paymentId,
          transactionReference: payment.transactionReference,
          amountNgwee: payment.amountNgwee,
          planId: payment.planId,
          createdAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(paymentRef, {
          status: 'rejected',
          rejectionReason,
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedAtMs: now.getTime(),
          reviewedByUid: admin.uid,
        });
        transaction.update(shopRef, {
          planStatus: shop.isDeactivated ? 'suspended' : 'rejected',
          ...(shop.isDeactivated ? { statusBeforeSuspension: 'rejected' } : {}),
          pendingPaymentId: FieldValue.delete(),
        });
        transaction.update(lockRef, {
          status: 'rejected',
          reviewedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(logRef, {
          action: 'subscription_payment_rejected',
          actorUid: admin.uid,
          shopId: payment.shopId,
          paymentId,
          transactionReference: payment.transactionReference,
          reason: rejectionReason,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'The payment review was not saved. Try again.');
  }
  return { status: decision === 'approve' ? 'approved' : 'rejected' };
});

export const extendShopSubscription = onCall({ region: REGION }, async (request) => {
  const admin = requirePlatformAdmin(request);
  const shopId = typeof request.data?.shopId === 'string' ? request.data.shopId.trim() : '';
  const days = Number(request.data?.days);
  if (!shopId || !Number.isInteger(days) || days < 1 || days > 3650)
    throw new HttpsError('invalid-argument', 'Choose a shop and a number of days from 1 to 3,650.');
  const shopRef = db.collection('shops').doc(shopId);
  const logRef = auditRef();
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(shopRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Shop not found.');
    const shop = snapshot.data()!;
    const oldExpiry = Number.isFinite(shop.planExpiryAtMs)
      ? shop.planExpiryAtMs
      : Date.parse(String(shop.planExpiryDate ?? ''));
    const startAt = Math.max(now, Number.isFinite(oldExpiry) ? oldExpiry : now);
    const expiryAt = startAt + days * DAY_MS;
    const status = shop.isDeactivated ? 'suspended' : 'active';
    transaction.update(shopRef, {
      planStatus: status,
      ...(shop.isDeactivated
        ? { statusBeforeSuspension: 'active' }
        : { statusBeforeSuspension: FieldValue.delete() }),
      planExpiryDate: new Date(expiryAt).toISOString(),
      planExpiryAtMs: expiryAt,
      salesAccessUntilMs: expiryAt + GRACE_PERIOD_DAYS * DAY_MS,
      subscriptionStartedAt: new Date(startAt).toISOString(),
      subscriptionStartedAtMs: startAt,
    });
    transaction.create(logRef, {
      action: 'subscription_extended',
      actorUid: admin.uid,
      shopId,
      days,
      startAtMs: startAt,
      expiryAtMs: expiryAt,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { extended: true };
});

export const setShopSuspended = onCall({ region: REGION }, async (request) => {
  const admin = requirePlatformAdmin(request);
  const shopId = typeof request.data?.shopId === 'string' ? request.data.shopId.trim() : '';
  const suspended = request.data?.suspended;
  if (!shopId || typeof suspended !== 'boolean')
    throw new HttpsError('invalid-argument', 'Choose a shop and a valid suspension action.');
  const shopRef = db.collection('shops').doc(shopId);
  const logRef = auditRef();
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(shopRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Shop not found.');
    const shop = snapshot.data()!;
    let planStatus = String(shop.planStatus ?? 'expired');
    let statusBeforeSuspension = shop.statusBeforeSuspension;
    if (suspended && !shop.isDeactivated) {
      statusBeforeSuspension = planStatus;
      planStatus = 'suspended';
    } else if (!suspended && shop.isDeactivated) {
      const expiry = Number.isFinite(shop.salesAccessUntilMs)
        ? shop.salesAccessUntilMs
        : Number.isFinite(shop.planExpiryAtMs)
          ? shop.planExpiryAtMs + GRACE_PERIOD_DAYS * DAY_MS
          : Date.parse(String(shop.planExpiryDate ?? '')) + GRACE_PERIOD_DAYS * DAY_MS;
      planStatus =
        typeof statusBeforeSuspension === 'string'
          ? statusBeforeSuspension
          : expiry > now
            ? shop.planType === 'trial'
              ? 'trial'
              : 'active'
            : 'expired';
      if (planStatus === 'suspended') planStatus = expiry > now ? 'active' : 'expired';
      statusBeforeSuspension = FieldValue.delete();
    }
    transaction.update(shopRef, {
      isDeactivated: suspended,
      planStatus,
      statusBeforeSuspension,
    });
    transaction.create(logRef, {
      action: suspended ? 'shop_suspended' : 'shop_reactivated',
      actorUid: admin.uid,
      shopId,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { suspended };
});
