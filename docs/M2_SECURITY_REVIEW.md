# COUNTUP — M2 Adversarial Security Review (READ-ONLY)

**Date:** 2026-11-02 (Africa/Lusaka)
**Branch:** `arena/cb51ea07-countup` (HEAD `4cb723a9d927a40c83239f5746c15473f626afc2`)
**Commits reviewed:** `47325d2955320be01779baae6dc2a48234b6d14f` (live PG validation),
`15c69457403d983f61b71ae71dac72df1cf487ab` (migration 0007),
`4cb723a9d927a40c83239f5746c15473f626afc2` (M2 authentication)
**Reviewer stance:** independent, adversarial. Passing automated tests were treated as
evidence of *test design*, not of security.

## Read-only statement

No implementation file was edited, no dependency installed, no commit created, no
push, no merge, no deployment, and no production data was touched. All adversarial
tests used **inline scripts only** (no scratch files in the repository) against
**in-memory PGlite** or a **freshly created, immediately dropped database** on the
isolated local PostgreSQL 18.6 server at `127.0.0.1:55432`, with synthetic accounts
only. One temporary database left by an aborted script was identified and dropped
(`countup_adv_e2458eff`); the second run cleaned up in `finally`. Firebase config,
Firestore rules/data, Firebase Auth users, Functions, the frontend and the legacy
GitHub Pages deployment were not touched. The **only** file created by this review is
this report. **`git status --short` was clean immediately before writing it.**

Where a test would have required modifying code or infrastructure (real multi-instance
deployment, proxy, induced DB failure, production TLS), the required setup is
described instead of silently changing anything; those items are marked *theoretical*.

---

## 0. Executive summary

M2 is a genuinely improved foundation: password-only Argon2id credentials, opaque
DB-managed sessions, server-side role checks, strict Zod bodies, CSRF/Origin guards,
append-only audit tables and no PIN reuse. The 45 live-PostgreSQL tests passing does
**not** make it secure. This review **reproduced 10 concrete weaknesses**, including a
**real PostgreSQL 18.6 concurrent-refresh race**, a **process-local rate limiter with a
trivial identity-casing bypass**, an **absent administrator bootstrap/recovery path
that deadlocks**, **publicly known development secrets gated only by `NODE_ENV`**, and
**admin self-verification with stale trust markers after reversal**.

**Overall: DO NOT APPROVE M3.** M3 introduces shop/tenant data and an expanded admin
surface on top of these foundations. Several findings are not cosmetic hardening —
they are missing controls or incorrect invariants that M3 would inherit and amplify.

---

## 1. Administrator bootstrap

**How the first `platform_admin` is created:** it is **not**. Verified by exhaustive
search: the only production `INSERT INTO users` is `apps/api/src/auth/auth-service.ts:165-170`,
which hardcodes `'owner', 'active', 'unverified'`; `migrations/0002_identity.up.sql:9`
sets `role user_role NOT NULL DEFAULT 'owner'`; `migrations/0007_m2_auth.up.sql` adds
no admin seed and does not change the default. The only code that ever writes
`role='platform_admin'` is the **test harness** (`apps/api/test/auth/harness.ts:193-215`).
No CLI, no bootstrap script, no migration, no documented SQL exists.
`docs/M2_AUTHENTICATION_IMPLEMENTATION.md:156-157, 384` merely says "provisioned
out-of-band by a trusted server-side DB operation" without a procedure.

**Public signup / request manipulation / DB defaults / migrations:** all four were
checked and **cannot** grant admin (positive):

| Vector | Result | Evidence |
| --- | --- | --- |
| `POST /auth/signup` with `role:'platform_admin'` and `userId:<other>` | `400 validation_error` | reproduced; `apps/api/src/auth/schemas.ts:7-18` `.strict()`, `auth-service.ts:166-169` |
| `users.role` DB default | `'owner'` | `migrations/0002_identity.up.sql:9` |
| Migration 0007 | adds no role write, no grant | `migrations/0007_m2_auth.up.sql:15-50` |
| Any app endpoint mutating `role` | none found | `git grep "UPDATE users"` → only `identity_status`/`session_version` |

**Privilege escalation:** roles are read from PostgreSQL on every request
(`middleware.ts:105-117` → `auth-service.ts:358-404`), and both admin operations
re-check via `assertPlatformAdmin` (`roles.ts:28-37`, called at
`identity-verifier.ts:53` and `auth-service.ts:539`). No escalation path via HTTP was
found. **However**, because no supported bootstrap exists, the *de facto* procedure is
raw SQL (`UPDATE users SET role='platform_admin' ...`) executed with the migration/DB
superuser. That path writes **no `platform_audit` row**, is not reviewable, and is not
documented — see C-02.

> Note (informational): `functions/src/index.ts:100-106` (legacy Firebase
> `ensurePlatformAdmin`) sets a **Firebase custom claim** `platformAdmin`, not the
> PostgreSQL `users.role`. An operator could reasonably but incorrectly assume this
> provisions a M2 admin. Two independent admin systems now exist.

---

## 2. Administrator recovery

**Loss of administrator access produces an unrecoverable deadlock** (C-02, reproduced
by exhaustion of all paths):

- `POST /auth/password/recovery/request` (`routes.ts:174-187` →
  `auth-service.ts:515-530`) writes only an audit row and **creates no token**.
  Reproduced: identical `202` body for existing/unknown accounts, and
  `password_reset_tokens` row count remained **0**.
- The only `INSERT INTO password_reset_tokens` in the entire repository is
  `auth-service.ts:548-553` inside `adminIssueResetToken`, which requires an
  already-authenticated `platform_admin`.
- `POST /auth/admin/password-reset/:userId` as an ordinary owner → reproduced
  `403 forbidden`.
- `POST /auth/password/recovery/confirm` (`routes.ts:189-197`) needs a token that
  only an admin can mint.

Therefore: if the sole admin forgets a password, is locked out after 5 failures, is
suspended, or the account is deleted, **no supported recovery procedure exists**. The
fallback is unaudited raw SQL against `users.role` / `credentials.password_hash` /
`password_reset_tokens` — precisely the "unaudited privilege-reset path" the review
asked about. No break-glass, no dual control, no documented runbook, no test.

---

## 3. Session security

**Rotation and single reuse (positive, reproduced):** after `/auth/refresh`, the old
session token → `401 unauthenticated`; the old refresh token → `401`; `/auth/logout`
sets `revoked_at='logout'` and the token → `401`; `invalidateAllSessions` bumps
`users.session_version` and all tokens stop working (M2 test 22). Idle 12 h / absolute
30 d values are correct (`auth-service.ts:326-343`, test 4 asserts exact seconds).

