/* ============================================================================
 * Array Operator — Analysis tab · Production vs Expected  (analysis-forecast.js)
 *
 * The weather-adjusted "Production vs expected" card — RELOCATED here from Fleet
 * Health (was command-center.js #fleetTarget). Fleet Health now leads with the
 * "which inverters need a crew" queue; the whole-fleet weather-adjusted view is
 * an analysis concern, so it lives in the Analysis tab.
 *
 * Renders from the shared ctx.forecast (the orchestrator's ONE
 * /v1/array-owners/forecast-fleet fetch — same payload the old card fetched), so
 * behavior is preserved: the headline % of weather-expected output, the actual-vs-
 * expected kWh, the clearest-recent-day spotlight, and the expandable
 * "How we calculated this" panel that names every model input.
 *
 * Window: 10 days (Ford). Honest by construction: Actual = measured production
 * from the arrays' inverter telemetry over the last 10 days; Expected = the real
 * irradiance (sunlight) that fell on each array's location over the same 10 days.
 * No forecast (demo / not-yet-loaded / no addresses) → an honest empty state; we
 * never fabricate an expected value.
 * ========================================================================== */
(function () {
  "use strict";

  window.AnalysisSections = window.AnalysisSections || [];

  var _open = false;   // is the "How we calculated this" detail expanded? (module-level → survives re-render)

  // Confidence → plain words (matches the rest of the fleet's "say why" voice).
  var CONF_LABEL = {
    high: "high confidence", medium: "moderate confidence",
    low: "limited data so far", none: "not enough measured days yet"
  };

  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }
  function windowDays(fc, ctx) {
    return (fc && fc.window && fc.window.days) || (ctx && ctx.windowDays) || 10;
  }

  // ---- one-time scoped CSS ----------------------------------------------------
  function injectCss() {
    if (document.getElementById("anfc-css")) return;
    var s = document.createElement("style");
    s.id = "anfc-css";
    s.textContent = [
      ".anfc-body{padding:18px 18px 20px;}",

      /* headline row: big % + made/expected numbers */
      ".anfc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;}",
      ".anfc-pct{font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;}",
      ".anfc-pct span{font-size:20px;font-weight:700;color:var(--muted);margin-left:4px;}",
      ".anfc-pct small{display:block;font-size:12px;font-weight:600;color:var(--faint);letter-spacing:.02em;margin-top:5px;}",
      ".anfc-nums{text-align:right;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1.5;}",
      ".anfc-nums b{color:var(--ink);font-weight:720;}",
      ".anfc-badge{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--good);background:rgba(37,99,235,.09);border:1px solid rgba(37,99,235,.28);border-radius:999px;padding:2px 8px;margin-left:9px;vertical-align:middle;}",

      /* the progress track (100% = weather-expected) */
      ".anfc-track{position:relative;height:12px;border-radius:8px;background:var(--bg2);overflow:hidden;margin:16px 0 6px;}",
      ".anfc-fill{height:100%;border-radius:8px;background:var(--good);transition:width .5s ease;}",
      ".anfc-fill.warn{background:var(--bad);} .anfc-fill.soft{background:var(--warn);}",
      ".anfc-mark{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.35;}",

      ".anfc-verdict{font-size:13.5px;font-weight:640;color:var(--muted);margin-top:4px;}",
      ".anfc-verdict.warn{color:var(--bad);} .anfc-verdict.ok{color:var(--good);}",

      /* window + actuals explainer (Ford: clearer window + how actuals are collected) */
      ".anfc-explain{margin-top:15px;border:1px solid var(--line);border-radius:12px;background:var(--bg2);padding:13px 15px;}",
      ".anfc-explain-win{font-size:12px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;color:var(--good);margin-bottom:9px;}",
      ".anfc-explain-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px;}",
      ".anfc-ex{min-width:0;}",
      ".anfc-ex .k{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--faint);margin-bottom:3px;}",
      ".anfc-ex .v{font-size:12.5px;color:var(--muted);line-height:1.5;}",
      ".anfc-ex .v b{color:var(--ink);font-weight:660;}",
      "@media (max-width:620px){.anfc-explain-grid{grid-template-columns:1fr;}}",

      /* clearest-recent-day spotlight */
      ".anfc-spot{margin-top:13px;font-size:12.5px;color:var(--muted);line-height:1.55;background:rgba(37,99,235,.05);border:1px solid rgba(37,99,235,.16);border-radius:10px;padding:10px 12px;}",
      ".anfc-spot b{color:var(--ink);} .anfc-spot .good{color:var(--good);} .anfc-spot .bad{color:var(--bad);}",
      ".anfc-spot-ic{margin-right:5px;}",

      /* "How we calculated this" toggle + panel */
      ".anfc-note{font-size:12.5px;color:var(--muted);margin-top:13px;line-height:1.55;}",
      ".anfc-note b{color:var(--ink);}",
      ".anfc-toggle{margin-left:6px;border:0;background:none;color:var(--good);font:inherit;font-size:12.5px;font-weight:660;cursor:pointer;padding:0;text-decoration:underline;}",
      ".anfc-how{margin-top:13px;border-top:1px solid var(--line);padding-top:13px;}",
      ".anfc-how-eq{font-size:12px;color:var(--ink);background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:9px 12px;font-variant-numeric:tabular-nums;}",
      ".anfc-how-dl{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;margin:12px 0 0;font-size:12.5px;}",
      ".anfc-how-dl dt{font-weight:700;color:var(--faint);text-transform:uppercase;font-size:11px;letter-spacing:.03em;padding-top:2px;}",
      ".anfc-how-dl dd{margin:0;color:var(--muted);line-height:1.5;}",
      ".anfc-how-dl dd b{color:var(--ink);} .anfc-how-dl dd em{color:var(--faint);font-style:italic;}",
      ".anfc-how-foot{font-size:12px;color:var(--faint);margin-top:12px;line-height:1.55;}",
      ".anfc-how-foot b{color:var(--muted);}",

      /* honest empty state (no forecast) */
      ".anfc-empty{display:flex;gap:13px;align-items:flex-start;padding:4px 0;}",
      ".anfc-empty-ic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--bg2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--faint);}",
      ".anfc-empty-tx b{display:block;font-size:14px;font-weight:700;color:var(--ink);margin-bottom:3px;}",
      ".anfc-empty-tx span{font-size:12.5px;color:var(--muted);line-height:1.5;}"
    ].join("");
    document.head.appendChild(s);
  }

  // The transparent "How we calculated this" panel — every model input, named.
  // Ported verbatim from command-center.js forecastHowHTML (window copy = 10 days).
  function howHTML(f, ctx) {
    var esc = ctx.esc;
    var i = f.inputs || {};
    var loc = i.location || {}, g = i.geometry || {}, ir = i.irradiance || {};
    var srcName = ({ census: "street address (rooftop)", nominatim: "street address (OpenStreetMap)",
      "open-meteo": "town centroid (approximate)", manual: "operator-set" })[loc.geocode_source] || loc.geocode_source || "—";
    var tiltTxt = g.tilt_deg != null
      ? (g.tilt_deg + "° tilt" + (g.tilt_assumed ? " <em>(assumed = your latitude — the usual fixed-tilt optimum)</em>" : " (you set this)"))
      : "—";
    var azTxt = g.azimuth_deg != null
      ? ("facing " + esc(g.azimuth_label || "south") + (g.azimuth_assumed ? " <em>(assumed south)</em>" : " (you set this)"))
      : "—";
    var win = windowDays(f, ctx);
    var rows = [
      ["Where", esc(loc.address || "—") + " — " + esc(srcName) + " → " + (loc.lat != null ? (loc.lat + ", " + loc.lng) : "—")],
      ["Sunlight", esc(ir.source || "Open-Meteo") + " for " + esc(ir.window_start || "") + "–" + esc(ir.window_end || "") + ". Best day this window: <b>" + (ir.best_day_poa_kwh_m2 != null ? ir.best_day_poa_kwh_m2 : "—") + " kWh/m²</b> of plane-of-array sun (vs " + (ir.stc_reference_kwh_m2 || 1) + " kWh/m² at lab \"standard\" conditions)."],
      ["Panel angle", tiltTxt + ", " + azTxt],
      ["Capacity", "<b>" + (i.nameplate_kw != null ? i.nameplate_kw : "—") + " kW</b> nameplate (sum of this fleet's inverters)"],
      ["Losses", "Performance ratio <b>" + (i.performance_ratio != null ? Math.round(i.performance_ratio * 100) + "%" : "—") + "</b> — the standard derate from panel nameplate to delivered AC power (inverter efficiency, wiring, heat, soiling, mismatch)."],
      ["Measured", "Actual = real metered/inverter kWh only. We <b>exclude</b> monthly utility-bill estimates so a bill can't masquerade as one big day. " + (i.measured_days != null ? i.measured_days : "0") + " measured day(s) in the " + win + "-day window."]
    ];
    var dl = rows.map(function (kv) { return "<dt>" + esc(kv[0]) + "</dt><dd>" + kv[1] + "</dd>"; }).join("");
    return '<div class="anfc-how">' +
      '<div class="anfc-how-eq">expected kWh  =  nameplate kW  ×  (sunlight ÷ standard 1 kW/m²)  ×  performance ratio</div>' +
      '<dl class="anfc-how-dl">' + dl + '</dl>' +
      '<div class="anfc-how-foot">This is a <b>weather-adjusted expected value</b>, not a guarantee — a cloudy stretch runs under, a clear one over. It uses the real sun that fell on your location, so it catches a whole-fleet dip (soiling, snow, smoke, aging) that per-neighbor checks miss. ' +
      (f.arrays_skipped ? (f.arrays_skipped + " array(s) not yet modeled (no address or capacity on file).") : "") + '</div>' +
      '</div>';
  }

  // The clearer window + actuals explanation Ford asked for — explicit + honest.
  function explainHTML(f, ctx) {
    var win = windowDays(f, ctx);
    var modeled = num(f.arrays_modeled);
    var actualsSrc = (f.simulated
      ? "simulated demo telemetry"
      : "the arrays' inverter telemetry (real metered production; monthly utility-bill estimates are excluded)");
    return '<div class="anfc-explain">' +
      '<div class="anfc-explain-win">Window · last ' + win + ' days</div>' +
      '<div class="anfc-explain-grid">' +
      '<div class="anfc-ex"><div class="k">Actuals — measured</div><div class="v">Real production summed from <b>' + actualsSrc + '</b> over the last <b>' + win + ' days</b>' + (modeled != null ? ', across <b>' + modeled + ' modeled array' + (modeled === 1 ? '' : 's') + '</b>' : '') + '.</div></div>' +
      '<div class="anfc-ex"><div class="k">Expected — weather-adjusted</div><div class="v">The <b>real irradiance (sunlight)</b> that actually fell on each array\'s location over the <b>same ' + win + ' days</b>, converted to expected AC kWh (not a seasonal average).</div></div>' +
      '</div></div>';
  }

  // honest empty state — the card has no meaning without the weather model
  function emptyHTML(ctx) {
    var esc = ctx.esc;
    return '<div class="anfc-empty">' +
      '<div class="anfc-empty-ic">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>' +
      '</div><div class="anfc-empty-tx">' +
      '<b>Production vs expected needs your weather-modeled data</b>' +
      '<span>' + (ctx.simulated
        ? 'The live demo fleet has no weather model. Sign in with real arrays (with a service address on file) to compare measured production against the real sunlight on each site.'
        : 'Available once production has loaded for a few days and your arrays have a location on file — we compare measured output against the weather-expected output for each site over the last 10 days.') +
      '</span></div></div>';
  }

  // ---- render (idempotent) ----------------------------------------------------
  function render(container, ctx) {
    injectCss();
    var esc = ctx.esc;
    var f = ctx.forecast;

    var body;
    if (!f || !f.available || num(f.ratio_pct) == null) {
      // No usable forecast → honest empty state (never a fabricated expected value).
      body = emptyHTML(ctx);
    } else {
      var pct = num(f.ratio_pct);
      var fill = Math.max(0, Math.min(pct, 120));
      var tone = pct < 82 ? "warn" : (pct >= 92 ? "ok" : "soft");
      var verdict = pct < 82
        ? ((100 - pct) + "% under the sunlight-expected output")
        : (pct >= 100 ? "at or above what the actual weather should yield" : "tracking near the sunlight-expected output");
      var spot = f.sunny_spotlight;
      var spotLine = (spot && num(spot.ratio_pct) != null)
        ? '<div class="anfc-spot"><span class="anfc-spot-ic">☀</span> Clearest recent day (' + esc(spot.day) + ', ' + spot.poa_kwh_m2 + ' kWh/m² sun): <b>' + esc(spot.array_name) + '</b> made <b>' + Math.round(spot.actual_kwh).toLocaleString() + ' kWh</b> vs ' + Math.round(spot.expected_kwh).toLocaleString() + ' expected — <b class="' + (spot.ratio_pct >= 92 ? 'good' : spot.ratio_pct < 82 ? 'bad' : '') + '">' + spot.ratio_pct + '%</b>.</div>'
        : "";
      var conf = esc(CONF_LABEL[f.confidence] || f.confidence || "");
      var modeled = num(f.arrays_modeled);
      // honesty footnote: arrays whose "expected" is an operator-entered kWh/kW
      // target (set in the kWh/kW health card above), not the weather model.
      var ratioBased = num(f.arrays_ratio_based);
      var ratioNote = (ratioBased > 0)
        ? ' ' + ratioBased + ' array' + (ratioBased === 1 ? ' uses' : 's use') + ' your entered kWh/kW target as its expected.'
        : '';

      body =
        '<div class="anfc-head">' +
        '  <div class="anfc-pct">' + pct + '<span>%</span><small>of weather-expected</small></div>' +
        '  <div class="anfc-nums"><b>' + Math.round(f.actual_kwh).toLocaleString() + ' kWh</b> made<br>' + Math.round(f.expected_kwh).toLocaleString() + ' kWh expected</div>' +
        '</div>' +
        '<div class="anfc-track" role="img" aria-label="Fleet made ' + pct + '% of its weather-expected output">' +
        '  <div class="anfc-fill ' + tone + '" style="width:' + fill + '%"></div>' +
        '  <span class="anfc-mark" style="left:' + (100 / 1.2) + '%" title="100% = the actual weather\'s expected output"></span>' +
        '</div>' +
        '<div class="anfc-verdict ' + tone + '">' + (pct < 82 ? "⚠ " : "") + esc(verdict) + '</div>' +
        explainHTML(f, ctx) +
        spotLine +
        '<div class="anfc-note">Expected = the <b>real sunlight</b> that fell on your arrays\' locations, not a seasonal average — ' + conf + (modeled != null ? ' (' + modeled + ' array' + (modeled === 1 ? '' : 's') + ' modeled)' : '') + '.' + esc(ratioNote) +
        '<button type="button" class="anfc-toggle" data-anfc-toggle aria-expanded="' + _open + '">' + (_open ? "Hide" : "How we calculated this") + '</button></div>' +
        (_open ? howHTML(f, ctx) : "");
    }

    var simNote = (f && f.simulated)
      ? '<div class="an-card-sub">Demo fleet — a simulated weather model so the card is demoable.</div>'
      : '<div class="an-card-sub">Measured production vs the real sunlight on each site, last ' + windowDays(f, ctx) + ' days</div>';

    container.innerHTML =
      '<div class="an-card">' +
      '  <div class="an-card-head">' +
      '    <div><h3>Production vs expected <span class="anfc-badge">weather-adjusted</span></h3>' + simNote + '</div>' +
      '  </div>' +
      '  <div class="anfc-body">' + body + '</div>' +
      '</div>';

    // Wire the "How we calculated this" toggle (re-render preserves _open).
    var t = container.querySelector("[data-anfc-toggle]");
    if (t) t.addEventListener("click", function () { _open = !_open; render(container, ctx); });
  }

  // order 8 → SECOND, right under the kWh/kW health ranking (order 5) and above
  // the Portfolio KPI strip (10). Bruce's Analysis order: kWh/kW ratio first
  // (with flags inline), THEN actual-vs-expected as the second layer.
  window.AnalysisSections.push({ id: "forecast", title: "Production vs expected", order: 8, render: render });
})();
