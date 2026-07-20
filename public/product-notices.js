/* product-notices.js — small, dismissible product announcements
 *
 * Use this for anything like a rate change, maintenance window, or policy
 * heads-up. Add a row to AO_PRODUCT_NOTICES below; no other wiring needed.
 *
 * Each notice:
 *   id        — stable string; dismissal is stored as ao_notice_dismiss_<id>
 *   starts    — ISO date (inclusive) when to show, or null = immediately
 *   ends      — ISO date (exclusive) when to stop, or null = never auto-hide
 *   tone      — "urgent" | "neutral" | "success" (trial-nudge CSS classes)
 *   audience  — "signed_in" | "all"
 *   html      — copy (may include <b>); keep short
 *   cta       — optional { label, href }  href may be "#account" hash or URL
 *
 * August 2026 rate increase is the first live notice. When the change is done
 * or the window passes, set ends or remove the entry.
 */
(function () {
  "use strict";

  /** @type {Array<{
   *   id: string,
   *   starts?: string|null,
   *   ends?: string|null,
   *   tone?: string,
   *   audience?: string,
   *   html: string,
   *   cta?: { label: string, href: string }|null
   * }>} */
  var AO_PRODUCT_NOTICES = [
    {
      id: "rate-increase-2026-08",
      starts: "2026-07-01",
      ends: "2026-09-01",
      tone: "urgent",
      audience: "signed_in",
      html:
        "Starting <b>August&nbsp;1,&nbsp;2026</b>, Array Operator rates increase. " +
        "Your current pricing stays through July — nothing changes until August.",
      cta: { label: "Account & billing", href: "#account" },
    },
  ];

  // Expose for ops/debug and so future tools can append notices at runtime.
  window.AO_PRODUCT_NOTICES = AO_PRODUCT_NOTICES;

  function dismissKey(id) {
    return "ao_notice_dismiss_" + id;
  }

  function isDismissed(id) {
    try {
      return localStorage.getItem(dismissKey(id)) === "1";
    } catch (e) {
      return false;
    }
  }

  function setDismissed(id) {
    try {
      localStorage.setItem(dismissKey(id), "1");
    } catch (e) {}
  }

  function parseDay(iso) {
    if (!iso) return null;
    // Date-only → UTC midnight so "2026-08-01" means calendar day, not local TZ surprises.
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function inWindow(n, nowMs) {
    var s = parseDay(n.starts);
    var e = parseDay(n.ends);
    if (s != null && nowMs < s) return false;
    if (e != null && nowMs >= e) return false;
    return true;
  }

  function hasSession() {
    try {
      return !!localStorage.getItem("so_session");
    } catch (e) {
      return false;
    }
  }

  function host() {
    return document.getElementById("productNotices");
  }

  function render() {
    var el = host();
    if (!el) return;
    var nowMs = Date.now();
    var signedIn = hasSession();
    var list = window.AO_PRODUCT_NOTICES || [];
    el.innerHTML = "";

    list.forEach(function (n) {
      if (!n || !n.id || !n.html) return;
      if (isDismissed(n.id)) return;
      if (!inWindow(n, nowMs)) return;
      var aud = n.audience || "signed_in";
      if (aud === "signed_in" && !signedIn) return;

      var bar = document.createElement("div");
      bar.className = "trial-nudge product-notice";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Product notice");
      bar.dataset.noticeId = n.id;
      if (n.tone === "urgent") bar.classList.add("urgent");
      else if (n.tone === "success") bar.classList.add("success");
      else bar.classList.add("neutral");

      var row = document.createElement("div");
      row.className = "trial-nudge-row";

      var copy = document.createElement("div");
      copy.className = "trial-nudge-copy";
      copy.innerHTML = n.html;

      row.appendChild(copy);

      if (n.cta && n.cta.label && n.cta.href) {
        var cta = document.createElement("a");
        cta.className = "trial-nudge-cta";
        cta.textContent = n.cta.label;
        cta.href = n.cta.href;
        if (n.cta.href.charAt(0) === "#") {
          cta.addEventListener("click", function (ev) {
            // Let hash routing run; no preventDefault.
          });
        } else {
          cta.target = "_blank";
          cta.rel = "noopener";
        }
        row.appendChild(cta);
      }

      var x = document.createElement("button");
      x.type = "button";
      x.className = "trial-nudge-x";
      x.setAttribute("aria-label", "Dismiss");
      x.title = "Dismiss";
      x.textContent = "×";
      x.addEventListener("click", function () {
        setDismissed(n.id);
        bar.remove();
        if (!el.children.length) el.hidden = true;
      });
      row.appendChild(x);

      bar.appendChild(row);
      el.appendChild(bar);
    });

    el.hidden = el.children.length === 0;
  }

  window.__aoRenderProductNotices = render;

  // Re-show when session appears (login) or hash-only navigations don't remount.
  window.addEventListener("storage", function (e) {
    if (e && e.key === "so_session") render();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      render();
      // After app.js may mint ?token= → so_session
      setTimeout(render, 800);
      setTimeout(render, 2500);
    });
  } else {
    render();
    setTimeout(render, 800);
  }
})();