**Concurrent refresh (C-01, REPRODUCED on real PostgreSQL 18.6):**
`auth-service.ts:407-461` performs `SELECT ... WHERE refresh_token_hash=$1` then
`UPDATE sessions SET ... WHERE id = $1` with **no compare-and-swap on the old refresh
hash, no `SELECT ... FOR UPDATE`, and no reuse detection/revocation**. Using two
independent `pg` clients against a disposable database and an orchestrated
interleaving (inline `QueryExecutor` test double delaying the rotation UPDATE on both
connections by 120 ms):

```
CONCURRENT_REFRESH_BOTH_SUCCEEDED: true      // both returned 200 + new token pair
FIRST_TOKEN_IS_DEAD: true                    // one client silently gets dead tokens
LAST_TOKEN_IS_LIVE: true                     // last writer wins
OLD_REFRESH_REPLAY_ACCEPTED: false unauthenticated
REFRESH_AUDIT_ROWS: 2                        // both claimed a successful rotation
```

Impact: a stolen refresh token can be raced against the victim; the winner obtains a
fully valid session and the victim is silently logged out with **no detection, no
session revocation and no alert**. Even without theft, ordinary client retries/tabs
cause one client to receive tokens that never work. `UPDATE` also lacks
`AND revoked_at IS NULL AND session_version = $n`, so a concurrent logout or
version invalidation between SELECT and UPDATE still rotates the hashes of a revoked
session (state churn, no resurrection because `revoked_at` is not cleared).

**Stolen/replayed tokens:** a stolen *session* token remains usable until idle/absolute
expiry, and `validateSession` (`auth-service.ts:382-389`) **slides idle expiry on every
request**, so an attacker can keep a stolen token alive for the full 30-day absolute
window. There is no device/IP binding, no step-up authentication for admin actions,
and no anomaly detection. See H-04.

---

## 4. CSRF and browser security

**Cookie configuration (positive):** `cookies.ts:10-17` — `HttpOnly`,
`SameSite=Lax`, `Secure` only in production; session cookie `Path=/`, refresh cookie
`Path=/auth/refresh`; `cookies.ts:57-66` CSRF cookie is intentionally readable and
host-only (no `Domain`). `app.ts:58` sets `no-store` on every response.

**Negative CSRF cases (positive, reproduced):** missing header, malformed
(`garbage`), and cookie/header mismatch all → `403 invalid_csrf`
(`middleware.ts:63-77`, `csrf.ts:32-44`). Cross-origin request with
`Origin: http://evil.example` + `Sec-Fetch-Site: same-origin` → `403 cross_origin`
(reproduced). `Sec-Fetch-Site: cross-site` → `403` (M2 test 20).

**Origin guard gap (C-07, REPRODUCED):** `middleware.ts:44-54` accepts
`Sec-Fetch-Site: none`, and if `Origin` is absent it only rejects when
`site === undefined`. A request with **no `Origin` header and a client-supplied
`Sec-Fetch-Site: none`** passes the guard. Combined with a valid (or forged) CSRF
token this was accepted:

```
NO_ORIGIN_SFS_NONE: [201, "accepted"]       // state-changing signup, no Origin header
```

Since `Sec-Fetch-Site` is just a request header for non-browser clients, the "strict
Origin check" is bypassable by any scripted client. Browser cross-site form CSRF is
still blocked by `cross-site` + `SameSite=Lax`, so this is a defence-in-depth gap
rather than a direct browser CSRF hole — but it removes one of two independent
controls.

**Development-mode assumptions (C-04, REPRODUCED):** `constants.ts:35-37` commits
`DEV_PEPPER` and `DEV_CSRF_SECRET` as public constants. `security.ts:33-43` enforces
real secrets **only when `NODE_ENV === 'production'`**; `env.ts:9` allows
`development`/`test`. Consequently any deployment that runs with `NODE_ENV` other
than exactly `production` (staging, preview, misconfigured container) uses a
**publicly known CSRF HMAC key** and a **publicly known password pepper**, and
`cookies.ts:13` omits `Secure`. Reproduced: a CSRF token forged locally with
`createCsrfToken(DEV_CSRF_SECRET)` was accepted by the API (`NO_ORIGIN_SFS_NONE` case
used exactly such a forged token). Also reproduced: the same CSRF token was replayed
for a 10th successive state-changing request → `201` (no expiry/rotation, H-01).

**Proxy assumptions (H-02/H-03, theoretical):** no `trust proxy` is configured
anywhere (`git grep "trust proxy"` → none). `middleware.ts:48` builds the trusted
self-origin from `req.protocol` + `req.get('host')`. Behind a TLS-terminating proxy,
`req.protocol` is `http` while a browser sends `Origin: https://...` → legitimate
state-changing requests would be rejected unless `PUBLIC_APP_ORIGIN` is set;
`PUBLIC_APP_ORIGIN` is an unvalidated free-form comma list (`security.ts:44-50`,
`env.ts:18`). `Host` is client-controlled, so the self-origin check is derived from
untrusted input. I could **not** reproduce a Host-spoof bypass via Node `fetch`
(undici overrides `Host` from the URL); confirming it requires a raw-socket test
described in §"Unverified assumptions".

---

## 5. Identity verification

**Unverified accounts (positive, reproduced):** `GET /auth/sessions` for an unverified
owner → `403 unverified_identity`; `GET /auth/me` → `200` (account basics only).

**Status trusted exclusively from PostgreSQL (positive, reproduced):** flipping
`users.identity_status` directly in the disposable DB changed the very next request
on an existing, unrefreshed session: `403 → 200 → 403` for
`unverified → verified → rejected`. `validateSession` re-reads
`u.identity_status::text` (`auth-service.ts:363`) on every request. DB defaults
cannot set `verified` (`0007:17` default `'unverified'`).

**Admin self-verification (C-05, REPRODUCED):** `identity-verifier.ts:51-108` checks
the actor is a `platform_admin` but **never checks `actorUserId !== targetUserId`**.
An admin whose own identity was set to `unverified` approved themselves:

```
SELF_VERIFY_STATUS: 200
SELF_VERIFY_DB: {"identity_status":"verified","identity_verified_by":"<same admin id>"}
```

There is also no uniqueness/idempotency constraint: verification can be repeated
indefinitely. Reproduced `APPROVE_THEN_REJECT: [200,200]` with trail
`["requested","approved","rejected"]`. Every decision writes an immutable
`identity_verifications` row (`0007:48-50`) and a `platform_audit` row, so the
*history* is preserved (positive) — but there is no dual control, and an admin can
reset their own password or another admin's (reproduced:
`ADMIN_SELF_RESET: [200,"string"]`, `ADMIN_RESETS_OTHER_ADMIN: [200,"string"]`,
confirm → `200`, other admin's old password → `401`). A single admin therefore has
unilateral, unaudited-by-a-second-party control over the entire admin tier.

