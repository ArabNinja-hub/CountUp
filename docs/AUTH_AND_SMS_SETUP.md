# CountUp Zambia — Phone OTP, Swappable SMS, PBKDF2 Benchmarks & Turnstile Setup

This guide explains how to configure phone verification (SMS OTP), SMS abuse caps, Cloudflare Turnstile anti-abuse protection, PBKDF2 security parameters, and real-number testing for Zambian mobile networks (**MTN**, **Airtel**, and **Zamtel**) without changing application code.

---

## 1. Architecture Overview (Plain Language)

1. **Phone OTP (`+260`) + Turnstile CAPTCHA + CGNAT-Tuned & Split-Budget SMS Caps**:
   - Every new shop registration and new-device sign-in requires a 6-digit SMS code sent by Supabase Auth.
   - Before Supabase sends an SMS, Cloudflare Turnstile verifies a real browser AND `check-otp-rate-limit` + `send-sms-hook` enforce:
     - **Per-phone limits**: max **3 OTPs per 15 minutes** and **8 OTPs per 24 hours** (stored as peppered SHA-256 hashes, never raw phone numbers).
     - **Per-IP limits (tuned for Zambian mobile CGNAT)**: max **30 OTPs per 15 minutes** and **100 OTPs per 24 hours**, reading the real client IP from Cloudflare's `CF-Connecting-IP` header when present so legitimate MTN/Airtel/Zamtel handsets sharing a carrier NAT IPv4 address are not falsely throttled.
     - **Split daily OTP budgets**:
       1. **New shop registrations** (`SMS_DAILY_NEW_REGISTRATION_CAP`, default **150 SMS / UTC day**).
       2. **Existing-shop sign-ins** (`SMS_DAILY_EXISTING_SIGNIN_CAP`, default **200 SMS / UTC day**).
       3. **Security notice SMS** (72-hour PIN reset warnings and one-time recovery-code usage alerts) are **exempt from both daily OTP caps** so an OTP surge can never silence owner anti-takeover alerts.
     - **80% warning + 100% fail-safe stop**: When either daily OTP budget reaches **80%** (`SMS_BUDGET_WARNING_PERCENT`), CountUp posts an amber **Warning Alert** on the Admin Screen (`public.platform_alerts`). If a bucket hits **100%**—or if the rate-limit table cannot be checked—only that OTP bucket **pauses immediately (fails safe)** and posts a red **Critical Alert** banner.
2. **Swappable SMS Delivery (`send-sms-hook`)**:
   - Changing the `SMS_PROVIDER` secret in Supabase switches delivery between **Africa's Talking**, **Twilio**, or **any Zambian local HTTP SMS gateway** (Zamtel Bulk SMS, Probase, Cloudservice ZM) in seconds.
3. **SIM-Swap Protection, Recovery Lockouts & 72-Hour Fallback**:
   - Completing SMS OTP alone **does not** grant database access to a shop.
   - A new device must verify the shop's 4-digit PIN (`shop_verified_sessions` bound strictly to GoTrue `session_id`) before `custom_access_token_hook` issues the `shop_id` claim required by Row-Level Security.
   - Both new-device PIN attempts **and** one-time recovery-code attempts have escalating per-shop lockouts. Using a recovery code rotates the code and sends a **Security Alert** to existing devices.
   - If a shopkeeper loses **both** their PIN and recovery code, a `platform_admin` (verified with TOTP 2FA `aal2`) can initiate an **Admin-Approved PIN Reset** with a mandatory **72-hour waiting period**, an immediate SMS warning to the owner's number, and a **Cancel Reset** button on the shop's existing phone.

---

## 2. PBKDF2 Iteration Counts & Low-End Android Unlock Benchmarks

CountUp uses native **WebCrypto `PBKDF2-HMAC-SHA256`** in two distinct places with intentionally tuned work factors (`shared/authSecurity.ts` & `src/utils/pinLock.ts`):

| Where It Runs | Constant | Iterations | Salt & Pepper | Why This Exact Count |
| --- | --- | --- | --- | --- |
| **Server Edge Functions** (`register-shop`, `unlock-shop-session`, `recover-shop-pin`, `change-shop-pin`, `complete-approved-pin-reset`) | `SERVER_PBKDF2_ITERATIONS` | **210,000** | 16-byte random CSPRNG salt + server-only secret `COUNTUP_PIN_PEPPER` | Matches **OWASP 2023+ PBKDF2-HMAC-SHA256** guidance (`210,000` iterations). Runs on Deno Edge isolates in ~25–40 ms while making offline brute-force costly even if DB rows were ever leaked. |
| **Same-Device Offline Screen Lock** (`src/utils/pinLock.ts`) | `LOCAL_PBKDF2_ITERATIONS` | **120,000** | 16-byte random CSPRNG salt per device/shop (`countup_pin_v1:<shopId>`) | Keeps daily counter-side screen unlock crisp (**< 250 ms**) on entry-level Zambian Android phones (Unisoc SC9863A / MediaTek Helio A22, e.g., Tecno Pop / Itel A-series) while remaining strong on-device. |

