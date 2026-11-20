/**
 * Overlap-window cursor sync engine (Phase 3a).
 *
 * Why `(cursor - 120s)` + `(id, updated_at)` deduplication:
 *   In PostgreSQL, Transaction A can start slightly before Transaction B (so A's
 *   `clock_timestamp()` or transaction timestamp is earlier) while committing
 *   slightly after B. Re-fetching from `lastCursor - 120s` guarantees late-
 *   committing rows are never skipped, while deduplicating by `(id, updated_at)`
 *   makes re-reading rows inside the 120-second overlap window a zero-mutation
 *   no-op.
 */
export const CURSOR_OVERLAP_WINDOW_MS = 120_000; // 120 seconds

export interface CursorTrackableRow {
  id: string;
  updated_at: string;
}

export interface ShopSyncCursors {
  items?: string | null;
  customers?: string | null;
  sales?: string | null;
  sale_lines?: string | null;
  credit_payments?: string | null;
  expenses?: string | null;
  stock_movements?: string | null;
  stock_conflicts?: string | null;
  subscription_payments?: string | null;
}

/**
 * Parses an ISO-8601 / PostgreSQL `timestamptz` string into BigInt microseconds
 * since the Unix epoch so sub-millisecond updates (`+ interval '1 microsecond'`)
 * are ordered accurately without `Date.parse` millisecond truncation.
 */
export function parseTimestampToEpochMicros(iso: string): bigint {
  const trimmed = iso.trim().replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
    trimmed
  );
  if (!match) {
    const fallbackMs = Date.parse(trimmed);
    if (!Number.isFinite(fallbackMs)) {
      throw new Error(`Invalid cursor timestamp: ${iso}`);
    }
    return BigInt(fallbackMs) * 1000n;
  }

  const [, dateTimeHead, rawFraction = '', rawTz] = match;
  const normalizedTz =
    rawTz === 'Z' || rawTz.includes(':')
      ? rawTz
      : rawTz.length === 3
        ? `${rawTz}:00`
        : `${rawTz.slice(0, 3)}:${rawTz.slice(3)}`;

  const wholeSecondMs = Date.parse(`${dateTimeHead}${normalizedTz}`);
  if (!Number.isFinite(wholeSecondMs)) {
    throw new Error(`Invalid cursor timestamp: ${iso}`);
  }

  const microDigits = rawFraction.slice(0, 6).padEnd(6, '0');
  const subSecondMicros = BigInt(Number.parseInt(microDigits, 10));
  return BigInt(wholeSecondMs) * 1000n + subSecondMicros;
}

export function compareTimestampsMicros(a: string, b: string): number {
  const ma = parseTimestampToEpochMicros(a);
  const mb = parseTimestampToEpochMicros(b);
  if (ma === mb) return 0;
  return ma > mb ? 1 : -1;
}

/**
 * Computes `(cursor - 120s)` as an ISO timestamp string for `WHERE updated_at >= $floor`.
 * Returns `null` when `lastCursor` is absent so initial load fetches all rows.
 */
export function computeOverlapQueryFloor(
  lastCursor: string | null | undefined,
  overlapMs = CURSOR_OVERLAP_WINDOW_MS
): string | null {
  if (!lastCursor) return null;
  const micros = parseTimestampToEpochMicros(lastCursor);
  const floorMs = Number(micros / 1000n) - overlapMs;
  if (!Number.isFinite(floorMs)) return null;
  return new Date(Math.max(0, floorMs)).toISOString();
}

export interface CursorMergeResult<TRow extends CursorTrackableRow> {
  rows: TRow[];
  appliedCount: number;
  skippedDuplicateCount: number;
  skippedStaleCount: number;
  nextCursor: string | null;
}

/**
 * Merges incoming server rows into cached rows, deduplicating strictly by
 * `(id, updated_at)` and advancing `nextCursor` monotonically.
 */
export function mergeRowsByCursorDedupe<TRow extends CursorTrackableRow>(
  cachedRows: readonly TRow[],
  incomingRows: readonly TRow[],
  previousCursor: string | null = null
): CursorMergeResult<TRow> {
  const byId = new Map<string, TRow>();
  for (const row of cachedRows) {
    byId.set(row.id, row);
  }

  let appliedCount = 0;
  let skippedDuplicateCount = 0;
  let skippedStaleCount = 0;
  let maxCursor: string | null = previousCursor;

  for (const incoming of incomingRows) {
    if (!maxCursor || compareTimestampsMicros(incoming.updated_at, maxCursor) > 0) {
      maxCursor = incoming.updated_at;
    }

    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      appliedCount += 1;
      continue;
    }

    // Exact (id, updated_at) match inside the 120s overlap window -> pure no-op
    if (existing.id === incoming.id && existing.updated_at === incoming.updated_at) {
      skippedDuplicateCount += 1;
      continue;
    }

    if (compareTimestampsMicros(incoming.updated_at, existing.updated_at) >= 0) {
      byId.set(incoming.id, incoming);
      appliedCount += 1;
    } else {
      skippedStaleCount += 1;
    }
  }

  return {
    rows: Array.from(byId.values()),
    appliedCount,
    skippedDuplicateCount,
    skippedStaleCount,
    nextCursor: maxCursor,
  };
}