**Stale trust markers after reversal (C-06, REPRODUCED):**
`identity-verifier.ts:88-92` sets only `identity_status='rejected'`; it does **not**
clear `identity_verified_at`, `identity_verified_by`, or
`auth_identities.verified_at` set by the earlier approval (`lines 75-87`):

```
REJECT_LEAVES_STALE: {"identity_status":"rejected","has_verified_at":true,"has_verifier":true}
REJECT_LEAVES_STALE_IDENTITY: {"has_verified_at":true}
```

Any M3 code that reads `verified_at` (a natural field to trust) would treat a rejected
identity as verified. Within the app, no endpoint currently reads those columns, so
impact is latent — but M3 is exactly where it becomes exploitable.

**Modification without audit trail (theoretical):** the only app path that changes
`users.identity_status` is `verifier.decide`, which is audited. Direct DB writes by an
operator with DB credentials would bypass audit entirely (same class as C-02).

---

## 6. Rate limiting

**Process-local (C-03, REPRODUCED):** `rate-limit.ts:16-17` uses a per-instance
`Map`. `security.ts:56` creates one `RateLimiter` per `createApp` call. Two limiter
instances simulating two API processes, same key and rule `{max:2}`:

```
TWO_PROCESS_SAME_KEY: instanceA [true,true,false], instanceB [true,true,false],
                      effectiveAllowed: 4, singleInstanceExpected: 2
```

With N instances the effective limit is N×. **Not safe for multiple API instances.**
`docs/M2_AUTHENTICATION_IMPLEMENTATION.md:287-288` acknowledges this as a known
limitation, but M3 deployment plans (Render/Cloudflare, blue-green, autoscaling) make
it a live risk rather than a deferred one.

**Identity-casing bypass (C-03, REPRODUCED):** `middleware.ts:82-87` hashes the
**raw** `req.body.identifier`, while `auth-service.ts:212-214` normalises with
`trim().toLowerCase()` (or phone digit stripping). With
`loginIdentity.max = 2` and `loginIp.max = 100`:

```
CASING_VARIED_3_ATTEMPTS:  ['case@test.test','CASE@TEST.TEST',' Case@Test.Test ']
                           -> 401, 401, 401        (no rate_limited)
SAME_CASE_3_ATTEMPTS:      -> 401, 401, 429 rate_limited
```

All three variants hit the **same account** but hash to three different limiter keys.
Phone identifiers have the same issue (whitespace/`+`/separators are stripped later).

**No signup rate limiting (C-03, REPRODUCED):** `globalIp` is consulted only inside
`loginRateLimit` (`middleware.ts:79-93`), which is mounted only on `/auth/login`
(`routes.ts:102`). 15 successive signups with the same IP and one CSRF token →
`201,201,201,201,201,201,201,201,201,201,201,201,201,201,201`; 15 users created.
`/auth/refresh`, `/auth/password/recovery/confirm`, `/auth/logout`, `/auth/sessions/:id/revoke`
and both `/auth/admin/*` routes have no limiter at all (inspection).

**Alternate IP headers (positive + theoretical):** `req.ip` is used
(`middleware.ts:81,98`) and `trust proxy` is off, so `X-Forwarded-For`/
`X-Real-IP` **cannot** be spoofed to reset buckets (positive). But behind a real
proxy all clients share the proxy's IP, collapsing per-IP limits into one global
bucket (either shared DoS or shared headroom) — theoretical, requires a proxy setup.

**Malformed requests:** `loginRateLimit` runs *before* `validateBody`
(`routes.ts:102-103`), so requests with a missing/non-string identifier all key to
`'unknown'`; they still consume `login-ip`/`global` budget, so this is not a full
bypass. The `&&` short-circuit at `middleware.ts:88-91` means a denied `globalIp`
bucket does not increment `loginIp`/`loginIdentity` (minor accounting inaccuracy).

**Account-lockout DoS (H-12, theoretical):** 5 wrong attempts on any known account
produce a 15-minute lock (`auth-service.ts:242-244, 250-272`); an attacker can
deliberately lock out a victim. Unknown-identifier logins also trigger a full
19 MiB Argon2 `dummyVerify` (`password.ts:28-34`), a CPU-exhaustion amplifier across
multiple IPs.

---

## 7. Password security

**Positive:**

- Argon2id, `m=19456 KiB, t=2, p=1, outputLen=32` (`constants.ts:25-31`) — within
  OWASP-acceptable parameters; unique random 16-byte salt per hash from the library.
- Server-side pepper mixed via `HMAC-SHA256(pepper, password)` **before** Argon2
  (`password.ts:16-22`); `credentials.password_algo='argon2id'`, plaintext never
  stored. Reproduced in M2 test 3 that two identical passwords yield different
  hashes and a different pepper fails verification.
- Password change verifies the current password and revokes all *other* sessions
  (`auth-service.ts:477-512`); recovery reset revokes **all** sessions and bumps
  `session_version` (`auth-service.ts:567-606`).
- Reset tokens: `randomBytes(32)` = 256 bits (`tokens.ts:5-7`), stored as SHA-256
  (`tokens.ts:10-12`), 30-minute expiry, single-use enforced atomically by
  `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING`
  (`auth-service.ts:573-578`) — verified by M2 tests 13/14 (reuse → `400 invalid_token`).
- **Legacy plaintext POS PIN is not reused.** `git grep -n -i pin` over
  `apps/api/src/auth`, `app.ts` and `0007` returns no PIN logic; `signup` only creates
  fresh Argon2id credentials. (Legacy PINs still exist in the untouched Firestore
  read-only source, which is correct per scope.)

**Weaknesses:**

- **C-04** (known dev pepper/CSRF secret outside `NODE_ENV=production`) — see §4.
  A known pepper removes the "DB-only breach is insufficient" protection.
- **H-08:** password policy is length-only, 12–1024 (`constants.ts:17-18`,
  `password.ts:37-47`); no breach-password check, no rate-limited password change,
  no pepper rotation/versioning. Changing `AUTH_PEPPER` invalidates every hash with
  no migration path.
- **H-09:** `assertPasswordPolicy` throws a bare `RangeError`; if ever reached
  outside Zod it would fall through `app.ts:114-140` to a logged `500`. Currently
  unreachable because all callers validate first.
- **C-09 / C-10** apply to recovery audit (arbitrary `evidence` in an append-only
  row; non-atomic audit).

---

## 8. Tenant and authorization boundaries

**Positive, reproduced:**

- Cross-user revoke: owner A calling
  `POST /auth/sessions/<owner B's session id>/revoke` → `{"revoked":false}` — no
  error oracle, no state change (`auth-service.ts:619-634` uses
  `WHERE id=$1 AND user_id=$2`, with `userId` from `res.locals`, never the body).
