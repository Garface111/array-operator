# Array Operator — Architecture Slideshow Frame Plan

Source of truth: `architecture-slideshow.html` (single self-contained file, dark theme, SVG).
One conceptual increment per frame; the diagram accumulates within each chapter.
Color code (legend always visible): **cyan** = capture/extension · **violet** = front-end/API ·
**amber** = state/persistence · **green** = background jobs/engine · **rose** = external services ·
**white** = people/deliverables.

The Array Operator is the owner-facing sibling of NEPOOL Operator. Its thesis (ARRAY_OWNER_RESEARCH.md):
not a dashboard — an agent that watches your panels and brings the verdict and the paperwork.

## Chapter 1 — The Big Picture (frames 1–7)

| # | What appears | Caption |
|---|--------------|---------|
| 1 | Title + legend | Array Operator: an agent that watches your panels — verdict + paperwork |
| 2 | Owner + inverter clouds / GMP portal boxes | The owner's data lives in vendor clouds and the utility portal |
| 3 | arrayoperator.com box (Netlify, `public/`) | The front door: a static, no-build vanilla-JS site on Netlify |
| 4 | Shared FastAPI backend box + `/v1/*` proxy arrow | `_redirects` proxies `/v1/*` same-origin to the shared solar-operator backend on Railway |
| 5 | Postgres box | Same 33-table database — Inverter, DailyGeneration, WarrantyClaim live here |
| 6 | EnergyAgent extension box + capture arrows | The same extension captures inverter portals and GMP meters |
| 7 | Output arrows: alert emails, warranty claims, offtaker invoices | What comes out: verdicts, paperwork, and invoices — not charts |

## Chapter 2 — The Front Door: `public/` (frames 8–15)

| # | What appears | Caption |
|---|--------------|---------|
| 8 | `index.html` — one page, 6 tabs (Fleet Health · Inverters · Analysis · Trends · Invoices · Account) | No SPA router: hash tabs and hidden panels |
| 9 | `fleet-store.js` (`window.FleetStore`) | Single source of truth: array → inverter model with peer_index, status, dollars |
| 10 | `sandbox.js` + `vendor-sheet.js` | Two views of the same store: spatial canvas and sortable spreadsheet |
| 11 | `command-center.js` | Portfolio rollup, worst-first: how many inverters flagged, how many $ leaking |
| 12 | `analysis.js` + 8 `analysis-*.js` section modules | A PowerTrack-style NOC with an honesty contract: never fabricate expected values |
| 13 | `trends-core.js` registry + `trends-view-*.js` (bars·monthly·liquid·spiral·heatfield) | Plug-in canvas views of one payload — `registerView(key, {mount})` |
| 14 | `session-tabscope.js` + `login.html` (`so_session` bearer) | Per-tab sessions; password or magic-link → `/v1/auth/*` |
| 15 | `demo-data.js` + `error-reporter.js` | Signed-out visitors get a consistent fake fleet; errors POST to `/v1/client-error` |

## Chapter 3 — Ground Truth: peer_index (frames 16–21)

| # | What appears | Caption |
|---|--------------|---------|
| 16 | `api/inverters/peer_analysis.py` — `analyze_cohort()` | The engine: judge a unit against its cohort, not in isolation |
| 17 | Formula: `peer_index = energy share / nameplate share` | Same sky, same window — weather cancels out |
| 18 | Threshold markers: `1.00` pulling weight · `< 0.85` underperforming | UNDERPERFORM_THRESHOLD = 0.85 |
| 19 | Status ladder: `fault > dead > comm_gap > underperforming > ok` | Vendor faults win; DEAD_DAYS=2, COMM_GAP_HOURS=24 |
| 20 | Degenerate-cohort caveat box | One-unit cohorts get peer_index=None — nothing to underperform against |
| 21 | "Pure functions only" note | No I/O, no DB — dicts in, dicts out; ported from sun-mirror |

## Chapter 4 — Data In (frames 22–28)

| # | What appears | Caption |
|---|--------------|---------|
| 22 | `InverterConnection` (one per array) + `api/inverters.VENDORS` (9 vendors) | One uniform interface: validate / fetch_live / fetch_daily |
| 23 | `poll_all_sources_job` — every 5 min, daylight-gated → `InverterReading` | Live watts, continuously, without burning night API budget |
| 24 | Nightly `inverter_pull` 03:00 → `DailyGeneration` / `InverterDaily` | Settled daily kWh for every vendor |
| 25 | `heal_missing_history` 04:15 + connect-time backfill | Self-healing multi-year history — new connections fill in |
| 26 | Extension path: solaredge/solarweb/sunnyportal/chint content scripts → `/v1/array-owners/inverter-capture` | No API key? The extension captures the vendor portal |
| 27 | `gmp_meter_content.js` → `/v1/array-owners/utility-meter-capture` | The GMP meter is billing truth — captured client-side |
| 28 | `solaredge/discover` — one credential, every array | Paste one key; the backend discovers all your sites |

