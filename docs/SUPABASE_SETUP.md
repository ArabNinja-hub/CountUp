# CountUp — Supabase Production & Staging Configuration Guide

This guide covers **separate Staging vs. Production Supabase projects**, **Site URL & Redirect URLs**, **`ALLOWED_ORIGIN`**, **API & timeout settings**, **backups**, and **Admin monitoring & error reporting**.

---

## 1. Use Two Separate Supabase Projects (Staging vs. Production)

Always maintain **two completely separate Supabase projects**:

| Environment | Supabase Project | Connected Cloudflare Pages Environment | SMS Provider Mode |
| --- | --- | --- | --- |
| **Staging** | `countup-staging` | Cloudflare Pages **Preview** deployments (`*.countup.pages.dev`) + local testing | Sandbox or dedicated low-cap test sender (`SMS_DAILY_NEW_REGISTRATION_CAP=25`) |
| **Production** | `countup-production` | Cloudflare Pages **Production** branch (`main`, e.g. `https://countup.zm`) | Live Zambian sender (`Africa's Talking`, `Twilio`, or local HTTP gateway) |

**Why never share one project?**
- Staging tests (such as deleting shops, triggering PIN lockouts, or importing a 4.5 MB multi-year benchmark backup) can never touch real shopkeeper ledgers, exhaust your production daily SMS budget, or mix test references into your live Mobile Money review queue.
- Generate **different** random secrets (`COUNTUP_PIN_PEPPER`, `SEND_SMS_HOOK_SECRET`, admin passwords, and Turnstile keys) for each project.

---

## 2. Authentication Settings (`Authentication → URL Configuration` & `Providers`)

### A. Site URL & Redirect URLs

Open **Supabase Dashboard → Authentication → URL Configuration**:

| Setting | Production Value | Staging Value |
| --- | --- | --- |
| **Site URL** | `https://countup.zm` *(or `https://<prod-project>.pages.dev`)* | `https://staging.<project>.pages.dev` |
| **Redirect URLs** | `https://countup.zm/**` | `https://*.<project>.pages.dev/**`, `http://localhost:3000/**` |

> Never add broad wildcards like `https://**` or `http://localhost:*` to the **Production** project's Redirect URLs—only admin password-reset links use Redirect URLs, and restricting them to your exact production domain prevents host-header / redirect link hijacking.

### B. Auth Providers, Hooks & MFA

1. **Phone Provider (`Authentication → Providers → Phone`)**:
   - Enable **Phone** provider.
   - Set OTP Length to **6 digits**, OTP Expiry to **300 seconds (5 minutes)**.
   - Enable **Send SMS Hook** (`Authentication → Hooks → Send SMS`) pointing to your deployed `send-sms-hook` Edge Function and save the generated secret as `SEND_SMS_HOOK_SECRET`.
2. **Custom Access Token Hook (`Authentication → Hooks → Custom Access Token`)**:
   - Enable and select Postgres function `public.custom_access_token_hook`.
   - This injects `shop_id` **only** when the caller's GoTrue `session_id` has a non-revoked row in `public.shop_verified_sessions`.
3. **Bot Protection (`Authentication → Bot and Abuse Protection`)**:
   - Enable **Cloudflare Turnstile** and paste your Turnstile **Secret Key**.
4. **Admin Email & Mandatory MFA (`Authentication → Multi-Factor`)**:
   - Enable **TOTP (App Authenticator)**.
   - Pre-create your authorized admin account(s) matching `COUNTUP_PLATFORM_ADMIN_EMAIL` (primary + optional offline backup admin; see `docs/AUTH_AND_SMS_SETUP.md` §6). Both PostgreSQL (`public.is_platform_admin()`) and every admin Edge Function enforce **`aal2`**.

---

## 3. Edge Function Secrets (`Edge Functions → Secrets`)

Deploy all Edge Functions (`supabase functions deploy`) and configure these server-only secrets:

| Secret | Example / Requirement |
| --- | --- |
| `ALLOWED_ORIGIN` | **Exact origin(s), no trailing slash**: `https://countup.zm` on Production (or `https://staging.countup.pages.dev,http://localhost:3000` on Staging). Every Edge Function rejects unlisted `Origin` headers with `403 forbidden_origin` and never emits `*`. |
| `COUNTUP_PIN_PEPPER` | `openssl rand -hex 32` (64 hex chars; back this up in your password manager safe—changing it invalidates existing PIN/recovery hashes). |
| `COUNTUP_PLATFORM_ADMIN_EMAIL` | `ops-primary@countup.zm,ops-backup@countup.zm` |
| `SEND_SMS_HOOK_SECRET` | Secret from **Authentication → Hooks → Send SMS**. |
| `PAYMENT_INSTRUCTIONS_JSON` | JSON instructions returned to authenticated shopkeepers by `get-payment-instructions` (`airtel` and `mtn` merchant/recipient names & numbers—never hardcoded in the public JS bundle). |
| `SMS_PROVIDER` + provider credentials | `africastalking` / `twilio` / `generic_http` + API keys (see `docs/AUTH_AND_SMS_SETUP.md` §4). |

---

## 4. API Limits & Statement Timeouts (`Settings → Data API`)

