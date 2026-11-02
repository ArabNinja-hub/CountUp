# COUNTUP — Phase 2, Milestones M0 + M1 (Backend Foundation & Database)

> **Historical document — preserved as written at the end of M0/M1.** A later M2
> milestone added the seventh versioned migration `0007_m2_auth`, and M2 security
> remediation added the eighth (`0008_m2_security_remediation`), so the migration counts
> below describe the M1 state only. See `docs/POSTGRESQL_LIVE_VALIDATION.md` §10–11,
> `docs/M2_AUTHENTICATION_IMPLEMENTATION.md` §12 and
> `docs/M2_SECURITY_REMEDIATION.md` for the current schema. No text in this report has
> been rewritten to hide those changes.

**Date:** 2026-11-02 (Africa/Lusaka)
**Scope:** M0 (clean backend foundation) + M1 (PostgreSQL schema and DB tests) **only**.
**Base:** Phase 1 commit `5a2ea63542d046ef163bbf923511d84ddbaca5a7`.
**Branch:** `arena/cb51ea07-countup` (see "Version control" below).
**Stop condition:** work stops here. No M2 or later milestone has been started.

---

## 0. Verification of the starting point

| Check | Result |
| --- | --- |
| Repository | `/home/user/CountUp`, `ArabNinja-hub/CountUp` |
| Working tree before Phase 2 | clean |
| `git cat-file -t 5a2ea63542d046ef163bbf923511d84ddbaca5a7` | `commit` (present) |
| HEAD at Phase 2 start | `5a2ea63` = Phase 1 commit (already pushed) |
| `origin/main`, `origin/arena/cb51ea07-countup` | both present |
| Existing Firebase paths | unchanged in this phase |
| Existing frontend runtime | unchanged in this phase |

### Branch note (important)

The user asked for a **dedicated Phase 2 branch based on the Phase 1 commit**. This
Arena session is pinned to `arena/cb51ea07-countup`; the environment does not permit
creating, switching to, or pushing any other branch. The constraint *is* satisfied in
substance: `arena/cb51ea07-countup` is already a dedicated working branch whose HEAD
**is** the Phase 1 commit, and all Phase 2 work lives exclusively on it. Nothing was
committed or pushed to `main`, and nothing was merged into `main`. A separate local
branch name was deliberately not fabricated, because a branch with no work on it would
be misleading.

---

## 1. Exact architecture and folder structure

```
CountUp/
├── apps/api/                          # NEW — Node.js + TypeScript + Express foundation
│   ├── package.json                  # workspace @countup/api
│   ├── tsconfig.json                 # strict, noEmit, ES2022/ESM
│   ├── vitest.config.ts              # node env, forks, inline @countup/shared
│   ├── src/
│   │   ├── app.ts                    # createApp(): health routes, Zod validation, 404/error handlers
│   │   ├── server.ts                 # 0.0.0.0 listener, optional pg Pool, graceful shutdown
│   │   ├── config/env.ts             # Zod deployment-env schema (NOT business config)
│   │   ├── db/
│   │   │   ├── query-executor.ts     # QueryExecutor: query()/exec()/transaction() + 3 adapters
│   │   │   ├── migrations.ts         # discovery, SHA-256 checksums, ledger, up/down/status
│   │   │   └── migrate-cli.ts        # tsx CLI, production guard
│   │   └── http/validate.ts          # parseWith / validateBody / RequestValidationError
│   └── test/
│       ├── isolated-database.ts      # ONLY test DB: fresh in-memory PGlite
│       ├── fixtures.ts               # parameterised INSERT helpers
│       ├── migrations.test.ts
│       ├── schema-constraints.test.ts
│       ├── tenant-isolation.test.ts
│       ├── append-only.test.ts
│       └── http-foundation.test.ts
├── packages/shared/                  # NEW — dependency-free shared kernel
│   ├── package.json                  # workspace @countup/shared
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── plan-catalog.ts           # server-safe mirror of shared/subscriptionPlans.ts
│       ├── system-config.ts          # canonical system_config keys + provisional flags
│       └── money.ts                  # ngwee conversion/formatting (pure)
├── migrations/                       # NEW — 6 versioned pairs (12 SQL files)
│   ├── 0001_foundation.{up,down}.sql
│   ├── 0002_identity.{up,down}.sql
│   ├── 0003_shops_business.{up,down}.sql
│   ├── 0004_payments_audit.{up,down}.sql
│   ├── 0005_sync.{up,down}.sql
│   └── 0006_ops_migration.{up,down}.sql
├── docs/
│   ├── adr/ADR-REGISTER.md            # NEW — 22 unresolved ADRs, 4 provisional defaults
│   └── backend/M0-M1-REPORT.md        # NEW — this file
├── .github/workflows/backend-db.yml  # NEW — CI foundation for backend/DB tests
├── .env.example                      # MODIFIED — backend deployment vars documented (no secrets)
├── package.json                      # MODIFIED — workspaces + 10 new scripts
├── package-lock.json                 # MODIFIED — regenerated for the workspaces
├── tsconfig.json                     # MODIFIED — excludes apps/** and packages/** from root typecheck
└── [all existing frontend / Firebase / Functions / rules / workflows UNCHANGED]
```

