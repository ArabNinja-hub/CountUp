# COUNTUP — M2 Security Remediation (C-01…C-07, C-09, C-10)

**Date:** 2026-11-02 (Africa/Lusaka)
**Branch:** `arena/cb51ea07-countup`
**Base (pre-remediation HEAD):** `4cb723a9d927a40c83239f5746c15473f626afc2`
**Commits:**
- `628dfa2` — commits the read-only adversarial review report (`docs/M2_SECURITY_REVIEW.md`)
- `08b44df` — implementation, migration `0008`, adversarial regression suites, config/CI
- this document — remediation report + operator runbook + validation evidence

**Verdict of the review remains in force: M3 is NOT APPROVED.** This milestone remediates
9 of the 10 reproduced findings. It does **not** implement M3, does not authorise M3, and
does not claim M2 is "secure" because tests pass. A fresh adversarial re-review is still
required before M3. C-08 (account enumeration) is deliberately deferred, as the review
classified it as non-blocking for M3 development.

No Firebase dependency, Firestore data/rules, Firebase Functions, Firebase Auth users,
frontend/`src/**`, `ShopContext.tsx`, legacy GitHub Pages build or production database was
touched. No credential, pepper, CSRF key or recovery share is committed. All database
tests used isolated in-memory PGlite or freshly created, immediately dropped databases on
the local PostgreSQL 18.6 server at `127.0.0.1:55432`.

---

## 0. Scope and mapping

| ID | Finding | Remediation | Regression tests |
| --- | --- | --- | --- |
| C-01 | Concurrent refresh race, no CAS, no reuse detection | Atomic compare-and-swap rotation + immutable refresh-hash history + family revocation + `session_version` bump + reuse alert | `test/live/refresh-concurrency.live.test.ts` (3, real PG), `test/auth/refresh-reuse.test.ts` (2) |
| C-02 | No admin bootstrap / deadlocked recovery / unaudited raw SQL | Audited, one-time, two-admin offline CLI + dual-share single-use break-glass recovery | `test/auth/admin-bootstrap.test.ts` (6), `test/live/admin-cli.live.test.ts` (5, real PG incl. built bundle) |
| C-03 | Process-local limiter, casing bypass, no signup limit | PostgreSQL-backed atomic shared limiter, canonical identifier normalisation, per-route limits on all `/auth/*` | `test/auth/rate-limit.test.ts` (4), `test/live/multi-instance-rate-limit.live.test.ts` (3, two real pools) |
| C-04 | Public dev pepper/CSRF secret, `NODE_ENV`-gated enforcement | Delete all fallback secrets; fail closed in **every** environment; explicit `Secure` cookie + origin/proxy config | `test/auth/secret-startup.test.ts` (11 real process starts), `test/auth/security-unit.test.ts` (23) |
| C-05 | Admin self-verification / unilateral admin-tier control | `assertAdminTargetAllowed`: no self-targeting, no admin-to-admin verification/reset; admin tier is break-glass-only | `test/auth/verification-transitions.test.ts` (2) |
| C-06 | Rejection leaves stale verification markers | Atomic transitions clearing all markers; DB CHECK + trigger make `users.identity_status` the single authoritative state | `test/auth/verification-transitions.test.ts` (2) |
| C-07 | Missing `Origin` + `Sec-Fetch-Site: none` bypass | Exact allowlisted `Origin` required for every unsafe method; `Sec-Fetch-Site` never accepted as proof; Host-derived self-origin only on non-production loopback | `test/auth/origin-guard.test.ts` (3 incl. raw-socket Host spoof) |
| C-09 | Arbitrary PII written into append-only audit tables | Strict allowlisted, size-bounded evidence schema + payload policy enforced in `writeSecurityAudit` and at the service boundary | `test/auth/audit-evidence.test.ts` (16) |
| C-10 | Audit writes not atomic with state changes | Every security-critical mutation and its audit row are one transaction; fault-injection tests on PGlite and real PG | `test/auth/audit-atomicity.test.ts` (2), `test/live/audit-rollback.live.test.ts` (3) |
| C-08 | Account enumeration | **Deferred** (review: does not block M3 development) | unchanged |

