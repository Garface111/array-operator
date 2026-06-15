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
    el.innerHTML = shell();
    wireUpload();
    renderDoc();              // right pane starts as the "drop a sheet" placeholder
    await refreshList();
  }
  window.__aoLoadReports = load;

  function signInPrompt() {
    return `<div class="rep-card"><span class="rep-eyebrow">Reports</span>
      <h3>Sign in to set up automatic reports</h3>
      <p>Upload a billing spreadsheet and we'll send invoices + performance
      summaries on the schedule you choose. <a href="/accounts" style="color:var(--good)">Sign in</a> to get started.</p></div>`;
  }

  function shell() {
    return `
      <div class="rb-layout">
        <div class="rb-col-form">
          <div class="rb-upload rep-card" id="rbUpload">
            <span class="rep-eyebrow">Step 1 · Match a spreadsheet</span>
            <h3>Drop a billing spreadsheet</h3>
            <p>Any of your billing workbooks — we recognize the customer, rate, and
               the latest billing period automatically, whatever the sheet is named.</p>
            <label class="rb-drop" id="rbDrop">
              <input type="file" id="rbFile" accept=".xlsx,.xls" hidden>
              <span class="rb-drop-ico">⬆</span>
              <span class="rb-drop-main">Choose a spreadsheet or drop it here</span>
              <span class="rb-drop-sub">.xlsx — up to 8 MB</span>
            </label>
            <div class="rb-status" id="rbStatus"></div>
          </div>
          <div id="rbPreview"></div>
        </div>
        <aside class="rb-col-doc" id="rbDocPane"></aside>
      </div>
      <div class="rb-listwrap">
        <div class="cc-treedivider"><h3>Scheduled reports</h3>
          <span>each customer's automatic invoice + summary, on its cadence</span></div>
        <div id="rbList"><div class="empty" style="padding:22px 0;color:var(--faint)">Loading…</div></div>
      </div>`;
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
      status.textContent = "Recognized " + (m.customer.name || "a customer") +
        " (confidence " + Math.round((m.confidence || 0) * 100) + "%).";
      PENDING = { file, match: m };
      renderPreview(m);
    } catch (e) {
      status.className = "rb-status rb-err";
      status.textContent = "Network error while matching — try again.";
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
          <div><span class="rb-k">Customer</span><span class="rb-v">${esc(m.customer.name || "—")}</span></div>
          <div><span class="rb-k">Billing model</span><span class="rb-v">${esc(MODEL_LABEL[m.billing_model] || m.billing_model)}</span></div>
          <div><span class="rb-k">Latest period</span><span class="rb-v">${esc(ci.period_start || "—")} → ${esc(ci.period_end || "—")}</span></div>
          <div><span class="rb-k">Generation</span><span class="rb-v">${fmt0(ci.kwh)} kWh</span></div>
          <div><span class="rb-k">Amount due</span><span class="rb-v rb-amt">${money(ci.amount_owed)}</span></div>
          <div><span class="rb-k">Billing rate</span><span class="rb-v">${m.billing_rate != null ? Math.round(m.billing_rate * 100) + "%" : "—"}</span></div>
        </div>
        ${warn}
        <div class="rb-controls">
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
            <input type="email" id="rbClientEmail" placeholder="customer@example.com" value="${esc(m.customer.email || "")}"></label>
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
        performance summary your customer receives — updating live as you set
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
    } catch (e) {
      list.innerHTML = `<div class="empty">Couldn't load your schedules — refresh to retry.</div>`;
    }
  }

  const MODE_LABEL = { to_me: "To me", to_client: "To client", to_both: "To both" };

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
            <span class="rb-chip ${live ? "rb-chip-live" : ""}">${esc(MODE_LABEL[s.send_mode] || s.send_mode)}</span>
            ${s.enabled ? "" : `<span class="rb-chip rb-chip-off">Paused</span>`}
          </div>
          <div class="rb-sub-meta">
            ${esc(s.cadence)} · ${esc(fmts)} · next ${esc(next)} · last sent ${esc(last)}
            ${prev.amount_owed != null ? " · " + money(prev.amount_owed) : ""}
          </div>
        </div>
        <div class="rb-sub-acts">
          <div class="rb-seg rb-slider rb-mini" data-act="mode">
            <button type="button" data-v="to_me" class="${s.send_mode === "to_me" ? "on" : ""}">Me</button>
            <button type="button" data-v="to_client" class="${s.send_mode === "to_client" ? "on" : ""}">Client</button>
            <button type="button" data-v="to_both" class="${s.send_mode === "to_both" ? "on" : ""}">Both</button>
          </div>
          <button class="ao-btn rb-btn" data-act="test">Send test</button>
          <a class="ao-btn rb-btn" data-act="preview" href="#">Preview</a>
          <button class="ao-btn rb-btn" data-act="toggle">${s.enabled ? "Pause" : "Resume"}</button>
          <button class="ao-btn rb-btn rb-danger" data-act="delete">Delete</button>
          <span class="rb-status rb-sub-status"></span>
        </div>
      </div>`;
  }

  async function onAction(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const act = btn.getAttribute("data-act");
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

  // If the Reports tab is the active hash on first load, render immediately.
  if (location.hash === "#reports") {
    document.addEventListener("DOMContentLoaded", load);
  }
})();