**Layering:** `packages/shared` has zero runtime dependencies. `apps/api` depends on
`@countup/shared`, `express`, `pg`, `zod`. Migrations are pure SQL files at the repo root,
read by the runner — no ORM, no query builder, no code generation, no abstraction
layers beyond the small `QueryExecutor` port needed to run the same SQL on `pg` and on
the isolated test database.

**Runtime separation of configuration:** deployment identity (connection string, port,
log level, environment) is validated by Zod in `apps/api/src/config/env.ts`. Business
settings (trial/warning/grace days, currency, timezone, money unit, tenant policy,
Zamtel retention) live in the `system_config` **table** and are seeded by migration
0001 — never in environment variables. This is the "separate system-settings config
design" required by M0.

---

## 2. All files created / modified

**4 modified:** `.env.example`, `package.json`, `package-lock.json`, `tsconfig.json`.

**38 created:**

| Area | Files |
| --- | --- |
| CI | `.github/workflows/backend-db.yml` |
| Docs | `docs/adr/ADR-REGISTER.md`, `docs/backend/M0-M1-REPORT.md` |
| Migrations (12) | `migrations/0001_foundation.up.sql`, `.down.sql`; `0002_identity.up/down.sql`; `0003_shops_business.up/down.sql`; `0004_payments_audit.up/down.sql`; `0005_sync.up/down.sql`; `0006_ops_migration.up/down.sql` |
| `packages/shared` (6) | `package.json`, `tsconfig.json`, `src/index.ts`, `src/plan-catalog.ts`, `src/system-config.ts`, `src/money.ts` |
| `apps/api` config (3) | `package.json`, `tsconfig.json`, `vitest.config.ts` |
| `apps/api/src` (7) | `app.ts`, `server.ts`, `config/env.ts`, `db/query-executor.ts`, `db/migrations.ts`, `db/migrate-cli.ts`, `http/validate.ts` |
| `apps/api/test` (7) | `isolated-database.ts`, `fixtures.ts`, `migrations.test.ts`, `schema-constraints.test.ts`, `tenant-isolation.test.ts`, `append-only.test.ts`, `http-foundation.test.ts` |

**Explicitly NOT touched:** `src/**` (including `ShopContext.tsx`), `shared/subscriptionPlans.ts`
(frontend file), `functions/**`, `firestore.rules`, `firebase*.json`, `.firebaserc`,
`public/**`, `scripts/**`, `vite.config.ts`, `server.ts` (frontend dev server),
`index.html`, `.github/workflows/deploy-pages.yml`, `.github/workflows/firestore-rules.yml`,
`README.md`. Firebase dependencies and runtime integration remain intact; auth,
screens, and offline behaviour are unchanged.

