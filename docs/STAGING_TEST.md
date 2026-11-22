# CountUp Zambia — Two-Phone Manual Staging Test Script

Use this step-by-step checklist with **two real phones** (or one phone + a separate laptop/tablet browser) against your **Staging Supabase project** before promoting to production.

---

## What You Need Before Starting

1. **Phone A ("Shop Phone")** with an active Zambian SIM card (**MTN `096/076`**, **Airtel `097/077`**, or **Zamtel `095/075`**) that has **never** registered on this staging database before.
2. **Phone B ("Second / Replacement Phone")** — any smartphone or incognito browser on another device.
3. **Admin Laptop/Browser** with an authenticator app (**Google Authenticator**, **Authy**, or **1Password**) ready to scan a QR code for Admin 2-Factor Authentication (`aal2`).
4. A pen and paper to write down the **one-time recovery code** (`CU-XXXX-XXXX-XXXX`).

---

## Step 1 — Register Shop, SMS OTP & Set 4-Digit PIN (Phone A)

1. Open your staging CountUp URL on **Phone A**.
2. Choose **Register**, enter your real `+260` / `09...` mobile number, complete the Cloudflare Turnstile check, and tap **Send 6-Digit SMS Code**.
3. **Expected**:
   - Within ~15 seconds, Phone A receives the 6-digit SMS code.
4. Enter the 6-digit SMS code, then enter:
   - **Shop Name**: `Staging Test Shop`
   - **Choose 4-Digit PIN**: `2580`
   - **Repeat 4-Digit PIN**: `2580`
5. Tap **Create Shop**.
6. **Expected**:
   - A modal appears showing your **One-Time Recovery Code** (`CU-XXXX-XXXX-XXXX`).
   - Write this code down on paper, tick the confirmation box, and tap **I Have Saved My Recovery Code**.
   - The shop opens with a **30-day Free Trial** badge.
7. Lock the screen inside CountUp (Header → Lock icon), turn **Airplane Mode ON**, and enter `2580`.
8. **Expected**:
   - Same-device PIN unlock works **100% offline** in well under half a second. Turn Airplane Mode back **OFF**.

---

## Step 2 — New-Device Sign-In & SIM-Swap Protection Check (Phone B)

1. Open the staging CountUp URL on **Phone B** and tap **Log In**.
2. Enter the **same** phone number from Step 1 and tap **Send 6-Digit SMS Code**.
3. Read the 6-digit SMS code that arrives on Phone A and type it into Phone B.
4. **Expected (SIM-Swap Gate)**:
   - Phone B does **NOT** open the shop yet! Even with a valid SMS OTP, it stops on the **"Enter your 4-digit shop PIN to unlock your shop"** screen, and zero shop items/sales are readable.
5. Enter `2580` on Phone B.
6. **Expected**:
   - Phone B unlocks `Staging Test Shop` and syncs the shop profile.

---

## Step 3 — "Sign Out All Other Devices" (Phone A Revokes Phone B)

1. On **Phone A**, go to **Settings → Account & Access** and tap **Sign Out All Other Devices**.
2. **Expected**:
   - Phone A shows a green confirmation toast (`Signed out other devices`) and stays signed in.
   - Refresh or trigger an action on **Phone B**: Phone B loses its verified session and cannot read shop data without signing in and verifying the PIN again.

---

## Step 4 — Wrong-PIN Brute-Force Lockout (Phone B vs. Offline Phone A)

1. On **Phone B** (in a fresh private/incognito tab), log in with the shop phone number + SMS OTP so you reach the **4-Digit PIN** prompt.
2. Enter a **wrong PIN** (`0000`) **5 times in a row**.
3. **Expected**:
   - Attempts 1–4 say *"Incorrect PIN. X attempts left before temporary lockout."*
   - Attempt 5 locks new-device sign-in for **15 minutes** and switches Phone B to the **Recovery Code** screen.
   - Even typing the **correct** PIN (`2580`) on Phone B is blocked while locked out.
