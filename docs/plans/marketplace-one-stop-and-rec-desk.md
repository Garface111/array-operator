# Marketplace → Operator Desk (one-stop) + REC trading

**Status:** Product architecture (2026-07-18). Not shipped as a live AO tab yet.
**Owner product:** Array Operator (`arrayoperator.com`) + shared backend (`solar-operator`).
**Sister product:** NEPOOL Operator (generation → GMCS/REC workbook → Independent Verifier / Crown).

---

## 0. Honest baseline (code vs brief)

Marketplace v0 **exists on staging +** `https://ao-owner-web-preview.netlify.app/#marketplace` (merged Offtaker Exchange + Array Prospectus). It may not yet be on every production shell / `main` checkout — treat preview/staging as source of truth for the surface.

### Shipped v0 (do not rebuild)

| Piece | Where | APIs / modules |
|-------|--------|----------------|
| Marketplace top tab + sub-tab registry | `marketplace.js` shell (`window.__aoMarketplace`) | — |
| Credit Exchange | vacancy cards, expiry, waitlist intake | `GET /v1/array-operator/billing/vacancy`, `GET/POST …/exchange/demand` · `api/market_vacancy.py` · `ExchangeDemand` |
| Array Market | prospectus build/list + PDF + share | `POST /v1/array-owners/arrays/{id}/prospectus`, prospectuses list, share mint/patch, public token route · `api/prospectus.py` + `prospectus_routes.py` · `ProspectusShare` / `AgentDocument` |
| Honesty rails | confidence tiers, SHA-256, unpublished-by-default, PII redact, disclaimer | already encoded in builders |

Vacancy math (keep): bill-side primary (pool − $0 EXCESS shared + retained), registry-side secondary, confidence high/medium/none; rates from bill → account → fleet → default — never fantasy flat rates when real ones exist. Demo tenants excluded from any future cross-tenant board (`is_synthetic_tenant`).

### Already live elsewhere (wire into Marketplace; don’t fork)

| Need | Surface |
|------|---------|
| Offtaker invoices | Invoices → Offtakers |
| Generation → REC filing pack | Invoices → Generation reports + NEPOOL GMCS/REC writers |
| REC price context (indicative) | Analysis → Resources (`resources-data.json`) |
| O&M | Repairs + Energy Agent |
| Fleet truth | Fleet Triage / Analysis |

### Not built yet (expansion targets)

- Lead → prefilled offtaker draft + utility allocation packet
- Match suggestions (still human-approve)
- Prospectus purpose packs / versioning / multi-array
- **REC Desk** (ownership, readiness, inventory, sell intent, transfer checklist)
- Cross-tenant demand board, placement fees, escrow, any money movement

Mental model stays:

```
AO = truth + paper + workflow
Utility / NEPOOL-GIS / counsel / broker / bank = authority + money + legal title
```

---

## 1. Product rename of the surface (one-stop without clutter)

**Do not** invent five parallel “marketplaces.” One top-level tab:

### **Marketplace** (or **Desk** if “Marketplace” feels broker-y)

Four **lanes** (sub-tabs). Each lane is single-player valuable first.

```
┌─────────────┬──────────────────────────────┬─────────┬─────────────────────────┐
│ Lane        │ Job                          │ Money?  │ Matching?               │
├─────────────┼──────────────────────────────┼─────────┼─────────────────────────┤
│ Credits     │ Unallocated GNM vacancy +    │ No v0   │ Hand → suggest → host   │
│             │ waitlist → offtaker pipeline │         │ confirm only            │
├─────────────┼──────────────────────────────┼─────────┼─────────────────────────┤
│ Arrays      │ Verified data room for sale  │ No v0   │ Interest inbox only     │
│             │ / refi / insurance diligence │         │ (no brokerage desk)     │
├─────────────┼──────────────────────────────┼─────────┼─────────────────────────┤
│ RECs        │ Own? Ready? Mint? Sell path  │ No v0   │ Broker/partner intro;   │
│             │ for certificates you own     │         │ GIS transfer checklist  │
├─────────────┼──────────────────────────────┼─────────┼─────────────────────────┤
│ Services    │ O&M bids, insurance packets, │ No v0   │ Route into Repairs /    │
│ (thin)      │ intro requests               │         │ prospectus purpose packs│
└─────────────┴──────────────────────────────┴─────────┴─────────────────────────┘
```

