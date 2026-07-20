/* session-ping.js — time-on-site instrumentation
 *
 * Pings POST /v1/telemetry/ping once on load and every 60s while:
 *   - the tab is visible (document.visibilityState === 'visible')
 *   - the user has a so_session (signed in)
 * Hidden tabs stop the timer; returning to visible pings immediately.
 * One server row per tenant per minute — honest wall-clock minutes on site.
 */
(function () {
  "use strict";
  var INTERVAL_MS = 60000;
  var timer = null;
  var inFlight = false;

  function session() {
    try { return localStorage.getItem("so_session"); } catch (e) { return null; }
  }

  function path() {
    try {
      return (location.pathname || "/") + (location.hash || "");
    } catch (e) {
      return "/";
    }
  }

  function ping() {
    if (document.visibilityState !== "visible") return;
    var s = session();
    if (!s) return;
    if (inFlight) return;
    inFlight = true;
    fetch("/v1/telemetry/ping", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + s,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: path() }),
      keepalive: true,
    }).catch(function () { /* silent — never break the app for telemetry */ })
      .finally(function () { inFlight = false; });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function start() {
    stop();
    if (!session()) return;
    if (document.visibilityState !== "visible") return;
    ping();
    timer = setInterval(ping, INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") start();
    else stop();
  });

  // Session can appear after magic-link / onboarding handoff mid-page.
  window.addEventListener("storage", function (e) {
    if (e && e.key === "so_session") {
      if (e.newValue) start();
      else stop();
    }
  });

  // Also re-check shortly after load (token may be set by ?token= scrub).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      start();
      setTimeout(start, 1500);
    });
  } else {
    start();
    setTimeout(start, 1500);
  }

  // Expose for debugging
  window.__aoSessionPing = { ping: ping, start: start, stop: stop };
})();
