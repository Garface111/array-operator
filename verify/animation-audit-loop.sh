#!/usr/bin/env bash
# Continuous animation audit loop: run until high=0 and med=0 (or MAX_ROUNDS).
# Does NOT auto-edit code — prints report path each round for the agent to fix.
set -euo pipefail
cd "$(dirname "$0")"
MAX="${MAX_ROUNDS:-20}"
i=0
while [ "$i" -lt "$MAX" ]; do
  i=$((i + 1))
  echo ""
  echo "══════════════ AUDIT ROUND $i / $MAX ══════════════"
  set +e
  node animation-audit.mjs
  code=$?
  set -e
  REPORT=$(ls -td artifacts/animation-audit/*/report.json 2>/dev/null | head -1)
  if [ -z "$REPORT" ]; then
    echo "No report produced; aborting."
    exit 1
  fi
  read -r HIGH MED LOW SCEN < <(python3 - <<PY
import json
d=json.load(open("$REPORT"))
s=d.get("summary",{})
b=s.get("by_severity") or {}
print(b.get("high",0), b.get("med",0), b.get("low",0), s.get("scenarios",0))
PY
)
  echo "Round $i result: high=$HIGH med=$MED low=$LOW scenarios=$SCEN exit=$code"
  echo "Report: $REPORT"
  if [ "$HIGH" = "0" ] && [ "$MED" = "0" ]; then
    echo "CLEAN — no high/med issues after $i round(s)."
    exit 0
  fi
  # Leave low-only ambient noise as success if high/med gone
  if [ "$HIGH" = "0" ] && [ "$MED" = "0" ]; then
    exit 0
  fi
  echo "Issues remain — agent should fix then re-run this loop."
  # If called standalone without agent, sleep so humans can fix; agent kills/restarts
  if [ "${AUTO_SLEEP:-0}" = "1" ]; then
    sleep 30
  else
    exit "$code"
  fi
done
echo "Hit MAX_ROUNDS=$MAX with remaining issues."
exit 2
