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
} from '../types';
import { translations, Translations } from '../i18n/translations';
import { getSubscriptionInfo } from '../config/plans';
import { auth, db, testConnection } from '../firebase/config';
import { signInAnonymously, onAuthStateChanged, User } from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  getDocs,
} from 'firebase/firestore';

interface PendingSyncAction {
  id: string;
  type: 'sale' | 'item' | 'customer' | 'payment' | 'expense' | 'stock_update';
  path: string;
  data: any;
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
  addItem: (itemData: Omit<Item, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateItem: (itemId: string, patch: Partial<Item>) => Promise<void>;
  quickRestock: (itemId: string, quantityToAdd: number) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  addCustomer: (name: string, phone?: string) => Promise<Customer>;
  recordCreditPayment: (customerId: string, amount: number, note?: string) => Promise<void>;
  addExpense: (category: Expense['category'], amount: number, note?: string) => Promise<void>;
  deleteExpense: (expenseId: string) => Promise<void>;

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

export const ShopProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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

  // Listen to Firestore real-time updates when shop is loaded and online
  useEffect(() => {
    if (!shop?.id || !user) return;

    const shopRef = doc(db, 'shops', shop.id);
    const unsubShop = onSnapshot(shopRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Shop;
        setShop(data);
      }
    }, (err) => {
      console.warn('Real-time shop listener error (offline or permission):', err);
    });

    const itemsCol = collection(db, 'shops', shop.id, 'items');
    const unsubItems = onSnapshot(itemsCol, (snap) => {
      const remoteItems: Item[] = [];
      snap.forEach((d) => {
        const data = d.data() as Item & { isDeleted?: boolean };
        // Skip items that were soft-deleted so they don't reappear after a sync
        if (!data.isDeleted) remoteItems.push(data);
      });
      if (remoteItems.length > 0) {
        setItems(remoteItems);
      }
    }, (err) => {
      console.warn('Real-time items listener error:', err);
    });

    const salesCol = collection(db, 'shops', shop.id, 'sales');
    const unsubSales = onSnapshot(salesCol, (snap) => {
      const remoteSales: Sale[] = [];
      snap.forEach((d) => remoteSales.push(d.data() as Sale));
      if (remoteSales.length > 0) {
        // Sort most recent sales first
        remoteSales.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setSales(remoteSales);
      }
    }, (err) => {
      console.warn('Real-time sales listener error:', err);
    });

    const customersCol = collection(db, 'shops', shop.id, 'customers');
    const unsubCustomers = onSnapshot(customersCol, (snap) => {
      const remoteCustomers: Customer[] = [];
      snap.forEach((d) => remoteCustomers.push(d.data() as Customer));
      if (remoteCustomers.length > 0) {
        setCustomers(remoteCustomers);
      }
    }, (err) => {
      console.warn('Real-time customers listener error:', err);
    });

    const paymentsCol = collection(db, 'shops', shop.id, 'credit_payments');
    const unsubPayments = onSnapshot(paymentsCol, (snap) => {
      const remotePayments: CreditPayment[] = [];
      snap.forEach((d) => remotePayments.push(d.data() as CreditPayment));
      if (remotePayments.length > 0) {
        setCreditPayments(remotePayments);
      }
    }, (err) => {
      console.warn('Real-time credit payments listener error:', err);
    });

    const expensesCol = collection(db, 'shops', shop.id, 'expenses');
    const unsubExpenses = onSnapshot(expensesCol, (snap) => {
      const remoteExpenses: Expense[] = [];
      snap.forEach((d) => remoteExpenses.push(d.data() as Expense));
      if (remoteExpenses.length > 0) {
        setExpenses(remoteExpenses);
      }
    }, (err) => {
      console.warn('Real-time expenses listener error:', err);
    });

    return () => {
      unsubShop();
      unsubItems();
      unsubSales();
      unsubCustomers();
      unsubPayments();
      unsubExpenses();
    };
  }, [shop?.id, user]);

  // Fetch all shops for platform owner admin view
  useEffect(() => {
    if (isAdmin && user) {
      const fetchAllShops = async () => {
        try {
          const q = query(collection(db, 'shops'));
          const snap = await getDocs(q);
          const shopsList: Shop[] = [];
          snap.forEach((d) => shopsList.push(d.data() as Shop));
          setAllShops(shopsList);
        } catch (e) {
          console.warn('Failed to load all shops for admin:', e);
        }
      };
      void fetchAllShops();
    }
  }, [isAdmin, user]);

  // Drain offline pending queue to Firestore
  const syncNow = useCallback(async () => {
    if (!navigator.onLine || pendingQueue.length === 0 || isSyncing) return;
    setIsSyncing(true);

    const remainingQueue: PendingSyncAction[] = [];

    for (const item of pendingQueue) {
      try {
        const targetDoc = doc(db, item.path);
        await setDoc(targetDoc, item.data, { merge: true });
      } catch (err) {
        console.warn('Sync failed for item, keeping in queue:', item.id, err);
        remainingQueue.push(item);
      }
    }

    setPendingQueue(remainingQueue);
    setIsSyncing(false);
    if (remainingQueue.length === 0) {
      setLastOfflineNotice(null);
    }
  }, [pendingQueue, isSyncing]);

  const queueAction = (type: PendingSyncAction['type'], path: string, data: any) => {
    const action: PendingSyncAction = {
      id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type,
      path,
      data,
      timestamp: Date.now(),
    };
    setPendingQueue((prev) => [...prev, action]);
    if (!navigator.onLine) {
      setLastOfflineNotice('Saved offline on this phone. Will sync when internet returns.');
    } else {
      // Attempt immediate background sync
      setTimeout(() => void syncNow(), 50);
    }
  };

  // Safe helper to obtain a Firebase auth user if Anonymous is enabled or user logged in
  const ensureFirebaseAuth = async (): Promise<User | null> => {
    if (auth.currentUser) return auth.currentUser;
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (err: any) {
      // Anonymous authentication can be enabled in Firebase console under Auth > Sign-in method
      console.warn('Anonymous auth note (can be enabled in Firebase console):', err?.message);
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
      let currentUser = await ensureFirebaseAuth();

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
      } catch (e) {
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

    // 3. Persist to Firestore or queue
    const salePath = `shops/${shop.id}/sales/${saleId}`;
    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, salePath), newSale);
        // Sync item reductions
        for (const sold of saleData.items) {
          const matchedItem = updatedItems.find((i) => i.id === sold.itemId);
          if (matchedItem) {
            await setDoc(doc(db, `shops/${shop.id}/items/${matchedItem.id}`), matchedItem, { merge: true });
          }
        }
        // Sync customer credit
        if (saleData.paymentType === 'credit' && saleData.customerId) {
          const updatedCust = customers.find((c) => c.id === saleData.customerId);
          if (updatedCust) {
            await setDoc(doc(db, `shops/${shop.id}/customers/${updatedCust.id}`), {
              ...updatedCust,
              totalOwed: updatedCust.totalOwed + saleData.totalAmount,
              updatedAt: nowIso,
            }, { merge: true });
          }
        }
      } catch (err) {
        console.warn('Sale sync error, queuing locally:', err);
        queueAction('sale', salePath, newSale);
      }
    } else {
      queueAction('sale', salePath, newSale);
      for (const sold of saleData.items) {
        const matchedItem = updatedItems.find((i) => i.id === sold.itemId);
        if (matchedItem) {
          queueAction('stock_update', `shops/${shop.id}/items/${matchedItem.id}`, matchedItem);
        }
      }
    }

    return saleId;
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
      } catch (e) {
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
        } catch (e) {
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

  // Delete Item
  const deleteItem = async (itemId: string) => {
    if (!shop) return;
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    // Soft or hard delete in Firestore
    if (navigator.onLine && auth.currentUser) {
      try {
        const itemRef = doc(db, `shops/${shop.id}/items/${itemId}`);
        await setDoc(itemRef, { isDeleted: true }, { merge: true });
      } catch (e) {
        console.warn('Delete item sync note:', e);
      }
    }
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
      } catch (e) {
        queueAction('customer', path, newCustomer);
      }
    } else {
      queueAction('customer', path, newCustomer);
    }

    return newCustomer;
  };

  // Record Credit Payment
  const recordCreditPayment = async (
    customerId: string,
    amount: number,
    note?: string
  ) => {
    if (!shop) return;
    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const nowIso = new Date().toISOString();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) return;

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
    const newTotalOwed = Math.max(0, customer.totalOwed - amount);
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === customerId ? { ...c, totalOwed: newTotalOwed, updatedAt: nowIso } : c
      )
    );

    const paymentPath = `shops/${shop.id}/credit_payments/${paymentId}`;
    const customerPath = `shops/${shop.id}/customers/${customerId}`;

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, paymentPath), newPayment);
        await setDoc(doc(db, customerPath), { totalOwed: newTotalOwed, updatedAt: nowIso }, { merge: true });
      } catch (e) {
        queueAction('payment', paymentPath, newPayment);
      }
    } else {
      queueAction('payment', paymentPath, newPayment);
    }
  };

  // Add Expense
  const addExpense = async (
    category: Expense['category'],
    amount: number,
    note?: string
  ) => {
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
      } catch (e) {
        queueAction('expense', path, newExpense);
      }
    } else {
      queueAction('expense', path, newExpense);
    }
  };

  const deleteExpense = async (expenseId: string) => {
    if (!shop) return;
    setExpenses((prev) => prev.filter((e) => e.id !== expenseId));
  };

  // Admin Controls
  const adminExtendShop = async (shopId: string, days: number) => {
    const targetShop = allShops.find((s) => s.id === shopId) || (shop?.id === shopId ? shop : null);
    if (!targetShop) return;

    const currentExpiry = targetShop.planExpiryDate ? new Date(targetShop.planExpiryDate) : new Date();
    const base = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    const patched: Partial<Shop> = {
      planStatus: 'active',
      planExpiryDate: newExpiry.toISOString(),
    };

    if (shop?.id === shopId) {
      setShop((prev) => (prev ? { ...prev, ...patched } : null));
    }

    setAllShops((prev) =>
      prev.map((s) => (s.id === shopId ? { ...s, ...patched } : s))
    );

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

    setAllShops((prev) =>
      prev.map((s) => (s.id === shopId ? { ...s, ...patched } : s))
    );

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
        addItem,
        updateItem,
        quickRestock,
        deleteItem,
        addCustomer,
        recordCreditPayment,
        addExpense,
        deleteExpense,
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

export const useShop = () => {
  const context = useContext(ShopContext);
  if (!context) {
    throw new Error('useShop must be used within a ShopProvider');
  }
  return context;
};
