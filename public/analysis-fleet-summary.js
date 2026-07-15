/* ============================================================================
 * Array Operator, Analysis tab · Portfolio rollup KPI strip
 * (analysis-fleet-summary.js) [SECTION MODULE, id:"fleet-summary"]
 *
 * The top-of-page fleet header: PowerTrack's portfolio header + footer totals
 * condensed into one clean KPI row. Reads ONLY ctx (built by analysis.js), it
 * fetches nothing and mutates nothing. Idempotent: rebuilds container.innerHTML
 * on every call (first show + every live FleetStore/forecast update).
 *
 * Honesty (Ford's hard rule): weather/performance KPIs read "—" when
 * ctx.forecast is null (demo/anon or before it loads), NEVER fabricated. The
 * measured KPIs (sites, inverters, capacity, producing now, production, alarms)
 * are always fully populated from the canonical fleet, demo or live.
 * ========================================================================== */
(function () {
 "use strict";

 // ---- scoped CSS, injected once ----------------------------------------------
 function ensureCss() {
 if (document.getElementById("ansum-css")) return;
 var s = document.createElement("style");
 s.id = "ansum-css";
 s.textContent = [
 // The strip always holds exactly 7 KPI tiles (the money/impact figure is a
 // separate banner below). auto-fit would orphan a lone 7th tile at some
 // widths (e.g. 6-up → 6+1), so we pick explicit column counts that divide 7
 // WITHOUT leaving a single card alone on the last row: 7 (one row), 4 (4+3),
 // or 2 (mobile). We deliberately avoid 6-up and 3-up (both leave a 1-orphan).
 ".ansum-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}",
 // wide screens: all seven on one dense row
 "@media (min-width:1360px){.ansum-grid{grid-template-columns:repeat(7,1fr);}}",
 ".ansum-card{position:relative;background:linear-gradient(168deg,var(--card),var(--card2));",
 " border:1px solid var(--line);border-radius:16px;padding:14px 16px 13px;min-width:0;overflow:hidden;}",
 // a hairline accent rail on the left edge, tinted by health
 ".ansum-card::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;",
 " background:var(--good2);opacity:.55;}",
 ".ansum-card.warn::before{background:var(--warn);opacity:.85;}",
 ".ansum-card.bad::before{background:var(--bad);opacity:.9;}",
 ".ansum-card.muted::before{background:var(--faint);opacity:.4;}",
 ".ansum-lbl{font-size:10.5px;font-weight:680;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);}",
 ".ansum-val{font-size:25px;font-weight:760;line-height:1.05;letter-spacing:-.015em;color:var(--ink);",
 " margin-top:6px;font-variant-numeric:tabular-nums;white-space:nowrap;}",
 ".ansum-val .ansum-unit{font-size:14px;font-weight:640;color:var(--muted);margin-left:2px;letter-spacing:0;}",
 ".ansum-val.good{color:var(--good);}",
 ".ansum-val.warn{color:var(--warn);}",
 ".ansum-val.bad{color:var(--bad);}",
 ".ansum-val.muted{color:var(--faint);}",
 ".ansum-sub{font-size:11.5px;color:var(--muted);margin-top:5px;font-variant-numeric:tabular-nums;",
 " white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
 ".ansum-sub.warn{color:var(--warn);}",
 ".ansum-sub.bad{color:var(--bad);}",
 // full-width "Energy at risk" impact banner (a money figure, not a KPI tile)
 ".ansum-banner{margin-top:12px;display:flex;align-items:center;justify-content:space-between;",
 " gap:18px;flex-wrap:wrap;padding:13px 18px;border-radius:14px;",
 " background:linear-gradient(168deg,var(--card),var(--card2));border:1px solid var(--line);",
 " position:relative;overflow:hidden;}",
 // health rail on the left edge, matching the tile accent language
 ".ansum-banner::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;",
 " border-radius:3px;background:var(--warn);opacity:.85;}",
 ".ansum-banner.good::before{background:var(--good2);opacity:.55;}",
 ".ansum-banner-main{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;min-width:0;}",
 ".ansum-banner-lbl{font-size:10.5px;font-weight:680;letter-spacing:.07em;text-transform:uppercase;",
 " color:var(--faint);white-space:nowrap;}",
 ".ansum-banner-win{color:var(--faint);font-weight:600;letter-spacing:.04em;}",
 ".ansum-banner-val{font-size:23px;font-weight:760;line-height:1.05;letter-spacing:-.015em;",
 " color:var(--warn);font-variant-numeric:tabular-nums;white-space:nowrap;display:inline-flex;",
 " align-items:baseline;gap:11px;}",
 ".ansum-banner.good .ansum-banner-val{color:var(--good);}",
 ".ansum-banner-money{font-size:14px;font-weight:680;color:var(--muted);letter-spacing:0;}",
 ".ansum-banner-lede{font-size:12px;color:var(--muted);line-height:1.45;max-width:46ch;",
 " text-align:right;margin-left:auto;}",
 // spotlight caption below the strip
 ".ansum-spot{margin-top:12px;display:flex;align-items:flex-start;gap:8px;padding:11px 14px;",
 " background:var(--bg2);border:1px solid var(--line);border-radius:12px;",
 " font-size:12.5px;color:var(--muted);line-height:1.5;}",
 ".ansum-spot-ic{color:var(--warn);font-size:14px;line-height:1.25;flex:0 0 auto;}",
 ".ansum-spot b{color:var(--ink);font-weight:680;}",
 ".ansum-spot b.good{color:var(--good);}",
 ".ansum-spot b.bad{color:var(--bad);}",
 "@media (max-width:760px){",
 " .ansum-grid{grid-template-columns:repeat(2,1fr);gap:10px;}",
 // 7 tiles in a 2-col grid leaves the 7th alone with a void beside it, let it
 // span the full width so the odd tile reads as intentional, not orphaned.
 " .ansum-grid > .ansum-card:last-child{grid-column:1 / -1;}",
 " .ansum-card{padding:12px 13px 11px;}",
 " .ansum-val{font-size:22px;}",
 " .ansum-banner{align-items:flex-start;flex-direction:column;gap:8px;}",
 " .ansum-banner-lede{text-align:left;margin-left:0;}",
 " .ansum-banner-val{font-size:21px;}",
 "}"
 ].join("\n");
 document.head.appendChild(s);
 }

 var CONF_LABEL = { high: "high confidence", medium: "moderate confidence", low: "lower confidence" };

 function _num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

 // split a fmt string like "1.24 MW" / "350 kW" into {v, unit} so the unit
 // renders smaller, keeps the big number tabular and clean.
 function splitUnit(str) {
 var m = String(str).match(/^([^\sA-Za-z]*[\d.,\-]+)\s*(.*)$/);
 if (!m) return { v: str, unit: "" };
 return { v: m[1], unit: m[2] };
 }

 // one KPI card. value can carry a unit (split smaller); tone tints val + rail.
 function card(label, valStr, sub, opts) {
 opts = opts || {};
 var tone = opts.tone || ""; // "" | good | warn | bad | muted
 var splitU = opts.splitUnit !== false; // default: peel the unit off
 var parts = splitU ? splitUnit(valStr) : { v: valStr, unit: "" };
 var unitHtml = parts.unit ? '<span class="ansum-unit">' + esc(parts.unit) + "</span>" : "";
 var subHtml = sub ? '<div class="ansum-sub' + (opts.subTone ? " " + opts.subTone : "") + '">' + sub + "</div>" : "";
 var railCls = (tone === "warn" || tone === "bad" || tone === "muted") ? " " + tone : "";
 var titleAttr = opts.title ? ' title="' + esc(opts.title) + '" tabindex="0"' : "";
 return '<div class="ansum-card' + railCls + '"' + titleAttr + '>' +
 '<div class="ansum-lbl">' + esc(label) + "</div>" +
 '<div class="ansum-val' + (tone ? " " + tone : "") + '">' + esc(parts.v) + unitHtml + "</div>" +
 subHtml + "</div>";
 }

 function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
 return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
 });
 }

 // ---- the render -------------------------------------------------------------
 function render(container, ctx) {
 ensureCss();
 var fmt = ctx.fmt;
 var arrays = ctx.arrays || [];
 var cols = ctx.columns || [];
 var f = ctx.forecast; // null = demo/anon or not-yet-loaded
 var win = ctx.windowDays || 14;

 // --- measured aggregates (always available, demo or live) ----------------
 var sites = arrays.length;
 var invTotal = (ctx.summary && _num(ctx.summary.inverters_total)) || 0;

 // fleet capacity = sum of every inverter nameplate across the canonical fleet
 var capKw = 0;
 arrays.forEach(function (a) {
 (a.inverters || []).forEach(function (iv) {
 var np = _num(iv.nameplate_kw); if (np != null) capKw += np;
 });
 });

 // producing now = sum of live inverter wattage across columns (live liveness).
 // A stale column's current_power_w is a FROZEN reading, not live output, gate
 // on the spreadsheet's canonical VendorSheet.isStale so a paused feed never
 // inflates this KPI (mirrors the Dashboard "kW now" strip in command-center.js,
 // including its asleep-vs-paused split: a feed frozen because the sun is down
 // is excluded from the sum but not alarmed as "paused").
 function _colStale(c) {
 return !!(window.VendorSheet && VendorSheet.isStale && VendorSheet.isStale(c));
 }
 var prodW = 0, sawLive = false, staleW = 0, staleN = 0, pausedN = 0;
 cols.forEach(function (c) {
 var w = null;
 (c.inverters || []).forEach(function (iv) {
 var x = _num(iv.current_power_w);
 if (x != null) w = (w || 0) + x;
 });
 if (w == null) return;
 if (_colStale(c)) {
 staleW += w; staleN++;
 if (c.is_daylight !== false) pausedN++;
 return;
 }
 prodW += w; sawLive = true;
 });
 var allStale = !sawLive && staleN > 0; // every feed frozen → last-known, not live
 var prodKw = sawLive ? fmt.kwFromW(prodW) : (allStale ? fmt.kwFromW(staleW) : null);
 var prodPctOfCap = (sawLive && capKw > 0) ? (prodKw / capKw) * 100 : null;

 // production over the window: forecast actual_kwh when present, else sum of
 // measured per-inverter window_kwh from the canonical fleet.
 var prodKwh = null;
 if (f && _num(f.actual_kwh) != null) {
 prodKwh = f.actual_kwh;
 } else {
 var sum = 0, any = false;
 arrays.forEach(function (a) {
 (a.inverters || []).forEach(function (iv) {
 var k = _num(iv.window_kwh); if (k != null) { sum += k; any = true; }
 });
 });
 prodKwh = any ? sum : null;
 }

 // --- alarms (measured): arrays not "ok" + total flagged inverters ---------
 var alarmArrays = 0, flaggedInv = 0;
 cols.forEach(function (c) {
 var al = c.alert || {};
 if (al.level && al.level !== "ok") {
 alarmArrays++;
 flaggedInv += (_num(al.count) || 0);
 }
 });
 var hasCritical = cols.some(function (c) { return c.alert && c.alert.level === "critical"; });
 var alarmTone = alarmArrays === 0 ? "" : (hasCritical ? "bad" : "warn");

 // --- weather-adjusted performance (forecast-gated; never fabricated) ------
 var perfRatio = null;
 if (f && f.available) {
 if (_num(f.ratio_pct) != null) perfRatio = f.ratio_pct;
 else if (_num(f.performance_ratio_measured) != null) perfRatio = f.performance_ratio_measured * 100;
 }

 // --- build the cards ------------------------------------------------------
 var html = "";

 // 1. Sites
 html += card("Sites", fmt.num(sites),
 sites === 1 ? "1 array monitored" : sites + " arrays monitored",
 { tone: "" });

 // 2. Inverters
 html += card("Inverters", fmt.num(invTotal),
 "across " + fmt.num(sites) + (sites === 1 ? " site" : " sites"),
 { tone: "" });

 // 3. Fleet capacity (auto-MW)
 html += card("Fleet capacity", fmt.kw(capKw), "DC nameplate", { tone: "" });

 // 4. Producing now + % of capacity. Stale feeds were excluded from the sum
 // above; say so in the sub, and when EVERY feed is frozen show the last-known
 // total muted with "data stale", a frozen fleet must never read as live green.
 var prodSub = allStale
 ? "data stale"
 : (prodPctOfCap != null)
 ? fmt.pct(prodPctOfCap) + " of capacity"
 : (sawLive ? "live" : "no live reading yet");
 if (!allStale && pausedN) prodSub += " · " + pausedN + " feed" + (pausedN === 1 ? "" : "s") + " paused";
 html += card("Producing now",
 prodKw != null ? fmt.kw(prodKw) : "—",
 prodSub,
 { tone: sawLive && prodKw != null ? "good" : "muted" });

 // 5. Production over the window
 html += card("Production · " + win + "d",
 prodKwh != null ? fmt.kwh(prodKwh) : "—",
 f && _num(f.actual_kwh) != null ? "weather-modeled total" : "metered total",
 { tone: prodKwh != null ? "" : "muted" });

 // 6. Weather-adjusted performance (forecast or honest "—")
 if (perfRatio != null) {
 var pTone = perfRatio >= 92 ? "good" : (perfRatio < 82 ? "bad" : "warn");
 var confTxt = f.confidence ? (CONF_LABEL[f.confidence] || f.confidence) : "";
 var modeled = _num(f.arrays_modeled);
 var fcWin = (f.window && f.window.days) || win;
 var perfSub = "last " + fcWin + "d";
 if (confTxt) perfSub += " · " + confTxt;
 if (modeled != null) perfSub += " · " + modeled + (modeled === 1 ? " array modeled" : " arrays modeled");
 html += card("Weather-adj. performance", fmt.pct(perfRatio), perfSub, { tone: pTone });
 } else {
 html += card("Weather-adj. performance", "—", "not modeled yet", { tone: "muted",
 title: "Compares each site's measured production against the real sunlight that fell on it, over the last " + win + " days. "
 + "It needs a location on file plus a few days of measured daily production, usually 3–4 full days after a site starts producing, then it fills in automatically." });
 }

 // 7. Active alarms (measured)
 var alarmSub = alarmArrays === 0
 ? "all sites healthy"
 : fmt.num(flaggedInv) + (flaggedInv === 1 ? " inverter flagged" : " inverters flagged");
 html += card("Active alarms",
 fmt.num(alarmArrays),
 alarmSub,
 { tone: alarmTone, subTone: alarmArrays === 0 ? "" : (hasCritical ? "bad" : "warn") });

 // Energy at risk (forecast-gated) is NOT a tile, it's a distinct impact/money
 // figure, so it renders as a full-width banner BELOW the tile grid (built
 // further down). This also keeps the tile grid an even 7 (or fewer) so the
 // auto-fit rows never orphan a lone card. Compute it here; render below.
 var riskBanner = "";
 // actual_kwh covers MEASURED days only; the shortfall must subtract it from the
 // expected over those SAME matched days (expected_matched_kwh), not the full
 // window, otherwise unmeasured days inflate the "at risk" dollars (#15).
 var _expMatched = _num(f && f.expected_matched_kwh);
 if (_expMatched == null) _expMatched = _num(f && f.expected_kwh);
 if (f && f.available && _expMatched != null && _num(f.actual_kwh) != null) {
 var shortfallKwh = Math.max(0, _expMatched - f.actual_kwh);
 var rate = _num(ctx.energyRate) || 0;
 var dollars = shortfallKwh * rate;
 // optional REC value on the shortfall MWh
 var recPerMwh = _num(ctx.recPerMwh);
 if (recPerMwh != null) dollars += (shortfallKwh / 1000) * recPerMwh;
 var atRisk = shortfallKwh > 0;
 var riskMoney = atRisk ? "≈ " + fmt.money(dollars) : null;
 var riskLede = atRisk
 ? "Recoverable if the fleet met its weather-adjusted expected output"
 : "The fleet met or beat its weather-adjusted expected output";
 riskBanner =
 '<div class="ansum-banner' + (atRisk ? " warn" : " good") + '">' +
 '<div class="ansum-banner-main">' +
 '<div class="ansum-banner-lbl">Energy at risk<span class="ansum-banner-win"> · last ' + win + ' days</span></div>' +
 '<div class="ansum-banner-val">' +
 (atRisk ? esc(fmt.kwh(shortfallKwh)) : "0 kWh") +
 (riskMoney ? '<span class="ansum-banner-money">' + esc(riskMoney) + "</span>" : "") +
 '</div></div>' +
 '<div class="ansum-banner-lede">' + esc(riskLede) + "</div>" +
 "</div>";
 }

 // --- spotlight caption (skip silently if absent) -------------------------
 var spotHtml = "";
 var spot = f && f.sunny_spotlight;
 if (spot && _num(spot.ratio_pct) != null) {
 var rTone = spot.ratio_pct >= 92 ? "good" : (spot.ratio_pct < 82 ? "bad" : "");
 spotHtml =
 '<div class="ansum-spot"><span class="ansum-spot-ic">☀</span><span>' +
 "Clearest recent day (" + esc(spot.day) + ", " + esc(spot.poa_kwh_m2) + " kWh/m² sun): " +
 "<b>" + esc(spot.array_name) + "</b> made <b>" + fmt.kwh(spot.actual_kwh) + "</b> " +
 "vs " + fmt.kwh(spot.expected_kwh) + " expected, " +
 '<b class="' + rTone + '">' + fmt.pct(spot.ratio_pct) + "</b>." +
 "</span></div>";
 }

 container.innerHTML = '<div class="ansum-grid">' + html + "</div>" + riskBanner + spotHtml;
 }

 window.AnalysisSections = window.AnalysisSections || [];
 window.AnalysisSections.push({ id: "fleet-summary", title: "Portfolio", order: 10, render: render });
})();
