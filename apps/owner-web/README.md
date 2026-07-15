# Array Operator — Owner Web (React)

Phone-first React client for fleet + offtaker overview and **Energy Agent**.

| | |
|---|---|
| **Path** | `apps/owner-web` |
| **Live URL** | **https://arrayoperator.com/m/** (mobile beta) |
| **Publish** | `bash apps/owner-web/scripts/publish-to-public.sh` → `public/m/` then deploy `public/` |
| **Backend** | Existing FastAPI (`/v1/*`) — same `so_session` auth as desktop |
| **Desktop site** | `public/` root — phones auto-redirect to `/m/` via `mobile-beta-gate.js` |

## Why this app exists

The vanilla `public/` site is the stable desktop product. Mobile UX needs a
clean component model (nav, sheets, data hooks) without risking production.
This app is the durable path: scalable React surface, same API.

## Product v1 (from interview)

1. **Phone-first owner ops**
2. **Home** = fleet pulse + offtaker pulse + Agent entry
3. **Energy Agent** = home surface + bottom sheet for small adjustments
4. Auth = existing magic-link / password (`so_session`)
5. Later tabs: full invoices workspace, analysis/trends (scaffolded)

## Develop

```bash
cd apps/owner-web
npm install
npm run dev     # http://localhost:5174/m/  — proxies /v1 → arrayoperator.com
```

Sign in with a real Array Operator account (prod API via proxy).

```bash
npm run build                              # base /m/
VITE_BASE=/ npm run build                  # root base (preview Netlify only)
bash apps/owner-web/scripts/publish-to-public.sh   # → public/m/
```

## Live mobile beta (arrayoperator.com)

1. `bash apps/owner-web/scripts/publish-to-public.sh`
2. Deploy `public/` to Netlify site `966cb1f5-…` (arrayoperator.com)
3. Phones (≤960px) hitting `/` or `/login` → `/m/` via `public/mobile-beta-gate.js`
4. Escape hatch: `?desktop=1` sticks desktop (`localStorage ao_force_desktop`)
5. Force mobile again: `?mobile=1`

Desktop canvas remains at site root. Same `so_session` and `/v1/*` proxy.

## Architecture

```
apps/owner-web/
  src/
    auth/          AuthGate (so_session)
    components/    Shell, BottomNav, AgentSheet, StatCard
    hooks/
    lib/           api.ts, session.ts, types, format
    screens/       Home, Fleet, Invoices, Connect, More, Login
    styles/        Tailwind + mobile-safe base
```

API client mirrors NEPOOL SPA conventions (`Authorization: Bearer`, 401 → login).

## Live now (backend-wired)

- Auth: password, magic-link (`/v1/auth/verify` on `?token=`), demo mode
- Home / Fleet: overview + fleet-tree (+ force refresh)
- Connect: SolarEdge, cloud harvest, portal-vendor path (Fronius/SMA/Chint), Stripe Connect
- Invoices: create/edit offtakers, PDF preview, send-pipeline
- Analysis: fleet-trends + forecast-fleet NOC + peer rollup
- Account: profile, billing, capture mode, extension key
- Energy Agent: chat + **confirm pending writes** UI

## Next slices

1. Bulk offtaker import on mobile
2. Invoice send-now from phone
3. Per-array forecast editor (tilt/azimuth/PR)
4. PWA install + offline shell

## Safety

- Branch work only under `apps/owner-web`
- Never `netlify deploy --dir public` from this branch for “React testing”
- Stash `public/` mobile experiments stay off this product path
