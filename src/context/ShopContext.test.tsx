// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import { Shop } from '../types';
import { customerStatement, summarizeLedger } from '../utils/ledger';
import { hasLocalPinRecord, saveLocalPinRecord, verifyLocalPin } from '../utils/pinLock';
import { activeShopCacheKey, writeVersionedDomainCollection } from '../data/offlineCache';
import { setShopReadSyncOverrideForTests } from '../data/shopReadRepository';
import { setShopWriteClientOverrideForTests, SYNC_BATCH_CHUNK_SIZE } from '../data/shopWriteRpc';
import {
  createFakeDocsReadSyncOverride,
  createFakeDocsRpcClient,
} from '../data/__tests__/fakeDocsRpcAdapter';
import type { AuthUserIdentity } from '../auth/authService';

const fake = vi.hoisted(() => {
  const state = {
    auth: {
      currentUser: null as AuthUserIdentity | null,
    },
    docs: new Map<string, Record<string, unknown>>(),
    changeListeners: [] as (() => void)[],
    authListeners: [] as ((identity: AuthUserIdentity | null) => void)[],
    accounts: new Map<string, { uid: string; password: string }>(),
    phoneUsers: new Map<string, { uid: string; otp: string }>(),
    serverShops: new Map<
      string,
      {
        shop: Shop;
        pin: string;
        recoveryCode: string;
        failedAttempts: number;
        lockedUntilMs: number | null;
      }
    >(),
    usedPhones: new Map<string, { wasSuspended: boolean }>(),
    auditLogs: [] as { action: string; shopId?: string; reason?: string }[],
    adminUids: new Set<string>(),
    emit: () => {
      fake.changeListeners.forEach((fn) => fn());
    },
    emitAuth: () => {
      state.authListeners.forEach((fn) => fn(state.auth.currentUser));
    },
    resets: [] as string[],
    failAdminRead: false,
    failWrite: false,
    failBatch: false,
    transactionError: null as Error | null,
    failMarker: null as string | null,
    failNextVerification: false,
    transactionAttempts: 0,
    failDelete: false,
    deleteGate: null as Promise<void> | null,
    failOtpVerify: false,
    failRegister: false,
    nextUuidIndex: 1,
  };
  return state;
});

vi.mock('../auth/authService', async () => {
  const security = await import('../../shared/authSecurity');
  return {
    AuthServiceError: class AuthServiceError extends Error {
      readonly code: string;
      constructor(message: string, code = 'auth_error') {
        super(message);
        this.code = code;
      }
    },
    subscribeToAuthIdentity: (listener: (identity: AuthUserIdentity | null) => void) => {
      fake.authListeners.push(listener);
      queueMicrotask(() => listener(fake.auth.currentUser));
      return () => {
        fake.authListeners = fake.authListeners.filter((fn) => fn !== listener);
      };
    },
    requestPhoneOtp: async (rawPhone: string) => {
      const phoneE164 = security.normalizeZambianPhoneE164(rawPhone);
      if (!fake.phoneUsers.has(phoneE164)) {
        fake.phoneUsers.set(phoneE164, {
          uid: `phone-user-${fake.phoneUsers.size + 1}`,
          otp: '123456',
        });
      }
      return { phoneE164 };
    },
    verifyPhoneOtp: async (rawPhone: string, otpToken: string) => {
      if (fake.failOtpVerify) throw new Error('SMS verification unavailable');
      const phoneE164 = security.normalizeZambianPhoneE164(rawPhone);
      const entry = fake.phoneUsers.get(phoneE164);
      if (!entry || entry.otp !== otpToken.trim()) {
        throw new Error('Invalid or expired SMS verification code.');
      }
      // Before PIN unlock on a new session, verifiedShopId is null (SIM-swap session gating!)
      const identity: AuthUserIdentity = {
        id: entry.uid,
        phone: phoneE164,
        email: null,
        isPlatformAdmin: fake.adminUids.has(entry.uid),
        verifiedShopId: null,
      };
      fake.auth.currentUser = identity;
      fake.emitAuth();
      return identity;
    },
    checkShopUnlockStatus: async () => {
      const uid = fake.auth.currentUser?.id;
      const found = [...fake.serverShops.values()].find((entry) => entry.shop.ownerUid === uid);
      if (!found) {
        return { hasShop: false, sessionVerified: false, isLockedOut: false, lockedUntil: null };
      }
      const isLockedOut = Boolean(found.lockedUntilMs && found.lockedUntilMs > Date.now());
      return {
        hasShop: true,
        sessionVerified: fake.auth.currentUser?.verifiedShopId === found.shop.id,
        isLockedOut,
        lockedUntil: isLockedOut ? new Date(found.lockedUntilMs!).toISOString() : null,
      };
    },
    registerShopWithServer: async ({ name, pin }: { name: string; pin: string }) => {
      if (fake.failRegister || fake.failWrite) throw new Error('Server registration unavailable');
      const caller = fake.auth.currentUser;
      if (!caller?.phone) throw new Error('Verify your phone number first.');
      const cleanName = security.validateShopName(name);
      if (!security.isValidFourDigitPin(pin)) throw new Error('Enter a 4-digit PIN.');
      const duplicate = [...fake.serverShops.values()].find(
        (entry) => entry.shop.ownerUid === caller.id || entry.shop.ownerPhone === caller.phone
      );
      if (duplicate) {
        throw new Error('A shop is already registered for this phone number. Sign in instead.');
      }
      const used = fake.usedPhones.get(caller.phone);
      const now = Date.now();
      const trialEnds = new Date(now + 30 * 86_400_000).toISOString();
      const trialGranted = !used;
      const isSuspended = Boolean(used?.wasSuspended);
      const shopId = `550e8400-e29b-41d4-a716-${String(fake.nextUuidIndex++).padStart(12, '0')}`;
      const recoveryCode = security.generateOneTimeRecoveryCode();
      const created: Shop = {
        id: shopId,
        name: cleanName,
        ownerPhone: caller.phone,
        ownerUid: caller.id,
        planStatus: trialGranted ? 'trial' : isSuspended ? 'suspended' : 'expired',
        planType: 'trial',
        createdAt: new Date(now).toISOString(),
        trialEndsAt: trialGranted ? trialEnds : new Date(now).toISOString(),
        planExpiryDate: trialGranted ? trialEnds : new Date(now).toISOString(),
        salesAccessUntilMs: trialGranted ? now + 33 * 86_400_000 : now,
        isDeactivated: isSuspended,
        currency: 'ZMW',
      };
      if (!used) {
        fake.usedPhones.set(caller.phone, { wasSuspended: false });
      }
      fake.serverShops.set(shopId, {
        shop: created,
        pin,
        recoveryCode,
        failedAttempts: 0,
        lockedUntilMs: null,
      });
      fake.docs.set(`shops/${shopId}`, { ...created });
      fake.auth.currentUser = { ...caller, verifiedShopId: shopId };
      fake.emitAuth();
      return { shop: created, recoveryCode, trialGranted };
    },
    unlockShopSessionWithPin: async (pin: string) => {
      const caller = fake.auth.currentUser;
      if (!caller) throw new Error('Sign in first.');
      const record = [...fake.serverShops.values()].find((e) => e.shop.ownerUid === caller.id);
      if (!record) throw new Error('Shop not found.');
      if (record.lockedUntilMs && record.lockedUntilMs > Date.now()) {
        throw new Error('Too many incorrect PIN attempts on a new device.');
      }
      if (record.pin !== pin) {
        record.failedAttempts += 1;
        const delay = security.calculateNewDeviceLockoutMs(record.failedAttempts);
        record.lockedUntilMs = delay > 0 ? Date.now() + delay : null;
        throw new Error(
          delay > 0
            ? 'New-device sign-in is locked. Use your one-time recovery code.'
            : 'Incorrect PIN.'
        );
      }
      record.failedAttempts = 0;
      record.lockedUntilMs = null;
      fake.auth.currentUser = { ...caller, verifiedShopId: record.shop.id };
      fake.emitAuth();
      return { shop: record.shop };
    },
    recoverShopPinWithCode: async ({
      recoveryCode,
      newPin,
    }: {
      recoveryCode: string;
      newPin: string;
    }) => {
      const caller = fake.auth.currentUser;
      if (!caller) throw new Error('Sign in first.');
      const record = [...fake.serverShops.values()].find((e) => e.shop.ownerUid === caller.id);
      if (!record) throw new Error('Shop not found.');
      const normalized = security.normalizeRecoveryCode(recoveryCode);
      if (normalized !== record.recoveryCode) {
        throw new Error('That recovery code does not match.');
      }
      if (!security.isValidFourDigitPin(newPin)) throw new Error('Enter a 4-digit PIN.');
      const nextCode = security.generateOneTimeRecoveryCode();
      record.pin = newPin;
      record.recoveryCode = nextCode;
      record.failedAttempts = 0;
      record.lockedUntilMs = null;
      fake.auth.currentUser = { ...caller, verifiedShopId: record.shop.id };
      fake.emitAuth();
      return { shop: record.shop, recoveryCode: nextCode };
    },
    changeShopPinOnServer: async ({
      currentPin,
      newPin,
    }: {
      currentPin: string;
      newPin: string;
    }) => {
      if (fake.failWrite) throw new Error('Write rejected');
      const caller = fake.auth.currentUser;
      if (!caller) throw new Error('Sign in first.');
      const record = [...fake.serverShops.values()].find((e) => e.shop.ownerUid === caller.id);
      if (!record || record.pin !== currentPin || currentPin === newPin) {
        throw new Error('That is not your current PIN.');
      }
      record.pin = newPin;
    },
    deleteShopOnServer: async ({
      confirmationName,
      pin,
    }: {
      confirmationName: string;
      pin: string;
    }) => {
      if (fake.deleteGate) await fake.deleteGate;
      if (fake.failDelete) throw new Error('Some records may already have been removed.');
      const caller = fake.auth.currentUser;
      if (!caller) throw new Error('Sign in first.');
      const record = [...fake.serverShops.values()].find((e) => e.shop.ownerUid === caller.id);
      if (!record) throw new Error('Shop not found.');
      if (confirmationName.trim().toLowerCase() !== record.shop.name.trim().toLowerCase()) {
        throw new Error('Confirmation name mismatch.');
      }
      if (record.pin !== pin) {
        throw new Error('Incorrect PIN.');
      }
      const prevUsed = fake.usedPhones.get(record.shop.ownerPhone);
      fake.usedPhones.set(record.shop.ownerPhone, {
        wasSuspended: Boolean(
          prevUsed?.wasSuspended ||
          record.shop.isDeactivated ||
          record.shop.planStatus === 'suspended'
        ),
      });
      fake.serverShops.delete(record.shop.id);
      fake.docs.delete(`shops/${record.shop.id}`);
    },
    signInPlatformAdmin: async (email: string, password: string) => {
      const cleanEmail = email.trim();
      const account = fake.accounts.get(cleanEmail);
      if (!account || account.password !== password) {
        throw Object.assign(
          new Error('The account or password is incorrect. Use the authorized platform account.'),
          { code: 'invalid_credentials' }
        );
      }
      if (fake.failAdminRead) {
        fake.auth.currentUser = null;
        fake.emitAuth();
        throw Object.assign(new Error('Server unavailable'), { code: 'unavailable' });
      }
      if (!fake.adminUids.has(account.uid)) {
        fake.auth.currentUser = null;
        fake.emitAuth();
        throw Object.assign(
          new Error('This account is not authorized for platform administration.'),
          { code: 'permission_denied' }
        );
      }
      const identity: AuthUserIdentity = {
        id: account.uid,
        phone: null,
        email: cleanEmail,
        isPlatformAdmin: true,
        verifiedShopId: null,
      };
      fake.auth.currentUser = identity;
      fake.emitAuth();
      return { status: 'authenticated' as const, identity };
    },
    completePlatformAdminMfa: async () => {
      if (!fake.auth.currentUser) throw new Error('Not signed in.');
      return fake.auth.currentUser;
    },
    sendAdminPasswordReset: async (email: string) => {
      fake.resets.push(email.trim());
    },
    adminInitiateShopPinReset: async ({
      shopId,
      identityCheckNote,
    }: {
      shopId: string;
      identityCheckNote: string;
    }) => {
      const note = security.validateIdentityCheckNote(identityCheckNote);
      const record = fake.serverShops.get(shopId);
      if (!record) throw new Error('Shop not found.');
      const availableAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
      record.shop = {
        ...record.shop,
        securityNotice: `Urgent security alert: Support initiated a 72-hour PIN reset (${availableAt}).`,
        securityNoticeAt: new Date().toISOString(),
      };
      fake.docs.set(`shops/${shopId}`, { ...record.shop });
      fake.auditLogs.push({ action: 'shop_pin_reset_72h_initiated', shopId, reason: note });
      fake.emit();
      return { requestId: 'req-1', availableAt };
    },
    completeApprovedShopPinReset: async ({ newPin }: { newPin: string }) => {
      const caller = fake.auth.currentUser;
      if (!caller) throw new Error('Sign in first.');
      const record = [...fake.serverShops.values()].find((e) => e.shop.ownerUid === caller.id);
      if (!record) throw new Error('Shop not found.');
      const nextCode = security.generateOneTimeRecoveryCode();
      record.pin = newPin;
      record.recoveryCode = nextCode;
      fake.auth.currentUser = { ...caller, verifiedShopId: record.shop.id };
      fake.emitAuth();
      return { shop: record.shop, recoveryCode: nextCode };
    },
    revokeOtherShopSessionsOnServer: async () => ({ revokedCount: 1 }),
    cancelPendingPinResetOnServer: async () => true,
    fetchActivePlatformAlerts: async () => [],
    adminResetShopPinLockout: async ({
      shopId,
      identityCheckNote,
    }: {
      shopId: string;
      identityCheckNote: string;
    }) => {
      const note = security.validateIdentityCheckNote(identityCheckNote);
      const record = fake.serverShops.get(shopId);
      if (!record) throw new Error('Shop not found.');
      record.failedAttempts = 0;
      record.lockedUntilMs = null;
      record.shop = {
        ...record.shop,
        securityNotice:
          'Security alert: Platform support reset your shop’s new-device PIN lockout after an identity check.',
        securityNoticeAt: new Date().toISOString(),
      };
      fake.docs.set(`shops/${shopId}`, { ...record.shop });
      fake.auditLogs.push({ action: 'shop_pin_lockout_reset', shopId, reason: note });
      fake.emit();
    },
    acknowledgeShopSecurityNoticeOnServer: async () => {
      const caller = fake.auth.currentUser;
      if (!caller?.verifiedShopId) throw new Error('No verified shop.');
      const record = fake.serverShops.get(caller.verifiedShopId);
      if (record) {
        record.shop = { ...record.shop, securityNotice: null, securityNoticeAt: null };
        fake.docs.set(`shops/${record.shop.id}`, { ...record.shop });
      }
    },
    fetchVerifiedShopFromServer: async (shopId: string) => {
      return fake.serverShops.get(shopId)?.shop ?? null;
    },
    fetchAllShopsForAdmin: async () => {
      return [...fake.serverShops.values()].map((entry) => entry.shop);
    },
    signOutSupabase: async () => {
      fake.auth.currentUser = null;
      fake.emitAuth();
    },
  };
});

