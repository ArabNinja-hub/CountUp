# Countup — Zambian Kiosk Sales & Stock Book

**Countup** is a mobile-first Point-of-Sale and shop-management web app built for
Zambian kiosks, market stalls, and small shops. It works in **Zambian Kwacha (K)**,
saves ordinary shop entries offline on a phone, and queues them for cloud sync.
Shop sign-in uses a phone number and PIN; there is no general shop email sign-in. Email
linking is retained only for reauthenticating the original shop identity. Email linking,
backup import and account deletion require an internet connection.

> Record a sale in seconds, track credit customers, manage stock, log expenses, and
> see your daily profit — all in English, Bemba, or Nyanja.

---

## Instruction manual

Open **Help** on the sign-in page or the **?** button in your shop for the built-in,
offline guide. The complete step-by-step manual is in [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Features

- **Quick Sell** — tap items, choose Cash / Mobile Money / Credit, done in ~15s.
- **Stock Book** — add/edit products, optional cost prices, low-stock warnings, stock movements, adjustments and reversible archives.
- **Credit Book** — customer statements, balance tracking, cash/Mobile Money repayments and polite **WhatsApp** reminders in 3 languages.
- **Reports** — daily / weekly / monthly sales, known-cost profit, cash vs. Mobile Money received (including repayments), top sellers and expenses.
- **Data tools** — JSON and CSV exports, plus an additive import for legacy v1 backups.
- **Subscriptions** — a 30-day free trial, then monthly / 3-month / 6-month plans paid manually through MTN or Airtel Mobile Money. Payment references are reviewed by an authorized administrator; a submission never activates access by itself.
- **Offline-first** — after the built app has loaded online once, it can reopen in the same browser offline. Ordinary entries are saved locally and queued for sync; unresolved conflicts can stop the queue.
- **Localized** — existing navigation and reminders support English, Ichibemba, and Chinyanja; some newer screens are currently English-only.
- **Platform admin** — the owner account can see every shop, extend plans, and suspend
  a shop. A suspended shop keeps its records (viewable and exportable) but cannot record
  new sales.

Every new shop starts with an **empty** stock book: the owner enters their own items.
There is no sample data, demo shop, or pre-filled inventory anywhere in the app.

### What happens the moment you tap something

- **Real-time everywhere.** Sales, stock, credit balances, expenses, the plan expiry
  and the admin shop list are all backed by live Firestore listeners. A sale shows up
  in Today's totals, Reports and the credit book immediately, with no reload.
- **Grouped sync.** Normal queued entries and their operation markers commit together,
  so retries do not repeat them. A sale undo already completed on another device is
  not applied twice. Stock shortfalls and stale physical counts are flagged for a
  recount rather than overwriting newer stock.
- **Offline entries are queued.** The header shows how many are waiting; keep the
  browser data until they sync. Temporary connection failures are retried. If a
  repayment or sale undo conflicts with a newer balance, the queue pauses and **Review**
  compares the saved entry with the server. Only after the owner confirms a verified
  mistake can a payment be corrected or cancelled, or an undo cancelled. The original
  and decision are kept under Settings → Data & backups → Sync review history; later
  entries remain queued and resume in order. Genuine overpayments and refunds are not
  supported: leave the affected entry waiting and reconcile outside the app or seek
  support. A pending non-transactional edit made by an older release may lack an
  operation marker; if its acknowledgement was lost before this update, a retry can
  still overwrite a newer edit. Check the affected records after upgrading.
- **One active tab per browser.** On browsers supporting Web Locks, another CountUp
  tab waits until the first closes, so their local queues cannot overwrite each other.
  Older browsers display a warning: use only one CountUp tab on that device.
- **Validation.** A sale cannot exceed the local stock on hand, credit sales require
  a customer and repayments cannot exceed the local balance.
- **Reversal.** Today's eligible sales can be undone in Reports; a partly repaid credit
  sale cannot be voided. Archived products can be restored, and deleted expenses have
  a short-lived Undo action.

### Before going offline

Open the production app online in the browser you will use, and allow it to finish
loading so its static app shell can be cached. It can then reopen in that browser
without a connection, provided the browser has not cleared or evicted those files.
The development server does not install the offline worker. The worker caches only
application files, not Firebase responses or shop records; it is not a data backup.
Shop entries and their pending queue remain in browser storage until they sync. Do not
clear that storage while entries are pending. Logging out clears the local shop cache;
a phone-and-PIN login needs a connection afterwards.

If a previously linked shop loses its cloud session while entries are waiting, use
**Settings → Account & cloud access** to reconnect the original email identity without
discarding the queue. This recovery flow requires the original shop data to still be
present in the browser; it is not general email shop sign-in or a new-device restore. A
different account cannot sync the queue. A phone-and-PIN-only shop still needs its
original anonymous Firebase session; an unlinked identity cannot be recovered by
creating a new anonymous account.

---

## Tech Stack

| Layer        | Technology                                   |
|--------------|----------------------------------------------|
| UI           | React 19 + TypeScript + Tailwind CSS v4      |
| Build / Dev  | Vite 8 (`@vitejs/plugin-react`, `@tailwindcss/vite`) |
| Hosting      | GitHub Pages (static); `server.ts` serves `dist/` + the Vite dev middleware locally |
| Data         | Firebase Firestore (real-time) + localStorage offline cache |
| Payments     | Manual MTN/Airtel submissions + Firebase Functions review |

> **Note:** Customer sales are still entered as business records only. Subscription
> payments use a separate manual transfer and administrator review flow. No Mobile Money
> gateway, provider API or automatic verification is connected.

---

## Getting Started

### Prerequisites
- **Node.js** 24.12+ recommended (some Firebase packages warn on Node 22)
- npm (the root app uses the committed `package-lock.json`; the separate `functions/` package has its own `functions/package-lock.json`)

### Install
```bash
npm install
```

### Run (development)
```bash
npm run dev
# http://localhost:3000/CountUp/  (set PORT to override; the /CountUp/ prefix comes
# from VITE_BASE_PATH so dev matches the Pages deployment — see base-path.ts)
```

### Build & Preview (production)
```bash
npm run build      # outputs to ./dist (+ 404.html, .nojekyll, sw.js)
npm run start      # serves dist/ via Express at the same base path
npm run preview    # Vite preview server
npm run deploy     # publish dist/ to the gh-pages branch (see Deployment)
```

### Checks
```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (React + TypeScript rules)
npm run format      # Prettier — rewrite files in place
npm run format:check # Prettier — report only (used by CI)
npm test            # Vitest, one run
npm run test:watch  # Vitest in watch mode while you work
npm run check       # typecheck + lint + tests in one go
```

Tests cover plans, money and ledger calculations, queue reconciliation and recovery,
static offline-shell caching, single-tab coordination, legacy backup conversion, CSV
escaping, payment validation/review/date arithmetic, entitlement expiry, mocked
authentication/transactions and screen behavior. The Firestore emulator suite exercises
shop/payment-record isolation and custom-claim authorization; none of these tests uses
live Firebase accounts or submits real payments.

To exercise Firestore authorization locally, install Java and the Firebase CLI's
Firestore emulator, then start it with this repository's `firebase.json` and rules:

```bash
npx firebase emulators:start --project demo-countup --only firestore
# In another terminal:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-countup npm run test:rules
```

Use the actual emulator port if different. `test:rules` only accepts a local host and
`demo-*` project, and uses a named database. These tests do not deploy rules or verify
the live project. `npm run functions:build` typechecks the callable backend against its
separate `functions/` package.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values you need:

| Variable                | Purpose                                                        |
|-------------------------|----------------------------------------------------------------|
| `PORT`                  | Port for `npm run dev` / `npm run start` (default 3000)        |
| `VITE_BASE_PATH`        | Subpath the app is built for and served from; default `/CountUp/` |

The app needs no API keys. `VITE_BASE_PATH` is the one value that matters for
deployment — it is read by both `vite.config.ts` and `server.ts` through
`base-path.ts`, so the built asset URLs and the server's mount point can never drift
apart. Set it to `/` when hosting a custom domain from the site root.

### Manual payment configuration
The MTN and Airtel payment numbers are kept in Firebase Functions secrets and returned
only to a signed-in shop owner by `getManualPaymentInstructions`. They are not embedded
in the web bundle. Configure `COUNTUP_MTN_PAYMENT_NUMBER` and
`COUNTUP_AIRTEL_PAYMENT_NUMBER` with the platform-approved values. The Plan screen
supports only MTN and Airtel; it does not connect to a payment gateway.

### Firebase
`firebase-applet-config.json` holds the web app configuration. Security rules live in
`firestore.rules`; privileged review and subscription changes run in the Firebase
Functions code under `functions/`. `firebase.json` + `.firebaserc` tell the Firebase
CLI which project and which (non-default) database those rules belong to.

Enable **Anonymous** under Firebase Authentication → Sign-in method for the existing
phone-and-PIN flow. For optional account recovery, also enable **Email/Password**. While
signed in on the original device, open Settings → Account & cloud access and link an email
and password. Linking retains the existing Firebase UID and therefore the shop ownership
and any server-issued custom claim bound to that UID. Email linking only supports reauthentication of the original shop
identity on a device that still has its shop data; it is not general shop email sign-in or
a new-device restore. Password reset is available for the linked email.

Phone/PIN shops remain bound to their original Firebase identity; a PIN alone does not
authorize a new device. Do not clear the original browser data or identity while entries
are pending. Email reauthentication and cloud operations require connectivity. Credentials
from earlier accounts are not transferred automatically; import any supported legacy
backup separately.

### Platform owner access

Admin access is based on a server-issued Firebase custom claim. No client email check,
Firestore admin document or self-service role setting grants access. The configured
platform identity is held in the `COUNTUP_ADMIN_EMAIL` Firebase Functions secret, not
in the web client or this repository.

1. Enable **Email/Password** sign-in in Firebase Authentication. An authorized platform
   account must already exist and have a verified email; this app does not create admin
   credentials or set a hardcoded password.
2. Set `COUNTUP_ADMIN_EMAIL` through Firebase Functions secrets to the privately
   configured owner identity. Do not put the value in source code or Vite environment
   variables.
3. Build Functions dependencies with `npm --prefix functions install`, then set the
   payment secrets `COUNTUP_MTN_PAYMENT_NUMBER` and
   `COUNTUP_AIRTEL_PAYMENT_NUMBER` using `firebase functions:secrets:set`.
4. Deploy both the rules and backend: `firebase deploy --only firestore:rules,functions`.
5. On first authorized sign-in, `verifyPlatformAdmin` checks the verified identity
   against the secret and provisions a `platformAdmin` custom claim. The client refreshes
   its token. Every admin callable and Firestore admin read independently checks that
   claim. Revoke access by removing the claim through Firebase Admin tooling and ending
   existing sessions; an already issued ID token may remain valid until it expires.

Admin operations require connectivity. No production credentials, live accounts, payment
records or secrets are created by this repository change. Configure Firebase providers,
secrets, account verification and deployment separately before enabling real payments.

### Security model (what the rules enforce)

`firestore.rules` is the only thing standing between one shop's records and every other
device on the internet, so it is deliberately strict:

- **Default deny.** Everything not explicitly allowed is refused.
- **One shop sees one shop.** The shop document, `items`, `sales`, `customers`,
  `credit_payments`, `expenses`, `stock_movements`, `stock_conflicts` and
  `sync_operations` are restricted to the owner Firebase UID and platform admins.
- **A shop cannot grant itself premium access.** Client writes to shop entitlement fields
  are denied. Admin SDK callables verify the server-issued platform-admin claim before
  reviewing payments, extending subscriptions or changing suspension status.
- **A new shop starts on the trial.** Creating a shop with `planStatus: active` (or with
  the trial end and the plan expiry disagreeing) is refused by the rules.
- **Admin roles are not a Firestore document.** The retired `admins` collection is
  denied to all clients; privileged shop/payment/audit reads require the server-issued
  custom claim.
- **PINs are always four digits**, on create and on change.
- **The connectivity probe is read-only.** Nothing needs to write `test/connection`.

**Known limits — read these before launch:**

1. **The PIN is stored as plain text** in `shops/<shopId>.pin` and in the phone's local
   cache. The rules stop other shops from reading it, but anyone with Firebase console
   access (or the phone itself) can see it, and four digits are easy to guess if the
   database ever leaks. Moving to a salted hash needs a migration path for existing shops.
2. **Offline shop creation has a client timestamp.** Firestore rules cap a new trial at
   30 days from the server's create request, so a forged long trial is denied. If the
   shop is created offline and synced later, its originally computed trial may be shorter
   by the time it reaches Firestore.
3. **There is no rate limit on PIN attempts.** A 4-digit PIN has 10,000 combinations;
   add a short lockout if these shops ever hold money belonging to someone else.
4. **A forgotten shop PIN has no direct reset flow.** A linked email can reauthenticate
   the original shop identity on a browser that still has its shop data and reset its
   email password, but the PIN-change screen still requires the old PIN. Do not delete a
   shop as a recovery shortcut: its data would be lost.
5. **Admin rights are bound to a Firebase UID and custom claim.** Protect the
   authorized account and device. Revocation requires removing the custom claim with
   Firebase Admin tooling and ending active sessions; an already issued token may
   remain valid until expiry.
6. **No Content-Security-Policy is set.** It is worth adding one after testing sign-in
   (Firebase Auth needs `frame-src` for its auth domain); the fonts are loaded from
   Google Fonts, which is the only third-party request the app makes.

---

## Legacy backups and data exports

1. Keep a copy of your **full legacy v1 JSON backup** (format `shopbook-backup-v1`).
   Accounts, credentials, roles, settings and the old sync queue are not transferred.
2. Sign in to your shop as its Firebase owner, connect to the internet and sync all
   pending entries.
3. Open Settings → **Data & backups** → **Choose legacy JSON backup**. Review the
   preview, then import. Products (including archives), sales and line snapshots,
   customers, repayments and stock movements are converted; balances are checked from
   the credit ledger. Prices with unknown costs remain unknown.
4. Imports are additive and atomic, and duplicate IDs are refused without overwriting
   existing records. The file must be at most 5 MB and produce at most 400 CountUp
   documents. Invalid references or inconsistent totals are rejected. Larger files
   require a separate migration strategy; do not split them without checking links.

Settings also exports CountUp JSON and CSV files. The JSON export omits the PIN, but
contains sensitive business/customer data; store it securely. **There is not yet an
in-app restore for CountUp JSON**, and the export does not include the pending sync
queue. It is not a substitute for keeping the original browser data until it syncs.
CountUp currently has no separate owner/cashier role system.

---

## Deployment

The live site is https://arabninja-hub.github.io/CountUp/, served by GitHub Pages
**from the `gh-pages` branch** (Settings → Pages → "Deploy from a branch").

`gh-pages` holds **only build output**. Never hand-edit it: it is overwritten on every
deploy, and editing it is how the deployed site drifts into a state the repository
cannot rebuild.

### Automatic (recommended)
Pushing to `main` runs `.github/workflows/deploy-pages.yml`, which type-checks, builds,
asserts the artifact is publishable, and force-updates `gh-pages`. Pages then serves it
within about a minute.

### Manual
```bash
npm run build && npm run deploy   # gh-pages -d dist
```

### What keeps a Pages deploy working
1. **Base path.** Pages serves this repo under `/CountUp/`, so `base` in `vite.config.ts`
   must be `/CountUp/`. A build with `base: '/'` publishes HTML requesting
   `/assets/...`, which Pages 404s — the page loads and renders a blank screen.
2. **Images referenced from JS** must be imported (`import icon from '/brand/icon.png'`)
   rather than written as string literals. Vite only rewrites URLs it can resolve, so a
   literal `src="/brand/icon.png"` 404s under the subpath.
3. **`public/.nojekyll`** ships in `dist/` so Pages does not post-process the build with
   Jekyll (that step added ~80s per deploy and can drop files).
4. **`404.html`** is emitted as a copy of the shell so a deep link that Pages cannot
   rewrite still boots the app.

If you switch Pages to the **GitHub Actions** deployment source instead of a branch,
replace the publish step in the workflow with `actions/upload-pages-artifact` +
`actions/deploy-pages` and delete the `gh-pages` branch.

---

## Deploying the Firestore rules

Rules are **not** part of the Pages build. Pages only publishes files; the security
rules live in Firebase and only change when you (or CI) deploy them. There are three
ways, easiest first.

### 1. Automatic from GitHub (set up once)

`.github/workflows/firestore-rules.yml` deploys `firestore.rules` whenever that file
changes on `main`. It needs one repository secret:

1. On a computer with the repo checked out, run `npx firebase login:ci` and sign in with
   the Google account that owns the Firebase project.
2. Copy the token it prints (a long string starting with `1//`).
3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
   Name it exactly `FIREBASE_TOKEN`, paste the token, save.
4. Re-run the **Deploy Firestore rules** workflow (Actions → the workflow → *Run
   workflow*).

Until the secret exists the workflow does not fail — it prints a warning saying the
rules were not deployed.

### 2. By hand with the CLI

```bash
npx firebase login                     # once per computer
npm run deploy:rules                    # npx firebase deploy --only firestore:rules
```

This uses `firebase.json` (rules file + which database) and `.firebaserc` (project id),
so there is nothing to type by hand.

### 3. By hand in the browser (no tooling at all)

1. Open [console.firebase.google.com](https://console.firebase.google.com) and pick the
   project.
2. **Firestore Database → Rules**.
3. Select the database named `ai-studio-6763e195-ebd5-4984-ba25-2f9dabfe7719` (the app
   uses this named database, not `(default)`).
4. Open `firestore.rules` from the repository, copy **all** of it, paste it over the
   editor contents, and press **Publish**.

If you paste only part of the file, or publish to `(default)`, the app keeps working
from its local cache but every cloud read and write is denied.

---

## Project Structure

```
CountUp/
├── base-path.ts              # Shared subpath (Vite base + Express mount) — see Deployment
├── server.ts                 # Express: Vite middleware in dev, serves dist/ in production
├── index.html               # App shell + fonts + meta
├── vite.config.ts           # base + spaFallback() emit of 404.html
├── public/                  # Copied verbatim into dist/ (.nojekyll, brand images)
├── .github/workflows/deploy-pages.yml  # main -> typecheck/lint/test -> build -> gh-pages
├── .github/workflows/firestore-rules.yml # firestore.rules -> live rules (needs FIREBASE_TOKEN)
├── eslint.config.js          # ESLint 9 flat config (React + TypeScript)
├── .prettierrc               # Prettier formatting rules
├── vitest.config.ts          # Test runner config (src/**/*.test.ts)
├── firebase.json             # Firebase CLI: which rules file, which database
├── .firebaserc               # Firebase CLI: which project
├── firebase-applet-config.json
├── firestore.rules
└── src/
    ├── App.tsx              # Root + routing between auth / admin / plan / main app
    ├── main.tsx
    ├── index.css           # Tailwind + custom animations
    ├── components/         # Screen + shared UI components (LegalPages included)
    ├── config/             # Shared subscription terms and app configuration
    ├── context/            # ShopProvider (state, auth, sync)
    ├── firebase/           # Firebase init + helpers
    ├── i18n/               # EN / BEM / NYA translations
    ├── types/              # Shared TypeScript types
    └── utils/              # format.ts (money/quantity/phone), sync.ts (offline merge) + their tests
```

---

## Before you launch

Things a deploy does **not** do for you:

1. **Publish Firestore rules and Functions.** Deploy `firestore.rules` and the callable
   backend before enabling payment submissions or privileged administration.
2. **Enable sign-in providers.** Authentication → Sign-in method → *Anonymous* must be
   on for shops; enable *Email/Password* for the separately verified platform account.
3. **Provision the platform identity.** Set the private `COUNTUP_ADMIN_EMAIL` Firebase
   secret, verify the matching Firebase Authentication email, then sign in once to let
   the server issue the admin custom claim. Never create an `admins/<uid>` document.
4. **Configure payment secrets.** Set `COUNTUP_MTN_PAYMENT_NUMBER` and
   `COUNTUP_AIRTEL_PAYMENT_NUMBER` to the approved receiving numbers through Firebase
   Functions secrets. Do not put them in client or Vite configuration.
5. **Keep pilot payments manual.** Owners make a Mobile Money transfer and submit its
   reference; an administrator must verify the operator transaction and approve it.
   There is no automatic Mobile Money gateway or callback.

### Known limitations of phone-only access

- A shop is bound to its original Firebase identity. Phone and PIN alone do not open it
  on another device, and CountUp currently has no general email shop sign-in or
  new-device restore flow.
- Clearing browser data can permanently lose the original anonymous identity and any
  unsynced entries. Email linking only supports reauthentication of the original shop
  session on a browser that still has the shop data. The JSON export has no in-app restore.
- Data isolation relies on deployed `firestore.rules`; there is no server between the
  browser and Firestore.

## License

Licensed under the Apache License 2.0. See `SPDX-License-Identifier` headers in source files.
