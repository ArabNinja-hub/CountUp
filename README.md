# Countup — Zambian Kiosk Sales & Stock Book

**Countup** is a mobile-first Point-of-Sale and shop-management web app built for
Zambian kiosks, market stalls, and small shops. It works in **Zambian Kwacha (K)**,
saves ordinary shop entries offline on a phone, and queues them for cloud sync.
Email access, backup import and account deletion require an internet connection.

> Record a sale in seconds, track credit customers, manage stock, log expenses, and
> see your daily profit — all in English, Bemba, or Nyanja.

---

## Features

- **Quick Sell** — tap items, choose Cash / Mobile Money / Credit, done in ~15s.
- **Stock Book** — add/edit products, optional cost prices, low-stock warnings, stock movements, adjustments and reversible archives.
- **Credit Book** — customer statements, balance tracking, cash/Mobile Money repayments and polite **WhatsApp** reminders in 3 languages.
- **Reports** — daily / weekly / monthly sales, known-cost profit, cash vs. Mobile Money received (including repayments), top sellers and expenses.
- **Data tools** — JSON and CSV exports, plus an additive import for ShopBook v1 backups.
- **Subscriptions** — 30-day free trial, then monthly / 3-month / 6-month plans paid by
  Mobile Money (Airtel, MTN, Zamtel) through the contact channels in the Plan screen.
- **Offline-first** — ordinary entries are saved locally and queued for sync; unresolved conflicts can stop the queue.
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
- **Grouped sync.** A queued sale and its stock and credit changes are committed in a
  Firestore transaction with an operation marker for safe retries. If another device
  has sold the same stock, a shortfall is flagged for a physical recount.
- **Offline entries are queued.** The header shows how many are waiting; keep the
  browser data until they sync. If a repayment or void conflicts with a newer server
  balance, the queue stops and shows the reason; an in-app resolution flow is not yet
  available.
- **Validation.** A sale cannot exceed the local stock on hand, credit sales require
  a customer and repayments cannot exceed the local balance.
- **Reversal.** Today's eligible sales can be undone in Reports; a partly repaid credit
  sale cannot be voided. Archived products can be restored, and deleted expenses have
  a short-lived Undo action.

---

## Tech Stack

| Layer        | Technology                                   |
|--------------|----------------------------------------------|
| UI           | React 19 + TypeScript + Tailwind CSS v4      |
| Build / Dev  | Vite 8 (`@vitejs/plugin-react`, `@tailwindcss/vite`) |
| Hosting      | GitHub Pages (static); `server.ts` serves `dist/` + the Vite dev middleware locally |
| Data         | Firebase Firestore (real-time) + localStorage offline cache |
| Payments     | Contact-based plan top-ups (WhatsApp / phone / email) |

