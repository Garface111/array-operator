/* ============================================================================
 * Array Operator — Analysis tab · Sites grid (analysis-sites-grid.js)
 *
 * The signature PowerTrack-style fleet table: one row per site, sortable, with a
 * hero "Actual vs Expected" bar column (weather-adjusted performance ratio). It
 * renders entirely off the read-only `ctx` the orchestrator assembles — it never
 * fetches, never mutates ctx.
 *
 * HONESTY (Ford's hard rule): the Expected + Actual-vs-Expected columns are the
 * ONLY place a weather-model number appears. When a site has no forecast row
 * (anonymous demo, or an array the backend listed in forecast.skipped), those two
 * cells read "not modeled yet" — we never fabricate a %, never paint a 0% bar.
 * The measured columns (trend, producing now, this-window kWh, capacity) are real
 * for every site, so the table is excellent even with no forecast at all.
 *
 * Self-contained: registers on window.AnalysisSections, injects ONE scoped
 * <style id="ansg-css">, every class namespaced .ansg-*, idempotent render that
 * rebuilds innerHTML each call while preserving sort + search in module vars.
 * ========================================================================== */
(function () {
  "use strict";

  window.AnalysisSections = window.AnalysisSections || [];

  // ---- preserved UI state (survives re-renders / live updates) ----------------
  var sortKey = "ratio";   // default: surface the worst performers first
  var sortDir = "asc";     // ratio asc → low % at the top (PowerTrack default)
  var searchText = "";
  var groupBy = "none";          // "none" | "portfolio" | "vendor"
  var groupBy2 = "none";         // secondary "then by": "none" | "portfolio" | "vendor"
  var density = "comfortable";   // "comfortable" | "compact" — pure CSS density switch
  var collapsedGroups = {};      // {mode: Set(groupKey)} — per-mode collapse state
  function collapsedSetFor(mode) {
    if (!collapsedGroups[mode]) collapsedGroups[mode] = Object.create(null);
    return collapsedGroups[mode];
  }

  // ---- one-time scoped stylesheet --------------------------------------------
  function injectCSS() {
    if (document.getElementById("ansg-css")) return;
    var s = document.createElement("style");
    s.id = "ansg-css";
    s.textContent = [
      ".ansg-wrap{overflow-x:auto}",
      // toolbar (search + count) above the table
      ".ansg-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:0 4px 0 2px}",
      ".ansg-search{position:relative;flex:0 0 auto}",
      ".ansg-search input{appearance:none;background:var(--bg2);border:1px solid var(--line);border-radius:9px;color:var(--ink);font:inherit;font-size:12.5px;padding:7px 11px 7px 28px;width:200px;outline:none;transition:border-color .12s,box-shadow .12s}",
      ".ansg-search input:focus{border-color:var(--good2);box-shadow:0 0 0 3px rgba(14,165,233,.14)}",
      ".ansg-search input::placeholder{color:var(--faint)}",
      ".ansg-search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:13px;height:13px;color:var(--faint);pointer-events:none}",
      ".ansg-count{color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      // table
      ".ansg-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px;min-width:1000px}",
      ".ansg-table th,.ansg-table td{padding:9px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}",
      ".ansg-table thead th{position:sticky;top:0;z-index:1;background:var(--card2);color:var(--muted);font-size:10.5px;font-weight:740;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;user-select:none;border-bottom:1px solid var(--line)}",
      ".ansg-table thead th.ansg-sortable:hover{color:var(--ink)}",
      ".ansg-table thead th.ansg-num,.ansg-table td.ansg-num{text-align:right}",
      ".ansg-table thead th.ansg-on{color:var(--ink)}",
      ".ansg-arrow{display:inline-block;width:0;opacity:0;margin-left:4px;font-size:9px;transition:opacity .1s}",
      ".ansg-table thead th.ansg-on .ansg-arrow{opacity:.9;width:auto}",
      ".ansg-table tbody tr{transition:background .1s}",
      ".ansg-table tbody tr:hover{background:var(--bg2)}",
      ".ansg-table tbody tr:last-child td{border-bottom:0}",
      // status dot + count badge
      ".ansg-dotcell{width:1%;padding-right:4px}",
      ".ansg-dot{display:inline-flex;align-items:center;gap:6px}",
      ".ansg-dot i{width:9px;height:9px;border-radius:50%;background:var(--faint);box-shadow:0 0 0 3px rgba(100,116,139,.12)}",
      ".ansg-dot.ok i{background:var(--good);box-shadow:0 0 0 3px rgba(37,99,235,.14)}",
      ".ansg-dot.warn i{background:var(--warn);box-shadow:0 0 0 3px rgba(217,119,6,.16)}",
      ".ansg-dot.critical i{background:var(--bad);box-shadow:0 0 0 3px rgba(220,38,38,.16)}",
      ".ansg-badge{font-size:10px;font-weight:760;color:var(--bad);background:rgba(220,38,38,.12);border-radius:7px;padding:1px 5px;line-height:1.5}",
      ".ansg-dot.warn .ansg-badge{color:var(--warn);background:rgba(217,119,6,.12)}",
      // name cell
      ".ansg-name{font-weight:680;color:var(--ink);max-width:230px;overflow:hidden;text-overflow:ellipsis}",
      ".ansg-name-row{display:flex;align-items:center;gap:7px}",
      ".ansg-vtag{font-size:9.5px;font-weight:720;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;flex:0 0 auto}",
      ".ansg-region{display:block;color:var(--faint);font-size:11px;font-weight:500;margin-top:1px;max-width:230px;overflow:hidden;text-overflow:ellipsis}",
      // sparkline
      ".ansg-spark{display:block}",
      ".ansg-spark-none{color:var(--faint)}",
      // measured value cells
      ".ansg-val{color:var(--ink);font-weight:560}",
      ".ansg-muted{color:var(--muted)}",
      ".ansg-faint{color:var(--faint)}",
      ".ansg-now{display:inline-flex;align-items:center;gap:6px}",
      ".ansg-now b{color:var(--good2);font-weight:680}",
      ".ansg-livedot{width:6px;height:6px;border-radius:50%;background:var(--good2);box-shadow:0 0 0 2px rgba(14,165,233,.18)}",
      // hero: actual-vs-expected bar
      ".ansg-ave{min-width:180px}",
      ".ansg-bar-row{display:flex;align-items:center;gap:9px}",
      ".ansg-track{position:relative;flex:1 1 auto;height:16px;min-width:96px;background:var(--bg2);border-radius:5px;overflow:hidden}",
      ".ansg-fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:var(--good);transition:width .35s cubic-bezier(.22,.61,.36,1)}",
      ".ansg-fill.neutral{background:var(--muted)}",
      ".ansg-fill.bad{background:var(--bad)}",
      ".ansg-tick{position:absolute;top:-1px;bottom:-1px;width:1px;background:var(--faint);opacity:.5}", // 100% reference
      ".ansg-pct{flex:0 0 auto;width:42px;text-align:right;font-weight:700;color:var(--ink)}",
      ".ansg-pct.over{color:var(--good)}",
      ".ansg-pct.bad{color:var(--bad)}",
      ".ansg-pct.neutral{color:var(--muted)}",
      ".ansg-nomodel{color:var(--faint);font-style:italic;font-size:12px}",
      ".ansg-setloc{appearance:none;background:transparent;border:1px dashed var(--good);color:var(--good);border-radius:7px;font:inherit;font-size:11px;font-weight:700;line-height:1.4;padding:2px 9px;cursor:pointer;transition:background .12s,color .12s;white-space:nowrap}",
      ".ansg-setloc:hover{background:var(--good);color:#fff}",
      ".ansg-setloc:disabled{opacity:.6;cursor:default}",
      // footer totals
      ".ansg-table tfoot td{border-top:2px solid var(--line);border-bottom:0;font-weight:700;color:var(--ink);background:var(--card2);padding-top:11px;padding-bottom:11px}",
      ".ansg-table tfoot .ansg-tlabel{color:var(--muted);font-weight:740;font-size:11px;letter-spacing:.05em;text-transform:uppercase}",
      ".ansg-empty{padding:30px 18px;text-align:center;color:var(--muted);font-size:13px}",
      // group-by control (right side of toolbar)
      ".ansg-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".ansg-groupctl{display:flex;align-items:center;gap:7px}",
      ".ansg-groupctl > span{color:var(--faint);font-size:10.5px;font-weight:740;letter-spacing:.06em;text-transform:uppercase}",
      // group header rows
      ".ansg-grouphead{cursor:pointer;user-select:none}",
      ".ansg-grouphead td{background:var(--bg2);border-bottom:1px solid var(--line);border-top:1px solid var(--line);padding-top:8px;padding-bottom:8px}",
      ".ansg-grouphead:hover td{background:var(--card2)}",
      ".ansg-ghd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".ansg-chev{flex:0 0 auto;width:11px;height:11px;color:var(--muted);transition:transform .15s}",
      ".ansg-grouphead.ansg-collapsed .ansg-chev{transform:rotate(-90deg)}",
      ".ansg-gname{font-weight:760;color:var(--ink);font-size:13px;letter-spacing:.01em}",
      ".ansg-gname.ansg-unassigned{color:var(--muted);font-weight:680}",
      ".ansg-gcount{color:var(--faint);font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".ansg-groll{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:12px;font-variant-numeric:tabular-nums}",
      ".ansg-groll .ansg-gm{display:inline-flex;align-items:baseline;gap:5px;white-space:nowrap}",
      ".ansg-groll .ansg-gm i{font-style:normal;color:var(--faint);font-size:10px;font-weight:740;letter-spacing:.04em;text-transform:uppercase}",
      ".ansg-groll .ansg-gm b{color:var(--ink);font-weight:680}",
      ".ansg-gpct{font-weight:760}",
      ".ansg-gpct.over{color:var(--good)}",
      ".ansg-gpct.bad{color:var(--bad)}",
      ".ansg-gpct.neutral{color:var(--muted)}",
      ".ansg-galarm{display:inline-flex;align-items:center;gap:4px;font-weight:740;color:var(--faint)}",
      ".ansg-galarm.warn{color:var(--warn)}",
      ".ansg-galarm.bad{color:var(--bad)}",
      // assign-to-portfolio affordance in the Site cell
      ".ansg-assign{appearance:none;background:transparent;border:1px dashed var(--line);color:var(--faint);border-radius:6px;font:inherit;font-size:10px;font-weight:700;line-height:1.4;padding:1px 6px;cursor:pointer;opacity:0;transition:opacity .12s,border-color .12s,color .12s;flex:0 0 auto}",
      ".ansg-table tbody tr:hover .ansg-assign{opacity:1}",
      ".ansg-assign:hover{border-color:var(--good2);color:var(--good2);border-style:solid}",
      ".ansg-assign.ansg-has{opacity:.65;border-style:solid;border-color:var(--line)}",
      ".ansg-table tbody tr:hover .ansg-assign.ansg-has{opacity:1}",
      // per-site weather icon column (PowerTrack-style)
      ".ansg-wxcell{width:1%;text-align:center;padding-left:6px;padding-right:6px}",
      ".ansg-wx{display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;cursor:default}",
      ".ansg-wx.good{color:var(--good)}",
      ".ansg-wx.sky{color:var(--sky)}",
      ".ansg-wx.muted{color:var(--faint)}",
      ".ansg-wx-none{color:var(--faint)}",
      // O&M reminder note — folded into the Site name row (used to be its own
      // "Notes" column; removed to give the rest of the table room, same
      // hover-reveal language as .ansg-assign right above).
      ".ansg-rem-inline{display:inline-block;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:650;color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;flex:0 0 auto}",
      ".ansg-rem-inline.ansg-editable{cursor:pointer}",
      ".ansg-rem-inline.ansg-editable:hover{color:var(--ink);border-color:var(--good2)}",
      ".ansg-remadd.ansg-inline{appearance:none;background:transparent;border:1px dashed var(--line);color:var(--faint);border-radius:6px;font:inherit;font-size:10px;font-weight:700;line-height:1.4;padding:1px 6px;cursor:pointer;opacity:0;transition:opacity .12s,border-color .12s,color .12s;flex:0 0 auto}",
      ".ansg-table tbody tr:hover .ansg-remadd.ansg-inline{opacity:1}",
      ".ansg-remadd.ansg-inline:hover{border-color:var(--good2);color:var(--good2);border-style:solid}",
      // density: compact tightens padding + font on the table wrapper
      ".ansg-wrap.ansg-compact .ansg-table{font-size:11.5px}",
      ".ansg-wrap.ansg-compact .ansg-table th,.ansg-wrap.ansg-compact .ansg-table td{padding:5px 9px}",
      ".ansg-wrap.ansg-compact .ansg-table thead th{font-size:9.5px}",
      ".ansg-wrap.ansg-compact .ansg-grouphead td{padding-top:5px;padding-bottom:5px}",
      ".ansg-wrap.ansg-compact .ansg-subhead td{padding-top:4px;padding-bottom:4px}",
      ".ansg-wrap.ansg-compact .ansg-table tfoot td{padding-top:7px;padding-bottom:7px}",
      // secondary "then by" selector in the toolbar
      ".ansg-thenby{display:flex;align-items:center;gap:7px}",
      ".ansg-thenby > span{color:var(--faint);font-size:10.5px;font-weight:740;letter-spacing:.06em;text-transform:uppercase}",
      // secondary sub-group header rows (lighter + indented under the primary)
      ".ansg-subhead{cursor:default;user-select:none}",
      ".ansg-subhead td{background:var(--card);border-bottom:1px solid var(--line);padding-top:6px;padding-bottom:6px}",
      ".ansg-shd{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding-left:22px}",
      ".ansg-shd::before{content:'';flex:0 0 auto;width:8px;height:8px;border-left:1px solid var(--line);border-bottom:1px solid var(--line);margin-right:2px;transform:translateY(-2px)}",
      ".ansg-sname{font-weight:700;color:var(--muted);font-size:12px;letter-spacing:.01em}",
      ".ansg-sname.ansg-unassigned{color:var(--faint);font-weight:640}",
      ".ansg-scount{color:var(--faint);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".ansg-sroll{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:11.5px;font-variant-numeric:tabular-nums}",
      ".ansg-sroll .ansg-gm{display:inline-flex;align-items:baseline;gap:5px;white-space:nowrap}",
      ".ansg-sroll .ansg-gm i{font-style:normal;color:var(--faint);font-size:9.5px;font-weight:740;letter-spacing:.04em;text-transform:uppercase}",
      ".ansg-sroll .ansg-gm b{color:var(--muted);font-weight:680}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- helpers ----------------------------------------------------------------
  var VENDORS = { solaredge: 1, fronius: 1, sma: 1, chint: 1, locus: 1, cps: 1, enphase: 1 };
  function vendorTag(v) {
    var k = String(v || "").toLowerCase();
    return VENDORS[k] ? k : (k || "");
  }

  // daily kWh series for a site: prefer the array-level series, else sum per-day
  // across its inverters' series. Returns [] when there's nothing to draw.
  function seriesFor(col) {
    if (Array.isArray(col.daily) && col.daily.length) {
      return col.daily.map(function (d) { return num(d && d.kwh); });
    }
    var invs = col.inverters || [];
    var byDay = {};   // date -> summed kwh (keeps day alignment across inverters)
    var order = [];
    invs.forEach(function (iv) {
      (iv.daily || []).forEach(function (d) {
        var key = (d && d.date != null) ? String(d.date) : null;
        var v = num(d && d.kwh);
        if (key == null) return;
        if (!(key in byDay)) { byDay[key] = 0; order.push(key); }
        if (v != null) byDay[key] += v;
      });
    });
    return order.map(function (k) { return byDay[k]; });
  }
  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  // inline sparkline of a kWh series, themed via currentColor on the path
  function sparkline(series) {
    var vals = (series || []).filter(function (v) { return v != null; });
    if (vals.length < 2) return '<span class="ansg-spark-none">—</span>';
    var W = 88, H = 22, pad = 2;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    var span = (max - min) || 1;
    var n = series.length;
    var stepX = (W - pad * 2) / (n - 1);
    var pts = [];
    for (var i = 0; i < n; i++) {
      var v = series[i];
      if (v == null) continue;
      var x = pad + i * stepX;
      var y = pad + (H - pad * 2) * (1 - (v - min) / span);
      pts.push([x, y]);
    }
    if (pts.length < 2) return '<span class="ansg-spark-none">—</span>';
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = d + " L" + pts[pts.length - 1][0].toFixed(1) + " " + H + " L" + pts[0][0].toFixed(1) + " " + H + " Z";
    var last = pts[pts.length - 1];
    // healthy blue series; subtle area fill under the line + an end dot
    return '<svg class="ansg-spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<path d="' + area + '" fill="var(--good)" opacity="0.08"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--good2)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.9" fill="var(--good2)"/>' +
      '</svg>';
  }

  // ratio → bar color bucket (≥92 good · 82–92 neutral · <82 bad · >115 over=good)
  function ratioBucket(r) {
    if (r == null) return "none";
    if (r >= 92) return "good";      // includes the over-performers (>115)
    if (r >= 82) return "neutral";
    return "bad";
  }

  // ---- grouping ---------------------------------------------------------------
  var UNASSIGNED = "Unassigned";
  // canonical display names for known vendor keys (Title-case per Ford's spec)
  var VENDOR_LABEL = {
    solaredge: "SolarEdge", fronius: "Fronius", sma: "SMA", chint: "CHINT",
    locus: "Locus", cps: "CPS", enphase: "Enphase"
  };
  function vendorLabel(key) {
    if (!key) return "Other";
    return VENDOR_LABEL[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  }
  // group key + display label + sort hint for a row, per the active mode
  function groupKeyFor(r, mode) {
    if (mode === "portfolio") {
      return r.portfolio ? { key: r.portfolio, label: r.portfolio, last: false }
                         : { key: UNASSIGNED, label: UNASSIGNED, last: true };
    }
    // vendor
    var label = vendorLabel(r.vendor);
    return { key: label, label: label, last: label === "Other" };
  }
  // rollup the measured + forecast aggregates for one group's rows
  function groupRollup(rs, ctx) {
    var cap = 0, hasCap = false, win = 0, hasWin = false;
    var actSum = 0, expSum = 0, modeled = 0, alarms = 0;
    rs.forEach(function (r) {
      if (r.cap != null) { cap += r.cap; hasCap = true; }
      if (r.win != null) { win += r.win; hasWin = true; }
      if (r.alertCount) alarms += r.alertCount;
      // group performance: sum measured actual ÷ sum matched expected, only for
      // rows that actually have a forecast (never fabricate)
      var fc = ctx.forecastByArray[r.aid];
      if (fc) {
        // actual_kwh is summed over MEASURED days only, so compare it to the
        // expected over those SAME matched days (expected_matched_kwh), never the
        // full-window expected — else a half-measured array is painted red (#15).
        var a = num(fc.actual_kwh);
        var e = num(fc.expected_matched_kwh);
        if (e == null) e = num(fc.expected_kwh);   // fallback for older payloads
        if (a != null && e != null && e > 0) { actSum += a; expSum += e; modeled++; }
      }
    });
    var pct = (modeled > 0 && expSum > 0) ? Math.round(actSum / expSum * 100) : null;
    return { cap: cap, hasCap: hasCap, win: win, hasWin: hasWin, pct: pct, alarms: alarms, count: rs.length };
  }
  function chevronSvg() {
    return '<svg class="ansg-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  }

  // ---- build one row's data model (measured + optional forecast) --------------
  function rowModel(col, ctx) {
    var aid = String(col.array_id);
    var fc = ctx.forecastByArray[aid] || null;

    // capacity: prefer forecast nameplate, else sum inverter nameplates
    var cap = (fc && num(fc.nameplate_kw)) != null ? num(fc.nameplate_kw) : null;
    if (cap == null) {
      var s = 0, any = false;
      (col.inverters || []).forEach(function (iv) { var n = num(iv.nameplate_kw); if (n != null) { s += n; any = true; } });
      cap = any ? s : null;
    }

    // this-window kWh: prefer forecast actual_kwh, else sum inverter window_kwh
    var win = (fc && num(fc.actual_kwh)) != null ? num(fc.actual_kwh) : null;
    if (win == null) {
      var w = 0, anyW = false;
      (col.inverters || []).forEach(function (iv) { var n = num(iv.window_kwh); if (n != null) { w += n; anyW = true; } });
      win = anyW ? w : null;
    }

    var ratio = fc ? num(fc.ratio_pct) : null;
    // Show expected over the SAME measured days as `win` (actual_kwh), so the
    // Expected column reconciles with Actual and the ratio badge (#15); full-window
    // expected here made a half-measured site read e.g. 252 actual / 588 expected
    // yet a 90% badge. Fall back to full-window only for older payloads.
    var expected = fc ? (num(fc.expected_matched_kwh) != null
                          ? num(fc.expected_matched_kwh) : num(fc.expected_kwh)) : null;
    // Open-Meteo weathercode (int) if the forecast row carries one
    var wxCode = (fc && typeof fc.weather_code === "number" && isFinite(fc.weather_code)) ? fc.weather_code : null;
    // operator O&M note on the site (string|null); empty string → treated as none
    var reminder = (typeof col.reminder === "string" && col.reminder.trim()) ? col.reminder.trim() : null;

    // region only if it's a real value (real columns carry "—"); look up canonical
    var region = null;
    var arr = null;
    if (Array.isArray(ctx.arrays)) {
      for (var i = 0; i < ctx.arrays.length; i++) { if (String(ctx.arrays[i].id) === aid) { arr = ctx.arrays[i]; break; } }
      if (arr && arr.region && arr.region !== "—") region = arr.region;
    }

    // portfolio label: prefer the column's, fall back to the canonical array's
    var pf = col.portfolio_name;
    if (pf == null && arr) pf = arr.portfolio_name;
    pf = (typeof pf === "string") ? pf.trim() : "";

    // freshness: a stale column's current_power_w is a FROZEN reading, not live —
    // use the spreadsheet's canonical VendorSheet.isStale (fallback: not stale, the
    // old behavior) so cellNow can drop the live-dot and show the reading's age.
    // staleAge is the SOURCE-data age ("3h ago" → "3h"), not our sync clock — the
    // honest "this number is from X ago" (same basis as the sheet's stale tooltip).
    var stale = !!(window.VendorSheet && VendorSheet.isStale && VendorSheet.isStale(col));

    return {
      col: col,
      aid: aid,
      name: col.array_name || "Site",
      vendor: vendorTag(col.vendor),
      portfolio: pf,                 // "" → Unassigned bucket
      region: region,
      level: (col.alert && col.alert.level) || "ok",
      alertCount: (col.alert && num(col.alert.count)) || 0,
      series: seriesFor(col),
      powerW: num(col.current_power_w),
      producedToday: num(col.produced_today_kwh),
      isDaylight: col.is_daylight !== false,
      isStale: stale,
      staleAge: (stale && window.VendorSheet && VendorSheet.freshness)
        ? String(VendorSheet.freshness(col)).replace(/\s*ago$/, "") : "",
      expected: expected,
      ratio: ratio,
      hasForecast: !!fc,
      wxCode: wxCode,
      reminder: reminder,
      win: win,
      cap: cap
    };
  }

  // ---- sort comparator (forecast-less rows sink for the ratio sort) -----------
  function compare(a, b, key, dir) {
    var mul = dir === "asc" ? 1 : -1;
    function n(x) { return x == null ? null : x; }
    var av, bv;
    switch (key) {
      case "status": av = statusRank(a); bv = statusRank(b); break;
      case "name": return a.name.localeCompare(b.name) * mul;
      case "now": av = n(a.powerW); bv = n(b.powerW); break;
      case "expected": av = n(a.expected); bv = n(b.expected); break;
      case "ratio": av = n(a.ratio); bv = n(b.ratio); break;
      case "window": av = n(a.win); bv = n(b.win); break;
      case "cap": av = n(a.cap); bv = n(b.cap); break;
      default: av = n(a.ratio); bv = n(b.ratio);
    }
    // nulls always sink to the bottom regardless of direction
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return a.name.localeCompare(b.name);
  }
  function statusRank(r) { return r.level === "critical" ? 0 : r.level === "warn" ? 1 : 2; }

  // ---- column defs (drives header render + sort keys) -------------------------
  var COLS = [
    { key: "status", label: "", sortable: true, cls: "ansg-dotcell" },
    { key: "name", label: "Site", sortable: true },
    { key: "trend", label: "14-day", sortable: false },
    { key: "now", label: "Producing now", sortable: true, num: true },
    { key: "wx", label: "Sky", sortable: false, cls: "ansg-wxcell" },
    { key: "expected", label: "Expected", sortable: true, num: true },
    { key: "ratio", label: "Actual vs expected", sortable: true },
    { key: "window", label: "This window", sortable: true, num: true },
    { key: "cap", label: "Capacity", sortable: true, num: true }
  ];

  // ---- cell renderers ---------------------------------------------------------
  function cellStatus(r) {
    var badge = r.alertCount > 0 ? '<span class="ansg-badge">' + r.alertCount + '</span>' : "";
    return '<td class="ansg-dotcell"><span class="ansg-dot ' + r.level + '"><i></i>' + badge + '</span></td>';
  }
  function cellName(r, ctx) {
    var tag = r.vendor ? '<span class="ansg-vtag">' + ctx.esc(r.vendor) + '</span>' : "";
    var region = r.region ? '<span class="ansg-region">' + ctx.esc(r.region) + '</span>' : "";
    // assign-to-portfolio: only when signed in AND the mutator exists (no anon demo)
    var assign = "";
    if (ctx.signedIn && ctx.live && ctx.live.setArrayPortfolio) {
      assign = r.portfolio
        ? '<button type="button" class="ansg-assign ansg-has" data-assign="' + ctx.esc(r.aid) + '" title="Change portfolio · ' + ctx.esc(r.portfolio) + '">' + ctx.esc(r.portfolio) + '</button>'
        : '<button type="button" class="ansg-assign" data-assign="' + ctx.esc(r.aid) + '" title="Assign to a portfolio">+ portfolio</button>';
    }
    // O&M reminder note — folded in HERE (used to be its own "Notes" column, which
    // ate a full column of width on an already side-scrolling table — Ford: "delete
    // the notes column so there's more space"). Same data-reminder attribute + click
    // wiring as before, just living next to the portfolio-assign chip instead of its
    // own column. Editable only when signed in AND the mutator exists; on the anon
    // demo an existing note is read-only, and nothing renders when there's no note.
    var note = "";
    var canEditNote = !!(ctx.signedIn && ctx.live && ctx.live.setArrayReminder);
    if (r.reminder) {
      var noteCls = "ansg-rem-inline" + (canEditNote ? " ansg-editable" : "");
      var noteEdit = canEditNote ? ' data-reminder="' + ctx.esc(r.aid) + '"' : "";
      note = '<span class="' + noteCls + '" title="' + ctx.esc(r.reminder) + '"' + noteEdit + '>📝 ' + ctx.esc(r.reminder) + '</span>';
    } else if (canEditNote) {
      note = '<button type="button" class="ansg-remadd ansg-inline" data-reminder="' + ctx.esc(r.aid) + '" title="Add an O&amp;M note">+ note</button>';
    }
    return '<td><div class="ansg-name-row"><span class="ansg-name" title="' + ctx.esc(r.name) + '">' + ctx.esc(r.name) + '</span>' + tag + assign + note + '</div>' + region + '</td>';
  }
  function cellTrend(r) {
    return '<td>' + sparkline(r.series) + '</td>';
  }
  // per-site weather glyph via ctx.sky(weather_code). null → faint "·" (honest:
  // nothing rendered when the forecast row has no code).
  function cellWeather(r, ctx) {
    var sky = (typeof ctx.sky === "function" && r.wxCode != null) ? ctx.sky(r.wxCode) : null;
    if (!sky || !sky.glyph) return '<td class="ansg-wxcell"><span class="ansg-wx-none" aria-hidden="true">·</span></td>';
    var tone = sky.tone === "good" ? "good" : sky.tone === "sky" ? "sky" : sky.tone === "muted" ? "muted" : "";
    var label = ctx.esc(sky.label || "");
    return '<td class="ansg-wxcell"><span class="ansg-wx ' + tone + '" title="' + label + '" aria-label="' + label + '" role="img">' + ctx.esc(sky.glyph) + '</span></td>';
  }
  function cellNow(r, ctx) {
    var kw = ctx.fmt.kwFromW(r.powerW);
    if (kw != null && kw >= 0.05) {
      // stale feed → the number is frozen, not live: no live-dot, dimmed value,
      // and an honest "as of" age so it can never be mistaken for current output
      if (r.isStale) {
        var age = r.staleAge ? '· as of ' + r.staleAge : '· stale';
        return '<td class="ansg-num ansg-muted"><b>' + ctx.esc(ctx.fmt.kw(kw)) + '</b> <span class="ansg-faint">' + ctx.esc(age) + '</span></td>';
      }
      return '<td class="ansg-num"><span class="ansg-now"><span class="ansg-livedot"></span><b>' + ctx.esc(ctx.fmt.kw(kw)) + '</b></span></td>';
    }
    // not producing → honest, contextual muted state
    if (r.isDaylight === false) return '<td class="ansg-num ansg-muted">Sleeping</td>';
    if (r.producedToday != null) return '<td class="ansg-num ansg-muted">' + ctx.esc(ctx.fmt.kwh(r.producedToday)) + ' today</td>';
    return '<td class="ansg-num ansg-faint">—</td>';
  }
  function cellExpected(r, ctx) {
    if (r.expected == null) return '<td class="ansg-num ansg-faint">—</td>';
    return '<td class="ansg-num ansg-val">' + ctx.esc(ctx.fmt.kwh(r.expected)) + '</td>';
  }
  // Plain-English "why isn't this modeled yet, and how long until it is" — shown as
  // a hover popup on the "not modeled yet" cell (Ford 2026-07-10). Reason-aware. There
  // is no hard min-day CONSTANT in the model; it cites the real 10-day comparison
  // window + a typical (not guaranteed) 3–4 days of production before the read is solid.
  function nomodelTip(r, ctx) {
    var reason = ctx.forecastSkipped && ctx.forecastSkipped[r.aid];
    if (reason === "no_nameplate")
      return "Add this site's capacity (nameplate kW) so the weather model can compute its expected output.";
    if (reason === "irradiance_unavailable")
      return "Weather data for this location isn't available yet — this usually resolves within a day.";
    // Has a location, but no measured daily production has accumulated yet.
    return "Weather-adjusted performance compares this site's measured production against the real sunlight that fell on it, over the last 10 days. "
      + "It needs a location on file plus a few days of measured daily production — usually 3–4 full days after it starts producing. "
      + "This site is producing now but hasn't logged full days yet, so it'll model automatically once that data loads.";
  }
  function cellRatio(r, ctx) {
    // HONESTY: no forecast row → never a bar, never a 0%
    if (!r.hasForecast || r.ratio == null) {
      // Skipped only for want of a location (inverter-onboarded arrays have no
      // utility address to geocode) → offer a one-click "set location" instead of
      // a dead "not modeled yet", so the operator can unblock the weather model.
      var reason = ctx.forecastSkipped && ctx.forecastSkipped[r.aid];
      if (reason === "no_location" && ctx.signedIn && ctx.setLocation) {
        return '<td class="ansg-ave"><button type="button" class="ansg-setloc" data-setloc="' + ctx.esc(r.aid) + '" title="No location on file — add a town or address so the weather model can run">＋ set location</button></td>';
      }
      return '<td class="ansg-ave"><span class="ansg-nomodel" title="' + ctx.esc(nomodelTip(r, ctx)) + '" tabindex="0">not modeled yet</span></td>';
    }
    var bucket = ratioBucket(r.ratio);
    var fillCls = bucket === "good" ? "" : bucket === "neutral" ? " neutral" : " bad";
    var width = Math.max(2, Math.min(120, r.ratio));    // clamp visual width to ~120%
    var pctCls = r.ratio > 115 ? "over" : bucket === "bad" ? "bad" : bucket === "neutral" ? "neutral" : "";
    // 100% reference tick sits at 100/120 of the track
    var tickLeft = (100 / 120 * 100).toFixed(1);
    return '<td class="ansg-ave"><div class="ansg-bar-row">' +
      '<div class="ansg-track" title="' + r.ratio + '% of weather-adjusted expected">' +
      '<div class="ansg-fill' + fillCls + '" style="width:' + (width / 120 * 100).toFixed(1) + '%"></div>' +
      '<div class="ansg-tick" style="left:' + tickLeft + '%"></div>' +
      '</div>' +
      '<span class="ansg-pct ' + pctCls + '">' + r.ratio + '%</span>' +
      '</div></td>';
  }
  function cellWindow(r, ctx) {
    if (r.win == null) return '<td class="ansg-num ansg-faint">—</td>';
    return '<td class="ansg-num ansg-val">' + ctx.esc(ctx.fmt.kwh(r.win)) + '</td>';
  }
  function cellCap(r, ctx) {
    if (r.cap == null) return '<td class="ansg-num ansg-faint">—</td>';
    return '<td class="ansg-num ansg-val">' + ctx.esc(ctx.fmt.kw(r.cap)) + '</td>';
  }

  // ---- main render ------------------------------------------------------------
  function render(container, ctx) {
    injectCSS();

    var cols = ctx.columns || [];
    var rows = cols.map(function (c) { return rowModel(c, ctx); });

    // search filter (by name), preserved across re-renders
    var q = searchText.trim().toLowerCase();
    var shown = q ? rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; }) : rows;
    shown = shown.slice().sort(function (a, b) { return compare(a, b, sortKey, sortDir); });

    // ---- footer totals (measured sums always; fleet % only if modeled) --------
    var totCap = 0, hasCap = false, totWin = 0, hasWin = false;
    rows.forEach(function (r) {
      if (r.cap != null) { totCap += r.cap; hasCap = true; }
      if (r.win != null) { totWin += r.win; hasWin = true; }
    });
    var fleetPct = (ctx.forecast && num(ctx.forecast.ratio_pct) != null) ? num(ctx.forecast.ratio_pct) : null;

    // ---- group-by segmented control (reuses the global .an-seg classes) -------
    var GROUP_OPTS = [
      { v: "none", label: "None" },
      { v: "portfolio", label: "Portfolio" },
      { v: "vendor", label: "Vendor" }
    ];
    var groupCtlHtml =
      '<div class="ansg-groupctl"><span>Group</span><div class="an-seg" role="tablist">' +
      GROUP_OPTS.map(function (o) {
        return '<button type="button" class="an-seg-btn' + (groupBy === o.v ? " on" : "") + '" data-group-by="' + o.v + '">' + ctx.esc(o.label) + '</button>';
      }).join("") +
      '</div></div>';

    // ---- secondary "then by" — only when a primary group is active. Offers
    // None + whichever of Portfolio/Vendor isn't already the primary. -----------
    if (groupBy === "none" || (groupBy2 !== "none" && groupBy2 === groupBy)) groupBy2 = "none";
    var thenByHtml = "";
    if (groupBy !== "none") {
      var secondary = groupBy === "portfolio" ? "vendor" : "portfolio";
      var THEN_OPTS = [
        { v: "none", label: "None" },
        { v: secondary, label: secondary.charAt(0).toUpperCase() + secondary.slice(1) }
      ];
      thenByHtml =
        '<div class="ansg-thenby"><span>then by</span><div class="an-seg" role="tablist">' +
        THEN_OPTS.map(function (o) {
          return '<button type="button" class="an-seg-btn' + (groupBy2 === o.v ? " on" : "") + '" data-then-by="' + o.v + '">' + ctx.esc(o.label) + '</button>';
        }).join("") +
        '</div></div>';
    }

    // ---- density segmented control (comfortable / compact) --------------------
    var DENS_OPTS = [
      { v: "comfortable", label: "Comfortable" },
      { v: "compact", label: "Compact" }
    ];
    var densCtlHtml =
      '<div class="ansg-groupctl"><span>Density</span><div class="an-seg" role="tablist">' +
      DENS_OPTS.map(function (o) {
        return '<button type="button" class="an-seg-btn' + (density === o.v ? " on" : "") + '" data-density="' + o.v + '">' + ctx.esc(o.label) + '</button>';
      }).join("") +
      '</div></div>';

    // honest sub-line: how many sites can't be weather-modeled yet
    var unmodeled = rows.filter(function (r) { return !r.hasForecast; }).length;
    var subline;
    if (!ctx.forecast) {
      subline = ctx.simulated
        ? "Measured performance across the demo fleet — connect a fleet to model expected vs actual."
        : "Measured performance — not modeled yet.";
    } else if (unmodeled > 0) {
      subline = rows.length + " sites · " + unmodeled + " not modeled yet";
    } else {
      subline = rows.length + " sites · all modeled";
    }

    // ---- header cells with sort affordance ------------------------------------
    var headHtml = COLS.map(function (c) {
      if (!c.sortable) return '<th class="' + (c.num ? "ansg-num " : "") + '">' + ctx.esc(c.label) + '</th>';
      var on = sortKey === c.key;
      var arrow = on ? (sortDir === "asc" ? "▲" : "▼") : "";
      return '<th class="ansg-sortable ' + (c.num ? "ansg-num " : "") + (c.cls ? c.cls + " " : "") + (on ? "ansg-on" : "") +
        '" data-sort="' + c.key + '">' + ctx.esc(c.label) + '<span class="ansg-arrow">' + arrow + '</span></th>';
    }).join("");

    // ---- body -----------------------------------------------------------------
    function siteRow(r) {
      return '<tr>' +
        cellStatus(r) + cellName(r, ctx) + cellTrend(r) + cellNow(r, ctx) +
        cellWeather(r, ctx) + cellExpected(r, ctx) + cellRatio(r, ctx) + cellWindow(r, ctx) + cellCap(r, ctx) +
        '</tr>';
    }
    // a group header row spanning the table, with rollup metrics
    function groupHeaderRow(label, isUnassigned, roll, collapsed) {
      var pctHtml;
      if (roll.pct != null) {
        var bucket = ratioBucket(roll.pct);
        var pc = roll.pct > 115 ? "over" : bucket === "bad" ? "bad" : bucket === "neutral" ? "neutral" : "";
        pctHtml = '<span class="ansg-gpct ' + pc + '">' + roll.pct + '%</span>';
      } else {
        pctHtml = '<span class="ansg-faint">—</span>';
      }
      var alarmCls = roll.alarms > 0 ? (roll.alarms >= 3 ? "bad" : "warn") : "";
      var alarmHtml = '<span class="ansg-galarm ' + alarmCls + '" title="Open alarms in this group">● ' + roll.alarms + '</span>';
      return '<tr class="ansg-grouphead' + (collapsed ? " ansg-collapsed" : "") + '" data-group="' + ctx.esc(label) + '">' +
        '<td colspan="' + COLS.length + '">' +
        '<div class="ansg-ghd">' +
        chevronSvg() +
        '<span class="ansg-gname' + (isUnassigned ? " ansg-unassigned" : "") + '">' + ctx.esc(label) + '</span>' +
        '<span class="ansg-gcount">' + roll.count + ' site' + (roll.count === 1 ? "" : "s") + '</span>' +
        '<span class="ansg-groll">' +
        '<span class="ansg-gm"><i>cap</i><b>' + (roll.hasCap ? ctx.esc(ctx.fmt.kw(roll.cap)) : "—") + '</b></span>' +
        '<span class="ansg-gm"><i>window</i><b>' + (roll.hasWin ? ctx.esc(ctx.fmt.kwh(roll.win)) : "—") + '</b></span>' +
        '<span class="ansg-gm"><i>vs exp</i>' + pctHtml + '</span>' +
        '<span class="ansg-gm"><i>alarms</i>' + alarmHtml + '</span>' +
        '</span>' +
        '</div>' +
        '</td></tr>';
    }

    // a lighter secondary sub-group header (mini rollup: count + capacity only)
    function subGroupHeaderRow(label, isUnassigned, roll) {
      return '<tr class="ansg-subhead">' +
        '<td colspan="' + COLS.length + '">' +
        '<div class="ansg-shd">' +
        '<span class="ansg-sname' + (isUnassigned ? " ansg-unassigned" : "") + '">' + ctx.esc(label) + '</span>' +
        '<span class="ansg-scount">' + roll.count + ' site' + (roll.count === 1 ? "" : "s") + '</span>' +
        '<span class="ansg-sroll">' +
        '<span class="ansg-gm"><i>cap</i><b>' + (roll.hasCap ? ctx.esc(ctx.fmt.kw(roll.cap)) : "—") + '</b></span>' +
        '</span>' +
        '</div>' +
        '</td></tr>';
    }
    // partition a set of rows by a mode into ordered { key,label,last,rows } buckets
    function partition(rs, mode) {
      var ord = [], bks = {};
      rs.forEach(function (r) {
        var g = groupKeyFor(r, mode);
        if (!bks[g.key]) { bks[g.key] = { label: g.label, last: g.last, rows: [] }; ord.push(g.key); }
        bks[g.key].rows.push(r);
      });
      ord.sort(function (ka, kb) {
        var a = bks[ka], b = bks[kb];
        if (a.last !== b.last) return a.last ? 1 : -1;
        return a.label.localeCompare(b.label);
      });
      return ord.map(function (k) { return bks[k]; });
    }

    var bodyHtml;
    if (!shown.length) {
      var msg = q ? 'No sites match "' + ctx.esc(searchText) + '".' : "No sites in this fleet yet.";
      bodyHtml = '<tr><td class="ansg-empty" colspan="' + COLS.length + '">' + msg + '</td></tr>';
    } else if (groupBy === "none") {
      bodyHtml = shown.map(siteRow).join("");
    } else {
      // partition the already-filtered+sorted rows into groups, preserving the
      // per-group sort. Order groups: "last" buckets (Unassigned/Other) sink,
      // the rest alphabetically. When a secondary "then by" is active, each
      // primary group nests sub-group headers before its rows.
      var useSecondary = groupBy2 !== "none";
      var collapsedSet = collapsedSetFor(groupBy);
      bodyHtml = partition(shown, groupBy).map(function (g) {
        var roll = groupRollup(g.rows, ctx);
        var collapsed = !!collapsedSet[g.label];
        var head = groupHeaderRow(g.label, g.last && g.label === UNASSIGNED, roll, collapsed);
        if (collapsed) return head;
        var body;
        if (useSecondary) {
          body = partition(g.rows, groupBy2).map(function (sg) {
            var sroll = groupRollup(sg.rows, ctx);
            return subGroupHeaderRow(sg.label, sg.last && sg.label === UNASSIGNED, sroll) +
              sg.rows.map(siteRow).join("");
          }).join("");
        } else {
          body = g.rows.map(siteRow).join("");
        }
        return head + body;
      }).join("");
    }

    // ---- footer ---------------------------------------------------------------
    var footHtml = "";
    if (shown.length) {
      footHtml =
        '<tfoot><tr>' +
        '<td class="ansg-dotcell"></td>' +
        '<td class="ansg-tlabel">' + rows.length + ' site' + (rows.length === 1 ? "" : "s") + '</td>' +
        '<td></td>' +
        '<td class="ansg-num"></td>' +
        '<td class="ansg-wxcell"></td>' +
        '<td class="ansg-num"></td>' +
        '<td class="ansg-ave">' + (fleetPct != null
          ? '<span class="ansg-pct ' + (fleetPct > 115 ? "over" : ratioBucket(fleetPct) === "bad" ? "bad" : ratioBucket(fleetPct) === "neutral" ? "neutral" : "") + '">' + fleetPct + '%</span> <span class="ansg-faint" style="font-weight:600">fleet</span>'
          : '<span class="ansg-nomodel">—</span>') + '</td>' +
        '<td class="ansg-num">' + (hasWin ? ctx.esc(ctx.fmt.kwh(totWin)) : "—") + '</td>' +
        '<td class="ansg-num">' + (hasCap ? ctx.esc(ctx.fmt.kw(totCap)) : "—") + '</td>' +
        '</tr></tfoot>';
    }

    // ---- assemble (idempotent: full innerHTML rebuild every call) -------------
    container.innerHTML =
      '<div class="an-card">' +
      '  <div class="an-card-head">' +
      '    <h3>Sites</h3>' +
      '    <span class="an-card-sub">' + ctx.esc(subline) + '</span>' +
      '  </div>' +
      '  <div style="padding:12px 14px 4px">' +
      '    <div class="ansg-bar">' +
      '      <div class="ansg-search">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '        <input type="text" class="ansg-q" placeholder="Filter sites…" value="' + ctx.esc(searchText) + '" />' +
      '      </div>' +
      '      <div class="ansg-tools">' +
      groupCtlHtml +
      thenByHtml +
      densCtlHtml +
      '        <span class="ansg-count">' + shown.length + (q ? " of " + rows.length : "") + ' shown</span>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="ansg-wrap' + (density === "compact" ? " ansg-compact" : "") + '">' +
      '    <table class="ansg-table">' +
      '      <thead><tr>' + headHtml + '</tr></thead>' +
      '      <tbody>' + bodyHtml + '</tbody>' +
      footHtml +
      '    </table>' +
      '  </div>' +
      '</div>';

    // ---- (re)attach handlers via delegation on the container ------------------
    // header click → toggle sort. Default dir per column: ratio asc (worst first),
    // name asc, everything else desc (biggest first feels natural for kW/kWh).
    var head = container.querySelector("thead");
    if (head) {
      head.addEventListener("click", function (e) {
        var th = e.target.closest("th[data-sort]");
        if (!th) return;
        var key = th.getAttribute("data-sort");
        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = (key === "ratio" || key === "name" || key === "status") ? "asc" : "desc";
        }
        render(container, ctx);
      });
    }

    // search input → live filter, preserving caret + focus across the rebuild
    var input = container.querySelector(".ansg-q");
    if (input) {
      input.addEventListener("input", function () {
        searchText = input.value;
        var pos = input.selectionStart;
        render(container, ctx);
        var ni = container.querySelector(".ansg-q");
        if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (_) { } }
      });
    }

    // toolbar segmented controls (group-by / then-by / density) → one delegated
    // listener so every .ansg-groupctl wrapper is covered, not just the first.
    var tools = container.querySelector(".ansg-tools");
    if (tools) {
      tools.addEventListener("click", function (e) {
        var gb = e.target.closest("[data-group-by]");
        if (gb) {
          var gv = gb.getAttribute("data-group-by");
          if (gv !== groupBy) { groupBy = gv; render(container, ctx); }
          return;
        }
        var tb = e.target.closest("[data-then-by]");
        if (tb) {
          var tv = tb.getAttribute("data-then-by");
          if (tv !== groupBy2) { groupBy2 = tv; render(container, ctx); }
          return;
        }
        var db = e.target.closest("[data-density]");
        if (db) {
          var dv = db.getAttribute("data-density");
          if (dv !== density) { density = dv; render(container, ctx); }
          return;
        }
      });
    }

    // group header row → toggle collapse for that group (per-mode state)
    var body = container.querySelector("tbody");
    if (body) {
      body.addEventListener("click", function (e) {
        var gh = e.target.closest(".ansg-grouphead");
        if (!gh) return;
        var key = gh.getAttribute("data-group");
        var set = collapsedSetFor(groupBy);
        if (set[key]) delete set[key]; else set[key] = true;
        render(container, ctx);
      });
    }

    // assign-to-portfolio buttons → prompt + persist via the live mutator.
    // The FleetStore mutation re-renders the orchestrator, so no manual repaint.
    if (ctx.signedIn && ctx.live && ctx.live.setArrayPortfolio) {
      container.querySelectorAll(".ansg-assign").forEach(function (btn) {
        btn.addEventListener("click", async function (e) {
          e.stopPropagation();   // don't bubble into a group-header collapse
          var aid = btn.getAttribute("data-assign");
          var current = "";
          for (var i = 0; i < rows.length; i++) { if (rows[i].aid === aid) { current = rows[i].portfolio || ""; break; } }
          var next = await AODialog.prompt("Leave blank to clear.", current, { title: "Portfolio for this site" });
          if (next == null) return;                 // cancelled
          next = String(next).trim();
          if (next === current) return;             // no change
          try { ctx.live.setArrayPortfolio(aid, next); } catch (_) { }
        });
      });
    }

    // reminders / O&M note → prompt (prefill current) + persist via the live
    // mutator. Blank clears. FleetStore mutation re-renders the orchestrator.
    if (ctx.signedIn && ctx.live && ctx.live.setArrayReminder) {
      container.querySelectorAll("[data-reminder]").forEach(function (el) {
        el.addEventListener("click", async function (e) {
          e.stopPropagation();   // don't bubble into a group-header collapse
          var aid = el.getAttribute("data-reminder");
          var current = "";
          for (var i = 0; i < rows.length; i++) { if (rows[i].aid === aid) { current = rows[i].reminder || ""; break; } }
          var next = await AODialog.prompt("Leave blank to clear.", current, { title: "O&M note for this site" });
          if (next == null) return;                 // cancelled
          next = String(next).trim();
          if (next === current) return;             // no change
          try { ctx.live.setArrayReminder(aid, next); } catch (_) { }
        });
      });
    }

    // "set location" on arrays skipped as no_location → prompt for a town/address,
    // geocode + persist via the orchestrator, which reloads the forecast so the
    // row starts modeling. Defaults the prompt to the site's own name.
    if (ctx.signedIn && ctx.setLocation) {
      container.querySelectorAll("[data-setloc]").forEach(function (btn) {
        btn.addEventListener("click", async function (e) {
          e.stopPropagation();
          var aid = btn.getAttribute("data-setloc");
          var name = "";
          for (var i = 0; i < rows.length; i++) { if (rows[i].aid === aid) { name = rows[i].name || ""; break; } }
          var place = await AODialog.prompt(
            "Enter a town or address so the weather model can run — e.g. “Londonderry, VT”.",
            name, { title: "Where is “" + name + "”?" }
          );
          if (place == null) return;                  // cancelled
          place = String(place).trim();
          if (!place) return;
          var prev = btn.textContent;
          btn.textContent = "locating…"; btn.disabled = true;
          ctx.setLocation(aid, { place: place }).catch(function (err) {
            btn.textContent = prev; btn.disabled = false;
            AODialog.alert(err && err.message ? err.message : "Try a nearby town or a full address.", { title: "Couldn't find that location" });
          });
          // success path: the orchestrator reloads the forecast and re-renders.
        });
      });
    }
  }

  // ---- register ---------------------------------------------------------------
  window.AnalysisSections.push({ id: "sites-grid", title: "Sites", order: 20, render: render });
})();
