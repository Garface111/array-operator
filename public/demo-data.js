/* ============================================================================
 * Array Operator — anonymous-demo data (demo-data.js)
 *
 * A single, internally-consistent fake operator — "Catamount Community Solar",
 * a 56 kW VT community array on the "both" plan (live monitoring + per-offtaker
 * invoicing) — so a SIGNED-OUT visitor sees a fully-populated Master Account and
 * Offtaker Invoice Generator, not a sign-in wall.
 *
 * Loaded BEFORE sandbox.js / reports.js. Those files render this ONLY when there
 * is no session (gated on `!authHeaders() && window.AO_DEMO`); a real signed-in
 * owner never touches any of it.
 *
 * Every number ties out:
 *   • Monthly bill  = monitoring (kWh × rate) + offtakers (N × $20).
 *   • Each offtaker invoice = their produced kWh × the bill's net-metering
 *     solar-credit rate (~$0.2576/kWh, the EXCESS+SOLCRED blended VT rate).
 * The shapes here MIRROR what renderBilling / renderAccountList (sandbox.js) and
 * subCard / draftCard (reports.js) consume — see those functions before editing.
 * ==========================================================================*/
(function () {
  "use strict";

  // ── The operator's metered monitoring line (kWh basis). 56 kW community array,
  //    month-to-date production at a realistic VT June yield (~4.6 kWh/kW/day).
  var MTD_KWH = 8120;                  // kWh produced this billing month so far
  var RATE_CENTS_PER_KWH = 0.5;        // half a cent / kWh metered monitoring
  var MONITORING_CENTS = Math.round(MTD_KWH * RATE_CENTS_PER_KWH);   // 4060 ¢ = $40.60

  // ── The three offtakers + their per-offtaker invoicing line ($20 each, flat).
  var OFFTAKER_COUNT = 3;
  var PER_OFFTAKER_CENTS = 2000;       // flat $20 / offtaker we invoice
  var INVOICING_CENTS = OFFTAKER_COUNT * PER_OFFTAKER_CENTS;         // 6000 ¢ = $60.00

  var TOTAL_CENTS = MONITORING_CENTS + INVOICING_CENTS;             // 10060 ¢ = $100.60

  // ── The net-metering solar-credit rate each offtaker invoice bills at. This is
  //    the EXCESS + SOLCRED blended VT rate ($/kWh) read off the real GMP bill —
  //    every offtaker amount below = their kWh × this rate.
  var CREDIT_RATE = 0.2576;            // $/kWh
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  // Period: last full calendar month (so dates read as a real settled bill).
  var now = new Date();
  var pe = new Date(now.getFullYear(), now.getMonth(), 0);          // last day of prev month
  var ps = new Date(pe.getFullYear(), pe.getMonth(), 1);            // first day of prev month
  var iso = function (d) { return d.toISOString().slice(0, 10); };
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var periodLabel = MON[ps.getMonth()] + " " + ps.getFullYear();
  // Next charge = first of the upcoming month.
  var nextCharge = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  // Trial period start (billing-summary "since" line) — this month's 1st.
  var periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // ── Master Account object — shape consumed by renderAccountList() + renderBilling().
  var account = {
    company_name: "Catamount Community Solar",
    operator_name: "Dana Whitcomb",
    name: "Dana Whitcomb",
    email: "dana@catamountsolar.coop",
    operator_email: "dana@catamountsolar.coop",
    has_password: true,
    on_trial: false,
    trial: false,
    subscription_status: "active",
    status: "active",
    // Entitlement — drives the Plan row, the tab gating, AND which bill lines show.
    plan_features: {
      plan: "both",
      plan_chosen: true,
      vendor_data: true,
      invoicing: true,
    },
  };

  // ── billing-summary object — shape consumed by renderBilling() (sandbox.js).
  //    A "both" tenant: monitoring line (kWh × rate) + offtaker line (N × $20),
  //    each shown, then summed. Card-on-file fields render the Payment-method row.
  var billingSummary = {
    billing_basis: "both",
    subscription_status: "active",
    monitoring_basis: "kwh",
    monitoring_total_cents: MONITORING_CENTS,
    mtd_kwh: MTD_KWH,
    blended_cents_per_kwh: RATE_CENTS_PER_KWH,
    offtaker_count: OFFTAKER_COUNT,
    invoicing_per_offtaker_cents: PER_OFFTAKER_CENTS,
    invoicing_total_cents: INVOICING_CENTS,
    total_cents: TOTAL_CENTS,
    period_start: iso(periodStart),
    // Payment method — Visa on file.
    has_payment_method: true,
    card_brand: "visa",
    card_last4: "4242",
    card_exp: "12/27",
  };

  // ── next-invoice — just the next charge date (renderBilling reads period_end).
  var nextInvoice = { period_end: iso(nextCharge) };

  // ── Offtakers (subscriptions) — shape consumed by subCard() (reports.js).
  //    Each bills from the operator's GMP utility bill, at the solar-credit rate.
  //    kWh values sum to a believable share of the 56 kW array's monthly output.
  function offtaker(id, name, email, kwh, pct, opts) {
    opts = opts || {};
    var amount = r2(kwh * CREDIT_RATE);
    return {
      id: id,
      customer_name: name,
      client_email: email,
      operator_email: account.email,
      enabled: true,
      cadence: "monthly",
      billing_model: "percent_of_array",
      delivery_mode: opts.delivery_mode || "draft",   // "auto" | "draft"
      send_mode: opts.send_mode || "to_client",
      allocation_pct: pct,
      array_id: 1,
      utility_account_id: 9001,                        // bound to a GMP bill source
      utility_account_name: "Catamount Community Solar · GMP",
      resolved_discount_pct: null,
      net_rate_per_kwh: CREDIT_RATE,
      formats: ["pdf"],
      cc_emails: "",
      source_filename: null,
      next_send_at: iso(nextCharge),
      last_sent_at: opts.last_sent_at || null,
      // preview line under the name in the list view.
      preview: { amount_owed: amount, customer_kwh: kwh },
      _demo_kwh: kwh,
      _demo_amount: amount,
    };
  }

  // Array produced ~8,120 kWh MTD; the prior settled month (the invoiced one) ran
  // ~9,400 kWh. The three offtakers take 38% / 22% / 14% shares of that.
  var ARRAY_MONTH_KWH = 9400;
  var k1 = Math.round(ARRAY_MONTH_KWH * 0.38);   // 3572
  var k2 = Math.round(ARRAY_MONTH_KWH * 0.22);   // 2068
  var k3 = Math.round(ARRAY_MONTH_KWH * 0.14);   // 1316

  var offtakers = [
    offtaker(701, "Bruce Genereaux — Valley Village", "bruce@valleyvillage.example", k1, 0.38,
      { delivery_mode: "draft", send_mode: "to_client" }),
    offtaker(702, "Smith Family Home", "smith.family@example.com", k2, 0.22,
      { delivery_mode: "auto", send_mode: "to_both", last_sent_at: iso(pe) }),
    offtaker(703, "Mad River Co-op Loft", "loft@madriver.example", k3, 0.14,
      { delivery_mode: "draft", send_mode: "to_client" }),
  ];

  // ── Drafts (pending, awaiting approval) — shape consumed by draftCard() /
  //    renderInboxBody() (reports.js). subscription_id is intentionally NULL so the
  //    backend-fetching live invoice-PDF pane is SKIPPED; reports.js paints a clean
  //    styled demo invoice card in its place (no broken canvas / no failing fetch).
  function draft(id, sub) {
    return {
      id: id,
      subscription_id: null,                  // null → no backend PDF fetch in the demo
      customer_name: sub.customer_name,
      client_email: sub.client_email,
      operator_name: account.operator_name,
      period_label: periodLabel,
      array_total_kwh: ARRAY_MONTH_KWH,
      customer_kwh: sub._demo_kwh,
      allocation_pct: sub.allocation_pct,
      amount_usd: sub._demo_amount,
      net_rate_per_kwh: CREDIT_RATE,
      discount_pct: null,
      cadence: "monthly",
      send_mode: sub.send_mode,
      invoice_number: "CCS-" + ps.getFullYear() + String(ps.getMonth() + 1).padStart(2, "0") + "-" + id,
      auto_attach_gmp: true,
      gmp_auto_status: "ready",
      has_gmp_pdf: true,
      gmp_filename: "gmp_bill_" + iso(ps) + ".pdf",
      include_summary: false,
      has_workbook: false,
      note: "",
      _demo: true,
    };
  }

  // Two offtakers have a report awaiting approval; the auto-send one already sent.
  var drafts = [draft(8801, offtakers[0]), draft(8803, offtakers[2])];

  // ── "Your files" — the invoice template, a billing workbook, and the captured
  //    GMP utility-bill PDFs. Shape consumed by loadAcctFiles() (sandbox.js).
  var files = [
    { name: "gmp_bill_" + iso(ps) + ".pdf", kind: "gmp_bill", role: "GMP utility bill · " + periodLabel,
      uploaded_at: iso(pe), size: 184320 },
    { name: "catamount_invoice_template.xlsx", kind: "template", role: "Your invoice template",
      uploaded_at: iso(ps), size: 28160 },
    { name: "billing_workbook_2026.xlsx", kind: "workbook", role: "Billing workbook",
      uploaded_at: iso(ps), size: 41984 },
  ];

  window.AO_DEMO = {
    account: account,
    billingSummary: billingSummary,
    nextInvoice: nextInvoice,
    offtakers: offtakers,
    drafts: drafts,
    files: files,
    // handy constants for any consumer that wants to render the bill breakdown.
    creditRate: CREDIT_RATE,
    periodLabel: periodLabel,
  };
})();
