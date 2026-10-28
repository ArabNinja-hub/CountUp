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

### Type-check
```bash
npm run lint       # tsc --noEmit
```

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
number, payment email, and the platform-owner account used by the Plan screen, the
admin console, and `firestore.rules`. Change it there — never inline — and keep
`PLATFORM_ADMIN_EMAIL` identical to the address in `firestore.rules`.

### Firebase
`firebase-applet-config.json` holds the web app credentials. Security rules live in
`firestore.rules`. Anonymous + Google sign-in should be enabled in the Firebase
console for cloud sync.

**When you change the hosting origin**, add it to Firebase console → Authentication →
**Settings → Authorized domains** (e.g. `arabninja-hub.github.io`). Google sign-in
fails silently on any origin that is not listed there.

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

## Project Structure

```
CountUp/
├── base-path.ts              # Shared subpath (Vite base + Express mount) — see Deployment
├── server.ts                 # Express: Vite middleware in dev, serves dist/ in production
├── index.html               # App shell + fonts + meta
├── vite.config.ts           # base + spaFallback() emit of 404.html
├── public/                  # Copied verbatim into dist/ (.nojekyll, brand images)
├── .github/workflows/deploy-pages.yml  # main -> build -> verify -> gh-pages
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
    └── types/              # Shared TypeScript types
```

---

## Before you launch

Things a deploy does **not** do for you:

1. **Publish the Firestore rules.** `firestore.rules` is the only thing enforcing
   per-shop data isolation — rules must be live before real shops register:
   `firebase deploy --only firestore:rules --project <project-id>`.
2. **Authorize the origin.** Firebase console → Authentication → Settings →
   Authorized domains must list `arabninja-hub.github.io` (and any custom domain),
   otherwise Google sign-in fails silently.
3. **Enable sign-in methods.** Phone/PIN shops use Anonymous auth under the hood, so
   *Anonymous* and *Google* must both be enabled in the Firebase console.
4. **Confirm the contact details** in `src/config/support.ts` (WhatsApp, phone, payment
   email). These are the channels customers are told to pay through.
5. **Match the admin account** in `PLATFORM_ADMIN_EMAIL` and `firestore.rules`; only
   that Google account can open the admin console.
6. **Plan activation is manual.** Payment happens off-app (WhatsApp / call / email), and
   the owner activates the shop with the admin console's “+30 / +90 days” action. There
   is no automated Mobile Money callback in the static build.

### Known limitations of the client-only auth model

- A shop's 4-digit PIN is verified against the shop document, so **phone + PIN login
  works on the device that created the shop** (the local cache) and anywhere the
  Firestore rules let the signed-in user read that shop document. Cross-device PIN
  login would need a backend (Cloud Function) that verifies the PIN out-of-band; the
  Google sign-in path is the supported way to use a shop on a second device today.
- Data isolation relies entirely on `firestore.rules`; there is no server between the
  browser and Firestore.

## License

Licensed under the Apache License 2.0. See `SPDX-License-Identifier` headers in source files.
