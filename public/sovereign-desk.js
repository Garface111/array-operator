/* Sovereign Desk — private Ford ↔ Sovereign chat (rich markdown UI).
 * Visible when GET /v1/sovereign/desk/access returns desk:true.
 * Hash: #sovereign. Chat-only; no ops rail / worker dumps.
 */
(function () {
  "use strict";

  // Chat + turn status go direct to Railway so Netlify's ~60s edge proxy cannot
  // 504 a slow brain. History/access stay same-origin (fast).
  var RAIL_API = "https://web-production-49c83.up.railway.app";
  var API = {
    access: "/v1/sovereign/desk/access",
    history: "/v1/sovereign/desk/history",
    chat: RAIL_API + "/v1/sovereign/desk/chat",
    turn: RAIL_API + "/v1/sovereign/desk/turn",
    cancel: RAIL_API + "/v1/sovereign/desk/cancel",
    upload: "/v1/sovereign/desk/upload",
    bridgeStatus: "/v1/sovereign/desk/bridge/status",
  };

  var DRAFT_KEY = "sov_desk_draft_v1";
  var PENDING_KEY = "sov_desk_pending_v1";

  var state = {
    allowed: false,
    email: null,
    loading: false,
    sending: false,
    messages: [],
    pollTimer: null,
    booted: false,
    // Voice → text (Web Speech API)
    listening: false,
    recognition: null,
    baseText: "", // textarea content before this listening session
    interim: "",
    // File / data attachments for the next send
    attachments: [], // {id, filename, mime, size, preview}
    bridgeOnline: null,
    // In-flight durable send
    activeCrid: null,
    activeFordId: null,
    userCancelled: false,
    fetchCtrl: null,
  };

  function newClientRequestId() {
    return (
      "cr_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function saveDraft(text) {
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
  }

  function loadDraft() {
    try {
      return localStorage.getItem(DRAFT_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function savePendingTurn(p) {
    try {
      if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }

  function loadPendingTurn() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function authHeaders() {
    var h = { "Content-Type": "application/json", Accept: "application/json" };
    try {
      var s = localStorage.getItem("so_session");
      if (s) h.Authorization = "Bearer " + s;
    } catch (e) {}
    return h;
  }

  function hasSession() {
    try {
      return !!localStorage.getItem("so_session");
    } catch (e) {
      return false;
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Format timestamp as relative time (e.g., "2 minutes ago", "3 hours ago").
   *  Fixes #27: timestamps were all showing "just now" incorrectly. */
  function formatRelativeTime(isoString) {
    if (!isoString) return "just now";
    try {
      var then = new Date(isoString).getTime();
      var now = Date.now();
      var diffMs = now - then;
      
      // Handle future timestamps (clock skew)
      if (diffMs < 0) diffMs = 0;
      
      var diffSec = Math.floor(diffMs / 1000);
      var diffMin = Math.floor(diffSec / 60);
      var diffHr = Math.floor(diffMin / 60);
      var diffDay = Math.floor(diffHr / 24);
      
      if (diffSec < 10) return "just now";
      if (diffSec < 60) return diffSec + " seconds ago";
      if (diffMin === 1) return "1 minute ago";
      if (diffMin < 60) return diffMin + " minutes ago";
      if (diffHr === 1) return "1 hour ago";
      if (diffHr < 24) return diffHr + " hours ago";
      if (diffDay === 1) return "1 day ago";
      if (diffDay < 7) return diffDay + " days ago";
      
      // For older messages, show the actual date
      var d = new Date(isoString);
      var month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      return month + " " + d.getDate();
    } catch (e) {
      return "just now";
    }
  }

  /** Drop trailing side-effect JSON (and fenced leaks) so chat never shows raw mind JSON. */
  function stripSideJson(text) {
    var t = String(text || "");
    var cut = t.indexOf("---JSON---");
    if (cut >= 0) t = t.slice(0, cut);
    // trailing fenced ```json { monologue/actions ... } ```
    t = t.replace(
      /\n?```(?:json|JSON)?\s*\n?\{[\s\S]*"(?:actions|monologue|ford_ask|mood|succession_gap|memory_writes)"[\s\S]*?\}\s*\n?```\s*$/i,
      ""
    );
    // bare trailing { ... } with side-meta keys
    t = t.replace(
      /\n?\{[\s\S]*"(?:actions|monologue|ford_ask|mood|succession_gap|memory_writes)"[\s\S]*?\}\s*$/i,
      ""
    );
    return t.trim();
  }

  function renderMessage(msg) {
    var role = msg.role || "user";
    var text = stripSideJson(msg.content || "");
    var ts = msg.created_at || msg.timestamp;
    var relTime = formatRelativeTime(ts);
    
    var cls = role === "assistant" ? "sd-msg sd-sov" : "sd-msg sd-ford";
    var label = role === "assistant" ? "Sovereign" : "You";
    
    var html = '<div class="' + cls + '"><div class="sd-msg-meta"><span class="sd-msg-lbl">' +
      esc(label) + '</span><span class="sd-msg-ts" data-timestamp="' + esc(ts) + '">' +
      esc(relTime) + "</span></div><div class=\"sd-msg-txt\">" +
      renderMarkdown(text) + "</div></div>";
    return html;
  }

  /** Update all visible timestamps to show correct relative time */
  function refreshTimestamps() {
    var els = document.querySelectorAll(".sd-msg-ts[data-timestamp]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var ts = el.getAttribute("data-timestamp");
      if (ts) {
        el.textContent = formatRelativeTime(ts);
      }
    }
  }

  function renderMarkdown(text) {
    var html = esc(text);
    // bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // inline code
    html = html.replace(/`([^`]+)`/g, '<code class="sd-code">$1</code>');
    // links
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    // newlines
    html = html.replace(/\n/g, "<br>");
    return html;
  }

  function scrollToBottom() {
    var container = document.getElementById("sdMsgs");
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function renderMessages() {
    var container = document.getElementById("sdMsgs");
    if (!container) return;
    var html = "";
    for (var i = 0; i < state.messages.length; i++) {
      html += renderMessage(state.messages[i]);
    }
    container.innerHTML = html;
    scrollToBottom();
  }

  function showError(msg) {
    var el = document.getElementById("sdError");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function setLoading(yes) {
    state.loading = yes;
    var btn = document.getElementById("sdSend");
    if (btn) btn.disabled = yes || state.sending;
  }

  function setSending(yes) {
    state.sending = yes;
    var btn = document.getElementById("sdSend");
    if (btn) {
      btn.disabled = yes || state.loading;
      btn.textContent = yes ? "Sending…" : "Send";
    }
  }

  async function loadHistory() {
    setLoading(true);
    showError("");
    try {
      var resp = await fetch(API.history, { headers: authHeaders() });
      if (!resp.ok) throw new Error("Failed to load history");
      var data = await resp.json();
      state.messages = data.messages || [];
      renderMessages();
      // Start timestamp refresh interval
      if (!state.pollTimer) {
        state.pollTimer = setInterval(refreshTimestamps, 30000); // Update every 30s
      }
    } catch (err) {
      showError("Could not load chat history: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage() {
    var input = document.getElementById("sdInput");
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;

    setSending(true);
    showError("");

    var crid = newClientRequestId();
    state.activeCrid = crid;
    state.userCancelled = false;

    try {
      // Optimistically add user message
      state.messages.push({
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      });
      renderMessages();
      input.value = "";
      saveDraft("");

      var payload = {
        message: text,
        client_request_id: crid,
        attachments: state.attachments,
      };

      state.fetchCtrl = new AbortController();
      var resp = await fetch(API.chat, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: state.fetchCtrl.signal,
      });

      if (!resp.ok) throw new Error("Chat request failed");
      var data = await resp.json();

      if (data.ford_id) {
        state.activeFordId = data.ford_id;
        await pollTurnStatus(data.ford_id, crid);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        showError("Message cancelled");
      } else {
        showError("Send failed: " + err.message);
      }
    } finally {
      setSending(false);
      state.activeCrid = null;
      state.activeFordId = null;
      state.fetchCtrl = null;
    }
  }

  async function pollTurnStatus(fordId, crid) {
    var maxAttempts = 120; // 2 minutes
    var attempt = 0;

    while (attempt < maxAttempts && !state.userCancelled) {
      try {
        var resp = await fetch(
          API.turn + "?ford_id=" + encodeURIComponent(fordId),
          { headers: authHeaders() }
        );
        if (!resp.ok) throw new Error("Status check failed");
        var data = await resp.json();

        if (data.status === "complete" && data.reply) {
          state.messages.push({
            role: "assistant",
            content: data.reply,
            created_at: new Date().toISOString(),
          });
          renderMessages();
          return;
        }

        if (data.status === "error") {
          throw new Error(data.error || "Turn failed");
        }

        await sleep(1000);
        attempt++;
      } catch (err) {
        showError("Status check error: " + err.message);
        return;
      }
    }

    if (attempt >= maxAttempts) {
      showError("Response timeout - please refresh");
    }
  }

  function cancelSend() {
    if (state.fetchCtrl) {
      state.fetchCtrl.abort();
    }
    if (state.activeFordId) {
      fetch(API.cancel, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ford_id: state.activeFordId }),
      }).catch(function () {});
    }
    state.userCancelled = true;
  }

  function handleInput() {
    var input = document.getElementById("sdInput");
    if (input) {
      saveDraft(input.value);
    }
  }

  function initUI() {
    var input = document.getElementById("sdInput");
    if (input) {
      input.value = loadDraft();
      input.addEventListener("input", handleInput);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    var btn = document.getElementById("sdSend");
    if (btn) {
      btn.addEventListener("click", sendMessage);
    }

    var cancelBtn = document.getElementById("sdCancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", cancelSend);
    }
  }

  async function fetchAccessWithRetry() {
    // Same-origin first (Netlify→Railway proxy). On gateway failures, fall back
    // direct to Railway so a wedged edge proxy cannot brick the desk.
    var urls = [API.access, RAIL_API + "/v1/sovereign/desk/access"];
    var lastErr = null;
    for (var u = 0; u < urls.length; u++) {
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
          var timer = ctrl
            ? setTimeout(function () {
                try {
                  ctrl.abort();
                } catch (e) {}
              }, 12000)
            : null;
          var resp = await fetch(urls[u], {
            headers: authHeaders(),
            signal: ctrl ? ctrl.signal : undefined,
          });
          if (timer) clearTimeout(timer);
          // Transient gateway / cold-start — retry, then try next URL
          if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
            lastErr = new Error(
              "API temporarily unavailable (HTTP " + resp.status + ")"
            );
            await sleep(400 * (attempt + 1));
            continue;
          }
          if (!resp.ok) {
            throw new Error("Access check failed (HTTP " + resp.status + ")");
          }
          return await resp.json();
        } catch (err) {
          lastErr = err;
          // Network / abort — short backoff then retry
          if (attempt < 2) await sleep(350 * (attempt + 1));
        }
      }
    }
    throw lastErr || new Error("Access check failed");
  }

  /** NEVER write document.body — that wiped the whole Array Operator app for
   * every owner when desk was disabled (lockout bug, 2026-07-16).
   * All status UI stays inside #panelSovereign only. */
  function deskPanel() {
    return document.getElementById("panelSovereign");
  }

  function hideDeskAndLeave() {
    state.allowed = false;
    var p = deskPanel();
    if (p) {
      p.hidden = true;
      p.classList.remove("active");
      // Clear any prior status markup; leave empty hidden panel
      // Do NOT put customer-facing "access not enabled" on the main stage.
    }
    // If user is on #sovereign, bounce them back to the normal app
    if ((location.hash || "") === "#sovereign") {
      try {
        location.hash = "#arrays";
      } catch (e) {}
    }
  }

  function showDeskPanelStatus(html) {
    var p = deskPanel();
    if (!p) return;
    p.hidden = false;
    p.removeAttribute("hidden");
    p.classList.add("active");
    p.innerHTML =
      '<div class="sd-gate" style="padding:2rem;max-width:36rem;margin:2rem auto;color:var(--muted,#64748b)">' +
      html +
      "</div>";
  }

  async function checkAccess() {
    // Not signed in → silent no-op on normal tabs; only gate if on #sovereign
    if (!hasSession()) {
      if ((location.hash || "") === "#sovereign") {
        hideDeskAndLeave();
      }
      return false;
    }

    try {
      var data = await fetchAccessWithRetry();

      if (!data || !data.desk) {
        // Desk off / not allowlisted: never brick the app
        hideDeskAndLeave();
        return false;
      }

      state.allowed = true;
      state.email = data.email;
      // Only build chat UI once allowed
      ensureDeskChrome();
      initUI();
      await loadHistory();
      return true;
    } catch (err) {
      // Network / API failure: do NOT replace the app shell.
      // Only surface a message if they deliberately opened #sovereign.
      if ((location.hash || "") === "#sovereign") {
        var msg = (err && err.message) || "Access check failed";
        if (err && err.name === "AbortError") {
          msg = "API timed out — try again in a moment.";
        }
        showDeskPanelStatus(
          "Desk unavailable: " +
            esc(msg) +
            ' <button type="button" id="sdRetryAccess" style="margin-left:0.75rem;cursor:pointer">Retry</button>' +
            ' <button type="button" id="sdLeaveDesk" style="margin-left:0.5rem;cursor:pointer">Back to app</button>'
        );
        var rb = document.getElementById("sdRetryAccess");
        if (rb) {
          rb.addEventListener("click", function () {
            state.booted = false;
            boot({ force: true });
          });
        }
        var leave = document.getElementById("sdLeaveDesk");
        if (leave) {
          leave.addEventListener("click", function () {
            hideDeskAndLeave();
          });
        }
      } else {
        hideDeskAndLeave();
      }
      return false;
    }
  }

  function ensureDeskChrome() {
    var p = deskPanel();
    if (!p) return;
    // If panel was replaced with a gate message, restore minimal chat chrome
    if (!document.getElementById("sdMsgs") || !document.getElementById("sdInput")) {
      p.innerHTML =
        '<div class="sd-shell">' +
        '<div class="sd-head"><strong>Energy Agent Prime</strong> <span class="sd-sub">private desk</span></div>' +
        '<div id="sdError" class="sd-error" style="display:none"></div>' +
        '<div id="sdMsgs" class="sd-msgs"></div>' +
        '<div class="sd-compose">' +
        '<textarea id="sdInput" class="sd-input" rows="3" placeholder="Message…"></textarea>' +
        '<div class="sd-actions">' +
        '<button type="button" id="sdCancel" class="sd-btn">Stop</button>' +
        '<button type="button" id="sdSend" class="sd-btn sd-btn-primary">Send</button>' +
        "</div></div></div>";
    }
    p.hidden = false;
    p.removeAttribute("hidden");
    p.classList.add("active");
  }

  /**
   * Safe boot: never auto-destroy the owner app.
   * - Normal tabs: no access probe that can brick the page.
   * - #sovereign only: check access; if denied, leave silently.
   */
  async function boot(opts) {
    opts = opts || {};
    var onSov = (location.hash || "") === "#sovereign" || opts.force;
    if (!onSov) {
      // Idle: do not call access, do not touch the DOM shell
      return false;
    }
    if (state.booted && state.allowed && !opts.force) return true;
    state.booted = true;
    return !!(await checkAccess());
  }

  // Public hooks used by sandbox applyView()
  window.__aoSovereignDeskBoot = function () {
    return boot({ force: (location.hash || "") === "#sovereign" });
  };
  window.__aoOpenSovereignDesk = function () {
    if (!state.allowed) return;
    ensureDeskChrome();
    initUI();
  };

  // Hash changes: only engage desk on #sovereign
  window.addEventListener("hashchange", function () {
    if ((location.hash || "") === "#sovereign") {
      state.booted = false;
      boot({ force: true });
    }
  });

  // Do NOT auto-boot on every page load (that caused the lockout).
  // Only if the user landed directly on #sovereign.
  function maybeBootIfSovereign() {
    if ((location.hash || "") === "#sovereign") {
      boot({ force: true });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeBootIfSovereign);
  } else {
    maybeBootIfSovereign();
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", function () {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
  });
})();
