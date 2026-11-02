# COUNTUP — M2 Authentication Implementation

**Date:** 2026-11-02 (Africa/Lusaka)
**Branch:** `arena/cb51ea07-countup`
**Prerequisite gate:** `docs/POSTGRESQL_LIVE_VALIDATION.md` — **PASS** on real
PostgreSQL 18.6 before M2 work began.
**Scope:** M2 only. No M3 shops/entitlements, inventory, sales, credit, expenses,
reports, payments, subscriptions, frontend rewiring, Firebase changes, cutover,
deployment or merge to `main`.

---

## 1. Approved decisions driving this milestone

The owner approved four ADRs on 2026-11-02 (recorded with rationale and preserved
history in `docs/adr/ADR-REGISTER.md`):

| ADR | Decision | Effect here |
| --- | --- | --- |
| ADR-01 | Opaque database-managed sessions | 256-bit random tokens, SHA-256 hashes only in PostgreSQL, rotation/revocation/`session_version`; **no JWT** |
| ADR-02 | Admin-assisted identity verification, no unverified phone claims, no paid SMS | `unverified` by default; replaceable `IdentityVerifier` port + `AdminAssistedIdentityVerifier`; immutable audit; **no SMS/email delivery** |
| ADR-03 | Password-only auth; retire the POS PIN; no new PIN | Argon2id only, one credential type, no OTP/PIN challenges; legacy PIN is never copied into any field |
| ADR-13 | Owner-only pilot; no cashier/staff access | Signup always creates `owner`; `requireOwner` server-side guard; no staff signup path |

**Scope caveat:** "retire the existing POS PIN" applies to the **new backend only**.
Per the strict scope restrictions, the legacy frontend/Firebase configuration, Auth
users, Firestore data/rules and Functions remain untouched as the read-only
migration source and fallback. No frontend rewiring or deletion was performed.

ADR-09/10/11/14 remain **provisional — NOT APPROVED**; RLS is still not enabled.

---

## 2. Implemented features

- **Dedicated `AuthService`** (`apps/api/src/auth/auth-service.ts`) — all DB/business
  logic: registration, hashing/verification, login, session create/validate/refresh/
  revoke, password change/recovery, account status, lockout, `session_version`
  invalidation. Route handlers only parse input, call the service, set cookies and
  map errors.
- **Argon2id** (`@node-rs/argon2@2.2.2`, native binding) with a unique random salt
  per hash and a **server-side pepper** (`AUTH_PEPPER`, required in production)
  mixed in via HMAC-SHA256 before hashing. Stored string is standard
  `$argon2id$v=19$m=19456,t=2,p=1$...`. Plaintext passwords are never stored or
  logged; the legacy POS PIN is never migrated.
- **Opaque DB-managed sessions (ADR-01)** — two independent 256-bit tokens
  (`session`, `refresh`), only their SHA-256 hex digests stored. Idle 12 h (sliding,
  capped at absolute), absolute 30 d. Refresh rotates **both** hashes so old tokens
  die immediately. `users.session_version` invalidation kills every session.
- **Admin-assisted identity verification (ADR-02)** — `IdentityVerifier` port with
  `AdminAssistedIdentityVerifier`. Signup records a `pending_review` audit row and
  leaves `identity_status='unverified'`. Only a trusted `platform_admin` (role read
  from PostgreSQL) can approve/reject; the decision is written to the immutable
  `identity_verifications` table and `platform_audit`. No unverified phone claim is
  trusted; `auth_identities.verified_at` is set only on approval. No SMS/email
  integration exists, and the port is replaceable.
- **Password recovery (B4)** — generic, non-revealing request endpoint; random
  hashed single-use 30-minute reset tokens; admin-assisted, controlled and audited
  issuance; reset revokes all sessions and bumps `session_version`. No hardcoded
  admin credentials, no recovery secrets in Git.
- **Owner-only authorization (ADR-13)** — `requireOwner` on `/auth/me`,
  `/auth/password/change`, `/auth/sessions` and `/auth/sessions/:id/revoke`.
  `requirePlatformAdmin` on admin operations. Roles always come from the DB, never
  from request payloads (strict Zod `.strict()` schemas reject extra fields).
