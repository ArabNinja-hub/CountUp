import type {
  ExpenseCategory,
  ManualPaymentNetwork,
  PaymentType,
  PlanBillingCycle,
  PlanStatus,
  StockMovementType,
  SubscriptionPaymentStatus,
} from '../types';

export type SyncOperationType =
  | 'sale'
  | 'void_sale'
  | 'item'
  | 'customer'
  | 'payment'
  | 'expense'
  | 'stock_update'
  | 'conflict_resolution'
  | 'backup_import';

export type SyncOperationOutcome = 'applied' | 'already-voided' | 'resolved' | 'flagged';

export interface ShopRow {
  id: string;
  owner_user_id: string;
  name: string;
  owner_phone: string;
  plan_status: PlanStatus;
  plan_type: PlanBillingCycle | 'trial';
  trial_ends_at: string;
  plan_expiry_at: string;
  sales_access_until: string;
  pending_payment_id: string | null;
  subscription_started_at: string | null;
  subscription_payment_id: string | null;
  status_before_suspension: Exclude<PlanStatus, 'suspended'> | null;
  is_deactivated: boolean;
  currency: 'ZMW';
  momo_airtel_number: string | null;
  momo_mtn_number: string | null;
  momo_zamtel_number: string | null;
  last_server_contact_at: string;
  security_notice: string | null;
  security_notice_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopPinCredentialRow {
  shop_id: string;
  pin_salt: string;
  pin_hash: string;
  pin_iterations: number;
  recovery_salt: string;
  recovery_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  last_failed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopVerifiedSessionRow {
  shop_id: string;
  session_id: string;
  user_id: string;
  verified_at: string;
  created_at: string;
  updated_at: string;
}

export interface ShopProfileUpdate {
  name?: string;
  momo_airtel_number?: string | null;
  momo_mtn_number?: string | null;
  momo_zamtel_number?: string | null;
}

export interface UsedTrialPhoneRow {
  phone_hash: string;
  first_shop_id: string;
  first_user_id: string | null;
  trial_used_at: string;
  was_suspended: boolean;
  last_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmsRateEventRow {
  id: number;
  phone_hash: string;
  ip_hash: string | null;
  purpose: 'otp' | 'otp_registration' | 'otp_signin' | 'pin_reset_notice' | 'recovery_code_notice';
  blocked: boolean;
  block_reason: string | null;
  day_utc: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformAlertRow {
  id: string;
  alert_key: string;
  severity: 'warning' | 'critical';
  category: 'sms_cap' | 'sms_abuse' | 'security';
  title: string;
  detail: string;
  metadata: Record<string, unknown>;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopPinResetRequestRow {
  id: string;
  shop_id: string;
  initiated_by_admin_id: string | null;
  identity_check_note: string;
  status: 'pending_wait' | 'completed' | 'cancelled';
  initiated_at: string;
  available_at: string;
  expires_at: string;
  sms_notified_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  shop_id: string;
  id: string;
  name: string;
  buying_price_ngwee: number;
  buying_price_known: boolean;
  selling_price_ngwee: number;
  unit_label: string;
  quantity: number;
  low_stock_threshold: number;
  is_deleted: boolean;
  is_demo: boolean;
  last_sold_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemCatalogUpdate {
  name?: string;
  unit_label?: string;
  buying_price_ngwee?: number;
  buying_price_known?: boolean;
  selling_price_ngwee?: number;
  low_stock_threshold?: number;
  is_deleted?: boolean;
}

export interface CustomerRow {
  shop_id: string;
  id: string;
  name: string;
  phone: string;
  notes: string;
  total_owed_ngwee: number;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerProfileUpdate {
  name?: string;
  phone?: string;
  notes?: string;
}

export interface SaleRow {
  shop_id: string;
  id: string;
  items_count: number;
  total_amount_ngwee: number;
  total_cost_ngwee: number;
  profit_ngwee: number;
  missing_cost_revenue_ngwee: number;
  payment_type: PaymentType;
  momo_operator: 'airtel' | 'mtn' | 'zamtel' | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  receipt_number: string;
  payment_reference: string | null;
  note: string | null;
  local_date: string | null;
  cash_tendered_ngwee: number | null;
  change_given_ngwee: number | null;
  is_deleted: boolean;
  is_demo: boolean;
  is_offline_sync: boolean;
  offline_window_flagged: boolean;
  offline_flag_reason: string | null;
  client_created_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaleLineRow {
  shop_id: string;
  id: string;
  sale_id: string;
  line_index: number;
  item_id: string;
  item_name: string;
  unit_label: string;
  quantity: number;
  buying_price_ngwee: number;
  buying_price_known: boolean;
  selling_price_ngwee: number;
  line_total_ngwee: number;
  created_at: string;
  updated_at: string;
}

export interface CreditPaymentRow {
  shop_id: string;
  id: string;
  customer_id: string;
  customer_name: string;
  amount_ngwee: number;
  payment_method: 'cash' | 'momo';
  note: string;
  local_date: string | null;
  is_demo: boolean;
  sync_correction: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseRow {
  shop_id: string;
  id: string;
  category: ExpenseCategory;
  amount_ngwee: number;
  note: string;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface StockMovementRow {
  shop_id: string;
  id: string;
  item_id: string;
  item_name: string;
  type: StockMovementType;
  delta: number;
  previous_quantity: number;
  new_quantity: number;
  reason: string;
  related_sale_id: string | null;
  requested_quantity: number | null;
  recount_needed: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface StockConflictRow {
  shop_id: string;
  id: string;
  item_id: string;
  item_name: string;
  kind: 'shortfall' | 'recount';
  observed: number | null;
  requested: number;
  available: number;
  shortfall: number;
  related_sale_id: string | null;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncOperationRow {
  shop_id: string;
  operation_id: string;
  operation_type: SyncOperationType;
  outcome: SyncOperationOutcome;
  sale_id: string | null;
  has_resolution: boolean;
  resolution: Record<string, unknown> | null;
  applied_at: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPaymentRow {
  id: string;
  shop_id: string;
  shop_name_snapshot: string;
  owner_user_id: string;
  provider: 'manual_mobile_money';
  network: ManualPaymentNetwork;
  plan_id: PlanBillingCycle;
  transaction_reference: string;
  payer_phone: string;
  payment_date: string;
  amount_ngwee: number;
  status: SubscriptionPaymentStatus;
  rejection_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  subscription_start_at: string | null;
  subscription_expiry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentReferenceLockRow {
  id: string;
  payment_id: string | null;
  shop_id: string | null;
  network: ManualPaymentNetwork;
  transaction_reference: string;
  status: SubscriptionPaymentStatus;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformAuditRow {
  id: string;
  action: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  shop_id: string | null;
  payment_id: string | null;
  transaction_reference: string | null;
  amount_ngwee: number | null;
  plan_id: PlanBillingCycle | null;
  days: number | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LedgerReconciliationReport {
  checked_at: string;
  shops_checked: number;
  total_differences: number;
  sale_line_mismatch_count: number;
  sale_profit_mismatch_count: number;
  customer_balance_mismatch_count: number;
  stock_movement_mismatch_count: number;
  sale_line_mismatches: Array<Record<string, unknown>>;
  sale_profit_mismatches: Array<Record<string, unknown>>;
  customer_balance_mismatches: Array<Record<string, unknown>>;
  stock_movement_mismatches: Array<Record<string, unknown>>;
}
