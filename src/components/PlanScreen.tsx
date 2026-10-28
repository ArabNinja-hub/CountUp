import React, { useState, useEffect } from 'react';
import { useShop } from '../context/ShopContext';
import {
  CreditCard,
  ShieldCheck,
  CheckCircle2,
  Smartphone,
  Info,
  Clock,
  Lock,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  XCircle,
  HelpCircle,
  ArrowLeft,
  X,
} from 'lucide-react';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/plans';
import {
  ZAMBIAN_OPERATORS,
  detectZambianOperator,
  formatZambianPhone,
} from '../config/paymentConfig';
import { PlanBillingCycle } from '../types';

interface PlanScreenProps {
  onClose: () => void;
}

interface LipilaServerConfig {
  isConfigured: boolean;
  environment: string;
  baseUrl: string;
  walletIdConfigured: boolean;
  apiKeyConfigured: boolean;
  missingVariables: string[];
  documentationUrl: string;
}

export const PlanScreen: React.FC<PlanScreenProps> = ({ onClose }) => {
  const { shop, subscription, upgradePlan, t } = useShop();

  const [selectedPlanId, setSelectedPlanId] = useState<PlanBillingCycle>('monthly');
  const [momoPhone, setMomoPhone] = useState(shop?.ownerPhone || '');
  const [operator, setOperator] = useState<'airtel' | 'mtn' | 'zamtel'>(() => {
    return detectZambianOperator(shop?.ownerPhone || '');
  });

  // Server Lipila config status
  const [lipilaConfig, setLipilaConfig] = useState<LipilaServerConfig | null>(null);
  const [isCheckingConfig, setIsCheckingConfig] = useState(true);

  // Payment flow state
  const [isInitiating, setIsInitiating] = useState(false);
  const [activeReferenceId, setActiveReferenceId] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<'Pending' | 'Completed' | 'Failed' | null>(null);
  const [pollingMessage, setPollingMessage] = useState<string>('');
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showConfigModal, setShowConfigModal] = useState(false);

  // Fetch backend Lipila config status on mount
  useEffect(() => {
    const checkConfig = async () => {
      try {
        const res = await fetch('/api/lipila/config');
        if (res.ok) {
          const data = await res.json();
          setLipilaConfig(data);
        }
      } catch (e) {
        console.warn('Could not fetch Lipila config from server:', e);
      } finally {
        setIsCheckingConfig(false);
      }
    };
    void checkConfig();
  }, []);

  // Poll for payment verification when referenceId is active
  useEffect(() => {
    if (!activeReferenceId || pollingStatus === 'Completed' || pollingStatus === 'Failed') {
      return;
    }

    let intervalId: any;
    let pollCount = 0;
    const maxPolls = 20; // 60 seconds (every 3 seconds)

    intervalId = setInterval(async () => {
      pollCount++;
      try {
        const res = await fetch(`/api/lipila/verify/${encodeURIComponent(activeReferenceId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.verified && data.status === 'Completed') {
            clearInterval(intervalId);
            setPollingStatus('Completed');
            setPollingMessage('Payment verified successfully with Lipila!');
            await upgradePlan(selectedPlanId, momoPhone, operator);
            setPaymentSuccess(true);
            return;
          } else if (data.status === 'Failed') {
            clearInterval(intervalId);
            setPollingStatus('Failed');
            setErrorMessage('Transaction was cancelled or declined on your mobile device.');
            return;
          }
        }
      } catch (err) {
        console.warn('Verification poll error:', err);
      }

      if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        setPollingStatus('Failed');
        setErrorMessage('Verification timed out. If money was deducted, the webhook will update your shop automatically.');
      }
    }, 3000);

    return () => clearInterval(intervalId);
  }, [activeReferenceId, pollingStatus, selectedPlanId, momoPhone, operator, upgradePlan]);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMomoPhone(val);
    setOperator(detectZambianOperator(val));
  };

  const selectedPlan = SUBSCRIPTION_PLANS[selectedPlanId];
  const activeOperatorObj = ZAMBIAN_OPERATORS.find((o) => o.id === operator) || ZAMBIAN_OPERATORS[0];

  // Initiate real server-side payment through Lipila API
  const handleInitiatePayment = async () => {
    if (!momoPhone.trim()) {
      alert('Please enter your Zambian Mobile Money phone number');
      return;
    }

    setErrorMessage(null);
    setIsInitiating(true);

    try {
      const response = await fetch('/api/lipila/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop?.id || 'demo_shop',
          planId: selectedPlanId,
          phone: momoPhone,
          operator,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setIsInitiating(false);
        if (data.error === 'CONFIGURATION_REQUIRED') {
          setShowConfigModal(true);
        } else {
          setErrorMessage(data.message || 'Could not initiate collection with Lipila.');
        }
        return;
      }

      // Successful initiation from backend
      setActiveReferenceId(data.referenceId);
      setPollingStatus('Pending');
      setPollingMessage(data.message || 'USSD prompt dispatched. Please check your phone.');
      setIsInitiating(false);
    } catch (e) {
      setIsInitiating(false);
      setErrorMessage(e instanceof Error ? e.message : 'Network error initiating Lipila payment');
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto py-4 px-3 sm:px-6 space-y-4">
      {/* Title & Close Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-200">
        <div className="flex items-center space-x-2.5">
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 flex items-center space-x-2">
              <CreditCard className="w-5 h-5 text-emerald-800" />
              <span>{t.planTitle}</span>
            </h2>
            <p className="text-xs text-slate-500">
              Countup subscription &amp; Zambian Mobile Money billing
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="text-xs text-slate-600 font-bold hover:text-slate-900 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 transition-colors"
        >
          {t.close}
        </button>
      </div>

      {/* Lipila Sandbox Credentials Status Banner */}
      {!isCheckingConfig && lipilaConfig && !lipilaConfig.isConfigured && (
        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-950 shadow-xs">
          <div className="flex items-start justify-between">
            <div className="flex items-start space-x-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-amber-950">
                  Lipila Sandbox Credentials (Ready to configure)
                </p>
                <p className="text-[11px] text-amber-800 mt-0.5">
                  Environment: <span className="font-bold font-mono">Sandbox (api.lipila.dev)</span>
                </p>
                <p className="text-[10px] text-amber-700 mt-0.5">
                  Add <span className="font-mono font-bold">{lipilaConfig.missingVariables.join(', ')}</span> to .env when ready.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowConfigModal(true)}
              className="text-xs text-amber-900 font-bold underline shrink-0 ml-2"
            >
              Setup Guide
            </button>
          </div>
        </div>
      )}

      {/* Current Subscription Status Card */}
      <div
        className={`rounded-2xl p-4 sm:p-5 border shadow-xs ${
          subscription.status === 'expired'
            ? 'bg-rose-50 border-rose-200 text-rose-950'
            : subscription.status === 'grace'
            ? 'bg-amber-50 border-amber-200 text-amber-950'
            : subscription.isWarningPeriod
            ? 'bg-amber-50/70 border-amber-200 text-amber-950'
            : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
        }`}
      >
        <div className="flex items-start justify-between">
          <div>
            <span
              className={`inline-block px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider ${
                subscription.status === 'trial'
                  ? 'bg-emerald-200 text-emerald-900'
                  : subscription.status === 'active'
                  ? 'bg-emerald-800 text-white'
                  : subscription.status === 'grace'
                  ? 'bg-amber-600 text-white'
                  : 'bg-rose-700 text-white'
              }`}
            >
              {subscription.status === 'trial'
                ? t.trialBadge
                : subscription.status === 'active'
                ? 'Active Subscription'
                : subscription.status === 'grace'
                ? 'Grace Period'
                : t.planExpired}
            </span>

            <h3 className="font-black text-slate-900 text-lg mt-2 tracking-tight">
              {subscription.daysRemaining > 0
                ? `${subscription.daysRemaining} ${t.daysRemaining}`
                : subscription.status === 'grace'
                ? `${subscription.graceDaysRemaining} days remaining in grace period`
                : t.planExpired}
            </h3>

            <p className="text-xs text-slate-600 mt-1 max-w-xl">
              {subscription.status === 'trial'
                ? 'Every new Zambian kiosk starts with 30 days of full access. After trial, subscribe to continue recording sales.'
                : subscription.status === 'grace'
                ? `You have a ${GRACE_PERIOD_DAYS}-day grace period to renew before new sales are locked.`
                : subscription.status === 'expired'
                ? t.planExpiredNotice
                : 'Your shop is fully unlocked for sales.'}
            </p>
          </div>

          <div className="w-10 h-10 rounded-xl bg-white shadow-xs flex items-center justify-center shrink-0">
            {subscription.status === 'expired' ? (
              <Lock className="w-5 h-5 text-rose-600" />
            ) : subscription.status === 'grace' || subscription.isWarningPeriod ? (
              <Clock className="w-5 h-5 text-amber-600" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-700" />
            )}
          </div>
        </div>

        {/* Guarantee: Existing data is always safe */}
        <div className="mt-3 pt-3 border-t border-slate-200/60 flex items-center space-x-1.5 text-xs text-slate-600">
          <Info className="w-4 h-4 text-emerald-800 shrink-0" />
          <span>{t.existingDataSafe}</span>
        </div>
      </div>

      {/* Error Message Notice */}
      {errorMessage && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900 flex items-start space-x-2">
          <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold">Payment Status</p>
            <p className="text-[11px] text-rose-800 mt-0.5">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      )}

      {/* Payment Success View (Only shown after verified by Lipila backend) */}
      {paymentSuccess ? (
        <div className="bg-white border-2 border-emerald-500 rounded-3xl p-8 text-center shadow-md my-4 animate-in zoom-in-95 max-w-md mx-auto">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <h3 className="text-xl font-black text-slate-900">{t.testPaymentSuccess}</h3>
          <p className="text-xs text-slate-500 mt-1 mb-2">
            Payment verified with Lipila. Your {selectedPlan.name} plan is now active.
          </p>
          <p className="text-xs text-emerald-900 font-mono mb-4">
            Ref: {activeReferenceId}
          </p>
          <button
            onClick={() => {
              setPaymentSuccess(false);
              setActiveReferenceId(null);
              setPollingStatus(null);
              onClose();
            }}
            className="w-full bg-emerald-800 text-white font-bold text-sm py-3 px-4 rounded-xl shadow-xs cursor-pointer"
          >
            Back to Sales
          </button>
        </div>
      ) : activeReferenceId && pollingStatus === 'Pending' ? (
        /* Real-time Awaiting Authorization Dialog */
        <div className="bg-white border-2 border-sky-500 rounded-3xl p-8 text-center shadow-md my-4 animate-in zoom-in-95 max-w-md mx-auto">
          <div className="w-14 h-14 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center mx-auto mb-3 animate-spin">
            <RefreshCw className="w-7 h-7" />
          </div>
          <h3 className="font-black text-base text-slate-900">
            Awaiting Mobile Money Authorization
          </h3>
          <p className="text-xs text-slate-600 mt-1">
            Prompt sent to <strong className="text-slate-900 font-mono">{momoPhone}</strong> ({activeOperatorObj.name}).
          </p>
          <div className="my-3 p-3 bg-slate-50 rounded-xl text-left text-xs font-mono space-y-1 text-slate-700 border border-slate-200">
            <p className="font-bold text-slate-900">Transaction Status: PENDING</p>
            <p>Reference: {activeReferenceId}</p>
            <p>Amount: K {selectedPlan.priceKwacha}</p>
            <p className="text-emerald-800 font-bold">
              Dial {activeOperatorObj.ussdPromptCode} if prompt did not appear automatically.
            </p>
          </div>
          <p className="text-[11px] text-slate-400 italic mb-4">
            Checking status with Lipila server...
          </p>
          <button
            onClick={() => {
              setActiveReferenceId(null);
              setPollingStatus(null);
            }}
            className="text-xs text-slate-500 hover:text-slate-800 underline"
          >
            Cancel / Try Again
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Plan Selection Cards */}
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-2">
              {t.selectPlan}
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(Object.keys(SUBSCRIPTION_PLANS) as PlanBillingCycle[]).map((key) => {
                const plan = SUBSCRIPTION_PLANS[key];
                const isSelected = selectedPlanId === key;

                return (
                  <div
                    key={key}
                    onClick={() => setSelectedPlanId(key)}
                    className={`p-4 rounded-2xl border-2 transition-all cursor-pointer flex flex-col justify-between ${
                      isSelected
                        ? 'border-emerald-800 bg-emerald-50/60 shadow-xs ring-1 ring-emerald-800'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-black text-sm text-slate-900">
                          {plan.name}
                        </span>
                        {plan.discountBadge && (
                          <span className="text-[10px] font-bold bg-amber-500 text-slate-950 px-2 py-0.5 rounded-md">
                            {plan.discountBadge}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 leading-snug">{plan.description}</p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100 flex items-baseline justify-between">
                      <span className="text-2xl font-black text-emerald-900 tracking-tight tabular-nums">
                        K {plan.priceKwacha}
                      </span>
                      {plan.months > 1 && (
                        <span className="text-[11px] text-slate-400 font-medium">
                          ~K {Math.round(plan.monthlyRateKwacha)}/mo
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Zambian Mobile Money Checkout Step */}
          <div className="bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <h4 className="font-bold text-xs text-slate-800 uppercase tracking-wider mb-3 flex items-center space-x-1.5">
              <Smartphone className="w-4 h-4 text-emerald-800" />
              <span>Zambian Mobile Money (Lipila API Integration)</span>
            </h4>

            {/* Operator Selector (Airtel, MTN, Zamtel) */}
            <div className="grid grid-cols-3 gap-2.5 mb-3.5">
              {ZAMBIAN_OPERATORS.map((op) => {
                const isSelected = operator === op.id;
                return (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => setOperator(op.id)}
                    className={`min-h-[48px] py-2 px-2 rounded-xl text-xs font-bold transition-all border flex flex-col items-center justify-center ${
                      isSelected
                        ? 'border-emerald-800 bg-emerald-50 text-emerald-950 ring-1 ring-emerald-800 shadow-xs'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="text-xs font-bold">{op.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono mt-0.5">
                      {op.ussdPromptCode}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Phone input */}
            <div className="mb-4">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {t.enterMomoNumber} ({activeOperatorObj.name}) *
              </label>
              <input
                type="tel"
                value={momoPhone}
                onChange={handlePhoneChange}
                placeholder="e.g. 0977 123 456"
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:bg-white font-mono"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Prompt will be dispatched to your phone (or dial{' '}
                <span className="font-bold text-emerald-800">{activeOperatorObj.ussdPromptCode}</span>).
              </p>
            </div>

            {/* Pay Now Button */}
            <button
              onClick={handleInitiatePayment}
              disabled={isInitiating}
              className="w-full min-h-[48px] bg-emerald-800 hover:bg-emerald-900 active:scale-[0.99] text-white py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-between shadow-xs cursor-pointer disabled:opacity-50 transition-all"
            >
              <span>{isInitiating ? 'Calling Lipila API...' : t.payNow}</span>
              <div className="flex items-center space-x-1.5 bg-emerald-900/80 px-2.5 py-1 rounded-lg">
                <span className="text-emerald-200 text-xs font-normal">Total:</span>
                <span className="text-base font-black tabular-nums">K {selectedPlan.priceKwacha}</span>
              </div>
            </button>
          </div>

          {/* Configuration Requirements Guide */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 font-bold text-slate-800">
                <Info className="w-4 h-4 text-emerald-800" />
                <span>Lipila Integration Architecture</span>
              </div>
              <button
                onClick={() => setShowConfigModal(true)}
                className="text-xs text-emerald-800 font-bold underline"
              >
                View Setup
              </button>
            </div>
            <p className="text-[11px] leading-relaxed">
              Lipila API collections are handled via server-side endpoints with verification polling and webhook callbacks. Subscriptions are activated only after backend verification.
            </p>
            <div className="flex items-center space-x-2 text-[10px]">
              <span className="px-2 py-0.5 rounded-md bg-slate-200 font-mono text-slate-700 font-semibold">
                Mode: {lipilaConfig?.environment || 'sandbox'}
              </span>
              <a
                href="https://docs.lipila.io"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-800 font-bold flex items-center space-x-0.5 hover:underline"
              >
                <span>docs.lipila.io</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Configuration Required Modal Dialog */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center">
                  <HelpCircle className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900">
                    Lipila Sandbox Setup
                  </h3>
                  <p className="text-[10px] text-slate-500">Configure Sandbox Credentials</p>
                </div>
              </div>
              <button
                onClick={() => setShowConfigModal(false)}
                className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-700 space-y-3">
              <p className="text-slate-600 leading-relaxed">
                Before real or sandbox payments can be dispatched, add your credentials from the{' '}
                <a
                  href="https://docs.lipila.io"
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-800 font-bold underline"
                >
                  Lipila Developer Portal
                </a>{' '}
                to your environment variables:
              </p>

              <div className="bg-slate-900 text-slate-100 p-3.5 rounded-xl font-mono text-[10px] space-y-1">
                <p className="text-emerald-400"># In your .env file:</p>
                <p>LIPILA_ENVIRONMENT="sandbox"</p>
                <p>LIPILA_API_KEY="lsk_YOUR_SANDBOX_KEY"</p>
                <p>LIPILA_WALLET_ID="YOUR_MERCHANT_WALLET_ID"</p>
              </div>

              <div className="space-y-1.5 text-[11px] text-slate-600">
                <p className="font-bold text-slate-800">Verified backend endpoints:</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><code className="text-slate-800 font-mono">POST /api/lipila/initiate</code> (Server-side collection)</li>
                  <li><code className="text-slate-800 font-mono">GET /api/lipila/verify/:ref</code> (Status verification)</li>
                  <li><code className="text-slate-800 font-mono">POST /api/lipila/webhook</code> (Lipila webhook listener)</li>
                </ul>
              </div>

              <button
                onClick={() => setShowConfigModal(false)}
                className="w-full mt-2 bg-slate-900 hover:bg-slate-950 text-white font-bold py-2.5 rounded-xl text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
