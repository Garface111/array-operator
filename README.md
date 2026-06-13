# Array Operator — the owner's interface

The **Array Operator** site: a distinct, owner-facing product under the
**EnergyAgent** umbrella (sibling to NEPOOL Operator / solaroperator.org).

This is NOT a dashboard you read — it's an agent that watches your panels and
brings you the verdict and the paperwork. Built on the sun-mirror per-inverter
ground-truth engine (`peer_index`): every inverter is measured against its own
fleet under the same sky, so weather cancels and a silent underperformer can't
hide behind a cloudy day.

## What's here

- `public/index.html` — the Array Operator interface. Dollar-first hero, a
  "We're on it" done-for-you band (drafted warranty claims, diagnosed money
  leaks, found REC revenue), and the ground-truth fleet with peer-index bars,
  plain-English status, and per-inverter dollars-lost.
- `public/inverter-truth.json` — engine output (demo). Regenerate with the
  sun-mirror engine: `python3 ~/sun-mirror/capture/inverters.py --demo --out public/inverter-truth.json`
- `ARRAY_OWNER_RESEARCH.md` — the owner persona + problem research driving the
  design.

## Run locally

```bash
cd public && python3 -m http.server 8088   # → http://localhost:8088
```

## Backend

The live product reads `/v1/array-owners/overview` from the shared Solar
Operator backend (FastAPI on Railway) — same engine, same `peer_analysis`
module. This static site is the standalone showcase / front door; the React
dashboard at solaroperator.org/accounts is the authenticated app.

## Brand

Array Operator is an EnergyAgent product. EnergyAgent is a Dyson Swarm
Technologies product. Domain target: app.yourenergyagent.com (or arrayoperator.*).
