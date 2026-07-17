#!/usr/bin/env bash
# Promote what you tested on PREPROD (the staging branch) to PRODUCTION.
#
# The dev -> preprod -> prod pipeline ends here. This is deliberately guarded:
# it pushes to main (prod backend auto-deploys) and deploys the prod frontend.
#
#   Usage:  scripts/promote-to-prod.sh --yes
#
# Preconditions (the script checks): staging merges cleanly into main. Keep
# staging current first if other lanes have advanced main:
#   git checkout staging && git merge origin/main && git push origin staging
#   scripts/deploy-preprod.sh   # re-test on preprod, THEN promote
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

[ "${1:-}" = "--yes" ] || { echo "Refusing to promote without --yes (this deploys to PRODUCTION)."; exit 2; }

git fetch origin -q
AHEAD="$(git rev-list --count origin/main..origin/staging)"
BEHIND="$(git rev-list --count origin/staging..origin/main)"
echo "[promote] staging is $AHEAD commit(s) ahead of main, $BEHIND behind."
if [ "$BEHIND" -gt 0 ]; then
  echo "[promote] main has advanced past staging. Sync staging first:" >&2
  echo "          git checkout staging && git merge origin/main && git push origin staging" >&2
  exit 1
fi
if [ "$AHEAD" -eq 0 ]; then echo "[promote] nothing to promote."; exit 0; fi

echo "[promote] changes going to production:"
git --no-pager log --oneline origin/main..origin/staging | sed 's/^/          /'

# Fast-forward main to staging (safe: we verified main is not behind... i.e. staging
# contains all of main), then push. Prod backend auto-deploys on push-to-main.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git worktree add -q "$TMP" origin/main
git -C "$TMP" merge --ff-only origin/staging || { echo "[promote] main cannot fast-forward from staging (divergence). Sync staging first." >&2; git worktree remove --force "$TMP"; exit 1; }
git -C "$TMP" push origin HEAD:main
git worktree remove --force "$TMP"
echo "[promote] main updated -> prod backend (Railway web) auto-deploys."

echo "[promote] deploying prod frontend (arrayoperator.com)..."
scripts/deploy-and-verify.sh
echo "[promote] done. Verify: https://arrayoperator.com"
