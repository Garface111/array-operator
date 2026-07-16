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

  /** Relative time for chat timestamps — accurate intervals, not always "just now" */
  function relativeTime(isoStr) {
    if (!isoStr) return "";
    try {
      var then = new Date(isoStr).getTime();
      var now = Date.now();
      var diff = Math.floor((now - then) / 1000); // seconds
      
      if (diff < 10) return "just now";
      if (diff < 60) return diff + "s ago";
      
      var mins = Math.floor(diff / 60);
      if (mins < 60) return mins + "m ago";
      
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h ago";
      
      var days = Math.floor(hrs / 24);
      if (days < 7) return days + "d ago";
      
      var weeks = Math.floor(days / 7);
      if (weeks < 4) return weeks + "w ago";
      
      // For older messages, show actual date
      var d = new Date(then);
      var mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      return mon + " " + d.getDate();
    } catch (e) {
      return "";
    }
  }

  /** Update all visible timestamps (called on render + every 30s to keep them fresh) */
  function refreshTimestamps() {
    var els = document.querySelectorAll(".sd-msg-time");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var iso = el.getAttribute("data-ts");
      if (iso) el.textContent = relativeTime(iso);
    }
  }

  /** Markdown → HTML (basic: **bold**, *em*, `code`, links, fenced blocks) */
  function md(text) {
    var h = esc(stripSideJson(text));
    // fenced code blocks
    h = h.replace(
      /```([\s\S]*?)```/g,
      '<pre class="sd-code"><code>$1</code></pre>'
    );
    // inline code
    h = h.replace(/`([^`]+)`/g, '<code class="sd-inline-code">$1</code>');
    // bold
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // italic
    h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // links
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="sd-link">$1</a>'
    );
    // line breaks
    h = h.replace(/\n/g, "<br>");
    return h;
  }

  function renderMessages() {
    var cont = document.getElementById("sdMsgs");
    if (!cont) return;
    var html = "";
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      var role = m.role || "user";
      var cls = role === "user" ? "sd-msg-user" : "sd-msg-sov";
      var label = role === "user" ? state.email || "You" : "Sovereign";
      var ts = m.created_at ? '<span class="sd-msg-time" data-ts="' + esc(m.created_at) + '">' + relativeTime(m.created_at) + '</span>' : "";
      html +=
        '<div class="sd-msg ' +
        cls +
        '"><div class="sd-msg-head"><strong>' +
        esc(label) +
        "</strong>" +
        ts +
        '</div><div class="sd-msg-body">' +
        md(m.content) +
        "</div></div>";
    }
    cont.innerHTML = html;
    cont.scrollTop = cont.scrollHeight;
  }

  function addMessage(role, content, createdAt) {
    state.messages.push({ role: role, content: content, created_at: createdAt || new Date().toISOString() });
    renderMessages();
  }

  function checkAccess() {
    if (!hasSession()) {
      state.allowed = false;
      return Promise.resolve(false);
    }
    return fetch(API.access, { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.allowed = !!d.desk;
        state.email = d.email || null;
        return state.allowed;
      })
      .catch(function () {
        state.allowed = false;
        return false;
      });
  }

  function loadHistory() {
    return fetch(API.history, { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.messages = d.messages || [];
        renderMessages();
      })
      .catch(function (err) {
        console.error("[Desk] history load fail:", err);
      });
  }

  function sendMessage(text) {
    if (!text.trim()) return;
    var crid = newClientRequestId();
    state.activeCrid = crid;
    state.userCancelled = false;
    addMessage("user", text);
    saveDraft("");
    document.getElementById("sdInput").value = "";
    state.sending = true;
    updateUI();

    var body = { client_request_id: crid, message: text };
    if (state.attachments.length > 0) {
      body.attachments = state.attachments.map(function (a) {
        return { upload_id: a.id, filename: a.filename };
      });
      state.attachments = [];
      renderAttachments();
    }

    savePendingTurn({ crid: crid, userMessage: text });

    state.fetchCtrl = new AbortController();
    fetch(API.chat, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: state.fetchCtrl.signal,
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.activeFordId = d.ford_id || null;
        return pollTurn(crid);
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        console.error("[Desk] send fail:", err);
        addMessage(
          "system",
          "**Error**: Failed to send message. " + String(err.message || err)
        );
      })
      .finally(function () {
        if (state.activeCrid === crid) {
          state.sending = false;
          state.activeCrid = null;
          state.activeFordId = null;
          state.fetchCtrl = null;
          savePendingTurn(null);
          updateUI();
        }
      });
  }

  function pollTurn(crid) {
    var maxAttempts = 120;
    var attempt = 0;
    function poll() {
      if (state.userCancelled) return Promise.resolve();
      if (attempt++ > maxAttempts) {
        addMessage("system", "**Timeout**: Sovereign did not respond in time.");
        return Promise.resolve();
      }
      return fetch(
        API.turn +
          "?client_request_id=" +
          encodeURIComponent(crid) +
          "&t=" +
          Date.now(),
        { headers: authHeaders() }
      )
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        })
        .then(function (d) {
          if (d.status === "complete") {
            addMessage("assistant", d.response, d.completed_at);
            return Promise.resolve();
          }
          return sleep(1000).then(poll);
        })
        .catch(function (err) {
          console.error("[Desk] poll fail:", err);
          return sleep(2000).then(poll);
        });
    }
    return poll();
  }

  function cancelTurn() {
    if (!state.activeCrid) return;
    state.userCancelled = true;
    if (state.fetchCtrl) state.fetchCtrl.abort();
    fetch(API.cancel, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        client_request_id: state.activeCrid,
        ford_id: state.activeFordId,
      }),
    }).catch(function (err) {
      console.error("[Desk] cancel fail:", err);
    });
    state.sending = false;
    state.activeCrid = null;
    state.activeFordId = null;
    state.fetchCtrl = null;
    savePendingTurn(null);
    addMessage("system", "**Cancelled** by you.");
    updateUI();
  }

  function resumePending() {
    var p = loadPendingTurn();
    if (!p || !p.crid) return;
    state.activeCrid = p.crid;
    state.sending = true;
    updateUI();
    pollTurn(p.crid).finally(function () {
      state.sending = false;
      state.activeCrid = null;
      savePendingTurn(null);
      updateUI();
    });
  }

  function updateUI() {
    var sendBtn = document.getElementById("sdSend");
    var cancelBtn = document.getElementById("sdCancel");
    var input = document.getElementById("sdInput");
    if (sendBtn) sendBtn.disabled = state.sending;
    if (cancelBtn) cancelBtn.style.display = state.sending ? "inline-block" : "none";
    if (input) input.disabled = state.sending;
  }

  function renderAttachments() {
    var cont = document.getElementById("sdAttachList");
    if (!cont) return;
    if (state.attachments.length === 0) {
      cont.innerHTML = "";
      return;
    }
    var html = "";
    for (var i = 0; i < state.attachments.length; i++) {
      var a = state.attachments[i];
      html +=
        '<div class="sd-attach-item"><span>' +
        esc(a.filename) +
        '</span><button class="sd-attach-rm" data-idx="' +
        i +
        '">×</button></div>';
    }
    cont.innerHTML = html;
  }

  function attachFile(file) {
    var formData = new FormData();
    formData.append("file", file);
    fetch(API.upload, { method: "POST", headers: authHeaders(), body: formData })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.attachments.push({
          id: d.upload_id,
          filename: file.name,
          mime: file.type,
          size: file.size,
        });
        renderAttachments();
      })
      .catch(function (err) {
        console.error("[Desk] upload fail:", err);
        alert("Upload failed: " + String(err.message || err));
      });
  }

  function initVoice() {
    if (!window.webkitSpeechRecognition && !window.SpeechRecognition) return;
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SpeechRecognition();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.onresult = function (event) {
      var interim = "";
      var final = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript + " ";
        else interim += transcript;
      }
      var input = document.getElementById("sdInput");
      if (input) {
        if (final) state.baseText += final;
        input.value = state.baseText + interim;
      }
    };
    state.recognition.onerror = function (event) {
      console.error("[Desk] voice error:", event.error);
      stopVoice();
    };
    state.recognition.onend = function () {
      if (state.listening) {
        try {
          state.recognition.start();
        } catch (e) {
          stopVoice();
        }
      }
    };
  }

  function startVoice() {
    if (!state.recognition) return;
    var input = document.getElementById("sdInput");
    state.baseText = input ? input.value : "";
    state.listening = true;
    try {
      state.recognition.start();
    } catch (e) {
      console.error("[Desk] voice start fail:", e);
      state.listening = false;
    }
    var btn = document.getElementById("sdVoice");
    if (btn) btn.textContent = "🎤 Stop";
  }

  function stopVoice() {
    if (!state.recognition) return;
    state.listening = false;
    try {
      state.recognition.stop();
    } catch (e) {}
    var btn = document.getElementById("sdVoice");
    if (btn) btn.textContent = "🎤 Voice";
  }

  function toggleVoice() {
    if (state.listening) stopVoice();
    else startVoice();
  }

  function checkBridge() {
    fetch(API.bridgeStatus, { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.bridgeOnline = !!d.online;
      })
      .catch(function () {
        state.bridgeOnline = false;
      });
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    var root = document.getElementById("sovereignDesk");
    if (!root) return;

    checkAccess().then(function (allowed) {
      if (!allowed) {
        root.innerHTML =
          '<div class="sd-denied"><h2>Access Denied</h2><p>You do not have Sovereign Desk access.</p></div>';
        return;
      }

      root.innerHTML =
        '<div class="sd-wrap">' +
        '<div class="sd-header"><h2>Sovereign Desk</h2></div>' +
        '<div class="sd-msgs" id="sdMsgs"></div>' +
        '<div class="sd-attach-list" id="sdAttachList"></div>' +
        '<div class="sd-input-wrap">' +
        '<textarea id="sdInput" placeholder="Type your message..."></textarea>' +
        '<div class="sd-controls">' +
        '<button id="sdAttach" title="Attach file">📎</button>' +
        '<button id="sdVoice" title="Voice input">🎤 Voice</button>' +
        '<button id="sdCancel" style="display:none">Cancel</button>' +
        '<button id="sdSend">Send</button>' +
        '</div>' +
        '</div>' +
        '</div>';

      var input = document.getElementById("sdInput");
      var sendBtn = document.getElementById("sdSend");
      var cancelBtn = document.getElementById("sdCancel");
      var attachBtn = document.getElementById("sdAttach");
      var voiceBtn = document.getElementById("sdVoice");

      input.value = loadDraft();
      input.addEventListener("input", function () {
        saveDraft(input.value);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage(input.value);
        }
      });

      sendBtn.addEventListener("click", function () {
        sendMessage(input.value);
      });

      cancelBtn.addEventListener("click", cancelTurn);

      attachBtn.addEventListener("click", function () {
        var fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.onchange = function () {
          if (fileInput.files.length > 0) attachFile(fileInput.files[0]);
        };
        fileInput.click();
      });

      if (voiceBtn) voiceBtn.addEventListener("click", toggleVoice);

      document.addEventListener("click", function (e) {
        if (e.target && e.target.classList.contains("sd-attach-rm")) {
          var idx = parseInt(e.target.getAttribute("data-idx"), 10);
          if (!isNaN(idx)) {
            state.attachments.splice(idx, 1);
            renderAttachments();
          }
        }
      });

      initVoice();
      loadHistory().then(function () {
        resumePending();
      });
      checkBridge();
      
      // Refresh timestamps every 30 seconds to keep them current
      setInterval(refreshTimestamps, 30000);
    });
  }

  function onHashChange() {
    if (window.location.hash === "#sovereign") boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onHashChange);
  } else {
    onHashChange();
  }
  window.addEventListener("hashchange", onHashChange);
})();
