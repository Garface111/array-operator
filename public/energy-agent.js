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
    greeted: false, // one Realtime greeting per panel session
    touring: false,
    // Speech pipeline — one mouth at a time
    _onSpeakDone: null,
    _speakQueue: Promise.resolve(),
    _speakSeq: 0,
    _lastSpokenPlain: "",
    // Mic hold during TTS attack only (guarded barge-in after ~0.5s)
    _micHeldForSpeak: false,
    _unmuteAfterSpeakTimer: null,
    _speakStartedAt: 0,
    // Debounce duplicate ghost transcripts
    _lastUserSaid: "",
    _lastUserSaidAt: 0,
    // Weekly usage meter soft-warn once per panel session
    _budgetWarned: false,
    _budgetExhausted: false,
    // Speaker mute — kill agent voice (Realtime + browser TTS); text still paints.
    // Persisted so it sticks across panel open/close (Ford 2026-07-13).
    voiceMuted: (function () {
      try { return localStorage.getItem("ea_voice_muted") === "1"; } catch (e) { return false; }
    })(),
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
    var hash = location.hash || "#dashboard";
    return {
      hash: hash,
      tab_label: tabLabel(hash),
      // Always remind the model of live nav labels (hashes are internal only)
      nav_tabs: [
        { label: "Fleet Triage", hash: "#dashboard" },
        { label: "Inverters", hash: "#arrays" },
        { label: "Analysis", hash: "#analysis", note: "Trends is a sub-view here" },
        { label: "Invoices", hash: "#reports" },
        { label: "Resources", hash: "#resources" },
        { label: "Account", hash: "#account" },
      ],
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
    // Desktop entry point. On mobile this is CSS-hidden; #eaFab is the bubble.
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

    // Mobile floating chat bubble — follows the user (position:fixed). Collapses
    // the open sheet; expands it. Desktop CSS hides this node.
    if (!document.getElementById("eaFab")) {
      var fab = document.createElement("button");
      fab.type = "button";
      fab.id = "eaFab";
      fab.setAttribute("aria-label", "Open Energy Agent");
      fab.title = "Energy Agent — chat";
      fab.innerHTML =
        '<span class="ea-fab-ic" aria-hidden="true"></span>' +
        '<span class="ea-fab-label">Energy Agent</span>';
      document.body.appendChild(fab);
    }

    // Dim page while chat sheet is open on mobile (tap to collapse)
    if (!document.getElementById("eaBackdrop")) {
      var bd = document.createElement("button");
      bd.type = "button";
      bd.id = "eaBackdrop";
      bd.setAttribute("aria-label", "Close Energy Agent");
      bd.tabIndex = -1;
      document.body.appendChild(bd);
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
      '    <p>Your operator + site improver — marks up changes, judges them, ships small UI live.</p></div>' +
      '    <button type="button" class="ea-x" id="eaClose" aria-label="Close">×</button>' +
      "  </div>" +
      '  <div class="ea-status"><i class="ea-dot" id="eaDot"></i>' +
      '    <span id="eaStatusText">Ready</span>' +
      '    <span class="ea-budget" id="eaBudget" aria-label="Weekly AI usage">' +
      '      <span class="ea-usage ea-usage-ok">' +
      '        <span class="ea-usage-label">Weekly</span>' +
      '        <span class="ea-usage-track" aria-hidden="true">' +
      '          <span class="ea-usage-fill" id="eaUsageFill" style="width:0%"></span>' +
      '        </span>' +
      '      </span>' +
      '    </span></div>' +
      '  <div class="ea-tools" id="eaTools"></div>' +
      '  <div class="ea-tour-cap" id="eaTourCap" hidden>' +
      '    <span class="ea-tour-kicker" id="eaTourKicker">Tour</span>' +
      '    <span id="eaTourCapText"></span></div>' +
      '  <div class="ea-msgs" id="eaMsgs"></div>' +
      '  <div class="ea-pending" id="eaPending" hidden></div>' +
      // Site-improve compose (screenshot markup → describe → judge pipeline)
      '  <div class="ea-improve" id="eaImprove" hidden>' +
      '    <div class="ea-improve-head"><b>Improve this site</b>' +
      '      <button type="button" class="ea-improve-x" id="eaImproveCancel" aria-label="Cancel improve">×</button></div>' +
      '    <p class="ea-improve-lead" id="eaImproveLead">Circle the spot on the page, then describe the change.</p>' +
      '    <div class="ea-improve-thumb" id="eaImproveThumb" hidden>' +
      '      <img id="eaImproveImg" alt="Your marked screenshot">' +
      '      <button type="button" id="eaImproveRemark">Re-circle</button></div>' +
      '    <textarea id="eaImproveText" rows="2" maxlength="800" placeholder="e.g. Put a total kWh badge right here"></textarea>' +
      '    <div class="ea-improve-row">' +
      '      <button type="button" class="ea-improve-mark" id="eaImproveMark">Circle the spot</button>' +
      '      <button type="button" class="ea-improve-send" id="eaImproveSend">Build this →</button>' +
      '    </div>' +
      '    <div class="ea-improve-msg" id="eaImproveMsg"></div>' +
      "  </div>" +
      '  <div class="ea-journey" id="eaJourney" hidden role="status" aria-live="polite"></div>' +
      '  <div class="ea-footer">' +
      '    <div class="ea-compose" id="eaCompose">' +
      '      <div class="ea-compose-shell">' +
      '        <textarea id="eaInput" rows="2" placeholder="Message Energy Agent…"></textarea>' +
      '        <div class="ea-compose-bar">' +
      '          <button type="button" class="ea-chip" id="eaImproveOpen" title="Mark up the page and ship a small improvement">' +
      '            <span class="ea-chip-ic" aria-hidden="true">✦</span><span class="ea-chip-lbl">Improve</span></button>' +
      '          <button type="button" class="ea-chip ea-mic" id="eaMic" title="Toggle microphone">' +
      '            <span class="ea-chip-ic" aria-hidden="true">🎙</span><span class="ea-chip-lbl">Mic</span></button>' +
      '          <button type="button" class="ea-chip ea-mute" id="eaMute" title="Mute agent voice">' +
      '            <span class="ea-chip-ic" aria-hidden="true">🔊</span><span class="ea-chip-lbl">Mute</span></button>' +
      '          <span class="ea-compose-spacer"></span>' +
      '          <button type="button" class="ea-send" id="eaSend" title="Send">' +
      '            <span class="ea-send-lbl">Send</span><span class="ea-send-ic" aria-hidden="true">↑</span></button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="ea-legal">Only your account · site changes are judge-gated · no billing edits</div>' +
      '  </div>';
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
    var fabEl = document.getElementById("eaFab");
    if (fabEl) {
      fabEl.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      };
    }
    var backdrop = document.getElementById("eaBackdrop");
    if (backdrop) {
      backdrop.onclick = function (e) {
        e.preventDefault();
        setOpen(false); // collapse chat sheet → bubble stays
      };
    }
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
    document.getElementById("eaMute").onclick = function (e) {
      e.preventDefault();
      setVoiceMuted(!state.voiceMuted);
    };
    syncMuteBtn();
    applyVoiceMuteToAudio();
    var eaIn = document.getElementById("eaInput");
    eaIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    // Auto-grow the raised composer row (cap ~5 lines)
    function growInput() {
      eaIn.style.height = "auto";
      var h = Math.min(120, Math.max(52, eaIn.scrollHeight));
      eaIn.style.height = h + "px";
    }
    eaIn.addEventListener("input", growInput);
    setTimeout(growInput, 0);
    // Site improve (merged "Wish this was better")
    document.getElementById("eaImproveOpen").onclick = function (e) {
      e.preventDefault();
      openImproveFlow({ markFirst: true });
    };
    document.getElementById("eaImproveCancel").onclick = function () { closeImproveCompose(); };
    document.getElementById("eaImproveMark").onclick = function () { launchMarkCapture(); };
    document.getElementById("eaImproveRemark").onclick = function () { launchMarkCapture(); };
    document.getElementById("eaImproveSend").onclick = function () { submitImprove(); };
    document.getElementById("eaImproveText").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitImprove(); }
    });
  }

  // ── Improve-the-site (merged with feature-suggestion + judge pipeline) ──
  var improve = {
    shot: null,
    activeId: null,
    poll: null,
    since: 0,
  };

  function openImproveFlow(opts) {
    opts = opts || {};
    ensureUi();
    if (!state.open) {
      // Open dock without killing mic if already open path
      state.open = true;
      var panel = document.getElementById("eaPanel");
      var orb = document.getElementById("eaOrb");
      if (panel) panel.classList.add("open");
      if (orb) { orb.classList.add("open", "active"); }
      document.body.classList.add("ea-shell-open");
    }
    showImproveCompose(true);
    addMsg("agent",
      "Let's improve the site. I'll freeze the page so you can circle the spot — " +
      "then type one short sentence. An AI judge reviews it; small UI changes can ship live. " +
      "Billing and money math never auto-ship.");
    if (opts.markFirst !== false) {
      setTimeout(launchMarkCapture, 350);
    }
  }

  function showImproveCompose(show) {
    var box = document.getElementById("eaImprove");
    if (box) box.hidden = !show;
  }

  function closeImproveCompose() {
    showImproveCompose(false);
    improve.shot = null;
    var img = document.getElementById("eaImproveImg");
    var thumb = document.getElementById("eaImproveThumb");
    var ta = document.getElementById("eaImproveText");
    var msg = document.getElementById("eaImproveMsg");
    if (img) img.removeAttribute("src");
    if (thumb) thumb.hidden = true;
    if (ta) ta.value = "";
    if (msg) msg.textContent = "";
  }

  function launchMarkCapture() {
    if (!window.__aoImprove || typeof window.__aoImprove.startMark !== "function") {
      addMsg("agent", "Markup tools aren't loaded yet — refresh the page once and try Improve again.");
      return;
    }
    setStatus("Circle the spot on the page…", "think");
    window.__aoImprove.startMark({ viaAgent: true });
  }

  /** Called by the feature-wish markup script after the user circles a spot. */
  window.__eaOpenImprove = function (payload) {
    payload = payload || {};
    ensureUi();
    if (!state.open) {
      state.open = true;
      var panel = document.getElementById("eaPanel");
      var orb = document.getElementById("eaOrb");
      if (panel) panel.classList.add("open");
      if (orb) { orb.classList.add("open", "active"); }
      document.body.classList.add("ea-shell-open");
    }
    showImproveCompose(true);
    improve.shot = payload.screenshot_b64 || null;
    var thumb = document.getElementById("eaImproveThumb");
    var img = document.getElementById("eaImproveImg");
    var lead = document.getElementById("eaImproveLead");
    var msg = document.getElementById("eaImproveMsg");
    if (improve.shot && img && thumb) {
      img.src = "data:image/png;base64," + improve.shot;
      thumb.hidden = false;
    } else if (thumb) {
      thumb.hidden = true;
    }
    if (lead) {
      lead.textContent = improve.shot
        ? "Marked. One short sentence — what should be there?"
        : (payload.skipped_mark
          ? "No mark — describe the change in a sentence."
          : "Describe the change (you can re-circle anytime).");
    }
    if (msg) msg.textContent = "";
    setStatus("Describe the change…", "on");
    setTimeout(function () {
      var ta = document.getElementById("eaImproveText");
      if (ta) ta.focus();
    }, 80);
  };

  async function submitImprove() {
    var ta = document.getElementById("eaImproveText");
    var msg = document.getElementById("eaImproveMsg");
    var text = (ta && ta.value || "").trim();
    if (!text) {
      if (msg) {
        msg.style.color = "#b45309";
        msg.textContent = improve.shot
          ? "One short sentence — what should be at the spot you circled?"
          : "Type a short wish first.";
      }
      return;
    }
    if (msg) { msg.style.color = ""; msg.textContent = "Sending to the AI engineer + judge…"; }
    var sendBtn = document.getElementById("eaImproveSend");
    if (sendBtn) sendBtn.disabled = true;
    try {
      var d = null;
      if (window.__aoImprove && typeof window.__aoImprove.submitWish === "function") {
        d = await window.__aoImprove.submitWish(text, improve.shot);
      } else {
        // Fallback direct API
        var r = await fetch("/v1/feature-suggestion", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text: text, screenshot_b64: improve.shot || undefined }),
        });
        d = await r.json().catch(function () { return null; });
        if (!(d && d.ok && d.id)) throw new Error("submit failed");
      }
      if (ta) ta.value = "";
      closeImproveCompose();
      addMsg("user", "Improve site: " + text);
      addMsg("agent", "Got it — the judge is reviewing. I'll update you as it builds.");
      watchBuild(d.id);
    } catch (e) {
      if (msg) {
        msg.style.color = "#b45309";
        msg.textContent = "Couldn't send — try again in a moment.";
      }
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function watchBuild(id) {
    improve.activeId = id;
    improve.since = Date.now();
    improve._toldFail = false;
    improve._pendingEscalateId = null;
    // Ensure dock is open so journey is visible (not the old floating card)
    if (!state.open) {
      state.open = true;
      var panel = document.getElementById("eaPanel");
      var orb = document.getElementById("eaOrb");
      if (panel) panel.classList.add("open");
      if (orb) { orb.classList.add("open", "active"); }
      document.body.classList.add("ea-shell-open");
    }
    // Kill residual floating wish chrome
    try {
      var wrap = document.getElementById("fsWrap");
      if (wrap) wrap.style.display = "none";
      var fj = document.getElementById("fsJourney");
      if (fj) fj.classList.remove("open");
      var mini = document.getElementById("fsMini");
      if (mini) mini.classList.remove("show");
    } catch (e) {}
    renderEaJourney("new");
    if (improve.poll) clearInterval(improve.poll);
    improve.poll = setInterval(tickBuildStatus, 4000);
    setTimeout(tickBuildStatus, 800);
  }
  window.__eaBuildWatch = watchBuild;

  function tickBuildStatus() {
    if (!improve.activeId) return;
    fetch("/v1/feature-suggestion/" + encodeURIComponent(improve.activeId) + "/status")
      .then(function (r) {
        if (r.status === 404) {
          renderEaJourney("reviewed", {
            failed: true,
            detail: "Request not found — it may have expired. Want me to escalate to the developer?",
          });
          stopBuildWatch();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d || !d.status) { renderEaJourney("new"); return; }
        if (d.status === "shipped") {
          renderEaJourney("shipped", { detail: d.detail });
          addMsg("agent", d.detail || "Your site change is live — refresh to see it.");
          if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
        } else if (d.status === "reviewed") {
          var elapsed = Math.floor((Date.now() - improve.since) / 1000);
          // Surface held outcome as soon as the judge finishes (don't wait 90s)
          var held = d.can_escalate || d.outcome === "passed" || d.outcome === "branched"
            || d.outcome === "backlog" || d.outcome === "failed_ship" || d.outcome === "held";
          if (held || elapsed > 25) {
            var why = d.detail || "The judge did not auto-ship this change.";
            renderEaJourney("reviewed", { failed: true, detail: why, canEscalate: true });
            if (!improve._toldFail) {
              improve._toldFail = true;
              addMsg("agent",
                "**Why this didn't auto-ship:** " + why + "\n\n" +
                "A pure color/CSS tweak should usually go through — this may have been " +
                "misclassified, the review agent may still be catching up, or the judge " +
                "wanted a human look.\n\n" +
                "Want me to **escalate this to the developer (Ford)** so it gets a human review?");
              improve._pendingEscalateId = improve.activeId;
            }
            if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
          } else {
            renderEaJourney("reviewed", { detail: d.detail });
          }
        } else {
          renderEaJourney(d.status, { detail: d.detail });
        }
      })
      .catch(function () {});
  }

  function stopBuildWatch() {
    improve.activeId = null;
    if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
  }

  var JOURNEY_STEPS = [
    { key: "received", label: "Received", sub: "Got your mark-up and note" },
    { key: "reading", label: "AI is reading it", sub: "Looking at what you circled" },
    { key: "deciding", label: "Judge deciding", sub: "Approve, branch, or pass" },
    { key: "building", label: "Building", sub: "Writing the code" },
    { key: "deploying", label: "Deploying live", sub: "Pushing to the site" },
    { key: "live", label: "Live on the site", sub: "Refresh to see your change" },
  ];

  function mapBuildStep(st, elapsedSec) {
    if (st === "shipped") return 5;
    if (st === "building") return elapsedSec > 120 ? 4 : 3;
    if (st === "reviewed") return 2;
    if (elapsedSec < 8) return 0;
    if (elapsedSec < 25) return 1;
    return 2;
  }

  function renderEaJourney(st, opts) {
    opts = opts || {};
    var host = document.getElementById("eaJourney");
    if (!host) return;
    var elapsed = improve.since ? Math.floor((Date.now() - improve.since) / 1000) : 0;
    var stepIdx = mapBuildStep(st || "new", elapsed);
    var failed = !!opts.failed;
    var detail = opts.detail || "";
    host.hidden = false;
    var title = st === "shipped" ? "It's live." : failed ? "Couldn't auto-ship." : "Building your change…";
    var lead = st === "shipped"
      ? (detail || "Your change is on the site. Refresh to see it.")
      : failed
        ? (detail || "Judge held this for a human look. Nothing was lost.")
        : (detail || "Judge reviews first — pure UI (colors, layout, copy) usually ships live.");
    var html = "<h4>" + esc(title) + "</h4><p class=\"ea-j-lead\">" + esc(lead) + "</p><ul class=\"ea-j-steps\">";
    JOURNEY_STEPS.forEach(function (s, i) {
      var cls = "";
      if (st === "shipped" || i < stepIdx) cls = "done";
      else if (i === stepIdx) cls = failed ? "fail" : "active";
      var icon = cls === "done" ? "✓" : cls === "active" ? "●" : cls === "fail" ? "!" : String(i + 1);
      html += '<li class="' + cls + '"><i>' + icon + "</i><div><b>" + s.label + "</b><span>" + s.sub + "</span></div></li>";
    });
    html += "</ul><div class=\"ea-j-actions\">";
    if (st === "shipped") {
      html += '<button type="button" id="eaJReload">Refresh page</button>';
    }
    if (failed || opts.canEscalate) {
      html += '<button type="button" id="eaJEscalate" class="ea-j-esc">Escalate to developer</button>';
    }
    html += '<button type="button" id="eaJDismiss">' + (st === "shipped" || failed ? "Dismiss" : "Hide") + "</button></div>";
    host.innerHTML = html;
    var reload = document.getElementById("eaJReload");
    if (reload) reload.onclick = function () { location.reload(); };
    var escBtn = document.getElementById("eaJEscalate");
    if (escBtn) escBtn.onclick = function () {
      addMsg("user", "Yes — escalate this site change to the developer.");
      turn(
        "Please escalate_to_ford: site improvement request #" +
          (improve.activeId || improve._pendingEscalateId || "?") +
          " was held by the judge. Detail: " + (detail || "not auto-shipped") +
          ". User wants a human developer review.",
        "text",
        { userAlreadyShown: true }
      );
    };
    var dismiss = document.getElementById("eaJDismiss");
    if (dismiss) dismiss.onclick = function () {
      if (st === "shipped" || failed) {
        stopBuildWatch();
        host.hidden = true;
        host.innerHTML = "";
      } else {
        host.hidden = true;
      }
    };
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
    var fab = document.getElementById("eaFab");
    if (el) el.textContent = text;
    if (dot) {
      dot.className = "ea-dot" + (mode === "on" ? " on" : mode === "warn" ? " warn" : "");
    }
    function paintOrb(node) {
      if (!node) return;
      node.classList.toggle("listening", mode === "listen");
      node.classList.toggle("thinking", mode === "think");
      node.classList.toggle("speaking", mode === "speak");
      node.classList.toggle("open", state.open);
    }
    paintOrb(orb);
    paintOrb(fab);
  }

  /**
   * Weekly AI usage meter ($5 thinking + voice combined).
   * Fills 0→100% as spend approaches the cap — no cash countdown in the chrome.
   */
  function setBudget(b) {
    state.budget = b;
    var el = document.getElementById("eaBudget");
    if (!el || !b) return;
    var cap = Number(b.weekly_budget_usd);
    if (!(cap > 0)) cap = 5;
    var spent = Number(b.spent_usd) || 0;
    var pct = b.pct_used != null
      ? Number(b.pct_used)
      : Math.min(100, (spent / cap) * 100);
    if (!(pct >= 0)) pct = 0;
    if (pct > 100) pct = 100;
    var level = !b.ok || pct >= 99.5 ? "full" : (b.warn || pct >= 80) ? "warn" : "ok";
    var bd = b.breakdown || {};
    var tip =
      "Weekly Energy Agent usage (thinking + voice) · " +
      Math.round(pct) + "% of $" + cap.toFixed(0) + " · resets each week";
    if (bd.thinking_usd != null || bd.voice_usd != null) {
      tip +=
        " · Thinking ~$" + (Number(bd.thinking_usd) || 0).toFixed(2) +
        " · Voice ~$" + (Number(bd.voice_usd) || 0).toFixed(2);
    }
    el.innerHTML =
      '<span class="ea-usage ea-usage-' + level + '" title="' + esc(tip) + '">' +
      '<span class="ea-usage-label">Weekly</span>' +
      '<span class="ea-usage-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
      'aria-valuenow="' + Math.round(pct) + '" aria-label="Weekly usage ' + Math.round(pct) + ' percent">' +
      '<span class="ea-usage-fill" id="eaUsageFill" style="width:' + pct.toFixed(1) + '%"></span>' +
      "</span></span>";
    el.setAttribute(
      "aria-label",
      "Weekly AI usage " + Math.round(pct) + " percent of " + cap.toFixed(0) + " dollar limit"
    );
    // One soft heads-up when crossing the warn line (not every refresh)
    if (b.warn && !state._budgetWarned) {
      state._budgetWarned = true;
      try {
        addMsg(
          "agent",
          "Heads up — you're past 80% of this week's Energy Agent allowance " +
            "(thinking + voice). The meter fills up as you use it; at 100% I'll pause until next week."
        );
      } catch (e) {}
    }
    if (!b.ok && !state._budgetExhausted) {
      state._budgetExhausted = true;
      setStatus("Weekly limit reached", "warn");
    }
  }

  /**
   * Safe lightweight markdown for chat bubbles.
   * Supports: **bold**, *italic*, `code`, ```blocks```, # headers, - lists,
   * [links](https://…), line breaks. Escapes HTML first so model output can't inject tags.
   */
  function formatMsg(text) {
    var raw = String(text == null ? "" : text);
    // Normalize fancy quotes/asterisks models sometimes emit
    raw = raw.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'");

    // Protect fenced code blocks before escaping line structure
    var blocks = [];
    raw = raw.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var i = blocks.length;
      blocks.push(
        '<pre class="ea-code"' +
          (lang ? ' data-lang="' + esc(lang) + '"' : "") +
          "><code>" +
          esc(code.replace(/^\n+|\n+$/g, "")) +
          "</code></pre>"
      );
      return "\n%%EA_BLOCK_" + i + "%%\n";
    });

    // Protect inline code
    var inlines = [];
    raw = raw.replace(/`([^`\n]+)`/g, function (_, code) {
      var i = inlines.length;
      inlines.push('<code class="ea-icode">' + esc(code) + "</code>");
      return "%%EA_CODE_" + i + "%%";
    });

    // Escape the rest
    var s = esc(raw);

    // Headings (line-start)
    s = s.replace(/^######\s+(.+)$/gm, '<div class="ea-h ea-h6">$1</div>');
    s = s.replace(/^#####\s+(.+)$/gm, '<div class="ea-h ea-h5">$1</div>');
    s = s.replace(/^####\s+(.+)$/gm, '<div class="ea-h ea-h4">$1</div>');
    s = s.replace(/^###\s+(.+)$/gm, '<div class="ea-h ea-h3">$1</div>');
    s = s.replace(/^##\s+(.+)$/gm, '<div class="ea-h ea-h2">$1</div>');
    s = s.replace(/^#\s+(.+)$/gm, '<div class="ea-h ea-h1">$1</div>');

    // Bold then italic (** before *)
    s = s.replace(/\*\*([^*\n][\s\S]*?[^*\n]|\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n][\s\S]*?[^_\n]|\S)__/g, "<strong>$1</strong>");
    // Single-asterisk italic — avoid matching inside already-processed strong tags
    s = s.replace(/(^|[^*\\])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    // Links — https only
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a class="ea-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Restore inline code
    s = s.replace(/%%EA_CODE_(\d+)%%/g, function (_, i) {
      return inlines[Number(i)] || "";
    });

    // Line-based lists & paragraphs
    var lines = s.split("\n");
    var out = [];
    var inUl = false;
    var inOl = false;
    function closeLists() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Restored code-block placeholders are whole lines
      var blockM = line.match(/^%%EA_BLOCK_(\d+)%%$/);
      if (blockM) {
        closeLists();
        out.push(blocks[Number(blockM[1])] || "");
        continue;
      }
      // Heading already a div — flush lists
      if (/^<div class="ea-h/.test(line)) {
        closeLists();
        out.push(line);
        continue;
      }
      var ul = line.match(/^\s*[-•]\s+(.+)$/);
      var ol = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (ul) {
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push('<ul class="ea-ul">'); inUl = true; }
        out.push("<li>" + ul[1] + "</li>");
        continue;
      }
      if (ol) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push('<ol class="ea-ol">'); inOl = true; }
        out.push("<li>" + ol[2] + "</li>");
        continue;
      }
      closeLists();
      if (/^\s*$/.test(line)) {
        out.push('<div class="ea-sp"></div>');
      } else {
        out.push('<p class="ea-p">' + line + "</p>");
      }
    }
    closeLists();

    // Restore any leftover block tokens
    var html = out.join("");
    html = html.replace(/%%EA_BLOCK_(\d+)%%/g, function (_, i) {
      return blocks[Number(i)] || "";
    });
    return html || "";
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
      var prev = (last.getAttribute("data-raw") || last.textContent || "").trim();
      if (prev === t || prev.indexOf(t) === 0 || t.indexOf(prev) === 0) {
        return false;
      }
    }
    if (opts.skipIfDup && state._lastUserSaid === t && role === "user") return false;
    if (role === "user") state._lastUserSaid = t;
    var d = document.createElement("div");
    d.className = "ea-msg " + (role === "user" ? "user" : "agent");
    d.setAttribute("data-role", role);
    d.setAttribute("data-raw", t);
    // Agent replies get full markdown; user bubbles stay plain (they typed it)
    // unless they include obvious markdown markers.
    var rich = role === "agent" || /\*\*|__|`|^#\s|^\s*[-•]\s/m.test(t);
    if (rich) d.innerHTML = formatMsg(t);
    else d.textContent = t;
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
      // Text-only mode (muted): open panel, no mic / no GPT voice — saves credits.
      if (signedIn() && state.voiceMuted) {
        await setOpen(true);
        setStatus("Text only — voice off", "on");
        return;
      }
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
        // startVoice uses the stream we already have (skipped when muted)
        if (micOk && !state.listening && !state.voiceMuted) {
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
    var fab = document.getElementById("eaFab");
    if (panel) panel.classList.toggle("open", state.open);
    if (orb) {
      orb.classList.toggle("open", state.open);
      orb.classList.toggle("active", state.open);
      orb.setAttribute("aria-pressed", state.open ? "true" : "false");
      orb.setAttribute("aria-label", state.open ? "Close Energy Agent" : "Open Energy Agent");
    }
    if (fab) {
      fab.classList.toggle("open", state.open);
      fab.setAttribute("aria-pressed", state.open ? "true" : "false");
      fab.setAttribute("aria-label", state.open ? "Minimize Energy Agent" : "Open Energy Agent");
      fab.title = state.open ? "Minimize chat" : "Energy Agent — chat";
    }
    // Desktop: shift site content right. Mobile CSS zeroes the margin.
    document.body.classList.toggle("ea-shell-open", state.open);
    if (state.open) {
      await ensureSession();
      // Voice usually already starting from toggle(); only start here if mic ready
      // and we aren't listening yet (e.g. re-open after close). Never when muted.
      if (signedIn() && !state.voiceMuted && !state.listening && state.micStream) {
        try { await startVoice(true); } catch (e) {}
      } else if (state.voiceMuted) {
        setStatus("Text only — voice off", "on");
      }
    } else {
      // Full teardown on panel close only (kills GPT voice pipe)
      stopVoice(true);
      state.greeted = false;
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
  /** Local short-circuit: user asks to improve the UI → markup flow, no LLM needed. */
  function isImproveIntent(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    return /^(improve|fix|change|redesign|update)\s+(this\s+)?(site|page|ui|screen|layout)\b/.test(t)
      || /\b(wish this was better|make this better|improve the site|change the ui|mark.?up)\b/.test(t)
      || /^(can you |please )?(improve|fix) (this|the) (site|page|ui)\??$/.test(t);
  }

  function isEscalateYes(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    if (improve._pendingEscalateId == null && !improve.activeId) return false;
    return /^(yes|yep|yeah|please|do it|escalate|send it|tell ford|notify|go ahead)\b/.test(t)
      || /\b(escalate|developer|ford)\b/.test(t);
  }

  function detectTourId(text) {
    var t = String(text || "").toLowerCase();
    // "what are the tabs" is not a tour — LLM answers from persona map
    if (/\bwhat (are|is) (all )?(the )?(different )?tabs\b/.test(t)) return null;
    if (!/\b(walk\s*me|walkthrough|show\s+me|tour|guide\s+me|take\s+me\s+through)\b/.test(t)
        && !/\bexplain\b.*\btab\b/.test(t)) {
      if (!/\b(master\s*account|account\s+tab|invoices?\s+tab|inverters?\s+tab|fleet\s+triage|arrays?\s+tab)\b/.test(t)) {
        return null;
      }
      if (!/\b(show|open|explain|walk)\b/.test(t)) return null;
    }
    if (/\b(master\s*account|account\s+tab|#account)\b/.test(t)
        || (/\baccount\b/.test(t) && /\b(walk|tour|show|explain)\b/.test(t))) {
      return "master_account";
    }
    if (/\b(invoice|offtaker)\b/.test(t) || (/\breports?\b/.test(t) && /\btab\b/.test(t))) {
      return "reports";
    }
    if (/\b(inverter|fleet\s+triage|fleet\s+canvas)\b/.test(t)
        || (/\barrays?\b/.test(t) && /\btab\b/.test(t))) {
      return "arrays";
    }
    if (/\banalysis\b/.test(t) || /\btrends?\b/.test(t)) return "analysis";
    return null;
  }

  /** Local answer when user asks what the tabs are — never invent old names. */
  function tabsCheatSheet() {
    return (
      "**Array Operator tabs** (exactly as labeled in the top bar):\n\n" +
      "1. **Fleet Triage** — fleet health at a glance; who needs attention\n" +
      "2. **Inverters** — live canvas of every inverter (columns = sites)\n" +
      "3. **Analysis** — deeper digs; *Through time* / trends live here as a sub-view " +
      "(there is no separate Trends tab)\n" +
      "4. **Invoices** — offtaker invoices, drafts, send pipeline\n" +
      "5. **Resources** — net-metering rates and regulatory news\n" +
      "6. **Account** — company, email, plan, card, auto-refresh, files\n\n" +
      "Want me to open one and walk you through it?"
    );
  }

  async function turn(text, source, opts) {
    opts = opts || {};
    if (!text) return;
    var sid = await ensureSession();
    if (!sid) return;
    if (!opts.userAlreadyShown) {
      addMsg("user", text);
    }
    // Seamless merge: site-improve intent opens mark-up without waiting on the brain
    if (isImproveIntent(text)) {
      openImproveFlow({ markFirst: true });
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
      return;
    }
    // Tab names must match the top bar — answer locally so the model can't invent Dashboard/Arrays/Reports
    if (/\bwhat (are|is) (all )?(the )?(different )?tabs\b/i.test(text)
        || /\b(list|name|explain) (all )?(the )?tabs\b/i.test(text)
        || /\btabs (do i|are there|in (the )?(app|nav|bar))\b/i.test(text)) {
      addMsg("agent", tabsCheatSheet());
      try { speak("Those are the six tabs in the top bar — Fleet Triage, Inverters, Analysis, Invoices, Resources, and Account."); } catch (e) {}
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
      return;
    }
    // Show-and-tell tours: run fully client-side (top→bottom, voice lockstep).
    // Do NOT also call the LLM mid-tour — that was causing disjointed audio + spam bubbles.
    var tourId = detectTourId(text);
    if (tourId) {
      setStatus("Walking you through…", "think");
      try {
        await runTour({ tour_id: tourId });
        // Quiet accurate wrap-up for Master Account only (no second tour)
        if (tourId === "master_account") {
          text = (
            "Tour finished. Call ONLY account_summary (include_billing true). " +
            "Reply in 2 short sentences: company, email (contact_email), plan, card-on-file. " +
            "Do NOT navigate or run another tour. Do NOT invent null email."
          );
        } else {
          setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
          return;
        }
      } catch (e) {
        addMsg("agent", "Couldn't run the visual tour — I'll explain from data instead.");
      }
    }
    // After a held ship, "yes escalate" → Ford without full LLM loop
    if (isEscalateYes(text)) {
      var eid = improve._pendingEscalateId || improve.activeId;
      improve._pendingEscalateId = null;
      // fall through to LLM with clear escalate instruction
      text = "Call escalate_to_ford now. Summary: site improvement #" + eid +
        " was held by the auto-ship judge; user wants developer review. " +
        "Original user message about the UI change was recently submitted.";
    }
    state.thinking = true;
    setStatus("Thinking…", "think");
    // Barge-in: user started a new turn — stop any leftover speech so we don't
    // double-talk. Do NOT cancel again later mid-turn (that caused self-interrupts).
    if (!state.touring) stopSpeak({ reason: "new_turn" });
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
      // One mouth: queue GPT voice (or stay silent if mouth disconnected — never
      // surprise the user with robotic browser TTS after they've used GPT voice).
      await enqueueSpeak(reply, { source: "chat" });
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
        // Normalize aliases → real hashes. User-facing labels are separate (TAB_LABELS).
        var aliases = {
          "#invoice": "#reports", "#invoices": "#reports", "#billing": "#reports",
          "#offtaker": "#reports", "#offtakers": "#reports",
          "#inverter": "#arrays", "#inverters": "#arrays",
          "#fleet": "#dashboard", "#triage": "#dashboard",
          "#fleettriage": "#dashboard", "#fleet-triage": "#dashboard",
          "#master": "#account", "#settings": "#account",
          "#masteraccount": "#account", "#master-account": "#account",
          "#trends": "#analysis", "#trend": "#analysis", "#through-time": "#analysis",
        };
        var h = hash.toLowerCase().replace(/\s+/g, "");
        if (aliases[h]) hash = aliases[h];
        // Spoken/legacy names without #
        var nameAlias = {
          dashboard: "#dashboard", "fleet triage": "#dashboard", fleettriage: "#dashboard",
          arrays: "#arrays", inverters: "#arrays",
          analysis: "#analysis", trends: "#analysis",
          reports: "#reports", invoices: "#reports",
          account: "#account", "master account": "#account",
          resources: "#resources",
        };
        var rawName = String((cmd.args && (cmd.args.tab || cmd.args.name || cmd.args.label)) || "")
          .toLowerCase().trim();
        if (nameAlias[rawName]) hash = nameAlias[rawName];
        location.hash = hash;
        // Help sandbox router if it listens to hashchange
        try {
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (e) {
          try { window.dispatchEvent(new Event("hashchange")); } catch (e2) {}
        }
        ok = true;
        detail = { hash: hash, tab: tabLabel(hash) };
        // Tours pass silent — avoid spamming "Opening…" over the guided narration
        if (!(cmd.args && cmd.args.silent) && !state.touring) {
          addMsg("agent", "Opening **" + tabLabel(hash) + "**…");
        }
      } else if (cmd.type === "highlight") {
        ok = highlight(
          cmd.args && cmd.args.selector,
          (cmd.args && cmd.args.ms) || 4500,
          cmd.args && cmd.args.say
        );
        detail = { selector: cmd.args && cmd.args.selector };
      } else if (cmd.type === "tour" || cmd.type === "walkthrough") {
        ok = await runTour(cmd.args || {});
        detail = { steps: ((cmd.args && cmd.args.steps) || []).length };
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
      } else if (cmd.type === "improve_site" || cmd.type === "site_improve") {
        // Merge path: freeze → circle → describe → judge pipeline
        openImproveFlow({ markFirst: cmd.args && cmd.args.mark_first !== false });
        if (cmd.args && cmd.args.suggestion_id) {
          watchBuild(cmd.args.suggestion_id);
        }
        ok = true;
        detail = cmd.args || {};
      } else if (cmd.type === "watch_build") {
        if (cmd.args && cmd.args.suggestion_id) watchBuild(cmd.args.suggestion_id);
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

  function clearHighlights() {
    try {
      document.querySelectorAll(".ea-hl, .ea-hl-pulse").forEach(function (el) {
        el.classList.remove("ea-hl", "ea-hl-pulse");
      });
    } catch (e) {}
  }

  function queryFirst(sel) {
    if (!sel) return null;
    var el = null;
    String(sel).split(",").some(function (part) {
      try { el = document.querySelector(part.trim()); } catch (e) { el = null; }
      return !!el && el.offsetParent !== null || !!el;
    });
    return el;
  }

  async function waitForSelector(sel, timeoutMs) {
    var t0 = Date.now();
    var limit = timeoutMs || 4000;
    while (Date.now() - t0 < limit) {
      var el = queryFirst(sel);
      if (el) return el;
      await sleep(120);
    }
    return queryFirst(sel);
  }

  function highlight(sel, ms, say) {
    if (!sel) return false;
    clearHighlights();
    var el = queryFirst(sel);
    if (!el) return false;
    el.classList.add("ea-hl", "ea-hl-pulse");
    try { el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch (e) {}
    // say is handled by the tour sequencer (speakAndWait) — keep highlight pure
    if (say && !state.touring) {
      addMsg("agent", say);
      try { speak(say); } catch (e) {}
    }
    setTimeout(function () {
      el.classList.remove("ea-hl", "ea-hl-pulse");
    }, ms || 4500);
    return true;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function stripMd(text) {
    return String(text || "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/#{1,6}\s+/g, "")
      .replace(/\n+/g, " ")
      .trim();
  }

  function setTourCaption(text, stepIdx, total) {
    var cap = document.getElementById("eaTourCap");
    var body = document.getElementById("eaTourCapText");
    var kicker = document.getElementById("eaTourKicker");
    if (!cap || !body) return;
    if (!text) {
      cap.hidden = true;
      body.textContent = "";
      return;
    }
    cap.hidden = false;
    if (kicker) {
      kicker.textContent = total
        ? ("Tour · " + (stepIdx + 1) + " of " + total)
        : "Tour";
    }
    // light markdown bold for caption
    body.innerHTML = formatMsg(text).replace(/<\/?p[^>]*>/g, " ").replace(/<div class="ea-sp"><\/div>/g, " ");
  }

  /** Tour lockstep: wait until this line finishes before the next highlight. */
  function speakAndWait(text) {
    return enqueueSpeak(text, { source: "tour", force: true });
  }

  /** User-visible tab names — must match the top tabbar labels exactly. */
  var TAB_LABELS = {
    "#dashboard": "Fleet Triage",
    "#arrays": "Inverters",
    "#analysis": "Analysis",
    "#reports": "Invoices",
    "#resources": "Resources",
    "#account": "Account",
  };
  function tabLabel(hash) {
    var h = String(hash || "").toLowerCase();
    if (h.charAt(0) !== "#") h = "#" + h;
    return TAB_LABELS[h] || hash;
  }

  function panelSelectorForHash(hash) {
    var map = {
      "#dashboard": "#panelDashboard",
      "#arrays": "#panelArrays",
      "#analysis": "#panelAnalysis",
      "#reports": "#panelReports",
      "#resources": "#panelResources",
      "#account": "#panelAccount",
    };
    var h = String(hash || "").toLowerCase();
    if (h.charAt(0) !== "#") h = "#" + h;
    return map[h] || null;
  }

  async function scrollPanelTop(hash) {
    var panelSel = panelSelectorForHash(hash);
    var panel = panelSel ? document.querySelector(panelSel) : null;
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      try { window.scrollTo(0, 0); } catch (e2) {}
    }
    if (panel) {
      try {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {}
      // Inner scroll containers (acct list)
      var list = panel.querySelector("#acctList, .acct-list, .dash-wrap, #sbWrap");
      if (list) {
        try { list.scrollTop = 0; } catch (e) {}
      }
      try { panel.scrollTop = 0; } catch (e) {}
    }
    // Also pin the tabbar active visual
    try {
      var tab = document.querySelector('#tabbar a[href="' + (hash || "") + '"]');
      if (tab) tab.classList.add("ea-hl");
      setTimeout(function () { if (tab) tab.classList.remove("ea-hl"); }, 2000);
    } catch (e) {}
    await sleep(450);
  }

  /** Show-and-tell: top-to-bottom, one step at a time, voice waits for visuals. */
  async function runTour(args) {
    args = args || {};
    var steps = args.steps || [];
    if (!steps.length && args.tour_id) {
      steps = presetTour(args.tour_id) || [];
    }
    if (!steps.length) return false;
    if (state.touring) return false; // one tour at a time
    state.touring = true;
    state.thinking = true; // block concurrent voice turns mid-tour
    addTool("ui.tour", (args.tour_id || steps.length + " steps"));
    setStatus("Guided tour…", "think");

    // Count narrated steps for caption
    var narrated = steps.filter(function (s) { return s && (s.say || s.selector); });
    var nIdx = 0;

    try {
      for (var i = 0; i < steps.length; i++) {
        if (!state.touring) break; // cancelled
        var s = steps[i] || {};
        var hash = s.hash || (s.navigate && s.navigate.hash);

        if (hash || s.type === "navigate") {
          var h = hash || (s.args && s.args.hash) || "#dashboard";
          if (h.charAt(0) !== "#") h = "#" + h;
          await runCommand({
            type: "navigate",
            args: { hash: h, silent: true },
            id: "tour-nav-" + i,
          });
          // Wait for the panel to mount, then always start at the TOP
          var psel = panelSelectorForHash(h) || "body";
          await waitForSelector(psel + ".active, " + psel, 3500);
          await sleep(350);
          await scrollPanelTop(h);
          if (s.say) {
            setTourCaption(s.say, nIdx, narrated.length);
            nIdx++;
            await speakAndWait(s.say);
          } else {
            setTourCaption("Opened **" + tabLabel(h) + "** — starting at the top.", nIdx, narrated.length);
            nIdx++;
            await speakAndWait("Opened " + tabLabel(h) + ". Starting at the top.");
          }
          continue;
        }

        if (s.selector || s.type === "highlight") {
          var el = await waitForSelector(s.selector, 3000);
          if (el) {
            // Ensure element is visible from a predictable top-down path
            try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
            await sleep(280);
            clearHighlights();
            el.classList.add("ea-hl", "ea-hl-pulse");
          }
          var line = s.say || s.label || "";
          if (line) {
            setTourCaption(line, nIdx, narrated.length);
            nIdx++;
            await speakAndWait(line);
          } else {
            await sleep(s.ms || 2000);
          }
          // Hold highlight a beat after speech, then clear for next
          await sleep(400);
          clearHighlights();
          continue;
        }

        if (s.say) {
          setTourCaption(s.say, nIdx, narrated.length);
          nIdx++;
          await speakAndWait(s.say);
        }
      }
    } finally {
      state.touring = false;
      state.thinking = false;
      clearHighlights();
      setTourCaption(null);
      setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
    }
    return true;
  }

  function presetTour(id) {
    var key = String(id || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    // Ordered TOP → BOTTOM of each page. First step always navigates + scrolls top.
    if (key === "master_account" || key === "account") {
      return [
        {
          hash: "#account",
          say: "Account. I'll walk top to bottom — profile first, then auto-refresh, billing, and files.",
        },
        {
          selector: "#tabAccount, a.tab[href='#account']",
          say: "You're on the **Account** tab in the top bar.",
        },
        {
          selector: ".acct-edit[data-field='company'], .acct-row[data-field='company']",
          say: "**Company** — your business name. Click to edit; it saves as you type.",
        },
        {
          selector: ".acct-edit[data-field='name'], .acct-row[data-field='name']",
          say: "**Operator name** — the person running this account.",
        },
        {
          selector: ".acct-edit[data-field='email'], .acct-row[data-field='email']",
          say: "**Email** — the contact address on this account.",
        },
        {
          selector: "#rowAutoRefresh, .ar-stack, .ar-card-head",
          say: "**Auto-refresh** — how production and utility bills stay up to date, cloud or this computer.",
        },
        {
          selector: "#aoPaySetup, .acct-pay-setup, #billManage, #payState, .acct-row.acct-pay-setup",
          say: "**Plan and card** — Array Operator billing for your subscription, not offtaker invoices.",
        },
        {
          selector: ".acct-files-row, #acctFilesBody, #acctFilesCount",
          say: "**Your files** — templates, workbooks, and captured utility PDFs.",
        },
        {
          say: "That's Account, top to bottom. Ask about any section, or say Improve to change the UI.",
        },
      ];
    }
    if (key === "arrays" || key === "inverters") {
      return [
        { hash: "#arrays", say: "Inverters tab — your live fleet canvas. Starting at the top." },
        { selector: "#tabArrays, a.tab[href='#arrays']", say: "This is the **Inverters** tab." },
        { selector: "#panelArrays .vs-seg, #panelArrays .sb-head, #sbWrap", say: "Controls and the canvas live here — each column is a site, prongs are inverters." },
        { say: "Name a site if you want a closer look." },
      ];
    }
    if (key === "reports" || key === "invoices") {
      return [
        { hash: "#reports", say: "Invoices tab — offtaker billing. Starting at the top." },
        { selector: "#tabReports, a.tab[href='#reports']", say: "This is **Invoices** in the top bar." },
        { selector: "#panelReports, .rb-wrap, #rbRoot", say: "Offtakers, drafts, and the send pipeline are here." },
      ];
    }
    if (key === "analysis" || key === "trends") {
      return [
        { hash: "#analysis", say: "Analysis tab — deeper digs. Trends live here as a sub-view, not their own top tab." },
        { selector: "#tabAnalysis, a.tab[href='#analysis']", say: "This is **Analysis**." },
        { selector: "#panelAnalysis .vs-seg, #panelAnalysis", say: "Use the segmented control for Through time and other views." },
      ];
    }
    if (key === "dashboard" || key === "fleet_triage" || key === "triage") {
      return [
        { hash: "#dashboard", say: "Fleet Triage — who needs attention across the fleet. Starting at the top." },
        { selector: "#tabDashboard, a.tab[href='#dashboard']", say: "This is **Fleet Triage**." },
        { selector: "#panelDashboard, .dash-wrap", say: "Overview and attention flags live on this page." },
      ];
    }
    return null;
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
      var lbl = b.querySelector(".ea-chip-lbl");
      if (lbl) lbl.textContent = state.listening ? "Live" : "Mic";
      else b.textContent = state.listening ? "Live" : "Mic";
      b.title = state.listening ? "Microphone on — click to mute" : "Toggle microphone";
    }
  }

  function syncMuteBtn() {
    var b = document.getElementById("eaMute");
    if (!b) return;
    var muted = !!state.voiceMuted;
    b.classList.toggle("on", muted);
    b.setAttribute("aria-pressed", muted ? "true" : "false");
    var ic = b.querySelector(".ea-chip-ic");
    var lbl = b.querySelector(".ea-chip-lbl");
    if (ic) ic.textContent = muted ? "🔇" : "🔊";
    if (lbl) lbl.textContent = muted ? "Muted" : "Mute";
    b.title = muted
      ? "Text only — GPT voice fully off (no credit burn). Click to turn voice back on."
      : "Turn off GPT voice — text chat only, saves credits";
  }

  /** Soft-mute Realtime <audio> element without tearing down the WebRTC pipe. */
  function applyVoiceMuteToAudio() {
    if (state.audioEl) {
      try {
        state.audioEl.muted = !!state.voiceMuted;
        state.audioEl.volume = state.voiceMuted ? 0 : 1;
      } catch (e) {}
    }
  }

  /**
   * Mute = TEXT ONLY. Tear down GPT Realtime entirely so we don't burn OpenAI
   * credits on a silent voice pipe (mic VAD / transcription / session).
   * Unmute reconnects voice if the panel is open.
   */
  function setVoiceMuted(muted) {
    state.voiceMuted = !!muted;
    try { localStorage.setItem("ea_voice_muted", state.voiceMuted ? "1" : "0"); } catch (e) {}
    if (state.voiceMuted) {
      // Full teardown of Realtime + browser TTS — not soft mute on the <audio> tag
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
      try { cancelRealtimeIfActive(); } catch (e) {}
      state.speaking = false;
      state.rtResponseActive = false;
      state._speakSeq++;
      if (typeof state._onSpeakDone === "function") {
        try { state._onSpeakDone(); } catch (e) {}
      }
      // Drop WebRTC / Realtime session completely (credits stop here)
      try { stopVoice(false); } catch (e) {}
      state.realtimeReady = false;
      if (state.open && !state.touring) {
        setStatus("Text only — voice off", "on");
      }
    } else {
      applyVoiceMuteToAudio();
      if (state.open && signedIn() && !state.touring) {
        setStatus("Connecting voice…", "think");
        // Fire-and-forget reconnect
        startVoice(true).then(function () {
          if (!state.voiceMuted && state.open) {
            setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
          }
        }).catch(function () {
          if (!state.voiceMuted && state.open) setStatus("Ready", "on");
        });
      } else if (state.open && !state.touring) {
        setStatus("Ready", "on");
      }
    }
    syncMuteBtn();
    syncMicBtn();
  }

  function isVoiceMuted() { return !!state.voiceMuted; }

  /**
   * Mute/unmute mic tracks WITHOUT tearing down WebRTC.
   * Killing the data channel was forcing TTS into robotic browser speechSynthesis.
   */
  function setMicListening(on) {
    if (state.micStream) {
      try {
        state.micStream.getTracks().forEach(function (t) { t.enabled = !!on; });
      } catch (e) {}
    }
    state.listening = !!on;
    // User explicitly muted — cancel any hold-for-speak so we don't re-open
    if (!on) state._micHeldForSpeak = false;
    if (state._unmuteAfterSpeakTimer) {
      try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
      state._unmuteAfterSpeakTimer = null;
    }
    if (state.voiceMode === "webspeech") {
      if (!on && state.recog) {
        try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
        state.recog = null;
      }
    }
    // Clear any residual input buffer on mute so VAD doesn't fire ghosts
    if (!on && state.dc && state.dc.readyState === "open") {
      try {
        state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      } catch (e) {}
    }
    syncMicBtn();
  }

  /**
   * Guarded barge-in (GPT Live style):
   * - Brief mic mute at TTS attack (~450ms) so the first syllable doesn't self-trigger.
   * - Then re-open the mic so the user can interrupt with real speech.
   * - Transcripts still pass echo / garbage / length filters (see acceptUserTranscript).
   * Does NOT flip state.listening — user still shows as Live.
   */
  function holdMicWhileSpeaking(hold) {
    if (state._unmuteAfterSpeakTimer) {
      try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
      state._unmuteAfterSpeakTimer = null;
    }
    if (hold) {
      if (!state.listening || !state.micStream) {
        state._speakStartedAt = Date.now();
        return;
      }
      state._speakStartedAt = Date.now();
      state._micHeldForSpeak = true;
      // Attack mute only — clear residual buffer, then reopen for barge-in
      try {
        state.micStream.getTracks().forEach(function (t) { t.enabled = false; });
      } catch (e) {}
      if (state.dc && state.dc.readyState === "open") {
        try {
          state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        } catch (e) {}
      }
      state._unmuteAfterSpeakTimer = setTimeout(function () {
        state._unmuteAfterSpeakTimer = null;
        state._micHeldForSpeak = false;
        if (!state.listening || !state.micStream) return;
        try {
          state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
        } catch (e) {}
        // Clear again so attack-bleed buffered while muted doesn't fire a ghost turn
        if (state.dc && state.dc.readyState === "open") {
          try {
            state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
          } catch (e) {}
        }
      }, 450);
      return;
    }
    // Speech finished — ensure mic is open after a short settle (room reverb)
    state._micHeldForSpeak = false;
    state._unmuteAfterSpeakTimer = setTimeout(function () {
      state._unmuteAfterSpeakTimer = null;
      if (!state.listening || !state.micStream) return;
      try {
        state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
      } catch (e) {}
      if (state.dc && state.dc.readyState === "open") {
        try {
          state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        } catch (e) {}
      }
    }, 280);
  }

  /** True while agent audio is playing (informational — does not alone block barge-in). */
  function isAgentMouthBusy() {
    return !!(state.speaking || state.rtResponseActive);
  }

  /**
   * Whether a user transcript should start a turn (incl. mid-agent-speech barge-in).
   * Harder bar while the agent is talking so speaker bleed / room noise don't cut it off.
   */
  function acceptUserTranscript(said) {
    if (!said || !state.listening) return false;
    if (state.thinking || state.touring) return false;
    if (looksLikeEchoOfLastSpeech(said)) return false;
    if (isGarbageTranscript(said)) return false;
    var now = Date.now();
    if (
      state._lastUserSaid &&
      said.toLowerCase() === state._lastUserSaid &&
      now - (state._lastUserSaidAt || 0) < 1200
    ) {
      return false;
    }
    // Mid-speech barge-in: require grace period + a bit more substance than idle turns
    if (isAgentMouthBusy() || state._micHeldForSpeak) {
      // Still in attack mute window — ignore
      if (state._micHeldForSpeak) return false;
      var started = state._speakStartedAt || 0;
      if (started && now - started < 500) return false;
      var words = said.trim().split(/\s+/).filter(Boolean);
      var ack = /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|stop|wait|cancel|go|please|hey)$/i.test(
        said.trim().replace(/[.!?]+$/, "")
      );
      // Need a real interrupt phrase — single short noise words won't cut speech
      if (!ack && words.length < 2 && said.trim().length < 10) return false;
    }
    return true;
  }

  /** Drop echo transcripts that closely match what we just spoke. */
  function looksLikeEchoOfLastSpeech(said) {
    var a = String(said || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    var b = String(state._lastSpokenPlain || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 12 && (b.indexOf(a) !== -1 || a.indexOf(b) !== -1)) return true;
    // Overlap on first ~6 words
    var aw = a.split(" ").slice(0, 8).join(" ");
    var bw = b.split(" ").slice(0, 8).join(" ");
    if (aw.length >= 10 && (bw.indexOf(aw) !== -1 || aw.indexOf(bw) !== -1)) return true;
    return false;
  }

  /**
   * Drop ghost VAD turns: empty-ish, filler-only, or noise that transcription
   * turns into a single throwaway word. Still allows short real acks (yes/no/ok).
   */
  function isGarbageTranscript(said) {
    var clean = String(said || "")
      .replace(/[^\w\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!clean) return true;
    var words = clean.split(" ").filter(Boolean);
    if (!words.length) return true;
    // Explicit short confirmations / greetings — keep
    var ack =
      /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|go|please|thanks|thank you|hi|hello|hey|ready|stop|cancel|wait|help)$/;
    var joined = words.join(" ");
    if (
      ack.test(joined) ||
      /^(go ahead|do it|yes please|no thanks|never mind|nevermind)$/.test(joined)
    ) {
      return false;
    }
    // Filler / breathing noise
    if (words.every(function (w) {
      return /^(um+|uh+|ah+|er+|hm+|hmm+|mm+|m+|huh|eh+)$/.test(w);
    })) {
      return true;
    }
    // One tiny token that isn't an ack (clicks often become "a", "i", "the")
    if (words.length === 1 && words[0].length <= 2) return true;
    // Single very short mystery word from room noise (allow ≥4 chars — real words)
    if (words.length === 1 && words[0].length < 3) return true;
    return false;
  }

  /** Shared VAD knobs — keep in sync with api/energy_agent._realtime_session_config */
  function realtimeVadConfig() {
    return {
      type: "server_vad",
      // Higher = less sensitive (default 0.5 is jumpy with fans/keys/speakers)
      threshold: 0.78,
      prefix_padding_ms: 280,
      // Wait longer before declaring end-of-speech
      silence_duration_ms: 900,
      create_response: false,
      interrupt_response: false,
    };
  }

  function stopVoice(keepMic) {
    state.listening = false;
    state.speaking = false;
    state.rtResponseActive = false;
    // Abort any waiting speak queue callbacks
    var cb = state._onSpeakDone;
    state._onSpeakDone = null;
    state._speakSeq++;
    if (typeof cb === "function") {
      try { cb(); } catch (e) {}
    }
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
        try { state.micStream.getTracks().forEach(function (t) { t.enabled = false; }); } catch (e) {}
      } else {
        try { state.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        state.micStream = null;
      }
    }
    if (state.audioEl) {
      try { state.audioEl.pause(); state.audioEl.srcObject = null; } catch (e) {}
    }
    if (state.recog) {
      try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
      state.recog = null;
    }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.voiceMode = "none";
    syncMicBtn();
  }

  function stopSpeak(opts) {
    opts = opts || {};
    // Barge-in / new turn: cancel current audio only
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    state.speaking = false;
    state.rtResponseActive = false;
    state._speakStartedAt = 0;
    // Release any attack-mute so mic is live for the next user turn
    if (state._unmuteAfterSpeakTimer) {
      try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
      state._unmuteAfterSpeakTimer = null;
    }
    state._micHeldForSpeak = false;
    if (state.listening && state.micStream) {
      try {
        state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
      } catch (e) {}
    }
    cancelRealtimeIfActive();
    var cb = state._onSpeakDone;
    state._onSpeakDone = null;
    // Bump seq so any in-flight enqueueSpeak step is abandoned
    if (opts.reason === "new_turn" || opts.reason === "barge_in") {
      state._speakSeq++;
    }
    if (typeof cb === "function") {
      try { cb(); } catch (e) {}
    }
  }

  function realtimeMouthOpen() {
    return !!(state.dc && state.dc.readyState === "open");
  }

  /**
   * Split long replies into speakable chunks (sentence-aware).
   * Realtime response.create is happier with shorter payloads; the queue plays
   * them back-to-back so explanations can run as long as needed.
   */
  function chunkForSpeech(plain, maxChars) {
    maxChars = maxChars || 900;
    var text = String(plain || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    if (text.length <= maxChars) return [text];
    // Sentence-ish split without lookbehind (older browsers)
    var parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
    var chunks = [];
    var buf = "";
    function flush() {
      var t = buf.trim();
      if (t) chunks.push(t);
      buf = "";
    }
    for (var i = 0; i < parts.length; i++) {
      var p = (parts[i] || "").trim();
      if (!p) continue;
      // Hard-split an oversized sentence on spaces
      if (p.length > maxChars) {
        flush();
        var rest = p;
        while (rest.length > maxChars) {
          var cut = rest.lastIndexOf(" ", maxChars);
          if (cut < maxChars * 0.4) cut = maxChars;
          chunks.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) buf = rest;
        continue;
      }
      if (buf && (buf.length + 1 + p.length) > maxChars) {
        flush();
      }
      buf = buf ? buf + " " + p : p;
    }
    flush();
    return chunks.length ? chunks : [text.slice(0, maxChars)];
  }

  /**
   * Serialize all TTS so we never stack multiple response.create calls.
   * Prefer GPT Realtime mouth; only use robotic browser TTS if we never had Realtime
   * (webspeech fallback mode). If Realtime was used but is briefly down, stay silent
   * rather than switching voices mid-session.
   * Long explanations are chunked and spoken sequentially — no hard 20s cutoff.
   */
  function enqueueSpeak(text, opts) {
    opts = opts || {};
    var plain = stripMd(text);
    if (!plain) return Promise.resolve();
    // Speaker mute: text already on screen; resolve immediately so tours don't stall.
    if (state.voiceMuted && !opts.force) {
      return Promise.resolve();
    }
    // Dedupe identical consecutive lines (double chat + tour wrap-up)
    if (plain === state._lastSpokenPlain && !opts.force) {
      return Promise.resolve();
    }
    state._lastSpokenPlain = plain;
    _lastSpoken = plain;

    var chunks = chunkForSpeech(plain, 900);
    var seq = ++state._speakSeq;
    chunks.forEach(function (chunk, i) {
      var isLast = i === chunks.length - 1;
      state._speakQueue = state._speakQueue
        .catch(function () {})
        .then(function () {
          if (seq !== state._speakSeq) return; // superseded by newer speech/barge-in
          if (state.voiceMuted && !opts.force) return;
          return speakNow(chunk, {
            source: opts.source,
            force: true, // chunks must not dedupe against each other
            // Keep mic held across multi-chunk explanations
            keepMicHeld: !isLast,
          });
        });
    });
    return state._speakQueue;
  }

  function speakNow(plain, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        state._onSpeakDone = null;
        state.speaking = false;
        state.rtResponseActive = false;
        // Only settle mic after the LAST chunk of a long explanation
        if (!opts.keepMicHeld) {
          holdMicWhileSpeaking(false);
          if (state.listening && !state.touring) {
            setStatus(state.voiceMuted ? "Listening (voice muted)" : "Listening…", "listen");
          }
        } else {
          // Next chunk will re-arm attack mute; keep status as speaking
          setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
        }
        resolve();
      }
      // Speaker mute — never start audio
      if (state.voiceMuted && !opts.force) {
        done();
        return;
      }
      state._onSpeakDone = done;

      var words = plain.split(/\s+/).filter(Boolean).length;
      // Scale with content. Old hard cap of 20s cut long explanations mid-sentence
      // (timer released the mic → ghost barge-in cancelled the Realtime response).
      // ~450ms/word + headroom; floor 6s, ceiling 4 min per chunk. While audio is
      // still playing we re-arm instead of force-ending.
      var fallbackMs = Math.min(240000, Math.max(6000, Math.round(words * 450) + 4000));
      var timer = null;
      var totalArmed = 0;
      function armFallback(ms) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          totalArmed += ms;
          // Still playing — keep waiting (cap total hang recovery ~6 min per chunk)
          if ((state.speaking || state.rtResponseActive) && totalArmed < 360000) {
            armFallback(Math.min(90000, ms));
            return;
          }
          done();
        }, ms);
      }
      armFallback(fallbackMs);

      var prevDone = done;
      state._onSpeakDone = function () {
        if (timer) clearTimeout(timer);
        timer = null;
        prevDone();
      };

      // Attack mute briefly, then reopen mic for barge-in (see holdMicWhileSpeaking)
      holdMicWhileSpeaking(true);

      // ── GPT Realtime mouth ────────────────────────────────────────────
      if (realtimeMouthOpen()) {
        try {
          // Wait for prior response to finish instead of cancel-storm,
          // unless barge-in already cleared rtResponseActive.
          if (state.rtResponseActive) {
            cancelRealtimeIfActive();
          }
          state.rtResponseActive = true;
          state.speaking = true;
          state._speakStartedAt = Date.now();
          // Full chunk text (chunks are already ≤ ~900 chars) — no 1200 hard truncate
          state.dc.send(JSON.stringify({
            type: "response.create",
            response: {
              instructions:
                "Speak the following to the user naturally, in English, no extra commentary. " +
                "Do not add greeting or questions beyond the text. " +
                "Speak the entire passage completely — do not stop early:\n\n" +
                plain,
            },
          }));
          setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
          return;
        } catch (e) {
          state.rtResponseActive = false;
        }
      }

      // ── Never switch to robotic voice if this session used GPT voice ──
      if (state.voiceMode === "realtime" || state.realtimeReady) {
        // Mouth offline — text is already on screen; skip browser TTS
        setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
        done();
        return;
      }

      // ── Browser TTS only in webspeech fallback mode ───────────────────
      if (!window.speechSynthesis) {
        done();
        return;
      }
      try { window.speechSynthesis.cancel(); } catch (e) {}
      // Chunks are short enough; speak full chunk (no 800-char cut)
      var u = new SpeechSynthesisUtterance(plain);
      u.rate = 1.02;
      u.onstart = function () {
        state.speaking = true;
        holdMicWhileSpeaking(true);
        setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
      };
      u.onend = function () { done(); };
      u.onerror = function () { done(); };
      window.speechSynthesis.speak(u);
    });
  }

  /** @deprecated path — route through enqueueSpeak so the queue stays single-threaded */
  function speak(text, opts) {
    opts = opts || {};
    var plain = opts.awaitable ? stripMd(text) : stripMd(text);
    if (!plain) return;
    // Legacy direct callers: still go through the queue
    enqueueSpeak(plain, opts);
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
    // Model audio lifecycle
    if (ev.type === "output_audio_buffer.started") {
      state.speaking = true;
      state.rtResponseActive = true;
      // Mark speak start once; attack mute already armed in speakNow — don't re-mute forever
      if (!state._speakStartedAt) state._speakStartedAt = Date.now();
      setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
    }
    if (ev.type === "response.output_audio.delta") {
      state.speaking = true;
      state.rtResponseActive = true;
    }
    // Prefer audio-buffer stopped (playback drained) — this is when the ear hears silence
    if (ev.type === "output_audio_buffer.stopped") {
      state.speaking = false;
      state.rtResponseActive = false;
      if (typeof state._onSpeakDone === "function") {
        try { state._onSpeakDone(); } catch (e) {}
      } else {
        holdMicWhileSpeaking(false);
        if (state.listening && !state.touring) {
          setStatus("Listening…", "listen");
        }
      }
    }
    if (ev.type === "response.cancelled" || ev.type === "response.failed") {
      state.speaking = false;
      state.rtResponseActive = false;
      if (typeof state._onSpeakDone === "function") {
        try { state._onSpeakDone(); } catch (e) {}
      } else {
        holdMicWhileSpeaking(false);
      }
    }
    if (ev.type === "response.done") {
      // Text/tool complete — audio may still be draining. Don't clear the speak
      // waiter here if we're still marked speaking (buffer stopped will finish it).
      if (!state.speaking) {
        state.rtResponseActive = false;
        if (typeof state._onSpeakDone === "function") {
          try { state._onSpeakDone(); } catch (e) {}
        } else if (state.listening && !state.touring) {
          setStatus("Listening…", "listen");
        }
      } else {
        // Safety drain if buffer-stopped never arrives
        setTimeout(function () {
          if (typeof state._onSpeakDone === "function") {
            state.speaking = false;
            state.rtResponseActive = false;
            try { state._onSpeakDone(); } catch (e) {}
          }
        }, 1200);
      }
    }
    // User finished speaking — ONE path: show once, then agent turn (tools + speak).
    // Guarded barge-in: while agent talks, accept real interrupts (not noise/echo).
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      var said = (ev.transcript || "").trim();
      if (!acceptUserTranscript(said)) return;
      var nowTs = Date.now();
      state._lastUserSaid = said.toLowerCase();
      state._lastUserSaidAt = nowTs;
      var wasSpeaking = isAgentMouthBusy();
      // Barge-in or idle: stop agent mouth, drop remaining speak queue chunks
      stopSpeak({ reason: "barge_in" });
      if (state.dc && state.dc.readyState === "open") {
        try {
          state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        } catch (e) {}
      }
      if (wasSpeaking) {
        setStatus("Listening…", "listen");
      }
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
    if (state.voiceMuted) {
      throw new Error("voice_muted");
    }
    // Already connected — just re-enable the mic (don't renegotiate / double-greet)
    if (realtimeMouthOpen() && state.pc) {
      try { state.micStream && state.micStream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}
      state.listening = true;
      state.voiceMode = "realtime";
      syncMicBtn();
      setStatus("Listening…", "listen");
      return;
    }

    setStatus("Connecting GPT voice…", "think");
    var stream = await ensureMicStream();
    try { stream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}

    // Tear down prior peer connection but KEEP the mic stream (permission)
    // Use internal teardown without wiping voiceMode preference
    try { if (state.dc) state.dc.close(); } catch (e) {}
    state.dc = null;
    try { if (state.pc) state.pc.close(); } catch (e) {}
    state.pc = null;
    if (state.recog) {
      try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
      state.recog = null;
    }

    stream = await ensureMicStream();
    try { stream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}

    var pc = new RTCPeerConnection();
    state.pc = pc;

    // Play model audio
    if (!state.audioEl) {
      state.audioEl = document.createElement("audio");
      state.audioEl.autoplay = true;
      state.audioEl.setAttribute("playsinline", "true");
      state.audioEl.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(state.audioEl);
      applyVoiceMuteToAudio();
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
      // VAD: less sensitive than OpenAI defaults so room noise / keys don't start turns.
      dcSend({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are Energy Agent's voice. Only speak lines the app asks you to say via response.create. " +
            "Do not invent your own answers to the user; the app handles reasoning and tools. " +
            "Never speak over yourself; one utterance at a time.",
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
              noise_reduction: { type: "near_field" },
              turn_detection: realtimeVadConfig(),
            },
          },
        },
      });
      // Single greeting per panel open — text intro already exists from ensureSession
      if (!state.greeted && !state.voiceMuted) {
        state.greeted = true;
        enqueueSpeak(
          "Hi — Energy Agent here. I'm listening whenever you're ready.",
          { source: "greeting", force: true }
        );
      }
      if (state.voiceMuted) {
        // Shouldn't happen (startRealtimeVoice guards) — leave text-only
        setStatus("Text only — voice off", "on");
      } else {
        setStatus("Listening…", "listen");
      }
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
    state.realtimeReady = true;
    syncMicBtn();
    setStatus("Listening…", "listen");
    // No chat bubble for voice-connect — status pill already shows Listening…
  }

  /** Fallback when OpenAI key missing or WebRTC fails: Web Speech + browser TTS */
  function startWebSpeechFallback(fromOpen) {
    if (state.voiceMuted) {
      setStatus("Text only — voice off", "on");
      return;
    }
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
    // Muted = text only — never open Realtime / burn voice credits
    if (state.voiceMuted) {
      setStatus("Text only — voice off", "on");
      syncMicBtn();
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
      if (state.voiceMuted || /voice_muted/i.test(msg)) {
        setStatus("Text only — voice off", "on");
        return;
      }
      if (/not configured|OPENAI_API_KEY|503/i.test(msg)) {
        addMsg("agent", "GPT voice isn’t configured yet (need OPENAI_API_KEY on Railway). Falling back to browser speech.");
      } else {
        addMsg("agent", "GPT voice connect failed: " + msg.slice(0, 180) + " — using browser fallback.");
      }
      if (state.voiceMuted) return;
      startWebSpeechFallback(fromOpen);
    }
  }

  function toggleMic() {
    if (state.voiceMuted) {
      // Voice fully off — Live mic would only burn credits with nowhere to send audio
      setStatus("Unmute first for voice · text still works", "on");
      return;
    }
    if (state.listening) {
      // Mute only — keep WebRTC data channel so GPT voice still speaks replies.
      // (Old path called stopVoice and fell back to robotic browser TTS.)
      setMicListening(false);
      setStatus("Mic muted · GPT voice still on for replies", "on");
    } else {
      // Click path — safe for permission prompt / reconnect
      if (realtimeMouthOpen()) {
        setMicListening(true);
        setStatus("Listening…", "listen");
      } else {
        requestMicFromClick();
      }
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
    // Seamless merge: hide residual floating "Wish this was better" chrome —
    // Improve lives entirely inside Energy Agent now.
    try {
      document.documentElement.classList.add("ea-merged");
      var wrap = document.getElementById("fsWrap");
      if (wrap && signedIn()) wrap.style.display = "none";
    } catch (e) {}
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
