import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Shop, Item, Sale, Customer, CreditPayment, Expense, Language, ActiveTab } from '../types';
import { translations, Translations } from '../i18n/translations';
import { getSubscriptionInfo } from '../config/plans';
import { auth, db, testConnection } from '../firebase/config';
import { useToast } from '../components/Toast';
import { reconcile } from '../utils/sync';
import { signInAnonymously, onAuthStateChanged, User } from 'firebase/auth';
import {
  doc,
  setDoc,
  writeBatch,
  getDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  getDocs,
  DocumentData,
} from 'firebase/firestore';

/**
 * Payload of a queued write. The concrete shape depends on `type` (a Sale, an
 * Item, a partial patch…), so the queue only promises that it is a plain object
 * and Firestore is given it as `DocumentData` at write time.
 */
type QueuePayload = object;

interface PendingSyncAction {
  id: string;
  type: 'sale' | 'item' | 'customer' | 'payment' | 'expense' | 'stock_update';
  path: string;
  data: QueuePayload;
  timestamp: number;
}

interface ShopContextType {
  // Auth & Shop
  user: User | null;
  shop: Shop | null;
  isLoading: boolean;
  isAdmin: boolean;
  loginWithPhoneAndPin: (phone: string, pin: string) => Promise<boolean>;
  registerNewShop: (name: string, phone: string, pin: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Permanently deletes this shop and every record that belongs to it. */
  deleteShopAccount: () => Promise<boolean>;
  /** Verifies the current PIN and replaces it with a new 4-digit PIN. */
  changePin: (currentPin: string, newPin: string) => Promise<boolean>;

  // Language & Tab
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;

  // Data
  items: Item[];
  sales: Sale[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  expenses: Expense[];

  // Actions
  recordSale: (saleData: Omit<Sale, 'id' | 'shopId' | 'createdAt'>) => Promise<string>;
  /** Undo a sale recorded today: restores stock and credit. Returns the voided sale. */
  voidSale: (saleId: string) => Promise<Sale>;
  addItem: (itemData: Omit<Item, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateItem: (itemId: string, patch: Partial<Item>) => Promise<void>;
  quickRestock: (itemId: string, quantityToAdd: number) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  restoreItem: (item: Item) => Promise<void>;
  addCustomer: (name: string, phone?: string) => Promise<Customer>;
  recordCreditPayment: (
    customerId: string,
    amount: number,
    note?: string
  ) => Promise<{ applied: number; remaining: number }>;
  addExpense: (category: Expense['category'], amount: number, note?: string) => Promise<void>;
  deleteExpense: (expenseId: string) => Promise<void>;
  restoreExpense: (expense: Expense) => Promise<void>;

  // Subscription
  subscription: ReturnType<typeof getSubscriptionInfo>;
  /** True when the platform owner has suspended this shop. Sales are locked. */
  isShopDeactivated: boolean;

  // Offline & Sync
  isOnline: boolean;
  pendingSyncCount: number;
  isSyncing: boolean;
  syncNow: () => Promise<void>;
  lastOfflineNotice: string | null;
  clearOfflineNotice: () => void;

  // Platform Admin
  allShops: Shop[];
  adminExtendShop: (shopId: string, days: number) => Promise<void>;
  adminToggleDeactivate: (shopId: string) => Promise<void>;
}

const ShopContext = createContext<ShopContextType | undefined>(undefined);

/** Is this timestamp on today's calendar day? (local, works offline) */
function isTodayIso(iso: string): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toDateString() === new Date().toDateString();
}

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { notify } = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [shop, setShop] = useState<Shop | null>(() => {
    const cached = localStorage.getItem('countup_active_shop');
    return cached ? JSON.parse(cached) : null;
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('countup_language') as Language;
    return saved === 'bem' || saved === 'nya' ? saved : 'en';
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>('sell');

  // Business state
  const [items, setItems] = useState<Item[]>(() => {
    const cached = localStorage.getItem('countup_items');
    return cached ? JSON.parse(cached) : [];
  });
  const [sales, setSales] = useState<Sale[]>(() => {
    const cached = localStorage.getItem('countup_sales');
    return cached ? JSON.parse(cached) : [];
  });
  const [customers, setCustomers] = useState<Customer[]>(() => {
    const cached = localStorage.getItem('countup_customers');
    return cached ? JSON.parse(cached) : [];
  });
  const [creditPayments, setCreditPayments] = useState<CreditPayment[]>(() => {
    const cached = localStorage.getItem('countup_payments');
    return cached ? JSON.parse(cached) : [];
  });
  const [expenses, setExpenses] = useState<Expense[]>(() => {
    const cached = localStorage.getItem('countup_expenses');
    return cached ? JSON.parse(cached) : [];
  });

  // Offline queue
  const [pendingQueue, setPendingQueue] = useState<PendingSyncAction[]>(() => {
    const cached = localStorage.getItem('countup_pending_queue');
    return cached ? JSON.parse(cached) : [];
  });
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastOfflineNotice, setLastOfflineNotice] = useState<string | null>(null);

  // Platform admin shops list
  const [allShops, setAllShops] = useState<Shop[]>([]);

  // Cache helper
  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('countup_language', lang);
  };

  const t = translations[language];

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void syncNow();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setLastOfflineNotice(t.offlineSaved);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial connection test
    void testConnection();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
    // Only the offline notice text is a real dependency: re-running on every
    // render would re-attach the listeners on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.offlineSaved]);

  // Save current shop state to local storage for instant offline recovery
  useEffect(() => {
    if (shop) {
      localStorage.setItem('countup_active_shop', JSON.stringify(shop));
    } else {
      localStorage.removeItem('countup_active_shop');
    }
  }, [shop]);

  useEffect(() => {
    localStorage.setItem('countup_items', JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    localStorage.setItem('countup_sales', JSON.stringify(sales));
  }, [sales]);

  useEffect(() => {
    localStorage.setItem('countup_customers', JSON.stringify(customers));
  }, [customers]);

  useEffect(() => {
    localStorage.setItem('countup_payments', JSON.stringify(creditPayments));
  }, [creditPayments]);

  useEffect(() => {
    localStorage.setItem('countup_expenses', JSON.stringify(expenses));
  }, [expenses]);

  useEffect(() => {
    localStorage.setItem('countup_pending_queue', JSON.stringify(pendingQueue));
  }, [pendingQueue]);

  // Auth state listener.
  //
  // Sign-in to Countup is phone + PIN only. Behind the scenes each device holds a
  // Firebase *anonymous* session (created on register/login) so that Firestore can
  // scope shop records to this device's uid — it carries no name, email or phone.
  useEffect(() => {
    let mounted = true;

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!mounted) return;
      setUser(currentUser);
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Platform-owner detection: the `admins` collection is the only source of truth
  // (see firestore.rules). Grant access by creating admins/<uid> in the Firebase
  // console — never by a hardcoded email or phone number in the client.
  useEffect(() => {
    let cancelled = false;
    const uid = user?.uid;
    if (!uid || !navigator.onLine) {
      setIsAdmin(false);
      return;
    }
    setIsAdmin(false);
    void (async () => {
      try {
        const snap = await getDoc(doc(db, 'admins', uid));
        if (!cancelled) setIsAdmin(snap.exists());
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Keep the latest state reachable from long-lived listeners without making them
  // re-subscribe on every change (a re-subscribe per sale drops real-time updates).
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const salesRef = React.useRef(sales);
  salesRef.current = sales;
  const customersRef = React.useRef(customers);
  customersRef.current = customers;
  const paymentsRef = React.useRef(creditPayments);
  paymentsRef.current = creditPayments;
  const expensesRef = React.useRef(expenses);
  expensesRef.current = expenses;
  const queueRef = React.useRef(pendingQueue);
  queueRef.current = pendingQueue;

  // ---------------------------------------------------------------
  // REAL-TIME SYNC
  //
  // Every collection is mirrored live: a sale recorded on this phone appears in
  // Reports/Credit instantly (optimistic state), and anything changed elsewhere
  // (an admin extending a plan, a second device) lands without a page reload.
  // Documents still sitting in the offline queue are kept on top of the server
  // snapshot so a pending write never disappears from the screen mid-sync.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!shop?.id || !user) return;

    const shopId = shop.id;
    const warn = (label: string) => (err: unknown) => {
      console.warn(`Real-time ${label} listener:`, err);
    };

    const unsubShop = onSnapshot(
      doc(db, 'shops', shopId),
      (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data() as Shop;
        // Never let the server drop the local PIN before it has been pushed.
        setShop((prev) => ({ ...data, pin: data.pin || prev?.pin || '' }));
      },
      warn('shop')
    );

    const unsubItems = onSnapshot(
      collection(db, 'shops', shopId, 'items'),
      (snap) => {
        const remote: Item[] = [];
        snap.forEach((d) => {
          const data = d.data() as Item & { isDeleted?: boolean };
          if (!data.isDeleted) remote.push(data);
        });
        setItems(reconcile(remote, itemsRef.current, queueRef.current, `shops/${shopId}/items`));
      },
      warn('items')
    );

    const unsubSales = onSnapshot(
      collection(db, 'shops', shopId, 'sales'),
      (snap) => {
        const remote: Sale[] = [];
        snap.forEach((d) => {
          const data = d.data() as Sale & { isDeleted?: boolean };
          if (!data.isDeleted) remote.push(data);
        });
        const merged = reconcile(
          remote,
          salesRef.current,
          queueRef.current,
          `shops/${shopId}/sales`
        );
        merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setSales(merged);
      },
      warn('sales')
    );

    const unsubCustomers = onSnapshot(
      collection(db, 'shops', shopId, 'customers'),
      (snap) => {
        const remote: Customer[] = [];
        snap.forEach((d) => remote.push(d.data() as Customer));
        setCustomers(
          reconcile(remote, customersRef.current, queueRef.current, `shops/${shopId}/customers`)
        );
      },
      warn('customers')
    );

    const unsubPayments = onSnapshot(
      collection(db, 'shops', shopId, 'credit_payments'),
      (snap) => {
        const remote: CreditPayment[] = [];
        snap.forEach((d) => remote.push(d.data() as CreditPayment));
        setCreditPayments(
          reconcile(
            remote,
            paymentsRef.current,
            queueRef.current,
            `shops/${shopId}/credit_payments`
          )
        );
      },
      warn('credit payments')
    );

    const unsubExpenses = onSnapshot(
      collection(db, 'shops', shopId, 'expenses'),
      (snap) => {
        const remote: Expense[] = [];
        snap.forEach((d) => {
          const data = d.data() as Expense & { isDeleted?: boolean };
          if (!data.isDeleted) remote.push(data);
        });
        setExpenses(
          reconcile(remote, expensesRef.current, queueRef.current, `shops/${shopId}/expenses`)
        );
      },
      warn('expenses')
    );

    return () => {
      unsubShop();
      unsubItems();
      unsubSales();
      unsubCustomers();
      unsubPayments();
      unsubExpenses();
    };
  }, [shop?.id, user]);

  // Live shop directory for the platform owner (was a one-off fetch, so plan
  // extensions made on one screen never showed up on another without a reload).
  useEffect(() => {
    if (!isAdmin || !user) {
      setAllShops([]);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'shops')),
      (snap) => {
        const shopsList: Shop[] = [];
        snap.forEach((d) => shopsList.push(d.data() as Shop));
        setAllShops(shopsList);
      },
      (err) => console.warn('Admin shops listener:', err)
    );
    return () => unsub();
  }, [isAdmin, user]);

  // Drain the offline queue.
  //
  // Reads the queue from a ref and guards with a ref, not component state: the old
  // version captured a stale (usually empty) queue in a timeout, so writes made
  // offline could sit in localStorage forever and never reach Firestore.
  const syncingRef = React.useRef(false);
  const syncNow = useCallback(async () => {
    if (!navigator.onLine || syncingRef.current) return;
    const queued = queueRef.current;
    if (queued.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);

    const remaining: PendingSyncAction[] = [];

    for (const action of queued) {
      try {
        await setDoc(doc(db, action.path), action.data as DocumentData, { merge: true });
      } catch (err) {
        console.warn('Sync failed for action, keeping in queue:', action.id, err);
        remaining.push(action);
      }
    }

    queueRef.current = remaining;
    setPendingQueue(remaining);
    syncingRef.current = false;
    setIsSyncing(false);

    if (remaining.length === 0) {
      setLastOfflineNotice(null);
      notify(
        `All ${queued.length} saved ${queued.length === 1 ? 'entry' : 'entries'} synced to the cloud`,
        {
          kind: 'success',
        }
      );
    } else if (navigator.onLine) {
      setLastOfflineNotice(
        `${remaining.length} ${remaining.length === 1 ? 'entry' : 'entries'} could not sync yet. Tap Sync to retry.`
      );
      notify('Some entries are still waiting to sync', {
        kind: 'error',
        detail: 'They are safe on this phone. Tap the sync button in the header to retry.',
      });
    }
  }, [notify]);

  const queueAction = useCallback(
    (type: PendingSyncAction['type'], path: string, data: QueuePayload) => {
      const action: PendingSyncAction = {
        id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type,
        path,
        data,
        timestamp: Date.now(),
      };
      const next = [...queueRef.current, action];
      queueRef.current = next;
      setPendingQueue(next);

      if (!navigator.onLine) {
        setLastOfflineNotice('Saved on this phone. Will sync when internet returns.');
      } else {
        // Push in the background; failures stay queued and are retried.
        setTimeout(() => void syncNow(), 50);
      }
    },
    [syncNow]
  );

  // Safe helper to obtain a Firebase auth user if Anonymous is enabled or user logged in
  const ensureFirebaseAuth = async (): Promise<User | null> => {
    if (auth.currentUser) return auth.currentUser;
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (err) {
      // Anonymous authentication can be enabled in Firebase console under Auth > Sign-in method
      console.warn(
        'Anonymous auth note (can be enabled in Firebase console):',
        err instanceof Error ? err.message : err
      );
      return null;
    }
  };

  // Login with phone and 4-digit PIN
  const loginWithPhoneAndPin = async (phone: string, pin: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const cleanPhone = phone.replace(/\D/g, '');
      const shopId = `shop_${cleanPhone}`;

      // Ensure an authenticated Firebase session exists if enabled
      const currentUser = await ensureFirebaseAuth();

      // Check remote Firestore first if online
      if (navigator.onLine && currentUser) {
        try {
          const shopSnap = await getDoc(doc(db, 'shops', shopId));
          if (shopSnap.exists()) {
            const shopData = shopSnap.data() as Shop;
            if (shopData.pin === pin) {
              setShop(shopData);
              setIsLoading(false);
              return true;
            } else {
              setIsLoading(false);
              return false; // Wrong PIN
            }
          }
        } catch (e) {
          console.warn('Remote check note:', e);
        }
      }

      // Check local cache if offline or first time
      const cached = localStorage.getItem('countup_active_shop');
      if (cached) {
        const localShop = JSON.parse(cached) as Shop;
        if (localShop.ownerPhone.replace(/\D/g, '') === cleanPhone && localShop.pin === pin) {
          setShop(localShop);
          setIsLoading(false);
          return true;
        }
      }

      setIsLoading(false);
      return false;
    } catch (error) {
      console.error('Login error:', error);
      setIsLoading(false);
      return false;
    }
  };

  // Register a new shop (starts 30-day free trial automatically)
  const registerNewShop = async (name: string, phone: string, pin: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const cleanPhone = phone.replace(/\D/g, '');
      const shopId = `shop_${cleanPhone}`;

      const currentUser = await ensureFirebaseAuth();

      // Refuse to overwrite a shop that already exists for this phone number.
      // Without this check, re-registering a known number silently replaced the
      // existing shop's records (or failed on a security rule with an obscure error).
      if (navigator.onLine && currentUser) {
        try {
          const existing = await getDoc(doc(db, 'shops', shopId));
          if (existing.exists()) {
            setIsLoading(false);
            return false;
          }
        } catch (e) {
          console.warn('Shop availability check note:', e);
        }
      }

      const now = new Date();
      const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const newShop: Shop = {
        id: shopId,
        name: name.trim(),
        ownerPhone: phone.trim(),
        ownerUid: currentUser?.uid || shopId,
        pin: pin.trim(),
        planStatus: 'trial',
        planType: 'trial',
        createdAt: now.toISOString(),
        trialEndsAt: trialEnds.toISOString(),
        planExpiryDate: trialEnds.toISOString(),
        isDeactivated: false,
        currency: 'ZMW',
      };

      // A new shop starts with an empty stock book — the owner enters their own items.
      setShop(newShop);
      setItems([]);
      setSales([]);
      setCustomers([]);
      setCreditPayments([]);
      setExpenses([]);

      // Persist to Firestore or queue for the next connection
      if (navigator.onLine && currentUser) {
        try {
          await setDoc(doc(db, 'shops', shopId), newShop);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code === 'permission-denied') {
            // The number is already registered to another account. Don't leave the
            // user in a shop that only exists on this phone.
            setShop(null);
            localStorage.removeItem('countup_active_shop');
            setIsLoading(false);
            return false;
          }
          console.warn('Shop creation sync note, queued for retry:', e);
          queueAction('item', `shops/${shopId}`, newShop);
        }
      } else {
        queueAction('item', `shops/${shopId}`, newShop);
      }

      setIsLoading(false);
      return true;
    } catch (error) {
      console.error('Registration error:', error);
      setIsLoading(false);
      return false;
    }
  };

  const logout = async () => {
    localStorage.removeItem('countup_active_shop');
    setShop(null);
    setItems([]);
    setSales([]);
    setCustomers([]);
    setCreditPayments([]);
    setExpenses([]);
  };

  // Change the shop PIN (verifies the current one first)
  const changePin = async (currentPin: string, newPin: string): Promise<boolean> => {
    if (!shop || !shop.pin) return false;
    if (!/^\d{4}$/.test(newPin)) return false;
    if (shop.pin !== currentPin.trim()) return false;

    const updatedShop: Shop = { ...shop, pin: newPin };
    setShop(updatedShop);

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, 'shops', shop.id), { pin: newPin }, { merge: true });
      } catch {
        queueAction('item', `shops/${shop.id}`, { pin: newPin });
      }
    } else {
      queueAction('item', `shops/${shop.id}`, { pin: newPin });
    }
    return true;
  };

  // Permanently delete the shop document and all of its records.
  // Backs the deletion right promised in the Privacy Policy.
  const deleteShopAccount = async (): Promise<boolean> => {
    if (!shop) return false;
    const activeShop = shop;
    setIsLoading(true);

    if (navigator.onLine && auth.currentUser) {
      const subcollections = ['items', 'sales', 'customers', 'credit_payments', 'expenses'];
      try {
        for (const name of subcollections) {
          const snap = await getDocs(collection(db, 'shops', activeShop.id, name));
          await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
        }
        await deleteDoc(doc(db, 'shops', activeShop.id));
      } catch (e) {
        // Keep the owner signed in so they can retry once a connection returns.
        console.error('Shop deletion failed:', e);
        setIsLoading(false);
        return false;
      }
    }

    // Clear every local trace on this device, whatever happened in the cloud.
    for (const key of [
      'countup_active_shop',
      'countup_items',
      'countup_sales',
      'countup_customers',
      'countup_payments',
      'countup_expenses',
      'countup_pending_queue',
    ]) {
      localStorage.removeItem(key);
    }
    setShop(null);
    setItems([]);
    setSales([]);
    setCustomers([]);
    setCreditPayments([]);
    setExpenses([]);
    setPendingQueue([]);
    setIsLoading(false);
    return true;
  };

  // Subscription info
  const planSubscription = shop
    ? getSubscriptionInfo(shop.createdAt, shop.planExpiryDate, shop.planStatus)
    : {
        daysRemaining: 30,
        graceDaysRemaining: 33,
        effectiveExpiry: new Date(),
        status: 'trial' as const,
        isWarningPeriod: false,
        canRecordSales: true,
      };

  // A shop suspended by the platform owner is read-only: records stay viewable and
  // exportable, but new sales are locked. Without this the admin "Deactivate"
  // action had no effect on the shop it was applied to.
  const isShopDeactivated = Boolean(shop?.isDeactivated);
  const subscription = isShopDeactivated
    ? { ...planSubscription, canRecordSales: false }
    : planSubscription;

  // Record a sale (under 15-second flow)
  const recordSale = async (
    saleData: Omit<Sale, 'id' | 'shopId' | 'createdAt'>
  ): Promise<string> => {
    if (!shop) throw new Error('No active shop');
    if (shop.isDeactivated) throw new Error('This shop has been deactivated');

    // Guard rail: the cart must never contain more than the stock on hand, or the
    // stock book silently drifts out of step with reality.
    for (const sold of saleData.items) {
      const stockItem = items.find((i) => i.id === sold.itemId);
      if (!stockItem) throw new Error(`"${sold.name}" is no longer in your stock book.`);
      if (sold.quantity > stockItem.quantity) {
        throw new Error(
          `Only ${stockItem.quantity} of "${stockItem.name}" left in stock — reduce the quantity to continue.`
        );
      }
    }

    const saleId = `sale_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();

    const newSale: Sale = {
      id: saleId,
      shopId: shop.id,
      ...saleData,
      createdAt: nowIso,
    };

    // 1. Reduce stock for sold items & update lastSoldAt for quick re-access
    const updatedItems = items.map((item) => {
      const soldItem = saleData.items.find((si) => si.itemId === item.id);
      if (soldItem) {
        const newQty = Math.max(0, item.quantity - soldItem.quantity);
        return {
          ...item,
          quantity: newQty,
          lastSoldAt: nowIso,
          updatedAt: nowIso,
        };
      }
      return item;
    });

    setItems(updatedItems);
    setSales((prev) => [newSale, ...prev]);

    // 2. If sale is "On credit", update customer's balance
    if (saleData.paymentType === 'credit' && saleData.customerId) {
      setCustomers((prev) =>
        prev.map((c) => {
          if (c.id === saleData.customerId) {
            return {
              ...c,
              totalOwed: c.totalOwed + saleData.totalAmount,
              updatedAt: nowIso,
            };
          }
          return c;
        })
      );
    }

    // 3. Persist to Firestore or queue.
    //
    // One atomic batch: the sale, the new stock levels and the credit balance land
    // together. Written one-by-one, a dropped connection halfway through left a sale
    // recorded against stock that never went down, and the real-time listeners
    // reflected that broken half-state on screen.
    const salePath = `shops/${shop.id}/sales/${saleId}`;
    const stockUpdates = saleData.items
      .map((sold) => updatedItems.find((i) => i.id === sold.itemId))
      .filter((i): i is Item => Boolean(i));
    const creditCustomer =
      saleData.paymentType === 'credit' && saleData.customerId
        ? customers.find((c) => c.id === saleData.customerId)
        : undefined;

    if (navigator.onLine && auth.currentUser) {
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, salePath), newSale);
        for (const item of stockUpdates) {
          batch.set(doc(db, `shops/${shop.id}/items/${item.id}`), item, { merge: true });
        }
        if (creditCustomer) {
          batch.set(
            doc(db, `shops/${shop.id}/customers/${creditCustomer.id}`),
            {
              totalOwed: creditCustomer.totalOwed + saleData.totalAmount,
              updatedAt: nowIso,
            },
            { merge: true }
          );
        }
        await batch.commit();
      } catch (err) {
        console.warn('Sale sync error, queuing locally:', err);
        queueAction('sale', salePath, newSale);
        for (const item of stockUpdates) {
          queueAction('stock_update', `shops/${shop.id}/items/${item.id}`, item);
        }
        if (creditCustomer) {
          queueAction('customer', `shops/${shop.id}/customers/${creditCustomer.id}`, {
            totalOwed: creditCustomer.totalOwed + saleData.totalAmount,
            updatedAt: nowIso,
          });
        }
      }
    } else {
      queueAction('sale', salePath, newSale);
      for (const item of stockUpdates) {
        queueAction('stock_update', `shops/${shop.id}/items/${item.id}`, item);
      }
      if (creditCustomer) {
        queueAction('customer', `shops/${shop.id}/customers/${creditCustomer.id}`, {
          totalOwed: creditCustomer.totalOwed + saleData.totalAmount,
          updatedAt: nowIso,
        });
      }
    }

    return saleId;
  };

  // Void a sale recorded by mistake.
  //
  // Puts the stock back, takes the amount off the customer's credit balance if it
  // was a credit sale, and hides the sale from reports — all in one atomic batch so
  // the ledger and the stock book can never disagree afterwards. Limited to today's
  // sales on purpose: a shopkeeper should not be able to rewrite last week's books.
  const voidSale = async (saleId: string): Promise<Sale> => {
    if (!shop) throw new Error('No active shop');
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) throw new Error('That sale is no longer in your records.');
    if (!isTodayIso(sale.createdAt)) {
      throw new Error('Only sales recorded today can be undone. Older sales stay in your reports.');
    }

    const nowIso = new Date().toISOString();

    // Restore stock for every item in the sale (skip items since deleted).
    const restoredItems: Item[] = [];
    for (const sold of sale.items) {
      const live = items.find((i) => i.id === sold.itemId);
      if (!live) continue;
      restoredItems.push({
        ...live,
        quantity: live.quantity + sold.quantity,
        updatedAt: nowIso,
      });
    }

    const creditCustomer =
      sale.paymentType === 'credit' && sale.customerId
        ? customers.find((c) => c.id === sale.customerId)
        : undefined;
    const restoredOwed = creditCustomer
      ? Math.max(0, Number((creditCustomer.totalOwed - sale.totalAmount).toFixed(2)))
      : undefined;

    // Optimistic local state first — the shopkeeper sees the correction instantly.
    setSales((prev) => prev.filter((s) => s.id !== saleId));
    setItems((prev) => prev.map((i) => restoredItems.find((r) => r.id === i.id) ?? i));
    if (creditCustomer && restoredOwed !== undefined) {
      setCustomers((prev) =>
        prev.map((c) =>
          c.id === creditCustomer.id ? { ...c, totalOwed: restoredOwed, updatedAt: nowIso } : c
        )
      );
    }

    const salePath = `shops/${shop.id}/sales/${saleId}`;
    if (navigator.onLine && auth.currentUser) {
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, salePath), { isDeleted: true }, { merge: true });
        for (const item of restoredItems) {
          batch.set(doc(db, `shops/${shop.id}/items/${item.id}`), item, { merge: true });
        }
        if (creditCustomer && restoredOwed !== undefined) {
          batch.set(
            doc(db, `shops/${shop.id}/customers/${creditCustomer.id}`),
            { totalOwed: restoredOwed, updatedAt: nowIso },
            { merge: true }
          );
        }
        await batch.commit();
        return sale;
      } catch (e) {
        console.warn('Void sale sync note, queued for retry:', e);
      }
    }

    queueAction('sale', salePath, { isDeleted: true });
    for (const item of restoredItems) {
      queueAction('stock_update', `shops/${shop.id}/items/${item.id}`, item);
    }
    if (creditCustomer && restoredOwed !== undefined) {
      queueAction('customer', `shops/${shop.id}/customers/${creditCustomer.id}`, {
        totalOwed: restoredOwed,
        updatedAt: nowIso,
      });
    }
    return sale;
  };

  // Add Item to Stock
  const addItem = async (
    itemData: Omit<Item, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!shop) throw new Error('No active shop');
    const itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();

    const newItem: Item = {
      id: itemId,
      shopId: shop.id,
      ...itemData,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    setItems((prev) => [newItem, ...prev]);

    const path = `shops/${shop.id}/items/${itemId}`;
    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), newItem);
      } catch {
        queueAction('item', path, newItem);
      }
    } else {
      queueAction('item', path, newItem);
    }

    return itemId;
  };

  // Update Item
  const updateItem = async (itemId: string, patch: Partial<Item>) => {
    if (!shop) return;
    const nowIso = new Date().toISOString();
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, ...patch, updatedAt: nowIso } : i))
    );

    const path = `shops/${shop.id}/items/${itemId}`;
    const updated = items.find((i) => i.id === itemId);
    if (updated) {
      const merged = { ...updated, ...patch, updatedAt: nowIso };
      if (navigator.onLine && auth.currentUser) {
        try {
          await setDoc(doc(db, path), merged, { merge: true });
        } catch {
          queueAction('item', path, merged);
        }
      } else {
        queueAction('item', path, merged);
      }
    }
  };

  // Quick Restock (+5, +10, etc.)
  const quickRestock = async (itemId: string, quantityToAdd: number) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const newQty = item.quantity + quantityToAdd;
    await updateItem(itemId, { quantity: newQty });
  };

  // Delete Item (soft delete: the document is flagged, never destroyed, so an
  // accidental removal can be undone from the toast that follows)
  const deleteItem = async (itemId: string) => {
    if (!shop) return;
    const path = `shops/${shop.id}/items/${itemId}`;
    setItems((prev) => prev.filter((i) => i.id !== itemId));

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), { isDeleted: true }, { merge: true });
        return;
      } catch (e) {
        console.warn('Delete item sync note, queued for retry:', e);
      }
    }
    queueAction('item', path, { isDeleted: true });
  };

  // Put a deleted item back exactly as it was (undo)
  const restoreItem = async (item: Item) => {
    if (!shop) return;
    const path = `shops/${shop.id}/items/${item.id}`;
    const restored: Item = { ...item, updatedAt: new Date().toISOString() };
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [restored, ...prev]));

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), { ...restored, isDeleted: false }, { merge: true });
        return;
      } catch (e) {
        console.warn('Restore item sync note, queued for retry:', e);
      }
    }
    queueAction('item', path, { ...restored, isDeleted: false });
  };

  // Add Customer to Credit Book
  const addCustomer = async (name: string, phone?: string): Promise<Customer> => {
    if (!shop) throw new Error('No active shop');
    const customerId = `cust_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();

    const newCustomer: Customer = {
      id: customerId,
      shopId: shop.id,
      name: name.trim(),
      phone: phone?.trim(),
      totalOwed: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    setCustomers((prev) => [newCustomer, ...prev]);

    const path = `shops/${shop.id}/customers/${customerId}`;
    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), newCustomer);
      } catch {
        queueAction('customer', path, newCustomer);
      }
    } else {
      queueAction('customer', path, newCustomer);
    }

    return newCustomer;
  };

  // Record Credit Payment
  //
  // Returns what was actually applied. Over-paying used to be accepted, silently
  // clamped to a zero balance and still stored the inflated amount — the ledger no
  // longer adds up as soon as that happens, so it is refused here instead.
  const recordCreditPayment = async (
    customerId: string,
    amount: number,
    note?: string
  ): Promise<{ applied: number; remaining: number }> => {
    if (!shop) throw new Error('No active shop');
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) throw new Error('That customer is no longer in your credit book.');
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Enter an amount greater than zero.');
    }
    if (amount > customer.totalOwed) {
      throw new Error(
        `${customer.name} only owes K ${customer.totalOwed.toFixed(2)} — enter that amount or less.`
      );
    }

    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();

    const newPayment: CreditPayment = {
      id: paymentId,
      shopId: shop.id,
      customerId,
      customerName: customer.name,
      amount,
      note,
      createdAt: nowIso,
    };

    setCreditPayments((prev) => [newPayment, ...prev]);

    // Update customer owed amount
    const newTotalOwed = Math.max(0, Number((customer.totalOwed - amount).toFixed(2)));
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === customerId ? { ...c, totalOwed: newTotalOwed, updatedAt: nowIso } : c
      )
    );

    const paymentPath = `shops/${shop.id}/credit_payments/${paymentId}`;
    const customerPath = `shops/${shop.id}/customers/${customerId}`;

    if (navigator.onLine && auth.currentUser) {
      try {
        // Atomic: a payment must never land without its matching balance change.
        const batch = writeBatch(db);
        batch.set(doc(db, paymentPath), newPayment);
        batch.set(
          doc(db, customerPath),
          { totalOwed: newTotalOwed, updatedAt: nowIso },
          { merge: true }
        );
        await batch.commit();
      } catch {
        queueAction('payment', paymentPath, newPayment);
        queueAction('customer', customerPath, { totalOwed: newTotalOwed, updatedAt: nowIso });
      }
    } else {
      queueAction('payment', paymentPath, newPayment);
      queueAction('customer', customerPath, { totalOwed: newTotalOwed, updatedAt: nowIso });
    }

    return { applied: amount, remaining: newTotalOwed };
  };

  // Add Expense
  const addExpense = async (category: Expense['category'], amount: number, note?: string) => {
    if (!shop) return;
    const expenseId = `exp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();

    const newExpense: Expense = {
      id: expenseId,
      shopId: shop.id,
      category,
      amount,
      note,
      createdAt: nowIso,
    };

    setExpenses((prev) => [newExpense, ...prev]);

    const path = `shops/${shop.id}/expenses/${expenseId}`;
    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), newExpense);
      } catch {
        queueAction('expense', path, newExpense);
      }
    } else {
      queueAction('expense', path, newExpense);
    }
  };

  // Expenses are soft-deleted like stock items: without a write the row simply
  // reappeared on the next real-time snapshot, so the delete looked broken.
  const deleteExpense = async (expenseId: string) => {
    if (!shop) return;
    const path = `shops/${shop.id}/expenses/${expenseId}`;
    setExpenses((prev) => prev.filter((e) => e.id !== expenseId));

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), { isDeleted: true }, { merge: true });
        return;
      } catch (e) {
        console.warn('Delete expense sync note, queued for retry:', e);
      }
    }
    queueAction('expense', path, { isDeleted: true });
  };

  const restoreExpense = async (expense: Expense) => {
    if (!shop) return;
    const path = `shops/${shop.id}/expenses/${expense.id}`;
    setExpenses((prev) => (prev.some((e) => e.id === expense.id) ? prev : [expense, ...prev]));

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, path), { ...expense, isDeleted: false }, { merge: true });
        return;
      } catch (e) {
        console.warn('Restore expense sync note, queued for retry:', e);
      }
    }
    queueAction('expense', path, { ...expense, isDeleted: false });
  };

  // Admin Controls
  const adminExtendShop = async (shopId: string, days: number) => {
    const targetShop = allShops.find((s) => s.id === shopId) || (shop?.id === shopId ? shop : null);
    if (!targetShop) return;

    const currentExpiry = targetShop.planExpiryDate
      ? new Date(targetShop.planExpiryDate)
      : new Date();
    const base = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    const patched: Partial<Shop> = {
      planStatus: 'active',
      planExpiryDate: newExpiry.toISOString(),
    };

    if (shop?.id === shopId) {
      setShop((prev) => (prev ? { ...prev, ...patched } : null));
    }

    setAllShops((prev) => prev.map((s) => (s.id === shopId ? { ...s, ...patched } : s)));

    if (navigator.onLine) {
      await setDoc(doc(db, 'shops', shopId), patched, { merge: true });
    }
  };

  const adminToggleDeactivate = async (shopId: string) => {
    const targetShop = allShops.find((s) => s.id === shopId) || (shop?.id === shopId ? shop : null);
    if (!targetShop) return;

    const newStatus = !targetShop.isDeactivated;
    const patched: Partial<Shop> = { isDeactivated: newStatus };

    if (shop?.id === shopId) {
      setShop((prev) => (prev ? { ...prev, ...patched } : null));
    }

    setAllShops((prev) => prev.map((s) => (s.id === shopId ? { ...s, ...patched } : s)));

    if (navigator.onLine) {
      await setDoc(doc(db, 'shops', shopId), patched, { merge: true });
    }
  };

  return (
    <ShopContext.Provider
      value={{
        user,
        shop,
        isLoading,
        isAdmin,
        loginWithPhoneAndPin,
        registerNewShop,
        logout,
        deleteShopAccount,
        changePin,
        language,
        setLanguage,
        t,
        activeTab,
        setActiveTab,
        items,
        sales,
        customers,
        creditPayments,
        expenses,
        recordSale,
        voidSale,
        addItem,
        updateItem,
        quickRestock,
        deleteItem,
        restoreItem,
        addCustomer,
        recordCreditPayment,
        addExpense,
        deleteExpense,
        restoreExpense,
        subscription,
        isShopDeactivated,
        isOnline,
        pendingSyncCount: pendingQueue.length,
        isSyncing,
        syncNow,
        lastOfflineNotice,
        clearOfflineNotice: () => setLastOfflineNotice(null),
        allShops,
        adminExtendShop,
        adminToggleDeactivate,
      }}
    >
      {children}
    </ShopContext.Provider>
  );
};

// The provider and its hook intentionally live together.
// eslint-disable-next-line react-refresh/only-export-components
export const useShop = () => {
  const context = useContext(ShopContext);
  if (!context) {
    throw new Error('useShop must be used within a ShopProvider');
  }
  return context;
};
