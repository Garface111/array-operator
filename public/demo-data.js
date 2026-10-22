/* ============================================================================
 * Array Operator, anonymous-demo data (demo-data.js)
 *
 * A frozen "big operator" snapshot for signed-out visitors on arrayoperator.com.
 * Designed to feel like a real multi-site VT/NE community-solar book mid-cycle —
 * healthy pipeline, mixed utilities, action in progress, not a sparse 3-offtaker
 * toy or a stack of bounced emails.
 *
 * Scale (Ford 2026-07-14):
 * · 20 arrays · ~200 inverters (fleet simulated separately in fleet-store.js)
 * · 300 offtakers across GMP / VEC / WEC / Eversource / CMP
 * · Pipeline: last cycle mostly delivered · this cycle drafts + auto-send
 * · next run scheduled, frozen "state of action"
 *
 * Loaded BEFORE sandbox.js / reports.js. Those files render this ONLY when there
 * is no session (gated on `!authHeaders() && window.AO_DEMO`); a real signed-in
 * owner never touches any of it.
 * ==========================================================================*/
(function () {
 "use strict";

 // Deterministic PRNG, same seed → same demo every load (stable screenshots).
 function mulberry32(a) {
 return function () {
 a |= 0; a = (a + 0x6D2B79F5) | 0;
 var t = Math.imul(a ^ (a >>> 15), 1 | a);
 t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
 return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
 }
 var rng = mulberry32(0xC0FFEE42);
 var pick = function (arr) { return arr[Math.floor(rng() * arr.length)]; };
 var r2 = function (n) { return Math.round(n * 100) / 100; };

 // ── Operator identity ────────────────────────────────────────────────────
 var account = {
 company_name: "Northeast Community Solar",
 operator_name: "Dana Whitcomb",
 name: "Dana Whitcomb",
 email: "dana@northeastsolar.coop",
 operator_email: "dana@northeastsolar.coop",
 has_password: true,
 on_trial: false,
 trial: false,
 subscription_status: "active",
 status: "active",
 plan_features: {
 plan: "both",
 plan_chosen: true,
 vendor_data: true,
 invoicing: true,
 },
 };

 // ── Calendar (last full month = settled bill period) ─────────────────────
 var now = new Date();
 var pe = new Date(now.getFullYear(), now.getMonth(), 0);
 var ps = new Date(pe.getFullYear(), pe.getMonth(), 1);
 // Local-calendar date (toISOString would shift the day in UTC+ zones).
 var iso = function (d) {
 return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
 };
 // A real send timestamp: early afternoon local time, as UTC ISO. A bare date
 // ("2026-10-01") parses as UTC midnight and shows a day early in US zones.
 var stamp = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 5, 0).toISOString(); };
 var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
 var periodLabel = MON[ps.getMonth()] + " " + ps.getFullYear();
 var nextCharge = new Date(now.getFullYear(), now.getMonth() + 1, 1);
 var periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
 var lastRunAt = new Date(ps.getFullYear(), pe.getMonth(), Math.min(13, pe.getDate()), 14, 30, 0);
 var nextFire = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0);

 var CREDIT_RATE = 0.2576; // VT excess+solcred-ish $/kWh

 // ── 20 arrays (matches fleet-store demo scale) ───────────────────────────
 // nameplate_kw · typical mid-season month kWh · region · primary utility
 var ARRAY_DEFS = [
 { id: 1, name: "Birch Hollow", kw: 99, util: "gmp", region: "south" },
 { id: 2, name: "Kettle Pond", kw: 75, util: "gmp", region: "central" },
 { id: 3, name: "Sawmill Ridge", kw: 62, util: "gmp", region: "north" },
 { id: 4, name: "Heron Flats", kw: 48, util: "gmp", region: "north" },
 { id: 5, name: "Cobble Hill", kw: 55, util: "gmp", region: "central" },
 { id: 6, name: "Maple Run Commons", kw: 40, util: "gmp", region: "south" },
 { id: 7, name: "Fox Meadow", kw: 32, util: "gmp", region: "south" },
 { id: 8, name: "North Branch Ridge", kw: 50, util: "vec", region: "northeast" },
 { id: 9, name: "Granite Notch", kw: 100, util: "gmp", region: "northeast" },
 { id: 10, name: "Old Mill Village", kw: 45, util: "gmp", region: "east" },
 { id: 11, name: "Long Pasture", kw: 38, util: "vec", region: "northeast" },
 { id: 12, name: "Blue Spruce Common", kw: 28, util: "vec", region: "northeast" },
 { id: 13, name: "Riverbend School", kw: 35, util: "gmp", region: "central" },
 { id: 14, name: "Clover Flats", kw: 42, util: "gmp", region: "central" },
 { id: 15, name: "Hilltop Dairy", kw: 60, util: "wec", region: "northwest" },
 { id: 16, name: "Rail Yard", kw: 52, util: "wec", region: "northwest" },
 { id: 17, name: "Ferry Crossing", kw: 70, util: "eversource", region: "nh" },
 { id: 18, name: "Elm Meadows", kw: 44, util: "eversource", region: "nh" },
 { id: 19, name: "Harbor Landing", kw: 80, util: "cmp", region: "me" },
 { id: 20, name: "Pine Commons", kw: 65, util: "cmp", region: "me" },
 ];

 // ~10 inverters × 20 = 200 (fleet-store mirrors this)
 var arrays = ARRAY_DEFS.map(function (a) {
 return {
 id: a.id,
 name: a.name,
 client_name: "Northeast Community Solar",
 nameplate_kw: a.kw,
 region: a.region,
 primary_utility: a.util,
 };
 });

 // Month production ~ nameplate × 4.6 kWh/kW/day × 30 × seasonal factor
 var monthKwh = function (kw) { return Math.round(kw * 4.6 * 30 * 0.92); };

 // ── Utility accounts (one host bill per array + offtaker bills) ──────────
 var PROVIDER_LABEL = {
 gmp: "Green Mountain Power",
 vec: "Vermont Electric Coop",
 wec: "Washington Electric Coop",
 eversource: "Eversource",
 cmp: "Central Maine Power",
 };
 var utilAccts = [];
 var uaId = 9000;
 ARRAY_DEFS.forEach(function (a) {
 uaId++;
 utilAccts.push({
 utility_account_id: uaId,
 id: uaId,
 array_id: a.id,
 provider: a.util,
 nickname: a.name + " · host",
 account_number: String(9900000000 + a.id * 137),
 service_address: a.name + ", VT",
 has_bill: true,
 bill_count: 14,
 latest_period_label: iso(ps).slice(0, 7),
 _host: true,
 });
 });

 // ── 300 offtakers ────────────────────────────────────────────────────────
 var FIRST = [
 "Avery", "Blake", "Cameron", "Dana", "Ellis", "Finley", "Greer", "Harper",
 "Indigo", "Jordan", "Kai", "Logan", "Morgan", "Noel", "Owen", "Parker",
 "Quinn", "Riley", "Sage", "Taylor", "Uma", "Val", "Wes", "Xia", "Yves", "Zion",
 "Ada", "Ben", "Cora", "Drew", "Eva", "Felix", "Gia", "Hugo", "Ivy", "Jules",
 ];
 var LAST = [
 "Ashworth", "Belmont", "Carrington", "Dunbar", "Ellsworth", "Fairchild",
 "Granville", "Hollis", "Iverson", "Jasper", "Kensington", "Llewellyn",
 "Merrick", "Northrop", "Oakley", "Prescott", "Quincy", "Ravenswood",
 "Sterling", "Thatcher", "Underwood", "Voss", "Whitcomb", "Yates", "Zell",
 "Alden", "Bishop", "Caldwell", "Drake", "Everett", "Frost", "Glenn",
 ];
 var ORG = [
 "Town Library", "Elementary School", "Town Garage", "Fire District",
 "Co-op Market", "Senior Housing", "Community Center", "Village Hall",
 "Historical Society", "Food Shelf", "Clinic", "Rec Center",
 "Congregational Church", "Methodist Church", "Grange Hall",
 "Housing Trust", "Watershed Alliance", "Arts Collective",
 "Brewery", "Creamery", "Farm Stand", "Ski Club",
 ];

 // Discounts are FRACTIONS (0.10 = 10%), exactly like the API's
 // resolved_discount_pct; the screens multiply by 100 to display.
 // invoice = kWh × net rate × (1 − discount), as delivery.resolve_discount_pricing.
 function offtaker(id, name, email, kwh, pct, arrayId, utilAcctId, provider, opts) {
 opts = opts || {};
 var disc = opts.discount != null ? opts.discount : 0.10;
 var amount = r2(kwh * CREDIT_RATE * (1 - disc));
 return {
 id: id,
 customer_name: name,
 client_email: email,
 operator_email: account.email,
 enabled: opts.enabled !== false,
 cadence: "monthly",
 billing_model: "percent_of_array",
 delivery_mode: opts.delivery_mode || "auto",
 send_mode: opts.send_mode || "to_client",
 allocation_pct: pct,
 array_id: arrayId,
 array_name: opts.array_name || "",
 utility_account_id: utilAcctId,
 utility_account_name: (PROVIDER_LABEL[provider] || provider) + " · " + (opts.acctNick || name),
 resolved_discount_pct: disc,
 net_rate_per_kwh: CREDIT_RATE,
 formats: ["pdf"],
 cc_emails: "",
 source_filename: null,
 next_send_at: stamp(nextCharge),
 last_sent_at: opts.last_sent_at || null,
 // Healthy last delivery, never "bounced" in the marketing demo.
 last_delivery_status: opts.last_sent_at ? "delivered" : null,
 preview: { amount_owed: amount, customer_kwh: kwh },
 _demo_kwh: kwh,
 _demo_amount: amount,
 _provider: provider,
 };
 }

 // The place each array sits in, used for local organisations' names
 // ("North Branch Grange Hall", not "North Grange Hall").
 var TOWN = {
 1: "Birch Hollow", 2: "Kettle Pond", 3: "Sawmill Ridge", 4: "Heron Flats", 5: "Cobble Hill",
 6: "Maple Run", 7: "Fox Meadow", 8: "North Branch", 9: "Granite Notch", 10: "Old Mill",
 11: "Long Pasture", 12: "Blue Spruce", 13: "Riverbend", 14: "Clover Flats", 15: "Hilltop",
 16: "Brookside", 17: "Ferry Crossing", 18: "Elm Meadows", 19: "Harborview", 20: "Pinewood",
 };
 var offtakers = [];
 var TARGET = 300;
 // Weight offtakers toward larger arrays
 var weights = ARRAY_DEFS.map(function (a) { return a.kw; });
 var wSum = weights.reduce(function (s, w) { return s + w; }, 0);

 for (var i = 0; i < TARGET; i++) {
 // Pick array by weight
 var roll = rng() * wSum;
 var arr = ARRAY_DEFS[0];
 for (var ai = 0; ai < ARRAY_DEFS.length; ai++) {
 roll -= weights[ai];
 if (roll <= 0) { arr = ARRAY_DEFS[ai]; break; }
 }
 var arrMonth = monthKwh(arr.kw);
 // ~15 offtakers average per array at 300/20, shares sum roughly to ~85%
 // with unallocated residual (realistic NEB-ish feel)
 var share = 0.012 + rng() * 0.055; // 1.2%–6.7%
 var kwh = Math.max(40, Math.round(arrMonth * share));
 var isOrg = rng() < 0.38;
 var name, emailLocal;
 if (isOrg) {
 var town = TOWN[arr.id] || arr.name;
 var org = pick(ORG);
 name = town + " " + org;
 emailLocal = (town + "." + org).toLowerCase().replace(/[^a-z0-9.]+/g, ".") + "@example.coop";
 } else {
 var f = pick(FIRST), l = pick(LAST);
 name = f + " " + l;
 emailLocal = (f + "." + l).toLowerCase() + "@example.com";
 }
 // Utility account for offtaker
 uaId++;
 var ua = {
 utility_account_id: uaId,
 id: uaId,
 array_id: arr.id,
 provider: arr.util,
 nickname: name,
 account_number: String(8800000000 + i * 97),
 service_address: name + " · " + arr.name,
 has_bill: true,
 bill_count: 8 + Math.floor(rng() * 10),
 latest_period_label: iso(ps).slice(0, 7),
 };
 utilAccts.push(ua);

 // State of action mix (healthy operator mid-cycle):
 // 62% auto-send, already delivered last cycle
 // 18% auto-send, will fire this cycle (last_sent null → "sending")
 // 15% draft for approval (has draft ready)
 // 5% paused (still in book, not broken)
 var r = rng();
 var mode = "auto", enabled = true, lastSent = null, hasDraft = false;
 if (r < 0.62) {
 mode = "auto";
 lastSent = stamp(new Date(now.getFullYear(), now.getMonth(), 1));
 } else if (r < 0.80) {
 mode = "auto";
 lastSent = null; // in flight this cycle
 } else if (r < 0.95) {
 mode = "draft";
 hasDraft = true;
 lastSent = stamp(new Date(now.getFullYear(), now.getMonth() - 1, 18 + (i % 7))); // approved last cycle (no rng draw: keeps every later draw stable)
 } else {
 mode = "draft";
 enabled = false;
 }

 offtakers.push(offtaker(
 1000 + i,
 name,
 emailLocal,
 kwh,
 Math.round(share * 10000) / 10000,
 arr.id,
 ua.utility_account_id,
 arr.util,
 {
 delivery_mode: mode,
 enabled: enabled,
 last_sent_at: lastSent,
 array_name: arr.name,
 // The account the credits come FROM: the array's host bill, so cards
 // read "receives 3.2% of Green Mountain Power · Heron Flats · host".
 acctNick: arr.name + " · host",
 discount: rng() < 0.15 ? 0 : 0.10,
 _hasDraft: hasDraft,
 }
 ));
 }

 // ── Distinct names ──────────────────────────────────────────────────────
 // Random draws repeat names. Keep exactly ONE person billed on two arrays
 // (a real pattern, and the Mail room review's "same customer on two arrays"
 // catch); every other repeat gets a middle initial (people) or a building
 // name (an organisation's second meter on the same array).
 var seenName = {}, keptCrossArray = false;
 var INITIALS = "ABCDEFGHJKLMNPRSTW", BLDG = ["Annex", "North Building", "Barn", "Office", "Garage"];
 offtakers.forEach(function (o, idx) {
 var key = o.customer_name;
 var first = seenName[key];
 if (!first) { seenName[key] = o; return; }
 var person = /@example\.com$/.test(o.client_email);
 if (person && !keptCrossArray && first.array_id !== o.array_id) {
 o.client_email = first.client_email; // same household, two shares
 keptCrossArray = true;
 return;
 }
 if (person) {
 var parts = o.customer_name.split(" ");
 var ini = INITIALS.charAt(idx % INITIALS.length);
 o.customer_name = parts[0] + " " + ini + ". " + parts.slice(1).join(" ");
 o.client_email = (parts[0] + "." + ini + "." + parts.slice(1).join(".")).toLowerCase() + "@example.com";
 } else {
 o.customer_name = o.customer_name + " (" + BLDG[idx % BLDG.length] + ")";
 }
 seenName[o.customer_name] = o;
 utilAccts.forEach(function (ua) {
 if (ua.utility_account_id === o.utility_account_id) {
 ua.nickname = o.customer_name;
 ua.service_address = o.customer_name + " · " + (o.array_name || "");
 }
 });
 });

 // ── Allocation tie-out ──────────────────────────────────────────────────
 // Each array's offtaker shares sum to a realistic 86–97% (never over 100%),
 // and each offtaker's kWh is their share of the array's LAST SETTLED MONTH from
 // the shared history (demo-api.js monthlyFor), so Statements, the Mail room,
 // Analysis and the Credit Exchange all agree on the same kWh and dollars.
 // Two arrays keep real vacancy on purpose: that is the Credit Exchange story.
 var LAST_KWH = {};
 ARRAY_DEFS.forEach(function (a) {
 var h = null;
 try { h = window.AO_DEMO_API && window.AO_DEMO_API.monthlyFor({ id: a.id, nameplate_kw: a.kw }, 1); } catch (e) {}
 LAST_KWH[a.id] = h && h.length ? h[0].kwh : monthKwh(a.kw);
 });
 var VACANCY_STORY = { 4: 0.74, 13: 0.80 }; // Heron Flats, Riverbend School
 var allocRng = mulberry32(0xA110CA7E);
 ARRAY_DEFS.forEach(function (a) {
 var mine = offtakers.filter(function (o) { return o.array_id === a.id; });
 var sum = mine.reduce(function (t, o) { return t + o.allocation_pct; }, 0);
 if (!sum) return;
 var target = VACANCY_STORY[a.id] || (0.86 + allocRng() * 0.11);
 mine.forEach(function (o) {
 var share = Math.round(o.allocation_pct * target / sum * 10000) / 10000;
 var kwh = Math.max(1, Math.round(LAST_KWH[a.id] * share));
 var amount = r2(kwh * CREDIT_RATE * (1 - o.resolved_discount_pct));
 o.allocation_pct = share;
 o._demo_kwh = kwh;
 o._demo_amount = amount;
 o.preview = { amount_owed: amount, customer_kwh: kwh };
 });
 });

 // ── Drafts (ready to review, frozen mid-action, no bounces) ─────────────
 function draft(id, sub) {
 return {
 id: id,
 subscription_id: null,
 customer_name: sub.customer_name,
 client_email: sub.client_email,
 operator_name: account.operator_name,
 period_label: periodLabel,
 array_total_kwh: LAST_KWH[sub.array_id] || monthKwh(50),
 customer_kwh: sub._demo_kwh,
 allocation_pct: sub.allocation_pct,
 amount_usd: sub._demo_amount,
 net_rate_per_kwh: CREDIT_RATE,
 discount_pct: sub.resolved_discount_pct,
 cadence: "monthly",
 send_mode: sub.send_mode,
 invoice_number: "NCS-" + ps.getFullYear() + String(ps.getMonth() + 1).padStart(2, "0") + "-" + id,
 auto_attach_gmp: true,
 gmp_auto_status: "ready",
 has_gmp_pdf: true,
 gmp_filename: "utility_bill_" + iso(ps) + ".pdf",
 include_summary: false,
 has_workbook: false,
 note: "",
 attach_provider: sub._provider || "gmp",
 _demo: true,
 };
 }

 var drafts = [];
 var draftId = 20000;
 offtakers.forEach(function (s) {
 // Drafts for approval-mode offtakers + a slice of auto that still need a look
 if (s.delivery_mode === "draft" && s.enabled) {
 drafts.push(draft(++draftId, s));
 } else if (s.delivery_mode === "auto" && !s.last_sent_at && rng() < 0.12) {
 // A few auto offtakers still show as "ready" this cycle (fresh bills just landed)
 drafts.push(draft(++draftId, s));
 }
 });
 // Cap drafts so the inbox feels active but not overwhelming (~24–40)
 if (drafts.length > 36) drafts = drafts.slice(0, 36);

 // ── Billing (AO fees) ─────────────────────────────────────────────────────
 // Same shape /v1/account/billing-summary returns, and the `unified` block is
 // the REAL pricing code's output for this operator (pricing_ao_unified
 // .build_unified_bill at 1,135 kW nameplate + 300 offtakers, generated
 // 2026-10-22), so the sample bill shows exactly what this fleet would pay.
 // Regenerate it if pricing_ao_nameplate / pricing_ao_invoicing change.
 var TOTAL_NAMEPLATE = ARRAY_DEFS.reduce(function (s, a) { return s + a.kw; }, 0);
 var MTD_KWH = Math.round(TOTAL_NAMEPLATE * 4.6 * Math.max(1, now.getDate() - 1));
 var UNIFIED = {"plan": "regular", "plan_label": "Regular", "lines": [{"id": "monitoring", "kind": "Fleet monitoring", "basis": "nameplate_kw", "quantity": 1135.0, "unit_label": "kW", "unit_cents": 14.822, "full_unit_cents": 15.0, "amount_cents": 16822.5, "billed": true, "included_in_monthly_total": true, "desc": "Live fleet health — billed on registered inverter nameplate (kW). Volume discounts apply automatically for large fleets."}, {"id": "invoicing", "kind": "Offtaker invoices", "basis": "offtaker_count", "quantity": 300, "unit_label": "offtakers", "unit_cents": 1092.5, "full_unit_cents": 1500.0, "amount_cents": 327750.0, "billed": true, "included_in_monthly_total": true, "desc": "$15 per offtaker / month for every active offtaker on your roster (volume discounts as you grow)."}, {"id": "generation_reports", "kind": "Generation reports", "basis": "array_quarters", "quantity": 0, "unit_label": "arrays reported", "unit_cents": 1500.0, "full_unit_cents": 1500.0, "amount_cents": 0.0, "billed": false, "included_in_monthly_total": false, "metered": true, "desc": "$15 per array, once per quarter — charged the first time you report an array (send its report or download the workbook), then unlimited that quarter. Building and previewing are free."}, {"id": "ai_pro", "kind": "Energy Agent Pro", "basis": "flat", "quantity": 0, "unit_label": "month", "unit_cents": 5000.0, "full_unit_cents": 5000.0, "amount_cents": 0.0, "included": false, "billed": false, "included_in_monthly_total": false, "desc": "Unlimited integrated AI (thinking + voice). Without Pro you get a $2.50/week sample."}, {"id": "collection_fee", "kind": "Online offtaker payments", "basis": "percent_of_collected", "quantity": 0, "unit_label": "0.5% of online payments", "unit_cents": 0, "full_unit_cents": 0, "amount_cents": null, "billed": false, "included_in_monthly_total": false, "fee_bps": 50, "fee_percent": 0.5, "desc": "When an offtaker pays an invoice online (card/bank via Stripe), we keep 0.5% of that payment as a platform fee. The rest goes to you. Check and offline payments: no fee. This is not part of your monthly bill above."}], "total_cents": 344572.5, "ai": {"pro": false, "monthly_usd": 50.0, "free_weekly_usd": 2.5, "stripe_price_ready": false}, "collection_fee": {"id": "collection_fee", "kind": "Online offtaker payments", "basis": "percent_of_collected", "fee_bps": 50, "fee_percent": 0.5, "amount_cents": null, "included_in_monthly_total": false, "desc": "When an offtaker pays an invoice online (card/bank via Stripe), we keep 0.5% of that payment as a platform fee. The rest goes to you. Check and offline payments: no fee. This is not part of your monthly bill above."}, "model_note": "Regular plan: fleet monitoring (kW nameplate) + offtaker invoices ($15/offtaker). Generation reports are $15 per array, once per quarter — only for arrays you actually report; building and previewing are free. Energy Agent Pro is $50/mo unlimited AI (free tier keeps a $2.50/week sample). When offtakers pay online we keep 0.5% of that payment — not part of the monthly total."};
 var lineCents = function (id) {
 for (var i = 0; i < UNIFIED.lines.length; i++) if (UNIFIED.lines[i].id === id) return UNIFIED.lines[i].amount_cents;
 return 0;
 };
 var billingSummary = {
 billing_basis: "regular",
 currency: "usd",
 has_payment_method: true,
 card_brand: "visa",
 card_last4: "4242",
 monitoring_basis: "nameplate",
 nameplate_kw: TOTAL_NAMEPLATE,
 rate_cents_per_kw: 14.8216,
 full_rate_cents_per_kw: 15.0,
 billable_arrays: ARRAY_DEFS.length,
 mtd_kwh: MTD_KWH,
 period_start: iso(periodStart),
 monitoring_total_cents: lineCents("monitoring"),
 offtaker_count: offtakers.length,
 invoicing_base_cents: 0,
 invoicing_base_includes: 0,
 invoicing_per_offtaker_cents: 1500,
 invoicing_blended_cents_per_offtaker: 1092.5,
 invoicing_setup_cents: 25000,
 invoicing_total_cents: lineCents("invoicing"),
 generation_reports_price_cents: 1500,
 generation_reports_charges_period: 0,
 generation_reports_total_cents: 0,
 total_cents: UNIFIED.total_cents,
 unified: UNIFIED,
 ai_pro: false,
 subscription_status: "active",
 };
 var nextInvoice = { amount_cents: Math.round(UNIFIED.total_cents), currency: "usd", period_end: iso(nextCharge) };

 // ── Files (account tab) ──────────────────────────────────────────────────
 var files = [
 { name: "gmp_bill_" + iso(ps) + ".pdf", kind: "gmp_bill", role: "GMP utility bill · " + periodLabel,
 uploaded_at: iso(pe), size: 184320 },
 { name: "vec_bill_" + iso(ps) + ".pdf", kind: "utility_bill", role: "VEC utility bill · " + periodLabel,
 uploaded_at: iso(pe), size: 156000 },
 { name: "northeast_invoice_template.xlsx", kind: "template", role: "Your invoice template",
 uploaded_at: iso(ps), size: 28160 },
 { name: "billing_workbook_2026.xlsx", kind: "workbook", role: "Billing workbook",
 uploaded_at: iso(ps), size: 128000 },
 { name: "neb_allocation_" + iso(ps).slice(0, 7) + ".xlsx", kind: "workbook", role: "NEB allocation export",
 uploaded_at: iso(pe), size: 96000 },
 ];

 // ── Send pipeline snapshot (frozen mid-cycle action) ─────────────────────
 var nAuto = offtakers.filter(function (s) { return s.delivery_mode === "auto" && s.enabled; }).length;
 var nDraftMode = offtakers.filter(function (s) { return s.delivery_mode === "draft" && s.enabled; }).length;
 var nSentLast = offtakers.filter(function (s) { return !!s.last_sent_at; }).length;
 var pipeline = {
 ok: true,
 paused: false,
 default_delivery_mode: "auto",
 mode_split: { auto: nAuto, approval: nDraftMode },
 last: {
 period_month: ps.getMonth() + 1,
 period_end: iso(pe),
 last_run_at: lastRunAt.toISOString(),
 delivered: Math.min(nSentLast, offtakers.length - 12),
 dollars: r2(Math.min(nSentLast, offtakers.length - 12) * 180),
 },
 next_monthly: {
 fires_at: nextFire.toISOString(),
 scheduled: offtakers.filter(function (s) { return s.enabled; }).length,
 auto: nAuto,
 approval: drafts.length,
 },
 next_quarterly: { scheduled: 0, auto: 0, approval: 0 },
 inflight: {
 sending: offtakers.filter(function (s) { return s.delivery_mode === "auto" && s.enabled && !s.last_sent_at; }).length,
 ready: drafts.length,
 },
 total_enabled: offtakers.filter(function (s) { return s.enabled; }).length,
 };

 window.AO_DEMO = {
 account: account,
 billingSummary: billingSummary,
 nextInvoice: nextInvoice,
 offtakers: offtakers,
 drafts: drafts,
 files: files,
 arrays: arrays,
 utilAccounts: utilAccts,
 pipeline: pipeline,
 creditRate: CREDIT_RATE,
 periodLabel: periodLabel,
 meta: {
 arrays: arrays.length,
 offtakers: offtakers.length,
 inverters_target: 200,
 nameplate_kw: TOTAL_NAMEPLATE,
 tagline: "20 sites · 200 inverters · 300 offtakers, frozen mid-cycle",
 },
 };
})();
