/* ============================================================================
 * Sample account · Marketplace routes (demo/market.js)
 *
 * Loaded only for signed-out visitors by demo-api.js. Answers the reads behind
 * the three Marketplace sub-tabs with the sample operator's data, shaped
 * EXACTLY like the backend so marketplace.js / rec-desk.js / prospectus.js run
 * their normal signed-in render path:
 *
 *   Credit Exchange  GET /v1/array-operator/billing/vacancy        (market_vacancy.tenant_vacancy)
 *                    GET /v1/array-operator/billing/exchange/demand      (lead_dict rows)
 *                    GET /v1/array-operator/billing/exchange/suggestions (exchange_match.suggest_pairings)
 *   RECs             GET /v1/array-owners/rec-desk                   (rec_desk.tenant_rec_desk)
 *   Array Market     GET /v1/array-owners/prospectuses               (prospectus_routes list)
 *                    GET /v1/array-owners/prospectus/{id}            (stored payload + shares)
 *                    GET /v1/array-owners/prospectus/{id}/document   (PDF / HTML render)
 *                    GET /v1/prospectus/{token}                      (public share view)
 *
 * Every number ties out with the rest of the sample: arrays + kW from
 * AO_DEMO.arrays, generation from AO_DEMO_API.monthly(id), offtaker shares
 * and invoice amounts from AO_DEMO.offtakers, credits priced at
 * AO_DEMO.creditRate, RECs = floor(MWh) per vintage quarter. Writes (add a
 * lead, draft an offtaker, save REC position, build/share a prospectus) are
 * NOT registered, so they get demo-api's read-only 403 + the shared nudge.
 * ==========================================================================*/
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  function A() { return window.AO_DEMO || {}; }
  function rate() { return Number(A().creditRate) || 0.2576; }
  function num(n) { return Number(n) || 0; }
  function r1(n) { return D.round(n, 1); }
  function r2(n) { return D.round(n, 2); }
  function r4(n) { return D.round(n, 4); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function monthEnd(y, m0) { return new Date(y, m0 + 1, 0); }
  function dayMs(d) { return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function today() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function fmt0(n) { return Math.round(num(n)).toLocaleString("en-US"); }

  var PROVIDER_LABEL = {
    gmp: "Green Mountain Power", vec: "Vermont Electric Coop", wec: "Washington Electric Coop",
    eversource: "Eversource", cmp: "Central Maine Power",
  };

  function offtakersFor(id) {
    id = Number(id);
    return (A().offtakers || []).filter(function (o) { return Number(o.array_id) === id; });
  }
  function hostAccount(id) {
    id = Number(id);
    var ua = A().utilAccounts || [];
    for (var i = 0; i < ua.length; i++) if (ua[i]._host && Number(ua[i].array_id) === id) return ua[i];
    return null;
  }
  function accountsFor(id) {
    id = Number(id);
    return (A().utilAccounts || []).filter(function (u) { return Number(u.array_id) === id; });
  }

  /* ── Credit Exchange: vacancy ─────────────────────────────────────────────
   * market_vacancy.array_vacancy, run on the sample's host bills. Each host
   * bill's pool = that month's generation (community arrays export it all);
   * the retained (unallocated) slice tracks 1 − Σ enabled offtaker shares, so
   * bill-side and registry-side agree ("high") except on Long Pasture, where
   * the bill shows less vacancy than the entered shares (members billed outside
   * AO → "medium", the backend's own reconciliation note). */
  var VACANCY_WINDOW_MONTHS = 12;
  var CREDIT_LIFETIME_MONTHS = 12;
  var EXPIRY_WARN_MONTHS = 2;
  var CONFIDENCE_TOL_FRAC = 0.05;
  // Hosts that BANK retained excess instead of cashing it, so their oldest
  // banked months are approaching the ~12-month cliff.
  var BANKS = { 4: true, 12: true, 16: true };
  // Points of vacancy the host bill shows BELOW the registry (members outside AO).
  var OUTSIDE_MEMBERS = { 11: 0.17 };

  function registryAllocated(id) {
    var subs = offtakersFor(id).filter(function (o) { return o.enabled !== false; });
    if (!subs.length) return null;
    var t = 0;
    subs.forEach(function (s) { t += num(s.array_share_pct != null ? s.array_share_pct : s.allocation_pct); });
    return t;
  }

  var _vac = null;
  function vacancy() {
    if (_vac) return _vac;
    var now = today();
    var rows = D.sites().map(function (s) {
      var id = Number(s.id);
      var host = hostAccount(id);
      var regAlloc = registryAllocated(id);
      var regVac = regAlloc == null ? null : Math.max(0, 1 - regAlloc);
      var base = {
        array_id: id,
        array_name: s.name,
        host_account_id: host ? host.utility_account_id : null,
        provider: host ? host.provider : (s.primary_utility || null),
        vacancy_kwh: 0.0, vacancy_usd: 0.0, pool_kwh: 0.0, vacancy_frac: null,
        registry_allocated_frac: regAlloc == null ? null : r4(regAlloc),
        registry_vacancy_frac: regVac == null ? null : r4(regVac),
        months_of_history: 0, confidence: "none", confidence_note: "", credit_rate: null,
        expiring_soon_kwh: 0.0, expiring_soon_usd: 0.0, expiring_soon_months: null,
      };
      var months = D.monthly(id, 24).slice(-VACANCY_WINDOW_MONTHS);
      var rng = D.rng("vacancy:" + id);
      var drift = OUTSIDE_MEMBERS[id] || 0;
      var pool = 0, retained = 0, value = 0, expK = 0, expU = 0, expM = null, cr = rate();
      months.forEach(function (m) {
        var p = num(m.kwh);
        var frac = regVac == null ? 0 : (regVac <= 0 ? 0 : regVac - drift + (rng() - 0.5) * 0.03);
        frac = Math.max(0, Math.min(1, frac));
        var ret = p * frac;
        pool += p; retained += ret; value += ret * cr;
        if (BANKS[id] && ret > 0) {
          var ped = monthEnd(m.year, m.month_num - 1);
          var left = CREDIT_LIFETIME_MONTHS - daysBetween(ped, now) / 30.44;
          if (left <= EXPIRY_WARN_MONTHS) {
            expK += ret; expU += ret * cr;
            var mm = Math.max(0, left);
            expM = expM == null ? mm : Math.min(expM, mm);
          }
        }
      });
      base.pool_kwh = r1(pool);
      base.vacancy_kwh = r1(retained);
      base.vacancy_usd = r2(value);
      base.months_of_history = months.length;
      base.credit_rate = D.round(cr, 5);
      base.expiring_soon_kwh = r1(expK);
      base.expiring_soon_usd = r2(expU);
      base.expiring_soon_months = expM == null ? null : r1(expM);
      var billVac = pool > 0 ? retained / pool : null;
      base.vacancy_frac = billVac == null ? null : r4(billVac);
      if (billVac == null) {
        base.confidence = "none";
        base.confidence_note = "No usable host-bill excess to measure.";
      } else if (regVac == null) {
        base.confidence = "medium";
        base.confidence_note = "Measured from the host bill. No offtaker shares are entered in AO for " +
          "this array yet, so we can't corroborate against your billing setup — " +
          "add members to raise confidence.";
      } else if (Math.abs(billVac - regVac) <= CONFIDENCE_TOL_FRAC) {
        base.confidence = "high";
        base.confidence_note = "The host bill and your entered offtaker shares agree on this vacancy.";
      } else {
        base.confidence = "medium";
        base.confidence_note = "The host bill shows ~" + Math.round(billVac * 100) + "% unallocated but your entered " +
          "shares imply ~" + Math.round(regVac * 100) + "% — likely group members billed outside " +
          "AO. Complete membership setup to reconcile (see the Bill audit tab).";
      }
      return base;
    });
    rows.sort(function (a, b) { return (b.vacancy_usd || 0) - (a.vacancy_usd || 0); });
    function tot(k, dp) { var t = 0; rows.forEach(function (r) { t += num(r[k]); }); return D.round(t, dp); }
    _vac = {
      arrays: rows,
      totals: {
        vacancy_kwh: tot("vacancy_kwh", 1),
        vacancy_usd: tot("vacancy_usd", 2),
        expiring_soon_kwh: tot("expiring_soon_kwh", 1),
        expiring_soon_usd: tot("expiring_soon_usd", 2),
        array_count: rows.length,
      },
      window_months: VACANCY_WINDOW_MONTHS,
      generated_at: new Date().toISOString(),
    };
    return _vac;
  }

  /* ── Credit Exchange: waitlist leads ──────────────────────────────────────
   * Fictional local buyers. Two older leads are ones the operator already
   * drafted: they link to real sample offtakers (same name, utility, array). */
  function parseDesiredKwhMo(band) {   // exchange_match.parse_desired_kwh_mo
    if (!band) return null;
    var s = String(band).trim().toLowerCase().replace(/,/g, "");
    if (!s) return null;
    var m = s.match(/(\d+(?:\.\d+)?)\s*(mwh|mw\.?h)?/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    var unit = (m[2] || "").replace(/\./g, "");
    if (unit.indexOf("mwh") === 0) n *= 1000;
    if (n <= 0 || n > 500000) return null;
    return r1(n);
  }

  var LEAD_SEED = [
    { id: 318, ago: 2, name: "Wren & Ladle Bakery", email: "orders@wrenandladle.example.com", phone: "(802) 555-0143",
      utility: "gmp", band: "~1,800 kWh/mo", bill: 412, status: "new",
      notes: "Walked in after seeing the Heron Flats array sign. Ovens run 5am to 1pm; wants credits locked in before winter." },
    { id: 317, ago: 5, name: "Cobble Hill Town Offices", email: "townclerk@cobblehill.example.org", phone: "(802) 555-0178",
      utility: "gmp", band: "3,500 kWh/mo", bill: 905, status: "suggested",
      notes: "Selectboard voted to source municipal power locally. Needs a signed allocation letter before budget season." },
    { id: 316, ago: 9, name: "Marisol & Theo Brandt", email: "brandt.household@example.com", phone: null,
      utility: "gmp", band: "~650 kWh/mo", bill: 168, status: "new",
      notes: "Heat-pump household, referred by a current offtaker." },
    { id: 315, ago: 13, name: "North Branch Grange Hall", email: "treasurer@nbgrange.example.org", phone: "(802) 555-0119",
      utility: "vec", band: "~900 kWh/mo", bill: 231, status: "new",
      notes: "Hall rental income covers the bill; the board wants a fixed discount." },
    { id: 314, ago: 18, name: "Spruce Hollow Sugarworks", email: "sap@sprucehollow.example.com", phone: "(802) 555-0162",
      utility: "vec", band: "1.2 MWh/mo", bill: 342, status: "suggested",
      notes: "Evaporator and RO run Feb to April; a flat annual allocation is fine." },
    { id: 313, ago: 24, name: "Ridgeline Brewing Co.", email: "ops@ridgelinebrewing.example.com", phone: "(802) 555-0187",
      utility: "wec", band: "~2,200 kWh/mo", bill: 560, status: "new",
      notes: "Glycol chillers run year-round. Asked about a two-year term." },
    { id: 312, ago: 31, name: "Ferry Crossing Family Dental", email: "office@fcdental.example.com", phone: "(603) 555-0131",
      utility: "eversource", band: "1,100 kWh/mo", bill: 288, status: "new",
      notes: "Two-chair practice; their landlord already signed on with another array." },
    { id: 311, ago: 38, name: "Tidewater Co-op Grocery", email: "gm@tidewatercoop.example.org", phone: "(207) 555-0150",
      utility: "cmp", band: "~4,000 kWh/mo", bill: 1180, status: "new",
      notes: "Refrigeration-heavy. Would split across two arrays if one can't cover it." },
    // 310 and 309 are filled from real sample offtakers below.
    { id: 308, ago: 75, name: "Lakeview Motor Inn", email: "frontdesk@lakeviewinn.example.com", phone: "(802) 555-0104",
      utility: "gmp", band: "~2,500 kWh/mo", bill: 640, status: "dead",
      notes: "Signed with a different community-solar provider." },
    { id: 307, ago: 80, name: "Jonah Whitley", email: "jonah.whitley@example.com", phone: null,
      utility: null, band: null, bill: 120, status: "new",
      notes: "Emailed through the website; hasn't confirmed which utility serves him yet." },
  ];

  function isOrg(o) { return / (Library|School|Garage|District|Market|Housing|Center|Hall|Society|Shelf|Clinic|Church|Trust|Alliance|Collective|Brewery|Creamery|Stand|Club)$/.test(o.customer_name || ""); }
  function leadFromOfftaker(id, ago, o, status, notes) {
    return {
      id: id, ago: ago, name: o.customer_name, email: o.client_email, phone: null,
      utility: o._provider || null,
      band: "~" + fmt0(o._demo_kwh) + " kWh/mo",
      bill: Math.round(num(o._demo_kwh) * 0.21),
      status: status, notes: notes,
      suggested_array_id: o.array_id, linked_subscription_id: o.id,
    };
  }

  var _leads = null;
  function leadRows() {
    if (_leads) return _leads;
    var offs = A().offtakers || [];
    var pending = null, live = null, liveAny = null;
    for (var i = 0; i < offs.length; i++) {
      var o = offs[i];
      if (!pending && o.enabled === false && isOrg(o)) pending = o;
      if (o.enabled !== false && o.last_sent_at && isOrg(o)) {
        if (!liveAny) liveAny = o;
        if (!live && o._provider === "vec") live = o;
      }
    }
    live = live || liveAny;
    var seed = LEAD_SEED.slice();
    if (live) seed.push(leadFromOfftaker(309, 62, live, "live",
      "Came off the waitlist; on the group roster and invoiced since."));
    if (pending) seed.push(leadFromOfftaker(310, 46, pending, "utility_pending",
      "Drafted from the waitlist. Allocation change filed with " +
      (PROVIDER_LABEL[pending._provider] || "the utility") + "; billing starts once it posts."));
    _leads = seed.map(function (l) {
      return {
        id: l.id,
        contact_name: l.name,
        contact_email: l.email,
        contact_phone: l.phone,
        utility: l.utility,
        desired_band: l.band,
        desired_kwh_mo: parseDesiredKwhMo(l.band),
        monthly_bill_usd: l.bill,
        source: "operator_waitlist",
        status: l.status,
        notes: l.notes,
        suggested_array_id: l.suggested_array_id || null,
        linked_subscription_id: l.linked_subscription_id || null,
        created_at: D.daysAgo(l.ago, 9 + (l.id % 8), (l.id * 7) % 60).toISOString(),
      };
    }).sort(function (a, b) { return b.id - a.id; });   // newest first, like the backend
    return _leads;
  }

  // exchange_match.suggest_pairings, verbatim logic.
  function suggestPairings(vacs, leads, maxPerLead) {
    maxPerLead = maxPerLead || 3;
    var out = [];
    vacs = vacs.filter(function (v) {
      return num(v.vacancy_frac) > 0.02 || num(v.vacancy_kwh) > 0 || num(v.expiring_soon_kwh) > 0;
    });
    if (!vacs.length || !leads.length) return out;
    leads.forEach(function (lead) {
      var status = String(lead.status || "new").toLowerCase();
      if (["dead", "live", "drafted", "utility_pending"].indexOf(status) >= 0) return;
      var leadUtil = String(lead.utility || "").trim().toLowerCase();
      var desired = parseDesiredKwhMo(lead.desired_band);
      var scored = [];
      vacs.forEach(function (v) {
        var vUtil = String(v.provider || "").trim().toLowerCase();
        if (leadUtil && vUtil && leadUtil !== vUtil) return;
        if (leadUtil && !vUtil) return;
        var score = 0, reasons = [];
        if (leadUtil && vUtil && leadUtil === vUtil) { score += 50; reasons.push("same utility (" + vUtil.toUpperCase() + ")"); }
        else if (!leadUtil) { score += 10; reasons.push("lead has no utility — confirm territory"); }
        var frac = num(v.vacancy_frac);
        score += Math.min(25, frac * 40);
        var usd = num(v.vacancy_usd);
        if (usd > 0) score += Math.min(15, usd / 500);
        if (num(v.expiring_soon_kwh) > 0) { score += 20; reasons.push("credits approaching expiry"); }
        var pool = num(v.pool_kwh), vacKwh = num(v.vacancy_kwh);
        var vacMo = vacKwh ? vacKwh / 12 : 0;
        var alloc = null;
        if (desired && pool > 0) {
          alloc = r4(Math.min(0.95, Math.max(0.01, desired * 12 / pool)));
          if (vacMo > 0) {
            var ratio = desired / vacMo;
            if (ratio >= 0.4 && ratio <= 1.25) { score += 20; reasons.push("size fits vacancy"); }
            else if (ratio < 0.4) { score += 8; reasons.push("smaller than vacancy (easy fit)"); }
            else { score += 2; reasons.push("wants more than measured vacancy — split or waitlist"); }
          }
          reasons.push("suggested share ≈ " + (alloc * 100).toFixed(1) + "% of pool");
        } else if (frac > 0) {
          alloc = r4(Math.min(0.5, Math.max(0.05, frac * 0.5)));
          reasons.push("suggested share ≈ " + (alloc * 100).toFixed(1) + "% (half of measured vacancy)");
        }
        if (score <= 0) return;
        scored.push({ score: score, row: {
          lead_id: lead.id, lead_name: lead.contact_name, lead_email: lead.contact_email,
          lead_utility: lead.utility, lead_desired_band: lead.desired_band, desired_kwh_mo: desired,
          array_id: v.array_id, array_name: v.array_name, provider: v.provider,
          vacancy_frac: v.vacancy_frac, vacancy_kwh: v.vacancy_kwh, vacancy_usd: v.vacancy_usd,
          expiring_soon_kwh: v.expiring_soon_kwh, expiring_soon_usd: v.expiring_soon_usd,
          confidence: v.confidence, suggested_allocation_pct: alloc,
          score: r2(score), reasons: reasons,
        } });
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      scored.slice(0, maxPerLead).forEach(function (x) { out.push(x.row); });
    });
    out.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return out;
  }

  /* ── RECs: certificate desk (rec_desk.tenant_rec_desk) ────────────────────
   * Per-array REC position. VT net-metering arrays mostly transfer RECs to the
   * utility for the REC adjustor; a few grandfathered VT groups and the NH/ME
   * arrays retain them for the New England certificate market. */
  var VERIFIER_VT = "Kestrel REC Services";
  var VERIFIER_ME = "Tidewater Certificate Partners";
  var REC_POS = {
    1:  { own: "owner_retained", gis: true, ver: VERIFIER_VT, note: "Pre-2017 group system; RECs retained per the original application." },
    2:  { own: "owner_retained", gis: true, ver: VERIFIER_VT },
    3:  { own: "assigned_to_utility", gis: true, note: "Transferred to the utility at enrollment for the REC adjustor." },
    4:  { own: "unknown" },
    5:  { own: "assigned_to_utility", gis: true, note: "Transferred to the utility at enrollment for the REC adjustor." },
    6:  { own: "assigned_to_utility", note: "Transferred to the utility at enrollment for the REC adjustor." },
    7:  { own: "assigned_to_utility", note: "Transferred to the utility at enrollment for the REC adjustor." },
    8:  { own: "owner_retained", ver: VERIFIER_VT, note: "GIS asset registration in progress." },
    9:  { own: "owner_retained", gis: true, ver: VERIFIER_VT },
    10: { own: "unknown" },
    11: { own: "assigned_to_utility", gis: true, note: "Co-op program owns attributes under the group tariff." },
    12: { own: "assigned_to_utility", note: "Co-op program owns attributes under the group tariff." },
    13: { own: "counterparty", gis: true, note: "School district PPA: environmental attributes convey to the offtaker." },
    14: { own: "owner_retained", note: "GIS registration submitted; awaiting the asset ID." },
    15: { own: "assigned_to_utility", gis: true, note: "Co-op program owns attributes under the group tariff." },
    16: { own: "unknown", gis: true },
    17: { own: "owner_retained", gis: true, ver: VERIFIER_VT, note: "NH Class II (solar) eligible." },
    18: { own: "owner_retained", gis: true, ver: VERIFIER_VT, note: "NH Class II (solar) eligible." },
    19: { own: "owner_retained", gis: true, ver: VERIFIER_ME, note: "Maine Class I eligible." },
    20: { own: "owner_retained", gis: true, note: "Maine Class I eligible." },
  };
  // Fictional NEPOOL-GIS style unit ids ("NON" = a non-ISO-settled generator).
  function gisId(id) {
    var p = REC_POS[id];
    if (!p || !p.gis) return null;
    return "NON" + (41000 + (D.hashStr("gis:" + id) % 18000));
  }

  // writers.gmcs_writer.default_reporting_reference_date + _rolling_quarters:
  // the newest vintage is the quarter NEPOOL-GIS is minting now (two before the
  // in-progress quarter), oldest first.
  function mintWindow(count) {
    var t = new Date();
    var y = t.getFullYear(), q = Math.floor(t.getMonth() / 3) + 1;
    for (var i = 0; i < 2; i++) { q--; if (q === 0) { y--; q = 4; } }
    var out = [];
    for (var k = 0; k < count; k++) { out.push([y, q]); q--; if (q === 0) { y--; q = 4; } }
    return out.reverse();
  }

  function expectedVintages(id) {
    var hist = D.monthly(id, 24);
    return mintWindow(6).map(function (yq) {
      var y = yq[0], q = yq[1], kwh = 0, months = 0;
      hist.forEach(function (m) {
        if (m.year === y && Math.floor((m.month_num - 1) / 3) + 1 === q) { kwh += num(m.kwh); months++; }
      });
      var days = months ? daysBetween(new Date(y, (q - 1) * 3, 1), new Date(y, q * 3, 1)) : 0;
      var mwh = kwh / 1000;
      return {
        year: y, quarter: q, label: "Q" + q + " " + y,
        kwh: r1(kwh), mwh: D.round(mwh, 3), expected_recs: Math.floor(mwh),
        day_count: days, source: "daily_generation_floor",
        note: "Expected from metered kWh (floor MWh). Not proof of GIS mint.",
      };
    });
  }

  function arrayReadiness(s) {   // rec_desk.array_readiness
    var id = Number(s.id), p = REC_POS[id] || { own: "unknown" };
    var ownership = p.own, gis = gisId(id), fuel = "solar", registry = "NEPOOL-GIS";
    var verifier = p.ver || null, note = p.note || null;
    var checks = [];
    function add(key, ok, label, detail) { checks.push({ key: key, ok: !!ok, label: label, detail: detail == null ? null : detail }); }
    add("ownership_known", ownership !== "unknown", "REC ownership recorded",
      "Set whether you retain certificates or assigned them to the utility/program.");
    var sellable = ownership === "owner_retained";
    add("owner_retained", sellable || ownership === "unknown",
      sellable ? "Owner appears to retain RECs" : ((ownership === "assigned_to_utility" || ownership === "counterparty")
        ? "RECs assigned away — no open-market sell path" : "Ownership unclear"), note);
    add("gis_id", !!gis, "NEPOOL-GIS (or registry) unit id", gis || "Add the GIS generator id so filings match the registry.");
    add("fuel", true, "Fuel type", fuel);
    add("registry", true, "Certificate registry", registry);
    // (The backend's hint names a real REC agent; the sample keeps it generic.)
    add("verifier", !!verifier, "Independent Verifier named", verifier || "Who files generation to GIS? (e.g. your REC agent or Independent Verifier)");
    var vintages = expectedVintages(id);
    var total = vintages.reduce(function (t, v) { return t + v.expected_recs; }, 0);
    var genOk = vintages.some(function (v) { return v.expected_recs > 0 || v.day_count > 0; });
    add("generation", genOk, "Generation history for recent quarters",
      genOk ? total + " expected RECs across window" : "No metered kWh in the REC reporting window yet.");
    var okN = checks.filter(function (c) { return c.ok; }).length;
    var canSell = ownership === "owner_retained" && !!gis && genOk;
    var path, pathLabel;
    if (ownership === "assigned_to_utility") {
      path = "utility_assigned";
      pathLabel = "Attributes go to the utility/program — monetized via rate adjustor/incentive, not open-market REC sales.";
    } else if (ownership === "counterparty") {
      path = "counterparty";
      pathLabel = "A PPA/program counterparty holds attributes — not owner-sold.";
    } else if (ownership === "owner_retained" && canSell) {
      path = "sell_ready";
      pathLabel = "Owner-retained with GIS id + generation — ready for mint pack / broker intro.";
    } else if (ownership === "owner_retained") {
      path = "sell_blocked";
      pathLabel = "Owner-retained but missing GIS id, verifier, or generation — finish readiness.";
    } else {
      path = "unknown";
      pathLabel = "Record ownership first. Many net-metering programs assign RECs to the utility.";
    }
    return {
      array_id: id, array_name: s.name, ownership: ownership, ownership_note: note,
      nepool_gis_id: gis, fuel_type: fuel, cert_registry: registry, verifier_name: verifier,
      checks: checks, readiness_score: okN, readiness_max: checks.length,
      path: path, path_label: pathLabel, can_list_intent: canSell,
      expected_vintages: vintages, expected_recs_total: total,
      disclaimer: "Not a broker bid and not GIS inventory. Expected RECs = floor(MWh) from " +
        "your captured generation. Certificate title moves only in NEPOOL-GIS (or " +
        "another registry) under your or your verifier's account. AO does not hold " +
        "certificates or sale proceeds.",
    };
  }

  function recDesk() {
    var rows = D.sites().map(arrayReadiness);
    function count(f) { return rows.filter(f).length; }
    var totals = {
      array_count: rows.length,
      unknown_ownership: count(function (r) { return r.ownership === "unknown"; }),
      owner_retained: count(function (r) { return r.ownership === "owner_retained"; }),
      assigned_to_utility: count(function (r) { return r.ownership === "assigned_to_utility"; }),
      sell_ready: count(function (r) { return r.path === "sell_ready"; }),
      sell_blocked: count(function (r) { return r.path === "sell_blocked"; }),
      expected_recs_total: rows.reduce(function (t, r) { return t + r.expected_recs_total; }, 0),
    };
    var order = { sell_ready: 0, sell_blocked: 1, unknown: 2, utility_assigned: 3, counterparty: 4 };
    rows.sort(function (a, b) {
      var oa = order[a.path] != null ? order[a.path] : 9, ob = order[b.path] != null ? order[b.path] : 9;
      return oa - ob || (b.expected_recs_total || 0) - (a.expected_recs_total || 0);
    });
    return {
      ok: true, arrays: rows, totals: totals,
      generated_at: new Date().toISOString(),
      market_note: "Indicative New England Class I band is shown in Analysis → Resources " +
        "(~$30–40/MWh, MA ACP $40 ceiling). That is reference context, not an AO bid.",
      legal_note: "REC Desk is software: ownership, readiness, expected inventory, and " +
        "checklists. GIS transfers and broker negotiations stay with you / your IV / " +
        "a licensed marketer. No success fee and no custody in this version.",
    };
  }

  /* ── Array Market: stored prospectuses (prospectus.build_prospectus) ──────
   * Three already-built data rooms on healthy sample arrays whose nameplate
   * matches the simulated fleet. The real prospectus deliberately carries NO
   * dollar valuation (it is "not an appraisal"): its value figures are the
   * weather-adjusted performance ratio, the reliability indicator, and
   * invoiced revenue, all derived here from the array's own history. */
  var DOCS = [
    { document_id: 4127, array_id: 1, purpose: "refinance", ago: 9,
      share: { id: 211, published: true, redact: true, views: 3, viewedAgo: 2, createdAgo: 8 } },
    { document_id: 4093, array_id: 15, purpose: "sale", ago: 26,
      share: { id: 198, published: false, redact: true, views: 0, viewedAgo: null, createdAgo: 26 } },
    { document_id: 4051, array_id: 19, purpose: "sale", ago: 47, share: null },
  ];
  function docSpec(id) {
    for (var i = 0; i < DOCS.length; i++) if (String(DOCS[i].document_id) === String(id)) return DOCS[i];
    return null;
  }
  var TOKEN_CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function shareToken(spec) {
    var r = D.rng("share-token:" + spec.share.id), t = "";
    for (var i = 0; i < 32; i++) t += TOKEN_CH.charAt(Math.floor(r() * 64));
    return t;
  }

  var DISCLAIMER =
    "Not an appraisal or an offer. This is a data room only — a captured, " +
    "timestamped, re-derivable package built from this array's own operating " +
    "history. It is not immutable and not investment advice. Revenue figures are " +
    "INVOICED amounts, not collected payments (no payment record exists yet). " +
    "Coverage windows and row counts are printed on every section: most telemetry " +
    "is young (months, not years); utility bills are the deeper series. Verify " +
    "independently before transacting. Array Operator is a software vendor charging " +
    "flat SaaS fees for tools — it never negotiates, never takes a success or " +
    "brokerage fee, and never touches funds.";

  // Approximate town-centroid coordinates by sample region (fictional sites).
  var REGION_LL = {
    south: [42.93, -72.71], central: [44.12, -72.68], north: [44.71, -72.62], northeast: [44.62, -71.98],
    east: [43.79, -72.31], northwest: [44.82, -73.07], nh: [43.64, -72.25], me: [43.91, -69.82],
  };

  function fleetArray(id) {
    try {
      var snap = window.FleetStore && FleetStore.snapshot ? FleetStore.snapshot() : null;
      var arrs = (snap && snap.arrays) || [];
      for (var i = 0; i < arrs.length; i++) if (Number(arrs[i].id) === Number(id)) return arrs[i];
    } catch (e) {}
    return null;
  }
  function equipmentFor(s) {
    var fa = fleetArray(s.id);
    if (fa && fa.inverters && fa.inverters.length) {
      return fa.inverters.map(function (i) {
        return { name: i.name, vendor: i.vendor || fa.vendor || null, model: i.model || null, serial: null,
          nameplate_kw: i.nameplate_kw != null ? r2(i.nameplate_kw) : null };
      });
    }
    // Fleet not loaded yet: same nameplate, evenly split.
    var kw = num(s.nameplate_kw) || 50, n = Math.max(4, Math.round(kw / 7.5)), np = r2(kw / n), out = [];
    for (var k = 0; k < n; k++) out.push({ name: "Inverter " + (k + 1), vendor: "solaredge", model: "SE" + np + "K", serial: null, nameplate_kw: np });
    return out;
  }

  function coverage(first, last) {
    if (!first || !last) return { first: null, last: null, day_count: 0 };
    return { first: D.isoDate(first), last: D.isoDate(last), day_count: daysBetween(first, last) + 1 };
  }

  function buildPayload(spec) {
    var s = D.site(spec.array_id) || { id: spec.array_id, name: "Array " + spec.array_id, nameplate_kw: 50 };
    var id = Number(s.id);
    var gen = D.daysAgo(spec.ago, 10, 12 + (id % 40));
    var genMonth = D.isoMonth(gen);
    var equipment = equipmentFor(s);
    var nameplate = r2(equipment.reduce(function (t, i) { return t + num(i.nameplate_kw); }, 0));
    var ll = REGION_LL[s.region] || [44.2, -72.5];
    var connect = new Date(2019 + (D.hashStr("connect:" + id) % 4), D.hashStr("cm:" + id) % 12, 1 + (id % 27));

    var asset = {
      name: s.name, portfolio_name: (fleetArray(id) || {}).portfolio_name || null, region: s.region || null,
      fuel_type: "solar", cert_registry: "NEPOOL-GIS", nepool_gis_id: gisId(id),
      first_connect_date: D.isoDate(connect), excluded: false,
      nameplate_kw: nameplate, nameplate_available: nameplate > 0,
      inverter_count: equipment.length, equipment: equipment,
      location: {
        latitude: ll[0], longitude: ll[1], geocode_source: "town_centroid",
        geocoded_address: s.name + ", " + ({ nh: "NH", me: "ME" }[s.region] || "VT"),
        tilt_deg: null, azimuth_deg: null, geometry_source: "default",
      },
      provenance: "equipment + geometry are captured on connect / operator-set",
    };

    // Production: the array's settled monthly history up to the build date.
    var hist = D.monthly(id, 24).filter(function (m) { return m.month < genMonth; });
    var firstDay = hist.length ? new Date(hist[0].year, hist[0].month_num - 1, 1) : null;
    var lastM = hist[hist.length - 1];
    var lastDay = lastM ? monthEnd(lastM.year, lastM.month_num - 1) : null;
    var cap = coverage(firstDay, lastDay);
    var isGmp = (s.primary_utility || "") === "gmp";
    var meterHist = isGmp ? hist.slice(-12) : [];
    var production = {
      monthly: hist.map(function (m) { return { month: m.month, captured_kwh: r1(m.kwh), owner_kwh: 0.0, estimate_kwh: 0.0 }; }),
      coverage: { captured: cap, owner_reported: coverage(null, null), estimated_bill_prorate: coverage(null, null) },
      row_counts: { captured: cap.day_count, owner_reported: 0, estimated: 0 },
      meter_settled: {
        source: "gmp_api (utility meter, 15-min intervals summed per day)",
        coverage: meterHist.length ? coverage(new Date(meterHist[0].year, meterHist[0].month_num - 1, 1), lastDay) : coverage(null, null),
        monthly_kwh: meterHist.map(function (m) { return { month: m.month, kwh: r1(m.kwh * 0.996) }; }),
      },
      provenance_note: "'captured' = metered readings (vendor telemetry, extension captures, " +
        "genuine utility reads). 'owner_reported' = operator-typed CSV/manual. " +
        "'estimated' = a monthly bill smeared flat across its days " +
        "(bill_prorate) — never mixed into the captured total.",
    };

    // Weather-adjusted expectation over the 120 captured days before the build.
    var WIN = 120, PR = 0.84;
    var perf = D.sitePerf(id), rr = D.rng("expect:" + id);
    var dly = D.daily(id, spec.ago + WIN).slice(0, WIN);
    var days = [], expT = 0, actT = 0, bestPoa = 0;
    dly.forEach(function (d) {
      var ratio = perf * (1 + (rr() - 0.5) * 0.06);
      var exp = d.kwh / ratio, poa = nameplate > 0 ? exp / (nameplate * PR) : 0;
      if (poa > bestPoa) bestPoa = poa;
      days.push({ day: d.date, poa_kwh_m2: r2(poa), expected_kwh: r1(exp), actual_kwh: r1(d.kwh), ratio_pct: Math.round(ratio * 100), sunny: false });
      expT += exp; actT += d.kwh;
    });
    days.forEach(function (d) { d.sunny = bestPoa > 0 && d.poa_kwh_m2 >= 0.85 * bestPoa; });
    var expectation = {
      available: true, reason: null,
      inputs: {
        nameplate_kw: nameplate, expected_basis: "weather_model", expected_kwh_per_kw_day: null,
        window_days: WIN, measured_days: days.length,
        measured_sources: ["extension_pull", "gmp_api", "smarthub", "utility_meter", "vendor"],
        location: { lat: ll[0], lng: ll[1], geocode_source: "town_centroid", address: asset.location.geocoded_address },
        geometry: { tilt_deg: 30.0, azimuth_deg: 0.0, tilt_assumed: true, azimuth_assumed: true, azimuth_label: "S" },
        performance_ratio: PR, performance_ratio_assumed: true,
        irradiance: {
          source: "Open-Meteo global_tilted_irradiance (hourly, integrated)", stc_reference_kwh_m2: 1.0,
          window_start: days.length ? days[0].day : null, window_end: days.length ? days[days.length - 1].day : null,
          best_day_poa_kwh_m2: r2(bestPoa),
        },
      },
      expected_kwh: r1(expT), expected_matched_kwh: r1(expT), actual_kwh: r1(actT),
      ratio_pct: expT > 0 ? Math.round(actT / expT * 100) : null,
      performance_ratio_measured: expT > 0 ? D.round(actT / expT, 3) : null,
      confidence: days.length >= 10 ? "high" : days.length >= 4 ? "medium" : days.length ? "low" : "none",
      days: days,
      window_anchor: D.isoDate(gen),
      captured_window: cap,
      basis: "weather_model",
      actuals_note: "Actuals are CAPTURED sources only (owner-typed CSV/manual excluded) so " +
        "the ratio can't be inflated by operator-entered data.",
    };

    // Health: healthy sites; two closed, months-old events for texture.
    var outageAt = D.daysAgo(spec.ago + 70 + (id % 25), 6, 40);
    var snowAt = new Date(gen.getFullYear() - (gen.getMonth() < 2 ? 1 : 0), 1, 6 + (id % 15), 9, 5);
    var invRef = "Inverter " + (1 + (id % Math.max(1, equipment.length)));
    var alerts = [
      { title: "Array output below seasonal expectation (snow cover)", severity: "info", status: "resolved",
        inverter_ref: null, at: snowAt.toISOString() },
      { title: invRef + " stopped reporting for 6 h (vendor portal)", severity: "warning", status: "resolved",
        inverter_ref: invRef, at: outageAt.toISOString() },
    ].sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    var health = {
      monitoring_since: cap.first,
      alert_events: { total: alerts.length, open: 0, by_severity: { info: 1, warning: 1 }, recent: alerts },
      warranty_claims: { total: 0, recovered_usd: 0.0, rows: [] },
      repair_tickets: { total: 0, open: 0, rows: [] },
      expected_low_inverters: [],
      honesty_note: "Fault observation began around " + (cap.first || "the first captured day") + ". " +
        "Absence of recorded faults BEFORE that is absence of observation, not " +
        "absence of faults — most telemetry here is months old, not years.",
    };

    // Revenue: every sample offtaker bound to this array, invoiced (not collected).
    var lastTotal = 0;
    var offtakers = offtakersFor(id).map(function (o) {
      var amt = o.last_sent_at ? num(o._demo_amount) : 0;
      lastTotal += amt;
      return {
        customer_name: o.customer_name, client_email: o.client_email,
        allocation_pct: o.allocation_pct, array_share_pct: null,
        discount_pct: o.resolved_discount_pct != null ? num(o.resolved_discount_pct) / 100 : null,
        net_rate_per_kwh: o.net_rate_per_kwh, rate_per_kwh: null, budget_amount_usd: null,
        cadence: o.cadence, delivery_mode: o.delivery_mode,
        last_sent_amount_usd: amt ? r2(amt) : null,
        last_sent_period_end: o.last_sent_at || null,
        trailing_invoiced: o.last_sent_at ? [{ period: String(o.last_sent_at).slice(0, 7), invoiced_usd: r2(amt) }] : [],
      };
    });
    var revenue = {
      offtaker_count: offtakers.length, offtakers: offtakers,
      last_cycle_invoiced_usd: r2(lastTotal), pii_redacted: false,
      invoiced_not_collected: "All figures are INVOICED amounts. Array Operator knows what was billed, " +
        "not what was collected — there are no offtaker payment rails yet.",
    };

    // Utility record: host + member accounts on this array (AO_DEMO.utilAccounts).
    var accts = accountsFor(id), billCount = 0, maxBills = 0;
    accts.forEach(function (u) { billCount += num(u.bill_count); maxBills = Math.max(maxBills, num(u.bill_count)); });
    var host = hostAccount(id), hostBills = host ? num(host.bill_count) : 0;
    var g0 = new Date(gen.getFullYear(), gen.getMonth(), 1);
    var allHist = D.monthly(id, 24), byMonth = {};
    allHist.forEach(function (m) { byMonth[m.month] = m.kwh; });
    var rateSeries = [];
    for (var k = hostBills; k >= 1; k--) {
      var pe = monthEnd(g0.getFullYear(), g0.getMonth() - k);
      var banked = !!BANKS[id];
      rateSeries.push({ period_end: D.isoDate(pe), credit_rate_per_kwh: banked ? null : D.round(rate(), 4),
        banked: banked, kwh_sent_to_grid: byMonth[D.isoMonth(pe)] != null ? byMonth[D.isoMonth(pe)] : null });
    }
    var utility = accts.length ? {
      bill_count: billCount,
      coverage: {
        first_period_end: maxBills ? D.isoDate(monthEnd(g0.getFullYear(), g0.getMonth() - maxBills)) : null,
        last_period_end: D.isoDate(monthEnd(g0.getFullYear(), g0.getMonth() - 1)),
      },
      captured_pdf_count: Math.round(billCount * 0.96),
      banked_month_count: rateSeries.filter(function (x) { return x.banked; }).length,
      credit_rate_history: rateSeries.slice(-36),
      provenance: "bills are the utility portal's own records (raw JSON + PDF " +
        "retained); credit rates are read from real line items, not typed.",
    } : { available: false, reason: "no_utility_accounts",
      note: "No linked utility account — the bill series is empty for this array (common for inverter-only arrays)." };

    // Reliability indicator (prospectus._estimate_section): NOT a valuation.
    var ratioPct = expectation.ratio_pct, covShare = Math.min(1, days.length / WIN), score = null;
    if (ratioPct != null) score = Math.round(100 * (0.7 * (Math.min(ratioPct / 100, 1.1) / 1.1) + 0.3 * covShare));
    var estimate = {
      reliability_score: score,
      inputs: { actual_vs_expected_pct: ratioPct, data_coverage_share: r2(covShare),
        weights: { performance: 0.7, coverage: 0.3 }, measured_days: days.length, window_days: WIN },
      not_a_valuation: "This is a reliability indicator, NOT an appraisal or an opinion of " +
        "value. A defensible valuation additionally needs: a full-year " +
        "weather-normalized revenue (not a naive ×12 — solar seasonality " +
        "lies), a stated remaining-term and O&M reserve, and collected (not " +
        "just invoiced) revenue. Those are a later phase, gated on counsel.",
    };

    var acct = D.account();
    return {
      schema_version: 1, kind: "array_prospectus", purpose: spec.purpose,
      array_id: id, array_name: s.name,
      operator: { company_name: acct.company_name || null, operator_name: acct.operator_name || null },
      sections: { asset: asset, production: production, expectation: expectation, health: health,
        revenue: revenue, utility: utility, estimate: estimate },
      disclaimer: DISCLAIMER,
      generated_at: gen.toISOString(),
    };
  }

  // A real SHA-256 over the payload's data (minus the volatile keys), so the
  // printed hash genuinely changes if the sample data does.
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { o[k] = sortKeys(v[k]); });
      return o;
    }
    return v;
  }
  function sha256Hex(str) {
    try {
      var c = (typeof crypto !== "undefined" && crypto.subtle) ? crypto : null;
      if (c && typeof TextEncoder !== "undefined") {
        return c.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
        });
      }
    } catch (e) {}
    // Insecure context without SubtleCrypto: a stable digest of the same bytes.
    var h = "";
    for (var i = 0; i < 8; i++) h += ("0000000" + D.hashStr(i + ":" + str).toString(16)).slice(-8);
    return Promise.resolve(h);
  }

  var _payloads = {};
  function payload(spec) {
    if (!_payloads[spec.document_id]) {
      var p = buildPayload(spec);
      var hashable = {};
      Object.keys(p).forEach(function (k) { if (k !== "generated_at" && k !== "content_sha256") hashable[k] = p[k]; });
      _payloads[spec.document_id] = sha256Hex(JSON.stringify(sortKeys(hashable))).then(function (h) {
        p.content_sha256 = h;
        return p;
      });
    }
    return _payloads[spec.document_id];
  }

  function shareDict(spec, p) {   // prospectus_routes._share_dict
    var sh = spec.share;
    var token = shareToken(spec);
    return {
      id: sh.id, token: token, share_path: "/v1/prospectus/" + token,
      published: !!sh.published, redact_offtaker_pii: !!sh.redact, revoked: false,
      view_count: sh.views,
      last_viewed_at: sh.viewedAgo != null ? D.daysAgo(sh.viewedAgo, 15, 22).toISOString() : null,
      content_sha256: p.content_sha256,
      created_at: D.daysAgo(sh.createdAgo, 11, 3).toISOString(),
    };
  }

  function redact(p) {   // prospectus.redact_prospectus
    var out = JSON.parse(JSON.stringify(p));
    var rev = (out.sections || {}).revenue || {};
    (rev.offtakers || []).forEach(function (o, i) { o.customer_name = "Offtaker " + (i + 1); o.client_email = null; });
    rev.pii_redacted = true;
    return out;
  }

  /* ── Renderers: the same sections the backend prints, built in-browser ─── */
  var SAMPLE_LINE = "Sample account: Northeast Community Solar is a fictional operator and every figure here is " +
    "sample data, rendered in your browser. Start free at arrayoperator.com to build one for your own arrays.";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); }
  function kwhTxt(x) { return x == null || !isFinite(Number(x)) ? "—" : fmt0(x) + " kWh"; }
  function rateTxt(x) { return x == null ? "—" : "$" + Number(x).toFixed(4) + "/kWh"; }
  function usd2(x) { return "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct1(f) { return (Math.round(Number(f) * 1000) / 10).toFixed(1) + "%"; }
  function nameplateTxt(a) { return a.nameplate_available ? a.nameplate_kw + " kW" : "not available (utility-only array)"; }
  function titleCase(s) { s = String(s || "sale"); return s.charAt(0).toUpperCase() + s.slice(1); }

  // prospectus.render_prospectus_html (public share view + owner HTML preview).
  function renderHtml(p) {
    var s = p.sections || {}, asset = s.asset || {}, prod = s.production || {}, exp = s.expectation || {},
      health = s.health || {}, rev = s.revenue || {}, util = s.utility || {}, est = s.estimate || {}, loc = asset.location || {};
    function stamp(cov) {
      if (!cov || !cov.day_count) return '<span class="cov none">no coverage</span>';
      return '<span class="cov">' + esc(cov.first) + " → " + esc(cov.last) + " · " + cov.day_count + " days</span>";
    }
    var equip = (asset.equipment || []).map(function (i) {
      return "<tr><td>" + esc(i.name || "—") + "</td><td>" + esc(i.vendor || "—") + "</td><td>" + esc(i.model || "—") +
        "</td><td>" + esc(i.serial || "—") + "</td><td>" + (i.nameplate_kw != null ? i.nameplate_kw : "—") + " kW</td></tr>";
    }).join("") || '<tr><td colspan="5" class="muted">No inverter equipment on file (utility-only array).</td></tr>';
    var prodRows = (prod.monthly || []).map(function (m) {
      return "<tr><td>" + esc(m.month) + "</td><td>" + kwhTxt(m.captured_kwh) + "</td><td>" + kwhTxt(m.owner_kwh) + "</td><td>" + kwhTxt(m.estimate_kwh) + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="muted">No daily production captured yet.</td></tr>';
    var expHtml = exp.available
      ? '<p class="big">' + (exp.ratio_pct != null ? exp.ratio_pct : "—") + '% <span class="muted">of weather-adjusted expectation</span></p>' +
        '<p class="muted">Actual ' + kwhTxt(exp.actual_kwh) + " vs expected " + kwhTxt(exp.expected_matched_kwh) + " over " +
        ((exp.inputs || {}).measured_days != null ? exp.inputs.measured_days : "—") + " measured days · confidence: " +
        esc(exp.confidence || "—") + ". " + esc(exp.actuals_note || "") + "</p>"
      : '<p class="muted">Weather-adjusted expectation unavailable — ' + esc(exp.reason || "") + ". " + esc(exp.note || "") + "</p>";
    var ae = health.alert_events || {}, wc = health.warranty_claims || {}, rt = health.repair_tickets || {};
    var healthHtml = '<ul class="stats"><li><b>' + (ae.total || 0) + "</b> alert events (" + (ae.open || 0) + " open)</li>" +
      "<li><b>" + (wc.total || 0) + "</b> warranty claims · $" + fmt0(wc.recovered_usd) + " recovered</li>" +
      "<li><b>" + (rt.total || 0) + "</b> repair tickets (" + (rt.open || 0) + ' open)</li></ul><p class="muted">' + esc(health.honesty_note || "") + "</p>";
    var revRows = (rev.offtakers || []).map(function (o) {
      return "<tr><td>" + esc(o.customer_name || "—") + "</td><td>" + (o.allocation_pct != null ? (Math.round(o.allocation_pct * 1000) / 10) : "—") + "%</td><td>" +
        (o.discount_pct != null ? (Math.round(o.discount_pct * 1000) / 10) + "%" : "—") + "</td><td>" + esc(o.cadence || "—") + "</td><td>" +
        (o.last_sent_amount_usd ? usd2(o.last_sent_amount_usd) : "—") + "</td></tr>";
    }).join("") || '<tr><td colspan="5" class="muted">No offtaker subscriptions bound to this array.</td></tr>';
    var utilHtml;
    if (util.available === false) utilHtml = '<p class="muted">' + esc(util.note || "") + "</p>";
    else {
      var uc = util.coverage || {};
      utilHtml = '<ul class="stats"><li><b>' + (util.bill_count || 0) + "</b> bills captured</li><li>" + esc(uc.first_period_end || "—") + " → " +
        esc(uc.last_period_end || "—") + "</li><li><b>" + (util.banked_month_count || 0) + "</b> banked months</li><li><b>" +
        (util.captured_pdf_count || 0) + "</b> bill PDFs retained</li></ul>";
      var cr = (util.credit_rate_history || []).slice(-12);
      if (cr.length) {
        utilHtml += "<table><thead><tr><th>Period end</th><th>Credit rate</th><th>Banked</th></tr></thead><tbody>" + cr.map(function (r) {
          return "<tr><td>" + esc(r.period_end) + "</td><td>" + (r.banked ? "—" : rateTxt(r.credit_rate_per_kwh)) + "</td><td>" + (r.banked ? "yes" : "no") + "</td></tr>";
        }).join("") + "</tbody></table>";
      }
    }
    var estHtml = (est.reliability_score != null
      ? '<p class="big oct">' + est.reliability_score + '<span class="muted"> / 100 reliability</span></p>'
      : '<p class="muted">Reliability score unavailable (needs captured production + expectation).</p>') +
      '<p class="muted">' + esc(est.not_a_valuation || "") + "</p>";
    var title = esc(p.array_name || "Array");
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Array Prospectus — " + title + "</title><style>" +
      ":root{--ink:#0e1420;--muted:#5a6572;--line:#e2e8f0;--card:#fff;--oct:#7c3aed;--sky1:#1E90E8;--sky2:#56B4F0;--sky3:#BEE3FA}" +
      "*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
      "color:var(--ink);background:linear-gradient(180deg,var(--sky1),var(--sky2) 42%,var(--sky3));min-height:100vh;padding:24px 16px}" +
      ".wrap{max-width:860px;margin:0 auto}.sheet{background:rgba(255,255,255,.86);backdrop-filter:blur(18px) saturate(1.5);" +
      "border:1px solid rgba(255,255,255,.6);border-radius:22px;box-shadow:0 12px 40px rgba(20,60,120,.16);padding:28px 30px;margin-bottom:18px}" +
      "h1{font-size:30px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.10em;color:var(--muted);margin:0 0 12px;font-weight:800}" +
      ".eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:800;color:var(--oct);margin:0 0 6px}" +
      ".big{font-size:34px;font-weight:800;letter-spacing:-.02em;margin:6px 0}.oct{color:var(--oct)}.muted{color:var(--muted)}" +
      "table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}" +
      "th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}ul.stats{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:10px}" +
      "ul.stats li{background:#f3f6fa;border-radius:10px;padding:8px 12px;font-size:13.5px}.cov{display:inline-block;background:#eef2f7;color:var(--muted);" +
      "border-radius:999px;padding:2px 10px;font-size:11.5px;margin-left:8px}.cov.none{background:#fef3c7;color:#92400e}" +
      ".meta{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--muted)}.disc{font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px;margin-top:6px}" +
      ".hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:var(--muted)}" +
      ".sample{font-size:12.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:8px 12px;margin:12px 0 0}" +
      '</style></head><body><div class="wrap"><div class="sheet">' +
      '<p class="eyebrow">Array Prospectus · ' + esc(titleCase(p.purpose)) + " · data room</p><h1>" + title + "</h1>" +
      '<div class="meta"><span>Operator: ' + esc((p.operator || {}).company_name || "—") + "</span><span>Nameplate: " + esc(nameplateTxt(asset)) +
      "</span><span>" + esc(loc.geocoded_address || "location not geocoded") + "</span><span>Generated " + esc(String(p.generated_at || "").slice(0, 19)) + "</span></div>" +
      '<p class="sample">' + esc(SAMPLE_LINE) + "</p></div>" +
      '<div class="sheet"><h2>The asset</h2><div class="meta" style="margin-bottom:10px"><span>NEPOOL GIS: ' + esc(asset.nepool_gis_id || "—") +
      "</span><span>Fuel: " + esc(asset.fuel_type || "solar") + "</span><span>First connect: " + esc(asset.first_connect_date || "unknown") +
      "</span><span>Inverters: " + (asset.inverter_count || 0) + "</span></div>" +
      "<table><thead><tr><th>Inverter</th><th>Vendor</th><th>Model</th><th>Serial</th><th>Nameplate</th></tr></thead><tbody>" + equip + "</tbody></table></div>" +
      '<div class="sheet"><h2>Production record ' + stamp((prod.coverage || {}).captured) + "</h2>" +
      "<table><thead><tr><th>Month</th><th>Captured</th><th>Owner-reported</th><th>Estimated</th></tr></thead><tbody>" + prodRows + "</tbody></table>" +
      '<p class="muted" style="margin-top:10px">' + esc(prod.provenance_note || "") + "</p></div>" +
      '<div class="sheet"><h2>Weather-adjusted performance</h2>' + expHtml + "</div>" +
      '<div class="sheet"><h2>Equipment health</h2>' + healthHtml + "</div>" +
      '<div class="sheet"><h2>Revenue (invoiced)</h2><table><thead><tr><th>Offtaker</th><th>Allocation</th><th>Discount</th><th>Cadence</th><th>Last invoiced</th></tr></thead>' +
      "<tbody>" + revRows + "</tbody></table>" +
      (rev.pii_redacted ? '<p class="muted">Offtaker identities are redacted in this shared view.</p>' : "") +
      '<p class="muted">' + esc(rev.invoiced_not_collected || "") + "</p></div>" +
      '<div class="sheet"><h2>The utility record</h2>' + utilHtml + '<p class="muted" style="margin-top:8px">' + esc(util.provenance || "") + "</p></div>" +
      '<div class="sheet"><h2>Reliability indicator</h2>' + estHtml + "</div>" +
      '<div class="sheet"><p class="disc">' + esc(p.disclaimer || "") + '</p><p class="hash">Artifact SHA-256: ' + esc(p.content_sha256 || "—") + "</p></div>" +
      "</div></body></html>";
  }

  // A small honest PDF (Helvetica, WinAnsi) with the sections of
  // prospectus.render_prospectus_pdf, so "Download PDF" opens a real document.
  var WIN_MAP = { "—": "\x97", "–": "\x96", "·": "\xb7", "’": "\x92", "‘": "\x91", "“": "\x93",
    "”": "\x94", "•": "\x95", "…": "\x85", "×": "\xd7", "→": "->", "≈": "~", "↗": "", " ": " " };
  function winAnsi(s) {
    s = String(s == null ? "" : s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), c = s.charCodeAt(i);
      if (WIN_MAP[ch] != null) out += WIN_MAP[ch];
      else if (c < 128 || (c >= 160 && c < 256)) out += ch;
      else out += "?";
    }
    return out;
  }
  function pdfStr(s) { return "(" + winAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")"; }
  function wrap(text, max) {
    var words = String(text || "").split(/\s+/), lines = [], cur = "";
    words.forEach(function (w) {
      if (!w) return;
      if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  function pdfBytes(title, blocks) {
    var TOP = 792 - 54, BOTTOM = 54, LEFT = 54, WIDTH = 504;
    var pages = [], ops = [], y = TOP;
    function flush() { if (ops.length) pages.push(ops.join("\n")); ops = []; y = TOP; }
    function need(h) { if (y - h < BOTTOM) flush(); }
    function col(c) { c = c || [0.055, 0.078, 0.125]; return c[0] + " " + c[1] + " " + c[2] + " rg"; }
    function text(x, size, bold, c, str) {
      ops.push("BT /" + (bold ? "F2" : "F1") + " " + size + " Tf " + col(c) + " " + x + " " + y.toFixed(1) + " Td " + pdfStr(str) + " Tj ET");
    }
    blocks.forEach(function (b) {
      var size = b.s || 9.5, lh = size * 1.4;
      if (b.gap) { if (y - b.gap - lh < BOTTOM) flush(); else y -= b.gap; }
      if (b.t === "rule") {
        need(8); y -= 4;
        ops.push("0.886 0.91 0.941 RG 0.6 w " + LEFT + " " + y.toFixed(1) + " m " + (LEFT + WIDTH) + " " + y.toFixed(1) + " l S");
        y -= 4; return;
      }
      if (b.t === "row") {
        need(lh); y -= lh;
        b.cells.forEach(function (cell, i) { text(LEFT + b.xs[i], size, b.b, b.c, cell); });
        return;
      }
      wrap(b.text, Math.floor(WIDTH / (size * 0.5))).forEach(function (ln) { need(lh); y -= lh; text(LEFT, size, b.b, b.c, ln); });
    });
    flush();
    var objs = [];
    objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objs[4] = "<< /Title " + pdfStr(title) + " /Producer (Array Operator sample account) >>";
    var kids = [];
    pages.forEach(function (content, i) {
      var pn = 6 + i * 2;
      kids.push(pn + " 0 R");
      objs[pn - 1] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + (pn + 1) + " 0 R >>";
      objs[pn] = "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream";
    });
    objs[1] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + kids.length + " >>";
    var out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", offs = [];
    objs.forEach(function (o, i) { offs.push(out.length); out += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
    var xref = out.length;
    out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
    offs.forEach(function (o) { out += ("0000000000" + o).slice(-10) + " 00000 n \n"; });
    out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R /Info 5 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
    var bytes = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
  }

  function renderPdf(p) {
    var s = p.sections || {}, asset = s.asset || {}, prod = s.production || {}, exp = s.expectation || {},
      health = s.health || {}, rev = s.revenue || {}, util = s.utility || {}, est = s.estimate || {}, loc = asset.location || {};
    var INK = [0.055, 0.078, 0.125], MUTED = [0.353, 0.396, 0.447], OCT = [0.486, 0.227, 0.929], H2C = [0.2, 0.255, 0.333], WARN = [0.573, 0.251, 0.055];
    var B = [];
    function h2(t) { B.push({ text: t, s: 11, b: true, c: H2C, gap: 12 }); }
    function body(t) { B.push({ text: t, s: 9.5, c: INK }); }
    function muted(t) { B.push({ text: t, s: 8, c: MUTED }); }
    function row(cells, xs, bold) { B.push({ t: "row", cells: cells, xs: xs, s: 8, b: !!bold, c: bold ? MUTED : INK }); }
    B.push({ text: "Array Prospectus · " + titleCase(p.purpose) + " · data room", s: 8, c: OCT });
    B.push({ text: p.array_name || "Array", s: 20, b: true, c: INK, gap: 4 });
    muted("Operator: " + ((p.operator || {}).company_name || "—") + " · Nameplate: " + nameplateTxt(asset) + " · " +
      (loc.geocoded_address || "location not geocoded") + " · Generated " + String(p.generated_at || "").slice(0, 19));
    B.push({ text: SAMPLE_LINE, s: 8, c: WARN, gap: 4 });

    h2("The asset");
    body("NEPOOL GIS: " + (asset.nepool_gis_id || "—") + " · Fuel: " + (asset.fuel_type || "solar") + " · First connect: " +
      (asset.first_connect_date || "unknown") + " · Inverters: " + (asset.inverter_count || 0));
    var EX = [0, 110, 190, 300, 420];
    row(["Inverter", "Vendor", "Model", "Serial", "kW"], EX, true);
    (asset.equipment || []).forEach(function (i) {
      row([i.name || "—", i.vendor || "—", i.model || "—", i.serial || "—", i.nameplate_kw != null ? String(i.nameplate_kw) : "—"], EX);
    });

    var cov = (prod.coverage || {}).captured || {};
    h2("Production record");
    muted("Captured coverage: " + (cov.first || "—") + " → " + (cov.last || "—") + " · " + (cov.day_count || 0) + " days");
    var PX = [0, 110, 230, 350];
    row(["Month", "Captured kWh", "Owner kWh", "Estimated kWh"], PX, true);
    (prod.monthly || []).slice(-24).forEach(function (m) { row([m.month, fmt0(m.captured_kwh), fmt0(m.owner_kwh), fmt0(m.estimate_kwh)], PX); });

    h2("Weather-adjusted performance");
    if (exp.available) {
      body(exp.ratio_pct + "% of weather-adjusted expectation — actual " + fmt0(exp.actual_kwh) + " kWh vs expected " +
        fmt0(exp.expected_matched_kwh) + " kWh over " + ((exp.inputs || {}).measured_days || "—") + " measured days (confidence: " + (exp.confidence || "—") + ").");
      muted(exp.actuals_note || "");
    } else muted("Unavailable — " + (exp.reason || "") + ". " + (exp.note || ""));

    var ae = health.alert_events || {}, wc = health.warranty_claims || {}, rt = health.repair_tickets || {};
    h2("Equipment health");
    body((ae.total || 0) + " alert events (" + (ae.open || 0) + " open) · " + (wc.total || 0) + " warranty claims ($" + fmt0(wc.recovered_usd) +
      " recovered) · " + (rt.total || 0) + " repair tickets (" + (rt.open || 0) + " open).");
    muted(health.honesty_note || "");

    h2("Revenue (invoiced)");
    var RX = [0, 190, 270, 350, 420];
    if ((rev.offtakers || []).length) {
      row(["Offtaker", "Allocation", "Discount", "Cadence", "Last invoiced"], RX, true);
      rev.offtakers.forEach(function (o) {
        row([o.customer_name || "—", o.allocation_pct != null ? pct1(o.allocation_pct) : "—",
          o.discount_pct != null ? pct1(o.discount_pct) : "—", o.cadence || "—", o.last_sent_amount_usd ? usd2(o.last_sent_amount_usd) : "—"], RX);
      });
    } else muted("No offtaker subscriptions bound to this array.");
    if (rev.pii_redacted) muted("Offtaker identities are redacted in this shared view.");
    muted(rev.invoiced_not_collected || "");

    h2("The utility record");
    if (util.available === false) muted(util.note || "");
    else {
      var uc = util.coverage || {};
      body((util.bill_count || 0) + " bills · " + (uc.first_period_end || "—") + " → " + (uc.last_period_end || "—") + " · " +
        (util.banked_month_count || 0) + " banked months · " + (util.captured_pdf_count || 0) + " bill PDFs retained.");
    }

    h2("Reliability indicator");
    body(est.reliability_score != null ? est.reliability_score + " / 100 reliability." : "Reliability score unavailable (needs captured production + expectation).");
    muted(est.not_a_valuation || "");

    B.push({ t: "rule", gap: 8 });
    muted(p.disclaimer || "");
    muted("Artifact SHA-256: " + (p.content_sha256 || "—"));
    return pdfBytes("Array Prospectus — " + (p.array_name || "Array"), B);
  }

  function notFound(detail) { return D.json({ detail: detail || "Not found" }, 404); }

  /* ── Routes ─────────────────────────────────────────────────────────────── */
  D.get(/^\/v1\/array-operator\/billing\/vacancy$/, function () { return vacancy(); });

  D.get(/^\/v1\/array-operator\/billing\/exchange\/demand$/, function () {
    var leads = leadRows();
    return { ok: true, leads: leads, count: leads.length };
  });

  D.get(/^\/v1\/array-operator\/billing\/exchange\/suggestions$/, function () {
    var pairs = suggestPairings(vacancy().arrays, leadRows(), 3);
    return { ok: true, suggestions: pairs, count: pairs.length,
      note: "Suggestions only — host must confirm. AO never assigns credits." };
  });

  D.get(/^\/v1\/array-owners\/rec-desk$/, function () { return recDesk(); });

  D.get(/^\/v1\/array-owners\/prospectuses$/, function (req) {
    var only = req.query && req.query.get("array_id");
    var specs = DOCS.filter(function (d) { return !only || String(d.array_id) === String(only); });
    return Promise.all(specs.map(payload)).then(function (ps) {
      return { ok: true, prospectuses: specs.map(function (d, i) {
        var p = ps[i];
        return {
          document_id: d.document_id, array_id: p.array_id, array_name: p.array_name, purpose: p.purpose,
          generated_at: p.generated_at, content_sha256: p.content_sha256, created_at: p.generated_at,
          shares: d.share ? [shareDict(d, p)] : [],
        };
      }) };
    });
  });

  D.get(/^\/v1\/array-owners\/prospectus\/(\d+)$/, function (req) {
    var spec = docSpec(req.match[1]);
    if (!spec) return notFound("Prospectus not found");
    return payload(spec).then(function (p) {
      return { ok: true, document_id: spec.document_id, prospectus: p, shares: spec.share ? [shareDict(spec, p)] : [] };
    });
  });

  D.get(/^\/v1\/array-owners\/prospectus\/(\d+)\/document$/, function (req) {
    var spec = docSpec(req.match[1]);
    if (!spec) return notFound("Prospectus not found");
    var format = (req.query && req.query.get("format")) || "pdf";
    return payload(spec).then(function (p) {
      if (format === "pdf") {
        return new Response(new Blob([renderPdf(p)], { type: "application/pdf" }), { status: 200, headers: {
          "Content-Type": "application/pdf", "X-AO-Sample": "1",
          "Content-Disposition": 'inline; filename="prospectus-' + spec.document_id + '.pdf"' } });
      }
      return new Response(renderHtml(p), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "X-AO-Sample": "1" } });
    });
  });

  // Public share view: 404 unless the link is published (and not revoked),
  // redacted per the share's flag, exactly like prospectus_routes.
  D.get(/^\/v1\/prospectus\/([A-Za-z0-9_-]+)$/, function (req) {
    var spec = null;
    DOCS.forEach(function (d) { if (d.share && shareToken(d) === req.match[1]) spec = d; });
    if (!spec || !spec.share.published) return notFound("Not found");
    var format = (req.query && req.query.get("format")) || "html";
    return payload(spec).then(function (p) {
      var shown = spec.share.redact ? redact(p) : p;
      if (format === "pdf") {
        return new Response(new Blob([renderPdf(shown)], { type: "application/pdf" }), { status: 200, headers: {
          "Content-Type": "application/pdf", "X-AO-Sample": "1" } });
      }
      return new Response(renderHtml(shown), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "X-AO-Sample": "1" } });
    });
  });
})();