**Nav placement:** new top tab **between Analysis and Invoices** (deals sit next to money/ops). Deep links:

- `#marketplace` / `#marketplace/credits`
- `#marketplace/arrays`
- `#marketplace/recs`
- `#marketplace/services`

**One-stop shop rule:** Marketplace is the **front door for deals**. Execution stays where it already works:

- Credits close → **Invoices / offtakers**
- RECs mint pack → **Generation reports** (same workbook stack)
- Array diligence → prospectus PDF + share (new) but O&M history from **Repairs/Analysis**
- Never duplicate offtaker CRUD inside Marketplace — draft and deep-link

---

## 2. Operator needs map (everything an array operator actually buys/sells)

### A. Credit / offtaker market (Credits lane)

| Deal | Exchange | AO role |
|------|----------|---------|
| Fill vacancy | Unallocated kWh/credit → new member | Measure vacancy; waitlist; draft offtaker; utility packet |
| Reallocate | % move between offtakers | Prefill change form; edit subscription |
| Waitlist placement | Future credit promise | Soft lead store; host approve |
| Expiry rescue | Banked credits near ~12‑mo limit | Urgency queue + nudge |
| Cross-fleet match | Owner A vacancy ↔ Owner B demand (same utility) | **Later**, demo-tenant guards, human approve |
| Placement fee | AO success fee after utility accepts | **Deferred** until counsel + framing |

Vacancy definition (keep precise):

```
vacancy_kwh ≈ host_grid_export_kwh − sum(member excess-shared kWh)
```

Registry % sums are a secondary check with confidence tiers: **Measured / Estimate / Connect login**.

### B. Capital & ownership (Arrays lane)

| Deal | Package purpose |
|------|-----------------|
| Whole array / SPV sale | `purpose=sale` |
| Partial interest | sale pack + external ownership docs |
| Refinance / debt | `purpose=refinance` |
| Insurance / O&M bid | `purpose=insurance` or `om` |
| Portfolio roll-up | multi-array side-by-side (phase 2) |

Prospectus contents (from existing captures): production (captured vs owner vs estimate), weather-adjusted performance, inverter health, repairs/warranty, offtaker **invoiced** revenue, utility bills, reliability indicator, SHA-256 over data sections.

Disclaimers (non-negotiable): not an appraisal, not an offer, not investment advice; revenue is invoiced ≠ collected; offtaker PII redacted by default; unpublished until deliberate publish; revoke = 404.

### C. Certificate market (RECs lane) — **new keystone**

RECs are a **third commodity**, orthogonal to bill credits:

| Stream | What it is | Where settled |
|--------|------------|---------------|
| Bill credits / GNM $ | Utility bill reduction for offtakers/host | Utility + AO invoices |
| RECs | 1 MWh renewable attribute certificate | **NEPOOL-GIS** (+ state RPS programs) |
| Capacity / other | Rare for small fleets | Out of scope v1 |

**Critical ownership fork (must be first-class UI):**

Many VT/MA/CT/RI programs **assign RECs to the utility** in exchange for a rate adjustor or incentive (VT +$0.03/kWh path, SMART attribute transfer, REG, etc.). Selling RECs only applies when the **owner still holds** the attribute.

Per-array REC status machine:

```
unknown → assigned_to_utility | owner_retained | split/unclear
                ↓                      ↓
           (no sell desk)      readiness → mint → inventory → sell intent → transfer
```

### D. Adjacent (do not re-home into Marketplace as new UIs)

| Need | Home |
|------|------|
| Recurring offtaker invoices | Invoices |
| Repair coordination | Repairs |
| Rate / tariff intel | Resources |
| Settlement audit (production vs utility-settled) | Future **Intel / Audit** venture — not Marketplace clearing |
| NEPOOL client workbook email to Crown | Generation reports / NEPOOL Operator |

---

## 3. How to sell / trade RECs through AO (without becoming an illegal broker)

### 3.1 What NEPOOL-GIS actually is