## Chapter 5 — The Fleet Model (frames 29–34)

| # | What appears | Caption |
|---|--------------|---------|
| 29 | `api/inverter_fleet.py` — owner-arrangeable `Inverter` rows | Owners think "the six inverters at Londonderry", not vendor sites |
| 30 | `discover_and_persist()` — upsert, never clobber `array_id` | Vendor inventory lands idempotently; owner grouping is sacred |
| 31 | `build_fleet_tree()` — group the OWNER's way, attach telemetry, peer-analyze | The 3-tier tree the whole product reads |
| 32 | Drag → `reassign_inverter()` — moving an inverter changes its cohort | The sandbox is a control surface, not a saved pixel layout |
| 33 | `/v1/array-owners/fleet-tree` → FleetStore | One endpoint feeds sandbox, spreadsheet, command center, analysis |
| 34 | `/v1/array-owners/overview` + `fleet-trends` + `fleet-audit` | The other read surfaces, all built on the same tree |

## Chapter 6 — The Watchers (frames 35–40)

| # | What appears | Caption |
|---|--------------|---------|
| 35 | APScheduler (shared, in the one web process) | Same background engine as NEPOOL Operator — no worker dyno |
| 36 | `inverter_alert_sweep.run_sweep()` — hourly at :20 | Finds DOWN and underperforming inverters via the fleet tree |
| 37 | `InverterAlertState` — `first_flagged_at` / `last_alerted_at` + grace window | One email per incident, not one per tick |
| 38 | `reconcile_warranty_claims` — every 15 min | Auto-opens claims for newly failed inverters, closes recovered ones |
| 39 | `generation_watchdog` 03:45 — physically-impossible kWh alarm | Bad data is caught before it can bill |
| 40 | `morning_fleet_digest` 12:00 UTC | One daily "is my fleet healthy" email per owner |

## Chapter 7 — Money (frames 41–47)

| # | What appears | Caption |
|---|--------------|---------|
| 41 | `reports.js` — Offtaker Invoice Generator tab | Upload a billing spreadsheet; the agent takes it from there |
| 42 | `POST /v1/array-operator/billing/match` → `matcher.match_billing_workbook` | Schema-matches the workbook to arrays and offtakers |
| 43 | `BillingReportSubscription` — cadence, allocation %, rate chain | rate_per_kwh → tenant default → VT legacy fallback |
| 44 | `billing/delivery.py deliver_subscription()` — invoice PDF/XLSX + summary → Resend | Same pipeline for "send now" and the scheduler — they can never drift |
| 45 | `last_sent_period_end` guard + send-mode slider (to me / to client / to both) | Exactly once per period; the owner controls who receives |
| 46 | `new_bill_review` 13:00 — new GMP bill → drafted invoice → "come review" prompt | The owner hears the moment the bill lands, not on the 1st |
| 47 | Pricing: $0.15/kW·mo nameplate (`nameplate_sync` 04:05) + $20/offtaker | Stripe quantities self-heal daily against registered nameplate |

## Chapter 8 — Full Trace: A Silent Failure Becomes Paperwork (frames 48–58)

| # | What appears (lit on ghosted full-system map) | Caption |
|---|--------------|---------|
| 48 | Map fades in dimmed; one inverter card flips dark | Day 0: an optimizer trips at Londonderry. The vendor app shows… a number |
| 49 | 5-min poll + nightly `inverter_pull` record the weak days | The data keeps arriving — same sky, same cohort |
| 50 | `build_fleet_tree` → `analyze_cohort`: peer_index drops to 0.62 | Peers produced; this one didn't. Weather can't be blamed |
| 51 | Status ladder fires: `underperforming` → 2 zero days → `dead` | Caught the day it slipped, not next year |
| 52 | `run_sweep` opens `InverterAlertState`, grace window runs | The agent waits out blips before speaking |
| 53 | Grace passes → owner gets the alert email (Resend) | Plain English + dollars lost, not a chart |
| 54 | `reconcile_warranty_claims` opens a `WarrantyClaim` | Drafted manufacturer email + peer-measured evidence snapshot |
| 55 | `claim_send_mode`: manual / auto / delay | Nothing leaves without the owner's policy saying so |
| 56 | Owner opens arrayoperator.com — FleetStore shows the red card | Verdict, dollars, and a finished claim waiting |
| 57 | Owner clicks send → forward-ready packet to their inbox | Manufacturer address in the body; Reply-To is the owner |
| 58 | Claim closes when the inverter recovers | The loop is watched end-to-end — that's the product |

**Total: 58 frames · 8 chapters**