- **Security middleware** — CSRF, Origin/`Sec-Fetch-Site`, cookie policy, rate
  limits, failed-login tracking, lockout, `no-store`, consistent error envelope,
  security audit events.

---

## 3. API endpoints

All `/auth/*` routes use Zod validation and the uniform error envelope
`{ error: <code>, message?, details? }`. Unsafe methods require a signed
double-submit CSRF token and a same-origin request.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/auth/csrf` | none | Issues the CSRF cookie and returns the token |
| `POST` | `/auth/signup` | none | Account registration (always `owner`, `unverified`) |
| `POST` | `/auth/login` | none | Password login; sets session + refresh cookies |
| `GET` | `/auth/me` | session + owner | Current authenticated user (safe fields only) |
| `POST` | `/auth/refresh` | refresh cookie | Rotates both tokens; old tokens invalid |
| `POST` | `/auth/logout` | session | Revokes the current session, clears cookies |
| `POST` | `/auth/password/change` | session + owner | Verify current password, set new, revoke other sessions |
| `POST` | `/auth/password/recovery/request` | none | Generic 202; identical for existing/unknown accounts |
| `POST` | `/auth/password/recovery/confirm` | reset token | Single-use reset; revokes all sessions |
| `GET` | `/auth/sessions` | session + owner + verified | Lists sessions (no token hashes) |
| `POST` | `/auth/sessions/:id/revoke` | session + owner + verified | Revokes one owned session |
| `POST` | `/auth/admin/identity-verifications/:userId/verify` | session + platform_admin | Admin-assisted approve/reject with evidence |
| `POST` | `/auth/admin/password-reset/:userId` | session + platform_admin | Audited operator handoff of a one-time reset token |

`GET /health/live`, `GET /health/ready` and the M0/M1 `POST /v1/echo` smoke route are
retained. **No endpoint implying shop registration, inventory, sales, credit,
expenses, payments or subscriptions was added.**

### Sample shapes

```jsonc
// POST /auth/signup -> 201
{ "userId": "…", "identityStatus": "unverified" }
// POST /auth/login -> 200 (tokens ONLY in Set-Cookie)
{ "user": { "id": "…", "displayName": "…", "role": "owner",
            "identityStatus": "unverified", "primaryEmail": "…", "primaryPhone": null } }
// POST /auth/password/recovery/request -> 202 (same body for unknown accounts)
{ "accepted": true, "message": "If the account exists, a recovery request has been recorded." }
```

---

## 4. Session lifecycle

1. **Login** generates two `randomBytes(32)` (256-bit) base64url tokens. `sessions`
   stores `sha256(token)` in `session_token_hash` and `refresh_token_hash`, plus
   `created_at`, `idle_expires_at = now + 12 h`, `absolute_expires_at = now + 30 d`,
   IP, user agent and the user's current `session_version`.
2. **Cookies** — `countup_session` (Path=/) and `countup_refresh`
   (Path=/auth/refresh): `HttpOnly`, `SameSite=Lax`, **`Secure` only in production**;
   local development omits `Secure`. `countup_csrf` is readable by JS
   (double-submit) and is also `SameSite=Lax`.
3. **Validation** — `GET`-protected middleware reads the opaque token, hashes it,
   joins `sessions` + `users`, and rejects if: revoked, expired (idle or absolute),
   account not active, or `sessions.session_version <> users.session_version`.
   Successful validation slides `idle_expires_at` to `min(now + 12 h,
   absolute_expires_at)`.
4. **Refresh** — `/auth/refresh` looks up by `refresh_token_hash`, applies the same
   checks, generates two new tokens, overwrites both hashes and sets `rotated_at`.
   The previous session token hash no longer exists → reuse returns 401.
5. **Logout / revocation** — sets `revoked_at` and `revoke_reason`.
6. **Password change** — revokes all *other* sessions; the current one survives.
7. **Password reset / `invalidateAllSessions`** — revokes **all** sessions and
   increments `users.session_version`, invalidating every token even if a row was
   missed.
8. **No JWT.** No stateless client token, no token in any JSON response or log.

---

## 5. Identity-verification process (ADR-02)

```
signup -> users.identity_status = 'unverified'
       -> identity_verifications(status='pending_review', decision='requested')
       -> platform_audit('identity.verification_requested')
       -> auth_identities.verified_at IS NULL
