#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Continuous animation audit → stop only when high=0 and med=0.
#
# This is the outer gate. The agent (or a FIX_HOOK) must repair product/CSS
# between rounds when issues remain. Standalone AUTO_SLEEP just re-polls.
#
# Usage:
#   verify/animation-audit-until-clean.sh
#   MAX_ROUNDS=50 FIX_HOOK='./my-fix.sh' verify/animation-audit-until-clean.sh
#   AUTO_SLEEP=1   # re-audit every 45s without exiting (human/agent edits live)
#
# Exit codes:
#   0  clean (high=0, med=0)
#   2  hit MAX_ROUNDS with remaining high/med
#   1  fatal (no report / audit crashed without report)
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")"
MAX="${MAX_ROUNDS:-40}"
SLEEP_S="${SLEEP_S:-45}"
HISTORY="artifacts/animation-audit/until-clean-history.jsonl"
mkdir -p artifacts/animation-audit
i=0
prev_sig=""
stagnant=0

echo "═══════════════════════════════════════════════════════════"
echo " animation-audit-until-clean  max_rounds=$MAX"
echo " stop condition: high=0 AND med=0  (low ambient noise OK)"
echo "═══════════════════════════════════════════════════════════"

while [ "$i" -lt "$MAX" ]; do
  i=$((i + 1))
  echo ""
  echo "══════════════ ROUND $i / $MAX ══════════════"
  set +e
  node animation-audit.mjs
  code=$?
  set -e

  REPORT=$(ls -td artifacts/animation-audit/*/report.json 2>/dev/null | head -1)
  if [ -z "$REPORT" ] || [ ! -f "$REPORT" ]; then
    echo "FATAL: no report.json produced (exit=$code)"
    exit 1
  fi

  eval "$(python3 - <<'PY' "$REPORT"
import json, sys
p = sys.argv[1]
d = json.load(open(p))
s = d.get("summary") or {}
b = s.get("by_severity") or {}
high = int(b.get("high") or 0)
med = int(b.get("med") or 0)
low = int(b.get("low") or 0)
scen = int(s.get("scenarios") or 0)
issues = []
for r in d.get("results") or []:
    for iss in r.get("issues") or []:
        sev = iss.get("severity") or ""
        if sev in ("high", "med"):
            issues.append(f"{r.get('id') or r.get('scenario') or '?'}:{iss.get('code')}:{sev}")
# also scan top-level issues if present
for iss in d.get("issues") or []:
    sev = iss.get("severity") or ""
    if sev in ("high", "med"):
        issues.append(f"{iss.get('scenario') or '?'}:{iss.get('code')}:{sev}")
sig = "|".join(sorted(set(issues))) or "clean"
print(f"HIGH={high}")
print(f"MED={med}")
print(f"LOW={low}")
print(f"SCEN={scen}")
print(f"SIG={sig!r}")
print(f"ISSUES={json.dumps(issues)}")
PY
)"

  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"ts\":\"$ts\",\"round\":$i,\"high\":$HIGH,\"med\":$MED,\"low\":$LOW,\"scenarios\":$SCEN,\"report\":\"$REPORT\",\"sig\":$SIG}" >> "$HISTORY"
  echo "Round $i → high=$HIGH med=$MED low=$LOW scenarios=$SCEN exit=$code"
  echo "Report: $REPORT"
  if [ "$HIGH" != "0" ] || [ "$MED" != "0" ]; then
    echo "Open high/med:"
    python3 - <<PY
import json
d=json.load(open("$REPORT"))
seen=set()
for r in d.get("results") or []:
  for iss in r.get("issues") or []:
    if iss.get("severity") in ("high","med"):
      line=f"  [{iss.get('severity')}] {r.get('id') or r.get('scenario')}: {iss.get('code')} — {iss.get('message','')}"
      if line not in seen:
        seen.add(line); print(line)
for iss in d.get("issues") or []:
  if iss.get("severity") in ("high","med"):
    print(f"  [{iss.get('severity')}] {iss.get('scenario')}: {iss.get('code')} — {iss.get('message','')}")
PY
  fi

  if [ "$HIGH" = "0" ] && [ "$MED" = "0" ]; then
    echo ""
    echo "CLEAN after $i round(s) — high=0 med=0 (low=$LOW ok)."
    echo "History: $HISTORY"
    exit 0
  fi

  # Stagnation: same issue signature 3 rounds in a row without a fix landing
  if [ "$SIG" = "$prev_sig" ]; then
    stagnant=$((stagnant + 1))
  else
    stagnant=0
    prev_sig="$SIG"
  fi
  if [ "$stagnant" -ge 3 ] && [ -z "${FIX_HOOK:-}" ] && [ "${AUTO_SLEEP:-0}" != "1" ]; then
    echo "STAGNANT: same high/med signature for 3 rounds. Agent must change product/CSS."
    echo "Re-run after fixes (commit+deploy for prod AO_BASE)."
    exit 2
  fi

  if [ -n "${FIX_HOOK:-}" ]; then
    echo "Running FIX_HOOK: $FIX_HOOK"
    set +e
    bash -c "$FIX_HOOK" "$REPORT" "$i"
    set -e
  fi

  if [ "${AUTO_SLEEP:-0}" = "1" ]; then
    echo "AUTO_SLEEP: waiting ${SLEEP_S}s for agent/human edits…"
    sleep "$SLEEP_S"
  else
    # Default: one audit pass, leave remaining issues for the agent to fix then re-invoke.
    # When the agent owns the loop, it re-invokes this script after each fix+deploy.
    echo "Issues remain after round $i — fix product, commit, deploy, re-run this script."
    exit 2
  fi
done

echo "Hit MAX_ROUNDS=$MAX with remaining high/med."
exit 2
