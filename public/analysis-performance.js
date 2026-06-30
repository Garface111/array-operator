/* ============================================================================
 * Array Operator — Analysis tab · Performance panel  (analysis-performance.js)
 *
 * PowerTrack-style "Performance Index ↔ Capacity Factor" panel. Self-contained
 * section module: registers on window.AnalysisSections, owns its own scoped
 * <style id="anperf-css">, renders into the .an-card frame the rest of the tab
 * uses. Two modes via the shared .an-seg segmented toggle:
 *
 *   • Performance Index — the weather-adjusted performance ratio
 *     (ctx.forecast.performance_ratio_measured, e.g. 0.84). REQUIRES the forecast;
 *     honest empty state when ctx.forecast is null. Never a fabricated PR.
 *   • Capacity Factor — measured output ÷ nameplate capacity, computed straight
 *     from measured window_kwh. Works WITHOUT a forecast (demo mode too). Solar CF
 *     is INHERENTLY ~15% — we never paint a normal CF as a fault.
 *
 * Honesty (hard rule): PI shows nothing rather than guess; CF is labelled
 * "measured"; tilt assumptions surfaced are labelled "assumed".
 * ========================================================================== */
(function () {
  "use strict";

  window.AnalysisSections = window.AnalysisSections || [];

  // module-level so re-renders (live updates) keep the user's toggle choice
  var MODE = "PI"; // "PI" | "CF"

  // PI thresholds (performance ratio): ≥.92 good (blue), <.82 bad (red), else neutral
  var PI_GOOD = 0.92, PI_BAD = 0.82;

  // ---- one-time scoped CSS ----------------------------------------------------
  function injectCss() {
    if (document.getElementById("anperf-css")) return;
    var s = document.createElement("style");
    s.id = "anperf-css";
    s.textContent = [
      ".anperf-body{padding:18px 18px 20px;}",

      /* headline */
      ".anperf-headline{display:flex;align-items:flex-start;gap:22px;flex-wrap:wrap;}",
      ".anperf-big{min-width:0;}",
      ".anperf-num{font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;}",
      ".anperf-num .anperf-unit{font-size:20px;font-weight:700;color:var(--muted);margin-left:7px;letter-spacing:0;}",
      ".anperf-alt{font-size:14px;font-weight:640;color:var(--good2);margin-top:7px;font-variant-numeric:tabular-nums;}",
      ".anperf-cap{font-size:12.5px;color:var(--muted);margin-top:9px;max-width:54ch;line-height:1.5;}",

      /* confidence + meta chips */
      ".anperf-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px;}",
      ".anperf-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:640;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--bg2);}",
      ".anperf-chip b{font-weight:720;color:var(--ink);}",
      ".anperf-chip.conf-high{color:var(--good);border-color:rgba(37,99,235,.32);background:rgba(37,99,235,.08);}",
      ".anperf-chip.conf-medium{color:var(--warn);border-color:rgba(217,119,6,.30);background:rgba(217,119,6,.08);}",
      ".anperf-chip.conf-low,.anperf-chip.conf-none{color:var(--faint);}",
      ".anperf-cdot{width:6px;height:6px;border-radius:50%;background:currentColor;}",

      /* gauge dial accent next to headline */
      ".anperf-dial{flex:0 0 auto;width:96px;height:96px;position:relative;}",
      ".anperf-dial svg{display:block;transform:rotate(-90deg);}",
      ".anperf-dial-mid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:740;color:var(--ink);font-variant-numeric:tabular-nums;}",

      /* empty state (PI with no forecast) */
      ".anperf-empty{display:flex;gap:13px;align-items:flex-start;padding:6px 0 4px;}",
      ".anperf-empty-ic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--bg2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--faint);}",
      ".anperf-empty-tx{min-width:0;}",
      ".anperf-empty-tx b{display:block;font-size:14px;font-weight:700;color:var(--ink);margin-bottom:3px;}",
      ".anperf-empty-tx span{font-size:12.5px;color:var(--muted);line-height:1.5;}",

      /* per-array breakdown */
      ".anperf-list{margin-top:20px;border-top:1px solid var(--line);padding-top:6px;}",
      ".anperf-list-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:10px 2px 8px;}",
      ".anperf-list-h .lab{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);}",
      ".anperf-list-h .hint{font-size:11.5px;color:var(--faint);}",
      ".anperf-row{display:grid;grid-template-columns:minmax(0,1fr) 150px 56px;align-items:center;gap:12px;padding:8px 2px;border-top:1px solid var(--line);}",
      ".anperf-row:first-child{border-top:0;}",
      ".anperf-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:620;color:var(--ink);}",
      ".anperf-name i{font-style:normal;color:var(--faint);font-weight:500;font-size:11.5px;margin-left:6px;}",
      ".anperf-bar{height:9px;border-radius:6px;background:var(--bg2);overflow:hidden;position:relative;}",
      ".anperf-bar > b{display:block;height:100%;border-radius:6px;background:var(--good);transition:width .4s ease;}",
      ".anperf-bar.lo > b{background:var(--bad);}",
      ".anperf-bar.mid > b{background:var(--warn);}",
      ".anperf-bar.cf > b{background:var(--good2);}",       /* CF: single calm brand series, never 'fault' colored */
      ".anperf-val{text-align:right;font-size:13px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;}",
      ".anperf-val.dim{color:var(--faint);font-weight:600;}",
      ".anperf-muted-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;border-top:1px solid var(--line);font-size:12px;color:var(--faint);}",
      ".anperf-muted-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".anperf-foot{font-size:11.5px;color:var(--faint);margin-top:12px;line-height:1.5;max-width:74ch;}",

      "@media (max-width:680px){",
      ".anperf-row{grid-template-columns:minmax(0,1fr) 84px 48px;gap:9px;}",
      ".anperf-num{font-size:38px;}",
      ".anperf-dial{width:78px;height:78px;}",
      "}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- helpers ----------------------------------------------------------------
  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  // total nameplate kW across the fleet (sum of every inverter)
  function fleetNameplateKw(arrays) {
    var t = 0;
    (arrays || []).forEach(function (a) {
      (a.inverters || []).forEach(function (inv) { var n = num(inv.nameplate_kw); if (n) t += n; });
    });
    return t;
  }
  // sum measured window kWh across one array's inverters (null if none reported)
  function arrayWindowKwh(a) {
    var sum = 0, any = false;
    (a.inverters || []).forEach(function (inv) { var k = num(inv.window_kwh); if (k != null) { sum += k; any = true; } });
    return any ? sum : null;
  }
  function arrayNameplateKw(a) {
    var t = 0;
    (a.inverters || []).forEach(function (inv) { var n = num(inv.nameplate_kw); if (n) t += n; });
    return t;
  }
  // measured capacity factor % for a nameplate/kWh/window  → kWh ÷ (kW × days × 24h)
  function capacityFactorPct(kwh, nameplateKw, windowDays) {
    if (kwh == null || !nameplateKw || !windowDays) return null;
    var denom = nameplateKw * windowDays * 24;
    if (denom <= 0) return null;
    return (kwh / denom) * 100;
  }

  function piBarClass(pr) {
    if (pr == null) return "";
    if (pr >= PI_GOOD) return "";        // default = good (blue)
    if (pr < PI_BAD) return "lo";        // red
    return "mid";                        // amber
  }

  // a small SVG ring dial (0..1 fill) used for the PI headline
  function dialSvg(frac, colorVar) {
    var f = Math.max(0, Math.min(1, frac));
    var r = 40, c = 2 * Math.PI * r, off = c * (1 - f);
    return '<svg width="96" height="96" viewBox="0 0 96 96">' +
      '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(--bg2)" stroke-width="9"/>' +
      '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(' + colorVar + ')" stroke-width="9" ' +
      'stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>' +
      '</svg>';
  }

  // ---- headline builders ------------------------------------------------------
  function headlinePI(ctx) {
    var fc = ctx.forecast;
    var esc = ctx.esc, fmt = ctx.fmt;
    var win = (fc && fc.window && fc.window.days) || ctx.windowDays || 14;

    // honest empty state — PI has no meaning without the weather model
    if (!fc || !fc.available) {
      return '<div class="anperf-empty">' +
        '<div class="anperf-empty-ic">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>' +
        '</div>' +
        '<div class="anperf-empty-tx">' +
        '<b>Performance Index needs your weather-modeled data</b>' +
        '<span>' + (ctx.simulated
          ? 'The live demo fleet has no weather model. Sign in with real arrays to see how production compares against weather-expected output.'
          : 'Available once production has loaded for a few days — we compare measured output against the weather-expected output for each site.') +
        '</span></div></div>';
    }

    var pr = num(fc.performance_ratio_measured);     // e.g. 0.84
    var pct = num(fc.ratio_pct);                     // e.g. 84
    if (pr == null && pct != null) pr = pct / 100;   // derive if only the % is present
    if (pr == null) {
      // forecast present but no matched-day PR yet — be honest, don't invent
      return '<div class="anperf-empty">' +
        '<div class="anperf-empty-ic">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>' +
        '</div><div class="anperf-empty-tx">' +
        '<b>Not enough matched days yet</b>' +
        '<span>We have the weather model but not enough measured production days to compute a performance index. Check back as more days load.</span>' +
        '</div></div>';
    }

    var conf = (fc.confidence || "none");
    var prColor = pr >= PI_GOOD ? "--good" : (pr < PI_BAD ? "--bad" : "--warn");
    var pctTxt = pct != null ? (pct + "% of expected") : (Math.round(pr * 100) + "% of expected");

    var modeled = num(fc.arrays_modeled), skipped = num(fc.arrays_skipped);

    return '<div class="anperf-headline">' +
      '<div class="anperf-dial">' + dialSvg(pr, prColor) +
      '<div class="anperf-dial-mid">' + (Math.round(pr * 100)) + '%</div></div>' +
      '<div class="anperf-big">' +
      '<div class="anperf-num">' + pr.toFixed(2) + '<span class="anperf-unit">PI</span></div>' +
      '<div class="anperf-alt">' + esc(pctTxt) + '</div>' +
      '<div class="anperf-cap">Measured production ÷ weather-expected production, last ' + win + ' days. A PI near 1.00 means the fleet is producing about what the weather should yield.</div>' +
      '<div class="anperf-chips">' +
      '<span class="anperf-chip conf-' + esc(conf) + '"><span class="anperf-cdot"></span>' + esc(conf) + ' confidence</span>' +
      (modeled != null ? '<span class="anperf-chip"><b>' + modeled + '</b> modeled</span>' : '') +
      (skipped ? '<span class="anperf-chip">' + skipped + ' not modeled</span>' : '') +
      '</div></div></div>';
  }

  function headlineCF(ctx) {
    var esc = ctx.esc;
    var win = ctx.windowDays || 14;

    // fleet CF straight from measured data — works in demo too. Sum only arrays
    // that actually reported window_kwh so the denominator matches the numerator.
    var totKwh = 0, totNameplate = 0, anyKwh = false, reportingArrays = 0;
    (ctx.arrays || []).forEach(function (a) {
      var k = arrayWindowKwh(a);
      if (k == null) return;                 // no measured kWh → exclude both sides
      var np = arrayNameplateKw(a);
      if (!np) return;                       // no nameplate → can't form a CF
      totKwh += k; totNameplate += np; anyKwh = true; reportingArrays++;
    });

    if (!anyKwh || !totNameplate) {
      return '<div class="anperf-empty">' +
        '<div class="anperf-empty-ic">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18M7 14l4-4 3 3 5-6"/></svg>' +
        '</div><div class="anperf-empty-tx">' +
        '<b>No measured production yet</b>' +
        '<span>Capacity factor is computed from measured output over the last ' + win + ' days. It will appear once your inverters report energy.</span>' +
        '</div></div>';
    }

    var cf = capacityFactorPct(totKwh, totNameplate, win);
    var cfColor = "--good2"; // CF is a neutral fact, NOT a pass/fail — single calm series

    return '<div class="anperf-headline">' +
      '<div class="anperf-dial">' + dialSvg((cf || 0) / 100, cfColor) +
      '<div class="anperf-dial-mid">' + (cf != null ? cf.toFixed(0) + "%" : "—") + '</div></div>' +
      '<div class="anperf-big">' +
      '<div class="anperf-num">' + (cf != null ? cf.toFixed(1) : "—") + '<span class="anperf-unit">% CF</span></div>' +
      '<div class="anperf-alt">measured · ' + reportingArrays + ' array' + (reportingArrays === 1 ? '' : 's') + ' · ' + Math.round(totNameplate) + ' kW nameplate</div>' +
      '<div class="anperf-cap">Average output as a share of nameplate capacity, last ' + win + ' days. For solar, a ~13–18% capacity factor is normal and healthy — this measures sunlight available, not whether the system is performing.</div>' +
      '<div class="anperf-chips">' +
      '<span class="anperf-chip"><b>' + Math.round(totKwh).toLocaleString() + '</b> kWh measured</span>' +
      '<span class="anperf-chip">last ' + win + ' days</span>' +
      '</div></div></div>';
  }

  // ---- per-array breakdown ----------------------------------------------------
  function breakdownPI(ctx) {
    var esc = ctx.esc;
    var rows = [], unmodeled = [];

    (ctx.arrays || []).forEach(function (a) {
      var fr = ctx.forecastByArray && ctx.forecastByArray[String(a.id)];
      var pct = fr ? num(fr.ratio_pct) : null;
      if (fr && pct != null) {
        rows.push({ id: a.id, name: a.name || ("Array " + a.id), vendor: a.vendor, pct: pct, pr: pct / 100, days: num(fr.measured_days), tilt: !!(fr && fr.tilt_assumed) });
      } else {
        unmodeled.push({ id: a.id, name: a.name || ("Array " + a.id) });
      }
    });

    if (!rows.length && !unmodeled.length) return "";
    rows.sort(function (x, y) { return x.pct - y.pct; }); // worst → best

    var html = '<div class="anperf-list">' +
      '<div class="anperf-list-h"><span class="lab">Per array · worst first</span><span class="hint">% of weather-expected</span></div>';

    rows.forEach(function (r) {
      var cls = piBarClass(r.pr);
      var w = Math.max(2, Math.min(100, r.pct)); // bar caps at 100% width even if over-performing
      html += '<div class="anperf-row">' +
        '<div class="anperf-name">' + esc(r.name) +
        (r.tilt ? '<i>tilt assumed</i>' : (r.days != null ? '<i>' + r.days + 'd</i>' : '')) +
        '</div>' +
        '<div class="anperf-bar ' + cls + '"><b style="width:' + w.toFixed(0) + '%"></b></div>' +
        '<div class="anperf-val">' + Math.round(r.pct) + '%</div>' +
        '</div>';
    });

    unmodeled.forEach(function (u) {
      html += '<div class="anperf-muted-row"><span class="nm">' + esc(u.name) + '</span><span>not modeled yet</span></div>';
    });

    if (rows.some(function (r) { return r.tilt; })) {
      html += '<div class="anperf-foot">"tilt assumed" = panel angle inferred from latitude (south-facing) because no exact tilt/azimuth is set; the index for those sites is approximate.</div>';
    }
    return html + '</div>';
  }

  function breakdownCF(ctx) {
    var esc = ctx.esc;
    var rows = [];
    (ctx.arrays || []).forEach(function (a) {
      var kwh = arrayWindowKwh(a);
      var np = arrayNameplateKw(a);
      var cf = capacityFactorPct(kwh, np, ctx.windowDays || 14);
      if (cf != null) rows.push({ name: a.name || ("Array " + a.id), vendor: a.vendor, cf: cf, np: np });
    });
    if (!rows.length) return "";
    rows.sort(function (x, y) { return x.cf - y.cf; }); // worst → best (lowest sunlight harvest first)

    // scale bars relative to the busiest array so differences read, but DON'T
    // color a low CF as a fault — solar CF is inherently ~15%. Single calm series.
    var maxCf = rows.reduce(function (m, r) { return Math.max(m, r.cf); }, 0) || 1;

    var html = '<div class="anperf-list">' +
      '<div class="anperf-list-h"><span class="lab">Per array · lowest harvest first</span><span class="hint">measured capacity factor</span></div>';
    rows.forEach(function (r) {
      var w = Math.max(2, Math.min(100, (r.cf / maxCf) * 100));
      html += '<div class="anperf-row">' +
        '<div class="anperf-name">' + esc(r.name) + '<i>' + Math.round(r.np) + ' kW</i></div>' +
        '<div class="anperf-bar cf"><b style="width:' + w.toFixed(0) + '%"></b></div>' +
        '<div class="anperf-val">' + r.cf.toFixed(1) + '%</div>' +
        '</div>';
    });
    html += '<div class="anperf-foot">Capacity factor reflects how much sunlight each site captured relative to its nameplate — bars are scaled to the highest in the fleet for comparison, not to a pass/fail line. A lower CF is usually shade, orientation, or season, not a fault.</div>';
    return html + '</div>';
  }

  // ---- render (idempotent — rebuilds container.innerHTML every call) ----------
  function render(container, ctx) {
    injectCss();

    var headline = MODE === "PI" ? headlinePI(ctx) : headlineCF(ctx);
    var breakdown = MODE === "PI" ? breakdownPI(ctx) : breakdownCF(ctx);

    container.innerHTML =
      '<div class="an-card">' +
      '  <div class="an-card-head">' +
      '    <div><h3>Performance</h3>' +
      '    <div class="an-card-sub">' + (MODE === "PI"
            ? 'Weather-adjusted production vs. expected'
            : 'Output as a share of nameplate capacity') + '</div></div>' +
      '    <div class="an-seg" role="tablist">' +
      '      <button type="button" class="an-seg-btn' + (MODE === "PI" ? " on" : "") + '" data-mode="PI">Performance Index</button>' +
      '      <button type="button" class="an-seg-btn' + (MODE === "CF" ? " on" : "") + '" data-mode="CF">Capacity Factor</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="anperf-body">' + headline + breakdown + '</div>' +
      '</div>';

    // re-attach toggle handlers each render
    var btns = container.querySelectorAll(".an-seg-btn");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () {
        var m = b.getAttribute("data-mode");
        if (m && m !== MODE) { MODE = m; render(container, ctx); } // persists in module-level MODE
      });
    });
  }

  window.AnalysisSections.push({ id: "performance", title: "Performance", order: 30, render: render });
})();