```
- A phone number supplied at signup is stored as an unverified contact identity;
  it is **never** treated as proof of identity.
- `GET /auth/sessions` (the M2 account-security surface) additionally requires
  `requireVerified`, so unverified accounts receive `403 unverified_identity`. There
  are **no shop-data endpoints in M2**; the same guard will be reused for them in M3.
- Only a `platform_admin` whose role is read from PostgreSQL can approve:
  `identity_verifications` gets an immutable `approved` row with evidence and
  `reviewed_by`; `users.identity_status='verified'`,
  `identity_verified_at/by` are set; `auth_identities.verified_at` is set; a
  `platform_audit` row is written.
- Admin accounts are **not** creatable through signup. They are provisioned
  out-of-band by a trusted server-side DB operation (tests do this directly). No
  hardcoded administrator credentials exist.
- `IdentityVerifier` is an interface; an OTP provider can replace
  `AdminAssistedIdentityVerifier` later without changing `AuthService` or routes.
- Shop-claiming / migration-ownership workflows are **not** implemented.

---

## 6. Password recovery process

1. `POST /auth/password/recovery/request { identifier }` always returns the **same**
   `202` body. It writes an audit event with a *hashed* identifier and does not
   create a token (there is no delivery integration).
2. A trusted `platform_admin` calls
   `POST /auth/admin/password-reset/:userId { evidence }`. This is CSRF-protected,
   role-checked and audited (`auth.password_recovery.admin_token_issued`). The
   response returns a raw reset token **once**, explicitly for an out-of-band
   operator handoff — no email/SMS integration is implied.
3. `password_reset_tokens` stores only `sha256(token)` with `expires_at = now + 30
   min`, `is_admin_initiated=true`, `initiated_by`, `requested_ip`, and `used_at`.
4. `POST /auth/password/recovery/confirm { token, newPassword }` consumes the row in
   a transaction (`used_at` set once → reuse returns `400 invalid_token`), rehashes
   the password with Argon2id, clears `failed_attempts`/`locked_until`, revokes all
   sessions, bumps `session_version`, and writes an audit event.
5. No recovery secret is committed; `.env*` remains gitignored except the
   placeholder `.env.example`.

---

## 7. Security controls

| Control | Implementation |
| --- | --- |
| CSRF | Signed double-submit (`nonce.HMAC-SHA256(CSRF_SECRET, nonce)`), cookie value must equal `x-csrf-token`, constant-time comparison. Applied to **all** unsafe methods globally, including the M0/M1 echo route. |
| Origin / Sec-Fetch-Site | `originGuard` rejects `cross-site`/`same-site`/`none`-mismatches, origins not equal to the request's own origin or `PUBLIC_APP_ORIGIN`, and requests with neither header. |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Secure` in production; refresh cookie path-scoped; `no-store, no-cache, must-revalidate, private` on every API response. |
| Secrets | `AUTH_PEPPER` (>= 32 chars) and `CSRF_SECRET` (>= 32 chars) are **required in production**, otherwise `EnvironmentError`. Clearly-labelled non-secret dev fallbacks outside production. |
| Rate limits | In-process fixed-window limiter: global per-IP, per-IP login, per-identity login, per-IP recovery. Returns `429 rate_limited`. |
| Failed-login tracking | `credentials.failed_attempts`, `locked_until`; **5 failures → 15-minute lockout** (`429 account_locked`), reset on success. Unknown identifiers use a dummy Argon2 verification to equalise timing. |
| Error consistency | One `AuthError` envelope; unknown identifier and wrong password both return `401 invalid_credentials`; recovery request never reveals account existence. |
| Request validation | Zod `.strict()` schemas on every body; UUID params validated; unknown keys rejected (no role/userId injection). |
| Authorization | `requireAuth` → `requireOwner` / `requireVerified` / `requirePlatformAdmin`; roles loaded from PostgreSQL on every request and re-checked inside admin operations. |
| Audit | Append-only `platform_audit` rows for signup, login success/failure, refresh, logout, password change/recovery, verification decisions, session revocation and invalidation. Payloads contain only hashed identifiers — never tokens, passwords or pepper. |
| Token storage | Only SHA-256 digests; no raw token or password hash in any response, log or audit payload. |
| SQL | 100% parameterised (`$1…$n`); no dynamic SQL from user input. |
| Encryption/TLS | Not implemented in M2 — deployment concern (known limitation). |

