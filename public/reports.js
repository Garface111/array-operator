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

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function authHeaders() { const s = session(); return s ? { Authorization: "Bearer " + s } : null; }

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
    if (!accts.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>No utility bills connected yet — offtaker invoices bill from your utility bills, so link a utility to get started.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button" tabindex="0">Link utility bills →</a></div>`;
      wireConnectUtility();
    } else if (!withBills.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>${accts.length} utility account${accts.length === 1 ? "" : "s"} connected, but no bills have landed yet — open your utility portal once more so the extension captures them.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button" tabindex="0">Link utility bills →</a></div>`;
      wireConnectUtility();
    } else {
      host.innerHTML = `<div class="rb-gmp-ok">✓ ${withBills.length} utility bill source${withBills.length === 1 ? "" : "s"} connected — available to link when you add an offtaker.</div>`;
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
      <div id="rbSubInvoice" class="rb-subpanel">
      <div class="rb-listwrap">
        <div class="cc-treedivider rb-list-head">
          <div>
            <h3>Your offtakers</h3>
          </div>
          <div class="rb-head-actions">
            <button class="ao-btn rb-btn" id="rbLinkUtility" type="button" title="Connect the utility whose bills you invoice against — GMP, VEC, or any of ~470 supported utilities nationwide. Offtakers bill from these utility bills.">🔗 Link utility bills</button>
            <button class="ao-btn rb-btn" id="rbBulkImport" type="button" title="Add many offtakers at once from a CSV roster — name, percent share, and (ideally) account number.">⬆ Bulk import</button>
            <button class="ao-btn ao-btn-primary rb-btn" id="rbCustAdd" type="button">＋ Add an offtaker</button>
          </div>
        </div>
        <!-- The operator-wide MASTER generation spreadsheet card was removed from the top
             (Ford 2026-06-28 — it didn't pull its weight and cluttered the main screen).
             Each offtaker still has its OWN sheet inside its accordion card (.rb-track-sub). -->
        <div class="rb-gmpbills-status" id="rbGmpBillsStatus"></div>
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
        if (st) { st.className = "rb-status rb-ok"; st.textContent = "Added to your approval inbox (Invoice generator tab) — review, edit the email, then send."; }
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

  // Build the #rbmUtility <option> list from utility accounts. When `keep` is set
  // (the value selected before a refresh), it's re-selected if it still exists, so
  // an in-flight new-offtaker form never loses the operator's pick mid-edit.
  function fillUtilitySelect(sel, accts, keep) {
    const fld = sel.closest(".rep-fld");
    // Remove any stale "link first" helper button — once accounts exist it's noise.
    const oldBtn = fld && fld.querySelector(".rbm-link-gmp");
    if (!accts.length) {
      sel.innerHTML = `<option value="">No utility bills yet — link your utility first</option>`;
      // Make the empty state ACTIONABLE: drop a Link-utility button right here so the
      // operator can connect their utility (any supported one) without hunting for it.
      if (fld && !oldBtn) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ao-btn rb-btn rbm-link-gmp";
        btn.textContent = "🔗 Link utility bills";
        btn.style.marginTop = "6px";
        btn.onclick = () => { if (window.__aoLinkUtility) window.__aoLinkUtility(); else location.hash = "#arrays"; };
        fld.appendChild(btn);
      }
      return;
    }
    if (oldBtn) oldBtn.remove();   // accounts arrived — the link prompt is no longer needed
    sel.innerHTML = `<option value="">Choose a utility account…</option>` +
      accts.map(a => {
        const prov = (a.provider || "gmp").toLowerCase();
        const isGmp = prov === "gmp";
        const tag = isGmp ? "" : prov.toUpperCase() + " · ";
        const label = a.nickname || a.array_name || ((isGmp ? "GMP " : prov.toUpperCase() + " ") + a.account_number);
        // GMP bills from the paper bill; VEC/SmartHub bills from measured
        // generation × the rate you set (no GMP-shaped bill on file for them).
        const note = isGmp
          ? (a.has_bill ? `${a.bill_count} bill${a.bill_count === 1 ? "" : "s"} · latest ${a.latest_period_label || "—"}` : "no bill on file yet")
          : "bills from measured generation × your rate";
        return `<option value="${a.utility_account_id}">${esc(tag + label)} · acct ${esc(a.account_number)} (${esc(note)})</option>`;
      }).join("");
    // Preserve the operator's selection across a rebuild if it's still valid.
    if (keep && sel.querySelector(`option[value="${(window.CSS && CSS.escape) ? CSS.escape(keep) : keep}"]`)) {
      sel.value = keep;
    }
  }

  // Fetch utility accounts and (re)fill #rbmUtility in place. `preserveCurrent`
  // keeps whatever the operator already picked. Used both on first render and when
  // a new bill-link capture lands while the add-offtaker panel is open.
  function refreshUtilitySelect(preserveCurrent) {
    const sel = $("#rbmUtility");
    if (!sel) return;                                  // add panel not open
    const keep = preserveCurrent ? sel.value : "";
    fetchUtilityAccounts().then(accts => {
      const s = $("#rbmUtility");                      // re-query: the panel may have closed mid-fetch
      if (s) fillUtilitySelect(s, accts, keep);
    });
  }

  // When the extension lands a GMP/VEC bill capture, sandbox.js dispatches
  // ao:utility-accounts-changed. If the new-offtaker form is open, repopulate the
  // utility picker in place (preserving the current pick) so the freshly-linked
  // account appears without a manual page refresh.
  window.addEventListener("ao:utility-accounts-changed", () => {
    if (MANUAL_OPEN && $("#rbmUtility")) refreshUtilitySelect(true);
  });

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
          ? "Bill an offtaker for a share of an array's production — billed <b>only</b> from the GMP utility bill you select below (the paper bill), never from inverter data."
          : "Already bill in your own spreadsheet? Drop it and we'll keep invoicing in <b>that exact format</b> every cycle."}</p>

        <div id="rbAddManual" ${ADD_MODE === "manual" ? "" : "hidden"}>
          <div class="rb-mform-grid">
            <label class="rep-fld"><span class="rl">Offtaker name</span>
              <input type="text" id="rbmName" placeholder="e.g. Sunnybrook Apartments"></label>
            <label class="rep-fld"><span class="rl">Which utility account?</span>
              <select id="rbmUtility"><option value="">Loading utility accounts…</option></select>
              <span class="rb-fld-hint">GMP offtakers bill from the paper bill; VEC/SmartHub offtakers bill from measured generation × the credit rate you set.</span></label>
            <label class="rep-fld"><span class="rl">Their share of the array (%)</span>
              <input type="number" id="rbmPct" min="0.01" max="100" step="0.01" placeholder="e.g. 25">
              <span class="rb-fld-hint">Enter 100% if this offtaker is part of a net-metered group.</span></label>
            <label class="rep-fld"><span class="rl">Discount (% off solar credit rate)</span>
              <input type="number" id="rbmRate" min="0" max="99" step="1" placeholder="blank = use my default">
              <span class="rb-fld-hint">Leave blank to use your default discount (10% off).</span></label>
            <label class="rep-fld"><span class="rl">Solar credit rate ($/kWh)</span>
              <input type="number" id="rbmCreditRate" min="0" step="0.0001" placeholder="blank = auto from bill">
              <span class="rb-fld-hint">Leave blank to use the credit rate from the GMP bill.</span></label>
            <label class="rep-fld"><span class="rl">Client email</span>
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
          <p class="rb-autosend-note" id="rbmAutoNote" hidden>⚡ With <b>Auto-send</b>, each invoice
             emails to your offtaker automatically — sent under <b>your name</b>, with replies coming to
             your email. Your offtaker never sees any Array Operator branding.</p>
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
      // Populate the GMP/VEC utility-bill picker. Offtakers bind to a utility
      // account; their invoice is generated from THAT account only. Fetch + fill
      // via the shared refreshUtilitySelect so an extension capture (linking new
      // bills) can rebuild this in place without a page refresh (see the
      // ao:utility-accounts-changed listener below).
      refreshUtilitySelect(false);
    } else {
      // Upload path: wire the dropzone + paint the live doc-preview placeholder.
      wireUpload();
      renderDoc();
    }
  }

  async function saveManual() {
    const st = $("#rbmStatus");
    const name = $("#rbmName").value.trim();
    const utilityId = $("#rbmUtility").value;
    const pctRaw = $("#rbmPct").value.trim();
    const rateRaw = $("#rbmRate").value.trim();
    const creditRateRaw = $("#rbmCreditRate") ? $("#rbmCreditRate").value.trim() : "";
    // The "Send to" slider was removed — offtaker invoices go to the offtaker and
    // the operator is BCC'd on every send (so they always see what was received).
    const mode = "to_client";
    const clientEmail = $("#rbmEmail").value.trim();
    if (!name) { st.className = "rb-status rb-err"; st.textContent = "Enter the offtaker's name."; return; }
    if (!utilityId) { st.className = "rb-status rb-err"; st.textContent = "Pick which GMP utility bill connects to this offtaker."; return; }
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
    if ((mode === "to_client" || mode === "to_both") && !clientEmail) {
      st.className = "rb-status rb-err"; st.textContent = "Add the client's email to send to them."; return;
    }
    st.className = "rb-status rb-busy"; st.textContent = "Adding offtaker…";
    const fd = new FormData();                       // no file → manual path
    fd.append("customer_name", name);
    fd.append("utility_account_id", utilityId);          // offtaker ↔ utility bill (utility data ONLY)
    fd.append("allocation_pct", String(pctNum / 100));   // backend wants a fraction in (0,1]
    if (rateNum !== null) fd.append("discount_pct", String(rateNum / 100));
    if (creditRateNum !== null) fd.append("net_rate_per_kwh", String(creditRateNum));
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
      MANUAL_OPEN = false;
      renderManual();
      if (MANUAL_AFTER_ADD) await MANUAL_AFTER_ADD();
      else await refreshList();
    } catch (e) {
      st.className = "rb-status rb-err"; st.textContent = "Network error while adding.";
    }
  }

  // ---- bulk offtaker import (CSV roster → many offtakers at once) -----------
  let BULK_OPEN = false;
  let BULK_PREVIEW = null;   // the dry-run preview from the server: {rows, summary}
  let BULK_FILE = null;      // the File we previewed, re-sent on confirm

  function renderBulkImport() {
    const host = $("#rbBulkHost");
    if (!host) return;
    if (!BULK_OPEN) { host.innerHTML = ""; BULK_PREVIEW = null; BULK_FILE = null; return; }

    if (!BULK_PREVIEW) {
      // ── Step 1: drop the CSV ──
      host.innerHTML = `
        <div class="rep-card rb-manual-form rb-add-panel">
          <div class="rb-add-head">
            <h3>Bulk import offtakers</h3>
            <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkCancel" type="button">Cancel</button>
          </div>
          <p class="rb-add-sub">A CSV roster — one row per offtaker. We'll show you exactly what we
            matched before creating anything.</p>
          <div class="rb-upload" id="rbBulkDrop">
            <label class="rb-drop" id="rbBulkDropZone">
              <input type="file" id="rbBulkFile" accept=".csv,.txt" hidden>
              <span class="rb-drop-ico">⬆</span>
              <span class="rb-drop-main">Choose a CSV or drop it here</span>
              <span class="rb-drop-sub">.csv — exported from Excel or Google Sheets</span>
            </label>
            <p class="rb-sample-hint">Columns we recognize (any order, header row required):
              <b>Name</b>, <b>Percent</b> (e.g. 25 or 25%), and ideally <b>Account Number</b>
              (so each offtaker links to the right utility bill — skip it only if you have
              just one utility account connected). <b>Email</b> and <b>Discount</b> are optional.</p>
            <div class="rb-status" id="rbBulkStatus"></div>
          </div>
        </div>`;
      $("#rbBulkCancel").onclick = () => { BULK_OPEN = false; renderBulkImport(); };
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

    // ── Step 2: review the match table, then confirm ──
    const rows = BULK_PREVIEW.rows || [];
    const s = BULK_PREVIEW.summary || {};
    const rowHtml = rows.map(r => {
      const ok = !r.errors.length;
      const pctTxt = r.allocation_pct != null ? Math.round(r.allocation_pct * 1000) / 10 + "%" : "—";
      return `<tr class="${ok ? "rb-bulk-ok" : "rb-bulk-err"}">
        <td>${r.row}</td>
        <td>${esc(r.name || "—")}</td>
        <td>${esc(r.email || "—")}</td>
        <td>${esc(pctTxt)}</td>
        <td>${esc(r.matched_account_label || (r.account_number ? "no match for “" + r.account_number + "”" : "—"))}</td>
        <td>${ok ? "✓ ready" : "⚠ " + esc(r.errors.join("; "))}</td>
      </tr>`;
    }).join("");
    host.innerHTML = `
      <div class="rep-card rb-manual-form rb-add-panel">
        <div class="rb-add-head">
          <h3>Bulk import — review</h3>
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbBulkCancel" type="button">Cancel</button>
        </div>
        <p class="rb-add-sub">
          <b>${s.ready || 0} of ${s.total || 0}</b> ready to import.
          ${s.needs_attention ? `<b>${s.needs_attention}</b> need attention and won't be created — fix your CSV and re-upload, or import the rest now and add those by hand.` : ""}
        </p>
        <div class="rb-bulk-tablewrap">
          <table class="rb-bulk-table">
            <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>%</th><th>Utility account</th><th>Status</th></tr></thead>
            <tbody>${rowHtml}</tbody>
          </table>
        </div>
        <div class="rb-actions">
          <button class="ao-btn ao-btn-ghost" id="rbBulkBack" type="button">← Choose a different file</button>
          <button class="ao-btn ao-btn-primary rb-save" id="rbBulkConfirm" type="button"
                  ${s.ready ? "" : "disabled"}>Import ${s.ready || 0} offtaker${s.ready === 1 ? "" : "s"}</button>
          <span class="rb-status" id="rbBulkStatus2"></span>
        </div>
      </div>`;
    $("#rbBulkCancel").onclick = () => { BULK_OPEN = false; renderBulkImport(); };
    $("#rbBulkBack").onclick = () => { BULK_PREVIEW = null; BULK_FILE = null; renderBulkImport(); };
    $("#rbBulkConfirm").onclick = bulkConfirmImport;
  }

  async function bulkPreviewFile(file) {
    BULK_FILE = file;
    const status = $("#rbBulkStatus");
    if (status) { status.className = "rb-status rb-busy"; status.textContent = "Reading " + file.name + "…"; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("dry_run", "true");
      const r = await fetch(API + "/subscriptions/bulk-import", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (status) {
          status.className = "rb-status rb-err";
          status.textContent = (data && data.detail) ? data.detail : "Couldn't read that file (HTTP " + r.status + ").";
        }
        return;
      }
      BULK_PREVIEW = data;
      renderBulkImport();
    } catch (e) {
      if (status) { status.className = "rb-status rb-err"; status.textContent = "Network error while reading the file."; }
    }
  }

  async function bulkConfirmImport() {
    const st = $("#rbBulkStatus2");
    if (!BULK_FILE) return;
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Importing…"; }
    const btn = $("#rbBulkConfirm"); if (btn) btn.disabled = true;
    try {
      const fd = new FormData();
      fd.append("file", BULK_FILE);
      fd.append("dry_run", "false");
      const r = await fetch(API + "/subscriptions/bulk-import", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (st) { st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Import failed (HTTP " + r.status + ")."; }
        if (btn) btn.disabled = false;
        return;
      }
      BULK_OPEN = false; BULK_PREVIEW = null; BULK_FILE = null;
      renderBulkImport();
      await refreshList();
    } catch (e) {
      if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error during import."; }
      if (btn) btn.disabled = false;
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
  function groupOfftakersByUtility(rows, utilAccts) {
    if (!rows || rows.length <= 5) return null;
    const acctById = {};
    (utilAccts || []).forEach(a => { if (a.utility_account_id != null) acctById[String(a.utility_account_id)] = a; });
    const groups = {};
    const order = [];
    rows.forEach(s => {
      const key = s.utility_account_id != null ? "u:" + s.utility_account_id
        : s.array_id != null ? "a:" + s.array_id
        : "u:none";
      if (!groups[key]) {
        const acct = s.utility_account_id != null ? acctById[String(s.utility_account_id)] : null;
        const label = acct
          ? `${(acct.provider || "").toUpperCase()} · ${acct.nickname || acct.account_number || s.utility_account_id}`
          : (s.utility_account_name || ((ACC_ARRS || []).find(a => String(a.id) === String(s.array_id)) || {}).name || "Ungrouped");
        groups[key] = { key, label, pctSum: 0, hasDraft: false, rows: [] };
        order.push(key);
      }
      const g = groups[key];
      g.rows.push(s);
      g.pctSum += Number(s.allocation_pct) || 0;
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

  // The "do this utility account's offtaker shares add up to 100%?" pill shown on
  // each group header — the direct answer to "an indicator that shows me how all of
  // those offtakers add up to a hundred percent" (Ford). Hovering it reveals a
  // breakdown popover ("show me how it was calculated"): every offtaker's share,
  // listed, then summed. A small epsilon absorbs float/rounding noise from
  // percent-entry; real over/under-allocation still shows as a warning.
  function pctSumPill(group) {
    const pct = Math.round((group.pctSum || 0) * 1000) / 10;   // fraction -> 1-decimal percent
    const within = Math.abs(pct - 100) <= 0.5;
    const cls = within ? "rb-grp-pct-ok" : "rb-grp-pct-warn";
    const label = within
      ? `✓ ${pct}% allocated`
      : `⚠ ${pct}% allocated — ${pct > 100 ? "over-allocated" : "under-allocated"}`;
    // Breakdown rows — each offtaker's share, biggest first so the math reads top-down.
    const rows = (group.rows || []).slice().sort((a, b) =>
      (Number(b.allocation_pct) || 0) - (Number(a.allocation_pct) || 0));
    const rowHtml = rows.map(s => {
      const p = s.allocation_pct != null ? Math.round(s.allocation_pct * 1000) / 10 : 0;
      return `<span class="rb-grp-pop-row"><span class="rb-grp-pop-who">${esc(s.customer_name || "(unnamed)")}</span><span class="rb-grp-pop-pct">${p}%</span></span>`;
    }).join("");
    const sumCls = within ? "rb-grp-pop-sum-ok" : "rb-grp-pop-sum-warn";
    return `<span class="rb-grp-pctwrap">
      <span class="rb-grp-pct ${cls}" tabindex="0" aria-describedby="">${label}</span>
      <span class="rb-grp-pct-pop" role="tooltip">
        <span class="rb-grp-pop-title">How this adds up — ${rows.length} offtaker${rows.length === 1 ? "" : "s"} on this utility bill</span>
        ${rowHtml}
        <span class="rb-grp-pop-row rb-grp-pop-sum ${sumCls}"><span class="rb-grp-pop-who">Total allocated</span><span class="rb-grp-pop-pct">${pct}%</span></span>
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
    // Above 5 offtakers, group by shared utility account (Ford) — each group gets a
    // header naming the utility account + a "do these shares add up to 100%" pill,
    // with the existing draft-first/alphabetical order preserved WITHIN each group.
    const groups = groupOfftakersByUtility(OFFTAKERS, utilAccts);
    const body = groups
      ? groups.map(g => {
          // The WHOLE group header toggles collapse of its offtaker cards (Ford:
          // "click on GMP Appalachian Community Array 1 and it should collapse all
          // of the offtakers into it"). Same gesture as the vendor-sheet collapse.
          // Groups DEFAULT to collapsed (Ford: "everything on the offtaker invoice
          // generator should default to being collapsed") — a fresh load shows just
          // the utility-bill headers; expand the one you want. First-seen key inits
          // to collapsed; after that the toggle owns its state.
          if (GROUP_COLLAPSED[g.key] === undefined) GROUP_COLLAPSED[g.key] = true;
          const collapsed = !!GROUP_COLLAPSED[g.key];
          return `
          <div class="rb-grp${collapsed ? " collapsed" : ""}">
            <div class="rb-grp-head" data-grpcollapse="${esc(g.key)}" role="button" tabindex="0"
                 aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Collapse"} the offtakers on this utility bill">
              <span class="rb-grp-caret" aria-hidden="true">▾</span>
              <span class="rb-grp-label">${esc(g.label)}</span>
              <span class="rb-grp-count">${g.rows.length} offtaker${g.rows.length === 1 ? "" : "s"}</span>
              ${pctSumPill(g)}
            </div>
            <div class="rb-grp-rows"${collapsed ? " hidden" : ""}>
              ${g.rows.map(s => subCard(s, arrs, utilAccts)).join("")}
            </div>
          </div>`;
        }).join("")
      : OFFTAKERS.map(s => subCard(s, arrs, utilAccts)).join("");
    list.innerHTML = `<div class="rb-acc-lead">${headLine}</div>` + body;
    wireAccordionHeaders(list);
    // Collapse/expand all offtakers under one utility-bill group. Whole header is the
    // target; the pill's hover-breakdown still works (the pill wrapper stops propagation
    // below so reading the breakdown never also collapses). Keyboard-accessible.
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
  let DRAFT_BY_SUB = {};        // subscription_id -> its pending draft (refs INTO INBOX_DRAFTS)
  let ACTIVE_SUB_ID = null;     // the offtaker under review — the source of truth for the view
  let GROUP_COLLAPSED = {};     // utility-account group key -> bool; collapses every offtaker
                                // card under one utility bill at once. DEFAULTS to collapsed
                                // (each first-seen group key inits to true in renderAccordion).
                                // Persists across refreshes (module-level, keyed by stable
                                // utility_account_id), un-persisted across reloads — so a fresh
                                // load always opens fully collapsed. Same map as vendor-sheet.
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
          const r = await fetch(API + "/drafts/" + did, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ note: ta.value }),
          });
          const t = tag(); if (t) t.textContent = r.ok ? "✓ saved" : "couldn’t save";
          const d = INBOX_DRAFTS.find(x => String(x.id) === String(did));
          if (d) d.note = ta.value;
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
    const disc = d.discount_pct ? Math.round(d.discount_pct * 100) : 0;
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
    const rateMath = (shownRate != null && d.customer_kwh != null)
      ? `${fmt0(d.customer_kwh)} kWh × ${ratePfx}$${Number(shownRate).toFixed(5)}/kWh${(explicitRate && disc) ? ` × (1−${disc}%)` : ""}`
      : (explicitRate ? "" : "from the bill's net-metering credit");
    const rateRow =
      `<div class="rb-calc-row"><span class="rb-calc-k">Solar credit rate`
      + `${explicitRate ? "" : "<small>effective — from the bill's net-metering credit</small>"}</span>`
      + `<span class="rb-calc-v">${rateTxt}${(explicitRate && disc) ? ` <span class="rb-calc-eq">− ${disc}%</span>` : ""}</span></div>`;
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
    const note = ta ? ta.value : (d.note || defaultDraftNote(d));
    const autoCb = card && card.querySelector('input[data-dact="autogmp"]');
    const autoOn = autoCb ? autoCb.checked : (d.auto_attach_gmp !== false);
    const sumCb = card && card.querySelector('input[data-dact="summary"]');
    const sumOn = sumCb ? sumCb.checked : (d.include_summary === true);   // OFF by default

    const period = d.period_label || "latest period";
    const kwh = d.customer_kwh != null ? fmt0(d.customer_kwh) + " kWh" : "—";

    // ── Envelope — faithful to the backend's _email_html (subject/from/to). ──
    const subject = `Your solar credit invoice — ${d.customer_name || "your offtaker"}`
      + (d.invoice_number ? ` (${d.invoice_number})` : "");
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
    d._defaultNote = defaultDraftNote(d);
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
          placeholder="Write the note your offtaker sees…">${esc(d.note || defaultDraftNote(d))}</textarea>
        <span class="rb-draft-msg-hint">Saves automatically as you type. The invoice${d.has_gmp_pdf ? " + GMP bill are" : " is"} attached for you.</span>
      </div>`;
    // The per-offtaker template box (#rbTpl) is folded into .rb-tpl-slot by foldTplIntoInbox.
    const tplSlot = `<div class="rb-tpl-slot"></div>`;
    const trackerBox = sid
      ? `<div class="rb-track rb-track-sub" data-tracker-base="${API}/subscriptions/${sid}/tracker" data-tracker-scope="offtaker" data-tracker-name="${esc(d.customer_name || "")}" hidden></div>`
      : `<p class="rb-sec-empty">Save this offtaker to add a generation spreadsheet.</p>`;
    return `
      <div class="rb-draft" data-did="${d.id}" data-subid="${d.subscription_id}">
        <div class="rb-draft-top">
          <div class="rb-draft-name">${esc(d.customer_name)}</div>
          <div class="rb-draft-period">${esc(d.period_label || "latest period")}</div>
        </div>
        ${sec("Offtaker details", offtakerEditor(d, utilAccts) + attachBox, "share, rate, schedule, delivery", false)}
        ${sec("Edit email", emailBody, "the note your offtaker sees", false)}
        ${sec("Invoice template", tplSlot, "PDF / Excel format", false)}
        ${sec("Generation spreadsheet", trackerBox, "their tracking sheet", false)}
        ${sec("How this was calculated", calcDashboard(d), "the math behind the amount", false)}
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

  function offtakerEditor(d, utilAccts) {
    const sid = d.subscription_id;
    if (!sid) return "";
    const wb = d.has_workbook === true;        // workbook offtakers bill from the sheet
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : "";
    const disc = d.discount_pct != null ? Math.round(d.discount_pct * 1000) / 10 : "";
    const rate = d.net_rate_per_kwh != null ? d.net_rate_per_kwh : "";
    const cad = d.cadence || "monthly";
    const sm = d.send_mode || "to_me";
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
        <div class="rb-cust-grid rb-offedit-grid">
          <label class="rep-fld"><span class="rl">Offtaker name</span>
            <input type="text" data-of="customer_name" value="${esc(d.customer_name || "")}"></label>
          ${showBillPicker ? `
          <label class="rep-fld"><span class="rl">Which utility account?</span>
            <select data-of="utility_account_id">
              <option value="">${d.utility_account_id ? "— keep current —" : "Select a utility account…"}</option>
              ${billOpts}
            </select></label>` : ""}
          <label class="rep-fld"><span class="rl">Their share of the array (%)</span>
            <input type="number" data-of="allocation_pct" min="0.01" max="100" step="0.01" value="${pct}" placeholder="e.g. 25">
            <span class="rb-fld-hint">Enter 100% if this offtaker is part of a net-metered group.</span></label>
          <label class="rep-fld"><span class="rl">Discount (% off the credit rate)</span>
            <input type="number" data-of="discount_pct" min="0" max="100" step="0.1" value="${disc}" placeholder="e.g. 10"></label>
          <label class="rep-fld"><span class="rl">Solar credit rate ($/kWh)</span>
            <input type="number" data-of="net_rate_per_kwh" min="0" step="0.0001" value="${rate}" placeholder="blank = auto from bill"></label>
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
              <option value="both" ${sm === "both" ? "selected" : ""}>Both</option>
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
          st2.textContent = (p && p.added_count > 0)
            ? "✓ Updated spreadsheet produced — added " + p.added.join(", ") + ". Download it below."
            : "✓ Processed — your spreadsheet is up to date through the latest bill.";
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
  const OF_MONEY_FIELDS = new Set(["utility_account_id", "allocation_pct", "discount_pct", "net_rate_per_kwh", "budget_amount_usd"]);
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
      // The labeled "Delete offtaker" button lives inside the editor (rendered into the
      // expanded body, so the list-level [data-del-offtaker] wiring never sees it).
      const del = box.querySelector(".rb-offedit-del[data-del-offtaker]");
      if (del) del.onclick = () => deleteOfftaker(del.getAttribute("data-del-offtaker"));
    });
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
        const nn = defaultDraftNote(d);
        ta.value = nn; d._defaultNote = nn;
        autoGrowMsg(ta);                              // re-fit after the note grows/shrinks
      }
    }
    if (card) {                                       // the calc dashboard now lives in the form col;
      const calcEl = card.querySelector(".rb-calc");  // repaint it in place from the new figures
      if (calcEl) { calcEl.outerHTML = calcDashboard(d); wireCalcLinks(card); }
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
          await fetch(API + "/drafts/" + id, {
            method: "PATCH",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify({ note: ta.value }),
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
      const note = ta ? ta.value : "";
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