`dist/`, `functions/lib/`, and `node_modules/` are gitignored and are not part of the
patchset.

---

## 3. Schema / migration inventory

Six versioned pairs, each with a matching `down` script. Applied in order, each in its
own transaction, recorded in `schema_migrations` (`version`, `checksum`, `applied_at`).

| Version | Tables / objects created | Highlights |
| --- | --- | --- |
| `0001_foundation` | `plans`, `system_config`; types `user_role`, `user_status`, `shop_role`, `identity_kind`; functions `set_updated_at()`, `set_local_date()`, `deny_mutation()` | 3 plan rows (monthly 9900 / quarterly 26900 / biannual 49900 ngwee); 9 `system_config` rows, 4 flagged `is_provisional = true` |
| `0002_identity` | `users`, `auth_identities`, `credentials`, `sessions`, `otp_challenges`, `password_reset_tokens` | partial unique indexes (legacy UID, primary identity), session expiry indexes, `INET` for IP, `set_updated_at()` trigger |
| `0003_shops_business` | `shops`, `shop_members`, `entitlement_snapshots`, `items`, `customers`, `credit_payments`, `sales`, `sale_items`, `credit_ledger_entries`, `stock_movements`, `stock_conflicts`, `expenses`; 8 enums | all money `BIGINT` ngwee with CHECKs; `UNIQUE (shop_id, id)` on 5 parents; 11 composite tenant FKs; `set_local_date()` on 3 tables; `deny_mutation()` on 2 ledgers |
| `0004_payments_audit` | `subscription_payments`, `payment_reference_locks`, `payment_proofs`, `platform_audit`, `provider_events`; 2 enums | `BIGSERIAL` append-only audit with GIN payload index; globally unique payment reference; 1 composite FK on proofs |
| `0005_sync` | `idempotency_keys`, `sync_operations`, `sync_conflict_reviews`, `change_log`; 2 enums | unique `(shop_id, device_id, client_operation_id)`; GIN payload index; append-only change feed; 1 composite FK |
| `0006_ops_migration` | `migration_runs`, `migration_shop_results`, `legacy_id_map`, `cutover_config`, `backup_runs`, `restore_drills`, `export_jobs`; 2 enums | tracking/reconciliation only; **commented-out RLS block, NOT enabled** |

**Total (queried from the migrated database):** 36 blueprint tables +
`schema_migrations` = **37 public tables**, **60 foreign keys**, **13 composite
`(shop_id, …)` foreign keys**, **18 enum types**, **51 CHECK constraints**,
**113 indexes**, **12 triggers** (5 `set_updated_at`, 3 `set_local_date`,
4 `deny_mutation`), and **0 RLS policies**.

### Blueprint Section 3 table checklist (36/36)

| Group | Tables |
| --- | --- |
| Identity | `users`, `auth_identities`, `credentials`, `sessions`, `otp_challenges`, `password_reset_tokens` |
| Platform config | `plans`, `system_config` |
| Shops / membership / entitlements | `shops`, `shop_members`, `entitlement_snapshots` |
| Inventory | `items`, `stock_movements`, `stock_conflicts` |
| Sales | `sales`, `sale_items` |
| Customers / credit | `customers`, `credit_payments`, `credit_ledger_entries` |
| Expenses | `expenses` |
| Subscription payments | `subscription_payments`, `payment_reference_locks`, `payment_proofs` |
| Platform audit / provider | `platform_audit`, `provider_events` |
| Sync / idempotency / conflicts | `idempotency_keys`, `sync_operations`, `sync_conflict_reviews`, `change_log` |
| Migration / reconciliation | `migration_runs`, `migration_shop_results`, `legacy_id_map`, `cutover_config` |
| Backup / export | `backup_runs`, `restore_drills`, `export_jobs` |

### Notable schema decisions (all evidence-based, all reversible)