1. **Exposed Schemas**: Keep **only `public`** exposed (`graphql_public` may remain or be removed; never expose `auth` or internal schemas).
2. **Max Rows (`db-max-rows`)**: Keep at **`1000`** (default).
   - CountUp's cursor sync (`src/data/shopReadRepository.ts`) paginates in deterministic **`500`-row** pages (`ORDER BY updated_at ASC, id ASC`), and multi-year backup restores upload in **`500`-row** chunks (`BACKUP_CHUNK_MAX_ROWS = 500`), so no query ever relies on raising `Max Rows` above `1000`.
3. **Request Payload & Statement Timeouts**:
   - Hosted Supabase enforces an **`8s` default `statement_timeout`** on the `authenticated` role plus Kong/Cloudflare HTTP gateway limits.
   - CountUp **does not** assume function-level `SET statement_timeout` extends hosted PostgREST request timeouts. Instead, `append_shop_backup_chunk` validates and normalizes each `500`-row chunk incrementally, and `finalize_shop_backup_import` hydrates pre-validated ngwee records via C-level `jsonb_populate_recordset` + O(N) aggregate parity verification.
   - **Always verify multi-year backup restore timing on your hosted Staging project** before opening production traffic by running **Step 9 ("Verify on Staging")** in [`docs/STAGING_TEST.md`](./STAGING_TEST.md).

---

## 5. Database Backups & Disaster Recovery (`Settings → Database → Backups`)

1. **Supabase Pro Daily Backups**: Upgrade the **Production** project to **Supabase Pro** before onboarding live paying shops so automated daily PostgreSQL backups (7-day retention) are enabled and project pausing is disabled.
2. **Point-in-Time Recovery (PITR)**: Once active shop volume grows (e.g. 50+ active shops), enable the **PITR add-on** (2-minute recovery-point granularity) so accidental administrative mistakes can be rolled back to any second.
3. **Quarterly Restore Drill**: Once per quarter, restore a production backup into a temporary isolated Supabase project and run **Admin Console → Verify all ledgers** + **Verify subscriptions** (`0 differences`).
4. **Shopkeeper JSON Exports**: Remind shopkeepers to download periodic JSON backups via **Settings → Data & Backups → Download Backup**.

---

## 6. Monitoring, Error Reporting & Daily Admin Routine

CountUp includes built-in, privacy-preserving monitoring directly inside the **Admin Console → Platform monitoring & alerts** panel (`public.platform_alerts`):

| Alert Category | How It Is Triggered | What You Should Do |
| --- | --- | --- |
| **SMS cap & abuse** (`sms_cap`, `sms_abuse`) | Fires an amber **Warning** at **80%** of either daily OTP bucket (`150` new registrations / `200` existing sign-ins) and a red **Critical** alert if **100%** is hit or rate-limit checks fail safe. | Check **Supabase → Edge Functions → Logs** for unusual traffic, verify your SMS provider balance, raise `SMS_DAILY_*_CAP` if legitimate growth caused it, then click **Mark resolved**. |
| **Failed sync batches** (`sync_failure`) | Recorded automatically by `apply_sync_batch` (on the server) and `reportSyncBatchFailure` (for single-entry poison errors) whenever a shop's sync queue halts on an unexpected/corrupt entry. | Contact or inspect the affected shop ID shown in the alert detail; guide the owner through **Review** or **Discard invalid entry** only after checking physical stock/receipts. |
| **Reconcile differences** (`reconcile_diff`) | Persisted automatically as a **Critical** alert whenever **Verify all ledgers** (`reconcile_shop_ledger(NULL)`) or **Verify subscriptions** (`reconcile_subscriptions(NULL)`) finds `> 0` discrepancies; auto-resolves when `0` differences remain. | Inspect the affected `shop_id` / `sale_id` / `payment_id` in the breakdown immediately—zero differences is the mandatory invariant. |
| **Security & client errors** (`security`, `client_error`) | Captures security events and rate-limited (`<= 15/hour/shop`) unhandled client runtime errors from verified shop sessions after scrubbing JWTs, PINs, OTPs, and recovery codes (`src/services/errorReporting.ts`). | Review browser/release version if multiple shops report the same `client_error` after a deploy, then click **Mark resolved**. |
| **Offline sync notes** (`sync_note`) | Low-priority informational log when an active/grace shop syncs a sale recorded `> 72h` earlier (`Synced late, kept`). | Informational only—no action needed unless investigating repeated clock drift on one device. |

### Recommended Weekly Operator Routine (2 Minutes)

1. Sign in to the **Admin Console** with your `aal2` authenticator code.
2. Check **Platform monitoring & alerts** (confirm `0` unresolved critical/warning alerts) and review any **pending** Mobile Money submissions against your official Airtel/MTN statement.
3. Click **Verify all ledgers** and **Verify subscriptions** and confirm both report **`0 differences`**.
4. *(Optional External Uptime Ping)*: Add a free Cloudflare Health Check or UptimeRobot HTTPS monitor against your production URL (`https://countup.zm/`) and `https://<prod-ref>.supabase.co/auth/v1/health` so you receive an email/SMS if either edge or database health degrades.