---

## 8. Database changes

New versioned pair **`migrations/0007_m2_auth.up.sql` / `.down.sql`** (with checksum
recorded in `schema_migrations` and a verified down script):

- New enum `identity_verification_status` (`unverified`, `pending_review`,
  `verified`, `rejected`).
- `users`: `session_version INT`, `identity_status`, `identity_verified_at`,
  `identity_verified_by` (FK to `users`).
- `sessions`: `session_version INT`, `rotated_at`, `last_ip`; CHECK on expiry order
  retained from M1.
- `password_reset_tokens`: `is_admin_initiated`, `initiated_by`, `requested_ip`,
  `CHECK (expires_at > created_at)`.
- New immutable table `identity_verifications` (status, decision, evidence JSONB,
  notes, `reviewed_by`) with a `deny_mutation()` trigger and a user index.
- **No** shop/business tables, **no** RLS policies, **no** changes to Firebase.

Catalog after all seven migrations (verified on real PostgreSQL 18.6): 38 tables,
19 enums, 64 FKs (13 composite tenant FKs unchanged), 55 CHECKs, 115 indexes,
13 triggers, 0 RLS policies, 22 tables with `shop_id`.

---

## 9. Test results (all actually executed)

### Live PostgreSQL 18.6 (`npm run test:db:live`, `TEST_DATABASE_URL` set)

```
Test Files  3 passed (3)
     Tests  45 passed (45)
```
- 13 Phase A migration/constraint/pool/API validation tests (see
  `docs/POSTGRESQL_LIVE_VALIDATION.md`).
- **24 M2 authentication integration tests running against the real `pg` driver
  and a fresh disposable PostgreSQL database per test.**
- 8 pure unit tests (tokens, CSRF, Argon2id, cookies, env secrets).

### Default PGlite suite (`npm run test:db`)

```
Test Files  7 passed (7)
     Tests  76 passed (76)
```
44 M1 tests + 24 M2 auth integration + 8 M2 unit tests.

### Phase C coverage map (24 integration tests)

| # | Test | # | Test |
| --- | --- | --- | --- |
| 1 | Successful signup | 13 | Password recovery |
| 2 | Duplicate identity rejection | 14 | Reset revokes all sessions |
| 3 | Argon2id hashing / unique salt / pepper | 15 | Unverified identities blocked |
| 4 | Successful login | 16 | Admin-assisted verification only via trusted server ops |
| 5 | Incorrect password rejection | 17 | Unauthenticated access → correct error |
| 6 | Lockout after 5 failures | 18 | Owner-only rejects staff/cashier |
| 7 | Session creation (hashes only) | 19 | CSRF rejects invalid requests |
| 8 | Session persistence across requests | 20 | Cross-origin state-changing requests rejected |
| 9 | Refresh + token rotation | 21 | Rate limiting works |
| 10 | Old session token rejected | 22 | `session_version` invalidation |
| 11 | Logout invalidates session | 23 | Session listing/revocation exposes no hashes |
| 12 | Password change | 24 | No private API response caching |

### Full repository verification (clean install)

| Command | Result |
| --- | --- |
| `rm -rf node_modules && npm ci` | exit 0, 951 packages |
| `npm run typecheck` / `typecheck:shared` / `typecheck:api` | exit 0 ×3 |
| `npm run lint` / `npm run format:check` | exit 0 ×2 |
| `npm test` (existing frontend) | **26 files / 185 tests passed** |
| `npm run test:db` | **7 files / 76 tests passed** |
| `npm run test:db:live` | **3 files / 45 tests passed** (real PG 18.6) |
| `npm run build` | exit 0; `dist/assets/firebase-*.js` still emitted |
| `npm run api:build` | exit 0; `apps/api/dist/server.mjs` 47.5 kB; `node --check` + smoke start OK |
| `npm run functions:build` | exit 0 |
| YAML parse of all 3 workflows | `js-yaml` exit 0 |

