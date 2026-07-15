/* ============================================================================
 * Array Operator, Analysis tab · Fleet health, kWh/kW (analysis-health.js)
 *
 * THE FIRST section of the Analysis tab (Bruce, anchor customer, 2026-07-03):
 * "Present 14-day (or 10 day) kWh/kW ratio first. This is the best indicator
 * to big picture health. Then put if there is a flag on a subset, should be
 * a correlation to kWh/kW ratio. Then do the actual vs expected."
 *
 * So this card leads with the fleet's measured SPECIFIC YIELD, kWh produced
 * per installed kW, and ranks every array by it, worst first, with each
 * array's existing problem flags (dead / lagging / quiet inverters, and
 * under-expected) inline on the same row, so the flag↔ratio correlation is
 * visible at a glance. The weather-adjusted actual-vs-expected card follows
 * as the second layer (analysis-forecast.js, order 8).
 *
 * UNITS (labeled everywhere, matching the API): kwh_per_kw_day = kWh per kW
 * per DAY averaged over the days we actually measured; the window figure is
 * the measured total ÷ nameplate over the window's measured days. Arrays with
 * no nameplate are excluded (never faked); arrays with no measured days are
 * listed not ranked as zero.
 *
 * Per-array "target": the operator can enter an EXPECTED kWh/kW per day
 * (Bruce: the operator knows a site's derates, 2014-era panels, orientation,
 * wire runs, better than a generic weather model). Saving it flips that
 * array's "expected" basis to the ratio via POST /expected-ratio and works
 * even for arrays with no location on file. This row IS the per-array tuning
 * surface, the same place a tilt/azimuth override would live.
 *
 * Honesty contract: everything here is measured or operator-entered, no
 * fabricated numbers, no extrapolation across unmeasured days.
 * ========================================================================== */