- `GET /auth/sessions` returned only A's session IDs.
- Role/userId injection → `400 validation_error`; `users.role` stayed `owner`.
- `requireOwner` (`middleware.ts:119-132`), `requireVerified` (`134-147`) and
  `requirePlatformAdmin` (`149-161`) all read `res.locals.auth` populated by
  `requireAuth` → `validateSession` → PostgreSQL join. No client-supplied role,
  user ID or ownership field is trusted by any endpoint.
- No endpoint mutates `users.role`; no dynamic SQL from user input; all statements
  parameterised.

**Boundary limitation (H-11):** M2 exposes **no shop/tenant endpoints**, so cross-shop
isolation was not exercised at the HTTP layer. The M1 composite-FK tenant containment
(13 composite FKs) and 0 RLS policies remain as-is (ADR-11 still provisional / not
approved). M3 **must** introduce server-side `shop_id` scoping on every query and
decide on RLS; nothing in M2 provides that at the API layer. Also note `requireOwner`
on `/auth/me` blocks `platform_admin` from that route — a usability quirk, not a
security defect.

---

## 9. Logging and information disclosure

**Positive:** no request logging middleware exists, so Cookie headers are not written
to logs; audit payloads use `hashIdentifier` (`tokens.ts:15-17`,
`auth-service.ts:216, 528`); responses never contain `sessionToken`,
`refreshToken` or `password_hash`; `platform_audit` and `identity_verifications` are
append-only (`migrations/0004_payments_audit.up.sql:86-88`,
`migrations/0007_m2_auth.up.sql:48-50`).

**Account enumeration (C-08, REPRODUCED):**

```
ENUM_SIGNUP_DUPLICATE: [409,"duplicate_identity"]      // confirms account exists
ENUM_LOCKOUT_KNOWN:   [401,401,401,401,429,429]        // 429 account_locked
ENUM_LOCKOUT_UNKNOWN: [401,401,401,401,401,401]        // always 401
SUSPENDED_LOGIN:      [403,"account_inactive"]         // distinct from ghost
GHOST_LOGIN:          [401,"invalid_credentials"]
```

`authErrors.invalidCredentials()` is correctly shared for unknown identifier and
wrong password (`auth-service.ts:231-239` vs `270-272`), but B4's non-revealing
requirement is only met for `/auth/password/recovery/request`. Signup, lockout and
`account_inactive` are three distinct oracles.

**Arbitrary PII into immutable audit (C-09, REPRODUCED):**
`adminVerifySchema`/`adminResetSchema` accept `z.record(z.string(), z.unknown())`
with no size or key restrictions (`schemas.ts:43-55`). That object is written
verbatim into `identity_verifications.evidence` (`identity-verifier.ts:64-69`) and
`platform_audit.payload` (`auth-service.ts:554-562`):

```
AUDIT_PAYLOAD_CONTAINS_RAW_PII: {"evidence":{"raw_email":"victim@pii.test","password_hint":"hunter2","note":"PII"}}
VERIFICATION_EVIDENCE_PII:      {"email":"victim@pii.test","national_id":"123456/11/1"}
LARGE_EVIDENCE: [200,"accepted"]      // 20 KB blob accepted
```

Because both tables are append-only, **PII written there can never be erased** — a
data-protection/erasure problem, unbounded storage, and an unvalidated write channel
into the security audit log.

**Non-atomic audit (C-10, REPRODUCED):** `logout` (`auth-service.ts:463-475`),
`login` success/failure (`261-269`, `286-294`), `refresh` (`446-453`),
`revokeSession` (`625-632`) and `requestPasswordRecovery` (`523-529`) perform the
state change and the audit INSERT as **two separate statements outside a
transaction**. Using an inline `QueryExecutor` test double that makes only the audit
INSERT fail:

```
AUDIT_FAILURE_THREW: true
AUDIT_ROWS_UNCHANGED: [3,3]
SESSION_STILL_REVOKED: true        // session revoked, NO audit record
```

So a crash or audit-table error produces an unlogged security-relevant state change.

**Error-object logging (H-06, reproduced property):** `app.ts:139` logs the full
error object. PGlite error objects expose a `params` array containing the bound
values:

```
PGLITE_ERROR_KEYS: [..., "query", "params", "queryOptions"]
PGLITE_ERROR_PARAMS: ["not-an-int"]
```

In production `pg` errors generally do not carry bound parameters, so the practical
risk is confined to dev/test — but the log line is unredacted and would capture any
future error type that includes a password hash, token or cookie value.

**Reset token in response body (H-07, reproduced):** `routes.ts:257` returns
`{ resetToken }`. It is an intentional operator handoff, but a one-time secret now
appears in an HTTP response body, where proxies/APM/browser history/console logs can
capture it. `GET /health/live` (`app.ts:70-77`) discloses `APP_VERSION` and
`NODE_ENV` unauthenticated — Informational.

---

# CONFIRMED VULNERABILITIES

### C-01 — Concurrent refresh rotation race; no compare-and-swap and no reuse revocation
- **Severity:** High
- **File/line:** `apps/api/src/auth/auth-service.ts:407-461` (SELECT `:408-415`, checks `:418-427`, unconditional `UPDATE ... WHERE id=$1` `:431-440`, audit `:446-453`); `apps/api/src/auth/routes.ts:131-142`
- **Scenario:** two simultaneous `/auth/refresh` calls with the same refresh cookie
- **Reproduced:** YES — real PostgreSQL 18.6, two `pg` clients, disposable DB, orchestrated 120 ms interleaving. Both calls returned 200 with new token pairs; only the last writer's session token validated; old refresh replay rejected; two `auth.session.refreshed` audit rows written
- **Impact:** stolen refresh token can win the race → full session hijack with no detection/revocation/alert and silent victim logout; ordinary client concurrency yields dead tokens; audit claims two successful rotations for one surviving session
- **Correction:** single atomic statement `UPDATE sessions SET ... WHERE id=$1 AND refresh_token_hash=$old AND revoked_at IS NULL AND session_version=$n RETURNING ...` (or `SELECT ... FOR UPDATE` inside one transaction); treat any use of an already-rotated refresh hash as reuse → revoke the whole session family, invalidate `session_version`, emit a security alert; add a unique `rotated_from`/token-family table; add a concurrency regression test on real PostgreSQL
- **Blocks M3:** **YES**

