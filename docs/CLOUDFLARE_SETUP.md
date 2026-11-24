# CountUp — Cloudflare Worker & Edge Security Setup Guide

This guide walks you through deploying **CountUp** as a **Cloudflare Worker named `countup`** using Workers Static Assets, configuring **Cloudflare Turnstile**, and setting up **WAF, Bot Fight Mode, Rate Limiting, and HTTPS rules** in plain language.

> The site is **not** a Cloudflare Pages project. Builds are run by Workers Builds and published with `npx wrangler deploy`. The committed `wrangler.jsonc` is the source of truth for the Worker's runtime configuration.

---

## 1. Connect the Worker to Git

1. Sign in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) and open **Workers & Pages → `countup` → Settings → Build** (or **Create → Workers → Connect to Git** if the Worker was not created yet).
2. Select the GitHub repository `ArabNinja-hub/CountUp` and the production branch `main`.
3. Keep these **Build settings** in the dashboard:

| Setting | Value | Why |
| --- | --- | --- |
| **Git repository / branch** | `ArabNinja-hub/CountUp` / `main` | Publishes verified merges to the live Worker. Other branches get Preview URLs when preview builds are enabled. |
| **Build command** | `npm run build:cloudflare` | Runs `VITE_BASE_PATH=/ vite build`, producing `dist/` with root-absolute asset URLs, `dist/_headers`, and `dist/sw.js`. `npm ci` works because the repo uses `package-lock.json` (the stale `bun.lock` was removed). |
| **Deploy command** | `npx wrangler deploy` | Deploys the Worker and its static assets from `dist/`. Wrangler reads `wrangler.jsonc` from the repository root. |
| **Root directory** | `/` *(leave blank)* | Builds from the repository root. |
| **Build output directory** | *No dashboard setting on Workers* | `assets.directory` in `wrangler.jsonc` points Wrangler at `./dist`. |

4. Under **Settings → Build → Build variables and secrets** (or **Settings → Environment variables** on older dashboards), add for Production (point to your Production Supabase project) and, if you use preview builds, for Staging:

| Variable Name | Value | Notes |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Keeps the Workers Builds image on Node.js 22. |
| `VITE_BASE_PATH` | `/` | Serves CountUp from the domain root (`https://countup.<subdomain>.workers.dev/` or a custom domain). |
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | **Also narrows `Content-Security-Policy` `connect-src` in `dist/_headers` to this exact Supabase host at build time.** |
| `VITE_SUPABASE_ANON_KEY` | `<your-supabase-anon-public-key>` | Public anon key only. **Never** put `service_role` here (`src/supabase/client.ts` blocks startup if a `service_role` key is detected). |
| `VITE_TURNSTILE_SITE_KEY` | `<your-turnstile-site-key>` | Public Cloudflare Turnstile widget site key. |

These are **build-time** variables: Vite inlines them into `dist/`, so no runtime Worker secrets are needed for the app shell.

5. Commit and push. Workers Builds runs the build command, then `npx wrangler deploy`.

### `wrangler.jsonc` (committed in the repo)

