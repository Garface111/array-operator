#!/usr/bin/env bash
# Deploy the Array Operator PREPROD frontend to the gated Netlify preview site,
# wired to the STAGING backend. This is the "deploy to preprod first" step of
# the dev -> preprod -> prod pipeline. See PREPROD.md.
#
# What it does:
#   1. Stages the committed tree of the preprod branch (default: staging).
#   2. Rewrites public/_redirects so /v1/* and /accounts proxy to the STAGING
#      backend instead of prod.
#   3. Deploys from the repo root so Netlify bundles the edge-function access
#      gate (netlify.toml + netlify/edge_functions/gate.ts); publish dir = public.
#
# The gate + staging-API rewrite are applied ONLY here, never to prod.
#
#   Usage:  scripts/deploy-preprod.sh
#   Env:    PREPROD_BRANCH (override branch), NETLIFY_TOKEN_FILE
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HERE/scripts/preprod/config.env"
BRANCH="${PREPROD_BRANCH:-staging}"

TOKF="${NETLIFY_TOKEN_FILE:-$HOME/.hermes/secrets/netlify_token}"
[ -s "$TOKF" ] || { echo "[preprod] missing Netlify token file: $TOKF" >&2; exit 1; }
export NETLIFY_AUTH_TOKEN="$(cat "$TOKF")"

cd "$HERE"
git fetch origin -q
REF="origin/$BRANCH"
SHA="$(git rev-parse --short "$REF")"
echo "[preprod] deploying $BRANCH @ $SHA  ->  $PREPROD_SITE_NAME ($PREPROD_ORIGIN)"

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
# Whole tree (root netlify.toml + netlify/edge_functions + public/).
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

cd "$S"
# Deploy from repo root: netlify discovers netlify.toml + the edge gate here.
netlify deploy --prod --dir public --site "$PREPROD_SITE_ID" \
  --message "preprod $BRANCH@$SHA" | tee /tmp/preprod_deploy.log

URL="$(grep -Eo 'https://[a-zA-Z0-9./_-]+' /tmp/preprod_deploy.log | tail -1 || true)"
echo "[preprod] live (gated): $PREPROD_ORIGIN"
echo "[preprod] verify:  curl -s -o /dev/null -w '%{http_code}\\n' $PREPROD_ORIGIN   # expect 401 (gate)"