### C-02 — No administrator bootstrap; unrecoverable admin lockout; unaudited raw-SQL privilege path
- **Severity:** High
- **File/line:** `apps/api/src/auth/auth-service.ts:165-170` (only production user INSERT, hardcoded `owner`); `migrations/0002_identity.up.sql:9` (default `owner`); `migrations/0007_m2_auth.up.sql` (no admin seed); `apps/api/src/auth/auth-service.ts:515-530` (recovery creates no token); `:533-565` (only reset-token INSERT, admin-gated); `apps/api/src/auth/routes.ts:242-259`; `docs/M2_AUTHENTICATION_IMPLEMENTATION.md:156-157, 384`
- **Scenario:** first admin creation and loss of the only admin credential
- **Reproduced:** YES — code search found no production admin INSERT/CLI/script; self-service recovery left `password_reset_tokens` at 0 rows; owner calling admin reset → `403`; no non-admin path can mint a token
- **Impact:** the pilot cannot be administered without hand-written superuser SQL; if the sole admin loses access the system is deadlocked; the de-facto bootstrap/reset writes no `platform_audit` row, is unreviewable, and can silently grant `platform_admin` to any account
- **Correction:** add an explicit, audited, one-time bootstrap mechanism (signed offline CLI or migration-time seeded admin with a forced password rotation), a documented break-glass recovery runbook with dual control, at least two admins, and an append-only audit event for every role grant/reset; never rely on ad-hoc SQL
- **Blocks M3:** **YES**

### C-03 — Rate limiting is process-local, bypassable by identifier casing, and absent on signup/other endpoints
- **Severity:** High
- **File/line:** `apps/api/src/auth/rate-limit.ts:16-17,39-44`; `apps/api/src/auth/security.ts:56`; `apps/api/src/auth/middleware.ts:79-102` (raw identifier hash `:82-87`, `&&` short-circuit `:88-91`); `apps/api/src/auth/routes.ts:89-98` (signup has no limiter), `:102` (limiter only on login); `apps/api/src/auth/tokens.ts:25-31` (normalisation applied later)
- **Scenario:** two API instances; case/whitespace variants of one email; 15 signups
- **Reproduced:** YES — two limiter instances allowed 4 requests where one instance allows 2; three casing variants of the same account produced `401,401,401` while three identical identifiers produced `401,401,429`; 15 signups all `201`
- **Impact:** online password guessing scales linearly with instance count; per-identity cap is trivially bypassed; account-creation/DB-filling spam is unlimited; per-IP limits collapse behind a proxy
- **Correction:** move limiter state to a shared atomic store (PostgreSQL `UPDATE ... RETURNING` counter or Redis `INCR`+`TTL`); hash the **normalised** identifier (and phone) using the same function as `login`; apply a global per-IP limiter to **all** `/auth/*` routes (and admin routes); add limits to signup, refresh, recovery confirm and admin endpoints; use a canonical client-IP strategy with an explicit trusted-proxy allowlist
- **Blocks M3:** **YES** (M3 plans multiple instances and more endpoints)

### C-04 — Publicly known pepper and CSRF secret outside `NODE_ENV=production`; `Secure` cookies off
- **Severity:** High (configuration-dependent)
- **File/line:** `apps/api/src/auth/constants.ts:35-37`; `apps/api/src/auth/security.ts:33-43`; `apps/api/src/config/env.ts:9,13-18`; `apps/api/src/auth/cookies.ts:13,62`; `apps/api/src/app.ts:62`
- **Scenario:** any deployment with `NODE_ENV=development`/`test` (staging, preview, misconfigured container)
- **Reproduced:** YES — a CSRF token forged locally from `DEV_CSRF_SECRET` was accepted for a state-changing signup; the known pepper is a repository constant; `Secure` is off in that mode
- **Impact:** complete CSRF-token forgery with a non-production deployment, known password pepper (offline cracking loses its extra barrier), session cookies sent over plaintext HTTP
- **Correction:** fail closed — require `AUTH_PEPPER`/`CSRF_SECRET` whenever the app is reachable from a non-loopback interface, or introduce an explicit `DEPLOYMENT_MODE` that forbids dev fallbacks; never ship a usable default secret; set `Secure` and `trust proxy` from deployment config, not from `NODE_ENV` alone; add a startup assertion and deployment smoke test
- **Blocks M3:** **YES**

### C-05 — Admin self-verification and unilateral control of the admin tier (no separation of duties)
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/identity-verifier.ts:51-60` (no `actor !== target` check), `:63-107`; `apps/api/src/auth/auth-service.ts:533-565`; `apps/api/src/auth/routes.ts:222-259`; `apps/api/src/auth/middleware.ts:149-161`
- **Scenario:** admin approves own identity; admin issues reset token for self or another admin
- **Reproduced:** YES — `SELF_VERIFY_STATUS: 200` with `identity_verified_by = <own id>`; `ADMIN_SELF_RESET` and `ADMIN_RESETS_OTHER_ADMIN` both `200` with tokens; confirming the latter changed the other admin's password
- **Impact:** a single (or compromised) admin account can verify itself, take over any other admin, and unilaterally approve any identity that M3 will gate shop data on; no dual control, no distinct reviewer
- **Correction:** reject `actorUserId === targetUserId` for verification and admin password resets; require a second distinct admin for irreversible admin-tier operations (or an explicitly approved, audited break-glass policy); enforce idempotency (`UNIQUE (user_id, decision)` or a state check); record reviewer identity and reason; alert on admin-tier resets
- **Blocks M3:** **YES** (policy decision + guard before M3 relies on `verified`)

### C-06 — Rejecting a verification leaves `verified_at`, `verified_by` and `auth_identities.verified_at` stale
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/identity-verifier.ts:75-92` (approve sets three markers; reject clears only `identity_status`); `migrations/0007_m2_auth.up.sql:18-19`
- **Scenario:** approve then reject the same user
- **Reproduced:** YES — `identity_status='rejected'` with `has_verified_at=true`, `has_verifier=true`, and primary `auth_identities.verified_at` still set
- **Impact:** contradictory trust state. Any M3 code reading `verified_at` (the obvious marker) would grant a rejected identity access to shop data; DB-level integrity of the verification invariant is broken
- **Correction:** clear all three markers on rejection inside the same transaction; add a DB `CHECK` enforcing consistency between `identity_status` and the markers (e.g. `identity_status='verified' ⇔ verified_at IS NOT NULL`); add a regression test for the approve→reject→approve cycle
- **Blocks M3:** **YES**

