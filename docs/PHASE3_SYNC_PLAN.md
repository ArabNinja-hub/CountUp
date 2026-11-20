# Phase 3 Reconnect Sync & Data-Layer Design Notes

## 1. Out-of-Order Commit Protection on `updated_at` Cursors

In PostgreSQL (MVCC), two concurrent server transactions can stamp `updated_at` in one order and commit in the opposite order:

- Transaction A starts at `10:00:00.100`, sets `updated_at = 10:00:00.100`, and finishes committing at `10:00:00.450`.
- Transaction B starts at `10:00:00.200`, sets `updated_at = 10:00:00.200`, and commits immediately at `10:00:00.210`.

If a device syncs at `10:00:00.250`, it receives Transaction B (`last_cursor = 10:00:00.200`) before Transaction A is visible. A naive next query `WHERE updated_at > last_cursor` would permanently miss Transaction A.

### Reconnect Sync Rule (Phase 3)
1. **Safe Overlap Window (`CURSOR_OVERLAP_MS = 120_000` — 2 minutes):**
   - On reconnect (or periodic catch-up), each shop-scoped table queries:
     `WHERE shop_id = :shopId AND updated_at >= (:lastCursor - interval '120 seconds') ORDER BY updated_at ASC, id ASC`.
   - When `lastCursor` is absent (new device or cleared cache), perform a full paginated snapshot fetch (`ORDER BY updated_at ASC, id ASC`).
2. **Deterministic De-duplication by `(id, updated_at)`:**
   - Incoming rows from the overlap window (and from Supabase Realtime `postgres_changes` events) are merged into the local remote-mirror map keyed by `id`:
     - Replace the cached server row only when `incoming.updated_at >= existing.updated_at`.
     - Advance `lastCursor` to `max(existingCursor, maxIncomingUpdatedAt)` only after a complete page/batch succeeds.
   - Then run `reconcile(remoteMirror, localOptimistic, pendingQueue)` so unacknowledged local offline queue items stay visible on top of the server state until their `sync_operations` idempotency marker is confirmed.
3. **Realtime Is a Speed-Up Only:**
   - Supabase Realtime (`postgres_changes`) triggers immediate UI updates while connected, never advancing `lastCursor` past un-fetched gaps; reconnect and visibility/focus transitions always run the overlap-window cursor pull as the source of truth.

## 2. Bounded Offline Sale Window (Server-Time Plan Enforcement)
- Every authenticated RPC updates `shops.last_server_contact_at = clock_timestamp()`.
- When `record_sale_rpc` runs on the server:
  - If the shop is `is_deactivated = true` (`suspended`), reject new sales unless the sale's `client_created_at` was recorded inside a valid pre-suspension window, in which case evaluate the bounded offline window rule below.
  - Accept an offline sale's `client_created_at` as eligible inside `sales_access_until` **only** when `client_created_at` lies within the bounded offline window measured from `shops.last_server_contact_at` (e.g., `<= 72 hours` after last server contact, not in the future beyond 5 minutes clock skew, and `client_created_at < sales_access_until`).
  - Any queued offline sale outside that bounded window (while the shop is still within grace or recently expired) is **not silently dropped and not silently accepted as normal**: it is saved with `offline_window_flagged = true` and `offline_flag_reason` (or returned as a flagged sync item for owner/support review) so shopkeepers never lose records typed offline.

## 3. Backup Restore (`import_shop_backup` RPC)
- Decision B confirmed: **no live paying shops in Firebase**, so no Firebase bulk-export script is needed.
- Phase 3c will provide full validated in-app JSON backup restore supporting **both** legacy `shopbook-backup-v1` and CountUp `countup-backup-v2` exports, validating all totals, line math, customer debt balances, stock quantities, and foreign key references server-side inside one atomic transaction.

## 4. Phase 3b Atomic Write RPCs, Queue Batching & Ledger Reconciliation (`20261120000300`)
- **Write Authorization & Advisory Locking (`public.lock_authorized_shop_for_write`):**
  - Requires a verified shop session (`public.is_shop_owner(p_shop_id)` — i.e., JWT `shop_id === p_shop_id`, `shops.owner_user_id === auth.uid()`, and an active `shop_verified_sessions` row).
  - Acquires `pg_advisory_xact_lock(hashtext('shop_write:' || p_shop_id::text))` and `SELECT ... FOR UPDATE` on `public.shops` to serialize concurrent multi-device writes per shop cleanly without deadlocks.
- **Idempotency (`public.sync_operations`):**
  - Every write RPC checks `(shop_id, operation_id)` first; replays return `{ status: 'duplicate', idempotent: true, outcome, has_resolution }` without mutating stock, sales, or customer balances.
- **Core & Supporting RPCs (`src/data/shopWriteRpc.ts`):**
  - `public.record_sale`: computes all line totals, revenue, cost, `missing_cost_revenue_ngwee`, and `profit_ngwee` server-side in integer ngwee; clamps oversold stock at `0` (never negative, never dropping a sale) while inserting an unresolved `stock_conflicts` (`kind = 'shortfall'`) row and flagging `stock_movements.recount_needed = true`; enforces server-time `sales_access_until` and the bounded `72h` (`259,200s`) offline window (`offline_window_flagged` + `offline_flag_reason`).
  - `public.undo_sale`: soft-voids `sales.is_deleted = true`, restores only the physical units actually deducted (`GREATEST(0, -mv.delta)`), resolves open shortfall conflicts for that sale, returns `already-voided` on duplicate multi-device undos, and raises `CREDIT_BALANCE_CONFLICT` if customer debt was already repaid below the sale total.
  - `public.record_repayment` & `public.resolve_sync_conflict`: enforce `total_owed_ngwee >= amount_ngwee` and resolve credit conflicts (`keep-sale`, `cancel-payment`, `correct-payment`) with optimistic server-balance checks and `sync_correction` metadata.
  - `public.apply_stock_count` & `public.resolve_stock_conflict`: handle both `delta` adjustments and `set` physical counts (detecting stale `observed_quantity` without overwriting newer server stock, creating a `kind = 'recount'` conflict instead).
  - `public.upsert_shop_item`, `public.upsert_shop_customer`, `public.upsert_shop_expense`: preserve invariant columns (`quantity`, `total_owed_ngwee`) against metadata overwrites while writing `initial` stock movements on new item creation.
  - `public.apply_sync_batch`: processes up to `50` queued operations per RPC call (`SYNC_BATCH_CHUNK_SIZE = 50`) using per-operation PL/pgSQL subtransaction savepoints, committing earlier entries and stopping on the first conflict/error so strict FIFO ordering is preserved across 500+ item offline queues.
- **Ledger & Stock Reconciliation (`public.reconcile_shop_ledger`):**
  - Verifies four shop-wide / platform-wide invariants in one query report (`total_differences = 0`):
    1. `sales.total_amount_ngwee = SUM(sale_lines.line_total_ngwee)` and `items_count = SUM(sale_lines.quantity)`
    2. `sales.profit_ngwee = total_amount_ngwee - total_cost_ngwee - missing_cost_revenue_ngwee`
    3. `customers.total_owed_ngwee = SUM(non-deleted credit sales) - SUM(credit_payments)`
    4. `items.quantity = SUM(stock_movements.delta)` (initial + restocks + sales + voids + adjustments)