---

## 10. Known limitations

1. **In-process rate limiter.** Single-process only; a multi-instance deployment
   must replace `RateLimiter` with a shared store (Redis/PostgreSQL). Lockout state
   itself *is* in PostgreSQL.
2. **CSRF is stateless signed double-submit**, not session-bound synchroniser
   tokens. Combined with `SameSite=Lax`, strict Origin/`Sec-Fetch-Site` checks and
   `Secure` cookies in production this is sound, but a session-bound token is
   stronger and can be adopted later.
3. **Secrets** must be supplied via env in production; development fallbacks are
   deliberately non-secret and must never be used in production. No automated
   pepper/CSRF key rotation is implemented.
4. **No TLS, WAF, reverse-proxy hardening, HSTS, CSP or production origin
   configuration** — deployment concerns outside M2.
5. **No email/SMS delivery.** Recovery tokens are handed over by a trusted admin
   out-of-band. There is no self-service completion without an operator.
6. **No admin console / no admin self-service signup.** `platform_admin` accounts
   are provisioned by trusted server-side DB operations only.
7. **No shop-claiming or migration-ownership workflows.** No shop-data endpoints
   exist in M2, so `requireVerified` is applied to account-security surfaces and
   will be reused for shop routes in M3.
8. **Staff/cashier accounts** cannot be created through signup; they can only exist
   if provisioned directly in the DB, and every protected owner route rejects them.
9. **`pg` returns `BIGINT` as a string**, PGlite as a number (documented in the live
   validation report). M2 reads only `INT`/`TEXT`/`TIMESTAMPTZ`, so no coercion
   issue arises here; M3 money code must parse explicitly.
10. **Hosted CI not verified.** A `live-postgres` job using a `services: postgres:18`
    container was added, but workflow dispatch was blocked by `403 Resource not
    accessible by integration` in earlier phases; this hosted run has not been
    observed. All live-PG results above are from the local native PostgreSQL 18.6
    server in the sandbox, not from hosted CI.
11. **No production deployment.** `AUTH_PEPPER`/`CSRF_SECRET` production enforcement
    is unit-tested, not deployed. A local build is not a production deployment.
12. **Timing** — unknown-identifier logins use a dummy Argon2 verify but still take
    a different DB path; a constant-time full equivalence is not guaranteed.

---

## 11. Manual verification instructions

### Start a real PostgreSQL server (no Docker required on Linux/macOS)

```bash
# Real PostgreSQL 18 binaries (used for this deliverable's live validation):
npm pack @embedded-postgres/linux-x64@18.6.0-beta.19
# extract, create SONAME symlinks in native/lib, set LD_LIBRARY_PATH
initdb -D /tmp/pgdata -U postgres --auth=trust --encoding=UTF8 --locale=C
pg_ctl -D /tmp/pgdata -l /tmp/pglog.log \
  -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/pgsock" start
```

On Windows, run the committed reproducible script instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\live-postgres-validation.ps1 -UseDocker
```

### Run migrations and the API

```bash
export NODE_ENV=development
export DATABASE_URL='postgresql://postgres@127.0.0.1:55432/countup_dev'
npm run db:status
npm run db:migrate
npm run api:dev        # listens on 0.0.0.0:3000
```

### curl walkthrough (CSRF → signup → login → me → refresh → logout)

```bash
BASE=http://127.0.0.1:3000
JAR=/tmp/countup-cookies.txt

# 1. CSRF token (cookie + header must match)
CSRF=$(curl -s -c "$JAR" "$BASE/auth/csrf" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).csrfToken")

# 2. Signup (password-only; never send a PIN)
curl -s -i -b "$JAR" -c "$JAR" -X POST "$BASE/auth/signup" \
  -H 'Content-Type: application/json' -H "Origin: $BASE" \
  -H 'Sec-Fetch-Site: same-origin' -H "x-csrf-token: $CSRF" \
  -d '{"email":"owner@example.test","password":"Str0ngPassw0rd!2026","displayName":"Pilot Owner"}'

