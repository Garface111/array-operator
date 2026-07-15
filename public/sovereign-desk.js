/* Sovereign Desk — private Ford ↔ Sovereign chat (not Energy Agent).
 * Visible when GET /v1/sovereign/desk/access returns desk:true
 * (ford.genereaux@gmail.com + allowlist). Hash: #sovereign
 */
(function () {
  "use strict";

  var API = {
    access: "/v1/sovereign/desk/access",
    history: "/v1/sovereign/desk/history",
    chat: "/v1/sovereign/desk/chat",
    ops: "/v1/sovereign/desk/ops",
  };

  var state = {
    allowed: false,
    email: null,
    loading: false,
    sending: false,
    messages: [],
    pollTimer: null,
    booted: false,
  };

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
    var existing = sec.querySelector(".sov-desk");
    if (existing) {
      // Already new layout (ops rail first / left)
      var lay = existing.querySelector(".sov-desk-layout");
      var first = lay && lay.firstElementChild;
      if (first && first.classList.contains("sov-ops")) return sec;
      // Old right-rail shell — rebuild
      existing.remove();
    }
    // Controls rail LEFT (sticky while chat scrolls) · conversation RIGHT
    sec.innerHTML =
      '<div class="sov-desk">' +
      '  <header class="sov-desk-head">' +
      '    <div class="sov-desk-brand">' +
      '      <div class="sov-desk-mark" aria-hidden="true"></div>' +
      "      <div>" +
      "        <h1>Sovereign</h1>" +
      '        <p class="sov-desk-sub">Leadership desk</p>' +
      "      </div>" +
      "    </div>" +
      '    <div class="sov-desk-head-right">' +
      '      <div class="sov-desk-meta" id="sovDeskMeta">Developer only</div>' +
      '      <button type="button" class="sov-desk-refresh" id="sovDeskRefresh" title="Refresh" aria-label="Refresh">↻</button>' +
      "    </div>" +
      "  </header>" +
      '  <div class="sov-desk-layout">' +
      '    <aside class="sov-ops" id="sovOpsPanel" aria-label="Ops controls">' +
      '      <div class="sov-ops-sticky">' +
      '        <div class="sov-ops-title">Controls</div>' +
      '        <div class="sov-ops-auth" id="sovOpsAuth">Authority…</div>' +
      "      </div>" +
      '      <div class="sov-ops-scroll">' +
      '        <div class="sov-ops-group">' +
      '          <div class="sov-ops-group-label">Run</div>' +
      '          <button type="button" class="sov-ops-primary" data-ops="sweep">Full sweep</button>' +
      '          <button type="button" data-ops="feature_triage">Triage features</button>' +
      "        </div>" +
      '        <div class="sov-ops-group">' +
      '          <div class="sov-ops-group-label">Ship</div>' +
      '          <button type="button" data-ops="ship_reviewed">Reviewed → build</button>' +
      '          <button type="button" data-ops="ship_building">Building queue</button>' +
      "        </div>" +
      '        <div class="sov-ops-group">' +
      '          <div class="sov-ops-group-label">Utilities</div>' +
      '          <button type="button" data-ops="utility_advance">Advance utilities</button>' +
      '          <button type="button" data-ops="utility_cred_stage">Stage credentials</button>' +
      "        </div>" +
      '        <div class="sov-ops-group">' +
      '          <div class="sov-ops-group-label">Jobs &amp; deploy</div>' +
      '          <button type="button" data-ops="jobs_drain">Drain job queue</button>' +
      '          <button type="button" data-ops="jobs_requeue">Requeue failures</button>' +
      '          <button type="button" data-ops="deploy_stage">Stage deploy</button>' +
      "        </div>" +
      '        <div class="sov-ops-group">' +
      '          <div class="sov-ops-group-label">Escalations</div>' +
      '          <button type="button" data-ops="escalation_sweep">Resolve needs_ford</button>' +
      '          <button type="button" data-ops="credentials">Credential inventory</button>' +
      "        </div>" +
      '        <div class="sov-ops-body" id="sovOpsBody">Loading queues…</div>' +
      "      </div>" +
      "    </aside>" +
      '    <div class="sov-desk-main">' +
      '      <div class="sov-desk-body" id="sovDeskMsgs"></div>' +
      '      <form class="sov-desk-compose" id="sovDeskForm">' +
      '        <textarea id="sovDeskInput" rows="2" placeholder="Message Sovereign…" autocomplete="off"></textarea>' +
      '        <button type="submit" class="sov-desk-send" id="sovDeskSend">Send</button>' +
      "      </form>" +
      "    </div>" +
      "  </div>" +
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
    var ref = document.getElementById("sovDeskRefresh");
    if (ref && !ref._wired) {
      ref._wired = true;
      ref.onclick = function () {
        loadHistory();
        loadOps();
      };
    }
    var ops = document.getElementById("sovOpsPanel");
    if (ops && !ops._wired) {
      ops._wired = true;
      ops.addEventListener("click", function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-ops]") : null;
        if (!b) return;
        runOps(b.getAttribute("data-ops"));
      });
    }
    return sec;
  }

  async function loadOps() {
    var body = document.getElementById("sovOpsBody");
    if (!body || !state.allowed) return;
    try {
      var r = await fetch(API.ops, { headers: authHeaders() });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "HTTP " + r.status);
      var s = (d.summary && d.summary) || d.summary || {};
      // summary nested under d.summary from API
      s = d.summary || {};
      var f = s.features || {};
      var u = s.utilities || {};
      var e = s.escalations || {};
      var j = s.jobs || {};
      var html = "";
      html +=
        '<div class="sov-ops-kpis">' +
        kpi("New", f.new) +
        kpi("Reviewed", f.reviewed) +
        kpi("Building", f.building) +
        kpi("Utils hot", (u.researching || 0) + (u.reviewed || 0) + (u.new || 0)) +
        kpi("needs_ford", e.needs_ford) +
        kpi("Jobs", j.queued) +
        "</div>";
      html += "<h4>Reviewed features</h4><ul class='sov-ops-list'>";
      (d.features_reviewed || []).slice(0, 8).forEach(function (it) {
        html +=
          "<li><b>#" +
          it.id +
          "</b> " +
          esc((it.text || "").slice(0, 80)) +
          ' <button type="button" class="sov-ops-mini" data-ops-one="feature_assign" data-id="' +
          it.id +
          '">build</button>' +
          ' <button type="button" class="sov-ops-mini" data-ops-one="feature_ship" data-id="' +
          it.id +
          '">shipped</button></li>';
      });
      html += "</ul><h4>Utilities</h4><ul class='sov-ops-list'>";
      (d.utilities_active || [])
        .filter(function (it) {
          return it.status !== "added" && it.status !== "declined";
        })
        .slice(0, 8)
        .forEach(function (it) {
          html +=
            "<li><b>#" +
            it.id +
            "</b> " +
            esc(it.name || "") +
            " <span class='sov-pill'>" +
            esc(it.status) +
            "</span></li>";
        });
      html += "</ul><h4>Escalations needs_ford</h4><ul class='sov-ops-list'>";
      (d.escalations_needs_ford || []).slice(0, 6).forEach(function (it) {
        html +=
          "<li><b>" +
          esc((it.id || "").slice(0, 12)) +
          "</b> " +
          esc((it.summary || "").slice(0, 80)) +
          ' <button type="button" class="sov-ops-mini" data-ops-one="escalation_resolve" data-id="' +
          esc(it.id) +
          '">close</button></li>';
      });
      html += "</ul><h4>Goals (agenda)</h4><ul class='sov-ops-list'>";
      (d.goals || []).slice(0, 6).forEach(function (g) {
        html +=
          "<li><b>p" +
          esc(g.priority) +
          "</b> " +
          esc((g.title || g.id || "").slice(0, 70)) +
          "</li>";
      });
      html += "</ul>";
      var creds = (d.credentials && d.credentials.credentials) || [];
      var portals = (d.credentials && d.credentials.portal_status) || [];
      html +=
        "<h4>Credentials (meta)</h4><p class='sov-ops-meta'>" +
        creds.length +
        " stored · " +
        portals.length +
        " portal rows · passwords never shown</p>";
      var auth = d.ops_authority ? "ON" : "OFF";
      var credsOn = d.credentials_unlocked ? "unlocked" : "locked";
      var portalOn = d.portal_signoff ? "ON" : "OFF";
      var authEl = document.getElementById("sovOpsAuth");
      if (authEl) {
        authEl.innerHTML =
          "Authority <b>" +
          auth +
          "</b> · creds <b>" +
          credsOn +
          "</b> · portal <b>" +
          portalOn +
          "</b>";
      }
      body.innerHTML = html;
      body.querySelectorAll("[data-ops-one]").forEach(function (btn) {
        btn.onclick = function () {
          var act = btn.getAttribute("data-ops-one");
          var id = btn.getAttribute("data-id");
          if (act === "feature_ship")
            runOps("feature_ship", { feature_id: parseInt(id, 10) });
          if (act === "feature_assign")
            runOps("feature_assign", {
              feature_id: parseInt(id, 10),
              status: "building",
              note: "Assigned from desk",
            });
          if (act === "escalation_resolve")
            runOps("escalation_resolve", {
              escalation_id: id,
              status: "done",
              note: "Closed from desk UI",
            });
        };
      });
    } catch (err) {
      body.innerHTML =
        "<p class='sov-ops-err'>" + esc(err.message || "ops load failed") + "</p>";
    }
  }

  function kpi(label, n) {
    return (
      '<div class="sov-ops-kpi"><b>' +
      esc(n == null ? "—" : n) +
      "</b><span>" +
      esc(label) +
      "</span></div>"
    );
  }

  async function runOps(action, payload) {
    payload = payload || {};
    var map = {
      sweep: "sweep",
      ship_reviewed: "feature_ship_batch",
      ship_building: "feature_ship_building",
      feature_triage: "feature_triage",
      feature_assign: "feature_assign",
      utility_advance: "utility_advance",
      utility_cred_stage: "utility_cred_stage",
      escalation_sweep: "escalation_sweep",
      jobs_requeue: "jobs_requeue",
      jobs_drain: "jobs_drain",
      feature_ship: "feature_ship",
      escalation_resolve: "escalation_resolve",
      deploy_stage: "deploy_stage",
      credentials: "credentials",
    };
    var act = map[action] || action;
    try {
      var r = await fetch(API.ops, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ action: act, payload: payload }),
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "HTTP " + r.status);
      state.messages.push({
        role: "system",
        content: "Ops " + act + ": " + JSON.stringify(d).slice(0, 400),
      });
      renderMessages();
      loadOps();
      loadHistory();
    } catch (e) {
      state.messages.push({
        role: "system",
        content: "Ops failed: " + (e.message || e),
      });
      renderMessages();
    }
  }

  function renderMessages() {
    var host = document.getElementById("sovDeskMsgs");
    if (!host) return;
    if (!state.messages.length) {
      host.innerHTML =
        '<div class="sov-desk-empty">' +
        "<b>Sovereign is listening</b>" +
        "<p>Queues, succession, unlocks — use the rail or write freely.</p>" +
        "</div>";
      return;
    }
    var nearBottom =
      host.scrollHeight - host.scrollTop - host.clientHeight < 80;
    host.innerHTML = state.messages
      .map(function (m) {
        var role =
          m.role === "ford" ? "ford" : m.role === "system" ? "system" : "sov";
        var label =
          role === "ford" ? "You" : role === "system" ? "System" : "Sovereign";
        var prov = m.provider ? " · " + esc(m.provider) : "";
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
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }

  async function checkAccess() {
    if (!hasSession()) {
      state.allowed = false;
      return false;
    }
    try {
      var r = await fetch(API.access, { headers: authHeaders() });
      var d = await r.json().catch(function () {
        return {};
      });
      state.allowed = !!(d && d.desk && d.ok);
      state.email = (d && d.email) || null;
      return state.allowed;
    } catch (e) {
      state.allowed = false;
      return false;
    }
  }

  async function loadHistory() {
    var host = document.getElementById("sovDeskMsgs");
    if (!state.allowed) {
      if (host)
        host.innerHTML =
          '<div class="sov-desk-empty"><b>Sign in as Ford</b>' +
          "<p>Sovereign desk is only on the developer account.</p></div>";
      return;
    }
    try {
      var r = await fetch(API.history + "?limit=100", { headers: authHeaders() });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "HTTP " + r.status);
      state.messages = (d && d.messages) || [];
      var meta = document.getElementById("sovDeskMeta");
      if (meta)
        meta.textContent = (d.email || state.email || "desk") + " · private";
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
    if (state.sending || !state.allowed) return;
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
    var host = document.getElementById("sovDeskMsgs");
    if (host) host.scrollTop = host.scrollHeight;
    try {
      var r = await fetch(API.chat, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: text }),
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) {
        var detail = d && d.detail;
        if (typeof detail === "object")
          detail = detail.message || JSON.stringify(detail);
        throw new Error(detail || "HTTP " + r.status);
      }
      var reply =
        (d.message && d.message.content) || d.reply || "";
      if (reply) {
        state.messages.push({
          role: "sovereign",
          content: reply,
          provider: d.provider,
        });
      }
      renderMessages();
      if (host) host.scrollTop = host.scrollHeight;
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

  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(function () {
      if (location.hash === "#sovereign" && state.allowed && !state.sending) {
        loadHistory();
        loadOps();
      }
    }, 12000);
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function showPanel() {
    ensureShell();
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.remove("active");
    });
    var p = document.getElementById("panelSovereign");
    if (p) {
      p.hidden = false;
      p.removeAttribute("hidden");
      p.classList.add("active");
    }
    var acctTab = document.getElementById("tabAccount");
    if (acctTab) acctTab.classList.add("active");
    loadHistory();
    loadOps();
    startPoll();
  }

  function openDesk() {
    ensureShell();
    if (location.hash !== "#sovereign") {
      location.hash = "#sovereign";
      // applyView / hashchange will call showPanel
      setTimeout(function () {
        if (location.hash === "#sovereign") showPanel();
      }, 50);
    } else {
      showPanel();
    }
  }

  function mountEntry() {
    if (!state.allowed) {
      var old = document.getElementById("sovDeskEntry");
      if (old) old.remove();
      var fab = document.getElementById("sovDeskFab");
      if (fab) fab.remove();
      return;
    }
    // Account tab card — re-insert after Account re-renders
    var list = document.getElementById("acctList");
    if (list && !document.getElementById("sovDeskEntry")) {
      var card = document.createElement("section");
      card.id = "sovDeskEntry";
      card.className = "sov-desk-entry";
      card.innerHTML =
        '<div class="sov-desk-entry-inner">' +
        "<div>" +
        "<b>Sovereign desk</b>" +
        "<p>Leadership mind — separate from Energy Agent fleet chat.</p>" +
        "</div>" +
        '<button type="button" class="sov-desk-entry-btn" id="sovDeskOpenBtn">Open desk</button>' +
        "</div>";
      list.insertBefore(card, list.firstChild);
      var b = document.getElementById("sovDeskOpenBtn");
      if (b) b.onclick = openDesk;
    }
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
    if (!ok) {
      mountEntry(); // removes UI
      return false;
    }
    ensureShell();
    mountEntry();
    if (location.hash === "#sovereign") showPanel();
    state.booted = true;
    return true;
  }

  var _tries = 0;
  function bootWhenReady() {
    boot().then(function (ok) {
      if (!ok && _tries < 12) {
        _tries += 1;
        setTimeout(bootWhenReady, 1200);
      }
    });
  }

  window.addEventListener("hashchange", function () {
    if (location.hash === "#sovereign") {
      if (state.allowed) showPanel();
      else
        boot().then(function (ok) {
          if (ok) showPanel();
        });
    } else {
      stopPoll();
      var p = document.getElementById("panelSovereign");
      if (p) {
        p.classList.remove("active");
        p.hidden = true;
      }
    }
  });

  // Remount Account card when Account re-renders
  setTimeout(function () {
    var list = document.getElementById("acctList");
    if (!list) return;
    var obs = new MutationObserver(function () {
      if (state.allowed) mountEntry();
    });
    obs.observe(list, { childList: true });
  }, 1500);

  // Re-check access when session appears (login)
  var _sess = null;
  try {
    _sess = localStorage.getItem("so_session");
  } catch (e) {}
  setInterval(function () {
    var now = null;
    try {
      now = localStorage.getItem("so_session");
    } catch (e) {}
    if (now !== _sess) {
      _sess = now;
      _tries = 0;
      bootWhenReady();
    }
  }, 2000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWhenReady);
  } else {
    bootWhenReady();
  }

  window.__aoOpenSovereignDesk = openDesk;
  window.__aoSovereignDeskAllowed = function () {
    return state.allowed;
  };
  window.__aoSovereignDeskBoot = boot;
})();
