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
    try {
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      const page = await pdf.getPage(1);
      const cssW = Math.max(240, paper.clientWidth || 520);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (cssW / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      paper.innerHTML = "";
      paper.appendChild(canvas);
    } catch (e) { _pdfFallbackIframe(buf, paper); }
  }

  const MODEL_LABEL = {
    fixed_budget: "Fixed monthly budget",
    flat_rate: "Flat rate + true-up",
    percent_of_array: "% of array generation",
  };

  // pending match awaiting "Save schedule" — holds the File + parsed match.
  let PENDING = null;

  function root() { return document.getElementById("reportsRoot"); }

  // ---- top-level entry -------------------------------------------------------
  async function load() {
    const el = root();
    if (!el) return;
    if (!authHeaders()) {
      el.innerHTML = signInPrompt();
      return;
    }
    // The guided setup wizard was removed — the operator works the tab directly:
    // set the global rate, "＋ Add an offtaker", and link GMP bills, all inline.
    el.innerHTML = shell();
    wireSubtabs();
    wireGlobalRate();
    wireInvoiceTemplate();
    // "＋ Add an offtaker" opens a tabbed panel (Type it in / Upload a
    // spreadsheet); the upload zone + live doc-preview live inside that panel
    // now, so wireUpload()/renderDoc() are wired when the upload tab opens.
    MANUAL_HOST_ID = "rbCustManual";
    MANUAL_AFTER_ADD = refreshList;
    MANUAL_OPEN = false;
    const addBtn = $("#rbCustAdd");
    if (addBtn) addBtn.onclick = () => { MANUAL_OPEN = true; renderManual(); };
    // "Link GMP utility bills" — launches the REAL GMP connect flow (opens
    // greenmountainpower.com; the extension captures + lands the bills here).
    // Offtaker invoices bill from these utility bills only, so this is how the
    // operator gets bills to link an offtaker to. Reuses the same flow as the
    // onboarding gate's "Connect GMP" CTA (window.__aoConnectGmp).
    const linkGmpBtn = $("#rbLinkGmp");
    if (linkGmpBtn) linkGmpBtn.onclick = () => {
      if (window.__aoConnectGmp) { window.__aoConnectGmp(); }
      else { location.hash = "#arrays"; }   // defensive: sandbox owns the modal
    };
    await Promise.all([refreshInbox(), refreshList(), refreshGmpBillsStatus()]);
  }
  window.__aoLoadReports = load;

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
    if (!accts.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>No GMP utility bills connected yet — offtaker invoices bill from GMP utility bills, so connect GMP to link them.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button">Link GMP utility bills →</a></div>`;
      const a = $("#rbGmpInlineLink");
      if (a) a.onclick = () => { if (window.__aoConnectGmp) window.__aoConnectGmp(); else location.hash = "#arrays"; };
    } else if (!withBills.length) {
      host.innerHTML = `<div class="rb-gmp-empty">
        <span>${accts.length} GMP account${accts.length === 1 ? "" : "s"} connected, but no bills have landed yet — open GMP once more so the extension captures them.</span>
        <a class="rb-gmp-inline-link" id="rbGmpInlineLink" role="button">Open GMP →</a></div>`;
      const a = $("#rbGmpInlineLink");
      if (a) a.onclick = () => { if (window.__aoConnectGmp) window.__aoConnectGmp(); else location.hash = "#arrays"; };
    } else {
      host.innerHTML = `<div class="rb-gmp-ok">✓ ${withBills.length} GMP utility bill source${withBills.length === 1 ? "" : "s"} connected — available to link when you add an offtaker.</div>`;
    }
  }

  function signInPrompt() {
    return `<div class="rep-card"><span class="rep-eyebrow">Reports</span>
      <h3>Sign in to set up automatic reports</h3>
      <p>Upload a billing spreadsheet and we'll send invoices + performance
      summaries on the schedule you choose. <a href="/accounts" style="color:var(--good)">Sign in</a> to get started.</p></div>`;
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
            <button class="ao-btn rb-btn" id="rbLinkGmp" type="button" title="Connect Green Mountain Power so your utility bills flow in — offtakers bill from these bills only">🔗 Link GMP utility bills</button>
            <button class="ao-btn ao-btn-primary rb-btn" id="rbCustAdd" type="button">＋ Add an offtaker</button>
          </div>
        </div>
        <div class="rb-gmpbills-status" id="rbGmpBillsStatus"></div>
        <div id="rbCustManual"></div>
        <div id="rbList"><div class="empty" style="padding:22px 0;color:var(--faint)">Loading…</div></div>
      </div>
      <div class="rb-layout rb-tpl-layout">
        <div class="rb-col-form">
      <div class="rb-tpl rep-card" id="rbTpl">
        <div class="rb-tpl-main">
          <h3>Your invoice template</h3>
          <p>Upload your own invoice and every offtaker invoice will reproduce your exact format — PDF, Word, HTML, an image, or an Excel workbook (we'll find the invoice sheet inside it).</p>
        </div>
        <div class="rb-tpl-ctl">
          <input type="file" id="rbTplFile" accept=".pdf,.html,.htm,.docx,.doc,.png,.jpg,.jpeg,.xlsx,.xls,.xlsm" hidden>
          <button class="ao-btn ao-btn-primary rb-btn" id="rbTplPick" type="button">⬆ Upload template</button>
          <span class="rb-tpl-status" id="rbTplStatus">Checking…</span>
          <button class="ao-btn rb-btn rb-danger" id="rbTplDel" type="button" hidden>Remove</button>
        </div>
        <div class="rb-tpl-edit">
          <label class="rb-tpl-enable"><input type="checkbox" id="rbTplEnabled"> Use this template for my offtaker invoices</label>
        </div>
      </div>
        </div>
        <aside class="rb-col-doc" id="rbTplDocPane"></aside>
      </div>
      <div id="rbInboxWrap" class="rb-inbox-wrap"></div>
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

  async function saveCustCard(card) {
    const id = card.getAttribute("data-id");
    const st = card.querySelector(".rb-cust-status");
    const get = f => card.querySelector(`[data-f="${f}"]`);
    const body = {};

    const name = get("customer_name") && get("customer_name").value.trim();
    if (!name) { st.className = "rb-status rb-err"; st.textContent = "Offtaker name can't be empty."; return; }
    body.customer_name = name;

    const email = get("client_email") ? get("client_email").value.trim() : "";
    body.client_email = email;
    if (get("cc_emails")) body.cc_emails = get("cc_emails").value.trim();

    if (get("array_id")) {
      const av = get("array_id").value;
      if (av) body.array_id = Number(av);
    }
    // GMP utility bill (the billing source). Only send when one is chosen — the
    // blank "keep current" option leaves the existing binding untouched.
    if (get("utility_account_id")) {
      const uv = get("utility_account_id").value;
      if (uv) body.utility_account_id = Number(uv);
    }
    if (get("cadence")) {
      const cv = get("cadence").value;
      if (cv) body.cadence = cv;
    }
    if (get("allocation_pct")) {
      const raw = get("allocation_pct").value.trim();
      if (raw !== "") {
        const n = Number(raw);
        if (isNaN(n) || n <= 0 || n > 100) {
          st.className = "rb-status rb-err"; st.textContent = "Share must be a percent between 0 and 100."; return;
        }
        body.allocation_pct = n / 100;   // backend wants a fraction in (0,1]
      }
    }
    // solar credit rate ($/kWh): blank → null (auto-derive from the GMP bill);
    // positive number → per-offtaker override that wins over bill/reference rate.
    if (get("net_rate_per_kwh")) {
      const raw = get("net_rate_per_kwh").value.trim();
      if (raw === "") {
        body.net_rate_per_kwh = null;
      } else {
        const n = Number(raw);
        if (isNaN(n) || n < 0 || n > 5) {
          st.className = "rb-status rb-err"; st.textContent = "Solar credit rate must be 0–5 $/kWh, or blank to auto-read from the bill."; return;
        }
        body.net_rate_per_kwh = n;
      }
    }
    // discount: blank → null (clear → use the default 10% off); whole % → fraction.
    if (get("discount_pct")) {
      const raw = get("discount_pct").value.trim();
      if (raw === "") {
        body.discount_pct = null;
      } else {
        const n = Number(raw);
        if (isNaN(n) || n < 0 || n >= 100) {
          st.className = "rb-status rb-err"; st.textContent = "Discount must be 0–99 (% off), or blank."; return;
        }
        body.discount_pct = n / 100;   // backend stores a fraction in [0,1)
      }
    }
    // starting invoice #: blank → null (clear, back to date-based); whole number → set/seed.
    if (get("invoice_number_start")) {
      const raw = get("invoice_number_start").value.trim();
      if (raw === "") {
        body.invoice_number_start = null;
      } else {
        const n = parseInt(raw, 10);
        if (isNaN(n) || n < 0) {
          st.className = "rb-status rb-err"; st.textContent = "Starting invoice number must be a whole number, or blank."; return;
        }
        body.invoice_number_start = n;
      }
    }

    const ok = await patch(id, body, st);
    if (ok) {
      st.className = "rb-status rb-ok"; st.textContent = "Saved.";
      // keep the other tabs' lists fresh (name/rate show there too).
      refreshList();
    }
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
    const enabled = $("#rbTplEnabled"), htmlBox = $("#rbTplHtml"), tokens = $("#rbTplTokens");
    const saveBtn = $("#rbTplSave"), prevBtn = $("#rbTplPreview"), estatus = $("#rbTplEStatus");
    if (!pick || !fileIn || !status) return;
    const jsonHdr = () => Object.assign({ "Content-Type": "application/json" }, authHeaders() || {});
    function paint(t) {
      const has = t && t.has_template;
      status.textContent = has
        ? "On file: " + (t.filename || "your template") + ". " +
          (t.enabled ? "Used for your offtaker invoices." : "Saved — turn on below to use it.")
        : "No template yet — offtaker invoices use the standard format.";
      status.className = "rb-tpl-status" + (has ? " rb-tpl-have" : "");
      if (view) view.hidden = !(t && t.filename);
      if (del) del.hidden = !has;
      if (enabled && t) enabled.checked = !!t.enabled;
      // don't clobber unsaved edits in the textarea
      if (htmlBox && t && t.html != null && !htmlBox.dataset.dirty) htmlBox.value = t.html;
      if (tokens && t && t.tokens) tokens.innerHTML = "Tokens you can use: " +
        t.tokens.map(x => "<code>{{ " + x + " }}</code>").join(" ");
      // Feed the live draft preview so an uploaded/enabled template shows there now.
      TEMPLATE_STATE = t ? { enabled: !!t.enabled, html: t.html || "" } : null;
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
      try {
        const r = await fetch(API + "/invoice-template", { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        paint(r.ok ? d.template : null);
      } catch (e) { paint(null); }
      // keep the Master Account file library in sync after upload/remove/enable
      try { if (window.__aoReloadFiles) window.__aoReloadFiles(); } catch (e) {}
    }
    await refresh();
    pick.onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      status.textContent = "Uploading " + f.name + "…"; status.className = "rb-tpl-status rb-busy";
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await fetch(API + "/invoice-template", { method: "POST", headers: authHeaders(), body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { status.textContent = (d && d.detail) || "Upload failed."; status.className = "rb-tpl-status rb-err"; }
        else { if (htmlBox) htmlBox.dataset.dirty = ""; await refresh(); }
      } catch (e) { status.textContent = "Upload failed — check your connection."; status.className = "rb-tpl-status rb-err"; }
      fileIn.value = "";
    };
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
      if (!confirm("Remove your invoice template? Offtaker invoices go back to the standard format.")) return;
      try { await fetch(API + "/invoice-template", { method: "DELETE", headers: authHeaders() }); } catch (e) {}
      if (htmlBox) { htmlBox.value = ""; htmlBox.dataset.dirty = ""; }
      await refresh();
    };
    if (htmlBox) htmlBox.oninput = () => { htmlBox.dataset.dirty = "1"; };
    async function savePut(body, okMsg) {
      if (estatus) { estatus.textContent = "Saving…"; estatus.className = "rb-tpl-estatus rb-busy"; }
      try {
        const r = await fetch(API + "/invoice-template", { method: "PUT", headers: jsonHdr(), body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (estatus) { estatus.textContent = (d && d.detail) || "Save failed."; estatus.className = "rb-tpl-estatus rb-err"; } return false; }
        if (htmlBox) htmlBox.dataset.dirty = "";
        paint(d.template);
        if (estatus) { estatus.textContent = okMsg || "Saved."; estatus.className = "rb-tpl-estatus rb-ok"; }
        return true;
      } catch (e) { if (estatus) { estatus.textContent = "Save failed."; estatus.className = "rb-tpl-estatus rb-err"; } return false; }
    }
    if (enabled) enabled.onchange = () => savePut({ enabled: enabled.checked },
      enabled.checked ? "On — invoices will use your template." : "Off — using the standard format.");
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
            <label class="rep-fld"><span class="rl">Which GMP utility bill?</span>
              <select id="rbmUtility"><option value="">Loading utility bills…</option></select>
              <span class="rb-fld-hint">Offtaker invoices are generated from this GMP account's utility bills only.</span></label>
            <label class="rep-fld"><span class="rl">Their share of the array (%)</span>
              <input type="number" id="rbmPct" min="0.01" max="100" step="0.01" placeholder="e.g. 25"></label>
            <label class="rep-fld"><span class="rl">Discount (% off solar credit rate)</span>
              <input type="number" id="rbmRate" min="0" max="99" step="1" placeholder="blank = use my default">
              <span class="rb-fld-hint">Leave blank to use your default discount (10% off).</span></label>
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
            <div class="rb-ctl">
              <span class="rl">Send to</span>
              <div class="rb-seg rb-slider" id="rbmMode">
                <button type="button" data-v="to_me" class="on">To me</button>
                <button type="button" data-v="to_client">To my client</button>
                <button type="button" data-v="to_both">To both</button>
              </div>
            </div>
          </div>
          <div class="rb-actions">
            <button class="ao-btn ao-btn-primary rb-save" id="rbmSave" type="button">Add offtaker</button>
            <span class="rb-status" id="rbmStatus"></span>
          </div>
          <p class="rep-note">New offtakers send <b>to you</b> by default — move the slider
             to “To my client” only when you're ready for them to receive it.</p>
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
      $("#rbmSave").onclick = saveManual;
      // Populate the GMP utility-bill picker. Offtakers bind to a GMP account;
      // their invoice is generated from THAT account's utility bills only.
      fetchUtilityAccounts().then(accts => {
        const sel = $("#rbmUtility");
        if (!sel) return;
        const fld = sel.closest(".rep-fld");
        if (!accts.length) {
          sel.innerHTML = `<option value="">No GMP utility bills yet — link GMP first</option>`;
          // Make the empty state ACTIONABLE: drop a Link-GMP button right here so
          // the operator can connect without hunting for it.
          if (fld && !fld.querySelector(".rbm-link-gmp")) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ao-btn rb-btn rbm-link-gmp";
            btn.textContent = "🔗 Link GMP utility bills";
            btn.style.marginTop = "6px";
            btn.onclick = () => { if (window.__aoConnectGmp) window.__aoConnectGmp(); else location.hash = "#arrays"; };
            fld.appendChild(btn);
          }
          return;
        }
        sel.innerHTML = `<option value="">Choose a GMP utility bill…</option>` +
          accts.map(a => {
            const label = a.nickname || (a.array_name ? a.array_name : ("GMP " + a.account_number));
            const billNote = a.has_bill
              ? `${a.bill_count} bill${a.bill_count === 1 ? "" : "s"} · latest ${a.latest_period_label || "—"}`
              : "no bill on file yet";
            return `<option value="${a.utility_account_id}">${esc(label)} · acct ${esc(a.account_number)} (${esc(billNote)})</option>`;
          }).join("");
      });
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
    const mode = segValue("rbmMode") || "to_me";
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
    if ((mode === "to_client" || mode === "to_both") && !clientEmail) {
      st.className = "rb-status rb-err"; st.textContent = "Add the client's email to send to them."; return;
    }
    st.className = "rb-status rb-busy"; st.textContent = "Adding offtaker…";
    const fd = new FormData();                       // no file → manual path
    fd.append("customer_name", name);
    fd.append("utility_account_id", utilityId);          // offtaker ↔ utility bill (utility data ONLY)
    fd.append("allocation_pct", String(pctNum / 100));   // backend wants a fraction in (0,1]
    if (rateNum !== null) fd.append("discount_pct", String(rateNum / 100));
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
              <label><input type="checkbox" id="rbSummary" checked> Performance summary</label>
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
      summary: $("#rbSummary") ? $("#rbSummary").checked : true,
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
  async function refreshList() {
    const list = $("#rbList");
    if (!list) return;
    try {
      const [r, arrs, utilAccts] = await Promise.all([
        fetch(API + "/subscriptions", { headers: authHeaders() }),
        fetchArrays(),
        fetchUtilityAccounts(),
      ]);
      if (r.status === 401) { list.innerHTML = `<div class="empty">Session expired — please sign in again.</div>`; return; }
      const data = await r.json().catch(() => ({}));
      const subs = (data && data.subscriptions) || [];
      if (!subs.length) {
        list.innerHTML = `<div class="empty" style="padding:22px 0;color:var(--faint)">No offtakers yet — click <b>＋ Add an offtaker</b> above, or drop a billing spreadsheet to create one.</div>`;
        return;
      }
      list.innerHTML = subs.map(s => subCard(s, arrs, utilAccts)).join("");
      list.querySelectorAll("[data-act]").forEach(b => b.onclick = onAction);
      // Rate inputs commit on change (not click) — wire them separately.
      list.querySelectorAll("input.rb-rate-input[data-act='discount']").forEach(inp =>
        inp.onchange = onRateChange);
      // Per-offtaker "Save details" buttons (name/email/array/share/rate).
      list.querySelectorAll('[data-cact="save"]').forEach(b =>
        b.onclick = () => saveCustCard(b.closest(".rb-sub")));
    } catch (e) {
      list.innerHTML = `<div class="empty">Couldn't load your schedules — refresh to retry.</div>`;
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

  function subCard(s, arrs, utilAccts) {
    const prev = s.preview || {};
    const next = s.next_send_at ? new Date(s.next_send_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
    const last = s.last_sent_at ? new Date(s.last_sent_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never";
    const fmts = (s.formats || []).map(f => f.toUpperCase()).join(" + ");
    const live = s.send_mode !== "to_me";
    const manual = s.billing_model === "percent_of_array";
    const pct = s.allocation_pct != null ? (Math.round(s.allocation_pct * 10000) / 100) : "";
    const arrayOpts = (arrs || []).map(a =>
      `<option value="${a.id}" ${String(a.id) === String(s.array_id) ? "selected" : ""}>${esc(a.name)}${a.client_name ? " · " + esc(a.client_name) : ""}</option>`).join("");
    // GMP utility-bill (billing-source) options for the edit form. The offtaker's
    // invoice is generated from this account's bills, so being able to (re)pick it
    // here is essential — it was only collectible when adding before.
    const billOpts = (utilAccts || []).map(a => {
      const bills = a.bill_count != null ? ` (${a.bill_count} bill${a.bill_count === 1 ? "" : "s"})`
        : (a.has_bill ? " (bill on file)" : "");
      const lbl = (a.utility_name || "GMP") + " · acct " + (a.account_number || "?") + bills;
      const sel = String(a.utility_account_id) === String(s.utility_account_id) ? "selected" : "";
      return `<option value="${a.utility_account_id}" ${sel}>${esc(lbl)}</option>`;
    }).join("");
    // ── one plain-English sentence, built from the offtaker's actual choices:
    //    "<name> receives <pct> of <linked GMP account / array>'s generation.
    //     <Monthly|Quarterly> <PDF> — drafted for approval / auto-sent to <emails>." ──
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
    // Plain statement of WHERE the invoice numbers come from (replaces the rate-math
    // line). Honest per source: the GMP bill, an uploaded workbook, or "link one first".
    const discTxt = s.resolved_discount_pct ? `, at <b>${Math.round(s.resolved_discount_pct * 100)}% off</b>` : "";
    const invoiceSource = s.utility_account_id
      ? `Your offtaker's invoice is calculated from the GMP bill${discTxt}.`
      : (s.source_filename
          ? `Your offtaker's invoice is calculated from the uploaded billing workbook${discTxt}.`
          : "Link a GMP utility bill to invoice this offtaker.");
    return `
      <div class="rb-sub ${s.enabled ? "" : "rb-paused"}" data-id="${s.id}">
        <div class="rb-sub-main">
          <div class="rb-sub-name">${esc(s.customer_name)}
            <span class="rb-chip ${s.delivery_mode === "auto" ? "rb-chip-live" : ""}">${s.delivery_mode === "auto" ? "Auto-send" : "Draft for approval"}</span>
            ${s.enabled ? "" : `<span class="rb-chip rb-chip-off">Paused</span>`}
          </div>
          <div class="rb-sub-sentence">${sentence}</div>
          <div class="rb-sub-rate">${invoiceSource}</div>
          <div class="rb-sub-meta">
            Next ${esc(next)} · last sent ${esc(last)}${prev.amount_owed != null ? " · " + money(prev.amount_owed) : ""}
          </div>
        </div>
        <div class="rb-sub-acts">
          <button class="ao-btn rb-btn" data-act="draft">Draft invoice</button>
          <a class="ao-btn rb-btn" data-act="preview" href="#">Preview</a>
          <button class="ao-btn rb-btn rb-edit-toggle" data-act="edit" aria-expanded="false">Edit ⌄</button>
          <span class="rb-status rb-sub-status"></span>
          <div class="rb-sub-more" hidden>
            <div class="rb-more-row">
              <span class="rb-more-lbl">Delivery</span>
              <div class="rb-seg rb-slider rb-mini" data-act="delivery">
                <button type="button" data-v="approval" class="${s.delivery_mode !== "auto" ? "on" : ""}">Draft</button>
                <button type="button" data-v="auto" class="${s.delivery_mode === "auto" ? "on" : ""}">Auto</button>
              </div>
              <span class="rb-more-lbl">Send to</span>
              <div class="rb-seg rb-slider rb-mini" data-act="mode">
                <button type="button" data-v="to_me" class="${s.send_mode === "to_me" ? "on" : ""}">Me</button>
                <button type="button" data-v="to_client" class="${s.send_mode === "to_client" ? "on" : ""}">Client</button>
                <button type="button" data-v="to_both" class="${s.send_mode === "to_both" ? "on" : ""}">Both</button>
              </div>
            </div>
            <div class="rb-more-details">
              <span class="rb-more-lbl">Offtaker details</span>
              <div class="rb-cust-grid">
                <label class="rep-fld"><span class="rl">Company / offtaker name</span>
                  <input type="text" data-f="customer_name" value="${esc(s.customer_name || "")}" placeholder="e.g. Sunnybrook Apartments"></label>
                <label class="rep-fld"><span class="rl">Contact email</span>
                  <input type="email" data-f="client_email" value="${esc(s.client_email || "")}" placeholder="offtaker@example.com"></label>
                <label class="rep-fld"><span class="rl">CC (comma-separated)</span>
                  <input type="text" data-f="cc_emails" value="${esc(s.cc_emails || "")}" placeholder="optional"></label>
                ${manual ? `
                <label class="rep-fld"><span class="rl">Which GMP utility bill?</span>
                  <select data-f="utility_account_id">
                    <option value="">${s.utility_account_id ? "— keep current —" : "Select a GMP bill…"}</option>
                    ${billOpts}
                  </select>
                  <span class="rb-fld-hint">The offtaker's invoice is generated from this GMP account's utility bills only. ${s.utility_account_id ? "" : "<b>Pick one to start invoicing this offtaker.</b>"}</span></label>
                <label class="rep-fld"><span class="rl">Array</span>
                  <select data-f="array_id">${arrayOpts || `<option value="">No arrays</option>`}</select></label>
                <label class="rep-fld"><span class="rl">Their share of the array (%)</span>
                  <input type="number" data-f="allocation_pct" min="0.01" max="100" step="0.01" value="${pct}" placeholder="e.g. 25"></label>
                ` : ""}
                <label class="rep-fld"><span class="rl">Cadence</span>
                  <select data-f="cadence">
                    <option value="monthly" ${s.cadence === "monthly" ? "selected" : ""}>Monthly</option>
                    <option value="quarterly" ${s.cadence === "quarterly" ? "selected" : ""}>Quarterly</option>
                  </select></label>
                <label class="rep-fld"><span class="rl">Solar credit rate ($/kWh)</span>
                  <input type="number" data-f="net_rate_per_kwh" min="0" max="5" step="0.0001" value="${s.net_rate_per_kwh != null ? s.net_rate_per_kwh : ""}" placeholder="blank = auto from bill">
                  <span class="rb-fld-hint">Blank = read from the GMP bill automatically. Set this to your actual net-metering credit rate when the meter's own bill shows $0 credit (e.g. group net metering).</span></label>
                <label class="rep-fld"><span class="rl">Discount (% off the solar credit rate)</span>
                  <input type="number" data-f="discount_pct" min="0" max="99" step="1" value="${s.discount_pct != null ? Math.round(s.discount_pct * 100) : ""}" placeholder="e.g. 10">
                  <span class="rb-fld-hint">Blank = your default discount (10% off).</span></label>
                <label class="rep-fld"><span class="rl">Starting invoice #</span>
                  <input type="number" data-f="invoice_number_start" min="0" step="1" value="${s.invoice_number_start != null ? s.invoice_number_start : ""}" placeholder="e.g. 1001">
                  <span class="rb-fld-hint">${s.invoice_number_next != null ? "Next invoice will be #" + s.invoice_number_next + ". " : ""}Array Operator adds 1 after each send. Blank = date-based.</span></label>
              </div>
              <button class="ao-btn ao-btn-primary rb-btn" data-cact="save" type="button">Save details</button>
              <span class="rb-status rb-cust-status"></span>
            </div>
            <div class="rb-more-row">
              <button class="ao-btn rb-btn" data-act="test">Send test</button>
              <button class="ao-btn rb-btn" data-act="toggle">${s.enabled ? "Pause" : "Resume"}</button>
              <button class="ao-btn rb-btn rb-danger" data-act="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  // Per-customer discount committed inline (blank clears → use global default).
  // UI shows whole % off; backend stores a fraction in [0,1).
  async function onRateChange(e) {
    const inp = e.currentTarget;
    const row = inp.closest(".rb-sub");
    const id = row && row.getAttribute("data-id");
    if (!id) return;
    const st = $(".rb-sub-status", row);
    const raw = inp.value.trim();
    let body;
    if (raw === "") {
      body = { discount_pct: null };
    } else {
      const d = Number(raw);
      if (isNaN(d) || d < 0 || d >= 100) {
        if (st) { st.className = "rb-status rb-err"; st.textContent = "Discount must be 0–99%, or blank."; }
        return;
      }
      body = { discount_pct: d / 100 };
    }
    const ok = await patch(id, body, st);
    if (ok) await refreshList();
  }

  async function onAction(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const act = btn.getAttribute("data-act");
    if (act === "discount") return;   // handled by onRateChange (change, not click)
    const row = btn.closest(".rb-sub");
    const id = row && row.getAttribute("data-id");
    if (!id) return;
    const st = $(".rb-sub-status", row);

    if (act === "edit") {
      // Expand/collapse the per-offtaker controls (delivery, send-to, discount,
      // test/pause/delete). Purely local — no fetch, no list refresh.
      const more = $(".rb-sub-more", row);
      if (!more) return;
      const open = more.hasAttribute("hidden");
      if (open) { more.removeAttribute("hidden"); btn.textContent = "Close ⌃"; btn.setAttribute("aria-expanded", "true"); }
      else { more.setAttribute("hidden", ""); btn.textContent = "Edit ⌄"; btn.setAttribute("aria-expanded", "false"); }
      return;
    }

    if (act === "mode") {
      const seg = btn; // wrapper has data-act=mode; actual click target is a button inside
      const target = e.target.closest("button");
      if (!target) return;
      const mode = target.getAttribute("data-v");
      seg.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      target.classList.add("on");
      await patch(id, { send_mode: mode }, st);
      await refreshList();
      return;
    }
    if (act === "delivery") {
      const seg = btn;
      const target = e.target.closest("button");
      if (!target) return;
      const dm = target.getAttribute("data-v");
      seg.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      target.classList.add("on");
      await patch(id, { delivery_mode: dm }, st);
      await refreshList();
      return;
    }
    if (act === "toggle") {
      const resuming = btn.textContent.trim() === "Resume";
      await patch(id, { enabled: resuming }, st);
      await refreshList();
      return;
    }
    if (act === "delete") {
      if (!confirm("Delete this scheduled report? This can't be undone.")) return;
      st.className = "rb-status rb-busy"; st.textContent = "Deleting…";
      await fetch(API + "/subscriptions/" + id, { method: "DELETE", headers: authHeaders() });
      await refreshList();
      return;
    }
    if (act === "draft") {
      st.className = "rb-status rb-busy"; st.textContent = "Drafting invoice for review…";
      try {
        const r = await fetch(API + "/subscriptions/" + id + "/draft", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          st.className = "rb-status rb-ok"; st.textContent = "Draft added to your approval inbox ↑";
          await refreshInbox();
          const wrap = $("#rbInboxWrap");
          if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Couldn't draft.";
        }
      } catch (err) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
      return;
    }
    if (act === "preview") {
      // A new-tab GET wouldn't carry the Authorization header, so fetch the PDF
      // as a blob (auth header attached) and open the object URL instead.
      return downloadPreview(id, st);
    }
    if (act === "test") {
      st.className = "rb-status rb-busy"; st.textContent = "Sending test to you…";
      try {
        const r = await fetch(API + "/subscriptions/" + id + "/send-now?test=true", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          const to = (data.result && data.result.to || []).join(", ");
          st.className = "rb-status rb-ok"; st.textContent = "Test sent" + (to ? " to " + to : "") + ".";
        } else {
          st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Test failed.";
        }
      } catch (err) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
    }
  }

  async function downloadPreview(id, st) {
    st.className = "rb-status rb-busy"; st.textContent = "Building preview…";
    try {
      const r = await fetch(API + "/subscriptions/" + id + "/preview?kind=invoice&fmt=pdf", { headers: authHeaders() });
      if (!r.ok) { st.className = "rb-status rb-err"; st.textContent = "Preview failed."; return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      st.textContent = "";
    } catch (e) { st.className = "rb-status rb-err"; st.textContent = "Preview failed."; }
  }

  async function patch(id, body, st) {
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Saving…"; }
    try {
      const r = await fetch(API + "/subscriptions/" + id, {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      });
      if (st) {
        if (r.ok) { st.textContent = ""; }
        else { st.className = "rb-status rb-err"; st.textContent = "Save failed."; }
      }
      return r.ok;
    } catch (e) { if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error."; } return false; }
  }

  // ---- approval inbox (Paul's draft → review → approve & send) ---------------
  // The pending drafts currently shown, + which one the live preview tracks.
  let INBOX_DRAFTS = [];
  let ACTIVE_DRAFT_ID = null;
  // The operator's invoice template ({enabled, html}) — when enabled, the live
  // preview renders THIS (their exact format) instead of the generic mock, so an
  // uploaded template propagates into the preview immediately.
  let TEMPLATE_STATE = null;

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

  async function refreshInbox() {
    const wrap = $("#rbInboxWrap");
    if (!wrap) return;
    try {
      const r = await fetch(API + "/drafts?status=pending", { headers: authHeaders() });
      if (!r.ok) { wrap.innerHTML = ""; INBOX_DRAFTS = []; return; }
      const drafts = (await r.json().catch(() => ({}))).drafts || [];
      if (!drafts.length) { wrap.innerHTML = ""; INBOX_DRAFTS = []; return; }   // hide when empty
      INBOX_DRAFTS = drafts;
      if (!drafts.some(d => String(d.id) === String(ACTIVE_DRAFT_ID))) ACTIVE_DRAFT_ID = drafts[0].id;
      wrap.innerHTML = `
        <div class="rb-inbox rep-card">
          <div class="rb-inbox-h">
            <span class="rep-eyebrow">Awaiting your approval</span>
            <h3>${drafts.length} report${drafts.length === 1 ? "" : "s"} ready to review &amp; send</h3>
            <p>Drafted from the latest billing period. Review the numbers, then
               approve — nothing goes to an offtaker until you do. The GMP bill
               attaches automatically.</p>
          </div>
          <div class="rb-layout">
            <div class="rb-col-form">
              ${drafts.map(draftCard).join("")}
            </div>
            <aside class="rb-col-doc" id="rbDraftDocPane"></aside>
          </div>
        </div>`;
      wrap.querySelectorAll("[data-dact]").forEach(b => b.onclick = onDraftAction);
      // Live preview: paint now, then repaint as the operator edits the email,
      // toggles the GMP attach, or focuses a different draft.
      renderDraftDoc();
      wrap.querySelectorAll("textarea[data-draftmsg]").forEach(ta => {
        const focusDraft = () => { ACTIVE_DRAFT_ID = ta.getAttribute("data-draftmsg"); renderDraftDoc(); };
        ta.addEventListener("input", focusDraft);
        ta.addEventListener("focus", focusDraft);
      });
      wrap.querySelectorAll('input[data-dact="autogmp"]').forEach(cb =>
        cb.addEventListener("change", () => renderDraftDoc()));
    } catch (e) { wrap.innerHTML = ""; INBOX_DRAFTS = []; }
  }

  function activeDraft() {
    return INBOX_DRAFTS.find(d => String(d.id) === String(ACTIVE_DRAFT_ID)) || INBOX_DRAFTS[0] || null;
  }

  /* Live invoice preview beside the approval draft — a styled mock of exactly
   * what the offtaker receives, rebuilt in real time from the draft numbers, the
   * (live-edited) cover email, and the GMP-attach toggle. Mirrors the standard
   * backend invoice; the card's "Preview invoice" button still fetches the exact
   * PDF (incl. a custom template). */
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
    if (d.include_summary !== false) atts.push({
      ico: "📈", name: `production_summary_${slug}.pdf`,
      sub: "generation + savings report", state: "ready",
      url: sid ? `${API}/subscriptions/${sid}/preview?kind=summary&fmt=pdf` : null,
    });
    if (d.has_gmp_pdf || (autoOn && d.gmp_auto_status === "ready")) atts.push({
      ico: "🧾", name: esc(d.gmp_filename || "gmp_utility_bill.pdf"),
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
    const attWord = d.include_summary !== false
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
            <tr class="due"><td>Solar credit value due</td><td>${money(d.amount_usd)}</td></tr>
          </table>
          <p class="rb-eml-attline">The full ${attWord} attached.</p>
        </div>
        <div class="rb-eml-atts">
          <div class="lab">📎 ${atts.length} attachment${atts.length === 1 ? "" : "s"}</div>
          ${attChips}
        </div>
      </div>
      ${(TEMPLATE_STATE && TEMPLATE_STATE.enabled && sid)
        ? `<div class="rb-doc-cap" style="margin-top:15px">Inside the invoice attachment — your template, filled</div>
           <div class="rb-tpl-paper" id="rbDraftInvPaper"><div class="rb-tpl-load">Rendering invoice…</div></div>` : ""}
      <p class="rb-doc-hint">A faithful copy of the email${toClient ? " your offtaker" : ""} receives, with its attachments.
        Use <b>Preview invoice</b> for the exact invoice PDF${d.has_gmp_pdf ? "; the GMP bill rides along automatically" : ""}.</p>`;

    // Render the ACTUAL reproduced invoice (the exact PDF that gets attached/sent) onto
    // a canvas — same source as the attachment chip + "Preview invoice", so it shows
    // THIS offtaker's real values, not the lossy token-HTML that left sample text in.
    if (TEMPLATE_STATE && TEMPLATE_STATE.enabled && sid) {
      const paper = pane.querySelector("#rbDraftInvPaper");
      if (paper) {
        fetch(`${API}/subscriptions/${sid}/preview?kind=invoice&fmt=pdf`, { headers: authHeaders() })
          .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("preview " + r.status)))
          .then(buf => renderPdfToPaper(buf, paper))
          .catch(() => { paper.innerHTML =
            '<div class="rb-tpl-load">Invoice preview unavailable — use “Preview invoice” for the exact PDF.</div>'; });
      }
    }
    // Clicking an attachment chip downloads that exact file.
    pane.querySelectorAll(".rb-eml-att[data-dl]").forEach(b => b.onclick = () =>
      downloadAttachment(b.getAttribute("data-dl"), b.getAttribute("data-fn")));
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

  function draftCard(d) {
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    const auto = d.auto_attach_gmp !== false;   // ON by default
    // Honest auto-attach status line (never implies a PDF exists when it doesn't).
    const autoStatusText = {
      ready: "✓ GMP bill found — it will attach automatically.",
      pending: "GMP bill will attach automatically once it's captured (none yet).",
      no_gmp: "No GMP account on this array yet — connect one to auto-attach.",
    }[d.gmp_auto_status] || "";
    const gmp = `
      <div class="rb-gmp-toggle-row">
        <label class="rb-gmp-switch">
          <input type="checkbox" data-dact="autogmp" ${auto ? "checked" : ""}>
          <span>Auto-attach the GMP bill</span>
        </label>
        ${auto && autoStatusText ? `<span class="rb-gmp-auto-status rb-gmp-${esc(d.gmp_auto_status)}">${autoStatusText}</span>` : ""}
      </div>
      ${d.has_gmp_pdf ? `<div class="rb-gmp-manual"><span class="rb-gmp-ok">✓ GMP invoice attached${d.gmp_filename ? " · " + esc(d.gmp_filename) : ""}</span></div>` : ""}`;
    return `
      <div class="rb-draft" data-did="${d.id}" data-subid="${d.subscription_id}">
        <div class="rb-draft-top">
          <div class="rb-draft-name">${esc(d.customer_name)}</div>
          <div class="rb-draft-period">${esc(d.period_label || "latest period")}</div>
        </div>
        <div class="rb-draft-grid">
          <div><span class="rb-k">Array total</span><span class="rb-v">${fmt0(d.array_total_kwh)} kWh</span></div>
          <div><span class="rb-k">This customer</span><span class="rb-v">${pct != null ? pct + "%" : "—"}</span></div>
          <div><span class="rb-k">Their production</span><span class="rb-v">${fmt0(d.customer_kwh)} kWh</span></div>
          <div><span class="rb-k">Amount</span><span class="rb-v rb-amt">${money(d.amount_usd)}</span></div>
        </div>
        <div class="rb-draft-gmp">${gmp}</div>
        <div class="rb-draft-email">
          <span class="rl">Email to your offtaker (editable)</span>
          <textarea class="rb-draft-msg" data-draftmsg="${d.id}" rows="5"
            placeholder="Write the note your offtaker sees…">${esc(d.note || defaultDraftNote(d))}</textarea>
          <div class="rb-draft-email-row">
            <button class="ao-btn rb-btn" data-dact="savemsg" type="button">Save email</button>
            <span class="rb-draft-msg-hint">Saved with the report. The invoice${d.has_gmp_pdf ? " + GMP invoice are" : " is"} attached automatically.</span>
          </div>
        </div>
        <div class="rb-draft-acts">
          <button class="ao-btn ao-btn-primary rb-btn" data-dact="approve">Approve &amp; send</button>
          <button class="ao-btn rb-btn" data-dact="sendme" type="button" title="Email a test copy to yourself first">Send to me</button>
          <a class="ao-btn rb-btn" data-dact="preview" href="#">Preview invoice</a>
          <button class="ao-btn rb-btn rb-danger" data-dact="dismiss">Dismiss</button>
          <span class="rb-status rb-draft-status"></span>
        </div>
        <p class="rb-draft-note">Sends to <b>${esc(d.customer_name)}</b> per this offtaker's
           delivery setting below, with the offtaker invoice${d.has_gmp_pdf ? " and the GMP invoice" : ""} attached.
           <b>Nothing sends until you click Approve &amp; send.</b></p>
      </div>`;
  }

  // A sensible pre-written note the operator edits before sending (Paul's
  // "edit a pre-written email" ask). Mentions the period + amount.
  function defaultDraftNote(d) {
    const amt = d.amount_usd != null ? money(d.amount_usd) : "the amount due";
    const kwh = d.customer_kwh != null ? fmt0(d.customer_kwh) + " kWh" : "your production";
    const period = d.period_label || "the latest period";
    return `Hi,\n\nAttached is your solar invoice for ${period}. Your array produced ${kwh} this period, for a total of ${amt}. The GMP source data and a production summary are attached so you can see exactly how it was calculated.\n\nThanks for going solar!`;
  }

  async function onDraftAction(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const act = btn.getAttribute("data-dact");
    const card = btn.closest(".rb-draft");
    const id = card && card.getAttribute("data-did");
    if (!id) return;
    const st = $(".rb-draft-status", card);
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
