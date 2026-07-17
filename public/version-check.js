// version-check.js, surface a fresh deploy so nobody is stuck on a cached old bundle.
// Ford 2026-07-09: a soft refresh kept serving a STALE reports.js, so shipped fixes
// looked "not applied" until a manual hard-refresh. This polls the LIVE app-shell for a
// newer cache-bust version than the one THIS page loaded, and offers a one-click reload.
// It NEVER auto-reloads, an operator may be mid-edit / mid-approval, so the reload is
// always the user's explicit click (dismissible).
//
// Ford 2026-07-16: it only ever watched reports.js. The shell versions ~15 assets, so a
// deploy that bumped energy-agent.js (or app.js, or any stylesheet) was INVISIBLE — the
// tab sat on stale code for hours with no banner and no signal. Worse than useless: it
// looked like staleness was covered. It now compares EVERY versioned asset this page
// actually loaded against the live shell, and speaks up if any of them moved.
(function () {
  "use strict";

  var ASSET_RE = /([A-Za-z0-9_.-]+\.(?:js|css))\?v=([^&"'\s>]+)/g;

  /** file -> token for every versioned asset THIS page loaded. */
  function myTokens() {
    var out = {};
    try {
      var nodes = document.querySelectorAll("script[src], link[href]");
      for (var i = 0; i < nodes.length; i++) {
        var url = nodes[i].getAttribute("src") || nodes[i].getAttribute("href") || "";
        var m = /([A-Za-z0-9_.-]+\.(?:js|css))\?v=([^&"'\s]+)/.exec(url);
        if (m) out[m[1]] = m[2];
      }
    } catch (_) {}
    return out;
  }

  /** file -> token from the live shell HTML. */
  function liveTokens(html) {
    var out = {}, m;
    ASSET_RE.lastIndex = 0;
    while ((m = ASSET_RE.exec(html))) out[m[1]] = m[2];
    return out;
  }

  var MINE = myTokens();
  if (!Object.keys(MINE).length) return;     // can't determine our version → stay inert
  var shown = false, timer = null;

  function showBanner() {
    if (shown || !document.body) return;
    shown = true;
    if (timer) { clearInterval(timer); timer = null; }   // stop polling once surfaced

    var wrap = document.createElement("div");
    wrap.id = "ao-update-bar";
    wrap.style.cssText = [
      "position:fixed", "left:50%", "bottom:20px", "transform:translateX(-50%)",
      "z-index:2147483647", "display:flex", "gap:12px", "align-items:center",
      "background:#0b8a4b", "color:#fff", "padding:11px 12px 11px 16px",
      "border-radius:12px", "box-shadow:0 10px 30px -10px rgba(0,0,0,.55)",
      "font:600 13px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif", "max-width:92vw"
    ].join(";");

    var msg = document.createElement("span");
    msg.textContent = "A new version of Array Operator is available.";

    var btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText = "background:#fff;color:#0b8a4b;border:0;border-radius:8px;padding:7px 14px;"
      + "font:700 12.5px system-ui,sans-serif;cursor:pointer;flex:0 0 auto";
    btn.onclick = function () { try { location.reload(); } catch (_) { location.href = location.pathname + location.search; } };

    var x = document.createElement("button");
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "✕";
    x.style.cssText = "background:transparent;color:#fff;border:0;opacity:.7;cursor:pointer;"
      + "font-size:13px;padding:2px 6px;flex:0 0 auto";
    x.onclick = function () { try { wrap.remove(); } catch (_) {} };

    wrap.appendChild(msg); wrap.appendChild(btn); wrap.appendChild(x);
    document.body.appendChild(wrap);
  }

  function check() {
    if (shown) return;
    // Cache-busting fetch of the app shell so we read the LIVE deployed version, never a
    // cached copy. (index.html itself is max-age=0,must-revalidate, but no-store is belt
    // + suspenders against an intermediary.)
    fetch("/index.html?_ck=" + Date.now(), { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var live = liveTokens(html);
        // Only compare assets we ACTUALLY loaded: a file merely added or removed upstream
        // shouldn't nag someone mid-approval, but any asset of ours that moved means this
        // tab is running code that no longer exists on the server.
        for (var file in MINE) {
          if (!Object.prototype.hasOwnProperty.call(MINE, file)) continue;
          if (live[file] && live[file] !== MINE[file]) { showBanner(); return; }
        }
      })
      .catch(function () { /* offline / transient, try again next tick */ });
  }

  // Poll gently, and opportunistically when the tab regains attention (deploys often land
  // while a tester's tab sits idle in the background).
  timer = setInterval(check, 90000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
  window.addEventListener("focus", check);
  setTimeout(check, 8000);                  // one early check shortly after load
})();
