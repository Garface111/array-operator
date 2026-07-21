/* ============================================================================
 * Array Operator, Analysis tab · Performance Verification (analysis-verification.js)
 *
 * Sunreport-parity layer: portfolio PI from meter-primary measured energy,
 * boundary badge (meter / inverter / mixed), deviation labels + priority, and
 * download links for the monthly PDF pack + auditor export ZIP.
 *
 * Self-registers on window.AnalysisSections. Fetches
 * GET /v1/array-owners/verification/summary with Bearer so_session (same as
 * analysis.js). Never fabricates PI — honest empty when unavailable.
 * Also stashes the last summary on window.__aoVerification for the Performance
 * panel boundary badge (additive only).
 * ========================================================================== */
(function () {
 "use strict";

 window.AnalysisSections = window.AnalysisSections || [];

 var SESSION_KEY = "so_session";
 function getSession() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }

 var _snap = null; // last verification summary json | null
 var _tried = false;
 var _inFlight = false;
 var _err = "";

 function injectCss() {
 if (document.getElementById("anver-css")) return;
 var s = document.createElement("style");
 s.id = "anver-css";
 s.textContent = [
 ".anver-body{padding:18px 18px 20px;}",
 ".anver-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}",
 ".anver-num{font-size:40px;font-weight:800;letter-spacing:-.02em;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;}",
 ".anver-num .u{font-size:16px;font-weight:700;color:var(--muted);margin-left:6px;}",
 ".anver-alt{font-size:13px;font-weight:620;color:var(--muted);margin-top:6px;}",
 ".anver-cap{font-size:12.5px;color:var(--muted);margin-top:8px;max-width:62ch;line-height:1.5;}",
 ".anver-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;}",
 ".anver-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:640;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--bg2);}",
 ".anver-chip b{font-weight:720;color:var(--ink);}",
 ".anver-chip.bnd-meter{color:var(--good);border-color:rgba(37,99,235,.28);background:rgba(37,99,235,.07);}",
 ".anver-chip.bnd-inverter{color:var(--warn);border-color:rgba(217,119,6,.28);background:rgba(217,119,6,.08);}",
 ".anver-chip.bnd-mixed{color:var(--muted);}",
 ".anver-chip.bnd-unavailable{color:var(--faint);}",
 ".anver-chip.dev-sudden{color:var(--bad);border-color:rgba(220,38,38,.28);background:rgba(220,38,38,.07);}",
 ".anver-chip.dev-persistent{color:var(--warn);border-color:rgba(217,119,6,.28);background:rgba(217,119,6,.08);}",
 ".anver-empty{font-size:13px;color:var(--muted);line-height:1.5;max-width:58ch;}",
 ".anver-list{margin-top:16px;border-top:1px solid var(--line);padding-top:6px;}",
 ".anver-list-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:8px 2px;}",
 ".anver-list-h .lab{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);}",
 ".anver-row{display:grid;grid-template-columns:minmax(0,1.4fr) 72px 88px 64px 56px;align-items:center;gap:10px;padding:7px 2px;border-top:1px solid var(--line);font-size:12.5px;}",
 ".anver-row:first-child{border-top:0;}",
 ".anver-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:620;color:var(--ink);}",
 ".anver-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink);}",
 ".anver-val.dim{color:var(--faint);font-weight:600;}",
 ".anver-badge{display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:720;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--bg2);text-transform:capitalize;}",
 ".anver-badge.meter{color:var(--good);border-color:rgba(37,99,235,.28);}",
 ".anver-badge.inverter{color:var(--warn);border-color:rgba(217,119,6,.28);}",
 ".anver-badge.mixed,.anver-badge.unavailable{color:var(--faint);}",
 ".anver-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}",
 ".anver-btn{appearance:none;border:1px solid var(--line);background:var(--bg2);color:var(--ink);font:inherit;font-size:12px;font-weight:680;padding:6px 12px;border-radius:8px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;}",
 ".anver-btn:hover{border-color:var(--good);}",
 ".anver-foot{font-size:11px;color:var(--faint);margin-top:12px;line-height:1.45;max-width:72ch;}",
 "@media (max-width:720px){",
 ".anver-row{grid-template-columns:minmax(0,1fr) 56px 70px 52px;}",
 ".anver-row .hide-sm{display:none;}",
 ".anver-num{font-size:32px;}",
 "}"
 ].join("");
 document.head.appendChild(s);
 }

 function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
 return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
 });
 }
 function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

 function boundaryLabel(b) {
 if (!b) return "—";
 if (b === "meter") return "Meter";
 if (b === "inverter") return "Inverter";
 if (b === "mixed") return "Mixed";
 if (b === "unavailable") return "Unavailable";
 return String(b);
 }

 function portfolioBoundary(arrays) {
 var set = {};
 (arrays || []).forEach(function (a) {
 if (a && a.boundary) set[a.boundary] = true;
 });
 var keys = Object.keys(set).filter(function (k) { return k !== "unavailable"; });
 if (!keys.length) return set.unavailable ? "unavailable" : null;
 if (keys.length === 1) return keys[0];
 return "mixed";
 }

 function loadSummary(force) {
 var s = getSession();
 if (!s) { _snap = null; _tried = true; return; }
 if (_inFlight) return;
 if (_snap && !force) return;
 _inFlight = true;
 var win = 30;
 try {
 var n = Number(sessionStorage.getItem("ao_forecast_window_days"));
 if (n >= 7 && n <= 90) win = n;
 } catch (e) { }
 fetch("/v1/array-owners/verification/summary?window_days=" + win, {
 headers: { Authorization: "Bearer " + s }
 })
 .then(function (r) {
 if (r.status === 401 || r.status === 403) throw new Error("auth");
 return r.ok ? r.json() : null;
 })
 .then(function (d) {
 _snap = d || null;
 _err = "";
 _tried = true;
 _inFlight = false;
 // Share with Performance panel for boundary badge
 try {
 window.__aoVerification = _snap;
 var b = portfolioBoundary((_snap && _snap.arrays) || []);
 if (_snap) {
 _snap.boundary = b;
 var byA = {};
 (_snap.arrays || []).forEach(function (a) {
 if (a && a.array_id != null) byA[String(a.array_id)] = a;
 });
 _snap.byArray = byA;
 }
 } catch (e) { }
 if (window.__aoScheduleAnalysisRender) {
 try { window.__aoScheduleAnalysisRender(); } catch (e2) { }
 }
 // Force parent re-render if available via custom event
 try {
 document.dispatchEvent(new CustomEvent("ao-verification-loaded"));
 } catch (e3) { }
 // Re-render our section host if still mounted
 var host = document.querySelector('[data-section="verification"]');
 if (host && host.__anverRender) host.__anverRender();
 })
 .catch(function (e) {
 _tried = true;
 _inFlight = false;
 _err = (e && e.message === "auth") ? "Sign in to load verification." : "Verification unavailable right now.";
 var host = document.querySelector('[data-section="verification"]');
 if (host && host.__anverRender) host.__anverRender();
 });
 }

 function periodHint() {
 var d = new Date();
 var y = d.getUTCFullYear(), m = d.getUTCMonth(); // 0-based; previous month
 if (m === 0) { y -= 1; m = 12; }
 return y + "-" + String(m).padStart(2, "0");
 }

 function downloadWithAuth(url, filename) {
 var s = getSession();
 if (!s) return;
 fetch(url, { headers: { Authorization: "Bearer " + s } })
 .then(function (r) {
 if (!r.ok) throw new Error("download failed");
 return r.blob().then(function (b) { return { blob: b, type: r.headers.get("Content-Type") }; });
 })
 .then(function (o) {
 var a = document.createElement("a");
 var u = URL.createObjectURL(o.blob);
 a.href = u;
 a.download = filename || "verification-download";
 document.body.appendChild(a);
 a.click();
 setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1500);
 })
 .catch(function () { /* silent — button is best-effort */ });
 }

 function renderBody(ctx) {
 if (!ctx.signedIn || ctx.simulated) {
 return '<div class="anver-empty">Performance Verification compares measured generation to weather-expected energy with a meter-first boundary. Sign in with a live fleet to see portfolio PI, deviation labels, and download the monthly pack.</div>';
 }
 if (!_tried && !_snap) {
 loadSummary(false);
 return '<div class="anver-empty">Loading verification…</div>';
 }
 if (_err && !_snap) {
 return '<div class="anver-empty">' + esc(_err) + '</div>';
 }
 if (!_snap || !_snap.available) {
 var skipped = (_snap && _snap.skipped) ? _snap.skipped.length : 0;
 return '<div class="anver-empty">No verification PI yet for this window'
 + (skipped ? ' (' + skipped + ' site' + (skipped === 1 ? '' : 's') + ' not modeled).' : '.')
 + ' Needs nameplate, location or expected ratio, and measured days that are not bill prorations.</div>';
 }

 var port = _snap.portfolio || {};
 var pi = num(port.performance_index);
 var win = _snap.window_days || 30;
 var b = _snap.boundary || portfolioBoundary(_snap.arrays || []);
 var arrays = (_snap.arrays || []).slice(0, 12);

 var html = '<div class="anver-head"><div>' +
 '<div class="anver-num">' + (pi != null ? pi.toFixed(2) : "—") + '<span class="u">PI</span></div>' +
 '<div class="anver-alt">Portfolio performance index · last ' + win + ' days</div>' +
 '<div class="anver-cap">Measured energy prefers utility meter days, else inverter AC. Expected uses weather POA × nameplate × labeled PR. Methods consistent with IEC 61724-1 / 61724-3.</div>' +
 '<div class="anver-chips">' +
 (b ? '<span class="anver-chip bnd-' + esc(b) + '"><b>' + esc(boundaryLabel(b)) + '</b> boundary</span>' : '') +
 '<span class="anver-chip"><b>' + (port.array_count || 0) + '</b> modeled</span>' +
 (port.skipped_count ? '<span class="anver-chip">' + port.skipped_count + ' skipped</span>' : '') +
 (num(port.max_priority) ? '<span class="anver-chip">max priority <b>' + Math.round(port.max_priority) + '</b></span>' : '') +
 '</div></div></div>';

 if (arrays.length) {
 html += '<div class="anver-list"><div class="anver-list-h"><span class="lab">Priority · worst first</span><span class="lab hide-sm">deviation</span></div>';
 arrays.forEach(function (a) {
 var dev = a.deviation || {};
 var api = num(a.performance_index);
 var label = dev.label || "—";
 var pri = num(dev.priority);
 html += '<div class="anver-row">' +
 '<div class="anver-name">' + esc(a.array_name || ("Array " + a.array_id)) + '</div>' +
 '<div class="anver-val' + (api == null ? " dim" : "") + '">' + (api != null ? api.toFixed(2) : "—") + '</div>' +
 '<div><span class="anver-badge ' + esc(a.boundary || "") + '">' + esc(boundaryLabel(a.boundary)) + '</span></div>' +
 '<div class="anver-badge dev">' + esc(label) + '</div>' +
 '<div class="anver-val' + (pri == null ? " dim" : "") + '">' + (pri != null ? Math.round(pri) : "—") + '</div>' +
 '</div>';
 });
 html += '</div>';
 }

 var per = periodHint();
 var end = _snap.window_end || "";
 var start = _snap.window_start || "";
 html += '<div class="anver-actions">' +
 '<button type="button" class="anver-btn" data-dl="pdf">Download monthly PDF</button>' +
 '<button type="button" class="anver-btn" data-dl="auditor">Auditor export (ZIP)</button>' +
 '</div>';
 html += '<div class="anver-foot">' + esc(_snap.report_footer || "Performance Verification · IEC 61724-aligned methods · not a third-party certification") + '</div>';

 return html;
 }

 function wireActions(container) {
 var pdfBtn = container.querySelector('[data-dl="pdf"]');
 if (pdfBtn) {
 pdfBtn.addEventListener("click", function () {
 var per = periodHint();
 downloadWithAuth(
 "/v1/array-owners/verification/report.pdf?period=" + encodeURIComponent(per),
 "verification-" + per + ".pdf"
 );
 });
 }
 var audBtn = container.querySelector('[data-dl="auditor"]');
 if (audBtn) {
 audBtn.addEventListener("click", function () {
 var start = (_snap && _snap.window_start) || "";
 var end = (_snap && _snap.window_end) || "";
 if (!start || !end) return;
 downloadWithAuth(
 "/v1/array-owners/verification/auditor-export?start=" + encodeURIComponent(start) +
 "&end=" + encodeURIComponent(end),
 "verification-auditor-" + start + "_" + end + ".zip"
 );
 });
 }
 }

 function render(container, ctx) {
 injectCss();
 container.__anverRender = function () { render(container, ctx); };
 var body = renderBody(ctx);
 container.innerHTML =
 '<div class="an-card">' +
 ' <div class="an-card-head">' +
 ' <div><h3>Verification</h3>' +
 ' <div class="an-card-sub">Meter-primary PI · deviation · monthly pack</div></div>' +
 ' </div>' +
 ' <div class="anver-body">' + body + '</div>' +
 '</div>';
 wireActions(container);
 if (ctx.signedIn && !ctx.simulated && !_snap && !_inFlight) loadSummary(false);
 }

 window.AnalysisSections.push({
 id: "verification",
 title: "Verification",
 order: 32, // just after Performance (30)
 render: render
 });
})();