- **Registry + tracking system**, not a marketplace.
- Issues certificates after generation + Independent Verifier (IV) reporting (trimester/quarter cycle; mint lag ~1 quarter+).
- **GIS does not price, buy, or sell.** Transfers move certificate title between GIS accounts after a bilateral deal (or aggregator standing arrangement).
- Transferor initiates; pending transfers can be withdrawn; acceptor confirms. Settlement $ is **outside** GIS (wire, broker invoice, etc.).

Regional price context AO already shows: Class I ~$30–40/MWh band, MA ACP $40/MWh ceiling (indicative, not a live bid).

### 3.2 Three legal product shapes (pick in order)

| Shape | What AO does | License risk | Revenue | Recommend |
|-------|--------------|--------------|---------|-----------|
| **A. REC Desk (software)** | Inventory, readiness, mint packs, sell-intent listing, transfer checklist, broker intro, proof upload | Low if no negotiation language / no custody | SaaS only | **Ship first** |
| **B. Facilitated brokerage intro** | Soft match owner ask ↔ licensed broker/aggregator; optional success fee after *documented* GIS transfer + owner marks paid | Medium — need VT counsel + “software facilitation” framing; never “we sell your RECs” as principal | Optional success fee / referral | Phase after A |
| **C. AO as aggregator / account agent** | AO holds GIS account, receives forward transfers, sells as principal or agent | **High** — GIS account holder duties, possible broker/aggregator registration by state, contracts, custody | Spread / commission | **Only with counsel + partner entity** — not v1 |

**Do not build C in-product until a licensed partner path exists.** Prefer partner: Xpansiv Managed Solutions / Evolution-style brokers, or existing verifiers (Crown class) who already monetize.

### 3.3 REC Desk workflow (shape A — build this)

```
1. CLAIM OWNERSHIP
   Per array: who owns RECs? (owner / utility / PPA counterparty / unknown)
   Evidence: interconnection docs, SMART/REG/NM tariff checkbox, user attestation
   Confidence: attested | document | unknown

2. READINESS SCORE
   ☐ nepool_gis_id (or other cert_registry id)
   ☐ fuel_type + nameplate
   ☐ Independent Verifier named (or “NEPOOL Operator pack → Crown”)
   ☐ Utility/program does NOT claim attributes
   ☐ Generation series continuous for target quarter(s)
   ☐ State dual-qualification notes (MA/CT/etc.)

3. MINT PIPELINE (already 80% built)
   AO/NEPOOL generation workbook (GMCS/REC writer) → IV submits → GIS mints
   Surface status: draft pack | sent to IV | expected mint window | minted (manual or CSV import)

4. INVENTORY LEDGER (new tables)
   Per array × vintage quarter: expected_mwh, expected_recs=floor(mwh),
   minted_recs, held, pending_transfer, transferred_out, retired
   Source: owner CSV from GIS export and/or IV confirmation (no live GIS API assumed)

5. SELL INTENT (ask) — not an order book
   Owner posts: vintage, quantity, min $/REC (optional), states dual-qualified,
   preferred settle (broker | bilateral | aggregator)
   Default: private to tenant; optional “visible to AO partner brokers”

6. EXIT PATHS (all human-confirmed)
   a) Intro to partner broker (email packet: inventory + readiness + contact)
   b) Bilateral counterparty the owner already has (checklist only)
   c) Later: structured RFQ to 2–3 pre-vetted brokers

7. TRANSFER CHECKLIST (paper automation)
   - Counterparty GIS account name
   - Certificate serials / vintage batch
   - Initiate transfer in GIS (owner or IV does this — AO does not hold keys)
   - Pending → Accepted
   - Upload confirmation + external payment proof (optional)
   - Ledger: transferred_out += n; close sell intent

8. MONEY
   v0: $ never touches AO
   v1 optional: success fee only when owner marks “transfer accepted + paid”
       with uploaded proof — SaaS facilitation, not escrow
```

### 3.4 What AO must never say/do on RECs

- Promise a firm $/MWh bid from AO
- Auto-initiate GIS transfers without the account holder
- Imply certificates are sold because generation was measured
- Mix **bill-credit $** and **REC $** in one invoice line without extreme clarity
- Appraise FMV of a plant from REC strip alone
- Hold sale proceeds

Copy pattern (same as prospectus):

> Draft tools and checklists based on your generation data. Not a broker-dealer, not an offer to buy RECs, not legal or investment advice. Certificate title moves only in NEPOOL-GIS (or other registry) under your (or your verifier’s) account.

