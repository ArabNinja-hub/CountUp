# CountUp Migration — ADR Register

**Status of this register:** maintained, but **no decision in it has been approved**.
Phase 2 M0/M1 deliberately does not resolve architectural choices. It records them,
labels risky defaults as *provisional*, and implements only the reversible database
structure that does not depend on those choices being settled.

**Source:** the 22 decision areas of the chat-only CountUp migration blueprint
(comprehensive technical audit → implementation-ready migration blueprint). That
blueprint was delivered in conversation and is **not** stored in this repository.
This register is the durable, in-repo record of its open decisions.

**Rule:** an item may move from `Proposed` / `Provisional` / `Blocked` to `Accepted`
only by an explicit, recorded approval from the project owner. Code in this
repository must never silently promote a provisional default to an approved
decision.

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

Legend: **Blocked** = cannot proceed without an owner decision; **Provisional** =
implemented only as a flagged, reversible default; **Proposed** = design direction
from the blueprint, not accepted; **Not started** = no implementation work in M0/M1.

| ADR | Decision area | Status | Implemented in M0/M1? | Blocking? |
| --- | --- | --- | --- | --- |
| **ADR-01** | Target topology: Cloudflare DNS/WAF → Render Node/TS/Express API → managed PostgreSQL | Proposed | Foundation folders and Express app only; no provisioning | Yes — before any deployment |
| **ADR-02** | Frontend hosting: keep GitHub Pages SPA vs move to Cloudflare Pages | Proposed | No. Existing Vite/GitHub Pages build untouched | Yes — before cutover |
| **ADR-03** | Account identity model replacing device-bound Firebase Anonymous UID | Blocked | Tables only (`users`, `auth_identities`, `legacy_owner_uid`) | Yes — before M2 auth |
| **ADR-04** | Authentication methods: phone OTP, email/password, PIN, or a combination | Blocked | Tables only (`credentials`, `otp_challenges`, `password_reset_tokens`); **no auth implemented** | Yes — explicitly blocked |
| **ADR-05** | Server session lifecycle: rotation, absolute/idle expiry, device limits, revocation | Blocked | `sessions` table only | Yes — explicitly blocked |
| **ADR-06** | Authorisation: owner/staff/platform_admin roles, shop membership, permission matrix | Proposed | `user_role`, `shop_role`, `shop_members`, `entitlement_snapshots` tables only | Yes — before M2 endpoints |
| **ADR-07** | Offline sync: IndexedDB outbox replacing the localStorage queue, conflict resolution | Blocked | Tables only (`sync_operations`, `sync_conflict_reviews`, `change_log`) | Yes — before sync work |
| **ADR-08** | Idempotency semantics and sync conflict review policy | Blocked | `idempotency_keys` + unique `(shop_id, device_id, client_operation_id)` | Yes |
| **ADR-09** | Business timezone / `local_date` = `Africa/Lusaka` | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-10** | Money representation = `BIGINT` ngwee | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-11** | Tenant isolation = application scoping + optional RLS | **Provisional — NOT APPROVED** | Yes, composite FKs + RLS deliberately disabled and commented out | Yes |
| **ADR-12** | Plan catalogue and trial/warning/grace policy ownership | Proposed | Seeded from the existing frontend constants (30/5/3 days; 9900/26900/49900 ngwee) with provenance comments | No, but owner must confirm policy |
| **ADR-13** | Manual payment proof storage, evidence retention and review workflow | Blocked | Tables only (`subscription_payments`, `payment_proofs`, `payment_reference_locks`) | Yes — explicitly blocked |
| **ADR-14** | Retain historical `zamtel` operator value | **Provisional — NOT APPROVED** | Yes, flagged in `system_config` | Yes |
| **ADR-15** | Migration approach: dual-write vs batch import, reconciliation strategy | Blocked | `migration_runs`, `migration_shop_results`, `legacy_id_map` tables only | Yes — before any data migration |
| **ADR-16** | Legacy Firestore ID mapping and per-entity reconciliation | Blocked | `legacy_*` columns + `legacy_id_map` table only | Yes |
| **ADR-17** | Cutover mode, reversibility and rollback criteria | Blocked | `cutover_config` table only; **no cutover implemented** | Yes |
| **ADR-18** | Backup, restore drills, retention and RPO/RTO | Blocked | `backup_runs`, `restore_drills` tables only | Yes |
| **ADR-19** | Observability: logging, metrics, alerting, error budgets | Blocked | `/health/live` and `/health/ready` only | Yes |
| **ADR-20** | Data export/portability and retention policy | Blocked | `export_jobs` table only | Yes |
| **ADR-21** | API versioning, rate limiting, WAF and abuse controls | Proposed | `/v1/echo` foundation validation route + 32 KB JSON limit only | Yes |
| **ADR-22** | Environment secrets, key rotation and production credential handling | Blocked | `apps/api/src/config/env.ts` (Zod validation), no secrets committed | Yes |

---

## Explicitly out of scope for M0/M1 (do not treat as decided)

- API authentication, OTP, PIN, password reset flows (**ADR-03/04/05**)
- Payment-proof upload/review and payment reference policy (**ADR-13**)
- Shop registration, sales/credit/expense services, entitlement enforcement (**ADR-06/12**)
- Frontend rewiring, `ShopContext.tsx` changes, Firebase removal or migration (**ADR-02/15**)
- Production cutover, Render/Cloudflare provisioning, backup/restore execution (**ADR-01/17/18**)
- Any merge to `main` or deployment

## Change log

| Date | Change |
| --- | --- |
| 2026-11-02 | Register created for Phase 2 M0/M1. All 22 areas unresolved; four provisional defaults explicitly flagged. |
