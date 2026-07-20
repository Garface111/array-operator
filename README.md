# Array Operator

Array Operator dashboard and controls.

## Deploy (read this)

| Env | Command |
|-----|---------|
| **Production** (arrayoperator.com) | `scripts/deploy-and-verify.sh` only |
| **Preprod** (gated preview) | `scripts/deploy-preprod.sh` only |

**Never** run `netlify deploy --prod` from the repo root against production — that
shipped the preprod “Private preview” gate to live customers (2026-07-20). Full
rules: **[DEPLOY.md](DEPLOY.md)**.

Feature #7 (annotate pipeline) shipped.
