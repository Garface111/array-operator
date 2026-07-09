/* error-reporter.js — whole-system browser error capture (Array Operator).
 *
 * Catches uncaught errors + unhandled promise rejections and POSTs a compact,
 * capped report to the shared backend /v1/client-error, which routes it through
 * the same Sentry + internal-alert pipeline as server errors. One backend DSN
 * covers the whole EnergyAgent system — no separate frontend Sentry project.
 *
 * Defensive: never throws, dedupes repeats, throttles, and silently no-ops if
 * the network call fails (an error reporter must never cause errors).
 */
(function () {
  "use strict";
  var SOURCE = "arrayoperator";
  // Same-origin in prod (Netlify proxies /v1/* to Railway); direct on local preview.
  var API_BASE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname)
    ? "https://web-production-49c83.up.railway.app" : "";
  var seen = {};            // signature -> last-sent ms (dedupe identical errors)
  var DEDUPE_MS = 60000;    // don't resend the same error within 60s
  // ROLLING-window rate limit (not a session-lifetime cap). This used to be a
  // `sentCount >= 20` counter that NEVER reset, so after 20 reports the whole error
  // reporter went permanently silent for the session -- a cascade of DISTINCT errors
  // (a broken build, a cascading render fault) blew past 20 instantly and then the
  // worst incident got muted while the app kept breaking. The 60s per-signature
  // dedupe below already stops same-error floods, so the cap's only job is a burst
  // ceiling -- make it self-heal (Ford, 2026-07-09: never permanently disarm to
  // conserve reports to our own Sentry). When the ceiling IS hit, send ONE marker so
  // the silence is itself a signal, not invisible.
  var sendTimes = [];       // ms timestamps of recent sends (pruned to the window)
  var WINDOW_MS = 60000, MAX_PER_WINDOW = 20;
  var suppressedNotified = false;

  function _send(payload) {
    // sendBeacon survives page unloads; fall back to fetch.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API_BASE + "/v1/client-error",
        new Blob([payload], { type: "application/json" }));
    } else {
      fetch(API_BASE + "/v1/client-error", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: payload, keepalive: true,
      }).catch(function () {});
    }
  }

  function report(message, stack, kind) {
    try {
      message = String(message || "").slice(0, 500);
      stack = String(stack || "").slice(0, 4000);
      if (!message && !stack) return;
      var sig = (kind || "") + "|" + message;
      var now = Date.now();
      if (seen[sig] && now - seen[sig] < DEDUPE_MS) return;

      // Prune sends older than the rolling window, then enforce the burst ceiling.
      var cutoff = now - WINDOW_MS;
      while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
      if (sendTimes.length >= MAX_PER_WINDOW) {
        if (!suppressedNotified) {   // one marker per suppression episode, so silence is visible
          suppressedNotified = true;
          _send(JSON.stringify({
            source: SOURCE, kind: "reporter_suppressed",
            message: "error-reporter hit " + MAX_PER_WINDOW + "/" + (WINDOW_MS / 1000) +
                     "s burst ceiling; further reports throttled until it drains",
            url: location.href.slice(0, 300),
          }));
        }
        return;
      }
      suppressedNotified = false;   // back under the ceiling -> re-arm the marker
      seen[sig] = now;
      sendTimes.push(now);
      _send(JSON.stringify({
        source: SOURCE, message: message, stack: stack,
        url: location.href.slice(0, 300), kind: kind || "error",
      }));
    } catch (_) { /* an error reporter must never throw */ }
  }

  window.addEventListener("error", function (e) {
    var msg = e && e.message ? e.message : "uncaught error";
    var stack = e && e.error && e.error.stack ? e.error.stack
      : (e && e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : "");
    report(msg, stack, "error");
  });

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = r && r.message ? r.message : String(r || "unhandled rejection");
    var stack = r && r.stack ? r.stack : "";
    report(msg, stack, "unhandledrejection");
  });

  // Expose a manual hook so app code can report caught errors it wants visibility on.
  window.AOReportError = function (message, stack) { report(message, stack, "manual"); };
})();
