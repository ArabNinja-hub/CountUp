import React, { useMemo, useState } from 'react';
import {
  Ban,
  CalendarPlus,
  CheckCircle,
  Clock3,
  CreditCard,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { getSubscriptionInfo } from '../config/plans';
import { useShop } from '../context/ShopContext';
import { ManualPaymentNetwork, Shop, SubscriptionPayment } from '../types';
import { useToast } from './Toast';

interface AdminScreenProps {
  onBack: () => void;
  exitLabel?: string;
}

type PaymentFilter = 'all' | 'pending' | 'approved' | 'rejected';

const money = (ngwee: number) => `K ${(ngwee / 100).toFixed(2)}`;
const dateTime = (value?: number) =>
  value && Number.isFinite(value) ? new Date(value).toLocaleString() : '—';
const networkName = (network: ManualPaymentNetwork) =>
  network === 'mtn' ? 'MTN Mobile Money' : 'Airtel Money';

export const AdminScreen: React.FC<AdminScreenProps> = ({ onBack, exitLabel = 'Exit admin' }) => {
  const {
    allShops,
    shop,
    adminExtendShop,
    adminToggleDeactivate,
    subscriptionPayments,
    reviewSubscriptionPayment,
  } = useShop();
  const { notify } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [shopFilter, setShopFilter] = useState<
    'all' | 'active' | 'trial' | 'pending_payment' | 'expired' | 'suspended'
  >('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('pending');
  const [paymentSearch, setPaymentSearch] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isUpdating, setIsUpdating] = useState<string | null>(null);

  const shopList = useMemo(() => {
    let list = [...allShops];
    if (shop && !list.some((entry) => entry.id === shop.id)) list.push(shop);
    const queryText = searchQuery.trim().toLowerCase();
    if (queryText) {
      list = list.filter(
        (entry) =>
          entry.name.toLowerCase().includes(queryText) ||
          entry.ownerPhone.includes(queryText) ||
          entry.id.toLowerCase().includes(queryText)
      );
    }
    if (shopFilter !== 'all') {
      list = list.filter((entry) => {
        const status = getSubscriptionInfo(
          entry.createdAt,
          entry.planExpiryDate,
          entry.planStatus,
          entry.isDeactivated,
          entry.salesAccessUntilMs,
          undefined,
          entry.planExpiryAtMs
        ).status;
        return shopFilter === 'active'
          ? status === 'active' || status === 'grace'
          : status === shopFilter;
      });
    }
    return list;
  }, [allShops, shop, searchQuery, shopFilter]);

  const stats = useMemo(() => {
    let trial = 0;
    let active = 0;
    let pending = 0;
    let expired = 0;
    let suspended = 0;
    for (const entry of allShops) {
      const result = getSubscriptionInfo(
        entry.createdAt,
        entry.planExpiryDate,
        entry.planStatus,
        entry.isDeactivated,
        entry.salesAccessUntilMs,
        undefined,
        entry.planExpiryAtMs
      );
      if (result.status === 'trial') trial++;
      else if (result.status === 'active' || result.status === 'grace') active++;
      else if (result.status === 'pending_payment') pending++;
      else if (result.status === 'suspended') suspended++;
      else expired++;
    }
    return {
      total: allShops.length,
      trial,
      active,
      pending,
      expired,
      suspended,
      receivedNgwee: subscriptionPayments
        .filter((payment) => payment.status === 'approved')
        .reduce((sum, payment) => sum + payment.amountNgwee, 0),
    };
  }, [allShops, subscriptionPayments]);

  const visiblePayments = useMemo(() => {
    const queryText = paymentSearch.trim().toLowerCase();
    return subscriptionPayments.filter((payment) => {
      if (paymentFilter !== 'all' && payment.status !== paymentFilter) return false;
      if (!queryText) return true;
      return [
        payment.shopNameSnapshot,
        payment.shopId,
        payment.transactionReference,
        payment.payerPhone,
        payment.ownerUid,
      ].some((value) => value.toLowerCase().includes(queryText));
    });
  }, [subscriptionPayments, paymentFilter, paymentSearch]);

  const handleReview = async (payment: SubscriptionPayment, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && rejectionReason.trim().length < 3) {
      notify('Add a reason before rejecting', { kind: 'error' });
      return;
    }
    setIsUpdating(payment.id);
    try {
      await reviewSubscriptionPayment({
        paymentId: payment.id,
        decision,
        ...(decision === 'reject' ? { reason: rejectionReason.trim() } : {}),
      });
      notify(
        decision === 'approve' ? 'Payment approved; subscription activated' : 'Payment rejected',
        {
          kind: 'success',
          detail:
            decision === 'approve'
              ? 'The transaction, subscription dates and review action have been recorded.'
              : 'The payment remains in history with the rejection reason.',
        }
      );
      setRejectingId(null);
      setRejectionReason('');
    } catch (error) {
      notify('Could not review payment', {
        kind: 'error',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUpdating(null);
    }
  };

  const handleExtend = async (target: Shop) => {
    const input = window.prompt(`Add subscription days for ${target.name} (1–3,650):`, '30');
    if (input === null) return;
    const days = Number(input);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      notify('Enter a whole number from 1 to 3,650 days', { kind: 'error' });
      return;
    }
    setIsUpdating(target.id);
    try {
      await adminExtendShop(target.id, days);
      notify(`+${days} days added to ${target.name}`, { kind: 'success' });
    } catch (error) {
      notify('Could not extend that subscription', {
        kind: 'error',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUpdating(null);
    }
  };

  const handleSuspend = async (target: Shop) => {
    const action = target.isDeactivated ? 'reactivate' : 'suspend';
    if (!window.confirm(`Are you sure you want to ${action} ${target.name}?`)) return;
    setIsUpdating(target.id);
    try {
      await adminToggleDeactivate(target.id);
      notify(target.isDeactivated ? `${target.name} reactivated` : `${target.name} suspended`, {
        kind: 'success',
        detail: 'The shop can still view existing records; suspension blocks new sales.',
      });
    } catch (error) {
      notify('Could not change shop status', {
        kind: 'error',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUpdating(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-3 py-4 sm:px-6">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-black text-slate-900">
            <ShieldCheck className="h-5 w-5 text-emerald-800" /> Admin console
          </h1>
          <p className="mt-1 text-xs text-slate-600">
            Private platform administration · server-verified access
          </p>
        </div>
        <button
          onClick={onBack}
          className="min-h-[40px] rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white"
        >
          {exitLabel}
        </button>
      </header>

      <section
        aria-label="Platform statistics"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7"
      >
        {[
          ['Shops', stats.total],
          ['Active / grace', stats.active],
          ['Free trial', stats.trial],
          ['Pending payment', stats.pending],
          ['Expired', stats.expired],
          ['Suspended', stats.suspended],
          ['Approved payments', money(stats.receivedNgwee)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-lg font-extrabold tabular-nums text-slate-950">{value}</p>
          </div>
        ))}
      </section>

      <section className="space-y-3" aria-labelledby="payments-title">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-emerald-800" />
          <div>
            <h2 id="payments-title" className="font-bold text-slate-900">
              Manual payment review
            </h2>
            <p className="text-xs text-slate-500">
              Verify the MTN/Airtel transaction independently before approving. A submitted
              reference is not proof of payment.
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <label className="relative block">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input
              value={paymentSearch}
              onChange={(event) => setPaymentSearch(event.target.value)}
              placeholder="Search shop, owner ID, phone or reference"
              aria-label="Search payment submissions"
              className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm"
            />
          </label>
          <div className="flex gap-1 overflow-x-auto" aria-label="Payment status filter">
            {(['pending', 'approved', 'rejected', 'all'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={paymentFilter === filter}
                onClick={() => setPaymentFilter(filter)}
                className={`min-h-[44px] rounded-lg px-3 text-xs font-bold capitalize ${paymentFilter === filter ? 'bg-emerald-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        {visiblePayments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            {paymentFilter === 'pending'
              ? 'No payments are awaiting review.'
              : 'No matching payment history.'}
          </div>
        ) : (
          <div className="space-y-2">
            {visiblePayments.map((payment) => {
              const pending = payment.status === 'pending';
              const deciding = isUpdating === payment.id;
              return (
                <article
                  key={payment.id}
                  className="rounded-xl border border-slate-200 bg-white p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-1 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold text-slate-950">
                          {payment.shopNameSnapshot || 'Shop'}
                        </h3>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${pending ? 'bg-amber-100 text-amber-900' : payment.status === 'approved' ? 'bg-emerald-100 text-emerald-900' : 'bg-rose-100 text-rose-900'}`}
                        >
                          {payment.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        Shop {payment.shopId} · owner {payment.ownerUid}
                      </p>
                      <p className="text-xs text-slate-600">
                        {networkName(payment.network)} · {payment.planId} ·{' '}
                        {money(payment.amountNgwee)}
                      </p>
                      <p className="break-all font-mono text-xs text-slate-800">
                        Transaction ref: {payment.transactionReference}
                      </p>
                      <p className="text-xs text-slate-600">
                        Payer {payment.payerPhone} · paid {payment.paymentDate} · submitted{' '}
                        {dateTime(payment.submittedAtMs)}
                      </p>
                      {payment.reviewedAtMs && (
                        <p className="text-xs text-slate-500">
                          Reviewed {dateTime(payment.reviewedAtMs)} · reviewer{' '}
                          {payment.reviewedByUid || '—'}
                        </p>
                      )}
                      {payment.subscriptionStartAt && (
                        <p className="text-xs font-semibold text-emerald-900">
                          Subscription: {dateTime(payment.subscriptionStartAtMs)} to{' '}
                          {payment.subscriptionExpiryAt
                            ? new Date(payment.subscriptionExpiryAt).toLocaleDateString()
                            : '—'}
                        </p>
                      )}
                      {payment.rejectionReason && (
                        <p className="text-xs text-rose-800">Reason: {payment.rejectionReason}</p>
                      )}
                    </div>
                    {pending && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={deciding}
                          onClick={() => void handleReview(payment, 'approve')}
                          className="flex min-h-[42px] items-center gap-1.5 rounded-lg bg-emerald-800 px-3 text-xs font-bold text-white disabled:opacity-50"
                        >
                          <CheckCircle className="h-4 w-4" /> Approve &amp; activate
                        </button>
                        <button
                          type="button"
                          disabled={deciding}
                          onClick={() => {
                            setRejectingId(rejectingId === payment.id ? null : payment.id);
                            setRejectionReason('');
                          }}
                          className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 text-xs font-bold text-rose-800 disabled:opacity-50"
                        >
                          <Ban className="h-4 w-4" /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                  {pending && rejectingId === payment.id && (
                    <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row">
                      <label className="flex-1 text-xs font-semibold text-slate-700">
                        Rejection reason
                        <input
                          value={rejectionReason}
                          onChange={(event) => setRejectionReason(event.target.value)}
                          maxLength={500}
                          className="mt-1 min-h-[42px] w-full rounded-lg border border-slate-300 px-3 text-sm font-normal"
                          placeholder="For example, reference not found in the operator statement"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={deciding || rejectionReason.trim().length < 3}
                        onClick={() => void handleReview(payment, 'reject')}
                        className="mt-4 min-h-[42px] rounded-lg bg-rose-800 px-4 text-xs font-bold text-white disabled:opacity-50 sm:self-end"
                      >
                        {deciding ? 'Saving…' : 'Confirm rejection'}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="shops-title">
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-emerald-800" />
          <div>
            <h2 id="shops-title" className="font-bold text-slate-900">
              Shops and accounts
            </h2>
            <p className="text-xs text-slate-500">
              Search, inspect status, extend a plan, or suspend an account.
            </p>
          </div>
        </div>
        <label className="relative block">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by shop name, owner phone or shop ID"
            aria-label="Search shops and accounts"
            className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm"
          />
        </label>
        <div className="flex gap-1 overflow-x-auto" aria-label="Shop subscription status filter">
          {(['all', 'active', 'trial', 'pending_payment', 'expired', 'suspended'] as const).map(
            (filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={shopFilter === filter}
                onClick={() => setShopFilter(filter)}
                className={`min-h-[40px] shrink-0 rounded-lg px-3 text-xs font-bold capitalize ${shopFilter === filter ? 'bg-emerald-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
              >
                {filter.replace('_', ' ')}
              </button>
            )
          )}
        </div>
        {shopList.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No shops found.
          </div>
        ) : (
          <div className="space-y-2">
            {shopList.map((entry) => {
              const info = getSubscriptionInfo(
                entry.createdAt,
                entry.planExpiryDate,
                entry.planStatus,
                entry.isDeactivated,
                entry.salesAccessUntilMs,
                undefined,
                entry.planExpiryAtMs
              );
              return (
                <article key={entry.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-bold text-slate-950">{entry.name}</h3>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
                          {info.status.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-1 break-all text-xs text-slate-600">
                        Owner phone: {entry.ownerPhone} · Shop ID: {entry.id}
                      </p>
                      <p className="text-xs text-slate-600">
                        Plan: {entry.planType || 'trial'} · expires{' '}
                        {info.effectiveExpiry.toLocaleDateString()} · access{' '}
                        {info.canRecordSales ? 'allowed' : 'locked'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={isUpdating === entry.id}
                        onClick={() => void handleExtend(entry)}
                        className="flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-bold text-slate-800 disabled:opacity-50"
                      >
                        <CalendarPlus className="h-4 w-4" /> Extend
                      </button>
                      <button
                        type="button"
                        disabled={isUpdating === entry.id}
                        onClick={() => void handleSuspend(entry)}
                        className={`flex min-h-[40px] items-center gap-1 rounded-lg px-3 text-xs font-bold text-white disabled:opacity-50 ${entry.isDeactivated ? 'bg-emerald-800' : 'bg-rose-800'}`}
                      >
                        {entry.isDeactivated ? (
                          <CheckCircle className="h-4 w-4" />
                        ) : (
                          <Ban className="h-4 w-4" />
                        )}
                        {entry.isDeactivated ? 'Reactivate' : 'Suspend'}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        Payment references are unique per operator and permanently retained in the review history.
        Check the operator’s transaction record before activating a subscription.
      </p>
    </div>
  );
};