### Measured Unlock Latency (`measureLocalPbkdf2UnlockMs()`)

Using native Chromium C++/BoringSSL WebCrypto (`crypto.subtle.deriveBits`) with `LOCAL_PBKDF2_ITERATIONS = 120,000`:

- **Modern desktop / server V8**: ~12–22 ms per PIN check.
- **Mid-range Android (Snapdragon 680 / Helio G85)**: ~55–85 ms per PIN check.
- **Entry-level Android (4× Cortex-A53 / Cortex-A55 @ 1.6 GHz — Tecno Pop 7 / Itel A60 / Samsung Galaxy A03 Core, Chrome Android)**: **~145–210 ms** per PIN check — feels instantaneous to a shopkeeper unlocking the till between customers while working 100% offline.
- You can run `measureLocalPbkdf2UnlockMs()` from `src/utils/pinLock.ts` on any target handset browser console to record exact hardware timing.

---

## 3. Required Environment Variables & Secrets

### Browser Environment Variables (`.env` / Cloudflare Pages)

Only public, safe-for-browser keys go here:

```bash
VITE_SUPABASE_URL="https://<your-project-ref>.supabase.co"
VITE_SUPABASE_ANON_KEY="<your-supabase-anon-public-key>"
VITE_TURNSTILE_SITE_KEY="<your-cloudflare-turnstile-site-key>"
```

> Never put `SUPABASE_SERVICE_ROLE_KEY`, `COUNTUP_PIN_PEPPER`, or SMS API keys in `VITE_*` variables. `src/supabase/client.ts` actively checks and refuses to boot if a `service_role` token is accidentally passed.

### Supabase Edge Function Secrets (Server-Only)

Set these in **Supabase Dashboard → Edge Functions → Secrets** (or `supabase secrets set`):

| Secret Name | Purpose |
| --- | --- |
| `ALLOWED_ORIGIN` | Exact web app origin allowed by CORS, e.g. `https://countup.pages.dev` (comma-separated if staging + prod). |
| `COUNTUP_PIN_PEPPER` | Random secret string (at least 32 characters) mixed into server PBKDF2 hashes for PINs, recovery codes, hashed `used_trial_phones`, and hashed SMS rate-limit keys. |
| `COUNTUP_PLATFORM_ADMIN_EMAIL` *(or `COUNTUP_PLATFORM_ADMIN_EMAILS`)* | Comma-separated verified email address(es) allowed to claim `platform_admin` (primary admin + optional offline backup admin; **every** admin session strictly requires TOTP MFA `aal2`). |
| `SEND_SMS_HOOK_SECRET` | Webhook signing secret generated in **Supabase Dashboard → Authentication → Hooks → Send SMS**. |
| `SMS_PROVIDER` | One of `africastalking`, `twilio`, or `generic_http`. |
| `SMS_MAX_PER_PHONE_15M` *(optional)* | Max OTP SMS per phone number in a rolling 15-minute window (default `3`). |
| `SMS_MAX_PER_PHONE_24H` *(optional)* | Max OTP SMS per phone number in a rolling 24-hour window (default `8`). |
| `SMS_MAX_PER_IP_15M` *(optional)* | Max OTP SMS per client IP (`CF-Connecting-IP`) in 15 minutes, tuned for Zambian carrier CGNAT (default `30`). |
| `SMS_MAX_PER_IP_24H` *(optional)* | Max OTP SMS per client IP (`CF-Connecting-IP`) in 24 hours, tuned for Zambian carrier CGNAT (default `100`). |
| `SMS_DAILY_NEW_REGISTRATION_CAP` *(optional)* | Daily UTC cap for new-shop registration OTPs before pausing new registrations and raising a critical Admin alert (default `150`). |
| `SMS_DAILY_EXISTING_SIGNIN_CAP` *(optional)* | Daily UTC cap for existing-shop sign-in OTPs before pausing sign-in OTPs and raising a critical Admin alert (default `200`). Security notice SMS do not count against either cap. |
| `SMS_BUDGET_WARNING_PERCENT` *(optional)* | Percentage threshold (`50`–`99`) at which an amber Warning Alert is posted to the Admin Screen for either daily OTP budget (default `80`). |
| `SMS_GLOBAL_DAILY_CAP` *(optional)* | Optional hard ceiling across both OTP buckets combined if desired (unset by default so registration bursts cannot starve existing-shop sign-ins). |

---

## 4. Configuring Your Chosen SMS Provider

Set `SMS_PROVIDER` and only the secrets for the provider you want active:

