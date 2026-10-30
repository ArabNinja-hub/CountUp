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

/** Firestore rejects undefined fields, while optional UI fields naturally use them. */
export function cleanForFirestore<T extends object>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}
