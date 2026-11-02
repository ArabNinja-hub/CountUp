import { httpsCallable } from 'firebase/functions';
import { ManualPaymentNetwork, PlanBillingCycle } from '../types';
import { functions } from '../firebase/functions';

export interface ManualPaymentInstructions {
  mtn: string;
  airtel: string;
  verification: 'manual';
}

export async function getManualPaymentInstructions(
  shopId: string
): Promise<ManualPaymentInstructions> {
  const call = httpsCallable<{ shopId: string }, ManualPaymentInstructions>(
    functions,
    'getManualPaymentInstructions'
  );
  return (await call({ shopId })).data;
}

export async function submitManualSubscriptionPayment(input: {
  shopId: string;
  planId: PlanBillingCycle;
  network: ManualPaymentNetwork;
  transactionReference: string;
  payerPhone: string;
  paymentDate: string;
}): Promise<{ id: string; status: 'pending' }> {
  const call = httpsCallable<typeof input, { id: string; status: 'pending' }>(
    functions,
    'submitManualSubscriptionPayment'
  );
  return (await call(input)).data;
}

export async function reviewManualSubscriptionPayment(input: {
  paymentId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}): Promise<{ status: 'approved' | 'rejected' }> {
  const call = httpsCallable<typeof input, { status: 'approved' | 'rejected' }>(
    functions,
    'reviewManualSubscriptionPayment'
  );
  return (await call(input)).data;
}

export async function extendShopSubscription(input: {
  shopId: string;
  days: number;
}): Promise<{ extended: true }> {
  const call = httpsCallable<typeof input, { extended: true }>(functions, 'extendShopSubscription');
  return (await call(input)).data;
}

export async function setShopSuspended(input: {
  shopId: string;
  suspended: boolean;
}): Promise<{ suspended: boolean }> {
  const call = httpsCallable<typeof input, { suspended: boolean }>(functions, 'setShopSuspended');
  return (await call(input)).data;
}
