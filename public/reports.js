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
    // First-run: if the owner has no customers yet, run the guided setup wizard
    // (collect arrays' age, accept the rate, add customers) instead of the bare
    // tab. Once set up — or if they reopen via the Setup link — show the tab.
    if (!FORCE_TAB) {
      try {
        const r = await fetch(API + "/setup-state", { headers: authHeaders() });
        const st = await r.json().catch(() => ({}));
        if (r.ok && st.ok && !st.has_customers) {
          return renderWizard(st);
        }
      } catch (e) { /* fall through to the normal tab */ }
    }
    el.innerHTML = shell();
    wireSubtabs();
    const setupLink = $("#rbSetupLink");
    if (setupLink) setupLink.onclick = async () => {
      try {
        const r = await fetch(API + "/setup-state", { headers: authHeaders() });
        const st = await r.json();
        if (r.ok && st.ok) { FORCE_TAB = false; return renderWizard(st); }
      } catch (e) {}
    };
    wireUpload();
    wireGlobalRate();
    renderDoc();              // right pane starts as the "drop a sheet" placeholder
    await Promise.all([refreshInbox(), refreshList()]);
  }
  window.__aoLoadReports = load;

  // When true, load() skips the wizard and shows the normal tab (Setup link / done).
  let FORCE_TAB = false;

  function signInPrompt() {
    return `<div class="rep-card"><span class="rep-eyebrow">Reports</span>
      <h3>Sign in to set up automatic reports</h3>
      <p>Upload a billing spreadsheet and we'll send invoices + performance
      summaries on the schedule you choose. <a href="/accounts" style="color:var(--good)">Sign in</a> to get started.</p></div>`;
  }

  // ===========================================================================
  // FIRST-RUN SETUP WIZARD
  // A guided, sequential flow so an owner enters everything needed to start
  // sending reports: ① confirm arrays + age → ② accept the rate → ③ add
  // customers → ④ review & finish. Backed by /setup-state, PATCH /arrays/{id},
  // PUT /global-rate, POST /subscriptions. Lands in the normal tab when done.
  // ===========================================================================
  const WIZ_STEPS = ["Your arrays", "Your rate", "Your offtakers", "Review"];
  let WIZ = null;   // { step, state(from setup-state), customers:[], rateDirty }

  function renderWizard(setupState) {
    WIZ = { step: 0, state: setupState, customers: [] };
    drawWizard();
  }

  function thisYear() { return new Date().getFullYear(); }

  function drawWizard() {
    const el = root();
    if (!el) return;
    el.innerHTML = `
      <div class="rb-wiz">
        <div class="rb-wiz-head">
          <span class="rep-eyebrow">Set up Reports</span>
          <h2>Let's get you ready to send invoices</h2>
          <p>A few quick steps and you'll be billing your offtakers automatically.</p>
          <button type="button" class="rb-wiz-skip" id="rbWizSkip">Skip for now →</button>
        </div>
        <ol class="rb-wiz-steps">
          ${WIZ_STEPS.map((s, i) => `<li class="${i === WIZ.step ? "on" : (i < WIZ.step ? "done" : "")}">
            <span class="rb-wiz-num">${i < WIZ.step ? "✓" : (i + 1)}</span>${esc(s)}</li>`).join("")}
        </ol>
        <div class="rb-wiz-body" id="rbWizBody"></div>
      </div>`;
    $("#rbWizSkip").onclick = () => { FORCE_TAB = true; load(); };
    [drawStepArrays, drawStepRate, drawStepCustomers, drawStepReview][WIZ.step]();
  }

  // ── Step ① arrays + age ────────────────────────────────────────────────────
  function drawStepArrays() {
    const body = $("#rbWizBody");
    const arrays = WIZ.state.arrays || [];
    if (!arrays.length) {
      body.innerHTML = `<div class="rb-wiz-card">
        <h3>No arrays detected yet</h3>
        <p>Connect an array (or capture data via the extension) and it'll show up
           here. You can still set your rate and add offtakers — come back to set
           ages later.</p>
        ${wizNav({ back: false, nextLabel: "Continue" })}</div>`;
      wireWizNav();
      return;
    }
    body.innerHTML = `<div class="rb-wiz-card">
      <h3>Confirm your arrays</h3>
      <p>How old is each array? This sets the correct blended rate — arrays past
         ${WIZ.state.age_threshold_years || 11} years bill at a different rate.</p>
      <div class="rb-wiz-arrays">
        ${arrays.map(a => `
          <div class="rb-wiz-arr" data-aid="${a.array_id}">
            <div class="rb-wiz-arr-main">
              <b>${esc(a.name)}</b>
              <span class="rb-wiz-arr-sub">${a.provider ? esc(a.provider.toUpperCase()) : "utility —"}${a.region ? " · " + esc(a.region) : ""}</span>
            </div>
            <label class="rb-wiz-yr">Installed in
              <input type="number" class="rb-wiz-yr-input" data-aid="${a.array_id}"
                min="1990" max="${thisYear()}" placeholder="year"
                value="${a.install_year != null ? a.install_year : ""}">
            </label>
            <span class="rb-wiz-arr-rate" data-aid="${a.array_id}">${
              a.age_known ? "$" + Number(a.auto_net_rate).toFixed(4) + "/kWh" : "set year →"}</span>
          </div>`).join("")}
      </div>
      <p class="rb-wiz-hint">Don't know the exact date? The year is enough.</p>
      ${wizNav({ back: false, nextLabel: "Save & continue" })}</div>`;
    wireWizNav(async () => {
      // Persist any entered years.
      const inputs = body.querySelectorAll(".rb-wiz-yr-input");
      for (const inp of inputs) {
        const yr = inp.value.trim();
        if (yr === "") continue;
        const n = Number(yr);
        if (isNaN(n) || n < 1990 || n > thisYear()) continue;
        await fetch(API + "/arrays/" + inp.getAttribute("data-aid"), {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ install_year: n }),
        });
      }
      // refresh state so later steps + rate reflect the saved ages
      try {
        const r = await fetch(API + "/setup-state", { headers: authHeaders() });
        const st = await r.json(); if (r.ok && st.ok) WIZ.state = st;
      } catch (e) {}
      return true;
    });
  }

  // ── Step ② rate + discount ──────────────────────────────────────────────────
  function drawStepRate() {
    const body = $("#rbWizBody");
    const g = WIZ.state.global || {};
    const discPct = Math.round((g.effective_discount_pct != null ? g.effective_discount_pct : 0.10) * 100);
    // Show the auto rate from the first array as the illustrative blended rate.
    const a0 = (WIZ.state.arrays || [])[0];
    const autoRate = a0 ? Number(a0.auto_net_rate) : null;
    body.innerHTML = `<div class="rb-wiz-card">
      <h3>Your billing rate</h3>
      <p>Offtakers pay the <b>solar credit rate</b> minus a <b>discount</b> — that discount
         is the solar savings you pass on. We default the solar credit rate automatically
         from your utility's blended rate, and a <b>10% discount</b>.</p>
      <div class="rb-wiz-rate">
        <label class="rb-gr-field"><span class="rb-gr-lbl">Solar credit rate (auto)</span>
          <span class="rb-gr-inwrap"><span class="rb-gr-dollar">$</span>
            <input type="number" id="rbWizNet" min="0" max="5" step="0.001"
              placeholder="${autoRate != null ? autoRate.toFixed(3) : "auto"}"
              value="${g.default_net_rate_per_kwh != null ? g.default_net_rate_per_kwh : ""}">
            <span class="rb-gr-unit">/kWh</span></span></label>
        <label class="rb-gr-field"><span class="rb-gr-lbl">Discount</span>
          <span class="rb-gr-inwrap">
            <input type="number" id="rbWizDisc" min="0" max="99" step="1" value="${discPct}">
            <span class="rb-gr-unit">% off</span></span></label>
      </div>
      <div class="rb-gr-eff" id="rbWizEff"></div>
      <p class="rb-wiz-hint">Leave the solar credit rate blank to use the auto rate from your
         bills${autoRate != null ? " (~$" + autoRate.toFixed(3) + "/kWh)" : ""}. You can override per offtaker later.</p>
      ${wizNav({ back: true, nextLabel: "Accept & continue" })}</div>`;
    const net = $("#rbWizNet"), disc = $("#rbWizDisc"), eff = $("#rbWizEff");
    function renderEff() {
      const n = net.value.trim() === "" ? (autoRate || 0) : Number(net.value);
      const d = disc.value.trim() === "" ? 10 : Number(disc.value);
      if (!isNaN(n) && !isNaN(d) && n > 0) {
        eff.innerHTML = `Offtakers pay <b>$${(n * (1 - d / 100)).toFixed(4)}/kWh</b> (credit $${n.toFixed(4)} − ${d}% off).`;
      } else { eff.textContent = ""; }
    }
    renderEff(); net.addEventListener("input", renderEff); disc.addEventListener("input", renderEff);
    wireWizNav(async () => {
      const bodyJson = {};
      const rawNet = net.value.trim();
      bodyJson.default_net_rate_per_kwh = rawNet === "" ? null : Number(rawNet);
      const rawDisc = disc.value.trim();
      bodyJson.default_discount_pct = rawDisc === "" ? null : Number(rawDisc) / 100;
      await fetch(API + "/global-rate", {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(bodyJson),
      });
      return true;
    });
  }

  // ── Step ③ customers ─────────────────────────────────────────────────────────
  function drawStepCustomers() {
    const body = $("#rbWizBody");
    const arrays = WIZ.state.arrays || [];
    const rows = WIZ.customers.map((c, i) => `
      <div class="rb-wiz-cust-row">
        <span><b>${esc(c.customer_name)}</b> · ${esc(c.array_name)} · ${Math.round(c.allocation_pct * 100)}%${
          c.discount_pct != null ? " · " + Math.round(c.discount_pct * 100) + "% off" : ""}</span>
        <button type="button" class="rb-wiz-cust-del" data-i="${i}">Remove</button>
      </div>`).join("");
    body.innerHTML = `<div class="rb-wiz-card">
      <h3>Add your offtakers</h3>
      <p>Each offtaker is billed for their share of an array's production. Add as
         many as you like — you can always add more later.</p>
      <div class="rb-wiz-custs" id="rbWizCusts">${rows || `<div class="rb-wiz-empty">No offtakers added yet.</div>`}</div>
      <div class="rb-wiz-cust-form">
        <input type="text" id="rbWizCName" placeholder="Offtaker name">
        <select id="rbWizCArray">${arrays.map(a => `<option value="${a.array_id}" data-name="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select>
        <span class="rb-wiz-inwrap"><input type="number" id="rbWizCPct" min="0.01" max="100" step="0.01" placeholder="25"><span>% of array</span></span>
        <span class="rb-wiz-inwrap"><input type="number" id="rbWizCDisc" min="0" max="99" step="1" placeholder="default"><span>% off (optional)</span></span>
        <input type="email" id="rbWizCEmail" placeholder="offtaker@email (optional)">
        <button type="button" class="ao-btn rb-btn" id="rbWizCAdd">+ Add offtaker</button>
        <span class="rb-status" id="rbWizCStatus"></span>
      </div>
      ${wizNav({ back: true, nextLabel: WIZ.customers.length ? "Continue" : "Skip for now", nextId: "rbWizCustNext" })}</div>`;
    if (!arrays.length) {
      $("#rbWizCArray").innerHTML = `<option value="">No arrays — add one first</option>`;
    }
    body.querySelectorAll(".rb-wiz-cust-del").forEach(b => b.onclick = () => {
      WIZ.customers.splice(Number(b.getAttribute("data-i")), 1); drawStepCustomers();
    });
    $("#rbWizCAdd").onclick = () => {
      const st = $("#rbWizCStatus");
      const name = $("#rbWizCName").value.trim();
      const sel = $("#rbWizCArray");
      const arrayId = sel.value;
      const arrayName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].getAttribute("data-name") : "";
      const pct = Number($("#rbWizCPct").value);
      const discRaw = $("#rbWizCDisc").value.trim();
      const email = $("#rbWizCEmail").value.trim();
      if (!name) { st.className = "rb-status rb-err"; st.textContent = "Enter the offtaker's name."; return; }
      if (!arrayId) { st.className = "rb-status rb-err"; st.textContent = "Pick an array."; return; }
      if (isNaN(pct) || pct <= 0 || pct > 100) { st.className = "rb-status rb-err"; st.textContent = "Enter their share 0–100%."; return; }
      let disc = null;
      if (discRaw !== "") { const d = Number(discRaw); if (isNaN(d) || d < 0 || d >= 100) { st.className = "rb-status rb-err"; st.textContent = "Discount 0–99% or blank."; return; } disc = d / 100; }
      WIZ.customers.push({ customer_name: name, array_id: arrayId, array_name: arrayName,
        allocation_pct: pct / 100, discount_pct: disc, client_email: email || null });
      drawStepCustomers();
    };
    wireWizNav();   // Continue just advances; customers are created at Review/Finish
  }

  // ── Step ④ review & finish ───────────────────────────────────────────────────
  function drawStepReview() {
    const body = $("#rbWizBody");
    const g = WIZ.state.global || {};
    const discPct = Math.round((g.effective_discount_pct != null ? g.effective_discount_pct : 0.10) * 100);
    const arrays = WIZ.state.arrays || [];
    const knownAges = arrays.filter(a => a.age_known).length;
    body.innerHTML = `<div class="rb-wiz-card">
      <h3>Review &amp; finish</h3>
      <div class="rb-wiz-review">
        <div class="rb-wiz-rev-item"><span class="rl">Arrays</span>
          <b>${arrays.length} array${arrays.length === 1 ? "" : "s"}</b>
          <span class="sub">${knownAges}/${arrays.length} with install year set</span></div>
        <div class="rb-wiz-rev-item"><span class="rl">Default billing</span>
          <b>${g.default_net_rate_per_kwh != null ? "$" + Number(g.default_net_rate_per_kwh).toFixed(4) + "/kWh credit" : "auto solar credit rate"} − ${discPct}% off</b>
          <span class="sub">offtakers without their own rate</span></div>
        <div class="rb-wiz-rev-item"><span class="rl">Offtakers</span>
          <b>${WIZ.customers.length} to create</b>
          <span class="sub">${WIZ.customers.map(c => esc(c.customer_name)).join(", ") || "none yet — you can add later"}</span></div>
      </div>
      <p class="rb-wiz-hint">Finishing creates your offtakers and opens the Reports tab. Nothing is emailed automatically — you review every draft before it sends.</p>
      ${wizNav({ back: true, nextLabel: "Finish setup", nextId: "rbWizFinish" })}
      <span class="rb-status" id="rbWizFinStatus"></span></div>`;
    wireWizNav(async () => {
      const st = $("#rbWizFinStatus");
      st.className = "rb-status rb-busy"; st.textContent = "Creating your offtakers…";
      let created = 0;
      for (const c of WIZ.customers) {
        const fd = new FormData();
        fd.append("customer_name", c.customer_name);
        fd.append("array_id", c.array_id);
        fd.append("allocation_pct", String(c.allocation_pct));
        if (c.discount_pct != null) fd.append("discount_pct", String(c.discount_pct));
        fd.append("cadence", "monthly");
        fd.append("delivery_mode", "approval");
        fd.append("send_mode", c.client_email ? "to_both" : "to_me");
        if (c.client_email) fd.append("client_email", c.client_email);
        try {
          const r = await fetch(API + "/subscriptions", { method: "POST", headers: authHeaders(), body: fd });
          if (r.ok) created++;
        } catch (e) {}
      }
      st.className = "rb-status rb-ok"; st.textContent = `Done — ${created} offtaker${created === 1 ? "" : "s"} ready.`;
      FORCE_TAB = true;
      setTimeout(() => load(), 600);
      return false;   // don't auto-advance; load() takes over
    });
  }

  // ── wizard nav helpers ───────────────────────────────────────────────────────
  function wizNav({ back, nextLabel, nextId }) {
    return `<div class="rb-wiz-nav">
      ${back ? `<button type="button" class="ao-btn rb-btn" id="rbWizBack">← Back</button>` : "<span></span>"}
      <button type="button" class="ao-btn ao-btn-primary rb-btn" id="${nextId || "rbWizNext"}">${esc(nextLabel || "Continue")}</button>
    </div>`;
  }

  // beforeNext: optional async fn; return false to NOT auto-advance.
  function wireWizNav(beforeNext) {
    const back = $("#rbWizBack");
    if (back) back.onclick = () => { if (WIZ.step > 0) { WIZ.step--; drawWizard(); } };
    const nextBtn = $("#rbWizNext") || $("#rbWizCustNext") || $("#rbWizFinish");
    if (nextBtn) nextBtn.onclick = async () => {
      nextBtn.disabled = true;
      let advance = true;
      if (beforeNext) { try { advance = await beforeNext(); } catch (e) { advance = true; } }
      nextBtn.disabled = false;
      if (advance !== false && WIZ.step < WIZ_STEPS.length - 1) { WIZ.step++; drawWizard(); }
    };
  }


  function shell() {
    return `
      <div class="rb-subtabs" role="tablist">
        <button type="button" class="rb-subtab on" data-sub="invoice" role="tab">Offtaker Invoice Generator</button>
        <button type="button" class="rb-subtab" data-sub="quarterly" role="tab">Quarterly reports</button>
        <button type="button" class="rb-subtab" data-sub="customers" role="tab">Offtakers</button>
        <button type="button" class="rb-setup-link" id="rbSetupLink" title="Re-run the guided setup">⚙ Setup</button>
      </div>
      <div id="rbSubInvoice" class="rb-subpanel">
      <div id="rbInboxWrap" class="rb-inbox-wrap"></div>
      <div class="rb-globalrate rep-card" id="rbGlobalRate">
        <div class="rb-gr-main">
          <span class="rep-eyebrow">Your default billing</span>
          <h3>Bill offtakers at a discount off the solar credit rate</h3>
          <p>Offtakers pay the <b>solar credit rate</b> minus your <b>discount</b> — that's
             their solar savings. Default is <b>10% off</b>. Applies to any
             offtaker without their own override below.</p>
        </div>
        <div class="rb-gr-ctl">
          <label class="rb-gr-field">
            <span class="rb-gr-lbl">Solar credit rate</span>
            <span class="rb-gr-inwrap"><span class="rb-gr-dollar">$</span>
              <input type="number" id="rbGrNet" min="0" max="5" step="0.001" placeholder="0.184">
              <span class="rb-gr-unit">/kWh</span></span>
          </label>
          <label class="rb-gr-field">
            <span class="rb-gr-lbl">Discount</span>
            <span class="rb-gr-inwrap">
              <input type="number" id="rbGrDisc" min="0" max="99" step="1" placeholder="10">
              <span class="rb-gr-unit">% off</span></span>
          </label>
          <button class="ao-btn ao-btn-primary rb-btn" id="rbGrSave" type="button">Save</button>
          <span class="rb-status" id="rbGrStatus"></span>
        </div>
        <div class="rb-gr-eff" id="rbGrEff"></div>
      </div>
      <div class="rb-layout">
        <div class="rb-col-form">
          <div class="rb-upload rep-card" id="rbUpload">
            <span class="rep-eyebrow">Step 1 · Match a spreadsheet</span>
            <h3>Drop a billing spreadsheet</h3>
            <p>Any of your billing workbooks — we recognize the offtaker, their
               percentage of the array, and the latest billing period automatically.</p>
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
      <div class="rb-listwrap">
        <div class="cc-treedivider"><h3>Your offtakers</h3>
          <span>each offtaker's percentage of the array · invoice + summary on its cadence</span></div>
        <div id="rbList"><div class="empty" style="padding:22px 0;color:var(--faint)">Loading…</div></div>
      </div>
      </div><!-- /rbSubInvoice -->
      <div id="rbSubQuarterly" class="rb-subpanel" style="display:none"></div>
      <div id="rbSubCustomers" class="rb-subpanel" style="display:none"></div>`;
  }

  // ---- subtab switching (Invoice generator / Quarterly reports / Customers) --
  let QUARTERLY_RENDERED = false;
  function wireSubtabs() {
    const tabs = Array.from(document.querySelectorAll(".rb-subtab"));
    if (!tabs.length) return;
    tabs.forEach(btn => btn.onclick = () => {
      const sub = btn.getAttribute("data-sub");
      tabs.forEach(b => b.classList.toggle("on", b === btn));
      const inv = $("#rbSubInvoice"), q = $("#rbSubQuarterly"), c = $("#rbSubCustomers");
      if (inv) inv.style.display = sub === "invoice" ? "" : "none";
      if (q) q.style.display = sub === "quarterly" ? "" : "none";
      if (c) c.style.display = sub === "customers" ? "" : "none";
      if (sub === "quarterly") renderQuarterly();
      if (sub === "customers") renderCustomers();
    });
  }

  // ---- Quarterly reports subtab ---------------------------------------------
  // A per-customer quarterly performance report: the quarter's invoice math +
  // the same Trends visuals (Solar Spiral + Energy Ridgeline) the Trends tab
  // uses, reusing window.AOTrends so the charts can't drift from that tab.
  let QTRENDS_STOPS = [];     // active chart cleanup fns
  let QTRENDS_DATA = null;    // cached fleet-trends payload

  function teardownQTrends() {
    QTRENDS_STOPS.forEach(fn => { try { fn && fn(); } catch (e) {} });
    QTRENDS_STOPS = [];
  }

  async function renderQuarterly() {
    const host = $("#rbSubQuarterly");
    if (!host) return;
    host.innerHTML = `
      <div class="rep-card rb-q-head">
        <span class="rep-eyebrow">Quarterly reports</span>
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
    const srcLabel = math && math.kwh_source === "gmp_api" ? "GMP metered data"
      : math && math.kwh_source === "daily_csv" ? "your uploaded generation data"
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
        <div class="rb-q-chart"><div class="rb-q-chart-cap">Solar Spiral</div><div id="rbqSpiral" class="rb-q-canvas"></div></div>
        <div class="rb-q-chart"><div class="rb-q-chart-cap">Energy Ridgeline</div><div id="rbqRidge" class="rb-q-canvas"></div></div>
      </div>
      <div class="rb-q-actions">
        <button class="ao-btn ao-btn-primary rb-btn" id="rbqDraft" type="button">Draft this report for review →</button>
        <span class="rb-status" id="rbqStatus"></span>
      </div>`;

    // 2) mount the Trends visuals, reusing window.AOTrends (same as Trends tab).
    mountQTrends();

    // 3) "Draft for review" reuses the existing per-subscription draft flow.
    const draftBtn = $("#rbqDraft");
    if (draftBtn) draftBtn.onclick = () => quarterlyDraft(subId);
  }

  async function mountQTrends() {
    const C = window.AOTrends;
    const spiralHost = $("#rbqSpiral"), ridgeHost = $("#rbqRidge");
    if (!C || !spiralHost || !ridgeHost) return;
    try {
      if (!QTRENDS_DATA) {
        const r = await fetch("/v1/array-owners/fleet-trends", { headers: authHeaders() });
        if (!r.ok) throw new Error("trends fetch " + r.status);
        QTRENDS_DATA = await r.json();
      }
      const prepped = C.prep(QTRENDS_DATA);
      if (!prepped.years || !prepped.years.length) {
        spiralHost.innerHTML = ridgeHost.innerHTML =
          `<div class="empty" style="padding:20px 0;color:var(--faint)">No production history to chart yet.</div>`;
        return;
      }
      [["spiral", spiralHost], ["ridgeline", ridgeHost]].forEach(([key, host]) => {
        const view = C.getView(key);
        host.style.position = "relative";
        if (!view) { host.innerHTML = `<div class="empty">${key} view unavailable.</div>`; return; }
        try { const stop = view.mount(host, prepped, C); if (stop) QTRENDS_STOPS.push(stop); }
        catch (e) { host.innerHTML = `<div class="empty">Chart error.</div>`; }
      });
    } catch (e) {
      spiralHost.innerHTML = ridgeHost.innerHTML =
        `<div class="empty" style="padding:20px 0;color:var(--faint)">Couldn't load production charts.</div>`;
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

  // ---- Customers subtab ------------------------------------------------------
  // "This is where you edit customers" (offtakers). Each customer is one
  // editable card: name, contact email, CC, which array + their share, and rate.
  // Saving PATCHes only the changed fields to /subscriptions/{id}. No fabricated
  // data — fields come straight from the saved subscription.
  async function renderCustomers() {
    const host = $("#rbSubCustomers");
    if (!host) return;
    // Route the manual-add form to this subtab + refresh the offtaker list on add.
    MANUAL_HOST_ID = "rbCustManual";
    MANUAL_AFTER_ADD = renderCustomers;
    MANUAL_OPEN = false;
    host.innerHTML = `
      <div class="rep-card rb-cust-head">
        <div class="rb-cust-head-row">
          <div>
            <span class="rep-eyebrow">Offtakers</span>
            <h3>Your offtakers</h3>
            <p>Edit each offtaker's details — their company name, contact email,
               which array they're billed from, and their share. Changes save to the
               offtaker used by both the Offtaker Invoice Generator and Quarterly reports.</p>
          </div>
          <button class="ao-btn ao-btn-primary rb-btn" id="rbCustAdd" type="button">＋ Add an offtaker</button>
        </div>
      </div>
      <div id="rbCustManual"></div>
      <div id="rbCustList"><div class="empty" style="padding:22px 0;color:var(--faint)">Loading offtakers…</div></div>`;
    const addBtn = $("#rbCustAdd");
    if (addBtn) addBtn.onclick = () => { MANUAL_OPEN = true; renderManual(); };
    const list = $("#rbCustList");
    try {
      const [r, arrs] = await Promise.all([
        fetch(API + "/subscriptions", { headers: authHeaders() }),
        fetchArrays(),
      ]);
      if (r.status === 401) { list.innerHTML = `<div class="empty">Session expired — please sign in again.</div>`; return; }
      const subs = ((await r.json().catch(() => ({}))).subscriptions) || [];
      if (!subs.length) {
        list.innerHTML = `<div class="empty" style="padding:22px 0;color:var(--faint)">
          No offtakers yet — click <b>＋ Add an offtaker</b> above to create your first one.</div>`;
        return;
      }
      list.innerHTML = subs.map(s => custCard(s, arrs)).join("");
      list.querySelectorAll(".rb-cust").forEach(card => wireCustCard(card));
    } catch (e) {
      list.innerHTML = `<div class="empty">Couldn't load offtakers — refresh to retry.</div>`;
    }
  }

  function custCard(s, arrs) {
    const pct = s.allocation_pct != null ? (Math.round(s.allocation_pct * 10000) / 100) : "";
    const manual = s.billing_model === "percent_of_array";
    const arrayOpts = (arrs || []).map(a =>
      `<option value="${a.id}" ${String(a.id) === String(s.array_id) ? "selected" : ""}>${esc(a.name)}${a.client_name ? " · " + esc(a.client_name) : ""}</option>`).join("");
    return `
      <div class="rep-card rb-cust" data-id="${s.id}">
        <div class="rb-cust-top">
          <div class="rb-cust-title">${esc(s.customer_name)}</div>
          <span class="rb-chip">${esc(MODEL_LABEL[s.billing_model] || s.billing_model)}</span>
        </div>
        <div class="rb-cust-grid">
          <label class="rep-fld"><span class="rl">Company / offtaker name</span>
            <input type="text" data-f="customer_name" value="${esc(s.customer_name || "")}" placeholder="e.g. Sunnybrook Apartments"></label>
          <label class="rep-fld"><span class="rl">Contact email</span>
            <input type="email" data-f="client_email" value="${esc(s.client_email || "")}" placeholder="offtaker@example.com"></label>
          <label class="rep-fld"><span class="rl">CC (comma-separated)</span>
            <input type="text" data-f="cc_emails" value="${esc(s.cc_emails || "")}" placeholder="optional"></label>
          ${manual ? `
          <label class="rep-fld"><span class="rl">Array</span>
            <select data-f="array_id">${arrayOpts || `<option value="">No arrays</option>`}</select></label>
          <label class="rep-fld"><span class="rl">Their share of the array (%)</span>
            <input type="number" data-f="allocation_pct" min="0.01" max="100" step="0.01" value="${pct}" placeholder="e.g. 25"></label>
          ` : ""}
          <label class="rep-fld"><span class="rl">Rate ($/kWh)</span>
            <input type="number" data-f="rate_per_kwh" min="0" max="5" step="0.001" value="${s.rate_per_kwh != null ? Number(s.rate_per_kwh) : ""}" placeholder="blank = your default rate">
            <span class="rb-fld-hint">Leave blank to bill at your default rate.</span></label>
        </div>
        <div class="rb-cust-acts">
          <button class="ao-btn ao-btn-primary rb-btn" data-cact="save" type="button">Save changes</button>
          <span class="rb-status rb-cust-status"></span>
        </div>
      </div>`;
  }

  function wireCustCard(card) {
    const save = card.querySelector('[data-cact="save"]');
    if (save) save.onclick = () => saveCustCard(card);
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
    // rate: blank → null (clear → use default); number → set.
    if (get("rate_per_kwh")) {
      const raw = get("rate_per_kwh").value.trim();
      if (raw === "") {
        body.rate_per_kwh = null;
      } else {
        const n = Number(raw);
        if (isNaN(n) || n < 0 || n > 5) {
          st.className = "rb-status rb-err"; st.textContent = "Rate must be 0–5 $/kWh, or blank."; return;
        }
        body.rate_per_kwh = n;
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

  function renderManual() {
    const host = $("#" + MANUAL_HOST_ID);
    if (!host) return;
    if (!MANUAL_OPEN) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = `
      <div class="rep-card rb-manual-form">
        <span class="rep-eyebrow">Add an offtaker · % of an array</span>
        <h3>New offtaker</h3>
        <div class="rb-mform-grid">
          <label class="rep-fld"><span class="rl">Offtaker name</span>
            <input type="text" id="rbmName" placeholder="e.g. Sunnybrook Apartments"></label>
          <label class="rep-fld"><span class="rl">Which array?</span>
            <select id="rbmArray"><option value="">Loading arrays…</option></select></label>
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
          <button class="ao-btn ao-btn-ghost rb-cancel" id="rbmCancel" type="button">Cancel</button>
          <span class="rb-status" id="rbmStatus"></span>
        </div>
        <p class="rep-note">New offtakers send <b>to you</b> by default — move the slider
           to “To my client” only when you're ready for them to receive it.</p>
      </div>`;
    wireSegments(host);
    $("#rbmCancel").onclick = () => { MANUAL_OPEN = false; renderManual(); };
    $("#rbmSave").onclick = saveManual;
    // Populate the array picker.
    fetchArrays().then(arrs => {
      const sel = $("#rbmArray");
      if (!sel) return;
      if (!arrs.length) {
        sel.innerHTML = `<option value="">No arrays yet — add one in the Arrays tab</option>`;
        return;
      }
      sel.innerHTML = `<option value="">Choose an array…</option>` +
        arrs.map(a => `<option value="${a.id}">${esc(a.name)}${a.client_name ? " · " + esc(a.client_name) : ""}</option>`).join("");
    });
  }

  async function saveManual() {
    const st = $("#rbmStatus");
    const name = $("#rbmName").value.trim();
    const arrayId = $("#rbmArray").value;
    const pctRaw = $("#rbmPct").value.trim();
    const rateRaw = $("#rbmRate").value.trim();
    const mode = segValue("rbmMode") || "to_me";
    const clientEmail = $("#rbmEmail").value.trim();
    if (!name) { st.className = "rb-status rb-err"; st.textContent = "Enter the offtaker's name."; return; }
    if (!arrayId) { st.className = "rb-status rb-err"; st.textContent = "Pick which array this offtaker is on."; return; }
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
    fd.append("array_id", arrayId);
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
      $("#rbPreview").innerHTML = "";
      $("#rbStatus").textContent = "";
      $("#rbFile").value = "";
      await refreshList();
    } catch (e) {
      st.className = "rb-status rb-err"; st.textContent = "Network error while saving.";
    }
  }

  // ---- subscriptions list ----------------------------------------------------
  async function refreshList() {
    const list = $("#rbList");
    if (!list) return;
    try {
      const r = await fetch(API + "/subscriptions", { headers: authHeaders() });
      if (r.status === 401) { list.innerHTML = `<div class="empty">Session expired — please sign in again.</div>`; return; }
      const data = await r.json().catch(() => ({}));
      const subs = (data && data.subscriptions) || [];
      if (!subs.length) {
        list.innerHTML = `<div class="empty" style="padding:22px 0;color:var(--faint)">No scheduled reports yet — upload a spreadsheet above to create one.</div>`;
        return;
      }
      list.innerHTML = subs.map(subCard).join("");
      list.querySelectorAll("[data-act]").forEach(b => b.onclick = onAction);
      // Rate inputs commit on change (not click) — wire them separately.
      list.querySelectorAll("input.rb-rate-input[data-act='discount']").forEach(inp =>
        inp.onchange = onRateChange);
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

  function subCard(s) {
    const prev = s.preview || {};
    const next = s.next_send_at ? new Date(s.next_send_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
    const last = s.last_sent_at ? new Date(s.last_sent_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never";
    const fmts = (s.formats || []).map(f => f.toUpperCase()).join(" + ");
    const live = s.send_mode !== "to_me";
    return `
      <div class="rb-sub ${s.enabled ? "" : "rb-paused"}" data-id="${s.id}">
        <div class="rb-sub-main">
          <div class="rb-sub-name">${esc(s.customer_name)}
            <span class="rb-chip">${esc(MODEL_LABEL[s.billing_model] || s.billing_model)}</span>
            <span class="rb-chip ${s.delivery_mode === "auto" ? "rb-chip-live" : ""}">${s.delivery_mode === "auto" ? "Auto-send" : "Draft for approval"}</span>
            <span class="rb-chip ${live ? "rb-chip-live" : ""}">${esc(MODE_LABEL[s.send_mode] || s.send_mode)}</span>
            <span class="rb-chip rb-chip-rate">${
              s.discount_pct != null ? Math.round(s.discount_pct * 100) + "% off"
              : (s.rate_per_kwh != null ? "$" + Number(s.rate_per_kwh).toFixed(3) + "/kWh"
              : "default discount")}</span>
            ${s.enabled ? "" : `<span class="rb-chip rb-chip-off">Paused</span>`}
          </div>
          <div class="rb-sub-meta">
            ${esc(s.cadence)} · ${esc(fmts)} · next ${esc(next)} · last sent ${esc(last)}
            ${prev.amount_owed != null ? " · " + money(prev.amount_owed) : ""}
          </div>
          ${s.resolved_net_rate != null ? `<div class="rb-sub-rate" title="${esc(s.resolved_net_note || "")}">
            Solar credit rate <b>$${Number(s.resolved_net_rate).toFixed(4)}/kWh</b>
            ${s.resolved_discount_pct ? "− " + Math.round(s.resolved_discount_pct * 100) + "% = <b>$" + Number(s.resolved_effective_rate).toFixed(4) + "/kWh</b>" : ""}
            <span class="rb-rate-prov">${esc(rateSourceLabel(s.resolved_net_source))}</span>
          </div>` : ""}
        </div>
        <div class="rb-sub-acts">
          <div class="rb-seg rb-slider rb-mini" data-act="delivery">
            <button type="button" data-v="approval" class="${s.delivery_mode !== "auto" ? "on" : ""}">Draft</button>
            <button type="button" data-v="auto" class="${s.delivery_mode === "auto" ? "on" : ""}">Auto</button>
          </div>
          <div class="rb-seg rb-slider rb-mini" data-act="mode">
            <button type="button" data-v="to_me" class="${s.send_mode === "to_me" ? "on" : ""}">Me</button>
            <button type="button" data-v="to_client" class="${s.send_mode === "to_client" ? "on" : ""}">Client</button>
            <button type="button" data-v="to_both" class="${s.send_mode === "to_both" ? "on" : ""}">Both</button>
          </div>
          <button class="ao-btn rb-btn" data-act="draft">Draft invoice</button>
          <label class="rb-rate-edit" title="Per-customer discount (% off the solar credit rate) — blank uses your default">
            <input type="number" class="rb-rate-input" data-act="discount" min="0" max="99" step="1"
              value="${s.discount_pct != null ? Math.round(s.discount_pct * 100) : ""}" placeholder="default">
            <span>% off</span>
          </label>
          <button class="ao-btn rb-btn" data-act="test">Send test</button>
          <a class="ao-btn rb-btn" data-act="preview" href="#">Preview</a>
          <button class="ao-btn rb-btn" data-act="toggle">${s.enabled ? "Pause" : "Resume"}</button>
          <button class="ao-btn rb-btn rb-danger" data-act="delete">Delete</button>
          <span class="rb-status rb-sub-status"></span>
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
  async function refreshInbox() {
    const wrap = $("#rbInboxWrap");
    if (!wrap) return;
    try {
      const r = await fetch(API + "/drafts?status=pending", { headers: authHeaders() });
      if (!r.ok) { wrap.innerHTML = ""; return; }
      const drafts = (await r.json().catch(() => ({}))).drafts || [];
      if (!drafts.length) { wrap.innerHTML = ""; return; }   // hide the section when empty
      wrap.innerHTML = `
        <div class="rb-inbox rep-card">
          <div class="rb-inbox-h">
            <span class="rep-eyebrow">Awaiting your approval</span>
            <h3>${drafts.length} report${drafts.length === 1 ? "" : "s"} ready to review &amp; send</h3>
            <p>Drafted from the latest billing period. Review the numbers, attach the
               GMP invoice, then approve — nothing goes to an offtaker until you do.</p>
          </div>
          ${drafts.map(draftCard).join("")}
        </div>`;
      wrap.querySelectorAll("[data-dact]").forEach(b => b.onclick = onDraftAction);
      wrap.querySelectorAll("input[type=file][data-gmp]").forEach(inp =>
        inp.addEventListener("change", () => { if (inp.files[0]) attachGmp(inp.getAttribute("data-gmp"), inp.files[0]); }));
    } catch (e) { wrap.innerHTML = ""; }
  }

  function draftCard(d) {
    const pct = d.allocation_pct != null ? Math.round(d.allocation_pct * 1000) / 10 : null;
    const auto = !!d.auto_attach_gmp;
    // Honest auto-attach status line (never implies a PDF exists when it doesn't).
    const autoStatusText = {
      ready: "✓ GMP bill found — it will attach automatically.",
      pending: "GMP bill will attach automatically once it's captured (none yet).",
      no_gmp: "No GMP account on this array yet — connect one to auto-attach.",
    }[d.gmp_auto_status] || "";
    const manualGmp = d.has_gmp_pdf
      ? `<span class="rb-gmp-ok">✓ GMP invoice attached${d.gmp_filename ? " · " + esc(d.gmp_filename) : ""}</span>`
      : `<label class="rb-gmp-attach">＋ Attach GMP invoice (PDF)
           <input type="file" accept="application/pdf,.pdf" data-gmp="${d.id}" hidden></label>`;
    const gmp = `
      <div class="rb-gmp-toggle-row">
        <label class="rb-gmp-switch">
          <input type="checkbox" data-dact="autogmp" ${auto ? "checked" : ""}>
          <span>Auto-attach the GMP bill</span>
        </label>
        ${auto && autoStatusText ? `<span class="rb-gmp-auto-status rb-gmp-${esc(d.gmp_auto_status)}">${autoStatusText}</span>` : ""}
      </div>
      ${(!auto || d.gmp_auto_status !== "ready") ? `<div class="rb-gmp-manual">${manualGmp}</div>` : ""}`;
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

  async function attachGmp(draftId, file) {
    const card = document.querySelector(`.rb-draft[data-did="${draftId}"]`);
    const st = card && $(".rb-draft-status", card);
    if (st) { st.className = "rb-status rb-busy"; st.textContent = "Attaching GMP invoice…"; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(API + "/drafts/" + draftId + "/gmp-invoice", { method: "POST", headers: authHeaders(), body: fd });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) { await refreshInbox(); }
      else if (st) { st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Attach failed."; }
    } catch (e) { if (st) { st.className = "rb-status rb-err"; st.textContent = "Network error."; } }
  }

  async function onDraftAction(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const act = btn.getAttribute("data-dact");
    const card = btn.closest(".rb-draft");
    const id = card && card.getAttribute("data-did");
    if (!id) return;
    const st = $(".rb-draft-status", card);

    if (act === "preview") {
      // Drafts share the subscription's preview; resolve the sub id via the draft.
      return downloadDraftPreview(id, st);
    }
    if (act === "autogmp") {
      // Per-customer auto-attach toggle. The draft carries subscription_id;
      // PATCH the subscription, then refresh the inbox to update the status line.
      const on = e.target.checked;
      const subId = card.getAttribute("data-subid");
      st.className = "rb-status rb-busy"; st.textContent = "Saving…";
      try {
        const r = await fetch(API + "/subscriptions/" + subId, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ auto_attach_gmp: on }),
        });
        if (r.ok) { st.textContent = ""; await refreshInbox(); }
        else { st.className = "rb-status rb-err"; st.textContent = "Couldn't save."; }
      } catch (err) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
      return;
    }
    if (act === "savemsg") {
      const ta = card.querySelector(`textarea[data-draftmsg="${id}"]`);
      const note = ta ? ta.value : "";
      st.className = "rb-status rb-busy"; st.textContent = "Saving email…";
      try {
        const r = await fetch(API + "/drafts/" + id, {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ note }),
        });
        if (r.ok) { st.className = "rb-status rb-ok"; st.textContent = "Email saved."; }
        else { st.className = "rb-status rb-err"; st.textContent = "Couldn't save email."; }
      } catch (err) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
      return;
    }
    if (act === "dismiss") {
      if (!confirm("Dismiss this drafted report without sending?")) return;
      st.className = "rb-status rb-busy"; st.textContent = "Dismissing…";
      await fetch(API + "/drafts/" + id + "/dismiss", { method: "POST", headers: authHeaders() });
      await refreshInbox();
      return;
    }
    if (act === "approve") {
      if (!confirm("Approve and send this report to the offtaker now?")) return;
      st.className = "rb-status rb-busy"; st.textContent = "Sending…";
      try {
        const r = await fetch(API + "/drafts/" + id + "/approve", { method: "POST", headers: authHeaders() });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          const to = (data.result && data.result.to || []).join(", ");
          st.className = "rb-status rb-ok"; st.textContent = "Sent" + (to ? " to " + to : "") + ".";
          setTimeout(refreshInbox, 900);
        } else {
          st.className = "rb-status rb-err"; st.textContent = (data && data.detail) ? data.detail : "Send failed.";
        }
      } catch (err) { st.className = "rb-status rb-err"; st.textContent = "Network error."; }
    }
  }

  async function downloadDraftPreview(draftId, st) {
    // The draft's subscription preview is the same invoice; fetch via the sub.
    st.className = "rb-status rb-busy"; st.textContent = "Building preview…";
    try {
      // get the draft to resolve its subscription_id
      const dl = await fetch(API + "/drafts?status=all", { headers: authHeaders() });
      const all = (await dl.json().catch(() => ({}))).drafts || [];
      const d = all.find(x => String(x.id) === String(draftId));
      if (!d) { st.className = "rb-status rb-err"; st.textContent = "Preview unavailable."; return; }
      const r = await fetch(API + "/subscriptions/" + d.subscription_id + "/preview?kind=invoice&fmt=pdf", { headers: authHeaders() });
      if (!r.ok) { st.className = "rb-status rb-err"; st.textContent = "Preview failed."; return; }
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      st.textContent = "";
    } catch (e) { st.className = "rb-status rb-err"; st.textContent = "Preview failed."; }
  }

  // If the Reports tab is the active hash on first load, render immediately.
  if (location.hash === "#reports") {
    document.addEventListener("DOMContentLoaded", load);
  }
})();