### Option A: Africa's Talking (`SMS_PROVIDER=africastalking`) — Recommended for Zambia
- `AFRICASTALKING_USERNAME`: Your Africa's Talking app username.
- `AFRICASTALKING_API_KEY`: Your Africa's Talking API key.
- `AFRICASTALKING_SENDER_ID` *(optional)*: Registered sender ID (e.g. `CountUp`); leave blank during initial testing.

### Option B: Twilio (`SMS_PROVIDER=twilio`)
- `TWILIO_ACCOUNT_SID`: Your Twilio Account SID (`AC...`).
- `TWILIO_AUTH_TOKEN`: Your Twilio Auth Token.
- `TWILIO_FROM`: Sender phone number or Messaging Service SID.

### Option C: Any Local Zambian HTTP Gateway (`SMS_PROVIDER=generic_http`)
- `GENERIC_SMS_WEBHOOK_URL`: HTTPS endpoint of your SMS gateway.
- `GENERIC_SMS_BEARER_TOKEN` *(optional)*: Bearer API key sent in `Authorization` header.
- `GENERIC_SMS_SENDER_ID` *(optional)*: Sender label included in JSON payload `{ "to": "+260...", "message": "...", "senderId": "..." }`.

---

## 5. Testing With Real Zambian Mobile Numbers (MTN, Airtel, Zamtel)

CountUp normalizes all valid 9-digit Zambian subscriber numbers into E.164 format (`+260XXXXXXXXX`) before calling Supabase Auth:

| Network | Accepted Local Inputs | Normalized E.164 Sent to SMS Gateway |
| --- | --- | --- |
| **MTN Zambia** | `096XXXXXXX`, `076XXXXXXX`, `+260 96...`, `+260 76...` | `+26096XXXXXXX` / `+26076XXXXXXX` |
| **Airtel Zambia** | `097XXXXXXX`, `077XXXXXXX`, `+260 97...`, `+260 77...` | `+26097XXXXXXX` / `+26077XXXXXXX` |
| **Zamtel** | `095XXXXXXX`, `075XXXXXXX`, `+260 95...`, `+260 75...` | `+26095XXXXXXX` / `+26075XXXXXXX` |

Follow [`docs/STAGING_TEST.md`](./STAGING_TEST.md) for the complete 8-step two-phone live staging verification script.

---

## 6. Admin MFA (`aal2`) Authenticator Loss Recovery (Without Weakening `aal2`)

CountUp enforces **`aal2` (TOTP two-factor verification)** at **both** the PostgreSQL RLS layer (`public.is_platform_admin()`) and every privileged Edge Function (`verify-platform-admin`, `admin-reset-pin-lockout`, `admin-initiate-pin-reset`). Password-only (`aal1`) sessions are denied across all admin tables and RPCs. Never relax `aal2` to recover an admin phone—use the two layers below instead:

1. **Store the TOTP Setup Key Offline During First Enrollment**:
   - When enrolling your primary admin account on `AdminLoginPanel`, copy the alphanumeric **Manual Setup Key** displayed beside the QR code.
   - Store a copy in an **encrypted password manager** (e.g., Bitwarden / 1Password protected by a hardware key or master passphrase) **and/or** print it on a physical recovery sheet stored in a locked safe.
   - If your phone is lost, damaged, or stolen, re-import that setup key into any TOTP authenticator app on a replacement device to immediately generate valid `aal2` codes—and if stolen, rotate the TOTP factor immediately afterward.
2. **Pre-Enroll a Second Backup-Admin Account (Separate Device / Safe)**:
   - `COUNTUP_PLATFORM_ADMIN_EMAIL` (or `COUNTUP_PLATFORM_ADMIN_EMAILS`) accepts a **comma-separated list** of verified admin emails, for example:
     ```bash
     COUNTUP_PLATFORM_ADMIN_EMAIL="ops-primary@countup.zm,ops-backup@countup.zm"
     ```
   - Enroll `ops-backup@countup.zm` with its **own independent password and TOTP authenticator** stored on a dedicated offline backup device (or co-founder's hardware token).
   - Both accounts still strictly require **`aal2`** on every login, so day-to-day platform operations continue uninterrupted even if the primary admin phone is unavailable.
3. **Last-Resort Factor Rotation via Supabase Project Owner Console**:
   - If both the primary phone and offline setup key are ever compromised or lost simultaneously, a Supabase Organization Owner protected by Supabase's own MFA can remove the stale `auth.mfa_factors` row for that admin user in the Supabase SQL Editor (`DELETE FROM auth.mfa_factors WHERE user_id = '<admin-uuid>';`). On next sign-in, `AdminLoginPanel` will remain at `aal1` (zero data access) until a brand-new TOTP factor is enrolled and verified to `aal2`.

