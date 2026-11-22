import React, { useEffect, useRef } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getTurnstileSiteKey } from '../supabase/client';

interface TurnstileGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
    }
  ) => string;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

interface TurnstileFieldProps {
  onTokenChange: (token: string | undefined, ready: boolean) => void;
  resetSignal?: number;
}

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const TurnstileField: React.FC<TurnstileFieldProps> = ({
  onTokenChange,
  resetSignal = 0,
}) => {
  const siteKey = getTurnstileSiteKey();
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onTokenChange);
  callbackRef.current = onTokenChange;

  useEffect(() => {
    if (!siteKey) {
      callbackRef.current(undefined, true);
      return;
    }

    let cancelled = false;
    let widgetId: string | null = null;
    callbackRef.current(undefined, false);

    const mountWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      containerRef.current.innerHTML = '';
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token: string) => {
          if (!cancelled) callbackRef.current(token, true);
        },
        'expired-callback': () => {
          if (!cancelled) callbackRef.current(undefined, false);
        },
        'error-callback': () => {
          if (!cancelled) callbackRef.current(undefined, false);
        },
      });
    };

    if (window.turnstile) {
      mountWidget();
    } else {
      let script = document.querySelector<HTMLScriptElement>(
        `script[src="${TURNSTILE_SCRIPT_SRC}"]`
      );
      const onLoad = () => mountWidget();
      if (!script) {
        script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', onLoad);
      return () => {
        cancelled = true;
        script?.removeEventListener('load', onLoad);
        if (widgetId && window.turnstile?.remove) {
          window.turnstile.remove(widgetId);
        }
      };
    }

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [siteKey, resetSignal]);

  if (!siteKey) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-700" />
        <span>Protected by SMS one-time verification code</span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-slate-600">Security check</p>
      <div
        ref={containerRef}
        data-testid="turnstile-widget"
        className="min-h-[65px] overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-1.5"
      />
    </div>
  );
};
