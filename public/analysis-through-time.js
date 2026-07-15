/* ============================================================================
 * Array Operator, Analysis tab · Through time (analysis-through-time.js)
 *
 * Glance panel: trailing months of fleet production with year-over-year and
 * last-3-years average so the Analysis tab answers "how is this month / this
 * stretch of months doing over a longer horizon?" without switching to Trends.
 *
 * Data: GET /v1/array-owners/fleet-trends (same payload as Trends). Cached at
 * module level; reuses in-memory cache across re-renders. Honest empty states
 * when signed out / no history / fetch failed.
 *
 * Visual:
 * • KPI strip, trailing 12 mo kWh · vs last year % · vs 3-yr avg %
 * • 12 trailing months as clustered bars: this year (bold), last year (ghost),
 * 3-year average (thin tick bar) so a scan reads the bigger picture.
 * ========================================================================== */
(function () {
 "use strict";

 window.AnalysisSections = window.AnalysisSections || [];

 var API = "/v1/array-owners/fleet-trends";
 var MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
 var TRAIL_N = 12; // trailing months shown

 // module cache, survive re-renders / live fleet ticks
 var _cache = null; // { data, at, err }
 var _inflight = null;
 var _wired = false;

 function injectCss() {
 if (document.getElementById("antt-css")) return;
 var s = document.createElement("style");
 s.id = "antt-css";
 s.textContent = [
 ".antt-body{padding:16px 18px 18px;}",
 ".antt-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}",
 ".antt-kpi{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:11px 13px;min-width:0;}",
 ".antt-kpi-l{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);}",
 ".antt-kpi-v{font-size:22px;font-weight:760;letter-spacing:-.015em;color:var(--ink);margin-top:4px;",
 " font-variant-numeric:tabular-nums;line-height:1.1;}",
 ".antt-kpi-v .u{font-size:12.5px;font-weight:640;color:var(--muted);margin-left:3px;}",
 ".antt-kpi-v.pos{color:var(--good);}",
 ".antt-kpi-v.neg{color:var(--bad);}",
 ".antt-kpi-v.dim{color:var(--faint);}",
 ".antt-kpi-s{font-size:11px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums;",
 " white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",

 /* chart */
 ".antt-chart{position:relative;}",
 ".antt-bars{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:6px;align-items:end;",
 " height:132px;padding:4px 0 0;}",
 ".antt-slot{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;",
 " height:100%;min-width:0;gap:3px;}",
 ".antt-cluster{display:flex;align-items:flex-end;justify-content:center;gap:2px;width:100%;height:100%;",
 " padding:0 1px;box-sizing:border-box;}",
 ".antt-b{width:28%;max-width:14px;border-radius:3px 3px 1px 1px;min-height:2px;transition:height .35s ease;}",
 ".antt-b.cur{background:var(--good);box-shadow:0 0 0 1px rgba(37,99,235,.12);}",
 ".antt-b.ly{background:rgba(100,116,139,.38);}",
 ".antt-b.avg{background:rgba(14,165,233,.45);width:18%;max-width:8px;}",
 ".antt-b.miss{background:transparent;border:1px dashed var(--line);min-height:4px;}",
 ".antt-mo{font-size:9.5px;font-weight:650;color:var(--faint);letter-spacing:.02em;",
 " white-space:nowrap;overflow:hidden;max-width:100%;}",
 ".antt-mo.now{color:var(--ink);font-weight:720;}",

 /* legend + footer */
 ".antt-leg{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:12px;",
 " font-size:11.5px;color:var(--muted);}",
 ".antt-sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;}",
 ".antt-sw.cur{background:var(--good);}",
 ".antt-sw.ly{background:rgba(100,116,139,.5);}",
 ".antt-sw.avg{background:rgba(14,165,233,.55);}",
 ".antt-link{margin-left:auto;color:var(--good);font-weight:680;text-decoration:none;font-size:12px;}",
 ".antt-link:hover{text-decoration:underline;}",

 /* empty / load */
 ".antt-empty{display:flex;gap:12px;align-items:flex-start;padding:8px 2px;}",
 ".antt-empty b{display:block;font-size:13.5px;font-weight:700;color:var(--ink);margin-bottom:3px;}",
 ".antt-empty span{font-size:12.5px;color:var(--muted);line-height:1.5;}",
 ".antt-load{padding:18px 4px;color:var(--faint);font-size:12.5px;}",

 "@media (max-width:760px){",
 " .antt-kpis{grid-template-columns:1fr;}",
 " .antt-bars{height:110px;gap:3px;}",
 " .antt-mo{font-size:8.5px;}",
 " .antt-leg{gap:10px;}",
 " .antt-link{margin-left:0;width:100%;}",
 "}"
 ].join("\n");
 document.head.appendChild(s);
 }

 function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
 return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
 });
 }
 function session() {
 try { return localStorage.getItem("so_session") || ""; } catch (e) { return ""; }
 }
 function kCompact(n) {
 if (n == null || !isFinite(n)) return "—";
 var a = Math.abs(n);
 if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
 if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
 return String(Math.round(n));
 }
 function pctStr(p) {
 if (p == null || !isFinite(p)) return "—";
 var sign = p > 0 ? "+" : "";
 return sign + p.toFixed(1) + "%";
 }
 function toneCls(p) {
 if (p == null || !isFinite(p)) return "dim";
 if (p > 0.5) return "pos";
 if (p < -0.5) return "neg";
 return "";
 }

 /** Build map year -> {month: kwh} from fleet-trends payload. */
 function byYearMap(data) {
 var out = {};
 var monthly = (data && data.monthly_by_year) || {};
 Object.keys(monthly).forEach(function (y) {
 var m = {};
 (monthly[y] || []).forEach(function (p) {
 if (p && p.month != null) m[p.month] = Number(p.kwh) || 0;
 });
 out[Number(y)] = m;
 });
 return out;
 }

 /** Last N complete-ish calendar months ending at the most recent month with data. */
 function trailingMonths(byYear, n) {
 var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });
 if (!years.length) return [];
 // Find latest (y,m) with data
 var ly = years[years.length - 1], lm = 12;
 var found = false;
 for (var m = 12; m >= 1; m--) {
 if (byYear[ly] && byYear[ly][m] != null) { lm = m; found = true; break; }
 }
 if (!found) return [];
 var pts = [];
 var y = ly, mo = lm;
 for (var i = 0; i < n; i++) {
 pts.unshift({ year: y, month: mo });
 mo -= 1;
 if (mo <= 0) { mo = 12; y -= 1; }
 }
 return pts;
 }

 function monthKwh(byYear, y, m) {
 if (!byYear[y] || byYear[y][m] == null) return null;
 return byYear[y][m];
 }

 /** Average of the same calendar month across up to `depth` prior years (not including y). */
 function avgPriorYears(byYear, y, m, depth) {
 var sum = 0, n = 0;
 for (var d = 1; d <= depth; d++) {
 var v = monthKwh(byYear, y - d, m);
 if (v != null) { sum += v; n++; }
 }
 return n ? sum / n : null;
 }

 function sumTrail(byYear, trail, yearOffset) {
 // yearOffset 0 = the trail as listed; 1 = same months one year earlier
 var sum = 0, n = 0;
 trail.forEach(function (pt) {
 var v = monthKwh(byYear, pt.year - yearOffset, pt.month);
 if (v != null) { sum += v; n++; }
 });
 return n ? { sum: sum, n: n } : null;
 }

 function sumTrailVsAvg3(byYear, trail) {
 // For each month in trail, compare to avg of prior 3 years' same month; sum both sides
 var cur = 0, avg = 0, n = 0;
 trail.forEach(function (pt) {
 var c = monthKwh(byYear, pt.year, pt.month);
 var a = avgPriorYears(byYear, pt.year, pt.month, 3);
 if (c != null && a != null) { cur += c; avg += a; n++; }
 });
 return n ? { cur: cur, avg: avg, n: n } : null;
 }

 function fetchTrends(force) {
 if (!force && _cache && _cache.data && (Date.now() - _cache.at < 5 * 60 * 1000)) {
 return Promise.resolve(_cache.data);
 }
 if (_inflight) return _inflight;
 var s = session();
 if (!s) {
 _cache = { data: null, at: Date.now(), err: "signed-out" };
 return Promise.resolve(null);
 }
 _inflight = fetch(API, { headers: { Authorization: "Bearer " + s } })
 .then(function (r) {
 if (!r.ok) throw new Error("http " + r.status);
 return r.json();
 })
 .then(function (d) {
 _cache = { data: d, at: Date.now(), err: null };
 _inflight = null;
 return d;
 })
 .catch(function (e) {
 _cache = { data: null, at: Date.now(), err: (e && e.message) || "fetch failed" };
 _inflight = null;
 return null;
 });
 return _inflight;
 }

 function paint(container, ctx, data) {
 injectCss();
 var head =
 '<div class="an-card">' +
 ' <div class="an-card-head">' +
 ' <h3>Through time</h3>' +
 ' <span class="an-card-sub">Trailing months · vs last year · vs last 3 years</span>' +
 ' </div>' +
 ' <div class="antt-body">';

 if (!session() && !(ctx && ctx.signedIn)) {
 container.innerHTML = head +
 '<div class="antt-empty"><div><b>Sign in to see multi-year production</b>' +
 '<span>Once your arrays have history, this panel shows trailing months against last year and a 3-year average, the long view at a glance.</span></div></div>' +
 '</div></div>';
 return;
 }

 if (!_cache || (_cache.err && !_cache.data && !_inflight)) {
 // loading or hard empty
 if (_inflight || !_cache) {
 container.innerHTML = head + '<div class="antt-load">Loading production history…</div></div></div>';
 return;
 }
 }

 if (!data) {
 var why = (_cache && _cache.err === "signed-out")
 ? "Sign in to load multi-year history."
 : (_cache && _cache.err)
 ? "Couldn't load production history (" + esc(_cache.err) + "). Try the Trends tab, or refresh."
 : "No monthly production history yet, it appears as soon as full months land.";
 container.innerHTML = head +
 '<div class="antt-empty"><div><b>No multi-year view yet</b><span>' + why + '</span></div></div>' +
 '</div></div>';
 return;
 }

 var byYear = byYearMap(data);
 var trail = trailingMonths(byYear, TRAIL_N);
 if (!trail.length) {
 container.innerHTML = head +
 '<div class="antt-empty"><div><b>History is still building</b>' +
 '<span>We need at least one full month of fleet production before the trailing view can paint.</span></div></div>' +
 '</div></div>';
 return;
 }

 // Peak for bar scaling across cur / ly / 3yr avg
 var peak = 1;
 trail.forEach(function (pt) {
 var c = monthKwh(byYear, pt.year, pt.month);
 var ly = monthKwh(byYear, pt.year - 1, pt.month);
 var a3 = avgPriorYears(byYear, pt.year, pt.month, 3);
 [c, ly, a3].forEach(function (v) { if (v != null && v > peak) peak = v; });
 });

 // KPIs
 var ttm = data.ttm_kwh != null ? Number(data.ttm_kwh) : null;
 if (ttm == null) {
 var s0 = sumTrail(byYear, trail, 0);
 if (s0) ttm = s0.sum;
 }
 var curSum = sumTrail(byYear, trail, 0);
 var lySum = sumTrail(byYear, trail, 1);
 var yoyPct = null;
 if (curSum && lySum && lySum.sum > 0 && lySum.n >= 3) {
 // Full months only (Paul 2026-07-15): skip in-progress calendar month so
 // MTD is never compared to a full prior-year month.
 var now = new Date();
 var curY = now.getFullYear(), curM = now.getMonth() + 1;
 var skipPartial = now.getDate() < 28;
 var cA = 0, lA = 0, nA = 0;
 trail.forEach(function (pt) {
 if (skipPartial && pt.year === curY && pt.month === curM) return;
 var c = monthKwh(byYear, pt.year, pt.month);
 var l = monthKwh(byYear, pt.year - 1, pt.month);
 if (c != null && l != null) { cA += c; lA += l; nA++; }
 });
 if (nA >= 3 && lA > 0) yoyPct = 100 * (cA - lA) / lA;
 }
 var vs3 = sumTrailVsAvg3(byYear, trail);
 var vs3Pct = (vs3 && vs3.avg > 0) ? 100 * (vs3.cur - vs3.avg) / vs3.avg : null;

 var first = trail[0], last = trail[trail.length - 1];
 var rangeLbl = MONTHS3[first.month - 1] + " " + first.year + " – " +
 MONTHS3[last.month - 1] + " " + last.year;

 var kpiHtml =
 '<div class="antt-kpis">' +
 ' <div class="antt-kpi" title="Sum of the last 12 calendar months of fleet production">' +
 ' <div class="antt-kpi-l">Trailing 12 mo</div>' +
 ' <div class="antt-kpi-v">' + esc(kCompact(ttm)) + '<span class="u">kWh</span></div>' +
 ' <div class="antt-kpi-s">' + esc(rangeLbl) + '</div>' +
 ' </div>' +
 ' <div class="antt-kpi" title="Same calendar months this year vs one year earlier (aligned months only)">' +
 ' <div class="antt-kpi-l">Vs last year</div>' +
 ' <div class="antt-kpi-v ' + toneCls(yoyPct) + '">' + esc(pctStr(yoyPct)) + '</div>' +
 ' <div class="antt-kpi-s">' + (yoyPct == null ? "Needs 2+ years of overlap" : "Same months, year prior") + '</div>' +
 ' </div>' +
 ' <div class="antt-kpi" title="This stretch vs the average of the same months in the prior 3 years">' +
 ' <div class="antt-kpi-l">Vs last 3 years</div>' +
 ' <div class="antt-kpi-v ' + toneCls(vs3Pct) + '">' + esc(pctStr(vs3Pct)) + '</div>' +
 ' <div class="antt-kpi-s">' + (vs3Pct == null ? "Needs multi-year history" : "Avg of prior 3 same-months") + '</div>' +
 ' </div>' +
 '</div>';

 var bars = trail.map(function (pt) {
 var c = monthKwh(byYear, pt.year, pt.month);
 var ly = monthKwh(byYear, pt.year - 1, pt.month);
 var a3 = avgPriorYears(byYear, pt.year, pt.month, 3);
 function h(v) {
 if (v == null) return 0;
 return Math.max(2, Math.round((v / peak) * 100));
 }
 var tip = MONTHS3[pt.month - 1] + " " + pt.year +
 " · now " + (c != null ? kCompact(c) + " kWh" : "—") +
 " · LY " + (ly != null ? kCompact(ly) + " kWh" : "—") +
 " · 3yr avg " + (a3 != null ? kCompact(a3) + " kWh" : "—");
 var isNow = (pt === last);
 return '<div class="antt-slot" title="' + esc(tip) + '">' +
 '<div class="antt-cluster">' +
 (ly != null
 ? '<span class="antt-b ly" style="height:' + h(ly) + '%"></span>'
 : '<span class="antt-b miss" style="height:4px"></span>') +
 (a3 != null
 ? '<span class="antt-b avg" style="height:' + h(a3) + '%"></span>'
 : '') +
 (c != null
 ? '<span class="antt-b cur" style="height:' + h(c) + '%"></span>'
 : '<span class="antt-b miss" style="height:4px"></span>') +
 '</div>' +
 '<div class="antt-mo' + (isNow ? " now" : "") + '">' +
 esc(MONTHS3[pt.month - 1]) +
 (pt.month === 1 || pt === trail[0] ? " '" + String(pt.year).slice(2) : "") +
 '</div></div>';
 }).join("");

 var leg =
 '<div class="antt-leg">' +
 '<span><i class="antt-sw cur"></i>This year</span>' +
 '<span><i class="antt-sw ly"></i>Last year</span>' +
 '<span><i class="antt-sw avg"></i>3-year avg</span>' +
 '<a class="antt-link" href="#trends">Open Trends for the full picture →</a>' +
 '</div>';

 container.innerHTML = head + kpiHtml +
 '<div class="antt-chart"><div class="antt-bars">' + bars + '</div></div>' +
 leg + '</div></div>';
 }

 function render(container, ctx) {
 injectCss();
 // Show cache immediately, then refresh if stale
 paint(container, ctx, _cache && _cache.data);
 fetchTrends(false).then(function (d) {
 // only repaint if this section is still mounted
 if (!container.isConnected) return;
 paint(container, ctx, d);
 });
 }

 window.AnalysisSections.push({
 id: "through-time",
 title: "Through time",
 order: 15, // after portfolio KPIs (10), before sites grid (20)
 render: render
 });
})();
