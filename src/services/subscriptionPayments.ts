import {
  getActiveShopWriteClient,
  normalizeSupabaseError,
  type ShopRpcQueryClient,
} from '../data/shopWriteRpc';
import { supabase } from '../supabase/client';
import { ManualPaymentNetwork, PlanBillingCycle } from '../types';

export interface ManualPaymentInstructions {
  mtn: string;
  airtel: string;
  verification: 'manual';
}

function generateOperationId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export async function getManualPaymentInstructions(
  shopId?: string
): Promise<ManualPaymentInstructions> {
  const { data, error } = await supabase.functions.invoke('get-payment-instructions', {
    body: shopId ? { shopId } : {},
  });
  if (error) {
    const maybeContext = (error as { context?: Response }).context;
    if (maybeContext && typeof maybeContext.json === 'function') {
      try {
        const parsed = (await maybeContext.json()) as { error?: string };
        if (parsed.error) {
          throw new Error(parsed.error);
        }
      } catch (inner) {
        if (inner instanceof Error && inner.message !== error.message) {
          throw inner;
        }
      }
    }
    throw new Error(error.message || 'Payment instructions are temporarily unavailable.');
  }
  return data as ManualPaymentInstructions;
}

export async function submitManualSubscriptionPayment(
  input: {
    shopId: string;
    planId: PlanBillingCycle;
    network: ManualPaymentNetwork;
    transactionReference: string;
    payerPhone: string;
    paymentDate: string;
    operationId?: string;
    expectedAmountNgwee?: number;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<{ id: string; status: 'pending'; idempotent?: boolean }> {
  const { data, error } = await client.rpc('submit_subscription_payment', {
    p_shop_id: input.shopId,
    p_plan_id: input.planId,
    p_network: input.network,
    p_transaction_reference: input.transactionReference,
    p_payer_phone: input.payerPhone,
    p_payment_date: input.paymentDate,
    p_operation_id: input.operationId ?? null,
    p_expected_amount_ngwee: input.expectedAmountNgwee ?? null,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(res.id ?? ''),
    status: 'pending',
    ...(typeof res.idempotent === 'boolean' ? { idempotent: res.idempotent } : {}),
  };
}

export async function reviewManualSubscriptionPayment(
  input: {
    paymentId: string;
    decision: 'approve' | 'reject';
    reason?: string;
    operationId?: string;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<{ status: 'approved' | 'rejected'; idempotent?: boolean }> {
  const { data, error } = await client.rpc('review_subscription_payment', {
    p_payment_id: input.paymentId,
    p_decision: input.decision,
    p_reason: input.reason ?? null,
    p_operation_id: input.operationId ?? null,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    status: res.status === 'approved' ? 'approved' : 'rejected',
    ...(typeof res.idempotent === 'boolean' ? { idempotent: res.idempotent } : {}),
  };
}

export async function extendShopSubscription(
  input: {
    shopId: string;
    days: number;
    operationId?: string;
    reason?: string;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<{ extended: true; idempotent?: boolean }> {
  const { data, error } = await client.rpc('admin_extend_shop_subscription', {
    p_shop_id: input.shopId,
    p_days: input.days,
    p_operation_id: input.operationId || generateOperationId('admin_ext'),
    p_reason: input.reason ?? null,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    extended: true,
    ...(typeof res.idempotent === 'boolean' ? { idempotent: res.idempotent } : {}),
  };
}

export async function setShopSuspended(
  input: {
    shopId: string;
    suspended: boolean;
    operationId?: string;
    reason?: string;
  },
  client: ShopRpcQueryClient = getActiveShopWriteClient()
): Promise<{ suspended: boolean; idempotent?: boolean }> {
  const { data, error } = await client.rpc('admin_set_shop_suspended', {
    p_shop_id: input.shopId,
    p_suspended: input.suspended,
    p_operation_id: input.operationId ?? null,
    p_reason: input.reason ?? null,
  });
  if (error) {
    throw normalizeSupabaseError(error);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    suspended: Boolean(res.suspended),
    ...(typeof res.idempotent === 'boolean' ? { idempotent: res.idempotent } : {}),
  };
}