### 3.5 Data model sketch (additive)

```text
RecPosition (tenant_id, array_id)
  ownership: owner | utility | counterparty | unknown
  ownership_note, ownership_evidence_url
  gis_account_holder_name
  independent_verifier
  dual_qual_states: JSON
  readiness_flags: JSON

RecVintageInventory (array_id, year, quarter)
  expected_mwh, expected_recs
  minted_recs, held_recs, pending_recs, transferred_recs, retired_recs
  source: estimated | gis_export | iv_confirm
  updated_at

RecSellIntent (tenant_id, …)
  array_ids or portfolio
  vintage_from, vintage_to
  quantity_recs, floor_price_usd (nullable)
  status: draft | open | intro_sent | transferred | cancelled
  visibility: private | partners

RecTransferEvent
  intent_id, quantity, counterparty_name, gis_ref
  status: initiated | pending | accepted | withdrawn | failed
  proof_urls: JSON
  closed_at
```

Reuse: `Array.nepool_gis_id`, `fuel_type`, `cert_registry`, generation series, GMCS/REC writers, Resources price band (display only).

### 3.6 Unit economics (surface before build)

Illustrative only — measure on real fleets before pricing:

| Fleet | Annual MWh owned-REC | @ $35/REC | AO take if 5% success | Notes |
|-------|----------------------|-----------|----------------------|-------|
| 5 × 500 kW VT community, owner-retained | ~2,500 | ~$87.5k | ~$4.4k/yr | Many VT NM transfer to utility — **filter first** |
| Same, utility-assigned | 0 sellable | $0 | $0 | Desk still valuable as “you already monetized via +$0.03” honesty |
| Bruce-class NEPOOL pilot | filing volume | IV already paid path | SaaS retention | Desk = visibility + sell path later |

**Pricing recommendation:**

1. REC Desk included in AO plan (retention / one-stop), **or**
2. Add-on “Certificate desk” flat $/mo when ownership=owner_retained on ≥1 array
3. Optional success fee only after proof — counsel first; default off

Selling intelligence (settlement audit) remains a **separate venture** (`vt-solar-intel`) — buyers are investors/fleet owners reconciling production vs settled kWh; don’t collapse it into Marketplace v1.

---

## 4. Facilitation roadmap (ranked ROI)

### Phase 0 — Done on staging/preview
Data + docs + honesty disclaimers. Credit Exchange vacancy + waitlist. Array prospectus + share. Hand match. **Promote preview → arrayoperator.com when ready** (today prod 404s `marketplace.js`).

### Phase 1 — Credits close-the-loop (highest ROI on shipped vacancy)
1. Waitlist row → prefilled offtaker draft (name/email/utility/target kWh) → existing offtaker CRUD
2. Match **suggestions** (same utility, kWh fit, expiry) — host click required; never auto-enroll
3. Utility allocation-change PDF/CSV packet from AO offtaker table
4. Expiry nudges → Fleet Triage + EA + digest (“fill this vacancy this month”)
5. Status machine on leads: new → drafted → utility_pending → live → dead

### Phase 1b — Ship REC Desk shell (parallel, low collision)
Register third Marketplace sub `recs` (order 30) in registry; ownership attestation + readiness only (no sell yet). Reuses `nepool_gis_id` / generation writers.

### Phase 2 — Arrays data room
1. Prospectus builder (purpose packs: sale / refi / insurance)
2. SHA-256, redact PII, publish/revoke share links
3. Version when new bills land
4. Interest inbox (intent only)

### Phase 3 — REC Desk v0 (shape A)
1. Per-array REC ownership attestation + readiness checklist
2. Expected RECs from generation (floor MWh) by quarter (reuse reporting lag rules)
3. Manual GIS inventory import (CSV) + ledger
4. Sell-intent draft + broker intro email packet
5. Transfer checklist + proof upload
6. EA skill: “which of my arrays can sell RECs?”

### Phase 4 — Match depth + light economics
- Cross-tenant credit demand board (territory filters, demo guards)
- Partner broker portal (read-only intents)
- Optional success fee after documented placement/transfer
- Multi-array prospectus

### Phase 5 — Only with counsel / partner
- Licensed aggregator integration (API if any)
- Escrow partner for array sale proceeds
- AO-as-GIS-agent (shape C) — separate legal entity likely

