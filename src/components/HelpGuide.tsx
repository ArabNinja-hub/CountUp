import React, { useEffect, useRef } from 'react';
import { BookOpen, ChevronDown, X } from 'lucide-react';

const steps = [
  {
    number: '01',
    title: 'Add a product',
    detail: 'Open Stock, tap Add New Item, and save its price and quantity.',
  },
  {
    number: '02',
    title: 'Make a sale',
    detail: 'Open Sell, tap products, choose how the customer paid, and save.',
  },
  {
    number: '03',
    title: 'See your day',
    detail: 'Open Reports for sales, money received, profit and expenses.',
  },
];

const topics = [
  {
    title: 'Create or open a shop',
    lines: [
      'Choose New shop. Enter its name, your phone number and a 4-number PIN, then tap Create shop.',
      'To return, choose Log in and use the phone number and PIN on the original device. If you linked email, you can also choose Email sign in.',
    ],
  },
  {
    title: 'Add and manage stock',
    lines: [
      'Open Stock → Add New Item. Enter the name, selling price and how many you have. Add the buying price if you know it, then save.',
      'Use +5 or +10 next to an item to add stock. Use its action buttons to adjust, edit or archive it. Low stock is shown on Home and Stock.',
    ],
  },
  {
    title: 'Record a sale',
    lines: [
      'Open Sell and tap each product. On a phone, tap Review sale. Change quantities if needed.',
      'Choose Cash, Mobile Money or Credit. For credit, choose or add a customer. Tap Save Sale. Use More details for an optional note or reference.',
    ],
  },
  {
    title: 'Credit and repayments',
    lines: [
      'Open Credit and select a customer to see what they owe.',
      'When they pay, tap Record Payment, enter the amount and payment method, then save. You can also send a WhatsApp reminder if their phone number is saved.',
    ],
  },
  {
    title: 'Reports and expenses',
    lines: [
      'Open Reports and choose Today, This Week or This Month. Record Expense adds a business expense.',
      'Money received includes cash, Mobile Money and repayments. Credit sales are not money received. Profit excludes products without a known buying price.',
    ],
  },
  {
    title: 'Offline and keeping your data',
    lines: [
      'Entries can be saved on this phone while offline. Reconnect and check the sync notice; conflicts can stop the queue.',
      'Do not clear browser data before entries sync. To open the shop on another device, first sync and link email in Settings → Account & cloud access.',
      'Settings → Data & backups can export data and import a legacy backup. CountUp JSON exports cannot yet be restored in the app.',
    ],
  },
  {
    title: 'Admin access',
    lines: [
      'Admin access must be granted to your account. On the sign-in page, choose Admin sign in and use that account’s email and password.',
      'If you use a shop PIN, log in to your shop and choose Settings → Platform Admin. To add email to that same account, use Settings → Account & cloud access.',
    ],
  },
];

/** An offline, task-focused guide available before and after shop sign-in. */
export const HelpGuide: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && dialogRef.current) {
        const controls = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), summary, a[href]'
          )
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 bg-emerald-950 px-5 py-5 text-white sm:px-6">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-300">
              <BookOpen className="h-4 w-4" />
              CountUp guide
            </p>
            <h2 id="help-title" className="mt-1 text-xl font-extrabold tracking-tight">
              How to use CountUp
            </h2>
            <p className="mt-1 text-sm text-emerald-100">Start here, or choose a topic below.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close guide"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain p-5 sm:p-6">
          <h3 className="text-sm font-extrabold text-slate-900">Get started in 3 steps</h3>
          <ol className="mt-3 space-y-2">
            {steps.map((step) => (
              <li key={step.number} className="flex gap-3 rounded-2xl bg-emerald-50 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-900 text-xs font-extrabold text-white">
                  {step.number}
                </span>
                <div>
                  <p className="text-sm font-bold text-slate-900">{step.title}</p>
                  <p className="mt-0.5 text-sm leading-snug text-slate-600">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <h3 className="mb-2 mt-6 text-sm font-extrabold text-slate-900">More help</h3>
          <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
            {topics.map((topic) => (
              <details key={topic.title} className="group px-4">
                <summary className="flex min-h-[50px] cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-slate-800 [&::-webkit-details-marker]:hidden">
                  {topic.title}
                  <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
                </summary>
                <ul className="space-y-2 pb-4 text-sm leading-relaxed text-slate-600">
                  {topic.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
