/* ============================================================================
 * Sample account · Statements routes (demo/statements.js)
 *
 * Loaded only for signed-out visitors by demo-api.js. Answers the reads behind
 * the Statements tab (#reports, reports.js) with the sample operator's data,
 * shaped EXACTLY like the backend (solar-operator api/billing/routes.py +
 * mailroom.py + mailroom_audit.py + reconcile_bills.py), so every sub-view runs
 * its normal signed-in render path:
 *
 *   Offtakers rail   GET  /send-pipeline              (send_pipeline)
 *                    GET  /utility-accounts           (list_utility_accounts)
 *                    GET  /global-rate                (get_global_rate)
 *                    GET  /export-periods             (invoice_export_periods)
 *                    GET  /payments, /payments/connect, /payment-policy, /issued-invoices
 *                    GET  /email-template  + POST /email-template/preview (pure render)
 *   Archives         GET  /invoice-archive, /utility-bill-archive, /monthly-report/manifest
 *   Mail room        GET  /mailroom, /mailroom/invoice/{id}(/email), /mailroom/legacy/{kind}/{id}(/email)
 *                    POST /mailroom/check, /mailroom/audit  → a scripted run id (changes nothing)
 *                    GET  /mailroom/audit, /mailroom/audit/{run_id}
 *   Bill audit       GET  /audit-by-array, /reconcile-bills
 *   Invoice trends   GET  /portfolio-gains
 *   Downloads        PDFs / xlsx / zip / csv → the shared read-only 403 + nudge
 *
 * ONE sample book drives all of it, so the tabs tie out:
 *   · offtakers, shares, emails, amounts and the $/kWh rate are AO_DEMO's;
 *   · AO_DEMO's "Sep 2026" draft figures ARE cycle 0 (the last full month);
 *     every other month is that figure × the array's seasonal shape from
 *     AO_DEMO_API.monthly(id), so North Branch Ridge's string fault shows up
 *     in its offtakers' last three invoices;
 *   · timing follows the backend scheduler: the monthly run fires on the 1st at
 *     09:00 UTC from the latest SETTLED bill, so the newest cycle that has gone
 *     out is the month before last (auto-send), approval offtakers were
 *     approved ~3 weeks after period end, and cycle 0 is the queue (drafts
 *     awaiting approval + the next scheduled run).
 * Writes the operator would make (save a rate, approve, send, upload, record a
 * payment) are NOT registered: they get demo-api's read-only 403 + nudge. The
 * two audit POSTs are registered because they only start a read-only check;
 * the "deep review" here is scripted from the sample data (its run says so in
 * `model` / `provider`), no AI call is made.
 * ==========================================================================*/
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  // ── Basics ───────────────────────────────────────────────────────────────
  function A() { return window.AO_DEMO || {}; }
  function acct() { return A().account || {}; }
  function rate() { return Number(A().creditRate) || 0.2576; }
  function num(n) { return Number(n) || 0; }
  function r1(n) { return D.round(n, 1); }
  function r2(n) { return D.round(n, 2); }
  function r4(n) { return D.round(n, 4); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function money(n) {
    return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmt0(n) { return Math.round(num(n)).toLocaleString("en-US"); }
  // Backend-style ISO timestamp (datetime.isoformat() + "Z", no millis).
  function isoZ(d) { return d.toISOString().replace(/\.\d{3}Z$/, "Z"); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function addMin(d, n) { return new Date(d.getTime() + n * 60000); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "offtaker"; }
  function notFound(detail) { return D.json({ detail: detail || "Not found" }, 404); }
  function R(p) { return new RegExp("^\\/v1\\/array-operator\\/billing" + p + "$"); }

  var MON = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var PROV_LABEL = {
    gmp: "Green Mountain Power", vec: "Vermont Electric Coop", wec: "Washington Electric Coop",
    eversource: "Eversource", cmp: "Central Maine Power",
  };
  function provTag(p) { p = String(p || "").toLowerCase(); return p === "gmp" ? "GMP" : p.length <= 6 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1); }

  var NOW = new Date();
  var SENDER = "hello@arrayoperator.com";   // branding.from_address("array_operator")
  var DL_DETAIL = "This is a sample account, so files can't be downloaded. " +
    "Start free to get your own.";

  // ── Billing-cycle calendar ───────────────────────────────────────────────
  // Cycle k: k = 0 is the last full calendar month (AO_DEMO.periodLabel — the
  // drafts awaiting approval), k = 1 the month before (the newest cycle that has
  // gone out), and so on back.
  function cStart(k) { return new Date(NOW.getFullYear(), NOW.getMonth() - 1 - k, 1); }
  function cEnd(k) { return new Date(NOW.getFullYear(), NOW.getMonth() - k, 0); }
  function cKey(k) { return D.isoMonth(cStart(k)); }
  function cLabel(k) { return D.isoDate(cStart(k)) + " → " + D.isoDate(cEnd(k)); }   // mailroom._period_label
  function cPretty(k) { var d = cStart(k); return MON[d.getMonth()] + " " + d.getFullYear(); }
  var LATEST_SENT = 1;      // newest invoiced cycle
  var FROZEN_CYCLES = 3;    // k = 1..3 carry frozen evidence (OfftakerInvoice rows)
  var LEGACY_CYCLES = 2;    // k = 4..5 were sent before frozen evidence existed

  // The monthly scheduler run: the 1st at 09:00 UTC (mailroom.next_month_first).
  function autoSentAt(k, seq) {
    var s = cStart(k);
    return new Date(Date.UTC(s.getFullYear(), s.getMonth() + 2, 1, 9, (seq * 3) % 50, (seq * 17) % 60));
  }
  // Approval offtakers: drafted when the settled bill lands, approved by Dana
  // about three weeks after the period closes.
  function approvedAt(k, id) {
    var e = cEnd(k);
    return new Date(e.getFullYear(), e.getMonth(), e.getDate() + 18 + (id % 7), 9 + (id % 8), (id * 13) % 60);
  }
  function nextMonthFirst() {
    var y = NOW.getUTCFullYear(), m = NOW.getUTCMonth();
    if (NOW.getUTCDate() === 1 && NOW.getUTCHours() < 9) return new Date(Date.UTC(y, m, 1, 9, 0, 0));
    return new Date(Date.UTC(y, m + 1, 1, 9, 0, 0));
  }
  function dayLabel(d) { return MON3[d.getUTCMonth()] + " " + d.getUTCDate(); }

  // ── Generation ───────────────────────────────────────────────────────────
  // An array's billed pool for a cycle IS its AO_DEMO_API.monthly() kWh for that
  // calendar month (demo-data.js prices every offtaker as share × the LAST
  // settled month of the same history), so seasons, weather and the story's
  // faults run through every invoice and the cycle-0 figures equal AO_DEMO's.
  var HISTORY_MONTHS = 40;
  function arrName(id) { var s = D.site(id); return s ? s.name : "Array " + id; }
  var _mm = {};
  function monthlyMap(id) {
    if (_mm[id]) return _mm[id];
    var m = {};
    D.monthly(id, HISTORY_MONTHS).forEach(function (r) { m[r.month] = r.kwh; });
    return (_mm[id] = m);
  }
  function arrayKwh(id, k) { return num(monthlyMap(id)[cKey(k)]); }
  function discOf(s) { var d = num(s.resolved_discount_pct); return d > 0 && d < 1 ? d : 0; }
  function effRate(s) { return D.round(rate() * (1 - discOf(s)), 6); }   // pricing["effective_rate"]

  // ── The sample book (built once, deterministic) ─────────────────────────
  var _m = null;
  function model() {
    if (_m) return _m;
    var subs = (A().offtakers || []).slice().sort(function (a, b) { return a.id - b.id; });
    var byId = {}, ua = {};
    subs.forEach(function (s) { byId[s.id] = s; });
    (A().utilAccounts || []).forEach(function (u) { ua[u.utility_account_id] = u; });

    // auto: auto-send, invoiced last cycle · approval: draft for approval ·
    // new: auto-send, first invoice still to come · paused: disabled.
    function klass(s) {
      if (!s.enabled) return "paused";
      if (s.delivery_mode === "auto") return s.last_sent_at ? "auto" : "new";
      return "approval";
    }
    var cls = {};
    subs.forEach(function (s) { cls[s.id] = klass(s); });

    // AO_DEMO drafts carry no subscription id; name + email + amount is unique.
    var drafts = (A().drafts || []).map(function (d) {
      var sub = null;
      for (var i = 0; i < subs.length; i++) {
        var s = subs[i];
        if (s.customer_name === d.customer_name && s.client_email === d.client_email &&
            num(s._demo_amount) === num(d.amount_usd)) { sub = s; break; }
      }
      var r = D.rng("draft:" + d.id);
      var made = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 3 - Math.floor(r() * 6),
        8 + Math.floor(r() * 9), Math.floor(r() * 60));
      return { d: d, sub: sub, sid: sub ? sub.id : null, created: made };
    });
    var draftBySub = {};
    drafts.forEach(function (x) { if (x.sid != null) draftBySub[x.sid] = x; });

    // When each invoiced offtaker joined (drives Invoice trends' history and
    // growth); everyone has at least the frozen + legacy cycles.
    var joinK = {};
    subs.forEach(function (s) {
      if (cls[s.id] !== "auto" && cls[s.id] !== "approval") return;
      var r = D.rng("join:" + s.id)();
      joinK[s.id] = FROZEN_CYCLES + LEGACY_CYCLES + Math.floor(r * 28);   // back to ~2024
    });

    // invoice = kWh × net rate × (1 − discount) (delivery.resolve_discount_pricing);
    // cycle 0 reproduces AO_DEMO's _demo_kwh / _demo_amount exactly.
    function figures(s, k) {
      var pool = arrayKwh(s.array_id, k);
      var kwh = k === 0 && s._demo_kwh != null ? num(s._demo_kwh) : Math.max(1, Math.round(pool * num(s.allocation_pct)));
      var amount = k === 0 && s._demo_amount != null ? num(s._demo_amount) : r2(kwh * rate() * (1 - discOf(s)));
      return { kwh: kwh, amount: amount, array_kwh: pool };
    }

    // ── Bill audit catches (GMP group net-metering only) ──────────────────
    function pick(arrayId, nth) {
      var c = subs.filter(function (s) {
        return Number(s.array_id) === arrayId && s._provider === "gmp" && cls[s.id] === "auto";
      }).sort(function (a, b) { return (b.allocation_pct - a.allocation_pct) || (a.id - b.id); });
      return c[Math.min(nth, c.length - 1)] || null;
    }
    // Kettle Pond: GMP keyed one offtaker's credit short (a transposed figure)
    // AND the host bill's own arithmetic is off (generated − host consumed ≠
    // Group Excess Shared). Birch Hollow: one offtaker credited from a base that
    // is on neither bill (the backend's own worked example, on sample numbers).
    var catches = [];
    var kp = pick(2, 0), bh = pick(1, 1);
    if (kp) catches.push({ sid: kp.id, array_id: 2, kind: "short" });
    if (bh) catches.push({ sid: bh.id, array_id: 1, kind: "over" });
    var catchBySub = {};
    catches.forEach(function (c) { catchBySub[c.sid] = c; });

    // The one invoice still unpaid well past due (a reminder is due).
    var lateSub = pick(4, 0) || pick(5, 0);
    var lateKey = lateSub ? lateSub.id + ":2" : null;

    // ── Sent history (frozen + legacy), chronological ids ─────────────────
    var invoices = [], legacy = [], history = [];
    var invSeq = 41000, legSeq = 30400;
    var autoSubs = subs.filter(function (s) { return cls[s.id] === "auto"; });
    var apprSubs = subs.filter(function (s) { return cls[s.id] === "approval"; });
    var maxJoin = 0;
    subs.forEach(function (s) { if (joinK[s.id] > maxJoin) maxJoin = joinK[s.id]; });
    for (var k = maxJoin; k >= LATEST_SENT; k--) {
      var batch = [];
      autoSubs.forEach(function (s, i) { if (joinK[s.id] >= k) batch.push({ s: s, at: autoSentAt(k, i) }); });
      apprSubs.forEach(function (s) { if (joinK[s.id] >= k) batch.push({ s: s, at: approvedAt(k, s.id) }); });
      batch.sort(function (a, b) { return a.at - b.at || a.s.id - b.s.id; });
      batch.forEach(function (b) {
        var f = figures(b.s, k);
        var h = { sid: b.s.id, k: k, kwh: f.kwh, amount: f.amount, array_kwh: f.array_kwh, at: b.at };
        history.push(h);
        if (k <= FROZEN_CYCLES) { h.id = ++invSeq; invoices.push(h); }
        else if (k <= FROZEN_CYCLES + LEGACY_CYCLES) { h.legacy_id = ++legSeq; legacy.push(h); }
      });
    }
    // Payment state per frozen invoice (online pay link; ~1 in 9 by check).
    invoices.forEach(function (h) {
      var r = D.rng("pay:" + h.id);
      var age = (NOW - h.at) / 86400000;
      var key = h.sid + ":" + h.k;
      var roll = r(), roll2 = r();
      if (key === lateKey) h.pay = "open";
      else if (age > 28) h.pay = roll < 0.89 ? "online" : "check";
      else h.pay = roll < 0.55 ? "online" : "open";
      if (h.pay === "online") h.paid_at = addMin(h.at, Math.round((1 + roll2 * Math.min(16, Math.max(1, age - 1))) * 1440));
      if (h.pay === "check") h.paid_at = addDays(h.at, 6 + Math.floor(roll2 * 12));
      if (h.paid_at && h.paid_at > NOW) h.paid_at = addMin(NOW, -90);
      h.delivered_at = new Date(h.at.getTime() + (25 + Math.floor(r() * 110)) * 1000);
    });
    invoices.sort(function (a, b) { return b.at - a.at || b.id - a.id; });   // newest first
    legacy.sort(function (a, b) { return b.at - a.at || b.legacy_id - a.legacy_id; });
    var invById = {}, legById = {}, subLegacy = {};
    invoices.forEach(function (h) { invById[h.id] = h; });
    legacy.forEach(function (h) { legById[h.legacy_id] = h; });

    _m = {
      subs: subs, byId: byId, ua: ua, cls: cls, drafts: drafts, draftBySub: draftBySub,
      figures: figures, catches: catches, catchBySub: catchBySub, lateKey: lateKey,
      invoices: invoices, legacy: legacy, history: history, invById: invById, legById: legById,
      subLegacy: subLegacy, joinK: joinK,
    };
    return _m;
  }

  function utilView(s) {
    var u = model().ua[s.utility_account_id];
    if (!u) return null;
    return { utility_account_id: u.utility_account_id, provider: u.provider,
      account_number: u.account_number, nickname: u.nickname };
  }
  function lastSent(s) {
    // The subscription's last-send stamps, as the backend columns would hold them.
    var M = model();
    if (M.cls[s.id] !== "auto" && M.cls[s.id] !== "approval") return null;
    var hs = M.invoices.filter(function (h) { return h.sid === s.id; });
    return hs.length ? hs[0] : null;     // newest first
  }
  function invNo(s, k) { return "NCS-" + cKey(k).replace("-", "") + "-" + s.id; }
  function attachNames(s, k) {
    var sl = slug(s.customer_name), no = invNo(s, k);
    var p = String(s._provider || "gmp").toLowerCase();
    return ["invoice_" + sl + "_" + no + ".pdf", (p === "gmp" ? "gmp" : p) + "_utility_bill_" + sl + "_" + no + ".pdf"];
  }
  function isOrg(s) {
    var n = String(s.customer_name || "");
    return /@example\.coop$/i.test(s.client_email || "") || /&/.test(n) || n.split(/\s+/).length >= 4;
  }
  function subject(s, no) { return "Your solar credit invoice — " + s.customer_name + " (" + no + ")"; }
  function fromAddr() { return '"' + (acct().company_name || "Northeast Community Solar") + '" <' + SENDER + ">"; }

  // A sample pay link opens a short, honest page instead of a dead Stripe URL.
  var _payPage;
  function samplePayUrl() {
    if (_payPage !== undefined) return _payPage;
    _payPage = null;
    try {
      var html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<title>Sample pay link</title><style>body{margin:0;background:#EEF4FB;font:16px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937}" +
        "main{max-width:540px;margin:12vh auto;padding:32px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(20,60,120,.10)}" +
        "h1{font-size:22px;margin:0 0 10px}p{margin:10px 0}.m{color:#6b7280;font-size:14px}a{color:#1976D2;font-weight:700}</style></head><body><main>" +
        "<h1>This is a sample pay link</h1>" +
        "<p>In a live account, the <b>Pay invoice</b> button on every offtaker invoice opens a secure Stripe checkout for the amount due. " +
        "Offtakers pay by bank debit or card and the money lands in the operator&rsquo;s bank account.</p>" +
        "<p class=\"m\">Array Operator keeps 0.5% of each online payment. Stripe&rsquo;s processing fee also applies: bank debit (ACH) 0.8%, capped at $5; card 2.9% + 30&cent;. Checks and other offline payments have no fee.</p>" +
        "<p><a href=\"/onboarding\" target=\"_blank\" rel=\"noopener\">Start free &rarr;</a></p></main></body></html>";
      _payPage = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    } catch (e) { _payPage = null; }
    return _payPage;
  }

  // ── Mail room: one sent invoice (mailroom._sent_item shape) ─────────────
  function sentItem(h) {
    var M = model(), s = M.byId[h.sid], k = h.k, no = invNo(s, k);
    var amount = h.amount, pay = null, settled = 0, gross = 0;
    if (h.pay === "online") {
      pay = { payment_id: h.id + 9000, status: "paid", paid_at: isoZ(h.paid_at), amount_usd: amount,
        fee_usd: r2(amount * 0.005), refunded_usd: 0, pay_url: null };
      gross = amount;
    } else if (h.pay === "check") {
      pay = { payment_id: h.id + 9000, status: "expired", paid_at: null, amount_usd: amount,
        fee_usd: 0, refunded_usd: 0, pay_url: null };
      settled = amount; gross = amount;
    } else {
      pay = { payment_id: h.id + 9000, status: "open", paid_at: null, amount_usd: amount,
        fee_usd: 0, refunded_usd: 0, pay_url: samplePayUrl() };
    }
    var outstanding = r2(Math.max(amount - gross, 0));
    var summary = outstanding <= 0.005 ? "paid" : (gross > 0 ? "partial" : "unpaid");
    var names = attachNames(s, k);
    return {
      id: h.id, legacy: false, kind: "invoice", subscription_id: s.id,
      customer_name: s.customer_name, invoice_number: no, status: "accepted",
      sent_at: isoZ(h.at), period_key: cKey(k), period_label: cLabel(k),
      period_start: D.isoDate(cStart(k)), period_end: D.isoDate(cEnd(k)),
      amount_usd: amount, credit_applied_usd: null, kwh: h.kwh, array_kwh: h.array_kwh,
      allocation_pct: s.allocation_pct, array_share_pct: null,
      rate: { net_rate_per_kwh: rate(), effective_rate_per_kwh: effRate(s), adder_per_kwh: null,
        discount_pct: discOf(s) || null, source: "offtaker rate", note: null, operator_entered: true },
      kwh_source: "utility_bill", billing_basis: "real_math", has_utility_bill: true,
      utility: utilView(s), arrays: [s.array_name || arrName(s.array_id)],
      to: [s.client_email], cc: [], bcc: [acct().email || "dana@northeastsolar.coop"],
      from_addr: fromAddr(), reply_to: acct().email || null, subject: subject(s, no),
      attachments: names,
      dispatch: { status: "accepted", attempts: 1, resend_email_id: null, error: null, retry_at: null },
      delivery: { status: "delivered", delivered_at: isoZ(h.delivered_at), bounced_at: null, reason: null },
      payment: pay, offline_settled_usd: settled, paid_usd: r2(gross), refunded_usd: 0,
      outstanding_usd: outstanding, payment_summary: summary, warnings: [],
      send_mode: s.send_mode || "to_client", delivery_mode: s.delivery_mode, cadence: s.cadence || "monthly",
    };
  }
  function legacyItem(h) {
    var M = model(), s = M.byId[h.sid], k = h.k;
    return {
      id: "legacy:draft:" + h.legacy_id, legacy: true, kind: "invoice", subscription_id: s.id,
      customer_name: s.customer_name, invoice_number: invNo(s, k), status: "accepted",
      sent_at: isoZ(h.at), period_key: null, period_label: cLabel(k), period_start: null, period_end: null,
      amount_usd: h.amount, credit_applied_usd: null, kwh: h.kwh, array_kwh: null,
      allocation_pct: s.allocation_pct, array_share_pct: null,
      rate: { net_rate_per_kwh: rate(), effective_rate_per_kwh: null, adder_per_kwh: null,
        discount_pct: discOf(s) || null, source: null, note: "issued before frozen evidence existed", operator_entered: null },
      kwh_source: null, billing_basis: null, has_utility_bill: null,
      utility: utilView(s), arrays: [s.array_name || arrName(s.array_id)],
      to: [s.client_email], cc: [], bcc: [], from_addr: null, reply_to: null, subject: null,
      attachments: [], dispatch: null,
      delivery: { status: "accepted", delivered_at: null, bounced_at: null, reason: null },
      payment: null, offline_settled_usd: 0, paid_usd: 0, outstanding_usd: null,
      payment_summary: "not_tracked", warnings: [], send_mode: s.send_mode || "to_client",
      delivery_mode: s.delivery_mode, cadence: s.cadence || "monthly",
    };
  }

  // ── The invoice email (delivery._email_html + the AO sky skin) ───────────
  function emailHtml(s, k, kwh, amount, arrayKwh_, withPay) {
    var op = acct().company_name || "Northeast Community Solar";
    var signer = acct().operator_name || "Dana Whitcomb";
    var opEmail = acct().email || "";
    var first = String(s.customer_name || "").split(/\s+/)[0];
    var greet = isOrg(s) ? "Dear " + s.customer_name : "Hi " + first;
    var gmp = String(s._provider || "gmp").toLowerCase() === "gmp";
    var attLine = gmp
      ? "Your full invoice is attached, along with the GMP source bill behind it (so you can see exactly how the amount was calculated)."
      : "Your full invoice is attached.";
    var period = cLabel(k), amt = money(amount);
    var row = function (l, v, strong) {
      var p = strong ? "10px" : "6px";
      return '<tr><td style="padding:' + p + ' 0;color:#4C596B;font-size:13px;">' + esc(l) + "</td>" +
        '<td style="padding:' + p + ' 0;text-align:right;font-size:14px;' + (strong ? "font-weight:800;color:#1976D2;" : "color:#0E1420;") + '">' + esc(v) + "</td></tr>";
    };
    var pay = withPay
      ? '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 22px;border-collapse:separate;"><tr><td align="center" style="background:linear-gradient(180deg,#EAF4FD 0%,#D9E7FB 100%);background-color:#D9E7FB;border:1px solid rgba(33,150,243,.28);border-radius:16px;padding:20px 18px 16px;">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#1976D2;margin:0 0 6px;">Amount due</div>' +
        '<div style="font-size:32px;font-weight:800;letter-spacing:-.02em;color:#0E1420;line-height:1.1;margin:0 0 14px;">' + amt + "</div>" +
        '<span style="display:inline-block;background:linear-gradient(180deg,#42A5F5,#2196F3);color:#ffffff;padding:14px 28px;border-radius:12px;font-weight:800;font-size:16px;">Pay invoice securely &rarr;</span>' +
        '<div style="font-size:12px;color:#4C596B;margin-top:12px;line-height:1.4;">Secure card payment &middot; due within 28 days &middot; powered by Stripe</div></td></tr></table>'
      : "";
    var letter = "<p>" + esc(greet) + ",</p><p>Attached is your solar credit invoice for " + esc(period) +
      ". Your share of the array's production this period came to <strong>" + fmt0(kwh) + " kWh</strong>, for a total of <strong>" + amt + "</strong>.</p>" +
      "<p>" + esc(attLine) + " If anything looks off, just reply to this email and we'll take a look together.</p>" +
      "<p>Thanks for going solar!</p><p>Thank you,<br>" + esc(signer) + (opEmail ? "<br>" + esc(opEmail) : "") + "</p>";
    var figs = '<table width="100%" style="font-size:14px;border-collapse:collapse;margin-top:8px;">' +
      row("Billing period", period) +
      (arrayKwh_ ? row("Array generation (Group Excess Shared)", fmt0(arrayKwh_) + " kWh") + row("Your share", (num(s.allocation_pct) * 100).toFixed(2) + "%") : "") +
      row("Your production", fmt0(kwh) + " kWh") +
      row("Solar credit rate", "$" + effRate(s).toFixed(5) + "/kWh") +
      row("Solar credit value due", amt, true) + "</table>";
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your solar credit invoice</title></head>' +
      '<body style="margin:0;padding:0;background:#EEF4FB;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:linear-gradient(180deg,#CFE3F7 0%,#EEF4FB 60%);padding:32px 12px;"><tr><td align="center">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="580" role="presentation" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #DCE6F2;border-radius:18px;box-shadow:0 18px 50px -12px rgba(20,60,120,.18);overflow:hidden;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
      '<tr><td style="background:linear-gradient(135deg,#2196F3,#1565C0);padding:26px 34px;border-bottom:3px solid #90CAF9;">' +
      '<div style="font-size:22px;font-weight:700;color:#ffffff;line-height:1.25;">Your solar credit invoice</div>' +
      '<div style="font-size:13px;color:#E3F2FD;margin-top:8px;">From ' + esc(op) + "</div></td></tr>" +
      '<tr><td style="padding:28px 34px;color:#0E1420;font-size:14px;line-height:1.55;">' + pay + letter + figs + "</td></tr>" +
      '<tr><td style="padding:16px 34px 24px;border-top:1px solid #EEF2F7;font-size:11.5px;color:#7A8899;">Sent by ' + esc(op) + " with Array Operator &middot; Questions? Just reply to this email.</td></tr>" +
      "</table></td></tr></table></body></html>";
  }
  function emailText(s, k, kwh, amount) {
    return "Billing period: " + cLabel(k) + "\nYour production: " + fmt0(kwh) + " kWh\nSolar credit value due: " + money(amount) +
      "\n\nQuestions? Just reply to this email.";
  }

  // Host-bill anatomy for a GMP array's cycle (group_host_bill.bill_anatomy).
  function anatomy(arrayId, k) {
    var excess = arrayKwh(arrayId, k);
    var r = D.rng("anat:" + arrayId + ":" + cKey(k));
    var consumed = Math.round(excess * (0.011 + r() * 0.012));
    var gen = excess + consumed;
    var warnings = [];
    if (arrayId === 2 && k === 0) {
      // The Kettle Pond catch: the bill's Generated − Host consumed doesn't equal
      // the Group Excess Shared it allocates from.
      gen = excess + consumed + 418;
      warnings.push("Generated (" + fmt0(gen) + ") − host consumed (" + fmt0(consumed) + ") = " +
        fmt0(gen - consumed) + " kWh, but Group Excess Shared is " + fmt0(excess) + " kWh — differs by more than 1 kWh.");
    }
    return {
      generated_kwh: r1(gen), host_consumed_kwh: r1(consumed), group_excess_shared_kwh: excess,
      group_excess_source: "kwh_sent_to_grid", net_billed_kwh: 0, fixed_charges_usd: r2(17.5 + r() * 4),
      kwh_sent_to_grid_raw: excess, period_start: D.isoDate(cStart(k)), period_end: D.isoDate(cEnd(k)),
      is_group_host_signal: true, warnings: warnings,
    };
  }

  function invoiceDetail(h) {
    var M = model(), s = M.byId[h.sid], it = sentItem(h);
    var gmp = String(s._provider || "gmp") === "gmp";
    var names = attachNames(s, h.k);
    var r = D.rng("att:" + h.id);
    it.figures = {
      invoice_number: it.invoice_number, period_start: it.period_start, period_end: it.period_end,
      kwh: h.kwh, project_total_kwh: h.array_kwh, allocation_pct: s.allocation_pct,
      net_rate_per_kwh: rate(), discount_pct: discOf(s), effective_rate_per_kwh: effRate(s), amount_owed: h.amount,
      kwh_source: "utility_bill", billing_basis: "real_math", has_utility_bill: true,
    };
    it.bill_anatomy = gmp ? anatomy(s.array_id, h.k) : null;
    it.project_totals = null;
    it.email = { subject: it.subject, html: emailHtml(s, h.k, h.kwh, h.amount, h.array_kwh, true),
      text: emailText(s, h.k, h.kwh, h.amount), from_addr: it.from_addr, reply_to: it.reply_to };
    it.attachment_files = [
      { filename: names[0], size_bytes: 38000 + Math.floor(r() * 9000), sha256: null },
      { filename: names[1], size_bytes: 146000 + Math.floor(r() * 64000), sha256: null },
    ];
    it.settlements = h.pay === "check" ? [{
      id: h.id + 70000, amount_usd: h.amount, received_on: D.isoDate(h.paid_at), method: "check",
      actor: "operator", note: "Check #" + (1100 + (h.id % 900)), created_at: isoZ(addMin(h.paid_at, 30)),
    }] : [];
    it.prepared_at = isoZ(addMin(h.at, -3));
    it.last_error = null;
    it.subscription = subContext(s);
    return it;
  }
  function legacyDetail(h) {
    var M = model(), s = M.byId[h.sid], it = legacyItem(h);
    it.array_kwh = h.array_kwh;
    it.figures = { amount_owed: h.amount, kwh: h.kwh, project_total_kwh: h.array_kwh,
      allocation_pct: s.allocation_pct, invoice_number: it.invoice_number, period_label: it.period_label,
      note: "", gmp_attachment: null };
    // The archive still holds most of these emails; the rest predate it.
    var kept = D.rng("legacy-mail:" + h.legacy_id)() < 0.7;
    it.email = kept
      ? { subject: subject(s, it.invoice_number), html: emailHtml(s, h.k, h.kwh, h.amount, null, false),
        text: emailText(s, h.k, h.kwh, h.amount), from_addr: fromAddr(), reply_to: null }
      : { subject: null, html: null, text: null, from_addr: null, reply_to: null };
    if (kept) { it.subject = it.email.subject; it.from_addr = it.email.from_addr; }
    it.attachment_files = []; it.settlements = []; it.prepared_at = null; it.last_error = null;
    it.evidence = "legacy";
    it.subscription = subContext(s);
    return it;
  }
  function subContext(s) {
    var ls = lastSent(s);
    return {
      subscription_id: s.id, customer_name: s.customer_name, client_email: s.client_email,
      cc_emails: [], operator_email: s.operator_email, send_mode: s.send_mode || "to_client",
      delivery_mode: s.delivery_mode, cadence: s.cadence || "monthly", enabled: !!s.enabled,
      allocation_pct: s.allocation_pct, array_share_pct: null, rate_per_kwh: null,
      net_rate_per_kwh: s.net_rate_per_kwh, net_rate_adder_per_kwh: null, discount_pct: discOf(s),
      budget_amount_usd: null, pending_credit_usd: null,
      last_sent_at: ls ? isoZ(ls.at) : null, last_sent_period_end: ls ? D.isoDate(cEnd(ls.k)) : null,
      last_sent_amount_usd: ls ? ls.amount : null, last_invoice_number: ls ? invNo(s, ls.k) : null,
      last_resend_email_id: null, last_delivered_at: ls ? isoZ(ls.delivered_at) : null,
      last_bounced_at: null, last_bounce_reason: null, next_send_at: isoZ(nextMonthFirst()),
      utility: utilView(s), arrays: [s.array_name || arrName(s.array_id)],
    };
  }

  // ── Mail room: the going-out side (mailroom.outgoing_items) ──────────────
  function outgoing() {
    var M = model(), items = [], covered = {};
    M.drafts.forEach(function (x) {
      var s = x.sub, d = x.d;
      if (s) covered[s.id] = true;
      items.push({
        kind: "draft", draft_id: d.id, invoice_id: null, subscription_id: x.sid,
        customer_name: d.customer_name, email: d.client_email, send_mode: d.send_mode || "to_client",
        delivery_mode: s ? s.delivery_mode : null, cadence: d.cadence || "monthly",
        period_label: d.period_label, amount_usd: d.amount_usd, kwh: d.customer_kwh,
        invoice_number: d.invoice_number, utility: s ? utilView(s) : null,
        arrays: s ? [s.array_name || arrName(s.array_id)] : [],
        when: null, when_label: "On your approval", status: "awaiting_approval", reason: null,
        created_at: isoZ(x.created), sort: 0,
      });
    });
    var fire = nextMonthFirst();
    M.subs.forEach(function (s) {
      if (covered[s.id] || !s.enabled) return;
      var auto = s.delivery_mode === "auto";
      var ls = lastSent(s);
      items.push({
        kind: "scheduled", draft_id: null, invoice_id: null, subscription_id: s.id,
        customer_name: s.customer_name, email: s.client_email, send_mode: s.send_mode || "to_client",
        delivery_mode: s.delivery_mode, cadence: s.cadence || "monthly", period_label: null,
        amount_usd: ls ? ls.amount : null, amount_is_estimate: true, kwh: null, invoice_number: null,
        utility: utilView(s), arrays: [s.array_name || arrName(s.array_id)],
        when: isoZ(fire), when_label: auto ? dayLabel(fire) + ", 09:00 UTC · auto-send" : dayLabel(fire) + " draft, then your approval",
        status: auto ? "auto" : "approval", reason: null, created_at: null, sort: 2,
      });
    });
    items.sort(function (a, b) {
      return (a.sort - b.sort) || String(a.when || "").localeCompare(String(b.when || "")) ||
        String(a.customer_name || "").toLowerCase().localeCompare(String(b.customer_name || "").toLowerCase());
    });
    return items;
  }

  function board(limit, offset, withLegacy) {
    var M = model();
    limit = Math.max(1, Math.min(limit || 300, 1000));
    offset = Math.max(0, offset || 0);
    var page = M.invoices.slice(offset, offset + limit).map(sentItem);
    var leg = withLegacy && offset === 0 ? M.legacy.map(legacyItem) : [];
    var all = page.concat(leg);
    var out = outgoing();
    var allFrozen = M.invoices.map(sentItem);
    function cnt(list, fn) { var n = 0; list.forEach(function (x) { if (fn(x)) n++; }); return n; }
    var counts = {
      outgoing: out.length,
      drafts: cnt(out, function (x) { return x.kind === "draft"; }),
      held: cnt(out, function (x) { return ["held", "retrying", "unconfirmed", "prepared"].indexOf(x.kind) >= 0; }),
      scheduled: cnt(out, function (x) { return x.kind === "scheduled"; }),
      sent_total: M.invoices.length + (withLegacy ? M.legacy.length : 0),
      sent_frozen: M.invoices.length,
      sent_legacy: withLegacy ? M.legacy.length : 0,
      bounced: 0, unconfirmed: 0,
      paid: cnt(all, function (x) { return x.payment_summary === "paid"; }),
      unpaid: cnt(all, function (x) { return x.payment_summary === "unpaid" || x.payment_summary === "partial"; }),
      billed_usd: r2(all.reduce(function (n, x) { return n + num(x.amount_usd); }, 0)),
      collected_usd: r2(all.reduce(function (n, x) { return n + num(x.paid_usd); }, 0)),
    };
    // portfolio_counts: global KPIs over every frozen invoice, not just this page.
    var portfolio = {
      paid: cnt(allFrozen, function (x) { return x.payment_summary === "paid"; }),
      unpaid: cnt(allFrozen, function (x) { return x.payment_summary === "unpaid" || x.payment_summary === "partial"; }),
      unconfirmed: 0, bounced: 0,
      billed_usd: r2(allFrozen.reduce(function (n, x) { return n + num(x.amount_usd); }, 0)),
      collected_usd: r2(allFrozen.reduce(function (n, x) { return n + num(x.paid_usd); }, 0)),
    };
    var pageCounts = Object.assign({}, counts, { sent_total: all.length, sent_frozen: page.length, sent_legacy: leg.length });
    return {
      ok: true, generated_at: isoZ(new Date()), paused: false,
      outgoing: out, sent: all, counts: Object.assign({}, counts, portfolio), page_counts: pageCounts,
      counts_scope: "portfolio_frozen_invoices", legacy_scope: "first_page_only",
      has_more: offset + page.length < M.invoices.length, limit: limit, offset: offset,
    };
  }

  // ── Bill audit + reconcile (reconcile_bills.audit_by_array / reconcile_tenant) ─
  function allocationFor(s) {
    // _allocation_check for a GMP offtaker against the latest settled bill.
    var M = model();
    var excess = arrayKwh(s.array_id, 0);
    var share = num(s.allocation_pct);
    if (!share) return { status: "no_share", note: "No share % entered for this offtaker — enter their share of the array to cross-check GMP's allocation." };
    var should = r1(excess * share);
    // GMP's own credit = the kWh the offtaker was billed on (AO_DEMO's _demo_kwh,
    // share × the bill's pool, whole kWh), except where GMP got it wrong.
    var credited = s._demo_kwh != null ? num(s._demo_kwh) : Math.round(should);
    var c = M.catchBySub[s.id];
    if (c && c.kind === "short") credited = Math.round(should) - 54;     // a transposed credit
    if (c && c.kind === "over") credited = Math.round(should) + Math.max(24, Math.round(should * 0.05));
    var delta = r2(credited - should);
    var implied = r1(credited / share);
    var dollars = r2(Math.abs(delta) * rate());
    var out = {
      status: Math.abs(delta) <= 2 ? "match" : "mismatch",
      offtaker_credited_kwh: r1(credited), expected_kwh: should, delta_kwh: delta,
      implied_group_total_kwh: implied, array_group_excess_kwh: r1(excess),
      credit_rate: r4(rate()), delta_dollars: dollars,
      per_array: [{ array_id: s.array_id, array_excess_kwh: r1(excess), share: r4(share), expected_kwh: should }],
    };
    if (out.status === "mismatch") {
      out.at_stake_usd = 25;
      out.note = "GMP credited this offtaker " + fmt0(credited) + " kWh — at the " + (share * 100).toFixed(2) +
        "% share you entered that implies a group total of " + fmt0(implied) + " kWh, but the array's bill shows " +
        fmt0(excess) + " kWh (off by " + fmt0(Math.abs(delta)) + " kWh ≈ " + money(dollars) +
        "). Either the entered share is slightly off, or GMP allocated from a base that appears on neither bill — worth a look: GMP credits $25 per billing error they made.";
    } else {
      out.note = "GMP's allocation (" + fmt0(credited) + " kWh) matches this offtaker's share of the array's group excess (" + fmt0(should) + " kWh).";
    }
    return out;
  }
  function auditByArray() {
    var M = model(), arrays = {}, flagged = 0, dollars = 0;
    M.subs.slice().sort(function (a, b) { return String(a.customer_name).localeCompare(String(b.customer_name)); })
      .forEach(function (s) {
        if (String(s._provider) !== "gmp") return;    // GMP group net-metering only
        var aid = Number(s.array_id);
        var a = allocationFor(s);
        var e = arrays[aid];
        if (!e) {
          var anat = anatomy(aid, 0);
          e = arrays[aid] = { array_id: aid, array_name: arrName(aid), provider: "gmp",
            group_excess_kwh: anat.group_excess_shared_kwh, credit_rate: a.credit_rate || r4(rate()),
            bill_anatomy: anat, flagged: 0, offtakers: [] };
        }
        if (a.status === "mismatch") { e.flagged++; flagged++; dollars += num(a.delta_dollars); }
        e.offtakers.push({
          sub_id: s.id, customer_name: s.customer_name, share_pct: s.allocation_pct ? r4(s.allocation_pct) : null,
          gmp_credited_kwh: a.offtaker_credited_kwh, should_be_kwh: a.expected_kwh, delta_kwh: a.delta_kwh,
          delta_dollars: a.delta_dollars, at_stake_usd: a.at_stake_usd, status: a.status, note: a.note,
        });
      });
    var list = Object.keys(arrays).map(function (k) { return arrays[k]; })
      .sort(function (a, b) { return a.array_name.localeCompare(b.array_name); });
    var offN = list.reduce(function (n, e) { return n + e.offtakers.length; }, 0);
    return { ok: true, utilities: list.length ? [{ provider: "gmp", arrays: list }] : [],
      totals: { arrays: list.length, offtakers: offN, flagged: flagged, dollars_flagged: r2(dollars), at_stake_usd: r2(flagged * 25) } };
  }
  function reconcile() {
    var M = model(), counts = {}, alloc = {}, dollars = 0, gmpN = 0;
    var rows = M.subs.map(function (s) {
      var prov = String(s._provider || "gmp");
      var excess = arrayKwh(s.array_id, 0);
      var arrRow = { array_id: s.array_id, array_name: arrName(s.array_id), our_kwh: r1(excess), gmp_kwh: r1(excess),
        delta_kwh: 0, delta_pct: 0, status: "match", mismatch_reason: null,
        gmp_bill_period: D.isoDate(cStart(0)) + " → " + D.isoDate(cEnd(0)), gmp_total_cost: null };
      var allocation = prov === "gmp" ? allocationFor(s)
        : { status: "not_gmp", note: "Bill audit runs only for offtakers bound to a GMP utility account — this offtaker's account is " + prov + "." };
      if (allocation.status !== "not_gmp") gmpN++;
      if (allocation.status === "mismatch") dollars += num(allocation.delta_dollars);
      counts.match = (counts.match || 0) + 1;
      alloc[allocation.status] = (alloc[allocation.status] || 0) + 1;
      return { sub_id: s.id, customer_name: s.customer_name, from_workbook: false,
        invoice_period: D.isoDate(cStart(0)) + " → " + D.isoDate(cEnd(0)),
        arrays: [arrRow], overall_status: "match", allocation: allocation, provider: prov };
    });
    return { ok: true, subscription_count: rows.length, gmp_offtaker_count: gmpN, status_counts: counts,
      allocation_counts: alloc, allocation_flagged: alloc.mismatch || 0,
      allocation_dollars_flagged: r2(dollars), allocation_at_stake_usd: r2((alloc.mismatch || 0) * 25),
      subscriptions: rows };
  }

  // ── Mail room audit (mailroom_audit.deterministic_checks + a scripted review) ─
  var RUNS = [];
  var RUN_SEQ = 5200;
  var CHECK_MS = 2400, DEEP_MS = 6500;
  function targets(code, sid, invoiceId, draftId) {
    var t = [];
    if (invoiceId != null) t.push({ kind: "invoice", id: invoiceId, label: "Open invoice" });
    if (draftId != null) t.push({ kind: "draft", id: draftId, subscription_id: sid, label: "Open draft" });
    if (sid != null) t.push({ kind: "offtaker", id: sid, label: "Open off-taker" });
    if (code === "gmp_mismatch" || code === "gmp_share_mismatch" || code === "no_utility_bill") t.push({ kind: "bill_audit", label: "Bill audit" });
    if (code === "unpaid_aging" || code === "payment_not_tracked") t.push({ kind: "collection", label: "Payment collection" });
    return t;
  }
  function finding(code, sev, title, detail, o) {
    o = o || {};
    return { code: code, severity: sev, title: title, detail: detail,
      subscription_id: o.sid != null ? o.sid : null, invoice_id: o.inv != null ? o.inv : null,
      customer_name: o.name || null, evidence: o.evidence || {}, action: o.fix, fix: o.fix,
      source: o.source || "rules", targets: o.targets || targets(code, o.sid, o.inv, o.draft) };
  }
  // `withReconcile`: the quick check (opening the mail room) skips the utility
  // cross-check exactly like gather(include_reconcile=not rules_only), so the
  // GMP allocation catches surface in the Deep review (and in Bill audit).
  function ruleFindings(withReconcile) {
    var M = model(), out = [];
    // 7. Shares per array across enabled offtakers.
    var per = {}, who = {};
    M.subs.forEach(function (s) {
      if (!s.enabled) return;
      var n = s.array_name || arrName(s.array_id);
      per[n] = (per[n] || 0) + num(s.allocation_pct);
      (who[n] = who[n] || []).push(s.customer_name);
    });
    Object.keys(per).forEach(function (n) {
      if (per[n] > 1.0005) {
        out.push(finding("over_allocated", "critical", "Array allocated over 100%",
          n + ": enabled off-takers sum to " + (per[n] * 100).toFixed(2) + "% (" + who[n].length + " off-takers).",
          { evidence: { array: n, total_pct: r2(per[n] * 100), offtakers: who[n].slice(0, 20) },
            fix: "Fix the shares before the next run; every invoice on this array is overstated." }));
      }
    });
    // 8. GMP allocation cross-check.
    if (withReconcile) M.catches.forEach(function (c) {
      var s = M.byId[c.sid];
      out.push(finding("gmp_share_mismatch", "high", "GMP's credited share disagrees with the entered share",
        s.customer_name + ": GMP's credit implies a different share than the one billed.",
        { sid: s.id, name: s.customer_name, fix: "Compare the entered share to what the utility credited on the bill; fix whichever is wrong." }));
    });
    // 5. Unpaid aging.
    M.invoices.forEach(function (h) {
      if (h.sid + ":" + h.k !== M.lateKey) return;
      var s = M.byId[h.sid], days = Math.floor((NOW - h.at) / 86400000);
      if (days < 35) return;
      out.push(finding("unpaid_aging", "medium", "Unpaid for more than 35 days",
        s.customer_name + " #" + invNo(s, h.k) + " $" + h.amount.toFixed(2) + " outstanding since " + MON3[h.at.getMonth()] + " " + pad(h.at.getDate()) + ".",
        { sid: s.id, inv: h.id, name: s.customer_name, evidence: { outstanding_usd: h.amount, days: days },
          fix: "Send a reminder; record the payment as an offline receipt if a check arrived." }));
    });
    // 9. Legacy history.
    if (M.legacy.length) {
      out.push(finding("legacy_history", "info", "Older invoices lack frozen evidence",
        M.legacy.length + " invoice(s) were issued before frozen evidence existed; amounts are from the send stamps, and their emails and attachments cannot be reproduced exactly.",
        { evidence: { count: M.legacy.length }, fix: "No action; newer invoices keep full evidence automatically." }));
    }
    return out;
  }
  function reviewFindings() {
    // The scripted "deep review": what a careful billing clerk would question
    // that the rules can't express, grounded in the sample data.
    var M = model(), out = [];
    var nbr = M.subs.filter(function (s) { return Number(s.array_id) === 8 && (M.cls[s.id] === "auto" || M.cls[s.id] === "approval"); });
    if (nbr.length) {
      // monthly() applies the fault to the last three settled months = cycles
      // 0..2 here (the queued cycle plus the two newest invoiced ones).
      var lost = 0;
      M.history.forEach(function (h) {
        var s = M.byId[h.sid];
        if (Number(s.array_id) === 8 && h.k <= 2) lost += h.amount * (0.985 / D.sitePerf(8) - 1);
      });
      var pct = ((1 - D.sitePerf(8) / 0.985) * 100).toFixed(1);
      out.push(finding("model", "medium", "North Branch Ridge credits are running low",
        "Invoices for the " + nbr.length + " North Branch Ridge offtakers have come in about " + pct +
        "% under their usual share of the season since " + MON[cStart(2).getMonth()] + ", while the other VEC arrays held steady. That lines up with the open string fault on Inverter 1. The invoices are right (they bill VEC's settled numbers); the shortfall is lost credit, roughly " + money(lost) + " on the invoices already sent.",
        { sid: nbr[0].id, name: nbr[0].customer_name, source: "sample-review",
          fix: "Schedule the Inverter 1 repair at North Branch Ridge; nothing needs re-issuing." }));
    }
    // Same customer on two arrays (same name and email).
    var seen = {}, pair = null;
    M.subs.forEach(function (s) {
      if (pair || !s.enabled) return;
      var key = String(s.customer_name).toLowerCase() + "|" + String(s.client_email).toLowerCase();
      if (seen[key] && seen[key].array_id !== s.array_id) pair = [seen[key], s];
      else if (!seen[key]) seen[key] = s;
    });
    if (pair) {
      var a = pair[0], b = pair[1];
      out.push(finding("model", "low", "Same customer on two arrays",
        a.customer_name + " is billed on " + (a.array_name || arrName(a.array_id)) + " (" + (num(a.allocation_pct) * 100).toFixed(2) + "%) and " +
        (b.array_name || arrName(b.array_id)) + " (" + (num(b.allocation_pct) * 100).toFixed(2) + "%) at the same address, " + a.client_email +
        ", so they receive two invoices a month. If that is intended, nothing to do; if not, one row is a duplicate.",
        { sid: a.id, name: a.customer_name, source: "sample-review",
          targets: [{ kind: "offtaker", id: a.id, label: "Open " + (a.array_name || "first") }, { kind: "offtaker", id: b.id, label: "Open " + (b.array_name || "second") }],
          fix: "Open both off-takers and confirm they are the same customer with two shares." }));
    }
    return out;
  }
  function lookFor(findings) {
    var M = model(), out = [];
    var dr = M.drafts.filter(function (x) { return x.sid != null; });
    if (dr.length) {
      var names = dr.map(function (x) { return x.d.customer_name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort().slice(0, 4);
      out.push("Open the " + dr.length + " draft" + (dr.length === 1 ? "" : "s") + " waiting on you (" + names.join(", ") + (dr.length > 4 ? "…" : "") + ") and read the amount and period before approving.");
    }
    var newest = M.invoices.slice(0, 3).map(function (h) { return M.byId[h.sid].customer_name + " (" + cLabel(h.k) + ")"; });
    if (newest.length) out.push("Open the newest invoices — " + newest.join(", ") + " — and compare the kWh on each to the utility bill for that period.");
    var open = M.invoices.filter(function (h) { return h.pay === "open"; });
    if (open.length) {
      var due = open.reduce(function (n, h) { return n + h.amount; }, 0);
      out.push(open.length + " invoice" + (open.length === 1 ? "" : "s") + " still open, " + money(due) + " outstanding — decide who gets a reminder.");
    }
    out.push("Scan each off-taker's amounts month to month; anything that moved more than a quarter deserves a reason you can name.");
    out.push("Check that each array's shares add up to 100% and that no off-taker appears twice under slightly different names.");
    return out;
  }
  function runJson(run) {
    var elapsed = Date.now() - run.t0;
    var deep = run.mode === "deep";
    var base = { id: run.id, triggered_by: deep ? "operator" : "mailroom_check", started_at: isoZ(run.started),
      model: null, provider: null, verdict: null, summary: null, findings: [], stats: { check_mode: deep ? "deep" : "check", repairs: [], repaired_count: 0 },
      what_to_look_for: [], repairs: [], repaired_count: 0, coverage: {}, error: null };
    if (elapsed < (deep ? DEEP_MS : CHECK_MS)) {
      base.status = "running"; base.finished_at = null;
      return base;
    }
    var M = model();
    var rules = ruleFindings(deep);
    var model_ = deep ? reviewFindings() : [];
    var SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    var all = rules.concat(model_).sort(function (a, b) {
      return (SEV[a.severity] - SEV[b.severity]) || String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
    });
    var worst = all.length ? SEV[all[0].severity] : 99;
    var verdict = worst === 0 ? "stop" : worst <= 2 ? "caution" : "ready";
    var look = (deep ? ["Once Inverter 1 at North Branch Ridge is repaired, confirm the next VEC bill for that array is back in line with Long Pasture and Blue Spruce Common."] : [])
      .concat(lookFor(all)).slice(0, 10);
    var coverage = { checked: M.invoices.length + M.legacy.length, total: M.invoices.length + M.legacy.length,
      truncated: false, reconcile_checked: deep };
    var finished = new Date(run.t0 + (deep ? DEEP_MS : CHECK_MS));
    base.status = "done";
    base.finished_at = isoZ(finished);
    base.model = deep ? "Scripted sample review (no AI call)" : null;
    base.provider = deep ? "sample" : "rules-only";
    base.verdict = verdict;
    base.summary = deep
      ? "Scripted review of the sample account's mail room (no AI call). " + M.catches.length + " GMP credit(s) disagree with the entered shares and one invoice is past due; North Branch Ridge's credits are down while Inverter 1 is faulted."
      : all.length + " rule finding(s); most severe: " + (all[0] ? all[0].severity + " — " + all[0].title : "none") + ".";
    base.findings = all;
    base.what_to_look_for = look;
    base.coverage = coverage;
    base.stats = {
      what_to_look_for: look, check_mode: deep ? "deep" : "check", coverage: coverage,
      subscriptions: M.subs.length, outgoing: outgoing().length, sent: M.invoices.length + M.legacy.length,
      sent_frozen: M.invoices.length, remaining_findings: all.length, rule_findings: rules.length,
      model_findings: model_.length,
      by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      model_ok: deep, model_error: null, model_skipped: deep ? null : "Rules-only check; no model requested",
      model_seconds: deep ? 4.1 : null, seconds: deep ? 6.5 : 2.4, repairs: [], repaired_count: 0,
    };
    all.forEach(function (f) { base.stats.by_severity[f.severity] = (base.stats.by_severity[f.severity] || 0) + 1; });
    return base;
  }
  function startRun(mode, force) {
    var running = RUNS.filter(function (r) { return runJson(r).status === "running"; });
    if (running.length) return { ok: true, run_id: running[running.length - 1].id, already_running: true, cached: false, mode: running[running.length - 1].mode };
    if (mode === "check" && !force) {
      var recent = RUNS.filter(function (r) { return r.mode === "check" && Date.now() - r.t0 < 15 * 60000; });
      if (recent.length) return { ok: true, run_id: recent[recent.length - 1].id, already_running: false, cached: true, mode: "check" };
    }
    var run = { id: ++RUN_SEQ, mode: mode, t0: Date.now(), started: new Date() };
    RUNS.push(run);
    return { ok: true, run_id: run.id, already_running: false, cached: false, mode: mode };
  }

  // ── Send pipeline (routes.send_pipeline) ─────────────────────────────────
  function pipeline() {
    var M = model();
    var enabled = M.subs.filter(function (s) { return s.enabled; });
    var lastEnd = null, delivered = 0, dollars = 0, lastRun = null;
    var stamps = enabled.map(function (s) { return { s: s, ls: lastSent(s) }; });
    stamps.forEach(function (x) { if (x.ls) { var pe = D.isoDate(cEnd(x.ls.k)); if (!lastEnd || pe > lastEnd) lastEnd = pe; } });
    stamps.forEach(function (x) {
      if (!x.ls) return;
      if (D.isoDate(cEnd(x.ls.k)) === lastEnd) { delivered++; dollars += x.ls.amount; }
      if (!lastRun || x.ls.at > lastRun) lastRun = x.ls.at;
    });
    var pendAuto = 0, pendAppr = 0;
    M.drafts.forEach(function (x) {
      if (!x.sub || !x.sub.enabled) return;
      if (x.sub.delivery_mode === "auto") pendAuto++; else pendAppr++;
    });
    var pending = pendAuto + pendAppr;
    var autoAll = enabled.filter(function (s) { return s.delivery_mode === "auto"; }).length;
    var monthly = enabled.filter(function (s) { return (s.cadence || "monthly") === "monthly"; });
    var mAuto = monthly.filter(function (s) { return s.delivery_mode === "auto"; }).length;
    var q = enabled.length - monthly.length;
    return {
      ok: true, total_enabled: enabled.length, holds: [], dispatch_holds: [],
      last: { period_end: lastEnd, period_month: lastEnd ? lastEnd.slice(0, 7) : null, delivered: delivered,
        dollars: r2(dollars), last_run_at: lastRun ? isoZ(lastRun) : null },
      inflight: { pending_drafts: pending, pending_auto: pendAuto, pending_approval: pendAppr,
        waiting: Math.max(0, enabled.length - delivered - pending) },
      default_delivery_mode: autoAll > enabled.length - autoAll ? "auto" : "approval",
      mode_split: { auto: autoAll, approval: enabled.length - autoAll },
      // The monthly run: the 1st at 09:00 UTC, same instant the mail room's
      // scheduled rows name, so the rail and the mail room agree.
      next_monthly: { fires_at: isoZ(nextMonthFirst()), scheduled: monthly.length, auto: mAuto, approval: monthly.length - mAuto },
      next_quarterly: { fires_at: isoZ(nextMonthFirst()), scheduled: q, auto: 0, approval: q },
      paused: false,
    };
  }

  // ── Invoice trends (routes.portfolio_gains) ──────────────────────────────
  function gains() {
    var M = model(), byYear = {}, byMonth = {}, life = {}, pend = {};
    M.history.forEach(function (h) {
      var d = cEnd(h.k), y = d.getFullYear(), ym = D.isoMonth(d);
      life[h.sid] = (life[h.sid] || 0) + h.amount;
      var cy = byYear[y] = byYear[y] || { sent_usd: 0, sent_count: 0 };
      cy.sent_usd += h.amount; cy.sent_count++;
      var cm = byMonth[ym] = byMonth[ym] || { sent_usd: 0, sent_count: 0 };
      cm.sent_usd += h.amount; cm.sent_count++;
    });
    M.drafts.forEach(function (x) {
      if (x.sid == null) return;
      var a = num(x.d.amount_usd);
      if (a > (pend[x.sid] || 0)) pend[x.sid] = a;
    });
    var enabledN = 0, withLast = 0, lastTotal = 0, estAnnual = 0;
    var offs = M.subs.map(function (s) {
      var ls = lastSent(s), en = !!s.enabled;
      if (en) enabledN++;
      var last = ls ? ls.amount : null;
      var ann = en && last ? r2(last * 12) : null;
      if (en && last) { withLast++; lastTotal += last; }
      if (ann) estAnnual += ann;
      return { id: s.id, customer_name: s.customer_name, enabled: en, cadence: s.cadence || "monthly",
        last_sent_amount_usd: last != null ? r2(last) : null,
        last_sent_period_end: ls ? D.isoDate(cEnd(ls.k)) : null,
        last_sent_at: ls ? isoZ(ls.at) : null, budget_amount_usd: null, est_annual_usd: ann,
        pending_amount_usd: pend[s.id] != null ? r2(pend[s.id]) : null,
        sent_lifetime_usd: life[s.id] != null ? r2(life[s.id]) : null };
    });
    offs.sort(function (a, b) {
      return (num(b.last_sent_amount_usd) - num(a.last_sent_amount_usd)) || (num(b.est_annual_usd) - num(a.est_annual_usd)) ||
        String(a.customer_name).toLowerCase().localeCompare(String(b.customer_name).toLowerCase());
    });
    offs.forEach(function (o) { o.share_pct = lastTotal > 0 && o.last_sent_amount_usd ? r1(100 * o.last_sent_amount_usd / lastTotal) : null; });
    var years = Object.keys(byYear).map(Number).sort();
    var months = Object.keys(byMonth).sort();
    var outYear = {}, outMonth = {};
    years.forEach(function (y) { outYear[String(y)] = { sent_usd: r2(byYear[y].sent_usd), sent_count: byYear[y].sent_count }; });
    months.forEach(function (m) { outMonth[m] = { sent_usd: r2(byMonth[m].sent_usd), sent_count: byMonth[m].sent_count }; });
    var yoy = years.map(function (y, i) {
      var cur = r2(byYear[y].sent_usd), prior = i > 0 ? r2(byYear[years[i - 1]].sent_usd) : null;
      return { year: y, sent_usd: cur, sent_count: byYear[y].sent_count, delta_pct: prior ? r1(100 * (cur - prior) / prior) : null };
    });
    var lifetime = Object.keys(life).reduce(function (n, k) { return n + life[k]; }, 0);
    var pendUsd = Object.keys(pend).reduce(function (n, k) { return n + pend[k]; }, 0);
    return {
      ok: true,
      kpis: { enabled_offtakers: enabledN, total_offtakers: M.subs.length, with_last_invoice: withLast,
        last_invoice_total_usd: r2(lastTotal), pending_drafts: Object.keys(pend).length, pending_draft_usd: r2(pendUsd),
        est_annual_usd: r2(estAnnual), lifetime_sent_usd: r2(lifetime) },
      years: years, by_year: outYear, yoy: yoy, months: months, by_month: outMonth, offtakers: offs,
    };
  }

  // ── Archives ─────────────────────────────────────────────────────────────
  function invoiceArchive() {
    var M = model(), months = [];
    for (var k = 0; k <= FROZEN_CYCLES; k++) {
      var arrays = {};
      M.subs.forEach(function (s) {
        var c = M.cls[s.id];
        if (c === "paused") return;
        if (k > 0 && !(c === "auto" || c === "approval")) return;    // new offtakers start with cycle 0
        var aid = Number(s.array_id);
        var e = arrays[aid] = arrays[aid] || { array_id: aid, array_name: arrName(aid), array_bill_available: true, offtakers: [] };
        e.offtakers.push({ sub_id: s.id, customer_name: s.customer_name, invoice_available: true, offtaker_bill_available: true });
      });
      var list = Object.keys(arrays).map(function (a) { return arrays[a]; }).sort(function (a, b) { return a.array_name.localeCompare(b.array_name); });
      var n = list.reduce(function (t, a) { return t + a.offtakers.length; }, 0);
      months.push({ month: cKey(k), arrays: list, invoice_count: n });
    }
    return { ok: true, months: months, month_count: months.length, latest_month: months.length ? months[0].month : null };
  }
  function billArchive() {
    var bills = [], id = 88000;
    var hosts = (A().utilAccounts || []).filter(function (u) { return u._host; });
    for (var k = 0; k < 12; k++) {
      hosts.forEach(function (u) {
        var p = String(u.provider || "utility").toLowerCase();
        var lab = provTag(p);
        var label = u.nickname || arrName(u.array_id);
        var pe = cEnd(k), bd = addDays(pe, 9 + (u.array_id % 6));
        if (bd > NOW) bd = addDays(NOW, -1);
        var r = D.rng("bill:" + u.utility_account_id + ":" + cKey(k));
        bills.push({
          id: ++id, account_id: u.utility_account_id, provider: p, provider_label: lab,
          account_label: label, account_number: u.account_number || null, array_name: arrName(u.array_id),
          period_start: D.isoDate(cStart(k)), period_end: D.isoDate(pe), bill_date: D.isoDate(bd),
          month: cKey(k), kwh_generated: p === "gmp" ? arrayKwh(u.array_id, k) : null,
          size: 140000 + Math.floor(r() * 90000),
          filename: p + "_bill_" + String(label).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") + "_" + cKey(k) + ".pdf",
          download: "/v1/array-operator/billing/files/gmp-bill/" + id,
        });
      });
    }
    bills.sort(function (a, b) { return b.period_end.localeCompare(a.period_end) || b.id - a.id; });
    return { ok: true, bills: bills, count: bills.length };
  }
  function monthlyManifest() {
    var M = model(), reps = [];
    var op = acct().company_name || "Northeast Community Solar";
    var opSlug = op.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    var to = acct().email || "dana@northeastsolar.coop";
    for (var k = LATEST_SENT; k <= 6; k++) {
      var hs = M.history.filter(function (h) { return h.k === k; });
      if (!hs.length) continue;
      var anchor = hs.reduce(function (m, h) { return h.at > m ? h.at : m; }, hs[0].at);
      var sent = addDays(anchor, 15);
      if (sent > NOW) continue;
      var billed = hs.reduce(function (n, h) { return n + h.amount; }, 0);
      var paidN = 0, coll = 0;
      hs.forEach(function (h) {
        var inv = h.id != null ? h : null;
        var paid = inv ? inv.pay === "online" || inv.pay === "check" : true;   // older cycles settled
        if (paid) { paidN++; coll += h.amount; }
      });
      reps.push({
        id: 610 + k, period_key: cKey(k), sent_at: isoZ(new Date(Date.UTC(sent.getFullYear(), sent.getMonth(), sent.getDate(), 13, 0, 0))),
        anchor_sent_at: isoZ(anchor), recipient: to, trigger: "scheduled", offtaker_count: hs.length, paid_count: paidN,
        total_kwh: hs.reduce(function (n, h) { return n + h.kwh; }, 0), total_billed_usd: r2(billed),
        total_collected_usd: r2(coll), filename: opSlug + "-offtaker-summary-" + cKey(k) + ".xlsx",
        size_bytes: 52000 + hs.length * 41, error: null,
      });
    }
    return {
      ok: true, reports: reps,
      next: reps.length ? { period_key: reps[0].period_key, already_sent: true } : null,
      settings: { enabled: true, lag_days: 15, recipient: to, recipients: [to], recipient_is_default: true },
    };
  }

  // ── Utility accounts / payments / settings ──────────────────────────────
  function utilityAccounts() {
    return { ok: true, utility_accounts: (A().utilAccounts || []).map(function (u) {
      var pe = cEnd(0);
      return { utility_account_id: u.utility_account_id, account_number: u.account_number, nickname: u.nickname,
        provider: u.provider, array_id: u.array_id, array_name: arrName(u.array_id), service_address: u.service_address,
        bill_count: u.bill_count || 0, has_bill: !!u.has_bill, latest_period_end: u.has_bill ? D.isoDate(pe) : null,
        latest_period_label: u.has_bill ? (u.latest_period_label || D.isoMonth(pe)) : null,
        latest_kwh_generated: u._host && String(u.provider) === "gmp" ? arrayKwh(u.array_id, 0) : null };
    }) };
  }
  function payments(limit) {
    var M = model(), items = [];
    M.invoices.forEach(function (h) {
      if (h.pay !== "online" && h.pay !== "open") return;
      var s = M.byId[h.sid];
      items.push({ id: h.id + 9000, subscription_id: s.id, customer_name: s.customer_name, invoice_number: invNo(s, h.k),
        period_key: cKey(h.k), amount_usd: r2(h.amount), fee_usd: h.pay === "online" ? r2(h.amount * 0.005) : 0,
        status: h.pay === "online" ? "paid" : "open", pay_url: h.pay === "open" ? samplePayUrl() : null,
        paid_at: h.paid_at ? isoZ(h.paid_at) : null, created_at: isoZ(h.at) });
    });
    items.sort(function (a, b) { return b.id - a.id; });
    items = items.slice(0, Math.max(1, Math.min(limit || 50, 200)));
    return { ok: true, payments: items, count: items.length };
  }
  function issuedInvoices() {
    var M = model();
    return { ok: true, invoices: M.invoices.slice().sort(function (a, b) { return cKey(a.k) === cKey(b.k) ? b.id - a.id : cKey(b.k).localeCompare(cKey(a.k)); }).map(function (h) {
      var s = M.byId[h.sid], cents = Math.round(h.amount * 100);
      var gross = h.pay === "online" || h.pay === "check" ? cents : 0;
      var fee = h.pay === "online" ? Math.round(cents * 0.005) : 0;
      var off = h.pay === "check" ? cents : 0;
      return { invoice_id: h.id, id: h.id, subscription_id: s.id, invoice_number: invNo(s, h.k), period_key: cKey(h.k),
        status: "accepted", amount_cents: cents, gross_collected_cents: gross, refunded_cents: 0, fee_cents: fee,
        after_platform_fee_cents: Math.max(gross - fee, 0), net_collected_cents: Math.max(gross - fee, 0),
        actual_net_cents: null, stripe_processing_fee_cents: null, refund_state: "none",
        collectible_cents: Math.max(cents - gross, 0), offline_collected_cents: off,
        outstanding_cents: Math.max(cents - gross, 0), payment_status: h.pay === "online" ? "paid" : h.pay === "check" ? "expired" : "open",
        bank_payout_verified: false, customer_name: s.customer_name };
    }) };
  }
  function exportPeriods() {
    var n = model().subs.filter(function (s) { return s.enabled; }).length;
    var out = [];
    for (var k = 0; k < 6; k++) out.push({ label: cKey(k), pretty: cPretty(k), count: n });
    return { ok: true, periods: out };
  }
  function emailTemplate() {
    var first = model().subs.filter(function (s) { return s.enabled && s.client_email; })
      .sort(function (a, b) { return String(a.customer_name).localeCompare(String(b.customer_name)); })[0];
    return {
      subject_template: "Your solar credit invoice — {{offtaker_name}} ({{invoice_number}})",
      body_template: "<p>{{greeting}},</p><p>Attached is your solar credit invoice for {{period}}. Your share of the array's production this period came to <strong>{{kwh}}</strong>, for a total of <strong>{{amount}}</strong>.</p><p>{{attachments_line}} If anything looks off, just reply to this email and we'll take a look together.</p><p>Thanks for going solar!</p>{{signoff}}",
      signoff: "<p>Thank you,<br>{{tenant_name}}{{tenant_email_line}}</p>",
      is_default_subject: true, is_default_body: true, is_default_signoff: true,
      from_email: acct().email || null,
      available_tokens: ["amount", "attachments_line", "company_name", "greeting", "invoice_number", "kwh",
        "offtaker_first_name", "offtaker_name", "operator_name", "period", "period_end", "period_start",
        "signoff", "tenant_email_line", "tenant_name"],
      has_client_with_email: !!first, sample_client_email: first ? first.client_email : null,
    };
  }
  function previewTemplate(body) {
    // Pure render (routes.preview_offtaker_email_template): merge the proposed
    // template with the first offtaker's own latest invoice. Saves nothing.
    var t = emailTemplate(), M = model();
    var s = M.subs.filter(function (x) { return x.enabled && x.client_email; })
      .sort(function (a, b) { return String(a.customer_name).localeCompare(String(b.customer_name)); })[0];
    body = body || {};
    var k = 0;   // build_match(sub): the latest settled bill
    var f = s ? M.figures(s, k) : { kwh: 1265, amount: 190.2 };
    var signer = acct().operator_name || "Dana Whitcomb", email = acct().email || "";
    var signT = String(body.signoff || "").trim() || t.signoff;
    var sign = merge(signT, { tenant_name: signer, tenant_email: email, tenant_email_line: email ? "<br>" + email : "" });
    var name = s ? s.customer_name : "Sample Offtaker";
    var gmp = s && String(s._provider) === "gmp";
    var ctx = {
      offtaker_name: name, offtaker_first_name: String(name).split(/\s+/)[0],
      greeting: s && isOrg(s) ? "Dear " + name : "Hi " + String(name).split(/\s+/)[0],
      period: cLabel(k), period_start: D.isoDate(cStart(k)), period_end: D.isoDate(cEnd(k)),
      kwh: fmt0(f.kwh) + " kWh", amount: money(f.amount), invoice_number: s ? invNo(s, k) : "",
      tenant_name: acct().company_name || "Northeast Community Solar", company_name: acct().company_name || "Northeast Community Solar",
      operator_name: signer, tenant_email_line: email ? "<br>" + email : "",
      attachments_line: gmp ? "Your full invoice is attached, along with the GMP source bill behind it (so you can see exactly how the amount was calculated)." : "Your full invoice is attached, along with the utility bill behind it.",
      signoff: sign,
    };
    var subjT = String(body.subject_template || "").trim() || t.subject_template;
    var bodyT = String(body.body_template || "").trim() || t.body_template;
    return { subject_rendered: merge(subjT, ctx), body_rendered: merge(bodyT, ctx), sample_client: name };
  }
  function merge(tpl, ctx) {
    return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (m, key) {
      return ctx[key] != null ? String(ctx[key]) : m;
    });
  }

  function html(body) {
    return new Response(body, { status: 200, headers: {
      "Content-Type": "text/html; charset=utf-8", "X-AO-Sample": "1", "Cache-Control": "no-store" } });
  }
  function q(req, key, dflt) {
    var v = req.query && req.query.get(key);
    return v == null || v === "" ? dflt : v;
  }

  /* ── Routes ─────────────────────────────────────────────────────────────── */
  D.get(R("\\/send-pipeline"), function () { return pipeline(); });
  D.get(R("\\/utility-accounts"), function () { return utilityAccounts(); });
  // The roster with the backend's last-send stamps (last_sent_at, period end,
  // amount, delivery confirmation, next send) from the same sent history the
  // Mail room shows, so each offtaker card's "last sent" ties to its invoices.
  D.get(R("\\/subscriptions"), function () {
    return { ok: true, crosscheck_threshold_default_pct: 0.5, subscriptions: model().subs.map(function (s) {
      var c = subContext(s);
      return Object.assign({}, s, {
        last_sent_at: c.last_sent_at, last_sent_period_end: c.last_sent_period_end,
        last_sent_amount_usd: c.last_sent_amount_usd, last_invoice_number: c.last_invoice_number,
        last_delivered_at: c.last_delivered_at, last_bounced_at: null, last_bounce_reason: null,
        next_send_at: s.enabled ? c.next_send_at : null,
        // Override column: blank = the fleet's 10% default; 0% is an explicit override.
        discount_pct: discOf(s) > 0 ? null : 0,
      });
    }) };
  });
  D.get(R("\\/global-rate"), function () {
    return {
      ok: true, default_billing_rate_per_kwh: null,
      // Blank master rate: each offtaker prices off its own rate/bill, minus the
      // fleet's 10% default discount (AO_DEMO: most offtakers 10%, some 0%).
      default_net_rate_per_kwh: null, default_net_rate_adder_per_kwh: null, default_net_rate_adder_until: null,
      default_discount_pct: 0.1, effective_net_rate_per_kwh: null, effective_net_rate_source: "per_offtaker_bill",
      effective_net_rate_note: "Master rate is blank — each offtaker uses the solar credit rate from their own utility sub-account bill.",
      effective_discount_pct: 0.1,
    };
  });
  D.get(R("\\/export-periods"), function () { return exportPeriods(); });
  D.get(R("\\/payments"), function (req) { return payments(Number(q(req, "limit", 50))); });
  D.get(R("\\/payments\\/connect"), function () {
    // A connected payout account (Stripe Connect Express, charges enabled).
    return { ok: true, enabled: true, connected: true, account_id: "acct_sample", charges_enabled: true,
      details_submitted: true, fee_bps: 50, fee_percent: 0.5, fee_min_cents: 0,
      stripe_fees: { ach: "0.8%, capped at $5", card: "2.9% + 30¢" },
      platform: "energy_agent", platform_name: "Energy Agent", ready: true };
  });
  D.get(R("\\/payment-policy"), function () { return { ok: true, policy: "online_required", audit: [] }; });
  D.get(R("\\/issued-invoices"), function () { return issuedInvoices(); });
  D.get(R("\\/email-template"), function () { return emailTemplate(); });
  D.post(R("\\/email-template\\/preview"), function (req) { return previewTemplate(req.body); });

  D.get(R("\\/invoice-archive"), function () { return invoiceArchive(); });
  D.get(R("\\/utility-bill-archive"), function () { return billArchive(); });
  D.get(R("\\/monthly-report\\/manifest"), function () { return monthlyManifest(); });

  D.get(R("\\/audit-by-array"), function () { return auditByArray(); });
  D.get(R("\\/reconcile-bills"), function () { return reconcile(); });
  D.get(R("\\/portfolio-gains"), function () { return gains(); });

  // Mail room
  D.get(R("\\/mailroom"), function (req) {
    return board(Number(q(req, "limit", 300)), Number(q(req, "offset", 0)), String(q(req, "legacy", "1")) !== "0");
  });
  D.get(R("\\/mailroom\\/invoice\\/(\\d+)"), function (req) {
    var h = model().invById[Number(req.match[1])];
    return h ? { ok: true, invoice: invoiceDetail(h) } : notFound("invoice not found");
  });
  D.get(R("\\/mailroom\\/invoice\\/(\\d+)\\/email"), function (req) {
    var h = model().invById[Number(req.match[1])];
    if (!h) return notFound("invoice not found");
    return html(invoiceDetail(h).email.html);
  });
  D.get(R("\\/mailroom\\/invoice\\/(\\d+)\\/attachment\\/(.+)"), function () { return D.readOnly(DL_DETAIL); });
  D.get(R("\\/mailroom\\/legacy\\/(draft|sub)\\/(\\d+)"), function (req) {
    var h = req.match[1] === "draft" ? model().legById[Number(req.match[2])] : null;
    return h ? { ok: true, invoice: legacyDetail(h) } : notFound("invoice not found");
  });
  D.get(R("\\/mailroom\\/legacy\\/(draft|sub)\\/(\\d+)\\/email"), function (req) {
    var h = req.match[1] === "draft" ? model().legById[Number(req.match[2])] : null;
    if (!h) return notFound("invoice not found");
    var d = legacyDetail(h);
    if (d.email.html) return html(d.email.html);
    return html("<pre style='font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap;padding:24px'>" +
      "No copy of this email survives — it was sent before the platform kept one for every invoice.</pre>");
  });
  // The checks only READ the board (no repairs happen in the sample), so they
  // run here instead of hitting the read-only wall — opening the mail room
  // starts one automatically and must never trigger the sample nudge.
  D.post(R("\\/mailroom\\/check"), function (req) { return startRun("check", String(q(req, "force", "false")) === "true"); });
  D.post(R("\\/mailroom\\/audit"), function () { return startRun("deep", true); });
  D.get(R("\\/mailroom\\/audit"), function (req) {
    var lim = Math.max(1, Math.min(Number(q(req, "limit", 10)), 50));
    var runs = RUNS.slice().reverse().slice(0, lim).map(function (r) {
      var j = runJson(r);
      j.finding_count = (j.findings || []).length;
      delete j.findings;
      return j;
    });
    return { ok: true, runs: runs, latest: runs.length ? runs[0] : null };
  });
  D.get(R("\\/mailroom\\/audit\\/(\\d+)"), function (req) {
    var id = Number(req.match[1]);
    var run = RUNS.filter(function (r) { return r.id === id; })[0];
    return run ? { ok: true, run: runJson(run) } : notFound("audit run not found");
  });

  // Downloads: the sample has no files to hand out.
  [R("\\/invoice-export\\.csv"), R("\\/invoice-archive\\.zip"), R("\\/files\\/gmp-bill\\/(\\d+)"),
    R("\\/monthly-report\\/(\\d+)\\.xlsx"), R("\\/offtaker-template\\.xlsx"), R("\\/drafts\\/(\\d+)\\/gmp-bill"),
    R("\\/subscriptions\\/(\\d+)\\/preview")].forEach(function (re) {
    D.get(re, function () { return D.readOnly(DL_DETAIL); });
  });

  // For the harness (node) and for debugging in the console; not used by the app.
  D._statements = { model: model, board: board, invoiceDetail: invoiceDetail, legacyDetail: legacyDetail,
    auditByArray: auditByArray, reconcile: reconcile, pipeline: pipeline, gains: gains, runJson: runJson,
    startRun: startRun, RUNS: RUNS, invoiceArchive: invoiceArchive, billArchive: billArchive,
    monthlyManifest: monthlyManifest, previewTemplate: previewTemplate, emailTemplate: emailTemplate,
    payments: payments, utilityAccounts: utilityAccounts, issuedInvoices: issuedInvoices };
})();
