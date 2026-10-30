// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import { Shop } from '../types';

const fake = vi.hoisted(() => {
  const state = {
    auth: {
      currentUser: { uid: 'owner-1', isAnonymous: true, email: null as string | null } as {
        uid: string;
        isAnonymous: boolean;
        email: string | null;
      } | null,
    },
    docs: new Map<string, Record<string, unknown>>(),
    listeners: [] as { path: string; callback: (snapshot: unknown) => void }[],
    authListeners: [] as ((user: unknown) => void)[],
    accounts: new Map<string, { uid: string; password: string }>(),
    resets: [] as string[],
    failAdminRead: false,
    failWrite: false,
    failBatch: false,
    transactionError: null as Error | null,
    failMarker: null as string | null,
    failNextVerification: false,
    transactionAttempts: 0,
    failDeletePath: null as string | null,
    deleteGate: null as Promise<void> | null,
    deleteGates: new Map<string, Promise<void>>(),
    deleteCalls: [] as string[],
    failAnonymousSignIn: false,
    anonymousSignIns: 0,
  };
  return state;
});
vi.mock('../firebase/config', () => ({
  auth: fake.auth,
  db: {},
  testConnection: vi.fn().mockResolvedValue(true),
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: unknown) => void) => {
    fake.authListeners.push(callback);
    queueMicrotask(() => callback(fake.auth.currentUser));
    return () => {
      fake.authListeners = fake.authListeners.filter((fn) => fn !== callback);
    };
  },
  signInAnonymously: async () => {
    fake.anonymousSignIns++;
    if (fake.failAnonymousSignIn) throw new Error('Anonymous sign-in failed');
    if (!fake.auth.currentUser) {
      fake.auth.currentUser = { uid: 'new-anonymous-owner', isAnonymous: true, email: null };
      fake.authListeners.forEach((fn) => fn(fake.auth.currentUser));
    }
    return { user: fake.auth.currentUser };
  },
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  linkWithCredential: async (
    user: { uid: string },
    credential: { email: string; password: string }
  ) => {
    fake.accounts.set(credential.email, { uid: user.uid, password: credential.password });
    fake.auth.currentUser = { uid: user.uid, isAnonymous: false, email: credential.email };
    fake.authListeners.forEach((fn) => fn(fake.auth.currentUser));
    return { user: fake.auth.currentUser };
  },
  signInWithEmailAndPassword: async (_auth: unknown, email: string, password: string) => {
    const account = fake.accounts.get(email);
    if (!account || account.password !== password)
      throw Object.assign(new Error('Invalid credentials'), { code: 'auth/invalid-credential' });
    fake.auth.currentUser = { uid: account.uid, isAnonymous: false, email };
    fake.authListeners.forEach((fn) => fn(fake.auth.currentUser));
    return { user: fake.auth.currentUser };
  },
  signOut: async () => {
    fake.auth.currentUser = null;
    fake.authListeners.forEach((fn) => fn(null));
  },
  sendPasswordResetEmail: async (_auth: unknown, email: string) => {
    fake.resets.push(email);
  },
}));
vi.mock('firebase/firestore', () => {
  const path = (...parts: unknown[]) => parts.slice(1).join('/');
  const snapshot = (p: string) => ({
    exists: () => fake.docs.has(p),
    data: () => fake.docs.get(p),
  });
  const collectionSnapshot = (p: string) => {
    const docs = [...fake.docs.entries()]
      .filter(
        ([key]) => key.startsWith(`${p}/`) && key.split('/').length === p.split('/').length + 1
      )
      .map(([key, data]) => ({ ref: { path: key }, data: () => data }));
    return { docs, forEach: (fn: (doc: unknown) => void) => docs.forEach(fn) };
  };
  const emit = () =>
    fake.listeners.forEach(({ path: p, callback }) =>
      callback(p.split('/').length % 2 ? collectionSnapshot(p) : snapshot(p))
    );
  const write = (p: string, data: Record<string, unknown>, merge: boolean) =>
    fake.docs.set(p, merge ? { ...fake.docs.get(p), ...data } : { ...data });
  return {
    doc: (...parts: unknown[]) => ({ path: path(...parts) }),
    collection: (...parts: unknown[]) => ({ path: path(...parts) }),
    query: (ref: unknown) => ref,
    where: () => ({}),
    getDoc: async (ref: { path: string }) => snapshot(ref.path),
    getDocFromServer: async (ref: { path: string }) => {
      if (fake.failAdminRead && ref.path.startsWith('admins/'))
        throw Object.assign(new Error('Server unavailable'), { code: 'unavailable' });
      return snapshot(ref.path);
    },
    getDocs: async (ref: { path: string }) => {
      const result = collectionSnapshot(ref.path);
      if (ref.path === 'shops')
        result.docs = result.docs.filter((d) => d.data().ownerUid === fake.auth.currentUser?.uid);
      return result;
    },
    getDocsFromServer: async (ref: { path: string }) => collectionSnapshot(ref.path),
    setDoc: async (
      ref: { path: string },
      data: Record<string, unknown>,
      options?: { merge: boolean }
    ) => {
      if (fake.failWrite) throw new Error('Write rejected');
      write(ref.path, data, Boolean(options?.merge));
      emit();
    },
    deleteDoc: async (ref: { path: string }) => {
      fake.deleteCalls.push(ref.path);
      if (fake.deleteGate) await fake.deleteGate;
      const pathGate = fake.deleteGates.get(ref.path);
      if (pathGate) await pathGate;
      if (fake.failDeletePath === ref.path) throw new Error('Delete interrupted');
      fake.docs.delete(ref.path);
      emit();
    },
    onSnapshot: (ref: { path: string }, callback: (snapshot: unknown) => void) => {
      const listener = { path: ref.path, callback };
      fake.listeners.push(listener);
      queueMicrotask(() =>
        callback(ref.path.split('/').length % 2 ? collectionSnapshot(ref.path) : snapshot(ref.path))
      );
      return () => {
        fake.listeners = fake.listeners.filter((item) => item !== listener);
      };
    },
    writeBatch: () => {
      const writes: { path: string; data: Record<string, unknown>; merge: boolean }[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge: boolean }) =>
          writes.push({ path: ref.path, data, merge: Boolean(opts?.merge) }),
        commit: async () => {
          if (fake.failBatch) throw new Error('Batch rejected');
          writes.forEach((w) => write(w.path, w.data, w.merge));
          emit();
        },
      };
    },
    runTransaction: async (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => {
      fake.transactionAttempts++;
      if (fake.transactionError) throw fake.transactionError;
      const writes: { path: string; data: Record<string, unknown>; merge: boolean }[] = [];
      const tx = {
        get: async (ref: { path: string }) => {
          if (fake.failMarker && ref.path.endsWith(`/sync_operations/${fake.failMarker}`))
            throw Object.assign(new Error('Write permission denied'), {
              code: 'permission-denied',
            });
          return snapshot(ref.path);
        },
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge: boolean }) =>
          writes.push({ path: ref.path, data, merge: Boolean(opts?.merge) }),
      };
      const result = await callback(tx);
      writes.forEach((w) => write(w.path, w.data, w.merge));
      emit();
      if (fake.failNextVerification && writes.some((entry) => entry.data.hasResolution === true)) {
        fake.failNextVerification = false;
        fake.transactionError = Object.assign(new Error('Network lost after commit'), {
          code: 'unavailable',
        });
      }
      return result;
    },
  };
});
import { ShopProvider, useShop } from './ShopContext';
import App from '../App';

