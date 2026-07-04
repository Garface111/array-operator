/* ============================================================================
 * Array Operator — Reports tab (reports.js)
 *
 * Automatic billing reports. The operator drops a billing spreadsheet; we match
 * its schema (POST /v1/array-operator/billing/match), show what we recognized,
 * and let them set a schedule + recipient slider (to me / to my client / to
 * both) + format (PDF / Excel). Saving uploads the workbook and creates a
 * subscription the backend scheduler delivers automatically.
 *
 * Self-contained: exposes window.__aoLoadReports(); sandbox.js's loadReports()
 * delegates here. Same-origin /v1/* is proxied to the Railway backend.
 *
 * New classes (styled in command-center.css): .rb-*  (reports billing)
 * ==========================================================================*/
(function () {
  "use strict";

  const API = "/v1/array-operator/billing";
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const money = n => n == null ? "—"
    : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt0 = n => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  // Whole-dollar money for the GMP $25-per-error stakes ($25 / $1,675 — never $25.00).
  const money0 = n => n == null ? "—"
    : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function authHeaders() { const s = session(); return s ? { Authorization: "Bearer " + s } : null; }

  /* ===========================================================================
   * BILL ACCURACY CHECK — the per-offtaker GMP-allocation cross-check.
   *
   * The backend (/reconcile-bills) cross-checks two things per offtaker before the
   * operator sends an invoice:
   *   1. Production vs the GMP bill  — our metered kWh vs what GMP's meter says.
   *   2. GMP allocation cross-check — does the excess GMP credited THIS offtaker
   *      match (their share × the array bill's stated group excess)? When it
   *      doesn't, we reverse-solve the group total GMP implied — a number on
   *      neither bill = a caught billing error (Anna gets $25 per catch).
   *
   * Fetched ONCE per page load, cached on the module, indexed by sub_id. Woven into
   * the invoice-review flow (a "Bill accuracy check" section in each offtaker's
   * draft card) + a top-level summary chip when anything is flagged. Honest, quiet
   * treatment for the "check couldn't run yet" states; amber (not red) for soft
   * flags; the allocation $-mismatch is the one prominent catch.
   * ==========================================================================*/
  let RECON = null;                 // full /reconcile-bills payload (cached)
  let RECON_BY_SUB = {};            // sub_id -> subscription reconcile row
  let _reconPromise = null;         // in-flight fetch (dedupe concurrent callers)
  function reconIndex() {
    RECON_BY_SUB = {};
    if (RECON && Array.isArray(RECON.subscriptions))
      RECON.subscriptions.forEach(r => { if (r && r.sub_id != null) RECON_BY_SUB[String(r.sub_id)] = r; });
  }
  // Fetch the reconcile payload once; return the cache on repeat calls. Fails soft
  // (a network/500 error just leaves the accuracy check absent — never blocks the
  // invoice flow). Refetched naturally on a page reload (module state resets).
  function loadReconcile() {
    if (RECON) return Promise.resolve(RECON);
    if (_reconPromise) return _reconPromise;
    if (!authHeaders()) return Promise.resolve(null);
    // The server computes the sweep in the background (63s at 800 offtakers
    // crossed the edge gateway timeout) — {pending:true} means "poll again".
    _reconPromise = (async () => {
      for (let i = 0; i < 45; i++) {                 // ≤ ~7.5 min of 10s polls
        try {
          const r = await fetch(API + "/reconcile-bills", { headers: authHeaders() });
          if (!r.ok) return null;
          const d = await r.json().catch(() => null);
          if (d && d.ok) { RECON = d; reconIndex(); return RECON; }
          if (!d || !d.pending) return null;
        } catch (e) { return null; }
        await new Promise(res => setTimeout(res, 10000));
      }
      return null;
    })().then(v => { _reconPromise = null; return v; });
    return _reconPromise;
  }
  function reconFor(subId) { return subId == null ? null : RECON_BY_SUB[String(subId)] || null; }

  // Plain-English label + tone for an array-row production-vs-bill verdict.
  const _ARR_STATUS = {
    match:           { cls: "ok",   label: "Matches the GMP bill" },
    mismatch:        { cls: "warn", label: "Differs from the GMP bill" },
    no_bill:         { cls: "mute", label: "No GMP bill for this period yet" },
    no_invoice_data: { cls: "mute", label: "No production data yet" },
    unverified:      { cls: "mute", label: "Awaiting measured data to verify" },
  };
  // The array-level production-vs-bill rows: our metered kWh vs GMP's, per array.
  function reconArraysHTML(row) {
    const arrs = (row && row.arrays) || [];
    if (!arrs.length) return "";
    const rows = arrs.map(a => {
      const meta = _ARR_STATUS[a.status] || { cls: "mute", label: a.status || "—" };
      const dpct = a.delta_pct != null ? (a.delta_pct > 0 ? "+" : "") + Number(a.delta_pct).toFixed(1) + "%" : null;
      const cmp = (a.status === "match" || a.status === "mismatch")
        ? `<span class="rb-bac-cmp">${fmt0(a.our_kwh)} <span class="rb-bac-vs">vs</span> ${fmt0(a.gmp_kwh)} kWh${dpct ? ` <span class="rb-bac-delta rb-bac-${meta.cls}">${esc(dpct)}</span>` : ""}</span>`
        : `<span class="rb-bac-cmp rb-bac-mute">${a.our_kwh != null ? fmt0(a.our_kwh) + " kWh (ours)" : "—"}</span>`;
      return `<div class="rb-bac-arow">
          <div class="rb-bac-atop">
            <span class="rb-bac-aname">${esc(a.array_name || ("Array " + (a.array_id != null ? a.array_id : "")))}</span>
            <span class="rb-bac-verdict rb-bac-${meta.cls}">${esc(meta.label)}</span>
          </div>
          ${cmp}
          ${a.mismatch_reason ? `<div class="rb-bac-reason">${esc(a.mismatch_reason)}</div>` : ""}
        </div>`;
    }).join("");
    return `<div class="rb-bac-block">
        <div class="rb-bac-blabel">Production vs GMP bill<small>our metered kWh vs the utility's meter</small></div>
        ${rows}
      </div>`;
  }

  // The GMP allocation cross-check — Bruce's worked example. `note` is authored by
  // the backend in plain English; we render it, we don't re-derive it. The mismatch
  // dollar figure is the $25 catch, so it leads; honest non-run states render quietly.
  const _ALLOC_QUIET = {
    single_meter:         "This offtaker is on the array's own meter — there's no separate GMP allocation to cross-check.",
    no_offtaker_account:  "Awaiting this offtaker's own GMP account to cross-check the allocation.",
    no_offtaker_bill:     "Awaiting a GMP bill on this offtaker's account to cross-check the allocation.",
    no_array_bill:        "Awaiting the array's GMP bill to cross-check the allocation.",
    no_share:             "Set this offtaker's share to cross-check the GMP allocation.",
  };
  function reconAllocHTML(row) {
    const al = row && row.allocation;
    if (!al || !al.status) return "";
    const note = al.note ? `<div class="rb-bac-note">${esc(al.note)}</div>` : "";
    if (al.status === "mismatch") {
      // The stake is GMP's $25 billing-error credit — the kWh-delta dollars
      // (often cents) live in the note as the size of the mis-allocation.
      const stake = money0(al.at_stake_usd != null ? al.at_stake_usd : 25);
      return `<div class="rb-bac-block rb-bac-flag">
          <div class="rb-bac-blabel">
            <span class="rb-bac-flagicon" aria-hidden="true">⚑</span>GMP allocation cross-check
            <span class="rb-bac-atstake" title="GMP credits $25 per billing error they made — a confirmed catch is worth ${esc(stake)}.">${stake} at stake</span>
          </div>
          <div class="rb-bac-figs">
            <div class="rb-bac-fig"><b>${fmt0(al.offtaker_credited_kwh)}</b><span>GMP credited this offtaker</span></div>
            <div class="rb-bac-fig"><b>${fmt0(al.expected_kwh)}</b><span>expected (share × group excess)</span></div>
            <div class="rb-bac-fig rb-bac-fig-imp"><b>${fmt0(al.implied_group_total_kwh)}</b><span>group total GMP implied</span></div>
            <div class="rb-bac-fig"><b>${fmt0(al.array_group_excess_kwh)}</b><span>group excess on the array bill</span></div>
          </div>
          ${note}
        </div>`;
    }
    if (al.status === "match") {
      return `<div class="rb-bac-block">
          <div class="rb-bac-blabel">GMP allocation cross-check
            <span class="rb-bac-ok-pill">✓ checks out</span></div>
          ${note}
        </div>`;
    }
    if (al.status === "error") {
      return `<div class="rb-bac-block">
          <div class="rb-bac-blabel rb-bac-mute">GMP allocation cross-check</div>
          <div class="rb-bac-note rb-bac-mute">${esc(al.note || "Couldn't run this check right now.")}</div>
        </div>`;
    }
    // Honest non-run states — render the note quietly, never as a flag.
    const quiet = al.note || _ALLOC_QUIET[al.status] || "This check isn't ready to run yet.";
    return `<div class="rb-bac-block">
        <div class="rb-bac-blabel rb-bac-mute">GMP allocation cross-check</div>
        <div class="rb-bac-note rb-bac-mute">${esc(quiet)}</div>
      </div>`;
  }

  // The full per-offtaker "Bill accuracy check" body for a draft's subscription.
  // Returns null when we have no reconcile row for it (so the section can hide).
  function reconPanelHTML(subId) {
    const row = reconFor(subId);
    if (!row) return null;
    const arrs = reconArraysHTML(row);
    const alloc = reconAllocHTML(row);
    if (!arrs && !alloc) return null;
    return `<div class="rb-bac">${arrs}${alloc}</div>`;
  }
  // Does this offtaker's check carry a hard flag (the allocation $-mismatch)?
  function reconFlagged(subId) {
    const row = reconFor(subId);
    return !!(row && row.allocation && row.allocation.status === "mismatch");
  }
  // Sub-label for the collapsed section header — surfaces the catch without a click.
  function reconSecSub(subId) {
    const row = reconFor(subId);
    if (!row) return "";
    if (row.allocation && row.allocation.status === "mismatch") {
      const s = row.allocation.at_stake_usd != null ? row.allocation.at_stake_usd : 25;
      return "⚑ allocation mismatch — " + money0(s) + " at stake";
    }
    const arrMis = (row.arrays || []).some(a => a.status === "mismatch");
    if (arrMis) return "⚑ differs from the GMP bill";
    if (row.overall_status === "match") return "✓ reconciles cleanly";
    if (row.overall_status === "unverified") return "awaiting measured data to verify";
    return "production vs the utility bill";
  }

  // The top-level summary strip in the generator hero: a subtle amber chip when
  // anything is flagged (allocation mismatches + array production-vs-bill
  // mismatches), or a quiet "bills reconcile cleanly" note when the check ran and
  // found nothing. Nothing at all before the check has run. Clicking the chip opens
  // the first flagged offtaker's card so the operator lands straight on the catch.
  function reconArrayMismatchCount() {
    if (!RECON || !Array.isArray(RECON.subscriptions)) return 0;
    return RECON.subscriptions.filter(r =>
      (r.arrays || []).some(a => a.status === "mismatch")).length;
  }
  // The sub_id of the first offtaker carrying a hard flag, for click-to-jump.
  function firstFlaggedSub() {
    if (!RECON || !Array.isArray(RECON.subscriptions)) return null;
    const hit = RECON.subscriptions.find(r =>
      (r.allocation && r.allocation.status === "mismatch") ||
      (r.arrays || []).some(a => a.status === "mismatch"));
    return hit ? hit.sub_id : null;
  }
  function bacSummaryHTML() {
    if (!RECON) return "";                       // check hasn't run yet — show nothing
    const allocN = RECON.allocation_flagged || 0;
    const arrN = reconArrayMismatchCount();
    // The stake is GMP's $25 billing-error credit per catch — NOT the kWh-delta
    // dollars (that's just the mis-allocation's size, often cents).
    const atStake = RECON.allocation_at_stake_usd != null
      ? RECON.allocation_at_stake_usd : allocN * 25;
    const flaggedSubs = new Set();
    let unverifiedSubs = 0;
    (RECON.subscriptions || []).forEach(r => {
      const genuine = (r.allocation && r.allocation.status === "mismatch") ||
                      (r.arrays || []).some(a => a.status === "mismatch");
      if (genuine) flaggedSubs.add(r.sub_id);
      else if ((r.arrays || []).some(a => a.status === "unverified")) unverifiedSubs++;
    });
    const n = flaggedSubs.size;
    // What this chip is: we cross-check each offtaker's MEASURED production and
    // GMP's allocation against the actual utility bill, to catch GMP billing
    // errors. Only a GENUINE discrepancy (real data on both sides) counts as
    // "to review" — an offtaker we simply can't verify yet (no measured
    // generation, a prorated estimate) is honestly "awaiting data", not flagged.
    if (!n) {
      if (unverifiedSubs) {
        return `<span class="rb-bac-clean" title="We cross-check each offtaker's measured production and GMP's allocation against the utility bill. No discrepancies found; ${unverifiedSubs} can't be fully verified until measured generation data lands.">✓ No billing discrepancies · ${unverifiedSubs} awaiting data</span>`;
      }
      return `<span class="rb-bac-clean" title="We cross-check each offtaker's measured production and GMP's allocation against the utility bill — everything reconciles.">✓ Utility bills reconcile</span>`;
    }
    const dTxt = atStake > 0 ? ` · ≈ ${money0(atStake)} at stake` : "";
    const label = `⚑ ${n} bill${n === 1 ? "" : "s"} to review — doesn't match GMP${dTxt}`;
    const tip = allocN
      ? `The utility bill doesn't match our numbers for ${n} offtaker${n === 1 ? "" : "s"}: ${allocN} GMP allocation error${allocN === 1 ? "" : "s"}${arrN ? " + " + arrN + " production difference" + (arrN === 1 ? "" : "s") : ""}. GMP credits $25 per billing error they made — that's ${money0(atStake)} across these catches. Click to open the Bill audit.`
      : `Measured production differs from the GMP bill for ${arrN} offtaker${arrN === 1 ? "" : "s"} — a possible billing error. Click to open the Bill audit.`;
    return `<span class="rb-bac-chip" id="rbBacChip" role="button" tabindex="0" title="${esc(tip)}">${label}</span>`;
  }
  // Flip the generator to the Bill-audit tab (the flagged chip's destination —
  // that's where the catches live, organized the way GMP allocates them).
  function openAuditTab() {
    const btn = document.querySelector('#rbGenTabs [data-gentab="audit"]');
    if (btn) { btn.click(); return true; }
    return false;
  }
  // The little flagged-count badge on the "Bill audit" tab label itself —
  // visible before the tab is ever opened (populated when RECON lands).
  function updateAuditTabBadge() {
    const b = document.getElementById("rbAuditTabBadge");
    if (!b) return;
    const n = (RECON && RECON.allocation_flagged) || 0;
    b.hidden = !n;
    if (n) b.textContent = "⚑ " + n;
  }
  // Re-render the summary chip in place (after the reconcile data lands post-paint).
  function refreshBacSummary() {
    const host = document.getElementById("rbBacSummary");
    if (!host) return;
    host.innerHTML = bacSummaryHTML();
    wireBacChip(host);
    updateAuditTabBadge();
    renderKpis();   // the "Doesn't match GMP" KPI tile fills when RECON lands
  }
  function wireBacChip(host) {
    const chip = host && host.querySelector("#rbBacChip");
    updateAuditTabBadge();
    if (!chip) return;
    const jump = () => {
      // The Bill-audit tab IS the review surface for these catches (Ford,
      // 2026-07-03) — fall back to the first flagged card if the tab's absent.
      if (openAuditTab()) return;
      const sid = firstFlaggedSub();
      if (sid == null) return;
      expandAccordion(String(sid));
    };
    chip.onclick = jump;
    chip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } };
  }

  /* ── Generation-time cross-check (Bruce, 2026-07) ────────────────────────────
   * POST /subscriptions/{id}/draft now returns `crosscheck`: the share GMP
   * effectively used for this offtaker (credited ÷ the array bill's group
   * excess) vs the share the operator entered, flagged beyond the backend's
   * SHARE_VARIANCE_THRESHOLD_PCT (or the audit's kWh tolerance). Captured at
   * EVERY generation site (open-card mint, background refresh, money edits,
   * quarterly draft) and rendered as an inline strip at the top of the draft
   * card — the check "pops up when an invoice is generated" (Bruce), always as
   * fresh as the draft itself (the page-load /reconcile-bills snapshot backs
   * the fuller "Bill accuracy check" section below it). null = the check can't
   * run honestly yet (no settled bill / no share / single meter) → no strip,
   * never a fabricated verdict. */
  const XCHECK_BY_SUB = {};          // sub_id -> crosscheck object | null
  // 2-decimal share/variance formatter (25.53%, not 25.5300%).
  const fmtPct = n => n == null ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  // Record a POST /draft response's crosscheck + repaint the open card's strip
  // in place. Tolerates old/partial responses (no `crosscheck` key → no-op).
  function noteXcheck(subId, data) {
    if (!data || typeof data !== "object" || !("crosscheck" in data)) return;
    XCHECK_BY_SUB[String(subId)] = data.crosscheck;
    refreshXcheck(subId);
  }
  function refreshXcheck(subId) {
    const host = document.querySelector(`.rb-xcheck-host[data-xcheck="${String(subId)}"]`);
    if (host) host.innerHTML = xcheckHTML(subId);
  }
  function xcheckHTML(subId) {
    const x = XCHECK_BY_SUB[String(subId)];
    if (!x) return "";               // not run yet / can't run — honest silence
    const th = x.threshold_pct != null ? x.threshold_pct : 0.1;
    if (!x.flagged) {
      // Quiet green line: the numbers agree — say so with the real shares.
      return `<div class="rb-xcheck rb-xcheck-ok" role="status">✓ Cross-check — GMP's share matches yours within ${fmtPct(th)}%`
        + ` <small>(${fmtPct(x.computed_share_pct)}% on the bills · ${fmtPct(x.entered_share_pct)}% entered)</small></div>`;
    }
    // Prominent warning strip with the real numbers — the operator sees exactly
    // what disagrees before Approve & send.
    const offKwh = x.delta_kwh != null ? Math.abs(Number(x.delta_kwh)) : null;
    const dollars = x.delta_dollars ? ` ≈ ${money(Math.abs(x.delta_dollars))}` : "";
    const offLine = offKwh != null
      ? `Off by ${fmt0(offKwh)} kWh${dollars} · variance ${fmtPct(Math.abs(x.variance_pct))}% (flags beyond ${fmtPct(th)}%). `
      : "";
    return `<div class="rb-xcheck rb-xcheck-flag" role="alert">
        <div class="rb-xcheck-head"><span class="rb-xcheck-ico" aria-hidden="true">⚑</span>Cross-check — GMP's bill doesn't match this offtaker's share</div>
        <div class="rb-xcheck-figs">
          <span class="rb-xcheck-fig"><b>${fmtPct(x.computed_share_pct)}%</b><small>share GMP's bills imply</small></span>
          <span class="rb-xcheck-fig"><b>${fmtPct(x.entered_share_pct)}%</b><small>share you entered</small></span>
          <span class="rb-xcheck-fig"><b>${fmt0(x.kwh_offtaker_credited)}</b><small>kWh GMP credited them</small></span>
          <span class="rb-xcheck-fig"><b>${fmt0(x.kwh_offtaker_expected)}</b><small>kWh expected (${fmtPct(x.entered_share_pct)}% × ${fmt0(x.kwh_master)})</small></span>
        </div>
        <div class="rb-xcheck-note">${offLine}Check the entered share or GMP's bill before sending — details in the Bill accuracy check below.</div>
      </div>`;
  }

  /* ===========================================================================
   * BILL AUDIT SANDBOX — Ford/Bruce's "organize the fleet the way GMP allocates it
   * so you can catch GMP's per-offtaker math errors visually".
   *
   * Pull the ARRAY's master utility bill (e.g. Londonderry, 100 kWh of group
   * excess), lay each offtaker's OWN utility bill underneath it (Brooks House 50%
   * → should show 50, …), and FLAG it when GMP's number doesn't match the math.
   * Sub-tabs per utility (GMP / VEC / …). Reads GET /audit-by-array (auth), cached,
   * refetched on reload; signed-in only; fails soft.
   * ==========================================================================*/
  let AUDIT = null;                 // /audit-by-array payload (cached)
  let _auditPromise = null;
  let AUDIT_PROVIDER = null;        // which utility sub-tab is active (provider string)
  function loadAudit() {
    if (AUDIT) return Promise.resolve(AUDIT);
    if (_auditPromise) return _auditPromise;
    if (!authHeaders()) return Promise.resolve(null);
    // Server computes the sweep in the background — {pending:true} = poll again.
    _auditPromise = (async () => {
      for (let i = 0; i < 45; i++) {                 // ≤ ~7.5 min of 10s polls
        try {
          const r = await fetch(API + "/audit-by-array", { headers: authHeaders() });
          if (!r.ok) return null;
          const d = await r.json().catch(() => null);
          if (d && d.ok) { AUDIT = d; return AUDIT; }
          if (!d || !d.pending) return null;
        } catch (e) { return null; }
        await new Promise(res => setTimeout(res, 10000));
      }
      return null;
    })().then(v => { _auditPromise = null; return v; });
    return _auditPromise;
  }

  const AUDIT_PROVIDER_LABEL = { gmp: "GMP", vec: "VEC", wec: "WEC", smarthub: "SmartHub/co-op", other: "Other" };
  function auditProviderLabel(p) {
    if (!p) return "Other";
    return AUDIT_PROVIDER_LABEL[String(p).toLowerCase()] || String(p).toUpperCase();
  }
  // Honest non-run states → a quiet grey note, never a flag or a fake ✓.
  const AUDIT_QUIET = {
    single_meter:        "On the array's own meter — no separate GMP allocation to audit.",
    no_offtaker_account: "Awaiting this offtaker's own utility account to audit the allocation.",
    no_offtaker_bill:    "Awaiting a utility bill on this offtaker's account.",
    no_array_bill:       "Awaiting the array's master utility bill.",
    no_share:            "Set this offtaker's share to audit the allocation.",
  };

  // One offtaker row under an array's master bill.
  function auditOfftakerRow(o) {
    const sharePct = o.share_pct != null ? (Math.round(o.share_pct * 1000) / 10) + "%" : "—";
    const credited = o.gmp_credited_kwh != null ? fmt0(o.gmp_credited_kwh) : "—";
    const should = o.should_be_kwh != null ? fmt0(o.should_be_kwh) : "—";
    if (o.status === "mismatch") {
      const dk = o.delta_kwh;
      const deltaTxt = dk != null ? (dk > 0 ? "+" : "") + fmt0(dk) + " kWh" : "—";
      // Stake = GMP's $25 billing-error credit (the kWh-delta $ lives in the note).
      const stake = money0(o.at_stake_usd != null ? o.at_stake_usd : 25);
      return `<div class="rb-au-off rb-au-flag">
          <div class="rb-au-off-top">
            <span class="rb-au-off-name"><span class="rb-au-flagicon" aria-hidden="true">⚑</span>${esc(o.customer_name || "(unnamed offtaker)")}</span>
            <span class="rb-au-off-share">${sharePct} share</span>
          </div>
          <div class="rb-au-figs">
            <span class="rb-au-fig"><b>${credited}</b><small>GMP credited</small></span>
            <span class="rb-au-fig"><b>${should}</b><small>should be</small></span>
            <span class="rb-au-fig rb-au-fig-delta"><b>${esc(deltaTxt)}</b><small>Δ vs the math</small></span>
            <span class="rb-au-atstake" title="GMP credits $25 per billing error they made — a confirmed catch is worth ${esc(stake)}.">${stake} at stake</span>
          </div>
          ${o.note ? `<div class="rb-au-note">${esc(o.note)}</div>` : ""}
        </div>`;
    }
    if (o.status === "match") {
      return `<div class="rb-au-off">
          <div class="rb-au-off-top">
            <span class="rb-au-off-name">${esc(o.customer_name || "(unnamed offtaker)")}</span>
            <span class="rb-au-off-share">${sharePct} share</span>
          </div>
          <div class="rb-au-figs">
            <span class="rb-au-fig"><b>${credited}</b><small>GMP credited</small></span>
            <span class="rb-au-fig"><b>${should}</b><small>should be</small></span>
            <span class="rb-au-ok">✓ matches</span>
          </div>
        </div>`;
    }
    // Honest non-run state — render the note quietly in grey.
    const quiet = o.note || AUDIT_QUIET[o.status] || "Not enough data to audit this offtaker yet.";
    return `<div class="rb-au-off rb-au-quiet">
        <div class="rb-au-off-top">
          <span class="rb-au-off-name">${esc(o.customer_name || "(unnamed offtaker)")}</span>
          <span class="rb-au-off-share">${sharePct} share</span>
        </div>
        <div class="rb-au-note rb-au-mute">${esc(quiet)}</div>
      </div>`;
  }

  // One array card: the MASTER bill row on top + its offtaker rows underneath.
  function auditArrayCard(a) {
    const flagged = (a.offtakers || []).filter(o => o.status === "mismatch").length;
    const rate = a.credit_rate != null ? "$" + Number(a.credit_rate).toFixed(4) + "/kWh" : null;
    const rows = (a.offtakers || []).map(auditOfftakerRow).join("")
      || `<div class="rb-au-off rb-au-quiet"><div class="rb-au-note rb-au-mute">No offtakers on this array yet.</div></div>`;
    return `<div class="rb-au-card${flagged ? " rb-au-card-flag" : ""}">
        <div class="rb-au-master">
          <div class="rb-au-master-name">${esc(a.array_name || ("Array " + (a.array_id != null ? a.array_id : "")))}
            ${flagged ? `<span class="rb-au-card-badge">⚑ ${flagged} flagged</span>` : ""}</div>
          <div class="rb-au-master-meta">
            <span class="rb-au-excess">Group excess <b>${a.group_excess_kwh != null ? fmt0(a.group_excess_kwh) + " kWh" : "—"}</b></span>
            ${rate ? `<span class="rb-au-rate">${esc(rate)}</span>` : ""}
          </div>
        </div>
        <div class="rb-au-offs">${rows}</div>
      </div>`;
  }

  // Render the whole Bill-audit view into #rbAuditView (per-utility sub-tabs + array cards).
  function renderAudit() {
    const host = document.getElementById("rbAuditView");
    if (!host) return;
    if (!authHeaders()) { host.innerHTML = auditEmptyHTML("Sign in to audit GMP's per-offtaker allocation."); return; }
    if (!AUDIT) {
      // not loaded yet — kick the fetch, show a light loading state.
      host.innerHTML = `<div class="rb-au-loading">Loading the bill audit…</div>`;
      loadAudit().then(a => { if (a) renderAudit(); else host.innerHTML = auditEmptyHTML(); });
      return;
    }
    const utilities = (AUDIT.utilities || []).filter(u => (u.arrays || []).length);
    if (!utilities.length) {
      host.innerHTML = auditEmptyHTML();
      return;
    }
    // Which sub-tab is active — default to the first utility (or the last picked, if still present).
    if (!AUDIT_PROVIDER || !utilities.some(u => u.provider === AUDIT_PROVIDER)) {
      AUDIT_PROVIDER = utilities[0].provider;
    }
    const active = utilities.find(u => u.provider === AUDIT_PROVIDER) || utilities[0];

    // Summary line from the tenant totals. The headline $ is the SUM of GMP's
    // $25 billing-error credits across every flagged bill (Ford: "at the top,
    // add up all of that so you can see how much is at stake").
    const t = AUDIT.totals || {};
    const atStake = t.at_stake_usd != null ? t.at_stake_usd : (t.flagged || 0) * 25;
    const dTxt = t.flagged
      ? ` · ≈ ${money0(atStake)} at stake <small class="rb-au-sum-why">GMP credits $25 per billing error</small>`
      : "";
    const flagClass = t.flagged ? "rb-au-sum-flag" : "";
    const summary = `<div class="rb-au-summary ${flagClass}">
        <b>${fmt0(t.arrays || 0)}</b> array${(t.arrays === 1) ? "" : "s"} ·
        <b>${fmt0(t.offtakers || 0)}</b> offtaker${(t.offtakers === 1) ? "" : "s"} ·
        <span class="rb-au-sum-flagged">${t.flagged ? "⚑ " : "✓ "}<b>${fmt0(t.flagged || 0)}</b> flagged${dTxt}</span>
      </div>`;

    // Per-utility sub-tabs (GMP / VEC / …), each with its own flagged count.
    const subtabs = utilities.map(u => {
      const uFlag = (u.arrays || []).reduce((n, a) => n + (a.offtakers || []).filter(o => o.status === "mismatch").length, 0);
      const on = u.provider === AUDIT_PROVIDER;
      return `<button type="button" class="rb-au-tab${on ? " on" : ""}" data-au-prov="${esc(u.provider)}">
          ${esc(auditProviderLabel(u.provider))}${uFlag ? `<span class="rb-au-tab-flag">${uFlag}</span>` : ""}
        </button>`;
    }).join("");

    const cards = (active.arrays || []).map(auditArrayCard).join("");

    host.innerHTML = `
      <div class="rb-au-head">
        <div class="rb-au-title">Bill audit <span class="rb-au-eyebrow">GMP allocation cross-check</span></div>
        <p class="rb-au-lead">The array's master utility bill on top; each offtaker's own bill underneath. We flag it when GMP's credited kWh doesn't match <b>their share × the array's group excess</b>.</p>
      </div>
      ${summary}
      <div class="rb-au-tabs" role="tablist">${subtabs}</div>
      <div class="rb-au-cards">${cards}</div>`;

    // Wire the sub-tabs.
    host.querySelectorAll("[data-au-prov]").forEach(b => b.onclick = () => {
      AUDIT_PROVIDER = b.getAttribute("data-au-prov");
      renderAudit();
    });
  }
  function auditEmptyHTML(msg) {
    return `<div class="rb-au-empty">${esc(msg || "Connect an array's utility bill + its offtakers' bills to audit GMP's allocation. Once both are on file, this shows the array's group excess with each offtaker's share checked against what GMP actually credited them.")}</div>`;
  }

  // The "Offtakers | Bill audit" segmented toggle at the top of the generator: swaps
  // the body between the offtaker list (#rbGenList) and the Bill-audit sandbox
  // (#rbAuditView). Lazily fetches the audit on first switch. Works in the demo too
  // (renderAudit shows the sign-in/empty state without a live fetch).
  function wireGenTabs() {
    const tabs = Array.from(document.querySelectorAll("#rbGenTabs [data-gentab]"));
    if (!tabs.length) return;
    const list = document.getElementById("rbGenList");
    const audit = document.getElementById("rbAuditView");
    tabs.forEach(btn => btn.onclick = () => {
      const v = btn.getAttribute("data-gentab");
      tabs.forEach(b => b.classList.toggle("on", b === btn));
      if (list) list.style.display = v === "offtakers" ? "" : "none";
      if (audit) audit.style.display = v === "audit" ? "" : "none";
      if (v === "audit") renderAudit();   // lazy render + fetch on first view
    });
  }

  // ── pdf.js: paint page 1 of a PDF onto a <canvas> inside `paper` — no browser
  //    PDF-viewer chrome. Shared by the template-card preview AND the approval-inbox
  //    draft preview, so both show the REAL reproduced invoice (not lossy token-HTML).
  let _pdfjsPromise = null;
  function _ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfjsPromise) return _pdfjsPromise;
    const BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    _pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = BASE + "pdf.min.js";
      s.onload = () => {
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + "pdf.worker.min.js"; resolve(window.pdfjsLib); }
        catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error("pdfjs load failed"));
      document.head.appendChild(s);
    });
    return _pdfjsPromise;
  }
  function _pdfFallbackIframe(buf, paper) {            // CDN-down fallback: native viewer, chrome suppressed
    try {
      const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      paper.innerHTML = '<iframe class="rb-tpl-frame" title="Invoice preview" src="' +
        url + '#toolbar=0&navpanes=0&scrollbar=0&view=FitH"></iframe>';
    } catch (e) { paper.innerHTML = '<div class="rb-tpl-load">Preview unavailable.</div>'; }
  }
  async function renderPdfToPaper(buf, paper) {
    if (!paper) return;
    let lib;
    try { lib = await _ensurePdfJs(); } catch (e) { return _pdfFallbackIframe(buf, paper); }
    // Keep a copy of the bytes BEFORE pdf.js consumes them (it transfers the buffer to
    // its worker, detaching the original) so the click-to-enlarge lightbox can re-render.
    const lbBuf = buf.slice(0);
    try {
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      const page = await pdf.getPage(1);
      const cssW = Math.max(240, paper.clientWidth || 520);
      const base = page.getViewport({ scale: 1 });
      // Render at a HIGH internal resolution, independent of the display size. The canvas
      // is shown at the container width (CSS width:100%), so extra internal pixels just
      // sharpen the small invoice numbers. Target ~3x the display width (capped) so the
      // figures stay legible enough to verify — Ford: "hard to read the numbers."
      const targetW = Math.min(Math.max(cssW * 3, 1600), 2600);
      const vp = page.getViewport({ scale: targetW / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      paper.innerHTML = "";
      paper.appendChild(canvas);
      // Click to enlarge — a full-screen, even sharper view to read every number.
      canvas.classList.add("rb-tpl-zoomable");
      canvas.title = "Click to enlarge";
      canvas.onclick = () => _pdfLightbox(lbBuf);
    } catch (e) { _pdfFallbackIframe(buf, paper); }
  }

  // Full-screen lightbox of the invoice — large + crisp so every number is readable.
  // Click anywhere (or Esc) to dismiss.
  async function _pdfLightbox(buf) {
    let lib;
    try { lib = await _ensurePdfJs(); } catch (e) { return; }
    const overlay = document.createElement("div");
    overlay.className = "rb-tpl-lightbox";
    overlay.innerHTML = '<div class="rb-tpl-lb-inner"><div class="rb-tpl-load" style="color:#9fb0c0">Rendering…</div></div>';
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.onclick = close;
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    try {
      // pdf.js transfers (and detaches) the buffer it's given, so render from a fresh
      // COPY each time — otherwise the first enlarge consumes `buf` and every later
      // click gets a detached/empty buffer and silently fails (Ford: "only works once").
      const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const dispW = Math.min((window.innerWidth || 1200) * 0.92, 1500);
      const ratio = Math.min((window.devicePixelRatio || 1) * 1.5, 3);
      const vp = page.getViewport({ scale: (dispW / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      canvas.style.width = Math.round(dispW) + "px";
      canvas.style.height = "auto";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const inner = overlay.querySelector(".rb-tpl-lb-inner");
      if (inner) { inner.innerHTML = ""; inner.appendChild(canvas); }
    } catch (e) { close(); }
  }

  const MODEL_LABEL = {
    fixed_budget: "Fixed monthly budget",
    flat_rate: "Flat rate + true-up",
    percent_of_array: "% of array generation",
  };

  // pending match awaiting "Save schedule" — holds the File + parsed match.
  let PENDING = null;

  function root() { return document.getElementById("reportsRoot"); }

  // Canonical GMP-bill attachment name: gmp_utility_bill_<offtaker>_<period>.pdf —
  // matches the invoice's own name so the offtaker gets a self-describing file, not
  // the operator's raw upload name. Mirrors the backend (delivery.py generate_files).
  function gmpBillFilename(d) {
    const slug = String((d && d.customer_name) || "offtaker").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "offtaker";
    const suf = (d && d.invoice_number) ? "_" + d.invoice_number : "";
    return `gmp_utility_bill_${slug}${suf}.pdf`;
  }

  // ---- top-level entry -------------------------------------------------------
  // load() runs on every Reports tab activation. It used to rebuild the whole
  // shell + re-fetch everything (including the heavy invoice-template PDF
  // preview) on EVERY visit — so the tab visibly "reloaded" each time. It's now
  // idempotent: build the shell + wire handlers ONCE, render the heavy template
  // preview once (and only when the tab is actually viewed, not during an idle
  // prefetch), and never re-blank an already-rendered tab — just a quiet
  // background data refresh when the cached data has gone stale. Result: instant
  // on revisit, and instant on first open when warmed during idle (see below).
  let _dataAt = 0;
  let _tplWired = false;
  const DATA_TTL_MS = 45000;
  async function load(opts) {
    const el = root();
    if (!el) return;
    if (!authHeaders()) {
      // Signed-out DEMO: render a fully-populated Offtaker Invoice Generator for
      // the fake operator (Catamount Community Solar) — its offtaker list + an
      // approval inbox with a styled demo invoice — instead of the sign-in wall.
      // Gated on the demo module; the real signed-in path (authHeaders truthy)
      // is never affected.
      if (window.AO_DEMO && Array.isArray(window.AO_DEMO.offtakers)) {
        renderDemo(el);
        return;
      }
      el.innerHTML = signInPrompt();
      el.dataset.rbBuilt = "";
      _dataAt = 0; _tplWired = false;
      return;
    }
    const prefetch = !!(opts && opts.prefetch);
    const built = el.dataset.rbBuilt === "1" && document.getElementById("rbList");
    if (!built) {
      // The guided setup wizard was removed — the operator works the tab
      // directly: set the global rate, "＋ Add an offtaker", and link GMP bills.
      el.innerHTML = shell();
      wireSubtabs();
      wireGenTabs();   // "Offtakers | Bill audit" segmented toggle
      wireGlobalRate();
      // "＋ Add an offtaker" opens a tabbed panel (Type it in / Upload a
      // spreadsheet); the upload zone + live doc-preview live inside that panel
      // now, so wireUpload()/renderDoc() are wired when the upload tab opens.
      MANUAL_HOST_ID = "rbCustManual";
      MANUAL_AFTER_ADD = refreshList;
      MANUAL_OPEN = false;
      const addBtn = $("#rbCustAdd");
      if (addBtn) addBtn.onclick = () => { BULK_OPEN = false; renderBulkImport(); MANUAL_OPEN = true; renderManual(); };
      // "⬆ Bulk import" — a CSV roster (name/percent/account number) creates many
      // offtakers at once instead of one at a time. Closes the manual panel if open
      // (the two are mutually exclusive — never two add-flows stacked at once).
      const bulkBtn = $("#rbBulkImport");
      if (bulkBtn) bulkBtn.onclick = () => { MANUAL_OPEN = false; renderManual(); BULK_OPEN = true; renderBulkImport(); };
      // "Link utility bills" — ONE button opens the utility picker (every supported
      // utility, searchable — GMP/VEC/WEC quick-picks + ~470 SmartHub co-ops from
      // /v1/providers). The owner picks theirs; the extension opens that portal and
      // captures the bills, which then appear in the offtaker utility-account picker.
      // Offtaker invoices bill from these utility bills only.
      const linkUtilBtn = $("#rbLinkUtility");
      if (linkUtilBtn) linkUtilBtn.onclick = () => {
        if (window.__aoLinkUtility) { window.__aoLinkUtility(); }
        else { location.hash = "#arrays"; }   // defensive: sandbox owns the modal
      };
      // "✉ Customize email" — the MASS offtaker-email template studio.
      const esBtn = $("#rbEmailStudio");
      if (esBtn) esBtn.onclick = openEmailStudio;
      // "⬇ Export to QuickBooks / Xero" — this reaches shell() only on the signed-in
      // path (the signed-out/demo branch returns earlier), so revealing + wiring the
      // export box here inherently gates it to authed operators.
      wireExport();
      // The Export controls now live in ONE popover (approved redesign) —
      // the button toggles it; any outside click closes it.
      const xBtn = $("#rb2ExportBtn"), xPop = $("#rb2ExportPop");
      if (xBtn && xPop) {
        xBtn.onclick = (e) => {
          e.stopPropagation();
          xPop.hidden = !xPop.hidden;
          xBtn.setAttribute("aria-expanded", String(!xPop.hidden));
        };
        document.addEventListener("click", (e) => {
          if (!xPop.hidden && !xPop.contains(e.target) && e.target !== xBtn) {
            xPop.hidden = true;
            xBtn.setAttribute("aria-expanded", "false");
          }
        });
      }
      el.dataset.rbBuilt = "1";
    }
    // Heavy invoice-template preview: wire ONCE, and only when the tab is really
    // being viewed (skip during an idle prefetch so we never render a PDF for
    // users who never open Reports).
    if (!_tplWired && !prefetch) { _tplWired = true; wireInvoiceTemplate(); }
    // Data sections: fill on first build; quiet background refresh when the cache
    // is stale. Fire-and-forget so the tab paints instantly (refreshList et al.
    // fetch-then-fill in place, so this never re-blanks a rendered tab).
    if (!built || (Date.now() - _dataAt) > DATA_TTL_MS) {
      _dataAt = Date.now();
      // refreshList() now renders the unified accordion (offtaker list + their
      // drafts inline) — the old separate approval inbox is gone.
      Promise.all([refreshList(), refreshGmpBillsStatus()]).catch(() => {});
      // The send-pipeline band (fire-and-forget; hidden until data lands).
      loadPipeline();
    }
    // Invoice archive (monthly directory): fetch the manifest once (cached) on a real
    // view and render the collapsible directory. Skipped during the idle prefetch;
    // fails soft (fetch error → renderArchive keeps the host hidden).
    if (!prefetch && authHeaders()) {
      loadArchive().then(() => renderArchive()).catch(() => {});
    }
  }
  window.__aoLoadReports = load;

  // Warm the tab during browser idle so the FIRST open is instant too: prebuild
  // the shell + prefetch the data into the (hidden) panel ahead of any click.
  // The heavy template preview still defers to the first real view. Gated on a
  // signed-in session; harmless (and cheap) if the user never opens Reports.
  try {
    if (authHeaders()) {
      const warm = () => { try { if (root() && root().dataset.rbBuilt !== "1") load({ prefetch: true }); } catch (e) {} };
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 3000 });
      else setTimeout(warm, 1500);
    }
  } catch (e) {}

  // Let a GMP capture landing (sandbox.js fires __aoRefreshGmpGate) also refresh
  // the bills status + the offtaker utility-bill picker, so the operator sees the
  // bills appear without a manual reload.
  try {
    const _prevRefresh = window.__aoRefreshGmpGate;
    window.__aoRefreshGmpGate = function(){
      try { if (_prevRefresh) _prevRefresh(); } catch(e){}
      try { refreshGmpBillsStatus(); } catch(e){}
    };
  } catch(e){}

  // Show whether GMP utility bills are connected (and how many), with a direct
  // link to connect when none are present — answers "why is the dropdown empty?"
  // ALSO answers "will this run by itself?": bills only refresh when the utility
  // portal gets opened, so invoices are only AUTOMATIC once the operator saves
  // their utility login in the extension vault (Account → Auto-refresh). We check
  // the vault (via sandbox.js's shared __aoVaultStatus) for exactly the providers
  // this tenant has connected, and nudge — or confirm — accordingly.
  const _UTIL_LABEL = { gmp: "Green Mountain Power", vec: "Vermont Electric Co-op", wec: "Washington Electric Co-op" };
  const _utilLabel = (code) => _UTIL_LABEL[code] || String(code || "").replace(/^sh_/, "").toUpperCase();
  async function utilityAutomationState(accts) {
    // → {auto:true} all providers have saved logins; {auto:false, missing:[codes]}
    //   some don't; null = can't know (no extension / vault unreachable / no accounts).
    try {
      if (!accts.length || typeof window.__aoVaultStatus !== "function") return null;
      const status = await window.__aoVaultStatus();
      if (!status) return null;
      const providers = [...new Set(accts.map(a => (a.provider || "gmp").toLowerCase()))];
      const missing = providers.filter(p => !(status[p] && status[p].hasCreds));
      return missing.length ? { auto: false, missing } : { auto: true };
    } catch (e) { return null; }
  }
  function autoRefreshNudgeHTML(missing) {
    const names = missing.map(_utilLabel).join(" and ");
    return `<div class="rb-gmp-auto-nudge">
      <span>⚡ Invoices update only when you open your utility portal. Save your <b>${esc(names)}</b> login once and they generate automatically every month.</span>
      <a class="rb-gmp-inline-link" id="rbAutoRefreshLink" role="button" tabindex="0">Set up auto-refresh →</a></div>`;
  }
  function wireAutoRefreshLink() {
    const a = $("#rbAutoRefreshLink");
    if (!a) return;
    const go = () => {
      location.hash = "#account";
      setTimeout(() => {
        const row = document.getElementById("rowAutoRefresh");
        if (!row) return;
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        // land with the panel OPEN — the operator came here to type a password
        const body = row.querySelector("#arBody");
        const toggle = row.querySelector("#arToggle");
        if (body) body.classList.remove("ar-collapsed");
        if (toggle) { toggle.classList.add("open"); toggle.setAttribute("aria-expanded", "true"); }
        try { localStorage.setItem("ao_ar_open", "1"); } catch (e) {}
      }, 150);
    };
    a.onclick = go;
    a.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  }
  async function refreshGmpBillsStatus() {
    const host = $("#rbGmpBillsStatus");
    if (!host) return;
    let accts = [];
    try {
      const r = await fetch(API + "/utility-accounts", { headers: authHeaders() });
      if (r.ok) { const d = await r.json().catch(() => ({})); accts = d.utility_accounts || []; }
    } catch (e) { /* leave empty */ }
    const withBills = accts.filter(a => a.has_bill);
    // role="button" anchors carry no href, so they aren't keyboard-focusable or
    // Enter/Space-activatable by default. Wire click AND keyboard so a keyboard
    // user gets the same affordance as a mouse user (WCAG button pattern).
    const wireConnectUtility = () => {
      const a = $("#rbGmpInlineLink");
      if (!a) return;
      const go = () => { if (window.__aoLinkUtility) window.__aoLinkUtility(); else location.hash = "#arrays"; };
      a.onclick = go;
      a.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    };
    const autoState = await utilityAutomationState(accts);
    if (!accts.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>No utility bills connected yet — offtaker invoices bill from your utility bills, so link a utility to get started.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button" tabindex="0">Link utility bills →</a></div>`;
      wireConnectUtility();
    } else if (!withBills.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>${accts.length} utility account${accts.length === 1 ? "" : "s"} connected, but no bills have landed yet — open your utility portal once more so the extension captures them.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button" tabindex="0">Link utility bills →</a></div>` +
        (autoState && !autoState.auto ? autoRefreshNudgeHTML(autoState.missing) : "");
      wireConnectUtility();
      wireAutoRefreshLink();
    } else {
      host.innerHTML = `<div class="rb-gmp-ok">✓ ${withBills.length} utility bill source${withBills.length === 1 ? "" : "s"} connected${autoState && autoState.auto ? " · refreshing automatically" : ""} — available to link when you add an offtaker.</div>` +
        (autoState && !autoState.auto ? autoRefreshNudgeHTML(autoState.missing) : "");
      wireAutoRefreshLink();
    }
  }

  // ── Export to QuickBooks / Xero ────────────────────────────────────────────
  // A portfolio-level batch action: download the current period's offtaker invoices
  // as a QuickBooks/Xero-import CSV. The endpoint requires the Bearer header, so a
  // plain <a href download> can't carry auth — we do an authenticated fetch → blob →
  // object-URL download instead. Only revealed for a signed-in operator (the demo/
  // signed-out path never builds this shell). The optional account-code input maps
  // solar income to a QB/Xero income account and persists in localStorage.
  // Authenticated file download: the export/archive endpoints require the Bearer
  // header, so a plain <a href download> can't carry auth. Fetch → blob → object-URL
  // → click. Reads an optional count header (X-Invoice-Count / X-File-Count) and
  // returns {ok, count, name}. Surfaces the backend `detail` on failure. Shared by the
  // QuickBooks/Xero CSV export and the monthly-archive .zip download.
  async function authBlobDownload(url, fallbackName, countHeader) {
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) {
      let detail = "";
      try { const d = await r.clone().json(); detail = (d && d.detail) || ""; } catch (e) {}
      throw new Error(detail || ("Download failed (HTTP " + r.status + ")."));
    }
    const count = countHeader ? r.headers.get(countHeader) : null;
    // Prefer the server's filename from Content-Disposition; else the fallback.
    let name = fallbackName;
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (m && m[1]) { try { name = decodeURIComponent(m[1].trim().replace(/"/g, "")); } catch (e) { name = m[1].trim().replace(/"/g, ""); } }
    const blob = await r.blob();
    if (!blob || blob.size === 0) throw new Error("Nothing to download yet.");
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    return { ok: true, count: count != null ? Number(count) : null, name };
  }

  // Authenticated download that tolerates a background-computed export: the
  // register endpoint returns 202 {pending:true} (JSON) while it builds at
  // scale, then the CSV. Poll the JSON away, then blob-download the CSV.
  async function exportPoll(url, fallbackName) {
    for (let i = 0; i < 40; i++) {                 // ≤ ~7 min of 10s polls
      const r = await fetch(url, { headers: authHeaders() });
      const ct = r.headers.get("content-type") || "";
      if (r.status === 202 || ct.includes("application/json")) {
        let d = null; try { d = await r.json(); } catch (e) {}
        if (d && d.pending) { await new Promise(res => setTimeout(res, 10000)); continue; }
        throw new Error((d && d.detail) || "Nothing to export for this period yet.");
      }
      if (!r.ok) throw new Error("Download failed (HTTP " + r.status + ").");
      const count = r.headers.get("X-Invoice-Count");
      let name = fallbackName;
      const cd = r.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      if (m && m[1]) { try { name = decodeURIComponent(m[1].trim().replace(/"/g, "")); } catch (e) { name = m[1].trim().replace(/"/g, ""); } }
      const blob = await r.blob();
      if (!blob || blob.size === 0) throw new Error("Nothing to download yet.");
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
      return { ok: true, count: count != null ? Number(count) : null, name };
    }
    throw new Error("Export is taking longer than usual — try again in a moment.");
  }

  const EXPORT_ACCT_KEY = "ao_qb_export_account_code";
  function wireExport() {
    const box = $("#rbExportBox"), acct = $("#rbExportAcct"), stat = $("#rbExportStat");
    const btnQb = $("#rbExportQb"), btnXero = $("#rbExportXero");
    if (!box || (!btnQb && !btnXero)) return;
    if (!authHeaders()) { box.hidden = true; return; }   // defensive; demo never reaches here
    box.hidden = false;
    // Restore the remembered account code (the Xero AccountCode).
    if (acct) {
      try { acct.value = localStorage.getItem(EXPORT_ACCT_KEY) || ""; } catch (e) {}
      acct.addEventListener("input", () => {
        try { localStorage.setItem(EXPORT_ACCT_KEY, acct.value.trim()); } catch (e) {}
      });
      // Enter in the account field triggers the Xero export (that's what it feeds).
      acct.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doExport("xero", "Xero"); } });
    }
    const setStat = (cls, msg) => { if (stat) { stat.className = "rb-export-stat" + (cls ? " " + cls : ""); stat.textContent = msg || ""; } };
    let _busy = false;
    // QuickBooks Online and Xero use DIFFERENT import layouts — one button each,
    // both hitting /invoice-export.csv?format=<fmt> through the shared auth-download
    // helper. The account-code input feeds Xero's AccountCode (QuickBooks ignores it).
    async function doExport(format, label) {
      if (_busy) return;
      _busy = true;
      if (btnQb) btnQb.disabled = true;
      if (btnXero) btnXero.disabled = true;
      setStat("rb-busy", "Preparing your " + label + " export…");
      const code = acct && acct.value.trim();
      const params = new URLSearchParams({ format: format });
      if (code) params.set("account_code", code);
      const url = API + "/invoice-export.csv?" + params.toString();
      try {
        // The register computes in a background sweep at scale (a 202 {pending}
        // while it runs), so poll until the CSV lands, then download it. The
        // backend stamps a per-format filename via Content-Disposition.
        const res = await exportPoll(url, "offtaker-invoices-" + format + ".csv");
        const n = res.count;
        setStat("rb-ok", n != null
          ? ("✓ Exported " + n + " invoice" + (n === 1 ? "" : "s") + " for " + label + ".")
          : "✓ Exported — CSV downloaded.");
      } catch (e) {
        setStat("rb-err", (e && e.message) || ("Export to " + label + " failed — check your connection."));
      } finally {
        _busy = false;
        if (btnQb) btnQb.disabled = false;
        if (btnXero) btnXero.disabled = false;
      }
    }
    if (btnQb) btnQb.onclick = () => doExport("quickbooks", "QuickBooks");
    if (btnXero) btnXero.onclick = () => doExport("xero", "Xero");
  }

  /* ===========================================================================
   * INVOICE ARCHIVE (monthly directory) — Anna's ask #2.
   *
   * A browsable, collapsible directory of past billing months → arrays →
   * offtakers, with honest availability badges (invoice / offtaker bill / array
   * bill) and a per-month .zip download laid out <month>/<array>/{invoice, each
   * offtaker bill, the array's own bill}. Portfolio-level month-close surface,
   * signed-in only. Manifest fetched ONCE, cached (refetched on reload). Fails
   * soft: a fetch error just leaves the section absent, never blocks the generator.
   * ==========================================================================*/
  let ARCHIVE = null;               // /invoice-archive manifest (cached)
  let _archivePromise = null;
  let _archiveOpen = false;         // remember the panel's open/closed state across refreshes
  function loadArchive() {
    if (ARCHIVE) return Promise.resolve(ARCHIVE);
    if (_archivePromise) return _archivePromise;
    if (!authHeaders()) return Promise.resolve(null);
    // The manifest computes in a background sweep (a match per offtaker — ~60s
    // at 800 crossed the edge timeout); {pending:true} means "poll again".
    _archivePromise = (async () => {
      for (let i = 0; i < 30; i++) {                 // ≤ ~5 min of 10s polls
        try {
          const r = await fetch(API + "/invoice-archive", { headers: authHeaders() });
          if (!r.ok) return null;
          const d = await r.json().catch(() => null);
          if (d && d.ok) { ARCHIVE = d; return ARCHIVE; }
          if (!d || !d.pending) return null;
        } catch (e) { return null; }
        await new Promise(res => setTimeout(res, 10000));
      }
      return null;
    })().then(v => { _archivePromise = null; return v; });
    return _archivePromise;
  }

  // A single availability badge — emerald ✓ when present, muted "—" when not.
  // Honest: never renders a ✓ for something the backend says isn't available.
  function archBadge(label, available) {
    return `<span class="rb-arch-badge ${available ? "rb-arch-yes" : "rb-arch-no"}">${available ? "✓" : "—"} ${esc(label)}</span>`;
  }
  function monthLabel(m) {
    // "2026-06" -> "June 2026" (fall back to the raw string on any parse miss).
    const mm = String(m || "").match(/^(\d{4})-(\d{2})$/);
    if (!mm) return String(m || "");
    const d = new Date(Number(mm[1]), Number(mm[2]) - 1, 1);
    return isNaN(d) ? String(m) : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // Render the archive panel into #rbArchiveHost from the cached manifest. Signed-in
  // only; hides the host entirely when there's no manifest (fetch failed / demo).
  function renderArchive() {
    const host = $("#rbArchiveHost");
    if (!host) return;
    if (!authHeaders() || !ARCHIVE) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    const months = ARCHIVE.months || [];
    const total = ARCHIVE.month_count || 0;
    // Empty state — honest, quiet.
    if (!total || !months.length) {
      host.innerHTML = `<details class="rb-arch"${_archiveOpen ? " open" : ""} id="rbArch">
        <summary class="rb-arch-sum"><span class="rb-sec-caret" aria-hidden="true">▸</span>
          <span class="rb-arch-t">Invoice archive</span>
          <span class="rb-arch-sub">monthly directory</span></summary>
        <div class="rb-arch-body">
          <p class="rb-arch-empty">No invoices archived yet — they appear here once GMP bills with billable excess land.</p>
        </div></details>`;
      wireArchiveToggle();
      return;
    }
    const monthsHtml = months.map(m => {
      const arrays = m.arrays || [];
      const arraysHtml = arrays.map(a => {
        const offs = (a.offtakers || []).map(o =>
          `<div class="rb-arch-off">
             <span class="rb-arch-off-name">${esc(o.customer_name || "(unnamed offtaker)")}</span>
             <span class="rb-arch-badges">
               ${archBadge("invoice", !!o.invoice_available)}
               ${archBadge("offtaker bill", !!o.offtaker_bill_available)}
             </span>
           </div>`).join("");
        return `<div class="rb-arch-array">
            <div class="rb-arch-array-head">
              <span class="rb-arch-array-name">${esc(a.array_name || ("Array " + (a.array_id != null ? a.array_id : "")))}</span>
              ${archBadge("array bill", !!a.array_bill_available)}
            </div>
            ${offs || `<div class="rb-arch-off rb-arch-off-none">No offtakers on this array this month.</div>`}
          </div>`;
      }).join("");
      const n = m.invoice_count != null ? m.invoice_count : (arrays.reduce((s, a) => s + (a.offtakers || []).length, 0));
      return `<div class="rb-arch-month">
          <div class="rb-arch-month-head">
            <div class="rb-arch-month-title">${esc(monthLabel(m.month))}
              <span class="rb-arch-month-count">${n} invoice${n === 1 ? "" : "s"}</span></div>
            <button class="ao-btn rb-btn rb-arch-zip" type="button" data-arch-zip="${esc(m.month)}"
              title="Download this month's invoices, offtaker bills, and array bills as a .zip (one folder per array).">⬇ Download month (.zip)</button>
            <span class="rb-arch-zip-stat" data-arch-stat="${esc(m.month)}" aria-live="polite"></span>
          </div>
          <div class="rb-arch-arrays">${arraysHtml || `<div class="rb-arch-off-none">No arrays billed this month.</div>`}</div>
        </div>`;
    }).join("");
    host.innerHTML = `<details class="rb-arch"${_archiveOpen ? " open" : ""} id="rbArch">
      <summary class="rb-arch-sum"><span class="rb-sec-caret" aria-hidden="true">▸</span>
        <span class="rb-arch-t">Invoice archive</span>
        <span class="rb-arch-sub">${total} month${total === 1 ? "" : "s"} · newest first</span></summary>
      <div class="rb-arch-body">${monthsHtml}</div></details>`;
    wireArchiveToggle();
    // Per-month .zip download (authenticated blob download, same helper as the CSV export).
    host.querySelectorAll("[data-arch-zip]").forEach(btn => {
      btn.onclick = () => downloadArchiveMonth(btn.getAttribute("data-arch-zip"), btn, host);
    });
  }
  function wireArchiveToggle() {
    const det = $("#rbArch");
    if (det) det.addEventListener("toggle", () => { _archiveOpen = det.open; });
  }
  async function downloadArchiveMonth(month, btn, host) {
    const stat = host.querySelector(`[data-arch-stat="${CSS.escape(month)}"]`);
    const setStat = (cls, msg) => { if (stat) { stat.className = "rb-arch-zip-stat" + (cls ? " " + cls : ""); stat.textContent = msg || ""; } };
    if (btn.disabled) return;
    btn.disabled = true;
    setStat("rb-busy", "Preparing…");
    const url = API + "/invoice-archive.zip?month=" + encodeURIComponent(month);
    try {
      const res = await authBlobDownload(url, "offtaker-invoices-" + month + ".zip", "X-File-Count");
      const n = res.count;
      setStat("rb-ok", n != null ? ("✓ Downloaded " + n + " file" + (n === 1 ? "" : "s") + ".") : "✓ Downloaded.");
    } catch (e) {
      setStat("rb-err", (e && e.message) || "Download failed — check your connection.");
    } finally {
      btn.disabled = false;
    }
  }

  function signInPrompt() {
    return `<div class="rep-card"><span class="rep-eyebrow">Reports</span>
      <h3>Sign in to set up automatic reports</h3>
      <p>Upload a billing spreadsheet and we'll send invoices + performance
      summaries on the schedule you choose. <a href="/accounts" style="color:var(--good)">Sign in</a> to get started.</p></div>`;
  }

  /* ===========================================================================
   * ANONYMOUS DEMO — a fully-populated Offtaker Invoice Generator for the fake
   * operator (Catamount Community Solar) so a signed-out visitor sees the whole
   * surface working: the offtaker list, the approval inbox with a real invoice
   * email preview, and the dual bill model. Reuses subCard()/draftCard()/
   * renderInboxBody() so the demo can't drift from the live UI. Every action
   * button (Approve / Draft / Edit) is intercepted to a gentle "sign in" note
   * rather than firing a fetch that would 401.
   * ==========================================================================*/
  let _demoBuilt = false;
  function renderDemo(el) {
    const D = window.AO_DEMO;
    if (!_demoBuilt) {
      el.innerHTML = shell();
      wireGenTabs();   // the "Offtakers | Bill audit" toggle works in the demo too (audit shows the sign-in state)
      _demoBuilt = true;
    }
    // A subtle demo affordance above the offtaker list (matches the page's demo banner).
    const head = $(".rb-list-head");
    if (head && !$("#rbDemoNote")) {
      const note = document.createElement("div");
      note.id = "rbDemoNote";
      note.className = "rb-gmp-ok";
      note.style.cssText = "margin:2px 0 0;background:rgba(245,185,66,.08);border:1px solid rgba(245,185,66,.28);color:var(--muted)";
      note.innerHTML = `Demo — a sample operator's offtakers. <a href="/onboarding" style="color:var(--good);font-weight:650">Set up your own →</a>`;
      head.parentNode.insertBefore(note, head.nextSibling);
    }
    // The GMP-bills status line: show the "connected" affordance (offtakers bill from bills).
    const gmpStatus = $("#rbGmpBillsStatus");
    if (gmpStatus) gmpStatus.innerHTML =
      `<div class="rb-gmp-ok">✓ ${D.offtakers.length} offtakers billing from this operator's utility bills.</div>`;

    // ── Offtaker accordion — same cards as the live app, with demo arrays/accts. ──
    const demoArrays = [{ id: 1, name: "Catamount Community Solar", client_name: "" }];
    const demoUtil = [{ utility_account_id: 9001, array_name: "Catamount Community Solar",
      has_bill: true, bill_count: 6, account_number: "GMP-558210" }];

    // Populate the inbox globals so the accordion renders + expands from the demo data.
    OFFTAKERS = D.offtakers.slice();
    INBOX_DRAFTS = D.drafts.slice();
    DRAFT_BY_SUB = {};
    INBOX_DRAFTS.forEach(d => {
      // match each draft to its offtaker by name (subscription_id is null in the demo).
      const sub = OFFTAKERS.find(s => s.customer_name === d.customer_name);
      if (sub) { d.subscription_id = null; DRAFT_BY_SUB[String(sub.id)] = d; }
    });
    INBOX_UTIL_ACCTS = demoUtil;
    ACC_ARRS = demoArrays;
    TEMPLATE_STATE = { has: false, enabled: false };   // no template-PDF fetch in the demo

    const list = $("#rbList");
    if (list) {
      const pending = OFFTAKERS.filter(s => DRAFT_BY_SUB[String(s.id)]).length;
      const headLine = pending
        ? `<b>${pending}</b> report${pending === 1 ? "" : "s"} ready to review &amp; send — nothing sends until you approve.`
        : `Click an offtaker to review &amp; send their invoice — nothing sends until you approve.`;
      list.innerHTML = `<div class="rb-acc-lead">${headLine}</div>` +
        OFFTAKERS.map(s => subCard(s, demoArrays, demoUtil)).join("");
      wireAccordionHeaders(list);
      // Leave every offtaker collapsed on load — matches the live app (no auto-open).
      ACTIVE_SUB_ID = null;
      // Intercept send/save actions to a sign-in nudge (no live fetch in the demo);
      // local toggles (autogmp/summary) + the accordion expand/collapse stay live.
      const reintercept = () => {
        list.querySelectorAll("[data-dact]").forEach(b => {
          const act = b.getAttribute("data-dact");
          if (act === "approve" || act === "sendme" || act === "aiemail" || act === "savemsg" || act === "preview")
            b.onclick = (e) => { e.preventDefault(); demoNudge(b); };
        });
      };
      reintercept();
      // The body re-renders on expand/edit, so re-intercept after any header click too.
      list.querySelectorAll("[data-acchead]").forEach(h => {
        const sid = h.getAttribute("data-acchead");
        h.addEventListener("click", () => requestAnimationFrame(reintercept));
      });
    }

    // Wire the "Add an offtaker" + "Link utility bills" header buttons to the sign-in nudge.
    const addBtn = $("#rbCustAdd"); if (addBtn) addBtn.onclick = () => demoNudge(addBtn);
    const linkBtn = $("#rbLinkUtility"); if (linkBtn) linkBtn.onclick = () => demoNudge(linkBtn);
    const esBtn = $("#rbEmailStudio"); if (esBtn) esBtn.onclick = () => demoNudge(esBtn);
    const exBtn = $("#rb2ExportBtn"); if (exBtn) exBtn.onclick = () => demoNudge(exBtn);
  }

  // A gentle, in-place "this is a demo" affordance — no fetch, no error.
  function demoNudge(near) {
    let tip = document.getElementById("rbDemoTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "rbDemoTip";
      tip.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);" +
        "z-index:9500;background:var(--card,#15201c);color:var(--ink,#e8f1ec);" +
        "border:1px solid var(--good,#34d896);border-radius:12px;padding:11px 18px;" +
        "font:600 13px/1.4 inherit;box-shadow:0 10px 34px -10px rgba(0,0,0,.6);max-width:min(92vw,420px)";
      document.body.appendChild(tip);
    }
    tip.innerHTML = `This is a live demo. <a href="/onboarding" style="color:var(--good)">Start free →</a> to send real invoices.`;
    tip.style.opacity = "1";
    clearTimeout(demoNudge._t);
    demoNudge._t = setTimeout(() => { if (tip) tip.style.opacity = "0"; tip.style.transition = "opacity .4s"; }, 3200);
  }

  // ─── Offtaker email studio — the MASS email customizer (Anna-scale ask) ────
  // Mirrors the NEPOOL report-email Template Studio against the AO endpoint
  // suite (GET/PUT/preview/chat/test-send/reset at /email-template*): a live
  // inbox preview rendered with a REAL sample offtaker's figures, subject/body
  // merge-tag editors with token chips, the shared operator sign-off, autosave,
  // "Send myself a test", reset, and the floating Ask-AI assistant. The
  // template is the letter on EVERY offtaker invoice email; a per-offtaker
  // edited note still overrides it for that one send.
  const ES = {
    subject: "", body: "", signoff: "",
    dirty: { subject: false, body: false, signoff: false },
    saveT: null, prevT: null, chat: [], busy: false, target: "body",
    fromEmail: "", sampleEmail: "",
  };
  const ES_TOKENS = ["{{greeting}}", "{{offtaker_first_name}}", "{{offtaker_name}}",
                     "{{period}}", "{{kwh}}", "{{amount}}", "{{invoice_number}}",
                     "{{attachments_line}}", "{{signoff}}"];
  const ES_SIGNOFF_CHIPS = [
    { label: "Just my name", value: "<p>Thank you,<br>{{tenant_name}}</p>" },
    { label: "Name + email", value: "<p>Thank you,<br>{{tenant_name}}<br>{{tenant_email}}</p>" },
  ];

  async function esApi(path, opts) {
    const r = await fetch(API + "/email-template" + (path || ""), Object.assign({
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    }, opts || {}));
    if (!r.ok) {
      let msg = "Request failed";
      try { msg = (await r.json()).detail || msg; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function esStatus(txt, cls) {
    const el = document.getElementById("esStatus");
    if (el) { el.textContent = txt || ""; el.className = "rb-es-status" + (cls ? " " + cls : ""); }
  }

  async function openEmailStudio() {
    let ov = document.getElementById("esOverlay");
    if (!ov) { ov = esBuild(); document.body.appendChild(ov); }
    ov.hidden = false;
    document.body.style.overflow = "hidden";
    // A pending autosave/preview timer from a previous state must never fire
    // across a (re)load — it would re-save stale content over fresh state.
    clearTimeout(ES.saveT); clearTimeout(ES.prevT);
    ES.dirty = { subject: false, body: false, signoff: false };
    esStatus("Loading…");
    try {
      const d = await esApi("");
      ES.subject = d.subject_template || "";
      ES.body = d.body_template || "";
      ES.signoff = d.signoff || "";
      ES.fromEmail = d.from_email || "";
      ES.sampleEmail = d.sample_client_email || "";
      ES.dirty = { subject: false, body: false, signoff: false };
      ES.chat = [];
      $("#esSubj").value = ES.subject;
      $("#esBody").value = ES.body;
      $("#esSignoff").value = ES.signoff;
      $("#esPrevFrom").textContent = ES.fromEmail || "admin@solaroperator.org";
      esStatus("Saved");
      esRenderChat();
      await esPreview();
    } catch (e) {
      esStatus("Couldn't load — " + e.message, "rb-es-err");
    }
  }

  function esCloseStudio() {
    esFlushSave();
    const ov = document.getElementById("esOverlay");
    if (ov) ov.hidden = true;
    document.body.style.overflow = "";
  }

  async function esPreview() {
    const stat = document.getElementById("esPrevStat");
    if (stat) stat.hidden = false;
    try {
      const r = await esApi("/preview", { method: "POST", body: JSON.stringify({
        subject_template: ES.subject || null,
        body_template: ES.body || null,
        signoff: ES.signoff || null,
      })});
      $("#esPrevSubj").textContent = r.subject_rendered || "(subject will appear here)";
      $("#esPrevBody").innerHTML = r.body_rendered || "<p style='color:var(--faint)'>Preview will appear here.</p>";
      $("#esPrevTo").textContent = (r.sample_client || "your offtaker")
        + (ES.sampleEmail ? " <" + ES.sampleEmail + ">" : "");
      $("#esSampleNote").textContent = r.sample_client
        ? "Previewing with " + r.sample_client + "'s real figures — every offtaker gets their own."
        : "";
    } catch (e) {
      esStatus("Preview failed — " + e.message, "rb-es-err");
    } finally {
      if (stat) stat.hidden = true;
    }
  }

  function esSchedulePreview() {
    clearTimeout(ES.prevT);
    ES.prevT = setTimeout(() => { esPreview(); }, 300);
  }

  async function esDoSave() {
    const dirty = Object.assign({}, ES.dirty);
    if (!dirty.subject && !dirty.body && !dirty.signoff) return;
    ES.dirty = { subject: false, body: false, signoff: false };
    esStatus("Saving…");
    try {
      const jobs = [];
      if (dirty.subject || dirty.body) {
        jobs.push(esApi("", { method: "PUT", body: JSON.stringify({
          subject_template: ES.subject, body_template: ES.body }) }));
      }
      if (dirty.signoff) {
        jobs.push(esApi("/signoff", { method: "PUT",
                                      body: JSON.stringify({ signoff: ES.signoff }) }));
      }
      await Promise.all(jobs);
      esStatus("Saved");
    } catch (e) {
      ES.dirty.subject = ES.dirty.subject || dirty.subject;
      ES.dirty.body = ES.dirty.body || dirty.body;
      ES.dirty.signoff = ES.dirty.signoff || dirty.signoff;
      esStatus("Couldn't save — " + e.message, "rb-es-err");
    }
  }

  function esScheduleSave() {
    clearTimeout(ES.saveT);
    esStatus("Saving…");   // honest immediately — "Saved" only after the PUT lands
    ES.saveT = setTimeout(esDoSave, 800);
  }

  function esFlushSave() {
    clearTimeout(ES.saveT);
    esDoSave();
  }

  function esInsertToken(tok) {
    const el = ES.target === "subject" ? $("#esSubj") : $("#esBody");
    if (!el) return;
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + tok + el.value.slice(end);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    try { el.setSelectionRange(start + tok.length, start + tok.length); } catch (_) { /* ok */ }
  }

  function esRenderChat() {
    const box = document.getElementById("esChatMsgs");
    if (!box) return;
    box.innerHTML = ES.chat.length
      ? ES.chat.map(m => `<div class="rb-es-msg ${m.role === "user" ? "rb-es-msg-me" : ""}">${esc(m.content)}</div>`).join("")
      : `<p class="rb-es-chat-hint">Describe the change — “make it warmer”, “add a line about budget billing”, “shorter”. The AI rewrites the template; you review before it sends anywhere.</p>`;
    if (ES.busy) box.innerHTML += `<div class="rb-es-msg">Drafting…</div>`;
    box.scrollTop = box.scrollHeight;
  }

  async function esChatSend() {
    const input = document.getElementById("esChatInput");
    const text = (input && input.value || "").trim();
    if (!text || ES.busy) return;
    input.value = "";
    ES.chat.push({ role: "user", content: text });
    ES.busy = true;
    esRenderChat();
    try {
      const r = await esApi("/chat", { method: "POST", body: JSON.stringify({
        messages: ES.chat, current_body: ES.body, current_subject: ES.subject }) });
      ES.chat.push({ role: "assistant", content: r.assistant_reply || "Updated." });
      if (r.proposed_body) { ES.body = r.proposed_body; $("#esBody").value = ES.body; ES.dirty.body = true; }
      if (typeof r.proposed_subject === "string") { ES.subject = r.proposed_subject; $("#esSubj").value = ES.subject; ES.dirty.subject = true; }
      esScheduleSave();
      esSchedulePreview();
    } catch (e) {
      ES.chat.push({ role: "assistant", content: "That didn't work — " + e.message });
    } finally {
      ES.busy = false;
      esRenderChat();
    }
  }

  async function esTestSend(btn) {
    btn.disabled = true;
    const keep = btn.textContent;
    btn.textContent = "Sending…";
    try {
      const r = await esApi("/test-send", { method: "POST", body: JSON.stringify({
        subject_template: ES.subject || null, body_template: ES.body || null,
        signoff: ES.signoff || null }) });
      esStatus("Test sent to " + (r.sent_to || "you"));
    } catch (e) {
      esStatus("Test failed — " + e.message, "rb-es-err");
    } finally {
      btn.disabled = false;
      btn.textContent = keep;
    }
  }

  async function esReset(btn) {
    btn.disabled = true;
    // Kill any in-flight autosave FIRST — a pending timer firing after the
    // reset would re-save the pre-reset body as a "custom" template.
    clearTimeout(ES.saveT); clearTimeout(ES.prevT);
    ES.dirty = { subject: false, body: false, signoff: false };
    try {
      await esApi("/reset", { method: "POST", body: "{}" });
      await openEmailStudio();   // reload defaults + preview
      esStatus("Reset to the default template");
    } catch (e) {
      esStatus("Reset failed — " + e.message, "rb-es-err");
    } finally {
      btn.disabled = false;
    }
  }

  function esBuild() {
    const ov = document.createElement("div");
    ov.id = "esOverlay";
    ov.className = "rb-es-overlay";
    ov.innerHTML = `
      <div class="rb-es-head">
        <div>
          <b>Customize offtaker email</b>
          <span class="rb-es-sub">Applies to every offtaker invoice email — merge tags personalize each one. A per-offtaker edited note still overrides it.</span>
        </div>
        <span class="rb-es-status" id="esStatus">Saved</span>
        <button type="button" class="rb-es-x" id="esClose" aria-label="Close email studio">✕</button>
      </div>
      <div class="rb-es-cols">
        <div class="rb-es-left">
          <div class="rb-es-prevlabel">LIVE PREVIEW <span id="esSampleNote"></span>
            <span id="esPrevStat" hidden>rendering…</span></div>
          <div class="rb-es-mail">
            <div class="rb-es-mail-subj" id="esPrevSubj"></div>
            <div class="rb-es-mail-env">
              <div><span class="rb-es-envlab">FROM</span> <span id="esPrevFrom"></span> <span class="rb-es-envvia">via Array Operator</span></div>
              <div><span class="rb-es-envlab">TO</span> <span id="esPrevTo"></span></div>
            </div>
            <div class="rb-es-mail-body" id="esPrevBody"></div>
            <div class="rb-es-mail-att">📄 the offtaker's invoice PDF &nbsp;·&nbsp; 🧾 the GMP bill behind it — attached automatically, plus the figures table below the letter.</div>
          </div>
        </div>
        <div class="rb-es-right">
          <div class="rb-es-toklabel">Insert a merge tag into the <b id="esTokTarget">body</b> — click a field, then a chip</div>
          <div class="rb-es-tokens">${ES_TOKENS.map(t => `<button type="button" class="rb-es-token" data-tok="${esc(t)}">${esc(t)}</button>`).join("")}</div>
          <label class="rb-es-lab">Subject line</label>
          <input type="text" id="esSubj" class="rb-es-input" autocomplete="off" spellcheck="false">
          <label class="rb-es-lab">Body (HTML)</label>
          <textarea id="esBody" class="rb-es-ta" rows="9" spellcheck="false"></textarea>
          <p class="rb-es-hint">{{greeting}} auto-picks “Hi Abigail,” for people and “Dear Hartland Feed &amp; Grain,” for organizations. {{attachments_line}} only ever claims files that really attach.</p>
          <div class="rb-es-signoff">
            <b>Sign-off</b>
            <span class="rb-es-hint" style="margin:0">Shared with your NEPOOL report emails — one identity everywhere.</span>
            <div class="rb-es-tokens">${ES_SIGNOFF_CHIPS.map(c => `<button type="button" class="rb-es-token" data-signoff="${esc(c.value)}">${esc(c.label)}</button>`).join("")}</div>
            <textarea id="esSignoff" class="rb-es-ta" rows="3" spellcheck="false" placeholder="Paste your sign-off here…"></textarea>
          </div>
          <div class="rb-es-actions">
            <button type="button" class="ao-btn rb-btn" id="esTest">Send myself a test</button>
            <button type="button" class="rb-es-reset" id="esReset">Reset to default</button>
          </div>
        </div>
      </div>
      <button type="button" class="rb-es-ai" id="esAiPill">✦ Ask AI</button>
      <div class="rb-es-chat" id="esChatPanel" hidden>
        <div class="rb-es-chat-head">AI assistant <button type="button" class="rb-es-x" id="esChatClose" aria-label="Close AI assistant">✕</button></div>
        <div class="rb-es-chat-msgs" id="esChatMsgs"></div>
        <div class="rb-es-chat-in">
          <input type="text" id="esChatInput" placeholder="Make it warmer…" autocomplete="off">
          <button type="button" class="ao-btn ao-btn-primary rb-btn" id="esChatSend">Send</button>
        </div>
      </div>`;

    // ── wiring ──
    ov.querySelector("#esClose").onclick = esCloseStudio;
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") esCloseStudio(); });
    const subj = ov.querySelector("#esSubj");
    const bodyTa = ov.querySelector("#esBody");
    const sign = ov.querySelector("#esSignoff");
    subj.addEventListener("focus", () => { ES.target = "subject"; $("#esTokTarget").textContent = "subject"; });
    bodyTa.addEventListener("focus", () => { ES.target = "body"; $("#esTokTarget").textContent = "body"; });
    subj.addEventListener("input", () => { ES.subject = subj.value; ES.dirty.subject = true; esScheduleSave(); esSchedulePreview(); });
    bodyTa.addEventListener("input", () => { ES.body = bodyTa.value; ES.dirty.body = true; esScheduleSave(); esSchedulePreview(); });
    sign.addEventListener("input", () => { ES.signoff = sign.value; ES.dirty.signoff = true; esScheduleSave(); esSchedulePreview(); });
    [subj, bodyTa, sign].forEach(el => el.addEventListener("blur", esFlushSave));
    ov.querySelectorAll("[data-tok]").forEach(b => b.onclick = () => esInsertToken(b.getAttribute("data-tok")));
    ov.querySelectorAll("[data-signoff]").forEach(b => b.onclick = () => {
      sign.value = b.getAttribute("data-signoff");
      sign.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ov.querySelector("#esTest").onclick = (e) => esTestSend(e.currentTarget);
    ov.querySelector("#esReset").onclick = (e) => esReset(e.currentTarget);
    ov.querySelector("#esAiPill").onclick = () => {
      const p = ov.querySelector("#esChatPanel");
      p.hidden = !p.hidden;
      if (!p.hidden) { esRenderChat(); ov.querySelector("#esChatInput").focus(); }
    };
    ov.querySelector("#esChatClose").onclick = () => { ov.querySelector("#esChatPanel").hidden = true; };
    ov.querySelector("#esChatSend").onclick = esChatSend;
    ov.querySelector("#esChatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); esChatSend(); }
    });
    return ov;
  }

  // ─── Send pipeline + KPI band (Ford-approved redesign, 2026-07-03) ─────────
  // The flow view over the offtaker list: what fired, what's in flight, what
  // fires next — plus the pipeline controls (Auto-send all / Draft all with
  // confirms, and the tenant-wide Pause switch). All numbers come from
  // GET /send-pipeline (cheap column aggregates, no invoice rebuilds).
  let PIPE = null;

  function _monthName(ym) {           // "2026-06" → "June"
    if (!ym) return "—";
    const parts = String(ym).split("-").map(Number);
    if (!parts[0] || !parts[1]) return "—";
    return new Date(Date.UTC(parts[0], parts[1] - 1, 1))
      .toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
  }
  function _fireLabel(iso) {          // "2026-08-01T09:00:00" → "Aug 1"
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function _daysUntil(iso) {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    return isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 86400000));
  }

  async function loadPipeline() {
    if (!authHeaders()) return;
    try {
      const r = await fetch(API + "/send-pipeline", { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (d && d.ok) { PIPE = d; renderPipeline(); renderKpis(); }
    } catch (e) { /* the band stays hidden — never blocks the tab */ }
  }

  function renderPipeline() {
    const host = document.getElementById("rb2Pipe");
    if (!host) return;
    if (!PIPE || !authHeaders()) { host.hidden = true; return; }
    const p = PIPE;
    const paused = !!p.paused;
    const monthly = p.next_monthly || {}, quarterly = p.next_quarterly || {};
    const last = p.last || {}, inf = p.inflight || {};
    const lastRun = last.last_run_at
      ? new Date(last.last_run_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "—";
    const approvalTotal = (monthly.approval || 0) + (quarterly.approval || 0);
    const autoTotal = (monthly.auto || 0) + (quarterly.auto || 0);
    const days = _daysUntil(monthly.fires_at);
    host.hidden = false;
    host.className = "rb2-pipe" + (paused ? " paused" : "");
    host.innerHTML = `
      <div class="rb2-pipe-label">
        <h2>Send pipeline</h2>
        ${paused ? '<span class="rb2-pausechip">⏸ SENDING PAUSED</span>' : ""}
        <small class="rb2-rules">monthly invoices fire the 1st · quarterly Jan / Apr / Jul / Oct · an invoice only generates once its utility bill settles</small>
        <span class="rb2-sp"></span>
        <small class="rb2-runstamp"><b>last run</b> ${esc(lastRun)} · next ${esc(_fireLabel(monthly.fires_at))}</small>
        <div class="rb2-pipe-ctl">
          <button class="ao-btn rb-btn rb2-ctlbtn" id="rb2AutoAll" type="button">Auto-send all</button>
          <div class="rb2-ctlpop" id="rb2AutoAllPop" hidden>
            <p><b>${fmt0(approvalTotal)} offtaker${approvalTotal === 1 ? "" : "s"}</b> on draft-for-approval will switch to <b>auto-send</b> — invoices email on schedule, from settled bills, without review. Per-offtaker settings still override.</p>
            <div class="rb2-ctlpop-row"><button class="ao-btn rb-btn" data-close type="button">Cancel</button><button class="ao-btn ao-btn-primary rb-btn" id="rb2AutoAllGo" type="button">Switch ${fmt0(approvalTotal)} to auto</button></div>
          </div>
          <button class="ao-btn rb-btn rb2-ctlbtn" id="rb2DraftAll" type="button">Draft all</button>
          <div class="rb2-ctlpop" id="rb2DraftAllPop" hidden>
            <p><b>${fmt0(autoTotal)} offtaker${autoTotal === 1 ? "" : "s"}</b> on auto-send will switch to <b>draft for approval</b> — every invoice lands in your inbox for review before anything emails.</p>
            <div class="rb2-ctlpop-row"><button class="ao-btn rb-btn" data-close type="button">Cancel</button><button class="ao-btn ao-btn-primary rb-btn" id="rb2DraftAllGo" type="button">Switch ${fmt0(autoTotal)} to drafts</button></div>
          </div>
          <button class="rb2-pswitch" id="rb2Pause" role="switch" aria-checked="${paused}" type="button">
            <span class="rb2-knob" aria-hidden="true"></span>${paused ? "Resume sending" : "Pause sending"}
          </button>
        </div>
      </div>
      <div class="rb2-pipe-row">
        <div class="rb2-pcell done" id="rb2CellLast" role="button" tabindex="0" title="Scrolls to the invoice archive — download this month as a .zip there.">
          <div class="rb2-when"><b>${esc(_monthName(last.period_month))} · delivered</b><small>ran ${esc(lastRun)}</small></div>
          <div class="rb2-big">${fmt0(last.delivered || 0)} <span>of ${fmt0(p.total_enabled || 0)}${last.dollars ? " · " + money0(last.dollars) : ""}</span></div>
          <div class="rb2-chips"><span class="rb2-pc g">✓ ${fmt0(last.delivered || 0)} sent</span></div>
        </div>
        <div class="rb2-nowmark" aria-hidden="true"><em>NOW</em></div>
        <div class="rb2-pcell now">
          <div class="rb2-when"><b>In flight</b><small>current period</small></div>
          <div class="rb2-big">${fmt0(inf.pending_drafts || 0)} <span>awaiting your approval</span></div>
          <div class="rb2-chips"><span class="rb2-pc a">${fmt0(inf.pending_drafts || 0)} to approve</span><span class="rb2-pc m">${fmt0(inf.waiting || 0)} waiting on bills</span></div>
        </div>
        <div class="rb2-pcell sched">
          <div class="rb2-when"><b>${esc(_fireLabel(monthly.fires_at))} · next run</b><small>${paused ? "paused" : (days != null ? "fires in " + fmt0(days) + " day" + (days === 1 ? "" : "s") : "")}</small></div>
          <div class="rb2-big">${fmt0(monthly.scheduled || 0)} <span>scheduled</span></div>
          <div class="rb2-chips"><span class="rb2-pc b">${fmt0(monthly.auto || 0)} auto-send</span><span class="rb2-pc m">${fmt0(monthly.approval || 0)} draft for approval</span></div>
          ${paused ? `<div class="rb2-pausednote">⏸ Paused — this run won't fire until you resume. Manual sends still work.</div>` : ""}
        </div>
        <div class="rb2-pcell later">
          <div class="rb2-when"><b>${esc(_fireLabel(quarterly.fires_at))} · quarterly</b><small>${(quarterly.scheduled || 0) ? "" : "none scheduled"}</small></div>
          <div class="rb2-big">${fmt0(quarterly.scheduled || 0)} <span>scheduled</span></div>
          <div class="rb2-chips"><span class="rb2-pc b">${fmt0(quarterly.auto || 0)} auto-send</span><span class="rb2-pc m">${fmt0(quarterly.approval || 0)} draft for approval</span></div>
        </div>
      </div>`;

    // ── wiring ──
    const cellLast = host.querySelector("#rb2CellLast");
    if (cellLast) cellLast.onclick = () => {
      const a = document.getElementById("rbArchiveHost");
      if (a && !a.hidden) a.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    [["rb2AutoAll", "rb2AutoAllPop"], ["rb2DraftAll", "rb2DraftAllPop"]].forEach(([b, pp]) => {
      const btn = host.querySelector("#" + b), pop = host.querySelector("#" + pp);
      if (!btn || !pop) return;
      btn.onclick = (e) => {
        e.stopPropagation();
        host.querySelectorAll(".rb2-ctlpop").forEach(x => { if (x !== pop) x.hidden = true; });
        pop.hidden = !pop.hidden;
      };
      pop.querySelectorAll("[data-close]").forEach(c => c.onclick = () => { pop.hidden = true; });
    });
    const autoGo = host.querySelector("#rb2AutoAllGo");
    if (autoGo) autoGo.onclick = (e) => bulkDeliveryMode("auto", e.currentTarget);
    const draftGo = host.querySelector("#rb2DraftAllGo");
    if (draftGo) draftGo.onclick = (e) => bulkDeliveryMode("approval", e.currentTarget);
    const pauseBtn = host.querySelector("#rb2Pause");
    if (pauseBtn) pauseBtn.onclick = async () => {
      pauseBtn.disabled = true;
      try {
        const r = await fetch(API + "/sending-paused", {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ paused: !PIPE.paused }),
        });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (d) { PIPE.paused = !!d.paused; renderPipeline(); return; }
        }
      } catch (e) { /* leave state as-is */ }
      pauseBtn.disabled = false;
    };
    if (!renderPipeline._closerWired) {
      renderPipeline._closerWired = true;
      document.addEventListener("click", (e) => {
        document.querySelectorAll(".rb2-ctlpop").forEach(x => {
          if (!x.hidden && !x.contains(e.target) && !e.target.closest(".rb2-ctlbtn")) x.hidden = true;
        });
      });
    }
  }

  async function bulkDeliveryMode(mode, btn) {
    btn.disabled = true;
    const keep = btn.textContent;
    btn.textContent = "Switching…";
    try {
      const r = await fetch(API + "/subscriptions/bulk-delivery-mode", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ mode }),
      });
      if (r.ok) {
        await loadPipeline();     // re-renders the band with the new splits
        refreshList();            // cards pick up their new mode chips
        return;
      }
    } catch (e) { /* fall through to restore */ }
    btn.disabled = false;
    btn.textContent = keep;
  }

  function renderKpis() {
    const host = document.getElementById("rb2Kpis");
    if (!host) return;
    if (!authHeaders()) { host.hidden = true; return; }
    const nOff = (OFFTAKERS || []).length;
    const nArr = (ACC_ARRS || []).length;
    const ready = (INBOX_DRAFTS || []).length;   // the pending-drafts inbox
    const allocN = RECON ? (RECON.allocation_flagged || 0) : null;
    const atStake = RECON
      ? (RECON.allocation_at_stake_usd != null ? RECON.allocation_at_stake_usd : (allocN || 0) * 25)
      : null;
    const dollars = (PIPE && PIPE.last && PIPE.last.dollars) || null;
    const month = PIPE && PIPE.last ? _monthName(PIPE.last.period_month) : null;
    if (!nOff && !ready) { host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = `
      <div class="rb2-kpi"><span>Offtakers</span><b>${fmt0(nOff)}</b><small>across ${fmt0(nArr)} array${nArr === 1 ? "" : "s"}</small></div>
      <div class="rb2-kpi"><span>Ready to review</span><b>${fmt0(ready)}</b><small>draft${ready === 1 ? "" : "s"} awaiting approval</small></div>
      ${allocN
        ? `<div class="rb2-kpi flag" role="button" tabindex="0" id="rb2KpiFlag" title="GMP credits $25 per billing error they made — ${money0(atStake)} across these catches. Opens the Bill audit.">
             <span>Doesn't match GMP</span><b>⚑ ${fmt0(allocN)}</b><small>≈ ${money0(atStake)} at stake</small></div>`
        : `<div class="rb2-kpi"><span>Doesn't match GMP</span><b>${RECON ? "0" : "…"}</b><small>${RECON ? "all allocations check out" : "checking the bills…"}</small></div>`}
      <div class="rb2-kpi"><span>This period</span><b>${dollars != null ? money0(dollars) : "—"}</b><small>${dollars != null ? "invoiced · " + esc(month || "") : "no sends yet"}</small></div>`;
    const flag = host.querySelector("#rb2KpiFlag");
    if (flag) {
      flag.onclick = () => openAuditTab();
      flag.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAuditTab(); } };
    }
  }

  // The draft envelope preview (renderDraftDoc) shows the email; with a null
  // subscription_id it skips the live PDF pane, so append a clean styled demo
  // invoice underneath so the visitor sees the actual document, not a blank.
  function injectDemoInvoice() {
    const pane = $("#rbDraftDocPane");
    const d = activeDraft();
    if (!pane || !d) return;
    if (pane.querySelector(".rb-demo-inv")) return;
    const credit = (window.AO_DEMO && window.AO_DEMO.creditRate) || 0.2576;
    const rate = "$" + credit.toFixed(4) + "/kWh";
    const inv = document.createElement("div");
    inv.className = "rb-demo-inv";
    inv.style.cssText = "margin-top:15px";
    inv.innerHTML = `
      <div class="rb-doc-cap">Inside the invoice attachment</div>
      <div style="border:1px solid var(--line);border-radius:12px;background:var(--card);padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:14px">
          <div>
            <div style="font-weight:800;font-size:15px;color:var(--ink)">Catamount Community Solar</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">Solar credit invoice · ${esc(d.invoice_number || "")}</div>
          </div>
          <div style="text-align:right;font-size:11.5px;color:var(--muted)">
            <div><b style="color:var(--ink)">Bill to</b></div>
            <div>${esc(d.customer_name)}</div>
            <div style="margin-top:5px">${esc(d.period_label || "")}</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <tr><td style="padding:5px 0;color:var(--muted)">Array total production</td>
              <td style="padding:5px 0;text-align:right;color:var(--ink)">${fmt0(d.array_total_kwh)} kWh</td></tr>
          <tr><td style="padding:5px 0;color:var(--muted)">Your share</td>
              <td style="padding:5px 0;text-align:right;color:var(--ink)">${d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 + "%" : "—"}</td></tr>
          <tr><td style="padding:5px 0;color:var(--muted)">Your production</td>
              <td style="padding:5px 0;text-align:right;color:var(--ink)">${fmt0(d.customer_kwh)} kWh</td></tr>
          <tr><td style="padding:5px 0;color:var(--muted)">Solar-credit rate</td>
              <td style="padding:5px 0;text-align:right;color:var(--ink)">${rate}</td></tr>
          <tr style="border-top:1px solid var(--line)"><td style="padding:9px 0 0;font-weight:800;color:var(--ink)">Amount due</td>
              <td style="padding:9px 0 0;text-align:right;font-weight:800;font-size:15px;color:var(--good)">${money(d.amount_usd)}</td></tr>
        </table>
        <div style="font-size:11px;color:var(--muted);margin-top:13px;line-height:1.5">
          ${fmt0(d.customer_kwh)} kWh × ${rate} = ${money(d.amount_usd)}. Billed from the operator's GMP utility bill at the net-metering credit rate.
        </div>
      </div>
      <p class="rb-doc-hint">In the live app this is your real reproduced invoice PDF. <a href="/onboarding" style="color:var(--good)">Start free →</a> to generate it from your own bills.</p>`;
    pane.appendChild(inv);
  }



  function shell() {
    return `
      <div id="rbSubInvoice" class="rb-subpanel rb2">
      <!-- ═ Redesign (Ford-approved mock, 2026-07-03): header band (title + KPIs)
           + send-pipeline band + connection rail + sticky action bar over the
           collapsed hierarchy. Every legacy id/host below is PRESERVED — only
           the frame around them changed, so all existing wiring keeps working. ═ -->
      <div class="rb2-head">
        <div class="rb2-id">
          <h1>Offtaker invoicing</h1>
          <p>Every offtaker's solar credit invoice, generated from their settled utility bills. Nothing sends until you approve it.</p>
          <div class="rb-subtabs rb-subtabs-bare rb2-subtabs" role="tablist" id="rbGenTabs">
            <button type="button" class="rb-subtab on" data-gentab="offtakers">Offtakers</button>
            <button type="button" class="rb-subtab" data-gentab="audit" title="Audit GMP's per-offtaker allocation against each array's master utility bill.">Bill audit<span class="rb-au-genbadge" id="rbAuditTabBadge" hidden></span></button>
          </div>
        </div>
        <div class="rb2-kpis" id="rb2Kpis" hidden></div>
      </div>
      <div class="rb2-pipe" id="rb2Pipe" hidden></div>
      <div id="rbAuditView" class="rb-au" style="display:none"></div>
      <div id="rbGenList">
      <div class="rb-listwrap rb2-listwrap">
        <!-- Connection rail: the plumbing status lines (✓ sources connected +
             the ⚡ auto-refresh nudge) render into this host as before. -->
        <div class="rb-gmpbills-status rb2-rail" id="rbGmpBillsStatus"></div>
        <div class="rb2-controls">
          <span class="rb2-controls-label">Your offtakers</span>
          <span class="rb2-sp"></span>
          <div class="rb-head-actions rb2-actions">
            <!-- Portfolio-level batch export, now folded into ONE Export popover
                 (approved mock): same two CSV buttons + the Xero AccountCode
                 field, same ids, same wiring (wireExport). -->
            <div class="rb2-exportwrap">
              <button class="ao-btn rb-btn" id="rb2ExportBtn" type="button" aria-haspopup="true" aria-expanded="false">⬇ Export</button>
              <div class="rb2-exportpop" id="rb2ExportPop" hidden>
                <div class="rb2-exportpop-h">Export this period's invoices</div>
                <p class="rb2-exportpop-p">One CSV per accounting system — layouts differ, both import directly.</p>
                <div class="rb-export rb2-export" id="rbExportBox" hidden>
                  <button class="ao-btn rb-btn" id="rbExportQb" type="button"
                          title="Download all offtaker invoices this period as a QuickBooks Online import CSV.">⬇ QuickBooks</button>
                  <button class="ao-btn rb-btn" id="rbExportXero" type="button"
                          title="Download all offtaker invoices this period as a Xero Sales-Invoice import CSV (uses the account code, if set).">⬇ Xero</button>
                  <input class="rb-export-acct" id="rbExportAcct" type="text" inputmode="text"
                         placeholder="Xero account code" maxlength="40" autocomplete="off"
                         title="Optional — the Xero AccountCode these solar invoices post to (e.g. 200). QuickBooks doesn't need it (it uses a &quot;Solar Credit&quot; product/service). Remembered for next time.">
                  <span class="rb-export-hint" title="The account code applies to the Xero export only — QuickBooks uses a default &quot;Solar Credit&quot; item.">Xero only — QuickBooks uses a "Solar Credit" item</span>
                  <span class="rb-export-stat" id="rbExportStat" aria-live="polite"></span>
                </div>
              </div>
            </div>
            <button class="ao-btn rb-btn" id="rbEmailStudio" type="button" title="Customize the email every offtaker invoice goes out with — greeting, wording, sign-off. Personalized per offtaker with merge tags ({{greeting}} renders “Hi Abigail,” automatically); a per-offtaker edited note still overrides it.">✉ Customize email</button>
            <button class="ao-btn rb-btn" id="rbLinkUtility" type="button" title="Connect the utility whose bills you invoice against — GMP, VEC, or any of ~470 supported utilities nationwide. Offtakers bill from these utility bills.">🔗 Link utility bills</button>
            <button class="ao-btn rb-btn" id="rbBulkImport" type="button" title="Add many offtakers at once from a CSV roster — name, percent share, and (ideally) account number.">⬆ Bulk import</button>
            <button class="ao-btn ao-btn-primary rb-btn" id="rbCustAdd" type="button">＋ Add an offtaker</button>
          </div>
        </div>
        <!-- Invoice archive (monthly directory) — collapsible month-close surface. -->
        <div id="rbArchiveHost" hidden></div>
        <div id="rbCustManual"></div>
        <div id="rbBulkHost"></div>
        <div id="rbList"><div class="empty" style="padding:22px 0;color:var(--faint)">Loading…</div></div>
      </div>
      <!-- ONE wired invoice-template box, PER-OFFTAKER: it folds into whichever
           offtaker card is open and rebinds to that offtaker's own template
           (foldTplIntoInbox → rebindTpl). Parked here (#rbTplHome, kept HIDDEN) when
           no card is open, and stashed in #rbTplStash during an open card's
           re-render so it doesn't flash. Each offtaker has its own template; this box
           hits per-subscription endpoints (see tplApi). -->
      <div id="rbTplStash" hidden></div>
      <div id="rbTplHome" hidden>
      <div class="rb-tpl rep-card" id="rbTpl">
        <div class="rb-tpl-main">
          <h3>This offtaker’s invoice template</h3>
          <p>Upload an invoice and <b>this offtaker’s</b> invoices reproduce that exact format — PDF, Word, HTML, an image, or an Excel workbook (we'll find the invoice sheet inside it). Leave it on Default to use the standard format.</p>
        </div>
        <div class="rb-tpl-ctl">
          <input type="file" id="rbTplFile" accept=".pdf,.html,.htm,.docx,.doc,.png,.jpg,.jpeg,.xlsx,.xls,.xlsm" hidden>
          <button class="ao-btn ao-btn-primary rb-btn" id="rbTplPick" type="button">⬆ Upload template</button>
          <span class="rb-tpl-status" id="rbTplStatus">Checking…</span>
          <button class="ao-btn rb-btn rb-danger" id="rbTplDel" type="button" hidden>Remove</button>
        </div>
        <p class="rb-tpl-drophint">…or just drag &amp; drop a file anywhere on this box.</p>
        <div class="rb-tpl-edit" id="rbTplEditRow" hidden>
          <span class="rb-tpl-fmt-label">Offtaker invoice format</span>
          <div class="rb-seg rb-slider rb-tpl-fmt" id="rbTplFmt">
            <button type="button" data-v="template">Use this template</button>
            <button type="button" data-v="default">Default format</button>
          </div>
          <span class="rb-tpl-estatus" id="rbTplEStatus"></span>
        </div>
      </div>
      </div>
      </div><!-- /rbGenList -->
      </div><!-- /rbSubInvoice -->
      <div id="rbSubQuarterly" class="rb-subpanel" style="display:none"></div>`;
  }

  // ---- subtab switching (Invoice generator / Quarterly reports / Customers) --
  let QUARTERLY_RENDERED = false;
  function wireSubtabs() {
    const tabs = Array.from(document.querySelectorAll(".rb-subtab"));
    if (!tabs.length) return;
    tabs.forEach(btn => btn.onclick = () => {
      const sub = btn.getAttribute("data-sub");
      tabs.forEach(b => b.classList.toggle("on", b === btn));
      const inv = $("#rbSubInvoice"), q = $("#rbSubQuarterly");
      if (inv) inv.style.display = sub === "invoice" ? "" : "none";
      if (q) q.style.display = sub === "quarterly" ? "" : "none";
      if (sub === "quarterly") renderQuarterly();
    });
  }

  // ---- Quarterly reports subtab ---------------------------------------------
  // A per-customer quarterly performance report: the quarter's invoice math +
  // the real daily-generation bar graph (the chart a customer actually reads),
  // reusing window.AOBars so it can't drift from the Trends tab's bar chart.
  let QTRENDS_STOPS = [];     // active chart cleanup fns

  function teardownQTrends() {
    QTRENDS_STOPS.forEach(fn => { try { fn && fn(); } catch (e) {} });
    QTRENDS_STOPS = [];
  }

  async function renderQuarterly() {
    const host = $("#rbSubQuarterly");
    if (!host) return;
    host.innerHTML = `
      <div class="rep-card rb-q-head">
        <h3>Quarterly performance report</h3>
        <p>Pick an offtaker and a quarter — we build the produced-kWh invoice for
           that quarter plus a visual production report, then you review and send it.</p>
        <div class="rb-q-controls">
          <label class="rep-fld"><span class="rl">Offtaker</span>
            <select id="rbqCustomer"><option value="">Loading…</option></select></label>
          <label class="rep-fld"><span class="rl">Quarter</span>
            <select id="rbqQuarter"></select></label>
        </div>
      </div>
      <div id="rbqBody"></div>`;
    // Populate quarter options (current + last 7 quarters).
    fillQuarterOptions($("#rbqQuarter"));
    // Populate customers from the existing subscriptions list.
    try {
      const r = await fetch(API + "/subscriptions", { headers: authHeaders() });
      const subs = ((await r.json().catch(() => ({}))).subscriptions) || [];
      const sel = $("#rbqCustomer");
      if (!subs.length) {
        sel.innerHTML = `<option value="">No offtakers yet — add one in the Offtakers tab</option>`;
      } else {
        sel.innerHTML = subs.map(s =>
          `<option value="${s.id}">${esc(s.customer_name)}</option>`).join("");
      }
      sel.onchange = renderQuarterlyBody;
      $("#rbqQuarter").onchange = renderQuarterlyBody;
      if (subs.length) renderQuarterlyBody();
    } catch (e) {
      $("#rbqBody").innerHTML = `<div class="empty">Couldn't load offtakers — refresh to retry.</div>`;
    }
  }

  function fillQuarterOptions(sel) {
    if (!sel) return;
    const now = new Date();
    let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
    const opts = [];
    for (let i = 0; i < 8; i++) {
      opts.push(`<option value="${y}-Q${q}">Q${q} ${y}</option>`);
      q--; if (q < 1) { q = 4; y--; }
    }
    sel.innerHTML = opts.join("");
  }

  async function renderQuarterlyBody() {
    const body = $("#rbqBody");
    const subId = $("#rbqCustomer") && $("#rbqCustomer").value;
    const quarter = $("#rbqQuarter") && $("#rbqQuarter").value;
    if (!body || !subId) return;
    teardownQTrends();
    body.innerHTML = `<div class="rep-card"><div class="empty" style="padding:18px 0;color:var(--faint)">Building report…</div></div>`;

    // 1) the quarter's invoice math (real produced kWh × rate; never fabricated).
    let math = null;
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/preview-math", { headers: authHeaders() });
      if (r.ok) math = await r.json().catch(() => null);
    } catch (e) { /* surfaced below */ }

    const cust = $("#rbqCustomer").selectedOptions[0]
      ? $("#rbqCustomer").selectedOptions[0].textContent : "Offtaker";
    // Honest provenance (audit #8): bill_prorate is an ESTIMATE (a utility bill smeared
    // flat across its days), never "uploaded/measured" data.
    const _ks = math && math.kwh_source;
    const srcLabel = _ks === "gmp_api" ? "GMP metered data"
      : _ks === "bill_prorate" ? "estimated from your utility bill (prorated)"
      : _ks === "utility_bill" ? "your utility bill"
      : _ks === "daily_csv" ? "your metered generation data"
      : "best available data";
    const hasData = math && math.has_data;

    body.innerHTML = `
      <div class="rep-card rb-q-invoice">
        <div class="rb-q-inv-h"><h4>${esc(cust)} · ${esc(quarter)}</h4>
          <span class="rb-q-src">source: ${esc(srcLabel)}</span></div>
        ${hasData ? `
          <div class="rb-q-stats">
            <div class="st"><b>${fmt0(math.customer_kwh)}</b><span>kWh produced</span></div>
            <div class="st"><b>${math.rate != null ? "$" + Number(math.rate).toFixed(3) : "—"}</b><span>$/kWh${math.rate_source ? " · " + esc(math.rate_source) : ""}</span></div>
            <div class="st"><b>${money(math.amount_usd)}</b><span>amount due</span></div>
          </div>
          <p class="rb-q-math">${fmt0(math.customer_kwh)} kWh × ${math.rate != null ? "$" + Number(math.rate).toFixed(3) : "—"}/kWh = <b>${money(math.amount_usd)}</b>
             <span class="rb-q-period">· latest period ${esc(math.period_start || "—")} → ${esc(math.period_end || "—")}</span></p>
        ` : `<div class="rb-warn">No generation data yet for this offtaker's array — no fabricated numbers. Connect data or upload generation to build the quarter's invoice.</div>`}
      </div>
      <div class="rep-card rb-q-charts">
        <h4>Production report</h4>
        <div class="rb-q-chart rb-q-chart-wide"><div class="rb-q-chart-cap">Daily Generation</div><div id="rbqBars" class="rb-q-canvas"></div></div>
      </div>
      <div class="rb-q-actions">
        <button class="ao-btn ao-btn-primary rb-btn" id="rbqDraft" type="button">Draft this report for review →</button>
        <span class="rb-status" id="rbqStatus"></span>
      </div>`;

    // 2) mount the daily-generation bar graph (real DailyGeneration, the chart
    //    the offtaker reads on their report).
    mountQTrends(subId);

    // 3) "Draft for review" reuses the existing per-subscription draft flow.
    const draftBtn = $("#rbqDraft");
    if (draftBtn) draftBtn.onclick = () => quarterlyDraft(subId);
  }

  async function mountQTrends(subId) {
    const barsHost = $("#rbqBars");

    // DAILY GENERATION bar graph (real DailyGeneration, scaled to this
    // offtaker's share) — the one chart a customer actually reads on a
    // monthly/quarterly report. Never fabricated; honest empty when no rows.
    if (barsHost && window.AOBars && subId) {
      barsHost.style.position = "relative";
      barsHost.innerHTML = `<div class="empty" style="padding:18px 0;color:var(--faint)">Loading daily generation…</div>`;
      try {
        const r = await fetch(API + "/subscriptions/" + subId + "/daily-series", { headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        barsHost.innerHTML = "";
        const stop = window.AOBars.mount(barsHost, data || {});
        if (stop) QTRENDS_STOPS.push(stop);
        const cap = barsHost.parentElement && barsHost.parentElement.querySelector(".rb-q-chart-cap");
        if (cap && data && data.period_label) cap.textContent = "Daily Generation · " + data.period_label;
      } catch (e) {
        barsHost.innerHTML = `<div class="empty" style="padding:18px 0;color:var(--faint)">Couldn't load daily generation.</div>`;
      }
    }
  }

  async function quarterlyDraft(subId) {
    const st = $("#rbqStatus");
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Drafting for review…"; }
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/draft", { method: "POST", headers: authHeaders() });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        noteXcheck(subId, data);   // the cross-check rides the generation response
        const xc = data.crosscheck;
        if (st) {
          if (xc && xc.flagged) {
            st.className = "rb-status rb-err";
            st.textContent = "Drafted — but the cross-check flagged it: GMP's bill doesn't match this offtaker's share ("
              + fmtPct(xc.computed_share_pct) + "% on the bills vs " + fmtPct(xc.entered_share_pct)
              + "% entered). Review it in the approval inbox before sending.";
          } else {
            st.className = "rb-status rb-ok";
            st.textContent = (xc && !xc.flagged ? "Cross-check ✓ GMP's numbers match this offtaker's share. " : "")
              + "Added to your approval inbox (Invoice generator tab) — review, edit the email, then send.";
          }
        }
      } else {
        if (st) { st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Couldn't draft."; }
      }
    } catch (e) { if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error."; } }
  }

  // ---- upload + match --------------------------------------------------------
  function wireUpload() {
    const input = $("#rbFile");
    const drop = $("#rbDrop");
    if (!input || !drop) return;
    input.addEventListener("change", () => { if (input.files[0]) matchFile(input.files[0]); });
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add("rb-drop-over");
    }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove("rb-drop-over");
    }));
    drop.addEventListener("drop", e => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) matchFile(f);
    });
  }

  // ---- invoice template upload (operator's own format) ----------------------
  // Stage 1: bank the operator's invoice template per-tenant. Generating offtaker
  // invoices FROM it is gated server-side (Stage 2), so uploading here never
  // changes a live send today — it captures the format to reproduce.
  async function wireInvoiceTemplate() {
    const pick = $("#rbTplPick"), fileIn = $("#rbTplFile"), status = $("#rbTplStatus");
    const view = $("#rbTplView"), del = $("#rbTplDel");
    const fmtSeg = $("#rbTplFmt"), editRow = $("#rbTplEditRow"), htmlBox = $("#rbTplHtml"), tokens = $("#rbTplTokens");
    const saveBtn = $("#rbTplSave"), prevBtn = $("#rbTplPreview"), estatus = $("#rbTplEStatus");
    if (!pick || !fileIn || !status) return;
    const jsonHdr = () => Object.assign({ "Content-Type": "application/json" }, authHeaders() || {});
    // Reflect the enabled state on the two-option slider (Use this template / Default).
    function setFmt(useTpl) {
      if (!fmtSeg) return;
      fmtSeg.querySelectorAll("button").forEach(b =>
        b.classList.toggle("on", (b.getAttribute("data-v") === "template") === !!useTpl));
    }
    function paint(t) {
      const has = t && t.has_template;
      status.textContent = has
        ? "On file: " + (t.filename || "your template") + ". " +
          (t.enabled ? "Used for this offtaker’s invoices." : "Saved — turn on below to use it.")
        : "No template yet — this offtaker’s invoices use the standard format.";
      status.className = "rb-tpl-status" + (has ? " rb-tpl-have" : "");
      if (view) view.hidden = !(t && t.filename);
      if (del) del.hidden = !has;
      // The Use-this-template / Default-format slider only makes sense with a
      // template on file; it defaults to "Use this template" once one is uploaded.
      if (editRow) editRow.hidden = !has;
      if (fmtSeg && t) setFmt(!!t.enabled);
      // don't clobber unsaved edits in the textarea
      if (htmlBox && t && t.html != null && !htmlBox.dataset.dirty) htmlBox.value = t.html;
      if (tokens && t && t.tokens) tokens.innerHTML = "Tokens you can use: " +
        t.tokens.map(x => "<code>{{ " + x + " }}</code>").join(" ");
      // Feed the live draft preview so an uploaded/enabled template shows there now.
      TEMPLATE_STATE = t ? { enabled: !!t.enabled, html: t.html || "", has: !!t.has_template } : null;
      renderDraftDoc();
      loadTplPreview(t);                              // rendered PDF of the template
    }
    // Template-card preview: render the stored template (sample data) via the shared
    // renderPdfToPaper — JUST the invoice page, no PDF-viewer chrome.
    async function loadTplPreview(t) {
      const pane = $("#rbTplDocPane");
      if (!pane) return;
      const has = !!(t && t.has_template);
      if (!has) {
        pane.innerHTML = '<div class="rb-doc-cap">Template preview</div>' +
          '<div class="rb-doc-empty"><span class="ico">📄</span>' +
          '<b>Your template preview appears here</b>' +
          '<div>Upload your invoice and we\'ll render a live PDF preview of it here.</div></div>';
        return;
      }
      pane.innerHTML = '<div class="rb-doc-cap">Our reproduction of your template — ' +
        esc(t.filename || 'your invoice') + '</div>' +
        '<div class="rb-tpl-prevbtns">' +
          '<button type="button" class="ao-btn rb-btn" id="rbPrevDefault" data-fmt="default">View our default format</button>' +
          '<button type="button" class="ao-btn rb-btn" id="rbPrevRepro" data-fmt="repro">View your reproduced template</button>' +
        '</div>' +
        '<div class="rb-tpl-paper" id="rbTplPaper"><div class="rb-tpl-load">Rendering preview…</div></div>' +
        '<p class="rb-doc-hint">Switch between your reproduced template and our standard format to compare them. ' +
        '<a href="#" id="rbPrevOpen">Open the full PDF ↗</a></p>';
      const paper = $("#rbTplPaper");
      const PREV_URL = {
        repro: API + "/invoice-template/preview.pdf",
        default: API + "/invoice-template/preview.pdf?default=1",
      };
      let curFmt = "repro";
      // The two buttons TOGGLE this inline pane (no new tab) so the operator can
      // flip between their reproduced template and our standard format side by side.
      const showFmt = async (fmt) => {
        curFmt = fmt;
        pane.querySelectorAll(".rb-tpl-prevbtns button").forEach(b =>
          b.classList.toggle("on", b.getAttribute("data-fmt") === fmt));
        paper.innerHTML = '<div class="rb-tpl-load">Rendering preview…</div>';
        try {
          const r = await fetch(PREV_URL[fmt], { headers: authHeaders() });
          if (!r.ok) throw new Error("preview " + r.status);
          await renderPdfToPaper(await r.arrayBuffer(), paper);
        } catch (e) {
          paper.innerHTML = '<div class="rb-doc-empty" style="padding:34px 16px;">' +
            '<span class="ico">📄</span><b>This view is unavailable right now</b>' +
            '<div>Your template is still saved — try the other view.</div></div>';
        }
      };
      const bDef = $("#rbPrevDefault"), bRep = $("#rbPrevRepro");
      if (bDef) bDef.onclick = () => showFmt("default");
      if (bRep) bRep.onclick = () => showFmt("repro");
      const openBtn = $("#rbPrevOpen");
      if (openBtn) openBtn.onclick = async (e) => {
        e.preventDefault();
        try {
          const rr = await fetch(PREV_URL[curFmt], { headers: authHeaders() });
          if (!rr.ok) return;
          const u = URL.createObjectURL(await rr.blob());
          window.open(u, "_blank");
          setTimeout(() => URL.revokeObjectURL(u), 60000);
        } catch (_) {}
      };
      showFmt("repro");   // default inline view = the reproduced template
    }
    async function refresh() {
      const base = tplApi();
      if (!base || !authHeaders()) { paint(null); return; }   // no offtaker bound (parked) / demo
      try {
        const r = await fetch(base, { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        paint(r.ok ? d.template : null);
      } catch (e) { paint(null); }
      // keep the Master Account file library in sync after upload/remove/enable
      try { if (window.__aoReloadFiles) window.__aoReloadFiles(); } catch (e) {}
    }
    _tplRefresh = refresh;        // rebindTpl(sid) calls this when a card folds in
    await refresh();
    pick.onclick = () => fileIn.click();
    async function doUpload(f) {
      if (!f) return;
      status.textContent = "Uploading " + f.name + "…"; status.className = "rb-tpl-status rb-busy";
      const fd = new FormData(); fd.append("file", f);
      const base = tplApi();
      if (!base) { status.textContent = "Open an offtaker to set its template."; status.className = "rb-tpl-status rb-err"; return; }
      try {
        const r = await fetch(base, { method: "POST", headers: authHeaders(), body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { status.textContent = (d && d.detail) || "Upload failed."; status.className = "rb-tpl-status rb-err"; }
        else { if (htmlBox) htmlBox.dataset.dirty = ""; await refresh(); }
      } catch (e) { status.textContent = "Upload failed — check your connection."; status.className = "rb-tpl-status rb-err"; }
    }
    fileIn.onchange = async () => { await doUpload(fileIn.files && fileIn.files[0]); fileIn.value = ""; };
    // Drag & drop a file anywhere on the template box. Listeners live on #rbTpl,
    // which survives the parkTpl/foldTplIntoInbox DOM moves.
    const drop = $("#rbTpl");
    if (drop && !drop.dataset.dropWired) {
      drop.dataset.dropWired = "1";
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, (e) => { stop(e); drop.classList.add("rb-tpl-drag"); }));
      ["dragleave", "dragend"].forEach(ev => drop.addEventListener(ev, (e) => {
        stop(e);
        if (ev === "dragleave" && drop.contains(e.relatedTarget)) return;  // moving over a child
        drop.classList.remove("rb-tpl-drag");
      }));
      drop.addEventListener("drop", (e) => {
        stop(e); drop.classList.remove("rb-tpl-drag");
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) doUpload(f);
      });
    }
    if (view) view.onclick = async () => {
      try {
        const r = await fetch(API + "/invoice-template/file", { headers: authHeaders() });
        if (!r.ok) return;
        const url = URL.createObjectURL(await r.blob());
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {}
    };
    if (del) del.onclick = async () => {
      if (!confirm("Remove this offtaker’s invoice template? Their invoices go back to the standard format.")) return;
      const base = tplApi();
      try { if (base) await fetch(base, { method: "DELETE", headers: authHeaders() }); } catch (e) {}
      if (htmlBox) { htmlBox.value = ""; htmlBox.dataset.dirty = ""; }
      await refresh();
    };
    if (htmlBox) htmlBox.oninput = () => { htmlBox.dataset.dirty = "1"; };
    async function savePut(body, okMsg) {
      if (estatus) { estatus.textContent = "Saving…"; estatus.className = "rb-tpl-estatus rb-busy"; }
      const base = tplApi();
      if (!base) { if (estatus) { estatus.textContent = "Open an offtaker first."; estatus.className = "rb-tpl-estatus rb-err"; } return false; }
      try {
        const r = await fetch(base, { method: "PUT", headers: jsonHdr(), body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (estatus) { estatus.textContent = (d && d.detail) || "Save failed."; estatus.className = "rb-tpl-estatus rb-err"; } return false; }
        if (htmlBox) htmlBox.dataset.dirty = "";
        paint(d.template);
        if (estatus) { estatus.textContent = okMsg || "Saved."; estatus.className = "rb-tpl-estatus rb-ok"; }
        return true;
      } catch (e) { if (estatus) { estatus.textContent = "Save failed."; estatus.className = "rb-tpl-estatus rb-err"; } return false; }
    }
    if (fmtSeg) fmtSeg.querySelectorAll("button").forEach(b => b.onclick = () => {
      const useTpl = b.getAttribute("data-v") === "template";
      setFmt(useTpl);                                  // optimistic; paint() reconciles
      savePut({ enabled: useTpl },
        useTpl ? "On — invoices use your template." : "Using the standard format.");
    });
    if (saveBtn) saveBtn.onclick = () => savePut({ html: htmlBox ? htmlBox.value : "" }, "Template saved.");
    if (prevBtn) prevBtn.onclick = async () => {
      if (estatus) { estatus.textContent = "Rendering preview…"; estatus.className = "rb-tpl-estatus rb-busy"; }
      try {
        const r = await fetch(API + "/invoice-template/preview", { method: "POST", headers: jsonHdr(),
          body: JSON.stringify({ html: htmlBox ? htmlBox.value : null }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); if (estatus) { estatus.textContent = (d && d.detail) || "Preview failed."; estatus.className = "rb-tpl-estatus rb-err"; } return; }
        const url = URL.createObjectURL(await r.blob());
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (estatus) { estatus.textContent = "Preview opened."; estatus.className = "rb-tpl-estatus rb-ok"; }
      } catch (e) { if (estatus) { estatus.textContent = "Preview failed."; estatus.className = "rb-tpl-estatus rb-err"; } }
    };
  }

  // ---- global default billing (net rate + discount) --------------------------
  async function wireGlobalRate() {
    const net = $("#rbGrNet");
    const disc = $("#rbGrDisc");
    const save = $("#rbGrSave");
    const st = $("#rbGrStatus");
    const eff = $("#rbGrEff");
    if (!net || !disc || !save) return;

    let effNet = 0.18398, effDisc = 0.10;   // built-in fallbacks for the preview
    function renderEff() {
      const n = net.value.trim() === "" ? effNet : Number(net.value);
      const d = disc.value.trim() === "" ? effDisc * 100 : Number(disc.value);
      if (eff) {
        if (isNaN(n) || isNaN(d)) { eff.textContent = ""; return; }
        const rate = n * (1 - d / 100);
        eff.innerHTML = `Offtakers pay <b>$${rate.toFixed(4)}/kWh</b> ` +
          `(credit $${n.toFixed(4)} − ${d.toFixed(0)}% off). ` +
          `Blank = your defaults ($${effNet.toFixed(3)} credit, ${(effDisc*100).toFixed(0)}% off).`;
      }
    }
    // Load current globals (+ the effective defaults the backend would apply).
    try {
      const r = await fetch(API + "/global-rate", { headers: authHeaders() });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        if (data.effective_net_rate_per_kwh != null) effNet = data.effective_net_rate_per_kwh;
        if (data.effective_discount_pct != null) effDisc = data.effective_discount_pct;
        if (data.default_net_rate_per_kwh != null) net.value = data.default_net_rate_per_kwh;
        else if (data.default_billing_rate_per_kwh != null) net.value = data.default_billing_rate_per_kwh;
        if (data.default_discount_pct != null) disc.value = Math.round(data.default_discount_pct * 100);
      }
    } catch (e) { /* leave blank */ }
    renderEff();
    net.addEventListener("input", renderEff);
    disc.addEventListener("input", renderEff);

    save.onclick = async () => {
      const body = {};
      // net rate: blank clears (→ VT default)
      const rawNet = net.value.trim();
      if (rawNet === "") body.default_net_rate_per_kwh = null;
      else {
        const n = Number(rawNet);
        if (isNaN(n) || n < 0 || n > 5) {
          st.className = "rb-status rb-err"; st.textContent = "Solar credit rate must be 0–5 $/kWh, or blank to clear."; return;
        }
        body.default_net_rate_per_kwh = n;
      }
      // discount: blank clears (→ 10% default); UI is whole-% → fraction
      const rawDisc = disc.value.trim();
      if (rawDisc === "") body.default_discount_pct = null;
      else {
        const d = Number(rawDisc);
        if (isNaN(d) || d < 0 || d >= 100) {
          st.className = "rb-status rb-err"; st.textContent = "Discount must be 0–99%, or blank for the 10% default."; return;
        }
        body.default_discount_pct = d / 100;
      }
      st.className = "rb-status rb-busy"; st.textContent = "Saving…";
      try {
        const r = await fetch(API + "/global-rate", {
          method: "PUT",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          st.className = "rb-status rb-ok"; st.textContent = "Saved.";
          await refreshList();   // re-price rows that use the defaults
        } else {
          st.className = "rb-status rb-err";
          st.textContent = (data && data.detail) ? data.detail : "Couldn't save.";
        }
      } catch (e) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
    };
  }

  async function matchFile(file) {
    const status = $("#rbStatus");
    status.className = "rb-status rb-busy";
    status.textContent = "Reading " + file.name + "…";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(API + "/match", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        status.className = "rb-status rb-err";
        status.textContent = (data && data.detail) ? data.detail : "Couldn't read that file (HTTP " + r.status + ").";
        return;
      }
      const m = data.match;
      if (!m.matched) {
        status.className = "rb-status rb-err";
        status.textContent = "We couldn't recognize this as a billing workbook. " +
          ((m.warnings || [])[0] || "Try a different file.");
        return;
      }
      status.className = "rb-status rb-ok";
      status.textContent = "Recognized " + (m.customer.name || "an offtaker") +
        " (confidence " + Math.round((m.confidence || 0) * 100) + "%).";
      PENDING = { file, match: m };
      renderPreview(m);
    } catch (e) {
      status.className = "rb-status rb-err";
      status.textContent = "Network error while matching — try again.";
    }
  }

  // ---- add a customer manually (no spreadsheet) ------------------------------
  // Backend: POST /subscriptions with NO file → manual sub from
  // customer_name + array_id + allocation_pct (percent_of_array model). The
  // customer's invoice each cycle = allocation_pct × the array's generation.
  let MANUAL_OPEN = false;
  let ARRAYS = null;   // cached [{id,name,client_name}] for the array picker
  // Where the manual-add form mounts + what to refresh after a successful add.
  // Defaults target the Offtakers subtab; back-compat with the old #rbManual mount.
  let MANUAL_HOST_ID = "rbManual";
  let MANUAL_AFTER_ADD = null;

  async function fetchArrays() {
    if (ARRAYS) return ARRAYS;
    try {
      const r = await fetch("/v1/array-owners/fleet-tree", { headers: authHeaders() });
      if (!r.ok) return (ARRAYS = []);
      const t = await r.json().catch(() => ({}));
      // fleet-tree returns { columns: [{ array_id, array_name, ... }] } — map
      // from that shape (NOT t.arrays / a.name, which never existed here).
      ARRAYS = (t.columns || []).map(a => ({
        id: a.array_id, name: a.array_name, client_name: a.client_name,
      })).filter(a => a.id != null);
    } catch (e) { ARRAYS = []; }
    return ARRAYS;
  }

  // GMP utility accounts (offtaker ↔ utility-bill binding). Each carries a
  // summary of the bills we hold so the picker shows whether a paper bill is on
  // file. Offtaker invoices read these bills ONLY — never vendor/inverter data.
  // NOTE: we deliberately DO NOT cache. A previous version cached the result in
  // a module var, but an empty list ([]) is truthy in JS, so once a pre-connect
  // fetch cached [], every reopen returned the stale empty list forever and the
  // dropdown never populated after GMP was connected. Always fetch fresh — the
  // list is tiny and this endpoint is cheap.
  async function fetchUtilityAccounts() {
    try {
      const r = await fetch(API + "/utility-accounts", { headers: authHeaders() });
      if (!r.ok) return [];
      const d = await r.json().catch(() => ({}));
      return (d.utility_accounts || []).filter(a => a.utility_account_id != null);
    } catch (e) { return []; }
  }

  // GMP expected-rate cross-check (Piece 4). Given the array's commissioning
  // DATE (YYYY-MM-DD — day-accurate at the 11-year Rate #1 → Blended boundary,
  // Bruce's C4 ask), ask the backend what GMP's published schedule says the rate
  // should be THIS month, so the operator can sanity-check the billing rate.
  // Reference only — never overrides the bill's own billed rate. Returns null on
  // any failure (fail-soft).
  async function fetchExpectedGmpRate(commissionDate) {
    if (!authHeaders()) return null;
    const now = new Date();
    const qs = new URLSearchParams({
      year: String(now.getFullYear()),
      month: String(now.getMonth() + 1),
      commission_date: String(commissionDate),
    });
    try {
      const r = await fetch(API + "/gmp-expected-rate?" + qs.toString(), { headers: authHeaders() });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } catch (e) { return null; }
  }

  // Honest one-line summary of the expected-rate payload for an inline hint.
  function expectedRateHintHTML(rate) {
    if (!rate || rate.rate_plus_adder == null) return "";
    const base = Number(rate.rate_per_kwh);
    const adder = Number(rate.solar_adder || 0);
    const total = Number(rate.rate_plus_adder);
    const regime = rate.regime_label || rate.regime || "GMP";
    const adderTxt = adder ? ` +$${adder.toFixed(4)} adder` : "";
    // Day-accurate 11-year boundary, made visible: when the switch date is known
    // the operator sees exactly when Rate #1 ends — an array near the mark can't
    // be silently misread (Bruce: GMP itself has called an array 11 two years early).
    let boundary = "";
    if (rate.blended_from) {
      const bf = docDate(rate.blended_from);
      boundary = rate.regime === "blended"
        ? ` · Blended since <b>${esc(bf)}</b>`
        : ` · Rate #1 until <b>${esc(bf)}</b>`;
      if (rate.regime_flips_within_month) boundary += " (crosses 11 years this month)";
      if (rate.year_only_assumed_jan1) boundary += " (from a year-only value — assumed Jan 1; set the exact date to pin the boundary)";
    }
    const clamped = rate.clamped ? " · <b>schedule clamped</b> (year outside the published range — nearest year used)" : "";
    return `Expected GMP rate: <b>$${total.toFixed(4)}/kWh</b> ($${base.toFixed(4)} ${esc(regime)}${adderTxt})${boundary}. Reference only — the invoice always uses the bill's own credit rate.${clamped}`;
  }

  // Today as a local YYYY-MM-DD (for <input type="date"> max= and validation).
  function todayISO() {
    const n = new Date();
    return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
  }

  // A commissioning date is valid when it parses as YYYY-MM-DD and lands in
  // 1990-01-01..today (native date inputs already emit this shape or "").
  function isValidCommissioningDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return false;
    return iso >= "1990-01-01" && iso <= todayISO();
  }

  // Wire a commissioning-date input (native <input type="date">) to a hint
  // element: on change, look up the expected GMP rate for that exact date and
  // render it inline (debounced). `defaultText` is restored when blank/invalid.
  function wireCommissioningDateHint(inputEl, hintEl, defaultText) {
    if (!inputEl || !hintEl) return;
    let timer = null;
    const run = () => {
      const raw = inputEl.value.trim();
      if (!isValidCommissioningDate(raw)) {
        hintEl.innerHTML = defaultText; hintEl.classList.remove("rb-rate-hint-on"); return;
      }
      hintEl.textContent = "Checking GMP schedule…"; hintEl.classList.add("rb-rate-hint-on");
      fetchExpectedGmpRate(raw).then(rate => {
        const html = expectedRateHintHTML(rate);
        if (html) { hintEl.innerHTML = html; hintEl.classList.add("rb-rate-hint-on"); }
        else { hintEl.innerHTML = defaultText; hintEl.classList.remove("rb-rate-hint-on"); }
      });
    };
    const debounced = () => { clearTimeout(timer); timer = setTimeout(run, 400); };
    inputEl.addEventListener("input", debounced);
    inputEl.addEventListener("change", debounced);
  }

  // When the extension lands a GMP/VEC bill capture, sandbox.js dispatches
  // ao:utility-accounts-changed. If the new-offtaker form is open, repopulate the
  // utility picker in place (preserving the current pick) so the freshly-linked
  // account appears without a manual page refresh.
  window.addEventListener("ao:utility-accounts-changed", () => {
    // Re-resolve the array→bill mapping in place if the array-first form is open.
    if (MANUAL_OPEN && $("#rbmArray")) resolveArrayBills(true);
  });

  // ---- array-FIRST manual add: pick the array, we resolve its utility bill ----
  // Cache of this tenant's utility accounts (each carries array_id) so we can map
  // the chosen array → the bill(s) it invoices from without a refetch on every
  // dropdown change. Refreshed by resolveArrayBills(forceRefetch).
  let ARR_UTIL_ACCTS = null;

  // Fill #rbmArray from the shared arrays cache (list-bundle .arrays), then wire
  // its change handler to resolve + display which utility bill invoices from it.
  function wireArrayFirst() {
    const sel = $("#rbmArray");
    if (!sel) return;
    fetchArrays().then(arrs => {
      const s = $("#rbmArray");
      if (!s) return;                                  // panel closed mid-fetch
      if (!arrs.length) {
        s.innerHTML = `<option value="">No arrays yet — connect one first</option>`;
      } else {
        s.innerHTML = `<option value="">Choose an array…</option>` +
          arrs.map(a => {
            const label = a.name || ("Array " + a.id);
            const client = a.client_name ? ` · ${a.client_name}` : "";
            return `<option value="${esc(String(a.id))}">${esc(label + client)}</option>`;
          }).join("");
      }
      s.onchange = () => resolveArrayBills(false);
    });
    // Prime the utility-account cache so the first array pick resolves instantly.
    resolveArrayBills(true, true);
  }

  // Resolve the utility bill(s) for the currently-selected array and paint the
  // "Invoices from:" line + (multi-bill) override picker / (no-bill) amber note.
  // `forceRefetch` re-pulls utility accounts (e.g. after an extension capture).
  // `primeOnly` fetches the cache but skips the paint (used to warm on open).
  function resolveArrayBills(forceRefetch, primeOnly) {
    const need = forceRefetch || !ARR_UTIL_ACCTS;
    const done = () => { if (!primeOnly) { paintArrayBills(); paintRateField(); } };
    if (need) {
      fetchUtilityAccounts().then(accts => { ARR_UTIL_ACCTS = accts || []; done(); });
    } else { done(); }
  }

  // ── Solar credit rate slot (Bruce C6) ──────────────────────────────────────
  // Which utility PROVIDER governs the offtaker being added, from what's already
  // resolved in the form: an explicit pick in the visible override picker wins;
  // else the chosen array's bound account(s) when they agree on one provider.
  // Returns a lowercase provider code ("gmp", "vec", …) or null (nothing chosen
  // yet / mixed candidates — resolves as soon as the operator picks).
  function rateSlotProvider() {
    const accts = ARR_UTIL_ACCTS || [];
    const wrap = $("#rbmUtilityWrap"), usel = $("#rbmUtility");
    if (wrap && !wrap.hidden && usel && usel.value) {
      const a = accts.find(x => String(x.utility_account_id) === String(usel.value));
      if (a) return (a.provider || "gmp").toLowerCase();
    }
    const arrSel = $("#rbmArray");
    const arrId = arrSel ? arrSel.value : "";
    if (!arrId) return null;
    const mine = accts.filter(a => String(a.array_id) === String(arrId));
    const cands = mine.length ? mine : accts;   // fresh-link case offers the full list
    if (!cands.length) return null;
    const provs = [...new Set(cands.map(a => (a.provider || "gmp").toLowerCase()))];
    return provs.length === 1 ? provs[0] : null;
  }

  // Render the Solar-credit-rate slot to match the resolved provider. Bill-scraped
  // utilities (GMP) get a read-only truth line — the invoice always prices from the
  // bill's own net-metering credit rate, so there is nothing to type. VEC/SmartHub
  // portals publish no usable credit rate, so those offtakers keep the manual
  // $/kWh input (operator-entered rate model). Mode is memoized on the slot so a
  // repaint never clobbers a half-typed rate.
  function paintRateField() {
    const slot = $("#rbmRateSlot");
    if (!slot) return;
    const prov = rateSlotProvider();
    const mode = (prov && prov !== "gmp") ? "manual:" + prov : "auto:" + (prov || "any");
    if (slot.dataset.mode === mode) return;    // unchanged — keep typed input intact
    slot.dataset.mode = mode;
    if (prov && prov !== "gmp") {
      const P = esc(prov.toUpperCase());
      slot.innerHTML = `<span class="rl">Solar credit rate ($/kWh)</span>
        <input type="number" id="rbmCreditRate" min="0" step="0.0001" placeholder="e.g. 0.14963">
        <span class="rb-fld-hint">${P}'s portal doesn't publish a usable credit rate — enter the $/kWh you bill at. Leave blank to use your default rate (or upload the ${P} bill PDF later and we'll read its rate).</span>`;
    } else {
      const src = prov === "gmp" ? "GMP bill" : "utility bill";
      slot.innerHTML = `<span class="rl">Solar credit rate</span>
        <span class="rb-rate-auto">Read from each ${src} automatically — the invoice always uses the bill's own net-metering credit rate.</span>`;
    }
  }

  // Given ARR_UTIL_ACCTS + the chosen #rbmArray (Net Meter Group), render the bill state:
  //  • exactly one linked bill → silent, show "Invoices from: …"
  //  • multiple linked bills  → reveal the #rbmUtility picker scoped to this group
  //  • NONE linked, but the tenant HAS utility accounts → reveal the picker with
  //    the FULL account list. A fresh GMP link lands accounts with array_id=null
  //    until they're matched to an array, so filtering on array_id alone showed
  //    Bruce an EMPTY select even though every bill was downloaded. The pick is
  //    sent explicitly on save and the backend links account → group from it.
  //  • no utility accounts at all → amber note + a link-utility button.
  function paintArrayBills() {
    const arrSel = $("#rbmArray"), line = $("#rbmBillLine");
    const wrap = $("#rbmUtilityWrap"), usel = $("#rbmUtility");
    if (!arrSel || !line) return;
    const arrId = arrSel.value;
    if (!arrId) {
      line.className = "rb-arr-billline";
      line.innerHTML = "";
      if (wrap) wrap.hidden = true;
      return;
    }
    const accts = ARR_UTIL_ACCTS || [];
    const mine = accts.filter(a => String(a.array_id) === String(arrId));
    if (!mine.length && !accts.length) {
      // Nothing to pick from anywhere — make the empty state ACTIONABLE.
      line.className = "rb-arr-billline rb-arr-nobill";
      line.innerHTML = "⚠ No utility bills yet — link your utility to invoice this group. ";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ao-btn rb-btn rbm-link-gmp";
      btn.textContent = "🔗 Link utility bills";
      btn.onclick = () => { if (window.__aoLinkUtility) window.__aoLinkUtility(); else location.hash = "#arrays"; };
      line.appendChild(btn);
      if (wrap) { wrap.hidden = true; usel.innerHTML = ""; }
      return;
    }
    if (!mine.length) {
      // Accounts exist but none is matched to this group yet (Bruce's fresh-link
      // case). Offer the full list instead of a dead end.
      line.className = "rb-arr-billline rb-arr-hasbill";
      line.innerHTML = "This group isn't matched to a utility bill yet — pick your offtaker's utility account below and we'll connect it.";
      showUtilityPicker(wrap, usel, accts, true, arrId);
      return;
    }
    if (mine.length === 1) {
      const a = mine[0];
      line.className = "rb-arr-billline rb-arr-hasbill";
      line.innerHTML = `Invoices from: <b>${esc(billLabel(a))}</b>`;
      if (wrap) { wrap.hidden = true; usel.innerHTML =
        `<option value="${a.utility_account_id}" selected>${esc(billLabel(a))}</option>`; }
      return;
    }
    // Multiple linked bills → picker scoped to this group's accounts.
    line.className = "rb-arr-billline rb-arr-hasbill";
    line.innerHTML = `This group has <b>${mine.length} connected utility bills</b> — select which one bills this offtaker:`;
    showUtilityPicker(wrap, usel, mine, false, arrId);
  }

  // Fill + reveal the offtaker-bill picker. `needPick` prepends a placeholder so
  // the operator must choose explicitly (used when no account is linked to the
  // group yet); the prior pick survives a repaint. The subtext names the chosen
  // group (Bruce's copy): "<Group> group has multiple participants. …"
  function showUtilityPicker(wrap, usel, accts, needPick, arrId) {
    if (!wrap || !usel) return;
    const prev = usel.value;
    usel.innerHTML = (needPick ? `<option value="">Choose a utility account…</option>` : "") +
      accts.map(a => `<option value="${a.utility_account_id}">${esc(billLabel(a))}</option>`).join("");
    if (prev && accts.some(a => String(a.utility_account_id) === String(prev))) usel.value = prev;
    const hint = $("#rbmUtilHint");
    if (hint) {
      const arr = (ARRAYS || []).find(x => String(x.id) === String(arrId));
      hint.textContent = (arr && arr.name ? arr.name + " group" : "This group") +
        " has multiple participants. Your selection here should be the utility account from this dropdown list.";
    }
    wrap.hidden = false;
  }

  // Human label for a utility account in the bill line / offtaker-bill picker:
  // "Starlake · GMP acct 43210 · 12 bills · latest 2026-06". Name prefers the
  // operator's nickname, then the linked array's name; the account number is
  // always shown so same-named accounts stay tellable-apart.
  function billLabel(a) {
    const prov = (a.provider || "gmp").toLowerCase();
    const provTag = prov === "gmp" ? "GMP" : prov.toUpperCase();
    const who = a.nickname || a.array_name;
    const acctNo = `${provTag} acct ${a.account_number || "?"}`;
    const name = who ? `${who} · ${acctNo}` : acctNo;
    const bills = a.has_bill
      ? ` · ${a.bill_count || 0} bill${a.bill_count === 1 ? "" : "s"}${a.latest_period_label ? " · latest " + a.latest_period_label : ""}`
      : " · no bill on file yet";
    return name + bills;
  }

  let ADD_MODE = "manual";   // "manual" | "upload" — active tab in the add panel
  function renderManual() {
    const host = $("#" + MANUAL_HOST_ID);
    if (!host) return;
    if (!MANUAL_OPEN) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = `
      <div class="rep-card rb-manual-form rb-add-panel">
        <div class="rb-add-head">
          <h3>New offtaker</h3>
          <div class="rb-add-tabs" role="tablist">
            <button type="button" data-addmode="manual" class="${ADD_MODE === "manual" ? "on" : ""}">Type it in</button>
            <button type="button" data-addmode="upload" class="${ADD_MODE === "upload" ? "on" : ""}">Upload a spreadsheet</button>
          </div>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbmCancel" type="button">Cancel</button>
        </div>
        <p class="rb-add-sub">${ADD_MODE === "manual"
          ? "Pick the <b>net meter group</b> your offtaker participates in — we resolve the utility bill it invoices from (the paper bill, never inverter data) and bill them for their share of it."
          : "Already bill in your own spreadsheet? Drop it and we'll keep invoicing in <b>that exact format</b> every cycle."}</p>

        <div id="rbAddManual" ${ADD_MODE === "manual" ? "" : "hidden"}>
          <!-- Required-field marking (Bruce C5): .req mirrors saveManual's actual
               validation — group, name, share %, email, and the bill pick when its
               picker is visible. Everything else saves blank, so it stays clear. -->
          <p class="rb-req-legend">Marked fields are required — everything else is optional.</p>
          <div class="rb-mform-grid">
            <label class="rep-fld req"><span class="rl">Net Meter Group</span>
              <select id="rbmArray"><option value="">Loading arrays…</option></select>
              <span class="rb-fld-hint">The array in which your offtaker participates.</span>
              <span class="rb-arr-billline" id="rbmBillLine"></span>
              <label class="rep-fld rb-arr-override req" id="rbmUtilityWrap" hidden><span class="rl">Select your offtaker's utility bill</span>
                <select id="rbmUtility"><option value="">Choose a utility account…</option></select>
                <span class="rb-fld-hint" id="rbmUtilHint">This group has multiple participants. Your selection here should be the utility account from this dropdown list.</span></label></label>
            <label class="rep-fld req"><span class="rl">Offtaker name</span>
              <input type="text" id="rbmName" placeholder="e.g. Sunnybrook Apartments"></label>
            <!-- Money cluster (Bruce C5): share → rate → discount → cross-check read
                 as one block — "get the solar credit rate right next to or below the
                 share of array". -->
            <label class="rep-fld req"><span class="rl">Expected share of array's net meter group (%)</span>
              <input type="number" id="rbmPct" min="0.01" max="100" step="0.001" placeholder="e.g. 24.783"></label>
            <!-- Solar credit rate (Bruce C6): NOT an input for bill-scraped utilities.
                 GMP bills carry their own net-metering credit rate, so the invoice
                 always prices from the bill — the old manual field was an override
                 that read as required data entry. This slot is provider-aware
                 (paintRateField): GMP/unknown → a read-only "read from the bill"
                 line; VEC/SmartHub (whose portals publish no usable rate) → the
                 manual $/kWh input, which those offtakers genuinely need. -->
            <label class="rep-fld rbm-rate-slot" id="rbmRateSlot"></label>
            <label class="rep-fld"><span class="rl">Discount (% off solar credit rate)</span>
              <input type="number" id="rbmRate" min="0" max="99" step="1" placeholder="blank = use my default">
              <span class="rb-fld-hint">Leave blank to use your default discount (10% off).</span></label>
            <label class="rep-fld"><span class="rl">Share for accuracy cross-check (%)
                <span class="rb-info" tabindex="0" title="The offtaker's GMP allocation share of the array's group excess — used by the Bill accuracy check to catch mis-allocations. DISTINCT from the expected-share field above (which is the billing multiplier). Leave blank to reuse the billing share.">ⓘ</span></span>
              <input type="number" id="rbmSharePct" min="0.01" max="100" step="0.001" placeholder="blank = same as billing share">
              <span class="rb-fld-hint">Optional. Drives the bill-accuracy cross-check only — not the invoice amount.</span></label>
            <label class="rep-fld"><span class="rl">Commissioning Date</span>
              <input type="date" id="rbmCommDate" min="1990-01-01" max="${todayISO()}">
              <span class="rb-fld-hint" id="rbmRateHint">The array's in-service date — sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).</span></label>
            <label class="rep-fld"><span class="rl">Starting invoice #</span>
              <input type="number" id="rbmInvStart" min="0" max="9999999" step="1" placeholder="blank = date-based">
              <span class="rb-fld-hint">Optional. Seeds sequential invoice numbering; each send adds 1.</span></label>
            <label class="rep-fld req"><span class="rl">Client email</span>
              <input type="email" id="rbmEmail" placeholder="offtaker@example.com"></label>
          </div>
          <div class="rb-controls">
            <div class="rb-ctl">
              <span class="rl">When a report is ready</span>
              <div class="rb-seg rb-slider" id="rbmDelivery">
                <button type="button" data-v="approval" class="on">Draft for my approval</button>
                <button type="button" data-v="auto">Auto-send</button>
              </div>
            </div>
            <div class="rb-ctl">
              <span class="rl">Cadence</span>
              <div class="rb-seg" id="rbmCadence">
                <button type="button" data-v="monthly" class="on">Monthly</button>
                <button type="button" data-v="quarterly">Quarterly</button>
              </div>
            </div>
          </div>
          <p class="rb-autosend-note" id="rbmAutoNote" hidden>⚡ <b>Auto-send</b> will email each invoice
             to your offtaker automatically — under <b>your name</b>, replies to your email, no Array Operator branding.
             It only fires once a real utility bill for the period has landed. <b>Real sends to real customers are
             still gated</b> while we prove it out on demo data — until then Auto-send previews on demo data and holds
             real invoices for your approval.</p>
          <p class="rb-bcc-note">📩 Every invoice email sent to an offtaker is automatically
             <b>BCC'd to your email</b> — so you always see exactly what they received.</p>
          <div class="rb-actions">
            <button class="ao-btn ao-btn-primary rb-save" id="rbmSave" type="button">Add offtaker</button>
            <span class="rb-status" id="rbmStatus"></span>
          </div>
        </div>

        <div id="rbAddUpload" ${ADD_MODE === "upload" ? "" : "hidden"}>
          <div class="rb-layout">
            <div class="rb-col-form">
              <div class="rb-upload" id="rbUpload">
                <label class="rb-drop" id="rbDrop">
                  <input type="file" id="rbFile" accept=".xlsx,.xls" hidden>
                  <span class="rb-drop-ico">⬆</span>
                  <span class="rb-drop-main">Choose a spreadsheet or drop it here</span>
                  <span class="rb-drop-sub">.xlsx — up to 8 MB</span>
                </label>
                <p class="rb-sample-hint">Not sure what to upload?
                  <a href="/sample-billing.xlsx" download="sample-billing.xlsx" class="rb-sample-link">
                    Download a sample billing spreadsheet</a>, then drop it back here to
                  see exactly how matching works.</p>
                <div class="rb-status" id="rbStatus"></div>
              </div>
              <div id="rbPreview"></div>
            </div>
            <aside class="rb-col-doc" id="rbDocPane"></aside>
          </div>
        </div>
      </div>`;

    // Tab switching within the add panel.
    host.querySelectorAll(".rb-add-tabs button").forEach(b => b.onclick = () => {
      ADD_MODE = b.getAttribute("data-addmode");
      renderManual();
    });
    $("#rbmCancel").onclick = () => { MANUAL_OPEN = false; PENDING = null; renderManual(); };

    if (ADD_MODE === "manual") {
      wireSegments(host);
      // Reveal the auto-send explanation the moment the operator picks Auto-send.
      const autoNote = $("#rbmAutoNote"), dseg = $("#rbmDelivery");
      if (dseg) dseg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        if (autoNote) autoNote.hidden = b.getAttribute("data-v") !== "auto";
      }));
      $("#rbmSave").onclick = saveManual;
      // Commissioning date → live expected-GMP-rate helper next to the rate fields.
      const commDefHint = "The array's in-service date — sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).";
      wireCommissioningDateHint($("#rbmCommDate"), $("#rbmRateHint"), commDefHint);
      // When an array is picked, surface its SAVED commissioning date (if any) so
      // the operator sees — and can correct — exactly what the rate helper uses.
      // A hand-typed date survives array switches; prefill never clobbers it.
      const commArrSel = $("#rbmArray"), commDateEl = $("#rbmCommDate");
      if (commArrSel && commDateEl) {
        commDateEl.addEventListener("input", () => { commDateEl.dataset.userEdited = "1"; });
        commArrSel.addEventListener("change", () => {
          if (commDateEl.dataset.userEdited) return;
          prefillCommissioningDate(commArrSel.value, commDateEl, $("#rbmRateHint"), commDefHint, true);
        });
      }
      // Array-FIRST flow: the operator picks the ARRAY, and we resolve which
      // utility bill it invoices from. The utility <select> is now an OVERRIDE,
      // shown only when the chosen array has more than one connected bill.
      wireArrayFirst();
      // Solar-credit-rate slot: paint the zero state now, and re-resolve whenever
      // the override utility pick changes (an array change repaints via
      // resolveArrayBills → paintRateField). The <select> element persists across
      // option refills, so one listener is enough.
      paintRateField();
      const rateUsel = $("#rbmUtility");
      if (rateUsel) rateUsel.addEventListener("change", paintRateField);
    } else {
      // Upload path: wire the dropzone + paint the live doc-preview placeholder.
      wireUpload();
      renderDoc();
    }
  }

  async function saveManual() {
    const st = $("#rbmStatus");
    const name = $("#rbmName").value.trim();
    const arrayId = $("#rbmArray") ? $("#rbmArray").value : "";
    // The utility <select> is now an OVERRIDE — only meaningful (and visible) when
    // the chosen array has multiple connected bills. The backend resolves the bill
    // from array_id; we pass utility_account_id ONLY when the operator overrode.
    const utilWrap = $("#rbmUtilityWrap");
    const overrode = utilWrap && !utilWrap.hidden;
    const utilityId = overrode && $("#rbmUtility") ? $("#rbmUtility").value : "";
    const pctRaw = $("#rbmPct").value.trim();
    const rateRaw = $("#rbmRate").value.trim();
    const creditRateRaw = $("#rbmCreditRate") ? $("#rbmCreditRate").value.trim() : "";
    const sharePctRaw = $("#rbmSharePct") ? $("#rbmSharePct").value.trim() : "";
    const invStartRaw = $("#rbmInvStart") ? $("#rbmInvStart").value.trim() : "";
    const commDateRaw = $("#rbmCommDate") ? $("#rbmCommDate").value.trim() : "";
    // The "Send to" slider was removed — offtaker invoices go to the offtaker and
    // the operator is BCC'd on every send (so they always see what was received).
    const mode = "to_client";
    const clientEmail = $("#rbmEmail").value.trim();
    if (!arrayId) { st.className = "rb-status rb-err"; st.textContent = "Pick which net meter group this offtaker draws from."; return; }
    // Block save only when the tenant has NO utility accounts at all (nothing to
    // invoice from). A group with no LINKED account is fine — the picker offered
    // the full account list and the explicit pick below carries the binding.
    const arrAccts = (ARR_UTIL_ACCTS || []).filter(a => String(a.array_id) === String(arrayId));
    if (!arrAccts.length && !(ARR_UTIL_ACCTS || []).length) {
      st.className = "rb-status rb-err";
      st.textContent = "This group has no utility bills yet — link your utility before invoicing it.";
      return;
    }
    if (overrode && !utilityId) {
      st.className = "rb-status rb-err";
      st.textContent = arrAccts.length
        ? "Pick which of this group's bills to invoice from."
        : "Pick your offtaker's utility account so we know which bill to invoice from.";
      return;
    }
    if (!name) { st.className = "rb-status rb-err"; st.textContent = "Enter the offtaker's name."; return; }
    const pctNum = Number(pctRaw);
    if (!pctRaw || isNaN(pctNum) || pctNum <= 0 || pctNum > 100) {
      st.className = "rb-status rb-err"; st.textContent = "Enter their share as a percent between 0 and 100."; return;
    }
    let rateNum = null;
    if (rateRaw !== "") {
      rateNum = Number(rateRaw);
      if (isNaN(rateNum) || rateNum < 0 || rateNum >= 100) {
        st.className = "rb-status rb-err"; st.textContent = "Discount must be a number 0–99 (% off), or blank."; return;
      }
    }
    let creditRateNum = null;
    if (creditRateRaw !== "") {
      creditRateNum = Number(creditRateRaw);
      if (isNaN(creditRateNum) || creditRateNum < 0) {
        st.className = "rb-status rb-err"; st.textContent = "Solar credit rate must be a number ≥ 0 ($/kWh), or blank."; return;
      }
    }
    let sharePctNum = null;
    if (sharePctRaw !== "") {
      sharePctNum = Number(sharePctRaw);
      if (isNaN(sharePctNum) || sharePctNum <= 0 || sharePctNum > 100) {
        st.className = "rb-status rb-err"; st.textContent = "Cross-check share must be a percent between 0 and 100, or blank."; return;
      }
    }
    let invStartNum = null;
    if (invStartRaw !== "") {
      invStartNum = Number(invStartRaw);
      if (isNaN(invStartNum) || invStartNum < 0 || !Number.isInteger(invStartNum) || invStartNum > 9999999) {
        st.className = "rb-status rb-err"; st.textContent = "Starting invoice # must be a whole number 0–9999999, or blank."; return;
      }
    }
    let commDateVal = null;
    if (commDateRaw !== "") {
      if (!isValidCommissioningDate(commDateRaw)) {
        st.className = "rb-status rb-err"; st.textContent = "Commissioning date must be between Jan 1, 1990 and today, or blank."; return;
      }
      commDateVal = commDateRaw;
    }
    if ((mode === "to_client" || mode === "to_both") && !clientEmail) {
      st.className = "rb-status rb-err"; st.textContent = "Add the client's email to send to them."; return;
    }
    st.className = "rb-status rb-busy"; st.textContent = "Adding offtaker…";
    const fd = new FormData();                       // no file → manual path
    fd.append("customer_name", name);
    fd.append("array_id", String(arrayId));              // array-FIRST: backend resolves the bill from the array
    if (utilityId) fd.append("utility_account_id", utilityId);  // only when the operator overrode the bill
    fd.append("allocation_pct", String(pctNum / 100));   // backend wants a fraction in (0,1]
    if (rateNum !== null) fd.append("discount_pct", String(rateNum / 100));
    if (creditRateNum !== null) fd.append("net_rate_per_kwh", String(creditRateNum));
    if (sharePctNum !== null) fd.append("array_share_pct", String(sharePctNum / 100));  // cross-check share, fraction
    if (invStartNum !== null) fd.append("invoice_number_start", String(invStartNum));
    fd.append("cadence", segValue("rbmCadence") || "monthly");
    fd.append("delivery_mode", segValue("rbmDelivery") || "approval");
    fd.append("send_mode", mode);
    fd.append("client_email", clientEmail);
    fd.append("formats", JSON.stringify(["pdf"]));
    try {
      const r = await fetch(API + "/subscriptions", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        st.className = "rb-status rb-err";
        st.textContent = (data && data.detail) ? data.detail : "Couldn't add (HTTP " + r.status + ").";
        return;
      }
      // The commissioning date sets the array's in-service date (feeds the GMP
      // rate regime, day-accurate at the 11-year boundary). Best-effort: the
      // offtaker is already created; a failure here shouldn't block it.
      const newArrayId = (data.subscription && data.subscription.array_id) || arrayId;
      if (commDateVal !== null && newArrayId != null) {
        try {
          await fetch(API + "/arrays/" + newArrayId, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ first_connect_date: commDateVal }),
          });
          _SETUP_ARRAYS = null;   // the accordion prefill cache is now stale
        } catch (e) { /* non-fatal — offtaker was created */ }
      }
      MANUAL_OPEN = false;
      renderManual();
      if (MANUAL_AFTER_ADD) await MANUAL_AFTER_ADD();
      else await refreshList();
    } catch (e) {
      st.className = "rb-status rb-err"; st.textContent = "Network error while adding.";
    }
  }

  // ---- bulk offtaker import — upload → REVIEW & CORRECT → commit -------------
  // The heart of "flawless" import: the operator uploads a workbook (.xlsx/.csv),
  // the backend dry-runs a fuzzy ARRAY match per row, and we render a review table
  // where every array match is a CORRECTABLE dropdown with a confidence badge. No
  // medium/none match is ever auto-imported — the operator must confirm the guess.
  let BULK_OPEN = false;
  let BULK_PREVIEW = null;     // the raw dry-run payload {summary, arrays, rows}
  let BULK_ARRAYS = [];        // the pick-list: [{array_id, array_name, utility_account_id, utility_label, provider, has_bill}]
  let BULK_ROWS = [];          // editable per-offtaker state (persists corrections across re-renders)
  let BULK_FILE = null;        // the File we previewed (kept for a re-upload / re-parse-with-override)
  // Two-phase review: "columns" = confirm which sheet column is which of OUR fields
  // (Phase 1, NEW), "rows" = the per-offtaker array-match review (Phase 2, existing).
  let BULK_PHASE = "columns";
  let DETECTION = null;        // the backend `detection` block from the first dry-run
  let COLUMN_MAP = {};         // OUR field -> column index (or null = "not in my sheet")

  // OUR importable fields, in display order. `req` = required (Continue is gated on
  // all three being mapped). Order/labels are the operator-facing column meanings.
  const BULK_FIELDS = [
    { key: "array_name",     label: "Array",          req: true  },
    { key: "offtaker_name",  label: "Offtaker name",  req: true  },
    { key: "allocation_pct", label: "Share %",        req: true  },
    { key: "email",          label: "Email",          req: false },
    { key: "discount_pct",   label: "Discount %",     req: false },
    { key: "net_rate",       label: "Rate ($/kWh)",   req: false },
    { key: "account_number", label: "Account #",      req: false },
  ];

  // 0 → "A", 1 → "B", … 26 → "AA" — spreadsheet-style column letters for friendliness.
  function colLetter(idx) {
    if (idx == null || idx < 0) return "";
    let n = idx, s = "";
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  // Index the array pick-list by array_id for O(1) lookups on dropdown change.
  function bulkArrayById(id) {
    return BULK_ARRAYS.find(a => String(a.array_id) === String(id)) || null;
  }
  function bulkArrayLabel(a) {
    const base = a.array_name || ("Array " + a.array_id);
    return a.utility_label ? `${base} · ${a.utility_label}` : base;
  }

  // Derive a per-row status from the CURRENT edited state (not the server's — the
  // operator may have corrected it). Blocked = missing required (name/array/pct);
  // Needs review = no utility bill for the chosen array OR a soft (medium/none)
  // confidence match the operator hasn't corrected; else Ready.
  // Discount is stored as a fraction; valid range mirrors saveManual (0–99% off, so
  // fraction [0, 1)). Anything the backend would 400 on becomes an inline error here so
  // the "Ready" count / Import button never include a row the backend will reject.
  function bulkDiscountError(row) {
    if (row.discount_pct == null) return "";
    const d = Number(row.discount_pct);
    if (isNaN(d) || d < 0 || d >= 1) return "Discount must be 0–99% (or blank).";
    return "";
  }
  function bulkRowStatus(row) {
    if (!row.offtaker_name || !row.array_id || !(row.allocation_pct > 0)) return "blocked";
    const a = bulkArrayById(row.array_id);
    if (!a || !a.utility_account_id || a.has_bill === false) return "needs_review";
    // Discount outside saveManual's 0–99 band → make the operator fix it before import.
    if (bulkDiscountError(row)) return "needs_review";
    // Soft match the operator left on the guessed array → make them look at it.
    if ((row.confidence === "medium" || row.confidence === "none") && !row._confirmed) return "needs_review";
    return "ready";
  }
  function bulkCounts() {
    let ready = 0, needs = 0, blocked = 0;
    BULK_ROWS.forEach(r => {
      const s = bulkRowStatus(r);
      if (s === "ready") ready++; else if (s === "needs_review") needs++; else blocked++;
    });
    return { ready, needs, blocked, total: BULK_ROWS.length };
  }

  function renderBulkImport() {
    const host = $("#rbBulkHost");
    if (!host) return;
    if (!BULK_OPEN) { host.innerHTML = ""; bulkResetState(); return; }

    if (!BULK_PREVIEW) {
      // ── Step 1: drop the workbook ──
      host.innerHTML = `
        <div class="rep-card rb-manual-form rb-add-panel">
          <div class="rb-add-head">
            <h3>Bulk import offtakers</h3>
            <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkCancel" type="button">Cancel</button>
          </div>
          <p class="rb-add-sub">One row per offtaker — <b>Array</b>, <b>Offtaker</b>, <b>Share %</b>,
            plus <b>Email</b>/<b>Discount</b> if you have them. We'll match each row to an array and
            let you review + correct every match before creating anything.</p>
          <div class="rb-upload" id="rbBulkDrop">
            <label class="rb-drop" id="rbBulkDropZone">
              <input type="file" id="rbBulkFile" accept=".csv,.xlsx" hidden>
              <span class="rb-drop-ico">⬆</span>
              <span class="rb-drop-main">Choose a spreadsheet or drop it here</span>
              <span class="rb-drop-sub">.xlsx or .csv — exported from Excel or Google Sheets</span>
            </label>
            <p class="rb-sample-hint">Not sure of the layout?
              <a href="#" class="rb-sample-link" id="rbBulkTemplate">Download the template</a>
              — fill it in and drop it back here.</p>
            <div class="rb-status" id="rbBulkStatus"></div>
          </div>
        </div>`;
      $("#rbBulkCancel").onclick = () => { BULK_OPEN = false; renderBulkImport(); };
      const tmpl = $("#rbBulkTemplate");
      if (tmpl) tmpl.onclick = (e) => { e.preventDefault(); downloadOfftakerTemplate(); };
      const input = $("#rbBulkFile"), drop = $("#rbBulkDropZone");
      const go = (f) => { if (f) bulkPreviewFile(f); };
      input.addEventListener("change", () => go(input.files[0]));
      ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.add("rb-drop-over");
      }));
      ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.remove("rb-drop-over");
      }));
      drop.addEventListener("drop", e => go(e.dataTransfer && e.dataTransfer.files[0]));
      return;
    }

    // ── Step 2: two-phase review — columns first, then per-row array match ──
    if (BULK_PHASE === "columns" && DETECTION) renderColumnMapping();
    else renderBulkReview();
  }

  // Clear ALL bulk state (upload, preview, phase, detection, column map) in one place.
  function bulkResetState() {
    BULK_PREVIEW = null; BULK_ROWS = []; BULK_ARRAYS = []; BULK_FILE = null;
    BULK_PHASE = "columns"; DETECTION = null; COLUMN_MAP = {};
  }

  // The pick-list <select> options (shared by every row). `sel` marks the chosen id.
  function bulkArrayOptions(sel) {
    return `<option value=""${sel ? "" : " selected"}>— pick an array —</option>` +
      BULK_ARRAYS.map(a =>
        `<option value="${esc(String(a.array_id))}"${String(a.array_id) === String(sel) ? " selected" : ""}>${esc(bulkArrayLabel(a))}</option>`
      ).join("");
  }
  // Confidence badge next to the array picker. exact/high = blue check (trust the
  // guess), medium = amber "check this", none = red "pick the array".
  function bulkConfBadge(row) {
    const a = bulkArrayById(row.array_id);
    const noBill = a && (a.utility_account_id == null || a.has_bill === false);
    if (noBill) return `<span class="rb-conf rb-conf-warn" title="This array has no connected utility bill yet.">no bill yet</span>`;
    const c = row._confirmed ? "high" : (row.confidence || "none");
    if (c === "exact" || c === "high") return `<span class="rb-conf rb-conf-ok" title="Confident match.">✓</span>`;
    if (c === "medium") return `<button type="button" class="rb-conf rb-conf-warn rb-conf-confirm" title="Low-confidence match — click to confirm this is the right array, or pick a different one.">check this ✓</button>`;
    return `<span class="rb-conf rb-conf-bad" title="We couldn't confidently match this — pick the array.">pick the array</span>`;
  }
  function bulkStatusPill(status) {
    if (status === "ready") return `<span class="rb-pill rb-pill-ok">Ready</span>`;
    if (status === "needs_review") return `<span class="rb-pill rb-pill-warn">Needs review</span>`;
    return `<span class="rb-pill rb-pill-bad">Blocked</span>`;
  }

  // ============================================================================
  // PHASE 1 — column-mapping review (NEW)
  // Operators upload spreadsheets in ANY layout. The backend detects which column
  // is which of OUR fields; here the operator confirms/corrects that mapping on a
  // live-tinted preview of their own data before we parse rows.
  // ============================================================================

  // Options for a field's column <select>: every sheet column ("{header}" (col A)),
  // plus a "not in my sheet" escape. `sel` = the currently-assigned index (or null).
  function colOptions(sel) {
    const headers = (DETECTION && DETECTION.headers) || [];
    const opts = headers.map((h, idx) => {
      const label = `"${(h == null || h === "") ? "(blank)" : h}" (col ${colLetter(idx)})`;
      return `<option value="${idx}"${String(idx) === String(sel) ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    const none = `<option value=""${sel == null ? " selected" : ""}>— not in my sheet —</option>`;
    return opts + none;
  }

  // Confidence/requirement badge for a field row. Required + unmapped → red "needed".
  // Otherwise: high=blue check, medium=amber "check this", low/none-but-mapped=grey.
  function colFieldBadge(field) {
    const idx = COLUMN_MAP[field.key];
    if (idx == null) {
      return field.req
        ? `<span class="rb-col-badge rb-conf rb-conf-bad" title="Required — pick the column that holds this.">needed</span>`
        : `<span class="rb-col-badge rb-col-skip" title="Not in your sheet — that's fine.">not mapped</span>`;
    }
    // Only trust the detected confidence while the operator keeps the detected column;
    // a hand-picked column is an explicit choice → treat as confident.
    const det = (DETECTION && DETECTION.column_map && DETECTION.column_map[field.key]) || null;
    const kept = det && det.index === idx;
    const conf = kept ? detConfidence(field.key) : "high";
    if (conf === "high") return `<span class="rb-col-badge rb-conf rb-conf-ok" title="Confident match.">✓</span>`;
    if (conf === "medium") return `<span class="rb-col-badge rb-conf rb-conf-warn" title="Medium-confidence match — worth a glance.">check this</span>`;
    return `<span class="rb-col-badge rb-col-pick" title="Low confidence — confirm this is the right column.">pick a column</span>`;
  }

  // Which OUR-field (if any) currently owns a given sheet column index → drives the
  // live preview tint so the operator SEES the mapping on their own data.
  function fieldForColumn(idx) {
    for (const f of BULK_FIELDS) if (COLUMN_MAP[f.key] === idx) return f;
    return null;
  }

  // Required fields still without a column → the reasons Continue stays disabled.
  function unmappedRequired() {
    return BULK_FIELDS.filter(f => f.req && COLUMN_MAP[f.key] == null);
  }

  function renderColumnMapping() {
    const host = $("#rbBulkHost");
    const headers = (DETECTION && DETECTION.headers) || [];
    const preview = (DETECTION && DETECTION.preview) || [];
    const via = (DETECTION && DETECTION.via) || "";
    const viaNote = via === "content" ? "matched by your data"
      : via === "llm" ? "matched by AI"
      : via === "mixed" ? "matched by headers + data"
      : via === "heuristic" ? "matched by column names" : "";
    const sheetNote = (DETECTION && DETECTION.sheet)
      ? `Sheet <b>${esc(DETECTION.sheet)}</b>${DETECTION.header_row != null ? `, header on row ${DETECTION.header_row + 1}` : ""}. ` : "";
    const warnings = (DETECTION && DETECTION.warnings) || [];

    // Field-mapping rows.
    const fieldRows = BULK_FIELDS.map(f => {
      const idx = COLUMN_MAP[f.key];
      return `<tr class="rb-col-frow${f.req ? " rb-col-req" : ""}${f.req && idx == null ? " rb-col-missing" : ""}" data-field="${f.key}">
        <td class="rb-col-flabel">${esc(f.label)}${f.req ? ` <span class="rb-col-star" title="Required">*</span>` : ""}</td>
        <td class="rb-col-fsel">
          <select class="rb-col-select" data-field="${f.key}">${colOptions(idx)}</select>
        </td>
        <td class="rb-col-fbadge">${colFieldBadge(f)}</td>
      </tr>`;
    }).join("");

    // Live-tinted preview: header row + up to 5 data rows, columns assigned to a
    // field get that field's tint so the operator confirms on their own data.
    const previewHead = headers.map((h, idx) => {
      const f = fieldForColumn(idx);
      const tag = f ? `<span class="rb-col-ptag">${esc(f.label)}</span>` : "";
      return `<th class="rb-col-pth${f ? " rb-col-pon" : ""}" data-col="${idx}">
        <span class="rb-col-pcol">col ${colLetter(idx)}</span>
        <span class="rb-col-phdr">${(h == null || h === "") ? "&nbsp;" : esc(String(h))}</span>${tag}</th>`;
    }).join("");
    const previewBody = preview.map(cells => {
      const tds = headers.map((h, idx) => {
        const f = fieldForColumn(idx);
        const v = (cells && cells[idx] != null) ? String(cells[idx]) : "";
        return `<td class="rb-col-ptd${f ? " rb-col-pon" : ""}" data-col="${idx}">${esc(v)}</td>`;
      }).join("");
      return `<tr>${tds}</tr>`;
    }).join("");

    const missing = unmappedRequired();
    const canContinue = missing.length === 0;
    const gateNote = canContinue ? ""
      : `<span class="rb-col-gate">Pick a column for: ${missing.map(f => esc(f.label)).join(", ")}</span>`;

    host.innerHTML = `
      <div class="rep-card rb-manual-form rb-add-panel">
        <div class="rb-add-head">
          <h3>We read your spreadsheet</h3>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkCancel" type="button">Cancel</button>
        </div>
        <p class="rb-add-sub">${sheetNote}Detected the header row and mapped your columns — confirm or fix
          each one, then continue.${viaNote ? ` <span class="rb-col-via">(${esc(viaNote)})</span>` : ""}</p>
        ${warnings.length ? `<div class="rb-col-warns">⚠ ${warnings.map(w => esc(String(w))).join(" · ")}</div>` : ""}
        <div class="rb-col-grid">
          <div class="rb-col-mapcard">
            <table class="rb-col-maptable">
              <thead><tr><th>Our field</th><th>Your column</th><th></th></tr></thead>
              <tbody>${fieldRows}</tbody>
            </table>
          </div>
          <div class="rb-col-prevcard">
            <div class="rb-col-prevlabel">Your data — highlighted columns are the ones you've assigned</div>
            <div class="rb-col-prevwrap">
              <table class="rb-col-prevtable">
                <thead><tr>${previewHead}</tr></thead>
                <tbody>${previewBody || `<tr><td class="rb-col-prevempty">No preview rows.</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="rb-actions">
          <button class="ao-btn ao-btn-ghost" id="rbColRestart" type="button">↺ Upload a different file</button>
          <button class="ao-btn ao-btn-primary rb-save" id="rbColContinue" type="button" ${canContinue ? "" : "disabled"}>Looks right — continue →</button>
          ${gateNote}
          <span class="rb-status" id="rbColStatus"></span>
        </div>
      </div>`;

    $("#rbBulkCancel").onclick = () => { BULK_OPEN = false; renderBulkImport(); };
    $("#rbColRestart").onclick = () => { bulkResetState(); renderBulkImport(); };

    // Dropdown change → update COLUMN_MAP, then re-render so the badges + preview
    // tint update live. Enforce ONE column per field: if the operator assigns a
    // column already owned by another field, steal it (clear the other) so tints
    // never double-paint and the re-parse map stays unambiguous.
    host.querySelectorAll(".rb-col-select").forEach(sel => {
      sel.onchange = () => {
        const field = sel.getAttribute("data-field");
        const val = sel.value === "" ? null : Number(sel.value);
        if (val != null) {
          BULK_FIELDS.forEach(f => { if (f.key !== field && COLUMN_MAP[f.key] === val) COLUMN_MAP[f.key] = null; });
        }
        COLUMN_MAP[field] = val;
        renderColumnMapping();
      };
    });

    $("#rbColContinue").onclick = () => {
      if (unmappedRequired().length) return;   // gate: never continue with a required field unmapped
      // Send only the fields the operator kept (omit "not in my sheet" fields).
      const override = {};
      BULK_FIELDS.forEach(f => { if (COLUMN_MAP[f.key] != null) override[f.key] = COLUMN_MAP[f.key]; });
      bulkPreviewFile(BULK_FILE, override, $("#rbColStatus"));
    };
  }

  // Compact "Columns: Array=…, Offtaker=…, %=…  [change]" strip shown atop Phase 2 so
  // the operator can always see (and reopen) the mapping they confirmed.
  function bulkColumnSummary() {
    if (!DETECTION) return "";
    const headers = (DETECTION && DETECTION.headers) || [];
    const parts = BULK_FIELDS.filter(f => f.req || COLUMN_MAP[f.key] != null).map(f => {
      const idx = COLUMN_MAP[f.key];
      const col = (idx == null) ? "—" : `${esc(String(headers[idx] != null && headers[idx] !== "" ? headers[idx] : "col " + colLetter(idx)))}`;
      return `<span class="rb-col-sumpart"><b>${esc(f.label)}</b>=${col}</span>`;
    }).join(`<span class="rb-col-sumsep">·</span>`);
    return `<div class="rb-col-summary" id="rbColSummary">
      <span class="rb-col-sumhead">Columns:</span> ${parts}
      <button type="button" class="rb-col-sumchange" id="rbColChange">change</button>
    </div>`;
  }

  function renderBulkReview() {
    const host = $("#rbBulkHost");
    const c = bulkCounts();
    const rowHtml = BULK_ROWS.map((row, i) => {
      const status = bulkRowStatus(row);
      // 3-decimal percent (Bruce): 0.24783 → "24.783". A 1-decimal prefill would
      // silently truncate the stored share on the next edit+save of the row.
      const pctVal = row.allocation_pct != null ? (row.allocation_pct * 100).toFixed(3) : "";
      const discVal = row.discount_pct != null ? Math.round(row.discount_pct * 1000) / 10 : "";
      const errs = (row.errors || []).length ? `<div class="rb-rev-err">⚠ ${esc(row.errors.join("; "))}</div>` : "";
      return `<tr class="rb-rev-row rb-rev-${status}" data-i="${i}">
        <td class="rb-rev-name"><input type="text" class="rb-rev-in" data-f="offtaker_name" value="${esc(row.offtaker_name || "")}" placeholder="Offtaker name"></td>
        <td class="rb-rev-arr">
          <div class="rb-rev-arrbox">
            <select class="rb-rev-in rb-rev-arrsel" data-f="array_id">${bulkArrayOptions(row.array_id)}</select>
            ${bulkConfBadge(row)}
          </div>
          ${row.array_name_raw ? `<div class="rb-rev-raw">from your file: “${esc(row.array_name_raw)}”</div>` : ""}
          ${errs}
        </td>
        <td class="rb-rev-pct"><input type="number" class="rb-rev-in" data-f="allocation_pct" min="0.01" max="100" step="0.001" value="${pctVal}" placeholder="%"></td>
        <td class="rb-rev-email"><input type="email" class="rb-rev-in" data-f="email" value="${esc(row.email || "")}" placeholder="optional"></td>
        <td class="rb-rev-disc"><input type="number" class="rb-rev-in" data-f="discount_pct" min="0" max="99" step="0.1" value="${discVal}" placeholder="—"><div class="rb-rev-err rb-rev-discerr">${bulkDiscountError(row) ? "⚠ " + esc(bulkDiscountError(row)) : ""}</div></td>
        <td class="rb-rev-stat">${bulkStatusPill(status)}</td>
      </tr>`;
    }).join("");

    host.innerHTML = `
      <div class="rep-card rb-manual-form rb-add-panel">
        <div class="rb-add-head">
          <h3>Bulk import — review &amp; correct</h3>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkCancel" type="button">Cancel</button>
        </div>
        ${bulkColumnSummary()}
        <div class="rb-rev-summary" id="rbBulkSummary">
          <span class="rb-rev-sum-ok"><b>${c.ready}</b> ready</span>
          <span class="rb-rev-sum-sep">·</span>
          <span class="rb-rev-sum-warn"><b>${c.needs}</b> to review</span>
          <span class="rb-rev-sum-sep">·</span>
          <span class="rb-rev-sum-bad"><b>${c.blocked}</b> blocked</span>
        </div>
        <p class="rb-add-sub">Check every array match below. A blue ✓ is a confident match; amber
          <b>“check this”</b> and red <b>“pick the array”</b> need your eyes before importing. Rows with
          no connected bill can't be invoiced until you connect one.</p>
        <div class="rb-bulk-tablewrap">
          <table class="rb-bulk-table rb-rev-table">
            <thead><tr>
              <th>Offtaker</th><th>Net Meter Group</th><th>Share %</th><th>Email</th><th>Discount %</th><th>Status</th>
            </tr></thead>
            <tbody>${rowHtml}</tbody>
          </table>
        </div>
        <div class="rb-actions">
          <button class="ao-btn ao-btn-ghost" id="rbBulkBack" type="button">← Choose a different file</button>
          <button class="ao-btn ao-btn-primary rb-save" id="rbBulkConfirm" type="button"
                  ${c.ready ? "" : "disabled"}>Import ${c.ready} offtaker${c.ready === 1 ? "" : "s"}</button>
          <span class="rb-status" id="rbBulkStatus2"></span>
        </div>
      </div>`;

    $("#rbBulkCancel").onclick = () => { BULK_OPEN = false; renderBulkImport(); };
    $("#rbBulkBack").onclick = () => { bulkResetState(); renderBulkImport(); };
    $("#rbBulkConfirm").onclick = bulkCommitImport;

    // Reopen Phase 1 (column mapping) with the current DETECTION + COLUMN_MAP intact.
    const chg = $("#rbColChange");
    if (chg) chg.onclick = () => { BULK_PHASE = "columns"; renderBulkImport(); };

    // "check this ✓" — confirm a medium-confidence guess WITHOUT changing the
    // dropdown (a <select> fires no change event when re-picking the same value,
    // so agreeing with the guess needs its own affordance). Honesty preserved: the
    // operator still had to look and click, never a silent auto-accept.
    host.querySelectorAll(".rb-conf-confirm").forEach(btn => {
      const tr = btn.closest("tr");
      const i = Number(tr.getAttribute("data-i"));
      btn.onclick = () => { BULK_ROWS[i]._confirmed = true; renderBulkReview(); };
    });

    // Wire the editable fields — mutate BULK_ROWS in place so corrections persist
    // across re-renders, and re-render on array change (badge + status recompute).
    host.querySelectorAll(".rb-rev-in").forEach(el => {
      const tr = el.closest("tr");
      const i = Number(tr.getAttribute("data-i"));
      const f = el.getAttribute("data-f");
      if (f === "array_id") {
        el.onchange = () => {
          const row = BULK_ROWS[i];
          const newId = el.value ? el.value : null;
          // Operator picked an array by hand → treat it as confirmed (clears the
          // medium/none "needs review" flag), and snap its utility_account_id.
          if (newId && String(newId) !== String(row.array_id || "")) row._confirmed = true;
          row.array_id = newId;
          const a = bulkArrayById(newId);
          row.utility_account_id = a ? a.utility_account_id : null;
          renderBulkReview();                          // full re-render: badge + pill + summary
        };
      } else {
        // Text/number fields: update state live; refresh the row's pill + summary
        // without a full re-render so focus/caret isn't lost mid-typing.
        el.oninput = () => {
          const row = BULK_ROWS[i];
          const v = el.value.trim();
          if (f === "allocation_pct") row.allocation_pct = v === "" ? null : Number(v) / 100;
          else if (f === "discount_pct") row.discount_pct = v === "" ? null : Number(v) / 100;
          else row[f] = v;                             // offtaker_name / email
          refreshBulkRowPill(tr, i);
        };
      }
    });
  }

  // Live-update one row's status pill + row class + the summary strip (no re-render).
  function refreshBulkRowPill(tr, i) {
    const status = bulkRowStatus(BULK_ROWS[i]);
    tr.className = `rb-rev-row rb-rev-${status}`;
    const cell = tr.querySelector(".rb-rev-stat");
    if (cell) cell.innerHTML = bulkStatusPill(status);
    // Keep the inline discount error in sync without a full re-render (preserve caret).
    const discErrEl = tr.querySelector(".rb-rev-discerr");
    if (discErrEl) {
      const de = bulkDiscountError(BULK_ROWS[i]);
      discErrEl.textContent = de ? "⚠ " + de : "";
    }
    const c = bulkCounts();
    const sum = $("#rbBulkSummary");
    if (sum) sum.innerHTML =
      `<span class="rb-rev-sum-ok"><b>${c.ready}</b> ready</span>` +
      `<span class="rb-rev-sum-sep">·</span>` +
      `<span class="rb-rev-sum-warn"><b>${c.needs}</b> to review</span>` +
      `<span class="rb-rev-sum-sep">·</span>` +
      `<span class="rb-rev-sum-bad"><b>${c.blocked}</b> blocked</span>`;
    const btn = $("#rbBulkConfirm");
    if (btn) { btn.disabled = !c.ready; btn.textContent = `Import ${c.ready} offtaker${c.ready === 1 ? "" : "s"}`; }
  }

  // Dry-run the file. First call (no override) also lands the `detection` block and
  // drops us in Phase 1 (column mapping). A re-parse WITH `columnMap` (field→col-index)
  // re-POSTs the SAME file so the backend re-parses using the operator's confirmed
  // columns, then advances to Phase 2 (row review). `statusEl` lets the caller point
  // errors at whichever status line is on screen for the current phase.
  async function bulkPreviewFile(file, columnMap, statusEl) {
    BULK_FILE = file;
    const status = statusEl || $("#rbBulkStatus");
    const reparse = !!columnMap;
    if (status) {
      status.className = "rb-status rb-busy";
      status.textContent = reparse ? "Re-reading with your columns…" : ("Reading " + file.name + "…");
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (columnMap) fd.append("column_map", JSON.stringify(columnMap));
      const r = await fetch(API + "/subscriptions/bulk-import?dry_run=true", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (status) {
          status.className = "rb-status rb-err";
          status.textContent = (data && data.detail) ? data.detail : "Couldn't read that file (HTTP " + r.status + ").";
        }
        return;
      }
      BULK_PREVIEW = data;
      BULK_ARRAYS = (data.arrays || []).filter(a => a.array_id != null);
      // Seed the editable row state from the server's matches. Every correction the
      // operator makes lives here (not in the DOM) so re-renders never lose it.
      BULK_ROWS = (data.rows || []).map(r => ({
        offtaker_name: r.offtaker_name || "",
        array_name_raw: r.array_name_raw || "",
        array_id: r.matched_array_id != null ? r.matched_array_id : null,
        utility_account_id: r.matched_utility_account_id != null ? r.matched_utility_account_id : null,
        allocation_pct: r.allocation_pct != null ? r.allocation_pct : null,
        email: r.email || "",
        discount_pct: r.discount_pct != null ? r.discount_pct : null,
        confidence: r.confidence || "none",
        errors: r.errors || [],
        _confirmed: (r.confidence === "exact" || r.confidence === "high"),
      }));

      if (reparse) {
        // Operator confirmed columns → straight to the per-row array review.
        BULK_PHASE = "rows";
      } else if (data.detection) {
        // First read → seed the editable column map from the backend's guesses and
        // open Phase 1 so the operator can confirm/correct before we trust the rows.
        DETECTION = data.detection;
        COLUMN_MAP = seedColumnMap(DETECTION);
        BULK_PHASE = "columns";
      } else {
        // Backend didn't return a detection block (older contract) → skip to rows.
        DETECTION = null;
        BULK_PHASE = "rows";
      }
      renderBulkImport();
    } catch (e) {
      if (status) { status.className = "rb-status rb-err"; status.textContent = "Network error while reading the file."; }
    }
  }

  // Build COLUMN_MAP {field: index|null} from the backend's detected column_map.
  function seedColumnMap(det) {
    const cm = {}, dm = (det && det.column_map) || {};
    BULK_FIELDS.forEach(f => {
      const hit = dm[f.key];
      cm[f.key] = (hit && hit.index != null) ? hit.index : null;
    });
    return cm;
  }
  // The confidence the backend reported for a field's detected column ("high"|
  // "medium"|"low"|null). Only meaningful while the operator keeps the detected column.
  function detConfidence(fieldKey) {
    const dm = (DETECTION && DETECTION.column_map) || {};
    const hit = dm[fieldKey];
    return hit && hit.confidence ? hit.confidence : null;
  }

  // Commit: send ONLY the rows the operator hasn't left blocked/needs-review —
  // rows with a valid array_id + utility_account_id + positive pct.
  async function bulkCommitImport() {
    const st = $("#rbBulkStatus2");
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Importing…"; }
    const btn = $("#rbBulkConfirm"); if (btn) btn.disabled = true;
    const ready = BULK_ROWS.filter(r => bulkRowStatus(r) === "ready").map(r => ({
      offtaker_name: r.offtaker_name,
      array_id: r.array_id,
      utility_account_id: r.utility_account_id,
      allocation_pct: r.allocation_pct,
      email: r.email || null,
      discount_pct: r.discount_pct != null ? r.discount_pct : null,
    }));
    if (!ready.length) {
      if (st) { st.className = "rb-status rb-err"; st.textContent = "No rows are ready to import yet."; }
      if (btn) btn.disabled = false;
      return;
    }
    try {
      const body = {
        rows: ready,
        cadence: "monthly",
        delivery_mode: "approval",
      };
      const r = await fetch(API + "/subscriptions/bulk-commit", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (st) { st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Import failed (HTTP " + r.status + ")."; }
        if (btn) btn.disabled = false;
        return;
      }
      const created = data.created || 0;
      const failed = data.failed || [];
      const skipped = data.skipped || [];
      bulkToast(`Imported ${created} offtaker${created === 1 ? "" : "s"}`);
      // If nothing failed/skipped, close + refresh. Otherwise keep the panel open and
      // surface the failures inline so the operator can act on them.
      if (!failed.length && !skipped.length) {
        BULK_OPEN = false; bulkResetState();
        renderBulkImport();
        await refreshList();
        return;
      }
      await refreshList();
      renderBulkCommitResult(created, failed, skipped);
    } catch (e) {
      if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error during import."; }
      if (btn) btn.disabled = false;
    }
  }

  // Post-commit summary when some rows failed/skipped — shown IN PLACE of the review.
  function renderBulkCommitResult(created, failed, skipped) {
    const host = $("#rbBulkHost");
    const problem = failed.concat(skipped);
    const rows = problem.map(p =>
      `<tr class="rb-bulk-err"><td>${esc(p.offtaker_name || "—")}</td><td>${esc(p.error || p.reason || "skipped")}</td></tr>`
    ).join("");
    host.innerHTML = `
      <div class="rep-card rb-manual-form rb-add-panel">
        <div class="rb-add-head">
          <h3>Bulk import — done</h3>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkClose" type="button">Close</button>
        </div>
        <p class="rb-add-sub"><b>${created}</b> offtaker${created === 1 ? "" : "s"} imported.
          ${problem.length ? `<b>${problem.length}</b> couldn't be created — details below.` : ""}</p>
        ${problem.length ? `<div class="rb-bulk-tablewrap"><table class="rb-bulk-table">
          <thead><tr><th>Offtaker</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
        <div class="rb-actions">
          <button class="ao-btn ao-btn-primary rb-save" id="rbBulkClose2" type="button">Done</button>
        </div>
      </div>`;
    const close = () => { BULK_OPEN = false; bulkResetState(); renderBulkImport(); };
    $("#rbBulkClose").onclick = close;
    $("#rbBulkClose2").onclick = close;
  }

  // Lightweight self-contained toast (reports.js has no shared toast; command-center's
  // is module-private). Mirrors its look so the confirmation feels native.
  function bulkToast(msg) {
    let t = document.getElementById("rbToast");
    if (!t) {
      t = document.createElement("div"); t.id = "rbToast";
      t.setAttribute("style", "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9998;background:#0e1620;border:1px solid var(--line);color:var(--ink);padding:11px 16px;border-radius:11px;font-size:13px;box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;");
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = "1";
    clearTimeout(t._tm); t._tm = setTimeout(() => t.style.opacity = "0", 3200);
  }

  // Download the offtaker import template (.xlsx). The endpoint needs the Bearer
  // header, so we fetch → blob → object-URL rather than a plain <a download>.
  async function downloadOfftakerTemplate() {
    const status = $("#rbBulkStatus");
    try {
      const r = await fetch(API + "/offtaker-template.xlsx", { headers: authHeaders() });
      if (!r.ok) {
        if (status) { status.className = "rb-status rb-err"; status.textContent = "Couldn't fetch the template (HTTP " + r.status + ")."; }
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "offtaker-import-template.xlsx";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      if (status) { status.className = "rb-status rb-err"; status.textContent = "Network error fetching the template."; }
    }
  }

  // ---- match preview + schedule form ----------------------------------------
  function renderPreview(m) {
    const ci = m.computed_invoice || {};
    const warn = (m.warnings || []).length
      ? `<div class="rb-warn">${m.warnings.map(esc).join("<br>")}</div>` : "";
    const host = $("#rbPreview");
    host.innerHTML = `
      <div class="rep-card rb-preview">
        <span class="rep-eyebrow">Step 2 · Confirm &amp; schedule</span>
        <div class="rb-matchgrid">
          <div><span class="rb-k">Offtaker</span><span class="rb-v">${esc(m.customer.name || "—")}</span></div>
          <div><span class="rb-k">Billing model</span><span class="rb-v">${esc(MODEL_LABEL[m.billing_model] || m.billing_model)}</span></div>
          <div><span class="rb-k">Latest period</span><span class="rb-v">${esc(ci.period_start || "—")} → ${esc(ci.period_end || "—")}</span></div>
          <div><span class="rb-k">Generation</span><span class="rb-v">${fmt0(ci.kwh)} kWh</span></div>
          <div><span class="rb-k">Amount due</span><span class="rb-v rb-amt">${money(ci.amount_owed)}</span></div>
          <div><span class="rb-k">Billing rate</span><span class="rb-v">${m.billing_rate != null ? Math.round(m.billing_rate * 100) + "%" : "—"}</span></div>
        </div>
        ${warn}
        <div class="rb-controls">
          <div class="rb-ctl">
            <span class="rl">When a report is ready</span>
            <div class="rb-seg rb-slider" id="rbDelivery">
              <button type="button" data-v="approval" class="on">Draft for my approval</button>
              <button type="button" data-v="auto">Auto-send</button>
            </div>
          </div>
          <div class="rb-ctl">
            <span class="rl">Cadence</span>
            <div class="rb-seg" id="rbCadence">
              <button type="button" data-v="monthly" class="on">Monthly</button>
              <button type="button" data-v="quarterly">Quarterly</button>
            </div>
          </div>
          <div class="rb-ctl">
            <span class="rl">Send to</span>
            <div class="rb-seg rb-slider" id="rbMode">
              <button type="button" data-v="to_me" class="on">To me</button>
              <button type="button" data-v="to_client">To my client</button>
              <button type="button" data-v="to_both">To both</button>
            </div>
          </div>
          <div class="rb-ctl">
            <span class="rl">Format</span>
            <div class="rb-checks" id="rbFormats">
              <label><input type="checkbox" value="pdf" checked> PDF</label>
              <label><input type="checkbox" value="xlsx"> Excel</label>
            </div>
          </div>
          <div class="rb-ctl">
            <span class="rl">Include</span>
            <div class="rb-checks">
              <label><input type="checkbox" id="rbSummary"> Performance summary</label>
              <label><input type="checkbox" id="rbTrueup"> Annual true-up (Sept)</label>
            </div>
          </div>
        </div>
        <div class="rb-emails">
          <label class="rep-fld"><span class="rl">Client email</span>
            <input type="email" id="rbClientEmail" placeholder="offtaker@example.com" value="${esc(m.customer.email || "")}"></label>
          <label class="rep-fld"><span class="rl">Your email (operator)</span>
            <input type="email" id="rbOpEmail" placeholder="you@example.com"></label>
          <label class="rep-fld"><span class="rl">CC (comma-separated)</span>
            <input type="text" id="rbCc" placeholder="optional"></label>
        </div>
        <div class="rb-actions">
          <button class="ao-btn ao-btn-primary rb-save" id="rbSave" type="button">Save schedule</button>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbCancel" type="button">Cancel</button>
          <span class="rb-status" id="rbSaveStatus"></span>
        </div>
        <p class="rep-note">New schedules send <b>to you</b> by default — nothing reaches your
           customer until you move the slider to “To my client” or “To both”. Use <b>Send test</b>
           below to preview a delivery to yourself first.</p>
      </div>`;
    wireSegments(host);
    $("#rbCancel").onclick = () => { PENDING = null; host.innerHTML = ""; $("#rbStatus").textContent = ""; renderDoc(); };
    $("#rbSave").onclick = saveSchedule;

    // Live document preview (right pane) — paint now, then repaint on any change.
    renderDoc();
    host.querySelectorAll("#rbCadence button, #rbMode button").forEach(b => b.addEventListener("click", renderDoc));
    host.querySelectorAll("#rbFormats input, #rbSummary, #rbTrueup").forEach(i => i.addEventListener("change", renderDoc));
    ["rbClientEmail", "rbOpEmail"].forEach(id => { const el = $("#" + id); if (el) el.addEventListener("input", renderDoc); });
  }

  /* ---- live document preview (the right pane) -------------------------------
   * A client-side mock of the PDF invoice + performance summary we'll deliver,
   * built from the matched workbook and the current form state. Mirrors what the
   * backend renders, so the operator sees exactly what their customer receives
   * before saving. (The saved subscription's "Preview" button fetches the REAL
   * backend PDF; this is the instant, pre-save what-you'll-send view.) */
  function docDate(s) {
    if (!s) return "—";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
    return isNaN(d) ? String(s) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function currentDocState() {
    return {
      cadence: segValue("rbCadence") || "monthly",
      mode: segValue("rbMode") || "to_me",
      formats: checkedFormats().length ? checkedFormats() : ["pdf"],
      summary: $("#rbSummary") ? $("#rbSummary").checked : false,
      trueup: $("#rbTrueup") ? $("#rbTrueup").checked : false,
      clientEmail: ($("#rbClientEmail") || {}).value || "",
      opEmail: ($("#rbOpEmail") || {}).value || "",
    };
  }

  function docPlaceholder() {
    return `<div class="rb-doc-cap">Report preview</div>
      <div class="rb-doc-empty">
        <span class="ico">📄</span>
        <b>Your report appears here</b>
        <div>Drop a billing spreadsheet and we'll show the exact invoice &amp;
        performance summary your offtaker receives — updating live as you set
        the cadence, format, and recipient.</div>
      </div>`;
  }

  function renderDoc() {
    const pane = $("#rbDocPane");
    if (!pane) return;
    if (!PENDING) { pane.innerHTML = docPlaceholder(); return; }
    const m = PENDING.match, ci = m.computed_invoice || {};
    const s = currentDocState();
    const ratePct = m.billing_rate != null ? Math.round(m.billing_rate * 100) + "%" : null;
    const model = MODEL_LABEL[m.billing_model] || m.billing_model || "Solar billing";
    const periodLabel = `${docDate(ci.period_start)} – ${docDate(ci.period_end)}`;
    const cadenceWord = s.cadence === "quarterly" ? "Quarterly" : "Monthly";

    const lineSub = [
      ci.kwh != null ? `${fmt0(ci.kwh)} kWh generated` : null,
      ratePct ? `${ratePct} billing rate` : null,
    ].filter(Boolean).join(" · ");

    const summary = s.summary ? `
      <div class="rb-doc-summary">
        <h4>Performance summary</h4>
        <div class="rb-doc-stats">
          <div class="st"><b>${fmt0(ci.kwh)}</b><span>kWh this period</span></div>
          <div class="st"><b>${ratePct || "—"}</b><span>billing rate</span></div>
          <div class="st"><b>${money(ci.amount_owed)}</b><span>amount due</span></div>
        </div>
        <p class="rb-doc-note">Over ${periodLabel}, ${esc(m.customer.name || "this array")} generated
        ${fmt0(ci.kwh)} kWh${ratePct ? `, billed at ${ratePct} of generation` : ""}. Full production and
        peer-measured health detail is included in the attached report.</p>
      </div>` : "";

    const recipient = s.mode === "to_both"
      ? `you + ${esc(s.clientEmail || m.customer.email || "your client")}`
      : s.mode === "to_client"
        ? esc(s.clientEmail || m.customer.email || "your client")
        : "you";
    const badges = s.formats.map(f => `<span class="rb-doc-badge">${esc(f.toUpperCase())}</span>`).join("");

    pane.innerHTML = `
      <div class="rb-doc-cap">Live preview — exactly what gets delivered</div>
      <div class="rb-doc-paper">
        <div class="rb-doc-band">
          <div class="brand">⚡ Array Operator<small>Solar generation billing</small></div>
          <div class="doctype">INVOICE<small>${cadenceWord} · ${docDate(ci.period_end)}</small></div>
        </div>
        <div class="rb-doc-body">
          <div class="rb-doc-parties">
            <div><span class="lab">From</span><b>${esc(s.opEmail || "Your operator account")}</b>
              <span class="sub">via Array Operator</span></div>
            <div style="text-align:right"><span class="lab">Bill to</span><b>${esc(m.customer.name || "—")}</b>
              <span class="sub">${esc(s.clientEmail || m.customer.email || "")}</span></div>
          </div>
          <table class="rb-doc-table">
            <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
            <tbody>
              <tr>
                <td><b>${esc(model)}</b>${lineSub ? `<br><small>${esc(lineSub)}</small>` : ""}
                  <br><small>Period ${periodLabel}</small></td>
                <td class="num">${money(ci.amount_owed)}</td>
              </tr>
            </tbody>
            <tfoot><tr class="rb-doc-total"><td>Total due</td><td class="num amt">${money(ci.amount_owed)}</td></tr></tfoot>
          </table>
          ${summary}
        </div>
        <div class="rb-doc-foot">
          <span>Delivered ${esc(s.cadence)} · to ${recipient}</span>
          <span class="rb-doc-badges">${badges}</span>
        </div>
      </div>`;
  }

  function wireSegments(host) {
    host.querySelectorAll(".rb-seg").forEach(seg => {
      seg.querySelectorAll("button").forEach(b => b.onclick = () => {
        seg.querySelectorAll("button").forEach(x => x.classList.remove("on"));
        b.classList.add("on");
      });
    });
  }
  function segValue(id) { const on = $("#" + id + " .on"); return on ? on.getAttribute("data-v") : null; }
  function checkedFormats() {
    return Array.from(document.querySelectorAll("#rbFormats input:checked")).map(i => i.value);
  }

  async function saveSchedule() {
    if (!PENDING) return;
    const st = $("#rbSaveStatus");
    const fmts = checkedFormats();
    if (!fmts.length) { st.className = "rb-status rb-err"; st.textContent = "Pick at least one format."; return; }
    const mode = segValue("rbMode");
    const clientEmail = $("#rbClientEmail").value.trim();
    if ((mode === "to_client" || mode === "to_both") && !clientEmail) {
      st.className = "rb-status rb-err"; st.textContent = "Add the client's email to send to them."; return;
    }
    st.className = "rb-status rb-busy"; st.textContent = "Saving…";
    const fd = new FormData();
    fd.append("file", PENDING.file);
    fd.append("customer_name", PENDING.match.customer.name || "");
    fd.append("cadence", segValue("rbCadence") || "monthly");
    fd.append("delivery_mode", segValue("rbDelivery") || "approval");
    fd.append("send_mode", mode || "to_me");
    fd.append("client_email", clientEmail);
    fd.append("operator_email", $("#rbOpEmail").value.trim());
    fd.append("cc_emails", $("#rbCc").value.trim());
    fd.append("formats", JSON.stringify(fmts));
    fd.append("include_summary", $("#rbSummary").checked ? "true" : "false");
    fd.append("annual_trueup", $("#rbTrueup").checked ? "true" : "false");
    try {
      const r = await fetch(API + "/subscriptions", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        st.className = "rb-status rb-err";
        st.textContent = (data && data.detail) ? data.detail : "Couldn't save (HTTP " + r.status + ").";
        return;
      }
      PENDING = null;
      // Close the add panel and refresh the offtaker list (mirrors the manual
      // path). The panel is the unified "Add an offtaker" surface now.
      MANUAL_OPEN = false;
      renderManual();
      if (MANUAL_AFTER_ADD) await MANUAL_AFTER_ADD();
      else await refreshList();
    } catch (e) {
      st.className = "rb-status rb-err"; st.textContent = "Network error while saving.";
    }
  }

  // ---- subscriptions list ----------------------------------------------------
  // The single list renderer for the Offtaker Invoice Generator. It fetches the
  // offtaker list + their pending drafts + the array & utility-account options in
  // one pass, primes the inbox globals (DRAFT_BY_SUB / OFFTAKERS / ARRAYS /
  // INBOX_UTIL_ACCTS), then renders every offtaker as one accordion card and
  // auto-expands the default (first with a pending draft). The old separate
  // "approval inbox" section is GONE — each expanded card IS that offtaker's draft.
  async function refreshList() {
    const list = $("#rbList");
    if (!list) return;
    try {
      // ONE round-trip for subs+arrays+util-accounts (the list-bundle), in parallel
      // with the pending drafts. Falls back to the legacy individual endpoints if the
      // bundle isn't available (older backend), so frontend + backend deploy independently.
      let subs, arrs, utilAccts, bundled = false;
      const draftsP = fetch(API + "/drafts?status=pending", { headers: authHeaders() })
        .then(r => r.ok ? r.json().catch(() => ({})) : ({})).then(j => j.drafts || []).catch(() => []);
      try {
        const rb = await fetch(API + "/list-bundle", { headers: authHeaders() });
        if (rb.status === 401) { list.innerHTML = `<div class="empty">Session expired — please sign in again.</div>`; return; }
        if (rb.ok) {
          const d = await rb.json().catch(() => ({}));
          if (d && d.ok) {
            subs = d.subscriptions || [];
            arrs = ARRAYS = (d.arrays || []).filter(a => a.id != null);   // prime the shared arrays cache
            utilAccts = (d.utility_accounts || []).filter(a => a.utility_account_id != null);
            bundled = true;
          }
        }
      } catch (e) { /* fall through to the legacy three-call path */ }
      if (!bundled) {
        const [r, a2, u2] = await Promise.all([
          fetch(API + "/subscriptions", { headers: authHeaders() }),
          fetchArrays(),
          fetchUtilityAccounts(),
        ]);
        if (r.status === 401) { list.innerHTML = `<div class="empty">Session expired — please sign in again.</div>`; return; }
        const data = await r.json().catch(() => ({}));
        subs = (data && data.subscriptions) || [];
        arrs = a2; utilAccts = u2;
      }
      const drafts = await draftsP;
      INBOX_UTIL_ACCTS = utilAccts || [];
      renderAccordion(subs, arrs, utilAccts, drafts);
      // Bill accuracy check: fetch the reconcile payload (once, cached) alongside the
      // list. When it lands, paint the top-level summary chip and — if a card is
      // already open — fill its "Bill accuracy check" section, no reload needed.
      if (authHeaders() && !RECON) {
        loadReconcile().then(r => {
          if (!r) return;
          refreshBacSummary();
          if (ACTIVE_SUB_ID != null) renderAccordionBody(ACTIVE_SUB_ID);
        });
      }
    } catch (e) {
      list.innerHTML = `<div class="empty">Couldn't load your schedules — refresh to retry.</div>`;
    }
  }

  // Group offtakers by the utility account they share (Ford, 2026-06-30: "when you
  // get above five offtakers, they should be sorted by utility account... so if I
  // have five offtakers with one utility bill, they should all be sorted together").
  // Only kicks in above the 5-offtaker threshold — below that, the flat draft-first/
  // alphabetical list (the existing behavior) is already easy to scan.
  // Returns null when grouping doesn't apply; otherwise an ORDERED array of
  // {key, label, pctSum, hasDraft, rows}. Groups with a pending draft sort first
  // (matches the existing "important things first" rule), then alphabetically by
  // label; legacy array-bound subs with no utility_account_id group by array_id
  // instead (so nothing is silently dropped from the list).
  // Piece 4: is an offtaker bound to a GMP utility account, or a non-GMP one (VEC/
  // SmartHub/other)? Drives the GMP-vs-non-GMP segmented filter. An offtaker with no
  // bound utility account is treated as "other" (it isn't a GMP-bill-bound offtaker).
  function offtakerProviderBucket(s, acctById) {
    if (s.utility_account_id == null) return "other";
    const acct = acctById[String(s.utility_account_id)];
    const prov = acct && acct.provider ? String(acct.provider).toLowerCase() : "";
    return prov === "gmp" ? "gmp" : "other";
  }

  // Count offtakers per provider bucket so the filter strip only shows when there's a
  // genuine mix (both GMP and non-GMP) — a pure-GMP fleet never sees the noise.
  function providerBucketCounts(rows, utilAccts) {
    const acctById = {};
    (utilAccts || []).forEach(a => { if (a.utility_account_id != null) acctById[String(a.utility_account_id)] = a; });
    let gmp = 0, other = 0;
    (rows || []).forEach(s => { (offtakerProviderBucket(s, acctById) === "gmp" ? gmp++ : other++); });
    return { gmp, other, acctById };
  }

  function groupOfftakersByUtility(rows, utilAccts) {
    if (!rows || rows.length <= 5) return null;
    const acctById = {};
    (utilAccts || []).forEach(a => { if (a.utility_account_id != null) acctById[String(a.utility_account_id)] = a; });
    // Anna-shape fleets: when (nearly) every offtaker bills off their OWN meter,
    // the utility-account level is 1:1 with offtakers — at 800 offtakers that's
    // 800 single-card wrapper groups burying the real structure. Group by ARRAY
    // (the community project) instead, and sum array_share_pct so the pill
    // answers the question that actually matters there: "is this array fully
    // allocated?" (allocation_pct is 1.0 of each OWN bill — summing it is
    // meaningless in this shape).
    const bound = rows.filter(s => s.utility_account_id != null);
    const distinctOwn = new Set(bound.map(s => String(s.utility_account_id))).size;
    const arrayMode = bound.length > 20
      && distinctOwn / bound.length > 0.9
      && rows.filter(s => s.array_id != null).length / rows.length > 0.9;
    const groups = {};
    const order = [];
    rows.forEach(s => {
      const key = (arrayMode && s.array_id != null) ? "a:" + s.array_id
        : s.utility_account_id != null ? "u:" + s.utility_account_id
        : s.array_id != null ? "a:" + s.array_id
        : "u:none";
      if (!groups[key]) {
        const acct = s.utility_account_id != null ? acctById[String(s.utility_account_id)] : null;
        // provider drives the TOP grouping level (GMP / VEC / WEC …); the account
        // label drops the provider prefix now that it sits UNDER a provider header.
        const provider = (acct && acct.provider) ? String(acct.provider).toLowerCase() : "";
        const arrName = ((ACC_ARRS || []).find(a => String(a.id) === String(s.array_id)) || {}).name;
        const label = (arrayMode && key.startsWith("a:") && arrName)
          ? arrName
          : acct
            ? (acct.nickname || acct.account_number || String(s.utility_account_id))
            : (s.utility_account_name || arrName || "Ungrouped");
        groups[key] = { key, provider, providerLabel: provider ? provider.toUpperCase() : "Other",
                        label, pctSum: 0, hasDraft: false, rows: [],
                        shareMode: (arrayMode && key.startsWith("a:")) ? "array" : "meter" };
        order.push(key);
      }
      const g = groups[key];
      g.rows.push(s);
      g.pctSum += Number(g.shareMode === "array"
        ? (s.array_share_pct != null ? s.array_share_pct : s.allocation_pct)
        : s.allocation_pct) || 0;
      if (DRAFT_BY_SUB[String(s.id)]) g.hasDraft = true;
    });
    const list = order.map(k => groups[k]);
    list.sort((a, b) => {
      const ap = a.hasDraft ? 0 : 1, bp = b.hasDraft ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.label.localeCompare(b.label);
    });
    return list;
  }

  // Roll the per-utility-account groups UP into provider buckets (Ford: "organized by
  // utility (GMP VEC WEC etc), and THOSE can be collapsed and expanded as well, so it
  // goes utility → utility account → offtaker"). Returns an ORDERED array of
  // {provider, providerLabel, key, groups:[…], offtakerCount, hasDraft}. Buckets with a
  // pending draft float first (the "important things first" rule again), then alpha by
  // label; account-group order WITHIN each bucket is preserved from the input.
  function groupByProvider(accountGroups) {
    const buckets = {};
    const order = [];
    accountGroups.forEach(g => {
      const p = g.provider || "";
      if (!buckets[p]) {
        buckets[p] = { provider: p, providerLabel: g.providerLabel, key: "prov:" + (p || "other"),
                       groups: [], offtakerCount: 0, hasDraft: false };
        order.push(p);
      }
      const b = buckets[p];
      b.groups.push(g);
      b.offtakerCount += g.rows.length;
      if (g.hasDraft) b.hasDraft = true;
    });
    const list = order.map(p => buckets[p]);
    list.sort((a, b) => {
      const ap = a.hasDraft ? 0 : 1, bp = b.hasDraft ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.providerLabel.localeCompare(b.providerLabel);
    });
    return list;
  }

  // The "do this utility account's offtaker shares add up to 100%?" pill shown on
  // each group header — the direct answer to "an indicator that shows me how all of
  // those offtakers add up to a hundred percent" (Ford). Hovering it reveals a
  // breakdown popover ("show me how it was calculated"): every offtaker's share,
  // listed, then summed. A small epsilon absorbs float/rounding noise from
  // percent-entry; real over/under-allocation still shows as a warning.
  function pctSumPill(group) {
    const pct = Math.round((group.pctSum || 0) * 1000) / 10;   // fraction -> 1-decimal percent
    const within = Math.abs(pct - 100) <= 0.5;
    const over = !within && pct > 100;                          // REAL over-allocation — would double-bill
    const overBy = Math.round((pct - 100) * 10) / 10;           // how far past 100% (over case)
    const unassigned = Math.round((100 - pct) * 10) / 10;       // how far short of 100% (under case)
    // ~100% = fine; >100% = a genuine double-bill risk (loud warning, guard kept);
    // <100% = calm info note that some of the meter's excess is simply unassigned.
    const cls = over ? "rb-grp-pct-warn" : "rb-grp-pct-ok";
    let label, hint;
    if (within) {
      label = `✓ 100% allocated`;
      hint = "";
    } else if (over) {
      label = `⚠ ${pct}% allocated — over-allocated (would double-bill the meter's excess)`;
      hint = `These shares add to ${overBy}% more than 100%, so part of the meter's excess would be billed to two offtakers at once. Lower a share so the total is 100%.`;
    } else {
      label = `ⓘ ${pct}% allocated`;
      hint = `${unassigned}% of this meter's excess is unassigned — fine if that's intended, or add/raise a share to reach 100%.`;
    }
    // Breakdown rows — each offtaker's share, biggest first so the math reads
    // top-down. Array-grouped fleets (own-meter shape) show array_share_pct —
    // the share of the ARRAY's excess — not the 1.0-of-own-bill multiplier.
    const rowPct = (s) => group.shareMode === "array"
      ? (s.array_share_pct != null ? s.array_share_pct : s.allocation_pct)
      : s.allocation_pct;
    const rows = (group.rows || []).slice().sort((a, b) =>
      (Number(rowPct(b)) || 0) - (Number(rowPct(a)) || 0));
    const rowHtml = rows.map(s => {
      const rp = rowPct(s);
      const p = rp != null ? Math.round(rp * 1000) / 10 : 0;
      return `<span class="rb-grp-pop-row"><span class="rb-grp-pop-who">${esc(s.customer_name || "(unnamed)")}</span><span class="rb-grp-pop-pct">${p}%</span></span>`;
    }).join("");
    const sumCls = over ? "rb-grp-pop-sum-warn" : "rb-grp-pop-sum-ok";
    const where = group.shareMode === "array" ? "in this array" : "on this utility bill";
    // Redesign: the pill carries a small allocation METER (fill = % allocated;
    // green ≈100%, amber over/under) — the number still reads exactly, the bar
    // makes 26 arrays scannable. Hover breakdown unchanged below.
    const meter = `<span class="rb2-meter${over ? " warn" : (within ? "" : " under")}" aria-hidden="true"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></span>`;
    return `<span class="rb-grp-pctwrap">
      ${meter}<span class="rb-grp-pct ${cls}" tabindex="0" aria-describedby="">${label}</span>
      <span class="rb-grp-pct-pop" role="tooltip">
        <span class="rb-grp-pop-title">How this adds up — ${rows.length} offtaker${rows.length === 1 ? "" : "s"} ${where}</span>
        ${rowHtml}
        <span class="rb-grp-pop-row rb-grp-pop-sum ${sumCls}"><span class="rb-grp-pop-who">Total allocated</span><span class="rb-grp-pop-pct">${pct}%</span></span>
        ${hint ? `<span class="rb-grp-pop-note">${esc(hint)}</span>` : ""}
      </span>
    </span>`;
  }

  // Render every offtaker as a collapsed accordion card, preserve which one is
  // open across refreshes, and auto-open the default (first awaiting approval) on
  // a fresh load. The expanded body is filled lazily by expandAccordion().
  let ACC_ARRS = [];               // arrays cache for the open card's offtaker editor
  function renderAccordion(subs, arrs, utilAccts, drafts) {
    const list = $("#rbList");
    if (!list) return;
    parkTpl();   // move #rbTpl to its standalone home BEFORE wiping #rbList — else a box
                 // currently folded into an open card is destroyed with the list and
                 // never comes back (the "showed up then disappeared on reload" bug). The
                 // re-expanded card re-folds it; if none re-opens it stays visible at home.
    ACC_ARRS = arrs || [];
    // Index the drafts (newest per offtaker) + build the dropdown-free OFFTAKERS list.
    _indexInbox(drafts || [], subs || []);
    // OFFTAKERS is reused as the canonical ordered offtaker list (drafts float to top).
    if (!OFFTAKERS.length) {
      list.innerHTML = `<div class="empty" style="padding:22px 0;color:var(--faint)">No offtakers yet — click <b>＋ Add an offtaker</b> above, or drop a billing spreadsheet to create one.</div>`;
      return;
    }
    // Header copy: "N reports ready to review & send — nothing sends until you approve."
    const pending = OFFTAKERS.filter(s => DRAFT_BY_SUB[String(s.id)]).length;
    const headLine = pending
      ? `<b>${pending}</b> report${pending === 1 ? "" : "s"} ready to review &amp; send — nothing sends until you approve.`
      : `Click an offtaker to review &amp; send their invoice — nothing sends until you approve.`;
    // Keep the currently-open card open across refreshes, but do NOT auto-open one on a
    // fresh load — every offtaker starts collapsed until the operator clicks one (Ford).
    const stillOpen = ACTIVE_SUB_ID && OFFTAKERS.some(s => String(s.id) === String(ACTIVE_SUB_ID));
    if (!stillOpen) ACTIVE_SUB_ID = null;
    // ── GMP vs non-GMP segmented filter (Piece 4) ──────────────────────────────
    // A filter strip over the ONE list — NOT a separate tab/page. Only shown when
    // the fleet actually mixes GMP-bill-bound offtakers with non-GMP ones (VEC/
    // SmartHub/unbound); a pure-GMP fleet never sees it. Scopes which offtakers
    // render; the existing utility → account → offtaker hierarchy still applies
    // within the scope.
    const bucketCounts = providerBucketCounts(OFFTAKERS, utilAccts);
    const showFilter = bucketCounts.gmp > 0 && bucketCounts.other > 0;
    if (!showFilter) OFFTAKER_FILTER = "all";   // no mix → the filter is meaningless
    const filterStripHTML = showFilter ? (() => {
      const chip = (v, label, n) =>
        `<button type="button" class="rb-ofilter-chip${OFFTAKER_FILTER === v ? " on" : ""}" data-ofilter="${v}"
                 aria-pressed="${OFFTAKER_FILTER === v}">${label} <span class="rb-ofilter-n">${n}</span></button>`;
      return `<div class="rb-ofilter" role="group" aria-label="Filter offtakers by utility">
          ${chip("all", "All", bucketCounts.gmp + bucketCounts.other)}
          ${chip("gmp", "GMP bills", bucketCounts.gmp)}
          ${chip("other", "Other utilities", bucketCounts.other)}
        </div>`;
    })() : "";
    const scopeRows = showFilter && OFFTAKER_FILTER !== "all"
      ? OFFTAKERS.filter(s => offtakerProviderBucket(s, bucketCounts.acctById) === OFFTAKER_FILTER)
      : OFFTAKERS;
    // ── find-an-offtaker search (Anna-scale) ──────────────────────────────────
    // Big fleets need a lookup tool, not a scroll: match name / email / utility-
    // account number or nickname. The query lives beside the GMP-vs-other chips
    // in one tools row over the ONE list (integrate-in-place, no separate page).
    const acctByIdFull = new Map((utilAccts || []).map(a => [String(a.id), a]));
    const q = (OFFTAKER_QUERY || "").trim().toLowerCase();
    const matchesQuery = (s) => {
      if (!q) return true;
      const a = s.utility_account_id != null ? acctByIdFull.get(String(s.utility_account_id)) : null;
      return [s.customer_name, s.client_email, a && a.account_number, a && a.nickname]
        .some(v => v && String(v).toLowerCase().includes(q));
    };
    const viewRows = q ? scopeRows.filter(matchesQuery) : scopeRows;
    const showSearch = OFFTAKERS.length > 12;
    const searchHTML = showSearch ? `
      <div class="rb-osearch">
        <span class="rb-osearch-ico" aria-hidden="true">⌕</span>
        <input id="rbOSearch" type="search" placeholder="Find an offtaker — name, email, or account…"
               value="${esc(OFFTAKER_QUERY)}" autocomplete="off" spellcheck="false"
               aria-label="Find an offtaker">
        ${q ? `<span class="rb-osearch-n">${viewRows.length} match${viewRows.length === 1 ? "" : "es"}</span>` : ""}
      </div>` : "";
    // Above 5 offtakers, build the three-level hierarchy (Ford): utility (provider) →
    // utility account → offtaker. Both upper levels collapse on a whole-header click and
    // both DEFAULT collapsed, so a fresh load of a big account shows just the provider
    // headers (GMP / VEC / WEC). Each utility-account header still carries the "do these
    // shares add up to 100%" pill with its hover breakdown.
    // An active SEARCH renders its matches FLAT — regrouping 12 matches under
    // wrapper headers (with pills computed off the filtered subset) is noise;
    // the operator asked for specific offtakers, show exactly those cards.
    const groups = q ? null : groupOfftakersByUtility(viewRows, utilAccts);
    // MIDDLE level — one utility-account group (its header + the offtaker cards under it).
    const acctGroupHTML = (g) => {
      if (GROUP_COLLAPSED[g.key] === undefined) GROUP_COLLAPSED[g.key] = true;   // default collapsed
      const collapsed = !!GROUP_COLLAPSED[g.key];
      return `
        <div class="rb-grp${collapsed ? " collapsed" : ""}">
          <div class="rb-grp-head" data-grpcollapse="${esc(g.key)}" role="button" tabindex="0"
               aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Collapse"} the offtakers ${g.shareMode === "array" ? "in this array" : "on this utility bill"}">
            <span class="rb-grp-caret" aria-hidden="true">▾</span>
            <span class="rb-grp-label">${esc(g.label)}</span>
            <span class="rb-grp-count">${g.rows.length} offtaker${g.rows.length === 1 ? "" : "s"}</span>
            ${pctSumPill(g)}
          </div>
          <div class="rb-grp-rows"${collapsed ? " hidden" : ""}>
            ${g.rows.map(s => subCard(s, arrs, utilAccts)).join("")}
          </div>
        </div>`;
    };
    let body;
    if (groups) {
      const providers = groupByProvider(groups);
      body = providers.map(pv => {
        if (PROVIDER_COLLAPSED[pv.key] === undefined) PROVIDER_COLLAPSED[pv.key] = true;   // default collapsed
        const pCollapsed = !!PROVIDER_COLLAPSED[pv.key];
        const nAcct = pv.groups.length;
        // Array-grouped fleets (own-meter shape): the middle level is arrays,
        // not utility accounts — say so.
        const grpNoun = pv.groups.length && pv.groups.every(g => g.shareMode === "array")
          ? `array${nAcct === 1 ? "" : "s"}`
          : `utility account${nAcct === 1 ? "" : "s"}`;
        // Redesign: sent-this-period progress + flagged count on the provider
        // header — exact period compare against the pipeline's last period.
        const _lp = PIPE && PIPE.last && PIPE.last.period_end;
        const sentN = _lp ? pv.groups.reduce((n, g) =>
          n + g.rows.filter(s => s.last_sent_period_end === _lp).length, 0) : 0;
        const provBar = (_lp && pv.offtakerCount)
          ? `<span class="rb2-provbar"><span class="rb2-minitrack"><i style="width:${Math.min(100, Math.round(sentN / pv.offtakerCount * 100))}%"></i></span><small>${fmt0(sentN)} sent · ${esc(_monthName(PIPE.last.period_month))}</small></span>`
          : "";
        const provFlagN = RECON ? pv.groups.reduce((n, g) =>
          n + g.rows.filter(s => reconFlagged(s.id)).length, 0) : 0;
        const provFlag = provFlagN
          ? `<span class="rb2-provflag">⚑ ${fmt0(provFlagN)} to review</span>` : "";
        return `
          <div class="rb-prov${pCollapsed ? " collapsed" : ""}">
            <div class="rb-prov-head" data-provcollapse="${esc(pv.key)}" role="button" tabindex="0"
                 aria-expanded="${!pCollapsed}" title="${pCollapsed ? "Expand" : "Collapse"} all ${esc(pv.providerLabel)} utility accounts">
              <span class="rb-prov-caret" aria-hidden="true">▾</span>
              <span class="rb-prov-label">${esc(pv.providerLabel)}</span>
              <span class="rb-prov-count">${nAcct} ${grpNoun} · ${pv.offtakerCount} offtaker${pv.offtakerCount === 1 ? "" : "s"}</span>
              <span class="rb2-provsp"></span>${provFlag}${provBar}
            </div>
            <div class="rb-prov-rows"${pCollapsed ? " hidden" : ""}>
              ${pv.groups.map(acctGroupHTML).join("")}
            </div>
          </div>`;
      }).join("");
    } else {
      body = viewRows.map(s => subCard(s, arrs, utilAccts)).join("");
    }
    if (q && viewRows.length === 0) {
      body = `<div class="empty" style="padding:18px 0;color:var(--faint)">No offtaker matches “${esc(OFFTAKER_QUERY)}”.</div>`;
    } else if (showFilter && viewRows.length === 0) {
      // The filter matched nothing (shouldn't normally happen since chips carry counts,
      // but stay honest rather than render a blank list).
      body = `<div class="empty" style="padding:18px 0;color:var(--faint)">No ${OFFTAKER_FILTER === "gmp" ? "GMP" : "non-GMP"} offtakers.</div>`;
    }
    const toolsHTML = (filterStripHTML || searchHTML)
      ? `<div class="rb-listtools">${filterStripHTML}${searchHTML}</div>` : "";
    list.innerHTML = `<div class="rb-acc-lead">${headLine}` +
      `<span class="rb-bac-summary" id="rbBacSummary">${bacSummaryHTML()}</span></div>` + toolsHTML + body;
    wireBacChip($("#rbBacSummary"));
    renderKpis();   // the KPI band tracks the freshly-rendered list's counts
    // Wire the GMP-vs-non-GMP filter chips — flip the scope + re-render in place.
    list.querySelectorAll("[data-ofilter]").forEach(b => b.onclick = () => {
      OFFTAKER_FILTER = b.getAttribute("data-ofilter") || "all";
      renderAccordion(subs, arrs, utilAccts, drafts);
    });
    // Wire the search box — debounced re-render; the innerHTML swap drops focus,
    // so restore it (with the caret at the end) after each keystroke's render.
    const se = list.querySelector("#rbOSearch");
    if (se) {
      const apply = () => {
        clearTimeout(se._t);
        se._t = setTimeout(() => {
          if ((se.value || "") === OFFTAKER_QUERY) return;
          OFFTAKER_QUERY = se.value || "";
          renderAccordion(subs, arrs, utilAccts, drafts);
          const el = list.querySelector("#rbOSearch");
          if (el) {
            el.focus();
            const n = el.value.length;
            try { el.setSelectionRange(n, n); } catch (_) { /* type=search quirk */ }
          }
        }, 160);
      };
      se.oninput = apply;
      se.onsearch = apply;   // the native ✕ clear control on type=search
    }
    wireAccordionHeaders(list);
    // TOP level — provider collapse (GMP / VEC / WEC). Whole header clickable, keyboard-OK.
    // (.rb-prov-head and .rb-grp-head are siblings' children, not nested, so the two
    // collapse levels never trigger each other.)
    list.querySelectorAll("[data-provcollapse]").forEach(h => {
      const go = () => {
        const k = h.getAttribute("data-provcollapse");
        PROVIDER_COLLAPSED[k] = !PROVIDER_COLLAPSED[k];
        renderAccordion(subs, arrs, utilAccts, drafts);
      };
      h.onclick = go;
      h.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    // MIDDLE level — utility-account collapse. The pill's hover-breakdown still works
    // (the pill wrapper stops propagation below so reading it never also collapses).
    list.querySelectorAll("[data-grpcollapse]").forEach(h => {
      const go = () => {
        const k = h.getAttribute("data-grpcollapse");
        GROUP_COLLAPSED[k] = !GROUP_COLLAPSED[k];
        renderAccordion(subs, arrs, utilAccts, drafts);
      };
      h.onclick = go;
      h.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    // The allocation pill is an info affordance (hover shows the breakdown) — clicking
    // it should NOT also collapse the group it sits inside.
    list.querySelectorAll(".rb-grp-pctwrap").forEach(p => p.addEventListener("click", e => e.stopPropagation()));
    // Per-offtaker delete (🗑 on the header). stopPropagation so the click deletes
    // instead of toggling the card open.
    list.querySelectorAll("[data-del-offtaker]").forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      deleteOfftaker(b.getAttribute("data-del-offtaker"));
    });
    // Open the default card inline.
    if (ACTIVE_SUB_ID != null) expandAccordion(ACTIVE_SUB_ID, { silent: true });
  }

  // Soft-delete an offtaker (DELETE /subscriptions/{id} dismisses its drafts too), then
  // refresh the list. Names the offtaker in the confirm so a misclick is obvious.
  async function deleteOfftaker(id) {
    const card = document.querySelector(`.rb-acc[data-id="${id}"]`);
    let name = "this offtaker";
    if (card) {
      const n = card.querySelector(".rb-acc-name");
      if (n && n.childNodes[0]) name = (n.childNodes[0].textContent || name).trim() || name;
    }
    if (!confirm(`Delete ${name} and their invoice schedule? This can't be undone.`)) return;
    try {
      const r = await fetch(API + "/subscriptions/" + id, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) { alert("Couldn't delete the offtaker (HTTP " + r.status + ")."); return; }
      if (String(ACTIVE_SUB_ID) === String(id)) ACTIVE_SUB_ID = null;
      await refreshList();
    } catch (e) {
      alert("Network error — the offtaker wasn't deleted. Try again.");
    }
  }

  const MODE_LABEL = { to_me: "To me", to_client: "To client", to_both: "To both" };

  // Human label for where the auto-resolved net rate came from.
  function rateSourceLabel(src) {
    return {
      customer: "your override",
      global: "your default",
      auto_schedule: "auto · from GMP bills",
      auto_schedule_provisional: "auto · provisional",
      vt_default: "VT default",
      legacy_flat_customer: "flat (override)",
      legacy_flat_global: "flat (default)",
    }[src] || (src || "");
  }

  // ── ACCORDION CARD ─────────────────────────────────────────────────────────
  // Each offtaker is ONE clickable accordion card. Collapsed = a summary header
  // (name + status chip + the plain-English "receives X% of … · Next/last" line).
  // Expanded = that offtaker's full draft inline (calc panel, cover email,
  // offtaker editor, attachments, Approve & send) — built lazily into .rb-acc-body
  // by expandAccordion() so it reuses the exact live draft pieces. Clicking the
  // header toggles; expanding one collapses the rest (one open at a time).
  function subCard(s, arrs, utilAccts) {
    const prev = s.preview || {};
    const next = s.next_send_at ? new Date(s.next_send_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
    const last = s.last_sent_at ? new Date(s.last_sent_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never";
    const fmts = (s.formats || []).map(f => f.toUpperCase()).join(" + ");
    // ── one plain-English sentence, built from the offtaker's actual choices. ──
    const srcName = s.utility_account_name
      || ((arrs || []).find(a => String(a.id) === String(s.array_id)) || {}).name
      || "the array";
    const pctTxt = s.allocation_pct != null ? (Math.round(s.allocation_pct * 1000) / 10) + "%" : "a share";
    const cadTxt = s.cadence === "quarterly" ? "Quarterly" : s.cadence === "monthly" ? "Monthly" : (s.cadence || "");
    const cc = (s.cc_emails || "").trim();
    const client = (s.client_email || "").trim();
    let recips;
    if (s.send_mode === "to_client") recips = (client || "the offtaker") + (cc ? ", cc " + cc : "");
    else if (s.send_mode === "to_both") recips = "you and " + (client || "the offtaker") + (cc ? ", cc " + cc : "");
    else recips = "you" + (s.operator_email ? " (" + s.operator_email + ")" : "");
    const deliveryTxt = s.delivery_mode === "auto"
      ? "auto-sent to " + esc(recips)
      : "drafted for your approval, then sent to " + esc(recips);
    const sentence = "<b>" + esc(s.customer_name) + "</b> receives <b>" + pctTxt + "</b> of <b>"
      + esc(srcName) + "</b>'s generation. <b>" + cadTxt + "</b> " + esc(fmts) + " &mdash; " + deliveryTxt + ".";
    // Whether a draft is queued for this offtaker (Ready) drives the header pill.
    const draft = DRAFT_BY_SUB[String(s.id)];
    const readyPill = draft
      ? `<span class="rb-chip rb-chip-ready">${draft.amount_usd != null ? money(draft.amount_usd) + " ready" : "Ready"}</span>`
      : "";
    return `
      <div class="rb-acc ${s.enabled ? "" : "rb-paused"}" data-id="${s.id}" data-open="false">
        <div class="rb-acc-head" role="button" tabindex="0" aria-expanded="false"
             aria-controls="rbAccBody-${s.id}" data-acchead="${s.id}">
          <span class="rb-acc-caret" aria-hidden="true">▸</span>
          <div class="rb-acc-head-main">
            <div class="rb-acc-name">${esc(s.customer_name)}
              ${readyPill}
              <span class="rb-chip ${s.delivery_mode === "auto" ? "rb-chip-live" : ""}">${s.delivery_mode === "auto" ? "Auto-send" : "Draft for approval"}</span>
              ${s.enabled ? "" : `<span class="rb-chip rb-chip-off">Paused</span>`}
            </div>
            <div class="rb-acc-sentence">${sentence}</div>
            <div class="rb-acc-meta">Next ${esc(next)} · last sent ${esc(last)}${prev.amount_owed != null && !draft ? " · ~" + money(prev.amount_owed) : ""}</div>
          </div>
          <button class="rb-acc-del" data-del-offtaker="${s.id}" title="Delete this offtaker" aria-label="Delete offtaker">🗑</button>
        </div>
        <div class="rb-acc-body" id="rbAccBody-${s.id}" data-accbody="${s.id}" hidden></div>
      </div>`;
  }

  async function patch(id, body, st) {
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Saving…"; }
    try {
      const r = await fetch(API + "/subscriptions/" + id, {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      });
      if (r.ok) { if (st) st.textContent = ""; return true; }
      // Surface the backend reason instead of a blind "Save failed." so a real
      // error (a rejected field, a 500) is diagnosable from the form.
      const d = await r.json().catch(() => ({}));
      if (st) {
        st.className = "rb-status rb-err";
        st.textContent = (d && d.detail) ? d.detail : ("Save failed (HTTP " + r.status + ").");
      }
      return false;
    } catch (e) { if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error."; } return false; }
  }

  // ---- approval inbox (Paul's draft → review → approve & send) ---------------
  // The pending drafts currently shown, + which one the live preview tracks.
  let INBOX_DRAFTS = [];
  let ACTIVE_DRAFT_ID = null;
  let INBOX_UTIL_ACCTS = [];   // cached so the offtaker dropdown can re-render without a refetch
  // The offtaker dropdown lists ALL the operator's offtakers (not just the ones the
  // scheduler already drafted), so they can swap to ANY of them. Selecting one shows
  // its pending draft if it has one, else mints one on demand (idempotent generate).
  let OFFTAKERS = [];           // enabled subscriptions (+ any with a pending draft) = dropdown rows
  let OFFTAKER_FILTER = "all";  // "all" | "gmp" | "other" — GMP-vs-non-GMP list scope (Piece 4).
                                // A segmented strip over the ONE list (not a separate tab/page):
                                // Bruce framed GMP-vs-other as "tabs", but Ford's rule is integrate-
                                // in-place, so it's a filter that scopes which offtakers render.
                                // Only shown when the fleet has BOTH GMP and non-GMP offtakers.
  let OFFTAKER_QUERY = "";      // find-an-offtaker search (Anna-scale fleets: at 800 offtakers,
                                // scrolling collapsed groups is not a lookup tool). Filters by
                                // name / email / utility-account; an active query force-expands
                                // the provider→account hierarchy so matches surface in place.
  let DRAFT_BY_SUB = {};        // subscription_id -> its pending draft (refs INTO INBOX_DRAFTS)
  let ACTIVE_SUB_ID = null;     // the offtaker under review — the source of truth for the view
  let GROUP_COLLAPSED = {};     // utility-account group key -> bool; collapses every offtaker
                                // card under one utility bill at once. DEFAULTS to collapsed
                                // (each first-seen group key inits to true in renderAccordion).
                                // Persists across refreshes (module-level, keyed by stable
                                // utility_account_id), un-persisted across reloads — so a fresh
                                // load always opens fully collapsed. Same map as vendor-sheet.
  let PROVIDER_COLLAPSED = {};  // provider bucket key ("prov:gmp") -> bool; the TOP level of the
                                // utility → utility-account → offtaker hierarchy. Same default-
                                // collapsed + persist-across-refreshes / reset-on-reload rules.
  let GENERATING_SUB_ID = null; // the offtaker whose draft is being minted right now (loading state)
  let GEN_FAIL = {};            // subscription_id -> why its on-demand draft couldn't be built
  let _pinActiveSub = false;    // keep refreshInbox from auto-advancing off a just-selected offtaker
  // The operator's invoice template ({enabled, html}) — when enabled, the live
  // preview renders THIS (their exact format) instead of the generic mock, so an
  // uploaded template propagates into the preview immediately.
  let TEMPLATE_STATE = null;
  // Per-offtaker invoice template: the single wired #rbTpl box is rebound to whichever
  // offtaker card is open (TPL_SID) so its upload/toggle/remove hit that offtaker's
  // own per-subscription endpoints. Parked (no card open) → TPL_SID null → hidden.
  let TPL_SID = null;
  let _tplRefresh = null;
  function tplApi(suffix) {
    return TPL_SID != null
      ? (API + "/subscriptions/" + TPL_SID + "/invoice-template" + (suffix || ""))
      : null;
  }
  function rebindTpl(sid) {
    TPL_SID = (sid == null || sid === "") ? null : sid;
    if (_tplRefresh) _tplRefresh();
  }

  // Fill {{ tokens }} in a template with a draft's known numbers (graceful: an
  // unknown token renders blank, exactly like the backend's ChainableUndefined).
  function draftTokenValues(d) {
    let ps = "", pe = "";
    const m = String(d.period_label || "").match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
    if (m) { ps = m[1]; pe = m[2]; }
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    return {
      amount_due: d.amount_usd != null ? money(d.amount_usd) : "",
      kwh: d.customer_kwh != null ? fmt0(d.customer_kwh) : "",
      offtaker_name: d.customer_name || "", customer_name: d.customer_name || "",
      period_start: ps, period_end: pe,
      rate: pct != null ? pct + "%" : "",
    };
  }
  function fillTemplate(html, d) {
    const v = draftTokenValues(d);
    return String(html || "").replace(/\{\{\s*(\w+)\s*\}\}/g,
      (_, k) => (k in v && v[k] != null) ? esc(String(v[k])) : "");
  }

  // True if draft a is NEWER than b — by billing period, then created_at, then id.
  // period_label is "YYYY-MM-DD → YYYY-MM-DD", so a lexical compare ranks later periods
  // higher; a null/placeholder period sorts below any real one.
  function _draftNewer(a, b) {
    const ka = [String(a.period_label || ""), String(a.created_at || ""), Number(a.id) || 0];
    const kb = [String(b.period_label || ""), String(b.created_at || ""), Number(b.id) || 0];
    for (let i = 0; i < ka.length; i++) { if (ka[i] > kb[i]) return true; if (ka[i] < kb[i]) return false; }
    return false;
  }

  // Build the dropdown's offtaker list + the subscription->draft index from a fetch.
  function _indexInbox(drafts, subs) {
    INBOX_DRAFTS = drafts;
    DRAFT_BY_SUB = {};
    // An offtaker can have >1 pending draft (a new period's draft + a stale older one).
    // Index the NEWEST per offtaker so the inbox auto-switches to the latest draft and
    // never surfaces a superseded bill (Paul Bozuwa: a May $3,167 draft in front of June).
    drafts.forEach(d => {
      if (d.subscription_id == null) return;
      const k = String(d.subscription_id);
      if (!DRAFT_BY_SUB[k] || _draftNewer(d, DRAFT_BY_SUB[k])) DRAFT_BY_SUB[k] = d;
    });
    // Dropdown rows = every enabled offtaker, PLUS any (even disabled) that has a
    // pending draft so a queued report is never stranded.
    const rows = (subs || []).filter(s => s.enabled !== false || DRAFT_BY_SUB[String(s.id)]);
    const seen = new Set(rows.map(s => String(s.id)));
    // A pending draft whose subscription isn't in the list (disabled+excluded or
    // deleted) still needs a selectable row — synthesize one from the draft.
    drafts.forEach(d => {
      const sid = d.subscription_id;
      if (sid != null && !seen.has(String(sid))) {
        rows.push({ id: sid, customer_name: d.customer_name, _fromDraft: true });
        seen.add(String(sid));
      }
    });
    // Offtakers WITH a pending draft float to the top (the genuine approval queue),
    // then the rest alphabetically.
    rows.sort((a, b) => {
      const ap = DRAFT_BY_SUB[String(a.id)] ? 0 : 1, bp = DRAFT_BY_SUB[String(b.id)] ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
    });
    OFFTAKERS = rows;
  }

  // ── invoice-template box relocation ──────────────────────────────────────
  // #rbTpl is one wired element moved between its standalone home (#rbTplHome)
  // and the bottom of the approval card. ALWAYS park it home before an innerHTML
  // wipe so its event wiring survives the re-render.
  function parkTpl() {
    const home = $("#rbTplHome"), tpl = $("#rbTpl");
    if (home && tpl && tpl.parentElement !== home) home.appendChild(tpl);
  }
  // During an OPEN card's re-render (fired several times in a burst as the draft,
  // versions, and the background GMP re-pull resolve), stash #rbTpl in a HIDDEN holder
  // rather than the visible home — else it flashes to the top of the page and back on
  // every pass (the flicker). collapseAccordion still parks it to the visible home.
  function stashTpl() {
    const stash = $("#rbTplStash"), tpl = $("#rbTpl");
    if (stash && tpl && tpl.parentElement !== stash) stash.appendChild(tpl);
  }
  function foldTplIntoInbox(inboxCard) {
    const tpl = $("#rbTpl");
    if (!inboxCard || !tpl) return;
    // Drop the single wired template box into the "Invoice template" section's slot
    // (falls back to the form column if the slot isn't present).
    const slot = inboxCard.querySelector(".rb-tpl-slot")
      || inboxCard.querySelector(".rb-col-form") || inboxCard;
    slot.appendChild(tpl);
    // Rebind the (single, wired) box to THIS offtaker so its upload/toggle/remove hit
    // the per-subscription endpoints and it shows this offtaker's own template.
    const oe = inboxCard.querySelector("[data-offedit]");
    rebindTpl(oe ? oe.getAttribute("data-offedit") : null);
  }

  // refreshInbox() is retained as the canonical "re-pull drafts + re-render the
  // list" entry point (every approve/send/dismiss/toggle path calls it). It now
  // simply re-renders the unified accordion list (which fetches drafts itself).
  async function refreshInbox() {
    await refreshList();
  }


  // Render the approval inbox from the cached data, so the offtaker dropdown switches
  // the whole section instantly. ONE offtaker shows at a time; the custom dropdown picks
  // which (its draft card + live preview move together). An offtaker with no pending
  // draft shows a loading state while one is minted, or a graceful empty state.
  // ── ACCORDION: header wiring + expand/collapse ───────────────────────────────
  // The collapsed header is a real button (role+tabindex+aria-expanded). A click
  // ANYWHERE on it toggles; Enter/Space do the same. Expanding one collapses any
  // other open card (one at a time). Inner controls in the expanded body stop their
  // own propagation, so editing/sending never bubbles up to collapse the card.
  function wireAccordionHeaders(list) {
    list.querySelectorAll("[data-acchead]").forEach(h => {
      const sid = h.getAttribute("data-acchead");
      h.onclick = () => toggleAccordion(sid);
      h.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); toggleAccordion(sid); }
      };
    });
  }

  function toggleAccordion(sid) {
    sid = String(sid);
    const card = document.querySelector(`.rb-acc[data-id="${sid}"]`);
    if (!card) return;
    if (card.getAttribute("data-open") === "true") collapseAccordion(sid);
    else expandAccordion(sid);
  }

  // Open one offtaker's card: collapse every other, mark this one open, set
  // ACTIVE_SUB_ID, and render its full draft inline into .rb-acc-body. `silent`
  // skips the scroll-into-view (used for the default-open on first render).
  function expandAccordion(sid, opts) {
    sid = String(sid);
    const list = $("#rbList");
    if (!list) return;
    // Collapse any other open card first (one open at a time).
    list.querySelectorAll('.rb-acc[data-open="true"]').forEach(c => {
      if (c.getAttribute("data-id") !== sid) collapseAccordion(c.getAttribute("data-id"));
    });
    const card = list.querySelector(`.rb-acc[data-id="${sid}"]`);
    if (!card) return;
    ACTIVE_SUB_ID = sid;
    VIEWING_VERSION_ID = null;          // always open on the latest version
    card.setAttribute("data-open", "true");
    const head = card.querySelector("[data-acchead]");
    if (head) head.setAttribute("aria-expanded", "true");
    const body = card.querySelector("[data-accbody]");
    if (body) body.hidden = false;
    renderAccordionBody(sid);
    // A cached draft is shown instantly; pull the latest GMP bill + recompute in the
    // background so a freshly-released statement is reflected without a manual regen.
    if (DRAFT_BY_SUB[sid] && authHeaders()) backgroundRefreshDraft(sid);
    // Bill accuracy check: if the reconcile data hasn't landed yet, fetch it and
    // re-render this card's body once (only while it's still the open card) so the
    // "Bill accuracy check" section fills in without a reload.
    if (authHeaders() && !RECON) {
      loadReconcile().then(r => {
        if (r && String(ACTIVE_SUB_ID) === sid) { renderAccordionBody(sid); refreshBacSummary(); }
      });
    }
    if (!(opts && opts.silent)) {
      requestAnimationFrame(() => card.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  function collapseAccordion(sid) {
    sid = String(sid);
    const card = document.querySelector(`.rb-acc[data-id="${sid}"]`);
    if (!card) return;
    parkTpl();                          // protect the wired template box before wiping the body
    card.setAttribute("data-open", "false");
    const head = card.querySelector("[data-acchead]");
    if (head) head.setAttribute("aria-expanded", "false");
    const body = card.querySelector("[data-accbody]");
    if (body) { body.hidden = true; body.innerHTML = ""; }
    if (String(ACTIVE_SUB_ID) === sid) ACTIVE_SUB_ID = null;
  }

  // renderInboxBody() is the compatibility shim the rest of the module calls to
  // "re-render the active draft view" (version picker, recompute, etc.). It now
  // re-renders the OPEN accordion card's body.
  function renderInboxBody() {
    if (ACTIVE_SUB_ID != null) renderAccordionBody(ACTIVE_SUB_ID);
  }

  // Fill one offtaker's expanded body with its full draft: the two-column review
  // (left = cover email + attach controls + offtaker editor; right = Approve/Send
  // header + the How-we-calculated panel + the live email/invoice preview). This is
  // the SAME draft pipeline the old approval inbox used — draftCard/calcDashboard/
  // reviewActions/renderDraftDoc — just hosted inside the accordion card.
  function renderAccordionBody(sid) {
    sid = String(sid);
    const card = document.querySelector(`.rb-acc[data-id="${sid}"]`);
    if (!card) return;
    const wrap = card.querySelector("[data-accbody]");
    if (!wrap) return;
    stashTpl();                         // hide-stash the wired box before the wipe (no flash to the top)
    const activeOf = OFFTAKERS.find(s => String(s.id) === sid) || { id: sid };
    const active = activeDraft();       // reads ACTIVE_SUB_ID / VIEWING_VERSION_ID

    // The form column: the real draft card | a loading card | a graceful empty state.
    let bodyCol;
    if (String(GENERATING_SUB_ID) === sid) {
      bodyCol = `<div class="rb-draft rb-draft-loading"><div class="rb-spin"></div>
        <p>Drafting ${esc(activeOf.customer_name || "this offtaker")}'s latest period…</p></div>`;
    } else if (active) {
      bodyCol = draftCard(active, INBOX_UTIL_ACCTS);
    } else {
      const why = GEN_FAIL[sid]
        || "No billable period yet for this offtaker — its report appears here once a GMP bill lands.";
      bodyCol = `<div class="rb-draft rb-draft-empty">
        <div class="rb-draft-top"><div class="rb-draft-name">${esc(activeOf.customer_name || "Offtaker")}</div></div>
        <p class="rb-empty-why">${esc(why)}</p>
        <button class="ao-btn rb-btn" type="button" data-regen="${esc(sid)}">Try drafting this period</button>
      </div>`;
    }

    wrap.innerHTML = `
      <div class="rb-acc-inner">
        ${verPickerHTML(sid)}
        <div id="rbReviewTop" class="rb-reviewbar"></div>
        <div class="rb-layout">
          <div class="rb-col-form">${bodyCol}</div>
          <aside class="rb-col-doc">
            <div id="rbDraftDocPane"></div>
          </aside>
        </div>
      </div>`;
    // Inner controls must NOT bubble a click up to the header (which would collapse
    // the card). Only the header strip toggles; everything inside the body is inert
    // to the accordion. (Capture isn't needed — the header listener is on the header
    // element, not an ancestor of the body, but this guards future nesting + the
    // version picker that sits at the top of the body.)
    wrap.querySelectorAll("[data-dact]").forEach(b => b.onclick = onDraftAction);
    // Version history: fetch older drafts (once), wire the dropdown; older = read-only.
    _ensureVersions(sid);
    const _vp = wrap.querySelector("#rbVerPick");
    if (_vp) _vp.onchange = () => { VIEWING_VERSION_ID = _vp.value || null; renderAccordionBody(sid); };
    if (VIEWING_VERSION_ID != null) {
      const form = wrap.querySelector(".rb-col-form");
      if (form) { const b = document.createElement("div"); b.className = "rb-ver-banner";
        b.textContent = "Viewing an older version (read-only) — select “· latest” to edit or send."; form.insertBefore(b, form.firstChild); }
    }
    // Live preview + review header (actions + calc dashboard).
    renderDraftDoc();
    renderReviewTop();
    wireCalcLinks(wrap);                 // calc dashboard now lives in the form column
    wrap.querySelectorAll("textarea[data-draftmsg]").forEach(ta => {
      autoGrowMsg(ta);
      const did = ta.getAttribute("data-draftmsg");
      const focusDraft = () => { ACTIVE_DRAFT_ID = did; renderDraftDoc(); };
      // The cover email AUTO-SAVES as you type (debounced 700ms) — no Save button.
      let saveT = null;
      const tag = () => wrap.querySelector(".rb-email-saved");
      const doSave = async () => {
        try {
          const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
          // An UNTOUCHED default letter never persists as a per-draft note —
          // saving it would freeze today's mass template onto this draft and
          // detach it from future template edits. Empty note → the send keeps
          // using the live template.
          const untouched = d && d._defaultNote != null && ta.value === d._defaultNote;
          const noteVal = untouched ? "" : ta.value;
          const r = await fetch(API + "/drafts/" + did, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ note: noteVal }),
          });
          const t = tag(); if (t) t.textContent = r.ok ? "✓ saved" : "couldn’t save";
          if (d) d.note = noteVal;
        } catch (_) { const t = tag(); if (t) t.textContent = "couldn’t save"; }
      };
      const queueSave = () => { const t = tag(); if (t) t.textContent = "saving…"; clearTimeout(saveT); saveT = setTimeout(doSave, 700); };
      ta.addEventListener("input", () => { autoGrowMsg(ta); focusDraft(); queueSave(); });
      ta.addEventListener("focus", focusDraft);
      ta.addEventListener("blur", () => { clearTimeout(saveT); doSave(); });
    });
    requestAnimationFrame(() => wrap.querySelectorAll("textarea[data-draftmsg]").forEach(autoGrowMsg));
    wrap.querySelectorAll('input[data-dact="autogmp"], input[data-dact="summary"]').forEach(cb =>
      cb.addEventListener("change", () => renderDraftDoc()));
    wrap.querySelectorAll("[data-gmpupload]").forEach(inp =>
      inp.addEventListener("change", () => uploadGmpBill(inp)));
    wrap.querySelectorAll("[data-vecbillfile]").forEach(inp =>
      inp.addEventListener("change", () => uploadVecBill(inp)));
    const regen = wrap.querySelector("[data-regen]");
    if (regen) regen.onclick = () => selectOfftaker(regen.getAttribute("data-regen"), true);
    wireOfftakerEditors(wrap);
    wireResync(sid);   // stale utility bill → hands-off background re-sync + one-click regenerate
    // Load THIS offtaker's own generation spreadsheet card (self-hides if the
    // feature flag is off). The operator-wide master sheet loads once at page top.
    wrap.querySelectorAll(".rb-track-sub").forEach(loadTrackerInto);
    // Consolidate: drop the (already-wired) invoice-template box at the bottom of
    // the open card so the page reads as one element.
    foldTplIntoInbox(wrap.querySelector(".rb-acc-inner"));
  }

  // Switch the whole approval section to a chosen offtaker. If they already have a
  // pending draft, show it instantly; otherwise mint one on demand (idempotent — the
  // backend reuses/refreshes the period's draft) and refetch so it carries its live
  // Silently re-pull the latest GMP bill + recompute this offtaker's draft (the backend
  // /draft endpoint pulls the bound account fresh before computing), then refresh the
  // inbox so the figures update in place. Best-effort + debounced ≤1/min per offtaker so
  // browsing never stacks pulls; on any failure the cached draft stands (no error shown).
  const _bgRefreshed = {};   // subId -> last bg-refresh ms
  async function backgroundRefreshDraft(subId) {
    subId = String(subId);
    if (!authHeaders()) return;                          // demo / signed-out
    const nowMs = Date.now();
    if (_bgRefreshed[subId] && nowMs - _bgRefreshed[subId] < 60000) return;
    _bgRefreshed[subId] = nowMs;
    let dg;
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/draft",
        { method: "POST", headers: authHeaders() });
      if (!r.ok) return;
      dg = await r.json().catch(() => ({}));
    } catch (_) { return; }
    // The generation-time cross-check rides every /draft response — record it and
    // repaint the strip in place BEFORE the figures-changed short-circuit below
    // (the strip must fill in even when the draft numbers themselves didn't move).
    noteXcheck(subId, dg);
    // Update the figures IN PLACE — and ONLY if this offtaker is still open on its LATEST
    // version AND a figure actually changed. The usual case (the GMP bill hasn't moved) is
    // a no-op that touches NOTHING, so the page never silently rebuilds under the operator.
    // (Was: an unconditional refreshInbox() that wiped + rebuilt the whole accordion a few
    // seconds after every open — the "random refresh / jitter / reload" Ford reported.)
    if (!dg || !dg.draft || VIEWING_VERSION_ID != null || String(ACTIVE_SUB_ID) !== subId) return;
    const d = activeDraft();
    if (!d) return;
    const keys = ["array_total_kwh", "allocation_pct", "customer_kwh", "amount_usd",
      "invoice_number", "period_label", "budget_amount_usd", "solar_credit_value",
      "net_rate_per_kwh", "discount_pct", "has_gmp_pdf", "gmp_auto_status"];
    const changed = keys.some(k => (k in dg.draft) && dg.draft[k] !== d[k]);
    if (!changed) return;                                // nothing new → no repaint, no jitter
    keys.forEach(k => { if (k in dg.draft) d[k] = dg.draft[k]; });
    const card = document.querySelector(`.rb-acc[data-id="${subId}"] .rb-draft[data-did="${d.id}"]`);
    applyDraftFigures(card, d);                          // calc + preview only — never a list rebuild
    const pill = document.querySelector(`.rb-acc[data-id="${subId}"] .rb-chip-ready`);
    if (pill && d.amount_usd != null) pill.textContent = money(d.amount_usd) + " ready";
  }

  // envelope fields. `force` re-mints even when a draft already exists.
  async function selectOfftaker(subId, force) {
    subId = String(subId);
    VIEWING_VERSION_ID = null;          // a new offtaker always opens on its LATEST version
    _verFetched.delete(subId);          // re-fetch versions in case a new period landed
    if (DRAFT_BY_SUB[subId] && !force) {
      ACTIVE_SUB_ID = subId; ACTIVE_DRAFT_ID = DRAFT_BY_SUB[subId].id; renderInboxBody();
      // Show the cached draft instantly, but ALSO pull the latest GMP bill + recompute in
      // the BACKGROUND so a newly-released statement is reflected without a manual
      // regenerate — the figures refresh in place if anything changed.
      backgroundRefreshDraft(subId);
      return;
    }
    // Signed-out DEMO: never mint via the backend (it would 401). Just switch to the
    // offtaker; ones without a pre-built draft show the graceful empty state.
    if (!authHeaders() && window.AO_DEMO) {
      ACTIVE_SUB_ID = subId;
      GEN_FAIL[subId] = "This sample offtaker is set to auto-send — its invoice is delivered automatically each period. Sign in to set up your own.";
      renderInboxBody();
      return;
    }
    ACTIVE_SUB_ID = subId;
    delete GEN_FAIL[subId];
    GENERATING_SUB_ID = subId;
    _pinActiveSub = true;
    renderInboxBody();                 // show the loading card for this offtaker
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/draft",
        { method: "POST", headers: authHeaders() });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        GEN_FAIL[subId] = (e && e.detail) ? e.detail
          : "No billable period yet for this offtaker — its report appears here once a GMP bill lands.";
      } else {
        // Record the generation-time cross-check before the inbox re-render below,
        // so the freshly-minted card paints its verdict strip on first draw.
        noteXcheck(subId, await r.json().catch(() => ({})));
      }
    } catch (e) { GEN_FAIL[subId] = "Couldn't reach the server — try again."; }
    GENERATING_SUB_ID = null;
    _pinActiveSub = true;              // stay on this offtaker through the refetch
    await refreshInbox();              // refetch → DRAFT_BY_SUB updated → renders the draft or empty state
  }

  // Attach a GMP bill PDF to a draft by hand — the operator's fallback for when
  // auto-capture hasn't pulled the bill's PDF yet. POSTs to /drafts/{id}/gmp-invoice;
  // a manually-attached PDF takes precedence over auto-attach on send.
  async function uploadGmpBill(inp) {
    const did = inp.getAttribute("data-gmpupload");
    const file = inp.files && inp.files[0];
    if (!file) return;
    const box = inp.closest(".rb-gmp-manual");
    const stat = box && box.querySelector(".rb-gmp-upload-stat");
    const setStat = (cls, txt) => { if (stat) { stat.className = "rb-gmp-upload-stat " + cls; stat.textContent = txt; } };
    if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStat("rb-err", "Please choose a PDF."); inp.value = ""; return;
    }
    setStat("rb-busy", "Uploading…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      // NOTE: don't set Content-Type — the browser adds the multipart boundary.
      const r = await fetch(API + "/drafts/" + did + "/gmp-invoice",
        { method: "POST", headers: authHeaders(), body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setStat("rb-err", (e && e.detail) ? e.detail : ("Upload failed (HTTP " + r.status + ")."));
        inp.value = "";
        return;
      }
      const jr = await r.json().catch(() => ({}));
      const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
      if (d) { d.has_gmp_pdf = true; d.gmp_filename = (jr.draft && jr.draft.gmp_filename) || file.name; }
      renderInboxBody();   // chip flips to "✓ attached"; the live preview now shows the GMP bill
    } catch (e) { setStat("rb-err", "Network error — try again."); inp.value = ""; }
  }

  // Upload a VEC/SmartHub bill PDF for a bound utility account. The backend parses
  // the generation + the bill's own net-metering credit rate off the PDF into a
  // settled Bill, so the offtaker invoice auto-prices from it (like GMP). On
  // success we regenerate this offtaker's draft so the figures flip live.
  async function uploadVecBill(inp) {
    const uaid = inp.getAttribute("data-vecbillfile");
    const sid = inp.getAttribute("data-vbsid");
    const file = inp.files && inp.files[0];
    if (!file || !uaid) return;
    const box = inp.closest(".rb-vecbill");
    const stat = box && box.querySelector(".rb-vecbill-stat");
    const setStat = (cls, txt) => { if (stat) { stat.className = "rb-status rb-vecbill-stat " + (cls || ""); stat.textContent = txt; } };
    if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStat("rb-err", "Please choose a PDF."); inp.value = ""; return;
    }
    setStat("rb-busy", "Reading the bill…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(API + "/utility-accounts/" + uaid + "/vec-bill",
        { method: "POST", headers: authHeaders(), body: fd });
      const jr = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStat("rb-err", (jr && jr.detail) ? jr.detail : ("Couldn't read that bill (HTTP " + r.status + ")."));
        inp.value = ""; return;
      }
      const p = (jr && jr.parsed) || {};
      const kwh = p.kwh_generated != null ? fmt0(p.kwh_generated) + " kWh" : "bill";
      const rt = p.credit_rate != null ? " @ $" + p.credit_rate + "/kWh" : "";
      setStat("rb-ok", "✓ Read " + kwh + rt + " — recomputing the invoice…");
      // The new settled bill changes the math — regenerate this offtaker's draft.
      if (sid != null && sid !== "" && typeof selectOfftaker === "function") {
        selectOfftaker(String(sid), true);
      }
    } catch (e) { setStat("rb-err", "Network error — try again."); inp.value = ""; }
  }

  // ── Invoice version history (older drafts per offtaker) ──────────────────────
  let VIEWING_VERSION_ID = null;     // a draft id when reviewing an OLDER version; null = latest
  const VERSIONS_BY_SUB = {};        // subId -> [draft versions, latest first]
  const _verFetched = new Set();     // subIds whose versions we've fetched this view
  async function _ensureVersions(subId) {
    subId = String(subId);
    if (!subId || !authHeaders() || _verFetched.has(subId)) return;
    _verFetched.add(subId);
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/draft-versions", { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      VERSIONS_BY_SUB[subId] = j.versions || [];
      // Re-render so the dropdown appears, but only if there's actually history to show.
      if (String(ACTIVE_SUB_ID) === subId && VERSIONS_BY_SUB[subId].length > 1) renderInboxBody();
    } catch (_) {}
  }
  // The version dropdown beside the offtaker picker — only when >1 version exists.
  function verPickerHTML(subId) {
    const vs = VERSIONS_BY_SUB[String(subId)] || [];
    if (vs.length < 2) return "";
    const opts = vs.map((d, i) => {
      const amt = d.amount_usd != null
        ? " · $" + Number(d.amount_usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
      const label = (d.period_label || d.invoice_number || ("Draft #" + d.id)) + (i === 0 ? " · latest" : "") + amt;
      const val = i === 0 ? "" : String(d.id);
      const sel = String(VIEWING_VERSION_ID || "") === val ? " selected" : "";
      return `<option value="${esc(val)}"${sel}>${esc(label)}</option>`;
    }).join("");
    return `<label class="rb-ver-lab">Version <select class="rb-ver-pick" id="rbVerPick" title="View an older invoice version for this offtaker">${opts}</select></label>`;
  }
  function activeDraft() {
    // A selected OLDER version wins — a read-only look-back at a past invoice.
    if (VIEWING_VERSION_ID != null) {
      const v = (VERSIONS_BY_SUB[String(ACTIVE_SUB_ID)] || []).find(d => String(d.id) === String(VIEWING_VERSION_ID));
      if (v) return v;
    }
    // The selected OFFTAKER is the source of truth; its latest pending draft renders.
    if (ACTIVE_SUB_ID != null && DRAFT_BY_SUB[String(ACTIVE_SUB_ID)]) return DRAFT_BY_SUB[String(ACTIVE_SUB_ID)];
    return INBOX_DRAFTS.find(d => String(d.id) === String(ACTIVE_DRAFT_ID)) || null;
  }

  /* Live invoice preview beside the approval draft — a styled mock of exactly
   * what the offtaker receives, rebuilt in real time from the draft numbers, the
   * (live-edited) cover email, and the GMP-attach toggle. Mirrors the standard
   * backend invoice; the card's "Preview invoice" button still fetches the exact
   * PDF (incl. a custom template). */
  // "How we calculated this" — a transparent breakdown above the live preview so the
  // reviewer can trace latest bill → metered generation → their share → the rate math →
  // the solar-credit value (and any fixed budget override). All from the draft's figures.
  function calcDashboard(d) {
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    const explicitRate = d.net_rate_per_kwh != null;
    // 1-decimal, matching the editor (step=0.1) so 12.5% shows "12.5%", not "13%",
    // and the printed "× (1−X%)" reconciles with the server-computed total.
    const disc = d.discount_pct ? Math.round(d.discount_pct * 1000) / 10 : 0;
    // Disclosure: a discount can be applied without the operator setting one (backend
    // auto-resolves a default). Surface that plainly so this panel never shows a silent
    // discount. Purely a label — the money is server-computed.
    const autoDisc = d.discount_pct == null && d.resolved_discount_pct != null && d.resolved_discount_pct > 0;
    const autoDiscPct = autoDisc ? Math.round(d.resolved_discount_pct * 1000) / 10 : null;
    // A budget bill is keyed on budget_amount_usd ALONE — never inferred from the dollar
    // total. This panel is "how we calculated this invoice": it must ALWAYS land on the
    // genuine production calculation and surface the budget only as a separate override
    // line — it must NEVER present the budget as if it were the calculated credit.
    const budgetSet = d.budget_amount_usd != null;
    const gmpReady = d.has_gmp_pdf || (d.auto_attach_gmp !== false && d.gmp_auto_status === "ready");
    const billUrl = gmpReady ? `${API}/drafts/${d.id}/gmp-bill` : null;
    // The CALCULATED solar-credit value (production × real net-metering rate), independent
    // of any budget. With a budget set this is solar_credit_value (the pre-override amount);
    // with NO budget it's amount_usd (which IS the calculated total). When a budget is set
    // but solar_credit_value hasn't reached us, we have NO genuine calculated value — so we
    // must NOT fall back to amount_usd (that's the budget, and budget ÷ kWh is exactly the
    // fake $2.42718/kWh bug). Leave it null and show the value as pending instead.
    const creditVal = budgetSet ? (d.solar_credit_value != null ? d.solar_credit_value : null)
                                : d.amount_usd;
    // ALWAYS surface the per-kWh rate that turns production into that credit, so the
    // multiplication kWh × rate = $ is visible. Use the operator's set rate when there is
    // one; otherwise show the EFFECTIVE rate implied by the bill's net-metering credit
    // (CALCULATED credit ÷ kWh — never budget ÷ kWh) — so an offtaker priced straight off
    // the bill isn't a mystery jump.
    const effRate = (d.customer_kwh && creditVal != null) ? (creditVal / d.customer_kwh) : null;
    const shownRate = explicitRate ? d.net_rate_per_kwh : effRate;
    const ratePfx = explicitRate ? "" : "≈ ";
    const rateTxt = shownRate != null ? `${ratePfx}$${Number(shownRate).toFixed(5)}/kWh` : "—";
    // Which discount to show as the "− X%" chip: the operator's explicit one, or the
    // auto-applied default when they set none. (With an implicit bill rate the effective
    // ≈rate already bakes the discount in, so we disclose it as a note, not a second chip.)
    const shownDisc = disc || autoDiscPct || 0;
    const rateMath = (shownRate != null && d.customer_kwh != null)
      ? `${fmt0(d.customer_kwh)} kWh × ${ratePfx}$${Number(shownRate).toFixed(5)}/kWh${(explicitRate && shownDisc) ? ` × (1−${shownDisc}%)` : ""}`
      : (explicitRate ? "" : "from the bill's net-metering credit");
    const rateRow =
      `<div class="rb-calc-row"><span class="rb-calc-k">Solar credit rate`
      + `${explicitRate ? "" : "<small>effective — from the bill's net-metering credit</small>"}`
      + `${autoDisc ? `<small>${autoDiscPct}% discount (default — auto-applied)</small>` : ""}</span>`
      + `<span class="rb-calc-v">${rateTxt}${(explicitRate && shownDisc) ? ` <span class="rb-calc-eq">− ${shownDisc}%</span>` : ""}</span></div>`;
    // The calculated credit value: the genuine number when we have it; "computing…" when a
    // budget is set but the calculated value hasn't landed yet (NEVER the budget amount).
    const creditDue = creditVal != null ? money(creditVal) : "computing…";
    const totalRows = budgetSet
      ? `<div class="rb-calc-row sub"><span class="rb-calc-k">Solar credit value<small>${esc(rateMath)}</small></span><span class="rb-calc-v">${creditDue}</span></div>
         <div class="rb-calc-row total"><span class="rb-calc-k">Budget bill — fixed total<small>overrides the calculated value</small></span><span class="rb-calc-v">${money(d.amount_usd)}</span></div>`
      : `<div class="rb-calc-row total"><span class="rb-calc-k">Solar credit value due<small>${esc(rateMath)}</small></span><span class="rb-calc-v">${money(d.amount_usd)}</span></div>`;
    return `
      <div class="rb-calc">
        <div class="rb-calc-h">How we calculated this invoice</div>
        <div class="rb-calc-row"><span class="rb-calc-k">Latest GMP bill</span>
          <span class="rb-calc-v">${esc(d.period_label || "latest period")}${billUrl ? ` <button type="button" class="rb-calc-link" data-dl="${esc(billUrl)}" data-fn="${esc(gmpBillFilename(d))}">view ↓</button>` : ""}</span></div>
        <div class="rb-calc-row"><span class="rb-calc-k">Array generation<small>metered on the bill</small></span><span class="rb-calc-v">${fmt0(d.array_total_kwh)} kWh</span></div>
        <div class="rb-calc-row"><span class="rb-calc-k">${esc(d.customer_name || "This offtaker")}'s share</span>
          <span class="rb-calc-v">${pct != null ? pct + "%" : "—"}${pct != null ? ` <span class="rb-calc-eq">= ${fmt0(d.customer_kwh)} kWh</span>` : ""}</span></div>
        ${rateRow}
        ${totalRows}
      </div>`;
  }

  // The send actions, lifted ABOVE the live preview (Paul's review flow). Disabled when
  // reviewing an OLDER version (look-only) — switch to latest to send.
  function reviewActions(d, readonly) {
    // "Preview" downloads the exact PDF that gets sent (the old summary-row Preview
    // button, absorbed here). Approve & send is the blue primary; Send-to-me + Preview
    // are quiet secondaries beside it.
    return `
      <div class="rb-review-acts">
        <button class="ao-btn ao-btn-primary rb-btn rb-btn-lg" data-dact="approve"${readonly ? ' disabled title="Viewing an older version — switch to “latest” to send."' : ""}>Approve &amp; send</button>
        <button class="ao-btn rb-btn" data-dact="sendme" type="button" title="Email a test copy to yourself first"${readonly ? " disabled" : ""}>Send to me</button>
        <button class="ao-btn rb-btn" data-dact="preview" type="button" title="Open the exact invoice PDF in a new tab">Preview ↗</button>
        <span class="rb-status rb-draft-status"></span>
      </div>`;
  }

  // The calc dashboard's "view ↓" bill button. The dashboard now lives in the FORM
  // column (between the offtaker name and the cover email), so wire its link wherever
  // the dashboard is (re)rendered — initial body render + post-recompute repaint.
  function wireCalcLinks(root) {
    if (!root) return;
    root.querySelectorAll(".rb-calc-link[data-dl]").forEach(b => b.onclick = () =>
      downloadAttachment(b.getAttribute("data-dl"), b.getAttribute("data-fn")));
  }

  // Render the review ACTIONS (Approve & send …) above the live preview. Kept in its
  // OWN container so it repaints only when figures change — not on every keystroke.
  // (The calc dashboard moved to the form column; see draftCard.)
  function renderReviewTop() {
    const top = $("#rbReviewTop");
    if (!top) return;
    const d = activeDraft();
    if (!d) { top.innerHTML = ""; return; }
    // A one-line "what gets sent" summary sits beside the send actions in the top bar,
    // so the operator can review-and-send without expanding anything below.
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    const src = d.utility_account_name || d.array_name || "";
    const summary = `<div class="rb-reviewbar-sum">Receives <b>${pct != null ? pct + "%" : "a share"}</b>${src ? " of " + esc(src) : ""}`
      + ` &middot; ${esc(d.period_label || "latest period")} &middot; <b>${money(d.amount_usd)} due</b></div>`;
    top.innerHTML = summary + reviewActions(d, VIEWING_VERSION_ID != null);
    top.querySelectorAll("[data-dact]").forEach(b => b.onclick = onDraftAction);
  }

  function renderDraftDoc() {
    const pane = $("#rbDraftDocPane");
    if (!pane) return;
    const d = activeDraft();
    if (!d) { pane.innerHTML = ""; return; }

    // Live state from the card (note edits + GMP-attach toggle repaint this).
    const layout = pane.closest(".rb-layout");
    const card = layout && layout.querySelector(`.rb-draft[data-did="${d.id}"]`);
    const ta = card && card.querySelector(`textarea[data-draftmsg="${d.id}"]`);
    const note = ta ? ta.value : (d.note || d.email_letter_default || defaultDraftNote(d));
    const autoCb = card && card.querySelector('input[data-dact="autogmp"]');
    const autoOn = autoCb ? autoCb.checked : (d.auto_attach_gmp !== false);
    const sumCb = card && card.querySelector('input[data-dact="summary"]');
    const sumOn = sumCb ? sumCb.checked : (d.include_summary === true);   // OFF by default

    const period = d.period_label || "latest period";
    const kwh = d.customer_kwh != null ? fmt0(d.customer_kwh) + " kWh" : "—";

    // ── Envelope — faithful to the backend's _email_html (subject/from/to). ──
    // The backend renders the subject from the tenant's mass template
    // (email_subject_default); fall back to the default construction.
    const subject = d.email_subject_default
      || (`Your solar credit invoice — ${d.customer_name || "your offtaker"}`
          + (d.invoice_number ? ` (${d.invoice_number})` : ""));
    const fromName = d.operator_name || "Your operator account";
    const toClient = !!(d.send_mode && d.send_mode !== "to_me");
    const toLine = toClient
      ? esc(d.customer_name || "your offtaker") + (d.client_email ? ` &lt;${esc(d.client_email)}&gt;` : "")
      : "you (operator copy — “Send to: Me”)";

    // ── Attachments — faithful: invoice + summary (if on) + the GMP bill. ──
    const slug = String(d.customer_name || "offtaker").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "offtaker";
    const invSuffix = d.invoice_number ? "_" + d.invoice_number : "";
    const sid = d.subscription_id;
    // Each chip carries a `url` — clicking downloads that exact file. The GMP bill
    // is downloadable once captured (manual attach OR auto-capture ready); until
    // then it's a non-clickable "pending" chip.
    const atts = [{
      ico: "📄", name: `invoice_${slug}${invSuffix}.pdf`,
      sub: `${money(d.amount_usd)} · solar credit invoice`, state: "ready",
      url: sid ? `${API}/subscriptions/${sid}/preview?kind=invoice&fmt=pdf` : null,
    }];
    if (sumOn) atts.push({
      ico: "📈", name: `production_summary_${slug}.pdf`,
      sub: "generation + savings report", state: "ready",
      url: sid ? `${API}/subscriptions/${sid}/preview?kind=summary&fmt=pdf` : null,
    });
    if (d.has_gmp_pdf || (autoOn && d.gmp_auto_status === "ready")) atts.push({
      ico: "🧾", name: gmpBillFilename(d),
      sub: "the GMP bill behind this invoice", state: "ready",
      url: `${API}/drafts/${d.id}/gmp-bill`,
    });
    else if (autoOn) atts.push({
      ico: "🧾", name: "GMP utility bill",
      sub: "attaches automatically once captured", state: "pending", url: null,
    });
    const attChips = atts.map(a => {
      const dl = a.url ? ` data-dl="${esc(a.url)}" data-fn="${esc(a.name)}"` : " disabled";
      const tag = a.state === "pending" ? "pending" : "download ↓";
      return `<button type="button" class="rb-eml-att ${a.state}${a.url ? "" : " disabled"}"${dl} title="${a.url ? "Download " + esc(a.name) : "Not captured yet"}">
        <span class="ico">${a.ico}</span>
        <span class="meta"><b>${a.name}</b><small>${a.sub}</small></span>
        <span class="tag">${tag}</span>
      </button>`;
    }).join("");

    // ── Cover body — note → figure table → attached line (mirrors _email_html). ──
    const noteHtml = note && note.trim()
      ? `<div class="rb-eml-note">${esc(note.trim()).replace(/\n/g, "<br>")}</div>` : "";
    const attWord = sumOn
      ? "invoice and performance summary are" : "invoice is";

    pane.innerHTML = `
      <div class="rb-doc-cap">Live preview — the email ${esc(toClient ? (d.customer_name || "your offtaker") : "you")} receive${toClient ? "s" : ""}</div>
      <div class="rb-eml">
        <div class="rb-eml-head">
          <div class="row"><span class="k">From</span><span class="v">${esc(fromName)} <small>via Array Operator</small></span></div>
          <div class="row"><span class="k">To</span><span class="v">${toLine}</span></div>
          <div class="row"><span class="k">Subject</span><span class="v subj">${esc(subject)}</span></div>
        </div>
        <div class="rb-eml-body">
          ${noteHtml}
          <table class="rb-eml-figs">
            <tr><td>Billing period</td><td>${esc(period)}</td></tr>
            <tr><td>Your production</td><td>${kwh}</td></tr>
            ${(d.budget_amount_usd != null)
              ? `<tr><td>Solar credit value due</td><td>${d.solar_credit_value != null ? money(d.solar_credit_value) : "computing…"}</td></tr>
                 <tr class="due"><td>Budgeted amount</td><td>${money(d.amount_usd)}</td></tr>`
              : `<tr class="due"><td>Solar credit value due</td><td>${money(d.amount_usd)}</td></tr>`}
          </table>
          <p class="rb-eml-attline">The full ${attWord} attached.</p>
        </div>
        <div class="rb-eml-atts">
          <div class="lab">📎 ${atts.length} attachment${atts.length === 1 ? "" : "s"}</div>
          ${attChips}
        </div>
      </div>
      ${sid
        ? `<div class="rb-doc-cap" style="margin-top:15px">Inside the invoice attachment</div>
           ${(TEMPLATE_STATE && TEMPLATE_STATE.has) ? `<div class="rb-tpl-prevbtns rb-invfmt-btns">
             <button type="button" class="ao-btn rb-btn" data-invfmt="default">View our default format</button>
             <button type="button" class="ao-btn rb-btn" data-invfmt="template">View your reproduced template</button>
           </div>` : ""}
           <div class="rb-tpl-paper" id="rbDraftInvPaper"><div class="rb-tpl-load">Rendering invoice…</div></div>` : ""}
      <p class="rb-doc-hint">A faithful copy of the email${toClient ? " your offtaker" : ""} receives, with its attachments.
        The invoice shown below is the exact PDF that gets attached${d.has_gmp_pdf ? "; the GMP bill rides along automatically" : ""}.</p>`;

    // Render the ACTUAL reproduced invoice (the exact PDF that gets attached/sent) onto
    // a canvas — same source as the attachment chip + "Preview invoice", so it shows
    // THIS offtaker's real values, not the lossy token-HTML that left sample text in.
    if (sid) {
      const paper = pane.querySelector("#rbDraftInvPaper");
      const invBtns = pane.querySelectorAll("[data-invfmt]");
      // Render the invoice in a given variant ("default" = our standard format,
      // "template" = the operator's reproduced template, forced even if toggled
      // off) and light its button. Lets the operator compare without changing the
      // saved format (the slider commits; these buttons just preview).
      const showInv = (variant) => {
        invBtns.forEach(b => b.classList.toggle("on", b.getAttribute("data-invfmt") === variant));
        if (!paper) return;
        paper.innerHTML = '<div class="rb-tpl-load">Rendering invoice…</div>';
        fetch(`${API}/subscriptions/${sid}/preview?kind=invoice&fmt=pdf&variant=${variant}`, { headers: authHeaders() })
          .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("preview " + r.status)))
          .then(buf => renderPdfToPaper(buf, paper))
          .catch(() => { paper.innerHTML =
            '<div class="rb-tpl-load">Invoice preview unavailable — use “Preview invoice” for the exact PDF.</div>'; });
      };
      invBtns.forEach(b => b.onclick = () => showInv(b.getAttribute("data-invfmt")));
      // Default view = the format that actually gets sent (honors the slider).
      showInv((TEMPLATE_STATE && TEMPLATE_STATE.enabled) ? "template" : "default");
    }
    // Clicking an attachment chip downloads that exact file.
    pane.querySelectorAll(".rb-eml-att[data-dl]").forEach(b => b.onclick = () =>
      downloadAttachment(b.getAttribute("data-dl"), b.getAttribute("data-fn")));

    // Signed-out DEMO: drafts carry a null subscription_id (no live PDF fetch), so
    // append a styled sample invoice in place of the backend-rendered one.
    if (!authHeaders() && window.AO_DEMO && d && d._demo) injectDemoInvoice();
  }

  // Fetch a file with the session bearer and save it (true download, not a tab).
  async function downloadAttachment(url, filename) {
    if (!url) return;
    try {
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return;
      const u = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = u; a.download = filename || "attachment";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } catch (e) { /* swallow — never break the preview */ }
  }

  function draftCard(d, utilAccts) {
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    // Remember the auto-written note so a live recompute can re-sync it — but only
    // while the operator hasn't customized it (we compare against this snapshot).
    d._defaultNote = d.email_letter_default || defaultDraftNote(d);
    const auto = d.auto_attach_gmp !== false;   // ON by default
    const sumOn = d.include_summary === true;    // OFF by default — AO summary is opt-in (Ford)
    // Honest auto-attach status line (never implies a PDF exists when it doesn't).
    const autoStatusText = {
      ready: "✓ GMP bill found — it will attach automatically.",
      pending: "GMP bill will attach automatically once it's captured (none yet).",
      no_gmp: "No GMP account on this array yet — connect one to auto-attach.",
    }[d.gmp_auto_status] || "";
    // Attachment controls box — sits beside the send buttons (Ford). Auto-attach the
    // GMP bill (on by default) + opt-in Array Operator summary data (off by default).
    const attachBox = `
      <div class="rb-draft-attach">
        <label class="rb-gmp-switch">
          <input type="checkbox" data-dact="autogmp" ${auto ? "checked" : ""}>
          <span>Auto-attach the GMP bill</span>
        </label>
        ${auto && autoStatusText ? `<span class="rb-gmp-auto-status rb-gmp-${esc(d.gmp_auto_status)}">${autoStatusText}</span>` : ""}
        <label class="rb-gmp-switch">
          <input type="checkbox" data-dact="summary" ${sumOn ? "checked" : ""}>
          <span>Attach Array Operator's summary data</span>
        </label>
        ${d.has_gmp_pdf
          ? `<div class="rb-gmp-manual">
               <span class="rb-gmp-ok">✓ GMP bill attached${d.gmp_filename ? " · " + esc(d.gmp_filename) : ""}</span>
               <label class="rb-gmp-upload-link" title="Replace the attached GMP bill PDF">Replace<input type="file" accept="application/pdf,.pdf" data-gmpupload="${d.id}" hidden></label>
               <span class="rb-gmp-upload-stat"></span>
             </div>`
          : ""}
      </div>`;
    // Simplified expanded card (Ford 2026-06-28): the send decision + a one-line summary
    // live in the top bar (renderReviewTop) and the live email+invoice preview stays on
    // the right; everything else folds into collapsed <details> sections here. Native
    // <details> keeps every element in the DOM, so all the existing wiring (auto-save,
    // toggles, offtaker editor, tracker, template fold, calc link) still finds + wires
    // them — they're just hidden until the operator opens the section.
    const sid = d.subscription_id;
    const sec = (title, body, sub, open) =>
      `<details class="rb-sec"${open ? " open" : ""}>
        <summary class="rb-sec-h"><span class="rb-sec-caret" aria-hidden="true">▸</span><span class="rb-sec-t">${title}</span>${sub ? `<span class="rb-sec-sub">${esc(sub)}</span>` : ""}</summary>
        <div class="rb-sec-body">${body}</div>
      </details>`;
    const emailBody = `
      <div class="rb-draft-email">
        <span class="rl">Email to your offtaker <span class="rb-email-saved" aria-live="polite"></span></span>
        <textarea class="rb-draft-msg" data-draftmsg="${d.id}" rows="6"
          placeholder="Write the note your offtaker sees…">${esc(d.note || d.email_letter_default || defaultDraftNote(d))}</textarea>
        <span class="rb-draft-msg-hint">Saves automatically as you type. The invoice${d.has_gmp_pdf ? " + GMP bill are" : " is"} attached for you.</span>
      </div>`;
    // The per-offtaker template box (#rbTpl) is folded into .rb-tpl-slot by foldTplIntoInbox.
    const tplSlot = `<div class="rb-tpl-slot"></div>`;
    const trackerBox = sid
      ? `<div class="rb-track rb-track-sub" data-tracker-base="${API}/subscriptions/${sid}/tracker" data-tracker-scope="offtaker" data-tracker-name="${esc(d.customer_name || "")}" hidden></div>`
      : `<p class="rb-sec-empty">Save this offtaker to add a generation spreadsheet.</p>`;
    // Bill accuracy check — the production-vs-bill + GMP-allocation cross-check for
    // THIS offtaker (from /reconcile-bills, indexed by sub_id). Only shown when we
    // have a reconcile row; opens by default when a hard allocation mismatch was
    // caught so the $25 catch is visible without a click. If the reconcile data
    // hasn't arrived yet on first paint, expandAccordion re-renders once it lands.
    const bacBody = sid != null ? reconPanelHTML(sid) : null;
    const bacFlagged = sid != null && reconFlagged(sid);
    const bacSec = bacBody
      ? sec("Bill accuracy check", bacBody, reconSecSub(sid), bacFlagged)
      : "";
    return `
      <div class="rb-draft" data-did="${d.id}" data-subid="${d.subscription_id}">
        <div class="rb-draft-top">
          <div class="rb-draft-name">${esc(d.customer_name)}</div>
          <div class="rb-draft-period">${esc(d.period_label || "latest period")}</div>
        </div>
        ${sid != null ? `<div class="rb-xcheck-host" data-xcheck="${esc(String(sid))}">${xcheckHTML(sid)}</div>` : ""}
        ${sec("Offtaker details", offtakerEditor(d, utilAccts) + attachBox, "share, rate, schedule, delivery", false)}
        ${sec("Edit email", emailBody, "the note your offtaker sees", false)}
        ${sec("Invoice template", tplSlot, "PDF / Excel format", false)}
        ${sec("Generation spreadsheet", trackerBox, "their tracking sheet", false)}
        ${sec("How this was calculated", calcDashboard(d), "the math behind the amount", false)}
        ${bacSec}
        <p class="rb-draft-note">Sends to <b>${esc(d.customer_name)}</b> per the delivery setting,
           with the offtaker invoice${d.has_gmp_pdf ? " and the GMP bill" : ""} attached.
           <b>Nothing sends until you click Approve &amp; send</b> (at the top).</p>
      </div>`;
  }

  // The inline, live offtaker-detail editor that sits under each draft in the
  // approval inbox. Every field maps to a SubscriptionPatch field (data-of) and
  // persists on edit; copy fields repaint the preview instantly, money fields
  // (share / discount / rate / GMP bill) recompute the draft figures via the
  // production path (generate_draft → build_manual_match), so the numbers the
  // operator sees stay true. Mirrors the per-offtaker Edit form one-to-one.
  // ── Invoice-time utility resync ──────────────────────────────────────────
  // A utility-bound offtaker's invoice is only as fresh as the last captured bill.
  // GMP/VEC/WEC bills land via the extension, so when the latest one on file is old
  // we auto-trigger a HANDS-OFF background re-sync (SO_RECAPTURE → the extension's
  // recaptureNow, which now auto-logs-in from the saved utility password) and, once
  // a newer bill lands, offer one-click regenerate. No manual "open the portal +
  // sign in + refresh" dance. Degrades gracefully: no extension → the banner just
  // offers the manual button; no creds → the extension surfaces its own sign-in.
  const RESYNC_STALE_DAYS = 35;          // a monthly bill should have landed by now
  let _extPresent = false;
  const _resyncFired = new Set();        // offtaker sids we've auto-synced this session
  try {
    window.addEventListener("message", (e) => {
      if (e.source === window && e.origin === window.location.origin && e.data &&
          (e.data.type === "SO_EXTENSION_PRESENT" || e.data.type === "SO_STATUS_ACK")) _extPresent = true;
    });
  } catch (_) {}

  function _billDaysOld(acct) {
    const t = acct && acct.latest_period_end ? Date.parse(acct.latest_period_end) : NaN;
    return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
  }
  // Post SO_RECAPTURE to the extension bridge → background recapture (auto-login aware).
  function requestUtilityResync(provider, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const reqId = "rb-resync-" + provider + "-" + Date.now() + "-" + Math.random();
      let settled = false;
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
        if (e.data.type === "SO_RECAPTURE_DONE" && e.data.reqId === reqId) {
          settled = true; window.removeEventListener("message", onMsg);
          resolve({ ok: !!e.data.ok, captured: !!e.data.captured, error: e.data.error || null });
        }
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ type: "SO_RECAPTURE", vendor: provider, reqId }, window.location.origin); }
      catch (_) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "post-failed" }); return; }
      setTimeout(() => { if (!settled) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
    });
  }
  // The banner HTML — only for a utility-bound offtaker whose latest bill is stale/absent.
  function resyncBanner(d, utilAccts) {
    const boundAcct = (utilAccts || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
    if (!boundAcct) return "";
    const prov = (boundAcct.provider || "gmp").toLowerCase();
    const days = _billDaysOld(boundAcct);
    if (days != null && days <= RESYNC_STALE_DAYS) return "";   // already fresh → no banner
    const sid = d.subscription_id;
    const provLabel = prov === "gmp" ? "GMP" : prov.toUpperCase();
    const msg = days == null
      ? `No ${provLabel} bill on file yet for this offtaker.`
      : `Latest ${provLabel} bill is from ${esc(boundAcct.latest_period_label || "—")} — ${days} days ago.`;
    return `<div class="rb-resync" data-resync-sid="${sid}" data-resync-prov="${esc(prov)}">
      <span class="rb-resync-msg">${msg}</span>
      <button type="button" class="rb-resync-btn" data-resync-go="${sid}">↻ Re-sync latest bill</button>
      <span class="rb-resync-status" aria-live="polite"></span></div>`;
  }
  // Wire the banner after render: manual button + a one-time hands-off auto-sync on open.
  function wireResync(sid) {
    const banner = document.querySelector(`.rb-resync[data-resync-sid="${sid}"]`);
    if (!banner) return;
    const prov = banner.getAttribute("data-resync-prov");
    const statusEl = banner.querySelector(".rb-resync-status");
    const btn = banner.querySelector(".rb-resync-btn");
    let busy = false;
    const run = async () => {
      if (busy) return; busy = true;
      if (btn) btn.disabled = true;
      if (statusEl) statusEl.textContent = "Re-syncing your latest bill…";
      const res = await requestUtilityResync(prov);
      busy = false; if (btn) btn.disabled = false;
      if (res.ok && res.captured) {
        if (statusEl) statusEl.innerHTML = `✓ Latest bill synced — <button type="button" class="rb-resync-regen" data-regen="${esc(String(sid))}">regenerate to use it</button>`;
        const rg = statusEl.querySelector("[data-regen]");
        if (rg) rg.onclick = () => selectOfftaker(sid, true);
        try { window.dispatchEvent(new CustomEvent("ao:utility-accounts-changed")); } catch (_) {}
        try { await refreshList(); } catch (_) {}
      } else if (res.ok) {
        if (statusEl) statusEl.textContent = "No newer bill found yet.";
      } else if (res.error === "timeout" || res.error === "post-failed") {
        if (statusEl) statusEl.textContent = "Couldn't reach the portal — open it once and sign in, then it stays hands-off.";
      } else {
        if (statusEl) statusEl.textContent = "Re-sync needs the EnergyAgent extension + your saved utility login.";
      }
    };
    if (btn) btn.onclick = run;
    // Hands-off: auto-sync once per offtaker per session when the extension is present.
    if (_extPresent && !_resyncFired.has(String(sid))) { _resyncFired.add(String(sid)); run(); }
  }

  // ── Solar credit rate row for the accordion editor (Bruce C6) ──────────────
  // GMP-bound offtakers price from the BILL's own net-metering credit rate, so the
  // editable $/kWh field is gone for them (Bruce: "have it only default to rate
  // scraped from bill"):
  //   • no override saved → a read-only line showing the bill-derived rate when the
  //     draft carries enough to compute it (credit ÷ kWh ÷ (1−discount) — exactly
  //     inverting the invoice math), else an honest "read from each GMP bill";
  //   • a legacy manual override → its value shown read-only + a one-click "Clear
  //     override — use the bill rate" (no hidden state, reversible);
  //   • VEC/SmartHub, unbound, workbook-priced and legacy-flat offtakers keep the
  //     fully-functional manual input (no bill-scraped rate is their source of truth).
  function rateFieldHTML(d, utilAccts) {
    const accts = utilAccts || INBOX_UTIL_ACCTS || [];
    const boundAcct = accts.find(a => String(a.utility_account_id) === String(d.utility_account_id));
    const boundProv = boundAcct ? (boundAcct.provider || "gmp").toLowerCase() : "";
    const subRec = OFFTAKERS.find(x => String(x.id) === String(d.subscription_id)) || {};
    const wb = d.has_workbook === true;
    const legacyFlat = subRec.rate_per_kwh != null && subRec.rate_per_kwh > 0;
    // Bill-scraped = the GMP bill is the pricing source of truth: GMP-bound, no
    // legacy flat $/kWh, and (for workbook offtakers) an explicit share set — that
    // combination routes billing through the bill path (delivery.build_manual_match).
    const billScraped = boundProv === "gmp" && !legacyFlat && (!wb || d.allocation_pct != null);
    if (!billScraped) {
      const rate = d.net_rate_per_kwh != null ? d.net_rate_per_kwh : "";
      return `<label class="rep-fld rb-rate-fld"><span class="rl">Solar credit rate ($/kWh)</span>
            <input type="number" data-of="net_rate_per_kwh" min="0" step="0.0001" value="${rate}" placeholder="blank = auto from bill"></label>`;
    }
    if (d.net_rate_per_kwh != null) {
      return `<div class="rep-fld rb-rate-fld" data-rate-readonly="1"><span class="rl">Solar credit rate</span>
            <span class="rb-rate-auto rb-rate-warn"><b>$${Number(d.net_rate_per_kwh).toFixed(5)}/kWh</b> — manual override; your GMP bill's own credit rate is ignored while it's set.</span>
            <button type="button" class="ao-btn rb-btn rb-rate-clear">Clear override — use the bill rate</button></div>`;
    }
    // Just-cleared override: the local figures still reflect the override until the
    // server recompute lands, so deriving now would flash the OLD rate labeled as
    // the bill's. Show an honest transient instead (applyDraftFigures clears it).
    if (d._ratePending) {
      return `<div class="rep-fld rb-rate-fld" data-rate-readonly="1"><span class="rl">Solar credit rate</span>
          <span class="rb-rate-auto">Override cleared — recalculating from your GMP bill…</span></div>`;
    }
    // Never derive a "rate" from a budget-overridden total — that's not a rate.
    const budgetSet = d.budget_amount_usd != null;
    const creditVal = budgetSet ? (d.solar_credit_value != null ? d.solar_credit_value : null) : d.amount_usd;
    const discFrac = d.discount_pct != null ? d.discount_pct
      : (subRec.resolved_discount_pct != null ? subRec.resolved_discount_pct : null);
    let billRate = null;
    if (creditVal != null && creditVal > 0 && d.customer_kwh > 0
        && discFrac != null && discFrac >= 0 && discFrac < 1) {
      billRate = creditVal / d.customer_kwh / (1 - discFrac);
    }
    const line = billRate != null
      ? `<b>$${billRate.toFixed(5)}/kWh</b> — from your GMP bill${d.period_label ? " (" + esc(d.period_label) + ")" : ""}`
      : `Read from each GMP bill automatically — shows here once a bill settles.`;
    return `<div class="rep-fld rb-rate-fld" data-rate-readonly="1"><span class="rl">Solar credit rate</span>
          <span class="rb-rate-auto">${line}</span></div>`;
  }

  function offtakerEditor(d, utilAccts) {
    const sid = d.subscription_id;
    if (!sid) return "";
    const wb = d.has_workbook === true;        // workbook offtakers bill from the sheet
    // Editor prefills show the FULL 3-decimal percent (Bruce: "e.g. 24.783") —
    // the old 1-decimal rounding meant any touch of the field saved back 24.8%,
    // destroying the stored third decimal. Whole shares render as 25.000 (consistent).
    const pct = d.allocation_pct != null ? (d.allocation_pct * 100).toFixed(3) : "";
    const disc = d.discount_pct != null ? Math.round(d.discount_pct * 1000) / 10 : "";
    // Disclosure: when the operator never set a discount but one is still applied, the
    // backend auto-resolves a default (tenant default → 10%). Surface it plainly so the
    // blank field never hides a live discount the customer is actually billed at.
    const autoDisc = d.discount_pct == null && d.resolved_discount_pct != null && d.resolved_discount_pct > 0;
    const autoDiscPct = autoDisc ? Math.round(d.resolved_discount_pct * 1000) / 10 : null;
    const cad = d.cadence || "monthly";
    const sm = d.send_mode || "to_me";
    // The subscription record carries the cross-check share + invoice seed + array id
    // (the draft `d` may not). Look it up from the canonical offtaker list so the edit
    // fields pre-fill. The commissioning date lives on the array (fetched lazily on wire).
    const subRec = OFFTAKERS.find(x => String(x.id) === String(sid)) || {};
    const sharePct = subRec.array_share_pct != null ? (subRec.array_share_pct * 100).toFixed(3) : "";
    const invStart = subRec.invoice_number_start != null ? subRec.invoice_number_start : "";
    const editArrayId = subRec.array_id != null ? subRec.array_id : (d.array_id != null ? d.array_id : "");
    // Is the bound account a VEC/SmartHub one? Those bills don't expose the credit
    // rate in the portal, so we offer a bill-PDF upload that reads the generation +
    // net-metering rate off the PDF (then the invoice auto-prices like GMP).
    const boundAcct = (utilAccts || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
    const boundProv = boundAcct ? (boundAcct.provider || "gmp").toLowerCase() : "";
    const isSmartHubBound = !!boundProv && boundProv !== "gmp";
    const billOpts = (utilAccts || []).map(a => {
      // Provider-aware: GMP shows its paper-bill count; VEC/SmartHub shows a "VEC ·"
      // tag (it has no GMP-shaped bill — it bills from measured generation × rate).
      const prov = (a.provider || "gmp").toLowerCase();
      const isGmp = prov === "gmp";
      const bills = isGmp
        ? (a.bill_count != null ? ` (${a.bill_count} bill${a.bill_count === 1 ? "" : "s"})`
                                : (a.has_bill ? " (bill on file)" : ""))
        : "";
      const tag = isGmp ? "" : prov.toUpperCase() + " · ";
      // Label by the array name the account feeds (recognizable site), not the raw
      // account number. Fall back to nickname, then the account number.
      const nm = a.array_name || a.nickname;
      const lbl = nm ? (tag + nm + bills) : (tag + "acct " + (a.account_number || "?") + bills);
      const sel = String(a.utility_account_id) === String(d.utility_account_id) ? "selected" : "";
      return `<option value="${a.utility_account_id}" ${sel}>${esc(lbl)}</option>`;
    }).join("");
    // Show the GMP-bill link for EVERY offtaker, INCLUDING workbook offtakers. The linked
    // utility_account_id drives the GMP-bill auto-attach (api/billing/delivery.py); it does
    // NOT change a workbook offtaker's amount (that bills from source_workbook, which takes
    // precedence) — it only sets which GMP bill attaches. Was gated on !wb, so workbook
    // offtakers (e.g. Paul's Valley Cares) had no way to link a utility bill at all.
    const showBillPicker = (utilAccts || []).length > 0;
    return `
      <div class="rb-offedit" data-offedit="${sid}">
        <div class="rb-offedit-h">
          <span class="rl">Offtaker details</span>
          <span class="rb-offedit-hint">Edits save to this offtaker and update the preview live.</span>
          <button type="button" class="rb-offedit-del" data-del-offtaker="${sid}"
                  title="Permanently delete this offtaker">🗑 Delete offtaker</button>
        </div>
        ${resyncBanner(d, utilAccts)}
        <!-- Required-field marking (Bruce C5): .req mirrors ofPatchBody's actual
             semantics — name / utility account / share % refuse to save blank
             (return null); every other field persists blank, so it stays clear. -->
        <p class="rb-req-legend">Marked fields are required — everything else is optional.</p>
        <div class="rb-cust-grid rb-offedit-grid">
          <label class="rep-fld req"><span class="rl">Offtaker name</span>
            <input type="text" data-of="customer_name" value="${esc(d.customer_name || "")}"></label>
          ${showBillPicker ? `
          <label class="rep-fld req"><span class="rl">Which utility account?</span>
            <select data-of="utility_account_id">
              <option value="">${d.utility_account_id ? "— keep current —" : "Select a utility account…"}</option>
              ${billOpts}
            </select></label>` : ""}
          <!-- Money cluster (Bruce C5): share → rate → discount → cross-check, one block. -->
          <label class="rep-fld req"><span class="rl">Expected share of array's net meter group (%)</span>
            <input type="number" data-of="allocation_pct" min="0.01" max="100" step="0.001" value="${pct}" placeholder="e.g. 24.783"></label>
          ${rateFieldHTML(d, utilAccts)}
          <label class="rep-fld"><span class="rl">Discount (% off the credit rate)</span>
            <input type="number" data-of="discount_pct" min="0" max="100" step="0.1" value="${disc}" placeholder="e.g. 10">
            ${autoDisc ? `<span class="rb-fld-hint">Applying <b>${autoDiscPct}% (default — auto-applied)</b> because you haven't set one${d.resolved_net_note ? ` · ${esc(d.resolved_net_note)}` : ""}. Enter a value to override.</span>` : ""}</label>
          <label class="rep-fld"><span class="rl">Share for accuracy cross-check (%)
              <span class="rb-info" tabindex="0" title="The offtaker's GMP allocation share of the array's group excess — used by the Bill accuracy check to catch mis-allocations. DISTINCT from the expected-share field (the billing multiplier). Blank reuses the billing share.">ⓘ</span></span>
            <input type="number" data-of="array_share_pct" min="0.01" max="100" step="0.001" value="${sharePct}" placeholder="blank = same as billing share">
            <span class="rb-fld-hint">Drives the bill-accuracy cross-check only — not the invoice amount.</span></label>
          ${editArrayId !== "" ? `
          <label class="rep-fld"><span class="rl">Commissioning Date</span>
            <input type="date" class="rb-of-commdate" data-commdate-arr="${editArrayId}" min="1990-01-01" max="${todayISO()}">
            <span class="rb-fld-hint rb-of-ratehint">The array's in-service date — sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).</span></label>` : ""}
          <label class="rep-fld"><span class="rl">Starting invoice #</span>
            <input type="number" data-of="invoice_number_start" min="0" max="9999999" step="1" value="${invStart}" placeholder="blank = date-based">
            <span class="rb-fld-hint">Seeds sequential invoice numbering; each send adds 1.</span></label>
          <label class="rep-fld"><span class="rl">Budget bill — fixed total ($)</span>
            <input type="number" data-of="budget_amount_usd" min="0" step="0.01" value="${d.budget_amount_usd != null ? d.budget_amount_usd : ""}" placeholder="blank = use the calculated amount">
            <span class="rb-fld-hint">Set a flat amount this offtaker pays — overrides the calculated total (line items still show).</span></label>
          <label class="rep-fld"><span class="rl">Cadence</span>
            <select data-of="cadence">
              <option value="monthly" ${cad === "monthly" ? "selected" : ""}>Monthly</option>
              <option value="quarterly" ${cad === "quarterly" ? "selected" : ""}>Quarterly</option>
            </select></label>
          <label class="rep-fld"><span class="rl">Send to</span>
            <select data-of="send_mode">
              <option value="to_me" ${sm === "to_me" ? "selected" : ""}>Me (operator copy)</option>
              <option value="to_client" ${sm === "to_client" ? "selected" : ""}>The offtaker</option>
              <option value="to_both" ${sm === "to_both" ? "selected" : ""}>Both</option>
            </select></label>
          <label class="rep-fld"><span class="rl">Offtaker email</span>
            <input type="email" data-of="client_email" value="${esc(d.client_email || "")}" placeholder="name@example.com"></label>
          <label class="rep-fld"><span class="rl">CC (comma-separated)</span>
            <input type="text" data-of="cc_emails" value="${esc(d.cc_emails || "")}" placeholder="optional"></label>
        </div>
        ${isSmartHubBound ? `
        <div class="rb-vecbill">
          <div class="rb-vecbill-h"><span class="rl">${esc(boundProv.toUpperCase())} bill — we read the rate from the PDF</span></div>
          <span class="rb-fld-hint">${esc(boundProv.toUpperCase())}'s portal doesn't publish the credit rate, so upload this account's bill PDF — we read the generation + net-metering credit rate off it and the invoice prices itself (no rate to enter).</span>
          <div class="rb-vecbill-row">
            <label class="rb-track-up">📄 Upload ${esc(boundProv.toUpperCase())} bill (PDF)
              <input type="file" accept="application/pdf,.pdf" data-vecbillfile="${d.utility_account_id}" data-vbsid="${sid}" hidden></label>
            <span class="rb-status rb-vecbill-stat"></span>
          </div>
        </div>` : ""}
        <span class="rb-status rb-offedit-status"></span>
      </div>`;
  }

  // ── Bring-your-own generation spreadsheet ("our magic" auto-updater) ────────
  // The operator uploads their existing generation-tracking sheet (any columns);
  // we detect its structure and append a new row each month as fresh GMP bills
  // land. A "Download latest spreadsheet" button streams the kept-current file.
  //
  // Each offtaker has its OWN sheet inside its accordion card (.rb-track-sub).
  // (The operator-wide MASTER sheet card was removed from the top — Ford 2026-06-28;
  // TRACKER_BASE stays as the tenant-level fallback used by loadTrackerInto.)
  const TRACKER_BASE = "/v1/array-operator/tracker";   // tenant-level fallback (no /billing, no sid)
  const FIELD_LABEL = { period: "Period", generation: "Generation kWh",
    consumption: "Consumption", rate: "Credit rate", amount: "Amount $" };

  function relTime(iso) {
    try {
      const then = new Date(iso).getTime();
      const s = Math.max(0, (Date.now() - then) / 1000);
      if (s < 90) return "just now";
      if (s < 3600) return Math.round(s / 60) + " min ago";
      if (s < 86400) return Math.round(s / 3600) + "h ago";
      return Math.round(s / 86400) + "d ago";
    } catch (e) { return ""; }
  }

  // Generic tracker loader. The box carries its OWN endpoint + scope on data-
  // attributes (data-tracker-base / -scope / -name), so the SAME renderer drives
  // each offtaker's OWN sheet (.rb-track-sub, inside its accordion). On 404 /
  // disabled / network the box stays hidden (safe to ship ahead of the flag; demo/out).
  async function loadTrackerInto(box) {
    if (!box) return;
    const base = box.dataset.trackerBase || TRACKER_BASE;
    if (!authHeaders()) { box.hidden = true; return; }   // demo / signed-out
    try {
      const r = await fetch(base, { headers: authHeaders() });
      if (!r.ok) { box.hidden = true; return; }           // flag off / not found → hide
      const j = await r.json();
      const t = j && (j.tracker || j);                    // accept {tracker:{…}} or flat shape
      if (!t || !t.enabled) { box.hidden = true; return; } // feature disabled → hide
      box.hidden = false;
      renderTracker(box, t);
    } catch (e) { box.hidden = true; }                    // network — leave hidden
  }

  function trackerMapTable(t) {
    if (!t.has_sheet) return "";
    const heads = t.headers || [];
    const cols = t.columns || {};
    let chips;
    if (t.auto) {
      // The auto-built master sheet's columns ARE the arrays (+ Period/Total), not
      // detected logical fields — summarize its shape instead of a field map.
      const nArr = Math.max(0, (heads.length || 0) - 2);   // minus Period + Total
      const nMon = t.data_rows || 0;
      chips = `<span class="rb-track-chip"><b>${nArr}</b> array${nArr === 1 ? "" : "s"}</span>`
            + `<span class="rb-track-chip"><b>${nMon}</b> month${nMon === 1 ? "" : "s"}</span>`;
    } else {
      chips = ["period", "generation", "consumption", "rate", "amount"]
        .filter(f => cols[f] != null)
        .map(f => `<span class="rb-track-chip"><b>${FIELD_LABEL[f]}</b> ← ${esc(heads[cols[f]] || ("col " + (cols[f] + 1)))}</span>`)
        .join("");
    }
    const last = t.last_period ? `Last row: <b>${esc(t.last_period)}</b>` : "No data rows yet";
    const upd = t.updated_at ? " · updated " + relTime(t.updated_at) : "";
    return `
      <div class="rb-track-detected">
        <div class="rb-track-map">${chips}</div>
        <div class="rb-track-meta">${esc(t.filename || "spreadsheet")} · ${last}${upd}</div>
      </div>`;
  }

  // Scope-aware copy. A box is either the MASTER (operator-wide) sheet at the top
  // or one OFFTAKER's own sheet inside its accordion. The master is auto-built
  // from the operator's arrays unless they upload their own layout to override it.
  function trackerCopy(box, t) {
    const scope = box.dataset.trackerScope || "global";
    const name = (box.dataset.trackerName || "").trim();
    const has = !!t.has_sheet;
    if (scope === "offtaker") {
      const who = name || "this offtaker";
      return {
        title: name ? `${name}’s generation spreadsheet` : "This offtaker’s generation spreadsheet",
        hint: has
          ? `We add a new row to ${who}’s sheet each month as their GMP bills land.`
          : `Upload ${name ? name + "’s" : "this offtaker’s"} own tracking sheet — we’ll match its format and add a row each month as their GMP bills land.`,
      };
    }
    // master / operator-wide
    if (t.auto) return {
      title: "Master generation spreadsheet",
      hint: "Auto-built from all your arrays — a column per array, a row per month, always current. Download anytime, or upload your own master layout to override it.",
    };
    return {
      title: "Master generation spreadsheet",
      hint: has
        ? "Your uploaded master sheet — we add a row each month as GMP bills land. Remove it to fall back to the auto-built sheet."
        : "Upload your operator-wide generation tracking sheet — we’ll detect its columns and keep it current as GMP bills land.",
    };
  }

  function renderTracker(box, t) {
    const has = !!t.has_sheet;
    const isAuto = !!t.auto;
    const canRemove = has && !isAuto;                 // the auto master sheet has nothing to remove
    const upLabel = !has ? "Upload spreadsheet" : (isAuto ? "Upload your own" : "Replace");
    const upTitle = isAuto ? "Upload your own sheet to override the auto-built one"
                           : (has ? "Replace the tracked sheet" : "Upload a spreadsheet");
    const dlLabel = isAuto ? "Download spreadsheet ↓" : "Download latest spreadsheet ↓";
    const { title, hint } = trackerCopy(box, t);
    box.innerHTML = `
      <div class="rb-track-h">
        <span class="rl">${esc(title)}</span>
        <span class="rb-track-hint">${esc(hint)}</span>
      </div>
      ${trackerMapTable(t)}
      <div class="rb-track-actions">
        ${has ? `<button type="button" class="rb-track-dl" data-tdl="1">${dlLabel}</button>` : ""}
        <label class="rb-track-up" title="${esc(upTitle)}">
          ${upLabel}
          <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" data-tup="1" hidden>
        </label>
        ${canRemove ? `<button type="button" class="rb-track-rm" data-trm="1">Remove</button>` : ""}
        <span class="rb-status rb-track-stat"></span>
      </div>
      ${(t.warnings && t.warnings.length) ? `<div class="rb-track-warn">${esc(t.warnings.join(" "))}</div>` : ""}`;
    wireTracker(box);
  }

  function wireTracker(box) {
    const base = box.dataset.trackerBase || TRACKER_BASE;
    const stat = box.querySelector(".rb-track-stat");
    const setS = (cls, txt) => { if (stat) { stat.className = "rb-status rb-track-stat " + (cls || ""); stat.textContent = txt || ""; } };
    const up = box.querySelector("[data-tup]");
    if (up) up.onchange = async () => {
      const f = up.files && up.files[0];
      if (!f) return;
      setS("rb-busy", "Processing your sheet — building the updated spreadsheet…");
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await fetch(base, { method: "POST", headers: authHeaders(), body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setS("rb-err", (j && j.detail) ? j.detail : "Couldn't read that sheet."); return; }
        renderTracker(box, (j && (j.tracker || j)) || {});
        // Transparency: confirm we processed it + produced an updated spreadsheet, and name the
        // months added. renderTracker rebuilt the box, so re-query the (fresh) status span.
        const p = j && j.processed;
        const st2 = box.querySelector(".rb-track-stat");
        if (st2) {
          st2.className = "rb-status rb-track-stat rb-ok";
          // Formatting-normalization transparency: when the pipeline unified mixed
          // date/number formats on the way in (STEP 1 of the reconcile), say so —
          // the operator should never wonder why their sheet looks subtly cleaner.
          const norm = (p && p.normalized > 0) ? " Tidied " + p.normalized + " cells into one consistent format." : "";
          st2.textContent = ((p && p.added_count > 0)
            ? "✓ Updated spreadsheet produced — added " + p.added.join(", ") + ". Download it below."
            : "✓ Processed — your spreadsheet is up to date through the latest bill.") + norm;
        }
        // AI review gate: when the model planned the rows, show its plain-English read + a sanity
        // verdict. Not-sane = amber "review before sending"; sane = green "looks consistent".
        if (p && p.ai && p.ai.explanation) {
          let note = box.querySelector(".rb-track-ai");
          if (!note) { note = document.createElement("div"); note.className = "rb-track-ai"; box.appendChild(note); }
          const ok = p.ai.sane !== false;
          note.style.cssText = "margin-top:9px;padding:9px 12px;border-radius:8px;font-size:13px;line-height:1.5;"
            + (ok ? "background:rgba(30,150,80,.10);color:#1c7a43;border:1px solid rgba(30,150,80,.30);"
                  : "background:rgba(200,130,0,.12);color:#8a5a00;border:1px solid rgba(200,130,0,.45);");
          note.textContent = (ok ? "✓ AI reviewed — looks consistent. " : "⚠ AI flagged this — review before sending. ")
            + p.ai.explanation;
        }
      } catch (e) { setS("rb-err", "Upload failed."); }
    };
    const dl = box.querySelector("[data-tdl]");
    if (dl) dl.onclick = async () => {
      setS("rb-busy", "Building latest…");
      try {
        const r = await fetch(base + "/download", { headers: authHeaders() });
        if (!r.ok) { setS("rb-err", "Download failed."); return; }
        const blob = await r.blob();
        const cd = r.headers.get("Content-Disposition") || "";
        const mm = /filename="?([^"]+)"?/.exec(cd);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = (mm && mm[1]) || "generation.xlsx";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        setS("rb-ok", "Downloaded.");
        // Refresh the card so a just-appended period shows as the new last row.
        const rr = await fetch(base, { headers: authHeaders() });
        const jj = await rr.json().catch(() => ({}));
        const tt = jj && (jj.tracker || jj);
        if (rr.ok && tt && tt.enabled) renderTracker(box, tt);
      } catch (e) { setS("rb-err", "Download failed."); }
    };
    const rm = box.querySelector("[data-trm]");
    if (rm) rm.onclick = async () => {
      setS("rb-busy", "Removing…");
      try {
        const r = await fetch(base, { method: "DELETE", headers: authHeaders() });
        if (!r.ok) { setS("rb-err", "Couldn't remove."); return; }
        // Re-fetch so the master reverts to its auto-built sheet (and an offtaker
        // box returns to its empty upload state) — the DELETE body alone can't
        // tell us the post-removal shape for the master.
        const rr = await fetch(base, { headers: authHeaders() });
        const jj = await rr.json().catch(() => ({}));
        const tt = (jj && (jj.tracker || jj)) || { enabled: true, has_sheet: false };
        renderTracker(box, tt);
      } catch (e) { setS("rb-err", "Network error."); }
    };
  }

  // ── Live offtaker-edit wiring ──────────────────────────────────────────────
  // Money fields change the invoiced amount, so a change recomputes the draft;
  // copy fields only repaint the preview envelope.
  // array_share_pct IS money: real-math billing charges share × the array's group
  // excess, and the generation-time cross-check compares GMP's implied share to it
  // — so a share edit must recompute the draft (and re-run the cross-check) live.
  const OF_MONEY_FIELDS = new Set(["utility_account_id", "allocation_pct", "array_share_pct", "discount_pct", "net_rate_per_kwh", "budget_amount_usd"]);
  const OF_PENDING = {};   // sid -> { body, money, timer, card, box, did }

  function wireOfftakerEditors(wrap) {
    wrap.querySelectorAll(".rb-offedit").forEach(box => {
      const sid = box.getAttribute("data-offedit");
      const card = box.closest(".rb-draft");
      const did = card && card.getAttribute("data-did");
      box.querySelectorAll("[data-of]").forEach(inp => {
        const field = inp.getAttribute("data-of");
        const h = () => onOfftakerEdit(card, box, did, sid, field, inp);
        inp.addEventListener("input", h);
        inp.addEventListener("change", h);
      });
      // The commissioning date is NOT a subscription field — it lives on the ARRAY
      // and PATCHes /arrays/{id}. Wire it specially: pre-fill from the array's
      // current setup, save the in-service DATE on change (day-accurate — it sets
      // the 11-year Rate #1 → Blended boundary), and show the expected GMP rate.
      const commEl = box.querySelector(".rb-of-commdate");
      if (commEl) {
        const arrId = commEl.getAttribute("data-commdate-arr");
        const hintEl = box.querySelector(".rb-of-ratehint");
        const defHint = "The array's in-service date — sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).";
        // Pre-fill the current commissioning date from the array setup (best-effort).
        prefillCommissioningDate(arrId, commEl, hintEl, defHint);
        // Persist on change (debounced) to PATCH /arrays/{id} via first_connect_date.
        wireCommissioningDateHint(commEl, hintEl, defHint);
        let saveTimer = null;
        const saveDate = () => {
          const raw = commEl.value.trim();
          if (raw === "") return;                    // don't clear the array's date on blank
          if (!isValidCommissioningDate(raw)) return;
          fetch(API + "/arrays/" + arrId, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ first_connect_date: raw }),
          }).then(() => { _SETUP_ARRAYS = null; }).catch(() => {});
        };
        commEl.addEventListener("change", () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveDate, 500); });
      }
      // C6: one-click "Clear override — use the bill rate" on a bill-priced offtaker
      // whose subscription still carries a legacy manual rate.
      wireRateClear(card);
      // The labeled "Delete offtaker" button lives inside the editor (rendered into the
      // expanded body, so the list-level [data-del-offtaker] wiring never sees it).
      const del = box.querySelector(".rb-offedit-del[data-del-offtaker]");
      if (del) del.onclick = () => deleteOfftaker(del.getAttribute("data-del-offtaker"));
    });
  }

  // C6: wire the "Clear override — use the bill rate" button inside a draft card's
  // editor (if present). Optimistically flips the row to the read-only bill-rate
  // line, then persists through the SAME debounced money-field pipeline as typing
  // in the old input did (PATCH {net_rate_per_kwh:null} → draft recompute), so the
  // figures + calc panel re-derive from the bill's own credit rate.
  function wireRateClear(card) {
    const box = card && card.querySelector(".rb-offedit");
    const btn = box && box.querySelector(".rb-rate-clear");
    if (!btn) return;
    const sid = box.getAttribute("data-offedit");
    const did = card.getAttribute("data-did");
    btn.onclick = () => {
      const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
      if (!d) return;
      d.net_rate_per_kwh = null;
      d._ratePending = true;              // figures are override-priced until recompute
      const fld = box.querySelector(".rb-rate-fld");
      if (fld) fld.outerHTML = rateFieldHTML(d);
      ACTIVE_DRAFT_ID = did;
      scheduleOfftakerPatch(card, box, did, sid, { net_rate_per_kwh: null }, true);
    };
  }

  // Pre-fill a commissioning-date input from the array's current setup, and if a
  // date is known, immediately render its expected GMP rate. Uses /setup-state
  // (which lists arrays with their first_connect_date). Legacy year-only values
  // were stored as Jan 1 of that year, so they show as YYYY-01-01 — consistent
  // with the backend's year→Jan-1 boundary reading. `overwrite` repaints the
  // field even when it already holds a value (used when the picked array CHANGES
  // in the add-offtaker form); default only fills an empty field. Best-effort,
  // fail-soft.
  let _SETUP_ARRAYS = null;
  async function prefillCommissioningDate(arrId, inputEl, hintEl, defHint, overwrite) {
    if (!authHeaders() || !inputEl) return;
    try {
      if (_SETUP_ARRAYS == null) {
        const r = await fetch(API + "/setup-state", { headers: authHeaders() });
        const j = r.ok ? await r.json().catch(() => ({})) : {};
        _SETUP_ARRAYS = (j && j.arrays) || [];
      }
      const a = _SETUP_ARRAYS.find(x => String(x.array_id) === String(arrId));
      const fc = a && a.first_connect_date ? String(a.first_connect_date).slice(0, 10) : "";
      if (!overwrite && inputEl.value.trim() !== "") return;
      if (!fc) {
        if (overwrite) {          // switching to an array with no saved date: don't
          inputEl.value = "";     // let the previous array's date linger and PATCH
          if (hintEl) { hintEl.innerHTML = defHint; hintEl.classList.remove("rb-rate-hint-on"); }
        }
        return;
      }
      inputEl.value = fc;
      if (hintEl) {
        const rate = await fetchExpectedGmpRate(fc);
        const html = expectedRateHintHTML(rate);
        if (html) { hintEl.innerHTML = html; hintEl.classList.add("rb-rate-hint-on"); }
      }
    } catch (e) { /* leave blank */ }
  }

  function onOfftakerEdit(card, box, did, sid, field, inp) {
    const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
    if (!d) return;
    const raw = inp.value;
    ACTIVE_DRAFT_ID = did;                       // preview tracks the edited draft
    // Optimistic repaint for what the preview/grid can honestly show right now.
    if (field === "customer_name") {
      d.customer_name = raw;
      // Rename updates EVERYWHERE instantly: the draft-card header + the picker.
      const nameEl = card && card.querySelector(".rb-draft-name");
      if (nameEl) nameEl.textContent = raw;
      const pickName = document.querySelector(".rb-pick-btn-name");
      if (pickName) pickName.textContent = raw;
    }
    else if (field === "client_email") d.client_email = raw;
    else if (field === "send_mode") d.send_mode = raw;
    else if (field === "cc_emails") d.cc_emails = raw;
    else if (field === "allocation_pct" && raw !== "") {
      d.allocation_pct = Number(raw) / 100;
      const v = card && card.querySelectorAll(".rb-draft-grid .rb-v")[1];
      if (v) v.textContent = (Math.round(d.allocation_pct * 1000) / 10) + "%";
    }
    renderDraftDoc();
    const body = ofPatchBody(field, raw);
    if (body === null) return;                   // nothing to persist (blank required)
    scheduleOfftakerPatch(card, box, did, sid, body, OF_MONEY_FIELDS.has(field));
  }

  function ofPatchBody(field, raw) {
    const v = String(raw == null ? "" : raw).trim();
    switch (field) {
      case "allocation_pct":     return v === "" ? null : { allocation_pct: Number(v) / 100 };
      case "discount_pct":       return v === "" ? { discount_pct: null } : { discount_pct: Number(v) / 100 };
      case "net_rate_per_kwh":   return { net_rate_per_kwh: v === "" ? null : Number(v) };
      case "budget_amount_usd":  return { budget_amount_usd: v === "" ? null : Number(v) };
      // Cross-check share: percent in the UI → fraction on the wire; blank clears it
      // (the accuracy check falls back to allocation_pct). Not a money field.
      case "array_share_pct":    return { array_share_pct: v === "" ? null : Number(v) / 100 };
      // Sequential-numbering seed: whole number; blank clears (back to date-based).
      case "invoice_number_start": return { invoice_number_start: v === "" ? null : Math.trunc(Number(v)) };
      case "utility_account_id": return v === "" ? null : { utility_account_id: Number(v) };
      case "customer_name":      return v === "" ? null : { customer_name: v };
      case "client_email":       return { client_email: v };
      case "cc_emails":          return { cc_emails: v };
      case "cadence":            return { cadence: v };
      case "send_mode":          return { send_mode: v };
      default: return null;
    }
  }

  function scheduleOfftakerPatch(card, box, did, sid, body, isMoney) {
    let p = OF_PENDING[sid];
    if (!p) p = OF_PENDING[sid] = { body: {}, money: false };
    Object.assign(p.body, body);
    p.money = p.money || isMoney;
    p.card = card; p.box = box; p.did = did;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flushOfftakerPatch(sid), 600);
  }

  async function flushOfftakerPatch(sid) {
    const p = OF_PENDING[sid];
    if (!p) return;
    delete OF_PENDING[sid];
    const { body, money, card, box, did } = p;
    const st = box && box.querySelector(".rb-offedit-status");
    const setSt = (cls, txt) => { if (st) { st.className = cls; if (txt !== undefined) st.textContent = txt; } };
    setSt("rb-status rb-busy", money ? "Recalculating…" : "Saving…");
    try {
      const r = await fetch(API + "/subscriptions/" + sid, {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setSt("rb-status rb-err", (e && e.detail) ? e.detail : "Couldn't save.");
        return;
      }
      if (!money) { setSt("rb-status rb-ok", "Saved."); renderDraftDoc(); return; }
      // Money changed → recompute the draft figures via the production path
      // (generate_draft → build_match → build_manual_match for GMP-bound offtakers).
      try {
        const rg = await fetch(API + "/subscriptions/" + sid + "/draft",
          { method: "POST", headers: authHeaders() });
        const dg = await rg.json().catch(() => ({}));
        // A share/rate edit re-runs the cross-check server-side — flip the strip
        // live so a just-corrected share clears the flag (or a bad one raises it).
        if (rg.ok) noteXcheck(sid, dg);
        const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
        if (rg.ok && dg.draft && d) {
          // Include budget_amount_usd + solar_credit_value so CLEARING a budget bill
          // (or changing it) updates the preview live — otherwise the local draft kept
          // the old budget and the two-row "Budgeted amount" display stayed stale until
          // a hard refresh re-fetched the draft.
          // Include net_rate_per_kwh + discount_pct so the calc dashboard reflects a
          // freshly-typed Solar credit rate LIVE — without these the local draft kept the
          // old rate and the dashboard fell back to the effective (post-discount) rate
          // instead of showing the rate the operator just set.
          ["array_total_kwh", "allocation_pct", "customer_kwh", "amount_usd",
           "invoice_number", "period_label", "budget_amount_usd",
           "solar_credit_value", "net_rate_per_kwh", "discount_pct"].forEach(k => { if (k in dg.draft) d[k] = dg.draft[k]; });
          applyDraftFigures(card, d);
          setSt("rb-status rb-ok", "Saved · figures updated.");
        } else {
          setSt("rb-status rb-ok", "Saved · figures update once a GMP bill lands.");
        }
      } catch (e) { setSt("rb-status rb-ok", "Saved."); }
      // C6: if a cleared override's transient "recalculating…" rate row is still up
      // (recompute wasn't possible — e.g. no settled bill yet), settle it to the
      // honest static line instead of leaving a stuck in-between state.
      const dp = INBOX_DRAFTS.find(x => String(x.id) === String(did));
      if (dp && dp._ratePending) {
        delete dp._ratePending;
        const fld = card && card.querySelector(".rb-rate-fld[data-rate-readonly]");
        if (fld) { fld.outerHTML = rateFieldHTML(dp); wireRateClear(card); }
      }
    } catch (e) { setSt("rb-status rb-err", "Network error."); }
  }

  // Repaint a draft card's number grid + the live preview from the updated draft
  // object, WITHOUT re-rendering the editor inputs (so the operator keeps focus).
  function applyDraftFigures(card, d) {
    if (card) {
      const vs = card.querySelectorAll(".rb-draft-grid .rb-v");
      const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
      if (vs[0]) vs[0].textContent = fmt0(d.array_total_kwh) + " kWh";
      if (vs[1]) vs[1].textContent = pct != null ? pct + "%" : "—";
      if (vs[2]) vs[2].textContent = fmt0(d.customer_kwh) + " kWh";
      if (vs[3]) vs[3].textContent = money(d.amount_usd);
      // Re-sync the auto-written note to the new figures — but only if it's still
      // the default (never clobber an email the operator has edited).
      const ta = card.querySelector(`textarea[data-draftmsg="${d.id}"]`);
      if (ta && d._defaultNote != null && ta.value === d._defaultNote) {
        const nn = d.email_letter_default || defaultDraftNote(d);
        ta.value = nn; d._defaultNote = nn;
        autoGrowMsg(ta);                              // re-fit after the note grows/shrinks
      }
    }
    if (card) {                                       // the calc dashboard now lives in the form col;
      const calcEl = card.querySelector(".rb-calc");  // repaint it in place from the new figures
      if (calcEl) { calcEl.outerHTML = calcDashboard(d); wireCalcLinks(card); }
      // C6: the READ-ONLY solar-credit-rate line derives from the draft figures, so
      // re-derive it from the fresh numbers. The one case we must NOT touch is
      // input→input (VEC/SmartHub manual field the operator may be mid-typing in);
      // every other transition (readonly refresh, input↔readonly after a utility-
      // account rebind) repaints so the row always shows the true rate source.
      const rateFld = card.querySelector(".rb-rate-fld");
      if (rateFld) {
        delete d._ratePending;             // fresh server figures just merged — derive for real
        const fresh = rateFieldHTML(d);
        const wasInput = !rateFld.hasAttribute("data-rate-readonly");
        const staysInput = fresh.indexOf("data-rate-readonly") === -1;
        if (!(wasInput && staysInput)) {
          rateFld.outerHTML = fresh;
          wireRateClear(card);           // the repaint can (re)introduce the button
          // A readonly→input repaint (GMP → VEC rebind) mints a fresh manual input
          // that missed wireOfftakerEditors — wire it here so it saves like the rest.
          const rateInp = card.querySelector(".rb-rate-fld [data-of]");
          if (rateInp) {
            const rbox = card.querySelector(".rb-offedit");
            const rdid = card.getAttribute("data-did");
            const rsid = rbox && rbox.getAttribute("data-offedit");
            const rh = () => onOfftakerEdit(card, rbox, rdid, rsid, rateInp.getAttribute("data-of"), rateInp);
            rateInp.addEventListener("input", rh);
            rateInp.addEventListener("change", rh);
          }
        }
      }
    }
    renderReviewTop();                                // repaint the action buttons
    renderDraftDoc();
  }

  // Grow the cover-email textarea to fit its whole content (no inner scrollbar),
  // so the operator sees the entire message without dragging the resize handle.
  function autoGrowMsg(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 140) + "px";
  }

  // A sensible pre-written note the operator edits before sending (Paul's
  // "edit a pre-written email" ask). Mentions the period + amount.
  function defaultDraftNote(d) {
    const amt = d.amount_usd != null ? money(d.amount_usd) : "the amount due";
    const kwh = d.customer_kwh != null ? fmt0(d.customer_kwh) + " kWh" : "your production";
    const period = d.period_label || "the latest period";
    // Only claim attachments that will actually be there (auto-attach GMP on by
    // default; AO summary opt-in) so the note never promises a file that isn't sent.
    const extras = [];
    if (d.auto_attach_gmp !== false) extras.push("the GMP source data");
    if (d.include_summary === true) extras.push("a production summary");
    const extraLine = extras.length
      ? ` ${extras.join(" and ")} ${extras.length > 1 ? "are" : "is"} attached so you can see exactly how it was calculated.`
      : "";
    return `Hi,\n\nAttached is your solar invoice for ${period}. Your array produced ${kwh} this period, for a total of ${amt}.${extraLine}\n\nThanks for going solar!`;
  }

  async function onDraftAction(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const act = btn.getAttribute("data-dact");
    // Buttons live either in the LEFT card (attach toggles) or the RIGHT review header
    // (approve/send). Resolve the active draft's card + the shared status span either way.
    const layout = btn.closest(".rb-layout") || document;
    const card = btn.closest(".rb-draft") || layout.querySelector(".rb-draft");
    const id = card && card.getAttribute("data-did");
    if (!id) return;
    const st = layout.querySelector(".rb-draft-status");
    // Null-safe status writer: a missing status span must NEVER throw and block
    // the actual send (this was the "Approve & send does nothing" bug — st was
    // null, `st.className=` threw before the fetch fired, so nothing happened).
    const setSt = (cls, txt) => { if (st) { st.className = cls; if (txt !== undefined) st.textContent = txt; } };

    if (act === "preview") {
      // Open the tab SYNCHRONOUSLY (still inside the click = a user gesture) so the
      // popup blocker doesn't kill it after the await; the sub id is on the card.
      const win = window.open("", "_blank");
      return previewDraftInvoice(card.getAttribute("data-subid"), st, win);
    }
    if (act === "sendme") {
      // Email a TEST copy of this draft to the operator (you). Save the edited note
      // first so the test reflects exactly what the offtaker would receive.
      const subId = card.getAttribute("data-subid");
      const ta = card.querySelector(`textarea[data-draftmsg="${id}"]`);
      setSt("rb-status rb-busy", "Sending a test to you…");
      try {
        if (ta) {
          const dd = INBOX_DRAFTS.find(x => String(x.id) === String(id));
          const untouched = dd && dd._defaultNote != null && ta.value === dd._defaultNote;
          await fetch(API + "/drafts/" + id, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ note: untouched ? "" : ta.value }),
          });
        }
        const r = await fetch(API + "/drafts/" + id + "/test", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          const to = (data.result && data.result.to || []).join(", ");
          setSt("rb-status rb-ok", "Test sent to " + (to || "you") + " — check your inbox.");
        } else {
          setSt("rb-status rb-err", (data && data.detail) ? data.detail : "Test send failed.");
        }
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
      return;
    }
    if (act === "autogmp") {
      // Per-customer auto-attach toggle. The draft carries subscription_id;
      // PATCH the subscription, then refresh the inbox to update the status line.
      const on = e.target.checked;
      const subId = card.getAttribute("data-subid");
      setSt("rb-status rb-busy", "Saving…");
      try {
        const r = await fetch(API + "/subscriptions/" + subId, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ auto_attach_gmp: on }),
        });
        if (r.ok) { setSt("rb-status", ""); await refreshInbox(); }
        else { setSt("rb-status rb-err", "Couldn't save."); }
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
      return;
    }
    if (act === "summary") {
      // Per-offtaker opt-in (OFF by default): attach Array Operator's performance
      // summary PDF. PATCH the subscription's include_summary, then refresh so the
      // live preview's attachment list + note update.
      const on = e.target.checked;
      const subId = card.getAttribute("data-subid");
      setSt("rb-status rb-busy", "Saving…");
      try {
        const r = await fetch(API + "/subscriptions/" + subId, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ include_summary: on }),
        });
        if (r.ok) { setSt("rb-status", ""); await refreshInbox(); }
        else { setSt("rb-status rb-err", "Couldn't save."); }
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
      return;
    }
    if (act === "aiemail") {
      const ta = card.querySelector(`textarea[data-draftmsg="${id}"]`);
      setSt("rb-status rb-busy", "✨ Writing a tailored email…");
      try {
        const r = await fetch(API + "/drafts/" + id + "/ai-email", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.email) {
          setSt("rb-status rb-err", (data && data.detail) ? data.detail : "Couldn't write the email.");
          return;
        }
        if (ta) { ta.value = data.email; autoGrowMsg(ta); }
        const d = INBOX_DRAFTS.find(x => String(x.id) === String(id));
        if (d) d.note = data.email;            // preview + send use this note
        ACTIVE_DRAFT_ID = id; renderDraftDoc();
        // Persist it so Approve/Send uses it even without a separate Save click.
        try {
          await fetch(API + "/drafts/" + id, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ note: data.email }),
          });
        } catch (e) { /* the textarea still holds it; Save email persists it */ }
        setSt("rb-status rb-ok", "✨ Written + saved — review, edit anything, then send.");
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
      return;
    }
    if (act === "savemsg") {
      const ta = card.querySelector(`textarea[data-draftmsg="${id}"]`);
      const _dd = INBOX_DRAFTS.find(x => String(x.id) === String(id));
      const _untouched = _dd && _dd._defaultNote != null && ta && ta.value === _dd._defaultNote;
      const note = ta ? (_untouched ? "" : ta.value) : "";
      setSt("rb-status rb-busy", "Saving email…");
      try {
        const r = await fetch(API + "/drafts/" + id, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ note }),
        });
        if (r.ok) { setSt("rb-status rb-ok", "Email saved."); }
        else { setSt("rb-status rb-err", "Couldn't save email."); }
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
      return;
    }
    if (act === "dismiss") {
      if (!confirm("Dismiss this drafted report without sending?")) return;
      setSt("rb-status rb-busy", "Dismissing…");
      await fetch(API + "/drafts/" + id + "/dismiss", { method: "POST", headers: authHeaders() });
      await refreshInbox();
      return;
    }
    if (act === "approve") {
      if (!confirm("Approve and send this report to the offtaker now?")) return;
      setSt("rb-status rb-busy", "Sending…");
      try {
        const r = await fetch(API + "/drafts/" + id + "/approve", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          const to = (data.result && data.result.to || []).join(", ");
          setSt("rb-status rb-ok", "Sent" + (to ? " to " + to : "") + ".");
          setTimeout(refreshInbox, 900);
        } else {
          setSt("rb-status rb-err", (data && data.detail) ? data.detail : "Send failed.");
        }
      } catch (err) { setSt("rb-status rb-err", "Network error."); }
    }
  }

  async function previewDraftInvoice(subId, st, win) {
    // Stream the invoice PDF for this draft's subscription into the pre-opened tab
    // (opened synchronously by the click so it isn't popup-blocked).
    // st (the card's status span) can be null if the card re-rendered between the
    // click and here — guard every write so it never throws (Sentry PYTHON-FASTAPI-4).
    const setSt = (cls, txt) => { if (st) { st.className = cls; st.textContent = txt; } };
    setSt("rb-status rb-busy", "Building preview…");
    function fail(msg) { if (win && !win.closed) win.close(); setSt("rb-status rb-err", msg); }
    if (!subId) return fail("Preview unavailable.");
    try {
      const r = await fetch(API + "/subscriptions/" + subId + "/preview?kind=invoice&fmt=pdf", { headers: authHeaders() });
      if (!r.ok) return fail("Preview failed.");
      const url = URL.createObjectURL(await r.blob());
      if (win && !win.closed) win.location = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (st) st.textContent = "";
    } catch (e) { fail("Preview failed."); }
  }

  // If the Reports tab is the active hash on first load, render immediately.
  if (location.hash === "#reports") {
    document.addEventListener("DOMContentLoaded", load);
  }
})();
