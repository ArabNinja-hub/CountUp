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
import { SUPPORT_CONTACT } from '../config/support';

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

// Typed so `content` is always an array: some sections were authored as a bare
// string, and the renderer calls .map() on it unconditionally.
const legalContent: Record<LegalDocType, LegalDoc> = {
  privacy: {
    title: 'Privacy Policy',
    lastUpdated: 'October 28, 2026',
    sections: [
      {
        title: 'Information We Collect',
        content: [
          'Shop Information: Your shop/kiosk name, owner name, and phone number for account creation.',
          'Sales Data: Items sold, quantities, prices, payment methods (cash, mobile money, credit), timestamps.',
          'Stock Data: Product names, buying/selling prices, stock quantities, low-stock thresholds.',
          'Customer Data (Credit Book): Customer names, phone numbers, amounts owed, payment history - ONLY when you choose to use the credit feature.',
          'Expenses: Expense categories, amounts, notes you record for business tracking.',
          'Device Information: Anonymous device ID, app version, language preference for offline sync.',
        ],
      },
      {
        title: 'How We Use Your Data',
        content: [
          'Provide the Service: Enable offline-first sales recording, stock management, credit tracking, and reports.',
          'Sync & Backup: Entries saved offline remain on the device until they sync to Firebase. Keep your browser data until sync completes.',
          'Subscription Management: Track your trial/plan status and show in-app renewal reminders.',

          'Legal Compliance: Respond to valid legal requests from Zambian authorities.',
        ],
      },
      {
        title: 'Data Storage & Security',
        content: [
          'Local-First: Shop entries can be saved on this device offline and synced later. Account access, imports and administration require a connection.',
          'Cloud Sync: When online, your records sync to Google Firebase (Google Cloud infrastructure). Firebase is SOC 2 and ISO 27001 certified.',
          'Encryption: Data in transit uses TLS 1.3. Data at rest encrypted by Firebase.',
          'Authentication: A shop can use a phone number and 4-digit PIN on its original device. Email and password access is optional; administrators can also sign in with an authorized email account. Your shop PIN is stored with the shop record.',
          "Access Control: Every shop's records are scoped to that shop ID by Firestore security rules. Other shops cannot read your data. Authorized platform administrators can access shop records for support, billing, or legal compliance.",
        ],
      },
      {
        title: 'Your Rights (Zambia Data Protection Act 2021)',
        content: [
          "Access: Request a copy of all your data anytime via the app's Export feature.",
          'Correction: Edit any item, sale, customer, or expense directly in the app.',
          'Deletion: Settings → Delete Shop & Data permanently removes your shop, stock, sales, credit and expense records. It is immediate and cannot be undone.',
          'Portability: Export your sales, stock, and customer data as CSV/JSON anytime.',
        ],
      },
      {
        title: 'Data Retention',
        content: [
          'Active Shops: Data retained while your subscription is active.',
          'Expired/Cancelled: Records are kept read-only after a plan expires so you can renew and keep trading; nothing is auto-deleted. You can delete everything yourself at any time (Settings → Delete Shop & Data).',
          'Backups: Firebase retains deleted data for up to 30 days in backup systems.',
        ],
      },
      {
        title: 'Third-Party Services',
        content: [
          'Firebase (Google): Hosting and database. Privacy Policy: policies.google.com/privacy',
          'Lipila (Mobile Money): Only used when you initiate a subscription payment. We do not store your Mobile Money PIN.',
          'WhatsApp: Only opens when you tap "Send Reminder" - we do not access your WhatsApp data.',
        ],
      },
      {
        title: "Children's Privacy",
        content: [
          'Countup is for business use by adults (18+). We do not knowingly collect data from minors.',
        ],
      },
      {
        title: 'Contact',
        content: [
          `Data Protection Officer: ${SUPPORT_CONTACT.supportEmail}`,
          `Phone / WhatsApp: ${SUPPORT_CONTACT.phoneDisplay}`,
          'For Zambian regulatory inquiries: We comply with the Data Protection Act No. 3 of 2021.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of Service',
    lastUpdated: 'October 28, 2026',
    sections: [
      {
        title: 'Acceptance of Terms',
        content: [
          'By creating a shop account or using Countup, you agree to these Terms.',
          'If you do not agree, do not use the app. Your only remedy is to stop using Countup.',
          'We may update these terms. Continued use after changes constitutes acceptance.',
        ],
      },
      {
        title: 'Service Description',
        content: [
          'Countup is a mobile-first sales book, stock manager, and credit tracker for Zambian kiosks, market stalls, and small shops.',
          'Features: Offline sales recording, stock tracking with profit margins, customer credit book, expense tracking, sales reports, subscription management.',
          'The service is provided "as is" and "as available" without warranties of any kind.',
        ],
      },
      {
        title: 'Your Responsibilities',
        content: [
          'Accurate Information: Provide truthful shop name, phone number. PIN must be kept secret.',
          'Legal Compliance: Use Countup for lawful business activities. You are responsible for tax compliance (ZRA, local council).',
          'Data Accuracy: You are responsible for the accuracy of sales, stock, and customer data you enter.',
          'Device Security: Protect your phone. Anyone with your phone + PIN can access your shop data.',
          'No Resale: You may not resell, sublicense, or commercialize access to Countup.',
        ],
      },
      {
        title: 'Subscription & Payments',
        content: [
          'Free Trial: New shops get a 30-day free trial with full features.',
          'Paid Plans: After trial, choose Monthly (K99), Quarterly (K269), or Biannual (K499). Prices in Zambian Kwacha (ZMW).',
          'Payments: Processed via Lipila (Airtel Money, MTN MoMo, Zamtel). We never see your Mobile Money PIN.',
          'Auto-Renewal: Plans do NOT auto-renew. You must manually renew before expiry.',
          'Grace Period: 3 days after expiry to renew without data loss. After grace, sales recording pauses (data remains viewable).',
          'Refunds: No refunds for partial periods. You can export all data anytime.',
        ],
      },
      {
        title: 'Intellectual Property',
        content: [
          'Your Data: You own all sales, stock, customer, and expense data you enter.',
          'Our IP: Countup brand, code, UI, and algorithms remain our property.',
          'Feedback: Any suggestions you send become ours to use without compensation.',
        ],
      },
      {
        title: 'Disclaimers & Limitation of Liability',
        content: [
          'No Financial Advice: Countup shows calculated profit based on your entered prices. Verify independently.',
          'No Guarantee of Uptime: We strive for 99.9% uptime but cannot guarantee continuous availability.',
          'Liability Cap: Our total liability shall not exceed the amount you paid in the last 12 months (or K100 if on trial).',
          'No Liability For: Lost profits, data loss due to device failure, third-party payment failures, government actions.',
        ],
      },
      {
        title: 'Termination',
        content: [
          'By You: Settings → Delete Shop & Data removes your shop immediately and permanently.',
          'By Us: We may suspend/terminate for: non-payment after grace period, illegal activity, abuse of platform, extended inactivity (180+ days).',
          'Effect: On termination, sales recording stops. Data export remains available for 90 days.',
        ],
      },
      {
        title: 'Governing Law & Disputes',
        content: [
          'Governing Law: Laws of the Republic of Zambia.',
          'Disputes: First attempt good-faith negotiation. Then binding arbitration in Lusaka under the Arbitration Act No. 19 of 2000.',
          'Venue: Lusaka, Zambia courts for any non-arbitrable matters.',
        ],
      },
      {
        title: 'Contact',
        content: [
          `Support: ${SUPPORT_CONTACT.phoneDisplay} (call or WhatsApp)`,
          `Email: ${SUPPORT_CONTACT.supportEmail} (support, payments and legal)`,
          'Physical: Countup Zambia, Lusaka, Zambia',
        ],
      },
    ],
  },
  security: {
    title: 'Security & Data Protection',
    lastUpdated: 'October 28, 2026',
    sections: [
      {
        title: 'Security Measures',
        content: [
          {
            icon: Lock,
            text: 'Encryption: Data is encrypted in transit (TLS 1.3) and at rest by Google Cloud. This is transport and storage encryption, not end-to-end encryption of your device.',
          },
          {
            icon: Shield,
            text: 'Authentication: phone and PIN access uses an anonymous Firebase session. You may link email and password to that same session to sign in on another device; admin access requires a separate authorization grant.',
          },
          {
            icon: User,
            text: "Data Isolation: Each shop's data is scoped to a unique shop ID. Shops cannot access each other's data.",
          },
          {
            icon: CheckCircle,
            text: 'Offline-First Architecture: Offline entries stay on the device and are queued to sync when a connection is available.',
          },
          {
            icon: AlertCircle,
            text: "PIN Handling: Your 4-digit PIN is stored with your shop record and readable by your account and authorized platform administrators. Mobile Money PINs are never entered in Countup — they go straight into your operator's own prompt.",
          },
          {
            icon: Globe,
            text: 'Firebase Security Rules: Firestore rules enforce shop-level data isolation at the database level.',
          },
        ],
      },
      {
        title: 'Firebase Security Rules (Enforced Server-Side)',
        content: [
          'shops/{shopId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'shops/{shopId}/items/{itemId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'shops/{shopId}/sales/{saleId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'shops/{shopId}/customers/{customerId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'shops/{shopId}/credit_payments/{paymentId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'shops/{shopId}/expenses/{expenseId}: Read/Write only if request.auth.uid == shop.ownerUid',
          'Platform owner: Can read shop records for support, billing, and plan administration, and can extend or suspend a shop',
          'Shop deletion: Only the shop owner (or the platform owner) can permanently delete a shop',
        ],
      },
      {
        title: 'What We Protect Against',
        content: [
          'Unauthorized Access: Each shop requires its phone number and PIN, and Firestore rules reject reads or writes from any other session.',
          'Data Tampering: Firestore validates every write against the security rules, and removed stock items are soft-deleted so they cannot silently reappear.',
          'Man-in-the-Middle: All traffic to Firebase uses TLS. Always open Countup from its official address (arabninja-hub.github.io/CountUp).',
          'Cross-Site Scripting: React escapes all rendered values; the app never injects raw HTML.',
          'Data Loss: Local-first storage plus cloud sync. Export a JSON backup monthly from Settings → Export My Data.',
        ],
      },
      {
        title: 'Your Security Checklist',
        content: [
          'Use a unique 4-digit PIN (not 1234, 0000, birth year).',
          'Do not share your PIN. Countup staff will NEVER ask for it.',
          'Enable phone screen lock (fingerprint/face/PIN).',
          'Log out if sharing your phone: Menu → Log Out.',
          'Pay subscriptions only through the contact channels listed in the Plan screen, and confirm the shop ID before paying.',
          'Export your data monthly as backup: Reports → Export.',
        ],
      },
      {
        title: 'Incident Response',
        content: [
          `If you suspect unauthorized access: Change PIN immediately, log out all sessions, then contact ${SUPPORT_CONTACT.supportEmail} or call ${SUPPORT_CONTACT.phoneDisplay}.`,
          'We notify affected users within 72 hours of any confirmed data breach per Zambia Data Protection Act.',
          'Access to the platform-owner admin console is limited to the owner account, and Google Cloud keeps API-level audit logs.',
        ],
      },
      {
        title: 'Compliance',
        content: [
          'Zambia Data Protection Act No. 3 of 2021',
          'Firebase: SOC 2 Type II, ISO 27001, ISO 27017, ISO 27018',
          'Lipila: Licensed by Bank of Zambia as Payment Service Provider',
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
            const isExpanded = expandedSections[section.title] !== false; // Default open
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
            Countup Zambia · Your data, your business, your control
          </p>
        </div>
      </main>
    </div>
  );
};

// Standalone components for each legal page (for direct linking if needed)
export const PrivacyPolicy: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} />
);

export const TermsOfService: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} initialDoc="terms" />
);

export const SecurityPage: React.FC<LegalPageProps> = ({ onClose }) => (
  <LegalPages onClose={onClose} initialDoc="security" />
);
