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
      '<button type="button" id="eaOrb" aria-label="Open Energy Agent" title="Energy Agent — click to talk">' +
      '<span class="ea-ring" aria-hidden="true"></span></button>' +
      // Visible CTA — browsers only show the mic prompt after a real click
      '<button type="button" id="eaMicGate" class="ea-mic-gate" hidden>' +
      '  <span class="ea-mic-gate-ic" aria-hidden="true">🎙</span>' +
      '  <span class="ea-mic-gate-txt">Allow microphone</span>' +
      '</button>' +
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

    document.getElementById("eaOrb").onclick = function (e) {
      e.preventDefault();
      toggle(); // async; mic requested first inside toggle (user gesture)
    };
    document.getElementById("eaMicGate").onclick = function (e) {
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
    if (orb) orb.classList.toggle("open", state.open);
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
    // Barge-in: cancel browser TTS; Realtime barge-in is handled by server VAD
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.speaking = false;
    if (state.dc && state.dc.readyState === "open") {
      try {
        state.dc.send(JSON.stringify({ type: "response.cancel" }));
      } catch (e) {}
    }
  }

  function speak(text) {
    if (!text) return;
    // Prefer GPT Realtime TTS when connected
    if (state.dc && state.dc.readyState === "open") {
      try {
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
      } catch (e) {}
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
    // Model audio lifecycle
    if (ev.type === "output_audio_buffer.started" || ev.type === "response.output_audio.delta") {
      state.speaking = true;
      setStatus("Speaking (GPT voice)…", "speak");
    }
    if (ev.type === "output_audio_buffer.stopped" || ev.type === "response.done") {
      state.speaking = false;
      if (state.listening) setStatus("Listening…", "listen");
    }
    // User transcript (when available)
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      var said = (ev.transcript || "").trim();
      if (said) {
        addMsg("user", said);
        // Also run our tool brain (Grok/Claude) then speak the result via Realtime
        turn(said, "voice");
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
      }
    }
    // Assistant text transcript (for the chat panel)
    if (ev.type === "response.output_audio_transcript.done" ||
        ev.type === "response.audio_transcript.done") {
      var tr = (ev.transcript || "").trim();
      // Avoid double-adding if we already added from /chat reply
      if (tr && !state.thinking) {
        // only log if it looks like a pure voice turn
      }
    }
    if (ev.type === "error") {
      var msg = (ev.error && (ev.error.message || ev.error)) || "Realtime error";
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
      // Enable input transcription so we can run tools on what you said
      dcSend({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
          },
        },
      });
      // Greet the user in GPT voice
      dcSend({
        type: "response.create",
        response: {
          instructions:
            "Greet the user briefly as Energy Agent. Say you're ready to help with their " +
            "solar fleet, invoices, and earnings. One or two short sentences.",
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
