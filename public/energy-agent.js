/* ============================================================================
 * Energy Agent — voice-first orb + browser driver (Array Operator)
 * Backend: /v1/energy-agent/*
 * ========================================================================== */
(function () {
  "use strict";

  var API = {
    session: "/v1/energy-agent/session",
    chat: "/v1/energy-agent/chat",
    confirm: "/v1/energy-agent/confirm",
    realtime: "/v1/energy-agent/realtime-session",
    transcript: "/v1/energy-agent/transcript",
    uiResult: "/v1/energy-agent/ui-result",
    budget: "/v1/energy-agent/budget",
  };

  var state = {
    open: false,
    sessionId: null,
    listening: false,
    thinking: false,
    speaking: false,
    pending: null,
    recog: null,
    budget: null,
    brain: null,
  };

  function token() {
    try { return localStorage.getItem("so_session") || ""; } catch (e) { return ""; }
  }
  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = token();
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }
  function signedIn() { return !!token(); }

  function packContext() {
    var sel = null;
    try {
      var ae = document.activeElement;
      if (ae && ae.closest) {
        var card = ae.closest("[data-sub-id], [data-array-id], .rb-offtaker, .ansg-table tr");
        if (card) {
          sel = {
            subId: card.getAttribute("data-sub-id") || null,
            arrayId: card.getAttribute("data-array-id") || null,
            text: (card.innerText || "").slice(0, 200),
          };
        }
      }
    } catch (e) {}
    return {
      hash: location.hash || "#dashboard",
      path: location.pathname,
      title: document.title,
      selection: sel,
      viewport: { w: innerWidth, h: innerHeight },
    };
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  function ensureUi() {
    if (document.getElementById("eaRoot")) return;
    var root = document.createElement("div");
    root.id = "eaRoot";
    root.innerHTML =
      '<button type="button" id="eaOrb" aria-label="Open Energy Agent" title="Energy Agent">' +
      '<span class="ea-ring" aria-hidden="true"></span></button>' +
      '<div id="eaPanel" role="dialog" aria-label="Energy Agent">' +
      '  <div class="ea-head">' +
      '    <div><h3>Energy Agent</h3>' +
      '    <p>Voice-first solar operator — fleet, invoices, earnings. Confirms before changing anything.</p></div>' +
      '    <button type="button" class="ea-x" id="eaClose" aria-label="Close">×</button>' +
      "  </div>" +
      '  <div class="ea-status"><i class="ea-dot" id="eaDot"></i>' +
      '    <span id="eaStatusText">Ready</span>' +
      '    <span class="ea-budget" id="eaBudget"></span></div>' +
      '  <div class="ea-tools" id="eaTools"></div>' +
      '  <div class="ea-msgs" id="eaMsgs"></div>' +
      '  <div class="ea-pending" id="eaPending" hidden></div>' +
      '  <div class="ea-compose">' +
      '    <textarea id="eaInput" rows="1" placeholder="Ask or type… (or use the mic)"></textarea>' +
      '    <button type="button" class="ea-mic" id="eaMic" title="Toggle microphone">Mic</button>' +
      '    <button type="button" class="ea-send" id="eaSend">Send</button>' +
      "  </div>" +
      '  <div class="ea-legal">Sessions may be transcribed to improve support. Only your account. Never other tenants. Mic stays on while the agent is open.</div>' +
      "</div>";
    document.body.appendChild(root);

    document.getElementById("eaOrb").onclick = toggle;
    document.getElementById("eaClose").onclick = function () { setOpen(false); };
    document.getElementById("eaSend").onclick = sendText;
    document.getElementById("eaMic").onclick = toggleMic;
    document.getElementById("eaInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
  }

  function setStatus(text, mode) {
    var el = document.getElementById("eaStatusText");
    var dot = document.getElementById("eaDot");
    var orb = document.getElementById("eaOrb");
    if (el) el.textContent = text;
    if (dot) {
      dot.className = "ea-dot" + (mode === "on" ? " on" : mode === "warn" ? " warn" : "");
    }
    if (orb) {
      orb.classList.toggle("listening", mode === "listen");
      orb.classList.toggle("thinking", mode === "think");
      orb.classList.toggle("speaking", mode === "speak");
      orb.classList.toggle("open", state.open);
    }
  }

  function setBudget(b) {
    state.budget = b;
    var el = document.getElementById("eaBudget");
    if (!el || !b) return;
    el.textContent = "$" + (b.remaining_usd != null ? b.remaining_usd.toFixed(2) : "—") + " left this week";
  }

  function addMsg(role, text) {
    var host = document.getElementById("eaMsgs");
    if (!host) return;
    var d = document.createElement("div");
    d.className = "ea-msg " + (role === "user" ? "user" : "agent");
    d.textContent = text;
    host.appendChild(d);
    host.scrollTop = host.scrollHeight;
  }

  function addTool(name, detail) {
    var host = document.getElementById("eaTools");
    if (!host) return;
    var d = document.createElement("div");
    d.className = "ea-tool";
    d.innerHTML = "<b>" + esc(name) + "</b><code>" + esc(detail || "") + "</code>";
    host.appendChild(d);
    host.scrollTop = host.scrollHeight;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showPending(p) {
    state.pending = p;
    var box = document.getElementById("eaPending");
    if (!box) return;
    if (!p) { box.hidden = true; box.innerHTML = ""; return; }
    var reason = (p.reason || p.type || "action") +
      (p.args && p.args.hash ? " → " + p.args.hash : "") +
      (p.args && p.args.selector ? " · " + p.args.selector : "") +
      (p.args && p.args.path ? " · " + p.args.path : "");
    box.hidden = false;
    box.innerHTML =
      "<div><b>Confirm</b> — " + esc(reason) + "</div>" +
      '<div class="ea-pending-actions">' +
      '<button type="button" class="ea-yes" id="eaYes">Yes, do it</button>' +
      '<button type="button" class="ea-no" id="eaNo">Cancel</button></div>';
    document.getElementById("eaYes").onclick = function () { confirmPending(true); };
    document.getElementById("eaNo").onclick = function () { confirmPending(false); };
  }

  // ── session ──────────────────────────────────────────────────────────────
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    if (!signedIn()) {
      addMsg("agent", "Sign in to use Energy Agent — I only work inside your own account.");
      return null;
    }
    setStatus("Starting…", "think");
    var r = await fetch(API.session, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ context: packContext() }),
    });
    var d = await r.json().catch(function () { return null; });
    if (!r.ok || !d || !d.session_id) {
      addMsg("agent", (d && d.detail) || "Couldn't start Energy Agent. Try again.");
      setStatus("Error", "warn");
      return null;
    }
    state.sessionId = d.session_id;
    state.brain = d.brain;
    setBudget(d.budget);
    addMsg("agent", d.intro || "Hi — I'm Energy Agent.");
    setStatus(d.realtime_ready ? "Voice ready · " + (d.brain || "brain") : "Text ready · " + (d.brain || "brain"), "on");
    return state.sessionId;
  }

  async function toggle() {
    ensureUi();
    setOpen(!state.open);
  }

  async function setOpen(o) {
    ensureUi();
    state.open = !!o;
    var panel = document.getElementById("eaPanel");
    var orb = document.getElementById("eaOrb");
    if (panel) panel.classList.toggle("open", state.open);
    if (orb) orb.classList.toggle("open", state.open);
    if (state.open) {
      await ensureSession();
      // Auto-start mic after open (always-on once enabled)
      if (signedIn() && !state.listening) {
        setTimeout(function () { startMic(true); }, 400);
      }
    } else {
      stopMic();
      stopSpeak();
    }
  }

  // ── chat ─────────────────────────────────────────────────────────────────
  async function sendText() {
    var input = document.getElementById("eaInput");
    var text = (input && input.value || "").trim();
    if (!text) return;
    if (input) input.value = "";
    await turn(text, "text");
  }

  async function turn(text, source) {
    if (!text) return;
    var sid = await ensureSession();
    if (!sid) return;
    addMsg("user", text);
    state.thinking = true;
    setStatus("Thinking…", "think");
    try {
      var r = await fetch(API.chat, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          session_id: sid,
          message: text,
          context: packContext(),
          source: source || "text",
        }),
      });
      var d = await r.json().catch(function () { return null; });
      if (!r.ok) {
        var err = (d && (d.detail || d.error)) || ("HTTP " + r.status);
        addMsg("agent", String(err));
        setStatus("Error", "warn");
        return;
      }
      setBudget(d.budget);
      (d.tool_trace || []).forEach(function (t) {
        addTool(t.name, JSON.stringify(t.args || {}).slice(0, 80));
      });
      if (d.pending) showPending(d.pending);
      else showPending(null);
      var cmds = d.ui_commands || [];
      for (var i = 0; i < cmds.length; i++) await runCommand(cmds[i]);
      addMsg("agent", d.reply || "…");
      speak(d.reply || "");
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
    } catch (e) {
      addMsg("agent", "Network error — try again.");
      setStatus("Error", "warn");
    } finally {
      state.thinking = false;
    }
  }

  async function confirmPending(yes) {
    if (!state.sessionId) return;
    var r = await fetch(API.confirm, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        session_id: state.sessionId,
        confirm: !!yes,
        pending_id: state.pending && state.pending.id,
      }),
    });
    var d = await r.json().catch(function () { return null; });
    showPending(null);
    if (d && d.command) {
      addMsg("agent", yes ? "On it." : "Cancelled.");
      await runCommand(d.command);
    } else if (d && d.cancelled) {
      addMsg("agent", "Cancelled.");
    }
  }

  // ── browser driver ───────────────────────────────────────────────────────
  async function runCommand(cmd) {
    if (!cmd) return;
    addTool("ui." + (cmd.type || "?"), JSON.stringify(cmd.args || {}).slice(0, 100));
    var ok = false, detail = {};
    try {
      if (cmd.type === "navigate") {
        var hash = (cmd.args && cmd.args.hash) || "#dashboard";
        if (hash.charAt(0) !== "#") hash = "#" + hash;
        location.hash = hash;
        ok = true;
        detail = { hash: hash };
      } else if (cmd.type === "highlight") {
        ok = highlight(cmd.args && cmd.args.selector);
        detail = { selector: cmd.args && cmd.args.selector };
      } else if (cmd.type === "fill") {
        ok = fill(cmd.args && cmd.args.selector, cmd.args && cmd.args.value);
      } else if (cmd.type === "click") {
        ok = clickEl(cmd.args && cmd.args.selector);
      } else if (cmd.type === "api_patch" || cmd.type === "api") {
        ok = await apiProxy(cmd.args || {});
        detail = cmd.args || {};
      } else {
        detail = { error: "unknown command type" };
      }
    } catch (e) {
      detail = { error: String(e && e.message || e) };
    }
    try {
      await fetch(API.uiResult, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          session_id: state.sessionId,
          command_id: cmd.id || "x",
          ok: ok,
          detail: detail,
        }),
      });
    } catch (e) {}
  }

  function highlight(sel) {
    if (!sel) return false;
    var el = document.querySelector(sel);
    if (!el) return false;
    el.classList.add("ea-hl");
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    setTimeout(function () { el.classList.remove("ea-hl"); }, 4000);
    return true;
  }
  function fill(sel, value) {
    if (!sel) return false;
    var el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    if ("value" in el) {
      el.value = value == null ? "" : String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    highlight(sel);
    return true;
  }
  function clickEl(sel) {
    if (!sel) return false;
    var el = document.querySelector(sel);
    if (!el) return false;
    highlight(sel);
    el.click();
    return true;
  }
  async function apiProxy(args) {
    var path = args.path;
    if (!path) return false;
    var r = await fetch(path, {
      method: args.method || "GET",
      headers: authHeaders(),
      body: args.body ? JSON.stringify(args.body) : undefined,
    });
    if (args.open_url_field) {
      var d = await r.json().catch(function () { return null; });
      var url = d && (d[args.open_url_field] || d.url || d.portal_url);
      if (url) window.open(url, "_blank", "noopener");
    }
    return r.ok;
  }

  window.__eaDriver = {
    navigate: function (h) { return runCommand({ type: "navigate", args: { hash: h }, id: "drv" }); },
    highlight: highlight,
    fill: fill,
    click: clickEl,
  };

  // ── voice (Web Speech API — always-on once open) ─────────────────────────
  function canSpeech() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function startMic(fromOpen) {
    if (!canSpeech()) {
      if (!fromOpen) addMsg("agent", "This browser has no speech recognition — type instead. Chrome works best.");
      return;
    }
    stopMic();
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = "en-US";
    var finalBuf = "";
    recog.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalBuf += t + " ";
        else interim += t;
      }
      if (finalBuf.trim() && !state.thinking) {
        var said = finalBuf.trim();
        finalBuf = "";
        // Barge-in: stop TTS
        stopSpeak();
        turn(said, "voice");
        // log voice seconds estimate
        if (state.sessionId) {
          fetch(API.transcript, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              session_id: state.sessionId,
              lines: [{ role: "user", text: said }],
              voice_seconds: Math.max(2, said.split(/\s+/).length * 0.4),
            }),
          }).catch(function () {});
        }
      } else if (interim) {
        setStatus("Hearing: " + interim.slice(0, 40), "listen");
      }
    };
    recog.onerror = function (e) {
      if (e.error === "not-allowed") {
        addMsg("agent", "Microphone blocked — allow mic for this site, or type.");
        setStatus("Mic blocked", "warn");
        state.listening = false;
        syncMicBtn();
      }
    };
    recog.onend = function () {
      // Always-on: restart while panel open
      if (state.open && state.listening) {
        try { recog.start(); } catch (e) {}
      }
    };
    try {
      recog.start();
      state.recog = recog;
      state.listening = true;
      syncMicBtn();
      setStatus("Listening…", "listen");
    } catch (e) {
      addMsg("agent", "Couldn't start the mic.");
    }
  }

  function stopMic() {
    state.listening = false;
    if (state.recog) {
      try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
      state.recog = null;
    }
    syncMicBtn();
  }

  function toggleMic() {
    if (state.listening) {
      stopMic();
      setStatus("Mic off · type anytime", "on");
    } else startMic(false);
  }

  function syncMicBtn() {
    var b = document.getElementById("eaMic");
    if (b) {
      b.classList.toggle("on", state.listening);
      b.textContent = state.listening ? "Mic on" : "Mic";
    }
  }

  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    stopSpeak();
    var u = new SpeechSynthesisUtterance(String(text).slice(0, 800));
    u.rate = 1.05;
    u.pitch = 1;
    u.onstart = function () { state.speaking = true; setStatus("Speaking…", "speak"); };
    u.onend = function () {
      state.speaking = false;
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
    };
    window.speechSynthesis.speak(u);
  }
  function stopSpeak() {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.speaking = false;
  }

  // ── mic permission on startup (Ford: request as soon as the app loads) ───
  function requestMicOnStartup() {
    if (!signedIn()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    // Ask once per tab load so Chrome shows the prompt early, not after orb open.
    // Stop tracks immediately — we only need the permission grant; SpeechRecognition
    // opens its own stream when listening starts.
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      setStatus("Mic ready — click the sun to talk", "on");
    }).catch(function (err) {
      var name = (err && err.name) || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setStatus("Mic blocked — type or allow mic in the browser", "warn");
      }
      // Other errors (no device): stay quiet; text still works.
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot() {
    // Only show for signed-in product surfaces (not marketing alone)
    if (!document.getElementById("tabbar") && !document.getElementById("analysisRoot")) {
      // still allow on main app shell
    }
    ensureUi();
    // Hide orb on pure login pages
    if (/\/login/i.test(location.pathname) && !signedIn()) {
      var r = document.getElementById("eaRoot");
      if (r) r.style.display = "none";
      return;
    }
    // Request mic as soon as the signed-in app is up (slight delay so UI paints first).
    if (signedIn()) {
      setTimeout(requestMicOnStartup, 600);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.__eaOpen = function () { setOpen(true); };
  window.__eaClose = function () { setOpen(false); };
})();
