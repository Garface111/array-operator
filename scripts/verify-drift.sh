#!/usr/bin/env bash
# Daily DRIFT check — run the onboarding-sync verification loop against LIVE prod. Catches
# EXTERNAL drift a deploy gate can't: the extension's message contract changing, a dependency or
# CDN breaking the page, etc. Designed to run from cron.
#
# On RED  : flag the fleet's SHARED-BACKLOG (deduped) so the regression gets seen, keep the log.
# On GREEN: clear any prior flag.
#
#   Cron:  30 14 * * *  /mnt/c/Users/fordg/CC/ao-wt/scripts/verify-drift.sh >> /root/ao_verify_drift.log 2>&1
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HERE/verify/logs"; mkdir -p "$LOG_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/drift-$TS.log"
BACKLOG="/mnt/c/Users/fordg/.claude/projects/C--Users-fordg-CC/memory/SHARED-BACKLOG.md"
MARK="onboarding-verify-FAILING"

cd "$HERE/verify"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1
node onboarding-sync.mjs > "$LOG" 2>&1; RC=$?
cp -f "$LOG" "$LOG_DIR/latest.log" 2>/dev/null || true
find "$LOG_DIR" -name 'drift-*.log' -mtime +14 -delete 2>/dev/null || true
echo "[$TS] onboarding drift check rc=$RC"

if [ "$RC" -ne 0 ]; then
  if [ -f "$BACKLOG" ] && ! grep -q "$MARK" "$BACKLOG"; then
    printf '\n- [ ] %s (%s) — onboarding sync verification went RED against live prod. Log: array-operator/verify/logs/latest.log. Repro: `cd array-operator/verify && npm run verify`.\n' "$MARK" "$TS" >> "$BACKLOG"
    echo "[$TS] flagged SHARED-BACKLOG"
  fi
else
  if [ -f "$BACKLOG" ] && grep -q "$MARK" "$BACKLOG"; then
    grep -v "$MARK" "$BACKLOG" > "$BACKLOG.tmp" 2>/dev/null && mv "$BACKLOG.tmp" "$BACKLOG" && echo "[$TS] cleared prior SHARED-BACKLOG flag (green again)"
  fi
fi
exit "$RC"
