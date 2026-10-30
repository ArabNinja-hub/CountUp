import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  Shop,
  Item,
  Sale,
  Customer,
  CreditPayment,
  Expense,
  Language,
  ActiveTab,
  StockMovement,
  StockConflict,
} from '../types';
import { translations, Translations } from '../i18n/translations';
import { getSubscriptionInfo } from '../config/plans';
import { auth, db, testConnection } from '../firebase/config';
import { useToast } from '../components/Toast';
import {
  cleanForFirestore,
  reconcile,
  replayQueuedWrites,
  PendingSyncAction,
  SyncAdjustment,
  SyncProjectionDocument,
  rebaseQueuedProjections,
  isTransientSyncError,
} from '../utils/sync';
import {
  reviewableAction,
  voidActionSaleId,
  SyncConflictReview,
  SyncReviewDecision,
  SyncResolutionAudit,
} from '../services/syncReview';
import { addKwacha, localDateKey, multiplyKwacha, toNgwee } from '../utils/money';
import { normalizeZambianPhone } from '../utils/format';
import { prepareLegacyBackupImport, LegacyBackupImport } from '../services/backupImport';
import {
  signInAnonymously,
  onAuthStateChanged,
  User,
  EmailAuthProvider,
  linkWithCredential,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  writeBatch,
  getDoc,
  getDocFromServer,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  where,
  getDocs,
  getDocsFromServer,
  runTransaction,
  DocumentData,
  Transaction,
} from 'firebase/firestore';

/**
 * Payload of a queued write. The concrete shape depends on `type` (a Sale, an
 * Item, a partial patch…), so the queue only promises that it is a plain object
 * and Firestore is given it as `DocumentData` at write time.
 */
type QueuePayload = object;

interface ShopContextType {
  // Auth & Shop
  user: User | null;
  shop: Shop | null;
  isLoading: boolean;
  isAdmin: boolean;
  loginWithPhoneAndPin: (phone: string, pin: string) => Promise<boolean>;
  registerNewShop: (name: string, phone: string, pin: string) => Promise<boolean>;
  linkEmailAccount: (email: string, password: string) => Promise<void>;
  needsShopAccountRecovery: boolean;
  restoreShopAccount: (email: string, password: string) => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<Shop[]>;
  loginAsAdmin: (email: string, password: string) => Promise<void>;
  cancelEmailLogin: () => Promise<void>;
  selectEmailShop: (shop: Shop) => void;
  resetEmailPassword: (email: string) => Promise<void>;
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
  archivedItems: Item[];
  stockMovements: StockMovement[];
  stockConflicts: StockConflict[];
  resolveStockConflict: (conflictId: string) => Promise<void>;
  sales: Sale[];
  customers: Customer[];
  creditPayments: CreditPayment[];
  expenses: Expense[];
  importLegacyBackup: (raw: string) => Promise<LegacyBackupImport>;

