/* ============================================================================
 * Array Operator — anonymous-demo data (demo-data.js)
 *
 * A frozen "big operator" snapshot for signed-out visitors on arrayoperator.com.
 * Designed to feel like a real multi-site VT/NE community-solar book mid-cycle —
 * healthy pipeline, mixed utilities, action in progress — not a sparse 3-offtaker
 * toy or a stack of bounced emails.
 *
 * Scale (Ford 2026-07-14):
 *   · 20 arrays · ~200 inverters (fleet simulated separately in fleet-store.js)
 *   · 300 offtakers across GMP / VEC / WEC / Eversource / CMP
 *   · Pipeline: last cycle mostly delivered · this cycle drafts + auto-send
 *     · next run scheduled — frozen "state of action"
 *
 * Loaded BEFORE sandbox.js / reports.js. Those files render this ONLY when there
 * is no session (gated on `!authHeaders() && window.AO_DEMO`); a real signed-in
 * owner never touches any of it.
 * ==========================================================================*/
(function () {
  "use strict";

  // Deterministic PRNG — same seed → same demo every load (stable screenshots).
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
  var iso = function (d) { return d.toISOString().slice(0, 10); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var periodLabel = MON[ps.getMonth()] + " " + ps.getFullYear();
  var nextCharge = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  var periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var lastRunAt = new Date(ps.getFullYear(), pe.getMonth(), Math.min(13, pe.getDate()), 14, 30, 0);
  var nextFire = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0);

  var CREDIT_RATE = 0.2576; // VT excess+solcred-ish $/kWh
  var RATE_CENTS_PER_KWH = 0.5;

  // ── 20 arrays (matches fleet-store demo scale) ───────────────────────────
  // nameplate_kw · typical mid-season month kWh · region · primary utility
  var ARRAY_DEFS = [
    { id: 1,  name: "Londonderry",           kw: 99,  util: "gmp",        region: "south" },
    { id: 2,  name: "Starlake",              kw: 75,  util: "gmp",        region: "central" },
    { id: 3,  name: "Timberworks",           kw: 62,  util: "gmp",        region: "north" },
    { id: 4,  name: "Waterford",             kw: 48,  util: "gmp",        region: "north" },
    { id: 5,  name: "Tannery Brook",         kw: 55,  util: "gmp",        region: "central" },
    { id: 6,  name: "Chester Commons",       kw: 40,  util: "gmp",        region: "south" },
    { id: 7,  name: "Cover Catamount",       kw: 32,  util: "gmp",        region: "south" },
    { id: 8,  name: "West Glover Ridge",     kw: 50,  util: "vec",        region: "northeast" },
    { id: 9,  name: "Danville Big Buck",     kw: 100, util: "gmp",        region: "northeast" },
    { id: 10, name: "Norwich Union Village", kw: 45,  util: "gmp",        region: "east" },
    { id: 11, name: "Hardwick Field",        kw: 38,  util: "vec",        region: "northeast" },
    { id: 12, name: "Craftsbury Common",     kw: 28,  util: "vec",        region: "northeast" },
    { id: 13, name: "Mad River School",      kw: 35,  util: "gmp",        region: "central" },
    { id: 14, name: "Waitsfield Flats",      kw: 42,  util: "gmp",        region: "central" },
    { id: 15, name: "Enosburg Dairy",        kw: 60,  util: "wec",        region: "northwest" },
    { id: 16, name: "Swanton Yard",          kw: 52,  util: "wec",        region: "northwest" },
    { id: 17, name: "Lebanon Crossing",      kw: 70,  util: "eversource", region: "nh" },
    { id: 18, name: "Hanover Meadows",       kw: 44,  util: "eversource", region: "nh" },
    { id: 19, name: "Brunswick Landing",     kw: 80,  util: "cmp",        region: "me" },
    { id: 20, name: "Augusta Commons",       kw: 65,  util: "cmp",        region: "me" },
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

  function offtaker(id, name, email, kwh, pct, arrayId, utilAcctId, provider, opts) {
    opts = opts || {};
    var amount = r2(kwh * CREDIT_RATE);
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
      resolved_discount_pct: opts.discount != null ? opts.discount : 10,
      net_rate_per_kwh: CREDIT_RATE,
      formats: ["pdf"],
      cc_emails: "",
      source_filename: null,
      next_send_at: iso(nextCharge),
      last_sent_at: opts.last_sent_at || null,
      // Healthy last delivery — never "bounced" in the marketing demo.
      last_delivery_status: opts.last_sent_at ? "delivered" : null,
      preview: { amount_owed: amount, customer_kwh: kwh },
      _demo_kwh: kwh,
      _demo_amount: amount,
      _provider: provider,
    };
  }

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
    // ~15 offtakers average per array at 300/20 — shares sum roughly to ~85%
    // with unallocated residual (realistic NEB-ish feel)
    var share = 0.012 + rng() * 0.055; // 1.2%–6.7%
    var kwh = Math.max(40, Math.round(arrMonth * share));
    var isOrg = rng() < 0.38;
    var name, emailLocal;
    if (isOrg) {
      var town = arr.name.split(" ")[0];
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
    //   62% auto-send, already delivered last cycle
    //   18% auto-send, will fire this cycle (last_sent null → "sending")
    //   15% draft for approval (has draft ready)
    //   5%  paused (still in book, not broken)
    var r = rng();
    var mode = "auto", enabled = true, lastSent = null, hasDraft = false;
    if (r < 0.62) {
      mode = "auto";
      lastSent = iso(pe);
    } else if (r < 0.80) {
      mode = "auto";
      lastSent = null; // in flight this cycle
    } else if (r < 0.95) {
      mode = "draft";
      hasDraft = true;
      lastSent = iso(new Date(ps.getFullYear(), ps.getMonth() - 1, 15)); // prior month sent
    } else {
      mode = "draft";
      enabled = false;
    }

    offtakers.push(offtaker(
      1000 + i,
      name,
      emailLocal,
      kwh,
      r2(share),
      arr.id,
      ua.utility_account_id,
      arr.util,
      {
        delivery_mode: mode,
        enabled: enabled,
        last_sent_at: lastSent,
        array_name: arr.name,
        acctNick: name,
        discount: rng() < 0.15 ? 0 : 10,
        _hasDraft: hasDraft,
      }
    ));
  }

  // ── Drafts (ready to review — frozen mid-action, no bounces) ─────────────
  function draft(id, sub) {
    return {
      id: id,
      subscription_id: null,
      customer_name: sub.customer_name,
      client_email: sub.client_email,
      operator_name: account.operator_name,
      period_label: periodLabel,
      array_total_kwh: monthKwh((ARRAY_DEFS.find(function (a) { return a.id === sub.array_id; }) || { kw: 50 }).kw),
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

  // ── Billing (AO fees) scaled to 300 offtakers ────────────────────────────
  var TOTAL_NAMEPLATE = ARRAY_DEFS.reduce(function (s, a) { return s + a.kw; }, 0);
  var MTD_KWH = Math.round(TOTAL_NAMEPLATE * 4.6 * 22); // MTD ~22 days into month
  var MONITORING_CENTS = Math.round(MTD_KWH * RATE_CENTS_PER_KWH);
  var PER_OFFTAKER_CENTS = 1500;
  var INVOICING_CENTS = offtakers.length * PER_OFFTAKER_CENTS;
  var TOTAL_CENTS = MONITORING_CENTS + INVOICING_CENTS;

  var billingSummary = {
    billing_basis: "both",
    subscription_status: "active",
    monitoring_basis: "kwh",
    monitoring_total_cents: MONITORING_CENTS,
    mtd_kwh: MTD_KWH,
    blended_cents_per_kwh: RATE_CENTS_PER_KWH,
    offtaker_count: offtakers.length,
    invoicing_per_offtaker_cents: PER_OFFTAKER_CENTS,
    invoicing_total_cents: INVOICING_CENTS,
    total_cents: TOTAL_CENTS,
    period_start: iso(periodStart),
    has_payment_method: true,
    card_brand: "visa",
    card_last4: "4242",
    card_exp: "12/27",
  };
  var nextInvoice = { period_end: iso(nextCharge) };

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
      tagline: "20 sites · 200 inverters · 300 offtakers — frozen mid-cycle",
    },
  };
})();
