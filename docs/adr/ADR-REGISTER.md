# CountUp Migration — ADR Register

**Status of this register:** maintained. **Four decisions were explicitly approved by
the project owner on 2026-11-02** (ADR-01, ADR-02, ADR-03, ADR-13 — see "Owner
approvals" below). The remaining areas are unresolved. Phase 2 M0/M1 deliberately did
not resolve architectural choices: it recorded them, labelled risky defaults as
*provisional*, and implemented only the reversible database structure that does not
depend on those choices being settled. M2 implements only the four approved areas.

**Source:** the 22 decision areas of the chat-only CountUp migration blueprint
(comprehensive technical audit → implementation-ready migration blueprint). That
blueprint was delivered in conversation and is **not** stored in this repository.
This register is the durable, in-repo record of its open decisions.

**Rule:** an item may move from `Proposed` / `Provisional` / `Blocked` to `Accepted`
only by an explicit, recorded approval from the project owner. Code in this
repository must never silently promote a provisional default to an approved
decision.

---

## Owner approvals — 2026-11-02

The project owner supplied the following four decisions with explicit approval.
These are the **authoritative ADR titles**; the register's earlier reconstruction of
these four IDs was a guess and is preserved verbatim under "Superseded
reconstruction" below. Original rows are not deleted or silently overwritten.

| ADR | Approved decision | Status | Approval date | Rationale (owner-stated constraints) | Consequence for M2 |
| --- | --- | --- | --- | --- | --- |
| **ADR-01** | **Opaque database-managed sessions** | **Accepted** | 2026-11-02 | Server authority over session state; no stateless client tokens. Avoids JWT and makes revocation/rotation verifiable in PostgreSQL. | 256-bit random opaque tokens, SHA-256 hashes only in `sessions`, idle 12 h / absolute 30 d, rotation invalidates old tokens, `session_version` invalidation. No JWT. |
| **ADR-02** | **Admin-assisted identity verification for the pilot. No unverified phone-number claims and no paid SMS dependency** | **Accepted** | 2026-11-02 | A typed phone number is not proof of identity. The pilot cannot depend on a paid SMS provider; verification must be an explicit, auditable human-assisted operation. | New accounts start `unverified`. A replaceable `IdentityVerifier` port with an admin-assisted implementation; trusted server-side role check; audit records. No SMS/email delivery integration. |
| **ADR-03** | **Password-only authentication. Retire the existing POS PIN. Do not introduce another PIN** | **Accepted** | 2026-11-02 | The legacy 4-digit plaintext POS PIN is unsafe. One credential type only. | Argon2id with unique salt + server-side pepper; `credentials` holds only hashes. The legacy PIN is **never** copied into any password/credential field. No OTP/PIN challenge flows. |
| **ADR-13** | **Owner-only pilot. No cashier/staff access in this milestone** | **Accepted** | 2026-11-02 | Reduce the authorisation surface for the pilot; staff/cashier roles are deferred. | Signup always creates `owner`; `requireOwner` server-side middleware rejects `staff` and unauthenticated requests. `platform_admin` is read from trusted DB state only, never from a request payload. |

### Scope caveats attached to these approvals

- **"Retire the existing POS PIN" (ADR-03) applies to the new backend only.** Per the
  strict scope restrictions, the legacy frontend, Firebase configuration, Firebase
  Auth users, Firestore data/rules and Functions are preserved as the read-only
  migration source and fallback. No frontend rewiring or deletion was performed.
- **ADR-02 does not authorise shop-claiming or migration-ownership workflows.** Those
  remain later-milestone work (ADR-15/16/17 still Blocked).
- **ADR-13 does not authorise a full admin console.** Only the minimum trusted
  server-side admin-assisted verification operation is implemented.
- All four approvals are **M2-scoped**. They do not approve production cutover,
  Render/Cloudflare provisioning, Firebase removal, or a merge to `main`.

---

## The four proposed defaults — PROVISIONAL, NOT APPROVED

These four are implemented **only as reversible, explicitly-flagged defaults** so
M0/M1 can be tested. They are **not** architecture decisions. Each must remain
labelled provisional until approved.

| ADR | Proposed default | Where it appears | Why it is still provisional | What approval must decide |
| --- | --- | --- | --- | --- |
| **ADR-09** | Business timezone `Africa/Lusaka`; `local_date` derived by `timezone('Africa/Lusaka', created_at)::date` | `migrations/0001_foundation.up.sql` (`set_local_date()`), `local_date` columns + triggers in `0003`, `shops.timezone` default, `system_config.timezone` with `is_provisional = true` | No owner confirmation; historical Firestore records may have been dated in device-local time, so a timezone change has migration implications | Confirm the timezone, DST/history handling, and how legacy local dates are back-filled |
| **ADR-10** | Money stored as `BIGINT` **ngwee** (100 ngwee = K1.00), `CHECK` constraints on every money column | Every `*_ngwee` column in `0003`/`0004`, `plans.price_ngwee`, `system_config.money_unit` with `is_provisional = true`, `packages/shared/src/money.ts` | No owner confirmation; changing representation later requires a data migration | Confirm integer minor units, rounding rules, and whether any fractional amounts exist in legacy data |
| **ADR-11** | Tenant isolation = application-level `shop_id` scoping **plus** database composite FKs; PostgreSQL RLS is optional and **NOT enabled** | `migrations/0003`/`0004`/`0005` (`UNIQUE (shop_id, id)`, 13 composite FKs), commented-out RLS block in `0006`, `system_config.tenant_isolation` with `is_provisional = true` | Requires a decision about the API's database role and per-transaction shop claim before RLS can be correct; enabling it half-way would be a false sense of security | Decide whether RLS becomes mandatory, which role the API uses, how `app.current_shop_id` is set, and how it is tested |
| **ADR-14** | Retain the historical `zamtel` value in `momo_operator` / `payment_network` | `migrations/0003`/`0004` enums, `system_config.retain_zamtel_operator` with `is_provisional = true` | Legacy Firestore records contain `zamtel`; dropping it would break historical import, but the operator list is not confirmed | Confirm the operator list and the treatment of legacy `zamtel` rows |

`system_config` enforces this in data: exactly four rows have
`is_provisional = true` (`timezone`, `money_unit`, `tenant_isolation`,
`retain_zamtel_operator`). `apps/api/test/schema-constraints.test.ts` asserts this.
`packages/shared/src/system-config.ts` exposes `PROVISIONAL_CONFIG_KEYS`.

---

## Full register (22 decision areas)

Legend: **Accepted** = explicitly approved by the owner (date in the approvals
section); **Blocked** = cannot proceed without an owner decision; **Provisional** =
implemented only as a flagged, reversible default; **Proposed** = design direction
from the blueprint, not accepted; **Not started** = no implementation work in M0/M1.

| ADR | Decision area | Status | Implemented in M0/M1? | Blocking? |
| --- | --- | --- | --- | --- |
| **ADR-01** | **Opaque database-managed sessions** *(owner-authoritative title)* | **Accepted 2026-11-02** | M0/M1: `sessions` table only. M2: implemented. | No — unblocked |
| **ADR-02** | **Admin-assisted identity verification for the pilot; no unverified phone claims, no paid SMS** *(owner-authoritative title)* | **Accepted 2026-11-02** | M0/M1: nothing. M2: implemented. | No — unblocked |
| **ADR-03** | **Password-only authentication; retire the existing POS PIN; no new PIN** *(owner-authoritative title)* | **Accepted 2026-11-02** | M0/M1: `credentials` table only. M2: implemented. | No — unblocked |
| **ADR-04** | Authentication methods: phone OTP, email/password, PIN, or a combination | Blocked | Tables only (`credentials`, `otp_challenges`, `password_reset_tokens`); **no auth implemented** | Yes — explicitly blocked |
| **ADR-05** | Server session lifecycle: rotation, absolute/idle expiry, device limits, revocation | Blocked | `sessions` table only | Yes — explicitly blocked |
| **ADR-06** | Authorisation: owner/staff/platform_admin roles, shop membership, permission matrix | Proposed | `user_role`, `shop_role`, `shop_members`, `entitlement_snapshots` tables only | Yes — before M2 endpoints |
| **ADR-07** | Offline sync: IndexedDB outbox replacing the localStorage queue, conflict resolution | Blocked | Tables only (`sync_operations`, `sync_conflict_reviews`, `change_log`) | Yes — before sync work |
| **ADR-08** | Idempotency semantics and sync conflict review policy | Blocked | `idempotency_keys` + unique `(shop_id, device_id, client_operation_id)` | Yes |
| **ADR-09** | Business timezone / `local_date` = `Africa/Lusaka` | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-10** | Money representation = `BIGINT` ngwee | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-11** | Tenant isolation = application scoping + optional RLS | **Provisional — NOT APPROVED** | Yes, composite FKs + RLS deliberately disabled and commented out | Yes |
| **ADR-12** | Plan catalogue and trial/warning/grace policy ownership | Proposed | Seeded from the existing frontend constants (30/5/3 days; 9900/26900/49900 ngwee) with provenance comments | No, but owner must confirm policy |
| **ADR-13** | **Owner-only pilot; no cashier/staff access in this milestone** *(owner-authoritative title)* | **Accepted 2026-11-02** | M0/M1: role enums/tables only. M2: `requireOwner` middleware. | No — unblocked |
| **ADR-14** | Retain historical `zamtel` operator value | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-15** | Migration approach: dual-write vs batch import, reconciliation strategy | Blocked | `migration_runs`, `migration_shop_results`, `legacy_id_map` tables only | Yes — before any data migration |
| **ADR-16** | Legacy Firestore ID mapping and per-entity reconciliation | Blocked | `legacy_*` columns + `legacy_id_map` table only | Yes |
| **ADR-17** | Cutover mode, reversibility and rollback criteria | Blocked | `cutover_config` table only; **no cutover implemented** | Yes |
| **ADR-18** | Backup, restore drills, retention and RPO/RTO | Blocked | `backup_runs`, `restore_drills` tables only | Yes |
| **ADR-19** | Observability: logging, metrics, alerting, error budgets | Blocked | `/health/live` and `/health/ready` only | Yes |
| **ADR-20** | Data export/portability and retention policy | Blocked | `export_jobs` table only | Yes |
| **ADR-21** | API versioning, rate limiting, WAF and abuse controls | Proposed | `/v1/echo` foundation validation route + 32 KB JSON limit only | Yes |
| **ADR-22** | Environment secrets, key rotation and production credential handling | Blocked | `apps/api/src/config/env.ts` (Zod validation), no secrets committed | Yes |

**Cross-references to the approvals (original rows retained, not relabelled):**

- ADR-04 (authentication methods) and ADR-05 (session lifecycle) are now **resolved in
  practice for M2** by owner approvals ADR-03 (password-only) and ADR-01 (opaque
  database-managed sessions). Their rows above keep the original M0/M1 status text as
  history; the acceptance is recorded in the approvals section.
- ADR-06 (authorisation) is constrained for M2 by owner approval ADR-13 (owner-only).
- ADR-09/10/11/14 remain **provisional — NOT APPROVED**. The four owner approvals do
  not touch them.

### Superseded reconstruction — preserved decision history

On 2026-11-02 the register's initial reconstruction of the chat-only blueprint used
the following four titles. The owner then supplied the authoritative titles recorded
above. These rows are kept **verbatim** so the decision history is not lost; the
reconstructed titles are **superseded**, not silently edited.

| ADR ID | Reconstructed title (superseded) | Original status | Now |
| --- | --- | --- | --- |
| ADR-01 | Target topology: Cloudflare DNS/WAF → Render Node/TS/Express API → managed PostgreSQL | Proposed | Superseded by owner ADR-01; topic moved to open area O-1 |
| ADR-02 | Frontend hosting: keep GitHub Pages SPA vs move to Cloudflare Pages | Proposed | Superseded by owner ADR-02; topic moved to open area O-2 |
| ADR-03 | Account identity model replacing device-bound Firebase Anonymous UID | Blocked | Superseded by owner ADR-03; topic moved to open area O-3 |
| ADR-13 | Manual payment proof storage, evidence retention and review workflow | Blocked | Superseded by owner ADR-13; topic moved to open area O-4 |

**Open areas displaced by the clarification (still unresolved; no ADR ID assigned):**

| Ref | Open area | Status |
| --- | --- | --- |
| O-1 | Target topology: Cloudflare DNS/WAF → Render API → managed PostgreSQL | Proposed, blocking before any deployment |
| O-2 | Frontend hosting: keep GitHub Pages SPA vs Cloudflare Pages | Proposed, blocking before cutover |
| O-3 | Account identity model replacing device-bound Firebase Anonymous UID | Blocked, needed before legacy data migration |
| O-4 | Manual payment proof storage, evidence retention and review workflow | Blocked, explicitly out of scope for M2 |

---

## Scope history

### Originally out of scope for M0/M1 (historical, preserved)

- API authentication, OTP, PIN, password reset flows (**ADR-03/04/05**)
- Payment-proof upload/review and payment reference policy (**ADR-13**)
- Shop registration, sales/credit/expense services, entitlement enforcement (**ADR-06/12**)
- Frontend rewiring, `ShopContext.tsx` changes, Firebase removal or migration (**ADR-02/15**)
- Production cutover, Render/Cloudflare provisioning, backup/restore execution (**ADR-01/17/18**)
- Any merge to `main` or deployment

### Now in scope for M2 only (following the 2026-11-02 approvals)

- Password-only account registration/login, Argon2id credentials, opaque DB-managed
  sessions, refresh/rotation/revocation, password change and recovery
  (ADR-01 / ADR-03 / ADR-04 / ADR-05).
- Admin-assisted identity verification with audit records; unverified accounts cannot
  reach protected resources (ADR-02).
- Owner-only server-side authorisation; no staff/cashier access (ADR-13 / ADR-06).

### Still out of scope after M2

- Shop registration, inventory, sales, credit, expenses, reports, payments,
  subscriptions, entitlement services (M3+).
- Shop-claiming / migration-ownership workflows, full admin console.
- Firebase removal or modification, Firestore data deletion, frontend rewiring,
  `ShopContext.tsx` changes, production cutover, Render/Cloudflare provisioning.
- Any merge to `main`, any deployment, any dual-write to Firestore.

## Change log

| Date | Change |
| --- | --- |
| 2026-11-02 | Register created for Phase 2 M0/M1. All 22 areas unresolved; four provisional defaults explicitly flagged. |
| 2026-11-02 | Owner approved ADR-01 (opaque DB-managed sessions), ADR-02 (admin-assisted identity verification), ADR-03 (password-only auth, retire POS PIN), ADR-13 (owner-only pilot). Superseded reconstruction rows preserved verbatim; four displaced open areas recorded as O-1..O-4; M2 scope added. ADR-09/10/11/14 remain provisional and NOT approved. |
