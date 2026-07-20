#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# PRODUCTION frontend deploy — arrayoperator.com ONLY safe path
# ═══════════════════════════════════════════════════════════════════════════
#
# Deploys public/ via REST digest upload (no root netlify.toml, no edge
# functions). Then verifies the live site is NOT the preprod Private Preview
# gate, and runs the onboarding-sync check.
#
# INCIDENT 2026-07-20: `netlify deploy --prod --dir public` from repo root
# attached the preprod IP gate to production. NEVER use the Netlify CLI for
# prod. See DEPLOY.md.
#
#   Usage:  scripts/deploy-and-verify.sh
#   Env:    NETLIFY_DEPLOY_HELPER (default /mnt/c/Users/fordg/CC/netlify_deploy_dir.py)
#           ONB_URL               (default https://arrayoperator.com/onboarding)
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HELPER="${NETLIFY_DEPLOY_HELPER:-/mnt/c/Users/fordg/CC/netlify_deploy_dir.py}"
ONB_URL="${ONB_URL:-https://arrayoperator.com/onboarding}"
PROD_URL="${PROD_URL:-https://arrayoperator.com/}"
PROD_SITE_ID="966cb1f5-944e-41fd-855b-10053edc5d18"
cd "$HERE"

echo "[deploy:prod] ══════════════════════════════════════════════════════"
echo "[deploy:prod] PRODUCTION only — public/ REST upload, NO edge functions"
echo "[deploy:prod] FORBIDDEN: netlify deploy --prod from repo root"
echo "[deploy:prod] ══════════════════════════════════════════════════════"
echo "[deploy:prod] public/ @ $(git rev-parse --short HEAD)"

if [ ! -f "$DEPLOY_HELPER" ]; then
  echo "[deploy:prod] FATAL: missing deploy helper: $DEPLOY_HELPER" >&2
  echo "[deploy:prod]     Do NOT fall back to netlify CLI. Fix the helper path." >&2
  exit 1
fi

# Refuse if someone exported a flag that would point CLI at prod with a gate
if [ "${FORCE_NETLIFY_CLI_PROD:-}" = "1" ]; then
  echo "[deploy:prod] FATAL: FORCE_NETLIFY_CLI_PROD is set — that path is banned." >&2
  exit 1
fi

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
git archive HEAD public | tar -x -C "$S" || { echo "[deploy:prod] archive failed" >&2; exit 1; }

# Safety: staged tree must be public-only (no netlify.toml, no edge functions)
if [ -f "$S/netlify.toml" ] || [ -f "$S/public/../netlify.toml" ]; then
  echo "[deploy:prod] FATAL: netlify.toml present in archive staging — abort" >&2
  exit 1
fi
if [ -d "$S/netlify" ] || [ -d "$S/public/netlify" ]; then
  echo "[deploy:prod] FATAL: netlify/ edge dir present in prod archive — abort" >&2
  exit 1
fi
# git archive HEAD public puts files under $S/public
if [ ! -d "$S/public" ]; then
  echo "[deploy:prod] FATAL: expected $S/public from git archive" >&2
  exit 1
fi

python3 "$DEPLOY_HELPER" "$S/public" || {
  echo "[deploy:prod] netlify REST deploy failed" >&2
  echo "[deploy:prod] Do NOT fall back to: netlify deploy --prod" >&2
  exit 1
}
echo "[deploy:prod] live — waiting ~8s for propagation"; sleep 8

# ── CRITICAL: prove the preprod gate is NOT on production ─────────────────
echo "[deploy:prod] smoke: ensure Private Preview gate is absent on $PROD_URL"
CODE="$(curl -sS -o /tmp/ao_prod_smoke.html -w '%{http_code}' --max-time 20 "$PROD_URL" || echo FAIL)"
if [ "$CODE" != "200" ]; then
  echo "[deploy:prod] FATAL: $PROD_URL returned HTTP $CODE (expected 200)" >&2
  exit 1
fi
if grep -qiE 'Private preview|preprod environment|Request access' /tmp/ao_prod_smoke.html; then
  echo "[deploy:prod] ══════════════════════════════════════════════════" >&2
  echo "[deploy:prod] FATAL: PREPROD GATE IS LIVE ON PRODUCTION" >&2
  echo "[deploy:prod]     Page body matches Private preview / preprod gate." >&2
  echo "[deploy:prod]     Re-run a public-only REST deploy immediately." >&2
  echo "[deploy:prod]     See DEPLOY.md (incident 2026-07-20)." >&2
  echo "[deploy:prod] ══════════════════════════════════════════════════" >&2
  exit 1
fi
if ! grep -qi 'Array Operator' /tmp/ao_prod_smoke.html; then
  echo "[deploy:prod] FATAL: prod HTML does not look like the real app" >&2
  exit 1
fi
echo "[deploy:prod] smoke OK — no Private Preview gate on production"

# Optional API check: latest deploy must not list edge functions
if [ -s "${NETLIFY_TOKEN_FILE:-$HOME/.hermes/secrets/netlify_token}" ]; then
  TOK="$(cat "${NETLIFY_TOKEN_FILE:-$HOME/.hermes/secrets/netlify_token}")"
  if python3 - "$PROD_SITE_ID" "$TOK" <<'PY'
import json, sys, urllib.request
site, tok = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    f"https://api.netlify.com/api/v1/sites/{site}/deploys?per_page=1",
    headers={"Authorization": f"Bearer {tok}", "User-Agent": "curl/8.5.0"},
)
with urllib.request.urlopen(req, timeout=30) as r:
    deps = json.loads(r.read())
dep = deps[0] if isinstance(deps, list) else deps
edge = dep.get("edge_functions_present")
print(f"[deploy:prod] latest deploy {dep.get('id')} edge_functions_present={edge}")
if edge is True:
    print("[deploy:prod] FATAL: production deploy has edge functions (preprod gate risk)", file=sys.stderr)
    sys.exit(1)
PY
  then
    echo "[deploy:prod] Netlify API: no edge functions on latest deploy"
  else
    echo "[deploy:prod] FATAL: edge functions present on production deploy" >&2
    exit 1
  fi
fi

echo "[gate] verifying onboarding sync against $ONB_URL"
cd "$HERE/verify"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1
if ONB_URL="$ONB_URL" node onboarding-sync.mjs; then
  echo "[gate] OK — onboarding verified, deploy good"
else
  {
    echo ""
    echo "[gate] xxx ONBOARDING REGRESSED — the deploy is LIVE but the sync FAILED verification."
    echo "[gate]     Investigate / revert now:  cd verify && npm run verify:headed"
  } >&2
  exit 1
fi
