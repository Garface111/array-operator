/* ============================================================================
 * Sample account, Analysis tab routes (public/demo/analysis.js)
 *
 * Loaded by demo-api.js ONLY for signed-out visitors. Answers the Analysis
 * tab's own API calls with the sample operator (Northeast Community Solar),
 * shaped exactly like the backend handlers so every panel renders through its
 * normal signed-in code path:
 *
 *   GET /v1/array-owners/fleet-trends[?array_id=N]
 *         ← api/array_owners.py  array_owners_fleet_trends
 *   GET /v1/array-owners/forecast-fleet?window_days=N
 *         ← api/array_owners.py  compute_fleet_forecast
 *   GET /v1/array-owners/verification/summary?window_days=N
 *         ← api/perf_verification/engine.py  build_portfolio_verification
 *   GET /v1/array-owners/alert-events
 *         ← api/array_owners.py  list_alert_events_ep
 *   GET /v1/array-owners/files
 *         ← api/array_owners.py  list_site_files_ep
 *   Downloads (verification PDF / auditor ZIP / master data packs / site
 *   files) → the shared "start free" nudge + read-only 403, never a fake file.
 *
 * Ties out with every other tab:
 *  · monthly kWh = AO_DEMO_API.monthly(id, n), daily kWh = AO_DEMO_API.daily(id, n).
 *    Both depend only on (site, date), so a 45-month Trends history and a
 *    24-month Statements table agree on every month they share.
 *  · The four story sites (8, 12, 3, 17) read below the weather model; every
 *    other site verifies. Same per-day residual drives the forecast hero,
 *    Performance, and Verification, so they agree.
 * ==========================================================================*/
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  var DL_MSG = "Downloads are available on your own account. Start free to export your arrays.";
  var TENANT_ID = "ten_sample_northeast";
  var MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function r1(n) { return D.round(n, 1); }
  function r2(n) { return D.round(n, 2); }
  function r3(n) { return D.round(n, 3); }
  function r4(n) { return D.round(n, 4); }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function intParam(req, name, def, lo, hi) {
    var v = parseInt(req.query && req.query.get(name), 10);
    if (!isFinite(v)) return def;
    return Math.max(lo, Math.min(hi, v));
  }

  // ── kWh series (memoized per day; dates are relative to today) ─────────────
  var _memo = {}, _memoDay = "";
  function memo(key, fn) {
    var t = D.isoDate(new Date());
    if (t !== _memoDay) { _memo = {}; _memoDay = t; }
    if (!Object.prototype.hasOwnProperty.call(_memo, key)) _memo[key] = fn();
    return _memo[key];
  }
  function monthsOf(id, n) { return memo("m:" + id + ":" + n, function () { return D.monthly(id, n); }); }
  function daysOf(id, n) { return memo("d:" + id + ":" + n, function () { return D.daily(id, n); }); }
  // Trends' multi-year views (and Through time's 3-year average) want history
  // back to January three years ago: Jan (Y-3) .. last settled month.
  function histMonths() { return 36 + new Date().getMonth(); }

  // ── the sample fleet's vendors / live inverter state (FleetStore) ─────────
  var VENDOR_FALLBACK = {
    1: "solaredge", 2: "solaredge", 3: "fronius", 4: "solaredge", 5: "sma", 6: "solaredge",
    7: "solaredge", 8: "chint", 9: "fronius", 10: "solaredge", 11: "locus", 12: "fronius",
    13: "sma", 14: "solaredge", 15: "chint", 16: "sma", 17: "solaredge", 18: "fronius",
    19: "alsoenergy", 20: "chint"
  };
  // FleetStore's simulated fleet is the live state every other surface shows.
  // Read it when it is loaded; never trigger a load from here.
  function fleetArray(id) {
    try {
      var FS = window.FleetStore;
      if (!FS || !FS.isLoaded || !FS.isLoaded()) return null;
      var arr = FS.snapshot().arrays || [];
      for (var i = 0; i < arr.length; i++) if (Number(arr[i].id) === Number(id)) return arr[i];
    } catch (e) {}
    return null;
  }
  function vendorOf(id) {
    var fa = fleetArray(id);
    return (fa && fa.vendor) || VENDOR_FALLBACK[id] || "solaredge";
  }

  // ── fleet-trends ──────────────────────────────────────────────────────────
  // Source families exactly as array_owners._SOURCE_FAMILY / _SOURCE_LABELS.
  var SOURCE_ORDER = ["gmp", "solaredge", "fronius", "sma", "chint", "locus",
    "inverter", "csv", "manual", "bill", "other"];
  var SOURCE_LABELS = {
    gmp: "GMP (utility meter)", solaredge: "SolarEdge", fronius: "Fronius",
    sma: "SMA", chint: "CHINT", locus: "Locus Energy",
    inverter: "Inverter (extension)", csv: "CSV upload", manual: "Manual entry",
    bill: "Bill (prorated)", other: "Other"
  };
  var VENDOR_FAMILY = { solaredge: "solaredge", fronius: "fronius", sma: "sma", chint: "chint",
    locus: "locus", alsoenergy: "inverter" };   // AlsoEnergy rides the capture extension
  // GMP-metered sites: history older than this many months was backfilled from
  // the GMP utility meter before vendor monitoring was connected.
  var GMP_BACKFILL_RECENT = 14;

  function familyFor(site, idx, n) {
    if (site.primary_utility === "gmp" && idx < n - GMP_BACKFILL_RECENT) return "gmp";
    return VENDOR_FAMILY[vendorOf(site.id)] || "other";
  }

  function ttmKeys() {
    // Last 12 SETTLED months. The backend sums today's month too (MTD); the
    // sample's monthly history is settled months only, so the honest analog
    // of "trailing 12 months" is the 12 months ending last month.
    var out = {}, now = new Date();
    for (var k = 1; k <= 12; k++) out[D.isoMonth(new Date(now.getFullYear(), now.getMonth() - k, 1))] = true;
    return out;
  }

  function fleetTrends(arrayId) {
    var sites = D.sites();
    var scoped = sites;
    if (arrayId != null) {
      scoped = sites.filter(function (s) { return Number(s.id) === arrayId; });
      if (!scoped.length) return D.json({ detail: "array not found" }, 404);
    }
    var n = histMonths();
    var now = new Date(), curY = now.getFullYear(), priorY = curY - 1;
    var TTM = ttmKeys();
    var rate = Number((window.AO_DEMO || {}).creditRate) || 0.2576;

    var fleetYM = {};                 // "YYYY-MM" -> kWh
    var srcYM = {}, srcLife = {};     // family -> {"YYYY-MM": kWh}, family -> kWh
    var dayTot = {}, dayOrder = [];   // fleet daily (365 d)
    var capKw = 0, capN = 0;

    scoped.forEach(function (s) {
      monthsOf(s.id, n).forEach(function (m, i) {
        fleetYM[m.month] = (fleetYM[m.month] || 0) + m.kwh;
        var fam = familyFor(s, i, n);
        srcYM[fam] = srcYM[fam] || {};
        srcYM[fam][m.month] = (srcYM[fam][m.month] || 0) + m.kwh;
        srcLife[fam] = (srcLife[fam] || 0) + m.kwh;
      });
      daysOf(s.id, 365).forEach(function (p) {
        if (!(p.date in dayTot)) { dayTot[p.date] = 0; dayOrder.push(p.date); }
        dayTot[p.date] += p.kwh;
      });
      var kw = Number(s.nameplate_kw) || 0;
      if (kw > 0) { capKw += kw; capN++; }
    });

    var yearSet = {};
    Object.keys(fleetYM).forEach(function (k) { yearSet[k.slice(0, 4)] = true; });
    var years = Object.keys(yearSet).map(Number).sort(function (a, b) { return a - b; });

    var monthlyByYear = {};
    years.forEach(function (y) {
      var pts = [];
      for (var mm = 1; mm <= 12; mm++) {
        var key = y + "-" + (mm < 10 ? "0" : "") + mm;
        if (key in fleetYM) pts.push({ month: mm, kwh: r1(fleetYM[key]) });
      }
      monthlyByYear[String(y)] = pts;
    });

    var seasonal = [];
    for (var m = 1; m <= 12; m++) {
      var byYear = {}, present = [];
      years.forEach(function (y) {
        var key = y + "-" + (m < 10 ? "0" : "") + m;
        if (key in fleetYM) { byYear[String(y)] = r1(fleetYM[key]); present.push(y); }
      });
      if (!present.length) continue;
      var delta = null;
      if (present.length >= 2) {
        var pv = byYear[String(present[present.length - 2])];
        if (pv) delta = r1(100 * (byYear[String(present[present.length - 1])] - pv) / pv);
      }
      seasonal.push({ month: m, label: MON3[m - 1], by_year: byYear, latest_delta_pct: delta });
    }

    var ttm = 0, life = 0;
    Object.keys(fleetYM).forEach(function (k) { life += fleetYM[k]; if (TTM[k]) ttm += fleetYM[k]; });
    life = r1(life);

    dayOrder.sort();
    var series = dayOrder.map(function (d) { return { day: d, kwh: r1(dayTot[d]) }; });
    var recent = series.slice(-30);

    var totalLife = 0;
    Object.keys(srcLife).forEach(function (f) { totalLife += srcLife[f]; });
    var fams = SOURCE_ORDER.filter(function (f) { return srcLife[f] > 0; });
    var sourceBreakdown = fams.map(function (f) {
      var fby = {};
      years.forEach(function (y) {
        var pts = [];
        for (var mm = 1; mm <= 12; mm++) {
          var key = y + "-" + (mm < 10 ? "0" : "") + mm;
          if (srcYM[f][key] != null) pts.push({ month: mm, kwh: r1(srcYM[f][key]) });
        }
        if (pts.length) fby[String(y)] = pts;
      });
      var lt = r1(srcLife[f]);
      return { key: f, label: SOURCE_LABELS[f] || f, lifetime_kwh: lt,
        share_pct: totalLife ? r1(100 * lt / totalLife) : 0, monthly_by_year: fby };
    });

    // EPA GHG equivalencies (2024), the backend's published factors.
    var co2lb = life * 1.5634;
    var environmental = life > 0 ? {
      co2_avoided_lb: Math.round(co2lb),
      co2_avoided_tonnes: r2(co2lb * 0.000453592),
      trees_equiv: Math.round(co2lb / 48.0),
      cars_year_equiv: r1(co2lb / 11015.0),
      homes_year_equiv: r1(life / 10500.0),
      basis: "EPA GHG equivalencies (2024); applied to lifetime clean kWh"
    } : null;

    // by_array always lists the FULL fleet (so the filter can switch arrays).
    var byArray = sites.map(function (s) {
      var lifeA = 0, ttmA = 0, byY = {};
      monthsOf(s.id, n).forEach(function (mo) {
        lifeA += mo.kwh;
        byY[mo.year] = (byY[mo.year] || 0) + mo.kwh;
        if (TTM[mo.month]) ttmA += mo.kwh;
      });
      var kby = {};
      Object.keys(byY).sort().forEach(function (y) { kby[y] = r1(byY[y]); });
      var prior = r1(byY[priorY] || 0);
      return {
        array_id: s.id,
        name: s.name,
        lifetime_kwh: r1(lifeA),
        years: Object.keys(byY).map(Number).sort(function (a, b) { return a - b; }),
        kwh_by_year: kby,
        kwh_ytd: r1(byY[curY] || 0),
        ytd_year: curY,
        kwh_ttm: r1(ttmA),
        kwh_prior_year: prior > 0 ? prior : null,
        prior_year: priorY,
        ttm_vs_prior_year_pct: (prior > 0 && ttmA > 0) ? r1(100 * (ttmA - prior) / prior) : null
      };
    }).sort(function (a, b) { return b.lifetime_kwh - a.lifetime_kwh; });

    return {
      years: years,
      monthly_by_year: monthlyByYear,
      seasonal_yoy: seasonal,
      ttm_kwh: r1(ttm),
      ttm_savings_usd: r2(ttm * rate),
      blended_rate_usd_per_kwh: r4(rate),
      rate_source: "bill_or_schedule",
      rate_note: "kWh-weighted from bill / rate schedule",
      lifetime_kwh: life,
      daily_recent: recent,
      daily_series: series,
      source_breakdown: sourceBreakdown,
      capacity_kw: capKw > 0 ? r2(capKw) : null,
      capacity_known_arrays: capN,
      specific_yield_ttm_kwh_per_kwp: capKw > 0 ? r1(ttm / capKw) : null,
      environmental: environmental,
      selected_array_id: arrayId != null ? arrayId : null,
      by_array: byArray
    };
  }

  D.get(/^\/v1\/array-owners\/fleet-trends$/, function (req) {
    var raw = req.query && req.query.get("array_id");
    var id = raw != null && raw !== "" ? parseInt(raw, 10) : null;
    if (raw != null && raw !== "" && !isFinite(id)) return D.json({ detail: "array_id must be an integer" }, 422);
    return fleetTrends(id);
  });

  // ── the weather model shared by forecast-fleet + verification ─────────────
  // Region centroids for the sample's (fictional) sites; coordinates are
  // operator-set ("manual"), not geocoded from a real address.
  var REGION = {
    south: { st: "VT", lat: 42.95, lng: -72.74 },
    central: { st: "VT", lat: 44.05, lng: -72.66 },
    north: { st: "VT", lat: 44.66, lng: -72.52 },
    northeast: { st: "VT", lat: 44.58, lng: -71.93 },
    east: { st: "VT", lat: 43.97, lng: -72.44 },
    northwest: { st: "VT", lat: 44.81, lng: -73.04 },
    nh: { st: "NH", lat: 43.62, lng: -72.12 },
    me: { st: "ME", lat: 44.18, lng: -69.81 }
  };
  // A few sites carry operator-entered geometry / losses; the rest use the
  // model defaults (tilt ≈ latitude, south, PR 84%), labeled "assumed".
  var OPERATOR_MODEL = {
    1: { tilt: 30, pr: 0.82 }, 9: { tilt: 25, pr: 0.86 }, 15: { tilt: 35 }, 19: { tilt: 30, pr: 0.83 }
  };
  // Mean daily residual vs the model for the four story sites (FleetStore's
  // flagged inverters). Every other site sits within ±1% of its model.
  var STORY_OFFSET = { 8: -0.068, 12: -0.062, 3: -0.056, 17: -0.052 };
  var SUNNY_FRACTION = 0.85;

  function model(s) {
    var reg = REGION[s.region] || REGION.central;
    var g = D.rng("analysis-geo:" + s.id);
    var lat = r4(reg.lat + (g() - 0.5) * 0.16);
    var lng = r4(reg.lng + (g() - 0.5) * 0.2);
    var op = OPERATOR_MODEL[s.id] || null;
    var tilt = op && op.tilt != null ? op.tilt : D.round(Math.max(10, Math.min(60, Math.abs(lat))), 1);
    return {
      lat: lat, lng: lng, address: s.name + ", " + reg.st, region: s.region,
      tilt: tilt, tilt_assumed: !(op && op.tilt != null),
      az: 0, az_assumed: !op,
      pr: op && op.pr != null ? op.pr : 0.84, pr_assumed: !(op && op.pr != null)
    };
  }

  function residualOffset(s, iso) {
    var off = STORY_OFFSET[s.id];
    if (off == null) return (D.sitePerf(s.id) - 0.985) * 0.4;
    // North Branch Ridge's string fault began three settled months ago (the
    // same cutover monthly() uses); before that it ran like its peers.
    if (Number(s.id) === 8) {
      var n = new Date(), start = D.isoDate(new Date(n.getFullYear(), n.getMonth() - 3, 1));
      if (iso < start) return 0;
    }
    return off;
  }

  // Per-day measured (daily()) vs model expected. The residual is seeded per
  // site+day, so a 10-day forecast and a 30-day verification agree day by day.
  function dayRows(s, w, mdl) {
    var kw = Number(s.nameplate_kw) || 0;
    var days = daysOf(s.id, Math.max(w, 30)).slice(-w);
    var rows = days.map(function (p) {
      var r = D.rng("analysis-pi:" + s.id + ":" + p.date);
      var res = residualOffset(s, p.date) + (r() - 0.5) * 0.05;   // ±2.5% day-to-day scatter
      var exp = p.kwh / (1 + res);
      return { day: p.date, actual: p.kwh, expected: exp, poa: kw > 0 ? exp / (kw * mdl.pr) : null };
    });
    var best = 0;
    rows.forEach(function (d) { if (d.poa != null && d.poa > best) best = d.poa; });
    rows.forEach(function (d) { d.sunny = d.poa != null && best > 0 && d.poa >= SUNNY_FRACTION * best; });
    rows.best = best;
    return rows;
  }

  var MEASURED_SOURCES = ["chint", "csv", "extension_pull", "fronius", "gmp_api", "locus",
    "manual", "sma", "solaredge", "vendor"];

  function inputsFor(s, mdl, w, rows) {
    var kw = Number(s.nameplate_kw) || 0;
    return {
      nameplate_kw: r2(kw),
      expected_basis: "weather_model",
      expected_kwh_per_kw_day: null,
      window_days: w,
      measured_days: rows.length,
      measured_sources: MEASURED_SOURCES,
      location: { lat: mdl.lat, lng: mdl.lng, geocode_source: "manual", address: mdl.address },
      geometry: {
        tilt_deg: r1(mdl.tilt), azimuth_deg: r1(mdl.az),
        tilt_assumed: mdl.tilt_assumed, azimuth_assumed: mdl.az_assumed, azimuth_label: "south"
      },
      performance_ratio: r3(mdl.pr),
      performance_ratio_assumed: mdl.pr_assumed,
      irradiance: {
        source: "Open-Meteo global_tilted_irradiance (hourly, integrated)",
        stc_reference_kwh_m2: 1.0,
        window_start: rows.length ? rows[0].day : null,
        window_end: rows.length ? rows[rows.length - 1].day : null,
        best_day_poa_kwh_m2: r2(rows.best || 0)
      }
    };
  }

  function confidenceFor(days) {
    return days >= 10 ? "high" : days >= 4 ? "medium" : days >= 1 ? "low" : "none";
  }

  // Current sky per region (Open-Meteo weather codes); stable within a day.
  function skyCode(region) {
    var r = D.rng("analysis-sky:" + region + ":" + D.isoDate(new Date()));
    var codes = [0, 0, 1, 2, 3, 3, 61];
    return codes[Math.floor(r() * codes.length)];
  }

  // ── forecast-fleet ────────────────────────────────────────────────────────
  function forecastFleet(w) {
    var rows = [], sunny = [];
    var fleetExp = 0, fleetAct = 0, maxDays = 0;
    var kkAct = 0, kkNpDays = 0, kkNp = 0, kkN = 0;
    var rep = null, repKw = 0;
    D.sites().forEach(function (s) {
      var kw = Number(s.nameplate_kw) || 0;
      if (kw <= 0) return;
      var mdl = model(s);
      var days = dayRows(s, w, mdl);
      var exp = sum(days.map(function (d) { return d.expected; }));
      var act = sum(days.map(function (d) { return d.actual; }));
      var md = days.length;
      rows.push({
        array_id: s.id, array_name: s.name,
        nameplate_kw: r1(kw),
        expected_kwh: r1(exp),
        expected_matched_kwh: r1(exp),
        actual_kwh: r1(act),
        kwh_per_kw_day: md > 0 ? r2(act / kw / md) : null,
        kwh_per_kw_window: md > 0 ? r1(act / kw) : null,
        expected_basis: "weather_model",
        expected_kwh_per_kw_day: null,
        ratio_pct: exp > 0 ? Math.round(act / exp * 100) : null,
        measured_days: md,
        confidence: confidenceFor(md),
        tilt_assumed: mdl.tilt_assumed,
        geocode_source: "manual",
        weather_code: skyCode(mdl.region),
        tilt_deg: r1(mdl.tilt), azimuth_deg: r1(mdl.az),
        performance_ratio: r3(mdl.pr),
        performance_ratio_assumed: mdl.pr_assumed,
        azimuth_assumed: mdl.az_assumed,
        address: mdl.address,
        latitude: mdl.lat, longitude: mdl.lng
      });
      if (md > 0) { kkAct += act; kkNpDays += kw * md; kkNp += kw; kkN++; }
      fleetExp += exp; fleetAct += act; maxDays = Math.max(maxDays, md);
      if (!rep || kw > repKw) { rep = inputsFor(s, mdl, w, days); repKw = kw; }
      days.forEach(function (d) {
        if (!d.sunny) return;
        sunny.push({
          array_id: s.id, array_name: s.name, day: d.day,
          poa_kwh_m2: r2(d.poa), expected_kwh: r1(d.expected), actual_kwh: r1(d.actual),
          ratio_pct: Math.round(d.actual / d.expected * 100), sunny: true
        });
      });
    });
    sunny.sort(function (a, b) { return (b.poa_kwh_m2 || 0) - (a.poa_kwh_m2 || 0); });
    rows.sort(function (a, b) { return (a.ratio_pct == null) - (b.ratio_pct == null) || (a.ratio_pct || 0) - (b.ratio_pct || 0); });
    var end = D.daysAgo(1), start = D.daysAgo(w);
    return {
      available: rows.length > 0,
      ratio_pct: fleetExp > 0 ? Math.round(fleetAct / fleetExp * 100) : null,
      expected_kwh: r1(fleetExp),
      actual_kwh: r1(fleetAct),
      expected_kwh_window: r1(fleetExp),
      performance_ratio_measured: fleetExp > 0 ? r3(fleetAct / fleetExp) : null,
      confidence: maxDays >= 10 && rows.length ? "high" : maxDays >= 4 && rows.length ? "medium" : rows.length ? "low" : "none",
      arrays_modeled: rows.length,
      arrays_skipped: 0,
      arrays_ratio_based: 0,
      kwh_per_kw: {
        fleet_per_day: kkNpDays > 0 ? r2(kkAct / kkNpDays) : null,
        nameplate_kw: r1(kkNp),
        arrays_counted: kkN,
        units: "kWh per kW per day, averaged over measured days"
      },
      inputs: rep || {},
      rows: rows,
      skipped: [],
      sunny_spotlight: sunny[0] || null,
      window: { start: D.isoDate(start), end: D.isoDate(end), days: w }
    };
  }

  D.get(/^\/v1\/array-owners\/forecast-fleet$/, function (req) {
    return forecastFleet(intParam(req, "window_days", 14, 3, 30));
  });

  // ── verification (ports of perf_verification persistence/causes/availability) ─
  var IEC_ALIGNMENT_NOTE =
    "EnergyAgent Performance Verification evaluates PV systems using methods " +
    "consistent with IEC 61724-1 (monitoring) and IEC 61724-3 (energy evaluation). " +
    "This is an operational verification layer, not a third-party bankability " +
    "certification.";
  var REPORT_FOOTER =
    "Performance Verification · methods consistent with IEC 61724-1 / 61724-3 · " +
    "EnergyAgent Array Operator · not a third-party certification · " +
    "Measured energy uses the utility meter when available, otherwise inverter AC · " +
    "Expected energy is weather irradiance (POA) × nameplate × performance ratio";
  var METHOD_SUMMARY = {
    title: "Performance verification method",
    standards: ["IEC 61724-1", "IEC 61724-3"],
    alignment: IEC_ALIGNMENT_NOTE,
    measurement_boundary:
      "Preferred measured energy is utility / revenue-grade meter generation " +
      "at the point of interconnection (POI) when available for the calendar day. " +
      "When meter-day energy is absent, inverter / telemetry AC energy is used. " +
      "Monthly bill prorations (bill_prorate, utility_meter smears) are never used " +
      "as measured energy for Performance Index.",
    expected_energy:
      "Expected AC energy is computed from plane-of-array (POA) irradiance " +
      "(satellite/reanalysis via Open-Meteo global_tilted_irradiance), array " +
      "nameplate kW, plane geometry (tilt/azimuth), and a labeled performance " +
      "ratio (PR). Default PR = 0.84 unless the owner sets a site PR. " +
      "expected_kwh = nameplate_kw × (POA_kWh/m² / 1.0) × PR.",
    kpis: {
      performance_index:
        "PI = measured_energy / expected_energy over matched days " +
        "(days with both measured and expected). PI ≈ 1 means production " +
        "aligned with the weather-and-PR model.",
      performance_ratio_assumed:
        "The model PR is an input derate (inverter, wiring, temperature, " +
        "soiling allowance, mismatch). It is always labeled assumed vs owner-set.",
      deviation:
        "Daily residual r = (measured − expected) / expected. Portfolio and " +
        "array summaries report mean residual and classify persistence.",
      availability:
        "Where inverter status exists, availability distinguishes all-in energy " +
        "from in-service periods (excluding multi-day comm_gap / dead windows). " +
        "Null when status history is insufficient — never fabricated."
    },
    windows:
      "Consistent calendar windows: daily, rolling N-day (default 14/30), and " +
      "prior full calendar month for scheduled reports. Partial current day is " +
      "excluded from matched comparisons.",
    honesty:
      "No fabricated irradiance, measured energy, or PI. Unavailable inputs yield " +
      "structured nulls with reasons."
  };
  var DEFAULT_THRESHOLD = 0.05, PERSISTENT_DAYS = 5;

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function pct0(t) { return Math.round(t * 100) + "%"; }          // Python f"{t:.0%}"
  function priorityScore(mag, dur, sudden) {
    if (mag <= 0 || dur <= 0) return 0;
    var raw = mag * 100 * (dur / 7);
    if (sudden) raw *= 1.5;
    return D.round(Math.min(100, Math.max(0, raw)), 1);
  }
  // persistence.classify_deviation (no prior-year residuals → never "seasonal")
  function classifyDeviation(series, thr) {
    thr = Math.abs(thr || DEFAULT_THRESHOLD);
    var pts = series.filter(function (p) { return p.residual != null; })
      .sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
    if (pts.length < 2) {
      return { label: "insufficient_data", threshold: thr, magnitude_mean: null, duration_days: 0, priority: 0,
        detail: "Need at least 2 matched days with residual to classify deviation." };
    }
    var res = pts.map(function (p) { return p.residual; });
    var under = res.filter(function (r) { return r < -thr; });
    var streak = 0;
    for (var i = res.length - 1; i >= 0; i--) { if (res[i] < -thr) streak++; else break; }
    var sudden = false;
    if (res.length >= 5) {
      var last = res.slice(-2), prior = res.slice(0, -2);
      if (prior.length && last.every(function (r) { return r < -thr; }) && median(prior.slice(-7)) > -thr * 0.5) sudden = true;
    }
    var mag, dur;
    if (sudden && streak <= 3) {
      mag = (res[res.length - 2] + res[res.length - 1]) / 2;
      return { label: "sudden", threshold: thr, magnitude_mean: r4(mag), duration_days: Math.max(streak, 1),
        priority: priorityScore(Math.abs(mag), Math.max(streak, 2), true),
        detail: "Sudden drop: last days residual < −" + pct0(thr) + " while prior baseline was near expected." };
    }
    if (streak >= PERSISTENT_DAYS || under.length >= PERSISTENT_DAYS) {
      var mags = under.length ? under : res.slice(-streak);
      mag = sum(mags) / mags.length;
      dur = Math.max(streak, under.length);
      return { label: "persistent", threshold: thr, magnitude_mean: r4(mag), duration_days: dur,
        priority: priorityScore(Math.abs(mag), dur, false),
        detail: "Underperformance below −" + pct0(thr) + " for " + dur + " day(s)." };
    }
    if (under.length) {
      mag = sum(under) / under.length;
      var emerging = under.length >= 3;
      return { label: emerging ? "persistent" : "ok", threshold: thr, magnitude_mean: r4(mag), duration_days: under.length,
        priority: emerging ? priorityScore(Math.abs(mag), under.length, false) : 0,
        detail: emerging
          ? "Emerging underperformance (" + under.length + " days)."
          : under.length + " day(s) below −" + pct0(thr) + " residual; below persistence threshold of " + PERSISTENT_DAYS + " days." };
    }
    return { label: "ok", threshold: thr, magnitude_mean: r4(sum(res) / res.length), duration_days: 0, priority: 0,
      detail: "No multi-day underperformance below the deviation threshold." };
  }

  // engine._inverter_status_hint over FleetStore's live inverters
  function statusHint(id) {
    var fa = fleetArray(id);
    var status = null, expectedLow = false;
    ((fa && fa.inverters) || []).forEach(function (iv) {
      if (iv.expected_low) expectedLow = true;
    });
    var invs = (fa && fa.inverters) || [];
    for (var i = 0; i < invs.length; i++) {
      var st = invs[i].status;
      if (st === "fault" || st === "dead") { status = st; break; }
      if (st === "comm_gap" && status == null) status = "comm_gap";
      if (st === "underperforming" && status == null) status = "underperforming";
    }
    return { status: status, expectedLow: expectedLow };
  }

  // causes.infer_cause
  function inferCause(o) {
    function c(cause, conf, detail) { return { cause: cause, confidence: conf, detail: detail, dollars_hint: null }; }
    if (o.measuredDays < Math.max(3, Math.floor(o.windowDays / 4)) || o.boundary === "unavailable") {
      return c("data_quality", "medium", "Too few matched measured days (or no measured boundary) to attribute a physical cause. Fix capture / meter feed first.");
    }
    if (o.peerStatus === "fault" || o.peerStatus === "dead") {
      return c("electrical", "medium", "Hardware/electrical signal: status=" + o.peerStatus + ". Check inverter faults and AC/DC wiring before soiling claims.");
    }
    if (o.peerStatus === "comm_gap") {
      return c("availability", "medium", "Communications gap — production may be fine but telemetry is dark. Re-auth portal / Auto-refresh before dispatching field service.");
    }
    if (o.expectedLow) {
      return c("shading", "medium", "Site marked expected-low (known shading / fixed derate). Judged against its baseline, not full nameplate peers.");
    }
    if ((o.label === "persistent" || o.label === "seasonal") && o.sunny.length) {
      var sMean = sum(o.sunny) / o.sunny.length;
      var cMean = o.cloudy.length ? sum(o.cloudy) / o.cloudy.length : 0;
      if (sMean < -0.05 && (!o.cloudy.length || sMean < cMean - 0.03)) {
        return c("soiling", "low", "Persistent shortfall more pronounced on high-irradiance days — compatible with soiling or module surface losses. Confirm with site inspection / cleaning trial.");
      }
    }
    if (o.label === "sudden") {
      return c("electrical", "low", "Sudden step-change vs weather-expected output — often a string/inverter event or curtailment. Check fault logs and recent work orders.");
    }
    if ((o.label === "persistent" || o.label === "seasonal") && o.mean != null && o.mean < -0.05) {
      return c(o.label === "seasonal" ? "environmental" : "unknown", "low",
        "Sustained gap vs expected energy without a clear hardware flag. Could be soiling, vegetation, snow, mis-set PR/geometry, or model mismatch — treat as investigation priority, not a confirmed root cause.");
    }
    return c("unknown", "low", "No strong cause signal; performance near model or mixed residuals.");
  }

  // availability.compute_availability (no inverter status history → energy proxy)
  function availability(w, daily) {
    var acts = daily.filter(function (d) { return d.actual_kwh != null; });
    if (!acts.length) {
      return { window_days: w, all_in_energy_kwh: null, in_service_energy_kwh: null, downtime_days: null,
        availability_pct: null, reason: "no_measured_days" };
    }
    var allIn = sum(acts.map(function (d) { return d.actual_kwh; }));
    var down = daily.filter(function (d) { return d.actual_kwh != null && d.actual_kwh <= 0 && d.expected_kwh > 1; }).length;
    return { window_days: w, all_in_energy_kwh: r1(allIn), in_service_energy_kwh: r1(allIn), downtime_days: down,
      availability_pct: r1(Math.max(0, Math.min(100, 100 * (1 - down / Math.max(w, 1))))),
      reason: "energy_proxy_no_status" };
  }

  function verifyArray(s, w, thr) {
    var kw = Number(s.nameplate_kw) || 0;
    var mdl = model(s);
    var rows = dayRows(s, w, mdl);
    // GMP sites read the utility meter (revenue-grade, meter-first); the rest
    // fall back to inverter AC, exactly as boundary.select_measured_for_day.
    var boundary = s.primary_utility === "gmp" ? "meter" : "inverter";
    var sunnyRes = [], cloudyRes = [];
    var daily = rows.map(function (d) {
      var residual = (d.actual - d.expected) / d.expected;
      (d.sunny ? sunnyRes : cloudyRes).push(residual);
      return { day: d.day, actual_kwh: r1(d.actual), expected_kwh: r1(d.expected), poa_kwh_m2: r2(d.poa),
        residual: r4(residual), boundary: boundary, sunny: d.sunny, status: null };
    });
    var dev = classifyDeviation(daily.map(function (d, i) {
      return { day: d.day, residual: (rows[i].actual - rows[i].expected) / rows[i].expected };
    }), thr);
    var hint = statusHint(s.id);
    var cause = inferCause({ label: dev.label, mean: dev.magnitude_mean, peerStatus: hint.status,
      expectedLow: hint.expectedLow, sunny: sunnyRes, cloudy: cloudyRes, measuredDays: rows.length,
      windowDays: w, boundary: boundary });
    var exp = sum(rows.map(function (d) { return d.expected; }));
    var act = sum(rows.map(function (d) { return d.actual; }));
    return {
      array_id: s.id,
      array_name: s.name,
      window_days: w,
      window_start: rows.length ? rows[0].day : null,
      window_end: rows.length ? rows[rows.length - 1].day : null,
      available: true,
      standards_note: IEC_ALIGNMENT_NOTE,
      reason: null,
      boundary: boundary,
      nameplate_kw: r2(kw),
      performance_index: exp > 0 ? r4(act / exp) : null,
      performance_ratio_model: mdl.pr,
      performance_ratio_assumed: mdl.pr_assumed,
      expected_kwh: r1(exp),
      expected_matched_kwh: r1(exp),
      actual_kwh: r1(act),
      ratio_pct: exp > 0 ? Math.round(act / exp * 100) : null,
      loss_kwh_vs_expected: exp > 0 ? r1(exp - act) : null,
      confidence: confidenceFor(rows.length),
      measured_days: rows.length,
      inputs: inputsFor(s, mdl, w, rows),
      deviation: dev,
      cause: cause,
      availability: availability(w, daily),
      daily: daily,
      report_footer: REPORT_FOOTER
    };
  }

  function verificationSummary(w) {
    var thr = DEFAULT_THRESHOLD;
    var arrays = D.sites().filter(function (s) { return Number(s.nameplate_kw) > 0; })
      .map(function (s) { return verifyArray(s, w, thr); });
    var act = 0, expM = 0, pris = [];
    arrays.forEach(function (a) {
      act += a.actual_kwh || 0; expM += a.expected_matched_kwh || 0;
      pris.push(a.deviation.priority || 0);
    });
    var pi = expM > 0 ? act / expM : null;
    var ranked = arrays.slice().sort(function (a, b) { return (b.deviation.priority || 0) - (a.deviation.priority || 0); });
    return {
      available: arrays.length > 0,
      tenant_id: TENANT_ID,
      window_days: w,
      window_start: D.isoDate(D.daysAgo(w)),
      window_end: D.isoDate(D.daysAgo(1)),
      threshold: thr,
      portfolio: {
        array_count: arrays.length,
        skipped_count: 0,
        actual_kwh: r1(act),
        expected_matched_kwh: r1(expM),
        performance_index: pi != null ? r3(pi) : null,
        ratio_pct: pi != null ? Math.round(pi * 100) : null,
        max_priority: pris.length ? Math.max.apply(null, pris) : 0
      },
      arrays: ranked,
      skipped: [],
      method: METHOD_SUMMARY,
      standards_note: IEC_ALIGNMENT_NOTE,
      report_footer: REPORT_FOOTER
    };
  }

  D.get(/^\/v1\/array-owners\/verification\/summary$/, function (req) {
    return verificationSummary(intParam(req, "window_days", 30, 1, 366));
  });

  // ── downloads: nudge + honest 403, never a fake file ──────────────────────
  function download() { return D.readOnly(DL_MSG); }
  D.get(/^\/v1\/array-owners\/verification\/(report\.pdf|auditor-export)$/, download);
  D.get(/^\/v1\/array-owners\/master-data\.zip$/, download);
  D.get(/^\/v1\/array-owners\/arrays\/\d+\/master-data\.xlsx$/, download);
  D.get(/^\/v1\/array-owners\/files\/\d+\/download$/, download);

  // ── event log (alert-events) ──────────────────────────────────────────────
  // Every alert that fired is a ticket here, so the log mirrors the Repairs
  // tab's cases (demo/repairs.js) day for day: live tickets for FleetStore's
  // flagged inverters (the story table), resolved ones for the closed repairs
  // on healthy sites. Times are [days ago, hour, minute] like repairs.js at().
  var TITLE_FROM_STATUS = {
    dead: ["Inverter stopped", "critical"], fault: ["Fault reported", "critical"],
    underperforming: ["Underperforming", "warning"], comm_gap: ["Gone quiet", "warning"]
  };
  var STORY_LIVE = [   // fallback when FleetStore isn't loaded yet
    { id: 8, inv: "Inverter 1", st: "underperforming" }, { id: 8, inv: "Inverter 2", st: "comm_gap", h: 10 },
    { id: 12, inv: "Inverter 3", st: "underperforming" }, { id: 12, inv: "Inverter 7", st: "comm_gap", h: 23 },
    { id: 3, inv: "Inverter 1", st: "underperforming" }, { id: 17, inv: "Inverter 4", st: "underperforming" }
  ];
  // Alert opened = the auto repair case's opened_at; acknowledged when Dana
  // approved the repair email (repairs.js "approve" step).
  var LIVE_CASES = {
    "17:Inverter 4": { opened: [12, 7, 20], ack: [12, 8, 40] },
    "12:Inverter 3": { opened: [8, 6, 55], ack: [8, 9, 30] },
    "3:Inverter 1": { opened: [7, 7, 10], ack: [7, 9, 45] },
    "8:Inverter 1": { opened: [6, 6, 40], ack: [6, 8, 12] }
  };
  var HISTORY = [
    { id: 2, inv: "Inverter 2", st: "dead", opened: [119, 10, 5], closed: [116, 10, 41],
      note: "Came back after the O&M tech power-cycled it on the next site visit." },
    { id: 15, inv: "Inverter 8", st: "fault", opened: [104, 8, 40], closed: [90, 15, 11],
      note: "Failing unit swapped under warranty." },
    { id: 20, inv: "Inverter 5", st: "dead", opened: [38, 10, 30], closed: [35, 13, 21],
      note: "Power-cycled on site; producing in line with its neighbors again." },
    { id: 1, inv: "Inverter 9", st: "fault", opened: [15, 10, 40], closed: [14, 9, 30],
      note: "Grid over-voltage fault; reconnected on its own once the line settled." },
    { id: 16, inv: "Inverter 6", st: "fault", opened: [4, 8, 10], closed: [4, 11, 6],
      note: "Grid-fault latch after co-op line work; cleared the same morning." }
  ];

  function liveFlags() {
    var out = [];
    var FS = window.FleetStore;
    try {
      if (FS && FS.isLoaded && FS.isLoaded()) {
        (FS.snapshot().arrays || []).forEach(function (a) {
          (a.inverters || []).forEach(function (iv) {
            if (TITLE_FROM_STATUS[iv.status]) {
              out.push({ id: Number(a.id), inv: iv.name, st: iv.status, h: iv.stale_hours, diagnosis: iv.diagnosis });
            }
          });
        });
        return out;
      }
    } catch (e) {}
    return STORY_LIVE.slice();
  }

  function nameOf(id) { var s = D.site(id); return s ? s.name : "Array " + id; }
  function at(d, seed) {           // a stable working-hours time on day d
    var r = D.rng("analysis-evt:" + seed);
    d.setHours(7 + Math.floor(r() * 10), Math.floor(r() * 60), 0, 0);
    return d;
  }
  function when(t) { return D.daysAgo(t[0], t[1], t[2]); }

  function alertEvents() {
    var now = new Date(), events = [], nextId = 4100;
    liveFlags().forEach(function (f) {
      var spec = TITLE_FROM_STATUS[f.st];
      var kase = LIVE_CASES[f.id + ":" + f.inv];
      var created = f.st === "comm_gap"
        ? new Date(now.getTime() - (Number(f.h) || 12) * 3600 * 1000)
        : kase ? when(kase.opened) : at(D.daysAgo(3), f.id + f.inv);
      var updated = kase ? when(kase.ack) : created;
      events.push({
        id: nextId++, array_id: f.id, array_name: nameOf(f.id), inverter_name: f.inv,
        title: spec[0], severity: spec[1], status: kase ? "ack" : "open",
        note: f.diagnosis || (f.st === "underperforming" ? "Pulling below peer cohort, check DC string / soiling." : null),
        created_at: created.toISOString(), updated_at: updated.toISOString()
      });
    });
    HISTORY.forEach(function (h) {
      var spec = TITLE_FROM_STATUS[h.st];
      var created = when(h.opened), closed = when(h.closed);
      events.push({
        id: nextId++, array_id: h.id, array_name: nameOf(h.id), inverter_name: h.inv,
        title: spec[0], severity: spec[1], status: "resolved", note: h.note,
        created_at: created.toISOString(), updated_at: closed.toISOString()
      });
    });
    events.sort(function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; });
    return { events: events };
  }

  D.get(/^\/v1\/array-owners\/alert-events$/, function () { return alertEvents(); });

  // ── files (per-site document store) ───────────────────────────────────────
  var FILES = [
    { id: 701, array_id: 1, filename: "Interconnection agreement.pdf", mime: "application/pdf", size: 418304, days: 212 },
    { id: 702, array_id: 1, filename: "Site layout.png", mime: "image/png", size: 1684021, days: 212 },
    { id: 703, array_id: 9, filename: "O&M contract, Green Peak O&M.pdf", mime: "application/pdf", size: 271360, days: 96 },
    { id: 704, array_id: 9, filename: "Inverter warranty, Fronius.pdf", mime: "application/pdf", size: 97280, days: 401 },
    { id: 705, array_id: 17, filename: "Interconnection agreement, Eversource.pdf", mime: "application/pdf", size: 389120, days: 301 },
    { id: 706, array_id: 19, filename: "As-built single-line.pdf", mime: "application/pdf", size: 655360, days: 153 },
    { id: 707, array_id: 19, filename: "Site lease, landowner.pdf", mime: "application/pdf", size: 204800, days: 488 },
    { id: 708, array_id: 12, filename: "Commissioning report.pdf", mime: "application/pdf", size: 1153433, days: 530 },
    { id: 709, array_id: 3, filename: "Spring inspection photos.zip", mime: "application/zip", size: 8493465, days: 158 }
  ];
  D.get(/^\/v1\/array-owners\/files$/, function () {
    var files = FILES.map(function (f) {
      return {
        id: f.id, array_id: f.array_id, array_name: nameOf(f.array_id),
        filename: f.filename, mime: f.mime, size: f.size,
        uploaded_at: at(D.daysAgo(f.days), "file" + f.id).toISOString()
      };
    }).sort(function (a, b) { return a.uploaded_at < b.uploaded_at ? 1 : -1; });
    return { files: files };
  });
})();