let current: ReturnType<typeof useShop>;
function Capture() {
  current = useShop();
  return null;
}
const shop: Shop = {
  id: 'shop_0977000000',
  name: 'CountUp Test',
  ownerPhone: '0977000000',
  ownerUid: 'owner-1',
  pin: '1234',
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

beforeEach(() => {
  localStorage.clear();
  fake.docs.clear();
  fake.listeners = [];
  fake.authListeners = [];
  fake.accounts.clear();
  fake.resets = [];
  fake.failAdminRead = false;
  fake.failWrite = false;
  fake.failBatch = false;
  fake.transactionError = null;
  fake.failMarker = null;
  fake.failNextVerification = false;
  fake.transactionAttempts = 0;
  fake.failDeletePath = null;
  fake.deleteGate = null;
  fake.deleteGates.clear();
  fake.deleteCalls = [];
  fake.failAnonymousSignIn = false;
  fake.anonymousSignIns = 0;
  fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
  online(false);
  localStorage.setItem('countup_active_shop', JSON.stringify(shop));
  fake.docs.set(`shops/${shop.id}`, { ...shop });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CountUp integrated business and authentication flows (mock Firebase)', () => {
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
    fake.auth.currentUser = { uid: 'wrong-owner', isAnonymous: true, email: null };
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

  it('links the existing owner UID to email, signs in again, rejects wrong credentials and requests recovery', async () => {
    online(true);
    await mount();
    await act(async () => {
      await current.linkEmailAccount('owner@example.com', 'strongpass123');
    });
    expect(fake.auth.currentUser).toMatchObject({
      uid: 'owner-1',
      isAnonymous: false,
      email: 'owner@example.com',
    });
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('owner-1');
    await act(async () => {
      await current.logout();
    });
    expect(fake.auth.currentUser).toBeNull();
    await expect(current.loginWithEmail('owner@example.com', 'wrong')).rejects.toThrow(
      /Invalid credentials/
    );
    let shops: Shop[] = [];
    await act(async () => {
      shops = await current.loginWithEmail('owner@example.com', 'strongpass123');
      current.selectEmailShop(shops[0]);
    });
    expect(current.shop?.id).toBe(shop.id);
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

  it('recovers an offline shop and its records from the durable queue after an interrupted cache update', async () => {
    fake.auth.currentUser = null;
    fake.docs.clear();
    localStorage.removeItem('countup_active_shop');
    const pendingShop = { ...shop, ownerUid: shop.id };
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
        action('create-shop', [{ path: `shops/${shop.id}`, data: pendingShop }]),
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
    expect(current.pendingSyncCount).toBe(3);
  });

  it('replays queued archives, expense deletions and PIN changes after restart', async () => {
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
    localStorage.setItem('countup_items', JSON.stringify([product]));
    localStorage.setItem('countup_expenses', JSON.stringify([expense]));
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
        { id: 'pin', type: 'shop', timestamp: 3, path: `shops/${shop.id}`, data: { pin: '4321' } },
      ])
    );
    await mount();
    expect(current.items).toHaveLength(0);
    expect(current.archivedItems[0]).toMatchObject({ id: product.id, isDeleted: true });
    expect(current.expenses).toHaveLength(0);
    expect(current.shop?.pin).toBe('4321');
    expect(current.pendingSyncCount).toBe(3);
  });

  it('creates a shop offline immediately and binds its temporary owner to the authenticated UID on sync', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('New shop', '+260 977 000 000', '1234')).toBe(true);
    });
    expect(current.shop).toMatchObject({
      id: shop.id,
      ownerPhone: '0977000000',
      ownerUid: shop.id,
    });
    expect(current.pendingSyncCount).toBe(1);
    online(true);
    fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('owner-1');
    expect(current.shop?.ownerUid).toBe('owner-1');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('authenticates and syncs an offline-created shop after reopening online', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    let itemId = '';
    await act(async () => {
      itemId = await current.addItem({
        name: 'Sugar',
        buyingPrice: 1,
        sellingPrice: 2,
        quantity: 4,
        lowStockThreshold: 1,
      });
    });
    await act(async () => {
      await current.recordSale({
        items: [{ itemId, name: 'Sugar', quantity: 1, buyingPrice: 1, sellingPrice: 2 }],
        itemsCount: 1,
        totalAmount: 2,
        totalCost: 1,
        profit: 1,
        paymentType: 'cash',
      });
    });
    expect(current.pendingSyncCount).toBe(3);
    cleanup();
    online(true);
    fake.auth.currentUser = null;
    await mount();
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.anonymousSignIns).toBe(1);
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('new-anonymous-owner');
    expect(fake.docs.get(`shops/${shop.id}/items/${itemId}`)?.quantity).toBe(3);
    await waitFor(() => expect(current.items[0].quantity).toBe(3));
    expect(current.sales).toHaveLength(1);
  });

  it('keeps a temporary shop queued when anonymous sign-in fails, then retries safely', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    cleanup();
    fake.failAnonymousSignIn = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    online(true);
    await mount();
    await waitFor(() =>
      expect(current.lastOfflineNotice).toMatch(/Could not create a cloud session/i)
    );
    expect(current.pendingSyncCount).toBe(1);
    expect(current.shop?.ownerUid).toBe(shop.id);
    fake.failAnonymousSignIn = false;
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(0);
    expect(current.shop?.ownerUid).toBe('new-anonymous-owner');
  });

  it('keeps an existing shop queue safe when its original Firebase account is missing', async () => {
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
    expect(fake.anonymousSignIns).toBe(0);
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);
  });

  it('does not sync an established shop with a different signed-in UID', async () => {
    fake.auth.currentUser = { uid: 'other-owner', isAnonymous: true, email: null };
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
    expect(fake.auth.currentUser?.uid).toBe('other-owner');
    expect(fake.anonymousSignIns).toBe(0);
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);
  });

  it('reconnects only the original linked owner without discarding pending entries', async () => {
    fake.auth.currentUser = null;
    fake.accounts.set('owner@example.com', { uid: 'owner-1', password: 'password123' });
    fake.accounts.set('other@example.com', { uid: 'other-owner', password: 'password123' });
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
      await expect(current.restoreShopAccount('other@example.com', 'password123')).rejects.toThrow(
        /not linked to the original shop/i
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.pendingSyncCount).toBe(1);
    expect(fake.docs.has(`shops/${shop.id}/expenses/expense-a`)).toBe(false);
    await act(async () => {
      await current.restoreShopAccount('owner@example.com', 'password123');
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(`shops/${shop.id}/expenses/expense-a`)).toMatchObject({ amount: 2 });
    expect(current.needsShopAccountRecovery).toBe(false);
  });

  it('does not bind a temporary shop owner until its cloud creation succeeds', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    fake.failBatch = true;
    fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.shop?.ownerUid).toBe(shop.id);
    expect(JSON.parse(localStorage.getItem('countup_active_shop') || '{}').ownerUid).toBe(shop.id);
    expect(current.pendingSyncCount).toBe(1);
    fake.failBatch = false;
    await act(async () => {
      await current.syncNow();
    });
    expect(current.shop?.ownerUid).toBe('owner-1');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('does not replay stale shop creation fields when the same creation was already accepted', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    const created = JSON.parse(localStorage.getItem('countup_pending_queue')!)[0].writes[0].data;
    fake.docs.set(`shops/${created.id}`, {
      ...created,
      ownerUid: 'owner-1',
      pin: '9999',
      planStatus: 'active',
    });
    fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(current.pendingSyncCount).toBe(0);
    expect(fake.docs.get(`shops/${created.id}`)).toMatchObject({
      ownerUid: 'owner-1',
      pin: '9999',
      planStatus: 'active',
    });
  });

  it('defers listeners for a queued online creation until its parent exists', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    online(true);
    fake.failWrite = true;
    fake.failBatch = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Queued online', '0977000000', '1234')).toBe(true);
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(1));
    expect(fake.listeners.some((entry) => entry.path.startsWith(`shops/${shop.id}`))).toBe(false);
    fake.failWrite = false;
    fake.failBatch = false;
    await act(async () => {
      await current.syncNow();
    });
    await waitFor(() => expect(current.pendingSyncCount).toBe(0));
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('owner-1');
    await waitFor(() =>
      expect(fake.listeners.some((entry) => entry.path === `shops/${shop.id}/items`)).toBe(true)
    );
  });

  it('defers remote listeners until an offline shop create is acknowledged', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
    await act(async () => {
      fake.authListeners.forEach((listener) => listener(fake.auth.currentUser));
    });
    expect(fake.listeners.some((entry) => entry.path.startsWith(`shops/${shop.id}`))).toBe(false);
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    await waitFor(() =>
      expect(fake.listeners.some((entry) => entry.path === `shops/${shop.id}/items`)).toBe(true)
    );
    expect(current.shop?.ownerUid).toBe('owner-1');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('keeps the reserved creation UID if a cloud acknowledgement and session are lost', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    fake.failBatch = true;
    fake.auth.currentUser = { uid: 'original-owner', isAnonymous: true, email: null };
    online(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await current.syncNow();
    });
    expect(JSON.parse(localStorage.getItem('countup_pending_queue') || '[]')[0]).toMatchObject({
      reservedOwnerUid: 'original-owner',
    });
    expect(current.shop?.ownerUid).toBe(shop.id);
    cleanup();
    fake.auth.currentUser = null;
    await mount();
    await waitFor(() => expect(current.lastOfflineNotice).toMatch(/original shop account/i));
    expect(current.needsShopAccountRecovery).toBe(true);
    expect(fake.anonymousSignIns).toBe(0);
    expect(current.pendingSyncCount).toBe(1);
    fake.failBatch = false;
    fake.auth.currentUser = { uid: 'wrong-owner', isAnonymous: true, email: null };
    await act(async () => {
      await current.syncNow();
    });
    expect(current.lastOfflineNotice).toMatch(/different account/i);
    expect(fake.docs.has(`shops/${shop.id}`)).toBe(false);
    fake.auth.currentUser = { uid: 'original-owner', isAnonymous: true, email: null };
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('original-owner');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('does not send a shop create if its chosen UID cannot be saved locally', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.docs.clear();
    fake.auth.currentUser = null;
    await mount();
    await act(async () => {
      expect(await current.registerNewShop('Offline shop', '0977000000', '1234')).toBe(true);
    });
    fake.auth.currentUser = { uid: 'owner-1', isAnonymous: true, email: null };
    online(true);
    const original = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key, value) {
        if (key === 'countup_pending_queue' && value.includes('reservedOwnerUid')) {
          throw new Error('Storage full');
        }
        return original.call(this, key, value);
      });
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.has(`shops/${shop.id}`)).toBe(false);
    expect(current.pendingSyncCount).toBe(1);
    expect(current.lastOfflineNotice).toMatch(/Storage full/);
    storage.mockRestore();
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}`)?.ownerUid).toBe('owner-1');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('warns when interrupted shop deletion has already removed some records', async () => {
    fake.docs.set(`shops/${shop.id}/items/item-a`, { id: 'item-a', name: 'Sugar' });
    fake.docs.set(`shops/${shop.id}/sales/sale-a`, { id: 'sale-a', totalAmount: 2 });
    fake.failDeletePath = `shops/${shop.id}/sales/sale-a`;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    online(true);
    await mount();
    await act(async () => {
      expect(await current.deleteShopAccount()).toBe(false);
    });
    expect(fake.docs.has(`shops/${shop.id}/items/item-a`)).toBe(false);
    expect(fake.docs.has(`shops/${shop.id}/sales/sale-a`)).toBe(true);
    expect(fake.docs.has(`shops/${shop.id}`)).toBe(true);
    expect(current.shop?.id).toBe(shop.id);
    expect(screen.getByText(/Some records may already have been removed/i)).toBeTruthy();
  });

  it('waits for in-flight deletions to settle before reporting a partial failure', async () => {
    const failedPath = `shops/${shop.id}/sales/sale-failed`;
    const slowPath = `shops/${shop.id}/sales/sale-slow`;
    fake.docs.set(failedPath, { id: 'sale-failed' });
    fake.docs.set(slowPath, { id: 'sale-slow' });
    fake.failDeletePath = failedPath;
    let finish!: () => void;
    fake.deleteGates.set(
      slowPath,
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    online(true);
    await mount();
    let deletion!: Promise<boolean>;
    act(() => {
      deletion = current.deleteShopAccount();
    });
    await waitFor(() => expect(fake.deleteCalls).toContain(slowPath));
    expect(current.isLoading).toBe(true);
    expect(fake.docs.has(slowPath)).toBe(true);
    await act(async () => {
      finish();
      expect(await deletion).toBe(false);
    });
    expect(current.isLoading).toBe(false);
    expect(fake.docs.has(slowPath)).toBe(false);
    expect(fake.docs.has(failedPath)).toBe(true);
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
      expect(await current.deleteShopAccount()).toBe(false);
    });
    expect(current.isLoading).toBe(false);
    expect(fake.docs.has(`shops/${shop.id}`)).toBe(false);
    expect(screen.getByText(/Some records may already have been removed/i)).toBeTruthy();
    storage.mockRestore();
  });

  it('keeps the deletion dialog open and shows an interrupted partial deletion', async () => {
    fake.docs.set(`shops/${shop.id}/items/item-a`, {
      id: 'item-a',
      name: 'Sugar',
      quantity: 2,
      lowStockThreshold: 1,
      sellingPrice: 1,
      buyingPrice: 1,
      createdAt: shop.createdAt,
      updatedAt: shop.createdAt,
      shopId: shop.id,
    });
    fake.docs.set(`shops/${shop.id}/sales/sale-a`, { id: 'sale-a', totalAmount: 2 });
    fake.failDeletePath = `shops/${shop.id}/sales/sale-a`;
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }));
    await screen.findByText(/Deleting shop and data/i);
    await act(async () => finish());
    await waitFor(() =>
      expect(within(dialog).getByText(/Some records may already have been removed/i)).toBeTruthy()
    );
    expect(screen.queryByText(/Deleting shop and data/i)).toBeNull();
    expect(fake.docs.has(`shops/${shop.id}/items/item-a`)).toBe(false);
    expect(fake.docs.has(`shops/${shop.id}/sales/sale-a`)).toBe(true);
  });

  it('does not enter an offline shop when saving its queue fails', async () => {
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    await mount();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === 'countup_pending_queue') throw new Error('storage full');
      return original.call(this, key, value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      expect(await current.registerNewShop('New shop', '0977000000', '1234')).toBe(false);
    });
    expect(current.shop).toBeNull();
    expect(current.pendingSyncCount).toBe(0);
  });

  it('keeps queued PIN changes in order and does not replace them with an old server snapshot', async () => {
    await mount();
    await act(async () => {
      expect(await current.changePin('1234', '4321')).toBe(true);
    });
    await act(async () => {
      expect(await current.changePin('4321', '9876')).toBe(true);
    });
    const listener = fake.listeners.find((entry) => entry.path === `shops/${shop.id}`);
    await act(async () => {
      listener?.callback({ exists: () => true, data: () => shop });
    });
    expect(current.shop?.pin).toBe('9876');
    online(true);
    await act(async () => {
      await current.syncNow();
    });
    expect(fake.docs.get(`shops/${shop.id}`)?.pin).toBe('9876');
    expect(current.pendingSyncCount).toBe(0);
  });

  it('signs out an email account when the user cancels multi-shop selection', async () => {
    online(true);
    await mount();
    await act(async () => {
      await current.linkEmailAccount('owner@example.com', 'strongpass123');
    });
    await act(async () => {
      await current.logout();
    });
    const otherShop = { ...shop, id: 'shop_0977000002', name: 'Second shop' };
    fake.docs.set(`shops/${otherShop.id}`, otherShop);
    let owned: Shop[] = [];
    await act(async () => {
      owned = await current.loginWithEmail('owner@example.com', 'strongpass123');
    });
    expect(owned).toHaveLength(2);
    expect(current.shop).toBeNull();
    await act(async () => {
      await current.cancelEmailLogin();
    });
    expect(fake.auth.currentUser).toBeNull();
  });

  it('finds a legacy international-format shop when signing in with the national format', async () => {
    online(true);
    await mount();
    await act(async () => {
      await current.logout();
    });
    fake.docs.clear();
    const legacyShop = { ...shop, id: 'shop_260977000000', ownerPhone: '260977000000' };
    fake.docs.set(`shops/${legacyShop.id}`, legacyShop);
    await act(async () => {
      expect(await current.loginWithPhoneAndPin('0977 000 000', '1234')).toBe(true);
    });
    expect(current.shop?.id).toBe(legacyShop.id);
  });

  it('opens the real admin screen from the sign-in form and signs out on exit', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.docs.set('admins/admin-1', {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Admin sign in' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
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
    fake.docs.set('admins/admin-1', {});
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
        /does not have admin access/
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.isAdmin).toBe(false);
    fake.docs.set('admins/user-1', {});
    fake.failAdminRead = true;
    await act(async () => {
      await expect(current.loginAsAdmin('user@example.com', 'strongpass123')).rejects.toThrow(
        /Server unavailable/
      );
    });
    expect(fake.auth.currentUser).toBeNull();
    expect(current.isAdmin).toBe(false);
  });

  it('protects the anonymous shop identity and pending queue when entering admin sign-in', async () => {
    localStorage.removeItem('countup_active_shop');
    localStorage.setItem('countup_legacy_uid', 'owner-1');
    await mount();
    online(true);
    await expect(current.loginAsAdmin('admin@example.com', 'password')).rejects.toThrow(
      /anonymous identity is not lost/
    );
    expect(fake.auth.currentUser?.uid).toBe('owner-1');
    localStorage.removeItem('countup_legacy_uid');
    online(false);
    // An offline pending queue must also block a switch, even without a shop.
    cleanup();
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
      /Sync pending entries/
    );
    expect(fake.auth.currentUser).toBeNull();
  });

  it('requires a live admin grant for changes and never reports failed or offline writes as saved', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.docs.set('admins/admin-1', {});
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
      planStatus: 'active',
      isDeactivated: true,
    });
    online(false);
    await expect(current.adminToggleDeactivate(shop.id)).rejects.toThrow(/internet/);
    expect(fake.docs.get(`shops/${shop.id}`)?.isDeactivated).toBe(true);
  });

  it('does not carry an admin grant to a different Firebase user', async () => {
    online(true);
    localStorage.removeItem('countup_active_shop');
    fake.auth.currentUser = null;
    fake.accounts.set('admin@example.com', { uid: 'admin-1', password: 'strongpass123' });
    fake.docs.set('admins/admin-1', {});
    await mount();
    await act(async () => {
      await current.loginAsAdmin('admin@example.com', 'strongpass123');
    });
    await waitFor(() => expect(current.isAdmin).toBe(true));
    await act(async () => {
      fake.auth.currentUser = {
        uid: 'ordinary-user',
        isAnonymous: false,
        email: 'user@example.com',
      };
      fake.authListeners.forEach((fn) => fn(fake.auth.currentUser));
    });
    expect(current.isAdmin).toBe(false);
    await expect(current.adminToggleDeactivate(shop.id)).rejects.toThrow(/Admin access/);
  });

  it('refuses an import from a non-owner and makes no writes', async () => {
    online(true);
    await mount();
    fake.auth.currentUser = { uid: 'other', isAnonymous: false, email: 'other@example.com' };
    const before = [...fake.docs.entries()];
    await expect(current.importLegacyBackup('{}')).rejects.toThrow(/owner/);
    expect([...fake.docs.entries()]).toEqual(before);
  });
});
