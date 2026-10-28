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
- **Subscriptions** — 30-day free trial with Mobile Money (Lipila) top-ups via Airtel, MTN, and Zamtel.
- **Offline-first** — every action is saved locally and queued for background sync.
- **Localized** — full UI in English, Ichibemba, and Chinyanja.

---

## Tech Stack

| Layer        | Technology                                   |
|--------------|----------------------------------------------|
| UI           | React 19 + TypeScript + Tailwind CSS v4      |
| Build / Dev  | Vite 8 (`@vitejs/plugin-react`, `@tailwindcss/vite`) |
| Backend      | Express server (`server.ts`) proxying Vite + Lipila payment APIs |
| Data         | Firebase Firestore (real-time) + localStorage offline cache |
| Payments     | Lipila Zambia Mobile Money API (sandbox + live) |

---

## Getting Started

### Prerequisites
- **Node.js** 22+ (the Firebase SDK targets Node 24; warnings on 22 are non-blocking)
- A package manager (`npm`, `pnpm`, or `bun`)

### Install
```bash
npm install
```

### Run (development)
```bash
npm run dev
# Server starts on http://localhost:3000 (set PORT to override)
```

### Build & Preview (production)
```bash
npm run build      # outputs to ./dist
npm run start      # serves the built app via Express
npm run preview    # Vite preview server
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
| `APP_URL`               | Public URL of the app (used for payment webhook callbacks)      |
| `LIPILA_ENVIRONMENT`    | `sandbox` (testing) or `production` (live)                      |
| `LIPILA_API_KEY`        | Lipila API key (`lsk_` in sandbox, `lpk_` in production)        |
| `LIPILA_WALLET_ID`      | Merchant Wallet / Till ID                                       |
| `LIPILA_WEBHOOK_SECRET` | Optional webhook verification secret                            |
| `PLATFORM_OWNER_EMAIL`  | Email treated as the platform owner (admin access)              |
| `GEMINI_API_KEY`        | Required only if you enable Gemini-powered features             |

If the Lipila keys are absent, the app still runs — the Plan screen shows a
"configuration required" guide instead of dispatching real payments.

### Firebase
`firebase-applet-config.json` holds the web app credentials. Security rules live in
`firestore.rules`. Anonymous + Google sign-in should be enabled in the Firebase
console for cloud sync.

---

## Project Structure

```
CountUp/
├── server.ts                 # Express server: Vite middleware (dev) + Lipila API routes
├── index.html               # App shell + fonts + meta
├── vite.config.ts
├── firebase-applet-config.json
├── firestore.rules
└── src/
    ├── App.tsx              # Root + routing between auth / admin / plan / main app
    ├── main.tsx
    ├── index.css           # Tailwind + custom animations
    ├── components/         # Screen + shared UI components
    ├── config/             # Pricing & payment gateway config
    ├── context/            # ShopProvider (state, auth, sync)
    ├── firebase/           # Firebase init + helpers
    ├── i18n/               # EN / BEM / NYA translations
    └── types/              # Shared TypeScript types
```

---

## License

Licensed under the Apache License 2.0. See `SPDX-License-Identifier` headers in source files.
