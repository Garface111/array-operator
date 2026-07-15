/* Sovereign Desk — private Ford ↔ Sovereign chat (not Energy Agent).
 * Visible only when GET /v1/sovereign/desk/access returns desk:true
 * (ford.genereaux@gmail.com + allowlist). Hash: #sovereign
 */
(function () {
  "use strict";

  var API = {
    access: "/v1/sovereign/desk/access",
    history: "/v1/sovereign/desk/history",
    chat: "/v1/sovereign/desk/chat",
  };

  var state = {
    allowed: false,
    email: null,
    loading: false,
    sending: false,
    messages: [],
  };

  function authHeaders() {
    var h = { "Content-Type": "application/json", Accept: "application/json" };
    try {
      var s = localStorage.getItem("so_session");
      if (s) h.Authorization = "Bearer " + s;
    } catch (e) {}
    return h;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureShell() {
    var sec = document.getElementById("panelSovereign");
    if (!sec) {
      var wrap = document.querySelector(".wrap") || document.body;
      sec = document.createElement("section");
      sec.className = "panel";
      sec.id = "panelSovereign";
      sec.setAttribute("role", "tabpanel");
      sec.setAttribute("aria-label", "Sovereign desk");
      wrap.appendChild(sec);
    }
    if (sec.querySelector(".sov-desk")) return;
    sec.hidden = false;
    sec.innerHTML =
      '<div class="sov-desk">' +
      '  <header class="sov-desk-head">' +
      '    <div class="sov-desk-brand">' +
      '      <div class="sov-desk-mark" aria-hidden="true"></div>' +
      '      <div>' +
      '        <h1>Sovereign</h1>' +
      '        <p class="sov-desk-sub">Array Operator leadership desk · private with Ford</p>' +
      "      </div>" +
      "    </div>" +
      '    <div class="sov-desk-meta" id="sovDeskMeta">Developer only</div>' +
      "  </header>" +
      '  <div class="sov-desk-body" id="sovDeskMsgs"></div>' +
      '  <form class="sov-desk-compose" id="sovDeskForm">' +
      '    <textarea id="sovDeskInput" rows="2" placeholder="Talk to Sovereign…" autocomplete="off"></textarea>' +
      '    <button type="submit" class="sov-desk-send" id="sovDeskSend">Send</button>' +
      "  </form>" +
      '  <p class="sov-desk-foot">Not Energy Agent. This is your direct line to the product mind.</p>' +
      "</div>";

    var form = document.getElementById("sovDeskForm");
    if (form && !form._wired) {
      form._wired = true;
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        send();
      });
    }
    var ta = document.getElementById("sovDeskInput");
    if (ta && !ta._wired) {
      ta._wired = true;
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
    }
  }

  function renderMessages() {
    var host = document.getElementById("sovDeskMsgs");
    if (!host) return;
    if (!state.messages.length) {
      host.innerHTML =
        '<div class="sov-desk-empty">' +
        "<b>Sovereign is listening.</b>" +
        "<p>Expansion, queues, succession, unlocks — talk here. " +
        "Energy Agent stays clean for fleet O&amp;M.</p>" +
        "</div>";
      return;
    }
    host.innerHTML = state.messages
      .map(function (m) {
        var role = m.role === "ford" ? "ford" : m.role === "system" ? "system" : "sov";
        var label =
          role === "ford" ? "You" : role === "system" ? "System" : "Sovereign";
        var prov = m.provider ? ' · ' + esc(m.provider) : "";
        return (
          '<div class="sov-bubble sov-bubble--' +
          role +
          '">' +
          '<div class="sov-bubble-lab">' +
          esc(label) +
          prov +
          "</div>" +
          '<div class="sov-bubble-body">' +
          esc(m.content).replace(/\n/g, "<br>") +
          "</div>" +
          "</div>"
        );
      })
      .join("");
    host.scrollTop = host.scrollHeight;
  }

  async function checkAccess() {
    try {
      var r = await fetch(API.access, { headers: authHeaders() });
      var d = await r.json();
      state.allowed = !!(d && d.desk && d.ok);
      state.email = d && d.email;
      return state.allowed;
    } catch (e) {
      state.allowed = false;
      return false;
    }
  }

  async function loadHistory() {
    var host = document.getElementById("sovDeskMsgs");
    if (host) host.innerHTML = '<div class="sov-desk-empty">Loading…</div>';
    try {
      var r = await fetch(API.history + "?limit=100", { headers: authHeaders() });
      var d = await r.json();
      state.messages = (d && d.messages) || [];
      var meta = document.getElementById("sovDeskMeta");
      if (meta) meta.textContent = (d.email || state.email || "desk") + " · private";
      renderMessages();
    } catch (e) {
      if (host)
        host.innerHTML =
          '<div class="sov-desk-empty"><b>Couldn’t load desk</b><p>' +
          esc(e.message || "network") +
          "</p></div>";
    }
  }

  async function send() {
    if (state.sending) return;
    var ta = document.getElementById("sovDeskInput");
    var text = ta ? String(ta.value || "").trim() : "";
    if (!text) return;
    state.sending = true;
    var btn = document.getElementById("sovDeskSend");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    if (ta) ta.value = "";
    state.messages.push({ role: "ford", content: text });
    renderMessages();
    try {
      var r = await fetch(API.chat, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: text }),
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "HTTP " + r.status);
      if (d.message && d.message.content) {
        state.messages.push({
          role: "sovereign",
          content: d.message.content,
          provider: d.provider,
        });
      } else if (d.reply) {
        state.messages.push({
          role: "sovereign",
          content: d.reply,
          provider: d.provider,
        });
      }
      renderMessages();
    } catch (e) {
      state.messages.push({
        role: "system",
        content: "Send failed: " + (e.message || e),
      });
      renderMessages();
    } finally {
      state.sending = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send";
      }
      if (ta) ta.focus();
    }
  }

  function openDesk() {
    ensureShell();
    if (location.hash !== "#sovereign") location.hash = "#sovereign";
    else showPanel();
  }

  function showPanel() {
    ensureShell();
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.remove("active");
    });
    var p = document.getElementById("panelSovereign");
    if (p) {
      p.hidden = false;
      p.classList.add("active");
    }
    var acctTab = document.getElementById("tabAccount");
    if (acctTab) acctTab.classList.add("active");
    loadHistory();
  }

  function mountEntry() {
    if (!state.allowed) {
      var old = document.getElementById("sovDeskEntry");
      if (old) old.remove();
      var fab = document.getElementById("sovDeskFab");
      if (fab) fab.remove();
      return;
    }
    // Account tab card
    var list = document.getElementById("acctList");
    if (list && !document.getElementById("sovDeskEntry")) {
      var card = document.createElement("section");
      card.id = "sovDeskEntry";
      card.className = "sov-desk-entry";
      card.innerHTML =
        '<div class="sov-desk-entry-inner">' +
        "<div>" +
        "<b>Sovereign desk</b>" +
        "<p>Direct line to the Array Operator leadership mind. " +
        "Not mixed with Energy Agent fleet chat.</p>" +
        "</div>" +
        '<button type="button" class="sov-desk-entry-btn" id="sovDeskOpenBtn">Open desk</button>' +
        "</div>";
      list.insertBefore(card, list.firstChild);
      var b = document.getElementById("sovDeskOpenBtn");
      if (b) b.onclick = openDesk;
    }
    // Floating fab (always available when allowed)
    if (!document.getElementById("sovDeskFab")) {
      var fab2 = document.createElement("button");
      fab2.type = "button";
      fab2.id = "sovDeskFab";
      fab2.className = "sov-desk-fab";
      fab2.title = "Sovereign desk";
      fab2.setAttribute("aria-label", "Open Sovereign desk");
      fab2.textContent = "S";
      fab2.onclick = openDesk;
      document.body.appendChild(fab2);
    }
  }

  async function boot() {
    var ok = await checkAccess();
    if (!ok) return;
    ensureShell();
    mountEntry();
    if (location.hash === "#sovereign") showPanel();
  }

  // Re-check after account loads (session ready)
  var _tries = 0;
  function bootWhenReady() {
    boot();
    if (!state.allowed && _tries < 8) {
      _tries += 1;
      setTimeout(bootWhenReady, 1500);
    }
  }

  window.addEventListener("hashchange", function () {
    if (location.hash === "#sovereign" && state.allowed) showPanel();
  });

  // Hook applyView: when leaving sovereign, fine; when opening account remount entry
  var _origApply = null;
  function patchApplyView() {
    if (typeof window.applyView === "function" && !_origApply) {
      // applyView is not on window — sandbox keeps it local
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWhenReady);
  } else {
    bootWhenReady();
  }

  // After account render, remount entry card
  var _obs = new MutationObserver(function () {
    if (state.allowed) mountEntry();
  });
  setTimeout(function () {
    var list = document.getElementById("acctList");
    if (list) _obs.observe(list, { childList: true });
  }, 2000);

  window.__aoOpenSovereignDesk = openDesk;
  window.__aoSovereignDeskAllowed = function () {
    return state.allowed;
  };
})();
