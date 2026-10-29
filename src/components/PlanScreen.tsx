import React, { useState } from 'react';
import { useShop } from '../context/ShopContext';
import {
  CreditCard,
  ShieldCheck,
  Smartphone,
  Info,
  Clock,
  Lock,
  ArrowLeft,
  X,
  MessageSquare,
  Phone,
  Mail,
} from 'lucide-react';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/plans';
import { SUPPORT_CONTACT } from '../config/support';
import { PlanBillingCycle } from '../types';

interface PlanScreenProps {
  onClose: () => void;
}

export const PlanScreen: React.FC<PlanScreenProps> = ({ onClose }) => {
  const { shop, subscription, t } = useShop();

  const [selectedPlanId, setSelectedPlanId] = useState<PlanBillingCycle>('monthly');
  const [showContactModal, setShowContactModal] = useState(false);
  const [contactMethod, setContactMethod] = useState<'whatsapp' | 'phone' | 'email'>('whatsapp');

  const selectedPlan = SUBSCRIPTION_PLANS[selectedPlanId];

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
            <p className="text-xs text-slate-500">Countup subscription plans for Zambian kiosks</p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="text-xs text-slate-600 font-bold hover:text-slate-900 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 transition-colors"
        >
          {t.close}
        </button>
      </div>

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
                    <span className="font-black text-sm text-slate-900">{plan.name}</span>
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

      {/* Contact for Payment - Since we're on static hosting, show contact options */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
        <h4 className="font-bold text-xs text-slate-800 uppercase tracking-wider mb-3 flex items-center space-x-1.5">
          <Smartphone className="w-4 h-4 text-emerald-800" />
          <span>Subscribe Now</span>
        </h4>

        <p className="text-xs text-slate-600 mb-4">
          To activate your {selectedPlan.name} plan (K {selectedPlan.priceKwacha}), please contact
          us via one of the methods below. We'll send you a Mobile Money prompt (Airtel/MTN/Zamtel)
          or provide bank details.
        </p>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <button
            onClick={() => {
              setContactMethod('whatsapp');
              setShowContactModal(true);
            }}
            className="min-h-[48px] py-3 px-2 rounded-xl text-xs font-bold transition-all border flex flex-col items-center justify-center bg-green-50 border-green-200 text-green-800 hover:bg-green-100"
          >
            <MessageSquare className="w-5 h-5 mb-1" />
            <span className="font-bold">WhatsApp</span>
            <span className="text-[10px] font-mono">{SUPPORT_CONTACT.phoneDisplay}</span>
          </button>

          <button
            onClick={() => {
              setContactMethod('phone');
              setShowContactModal(true);
            }}
            className="min-h-[48px] py-3 px-2 rounded-xl text-xs font-bold transition-all border flex flex-col items-center justify-center bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100"
          >
            <Phone className="w-5 h-5 mb-1" />
            <span className="font-bold">Call / SMS</span>
            <span className="text-[10px] font-mono">{SUPPORT_CONTACT.phoneDisplay}</span>
          </button>

          <button
            onClick={() => {
              setContactMethod('email');
              setShowContactModal(true);
            }}
            className="min-h-[48px] py-3 px-2 rounded-xl text-xs font-bold transition-all border flex flex-col items-center justify-center bg-purple-50 border-purple-200 text-purple-800 hover:bg-purple-100"
          >
            <Mail className="w-5 h-5 mb-1" />
            <span className="font-bold">Email</span>
            <span className="text-[10px] font-mono">{SUPPORT_CONTACT.paymentsEmail}</span>
          </button>
        </div>

        {/* Payment happens out-of-band: no gateway is wired into the static build,
            so the app must not print USSD codes it cannot verify. */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-600 space-y-1.5">
          <p className="font-bold text-slate-800">How activation works</p>
          <ol className="list-decimal pl-4 space-y-1 text-[11px] leading-relaxed">
            <li>Contact us using one of the buttons above.</li>
            <li>
              We send you a Mobile Money request, or the payment details for Airtel, MTN or Zamtel.
            </li>
            <li>
              Once the payment shows, we activate your plan — the days remaining at the top of this
              screen update immediately.
            </li>
          </ol>
          <p className="text-[10px] text-slate-500">
            Quote this shop ID so we credit the right shop:{' '}
            <code className="font-mono bg-slate-200 px-1 rounded">
              {shop?.id || 'your-shop-id'}
            </code>
          </p>
        </div>
      </div>

      {/* What's Included */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-xs text-emerald-900 space-y-2">
        <div className="flex items-center space-x-1.5 font-bold">
          <ShieldCheck className="w-4 h-4" />
          <span>What's included in every plan:</span>
        </div>
        <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
          <li>Unlimited sales recording (offline-first)</li>
          <li>Stock management with profit tracking</li>
          <li>Credit book (Mangawa/Amakongole) with WhatsApp reminders</li>
          <li>Expense tracking & profit reports</li>
          <li>Data export (CSV/JSON) anytime</li>
          <li>Multi-language: English, Bemba, Nyanja</li>
          <li>Auto-sync when online, works fully offline</li>
          <li>No hidden fees, cancel anytime</li>
        </ul>
      </div>

      {/* Contact Modal */}
      {showContactModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200 animate-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                    contactMethod === 'whatsapp'
                      ? 'bg-green-100 text-green-800'
                      : contactMethod === 'phone'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-purple-100 text-purple-800'
                  }`}
                >
                  {contactMethod === 'whatsapp' && <MessageSquare className="w-4 h-4" />}
                  {contactMethod === 'phone' && <Phone className="w-4 h-4" />}
                  {contactMethod === 'email' && <Mail className="w-4 h-4" />}
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900">
                    {contactMethod === 'whatsapp'
                      ? 'WhatsApp Us'
                      : contactMethod === 'phone'
                        ? 'Call / SMS'
                        : 'Email Us'}
                  </h3>
                  <p className="text-[10px] text-slate-500">
                    {contactMethod === 'whatsapp' && SUPPORT_CONTACT.phoneDisplay}
                    {contactMethod === 'phone' && SUPPORT_CONTACT.phoneDisplay}
                    {contactMethod === 'email' && SUPPORT_CONTACT.paymentsEmail}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowContactModal(false)}
                className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-700 space-y-3">
              <p className="text-slate-600 leading-relaxed">
                Ready to subscribe to{' '}
                <strong className="text-emerald-800">{selectedPlan.name}</strong> (K{' '}
                {selectedPlan.priceKwacha})? Contact us and we'll send a Mobile Money prompt or
                provide payment details.
              </p>

              <div className="bg-slate-50 p-3 rounded-xl space-y-2">
                <p className="font-bold text-slate-800 text-[11px]">Tell us:</p>
                <ul className="list-disc pl-4 space-y-1 text-[11px] text-slate-600">
                  <li>Your shop name</li>
                  <li>Your phone number (for Mobile Money prompt)</li>
                  <li>Preferred operator: Airtel / MTN / Zamtel</li>
                  <li>
                    Reference: <code className="font-mono bg-white px-1 rounded">{shop?.id}</code>
                  </li>
                </ul>
              </div>

              {contactMethod === 'whatsapp' && (
                <a
                  href={`https://wa.me/${SUPPORT_CONTACT.whatsapp}?text=${encodeURIComponent(`Hi Countup, I want to subscribe my shop "${shop?.name}" (${shop?.id}) to the ${selectedPlan.name} plan for K${selectedPlan.priceKwacha}. My phone is ${shop?.ownerPhone}. Please send Mobile Money prompt.`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full flex items-center justify-center space-x-2 bg-green-600 hover:bg-green-700 text-white font-bold py-2.5 rounded-xl text-xs"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Open WhatsApp with Pre-filled Message</span>
                </a>
              )}

              {contactMethod === 'phone' && (
                <a
                  href={`tel:${SUPPORT_CONTACT.phoneDial}`}
                  className="w-full flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-xl text-xs"
                >
                  <Phone className="w-4 h-4" />
                  <span>Call Now</span>
                </a>
              )}

              {contactMethod === 'email' && (
                <a
                  href={`mailto:${SUPPORT_CONTACT.paymentsEmail}?subject=${encodeURIComponent(`Subscription: ${shop?.name} - ${selectedPlan.name}`)}&body=${encodeURIComponent(`Hi Countup Team,\n\nI want to subscribe my shop "${shop?.name}" (ID: ${shop?.id}) to the ${selectedPlan.name} plan for K${selectedPlan.priceKwacha}.\n\nMy phone: ${shop?.ownerPhone}\nPreferred operator: Airtel/MTN/Zamtel\n\nPlease send Mobile Money prompt or provide payment details.\n\nThanks!`)}`}
                  className="w-full flex items-center justify-center space-x-2 bg-purple-600 hover:bg-purple-700 text-white font-bold py-2.5 rounded-xl text-xs"
                >
                  <Mail className="w-4 h-4" />
                  <span>Open Email with Pre-filled Details</span>
                </a>
              )}

              <button
                onClick={() => setShowContactModal(false)}
                className="w-full mt-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs"
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