> **Note:** the Express app used to proxy the Lipila Mobile Money API. Those routes are
> gone — the deployed app is static, and the Plan screen hands the shopkeeper contact
> options instead. See [Deployment](#deployment) for what that means for hosting.

---

## Getting Started

### Prerequisites
- **Node.js** 24.12+ recommended (some Firebase packages warn on Node 22)
- npm (this repo ships `package-lock.json`; use `npm ci` in CI)

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
npm run build      # outputs to ./dist (+ 404.html, .nojekyll)
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
ShopBook conversion, CSV escaping, mocked authentication/transactions and screen
behavior. The mock tests are not a substitute for testing a real Firebase project.

To exercise Firestore authorization locally, install Java and the Firebase CLI's
Firestore emulator, then start it with this repository's `firebase.json` and rules:

```bash
npx firebase emulators:start --project demo-countup --only firestore
# In another terminal:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-countup npm run test:rules
```

Use the actual emulator port if different. `test:rules` only accepts a local host and
`demo-*` project, and uses a named database. These tests do not deploy rules or verify
the live project.

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

### Support & payment contacts
`src/config/support.ts` is the single source of truth for the WhatsApp number, phone
number, and email addresses used by the Plan screen and the legal pages. Change them
there — never inline. Current values: **+260 96 283 8581** and
**ronisherbwalya@gmail.com** (the same mailbox is used for support, payments and legal
mail, because there is no separate department yet).

The legal pages in `src/components/LegalPages.tsx` repeat the email inside their text,
so update that file too if the address ever changes.

### Firebase
`firebase-applet-config.json` holds the web app credentials. Security rules live in
`firestore.rules`. `firebase.json` + `.firebaserc` tell the Firebase CLI which project
and which (non-default) database those rules belong to.

Enable **Anonymous** under Firebase Authentication → Sign-in method for the existing
phone-and-PIN flow. To use optional account access, also enable **Email/Password**.
While signed in on the existing phone, open Settings → Account & cloud access and link an
email and password. Linking retains the existing Firebase UID and therefore the shop
ownership and any admin grant. A linked account can sign in on another device and
request a password reset by email.

Phone/PIN-only shops remain bound to their original anonymous Firebase identity; a
PIN alone does not authorize a new device. Do not clear that identity before linking.
Email access and cloud operations require connectivity. ShopBook credentials are not
transferred: create/link CountUp access separately, then import a ShopBook backup.

### Platform owner access
Owner access is granted by data, not by an email in the source: create the Firestore
document `admins/<uid>` for the owner's account. `firestore.rules` gates every admin
read and write on that document, and the app reveals the admin console only when it
can read `admins/<own uid>`. Delete the document to revoke access.

### Security model (what the rules enforce)

`firestore.rules` is the only thing standing between one shop's records and every other
device on the internet, so it is deliberately strict:

- **Default deny.** Everything not explicitly allowed is refused.
- **One shop sees one shop.** The shop document, `items`, `sales`, `customers`,
  `credit_payments`, `expenses`, `stock_movements`, `stock_conflicts` and
  `sync_operations` are restricted to the owner Firebase UID and platform admins.
- **A shop cannot pay itself.** A shop may change *only* its PIN after creation. Plan
  status, plan expiry, the trial dates and the "deactivated" flag can only be written
  by the platform owner — the browser console can no longer be used to grant free
  premium or to lift a suspension.
- **A new shop starts on the trial.** Creating a shop with `planStatus: active` (or with
  the trial end and the plan expiry disagreeing) is refused by the rules.
- **The admin registry is restricted.** Non-admins can check only their own UID and
  cannot list or change the registry.
- **PINs are always four digits**, on create and on change.
- **The connectivity probe is read-only.** Nothing needs to write `test/connection`.

**Known limits — read these before launch:**

1. **The PIN is stored as plain text** in `shops/<shopId>.pin` and in the phone's local
   cache. The rules stop other shops from reading it, but anyone with Firebase console
   access (or the phone itself) can see it, and four digits are easy to guess if the
   database ever leaks. Moving to a salted hash is the next security step; it needs a
   migration path for shops that already have a plain-text PIN.
2. **Trial dates are client-supplied on creation.** Rules stop an owner changing plan
   fields afterward, but do not enforce a server-calculated 30-day trial at creation.
   Stronger enforcement needs a trusted backend.
3. **There is no rate limit on PIN attempts.** A 4-digit PIN has 10,000 combinations;
   add a short lockout if these shops ever hold money belonging to someone else.
4. **A forgotten shop PIN has no direct reset flow.** A previously linked email account
   can sign in and reset its email password, but the PIN-change screen still requires
   the old PIN. Do not delete a shop as a recovery shortcut: its data would be lost.
5. **Admin rights are bound to a Firebase UID.** Anonymous sessions remain on the
   device after logging out; an email link retains that same UID. Anyone with access to
   an authenticated admin device/account may reach the admin console. Protect the
   device and remove `admins/<uid>` when revoking access.
6. **No Content-Security-Policy is set.** It is worth adding one after testing sign-in
   (Firebase Auth needs `frame-src` for its auth domain); the fonts are loaded from
   Google Fonts, which is the only third-party request the app makes.

---

## ShopBook migration and data exports

1. In ShopBook, export the **full JSON backup** (`shopbook-backup-v1`) and keep the
   original file safe. ShopBook accounts, credentials, roles, settings and sync queue
   are not transferred.
2. Sign in to the target CountUp shop as its Firebase owner, connect to the internet
   and sync all pending CountUp entries.
3. Open Settings → **Data & backups** → **Choose ShopBook JSON**. Review the preview,
   then import. Products (including archives), sales and line snapshots, customers,
   repayments and stock movements are converted; balances are checked from the credit
   ledger. Prices with unknown costs remain unknown.
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
    ├── config/             # Pricing (plans.ts), support contacts & admin (support.ts)
    ├── context/            # ShopProvider (state, auth, sync)
    ├── firebase/           # Firebase init + helpers
    ├── i18n/               # EN / BEM / NYA translations
    ├── types/              # Shared TypeScript types
    └── utils/              # format.ts (money/quantity/phone), sync.ts (offline merge) + their tests
```

---

## Before you launch

Things a deploy does **not** do for you:

1. **Publish the Firestore rules.** `firestore.rules` is the only thing enforcing
   per-shop data isolation — rules must be live before real shops register. See
   [Deploying the Firestore rules](#deploying-the-firestore-rules) below.
2. **Enable sign-in providers.** Authentication → Sign-in method → *Anonymous* must
   be on; enable *Email/Password* as well for optional linked account access.
3. **Grant yourself admin.** After your first sign-in, copy your UID from
   Authentication → Users and create the document `admins/<uid>` in Firestore.
4. **Confirm the contact details** in `src/config/support.ts` (WhatsApp, phone, payment
   email). These are the channels customers are told to pay through. They are already
   set to +260 96 283 8581 and ronisherbwalya@gmail.com.
5. **Plan activation is manual.** Payment happens off-app (WhatsApp / call / email), and
   the owner activates the shop with the admin console's “+30 / +90 days” action. There
   is no automated Mobile Money callback in the static build.

### Known limitations of phone-only access

- A shop that has not linked email remains bound to its original anonymous Firebase
  session. Another device cannot open it using only the phone and PIN.
- Clearing browser data can permanently lose that anonymous identity and any unsynced
  entries. Link email and sync first; the JSON export currently has no in-app restore.
- Data isolation relies on deployed `firestore.rules`; there is no server between the
  browser and Firestore.

## License

Licensed under the Apache License 2.0. See `SPDX-License-Identifier` headers in source files.
