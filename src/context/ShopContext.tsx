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
  PlanBillingCycle,
} from '../types';
import { translations, Translations } from '../i18n/translations';
import { getSubscriptionInfo, SUBSCRIPTION_PLANS } from '../config/plans';
import { auth, db, handleFirestoreError, OperationType, testConnection } from '../firebase/config';
import {
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
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
  loginWithGoogle: () => Promise<boolean>;
  registerNewShop: (name: string, phone: string, pin: string) => Promise<boolean>;
  loadDemoShop: (demoType: 'kiosk' | 'stall' | 'minimart') => Promise<void>;
  logout: () => Promise<void>;
  toggleAdminMode: () => void;

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
  upgradePlan: (planId: PlanBillingCycle, momoPhone: string, operator: string) => Promise<boolean>;

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

// Initial sample inventory for Zambian kiosks
const DEFAULT_ZAMBIAN_ITEMS = [
  { name: 'Sugar 1kg (Illovo)', buyingPrice: 28, sellingPrice: 34, quantity: 24, lowStockThreshold: 5 },
  { name: 'Mealie Meal 25kg (Breakfast)', buyingPrice: 280, sellingPrice: 320, quantity: 15, lowStockThreshold: 4 },
  { name: 'Cooking Oil 750ml', buyingPrice: 38, sellingPrice: 46, quantity: 18, lowStockThreshold: 5 },
  { name: 'Boom Washing Paste 400g', buyingPrice: 19, sellingPrice: 25, quantity: 30, lowStockThreshold: 6 },
  { name: 'Eggs (Tray of 30)', buyingPrice: 75, sellingPrice: 90, quantity: 8, lowStockThreshold: 3 },
  { name: 'Matches (Box)', buyingPrice: 10, sellingPrice: 15, quantity: 45, lowStockThreshold: 10 },
  { name: 'Candles (6 Pack)', buyingPrice: 20, sellingPrice: 26, quantity: 12, lowStockThreshold: 4 },
  { name: 'Coca-Cola 300ml', buyingPrice: 8, sellingPrice: 12, quantity: 28, lowStockThreshold: 6 },
  { name: 'Panado Pain Tablets', buyingPrice: 15, sellingPrice: 22, quantity: 35, lowStockThreshold: 8 },
  { name: 'Salt 500g', buyingPrice: 7, sellingPrice: 10, quantity: 20, lowStockThreshold: 5 },
];

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

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser?.email === 'ronisherbwalya@gmail.com') {
        setIsAdmin(true);
      }
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Listen to Firestore real-time updates when shop is loaded and online
  useEffect(() => {
    if (!shop?.id || !user) return;

    const shopPath = `shops/${shop.id}`;
    const shopRef = doc(db, 'shops', shop.id);
    const unsubShop = onSnapshot(shopRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Shop;
        setShop(data);
      }
    }, (err) => {
      console.warn('Real-time shop listener warning:', err);
      handleFirestoreError(err, OperationType.GET, shopPath);
    });

    const itemsPath = `shops/${shop.id}/items`;
    const itemsCol = collection(db, 'shops', shop.id, 'items');
    const unsubItems = onSnapshot(itemsCol, (snap) => {
      const remoteItems: Item[] = [];
      snap.forEach((d) => remoteItems.push(d.data() as Item));
      if (remoteItems.length > 0) {
        setItems(remoteItems);
      }
    }, (err) => {
      console.warn('Real-time items listener warning:', err);
      handleFirestoreError(err, OperationType.GET, itemsPath);
    });

    const salesPath = `shops/${shop.id}/sales`;
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
      console.warn('Real-time sales listener warning:', err);
      handleFirestoreError(err, OperationType.GET, salesPath);
    });

    const customersPath = `shops/${shop.id}/customers`;
    const customersCol = collection(db, 'shops', shop.id, 'customers');
    const unsubCustomers = onSnapshot(customersCol, (snap) => {
      const remoteCustomers: Customer[] = [];
      snap.forEach((d) => remoteCustomers.push(d.data() as Customer));
      if (remoteCustomers.length > 0) {
        setCustomers(remoteCustomers);
      }
    }, (err) => {
      console.warn('Real-time customers listener warning:', err);
      handleFirestoreError(err, OperationType.GET, customersPath);
    });

    const paymentsPath = `shops/${shop.id}/credit_payments`;
    const paymentsCol = collection(db, 'shops', shop.id, 'credit_payments');
    const unsubPayments = onSnapshot(paymentsCol, (snap) => {
      const remotePayments: CreditPayment[] = [];
      snap.forEach((d) => remotePayments.push(d.data() as CreditPayment));
      if (remotePayments.length > 0) {
        setCreditPayments(remotePayments);
      }
    }, (err) => {
      console.warn('Real-time credit payments listener warning:', err);
      handleFirestoreError(err, OperationType.GET, paymentsPath);
    });

    const expensesPath = `shops/${shop.id}/expenses`;
    const expensesCol = collection(db, 'shops', shop.id, 'expenses');
    const unsubExpenses = onSnapshot(expensesCol, (snap) => {
      const remoteExpenses: Expense[] = [];
      snap.forEach((d) => remoteExpenses.push(d.data() as Expense));
      if (remoteExpenses.length > 0) {
        setExpenses(remoteExpenses);
      }
    }, (err) => {
      console.warn('Real-time expenses listener warning:', err);
      handleFirestoreError(err, OperationType.GET, expensesPath);
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

  // Safe helper to obtain a Firebase auth user if user is logged in
  const ensureFirebaseAuth = async (): Promise<User | null> => {
    return auth.currentUser;
  };

  // Google Sign-In (Official provider enabled by default in AI Studio Firebase)
  const loginWithGoogle = async (): Promise<boolean> => {
    setIsLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      const googleUser = cred.user;
      setUser(googleUser);

      if (googleUser.email === 'ronisherbwalya@gmail.com') {
        setIsAdmin(true);
      }

      // Check if user already has an existing shop in Firestore
      if (navigator.onLine) {
        try {
          const q = query(collection(db, 'shops'));
          const snap = await getDocs(q);
          let foundShop: Shop | null = null;
          snap.forEach((d) => {
            const data = d.data() as Shop;
            if (data.ownerUid === googleUser.uid || (data.ownerEmail && data.ownerEmail === googleUser.email)) {
              foundShop = data;
            }
          });
          if (foundShop) {
            setShop(foundShop);
            setIsLoading(false);
            return true;
          }
        } catch (e) {
          console.warn('Google user shop lookup note:', e);
        }
      }

      // If user already had a local shop, link it
      if (shop) {
        const linkedShop: Shop = {
          ...shop,
          ownerUid: googleUser.uid,
          ownerEmail: googleUser.email || undefined,
        };
        setShop(linkedShop);
        if (navigator.onLine) {
          try {
            await setDoc(doc(db, 'shops', shop.id), linkedShop, { merge: true });
          } catch (e) {
            console.warn('Link shop firestore note:', e);
          }
        }
      } else {
        // Create new shop for Google user
        const newShopId = `shop_${googleUser.uid.substring(0, 15)}`;
        const now = new Date();
        const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const autoShop: Shop = {
          id: newShopId,
          name: googleUser.displayName ? `${googleUser.displayName}'s Kiosk` : 'My Zambian Kiosk',
          ownerPhone: googleUser.phoneNumber || '0977 123 456',
          ownerEmail: googleUser.email || undefined,
          ownerUid: googleUser.uid,
          pin: '1234',
          planStatus: 'active',
          planType: 'monthly',
          createdAt: now.toISOString(),
          trialEndsAt: trialEnds.toISOString(),
          planExpiryDate: trialEnds.toISOString(),
          isDeactivated: false,
          currency: 'ZMW',
        };
        const seeded = DEFAULT_ZAMBIAN_ITEMS.map((item, idx) => ({
          id: `item_${newShopId}_${idx}`,
          shopId: newShopId,
          name: item.name,
          buyingPrice: item.buyingPrice,
          sellingPrice: item.sellingPrice,
          quantity: item.quantity,
          lowStockThreshold: item.lowStockThreshold,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }));
        setShop(autoShop);
        setItems(seeded);
        if (navigator.onLine) {
          try {
            await setDoc(doc(db, 'shops', newShopId), autoShop);
            for (const item of seeded) {
              await setDoc(doc(db, 'shops', newShopId, 'items', item.id), item);
            }
          } catch (e) {
            console.warn('Auto shop firestore creation note:', e);
          }
        }
      }

      setIsLoading(false);
      return true;
    } catch (err: any) {
      console.error('Google Sign-in error:', err);
      setIsLoading(false);
      return false;
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

      let currentUser = await ensureFirebaseAuth();

      const now = new Date();
      const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const newShop: Shop = {
        id: shopId,
        name: name.trim() || 'My Zambian Kiosk',
        ownerPhone: phone.trim(),
        ownerUid: currentUser?.uid || shopId,
        pin: pin.trim(),
        planStatus: 'active',
        planType: 'monthly',
        createdAt: now.toISOString(),
        trialEndsAt: trialEnds.toISOString(),
        planExpiryDate: trialEnds.toISOString(),
        isDeactivated: false,
        currency: 'ZMW',
      };

      // Seed initial default items
      const seededItems: Item[] = DEFAULT_ZAMBIAN_ITEMS.map((item, index) => ({
        id: `item_${Date.now()}_${index}`,
        shopId,
        name: item.name,
        buyingPrice: item.buyingPrice,
        sellingPrice: item.sellingPrice,
        quantity: item.quantity,
        lowStockThreshold: item.lowStockThreshold,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));

      // Set local state immediately for fast response
      setShop(newShop);
      setItems(seededItems);
      setSales([]);
      setCustomers([]);
      setCreditPayments([]);
      setExpenses([]);

      // Persist to Firestore or queue
      if (navigator.onLine && currentUser) {
        try {
          await setDoc(doc(db, 'shops', shopId), newShop);
          for (const item of seededItems) {
            await setDoc(doc(db, 'shops', shopId, 'items', item.id), item);
          }
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `shops/${shopId}`);
          queueAction('item', `shops/${shopId}`, newShop);
        }
      } else {
        queueAction('item', `shops/${shopId}`, newShop);
        seededItems.forEach((item) => {
          queueAction('item', `shops/${shopId}/items/${item.id}`, item);
        });
      }

      setIsLoading(false);
      return true;
    } catch (error) {
      console.error('Registration error:', error);
      setIsLoading(false);
      return false;
    }
  };

  // Demo shop loader for instant 1-tap testing
  const loadDemoShop = async (demoType: 'kiosk' | 'stall' | 'minimart') => {
    setIsLoading(true);
    let currentUser = await ensureFirebaseAuth();

    const demoNames = {
      kiosk: 'Bwino General Kiosk (Lusaka)',
      stall: 'Soweto Market Stall #42',
      minimart: 'Chilenje Grocer & Provisions',
    };

    const demoPhones = {
      kiosk: '0977 123 456',
      stall: '0966 987 654',
      minimart: '0955 555 111',
    };

    const cleanPhone = demoPhones[demoType].replace(/\D/g, '');
    const shopId = `shop_demo_${demoType}`;
    const now = new Date();
    const trialEnds = new Date(now.getTime() + 27 * 24 * 60 * 60 * 1000); // 27 days left in trial

    const demoShop: Shop = {
      id: shopId,
      name: demoNames[demoType],
      ownerPhone: demoPhones[demoType],
      ownerUid: currentUser?.uid || shopId,
      pin: '1234',
      planStatus: 'active',
      planType: 'monthly',
      createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      trialEndsAt: trialEnds.toISOString(),
      planExpiryDate: trialEnds.toISOString(),
      isDeactivated: false,
      currency: 'ZMW',
    };

    const seededItems: Item[] = DEFAULT_ZAMBIAN_ITEMS.map((item, idx) => ({
      id: `item_${shopId}_${idx}`,
      shopId,
      name: item.name,
      buyingPrice: item.buyingPrice,
      sellingPrice: item.sellingPrice,
      quantity: idx === 1 ? 2 : idx === 4 ? 3 : item.quantity, // Make a couple items low stock for preview!
      lowStockThreshold: item.lowStockThreshold,
      lastSoldAt: idx < 4 ? new Date(now.getTime() - idx * 3600000).toISOString() : undefined,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }));

    // Demo customers with debt
    const demoCustomers: Customer[] = [
      {
        id: `cust_${shopId}_1`,
        shopId,
        name: 'Ba Mwila (Teacher)',
        phone: '0977 888 999',
        totalOwed: 145,
        createdAt: new Date(now.getTime() - 4 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      },
      {
        id: `cust_${shopId}_2`,
        shopId,
        name: 'Mama Bwalya',
        phone: '0966 222 333',
        totalOwed: 85,
        createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 2 * 86400000).toISOString(),
      },
      {
        id: `cust_${shopId}_3`,
        shopId,
        name: 'Uncle James (Mechanic)',
        phone: '0955 444 777',
        totalOwed: 210,
        createdAt: new Date(now.getTime() - 10 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 3 * 86400000).toISOString(),
      },
    ];

    // Demo sales
    const demoSales: Sale[] = [
      {
        id: `sale_${shopId}_1`,
        shopId,
        items: [{ itemId: seededItems[0].id, name: seededItems[0].name, quantity: 2, buyingPrice: 28, sellingPrice: 34 }],
        itemsCount: 2,
        totalAmount: 68,
        totalCost: 56,
        profit: 12,
        paymentType: 'cash',
        createdAt: new Date(now.getTime() - 2 * 3600000).toISOString(),
      },
      {
        id: `sale_${shopId}_2`,
        shopId,
        items: [{ itemId: seededItems[1].id, name: seededItems[1].name, quantity: 1, buyingPrice: 280, sellingPrice: 320 }],
        itemsCount: 1,
        totalAmount: 320,
        totalCost: 280,
        profit: 40,
        paymentType: 'credit',
        customerId: demoCustomers[0].id,
        customerName: demoCustomers[0].name,
        customerPhone: demoCustomers[0].phone,
        createdAt: new Date(now.getTime() - 5 * 3600000).toISOString(),
      },
      {
        id: `sale_${shopId}_3`,
        shopId,
        items: [
          { itemId: seededItems[3].id, name: seededItems[3].name, quantity: 1, buyingPrice: 19, sellingPrice: 25 },
          { itemId: seededItems[7].id, name: seededItems[7].name, quantity: 2, buyingPrice: 8, sellingPrice: 12 },
        ],
        itemsCount: 3,
        totalAmount: 49,
        totalCost: 35,
        profit: 14,
        paymentType: 'momo',
        momoOperator: 'airtel',
        createdAt: new Date(now.getTime() - 12 * 3600000).toISOString(),
      },
    ];

    // Demo expenses
    const demoExpenses: Expense[] = [
      {
        id: `exp_${shopId}_1`,
        shopId,
        category: 'council_fee',
        amount: 15,
        note: 'Daily market levy Lusaka City Council',
        createdAt: new Date(now.getTime() - 8 * 3600000).toISOString(),
      },
      {
        id: `exp_${shopId}_2`,
        shopId,
        category: 'transport',
        amount: 40,
        note: 'Canter delivery from Soweto market',
        createdAt: new Date(now.getTime() - 24 * 3600000).toISOString(),
      },
    ];

    setShop(demoShop);
    setItems(seededItems);
    setCustomers(demoCustomers);
    setSales(demoSales);
    setExpenses(demoExpenses);
    setCreditPayments([]);
    setIsLoading(false);

    // Save demo shop to Firestore if online
    if (navigator.onLine && currentUser) {
      try {
        await setDoc(doc(db, 'shops', shopId), demoShop);
      } catch (e) {
        console.warn('Demo shop Firestore sync note:', e);
      }
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

  const toggleAdminMode = () => {
    setIsAdmin((prev) => !prev);
  };

  // Subscription info - full free access
  const subscription = {
    daysRemaining: 365,
    graceDaysRemaining: 0,
    effectiveExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    status: 'active' as const,
    isWarningPeriod: false,
    canRecordSales: true,
  };

  // Record a sale (under 15-second flow)
  const recordSale = async (
    saleData: Omit<Sale, 'id' | 'shopId' | 'createdAt'>
  ): Promise<string> => {
    if (!shop) throw new Error('No active shop');
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

  // Upgrade / Renew Plan via Mobile Money
  const upgradePlan = async (
    planId: PlanBillingCycle,
    momoPhone: string,
    operator: string
  ): Promise<boolean> => {
    if (!shop) return false;
    const selectedPlan = SUBSCRIPTION_PLANS[planId];
    if (!selectedPlan) return false;

    // Calculate new expiry date based on existing expiry or now
    const now = new Date();
    const currentExpiry = shop.planExpiryDate ? new Date(shop.planExpiryDate) : now;
    const baseDate = currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
    const additionalMs = selectedPlan.months * 30 * 24 * 60 * 60 * 1000;
    const newExpiry = new Date(baseDate.getTime() + additionalMs);

    const updatedShop: Shop = {
      ...shop,
      planStatus: 'active',
      planType: planId,
      planExpiryDate: newExpiry.toISOString(),
    };

    setShop(updatedShop);

    if (navigator.onLine && auth.currentUser) {
      try {
        await setDoc(doc(db, 'shops', shop.id), updatedShop, { merge: true });
      } catch (e) {
        queueAction('item', `shops/${shop.id}`, updatedShop);
      }
    } else {
      queueAction('item', `shops/${shop.id}`, updatedShop);
    }

    return true;
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
        loginWithGoogle,
        registerNewShop,
        loadDemoShop,
        logout,
        toggleAdminMode,
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
        upgradePlan,
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
