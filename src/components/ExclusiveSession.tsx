import React, { useEffect, useState } from 'react';
import icon from '/brand/icon.png';

type SessionState = 'opening' | 'waiting' | 'active' | 'unsupported';

/**
 * The local cache and sync queue are shared by every tab on this origin. Keep
 * exactly one app instance active, rather than letting stale tabs overwrite one
 * another's queued sales. Web Locks automatically releases the lock on close.
 */
export const ExclusiveSession: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<SessionState>('opening');

  useEffect(() => {
    if (!navigator.locks?.request) {
      setState('unsupported');
      return;
    }
    let cancelled = false;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const waitingTimer = window.setTimeout(() => {
      if (!cancelled) setState((current) => (current === 'opening' ? 'waiting' : current));
    }, 250);

    void navigator.locks
      .request(
        'countup-local-data-v1',
        { mode: 'exclusive', signal: controller.signal },
        async () => {
          if (cancelled) return;
          setState('active');
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      )
      .catch(() => {
        if (!cancelled) setState('unsupported');
      });

    return () => {
      cancelled = true;
      window.clearTimeout(waitingTimer);
      controller.abort();
      release?.();
    };
  }, []);

  if (state === 'active') return <>{children}</>;
  if (state === 'unsupported') {
    return (
      <>
        <div
          role="alert"
          className="bg-amber-100 px-4 py-3 text-center text-xs font-bold text-amber-950"
        >
          This browser cannot protect data across multiple tabs. Keep CountUp open in only one tab
          on this device.
        </div>
        {children}
      </>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-center text-slate-900">
      <div
        className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <img src={icon} alt="Countup" className="mx-auto mb-4 h-12 w-12 object-contain" />
        {state === 'waiting' ? (
          <>
            <h1 className="text-lg font-extrabold">CountUp is open in another tab</h1>
            <p className="mt-2 text-sm text-slate-600">
              To protect unsynced entries, use the other tab or close it. This tab will open
              automatically.
            </p>
          </>
        ) : (
          <p className="text-sm font-bold">Opening your shop safely…</p>
        )}
      </div>
    </div>
  );
};
