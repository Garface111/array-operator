/* ============================================================================
 * Array Operator — Analysis tab · Portfolio rollup KPI strip
 * (analysis-fleet-summary.js)  [SECTION MODULE — id:"fleet-summary"]
 *
 * The top-of-page fleet header: PowerTrack's portfolio header + footer totals
 * condensed into one clean KPI row. Reads ONLY ctx (built by analysis.js) — it
 * fetches nothing and mutates nothing. Idempotent: rebuilds container.innerHTML
 * on every call (first show + every live FleetStore/forecast update).
 *
 * Honesty (Ford's hard rule): weather/performance KPIs read "—" when
 * ctx.forecast is null (demo/anon or before it loads) — NEVER fabricated. The
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
      ".ansum-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px;}",
      ".ansum-card{position:relative;background:linear-gradient(168deg,var(--card),var(--card2));",
      "  border:1px solid var(--line);border-radius:16px;padding:14px 16px 13px;min-width:0;overflow:hidden;}",
      // a hairline accent rail on the left edge, tinted by health
      ".ansum-card::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;",
      "  background:var(--good2);opacity:.55;}",
      ".ansum-card.warn::before{background:var(--warn);opacity:.85;}",
      ".ansum-card.bad::before{background:var(--bad);opacity:.9;}",
      ".ansum-card.muted::before{background:var(--faint);opacity:.4;}",
      ".ansum-lbl{font-size:10.5px;font-weight:680;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);}",
      ".ansum-val{font-size:25px;font-weight:760;line-height:1.05;letter-spacing:-.015em;color:var(--ink);",
      "  margin-top:6px;font-variant-numeric:tabular-nums;white-space:nowrap;}",
      ".ansum-val .ansum-unit{font-size:14px;font-weight:640;color:var(--muted);margin-left:2px;letter-spacing:0;}",
      ".ansum-val.good{color:var(--good);}",
      ".ansum-val.warn{color:var(--warn);}",
      ".ansum-val.bad{color:var(--bad);}",
      ".ansum-val.muted{color:var(--faint);}",
      ".ansum-sub{font-size:11.5px;color:var(--muted);margin-top:5px;font-variant-numeric:tabular-nums;",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".ansum-sub.warn{color:var(--warn);}",
      ".ansum-sub.bad{color:var(--bad);}",
      // spotlight caption below the strip
      ".ansum-spot{margin-top:13px;display:flex;align-items:flex-start;gap:8px;padding:11px 14px;",
      "  background:var(--bg2);border:1px solid var(--line);border-radius:12px;",
      "  font-size:12.5px;color:var(--muted);line-height:1.5;}",
      ".ansum-spot-ic{color:var(--warn);font-size:14px;line-height:1.25;flex:0 0 auto;}",
      ".ansum-spot b{color:var(--ink);font-weight:680;}",
      ".ansum-spot b.good{color:var(--good);}",
      ".ansum-spot b.bad{color:var(--bad);}",
      "@media (max-width:760px){",
      "  .ansum-grid{grid-template-columns:repeat(2,1fr);gap:10px;}",
      "  .ansum-card{padding:12px 13px 11px;}",
      "  .ansum-val{font-size:22px;}",
      "}"
    ].join("\n");
    document.head.appendChild(s);
  }

  var CONF_LABEL = { high: "high confidence", medium: "moderate confidence", low: "lower confidence" };

  function _num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  // split a fmt string like "1.24 MW" / "350 kW" into {v, unit} so the unit
  // renders smaller — keeps the big number tabular and clean.
  function splitUnit(str) {
    var m = String(str).match(/^([^\sA-Za-z]*[\d.,\-]+)\s*(.*)$/);
    if (!m) return { v: str, unit: "" };
    return { v: m[1], unit: m[2] };
  }

  // one KPI card. value can carry a unit (split smaller); tone tints val + rail.
  function card(label, valStr, sub, opts) {
    opts = opts || {};
    var tone = opts.tone || "";              // "" | good | warn | bad | muted
    var splitU = opts.splitUnit !== false;   // default: peel the unit off
    var parts = splitU ? splitUnit(valStr) : { v: valStr, unit: "" };
    var unitHtml = parts.unit ? '<span class="ansum-unit">' + esc(parts.unit) + "</span>" : "";
    var subHtml = sub ? '<div class="ansum-sub' + (opts.subTone ? " " + opts.subTone : "") + '">' + sub + "</div>" : "";
    var railCls = (tone === "warn" || tone === "bad" || tone === "muted") ? " " + tone : "";
    return '<div class="ansum-card' + railCls + '">' +
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
    var f = ctx.forecast;                    // null = demo/anon or not-yet-loaded
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

    // producing now = sum of live inverter wattage across columns (live liveness)
    var prodW = 0, sawLive = false;
    cols.forEach(function (c) {
      (c.inverters || []).forEach(function (iv) {
        var w = _num(iv.current_power_w);
        if (w != null) { prodW += w; sawLive = true; }
      });
    });
    var prodKw = sawLive ? fmt.kwFromW(prodW) : null;
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

    // 4. Producing now + % of capacity
    var prodSub = (prodPctOfCap != null)
      ? fmt.pct(prodPctOfCap) + " of capacity"
      : (sawLive ? "live" : "awaiting live data");
    html += card("Producing now",
      prodKw != null ? fmt.kw(prodKw) : "—",
      prodSub,
      { tone: prodKw != null ? "good" : "muted" });

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
      var perfSub = "";
      if (confTxt) perfSub = confTxt;
      if (modeled != null) perfSub += (perfSub ? " · " : "") + modeled + (modeled === 1 ? " array modeled" : " arrays modeled");
      html += card("Weather-adj. performance", fmt.pct(perfRatio), perfSub || "vs expected", { tone: pTone });
    } else {
      html += card("Weather-adj. performance", "—", "available once data loads", { tone: "muted" });
    }

    // 7. Active alarms (measured)
    var alarmSub = alarmArrays === 0
      ? "all sites healthy"
      : fmt.num(flaggedInv) + (flaggedInv === 1 ? " inverter flagged" : " inverters flagged");
    html += card("Active alarms",
      fmt.num(alarmArrays),
      alarmSub,
      { tone: alarmTone, subTone: alarmArrays === 0 ? "" : (hasCritical ? "bad" : "warn") });

    // 8. At risk / recoverable — ONLY when forecast present (else omit entirely)
    if (f && f.available && _num(f.expected_kwh) != null && _num(f.actual_kwh) != null) {
      var shortfallKwh = Math.max(0, f.expected_kwh - f.actual_kwh);
      var rate = _num(ctx.energyRate) || 0;
      var dollars = shortfallKwh * rate;
      // optional REC value on the shortfall MWh
      var recPerMwh = _num(ctx.recPerMwh);
      if (recPerMwh != null) dollars += (shortfallKwh / 1000) * recPerMwh;
      var sfTone = shortfallKwh > 0 ? "warn" : "good";
      var sfSub = shortfallKwh > 0
        ? "≈ " + fmt.money(dollars) + " vs expected, last " + win + "d"
        : "on or above expected, last " + win + "d";
      html += card("Energy at risk",
        shortfallKwh > 0 ? fmt.kwh(shortfallKwh) : "0 kWh",
        sfSub,
        { tone: sfTone, subTone: shortfallKwh > 0 ? "warn" : "" });
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
        "vs " + fmt.kwh(spot.expected_kwh) + " expected — " +
        '<b class="' + rTone + '">' + fmt.pct(spot.ratio_pct) + "</b>." +
        "</span></div>";
    }

    container.innerHTML = '<div class="ansum-grid">' + html + "</div>" + spotHtml;
  }

  window.AnalysisSections = window.AnalysisSections || [];
  window.AnalysisSections.push({ id: "fleet-summary", title: "Portfolio", order: 10, render: render });
})();