---

## 5. Legal automation (same rails as original brief)

### Automate freely
Data rooms, disclosure stamps, access control, offtaker/REC templates reviewed by counsel, utility/GIS checklists, notices, audit trails, e-sign routing, closing checklists.

### Automate only with counsel
Cross-owner matching that looks like brokerage; success fees; valuations; escrow; generating “the contract” as advice; anything that changes utility membership or GIS title without the human account holder.

### REC-specific counsel questions (park for lawyer)
1. Is a success fee on completed GIS transfer + payment proof “brokerage” under VT / other NE states?
2. Can AO display partner broker bids without becoming an agent?
3. Document retention for GIS export / transfer proofs
4. Whether referring exclusively to one aggregator creates fiduciary duties

---

## 6. UX: one-stop without a mess

Ford bar: one coherent direction, one primary action per state, no stacked design languages.

**Marketplace home (fleet rollup):**

```
Your desk                          [this month]
───────────────────────────────────────────────
Credits locked in vacancy    $ / kWh     [Fill →]
Arrays with open data rooms  N           [Build →]
RECs you likely own          N MWh exp.  [Review →]
RECs assigned to utility     N arrays    (info)
Open transfer checklists     N           [Continue →]
```

Each row → one lane. Empty states teach by opening the real tool (vacancy math, ownership form), not feature lectures.

**Energy Agent:** new product_map topics `marketplace`, `recs_desk`; tools later: `vacancy_summary`, `rec_readiness`, `draft_offtaker_from_lead`.

---

## 7. Build slices (when you say go)

### Slice 1 (ship first) — Credits intake
- Backend: vacancy calculation service + WaitlistLead model + APIs
- Frontend: Marketplace tab shell + Credits sub-tab
- Lead → offtaker draft deep-link
- No fees, no cross-tenant

### Slice 2 — REC ownership + readiness
- `RecPosition` + UI on Marketplace/RECs + array drawer field
- Readiness checklist from existing Array fields + generation coverage
- Expected REC calendar (quarter lag aligned with GMCS `default_reporting_reference_date`)
- Resources price band shown as **indicative only** next to inventory

### Slice 3 — Prospectus v0
- PDF from existing analysis/bill/invoice aggregates
- Share token + redact + revoke

### Slice 4 — REC sell intent + broker packet
- Intent CRUD, PDF/email packet, transfer checklist

---

## 8. Success metrics

| Metric | Why |
|--------|-----|
| % arrays with REC ownership ≠ unknown | Desk can’t sell fog |
| Vacancy $ surfaced / $ recovered via new offtakers | Credits lane ROI |
| Prospectus created / link viewed | Capital lane |
| Sell intents → transfer accepted (count) | REC lane; quality > volume |
| Support tickets “where do I sell RECs?” | Deflection via Desk |
| Zero accidental “AO sold my RECs” expectations | Copy + UX honesty |

---

## 9. Bottom line

1. **One-stop** = one Marketplace tab with Credits / Arrays / RECs (/ Services thin), wired into Invoices, Generation reports, Repairs, Resources — not five products.
2. **Credits** remains the fastest money recovery for GNM hosts (vacancy → offtaker → utility paper → invoice).
3. **RECs** are real and separate: AO should run a **Certificate Desk** (ownership → readiness → mint visibility → sell intent → GIS transfer checklist → optional broker intro). NEPOOL-GIS will not be our exchange; brokers and GIS transfers remain the authority layer.
4. **Do not** clear REC trades or hold certificates in v1. Partner or counsel before success fees or aggregator custody.
5. Highest ROI build order: **Credits spine → REC ownership/readiness → prospectus → sell-intent/broker packet**.

---

## 10. Open decisions for Ford

1. Tab label: **Marketplace** vs **Desk** vs **Markets**?
2. REC money: pure SaaS desk first, or design success-fee hooks now (off by default)?
3. First ship slice: Credits vacancy+waitlist, or REC ownership inventory (Bruce already on NEPOOL path)?
4. Broker strategy: warm intro to Crown/existing IV ecosystem vs pursue Xpansiv/aggregator partnership in parallel?
5. Any VT counsel already on retainer for broker/UPL wording on success fees?
