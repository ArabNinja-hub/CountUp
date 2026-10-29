import React from 'react';
import { useShop } from '../context/ShopContext';
import {
  ShieldCheck,
  CheckCircle2,
  ArrowLeft,
  Sparkles,
  ShoppingBag,
  Boxes,
  BookUser,
  BarChart3,
  Wifi,
  Store,
} from 'lucide-react';

interface PlanScreenProps {
  onClose: () => void;
}

export const PlanScreen: React.FC<PlanScreenProps> = ({ onClose }) => {
  const { shop, t } = useShop();

  const features = [
    {
      title: 'Unlimited Items & Stock Tracking',
      desc: 'Add as many products as you want with low-stock alerts and instant restock buttons.',
      icon: Boxes,
    },
    {
      title: 'Fast Kiosk Sales',
      desc: 'Record sales in seconds with cash, Airtel Money, MTN MoMo, or Zamtel Kwacha.',
      icon: ShoppingBag,
    },
    {
      title: 'Customer Credit Book (Mangongole)',
      desc: 'Track who owes you, record partial payments, and see total debt at a glance.',
      icon: BookUser,
    },
    {
      title: 'Profit & Loss Reports',
      desc: 'Real-time sales summaries, expenses, top-selling items, and profit margin analytics.',
      icon: BarChart3,
    },
    {
      title: '100% Offline Capability & Cloud Sync',
      desc: 'Keep selling even when your network drops; data safely syncs whenever internet returns.',
      icon: Wifi,
    },
  ];

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-10">
      {/* Back button */}
      <div className="mb-6">
        <button
          onClick={onClose}
          className="inline-flex items-center space-x-2 text-xs font-semibold text-slate-600 hover:text-emerald-800 transition-colors cursor-pointer bg-white border border-slate-200 px-3.5 py-2 rounded-xl shadow-xs"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to POS</span>
        </button>
      </div>

      {/* Main License Card */}
      <div className="bg-white rounded-3xl border border-slate-200/90 shadow-sm overflow-hidden mb-6">
        {/* Header Banner */}
        <div className="bg-gradient-to-r from-emerald-800 to-emerald-950 text-white p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-700/80 text-emerald-100 border border-emerald-600/60 mb-3">
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                <span>Full Free Access Enabled</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Countup Smart POS
              </h1>
              <p className="text-emerald-200 text-xs sm:text-sm mt-1">
                Your shop is fully unlocked with no subscription fees or payments required.
              </p>
            </div>

            <div className="shrink-0 bg-emerald-900/80 border border-emerald-700/60 rounded-2xl p-4 text-center sm:text-right">
              <span className="block text-[11px] uppercase font-bold text-emerald-300 tracking-wider">
                Plan Status
              </span>
              <span className="text-xl font-black text-white flex items-center justify-center sm:justify-end space-x-1.5 mt-0.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span>Free & Active</span>
              </span>
              <span className="text-[11px] text-emerald-200">Unlimited Lifetime Access</span>
            </div>
          </div>
        </div>

        {/* Shop Details */}
        <div className="p-6 sm:p-8 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center space-x-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <Store className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900 text-base">{shop?.name || 'My Kiosk'}</h2>
              <p className="text-xs text-slate-500 font-mono">
                Phone: {shop?.ownerPhone} · Currency: {shop?.currency || 'ZMW'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                Subscription Fee
              </span>
              <span className="text-sm font-extrabold text-emerald-700">K 0.00 (Free)</span>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                Stock Limit
              </span>
              <span className="text-sm font-extrabold text-slate-900">Unlimited Products</span>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3 col-span-2 sm:col-span-1">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                Sales Limit
              </span>
              <span className="text-sm font-extrabold text-slate-900">Unlimited Transactions</span>
            </div>
          </div>
        </div>

        {/* Included Features List */}
        <div className="p-6 sm:p-8">
          <h3 className="font-bold text-slate-900 text-sm mb-4 uppercase tracking-wider text-[11px] text-slate-400">
            Everything Included With Your Account
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {features.map((feat, idx) => {
              const Icon = feat.icon;
              return (
                <div
                  key={idx}
                  className="flex items-start space-x-3 p-3.5 rounded-xl border border-slate-200 bg-white hover:border-emerald-300 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900">{feat.title}</h4>
                    <p className="text-[11px] text-slate-500 leading-snug mt-0.5">{feat.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Developer & Support Contact Banner */}
        <div className="p-6 sm:p-8 bg-emerald-50/60 border-t border-slate-200">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider block">
                Direct Developer & POS Support
              </span>
              <h4 className="text-sm font-extrabold text-slate-900 mt-0.5">
                Ronisher Bwalya
              </h4>
              <p className="text-xs text-slate-600 mt-0.5">
                Available for kiosk onboarding, feature requests, or POS questions across Zambia.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <a
                href="https://wa.me/260962838581?text=Hello%20Ronisher,%20I%20need%20assistance%20with%20CountUp%20POS"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center space-x-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold px-3 py-2 rounded-xl shadow-xs transition-colors"
              >
                <span>WhatsApp (+260 96 283 8581)</span>
              </a>

              <a
                href="tel:+260962838581"
                className="inline-flex items-center space-x-1.5 bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-bold px-3 py-2 rounded-xl shadow-xs transition-colors"
              >
                <span>Call</span>
              </a>

              <a
                href="mailto:ronisherbwalya@gmail.com?subject=CountUp%20Smart%20POS%20Support"
                className="inline-flex items-center space-x-1.5 bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-bold px-3 py-2 rounded-xl shadow-xs transition-colors"
              >
                <span>Email</span>
              </a>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-6 sm:p-8 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-2 text-xs text-slate-600">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>All features unlocked without payment requirements</span>
          </div>

          <button
            onClick={onClose}
            className="w-full sm:w-auto bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            Back to POS
          </button>
        </div>
      </div>
    </div>
  );
};
