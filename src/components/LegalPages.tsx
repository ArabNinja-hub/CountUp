import React, { useState } from 'react';
import {
  X,
  Shield,
  Lock,
  User,
  Globe,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

type LegalDocType = 'privacy' | 'terms' | 'security';

interface LegalPageProps {
  onClose: () => void;
  initialDoc?: LegalDocType;
}

/** A section is either a plain paragraph or an icon-led bullet. */
type LegalItem = string | { icon: React.ComponentType<{ className?: string }>; text: string };

interface LegalDoc {
  title: string;
  lastUpdated: string;
  sections: { title: string; content: LegalItem[] }[];
}

const legalContent: Record<LegalDocType, LegalDoc> = {
  privacy: {
    title: 'Privacy Policy',
    lastUpdated: 'November 20, 2026',
    sections: [
      {
        title: 'Information We Collect & Store',
        content: [
          'Shop & Account Information: Your shop/kiosk name and verified Zambian mobile number (+260) used for SMS one-time verification and account recovery.',
          'Authentication Credentials (Hashed Only): Your 4-digit shop PIN and one-time recovery code are hashed with salted and peppered PBKDF2-HMAC-SHA256 (210,000 server iterations). Neither CountUp nor platform administrators can read your PIN or recovery code.',
          'Sales, Stock, Credit & Expense Records: Product names, integer ngwee buying/selling prices, stock quantities and movements, sales receipts, payment types (cash, Mobile Money, credit), optional customer credit book entries (names, phone numbers, balances, repayments), and business expenses.',
          'Subscription Payment Submissions: When you submit a manual Mobile Money renewal, we store the selected plan, operator (MTN or Airtel), transaction reference, payer phone number, payment date, and review outcome. CountUp never asks for or stores your Mobile Money PIN.',
          'Abuse-Prevention & Audit Metadata: Salted SHA-256 hashes of phone numbers and IP addresses for SMS rate limiting, salted SHA-256 trial-eligibility hashes, session verification records, and administrative audit logs.',
        ],
      },
      {
        title: 'How We Use Your Data',
        content: [
          'Operate Your Shop Book: Record sales offline and online, track stock and profit in Zambian Kwacha, manage customer credit balances, and generate reports.',
          'Multi-Device Sync & New-Phone Sign-In: Sync queued offline entries to your shop database and let you sign in on a replacement phone after verifying both an SMS code and your 4-digit shop PIN (or recovery code).',
          'Account Security & Anti-Takeover Alerts: Detect SIM-swap attempts, enforce brute-force lockouts, send 72-hour PIN-reset warning SMS notices, and display security alerts on your active shop device.',
          'Subscription Verification & Legal Compliance: Verify manual subscription transfers, prevent duplicate reference reuse, and comply with applicable laws of the Republic of Zambia.',
        ],
      },
      {
        title: 'Infrastructure & Third-Party Processors',
        content: [
          'Supabase (Database, Authentication, Realtime & Edge Functions): Stores your PostgreSQL shop records, enforces Row-Level Security (RLS) per verified shop session, runs server-side Edge Functions, and delivers live sync wake-ups over TLS/WSS.',
          'Cloudflare (Hosting, CDN, WAF & Turnstile): Serves the CountUp web application through Cloudflare Pages, protects against DDoS and automated abuse, and verifies sign-in requests with Cloudflare Turnstile without tracking you across third-party ad networks.',
          'SMS Gateway Provider (Africa’s Talking, Twilio, or configured Zambian SMS gateway): Delivers 6-digit one-time sign-in codes and urgent account-security SMS warnings to your +260 phone number.',
          'Google Fonts: Serves the Plus Jakarta Sans and JetBrains Mono typefaces when online.',
          'WhatsApp (Optional User Action): Only opens on your device when you tap "Send Reminder" for a credit customer; CountUp never accesses your WhatsApp contacts or messages.',
        ],
      },
      {
        title: 'Data Storage, Retention & Deletion',
        content: [
          'Active & Expired Shops: Your shop records are retained while your shop exists. If your trial or paid plan expires (after the 3-day grace period), new sales recording pauses, while your existing records remain read-only and exportable so you never lose your books while renewing.',
          'Immediate Self-Service Deletion: Opening Settings → Account & Access → Delete Shop (confirmed with your shop name and 4-digit PIN) immediately and permanently deletes your shop, items, sales, credit book, expenses, stock movements, and authentication sessions from Supabase, and clears local device storage.',
          'What Remains After Deletion: To prevent repeated free-trial abuse and preserve financial audit integrity, only a non-reversible salted/peppered SHA-256 hash of the trial phone number (`used_trial_phones`, containing zero raw phone numbers) and minimal non-ledger audit metadata are retained.',
          'Backups: Export a JSON or CSV copy regularly from Settings → Data & Backups. Once you delete a shop, deleted shop records cannot be recovered.',
        ],
      },
      {
        title: 'Your Rights (Zambia Data Protection Act No. 3 of 2021)',
        content: [
          'Access & Portability: Export your full shop history as JSON or CSV anytime from Settings → Data & Backups or Reports, and restore supported backups into CountUp.',
          'Correction: Edit products, customer details, expenses, or void eligible same-day sales directly in the app.',
          'Erasure: Permanently delete your shop and its records at any time from Settings → Account & Access → Delete Shop.',
          'Session Control: Revoke access on any other signed-in phone immediately via Settings → Account & Access → Sign Out All Other Devices.',
        ],
      },
      {
        title: "Children's Privacy & Contact",
        content: [
          'CountUp is intended for business use by adults (18+) and does not knowingly collect personal data from minors.',
          'For assistance, open the in-app Help guide. CountUp complies with the Zambia Data Protection Act No. 3 of 2021.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of Service',
    lastUpdated: 'November 20, 2026',
    sections: [
      {
        title: 'Acceptance of Terms',
        content: [
          'By registering a shop or using CountUp, you agree to these Terms of Service.',
          'If you do not agree, do not use the service. We may update these Terms and show the revised date at the top of this page.',
        ],
      },
      {
        title: 'Service Description',
        content: [
          'CountUp is an offline-first mobile sales book, stock manager, and customer credit tracker built in Zambian Kwacha (ZMW) for kiosks, market stalls, and small shops.',
          'Core features include offline sales queuing with automatic background sync, stock tracking and recount conflict handling, customer credit ledger, expense tracking, JSON/CSV backup and restore, and manual Mobile Money subscription management.',
          'The service is provided "as is" and "as available" without warranties of uninterrupted availability.',
        ],
      },
      {
        title: 'Account Security & Your Responsibilities',
        content: [
          'Accurate Details & Secret PIN: Register with your own active +260 phone number, keep your 4-digit shop PIN confidential, and store your one-time recovery code (`CU-XXXX-XXXX-XXXX`) safely offline.',
          'Pending Offline Entries: Entries recorded offline stay in your device browser until synced. Do not clear browser storage or uninstall the app while the pending sync counter is above zero.',
          'Lawful Business Use: Use CountUp only for lawful commerce. You remain solely responsible for your pricing, customer credit agreements, and ZRA or local council tax obligations.',
          'Lost PIN & Recovery Code: If both your PIN and recovery code are lost, support-initiated PIN resets enforce a mandatory 72-hour security waiting period and SMS warning to protect against SIM-swap fraud.',
        ],
      },
      {
        title: 'Subscriptions, Grace Period & Payments',
        content: [
          'Free Trial: Eligible first-time phone numbers receive a 30-day free trial. Deleting and re-registering with a previously used phone number does not grant a second free trial.',
          'Paid Plans (Zambian Kwacha): 1 Month (K99), 3 Months (K269), or 6 Months (K499). Plans do not auto-renew.',
          'Manual Mobile Money Verification: Renewals are paid manually to the Airtel Money or MTN Mobile Money details shown on the Plan screen, followed by submitting the operator transaction reference in CountUp. Submitting a reference sets status to pending until an administrator independently verifies the transfer and approves it.',
          '3-Day Grace Period & Offline Window: Every trial and paid plan includes 3 extra days of sales access after expiry so you can renew without interruption. Offline sales recorded within the bounded 72-hour sync window sync normally; sales synced more than 72 hours late on an active or grace plan are kept and marked as synced late, while expired shops reject backdated sales.',
          'Refunds: Fees for activated subscription periods are non-refundable. Your existing data remains viewable and exportable even when a plan is expired.',
        ],
      },
      {
        title: 'Ownership, Suspension & Termination',
        content: [
          'Your Data: You own all business records (products, sales, customer credit, and expenses) you enter into CountUp.',
          'Self-Service Deletion: You may permanently delete your shop at any time in Settings → Account & Access → Delete Shop.',
          'Suspension for Abuse: We may suspend sales access for fraudulent payment references, platform abuse, or unlawful activity. Suspended shops retain read/export access unless deleted for legal compliance.',
        ],
      },
      {
        title: 'Limitation of Liability & Governing Law',
        content: [
          'CountUp calculates totals and profit from the prices you enter; always verify critical figures independently and export regular backups.',
          'To the maximum extent permitted by law, CountUp’s aggregate liability shall not exceed the subscription fees you paid in the preceding 12 months (or K100 during a free trial).',
          'These Terms are governed by the laws of the Republic of Zambia, with good-faith negotiation followed by arbitration or the courts of Lusaka, Zambia.',
        ],
      },
    ],
  },
  security: {
    title: 'Security & Data Protection',
    lastUpdated: 'November 20, 2026',
    sections: [
      {
        title: 'Defense-in-Depth Architecture',
        content: [
          {
            icon: Lock,
            text: 'Transport & Storage Encryption: All traffic between your phone, Cloudflare, and Supabase uses HTTPS (TLS 1.2/1.3) and WSS, with encryption at rest on Supabase PostgreSQL storage.',
          },
          {
            icon: Shield,
            text: 'Two-Step SIM-Swap Protection: Signing in on a new phone requires BOTH a 6-digit SMS code AND your 4-digit shop PIN before the server binds your session (`shop_verified_sessions`) and issues a `shop_id` database token.',
          },
          {
            icon: User,
            text: 'PostgreSQL Row-Level Security (RLS): Every shop table enforces strict tenant isolation in PostgreSQL using verified JWT claims (`request_shop_id()`), preventing one shop from ever reading or modifying another shop’s rows.',
          },
          {
            icon: CheckCircle,
            text: 'Integer Financial Integrity: All monetary values are stored and reconciled on the server as exact integer ngwee (`bigint`), eliminating floating-point rounding drift.',
          },
          {
            icon: AlertCircle,
            text: 'Salted & Peppered PBKDF2 Hashing: Shop PINs and recovery codes are hashed with PBKDF2-HMAC-SHA256 (210,000 server iterations + secret pepper; 120,000 local iterations for fast offline screen unlock). Mobile Money PINs are never entered in CountUp.',
          },
          {
            icon: Globe,
            text: 'Cloudflare Edge Hardening: Strict Content-Security-Policy (CSP), Turnstile bot verification, CGNAT-aware SMS rate limits, and isolated static-shell Service Worker caching that never caches authenticated API responses.',
          },
        ],
      },
      {
        title: 'Server-Enforced Controls',
        content: [
          'Session Binding: Revoking sessions ("Sign Out All Other Devices") or changing/recovering a PIN invalidates other devices’ verified shop sessions.',
          'Escalating Brute-Force Lockouts: Repeated wrong PIN or recovery-code guesses on a new device trigger escalating server lockouts without locking the shopkeeper out of their already-unlocked counter phone.',
          '72-Hour Fallback Reset Protection: Any support-initiated PIN reset sends an immediate SMS warning and in-app banner with a one-tap Cancel Reset button for 72 hours.',
          'Mandatory Admin MFA (`aal2`): Platform administration requires both a pre-authorized verified email and active TOTP two-factor authentication (`aal2`) enforced in both Edge Functions and PostgreSQL RLS.',
        ],
      },
      {
        title: 'Shopkeeper Security Checklist',
        content: [
          'Choose a unique 4-digit PIN (avoid 1234, 0000, or your birth year) and never share it—CountUp support will never ask for your PIN.',
          'Write down your one-time recovery code (`CU-XXXX-XXXX-XXXX`) and store it safely away from your phone.',
          'Keep a screen lock enabled on your phone and tap the Lock icon in CountUp when stepping away from the counter.',
          'Export a JSON backup regularly from Settings → Data & Backups and keep a copy in a safe place.',
        ],
      },
    ],
  },
};

export const LegalPages: React.FC<LegalPageProps> = ({ onClose, initialDoc = 'privacy' }) => {
  const [activeDoc, setActiveDoc] = useState<LegalDocType>(initialDoc);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  const doc = legalContent[activeDoc];

  const toggleSection = (sectionTitle: string) => {
    setExpandedSections((prev) => ({ ...prev, [sectionTitle]: !prev[sectionTitle] }));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-title"
    >
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <h1 id="legal-title" className="font-bold text-slate-900 text-base">
            {doc.title}
          </h1>
        </div>
        <span className="text-[10px] text-slate-400 font-mono">Updated: {doc.lastUpdated}</span>
      </header>

      {/* Tab Navigation */}
      <nav
        className="sticky top-[52px] z-10 bg-white border-b border-slate-100 px-3 py-2 flex gap-2 overflow-x-auto"
        role="tablist"
      >
        {(['privacy', 'terms', 'security'] as LegalDocType[]).map((docKey) => {
          const Doc = legalContent[docKey];
          const isActive = activeDoc === docKey;
          return (
            <button
              key={docKey}
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setActiveDoc(docKey);
                setExpandedSections({});
              }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                isActive
                  ? 'bg-emerald-900 text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              {Doc.title}
            </button>
          );
        })}
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-4 py-4 max-w-3xl mx-auto w-full">
        <div className="space-y-4">
          {doc.sections.map((section, idx) => {
            const isExpanded = expandedSections[section.title] !== false;
            return (
              <section
                key={idx}
                className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden"
              >
                <button
                  onClick={() => toggleSection(section.title)}
                  className="w-full px-4 py-3.5 flex items-center justify-between text-left"
                  aria-expanded={isExpanded}
                >
                  <h2 className="font-bold text-slate-900 text-sm flex-1 pr-3">{section.title}</h2>
                  {isExpanded ? (
                    <ChevronUp className="w-5 h-5 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-slate-100 text-xs text-slate-700 leading-relaxed space-y-3">
                    {section.content.map((item, itemIdx) => {
                      if (typeof item === 'string') {
                        return (
                          <p key={itemIdx} className="text-slate-700">
                            {item}
                          </p>
                        );
                      }
                      return (
                        <div key={itemIdx} className="flex items-start gap-2 text-slate-700">
                          <item.icon className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                          <span>{item.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <div className="mt-6 pt-4 border-t border-slate-200 text-center">
          <p className="text-[10px] text-slate-400">
            CountUp Zambia · Your data, your business, your control
          </p>
        </div>
      </main>
    </div>
  );
};

export const PrivacyPolicy: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} />
);

export const TermsOfService: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} initialDoc="terms" />
);

export const SecurityPage: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} initialDoc="security" />
);
