# Owner React app (phone-first)

**Status:** scaffold on `feat/owner-react` · **does not ship** arrayoperator.com  
**Code:** `apps/owner-web`  
**Prod desktop:** still `public/` on `main` only

## Interview decisions (2026-07-15)

| Decision | Choice |
|---|---|
| v1 purpose | Phone-first owner ops |
| Repo layout | Folder in array-operator + feature branch |
| Auth | Same `so_session` password / magic-link |
| Agent | Home surface + sheet for small adjustments |
| Surfaces | Home fleet/offtaker pulse first; invoices, connect, analysis grow in-app |

## Guardrails

1. Never deploy this app’s `dist/` to the production Netlify site that serves `public/`.
2. Do not rewrite or delete `public/` as part of this workstream.
3. Backend remains FastAPI; React is a new client only.
4. CORS: add the future React origin when a preview domain exists.

## Run

See `apps/owner-web/README.md`.