vi.mock('../firebase/functions', () => ({ functions: {} }));
vi.mock('firebase/functions', () => ({
  httpsCallable:
    (_functions: unknown, name: string) =>
    async (input: Record<string, unknown> = {}) => {
      if (name === 'extendShopSubscription' || name === 'setShopSuspended') {
        if (fake.failWrite) throw new Error('Write rejected');
        const shopId = String(input.shopId);
        const path = `shops/${shopId}`;
        const currentDoc = fake.docs.get(path) ?? {};
        const updated =
          name === 'extendShopSubscription'
            ? {
                ...currentDoc,
                planStatus: 'active',
                planExpiryDate: new Date(Date.now() + Number(input.days) * 86400000).toISOString(),
              }
            : {
                ...currentDoc,
                isDeactivated: Boolean(input.suspended),
                planStatus: input.suspended ? 'suspended' : 'active',
              };
        fake.docs.set(path, updated);
        const serverEntry = fake.serverShops.get(shopId);
        if (serverEntry) {
          serverEntry.shop = updated as Shop;
        }
        fake.emit();
        return {
          data:
            name === 'extendShopSubscription' ? { extended: true } : { suspended: input.suspended },
        };
      }
      if (name === 'submitManualSubscriptionPayment')
        return { data: { id: 'payment-test', status: 'pending' } };
      if (name === 'reviewManualSubscriptionPayment')
        return { data: { status: input.decision === 'approve' ? 'approved' : 'rejected' } };
      if (name === 'getManualPaymentInstructions')
        return { data: { mtn: 'test-mtn', airtel: 'test-airtel', verification: 'manual' } };
      throw new Error(`Unexpected callable ${name}`);
    },
}));
import { ShopProvider, useShop } from './ShopContext';
import App from '../App';

let current: ReturnType<typeof useShop>;
function Capture() {
  current = useShop();
  return null;
}
const shop: Shop = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'CountUp Test',
  ownerPhone: '+260977000000',
  ownerUid: 'owner-1',
  planStatus: 'trial',
  planType: 'trial',
  createdAt: new Date().toISOString(),
  trialEndsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
  planExpiryDate: new Date(Date.now() + 86400000 * 30).toISOString(),
  isDeactivated: false,
  currency: 'ZMW',
};
const online = (value: boolean) =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
async function mount() {
  render(
    <ToastProvider>
      <ShopProvider>
        <Capture />
      </ShopProvider>
    </ToastProvider>
  );
  await waitFor(() => expect(current?.isLoading).toBe(false));
}

beforeEach(async () => {
  localStorage.clear();
  fake.docs.clear();
  fake.changeListeners = [];
  fake.authListeners = [];
  fake.accounts.clear();
  fake.phoneUsers.clear();
  fake.serverShops.clear();
  fake.usedPhones.clear();
  fake.auditLogs = [];
  fake.adminUids.clear();
  fake.resets = [];
  fake.failAdminRead = false;
  fake.failWrite = false;
  fake.failBatch = false;
  fake.transactionError = null;
  fake.failMarker = null;
  fake.failNextVerification = false;
  fake.transactionAttempts = 0;
  fake.failDelete = false;
  fake.deleteGate = null;
  fake.failOtpVerify = false;
  fake.failRegister = false;
  fake.nextUuidIndex = 1;
  fake.phoneUsers.set('+260977000000', { uid: 'owner-1', otp: '123456' });
  fake.serverShops.set(shop.id, {
    shop: { ...shop },
    pin: '1234',
    recoveryCode: 'CU-ABCD-EFGH-JKLM',
    failedAttempts: 0,
    lockedUntilMs: null,
  });
  fake.usedPhones.set('+260977000000', { wasSuspended: false });
  fake.auth.currentUser = {
    id: 'owner-1',
    phone: '+260977000000',
    email: null,
    isPlatformAdmin: false,
    verifiedShopId: shop.id,
  };
  online(false);
  setShopReadSyncOverrideForTests(
    createFakeDocsReadSyncOverride(fake.docs, (fn) => {
      fake.changeListeners.push(fn);
      return () => {
        fake.changeListeners = fake.changeListeners.filter((item) => item !== fn);
      };
    })
  );
  setShopWriteClientOverrideForTests(createFakeDocsRpcClient(fake));
  localStorage.setItem('countup_active_shop', JSON.stringify(shop));
  await saveLocalPinRecord(shop.id, '1234', { iterations: 1_000 });
  fake.docs.set(`shops/${shop.id}`, { ...shop });
});
afterEach(() => {
  setShopReadSyncOverrideForTests(null);
  setShopWriteClientOverrideForTests(null);
  cleanup();
  vi.restoreAllMocks();
});

