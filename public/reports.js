/* ============================================================================
 * Array Operator, Reports tab (reports.js)
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
 * New classes (styled in command-center.css): .rb-* (reports billing)
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
 // Whole-dollar money for the GMP $25-per-error stakes ($25 / $1,675, never $25.00).
 const money0 = n => n == null ? "—"
 : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

 function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
 function authHeaders() { const s = session(); return s ? { Authorization: "Bearer " + s } : null; }

 // Extract a HUMAN-READABLE message from an API error body. FastAPI `detail`
 // comes in three shapes and only the first is a plain string:
 // • string , our HTTPException(400, "…") → use as-is
 // • object , a machine-readable body, e.g. require_not_demo's
 // {error:"demo-read-only", message:"…", cta_url} → use .message
 // • array , a 422 validation error: [{msg, loc, …}, …] → join the msgs
 // Rendering `data.detail` straight into textContent turned the last two into
 // the literal string "[object Object]", masking the real reason, most visibly
 // the demo-read-only 403, so an offtaker create on a demo/scratch tenant showed
 // "[object Object]" instead of "This is a demo account, sign up…" (Ford,
 // 2026-07-09). Always route error text through this helper.
 function apiErr(data, fallback) {
 const d = data && data.detail;
 if (typeof d === "string" && d.trim()) return d;
 if (d && typeof d === "object" && !Array.isArray(d) && typeof d.message === "string" && d.message.trim()) {
 return d.message;
 }
 if (Array.isArray(d)) {
 const msgs = d.map(e =>
 (e && typeof e === "object" && typeof e.msg === "string") ? e.msg
 : (typeof e === "string" ? e : null)).filter(Boolean);
 if (msgs.length) return msgs.join("; ");
 }
 return fallback;
 }

 /* ===========================================================================
 * BILL ACCURACY CHECK, the per-offtaker GMP-allocation cross-check.
 *
 * The backend (/reconcile-bills) cross-checks two things per offtaker before the
 * operator sends an invoice:
 * 1. Production vs the GMP bill , our metered kWh vs what GMP's meter says.
 * 2. GMP allocation cross-check, does the excess GMP credited THIS offtaker
 * match (their share × the array bill's stated group excess)? When it
 * doesn't, we reverse-solve the group total GMP implied, a number on
 * neither bill = a caught billing error (Anna gets $25 per catch).
 *
 * Fetched ONCE per page load, cached on the module, indexed by sub_id. Woven into
 * the invoice-review flow (a "Bill accuracy check" section in each offtaker's
 * draft card) + a top-level summary chip when anything is flagged. Honest, quiet
 * treatment for the "check couldn't run yet" states; amber (not red) for soft
 * flags; the allocation $-mismatch is the one prominent catch.
 * ==========================================================================*/
 let RECON = null; // full /reconcile-bills payload (cached)
 let RECON_BY_SUB = {}; // sub_id -> subscription reconcile row
 let _reconPromise = null; // in-flight fetch (dedupe concurrent callers)
 function reconIndex() {
 RECON_BY_SUB = {};
 if (RECON && Array.isArray(RECON.subscriptions))
 RECON.subscriptions.forEach(r => { if (r && r.sub_id != null) RECON_BY_SUB[String(r.sub_id)] = r; });
 }
 // Fetch the reconcile payload once; return the cache on repeat calls. Fails soft
 // (a network/500 error just leaves the accuracy check absent, never blocks the
 // invoice flow). Refetched naturally on a page reload (module state resets).
 function loadReconcile() {
 if (RECON) return Promise.resolve(RECON);
 if (_reconPromise) return _reconPromise;
 if (!authHeaders()) return Promise.resolve(null);
 // The server computes the sweep in the background (63s at 800 offtakers
 // crossed the edge gateway timeout), {pending:true} means "poll again".
 _reconPromise = (async () => {
 for (let i = 0; i < 45; i++) { // ≤ ~7.5 min of 10s polls
 try {
 const r = await fetch(API + "/reconcile-bills", { headers: authHeaders() });
 if (!r.ok) return null;
 const d = await r.json().catch(() => null);
 if (d && d.ok) { RECON = d; reconIndex(); return RECON; }
 if (!d || !d.pending) return null;
 } catch (e) { return null; }
 await new Promise(res => setTimeout(res, 2500));
 }
 return null;
 })().then(v => { _reconPromise = null; return v; });
 return _reconPromise;
 }
 function reconFor(subId) { return subId == null ? null : RECON_BY_SUB[String(subId)] || null; }

 // Plain-English label + tone for an array-row production-vs-bill verdict.
 const _ARR_STATUS = {
 match: { cls: "ok", label: "Matches the GMP bill" },
 mismatch: { cls: "warn", label: "Differs from the GMP bill" },
 no_bill: { cls: "mute", label: "No GMP bill for this period yet" },
 no_invoice_data: { cls: "mute", label: "No production data yet" },
 unverified: { cls: "mute", label: "Awaiting measured data to verify" },
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

 // The GMP allocation cross-check, Bruce's worked example. `note` is authored by
 // the backend in plain English; we render it, we don't re-derive it. The mismatch
 // dollar figure is the $25 catch, so it leads; honest non-run states render quietly.
 const _ALLOC_QUIET = {
 single_meter: "This offtaker is on the array's own meter, there's no separate GMP allocation to cross-check.",
 no_offtaker_account: "Awaiting this offtaker's own GMP account to cross-check the allocation.",
 no_offtaker_bill: "Awaiting a GMP bill on this offtaker's account to cross-check the allocation.",
 no_array_bill: "Awaiting the array's GMP bill to cross-check the allocation.",
 no_share: "Set this offtaker's share to cross-check the GMP allocation.",
 };
 // The effective variance threshold (percentage points) for this offtaker's
 // cross-check: their own override, else the fleet default. Bruce 2026-07-07 —
 // surfaced on the accuracy surfaces so the threshold is always documented.
 function effXThreshold(subId) {
 const rec = (OFFTAKERS || []).find(x => String(x.id) === String(subId));
 const o = rec && rec.crosscheck_threshold_pct;
 return (o != null && Number(o) > 0) ? Number(o) : XCHECK_DEFAULT_PCT;
 }
 function reconAllocHTML(row) {
 const al = row && row.allocation;
 if (!al || !al.status) return "";
 const note = al.note ? `<div class="rb-bac-note">${esc(al.note)}</div>` : "";
 const thr = effXThreshold(row && row.sub_id);
 if (al.status === "mismatch") {
 // The stake is GMP's $25 billing-error credit, the kWh-delta dollars
 // (often cents) live in the note as the size of the mis-allocation.
 const stake = money0(al.at_stake_usd != null ? al.at_stake_usd : 25);
 return `<div class="rb-bac-block rb-bac-flag">
 <div class="rb-bac-blabel">
 <span class="rb-bac-flagicon" aria-hidden="true">⚑</span>GMP allocation cross-check
 <span class="rb-bac-atstake" title="GMP credits $25 per billing error they made, a confirmed catch is worth ${esc(stake)}.">${stake} at stake</span>
 </div>
 <div class="rb-bac-figs">
 <div class="rb-bac-fig"><b>${fmt0(al.offtaker_credited_kwh)}</b><span>GMP credited this offtaker</span></div>
 <div class="rb-bac-fig"><b>${fmt0(al.expected_kwh)}</b><span>expected (share × group excess)</span></div>
 <div class="rb-bac-fig rb-bac-fig-imp"><b>${fmt0(al.implied_group_total_kwh)}</b><span>group total GMP implied</span></div>
 <div class="rb-bac-fig"><b>${fmt0(al.array_group_excess_kwh)}</b><span>group excess on the array bill</span></div>
 </div>
 <div class="rb-bac-note rb-bac-mute">Flagged because GMP's derived share differs from yours by more than your ${fmtPct(thr)}% threshold.</div>
 ${note}
 </div>`;
 }
 if (al.status === "match") {
 return `<div class="rb-bac-block">
 <div class="rb-bac-blabel">GMP allocation cross-check
 <span class="rb-bac-ok-pill" title="We derive GMP's actual share (credited ÷ the array's group excess) and compare it to your entered share, it agrees within your ${fmtPct(thr)}% flag threshold.">✓ checks out</span></div>
 <div class="rb-bac-note rb-bac-mute">Flags if GMP's derived share differs from yours by more than ${fmtPct(thr)}% (set per offtaker above).</div>
 ${note}
 </div>`;
 }
 if (al.status === "error") {
 return `<div class="rb-bac-block">
 <div class="rb-bac-blabel rb-bac-mute">GMP allocation cross-check</div>
 <div class="rb-bac-note rb-bac-mute">${esc(al.note || "Couldn't run this check right now.")}</div>
 </div>`;
 }
 // Honest non-run states, render the note quietly, never as a flag.
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
 // Sub-label for the collapsed section header, surfaces the catch without a click.
 function reconSecSub(subId) {
 const row = reconFor(subId);
 if (!row) return "";
 if (row.allocation && row.allocation.status === "mismatch") {
 const s = row.allocation.at_stake_usd != null ? row.allocation.at_stake_usd : 25;
 return "⚑ allocation mismatch, " + money0(s) + " at stake";
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
 if (!RECON) return ""; // check hasn't run yet, show nothing
 const allocN = RECON.allocation_flagged || 0;
 const arrN = reconArrayMismatchCount();
 // The stake is GMP's $25 billing-error credit per catch, NOT the kWh-delta
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
 // "to review", an offtaker we simply can't verify yet (no measured
 // generation, a prorated estimate) is "awaiting data", not flagged.
 if (!n) {
 if (unverifiedSubs) {
 return `<span class="rb-bac-clean" title="We cross-check each offtaker's measured production and GMP's allocation against the utility bill. No discrepancies found; ${unverifiedSubs} can't be fully verified until measured generation data lands.">✓ No billing discrepancies · ${unverifiedSubs} awaiting data</span>`;
 }
 return `<span class="rb-bac-clean" title="We cross-check each offtaker's measured production and GMP's allocation against the utility bill. Everything reconciles.">✓ Utility bills reconcile</span>`;
 }
 const dTxt = atStake > 0 ? ` · ≈ ${money0(atStake)} at stake` : "";
 const label = `⚑ ${n} bill${n === 1 ? "" : "s"} to review · doesn't match GMP${dTxt}`;
 const tip = allocN
 ? `The utility bill doesn't match our numbers for ${n} offtaker${n === 1 ? "" : "s"}: ${allocN} GMP allocation error${allocN === 1 ? "" : "s"}${arrN ? " + " + arrN + " production difference" + (arrN === 1 ? "" : "s") : ""}. GMP credits $25 per billing error they made, totaling ${money0(atStake)} across these catches. Click to open the Bill audit.`
 : `Measured production differs from the GMP bill for ${arrN} offtaker${arrN === 1 ? "" : "s"}, a possible billing error. Click to open the Bill audit.`;
 return `<span class="rb-bac-chip" id="rbBacChip" role="button" tabindex="0" title="${esc(tip)}">${label}</span>`;
 }
 // Flip the generator to the Bill-audit tab (the flagged chip's destination —
 // that's where the catches live, organized the way GMP allocates them).
 function openAuditTab() {
 const btn = document.querySelector('.inv-sub-seg [data-gentab="audit"], #rbGenTabs [data-gentab="audit"]');
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
 renderKpis(); // the "Doesn't match GMP" KPI tile fills when RECON lands
 }
 function wireBacChip(host) {
 const chip = host && host.querySelector("#rbBacChip");
 updateAuditTabBadge();
 if (!chip) return;
 const jump = () => {
 // The Bill-audit tab IS the review surface for these catches (Ford,
 // 2026-07-03), fall back to the first flagged card if the tab's absent.
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
 * card, the check "pops up when an invoice is generated" (Bruce), always as
 * fresh as the draft itself (the page-load /reconcile-bills snapshot backs
 * the fuller "Bill accuracy check" section below it). null = the check can't
 * run yet (no settled bill / no share / single meter) → no strip,
 * never a fabricated verdict. */
 const XCHECK_BY_SUB = {}; // sub_id -> crosscheck object | null
 // The fleet-default cross-check variance threshold (percentage points, Bruce
 // 2026-07-07). Set from the subscriptions list / list-bundle; the setup + edit
 // forms show "flags beyond X%" from it when the per-offtaker override is blank.
 let XCHECK_DEFAULT_PCT = 0.5; // fleet default (Ford 2026-07-10: 0.1 → 0.5%, looser); backend list-bundle overrides
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
 if (!x) return ""; // not run yet / can't run, honest silence
 const th = x.threshold_pct != null ? x.threshold_pct : 0.1;
 if (!x.flagged) {
 // Quiet green line: the numbers agree, say so with the real shares.
 return `<div class="rb-xcheck rb-xcheck-ok" role="status">✓ Cross-check, GMP's share matches yours within ${fmtPct(th)}%`
 + ` <small>(${fmtPct(x.computed_share_pct)}% on the bills · ${fmtPct(x.entered_share_pct)}% entered)</small></div>`;
 }
 // Prominent warning strip with the real numbers, the operator sees exactly
 // what disagrees before Approve & send.
 const offKwh = x.delta_kwh != null ? Math.abs(Number(x.delta_kwh)) : null;
 const dollars = x.delta_dollars ? ` ≈ ${money(Math.abs(x.delta_dollars))}` : "";
 const offLine = offKwh != null
 ? `Off by ${fmt0(offKwh)} kWh${dollars} · variance ${fmtPct(Math.abs(x.variance_pct))}% (flags beyond ${fmtPct(th)}%). `
 : "";
 return `<div class="rb-xcheck rb-xcheck-flag" role="alert">
 <div class="rb-xcheck-head"><span class="rb-xcheck-ico" aria-hidden="true">⚑</span>Cross-check, GMP's bill doesn't match this offtaker's share</div>
 <div class="rb-xcheck-figs">
 <span class="rb-xcheck-fig"><b>${fmtPct(x.computed_share_pct)}%</b><small>share GMP's bills imply</small></span>
 <span class="rb-xcheck-fig"><b>${fmtPct(x.entered_share_pct)}%</b><small>share you entered</small></span>
 <span class="rb-xcheck-fig"><b>${fmt0(x.kwh_offtaker_credited)}</b><small>kWh GMP credited them</small></span>
 <span class="rb-xcheck-fig"><b>${fmt0(x.kwh_offtaker_expected)}</b><small>kWh expected (${fmtPct(x.entered_share_pct)}% × ${fmt0(x.kwh_master)})</small></span>
 </div>
 <div class="rb-xcheck-note">${offLine}Check the entered share or GMP's bill before sending, details in the Bill accuracy check below.</div>
 </div>`;
 }

 /* ===========================================================================
 * BILL AUDIT SANDBOX, Ford/Bruce's "organize the fleet the way GMP allocates it
 * so you can catch GMP's per-offtaker math errors visually".
 *
 * Pull the ARRAY's master utility bill (e.g. Londonderry, 100 kWh of group
 * excess), lay each offtaker's OWN utility bill underneath it (Brooks House 50%
 * → should show 50, …), and FLAG it when GMP's number doesn't match the math.
 * Sub-tabs per utility (GMP / VEC / …). Reads GET /audit-by-array (auth), cached,
 * refetched on reload; signed-in only; fails soft.
 * ==========================================================================*/
 let AUDIT = null; // /audit-by-array payload (cached)
 let _auditPromise = null;
 let AUDIT_PROVIDER = null; // which utility sub-tab is active (provider string)
 function loadAudit() {
 if (AUDIT) return Promise.resolve(AUDIT);
 if (_auditPromise) return _auditPromise;
 if (!authHeaders()) return Promise.resolve(null);
 // Server computes the sweep in the background, {pending:true} = poll again.
 _auditPromise = (async () => {
 for (let i = 0; i < 45; i++) { // ≤ ~7.5 min of 10s polls
 try {
 const r = await fetch(API + "/audit-by-array", { headers: authHeaders() });
 if (!r.ok) return null;
 const d = await r.json().catch(() => null);
 if (d && d.ok) { AUDIT = d; return AUDIT; }
 if (!d || !d.pending) return null;
 } catch (e) { return null; }
 await new Promise(res => setTimeout(res, 2500));
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
 single_meter: "On the array's own meter, no separate GMP allocation to audit.",
 no_offtaker_account: "Awaiting this offtaker's own utility account to audit the allocation.",
 no_offtaker_bill: "Awaiting a utility bill on this offtaker's account.",
 no_array_bill: "Awaiting the array's master utility bill.",
 no_share: "Set this offtaker's share to audit the allocation.",
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
 <span class="rb-au-atstake" title="GMP credits $25 per billing error they made, a confirmed catch is worth ${esc(stake)}.">${stake} at stake</span>
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
 // Honest non-run state, render the note quietly in grey.
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
 const offs = a.offtakers || [];
 const flaggedOffs = offs.filter(o => o.status === "mismatch");
 const okOffs = offs.filter(o => o.status !== "mismatch");
 const matchN = okOffs.filter(o => o.status === "match").length;
 const quietN = okOffs.length - matchN;
 const flagged = flaggedOffs.length;
 const rate = a.credit_rate != null ? "$" + Number(a.credit_rate).toFixed(4) + "/kWh" : null;
 // Only flagged (mismatch) offtakers show by default; matching + awaiting-data
 // rows collapse into a drawer so they never bury the flags an operator opens
 // this audit to find.
 const flaggedRows = flaggedOffs.map(auditOfftakerRow).join("");
 let okDrawer = "";
 if (okOffs.length) {
 const bits = [];
 if (matchN) bits.push("✓ " + matchN + " reconcile" + (matchN === 1 ? "s" : ""));
 if (quietN) bits.push(quietN + " awaiting data");
 okDrawer = `<details class="rb-au-collapsed"><summary class="rb-au-collapsed-sum">${bits.join(" · ")}</summary><div class="rb-au-offs rb-au-offs-drawer">${okOffs.map(auditOfftakerRow).join("")}</div></details>`;
 }
 const body = flaggedRows
 ? `<div class="rb-au-offs">${flaggedRows}</div>` + okDrawer
 : (okDrawer || `<div class="rb-au-offs"><div class="rb-au-off rb-au-quiet"><div class="rb-au-note rb-au-mute">No offtakers on this array yet.</div></div></div>`);
 return `<div class="rb-au-card${flagged ? " rb-au-card-flag" : ""}">
 <div class="rb-au-master">
 <div class="rb-au-master-name">${esc(a.array_name || ("Array " + (a.array_id != null ? a.array_id : "")))}
 ${flagged ? `<span class="rb-au-card-badge">⚑ ${flagged} flagged</span>` : ""}</div>
 <div class="rb-au-master-meta">
 <span class="rb-au-excess">Group excess <b>${a.group_excess_kwh != null ? fmt0(a.group_excess_kwh) + " kWh" : "—"}</b></span>
 ${rate ? `<span class="rb-au-rate">${esc(rate)}</span>` : ""}
 </div>
 </div>
 ${body}
 </div>`;
 }

 // Render the whole Bill-audit view into #rbAuditView (per-utility sub-tabs + array cards).
 function renderAudit() {
 const host = document.getElementById("rbAuditView");
 if (!host) return;
 if (!authHeaders()) { host.innerHTML = auditEmptyHTML("Sign in to audit GMP's per-offtaker allocation."); return; }
 if (!AUDIT) {
 // not loaded yet, kick the fetch, show a light loading state.
 host.innerHTML = `<div class="rb-au-loading">Loading the bill audit…</div>`;
 loadAudit().then(a => { if (a) renderAudit(); else host.innerHTML = auditEmptyHTML(); });
 return;
 }
 const utilities = (AUDIT.utilities || []).filter(u => (u.arrays || []).length);
 if (!utilities.length) {
 host.innerHTML = auditEmptyHTML();
 return;
 }
 // Which sub-tab is active, default to the first utility (or the last picked, if still present).
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

 // Arrays with a flagged offtaker surface as open cards; arrays that
 // reconcile cleanly collapse into one drawer at the bottom, the operator is
 // here to find mismatches, not scroll past clean arrays.
 const _arrs = active.arrays || [];
 const _hasFlag = x => (x.offtakers || []).some(o => o.status === "mismatch");
 const flaggedCards = _arrs.filter(_hasFlag).map(auditArrayCard).join("");
 const _cleanArrs = _arrs.filter(x => !_hasFlag(x));
 const cleanDrawer = _cleanArrs.length
 ? `<details class="rb-au-collapsed rb-au-clean-drawer"><summary class="rb-au-collapsed-sum">✓ ${fmt0(_cleanArrs.length)} array${_cleanArrs.length === 1 ? "" : "s"} reconcile cleanly</summary><div class="rb-au-cards rb-au-cards-drawer">${_cleanArrs.map(auditArrayCard).join("")}</div></details>`
 : "";
 const cards = (flaggedCards + cleanDrawer) || `<div class="rb-au-empty-clean">✓ Every offtaker's GMP allocation reconciles, nothing to review.</div>`;

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

 // Invoices secondary nav (Ford 2026-07-16): same treatment as Analysis.
 // Pills live in #panelReports .inv-sub-seg (under the main tabbar). Swaps
 // #rbGenList / #rbAuditView / #rbFinTrends. Deep links:
 // #reports | #reports/audit | #reports/trends
 function invoicesSubFromHash() {
 const h = (location.hash || "").toLowerCase();
 if (/#reports\/audit/i.test(h) || h === "#bill-audit" || h === "#billaudit") return "audit";
 if (/#reports\/trends/i.test(h)) return "trends";
 if (/#reports\/generation/i.test(h) && (_genrepOn || genrepFlag())) return "genreports";
 return "offtakers";
 }
 function applyInvoicesSub(v) {
 const tabs = Array.from(document.querySelectorAll(".inv-sub-seg [data-gentab], #rbGenTabs [data-gentab]"));
 const list = document.getElementById("rbGenList");
 const audit = document.getElementById("rbAuditView");
 const fin = document.getElementById("rbFinTrends");
 const gen = document.getElementById("rbGenReportsView");
 const pipe = document.getElementById("rb2Pipe");
 const head = document.querySelector("#rbSubInvoice .rb2-head");
 if (!v) v = invoicesSubFromHash();
 tabs.forEach(b => {
 const on = b.getAttribute("data-gentab") === v;
 b.classList.toggle("on", on);
 b.setAttribute("aria-pressed", on ? "true" : "false");
 });
 if (list) list.style.display = v === "offtakers" ? "" : "none";
 if (audit) audit.style.display = v === "audit" ? "" : "none";
 if (fin) fin.style.display = v === "trends" ? "" : "none";
 if (gen) gen.style.display = v === "genreports" ? "" : "none";
 if (pipe) pipe.style.display = (v === "offtakers") ? "" : "none";
 // The KPI glance-line is offtaker-invoicing chrome ("N offtakers · billed
 // arrays · don't match GMP") — it leaked onto the other sub-views' heads.
 const kpis = document.getElementById("rb2Kpis");
 if (kpis) kpis.style.display = (v === "offtakers") ? "" : "none";
 // Title band is offtaker-invoicing chrome; keep it for offtakers, soft-hide on others
 if (head) {
 const id = head.querySelector(".rb2-id h1");
 const sub = head.querySelector(".rb2-id #rb2Sub, .rb2-id p");
 if (v === "offtakers") {
 if (id) id.textContent = "Offtaker invoicing";
 if (sub) sub.style.display = "";
 } else if (v === "audit") {
 if (id) id.textContent = "Bill audit";
 if (sub) sub.style.display = "none";
 } else if (v === "trends") {
 if (id) id.textContent = "Invoice trends";
 if (sub) sub.style.display = "none";
 } else if (v === "genreports") {
 if (id) id.textContent = "Generation reports";
 if (sub) sub.style.display = "none";
 }
 }
 if (v === "audit") renderAudit();
 if (v === "trends") renderFinTrends();
 if (v === "genreports") renderGenReports();
 try {
 const want =
 v === "audit" ? "#reports/audit" :
 v === "trends" ? "#reports/trends" :
 v === "genreports" ? "#reports/generation" :
 "#reports";
 if ((location.hash || "").toLowerCase() !== want) {
 history.replaceState(null, "", want);
 }
 // replaceState fires no hashchange, so record the sub-tab memory explicitly.
 if (window.__aoRememberSub) window.__aoRememberSub();
 } catch (e) {}
 }
 function wireGenTabs() {
 const tabs = Array.from(document.querySelectorAll(".inv-sub-seg [data-gentab], #rbGenTabs [data-gentab]"));
 if (!tabs.length) return;
 tabs.forEach(btn => {
 btn.onclick = () => {
 const v = btn.getAttribute("data-gentab") || "offtakers";
 applyInvoicesSub(v);
 };
 });
 // Honor deep link / restore last sub-view
 revealGenrepPill();
 applyInvoicesSub(invoicesSubFromHash());
 }
 try { window.__aoApplyInvoicesSub = applyInvoicesSub; } catch (e) {}

 // ── Generation reports sub-tab (THE FOLD, 2026-07-16): the NEPOOL Operator
 // product folded in as a React embed module — solar-operator web/app's
 // `build:embed` bundle served from /genrep/ on THIS origin. It reads the
 // same so_session and calls the same /v1 API, so there's no auth plumbing.
 // Flag-gated while the spike bakes: ?genrep=1 persists the flag, ?genrep=0
 // clears it. Map: C:\Users\fordg\CC\nepool-fold\MAP.md.
 const GENREP_V = "20260716esAiOpen1";
 function genrepFlag() {
 try {
 const m = location.search.match(/[?&]genrep=([01])/);
 if (m) localStorage.setItem("ao_genrep", m[1]);
 return localStorage.getItem("ao_genrep") === "1";
 } catch (e) { return false; }
 }
 // The pill is ALWAYS visible (AO demo philosophy: every capability shows;
 // states are honest). World-gating happens at render time — the embed only
 // mounts for accounts whose generation-reports world is live.
 const _genrepOn = true;
 function revealGenrepPill() {
 const b = document.getElementById("invTabGenrep");
 // Drop the inline display:none!important (the important flag is required:
 // a .vs-seg-btn stylesheet rule sets display:flex!important, which beats
 // plain inline styles — the classic [hidden]-vs-flex trap).
 if (b) b.style.removeProperty("display");
 }
 let _genrepMounted = false;
 function renderGenReports() {
 const host = document.getElementById("rbGenReportsView");
 if (!host || _genrepMounted) return;
 if (!session()) {
 // Anonymous demo stays honest: no fabricated NEPOOL data, just the door.
 host.innerHTML = '<div class="rb-au-empty">Generation reports manage NEPOOL/REC reporting for your real fleet — automated quarterly NEPOOL-GIS workbooks, emailed to each client. Sign in or start a trial to use them.</div>';
 return;
 }
 // Enabled for EVERY operator (Ford 2026-07-16). Mount the embed directly; a
 // fresh tenant is guided through setup by the embed's own progress spine. No
 // per-account "not set up" wall — generation reports is a standard AO feature.
 mountGenrepEmbed(host);
 }
 function mountGenrepEmbed(host) {
 if (_genrepMounted) return;
 _genrepMounted = true;
 host.innerHTML = '<div class="rb-fin-loading">Loading generation reports…</div>';
 const fail = (e) => {
 _genrepMounted = false;
 host.innerHTML = '<div class="rb-au-empty">Couldn\'t load generation reports — ' + esc((e && e.message) || "script error") + '. Reload the page to retry.</div>';
 };
 try {
 if (!document.getElementById("genrepCss")) {
 const l = document.createElement("link");
 l.id = "genrepCss"; l.rel = "stylesheet";
 l.href = "/genrep/embed.css?v=" + GENREP_V;
 document.head.appendChild(l);
 }
 if (window.NepoolGenReports) { host.innerHTML = ""; window.NepoolGenReports.mount(host); return; }
 const s = document.createElement("script");
 s.src = "/genrep/embed.js?v=" + GENREP_V;
 s.onload = () => {
 try {
 if (!window.NepoolGenReports) throw new Error("embed bundle didn't register");
 host.innerHTML = "";
 window.NepoolGenReports.mount(host);
 } catch (e) { fail(e); }
 };
 s.onerror = () => fail(new Error("couldn't fetch the module"));
 document.head.appendChild(s);
 } catch (e) { fail(e); }
 }

 // ── Invoice Trends sub-tab (Paul 2026-07-15 / Ford): offtaker financial gains.
 // Production kWh lives on Analysis → Trends. This surface is dollars only —
 // what the owner makes from offtakers (last invoices, run-rate, YoY, shares).
 let _finTrendsLoaded = false;
 async function renderFinTrends(force) {
 const host = document.getElementById("rbFinTrends");
 if (!host) return;
 if (_finTrendsLoaded && !force && host.dataset.ready === "1") return;
 host.innerHTML = `<div class="rb-fin-loading">Loading offtaker gains…</div>`;

 const money0 = n => {
 const v = Number(n);
 if (!isFinite(v)) return "—";
 return "$" + Math.round(v).toLocaleString();
 };
 const money1 = n => {
 const v = Number(n);
 if (!isFinite(v)) return "—";
 return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
 };
 const fmt0 = n => Math.round(Number(n) || 0).toLocaleString();
 const esc = s => String(s == null ? "" : s)
 .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
 const cadenceLabel = c => {
 const x = String(c || "monthly").toLowerCase();
 if (x.indexOf("quarter") === 0) return "Quarterly";
 if (x.indexOf("annual") === 0 || x === "yearly" || x === "year") return "Annual";
 if (x.indexOf("semi") === 0) return "Semi-annual";
 return "Monthly";
 };

 let gains = null;
 try {
 const hdrs = authHeaders() || {};
 gains = await fetch("/v1/array-operator/billing/portfolio-gains", { headers: hdrs })
 .then(r => r.ok ? r.json() : null).catch(() => null);
 } catch (e) { /* demo / offline */ }

 // Demo fallback when signed out or API missing
 if (!gains && window.__AO_DEMO__) {
 gains = {
 ok: true,
 kpis: {
 enabled_offtakers: 4,
 with_last_invoice: 3,
 last_invoice_total_usd: 4550,
 pending_drafts: 2,
 pending_draft_usd: 1949,
 est_annual_usd: 54600,
 lifetime_sent_usd: 18200,
 },
 years: [2024, 2025, 2026],
 by_year: {
 "2024": { sent_usd: 41200, sent_count: 36 },
 "2025": { sent_usd: 48800, sent_count: 40 },
 "2026": { sent_usd: 18200, sent_count: 14 },
 },
 yoy: [
 { year: 2024, sent_usd: 41200, sent_count: 36, delta_pct: null },
 { year: 2025, sent_usd: 48800, sent_count: 40, delta_pct: 18.4 },
 { year: 2026, sent_usd: 18200, sent_count: 14, delta_pct: null },
 ],
 months: ["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"],
 by_month: {
 "2026-01": { sent_usd: 2800, sent_count: 3 },
 "2026-02": { sent_usd: 2650, sent_count: 3 },
 "2026-03": { sent_usd: 3100, sent_count: 3 },
 "2026-04": { sent_usd: 2900, sent_count: 2 },
 "2026-05": { sent_usd: 3200, sent_count: 2 },
 "2026-06": { sent_usd: 3550, sent_count: 1 },
 },
 offtakers: [
 { customer_name: "Valley Cares", enabled: true, cadence: "monthly", last_sent_amount_usd: 2150, last_sent_period_end: "2026-06-24", est_annual_usd: 25800, pending_amount_usd: 2150, sent_lifetime_usd: 9600, share_pct: 47.3 },
 { customer_name: "Town of Fairlee", enabled: true, cadence: "monthly", last_sent_amount_usd: 1250, last_sent_period_end: "2026-06-18", est_annual_usd: 15000, pending_amount_usd: 1250, sent_lifetime_usd: 5000, share_pct: 27.5 },
 { customer_name: "Town of Glover", enabled: true, cadence: "monthly", last_sent_amount_usd: 1150, last_sent_period_end: "2026-06-21", est_annual_usd: 13800, pending_amount_usd: null, sent_lifetime_usd: 3600, share_pct: 25.3 },
 { customer_name: "Norwich Fire District", enabled: true, cadence: "monthly", last_sent_amount_usd: null, last_sent_period_end: null, est_annual_usd: null, pending_amount_usd: 699, sent_lifetime_usd: null, share_pct: null },
 ],
 };
 }

 const k = (gains && gains.kpis) || {};
 const offtakers = (gains && gains.offtakers) || [];
 const yoy = (gains && gains.yoy) || [];
 const years = (gains && gains.years) || [];
 const byYear = (gains && gains.by_year) || {};
 const months = (gains && gains.months) || [];
 const byMonth = (gains && gains.by_month) || {};
 const curY = new Date().getFullYear();

 const kpis = `
 <div class="rb-fin-kpis">
 <div class="rb-fin-kpi">
 <div class="rb-fin-kl">Active offtakers</div>
 <div class="rb-fin-kv">${k.enabled_offtakers != null ? fmt0(k.enabled_offtakers) : "—"}</div>
 <div class="rb-fin-ks">${k.with_last_invoice != null ? fmt0(k.with_last_invoice) + " with a recorded invoice" : "Enabled schedules"}</div>
 </div>
 <div class="rb-fin-kpi">
 <div class="rb-fin-kl">Last invoices</div>
 <div class="rb-fin-kv">${k.last_invoice_total_usd != null ? money0(k.last_invoice_total_usd) : "—"}</div>
 <div class="rb-fin-ks">Sum of each offtaker’s latest send</div>
 </div>
 <div class="rb-fin-kpi">
 <div class="rb-fin-kl">Est. annual run-rate</div>
 <div class="rb-fin-kv">${k.est_annual_usd != null && k.est_annual_usd > 0 ? money0(k.est_annual_usd) : "—"}</div>
 <div class="rb-fin-ks">From last invoice × cadence</div>
 </div>
 <div class="rb-fin-kpi">
 <div class="rb-fin-kl">Delivered to date</div>
 <div class="rb-fin-kv">${k.lifetime_sent_usd != null && k.lifetime_sent_usd > 0 ? money0(k.lifetime_sent_usd) : "—"}</div>
 <div class="rb-fin-ks">${k.pending_draft_usd ? money0(k.pending_draft_usd) + " in pending drafts" : "Sent draft ledger"}</div>
 </div>
 </div>`;

 // Year-over-year bars (sent $ by calendar year of billing period)
 let yoyCard = "";
 if (yoy.length >= 1) {
 const maxY = Math.max.apply(null, yoy.map(r => Number(r.sent_usd) || 0).concat([1]));
 const bars = yoy.map(r => {
 const usd = Number(r.sent_usd) || 0;
 const pct = Math.max(4, Math.round(100 * usd / maxY));
 const isCur = r.year === curY;
 const delta = r.delta_pct != null
 ? `<span class="rb-fin-delta ${r.delta_pct >= 0 ? "up" : "dn"}">${r.delta_pct >= 0 ? "+" : ""}${r.delta_pct}%</span>`
 : (isCur ? `<span class="rb-fin-ytd">YTD</span>` : "");
 return `<div class="rb-fin-barrow">
 <div class="rb-fin-bary">${r.year}${delta ? " " + delta : ""}</div>
 <div class="rb-fin-bartrack"><div class="rb-fin-barfill" style="width:${pct}%"></div></div>
 <div class="rb-fin-barv">${money0(usd)}</div>
 <div class="rb-fin-barn">${fmt0(r.sent_count)} send${r.sent_count === 1 ? "" : "s"}</div>
 </div>`;
 }).join("");
 const yoyTableRows = yoy.map((r, i) => {
 const prior = i > 0 ? yoy[i - 1].sent_usd : null;
 const d = r.delta_pct != null
 ? `${r.delta_pct >= 0 ? "+" : ""}${r.delta_pct}%`
 : "—";
 return `<tr>
 <td class="rb-fin-name">${r.year}${r.year === curY ? ' <span class="rb-fin-ytd">YTD</span>' : ""}</td>
 <td class="rb-fin-num rb-fin-life">${money1(r.sent_usd)}</td>
 <td class="rb-fin-num">${fmt0(r.sent_count)}</td>
 <td class="rb-fin-num">${d}</td>
 </tr>`;
 }).join("");
 yoyCard = `
 <div class="rb-fin-card">
 <div class="rb-fin-ch">Year over year</div>
 <p class="rb-fin-cs">Dollars delivered to offtakers, grouped by the billing period’s end year.</p>
 <div class="rb-fin-bars">${bars}</div>
 <div class="rb-fin-scroll" style="margin-top:14px"><table class="rb-fin-table">
 <thead><tr><th>Year</th><th class="rb-fin-num">Delivered</th><th class="rb-fin-num">Sends</th><th class="rb-fin-num">vs prior</th></tr></thead>
 <tbody>${yoyTableRows}</tbody>
 </table></div>
 </div>`;
 } else {
 yoyCard = `
 <div class="rb-fin-card rb-fin-empty">
 <div class="rb-fin-ch">Year over year</div>
 <p class="rb-fin-cs">After you send invoices, delivered dollars stack here by year so you can compare seasons.</p>
 </div>`;
 }

 // Recent months (this year) — simple horizontal bars
 let monthCard = "";
 const recentMonths = months.slice(-12);
 if (recentMonths.length >= 2) {
 const maxM = Math.max.apply(null, recentMonths.map(ym => Number((byMonth[ym] || {}).sent_usd) || 0).concat([1]));
 const mbars = recentMonths.map(ym => {
 const cell = byMonth[ym] || {};
 const usd = Number(cell.sent_usd) || 0;
 const pct = Math.max(3, Math.round(100 * usd / maxM));
 const label = (() => {
 try {
 const [yy, mm] = ym.split("-");
 const d = new Date(Number(yy), Number(mm) - 1, 1);
 return d.toLocaleString(undefined, { month: "short", year: "2-digit" });
 } catch (e) { return ym; }
 })();
 return `<div class="rb-fin-barrow rb-fin-barrow-sm">
 <div class="rb-fin-bary">${esc(label)}</div>
 <div class="rb-fin-bartrack"><div class="rb-fin-barfill rb-fin-barfill-soft" style="width:${pct}%"></div></div>
 <div class="rb-fin-barv">${money0(usd)}</div>
 </div>`;
 }).join("");
 monthCard = `
 <div class="rb-fin-card">
 <div class="rb-fin-ch">Recent months</div>
 <p class="rb-fin-cs">Delivered invoice total by month (up to the last 12 with activity).</p>
 <div class="rb-fin-bars">${mbars}</div>
 </div>`;
 }

 // Offtaker contribution bars + full table
 let otCard = "";
 const moneyRows = offtakers.filter(o => o.enabled !== false);
 if (moneyRows.length) {
 const maxShare = Math.max.apply(null,
 moneyRows.map(o => Number(o.last_sent_amount_usd) || Number(o.est_annual_usd) || 0).concat([1]));
 const top = moneyRows.slice(0, 12);
 const shareBars = top.map(o => {
 const usd = Number(o.last_sent_amount_usd) || 0;
 const est = Number(o.est_annual_usd) || 0;
 const barVal = usd || est;
 const pct = Math.max(3, Math.round(100 * barVal / maxShare));
 const sub = usd
 ? money0(usd) + " last · " + (o.share_pct != null ? o.share_pct + "% of last invoices" : cadenceLabel(o.cadence))
 : (est ? money0(est) + " est. annual · no send yet" : "No invoice recorded yet");
 return `<div class="rb-fin-share">
 <div class="rb-fin-share-top">
 <span class="rb-fin-share-name">${esc(o.customer_name)}</span>
 <span class="rb-fin-share-amt">${usd ? money0(usd) : (est ? money0(est) + " /yr" : "—")}</span>
 </div>
 <div class="rb-fin-bartrack"><div class="rb-fin-barfill" style="width:${pct}%"></div></div>
 <div class="rb-fin-share-sub">${esc(sub)}</div>
 </div>`;
 }).join("");

 const body = moneyRows.map(o => {
 const last = o.last_sent_amount_usd != null ? money1(o.last_sent_amount_usd) : "—";
 const ann = o.est_annual_usd != null ? money1(o.est_annual_usd) : "—";
 const life = o.sent_lifetime_usd != null ? money1(o.sent_lifetime_usd) : "—";
 const pend = o.pending_amount_usd != null ? money1(o.pending_amount_usd) : "—";
 const period = o.last_sent_period_end || "—";
 return `<tr>
 <td class="rb-fin-name">${esc(o.customer_name)}${o.enabled === false ? ' <span class="rb-fin-off">off</span>' : ""}</td>
 <td class="rb-fin-num rb-fin-life">${last}</td>
 <td class="rb-fin-num">${esc(period)}</td>
 <td class="rb-fin-num">${esc(cadenceLabel(o.cadence))}</td>
 <td class="rb-fin-num">${ann}</td>
 <td class="rb-fin-num">${life}</td>
 <td class="rb-fin-num">${pend}</td>
 </tr>`;
 }).join("");
 const sumLast = moneyRows.reduce((n, o) => n + (Number(o.last_sent_amount_usd) || 0), 0);
 const sumAnn = moneyRows.reduce((n, o) => n + (Number(o.est_annual_usd) || 0), 0);
 const sumLife = moneyRows.reduce((n, o) => n + (Number(o.sent_lifetime_usd) || 0), 0);
 const sumPend = moneyRows.reduce((n, o) => n + (Number(o.pending_amount_usd) || 0), 0);
 const foot = `<tr class="rb-fin-tot">
 <td class="rb-fin-name"><b>Total</b></td>
 <td class="rb-fin-num rb-fin-life"><b>${sumLast ? money1(sumLast) : "—"}</b></td>
 <td class="rb-fin-num"></td>
 <td class="rb-fin-num"></td>
 <td class="rb-fin-num"><b>${sumAnn ? money1(sumAnn) : "—"}</b></td>
 <td class="rb-fin-num"><b>${sumLife ? money1(sumLife) : "—"}</b></td>
 <td class="rb-fin-num"><b>${sumPend ? money1(sumPend) : "—"}</b></td>
 </tr>`;

 otCard = `
 <div class="rb-fin-card">
 <div class="rb-fin-ch">Gains by offtaker</div>
 <p class="rb-fin-cs">What each offtaker contributes — last invoice, estimated annual, and delivered history.</p>
 <div class="rb-fin-shares">${shareBars}</div>
 <div class="rb-fin-scroll" style="margin-top:16px"><table class="rb-fin-table rb-fin-table-wide">
 <thead><tr>
 <th>Offtaker</th>
 <th class="rb-fin-num">Last invoice</th>
 <th class="rb-fin-num">Period end</th>
 <th class="rb-fin-num">Cadence</th>
 <th class="rb-fin-num">Est. annual</th>
 <th class="rb-fin-num">Delivered</th>
 <th class="rb-fin-num">Pending</th>
 </tr></thead>
 <tbody>${body}${foot}</tbody>
 </table></div>
 </div>`;
 } else {
 otCard = `
 <div class="rb-fin-card rb-fin-empty">
 <div class="rb-fin-ch">Gains by offtaker</div>
 <p class="rb-fin-cs">Add offtakers and send an invoice — their dollars show up here as your offtaker business grows.</p>
 </div>`;
 }

 const note = `
 <div class="rb-fin-note">
 Edit schedules on <button type="button" class="rb-fin-link" id="rbFinGoOfftakers">Offtakers</button>.
 Production kWh by year lives on <b>Analysis → Trends</b>.
 </div>`;

 host.innerHTML = `
 <div class="rb-fin-wrap">
 <div class="rb-fin-intro">
 <h2 class="rb-fin-h">Offtaker gains</h2>
 <p class="rb-fin-p">What you’ve made from offtakers — last invoices, run-rate, and year-over-year delivery.</p>
 </div>
 ${kpis}
 ${yoyCard}
 ${monthCard}
 ${otCard}
 ${note}
 </div>`;

 const go = document.getElementById("rbFinGoOfftakers");
 if (go) go.onclick = () => {
 const t = document.querySelector('.inv-sub-seg [data-gentab="offtakers"], #rbGenTabs [data-gentab="offtakers"]');
 if (t) t.click();
 else if (window.__aoApplyInvoicesSub) window.__aoApplyInvoicesSub("offtakers");
 };
 host.dataset.ready = "1";
 _finTrendsLoaded = true;
 }

 // ── pdf.js: paint page 1 of a PDF onto a <canvas> inside `paper`, no browser
 // PDF-viewer chrome. Shared by the template-card preview AND the approval-inbox
 // draft preview, so both show the REAL reproduced invoice (not lossy token-HTML).
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
 function _pdfFallbackIframe(buf, paper) { // CDN-down fallback: native viewer, chrome suppressed
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
 // figures stay legible enough to verify, Ford: "hard to read the numbers."
 const targetW = Math.min(Math.max(cssW * 3, 1600), 2600);
 const vp = page.getViewport({ scale: targetW / base.width });
 const canvas = document.createElement("canvas");
 canvas.width = Math.ceil(vp.width);
 canvas.height = Math.ceil(vp.height);
 await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
 paper.innerHTML = "";
 paper.appendChild(canvas);
 // Click to enlarge, a full-screen, even sharper view to read every number.
 canvas.classList.add("rb-tpl-zoomable");
 canvas.title = "Click to enlarge";
 canvas.onclick = () => _pdfLightbox(lbBuf);
 } catch (e) { _pdfFallbackIframe(buf, paper); }
 }

 // Full-screen lightbox of the invoice, large + crisp so every number is readable.
 // Click anywhere (or Esc) to dismiss.
 async function _pdfLightbox(buf) {
 let lib;
 try { lib = await _ensurePdfJs(); } catch (e) { return; }
 const overlay = document.createElement("div");
 overlay.className = "rb-tpl-lightbox";
 overlay.innerHTML = '<div class="rb-tpl-lb-inner"><div class="rb-tpl-load" style="color:#9fb0c0">Rendering…</div></div>';
 // Discoverability toast: the full-screen preview takes over the screen and it wasn't
 // obvious how to get out (Ford 2026-07-11). This little pill spells it out. It's
 // pointer-events:none so it never blocks the click-anywhere-to-close, and fades on its own.
 const hint = document.createElement("div");
 hint.className = "rb-tpl-lb-hint";
 hint.innerHTML = 'Press <kbd>Esc</kbd> or click outside to close';
 overlay.appendChild(hint);
 const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
 function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
 overlay.onclick = close;
 document.addEventListener("keydown", onKey);
 document.body.appendChild(overlay);
 try {
 // pdf.js transfers (and detaches) the buffer it's given, so render from a fresh
 // COPY each time, otherwise the first enlarge consumes `buf` and every later
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

 // pending match awaiting "Save schedule", holds the File + parsed match.
 let PENDING = null;

 function root() { return document.getElementById("reportsRoot"); }

 // Canonical GMP-bill attachment name: gmp_utility_bill_<offtaker>_<period>.pdf —
 // matches the invoice's own name so the offtaker gets a self-describing file, not
 // the operator's raw upload name. Mirrors the backend (delivery.py generate_files).
 function gmpBillFilename(d) {
 const slug = String((d && d.customer_name) || "offtaker").toLowerCase()
 .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "offtaker";
 const suf = (d && d.invoice_number) ? "_" + d.invoice_number : "";
 // Provider-aware: a VEC/SmartHub offtaker's bill is a VEC bill, not a GMP one
 // (mirrors the backend's vec_utility_bill_… naming in delivery.generate_files).
 const prov = ((d && d.attach_provider) || "gmp").toLowerCase();
 const pfx = prov === "gmp" ? "gmp" : prov;
 return `${pfx}_utility_bill_${slug}${suf}.pdf`;
 }

 // ---- top-level entry -------------------------------------------------------
 // load() runs on every Reports tab activation. It used to rebuild the whole
 // shell + re-fetch everything (including the heavy invoice-template PDF
 // preview) on EVERY visit, so the tab visibly "reloaded" each time. It's now
 // idempotent: build the shell + wire handlers ONCE, render the heavy template
 // preview once (and only when the tab is actually viewed, not during an idle
 // prefetch), and never re-blank an already-rendered tab, just a quiet
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
 // the fake operator (Catamount Community Solar), its offtaker list + an
 // approval inbox with a styled demo invoice, instead of the sign-in wall.
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
 // The guided setup wizard was removed, the operator works the tab
 // directly: set the global rate, "＋ Add an offtaker", and link GMP bills.
 el.innerHTML = shell();
 wireSubtabs();
 wireGenTabs(); // "Offtakers | Bill audit" segmented toggle
 wireGlobalRate();
 // "＋ Add an offtaker" opens a tabbed panel (Type it in / Upload a
 // spreadsheet); the upload zone + live doc-preview live inside that panel
 // now, so wireUpload()/renderDoc() are wired when the upload tab opens.
 MANUAL_HOST_ID = "rbCustManual";
 MANUAL_AFTER_ADD = refreshList;
 MANUAL_OPEN = false;
 const addBtn = $("#rbCustAdd");
 if (addBtn) addBtn.onclick = () => {
 BULK_OPEN = false; renderBulkImport(); MANUAL_OPEN = true; renderManual();
 // Jump to the freshly-opened add panel (Ford): an operator scrolled deep into a
 // long offtaker list shouldn't have to hunt back up to the top for it. rAF so the
 // panel is painted before we scroll; focus the first field (preventScroll so the
 // focus doesn't fight the smooth scroll) so they can start typing right away.
 requestAnimationFrame(() => {
 const host = document.getElementById(MANUAL_HOST_ID);
 if (!host) return;
 const target = host.querySelector(".rb-add-panel") || host;
 target.scrollIntoView({ behavior: "smooth", block: "start" });
 const first = host.querySelector("select, input, textarea");
 if (first) { try { first.focus({ preventScroll: true }); } catch (_) { /* older browsers */ } }
 });
 };
 // "⬆ Bulk import", any roster spreadsheet creates many offtakers at once.
 // Closes the manual panel if open (mutually exclusive with type-it-in).
 const bulkBtn = $("#rbBulkImport");
 if (bulkBtn) bulkBtn.onclick = () => openBulkImport();
 // "Link utility bills", ONE button opens the utility picker (every supported
 // utility, searchable, GMP/VEC/WEC quick-picks + ~470 SmartHub co-ops from
 // /v1/providers). The owner picks theirs; the extension opens that portal and
 // captures the bills, which then appear in the offtaker utility-account picker.
 // Offtaker invoices bill from these utility bills only.
 const linkUtilBtn = $("#rbLinkUtility");
 if (linkUtilBtn) linkUtilBtn.onclick = () => {
 if (window.__aoLinkUtility) { window.__aoLinkUtility(); }
 else { location.hash = "#arrays"; } // defensive: sandbox owns the modal
 };
 // Master email card + toolbar "✉ Customize email" both open the mass studio.
 wireMasterEmail();
 // "⬇ Export to QuickBooks / Xero", this reaches shell() only on the signed-in
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
 // drafts inline), the old separate approval inbox is gone.
 Promise.all([refreshList(), refreshGmpBillsStatus()]).catch(() => {});
 // The send-pipeline band (fire-and-forget; hidden until data lands).
 loadPipeline();
 // Kick the bill-audit sweep in PARALLEL from t=0 so its ~11s server compute
 // (cached 10 min) overlaps the list render instead of starting after it, the
 // "Doesn't match GMP" tile fills sooner (Ford 2026-07-07: it was slow). It's
 // memoized (RECON/_reconPromise), so this shares the same sweep as the list.
 loadReconcile().catch(() => {});
 // Auto-draft: kick a draft-all now (from settled bills) + start the poll that
 // re-drafts as new bills land, no manual button (Ford 2026-07-07).
 if (!prefetch && authHeaders()) { autoDraftAll({ force: true }); startAutoDraftPoll(); }
 }
 // Invoice archive (monthly directory): fetch the manifest once (cached) on a real
 // view and render the collapsible directory. Skipped during the idle prefetch;
 // fails soft (fetch error → renderArchive keeps the host hidden).
 if (!prefetch && authHeaders()) {
 loadArchive().then(() => renderArchive()).catch(() => {});
 }
 }
 window.__aoLoadReports = load;
 // Hands-off tour: open Invoices and expand a specific offtaker (bill + draft lined up).
 window.__aoOpenOfftakerPreview = function (subId) {
 try {
 if (location.hash !== "#reports") location.hash = "#reports";
 else if (typeof load === "function") load();
 } catch (_) { /* hash navigate */ }
 const sid = subId != null && subId !== "" ? String(subId) : null;
 // Prefer explicit id; otherwise first accordion offtaker on the list.
 const openFirst = () => {
 if (sid) { deepLinkOpen(sid, 30); return; }
 const first = document.querySelector("#rbList .rb-acc[data-id]");
 if (first) {
 const id = first.getAttribute("data-id");
 if (id) deepLinkOpen(id, 30);
 else {
 const el = document.getElementById("rbList") || document.querySelector(".rb2-listwrap");
 if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
 }
 } else {
 const el = document.getElementById("rbList") || document.querySelector(".rb2-listwrap");
 if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
 }
 };
 setTimeout(openFirst, 420);
 };
 // Hands-off tour: flip fleet delivery mode (approve vs auto) from the dream step.
 window.__aoSetDeliveryMode = function (mode) {
 try {
 if (typeof setDeliveryModeAll === "function") setDeliveryModeAll(mode === "auto" ? "auto" : "approval");
 else if (PIPE) {
 PIPE.default_delivery_mode = mode === "auto" ? "auto" : "approval";
 try { renderPipeline(); } catch (_) {}
 }
 } catch (_) { /* reports not mounted yet */ }
 };

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

 // The moment a utility login is saved (auto-refresh set up), sandbox.js fires
 // ao:vault-changed, re-render the bills-status line so the "Set up auto-refresh"
 // nudge disappears live (Ford 2026-07-10), and the "✓ … refreshing automatically"
 // confirmation takes its place, no reload needed.
 if (!window.__aoVaultBannerWired) {
 window.__aoVaultBannerWired = true;
 window.addEventListener("ao:vault-changed", () => { try { refreshGmpBillsStatus(); } catch(e){} });
 }

 // Show whether GMP utility bills are connected (and how many), with a direct
 // link to connect when none are present, answers "why is the dropdown empty?"
 // ALSO answers "will this run by itself?":
 // • device mode → bills refresh when the extension vault has that utility login
 // • cloud mode → bills refresh when Account → Auto-refresh has a server-side
 // credential for that provider (extension vault is irrelevant)
 // Bug fixed 2026-07-14: cloud-mode owners still saw "Set up auto-refresh" because
 // we only consulted __aoVaultStatus (device vault) and ignored cloud credentials.
 const _UTIL_LABEL = { gmp: "Green Mountain Power", vec: "Vermont Electric Co-op", wec: "Washington Electric Co-op" };
 const _utilLabel = (code) => _UTIL_LABEL[code] || String(code || "").replace(/^sh_/, "").toUpperCase();
 function _arModeIsCloud() {
 try { return localStorage.getItem("ao_ar_mode") === "cloud"; } catch (e) { return false; }
 }
 async function _cloudProviderCoverage() {
 // Set of provider codes that have an enabled cloud credential.
 let status = null;
 try {
 if (typeof window.__aoCloudStatus === "function") {
 const cs = await window.__aoCloudStatus();
 if (cs && cs.ok !== false) status = cs;
 }
 } catch (e) { /* fall through to fetch */ }
 if (!status) {
 try {
 const r = await fetch("/v1/cloud-capture/status", { headers: authHeaders() });
 if (r.ok) status = await r.json();
 } catch (e) { return null; }
 }
 if (!status) return null;
 const covered = new Set();
 (status.credentials || []).forEach((c) => {
 if (c && c.enabled === false) return;
 const p = String((c && c.provider) || "").toLowerCase();
 if (p) covered.add(p);
 });
 return covered;
 }
 async function utilityAutomationState(accts) {
 // → {auto:true, mode} all providers covered; {auto:false, missing, mode};
 // null = can't know (no accounts / both status paths unreachable).
 // A provider is covered if EITHER cloud credentials OR the device vault has it —
 // cloud-mode owners must not be nagged because the extension vault is empty.
 try {
 if (!accts.length) return null;
 const providers = [...new Set(accts.map(a => (a.provider || "gmp").toLowerCase()))];
 const preferCloud = _arModeIsCloud();

 const cloudCovered = await _cloudProviderCoverage(); // Set | null
 let vaultStatus = null;
 try {
 if (typeof window.__aoVaultStatus === "function") {
 vaultStatus = await window.__aoVaultStatus();
 }
 } catch (e) { vaultStatus = null; }

 // Neither path available → unknown (don't flash a wrong nudge)
 if (!cloudCovered && !vaultStatus) return null;

 function vaultHas(p) {
 if (!vaultStatus) return false;
 if (vaultStatus[p] && vaultStatus[p].hasCreds) return true;
 return Object.keys(vaultStatus).some((k) =>
 (k === p || k.indexOf(p + "::") === 0) && vaultStatus[k] && vaultStatus[k].hasCreds
 );
 }
 function cloudHas(p) {
 return !!(cloudCovered && cloudCovered.has(p));
 }

 const missing = providers.filter((p) => !cloudHas(p) && !vaultHas(p));
 // Prefer cloud messaging when mode is cloud OR only cloud covers everything
 const anyCloud = providers.some(cloudHas);
 const mode = preferCloud || (anyCloud && !providers.some(vaultHas)) ? "cloud" : "device";
 return missing.length
 ? { auto: false, missing, mode }
 : { auto: true, mode };
 } catch (e) { return null; }
 }
 function autoRefreshNudgeHTML(missing, mode) {
 const names = missing.map(_utilLabel).join(" and ");
 // Compact inline pill (Ford 2026-07-10 declutter): the full explanation moved
 // into the tooltip so the toolbar rail stays one slim line. Same #rbAutoRefreshLink
 // id + wireAutoRefreshLink wiring, it still deep-links to Account → Auto-refresh.
 const tip = mode === "cloud"
 ? `Save your ${names} login under Account → Auto-refresh (Store it with us) so bills refresh 24/7 without opening a portal.`
 : `Invoices update only when you open your utility portal. Save your ${names} login once and they generate automatically every month.`;
 return `<a class="rb-gmp-arpill" id="rbAutoRefreshLink" role="button" tabindex="0"
 title="${esc(tip)}">⚡ Set up auto-refresh</a>`;
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
 // land with the panel OPEN, the operator came here to type a password
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
 // All three states render as slim inline pills now (Ford 2026-07-10), the rail
 // lives inside the toolbar row, so the long banners became short pills with the
 // detail in the tooltip. Same ids (#rbGmpInlineLink / #rbAutoRefreshLink) + wiring.
 const mode = (autoState && autoState.mode) || (_arModeIsCloud() ? "cloud" : "device");
 const autoOn = !!(autoState && autoState.auto);
 const needNudge = !!(autoState && !autoState.auto);
 const autoSuffix = autoOn
 ? (mode === "cloud" ? " · cloud auto-refresh" : " · refreshing automatically")
 : "";
 if (!accts.length) {
 host.innerHTML = `<a class="rb-gmp-arpill" id="rbGmpInlineLink" role="button" tabindex="0"
 title="Offtaker invoices bill from your utility bills. Link one to get started.">⚡ Link utility bills to start</a>`;
 wireConnectUtility();
 } else if (!withBills.length) {
 const noBillTip = mode === "cloud"
 ? `${accts.length} utility account${accts.length === 1 ? "" : "s"} connected, but no bills yet. Cloud auto-refresh will pull them once the next harvest runs, or open Account → Auto-refresh and hit refresh.`
 : `${accts.length} utility account${accts.length === 1 ? "" : "s"} connected, but no bills yet. Open your utility portal again so the extension captures them.`;
 host.innerHTML = `<a class="rb-gmp-arpill" id="rbGmpInlineLink" role="button" tabindex="0"
 title="${esc(noBillTip)}">⚡ ${fmt0(accts.length)} connected · no bills captured yet</a>` +
 (needNudge ? autoRefreshNudgeHTML(autoState.missing, mode) : "");
 wireConnectUtility();
 wireAutoRefreshLink();
 } else {
 const okTip = autoOn
 ? (mode === "cloud"
 ? "Utility bills refresh via cloud auto-refresh (stored with us, 24/7)."
 : "Utility bills refresh when your saved extension vault logins run.")
 : "These utility bill sources are available to link when you add an offtaker.";
 host.innerHTML = `<span class="rb-gmp-ok" title="${esc(okTip)}">✓ ${fmt0(withBills.length)} bill source${withBills.length === 1 ? "" : "s"}${autoSuffix}</span>` +
 (needNudge ? autoRefreshNudgeHTML(autoState.missing, mode) : "");
 wireAutoRefreshLink();
 }
 }

 // ── Export to QuickBooks / Xero ────────────────────────────────────────────
 // A portfolio-level batch action: download the current period's offtaker invoices
 // as a QuickBooks/Xero-import CSV. The endpoint requires the Bearer header, so a
 // plain <a href download> can't carry auth, we do an authenticated fetch → blob →
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
 for (let i = 0; i < 40; i++) { // ≤ ~7 min of 10s polls
 const r = await fetch(url, { headers: authHeaders() });
 const ct = r.headers.get("content-type") || "";
 if (r.status === 202 || ct.includes("application/json")) {
 let d = null; try { d = await r.json(); } catch (e) {}
 if (d && d.pending) { await new Promise(res => setTimeout(res, 2500)); continue; }
 throw new Error((d && d.detail) || "Nothing to export for this period yet.");
 }
 if (!r.ok) throw new Error("Download failed (HTTP " + r.status + ").");
 const count = r.headers.get("X-Invoice-Count") || r.headers.get("X-File-Count");
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
 throw new Error("Export is taking longer than usual, try again in a moment.");
 }

 const EXPORT_ACCT_KEY = "ao_qb_export_account_code";
 const EXPORT_FMT_KEY = "ao_qb_export_format";
 const EXPORT_MEMO_KEY = "ao_qb_export_memo";
 // Operator-facing label per format (for the status line + filename fallback).
 const EXPORT_LABELS = { quickbooks: "QuickBooks Online", iif: "QuickBooks Desktop", xero: "Xero" };
 const EXPORT_EXT = { iif: "iif" }; // everything else downloads a .csv
 function wireExport() {
 const box = $("#rbExportBox"), acct = $("#rbExportAcct"), stat = $("#rbExportStat");
 const fmtSel = $("#rbExportFmt"), dateInp = $("#rbExportDate"), periodSel = $("#rbExportPeriod");
 const memoInp = $("#rbExportMemo"), iifNote = $("#rbExportIifNote"), go = $("#rbExportGo");
 if (!box || !go || !fmtSel) return;
 if (!authHeaders()) { box.hidden = true; return; } // defensive; demo never reaches here
 box.hidden = false;

 // Restore remembered choices (format, income account, memo). Default the
 // invoice date to today so an export is one click from opening the popover.
 try { const f = localStorage.getItem(EXPORT_FMT_KEY); if (f && EXPORT_LABELS[f]) fmtSel.value = f; } catch (e) {}
 if (acct) { try { acct.value = localStorage.getItem(EXPORT_ACCT_KEY) || ""; } catch (e) {} }
 if (memoInp) { try { memoInp.value = localStorage.getItem(EXPORT_MEMO_KEY) || ""; } catch (e) {} }
 if (dateInp && !dateInp.value) {
 const d = new Date(); const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
 .toISOString().slice(0, 10);
 dateInp.value = iso;
 }
 const persist = (key, v) => { try { localStorage.setItem(key, (v || "").trim()); } catch (e) {} };
 if (acct) acct.addEventListener("input", () => persist(EXPORT_ACCT_KEY, acct.value));
 if (memoInp) memoInp.addEventListener("input", () => persist(EXPORT_MEMO_KEY, memoInp.value));

 // The IIF honesty note + the "income account" hint only apply to
 // QuickBooks Desktop / Xero, QuickBooks Online ignores the account. Reflect
 // the current format so the operator sees exactly what each field does.
 function syncFormat() {
 const fmt = fmtSel.value;
 persist(EXPORT_FMT_KEY, fmt);
 if (iifNote) iifNote.hidden = (fmt !== "iif");
 const acctWrap = $("#rbExportAcctWrap");
 if (acctWrap) acctWrap.style.display = (fmt === "quickbooks") ? "none" : "";
 }
 fmtSel.addEventListener("change", syncFormat);
 syncFormat();

 // Populate the billing-cycle picker from the fleet's settled periods (union
 // across offtakers). Keep the implicit "Latest bill per offtaker" default on
 // top; each option shows how many offtakers have a settled bill for it, so
 // the operator sees the coverage of a chosen cycle. Best-effort, a failure
 // just leaves the latest-bill default (the long-standing behavior).
 if (periodSel && !periodSel.dataset.loaded) {
 periodSel.dataset.loaded = "1";
 fetch(API + "/export-periods", { headers: authHeaders() })
 .then(r => r.ok ? r.json() : null)
 .then(d => {
 const periods = (d && d.periods) || [];
 for (const p of periods) {
 const o = document.createElement("option");
 o.value = p.label;
 o.textContent = p.pretty + (p.count ? " · " + p.count + " offtaker" + (p.count === 1 ? "" : "s") : "");
 periodSel.appendChild(o);
 }
 })
 .catch(() => {});
 }

 const setStat = (cls, msg) => { if (stat) { stat.className = "rb-export-stat" + (cls ? " " + cls : ""); stat.textContent = msg || ""; } };
 let _busy = false;
 // One unified download: the chosen format + invoice date + billing cycle +
 // memo + income account all hit /invoice-export.csv, which computes in a
 // background sweep at scale (202 {pending} while it runs) then serves the
 // file (CSV or, for QuickBooks Desktop, a .iif). The backend stamps the
 // filename via Content-Disposition.
 async function doExport() {
 if (_busy) return;
 _busy = true;
 go.disabled = true;
 const fmt = fmtSel.value;
 const label = EXPORT_LABELS[fmt] || fmt;
 setStat("rb-busy", "Preparing your " + label + " export…");
 const params = new URLSearchParams({ format: fmt });
 const code = acct && acct.value.trim();
 if (code) params.set("account_code", code);
 const memo = memoInp && memoInp.value.trim();
 if (memo) params.set("memo", memo);
 const period = periodSel && periodSel.value;
 if (period) params.set("period", period);
 const idate = dateInp && dateInp.value;
 if (idate) params.set("invoice_date", idate);
 const url = API + "/invoice-export.csv?" + params.toString();
 const ext = EXPORT_EXT[fmt] || "csv";
 try {
 const res = await exportPoll(url, "offtaker-invoices-" + fmt + "." + ext);
 const n = res.count;
 setStat("rb-ok", n != null
 ? ("✓ Exported " + n + " invoice" + (n === 1 ? "" : "s") + " for " + label + ".")
 : "✓ Exported, file downloaded.");
 } catch (e) {
 setStat("rb-err", (e && e.message) || ("Export to " + label + " failed, check your connection."));
 } finally {
 _busy = false;
 go.disabled = false;
 }
 }
 go.onclick = doExport;
 // Enter anywhere in the form triggers the download.
 box.addEventListener("keydown", (e) => {
 if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { e.preventDefault(); doExport(); }
 });
 }

 /* ===========================================================================
 * INVOICE ARCHIVE (monthly directory), Anna's ask #2.
 *
 * A browsable, collapsible directory of past billing months → arrays →
 * offtakers, with honest availability badges (invoice / offtaker bill / array
 * bill) and a per-month .zip download laid out <month>/<array>/{invoice, each
 * offtaker bill, the array's own bill}. Portfolio-level month-close surface,
 * signed-in only. Manifest fetched ONCE, cached (refetched on reload). Fails
 * soft: a fetch error just leaves the section absent, never blocks the generator.
 * ==========================================================================*/
 let ARCHIVE = null; // /invoice-archive manifest (cached)
 let _archivePromise = null;
 let _archiveOpen = false; // remember the panel's open/closed state across refreshes
 function loadArchive() {
 if (ARCHIVE) return Promise.resolve(ARCHIVE);
 if (_archivePromise) return _archivePromise;
 if (!authHeaders()) return Promise.resolve(null);
 // The manifest computes in a background sweep (a match per offtaker, ~60s
 // at 800 crossed the edge timeout); {pending:true} means "poll again".
 _archivePromise = (async () => {
 for (let i = 0; i < 30; i++) { // ≤ ~5 min of 10s polls
 try {
 const r = await fetch(API + "/invoice-archive", { headers: authHeaders() });
 if (!r.ok) return null;
 const d = await r.json().catch(() => null);
 if (d && d.ok) { ARCHIVE = d; return ARCHIVE; }
 if (!d || !d.pending) return null;
 } catch (e) { return null; }
 await new Promise(res => setTimeout(res, 2500));
 }
 return null;
 })().then(v => { _archivePromise = null; return v; });
 return _archivePromise;
 }

 // A single availability badge, emerald ✓ when present, muted "—" when not.
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
 // Empty state, honest, quiet.
 if (!total || !months.length) {
 host.innerHTML = `<details class="rb-arch"${_archiveOpen ? " open" : ""} id="rbArch">
 <summary class="rb-arch-sum"><span class="rb-sec-caret" aria-hidden="true">▸</span>
 <span class="rb-arch-t">Invoice archive</span>
 <span class="rb-arch-sub">monthly directory</span></summary>
 <div class="rb-arch-body">
 <p class="rb-arch-empty">No invoices archived yet. They'll appear once a GMP bill has billable excess.</p>
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
 // A month's zip renders hundreds of PDFs at scale → computed in a
 // background sweep (202 {pending} while it builds); poll, then download.
 const res = await exportPoll(url, "offtaker-invoices-" + month + ".zip");
 const n = res.count;
 setStat("rb-ok", n != null ? ("✓ Downloaded " + n + " file" + (n === 1 ? "" : "s") + ".") : "✓ Downloaded.");
 } catch (e) {
 setStat("rb-err", (e && e.message) || "Download failed, check your connection.");
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
 * ANONYMOUS DEMO, a fully-populated Offtaker Invoice Generator for the fake
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
 wireGenTabs(); // the "Offtakers | Bill audit" toggle works in the demo too (audit shows the sign-in state)
 wireMasterEmail(); // sample preview card + Customize CTA (demo-nudged)
 _demoBuilt = true;
 }
 // Demo note, big-operator snapshot (scale from AO_DEMO.meta when present).
 const head = $(".rb-list-head");
 if (head && !$("#rbDemoNote")) {
 const note = document.createElement("div");
 note.id = "rbDemoNote";
 note.className = "rb-gmp-ok";
 note.style.cssText = "margin:2px 0 0;background:rgba(33,150,243,.08);border:1px solid rgba(33,150,243,.22);color:var(--muted)";
 const meta = D.meta || {};
 const scale = meta.offtakers
 ? `${meta.arrays || "—"} sites · ${meta.offtakers} offtakers`
 : "sample operator";
 note.innerHTML = `Demo · <b>Northeast Community Solar</b> (${scale}), sample mid-cycle state. <a href="/onboarding" style="color:var(--good);font-weight:650">Create an account →</a>`;
 head.parentNode.insertBefore(note, head.nextSibling);
 }
 const gmpStatus = $("#rbGmpBillsStatus");
 if (gmpStatus) gmpStatus.innerHTML =
 `<div class="rb-gmp-ok">✓ ${D.offtakers.length} offtakers billing from multi-utility bills (GMP · VEC · WEC · Eversource · CMP).</div>`;

 // Multi-array / multi-utility book (falls back to a single site if old shape).
 const demoArrays = (D.arrays && D.arrays.length)
 ? D.arrays.map(a => ({ id: a.id, name: a.name, client_name: a.client_name || "" }))
 : [{ id: 1, name: "Catamount Community Solar", client_name: "" }];
 const demoUtil = (D.utilAccounts && D.utilAccounts.length)
 ? D.utilAccounts.slice()
 : [{ utility_account_id: 9001, array_id: 1, provider: "gmp",
 nickname: "Catamount Community Solar", service_address: "120 Main St, Waterbury, VT",
 has_bill: true, bill_count: 6, account_number: "GMP-558210", latest_period_label: "2026-06" }];

 OFFTAKERS = D.offtakers.slice();
 INBOX_DRAFTS = D.drafts.slice();
 DRAFT_BY_SUB = {};
 INBOX_DRAFTS.forEach(d => {
 const sub = OFFTAKERS.find(s => s.customer_name === d.customer_name);
 if (sub) { d.subscription_id = null; DRAFT_BY_SUB[String(sub.id)] = d; }
 });
 INBOX_UTIL_ACCTS = demoUtil;
 ACC_ARRS = demoArrays;
 TEMPLATE_STATE = { has: false, enabled: false };

 // Pipeline band, frozen mid-cycle action (healthy, not bounced).
 if (D.pipeline) {
 PIPE = D.pipeline;
 try { renderPipeline(); renderKpis(); } catch (_) { /* pipeline optional */ }
 }

 // Hierarchical offtaker list (utility → account → offtaker), same path as live
 // for fleets > a handful; defaults collapsed so 300 offtakers don't paint 300 cards.
 try {
 renderAccordion(OFFTAKERS, demoArrays, demoUtil, INBOX_DRAFTS);
 } catch (_) {
 const list = $("#rbList");
 if (list) {
 const pending = OFFTAKERS.filter(s => DRAFT_BY_SUB[String(s.id)]).length;
 const headLine = pending
 ? `<b>${pending}</b> report${pending === 1 ? "" : "s"} ready to review &amp; send. Review before you send.`
 : `Select an offtaker to review and send.`;
 list.innerHTML = `<div class="rb-acc-lead">${headLine}</div>` +
 OFFTAKERS.slice(0, 40).map(s => subCard(s, demoArrays, demoUtil)).join("") +
 (OFFTAKERS.length > 40
 ? `<div class="empty" style="padding:12px;color:var(--faint)">+ ${OFFTAKERS.length - 40} more offtakers, sign up to manage the full book.</div>`
 : "");
 wireAccordionHeaders(list);
 }
 }
 ACTIVE_SUB_ID = null;
 const list = $("#rbList");
 if (list) {
 const reintercept = () => {
 list.querySelectorAll("[data-dact]").forEach(b => {
 const act = b.getAttribute("data-dact");
 if (act === "approve" || act === "sendme" || act === "aiemail" || act === "savemsg" || act === "preview")
 b.onclick = (e) => { e.preventDefault(); demoNudge(b); };
 });
 };
 reintercept();
 list.querySelectorAll("[data-acchead]").forEach(h => {
 h.addEventListener("click", () => requestAnimationFrame(reintercept));
 });
 }

 const addBtn = $("#rbCustAdd"); if (addBtn) addBtn.onclick = () => demoNudge(addBtn);
 const linkBtn = $("#rbLinkUtility"); if (linkBtn) linkBtn.onclick = () => demoNudge(linkBtn);
 const esBtn = $("#rbEmailStudio"); if (esBtn) esBtn.onclick = () => demoNudge(esBtn);
 const mmBtn = $("#rbMasterEmailOpen"); if (mmBtn) mmBtn.onclick = () => demoNudge(mmBtn);
 const exBtn = $("#rb2ExportBtn"); if (exBtn) exBtn.onclick = () => demoNudge(exBtn);
 }

 // A gentle, in-place "this is a demo" affordance, no fetch, no error.
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

 // ─── Offtaker email studio, the MASS email customizer (Anna-scale ask) ────
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
 // Parity with Generation reports EmailTemplateStudio sign-off starters.
 { label: "Full signature", value: "<p>Thank you,<br><strong>{{tenant_name}}</strong><br>Solar consultant<br>{{tenant_email}}</p>" },
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
 // across a (re)load, it would re-save stale content over fresh state.
 clearTimeout(ES.saveT); clearTimeout(ES.prevT);
 ES.dirty = { subject: false, body: false, signoff: false };
 // Always land with the AI assistant OPEN so operators are encouraged to talk
 // to it first (same on Generation reports email studio).
 esSetChatOpen(true);
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
 // Focus the AI prompt after load so typing goes straight to the assistant.
 requestAnimationFrame(() => {
 const input = document.getElementById("esChatInput");
 if (input && !document.getElementById("esChatPanel")?.hidden) {
 try { input.focus(); } catch (_) { /* ok */ }
 }
 });
 } catch (e) {
 esStatus("Couldn't load, " + e.message, "rb-es-err");
 }
 }

 function esSetChatOpen(open) {
 const p = document.getElementById("esChatPanel");
 const pill = document.getElementById("esAiPill");
 if (p) p.hidden = !open;
 if (pill) pill.hidden = !!open;
 if (open) {
 esRenderChat();
 const input = document.getElementById("esChatInput");
 if (input) setTimeout(() => { try { input.focus(); } catch (_) { /* ok */ } }, 0);
 }
 }

 function esCloseStudio() {
 esFlushSave();
 const ov = document.getElementById("esOverlay");
 if (ov) ov.hidden = true;
 document.body.style.overflow = "";
 // Refresh the in-page master email card so the sample preview matches the studio.
 try { loadMasterEmailPreview(); } catch (_) { /* non-fatal */ }
 }

 // ─── Master email card (inline on Offtakers tab) ───────────────────────────
 // 1-1 with Generation reports Delivery settings → Email template region:
 // sample preview + full-width "Customize email template" → studio.
 // Studio writes Tenant.offtaker_email_* so EVERY offtaker invoice email uses
 // the new letter (merge tags personalize; per-offtaker notes still win one send).
 //
 // Demo gate: ONLY !authHeaders(). window.AO_DEMO is always defined by
 // demo-data.js even when signed in — never use `|| window.AO_DEMO` here
 // (that was treating Ford's real account as a demo and blocking the studio).
 function wireMasterEmail() {
 const signedIn = !!authHeaders();
 const open = (e) => {
 if (e) { e.preventDefault(); e.stopPropagation(); }
 if (!signedIn) { demoNudge(e && e.currentTarget); return; }
 openEmailStudio();
 };
 const cardBtn = $("#rbMasterEmailOpen");
 if (cardBtn) cardBtn.onclick = open;
 const esBtn = $("#rbEmailStudio");
 if (esBtn) esBtn.onclick = open;
 // Whole preview pane is also a hit target (gen-reports UX: click to customize).
 const prev = $("#rbMasterEmailPreview");
 if (prev) {
 prev.setAttribute("role", "button");
 prev.setAttribute("tabindex", "0");
 prev.setAttribute("title", "Open the email template studio");
 prev.onclick = open;
 prev.onkeydown = (e) => {
 if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
 };
 }
 if (!signedIn) {
 const subjEl = $("#rbMmSubj");
 const bodyEl = $("#rbMmBody");
 const fromEl = $("#rbMmFrom");
 if (fromEl) fromEl.textContent = "you · via Array Operator";
 if (subjEl) subjEl.textContent = "Your solar credit invoice — sample period";
 if (bodyEl) {
 bodyEl.innerHTML = "<p>Hi there,</p><p>Please find your solar credit invoice attached, "
 + "along with the utility bill behind the figures.</p>"
 + "<p class='rb-mm-mute'>Sign in to customize this letter for every offtaker.</p>";
 }
 return;
 }
 loadMasterEmailPreview();
 }

 async function loadMasterEmailPreview() {
 const fromEl = $("#rbMmFrom");
 const subjEl = $("#rbMmSubj");
 const bodyEl = $("#rbMmBody");
 const footEl = $("#rbMmFoot");
 const statEl = $("#rbMmStatus");
 if (!subjEl || !bodyEl) return;
 if (!authHeaders()) {
 subjEl.textContent = "Sign in to preview your offtaker email.";
 bodyEl.innerHTML = "";
 return;
 }
 if (statEl) statEl.textContent = "";
 try {
 const d = await esApi("");
 if (fromEl) {
 const fe = d.from_email || "admin@solaroperator.org";
 fromEl.textContent = fe + " · via Array Operator";
 }
 // Preview with current (saved) templates — null body means server uses tenant defaults.
 const r = await esApi("/preview", {
 method: "POST",
 body: JSON.stringify({
 subject_template: d.subject_template || null,
 body_template: d.body_template || null,
 signoff: d.signoff || null,
 }),
 });
 subjEl.textContent = r.subject_rendered || "(subject)";
 bodyEl.innerHTML = r.body_rendered
 || "<p class='rb-mm-mute'>Preview will appear here once a template is set.</p>";
 if (footEl) {
 const who = r.sample_client || null;
 footEl.textContent = who
 ? "Previewing with " + who + "'s figures — every offtaker gets their own."
 : "Add an offtaker with an email to see a personalized sample.";
 }
 } catch (e) {
 subjEl.textContent = "Couldn't load preview";
 bodyEl.innerHTML = "<p class='rb-mm-mute'>" + esc(e.message || "Preview failed") +
 " · <button type='button' class='rb-mm-retry' id='rbMmRetry'>Try again</button></p>";
 const retry = $("#rbMmRetry");
 if (retry) retry.onclick = () => loadMasterEmailPreview();
 if (statEl) statEl.textContent = "";
 }
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
 ? "Previewing with " + r.sample_client + "'s real figures, every offtaker gets their own."
 : "";
 } catch (e) {
 esStatus("Preview failed, " + e.message, "rb-es-err");
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
 esStatus("Couldn't save, " + e.message, "rb-es-err");
 }
 }

 function esScheduleSave() {
 clearTimeout(ES.saveT);
 esStatus("Saving…"); // honest immediately, "Saved" only after the PUT lands
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
 : `<p class="rb-es-chat-hint">Describe the change, “make it warmer”, “add a line about budget billing”, “shorter”. The AI rewrites the template; you review before it sends anywhere.</p>`;
 if (ES.busy) box.innerHTML += `<div class="rb-es-msg">Drafting…</div>`;
 box.scrollTop = box.scrollHeight;
 }

 async function esChatSend() {
 const input = document.getElementById("esChatInput");
 const text = (input && input.value || "").trim();
 if (!text || ES.busy) return;
 input.value = ""; input.style.height = "auto"; // collapse the grown box after send
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
 ES.chat.push({ role: "assistant", content: "That didn't work, " + e.message });
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
 esStatus("Test failed, " + e.message, "rb-es-err");
 } finally {
 btn.disabled = false;
 btn.textContent = keep;
 }
 }

 async function esReset(btn) {
 btn.disabled = true;
 // Kill any in-flight autosave FIRST, a pending timer firing after the
 // reset would re-save the pre-reset body as a "custom" template.
 clearTimeout(ES.saveT); clearTimeout(ES.prevT);
 ES.dirty = { subject: false, body: false, signoff: false };
 try {
 await esApi("/reset", { method: "POST", body: "{}" });
 await openEmailStudio(); // reload defaults + preview
 esStatus("Reset to the default template");
 } catch (e) {
 esStatus("Reset failed, " + e.message, "rb-es-err");
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
 <b>Customize email template</b>
 <span class="rb-es-sub">Master letter for <b>every offtaker invoice email</b>. Save once and all offtakers get the new wording — merge tags ({{greeting}}, {{amount}}, {{period}}…) personalize each send intelligently. A per-offtaker edited note still overrides one send only.</span>
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
 <div class="rb-es-mail-att">📄 the offtaker's invoice PDF &nbsp;·&nbsp; 🧾 the utility bill behind it, attached automatically, plus the figures table below the letter.</div>
 </div>
 </div>
 <div class="rb-es-right">
 <div class="rb-es-toklabel">Insert a merge tag into the <b id="esTokTarget">body</b>, click a field, then a chip</div>
 <div class="rb-es-tokens">${ES_TOKENS.map(t => `<button type="button" class="rb-es-token" data-tok="${esc(t)}">${esc(t)}</button>`).join("")}</div>
 <label class="rb-es-lab">Subject line</label>
 <input type="text" id="esSubj" class="rb-es-input" autocomplete="off" spellcheck="false">
 <label class="rb-es-lab">Body (HTML)</label>
 <textarea id="esBody" class="rb-es-ta" rows="9" spellcheck="false"></textarea>
 <p class="rb-es-hint">{{greeting}} auto-picks “Hi Abigail,” for people and “Dear Hartland Feed &amp; Grain,” for organizations. {{attachments_line}} only ever claims files that really attach.</p>
 <div class="rb-es-signoff">
 <b>Sign-off</b>
 <span class="rb-es-hint" style="margin:0">Shared with your NEPOOL report emails, one identity everywhere.</span>
 <div class="rb-es-tokens">${ES_SIGNOFF_CHIPS.map(c => `<button type="button" class="rb-es-token" data-signoff="${esc(c.value)}">${esc(c.label)}</button>`).join("")}</div>
 <textarea id="esSignoff" class="rb-es-ta" rows="3" spellcheck="false" placeholder="Paste your sign-off here…"></textarea>
 </div>
 <div class="rb-es-actions">
 <button type="button" class="ao-btn rb-btn" id="esTest">Send myself a test</button>
 <button type="button" class="rb-es-reset" id="esReset">Reset to default</button>
 </div>
 </div>
 </div>
 <button type="button" class="rb-es-ai" id="esAiPill" hidden>✦ Ask AI</button>
 <div class="rb-es-chat" id="esChatPanel">
 <div class="rb-es-chat-head">AI assistant <button type="button" class="rb-es-x" id="esChatClose" aria-label="Close AI assistant">✕</button></div>
 <div class="rb-es-chat-msgs" id="esChatMsgs"></div>
 <div class="rb-es-chat-in">
 <textarea id="esChatInput" placeholder="Make it warmer…" rows="1" autocomplete="off"></textarea>
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
 // Pill re-opens the panel after the operator closes it; studio open defaults open.
 ov.querySelector("#esAiPill").onclick = () => esSetChatOpen(true);
 ov.querySelector("#esChatClose").onclick = () => esSetChatOpen(false);
 ov.querySelector("#esChatSend").onclick = esChatSend;
 const _esIn = ov.querySelector("#esChatInput");
 _esIn.addEventListener("keydown", (e) => {
 // Enter sends; Shift+Enter drops a newline for a longer, multi-line request.
 if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); esChatSend(); }
 });
 // Auto-grow so the whole request stays visible instead of scrolling off the end.
 _esIn.addEventListener("input", (e) => {
 const t = e.currentTarget; t.style.height = "auto";
 t.style.height = Math.min(t.scrollHeight, 132) + "px";
 });
 return ov;
 }

 // ─── Send pipeline + KPI band (Ford-approved redesign, 2026-07-03) ─────────
 // The flow view over the offtaker list: what fired, what's in flight, what
 // fires next, plus the pipeline controls (Auto-send all / Draft all with
 // confirms, and the tenant-wide Pause switch). All numbers come from
 // GET /send-pipeline (cheap column aggregates, no invoice rebuilds).
 let PIPE = null;

 function _monthName(ym) { // "2026-06" → "June"
 if (!ym) return "—";
 const parts = String(ym).split("-").map(Number);
 if (!parts[0] || !parts[1]) return "—";
 return new Date(Date.UTC(parts[0], parts[1] - 1, 1))
 .toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
 }
 function _fireLabel(iso) { // "2026-08-01T09:00:00" → "Aug 1"
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
 } catch (e) { /* the band stays hidden, never blocks the tab */ }
 }

 function renderPipeline() {
 const host = document.getElementById("rb2Pipe");
 if (!host) return;
 // Signed-out demo paints a frozen pipeline from AO_DEMO.pipeline.
 if (!PIPE || (!authHeaders() && !(window.AO_DEMO && window.AO_DEMO.pipeline))) {
 host.hidden = true; return;
 }
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
 // The "now" divider between last-delivered and this-cycle shows the ACTUAL current
 // date (Ford 2026-07-11, a bare vertical "NOW" read as cramped/odd).
 const todayLabel = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
 host.hidden = false;
 host.className = "rb2-pipe" + (paused ? " paused" : "");
 // Pipeline stages only, no animated "energy balls" (visual misstep, removed).
 host.innerHTML = `
 <div class="rb2-pipe-label">
 <h2>Send pipeline</h2>
 ${paused ? '<span class="rb2-pausechip">⏸ SENDING PAUSED</span>' : ""}
 <small class="rb2-rules">monthly invoices fire the 1st · an invoice only generates once its utility bill settles</small>
 <span class="rb2-sp"></span>
 <span class="rb2-draftstat" id="rb2DraftStatus" hidden></span>
 <small class="rb2-runstamp"><b>last run</b> ${esc(lastRun)} · next ${esc(_fireLabel(monthly.fires_at))}</small>
 </div>
 <div class="rb2-moderow" title="The default for every offtaker once its invoice drafts. Approve to send: it waits for your OK. Auto-send: it emails itself on schedule. Per-offtaker settings still override; demo accounts don't send real mail.">
 <span class="rb2-modelab">When an invoice is drafted</span>
 <div class="rb-seg rb-slider rb2-modeslider" id="rb2Mode" role="group" aria-label="Default delivery mode">
 <button type="button" data-v="approval" class="${(p.default_delivery_mode || 'approval') === 'auto' ? '' : 'on'}">Approve to send</button>
 <button type="button" data-v="auto" class="${(p.default_delivery_mode || 'approval') === 'auto' ? 'on' : ''}">Auto-send</button>
 </div>
 ${paused ? `<button class="rb2-pswitch" id="rb2Pause" role="switch" aria-checked="true" type="button">
 <span class="rb2-knob" aria-hidden="true"></span>Resume sending
 </button>` : ""}
 </div>
 <div class="rb2-pipe-row">
 <div class="rb2-pcell done" id="rb2CellLast" role="button" tabindex="0" title="Scrolls to the invoice archive. Download this month as a .zip there.">
 <div class="rb2-when"><b>${esc(_monthName(last.period_month))} · delivered</b><small>ran ${esc(lastRun)}</small></div>
 <div class="rb2-big">${fmt0(last.delivered || 0)} <span>of ${fmt0(p.total_enabled || 0)}${last.dollars ? " · " + money0(last.dollars) : ""}</span></div>
 <div class="rb2-chips"><span class="rb2-pc g">✓ ${fmt0(last.delivered || 0)} sent</span></div>
 </div>
 <div class="rb2-nowmark" aria-hidden="true"><span class="rb2-now-pill"><em>Today</em><b>${esc(todayLabel)}</b></span></div>
 <div class="rb2-pcell now">
 <div class="rb2-when"><b>This cycle</b><small>drafted from settled bills</small></div>
 ${(() => {
 // Honest split (Ford 2026-07-07): an auto-send draft is NOT "awaiting
 // approval", it sends itself. Lead with what actually needs the operator;
 // if nothing does, lead with what's flowing automatically.
 const appr = inf.pending_approval != null ? inf.pending_approval : (inf.pending_drafts || 0);
 const au = inf.pending_auto || 0;
 const wait = inf.waiting || 0;
 const primary = appr > 0
 ? `${fmt0(appr)} <span>awaiting your approval</span>`
 : (au > 0 ? `${fmt0(au)} <span>sending automatically</span>`
 : `${fmt0(wait)} <span>waiting on bills</span>`);
 const chips = [
 appr > 0 ? `<span class="rb2-pc a">${fmt0(appr)} to approve</span>` : "",
 au > 0 ? `<span class="rb2-pc b">${fmt0(au)} auto-sending</span>` : "",
 wait > 0 ? `<span class="rb2-pc m">${fmt0(wait)} waiting on bills</span>` : "",
 ].filter(Boolean).join("");
 return `<div class="rb2-big">${primary}</div>
 <div class="rb2-chips">${chips || '<span class="rb2-pc g">✓ all caught up</span>'}</div>`;
 })()}
 </div>
 <div class="rb2-pcell sched">
 <div class="rb2-when"><b>${esc(_fireLabel(monthly.fires_at))} · next run</b><small>${paused ? "paused" : (days != null ? "fires in " + fmt0(days) + " day" + (days === 1 ? "" : "s") : "")}</small></div>
 <div class="rb2-big">${fmt0(monthly.scheduled || 0)} <span>scheduled</span></div>
 <div class="rb2-chips"><span class="rb2-pc b">${fmt0(monthly.auto || 0)} auto-send</span><span class="rb2-pc m">${fmt0(monthly.approval || 0)} draft for approval</span></div>
 ${paused ? `<div class="rb2-pausednote">⏸ Paused. This run won't fire until you resume. Manual sends still work.</div>` : ""}
 </div>
 </div>`;

 // Keep the header promise HONEST against the visible auto-send counts (sim #5):
 // the blanket "Review before you send it" contradicts an "Auto-sending N"
 // tile for any tenant running auto-send, the exact "who's in control" tension two
 // personas flagged as "the worst possible combination". State the guarantee precisely:
 // approval still LEADS (it's the trust anchor every skeptic cited, keep it bold and
 // prominent), and auto-send is called out as the named, opt-in exception.
 const autoInPlay = (p.default_delivery_mode === "auto")
 || ((monthly.auto || 0) + (quarterly.auto || 0)) > 0
 || ((inf.pending_auto || 0) > 0);
 const subEl = document.getElementById("rb2Sub");
 if (subEl) subEl.innerHTML = autoInPlay
 ? `Every offtaker's solar credit invoice, generated from their settled utility bills. <b>You approve every invoice before it sends,</b> except the ones you set to Auto-send, which email on schedule.`
 : `Every offtaker's solar credit invoice, generated from their settled utility bills. <b>Review before you send it.</b>`;

 // ── wiring ──
 const cellLast = host.querySelector("#rb2CellLast");
 if (cellLast) cellLast.onclick = () => {
 const a = document.getElementById("rbArchiveHost");
 if (a && !a.hidden) a.scrollIntoView({ behavior: "smooth", block: "start" });
 };
 // Mode slider, the tenant-wide default. Switching to Auto-send is money-adjacent
 // (invoices start emailing themselves on schedule), so confirm it; switching back
 // to Approve-to-send is always safe + instant.
 const modeSeg = host.querySelector("#rb2Mode");
 if (modeSeg) modeSeg.querySelectorAll("button[data-v]").forEach(b => {
 b.onclick = async () => {
 const want = b.getAttribute("data-v");
 const cur = (PIPE && PIPE.default_delivery_mode) || "approval";
 if (want === cur) return;
 if (want === "auto") {
 const n = (PIPE && PIPE.mode_split && PIPE.mode_split.approval) || 0;
 const ok = await AODialog.confirm(
 "Invoices send on schedule from settled bills. Per-offtaker settings still apply. Demo accounts do not send mail.",
 { title: `Switch ${fmt0(n)} offtaker${n === 1 ? "" : "s"} to Auto-send?` }
 );
 if (!ok) return;
 }
 setDeliveryModeAll(want);
 };
 });
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

 // Flip the tenant-wide default delivery mode (the pipeline slider). Optimistically
 // reflect it, then reload the pipeline (which re-derives the split → the slider +
 // "This cycle" counts settle to the truth) and refresh the offtaker cards.
 async function setDeliveryModeAll(mode) {
 if (PIPE) { PIPE.default_delivery_mode = mode; renderPipeline(); } // instant slider feedback
 if (!authHeaders()) return; // signed-out demo: local flip only, no API
 try {
 const r = await fetch(API + "/subscriptions/bulk-delivery-mode", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ mode }),
 });
 if (r.ok) { await loadPipeline(); refreshList(); }
 } catch (e) { loadPipeline(); /* re-sync the slider to server truth */ }
 }

 // ── Continuous auto-draft (Ford 2026-07-07: "remove the draft button ... have all
 // offtaker invoices automatically draft when they are added and continuously poll
 // to see if there's a new bill to draft again"). There is NO manual draft button:
 // every enabled offtaker drafts from its settled bill on load + on add, and a poll
 // re-drafts as new bills land. Reuses the server bulk-draft background job with
 // keep_mode=1 so a poll NEVER flips an auto-send offtaker back to approval. The job
 // is server-locked (one run per tenant) + idempotent (reuses each period's draft),
 // and the status chip narrates progress. It never sends, approval still gates.
 let _autoDraftAt = 0;
 let _autoDraftBusy = false;
 const AUTO_DRAFT_MIN_MS = 4 * 60 * 1000; // don't re-fire more than ~every 4 min
 async function autoDraftAll(opts) {
 const force = opts && opts.force;
 if (!authHeaders() || window.AO_DEMO) return; // signed-out/demo never drafts
 if (_autoDraftBusy) return;
 if (!force && Date.now() - _autoDraftAt < AUTO_DRAFT_MIN_MS) return;
 _autoDraftBusy = true; _autoDraftAt = Date.now();
 const st = document.getElementById("rb2DraftStatus");
 try {
 const r = await fetch(API + "/subscriptions/bulk-draft?keep_mode=1",
 { method: "POST", headers: authHeaders() });
 if (!r.ok) return;
 let last = null;
 for (let i = 0; i < 160; i++) { // poll to completion, ≤ ~8 min
 try {
 const s = await fetch(API + "/subscriptions/bulk-draft-status", { headers: authHeaders() });
 last = await s.json().catch(() => null);
 } catch (_) { /* keep polling */ }
 if (last && last.ok) {
 if (st) {
 st.hidden = false;
 st.textContent = last.running
 ? `⚡ Drafting ${fmt0(last.done)} of ${fmt0(last.total)}…`
 : (last.total ? `⚡ ${fmt0(last.drafted)} drafted${last.held ? " · " + fmt0(last.held) + " waiting on bills" : ""}` : "");
 }
 if (!last.running) break;
 }
 await new Promise(res => setTimeout(res, 3000));
 }
 // Reflect new/updated drafts in the inbox, but NEVER while the operator is
 // mid-edit (a full list re-render would clobber a focused note/rate field);
 // the next poll picks it up. loadPipeline is cheap + always safe to refresh.
 loadPipeline();
 // NEVER rebuild the list out from under an open card (Ford 2026-07-10: "no shifting
 // ground"). Defer the refresh while ANY offtaker card is expanded OR a field is
 // focused, not just the focused-field case, so a poll can't collapse/flash the
 // card the operator is working in. The next poll (or closing the card) picks it up.
 const editing = ACTIVE_SUB_ID != null ||
 (document.activeElement && document.activeElement.closest &&
 document.activeElement.closest("#rbList"));
 if (!editing) await refreshList();
 if (st) setTimeout(() => { if (st && !_autoDraftBusy) st.hidden = true; }, 6000);
 } catch (_) { /* transient, the next poll retries */ }
 finally { _autoDraftBusy = false; }
 }

 // Start the continuous poll ONCE. Visibility-gated so a backgrounded tab stays quiet
 // (and we don't hammer the server for a tab nobody's looking at).
 function startAutoDraftPoll() {
 if (startAutoDraftPoll._on) return;
 startAutoDraftPoll._on = true;
 setInterval(() => {
 if (document.visibilityState === "visible" && authHeaders()) autoDraftAll();
 }, AUTO_DRAFT_MIN_MS);
 }

 function renderKpis() {
 const host = document.getElementById("rb2Kpis");
 if (!host) return;
 if (!authHeaders()) { host.hidden = true; return; }
 const nOff = (OFFTAKERS || []).length;
 // "across N arrays" = distinct arrays that actually HAVE offtakers, not every
 // array on file (ACC_ARRS counted empty/non-solar ones → the misleading 80).
 const nArr = new Set((OFFTAKERS || []).map(s => s.array_id).filter(a => a != null)).size
 || (ACC_ARRS || []).length;
 const ready = (INBOX_DRAFTS || []).length; // the pending-drafts inbox
 // Honest cycle split (mirrors the send pipeline): an auto-send draft is NOT
 // "awaiting approval", it sends itself. Lead with what actually needs the operator.
 const inf = (PIPE && PIPE.inflight) || {};
 const nAppr = inf.pending_approval != null ? inf.pending_approval : ready;
 const nAuto = inf.pending_auto || 0;
 const k2 = nAppr > 0
 ? { lab: "Awaiting approval", big: nAppr, sub: `draft${nAppr === 1 ? "" : "s"} need your OK` }
 : (nAuto > 0
 ? { lab: "Auto-sending", big: nAuto, sub: `draft${nAuto === 1 ? "" : "s"} · send on schedule` }
 : { lab: "This cycle", big: ready, sub: `draft${ready === 1 ? "" : "s"} ready` });
 const allocN = RECON ? (RECON.allocation_flagged || 0) : null;
 const atStake = RECON
 ? (RECON.allocation_at_stake_usd != null ? RECON.allocation_at_stake_usd : (allocN || 0) * 25)
 : null;
 if (!nOff && !ready) { host.hidden = true; return; }
 host.hidden = false;
 // Declutter (Ford 2026-07-10): the old 4-card strip (Offtakers / cycle / match /
 // this-period) duplicated the send-pipeline band, so this is now ONE slim glance
 // line. Offtaker + array counts orient you; the reconcile signal is the only fact
 // the pipeline doesn't carry, kept clickable-to-audit with the same $25 explainer.
 const parts = [];
 parts.push(`<span class="rb2-gl-i"><b>${fmt0(nOff)}</b> offtaker${nOff === 1 ? "" : "s"}</span>`);
 if (nArr) parts.push(`<span class="rb2-gl-i"><b>${fmt0(nArr)}</b> billed array${nArr === 1 ? "" : "s"}</span>`);
 if (allocN) {
 parts.push(`<span class="rb2-gl-flag" role="button" tabindex="0" id="rb2KpiFlag" title="We derive GMP's actual share for each offtaker (credited ÷ the array's group excess) and flag it when it differs from your entered share by more than your threshold (default ${fmtPct(XCHECK_DEFAULT_PCT)}%). GMP credits $25 per billing error, totaling ${money0(atStake)} across these catches. Opens the Bill audit.">⚑ ${fmt0(allocN)} don't match GMP · ≈ ${money0(atStake)} at stake</span>`);
 } else if (RECON) {
 parts.push(`<span class="rb2-gl-ok" title="We derive GMP's actual share for each offtaker and compare it to your entered share automatically. All are within your ${fmtPct(XCHECK_DEFAULT_PCT)}% threshold."><span class="rb2-gl-check">✓</span> all bills reconcile with GMP</span>`);
 } else {
 parts.push(`<span class="rb2-gl-i rb2-gl-checking"><span class="rb2-spin" aria-hidden="true"></span> auditing your bills…</span>`);
 }
 host.innerHTML = parts.join(`<span class="rb2-gl-dot" aria-hidden="true">·</span>`);
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
 <td style="padding:5px 0;text-align:right;color:var(--ink)">${fmt0(draftDisplayTriple(d).total)} kWh</td></tr>
 <tr><td style="padding:5px 0;color:var(--muted)">Your share${draftDisplayTriple(d).fromBill ? " (from your utility bill)" : ""}</td>
 <td style="padding:5px 0;text-align:right;color:var(--ink)">${draftDisplayTriple(d).share != null ? Math.round(draftDisplayTriple(d).share * 1000) / 10 + "%" : "—"}</td></tr>
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
 collapsed hierarchy. Every legacy id/host below is PRESERVED, only
 the frame around them changed, so all existing wiring keeps working. ═ -->
 <div class="rb2-head">
 <div class="rb2-id">
 <h1>Offtaker invoicing</h1>
 <p id="rb2Sub">Every offtaker's solar credit invoice, generated from their settled utility bills. <b>Review before you send it.</b></p>
 <!-- Tabs + a slim glance-line share one row (Ford 2026-07-10 declutter). The
 old 4-card KPI strip just restated the send-pipeline band below it, so it's
 gone, only the ONE signal the pipeline doesn't carry (do the bills reconcile
 against GMP?) survives, as an inline status. Same #rb2Kpis host + renderKpis
 wiring; it renders one line now instead of four cards. -->
 <!-- Sub-nav lives above the sheet (index.html .inv-sub-seg), matching
 Analysis Fleet analysis | Trends | Resources. KPI glance stays here. -->
 <div class="rb2-tabrow rb2-tabrow--kpis-only">
 <div class="rb2-kpis" id="rb2Kpis" hidden></div>
 </div>
 </div>
 </div>
 <div class="rb2-pipe" id="rb2Pipe" hidden></div>
 <div id="rbAuditView" class="rb-au" style="display:none"></div>
 <div id="rbFinTrends" class="rb-fin" style="display:none" aria-label="Invoice trends"></div>
 <div id="rbGenReportsView" class="rb-genrep" style="display:none" aria-label="Generation reports"></div>
 <div id="rbGenList">
 <!-- Master solar credit rate, Tenant.default_net_rate_per_kwh (+ discount).
 SET → fleet override for every offtaker without a per-offtaker rate.
 BLANK → each offtaker uses the EXCESS credit rate from THEIR own bound
 utility sub-account bill (custom per offtaker).
 Wired by wireGlobalRate() → GET/PUT /v1/array-operator/billing/global-rate. -->
 <div class="rb-globalrate rep-card" id="rbGlobalRate">
 <div class="rb-gr-main">
 <h3>Master solar credit rate</h3>
 <p><b>Optional fleet override.</b> Leave blank and each offtaker is priced from
 the solar credit rate on <b>their own utility sub-account bill</b>
 (custom per offtaker). Fill this in to force one rate for everyone
 who doesn't have a per-offtaker override.</p>
 </div>
 <div class="rb-gr-ctl">
 <label class="rb-gr-field">
 <span class="rb-gr-lbl">Solar credit rate</span>
 <span class="rb-gr-inwrap"><span class="rb-gr-dollar">$</span>
 <input type="number" id="rbGrNet" min="0" max="5" step="0.001" placeholder="per bill"
 inputmode="decimal" autocomplete="off"
 title="Optional master $/kWh. Blank = each offtaker uses the credit rate from their own utility bill.">
 <span class="rb-gr-unit">/kWh</span></span>
 </label>
 <label class="rb-gr-field">
 <span class="rb-gr-lbl">Discount</span>
 <span class="rb-gr-inwrap">
 <input type="number" id="rbGrDisc" min="0" max="99" step="1" placeholder="10"
 inputmode="numeric" autocomplete="off"
 title="Percent off the credit rate offtakers pay (their solar savings). Blank = 10% default.">
 <span class="rb-gr-unit">% off</span></span>
 </label>
 <!-- Same column stack as the two rate fields so the button sits on the
 input row (vertical center of the boxes), not mid-way up the labels. -->
 <div class="rb-gr-field rb-gr-save">
 <span class="rb-gr-lbl rb-gr-lbl-spacer" aria-hidden="true">&nbsp;</span>
 <button class="ao-btn ao-btn-primary rb-btn" id="rbGrSave" type="button">Save rate</button>
 </div>
 <span class="rb-status" id="rbGrStatus"></span>
 </div>
 <div class="rb-gr-eff" id="rbGrEff"></div>
 </div>
 <!-- Master offtaker email — 1-1 with Generation reports Delivery settings
      "Email template" region (AutoReportsSettingsCard): section label, sample
      preview card, full-width Customize CTA → full studio. Saves to
      Tenant.offtaker_email_* so every offtaker invoice email updates. -->
 <div class="rb-mastermail rep-card" id="rbMasterEmail">
 <div class="rb-mm-sectionlab">Email template</div>
 <div class="rb-mm-head">
 <div class="rb-mm-main">
 <h3>Master offtaker email</h3>
 <p>Edit once — <b>every offtaker</b> receives this letter on their invoice email.
 Merge tags personalize each send ({{greeting}}, {{amount}}, {{period}}…).
 A per-offtaker edited note still overrides this for that one send only.</p>
 </div>
 </div>
 <div class="rb-mm-stage">
 <div class="rb-mm-eyebrow">✦ Sample preview · what your offtakers actually receive</div>
 <div class="rb-mm-preview" id="rbMasterEmailPreview">
 <div class="rb-mm-env">
 <div><span class="rb-mm-envlab">FROM</span> <span id="rbMmFrom">—</span></div>
 <div><span class="rb-mm-envlab">SUBJECT</span> <span id="rbMmSubj" class="rb-mm-subj">Loading…</span></div>
 </div>
 <div class="rb-mm-body" id="rbMmBody"><span class="rb-mm-mute">Rendering sample…</span></div>
 <div class="rb-mm-foot" id="rbMmFoot"></div>
 </div>
 <button class="ao-btn rb-btn rb-mm-cta" id="rbMasterEmailOpen" type="button"
 title="Open the full email studio — subject, body, sign-off, live preview, test send, AI assist. Changes apply to every offtaker invoice email.">Customize email template</button>
 </div>
 <div class="rb-mm-status" id="rbMmStatus" aria-live="polite"></div>
 </div>
 <div class="rb-listwrap rb2-listwrap">
 <div class="rb2-controls">
 <span class="rb2-controls-label">Your offtakers</span>
 <!-- Connection rail folded INTO the toolbar row (Ford 2026-07-10 declutter):
 the ✓-sources line + ⚡ auto-refresh nudge used to stack as two full-width
 banners above the list, now they render as one slim inline status pill
 right of the label. Same host id + refreshGmpBillsStatus wiring. -->
 <div class="rb-gmpbills-status rb2-rail" id="rbGmpBillsStatus"></div>
 <span class="rb2-sp"></span>
 <div class="rb-head-actions rb2-actions">
 <!-- Portfolio-level batch export, now folded into ONE Export popover
 (approved mock): same two CSV buttons + the Xero AccountCode
 field, same ids, same wiring (wireExport). -->
 <div class="rb2-exportwrap">
 <button class="ao-btn rb-btn" id="rb2ExportBtn" type="button" aria-haspopup="true" aria-expanded="false">⬇ Export</button>
 <div class="rb2-exportpop" id="rb2ExportPop" hidden>
 <div class="rb2-exportpop-h">Export invoices to accounting</div>
 <p class="rb2-exportpop-p">Pick your accounting system, the invoice date, and the billing cycle. The batch drafts every offtaker's invoice and downloads a file that imports directly.</p>
 <div class="rb-export rb2-export" id="rbExportBox" hidden>
 <label class="rb-exf" for="rbExportFmt">Accounting system
 <select class="rb-export-sel" id="rbExportFmt"
 title="QuickBooks Online and Desktop use different import files (Online CSV vs Desktop .IIF); Xero uses its own Sales-Invoice CSV.">
 <option value="quickbooks">QuickBooks Online (CSV)</option>
 <option value="iif">QuickBooks Desktop (IIF)</option>
 <option value="xero">Xero (CSV)</option>
 </select>
 </label>
 <label class="rb-exf" for="rbExportDate">Invoice date
 <input class="rb-export-date" id="rbExportDate" type="date" autocomplete="off"
 title="The date stamped on every invoice in this export. Defaults to today.">
 </label>
 <label class="rb-exf" for="rbExportPeriod">Billing cycle
 <select class="rb-export-sel" id="rbExportPeriod"
 title="Which settled bill period to invoice. “Latest bill per offtaker” drafts each offtaker's most recent settled bill; pick a specific month/quarter to draft that cycle for everyone who has a settled bill for it.">
 <option value="">Latest bill per offtaker</option>
 </select>
 </label>
 <label class="rb-exf" for="rbExportMemo">Memo <span class="rb-exf-opt">(optional)</span>
 <input class="rb-export-memo" id="rbExportMemo" type="text" inputmode="text"
 placeholder="Solar credit ({month})" maxlength="120" autocomplete="off"
 title="The description on each invoice line (QuickBooks ItemDescription / Xero Description / IIF memo). Leave blank to use “Solar credit ({month})”.">
 </label>
 <label class="rb-exf" for="rbExportAcct" id="rbExportAcctWrap">Income account <span class="rb-exf-opt">(optional)</span>
 <input class="rb-export-acct" id="rbExportAcct" type="text" inputmode="text"
 placeholder="e.g. 200 or Solar Credit Income" maxlength="60" autocomplete="off"
 title="The account these solar invoices post to: Xero's AccountCode and QuickBooks Desktop's income account. QuickBooks Online ignores it (it uses the “Solar Credit” product/service). Remembered for next time.">
 </label>
 <p class="rb-export-note" id="rbExportIifNote" hidden>QuickBooks Desktop 2019+ restricts IIF transaction imports by default. You may need File → Utilities → Import to enable it.</p>
 <button class="ao-btn ao-btn-primary rb-btn rb-export-go" id="rbExportGo" type="button"
 title="Draft every offtaker's invoice for the chosen cycle and download the import file.">⬇ Download export</button>
 <span class="rb-export-stat" id="rbExportStat" aria-live="polite"></span>
 </div>
 </div>
 </div>
 <button class="ao-btn rb-btn" id="rbEmailStudio" type="button" title="Customize the email every offtaker invoice goes out with: greeting, wording, sign-off. Personalized per offtaker with merge tags ({{greeting}} renders “Hi Abigail,” automatically); a per-offtaker edited note still overrides it.">✉ Customize email</button>
 <button class="ao-btn rb-btn" id="rbLinkUtility" type="button" title="Connect the utility whose bills you invoice against: GMP, VEC, or any of ~470 supported utilities nationwide. Offtakers bill from these utility bills.">🔗 Link utility bills</button>
 <button class="ao-btn rb-btn" id="rbBulkImport" type="button" title="Add many offtakers from any spreadsheet, utility export, Excel, or Google Sheets. We detect columns; you review before creating.">⬆ Bulk import</button>
 <button class="ao-btn ao-btn-primary rb-btn" id="rbCustAdd" type="button">＋ Add an offtaker</button>
 </div>
 </div>
 <!-- Invoice archive (monthly directory), collapsible month-close surface. -->
 <div id="rbArchiveHost" hidden></div>
 <div id="rbCustManual"></div>
 <div id="rbBulkHost"></div>
 <!-- V2 pay-links: nudge owners who haven't finished Stripe Connect yet. -->
 <div id="rbPayBanner" hidden class="rb-pay-banner" role="status"></div>
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
 <p>Upload an invoice and <b>this offtaker’s</b> invoices reproduce that exact format: PDF, Word, HTML, an image, or an Excel workbook (we'll find the invoice sheet inside it). Leave it on Default to use the standard format.</p>
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
 let QTRENDS_STOPS = []; // active chart cleanup fns

 function teardownQTrends() {
 QTRENDS_STOPS.forEach(fn => { try { fn && fn(); } catch (e) {} });
 QTRENDS_STOPS = [];
 }

 async function renderQuarterly() {
 const host = $("#rbSubQuarterly");
 if (!host) return;
 host.innerHTML = `
 <div class="rep-card rb-q-head">
 <h3>Generate a report</h3>
 <p>Pick an offtaker and the billing period to bill, we build the
 produced-kWh invoice for that period plus a visual production report,
 then you review and send it.</p>
 <div class="rb-q-controls">
 <label class="rep-fld"><span class="rl">Offtaker</span>
 <select id="rbqCustomer"><option value="">Loading…</option></select></label>
 <label class="rep-fld"><span class="rl">Billing period
 <span class="rb-info" tabindex="0" title="Which settled utility bill to invoice. Defaults to the latest, pick an earlier period to draft a past billing cycle.">ⓘ</span></span>
 <select id="rbqPeriod"><option value="">Latest bill</option></select></label>
 </div>
 </div>
 <div id="rbqBody"></div>`;
 // Populate customers from the existing subscriptions list.
 try {
 const r = await fetch(API + "/subscriptions", { headers: authHeaders() });
 const subs = ((await r.json().catch(() => ({}))).subscriptions) || [];
 const sel = $("#rbqCustomer");
 if (!subs.length) {
 sel.innerHTML = `<option value="">No offtakers yet, add one in the Offtakers tab</option>`;
 } else {
 sel.innerHTML = subs.map(s =>
 `<option value="${s.id}">${esc(s.customer_name)}</option>`).join("");
 }
 // Offtaker change → refresh that offtaker's real billing periods, then re-render.
 sel.onchange = async () => { await fillPeriodOptions(sel.value); renderQuarterlyBody(); };
 const psel = $("#rbqPeriod");
 if (psel) psel.onchange = renderQuarterlyBody;
 if (subs.length) { await fillPeriodOptions(sel.value); renderQuarterlyBody(); }
 } catch (e) {
 $("#rbqBody").innerHTML = `<div class="empty">Couldn't load offtakers, refresh to retry.</div>`;
 }
 }

 // Populate the Billing-period dropdown from the offtaker's REAL settled bills
 // (Bruce 2026-07-07, C4), every billable period, newest first, with the latest
 // marked as the default. Falls back to a lone "Latest bill" option when the
 // offtaker has no bill-bound periods (workbook offtakers / no settled bill yet).
 async function fillPeriodOptions(subId) {
 const sel = $("#rbqPeriod");
 if (!sel) return;
 sel.innerHTML = `<option value="">Latest bill</option>`;
 if (!subId) return;
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/bill-periods", { headers: authHeaders() });
 if (!r.ok) return;
 const d = await r.json().catch(() => ({}));
 const periods = (d && d.periods) || [];
 if (!periods.length) return; // keep the implicit "Latest bill" default
 // Value "" = latest (server default); explicit values pin a historical period.
 sel.innerHTML = periods.map((p, i) =>
 `<option value="${esc(p.label)}">${esc(p.pretty)}${i === 0 ? " · latest" : ""}</option>`
 ).join("");
 } catch (e) { /* keep the fallback option */ }
 }

 async function renderQuarterlyBody() {
 const body = $("#rbqBody");
 const subId = $("#rbqCustomer") && $("#rbqCustomer").value;
 const period = $("#rbqPeriod") && $("#rbqPeriod").value; // "" = latest bill
 if (!body || !subId) return;
 teardownQTrends();
 body.innerHTML = `<div class="rep-card"><div class="empty" style="padding:18px 0;color:var(--faint)">Building report…</div></div>`;

 // 1) the period's invoice math (real produced kWh × rate; never fabricated).
 // The chosen billing period rides the query so the preview matches the draft.
 let math = null;
 const pq = period ? ("?period=" + encodeURIComponent(period)) : "";
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/preview-math" + pq, { headers: authHeaders() });
 if (r.ok) math = await r.json().catch(() => null);
 } catch (e) { /* surfaced below */ }

 const cust = $("#rbqCustomer").selectedOptions[0]
 ? $("#rbqCustomer").selectedOptions[0].textContent : "Offtaker";
 // The chosen period's human label for the heading (the option text, minus the
 // "· latest" suffix); "" (Latest bill) falls back to the resolved period below.
 const periodSel = $("#rbqPeriod") && $("#rbqPeriod").selectedOptions[0];
 const periodLabel = period
 ? (periodSel ? periodSel.textContent.replace(/\s·\slatest$/, "") : period)
 : "Latest bill";
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
 <div class="rb-q-inv-h"><h4>${esc(cust)} · ${esc(periodLabel)}</h4>
 <span class="rb-q-src">source: ${esc(srcLabel)}</span></div>
 ${hasData ? `
 <div class="rb-q-stats">
 <div class="st"><b>${fmt0(math.customer_kwh)}</b><span>kWh produced</span></div>
 <div class="st"><b>${math.rate != null ? "$" + Number(math.rate).toFixed(3) : "—"}</b><span>$/kWh${math.rate_source ? " · " + esc(math.rate_source) : ""}</span></div>
 <div class="st"><b>${money(math.amount_usd)}</b><span>amount due</span></div>
 </div>
 <p class="rb-q-math">${fmt0(math.customer_kwh)} kWh × ${math.rate != null ? "$" + Number(math.rate).toFixed(3) : "—"}/kWh = <b>${money(math.amount_usd)}</b>
 <span class="rb-q-period">· period ${esc(math.period_start || "—")} → ${esc(math.period_end || "—")}</span></p>
 ` : `<div class="rb-warn">No generation data yet for this offtaker's array for ${esc(periodLabel.toLowerCase())}, Connect data or upload generation to build the invoice.</div>`}
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
 // the offtaker reads on their report).
 mountQTrends(subId);

 // 3) "Draft for review" reuses the existing per-subscription draft flow,
 // carrying the chosen billing period ("" = latest).
 const draftBtn = $("#rbqDraft");
 if (draftBtn) draftBtn.onclick = () => quarterlyDraft(subId, period);
 }

 async function mountQTrends(subId) {
 const barsHost = $("#rbqBars");

 // DAILY GENERATION bar graph (real DailyGeneration, scaled to this
 // offtaker's share), the one chart a customer actually reads on a
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

 async function quarterlyDraft(subId, period) {
 const st = $("#rbqStatus");
 if (st) { st.className = "rb-status rb-busy"; st.textContent = "Drafting for review…"; }
 // The chosen billing period ("" / undefined = latest bill) rides the draft.
 const pq = period ? ("?period=" + encodeURIComponent(period)) : "";
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/draft" + pq, { method: "POST", headers: authHeaders() });
 const data = await r.json().catch(() => ({}));
 if (r.ok && data.ok) {
 noteXcheck(subId, data); // the cross-check rides the generation response
 const xc = data.crosscheck;
 if (st) {
 if (xc && xc.flagged) {
 st.className = "rb-status rb-err";
 st.textContent = "Drafted, but the cross-check flagged it: GMP's bill doesn't match this offtaker's share ("
 + fmtPct(xc.computed_share_pct) + "% on the bills vs " + fmtPct(xc.entered_share_pct)
 + "% entered). Review it in the approval inbox before sending.";
 } else {
 st.className = "rb-status rb-ok";
 st.textContent = (xc && !xc.flagged ? "Cross-check ✓ GMP's numbers match this offtaker's share. " : "")
 + "Added to your approval inbox (Invoice generator tab), review, edit the email, then send.";
 }
 }
 } else {
 if (st) { st.className = "rb-status rb-err"; st.textContent = apiErr(data, "Couldn't draft."); }
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
 // changes a live send today, it captures the format to reproduce.
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
 (t.enabled ? "Used for this offtaker’s invoices." : "Saved, turn on below to use it.")
 : "No template yet, this offtaker’s invoices use the standard format.";
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
 loadTplPreview(t); // rendered PDF of the template
 }
 // Template-card preview: render the stored template (sample data) via the shared
 // renderPdfToPaper, JUST the invoice page, no PDF-viewer chrome.
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
 pane.innerHTML = '<div class="rb-doc-cap">Our reproduction of your template, ' +
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
 '<div>Your template is still saved, try the other view.</div></div>';
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
 showFmt("repro"); // default inline view = the reproduced template
 }
 async function refresh() {
 const base = tplApi();
 if (!base || !authHeaders()) { paint(null); return; } // no offtaker bound (parked) / demo
 try {
 const r = await fetch(base, { headers: authHeaders() });
 const d = await r.json().catch(() => ({}));
 paint(r.ok ? d.template : null);
 } catch (e) { paint(null); }
 // keep the Master Account file library in sync after upload/remove/enable
 try { if (window.__aoReloadFiles) window.__aoReloadFiles(); } catch (e) {}
 }
 _tplRefresh = refresh; // rebindTpl(sid) calls this when a card folds in
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
 } catch (e) { status.textContent = "Upload failed, check your connection."; status.className = "rb-tpl-status rb-err"; }
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
 if (ev === "dragleave" && drop.contains(e.relatedTarget)) return; // moving over a child
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
 const ok = await AODialog.confirm("Their invoices go back to the standard format.", { title: "Remove this offtaker’s invoice template?" });
 if (!ok) return;
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
 setFmt(useTpl); // optimistic; paint() reconciles
 savePut({ enabled: useTpl },
 useTpl ? "On, invoices use your template." : "Using the standard format.");
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
 // Master rate SET → fleet override for offtakers without a per-offtaker rate.
 // Master rate BLANK → each offtaker uses the EXCESS credit rate on THEIR own
 // bound utility sub-account bill (custom per offtaker). Never a fleet median.
 async function wireGlobalRate() {
 const net = $("#rbGrNet");
 const disc = $("#rbGrDisc");
 const save = $("#rbGrSave");
 const st = $("#rbGrStatus");
 const eff = $("#rbGrEff");
 if (!net || !disc || !save) return;

 let effDisc = 0.10, effSrc = "per_offtaker_bill", effNote = "";
 function renderEff() {
 const d = disc.value.trim() === "" ? effDisc * 100 : Number(disc.value);
 const raw = net.value.trim();
 if (eff) {
 if (raw === "") {
 // Blank master → per-offtaker bill rates (no single $/kWh to preview).
 const discBit = isNaN(d) ? "10" : d.toFixed(0);
 eff.innerHTML =
 `Master rate is <b>blank</b>, each offtaker is priced from the solar credit ` +
 `rate on <b>their own utility sub-account bill</b> (custom per offtaker), ` +
 `then minus your ${discBit}% discount. ` +
 `Fill the box only if you want one rate for everyone.`;
 return;
 }
 const n = Number(raw);
 if (isNaN(n) || isNaN(d)) { eff.textContent = ""; return; }
 const rate = n * (1 - d / 100);
 eff.innerHTML =
 `Master rate is set, offtakers without a custom rate pay ` +
 `<b>$${rate.toFixed(4)}/kWh</b> (credit $${n.toFixed(5)} − ${d.toFixed(0)}% off). ` +
 `Clear the box to go back to each offtaker's own utility-bill rate.`;
 }
 }
 try {
 const r = await fetch(API + "/global-rate", { headers: authHeaders() });
 const data = await r.json().catch(() => ({}));
 if (r.ok) {
 if (data.effective_discount_pct != null) effDisc = data.effective_discount_pct;
 if (data.effective_net_rate_source) effSrc = data.effective_net_rate_source;
 if (data.effective_net_rate_note) effNote = data.effective_net_rate_note;
 // Only show a number when the operator has SAVED a master override.
 if (data.default_net_rate_per_kwh != null) net.value = data.default_net_rate_per_kwh;
 else net.value = "";
 if (data.default_discount_pct != null) disc.value = Math.round(data.default_discount_pct * 100);
 }
 } catch (e) { /* leave blank */ }
 renderEff();
 net.addEventListener("input", renderEff);
 disc.addEventListener("input", renderEff);

 save.onclick = async () => {
 const body = {};
 // net rate: blank clears (→ per-offtaker utility bill rates)
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
 st.className = "rb-status rb-ok";
 st.textContent = rawNet === ""
 ? "Cleared, each offtaker uses the rate from their own utility bill."
 : "Saved, offtakers without a custom rate now use this master rate.";
 if (data.default_net_rate_per_kwh != null) {
 net.value = data.default_net_rate_per_kwh;
 } else {
 net.value = "";
 }
 if (data.default_discount_pct != null) {
 disc.value = Math.round(Number(data.default_discount_pct) * 100);
 effDisc = Number(data.default_discount_pct);
 } else if (data.default_discount_pct === null) {
 disc.value = "";
 }
 try {
 const gr = await fetch(API + "/global-rate", { headers: authHeaders() });
 const gd = await gr.json().catch(() => ({}));
 if (gr.ok) {
 if (gd.effective_discount_pct != null) effDisc = gd.effective_discount_pct;
 if (gd.effective_net_rate_source) effSrc = gd.effective_net_rate_source;
 if (gd.effective_net_rate_note) effNote = gd.effective_net_rate_note;
 }
 } catch (_) {}
 renderEff();
 await refreshList();
 } else {
 st.className = "rb-status rb-err";
 st.textContent = apiErr(data, "Couldn't save.");
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
 status.textContent = apiErr(data, "Couldn't read that file (HTTP " + r.status + ").");
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
 status.textContent = "Network error while matching, try again.";
 }
 }

 // ---- add a customer manually (no spreadsheet) ------------------------------
 // Backend: POST /subscriptions with NO file → manual sub from
 // customer_name + array_id + allocation_pct (percent_of_array model). The
 // customer's invoice each cycle = allocation_pct × the array's generation.
 let MANUAL_OPEN = false;
 // When the add form is opened from a master group's "+ Add offtaker" button, the
 // master's array_id is parked here; wireArrayFirst applies it once the net-meter
 // group picker has populated (async), pre-selecting that master. Cleared on apply.
 let PENDING_MASTER_ARRAY = null;
 let ARRAYS = null; // cached [{id,name,client_name}] for the array picker
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
 // fleet-tree returns { columns: [{ array_id, array_name, ... }] }, map
 // from that shape (NOT t.arrays / a.name, which never existed here).
 ARRAYS = (t.columns || []).map(a => ({
 id: a.array_id, name: a.array_name, client_name: a.client_name,
 })).filter(a => a.id != null);
 } catch (e) { ARRAYS = []; }
 return ARRAYS;
 }

 // GMP utility accounts (offtaker ↔ utility-bill binding). Each carries a
 // summary of the bills we hold so the picker shows whether a paper bill is on
 // file. Offtaker invoices read these bills ONLY, never vendor/inverter data.
 // NOTE: we deliberately DO NOT cache. A previous version cached the result in
 // a module var, but an empty list ([]) is truthy in JS, so once a pre-connect
 // fetch cached [], every reopen returned the stale empty list forever and the
 // dropdown never populated after GMP was connected. Always fetch fresh, the
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
 // DATE (YYYY-MM-DD, day-accurate at the 11-year Rate #1 → Blended boundary,
 // Bruce's C4 ask), ask the backend what GMP's published schedule says the rate
 // should be THIS month, so the operator can sanity-check the billing rate.
 // Reference only, never overrides the bill's own billed rate. Returns null on
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
 // the operator sees exactly when Rate #1 ends, an array near the mark can't
 // be silently misread (Bruce: GMP itself has called an array 11 two years early).
 let boundary = "";
 if (rate.blended_from) {
 const bf = docDate(rate.blended_from);
 boundary = rate.regime === "blended"
 ? ` · Blended since <b>${esc(bf)}</b>`
 : ` · Rate #1 until <b>${esc(bf)}</b>`;
 if (rate.regime_flips_within_month) boundary += " (crosses 11 years this month)";
 if (rate.year_only_assumed_jan1) boundary += " (from a year-only value, assumed Jan 1; set the exact date to pin the boundary)";
 }
 const clamped = rate.clamped ? " · <b>schedule clamped</b> (year outside the published range, nearest year used)" : "";
 return `Expected GMP rate: <b>$${total.toFixed(4)}/kWh</b> ($${base.toFixed(4)} ${esc(regime)}${adderTxt})${boundary}. Reference only, the invoice always uses the bill's own credit rate.${clamped}`;
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

 // Fill #rbmArray (the Net Meter Group picker) from UTILITY DATA ONLY, the paper
 // bills we invoice from, never the vendor/inverter fleet. Ford 2026-07-09: "there
 // shouldn't be any vendor info in this part of the system; it should just pull the
 // utility data to find the arrays." Each option is a net meter group, labeled from
 // its utility account(s) (nickname → service address → provider + account #, plus
 // bill status). Matched groups keep array_id as the value, the offtaker binding is
 // unchanged (backend resolves the bill from the array). A freshly-linked account not
 // yet tied to an array is still offered as its own group (value "u:<account_id>") so
 // onboarding is never stranded: the backend's OFFTAKER↔UTILITY-BILL path binds it
 // directly by account. Arrays with NO connected utility bill don't appear, you
 // can't invoice an offtaker without a paper bill.
 function wireArrayFirst() {
 const sel = $("#rbmArray");
 if (!sel) return;
 fetchUtilityAccounts().then(accts => {
 const s = $("#rbmArray");
 if (!s) return; // panel closed mid-fetch
 ARR_UTIL_ACCTS = accts || []; // warm the shared cache
 const opts = netMeterGroupOptions(ARR_UTIL_ACCTS);
 if (!opts.length) {
 s.innerHTML = `<option value="">No utility bills yet, link your utility first</option>`;
 } else {
 s.innerHTML = `<option value="">Choose a net meter group…</option>` +
 opts.map(o => `<option value="${esc(String(o.value))}">${esc(o.label)}</option>`).join("");
 }
 s.onchange = () => {
 const u = $("#rbmUtility"); // a new group → forget any prior sub-account pick
 if (u) u.dataset.userPicked = "";
 resolveArrayBills(false);
 };
 // Ford 2026-07-09: with tons of arrays the plain dropdown is hard to search —
 // overlay a type-to-filter combobox. The native <select> stays the source of
 // truth (value + onchange untouched); the combobox just mirrors the pick.
 makeSearchableSelect(s, { placeholder: "Search net meter groups…" });
 // Suggestion #15: "search for utility bills inside these dropdowns." The sub-
 // account picker beside the master lists the same utility bills, so give it the
 // same type-to-filter combobox (its CSS is already covered by .rb-mform-grid).
 // keepEmpty keeps the "— none —" option pickable: here a blank value is a real
 // choice (bill the master group's share), not just a placeholder.
 const usub = $("#rbmUtility");
 if (usub) makeSearchableSelect(usub, { placeholder: "Search utility accounts…",
 keepEmpty: true, noMatch: "No utility account matches that.",
 emptyText: "No utility accounts linked yet." });
 // Pre-select the master net-meter group the operator clicked "+ Add offtaker"
 // on (parked in PENDING_MASTER_ARRAY). Applied here, after the options exist —
 // then a native change fires so the bill line + sub picker + rate field resolve.
 if (PENDING_MASTER_ARRAY != null) {
 const want = String(PENDING_MASTER_ARRAY);
 PENDING_MASTER_ARRAY = null;
 if (Array.from(s.options).some(o => String(o.value) === want)) {
 s.value = want;
 if (s.__combo) s.__combo.sync(); // mirror the pick into the combobox input
 s.dispatchEvent(new Event("change", { bubbles: true }));
 }
 }
 });
 // Prime the utility-account cache so the first pick resolves instantly.
 resolveArrayBills(true, true);
 }

 // Turn a native <select> into a type-to-filter combobox WITHOUT changing its role
 // as the value/onchange billing basis: the <select> stays in the DOM (visually
 // hidden), we mirror each pick back into it and dispatch a native 'change', so all
 // existing logic (resolveArrayBills, .value reads) is untouched. Idempotent, safe
 // to call again after the options are repopulated (the list is (re)built from the
 // live <option>s each time it opens). Ford 2026-07-09: "with tons of arrays in the
 // net meter group dropdown it's hard to find the right one, add search."
 function makeSearchableSelect(sel, opt) {
 opt = opt || {};
 if (!sel) return;
 if (sel.__combo) { sel.__combo.sync(); return; } // already enhanced → just resync
 const wrap = document.createElement("div");
 wrap.className = "nmg-combo";
 sel.parentNode.insertBefore(wrap, sel);
 wrap.appendChild(sel);
 sel.classList.add("nmg-combo-native"); // visually hidden, kept for value/onchange

 const input = document.createElement("input");
 input.type = "text"; input.className = "nmg-combo-input";
 input.setAttribute("role", "combobox"); input.setAttribute("autocomplete", "off");
 input.spellcheck = false; input.placeholder = opt.placeholder || "Search…";
 const caret = document.createElement("span");
 caret.className = "nmg-combo-caret"; caret.textContent = "▾";
 const list = document.createElement("div");
 list.className = "nmg-combo-list"; list.hidden = true;
 wrap.appendChild(input); wrap.appendChild(caret); wrap.appendChild(list);

 let open = false, active = -1, items = [];

 const selectedLabel = () => { const o = sel.options[sel.selectedIndex]; return (o && (o.value || opt.keepEmpty)) ? o.textContent : ""; };
 const syncInputToSelection = () => { input.value = selectedLabel(); };

 const build = (q) => {
 const needle = String(q || "").trim().toLowerCase();
 list.innerHTML = ""; items = [];
 const opts = Array.from(sel.options).filter(o => opt.keepEmpty || o.value !== ""); // skip the "Choose…" placeholder (keepEmpty keeps a blank-value option that's a real choice)
 for (const o of opts) {
 const label = o.textContent;
 if (needle && !label.toLowerCase().includes(needle)) continue;
 const el = document.createElement("button");
 el.type = "button"; el.className = "nmg-combo-item"; el.textContent = label;
 if (o.value === sel.value) el.classList.add("is-sel");
 // Commit on pointerdown (fires before any focus/click churn), preventDefault so
 // the press never becomes a focus/label event, stopPropagation so it never
 // reaches the enclosing <label>. One event, done, nothing left to reopen it.
 el.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); choose(o.value, label); });
 el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
 list.appendChild(el); items.push({ value: o.value, label, el });
 }
 if (!items.length) {
 const none = document.createElement("div");
 none.className = "nmg-combo-none";
 none.textContent = opts.length
 ? (opt.noMatch || "No net meter group matches that.")
 : (opt.emptyText || "No net meter groups yet.");
 list.appendChild(none);
 }
 active = -1;
 };

 const openList = () => { build(input.value === selectedLabel() ? "" : input.value); list.hidden = false; open = true; wrap.classList.add("is-open"); };
 const closeList = () => { if (!open) return; list.hidden = true; open = false; wrap.classList.remove("is-open"); active = -1; };

 // Commit a selection: mirror into the native <select>, fire change, CLOSE. Because
 // opening is NOT tied to focus (below), nothing re-opens the list after this.
 function choose(value, label) {
 input.value = label;
 closeList();
 if (sel.value !== value) { sel.value = value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
 }

 // ── THE REBUILD (Ford, 2026-07-09, 5th report) ──────────────────────────────
 // Open the list ONLY on explicit intent, a pointer press on the field/caret, or
 // typing. NEVER on focus. The old design opened on focus, so the enclosing
 // <label> (and onchange re-renders) re-focusing the field after a selection popped
 // it straight back open; stopPropagation/timestamp patches only masked it. With
 // open decoupled from focus, a stray refocus is simply inert, the bug can't exist.
 input.addEventListener("pointerdown", () => { if (!open) openList(); }); // press opens; never closes (so you can edit the search)
 caret.addEventListener("pointerdown", (e) => { e.preventDefault(); if (open) closeList(); else { input.focus(); openList(); } });
 input.addEventListener("input", () => { if (!open) openList(); else build(input.value); });
 input.addEventListener("keydown", (e) => {
 if (e.key === "ArrowDown" || e.key === "ArrowUp") {
 e.preventDefault(); if (!open) { openList(); return; }
 if (!items.length) return;
 active = e.key === "ArrowDown" ? Math.min(items.length - 1, active + 1) : Math.max(0, active - 1);
 items.forEach((it, i) => it.el.classList.toggle("is-active", i === active));
 items[active].el.scrollIntoView({ block: "nearest" });
 } else if (e.key === "Enter") {
 if (open && active >= 0) { e.preventDefault(); choose(items[active].value, items[active].label); }
 } else if (e.key === "Escape") {
 if (open) { e.preventDefault(); closeList(); syncInputToSelection(); }
 }
 });
 // Close when a press lands anywhere outside the combo (capture phase so it wins).
 document.addEventListener("pointerdown", (e) => { if (open && !wrap.contains(e.target)) closeList(); }, true);

 sel.__combo = { sync: syncInputToSelection };
 syncInputToSelection();
 }

 // Build the Net Meter Group option list from utility accounts (vendor-free).
 // Matched accounts collapse by array_id → one option per group (value = array_id,
 // the unchanged billing key); unmatched accounts (array_id null, a fresh link) each
 // become their own option (value "u:<account_id>"). Returns [{value,label}] by label.
 function netMeterGroupOptions(accts) {
 const byArray = new Map(); // array_id -> [accts]
 const loose = []; // unmatched accounts (array_id null)
 for (const a of (accts || [])) {
 if (a.array_id != null) {
 const k = String(a.array_id);
 if (!byArray.has(k)) byArray.set(k, []);
 byArray.get(k).push(a);
 } else { loose.push(a); }
 }
 const out = [];
 for (const [arrId, group] of byArray) out.push({ value: arrId, label: nmgGroupLabel(group) });
 for (const a of loose) out.push({ value: "u:" + a.utility_account_id, label: nmgGroupLabel([a]) + " · needs an array match" });
 out.sort((x, y) => String(x.label).localeCompare(String(y.label)));
 return out;
 }

 // Vendor-FREE identity for a single utility account: operator nickname → utility
 // service address → provider + account number. NEVER the array/inverter name.
 function utilityIdentity(a) {
 const nm = (a.nickname || "").trim();
 if (nm) return nm;
 const addr = (a.service_address || "").trim();
 if (addr) return addr;
 const prov = (a.provider || "gmp").toLowerCase();
 const tag = prov === "gmp" ? "GMP" : prov.toUpperCase();
 return `${tag} acct ${a.account_number || "?"}`;
 }

 // Vendor-free label for a net meter GROUP (one or more accounts sharing an array),
 // with bill status so the operator sees it's invoiceable, e.g.
 // "52 County Rd, Glover, VT · 12 bills · latest 2026-06".
 function nmgGroupLabel(group) {
 const named = group.find(a => (a.nickname || "").trim())
 || group.find(a => (a.service_address || "").trim())
 || group[0];
 let name = utilityIdentity(named);
 if (group.length > 1) name += ` · ${group.length} accounts`;
 const totalBills = group.reduce((n, a) => n + (a.bill_count || 0), 0);
 let latest = null;
 for (const a of group) if (a.latest_period_label && (!latest || a.latest_period_label > latest)) latest = a.latest_period_label;
 const bills = totalBills > 0
 ? ` · ${totalBills} bill${totalBills === 1 ? "" : "s"}${latest ? " · latest " + latest : ""}`
 : " · no bill yet";
 return name + bills;
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
 // yet / mixed candidates, resolves as soon as the operator picks).
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
 // Directly-chosen unmatched account (value "u:<id>") → its own provider.
 if (String(arrId).startsWith("u:")) {
 const a = accts.find(x => String(x.utility_account_id) === String(arrId.slice(2)));
 return a ? (a.provider || "gmp").toLowerCase() : null;
 }
 const mine = accts.filter(a => String(a.array_id) === String(arrId));
 const cands = mine.length ? mine : accts; // fresh-link case offers the full list
 if (!cands.length) return null;
 const provs = [...new Set(cands.map(a => (a.provider || "gmp").toLowerCase()))];
 return provs.length === 1 ? provs[0] : null;
 }

 // Render the Solar-credit-rate slot to match the resolved provider. Bill-scraped
 // utilities (GMP) get a read-only truth line, the invoice always prices from the
 // bill's own net-metering credit rate, so there is nothing to type. VEC/SmartHub
 // portals publish no usable credit rate, so those offtakers keep the manual
 // $/kWh input (operator-entered rate model). Mode is memoized on the slot so a
 // repaint never clobbers a half-typed rate.
 function paintRateField() {
 const slot = $("#rbmRateSlot");
 if (!slot) return;
 const prov = rateSlotProvider();
 const mode = (prov && prov !== "gmp") ? "manual:" + prov : "auto:" + (prov || "any");
 if (slot.dataset.mode === mode) return; // unchanged, keep typed input intact
 slot.dataset.mode = mode;
 if (prov && prov !== "gmp") {
 const P = esc(prov.toUpperCase());
 slot.innerHTML = `<span class="rl">Solar credit rate ($/kWh)</span>
 <input type="number" id="rbmCreditRate" min="0" step="0.0001" placeholder="e.g. 0.14963">
 <span class="rb-fld-hint">${P}'s usage data doesn't include a $/kWh rate, but its bill does, enter the rate you bill at, or link/upload a ${P} bill and we'll read the rate straight off it. Blank uses your default until then.</span>`;
 } else {
 // GMP / unknown: the rate DEFAULTS to the bill's own net-metering credit rate,
 // but stays overridable (Ford 2026-07-07). Editable input, blank = use the
 // bill's rate. The exact default only exists once a bill settles for this
 // offtaker, so the helper says so rather than pre-filling a guess.
 const src = prov === "gmp" ? "GMP bill" : "utility bill";
 slot.innerHTML = `<span class="rl">Solar credit rate ($/kWh)</span>
 <input type="number" id="rbmCreditRate" min="0" step="0.0001" placeholder="blank = the bill's own rate">
 <span class="rb-fld-hint">Defaults to each ${src}'s own net-metering credit rate, leave blank to use it. Enter a rate only to <b>override</b> the bill (e.g. when a period's credit was banked and you want to set the rate yourself).</span>`;
 }
 }

 // ── Intelligent sub-account ↔ offtaker matching ────────────────────────────
 // When a net meter group has multiple GMP sub-accounts, we try to bind the
 // offtaker to THEIR OWN sub-account (topology A, GMP already allocated that
 // member's excess, so the invoice AND the bill-accuracy audit both read one
 // authoritative number) rather than billing a share of the whole group
 // (topology B). The only signal we have is the operator's own labels: the
 // offtaker's name vs each account's nickname / service address. We match on
 // shared significant tokens and accept ONLY a unique, unambiguous winner —
 // never a coin-flip on a billing path. Keep this normalization in sync with
 // the backend `_match_offtaker_subaccount` (solar-operator api/billing/routes.py).
 const _MATCH_STOP = new Set(["the", "a", "an", "of", "and", "at", "llc", "inc",
 "co", "house", "home", "apartments", "apartment", "apt", "unit", "units",
 "farm", "barn", "solar", "array", "account", "acct", "meter", "net", "group",
 "st", "street", "rd", "road", "ave", "avenue", "ln", "lane", "dr", "drive",
 "vt", "usa"]);
 function _matchTokens(s) {
 return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
 .filter(w => w.length >= 3 && !_MATCH_STOP.has(w));
 }
 // Returns { account, score } for the UNIQUE best-matching sub-account, or null
 // when there's no non-trivial, unambiguous winner (0 or 1 accounts, no shared
 // token, or a tie, all resolve to the safe whole-group fallback instead).
 function matchSubAccount(name, accounts) {
 const want = new Set(_matchTokens(name));
 if (!want.size || !accounts || accounts.length < 2) return null;
 let best = null, bestScore = 0, tie = false;
 for (const a of accounts) {
 const hay = new Set([..._matchTokens(a.nickname), ..._matchTokens(a.service_address)]);
 let score = 0;
 for (const w of want) if (hay.has(w)) score++;
 if (score > bestScore) { best = a; bestScore = score; tie = false; }
 else if (score === bestScore && score > 0) { tie = true; }
 }
 if (!best || bestScore < 1 || tie) return null;
 return { account: best, score: bestScore };
 }
 // The group HOST meter = the lowest utility_account_id sharing the array
 // (mirrors the backend `_host_id` rule). Billing its excess × share is the
 // whole-group percentage model (topology B), the safe auto-match fallback.
 function hostAccountId(accounts) {
 let host = null;
 for (const a of (accounts || [])) {
 const id = Number(a.utility_account_id);
 if (host === null || id < host) host = id;
 }
 return host === null ? "" : String(host);
 }

 // ── Parent / child (master + sub) account picker ───────────────────────────
 // The offtaker binds to ONE utility account, but the operator thinks of it as a
 // parent/child pair: a MASTER account (the net-meter group host they bill a
 // share of, topology B) and optionally the offtaker's OWN sub-account meter
 // (bill directly off it, topology A). We present these as TWO separate
 // dropdowns (Ford 2026-07-10). GMP publishes NO group-membership table
 // (verified against Bruce's real bills, no allocation/member list, isPrimary
 // unset almost everywhere), so which existing binding is a "master" vs a "sub"
 // is derived from the operator's OWN offtaker setup: an account that ≥2
 // offtakers bill off, or that ANY offtaker bills a FRACTIONAL (<100%) share
 // off, is a MASTER/group host (e.g. "Chester", whose five LRHC offtakers each
 // take 1–25%). This only decides which dropdown PRESELECTS the current binding;
 // both dropdowns list every account so the operator can always pick either.
 function masterAccountIds(offtakers) {
 const byAcct = new Map(); // utility_account_id -> [shares]
 for (const o of (offtakers || [])) {
 const uid = o && o.utility_account_id;
 if (uid == null) continue;
 const k = String(uid);
 if (!byAcct.has(k)) byAcct.set(k, []);
 byAcct.get(k).push(o.allocation_pct);
 }
 const masters = new Set();
 for (const [k, shares] of byAcct) {
 const fractional = shares.some(p => p != null && Number(p) > 0 && Number(p) < 0.999);
 if (shares.length >= 2 || fractional) masters.add(k); // shared host OR a %-share host
 }
 return masters;
 }

 // Flat <option> list of ALL utility accounts (alphabetized by label), with
 // `selectedId` marked selected and an optional lead option prepended. Each option
 // carries data-arr (the account's array_id) so the master pick can send the
 // MASTER group-host array_id the bill-accuracy cross-check reads group-excess from.
 function accountOptionsFlat(accts, selectedId, leadHTML) {
 const selStr = selectedId != null && selectedId !== "" ? String(selectedId) : "";
 const opts = (accts || []).filter(a => a && a.utility_account_id != null)
 .slice().sort((x, y) => billLabel(x).localeCompare(billLabel(y)))
 .map(a => {
 const id = String(a.utility_account_id);
 const arr = a.array_id != null ? ` data-arr="${a.array_id}"` : "";
 return `<option value="${id}"${arr}${id === selStr ? " selected" : ""}>${esc(billLabel(a))}</option>`;
 }).join("");
 return (leadHTML || "") + opts;
 }

 // Master + sub <option> lists for the two-dropdown picker. Both list EVERY
 // account; the current binding preselects the MASTER dropdown when it's a group
 // host others share, else the SUB dropdown (an individual own meter).
 function masterSubOptions(accts, offtakers, boundId, groupArrayId) {
 const masters = masterAccountIds(offtakers);
 const bound = boundId != null && boundId !== "" ? String(boundId) : "";
 const boundIsMaster = !!bound && masters.has(bound);
 // Which account preselects in the MASTER dropdown:
 // 1. the bound account itself, when it IS the group host (a %-share offtaker with
 // no own meter bills the master directly); else
 // 2. derive the group's host from the offtaker's array_id, a SUB-metered offtaker
 // (own meter, allocation_pct=1.0) is bound to their OWN account, so the master
 // can't come from the bound account; it lives on the GROUP (array_id). Without
 // this the master read "— none —" even though the group was set, Bruce's "St J
 // Pump Plant" (bound to sub 'St J Main St', group = Timberworks). Ford 2026-07-10.
 let masterSel = boundIsMaster ? bound : "";
 if (!masterSel && groupArrayId != null && groupArrayId !== "") {
 const groupHosts = (accts || []).filter(a =>
 a && a.array_id != null && String(a.array_id) === String(groupArrayId)
 && String(a.utility_account_id) !== bound); // never the offtaker's own sub-account
 const host = hostAccountId(groupHosts);
 if (host) masterSel = host;
 }
 return {
 masterHTML: accountOptionsFlat(accts, masterSel, `<option value="">— none —</option>`),
 subHTML: accountOptionsFlat(accts, (bound && !boundIsMaster) ? bound : "",
 `<option value="">— none (bill their share of the master) —</option>`),
 };
 }

 // The OPTIONAL sub-account dropdown (second of the two account dropdowns). Lists
 // EVERY utility account so the operator can bind this offtaker to their own meter
 // (bill directly off it, topology A); blank keeps the master group share
 // (topology B). Always shown once a master group with a bill is chosen. An
 // explicit prior pick survives repaints.
 function showSubPicker(wrap, usel) {
 if (!wrap || !usel) return;
 wrap.dataset.needPick = "";
 wrap.classList.remove("req");
 const lbl = $("#rbmUtilLabel");
 if (lbl) lbl.textContent = "Sub-account (optional)";
 const prev = usel.dataset.userPicked === "1" ? usel.value : "";
 usel.innerHTML = accountOptionsFlat(ARR_UTIL_ACCTS, prev,
 `<option value="">— none (bill their share of the master) —</option>`);
 const hint = $("#rbmUtilHint");
 if (hint) hint.textContent = "If this offtaker meters on their own account, pick it to bill directly off their meter. Leave blank to bill their share of the master.";
 if (usel.__combo) usel.__combo.sync(); // mirror the (re)populated selection into the search box
 wrap.hidden = false;
 }

 // Given ARR_UTIL_ACCTS + the chosen #rbmArray (Net Meter Group), render the bill state:
 // • exactly one linked bill → silent, show "Invoices from: …"
 // • multiple linked bills → reveal the #rbmUtility picker scoped to this group
 // • NONE linked, but the tenant HAS utility accounts → reveal the picker with
 // the FULL account list. A fresh GMP link lands accounts with array_id=null
 // until they're matched to an array, so filtering on array_id alone showed
 // Bruce an EMPTY select even though every bill was downloaded. The pick is
 // sent explicitly on save and the backend links account → group from it.
 // • no utility accounts at all → amber note + a link-utility button.
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
 // A freshly-linked account chosen directly (value "u:<id>"), not yet matched to
 // an array. The net meter group IS that one account; show it as the resolved bill.
 if (String(arrId).startsWith("u:")) {
 const uid = arrId.slice(2);
 const acct = (ARR_UTIL_ACCTS || []).find(a => String(a.utility_account_id) === String(uid));
 line.className = "rb-arr-billline rb-arr-hasbill";
 line.innerHTML = acct ? `Invoices from: <b>${esc(billLabel(acct))}</b>` : "";
 if (wrap) { wrap.hidden = true; if (usel) usel.innerHTML = acct
 ? `<option value="${acct.utility_account_id}" selected>${esc(billLabel(acct))}</option>` : ""; }
 return;
 }
 const accts = ARR_UTIL_ACCTS || [];
 const mine = accts.filter(a => String(a.array_id) === String(arrId));
 if (!mine.length && !accts.length) {
 // Nothing to pick from anywhere, make the empty state ACTIONABLE.
 line.className = "rb-arr-billline rb-arr-nobill";
 line.innerHTML = "⚠ No utility bills yet, link your utility to invoice this group. ";
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
 line.innerHTML = "This group isn't matched to a utility bill yet, pick your offtaker's utility account below and we'll connect it.";
 showUtilityPicker(wrap, usel, accts, true, arrId);
 return;
 }
 // A resolved master group (one or more host bills). Show the master's bill on
 // the line and ALWAYS reveal the optional sub-account dropdown (Ford 2026-07-10:
 // both master + sub always visible). A blank sub bills the master group share.
 line.className = "rb-arr-billline rb-arr-hasbill";
 if (mine.length === 1) {
 line.innerHTML = `Invoices from: <b>${esc(billLabel(mine[0]))}</b>`;
 } else {
 const host = mine.slice().sort((a, b) => Number(a.utility_account_id) - Number(b.utility_account_id))[0];
 line.innerHTML = `This group has <b>${mine.length} utility accounts</b>, its share bills from <b>${esc(billLabel(host))}</b>.`;
 }
 showSubPicker(wrap, usel);
 }

 // Fill + reveal the offtaker-bill picker. `needPick` prepends a placeholder so
 // the operator must choose explicitly (used when no account is linked to the
 // group yet); the prior pick survives a repaint. The subtext names the chosen
 // group (Bruce's copy): "<Group> group has multiple participants. …"
 function showUtilityPicker(wrap, usel, accts, needPick, arrId) {
 if (!wrap || !usel) return;
 wrap.dataset.needPick = needPick ? "1" : "";
 wrap.classList.toggle("req", !!needPick);
 const lbl = $("#rbmUtilLabel");
 if (lbl) lbl.textContent = needPick
 ? "Select your offtaker's utility account" : "Offtaker's sub-account (optional)";
 const prev = usel.value;
 usel.innerHTML = (needPick ? `<option value="">Choose a utility account…</option>` : "") +
 accts.map(a => `<option value="${a.utility_account_id}">${esc(billLabel(a))}</option>`).join("");
 if (prev && accts.some(a => String(a.utility_account_id) === String(prev))) usel.value = prev;
 const hint = $("#rbmUtilHint");
 if (hint) {
 // Name the group from UTILITY data (vendor-free), not the array/inverter name.
 const groupAccts = (ARR_UTIL_ACCTS || []).filter(a => String(a.array_id) === String(arrId));
 const gname = groupAccts.length ? nmgGroupLabel(groupAccts).split(" · ")[0] : "This group";
 hint.textContent = gname +
 " has multiple participants. Your selection here should be the utility account from this dropdown list.";
 }
 if (usel.__combo) usel.__combo.sync(); // mirror the (re)populated selection into the search box
 wrap.hidden = false;
 }

 // Human label for a utility account in the bill line / offtaker-bill picker:
 // "Starlake · GMP acct 43210 · 12 bills · latest 2026-06". Name prefers the
 // operator's nickname, then the linked array's name; the account number is
 // always shown so same-named accounts stay tellable-apart.
 function billLabel(a) {
 const prov = (a.provider || "gmp").toLowerCase();
 const provTag = prov === "gmp" ? "GMP" : prov.toUpperCase();
 // Vendor-free: operator nickname → utility service address, NEVER the array/
 // inverter name (Ford 2026-07-09: no vendor info in the offtaker invoice generator).
 const who = (a.nickname || "").trim() || (a.service_address || "").trim();
 const acctNo = `${provTag} acct ${a.account_number || "?"}`;
 const name = who ? `${who} · ${acctNo}` : acctNo;
 const bills = a.has_bill
 ? ` · ${a.bill_count || 0} bill${a.bill_count === 1 ? "" : "s"}${a.latest_period_label ? " · latest " + a.latest_period_label : ""}`
 : " · no bill on file yet";
 return name + bills;
 }

 // Open the add-offtaker form pre-set to a master net-meter group (from a group
 // header's "+ Add offtaker"): park the master array_id, open the Type-it-in panel,
 // and scroll it into view. wireArrayFirst applies the pre-pick once it populates.
 function openAddOfftakerForMaster(arrayId) {
 PENDING_MASTER_ARRAY = (arrayId != null && arrayId !== "") ? String(arrayId) : null;
 ADD_MODE = "manual";
 BULK_OPEN = false; renderBulkImport();
 MANUAL_OPEN = true; renderManual();
 const host = $("#" + MANUAL_HOST_ID);
 if (host) host.scrollIntoView({ behavior: "smooth", block: "start" });
 }

 let ADD_MODE = "manual"; // "manual" | "upload", active tab in the add panel
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
 ? "Pick the <b>master account</b> your offtaker draws from, we resolve the utility bill it invoices from (the paper bill, never inverter data) and bill them for their share of it. If they meter on their own account, set that as the <b>sub-account</b>."
 : "Already bill in your own spreadsheet? Drop it and we'll keep invoicing in <b>that exact format</b> every cycle."}</p>

 <div id="rbAddManual" ${ADD_MODE === "manual" ? "" : "hidden"}>
 <!-- Required-field marking (Bruce C5): .req mirrors saveManual's actual
 validation, group, name, share %, email, and the bill pick when its
 picker is visible. Everything else saves blank, so it stays clear. -->
 <p class="rb-req-legend">Marked fields are required, everything else is optional.</p>
 <div class="rb-mform-grid">
 <label class="rep-fld req"><span class="rl">Master account</span>
 <select id="rbmArray"><option value="">Loading master accounts…</option></select>
 <span class="rb-fld-hint">The net-meter group host this offtaker bills a share of.</span>
 <span class="rb-arr-billline" id="rbmBillLine"></span>
 <label class="rep-fld rb-arr-override" id="rbmUtilityWrap" hidden><span class="rl" id="rbmUtilLabel">Sub-account (optional)</span>
 <select id="rbmUtility"><option value="">— none (bill their share of the master) —</option></select>
 <span class="rb-fld-hint" id="rbmUtilHint">If this offtaker meters on their own account, pick it to bill directly off their meter. Leave blank to bill their share of the master.</span></label></label>
 <label class="rep-fld req"><span class="rl">Offtaker name</span>
 <input type="text" id="rbmName" placeholder="e.g. Sunnybrook Apartments"></label>
 <!-- Contact hoisted next to name (Ford 2026-07-10): the offtaker email is
 critical (and required here), so it sits with the identity fields, not
 buried below the billing config. -->
 <label class="rep-fld req"><span class="rl">Offtaker email</span>
 <input type="email" id="rbmEmail" placeholder="offtaker@example.com"></label>
 <!-- Money cluster (Bruce C5): share → rate → discount → cross-check read
 as one block, "get the solar credit rate right next to or below the
 share of array". -->
 <label class="rep-fld req"><span class="rl">Expected share of array's net meter group (%)</span>
 <input type="number" id="rbmPct" min="0.01" max="100" step="0.001" placeholder="e.g. 24.783"></label>
 <!-- Solar credit rate (Ford 2026-07-07): an EDITABLE $/kWh override for
 every offtaker, defaulting to the bill's own rate. This slot is
 provider-aware (paintRateField): GMP/unknown → an input that
 defaults to each GMP bill's net-metering credit rate (blank = use
 it; type only to override, e.g. a banked period); VEC/SmartHub
 (whose portals publish no usable rate) → the same input framed as
 the rate to bill at until a bill lands. Both write net_rate_per_kwh. -->
 <label class="rep-fld rbm-rate-slot" id="rbmRateSlot"></label>
 <label class="rep-fld"><span class="rl">Discount (% off solar credit rate)</span>
 <input type="number" id="rbmRate" min="0" max="99" step="1" placeholder="blank = use my default">
 <span class="rb-fld-hint">Leave blank to use your default discount (10% off).</span></label>
 <label class="rep-fld"><span class="rl">Bill-accuracy flag threshold (%)
 <span class="rb-info" tabindex="0" title="The Bill accuracy check derives GMP's actual share automatically (what GMP credited this offtaker ÷ the array's group excess) and compares it to the Expected share you entered above, no data entry needed. This sets how far the two may differ before it's flagged. Leave blank to use your default (${fmtPct(XCHECK_DEFAULT_PCT)}%).">ⓘ</span></span>
 <input type="number" id="rbmXThresh" min="0.001" max="100" step="0.001" placeholder="blank = default (${fmtPct(XCHECK_DEFAULT_PCT)}%)">
 <span class="rb-fld-hint">Flags when GMP's derived share differs from your entered share by more than this. Blank = ${fmtPct(XCHECK_DEFAULT_PCT)}%.</span></label>
 <label class="rep-fld"><span class="rl">Commissioning Date</span>
 <input type="date" id="rbmCommDate" min="1990-01-01" max="${todayISO()}">
 <span class="rb-fld-hint" id="rbmRateHint">The array's in-service date, sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).</span></label>
 <label class="rep-fld"><span class="rl">Starting invoice #</span>
 <input type="number" id="rbmInvStart" min="0" max="9999999" step="1" placeholder="blank = date-based">
 <span class="rb-fld-hint">Optional. Seeds sequential invoice numbering; each send adds 1.</span></label>
 <label class="rep-fld"><span class="rl">Budget bill, fixed total ($)</span>
 <input type="number" id="rbmBudget" min="0" step="0.01" placeholder="blank = use the calculated amount">
 <span class="rb-fld-hint">Set a flat amount this offtaker pays, overrides the calculated total (line items still show).</span></label>
 </div>
 <div class="rb-controls">
 <div class="rb-ctl">
 <span class="rl">When a report is ready</span>
 <div class="rb-seg rb-slider" id="rbmDelivery">
 <button type="button" data-v="approval" class="${(PIPE && PIPE.default_delivery_mode) === 'auto' ? '' : 'on'}">Draft for my approval</button>
 <button type="button" data-v="auto" class="${(PIPE && PIPE.default_delivery_mode) === 'auto' ? 'on' : ''}">Auto-send</button>
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
 to your offtaker automatically, under <b>your name</b>, replies to your email, no Array Operator branding.
 It only fires once a real utility bill for the period has landed. <b>Real sends to real customers are
 still gated</b> while we prove it out on demo data, until then Auto-send previews on demo data and holds
 real invoices for your approval.</p>
 <p class="rb-bcc-note">📩 Every invoice email sent to an offtaker is automatically
 <b>BCC'd to your email</b>, so you always see exactly what they received.</p>
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
 <span class="rb-drop-sub">.xlsx, up to 8 MB</span>
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
 // Record an explicit sub-account pick (so a repaint never clobbers it) and
 // repaint the rate field to the picked account's provider.
 const utilElAM = $("#rbmUtility");
 if (utilElAM) utilElAM.addEventListener("change", () => {
 utilElAM.dataset.userPicked = "1"; paintRateField();
 });
 // Commissioning date → live expected-GMP-rate helper next to the rate fields.
 const commDefHint = "The array's in-service date, sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).";
 wireCommissioningDateHint($("#rbmCommDate"), $("#rbmRateHint"), commDefHint);
 // When an array is picked, surface its SAVED commissioning date (if any) so
 // the operator sees, and can correct, exactly what the rate helper uses.
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
 let arrayId = $("#rbmArray") ? $("#rbmArray").value : "";
 // A directly-chosen unmatched utility account (value "u:<id>") binds by ACCOUNT
 // (the backend's OFFTAKER↔UTILITY-BILL path), no array_id. Everything else is
 // array-first (backend resolves the bill from the array).
 let looseUtilityId = "";
 if (String(arrayId).startsWith("u:")) { looseUtilityId = arrayId.slice(2); arrayId = ""; }
 // The sub-account <select> (when visible) links the offtaker to their OWN GMP
 // sub-account. Two visible modes: (1) auto-match, value "" resolves below to
 // the name-matched sub-account, else the group's host bill (their %-of-group);
 // (2) forced pick, an unmatched group where the operator must choose from the
 // full account list. A blank value in mode 1 is valid; in mode 2 it errors.
 const utilWrap = $("#rbmUtilityWrap");
 const wrapVisible = utilWrap && !utilWrap.hidden;
 const needPick = wrapVisible && utilWrap.dataset.needPick === "1";
 const uselEl = $("#rbmUtility");
 let utilityId = wrapVisible && uselEl ? uselEl.value : "";
 const pctRaw = $("#rbmPct").value.trim();
 const rateRaw = $("#rbmRate").value.trim();
 const creditRateRaw = $("#rbmCreditRate") ? $("#rbmCreditRate").value.trim() : "";
 const xThreshRaw = $("#rbmXThresh") ? $("#rbmXThresh").value.trim() : "";
 const invStartRaw = $("#rbmInvStart") ? $("#rbmInvStart").value.trim() : "";
 const budgetRaw = $("#rbmBudget") ? $("#rbmBudget").value.trim() : "";
 const commDateRaw = $("#rbmCommDate") ? $("#rbmCommDate").value.trim() : "";
 // The "Send to" slider was removed, offtaker invoices go to the offtaker and
 // the operator is BCC'd on every send (so they always see what was received).
 const mode = "to_client";
 const clientEmail = $("#rbmEmail").value.trim();
 if (!arrayId && !looseUtilityId) { st.className = "rb-status rb-err"; st.textContent = "Pick which net meter group this offtaker draws from."; return; }
 // Block save only when the tenant has NO utility accounts at all (nothing to
 // invoice from). A group with no LINKED account is fine, the picker offered
 // the full account list and the explicit pick below carries the binding.
 const arrAccts = (ARR_UTIL_ACCTS || []).filter(a => String(a.array_id) === String(arrayId));
 if (!arrAccts.length && !(ARR_UTIL_ACCTS || []).length) {
 st.className = "rb-status rb-err";
 st.textContent = "This group has no utility bills yet, link your utility before invoicing it.";
 return;
 }
 if (needPick && !utilityId) {
 st.className = "rb-status rb-err";
 st.textContent = "Pick your offtaker's utility account so we know which bill to invoice from.";
 return;
 }
 // Auto-match (visible picker, blank value, not a forced pick): resolve to the
 // name-matched sub-account (topology A), else the group host bill (their share
 // of the whole group, topology B). Never a silent wrong-meter bind.
 if (wrapVisible && !needPick && !utilityId) {
 const mineNow = (ARR_UTIL_ACCTS || []).filter(a => String(a.array_id) === String(arrayId));
 const m = matchSubAccount(name, mineNow);
 utilityId = m ? String(m.account.utility_account_id) : hostAccountId(mineNow);
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
 let xThreshNum = null;
 if (xThreshRaw !== "") {
 xThreshNum = Number(xThreshRaw);
 if (isNaN(xThreshNum) || xThreshNum <= 0 || xThreshNum > 100) {
 st.className = "rb-status rb-err"; st.textContent = "Flag threshold must be a percent between 0 and 100, or blank."; return;
 }
 }
 let invStartNum = null;
 if (invStartRaw !== "") {
 invStartNum = Number(invStartRaw);
 if (isNaN(invStartNum) || invStartNum < 0 || !Number.isInteger(invStartNum) || invStartNum > 9999999) {
 st.className = "rb-status rb-err"; st.textContent = "Starting invoice # must be a whole number 0–9999999, or blank."; return;
 }
 }
 let budgetNum = null;
 if (budgetRaw !== "") {
 budgetNum = Number(budgetRaw);
 if (isNaN(budgetNum) || budgetNum < 0) {
 st.className = "rb-status rb-err"; st.textContent = "Budget must be a dollar amount ≥ 0, or blank."; return;
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
 const fd = new FormData(); // no file → manual path
 fd.append("customer_name", name);
 if (arrayId) fd.append("array_id", String(arrayId)); // array-FIRST: backend resolves the bill from the array
 // utility_account_id carries the resolved sub-account link: an explicit pick,
 // the name-matched sub-account, the group host (auto-match fallback), or a
 // freshly-linked account chosen directly, the backend binds the bill by it.
 const utilToSend = looseUtilityId || utilityId;
 if (utilToSend) fd.append("utility_account_id", utilToSend);
 fd.append("allocation_pct", String(pctNum / 100)); // backend wants a fraction in (0,1]
 if (rateNum !== null) fd.append("discount_pct", String(rateNum / 100));
 if (creditRateNum !== null) fd.append("net_rate_per_kwh", String(creditRateNum));
 if (xThreshNum !== null) fd.append("crosscheck_threshold_pct", String(xThreshNum)); // variance flag threshold, pct points
 if (invStartNum !== null) fd.append("invoice_number_start", String(invStartNum));
 if (budgetNum !== null) fd.append("budget_amount_usd", String(budgetNum));
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
 st.textContent = apiErr(data, "Couldn't add (HTTP " + r.status + ").");
 return;
 }
 // The commissioning date sets the array's in-service date (feeds the GMP
 // rate regime, day-accurate at the 11-year boundary). Best-effort: the
 // offtaker is already created; a failure here shouldn't block it.
 const newArrayId = (data.subscription && data.subscription.array_id) || arrayId;
 const newSubId = data.subscription && data.subscription.id;
 if (commDateVal !== null && newArrayId) { // truthy: skip when there's no array (a loose-account bind)
 try {
 await fetch(API + "/arrays/" + newArrayId, {
 method: "PATCH",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ first_connect_date: commDateVal }),
 });
 _SETUP_ARRAYS = null; // the accordion prefill cache is now stale
 } catch (e) { /* non-fatal, offtaker was created */ }
 }
 MANUAL_OPEN = false;
 renderManual();
 if (MANUAL_AFTER_ADD) await MANUAL_AFTER_ADD();
 else await refreshList();
 // Reproduce the hard-refresh outcome for the NEW offtaker deterministically:
 // force-mint its draft fresh (the /draft endpoint re-pulls the bound account +
 // the commissioning regime we just committed above) and expand it, so its
 // bill / values / rate are correct on FIRST paint, no manual hard refresh
 // (Ford 2026-07-07: "shouldn't need to hard refresh to get the newly added
 // offtaker correct"). Degrades to the honest empty state if no bill has
 // settled for it yet.
 if (newSubId != null) { try { await selectOfftaker(String(newSubId), true); } catch (e) { /* the list already refreshed */ } }
 } catch (e) {
 st.className = "rb-status rb-err"; st.textContent = "Network error while adding.";
 }
 }

 // ---- bulk offtaker import, upload → REVIEW & CORRECT → commit -------------
 // The heart of "flawless" import: the operator uploads a workbook (.xlsx/.csv),
 // the backend dry-runs a fuzzy ARRAY match per row, and we render a review table
 // where every array match is a CORRECTABLE dropdown with a confidence badge. No
 // medium/none match is ever auto-imported, the operator must confirm the guess.
 let BULK_OPEN = false;
 let BULK_PREVIEW = null; // the raw dry-run payload {summary, arrays, rows}
 let BULK_ARRAYS = []; // the pick-list: [{array_id, array_name, utility_account_id, utility_label, provider, has_bill}]
 let BULK_ROWS = []; // editable per-offtaker state (persists corrections across re-renders)
 let BULK_FILE = null; // the File we previewed (kept for a re-upload / re-parse-with-override)
 // Two-phase review: "columns" = confirm which sheet column is which of OUR fields
 // (Phase 1, NEW), "rows" = the per-offtaker array-match review (Phase 2, existing).
 let BULK_PHASE = "columns";
 let DETECTION = null; // the backend `detection` block from the first dry-run
 let COLUMN_MAP = {}; // OUR field -> column index (or null = "not in my sheet")

 // OUR importable fields, in display order. `req` = required (Continue is gated on
 // all three being mapped). Order/labels are the operator-facing column meanings.
 // Utility-agnostic field labels (GMP / VEC / WEC / SmartHub / any co-op export).
 // array_name is soft-required: backend accepts account-# identity instead.
 const BULK_FIELDS = [
 { key: "array_name", label: "Array", req: true },
 { key: "master_account_number", label: "Master utility account #", req: false },
 { key: "offtaker_account_name", label: "Offtaker utility name", req: false },
 { key: "offtaker_name", label: "Offtaker name", req: true },
 { key: "allocation_pct", label: "Share %", req: true },
 { key: "email", label: "Email", req: false },
 { key: "discount_pct", label: "Discount %", req: false },
 { key: "account_number", label: "Offtaker account #", req: false },
 { key: "budget", label: "Budget monthly ($)", req: false },
 { key: "net_rate", label: "Rate ($/kWh)", req: false },
 ];

 // 0 → "A", 1 → "B", … 26 → "AA", spreadsheet-style column letters for friendliness.
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
 // The net meter group's accounts (sharing array_id) from the full utility-account
 // list, the sub-accounts a bulk row's offtaker could bill from. Empty until the
 // review loads ARR_UTIL_ACCTS (bulkPreviewFile primes it).
 function bulkGroupAccts(arrayId) {
 if (arrayId == null) return [];
 return (ARR_UTIL_ACCTS || []).filter(a => String(a.array_id) === String(arrayId));
 }
 // Auto-match a bulk row to the offtaker's OWN sub-account by name (unless the
 // operator picked one). Refines the server's representative account to the
 // name-matched sub-account when the group has more than one; `_subMatched` drives
 // the "matched by name" badge. Single-account groups keep their one account.
 function bulkAutoMatchRow(row) {
 row._subMatched = false;
 if (row._subPicked) return;
 const grp = bulkGroupAccts(row.array_id);
 if (grp.length < 2) return;
 const m = matchSubAccount(row.offtaker_name, grp);
 if (m) { row.utility_account_id = m.account.utility_account_id; row._subMatched = true; }
 else if (!grp.some(a => String(a.utility_account_id) === String(row.utility_account_id))) {
 const h = hostAccountId(grp);
 if (h) row.utility_account_id = Number(h);
 }
 }
 // The optional per-row sub-account picker, shown only when the group has >1
 // account (the only case a choice exists), mirrors the add-offtaker flow.
 function bulkSubAccountCellHTML(row) {
 const grp = bulkGroupAccts(row.array_id);
 if (grp.length < 2) return "";
 const opts = grp.map(a =>
 `<option value="${a.utility_account_id}"${String(a.utility_account_id) === String(row.utility_account_id) ? " selected" : ""}>${esc(billLabel(a))}</option>`).join("");
 const badge = row._subMatched
 ? `<span class="rb-conf rb-conf-ok" title="Matched to this offtaker's own sub-account by name, change it if they meter elsewhere.">matched by name</span>` : "";
 return `<div class="rb-rev-subbox">
 <select class="rb-rev-in rb-rev-subsel" data-f="utility_account_id" title="Offtaker's sub-account">${opts}</select>${badge}</div>`;
 }
 function bulkArrayLabel(a) {
 // Vendor-free (Ford 2026-07-09): lead with the utility identity (provider · acct
 // · nickname); fall back to the array name only when no utility account is linked
 // yet, so the row is still identifiable.
 return a.utility_label || a.array_name || ("Array " + a.array_id);
 }

 // Derive a per-row status from the CURRENT edited state (not the server's, the
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
 <p class="rb-add-sub">Drop <b>any</b> utility roster or your own spreadsheet, GMP, VEC,
 WEC, SmartHub co-op, Excel, Google Sheets. We detect columns, match each offtaker to an
 array, and create <b>new</b> offtakers after you review. One row needs an offtaker name,
 a share %, and either an array name or a utility account #.</p>
 <div class="rb-upload" id="rbBulkDrop">
 <label class="rb-drop" id="rbBulkDropZone">
 <input type="file" id="rbBulkFile" accept=".csv,.xlsx" hidden>
 <span class="rb-drop-ico">⬆</span>
 <span class="rb-drop-main">Choose a spreadsheet or drop it here</span>
 <span class="rb-drop-sub">.xlsx or .csv, any utility export or operator roster</span>
 </label>
 <p class="rb-sample-hint">Want a blank starter?
 <a href="#" class="rb-sample-link" id="rbBulkTemplate">Download the template</a>
 , or just drop the file you already have; column names don't need to match.</p>
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

 // ── Step 2: two-phase review, columns first, then per-row array match ──
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
 const flags = row.flags || [];
 if (flags.includes("offtaker_account_not_connected")) {
 const pending = row.pending_offtaker_account_number
 ? ` Account # ${row.pending_offtaker_account_number} isn't connected yet, offtaker will bill from the host until that meter is linked.`
 : " Offtaker account # isn't connected yet, offtaker will bill from the host until that meter is linked.";
 return `<span class="rb-conf rb-conf-warn" title="${esc(pending.trim())}">account pending</span>`;
 }
 if (flags.includes("master_account_not_connected")) {
 return `<span class="rb-conf rb-conf-warn" title="Master utility account # isn't connected yet, pick the array manually.">master pending</span>`;
 }
 const c = row._confirmed ? "high" : (row.confidence || "none");
 if (c === "exact" || c === "high") return `<span class="rb-conf rb-conf-ok" title="Confident match.">✓</span>`;
 if (c === "medium") return `<button type="button" class="rb-conf rb-conf-warn rb-conf-confirm" title="Low-confidence match, click to confirm this is the right array, or pick a different one.">check this ✓</button>`;
 return `<span class="rb-conf rb-conf-bad" title="We couldn't confidently match this, pick the array.">pick the array</span>`;
 }
 function bulkStatusPill(status) {
 if (status === "ready") return `<span class="rb-pill rb-pill-ok">Ready</span>`;
 if (status === "needs_review") return `<span class="rb-pill rb-pill-warn">Needs review</span>`;
 return `<span class="rb-pill rb-pill-bad">Blocked</span>`;
 }

 // ============================================================================
 // PHASE 1, column-mapping review (NEW)
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
 // array_name is soft-required when an account # column stands in for it.
 const softOk = field.key === "array_name" && (
 COLUMN_MAP.master_account_number != null || COLUMN_MAP.account_number != null);
 if (field.req && !softOk) {
 return `<span class="rb-col-badge rb-conf rb-conf-bad" title="Required, pick the column that holds this.">needed</span>`;
 }
 return softOk
 ? `<span class="rb-col-badge rb-col-skip" title="Optional when a utility account # is mapped, we'll resolve the array from the account.">via account #</span>`
 : `<span class="rb-col-badge rb-col-skip" title="Not in your sheet, that's fine.">not mapped</span>`;
 }
 // Only trust the detected confidence while the operator keeps the detected column;
 // a hand-picked column is an explicit choice → treat as confident.
 const det = (DETECTION && DETECTION.column_map && DETECTION.column_map[field.key]) || null;
 const kept = det && det.index === idx;
 const conf = kept ? detConfidence(field.key) : "high";
 if (conf === "high") return `<span class="rb-col-badge rb-conf rb-conf-ok" title="Confident match.">✓</span>`;
 if (conf === "medium") return `<span class="rb-col-badge rb-conf rb-conf-warn" title="Medium-confidence match, worth a glance.">check this</span>`;
 return `<span class="rb-col-badge rb-col-pick" title="Low confidence, confirm this is the right column.">pick a column</span>`;
 }

 // Which OUR-field (if any) currently owns a given sheet column index → drives the
 // live preview tint so the operator SEES the mapping on their own data.
 function fieldForColumn(idx) {
 for (const f of BULK_FIELDS) if (COLUMN_MAP[f.key] === idx) return f;
 return null;
 }

 // Required fields still without a column → the reasons Continue stays disabled.
 // array_name is soft: account # columns can stand in for array identity (utility
 // exports that only list member account numbers, no array name).
 function unmappedRequired() {
 const missing = BULK_FIELDS.filter(f => f.req && COLUMN_MAP[f.key] == null);
 const hasArrayIdentity = COLUMN_MAP.array_name != null
 || COLUMN_MAP.master_account_number != null
 || COLUMN_MAP.account_number != null;
 return missing.filter(f => f.key !== "array_name" || !hasArrayIdentity);
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
 <p class="rb-add-sub">${sheetNote}Detected the header row and mapped your columns, confirm or fix
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
 <div class="rb-col-prevlabel">Your data, highlighted columns are the ones you've assigned</div>
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
 <button class="ao-btn ao-btn-primary rb-save" id="rbColContinue" type="button" ${canContinue ? "" : "disabled"}>Looks right, continue →</button>
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
 if (unmappedRequired().length) return; // gate: never continue with a required field unmapped
 // Send only the fields the operator kept (omit "not in my sheet" fields).
 const override = {};
 BULK_FIELDS.forEach(f => { if (COLUMN_MAP[f.key] != null) override[f.key] = COLUMN_MAP[f.key]; });
 bulkPreviewFile(BULK_FILE, override, $("#rbColStatus"));
 };
 }

 // Compact "Columns: Array=…, Offtaker=…, %=… [change]" strip shown atop Phase 2 so
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
 ${bulkSubAccountCellHTML(row)}
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
 <h3>Bulk import, review &amp; correct</h3>
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

 // "check this ✓", confirm a medium-confidence guess WITHOUT changing the
 // dropdown (a <select> fires no change event when re-picking the same value,
 // so agreeing with the guess needs its own affordance). Honesty preserved: the
 // operator still had to look and click, never a silent auto-accept.
 host.querySelectorAll(".rb-conf-confirm").forEach(btn => {
 const tr = btn.closest("tr");
 const i = Number(tr.getAttribute("data-i"));
 btn.onclick = () => { BULK_ROWS[i]._confirmed = true; renderBulkReview(); };
 });

 // Wire the editable fields, mutate BULK_ROWS in place so corrections persist
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
 row._subPicked = false; // new group → auto-match its sub-account
 bulkAutoMatchRow(row);
 renderBulkReview(); // full re-render: badge + pill + summary
 };
 } else if (f === "utility_account_id") {
 // Explicit sub-account pick → pin it (auto-match stops overriding).
 el.onchange = () => {
 const row = BULK_ROWS[i];
 row.utility_account_id = el.value ? Number(el.value) : null;
 row._subPicked = true;
 renderBulkReview();
 };
 } else {
 // Text/number fields: update state live; refresh the row's pill + summary
 // without a full re-render so focus/caret isn't lost mid-typing.
 el.oninput = () => {
 const row = BULK_ROWS[i];
 const v = el.value.trim();
 if (f === "allocation_pct") row.allocation_pct = v === "" ? null : Number(v) / 100;
 else if (f === "discount_pct") row.discount_pct = v === "" ? null : Number(v) / 100;
 else row[f] = v; // offtaker_name / email
 refreshBulkRowPill(tr, i);
 };
 // Re-run sub-account auto-match when the name settles (blur), for groups
 // with a real choice and no explicit pick yet.
 if (f === "offtaker_name") el.onchange = () => {
 const row = BULK_ROWS[i];
 if (!row._subPicked && bulkGroupAccts(row.array_id).length > 1) {
 bulkAutoMatchRow(row);
 renderBulkReview();
 }
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
 status.textContent = apiErr(data, "Couldn't read that file (HTTP " + r.status + ").");
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
 budget_amount_usd: r.budget_amount_usd != null ? r.budget_amount_usd : null,
 offtaker_account_name: r.offtaker_account_name || "",
 confidence: r.confidence || "none",
 errors: r.errors || [],
 flags: r.flags || [],
 pending_offtaker_account_number: r.pending_offtaker_account_number || null,
 _confirmed: (r.confidence === "exact" || r.confidence === "high"),
 // An exact offtaker-account-number bind is authoritative, treat it as an
 // explicit pick so name auto-match never second-guesses it.
 _subPicked: !!r.utility_locked,
 _subMatched: false,
 }));

 // Prime the full utility-account list (shared with the add-offtaker form) so
 // each row can offer its group's sub-accounts, then auto-match every row to
 // the offtaker's OWN sub-account by name.
 if (!ARR_UTIL_ACCTS) { ARR_UTIL_ACCTS = await fetchUtilityAccounts(); }
 BULK_ROWS.forEach(bulkAutoMatchRow);

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
 budget_amount_usd: r.budget_amount_usd != null ? r.budget_amount_usd : null,
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
 if (st) { st.className = "rb-status rb-err"; st.textContent = apiErr(data, "Import failed (HTTP " + r.status + ")."); }
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

 // Post-commit summary when some rows failed/skipped, shown IN PLACE of the review.
 function renderBulkCommitResult(created, failed, skipped) {
 const host = $("#rbBulkHost");
 const problem = failed.concat(skipped);
 const rows = problem.map(p =>
 `<tr class="rb-bulk-err"><td>${esc(p.offtaker_name || "—")}</td><td>${esc(p.error || p.reason || "skipped")}</td></tr>`
 ).join("");
 host.innerHTML = `
 <div class="rep-card rb-manual-form rb-add-panel">
 <div class="rb-add-head">
 <h3>Bulk import, done</h3>
 <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkClose" type="button">Close</button>
 </div>
 <p class="rb-add-sub"><b>${created}</b> offtaker${created === 1 ? "" : "s"} imported.
 ${problem.length ? `<b>${problem.length}</b> couldn't be created, details below.` : ""}</p>
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
 // Cache-bust: the template endpoint sits behind an edge cache that would
 // otherwise serve a stale copy after a template update.
 const r = await fetch(API + "/offtaker-template.xlsx?v=" + Date.now(), { headers: authHeaders() });
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
 <p class="rep-note">New schedules send <b>to you</b> by default, nothing reaches your
 customer until you move the slider to “To my client” or “To both”. Use <b>Send test</b>
 below to preview a delivery to yourself first.</p>
 </div>`;
 wireSegments(host);
 $("#rbCancel").onclick = () => { PENDING = null; host.innerHTML = ""; $("#rbStatus").textContent = ""; renderDoc(); };
 $("#rbSave").onclick = saveSchedule;

 // Live document preview (right pane), paint now, then repaint on any change.
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
 performance summary your offtaker receives, updating live as you set
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
 <div class="rb-doc-cap">Live preview, exactly what gets delivered</div>
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
 st.textContent = apiErr(data, "Couldn't save (HTTP " + r.status + ").");
 return;
 }
 const newSubId = data.subscription && data.subscription.id;
 PENDING = null;
 // Close the add panel and refresh the offtaker list (mirrors the manual
 // path). The panel is the unified "Add an offtaker" surface now.
 MANUAL_OPEN = false;
 renderManual();
 if (MANUAL_AFTER_ADD) await MANUAL_AFTER_ADD();
 else await refreshList();
 // Same as the manual path: force-mint + expand the new offtaker so it's
 // correct on first paint without a hard refresh.
 if (newSubId != null) { try { await selectOfftaker(String(newSubId), true); } catch (e) { /* the list already refreshed */ } }
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
 // "approval inbox" section is GONE, each expanded card IS that offtaker's draft.
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
 if (rb.status === 401) { list.innerHTML = `<div class="empty">Session expired, please sign in again.</div>`; return; }
 if (rb.ok) {
 const d = await rb.json().catch(() => ({}));
 if (d && d.ok) {
 subs = d.subscriptions || [];
 arrs = ARRAYS = (d.arrays || []).filter(a => a.id != null); // prime the shared arrays cache
 utilAccts = (d.utility_accounts || []).filter(a => a.utility_account_id != null);
 if (d.crosscheck_threshold_default_pct != null) XCHECK_DEFAULT_PCT = Number(d.crosscheck_threshold_default_pct);
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
 if (r.status === 401) { list.innerHTML = `<div class="empty">Session expired, please sign in again.</div>`; return; }
 const data = await r.json().catch(() => ({}));
 subs = (data && data.subscriptions) || [];
 if (data && data.crosscheck_threshold_default_pct != null) XCHECK_DEFAULT_PCT = Number(data.crosscheck_threshold_default_pct);
 arrs = a2; utilAccts = u2;
 }
 const drafts = await draftsP;
 INBOX_UTIL_ACCTS = utilAccts || [];
 // Pay-link chips (V2), best-effort, never block the offtaker list.
 try { await loadOfftakerPayments(); } catch (e) { /* ignore */ }
 renderAccordion(subs, arrs, utilAccts, drafts);
 // Bill accuracy check: fetch the reconcile payload (once, cached) alongside the
 // list. When it lands, paint the top-level summary chip and, if a card is
 // already open, fill its "Bill accuracy check" section, no reload needed.
 if (authHeaders() && !RECON) {
 loadReconcile().then(r => {
 if (!r) return;
 refreshBacSummary();
 if (ACTIVE_SUB_ID != null) renderAccordionBody(ACTIVE_SUB_ID);
 });
 }
 } catch (e) {
 list.innerHTML = `<div class="empty">Couldn't load your schedules, refresh to retry.</div>`;
 }
 }

 async function loadOfftakerPayments() {
 if (!authHeaders()) { PAY_BY_SUB = {}; return; }
 try {
 const r = await fetch(API + "/payments?limit=200", { headers: authHeaders() });
 if (!r.ok) return;
 const j = await r.json().catch(() => ({}));
 const map = {};
 (j.payments || []).forEach(p => {
 if (p.subscription_id == null) return;
 const k = String(p.subscription_id);
 // List is newest-first; keep the first (most recent) per offtaker.
 if (!map[k]) map[k] = p;
 });
 PAY_BY_SUB = map;
 } catch (e) { /* leave prior map */ }
 // Refresh the Connect nudge in parallel with payment chips.
 try { await refreshPayBanner(); } catch (e) { /* ignore */ }
 }

 async function refreshPayBanner() {
 const el = document.getElementById("rbPayBanner");
 if (!el) return;
 if (!authHeaders()) { el.hidden = true; el.innerHTML = ""; return; }
 let st = null;
 try {
 const r = await fetch(API + "/payments/connect", { headers: authHeaders() });
 if (r.ok) st = await r.json();
 } catch (e) { st = null; }
 if (!st || !st.ok) { el.hidden = true; return; }
 const feePct = (st.fee_percent != null ? Number(st.fee_percent) : (Number(st.fee_bps || 50) / 100));
 const feeTxt = (Math.round(feePct * 100) / 100) + "%";
 if (st.ready || st.charges_enabled) {
 // Quiet success: don't clutter the Reports tab once they're set up.
 el.hidden = true;
 el.innerHTML = "";
 return;
 }
 el.hidden = false;
 if (st.connected || st.account_id) {
 el.innerHTML =
 `<span class="rb-pay-banner-ic" aria-hidden="true">💳</span>` +
 `<span class="rb-pay-banner-tx"><b>Finish online payments setup</b>, complete your bank details so offtaker invoices can include a pay button (${feeTxt} fee).</span>` +
 `<a class="rb-pay-banner-cta" href="#account">Continue setup →</a>`;
 } else {
 el.innerHTML =
 `<span class="rb-pay-banner-ic" aria-hidden="true">💳</span>` +
 `<span class="rb-pay-banner-tx"><b>Collect payments online</b>, offtaker invoices can include a secure pay link. We keep ${feeTxt}; the rest lands in your bank.</span>` +
 `<a class="rb-pay-banner-cta" href="#account">Enable online pay →</a>`;
 }
 }

 // Group offtakers by the utility account they share (Ford, 2026-06-30: "when you
 // get above five offtakers, they should be sorted by utility account... so if I
 // have five offtakers with one utility bill, they should all be sorted together").
 // Only kicks in above the 5-offtaker threshold, below that, the flat draft-first/
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
 // genuine mix (both GMP and non-GMP), a pure-GMP fleet never sees the noise.
 function providerBucketCounts(rows, utilAccts) {
 const acctById = {};
 (utilAccts || []).forEach(a => { if (a.utility_account_id != null) acctById[String(a.utility_account_id)] = a; });
 let gmp = 0, other = 0;
 (rows || []).forEach(s => { (offtakerProviderBucket(s, acctById) === "gmp" ? gmp++ : other++); });
 return { gmp, other, acctById };
 }

 function groupOfftakersByUtility(rows, utilAccts) {
 // Ford, 2026-07-09: the array/utility-organized view is now the DEFAULT for
 // every fleet, not just 5+ offtakers. (Small fleets default EXPANDED below —
 // see _smallFleet, so nothing is hidden behind a collapsed header.)
 if (!rows || !rows.length) return null;
 const acctById = {};
 (utilAccts || []).forEach(a => { if (a.utility_account_id != null) acctById[String(a.utility_account_id)] = a; });
 // Group by the MASTER net-meter group (array_id), NOT the account the offtaker
 // happens to bill from (Ford 2026-07-10). An offtaker on its OWN sub-meter (e.g.
 // "Brooks House", a sub of the "Londonderry" master) must show UNDER its master
 // array, labeled by that master's host account, not under its own sub-account.
 // The group host (master) = the lowest utility_account_id on the array (mirrors
 // the backend host rule). Topology-B offtakers bound straight to the host are
 // unchanged: their account IS the host, so array-keying groups them identically
 // (and array_share_pct is null for them → the sum still uses allocation_pct).
 const hostByArray = {};
 (utilAccts || []).forEach(a => {
 if (a.array_id == null || a.utility_account_id == null) return;
 const k = String(a.array_id);
 if (!hostByArray[k] || Number(a.utility_account_id) < Number(hostByArray[k].utility_account_id))
 hostByArray[k] = a;
 });
 const groups = {};
 const order = [];
 rows.forEach(s => {
 // The net-meter GROUP key: the master array when known, else the bound account.
 const key = s.array_id != null ? "a:" + s.array_id
 : s.utility_account_id != null ? "u:" + s.utility_account_id
 : "u:none";
 if (!groups[key]) {
 // Label + provider come from the group's MASTER (host) account, vendor-free
 // (utilityIdentity: nickname → service address → provider+acct#), never the
 // sub-account or the array/inverter name.
 const host = s.array_id != null ? hostByArray[String(s.array_id)] : null;
 const acct = host || (s.utility_account_id != null ? acctById[String(s.utility_account_id)] : null);
 const provider = (acct && acct.provider) ? String(acct.provider).toLowerCase() : "";
 const arrName = ((ACC_ARRS || []).find(a => String(a.id) === String(s.array_id)) || {}).name;
 const label = acct ? utilityIdentity(acct)
 : (s.utility_account_name || arrName || "Ungrouped");
 groups[key] = { key, provider, providerLabel: provider ? provider.toUpperCase() : "Other",
 label, pctSum: 0, hasDraft: false, rows: [], shareMode: "meter" };
 order.push(key);
 }
 const g = groups[key];
 g.rows.push(s);
 // Each offtaker's share OF THE MASTER ARRAY: array_share_pct for a sub-metered
 // offtaker (its allocation_pct is 1.0 of its own bill), else allocation_pct.
 // A sub-metered member flips the group to the "share of the array" wording.
 if (s.array_share_pct != null) g.shareMode = "array";
 g.pctSum += Number(s.array_share_pct != null ? s.array_share_pct : s.allocation_pct) || 0;
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
 // each group header, the direct answer to "an indicator that shows me how all of
 // those offtakers add up to a hundred percent" (Ford). Hovering it reveals a
 // breakdown popover ("show me how it was calculated"): every offtaker's share,
 // listed, then summed. A small epsilon absorbs float/rounding noise from
 // percent-entry; real over/under-allocation still shows as a warning.
 function pctSumPill(group) {
 const pctNum = (group.pctSum || 0) * 100; // exact percent (number, for the logic below)
 const pct = pctNum.toFixed(2); // 2-decimal display string (Ford: .00, not 0)
 const within = Math.abs(pctNum - 100) <= 0.5;
 const over = !within && pctNum > 100; // REAL over-allocation, would double-bill
 const overBy = (pctNum - 100).toFixed(2); // how far past 100% (over case)
 const unassigned = (100 - pctNum).toFixed(2); // how far short of 100% (under case)
 // ~100% = fine; >100% = a genuine double-bill risk (loud warning, guard kept);
 // <100% = calm info note that some of the meter's excess is simply unassigned.
 const cls = over ? "rb-grp-pct-warn" : "rb-grp-pct-ok";
 let label, hint;
 if (within) {
 label = `✓ 100% allocated`;
 hint = "";
 } else if (over) {
 label = `⚠ ${pct}% allocated · would double-bill the meter's excess`;
 hint = `These shares add to ${overBy}% more than 100%, so part of the meter's excess would be billed to two offtakers at once. Lower a share so the total is 100%.`;
 } else {
 label = `ⓘ ${pct}% allocated`;
 hint = `${unassigned}% of this meter's excess is unassigned. That's fine if intended, or add/raise a share to reach 100%.`;
 }
 // Breakdown rows, each offtaker's share, biggest first so the math reads
 // top-down. Array-grouped fleets (own-meter shape) show array_share_pct —
 // the share of the ARRAY's excess, not the 1.0-of-own-bill multiplier.
 const rowPct = (s) => group.shareMode === "array"
 ? (s.array_share_pct != null ? s.array_share_pct : s.allocation_pct)
 : s.allocation_pct;
 const rows = (group.rows || []).slice().sort((a, b) =>
 (Number(rowPct(b)) || 0) - (Number(rowPct(a)) || 0));
 const rowHtml = rows.map(s => {
 const rp = rowPct(s);
 const p = rp != null ? (rp * 100).toFixed(2) : "0.00";
 return `<span class="rb-grp-pop-row"><span class="rb-grp-pop-who">${esc(s.customer_name || "(unnamed)")}</span><span class="rb-grp-pop-pct">${p}%</span></span>`;
 }).join("");
 const sumCls = over ? "rb-grp-pop-sum-warn" : "rb-grp-pop-sum-ok";
 const where = group.shareMode === "array" ? "in this array" : "on this utility bill";
 // The "% allocated" chip carries the number on its own; the little meter bar
 // was removed (Ford 2026-07-07), it cried wolf (orange for a fine 96%) and
 // just repeated the chip. Hover breakdown unchanged below.
 return `<span class="rb-grp-pctwrap">
 <span class="rb-grp-pct ${cls}" tabindex="0" aria-describedby="">${label}</span>
 <span class="rb-grp-pct-pop" role="tooltip">
 <span class="rb-grp-pop-title">How this adds up · ${rows.length} offtaker${rows.length === 1 ? "" : "s"} ${where}</span>
 ${rowHtml}
 <span class="rb-grp-pop-row rb-grp-pop-sum ${sumCls}"><span class="rb-grp-pop-who">Total allocated</span><span class="rb-grp-pop-pct">${pct}%</span></span>
 ${hint ? `<span class="rb-grp-pop-note">${esc(hint)}</span>` : ""}
 </span>
 </span>`;
 }

 // Render every offtaker as a collapsed accordion card, preserve which one is
 // open across refreshes, and auto-open the default (first awaiting approval) on
 // a fresh load. The expanded body is filled lazily by expandAccordion().
 let ACC_ARRS = []; // arrays cache for the open card's offtaker editor
 function renderAccordion(subs, arrs, utilAccts, drafts) {
 const list = $("#rbList");
 if (!list) return;
 parkTpl(); // move #rbTpl to its standalone home BEFORE wiping #rbList, else a box
 // currently folded into an open card is destroyed with the list and
 // never comes back (the "showed up then disappeared on reload" bug). The
 // re-expanded card re-folds it; if none re-opens it stays visible at home.
 ACC_ARRS = arrs || [];
 // Index the drafts (newest per offtaker) + build the dropdown-free OFFTAKERS list.
 _indexInbox(drafts || [], subs || []);
 // OFFTAKERS is reused as the canonical ordered offtaker list (drafts float to top).
 if (!OFFTAKERS.length) {
 list.innerHTML = `<div class="empty" style="padding:22px 0;color:var(--faint)">No offtakers yet. Click <b>＋ Add an offtaker</b> above, or drop a billing spreadsheet to create one.</div>`;
 return;
 }
 // Header copy: "N reports ready to review & send. Review before you send."
 const pending = OFFTAKERS.filter(s => DRAFT_BY_SUB[String(s.id)]).length;
 const headLine = pending
 ? `<b>${pending}</b> report${pending === 1 ? "" : "s"} ready to review &amp; send. Review before you send.`
 : `Select an offtaker to review and send.`;
 // Keep the currently-open card open across refreshes, but do NOT auto-open one on a
 // fresh load, every offtaker starts collapsed until the operator clicks one (Ford).
 const stillOpen = ACTIVE_SUB_ID && OFFTAKERS.some(s => String(s.id) === String(ACTIVE_SUB_ID));
 if (!stillOpen) ACTIVE_SUB_ID = null;
 // ── GMP vs non-GMP segmented filter (Piece 4) ──────────────────────────────
 // A filter strip over the ONE list, NOT a separate tab/page. Only shown when
 // the fleet actually mixes GMP-bill-bound offtakers with non-GMP ones (VEC/
 // SmartHub/unbound); a pure-GMP fleet never sees it. Scopes which offtakers
 // render; the existing utility → account → offtaker hierarchy still applies
 // within the scope.
 const bucketCounts = providerBucketCounts(OFFTAKERS, utilAccts);
 const showFilter = bucketCounts.gmp > 0 && bucketCounts.other > 0;
 if (!showFilter) OFFTAKER_FILTER = "all"; // no mix → the filter is meaningless
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
 // ── find-an-offtaker search ──────────────────────────────────────────────
 // Always available (Ford 2026-07-13: even a 3-offtaker fleet wants lookup
 // next to the All/GMP/Other strip, was gated to >12 and never appeared).
 // Match name / email / utility account # or nickname / array name.
 const acctByIdFull = new Map((utilAccts || []).map(a => {
 const id = a.utility_account_id != null ? a.utility_account_id : a.id;
 return [String(id), a];
 }));
 const arrNameById = new Map((arrs || ACC_ARRS || []).map(a => [String(a.id), a.name || ""]));
 const q = (OFFTAKER_QUERY || "").trim().toLowerCase();
 const matchesQuery = (s) => {
 if (!q) return true;
 const a = s.utility_account_id != null ? acctByIdFull.get(String(s.utility_account_id)) : null;
 const arrName = s.array_id != null ? arrNameById.get(String(s.array_id)) : "";
 return [s.customer_name, s.client_email, a && a.account_number, a && a.nickname,
 a && a.provider, arrName, s.utility_account_name]
 .some(v => v && String(v).toLowerCase().includes(q));
 };
 const viewRows = q ? scopeRows.filter(matchesQuery) : scopeRows;
 const showSearch = OFFTAKERS.length >= 1;
 // Full-width search above the filter chips (always on when any offtakers exist).
 // SVG icon (the old ⌕ glyph fell back to a hollow "o" on some fonts).
 const searchHTML = showSearch ? `
 <div class="rb-osearch rb-osearch-lg" role="search">
 <span class="rb-osearch-ico" aria-hidden="true">
 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
 stroke-linecap="round" stroke-linejoin="round">
 <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
 </svg>
 </span>
 <input id="rbOSearch" type="search" placeholder="Search offtakers by name, email, or account number…"
 value="${esc(OFFTAKER_QUERY)}" autocomplete="off" spellcheck="false"
 aria-label="Search offtakers">
 ${q
 ? `<span class="rb-osearch-n">${viewRows.length} of ${scopeRows.length}</span>`
 : `<span class="rb-osearch-hint">${OFFTAKERS.length} offtaker${OFFTAKERS.length === 1 ? "" : "s"}</span>`}
 </div>` : "";
 // Above 5 offtakers, build the three-level hierarchy (Ford): utility (provider) →
 // utility account → offtaker. Both upper levels collapse on a whole-header click and
 // both DEFAULT collapsed, so a fresh load of a big account shows just the provider
 // headers (GMP / VEC / WEC). Each utility-account header still carries the "do these
 // shares add up to 100%" pill with its hover breakdown.
 // An active SEARCH renders its matches FLAT, regrouping 12 matches under
 // wrapper headers (with pills computed off the filtered subset) is noise;
 // the operator asked for specific offtakers, show exactly those cards.
 const groups = q ? null : groupOfftakersByUtility(viewRows, utilAccts);
 // AUTO-EXPAND on load (Ford, 2026-07-10): a tree left collapsed at the bottom of the
 // page makes the operator hunt + click to see their own offtakers (the ≤5 threshold
 // missed a normal 11-offtaker fleet). Default OPEN for any normal-size fleet;
 // AUTO_EXPAND_MAX keeps the lazy-render escape hatch so a genuinely big fleet (800-
 // offtaker Anna shape) still paints ~2 headers, not ~800 cards.
 const AUTO_EXPAND_MAX = 40;
 const _smallFleet = !q && (viewRows || []).length <= AUTO_EXPAND_MAX;
 // Master net-meter groups get a subtle ALTERNATING background band, a 2-tone
 // zebra keyed off ROW POSITION, not the array id (Ford 2026-07-12: "remove the
 // different colors … use two or three colors in a consistent pattern, don't
 // switch between colors without reason"). The old per-array hashed rainbow
 // assigned 8 hues meaninglessly; position-parity banding separates adjacent
 // groups for the same at-a-glance scan with a consistent, reasoned pattern.
 // (Tone is computed at render from each group's index, see acctGroupHTML.)
 // Per-utility provider colour (Ford 2026-07-11): the provider bar used to be a
 // fixed emerald for everyone, "the VEC, that should be blue, not green. Green
 // Mountain Power is green … we need to be prepared for all of them." Known
 // utilities are pinned to a hue; any of the ~1,600 others gets a stable colour
 // hashed from its code, so every utility reads apart without a hand-picked entry.
 const PROV_HUE = { gmp: "#059669", vec: "#2563eb", wec: "#7c3aed", cvps: "#0891b2",
 gmcs: "#059669", bed: "#db2777", vppsa: "#d97706" };
 const PROV_PALETTE = ["#2563eb", "#7c3aed", "#0891b2", "#db2777", "#d97706",
 "#0d9488", "#4f46e5", "#c026d3"];
 const provHue = (code) => {
 const k = String(code || "").toLowerCase();
 if (PROV_HUE[k]) return PROV_HUE[k];
 let n = 0; for (const c of k) n = (n * 31 + c.charCodeAt(0)) >>> 0;
 return PROV_PALETTE[n % PROV_PALETTE.length];
 };
 // MIDDLE level, one utility-account group (its header + the offtaker cards under it).
 const acctGroupHTML = (g, _i) => {
 if (GROUP_COLLAPSED[g.key] === undefined) GROUP_COLLAPSED[g.key] = !_smallFleet; // small fleet → expanded
 const collapsed = !!GROUP_COLLAPSED[g.key];
 // "+ Add offtaker" on the master header → opens the add form with THIS master
 // net-meter group pre-picked, so another offtaker onto the same master is one
 // click (Ford 2026-07-10). Only for real array groups (the pre-pick is by array_id).
 const grpArrayId = g.key.startsWith("a:") ? g.key.slice(2) : "";
 const addBtn = grpArrayId
 ? `<button type="button" class="rb-grp-add" data-grpadd="${esc(grpArrayId)}"
 title="Add an offtaker to ${esc(g.label)}">＋ Add offtaker</button>`
 : "";
 // Always wrap every master in the floating group card (Ford 2026-07-14):
 // a 1-offtaker group (Timberworks) must look like a multi-offtaker one
 // (Waterford), same shell, same padding, same alternating zebra tone.
 const tinted = true;
 return `
 <div class="rb-grp rb-grp-tinted${collapsed ? " collapsed" : ""}" data-grp-tone="${_i % 2}">
 <div class="rb-grp-head" data-grpcollapse="${esc(g.key)}" role="button" tabindex="0"
 aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Collapse"} the offtakers ${g.shareMode === "array" ? "in this array" : "on this utility bill"}">
 <span class="rb-grp-caret" aria-hidden="true">▾</span>
 <span class="rb-grp-label">${esc(g.label)}</span>
 <span class="rb-grp-count">${g.rows.length} offtaker${g.rows.length === 1 ? "" : "s"}</span>
 ${addBtn}
 ${pctSumPill(g)}
 </div>
 <div class="rb-grp-rows"${collapsed ? " hidden" : ""}>
 ${collapsed ? "" : g.rows.map(s => subCard(s, arrs, utilAccts)).join("")}
 </div>
 </div>`;
 };
 let body;
 if (groups) {
 const providers = groupByProvider(groups);
 // LAZY RENDER (perf, Ford 2026-07-07): a collapsed group/provider omits its
 // offtaker cards from the DOM entirely, at 800 offtakers that's the difference
 // between painting ~2 provider headers and ~800 cards on load (both default
 // collapsed). The OPEN card must still render, so force-open the group +
 // provider that hold ACTIVE_SUB_ID before we build the body.
 if (ACTIVE_SUB_ID != null) {
 for (const pv of providers) {
 for (const g of (pv.groups || [])) {
 if ((g.rows || []).some(s => String(s.id) === String(ACTIVE_SUB_ID))) {
 GROUP_COLLAPSED[g.key] = false;
 PROVIDER_COLLAPSED[pv.key] = false;
 }
 }
 }
 }
 body = providers.map(pv => {
 // Provider opens for a small fleet OR whenever there is a lone provider with a
 // modest number of accounts, a single collapsed GMP header is pure indirection,
 // and opening it only paints account-group headers (cards under still honor
 // GROUP_COLLAPSED). Bounded by group count so an 800-offtaker fleet stays collapsed.
 const _loneProvider = providers.length === 1 && pv.groups.length <= AUTO_EXPAND_MAX;
 if (PROVIDER_COLLAPSED[pv.key] === undefined) PROVIDER_COLLAPSED[pv.key] = !(_smallFleet || _loneProvider); // small OR lone-modest provider → expanded
 const pCollapsed = !!PROVIDER_COLLAPSED[pv.key];
 const nAcct = pv.groups.length;
 // Array-grouped fleets (own-meter shape): the middle level is arrays,
 // not utility accounts, say so.
 const grpNoun = pv.groups.length && pv.groups.every(g => g.shareMode === "array")
 ? `array${nAcct === 1 ? "" : "s"}`
 : `utility account${nAcct === 1 ? "" : "s"}`;
 // Redesign: sent-this-period progress + flagged count on the provider
 // header, exact period compare against the pipeline's last period.
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
 style="border-left-color:${provHue(pv.provider)}"
 aria-expanded="${!pCollapsed}" title="${pCollapsed ? "Expand" : "Collapse"} all ${esc(pv.providerLabel)} utility accounts">
 <span class="rb-prov-caret" aria-hidden="true">▾</span>
 <span class="rb-prov-label">${esc(pv.providerLabel)}</span>
 <span class="rb-prov-count">${nAcct} ${grpNoun} · ${pv.offtakerCount} offtaker${pv.offtakerCount === 1 ? "" : "s"}</span>
 <span class="rb2-provsp"></span>${provFlag}${provBar}
 </div>
 <div class="rb-prov-rows"${pCollapsed ? " hidden" : ""}>
 ${pCollapsed ? "" : pv.groups.map(acctGroupHTML).join("")}
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
 // Search on its own full-width row first, then filter chips underneath —
 // the search is the primary lookup tool and shouldn't share a cramped row.
 const toolsHTML = (filterStripHTML || searchHTML)
 ? `<div class="rb-listtools${searchHTML ? " rb-listtools-searchfirst" : ""}">${searchHTML}${filterStripHTML}</div>`
 : "";
 list.innerHTML = `<div class="rb-acc-lead">${headLine}` +
 `<span class="rb-bac-summary" id="rbBacSummary">${bacSummaryHTML()}</span></div>` + toolsHTML + body;
 wireBacChip($("#rbBacSummary"));
 renderKpis(); // the KPI band tracks the freshly-rendered list's counts
 // Wire the GMP-vs-non-GMP filter chips, flip the scope + re-render in place.
 list.querySelectorAll("[data-ofilter]").forEach(b => b.onclick = () => {
 OFFTAKER_FILTER = b.getAttribute("data-ofilter") || "all";
 renderAccordion(subs, arrs, utilAccts, drafts);
 });
 // Wire the search box, debounced re-render; the innerHTML swap drops focus,
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
 se.onsearch = apply; // the native ✕ clear control on type=search
 }
 wireAccordionHeaders(list);
 // TOP level, provider collapse (GMP / VEC / WEC). Whole header clickable, keyboard-OK.
 // (.rb-prov-head and .rb-grp-head are siblings' children, not nested, so the two
 // collapse levels never trigger each other.)
 // Collapsing an ancestor that holds the currently-open offtaker card must
 // actually release it, otherwise the "keep the active card visible" force-open
 // above (ACTIVE_SUB_ID != null) immediately re-expands this same group/provider
 // on the render this click triggers, and the collapse click looks like it does
 // nothing (Ford 2026-07-12: "you cannot collapse up to the GMP" while an
 // offtaker below it is expanded). Detected via the DOM (not the `providers`
 // structure, which is out of scope here): if the header's own container still
 // holds the active card at click-time, this collapse is about to hide it.
 const releaseActiveIfInside = (container) => {
 if (ACTIVE_SUB_ID == null || !container) return;
 if (container.querySelector(`.rb-acc[data-id="${CSS.escape(String(ACTIVE_SUB_ID))}"]`)) {
 parkTpl();
 ACTIVE_SUB_ID = null;
 }
 };
 list.querySelectorAll("[data-provcollapse]").forEach(h => {
 const go = () => {
 const k = h.getAttribute("data-provcollapse");
 const collapsing = !PROVIDER_COLLAPSED[k];
 if (collapsing) releaseActiveIfInside(h.closest(".rb-prov"));
 PROVIDER_COLLAPSED[k] = collapsing;
 renderAccordion(subs, arrs, utilAccts, drafts);
 };
 h.onclick = go;
 h.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
 });
 // MIDDLE level, utility-account collapse. The pill's hover-breakdown still works
 // (the pill wrapper stops propagation below so reading it never also collapses).
 list.querySelectorAll("[data-grpcollapse]").forEach(h => {
 const go = () => {
 const k = h.getAttribute("data-grpcollapse");
 const collapsing = !GROUP_COLLAPSED[k];
 if (collapsing) releaseActiveIfInside(h.closest(".rb-grp"));
 GROUP_COLLAPSED[k] = collapsing;
 renderAccordion(subs, arrs, utilAccts, drafts);
 };
 h.onclick = go;
 h.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
 });
 // The allocation pill is an info affordance (hover shows the breakdown), clicking
 // it should NOT also collapse the group it sits inside.
 list.querySelectorAll(".rb-grp-pctwrap").forEach(p => p.addEventListener("click", e => e.stopPropagation()));
 // "+ Add offtaker" on a master header → open the add form pre-set to that master.
 // stopPropagation so the click doesn't also collapse/expand the group.
 list.querySelectorAll("[data-grpadd]").forEach(b => b.onclick = (e) => {
 e.stopPropagation();
 openAddOfftakerForMaster(b.getAttribute("data-grpadd"));
 });
 // Per-offtaker delete (🗑 on the header). stopPropagation so the click deletes
 // instead of toggling the card open.
 list.querySelectorAll("[data-del-offtaker]").forEach(b => b.onclick = (e) => {
 e.stopPropagation();
 deleteOfftaker(b.getAttribute("data-del-offtaker"));
 });
 // Open the default card inline.
 if (ACTIVE_SUB_ID != null) expandAccordion(ACTIVE_SUB_ID, { silent: true });
 maybeDeepLink(); // a "Review & send" email's ?draft=<id> → open that exact card
 }

 // ── Deep-link from a "Review & send" email ─────────────────────────────────
 // The email links to /?draft=<subscription id>#reports. On arrival we open that
 // offtaker's review card, expanding any collapsed provider/array groups above
 // it, then scroll to and flash it, so the operator lands squarely on the
 // invoice the email was about instead of the whole list. Runs once per load;
 // the param is scrubbed so a refresh or a re-render never re-triggers it.
 let _deepLinkDone = false;
 function _cssq(s) {
 return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
 }
 function maybeDeepLink() {
 if (_deepLinkDone) return;
 _deepLinkDone = true;
 let id = null, review = null;
 try {
 const p = new URLSearchParams(location.search);
 id = p.get("draft"); review = p.get("review");
 } catch (_) { }
 if (!id && !review) return;
 try {
 const u = new URL(location.href);
 u.searchParams.delete("draft"); u.searchParams.delete("review");
 history.replaceState({}, "", u.pathname + (u.search || "") + u.hash);
 } catch (_) { }
 if (id) { setTimeout(() => deepLinkOpen(String(id), 25), 120); return; }
 // A batch digest ("?review=1", many offtakers ready): scroll to the offtaker
 // list so the operator lands on the review queue, not the top of the page.
 setTimeout(() => {
 const el = document.getElementById("rbList") || document.querySelector(".rb2-listwrap");
 if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
 }, 420);
 }
 function deepLinkOpen(subId, tries) {
 const list = document.getElementById("rbList");
 const acc = list && list.querySelector('.rb-acc[data-id="' + _cssq(subId) + '"]');
 if (!acc) { if (tries > 0) setTimeout(() => deepLinkOpen(subId, tries - 1), 200); return; }
 // Expand collapsed ancestors first (each click re-renders the list, so we
 // re-enter to continue once the DOM settles).
 const prov = acc.closest(".rb-prov");
 const provHead = prov && prov.querySelector('.rb-prov-head[aria-expanded="false"]');
 if (provHead) { provHead.click(); setTimeout(() => deepLinkOpen(subId, tries - 1), 130); return; }
 const grp = acc.closest(".rb-grp");
 const grpHead = grp && grp.querySelector('.rb-grp-head[aria-expanded="false"]');
 if (grpHead) { grpHead.click(); setTimeout(() => deepLinkOpen(subId, tries - 1), 130); return; }
 // Ancestors open (or a flat list). Open the offtaker's review card in place.
 if (acc.getAttribute("data-open") !== "true") {
 const head = acc.querySelector(".rb-acc-head");
 if (head) head.click();
 }
 setTimeout(() => {
 const a = document.querySelector('.rb-acc[data-id="' + _cssq(subId) + '"]');
 if (!a) return;
 a.scrollIntoView({ behavior: "smooth", block: "center" });
 a.classList.add("rb-acc-flash");
 setTimeout(() => a.classList.remove("rb-acc-flash"), 2600);
 }, 340);
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
 const ok = await AODialog.confirm("This can't be undone.", { title: `Delete ${name} and their invoice schedule?`, danger: true, confirmLabel: "Delete" });
 if (!ok) return;
 try {
 const r = await fetch(API + "/subscriptions/" + id, { method: "DELETE", headers: authHeaders() });
 if (!r.ok) { await AODialog.alert("HTTP " + r.status + ".", { title: "Couldn't delete the offtaker" }); return; }
 if (String(ACTIVE_SUB_ID) === String(id)) ACTIVE_SUB_ID = null;
 await refreshList();
 } catch (e) {
 await AODialog.alert("The offtaker wasn't deleted. Try again.", { title: "Network error" });
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
 // offtaker editor, attachments, Approve & send), built lazily into .rb-acc-body
 // by expandAccordion() so it reuses the exact live draft pieces. Clicking the
 // header toggles; expanding one collapses the rest (one open at a time).
 // The offtaker's ONE share as a FRACTION (or null). For an own-meter (sub-metered)
 // offtaker the share lives in array_share_pct, their share of the net-metering
 // GROUP's excess, while allocation_pct is pinned to 1.0 (100% of their own
 // sub-meter) and would display a meaningless "100%". Percent-of-array offtakers
 // have no array_share_pct, so this falls back to allocation_pct (their share of
 // the host meter). Mirrors the backend's reconcile_bills `array_share_pct or
 // allocation_pct` and the existing pill logic, one number, one meaning.
 function offtakerShareFrac(x) {
 return (x && x.array_share_pct != null) ? x.array_share_pct
 : (x && x.allocation_pct != null) ? x.allocation_pct : null;
 }

 // The (array total, share, billed kWh) TRIPLE a draft display shows, on ONE
 // honest basis (Ford 2026-07-10: the offtaker's OWN bill governs the invoice;
 // the entered share is the audit's expectation). When the own bill billed and
 // the group pool resolved, the % is DERIVED from the bills, own-bill excess ÷
 // the group's host pool, and the total is the GROUP pool, so total × share =
 // billed EXACTLY. Fallback (topology B / no group data / list payloads without
 // the meta): the stored figures + the entered share, exactly as before.
 function draftDisplayTriple(d) {
 if (d && d.billing_basis === "gmp_credited" && d.derived_share_pct != null
 && d.array_group_excess_kwh != null) {
 return { total: d.array_group_excess_kwh, share: d.derived_share_pct, fromBill: true };
 }
 return { total: d ? d.array_total_kwh : null,
 share: offtakerShareFrac(d), fromBill: false };
 }

 function subCard(s, arrs, utilAccts) {
 const prev = s.preview || {};
 const next = s.next_send_at ? new Date(s.next_send_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
 const last = s.last_sent_at ? new Date(s.last_sent_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never";
 const fmts = (s.formats || []).map(f => f.toUpperCase()).join(" + ");
 // ── one plain-English sentence, built from the offtaker's actual choices. ──
 const _arrName = ((arrs || []).find(a => String(a.id) === String(s.array_id)) || {}).name;
 // A sub-metered offtaker's share is OF the net-meter GROUP, so the subject is
 // the ARRAY, not their own sub-account (they receive ~100% of that). Naming
 // the sub-account would read "4.6% of <their own meter>'s generation", which is
 // the phantom-100% confusion. Percent-of-array offtakers name their host meter.
 const srcName = (s.array_share_pct != null)
 ? (_arrName || "the array")
 : (s.utility_account_name || _arrName || "the array");
 const pctTxt = offtakerShareFrac(s) != null ? (offtakerShareFrac(s) * 100).toFixed(2) + "%" : "a share";
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
 + esc(srcName) + "</b>'s generation. <b>" + cadTxt + "</b> " + esc(fmts) + ", " + deliveryTxt + ".";
 // Whether a draft is queued for this offtaker (Ready) drives the header pill.
 const draft = DRAFT_BY_SUB[String(s.id)];
 const readyPill = draft
 ? `<span class="rb-chip rb-chip-ready">${draft.amount_usd != null ? money(draft.amount_usd) + " ready" : "Ready"}</span>`
 : "";
 // V2 offtaker pay-link status (from /payments). Most-recent open/paid chip.
 const pay = (typeof PAY_BY_SUB !== "undefined" && PAY_BY_SUB[String(s.id)]) || null;
 let payPill = "";
 if (pay && pay.status === "paid") {
 payPill = `<span class="rb-chip rb-chip-live" title="Offtaker paid online">Paid online${pay.amount_usd != null ? " · " + money(pay.amount_usd) : ""}</span>`;
 } else if (pay && pay.status === "open" && pay.pay_url) {
 payPill = `<span class="rb-chip" title="Invoice includes a Stripe pay link">Pay link open</span>`;
 }
 // Status-first: one leading dot summarizes this offtaker's state so the list
 // scans top-to-bottom at a glance — needs-action (ready) first, then paused,
 // sent, or idle. Reuses the .rb-sec-dot halo language already in the card.
 let statusCls, statusLabel;
 if (!s.enabled) { statusCls = "paused"; statusLabel = "Paused"; }
 else if (draft) { statusCls = "ready"; statusLabel = draft.amount_usd != null ? money(draft.amount_usd) + " ready to review" : "Report ready to review"; }
 else if (s.last_sent_at) { statusCls = "sent"; statusLabel = "Sent · last " + last; }
 else { statusCls = "idle"; statusLabel = "No report sent yet"; }
 const statusDot = `<span class="rb-acc-dot rb-acc-dot-${statusCls}" title="${esc(statusLabel)}" aria-label="${esc(statusLabel)}"></span>`;
 return `
 <div class="rb-acc ${s.enabled ? "" : "rb-paused"}" data-id="${s.id}" data-open="false">
 <div class="rb-acc-head" role="button" tabindex="0" aria-expanded="false"
 aria-controls="rbAccBody-${s.id}" data-acchead="${s.id}">
 <span class="rb-acc-caret" aria-hidden="true">▸</span>
 <div class="rb-acc-head-main">
 <div class="rb-acc-name">${statusDot}${esc(s.customer_name)}
 ${readyPill}${payPill}
 <span class="rb-chip ${s.delivery_mode === "auto" ? "rb-chip-live" : ""}">${s.delivery_mode === "auto" ? "Auto-send" : "Draft for approval"}</span>
 ${s.enabled ? "" : `<span class="rb-chip rb-chip-off">Paused</span>`}
 </div>
 <div class="rb-acc-sentence">${sentence}</div>
 ${s.template_fit_warning ? `<div class="rb-acc-warn" role="alert" title="${esc(s.template_fit_warning)}">\u26a0 ${esc(s.template_fit_warning)}</div>` : ""}
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
 let INBOX_UTIL_ACCTS = []; // cached so the offtaker dropdown can re-render without a refetch
 // The offtaker dropdown lists ALL the operator's offtakers (not just the ones the
 // scheduler already drafted), so they can swap to ANY of them. Selecting one shows
 // its pending draft if it has one, else mints one on demand (idempotent generate).
 let OFFTAKERS = []; // enabled subscriptions (+ any with a pending draft) = dropdown rows
 let OFFTAKER_FILTER = "all"; // "all" | "gmp" | "other", GMP-vs-non-GMP list scope (Piece 4).
 // A segmented strip over the ONE list (not a separate tab/page):
 // Bruce framed GMP-vs-other as "tabs", but Ford's rule is integrate-
 // in-place, so it's a filter that scopes which offtakers render.
 // Only shown when the fleet has BOTH GMP and non-GMP offtakers.
 let OFFTAKER_QUERY = ""; // find-an-offtaker search (Anna-scale fleets: at 800 offtakers,
 // scrolling collapsed groups is not a lookup tool). Filters by
 // name / email / utility-account; an active query force-expands
 // the provider→account hierarchy so matches surface in place.
 let DRAFT_BY_SUB = {}; // subscription_id -> its pending draft (refs INTO INBOX_DRAFTS)
 // V2 offtaker pay-links: subscription_id -> most recent OfftakerPayment
 // (open pay link or paid online). Populated by loadOfftakerPayments().
 let PAY_BY_SUB = {};
 let ACTIVE_SUB_ID = null; // the offtaker under review, the billing basis for the view
 let SEC_OPEN = {}; // collapsible-section title -> open bool. Persists which sections
 // the operator has open ACROSS body re-renders (poll / recompute /
 // period+version change) so nothing collapses under them mid-edit —
 // "no shifting ground" (Ford 2026-07-10). Keyed by section title.
 let GROUP_COLLAPSED = {}; // utility-account group key -> bool; collapses every offtaker
 // card under one utility bill at once. DEFAULTS to collapsed
 // (each first-seen group key inits to true in renderAccordion).
 // Persists across refreshes (module-level, keyed by stable
 // utility_account_id), un-persisted across reloads, so a fresh
 // load always opens fully collapsed. Same map as vendor-sheet.
 let PROVIDER_COLLAPSED = {}; // provider bucket key ("prov:gmp") -> bool; the TOP level of the
 // utility → utility-account → offtaker hierarchy. Same default-
 // collapsed + persist-across-refreshes / reset-on-reload rules.
 let GENERATING_SUB_ID = null; // the offtaker whose draft is being minted right now (loading state)
 let GEN_FAIL = {}; // subscription_id -> why its on-demand draft couldn't be built
 let _pinActiveSub = false; // keep refreshInbox from auto-advancing off a just-selected offtaker
 // The operator's invoice template ({enabled, html}), when enabled, the live
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
 // Offtaker-facing {{rate}} token: the bill-DERIVED share when their own bill
 // billed (Ford 2026-07-10, the % comes from the bills), else the entered one.
 const _trip = draftDisplayTriple(d);
 const pct = _trip.share != null ? Math.round(_trip.share * 1000) / 10 : null;
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

 // True if draft a is NEWER than b, by billing period, then created_at, then id.
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
 // deleted) still needs a selectable row, synthesize one from the draft.
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
 // rather than the visible home, else it flashes to the top of the page and back on
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
 VIEWING_VERSION_ID = null; // always open on the latest version
 card.setAttribute("data-open", "true");
 const head = card.querySelector("[data-acchead]");
 if (head) head.setAttribute("aria-expanded", "true");
 const body = card.querySelector("[data-accbody]");
 if (body) body.hidden = false;
 renderAccordionBody(sid);
 // The cached draft renders instantly; then recompute from the LIVE bill so the email
 // cover + invoice PDF agree (a draft frozen before newer generation/a new bill landed
 // otherwise shows a stale amount next to the fresh invoice, Ford 2026-07-09).
 refreshDraftOnOpen(sid);
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
 parkTpl(); // protect the wired template box before wiping the body
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
 // the SAME draft pipeline the old approval inbox used, draftCard/calcDashboard/
 // reviewActions/renderDraftDoc, just hosted inside the accordion card.
 function renderAccordionBody(sid) {
 sid = String(sid);
 const card = document.querySelector(`.rb-acc[data-id="${sid}"]`);
 if (!card) return;
 const wrap = card.querySelector("[data-accbody]");
 if (!wrap) return;
 stashTpl(); // hide-stash the wired box before the wipe (no flash to the top)
 const activeOf = OFFTAKERS.find(s => String(s.id) === sid) || { id: sid };
 const active = activeDraft(); // reads ACTIVE_SUB_ID / VIEWING_VERSION_ID

 // The form column: the real draft card | a loading card | a graceful empty state.
 let bodyCol;
 if (String(GENERATING_SUB_ID) === sid) {
 bodyCol = `<div class="rb-draft rb-draft-loading"><div class="rb-spin"></div>
 <p>Drafting ${esc(activeOf.customer_name || "this offtaker")}'s latest period…</p></div>`;
 } else if (active) {
 bodyCol = draftCard(active, INBOX_UTIL_ACCTS);
 } else {
 const why = GEN_FAIL[sid]
 || "No billable period yet for this offtaker, its report appears here once a GMP bill lands.";
 bodyCol = `<div class="rb-draft rb-draft-empty">
 <div class="rb-draft-top"><div class="rb-draft-name">${esc(activeOf.customer_name || "Offtaker")}</div></div>
 <p class="rb-empty-why">${esc(why)}</p>
 <p class="rb-empty-auto">⚡ Drafts automatically the moment its bill lands, nothing to click.</p>
 </div>`;
 }

 wrap.innerHTML = `
 <div class="rb-acc-inner">
 <div class="rb-pickrow">${periodDraftHTML(sid)}${verPickerHTML(sid)}</div>
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
 // to the accordion. (Capture isn't needed, the header listener is on the header
 // element, not an ancestor of the body, but this guards future nesting + the
 // version picker that sits at the top of the body.)
 wrap.querySelectorAll("[data-dact]").forEach(b => b.onclick = onDraftAction);
 // Version history: fetch older drafts (once), wire the dropdown; older = read-only.
 _ensureVersions(sid);
 const _vp = wrap.querySelector("#rbVerPick");
 if (_vp) _vp.onchange = () => { VIEWING_VERSION_ID = _vp.value || null; renderAccordionBody(sid); };
 // Billing-period picker: fetch this offtaker's billable periods (once), wire the
 // dropdown so choosing one drafts that specific cycle (Bruce 2026-07-07, C4).
 _ensurePeriods(sid);
 const _pp = wrap.querySelector("#rbPeriodDraft");
 if (_pp) _pp.onchange = () => draftForPeriod(sid, _pp.value);
 if (VIEWING_VERSION_ID != null) {
 const form = wrap.querySelector(".rb-col-form");
 if (form) { const b = document.createElement("div"); b.className = "rb-ver-banner";
 b.textContent = "Viewing an older version (read-only), select “· latest” to edit or send."; form.insertBefore(b, form.firstChild); }
 }
 // Live preview + review header (actions + calc dashboard).
 renderDraftDoc();
 renderReviewTop();
 wireCalcLinks(wrap); // calc dashboard now lives in the form column
 // Remember which collapsible sections the operator has open, so the NEXT rebuild of
 // this body (a background poll, a recompute, a period/version switch) restores them
 // instead of collapsing everything, the "shifting ground" Ford flagged. Fresh
 // elements each render → no duplicate listeners.
 wrap.querySelectorAll("details[data-seckey]").forEach(dt =>
 dt.addEventListener("toggle", () => { SEC_OPEN[dt.getAttribute("data-seckey")] = dt.open; }));
 wrap.querySelectorAll("textarea[data-draftmsg]").forEach(ta => {
 autoGrowMsg(ta);
 const did = ta.getAttribute("data-draftmsg");
 const focusDraft = () => { ACTIVE_DRAFT_ID = did; renderDraftDoc(); };
 // The cover email AUTO-SAVES as you type (debounced 700ms), no Save button.
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
 wireResync(sid); // stale utility bill → hands-off background re-sync + one-click regenerate
 // Load THIS offtaker's own generation spreadsheet card (self-hides if the
 // feature flag is off). The operator-wide master sheet loads once at page top.
 wrap.querySelectorAll(".rb-track-sub").forEach(loadTrackerInto);
 // Consolidate: drop the (already-wired) invoice-template box at the bottom of
 // the open card so the page reads as one element.
 foldTplIntoInbox(wrap.querySelector(".rb-acc-inner"));
 }

 // Switch the whole approval section to a chosen offtaker. If they already have a
 // pending draft, show it instantly; otherwise mint one on demand (idempotent, the
 // backend reuses/refreshes the period's draft) and refetch so it carries its live
 // Silently re-pull the latest GMP bill + recompute this offtaker's draft (the backend
 // /draft endpoint pulls the bound account fresh before computing), then refresh the
 // inbox so the figures update in place. Best-effort + debounced ≤1/min per offtaker so
 // browsing never stacks pulls; on any failure the cached draft stands (no error shown).
 const _bgRefreshed = {}; // subId -> last bg-refresh ms
 async function backgroundRefreshDraft(subId) {
 subId = String(subId);
 if (!authHeaders()) return; // demo / signed-out
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
 // The generation-time cross-check rides every /draft response, record it and
 // repaint the strip in place BEFORE the figures-changed short-circuit below
 // (the strip must fill in even when the draft numbers themselves didn't move).
 noteXcheck(subId, dg);
 // Update the figures IN PLACE, and ONLY if this offtaker is still open on its LATEST
 // version AND a figure actually changed. The usual case (the GMP bill hasn't moved) is
 // a no-op that touches NOTHING, so the page never silently rebuilds under the operator.
 // (Was: an unconditional refreshInbox() that wiped + rebuilt the whole accordion a few
 // seconds after every open, the "random refresh / jitter / reload" Ford reported.)
 if (!dg || !dg.draft || VIEWING_VERSION_ID != null || String(ACTIVE_SUB_ID) !== subId) return;
 const d = activeDraft();
 if (!d) return;
 const keys = ["array_total_kwh", "allocation_pct", "customer_kwh", "amount_usd",
 "invoice_number", "period_label", "budget_amount_usd", "solar_credit_value",
 "net_rate_per_kwh", "discount_pct", "has_gmp_pdf", "gmp_auto_status",
 // The honest default-rate provenance (bill vs banked reference) the list
 // payload lacks, merge it so the editable rate field shows the true default.
 "default_net_rate_per_kwh", "default_net_rate_source", "default_net_rate_note",
 "resolved_net_rate_per_kwh", "resolved_net_rate_source",
 // The server re-renders the email LETTER + SUBJECT with the fresh figures on
 // every /draft response; merge them so the live preview's letter (kWh + $)
 // tracks a re-sync/new bill instead of showing the old amount until a hard
 // refresh (Ford 2026-07-07: "not live updating, requires a refresh").
 "email_letter_default", "email_subject_default"];
 const changed = keys.some(k => (k in dg.draft) && dg.draft[k] !== d[k]);
 if (!changed) return; // nothing new → no repaint, no jitter
 keys.forEach(k => { if (k in dg.draft) d[k] = dg.draft[k]; });
 const card = document.querySelector(`.rb-acc[data-id="${subId}"] .rb-draft[data-did="${d.id}"]`);
 applyDraftFigures(card, d); // calc + preview only, never a list rebuild
 const pill = document.querySelector(`.rb-acc[data-id="${subId}"] .rb-chip-ready`);
 if (pill && d.amount_usd != null) pill.textContent = money(d.amount_usd) + " ready";
 }

 // On OPEN, recompute the draft from the LIVE build_match: POST /draft persists the
 // fresh figures AND re-renders the email letter, then we re-render the WHOLE body so
 // the approval-inbox email cover and the attached invoice PDF are both built from one
 // current computation. Without this a pending draft created BEFORE more generation (or
 // a new bill) landed stayed frozen, Glover's email showed $24.05 / 121 kWh while the
 // live invoice PDF showed $32.49 / 164 kWh (Ford 2026-07-09). backgroundRefreshDraft's
 // surgical applyDraftFigures updated the calc grid but NOT the email pane, and only ran
 // for the cached-draft path, so the visible letter stayed stale. A full re-render is
 // safe on a fresh open (nothing is mid-edit); the throttled surgical refresh still
 // handles later in-place updates without clobbering a half-typed note/rate.
 async function refreshDraftOnOpen(sid) {
 sid = String(sid);
 if (!authHeaders() || VIEWING_VERSION_ID != null) return; // demo / version look-back: nothing to recompute
 let dg;
 try {
 const r = await fetch(API + "/subscriptions/" + sid + "/draft", { method: "POST", headers: authHeaders() });
 if (!r.ok) return;
 dg = await r.json().catch(() => ({}));
 } catch (_) { return; }
 if (!dg || !dg.draft) return;
 if (String(ACTIVE_SUB_ID) !== sid || VIEWING_VERSION_ID != null) return; // operator moved on mid-fetch
 noteXcheck(sid, dg);
 _bgRefreshed[sid] = Date.now(); // counts as the recent surgical refresh too
 const cur = DRAFT_BY_SUB[sid];
 const figKeys = ["amount_usd", "customer_kwh", "array_total_kwh", "period_label",
 "invoice_number", "email_letter_default", "email_subject_default", "solar_credit_value",
 "net_rate_per_kwh", "discount_pct", "gmp_auto_status", "has_gmp_pdf"];
 const changed = !cur || figKeys.some(k => (k in dg.draft) && dg.draft[k] !== cur[k]);
 if (cur) Object.assign(cur, dg.draft); else DRAFT_BY_SUB[sid] = dg.draft;
 // Re-render ONLY when something actually moved (no jitter on the common fresh case).
 if (changed && String(ACTIVE_SUB_ID) === sid) renderAccordionBody(sid);
 }

 // envelope fields. `force` re-mints even when a draft already exists.
 async function selectOfftaker(subId, force) {
 subId = String(subId);
 VIEWING_VERSION_ID = null; // a new offtaker always opens on its LATEST version
 _verFetched.delete(subId); // re-fetch versions in case a new period landed
 _periodsFetched.delete(subId); // re-fetch billable periods in case a new bill landed
 if (DRAFT_BY_SUB[subId] && !force) {
 ACTIVE_SUB_ID = subId; ACTIVE_DRAFT_ID = DRAFT_BY_SUB[subId].id; renderInboxBody();
 // Show the cached draft instantly, then recompute from the LIVE bill so the email
 // cover + invoice PDF are built from one current computation (re-renders the pane
 // in place only if a figure actually moved, no jitter otherwise).
 refreshDraftOnOpen(subId);
 return;
 }
 // Signed-out DEMO: never mint via the backend (it would 401). Just switch to the
 // offtaker; ones without a pre-built draft show the graceful empty state.
 if (!authHeaders() && window.AO_DEMO) {
 ACTIVE_SUB_ID = subId;
 GEN_FAIL[subId] = "This sample offtaker is set to auto-send, its invoice is delivered automatically each period. Sign in to set up your own.";
 renderInboxBody();
 return;
 }
 ACTIVE_SUB_ID = subId;
 delete GEN_FAIL[subId];
 GENERATING_SUB_ID = subId;
 _pinActiveSub = true;
 renderInboxBody(); // show the loading card for this offtaker
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/draft",
 { method: "POST", headers: authHeaders() });
 if (!r.ok) {
 const e = await r.json().catch(() => ({}));
 GEN_FAIL[subId] = (e && e.detail) ? e.detail
 : "No billable period yet for this offtaker, its report appears here once a GMP bill lands.";
 } else {
 // Record the generation-time cross-check before the inbox re-render below,
 // so the freshly-minted card paints its verdict strip on first draw.
 noteXcheck(subId, await r.json().catch(() => ({})));
 }
 } catch (e) { GEN_FAIL[subId] = "Couldn't reach the server, try again."; }
 GENERATING_SUB_ID = null;
 _pinActiveSub = true; // stay on this offtaker through the refetch
 await refreshInbox(); // refetch → DRAFT_BY_SUB updated → renders the draft or empty state
 }

 // Attach a GMP bill PDF to a draft by hand, the operator's fallback for when
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
 // NOTE: don't set Content-Type, the browser adds the multipart boundary.
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
 renderInboxBody(); // chip flips to "✓ attached"; the live preview now shows the GMP bill
 } catch (e) { setStat("rb-err", "Network error, try again."); inp.value = ""; }
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
 setStat("rb-ok", "✓ Read " + kwh + rt + ", recomputing the invoice…");
 // The new settled bill changes the math, regenerate this offtaker's draft.
 if (sid != null && sid !== "" && typeof selectOfftaker === "function") {
 selectOfftaker(String(sid), true);
 }
 } catch (e) { setStat("rb-err", "Network error, try again."); inp.value = ""; }
 }

 // ── Invoice version history (older drafts per offtaker) ──────────────────────
 let VIEWING_VERSION_ID = null; // a draft id when reviewing an OLDER version; null = latest
 const VERSIONS_BY_SUB = {}; // subId -> [draft versions, latest first]
 const _verFetched = new Set(); // subIds whose versions we've fetched this view
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
 // The version dropdown beside the offtaker picker, only when >1 version exists.
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

 // ── Draft a different billing period (Bruce 2026-07-07, C4) ──────────────────
 // The version picker looks BACK at periods already drafted; this picks which
 // billing cycle to draft NEXT. The card auto-drafts the latest bill; Bruce
 // wanted to choose an earlier settled period instead of always the latest.
 // Fed by GET /bill-periods (every billable period); drafting a chosen period
 // mints/refreshes its draft, which then also shows in the version picker.
 const PERIODS_BY_SUB = {}; // subId -> [{label, pretty, is_latest}]
 const _periodsFetched = new Set(); // subIds whose periods we've fetched this view
 async function _ensurePeriods(subId) {
 subId = String(subId);
 if (!subId || !authHeaders() || _periodsFetched.has(subId)) return;
 _periodsFetched.add(subId);
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/bill-periods", { headers: authHeaders() });
 if (!r.ok) return;
 const j = await r.json();
 PERIODS_BY_SUB[subId] = j.periods || [];
 // Repaint so the control appears once its options are known (>1 period to choose).
 if (String(ACTIVE_SUB_ID) === subId && PERIODS_BY_SUB[subId].length > 1) renderInboxBody();
 } catch (_) {}
 }
 // The "Draft another period" control, only when the offtaker has >1 billable
 // period (otherwise the auto-drafted latest is the only choice). The currently
 // drafted period is preselected so it reads as "which cycle am I invoicing".
 function periodDraftHTML(subId) {
 const ps = PERIODS_BY_SUB[String(subId)] || [];
 if (ps.length < 2) return "";
 // Which period does the live (latest) draft already cover? Match its
 // period_label ("YYYY-MM-DD → YYYY-MM-DD") to a month/quarter option.
 const cur = DRAFT_BY_SUB[String(subId)];
 const curLbl = cur && cur.period_label ? String(cur.period_label) : "";
 const opts = ps.map(p => {
 // A YYYY-MM option matches when the drafted end-date's month equals it.
 const m = curLbl.match(/(\d{4})-(\d{2})-\d{2}\s*(?:→|->)\s*(\d{4})-(\d{2})-\d{2}/);
 const endYM = m ? `${m[3]}-${m[4]}` : "";
 const sel = (endYM && endYM === p.label) ? " selected" : "";
 return `<option value="${esc(p.label)}"${sel}>${esc(p.pretty)}${p.is_latest ? " · latest" : ""}</option>`;
 }).join("");
 return `<label class="rb-ver-lab" title="Draft the invoice for a specific billing cycle. Defaults to the latest settled bill, pick an earlier one to invoice a past period.">Billing period <select class="rb-ver-pick" id="rbPeriodDraft">${opts}</select></label>`;
 }
 // Draft (or refresh) this offtaker's invoice for the chosen billing period, then
 // reopen the card on the fresh draft so its figures + cross-check reflect it.
 async function draftForPeriod(subId, period) {
 const pq = period ? ("?period=" + encodeURIComponent(period)) : "";
 const st = document.querySelector(`.rb-offedit[data-offedit="${subId}"] .rb-offedit-status`);
 if (st) { st.className = "rb-status rb-busy"; st.textContent = "Drafting that period…"; }
 try {
 const r = await fetch(API + "/subscriptions/" + subId + "/draft" + pq,
 { method: "POST", headers: authHeaders() });
 const dg = await r.json().catch(() => ({}));
 if (!r.ok || !dg.ok) {
 if (st) { st.className = "rb-status rb-err"; st.textContent = (dg && dg.detail) || "Couldn't draft that period."; }
 return;
 }
 noteXcheck(subId, dg); // the chosen period's cross-check rides the response
 if (dg.draft) DRAFT_BY_SUB[String(subId)] = dg.draft;
 _verFetched.delete(String(subId)); // a new/updated period → refresh the version list
 VIEWING_VERSION_ID = null; // land on the freshly-drafted (latest-selected) period
 renderInboxBody();
 } catch (e) {
 if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error, try again."; }
 }
 }

 function activeDraft() {
 // A selected OLDER version wins, a read-only look-back at a past invoice.
 if (VIEWING_VERSION_ID != null) {
 const v = (VERSIONS_BY_SUB[String(ACTIVE_SUB_ID)] || []).find(d => String(d.id) === String(VIEWING_VERSION_ID));
 if (v) return v;
 }
 // The selected OFFTAKER is the billing basis; its latest pending draft renders.
 if (ACTIVE_SUB_ID != null && DRAFT_BY_SUB[String(ACTIVE_SUB_ID)]) return DRAFT_BY_SUB[String(ACTIVE_SUB_ID)];
 return INBOX_DRAFTS.find(d => String(d.id) === String(ACTIVE_DRAFT_ID)) || null;
 }

 /* Live invoice preview beside the approval draft, a styled mock of exactly
 * what the offtaker receives, rebuilt in real time from the draft numbers, the
 * (live-edited) cover email, and the GMP-attach toggle. Mirrors the standard
 * backend invoice; the card's "Preview invoice" button still fetches the exact
 * PDF (incl. a custom template). */
 // "How we calculated this", a transparent breakdown above the live preview so the
 // reviewer can trace latest bill → metered generation → their share → the rate math →
 // the solar-credit value (and any fixed budget override). All from the draft's figures.
 // The offtaker's utility provider label (GMP / VEC / WEC …), resolved from its bound
 // utility account, for provider-accurate copy, a VEC offtaker must never read "GMP"
 // (Ford 2026-07-10). Returns "" when unknown so callers fall back to "utility".
 function offtakerProviderLabel(d) {
 const acct = (INBOX_UTIL_ACCTS || []).find(a => String(a.utility_account_id) === String(d && d.utility_account_id));
 const prov = (acct && acct.provider) || (d && d.provider) || "";
 return prov ? String(prov).toUpperCase() : "";
 }

 function calcDashboard(d) {
 // ONE honest displayed triple: pool × share = billed. When the offtaker's own
 // bill governs, the share is DERIVED from the bills (Ford 2026-07-10).
 const trip = draftDisplayTriple(d);
 const pct = trip.share != null ? Math.round(trip.share * 1000) / 10 : null;
 const explicitRate = d.net_rate_per_kwh != null;
 // 1-decimal, matching the editor (step=0.1) so 12.5% shows "12.5%", not "13%",
 // and the printed "× (1−X%)" reconciles with the server-computed total.
 const disc = d.discount_pct ? Math.round(d.discount_pct * 1000) / 10 : 0;
 // Disclosure: a discount can be applied without the operator setting one (backend
 // auto-resolves a default). Surface that plainly so this panel never shows a silent
 // discount. Purely a label, the money is server-computed.
 const autoDisc = d.discount_pct == null && d.resolved_discount_pct != null && d.resolved_discount_pct > 0;
 const autoDiscPct = autoDisc ? Math.round(d.resolved_discount_pct * 1000) / 10 : null;
 // A budget bill is keyed on budget_amount_usd ALONE, never inferred from the dollar
 // total. This panel is "how we calculated this invoice": it must ALWAYS land on the
 // genuine production calculation and surface the budget only as a separate override
 // line, it must NEVER present the budget as if it were the calculated credit.
 const budgetSet = d.budget_amount_usd != null;
 const gmpReady = d.has_gmp_pdf || (d.auto_attach_gmp !== false && d.gmp_auto_status === "ready");
 const billUrl = gmpReady ? `${API}/drafts/${d.id}/gmp-bill` : null;
 // The CALCULATED solar-credit value (production × real net-metering rate), independent
 // of any budget. With a budget set this is solar_credit_value (the pre-override amount);
 // with NO budget it's amount_usd (which IS the calculated total). When a budget is set
 // but solar_credit_value hasn't reached us, we have NO genuine calculated value, so we
 // must NOT fall back to amount_usd (that's the budget, and budget ÷ kWh is exactly the
 // fake $2.42718/kWh bug). Leave it null and show the value as pending instead.
 const creditVal = budgetSet ? (d.solar_credit_value != null ? d.solar_credit_value : null)
 : d.amount_usd;
 // ALWAYS surface the per-kWh rate that turns production into that credit, so the
 // multiplication kWh × rate = $ is visible. Use the operator's set rate when there is
 // one; otherwise show the EFFECTIVE rate implied by the bill's net-metering credit
 // (CALCULATED credit ÷ kWh, never budget ÷ kWh), so an offtaker priced straight off
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
 + `${explicitRate ? "" : "<small>effective, from the bill's net-metering credit</small>"}`
 + `${autoDisc ? `<small>${autoDiscPct}% discount (default, auto-applied)</small>` : ""}</span>`
 + `<span class="rb-calc-v">${rateTxt}${(explicitRate && shownDisc) ? ` <span class="rb-calc-eq">− ${shownDisc}%</span>` : ""}</span></div>`;
 // The calculated credit value: the genuine number when we have it; "computing…" when a
 // budget is set but the calculated value hasn't landed yet (NEVER the budget amount).
 const creditDue = creditVal != null ? money(creditVal) : "computing…";
 const totalRows = budgetSet
 ? `<div class="rb-calc-row sub"><span class="rb-calc-k">Solar credit value<small>${esc(rateMath)}</small></span><span class="rb-calc-v">${creditDue}</span></div>
 <div class="rb-calc-row total"><span class="rb-calc-k">Budget bill, fixed total<small>overrides the calculated value</small></span><span class="rb-calc-v">${money(d.amount_usd)}</span></div>`
 : `<div class="rb-calc-row total"><span class="rb-calc-k">Solar credit value due<small>${esc(rateMath)}</small></span><span class="rb-calc-v">${money(d.amount_usd)}</span></div>`;
 return `
 <div class="rb-calc">
 <div class="rb-calc-h">How we calculated this invoice</div>
 <div class="rb-calc-row"><span class="rb-calc-k">Latest ${offtakerProviderLabel(d) || "utility"} bill</span>
 <span class="rb-calc-v">${esc(d.period_label || "latest period")}${billUrl ? ` <button type="button" class="rb-calc-link" data-dl="${esc(billUrl)}" data-fn="${esc(gmpBillFilename(d))}">view ↓</button>` : ""}</span></div>
 <div class="rb-calc-row"><span class="rb-calc-k">Array generation<small>metered on the bill</small></span><span class="rb-calc-v">${fmt0(trip.total)} kWh</span></div>
 <div class="rb-calc-row"><span class="rb-calc-k">${esc(d.customer_name || "This offtaker")}'s share${trip.fromBill ? "<small>from their own utility bill</small>" : ""}</span>
 <span class="rb-calc-v">${pct != null ? pct + "%" : "—"}${pct != null ? ` <span class="rb-calc-eq">= ${fmt0(d.customer_kwh)} kWh</span>` : ""}</span></div>
 ${rateRow}
 ${totalRows}
 </div>`;
 }

 // The send actions, lifted ABOVE the live preview (Paul's review flow). Disabled when
 // reviewing an OLDER version (look-only), switch to latest to send.
 function reviewActions(d, readonly) {
 // "Preview" downloads the exact PDF that gets sent (the old summary-row Preview
 // button, absorbed here). Approve & send is the blue primary; Send-to-me + Preview
 // are quiet secondaries beside it.
 return `
 <div class="rb-review-acts">
 <button class="ao-btn ao-btn-primary rb-btn rb-btn-lg" data-dact="approve"${readonly ? ' disabled title="Viewing an older version, switch to “latest” to send."' : ""}>Approve &amp; send</button>
 <button class="ao-btn rb-btn" data-dact="sendme" type="button" title="Email a test copy to yourself first"${readonly ? " disabled" : ""}>Send to me</button>
 <button class="ao-btn rb-btn" data-dact="preview" type="button" title="Open the exact invoice PDF in a new tab">Preview ↗</button>
 <span class="rb-status rb-draft-status"></span>
 </div>`;
 }

 // The calc dashboard's "view ↓" bill button. The dashboard now lives in the FORM
 // column (between the offtaker name and the cover email), so wire its link wherever
 // the dashboard is (re)rendered, initial body render + post-recompute repaint.
 function wireCalcLinks(root) {
 if (!root) return;
 root.querySelectorAll(".rb-calc-link[data-dl]").forEach(b => b.onclick = () =>
 downloadAttachment(b.getAttribute("data-dl"), b.getAttribute("data-fn")));
 }

 // Render the review ACTIONS (Approve & send …) above the live preview. Kept in its
 // OWN container so it repaints only when figures change, not on every keystroke.
 // (The calc dashboard moved to the form column; see draftCard.)
 function renderReviewTop() {
 const top = $("#rbReviewTop");
 if (!top) return;
 const d = activeDraft();
 if (!d) { top.innerHTML = ""; return; }
 // A one-line "what gets sent" summary sits beside the send actions in the top bar,
 // so the operator can review-and-send without expanding anything below.
 const _trip = draftDisplayTriple(d);
 const pct = _trip.share != null ? Math.round(_trip.share * 1000) / 10 : null;
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
 const sumOn = sumCb ? sumCb.checked : (d.include_summary === true); // OFF by default

 const period = d.period_label || "latest period";
 const kwh = d.customer_kwh != null ? fmt0(d.customer_kwh) + " kWh" : "—";

 // ── Envelope, faithful to the backend's _email_html (subject/from/to). ──
 // The backend renders the subject from the tenant's mass template
 // (email_subject_default); fall back to the default construction.
 const subject = d.email_subject_default
 || (`Your solar credit invoice, ${d.customer_name || "your offtaker"}`
 + (d.invoice_number ? ` (${d.invoice_number})` : ""));
 const fromName = d.operator_name || "Your operator account";
 const toClient = !!(d.send_mode && d.send_mode !== "to_me");
 const toLine = toClient
 ? esc(d.customer_name || "your offtaker") + (d.client_email ? ` &lt;${esc(d.client_email)}&gt;` : "")
 : "you (operator copy, “Send to: Me”)";

 // ── Attachments, faithful: invoice + summary (if on) + the GMP bill. ──
 const slug = String(d.customer_name || "offtaker").toLowerCase()
 .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "offtaker";
 const invSuffix = d.invoice_number ? "_" + d.invoice_number : "";
 const sid = d.subscription_id;
 // Each chip carries a `url`, clicking downloads that exact file. The GMP bill
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
 // Provider-aware label: a VEC/SmartHub-bound offtaker's bill is a "VEC utility
 // bill", not a "GMP" one (Ford 2026-07-07: "glover is a VEC offtaker but it's
 // showing the gmp bill"). attach_provider comes from the backend (_bound_provider);
 // fall back to the bound utility account's provider, else GMP.
 const _bAcct = (INBOX_UTIL_ACCTS || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
 const _billLbl = auditProviderLabel((d.attach_provider || (_bAcct && _bAcct.provider) || "gmp").toLowerCase());
 if (d.has_gmp_pdf || (autoOn && d.gmp_auto_status === "ready")) atts.push({
 ico: "🧾", name: gmpBillFilename(d),
 sub: `the ${_billLbl} bill behind this invoice`, state: "ready",
 url: `${API}/drafts/${d.id}/gmp-bill`,
 });
 else if (autoOn) atts.push({
 ico: "🧾", name: `${_billLbl} utility bill`,
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

 // ── Cover body, note → figure table → attached line (mirrors _email_html). ──
 const noteHtml = note && note.trim()
 ? `<div class="rb-eml-note">${esc(note.trim()).replace(/\n/g, "<br>")}</div>` : "";
 const attWord = sumOn
 ? "invoice and performance summary are" : "invoice is";

 pane.innerHTML = `
 <div class="rb-doc-cap">Live preview, the email ${esc(toClient ? (d.customer_name || "your offtaker") : "you")} receive${toClient ? "s" : ""}</div>
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
 // a canvas, same source as the attachment chip + "Preview invoice", so it shows
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
 '<div class="rb-tpl-load">Invoice preview unavailable, use “Preview invoice” for the exact PDF.</div>'; });
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
 } catch (e) { /* swallow, never break the preview */ }
 }

 // Initials for the review card's avatar (first + second word, e.g. "Abigail
 // Ives II II" → "AI"; "Hartland Feed & Grain" → "HF"). Skips a lone "&".
 function offtakerInitials(name) {
 const parts = String(name || "").trim().split(/\s+/).filter(w => w && w !== "&");
 if (!parts.length) return "•";
 if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
 return (parts[0][0] + parts[1][0]).toUpperCase();
 }

 function draftCard(d, utilAccts) {
 const pct = offtakerShareFrac(d) != null ? Math.round(offtakerShareFrac(d) * 1000) / 10 : null;
 // Remember the auto-written note so a live recompute can re-sync it, but only
 // while the operator hasn't customized it (we compare against this snapshot).
 d._defaultNote = d.email_letter_default || defaultDraftNote(d);
 const auto = d.auto_attach_gmp !== false; // ON by default
 const sumOn = d.include_summary === true; // OFF by default, AO summary is opt-in (Ford)
 // Provider-aware auto-attach: the toggle attaches the offtaker's BOUND utility
 // bill, so label + status must reflect that provider (VEC/WEC/… vs GMP). Prefer
 // the backend's attach_provider; fall back to the bound util account's provider
 // (works before the payload field lands + for legacy). Column name on the sub
 // stays auto_attach_gmp for back-compat; here it's just "the utility bill".
 const _boundAcct = (utilAccts || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
 const _attachProv = (d.attach_provider || (_boundAcct && _boundAcct.provider) || "gmp").toLowerCase();
 const _isVecAttach = _attachProv !== "gmp";
 const _provLabel = auditProviderLabel(_attachProv); // "VEC" / "WEC" / "GMP" / …
 // Honest auto-attach status line (never implies a PDF exists when it doesn't).
 const autoStatusText = _isVecAttach
 ? {
 ready: `✓ ${_provLabel} bill found, it will attach automatically.`,
 pending: `${_provLabel} bill will attach automatically once it's pulled (none yet).`,
 no_gmp: `No ${_provLabel} bill on file for this offtaker yet.`,
 }[d.gmp_auto_status] || ""
 : {
 ready: "✓ GMP bill found, it will attach automatically.",
 pending: "GMP bill will attach automatically once it's captured (none yet).",
 no_gmp: "No GMP account on this array yet, connect one to auto-attach.",
 }[d.gmp_auto_status] || "";
 // Attachment controls box, sits beside the send buttons (Ford). Auto-attach the
 // bound utility bill (on by default) + opt-in Array Operator summary data (off by default).
 const attachBox = `
 <div class="rb-draft-attach">
 <label class="rb-gmp-switch">
 <input type="checkbox" data-dact="autogmp" ${auto ? "checked" : ""}>
 <span>Auto-attach the ${esc(_provLabel)} bill</span>
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
 // them, they're just hidden until the operator opens the section.
 const sid = d.subscription_id;
 // NEPOOL client-card aesthetic (Ford 2026-07-04): each section is a colour-
 // dotted, tinted collapsible sub-card. `tone` keys the colour band.
 // `open` is the FIRST-render default; once the operator toggles a section, SEC_OPEN
 // remembers it so a re-render restores their choice instead of snapping back.
 const sec = (title, body, sub, open, tone) => {
 const isOpen = (title in SEC_OPEN) ? SEC_OPEN[title] : open;
 return `<details class="rb-sec" data-seckey="${esc(title)}" data-tone="${tone || "slate"}"${isOpen ? " open" : ""}>
 <summary class="rb-sec-h"><span class="rb-sec-caret" aria-hidden="true">▸</span><span class="rb-sec-dot" aria-hidden="true"></span><span class="rb-sec-t">${title}</span>${sub ? `<span class="rb-sec-sub">${esc(sub)}</span>` : ""}</summary>
 <div class="rb-sec-body">${body}</div>
 </details>`;
 };
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
 // Bill accuracy check, the production-vs-bill + GMP-allocation cross-check for
 // THIS offtaker (from /reconcile-bills, indexed by sub_id). Only shown when we
 // have a reconcile row; opens by default when a hard allocation mismatch was
 // caught so the $25 catch is visible without a click. If the reconcile data
 // hasn't arrived yet on first paint, expandAccordion re-renders once it lands.
 const bacBody = sid != null ? reconPanelHTML(sid) : null;
 const bacFlagged = sid != null && reconFlagged(sid);
 const bacSec = bacBody
 ? sec("Bill accuracy check", bacBody, reconSecSub(sid), bacFlagged, bacFlagged ? "amber" : "sky")
 : "";
 return `
 <div class="rb-draft" data-did="${d.id}" data-subid="${d.subscription_id}">
 <div class="rb-draft-top">
 <span class="rb-draft-avatar" aria-hidden="true">${esc(offtakerInitials(d.customer_name))}</span>
 <div class="rb-draft-hd">
 <span class="rb-draft-eyebrow">Offtaker invoice</span>
 <div class="rb-draft-name">${esc(d.customer_name)}</div>
 </div>
 <div class="rb-draft-period">${esc(d.period_label || "latest period")}</div>
 </div>
 ${sid != null ? `<div class="rb-xcheck-host" data-xcheck="${esc(String(sid))}">${xcheckHTML(sid)}</div>` : ""}
 ${sec("How this was calculated", calcDashboard(d), "kWh × rate × share = the amount", true, "amber")}
 ${sec("Offtaker details", offtakerEditor(d, utilAccts) + attachBox, "share, rate, schedule, delivery", false, "emerald")}
 ${sec("Edit email", emailBody, "the note your offtaker sees", false, "amber")}
 ${sec("Invoice template", tplSlot, "PDF / Excel format", false, "sky")}
 ${sec("Generation spreadsheet", trackerBox, "their tracking sheet", false, "emerald")}
 ${bacSec}
 <p class="rb-draft-note">Sends to <b>${esc(d.customer_name)}</b> per the delivery setting,
 with the offtaker invoice${d.has_gmp_pdf ? " and the GMP bill" : ""} attached.
 Use <b>Approve &amp; send</b> at the top when ready.</p>
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
 // GMP/VEC/WEC bills land via the extension. When the latest one on file is old (or
 // absent), the banner's "Re-sync latest bill" button OPENS the utility portal so the
 // operator signs in and the extension captures the newest bill, which lands back
 // here automatically (SO_CAPTURE_LANDED below → refresh in place). No manual
 // regenerate. Degrades gracefully: no extension → the banner says to install it.
 const RESYNC_STALE_DAYS = 35; // a monthly bill should have landed by now
 let _extPresent = false;
 let _captureRefreshT = null;
 try {
 window.addEventListener("message", (e) => {
 if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
 if (e.data.type === "SO_EXTENSION_PRESENT" || e.data.type === "SO_STATUS_ACK") { _extPresent = true; return; }
 // A utility capture just landed from a portal the operator re-synced → refresh the
 // roster + the OPEN offtaker in place so a freshly-captured bill attaches and the
 // "no bill on file" banner clears. DEBOUNCED, and via the SILENT refreshDraftOnOpen
 // (not selectOfftaker(force), which shows the heavy "Drafting…" spinner), a single
 // VEC visit can broadcast several capture events, and stacking a forced regenerate
 // left the card stuck spinning (Ford 2026-07-09).
 if (e.data.type === "SO_CAPTURE_LANDED" && e.data.ok) {
 try { window.dispatchEvent(new CustomEvent("ao:utility-accounts-changed")); } catch (_) {}
 clearTimeout(_captureRefreshT);
 _captureRefreshT = setTimeout(() => {
 try { refreshList(); } catch (_) {}
 try { if (ACTIVE_SUB_ID) refreshDraftOnOpen(ACTIVE_SUB_ID); } catch (_) {}
 }, 500);
 }
 });
 } catch (_) {}

 function _billDaysOld(acct) {
 const t = acct && acct.latest_period_end ? Date.parse(acct.latest_period_end) : NaN;
 return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
 }
 // The banner HTML, only for a utility-bound offtaker whose latest bill is stale/absent.
 function resyncBanner(d, utilAccts) {
 const boundAcct = (utilAccts || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
 if (!boundAcct) return "";
 const prov = (boundAcct.provider || "gmp").toLowerCase();
 const days = _billDaysOld(boundAcct);
 if (days != null && days <= RESYNC_STALE_DAYS) return ""; // already fresh → no banner
 const sid = d.subscription_id;
 const provLabel = prov === "gmp" ? "GMP" : prov.toUpperCase();
 const msg = days == null
 ? `No ${provLabel} bill on file yet for this offtaker.`
 : `Latest ${provLabel} bill is from ${esc(boundAcct.latest_period_label || "—")}, ${days} days ago.`;
 return `<div class="rb-resync" data-resync-sid="${sid}" data-resync-prov="${esc(prov)}">
 <span class="rb-resync-msg">${msg}</span>
 <button type="button" class="rb-resync-btn" data-resync-go="${sid}">↻ Re-sync latest bill</button>
 <span class="rb-resync-status" aria-live="polite"></span></div>`;
 }
 // Wire the banner after render. Re-sync = OPEN the offtaker's utility portal in a
 // FOREGROUND tab so the operator signs in and the EnergyAgent extension captures the
 // latest bill, which then lands back here automatically (SO_CAPTURE_LANDED → refresh).
 // The old path posted SO_RECAPTURE for a silent background recapture, but the
 // extension's recaptureNow only knows inverter vendors (fronius/sma/chint), for a
 // UTILITY code (vec/wec/gmp/…) it returned "unsupported-vendor", so clicking did
 // NOTHING (Ford 2026-07-09). We now reuse the same SO_OPEN_PORTAL machinery as
 // "Link utility bills" (sandbox.js window.__aoOpenUtilityPortal), which opens the
 // real VEC/GMP portal, arms the capture intent, and returns to this tab on capture.
 function wireResync(sid) {
 const banner = document.querySelector(`.rb-resync[data-resync-sid="${sid}"]`);
 if (!banner) return;
 const prov = banner.getAttribute("data-resync-prov");
 const statusEl = banner.querySelector(".rb-resync-status");
 const btn = banner.querySelector(".rb-resync-btn");
 const provLabel = prov === "gmp" ? "GMP" : (prov || "utility").toUpperCase();
 const run = () => {
 const open = window.__aoOpenUtilityPortal;
 if (typeof open !== "function") {
 if (statusEl) statusEl.textContent = "Re-sync needs the EnergyAgent extension, install it, then click again.";
 return;
 }
 if (statusEl) statusEl.textContent = `Opening ${esc(provLabel)}, sign in there and your latest bill syncs back here automatically.`;
 try { open(prov); } catch (_) {
 if (statusEl) statusEl.textContent = "Couldn't open the portal, use the Link utility bills button instead.";
 }
 };
 if (btn) btn.onclick = run;
 // No hands-off auto-open: opening a portal is a foreground action, so it fires ONLY
 // on an explicit click, we never yank the operator to the portal on page open.
 }

 // Honest default-rate helper for a GMP-bound offtaker's Solar-credit-rate field.
 // Returns {rate, html} where `rate` is the default $/kWh (or null) and `html` is
 // the octarine "default: …" line, sourced TRUTHFULLY:
 // • the backend's default_net_rate_* (bill's own rate vs a banked-months
 // reference) when the draft carries it, the ONLY honest source of the
 // banked-vs-cashed distinction (Town of Fairlee: a banked bill's rate is a
 // COMPARABLE-MONTHS REFERENCE, never "from your GMP bill");
 // • else a back-derived rate (credit ÷ kWh ÷ (1−discount)) labeled generically,
 // for older cached drafts that predate the backend fields;
 // • else "shows here once a bill settles".
 // Never derives a rate from a budget-overridden total (that's not a rate).
 function gmpDefaultRate(d) {
 const subRec = OFFTAKERS.find(x => String(x.id) === String(d.subscription_id)) || {};
 const per = d.period_label ? " (" + esc(d.period_label) + ")" : "";
 // Preferred: the backend-computed default rate + its honest source.
 if (d.default_net_rate_per_kwh != null && d.default_net_rate_source) {
 const r = Number(d.default_net_rate_per_kwh);
 const src = d.default_net_rate_source === "gmp_credit_reference"
 ? `comparable-months reference, this period's credit was banked${per}`
 : `from your GMP bill${per}`;
 return { rate: r, html: `default: <b>$${r.toFixed(5)}/kWh</b>, ${src}` };
 }
 // Fallback (older cached draft, no backend fields yet): back-derive, label
 // generically, do NOT claim "from your GMP bill" (it may be a banked ref).
 const budgetSet = d.budget_amount_usd != null;
 const creditVal = budgetSet ? (d.solar_credit_value != null ? d.solar_credit_value : null) : d.amount_usd;
 const discFrac = d.discount_pct != null ? d.discount_pct
 : (subRec.resolved_discount_pct != null ? subRec.resolved_discount_pct : null);
 let billRate = null;
 // A "customer" override rules out back-deriving (amount already reflects it).
 if (d.net_rate_per_kwh == null
 && creditVal != null && creditVal > 0 && d.customer_kwh > 0
 && discFrac != null && discFrac >= 0 && discFrac < 1) {
 billRate = creditVal / d.customer_kwh / (1 - discFrac);
 }
 if (billRate != null) {
 return { rate: billRate, html: `default: <b>$${billRate.toFixed(5)}/kWh</b>, your GMP bill's net-metering credit rate${per}` };
 }
 return { rate: null, html: `Defaults to each GMP bill's own net-metering credit rate, shows here once a bill settles.` };
 }

 // ── Solar credit rate row for the accordion editor (Ford 2026-07-07) ────────
 // The rate DEFAULTS to the bill's own net-metering credit rate but the operator
 // can OVERRIDE it (Ford: "the solar credit rate needs to be something you can
 // enter to override the default"). Every offtaker type gets an editable $/kWh
 // input writing net_rate_per_kwh (blank = use the default):
 // • GMP-bound → the input's DEFAULT is the bill's own rate (or a banked-months
 // reference), shown in an honest "default: $X, <source>" helper beneath it;
 // typing overrides, blanking reverts. VEC/SmartHub/workbook/legacy-flat keep
 // their existing manual input (no bill-scraped rate is their billing basis).
 function rateFieldHTML(d, utilAccts) {
 const accts = utilAccts || INBOX_UTIL_ACCTS || [];
 const boundAcct = accts.find(a => String(a.utility_account_id) === String(d.utility_account_id));
 const boundProv = boundAcct ? (boundAcct.provider || "gmp").toLowerCase() : "";
 const subRec = OFFTAKERS.find(x => String(x.id) === String(d.subscription_id)) || {};
 const wb = d.has_workbook === true;
 const legacyFlat = subRec.rate_per_kwh != null && subRec.rate_per_kwh > 0;
 // Bill-scraped = the GMP bill is the pricing billing basis: GMP-bound, no
 // legacy flat $/kWh, and (for workbook offtakers) an explicit share set, that
 // combination routes billing through the bill path (delivery.build_manual_match).
 const billScraped = boundProv === "gmp" && !legacyFlat && (!wb || d.allocation_pct != null);
 if (!billScraped) {
 const rate = d.net_rate_per_kwh != null ? d.net_rate_per_kwh : "";
 return `<label class="rep-fld rb-rate-fld"><span class="rl">Solar credit rate ($/kWh)</span>
 <input type="number" data-of="net_rate_per_kwh" min="0" step="0.0001" value="${rate}" placeholder="blank = auto from bill"></label>`;
 }
 // GMP-bound: editable input defaulting to the bill's rate, overridable.
 const def = gmpDefaultRate(d);
 const val = d.net_rate_per_kwh != null ? Number(d.net_rate_per_kwh) : "";
 const ph = def.rate != null ? def.rate.toFixed(5) : "auto from bill";
 const overriding = d.net_rate_per_kwh != null;
 // When overriding, add an amber cue + the honest default underneath (so the
 // operator always sees the rate they're replacing). When not, just the default.
 const helper = overriding
 ? `<span class="rb-rate-auto rb-rate-warn rb-rate-def"><b>Override in effect</b>, the invoice uses your entered rate. Clear the field to revert to the ${def.html.replace(/^default: /, "")}</span>`
 : `<span class="rb-rate-auto rb-rate-def">${def.html}</span>`;
 return `<label class="rep-fld rb-rate-fld"><span class="rl">Solar credit rate ($/kWh)</span>
 <input type="number" data-of="net_rate_per_kwh" min="0" step="0.0001" value="${val}" placeholder="${ph}">
 ${helper}</label>`;
 }

 function offtakerEditor(d, utilAccts) {
 const sid = d.subscription_id;
 if (!sid) return "";
 const wb = d.has_workbook === true; // workbook offtakers bill from the sheet
 // Editor prefills show the FULL 3-decimal percent (Bruce: "e.g. 24.783") —
 // the old 1-decimal rounding meant any touch of the field saved back 24.8%,
 // destroying the stored third decimal. Whole shares render as 25.000 (consistent).
 // "Share of net-meter group" = array_share_pct (the group share real_math bills as
 // share × group excess). For a SUB-metered offtaker allocation_pct is pinned to 1.0
 // (100% of their OWN sub bill), showing THAT read a misleading 100% (Ford: dad's
 // "St J Pump Plant 5.67% of Timberworks" showed 100). Source array_share_pct from the
 // subscription record (which always carries it), the draft d may omit it, so
 // offtakerShareFrac(d) was falling back to the pinned allocation_pct. The field still
 // saves via allocation_pct; the backend PATCH re-routes that into array_share_pct for
 // sub-metered subs (never re-multiplying), so the round-trip stays consistent.
 const _subShare = (OFFTAKERS.find(x => String(x.id) === String(sid)) || {}).array_share_pct;
 const _shareFrac = _subShare != null ? _subShare : offtakerShareFrac(d);
 const pct = _shareFrac != null ? (_shareFrac * 100).toFixed(3) : "";
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
 const xThresh = subRec.crosscheck_threshold_pct != null ? Number(subRec.crosscheck_threshold_pct) : "";
 const invStart = subRec.invoice_number_start != null ? subRec.invoice_number_start : "";
 const editArrayId = subRec.array_id != null ? subRec.array_id : (d.array_id != null ? d.array_id : "");
 // Is the bound account a VEC/SmartHub one? Those bills don't expose the credit
 // rate in the portal, so we offer a bill-PDF upload that reads the generation +
 // net-metering rate off the PDF (then the invoice auto-prices like GMP).
 const boundAcct = (utilAccts || []).find(a => String(a.utility_account_id) === String(d.utility_account_id));
 const boundProv = boundAcct ? (boundAcct.provider || "gmp").toLowerCase() : "";
 const isSmartHubBound = !!boundProv && boundProv !== "gmp";
 // Vendor-free labels (billLabel: nickname → service address → provider+acct#,
 // + bill status), consistent with the add-offtaker sub-account picker, never
 // the array/inverter name (Ford 2026-07-09: no vendor info in this generator).
 // Two dropdowns (Ford 2026-07-10): master account (group host) + optional
 // sub-account (own meter). The bound account preselects whichever it is.
 const msOpts = masterSubOptions(utilAccts, OFFTAKERS, d.utility_account_id, editArrayId);
 // Show the GMP-bill link for EVERY offtaker, INCLUDING workbook offtakers. The linked
 // utility_account_id drives the GMP-bill auto-attach (api/billing/delivery.py); it does
 // NOT change a workbook offtaker's amount (that bills from source_workbook, which takes
 // precedence), it only sets which GMP bill attaches. Was gated on !wb, so workbook
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
 semantics, name / utility account / share % refuse to save blank
 (return null); every other field persists blank, so it stays clear. -->
 <!-- Redesign (Ford 2026-07-10): the flat 14-field grid was hard to scan.
 Group into labeled sections (Offtaker / Billing / Invoicing), fold the
 rarely-touched overrides into an Advanced <details>, and move the static
 per-field descriptions into ⓘ tooltips. Native <details> keeps every field
 in the DOM, so all wiring (data-of / .rb-of-master / .rb-of-sub /
 .rb-of-commdate / .rb-of-ratehint) still finds them. -->
 <p class="rb-req-legend">Marked fields are required, everything else is optional.</p>

 <div class="rb-fsec">
 <div class="rb-fsec-h">Offtaker</div>
 <div class="rb-cust-grid rb-offedit-grid rb-fgrid">
 <label class="rep-fld req"><span class="rl">Name</span>
 <input type="text" data-of="customer_name" value="${esc(d.customer_name || "")}"></label>
 <label class="rep-fld"><span class="rl">Email<span class="rb-info" tabindex="0" title="Where the invoice is sent, needed to email the offtaker.">ⓘ</span></span>
 <input type="email" data-of="client_email" value="${esc(d.client_email || "")}" placeholder="name@example.com"></label>
 ${showBillPicker ? `
 <label class="rep-fld req"><span class="rl">Master account<span class="rb-info" tabindex="0" title="The net-meter group host this offtaker bills a share of.">ⓘ</span></span>
 <select class="rb-of-master">${msOpts.masterHTML}</select></label>
 <label class="rep-fld"><span class="rl">Sub-account<span class="rb-info" tabindex="0" title="If this offtaker meters on their own account, pick it to bill directly off their meter instead of a share of the master. Leave blank to bill their share of the master. Changing either re-derives their group share automatically.">ⓘ</span></span>
 <select class="rb-of-sub">${msOpts.subHTML}</select></label>` : ""}
 <label class="rep-fld rb-fgrid-full"><span class="rl">CC</span>
 <input type="text" data-of="cc_emails" value="${esc(d.cc_emails || "")}" placeholder="optional, comma-separated"></label>
 </div>
 </div>

 <div class="rb-fsec">
 <div class="rb-fsec-h">Billing</div>
 <div class="rb-cust-grid rb-offedit-grid rb-fgrid">
 <label class="rep-fld req"><span class="rl">Share of net-meter group (%)<span class="rb-info" tabindex="0" title="This offtaker's percentage of the master array's net-meter group excess.">ⓘ</span></span>
 <input type="number" data-of="allocation_pct" min="0.01" max="100" step="0.001" value="${pct}" placeholder="e.g. 24.783">
 ${subRec.array_share_pct != null ? `<span class="rb-fld-hint">Their invoice bills <b>their own utility bill</b>, GMP's actual allocation. This share is your expected value for the <b>bill-accuracy audit</b> (and only bills directly while their sub-account has no settled bill).</span>` : ""}</label>
 ${rateFieldHTML(d, utilAccts)}
 <label class="rep-fld"><span class="rl">Discount (%)</span>
 <input type="number" data-of="discount_pct" min="0" max="100" step="0.1" value="${disc}" placeholder="e.g. 10">
 ${autoDisc ? `<span class="rb-fld-hint">Applying <b>${autoDiscPct}% (default, auto-applied)</b> because you haven't set one${d.resolved_net_note ? ` · ${esc(d.resolved_net_note)}` : ""}. Enter a value to override.</span>` : ""}</label>
 </div>
 </div>

 <div class="rb-fsec">
 <div class="rb-fsec-h">Invoicing</div>
 <div class="rb-cust-grid rb-offedit-grid rb-fgrid">
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
 </div>
 </div>

 <details class="rb-fadv" data-seckey="Advanced overrides"${SEC_OPEN["Advanced overrides"] ? " open" : ""}>
 <summary>Advanced, flag threshold, budget cap, invoice numbering, commissioning</summary>
 <div class="rb-cust-grid rb-offedit-grid rb-fgrid">
 <label class="rep-fld"><span class="rl">Bill-accuracy threshold (%)<span class="rb-info" tabindex="0" title="The Bill accuracy check derives GMP's actual share automatically (credited ÷ the array's group excess) and compares it to the Share above, no data entry. This sets how far the two may differ before it's flagged. Blank = your default (${fmtPct(XCHECK_DEFAULT_PCT)}%).">ⓘ</span></span>
 <input type="number" data-of="crosscheck_threshold_pct" min="0.001" max="100" step="0.001" value="${xThresh}" placeholder="blank = default (${fmtPct(XCHECK_DEFAULT_PCT)}%)"></label>
 <label class="rep-fld"><span class="rl">Budget bill, fixed total ($)<span class="rb-info" tabindex="0" title="Set a flat amount this offtaker pays, overrides the calculated total (line items still show).">ⓘ</span></span>
 <input type="number" data-of="budget_amount_usd" min="0" step="0.01" value="${d.budget_amount_usd != null ? d.budget_amount_usd : ""}" placeholder="blank = use the calculated amount"></label>
 <label class="rep-fld"><span class="rl">Starting invoice #<span class="rb-info" tabindex="0" title="Seeds sequential invoice numbering; each send adds 1.">ⓘ</span></span>
 <input type="number" data-of="invoice_number_start" min="0" max="9999999" step="1" value="${invStart}" placeholder="blank = date-based"></label>
 ${editArrayId !== "" ? `
 <label class="rep-fld"><span class="rl">Commissioning date</span>
 <input type="date" class="rb-of-commdate" data-commdate-arr="${editArrayId}" min="1990-01-01" max="${todayISO()}">
 <span class="rb-fld-hint rb-of-ratehint">The array's in-service date, sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).</span></label>` : ""}
 </div>
 </details>

 <span class="rb-status rb-offedit-status"></span>
 </div>`;
 }

 // ── Bring-your-own generation spreadsheet ("our magic" auto-updater) ────────
 // The operator uploads their existing generation-tracking sheet (any columns);
 // we detect its structure and append a new row each month as fresh GMP bills
 // land. A "Download latest spreadsheet" button streams the kept-current file.
 //
 // Each offtaker has its OWN sheet inside its accordion card (.rb-track-sub).
 // (The operator-wide MASTER sheet card was removed from the top, Ford 2026-06-28;
 // TRACKER_BASE stays as the tenant-level fallback used by loadTrackerInto.)
 const TRACKER_BASE = "/v1/array-operator/tracker"; // tenant-level fallback (no /billing, no sid)
 const FIELD_LABEL = { period: "Period", generation: "Generation kWh",
 consumption: "Consumption", rate: "Credit rate", amount: "Amount $",
 status: "Status", paid_date: "Paid date", collected: "Collected $",
 fee: "Platform fee $", invoice_number: "Invoice #" };

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

 function moneyFmt(n) {
 if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
 const v = Number(n);
 return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, {
 minimumFractionDigits: 2, maximumFractionDigits: 2,
 });
 }

 function paidDateShort(iso) {
 if (!iso) return "—";
 try {
 const d = new Date(iso);
 if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
 return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
 } catch (e) { return String(iso).slice(0, 10); }
 }

 // Generic tracker loader. The box carries its OWN endpoint + scope on data-
 // attributes (data-tracker-base / -scope / -name), so the SAME renderer drives
 // each offtaker's OWN sheet (.rb-track-sub, inside its accordion). On 404 /
 // disabled / network the box stays hidden (safe to ship ahead of the flag; demo/out).
 async function loadTrackerInto(box) {
 if (!box) return;
 const base = box.dataset.trackerBase || TRACKER_BASE;
 if (!authHeaders()) { box.hidden = true; return; } // demo / signed-out
 try {
 const r = await fetch(base, { headers: authHeaders() });
 if (!r.ok) { box.hidden = true; return; } // flag off / not found → hide
 const j = await r.json();
 const t = j && (j.tracker || j); // accept {tracker:{…}} or flat shape
 if (!t || !t.enabled) { box.hidden = true; return; } // feature disabled → hide
 box.hidden = false;
 renderTracker(box, t);
 } catch (e) { box.hidden = true; } // network, leave hidden
 }

 function trackerCollectionSummary(t) {
 const paid = t.payments_paid || 0;
 const open = t.payments_open || 0;
 const collected = t.collected_usd;
 const pays = Array.isArray(t.payments) ? t.payments : [];
 if (!pays.length && !paid && !open && !(collected > 0)) return "";
 const chips = [];
 if (collected != null) {
 chips.push(`<span class="rb-track-chip rb-track-chip-money"><b>${esc(moneyFmt(collected))}</b> collected</span>`);
 }
 if (paid) chips.push(`<span class="rb-track-chip rb-track-chip-paid"><b>${paid}</b> paid</span>`);
 if (open) chips.push(`<span class="rb-track-chip rb-track-chip-open"><b>${open}</b> awaiting</span>`);
 return `<div class="rb-track-collect">${chips.join("")}</div>`;
 }

 function trackerPaymentsTable(t) {
 const pays = Array.isArray(t.payments) ? t.payments : [];
 if (!pays.length) {
 return `<div class="rb-track-payempty">No invoices collected yet, when offtakers pay online, each period lands here with paid date and amount collected.</div>`;
 }
 // Newest first already from API; show up to 12, rest via download.
 const rows = pays.slice(0, 12).map(p => {
 const st = (p.status || "").toLowerCase();
 const stCls = st === "paid" ? "paid" : (st === "open" ? "open" : "other");
 const label = p.status_label || p.status || "—";
 const coll = st === "paid" ? moneyFmt(p.collected_usd) : "—";
 const amt = moneyFmt(p.amount_usd);
 return `<tr class="rb-track-payrow" data-status="${esc(stCls)}">
 <td>${esc(p.period_label || p.period_key || "—")}</td>
 <td><span class="rb-track-payst rb-track-payst-${esc(stCls)}">${esc(label)}</span></td>
 <td class="rb-num">${esc(amt)}</td>
 <td>${esc(st === "paid" ? paidDateShort(p.paid_at) : "—")}</td>
 <td class="rb-num">${esc(coll)}</td>
 <td class="rb-muted">${esc(p.invoice_number || "—")}</td>
 </tr>`;
 }).join("");
 const more = pays.length > 12
 ? `<div class="rb-track-paymore">+${pays.length - 12} more in the downloaded spreadsheet</div>`
 : "";
 return `
 <div class="rb-track-pays">
 <div class="rb-track-pays-h">Invoice collection</div>
 <div class="rb-track-pays-scroll">
 <table class="rb-track-paytable">
 <thead><tr>
 <th>Period</th><th>Status</th><th>Invoice $</th><th>Paid</th><th>Collected $</th><th>#</th>
 </tr></thead>
 <tbody>${rows}</tbody>
 </table>
 </div>
 ${more}
 </div>`;
 }

 function trackerMapTable(t, scope) {
 if (!t.has_sheet) return "";
 const heads = t.headers || [];
 const cols = t.columns || {};
 let chips;
 if (t.auto && scope === "offtaker") {
 // Default invoice ledger: period + generation + invoice/collection columns.
 const nInv = t.data_rows || (Array.isArray(t.payments) ? t.payments.length : 0);
 chips = `<span class="rb-track-chip"><b>Invoice ledger</b></span>`
 + `<span class="rb-track-chip"><b>${nInv}</b> invoice${nInv === 1 ? "" : "s"}</span>`;
 if (t.collected_usd != null) {
 chips += `<span class="rb-track-chip rb-track-chip-money"><b>${esc(moneyFmt(t.collected_usd))}</b> collected</span>`;
 }
 } else if (t.auto) {
 // The auto-built master sheet's columns ARE the arrays (+ Period/Total), not
 // detected logical fields, summarize its shape instead of a field map.
 const nArr = Math.max(0, (heads.length || 0) - 2); // minus Period + Total
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
 // or one OFFTAKER's own sheet inside its accordion. Offtaker default = invoice
 // ledger with generation + paid/collected columns; upload overrides layout.
 function trackerCopy(box, t) {
 const scope = box.dataset.trackerScope || "global";
 const name = (box.dataset.trackerName || "").trim();
 const has = !!t.has_sheet;
 if (scope === "offtaker") {
 const who = name || "this offtaker";
 if (t.auto || !has) {
 return {
 title: name ? `${name}’s generation & invoices` : "Generation & invoices",
 hint: has
 ? `Default ledger for ${who}: generation, invoice $, paid date, and money collected. Download anytime, or upload your own sheet layout.`
 : `We keep a ledger of ${who}’s invoices and collections. Upload a custom sheet if you already track generation yourself.`,
 };
 }
 return {
 title: name ? `${name}’s generation spreadsheet` : "This offtaker’s generation spreadsheet",
 hint: `Your uploaded sheet for ${who}, we add a row each month as bills land. Remove to restore the default invoice ledger.`,
 };
 }
 // master / operator-wide
 if (t.auto) return {
 title: "Master generation spreadsheet",
 hint: "Auto-built from all your arrays, a column per array, a row per month, always current. Download anytime, or upload your own master layout to override it.",
 };
 return {
 title: "Master generation spreadsheet",
 hint: has
 ? "Your uploaded master sheet, we add a row each month as GMP bills land. Remove it to fall back to the auto-built sheet."
 : "Upload your operator-wide generation tracking sheet, we’ll detect its columns and keep it current as GMP bills land.",
 };
 }

 function renderTracker(box, t) {
 const scope = box.dataset.trackerScope || "global";
 const has = !!t.has_sheet;
 const isAuto = !!t.auto;
 const canRemove = has && !isAuto; // the auto ledger has nothing to remove
 const upLabel = !has ? "Upload spreadsheet" : (isAuto ? "Upload your own" : "Replace");
 const upTitle = isAuto ? "Upload your own sheet to override the auto-built one"
 : (has ? "Replace the tracked sheet" : "Upload a spreadsheet");
 const dlLabel = isAuto
 ? (scope === "offtaker" ? "Download invoice ledger ↓" : "Download spreadsheet ↓")
 : "Download latest spreadsheet ↓";
 // Always offer download for offtaker auto ledger (API builds it on demand).
 const showDl = has || (scope === "offtaker");
 const { title, hint } = trackerCopy(box, t);
 const showPays = scope === "offtaker";
 box.innerHTML = `
 <div class="rb-track-h">
 <span class="rl">${esc(title)}</span>
 <span class="rb-track-hint">${esc(hint)}</span>
 </div>
 ${trackerMapTable(t, scope)}
 ${showPays ? trackerCollectionSummary(t) : ""}
 ${showPays ? trackerPaymentsTable(t) : ""}
 <div class="rb-track-actions">
 ${showDl ? `<button type="button" class="rb-track-dl" data-tdl="1">${dlLabel}</button>` : ""}
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
 setS("rb-busy", "Processing your sheet, building the updated spreadsheet…");
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
 ? "✓ Updated spreadsheet produced, added " + p.added.join(", ") + ". Download it below."
 : "✓ Processed, your spreadsheet is up to date through the latest bill.") + norm;
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
 note.textContent = (ok ? "✓ AI reviewed, looks consistent. " : "⚠ AI flagged this, review before sending. ")
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
 // box returns to its empty upload state), the DELETE body alone can't
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
 const OF_MONEY_FIELDS = new Set(["utility_account_id", "allocation_pct", "discount_pct", "net_rate_per_kwh", "budget_amount_usd"]);
 // Recheck fields (Bruce 2026-07-07): they don't move the amount, but they DO
 // change the Bill-accuracy cross-check verdict, so a change re-runs the draft's
 // cross-check and flips the strip live (the flush treats them like money for the
 // redraft, just without the "Recalculating" framing).
 const OF_RECHECK_FIELDS = new Set(["crosscheck_threshold_pct"]);
 const OF_PENDING = {}; // sid -> { body, money, timer, card, box, did }

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
 // The master + sub account dropdowns resolve together to ONE utility_account_id
 // (sub wins when set → bill off their own meter; else the master → their share).
 const masterSel = box.querySelector(".rb-of-master");
 const subSel = box.querySelector(".rb-of-sub");
 if (masterSel && subSel) {
 const onPick = () => onOfftakerUtilityPick(card, box, did, sid, masterSel, subSel);
 masterSel.addEventListener("change", onPick);
 subSel.addEventListener("change", onPick);
 }
 // The commissioning date is NOT a subscription field, it lives on the ARRAY
 // and PATCHes /arrays/{id}. Wire it specially: pre-fill from the array's
 // current setup, save the in-service DATE on change (day-accurate, it sets
 // the 11-year Rate #1 → Blended boundary), and show the expected GMP rate.
 const commEl = box.querySelector(".rb-of-commdate");
 if (commEl) {
 const arrId = commEl.getAttribute("data-commdate-arr");
 const hintEl = box.querySelector(".rb-of-ratehint");
 const defHint = "The array's in-service date, sets which GMP rate applies (Rate #1 for the first 11 years, then Blended Statewide).";
 // Pre-fill the current commissioning date from the array setup (best-effort).
 prefillCommissioningDate(arrId, commEl, hintEl, defHint);
 // Persist on change (debounced) to PATCH /arrays/{id} via first_connect_date.
 wireCommissioningDateHint(commEl, hintEl, defHint);
 let saveTimer = null;
 const saveDate = () => {
 const raw = commEl.value.trim();
 if (raw === "") return; // don't clear the array's date on blank
 if (!isValidCommissioningDate(raw)) return;
 fetch(API + "/arrays/" + arrId, {
 method: "PATCH",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ first_connect_date: raw }),
 }).then(() => { _SETUP_ARRAYS = null; }).catch(() => {});
 };
 commEl.addEventListener("change", () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveDate, 500); });
 }
 // The labeled "Delete offtaker" button lives inside the editor (rendered into the
 // expanded body, so the list-level [data-del-offtaker] wiring never sees it).
 const del = box.querySelector(".rb-offedit-del[data-del-offtaker]");
 if (del) del.onclick = () => deleteOfftaker(del.getAttribute("data-del-offtaker"));
 });
 }

 // Pre-fill a commissioning-date input from the array's current setup, and if a
 // date is known, immediately render its expected GMP rate. Uses /setup-state
 // (which lists arrays with their first_connect_date). Legacy year-only values
 // were stored as Jan 1 of that year, so they show as YYYY-01-01, consistent
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
 if (overwrite) { // switching to an array with no saved date: don't
 inputEl.value = ""; // let the previous array's date linger and PATCH
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
 ACTIVE_DRAFT_ID = did; // preview tracks the edited draft
 // Optimistic repaint for what the preview/grid can show right now.
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
 const frac = Number(raw) / 100;
 // The share posts as allocation_pct, but on an own-meter (sub-metered)
 // offtaker it IS the group share (array_share_pct), update the field the
 // display reads so the optimistic repaint matches what the backend stores.
 if (d.array_share_pct != null) d.array_share_pct = frac;
 else d.allocation_pct = frac;
 const v = card && card.querySelectorAll(".rb-draft-grid .rb-v")[1];
 if (v) v.textContent = (Math.round((offtakerShareFrac(d) || 0) * 1000) / 10) + "%";
 }
 renderDraftDoc();
 const body = ofPatchBody(field, raw);
 if (body === null) return; // nothing to persist (blank required)
 scheduleOfftakerPatch(card, box, did, sid, body,
 OF_MONEY_FIELDS.has(field), OF_RECHECK_FIELDS.has(field));
 }

 // The master + sub dropdowns resolve to the offtaker's billing binding:
 // • utility_account_id = the sub-account when chosen (bill directly off their
 // own meter, topology A), else the master (bill their share of the group).
 // • array_id = the MASTER account's net-meter group array, what the
 // bill-accuracy cross-check reads the group-excess from. Sending BOTH keeps a
 // sub-meter distinct from its group host, so the GMP allocation cross-check
 // actually runs (otherwise the backend reads single_meter). The backend's
 // sub-meter invariant then re-derives the group share into array_share_pct.
 function onOfftakerUtilityPick(card, box, did, sid, masterSel, subSel) {
 const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
 if (!d) return;
 ACTIVE_DRAFT_ID = did;
 const uid = (subSel.value || masterSel.value || "").trim();
 if (uid === "") return; // nothing chosen → keep the current binding
 const body = { utility_account_id: Number(uid) };
 // The chosen master carries its group array_id (data-arr). When set, pin the
 // offtaker to that group so the audit reads the master's group-excess bill.
 const mOpt = masterSel.selectedOptions && masterSel.selectedOptions[0];
 const mArr = mOpt && mOpt.dataset ? mOpt.dataset.arr : "";
 if (masterSel.value && mArr) { body.array_id = Number(mArr); d.array_id = Number(mArr); }
 d.utility_account_id = Number(uid);
 renderDraftDoc();
 scheduleOfftakerPatch(card, box, did, sid, body, true, true);
 }

 function ofPatchBody(field, raw) {
 const v = String(raw == null ? "" : raw).trim();
 switch (field) {
 case "allocation_pct": return v === "" ? null : { allocation_pct: Number(v) / 100 };
 case "discount_pct": return v === "" ? { discount_pct: null } : { discount_pct: Number(v) / 100 };
 case "net_rate_per_kwh": return { net_rate_per_kwh: v === "" ? null : Number(v) };
 case "budget_amount_usd": return { budget_amount_usd: v === "" ? null : Number(v) };
 // Bill-accuracy flag threshold (Bruce 2026-07-07): percentage points, sent as-is;
 // blank clears it (the check falls back to the fleet default). NOT a money field —
 // it never changes the amount, only how tight the accuracy flag is.
 case "crosscheck_threshold_pct": return { crosscheck_threshold_pct: v === "" ? null : Number(v) };
 // Sequential-numbering seed: whole number; blank clears (back to date-based).
 case "invoice_number_start": return { invoice_number_start: v === "" ? null : Math.trunc(Number(v)) };
 case "utility_account_id": return v === "" ? null : { utility_account_id: Number(v) };
 case "customer_name": return v === "" ? null : { customer_name: v };
 case "client_email": return { client_email: v };
 case "cc_emails": return { cc_emails: v };
 case "cadence": return { cadence: v };
 case "send_mode": return { send_mode: v };
 default: return null;
 }
 }

 function scheduleOfftakerPatch(card, box, did, sid, body, isMoney, isRecheck) {
 let p = OF_PENDING[sid];
 if (!p) p = OF_PENDING[sid] = { body: {}, money: false, recheck: false };
 Object.assign(p.body, body);
 p.money = p.money || isMoney;
 p.recheck = p.recheck || !!isRecheck;
 p.card = card; p.box = box; p.did = did;
 clearTimeout(p.timer);
 p.timer = setTimeout(() => flushOfftakerPatch(sid), 600);
 }

 async function flushOfftakerPatch(sid) {
 const p = OF_PENDING[sid];
 if (!p) return;
 delete OF_PENDING[sid];
 const { body, money, recheck, card, box, did } = p;
 const st = box && box.querySelector(".rb-offedit-status");
 const setSt = (cls, txt) => { if (st) { st.className = cls; if (txt !== undefined) st.textContent = txt; } };
 setSt("rb-status rb-busy", money ? "Recalculating…" : recheck ? "Re-checking…" : "Saving…");
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
 // A threshold-only edit doesn't move the amount, re-run just the draft's
 // cross-check so the strip re-evaluates against the new threshold, then done.
 if (!money && recheck) {
 try {
 const rg = await fetch(API + "/subscriptions/" + sid + "/draft",
 { method: "POST", headers: authHeaders() });
 const dg = await rg.json().catch(() => ({}));
 if (rg.ok) noteXcheck(sid, dg);
 } catch (e) { /* the strip just keeps its prior verdict */ }
 setSt("rb-status rb-ok", "Saved."); renderDraftDoc(); return;
 }
 if (!money) { setSt("rb-status rb-ok", "Saved."); renderDraftDoc(); return; }
 // Money changed → recompute the draft figures via the production path
 // (generate_draft → build_match → build_manual_match for GMP-bound offtakers).
 try {
 const rg = await fetch(API + "/subscriptions/" + sid + "/draft",
 { method: "POST", headers: authHeaders() });
 const dg = await rg.json().catch(() => ({}));
 // A share/rate edit re-runs the cross-check server-side, flip the strip
 // live so a just-corrected share clears the flag (or a bad one raises it).
 if (rg.ok) noteXcheck(sid, dg);
 const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
 if (rg.ok && dg.draft && d) {
 // Include budget_amount_usd + solar_credit_value so CLEARING a budget bill
 // (or changing it) updates the preview live, otherwise the local draft kept
 // the old budget and the two-row "Budgeted amount" display stayed stale until
 // a hard refresh re-fetched the draft.
 // Include net_rate_per_kwh + discount_pct so the calc dashboard reflects a
 // freshly-typed Solar credit rate LIVE, without these the local draft kept the
 // old rate and the dashboard fell back to the effective (post-discount) rate
 // instead of showing the rate the operator just set.
 ["array_total_kwh", "allocation_pct", "customer_kwh", "amount_usd",
 "invoice_number", "period_label", "budget_amount_usd",
 "solar_credit_value", "net_rate_per_kwh", "discount_pct",
 // Refresh the honest default-rate provenance so the "Override in effect"
 // ↔ "default: $X, <source>" helper tracks the just-saved rate live.
 "default_net_rate_per_kwh", "default_net_rate_source", "default_net_rate_note",
 "resolved_net_rate_per_kwh", "resolved_net_rate_source",
 // Re-rendered letter/subject so the preview email's kWh + $ update live
 // on a money edit (not just the figures grid), no hard refresh.
 "email_letter_default", "email_subject_default"].forEach(k => { if (k in dg.draft) d[k] = dg.draft[k]; });
 applyDraftFigures(card, d);
 setSt("rb-status rb-ok", "Saved · figures updated.");
 } else {
 setSt("rb-status rb-ok", "Saved · figures update once a GMP bill lands.");
 }
 } catch (e) { setSt("rb-status rb-ok", "Saved."); }
 } catch (e) { setSt("rb-status rb-err", "Network error."); }
 }

 // Repaint a draft card's number grid + the live preview from the updated draft
 // object, WITHOUT re-rendering the editor inputs (so the operator keeps focus).
 function applyDraftFigures(card, d) {
 if (card) {
 const vs = card.querySelectorAll(".rb-draft-grid .rb-v");
 const trip = draftDisplayTriple(d);
 const pct = trip.share != null ? Math.round(trip.share * 1000) / 10 : null;
 if (vs[0]) vs[0].textContent = fmt0(trip.total) + " kWh";
 if (vs[1]) vs[1].textContent = pct != null ? pct + "%" : "—";
 if (vs[2]) vs[2].textContent = fmt0(d.customer_kwh) + " kWh";
 if (vs[3]) vs[3].textContent = money(d.amount_usd);
 // Re-sync the auto-written note to the new figures, but only if it's still
 // the default (never clobber an email the operator has edited).
 const ta = card.querySelector(`textarea[data-draftmsg="${d.id}"]`);
 if (ta && d._defaultNote != null && ta.value === d._defaultNote) {
 const nn = d.email_letter_default || defaultDraftNote(d);
 ta.value = nn; d._defaultNote = nn;
 autoGrowMsg(ta); // re-fit after the note grows/shrinks
 }
 }
 if (card) { // the calc dashboard now lives in the form col;
 const calcEl = card.querySelector(".rb-calc"); // repaint it in place from the new figures
 if (calcEl) { calcEl.outerHTML = calcDashboard(d); wireCalcLinks(card); }
 // The solar-credit-rate row reflects the fresh figures. The one thing we must
 // NEVER clobber is the <input> the operator may be mid-typing in, so for an
 // input→input refresh we DON'T replace the field; we only refresh the octarine
 // "default: …" helper span (GMP) in place (VEC has no such span, so it's
 // untouched). A structural transition (input↔readonly, e.g. a GMP→VEC utility
 // rebind, or the just-cleared transient) does a full repaint.
 const rateFld = card.querySelector(".rb-rate-fld");
 if (rateFld) {
 const fresh = rateFieldHTML(d);
 const wasInput = !rateFld.hasAttribute("data-rate-readonly");
 const staysInput = fresh.indexOf("data-rate-readonly") === -1;
 if (wasInput && staysInput) {
 // In-place helper refresh only, keeps the input (and focus/caret) intact
 // while the "Override in effect" ↔ "default: $X" line tracks the new state.
 const inp = rateFld.querySelector("[data-of='net_rate_per_kwh']");
 const helper = rateFld.querySelector(".rb-rate-def");
 if (helper) {
 const tmp = document.createElement("template");
 tmp.innerHTML = fresh.trim();
 const freshHelper = tmp.content.querySelector(".rb-rate-def");
 if (freshHelper) helper.replaceWith(freshHelper);
 }
 // If the override was cleared elsewhere (blanked), sync the placeholder;
 // never overwrite a value the operator is actively typing.
 if (inp && d.net_rate_per_kwh == null && document.activeElement !== inp) {
 const def = gmpDefaultRate(d);
 inp.value = "";
 inp.placeholder = def.rate != null ? def.rate.toFixed(5) : "auto from bill";
 }
 } else {
 rateFld.outerHTML = fresh;
 // A readonly→input repaint (a utility rebind) mints a fresh manual input
 // that missed wireOfftakerEditors, wire it here so it saves like the rest.
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
 renderReviewTop(); // repaint the action buttons
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
 if (d.auto_attach_gmp !== false) extras.push(`the ${offtakerProviderLabel(d) || "utility"} bill`);
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
 // the actual send (this was the "Approve & send does nothing" bug, st was
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
 const res = data.result || {};
 const to = (res.to || []).join(", ");
 let extra = "";
 if (res.pay_url) {
 extra = " · pay link attached";
 try { await loadOfftakerPayments(); } catch (e) { /* ignore */ }
 } else if (res.pay_skip_reason) {
 extra = " · no pay link: " + String(res.pay_skip_reason).slice(0, 90);
 }
 setSt("rb-status rb-ok", "Test sent to " + (to || "you") + extra + ", check your inbox.");
 } else {
 setSt("rb-status rb-err", apiErr(data, "Test send failed."));
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
 setSt("rb-status rb-err", apiErr(data, "Couldn't write the email."));
 return;
 }
 if (ta) { ta.value = data.email; autoGrowMsg(ta); }
 const d = INBOX_DRAFTS.find(x => String(x.id) === String(id));
 if (d) d.note = data.email; // preview + send use this note
 ACTIVE_DRAFT_ID = id; renderDraftDoc();
 // Persist it so Approve/Send uses it even without a separate Save click.
 try {
 await fetch(API + "/drafts/" + id, {
 method: "PATCH",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ note: data.email }),
 });
 } catch (e) { /* the textarea still holds it; Save email persists it */ }
 setSt("rb-status rb-ok", "✨ Written + saved, review, edit anything, then send.");
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
 const ok = await AODialog.confirm("It's removed from your inbox without emailing the offtaker.", { title: "Dismiss this drafted report?" });
 if (!ok) return;
 setSt("rb-status rb-busy", "Dismissing…");
 await fetch(API + "/drafts/" + id + "/dismiss", { method: "POST", headers: authHeaders() });
 await refreshInbox();
 return;
 }
 if (act === "approve") {
 const ok = await AODialog.confirm("This sends the invoice email to the offtaker right now.", { title: "Approve and send this report?", confirmLabel: "Send now" });
 if (!ok) return;
 setSt("rb-status rb-busy", "Sending…");
 try {
 const r = await fetch(API + "/drafts/" + id + "/approve", { method: "POST", headers: authHeaders() });
 const data = await r.json().catch(() => ({}));
 if (r.ok && data.ok) {
 const res = data.result || {};
 const to = (res.to || []).join(", ");
 let extra = "";
 if (res.pay_url) {
 extra = " · pay link attached";
 // Refresh payment chips so this offtaker shows "Pay link open".
 try { await loadOfftakerPayments(); } catch (e) { /* ignore */ }
 } else if (res.pay_skip_reason) {
 extra = " · no pay link (" + String(res.pay_skip_reason).slice(0, 80) + ")";
 }
 setSt("rb-status rb-ok", "Sent" + (to ? " to " + to : "") + extra + ".");
 setTimeout(refreshInbox, 900);
 } else {
 setSt("rb-status rb-err", apiErr(data, "Send failed."));
 }
 } catch (err) { setSt("rb-status rb-err", "Network error."); }
 }
 }

 async function previewDraftInvoice(subId, st, win) {
 // Stream the invoice PDF for this draft's subscription into the pre-opened tab
 // (opened synchronously by the click so it isn't popup-blocked).
 // st (the card's status span) can be null if the card re-rendered between the
 // click and here, guard every write so it never throws (Sentry PYTHON-FASTAPI-4).
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

 /** Open the bulk offtaker roster import panel (toolbar button + deep links). */
 function openBulkImport() {
 MANUAL_OPEN = false;
 try { renderManual(); } catch (e) {}
 BULK_OPEN = true;
 renderBulkImport();
 requestAnimationFrame(() => {
 const host = document.getElementById("rbBulkHost");
 if (!host) return;
 const target = host.querySelector(".rb-add-panel") || host;
 try { target.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
 });
 }
 window.__aoOpenBulkImport = openBulkImport;

 /** Deep link: /?setup=offtakers#reports or /?bulk=1#reports opens Bulk import. */
 function maybeOpenBulkFromQuery() {
 try {
 const q = new URLSearchParams(location.search || "");
 if (q.get("setup") === "offtakers" || q.get("bulk") === "1") {
 openBulkImport();
 // Scrub so a refresh doesn't re-open forever; keep #reports hash.
 q.delete("setup");
 q.delete("bulk");
 const qs = q.toString();
 history.replaceState({}, "", location.pathname + (qs ? "?" + qs : "") + (location.hash || "#reports"));
 }
 } catch (e) {}
 }

 // If the Reports tab is the active hash on first load, render immediately.
 if (location.hash === "#reports") {
 document.addEventListener("DOMContentLoaded", async () => {
 await load();
 maybeOpenBulkFromQuery();
 });
 }

 // When the user lands later via hashchange (sandbox applyView → loadReports),
 // still honor setup=offtakers after the shell exists.
 const _prevLoad = window.__aoLoadReports;
 window.__aoLoadReports = async function (opts) {
 const r = await (_prevLoad ? _prevLoad(opts) : load(opts));
 if (location.hash === "#reports") maybeOpenBulkFromQuery();
 return r;
 };
})();