(function () {
 "use strict";

 window.AnalysisSections = window.AnalysisSections || [];

 // module-level editor state so live re-renders don't stomp an open editor
 var _edit = null; // { id, val } | null
 var _busy = false;
 var _err = "";
 var _showAll = false; // big fleets: worst-N first, expand on demand
 var SHOW_COLLAPSED = 15; // rows shown before the "Show all" expander

 function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }
 function windowDays(fc, ctx) {
 return (fc && fc.window && fc.window.days) || (ctx && ctx.windowDays) || 10;
 }

 // ---- one-time scoped CSS ----------------------------------------------------
 function injectCss() {
 if (document.getElementById("anhk-css")) return;
 var s = document.createElement("style");
 s.id = "anhk-css";
 s.textContent = [
 ".anhk-body{padding:18px 18px 20px;}",

 /* headline: the fleet specific-yield number */
 ".anhk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;}",
 ".anhk-big{min-width:0;}",
 ".anhk-num{font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;}",
 ".anhk-num .anhk-unit{font-size:17px;font-weight:700;color:var(--muted);margin-left:7px;letter-spacing:0;}",
 ".anhk-alt{font-size:14px;font-weight:640;color:var(--good2);margin-top:7px;font-variant-numeric:tabular-nums;}",
 ".anhk-cap{font-size:12.5px;color:var(--muted);margin-top:9px;max-width:60ch;line-height:1.5;}",
 ".anhk-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px;}",
 ".anhk-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:640;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--bg2);}",
 ".anhk-chip b{font-weight:720;color:var(--ink);}",
 ".anhk-chip.warn{color:var(--warn);border-color:rgba(217,119,6,.30);background:rgba(217,119,6,.08);}",
 ".anhk-chip.bad{color:var(--bad);border-color:rgba(220,38,38,.28);background:rgba(220,38,38,.07);}",

 /* the ranked list */
 ".anhk-list{margin-top:20px;border-top:1px solid var(--line);padding-top:6px;}",
 ".anhk-list-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:10px 2px 8px;}",
 ".anhk-list-h .lab{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);}",
 ".anhk-list-h .hint{font-size:11.5px;color:var(--faint);}",
 ".anhk-row{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(90px,1fr) 86px 108px;align-items:center;gap:12px;padding:8px 2px;border-top:1px solid var(--line);}",
 ".anhk-row:first-child{border-top:0;}",
 ".anhk-namecell{min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
 ".anhk-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:620;color:var(--ink);}",
 ".anhk-meta{font-size:11px;color:var(--faint);font-weight:500;white-space:nowrap;}",
 /* inline problem flags, the flag↔ratio correlation Bruce asked for */
 ".anhk-flag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;white-space:nowrap;flex:0 0 auto;}",
 ".anhk-flag .dot{width:6px;height:6px;border-radius:50%;background:currentColor;}",
 ".anhk-flag.bad{color:var(--bad);background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.24);}",
 ".anhk-flag.warn{color:var(--warn);background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.26);}",
 ".anhk-flag.exp{color:var(--muted);background:var(--bg2);border:1px solid var(--line);}",
 ".anhk-flag.exp.bad{color:var(--bad);}", ".anhk-flag.exp.warn{color:var(--warn);}", ".anhk-flag.exp.good{color:var(--good);background:rgba(37,99,235,.07);border-color:rgba(37,99,235,.24);}",

 /* bar: scaled to the fleet's best array; tick = the operator's target */
 ".anhk-bar{height:9px;border-radius:6px;background:var(--bg2);overflow:visible;position:relative;}",
 ".anhk-bar > b{display:block;height:100%;border-radius:6px;background:var(--good);transition:width .4s ease;}",
 ".anhk-bar.lo > b{background:var(--bad);}",
 ".anhk-bar.mid > b{background:var(--warn);}",
 ".anhk-tick{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:2px;background:var(--ink);opacity:.45;}",

 ".anhk-val{text-align:right;font-size:13px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap;}",
 ".anhk-val i{font-style:normal;font-size:10.5px;font-weight:600;color:var(--faint);margin-left:2px;}",

 /* per-row target affordance (the expected kWh/kW input) */
 ".anhk-tcell{display:flex;justify-content:flex-end;align-items:center;gap:5px;min-width:0;}",
 ".anhk-target{appearance:none;background:var(--bg2);border:1px solid var(--line);color:var(--muted);border-radius:7px;font:inherit;font-size:11px;font-weight:680;line-height:1.4;padding:2px 8px;cursor:pointer;white-space:nowrap;transition:border-color .12s,color .12s;}",
 ".anhk-target:hover{color:var(--ink);border-color:var(--good);}",
 ".anhk-target.add{background:transparent;border-style:dashed;color:var(--faint);}",
 ".anhk-target.add:hover{color:var(--good);border-color:var(--good);}",
 ".anhk-tin{width:58px;appearance:none;background:var(--card);border:1px solid var(--good);border-radius:7px;color:var(--ink);font:inherit;font-size:12px;font-weight:640;padding:2px 6px;outline:none;font-variant-numeric:tabular-nums;}",
 ".anhk-tbtn{appearance:none;border:1px solid var(--line);background:var(--card);border-radius:7px;color:var(--muted);font:inherit;font-size:11px;font-weight:700;line-height:1.4;padding:2px 7px;cursor:pointer;}",
 ".anhk-tbtn.save{color:#fff;background:var(--good);border-color:var(--good);}",
 ".anhk-tbtn:disabled{opacity:.55;cursor:default;}",
 ".anhk-terr{grid-column:1 / -1;font-size:11.5px;color:var(--bad);padding:0 2px 6px;}",

 /* muted rows: measured-but-unranked / excluded arrays */
 ".anhk-muted-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;border-top:1px solid var(--line);font-size:12px;color:var(--faint);}",
 ".anhk-muted-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
 ".anhk-more{display:block;width:100%;margin-top:8px;appearance:none;background:var(--bg2);border:1px dashed var(--line);border-radius:9px;color:var(--muted);font:inherit;font-size:12px;font-weight:680;padding:7px 12px;cursor:pointer;transition:color .12s,border-color .12s;}",
 ".anhk-more:hover{color:var(--good);border-color:var(--good);}",

 ".anhk-foot{font-size:11.5px;color:var(--faint);margin-top:12px;line-height:1.5;max-width:80ch;}",
 ".anhk-foot b{color:var(--muted);}",

 /* honest empty state */
 ".anhk-empty{display:flex;gap:13px;align-items:flex-start;padding:4px 0;}",
 ".anhk-empty-ic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--bg2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--faint);}",
 ".anhk-empty-tx b{display:block;font-size:14px;font-weight:700;color:var(--ink);margin-bottom:3px;}",
 ".anhk-empty-tx span{font-size:12.5px;color:var(--muted);line-height:1.5;}",

 "@media (max-width:680px){",
 ".anhk-row{grid-template-columns:minmax(0,1fr) 74px 96px;}",
 ".anhk-row .anhk-bar{display:none;}",
 ".anhk-num{font-size:38px;}",
 "}"
 ].join("");
 document.head.appendChild(s);
 }

 // ---- assemble the ranking entries from the forecast payload ------------------
 // Includes BOTH weather-modeled rows and skipped-but-measured arrays (the
 // backend attaches kWh/kW to no_location skips, the ratio needs no weather).
 function collectEntries(ctx) {
 var f = ctx.forecast;
 var out = [];
 if (!f) return out;
 (f.rows || []).forEach(function (r) {
 var np = num(r.nameplate_kw), days = num(r.measured_days) || 0, act = num(r.actual_kwh);
 var kkDay = num(r.kwh_per_kw_day);
 if (kkDay == null && np > 0 && days > 0 && act != null) kkDay = act / np / days; // older payload/demo fallback
 var kkWin = num(r.kwh_per_kw_window);
 if (kkWin == null && np > 0 && days > 0 && act != null) kkWin = act / np;
 out.push({
 id: r.array_id, name: r.array_name, nameplate: np, days: days,
 kkDay: kkDay, kkWin: kkWin, ratioPct: num(r.ratio_pct),
 basis: r.expected_basis || "weather_model",
 target: num(r.expected_kwh_per_kw_day), modeled: true
 });
 });
 (f.skipped || []).forEach(function (s) {
 var kkDay = num(s.kwh_per_kw_day);
 out.push({
 id: s.array_id, name: s.array_name, nameplate: num(s.nameplate_kw),
 days: num(s.measured_days) || 0, kkDay: kkDay, kkWin: num(s.kwh_per_kw_window),
 ratioPct: null, basis: null, target: null, modeled: false, skippedReason: s.reason
 });
 });
 return out;
 }

 // per-array problem flags from the canonical fleet (same alert rollup the rest
 // of the app uses), rendered inline on the ranking rows.
 var FLAG_LABEL = { dead: "down", underperforming: "lagging", comm_gap: "quiet" };
 function flagChips(ctx, e, esc) {
 var html = "";
 var col = ctx._anhkCols && ctx._anhkCols[String(e.id)];
 if (col && col.alert && col.alert.level && col.alert.level !== "ok") {
 var al = col.alert;
 var cls = al.level === "critical" ? "bad" : "warn";
 var lab = FLAG_LABEL[al.status] || "flagged";
 var n = num(al.count) || 1;
 html += '<span class="anhk-flag ' + cls + '" title="' + esc(al.headline || "") + '"><span class="dot"></span>' + n + " " + esc(lab) + "</span>";
 }
 // under-expected chip: always shown for operator targets, only when notably
 // low for the weather model (keeps healthy rows calm).
 if (e.ratioPct != null) {
 var isTarget = e.basis === "operator_ratio";
 if (isTarget || e.ratioPct < 82) {
 var tone = e.ratioPct < 70 ? "bad" : (e.ratioPct < 92 ? "warn" : "good");
 html += '<span class="anhk-flag exp ' + tone + '" title="Measured vs ' + (isTarget ? "your target" : "weather-expected") + ' over the window">' +
 e.ratioPct + "% of " + (isTarget ? "target" : "expected") + "</span>";
 }
 }
 return html;
 }

 // ---- the per-row target cell (view / editor) ---------------------------------
 function targetCell(e, canEdit, esc) {
 if (_edit && _edit.id === e.id) {
 return '<span class="anhk-tcell" data-anhk-stop>' +
 '<input class="anhk-tin" data-anhk-in type="number" min="0.1" max="12" step="0.1" value="' + esc(_edit.val) + '" aria-label="Expected kWh per kW per day" />' +
 '<button type="button" class="anhk-tbtn save" data-anhk-save' + (_busy ? " disabled" : "") + '>' + (_busy ? "…" : "Save") + '</button>' +
 (e.target != null ? '<button type="button" class="anhk-tbtn" data-anhk-clear' + (_busy ? " disabled" : "") + ' title="Back to the weather model">Clear</button>' : "") +
 '<button type="button" class="anhk-tbtn" data-anhk-cancel>✕</button>' +
 '</span>';
 }
 if (e.target != null) {
 return '<span class="anhk-tcell"><button type="button" class="anhk-target" data-anhk-edit="' + e.id + '" ' +
 'title="Your expected kWh per kW per day, “expected” for this array uses this instead of the weather model. Click to change or clear.">target ' + e.target + '<i>/day</i></button></span>';
 }
 if (!canEdit) return '<span class="anhk-tcell"></span>';
 return '<span class="anhk-tcell"><button type="button" class="anhk-target add" data-anhk-edit="' + e.id + '" ' +
 'title="Set the kWh/kW per day YOU expect from this site (its panels, angle, wiring), “expected” then uses your number instead of the weather model' + (e.modeled ? "" : ", and works without a location on file") + '.">＋ target</button></span>';
 }

 function emptyHTML(ctx) {
 return '<div class="anhk-empty">' +
 '<div class="anhk-empty-ic">' +
 '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18M7 14l4-4 3 3 5-6"/></svg>' +
 '</div><div class="anhk-empty-tx">' +
 '<b>kWh/kW appears once production is measured</b>' +
 '<span>Specific yield, kWh produced per installed kW, is computed from your inverters’ measured daily energy over the window. It will populate as days of data load; nothing here is ever estimated.</span>' +
 '</div></div>';
 }

 // ---- render (idempotent) ------------------------------------------------------
 function render(container, ctx) {
 injectCss();
 var esc = ctx.esc;
 var f = ctx.forecast;
 var win = windowDays(f, ctx);

 // column map for flags (built once per render, stashed on ctx for flagChips)
 var colMap = {};
 (ctx.columns || []).forEach(function (c) { colMap[String(c.array_id)] = c; });
 ctx._anhkCols = colMap;

 var entries = collectEntries(ctx);
 var ranked = entries.filter(function (e) { return e.kkDay != null; })
 .sort(function (a, b) { return a.kkDay - b.kkDay; }); // worst first
 var noData = entries.filter(function (e) { return e.kkDay == null && e.skippedReason !== "no_nameplate"; });
 var noNameplate = entries.filter(function (e) { return e.skippedReason === "no_nameplate"; });

 var canEdit = !!(ctx.signedIn && !ctx.simulated && ctx.setExpectedRatio);

 // fleet headline: nameplate-weighted per-day specific yield (API-labeled
 // units; client fallback recomputes the identical figure for the demo).
 var fleetDay = null;
 if (f) {
 fleetDay = num((f.kwh_per_kw || {}).fleet_per_day);
 if (fleetDay == null) {
 var act = 0, npd = 0;
 ranked.forEach(function (e) { if (e.nameplate > 0 && e.days > 0) { act += e.kkDay * e.nameplate * e.days; npd += e.nameplate * e.days; } });
 fleetDay = npd > 0 ? act / npd : null;
 }
 }

 var body;
 if (!f || !ranked.length || fleetDay == null) {
 body = emptyHTML(ctx);
 } else {
 var kk = (f.kwh_per_kw || {});
 var fleetWin = fleetDay != null ? fleetDay * win : null;
 var countedNp = num(kk.nameplate_kw);
 var flaggedCount = ranked.filter(function (e) {
 var c = colMap[String(e.id)]; return c && c.alert && c.alert.level && c.alert.level !== "ok";
 }).length;

 var maxDay = ranked.reduce(function (m, e) { return Math.max(m, e.kkDay, e.target || 0); }, 0) || 1;

 // Big fleets collapse to the worst N (the actionable end) with an honest
 // expander; small fleets always show everything, muted rows included.
 var collapsed = !_showAll && ranked.length > SHOW_COLLAPSED + 3;
 var visible = collapsed ? ranked.slice(0, SHOW_COLLAPSED) : ranked;

 var rowsHtml = "";
 visible.forEach(function (e) {
 var w = Math.max(2, Math.min(100, e.kkDay / maxDay * 100));
 var barCls = fleetDay != null
 ? (e.kkDay < fleetDay * 0.7 ? "lo" : (e.kkDay < fleetDay * 0.9 ? "mid" : ""))
 : "";
 var tick = (e.target != null)
 ? '<span class="anhk-tick" style="left:' + Math.min(100, e.target / maxDay * 100).toFixed(1) + '%" title="Your target: ' + e.target + ' kWh/kW per day"></span>'
 : "";
 var meta = "";
 if (e.days > 0 && e.days < win) meta = e.days + " of " + win + "d measured";
 else if (!e.modeled) meta = "no location, not weather-modeled";
 rowsHtml += '<div class="anhk-row">' +
 '<div class="anhk-namecell"><span class="anhk-name">' + esc(e.name || ("Array " + e.id)) + '</span>' +
 flagChips(ctx, e, esc) +
 (meta ? '<span class="anhk-meta">' + esc(meta) + '</span>' : "") +
 '</div>' +
 '<div class="anhk-bar ' + barCls + '"><b style="width:' + w.toFixed(1) + '%"></b>' + tick + '</div>' +
 '<div class="anhk-val" title="' + (e.kkWin != null ? (e.kkWin + " kWh/kW over the measured days of this window") : "") + '">' + e.kkDay.toFixed(2) + '<i>/day</i></div>' +
 targetCell(e, canEdit, esc) +
 (_err && _edit && _edit.id === e.id ? '<div class="anhk-terr">' + esc(_err) + '</div>' : "") +
 '</div>';
 });

 if (collapsed) {
 var hiddenN = (ranked.length - visible.length) + noData.length + noNameplate.length;
 rowsHtml += '<button type="button" class="anhk-more" data-anhk-more>Show all ' + ranked.length + ' arrays' +
 ((noData.length || noNameplate.length) ? ' + ' + (noData.length + noNameplate.length) + ' without a ratio' : '') +
 ' (' + hiddenN + ' more)</button>';
 } else {
 noData.forEach(function (e) {
 rowsHtml += '<div class="anhk-muted-row"><span class="nm">' + esc(e.name || ("Array " + e.id)) + '</span><span>no measured days this window</span></div>';
 });
 noNameplate.forEach(function (e) {
 rowsHtml += '<div class="anhk-muted-row"><span class="nm">' + esc(e.name || ("Array " + e.id)) + '</span><span>no nameplate, excluded from kWh/kW</span></div>';
 });
 if (_showAll && ranked.length > SHOW_COLLAPSED + 3) {
 rowsHtml += '<button type="button" class="anhk-more" data-anhk-more>Show the worst ' + SHOW_COLLAPSED + ' only</button>';
 }
 }

 body =
 '<div class="anhk-head"><div class="anhk-big">' +
 '<div class="anhk-num">' + fleetDay.toFixed(2) + '<span class="anhk-unit">kWh/kW · day</span></div>' +
 (fleetWin != null ? '<div class="anhk-alt">≈ ' + fleetWin.toFixed(1) + ' kWh per kW over the last ' + win + ' days</div>' : "") +
 '<div class="anhk-cap">Specific yield: measured production ÷ installed kW, nameplate-weighted across the fleet, <b>measured days only, never extrapolated</b>. The single best big-picture health number' + (ctx.simulated ? " (demo fleet)" : "") + '.</div>' +
 '<div class="anhk-chips">' +
 '<span class="anhk-chip"><b>' + ranked.length + '</b> array' + (ranked.length === 1 ? "" : "s") + ' ranked</span>' +
 (countedNp ? '<span class="anhk-chip"><b>' + Math.round(countedNp).toLocaleString() + '</b> kW counted</span>' : "") +
 '<span class="anhk-chip">last ' + win + ' days</span>' +
 (flaggedCount ? '<span class="anhk-chip warn"><b>' + flaggedCount + '</b> flagged site' + (flaggedCount === 1 ? "" : "s") + ', check the low end</span>' : "") +
 '</div></div></div>' +
 '<div class="anhk-list">' +
 '<div class="anhk-list-h"><span class="lab">Per array · lowest yield first</span><span class="hint">kWh per kW per day · flags inline</span></div>' +
 rowsHtml + '</div>' +
 '<div class="anhk-foot">Bars are scaled to the fleet’s best array; the tick ▏marks a site’s <b>target</b>, the kWh/kW per day you expect from it (its panel vintage, angle, wiring). Set one and “Production vs expected” below uses <b>your number</b> for that array instead of the weather model. Flags are the same dead / lagging / quiet verdicts as Fleet Health, low bars and flags landing together is the pattern to act on.</div>';
 }

 container.innerHTML =
 '<div class="an-card">' +
 ' <div class="an-card-head">' +
 ' <div><h3>Fleet health · kWh/kW</h3>' +
 ' <div class="an-card-sub">' + (ctx.simulated ? 'Demo fleet, ' : '') + 'Measured specific yield per array, last ' + win + ' days, worst first, problem flags inline</div></div>' +
 ' </div>' +
 ' <div class="anhk-body">' + body + '</div>' +
 '</div>';

 // ---- wire the target editor ------------------------------------------------
 function rerender() { render(container, ctx); }

 Array.prototype.forEach.call(container.querySelectorAll("[data-anhk-edit]"), function (btn) {
 btn.addEventListener("click", function () {
 if (!canEdit) return;
 var id = btn.getAttribute("data-anhk-edit");
 var e = null;
 entries.forEach(function (x) { if (String(x.id) === String(id)) e = x; });
 _edit = { id: e ? e.id : id, val: (e && e.target != null) ? String(e.target) : "" };
 _err = ""; _busy = false;
 rerender();
 var inp = container.querySelector("[data-anhk-in]");
 if (inp) { inp.focus(); inp.select(); }
 });
 });

 var inp = container.querySelector("[data-anhk-in]");
 if (inp) {
 inp.addEventListener("input", function () { if (_edit) _edit.val = inp.value; });
 inp.addEventListener("keydown", function (ev) {
 if (ev.key === "Enter") { ev.preventDefault(); save(); }
 if (ev.key === "Escape") { _edit = null; _err = ""; rerender(); }
 });
 }
 function save() {
 if (!_edit || _busy) return;
 var v = parseFloat(_edit.val);
 if (!isFinite(v) || v <= 0 || v > 12) { _err = "Enter a kWh/kW per day between 0 and 12 (most sites run 2–5)."; rerender(); return; }
 _busy = true; _err = ""; rerender();
 ctx.setExpectedRatio(_edit.id, v).then(function () {
 _edit = null; _busy = false; // forecast reload will repaint with the new basis
 }).catch(function (err) {
 _busy = false; _err = (err && err.message) || "Couldn't save the target."; rerender();
 });
 }
 function clearTarget() {
 if (!_edit || _busy) return;
 _busy = true; _err = ""; rerender();
 ctx.setExpectedRatio(_edit.id, null).then(function () {
 _edit = null; _busy = false;
 }).catch(function (err) {
 _busy = false; _err = (err && err.message) || "Couldn't clear the target."; rerender();
 });
 }
 var saveBtn = container.querySelector("[data-anhk-save]");
 if (saveBtn) saveBtn.addEventListener("click", save);
 var clearBtn = container.querySelector("[data-anhk-clear]");
 if (clearBtn) clearBtn.addEventListener("click", clearTarget);
 var cancelBtn = container.querySelector("[data-anhk-cancel]");
 if (cancelBtn) cancelBtn.addEventListener("click", function () { _edit = null; _err = ""; rerender(); });
 var moreBtn = container.querySelector("[data-anhk-more]");
 if (moreBtn) moreBtn.addEventListener("click", function () { _showAll = !_showAll; rerender(); });
 }

 // order 5: Bruce's ask, the kWh/kW health ranking LEADS the Analysis tab,
 // ahead of actual-vs-expected (forecast, order 8) and the Portfolio strip (10).
 window.AnalysisSections.push({ id: "health-kwhkw", title: "Fleet health · kWh/kW", order: 5, render: render });
})();