### C-07 — Origin guard accepts missing `Origin` with client-supplied `Sec-Fetch-Site: none`
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/middleware.ts:41-54` (`:44` allows `none`, `:52-54` rejects only when `site === undefined`)
- **Scenario:** POST with no `Origin` header and `Sec-Fetch-Site: none`
- **Reproduced:** YES — `NO_ORIGIN_SFS_NONE: [201,"accepted"]` for a state-changing signup
- **Impact:** one of the two independent cross-origin controls is trivially bypassable by scripted clients; combined with C-04 a non-production deployment has no effective origin/CSRF boundary at all
- **Correction:** require a matching `Origin` (or `Referer`) for every unsafe method; treat `Sec-Fetch-Site: none` as insufficient on its own; allowlist exact origins from validated config; reject `Host`-derived self-origin when the app is behind a proxy unless `trust proxy` is explicitly configured
- **Blocks M3:** **YES** (cheap fix, M3 adds more state-changing endpoints)

### C-08 — Account enumeration via signup, lockout and account status
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/auth-service.ts:203-207` (409 `duplicate_identity`), `:242-244` (429 `account_locked`), `:245-247` (403 `account_inactive`), `:270-272`; `apps/api/src/auth/errors.ts:32-44`
- **Scenario:** probe an email through three endpoints
- **Reproduced:** YES — `409` on duplicate signup; `401,401,401,401,429,429` for a known account vs `401×6` for an unknown one; `403 account_inactive` for a suspended account vs `401` for a ghost
- **Impact:** an attacker can enumerate registered owners before M3 exposes shop data; targeted phishing/credential stuffing; lockout doubles as an account-existence oracle
- **Correction:** return the same generic 401/202 for all authentication outcomes including lockout and inactive accounts (move the distinction into server-side audit only); make duplicate-signup responses generic or rate-limit/verify-email-gated; equalise timing; document the deliberate trade-off
- **Blocks M3:** No — fix before production cutover, but it does not block M3 development

### C-09 — Unvalidated, unbounded client data written into append-only audit tables
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/schemas.ts:43-55` (`z.record(z.string(), z.unknown())` with no cap); `apps/api/src/auth/identity-verifier.ts:64-69`; `apps/api/src/auth/auth-service.ts:554-562`; `migrations/0004_payments_audit.up.sql:86-88`; `migrations/0007_m2_auth.up.sql:48-50`
- **Scenario:** admin supplies PII / 20 KB blob in `evidence`
- **Reproduced:** YES — raw email, `password_hint`, `national_id` persisted verbatim in `platform_audit.payload` and `identity_verifications.evidence`; 20 KB blob accepted (`200`)
- **Impact:** permanent, non-erasable PII in append-only tables (erasure/compliance conflict), audit-log pollution with attacker-controlled content, unbounded row growth
- **Correction:** define a strict allowlisted evidence schema (fixed keys, bounded string lengths, no free-form objects), cap total payload size, redact/hash identifiers, and never place raw personal data in immutable audit rows
- **Blocks M3:** **YES** (M3 will add many more audited endpoints)

### C-10 — Security audit writes are not atomic with the state changes they describe
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/auth-service.ts:261-269, 275-294, 446-453, 463-475, 523-529, 619-634` (audit INSERT outside any transaction); contrast `signup :163-202`, `changePassword :494-511`, `verifyIdentity :63-107`, `confirmPasswordReset :572-605`, `invalidateAllSessions :638-653` which are transactional
- **Scenario:** audit INSERT fails after a state change
- **Reproduced:** YES — inline `QueryExecutor` test double made only the audit INSERT fail; `logout` still revoked the session while `platform_audit` row count stayed `[3,3]`
- **Impact:** logout, login, refresh and session revocation can occur with no audit record; security investigations and incident reconstruction become unreliable; an attacker who can induce audit failures gets unlogged actions
- **Correction:** wrap each state change + its audit event in one `executor.transaction(...)` (or use a DB trigger/outbox); add a fault-injection test; consider a `NOT NULL` audit-id reference on sensitive state changes
- **Blocks M3:** **YES**

---

# HARDENING RECOMMENDATIONS (not confirmed exploitable in the tested deployment)

### H-01 — CSRF tokens never expire, never rotate, and are not bound to a session
- **Severity:** Low / Medium
- **File/line:** `apps/api/src/auth/csrf.ts:10-14,32-44`; `apps/api/src/app.ts:64-68`; `apps/api/src/auth/cookies.ts:57-66`
- **Scenario:** replay one token for the 10th successive state-changing request
- **Reproduced:** YES (`201` on the 10th reuse) — but no cross-site browser exploit was demonstrated because `SameSite=Lax` and the `cross-site` check still hold
- **Impact:** a leaked token is valid indefinitely; login/privilege change does not rotate it; cookie-tossing from a subdomain would be fatal
- **Correction:** add an issued-at timestamp + short TTL to the signed token, bind the MAC to the session token hash once authenticated, rotate on login/privilege change, use the `__Host-` cookie prefix
- **Blocks M3:** No

### H-02 / H-03 — No `trust proxy`; self-origin derived from client-controlled `Host`; unvalidated `PUBLIC_APP_ORIGIN`
- **Severity:** Medium (deployment correctness)
- **File/line:** `apps/api/src/auth/middleware.ts:48`; `apps/api/src/app.ts:55-60`; `apps/api/src/auth/security.ts:44-50`; `apps/api/src/config/env.ts:18`; `apps/api/src/auth/middleware.ts:81,98` (`req.ip`)
- **Scenario:** TLS-terminating reverse proxy / load balancer
- **Reproduced:** NO — theoretical. A raw-socket test with `Host: evil.example` and `Origin: http://evil.example` is required (Node `fetch` overrides `Host`); setting up a proxy was out of scope for a read-only review
- **Impact:** legitimate unsafe requests rejected behind a proxy; all clients share one rate-limit bucket; Host-derived origin trust is weaker than an explicit allowlist
- **Correction:** configure `trust proxy` with an explicit hop allowlist, derive the client IP from a validated forwarded header, validate `PUBLIC_APP_ORIGIN` entries as absolute HTTPS origins, and compare `Origin` only against that allowlist
- **Blocks M3:** H-02 yes (deployment config), H-03 no

### H-04 — Stolen session tokens remain usable for the full 30-day absolute window
- **Severity:** Medium
- **File/line:** `apps/api/src/auth/auth-service.ts:357-404` (sliding idle expiry `:382-389`), `:311-355`; `apps/api/src/auth/constants.ts:10-11`
- **Scenario:** session token exfiltration; keep-alive polling
- **Reproduced:** NO — theoretical (would require exercising a 30-day clock / time travel); the sliding logic was verified by inspection
- **Impact:** no device/IP binding, no step-up authentication for admin operations, no anomaly detection; a stolen token can be kept alive indefinitely up to absolute expiry
- **Correction:** consider device fingerprint binding, re-authentication for admin/irreversible operations, idle-activity anomaly alerts, and a shorter absolute lifetime for admin sessions
- **Blocks M3:** No

