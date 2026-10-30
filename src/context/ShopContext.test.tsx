// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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
  signInAnonymously: async () => ({ user: fake.auth.currentUser }),
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
    getDocs: async (ref: { path: string }) => {
      const result = collectionSnapshot(ref.path);
      if (ref.path === 'shops')
        result.docs = result.docs.filter((d) => d.data().ownerUid === fake.auth.currentUser?.uid);
      return result;
    },
    setDoc: async (
      ref: { path: string },
      data: Record<string, unknown>,
      options?: { merge: boolean }
    ) => {
      write(ref.path, data, Boolean(options?.merge));
      emit();
    },
    deleteDoc: async (ref: { path: string }) => {
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
          writes.forEach((w) => write(w.path, w.data, w.merge));
          emit();
        },
      };
    },
    runTransaction: async (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => {
      const writes: { path: string; data: Record<string, unknown>; merge: boolean }[] = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge: boolean }) =>
          writes.push({ path: ref.path, data, merge: Boolean(opts?.merge) }),
      };
      const result = await callback(tx);
      writes.forEach((w) => write(w.path, w.data, w.merge));
      emit();
      return result;
    },
  };
});
import { ShopProvider, useShop } from './ShopContext';

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

  it('refuses an import from a non-owner and makes no writes', async () => {
    online(true);
    await mount();
    fake.auth.currentUser = { uid: 'other', isAnonymous: false, email: 'other@example.com' };
    const before = [...fake.docs.entries()];
    await expect(current.importLegacyBackup('{}')).rejects.toThrow(/owner/);
    expect([...fake.docs.entries()]).toEqual(before);
  });
});
