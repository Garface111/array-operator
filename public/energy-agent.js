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
    realtimeCall: "/v1/energy-agent/realtime-call",
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
    realtimeReady: false,
    // GPT Realtime WebRTC
    pc: null,
    dc: null,
    micStream: null,
    audioEl: null,
    voiceMode: "none", // realtime | webspeech | none
    rtResponseActive: false, // track open Realtime response — avoid cancel noise
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
    if (document.getElementById("eaPanel")) return;

    // Tab-style control: inject at LEFT of #tabbar (in line with Fleet Triage)
    var tabbar = document.getElementById("tabbar");
    var orb = document.getElementById("eaOrb");
    if (!orb) {
      orb = document.createElement("button");
      orb.type = "button";
      orb.id = "eaOrb";
      orb.className = "tab ea-tab";
      orb.setAttribute("role", "tab");
      orb.setAttribute("aria-label", "Open Energy Agent");
      orb.title = "Energy Agent — click to talk";
      orb.innerHTML =
        '<span class="ea-tab-ic" aria-hidden="true"></span>' +
        '<span class="ea-tab-label">Energy Agent</span>';
      if (tabbar) {
        tabbar.insertBefore(orb, tabbar.firstChild);
      } else {
        // Fallback if tabbar not present yet
        var rootF = document.createElement("div");
        rootF.id = "eaRoot";
        rootF.className = "ea-floating";
        rootF.appendChild(orb);
        document.body.appendChild(rootF);
      }
    }

    // Mic gate + left-rail panel live on body (fixed)
    var gate = document.getElementById("eaMicGate");
    if (!gate) {
      gate = document.createElement("button");
      gate.type = "button";
      gate.id = "eaMicGate";
      gate.className = "ea-mic-gate";
      gate.hidden = true;
      gate.innerHTML =
        '<span class="ea-mic-gate-ic" aria-hidden="true">🎙</span>' +
        '<span class="ea-mic-gate-txt">Allow microphone</span>';
      document.body.appendChild(gate);
    }

    var panel = document.createElement("div");
    panel.id = "eaPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Energy Agent");
    panel.innerHTML =
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
      '  <div class="ea-legal">Sessions may be transcribed to improve support. Only your account. Never other tenants. Mic stays on while the agent is open.</div>';
    document.body.appendChild(panel);

    // Lightweight marker root for status hooks that still look for #eaRoot
    if (!document.getElementById("eaRoot")) {
      var root = document.createElement("div");
      root.id = "eaRoot";
      root.setAttribute("aria-hidden", "true");
      root.style.cssText = "display:none";
      document.body.appendChild(root);
    }

    orb.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle(); // async; mic requested first inside toggle (user gesture)
    };
    gate.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      requestMicFromClick();
    };
    document.getElementById("eaClose").onclick = function () { setOpen(false); };
    document.getElementById("eaSend").onclick = sendText;
    document.getElementById("eaMic").onclick = function (e) {
      e.preventDefault();
      toggleMic();
    };
    document.getElementById("eaInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
  }

  function showMicGate(show, reason) {
    var gate = document.getElementById("eaMicGate");
    if (!gate) return;
    if (show) {
      gate.hidden = false;
      var t = gate.querySelector(".ea-mic-gate-txt");
      if (t) t.textContent = reason || "Allow microphone";
    } else {
      gate.hidden = true;
    }
  }

  /** Must run from a click handler so Chrome shows the permission prompt. */
  async function requestMicFromClick() {
    try {
      await ensureMicStream();
      showMicGate(false);
      setStatus("Mic allowed — opening agent…", "on");
      // If panel closed, open it and connect voice
      if (!state.open) await setOpen(true);
      else if (!state.listening) await startVoice(true);
      return true;
    } catch (err) {
      var name = (err && err.name) || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        showMicGate(true, "Mic blocked — click to retry");
        setStatus("Mic blocked", "warn");
        addMsg("agent",
          "Chrome blocked the mic. Click the lock/tune icon in the address bar → " +
          "Microphone → Allow, then click “Allow microphone” again.");
      } else {
        showMicGate(true, "Mic error — retry");
        addMsg("agent", "Mic error: " + ((err && err.message) || err));
      }
      return false;
    }
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

  /** Single chat log for voice + text. Returns false if this is a near-duplicate of the last bubble. */
  function addMsg(role, text, opts) {
    opts = opts || {};
    var host = document.getElementById("eaMsgs");
    if (!host) return false;
    var t = String(text || "").trim();
    if (!t) return false;
    // Dedupe: voice transcript path + turn() used to double-post the same line
    var last = host.lastElementChild;
    if (last && last.getAttribute("data-role") === role) {
      var prev = (last.textContent || "").trim();
      if (prev === t || prev.indexOf(t) === 0 || t.indexOf(prev) === 0) {
        return false;
      }
    }
    if (opts.skipIfDup && state._lastUserSaid === t && role === "user") return false;
    if (role === "user") state._lastUserSaid = t;
    var d = document.createElement("div");
    d.className = "ea-msg " + (role === "user" ? "user" : "agent");
    d.setAttribute("data-role", role);
    d.textContent = t;
    host.appendChild(d);
    host.scrollTop = host.scrollHeight;
    return true;
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
    state.realtimeReady = !!d.realtime_ready;
    setBudget(d.budget);
    addMsg("agent", d.intro || "Hi — I'm Energy Agent.");
    if (d.realtime_ready) {
      setStatus("GPT voice ready — connecting mic…", "on");
    } else {
      setStatus("Text ready (no OPENAI_API_KEY for GPT voice yet)", "warn");
      addMsg("agent",
        "Voice needs OPENAI_API_KEY on the server for the latest GPT Realtime model. " +
        "You can still type. Brain: " + (d.brain || "stub") + ".");
    }
    return state.sessionId;
  }

  async function toggle() {
    ensureUi();
    if (!state.open) {
      // First click on the sun: request mic IMMEDIATELY (user gesture), then open.
      // Do not await session/network before getUserMedia — that can drop the gesture
      // in some browsers and skip the permission dialog.
      if (signedIn()) {
        var micOk = false;
        try {
          await ensureMicStream();
          showMicGate(false);
          micOk = true;
        } catch (err) {
          var name = (err && err.name) || "";
          var blocked = name === "NotAllowedError" || name === "PermissionDeniedError";
          showMicGate(true, blocked ? "Mic blocked — fix & retry" : "Allow microphone");
          await setOpen(true);
          if (blocked) {
            addMsg("agent",
              "Microphone is blocked for this site. " +
              "Click the lock icon in the address bar → Site settings → Microphone → Allow, " +
              "then click the sun (or “Allow microphone”) again. " +
              "You can still type below.");
          } else {
            addMsg("agent", "Mic error: " + ((err && err.message) || err) + " — you can still type.");
          }
          return;
        }
        await setOpen(true);
        // startVoice uses the stream we already have
        if (micOk && !state.listening) {
          try { await startVoice(true); } catch (e) {}
        }
      } else {
        await setOpen(true);
      }
    } else {
      await setOpen(false);
    }
  }

  async function setOpen(o) {
    ensureUi();
    state.open = !!o;
    var panel = document.getElementById("eaPanel");
    var orb = document.getElementById("eaOrb");
    if (panel) panel.classList.toggle("open", state.open);
    if (orb) {
      orb.classList.toggle("open", state.open);
      orb.classList.toggle("active", state.open);
      orb.setAttribute("aria-pressed", state.open ? "true" : "false");
    }
    // Shift site content right; spawn left-rail card
    document.body.classList.toggle("ea-shell-open", state.open);
    if (state.open) {
      await ensureSession();
      // Voice usually already starting from toggle(); only start here if mic ready
      // and we aren't listening yet (e.g. re-open after close).
      if (signedIn() && !state.listening && state.micStream) {
        try { await startVoice(true); } catch (e) {}
      }
    } else {
      stopVoice(true); // keep mic permission stream; just tear down WebRTC
    }
  }

  /** Soft-refresh live surfaces after agent data writes (no full page reload). */
  function softRefreshUi(detail) {
    detail = detail || {};
    try {
      if (typeof window.__aoLoadReports === "function") {
        window.__aoLoadReports();
      }
    } catch (e) {}
    try {
      if (window.FleetStore && typeof window.FleetStore.refetch === "function") {
        window.FleetStore.refetch();
      }
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent("ea:data-changed", { detail: detail }));
    } catch (e) {
      try { window.dispatchEvent(new Event("ea:data-changed")); } catch (e2) {}
    }
    // Nudge any open offtaker accordion inputs if share changed
    try {
      if (detail && detail.subscription_id != null && detail.allocation_pct != null) {
        var pct = Number(detail.allocation_pct);
        if (pct <= 1) pct = pct * 100;
        var sel = '[data-sub-id="' + detail.subscription_id + '"] input[data-of="allocation_pct"],' +
          '#rbAccBody-' + detail.subscription_id + ' input[data-of="allocation_pct"]';
        document.querySelectorAll(sel).forEach(function (inp) {
          inp.value = String(Math.round(pct * 1000) / 1000);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
    } catch (e) {}
  }

  function cancelRealtimeIfActive() {
    if (!state.rtResponseActive) return;
    if (!(state.dc && state.dc.readyState === "open")) return;
    try {
      state.dc.send(JSON.stringify({ type: "response.cancel" }));
    } catch (e) {}
  }

  function isBenignVoiceError(msg) {
    var s = String(msg || "").toLowerCase();
    return (
      s.indexOf("no active response") !== -1 ||
      s.indexOf("cancellation failed") !== -1 ||
      s.indexOf("response_cancel") !== -1 ||
      s.indexOf("already has an active response") !== -1
    );
  }

  // ── chat ─────────────────────────────────────────────────────────────────
  async function sendText() {
    var input = document.getElementById("eaInput");
    var text = (input && input.value || "").trim();
    if (!text) return;
    if (input) input.value = "";
    await turn(text, "text");
  }

  /**
   * One conversation turn for BOTH voice and text.
   * opts.userAlreadyShown — voice path already painted the user bubble from transcript.
   */
  async function turn(text, source, opts) {
    opts = opts || {};
    if (!text) return;
    var sid = await ensureSession();
    if (!sid) return;
    if (!opts.userAlreadyShown) {
      addMsg("user", text);
    }
    state.thinking = true;
    setStatus("Thinking…", "think");
    // While tools run, cancel any stray Realtime speech only if one is active
    cancelRealtimeIfActive();
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
      // Run UI commands immediately (navigate has no confirm on server now)
      if (d.pending) showPending(d.pending);
      else showPending(null);
      var cmds = d.ui_commands || [];
      for (var i = 0; i < cmds.length; i++) await runCommand(cmds[i]);
      // Also execute navigates that arrived as pending by mistake (legacy)
      if (d.pending && d.pending.type === "navigate") {
        await runCommand(Object.assign({}, d.pending, { needs_confirm: false }));
        showPending(null);
      }
      var reply = d.reply || "…";
      addMsg("agent", reply);
      if (reply !== _lastSpoken) {
        _lastSpoken = reply;
        speak(reply);
      }
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
    if (d && d.cancelled) {
      addMsg("agent", "Cancelled.");
      return;
    }
    if (d && d.command) {
      addMsg("agent", yes ? "On it — applying now." : "Cancelled.");
      await runCommand(d.command);
      var extras = d.extra_commands || [];
      for (var i = 0; i < extras.length; i++) await runCommand(extras[i]);
      // Soft-refresh after any confirmed write
      softRefreshUi((d.command.args && d.command.args.body) || {});
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
        // Normalize common aliases the model might say
        var aliases = {
          "#invoice": "#reports", "#invoices": "#reports", "#billing": "#reports",
          "#offtaker": "#reports", "#offtakers": "#reports",
          "#inverter": "#arrays", "#inverters": "#arrays",
          "#fleet": "#dashboard", "#triage": "#dashboard",
          "#master": "#account", "#settings": "#account",
        };
        var h = hash.toLowerCase();
        if (aliases[h]) hash = aliases[h];
        location.hash = hash;
        // Help sandbox router if it listens to hashchange
        try {
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (e) {
          try { window.dispatchEvent(new Event("hashchange")); } catch (e2) {}
        }
        ok = true;
        detail = { hash: hash };
        addMsg("agent", "Opening " + hash + "…");
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
        if (ok) softRefreshUi(detail.body || detail);
      } else if (cmd.type === "ui_refresh" || cmd.type === "refresh") {
        softRefreshUi(cmd.args || {});
        ok = true;
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
    var d = null;
    try { d = await r.clone().json(); } catch (e) { d = null; }
    if (args.open_url_field) {
      var url = d && (d[args.open_url_field] || d.url || d.portal_url);
      if (url) window.open(url, "_blank", "noopener");
    }
    if (r.ok) {
      softRefreshUi(Object.assign({}, args.body || {}, d && d.subscription ? {
        subscription_id: d.subscription.id,
        allocation_pct: d.subscription.allocation_pct,
        array_share_pct: d.subscription.array_share_pct,
      } : {}));
    } else {
      var errDetail = (d && d.detail) || ("HTTP " + r.status);
      addMsg("agent", "Couldn't save that change: " + String(errDetail).slice(0, 180));
    }
    return r.ok;
  }

  window.__eaDriver = {
    navigate: function (h) { return runCommand({ type: "navigate", args: { hash: h }, id: "drv" }); },
    highlight: highlight,
    fill: fill,
    click: clickEl,
  };

  // ── Voice: GPT Realtime WebRTC (primary) + Web Speech fallback ───────────
  // Latest model (server-side): gpt-realtime-2.1 via /v1/energy-agent/realtime-call

  function syncMicBtn() {
    var b = document.getElementById("eaMic");
    if (b) {
      b.classList.toggle("on", state.listening);
      b.textContent = state.listening ? "Mic on" : "Mic";
    }
  }

  function stopVoice(keepMic) {
    state.listening = false;
    state.speaking = false;
    // WebRTC
    try {
      if (state.dc) { state.dc.close(); }
    } catch (e) {}
    state.dc = null;
    try {
      if (state.pc) { state.pc.close(); }
    } catch (e) {}
    state.pc = null;
    if (state.micStream) {
      if (keepMic) {
        // Stay permitted; mute until next listen
        try { state.micStream.getTracks().forEach(function (t) { t.enabled = false; }); } catch (e) {}
      } else {
        try { state.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        state.micStream = null;
      }
    }
    if (state.audioEl) {
      try { state.audioEl.pause(); state.audioEl.srcObject = null; } catch (e) {}
    }
    // Web Speech fallback
    if (state.recog) {
      try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
      state.recog = null;
    }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.voiceMode = "none";
    syncMicBtn();
  }

  function stopSpeak() {
    // Barge-in: cancel browser TTS; only cancel Realtime if a response is active
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.speaking = false;
    cancelRealtimeIfActive();
  }

  function speak(text) {
    if (!text) return;
    // Prefer GPT Realtime TTS when connected
    if (state.dc && state.dc.readyState === "open") {
      try {
        // If something is already speaking, cancel it first; then speak the new line
        cancelRealtimeIfActive();
        state.rtResponseActive = true;
        // Ask the Realtime model to speak this line (tools already ran server-side)
        state.dc.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Speak the following to the user naturally, in English, no extra commentary:\n\n" +
              String(text).slice(0, 1200),
          },
        }));
        state.speaking = true;
        setStatus("Speaking (GPT voice)…", "speak");
        return;
      } catch (e) {
        state.rtResponseActive = false;
      }
    }
    // Fallback: browser speech synthesis
    if (!window.speechSynthesis) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(String(text).slice(0, 800));
    u.rate = 1.05;
    u.onstart = function () { state.speaking = true; setStatus("Speaking…", "speak"); };
    u.onend = function () {
      state.speaking = false;
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
    };
    window.speechSynthesis.speak(u);
  }

  function dcSend(obj) {
    if (state.dc && state.dc.readyState === "open") {
      try { state.dc.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function handleRealtimeEvent(ev) {
    if (!ev || !ev.type) return;
    // Track whether a Realtime response is in flight (so cancel is safe)
    if (ev.type === "response.created" || ev.type === "response.output_item.added") {
      state.rtResponseActive = true;
    }
    if (
      ev.type === "response.done" ||
      ev.type === "response.cancelled" ||
      ev.type === "response.failed" ||
      ev.type === "output_audio_buffer.stopped"
    ) {
      state.rtResponseActive = false;
    }
    // Model audio lifecycle
    if (ev.type === "output_audio_buffer.started" || ev.type === "response.output_audio.delta") {
      state.speaking = true;
      state.rtResponseActive = true;
      setStatus("Speaking (GPT voice)…", "speak");
    }
    if (ev.type === "output_audio_buffer.stopped" || ev.type === "response.done") {
      state.speaking = false;
      state.rtResponseActive = false;
      if (state.listening) setStatus("Listening…", "listen");
    }
    // User finished speaking — ONE path: show once, then agent turn (tools + speak)
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      var said = (ev.transcript || "").trim();
      if (!said || state.thinking) return;
      // Only cancel if a response is actually running (avoids "no active response")
      cancelRealtimeIfActive();
      addMsg("user", said);
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
      // userAlreadyShown: do not paint the same user line again in turn()
      turn(said, "voice", { userAlreadyShown: true });
    }
    // Do NOT addMsg for assistant Realtime transcripts — agent bubble comes only from turn()
    if (ev.type === "error") {
      var msg = (ev.error && (ev.error.message || ev.error)) || "Realtime error";
      // Benign: cancel when nothing is speaking — ignore, do not alarm the user
      if (isBenignVoiceError(msg)) {
        state.rtResponseActive = false;
        return;
      }
      addMsg("agent", "Voice error: " + String(msg).slice(0, 200));
      setStatus("Voice error", "warn");
    }
  }

  async function ensureMicStream() {
    if (state.micStream) {
      var live = state.micStream.getTracks().some(function (t) { return t.readyState === "live"; });
      if (live) {
        // Re-enable if we muted them after the startup permission grant
        try { state.micStream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}
        return state.micStream;
      }
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser cannot access the microphone.");
    }
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    state.micStream = stream;
    return stream;
  }

  // Avoid double-adding chat reply when Realtime is also speaking
  var _lastSpoken = "";

  /** Primary: GPT Realtime over WebRTC via our server (unified /realtime-call). */
  async function startRealtimeVoice() {
    setStatus("Connecting GPT voice…", "think");
    var stream = await ensureMicStream();

    // Tear down prior peer connection but KEEP the mic stream (permission)
    stopVoice(true);
    stream = await ensureMicStream();

    var pc = new RTCPeerConnection();
    state.pc = pc;

    // Play model audio
    if (!state.audioEl) {
      state.audioEl = document.createElement("audio");
      state.audioEl.autoplay = true;
      state.audioEl.setAttribute("playsinline", "true");
      // Keep element in DOM so autoplay policies are happier
      state.audioEl.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(state.audioEl);
    }
    pc.ontrack = function (e) {
      state.audioEl.srcObject = e.streams[0];
      var p = state.audioEl.play();
      if (p && p.catch) p.catch(function () {});
    };

    stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });

    var dc = pc.createDataChannel("oai-events");
    state.dc = dc;
    dc.addEventListener("message", function (e) {
      try { handleRealtimeEvent(JSON.parse(e.data)); } catch (err) {}
    });
    dc.addEventListener("open", function () {
      // One system: Realtime = ears + mouth only. create_response false = we reply via /chat.
      dcSend({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are Energy Agent's voice. Only speak lines the app asks you to say via response.create. " +
            "Do not invent your own answers to the user; the app handles reasoning and tools.",
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: { type: "server_vad", create_response: false },
            },
          },
        },
      });
      // Single greeting (voice only; panel already has intro text from ensureSession)
      dcSend({
        type: "response.create",
        response: {
          instructions:
            "Greet the user briefly as Energy Agent in one short sentence. " +
            "Say you're ready to help with their solar fleet and invoices.",
        },
      });
      setStatus("Listening (GPT Realtime)…", "listen");
    });

    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    var sdpRes = await fetch(API.realtimeCall, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token(),
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!sdpRes.ok) {
      var errText = await sdpRes.text();
      var detail = errText;
      try { detail = JSON.parse(errText).detail || errText; } catch (e) {}
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    var answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    state.listening = true;
    state.voiceMode = "realtime";
    syncMicBtn();
    setStatus("Listening (GPT Realtime)…", "listen");
    addMsg("agent", "GPT voice connected — talk anytime. I’ll reply out loud.");
  }

  /** Fallback when OpenAI key missing or WebRTC fails: Web Speech + browser TTS */
  function startWebSpeechFallback(fromOpen) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (!fromOpen) {
        addMsg("agent", "No GPT voice key and no browser speech API — type instead.");
      }
      setStatus("Type to chat", "warn");
      return;
    }
    stopVoice();
    // Keep mic permission warm
    ensureMicStream().catch(function () {});

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
        stopSpeak();
        turn(said, "voice");
      } else if (interim) {
        setStatus("Hearing: " + interim.slice(0, 40), "listen");
      }
    };
    recog.onerror = function (e) {
      if (e.error === "not-allowed") {
        addMsg("agent", "Microphone blocked — click the lock icon in the address bar → allow mic, then Mic on.");
        setStatus("Mic blocked", "warn");
        state.listening = false;
        syncMicBtn();
      }
    };
    recog.onend = function () {
      if (state.open && state.listening && state.voiceMode === "webspeech") {
        try { recog.start(); } catch (e) {}
      }
    };
    try {
      recog.start();
      state.recog = recog;
      state.listening = true;
      state.voiceMode = "webspeech";
      syncMicBtn();
      setStatus("Listening (browser fallback)…", "listen");
      addMsg("agent", "Using browser speech (fallback). For real GPT voice, set OPENAI_API_KEY on Railway.");
    } catch (e) {
      addMsg("agent", "Couldn't start the mic: " + (e.message || e));
    }
  }

  async function startVoice(fromOpen) {
    if (!signedIn()) {
      addMsg("agent", "Sign in first.");
      return;
    }
    try {
      // Always request mic first (shows Chrome prompt if needed)
      await ensureMicStream();
    } catch (err) {
      var name = (err && err.name) || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        addMsg("agent", "Microphone permission denied. In Chrome: address bar lock → Site settings → Microphone → Allow, then click Mic.");
        setStatus("Mic blocked", "warn");
      } else {
        addMsg("agent", "Mic error: " + (err.message || err));
        setStatus("Mic error", "warn");
      }
      return;
    }

    // Prefer GPT Realtime if server has OPENAI_API_KEY
    try {
      await startRealtimeVoice();
      return;
    } catch (e) {
      var msg = String(e.message || e);
      if (/not configured|OPENAI_API_KEY|503/i.test(msg)) {
        addMsg("agent", "GPT voice isn’t configured yet (need OPENAI_API_KEY on Railway). Falling back to browser speech.");
      } else {
        addMsg("agent", "GPT voice connect failed: " + msg.slice(0, 180) + " — using browser fallback.");
      }
      startWebSpeechFallback(fromOpen);
    }
  }

  function toggleMic() {
    if (state.listening) {
      stopVoice(true);
      setStatus("Mic off · type anytime", "on");
    } else {
      // Click path — safe for permission prompt
      requestMicFromClick();
    }
  }

  // ── boot: show mic CTA (browsers block silent getUserMedia on load) ──────
  function refreshMicGate() {
    if (!signedIn()) {
      showMicGate(false);
      return;
    }
    // If we already hold a live stream, hide the gate
    if (state.micStream && state.micStream.getTracks().some(function (t) {
      return t.readyState === "live";
    })) {
      showMicGate(false);
      setStatus("Mic ready — click the sun to talk", "on");
      return;
    }
    // Permissions API (Chrome): show CTA when still "prompt" or "denied"
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "microphone" }).then(function (p) {
        if (p.state === "granted") {
          showMicGate(false);
          setStatus("Mic ready — click the sun to talk", "on");
          // Warm stream without needing another click when already granted
          ensureMicStream().then(function () {
            try { state.micStream.getTracks().forEach(function (t) { t.enabled = false; }); } catch (e) {}
          }).catch(function () {});
        } else if (p.state === "denied") {
          showMicGate(true, "Mic blocked — fix in browser settings");
          setStatus("Mic blocked", "warn");
        } else {
          // "prompt" — must click to trigger the browser dialog
          showMicGate(true, "Allow microphone");
          setStatus("Click “Allow microphone” to enable voice", "warn");
        }
        try {
          p.onchange = function () { refreshMicGate(); };
        } catch (e) {}
      }).catch(function () {
        // Safari etc. — always show the click-to-allow chip
        showMicGate(true, "Allow microphone");
      });
    } else {
      showMicGate(true, "Allow microphone");
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot() {
    ensureUi();
    // Hide orb on pure login pages
    if (/\/login/i.test(location.pathname) && !signedIn()) {
      var r = document.getElementById("eaRoot");
      if (r) r.style.display = "none";
      return;
    }
    if (signedIn()) {
      // Don't call getUserMedia here — Chrome ignores it without a user gesture.
      // Show the clickable gate so the user can grant mic with one click.
      setTimeout(refreshMicGate, 400);
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
