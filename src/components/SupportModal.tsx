import React from 'react';
import {
  X,
  Phone,
  Mail,
  MessageSquare,
  HelpCircle,
  ExternalLink,
  ShieldCheck,
  User,
} from 'lucide-react';
import { SUPPORT_CONTACT } from '../config/support';

interface SupportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SupportModal: React.FC<SupportModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-800 to-emerald-950 text-white p-5 sm:p-6 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-emerald-900/80 hover:bg-emerald-700 flex items-center justify-center text-white transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center space-x-2.5 mb-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-700/80 border border-emerald-600/70 flex items-center justify-center">
              <HelpCircle className="w-4 h-4 text-emerald-200" />
            </div>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-200">
              Developer & Customer Support
            </span>
          </div>

          <h3 className="text-xl font-extrabold tracking-tight">Need Help or Custom Features?</h3>
          <p className="text-xs text-emerald-200/90 mt-1">
            Reach out directly to the developer for kiosk assistance, questions, or POS support.
          </p>
        </div>

        {/* Content */}
        <div className="p-5 sm:p-6 space-y-4">
          {/* Developer Card */}
          <div className="flex items-center space-x-3.5 p-3.5 bg-slate-50 border border-slate-200/80 rounded-2xl">
            <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 font-bold text-sm">
              <User className="w-5 h-5 text-emerald-700" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Developer & Lead</p>
              <h4 className="text-sm font-extrabold text-slate-900 truncate">{SUPPORT_CONTACT.name}</h4>
              <p className="text-xs text-slate-500 font-mono">CountUp Zambia</p>
            </div>
          </div>

          {/* Contact Action Buttons */}
          <div className="space-y-2.5">
            {/* WhatsApp */}
            <a
              href={SUPPORT_CONTACT.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100/70 text-emerald-950 transition-all shadow-xs group"
            >
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-emerald-900">WhatsApp Message</p>
                  <p className="text-xs text-emerald-700 font-mono truncate">{SUPPORT_CONTACT.phoneDisplay}</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 transition-transform shrink-0" />
            </a>

            {/* Direct Phone Call */}
            <a
              href={SUPPORT_CONTACT.phoneUrl ?? `tel:${SUPPORT_CONTACT.phoneDial}`}
              className="flex items-center justify-between p-3.5 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-900 transition-all shadow-xs group"
            >
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-slate-800 text-white flex items-center justify-center shrink-0 shadow-xs">
                  <Phone className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-900">Phone Call</p>
                  <p className="text-xs text-slate-600 font-mono truncate">{SUPPORT_CONTACT.phoneDisplay}</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform shrink-0" />
            </a>

            {/* Email */}
            <a
              href={SUPPORT_CONTACT.emailUrl}
              className="flex items-center justify-between p-3.5 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-900 transition-all shadow-xs group"
            >
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-sky-700 text-white flex items-center justify-center shrink-0 shadow-xs">
                  <Mail className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-900">Email Address</p>
                  <p className="text-xs text-slate-600 font-mono truncate">{SUPPORT_CONTACT.email}</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform shrink-0" />
            </a>
          </div>

          <div className="flex items-center space-x-2 text-[11px] text-slate-400 justify-center pt-2">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>Fast support for kiosks & shops in Zambia</span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button
            onClick={onClose}
            className="w-full sm:w-auto bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs px-5 py-2.5 rounded-xl transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