### H-05 — Missing rate limits on several state-changing endpoints
- **Severity:** Low / Medium
- **File/line:** `apps/api/src/auth/routes.ts:89-98, 131-142, 144-153, 189-197, 210-220, 222-259`; `apps/api/src/auth/middleware.ts:79-102`
- **Scenario:** `/auth/refresh`, `/auth/password/recovery/confirm`, `/auth/logout`, `/auth/sessions/:id/revoke`, `/auth/admin/*`
- **Reproduced:** partially — signup unlimited (C-03); the others are unverified by inspection
- **Impact:** reset-token guessing and admin-endpoint abuse are not throttled (256-bit token entropy makes brute force infeasible, but resource exhaustion is possible)
- **Correction:** apply a uniform global limiter plus per-route limits; see C-03
- **Blocks M3:** No (fold into C-03)

### H-06 — Unredacted error logging
- **Severity:** Low
- **File/line:** `apps/api/src/app.ts:139`; `apps/api/src/auth/audit.ts:11-12`
- **Scenario:** any error reaching the global handler
- **Reproduced:** partially — PGlite error objects were confirmed to carry a `params` array (`["not-an-int"]`); no production `pg` error with credentials was produced
- **Impact:** in dev/test, bound parameters (possibly password hashes/tokens) could be logged; production `pg` errors normally omit params
- **Correction:** log only a sanitised message + error class + request id; never log whole error objects or bound parameters; add a redaction test
- **Blocks M3:** No

### H-07 — One-time reset token returned in an API response body
- **Severity:** Low / Medium
- **File/line:** `apps/api/src/auth/routes.ts:242-258` (`:257`); `apps/api/src/auth/auth-service.ts:532-565`
- **Scenario:** admin-assisted handoff
- **Reproduced:** YES — `ADMIN_SELF_RESET: [200,"string"]` returns the raw token
- **Impact:** a one-time secret can be captured by proxies, APM, browser history or screenshots; it is a deliberate design choice, not a bug, but it deserves an explicit control
- **Correction:** display once in a short-lived server-side handoff object with an opaque reference ID, require a second authenticated admin action to redeem, or deliver through an approved out-of-band channel; never log it
- **Blocks M3:** No

### H-08 / H-09 — Password policy is length-only; no pepper rotation; bare `RangeError`
- **Severity:** Low
- **File/line:** `apps/api/src/auth/constants.ts:17-18`; `apps/api/src/auth/password.ts:37-47`; `apps/api/src/config/env.ts:16`; `apps/api/src/app.ts:114-140`
- **Scenario:** weak-but-long passwords; `AUTH_PEPPER` rotation
- **Reproduced:** NO — theoretical
- **Impact:** no breached-password screening; rotating the pepper bricks every credential with no migration path; a stray `RangeError` would surface as a logged 500
- **Correction:** add a breach-password check, store a pepper version alongside each hash with a dual-verify migration window, map policy errors to a typed 400
- **Blocks M3:** No

### H-11 — No shop/tenant API surface in M2; RLS still disabled
- **Severity:** Informational (M3 gate)
- **File/line:** `apps/api/src/auth/routes.ts:83-262` (no shop endpoints); `migrations/0006_ops_migration.up.sql` (commented-out RLS); `docs/adr/ADR-REGISTER.md` (ADR-11 provisional)
- **Scenario:** M3 introduces shop data
- **Reproduced:** N/A
- **Impact:** M2 provides no API-layer tenant scoping to inherit; M3 must implement `shop_id` filtering on every query and resolve provisional ADR-11 (optional RLS) before any shop endpoint is exposed
- **Correction:** make `requireVerified` + server-side `shop_id` scoping a mandatory middleware for every M3 route; add cross-shop negative tests; decide ADR-11
- **Blocks M3:** this is a prerequisite for M3 scope, not an M2 defect

### I-01 — Informational
- `GET /health/live` (`apps/api/src/app.ts:70-77`) discloses `APP_VERSION` and `NODE_ENV` unauthenticated.
- `functions/src/index.ts:100-106` legacy `ensurePlatformAdmin` grants a **Firebase custom claim**, not the PostgreSQL `users.role`; two independent admin notions coexist and could confuse operators (see §1).
- `platform_admin` accounts cannot call `GET /auth/me` because `requireOwner` is mounted there (`routes.ts:122-129`) — usability, not a security defect.
- `docs/M2_AUTHENTICATION_IMPLEMENTATION.md:287-288` already discloses the in-process limiter; this review confirms it is exploitable rather than merely theoretical.

---

# POSITIVE CONTROLS VERIFIED (held under adversarial testing)

1. Public signup hardcodes `owner`/`active`/`unverified`; strict Zod rejects `role`, `userId` and unknown keys (`400 validation_error`). DB default is `owner`; no migration seeds admins; no endpoint mutates `role`.
2. Admin/owner/verified decisions are read from PostgreSQL on every request; admin operations re-check `assertPlatformAdmin` from DB state.
3. Verification status is DB-backed — flipping it in the DB changed the next request on an existing session (`403 → 200 → 403`).
4. Cross-user session revocation returns `{revoked:false}` with no state change; session listing is scoped to the caller.
5. Missing / malformed / mismatched CSRF tokens → `403`; `Origin: https://evil...` → `403 cross_origin`; `Sec-Fetch-Site: cross-site` → `403`.
6. Unverified accounts → `403 unverified_identity` on the protected surface.
7. Old session and refresh tokens are rejected after rotation; logout revokes; `session_version` invalidation works; reset revokes all sessions and bumps the version.
8. Reset tokens are 256-bit, SHA-256-hashed, 30-minute, single-use (atomic `UPDATE ... RETURNING`), and never reused.
9. Argon2id with unique salt + HMAC pepper; no legacy POS PIN is read, copied or reused anywhere in M2.
10. `no-store` on all responses; no request logging; hashed identifiers in audit payloads; append-only triggers on `platform_audit` and `identity_verifications`; all SQL parameterised; `deny_mutation()` rejects audit tampering.
11. Every decision on `identity_verifications` leaves an immutable row (`["requested","approved","rejected"]`) — history is preserved even though state consistency is not (C-06).

---

# 1. Overall security assessment

**Not secure enough to authorise M3.** The cryptographic and authorisation core is
sound: credential handling, opaque sessions, server-side role checks, strict input
validation and append-only audit are genuine improvements, and no privilege
escalation path via HTTP was found. But the review reproduced **four High** and **six
Medium** weaknesses. Two are architectural gaps rather than bugs: there is **no way to
create or recover the first administrator** (C-02), and the **rate limiter cannot work
in a multi-instance deployment** (C-03) — both are precisely the things M3 needs. Two
are correctness bugs in the foundations M3 will build on: the **refresh rotation race**
(C-01) and **stale verification trust markers** (C-06). Two are configuration
traps that turn the whole CSRF/pepper design off: **public dev secrets** (C-04) and
the **`Sec-Fetch-Site: none` origin bypass** (C-07). The automated 45-test live-PG
suite tests happy paths and single-threaded sequences; it contains no concurrency,
multi-instance, secret-misconfiguration, enumeration or audit-failure tests, which is
why all ten reproduced issues passed CI.