- **Tenant isolation:** every one of the 22 tenant tables has `shop_id` with a direct
  FK to `shops(id)`. Six parents (`items`, `customers`, `sales`, `credit_payments`,
  `subscription_payments`, `sync_operations`) expose `UNIQUE (shop_id, id)` so 13
  child references use composite `(shop_id, parent_id)` FKs. PostgreSQL itself rejects
  a cross-shop reference with SQLSTATE `23503`. Application-level scoping remains the
  *primary* mechanism; RLS is not enabled (provisional ADR-11).
- **Money:** all money columns are `BIGINT` ngwee with `CHECK` constraints;
  `sale_items.line_total_ngwee = quantity * unit_price_ngwee` is enforced in the DB.
- **Append-only:** `platform_audit`, `change_log`, `stock_movements`,
  `credit_ledger_entries` use a `BEFORE UPDATE OR DELETE` trigger that raises
  `P0001`.
- **Enums aligned with existing frontend types:** `momo_operator` = mtn/airtel/zamtel,
  `stock_movement_type` = initial/sale/restock/adjustment/void,
  `expense_category` = rent/transport/restock/council_fee/helper_wage/other,
  `expiry`/`trial`/`grace` values from `src/types/index.ts` and `src/config/plans.ts`.
- **Known mapping to resolve later (not silently chosen):** the frontend's
  `plan_status` literal `pending_payment` maps to the blueprint's `manual_pending`.
  This is listed as an open reconciliation item, not implemented as a conversion.

---

## 4. Dependency inventory and justification

Only three runtime packages were added to `apps/api`, two dev packages, and one
existing root dev dependency was reused. Every added package has one clear purpose.

| Package | Version | Where | Purpose / justification |
| --- | --- | --- | --- |
| `pg` | `8.23.1` | `apps/api` dependency | Maintained Node PostgreSQL driver for the **runtime** API and migration CLI. Node `>=16`, works on CI's Node 22. Chosen over ORMs because M1 is pure versioned SQL. |
| `@types/pg` | `8.23.1` | `apps/api` devDependency | Type definitions for `pg` under `strict` TS. |
| `@electric-sql/pglite` | `0.5.14` | `apps/api` devDependency | **Isolated test database only.** PostgreSQL 18.6 compiled to WASM; no Docker, no server, no secrets. Verified to support enums, `gen_random_uuid()`, `plpgsql` triggers, `INET`, `BIGSERIAL`, GIN, partial indexes, CHECKs, composite FKs and transactional DDL. |
| `@countup/shared` | `0.1.0` | workspace link | Dependency-free shared kernel (plan catalogue, system-config keys, money helpers). |
| `express` | `4.22.3` | already a root dependency, re-declared in `apps/api` | HTTP foundation. No new version. |
| `zod` | `4.6.7` | already a root dependency, re-declared in `apps/api` | Environment and request validation. No new version. |
| `tsx`, `typescript`, `vitest`, `eslint`, `prettier`, `@types/express`, `@types/node` | existing | root devDependencies | Already present from Phase 1; reused, not re-installed. |

`npm install --package-lock-only` regenerated `package-lock.json` for the two
workspaces; `npm ci` installs 947 packages (up from 944). Note that `firebase-tools`
already brings `@electric-sql/pglite@0.3.16` to the root `node_modules`; our
`0.5.14` is installed nested under `apps/api/node_modules` and is the one the tests
resolve. No dependency was removed. Firebase 13's pre-existing `EBADENGINE`
warnings (requires Node `>=24.12`, CI uses Node 22) remain non-fatal and unchanged.

### Testcontainers: evaluated and rejected for this milestone

**Testcontainers is unsuitable in this environment.** Verified absence of `docker`,
`podman`, `postgres`, `initdb`, `pg_ctl`, `psql`, `pg_config`; `docker info` fails.
Testcontainers requires a working Docker daemon to start a PostgreSQL container, so
it cannot run here or in the current CI without new infrastructure.

