import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, Undo2, X, XCircle } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: Toast[];
  notify: (message: string, options?: { kind?: ToastKind; detail?: string; action?: ToastAction }) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

const TONES: Record<ToastKind, { box: string; icon: string }> = {
  success: { box: 'border-emerald-200 bg-white', icon: 'text-emerald-600' },
  error: { box: 'border-rose-200 bg-white', icon: 'text-rose-600' },
  info: { box: 'border-slate-200 bg-white', icon: 'text-slate-500' },
};

/**
 * Single place where the app confirms what just happened.
 *
 * Every write (a sale, a restocked item, a recorded payment) shows a toast so the
 * shopkeeper gets instant, unambiguous feedback even when the phone is offline.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback<ToastContextValue['notify']>(
    (message, options) => {
      const id = nextId.current++;
      const toast: Toast = {
        id,
        kind: options?.kind ?? 'success',
        message,
        detail: options?.detail,
        action: options?.action,
      };
      setToasts((prev) => [...prev.slice(-2), toast]);
      // Errors and toasts with an action stay longer so they cannot be missed.
      const ttl = toast.kind === 'error' ? 7000 : toast.action ? 8000 : 3200;
      timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, notify, dismiss }}>
      {children}
      {createPortal(
        <div
          className="fixed inset-x-0 bottom-20 md:bottom-6 z-[60] flex flex-col items-center gap-2 px-3 pointer-events-none"
          role="status"
          aria-live="polite"
        >
          {toasts.map((toast) => {
            const Icon = ICONS[toast.kind];
            return (
              <div
                key={toast.id}
                className={`pointer-events-auto w-full max-w-md rounded-2xl border shadow-lg px-3.5 py-3 flex items-start gap-2.5 animate-in slide-in-from-bottom-2 fade-in ${TONES[toast.kind].box}`}
              >
                <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${TONES[toast.kind].icon}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-900 leading-snug">{toast.message}</p>
                  {toast.detail && (
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{toast.detail}</p>
                  )}
                </div>
                {toast.action && (
                  <button
                    onClick={() => {
                      toast.action?.onClick();
                      dismiss(toast.id);
                    }}
                    className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-emerald-800 hover:text-emerald-950 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg px-2 py-1 transition-colors"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    {toast.action.label}
                  </button>
                )}
                <button
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 text-slate-400 hover:text-slate-700 p-0.5"
                  aria-label="Dismiss"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};
