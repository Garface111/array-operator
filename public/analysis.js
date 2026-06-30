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
  function loadForecast() {
    var s = getSession(); if (!s) { _forecast = null; return; }   // demo/anon → no forecast
    if (_forecastInFlight) return;
    _forecastInFlight = true;
    fetch("/v1/array-owners/forecast-fleet?window_days=14", { headers: { Authorization: "Bearer " + s } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { _forecast = d || null; _forecastTried = true; _forecastInFlight = false; scheduleRender(); })
      .catch(function () { _forecast = null; _forecastTried = true; _forecastInFlight = false; scheduleRender(); });
  }

  // ---- build the read-only ctx every section renders against ------------------
  function buildCtx() {
    var snap = (window.FleetStore && FleetStore.snapshot()) || { arrays: [], simulated: false };
    var cols = (window.FleetStore && FleetStore.toColumns()) || { columns: [], summary: { arrays_total: 0, inverters_total: 0, attention: 0 } };
    var forecastByArray = {};
    if (_forecast && Array.isArray(_forecast.rows)) {
      _forecast.rows.forEach(function (r) { forecastByArray[String(r.array_id)] = r; });
    }
    return {
      signedIn: !!getSession(),
      simulated: !!snap.simulated,
      arrays: snap.arrays || [],                 // canonical: {id,name,region,host,vendor,inverters:[…]}
      columns: cols.columns || [],               // per-array: {array_id,array_name,vendor,alert,current_power_w,produced_today_kwh,sync_status,source_status,is_daylight,inverters:[…]}
      summary: cols.summary || { arrays_total: 0, inverters_total: 0, attention: 0 },
      forecast: _forecast,                       // fleet-forecast json | null  (null = demo/anon or not-yet-loaded)
      forecastByArray: forecastByArray,          // {array_id: row}  row={expected_kwh,actual_kwh,ratio_pct,nameplate_kw,measured_days,confidence,…}
      energyRate: (window.FleetStore && FleetStore.energyRate()) || 0.21,
      recPerMwh: (window.FleetStore && FleetStore.REC_PER_MWH) || 38,
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

  // ---- render all registered sections, ordered --------------------------------
  function renderAll() {
    var root = shell(); if (!root) return;
    var ctx = buildCtx();

    var asof = document.getElementById("anAsof");
    if (asof) {
      asof.innerHTML = ctx.simulated
        ? '<span class="an-livedot demo"></span> Live demo fleet'
        : '<span class="an-livedot"></span> Live · updated ' + esc(fmt.ago(ctx.lastUpdate));
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