**Alternative used:** a fresh in-memory **PGlite** instance per test. It is real
PostgreSQL (not a mock): the WASM build executes the same SQL parser, constraint and
trigger machinery. `apps/api/test/isolated-database.ts` is the only database the
suite ever talks to — it has no `dataDir`, no TCP listener, no wire protocol and never
reads `DATABASE_URL` or `TEST_DATABASE_URL`, so the tests **cannot** reach production
or even development data. A dedicated test asserts this even when both variables are
set to a plausible production URL.

**Limitations (documented, not hidden):**

1. PGlite is not a network server and does not speak the `pg` wire protocol. The
   `pg` driver path (`createPgClientExecutor`, `createPgPoolExecutor`, `migrate-cli.ts`)
   is typechecked and used by the app, but the *runtime* migration CLI against a real
   PostgreSQL server was **not executed** here — no server exists. Hosted verification
   against a real PostgreSQL service remains outstanding.
2. PGlite `query()` uses prepared statements and rejects multi-statement SQL;
   `exec()` must be used for migration files. The `QueryExecutor` port enforces that
   split and is verified by the migration tests.
3. PGlite is single-connection. Concurrency, connection pooling, lock contention,
   `LISTEN/NOTIFY`, replication and production performance are **not** covered.
4. PGlite version drift from the managed PostgreSQL version is possible; CI should
   later add a real-PostgreSQL job (with a `services: postgres` container) before
   cutover. That is explicitly deferred, not assumed to pass.

---

## 5. Migration / rollback instructions

```bash
# 1) Point at a NON-PRODUCTION PostgreSQL database only.
export NODE_ENV=development
export DATABASE_URL='postgresql://user:password@localhost:5432/countup_dev'

# 2) Inspect what is pending (read-only; creates the ledger table if absent).
npm run db:status

# 3) Apply pending migrations, in order, one transaction per version.
npm run db:migrate

# 4) Roll back the single most recently applied version (repeat for more).
npm run db:migrate:down
```

**Safety properties:**

- The CLI **refuses to run when `NODE_ENV=production`** and requires `DATABASE_URL`
  explicitly; it never uses a default/hosted connection string.
- Each up/down version runs inside `BEGIN … COMMIT`; a failed statement rolls back
  that version's DDL **and** its ledger row (verified by test).
- Applied migration checksums are SHA-256 of the up file; `migrateUp` throws on a
  checksum mismatch instead of silently re-running edited SQL.
- `down` scripts exist for all six versions and are verified in a full
  up → down → up cycle.
- Tests never invoke the CLI and never read `DATABASE_URL`; they use a fresh PGlite
  instance per test.
- No production data was touched. No migration was run against any external database.
- CLI guards were executed: `npm run db:status` without `DATABASE_URL` exits 1 with
  the usage message; `npm run db:migrate` with `NODE_ENV=production` exits 1 with
  "Refusing to run migrations with NODE_ENV=production". Neither attempted a
  connection.

Optional override: `MIGRATIONS_DIR` (validated by Zod) points at an alternative SQL
directory; it is used by the failure-injection test with a temp directory.

---

## 6. Test results (all actually executed)

### 6.1 Database / backend suite — `npm run test:db`

```
Test Files  5 passed (5)
     Tests  44 passed (44)
  Duration  83.76s (Vitest 3.2.7, Node 22.22.3, PGlite 0.5.14 / PostgreSQL 18.6)
```

