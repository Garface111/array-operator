/* ============================================================================
 * Array Operator, sample-account data layer (demo-api.js)
 *
 * A signed-out visitor on arrayoperator.com gets the REAL app running on a
 * sample account ("Northeast Community Solar", see demo-data.js). Instead of
 * every screen growing its own fake "signed-out" UI, this file answers the
 * app's own API calls with sample data, so each screen renders through the
 * exact code path a paying operator sees.
 *
 *  · Active ONLY with no session (no localStorage.so_session). The moment a
 *    session exists every call goes straight to the network, untouched.
 *  · Reads (GET) on a registered route → sample JSON, after a short realistic
 *    latency. Unregistered reads pass through (and 401 like they always did).
 *  · Writes (POST/PUT/PATCH/DELETE) on app routes → 403 with the SAME body the
 *    backend's require_not_demo() returns ({error:"demo-read-only", ...}), plus
 *    one shared "this is a sample account" nudge. Nothing can be changed.
 *  · Auth / onboarding / telemetry endpoints are never intercepted.
 *
 * Route files live in /demo/*.js and are fetched ONLY for signed-out visitors
 * (a signed-in owner never downloads them). Each one calls
 *     AO_DEMO_API.get(/^\/v1\/...$/, function (req) { return {...}; });
 * where req = { method, path, query (URLSearchParams), body, match, url }.
 * A handler may return a plain object (→ 200 JSON), a Response, a Promise of
 * either, or AO_DEMO_API.PASS to let the request through to the network.
 *
 * Loaded right after demo-data.js and before every app module.
 * ==========================================================================*/