  // Actions
  recordSale: (saleData: Omit<Sale, 'id' | 'shopId' | 'createdAt'>) => Promise<Sale>;
  /** Undo a sale recorded today: restores stock and credit. Returns the voided sale. */
  voidSale: (saleId: string) => Promise<Sale>;
  addItem: (itemData: Omit<Item, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateItem: (itemId: string, patch: Partial<Item>) => Promise<void>;
  quickRestock: (itemId: string, quantityToAdd: number) => Promise<void>;
  adjustStock: (
    itemId: string,
    mode: 'add' | 'subtract' | 'set',
    quantity: number,
    reason: string
  ) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  restoreItem: (item: Item) => Promise<void>;
  addCustomer: (name: string, phone?: string) => Promise<Customer>;
  updateCustomer: (
    customerId: string,
    patch: Pick<Customer, 'name' | 'phone' | 'notes'>
  ) => Promise<void>;
  recordCreditPayment: (
    customerId: string,
    amount: number,
    note?: string,
    paymentMethod?: 'cash' | 'momo'
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
  blockedSync: { actionId: string; kind: 'payment' | 'void' } | null;
  loadSyncReview: (actionId: string) => Promise<SyncConflictReview>;
  resolveSyncReview: (
    review: SyncConflictReview,
    decision: SyncReviewDecision
  ) => Promise<'resolved' | 'already-processed'>;
  loadSyncResolutionHistory: () => Promise<SyncResolutionAudit[]>;
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

/** Legacy shops may have been created with the international form in their ID. */
function shopIdsForPhone(phone: string): string[] {
  const national = normalizeZambianPhone(phone);
  const candidates = [national];
  if (/^0\d{9}$/.test(national)) candidates.push(`260${national.slice(1)}`);
  return [...new Set(candidates)].map((candidate) => `shop_${candidate}`);
}

/** Only the full, first queued creation can reserve an owner or defer listeners. */
function hasQueuedOfflineShopCreate(shop: Shop, queue: PendingSyncAction[]): boolean {
  const first = queue[0];
  if (!first) return false;
  return (first.writes ?? [{ path: first.path, data: first.data }]).some((write) => {
    const data = write.data as Partial<Shop> | null | undefined;
    return (
      write.path === `shops/${shop.id}` &&
      data?.id === shop.id &&
      data.createdAt === shop.createdAt &&
      (data.ownerUid === shop.id || data.ownerUid === shop.ownerUid)
    );
  });
}

class CreditBalanceConflict extends Error {
  constructor() {
    super(
      'A repayment or void conflicts with a newer customer balance. Review the entry before retrying.'
    );
  }
}

/** Read the affected records after a reviewed operation, including absent void movements. */
async function readResolutionBase(
  transaction: Transaction,
  action: PendingSyncAction
): Promise<SyncProjectionDocument[]> {
  const paths = new Set<string>([action.path]);
  for (const adjustment of action.adjustments ?? []) {
    paths.add(adjustment.path);
    if (adjustment.kind === 'stock') paths.add(adjustment.movement.path);
  }
  const list = [...paths];
  const snapshots = await Promise.all(list.map((path) => transaction.get(doc(db, path))));
  return snapshots.map((snapshot, index) => ({
    path: list[index],
    data: snapshot.exists() ? snapshot.data() : null,
  }));
}

function readInitialCache() {
  const read = <T,>(key: string, fallback: T): T => {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  };
  const queue = read<PendingSyncAction[]>('countup_pending_queue', []);
  let shop = read<Shop | null>('countup_active_shop', null);
  for (const action of queue) {
    for (const write of action.writes ?? [{ path: action.path, data: action.data }]) {
      const [collectionName, id, ...rest] = write.path.split('/');
      if (collectionName !== 'shops' || !id || rest.length) continue;
      const data = write.data as Partial<Shop>;
      if (!shop && data.id === id && data.name && data.ownerUid && data.pin) shop = data as Shop;
      else if (shop?.id === id && typeof data.pin === 'string') shop = { ...shop, pin: data.pin };
    }
  }
  const root = shop ? `shops/${shop.id}` : '';
  const replay = <T extends { id: string }>(cached: T[], collectionName: string) =>
    root ? replayQueuedWrites(cached, queue, `${root}/${collectionName}`) : cached;
  const allItems = replay(
    [...read<Item[]>('countup_items', []), ...read<Item[]>('countup_archived_items', [])],
    'items'
  );
  return {
    shop,
    queue,
    items: allItems.filter((item) => !item.isDeleted),
    archivedItems: allItems.filter((item) => item.isDeleted),
    movements: replay(read<StockMovement[]>('countup_stock_movements', []), 'stock_movements'),
    conflicts: replay(read<StockConflict[]>('countup_stock_conflicts', []), 'stock_conflicts'),
    sales: replay(read<(Sale & { isDeleted?: boolean })[]>('countup_sales', []), 'sales').filter(
      (sale) => !sale.isDeleted
    ),
    customers: replay(read<Customer[]>('countup_customers', []), 'customers'),
    payments: replay(read<CreditPayment[]>('countup_payments', []), 'credit_payments'),
    expenses: replay(
      read<(Expense & { isDeleted?: boolean })[]>('countup_expenses', []),
      'expenses'
    ).filter((expense) => !expense.isDeleted),
  };
}

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { notify } = useToast();
  const [initial] = useState(readInitialCache);
  const [user, setUser] = useState<User | null>(null);
  const [shop, setShop] = useState<Shop | null>(initial.shop);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const authReadyRef = React.useRef(false);

  // Associate the grant with a UID, so a change of Firebase account can never
  // inherit the previous account's admin state for even one render.
  const [adminUid, setAdminUid] = useState<string | null>(null);
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('countup_language') as Language;
    return saved === 'bem' || saved === 'nya' ? saved : 'en';
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');

  // Recover from the durable queue as well as the cache: a tab can close after
  // an operation was queued but before React's cache effects have run.
  const [items, setItems] = useState<Item[]>(initial.items);
  const [archivedItems, setArchivedItems] = useState<Item[]>(initial.archivedItems);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>(initial.movements);
  const [stockConflicts, setStockConflicts] = useState<StockConflict[]>(initial.conflicts);
  const [sales, setSales] = useState<Sale[]>(initial.sales);
  const [customers, setCustomers] = useState<Customer[]>(initial.customers);
  const [creditPayments, setCreditPayments] = useState<CreditPayment[]>(initial.payments);
  const [expenses, setExpenses] = useState<Expense[]>(initial.expenses);

  // Offline queue
  const [pendingQueue, setPendingQueue] = useState<PendingSyncAction[]>(initial.queue);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const isAdmin = Boolean(user && isOnline && adminUid === user.uid);
  const queuedShopCreate = Boolean(shop && hasQueuedOfflineShopCreate(shop, pendingQueue));
  const reservedOwnerUid = queuedShopCreate ? pendingQueue[0].reservedOwnerUid : undefined;
  const hasShopSession = Boolean(
    shop &&
    user &&
    (reservedOwnerUid
      ? user.uid === reservedOwnerUid
      : user.uid === shop.ownerUid || user.uid === shop.id)
  );
  const needsShopAccountRecovery = Boolean(
    shop && !hasShopSession && !(queuedShopCreate && shop.ownerUid === shop.id && !reservedOwnerUid)
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [blockedSync, setBlockedSync] = useState<{
    actionId: string;
    kind: 'payment' | 'void';
  } | null>(null);
  const [lastOfflineNotice, setLastOfflineNotice] = useState<string | null>(null);

  // Platform admin shops list
  const [allShops, setAllShops] = useState<Shop[]>([]);

  // Keep the latest state reachable from long-lived listeners without making them
  // re-subscribe on every change (a re-subscribe per sale drops real-time updates).
  const shopRef = React.useRef(shop);
  shopRef.current = shop;
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const archivedItemsRef = React.useRef(archivedItems);
  archivedItemsRef.current = archivedItems;
  const movementsRef = React.useRef(stockMovements);
  movementsRef.current = stockMovements;
  const conflictsRef = React.useRef(stockConflicts);
  conflictsRef.current = stockConflicts;
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
  const remoteRef = React.useRef<{
    shopId: string;
    items?: Item[];
    sales?: Sale[];
    customers?: Customer[];
    payments?: CreditPayment[];
    expenses?: Expense[];
    movements?: StockMovement[];
    conflicts?: StockConflict[];
  }>({ shopId: '' });

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
      setLastOfflineNotice(null);
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
    if (shopRef.current) {
      localStorage.setItem('countup_active_shop', JSON.stringify(shopRef.current));
    } else {
      localStorage.removeItem('countup_active_shop');
    }
  }, [shop]);

  useEffect(() => {
    localStorage.setItem('countup_items', JSON.stringify(itemsRef.current));
  }, [items]);

  useEffect(() => {
    localStorage.setItem('countup_archived_items', JSON.stringify(archivedItemsRef.current));
  }, [archivedItems]);

  useEffect(() => {
    localStorage.setItem('countup_stock_movements', JSON.stringify(movementsRef.current));
  }, [stockMovements]);

  useEffect(() => {
    localStorage.setItem('countup_stock_conflicts', JSON.stringify(conflictsRef.current));
  }, [stockConflicts]);

  useEffect(() => {
    localStorage.setItem('countup_sales', JSON.stringify(salesRef.current));
  }, [sales]);

  useEffect(() => {
    localStorage.setItem('countup_customers', JSON.stringify(customersRef.current));
  }, [customers]);

  useEffect(() => {
    localStorage.setItem('countup_payments', JSON.stringify(paymentsRef.current));
  }, [creditPayments]);

  useEffect(() => {
    localStorage.setItem('countup_expenses', JSON.stringify(expensesRef.current));
  }, [expenses]);

  // Queue changes are persisted synchronously before state changes; a later
  // effect must not overwrite that durable queue with an older render.

  // Firebase scopes shop records to a device's anonymous UID or to its linked
  // email account. An admin grant is checked separately against Firestore.
  useEffect(() => {
    let mounted = true;

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!mounted) return;
      authReadyRef.current = true;
      setUser(currentUser);
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // An anonymous Firebase identity is the only cloud key for a legacy shop.
  // Remember it so switching accounts cannot silently abandon that identity.
  useEffect(() => {
    if (shop && user?.isAnonymous && (shop.ownerUid === user.uid || shop.id === user.uid)) {
      localStorage.setItem('countup_legacy_uid', user.uid);
    }
  }, [shop, user]);

  // The admins registry is the only grant (also enforced in Firestore rules).
  // A server read avoids granting access from a stale offline cache.
  useEffect(() => {
    let cancelled = false;
    const uid = user?.uid;
    if (!uid || !isOnline) {
      setAdminUid(null);
      return;
    }
    setAdminUid(null);
    void (async () => {
      try {
        const snap = await getDocFromServer(doc(db, 'admins', uid));
        if (!cancelled) setAdminUid(snap.exists() ? uid : null);
      } catch {
        if (!cancelled) setAdminUid(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, isOnline]);

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
    // Subcollection rules require an existing parent shop. Starting listeners
    // before its offline create is acknowledged can produce a permanent
    // permission-denied error, leaving this tab with stale stock and balances.
    if (!shop?.id || !user || queuedShopCreate) {
      remoteRef.current = { shopId: '' };
      return;
    }

    const shopId = shop.id;
    remoteRef.current = { shopId };
    const warn = (label: string) => (err: unknown) => {
      console.warn(`Real-time ${label} listener:`, err);
    };

    const unsubShop = onSnapshot(
      doc(db, 'shops', shopId),
      (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data() as Shop;
        // A listener may emit an older PIN while a change is still queued.
        const pendingPin = queueRef.current
          .flatMap((action) => action.writes ?? [{ path: action.path, data: action.data }])
          .filter((write) => write.path === `shops/${shopId}`)
          .map((write) => (write.data as { pin?: unknown }).pin)
          .filter((pin): pin is string => typeof pin === 'string')
          .at(-1);
        setShop((prev) => {
          // Firestore can emit a locally pending creation before the server
          // accepts it. Keep the provisional shop until its queued create is
          // acknowledged; a rejected create must not appear cloud-owned.
          if (
            prev &&
            prev.ownerUid === shopId &&
            hasQueuedOfflineShopCreate(prev, queueRef.current)
          )
            return prev;
          return { ...data, pin: pendingPin ?? data.pin ?? prev?.pin ?? '' };
        });
      },
      warn('shop')
    );

    const unsubItems = onSnapshot(
      collection(db, 'shops', shopId, 'items'),
      (snap) => {
        const remote: Item[] = [];
        snap.forEach((d) => remote.push(d.data() as Item));
        remoteRef.current.items = remote;
        const merged = reconcile(
          remote,
          [...itemsRef.current, ...archivedItemsRef.current],
          queueRef.current,
          `shops/${shopId}/items`
        );
        setItems(merged.filter((item) => !item.isDeleted));
        setArchivedItems(merged.filter((item) => item.isDeleted));
      },
      warn('items')
    );

    const unsubMovements = onSnapshot(
      collection(db, 'shops', shopId, 'stock_movements'),
      (snap) => {
        const remote: StockMovement[] = [];
        snap.forEach((d) => remote.push(d.data() as StockMovement));
        remoteRef.current.movements = remote;
        const merged = reconcile(
          remote,
          movementsRef.current,
          queueRef.current,
          `shops/${shopId}/stock_movements`
        );
        merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setStockMovements(merged);
      },
      warn('stock movements')
    );

    const unsubConflicts = onSnapshot(
      collection(db, 'shops', shopId, 'stock_conflicts'),
      (snap) => {
        const remote: StockConflict[] = [];
        snap.forEach((d) => remote.push(d.data() as StockConflict));
        remoteRef.current.conflicts = remote;
        setStockConflicts(
          reconcile(
            remote,
            conflictsRef.current,
            queueRef.current,
            `shops/${shopId}/stock_conflicts`
          )
        );
      },
      warn('stock conflicts')
    );

    const unsubSales = onSnapshot(
      collection(db, 'shops', shopId, 'sales'),
      (snap) => {
        const remote: Sale[] = [];
        snap.forEach((d) => {
          const data = d.data() as Sale & { isDeleted?: boolean };
          if (!data.isDeleted) remote.push(data);
        });
        remoteRef.current.sales = remote;
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
        remoteRef.current.customers = remote;
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
        remoteRef.current.payments = remote;
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
        remoteRef.current.expenses = remote;
        setExpenses(
          reconcile(remote, expensesRef.current, queueRef.current, `shops/${shopId}/expenses`)
        );
      },
      warn('expenses')
    );

    return () => {
      unsubShop();
      unsubItems();
      unsubMovements();
      unsubConflicts();
      unsubSales();
      unsubCustomers();
      unsubPayments();
      unsubExpenses();
    };
  }, [shop?.id, user, queuedShopCreate]);

  // A snapshot can arrive before its queued operation is acknowledged. Reapply
  // the latest server snapshots when the queue changes so a reconciled stock
  // shortfall or concurrent balance becomes visible immediately after sync.
  useEffect(() => {
    if (!shop?.id || remoteRef.current.shopId !== shop.id) return;
    const remote = remoteRef.current;
    const root = `shops/${shop.id}`;
    if (remote.items) {
      const merged = reconcile(
        remote.items,
        [...itemsRef.current, ...archivedItemsRef.current],
        pendingQueue,
        `${root}/items`
      );
      setItems(merged.filter((item) => !item.isDeleted));
      setArchivedItems(merged.filter((item) => item.isDeleted));
    }
    if (remote.sales)
      setSales(reconcile(remote.sales, salesRef.current, pendingQueue, `${root}/sales`));
    if (remote.customers)
      setCustomers(
        reconcile(remote.customers, customersRef.current, pendingQueue, `${root}/customers`)
      );
    if (remote.payments)
      setCreditPayments(
        reconcile(remote.payments, paymentsRef.current, pendingQueue, `${root}/credit_payments`)
      );
    if (remote.expenses)
      setExpenses(
        reconcile(remote.expenses, expensesRef.current, pendingQueue, `${root}/expenses`)
      );
    if (remote.movements)
      setStockMovements(
        reconcile(remote.movements, movementsRef.current, pendingQueue, `${root}/stock_movements`)
      );
    if (remote.conflicts)
      setStockConflicts(
        reconcile(remote.conflicts, conflictsRef.current, pendingQueue, `${root}/stock_conflicts`)
      );
  }, [pendingQueue, shop?.id]);

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

  // Resolve an acknowledgement durably. When the head was reviewed, its old
  // optimistic effects must be removed before later entries are replayed.
  const acknowledgeAction = useCallback(
    (action: PendingSyncAction, base?: SyncProjectionDocument[]) => {
      const remaining = queueRef.current.filter((entry) => entry.id !== action.id);
      if (!base) {
        localStorage.setItem('countup_pending_queue', JSON.stringify(remaining));
        queueRef.current = remaining;
        setPendingQueue(remaining);
        return;
      }
      const activeShop = shopRef.current;
      if (!activeShop) throw new Error('Open the original shop to finish sync.');
      const root = `shops/${activeShop.id}`;
      const projected = rebaseQueuedProjections(remaining, base);
      function mergeRecords<T extends { id: string }>(
        existing: T[],
        name: string,
        changes: SyncProjectionDocument[],
        hideDeleted = false
      ): T[] {
        const records = new Map(existing.map((entry) => [entry.id, entry]));
        const prefix = `${root}/${name}/`;
        for (const change of changes) {
          if (!change.path.startsWith(prefix)) continue;
          const id = change.path.slice(prefix.length);
          if (!id || id.includes('/')) continue;
          if (!change.data || (hideDeleted && change.data.isDeleted === true)) records.delete(id);
          else records.set(id, { ...change.data, id } as T);
        }
        return [...records.values()];
      }
      const changed = (name: string) =>
        projected.documents.some((entry) => entry.path.startsWith(`${root}/${name}/`));
      const allItems = mergeRecords(
        [...itemsRef.current, ...archivedItemsRef.current],
        'items',
        projected.documents
      );
      const nextItems = allItems.filter((item) => !item.isDeleted);
      const nextArchived = allItems.filter((item) => item.isDeleted);
      const nextSales = mergeRecords(salesRef.current, 'sales', projected.documents, true);
      const nextCustomers = mergeRecords(customersRef.current, 'customers', projected.documents);
      const nextPayments = mergeRecords(
        paymentsRef.current,
        'credit_payments',
        projected.documents
      );
      const nextMovements = mergeRecords(
        movementsRef.current,
        'stock_movements',
        projected.documents
      );
      // Write caches before acknowledging the head. A crash before the queue
      // write leaves its marker in place, so the rebase can safely be repeated.
      if (changed('items')) {
        localStorage.setItem('countup_items', JSON.stringify(nextItems));
        localStorage.setItem('countup_archived_items', JSON.stringify(nextArchived));
      }
      if (changed('sales')) localStorage.setItem('countup_sales', JSON.stringify(nextSales));
      if (changed('customers'))
        localStorage.setItem('countup_customers', JSON.stringify(nextCustomers));
      if (changed('credit_payments'))
        localStorage.setItem('countup_payments', JSON.stringify(nextPayments));
      if (changed('stock_movements'))
        localStorage.setItem('countup_stock_movements', JSON.stringify(nextMovements));
      localStorage.setItem('countup_pending_queue', JSON.stringify(projected.queue));

      // Make the last server snapshot agree with this transaction. Otherwise a
      // queue-change effect could briefly put an old value back on screen.
      const remote = remoteRef.current;
      if (remote.shopId === activeShop.id) {
        if (remote.items) remote.items = mergeRecords(remote.items, 'items', base);
        if (remote.sales) remote.sales = mergeRecords(remote.sales, 'sales', base, true);
        if (remote.customers) remote.customers = mergeRecords(remote.customers, 'customers', base);
        if (remote.payments)
          remote.payments = mergeRecords(remote.payments, 'credit_payments', base);
        if (remote.movements)
          remote.movements = mergeRecords(remote.movements, 'stock_movements', base);
      }
      itemsRef.current = nextItems;
      archivedItemsRef.current = nextArchived;
      salesRef.current = nextSales;
      customersRef.current = nextCustomers;
      paymentsRef.current = nextPayments;
      movementsRef.current = nextMovements;
      queueRef.current = projected.queue;
      setItems(nextItems);
      setArchivedItems(nextArchived);
      setSales(nextSales);
      setCustomers(nextCustomers);
      setCreditPayments(nextPayments);
      setStockMovements(nextMovements);
      setPendingQueue(projected.queue);
    },
    []
  );

  // Drain in FIFO order; every normal operation and its marker commit together.
  // Never acknowledge an entry before its cloud transaction and local queue write.
  const syncingRef = React.useRef(false);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptsRef = React.useRef(0);
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const syncNow = useCallback(
    async function drainQueue() {
      if (
        !navigator.onLine ||
        !authReadyRef.current ||
        syncingRef.current ||
        queueRef.current.length === 0
      )
        return;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      syncingRef.current = true;
      setIsSyncing(true);
      let synced = 0;
      let failure: unknown = null;
      let conflict: { actionId: string; kind: 'payment' | 'void' } | null = null;
      try {
        const activeShop = shopRef.current;
        if (!activeShop)
          throw new Error('Open the original shop to sync. Keep this browser’s data.');
        const root = `shops/${activeShop.id}`;
        const belongsToShop = (path: string) => path === root || path.startsWith(`${root}/`);
        const queueBelongsToShop = queueRef.current.every((entry) =>
          [
            entry.path,
            ...(entry.writes ?? []).map((write) => write.path),
            ...(entry.adjustments ?? []).flatMap((adjustment) =>
              adjustment.kind === 'stock'
                ? [adjustment.path, adjustment.movement.path]
                : [adjustment.path]
            ),
          ].every(belongsToShop)
        );
        if (!queueBelongsToShop)
          throw new Error('Pending entries belong to a different shop. Keep this browser’s data.');

        const queuedInitialCreate = hasQueuedOfflineShopCreate(activeShop, queueRef.current);
        const first = queueRef.current[0];
        const reservedUid = queuedInitialCreate ? first.reservedOwnerUid : undefined;
        const isUnclaimedShop =
          queuedInitialCreate && activeShop.ownerUid === activeShop.id && !reservedUid;
        const currentUser =
          auth.currentUser ?? (isUnclaimedShop ? await ensureFirebaseAuth(true) : null);
        if (!currentUser) {
          throw new Error(
            isUnclaimedShop
              ? 'Could not create a cloud session. Check your connection and tap Sync Now. Keep this browser’s data.'
              : 'Sign in to the original shop account in Account & cloud access. Keep this browser’s data.'
          );
        }
        if (
          (reservedUid && currentUser.uid !== reservedUid) ||
          (!reservedUid &&
            !isUnclaimedShop &&
            currentUser.uid !== activeShop.ownerUid &&
            currentUser.uid !== activeShop.id)
        ) {
          throw new Error(
            'A different account is signed in. Sign in to the original shop account; keep this browser’s data.'
          );
        }
        if (queuedInitialCreate && !reservedUid) {
          const next = queueRef.current.map((entry) =>
            entry.id === first.id ? { ...entry, reservedOwnerUid: currentUser.uid } : entry
          );
          localStorage.setItem('countup_pending_queue', JSON.stringify(next));
          queueRef.current = next;
          setPendingQueue(next);
        }
        while (queueRef.current.length > 0) {
          const action = queueRef.current[0];
          try {
            if (auth.currentUser?.uid !== currentUser.uid)
              throw new Error(
                'The account changed during sync. Sign in to the original shop account.'
              );
            if (!action.id || action.id.includes('/'))
              throw new Error('A waiting entry has an invalid ID. Keep this browser’s data.');
            const writes = action.writes ?? [{ path: action.path, data: action.data }];
            const writePaths = writes.map((write) => write.path);
            const adjustmentPaths = (action.adjustments ?? []).map((entry) => entry.path);
            if (
              !writes.length ||
              writes[0].path !== action.path ||
              new Set(writePaths).size !== writes.length ||
              new Set(adjustmentPaths).size !== adjustmentPaths.length ||
              (action.adjustments ?? []).some(
                (entry) =>
                  !writePaths.includes(entry.path) ||
                  (entry.kind === 'stock' && !writePaths.includes(entry.movement.path))
              )
            )
              throw new Error(
                'A waiting entry is incomplete or inconsistent. Keep this browser’s data.'
              );
            if (queuedInitialCreate && action.id === first.id) {
              if (writes.length !== 1 || writes[0].path !== root)
                throw new Error(
                  'The queued shop creation cannot be verified. Keep this browser’s data.'
                );
              const creation = cleanForFirestore(writes[0].data) as DocumentData;
              // A missing shop cannot be read by a non-owner under the existing
              // rules. Try a server read first; permission-denied still lets the
              // server's create rule decide if the subsequent write is allowed.
              let existing: Awaited<ReturnType<typeof getDocFromServer>> | null = null;
              try {
                existing = await getDocFromServer(doc(db, root));
              } catch (error) {
                if ((error as { code?: string })?.code !== 'permission-denied') throw error;
              }
              if (existing?.exists()) {
                const data = existing.data() as DocumentData;
                if (
                  data.id !== activeShop.id ||
                  data.createdAt !== creation.createdAt ||
                  data.ownerUid !== currentUser.uid
                )
                  throw new Error(
                    'A different shop already uses this number. Keep this browser’s data.'
                  );
                // The same creation was already accepted. Do not replay stale PIN or plan fields.
              } else {
                const batch = writeBatch(db);
                batch.set(
                  doc(db, root),
                  { ...creation, ownerUid: currentUser.uid },
                  { merge: true }
                );
                await batch.commit();
              }
              if (
                shopRef.current?.id === activeShop.id &&
                shopRef.current.ownerUid === activeShop.id
              ) {
                const boundShop = { ...shopRef.current, ownerUid: currentUser.uid };
                localStorage.setItem('countup_active_shop', JSON.stringify(boundShop));
                shopRef.current = boundShop;
                setShop(boundShop);
              }
              acknowledgeAction(action);
            } else {
              const possibleVoid = writes.some(
                (write) =>
                  write.path.startsWith(`${root}/sales/`) &&
                  (write.data as { isDeleted?: boolean }).isDeleted === true
              );
              const voidId = voidActionSaleId(action, activeShop.id);
              if (possibleVoid && !voidId)
                throw new Error(
                  'This queued sale undo cannot be verified. Keep this browser’s data.'
                );
              const result = await runTransaction(db, async (transaction) => {
                const marker = doc(db, `${root}/sync_operations/${action.id}`);
                const markerSnapshot = await transaction.get(marker);
                if (markerSnapshot.exists()) {
                  const markerData = markerSnapshot.data();
                  return markerData.resolution || markerData.outcome === 'already-voided'
                    ? await readResolutionBase(transaction, action)
                    : undefined;
                }
                const adjustments = action.adjustments ?? [];
                const [saleSnapshot, snapshots] = await Promise.all([
                  voidId
                    ? transaction.get(doc(db, `${root}/sales/${voidId}`))
                    : Promise.resolve(null),
                  Promise.all(adjustments.map((entry) => transaction.get(doc(db, entry.path)))),
                ]);
                if (voidId) {
                  if (!saleSnapshot?.exists())
                    throw new Error('The sale needed by this undo no longer exists.');
                  const sale = saleSnapshot.data() as Sale & { isDeleted?: boolean };
                  if (sale.isDeleted) {
                    // Another device already undid this exact sale: its stock and
                    // credit have already been restored, regardless of queue ID.
                    // Read before writing so later queued previews can be rebased.
                    const base = await readResolutionBase(transaction, action);
                    transaction.set(marker, {
                      appliedAt: new Date().toISOString(),
                      outcome: 'already-voided',
                      saleId: voidId,
                    });
                    return base;
                  }
                  const credit = adjustments.find((entry) => entry.kind === 'credit');
                  if (
                    (sale.paymentType === 'credit' &&
                      (!credit ||
                        credit.kind !== 'credit' ||
                        credit.path !== `${root}/customers/${sale.customerId}` ||
                        credit.deltaNgwee !== -toNgwee(sale.totalAmount))) ||
                    (sale.paymentType !== 'credit' && credit)
                  )
                    throw new Error(
                      'The sale or its customer changed; this undo needs manual review.'
                    );
                  for (const entry of adjustments) {
                    if (entry.kind !== 'stock') continue;
                    const line = sale.items?.find(
                      (item) => item.itemId === entry.movement.data.itemId
                    );
                    if (!line || line.quantity !== entry.delta)
                      throw new Error('The sale items changed; this undo needs manual review.');
                  }
                }
                if (snapshots.some((snapshot) => !snapshot.exists()))
                  throw new Error(
                    'A stock item or customer needed by this entry no longer exists.'
                  );
                const calculated = adjustments.map((adjustment, index) => {
                  const current = snapshots[index].data();
                  if (adjustment.kind === 'credit') {
                    const previous = toNgwee(Number(current.totalOwed));
                    if (previous < 0 || !Number.isSafeInteger(adjustment.deltaNgwee))
                      throw new Error('Invalid customer balance or queued credit adjustment.');
                    const next = previous + adjustment.deltaNgwee;
                    if (!Number.isSafeInteger(next))
                      throw new Error('The customer balance is too large.');
                    if (next < 0) throw new CreditBalanceConflict();
                    return {
                      adjustment,
                      next: next / 100,
                      previous: 0,
                      shortfall: 0,
                      staleCount: false,
                    };
                  }
                  const previous = Number(current.quantity);
                  if (
                    !Number.isSafeInteger(previous) ||
                    previous < 0 ||
                    !Number.isSafeInteger(adjustment.delta) ||
                    (adjustment.setTo !== undefined &&
                      (!Number.isSafeInteger(adjustment.setTo) || adjustment.setTo < 0))
                  )
                    throw new Error('Invalid stock quantity or queued stock adjustment.');
                  // A physical count based on stale stock cannot safely replace a
                  // newer value. Keep the request and ask for a fresh recount.
                  const staleCount =
                    adjustment.setTo !== undefined &&
                    adjustment.movement.data.previousQuantity !== previous;
                  const requested = staleCount
                    ? previous
                    : (adjustment.setTo ?? previous + adjustment.delta);
                  if (!Number.isSafeInteger(requested))
                    throw new Error('The stock quantity is too large.');
                  return {
                    adjustment,
                    previous,
                    next: Math.max(0, requested),
                    shortfall: Math.max(0, -requested),
                    staleCount,
                  };
                });
                const dynamicPaths = new Set(
                  adjustments.flatMap((adjustment) =>
                    adjustment.kind === 'stock'
                      ? [adjustment.path, adjustment.movement.path]
                      : [adjustment.path]
                  )
                );
                for (const write of writes) {
                  if (!dynamicPaths.has(write.path))
                    transaction.set(
                      doc(db, write.path),
                      cleanForFirestore(write.data) as DocumentData,
                      {
                        merge: true,
                      }
                    );
                }
                for (const [index, entry] of calculated.entries()) {
                  const adjustment = entry.adjustment;
                  if (adjustment.kind === 'credit') {
                    transaction.set(
                      doc(db, adjustment.path),
                      { totalOwed: entry.next, updatedAt: adjustment.updatedAt },
                      { merge: true }
                    );
                  } else {
                    transaction.set(
                      doc(db, adjustment.path),
                      cleanForFirestore({
                        ...adjustment.metadata,
                        quantity: entry.next,
                        updatedAt: adjustment.updatedAt,
                        ...(adjustment.lastSoldAt ? { lastSoldAt: adjustment.lastSoldAt } : {}),
                      }),
                      { merge: true }
                    );
                    transaction.set(
                      doc(db, adjustment.movement.path),
                      cleanForFirestore({
                        ...adjustment.movement.data,
                        ...(entry.staleCount
                          ? {
                              delta: 0,
                              requestedQuantity: adjustment.setTo,
                              recountNeeded: true,
                              reason: `${adjustment.movement.data.reason} (not applied; recount needed)`,
                            }
                          : {}),
                        previousQuantity: entry.previous,
                        newQuantity: entry.next,
                      })
                    );
                    if (entry.shortfall > 0 || entry.staleCount) {
                      const conflictId = `${action.id}_${index}`;
                      transaction.set(doc(db, `${root}/stock_conflicts/${conflictId}`), {
                        id: conflictId,
                        itemId: adjustment.movement.data.itemId,
                        itemName: adjustment.movement.data.itemName,
                        ...(entry.staleCount
                          ? {
                              kind: 'recount',
                              observed: adjustment.movement.data.previousQuantity,
                            }
                          : { kind: 'shortfall' }),
                        requested: entry.staleCount ? adjustment.setTo : Math.abs(adjustment.delta),
                        available: entry.previous,
                        shortfall: entry.shortfall,
                        relatedSaleId: adjustment.movement.data.relatedSaleId || '',
                        createdAt: adjustment.updatedAt,
                        resolved: false,
                      });
                    }
                  }
                }
                transaction.set(marker, { appliedAt: new Date().toISOString() });
                return undefined;
              });
              acknowledgeAction(action, result);
            }
            setBlockedSync(null);
            synced++;
          } catch (error) {
            console.warn('Sync failed; this and later entries remain queued:', action.id, error);
            if (error instanceof CreditBalanceConflict) {
              const reviewable = reviewableAction(action, activeShop.id);
              if (reviewable) conflict = { actionId: action.id, kind: reviewable.kind };
            }
            failure = error;
            break;
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        syncingRef.current = false;
        setIsSyncing(false);
      }
      if (failure) {
        setBlockedSync(conflict);
        const count = queueRef.current.length;
        const transient = isTransientSyncError(failure);
        const reason = failure instanceof Error ? failure.message : '';
        const detail = transient
          ? 'Connection to the server failed. Entries stay on this device; CountUp will retry automatically.'
          : reason || 'Tap Sync Now to retry.';
        setLastOfflineNotice(
          `${count} ${count === 1 ? 'entry' : 'entries'} could not sync yet. ${detail}`
        );
        if (!transient || retryAttemptsRef.current === 0) {
          notify('Some entries are still waiting to sync', {
            kind: 'error',
            detail,
          });
        }
        if (transient && navigator.onLine && queueRef.current.length) {
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(retryAttemptsRef.current, 4));
          retryAttemptsRef.current++;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void drainQueue();
          }, delay);
        } else {
          retryAttemptsRef.current = 0;
        }
      } else {
        retryAttemptsRef.current = 0;
        if (synced > 0) setLastOfflineNotice(null);
      }
    },
    [acknowledgeAction, notify]
  );

  useEffect(() => {
    if (!isLoading && isOnline && pendingQueue.length) void syncNow();
  }, [user, isLoading, isOnline, pendingQueue.length, syncNow]);

  const getReviewableHead = (actionId: string) => {
    const activeShop = shopRef.current;
    const currentUser = auth.currentUser;
    if (!navigator.onLine || !activeShop || !currentUser)
      throw new Error('Connect and sign in to the original shop account to review this entry.');
    if (currentUser.uid !== activeShop.ownerUid && currentUser.uid !== activeShop.id)
      throw new Error('Only the original shop account can review this entry.');
    const action = queueRef.current[0];
    if (!action || action.id !== actionId)
      throw new Error('The waiting entry has changed. Close this review and check sync again.');
    const description = reviewableAction(action, activeShop.id);
    if (!description)
      throw new Error('This entry cannot be reviewed safely in the app. Keep this browser’s data.');
    return { activeShop, currentUser, description };
  };

  const loadSyncReview = async (actionId: string): Promise<SyncConflictReview> => {
    const { activeShop, currentUser, description } = getReviewableHead(actionId);
    const markerPath = `shops/${activeShop.id}/sync_operations/${actionId}`;
    const targetPath =
      description.kind === 'payment' ? description.paymentPath : description.salePath;
    const [marker, customer, target] = await Promise.all([
      getDocFromServer(doc(db, markerPath)),
      getDocFromServer(doc(db, description.customerPath)),
      getDocFromServer(doc(db, targetPath)),
    ]);
    if (auth.currentUser?.uid !== currentUser.uid || queueRef.current[0]?.id !== actionId)
      throw new Error(
        'The account or waiting entry changed. Close this review and check sync again.'
      );
    const customerData = customer.exists() ? customer.data() : null;
    const serverBalance = customerData ? Number(customerData.totalOwed) : 0;
    if (customerData && toNgwee(serverBalance) < 0)
      throw new Error('The server has an invalid customer balance. Keep this browser’s data.');
    const customerName =
      typeof customerData?.name === 'string'
        ? customerData.name
        : description.kind === 'payment'
          ? description.payment.customerName
          : 'Customer';
    const targetData = target.exists() ? target.data() : null;
    const sale =
      description.kind === 'void' ? (targetData as (Sale & { isDeleted?: boolean }) | null) : null;
    const alreadyProcessed = marker.exists() || Boolean(sale?.isDeleted);
    if (!alreadyProcessed) {
      if (!customerData)
        throw new Error('The customer no longer exists on the server. Keep this browser’s data.');
      if (description.kind === 'payment' && targetData)
        throw new Error(
          'A payment with this ID already exists without a sync marker. Keep this browser’s data.'
        );
      if (
        description.kind === 'void' &&
        (!sale ||
          sale.paymentType !== 'credit' ||
          `shops/${activeShop.id}/customers/${sale.customerId}` !== description.customerPath ||
          toNgwee(sale.totalAmount) !== description.amountNgwee)
      )
        throw new Error(
          'The sale or its customer changed on the server. Keep this browser’s data.'
        );
    }
    return {
      actionId,
      kind: description.kind,
      customerName,
      originalAmount: description.amountNgwee / 100,
      serverBalance,
      queuedAt: new Date(description.action.timestamp).toISOString(),
      ...(sale ? { receipt: sale.receiptNumber || sale.id } : {}),
      alreadyProcessed,
      canRetry: !alreadyProcessed && toNgwee(serverBalance) >= description.amountNgwee,
    };
  };

  const resolveSyncReview = async (
    review: SyncConflictReview,
    decision: SyncReviewDecision
  ): Promise<'resolved' | 'already-processed'> => {
    if (syncingRef.current) throw new Error('Sync is already running. Please try again.');
    const { activeShop, currentUser, description } = getReviewableHead(review.actionId);
    if (review.kind !== description.kind || review.alreadyProcessed || review.canRetry)
      throw new Error('This review is out of date. Close it and check sync again.');
    if (
      (description.kind === 'payment' && decision.kind === 'keep-sale') ||
      (description.kind === 'void' && decision.kind !== 'keep-sale')
    )
      throw new Error('That choice does not apply to this entry.');
    const expectedBalance = toNgwee(review.serverBalance);
    let correctedNgwee = 0;
    if (decision.kind === 'correct-payment') {
      correctedNgwee = toNgwee(decision.amount);
      if (
        correctedNgwee <= 0 ||
        correctedNgwee > expectedBalance ||
        correctedNgwee >= description.amountNgwee
      )
        throw new Error(
          'Enter the correct payment, greater than zero and no more than the current balance.'
        );
    }
    const root = `shops/${activeShop.id}`;
    const markerPath = `${root}/sync_operations/${review.actionId}`;
    let committed = false;
    let outcome: 'resolved' | 'already-processed' = 'resolved';
    syncingRef.current = true;
    setIsSyncing(true);
    try {
      outcome = await runTransaction(db, async (transaction) => {
        const markerRef = doc(db, markerPath);
        const marker = await transaction.get(markerRef);
        if (marker.exists()) return 'already-processed' as const;
        const targetPath =
          description.kind === 'payment' ? description.paymentPath : description.salePath;
        const [customerSnapshot, targetSnapshot] = await Promise.all([
          transaction.get(doc(db, description.customerPath)),
          transaction.get(doc(db, targetPath)),
        ]);
        if (!customerSnapshot.exists())
          throw new Error('The customer no longer exists on the server.');
        const customer = customerSnapshot.data();
        const currentBalance = toNgwee(Number(customer.totalOwed));
        if (currentBalance < 0) throw new Error('The server has an invalid customer balance.');
        const target = targetSnapshot.exists() ? targetSnapshot.data() : null;
        if (description.kind === 'void' && target?.isDeleted) {
          transaction.set(markerRef, {
            appliedAt: new Date().toISOString(),
            outcome: 'already-voided',
            saleId: description.saleId,
          });
          return 'already-processed' as const;
        }
        if (currentBalance !== expectedBalance || currentBalance >= description.amountNgwee)
          throw new Error('The server balance changed. Close this review and check it again.');
        if (description.kind === 'payment' && target)
          throw new Error('A payment with this ID already exists. Keep this browser’s data.');
        if (
          description.kind === 'void' &&
          (!target ||
            target.paymentType !== 'credit' ||
            `${root}/customers/${target.customerId}` !== description.customerPath ||
            toNgwee(Number(target.totalAmount)) !== description.amountNgwee)
        )
          throw new Error(
            'The sale or its customer changed. Close this review and check it again.'
          );
        const resolvedAt = new Date().toISOString();
        const audit: SyncResolutionAudit = {
          kind: decision.kind,
          actionId: review.actionId,
          resolvedAt,
          resolvedBy: currentUser.uid,
          customerName: typeof customer.name === 'string' ? customer.name : review.customerName,
          customerId: description.customerPath.split('/').at(-1)!,
          originalAmount: description.amountNgwee / 100,
          serverBalanceBefore: currentBalance / 100,
          queuedAt: new Date(description.action.timestamp).toISOString(),
          ...(description.kind === 'payment'
            ? { originalPayment: description.payment }
            : {
                saleId: description.saleId,
                receipt:
                  typeof target?.receiptNumber === 'string'
                    ? target.receiptNumber
                    : description.saleId,
                stockRestorations: description.stockAdjustments.map((entry) => ({
                  itemId: entry.movement.data.itemId,
                  itemName: entry.movement.data.itemName,
                  quantity: entry.delta,
                })),
              }),
          ...(decision.kind === 'correct-payment' ? { correctedAmount: correctedNgwee / 100 } : {}),
        };
        if (description.kind === 'payment' && decision.kind === 'correct-payment') {
          transaction.set(doc(db, description.paymentPath), {
            ...cleanForFirestore(description.payment),
            amount: correctedNgwee / 100,
            syncCorrection: {
              actionId: review.actionId,
              originalAmount: description.payment.amount,
              resolvedAt,
            },
          });
          transaction.set(
            doc(db, description.customerPath),
            { totalOwed: (currentBalance - correctedNgwee) / 100, updatedAt: resolvedAt },
            { merge: true }
          );
        }
        // A cancelled payment or undo changes no financial record. The marker
        // preserves the original entry and confirmation for the shop owner.
        transaction.set(markerRef, {
          appliedAt: resolvedAt,
          hasResolution: true,
          resolution: audit,
        });
        return 'resolved' as const;
      });
      committed = true;
      if (auth.currentUser?.uid !== currentUser.uid)
        throw new Error('The account changed after the review was saved.');
      // Fetch fresh authoritative data before rebasing later optimistic entries.
      // If this read or local persistence fails, the marker makes retry safe.
      const base = await runTransaction(db, async (transaction) => {
        const marker = await transaction.get(doc(db, markerPath));
        if (!marker.exists()) throw new Error('The saved review could not be verified.');
        return readResolutionBase(transaction, description.action);
      });
      acknowledgeAction(description.action, base);
      setBlockedSync(null);
      setLastOfflineNotice(null);
    } catch (error) {
      if (committed) {
        const message =
          outcome === 'already-processed'
            ? 'This entry was already processed, but this device could not finish updating. Tap Sync Now; no new review decision was applied.'
            : 'The review was saved in the cloud, but this device could not finish updating. Tap Sync Now; do not repeat the decision.';
        setLastOfflineNotice(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
    // Entries added while reviewing remain in FIFO order and are never discarded.
    setTimeout(() => void syncNow(), 0);
    return outcome;
  };

  const loadSyncResolutionHistory = async (): Promise<SyncResolutionAudit[]> => {
    const activeShop = shopRef.current;
    const currentUser = auth.currentUser;
    if (!navigator.onLine || !activeShop || !currentUser)
      throw new Error('Connect and sign in to the original shop account to view sync history.');
    if (currentUser.uid !== activeShop.ownerUid && currentUser.uid !== activeShop.id)
      throw new Error('Only the original shop account can view sync history.');
    const snapshot = await getDocsFromServer(
      query(
        collection(db, 'shops', activeShop.id, 'sync_operations'),
        where('hasResolution', '==', true)
      )
    );
    if (auth.currentUser?.uid !== currentUser.uid || shopRef.current?.id !== activeShop.id)
      throw new Error('The account changed while loading sync history.');
    return snapshot.docs
      .map((entry) => entry.data())
      .filter((entry) => entry.hasResolution === true && entry.resolution)
      .map((entry) => entry.resolution as SyncResolutionAudit)
      .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
  };

  const queueWrites = useCallback(
    (
      type: PendingSyncAction['type'],
      writes: { path: string; data: QueuePayload }[],
      adjustments?: SyncAdjustment[]
    ) => {
      if (!writes.length) return;
      const action: PendingSyncAction = {
        id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        type,
        path: writes[0].path,
        data: cleanForFirestore(writes[0].data),
        writes: writes.map((write) => ({ ...write, data: cleanForFirestore(write.data) })),
        ...(adjustments?.length ? { adjustments: cleanForFirestore(adjustments) } : {}),
        timestamp: Date.now(),
      };
      const next = [...queueRef.current, action];
      // Persist before reporting success. A full/disabled localStorage must not
      // silently discard a sale or its associated writes.
      localStorage.setItem('countup_pending_queue', JSON.stringify(next));
      queueRef.current = next;
      setPendingQueue(next);
      if (!navigator.onLine)
        setLastOfflineNotice('Saved on this phone. Will sync when internet returns.');
      else setTimeout(() => void syncNow(), 50);
    },
    [syncNow]
  );

  const queueAction = useCallback(
    (type: PendingSyncAction['type'], path: string, data: QueuePayload) =>
      queueWrites(type, [{ path, data }]),
    [queueWrites]
  );

  const persistOperation = async (
    type: PendingSyncAction['type'],
    writes: { path: string; data: QueuePayload }[],
    adjustments?: SyncAdjustment[]
  ) => {
    queueWrites(type, writes, adjustments);
    if (navigator.onLine && auth.currentUser) void syncNow();
  };

  // Safe helper to obtain a Firebase auth user if Anonymous is enabled or user logged in
  const ensureFirebaseAuth = async (retryTransient = false): Promise<User | null> => {
    if (auth.currentUser) return auth.currentUser;
    // Do not wait for a network-dependent auth request when creating a shop offline.
    if (!navigator.onLine) return null;
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (err) {
      if (retryTransient && isTransientSyncError(err)) throw err;
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
      const cleanPhone = normalizeZambianPhone(phone);

      // Ensure an authenticated Firebase session exists if enabled
      const currentUser = await ensureFirebaseAuth();

      // Check both the canonical ID and IDs created by older international-format registrations.
      if (navigator.onLine && currentUser) {
        for (const shopId of shopIdsForPhone(cleanPhone)) {
          try {
            const shopSnap = await getDoc(doc(db, 'shops', shopId));
            if (shopSnap.exists()) {
              const shopData = shopSnap.data() as Shop;
              if (shopData.pin === pin) {
                setShop(shopData);
                setIsLoading(false);
                return true;
              }
            }
          } catch (e) {
            console.warn('Remote check note:', e);
          }
        }
      }

      // Check local cache if offline or first time
      const cached = localStorage.getItem('countup_active_shop');
      if (cached) {
        const localShop = JSON.parse(cached) as Shop;
        if (normalizeZambianPhone(localShop.ownerPhone) === cleanPhone && localShop.pin === pin) {
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
    if (queueRef.current.length || syncingRef.current) {
      notify('Sync pending entries before creating another shop', { kind: 'error' });
      return false;
    }
    setIsLoading(true);
    try {
      const cleanPhone = normalizeZambianPhone(phone);
      const shopId = `shop_${cleanPhone}`;

      const currentUser = await ensureFirebaseAuth();

      // Check both current and legacy ID formats without changing existing shops.
      if (navigator.onLine && currentUser) {
        for (const candidateId of shopIdsForPhone(cleanPhone)) {
          try {
            const existing = await getDoc(doc(db, 'shops', candidateId));
            if (existing.exists()) {
              setIsLoading(false);
              return false;
            }
          } catch (e) {
            console.warn('Shop availability check note:', e);
          }
        }
      }

      const now = new Date();
      const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const newShop: Shop = {
        id: shopId,
        name: name.trim(),
        ownerPhone: cleanPhone,
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

      // Persist to Firestore or queue for the next connection before entering the shop.
      // If localStorage is full, the UI must not claim that an offline shop was saved.
      if (navigator.onLine && currentUser) {
        try {
          await setDoc(doc(db, 'shops', shopId), newShop);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code === 'permission-denied') {
            // The number is already registered to another account. Do not enter
            // a shop that cannot be saved to the cloud.
            setIsLoading(false);
            return false;
          }
          console.warn('Shop creation sync note, queued for retry:', e);
          queueAction('item', `shops/${shopId}`, newShop);
        }
      } else {
        queueAction('item', `shops/${shopId}`, newShop);
      }

      // A new shop starts with an empty stock book — the owner enters their own items.
      setShop(newShop);
      setItems([]);
      setArchivedItems([]);
      setStockMovements([]);
      setStockConflicts([]);
      setSales([]);
      setCustomers([]);
      setCreditPayments([]);
      setExpenses([]);
      setIsLoading(false);
      return true;
    } catch (error) {
      console.error('Registration error:', error);
      setIsLoading(false);
      return false;
    }
  };

  const linkEmailAccount = async (email: string, password: string) => {
    const current = auth.currentUser;
    if (!navigator.onLine || !current || !shop)
      throw new Error('Connect to the internet and sign in to your shop first.');
    if (queueRef.current.length || syncingRef.current)
      throw new Error('Sync all pending entries before enabling account access.');
    if (current.uid !== shop.ownerUid && current.uid !== shop.id)
      throw new Error('Only the shop owner can enable account access.');
    if (!current.isAnonymous) throw new Error('This Firebase account is already linked.');
    if (!email.trim() || password.length < 8)
      throw new Error('Enter an email and a password of at least 8 characters.');
    // Linking preserves the Firebase UID: existing Firestore ownership and admin
    // grants do not change, and no PIN or password is copied into the database.
    const result = await linkWithCredential(
      current,
      EmailAuthProvider.credential(email.trim(), password)
    );
    setUser(result.user);
    localStorage.removeItem('countup_legacy_uid');
  };

  // Reauthenticate an already-open shop without dropping its pending queue.
  // Only its original UID may resume sync; a different account is signed back out.
  const restoreShopAccount = async (email: string, password: string) => {
    if (!navigator.onLine || !shop)
      throw new Error('Connect to the internet and open the original shop first.');
    if (!email.trim() || !password) throw new Error('Enter your linked email and password.');
    const reservedUid = hasQueuedOfflineShopCreate(shop, queueRef.current)
      ? queueRef.current[0].reservedOwnerUid
      : undefined;
    const isOriginalOwner = (uid: string) =>
      reservedUid ? uid === reservedUid : uid === shop.ownerUid || uid === shop.id;
    const current = auth.currentUser;
    if (current) {
      if (isOriginalOwner(current.uid)) return;
      throw new Error(
        'Another account is active on this device. Keep this browser’s data and contact support before changing accounts.'
      );
    }
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    if (!isOriginalOwner(result.user.uid)) {
      if (auth.currentUser?.uid === result.user.uid) await signOut(auth);
      throw new Error(
        'This email is not linked to the original shop. Your pending entries remain on this device.'
      );
    }
    if (auth.currentUser?.uid !== result.user.uid)
      throw new Error('The account changed during sign-in. Please try again.');
    setUser(result.user);
    localStorage.removeItem('countup_legacy_uid');
  };

  const checkAccountSwitch = () => {
    if (!navigator.onLine) throw new Error('Email sign-in needs an internet connection.');
    if (shop) throw new Error('Sign out of your shop before switching accounts.');
    if (queueRef.current.length || syncingRef.current)
      throw new Error('Sync pending entries before switching accounts.');
    if (
      auth.currentUser?.isAnonymous &&
      localStorage.getItem('countup_legacy_uid') === auth.currentUser.uid
    ) {
      throw new Error(
        'This device owns a phone-and-PIN shop. Log in to that shop and enable email access before switching accounts, so its anonymous identity is not lost.'
      );
    }
  };

  const loginWithEmail = async (email: string, password: string): Promise<Shop[]> => {
    checkAccountSwitch();
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    try {
      const snapshot = await getDocs(
        query(collection(db, 'shops'), where('ownerUid', '==', result.user.uid))
      );
      const owned = snapshot.docs.map((entry) => entry.data() as Shop);
      if (!owned.length)
        throw new Error(
          'This account does not own a CountUp shop. Enable email access in your shop on its original device before signing in here.'
        );
      return owned;
    } catch (error) {
      await signOut(auth);
      throw error;
    }
  };
  const loginAsAdmin = async (email: string, password: string): Promise<void> => {
    checkAccountSwitch();
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    try {
      // An admin need not own a shop, but must have a current server-side grant.
      const grant = await getDocFromServer(doc(db, 'admins', result.user.uid));
      if (!grant.exists()) throw new Error('This account does not have admin access.');
      if (auth.currentUser?.uid !== result.user.uid)
        throw new Error('The account changed during sign-in. Please try again.');
      setUser(result.user);
      setAdminUid(result.user.uid);
    } catch (error) {
      // Do not leave a failed or unverifiable admin account signed in. Avoid
      // signing out a different user if the account changed during the lookup.
      if (auth.currentUser?.uid === result.user.uid) await signOut(auth);
      throw error;
    }
  };
  const cancelEmailLogin = async () => {
    // Signing in may return several shops. If the user backs out before
    // selecting one, do not leave that account silently active on this device.
    if (!shop && auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
  };
  const selectEmailShop = (selected: Shop) => {
    if (!auth.currentUser || selected.ownerUid !== auth.currentUser.uid)
      throw new Error('This account cannot open that shop.');
    itemsRef.current = [];
    setItems([]);
    archivedItemsRef.current = [];
    setArchivedItems([]);
    movementsRef.current = [];
    setStockMovements([]);
    conflictsRef.current = [];
    setStockConflicts([]);
    salesRef.current = [];
    setSales([]);
    customersRef.current = [];
    setCustomers([]);
    paymentsRef.current = [];
    setCreditPayments([]);
    expensesRef.current = [];
    setExpenses([]);
    setActiveTab('home');
    setShop(selected);
  };
  const resetEmailPassword = async (email: string) => {
    if (!navigator.onLine) throw new Error('Password recovery needs an internet connection.');
    if (!email.trim()) throw new Error('Enter your email address first.');
    await sendPasswordResetEmail(auth, email.trim());
  };

  const logout = async () => {
    if (queueRef.current.length || syncingRef.current) {
      notify('Sync your pending entries before logging out', {
        kind: 'error',
        detail: 'This protects unsynced records on this phone.',
      });
      return;
    }
    if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
    localStorage.removeItem('countup_active_shop');
    setShop(null);
    setItems([]);
    setArchivedItems([]);
    setStockMovements([]);
    setStockConflicts([]);
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

    // Keep PIN changes in FIFO order with earlier offline changes, and persist
    // the queue before reporting success or updating the local shop.
    await persistOperation('item', [{ path: `shops/${shop.id}`, data: { pin: newPin } }]);
    setShop({ ...shop, pin: newPin });
    return true;
  };

  // Permanently delete the shop document and all of its records.
  // Backs the deletion right promised in the Privacy Policy.
  const deleteShopAccount = async (): Promise<boolean> => {
    if (
      !shop ||
      !navigator.onLine ||
      !auth.currentUser ||
      queueRef.current.length ||
      syncingRef.current
    )
      return false;
    const activeShop = shop;
    setIsLoading(true);

    try {
      const subcollections = [
        'items',
        'sales',
        'customers',
        'credit_payments',
        'expenses',
        'stock_movements',
        'stock_conflicts',
        'sync_operations',
      ];
      for (const name of subcollections) {
        const snap = await getDocs(collection(db, 'shops', activeShop.id, name));
        // Wait for every request in this group, even if one fails. Otherwise
        // a rejected Promise.all can leave other deletions running while the
        // user is told they may retry or continue working.
        const results = await Promise.allSettled(snap.docs.map((d) => deleteDoc(d.ref)));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
      await deleteDoc(doc(db, 'shops', activeShop.id));

      // Clear local records only after the remote deletion completes.
      for (const key of [
        'countup_active_shop',
        'countup_items',
        'countup_archived_items',
        'countup_stock_movements',
        'countup_stock_conflicts',
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
      setArchivedItems([]);
      setStockMovements([]);
      setStockConflicts([]);
      setSales([]);
      setCustomers([]);
      setCreditPayments([]);
      setExpenses([]);
      queueRef.current = [];
      setPendingQueue([]);
      return true;
    } catch (e) {
      // Earlier deletions cannot be rolled back, so never claim nothing changed.
      console.error('Shop deletion failed:', e);
      notify('Shop deletion did not finish', {
        kind: 'error',
        detail: 'Some records may already have been removed. Reconnect and try again.',
      });
      return false;
    } finally {
      setIsLoading(false);
    }
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

  // New records have stable IDs across retries and devices.
  const createRecordId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
  const makeMovement = (
    item: Item,
    type: StockMovement['type'],
    next: number,
    reason: string,
    now: string,
    relatedSaleId?: string
  ): StockMovement => ({
    id: createRecordId('movement'),
    shopId: item.shopId,
    itemId: item.id,
    itemName: item.name,
    type,
    delta: next - item.quantity,
    previousQuantity: item.quantity,
    newQuantity: next,
    reason,
    ...(relatedSaleId ? { relatedSaleId } : {}),
    createdAt: now,
  });

  const recordSale = async (saleData: Omit<Sale, 'id' | 'shopId' | 'createdAt'>): Promise<Sale> => {
    if (!shop) throw new Error('No active shop');
    if (!subscription.canRecordSales) throw new Error('New sales are locked for this shop.');
    // A conflicting stock line can write the item, movement and a conflict record.
    // Reserve room for the sale, customer and idempotency marker under Firestore's
    // 500-write transaction limit even if every line needs a recount.
    if (!saleData.items.length || saleData.items.length > 160)
      throw new Error('A sale must contain between 1 and 160 products.');
    if (new Set(saleData.items.map((line) => line.itemId)).size !== saleData.items.length)
      throw new Error('A product appears more than once in the cart.');
    const liveItems = itemsRef.current;
    const lines = saleData.items.map((line) => {
      const item = liveItems.find((candidate) => candidate.id === line.itemId);
      if (!item) throw new Error(`"${line.name}" is no longer in your stock book.`);
      if (
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        line.quantity > item.quantity
      )
        throw new Error(
          `Only ${item.quantity} of "${item.name}" left in stock — reduce the quantity to continue.`
        );
      if (toNgwee(item.sellingPrice) <= 0)
        throw new Error(`Enter a valid selling price for ${item.name}.`);
      return {
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        buyingPrice: item.buyingPrice,
        buyingPriceKnown: item.buyingPriceKnown !== false,
        sellingPrice: item.sellingPrice,
        unitLabel: item.unitLabel || '',
      };
    });
    const creditCustomer =
      saleData.paymentType === 'credit'
        ? customersRef.current.find((customer) => customer.id === saleData.customerId)
        : undefined;
    if (saleData.paymentType === 'credit' && !creditCustomer)
      throw new Error('Choose a customer before saving a credit sale.');
    const now = new Date();
    const nowIso = now.toISOString();
    const saleId = createRecordId('sale');
    const totalAmount = addKwacha(
      ...lines.map((line) => multiplyKwacha(line.sellingPrice, line.quantity))
    );
    const totalCost = addKwacha(
      ...lines.map((line) =>
        line.buyingPriceKnown ? multiplyKwacha(line.buyingPrice, line.quantity) : 0
      )
    );
    const missingCostRevenue = addKwacha(
      ...lines.map((line) =>
        line.buyingPriceKnown ? 0 : multiplyKwacha(line.sellingPrice, line.quantity)
      )
    );
    const newSale: Sale = cleanForFirestore({
      ...saleData,
      id: saleId,
      shopId: shop.id,
      items: lines,
      itemsCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      totalAmount,
      totalCost,
      profit: addKwacha(totalAmount, -totalCost, -missingCostRevenue),
      missingCostRevenue,
      ...(creditCustomer
        ? {
            customerId: creditCustomer.id,
            customerName: creditCustomer.name,
            customerPhone: creditCustomer.phone || '',
          }
        : {}),
      receiptNumber: `CU-${localDateKey(now).replace(/-/g, '')}-${saleId.slice(5)}`,
      localDate: localDateKey(now),
      createdAt: nowIso,
    });
    const updatedItems = liveItems.map((item) => {
      const line = lines.find((candidate) => candidate.itemId === item.id);
      return line
        ? {
            ...item,
            quantity: item.quantity - line.quantity,
            lastSoldAt: nowIso,
            updatedAt: nowIso,
          }
        : item;
    });
    const writes: { path: string; data: object }[] = [
      { path: `shops/${shop.id}/sales/${saleId}`, data: newSale },
    ];
    const adjustments: SyncAdjustment[] = [];
    const movements: StockMovement[] = [];
    for (const line of lines) {
      const item = liveItems.find((candidate) => candidate.id === line.itemId)!;
      const movement = makeMovement(
        item,
        'sale',
        item.quantity - line.quantity,
        `Sale ${newSale.receiptNumber}`,
        nowIso,
        saleId
      );
      const itemPath = `shops/${shop.id}/items/${item.id}`;
      const movementPath = `shops/${shop.id}/stock_movements/${movement.id}`;
      movements.push(movement);
      writes.push(
        { path: itemPath, data: updatedItems.find((candidate) => candidate.id === item.id)! },
        { path: movementPath, data: movement }
      );
      adjustments.push({
        kind: 'stock',
        path: itemPath,
        delta: -line.quantity,
        updatedAt: nowIso,
        lastSoldAt: nowIso,
        movement: { path: movementPath, data: movement },
      });
    }
    if (creditCustomer) {
      const next = addKwacha(creditCustomer.totalOwed, totalAmount);
      const customerPath = `shops/${shop.id}/customers/${creditCustomer.id}`;
      writes.push({
        path: customerPath,
        data: { ...creditCustomer, totalOwed: next, updatedAt: nowIso },
      });
      adjustments.push({
        kind: 'credit',
        path: customerPath,
        deltaNgwee: toNgwee(totalAmount),
        updatedAt: nowIso,
      });
    }
    await persistOperation('sale', writes, adjustments);
    itemsRef.current = updatedItems;
    setItems(updatedItems);
    salesRef.current = [newSale, ...salesRef.current];
    setSales(salesRef.current);
    movementsRef.current = [...movements, ...movementsRef.current];
    setStockMovements(movementsRef.current);
    if (creditCustomer) {
      customersRef.current = customersRef.current.map((customer) =>
        customer.id === creditCustomer.id
          ? {
              ...customer,
              totalOwed: addKwacha(customer.totalOwed, totalAmount),
              updatedAt: nowIso,
            }
          : customer
      );
      setCustomers(customersRef.current);
    }
    return newSale;
  };

  const voidSale = async (saleId: string): Promise<Sale> => {
    if (!shop) throw new Error('No active shop');
    const sale = salesRef.current.find((entry) => entry.id === saleId);
    if (!sale) throw new Error('That sale is no longer in your records.');
    if (!isTodayIso(sale.createdAt))
      throw new Error('Only sales recorded today can be undone. Older sales stay in your reports.');
    const creditCustomer =
      sale.paymentType === 'credit' && sale.customerId
        ? customersRef.current.find((c) => c.id === sale.customerId)
        : undefined;
    if (sale.paymentType === 'credit' && !creditCustomer)
      throw new Error('The customer for this credit sale is missing; the sale cannot be undone.');
    if (creditCustomer && toNgwee(creditCustomer.totalOwed) < toNgwee(sale.totalAmount)) {
      throw new Error(
        'This credit sale has already been partly repaid. Reconcile the repayment before undoing it.'
      );
    }
    const nowIso = new Date().toISOString();
    const allItems = [...itemsRef.current, ...archivedItemsRef.current];
    const writes: { path: string; data: object }[] = [
      { path: `shops/${shop.id}/sales/${saleId}`, data: { isDeleted: true } },
    ];
    const adjustments: SyncAdjustment[] = [];
    const restored = new Map<string, Item>();
    const movements: StockMovement[] = [];
    for (const line of sale.items) {
      const item = allItems.find((candidate) => candidate.id === line.itemId);
      if (!item) continue; // Historical records remain even if old stock was permanently removed.
      const updated = { ...item, quantity: item.quantity + line.quantity, updatedAt: nowIso };
      const movement = makeMovement(
        item,
        'void',
        updated.quantity,
        `Undo sale ${sale.receiptNumber || sale.id}`,
        nowIso,
        saleId
      );
      const path = `shops/${shop.id}/items/${item.id}`;
      const movementPath = `shops/${shop.id}/stock_movements/${movement.id}`;
      restored.set(item.id, updated);
      movements.push(movement);
      writes.push({ path, data: updated }, { path: movementPath, data: movement });
      adjustments.push({
        kind: 'stock',
        path,
        delta: line.quantity,
        updatedAt: nowIso,
        movement: { path: movementPath, data: movement },
      });
    }
    if (creditCustomer) {
      const path = `shops/${shop.id}/customers/${creditCustomer.id}`;
      writes.push({
        path,
        data: {
          ...creditCustomer,
          totalOwed: addKwacha(creditCustomer.totalOwed, -sale.totalAmount),
          updatedAt: nowIso,
        },
      });
      adjustments.push({
        kind: 'credit',
        path,
        deltaNgwee: -toNgwee(sale.totalAmount),
        updatedAt: nowIso,
      });
    }
    await persistOperation('sale', writes, adjustments);
    salesRef.current = salesRef.current.filter((entry) => entry.id !== saleId);
    setSales(salesRef.current);
    itemsRef.current = itemsRef.current.map((item) => restored.get(item.id) ?? item);
    setItems(itemsRef.current);
    archivedItemsRef.current = archivedItemsRef.current.map(
      (item) => restored.get(item.id) ?? item
    );
    setArchivedItems(archivedItemsRef.current);
    movementsRef.current = [...movements, ...movementsRef.current];
    setStockMovements(movementsRef.current);
    if (creditCustomer) {
      customersRef.current = customersRef.current.map((c) =>
        c.id === creditCustomer.id
          ? { ...c, totalOwed: addKwacha(c.totalOwed, -sale.totalAmount), updatedAt: nowIso }
          : c
      );
      setCustomers(customersRef.current);
    }
    return sale;
  };

  const addItem = async (
    itemData: Omit<Item, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!shop) throw new Error('No active shop');
    if (
      !itemData.name.trim() ||
      !Number.isSafeInteger(itemData.quantity) ||
      itemData.quantity < 0 ||
      !Number.isSafeInteger(itemData.lowStockThreshold) ||
      itemData.lowStockThreshold < 0 ||
      toNgwee(itemData.sellingPrice) <= 0 ||
      toNgwee(itemData.buyingPrice) < 0
    )
      throw new Error('Enter a valid name, prices and whole stock quantities.');
    const nowIso = new Date().toISOString();
    const item: Item = {
      ...itemData,
      id: createRecordId('item'),
      shopId: shop.id,
      name: itemData.name.trim(),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const movement = makeMovement(
      { ...item, quantity: 0 },
      'initial',
      item.quantity,
      'Initial stock',
      nowIso
    );
    await persistOperation('item', [
      { path: `shops/${shop.id}/items/${item.id}`, data: item },
      { path: `shops/${shop.id}/stock_movements/${movement.id}`, data: movement },
    ]);
    itemsRef.current = [item, ...itemsRef.current];
    setItems(itemsRef.current);
    movementsRef.current = [movement, ...movementsRef.current];
    setStockMovements(movementsRef.current);
    return item.id;
  };

  const saveItemChange = async (
    itemId: string,
    patch: Partial<Item>,
    movementType: StockMovement['type'] = 'adjustment',
    reason = 'Stock level edited',
    setQuantity = false
  ) => {
    if (!shop) throw new Error('No active shop');
    const item = itemsRef.current.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('That product is no longer in your stock book.');
    // Only editable business fields are accepted; IDs and ownership never change.
    const {
      name,
      unitLabel,
      buyingPrice,
      buyingPriceKnown,
      sellingPrice,
      quantity,
      lowStockThreshold,
    } = patch;
    const editable = cleanForFirestore({
      name,
      unitLabel,
      buyingPrice,
      buyingPriceKnown,
      sellingPrice,
      quantity,
      lowStockThreshold,
    });
    const nowIso = new Date().toISOString();
    const updated: Item = { ...item, ...editable, updatedAt: nowIso };
    if (
      !updated.name.trim() ||
      !Number.isSafeInteger(updated.quantity) ||
      updated.quantity < 0 ||
      !Number.isSafeInteger(updated.lowStockThreshold) ||
      updated.lowStockThreshold < 0 ||
      toNgwee(updated.sellingPrice) <= 0 ||
      toNgwee(updated.buyingPrice) < 0
    )
      throw new Error('Enter a valid name, prices and whole stock quantities.');
    const path = `shops/${shop.id}/items/${itemId}`;
    if (updated.quantity !== item.quantity || setQuantity) {
      const movement = makeMovement(
        item,
        movementType,
        updated.quantity,
        reason.trim() || 'Stock adjustment',
        nowIso
      );
      const movementPath = `shops/${shop.id}/stock_movements/${movement.id}`;
      const metadata = { ...editable };
      delete metadata.quantity;
      await persistOperation(
        'stock_update',
        [
          { path, data: updated },
          { path: movementPath, data: movement },
        ],
        [
          {
            kind: 'stock',
            path,
            delta: updated.quantity - item.quantity,
            ...(setQuantity ? { setTo: updated.quantity } : {}),
            updatedAt: nowIso,
            metadata,
            movement: { path: movementPath, data: movement },
          },
        ]
      );
      movementsRef.current = [movement, ...movementsRef.current];
      setStockMovements(movementsRef.current);
    } else {
      const metadata = { ...editable };
      delete metadata.quantity;
      await persistOperation('item', [{ path, data: { ...metadata, updatedAt: nowIso } }]);
    }
    itemsRef.current = itemsRef.current.map((candidate) =>
      candidate.id === itemId ? updated : candidate
    );
    setItems(itemsRef.current);
  };

  const updateItem = async (itemId: string, patch: Partial<Item>) =>
    saveItemChange(
      itemId,
      patch,
      'adjustment',
      'Stock level edited',
      patch.quantity !== undefined &&
        patch.quantity !== itemsRef.current.find((item) => item.id === itemId)?.quantity
    );
  const adjustStock = async (
    itemId: string,
    mode: 'add' | 'subtract' | 'set',
    quantity: number,
    reason: string
  ) => {
    const item = itemsRef.current.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('That product is no longer in your stock book.');
    if (!Number.isSafeInteger(quantity) || quantity < 0 || (mode !== 'set' && quantity === 0))
      throw new Error('Enter a valid whole stock quantity.');
    const next =
      mode === 'set'
        ? quantity
        : mode === 'add'
          ? item.quantity + quantity
          : item.quantity - quantity;
    if (next < 0) throw new Error('You cannot remove more stock than is on hand.');
    await saveItemChange(
      itemId,
      { quantity: next },
      mode === 'add' ? 'restock' : 'adjustment',
      reason,
      mode === 'set'
    );
  };
  const quickRestock = async (itemId: string, quantityToAdd: number) =>
    adjustStock(itemId, 'add', quantityToAdd, 'Quick restock');

  const deleteItem = async (itemId: string) => {
    if (!shop) return;
    const item = itemsRef.current.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const archived = { ...item, isDeleted: true };
    await persistOperation('item', [
      { path: `shops/${shop.id}/items/${itemId}`, data: { isDeleted: true } },
    ]);
    itemsRef.current = itemsRef.current.filter((candidate) => candidate.id !== itemId);
    setItems(itemsRef.current);
    archivedItemsRef.current = [
      archived,
      ...archivedItemsRef.current.filter((candidate) => candidate.id !== itemId),
    ];
    setArchivedItems(archivedItemsRef.current);
  };
  const restoreItem = async (item: Item) => {
    if (!shop) return;
    const restored: Item = { ...item, isDeleted: false, updatedAt: new Date().toISOString() };
    await persistOperation('item', [
      {
        path: `shops/${shop.id}/items/${item.id}`,
        data: { isDeleted: false, updatedAt: restored.updatedAt },
      },
    ]);
    archivedItemsRef.current = archivedItemsRef.current.filter(
      (candidate) => candidate.id !== item.id
    );
    setArchivedItems(archivedItemsRef.current);
    itemsRef.current = [
      restored,
      ...itemsRef.current.filter((candidate) => candidate.id !== item.id),
    ];
    setItems(itemsRef.current);
  };
  const resolveStockConflict = async (conflictId: string) => {
    if (!shop) return;
    await persistOperation('stock_update', [
      { path: `shops/${shop.id}/stock_conflicts/${conflictId}`, data: { resolved: true } },
    ]);
    conflictsRef.current = conflictsRef.current.map((conflict) =>
      conflict.id === conflictId ? { ...conflict, resolved: true } : conflict
    );
    setStockConflicts(conflictsRef.current);
  };

  const addCustomer = async (name: string, phone?: string): Promise<Customer> => {
    if (!shop) throw new Error('No active shop');
    if (!name.trim()) throw new Error('Enter a customer name.');
    const nowIso = new Date().toISOString();
    const customer: Customer = {
      id: createRecordId('cust'),
      shopId: shop.id,
      name: name.trim(),
      phone: phone?.trim() || '',
      notes: '',
      totalOwed: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await persistOperation('customer', [
      { path: `shops/${shop.id}/customers/${customer.id}`, data: customer },
    ]);
    customersRef.current = [customer, ...customersRef.current];
    setCustomers(customersRef.current);
    return customer;
  };
  const updateCustomer = async (
    customerId: string,
    patch: Pick<Customer, 'name' | 'phone' | 'notes'>
  ) => {
    if (!shop) throw new Error('No active shop');
    const customer = customersRef.current.find((candidate) => candidate.id === customerId);
    if (!customer || !patch.name.trim()) throw new Error('Enter a customer name.');
    const updated = {
      ...customer,
      name: patch.name.trim(),
      phone: patch.phone?.trim() || '',
      notes: patch.notes?.trim() || '',
      updatedAt: new Date().toISOString(),
    };
    await persistOperation('customer', [
      {
        path: `shops/${shop.id}/customers/${customerId}`,
        data: {
          name: updated.name,
          phone: updated.phone,
          notes: updated.notes,
          updatedAt: updated.updatedAt,
        },
      },
    ]);
    customersRef.current = customersRef.current.map((candidate) =>
      candidate.id === customerId ? updated : candidate
    );
    setCustomers(customersRef.current);
  };

  const recordCreditPayment = async (
    customerId: string,
    amount: number,
    note?: string,
    paymentMethod: 'cash' | 'momo' = 'cash'
  ): Promise<{ applied: number; remaining: number }> => {
    if (!shop) throw new Error('No active shop');
    const customer = customersRef.current.find((candidate) => candidate.id === customerId);
    if (!customer) throw new Error('That customer is no longer in your credit book.');
    const cents = toNgwee(amount);
    if (cents <= 0) throw new Error('Enter an amount greater than zero.');
    if (cents > toNgwee(customer.totalOwed))
      throw new Error(
        `${customer.name} only owes K ${customer.totalOwed.toFixed(2)} — enter that amount or less.`
      );
    const now = new Date();
    const nowIso = now.toISOString();
    const payment: CreditPayment = {
      id: createRecordId('pay'),
      shopId: shop.id,
      customerId,
      customerName: customer.name,
      amount,
      paymentMethod,
      note: note?.trim() || '',
      createdAt: nowIso,
      localDate: localDateKey(now),
    };
    const remaining = addKwacha(customer.totalOwed, -amount);
    const customerPath = `shops/${shop.id}/customers/${customerId}`;
    await persistOperation(
      'payment',
      [
        { path: `shops/${shop.id}/credit_payments/${payment.id}`, data: payment },
        { path: customerPath, data: { ...customer, totalOwed: remaining, updatedAt: nowIso } },
      ],
      [{ kind: 'credit', path: customerPath, deltaNgwee: -cents, updatedAt: nowIso }]
    );
    paymentsRef.current = [payment, ...paymentsRef.current];
    setCreditPayments(paymentsRef.current);
    customersRef.current = customersRef.current.map((candidate) =>
      candidate.id === customerId
        ? { ...candidate, totalOwed: remaining, updatedAt: nowIso }
        : candidate
    );
    setCustomers(customersRef.current);
    return { applied: amount, remaining };
  };

  const addExpense = async (category: Expense['category'], amount: number, note?: string) => {
    if (!shop) throw new Error('No active shop');
    if (toNgwee(amount) <= 0) throw new Error('Enter an amount greater than zero.');
    const expense: Expense = {
      id: createRecordId('exp'),
      shopId: shop.id,
      category,
      amount,
      note: note?.trim() || '',
      createdAt: new Date().toISOString(),
    };
    await persistOperation('expense', [
      { path: `shops/${shop.id}/expenses/${expense.id}`, data: expense },
    ]);
    expensesRef.current = [expense, ...expensesRef.current];
    setExpenses(expensesRef.current);
  };
  const deleteExpense = async (expenseId: string) => {
    if (!shop) return;
    await persistOperation('expense', [
      { path: `shops/${shop.id}/expenses/${expenseId}`, data: { isDeleted: true } },
    ]);
    expensesRef.current = expensesRef.current.filter((expense) => expense.id !== expenseId);
    setExpenses(expensesRef.current);
  };
  const restoreExpense = async (expense: Expense) => {
    if (!shop) return;
    await persistOperation('expense', [
      { path: `shops/${shop.id}/expenses/${expense.id}`, data: { ...expense, isDeleted: false } },
    ]);
    expensesRef.current = [
      expense,
      ...expensesRef.current.filter((candidate) => candidate.id !== expense.id),
    ];
    setExpenses(expensesRef.current);
  };

  /** Import is an online, all-or-nothing transaction. No existing document is overwritten. */
  const importLegacyBackup = async (raw: string): Promise<LegacyBackupImport> => {
    if (!shop || !auth.currentUser || !navigator.onLine)
      throw new Error('Connect to the internet and sign in as the shop owner to import.');
    if (auth.currentUser.uid !== shop.ownerUid && auth.currentUser.uid !== shop.id)
      throw new Error('Only the shop owner can import a backup.');
    if (queueRef.current.length || syncingRef.current)
      throw new Error('Sync all pending CountUp entries before importing a backup.');
    const prepared = prepareLegacyBackupImport(raw, shop.id);
    const writes: { path: string; data: object }[] = [
      ...prepared.items.map((item) => ({ path: `shops/${shop.id}/items/${item.id}`, data: item })),
      ...prepared.customers.map((customer) => ({
        path: `shops/${shop.id}/customers/${customer.id}`,
        data: customer,
      })),
      ...prepared.sales.map((sale) => ({ path: `shops/${shop.id}/sales/${sale.id}`, data: sale })),
      ...prepared.creditPayments.map((payment) => ({
        path: `shops/${shop.id}/credit_payments/${payment.id}`,
        data: payment,
      })),
      ...prepared.stockMovements.map((movement) => ({
        path: `shops/${shop.id}/stock_movements/${movement.id}`,
        data: movement,
      })),
    ];
    if (writes.length > 400)
      throw new Error(
        'This backup contains more than 400 records. Import is limited to 400 records so it can be atomic; contact support before importing a larger backup.'
      );
    if (!writes.length) return prepared;
    await runTransaction(db, async (transaction) => {
      const refs = writes.map((write) => doc(db, write.path));
      const existing = await Promise.all(refs.map((ref) => transaction.get(ref)));
      if (existing.some((snapshot) => snapshot.exists()))
        throw new Error('Some of these records are already in this shop. Nothing was imported.');
      writes.forEach((write, index) =>
        transaction.set(refs[index], cleanForFirestore(write.data) as DocumentData)
      );
    });
    const merge = <T extends { id: string }>(old: T[], added: T[]) => [
      ...added,
      ...old.filter((entry) => !added.some((next) => next.id === entry.id)),
    ];
    itemsRef.current = merge(
      itemsRef.current,
      prepared.items.filter((item) => !item.isDeleted)
    );
    setItems(itemsRef.current);
    archivedItemsRef.current = merge(
      archivedItemsRef.current,
      prepared.items.filter((item) => item.isDeleted)
    );
    setArchivedItems(archivedItemsRef.current);
    customersRef.current = merge(customersRef.current, prepared.customers);
    setCustomers(customersRef.current);
    salesRef.current = merge(salesRef.current, prepared.sales);
    setSales(salesRef.current);
    paymentsRef.current = merge(paymentsRef.current, prepared.creditPayments);
    setCreditPayments(paymentsRef.current);
    movementsRef.current = merge(movementsRef.current, prepared.stockMovements);
    setStockMovements(movementsRef.current);
    return prepared;
  };

  // Admin changes are never queued or reported as successful offline. Firestore
  // rules independently enforce the registry grant on every write.
  const adminTarget = (shopId: string) => {
    if (!navigator.onLine) throw new Error('Connect to the internet to manage shops.');
    if (!isAdmin || !user || auth.currentUser?.uid !== user.uid)
      throw new Error('Admin access is required. Sign in again.');
    const target = allShops.find((s) => s.id === shopId) || (shop?.id === shopId ? shop : null);
    if (!target) throw new Error('Shop not found. Refresh the list and try again.');
    return target;
  };
  const applyAdminPatch = async (shopId: string, patched: Partial<Shop>) => {
    await setDoc(doc(db, 'shops', shopId), patched, { merge: true });
    if (shop?.id === shopId) setShop((prev) => (prev ? { ...prev, ...patched } : null));
    setAllShops((prev) => prev.map((s) => (s.id === shopId ? { ...s, ...patched } : s)));
  };
  const adminExtendShop = async (shopId: string, days: number) => {
    const targetShop = adminTarget(shopId);
    if (!Number.isInteger(days) || days <= 0) throw new Error('Enter a valid number of days.');
    const currentExpiry = targetShop.planExpiryDate
      ? new Date(targetShop.planExpiryDate)
      : new Date();
    const base = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    await applyAdminPatch(shopId, {
      planStatus: 'active',
      planExpiryDate: newExpiry.toISOString(),
    });
  };

  const adminToggleDeactivate = async (shopId: string) => {
    const targetShop = adminTarget(shopId);
    await applyAdminPatch(shopId, { isDeactivated: !targetShop.isDeactivated });
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
        linkEmailAccount,
        needsShopAccountRecovery,
        restoreShopAccount,
        loginWithEmail,
        loginAsAdmin,
        cancelEmailLogin,
        selectEmailShop,
        resetEmailPassword,
        logout,
        deleteShopAccount,
        changePin,
        language,
        setLanguage,
        t,
        activeTab,
        setActiveTab,
        items,
        archivedItems,
        stockMovements,
        stockConflicts,
        resolveStockConflict,
        importLegacyBackup,
        sales,
        customers,
        creditPayments,
        expenses,
        recordSale,
        voidSale,
        addItem,
        updateItem,
        quickRestock,
        adjustStock,
        deleteItem,
        restoreItem,
        addCustomer,
        updateCustomer,
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
        blockedSync,
        loadSyncReview,
        resolveSyncReview,
        loadSyncResolutionHistory,
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