# 3. Login — tokens arrive ONLY in Set-Cookie
curl -s -i -b "$JAR" -c "$JAR" -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $BASE" \
  -H 'Sec-Fetch-Site: same-origin' -H "x-csrf-token: $CSRF" \
  -d '{"identifier":"owner@example.test","password":"Str0ngPassw0rd!2026"}'

# 4. Protected route (unverified -> 403 on /auth/sessions, 200 on /auth/me)
curl -s -i -b "$JAR" "$BASE/auth/me"
curl -s -i -b "$JAR" "$BASE/auth/sessions"

# 5. Refresh rotates both tokens; logout revokes
curl -s -i -b "$JAR" -c "$JAR" -X POST "$BASE/auth/refresh" \
  -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' -H "x-csrf-token: $CSRF"
curl -s -i -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout" \
  -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' -H "x-csrf-token: $CSRF"
```

To approve an identity, create the administrators with the audited one-time
`npm run admin:bootstrap` CLI (see `docs/M2_SECURITY_REMEDIATION.md` §12), log in as
that admin, then call `POST /auth/admin/identity-verifications/:userId/verify` with
`{"decision":"approved","evidence":{"verification_method":"in_person","id_checked":true}}`.
There is no signup path that can grant admin, no hardcoded admin credential and no
undocumented superuser SQL procedure.

### Automated suites

```bash
npm ci
npm run test:db                                  # PGlite: M1 + M2 (76 tests)
TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' \
  npm run test:db:live                         # real PostgreSQL 18: 45 tests
npm run typecheck:api && npm run lint && npm run format:check
npm run api:build && npm run build
```

---

## 12. Scope confirmation

- **Firebase** — `src/firebase/*`, `firestore.rules`, `firebase*.json`,
  `.firebaserc`, `functions/**`, Firebase dependencies and Firebase Auth/Firestore
  data were **not modified or deleted**. Firebase remains the legacy read-only
  migration source and fallback.
- **Existing frontend** — `src/**` (including `ShopContext.tsx`), legacy GitHub
  Pages build, offline shell, and all 185 existing tests are unchanged and pass.
- **Production** — nothing deployed, no Render/Cloudflare provisioning, no cutover,
  no dual-write, no merge to `main`, no push to `main`, no secrets committed.


---

## 12. Post-remediation addendum (historical document preserved)

Sections 1–11 above describe M2 **as originally implemented** at commit
`4cb723a9d927a40c83239f5746c15473f626afc2`. An independent adversarial review
(`docs/M2_SECURITY_REVIEW.md`) reproduced 10 findings and recommended **DO NOT
APPROVE M3**. Commit `08b44df` remediated C-01…C-07, C-09 and C-10; the full account is
in `docs/M2_SECURITY_REMEDIATION.md`. The following statements in this document are
therefore **superseded** (kept here unaltered for decision history):

- §10 item 1 — the in-process rate limiter was replaced by a shared PostgreSQL limiter.
- §10 item 3 — development fallback secrets were deleted; strong secrets are now
  required in **every** `NODE_ENV` and startup fails closed.
- §10 item 6 — `platform_admin` accounts are now created by an audited, one-time,
  dual-control CLI with a documented break-glass recovery runbook.
- §8 — `0008_m2_security_remediation` added four security tables, token families,
  verification consistency constraints and a shared limiter table; the catalog is now
  42 tables / 68 FKs / 64 CHECKs / 124 indexes / 15 triggers on real PostgreSQL 18.6.
- §9 — suite sizes grew to 15 files / 139 tests (PGlite) and 15 files / 122 tests
  (live PostgreSQL, 11 process-startup tests intentionally skipped there).

`evidence` on the admin routes is no longer an unrestricted object: it is a strict
allowlist (see `apps/api/src/auth/audit-evidence.ts`). The curl example in §11 was updated
accordingly. M3 remains **NOT APPROVED** until a fresh adversarial re-review.
