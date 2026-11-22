import { StockMovement } from '../types';

/** A dynamic field is calculated against the latest server value, not a stale cache. */
export type SyncAdjustment =
  | {
      kind: 'stock';
      path: string;
      delta: number;
      setTo?: number;
      updatedAt: string;
      lastSoldAt?: string;
      metadata?: object;
      movement: { path: string; data: StockMovement };
    }
  | { kind: 'credit'; path: string; deltaNgwee: number; updatedAt: string };

/** The whole operation is durable on this device until the server acknowledges it. */
export interface PendingSyncAction {
  id: string;
  type: 'sale' | 'item' | 'customer' | 'payment' | 'expense' | 'stock_update';
  path: string;
  data: object;
  timestamp: number;
  writes?: { path: string; data: object }[];
  adjustments?: SyncAdjustment[];
  reservedOwnerUid?: string;
}

/** Merging server snapshots with the offline queue. */
export interface QueuedPath {
  path: string;
  data?: object;
  /** New operations can contain several writes that must be committed together. */
  writes?: { path: string; data: object }[];
}

/**
 * Rebuild the optimistic cache from the durable queue after an interrupted
 * render. Queue writes are replayed in order; a partial patch only applies when
 * its original record is available, while a full create can restore a lost cache.
 */
export function replayQueuedWrites<T extends { id: string }>(
  cached: T[],
  queue: QueuedPath[],
  collectionPath: string
): T[] {
  const entries = new Map(cached.map((record) => [record.id, record]));
  const prefix = `${collectionPath}/`;
  for (const action of queue) {
    for (const write of action.writes ?? [action]) {
      if (!write.path.startsWith(prefix) || !write.data) continue;
      const id = write.path.slice(prefix.length);
      if (!id || id.includes('/')) continue;
      const previous = entries.get(id);
      const patch = write.data as Partial<T>;
      if (previous) entries.set(id, { ...previous, ...patch, id });
      else if (patch.id === id) entries.set(id, patch as T);
    }
  }
  return [...entries.values()];
}

/**
 * Keep pending local creates, edits and deletes visible until their write reaches
 * the server. Old queue entries that only have a path retain their old behaviour.
 */
export function reconcile<T extends { id: string }>(
  remote: T[],
  local: T[],
  queue: QueuedPath[],
  collectionPath: string
): T[] {
  const pending = new Map<string, object | undefined>();
  for (const action of queue) {
    for (const write of action.writes ?? [action]) {
      if (write.path.startsWith(`${collectionPath}/`)) pending.set(write.path, write.data);
    }
  }
  if (pending.size === 0) return remote;
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const remoteIds = new Set(remote.map((entry) => entry.id));
  let changed = false;
  const result: T[] = [];
  for (const entry of remote) {
    const path = `${collectionPath}/${entry.id}`;
    const data = pending.get(path);
    const localEntry = localById.get(entry.id);
    if (data && (data as { isDeleted?: boolean }).isDeleted && !localEntry) {
      changed = true;
      continue;
    }
    if (data && localEntry) {
      result.push(localEntry);
      changed = true;
    } else result.push(entry);
  }
  for (const entry of local) {
    if (!remoteIds.has(entry.id) && pending.has(`${collectionPath}/${entry.id}`)) {
      result.push(entry);
      changed = true;
    }
  }
  return changed ? result : remote;
}

export interface SyncProjectionDocument {
  path: string;
  data: Record<string, unknown> | null;
}

/**
 * After an owner resolves the head of the queue, its old optimistic balances
 * no longer describe later entries. Rebuild only the affected previews from
 * the server, in FIFO order. The financial/stock deltas and receipts themselves
 * are never changed. A later overpayment remains queued for its own review.
 */
export function rebaseQueuedProjections(
  queue: PendingSyncAction[],
  base: SyncProjectionDocument[]
): { queue: PendingSyncAction[]; documents: SyncProjectionDocument[] } {
  const projected = new Map(
    base.map((entry) => [entry.path, entry.data ? { ...entry.data } : null])
  );
  const rebased = queue.map((action) => {
    if (!action.writes) return action;
    const adjusted = new Map((action.adjustments ?? []).map((entry) => [entry.path, entry]));
    const movementPreviews = new Map<string, Record<string, unknown>>();
    const writes = action.writes.map((write) => {
      if (!projected.has(write.path)) return write;
      const current = projected.get(write.path);
      if (!current) return write;
      const adjustment = adjusted.get(write.path);
      let next: Record<string, unknown>;
      if (adjustment?.kind === 'credit') {
        const balance = Math.round(Number(current.totalOwed) * 100);
        if (!Number.isSafeInteger(balance)) return write;
        // The queued payment itself stays unchanged and will be reviewed if it
        // exceeds the new balance. Do not display an invented negative debt.
        next = {
          ...current,
          totalOwed: Math.max(0, balance + adjustment.deltaNgwee) / 100,
          updatedAt: adjustment.updatedAt,
        };
      } else if (adjustment?.kind === 'stock') {
        const previous = Number(current.quantity);
        if (!Number.isSafeInteger(previous) || previous < 0) return write;
        const staleCount =
          adjustment.setTo !== undefined && adjustment.movement.data.previousQuantity !== previous;
        const quantity = Math.max(
          0,
          staleCount ? previous : (adjustment.setTo ?? previous + adjustment.delta)
        );
        next = {
          ...current,
          ...adjustment.metadata,
          quantity,
          updatedAt: adjustment.updatedAt,
          ...(adjustment.lastSoldAt ? { lastSoldAt: adjustment.lastSoldAt } : {}),
        };
        movementPreviews.set(adjustment.movement.path, {
          ...adjustment.movement.data,
          ...(staleCount
            ? { delta: 0, requestedQuantity: adjustment.setTo, recountNeeded: true }
            : {}),
          previousQuantity: previous,
          newQuantity: quantity,
        });
      } else {
        next = { ...current, ...write.data };
      }
      projected.set(write.path, next);
      // Dynamic write data is a local preview only; the transaction uses its
      // adjustment. Partial non-dynamic patches must remain partial on the wire.
      return adjustment ? { ...write, data: next } : write;
    });
    const withMovements = writes.map((write) => {
      const preview = movementPreviews.get(write.path);
      if (!preview) return write;
      projected.set(write.path, preview);
      return { ...write, data: preview };
    });
    const first = withMovements.find((write) => write.path === action.path);
    return { ...action, writes: withMovements, data: first?.data ?? action.data };
  });
  return {
    queue: rebased,
    documents: [...projected].map(([path, data]) => ({ path, data })),
  };
}

/** Retry only failures likely to clear without the owner changing an account or entry. */
export function isTransientSyncError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  return [
    'unavailable',
    'deadline-exceeded',
    'aborted',
    'resource-exhausted',
    'internal',
    'auth/network-request-failed',
    'auth/timeout',
    'auth/too-many-requests',
  ].includes(code);
}

/** Firestore rejects undefined fields, while optional UI fields naturally use them. */
export function cleanForFirestore<T extends object>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}
