/* ============================================================================
 Array Operator, Audit tab (audit.js)
 The settlement auditor's owner-facing view. Renders GET
 /v1/array-owners/fleet-audit into #auditRoot:
 • a hero coverage band (auditable %, dollars flagged, status legend)
 • a status filter row
 • a per-array verdict list (status pill, variance, $ at risk, detail)
 Read-only. Never invents a verdict the engine didn't return.
 ========================================================================== */
(function () {
 const API = "/v1/array-owners/fleet-audit";

 function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
 function root() { return document.getElementById("auditRoot"); }

 let _data = null; // last payload
 let _filter = "all"; // status filter

 // Status → display vocabulary (label, accent class, glyph). Mirrors the
 // engine's statuses; copy is owner-friendly.
 const STATUS = {
 leak: { label: "Leak", cls: "leak", ic: "⚠" },
 leak_unconfirmed: { label: "Unconfirmed gap", cls: "warn", ic: "◐" },
 ok: { label: "Reconciles", cls: "ok", ic: "✓" },
 incomplete_monitoring: { label: "Partial monitor", cls: "partial", ic: "◔" },
 insufficient_data: { label: "Needs data", cls: "none", ic: "·" },
 };

 function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
 ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
 }
 function usd(n) {
 if (n == null) return "—";
 return "$" + Math.round(n).toLocaleString();
 }
 function kwh(n) {
 if (n == null) return "—";
 return Math.round(n).toLocaleString() + " kWh";
 }

 function loading() {
 const r = root(); if (!r) return;
 r.innerHTML = '<div class="empty" style="padding:34px 0;color:var(--faint)">Running the fleet audit…</div>';
 }

 function emptyState(msg) {
 const r = root(); if (!r) return;
 r.innerHTML = `<div class="ad-empty">
 <div class="ad-empty-ic" aria-hidden="true">🔍</div>
 <div class="ad-empty-h">Nothing to audit yet</div>
 <div class="ad-empty-p">${esc(msg || "Connect your arrays and add a utility bill so we can reconcile metered production against what the utility settled.")}</div>
 </div>`;
 }

 // ── the hero coverage band, the at-a-glance audit headline ────────────────
 function heroHTML(s) {
 const flagged = (s.leak || 0) + (s.leak_unconfirmed || 0);
 const dollars = usd(s.dollars_flagged || 0);
 // The headline figure: dollars flagged when there's a flag, else coverage.
 const hasFlag = flagged > 0;
 return `
 <div class="ad-hero">
 <div class="ad-hero-glow" aria-hidden="true"></div>
 <div class="ad-hero-row">
 <div class="ad-hero-main">
 <div class="ad-hero-eyebrow">FLEET SETTLEMENT AUDIT</div>
 <div class="ad-hero-big ${hasFlag ? "flag" : ""}">${hasFlag ? dollars : (s.coverage_pct || 0) + "%"}</div>
 <div class="ad-hero-sub">${hasFlag
 ? `flagged across ${flagged} array${flagged === 1 ? "" : "s"} · production vs. utility settlement`
 : `of your fleet reconciles cleanly · production vs. utility settlement`}</div>
 </div>
 <div class="ad-hero-cov">
 <div class="ad-cov-ring" style="--pct:${s.coverage_pct || 0}">
 <span class="ad-cov-num">${s.auditable || 0}<i>/${s.total || 0}</i></span>
 <span class="ad-cov-lbl">auditable</span>
 </div>
 </div>
 </div>
 <div class="ad-hero-meter" title="How much of the fleet we can fully audit today">
 <span style="width:${s.coverage_pct || 0}%"></span>
 </div>
 <div class="ad-hero-foot">
 <span><b>${s.have_settlement || 0}</b> with utility bills</span>
 <span class="ad-dot">·</span>
 <span><b>${s.have_production || 0}</b> with a production feed</span>
 <span class="ad-dot">·</span>
 <span><b>${s.total || 0}</b> arrays total</span>
 </div>
 </div>`;
 }

 // ── status legend / filter chips ───────────────────────────────────────────
 function chipsHTML(s) {
 const order = ["leak", "leak_unconfirmed", "ok", "incomplete_monitoring", "insufficient_data"];
 const counts = {
 leak: s.leak || 0, leak_unconfirmed: s.leak_unconfirmed || 0, ok: s.ok || 0,
 incomplete_monitoring: s.incomplete_monitoring || 0, insufficient_data: s.insufficient_data || 0,
 };
 const all = order.reduce((a, k) => a + counts[k], 0);
 const chip = (key, label, n) =>
 `<button class="ad-chip ${_filter === key ? "on" : ""}" data-filter="${key}" type="button">
 ${label}<span class="ad-chip-n">${n}</span></button>`;
 let html = `<div class="ad-chips">` + chip("all", "All", all);
 for (const k of order) {
 if (counts[k] > 0) html += chip(k, `<i class="ad-sw ${STATUS[k].cls}"></i>${STATUS[k].label}`, counts[k]);
 }
 return html + `</div>`;
 }

 // ── one per-array verdict row ──────────────────────────────────────────────
 function rowHTML(a) {
 const st = STATUS[a.status] || STATUS.insufficient_data;
 // Variance hue: a flagged gap (leak/unconfirmed) is a concern → tint it like
 // its status, never green. Clean rows show the sign (green up / dim down).
 const flagged = a.status === "leak" || a.status === "leak_unconfirmed";
 const varCls = flagged ? (a.status === "leak" ? "bad" : "warn")
 : (a.variance_pct >= 0 ? "pos" : "dim");
 const varTxt = a.variance_pct != null
 ? `<span class="ad-var ${varCls}">${a.variance_pct > 0 ? "+" : ""}${a.variance_pct}%</span>`
 : "";
 const dollars = (a.status === "leak" || a.status === "leak_unconfirmed") && a.dollars_at_risk
 ? `<div class="ad-row-dollars ${a.status === "leak" ? "hard" : ""}">${usd(a.dollars_at_risk)}<i>at risk</i></div>` : "";
 // production vs settlement mini-compare (only when both exist)
 const cmp = (a.settlement_kwh > 0 || a.production_kwh > 0)
 ? `<div class="ad-row-cmp">
 <span title="metered production">${kwh(a.production_kwh)}</span>
 <span class="ad-cmp-vs">vs</span>
 <span title="utility-settled">${kwh(a.settlement_kwh)}</span>
 </div>` : "";
 return `
 <div class="ad-row ad-row--${st.cls}" data-status="${a.status}">
 <div class="ad-row-status">
 <span class="ad-row-ic ${st.cls}" aria-hidden="true">${st.ic}</span>
 </div>
 <div class="ad-row-main">
 <div class="ad-row-top">
 <span class="ad-row-name">${esc(a.name)}</span>
 <span class="ad-row-badge ${st.cls}">${st.label}</span>
 ${varTxt}
 </div>
 <div class="ad-row-headline">${esc(a.headline)}</div>
 ${a.detail ? `<div class="ad-row-detail">${esc(a.detail)}</div>` : ""}
 ${cmp}
 </div>
 <div class="ad-row-right">${dollars}</div>
 </div>`;
 }

 function render(d) {
 _data = d;
 const r = root(); if (!r) return;
 const s = d.summary || {};
 if (!s.total) { emptyState(); return; }

 const rows = (d.arrays || []).filter(a => _filter === "all" || a.status === _filter);
 const listHTML = rows.length
 ? rows.map(rowHTML).join("")
 : `<div class="ad-none">No arrays in this view.</div>`;

 r.innerHTML = `
 ${heroHTML(s)}
 ${chipsHTML(s)}
 <div class="ad-list">${listHTML}</div>
 <div class="ad-foot">Audited from your utility bills and metered production.
 A gap is only called a <b>confirmed leak</b> when production comes from a
 source independent of the utility (your inverter monitoring). Connect
 monitoring on the <a href="#arrays" style="color:var(--good)">Arrays tab</a>
 to upgrade unconfirmed gaps.</div>`;

 // wire filter chips
 r.querySelectorAll(".ad-chip").forEach(btn => {
 btn.addEventListener("click", () => {
 _filter = btn.getAttribute("data-filter");
 render(_data);
 });
 });
 }

 function load() {
 const s = session();
 if (!s) { emptyState("Sign in to audit your fleet's production against utility settlement."); return; }
 loading();
 fetch(API, { headers: { Authorization: "Bearer " + s } })
 .then(res => {
 if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.auth = true; throw e; }
 if (!res.ok) throw new Error("http " + res.status);
 return res.json();
 })
 .then(render)
 .catch(err => {
 const r = root(); if (!r) return;
 if (err && err.auth) { emptyState("Your session expired, sign in again to run the audit."); return; }
 r.innerHTML = `<div class="ad-empty"><div class="ad-empty-ic">⚠️</div>
 <div class="ad-empty-h">Couldn't run the audit</div>
 <div class="ad-empty-p">Something went wrong. <a href="#audit" onclick="window.__aoLoadAudit&&window.__aoLoadAudit();return false" style="color:var(--good)">Try again</a>.</div></div>`;
 });
 }

 window.__aoLoadAudit = load;
})();