(function () {
  "use strict";

  var RAILWAY = "https://web-production-49c83.up.railway.app";
  // Bump when any public/demo/*.js file changes (they are cache-busted by this).
  var DEMO_V = "20261022b";
  var SURFACES = ["fleet", "repairs", "market", "analysis", "statements", "agent"];
  var READY_TIMEOUT_MS = 5000;

  var READ_ONLY_DETAIL =
    "This is a sample account, so nothing here can be changed. " +
    "Start free to do this with your own arrays.";

  // Never intercepted, even signed out: the sign-in / sign-up / error plumbing.
  var PASS_RE = /^\/v1\/(auth|onboarding|client-error|telemetry|feature-suggestion|providers|demo|public|signup|login|magic|stripe)(\/|$)/;

  function signedOut() {
    try { return !localStorage.getItem("so_session"); } catch (e) { return true; }
  }

  // ── Deterministic helpers shared by every sample surface ─────────────────
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) { return mulberry32(typeof seed === "number" ? seed : hashStr(seed)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // Local-calendar ISO date (never toISOString, which shifts a day near midnight).
  function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function isoMonth(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function daysAgo(n, hour, minute) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    if (hour != null) d.setHours(hour, minute || 0, 0, 0);
    return d;
  }
  function round(n, dp) { var f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }

  // Vermont-ish monthly yield shape (kWh per kW of nameplate), Jan..Dec.
  // Annual ≈ 1,200 kWh/kW, which is what a fixed-tilt array in VT/NH/ME makes.
  var MONTH_YIELD = [52, 71, 101, 121, 140, 147, 150, 136, 113, 83, 52, 40];

  // Per-site performance ratio. The sites FleetStore's simulated fleet flags
  // (fleet-store.js simulateFleet) read low here too, so Fleet, Analysis,
  // Repairs, Statements and Energy Agent all tell ONE story:
  //   8  North Branch Ridge  Inverter 1 underperforming (string fault, ~3 mo), Inverter 2 comm gap
  //   12 Blue Spruce Common  Inverter 3 underperforming, Inverter 7 comm gap
  //   3  Sawmill Ridge       Inverter 1 underperforming
  //   17 Ferry Crossing      Inverter 4 underperforming
  var STORY_PERF = { 8: 0.94, 12: 0.95, 3: 0.965, 17: 0.97 };
  function sitePerf(id) {
    if (STORY_PERF[id]) return STORY_PERF[id];
    return 0.985 + (rng(id * 7919)() - 0.5) * 0.05;
  }

  function sites() {
    var A = window.AO_DEMO || {};
    return (A.arrays || []).slice();
  }
  function site(id) {
    id = Number(id);
    var s = sites();
    for (var i = 0; i < s.length; i++) if (Number(s[i].id) === id) return s[i];
    return null;
  }

  // One monthly production history for the whole sample (settled months,
  // oldest first). Every surface that shows monthly kWh reads THIS, so totals
  // tie out across tabs. Each value depends ONLY on (site, calendar month), never
  // on how many months were asked for, so a 36-month Trends chart and a
  // 24-month Statements chart agree on every month they share.
  //   weather: one fleet-wide draw per month (a cloudy June is cloudy everywhere)
  //            plus a small per-site draw.
  //   age:     ~0.5%/yr degradation, so older months read slightly higher.
  // kWh for one calendar month `k` months ago (k = 0 is the month in progress,
  // projected to a full month). The single formula behind monthly and daily.
  function monthKwhFor(s, k) {
    var id = Number(s.id);
    var kw = Number(s.nameplate_kw) || 50;
    var perf = sitePerf(id);
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    var ym = isoMonth(d);
    var weather = 0.9 + rng("wx:" + ym)() * 0.14 + rng("wx:" + id + ":" + ym)() * 0.06;
    var age = 1 + 0.005 * (k / 12);
    var kwh = kw * MONTH_YIELD[d.getMonth()] * perf * weather * age;
    // North Branch Ridge's string fault started three months ago; before
    // that it ran like its healthy peers.
    if (id === 8 && k > 3) kwh = kwh / perf * 0.985;
    return { d: d, ym: ym, kwh: kwh };
  }

  function monthlyFor(s, months) {
    months = months || 24;
    if (!s) return [];
    var out = [];
    for (var k = months; k >= 1; k--) {
      var m = monthKwhFor(s, k);
      out.push({ month: m.ym, year: m.d.getFullYear(), month_num: m.d.getMonth() + 1, kwh: Math.round(m.kwh) });
    }
    return out;
  }
  function monthly(id, months) { return monthlyFor(site(id), months); }

  // Daily kWh for the last `days` days (oldest first). Each day's value depends
  // only on (site, date): the sky is shared fleet-wide that day plus a little
  // per-site jitter, and the days of a month are scaled so they SUM to that
  // month's monthly() figure, so Trends' day view and month view tie out exactly.
  function skyWeight(id, day) {
    var sky = rng("sky:" + day)();
    var w = sky < 0.18 ? 0.15 + sky * 1.6 : sky < 0.45 ? 0.55 + (sky - 0.18) : 0.88 + (sky - 0.45) * 0.36;
    return w * (0.96 + rng("sky:" + id + ":" + day)() * 0.08);
  }
  function dailyFor(s, days) {
    days = days || 30;
    if (!s) return [];
    var id = Number(s.id);
    var now = new Date();
    var monthCache = {};
    function monthScale(d) {
      var ym = isoMonth(d);
      if (monthCache[ym]) return monthCache[ym];
      var k = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
      var total = monthKwhFor(s, k).kwh;
      var n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      var sum = 0;
      for (var i = 1; i <= n; i++) sum += skyWeight(id, isoDate(new Date(d.getFullYear(), d.getMonth(), i)));
      return (monthCache[ym] = total / sum);
    }
    var out = [];
    for (var k = days; k >= 1; k--) {
      var d = daysAgo(k);
      var day = isoDate(d);
      out.push({ date: day, kwh: round(monthScale(d) * skyWeight(id, day), 1) });
    }
    return out;
  }
  function daily(id, days) { return dailyFor(site(id), days); }

  // ── Response helpers ─────────────────────────────────────────────────────
  function json(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json", "X-AO-Sample": "1" },
    });
  }

  var _nudgeAt = 0;
  function nudge(detail) {
    var now = Date.now();
    if (now - _nudgeAt < 2500) return;
    _nudgeAt = now;
    try {
      var el = document.getElementById("aoSampleNudge");
      if (!el) {
        el = document.createElement("div");
        el.id = "aoSampleNudge";
        el.className = "ao-sample-nudge";
        el.setAttribute("role", "status");
        document.body.appendChild(el);
      }
      el.innerHTML =
        '<span class="ao-sample-nudge-txt"></span>' +
        '<a class="ao-sample-nudge-cta" href="/onboarding">Start free &rarr;</a>';
      el.querySelector(".ao-sample-nudge-txt").textContent = detail || READ_ONLY_DETAIL;
      el.classList.remove("show");
      void el.offsetWidth;
      el.classList.add("show");
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove("show"); }, 4200);
    } catch (e) {}
  }

  function readOnly(detail) {
    nudge(detail);
    return json({ error: "demo-read-only", detail: detail || READ_ONLY_DETAIL, cta_url: "/onboarding" }, 403);
  }

  // ── Route table ──────────────────────────────────────────────────────────
  var routes = [];
  function add(method, re, fn) { routes.push({ m: method, re: re, fn: fn }); }

  function parse(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin && u.origin !== RAILWAY) return null;
    if (u.pathname.indexOf("/v1/") !== 0) return null;
    return u;
  }

  function parseBody(b) {
    if (b == null) return null;
    if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return b; } }
    return b;
  }

  function latency() {
    return new Promise(function (res) { setTimeout(res, 80 + Math.random() * 170); });
  }

  // Route files load only for signed-out visitors; the shim waits for them so
  // a module that fetches early still gets the sample answer.
  var ready = Promise.resolve();
  function loadSurfaces() {
    var all = Promise.all(SURFACES.map(function (name) {
      return new Promise(function (res) {
        var el = document.createElement("script");
        el.src = "/demo/" + name + ".js?v=" + DEMO_V;
        el.onload = el.onerror = function () { res(); };
        (document.head || document.documentElement).appendChild(el);
      });
    }));
    var timeout = new Promise(function (res) { setTimeout(res, READY_TIMEOUT_MS); });
    return Promise.race([all, timeout]);
  }

  var PASS = { pass: true };
  var _fetch = window.fetch ? window.fetch.bind(window) : null;

  function demoFetch(input, init) {
    if (!signedOut() || !_fetch) return _fetch(input, init);
    var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
    var u = parse(url);
    if (!u || PASS_RE.test(u.pathname)) return _fetch(input, init);
    var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();

    return ready.then(function () {
      var hit = null, m = null;
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (r.m !== method && !(r.m === "GET" && method === "HEAD")) continue;
        m = u.pathname.match(r.re);
        if (m) { hit = r; break; }
      }
      if (hit) {
        var req = {
          method: method, path: u.pathname, query: u.searchParams, url: u,
          match: m, body: parseBody(init && init.body),
        };
        return latency().then(function () { return hit.fn(req); }).then(function (out) {
          if (out === PASS) return _fetch(input, init);
          if (out instanceof Response) return out;
          return json(out == null ? {} : out);
        });
      }
      if (method !== "GET" && method !== "HEAD") return readOnly();
      return _fetch(input, init);
    });
  }

  if (_fetch) {
    window.fetch = demoFetch;
    if (signedOut()) {
      ready = loadSurfaces();
      try { document.documentElement.classList.add("ao-sample"); } catch (e) {}
    }
  }

  window.AO_DEMO_API = {
    on: signedOut,
    get: function (re, fn) { add("GET", re, fn); },
    post: function (re, fn) { add("POST", re, fn); },
    put: function (re, fn) { add("PUT", re, fn); },
    del: function (re, fn) { add("DELETE", re, fn); },
    PASS: PASS,
    ready: function () { return ready; },
    json: json,
    readOnly: readOnly,
    nudge: nudge,
    READ_ONLY_DETAIL: READ_ONLY_DETAIL,
    // data helpers
    rng: rng, hashStr: hashStr, round: round,
    isoDate: isoDate, isoMonth: isoMonth, daysAgo: daysAgo,
    sites: sites, site: site, sitePerf: sitePerf,
    monthly: monthly, daily: daily, monthlyFor: monthlyFor, dailyFor: dailyFor, MONTH_YIELD: MONTH_YIELD,
    account: function () { return (window.AO_DEMO || {}).account || {}; },
  };
})();
