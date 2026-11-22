# CountUp — Cloudflare Pages & Edge Security Setup Guide

This guide walks you through deploying **CountUp** on **Cloudflare Pages**, configuring **Cloudflare Turnstile**, and setting up **WAF, Bot Fight Mode, Rate Limiting, and HTTPS rules** in plain language.

---

## 1. Create the Cloudflare Pages Project

1. Sign in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) and open **Workers & Pages → Create → Pages → Connect to Git**.
2. Select your GitHub repository (`ArabNinja-hub/CountUp`).
3. Enter these exact **Build settings**:

| Setting | Value | Why |
| --- | --- | --- |
| **Production branch** | `main` | Publishes verified merges to your live URL; other branches create isolated Preview URLs (`<branch>.<project>.pages.dev`). |
| **Framework preset** | `None` *(or `Vite`)* | Uses the repository's Vite 8 build pipeline directly. |
| **Build command** | `npm run build:cloudflare` | Runs `VITE_BASE_PATH=/ vite build`, pinning asset paths to `/` and generating `dist/_headers` + `dist/sw.js`. *(Note: `base-path.ts` also detects Cloudflare's `CF_PAGES=1` automatically if `npm run build` is used.)* |
| **Build output directory** | `dist` | Contains `index.html`, hashed `assets/*`, `manifest.webmanifest`, `brand/*` icons, `sw.js`, `_headers`, and `_redirects`. |
| **Root directory** | `/` *(leave blank)* | Builds from repository root. |

4. Under **Environment variables**, add the following for **Production** (point to your **Production** Supabase project) and **Preview** (point to your **Staging** Supabase project):

| Variable Name | Value | Notes |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Ensures Node.js 22 LTS is used during the Pages build. |
| `VITE_BASE_PATH` | `/` | Serves CountUp from the domain root (`https://countup.zm/` or `https://<project>.pages.dev/`). |
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | **Also narrows `Content-Security-Policy` `connect-src` in `dist/_headers` to this exact Supabase project host at build time.** |
| `VITE_SUPABASE_ANON_KEY` | `<your-supabase-anon-public-key>` | Public anon key only. **Never** put `service_role` here (`src/supabase/client.ts` blocks startup if a `service_role` key is detected). |
| `VITE_TURNSTILE_SITE_KEY` | `<your-turnstile-site-key>` | Public Cloudflare Turnstile widget site key. |

5. Click **Save and Deploy**.

---

## 2. How SPA Routing, Security Headers & Offline Updates Work Automatically

You do **not** need to hand-edit headers inside the Cloudflare Pages dashboard—every build emits them automatically into `dist/`:

- **SPA Deep-Link Fallback (`public/_redirects`)**:
  `/* /index.html 200` ensures bookmarks or refreshes on deep paths return the app shell with HTTP `200`, while real static files (`/assets/*`, `/brand/*`, `/sw.js`, `/manifest.webmanifest`) always take precedence.
- **Strict Security Headers (`public/_headers` + `scripts/security-headers.ts`)**:
  - `Content-Security-Policy`: Allows scripts only from `'self'` and `https://challenges.cloudflare.com` (no `'unsafe-inline'` or `'unsafe-eval'` in `script-src`), styles from `'self'` and `https://fonts.googleapis.com`, fonts from `'self'` and `https://fonts.gstatic.com`, images from `'self'` and `data:` (for TOTP MFA QR setup), frames only from `https://challenges.cloudflare.com`, workers from `'self'` and `blob:` (for `/sw.js` + Supabase Realtime heartbeat worker), and network/WebSocket connections (`connect-src`) **only** to `'self'`, your exact `https://<ref>.supabase.co` + `wss://<ref>.supabase.co` project host, and `https://challenges.cloudflare.com`.
  - `frame-ancestors 'none'` + `X-Frame-Options: DENY` (blocks iframe clickjacking).
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`: Disables camera, microphone, geolocation, USB, payment, display-capture, and motion sensors.
- **Clean Service Worker Rollouts (`dist/sw.js`)**:
  - `/sw.js` is served with `Cache-Control: no-cache, no-store, must-revalidate` and registered with `updateViaCache: 'none'`.
  - Every release builds an isolated, SHA-256-verified static cache (`countup-static-v1:/:<hash>`) and **never** intercepts or caches authenticated requests (`Authorization` / `apikey`), `/auth/v1/*`, `/rest/v1/*`, `/functions/v1/*`, `/realtime/v1/*`, or `/cdn-cgi/*`.

---

## 3. Set Up Cloudflare Turnstile (Anti-Bot Protection for SMS OTP)

1. In the Cloudflare Dashboard, open **Turnstile → Add widget**.
2. Name it `CountUp Zambia Auth` (create a second widget `CountUp Staging` for staging if desired).
3. Add your **Hostnames**:
   - Your custom domain (e.g. `countup.zm` and `www.countup.zm`)
   - Your Pages domain (e.g. `countup.pages.dev`)
4. Choose **Managed** widget mode (automatically invisible for normal shopkeepers on MTN/Airtel/Zamtel phones and challenges suspicious bots).
5. Copy:
   - **Site Key** → paste into Cloudflare Pages environment variable `VITE_TURNSTILE_SITE_KEY`.
   - **Secret Key** → paste into **Supabase Dashboard → Authentication → Bot and Abuse Protection (CAPTCHA) → Cloudflare Turnstile**.

---

## 4. Connect a Custom Domain & Configure HTTPS / TLS Settings

Once you attach a custom domain (e.g. `countup.zm`) in **Workers & Pages → `<project>` → Custom domains** (orange-cloud **Proxied** in DNS), open that domain zone in Cloudflare and set:

### SSL/TLS → Overview & Edge Certificates

| Setting | Value |
| --- | --- |
| **SSL/TLS encryption mode** | **Full (strict)** |
| **Always Use HTTPS** | **On** |
| **Minimum TLS Version** | **TLS 1.2** |
| **TLS 1.3** | **On** |
| **Automatic HTTPS Rewrites** | **On** |
| **HTTP Strict Transport Security (HSTS)** | Enable with **Max Age = 1 month** first (`2592000`), **No-Sniff = On**; raise to **12 months** (`31536000`, `Include subdomains = On`) once verified. |

---

## 5. Cloudflare Dashboard Security Rules (Exact Expressions)

Open your domain zone in Cloudflare → **Security**:

### A. WAF Managed Rules (**Security → WAF → Managed rules**)

1. Enable **Cloudflare Managed Ruleset** (default action: *Managed Challenge* / *Block*).
2. Enable **Cloudflare OWASP Core Ruleset** (Paranoia Level **PL1**, Score Threshold **Medium / 40**, Action **Block**).
   *(Available on Cloudflare Pro+; on the Free plan, enable the **Cloudflare Free Managed Ruleset**.)*

### B. Bot Protection (**Security → Bots**)

1. Turn **Bot Fight Mode = ON**.
2. **Important if you proxy Supabase under a subdomain of the same zone** (e.g. `api.countup.zm`): Supabase Auth calls `/functions/v1/send-sms-hook` server-to-server. Keep Supabase on its native `https://<project-ref>.supabase.co` URL (recommended—CountUp's Edge Functions already enforce strict `ALLOWED_ORIGIN` CORS and CGNAT-tuned IP/phone limits), **or** if you proxy Supabase on a custom domain on Cloudflare Pro+, add a WAF **Skip** rule before Bot Fight / Super Bot Fight for:
   ```txt
   (http.host eq "api.countup.zm" and http.request.uri.path eq "/functions/v1/send-sms-hook")
   ```

### C. Rate Limiting Rules (**Security → WAF → Rate limiting rules**)

> **Note on Zambian Mobile Networks (CGNAT)**: Hundreds of MTN (`096/076`), Airtel (`097/077`), and Zamtel (`095/075`) phones often share a single carrier IPv4 address. Keep IP thresholds generous enough for carrier NAT and use **Managed Challenge** on general web traffic, while CountUp's server-side per-phone hashed limits (`3 / 15m`, `8 / 24h`) stop targeted SMS abuse cleanly.

#### Rule 1 — Site HTML / SPA Flood Protection (All Plans, Including Free Plan's 1 Free Rate-Limit Rule)

- **Rule name**: `CountUp SPA flood protection (CGNAT-safe)`
- **If incoming requests match (Custom filter expression)**:
  ```txt
  (http.request.method eq "GET" and not starts_with(http.request.uri.path, "/assets/") and not starts_with(http.request.uri.path, "/brand/") and http.request.uri.path ne "/sw.js" and http.request.uri.path ne "/manifest.webmanifest")
  ```
- **Characteristics**: `IP`
- **Requests / Period**: **120 requests per 1 minute** *(or **20 requests per 10 seconds** on the Free plan)*
- **Action**: **Managed Challenge** *(or **Block** for 60 seconds if Managed Challenge is unavailable on your plan tier)*

#### Rule 2 — Proxied Supabase OTP & Auth Endpoint Shield *(Add if Supabase `/auth/v1/*` or `/functions/v1/*` is proxied through Cloudflare)*

- **Rule name**: `CountUp Auth & OTP rate limit (CGNAT-tuned)`
- **Custom filter expression**:
  ```txt
  (http.request.method eq "POST" and (starts_with(http.request.uri.path, "/auth/v1/otp") or starts_with(http.request.uri.path, "/auth/v1/verify") or starts_with(http.request.uri.path, "/functions/v1/check-otp-rate-limit")))
  ```
- **Characteristics**: `IP`
- **Requests / Period**: **30 requests per 10 minutes** *(matches `SMS_MAX_PER_IP_15M = 30`)*
- **Action**: **Block** (`429 Too Many Requests`, duration `10 minutes`)

#### Rule 3 — Proxied PIN Unlock / Recovery / Admin Brute-Force Shield *(Add if `/functions/v1/*` is proxied through Cloudflare)*

- **Rule name**: `CountUp PIN & Admin Edge Function rate limit`
- **Custom filter expression**:
  ```txt
  (http.request.method eq "POST" and (starts_with(http.request.uri.path, "/functions/v1/unlock-shop-session") or starts_with(http.request.uri.path, "/functions/v1/recover-shop-pin") or starts_with(http.request.uri.path, "/functions/v1/register-shop") or starts_with(http.request.uri.path, "/functions/v1/verify-platform-admin")))
  ```
- **Characteristics**: `IP`
- **Requests / Period**: **40 requests per 10 minutes**
- **Action**: **Block** (`429 Too Many Requests`, duration `10 minutes`)
