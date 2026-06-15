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
  var sentCount = 0, MAX_PER_SESSION = 20;   // hard cap so a loop can't flood

  function report(message, stack, kind) {
    try {
      if (sentCount >= MAX_PER_SESSION) return;
      message = String(message || "").slice(0, 500);
      stack = String(stack || "").slice(0, 4000);
      if (!message && !stack) return;
      var sig = (kind || "") + "|" + message;
      var now = Date.now();
      if (seen[sig] && now - seen[sig] < DEDUPE_MS) return;
      seen[sig] = now;
      sentCount++;
      var payload = JSON.stringify({
        source: SOURCE, message: message, stack: stack,
        url: location.href.slice(0, 300), kind: kind || "error",
      });
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
