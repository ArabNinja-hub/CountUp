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
  buyingPrice: number; // in Kwacha; 0 when the cost is unknown
  /** Absent on older CountUp records, whose cost prices were always recorded. */
  buyingPriceKnown?: boolean;
  sellingPrice: number; // in Kwacha
  unitLabel?: string;
  /** Existing CountUp soft deletes are treated as reversible archives. */
  isDeleted?: boolean;
  isDemo?: boolean;
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
  buyingPriceKnown?: boolean;
  sellingPrice: number;
  unitLabel?: string;
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
  /** Imported ShopBook receipts keep their original reference. New references use the sale ID. */
  receiptNumber?: string;
  paymentReference?: string;
  note?: string;
  localDate?: string;
  /** Revenue excluded from profit because the cost at the time of sale was unknown. */
  missingCostRevenue?: number;
  isDemo?: boolean;
  createdAt: string;
  isOfflineSync?: boolean;
}

export interface Customer {
  id: string;
  shopId: string;
  name: string;
  phone?: string;
  notes?: string;
  isDemo?: boolean;
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
  paymentMethod?: 'cash' | 'momo'; // absent in legacy records means cash
  note?: string;
  localDate?: string;
  isDemo?: boolean;
  createdAt: string;
}

export type StockMovementType = 'initial' | 'sale' | 'restock' | 'adjustment' | 'void';

export interface StockMovement {
  id: string;
  shopId: string;
  itemId: string;
  itemName: string;
  type: StockMovementType;
  delta: number;
  previousQuantity: number;
  newQuantity: number;
  reason: string;
  relatedSaleId?: string;
  isDemo?: boolean;
  createdAt: string;
}

export interface StockConflict {
  id: string;
  itemId: string;
  itemName: string;
  requested: number;
  available: number;
  shortfall: number;
  relatedSaleId?: string;
  createdAt: string;
  resolved: boolean;
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

export type ActiveTab = 'home' | 'sell' | 'stock' | 'credit' | 'reports';
