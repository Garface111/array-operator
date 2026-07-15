/* ============================================================================
 * Array Operator, Analysis tab · Production vs Expected (analysis-forecast.js)
 *
 * Lead hero of the Analysis tab (order 1). Weather-adjusted fleet production vs
 * the real sunlight on each site, big calm % verdict, then a simple model
 * system: EVERY array listed with its own address / tilt / facing / losses.
 * When setup is complete the editor collapses to a one-line summary.
 *
 * Data: shared ctx.forecast from /v1/array-owners/forecast-fleet. Never fabricates.
 * ========================================================================== */
(function () {
 "use strict";

 window.AnalysisSections = window.AnalysisSections || [];

 var _howOpen = false; // "how the number is built" drawer
 var _modelOpen = null; // null = auto (open when needs setup); true/false force
 var _dirty = false; // unsaved edits in the model list
 var _autofillTried = false; // one auto-propagate per page load
 var _autofilling = false;

 var CONF_LABEL = {
 high: "high confidence", medium: "moderate confidence",
 low: "limited data so far", none: "not enough measured days yet"
 };

 var AZ_OPTIONS = [
 { v: 0, lab: "South" },
 { v: -45, lab: "Southeast" },
 { v: 45, lab: "Southwest" },
 { v: -90, lab: "East" },
 { v: 90, lab: "West" },
 { v: 180, lab: "North" }
 ];

 // VT community-solar rule-of-thumb when we have no lat yet (≈ Burlington lat).
 var DEFAULT_TILT_VT = 44;

 function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }
 function windowDays(fc, ctx) {
 if (typeof window.__aoGetForecastWindow === "function") {
 var w = window.__aoGetForecastWindow();
 if (w >= 3 && w <= 30) return w;
 }
 return (fc && fc.window && fc.window.days) || (ctx && ctx.windowDays) || 10;
 }

 /** Strip geocode annotations so we never re-submit "Londonderry, VT (from site name)". */
 function cleanAddress(addr) {
 if (addr == null || addr === "") return "";
 return String(addr)
 .replace(/\s*\(from\s+[^)]*\)\s*/gi, "")
 .replace(/\s*\(geocoded[^)]*\)\s*/gi, "")
 .replace(/\s+/g, " ")
 .trim();
 }

 /** Derive a geocodable place from the array name (client-side mirror of backend). */
 function placeFromName(name) {
 if (!name) return "";
 var s = String(name)
 .replace(/\s*\([^)]*\)\s*/g, " ")
 .replace(/\s+\d[\d.]*\s*(kW|kw|MW|mw)?\b/gi, " ")
 .replace(/\b(SolarEdge|Fronius|SMA|Chint|CPS|Locus|Enphase)\b/gi, " ")
 .replace(/\s+/g, " ")
 .replace(/^[\s\-_,]+|[\s\-_,]+$/g, "");
 if (!s || s.length < 2) return "";
 if (/^[\dA-Za-z_-]{1,6}$/.test(s)) return "";
 if (!/,\s*[A-Za-z]{2}\b/.test(s)) s = s + ", VT";
 return s;
 }

 function defaultTilt(lat) {
 if (lat != null && isFinite(Number(lat))) {
 var t = Math.abs(Number(lat));
 return Math.round(Math.max(10, Math.min(60, t)) * 10) / 10;
 }
 return DEFAULT_TILT_VT;
 }

 function azLabel(az) {
 var n = Number(az);
 for (var i = 0; i < AZ_OPTIONS.length; i++) {
 if (AZ_OPTIONS[i].v === n) return AZ_OPTIONS[i].lab;
 }
 return (isFinite(n) ? n + "°" : "South");
 }

 /** Build the unified list of arrays that can have model variables.
 * Blanks are pre-filled with smart defaults so the form is never a wall of empty boxes:
 * address ← stored / place-from-name
 * tilt ← stored / ≈ latitude / VT default 44°
 * facing ← South
 * PR ← 84%
 */
 function modelableArrays(f) {
 var out = [];
 var seen = {};
 (f.rows || []).forEach(function (r) {
 seen[r.array_id] = true;
 var addr = cleanAddress(r.address) || placeFromName(r.array_name);
 var tilt = r.tilt_deg != null && r.tilt_deg !== ""
 ? r.tilt_deg
 : defaultTilt(r.latitude);
 out.push({
 array_id: r.array_id,
 array_name: r.array_name || ("Array " + r.array_id),
 nameplate_kw: r.nameplate_kw,
 address: addr,
 raw_address: r.address || "",
 has_location: !!(r.latitude != null && r.longitude != null) || !!(r.address || r.geocode_source),
 tilt_deg: tilt,
 azimuth_deg: r.azimuth_deg != null ? r.azimuth_deg : 0,
 performance_ratio: r.performance_ratio != null ? r.performance_ratio : 0.84,
 tilt_assumed: r.tilt_assumed != null ? !!r.tilt_assumed : true,
 azimuth_assumed: r.azimuth_assumed != null ? !!r.azimuth_assumed : true,
 pr_assumed: r.performance_ratio_assumed != null ? !!r.performance_ratio_assumed : true,
 needs_location: false,
 ratio_pct: r.ratio_pct,
 modeled: true,
 addr_guessed: !cleanAddress(r.address) && !!placeFromName(r.array_name)
 });
 });
 (f.skipped || []).forEach(function (s) {
 if (seen[s.array_id]) return;
 // Only surfaces where the operator can still fix the model with inputs.
 if (s.reason !== "no_location" && s.reason !== "irradiance_unavailable") return;
 seen[s.array_id] = true;
 var addrS = cleanAddress(s.address) || placeFromName(s.array_name);
 out.push({
 array_id: s.array_id,
 array_name: s.array_name || ("Array " + s.array_id),
 nameplate_kw: s.nameplate_kw,
 address: addrS,
 raw_address: s.address || "",
 has_location: false,
 tilt_deg: s.tilt_deg != null && s.tilt_deg !== "" ? s.tilt_deg : defaultTilt(s.latitude),
 azimuth_deg: s.azimuth_deg != null ? s.azimuth_deg : 0,
 performance_ratio: s.performance_ratio != null ? s.performance_ratio : 0.84,
 tilt_assumed: true,
 azimuth_assumed: true,
 pr_assumed: true,
 needs_location: s.reason === "no_location",
 ratio_pct: null,
 modeled: false,
 addr_guessed: !cleanAddress(s.address) && !!placeFromName(s.array_name)
 });
 });
 out.sort(function (a, b) {
 return String(a.array_name).localeCompare(String(b.array_name));
 });
 return out;
 }

 function anyBlankAddress(arrays) {
 return arrays.some(function (a) {
 return !a.raw_address && !a.has_location;
 });
 }

 function needsSetup(arrays) {
 return arrays.some(function (a) { return a.needs_location || !a.has_location; });
 }

 function isModelOpen(arrays) {
 if (_modelOpen === true) return true;
 if (_modelOpen === false) return false;
 // Auto: open while any site still needs a location; otherwise stay collapsed.
 return needsSetup(arrays);
 }

 // ---- one-time scoped CSS --------------------------------------------------
 function injectCss() {
 if (document.getElementById("anfc-css")) return;
 var s = document.createElement("style");
 s.id = "anfc-css";
 s.textContent = [
 /* ── hero shell ── */
 ".anfc-hero{padding:28px 28px 26px;}",
 ".anfc-kicker{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:var(--good);margin:0 0 10px;}",
 ".anfc-kicker i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgba(37,99,235,.18);}",
 ".anfc-title{font-size:22px;font-weight:760;letter-spacing:-.025em;color:var(--ink);margin:0 0 4px;line-height:1.2;}",
 ".anfc-lede{font-size:13.5px;color:var(--muted);line-height:1.5;margin:0 0 22px;max-width:52ch;}",
 ".anfc-lede b{color:var(--ink);font-weight:650;}",

 /* ── verdict strip ── */
 ".anfc-verdict-row{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:28px;align-items:end;}",
 "@media (max-width:720px){.anfc-verdict-row{grid-template-columns:1fr;gap:18px;}}",
 ".anfc-pct{font-size:64px;font-weight:800;letter-spacing:-.035em;line-height:.92;color:var(--ink);font-variant-numeric:tabular-nums;}",
 ".anfc-pct span{font-size:28px;font-weight:700;color:var(--muted);margin-left:2px;}",
 ".anfc-pct-lab{display:block;font-size:13px;font-weight:600;color:var(--faint);letter-spacing:.01em;margin-top:8px;}",
 ".anfc-nums{text-align:right;font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1.55;padding-bottom:6px;}",
 "@media (max-width:720px){.anfc-nums{text-align:left;}}",
 ".anfc-nums b{display:block;font-size:20px;font-weight:750;color:var(--ink);letter-spacing:-.02em;}",
 ".anfc-nums .anfc-num-sub{font-size:13px;color:var(--faint);}",

 /* progress */
 ".anfc-track{position:relative;height:10px;border-radius:999px;background:rgba(14,20,32,.06);overflow:hidden;margin:18px 0 10px;}",
 ".anfc-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--good2,#60a5fa),var(--good));transition:width .55s cubic-bezier(.2,.8,.2,1);}",
 ".anfc-fill.warn{background:linear-gradient(90deg,#fca5a5,var(--bad));}",
 ".anfc-fill.soft{background:linear-gradient(90deg,#fcd34d,var(--warn));}",
 ".anfc-mark{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink);opacity:.28;border-radius:1px;}",
 ".anfc-verdict{font-size:14px;font-weight:650;color:var(--muted);margin:0;}",
 ".anfc-verdict.warn{color:var(--bad);} .anfc-verdict.ok{color:var(--good);}",

 /* spotlight chip */
 ".anfc-spot{margin-top:16px;font-size:13px;color:var(--muted);line-height:1.5;background:rgba(37,99,235,.05);border:1px solid rgba(37,99,235,.14);border-radius:12px;padding:11px 14px;}",
 ".anfc-spot b{color:var(--ink);} .anfc-spot .good{color:var(--good);} .anfc-spot .bad{color:var(--bad);}",

 ".anfc-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}",
 ".anfc-chip{font-size:11.5px;font-weight:650;color:var(--muted);background:rgba(14,20,32,.04);border:1px solid rgba(14,20,32,.06);border-radius:999px;padding:5px 11px;}",
 ".anfc-chip b{color:var(--ink);font-weight:720;}",

 /* ── model panel ── */
 ".anfc-model{margin-top:22px;border-radius:16px;background:linear-gradient(165deg,rgba(255,255,255,.92),rgba(247,251,255,.88));border:1px solid rgba(14,20,32,.07);box-shadow:0 8px 28px -18px rgba(20,60,120,.22);overflow:hidden;}",
 ".anfc-model-sum{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 18px;cursor:pointer;user-select:none;}",
 ".anfc-model-sum:hover{background:rgba(37,99,235,.03);}",
 ".anfc-model-sum-l{display:flex;flex-direction:column;gap:3px;min-width:0;}",
 ".anfc-model-h{font-size:12px;font-weight:780;letter-spacing:.06em;text-transform:uppercase;color:var(--good);margin:0;}",
 ".anfc-model-sub{font-size:12.5px;color:var(--muted);margin:0;line-height:1.4;}",
 ".anfc-model-sub b{color:var(--ink);font-weight:650;}",
 ".anfc-model-sum-r{display:flex;align-items:center;gap:10px;flex-shrink:0;}",
 ".anfc-pill{font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(14,20,32,.05);color:var(--muted);}",
 ".anfc-pill.warn{background:rgba(217,119,6,.1);color:var(--warn,#b45309);}",
 ".anfc-pill.ok{background:rgba(37,99,235,.08);color:var(--good);}",
 ".anfc-chev{font-size:12px;color:var(--faint);transition:transform .15s;}",
 ".anfc-model.is-open .anfc-chev{transform:rotate(180deg);}",

 ".anfc-model-body{padding:0 18px 16px;border-top:1px solid rgba(14,20,32,.06);}",
 ".anfc-model-intro{font-size:12.5px;color:var(--muted);margin:12px 0 12px;line-height:1.45;}",
 ".anfc-model-tools{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:12px;}",
 ".anfc-fld{display:flex;flex-direction:column;gap:5px;min-width:0;}",
 ".anfc-fld label{font-size:10.5px;font-weight:720;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);}",
 ".anfc-fld input,.anfc-fld select,.anfc-row input,.anfc-row select{box-sizing:border-box;font:inherit;font-size:13px;font-weight:600;padding:9px 11px;border-radius:10px;border:1px solid rgba(14,20,32,.1);background:rgba(255,255,255,.95);color:var(--ink);transition:border-color .12s,box-shadow .12s;}",
 ".anfc-fld input:focus,.anfc-fld select:focus,.anfc-row input:focus,.anfc-row select:focus{outline:none;border-color:rgba(37,99,235,.5);box-shadow:0 0 0 3px rgba(37,99,235,.12);}",
 ".anfc-fld-win{width:160px;}",

 /* per-array table */
 ".anfc-list{display:flex;flex-direction:column;gap:0;border:1px solid rgba(14,20,32,.07);border-radius:12px;overflow:hidden;background:#fff;}",
 ".anfc-list-head,.anfc-row{display:grid;grid-template-columns:minmax(120px,1.3fr) minmax(140px,1.6fr) 72px 110px 72px;gap:10px;align-items:center;padding:10px 12px;}",
 "@media (max-width:820px){.anfc-list-head{display:none;}.anfc-row{grid-template-columns:1fr 1fr;gap:8px;padding:12px;border-bottom:1px solid rgba(14,20,32,.06);}.anfc-row .anfc-site{grid-column:1/-1;}.anfc-row .anfc-addr{grid-column:1/-1;}}",
 ".anfc-list-head{background:rgba(14,20,32,.03);font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid rgba(14,20,32,.06);}",
 ".anfc-row{border-bottom:1px solid rgba(14,20,32,.05);}",
 ".anfc-row:last-child{border-bottom:0;}",
 ".anfc-row.needs{background:rgba(217,119,6,.04);}",
 ".anfc-row input,.anfc-row select{width:100%;}",
 ".anfc-site{min-width:0;}",
 ".anfc-site-name{font-size:13px;font-weight:700;color:var(--ink);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
 ".anfc-site-meta{font-size:11px;color:var(--faint);margin-top:2px;}",
 ".anfc-site-meta .need{color:var(--warn,#b45309);font-weight:700;}",
 ".anfc-site-meta .ok{color:var(--good);}",
 ".anfc-assumed{font-size:10px;font-weight:700;color:var(--faint);letter-spacing:.02em;}",

 ".anfc-edit-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px;}",
 ".anfc-btn{font:inherit;font-size:13px;font-weight:740;padding:10px 18px;border-radius:11px;border:0;cursor:pointer;background:linear-gradient(180deg,var(--good2,#60a5fa),var(--good));color:#fff;box-shadow:0 6px 16px -8px rgba(37,99,235,.55);}",
 ".anfc-btn:hover{filter:brightness(1.04);}",
 ".anfc-btn:disabled{opacity:.55;cursor:default;filter:none;}",
 ".anfc-btn-ghost{background:transparent;color:var(--muted);border:1px solid rgba(14,20,32,.1);box-shadow:none;}",
 ".anfc-btn-ghost:hover{color:var(--ink);border-color:rgba(14,20,32,.18);}",
 ".anfc-edit-stat{font-size:12.5px;color:var(--muted);}",
 ".anfc-edit-stat.ok{color:var(--good);font-weight:650;}",
 ".anfc-edit-stat.info{color:var(--good,#2563eb);font-weight:650;}",
 ".anfc-edit-stat.err{color:var(--bad);font-weight:650;}",

 /* quiet details */
 ".anfc-details{margin-top:16px;}",
 ".anfc-toggle{border:0;background:none;color:var(--good);font:inherit;font-size:13px;font-weight:680;cursor:pointer;padding:0;}",
 ".anfc-toggle:hover{text-decoration:underline;}",
 ".anfc-how{margin-top:12px;padding-top:14px;border-top:1px solid rgba(14,20,32,.07);}",
 ".anfc-how-eq{font-size:12.5px;color:var(--ink);background:rgba(37,99,235,.05);border:1px solid rgba(37,99,235,.12);border-radius:10px;padding:11px 14px;font-variant-numeric:tabular-nums;letter-spacing:.01em;}",
 ".anfc-how-dl{display:grid;grid-template-columns:auto 1fr;gap:9px 18px;margin:14px 0 0;font-size:13px;}",
 ".anfc-how-dl dt{font-weight:720;color:var(--faint);text-transform:uppercase;font-size:10.5px;letter-spacing:.04em;padding-top:3px;}",
 ".anfc-how-dl dd{margin:0;color:var(--muted);line-height:1.5;}",
 ".anfc-how-dl dd b{color:var(--ink);} .anfc-how-dl dd em{color:var(--faint);font-style:italic;}",
 ".anfc-how-foot{font-size:12px;color:var(--faint);margin-top:14px;line-height:1.55;}",
 ".anfc-how-foot b{color:var(--muted);}",

 /* empty */
 ".anfc-empty{display:flex;gap:14px;align-items:flex-start;padding:8px 0;}",
 ".anfc-empty-ic{flex:0 0 auto;width:40px;height:40px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--faint);}",
 ".anfc-empty-tx b{display:block;font-size:15px;font-weight:720;color:var(--ink);margin-bottom:4px;letter-spacing:-.01em;}",
 ".anfc-empty-tx span{font-size:13px;color:var(--muted);line-height:1.5;}"
 ].join("");
 document.head.appendChild(s);
 }

 function summaryLine(arrays) {
 var n = arrays.length;
 var needLoc = arrays.filter(function (a) { return a.needs_location || !a.has_location; }).length;
 var assumed = arrays.filter(function (a) { return a.tilt_assumed || a.azimuth_assumed || a.pr_assumed; }).length;
 if (needLoc) {
 return "<b>" + needLoc + "</b> site" + (needLoc === 1 ? "" : "s") + " need an address · " + n + " total";
 }
 if (assumed === n && n > 0) {
 return "<b>" + n + "</b> site" + (n === 1 ? "" : "s") + " · using default tilt / facing / losses";
 }
 if (assumed > 0) {
 return "<b>" + n + "</b> site" + (n === 1 ? "" : "s") + " · " + assumed + " still on defaults";
 }
 return "<b>" + n + "</b> site" + (n === 1 ? "" : "s") + " configured";
 }

 function modelHTML(f, ctx) {
 var esc = ctx.esc;
 var arrays = modelableArrays(f);
 var open = isModelOpen(arrays);
 var need = needsSetup(arrays);
 var curWin = windowDays(f, ctx);
 var winOpts = [7, 10, 14, 21, 30].map(function (d) {
 return '<option value="' + d + '"' + (Number(curWin) === d ? " selected" : "") + ">Last " + d + " days</option>";
 }).join("");

 var pill = need
 ? '<span class="anfc-pill warn">needs address</span>'
 : '<span class="anfc-pill ok">' + arrays.length + " sites</span>";

 var sum =
 '<div class="anfc-model-sum" data-anfc-sum role="button" tabindex="0" aria-expanded="' + open + '">' +
 '<div class="anfc-model-sum-l">' +
 '<div class="anfc-model-h">Model</div>' +
 '<p class="anfc-model-sub">' + summaryLine(arrays) + "</p>" +
 "</div>" +
 '<div class="anfc-model-sum-r">' + pill +
 '<span class="anfc-chev" aria-hidden="true">▾</span>' +
 "</div></div>";

 if (!open) {
 return '<div class="anfc-model" id="anfcEdit">' + sum + "</div>";
 }

 var head =
 '<div class="anfc-list-head">' +
 "<div>Array</div><div>Address</div><div>Tilt °</div><div>Facing</div><div>PR %</div>" +
 "</div>";

 var rows = arrays.map(function (a) {
 var prPct = Math.round((a.performance_ratio != null ? a.performance_ratio : 0.84) * 100);
 var tiltVal = a.tilt_deg != null && a.tilt_deg !== "" ? a.tilt_deg : "";
 var azOpts = AZ_OPTIONS.map(function (o) {
 return '<option value="' + o.v + '"' + (Number(a.azimuth_deg) === o.v ? " selected" : "") + ">" + o.lab + "</option>";
 }).join("");
 var metaBits = [];
 if (a.nameplate_kw != null) metaBits.push(a.nameplate_kw + " kW");
 if (a.needs_location || !a.has_location) metaBits.push('<span class="need">needs location</span>');
 else if (a.addr_guessed) metaBits.push('<span class="assumed">address from name</span>');
 else if (a.tilt_assumed || a.azimuth_assumed || a.pr_assumed) metaBits.push('<span class="assumed">defaults</span>');
 else if (a.ratio_pct != null) metaBits.push(a.ratio_pct + "% of expected");
 var meta = metaBits.join(" · ");
 // data-orig-addr is the STORED address (not the place-from-name guess) so
 // saving a guess still posts it as a real location change.
 return '<div class="anfc-row' + (a.needs_location || !a.has_location ? " needs" : "") + '" data-aid="' + esc(String(a.array_id)) + '" data-orig-addr="' + esc(cleanAddress(a.raw_address)) + '">' +
 '<div class="anfc-site"><div class="anfc-site-name" title="' + esc(a.array_name) + '">' + esc(a.array_name) + "</div>" +
 '<div class="anfc-site-meta">' + meta + "</div></div>" +
 '<div class="anfc-addr"><input type="text" data-f="addr" placeholder="Town, state or street" value="' + esc(a.address) + '" autocomplete="street-address" title="' + (a.addr_guessed ? "Guessed from site name, confirm or edit" : "Site address") + '"></div>' +
 '<div><input type="number" data-f="tilt" min="0" max="90" step="0.5" value="' + esc(String(tiltVal)) + '" placeholder="≈lat" title="Panel tilt ° from horizontal' + (a.tilt_assumed ? " (assumed ≈ latitude)" : "") + '"></div>' +
 '<div><select data-f="az" title="' + (a.azimuth_assumed ? "Assumed south-facing" : "You set") + '">' + azOpts + "</select></div>" +
 '<div><input type="number" data-f="pr" min="50" max="100" step="1" value="' + prPct + '" title="Performance ratio, losses from DC nameplate to AC' + (a.pr_assumed ? " (default 84%)" : "") + '"></div>' +
 "</div>";
 }).join("");

 if (!rows) {
 rows = '<div style="padding:16px;font-size:13px;color:var(--muted)">No arrays with inverter data yet, connect a vendor portal first.</div>';
 }

 var body =
 '<div class="anfc-model-body">' +
 '<p class="anfc-model-intro">Angles, facing, losses, and address, pre-filled from utility bills, vendor portals, and site names where we know them. Tilt defaults to ≈ latitude; facing defaults to south; losses default to 84%. Address is only re-geocoded when you change it.</p>' +
 '<div class="anfc-model-tools">' +
 '<div class="anfc-fld anfc-fld-win"><label for="anfcWin">Comparison window</label>' +
 '<select id="anfcWin">' + winOpts + "</select></div>" +
 "</div>" +
 '<div class="anfc-list">' + head + rows + "</div>" +
 '<div class="anfc-edit-actions">' +
 '<button type="button" class="anfc-btn" id="anfcApply">Save &amp; recalculate</button>' +
 '<button type="button" class="anfc-btn anfc-btn-ghost" id="anfcAutofill" title="Pull addresses from utility bills, vendor sites, and place names">Autofill from known data</button>' +
 '<button type="button" class="anfc-btn anfc-btn-ghost" id="anfcDone">Done</button>' +
 '<span class="anfc-edit-stat" id="anfcStat"></span>' +
 "</div></div>";

 return '<div class="anfc-model is-open" id="anfcEdit">' + sum + body + "</div>";
 }

 function detailsHTML(f, ctx) {
 var esc = ctx.esc;
 var i = f.inputs || {};
 var loc = i.location || {}, g = i.geometry || {}, ir = i.irradiance || {};
 var srcName = ({ census: "street address (rooftop)", nominatim: "street address (OpenStreetMap)",
 "open-meteo": "town centroid", manual: "operator-set" })[loc.geocode_source] || loc.geocode_source || "—";
 var prAssumed = i.performance_ratio_assumed;
 if (prAssumed == null && i.performance_ratio != null)
 prAssumed = Math.abs(Number(i.performance_ratio) - 0.84) < 1e-9;
 var tiltTxt = g.tilt_deg != null
 ? (g.tilt_deg + "° tilt" + (g.tilt_assumed ? " <em>(assumed ≈ latitude)</em>" : " <em>(you set)</em>"))
 : "—";
 var azTxt = g.azimuth_deg != null
 ? ("facing " + esc(g.azimuth_label || "south") + (g.azimuth_assumed ? " <em>(assumed)</em>" : " <em>(you set)</em>"))
 : "—";
 var win = windowDays(f, ctx);
 var prPct = i.performance_ratio != null ? Math.round(i.performance_ratio * 100) : 84;
 var addrShow = cleanAddress(loc.address) || "—";
 var rows = [
 ["Where", esc(addrShow) + " · " + esc(srcName) + (loc.lat != null ? " → " + loc.lat + ", " + loc.lng : "")],
 ["Sunlight", esc(ir.source || "Open-Meteo") + " · " + esc(ir.window_start || "") + "–" + esc(ir.window_end || "") +
 ". Best day: <b>" + (ir.best_day_poa_kwh_m2 != null ? ir.best_day_poa_kwh_m2 : "—") + " kWh/m²</b> POA. <em>Real weather, not editable.</em>"],
 ["Panel angle", tiltTxt + ", " + azTxt],
 ["Capacity", "<b>" + (i.nameplate_kw != null ? i.nameplate_kw : "—") + " kW</b> nameplate from inverters"],
 ["Losses", "PR <b>" + prPct + "%</b>" + (prAssumed ? " <em>(default)</em>" : " <em>(custom)</em>") +
 ", inverter, wiring, heat, soiling, mismatch"],
 ["Measured", "Inverter/metered kWh only (utility-bill estimates excluded). " +
 (i.measured_days != null ? i.measured_days : "0") + " day(s) in the " + win + "-day window."]
 ];
 var dl = rows.map(function (kv) {
 return "<dt>" + esc(kv[0]) + "</dt><dd>" + kv[1] + "</dd>";
 }).join("");
 return '<div class="anfc-how">' +
 '<div class="anfc-how-eq">expected kWh = nameplate kW × (sunlight ÷ 1 kW/m² STC) × performance ratio</div>' +
 '<dl class="anfc-how-dl">' + dl + "</dl>" +
 '<div class="anfc-how-foot">A weather-adjusted expected, cloudy stretches run under, clear ones over. Real sun on each site catches whole-fleet dips (soiling, snow, smoke) that peer checks miss. ' +
 (f.arrays_skipped ? (f.arrays_skipped + " array(s) not yet modeled.") : "") +
 "</div></div>";
 }

 function readRow(el) {
 var addrEl = el.querySelector('[data-f="addr"]');
 var tiltEl = el.querySelector('[data-f="tilt"]');
 var azEl = el.querySelector('[data-f="az"]');
 var prEl = el.querySelector('[data-f="pr"]');
 var addr = cleanAddress(addrEl ? addrEl.value : "");
 var orig = cleanAddress(el.getAttribute("data-orig-addr") || "");
 var tiltRaw = tiltEl && tiltEl.value.trim() !== "" ? Number(tiltEl.value) : null;
 var az = azEl ? Number(azEl.value) : 0;
 var prPct = prEl ? Number(prEl.value) : 84;
 return {
 array_id: Number(el.getAttribute("data-aid")),
 address: addr,
 address_changed: addr !== "" && addr.toLowerCase() !== orig.toLowerCase(),
 needs_address: !orig && !addr,
 had_address: !!orig,
 tilt_deg: tiltRaw,
 azimuth_deg: az,
 pr_pct: prPct,
 performance_ratio: Math.round(prPct) / 100
 };
 }

 function wireModel(container, f, ctx) {
 var root = container.querySelector("#anfcEdit");
 if (!root) return;

 var sum = root.querySelector("[data-anfc-sum]");
 if (sum) {
 var toggle = function (e) {
 if (e && e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
 if (e && e.type === "keydown") e.preventDefault();
 // Don't collapse while dirty without saving, just flip state.
 _modelOpen = !isModelOpen(modelableArrays(f));
 render(container, ctx);
 };
 sum.addEventListener("click", toggle);
 sum.addEventListener("keydown", toggle);
 }

 var stat = root.querySelector("#anfcStat");
 function setStat(msg, cls) {
 if (!stat) return;
 stat.className = "anfc-edit-stat" + (cls ? " " + cls : "");
 stat.textContent = msg || "";
 }

 // Mark dirty on any field change so Done can warn.
 root.querySelectorAll(".anfc-row input, .anfc-row select").forEach(function (inp) {
 inp.addEventListener("input", function () { _dirty = true; });
 inp.addEventListener("change", function () { _dirty = true; });
 });

 var done = root.querySelector("#anfcDone");
 if (done) done.addEventListener("click", function () {
 if (_dirty) {
 setStat("Save first, or your edits won’t apply.", "err");
 return;
 }
 _modelOpen = false;
 render(container, ctx);
 });

 function runAutofill(btn) {
 if (!window.__aoAutofillModel) {
 setStat("Autofill unavailable.", "err");
 return;
 }
 if (_autofilling) return;
 _autofilling = true;
 if (btn) btn.disabled = true;
 setStat("Pulling addresses from utility bills & vendors…");
 window.__aoAutofillModel().then(function (d) {
 _autofilling = false;
 if (btn) btn.disabled = false;
 var n = (d && d.addresses_filled) || 0;
 var loc = (d && d.newly_located) || 0;
 var msg = n || loc
 ? ("Filled " + n + " address" + (n === 1 ? "" : "es")
 + (loc ? (" · located " + loc + " new") : "")
 + " · recalculating…")
 : "Already up to date, using defaults for tilt / facing / losses.";
 setStat(msg, "ok");
 _dirty = false;
 }).catch(function (e) {
 _autofilling = false;
 if (btn) btn.disabled = false;
 setStat((e && e.message) || "Autofill failed.", "err");
 });
 }

 var autofillBtn = root.querySelector("#anfcAutofill");
 if (autofillBtn) autofillBtn.addEventListener("click", function () {
 runAutofill(autofillBtn);
 });

 // One automatic propagate when the editor opens and addresses are blank.
 var arrays = modelableArrays(f || {});
 if (!_autofillTried && !_autofilling && typeof window.__aoAutofillModel === "function"
 && arrays.some(function (a) { return !a.raw_address; })) {
 _autofillTried = true;
 runAutofill(autofillBtn);
 }

 var apply = root.querySelector("#anfcApply");
 if (!apply) return;

 apply.addEventListener("click", function () {
 var rows = [].slice.call(root.querySelectorAll(".anfc-row[data-aid]"));
 if (!rows.length) { setStat("No arrays to save.", "err"); return; }

 var parsed = rows.map(readRow);
 for (var i = 0; i < parsed.length; i++) {
 var p = parsed[i];
 if (p.tilt_deg != null && (isNaN(p.tilt_deg) || p.tilt_deg < 0 || p.tilt_deg > 90)) {
 setStat("Tilt must be 0–90°.", "err"); return;
 }
 if (isNaN(p.pr_pct) || p.pr_pct < 50 || p.pr_pct > 100) {
 setStat("PR must be 50–100%.", "err"); return;
 }
 if (p.needs_address || (!p.had_address && !p.address && p.address_changed === false)) {
 // Allow geometry-only save when already located; require address only when never set.
 }
 }

 var winEl = root.querySelector("#anfcWin");
 var win = winEl ? Number(winEl.value) : 10;
 if (typeof window.__aoSetForecastWindow === "function" &&
 typeof window.__aoGetForecastWindow === "function" &&
 win !== window.__aoGetForecastWindow()) {
 window.__aoSetForecastWindow(win);
 }

 setStat("Saving…", "info");
 apply.disabled = true;

 // Sequential saves: location first (if changed), then geometry+PR per array.
 var chain = Promise.resolve({ nLoc: 0, nGeo: 0, errors: [] });
 parsed.forEach(function (p) {
 chain = chain.then(function (acc) {
 var step = Promise.resolve();
 var needLoc = p.address_changed || (!p.had_address && p.address);
 if (needLoc) {
 if (!window.__aoSetArrayLocation) {
 acc.errors.push("Location edit unavailable");
 return acc;
 }
 step = step.then(function () {
 return window.__aoSetArrayLocation(p.array_id, { place: p.address, silent: true })
 .then(function () { acc.nLoc++; })
 .catch(function (e) {
 acc.errors.push((e && e.message) || ("Address failed for array " + p.array_id));
 });
 });
 }
 return step.then(function () {
 if (!window.__aoSetArrayGeometry) {
 acc.errors.push("Geometry edit unavailable");
 return acc;
 }
 return window.__aoSetArrayGeometry(p.array_id, {
 tilt_deg: p.tilt_deg,
 azimuth_deg: p.azimuth_deg,
 performance_ratio: p.performance_ratio,
 silent: true
 }).then(function () {
 acc.nGeo++;
 return acc;
 }).catch(function (e) {
 acc.errors.push((e && e.message) || ("Couldn't save array " + p.array_id));
 return acc;
 });
 });
 });
 });

 chain.then(function (acc) {
 apply.disabled = false;
 // Hard fail only when nothing saved.
 if (acc.errors.length && !acc.nGeo && !acc.nLoc) {
 setStat(acc.errors[0] + (acc.errors.length > 1 ? " (+" + (acc.errors.length - 1) + " more)" : ""), "err");
 _dirty = true;
 return;
 }
 _dirty = false;
 var parts = [];
 if (acc.nGeo) parts.push(acc.nGeo + " array" + (acc.nGeo === 1 ? "" : "s"));
 if (acc.nLoc) parts.push(acc.nLoc + " address" + (acc.nLoc === 1 ? "" : "es"));
 var msg = "Saved " + (parts.join(" · ") || "changes");
 // Partial address issues are notes, not alarms, success stays green/blue.
 if (acc.errors.length) {
 msg += " · " + acc.errors.length + " address note" + (acc.errors.length === 1 ? "" : "s");
 }
 setStat(msg + " · recalculating…", "ok");
 // Collapse after a successful save when every row has an address string.
 var allHaveAddr = parsed.every(function (p) {
 return p.had_address || p.address;
 });
 if (allHaveAddr) {
 _modelOpen = false;
 }
 // One forecast reload after the whole batch (silent saves skip per-row reload).
 if (typeof window.__aoAnalysisReloadForecast === "function") {
 window.__aoAnalysisReloadForecast();
 }
 }).catch(function (e) {
 setStat((e && e.message) || "Couldn't save.", "err");
 apply.disabled = false;
 });
 });
 }

 function emptyHTML(ctx) {
 var esc = ctx.esc;
 return '<div class="anfc-empty">' +
 '<div class="anfc-empty-ic">' +
 '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>' +
 '</div><div class="anfc-empty-tx">' +
 "<b>Waiting on weather-modeled data</b>" +
 "<span>" + (ctx.simulated
 ? "Sign in with real arrays (and a service address) to compare measured production to the sunlight on each site."
 : "Once a few days of production land and arrays have locations, we compare measured output to weather-expected output.") +
 "</span></div></div>";
 }

 function render(container, ctx) {
 injectCss();
 var esc = ctx.esc;
 var f = ctx.forecast;
 var body;

 if (!f || !f.available || num(f.ratio_pct) == null) {
 // Still show the model editor when we have skipped no_location arrays —
 // that's exactly when the operator needs to fill addresses.
 var arraysEmpty = f ? modelableArrays(f) : [];
 if (arraysEmpty.length && ctx.signedIn !== false) {
 body =
 '<div class="anfc-kicker"><i></i>Weather-adjusted</div>' +
 '<h2 class="anfc-title">Production vs expected</h2>' +
 '<p class="anfc-lede">Add each site’s address and angles below so we can compare measured production to the real sunlight on the roof.</p>' +
 modelHTML(f || { rows: [], skipped: arraysEmpty }, ctx);
 } else {
 body = emptyHTML(ctx);
 }
 } else {
 var pct = num(f.ratio_pct);
 var fill = Math.max(0, Math.min(pct, 120));
 var tone = pct < 82 ? "warn" : (pct >= 92 ? "ok" : "soft");
 var verdict = pct < 82
 ? ((100 - pct) + "% under what the sunlight should yield")
 : (pct >= 100 ? "at or above what the weather should yield" : "tracking near weather-expected output");
 var spot = f.sunny_spotlight;
 var spotLine = (spot && num(spot.ratio_pct) != null)
 ? '<div class="anfc-spot">☀ Clearest day (' + esc(spot.day) + ", " + spot.poa_kwh_m2 + " kWh/m²): <b>" +
 esc(spot.array_name) + "</b> made <b>" + Math.round(spot.actual_kwh).toLocaleString() +
 " kWh</b> vs " + Math.round(spot.expected_kwh).toLocaleString() + ' expected, <b class="' +
 (spot.ratio_pct >= 92 ? "good" : spot.ratio_pct < 82 ? "bad" : "") + '">' + spot.ratio_pct + "%</b></div>"
 : "";
 var conf = CONF_LABEL[f.confidence] || f.confidence || "";
 var modeled = num(f.arrays_modeled);
 var win = windowDays(f, ctx);
 var ratioBased = num(f.arrays_ratio_based);

 var chips = '<div class="anfc-meta">' +
 '<span class="anfc-chip"><b>' + win + "d</b> window</span>" +
 (modeled != null ? '<span class="anfc-chip"><b>' + modeled + "</b> sites modeled</span>" : "") +
 (conf ? '<span class="anfc-chip">' + esc(conf) + "</span>" : "") +
 (ratioBased > 0 ? '<span class="anfc-chip"><b>' + ratioBased + "</b> on your kWh/kW target</span>" : "") +
 "</div>";

 body =
 '<div class="anfc-kicker"><i></i>Weather-adjusted</div>' +
 '<h2 class="anfc-title">Production vs expected</h2>' +
 '<p class="anfc-lede">What your fleet made against the <b>real sunlight</b> that fell on each site, not a seasonal average.</p>' +
 '<div class="anfc-verdict-row">' +
 ' <div><div class="anfc-pct">' + pct + '<span>%</span><span class="anfc-pct-lab">of weather-expected</span></div></div>' +
 ' <div class="anfc-nums"><b>' + Math.round(f.actual_kwh).toLocaleString() + " kWh</b> made" +
 ' <span class="anfc-num-sub">' + Math.round(f.expected_kwh).toLocaleString() + " kWh expected</span></div>" +
 "</div>" +
 '<div class="anfc-track" role="img" aria-label="Fleet made ' + pct + '% of weather-expected">' +
 ' <div class="anfc-fill ' + tone + '" style="width:' + (fill / 1.2).toFixed(1) + '%"></div>' +
 ' <span class="anfc-mark" style="left:' + (100 / 1.2).toFixed(1) + '%" title="100% = weather-expected"></span>' +
 "</div>" +
 '<p class="anfc-verdict ' + tone + '">' + (pct < 82 ? "⚠ " : "") + esc(verdict) + "</p>" +
 spotLine +
 chips +
 modelHTML(f, ctx) +
 '<div class="anfc-details">' +
 '<button type="button" class="anfc-toggle" data-anfc-toggle aria-expanded="' + _howOpen + '">' +
 (_howOpen ? "Hide how the number is built" : "How the number is built") + "</button>" +
 (_howOpen ? detailsHTML(f, ctx) : "") +
 "</div>";
 }

 container.innerHTML =
 '<div class="an-card anfc-lead">' +
 ' <div class="anfc-hero">' + body + "</div>" +
 "</div>";

 var t = container.querySelector("[data-anfc-toggle]");
 if (t) t.addEventListener("click", function () { _howOpen = !_howOpen; render(container, ctx); });
 wireModel(container, f || { rows: [], skipped: [] }, ctx);
 }

 // First on the Analysis tab, the fleet weather verdict + model controls.
 window.AnalysisSections.push({ id: "forecast", title: "Production vs expected", order: 1, render: render });
})();
