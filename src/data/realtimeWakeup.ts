import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../supabase/client';

export type SyncTriggerReason = 'initial' | 'realtime' | 'online' | 'visibility' | 'manual';

export interface RealtimeChannelSource {
  subscribeToShopChanges(shopId: string, onWakeup: () => void): () => void;
}

export function createSupabaseRealtimeChannelSource(
  client: SupabaseClient = supabase
): RealtimeChannelSource {
  return {
    subscribeToShopChanges(shopId: string, onWakeup: () => void): () => void {
      const channel: RealtimeChannel = client.channel(`shop-wakeup:${shopId}`).on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shops',
          filter: `id=eq.${shopId}`,
        },
        () => {
          // Realtime payload is intentionally ignored: Realtime is a speed-up
          // wake-up signal only, never the source of truth.
          onWakeup();
        }
      );

      const childTables = [
        'items',
        'customers',
        'sales',
        'sale_lines',
        'credit_payments',
        'expenses',
        'stock_movements',
        'stock_conflicts',
        'subscription_payments',
      ] as const;

      for (const tbl of childTables) {
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: tbl,
            filter: `shop_id=eq.${shopId}`,
          },
          () => {
            onWakeup();
          }
        );
      }

      channel.subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}

/**
 * Coordinates initial cursor pull, debounced Realtime wake-ups (speed-up only),
 * reconnect (`online`) catch-up, and tab foreground (`visibilitychange`) catch-up.
 * Coalesces overlapping wake-ups so at most one cursor pull runs at a time.
 */
export function createShopReadSyncCoordinator(params: {
  shopId: string;
  runCursorPull: (reason: SyncTriggerReason) => Promise<void>;
  realtimeSource?: RealtimeChannelSource;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}): {
  triggerNow: (reason?: SyncTriggerReason) => Promise<void>;
  dispose: () => void;
} {
  const {
    shopId,
    runCursorPull,
    realtimeSource = createSupabaseRealtimeChannelSource(),
    debounceMs = 250,
    onError,
  } = params;

  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let rerunReason: SyncTriggerReason | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const executePull = async (reason: SyncTriggerReason): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      rerunReason = reason;
      return inFlight;
    }

    inFlight = (async () => {
      let nextReason: SyncTriggerReason | null = reason;
      while (nextReason && !disposed) {
        const activeReason = nextReason;
        nextReason = null;
        try {
          await runCursorPull(activeReason);
        } catch (err) {
          onError?.(err);
        }
        if (rerunReason && !disposed) {
          nextReason = rerunReason;
          rerunReason = null;
        }
      }
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const scheduleRealtimePull = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void executePull('realtime');
    }, debounceMs);
  };

  const unsubRealtime = realtimeSource.subscribeToShopChanges(shopId, scheduleRealtimePull);

  const handleOnline = () => {
    void executePull('online');
  };
  const handleVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void executePull('visibility');
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  // Trigger initial load / catch-up immediately
  void executePull('initial');

  return {
    triggerNow: (reason: SyncTriggerReason = 'manual') => executePull(reason),
    dispose: () => {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      unsubRealtime();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    },
  };
}
