import React from 'react';
import { useShop } from '../context/ShopContext';
import { WifiOff, RefreshCw, X } from 'lucide-react';

export const OfflineNotice: React.FC = () => {
  const { lastOfflineNotice, clearOfflineNotice, isOnline, pendingSyncCount, syncNow, isSyncing } =
    useShop();

  if (pendingSyncCount === 0 && (isOnline || !lastOfflineNotice)) return null;

  return (
    <div className="w-full max-w-5xl mx-auto px-3 sm:px-6 pt-3" role="status">
      <div className="bg-slate-900 text-white rounded-2xl p-3 border border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-2.5 min-w-0 pr-2">
          {!isOnline ? (
            <div className="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <WifiOff className="w-4 h-4" />
            </div>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            </div>
          )}

          <div className="min-w-0 text-xs">
            <p className="font-bold text-slate-100">
              {!isOnline
                ? `Offline${pendingSyncCount ? ` · ${pendingSyncCount} waiting to sync` : ''}`
                : `${pendingSyncCount} ${pendingSyncCount === 1 ? 'entry' : 'entries'} waiting to sync`}
            </p>
            <p className="text-[11px] text-slate-400 break-words">
              {!isOnline
                ? pendingSyncCount > 0
                  ? 'Keep this browser’s data until your entries sync.'
                  : 'New entries stay on this device until they sync.'
                : isSyncing
                  ? 'Sending your saved entries now.'
                  : lastOfflineNotice || 'Keep this browser’s data until your entries sync.'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 shrink-0">
          {isOnline && pendingSyncCount > 0 && (
            <button
              onClick={() => void syncNow()}
              disabled={isSyncing}
              className="text-[11px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white px-2.5 py-1 rounded-lg transition-colors"
            >
              {isSyncing ? 'Syncing...' : 'Sync Now'}
            </button>
          )}

          {pendingSyncCount === 0 && (
            <button
              onClick={clearOfflineNotice}
              aria-label="Dismiss sync notice"
              className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
