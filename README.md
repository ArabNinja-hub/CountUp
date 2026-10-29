# Countup — Zambian Kiosk Sales & Stock Book

**Countup** is a mobile-first Point-of-Sale and shop-management web app built for
Zambian kiosks, market stalls, and small shops. It works in **Zambian Kwacha (K)**,
runs fully **offline** on a phone, and syncs to the cloud when a connection returns.

> Record a sale in seconds, track credit customers, manage stock, log expenses, and
> see your daily profit — all in English, Bemba, or Nyanja.

---

## Features

- **Quick Sell** — tap items, choose Cash / Mobile Money / Credit, done in ~15s.
- **Stock Book** — add/edit items with buying & selling prices, low-stock warnings, one-tap restock.
- **Credit Book** — customer ledger, balance tracking, and polite **WhatsApp** reminders in 3 languages.
- **Reports** — daily / weekly / monthly sales, net profit, cash vs. MoMo, top sellers, expenses. CSV export + shareable summary.
- **Subscriptions** — 30-day free trial, then monthly / 3-month / 6-month plans paid by
  Mobile Money (Airtel, MTN, Zamtel) through the contact channels in the Plan screen.
- **Offline-first** — every action is saved locally and queued for background sync.
- **Localized** — full UI in English, Ichibemba, and Chinyanja.
- **Platform admin** — the owner account can see every shop, extend plans, and suspend
  a shop. A suspended shop keeps its records (viewable and exportable) but cannot record
  new sales.

Every new shop starts with an **empty** stock book: the owner enters their own items.
There is no sample data, demo shop, or pre-filled inventory anywhere in the app.

### What happens the moment you tap something

- **Real-time everywhere.** Sales, stock, credit balances, expenses, the plan expiry
  and the admin shop list are all backed by live Firestore listeners. A sale shows up
  in Today's totals, Reports and the credit book immediately, with no reload.
- **One write, one truth.** A sale is committed as a single atomic batch with its
  stock changes and credit balance, so a dropped connection can never leave a sale
  recorded against stock that never went down.
- **Offline is normal, not an error.** Every action is saved locally and queued; the
  header shows how many entries are waiting, and the queued entries stay on screen
  while they sync.
- **Nothing can be entered by accident.** Quantities cannot exceed the stock on hand,
  a credit sale cannot be saved without naming the customer, a credit payment cannot
  exceed the balance, prices accept digits only, and "no search results" is never
  confused with "no items".
- **Everything is reversible.** Undo a sale recorded today from Reports (stock and
  credit are restored), undo a deleted item or expense from the toast that follows,
  and confirm before anything destructive happens. No `alert()` or `confirm()` boxes.

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
- **Node.js** 22+ (the Firebase SDK targets Node 24; warnings on 22 are non-blocking)
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

The test suite covers the parts where a silent mistake costs money or data:
`getSubscriptionInfo()` in `src/config/plans.ts` (trial / active / grace / expired and
the boundary days), the input sanitizers in `src/utils/format.ts` (money, quantity,
phone number), and `reconcile()` in `src/utils/sync.ts` (which local, not-yet-synced
records are kept on screen next to the server's copy).

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

**Sign-in is a phone number + 4-digit PIN — nothing else.** There is no Google button,
no email login, and no password. Each device holds a Firebase *anonymous* session
(a random uid with no personal details) so Firestore can scope records to it, which
means the only sign-in method that must be enabled in the Firebase console is
**Anonymous**.

### Platform owner access
Owner access is granted by data, not by an email in the source: create the Firestore
document `admins/<uid>` for the owner's account. `firestore.rules` gates every admin
read and write on that document, and the app reveals the admin console only when it
can read `admins/<own uid>`. Delete the document to revoke access.

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
2. **Enable Anonymous sign-in.** Authentication → Sign-in method → *Anonymous* must be
   on; it is the only method the app uses. (Leave Google, email and phone-provider
   sign-in switched off — nothing in the app calls them.)
3. **Grant yourself admin.** After your first sign-in, copy your UID from
   Authentication → Users and create the document `admins/<uid>` in Firestore.
4. **Confirm the contact details** in `src/config/support.ts` (WhatsApp, phone, payment
   email). These are the channels customers are told to pay through. They are already
   set to +260 96 283 8581 and ronisherbwalya@gmail.com.
5. **Plan activation is manual.** Payment happens off-app (WhatsApp / call / email), and
   the owner activates the shop with the admin console's “+30 / +90 days” action. There
   is no automated Mobile Money callback in the static build.

### Known limitations of the phone-only auth model

- **A shop is bound to the device that created it.** The PIN is verified against the
  shop document, which only that device's anonymous session is allowed to read. On a
  different phone the app cannot see the shop document, so it cannot verify the PIN.
  Opening one shop on several devices/phones therefore needs a backend (a Cloud
  Function that verifies the PIN and mints a session) — it cannot be done safely from
  the browser alone, because letting any anonymous session read a shop document would
  expose every shop's records to anyone who guesses a phone number.
- **Clearing browser data signs the shop out for good** (the anonymous session and the
  local cache both go). Export a JSON backup from Settings → Export My Data.
- Data isolation relies entirely on `firestore.rules`; there is no server between the
  browser and Firestore.

## License

Licensed under the Apache License 2.0. See `SPDX-License-Identifier` headers in source files.