| Suite | Tests | Coverage |
| --- | --- | --- |
| `migrations.test.ts` | 8 | 6 paired up/down files, ordered apply, idempotency, checksum immutability, 37-table inventory, full up→down→up, seeded data preserved, failed-migration DDL rollback, failed-transaction DML rollback |
| `schema-constraints.test.ts` | 13 | seeded plan values (9900/26900/49900), `system_config` (30/5/3 + 4 provisional flags), plan CHECK/unique, 7 monetary CHECK failures, fractional-money rejection, line-total CHECK, 8 unique constraints, FK enforcement (`23503`), `ON DELETE RESTRICT` (`23001`), cascade, `set_local_date()`/`set_updated_at()`, SQL-injection-as-data, valid same-shop relationships |
| `tenant-isolation.test.ts` | 6 | 22 tenant tables each with `shop_id` + direct `shops(id)` FK, 6 `UNIQUE (shop_id, id)` parents, 13 composite FKs, **all 13 cross-shop attempts rejected with `23503`**, all same-shop controls accepted, RLS/policies = 0, scoped reads return only the tenant's rows |
| `append-only.test.ts` | 7 | `platform_audit` insert/monotonic `BIGSERIAL`/UPDATE+DELETE rejected (`P0001`), immutability of `stock_movements`, `credit_ledger_entries`, `change_log`, mutable tables still mutable, rollback of DML and DDL after failed transactions, successful commit + connection reuse |
| `http-foundation.test.ts` | 10 | Zod env defaults/rejections, `parseWith` typed errors, `/health/live`, `/health/ready` against PGlite, invalid query → 400, no DB → 503, body validation + unknown-key stripping, malformed JSON → 400, oversized body → 413, 404, `x-powered-by` disabled, **test DB never reads `DATABASE_URL`/`TEST_DATABASE_URL`** |

### 6.2 Full existing-app checks — all executed, all passed