```jsonc
{
  "name": "countup",
  "compatibility_date": "2026-11-24",
  "build": {
    "command": "npm run build:cloudflare"
  },
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

- `name` must stay `countup` so Wrangler targets the existing Worker rather than creating a new one.
- `assets.directory: "./dist"` uploads the Vite output; there is no Worker `main` because this is an assets-only Worker.
- `not_found_handling: "single-page-application"` serves `index.html` with HTTP `200` for unmatched paths (deep links and refreshes).
- `compatibility_date` pins Workers runtime behavior. Refresh it to the current date periodically; a recent date (`>= 2025-04-01`) is needed for the current navigation/asset-routing behavior.

**About the “Update your Wrangler configuration with these changes to keep deployments in sync” notice:** it is Cloudflare's generic *source-of-truth* warning. It means a setting was changed in the dashboard (often Observability logs/traces or plaintext variables) and would be reverted by the next `wrangler deploy`, which applies `wrangler.jsonc` as the source of truth. Copy the **specific fields listed in your notice** into `wrangler.jsonc` (for example `"observability": { "logs": { "enabled": true } }` or non-secret `"vars"`). Do **not** put secrets in `vars` — use `npx wrangler secret put`. The **build command is the exception**: Workers Builds does not honor `build.command` from Wrangler config, so the dashboard **Settings → Build → Build command** must remain `npm run build:cloudflare`; the `build` block in `wrangler.jsonc` exists for local/`wrangler deploy` builds and as documentation. If your notice only mentions fields we have not listed here, paste those lines into the config and redeploy.

---

## 2. SPA Routing, Security Headers & Offline Updates

You do **not** need to hand-edit headers in the dashboard—every build emits them into `dist/_headers`:

- **SPA deep-link fallback:** `wrangler.jsonc` sets `assets.not_found_handling: "single-page-application"`. Real files (`/assets/*`, `/brand/*`, `/sw.js`, `/manifest.webmanifest`) always win; unmatched paths return `index.html` with `200`. A Pages-style `public/_redirects` rule (`/* /index.html 200`) was **removed**: Workers parses `_redirects`, treats that self-matching rewrite as an infinite loop (error `100324`), and rejects or ignores the deployment. No custom redirects are needed.
- **Strict security headers (`public/_headers` + `scripts/security-headers.ts`):**
  - `Content-Security-Policy`: scripts only from `'self'` and `https://challenges.cloudflare.com` (no `'unsafe-inline'` / `'unsafe-eval'`), styles from `'self'`, `'unsafe-inline'` (inline chart/progress styles) and `https://fonts.googleapis.com`, fonts from `https://fonts.gstatic.com`, images from `'self'` and `data:` (TOTP QR setup), frames only from Turnstile, workers from `'self'` and `blob:` (the offline service worker plus Supabase Realtime's heartbeat worker), and `connect-src` limited to `'self'`, your exact Supabase HTTPS/WSS host, and Turnstile. The generated CSP line is ~520 characters, below Workers' 2,000-character per-line limit for `_headers`.
  - `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Permissions-Policy`.
  - Workers Static Assets applies `_headers` to static asset responses, including the SPA fallback shell. There is no Worker entry point generating responses, so no header code is needed elsewhere.
- **Clean service worker rollouts (`dist/sw.js`):**
  - `/sw.js` is served with `Cache-Control: no-cache, no-store, must-revalidate`, registered from `${import.meta.env.BASE_URL}sw.js` (`/sw.js` on Workers) with `updateViaCache: 'none'`. On a `workers.dev` address it is same-origin, so `worker-src 'self'` and `connect-src 'self'` in the CSP allow it unchanged.
  - Each release builds an isolated, SHA-256-verified static cache (`countup-static-v1:/:<hash>`) and **never** intercepts or caches authenticated requests (`Authorization` / `apikey`), `/auth/v1/*`, `/rest/v1/*`, `/functions/v1/*`, `/realtime/v1/*`, or `/cdn-cgi/*`.
  - `_headers` (and any stale `_redirects`) are excluded from the precache manifest, so the worker install never fetches config files that Workers does not serve.

### Verify locally before pushing

```bash
npm ci
npm run check:edge-functions   # requires Deno 2.5.2, optional but recommended
npm run typecheck
npm test
npm run build:cloudflare
npx wrangler@4.167.0 deploy --dry-run --outdir /tmp/countup-wrangler-dry-run
npx wrangler@4.167.0 dev --local
# open http://127.0.0.1:8787/ and a deep link such as http://127.0.0.1:8787/plan
# the deep link must return 200 with the app shell and no redirect warning
```

---

## 3. Set Up Cloudflare Turnstile (Anti-Bot Protection for SMS OTP)

1. In the Cloudflare Dashboard, open **Turnstile → Add widget**.
2. Name it `CountUp Zambia Auth` (create a second widget `CountUp Staging` for staging if desired).
3. Add your **Hostnames**:
   - Your custom domain (e.g. `countup.zm` and `www.countup.zm`).
   - Your Worker domain (e.g. `countup.<your-subdomain>.workers.dev`) and any Preview URLs you use.
4. Choose **Managed** widget mode (automatically invisible for normal shopkeepers on MTN/Airtel/Zamtel phones and challenges suspicious bots).
5. Copy:
   - **Site Key** → paste into the Cloudflare Worker **build variable** `VITE_TURNSTILE_SITE_KEY`.
   - **Secret Key** → paste into **Supabase Dashboard → Authentication → Bot and Abuse Protection (CAPTCHA) → Cloudflare Turnstile**.

---

## 4. Connect a Custom Domain & Configure HTTPS / TLS Settings

Attach a custom domain (e.g. `countup.zm`) under **Workers & Pages → `countup` → Settings → Domains & Routes → Custom domains** (orange-cloud **Proxied** in DNS), then open that domain zone in Cloudflare and set:

### SSL/TLS → Overview & Edge Certificates

| Setting | Value |
| --- | --- |
| **SSL/TLS encryption mode** | **Full (strict)** |
| **Always Use HTTPS** | **On** |
| **Minimum TLS Version** | **TLS 1.2** |
| **TLS 1.3** | **On** |
| **Automatic HTTPS Rewrites** | **On** |
| **HTTP Strict Transport Security (HSTS)** | Enable with **Max Age = 1 month** first (`2592000`), **No-Sniff = On**; raise to **12 months** (`31536000`, **Include subdomains = On**) once verified. |

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
