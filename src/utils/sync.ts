/**
 * Merging server snapshots with the offline queue.
 *
 * Kept in its own module (rather than inside ShopContext) so the rule can be
 * unit-tested without booting React or Firebase.
 */

/** The only part of a queued sync action this logic needs. */
export interface QueuedPath {
  path: string;
}

/**
 * Merge a server snapshot with writes that are still waiting in the offline queue.
 *
 * Firestore only knows about documents that reached it. Anything queued while the
 * phone was offline exists solely in local state, so a naive `setState(remote)`
 * makes a just-recorded sale vanish from the screen until it syncs. Keep exactly
 * those not-yet-pushed documents on top of the server truth; everything else comes
 * from the server, so edits and deletions made elsewhere are reflected immediately.
 */
export function reconcile<T extends { id: string }>(
  remote: T[],
  local: T[],
  queue: QueuedPath[],
  collectionPath: string
): T[] {
  const unsynced = new Set(
    queue.filter((a) => a.path.startsWith(`${collectionPath}/`)).map((a) => a.path)
  );
  if (unsynced.size === 0) return remote;
  const remoteIds = new Set(remote.map((r) => r.id));
  const unsyncedLocal = local.filter(
    (l) => !remoteIds.has(l.id) && unsynced.has(`${collectionPath}/${l.id}`)
  );
  return unsyncedLocal.length === 0 ? remote : [...remote, ...unsyncedLocal];
}