describe('CountUp integrated business and authentication flows (mock Firebase)', () => {
  it('blocks new sales after the subscription and grace period expire without changing records', async () => {
    const expiredShop = {
      ...shop,
      planStatus: 'active' as const,
      planExpiryDate: new Date(Date.now() - 4 * 86400000).toISOString(),
      salesAccessUntilMs: Date.now() - 86400000,
    };
    localStorage.setItem('countup_active_shop', JSON.stringify(expiredShop));
    fake.docs.set(`shops/${shop.id}`, expiredShop);
    await mount();
    expect(current.subscription.status).toBe('expired');
    expect(current.subscription.canRecordSales).toBe(false);
    await expect(
      current.recordSale({
        items: [{ itemId: 'missing', name: 'Item', quantity: 1, buyingPrice: 1, sellingPrice: 2 }],
        itemsCount: 1,
        totalAmount: 2,
        totalCost: 1,
        profit: 1,
        paymentType: 'cash',
      })
    ).rejects.toThrow(/New sales are locked/);
    expect(current.pendingSyncCount).toBe(0);
  });

  it('rejects carts that could exceed Firestore transaction limits during conflicts', async () => {
    await mount();
    const lines = Array.from({ length: 161 }, (_, index) => ({
      itemId: `item-${index}`,
      name: 'Item',
      quantity: 1,
      buyingPrice: 1,
      sellingPrice: 2,
    }));
    await expect(
      current.recordSale({
        items: lines,
        itemsCount: 161,
        totalAmount: 322,
        totalCost: 161,
        profit: 161,
        paymentType: 'cash',
      })
    ).rejects.toThrow(/160 products/);
    expect(current.pendingSyncCount).toBe(0);
  });

  it('reconciles the requested cash, MoMo, credit, repayment and profit example end to end', async () => {
    await mount();
    let itemId = '';
    let customerId = '';
    await act(async () => {
      itemId = await current.addItem({
        name: 'Water bottle',
        buyingPrice: 6,
        sellingPrice: 10,
        quantity: 30,
        lowStockThreshold: 5,
      });
      customerId = (await current.addCustomer('Chisomo')).id;
    });

    await expect(
      current.recordSale({
        items: [{ itemId, name: 'Water bottle', quantity: 31, buyingPrice: 6, sellingPrice: 10 }],
        itemsCount: 31,
        totalAmount: 310,
        totalCost: 186,
        profit: 124,
        paymentType: 'cash',
        cashTendered: 310,
      })
    ).rejects.toThrow(/Only 30/);
    await expect(
      current.recordSale({
        items: [{ itemId, name: 'Water bottle', quantity: 1, buyingPrice: 6, sellingPrice: 10 }],
        itemsCount: 1,
        totalAmount: 10,
        totalCost: 6,
        profit: 4,
        paymentType: 'cash',
        cashTendered: 9,
      })
    ).rejects.toThrow(/Cash received must cover/);
    expect(current.pendingSyncCount).toBe(2);

    const sell = async (quantity: number, paymentType: 'cash' | 'momo' | 'credit') => {
      await act(async () => {
        await current.recordSale({
          items: [{ itemId, name: 'Water bottle', quantity, buyingPrice: 6, sellingPrice: 10 }],
          itemsCount: quantity,
          totalAmount: quantity * 10,
          totalCost: quantity * 6,
          profit: quantity * 4,
          paymentType,
          customerId: paymentType === 'credit' ? customerId : undefined,
          momoOperator: paymentType === 'momo' ? 'mtn' : undefined,
        });
      });
    };
    await sell(4, 'cash');
    await sell(3, 'momo');
    await sell(5, 'credit');
    await act(async () => {
      await current.updateItem(itemId, { sellingPrice: 12, buyingPrice: 7 });
    });
    expect(current.sales.every((sale) => sale.items[0].sellingPrice === 10)).toBe(true);
    expect(current.sales.every((sale) => sale.items[0].buyingPrice === 6)).toBe(true);
    await act(async () => {
      await current.recordCreditPayment(customerId, 20, 'Part repayment', 'cash');
    });
    await expect(current.recordCreditPayment(customerId, 31)).rejects.toThrow(/only owes K 30/);

    const ledger = summarizeLedger(current.sales, current.creditPayments, current.customers);
    expect(current.items.find((item) => item.id === itemId)?.quantity).toBe(18);
    expect(ledger).toMatchObject({
      sales: 120,
      cashSales: 40,
      cashRepayments: 20,
      momoSales: 30,
      cashReceived: 60,
      momoReceived: 30,
      moneyReceived: 90,
      creditSales: 50,
      outstanding: 30,
      profit: 48,
      missingCostRevenue: 0,
    });
    expect(current.sales).toHaveLength(3);
    expect(current.creditPayments).toHaveLength(1);
    expect(current.stockMovements.filter((movement) => movement.type === 'sale')).toHaveLength(3);
    expect(customerStatement(customerId, current.sales, current.creditPayments)).toMatchObject([
      { type: 'payment', amount: 20, runningBalance: 30 },
      { type: 'sale', amount: 50, runningBalance: 50 },
    ]);
    expect(current.pendingSyncCount).toBe(7);
  });

  it('records stock, credit sales, repayments, archives and expenses offline as atomic queued operations', async () => {
    await mount();
    let itemId = '';
    let customerId = '';
    await act(async () => {
      itemId = await current.addItem({
        name: 'Sugar',
        buyingPrice: 1,
        sellingPrice: 2.5,
        quantity: 10,
        lowStockThreshold: 5,
      });
    });
    await act(async () => {
      customerId = (await current.addCustomer('Mwamba', '0977000001')).id;
    });
    let saleId = '';
    await act(async () => {
      const sale = await current.recordSale({
        items: [{ itemId, name: 'Sugar', quantity: 2, buyingPrice: 1, sellingPrice: 2.5 }],
        itemsCount: 2,
        totalAmount: 5,
        totalCost: 2,
        profit: 3,
        paymentType: 'credit',
        customerId,
      });
      saleId = sale.id;
    });
    expect(current.items[0].quantity).toBe(8);
    expect(current.customers[0].totalOwed).toBe(5);
    expect(current.sales[0].receiptNumber).toMatch(/^CU-/);
    await act(async () => {
      await current.recordCreditPayment(customerId, 2, 'MTN', 'momo');
    });
    expect(current.customers[0].totalOwed).toBe(3);
    expect(current.creditPayments[0].paymentMethod).toBe('momo');
    await expect(current.voidSale(saleId)).rejects.toThrow(/partly repaid/);
    await act(async () => {
      await current.adjustStock(itemId, 'add', 3, 'Delivery');
      await current.deleteItem(itemId);
    });
    expect(current.items).toHaveLength(0);
    expect(current.archivedItems[0].quantity).toBe(11);
    await act(async () => {
      await current.restoreItem(current.archivedItems[0]);
      await current.addExpense('transport', 1.5);
    });
    expect(current.items[0].quantity).toBe(11);
    expect(current.expenses[0].amount).toBe(1.5);
    expect(current.stockMovements.map((movement) => movement.type)).toEqual([
      'restock',
      'sale',
      'initial',
    ]);
    const queue = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    const queuedSale = queue.find((entry: { type: string }) => entry.type === 'sale');
    expect(queuedSale.writes.length).toBe(4);
    expect(queuedSale.adjustments.length).toBe(2);
    await act(async () => {
      await current.logout();
    });
    expect(current.shop?.id).toBe(shop.id); // unsynced changes cannot be silently lost
  });

  it('syncs against current remote stock, preserves an oversold sale, flags a recount and does not double-apply a retry', async () => {
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 2,
      quantity: 5,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    fake.docs.set(`shops/${shop.id}/items/${item.id}`, item);
    await mount();
    await waitFor(() => expect(current.items).toHaveLength(1));
    await act(async () => {
      await current.recordSale({
        items: [{ itemId: item.id, name: item.name, quantity: 4, buyingPrice: 1, sellingPrice: 2 }],
        itemsCount: 4,
        totalAmount: 8,
        totalCost: 4,
        profit: 4,
        paymentType: 'cash',
      });
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0];
    fake.docs.set(`shops/${shop.id}/items/${item.id}`, { ...item, quantity: 2 });
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}/items/${item.id}`)?.quantity).toBe(0);
    expect(current.items[0].quantity).toBe(0);
    expect([...fake.docs.keys()].some((path) => path.includes('/stock_conflicts/'))).toBe(true);
    expect([...fake.docs.keys()].some((path) => path.includes('/sales/'))).toBe(true);
    // Simulate the crash window after commit but before queue acknowledgement.
    localStorage.setItem('countup_pending_queue', JSON.stringify([queued]));
    cleanup();
    await mount();
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}/items/${item.id}`)?.quantity).toBe(0);
    expect([...fake.docs.keys()].filter((path) => path.includes('/sales/'))).toHaveLength(1);
  });

  it('keeps a conflicting repayment and later entries queued with a visible reason', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8, undefined, 'cash');
    });
    await act(async () => {
      await current.addExpense('rent', 1);
    });
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(2);
    expect(current.lastOfflineNotice).toMatch(/conflicts with a newer customer balance/i);
    expect(fake.docs.get(path)?.totalOwed).toBe(5);
    expect([...fake.docs.keys()].some((key) => key.includes('/credit_payments/'))).toBe(false);
    expect([...fake.docs.keys()].some((key) => key.includes('/expenses/'))).toBe(false);
  });

  it('corrects a verified mistaken payment, audits the original and rebases dependent entries', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 2,
      quantity: 5,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const customerPath = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(customerPath, customer);
    fake.docs.set(`shops/${shop.id}/items/${item.id}`, item);
    await mount();
    await waitFor(() => expect(current.items).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8, 'original note', 'cash');
      await current.recordSale({
        items: [{ itemId: item.id, name: item.name, quantity: 1, buyingPrice: 1, sellingPrice: 2 }],
        itemsCount: 1,
        totalAmount: 2,
        totalCost: 1,
        profit: 1,
        paymentType: 'credit',
        customerId: customer.id,
      });
      await current.recordCreditPayment(customer.id, 2, 'later payment', 'momo');
      await current.addExpense('rent', 1);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    const firstId = queued[0].id;
    const paymentPath = queued[0].writes[0].path;
    fake.docs.set(customerPath, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.blockedSync).toEqual({ actionId: firstId, kind: 'payment' });
    const review = await current.loadSyncReview(firstId);
    expect(review).toMatchObject({ originalAmount: 8, serverBalance: 5, customerName: 'Mwamba' });
    // Keep the later sale queued so its local projection can be inspected.
    fake.failMarker = queued[1].id;
    await act(async () => {
      await current.resolveSyncReview(review, { kind: 'correct-payment', amount: 4 });
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(3));
    expect(current.customers[0].totalOwed).toBe(1); // K5 - K4 + K2 - K2
    expect(
      current.creditPayments.find((entry) => entry.id === paymentPath.split('/').at(-1))?.amount
    ).toBe(4);
    expect(fake.docs.get(paymentPath)).toMatchObject({ amount: 4, note: 'original note' });
    const marker = fake.docs.get(`shops/${shop.id}/sync_operations/${firstId}`);
    expect(marker?.resolution).toMatchObject({
      kind: 'correct-payment',
      originalAmount: 8,
      correctedAmount: 4,
      originalPayment: { amount: 8, note: 'original note', paymentMethod: 'cash' },
    });
    const history = await current.loadSyncResolutionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].originalPayment?.amount).toBe(8);
    fake.failMarker = null;
    await act(async () => {
      await current.syncNow();
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(customerPath)?.totalOwed).toBe(1);
    expect([...fake.docs.keys()].filter((path) => path.includes('/credit_payments/'))).toHaveLength(
      2
    );
    expect([...fake.docs.keys()].filter((path) => path.includes('/expenses/'))).toHaveLength(1);
  });

  it('stops again for a dependent overpayment instead of discarding or changing it', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8);
      await current.recordCreditPayment(customer.id, 2);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    const firstReview = await current.loadSyncReview(queued[0].id);
    await act(async () => {
      await current.resolveSyncReview(firstReview, { kind: 'correct-payment', amount: 4 });
    });
    await waitFor(() =>
      expect(current.blockedSync).toEqual({ actionId: queued[1].id, kind: 'payment' })
    );
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect(fake.docs.has(queued[1].writes[0].path)).toBe(false);
    expect(
      JSON.parse(localStorage.getItem('countup_pending_queue')!)[0].writes[0].data.amount
    ).toBe(2);
    const secondReview = await current.loadSyncReview(queued[1].id);
    expect(secondReview).toMatchObject({ originalAmount: 2, serverBalance: 1 });
    await act(async () => {
      await current.resolveSyncReview(secondReview, { kind: 'correct-payment', amount: 1 });
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(path)?.totalOwed).toBe(0);
    expect(fake.docs.get(queued[1].writes[0].path)?.amount).toBe(1);
    expect(await current.loadSyncResolutionHistory()).toHaveLength(2);
  });

  it('cancels a confirmed duplicate payment without recording it and keeps the original in history', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8, 'duplicate', 'momo');
      await current.addExpense('rent', 1);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    const review = await current.loadSyncReview(queued[0].id);
    await act(async () => {
      await current.resolveSyncReview(review, { kind: 'cancel-payment' });
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(path)?.totalOwed).toBe(5);
    expect(current.creditPayments).toHaveLength(0);
    expect([...fake.docs.keys()].filter((key) => key.includes('/credit_payments/'))).toHaveLength(
      0
    );
    expect(
      fake.docs.get(`shops/${shop.id}/sync_operations/${queued[0].id}`)?.resolution
    ).toMatchObject({
      kind: 'cancel-payment',
      originalAmount: 8,
      originalPayment: { note: 'duplicate', paymentMethod: 'momo' },
    });
    expect([...fake.docs.keys()].some((key) => key.includes('/expenses/'))).toBe(true);
  });

  it('refuses a stale review and invalid amounts without changing any entry', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8);
    });
    const id = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0].id;
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    const review = await current.loadSyncReview(id);
    await expect(
      current.resolveSyncReview(review, { kind: 'correct-payment', amount: 6 })
    ).rejects.toThrow(/current balance/);
    fake.docs.set(path, { ...customer, totalOwed: 4 });
    await act(async () => {
      await expect(
        current.resolveSyncReview(review, { kind: 'correct-payment', amount: 3 })
      ).rejects.toThrow(/balance changed/i);
    });
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.has(`shops/${shop.id}/sync_operations/${id}`)).toBe(false);
    expect([...fake.docs.keys()].some((key) => key.includes('/credit_payments/'))).toBe(false);
    await act(async () => {
      fake.auth.currentUser = {
        id: 'wrong-owner',
        phone: '+260966000000',
        email: null,
        isPlatformAdmin: false,
        verifiedShopId: null,
      };
      fake.emitAuth();
    });
    await expect(current.loadSyncReview(id)).rejects.toThrow(/original shop account/i);
    expect(current.pendingSyncCount).toBe(1);
  });

  it('resumes a reviewed payment after cloud commit but before local acknowledgement', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8);
      await current.addExpense('rent', 1);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    const review = await current.loadSyncReview(queued[0].id);
    fake.failNextVerification = true;
    await act(async () => {
      await expect(
        current.resolveSyncReview(review, { kind: 'correct-payment', amount: 4 })
      ).rejects.toThrow(/saved in the cloud/i);
    });
    expect(current.pendingSyncCount).toBe(2);
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect(fake.docs.get(queued[0].writes[0].path)?.amount).toBe(4);
    fake.transactionError = null;
    await act(async () => {
      await current.syncNow();
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect([...fake.docs.keys()].filter((key) => key.includes('/credit_payments/'))).toHaveLength(
      1
    );
    expect(current.creditPayments[0].amount).toBe(4);
    expect([...fake.docs.keys()].filter((key) => key.includes('/expenses/'))).toHaveLength(1);
  });

  it('recovers a committed review after local storage fails and the browser restarts', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8);
      await current.addExpense('rent', 1);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    const firstId = queued[0].id;
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    const review = await current.loadSyncReview(firstId);
    const original = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (
          key === 'countup_pending_queue' &&
          !JSON.parse(value).some((entry: { id: string }) => entry.id === firstId)
        )
          throw new Error('Storage full');
        return original.call(this, key, value);
      });
    await act(async () => {
      await expect(
        current.resolveSyncReview(review, { kind: 'correct-payment', amount: 4 })
      ).rejects.toThrow(/saved in the cloud/i);
    });
    expect(current.pendingSyncCount).toBe(2);
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect(fake.docs.get(`shops/${shop.id}/sync_operations/${firstId}`)?.hasResolution).toBe(true);
    storage.mockRestore();
    cleanup();
    await mount();
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect(current.customers[0].totalOwed).toBe(1);
    expect(current.creditPayments[0].amount).toBe(4);
    expect([...fake.docs.keys()].filter((key) => key.includes('/credit_payments/'))).toHaveLength(
      1
    );
    expect([...fake.docs.keys()].filter((key) => key.includes('/expenses/'))).toHaveLength(1);
  });

  it('keeps a sale when its conflicting undo is cancelled, and rebases later stock changes', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 5,
      quantity: 8,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const sale = {
      id: 'sale_a',
      shopId: shop.id,
      items: [{ itemId: item.id, name: item.name, quantity: 2, buyingPrice: 1, sellingPrice: 5 }],
      itemsCount: 2,
      totalAmount: 10,
      totalCost: 2,
      profit: 8,
      paymentType: 'credit',
      customerId: customer.id,
      customerName: customer.name,
      createdAt: new Date().toISOString(),
      receiptNumber: 'CU-001',
    };
    const customerPath = `shops/${shop.id}/customers/${customer.id}`;
    const itemPath = `shops/${shop.id}/items/${item.id}`;
    const salePath = `shops/${shop.id}/sales/${sale.id}`;
    fake.docs.set(customerPath, customer);
    fake.docs.set(itemPath, item);
    fake.docs.set(salePath, sale);
    await mount();
    await waitFor(() => expect(current.sales).toHaveLength(1));
    await act(async () => {
      await current.voidSale(sale.id);
      await current.recordSale({
        items: [{ itemId: item.id, name: item.name, quantity: 1, buyingPrice: 1, sellingPrice: 5 }],
        itemsCount: 1,
        totalAmount: 5,
        totalCost: 1,
        profit: 4,
        paymentType: 'cash',
      });
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!);
    fake.docs.set(customerPath, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.blockedSync).toEqual({ actionId: queued[0].id, kind: 'void' });
    const review = await current.loadSyncReview(queued[0].id);
    expect(review).toMatchObject({ receipt: 'CU-001', serverBalance: 5, originalAmount: 10 });
    fake.failMarker = queued[1].id;
    await act(async () => {
      await current.resolveSyncReview(review, { kind: 'keep-sale' });
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(1));
    expect(current.items[0].quantity).toBe(7); // Server's 8 minus the later sale, not the cancelled restore.
    expect(current.customers[0].totalOwed).toBe(5);
    expect(current.sales.map((entry) => entry.id)).toContain(sale.id);
    expect(current.stockMovements.some((entry) => entry.type === 'void')).toBe(false);
    expect(
      fake.docs.get(`shops/${shop.id}/sync_operations/${queued[0].id}`)?.resolution
    ).toMatchObject({
      kind: 'keep-sale',
      saleId: sale.id,
      originalAmount: 10,
      stockRestorations: [{ itemId: item.id, quantity: 2 }],
    });
    fake.failMarker = null;
    await act(async () => {
      await current.syncNow();
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(itemPath)?.quantity).toBe(7);
    expect(fake.docs.get(customerPath)?.totalOwed).toBe(5);
    expect(fake.docs.get(salePath)?.isDeleted).not.toBe(true);
    expect([...fake.docs.keys()].filter((key) => key.includes('/sales/'))).toHaveLength(2);
  });

  it('can retry the original unchanged payment when the server balance has recovered', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.recordCreditPayment(customer.id, 8);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0];
    fake.docs.set(path, { ...customer, totalOwed: 5 });
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    fake.docs.set(path, { ...customer, totalOwed: 9 });
    const review = await current.loadSyncReview(queued.id);
    expect(review).toMatchObject({ canRetry: true, originalAmount: 8, serverBalance: 9 });
    await expect(current.resolveSyncReview(review, { kind: 'cancel-payment' })).rejects.toThrow(
      /out of date/i
    );
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(path)?.totalOwed).toBe(1);
    expect(fake.docs.get(queued.writes[0].path)?.amount).toBe(8);
    expect(
      fake.docs.get(`shops/${shop.id}/sync_operations/${queued.id}`)?.resolution
    ).toBeUndefined();
  });

  it('does not undo a credit sale if its customer is missing locally', async () => {
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 5,
      quantity: 8,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const sale = {
      id: 'sale_a',
      shopId: shop.id,
      items: [{ itemId: item.id, name: item.name, quantity: 2, buyingPrice: 1, sellingPrice: 5 }],
      itemsCount: 2,
      totalAmount: 10,
      totalCost: 2,
      profit: 8,
      paymentType: 'credit',
      customerId: 'missing',
      createdAt: new Date().toISOString(),
    };
    fake.docs.set(`shops/${shop.id}/items/${item.id}`, item);
    fake.docs.set(`shops/${shop.id}/sales/${sale.id}`, sale);
    await mount();
    await waitFor(() => expect(current.sales).toHaveLength(1));
    await expect(current.voidSale(sale.id)).rejects.toThrow(/customer.*missing/i);
    expect(current.pendingSyncCount).toBe(0);
    expect(current.items[0].quantity).toBe(8);
    expect(current.sales).toHaveLength(1);
  });

  it('does not restore stock or subtract credit twice when two devices undo the same sale', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Mwamba',
      phone: '',
      notes: '',
      totalOwed: 20,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 5,
      quantity: 8,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const sale = {
      id: 'sale_a',
      shopId: shop.id,
      items: [{ itemId: item.id, name: item.name, quantity: 2, buyingPrice: 1, sellingPrice: 5 }],
      itemsCount: 2,
      totalAmount: 10,
      totalCost: 2,
      profit: 8,
      paymentType: 'credit',
      customerId: customer.id,
      customerName: customer.name,
      createdAt: new Date().toISOString(),
    };
    const customerPath = `shops/${shop.id}/customers/${customer.id}`;
    const itemPath = `shops/${shop.id}/items/${item.id}`;
    const salePath = `shops/${shop.id}/sales/${sale.id}`;
    fake.docs.set(customerPath, customer);
    fake.docs.set(itemPath, item);
    fake.docs.set(salePath, sale);
    await mount();
    await waitFor(() => expect(current.sales).toHaveLength(1));
    await act(async () => {
      await current.voidSale(sale.id);
    });
    const queued = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0];
    // Another device completed its own undo before this phone reconnects.
    fake.docs.set(customerPath, { ...customer, totalOwed: 10 });
    fake.docs.set(itemPath, { ...item, quantity: 10 });
    fake.docs.set(salePath, { ...sale, isDeleted: true });
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(0);
    expect(fake.docs.get(customerPath)?.totalOwed).toBe(10);
    expect(fake.docs.get(itemPath)?.quantity).toBe(10);
    expect(fake.docs.get(`shops/${shop.id}/sync_operations/${queued.id}`)).toMatchObject({
      outcome: 'already-voided',
      saleId: sale.id,
    });
    expect([...fake.docs.keys()].filter((key) => key.includes('/stock_movements/'))).toHaveLength(
      0
    );
  });

  it('does not overwrite newer stock with an old physical count; it records a recount notice', async () => {
    const item = {
      id: 'item_a',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 2,
      quantity: 10,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/items/${item.id}`;
    fake.docs.set(path, item);
    await mount();
    await waitFor(() => expect(current.items).toHaveLength(1));
    await act(async () => {
      await current.adjustStock(item.id, 'set', 12, 'Count before reconnecting');
      await current.addExpense('rent', 1);
    });
    fake.docs.set(path, { ...item, quantity: 8 });
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(0);
    expect(fake.docs.get(path)?.quantity).toBe(8);
    const conflict = [...fake.docs.entries()].find(([key]) =>
      key.includes('/stock_conflicts/')
    )?.[1];
    expect(conflict).toMatchObject({
      kind: 'recount',
      observed: 10,
      requested: 12,
      available: 8,
      resolved: false,
    });
    const movement = [...fake.docs.entries()].find(([key]) =>
      key.includes('/stock_movements/')
    )?.[1];
    expect(movement).toMatchObject({
      delta: 0,
      requestedQuantity: 12,
      recountNeeded: true,
      previousQuantity: 8,
      newQuantity: 8,
    });
    expect([...fake.docs.keys()].some((key) => key.includes('/expenses/'))).toBe(true);
  });

  it('does not replay an acknowledged metadata write over a newer server edit', async () => {
    const customer = {
      id: 'customer_a',
      shopId: shop.id,
      name: 'Before',
      phone: '',
      notes: '',
      totalOwed: 0,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const path = `shops/${shop.id}/customers/${customer.id}`;
    fake.docs.set(path, customer);
    await mount();
    await waitFor(() => expect(current.customers).toHaveLength(1));
    await act(async () => {
      await current.updateCustomer(customer.id, { name: 'First', phone: '', notes: '' });
    });
    const action = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0];
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(path)?.name).toBe('First');
    fake.docs.set(path, { ...fake.docs.get(path), name: 'Newer on another device' });
    localStorage.setItem('countup_pending_queue', JSON.stringify([action]));
    cleanup();
    await mount();
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(path)?.name).toBe('Newer on another device');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('automatically retries transient server failures without waiting for an online event', async () => {
    await mount();
    await act(async () => {
      await current.addExpense('rent', 2);
    });
    vi.useFakeTimers();
    try {
      online(true);
      fake.transactionError = Object.assign(new Error('Unavailable'), { code: 'unavailable' });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await act(async () => {
        await current.syncNow();
      });
      expect(current.pendingSyncCount).toBe(1);
      expect(current.lastOfflineNotice).toMatch(/retry automatically/i);
      fake.transactionError = null;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(current.pendingSyncCount).toBe(0);
      expect([...fake.docs.keys()].some((key) => key.includes('/expenses/'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not continuously retry a permission failure', async () => {
    await mount();
    await act(async () => {
      await current.addExpense('rent', 2);
    });
    vi.useFakeTimers();
    try {
      online(true);
      fake.transactionError = Object.assign(new Error('Permission denied'), {
        code: 'permission-denied',
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await act(async () => {
        await current.syncNow();
      });
      const attempts = fake.transactionAttempts;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120000);
      });
      expect(fake.transactionAttempts).toBe(attempts);
      expect(current.pendingSyncCount).toBe(1);
      expect(current.lastOfflineNotice).toMatch(/permission denied/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reauthenticates the existing shop identity via SMS OTP without discarding state and supports admin password reset', async () => {
    online(true);
    await mount();
    expect(current.user?.uid).toBe('owner-1');
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('owner-1');

    // Simulate an expired Supabase session while the original shop data is still open.
    await act(async () => {
      fake.auth.currentUser = null;
      fake.emitAuth();
    });
    expect(current.needsShopAccountRecovery).toBe(true);
    await expect(current.restoreShopSessionWithOtp('000000')).rejects.toThrow(
      /Invalid or expired SMS verification code/
    );
    await act(async () => {
      await current.restoreShopSessionWithOtp('123456');
    });
    expect(current.shop?.id).toBe(shop.id);
    expect(fake.auth.currentUser?.id).toBe(shop.ownerUid);
    await act(async () => {
      await current.resetEmailPassword('owner@example.com');
    });
    expect(fake.resets).toEqual(['owner@example.com']);
  });

  it('imports a valid backup atomically and refuses repeat imports without overwriting existing records', async () => {
    online(true);
    await mount();
    const raw = JSON.stringify({
      format: 'shopbook-backup-v1',
      exportedAt: shop.createdAt,
      shopSettings: { shopName: 'Old Shop' },
      products: [
        {
          id: 'p1',
          name: 'Tea',
          unitLabel: 'box',
          sellingPriceNgwee: 250,
          costPriceNgwee: null,
          stockQty: 4,
          lowStockThreshold: 2,
          isArchived: false,
          createdAt: shop.createdAt,
          updatedAt: shop.createdAt,
        },
      ],
      sales: [],
      saleItems: [],
      stockMovements: [],
      customers: [],
      creditTransactions: [],
    });
    await act(async () => {
      await current.importLegacyBackup(raw);
    });
    expect(fake.docs.get(`shops/${shop.id}/items/shopbook_p1`)).toMatchObject({
      name: 'Tea',
      sellingPrice: 2.5,
      buyingPriceKnown: false,
    });
    expect(current.items.some((item) => item.id === 'shopbook_p1')).toBe(true);
    const before = [...fake.docs.entries()];
    await expect(current.importLegacyBackup(raw)).rejects.toThrow(/already/);
    expect([...fake.docs.entries()]).toEqual(before);
  });

  it('recovers an open shop and its queued business records after an interrupted cache update', async () => {
    fake.auth.currentUser = null;
    fake.docs.clear();
    localStorage.setItem('countup_active_shop', JSON.stringify(shop));
    const product = {
      id: 'item_queued',
      shopId: shop.id,
      name: 'Tea',
      buyingPrice: 1,
      sellingPrice: 2,
      quantity: 5,
      lowStockThreshold: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const sale = {
      id: 'sale_queued',
      shopId: shop.id,
      items: [
        { itemId: product.id, name: product.name, quantity: 2, buyingPrice: 1, sellingPrice: 2 },
      ],
      itemsCount: 2,
      totalAmount: 4,
      totalCost: 2,
      profit: 2,
      paymentType: 'cash',
      createdAt: shop.createdAt,
    };
    const action = (id: string, writes: { path: string; data: object }[]) => ({
      id,
      type: 'item',
      timestamp: 1,
      ...writes[0],
      writes,
    });
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        action('create-item', [{ path: `shops/${shop.id}/items/${product.id}`, data: product }]),
        action('sale', [
          { path: `shops/${shop.id}/sales/${sale.id}`, data: sale },
          { path: `shops/${shop.id}/items/${product.id}`, data: { ...product, quantity: 3 } },
        ]),
      ])
    );
    await mount();
    expect(current.shop?.id).toBe(shop.id);
    expect(current.items[0]).toMatchObject({ name: 'Tea', quantity: 3 });
    expect(current.sales[0]).toMatchObject({ id: sale.id, totalAmount: 4 });
    expect(current.pendingSyncCount).toBe(2);
  });

  it('replays queued archives and expense deletions after restart and strips any legacy plain-text PIN', async () => {
    const product = {
      id: 'old-item',
      shopId: shop.id,
      name: 'Tea',
      quantity: 3,
      lowStockThreshold: 1,
      buyingPrice: 1,
      sellingPrice: 2,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const expense = {
      id: 'old-expense',
      shopId: shop.id,
      category: 'transport',
      amount: 1,
      createdAt: shop.createdAt,
    };
    localStorage.setItem('countup_active_shop', JSON.stringify({ ...shop, pin: '4321' }));
    writeVersionedDomainCollection(shop.id, 'items', [product], localStorage);
    writeVersionedDomainCollection(shop.id, 'expenses', [expense], localStorage);
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        {
          id: 'archive',
          type: 'item',
          timestamp: 1,
          path: `shops/${shop.id}/items/${product.id}`,
          data: { isDeleted: true },
        },
        {
          id: 'expense',
          type: 'expense',
          timestamp: 2,
          path: `shops/${shop.id}/expenses/${expense.id}`,
          data: { isDeleted: true },
        },
      ])
    );
    await mount();
    expect(current.items).toHaveLength(0);
    expect(current.archivedItems[0]).toMatchObject({ id: product.id, isDeleted: true });
    expect(current.expenses).toHaveLength(0);
    expect((current.shop as unknown as { pin?: string })?.pin).toBeUndefined();
    expect(current.pendingSyncCount).toBe(2);
  });

  it('starts a real online shop via verified SMS OTP with random UUID, one-time recovery code, salted PBKDF2 PIN, and empty business records', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.serverShops.clear();
    fake.usedPhones.clear();
    fake.auth.currentUser = null;
    online(true);
    await mount();

    await act(async () => {
      await current.sendPhoneVerificationCode('0966 123 456');
      const status = await current.verifyPhoneVerificationCode('0966 123 456', '123456');
      expect(status.hasShop).toBe(false);
    });

    let regResult!: { recoveryCode: string; trialGranted: boolean };
    await act(async () => {
      regResult = await current.completeShopRegistration('Owner entered shop', '2580');
    });

    expect(regResult.trialGranted).toBe(true);
    expect(regResult.recoveryCode).toMatch(/^CU-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(current.pendingRecoveryCode).toBe(regResult.recoveryCode);
    expect(current.shop?.name).toBe('Owner entered shop');
    expect(current.shop?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(current.shop?.id).not.toContain('966123456');
    expect(current.items).toHaveLength(0);
    expect(current.archivedItems).toHaveLength(0);
    expect(current.sales).toHaveLength(0);
    expect(current.customers).toHaveLength(0);
    expect(current.creditPayments).toHaveLength(0);
    expect(current.expenses).toHaveLength(0);
    expect(current.stockMovements).toHaveLength(0);
    expect(current.pendingSyncCount).toBe(0);
    expect(hasLocalPinRecord(current.shop!.id)).toBe(true);
    expect((await verifyLocalPin(current.shop!.id, '2580')).unlocked).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain('"2580"');
  });

  it('enforces one free trial per verified phone across shop deletion and re-registration', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.serverShops.clear();
    fake.usedPhones.clear();
    fake.auth.currentUser = null;
    online(true);
    await mount();

    await act(async () => {
      await current.sendPhoneVerificationCode('+260 977 222 333');
      await current.verifyPhoneVerificationCode('+260 977 222 333', '123456');
      const first = await current.completeShopRegistration('First Shop', '1234');
      expect(first.trialGranted).toBe(true);
    });
    expect(current.shop?.planStatus).toBe('trial');

    await act(async () => {
      expect(await current.deleteShopAccount('First Shop', '1234')).toBe(true);
    });
    expect(current.shop).toBeNull();

    await act(async () => {
      await current.sendPhoneVerificationCode('0977222333');
      await current.verifyPhoneVerificationCode('0977222333', '123456');
      const second = await current.completeShopRegistration('Second Shop', '4321');
      expect(second.trialGranted).toBe(false);
    });
    expect(current.shop?.planStatus).toBe('expired');
  });

  it('locks and unlocks the open shop 100% offline on the same device without calling the server', async () => {
    online(false);
    await mount();
    expect(current.isScreenLocked).toBe(false);

    act(() => {
      current.lockScreen();
    });
    expect(current.isScreenLocked).toBe(true);

    await act(async () => {
      const bad = await current.unlockLocalScreen('9999');
      expect(bad.unlocked).toBe(false);
    });
    expect(current.isScreenLocked).toBe(true);

    await act(async () => {
      const good = await current.unlockLocalScreen('1234');
      expect(good.unlocked).toBe(true);
    });
    expect(current.isScreenLocked).toBe(false);
  });

  it('refuses new shop registration while offline or before SMS OTP is verified', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    online(false);
    await mount();

    await expect(current.sendPhoneVerificationCode('0977000000')).rejects.toThrow(/internet/i);
    await expect(current.completeShopRegistration('Offline shop', '1234')).rejects.toThrow(
      /Verify your phone number online/i
    );
    expect(current.shop).toBeNull();
  });

  it('keeps an existing shop queue safe when its Supabase session expires', async () => {
    fake.auth.currentUser = null;
    online(true);
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        {
          id: 'pending',
          type: 'expense',
          path: `shops/${shop.id}/expenses/expense-a`,
          data: { id: 'expense-a', amount: 2 },
          timestamp: 1,
        },
      ])
    );
    await mount();
    await waitFor(() => expect(current.lastOfflineNotice).toMatch(/original shop account/i));
    expect(current.needsShopAccountRecovery).toBe(true);
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);
  });

  it('does not sync an established shop with a different signed-in UID', async () => {
    fake.auth.currentUser = {
      id: 'other-owner',
      phone: '+260966999888',
      email: null,
      isPlatformAdmin: false,
      verifiedShopId: null,
    };
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        {
          id: 'pending',
          type: 'expense',
          path: `shops/${shop.id}/expenses/expense-a`,
          data: { id: 'expense-a', amount: 2 },
          timestamp: 1,
        },
      ])
    );
    online(true);
    await mount();
    await waitFor(() => expect(current.lastOfflineNotice).toMatch(/different account/i));
    expect(current.needsShopAccountRecovery).toBe(true);
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.auth.currentUser?.id).toBe('other-owner');
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);
  });

  it('reconnects only the original owner phone via SMS OTP without discarding pending entries', async () => {
    fake.auth.currentUser = null;
    fake.phoneUsers.set('+260977000000', { uid: 'wrong-uid', otp: '999999' });
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        {
          id: 'pending',
          type: 'expense',
          path: `shops/${shop.id}/expenses/expense-a`,
          data: { id: 'expense-a', amount: 2 },
          timestamp: 1,
        },
      ])
    );
    online(true);
    await mount();
    expect(current.needsShopAccountRecovery).toBe(true);

    await act(async () => {
      await expect(current.restoreShopSessionWithOtp('999999')).rejects.toThrow(
        /does not match the original shop/i
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);

    fake.phoneUsers.set('+260977000000', { uid: 'owner-1', otp: '123456' });
    await act(async () => {
      await current.restoreShopSessionWithOtp('123456');
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(`shops/${shop.id}/expenses/expense-a`)).toMatchObject({ amount: 2 });
    expect(current.needsShopAccountRecovery).toBe(false);
  });

  it('keeps verifiedShopId null after SMS OTP until new-device PIN unlock succeeds (SIM-swap protection)', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    online(true);
    await mount();

    await act(async () => {
      const status = await current.verifyPhoneVerificationCode('+260977000000', '123456');
      expect(status.hasShop).toBe(true);
      expect(status.sessionVerified).toBe(false);
    });
    expect(current.user?.verifiedShopId).toBeNull();
    expect(current.shop).toBeNull();

    await expect(current.unlockCloudShopWithPin('0000')).rejects.toThrow(/Incorrect PIN/i);
    expect(current.shop).toBeNull();

    await act(async () => {
      await current.unlockCloudShopWithPin('1234');
    });
    expect(current.shop?.id).toBe(shop.id);
    expect(current.user?.verifiedShopId).toBe(shop.id);
  });

  it('recovers a locked-out shop on a new device with the one-time recovery code and rotates the code', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.serverShops.get(shop.id)!.lockedUntilMs = Date.now() + 60 * 60_000;
    online(true);
    await mount();

    await act(async () => {
      const status = await current.verifyPhoneVerificationCode('0977 000 000', '123456');
      expect(status.isLockedOut).toBe(true);
    });

    await expect(current.unlockCloudShopWithPin('1234')).rejects.toThrow(/Too many incorrect PIN/i);

    let rotated = '';
    await act(async () => {
      const res = await current.recoverCloudShopPin('cu abcd efgh jklm', '8888');
      rotated = res.recoveryCode;
    });
    expect(rotated).not.toBe('CU-ABCD-EFGH-JKLM');
    expect(current.pendingRecoveryCode).toBe(rotated);
    expect(current.shop?.id).toBe(shop.id);
    expect((await verifyLocalPin(shop.id, '8888')).unlocked).toBe(true);
  });

  it('blocks opening or creating another shop when unsynced entries exist on this phone', async () => {
    online(true);
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        {
          id: 'pending',
          type: 'expense',
          path: `shops/${shop.id}/expenses/expense-a`,
          data: { id: 'expense-a', amount: 5 },
          timestamp: 1,
        },
      ])
    );
    fake.auth.currentUser = {
      id: 'new-user',
      phone: '+260955111222',
      email: null,
      isPlatformAdmin: false,
      verifiedShopId: null,
    };
    await mount();

    await expect(current.completeShopRegistration('Another Shop', '1234')).rejects.toThrow(
      /Sync pending entries/i
    );
    await expect(current.unlockCloudShopWithPin('1234')).rejects.toThrow(/Sync pending entries/i);
  });

  it('preserves suspension state across shop deletion so a suspended phone cannot escape suspension', async () => {
    online(true);
    const suspendedShop: Shop = { ...shop, isDeactivated: true, planStatus: 'suspended' };
    localStorage.setItem('countup_active_shop', JSON.stringify(suspendedShop));
    fake.serverShops.set(shop.id, {
      shop: suspendedShop,
      pin: '1234',
      recoveryCode: 'CU-ABCD-EFGH-JKLM',
      failedAttempts: 0,
      lockedUntilMs: null,
    });
    await mount();

    await act(async () => {
      expect(await current.deleteShopAccount(shop.name, '1234')).toBe(true);
    });
    expect(current.shop).toBeNull();

    await act(async () => {
      await current.verifyPhoneVerificationCode(shop.ownerPhone, '123456');
      await current.completeShopRegistration('Reopened Shop', '5678');
    });
    expect(current.shop?.isDeactivated).toBe(true);
    expect(current.shop?.planStatus).toBe('suspended');
  });

  it('admin reset PIN lockout requires an identity check note, writes audit log, and notifies the shop device', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.adminUids.add('admin-1');
    fake.serverShops.get(shop.id)!.lockedUntilMs = Date.now() + 60_000;
    await mount();

    await act(async () => {
      await current.loginAsAdmin('admin@example.com', 'strongpass123');
    });
    await waitFor(() => expect(current.allShops).toHaveLength(1));

    await expect(current.adminResetPinLockout(shop.id, 'too short')).rejects.toThrow(
      /between 10 and 500 characters/i
    );

    await act(async () => {
      await current.adminResetPinLockout(
        shop.id,
        'Spoke with owner on verified phone +260977000000 and confirmed recent items'
      );
    });
    expect(fake.auditLogs).toContainEqual(
      expect.objectContaining({ action: 'shop_pin_lockout_reset', shopId: shop.id })
    );
    expect(fake.serverShops.get(shop.id)?.lockedUntilMs).toBeNull();
    expect(fake.serverShops.get(shop.id)?.shop.securityNotice).toMatch(/Security alert/i);
  });

  it('displays and acknowledges a server security notice on the shop owner device', async () => {
    online(true);
    const noticedShop: Shop = {
      ...shop,
      securityNotice: 'Security alert: Platform support reset your shop’s new-device PIN lockout.',
      securityNoticeAt: new Date().toISOString(),
    };
    localStorage.setItem('countup_active_shop', JSON.stringify(noticedShop));
    fake.serverShops.get(shop.id)!.shop = noticedShop;
    fake.docs.set(`shops/${shop.id}`, { ...noticedShop });

    render(<App />);
    expect(await screen.findByText(/Platform support reset your shop/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss alert' }));
    await waitFor(() => expect(screen.queryByText(/Platform support reset your shop/i)).toBeNull());
  });

  it('warns when server shop deletion fails and keeps the local shop intact', async () => {
    fake.failDelete = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    online(true);
    await mount();
    await act(async () => {
      expect(await current.deleteShopAccount(shop.name, '1234')).toBe(false);
    });
    expect(current.shop?.id).toBe(shop.id);
    expect(screen.getByText(/Some records may already have been removed/i)).toBeTruthy();
  });

  it('waits for in-flight server deletion to settle before reporting a failure', async () => {
    fake.failDelete = true;
    let finish!: () => void;
    fake.deleteGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    online(true);
    await mount();
    let deletion!: Promise<boolean>;
    act(() => {
      deletion = current.deleteShopAccount(shop.name, '1234');
    });
    expect(current.isLoading).toBe(true);
    await act(async () => {
      finish();
      expect(await deletion).toBe(false);
    });
    expect(current.isLoading).toBe(false);
  });

  it('unblocks the app if local cleanup fails after the cloud shop was removed', async () => {
    online(true);
    await mount();
    const original = Storage.prototype.removeItem;
    const storage = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (key) {
      if (key === 'countup_sales') throw new Error('Local storage unavailable');
      return original.call(this, key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      expect(await current.deleteShopAccount(shop.name, '1234')).toBe(false);
    });
    expect(current.isLoading).toBe(false);
    expect(fake.serverShops.has(shop.id)).toBe(false);
    expect(screen.getByText(/Local storage unavailable/i)).toBeTruthy();
    storage.mockRestore();
  });

  it('keeps the deletion dialog open and shows an error when server deletion fails', async () => {
    fake.failDelete = true;
    let finish!: () => void;
    fake.deleteGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    online(true);
    render(<App />);
    await screen.findByText('Welcome, CountUp Test');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Shop & Data' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete shop & all data' });
    fireEvent.change(within(dialog).getByLabelText(/Type CountUp Test to confirm/i), {
      target: { value: 'CountUp Test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Enter your 4-digit PIN/i), {
      target: { value: '1234' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }));
    await act(async () => finish());
    await waitFor(() => expect(within(dialog).getByText(/Deletion did not finish/i)).toBeTruthy());
  });

  it('does not enter a registered shop if saving its local PBKDF2 PIN lock fails', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.serverShops.clear();
    fake.usedPhones.clear();
    fake.auth.currentUser = null;
    online(true);
    await mount();

    await act(async () => {
      await current.sendPhoneVerificationCode('0977888999');
      await current.verifyPhoneVerificationCode('0977888999', '123456');
    });

    const original = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (key.startsWith('countup_pin_lock_v2:')) throw new Error('storage full');
        return original.call(this, key, value);
      });
    await expect(current.completeShopRegistration('New shop', '1234')).rejects.toThrow(
      /storage full/
    );
    expect(current.shop).toBeNull();
    storage.mockRestore();
  });

  it('updates server and local salted PBKDF2 PIN hashes in order and never stores plain-text PINs', async () => {
    online(true);
    await mount();
    await act(async () => {
      expect(await current.changePin('1234', '4321')).toBe(true);
    });
    await act(async () => {
      expect(await current.changePin('4321', '9876')).toBe(true);
    });
    await act(async () => {
      fake.docs.set(`shops/${shop.id}`, { ...shop });
      fake.emit();
    });
    expect((await verifyLocalPin(shop.id, '9876')).unlocked).toBe(true);
    expect((await verifyLocalPin(shop.id, '4321')).unlocked).toBe(false);
    expect(fake.serverShops.get(shop.id)?.pin).toBe('9876');
    expect(JSON.stringify(localStorage)).not.toContain('"9876"');
  });

  it('signs out the standalone admin account if admin sign-in is cancelled', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-cancel', password: 'strongpass123' });
    fake.adminUids.add('admin-cancel');
    await mount();
    await act(async () => {
      await current.loginAsAdmin('admin@example.com', 'strongpass123');
    });
    expect(fake.auth.currentUser?.id).toBe('admin-cancel');
    await act(async () => {
      await current.cancelEmailLogin();
    });
    expect(fake.auth.currentUser).toBeNull();
  });

  it('normalizes national and international Zambian phone formats onto the same E.164 shop identity', async () => {
    online(true);
    await mount();
    await act(async () => {
      await current.logout();
    });
    await act(async () => {
      const status = await current.verifyPhoneVerificationCode('0977 000 000', '123456');
      expect(status.hasShop).toBe(true);
      await current.unlockCloudShopWithPin('1234');
    });
    expect(current.shop?.id).toBe(shop.id);
    expect(current.shop?.ownerPhone).toBe('+260977000000');
  });

  it('opens the real admin screen from the sign-in form and signs out on exit', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.adminUids.add('admin-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Admin sign in' }));
    fireEvent.change(screen.getByLabelText('Account email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'strongpass123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open admin console' }));
    expect(await screen.findByRole('heading', { name: 'Admin console' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(shop.name)).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' }).at(-1)!);
    await waitFor(() => expect(fake.auth.currentUser).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Create your shop' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Admin console' })).toBeNull();
  });

  it('signs a registered admin into the console without requiring a shop and signs out on exit', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.adminUids.add('admin-1');
    await mount();
    await act(async () => {
      await current.loginAsAdmin(' admin@example.com ', 'strongpass123');
    });
    await waitFor(() => expect(current.isAdmin).toBe(true));
    await waitFor(() => expect(current.allShops.some((entry) => entry.id === shop.id)).toBe(true));
    expect(current.shop).toBeNull();
    await act(async () => {
      await current.cancelEmailLogin();
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.isAdmin).toBe(false);
    expect(current.allShops).toEqual([]);
  });

  it('rejects non-admin and unverifiable accounts and does not leave them signed in', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('user@example.com', { uid: 'user-1', password: 'strongpass123' });
    await mount();
    await act(async () => {
      await expect(current.loginAsAdmin('user@example.com', 'strongpass123')).rejects.toThrow(
        /not authorized for platform administration/
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.isAdmin).toBe(false);
    fake.failAdminRead = true;
    await act(async () => {
      await expect(current.loginAsAdmin('user@example.com', 'strongpass123')).rejects.toThrow(
        /Server unavailable/
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.isAdmin).toBe(false);
  });

  it('protects an open shop and pending queue when entering admin sign-in', async () => {
    await mount();
    online(true);
    await expect(current.loginAsAdmin('admin@example.com', 'password')).rejects.toThrow(
      /Sign out of the shop/
    );
    expect(fake.auth.currentUser?.id).toBe('owner-1');
    online(false);
    // An offline pending queue must also block a switch, even without a shop.
    cleanup();
    localStorage.removeItem('countup_active_shop');
    localStorage.removeItem(activeShopCacheKey());
    fake.auth.currentUser = null;
    localStorage.setItem(
      'countup_pending_queue',
      JSON.stringify([
        { id: 'pending', type: 'item', path: 'shops/a/items/b', data: {}, timestamp: 1 },
      ])
    );
    await mount();
    online(true);
    await expect(current.loginAsAdmin('admin@example.com', 'password')).rejects.toThrow(
      /Sync pending shop entries/
    );
    expect(fake.auth.currentUser).toBeNull();
  });

  it('requires a live admin grant for changes and never reports failed or offline writes as saved', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.adminUids.add('admin-1');
    await mount();
    await act(async () => {
      await current.loginAsAdmin('admin@example.com', 'strongpass123');
    });
    await waitFor(() => expect(current.allShops).toHaveLength(1));
    const before = { ...fake.docs.get(`shops/${shop.id}`) };
    fake.failWrite = true;
    await act(async () => {
      await expect(current.adminExtendShop(shop.id, 30)).rejects.toThrow(/Write rejected/);
    });
    expect(fake.docs.get(`shops/${shop.id}`)).toEqual(before);
    expect(current.allShops[0].planStatus).toBe('trial');
    fake.failWrite = false;
    await act(async () => {
      await current.adminExtendShop(shop.id, 30);
      await current.adminToggleDeactivate(shop.id);
    });
    expect(fake.docs.get(`shops/${shop.id}`)).toMatchObject({
      planStatus: 'suspended',
      isDeactivated: true,
    });
    online(false);
    await expect(current.adminToggleDeactivate(shop.id)).rejects.toThrow(/internet/);
    expect(fake.docs.get(`shops/${shop.id}`)?.isDeactivated).toBe(true);
  });

  it('does not carry an admin grant to a different Supabase user', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.adminUids.add('admin-1');
    await mount();
    await act(async () => {
      await current.loginAsAdmin('admin@example.com', 'strongpass123');
    });
    await waitFor(() => expect(current.isAdmin).toBe(true));
    await act(async () => {
      fake.auth.currentUser = {
        id: 'ordinary-user',
        phone: null,
        email: 'user@example.com',
        isPlatformAdmin: false,
        verifiedShopId: null,
      };
      fake.emitAuth();
    });
    expect(current.isAdmin).toBe(false);
    await expect(current.adminToggleDeactivate(shop.id)).rejects.toThrow(/Admin access/);
  });

  it('refuses an import from a non-owner and makes no writes', async () => {
    online(true);
    await mount();
    await act(async () => {
      fake.auth.currentUser = {
        id: 'other',
        phone: null,
        email: 'other@example.com',
        isPlatformAdmin: false,
        verifiedShopId: null,
      };
      fake.emitAuth();
    });
    const before = [...fake.docs.entries()];
    await expect(current.importLegacyBackup('{}')).rejects.toThrow(/owner/);
    expect([...fake.docs.entries()]).toEqual(before);
  });

  it('drains 520+ queued offline operations in bounded RPC batches and resumes cleanly on retry without duplicates', async () => {
    const item = {
      id: 'item_bulk',
      shopId: shop.id,
      name: 'Maize Meal 25kg',
      buyingPrice: 200,
      buyingPriceKnown: true,
      sellingPrice: 250,
      quantity: 1000,
      lowStockThreshold: 10,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    };
    const itemPath = `shops/${shop.id}/items/${item.id}`;
    fake.docs.set(itemPath, item);

    // Pre-populate 520 offline operations (sales + expenses) in the durable queue
    const nowIso = new Date().toISOString();
    const bulkQueue = Array.from({ length: 520 }, (_, i) => {
      if (i % 2 === 0) {
        const saleId = `bulk_sale_${i}`;
        const mvId = `bulk_mv_${i}`;
        const sale = {
          id: saleId,
          shopId: shop.id,
          items: [
            {
              itemId: item.id,
              name: item.name,
              quantity: 1,
              buyingPrice: 200,
              buyingPriceKnown: true,
              sellingPrice: 250,
              total: 250,
            },
          ],
          itemsCount: 1,
          totalAmount: 250,
          totalCost: 200,
          profit: 50,
          paymentType: 'cash',
          receiptNumber: `R-${i}`,
          createdAt: nowIso,
        };
        const mv = {
          id: mvId,
          shopId: shop.id,
          itemId: item.id,
          itemName: item.name,
          type: 'sale',
          delta: -1,
          previousQuantity: 1000 - i / 2,
          newQuantity: 1000 - i / 2 - 1,
          reason: `Sale R-${i}`,
          relatedSaleId: saleId,
          createdAt: nowIso,
        };
        return {
          id: `op_bulk_${i}`,
          type: 'sale',
          path: `shops/${shop.id}/sales/${saleId}`,
          data: sale,
          writes: [
            { path: `shops/${shop.id}/sales/${saleId}`, data: sale },
            { path: itemPath, data: { ...item, quantity: mv.newQuantity, updatedAt: nowIso } },
            { path: `shops/${shop.id}/stock_movements/${mvId}`, data: mv },
          ],
          adjustments: [
            {
              kind: 'stock',
              path: itemPath,
              delta: -1,
              updatedAt: nowIso,
              lastSoldAt: nowIso,
              movement: { path: `shops/${shop.id}/stock_movements/${mvId}`, data: mv },
            },
          ],
          timestamp: Date.now() - (520 - i) * 100,
          queuedOffline: true,
        };
      }
      const expId = `bulk_exp_${i}`;
      const exp = {
        id: expId,
        shopId: shop.id,
        category: 'transport',
        amount: 15,
        note: `Trip ${i}`,
        createdAt: nowIso,
      };
      return {
        id: `op_bulk_${i}`,
        type: 'expense',
        path: `shops/${shop.id}/expenses/${expId}`,
        data: exp,
        writes: [{ path: `shops/${shop.id}/expenses/${expId}`, data: exp }],
        timestamp: Date.now() - (520 - i) * 100,
        queuedOffline: true,
      };
    });

    localStorage.setItem('countup_pending_queue', JSON.stringify(bulkQueue));
    await mount();
    expect(current.pendingSyncCount).toBe(520);

    // Simulate a transient network failure on op_bulk_225 (inside the 5th 50-op batch)
    fake.failMarker = 'op_bulk_225';
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    // First 225 operations (batches 1..4 = 200 + 25 in batch 5) succeeded and were acknowledged;
    // remaining 295 operations stay queued in exact FIFO order!
    expect(current.pendingSyncCount).toBe(520 - 225);

    // Clear the fault and retry: remaining 295 operations drain cleanly with zero double-deduction!
    fake.failMarker = null;
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(0);
    // 260 sales of 1 unit each deducted exactly 260 from 1000 -> 740 remaining
    expect(fake.docs.get(itemPath)?.quantity).toBe(740);
    // Batch chunking kept RPC calls way below 520 (ceil(225/50)=5 + ceil(295/50)=6 = 11 RPC round-trips!)
    expect(fake.transactionAttempts).toBeLessThanOrEqual(
      Math.ceil(520 / SYNC_BATCH_CHUNK_SIZE) + 2
    );
  });

  it('halts on a poison operation without losing later entries, records a discard-poison audit on owner confirmation, and drains the remaining queue', async () => {
    const validItemPath = `shops/${shop.id}/items/item_valid_tea`;
    fake.docs.set(validItemPath, {
      id: 'item_valid_tea',
      shopId: shop.id,
      name: 'Valid Tea',
      buyingPrice: 5,
      buyingPriceKnown: true,
      sellingPrice: 10,
      quantity: 20,
      lowStockThreshold: 3,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
    });

    const poisonAndValidQueue = [
      {
        id: 'op_poison_missing_item',
        type: 'stock_update' as const,
        timestamp: Date.now() - 5_000,
        path: `shops/${shop.id}/items/ghost_deleted_item`,
        data: { quantity: 10, updatedAt: shop.createdAt },
        writes: [
          {
            path: `shops/${shop.id}/items/ghost_deleted_item`,
            data: { quantity: 10, updatedAt: shop.createdAt },
          },
          {
            path: `shops/${shop.id}/stock_movements/mv_poison_1`,
            data: {
              id: 'mv_poison_1',
              shopId: shop.id,
              itemId: 'ghost_deleted_item',
              itemName: 'Deleted Sugar',
              type: 'restock',
              delta: 5,
              previousQuantity: 5,
              newQuantity: 10,
              reason: 'Restock',
              createdAt: shop.createdAt,
            },
          },
        ],
        adjustments: [
          {
            kind: 'stock' as const,
            path: `shops/${shop.id}/items/ghost_deleted_item`,
            delta: 5,
            updatedAt: shop.createdAt,
            movement: {
              path: `shops/${shop.id}/stock_movements/mv_poison_1`,
              data: {
                id: 'mv_poison_1',
                shopId: shop.id,
                itemId: 'ghost_deleted_item',
                itemName: 'Deleted Sugar',
                type: 'restock',
                delta: 5,
                previousQuantity: 5,
                newQuantity: 10,
                reason: 'Restock',
                createdAt: shop.createdAt,
              },
            },
          },
        ],
      },
      {
        id: 'op_valid_sale_after_poison',
        type: 'sale' as const,
        timestamp: Date.now() - 2_000,
        path: `shops/${shop.id}/sales/sale_after_poison`,
        data: {
          id: 'sale_after_poison',
          shopId: shop.id,
          items: [
            {
              itemId: 'item_valid_tea',
              name: 'Valid Tea',
              quantity: 2,
              buyingPrice: 5,
              buyingPriceKnown: true,
              sellingPrice: 10,
              total: 20,
            },
          ],
          itemsCount: 2,
          totalAmount: 20,
          totalCost: 10,
          profit: 10,
          paymentType: 'cash',
          receiptNumber: 'CU-AFTER-POISON',
          createdAt: shop.createdAt,
        },
        writes: [
          {
            path: `shops/${shop.id}/sales/sale_after_poison`,
            data: {
              id: 'sale_after_poison',
              shopId: shop.id,
              items: [
                {
                  itemId: 'item_valid_tea',
                  name: 'Valid Tea',
                  quantity: 2,
                  buyingPrice: 5,
                  buyingPriceKnown: true,
                  sellingPrice: 10,
                  total: 20,
                },
              ],
              itemsCount: 2,
              totalAmount: 20,
              totalCost: 10,
              profit: 10,
              paymentType: 'cash',
              receiptNumber: 'CU-AFTER-POISON',
              createdAt: shop.createdAt,
            },
          },
          {
            path: validItemPath,
            data: { quantity: 18, updatedAt: shop.createdAt },
          },
          {
            path: `shops/${shop.id}/stock_movements/mv_valid_after_poison`,
            data: {
              id: 'mv_valid_after_poison',
              shopId: shop.id,
              itemId: 'item_valid_tea',
              itemName: 'Valid Tea',
              type: 'sale',
              delta: -2,
              previousQuantity: 20,
              newQuantity: 18,
              reason: 'Sale CU-AFTER-POISON',
              relatedSaleId: 'sale_after_poison',
              createdAt: shop.createdAt,
            },
          },
        ],
        adjustments: [
          {
            kind: 'stock' as const,
            path: validItemPath,
            delta: -2,
            updatedAt: shop.createdAt,
            movement: {
              path: `shops/${shop.id}/stock_movements/mv_valid_after_poison`,
              data: {
                id: 'mv_valid_after_poison',
                shopId: shop.id,
                itemId: 'item_valid_tea',
                itemName: 'Valid Tea',
                type: 'sale',
                delta: -2,
                previousQuantity: 20,
                newQuantity: 18,
                reason: 'Sale CU-AFTER-POISON',
                relatedSaleId: 'sale_after_poison',
                createdAt: shop.createdAt,
              },
            },
          },
        ],
      },
    ];

    localStorage.setItem('countup_pending_queue', JSON.stringify(poisonAndValidQueue));
    await mount();
    expect(current.pendingSyncCount).toBe(2);

    online(true);
    await act(async () => {
      await current.syncNow();
    });

    // Queue halted on the poison entry; BOTH entries remain safe until owner reviews
    expect(current.pendingSyncCount).toBe(2);
    expect(current.blockedSync).toMatchObject({
      actionId: 'op_poison_missing_item',
      kind: 'poison',
      actionType: 'stock_update',
    });

    // Owner reviews and confirms discarding the poison entry
    await act(async () => {
      await current.discardBlockedSyncAction('op_poison_missing_item');
    });

    // Remaining valid sale automatically drains and commits!
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(current.blockedSync).toBeNull();
    expect(fake.docs.get(`shops/${shop.id}/sales/sale_after_poison`)).toMatchObject({
      receiptNumber: 'CU-AFTER-POISON',
      totalAmount: 20,
    });
    expect(fake.docs.get(validItemPath)?.quantity).toBe(18);

    // Discard decision is permanently recorded in sync review history
    const history = await current.loadSyncResolutionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actionId: 'op_poison_missing_item',
      kind: 'discard-poison',
      poisonActionType: 'stock_update',
    });
  });

  it('previews and restores countup-backup-v2 into an empty shop, blocks duplicate restores, and requires explicit opt-in for non-empty shops', async () => {
    online(true);
    await mount();

    const v2Raw = JSON.stringify({
      format: 'countup-backup-v2',
      version: '2.0',
      exportedAt: shop.createdAt,
      shop: { id: 'old-id', name: 'Kabulonga Kiosk' },
      items: [
        {
          id: 'v2_rice',
          name: 'Rice 5kg',
          buyingPrice: 90,
          buyingPriceKnown: true,
          sellingPrice: 120.5,
          quantity: 4,
          lowStockThreshold: 2,
          isDeleted: false,
          createdAt: shop.createdAt,
          updatedAt: shop.createdAt,
        },
      ],
      archivedItems: [],
      customers: [],
      sales: [],
      creditPayments: [],
      expenses: [
        {
          id: 'v2_exp_1',
          category: 'council_fee',
          amount: 50,
          note: 'Council levy',
          createdAt: shop.createdAt,
        },
      ],
      stockMovements: [],
    });

    const preview = await current.previewShopBackup(v2Raw);
    expect(preview.shopHasExistingData).toBe(false);
    expect(preview.alreadyImported).toBe(false);
    expect(preview.preview).toMatchObject({
      format: 'countup-backup-v2',
      itemsCount: 1,
      expensesCount: 1,
      totalStockValueNgwee: 48200, // 4 * 12050 ngwee
    });

    let restored!: Awaited<ReturnType<typeof current.restoreShopBackup>>;
    await act(async () => {
      restored = await current.restoreShopBackup(v2Raw);
    });
    expect(restored.status).toBe('imported');
    expect(current.items.some((i) => i.id === 'v2_rice' && i.sellingPrice === 120.5)).toBe(true);
    expect(current.expenses.some((e) => e.id === 'v2_exp_1' && e.amount === 50)).toBe(true);

    // Repeat restore of the exact same file is idempotent and duplicates nothing
    const dup = await current.restoreShopBackup(v2Raw);
    expect(dup.status).toBe('duplicate');
    expect(dup.alreadyImported).toBe(true);
    expect(current.items.filter((i) => i.id === 'v2_rice')).toHaveLength(1);

    // Restoring a second distinct backup into the now-non-empty shop fails unless allowNonEmptyShop: true
    const secondV2Raw = JSON.stringify({
      format: 'countup-backup-v2',
      version: '2.0',
      exportedAt: shop.createdAt,
      shop: { id: 'old-id-2', name: 'Second Backup' },
      items: [
        {
          id: 'v2_flour',
          name: 'Flour 2kg',
          buyingPrice: 30,
          buyingPriceKnown: true,
          sellingPrice: 45,
          quantity: 3,
          lowStockThreshold: 1,
          isDeleted: false,
          createdAt: shop.createdAt,
          updatedAt: shop.createdAt,
        },
      ],
      archivedItems: [],
      customers: [],
      sales: [],
      creditPayments: [],
      expenses: [],
      stockMovements: [],
    });

    await expect(current.restoreShopBackup(secondV2Raw)).rejects.toThrow(
      /already contains records|non-empty/i
    );

    await act(async () => {
      const merged = await current.restoreShopBackup(secondV2Raw, { allowNonEmptyShop: true });
      expect(merged.status).toBe('imported');
    });
    expect(current.items.some((i) => i.id === 'v2_flour')).toBe(true);
  });
});