---

## 1. New versioned migration `0008_m2_security_remediation`

`migrations/0008_m2_security_remediation.up.sql` / `.down.sql`. No shop, inventory, sales,
credit, expense, payment, subscription, entitlement or other M3 business table. No RLS
(ADR-11 remains **PROVISIONAL / NOT APPROVED**). No admin credential or secret is seeded.

Added objects:

| Object | Purpose |
| --- | --- |
| `sessions.token_family_id` (+ index) | Identifies the whole refresh chain of one login |
| `refresh_token_history` (+ 2 indexes) | Records every issued refresh hash; a consumed hash is proof of reuse. Backfilled from existing sessions |
| `rate_limit_buckets` (+ index) | Shared atomic fixed-window counters (C-03) |
| `platform_bootstrap` (+ `deny_mutation` trigger) | One-row, one-time admin bootstrap record (C-02) |
| `admin_recovery_grants` (+ partial unique index) | Exactly one active dual-share break-glass grant; only SHA-256 digests stored |
| `users_verification_state_consistent` CHECK | `verified ⇔ identity_verified_at IS NOT NULL`; non-verified must have NO markers |
| `assert_verified_identity_marker()` + trigger | `auth_identities.verified_at` can only be set for a verified user (C-06) |

Data repair in the up script clears any pre-existing contradictory markers before the
CHECK/trigger are installed. The down script drops everything in reverse and was verified
on real PostgreSQL.

**Catalog after all eight up migrations, measured on real PostgreSQL 18.6:**

| Object | Before (7 migrations) | After (8 migrations) |
| --- | --- | --- |
| Tables (incl. `schema_migrations`) | 38 | **42** |
| Enum types | 19 | **19** |
| Foreign keys | 64 | **68** |
| Composite tenant FKs | 13 | **13** (unchanged) |
| CHECK constraints | 55 | **64** |
| Indexes | 115 | **124** |
| Triggers | 13 | **15** |
| Functions | 3 | **4** (`+ assert_verified_identity_marker`) |
| RLS policies | 0 | **0** |
| Tables with `shop_id` | 22 | **22** (unchanged) |

All eight down migrations execute in exact reverse order on the real server leaving only
`schema_migrations`, and all eight re-apply cleanly.

---

## 2. C-01 — Atomic refresh rotation and reuse detection

`apps/api/src/auth/auth-service.ts` → `refresh()`.

* Rotation is a **single atomic statement**:
  `UPDATE sessions SET … WHERE id = $1 AND refresh_token_hash = $old AND revoked_at IS NULL AND session_version = $n AND idle_expires_at > now() AND absolute_expires_at > now() RETURNING …`.
  Two concurrent callers race on the same row; the loser's `UPDATE` re-evaluates its
  `WHERE` after the winner commits and returns zero rows.
* Every issued refresh hash is recorded in `refresh_token_history` at login AND at each
  rotation. The old hash is marked `consumed_at` in the same transaction.