# 2. Confirmed findings

| ID | Severity | Reproduced | Blocks M3 | Summary |
| --- | --- | --- | --- | --- |
| C-01 | High | YES (real PG 18.6) | **YES** | Concurrent refresh race; no CAS / reuse revocation |
| C-02 | High | YES (exhaustive path check) | **YES** | No admin bootstrap or recovery; unaudited raw-SQL privilege path |
| C-03 | High | YES | **YES** | Process-local limiter, identifier-casing bypass, unlimited signup |
| C-04 | High | YES | **YES** | Known dev pepper/CSRF secret; gated only by `NODE_ENV`; no `Secure` cookies |
| C-05 | Medium | YES | **YES** | Admin self-verification; unilateral control of the admin tier |
| C-06 | Medium | YES | **YES** | Rejection leaves `verified_at`/`verified_by`/identity markers stale |
| C-07 | Medium | YES | **YES** | Missing `Origin` + `Sec-Fetch-Site: none` bypasses origin guard |
| C-08 | Medium | YES | No | Account enumeration via signup / lockout / inactive status |
| C-09 | Medium | YES | **YES** | Arbitrary unbounded PII written into append-only audit tables |
| C-10 | Medium | YES | **YES** | Audit writes not atomic with the state changes they describe |

Hardening (reproduced but not directly exploitable in the tested single-instance,
`NODE_ENV=test`, loopback deployment): H-01, H-07. Theoretical / unverified: H-02,
H-03, H-04, H-05, H-06, H-08, H-09, H-11, I-01.

# 3. Unverified assumptions

- **Host-header origin spoofing (H-03):** Node `fetch` overrides `Host`; confirming
  requires a raw TCP/socket client sending `Host: evil.example` with
  `Origin: http://evil.example`, or a curl `--resolve` setup. Not performed.
- **Proxy deployment behaviour (H-02):** no reverse proxy / load balancer was
  available. Expected effects (`req.protocol=http`, shared proxy IP) are inferred
  from the absence of `trust proxy`, not measured.
- **Real multi-instance deployment (C-03):** reproduced at unit level with two
  `RateLimiter` objects; no second API process / orchestrator was started.
- **Production secret configuration (C-04):** production (`NODE_ENV=production`)
  was not deployed; `security.ts:34-40` requiring 32-char secrets was verified by
  the M2 unit test, but no real secret manager was exercised.
- **Induced real DB audit failure (C-10):** reproduced with an inline `QueryExecutor`
  test double, not by revoking `INSERT` privileges on `platform_audit` (which would
  have modified infrastructure).
- **Long-lived stolen-token behaviour (H-04):** no 30-day clock/time-travel test;
  inferred from `validateSession`'s sliding idle update.
- **`pg` error parameter leakage (H-06):** only PGlite error objects were shown to
  expose `params`; production `pg` errors are assumed not to.
- **Timing side-channels:** `dummyVerify` equalises unknown-identifier hashing but
  DB-path differences and `locked_until` short-circuits were not measured with
  statistical timing analysis.
- **Firebase legacy admin path:** `functions/src/index.ts` was read, not executed
  (out of scope for a read-only review).
- **M3 tenant isolation:** no shop endpoints exist in M2; no HTTP-level cross-shop
  test was possible.

# 4. Required fixes before M3

1. **C-01** — atomic compare-and-swap refresh rotation + refresh-token reuse
   detection/revocation/alerting, with a real-PostgreSQL concurrency test.
2. **C-02** — audited first-admin bootstrap, documented break-glass recovery, at
   least two admins, dual control, and an audit event for every role grant/reset.
3. **C-03** — shared-store rate limiter; normalise the identifier before hashing;
   global per-IP limiter on all `/auth/*` routes; limits on signup, refresh,
   recovery confirm and admin endpoints; explicit trusted-proxy IP strategy.
4. **C-04** — remove usable default secrets; fail closed for any externally
   reachable deployment; decouple `Secure` cookies/proxy trust from `NODE_ENV`.
5. **C-05** — forbid self-targeting admin operations; two-distinct-admin control
   (or an explicitly approved, audited break-glass policy); idempotent decisions.
6. **C-06** — clear all verification markers on rejection; add a DB consistency
   CHECK; regression test for approve→reject→approve.
7. **C-07** — require a matching `Origin`/`Referer` for unsafe methods; stop treating
   `Sec-Fetch-Site: none` as sufficient.
8. **C-09** — strict allowlisted, size-bounded, redacted evidence schema.
9. **C-10** — make every security-relevant state change and its audit event one
   transaction; add fault-injection tests.
10. Add adversarial tests to CI (concurrency, multi-instance limiter, secret
    misconfiguration, enumeration, audit failure) so the next review does not find
    the same classes of issue.
11. **M3 prerequisite:** server-side `shop_id` scoping + `requireVerified` on every
    shop route, and a decision on provisional ADR-11 (optional RLS).

# 5. Risks that can reasonably wait until later milestones

- **C-08** account enumeration — fix before production cutover, not before M3
  development.
- **H-01** CSRF token TTL/rotation/session binding; **H-07** reset token in response
  body (keep the documented operator handoff, but add a short-lived redemption
  object later).
- **H-04** device binding / step-up auth / anomaly detection; **H-08** breached
  password screening and pepper versioning; **H-09** typed policy errors;
  **H-06** log redaction.
- **H-05** residual per-route limits once C-03's global limiter lands.
- **I-01** health-endpoint version disclosure and the legacy Firebase admin-claim
  documentation note.
- RLS enablement (ADR-11) — but **only if** M3 resolves the ADR; otherwise it is a
  blocker, not a deferral.

# 6. Explicit recommendation

## **DO NOT APPROVE M3.**

M2 must not be declared secure on the basis of its 45 passing live-PostgreSQL tests.
Ten weaknesses were reproduced, four rated High. Two are missing architectural
controls (administrator bootstrap/recovery, shared rate limiting) that M3 directly
depends on; two are incorrect security invariants (refresh rotation race, stale
verification trust markers); two are configuration traps that disable the CSRF and
pepper protections entirely outside `NODE_ENV=production`. Re-review is required
after the eleven items in §4 are implemented and a new adversarial CI suite passes —
including at least one real-PostgreSQL concurrency test and one multi-instance
rate-limit test.

---

*End of read-only review. No implementation changes were made.*
