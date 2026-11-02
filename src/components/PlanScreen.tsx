import React, { useEffect, useState } from 'react';
import { ArrowLeft, Check, Clock, Copy, CreditCard, Info, Lock, ShieldCheck } from 'lucide-react';
import { GRACE_PERIOD_DAYS, SUBSCRIPTION_PLANS } from '../config/plans';
import { useShop } from '../context/ShopContext';
import { ManualPaymentNetwork, PlanBillingCycle } from '../types';
import {
  getManualPaymentInstructions,
  ManualPaymentInstructions,
} from '../services/subscriptionPayments';
import { useToast } from './Toast';

interface PlanScreenProps {
  onClose: () => void;
}

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const statusLabel: Record<string, string> = {
  trial: 'Free trial',
  pending_payment: 'Pending payment review',
  active: 'Active',
  grace: 'Grace period',
  expired: 'Expired',
  rejected: 'Payment rejected',
  suspended: 'Suspended',
};

export const PlanScreen: React.FC<PlanScreenProps> = ({ onClose }) => {
  const { shop, subscription, t, submitSubscriptionPayment, subscriptionPayments } = useShop();
  const { notify } = useToast();
  const [selectedPlanId, setSelectedPlanId] = useState<PlanBillingCycle>('monthly');
  const [network, setNetwork] = useState<ManualPaymentNetwork>('mtn');
  const [transactionReference, setTransactionReference] = useState('');
  const [payerPhone, setPayerPhone] = useState(shop?.ownerPhone ?? '');
  const [paymentDate, setPaymentDate] = useState(localToday);
  const [instructions, setInstructions] = useState<ManualPaymentInstructions | null>(null);
  const [configError, setConfigError] = useState('');
  const [isLoadingInstructions, setIsLoadingInstructions] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedNetwork, setCopiedNetwork] = useState<ManualPaymentNetwork | null>(null);
  const [success, setSuccess] = useState(false);

  const selectedPlan = SUBSCRIPTION_PLANS[selectedPlanId];
  const hasPendingPayment = Boolean(shop?.pendingPaymentId);
  const ownHistory = subscriptionPayments
    .filter((payment) => payment.shopId === shop?.id)
    .slice(0, 5);

  useEffect(() => {
    let mounted = true;
    setIsLoadingInstructions(true);
    if (!shop?.id) {
      setConfigError('Sign in to your shop to view payment instructions.');
      setIsLoadingInstructions(false);
      return () => {
        mounted = false;
      };
    }
    getManualPaymentInstructions(shop.id)
      .then((result) => {
        if (mounted) {
          setInstructions(result);
          setConfigError('');
        }
      })
      .catch(() => {
        if (mounted)
          setConfigError(
            'Payment instructions are temporarily unavailable. Please try again later.'
          );
      })
      .finally(() => {
        if (mounted) setIsLoadingInstructions(false);
      });
    return () => {
      mounted = false;
    };
  }, [shop?.id]);

  const copyNumber = async (selectedNetwork: ManualPaymentNetwork) => {
    const value = selectedNetwork === 'mtn' ? instructions?.mtn : instructions?.airtel;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedNetwork(selectedNetwork);
      window.setTimeout(() => setCopiedNetwork(null), 1800);
      notify('Payment number copied', { kind: 'success' });
    } catch {
      notify('Could not copy automatically', {
        kind: 'error',
        detail: 'Select and copy the number manually.',
      });
    }
  };

  const submitPayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasPendingPayment) {
      notify('A payment is already awaiting review', { kind: 'info' });
      return;
    }
    setIsSubmitting(true);
    setSuccess(false);
    try {
      await submitSubscriptionPayment({
        planId: selectedPlanId,
        network,
        transactionReference,
        payerPhone,
        paymentDate,
      });
      setSuccess(true);
      setTransactionReference('');
      notify('Payment submitted for review', {
        kind: 'success',
        detail:
          'Your subscription stays unchanged until an administrator verifies and approves the payment.',
      });
    } catch (error) {
      notify('Payment submission failed', {
        kind: 'error',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const badgeClass =
    subscription.status === 'active' || subscription.status === 'trial'
      ? 'bg-emerald-100 text-emerald-900'
      : subscription.status === 'pending_payment'
        ? 'bg-amber-100 text-amber-950'
        : subscription.status === 'grace'
          ? 'bg-amber-100 text-amber-950'
          : subscription.status === 'rejected' ||
              subscription.status === 'expired' ||
              subscription.status === 'suspended'
            ? 'bg-rose-100 text-rose-900'
            : 'bg-slate-100 text-slate-800';

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-3 py-4 sm:px-6">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-black text-slate-900">
              <CreditCard className="h-5 w-5 text-emerald-800" />
              {t.planTitle}
            </h1>
            <p className="text-xs text-slate-500">
              Manual MTN or Airtel Mobile Money · admin-verified
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[40px] rounded-lg bg-slate-100 px-3 text-xs font-bold text-slate-700"
        >
          {t.close}
        </button>
      </header>

      <section
        className="rounded-xl border border-slate-200 bg-white p-4"
        aria-label="Current subscription status"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${badgeClass}`}
            >
              {statusLabel[subscription.status] || subscription.status}
            </span>
            <h2 className="mt-2 text-base font-bold text-slate-950">
              {subscription.status === 'pending_payment'
                ? 'Your submitted payment is awaiting review.'
                : subscription.status === 'rejected'
                  ? 'The last payment was not approved. Review its reason below or submit a new payment.'
                  : subscription.status === 'suspended'
                    ? 'This subscription is suspended. Contact the platform administrator through the authorized support channel.'
                    : subscription.status === 'expired'
                      ? t.planExpiredNotice
                      : subscription.daysRemaining > 0
                        ? `${subscription.daysRemaining} ${t.daysRemaining}`
                        : subscription.status === 'grace'
                          ? `${subscription.graceDaysRemaining} grace-period days remaining`
                          : 'Subscription is active'}
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              {subscription.status === 'trial'
                ? 'Every shop starts with a 30-day free trial. New sales are locked after the trial and grace period end.'
                : subscription.status === 'grace'
                  ? `There is a ${GRACE_PERIOD_DAYS}-day grace period after expiry. Renew before it ends to keep recording sales.`
                  : subscription.status === 'pending_payment'
                    ? 'Submitting a reference does not activate a plan. The administrator must verify the operator transaction and approve it.'
                    : 'Your existing records remain available for viewing and export.'}
            </p>
          </div>
          {subscription.canRecordSales ? (
            <ShieldCheck className="h-8 w-8 text-emerald-800" />
          ) : (
            <Lock className="h-8 w-8 text-rose-700" />
          )}
        </div>
        <div className="mt-3 flex items-start gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-800" />
          <span>{t.existingDataSafe}</span>
        </div>
      </section>

      <fieldset className="space-y-2">
        <legend className="text-xs font-bold uppercase tracking-wide text-slate-600">
          Choose a plan
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(SUBSCRIPTION_PLANS) as PlanBillingCycle[]).map((key) => {
            const plan = SUBSCRIPTION_PLANS[key];
            const selected = selectedPlanId === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSelectedPlanId(key)}
                className={`rounded-xl border p-4 text-left ${selected ? 'border-emerald-800 bg-emerald-50 ring-1 ring-emerald-800' : 'border-slate-200 bg-white hover:border-slate-400'}`}
              >
                <span className="flex items-center justify-between gap-2 text-sm font-bold text-slate-900">
                  {plan.name}
                  {selected && <Check className="h-4 w-4 text-emerald-800" />}
                </span>
                <span className="mt-1 block text-2xl font-black tabular-nums text-emerald-900">
                  K {plan.priceKwacha.toFixed(2)}
                </span>
                <span className="mt-1 block text-xs text-slate-600">
                  {plan.months} {plan.months === 1 ? 'month' : 'months'} access · paid once
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <section
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        aria-labelledby="manual-payment-title"
      >
        <div>
          <h2 id="manual-payment-title" className="font-bold text-slate-950">
            Pay manually with Mobile Money
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Pay the exact amount for the selected plan, then submit the operator transaction
            reference below.
          </p>
        </div>
        {configError && (
          <p
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
          >
            {configError}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(['mtn', 'airtel'] as const).map((operator) => {
            const value = operator === 'mtn' ? instructions?.mtn : instructions?.airtel;
            const label = operator === 'mtn' ? 'MTN Mobile Money' : 'Airtel Money';
            return (
              <div
                key={operator}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
              >
                <div>
                  <p className="text-xs font-bold text-slate-800">{label}</p>
                  <p className="mt-1 font-mono text-sm text-slate-950">
                    {isLoadingInstructions ? 'Loading payment number…' : value || 'Not available'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!value}
                  onClick={() => void copyNumber(operator)}
                  aria-label={`Copy ${label} payment number`}
                  className="flex min-h-[40px] shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-bold text-slate-700 disabled:opacity-50"
                >
                  {copiedNetwork === operator ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copiedNetwork === operator ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>No immediate activation.</strong> Submissions go to private administrator
            review. Your subscription changes only after the payment is verified against the
            mobile-money transaction and explicitly approved. This is manual payment handling, not
            an automatic payment gateway.
          </p>
        </div>

        <form onSubmit={(event) => void submitPayment(event)} className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700">
            Network used
            <select
              value={network}
              onChange={(event) => setNetwork(event.target.value as ManualPaymentNetwork)}
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="mtn">MTN Mobile Money</option>
              <option value="airtel">Airtel Money</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Amount to pay
            <input
              value={`K ${selectedPlan.priceKwacha.toFixed(2)}`}
              readOnly
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-900"
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Transaction reference
            <input
              value={transactionReference}
              onChange={(event) => setTransactionReference(event.target.value)}
              required
              minLength={5}
              maxLength={50}
              autoComplete="off"
              placeholder="Reference from your operator receipt"
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 px-3 text-sm font-mono"
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Payer phone number
            <input
              value={payerPhone}
              onChange={(event) => setPayerPhone(event.target.value)}
              required
              inputMode="tel"
              autoComplete="tel"
              placeholder="e.g. 0977 123 456"
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Date paid
            <input
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
              required
              max={localToday()}
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 px-3 text-sm"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={isSubmitting || isLoadingInstructions || !instructions || hasPendingPayment}
              className="min-h-[44px] w-full rounded-lg bg-emerald-900 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting
                ? 'Submitting…'
                : hasPendingPayment
                  ? 'Payment awaiting review'
                  : 'Submit for manual review'}
            </button>
          </div>
        </form>
        {hasPendingPayment && (
          <p className="text-xs font-semibold text-amber-900">
            A payment is already pending for this shop. Wait for review before sending another
            submission.
          </p>
        )}
        {success && (
          <p
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900"
          >
            Submission received. No subscription was activated; watch for the administrator’s review
            decision.
          </p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="payment-history-title">
        <h2 id="payment-history-title" className="font-bold text-slate-900">
          Your payment history
        </h2>
        {ownHistory.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
            No payment submissions yet.
          </p>
        ) : (
          ownHistory.map((payment) => (
            <article
              key={payment.id}
              className="rounded-lg border border-slate-200 bg-white p-3 text-xs"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <strong className="capitalize text-slate-900">
                  {payment.status.replace('_', ' ')} · {payment.planId}
                </strong>
                <span className="font-bold tabular-nums">
                  K {(payment.amountNgwee / 100).toFixed(2)}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-slate-700">
                Reference: {payment.transactionReference}
              </p>
              {payment.rejectionReason && (
                <p className="mt-1 text-rose-800">Reason: {payment.rejectionReason}</p>
              )}
              {payment.subscriptionExpiryAt && (
                <p className="mt-1 text-emerald-800">
                  Approved · expires {new Date(payment.subscriptionExpiryAt).toLocaleDateString()}
                </p>
              )}
            </article>
          ))
        )}
      </section>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
        <h2 className="font-bold text-slate-900">Included with every plan</h2>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          <li>Sales and stock records</li>
          <li>Credit book and payment history</li>
          <li>Expenses and reports</li>
          <li>Offline-first shop workflow</li>
        </ul>
      </div>
    </div>
  );
};
