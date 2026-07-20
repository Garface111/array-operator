#!/usr/bin/env bash
# Deploy the Array Operator PREPROD frontend to the gated Netlify preview site,
# wired to the STAGING backend. This is the "deploy to preprod first" step of
# the dev -> preprod -> prod pipeline. See PREPROD.md and DEPLOY.md.
#
# What it does:
#   1. Stages the committed tree of the preprod branch (default: staging).
#   2. Rewrites public/_redirects so /v1/* and /accounts proxy to the STAGING
#      backend instead of prod.
#   3. Injects the preprod auto-login snippet into index.html (preview only).
#   4. Overwrites netlify.toml with scripts/preprod/netlify.toml (IP gate) and
#      deploys THAT temp tree to the PREVIEW site only — never prod.
#
# The gate + staging-API rewrite are applied ONLY here, never to prod.
# INCIDENT 2026-07-20: running `netlify deploy --prod` from repo root against
# the PROD site UUID attached this gate to arrayoperator.com. This script
# refuses the prod site id.
#
#   Usage:  scripts/deploy-preprod.sh
#   Env:    PREPROD_BRANCH (override branch), NETLIFY_TOKEN_FILE
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HERE/scripts/preprod/config.env"
BRANCH="${PREPROD_BRANCH:-staging}"

# Hard refuse: never allow this script to touch production.
PROD_SITE_ID="966cb1f5-944e-41fd-855b-10053edc5d18"
if [ "${PREPROD_SITE_ID}" = "$PROD_SITE_ID" ]; then
  echo "[preprod] FATAL: PREPROD_SITE_ID equals production. Refusing." >&2
  exit 1
fi
if [ "${PREPROD_SITE_ID}" != "f6c82d88-8d69-4f88-abac-df195a34fe77" ]; then
  echo "[preprod] WARNING: PREPROD_SITE_ID is not the known preview UUID — double-check config.env" >&2
fi

TOKF="${NETLIFY_TOKEN_FILE:-$HOME/.hermes/secrets/netlify_token}"
[ -s "$TOKF" ] || { echo "[preprod] missing Netlify token file: $TOKF" >&2; exit 1; }
export NETLIFY_AUTH_TOKEN="$(cat "$TOKF")"

cd "$HERE"
git fetch origin -q
REF="origin/$BRANCH"
SHA="$(git rev-parse --short "$REF")"
echo "[preprod] deploying $BRANCH @ $SHA  ->  $PREPROD_SITE_NAME ($PREPROD_ORIGIN)"
echo "[preprod] site id: $PREPROD_SITE_ID  (must NOT be prod $PROD_SITE_ID)"

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
# Whole tree (public/ + netlify/edge-functions). Root netlify.toml from git is a
# TRAP (no gate) — we replace it with the preprod-only toml below.
git archive "$REF" | tar -x -C "$S"

# Point the API proxy at the staging backend.
if [ -f "$S/public/_redirects" ]; then
  sed -i "s#${PROD_API_ORIGIN}#${STAGING_API_ORIGIN}#g" "$S/public/_redirects"
  if grep -q "$STAGING_API_ORIGIN" "$S/public/_redirects"; then
    echo "[preprod] _redirects -> staging backend ok"
  else
    echo "[preprod] WARNING: staging origin not found in _redirects after rewrite" >&2
  fi
fi

# Inject the preprod auto-login snippet (preview build ONLY — never committed
# with a real key, never in the prod artifact). Key from a local secret file;
# the matching DEV_AUTOLOGIN_KEY lives on the staging backend.
AUTOLOGIN_KEY_FILE="${AO_PREPROD_AUTOLOGIN_KEY_FILE:-$HOME/.hermes/secrets/ao_preprod_autologin_key}"
SNIP_TMPL="$HERE/scripts/preprod/autologin-snippet.html"
if [ -s "$AUTOLOGIN_KEY_FILE" ] && [ -f "$SNIP_TMPL" ] && [ -f "$S/public/index.html" ]; then
  AK="$(cat "$AUTOLOGIN_KEY_FILE")" IDX="$S/public/index.html" TMPL="$SNIP_TMPL" python3 - <<'PY'
import os, io
idx, tmpl, key = os.environ["IDX"], os.environ["TMPL"], os.environ["AK"].strip()
snip = io.open(tmpl, encoding="utf-8").read().strip().replace("__AUTOLOGIN_KEY__", key)
html = io.open(idx, encoding="utf-8").read()
if "/v1/dev/auto-login" in html:
    print("[preprod] auto-login already present")
elif "</head>" in html:
    io.open(idx, "w", encoding="utf-8").write(html.replace("</head>", snip + "\n</head>", 1))
    print("[preprod] auto-login snippet injected")
else:
    print("[preprod] WARNING: no </head> in index.html; auto-login not injected")
PY
else
  echo "[preprod] no auto-login key file -> skipping auto-login injection (site will require normal login)"
fi

# Install PREPROD-ONLY netlify.toml (has [[edge_functions]] gate). Never use
# the repo-root trap toml, and never copy this onto a prod deploy.
PREPROD_TOML="$HERE/scripts/preprod/netlify.toml"
if [ ! -f "$PREPROD_TOML" ]; then
  echo "[preprod] FATAL: missing $PREPROD_TOML" >&2
  exit 1
fi
cp "$PREPROD_TOML" "$S/netlify.toml"
if ! grep -q 'function = "gate"' "$S/netlify.toml"; then
  echo "[preprod] FATAL: staged netlify.toml missing gate edge function" >&2
  exit 1
fi
if [ ! -f "$S/netlify/edge-functions/gate.ts" ] && [ ! -f "$S/netlify/edge_functions/gate.ts" ]; then
  echo "[preprod] FATAL: gate.ts missing under staged netlify/edge-functions/" >&2
  exit 1
fi
echo "[preprod] staged preprod netlify.toml + edge gate (preview site only)"

cd "$S"
# Final guard: site flag must be preprod UUID
if [ "$PREPROD_SITE_ID" = "$PROD_SITE_ID" ]; then
  echo "[preprod] FATAL: refusing deploy to production site" >&2
  exit 1
fi
netlify deploy --prod --dir public --site "$PREPROD_SITE_ID" \
  --message "preprod $BRANCH@$SHA" | tee /tmp/preprod_deploy.log

URL="$(grep -Eo 'https://[a-zA-Z0-9./_-]+' /tmp/preprod_deploy.log | tail -1 || true)"
echo "[preprod] live (gated): $PREPROD_ORIGIN"
echo "[preprod] verify:  curl -s -o /dev/null -w '%{http_code}\\n' $PREPROD_ORIGIN   # expect 403 (gate) off-allowlist"
