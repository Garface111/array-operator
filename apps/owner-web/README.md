# Array Operator — Owner Web (React)

Phone-first React client for fleet + offtaker overview and **Energy Agent**.

| | |
|---|---|
| **Path** | `apps/owner-web` |
| **Branch** | `feat/owner-react` (do not merge to prod Netlify until ready) |
| **Backend** | Existing FastAPI (`/v1/*`) — same `so_session` auth as desktop |
| **Desktop site** | Untouched — still `public/` on `main` → arrayoperator.com |

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
npm run dev     # http://localhost:5174  — proxies /v1 → arrayoperator.com
```

Sign in with a real Array Operator account (prod API via proxy).

```bash
npm run build   # outputs dist/ — never auto-deployed to arrayoperator.com
npm run typecheck
```

## Deploy policy (important)

- **Do not** point the production Netlify site (`966cb1f5-…` / `public/`) at this app.
- When ready: create a **separate** Netlify site or path (e.g. `m.arrayoperator.com`
  or `arrayoperator.com/app`) and add that origin to Railway `CORS_ALLOWED_ORIGINS`.
- Keep `main` + `public/` shipping the desktop vanilla site until cutover is explicit.

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

## Next slices (scalable backlog)

1. Live status probes for Connect (cloud vault / utility / pay)
2. Offtaker list + draft preview (read-only then edit)
3. Agent tool-result UI (confirm writes)
4. Analysis summary cards
5. PWA install + offline shell

## Safety

- Branch work only under `apps/owner-web`
- Never `netlify deploy --dir public` from this branch for “React testing”
- Stash `public/` mobile experiments stay off this product path
