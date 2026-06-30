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
      ".ansg-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px;min-width:880px}",
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
      // footer totals
      ".ansg-table tfoot td{border-top:2px solid var(--line);border-bottom:0;font-weight:700;color:var(--ink);background:var(--card2);padding-top:11px;padding-bottom:11px}",
      ".ansg-table tfoot .ansg-tlabel{color:var(--muted);font-weight:740;font-size:11px;letter-spacing:.05em;text-transform:uppercase}",
      ".ansg-empty{padding:30px 18px;text-align:center;color:var(--muted);font-size:13px}"
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
    var expected = fc ? num(fc.expected_kwh) : null;

    // region only if it's a real value (real columns carry "—"); look up canonical
    var region = null;
    if (Array.isArray(ctx.arrays)) {
      var a = null;
      for (var i = 0; i < ctx.arrays.length; i++) { if (String(ctx.arrays[i].id) === aid) { a = ctx.arrays[i]; break; } }
      if (a && a.region && a.region !== "—") region = a.region;
    }

    return {
      col: col,
      aid: aid,
      name: col.array_name || "Site",
      vendor: vendorTag(col.vendor),
      region: region,
      level: (col.alert && col.alert.level) || "ok",
      alertCount: (col.alert && num(col.alert.count)) || 0,
      series: seriesFor(col),
      powerW: num(col.current_power_w),
      producedToday: num(col.produced_today_kwh),
      isDaylight: col.is_daylight !== false,
      expected: expected,
      ratio: ratio,
      hasForecast: !!fc,
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
    return '<td><div class="ansg-name-row"><span class="ansg-name" title="' + ctx.esc(r.name) + '">' + ctx.esc(r.name) + '</span>' + tag + '</div>' + region + '</td>';
  }
  function cellTrend(r) {
    return '<td>' + sparkline(r.series) + '</td>';
  }
  function cellNow(r, ctx) {
    var kw = ctx.fmt.kwFromW(r.powerW);
    if (kw != null && kw >= 0.05) {
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
  function cellRatio(r, ctx) {
    // HONESTY: no forecast row → never a bar, never a 0%
    if (!r.hasForecast || r.ratio == null) {
      return '<td class="ansg-ave"><span class="ansg-nomodel">not modeled yet</span></td>';
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

    // honest sub-line: how many sites can't be weather-modeled yet
    var unmodeled = rows.filter(function (r) { return !r.hasForecast; }).length;
    var subline;
    if (!ctx.forecast) {
      subline = ctx.simulated
        ? "Measured performance across the demo fleet — connect a fleet to add weather-adjusted expected vs actual."
        : "Measured performance — weather model loading.";
    } else if (unmodeled > 0) {
      subline = rows.length + " sites · " + unmodeled + " not yet weather-modeled";
    } else {
      subline = rows.length + " sites · all weather-modeled";
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
    var bodyHtml;
    if (!shown.length) {
      var msg = q ? 'No sites match "' + ctx.esc(searchText) + '".' : "No sites in this fleet yet.";
      bodyHtml = '<tr><td class="ansg-empty" colspan="' + COLS.length + '">' + msg + '</td></tr>';
    } else {
      bodyHtml = shown.map(function (r) {
        return '<tr>' +
          cellStatus(r) + cellName(r, ctx) + cellTrend(r) + cellNow(r, ctx) +
          cellExpected(r, ctx) + cellRatio(r, ctx) + cellWindow(r, ctx) + cellCap(r, ctx) +
          '</tr>';
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
      '      <span class="ansg-count">' + shown.length + (q ? " of " + rows.length : "") + ' shown</span>' +
      '    </div>' +
      '  </div>' +
      '  <div class="ansg-wrap">' +
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
  }

  // ---- register ---------------------------------------------------------------
  window.AnalysisSections.push({ id: "sites-grid", title: "Sites", order: 20, render: render });
})();
