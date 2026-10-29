export type Language = 'en' | 'bem' | 'nya';

export type PlanStatus = 'trial' | 'active' | 'grace' | 'expired';

export type PlanBillingCycle = 'monthly' | 'quarterly' | 'biannual';

export interface Shop {
  id: string;
  name: string;
  ownerPhone: string;
  ownerUid: string;
  pin: string; // 4-digit numeric PIN — the only way into the shop
  planStatus: PlanStatus;
  planType: PlanBillingCycle | 'trial';
  createdAt: string; // ISO string
  trialEndsAt: string; // ISO string (30 days from creation)
  planExpiryDate: string; // ISO string
  isDeactivated: boolean;
  currency: 'ZMW';
  // Optional Shop Mobile Money numbers for customer payments
  momoAirtelNumber?: string;
  momoMtnNumber?: string;
  momoZamtelNumber?: string;
}

export interface Item {
  id: string;
  shopId: string;
  name: string;
  buyingPrice: number; // in Kwacha
  sellingPrice: number; // in Kwacha
  quantity: number;
  lowStockThreshold: number; // e.g. 5
  lastSoldAt?: string; // ISO string for quick-sorting most recently sold items
  createdAt: string;
  updatedAt: string;
}

export interface SaleItem {
  itemId: string;
  name: string;
  quantity: number;
  buyingPrice: number;
  sellingPrice: number;
}

export type PaymentType = 'cash' | 'momo' | 'credit';

export interface Sale {
  id: string;
  shopId: string;
  items: SaleItem[];
  itemsCount: number;
  totalAmount: number; // in Kwacha
  totalCost: number; // total buying price
  profit: number; // totalAmount - totalCost
  paymentType: PaymentType;
  momoOperator?: 'airtel' | 'mtn' | 'zamtel';
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  createdAt: string;
  isOfflineSync?: boolean;
}

export interface Customer {
  id: string;
  shopId: string;
  name: string;
  phone?: string;
  totalOwed: number; // in Kwacha
  createdAt: string;
  updatedAt: string;
}

export interface CreditPayment {
  id: string;
  shopId: string;
  customerId: string;
  customerName: string;
  amount: number; // in Kwacha
  paymentMethod?: 'cash' | 'momo';
  note?: string;
  createdAt: string;
}

export type ExpenseCategory =
  'rent' | 'transport' | 'restock' | 'council_fee' | 'helper_wage' | 'other';

export interface Expense {
  id: string;
  shopId: string;
  category: ExpenseCategory;
  amount: number; // in Kwacha
  note?: string;
  createdAt: string;
}

export interface PlanConfig {
  id: PlanBillingCycle;
  name: string;
  months: number;
  priceKwacha: number; // Total price
  monthlyRateKwacha: number;
  discountBadge?: string;
  description: string;
}

export type ActiveTab = 'sell' | 'stock' | 'credit' | 'reports';
