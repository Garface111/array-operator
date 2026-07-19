/* prospectus.js — Array Prospectus + the "Array Market" sub-tab (secondary-market v0).
 *
 * Two integrated surfaces, one flow:
 *   1. window.AOProspectus.open(arrayId, name) — builds a verified per-array data
 *      room (POST the prospectus builder), shows an honest summary, downloads the
 *      PDF, and manages a revocable share link. Called from the Array Market
 *      sub-tab AND the Fleet Triage drawer toolbar.
 *   2. Registers an "Array Market" sub-tab into the shared Marketplace registry
 *      (window.__aoMarketplace). This module does NOT own the Marketplace top tab
 *      — a second agent owns that shell; we only register our sub-tab.
 *
 * No money. Document surface only. Share links default OFF (unpublished) + PII
 * redacted — publishing is the deliberate, owner-gated external step.
 */
(function () {
  "use strict";

  // ── shared Marketplace sub-tab registry (idempotent; identical to the shell's
  //    copy — whoever loads first wins, the other no-ops, load order irrelevant) ──
  window.__aoMarketplace = window.__aoMarketplace || (function () {
    const subs = []; let onChange = null;
    return {
      register(sub){ if (subs.some(s=>s.id===sub.id)) return; subs.push(sub); subs.sort((a,b)=>(a.order||0)-(b.order||0)); if(onChange) onChange(); },
      list(){ return subs.slice(); },
      onChange(fn){ onChange = fn; if (subs.length) fn(); }
    };
  })();

  const API = "/v1/array-owners";
  const OCT = "var(--ao-oct, #7c3aed)";

  function sess(){ try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function authed(){ return !!sess(); }
  function H(json){ const h = { "Authorization": "Bearer " + sess() }; if (json) h["Content-Type"] = "application/json"; return h; }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const fmtDate = s => { if (!s) return "—"; try { return new Date(s).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" }); } catch (e) { return String(s).slice(0,10); } }
  const money = n => (n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  async function jfetch(path, opts){
    const r = await fetch(path, opts);
    let d = null; try { d = await r.json(); } catch (_) {}
    if (!r.ok) { const m = (d && (d.detail || d.error || d.message)) || ("HTTP " + r.status); throw new Error(typeof m === "string" ? m : JSON.stringify(m)); }
    return d;
  }

  // ── one-time injected styles (own .aopx-* namespace; reads on stock + sky) ──
  function injectStyle(){
    if (document.getElementById("aopx-style")) return;
    const s = document.createElement("style");
    s.id = "aopx-style";
    s.textContent = `
.aopx-wrap{max-width:960px;margin:0 auto;padding:4px 2px 40px}
.aopx-eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:800;color:${OCT};margin:2px 0 4px}
.aopx-h{font-size:22px;font-weight:800;letter-spacing:-.01em;margin:0 0 2px;color:var(--ink,#0f172a)}
.aopx-sub{color:var(--muted,#5a6572);font-size:13.5px;margin:0 0 18px}
.aopx-sec{font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:var(--muted,#5a6572);margin:22px 0 10px}
.aopx-card{background:var(--card,#fff);border:1px solid var(--line,#e2e8f0);border-radius:14px;padding:12px 14px;margin-bottom:10px;
 box-shadow:0 1px 2px -1px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.07)}
.aopx-row{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}
.aopx-name{font-weight:700;font-size:15px;color:var(--ink,#0f172a)}
.aopx-meta{color:var(--muted,#5a6572);font-size:12.5px}
.aopx-btn{border:1px solid var(--line,#cbd5e1);background:var(--card,#fff);color:var(--ink,#0f172a);border-radius:10px;
 padding:8px 13px;font:inherit;font-size:13.5px;font-weight:650;cursor:pointer;transition:transform .14s,border-color .14s,background .14s}
.aopx-btn:hover{transform:translateY(-1px);border-color:${OCT}}
.aopx-btn.oct{background:${OCT};border-color:${OCT};color:#fff}
.aopx-btn.oct:hover{filter:brightness(1.06)}
.aopx-btn.ghost{background:transparent}
.aopx-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.aopx-chip{display:inline-block;border-radius:999px;padding:2px 10px;font-size:11.5px;font-weight:700;vertical-align:middle}
.aopx-chip.off{background:#eef2f7;color:#64748b}
.aopx-chip.on{background:rgba(22,163,74,.12);color:#0f9d58}
.aopx-cov{display:inline-block;background:#eef2f7;color:#64748b;border-radius:999px;padding:1px 9px;font-size:11px;margin-left:6px}
.aopx-empty{color:var(--muted,#5a6572);font-size:13.5px;padding:14px;text-align:center;border:1px dashed var(--line,#e2e8f0);border-radius:12px}
/* overlay */
.aopx-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;
 background:rgba(15,23,42,.42);backdrop-filter:blur(3px);padding:34px 14px;overflow:auto}
.aopx-sheet{width:min(720px,100%);background:rgba(255,255,255,.94);backdrop-filter:blur(20px) saturate(1.4);
 border:1px solid rgba(255,255,255,.6);border-radius:20px;box-shadow:0 24px 60px -28px rgba(20,60,120,.5);padding:22px 24px}
.aopx-sheet h2{font-size:19px;margin:0 0 2px;letter-spacing:-.01em}
.aopx-close{float:right;border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:var(--muted,#5a6572);padding:2px 6px}
.aopx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:14px 0}
.aopx-tile{background:#f7faff;border:1px solid var(--line,#e2e8f0);border-radius:12px;padding:10px 12px}
.aopx-tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#5a6572);font-weight:700}
.aopx-tile .v{font-size:17px;font-weight:800;letter-spacing:-.01em;color:var(--ink,#0f172a);margin-top:2px}
.aopx-tile .s{font-size:11.5px;color:var(--muted,#5a6572);margin-top:1px}
.aopx-disc{font-size:11.5px;color:var(--muted,#5a6572);border-top:1px solid var(--line,#e2e8f0);padding-top:10px;margin-top:12px}
.aopx-hash{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted,#5a6572);word-break:break-all}
.aopx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.aopx-linkbox{display:flex;gap:6px;align-items:center;margin-top:8px}
.aopx-linkbox input{flex:1;font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--line,#cbd5e1);border-radius:9px;background:#f8fafc;color:var(--ink,#0f172a)}
.aopx-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink,#0f172a);margin:8px 0}
.aopx-note{font-size:12px;color:var(--muted,#5a6572);margin-top:6px}
.aopx-warn{font-size:12.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:8px 11px;margin-top:8px}
.aopx-spin{padding:34px;text-align:center;color:var(--muted,#5a6572)}
`;
    document.head.appendChild(s);
  }

  // ── overlay plumbing ──
  let _ov = null, _esc = null;
  function closeOverlay(){ if (_ov) { _ov.remove(); _ov = null; } if (_esc) { document.removeEventListener("keydown", _esc); _esc = null; } }
  function openOverlay(){
    injectStyle();
    closeOverlay();
    _ov = document.createElement("div");
    _ov.className = "aopx-ov";
    _ov.innerHTML = `<div class="aopx-sheet" role="dialog" aria-modal="true"><div class="aopx-inner"></div></div>`;
    _ov.addEventListener("click", e => { if (e.target === _ov) closeOverlay(); });
    _esc = e => { if (e.key === "Escape") closeOverlay(); };
    document.addEventListener("keydown", _esc);
    document.body.appendChild(_ov);
    return _ov.querySelector(".aopx-inner");
  }
  function toast(msg){
    injectStyle();
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10001;background:#0e1620;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.3)";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ── the prospectus flow ──
  const AOProspectus = {
    async open(arrayId, arrayName){
      if (!authed()) { toast("Sign in to prepare a prospectus for your arrays."); return; }
      const host = openOverlay();
      host.innerHTML = `<button class="aopx-close" aria-label="Close">×</button>
        <p class="aopx-eyebrow">Array Prospectus · data room</p>
        <h2>${esc(arrayName || "Array")}</h2>
        <div class="aopx-spin">Building the verified prospectus from this array's own history…</div>`;
      host.querySelector(".aopx-close").onclick = closeOverlay;
      try {
        const res = await jfetch(`${API}/arrays/${encodeURIComponent(arrayId)}/prospectus`,
          { method: "POST", headers: H(true), body: JSON.stringify({ purpose: "sale" }) });
        renderResult(host, res.document_id, res.prospectus);
      } catch (err) {
        host.querySelector(".aopx-spin, .aopx-body")?.remove();
        const d = document.createElement("div");
        d.className = "aopx-warn";
        d.textContent = "Couldn't build the prospectus: " + err.message;
        host.appendChild(d);
      }
    }
  };
  window.AOProspectus = AOProspectus;

  function coverStamp(cov){
    if (!cov || !cov.day_count) return '<span class="aopx-cov">no coverage</span>';
    return `<span class="aopx-cov">${esc(cov.first)} → ${esc(cov.last)} · ${cov.day_count}d</span>`;
  }

  function renderResult(host, documentId, p){
    const s = p.sections || {};
    const a = s.asset || {}, prod = s.production || {}, exp = s.expectation || {},
      health = s.health || {}, rev = s.revenue || {}, util = s.utility || {}, est = s.estimate || {};
    const nameplate = a.nameplate_available ? (a.nameplate_kw + " kW") : "not available";
    const capCov = ((prod.coverage || {}).captured) || {};
    const expTxt = exp.available
      ? `<span class="v">${exp.ratio_pct == null ? "—" : exp.ratio_pct + "%"}</span><div class="s">of weather-adjusted expected · ${(exp.inputs||{}).measured_days || 0}d · ${esc(exp.confidence||"")}</div>`
      : `<span class="v" style="font-size:13px">unavailable</span><div class="s">${esc(exp.reason || "")}</div>`;
    const ae = health.alert_events || {}, wc = health.warranty_claims || {}, rt = health.repair_tickets || {};
    const utilTxt = (util.available === false)
      ? `<span class="v" style="font-size:13px">no bills</span>`
      : `<span class="v">${util.bill_count || 0}</span><div class="s">${util.banked_month_count || 0} banked · ${util.captured_pdf_count || 0} PDFs</div>`;

    host.innerHTML = `<button class="aopx-close" aria-label="Close">×</button>
      <p class="aopx-eyebrow">Array Prospectus · data room</p>
      <h2>${esc(p.array_name || "Array")}</h2>
      <p class="aopx-meta">${esc((p.operator||{}).company_name || "")} · nameplate ${esc(nameplate)} · generated ${esc(String(p.generated_at||"").slice(0,10))}</p>
      <div class="aopx-grid">
        <div class="aopx-tile"><div class="k">Production ${coverStamp(capCov)}</div><div class="v">${(a.inverter_count||0)}</div><div class="s">inverters · ${prod.row_counts ? prod.row_counts.captured : 0} captured days</div></div>
        <div class="aopx-tile"><div class="k">Weather-adjusted</div>${expTxt}</div>
        <div class="aopx-tile"><div class="k">Health</div><div class="v">${ae.total||0} / ${wc.total||0} / ${rt.total||0}</div><div class="s">alerts / claims / repairs</div></div>
        <div class="aopx-tile"><div class="k">Revenue (invoiced)</div><div class="v">${rev.offtaker_count||0}</div><div class="s">offtakers · last ${money(rev.last_cycle_invoiced_usd)}</div></div>
        <div class="aopx-tile"><div class="k">Utility bills</div>${utilTxt}</div>
        <div class="aopx-tile"><div class="k">Reliability</div><div class="v">${est.reliability_score == null ? "—" : est.reliability_score}</div><div class="s">indicator, not an appraisal</div></div>
      </div>
      <div class="aopx-actions">
        <button class="aopx-btn" data-a="pdf">⬇ Download PDF</button>
        <button class="aopx-btn oct" data-a="share">🔗 Share…</button>
      </div>
      <div class="aopx-share"></div>
      <p class="aopx-disc">${esc(p.disclaimer || "")}</p>
      <p class="aopx-hash">SHA-256 ${esc(p.content_sha256 || "")}</p>`;
    host.querySelector(".aopx-close").onclick = closeOverlay;
    host.querySelector('[data-a="pdf"]').onclick = () => downloadOwnerPdf(documentId, p.array_name);
    host.querySelector('[data-a="share"]').onclick = () => openShare(host.querySelector(".aopx-share"), documentId, null);
  }

  async function downloadOwnerPdf(documentId, name){
    try {
      const r = await fetch(`${API}/prospectus/${documentId}/document?format=pdf`, { headers: H() });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast("Couldn't render the PDF: " + e.message); }
  }

  // ── share management (mint OFF by default; publishing is the deliberate step) ──
  async function openShare(container, documentId, existing){
    container.innerHTML = `<div class="aopx-spin" style="padding:14px">Preparing share link…</div>`;
    let share = existing;
    try {
      if (!share) {
        const r = await jfetch(`${API}/prospectus/${documentId}/share`,
          { method: "POST", headers: H(true), body: JSON.stringify({}) });
        share = r.share;
      }
    } catch (e) { container.innerHTML = `<div class="aopx-warn">Couldn't create a share link: ${esc(e.message)}</div>`; return; }
    renderShare(container, documentId, share);
  }

  function shareUrl(share){ return location.origin + share.share_path; }

  function renderShare(container, documentId, share){
    const pub = !!share.published && !share.revoked;
    container.innerHTML = `
      <div class="aopx-card" style="margin-top:12px">
        <div class="aopx-row">
          <div><b>Share link</b> ${share.revoked ? '<span class="aopx-chip off">revoked</span>' : (pub ? '<span class="aopx-chip on">published</span>' : '<span class="aopx-chip off">not published</span>')}</div>
          <div class="aopx-meta">opened ${share.view_count || 0}×${share.last_viewed_at ? " · last " + fmtDate(share.last_viewed_at) : ""}</div>
        </div>
        <div class="aopx-linkbox">
          <input readonly value="${esc(shareUrl(share))}">
          <button class="aopx-btn" data-s="copy">Copy</button>
        </div>
        ${pub ? "" : '<div class="aopx-warn">This link is OFF — it won\'t open until you publish it. Publishing shares this array\'s data outside your account; do it deliberately.</div>'}
        <label class="aopx-toggle"><input type="checkbox" data-s="redact" ${share.redact_offtaker_pii ? "checked" : ""}> Redact offtaker names &amp; emails in the shared view</label>
        <div class="aopx-actions">
          ${share.revoked ? "" : (pub
            ? '<button class="aopx-btn ghost" data-s="unpublish">Unpublish</button><button class="aopx-btn" data-s="preview">Open shared view ↗</button>'
            : '<button class="aopx-btn oct" data-s="publish">Publish link</button>')}
          ${share.revoked ? "" : '<button class="aopx-btn ghost" data-s="revoke">Revoke</button>'}
        </div>
        <p class="aopx-note">Not an appraisal or an offer — a captured, timestamped data room. Revenue is invoiced, not collected.</p>
      </div>`;
    const patch = async body => {
      try {
        const r = await jfetch(`${API}/prospectus/share/${share.id}`,
          { method: "PATCH", headers: H(true), body: JSON.stringify(body) });
        renderShare(container, documentId, r.share);
      } catch (e) { toast("Update failed: " + e.message); }
    };
    const q = sel => container.querySelector(sel);
    q('[data-s="copy"]').onclick = () => { navigator.clipboard?.writeText(shareUrl(share)).then(() => toast("Link copied")); };
    q('[data-s="redact"]').onchange = e => patch({ redact_offtaker_pii: e.target.checked });
    if (q('[data-s="publish"]')) q('[data-s="publish"]').onclick = () => patch({ published: true });
    if (q('[data-s="unpublish"]')) q('[data-s="unpublish"]').onclick = () => patch({ published: false });
    if (q('[data-s="revoke"]')) q('[data-s="revoke"]').onclick = () => patch({ revoked: true });
    if (q('[data-s="preview"]')) q('[data-s="preview"]').onclick = () => window.open(shareUrl(share), "_blank");
  }

  // ── the Array Market sub-tab ──
  function mountMarket(container){
    injectStyle();
    container.innerHTML = `<div class="aopx-wrap">
      <p class="aopx-eyebrow">Array Market</p>
      <h1 class="aopx-h">Array data room</h1>
      <p class="aopx-sub">Build a verified data room for an array, share it over a revocable link.</p>
      <div class="aopx-sec">Prepare a prospectus</div>
      <div class="aopx-arrays"></div>
      <div class="aopx-sec">Generated prospectuses</div>
      <div class="aopx-docs"><div class="aopx-spin" style="padding:14px">Loading…</div></div>
    </div>`;

    // Arrays (from the live FleetStore snapshot).
    const arraysEl = container.querySelector(".aopx-arrays");
    const snap = (window.FleetStore && FleetStore.snapshot) ? FleetStore.snapshot() : { arrays: [], simulated: true };
    if (!authed() || snap.simulated) {
      arraysEl.innerHTML = `<div class="aopx-empty">Sign in to your fleet to prepare a prospectus for a real array.</div>`;
    } else if (!snap.arrays || !snap.arrays.length) {
      arraysEl.innerHTML = `<div class="aopx-empty">No arrays yet — connect a fleet first.</div>`;
    } else {
      arraysEl.innerHTML = snap.arrays.map(a => {
        const kw = (a.inverters || []).reduce((t, i) => t + (Number(i.nameplate_kw) || 0), 0);
        const kwTxt = kw > 0 ? kw.toFixed(1) + " kW" : "utility-only";
        return `<div class="aopx-card"><div class="aopx-row">
          <div><span class="aopx-name">${esc(a.name)}</span>
            <span class="aopx-meta"> · ${esc(kwTxt)} · ${(a.inverters || []).length} inverters</span></div>
          <button class="aopx-btn" data-mk-array="${esc(a.id)}" data-mk-name="${esc(a.name)}">Prepare prospectus</button>
        </div></div>`;
      }).join("");
      arraysEl.querySelectorAll("[data-mk-array]").forEach(b => {
        b.onclick = () => AOProspectus.open(b.getAttribute("data-mk-array"), b.getAttribute("data-mk-name"));
      });
    }

    // Already-generated prospectuses + their shares.
    const docsEl = container.querySelector(".aopx-docs");
    if (!authed() || snap.simulated) { docsEl.innerHTML = `<div class="aopx-empty">Sign in to see your generated prospectuses.</div>`; return; }
    jfetch(`${API}/prospectuses`, { headers: H() }).then(res => {
      const list = (res && res.prospectuses) || [];
      if (!list.length) { docsEl.innerHTML = `<div class="aopx-empty">No prospectuses yet. Prepare one above.</div>`; return; }
      docsEl.innerHTML = list.map(d => {
        const sh = (d.shares || [])[0];
        const chip = !sh ? '<span class="aopx-chip off">no link</span>'
          : (sh.revoked ? '<span class="aopx-chip off">revoked</span>'
            : (sh.published ? '<span class="aopx-chip on">published</span>' : '<span class="aopx-chip off">link off</span>'));
        return `<div class="aopx-card" data-doc="${d.document_id}">
          <div class="aopx-row">
            <div><span class="aopx-name">${esc(d.array_name || ("Array " + d.array_id))}</span> ${chip}
              <div class="aopx-meta">${esc(d.purpose || "sale")} · generated ${fmtDate(d.generated_at)}</div></div>
            <div class="aopx-actions" style="margin:0">
              <button class="aopx-btn" data-d-pdf="${d.document_id}" data-d-name="${esc(d.array_name || "")}">⬇ PDF</button>
              <button class="aopx-btn" data-d-share="${d.document_id}">Share</button>
            </div>
          </div>
          <div class="aopx-share" data-share-host="${d.document_id}"></div>
        </div>`;
      }).join("");
      docsEl.querySelectorAll("[data-d-pdf]").forEach(b => b.onclick = () => downloadOwnerPdf(b.getAttribute("data-d-pdf"), b.getAttribute("data-d-name")));
      docsEl.querySelectorAll("[data-d-share]").forEach(b => b.onclick = () => {
        const id = b.getAttribute("data-d-share");
        const hostEl = docsEl.querySelector(`[data-share-host="${id}"]`);
        const rec = list.find(x => String(x.document_id) === String(id));
        openShare(hostEl, id, (rec && rec.shares && rec.shares[0]) || null);
      });
    }).catch(e => { docsEl.innerHTML = `<div class="aopx-warn">Couldn't load prospectuses: ${esc(e.message)}</div>`; });
  }

  window.__aoMarketplace.register({
    id: "array-market",
    label: "Array Market",
    order: 20,
    mount(container){ mountMarket(container); }
  });
})();
