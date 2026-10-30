import React, { useState, useMemo } from 'react';
import { useShop } from '../context/ShopContext';
import { ShieldCheck, Search, CheckCircle, Ban, CalendarPlus, KeyRound } from 'lucide-react';
import { getSubscriptionInfo, SUBSCRIPTION_PLANS } from '../config/plans';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { Shop } from '../types';

interface AdminScreenProps {
  onBack: () => void;
  exitLabel?: string;
}

export const AdminScreen: React.FC<AdminScreenProps> = ({ onBack, exitLabel = 'Exit admin' }) => {
  const { allShops, shop, adminExtendShop, adminToggleDeactivate, changeAdminPasscode } = useShop();
  const { notify } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [isUpdating, setIsUpdating] = useState<string | null>(null);
  const [shopToToggle, setShopToToggle] = useState<Shop | null>(null);
  const [showPasscodeForm, setShowPasscodeForm] = useState(false);
  const [newPasscode, setNewPasscode] = useState('');
  const [confirmNewPasscode, setConfirmNewPasscode] = useState('');
  const [isChangingPasscode, setIsChangingPasscode] = useState(false);

  // If allShops is empty in single-user context, ensure current shop is included in view
  const shopList = useMemo(() => {
    let list = [...allShops];
    if (shop && !list.find((s) => s.id === shop.id)) {
      list.push(shop);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.ownerPhone.includes(q) ||
          s.id.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allShops, shop, searchQuery]);

  // Platform Metrics
  const stats = useMemo(() => {
    const total = shopList.length;
    let onTrial = 0;
    let paying = 0;
    let expiringSoon = 0;
    let estimatedMonthlyRevenue = 0;

    shopList.forEach((s) => {
      const sub = getSubscriptionInfo(s.createdAt, s.planExpiryDate, s.planStatus);
      if (sub.status === 'trial') {
        onTrial++;
      } else if (sub.status === 'active') {
        paying++;
        const plan = s.planType && s.planType !== 'trial' ? SUBSCRIPTION_PLANS[s.planType] : null;
        estimatedMonthlyRevenue += plan ? Math.round(plan.monthlyRateKwacha) : 99;
      }

      if (sub.isWarningPeriod || sub.status === 'grace') {
        expiringSoon++;
      }
    });

    return {
      total,
      onTrial,
      paying,
      expiringSoon,
      estimatedMonthlyRevenue,
    };
  }, [shopList]);

  const handleExtend = async (shopId: string, days: number) => {
    const target = shopList.find((s) => s.id === shopId);
    setIsUpdating(shopId);
    try {
      await adminExtendShop(shopId, days);
      notify(`+${days} days added to ${target?.name ?? 'shop'}`, {
        kind: 'success',
        detail: 'The shop sees the new expiry immediately.',
      });
    } catch (err) {
      notify('Could not extend that plan', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUpdating(null);
    }
  };

  const handleToggleDeactivate = async (shopId: string) => {
    const target = shopList.find((s) => s.id === shopId) ?? shopToToggle;
    const willSuspend = !(target?.isDeactivated ?? false);
    setIsUpdating(shopId);
    try {
      await adminToggleDeactivate(shopId);
      notify(
        willSuspend
          ? `${target?.name ?? 'Shop'} suspended`
          : `${target?.name ?? 'Shop'} reactivated`,
        {
          kind: willSuspend ? 'info' : 'success',
          detail: willSuspend
            ? 'They can still view and export records, but cannot record new sales.'
            : 'They can record sales again right away.',
        }
      );
    } catch (err) {
      notify('Could not change that shop', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUpdating(null);
      setShopToToggle(null);
    }
  };

  const handleUpdatePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPasscode.length < 6) {
      notify('Passcode must be at least 6 characters', { kind: 'error' });
      return;
    }
    if (newPasscode !== confirmNewPasscode) {
      notify('Passcodes do not match', { kind: 'error' });
      return;
    }
    setIsChangingPasscode(true);
    try {
      await changeAdminPasscode(newPasscode);
      notify('Admin passcode updated successfully', {
        kind: 'success',
        detail: 'Use your new passcode next time you log in to the admin console.',
      });
      setNewPasscode('');
      setConfirmNewPasscode('');
      setShowPasscodeForm(false);
    } catch (err: unknown) {
      notify('Could not update passcode', {
        kind: 'error',
        detail: err instanceof Error ? err.message : 'Check your connection or sign in again.',
      });
    } finally {
      setIsChangingPasscode(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto py-4 px-3 sm:px-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200">
        <div className="flex min-w-0 items-start">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-slate-900 flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-emerald-800 shrink-0" />
              <span>Admin console</span>
            </h2>
            <p className="text-xs text-slate-500 break-all">
              Owner:{' '}
              <strong className="text-slate-800 font-mono">ronisherbwalya@gmail.com</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPasscodeForm(!showPasscodeForm)}
            className="min-h-[40px] shrink-0 text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>{showPasscodeForm ? 'Close Passcode Form' : 'Change Admin Passcode'}</span>
          </button>
          <button
            onClick={onBack}
            className="min-h-[40px] shrink-0 text-xs bg-slate-900 hover:bg-slate-950 text-white font-bold px-3 py-1.5 rounded-lg transition-colors"
          >
            {exitLabel}
          </button>
        </div>
      </div>

      {/* Owner Passcode Settings Card */}
      {showPasscodeForm && (
        <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-4 sm:p-5 shadow-xs">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="w-4 h-4 text-emerald-800" />
            <h3 className="text-sm font-extrabold text-slate-900">Change Admin Console Passcode</h3>
          </div>
          <p className="text-xs text-slate-600 mb-3">
            Set a new passcode for <strong>ronisherbwalya@gmail.com</strong>. You will use this passcode whenever opening the admin console.
          </p>

          <form onSubmit={handleUpdatePasscode} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-end">
            <div>
              <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                New Passcode (min 6 chars)
              </label>
              <input
                type="password"
                required
                value={newPasscode}
                onChange={(e) => setNewPasscode(e.target.value)}
                placeholder="New passcode"
                className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                Confirm New Passcode
              </label>
              <input
                type="password"
                required
                value={confirmNewPasscode}
                onChange={(e) => setConfirmNewPasscode(e.target.value)}
                placeholder="Confirm new passcode"
                className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isChangingPasscode}
                className="flex-1 min-h-[38px] bg-emerald-900 hover:bg-emerald-950 text-white font-bold text-xs px-4 py-2 rounded-xl transition-colors disabled:opacity-50"
              >
                {isChangingPasscode ? 'Updating…' : 'Save Passcode'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowPasscodeForm(false);
                  setNewPasscode('');
                  setConfirmNewPasscode('');
                }}
                className="min-h-[38px] bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs px-3 py-2 rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Total Shops */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Total Shops
          </span>
          <p className="text-2xl font-black text-slate-900 mt-1 tabular-nums">{stats.total}</p>
          <span className="text-xs text-slate-500">Registered kiosks</span>
        </div>

        {/* Estimated Monthly Revenue */}
        <div className="bg-emerald-900 border border-emerald-800 rounded-2xl p-4 shadow-xs text-white">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
            Est. Monthly Revenue
          </span>
          <p className="text-2xl font-black text-white mt-1 tabular-nums">
            K {stats.estimatedMonthlyRevenue.toLocaleString()}
          </p>
          <span className="text-xs text-emerald-200 font-medium">Paying subscribers</span>
        </div>

        {/* On Trial */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            On Trial
          </span>
          <p className="text-2xl font-black text-sky-700 mt-1 tabular-nums">{stats.onTrial}</p>
          <span className="text-xs text-slate-500">30-day trial period</span>
        </div>

        {/* Expiring Soon */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Plans ending soon
          </span>
          <p className="text-2xl font-black text-amber-700 mt-1 tabular-nums">
            {stats.expiringSoon}
          </p>
          <span className="text-xs text-amber-700 font-semibold">Under 5 days or in grace</span>
        </div>
      </div>

      {/* Shops Search */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3 shadow-xs">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search kiosks by name, phone or shop ID..."
            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white"
          />
        </div>
      </div>

      {/* Shops Directory */}
      <div className="space-y-3">
        {shopList.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-xs text-slate-400">
            No shops found matching your search.
          </div>
        ) : (
          shopList.map((s) => {
            const sub = getSubscriptionInfo(s.createdAt, s.planExpiryDate, s.planStatus);
            const isTargetUpdating = isUpdating === s.id;

            return (
              <div
                key={s.id}
                className={`bg-white border rounded-2xl p-4 shadow-xs transition-all ${
                  s.isDeactivated
                    ? 'border-rose-200 bg-rose-50/20 opacity-75'
                    : 'border-slate-200/90'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center space-x-2">
                      <h3 className="font-bold text-base text-slate-900 truncate">{s.name}</h3>
                      {s.isDeactivated && (
                        <span className="text-[10px] font-bold bg-rose-600 text-white px-1.5 py-0.5 rounded-md">
                          Deactivated
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Phone: <strong className="text-slate-800 font-mono">{s.ownerPhone}</strong>
                      <span className="mx-2 text-slate-300">·</span>
                      Shop ID: <span className="font-mono text-[11px] text-slate-400">{s.id}</span>
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Created: {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="text-left sm:text-right shrink-0">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                        sub.status === 'trial'
                          ? 'bg-sky-100 text-sky-800'
                          : sub.status === 'active'
                            ? 'bg-emerald-100 text-emerald-800'
                            : sub.status === 'grace'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {sub.status} ({sub.daysRemaining > 0 ? `${sub.daysRemaining}d` : 'Ended'})
                    </span>
                    <span className="text-xs text-slate-500 font-medium block mt-0.5">
                      {s.planType ? `Plan: ${s.planType}` : 'Trial Plan'}
                    </span>
                  </div>
                </div>

                {/* Admin Actions */}
                <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center space-x-2">
                    <button
                      disabled={isTargetUpdating}
                      onClick={() => handleExtend(s.id, 30)}
                      className="bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs px-3 py-1.5 rounded-lg flex items-center space-x-1.5 active:scale-95 transition-all"
                    >
                      <CalendarPlus className="w-3.5 h-3.5" />
                      <span>+30 Days</span>
                    </button>

                    <button
                      disabled={isTargetUpdating}
                      onClick={() => handleExtend(s.id, 90)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-3 py-1.5 rounded-lg active:scale-95 transition-all"
                    >
                      +90 Days
                    </button>
                  </div>

                  <button
                    disabled={isTargetUpdating}
                    onClick={() =>
                      s.isDeactivated ? handleToggleDeactivate(s.id) : setShopToToggle(s)
                    }
                    className={`font-bold text-xs px-3 py-1.5 rounded-lg flex items-center space-x-1.5 border active:scale-95 transition-all ${
                      s.isDeactivated
                        ? 'bg-emerald-800 text-white border-emerald-800'
                        : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                    }`}
                  >
                    {s.isDeactivated ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>Reactivate Shop</span>
                      </>
                    ) : (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        <span>Deactivate</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {shopToToggle && (
        <ConfirmDialog
          title={`Suspend ${shopToToggle.name}?`}
          description={
            <>
              <p>
                The shop can still open Countup, read its records and export them, but new sales
                will be locked until you reactivate it.
              </p>
              <p className="text-slate-500">Phone: {shopToToggle.ownerPhone}</p>
            </>
          }
          confirmLabel="Suspend shop"
          busy={isUpdating === shopToToggle.id}
          onCancel={() => setShopToToggle(null)}
          onConfirm={() => void handleToggleDeactivate(shopToToggle.id)}
        />
      )}
    </div>
  );
};
