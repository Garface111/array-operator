/* Sovereign Desk — private Ford ↔ Sovereign chat (rich markdown UI).
 * Visible when GET /v1/sovereign/desk/access returns desk:true.
 * Hash: #sovereign. Chat-only; no ops rail / worker dumps.
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

  /** Drop trailing side-effect JSON block if the model leaked it into prose. */
  function stripSideJson(text) {
    var t = String(text || "");
    var cut = t.indexOf("---JSON---");
    if (cut >= 0) t = t.slice(0, cut);
    // bare trailing { ... } with actions/monologue keys
    t = t.replace(/\n\s*\{[\s\S]*"(?:actions|monologue|ford_ask)"[\s\S]*\}\s*$/, "");
    return t.replace(/\s+$/, "");
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
    if (prov === "worker" || prov === "rules" || prov === "admin") return false;
    if (meta && (meta.job_id || meta.from === "rules_utility_triage" || meta.legacy)) {
      if (prov === "worker" || /^Sovereign shipped job/i.test(text) || /^Ops /i.test(text))
        return false;
    }
    if (/^Sovereign shipped job\s/i.test(text)) return false;
    if (/^Ship:\s*\{/m.test(text) && /Deploy:\s*\{/m.test(text)) return false;
    if (/^Ops\s+\w+:\s*\{/.test(text)) return false;
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
      if (
        existing.classList.contains("sov-desk--chat") &&
        existing.classList.contains("sov-desk--rich") &&
        !existing.querySelector(".sov-ops")
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
      '        <p class="sov-desk-sub">Private chat</p>' +
      "      </div>" +
      "    </div>" +
      '    <div class="sov-desk-head-right">' +
      '      <div class="sov-desk-meta" id="sovDeskMeta">Developer only</div>' +
      '      <button type="button" class="sov-desk-refresh" id="sovDeskRefresh" title="Refresh" aria-label="Refresh">↻</button>' +
      "    </div>" +
      "  </header>" +
      '  <div class="sov-desk-main">' +
      '    <div class="sov-desk-body" id="sovDeskMsgs" aria-live="polite"></div>' +
      '    <div class="sov-desk-typing" id="sovDeskTyping" hidden>' +
      '      <span class="sov-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      "      <span>Sovereign is thinking…</span>" +
      "    </div>" +
      '    <form class="sov-desk-compose" id="sovDeskForm">' +
      '      <textarea id="sovDeskInput" rows="1" placeholder="Message Sovereign…  (Enter to send · Shift+Enter newline)" autocomplete="off"></textarea>' +
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
        autoGrow(ta);
      });
    }
    var ref = document.getElementById("sovDeskRefresh");
    if (ref && !ref._wired) {
      ref._wired = true;
      ref.onclick = function () {
        loadHistory();
      };
    }
    return sec;
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
      var r = await fetch(API.history + "?limit=120", { headers: authHeaders() });
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
    state.messages.push({
      role: "ford",
      content: text,
      created_at: new Date().toISOString(),
    });
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
      var reply = (d.message && d.message.content) || d.reply || "";
      if (reply) {
        state.messages.push({
          role: "sovereign",
          content: reply,
          provider: d.provider,
          created_at:
            (d.message && d.message.created_at) || new Date().toISOString(),
        });
      }
      renderMessages();
      if (host) host.scrollTop = host.scrollHeight;
    } catch (e) {
      state.messages.push({
        role: "sovereign",
        content: "Couldn't send that just now — " + (e.message || e) + ". Try again.",
        provider: "error",
        created_at: new Date().toISOString(),
      });
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

  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(function () {
      if (location.hash === "#sovereign" && state.allowed && !state.sending) {
        loadHistory();
      }
    }, 15000);
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
    startPoll();
    setTimeout(function () {
      var ta = document.getElementById("sovDeskInput");
      if (ta) ta.focus();
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