* If a consumed hash is presented (or the CAS loses a race), `revokeFamilyForReuse()`
  revokes **every session in that token family**, bumps `users.session_version` (so all
  of that user's sessions die), marks `reuse_detected_at` and writes
  `auth.session.refresh_reuse_detected` — all committed **before** the request is rejected
  with `401 unauthenticated` (no account oracle).
* Verified on real PostgreSQL 18.6 with two independent `pg` clients and an orchestrated
  90 ms delay on both CAS statements: exactly one of two concurrent refreshes succeeds.

## 3. C-02 — Administrator bootstrap and recovery

`apps/api/src/auth/admin-bootstrap.ts` (`AdminBootstrapService`) and
`apps/api/src/admin/admin-cli.ts` (`npm run admin:bootstrap` / `admin:recover`). Both are
bundled by `npm run api:build` into `apps/api/dist/admin-cli.mjs`. The migration runner's
`DEFAULT_MIGRATIONS_DIR` was changed to walk up from the module directory so it resolves
correctly from source, Vitest **and** the built bundle (verified by a live test).

Properties:

* **No hardcoded credentials.** Passwords come from operator-supplied environment
  variables; the CLI never accepts them in argv and never logs them.
* **One-time.** `platform_bootstrap.singleton` + `INSERT … ON CONFLICT DO NOTHING
  RETURNING` gate. A repeated or concurrent bootstrap is refused, its admins are rolled
  back, and `auth.admin.bootstrap_rejected` is written to the append-only audit table.
* **At least two distinct admins** are required, so losing one account is not a deadlock.
* **Dual control.** Two independently generated 256-bit recovery shares are printed ONCE;
  only their SHA-256 digests are stored. Recovery needs **both**, plus an explicit
  confirmation token. A single/wrong/replayed share changes nothing.
* **Single-use + rotation.** A successful recovery marks the grant used, resets the
  bootstrap admin's password, revokes all their sessions, bumps `session_version`, writes
  `auth.admin.break_glass_recovery` and issues fresh shares.
* **Fully auditable.** Success and rejection both write `platform_audit` rows inside the
  same transaction as the state change. There is no undocumented superuser SQL procedure.
* The CLI refuses to run on a schema that is not fully migrated, and refuses to bootstrap
  if `platform_admin` rows exist without a bootstrap record (i.e. hand-written SQL).

**Bootstrap admins are created with `identity_status='verified'` and
`identity_verified_by = NULL`** — this is an offline, dual-admin CLI operation, not an admin
verifying itself through HTTP. All HTTP self-administration remains forbidden (C-05).

> Runbook: §12 below.

## 4. C-03 — Shared rate limiting

`apps/api/src/auth/rate-limit.ts`: `RateLimiter` is now an async interface. The API runtime
always injects `PostgresRateLimiter` when a DB executor exists (`createApp`). Its counter is
one atomic statement:

```sql
INSERT INTO rate_limit_buckets (bucket_key, window_started_at, hit_count)
VALUES ($1, $2::timestamptz, 1)
ON CONFLICT (bucket_key) DO UPDATE
  SET hit_count = CASE WHEN window_started_at <= $3 THEN 1 ELSE hit_count + 1 END,
      window_started_at = CASE WHEN window_started_at <= $3 THEN $2 ELSE window_started_at END
RETURNING hit_count
```

* All instances share the same rows — two real API processes with separate `pg` pools
  produce `[401, 401, 429, 429]` for a `max: 2` login rule (a per-process `Map` would give
  `[401, 401, 401, 401]`).
* `normaliseLoginIdentifier()` is the single canonical normaliser used by **both** the
  limiter key and credential lookup; case/whitespace/phone-separator variants now share
  one bucket.
* A shared `globalIp` budget is mounted on **every** `/auth/*` route, plus route limits on
  login, signup, recovery request, recovery confirm, refresh and both admin endpoints.
* Buckets are pruned opportunistically (1 in 64 calls) of rows older than one day.
* `InMemoryRateLimiter` remains **only** as a test/DB-less-health-boot fallback; a DB-
  backed deployment never uses it.

## 5. C-04 — Secret configuration (fail closed)

* `DEV_PEPPER` / `DEV_CSRF_SECRET` were **deleted**. No fallback secret exists anywhere in
  deployable code (a unit test reads the source files to assert this).
* `resolveSecrets()` / `assertStrongSecret()` require `AUTH_PEPPER` and `CSRF_SECRET` in
  **every** `NODE_ENV`, with 32–512 chars, distinct values, ≥12 distinct characters, no
  long repeated runs, mixed character classes, and rejection of example/placeholder/dev
  strings. There is no staging/preview escape hatch.
* `PUBLIC_APP_ORIGIN` is parsed as an exact canonical absolute origin. In production it is
  **required**, HTTPS-only, and no Host-derived self-origin fallback exists. Paths,
  credentials, query strings, fragments, explicit default ports and non-HTTP schemes are
  rejected at startup.
* `COOKIE_SECURE` (`auto|true|false`) explicitly controls the `Secure` flag; `auto` is true
  in production or when any allowed origin is HTTPS. `COOKIE_SECURE=false` is refused in
  production.
* `TRUST_PROXY_HOPS` (1–10) is the only way forwarded headers are trusted; unset means
  `req.ip` is the direct peer.
* Eleven tests spawn the **real server process** and assert non-zero exit + a precise
  error for missing/short/placeholder/low-entropy/identical secrets, production without an
  origin allowlist, insecure cookies forced off and non-HTTPS production origins. The
  built `server.mjs` was also smoke-tested with and without secrets.
* Unredacted whole-error logging was removed (`app.ts` now logs only the error class).

## 6. C-05 — Separation of duties

`assertAdminTargetAllowed()` (`apps/api/src/auth/roles.ts`) is used by both admin routes:

* actor must be a DB-backed active `platform_admin`;
* `actor.id === target.id` → `403 admin_self_action`;
* target is another `platform_admin` → `403 admin_tier_protected`.

So an admin cannot verify itself, verify another admin, reset its own password or take over
a peer admin. Admin-tier recovery goes exclusively through the dual-control break-glass
CLI. Self-service `/auth/password/recovery/request` still creates **zero** reset tokens and
returns the same body for existing/unknown accounts. An admin can still verify/reset an
ordinary owner. Direct service-level calls are protected too.

## 7. C-06 — One authoritative verification state

* `users.identity_status` is the only state `requireVerified()` and `validateSession()`
  read, re-queried from PostgreSQL on every request.
* Approval and rejection are one transaction with the immutable
  `identity_verifications` row and the `platform_audit` row. Rejection clears
  `identity_verified_at`, `identity_verified_by` and **all** `auth_identities.verified_at`
  values. Re-approval restores a fully consistent state.
* DB-level `users_verification_state_consistent` CHECK and the
  `auth_identities_verified_at_guard` trigger reject any attempt to leave/restore a stale
  marker for a non-verified identity (tested with `23514`).
* Duplicate decisions for an already-current state are rejected (idempotency); the full
  `requested → approved → rejected → approved` history is preserved.

## 8. C-07 — Strict Origin validation

`originGuard()` now requires an exact, well-formed `Origin` in the validated allowlist for
**every** unsafe method. Missing/empty/`null`/malformed/mismatched/hostile origins all →
`403 cross_origin`. `Sec-Fetch-Site` is used only to reject `cross-site`/`same-site`
evidence; `none` grants no exemption and is never proof of origin. Production requires an
explicit allowlist. A Host-derived self-origin fallback exists only for non-production,
loopback peers with no allowlist configured (needed by the M0/M1 smoke route). A raw TCP
test with a spoofed `Host: evil.example` is rejected, closing the review's previously
unverified H-03 assumption.

## 9. C-09 — Audit evidence privacy

`apps/api/src/auth/audit-evidence.ts`:

* `adminVerifySchema` / `adminResetSchema` no longer accept `z.record(z.string(),
  z.unknown())`. Evidence is a `.strictObject()` allowlist of 7 bounded fields:
  `verification_method`, `document_type`, `document_reference_hash` (SHA-256 hex only),
  `reviewer_note` (≤120), `channel`, `id_checked`, `recovery_reference_hash`, with a
  512-byte total cap. Document references must be **hashed**, never raw IDs.
* `writeSecurityAudit()` runs `assertAuditPayload()` before the INSERT: ≤16 flat keys,
  ≤2048 bytes, no arrays/nested objects beyond the validated `evidence`, prohibited key
  patterns (`password`, `secret`, `token`, `hint`, `national`, `nid`, `ssn`, `email`,
  `phone`, `pin`, `dob`, `address`, `cookie`, `pepper`, `credential`, `raw`, …) and
  rejection of email/phone/national-ID/Argon2-hash strings anywhere in a value.
* `notes` are bounded to 160 chars and scanned for raw PII at both the Zod and service
  boundaries.
* A violation throws a typed `400 validation_error` before any append-only row is written;
  tests confirm prohibited fields never reach `platform_audit.payload` or
  `identity_verifications.evidence`, and that a 20 KB blob is rejected.

## 10. C-10 — Transactional audit consistency

All state changes with an audit event are now one `executor.transaction(...)`:
`signup`, `login` (unknown/locked/inactive/failed/succeeded), `createSession`, `refresh`
(incl. reuse revocation), `logout`, `changePassword`, `requestPasswordRecovery`,
`adminIssueResetToken`, `confirmPasswordReset`, `revokeSession`, `invalidateAllSessions`,
and `verifier.decide`/`recordRequest`. `writeSecurityAudit` validates before inserting so a
policy rejection also rolls back the state change.

Fault injection (`test/auth/failing-audit.ts`) makes **only** the audit INSERT fail, inside
transactions, on both PGlite and real PostgreSQL. The live suite additionally installs a
real `BEFORE INSERT` trigger on `platform_audit` that raises, proving the rollback with a
genuine database error. In every case sessions, credentials, counters, reset tokens,
identity state and decision rows remain unchanged and no partial audit row exists.

---

## 11. Test evidence (all commands actually executed, clean `npm ci`)

| Command | Result |
| --- | --- |
| `rm -rf node_modules && npm ci` | exit 0, **951 packages** |
| `npm run typecheck` / `typecheck:shared` / `typecheck:api` | exit 0 ×3 |
| `npm run lint` / `npm run format:check` | exit 0 ×2 |
| `npm test` (existing frontend) | **26 files / 185 tests passed** |
| `npm run test:db` (isolated PGlite) | **15 files / 139 tests passed** |
| `TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npm run test:db:live` | **14 files passed + 1 skipped / 111 passed, 11 skipped (122)** on real PostgreSQL 18.6 |
| `npm run build` | exit 0; `dist/assets/firebase-*.js` still emitted |
| `npm run api:build` | exit 0; `dist/server.mjs` + `dist/admin-cli.mjs`; `node --check` both OK |
| Built server smoke start | `[countup-api] listening … database not configured` with valid secrets; **exit 1 `EnvironmentError`** without |
| Built admin CLI | resolves migrations from `apps/api/dist/`, bootstraps a disposable real-PG database |
| `npm run functions:build` | exit 0 |
| YAML parse of all 3 workflows | exit 0 |
| Disposable DBs left by this phase | **0 new** (four pre-existing `countup_probe*`/`countup_cli_probe`/`countup_measure` scratch DBs from earlier phases remain on the isolated local server) |

The 11 skipped live-suite tests are the process-startup secret tests, deliberately run
only in the fast PGlite job (`describe.runIf(TEST_DATABASE_URL === undefined)`) to avoid
spawning the same process twice. The live suite adds the four real-server adversarial
files; `vitest.live.config.ts` still never falls back to PGlite.

`npm run test:db` grew from 7 files/76 tests to **15 files/139 tests**; the live suite from
3 files/45 tests to **15 files/122 tests**. CI builds the API bundles before both suites;
the built-CLI runbook test lives in the live suite and is exercised by the
`live-postgres` job. Hosted CI execution has **not** been observed (workflow dispatch was
blocked by 403 in earlier phases); all results above are from the local native
PostgreSQL 18.6 server.

---

## 12. Administrator bootstrap and recovery runbook (C-02)

All commands run **locally / on a trusted operator workstation**, never in a shared CI log.
Use a secret manager to inject the variables. `DATABASE_URL` must point at the intended
non-production-or-production database **that you control**; the CLI verifies all eight
migrations are applied before doing anything.

### 12.1 One-time bootstrap (creates ≥2 admins)

```bash
export NODE_ENV=production
export DATABASE_URL='postgresql://…/countup'
export AUTH_PEPPER='<64+ random chars, secret manager>'
export CSRF_SECRET='<64+ DIFFERENT random chars, secret manager>'
export PUBLIC_APP_ORIGIN='https://app.example.com'

npm ci
npm run db:migrate                      # all 8 versions, up only

export COUNTUP_BOOTSTRAP_CONFIRM='I_UNDERSTAND_THIS_CREATES_PLATFORM_ADMINS'
export COUNTUP_BOOTSTRAP_ADMIN_EMAIL='admin1@example.com'
export COUNTUP_BOOTSTRAP_ADMIN_PASSWORD='<strong password 1>'
export COUNTUP_BOOTSTRAP_ADMIN2_EMAIL='admin2@example.com'
export COUNTUP_BOOTSTRAP_ADMIN2_PASSWORD='<strong password 2>'

npm run admin:bootstrap
# Production equivalent: node apps/api/dist/admin-cli.mjs bootstrap
```

The CLI prints the two `COUNTUP_RECOVERY_SHARE_*` values **once**. Store them in two
separate secret-manager entries with two different custodians. Only SHA-256 digests are
stored in PostgreSQL. Clear the shell environment afterwards. Re-running the command
fails with `bootstrap already completed`, creates nothing, and writes
`auth.admin.bootstrap_rejected`.

Verify:

```sql
SELECT count(*) FROM users WHERE role = 'platform_admin';        -- 2
SELECT count(*) FROM platform_bootstrap;                         -- 1
SELECT count(*) FROM admin_recovery_grants WHERE used_at IS NULL;-- 1
SELECT action FROM platform_audit ORDER BY id;                   -- bootstrap_completed
```

### 12.2 Break-glass recovery (both admins lost access)

Requires **both** current shares plus an explicit confirmation:

```bash
export COUNTUP_RECOVERY_CONFIRM='I_UNDERSTAND_THIS_RESETS_THE_BOOTSTRAP_ADMIN_PASSWORD'
export COUNTUP_RECOVERY_SHARE_A='<custodian A>'
export COUNTUP_RECOVERY_SHARE_B='<custodian B>'
export COUNTUP_RECOVERY_NEW_PASSWORD='<new strong password>'
npm run admin:recover
# Production equivalent: node apps/api/dist/admin-cli.mjs recover
```

Effect (one transaction): the bootstrap admin's password is reset, all their sessions are
revoked, `session_version` is bumped, the grant is consumed, fresh shares are issued and
`auth.admin.break_glass_recovery` is written. Old shares are worthless afterwards. Grants
expire after 365 days; rotate by running recovery before expiry and storing the new pair.

**Why this is not an unaudited superuser SQL workaround:** there is no ad-hoc `UPDATE users
SET role=…` step in any runbook. Every privilege grant/reset goes through this CLI, is
gated by a one-time DB record or two independent shares, and leaves an append-only audit
row in the same transaction.

### 12.3 Operator precautions

* Never put passwords or shares in `.env` files that are committed, in argv, in CI logs,
  or in a ticket. `.env.example` documents names only.
* Bootstrap admins must be two **different people**; the two shares must have two
  **different custodians**. That is the dual control, not just two variables.
* Rotating `AUTH_PEPPER` invalidates all password hashes — plan a migration window.
* If admins exist in the DB but `platform_bootstrap` is empty (someone used raw SQL), the
  CLI refuses to bootstrap. Resolve that discrepancy deliberately, with an audit record.

---

## 13. Deployment configuration (C-04)

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_PEPPER` | **Always** | ≥32 chars, high entropy, not a placeholder, distinct from `CSRF_SECRET` |
| `CSRF_SECRET` | **Always** | same rules |
| `PUBLIC_APP_ORIGIN` | **production** | comma-separated exact HTTPS origins; no paths/credentials/trailing slashes |
| `COOKIE_SECURE` | optional (`auto`) | `auto` = Secure in production or when an allowed origin is HTTPS; `false` refused in production |
| `TRUST_PROXY_HOPS` | optional | 1–10; unset = do not trust `X-Forwarded-*` |
| `DATABASE_URL` | API runtime / CLI / migrations | never a production string in any committed file |
| `TEST_DATABASE_URL` | live tests only | isolated, disposable PostgreSQL 18 server; refuses non-loopback hosts |

Startup is fail-closed: a missing/weak/unsafe secret, a missing production origin
allowlist, an unsafe origin or `COOKIE_SECURE=false` in production throws
`EnvironmentError` **before** `app.listen()`.

---

## 14. Residual risks, deferred items and honest limitations

1. **C-08 (account enumeration)** is still present: duplicate-signup `409`,
   `account_locked` `429`, `account_inactive` `403`. The review classified it as
   non-blocking for M3 development; fix before production cutover.
2. **H-01…H-09 / I-01** from the review are unchanged: CSRF tokens are stateless and not
   session-bound/TTL-limited; reset tokens are still returned in the admin response body;
   no device binding/step-up auth; password policy is length-only; no pepper rotation;
   health endpoint discloses version/NODE_ENV; legacy Firebase `ensurePlatformAdmin`
   grants a Firebase custom claim, not a PostgreSQL role.
3. **Rate limiter clock skew:** the shared counter uses each instance's `Date.now()` for
   the window boundary. Instances must share NTP; large skew could allow a few extra
   requests. Bucket rows are pruned opportunistically rather than by a scheduled job.
4. **Bootstrap concurrency:** two simultaneous bootstrap CLIs using the *same* emails
   will collide on `users.primary_email` (SQLSTATE `23505`) rather than reaching the
   one-time gate. Either way the second attempt creates no extra admins; only the error
   text differs. Bootstrap is a one-time operator action, not a concurrent API path.
5. **Break-glass recovery reactivates** a suspended bootstrap admin (`status='active'`).
   That is intentional for a dual-control emergency path and is audited.
6. **`identity_verified_by` is NULL** for CLI-bootstrapped admins (offline dual-admin
   creation), while HTTP-verified owners have a distinct verifier. `identity_status`
   remains the sole authoritative state.
7. **ADR-09/10/11/14 remain PROVISIONAL — NOT APPROVED.** RLS is still disabled
   (0 policies) and M2 exposes no shop endpoints. M3 must add server-side `shop_id`
   scoping plus `requireVerified()` on every shop route and resolve ADR-11.
8. **Hosted CI has not been observed**; workflow dispatch was blocked by 403 in earlier
   phases. All live results are from the local native PostgreSQL 18.6 server.
9. **No production deployment, TLS/WAF/HSTS/CSP, secret manager or real dual-custodian
   process was exercised.** A local build and an isolated DB are not a deployment.
10. **C-01 reuse response is `401`** with no client-side signal — detection is in the
    audit log and the revoked session; there is no alerting integration yet.

---

## 15. Explicit status

The nine in-scope findings are remediated and covered by adversarial regression tests,
including real-PostgreSQL concurrency, two-instance rate limiting, real DB transaction
rollback, process-startup secret failures, separation-of-duties, verification transitions,
audit privacy and the full bootstrap/recovery runbook.

## **M3 REMAINS NOT APPROVED.**

No M3 implementation was started. Before M3 can even be re-reviewed, an independent
adversarial pass should confirm these fixes, C-08 should be scheduled for cutover, and
the M3 prerequisites (server-side `shop_id` scoping, `requireVerified()` on shop routes,
and a decision on provisional ADR-11) must be resolved. Passing 139 PGlite and 111
live-PostgreSQL tests is evidence of coverage, **not** a declaration that M2 is secure.
