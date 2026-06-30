#!/usr/bin/env bash
# Deploy the Array Operator static site (public/) to Netlify, then GATE on the onboarding-sync
# verification loop. If the onboarding sync regressed, this command exits non-zero so a bad
# deploy is LOUD instead of silent.
#
# This is the canonical onboarding deploy path (see memory: deploy-playbook). It composes the
# existing `git archive HEAD public | netlify_deploy_dir.py` flow — it does not change it.
#
# NOTE: Netlify publishes immediately, so this is deploy-THEN-verify (catch + alert fast), not a
# pre-promote gate. On red: the deploy is live but flagged — investigate / revert at once.
#
#   Usage:  scripts/deploy-and-verify.sh
#   Env:    NETLIFY_DEPLOY_HELPER (default /mnt/c/Users/fordg/CC/netlify_deploy_dir.py)
#           ONB_URL               (default https://arrayoperator.com/onboarding)
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HELPER="${NETLIFY_DEPLOY_HELPER:-/mnt/c/Users/fordg/CC/netlify_deploy_dir.py}"
ONB_URL="${ONB_URL:-https://arrayoperator.com/onboarding}"
cd "$HERE"

echo "[deploy] public/ @ $(git rev-parse --short HEAD)"
S="$(mktemp -d)"
git archive HEAD public | tar -x -C "$S" || { echo "[deploy] archive failed" >&2; exit 1; }
python3 "$DEPLOY_HELPER" "$S/public" || { echo "[deploy] netlify deploy failed" >&2; exit 1; }
echo "[deploy] live — waiting ~6s for propagation"; sleep 6

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
