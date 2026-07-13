/* ============================================================================
 * Array Operator — Analysis tab (analysis.js)  [ORCHESTRATOR]
 *
 * A PowerTrack-style fleet NOC page, built entirely on data Array Operator
 * already has: the shared FleetStore (canonical fleet + live liveness) and the
 * weather-aware /v1/array-owners/forecast-fleet endpoint (expected-vs-actual,
 * performance ratio). It composes a set of SELF-CONTAINED section modules —
 * each module registers itself on window.AnalysisSections and owns its own
 * markup + scoped <style>. This file:
 *   1. builds the page shell (#analysisRoot)
 *   2. loads the fleet (FleetStore) + fetches the fleet forecast ONCE
 *   3. assembles a single read-only `ctx` and renders every section, ordered
 *   4. re-renders on FleetStore changes (load / fleet / live / rate) + when the
 *      forecast resolves — debounced, so the page stays genuinely live
 *
 * Honesty contract (Ford's hard rule): sections NEVER fabricate. `ctx.forecast`
 * is null for the anonymous demo / before it loads, and arrays we can't model
 * are reported in forecast.skipped — sections degrade to what's measured, they
 * never invent an expected value or a weather reading we don't have.
 * ========================================================================== */
(function () {
  "use strict";

  window.AnalysisSections = window.AnalysisSections || [];

  var SESSION_KEY = "so_session";
  function getSession() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }

  // ---- shared formatters (every section uses these so numbers never drift) ----
  function _n(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }
  var fmt = {
    // kW with sensible precision; accepts watts via kwFromW()
    kw: function (kw) { var v = _n(kw); if (v == null) return "—"; if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + " MW"; if (Math.abs(v) >= 100) return Math.round(v) + " kW"; return (Math.round(v * 10) / 10) + " kW"; },
    kwFromW: function (w) { var v = _n(w); return v == null ? null : v / 1000; },
    kwh: function (kwh) { var v = _n(kwh); if (v == null) return "—"; if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + " GWh"; if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + " MWh"; return Math.round(v).toLocaleString() + " kWh"; },
    money: function (d) { var v = _n(d); if (v == null) return "—"; if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString(); return "$" + (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); },
    pct: function (p) { var v = _n(p); return v == null ? "—" : Math.round(v) + "%"; },
    num: function (x) { var v = _n(x); return v == null ? "—" : Math.round(v).toLocaleString(); },
    ago: function (ms) {
      var v = _n(ms); if (v == null) return "—";
      var s = Math.max(0, Math.round((Date.now() - v) / 1000));
      if (s < 60) return s + "s ago"; var m = Math.round(s / 60);
      if (m < 60) return m + "m ago"; var h = Math.round(m / 60);
      if (h < 24) return h + "h ago"; return Math.round(h / 24) + "d ago";
    }
  };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  // ---- forecast cache (one fetch, shared by every section) --------------------
  var _forecast = null;          // null = not loaded / demo; object = loaded
  var _forecastTried = false;
  var _forecastInFlight = false;

  // Stale-while-revalidate: the fleet forecast is expensive to compute (weather
  // model over every site), so a cold Analysis tab used to sit with empty
  // Expected/Sky columns until the fetch resolved. We stash the last good payload
  // in sessionStorage keyed to the current session, hydrate it INSTANTLY on load
  // so the table paints its full weather columns immediately, then revalidate in
  // the background and repaint when fresh data lands. Bounded to ~6h so a very
  // stale cache never lingers.
  var _FC_CACHE_KEY = "ao_forecast_fleet_v1";
  var _FC_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;
  function _sessFp(s) { return s ? String(s).slice(-10) : ""; }   // fingerprint, not the token
  function readForecastCache() {
    try {
      var s = getSession(); if (!s) return null;
      var raw = sessionStorage.getItem(_FC_CACHE_KEY); if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.fp !== _sessFp(s) || !o.data) return null;
      if ((Date.now() - (o.ts || 0)) > _FC_CACHE_MAX_AGE_MS) return null;
      return o.data;
    } catch (e) { return null; }
  }
  function writeForecastCache(data) {
    try {
      var s = getSession(); if (!s || !data) return;
      sessionStorage.setItem(_FC_CACHE_KEY, JSON.stringify({ fp: _sessFp(s), ts: Date.now(), data: data }));
    } catch (e) { /* quota / disabled — cache is best-effort */ }
  }
  function clearForecastCache() { try { sessionStorage.removeItem(_FC_CACHE_KEY); } catch (e) { } }

  function loadForecast() {
    var s = getSession(); if (!s) { _forecast = null; return; }   // demo/anon → no forecast
    // Paint the last-known forecast immediately (instant Expected/Sky), then revalidate.
    if (!_forecast) { var cached = readForecastCache(); if (cached) _forecast = cached; }
    if (_forecastInFlight) return;
    _forecastInFlight = true;
    var win = 10;
    try {
      var n = Number(sessionStorage.getItem("ao_forecast_window_days"));
      if (n >= 3 && n <= 30) win = n;
    } catch (e) { }
    fetch("/v1/array-owners/forecast-fleet?window_days=" + win, { headers: { Authorization: "Bearer " + s } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { _forecast = d || _forecast || null; if (d) writeForecastCache(d); _forecastTried = true; _forecastInFlight = false; scheduleRender(); })
      .catch(function () { _forecastTried = true; _forecastInFlight = false; scheduleRender(); });
  }

  // Force a fresh forecast fetch (after an array gets a location, so it models).
  // Drops the cached copy too — a just-set location must not be masked by a stale paint.
  function reloadForecast() { _forecast = null; _simForecast = null; _forecastTried = false; _forecastInFlight = false; clearForecastCache(); loadForecast(); }
  window.__aoAnalysisReloadForecast = reloadForecast;

  // Give an array a location (place string / coords / use its name) so the weather
  // model can run, then reload the forecast so its row appears. Used by the Sites
  // grid's "set location" affordance on arrays skipped as no_location.
  window.__aoSetArrayLocation = function (arrayId, opts) {
    var s = getSession(); if (!s) return Promise.reject(new Error("Sign in to set a location"));
    opts = opts || {};
    var silent = !!opts.silent;
    var body = Object.assign({}, opts);
    delete body.silent;
    return fetch("/v1/array-owners/arrays/" + encodeURIComponent(arrayId) + "/location", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (e) { throw new Error(e.detail || ("Couldn't set location (" + r.status + ")")); });
    }).then(function (d) { if (!silent) reloadForecast(); return d; });
  };

  // Set/clear an array's operator-entered EXPECTED specific yield (kWh per kW
  // per DAY). null clears → back to the weather model. Used by the kWh/kW
  // health section's per-row "target" affordance; reloads the forecast so
  // expected/ratio flip to the new basis everywhere at once.
  window.__aoSetArrayExpectedRatio = function (arrayId, kwhPerKwDay) {
    var s = getSession(); if (!s) return Promise.reject(new Error("Sign in to set a target"));
    return fetch("/v1/array-owners/arrays/" + encodeURIComponent(arrayId) + "/expected-ratio", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s },
      body: JSON.stringify({ expected_kwh_per_kw_day: (kwhPerKwDay == null ? null : Number(kwhPerKwDay)) })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (e) {
        var msg = e && e.detail;
        if (msg && typeof msg === "object") msg = msg.message || msg.detail || JSON.stringify(msg);
        throw new Error(msg || ("Couldn't save the target (" + r.status + ")"));
      });
    }).then(function (d) { reloadForecast(); return d; });
  };

  // Save tilt / azimuth / performance ratio for ONE array (or clear with nulls).
  // Pass { silent: true } when batching many arrays, then call __aoAnalysisReloadForecast once.
  window.__aoSetArrayGeometry = function (arrayId, opts) {
    var s = getSession(); if (!s) return Promise.reject(new Error("Sign in to edit model inputs"));
    opts = opts || {};
    var silent = !!opts.silent;
    var body = {
      tilt_deg: opts.tilt_deg == null || opts.tilt_deg === "" ? null : Number(opts.tilt_deg),
      azimuth_deg: opts.azimuth_deg == null || opts.azimuth_deg === "" ? null : Number(opts.azimuth_deg),
    };
    if (opts.clear_performance_ratio) body.clear_performance_ratio = true;
    else if (opts.performance_ratio != null && opts.performance_ratio !== "")
      body.performance_ratio = Number(opts.performance_ratio);
    return fetch("/v1/array-owners/arrays/" + encodeURIComponent(arrayId) + "/geometry", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (e) {
        var msg = e && e.detail;
        if (Array.isArray(msg)) msg = msg.map(function (x) { return x.msg || x; }).join("; ");
        throw new Error(msg || ("Couldn't save geometry (" + r.status + ")"));
      });
    }).then(function (d) { if (!silent) reloadForecast(); return d; });
  };

  // Bulk-apply model params across the fleet (only assumed values by default).
  window.__aoSetFleetForecastParams = function (opts) {
    var s = getSession(); if (!s) return Promise.reject(new Error("Sign in to edit model inputs"));
    opts = opts || {};
    return fetch("/v1/array-owners/forecast-params", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s },
      body: JSON.stringify(opts)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (e) {
        var msg = e && e.detail;
        if (Array.isArray(msg)) msg = msg.map(function (x) { return x.msg || x; }).join("; ");
        throw new Error(msg || ("Couldn't save model params (" + r.status + ")"));
      });
    }).then(function (d) { reloadForecast(); return d; });
  };

  // Change the Analysis forecast window (7/10/14/30 days) and refetch.
  window.__aoSetForecastWindow = function (days) {
    var n = Number(days);
    if (!(n >= 3 && n <= 30)) n = 10;
    try { sessionStorage.setItem("ao_forecast_window_days", String(n)); } catch (e) { }
    _forecast = null; _simForecast = null; _forecastTried = false; _forecastInFlight = false;
    clearForecastCache();
    // loadForecast reads the window from sessionStorage
    loadForecast();
  };
  window.__aoGetForecastWindow = function () {
    try {
      var n = Number(sessionStorage.getItem("ao_forecast_window_days"));
      if (n >= 3 && n <= 30) return n;
    } catch (e) { }
    return 10;
  };

  // ---- weather: Open-Meteo weathercode → a compact sky descriptor -------------
  // Shared by the demo synthesis AND the real per-site weather the backend adds to
  // forecast rows, so the Sites grid renders one consistent icon set either way.
  var SKY = {
    clear:  { glyph: "☀", label: "Clear", tone: "good" },
    partly: { glyph: "⛅", label: "Partly cloudy", tone: "" },
    cloudy: { glyph: "☁", label: "Cloudy", tone: "muted" },
    rain:   { glyph: "🌧", label: "Rain", tone: "sky" },
    snow:   { glyph: "❄", label: "Snow", tone: "sky" },
    fog:    { glyph: "🌫", label: "Fog", tone: "muted" }
  };
  function skyFromCode(code) {
    if (code == null) return null;
    if (code === 0) return SKY.clear;
    if (code <= 3) return SKY.partly;
    if (code === 45 || code === 48) return SKY.fog;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return SKY.snow;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return SKY.rain;
    return SKY.cloudy;
  }

  // ---- simulated forecast for the anonymous DEMO fleet ------------------------
  // The demo fleet is entirely fake (100 simulated arrays) and has no weather
  // model, so the flagship weather-adjusted columns would read "not modeled yet".
  // We synthesize a plausible, deterministic forecast (+ per-site weather) from
  // the demo's own measured window_kwh so the tab is fully demoable. This is ONLY
  // built when FleetStore.isSimulated() is true; a real signed-in fleet always
  // uses the live /forecast-fleet endpoint. Flagged `simulated:true` so sections
  // can asterisk it as demo data.
  var _simForecast = null;
  function _h(n, salt) { var x = ((Number(n) || 0) + (salt || 0)) * 2654435761 % 4294967296; return ((x >>> 0) % 1000) / 1000; }
  function buildSimulatedForecast(arrays) {
    var rows = [], sumE = 0, sumA = 0, sumNp = 0, sumNpDays = 0, spotlight = null;
    var codes = [0, 0, 1, 2, 3, 61, 63, 71];   // weighted toward clearer skies
    arrays.forEach(function (a) {
      var np = 0, act = 0;
      (a.inverters || []).forEach(function (iv) {
        if (iv.nameplate_kw > 0) np += iv.nameplate_kw;
        if (iv.window_kwh > 0) act += iv.window_kwh;
      });
      if (np <= 0) return;
      var ratio = Math.round(64 + _h(a.id) * 54);           // 64..118 %
      var bad = (a.inverters || []).filter(function (iv) { return iv.status === "dead" || iv.status === "fault" || iv.status === "underperforming"; }).length;
      if (bad) ratio = Math.max(38, ratio - bad * 6);       // ailing sites read lower
      var exp = act > 0 ? Math.round(act / (ratio / 100)) : Math.round(np * 4.6 * 10);
      if (act <= 0) act = Math.round(exp * (ratio / 100));
      var code = codes[Math.floor(_h(a.id, 7) * codes.length)];
      rows.push({
        array_id: a.id, array_name: a.name, nameplate_kw: Math.round(np * 10) / 10,
        expected_kwh: exp, actual_kwh: act, ratio_pct: ratio, measured_days: 10,
        // demo kWh/kW (same units as the live payload: kWh per kW per day / per window)
        kwh_per_kw_day: Math.round(act / np / 10 * 100) / 100,
        kwh_per_kw_window: Math.round(act / np * 10) / 10,
        expected_basis: "weather_model", expected_kwh_per_kw_day: null,
        confidence: "high", tilt_assumed: false, weather_code: code
      });
      sumE += exp; sumA += act; sumNp += np; sumNpDays += np * 10;
      if (code === 0 && (!spotlight || ratio > spotlight.ratio_pct)) {
        spotlight = { array_name: a.name, poa_kwh_m2: 6.2, actual_kwh: act, expected_kwh: exp, ratio_pct: ratio, day: "a recent clear day" };
      }
    });
    var fr = sumE > 0 ? Math.round(sumA / sumE * 100) : null;
    return {
      available: true, simulated: true, ratio_pct: fr,
      performance_ratio_measured: sumE > 0 ? Math.round(sumA / sumE * 1000) / 1000 : null,
      expected_kwh: Math.round(sumE), actual_kwh: Math.round(sumA), expected_kwh_window: Math.round(sumE),
      confidence: "high", arrays_modeled: rows.length, arrays_skipped: 0, arrays_ratio_based: 0,
      kwh_per_kw: {
        fleet_per_day: sumNpDays > 0 ? Math.round(sumA / sumNpDays * 100) / 100 : null,
        nameplate_kw: Math.round(sumNp * 10) / 10, arrays_counted: rows.length,
        units: "kWh per kW per day, averaged over measured days"
      },
      rows: rows, skipped: [], sunny_spotlight: spotlight,
      inputs: { simulated: true, pr: 0.84, irradiance_source: "simulated", note: "Demo fleet — simulated weather model" },
      window: { days: 10 }
    };
  }

  // ---- build the read-only ctx every section renders against ------------------
  function buildCtx() {
    var snap = (window.FleetStore && FleetStore.snapshot()) || { arrays: [], simulated: false };
    var cols = (window.FleetStore && FleetStore.toColumns()) || { columns: [], summary: { arrays_total: 0, inverters_total: 0, attention: 0 } };
    // Real signed-in fleet → the live forecast. Anonymous demo → synthesize one
    // (once) so the flagship renders; a real fleet NEVER gets a synthetic forecast.
    var forecast = _forecast;
    if (!forecast && snap.simulated && (snap.arrays || []).length) {
      forecast = _simForecast || (_simForecast = buildSimulatedForecast(snap.arrays));
    }
    var forecastByArray = {};
    if (forecast && Array.isArray(forecast.rows)) {
      forecast.rows.forEach(function (r) { forecastByArray[String(r.array_id)] = r; });
    }
    // Why each un-modeled array was skipped (no_location / no_nameplate /
    // irradiance_unavailable) → lets the Sites grid offer "set location" on the
    // ones that just need coordinates.
    var forecastSkipped = {};
    if (forecast && Array.isArray(forecast.skipped)) {
      forecast.skipped.forEach(function (s) { forecastSkipped[String(s.array_id)] = s.reason; });
    }
    return {
      signedIn: !!getSession(),
      simulated: !!snap.simulated,
      // Has the fleet actually finished its first load? A cold sign-in's ctx.columns
      // is empty for the same reason a genuinely-empty fleet's would be — panels that
      // treat "0 flagged" as "all clear" must gate on this first, or a race between
      // FleetStore.load() and the first synchronous renderAll() paints a false-green
      // "All systems nominal" before a single inverter has been checked.
      loaded: !!(window.FleetStore && FleetStore.isLoaded && FleetStore.isLoaded()),
      arrays: snap.arrays || [],                 // canonical: {id,name,region,host,vendor,inverters:[…]}
      columns: cols.columns || [],               // per-array: {array_id,array_name,vendor,alert,current_power_w,produced_today_kwh,sync_status,source_status,is_daylight,inverters:[…]}
      summary: cols.summary || { arrays_total: 0, inverters_total: 0, attention: 0 },
      forecast: forecast,                        // fleet-forecast json | null. May be simulated:true for the demo.
      forecastByArray: forecastByArray,          // {array_id: row}  row={expected_kwh,actual_kwh,ratio_pct,nameplate_kw,…,weather_code}
      forecastSkipped: forecastSkipped,          // {array_id: "no_location"|"no_nameplate"|"irradiance_unavailable"}
      setLocation: window.__aoSetArrayLocation,  // (arrayId, {place}|{use_name}|{latitude,longitude}) → Promise; reloads forecast
      setExpectedRatio: window.__aoSetArrayExpectedRatio, // (arrayId, kwhPerKwDay|null) → Promise; reloads forecast
      sky: skyFromCode,                          // (weather_code) → {glyph,label,tone} | null — shared weather icon map
      energyRate: (window.FleetStore && FleetStore.energyRate()) || 0.21,
      recPerMwh: (window.FleetStore && FleetStore.REC_PER_MWH) || 38,
      // The span window_kwh is summed over — MUST match the backend's true window
      // (peer_analysis.WINDOW_DAYS = 14; the fleet payload's summary.window_days
      // echoes it). Capacity Factor, lost-$, and every "Production · Nd" label the
      // analysis submodules derive from window_kwh divide by THIS, so a wrong value
      // (the old hardcoded 10) inflated them all by 14/10 = 1.4x. Sourced from the
      // shared FleetStore constant so it can't drift. NOTE: the weather forecast card
      // is a SEPARATE, genuinely-10-day feature — it reads fc.window.days (=10) from
      // its own payload, not this, so it stays correct.
      windowDays: (window.FleetStore && FleetStore.WINDOW_DAYS) || 14,
      lastUpdate: (window.FleetStore && FleetStore.lastUpdate()) || Date.now(),
      live: window.FleetStore || null,           // for liveVerdict / isProducing / isLiveAnomaly
      fmt: fmt, esc: esc
    };
  }

  // ---- page shell -------------------------------------------------------------
  function shell() {
    var root = document.getElementById("analysisRoot");
    if (!root) return null;
    if (!root._built) {
      root.innerHTML =
        '<div class="an-wrap">' +
        '  <div class="an-head">' +
        '    <div class="an-head-main">' +
        '      <h2>Fleet analysis</h2>' +
        '      <div class="an-sub" id="anSub">Portfolio performance, weather-adjusted — every site in one view.</div>' +
        '    </div>' +
        '    <div class="an-asof" id="anAsof"></div>' +
        '  </div>' +
        '  <div class="an-sections" id="anSections"></div>' +
        '</div>';
      root._built = true;
    }
    return root;
  }

  // ---- header freshness: DATA age, not poll age --------------------------------
  // "Live · updated Xs ago" used to render ago(FleetStore.lastUpdate()) — the
  // browser's POLL clock, which keeps ticking even when every feed is frozen — so
  // a stale fleet read as live. Grade the header off the per-array data age
  // instead (source_status.age_hours, else sync_status.age_min), deferring to the
  // spreadsheet's canonical VendorSheet.isStale for the stale count.
  function colAgeMin(c) {
    var h = c.source_status && c.source_status.age_hours;
    if (h != null) return h * 60;
    var m = c.sync_status && c.sync_status.age_min;
    return m == null ? null : m;
  }
  function fmtAgeMin(m) {
    if (m < 90) return Math.round(m) + " min ago";
    if (m < 1440) return Math.round(m / 60) + "h ago";
    return Math.round(m / 1440) + "d ago";
  }
  function asofHtml(ctx) {
    var oldest = null, staleN = 0;
    (ctx.columns || []).forEach(function (c) {
      var a = colAgeMin(c);
      if (a != null && (oldest == null || a > oldest)) oldest = a;
      if (window.VendorSheet && VendorSheet.isStale && VendorSheet.isStale(c)) staleN++;
    });
    if (staleN === 0 && (oldest == null || oldest <= 60)) {
      return '<span class="an-livedot"></span> Live · updated ' + esc(fmt.ago(ctx.lastUpdate));
    }
    return 'Data as of ' + esc(fmtAgeMin(oldest)) +
      (staleN ? ' · ' + staleN + (staleN === 1 ? ' array stale' : ' arrays stale') : '');
  }

  // ---- render all registered sections, ordered --------------------------------
  function renderAll() {
    var root = shell(); if (!root) return;
    var ctx = buildCtx();

    var asof = document.getElementById("anAsof");
    if (asof) {
      asof.innerHTML = ctx.simulated
        ? '<span class="an-livedot demo"></span> Live demo fleet'
        : asofHtml(ctx);
    }
    var sub = document.getElementById("anSub");
    if (sub && ctx.signedIn && _forecast && _forecast.arrays_skipped) {
      // honest footnote: how many arrays can't be weather-modeled yet
    }

    var host = document.getElementById("anSections"); if (!host) return;
    var sections = (window.AnalysisSections || []).slice().sort(function (a, b) { return (a.order || 999) - (b.order || 999); });

    sections.forEach(function (sec) {
      var block = host.querySelector('[data-section="' + sec.id + '"]');
      if (!block) {
        block = document.createElement("section");
        block.className = "an-block";
        block.setAttribute("data-section", sec.id);
        host.appendChild(block);
      }
      try {
        sec.render(block, ctx);
        block.removeAttribute("data-failed");
      } catch (e) {
        block.setAttribute("data-failed", "1");
        block.innerHTML = '<div class="an-block-err">This panel hit an error and was skipped.</div>';
        try { console.error("[analysis] section " + sec.id + " failed:", e); } catch (_) { }
      }
    });
  }

  // debounce so a burst of FleetStore notifications collapses to one paint
  var _raf = 0;
  function scheduleRender() {
    if (_raf) return;
    _raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
      _raf = 0; renderAll();
    });
  }

  // ---- public entry: called by the tab router (sandbox.js applyView) ----------
  var _wired = false;
  function loadAnalysis() {
    if (!document.getElementById("analysisRoot")) return;
    if (window.FleetStore) FleetStore.load();
    loadForecast();
    if (!_wired && window.FleetStore) {
      _wired = true;
      FleetStore.subscribe(function (s, kind) {
        // repaint on anything that changes the numbers; ignore pure triage/history
        if (kind === "triage" || kind === "history" || kind === "focus") return;
        if (!document.getElementById("analysisRoot")) return;
        scheduleRender();
      });
    }
    renderAll();
  }
  window.__aoLoadAnalysis = loadAnalysis;
})();