| Command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | exit 0, 947 packages (9 non-fatal Firebase `EBADENGINE` warnings) |
| `npm run typecheck` (root/frontend) | exit 0 |
| `npm run typecheck:shared` | exit 0 |
| `npm run typecheck:api` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run format:check` | exit 0 — "All matched files use Prettier code style!" |
| `npm test` (existing frontend) | **26 files / 185 tests passed** (unchanged) |
| `npm run test:db` | **5 files / 44 tests passed** |
| `npm run build` | exit 0, 1,819 modules; `dist/assets/firebase-*.js` still emitted |
| YAML parse of all 3 workflows | `js-yaml` + PyYAML both exit 0 |

`npm run functions:build` was not re-run in Phase 2 because no `functions/**` file
changed; it passed in Phase 1.

**Clean-room CI simulation (executed):** `rm -rf node_modules && npm ci` (947
packages) followed by *every* check above — `typecheck`, `typecheck:shared`,
`typecheck:api`, `lint`, `format:check`, `test:db` (44/44), `npm test` (185/185),
`build` — all exited 0. This validates the regenerated root `package-lock.json`
with the two new workspaces from a completely empty `node_modules`.

**Not executed / not claimed:** hosted GitHub Actions run of the new
`backend-db.yml` (workflow dispatch was blocked in Phase 1 by `403 Resource not
accessible by integration`); the `pg` migration CLI against a live PostgreSQL server
(no server available); Testcontainers (no Docker). All are explicitly listed as
outstanding verification, not as passing results.

---

## 7. CI foundation

`.github/workflows/backend-db.yml` — **"Backend & Database"**, triggered on push
(excluding `gh-pages`), pull requests, and `workflow_dispatch`; `contents: read`
only; Node 22; `npm ci` pinned to the root `package-lock.json`. Steps:

`typecheck` → `typecheck:shared` → `typecheck:api` → `lint` → `format:check` →
`test:db` → `test` → `build`.

It requires **no secrets, no Docker daemon, no service container and no database**:
`test:db` boots its own in-memory PGlite. Running the existing frontend checks in the
same job guarantees the Phase 2 additions do not regress the deployed SPA. Nothing
in this workflow deploys, publishes, or touches Firebase.

---

## 8. Security and tenant-isolation verification

| Property | How it is enforced | Verified by |
| --- | --- | --- |
| Shop cannot reference another shop's records | 22 tenant tables with `shop_id` FK; 6 parents expose `UNIQUE (shop_id, id)`; 13 composite `(shop_id, parent_id)` FKs | `tenant-isolation.test.ts`: all 13 cross-shop inserts rejected with `23503`; all same-shop controls accepted |
| Application-level scoping | `shop_id` bind parameter on every query; no table name is interpolated from input; `countRows`-style dynamic SQL was removed from fixtures | `schema-constraints.test.ts` injection test (`'); DROP TABLE plans; --` stored as data, `plans` intact) and scoped-read test |
| Parameterised SQL only | `QueryExecutor.query(sql, values)` with `$1…$n`; migration files use `exec()`; no string concatenation of values anywhere in `apps/api` or `migrations/` | reviewed + injection test + all fixtures |
| Append-only audit | `deny_mutation()` `BEFORE UPDATE OR DELETE` trigger on 4 tables | `append-only.test.ts` → `P0001` for 6 mutation attempts |
| Monetary integrity | `BIGINT` ngwee + CHECKs + line-total identity | `schema-constraints.test.ts` (7 negative cases + fractional rejection) |
| Transaction atomicity | `BEGIN`/`COMMIT`/`ROLLBACK` on one connection; pool adapter checks out one client per transaction | `migrations.test.ts`, `append-only.test.ts` |
| No production data access | CLI refuses `NODE_ENV=production`; tests never read `DATABASE_URL`/`TEST_DATABASE_URL`; no external DB connection in the suite | `http-foundation.test.ts` + CLI source |
| No secrets committed | `.env.example` contains only placeholders; `.gitignore` still excludes `.env*` (with `!.env.example`); no credentials in any file | repository diff review |
| Existing app untouched | No `src/**`, Firebase, Functions, or rules changes | `git diff` vs Phase 1 |
| RLS | **Deliberately NOT enabled** — ADR-11 provisional. Composite FKs + app scoping are the enforced mechanisms; a commented RLS block documents the pending decision | `tenant-isolation.test.ts` asserts `pg_class.relrowsecurity` count = 0 and `pg_policies` count = 0 |

**Residual risk (stated, not hidden):** RLS is not enabled, so a future endpoint that
forgets to filter by `shop_id` could leak data. M0/M1 contains no data-returning
business endpoints (only health checks and a validation smoke route), so there is no
such endpoint today. Enabling RLS requires the blocked ADR-11 decision on the API
database role and per-transaction shop claim.

---

## 9. ADR register / unresolved decisions

See **`docs/adr/ADR-REGISTER.md`** — 22 decision areas, **all unresolved**. Four are
explicitly **PROVISIONAL — NOT APPROVED** and are flagged both in that register and in
the database (`system_config.is_provisional = true`):

1. `Africa/Lusaka` business timezone (ADR-09)
2. `BIGINT` ngwee money (ADR-10)
3. Application-level scoping with optional RLS, RLS disabled (ADR-11)
4. Retain historical `zamtel` operator value (ADR-14)

Blocked decisions (auth/OTP/PIN/session, payment proof/review, cutover, migration,
backup, monitoring) were **not** implemented, not guessed, and not marked approved.
`plan_status` `pending_payment` → `manual_pending` mapping is recorded as an open
reconciliation item.

---

## 10. Version control

- **Branch:** `arena/cb51ea07-countup` (session-fixed dedicated working branch)
- **Phase 1 base:** `5a2ea63542d046ef163bbf923511d84ddbaca5a7`
- **Phase 2 implementation commit:** `3bf16fba0531373ac1ee444419bc1c0b9ce2dd98`
  (42 files: 4 modified, 38 created). The small follow-up commit that records this
  hash and corrects the file count is the HEAD of the branch; `3bf16fb` is the
  commit containing all implementation work.
- **Not done:** no merge to `main`, no push to `main`, no PR, no deployment, no
  production provisioning.

---

## 11. Stop condition — what was NOT done

No M2+ work was started. Specifically **not** implemented: API authentication, OTP,
PIN or password flows; shop registration; sales/credit/expense/entitlement services;
frontend rewiring or `ShopContext.tsx` changes; Firebase dependency removal or runtime
changes; Firestore data/rules/config/Functions changes; customer/shop record
migration; production cutover; Render or Cloudflare provisioning; backups/restore
execution; any merge to `main`.

Existing application continues to work exactly as before (all 185 pre-existing tests
and the production build still pass).
