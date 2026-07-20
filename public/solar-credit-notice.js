/* solar-credit-notice.js — one-time modal: statewide solar credit rate (Aug)
 *
 * This is the Vermont / utility net-metering solar credit rate that offtaker
 * invoices and $/kWh value estimates use — NOT Array Operator SaaS pricing.
 *
 * Show once per browser for signed-in owners until they dismiss.
 * Id key: ao_solar_credit_notice_v1 (bump to re-show after a new notice).
 */
(function () {
  "use strict";

  var NOTICE_ID = "solar-credit-aug-2026";
  var STORAGE_KEY = "ao_solar_credit_notice_v1";
  // Show through end of August; after that the notice is obsolete.
  var END_MS = Date.UTC(2026, 8, 1); // 2026-09-01 exclusive

  function session() {
    try {
      return localStorage.getItem("so_session");
    } catch (e) {
      return null;
    }
  }

  function dismissed() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setDismissed() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (e) {}
  }

  function shouldShow() {
    if (Date.now() >= END_MS) return false;
    if (!session()) return false;
    if (dismissed()) return false;
    return true;
  }

  function close(ov) {
    setDismissed();
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  function open() {
    if (!shouldShow()) return;
    if (document.getElementById("solarCreditNoticeOv")) return;

    var ov = document.createElement("div");
    ov.id = "solarCreditNoticeOv";
    ov.className = "scn-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-labelledby", "scnTitle");

    ov.innerHTML =
      '<div class="scn-card">' +
      '  <div class="scn-kicker">Statewide solar credit</div>' +
      '  <h2 id="scnTitle">Credit rate rises in August</h2>' +
      '  <p class="scn-body">' +
      "    Vermont’s <b>statewide solar credit rate</b> (the net-metering credit " +
      "    your offtakers earn per kWh on their utility bills) is increasing " +
      "    in <b>August&nbsp;2026</b>." +
      "  </p>" +
      '  <p class="scn-body">' +
      "    Array Operator uses that credit rate when drafting offtaker invoices " +
      "    and when we estimate the dollar value of your generation. " +
      "    Your current invoices keep today’s rate until the change takes effect; " +
      "    after August, new periods will use the updated statewide credit." +
      "  </p>" +
      '  <p class="scn-note">' +
      "    This is the utility solar credit — not Array Operator’s subscription price." +
      "  </p>" +
      '  <div class="scn-actions">' +
      '    <button type="button" class="scn-btn primary" id="scnOk">Got it</button>' +
      '    <a class="scn-btn ghost" href="#reports" id="scnReports">View offtaker billing</a>' +
      "  </div>" +
      "</div>";

    document.body.appendChild(ov);

    function dismiss() {
      close(ov);
    }

    ov.querySelector("#scnOk").addEventListener("click", dismiss);
    ov.querySelector("#scnReports").addEventListener("click", function () {
      dismiss();
    });
    ov.addEventListener("click", function (e) {
      if (e.target === ov) dismiss();
    });
    document.addEventListener(
      "keydown",
      function onKey(e) {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", onKey);
          dismiss();
        }
      },
      { once: false }
    );

    // Focus primary for a11y
    try {
      ov.querySelector("#scnOk").focus();
    } catch (e) {}
  }

  // Styles once
  if (!document.getElementById("scnStyles")) {
    var st = document.createElement("style");
    st.id = "scnStyles";
    st.textContent =
      ".scn-ov{position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;" +
      "padding:20px;background:rgba(14,20,32,.45);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}" +
      ".scn-card{max-width:420px;width:100%;border-radius:22px;padding:22px 22px 18px;" +
      "background:rgba(255,255,255,.92);border:1px solid rgba(255,255,255,.55);" +
      "box-shadow:0 24px 70px -18px rgba(15,50,110,.35);" +
      "font-family:\"Plus Jakarta Sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif;" +
      "color:#0E1420}" +
      ".scn-kicker{font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;" +
      "color:#1976D2;margin:0 0 6px}" +
      ".scn-card h2{margin:0 0 12px;font-size:20px;font-weight:780;letter-spacing:-.02em;line-height:1.25}" +
      ".scn-body{margin:0 0 10px;font-size:13.5px;line-height:1.5;color:#4C596B}" +
      ".scn-body b{color:#0E1420;font-weight:700}" +
      ".scn-note{margin:12px 0 0;padding:9px 11px;border-radius:12px;font-size:12px;line-height:1.4;" +
      "background:rgba(33,150,243,.08);color:#1565C0;border:1px solid rgba(33,150,243,.18)}" +
      ".scn-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;align-items:center}" +
      ".scn-btn{display:inline-flex;align-items:center;justify-content:center;border-radius:12px;" +
      "padding:9px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;" +
      "border:1px solid transparent}" +
      ".scn-btn.primary{background:linear-gradient(180deg,#42a5f5,#1976D2);color:#fff;border:none;" +
      "box-shadow:0 6px 16px rgba(25,118,210,.28)}" +
      ".scn-btn.primary:hover{filter:brightness(1.05)}" +
      ".scn-btn.ghost{background:transparent;color:#1976D2;border-color:rgba(25,118,210,.28)}" +
      ".scn-btn.ghost:hover{background:rgba(33,150,243,.08)}" +
      "html:not(.sky) .scn-card{background:#fff;border-color:#e2e8f0}" +
      "@media(max-width:480px){.scn-card{padding:18px 16px 14px}.scn-card h2{font-size:18px}}";
    document.head.appendChild(st);
  }

  function tryOpen() {
    if (!shouldShow()) return;
    // Slight delay so the shell paints first; doesn't fight login splash.
    setTimeout(open, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryOpen);
  } else {
    tryOpen();
  }
  // Session may appear after ?token= handoff
  setTimeout(tryOpen, 1800);
  window.addEventListener("storage", function (e) {
    if (e && e.key === "so_session" && e.newValue) tryOpen();
  });

  window.__aoSolarCreditNotice = { open: open, NOTICE_ID: NOTICE_ID };
})();
