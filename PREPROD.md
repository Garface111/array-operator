# Array Operator — Preprod (staging) environment & pipeline

A real dev → **preprod** → prod pipeline. Test changes on a private, network-gated
copy of the whole product before they reach `arrayoperator.com`, and (later) let
beta users in.

## The three environments

| | Frontend (Netlify) | Backend (Railway) | Database |
|---|---|---|---|
| **prod** | `array-operator-ea` → arrayoperator.com | `web` (prod env) | shared prod Postgres |
| **preprod** | `ao-owner-web-preview` → [ao-owner-web-preview.netlify.app](https://ao-owner-web-preview.netlify.app) **(gated)** | `web-staging` (staging env) → web-staging-staging-3671.up.railway.app | **its own empty** Postgres (`Postgres-YSP8`) |

Preprod is a **fully isolated stack** — its own backend and its own database, so
beta users and test runs never touch real customer data, real email, real Stripe,
or the autonomous Sovereign.

## Branch model

- `main` = production (frontend prod deploy + backend `web` auto-deploys on push).
- `staging` = preprod. Deploy a change here first, verify on the gated site, then promote.

```
feature work ──▶ push to `staging` ──▶ deploy-preprod (FE) + deploy-staging-backend (BE)
                                   ──▶ verify on the gated preview ──▶ promote-to-prod
```

Keep `staging` current if other lanes advance `main`:
`git checkout staging && git merge origin/main && git push origin staging`.

## Deploy to preprod

```bash
# Frontend (this repo):  gated Netlify preview, wired to the staging backend
scripts/deploy-preprod.sh

# Backend (solar-operator repo):  Railway web-staging from the staging branch
cd ~/solar-operator && scripts/deploy-staging-backend.sh
```

`deploy-preprod.sh` stages the committed `staging` tree, rewrites `public/_redirects`
so `/v1/*` and `/accounts` proxy to the **staging** backend, and deploys from the repo
root so Netlify bundles the access gate (`netlify.toml` + `netlify/edge_functions/gate.ts`).

## The access gate (network gate + beta program)

Every request to the preview site runs `netlify/edge_functions/gate.ts`:

1. **IP allowlist** (`PREPROD_ALLOW_IPS`) — Ford's computer/network passes silently.
2. **Beta Basic-Auth** (`PREPROD_BETA_USER` / `PREPROD_BETA_PASS`) — the beta program
   password; the durable way in when the residential IP rotates.
3. Otherwise → a branded 401 "Private Preview" page with a *request beta access* link.

The gate is **structurally preprod-only**: prod deploys only `git archive HEAD public`
via the REST helper, so the root-level `netlify.toml`/edge function are never part of
the prod artifact. Gate config lives as Netlify **site env vars on the preview site**:

```bash
export NETLIFY_AUTH_TOKEN=$(cat ~/.hermes/secrets/netlify_token)
SITE=f6c82d88-8d69-4f88-abac-df195a34fe77
netlify env:set PREPROD_ALLOW_IPS "73.63.234.141" --site $SITE   # add IPs comma-separated
netlify env:set PREPROD_BETA_USER "beta"          --site $SITE
netlify env:set PREPROD_BETA_PASS "<the-beta-password>"          --site $SITE
```

Onboarding a beta user = share the `beta` username + password. Revoke = rotate the password.

## Promote to production

```bash
scripts/promote-to-prod.sh --yes
```

Fast-forwards `main` to `staging` (prod backend auto-deploys), then runs the prod
frontend deploy (`deploy-and-verify.sh`). Refuses if `main` has diverged — sync
`staging` first.

## Staging backend safety (why it can't touch the real world)

The backend infers "prod" from Railway env vars that staging also has, so inertness
is enforced explicitly (audited): no worker/harvester services (→ no scheduler,
Sovereign, or capture), `RUN_SCHEDULER=0`, `SOVEREIGN_ENABLED=0`, `RESEND_API_KEY`
and `STRIPE_SECRET_KEY` unset, plus an `EMAIL_SINK_TO` valve in `notify.py` that
redirects any stray outbound mail to the operator. To exercise email/AI in staging,
set the corresponding key on `web-staging` only (email will still be sinked).