4. Immediately test **Phone A** (the shop's existing trusted phone): lock the app screen and enter `2580`.
5. **Expected**:
   - **Phone A still unlocks immediately** — an attacker guessing PINs on another device never locks the shopkeeper out of the till in their hand.

---

## Step 5 — One-Time Recovery Code + Security Notice on Existing Device

1. While Phone B is still in the 15-minute PIN lockout from Step 4, stay on Phone B's **Recover PIN** screen.
2. Enter the **One-Time Recovery Code** you wrote down in Step 1 (`CU-XXXX-XXXX-XXXX`) and choose a **new 4-digit PIN**: `4682`.
3. **Expected on Phone B**:
   - Lockout clears immediately, PIN updates to `4682`, and CountUp displays a **brand-new** One-Time Recovery Code (write this new code down — the old one will never work again).
4. **Expected on Phone A**:
   - Within seconds (via Realtime wake-up + cursor sync), a prominent amber **Security Alert banner** appears at the top of Phone A warning: *"Your one-time recovery code was just used to set a new shop PIN on a device."*
   - Tap **Dismiss** on Phone A to clear the security alert.

---

## Step 6 — Admin MFA (`aal2`) Enrollment & Admin Lockout Reset

1. Open an incognito window on your **Admin Laptop**, open CountUp, scroll to the bottom of the sign-in card, and tap **Platform admin sign-in**.
2. Enter your authorized admin email (`COUNTUP_PLATFORM_ADMIN_EMAIL`) and password.
3. **Expected (Mandatory TOTP MFA `aal2`)**:
   - Admin Console does **not** open after password alone.
   - First sign-in shows a **QR Code + Manual Secret** for your authenticator app. Scan it and enter the 6-digit code.
   - Admin Console opens (`server-verified MFA (aal2) access`).
4. On **Phone B** (incognito), trigger a new 5-attempt wrong-PIN lockout again (`0000` × 5).
5. In the **Admin Console**, find `Staging Test Shop`, click **Reset PIN lockout**, type an identity note of at least 10 characters (e.g. `Called owner on MTN line and verified NRC + shop name`), and click **Confirm lockout reset**.
6. **Expected**:
   - Phone B can immediately sign in with `4682` without waiting 15 minutes.
   - **Phone A** displays a Security Alert banner stating platform support reset the new-device PIN lockout.

---

## Step 7 — 72-Hour Admin-Approved PIN Reset (Lost PIN + Lost Recovery Code) + Cancellation

1. In the **Admin Console**, find `Staging Test Shop`, click **Approve 72h PIN reset**, enter an identity check note (`Verified owner in person with NRC after lost PIN & recovery sheet`), and click **Confirm 72-hour PIN reset**.
2. **Expected**:
   - **Phone A receives a real SMS** warning that a 72-hour PIN reset was requested and advising the owner to cancel in CountUp if they did not request it.
   - **Phone A** shows an urgent banner in the app header with a **Cancel Reset** button.
   - On **Phone B** (signing in via SMS OTP), trying to reset early shows *"72-hour support PIN reset in waiting period"* with the exact unlock date/time — completion is blocked before 72 hours.
3. On **Phone A**, tap **Cancel Reset** on the security banner.
4. **Expected**:
   - The pending 72-hour reset is immediately cancelled and disappears on both Phone A and Phone B.

---

## Step 8 — Shop Deletion & Hashed Trial-Reuse Block

1. On **Phone A**, open **Settings → Account & Access → Delete Shop**.
2. Type `Staging Test Shop` and enter current PIN `4682`, then confirm deletion.
3. **Expected**:
   - Shop and its records are permanently deleted and Phone A signs out cleanly.
   - In Supabase Table Editor → `public.used_trial_phones`, verify only a 64-character `phone_hash` is stored (**no `+260` phone number appears anywhere in that table**).
4. Register a brand-new shop on **Phone A** using the **same SIM card** (`Staging Reopened Shop`, PIN `1357`).
5. **Expected**:
   - Registration succeeds, **but `plan_status` starts as `expired` (`trialGranted: false`)** — the same phone number cannot claim a second free 30-day trial.

---

## Step 9 — Verify on Staging: 4.5 MB Multi-Year Backup Import & Timeout Check

> **Verify on Staging (Mandatory Before Production Launch)**: Do **not** assume function-level `SET statement_timeout` extends request timeouts on hosted Supabase. Hosted Supabase enforces role-level `statement_timeout` (`8s` default on `authenticated`) plus PostgREST/gateway timeouts. Run this exact 4.5 MB test against your **hosted Staging Supabase project** and record the observed durations.

1. On your laptop, generate the ~4.5 MB two-year benchmark backup (`11,300` sales, `~16,800` sale lines, `400` repayments, `300` expenses):
   ```bash
   node scripts/generate-staging-4_5mb-backup.mjs /tmp/countup-staging-4_5mb-backup.json
   ```
2. Open your **Staging CountUp URL** on **Phone A** (or Chrome on your laptop with **DevTools → Network** open), sign in to a **new/empty** active staging shop, and open **Settings → Data & Backups**.
3. Select `/tmp/countup-staging-4_5mb-backup.json` to run the **staged chunked dry-run preview**, then confirm **Restore backup**.
4. In **Chrome DevTools → Network** (filtering by `rpc/`), record and note down:
   - **Total staged upload time** (`begin_shop_backup_import` + `append_shop_backup_chunk` calls): `________ ms`
   - **Single `finalize_shop_backup_import` request time**: `________ ms` *(must succeed with HTTP `200` well below hosted Supabase's `8,000 ms` `authenticated` statement timeout)*
5. Open the **Admin Console**, click **Verify all ledgers**, and confirm **`0 differences`** across the restored shop (`11,300` sales, `50` items, `20` customers).

---

## Step 10 — Verify on Android Chrome: PWA Install, Strict CSP & Offline Reopen

1. Open your **Staging Cloudflare Pages URL** in **Chrome on Android** (`https://...`).
2. Open **Chrome DevTools Remote Inspection** (or verify zero broken widgets on-screen):
   - Confirm **zero Content-Security-Policy (CSP) violation errors** while loading Google Fonts, rendering the **Cloudflare Turnstile** widget on the sign-in screen, signing in via SMS OTP + PIN, receiving **Supabase Realtime** updates, and registering `/sw.js`.
3. Tap Chrome's **⋮ menu → Add to Home screen / Install app** and confirm **Install**:
   - Confirm Android shows the **CountUp** name and crisp kiosk icon (`192×192` / `512×512` maskable icon without clipped edges).
   - Launch **CountUp** from the Android home screen and confirm it opens in full **standalone** mode (`#064e3b` emerald status bar, no browser address bar).
4. Turn **Airplane Mode ON**, force-close CountUp, and reopen CountUp from the Android home screen icon:
   - Confirm the app reopens offline, unlocks with your 4-digit PIN, records a test cash sale into the pending queue, and syncs automatically once Airplane Mode is turned **OFF**.

