/* Repairs — agent-centric surface.
 * Setup (team + array map) and coordination happen in Energy Agent chat.
 * This panel shows what the agent is working on; empty → calm invite to talk.
 * Hash: #ops  ·  data: /v1/array-owners/ops
 */
(function () {
  "use strict";

  var STATE = {
    data: null,
    busy: false,
    loadGen: 0,
    bgReconcileAt: 0,
    expanded: null,
  };

  var CACHE_KEY = "ao_ops_cache_v3";
  var FETCH_MS = 20000;
  var SETUP_FLAG = "ao_repairs_setup_done";

  function authHeaders() {
    var h = { "Content-Type": "application/json" };
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

  function root() {
    return document.getElementById("opsRoot");
  }

  function hasSession() {
    try {
      return !!localStorage.getItem("so_session");
    } catch (e) {
      return false;
    }
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.data) return null;
      if (o.ts && Date.now() - o.ts > 30 * 60 * 1000) return null;
      return o.data;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ ts: Date.now(), data: data })
      );
    } catch (e) {}
  }

  async function api(path, opts) {
    opts = opts || {};
    var ctrl = opts.signal ? null : new AbortController();
    var signal = opts.signal || (ctrl && ctrl.signal);
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (e) {}
      }, opts.timeoutMs || FETCH_MS);
    }
    try {
      var r = await fetch(
        path,
        Object.assign({ headers: authHeaders() }, opts, { signal: signal })
      );
      var d = null;
      try {
        d = await r.json();
      } catch (e) {
        d = null;
      }
      if (!r.ok) {
        var err =
          (d && (d.detail || d.error || d.message)) || "HTTP " + r.status;
        throw new Error(typeof err === "string" ? err : JSON.stringify(err));
      }
      return d;
    } catch (e) {
      if (e && e.name === "AbortError")
        throw new Error("Request timed out — try again");
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function activeCases(d) {
    if (!d) return [];
    if (d.active_cases && d.active_cases.length) return d.active_cases;
    return (d.tickets || []).filter(function (t) {
      return (
        t.status === "open" ||
        t.status === "waiting_reply" ||
        t.status === "scheduled" ||
        t.status === "in_progress"
      );
    });
  }

  function setupComplete(d) {
    try {
      if (localStorage.getItem(SETUP_FLAG) === "1") return true;
    } catch (e) {}
    var contacts = (d && d.contacts) || [];
    return contacts.length > 0;
  }

  function markSetupDone() {
    try {
      localStorage.setItem(SETUP_FLAG, "1");
    } catch (e) {}
  }

  function relTime(iso) {
    if (!iso) return "";
    try {
      var t = new Date(iso).getTime();
      if (!t) return "";
      var s = Math.round((Date.now() - t) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      if (s < 86400) return Math.floor(s / 3600) + "h ago";
      if (s < 86400 * 14) return Math.floor(s / 86400) + "d ago";
      return new Date(iso).toLocaleDateString();
    } catch (e) {
      return "";
    }
  }

  /** Context-aware staged prompt — never auto-sends. */
  function stagedPrompt(d) {
    var cases = activeCases(d);
    var contacts = (d && d.contacts) || [];
    if (!setupComplete(d) || !contacts.length) {
      return (
        "Set up my repair system. Check whether I have any O&M contacts, then help me " +
        "build a full roster — name, email, phone, and which arrays each person covers — " +
        "so you can email them the moment hardware faults."
      );
    }
    if (cases.length === 1) {
      var t = cases[0];
      var site = t.site_name || "a site";
      return (
        "Tell me about my current repair system, especially the open case at " +
        site +
        "."
      );
    }
    if (cases.length > 1) {
      return (
        "Tell me about my current repair system — I have " +
        cases.length +
        " open cases. What are you working on?"
      );
    }
    return "Tell me about my current repair system.";
  }

  /** Open Energy Agent and put prompt in the box (does not send). */
  function openAgentWithPrompt(text) {
    try {
      if (typeof window.__eaStagePrompt === "function") {
        window.__eaStagePrompt(text);
        return;
      }
    } catch (e) {}
    try {
      if (typeof window.__eaOpen === "function") {
        window.__eaOpen();
      }
      setTimeout(function () {
        var input = document.getElementById("eaInput");
        if (input) {
          input.value = text || "";
          input.focus();
          try {
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } catch (e2) {}
        }
      }, 120);
    } catch (e) {}
  }

  function applyData(d) {
    if (!d) return;
    STATE.data = d;
    if ((d.contacts || []).length) markSetupDone();
    writeCache(d);
    render();
  }

  function bgReconcile() {
    var now = Date.now();
    if (now - (STATE.bgReconcileAt || 0) < 5 * 60 * 1000) return;
    STATE.bgReconcileAt = now;
    api("/v1/array-owners/ops/reconcile", { method: "POST", timeoutMs: 90000 })
      .then(function (r) {
        if (r && ((r.opened || 0) > 0 || (r.closed || 0) > 0)) {
          return api("/v1/array-owners/ops?reconcile_first=0", {
            timeoutMs: FETCH_MS,
          });
        }
        return null;
      })
      .then(function (d) {
        if (d && (d.tickets || d.active_cases || d.contacts)) applyData(d);
      })
      .catch(function () {});
  }

  async function load(force) {
    var el = root();
    if (!el) return;

    if (!hasSession()) {
      el.innerHTML =
        '<div class="rp-shell">' +
        '<div class="rp-hero">' +
        "<h2>Repairs</h2>" +
        "<p>EnergyAgent watches your fleet, drafts outreach to your O&amp;M team, and closes cases when hardware recovers.</p>" +
        '<p class="rp-muted"><a class="ops-link" href="/login">Sign in</a> to set up your repair team in chat.</p>' +
        "</div></div>";
      return;
    }

    if (!STATE.data) {
      var cached = readCache();
      if (cached) {
        STATE.data = cached;
        render();
      }
    }

    if (STATE.busy && !force) return;
    var gen = ++STATE.loadGen;
    STATE.busy = true;
    if (!STATE.data) {
      el.innerHTML =
        '<div class="rp-shell"><div class="rp-muted" style="padding:40px 0;text-align:center">Loading…</div></div>';
    }
    try {
      var d = await api("/v1/array-owners/ops?reconcile_first=0", {
        timeoutMs: FETCH_MS,
      });
      if (gen !== STATE.loadGen) return;
      applyData(d);
      bgReconcile();
    } catch (e) {
      if (gen !== STATE.loadGen) return;
      if (STATE.data) render();
      else {
        el.innerHTML =
          '<div class="rp-shell"><div class="rp-hero"><h2>Repairs</h2><p class="rp-muted">' +
          esc(e.message || "Couldn't load") +
          '</p><button type="button" class="rp-talk" id="opsRetry">Retry</button></div></div>';
        var btn = document.getElementById("opsRetry");
        if (btn)
          btn.onclick = function () {
            load(true);
          };
      }
    } finally {
      if (gen === STATE.loadGen) STATE.busy = false;
    }
  }

  function caseCard(t) {
    var stage = t.pipeline_label || t.pipeline_stage || t.status || "";
    var diagnosis =
      t.diagnosis ||
      (t.evidence && (t.evidence.diagnosis || t.evidence.why)) ||
      t.title ||
      "";
    var draft = t.draft_checkin || {};
    var contact = t.contact;
    var html = '<article class="rp-case" data-ticket="' + t.id + '">';
    html += '<div class="rp-case-top">';
    html +=
      '<div class="rp-case-site">' +
      esc(t.site_name || "Site") +
      "</div>";
    html +=
      '<div class="rp-case-stage">' + esc(stage) + "</div>";
    html += "</div>";
    html +=
      '<div class="rp-case-inv">' +
      esc(t.inv_name || t.serial || "") +
      (t.fail_type
        ? ' · <span class="rp-fail">' + esc(t.fail_type) + "</span>"
        : "") +
      "</div>";
    if (diagnosis) {
      html +=
        '<p class="rp-case-diag">' + esc(String(diagnosis).slice(0, 220)) + "</p>";
    }
    if (t.next_action) {
      html +=
        '<div class="rp-case-next">' + esc(t.next_action) + "</div>";
    }
    if (contact) {
      html +=
        '<div class="rp-case-meta">Tech: ' +
        esc(contact.name) +
        (contact.email ? " · " + esc(contact.email) : "") +
        "</div>";
    }
    // Primary actions stay minimal — prefer chat
    html += '<div class="rp-case-actions">';
    if (
      draft &&
      draft.body &&
      (t.pipeline_stage === "draft_ready" ||
        t.pipeline_stage === "detected" ||
        t.status === "open")
    ) {
      html +=
        '<button type="button" class="rp-btn primary" data-ops-checkin="' +
        t.id +
        '">Approve &amp; send</button>';
    }
    html +=
      '<button type="button" class="rp-btn" data-ops-ask="' +
      t.id +
      '">Ask agent</button>';
    html += "</div>";
    html += "</article>";
    return html;
  }

  function render() {
    var el = root();
    if (!el) return;
    var d = STATE.data;
    var cases = activeCases(d);
    var contacts = (d && d.contacts) || [];
    var activity = (d && d.activity) || [];
    var ready = setupComplete(d) && contacts.length > 0;

    var html = '<div class="rp-shell">';

    // Compact status line — not a KPI wall
    html += '<header class="rp-head">';
    html += "<div>";
    html += "<h2>Repairs</h2>";
    if (ready) {
      var def =
        contacts.find(function (c) {
          return c.is_default;
        }) || contacts[0];
      html +=
        '<p class="rp-status">' +
        (cases.length
          ? cases.length +
            " active case" +
            (cases.length === 1 ? "" : "s")
          : "Watching your fleet") +
        (def ? " · " + esc(def.name) : "") +
        (def && def.email ? " (" + esc(def.email) + ")" : "") +
        "</p>";
    } else {
      html +=
        '<p class="rp-status">Not set up yet — Energy Agent will walk you through your O&amp;M team.</p>';
    }
    html += "</div>";
    html +=
      '<button type="button" class="rp-talk" id="opsTalk">Talk to Energy Agent</button>';
    html += "</header>";

    if (!ready) {
      // Setup-first calm state
      html += '<div class="rp-empty">';
      html +=
        '<div class="rp-empty-orb" aria-hidden="true"></div>';
      html +=
        "<h3>Set up repairs in chat</h3>";
      html +=
        "<p>Energy Agent will ask whether you have an O&amp;M team, take their contact info, then map which arrays they cover. After that it watches for faults and drafts outreach automatically.</p>";
      html +=
        '<button type="button" class="rp-talk primary" id="opsTalkMain">Open Energy Agent</button>';
      html += "</div>";
    } else if (!cases.length) {
      // Healthy empty — agent is the product
      html += '<div class="rp-empty calm">';
      html +=
        '<div class="rp-empty-orb" aria-hidden="true"></div>';
      html += "<h3>Nothing needs you right now</h3>";
      html +=
        "<p>Energy Agent is watching. When an inverter looks dead or faulted, it opens a case, drafts outreach to your repair team, and logs every step here.</p>";
      html +=
        '<button type="button" class="rp-talk primary" id="opsTalkMain">Ask about my repair system</button>';
      html += "</div>";

      // Thin recent activity if any
      if (activity.length) {
        html += '<div class="rp-log-wrap">';
        html += "<h4>Recently</h4>";
        html += '<ol class="rp-log">';
        activity.slice(0, 8).forEach(function (a) {
          html +=
            "<li><span class=\"rp-log-v\">" +
            esc(a.verb || a.summary) +
            '</span> <span class="rp-log-t">' +
            esc(relTime(a.at)) +
            "</span></li>";
        });
        html += "</ol></div>";
      }
    } else {
      // Working on — compact cards
      html +=
        '<div class="rp-working-label">What Energy Agent is working on</div>';
      html += '<div class="rp-cases">';
      cases.forEach(function (t) {
        html += caseCard(t);
      });
      html += "</div>";

      if (activity.length) {
        html += '<div class="rp-log-wrap">';
        html += "<h4>Agent log</h4>";
        html += '<ol class="rp-log">';
        activity.slice(0, 16).forEach(function (a) {
          html +=
            "<li><span class=\"rp-log-v\">" +
            esc(a.summary || a.verb) +
            '</span> <span class="rp-log-t">' +
            esc(relTime(a.at)) +
            "</span></li>";
        });
        html += "</ol></div>";
      }
    }

    html += "</div>";
    el.innerHTML = html;
    wire();
  }

  function wire() {
    var el = root();
    if (!el) return;
    var d = STATE.data;

    function talk() {
      openAgentWithPrompt(stagedPrompt(d));
    }

    ["opsTalk", "opsTalkMain"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.onclick = talk;
    });

    el.querySelectorAll("[data-ops-ask]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-ask"), 10);
        var t = activeCases(d).find(function (x) {
          return x.id === id;
        });
        var site = (t && t.site_name) || "this case";
        openAgentWithPrompt(
          "What's the status on the repair at " + site + " (case #" + id + ")?"
        );
      };
    });

    el.querySelectorAll("[data-ops-checkin]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-checkin"), 10);
        b.disabled = true;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/checkin", {
            method: "POST",
            body: "{}",
          });
          load(true);
        } catch (e) {
          b.disabled = false;
          openAgentWithPrompt(
            "I tried to send outreach on case #" +
              id +
              " but it failed (" +
              (e.message || "error") +
              "). Can you help?"
          );
        }
      };
    });
  }

  /** Called every time the Repairs tab is shown. */
  window.__aoLoadOps = function () {
    load(false);
    // After a beat (so panel paints), open agent with staged prompt
    setTimeout(function () {
      if (!hasSession()) return;
      // Only auto-open when this tab is actually active
      var panel = document.getElementById("panelOps");
      if (panel && !panel.classList.contains("active")) return;
      openAgentWithPrompt(stagedPrompt(STATE.data));
    }, 280);
  };

  window.__aoOpsGoto = function (sub) {
    if (sub === "resources") {
      location.hash = "#resources";
      return;
    }
    if (location.hash !== "#ops") location.hash = "#ops";
    else window.__aoLoadOps();
  };

  // Soft-refresh hook after agent writes contacts / tickets
  window.__aoRefreshRepairs = function () {
    load(true);
  };
})();
