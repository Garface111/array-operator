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
      /\n\s*\{[\s\S]*"(?:actions|monologue|ford_ask|mood|succession_gap|memory_writes)"[\s\S]*\}\s*$/,
      ""
    );
    t = t.replace(/\s+$/, "");
    // Whole bubble is pure side-meta JSON → show monologue/ford_ask only
    var trimmed = t.trim();
    if (trimmed.charAt(0) === "{" && /"(?:monologue|actions|mood)"/.test(trimmed)) {
      try {
        var obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object") {
          var mono = String(obj.monologue || "").trim();
          var ask = String(obj.ford_ask || "").trim();
          if (mono && ask && mono.indexOf(ask) < 0)
            return mono + "\n\n**What I need from you:** " + ask;
          if (mono) return mono;
          if (ask) return ask;
          return "Understood.";
        }
      } catch (e) {
        /* keep stripped text */
      }
    }
    return t;
  }

  // ── Safe markdown (same discipline as Energy Agent chat) ────────────────
  function normalizeChatMarkdown(raw) {
    var s = String(raw == null ? "" : raw);
    s = s.replace(/\r\n?/g, "\n");
    s = s.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'");
    s = s.replace(/\n{3,}/g, "\n\n");
    var lines = s.split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].replace(/[ \t]+$/g, "");
      trimmed = trimmed.replace(
        /^(\s*)([-*+]|[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u25CB\u25A0\u25B8\u25B6\u25C6]|[–—])\s+/,
        "$1- "
      );
      trimmed = trimmed.replace(/^(\s*)\((\d{1,3})\)\s+/, "$1$2. ");
      trimmed = trimmed.replace(/^(\s*)(\d{1,3})\s*[-–—]\s+/, "$1$2. ");
      trimmed = trimmed.replace(/^(\s*)Step\s+(\d{1,3})\s*[:.\-–—]\s+/i, "$1$2. ");
      var markers = trimmed.match(/\d{1,3}[.)]\s+/g);
      if (markers && markers.length >= 2 && /(?:^|[\s:;])\d{1,3}[.)]\s+\S/.test(trimmed)) {
        var firstIdx = trimmed.search(/\d{1,3}[.)]\s+/);
        var lead = firstIdx > 0 ? trimmed.slice(0, firstIdx).trim().replace(/[:：]\s*$/, "") : "";
        if (lead) out.push(lead);
        var parts = trimmed.slice(firstIdx).split(/(?=\d{1,3}[.)]\s+)/);
        for (var p = 0; p < parts.length; p++) {
          var part = parts[p].trim().replace(/^(\d{1,3})[.)]\s+/, "$1. ").replace(/[;·|]\s*$/, "").trim();
          if (part) out.push(part);
        }
        continue;
      }
      out.push(trimmed);
    }
    return out.join("\n");
  }

  /**
   * Safe lightweight markdown for chat bubbles.
   * bold, italic, code, fences, headers, lists, quotes, hr, links, tables (simple).
   * Escapes HTML first — model cannot inject tags.
   */
  function formatChatMd(text) {
    var raw = normalizeChatMarkdown(stripSideJson(text));
    if (!raw.trim()) return "";

    var blocks = [];
    raw = raw.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var i = blocks.length;
      blocks.push(
        '<pre class="sov-md-code"' +
          (lang ? ' data-lang="' + esc(lang) + '"' : "") +
          "><code>" +
          esc(code.replace(/^\n+|\n+$/g, "")) +
          "</code></pre>"
      );
      return "\n%%SOV_BLOCK_" + i + "%%\n";
    });

    var inlines = [];
    raw = raw.replace(/`([^`\n]+)`/g, function (_, code) {
      var i = inlines.length;
      inlines.push('<code class="sov-md-icode">' + esc(code) + "</code>");
      return "%%SOV_CODE_" + i + "%%";
    });

    var s = esc(raw);

    s = s.replace(/^######\s+(.+)$/gm, '<div class="sov-md-h sov-md-h6">$1</div>');
    s = s.replace(/^#####\s+(.+)$/gm, '<div class="sov-md-h sov-md-h5">$1</div>');
    s = s.replace(/^####\s+(.+)$/gm, '<div class="sov-md-h sov-md-h4">$1</div>');
    s = s.replace(/^###\s+(.+)$/gm, '<div class="sov-md-h sov-md-h3">$1</div>');
    s = s.replace(/^##\s+(.+)$/gm, '<div class="sov-md-h sov-md-h2">$1</div>');
    s = s.replace(/^#\s+(.+)$/gm, '<div class="sov-md-h sov-md-h1">$1</div>');
    s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="sov-md-hr">');
    s = s.replace(/^&gt;\s?(.+)$/gm, '<div class="sov-md-quote">$1</div>');

    // Tables: | a | b |
    s = s.replace(/(?:^|\n)((?:\|.+\|\n)+)/g, function (block) {
      var rows = block.trim().split("\n").filter(Boolean);
      if (rows.length < 2) return block;
      var isSep = function (row) {
        return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row.trim());
      };
      var parseRow = function (row) {
        return row
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map(function (c) {
            return c.trim();
          });
      };
      var html = '<div class="sov-md-table-wrap"><table class="sov-md-table">';
      var headerDone = false;
      for (var r = 0; r < rows.length; r++) {
        if (isSep(rows[r])) continue;
        var cells = parseRow(rows[r]);
        if (!cells.length) continue;
        if (!headerDone) {
          html += "<thead><tr>";
          cells.forEach(function (c) {
            html += "<th>" + c + "</th>";
          });
          html += "</tr></thead><tbody>";
          headerDone = true;
        } else {
          html += "<tr>";
          cells.forEach(function (c) {
            html += "<td>" + c + "</td>";
          });
          html += "</tr>";
        }
      }
      html += "</tbody></table></div>";
      return "\n" + html + "\n";
    });

    s = s.replace(/\*\*([^*\n][\s\S]*?[^*\n]|\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n][\s\S]*?[^_\n]|\S)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\\])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    // ~~strike~~
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a class="sov-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    s = s.replace(
      /(^|[^"'>=])(https?:\/\/[^\s<]+[^\s<.,);:'"!])/g,
      function (_, pre, url) {
        var shown = url.length > 56 ? url.slice(0, 48) + "…" : url;
        return (
          pre +
          '<a class="sov-md-link" href="' +
          url +
          '" target="_blank" rel="noopener noreferrer" title="' +
          url +
          '">' +
          shown +
          "</a>"
        );
      }
    );

    s = s.replace(/%%SOV_CODE_(\d+)%%/g, function (_, i) {
      return inlines[Number(i)] || "";
    });

    var lines = s.split("\n");
    var out = [];
    var stack = [];
    var openLi = false;

    function openList(type, indent) {
      var depth = stack.length;
      var tag = type === "ol" ? "ol" : "ul";
      var cls = type === "ol" ? "sov-md-ol" : "sov-md-ul";
      out.push(
        "<" + tag + ' class="' + cls + (depth ? " sov-md-nested" : "") + '">'
      );
      stack.push({ type: type, indent: indent });
    }
    function closeLiIfOpen() {
      if (openLi) {
        out.push("</li>");
        openLi = false;
      }
    }
    function closeOneList() {
      if (!stack.length) return;
      closeLiIfOpen();
      var top = stack.pop();
      out.push(top.type === "ol" ? "</ol>" : "</ul>");
      if (stack.length) openLi = true;
    }
    function closeToIndent(indent) {
      while (stack.length && stack[stack.length - 1].indent > indent) closeOneList();
    }
    function closeAllLists() {
      while (stack.length) closeOneList();
      openLi = false;
    }
    function ensureList(type, indent) {
      if (!stack.length) {
        openList(type, indent);
        return;
      }
      var top = stack[stack.length - 1];
      if (indent > top.indent) {
        if (!openLi) {
          closeLiIfOpen();
          if (top.type !== type) {
            closeOneList();
            openList(type, indent);
          }
          return;
        }
        openList(type, indent);
        openLi = false;
        return;
      }
      if (indent < top.indent) {
        closeToIndent(indent);
        top = stack[stack.length - 1];
        if (!top) {
          openList(type, indent);
          return;
        }
        if (top.indent === indent) {
          closeLiIfOpen();
          if (top.type !== type) {
            closeOneList();
            openList(type, indent);
          }
          return;
        }
        openList(type, indent);
        return;
      }
      closeLiIfOpen();
      if (top.type !== type) {
        closeOneList();
        openList(type, indent);
      }
    }

    var liRe = /^(\s*)(?:([-+•])|(\d+)[.)])\s+(.+)$/;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var blockM = line.match(/^%%SOV_BLOCK_(\d+)%%$/);
      if (blockM) {
        closeAllLists();
        out.push(blocks[Number(blockM[1])] || "");
        continue;
      }
      if (
        /^<div class="sov-md-h/.test(line) ||
        /^<div class="sov-md-quote">/.test(line) ||
        /^<hr class="sov-md-hr">/.test(line) ||
        /^<div class="sov-md-table-wrap">/.test(line)
      ) {
        closeAllLists();
        out.push(line);
        continue;
      }
      var m = line.match(liRe);
      if (m) {
        var indent = m[1].replace(/\t/g, "  ").length;
        var type = m[2] ? "ul" : "ol";
        ensureList(type, indent);
        out.push("<li>" + m[4]);
        openLi = true;
        continue;
      }
      if (stack.length && openLi && /^\s+\S/.test(line) && !liRe.test(line)) {
        out.push(" " + line.trim());
        continue;
      }
      closeAllLists();
      if (/^\s*$/.test(line)) out.push('<div class="sov-md-sp"></div>');
      else out.push('<p class="sov-md-p">' + line + "</p>");
    }
    closeAllLists();

    var html = out.join("");
    html = html.replace(/%%SOV_BLOCK_(\d+)%%/g, function (_, idx) {
      return blocks[Number(idx)] || "";
    });
    html = html.replace(/<\/(ul|ol)><div class="sov-md-sp"><\/div><(ul|ol)/g, "</$1><$2");
    return html || "";
  }

  function shouldRich(role, text) {
    if (role !== "ford") return true;
    return /\*\*|__|`|^#\s|^\s*[-*+•]\s|^\s*\d+[.)]\s|\[.+\]\(https?:|https?:\/\//m.test(
      text || ""
    );
  }

  function formatTime(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  /** Hide worker dumps / ops telemetry — chat is conversation, not a log. */
  function isChatWorthy(m) {
    if (!m) return false;
    var role = (m.role || "").toLowerCase();
    var prov = (m.provider || "").toLowerCase();
    var meta = m.meta || {};
    var text = String(m.content || "");
    if (role === "system") return false;
    // Allow provider "email" (Sovereign mailed you — short desk breadcrumb)
    if (prov === "worker" || prov === "rules" || prov === "admin") return false;
    if (meta && (meta.job_id || meta.from === "rules_utility_triage" || meta.legacy)) {
      if (prov === "worker" || /^Sovereign shipped job/i.test(text) || /^Ops /i.test(text))
        return false;
    }
    if (/^Sovereign shipped job\s/i.test(text)) return false;
    if (/^Ship:\s*\{/m.test(text) && /Deploy:\s*\{/m.test(text)) return false;
    if (/^Ops\s+\w+:\s*\{/.test(text)) return false;
    // Ops email dumps that used to spam the desk (code-hire / job telemetry)
    if (
      prov === "email" &&
      (/code-hire/i.test(text) ||
        /job id:/i.test(text) ||
        /utility-add request #/i.test(text) ||
        (/emailed you from/i.test(text) && /job/i.test(text)))
    )
      return false;
    return !!(text || "").trim();
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
      var micOk =
        existing.querySelector("#sovDeskMic") &&
        existing.querySelector("#sovDeskMic svg rect"); // stroke mic (not old filled path)
      var attachOk =
        existing.querySelector("#sovDeskAttach") &&
        existing.querySelector("#sovDeskAttach svg");
      if (
        existing.classList.contains("sov-desk--chat") &&
        existing.classList.contains("sov-desk--rich") &&
        !existing.querySelector(".sov-ops") &&
        micOk &&
        attachOk
      )
        return sec;
      existing.remove();
    }
    sec.innerHTML =
      '<div class="sov-desk sov-desk--chat sov-desk--rich">' +
      '  <header class="sov-desk-head">' +
      '    <div class="sov-desk-brand">' +
      '      <div class="sov-desk-mark" aria-hidden="true"></div>' +
      "      <div>" +
      "        <h1>Sovereign</h1>" +
      '        <p class="sov-desk-sub">Private chat · files · local bridge</p>' +
      "      </div>" +
      "    </div>" +
      '    <div class="sov-desk-head-right">' +
      '      <div class="sov-desk-meta" id="sovDeskMeta">Developer only</div>' +
      '      <span class="sov-bridge-pill" id="sovBridgePill" title="Local computer bridge">bridge…</span>' +
      '      <button type="button" class="sov-desk-refresh" id="sovDeskRefresh" title="Refresh" aria-label="Refresh">↻</button>' +
      "    </div>" +
      "  </header>" +
      '  <div class="sov-desk-main">' +
      '    <div class="sov-desk-body" id="sovDeskMsgs" aria-live="polite"></div>' +
      '    <div class="sov-desk-typing" id="sovDeskTyping" hidden>' +
      '      <span class="sov-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      "      <span>Sovereign is thinking…</span>" +
      "    </div>" +
      '    <div class="sov-attach-row" id="sovAttachRow" hidden></div>' +
      '    <form class="sov-desk-compose" id="sovDeskForm">' +
      '      <input type="file" id="sovDeskFile" multiple hidden ' +
      'accept=".txt,.md,.json,.csv,.py,.js,.ts,.tsx,.html,.css,.yml,.yaml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.sh,.sql,.xml">' +
      '      <button type="button" class="sov-desk-attach" id="sovDeskAttach" ' +
      'title="Attach file or data" aria-label="Attach file">' +
      '        <span class="sov-attach-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
      '<path d="M16.5 6.5v9.25a4.5 4.5 0 1 1-9 0V6.75a3 3 0 0 1 6 0v8.5a1.5 1.5 0 1 1-3 0V7.5a.75.75 0 0 0-1.5 0v7.75a3 3 0 1 0 6 0V6.75a4.5 4.5 0 1 0-9 0v9a6 6 0 1 0 12 0V6.5a.75.75 0 0 0-1.5 0z"/>' +
      "</svg></span>" +
      "      </button>" +
      '      <button type="button" class="sov-desk-mic" id="sovDeskMic" ' +
      'title="Talk — voice to text" aria-label="Voice to text" aria-pressed="false">' +
      '        <span class="sov-mic-ic" aria-hidden="true">' +
      // Clean outline mic (stroke) — avoids the chunky filled-path artifact
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="2.5" width="6" height="11" rx="3"/>' +
      '<path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/>' +
      '<path d="M12 17v4.5"/>' +
      '<path d="M8.5 21.5h7"/>' +
      "</svg></span>" +
      "      </button>" +
      '      <textarea id="sovDeskInput" rows="1" placeholder="Message Sovereign…  (attach · mic · Enter to send)" autocomplete="off"></textarea>' +
      '      <button type="submit" class="sov-desk-send" id="sovDeskSend">Send</button>' +
      "    </form>" +
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
      ta.addEventListener("input", function () {
        // Manual edits while listening become the new base
        if (state.listening) {
          state.baseText = ta.value;
          state.interim = "";
        }
        autoGrow(ta);
        // Durable draft so a refresh/crash never eats unsent text
        if (!state.sending) saveDraft(String(ta.value || ""));
      });
    }
    var mic = document.getElementById("sovDeskMic");
    if (mic && !mic._wired) {
      mic._wired = true;
      mic.onclick = function (e) {
        e.preventDefault();
        toggleVoice();
      };
    }
    var attachBtn = document.getElementById("sovDeskAttach");
    var fileInput = document.getElementById("sovDeskFile");
    if (attachBtn && fileInput && !attachBtn._wired) {
      attachBtn._wired = true;
      attachBtn.onclick = function (e) {
        e.preventDefault();
        fileInput.click();
      };
      fileInput.onchange = function () {
        var files = fileInput.files;
        if (!files || !files.length) return;
        for (var i = 0; i < files.length; i++) uploadFile(files[i]);
        fileInput.value = "";
      };
    }
    // Drag-drop files onto the desk
    var main = sec.querySelector(".sov-desk-main") || sec;
    if (main && !main._dropWired) {
      main._dropWired = true;
      ["dragenter", "dragover"].forEach(function (ev) {
        main.addEventListener(ev, function (e) {
          e.preventDefault();
          e.stopPropagation();
          main.classList.add("sov-drop-hot");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        main.addEventListener(ev, function (e) {
          e.preventDefault();
          e.stopPropagation();
          main.classList.remove("sov-drop-hot");
        });
      });
      main.addEventListener("drop", function (e) {
        var dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        for (var i = 0; i < dt.files.length; i++) uploadFile(dt.files[i]);
      });
    }
    // Paste images / large text into the box
    if (ta && !ta._pasteWired) {
      ta._pasteWired = true;
      ta.addEventListener("paste", function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind === "file") {
            var f = it.getAsFile();
            if (f) {
              e.preventDefault();
              uploadFile(f);
            }
          }
        }
      });
    }
    var ref = document.getElementById("sovDeskRefresh");
    if (ref && !ref._wired) {
      ref._wired = true;
      ref.onclick = function () {
        loadHistory();
        refreshBridgeStatus();
      };
    }
    syncMicUi();
    renderAttachments();
    refreshBridgeStatus();
    return sec;
  }

  function renderAttachments() {
    var row = document.getElementById("sovAttachRow");
    if (!row) return;
    if (!state.attachments.length) {
      row.hidden = true;
      row.innerHTML = "";
      return;
    }
    row.hidden = false;
    row.innerHTML = state.attachments
      .map(function (a, idx) {
        var size =
          a.size > 1024 * 1024
            ? (a.size / (1024 * 1024)).toFixed(1) + " MB"
            : a.size > 1024
              ? Math.round(a.size / 1024) + " KB"
              : a.size + " B";
        return (
          '<span class="sov-attach-chip" data-idx="' +
          idx +
          '">' +
          '<span class="sov-attach-name">' +
          esc(a.filename || "file") +
          "</span>" +
          '<span class="sov-attach-size">' +
          esc(size) +
          "</span>" +
          '<button type="button" class="sov-attach-x" data-rm="' +
          idx +
          '" aria-label="Remove">×</button>' +
          "</span>"
        );
      })
      .join("");
    row.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.onclick = function () {
        var i = parseInt(btn.getAttribute("data-rm"), 10);
        if (!isNaN(i)) {
          state.attachments.splice(i, 1);
          renderAttachments();
        }
      };
    });
  }

  async function uploadFile(file) {
    if (!file || !state.allowed) return;
    var row = document.getElementById("sovAttachRow");
    if (row) {
      row.hidden = false;
      row.innerHTML =
        (row.innerHTML || "") +
        '<span class="sov-attach-chip sov-attach-uploading">Uploading ' +
        esc(file.name || "file") +
        "…</span>";
    }
    try {
      var fd = new FormData();
      fd.append("file", file, file.name || "upload.bin");
      var headers = authHeaders();
      // Let browser set multipart boundary
      delete headers["Content-Type"];
      var r = await fetch(API.upload, {
        method: "POST",
        headers: headers,
        body: fd,
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "upload failed");
      if (d.asset) {
        state.attachments.push(d.asset);
      }
    } catch (e) {
      alert("Upload failed: " + ((e && e.message) || e));
    }
    renderAttachments();
  }

  async function uploadSnippet(text, filename) {
    if (!text || !state.allowed) return;
    try {
      var fd = new FormData();
      fd.append("snippet", text);
      fd.append("filename", filename || "paste.txt");
      var headers = authHeaders();
      delete headers["Content-Type"];
      var r = await fetch(API.upload, {
        method: "POST",
        headers: headers,
        body: fd,
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "snippet failed");
      if (d.asset) state.attachments.push(d.asset);
      renderAttachments();
    } catch (e) {
      alert("Couldn’t attach data: " + ((e && e.message) || e));
    }
  }

  async function refreshBridgeStatus() {
    var pill = document.getElementById("sovBridgePill");
    if (!pill || !state.allowed) return;
    try {
      var r = await fetch(API.bridgeStatus, { headers: authHeaders() });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error("no");
      var q = (d.queued || 0) + (d.running || 0);
      var configured = !!d.bridge_token_configured;
      pill.className =
        "sov-bridge-pill " +
        (configured ? (q ? "busy" : "ready") : "off");
      pill.textContent = !configured
        ? "bridge off"
        : q
          ? "bridge · " + q + " task" + (q === 1 ? "" : "s")
          : "bridge ready";
      pill.title = configured
        ? "Local computer bridge token is set. Run scripts/sovereign_local_bridge.py on your machine."
        : "Set SOVEREIGN_BRIDGE_TOKEN on Railway + run the local bridge for computer access.";
      state.bridgeOnline = configured;
    } catch (e) {
      pill.className = "sov-bridge-pill off";
      pill.textContent = "bridge ?";
    }
  }

  // ── Voice → text (browser SpeechRecognition) ─────────────────────────────
  function speechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function syncMicUi() {
    var mic = document.getElementById("sovDeskMic");
    if (!mic) return;
    if (!speechSupported()) {
      mic.disabled = true;
      mic.title = "Voice not supported in this browser — try Chrome";
      mic.classList.add("unsupported");
      mic.setAttribute("aria-pressed", "false");
      return;
    }
    mic.disabled = false;
    mic.classList.toggle("listening", !!state.listening);
    mic.setAttribute("aria-pressed", state.listening ? "true" : "false");
    mic.title = state.listening
      ? "Listening… click to stop"
      : "Talk — voice to text";
    var form = document.getElementById("sovDeskForm");
    if (form) form.classList.toggle("sov-listening", !!state.listening);
  }

  function applyVoiceText() {
    var ta = document.getElementById("sovDeskInput");
    if (!ta) return;
    var base = state.baseText || "";
    var interim = state.interim || "";
    var joined = base;
    if (interim) {
      joined = base
        ? base.replace(/\s+$/, "") + (base && !/\s$/.test(base) ? " " : "") + interim
        : interim;
    }
    ta.value = joined;
    autoGrow(ta);
  }

  function stopVoice(opts) {
    opts = opts || {};
    state.listening = false;
    state.interim = "";
    if (state.recognition) {
      try {
        state.recognition.onresult = null;
        state.recognition.onerror = null;
        state.recognition.onend = null;
        state.recognition.stop();
      } catch (e) {}
      try {
        state.recognition.abort();
      } catch (e2) {}
      state.recognition = null;
    }
    syncMicUi();
    if (opts.focus) {
      var ta = document.getElementById("sovDeskInput");
      if (ta) ta.focus();
    }
  }

  function startVoice() {
    if (!speechSupported()) {
      alert("Voice-to-text needs Chrome (or Edge). This browser has no SpeechRecognition.");
      return;
    }
    if (state.sending) return;
    stopVoice(); // clean prior instance
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (navigator.language || "en-US").indexOf("en") === 0
      ? navigator.language || "en-US"
      : "en-US";
    rec.maxAlternatives = 1;

    var ta = document.getElementById("sovDeskInput");
    state.baseText = ta ? String(ta.value || "").replace(/\s+$/, "") : "";
    state.interim = "";
    state.recognition = rec;
    state.listening = true;
    syncMicUi();

    rec.onresult = function (ev) {
      var finalChunk = "";
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        var piece = (r[0] && r[0].transcript) || "";
        if (r.isFinal) finalChunk += piece;
        else interim += piece;
      }
      if (finalChunk) {
        var add = finalChunk.replace(/^\s+/, "");
        if (state.baseText && !/\s$/.test(state.baseText) && add) {
          state.baseText += " ";
        }
        state.baseText += add;
        // Light punctuation help: capitalise sentence starts after .!?
        state.baseText = state.baseText.replace(/\s+/g, " ");
        state.interim = "";
      } else {
        state.interim = interim;
      }
      applyVoiceText();
    };

    rec.onerror = function (ev) {
      var err = (ev && ev.error) || "";
      if (err === "aborted" || err === "no-speech") {
        // benign — no-speech often fires between utterances
        if (err === "no-speech" && state.listening) return;
      }
      if (err === "not-allowed" || err === "service-not-allowed") {
        stopVoice();
        alert(
          "Microphone blocked. Click the lock icon in the address bar → Microphone → Allow, then try the mic again."
        );
        return;
      }
      // network / other — stop cleanly
      if (err !== "no-speech") stopVoice({ focus: true });
    };

    rec.onend = function () {
      // Chrome ends recognition after pauses even with continuous:true —
      // restart while user still wants to talk.
      if (state.listening && state.recognition === rec && !state.sending) {
        try {
          rec.start();
          return;
        } catch (e) {
          /* fall through to stop */
        }
      }
      state.listening = false;
      state.recognition = null;
      state.interim = "";
      // Keep finalized text in the box
      applyVoiceText();
      syncMicUi();
    };

    try {
      rec.start();
    } catch (e) {
      stopVoice();
      alert("Couldn’t start the microphone: " + ((e && e.message) || e));
    }
  }

  function toggleVoice() {
    if (state.listening) stopVoice({ focus: true });
    else startVoice();
  }

  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(160, Math.max(48, ta.scrollHeight)) + "px";
  }

  function setTyping(on) {
    var el = document.getElementById("sovDeskTyping");
    if (!el) return;
    if (on) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  }

  function bubbleHtml(m) {
    var role = m.role === "ford" ? "ford" : "sov";
    var label = role === "ford" ? "You" : "Sovereign";
    var raw = stripSideJson(m.content || "");
    var body = shouldRich(role, raw)
      ? formatChatMd(raw)
      : esc(raw).replace(/\n/g, "<br>");
    var t = formatTime(m.created_at);
    return (
      '<div class="sov-bubble sov-bubble--' +
      role +
      '" data-role="' +
      role +
      '">' +
      '<div class="sov-bubble-lab">' +
      '<span class="sov-bubble-who">' +
      esc(label) +
      "</span>" +
      (t ? '<span class="sov-bubble-time">' + esc(t) + "</span>" : "") +
      "</div>" +
      '<div class="sov-bubble-body sov-md">' +
      body +
      "</div>" +
      "</div>"
    );
  }

  function renderMessages() {
    var host = document.getElementById("sovDeskMsgs");
    if (!host) return;
    var visible = state.messages.filter(isChatWorthy);
    if (!visible.length && !state.sending) {
      host.innerHTML =
        '<div class="sov-desk-empty">' +
        "<b>Sovereign is here</b>" +
        "<p>Just talk. He’ll format answers clearly — links, lists, the works.</p>" +
        "</div>";
      return;
    }
    var nearBottom =
      host.scrollHeight - host.scrollTop - host.clientHeight < 120;
    host.innerHTML = visible.map(bubbleHtml).join("");
    if (nearBottom || state.sending) host.scrollTop = host.scrollHeight;
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

  function msgKey(m) {
    if (m && m.id) return "id:" + m.id;
    if (m && m._localId) return "local:" + m._localId;
    return (
      "tmp:" +
      (m && m.role) +
      ":" +
      String((m && m.content) || "").slice(0, 120) +
      ":" +
      String((m && m.created_at) || "")
    );
  }

  /** Merge server history with in-flight / local bubbles so poll never wipes a send. */
  function applyServerHistory(serverMsgs) {
    serverMsgs = Array.isArray(serverMsgs) ? serverMsgs : [];
    var byId = {};
    serverMsgs.forEach(function (m) {
      if (m && m.id) byId[m.id] = m;
    });

    // Keep local-only bubbles (optimistic send, offline error) until server has them
    var locals = (state.messages || []).filter(function (m) {
      if (!m) return false;
      if (m._pending) return true; // in-flight send — never drop
      if (m.id && byId[m.id]) return false; // server is source of truth
      if (m.id && !byId[m.id]) return true; // rare lag: keep until next poll
      // No id: keep recent local echoes if server doesn't already have same content
      if (m._local) {
        var dup = serverMsgs.some(function (s) {
          return (
            s &&
            s.role === m.role &&
            String(s.content || "").trim() === String(m.content || "").trim()
          );
        });
        return !dup;
      }
      return false;
    });

    // If server returned empty but we have real conversation, don't blank the UI
    if (!serverMsgs.length && (state.messages || []).length && !state._historyEverLoaded) {
      // first load empty is fine
    } else if (!serverMsgs.length && locals.length === 0 && (state.messages || []).length) {
      // Server empty + no locals → keep prior messages (stale worker-filter bug)
      var prior = (state.messages || []).filter(isChatWorthy);
      if (prior.length) {
        state._historyEverLoaded = true;
        return;
      }
    }

    var merged = serverMsgs.slice();
    locals.forEach(function (loc) {
      var exists = merged.some(function (s) {
        if (loc.id && s.id && loc.id === s.id) return true;
        return (
          s.role === loc.role &&
          String(s.content || "").trim() === String(loc.content || "").trim()
        );
      });
      if (!exists) merged.push(loc);
    });

    merged.sort(function (a, b) {
      var ta = a.created_at ? Date.parse(a.created_at) : 0;
      var tb = b.created_at ? Date.parse(b.created_at) : 0;
      if (ta && tb && ta !== tb) return ta - tb;
      return 0;
    });

    state.messages = merged;
    state._historyEverLoaded = true;
  }

  async function loadHistory(opts) {
    opts = opts || {};
    var host = document.getElementById("sovDeskMsgs");
    if (!state.allowed) {
      if (host)
        host.innerHTML =
          '<div class="sov-desk-empty"><b>Sign in as Ford</b>' +
          "<p>Sovereign desk is only on the developer account.</p></div>";
      return;
    }
    // Never clobber an in-flight turn (the classic "send then both disappear" race)
    if (state.sending && !opts.force) return;
    try {
      var r = await fetch(API.history + "?limit=120", { headers: authHeaders() });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error((d && d.detail) || "HTTP " + r.status);
      // If a send started while fetch was in flight, don't apply
      if (state.sending && !opts.force) return;
      applyServerHistory((d && d.messages) || []);
      var meta = document.getElementById("sovDeskMeta");
      if (meta)
        meta.textContent = (d.email || state.email || "desk") + " · private";
      renderMessages();
    } catch (e) {
      // On error, keep whatever is on screen — don't clear the transcript
      if (host && !(state.messages || []).length)
        host.innerHTML =
          '<div class="sov-desk-empty"><b>Couldn’t load desk</b><p>' +
          esc(e.message || "network") +
          "</p></div>";
    }
  }

  function applyTurnResult(d, fordLocal) {
    if (!d) return false;
    var fordMsg = d.ford_message || null;
    if (fordLocal) {
      fordLocal._pending = false;
      if (fordMsg && fordMsg.id) {
        fordLocal.id = fordMsg.id;
        fordLocal.created_at = fordMsg.created_at || fordLocal.created_at;
        fordLocal._local = false;
      } else if (d.ford_message_id) {
        fordLocal.id = d.ford_message_id;
        fordLocal._local = false;
      }
    }
    var reply = (d.message && d.message.content) || d.reply || "";
    if (!reply) return false;
    var mid = d.message && d.message.id;
    var exists =
      mid &&
      (state.messages || []).some(function (m) {
        return m && m.id === mid;
      });
    if (!exists) {
      state.messages.push({
        id: mid,
        role: "sovereign",
        content: reply,
        provider: d.provider,
        created_at:
          (d.message && d.message.created_at) || new Date().toISOString(),
        _local: !mid,
      });
    }
    return true;
  }

  async function postChat(payload, attempt) {
    attempt = attempt || 0;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    // Client-side ceiling well above server wait — pending path should return first
    if (ctrl) timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 95000);
    try {
      var r = await fetch(API.chat, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined,
      });
      var d = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) {
        var detail = d && d.detail;
        if (typeof detail === "object")
          detail = detail.message || JSON.stringify(detail);
        // Transient gateway — retry once, then treat as pending so poll can recover
        if (
          (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 524) &&
          attempt < 2
        ) {
          await sleep(800 * (attempt + 1));
          return postChat(payload, attempt + 1);
        }
        if (r.status === 504 || r.status === 502 || r.status === 524) {
          return {
            ok: true,
            pending: true,
            poll: true,
            client_request_id: payload.client_request_id,
            soft_gateway: r.status,
            hint: "Gateway slow — recovering via poll.",
          };
        }
        throw new Error(detail || "HTTP " + r.status);
      }
      return d;
    } catch (e) {
      var name = (e && e.name) || "";
      var msg = (e && e.message) || String(e);
      var transient =
        name === "AbortError" ||
        /failed to fetch|network|timeout|aborted/i.test(msg);
      if (transient && attempt < 2) {
        await sleep(900 * (attempt + 1));
        return postChat(payload, attempt + 1);
      }
      if (transient) {
        // Network died mid-flight — message may already be saved; poll recovers
        return {
          ok: true,
          pending: true,
          poll: true,
          client_request_id: payload.client_request_id,
          soft_network: true,
          hint: "Network blip — recovering via poll.",
        };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function pollTurnUntilReady(crid, fordId, opts) {
    opts = opts || {};
    var maxMs = opts.maxMs || 180000;
    var start = Date.now();
    var delay = 1500;
    while (Date.now() - start < maxMs) {
      // Prefer dedicated turn endpoint; fall back to history + chat poll_only
      try {
        var q = [];
        if (crid) q.push("client_request_id=" + encodeURIComponent(crid));
        if (fordId) q.push("ford_message_id=" + encodeURIComponent(fordId));
        var r = await fetch(API.turn + "?" + q.join("&"), {
          headers: authHeaders(),
        });
        var d = await r.json().catch(function () {
          return {};
        });
        if (r.ok && d && ((d.message && d.message.content) || d.reply)) {
          return d;
        }
        if (r.ok && d && d.ford_message_id && !fordId) {
          fordId = d.ford_message_id;
          state.activeFordId = fordId;
          savePendingTurn({
            crid: crid,
            fordId: fordId,
            at: Date.now(),
          });
        }
      } catch (e) {
        /* keep polling */
      }
      // Also poke chat poll_only (idempotent) + refresh history
      try {
        if (crid) {
          var d2 = await postChat({
            message: "",
            attachment_ids: [],
            client_request_id: crid,
            poll_only: true,
          });
          if (d2 && ((d2.message && d2.message.content) || d2.reply)) return d2;
          if (d2 && d2.ford_message_id) fordId = d2.ford_message_id;
        }
      } catch (e2) {}
      try {
        await loadHistory({ force: true });
        // Detect reply after our ford bubble in local state
        if (fordId) {
          var idx = -1;
          for (var i = 0; i < state.messages.length; i++) {
            if (state.messages[i] && state.messages[i].id === fordId) idx = i;
          }
          if (idx >= 0) {
            for (var j = idx + 1; j < state.messages.length; j++) {
              var m = state.messages[j];
              if (
                m &&
                m.role === "sovereign" &&
                m.provider !== "error" &&
                (m.content || "").trim()
              ) {
                return {
                  ok: true,
                  pending: false,
                  ford_message_id: fordId,
                  message: m,
                  reply: m.content,
                  provider: m.provider,
                };
              }
            }
          }
        }
      } catch (e3) {}
      await sleep(delay);
      delay = Math.min(5000, Math.floor(delay * 1.25));
    }
    return null;
  }

  async function send() {
    if (state.sending || !state.allowed) return;
    var ta = document.getElementById("sovDeskInput");
    var text = ta ? String(ta.value || "").trim() : "";
    var attachIds = (state.attachments || []).map(function (a) {
      return a.id;
    });
    if (!text && !attachIds.length) return;
    // Stop dictation so we don't keep filling the box mid-send
    if (state.listening) stopVoice();
    state.sending = true;
    setTyping(true);
    var btn = document.getElementById("sovDeskSend");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    if (ta) {
      ta.value = "";
      autoGrow(ta);
    }
    saveDraft(""); // clear draft once we've accepted the send
    var attachNote = "";
    if (attachIds.length) {
      attachNote =
        "\n\n[Attached " +
        attachIds.length +
        " file" +
        (attachIds.length === 1 ? "" : "s") +
        ": " +
        state.attachments
          .map(function (a) {
            return a.filename;
          })
          .join(", ") +
        "]";
    }
    var sentAttach = state.attachments.slice();
    state.attachments = [];
    renderAttachments();
    var crid = newClientRequestId();
    state.activeCrid = crid;
    var localId = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    var fordLocal = {
      role: "ford",
      content: text + attachNote,
      created_at: new Date().toISOString(),
      _local: true,
      _pending: true,
      _localId: localId,
      meta: { attachments: sentAttach, client_request_id: crid },
    };
    state.messages.push(fordLocal);
    renderMessages();
    var host = document.getElementById("sovDeskMsgs");
    if (host) host.scrollTop = host.scrollHeight;
    savePendingTurn({ crid: crid, text: text, at: Date.now() });

    try {
      var d = await postChat({
        message: text || "",
        attachment_ids: attachIds,
        client_request_id: crid,
      });

      var fordId =
        (d && d.ford_message && d.ford_message.id) ||
        (d && d.ford_message_id) ||
        null;
      if (fordId) {
        state.activeFordId = fordId;
        savePendingTurn({ crid: crid, fordId: fordId, at: Date.now() });
      }

      var gotReply = applyTurnResult(d, fordLocal);
      if (!gotReply && d && (d.pending || d.poll || !((d.message && d.message.content) || d.reply))) {
        // Soft-pending: keep typing indicator and poll until reply lands
        setTyping(true);
        var typingEl = document.getElementById("sovDeskTyping");
        if (typingEl) {
          var span = typingEl.querySelector("span:last-child") || typingEl;
          // leave default "Sovereign is thinking…"
        }
        var finished = await pollTurnUntilReady(crid, fordId, { maxMs: 180000 });
        if (finished) {
          applyTurnResult(finished, fordLocal);
          gotReply = true;
        } else {
          // Still no reply after long wait — message is safe; don't scare Ford
          fordLocal._pending = false;
          state.messages.push({
            role: "sovereign",
            content:
              "Still working on that — your message is saved. Hit ↻ in a moment; " +
              "the reply will appear when Sovereign finishes.",
            provider: "system",
            created_at: new Date().toISOString(),
            _local: true,
            _localId: "pend_" + localId,
          });
        }
      }
      savePendingTurn(null);
      state.activeCrid = null;
      state.activeFordId = null;
      renderMessages();
      if (host) host.scrollTop = host.scrollHeight;
      // Sync with server truth
      try {
        await loadHistory({ force: true });
      } catch (e) {}
    } catch (e) {
      fordLocal._pending = false;
      // Hard failure — but still try recovery poll once
      var recovered = null;
      try {
        recovered = await pollTurnUntilReady(crid, state.activeFordId, {
          maxMs: 12000,
        });
      } catch (e2) {}
      if (recovered && applyTurnResult(recovered, fordLocal)) {
        savePendingTurn(null);
      } else {
        // Restore draft so Ford never loses typed text on hard fail
        if (text) {
          saveDraft(text);
          if (ta) {
            ta.value = text;
            autoGrow(ta);
          }
        }
        state.messages.push({
          role: "sovereign",
          content:
            "Couldn't finish that send — " +
            ((e && e.message) || e) +
            ". Your draft was restored. Hit Send again (safe to retry).",
          provider: "error",
          created_at: new Date().toISOString(),
          _local: true,
          _localId: "err_" + localId,
        });
      }
      renderMessages();
    } finally {
      state.sending = false;
      setTyping(false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send";
      }
      if (ta) ta.focus();
    }
  }

  /** Resume a turn that was in-flight when the tab closed / refreshed. */
  async function resumePendingTurn() {
    var p = loadPendingTurn();
    if (!p || !p.crid) return;
    // Drop stale pendings (>15 min)
    if (p.at && Date.now() - p.at > 15 * 60 * 1000) {
      savePendingTurn(null);
      return;
    }
    if (state.sending) return;
    state.sending = true;
    setTyping(true);
    try {
      var d = await pollTurnUntilReady(p.crid, p.fordId || null, {
        maxMs: 90000,
      });
      if (d) {
        applyTurnResult(d, null);
        savePendingTurn(null);
        renderMessages();
        await loadHistory({ force: true });
      }
    } catch (e) {
      /* leave pending for next open */
    } finally {
      state.sending = false;
      setTyping(false);
    }
  }

  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(function () {
      if (location.hash === "#sovereign" && state.allowed && !state.sending) {
        loadHistory();
      }
    }, 20000);
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
    // Restore unsaved draft if compose is empty
    var ta = document.getElementById("sovDeskInput");
    if (ta && !String(ta.value || "").trim()) {
      var draft = loadDraft();
      if (draft) {
        ta.value = draft;
        autoGrow(ta);
      }
    }
    loadHistory();
    startPoll();
    // Resume any in-flight turn from a prior tab crash / hard refresh
    resumePendingTurn();
    setTimeout(function () {
      var ta2 = document.getElementById("sovDeskInput");
      if (ta2) ta2.focus();
    }, 80);
  }

  function openDesk() {
    ensureShell();
    if (location.hash !== "#sovereign") {
      location.hash = "#sovereign";
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
    var list = document.getElementById("acctList");
    if (list && !document.getElementById("sovDeskEntry")) {
      var card = document.createElement("section");
      card.id = "sovDeskEntry";
      card.className = "sov-desk-entry";
      card.innerHTML =
        '<div class="sov-desk-entry-inner">' +
        "<div>" +
        "<b>Sovereign</b>" +
        "<p>Private chat with the product mind.</p>" +
        "</div>" +
        '<button type="button" class="sov-desk-entry-btn" id="sovDeskOpenBtn">Open chat</button>' +
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
      fab2.title = "Sovereign";
      fab2.setAttribute("aria-label", "Open Sovereign chat");
      fab2.textContent = "S";
      fab2.onclick = openDesk;
      document.body.appendChild(fab2);
    }
  }

  async function boot() {
    var ok = await checkAccess();
    if (!ok) {
      mountEntry();
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
      if (state.listening) stopVoice();
      var p = document.getElementById("panelSovereign");
      if (p) {
        p.classList.remove("active");
        p.hidden = true;
      }
    }
  });

  setTimeout(function () {
    var list = document.getElementById("acctList");
    if (!list) return;
    var obs = new MutationObserver(function () {
      if (state.allowed) mountEntry();
    });
    obs.observe(list, { childList: true });
  }, 1500);

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
  window.__aoSovereignFormatMd = formatChatMd;
})();
