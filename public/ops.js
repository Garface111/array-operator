/* Repairs Command Center — battle cards for parallel repair pipelines.
 * Pipeline: detect fault → draft outreach → coordinate with tech → verify → close.
 * Data: /v1/array-owners/ops*  ·  hash #ops / #claims / #repairs
 */
(function () {
  "use strict";

  var STATE = {
    data: null,
    sub: "command", // command | team | settings
    expanded: null,
    checkins: {},
    arrays: [],
    busy: false,
    loadGen: 0,
    bgReconcileAt: 0,
    showClosed: false,
  };

  var CACHE_KEY = "ao_ops_cache_v2";
  var FETCH_MS = 20000;

  var SUBS = ["command", "team", "settings"];
  var SUB_LABELS = {
    command: "Command",
    team: "Team",
    settings: "Settings",
  };

  var PIPELINE = [
    { id: "detected", label: "Detected" },
    { id: "draft_ready", label: "Drafted" },
    { id: "coordinating", label: "Coordinating" },
    { id: "scheduled", label: "Scheduled" },
    { id: "in_progress", label: "In progress" },
    { id: "closed", label: "Closed" },
  ];

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

  function toast(msg) {
    var el = document.getElementById("opsToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "opsToast";
      el.className = "ops-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.remove("on");
    }, 3200);
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
      if (e && e.name === "AbortError") {
        throw new Error("Request timed out — try Refresh");
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function applyData(d) {
    if (!d) return;
    STATE.data = d;
    if (d.arrays && d.arrays.length) {
      STATE.arrays = d.arrays;
    } else {
      try {
        if (window.FleetStore && FleetStore.snapshot) {
          var snap = FleetStore.snapshot();
          if (snap && snap.arrays && snap.arrays.length)
            STATE.arrays = snap.arrays;
        }
      } catch (e) {}
    }
    writeCache(d);
    render();
  }

  function bgReconcile() {
    var now = Date.now();
    if (now - (STATE.bgReconcileAt || 0) < 5 * 60 * 1000) return;
    STATE.bgReconcileAt = now;
    api("/v1/array-owners/ops/reconcile", { method: "POST", timeoutMs: 90000 })
      .then(function (r) {
        if (
          r &&
          r.ok &&
          ((r.opened || 0) > 0 || (r.closed || 0) > 0)
        ) {
          return api("/v1/array-owners/ops?reconcile_first=0", {
            timeoutMs: FETCH_MS,
          });
        }
        return null;
      })
      .then(function (d) {
        if (d && d.ok !== false && (d.tickets || d.active_cases)) applyData(d);
        else if (d && d.tickets) applyData(d);
      })
      .catch(function () {});
  }

  async function load(force) {
    var el = root();
    if (!el) return;
    if (!hasSession()) {
      el.innerHTML =
        '<div class="ops-empty"><b>Sign in to use Repairs</b>' +
        "EnergyAgent detects dead or faulted inverters, drafts outreach to your repair team, " +
        "coordinates the visit, and closes the case when live vendor data shows the fix. " +
        'Rates &amp; news: <a class="ops-link" href="#resources">Resources</a>.</div>';
      return;
    }

    if (!STATE.data) {
      var cached = readCache();
      if (cached) {
        STATE.data = cached;
        if (cached.arrays && cached.arrays.length) STATE.arrays = cached.arrays;
        render();
      }
    }

    if (STATE.busy && !force) return;
    var gen = ++STATE.loadGen;
    STATE.busy = true;
    if (!STATE.data) {
      el.innerHTML =
        '<div class="empty" style="padding:28px 0;color:var(--faint)">Loading command center…</div>';
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
      if (STATE.data) {
        toast(e.message || "Refresh failed");
        render();
      } else {
        el.innerHTML =
          '<div class="ops-empty"><b>Couldn\'t load Repairs</b>' +
          esc(e.message || e) +
          '<div style="margin-top:12px"><button type="button" class="ops-btn primary" id="opsRetryLoad">Retry</button></div></div>';
        var btn = document.getElementById("opsRetryLoad");
        if (btn)
          btn.onclick = function () {
            load(true);
          };
      }
    } finally {
      if (gen === STATE.loadGen) STATE.busy = false;
    }
  }

  function setSub(name) {
    if (SUBS.indexOf(name) < 0) name = "command";
    // legacy deep-links
    if (name === "repairs" || name === "claims") name = "command";
    STATE.sub = name;
    try {
      if (location.hash === "#claims" || location.hash === "#repairs") {
        if (location.hash !== "#ops") history.replaceState({}, "", "#ops");
      }
    } catch (e) {}
    render();
  }

  function ensureShell(el) {
    if (el.querySelector(".ops-wrap")) return;
    el.innerHTML =
      '<div class="ops-wrap">' +
      '<div id="opsChrome"></div>' +
      '<div id="opsBody"></div>' +
      "</div>";
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

  function activeCases(d) {
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

  function renderChrome(d) {
    var chrome = document.getElementById("opsChrome");
    if (!chrome) return;
    var sum = (d && d.summary) || {};
    var active = d ? activeCases(d) : [];
    var html = "";
    html += '<div class="ops-head"><div>';
    html += "<h2>Repairs</h2>";
    html +=
      '<div class="ops-sub">Command center — EnergyAgent detects faults, drafts outreach, coordinates your tech, and closes cases when hardware recovers. Multiple cases run in parallel.</div>';
    html += '</div><div class="ops-kpis" id="opsKpis">';
    if (d) {
      html += kpi(active.length, "Active cases", active.length ? "warn" : "good");
      html += kpi(
        sum.awaiting_reply || 0,
        "Awaiting tech",
        sum.awaiting_reply ? "warn" : ""
      );
      html += kpi(
        sum.overdue_checkin || 0,
        "Overdue follow-up",
        sum.overdue_checkin ? "bad" : ""
      );
      html += kpi(
        (d.recently_closed || []).length ||
          (d.tickets || []).filter(function (t) {
            return t.status === "resolved";
          }).length,
        "Recently closed",
        "good"
      );
    }
    html += "</div></div>";
    html += '<div class="ops-seg" role="tablist" aria-label="Repairs sections">';
    SUBS.forEach(function (s) {
      html +=
        '<button type="button" class="ops-seg-btn' +
        (STATE.sub === s ? " on" : "") +
        '" data-ops-sub="' +
        s +
        '">' +
        SUB_LABELS[s] +
        "</button>";
    });
    html += "</div>";
    chrome.innerHTML = html;
    chrome.querySelectorAll("[data-ops-sub]").forEach(function (b) {
      b.onclick = function () {
        setSub(b.getAttribute("data-ops-sub"));
      };
    });
  }

  function kpi(n, label, cls) {
    return (
      '<div class="ops-kpi ' +
      (cls || "") +
      '"><b>' +
      esc(n) +
      "</b><span>" +
      esc(label) +
      "</span></div>"
    );
  }

  function pipelineHtml(t) {
    var stage = t.pipeline_stage || "detected";
    var stages = t.pipeline_stages || PIPELINE;
    var idx = typeof t.pipeline_index === "number" ? t.pipeline_index : 0;
    var html = '<div class="bc-pipe" aria-label="Repair pipeline">';
    stages.forEach(function (s, i) {
      if (s.id === "closed" && stage !== "closed") return; // hide closed until done
      var done = i < idx || stage === "closed";
      var on = s.id === stage;
      html +=
        '<div class="bc-pipe-step' +
        (on ? " on" : "") +
        (done && !on ? " done" : "") +
        '"><i></i><span>' +
        esc(s.label) +
        "</span></div>";
    });
    html += "</div>";
    return html;
  }

  function battleCard(t) {
    var open = STATE.expanded === t.id;
    var draft = t.draft_checkin || {};
    var stage = t.pipeline_stage || "detected";
    var contact = t.contact;
    var diagnosis =
      t.diagnosis ||
      (t.evidence && (t.evidence.diagnosis || t.evidence.why)) ||
      t.title ||
      "Hardware issue";
    var html = "";
    html +=
      '<article class="bc-card ' +
      esc(stage) +
      " sev-" +
      esc(t.severity || "critical") +
      (open ? " open" : "") +
      '" data-ticket="' +
      t.id +
      '">';

    // Header
    html += '<header class="bc-head">';
    html += '<div class="bc-head-main">';
    html +=
      '<div class="bc-site">' +
      esc(t.site_name || "Site") +
      "</div>";
    html += '<div class="bc-inv">';
    if (t.inv_name || t.serial)
      html += esc(t.inv_name || t.serial);
    if (t.vendor)
      html +=
        ' <span class="bc-vendor">' + esc(String(t.vendor).toUpperCase()) + "</span>";
    if (t.fail_type)
      html +=
        ' <span class="ops-pill ' +
        esc(t.fail_type) +
        '">' +
        esc(t.fail_type) +
        "</span>";
    html += "</div></div>";
    html +=
      '<div class="bc-stage-badge">' +
      esc(t.pipeline_label || stage) +
      "</div>";
    html += "</header>";

    html += pipelineHtml(t);

    // Diagnosis
    html += '<div class="bc-diagnosis">';
    html += '<div class="bc-label">Diagnosis</div>';
    html += "<p>" + esc(diagnosis) + "</p>";
    if (t.evidence && t.evidence.peer_index != null) {
      html +=
        '<div class="bc-meta">Peer index ' +
        esc(t.evidence.peer_index) +
        (t.evidence.window_kwh != null
          ? " · " + esc(t.evidence.window_kwh) + " kWh window"
          : "") +
        "</div>";
    }
    html += "</div>";

    // Tech
    html += '<div class="bc-tech">';
    html += '<div class="bc-label">Repair team</div>';
    if (contact) {
      html +=
        "<div><b>" +
        esc(contact.name) +
        "</b>" +
        (contact.company ? " · " + esc(contact.company) : "") +
        "</div>";
      html += '<div class="bc-meta">';
      if (contact.email) html += esc(contact.email);
      if (contact.phone)
        html +=
          (contact.email ? " · " : "") +
          '<a class="ops-link" href="tel:' +
          esc(contact.phone) +
          '">' +
          esc(contact.phone) +
          "</a>";
      html += "</div>";
    } else {
      html +=
        '<div class="bc-meta warn">No contact assigned — add one on the Team tab so EnergyAgent can draft outreach.</div>';
    }
    html += "</div>";

    // Draft outreach
    if (draft && draft.body && stage !== "closed") {
      html += '<div class="bc-draft">';
      html += '<div class="bc-label">Auto-drafted outreach</div>';
      html +=
        '<div class="bc-draft-to">To: <b>' +
        esc(draft.to || (contact && contact.email) || "—") +
        "</b></div>";
      html +=
        '<div class="bc-draft-sub">' +
        esc(draft.subject || "") +
        "</div>";
      html +=
        '<pre class="bc-draft-body' +
        (open ? " full" : "") +
        '">' +
        esc(draft.body) +
        "</pre>";
      if (!open) {
        html +=
          '<button type="button" class="ops-link bc-expand-draft" data-ops-expand="' +
          t.id +
          '">Show full draft</button>';
      }
      html += "</div>";
    }

    // Next action line
    html +=
      '<div class="bc-next">' +
      esc(t.next_action || "Review case") +
      "</div>";

    // Actions
    html += '<div class="bc-actions">';
    if (stage === "draft_ready" || stage === "detected") {
      html +=
        '<button type="button" class="ops-btn primary" data-ops-checkin="' +
        t.id +
        '" ' +
        (!contact || !contact.email ? "disabled title=\"Add a contact with email first\"" : "") +
        ">✓ Approve &amp; send</button>";
    } else if (stage === "coordinating" || stage === "scheduled" || stage === "in_progress") {
      html +=
        '<button type="button" class="ops-btn primary" data-ops-checkin="' +
        t.id +
        '">Send follow-up</button>';
    }
    if (contact && contact.phone) {
      html +=
        '<a class="ops-btn" href="tel:' +
        esc(contact.phone) +
        '">Call</a>';
      html +=
        '<button type="button" class="ops-btn" data-ops-sms="' +
        t.id +
        '">SMS</button>';
    }
    html +=
      '<button type="button" class="ops-btn" data-ops-phone-note="' +
      t.id +
      '">Phone note</button>';
    html +=
      '<button type="button" class="ops-btn" data-ops-note="' +
      t.id +
      '">Log note</button>';
    if (t.status !== "resolved" && t.status !== "cancelled") {
      html +=
        '<button type="button" class="ops-btn" data-ops-resolve="' +
        t.id +
        '">Mark resolved</button>';
    }
    html +=
      '<button type="button" class="ops-btn ghost" data-ops-expand="' +
      t.id +
      '">' +
      (open ? "Hide log" : "Case log") +
      "</button>";
    html += "</div>";

    // Expanded check-in history
    if (open) {
      html += '<div class="bc-detail">';
      var ch = STATE.checkins[t.id];
      if (ch && ch.length) {
        html += '<div class="ops-checkins">';
        ch.forEach(function (c) {
          html +=
            '<div class="ops-checkin ' +
            esc(c.channel || "") +
            " " +
            esc(c.direction || "") +
            '"><b>' +
            esc(c.channel) +
            " · " +
            esc(c.direction) +
            "</b> <span class=\"bc-meta\">" +
            esc(relTime(c.created_at) || c.created_at || "") +
            "</span><br>" +
            esc((c.body || "").slice(0, 500)) +
            "</div>";
        });
        html += "</div>";
      } else {
        html +=
          '<button type="button" class="ops-btn ghost" data-ops-load-checkins="' +
          t.id +
          '">Load case history</button>';
      }
      if (t.tech_note) {
        html +=
          '<div class="bc-meta" style="margin-top:8px">Last note: ' +
          esc(t.tech_note) +
          "</div>";
      }
      html += "</div>";
    }

    html += "</article>";
    return html;
  }

  function renderCommand(d) {
    var cases = activeCases(d);
    var activity = d.activity || [];
    var needs = d.sites_needing_repair || [];
    var closed = d.recently_closed || [];
    var contacts = d.contacts || [];

    var html = '<div class="cc-layout">';

    // Main column
    html += '<div class="cc-main">';
    html += '<div class="ops-toolbar">';
    html +=
      '<button type="button" class="ops-btn primary" id="opsOpenTicket">+ Manual case</button>';
    html +=
      '<button type="button" class="ops-btn" id="opsRefresh">Refresh</button>';
    if (!contacts.length) {
      html +=
        '<button type="button" class="ops-btn" data-ops-sub-jump="team">+ Add repair team</button>';
    }
    html +=
      '<span class="ops-meta" style="margin-left:auto">' +
      cases.length +
      " active · parallel pipelines</span>";
    html += "</div>";

    // Needs attention (no ticket yet)
    var unassigned = needs.filter(function (n) {
      return !(n.open_tickets && n.open_tickets.length) && !n.contact;
    });
    if (unassigned.length) {
      html += '<div class="cc-banner warn">';
      html +=
        "<b>Sites need a repair contact</b> — EnergyAgent can open cases once a tech is on the Team tab. ";
      unassigned.slice(0, 4).forEach(function (n) {
        html +=
          '<span class="ops-pill">' +
          esc(n.array_name || "Site") +
          "</span> ";
      });
      html +=
        ' <button type="button" class="ops-link" data-ops-sub-jump="team">Add contact →</button>';
      html += "</div>";
    }

    if (!cases.length) {
      html +=
        '<div class="ops-empty cc-empty"><b>All clear — no active repair cases</b>' +
        "When an inverter goes dead or faults, EnergyAgent opens a case, drafts outreach to your repair team, " +
        "and tracks it here until live vendor data shows the fix. Add a default contact on Team so auto-open works.</div>";
    } else {
      html += '<div class="bc-grid">';
      cases.forEach(function (t) {
        html += battleCard(t);
      });
      html += "</div>";
    }

    if (closed.length) {
      html +=
        '<details class="cc-closed"' +
        (STATE.showClosed ? " open" : "") +
        "><summary>Recently closed (" +
        closed.length +
        ")</summary><div class=\"bc-grid bc-grid-sm\">";
      closed.forEach(function (t) {
        html +=
          '<div class="bc-card closed mini"><div class="bc-site">' +
          esc(t.site_name || "Site") +
          "</div><div class=\"bc-meta\">" +
          esc(t.inv_name || t.serial || "") +
          " · " +
          esc(t.pipeline_label || t.status) +
          " · " +
          esc(relTime(t.resolved_at || t.updated_at)) +
          "</div></div>";
      });
      html += "</div></details>";
    }

    html += "</div>"; // cc-main

    // Activity rail
    html += '<aside class="cc-rail" aria-label="EnergyAgent activity log">';
    html += '<div class="cc-rail-head">';
    html += "<h3>Agent log</h3>";
    html +=
      '<p>What EnergyAgent has already done on your behalf across all open cases.</p>';
    html += "</div>";
    if (!activity.length) {
      html +=
        '<div class="cc-log-empty">No outreach yet. When a case is approved or auto-check-ins fire, every step lands here.</div>';
    } else {
      html += '<ol class="cc-log">';
      activity.slice(0, 40).forEach(function (a) {
        html +=
          '<li class="cc-log-item ' +
          esc(a.channel || "") +
          " " +
          esc(a.direction || "") +
          '">';
        html +=
          '<div class="cc-log-verb">' +
          esc(a.verb || a.summary) +
          "</div>";
        if (a.summary && a.summary !== a.verb) {
          html +=
            '<div class="cc-log-sum">' + esc(a.summary) + "</div>";
        }
        html +=
          '<div class="cc-log-meta">' +
          esc(relTime(a.at) || a.at || "") +
          (a.ticket_id ? " · case #" + a.ticket_id : "") +
          "</div>";
        html += "</li>";
      });
      html += "</ol>";
    }
    html += "</aside>";

    html += "</div>"; // cc-layout
    return html;
  }

  function roleOptions(cur) {
    var roles = [
      ["om", "O&M"],
      ["installer", "Installer"],
      ["electrician", "Electrician"],
      ["technician", "Technician"],
      ["general_contractor", "GC"],
      ["other", "Other"],
    ];
    return roles
      .map(function (r) {
        return (
          '<option value="' +
          r[0] +
          '"' +
          (cur === r[0] ? " selected" : "") +
          ">" +
          r[1] +
          "</option>"
        );
      })
      .join("");
  }

  function renderTeam(d) {
    var contacts = d.contacts || [];
    var assigns = d.assignments || [];
    var html =
      '<div class="ops-toolbar"><button type="button" class="ops-btn primary" id="opsAddContact">+ Add contact</button>' +
      '<span class="ops-meta">Default contact is used when a fault opens and the site has no assignment.</span></div>';
    html += '<div class="ops-grid">';
    if (!contacts.length) {
      html +=
        '<div class="ops-empty"><b>No repair team yet</b>Add your installer or O&amp;M tech. Mark one as default so new cases route automatically.</div>';
    }
    contacts.forEach(function (c) {
      var myAssigns = assigns.filter(function (a) {
        return a.contact_id === c.id;
      });
      html += '<div class="ops-card" data-contact="' + c.id + '">';
      html += '<div class="ops-card-top"><div>';
      html +=
        "<h3>" +
        esc(c.name) +
        (c.is_default
          ? ' <span class="ops-pill ok">default</span>'
          : "") +
        "</h3>";
      html += '<div class="ops-meta">';
      html += "<span>" + esc(c.role || "om") + "</span>";
      if (c.company) html += "<span>" + esc(c.company) + "</span>";
      if (c.email) html += "<span>" + esc(c.email) + "</span>";
      if (c.phone) {
        html +=
          '<span><a class="ops-link" href="tel:' +
          esc(c.phone) +
          '">' +
          esc(c.phone) +
          "</a></span>";
      }
      html += "</div>";
      if (myAssigns.length) {
        html +=
          '<div class="ops-assign-list">Sites: ' +
          myAssigns
            .map(function (a) {
              return (
                esc(a.array_name || "#" + a.array_id) +
                " (" +
                esc(a.kind) +
                ")"
              );
            })
            .join(", ") +
          "</div>";
      }
      html += "</div></div>";
      html += '<div class="ops-actions">';
      html +=
        '<button type="button" class="ops-btn" data-ops-edit-contact="' +
        c.id +
        '">Edit</button>';
      html +=
        '<button type="button" class="ops-btn" data-ops-assign="' +
        c.id +
        '">Assign to site</button>';
      html +=
        '<button type="button" class="ops-btn ghost" data-ops-del-contact="' +
        c.id +
        '">Remove</button>';
      html += "</div></div>";
    });
    html += "</div>";

    html +=
      '<div id="opsContactForm" class="ops-card" style="margin-top:14px;display:none">' +
      '<h3 id="opsContactFormTitle">Add contact</h3>' +
      '<form class="ops-form" id="opsContactFormEl">' +
      '<input type="hidden" name="contact_id" value="">' +
      '<div class="ops-field"><label>Name</label><input name="name" required placeholder="Alex Rivera"></div>' +
      '<div class="ops-row2">' +
      '<div class="ops-field"><label>Company</label><input name="company" placeholder="Green Fix LLC"></div>' +
      '<div class="ops-field"><label>Role</label><select name="role">' +
      roleOptions() +
      "</select></div></div>" +
      '<div class="ops-row2">' +
      '<div class="ops-field"><label>Email</label><input name="email" type="email" placeholder="alex@om.example"></div>' +
      '<div class="ops-field"><label>Phone</label><input name="phone" placeholder="+1 802 555 0100"></div></div>' +
      '<div class="ops-field"><label>Notes</label><textarea name="notes"></textarea></div>' +
      '<label style="font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center">' +
      '<input type="checkbox" name="is_default"> Default contact for unassigned arrays</label>' +
      '<div class="ops-actions"><button type="submit" class="ops-btn primary">Save contact</button>' +
      '<button type="button" class="ops-btn ghost" id="opsContactCancel">Cancel</button></div>' +
      "</form></div>";

    html +=
      '<div id="opsAssignForm" class="ops-card" style="margin-top:14px;display:none">' +
      "<h3>Assign contact to site</h3>" +
      '<form class="ops-form" id="opsAssignFormEl">' +
      '<input type="hidden" name="contact_id" value="">' +
      '<div class="ops-field"><label>Site</label><select name="array_id" required>' +
      (d.arrays || [])
        .map(function (a) {
          return (
            '<option value="' +
            a.id +
            '">' +
            esc(a.name || "#" + a.id) +
            "</option>"
          );
        })
        .join("") +
      '</select></div>' +
      '<div class="ops-field"><label>Kind</label><select name="kind">' +
      '<option value="primary">Primary</option><option value="backup">Backup</option>' +
      "</select></div>" +
      '<div class="ops-actions"><button type="submit" class="ops-btn primary">Assign</button>' +
      '<button type="button" class="ops-btn ghost" id="opsAssignCancel">Cancel</button></div>' +
      "</form></div>";

    return html;
  }

  function opt(v, label, cur) {
    return (
      '<option value="' +
      v +
      '"' +
      (String(cur || "") === v ? " selected" : "") +
      ">" +
      esc(label) +
      "</option>"
    );
  }

  function renderSettings(d) {
    var s = (d && d.settings) || {};
    var html = '<div class="ops-card">';
    html += "<h3>Automation</h3>";
    html +=
      '<p class="ops-meta" style="margin-bottom:12px">How EnergyAgent opens cases and follows up with your repair team.</p>';
    html += '<form class="ops-form" id="opsSettingsForm">';
    html +=
      '<div class="ops-field"><label>Check-in mode</label><select name="checkin_mode">' +
      opt("manual", "Manual — you approve each send", s.checkin_mode) +
      opt("auto", "Auto — EnergyAgent sends on schedule", s.checkin_mode) +
      opt("delay", "Delay — wait then auto-send", s.checkin_mode) +
      opt("off", "Off — drafts only", s.checkin_mode) +
      "</select></div>";
    html +=
      '<div class="ops-field"><label>Check-in interval (hours)</label><input name="checkin_hours" type="number" min="6" max="336" value="' +
      esc(s.checkin_hours || 48) +
      '"></div>';
    html +=
      '<label style="font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center;margin:10px 0">' +
      '<input type="checkbox" name="auto_open"' +
      (s.auto_open !== false ? " checked" : "") +
      "> Auto-open cases when fleet shows dead/fault and a contact is known</label>";
    html +=
      '<div class="ops-actions"><button type="submit" class="ops-btn primary">Save</button></div>';
    html += "</form></div>";
    html +=
      '<p class="ops-meta" style="margin-top:14px">Inbound replies that include <code>[AO-TICKET-#]</code> are logged on the case automatically. Closing is automatic when live vendor data returns to healthy, or you can Mark resolved.</p>';
    return html;
  }

  function render() {
    var el = root();
    if (!el) return;
    ensureShell(el);
    var d = STATE.data;
    renderChrome(d);

    var body = document.getElementById("opsBody");
    if (!body) return;

    if (!d) {
      body.innerHTML =
        '<div class="empty" style="padding:28px 0;color:var(--faint)">Loading command center…</div>';
      return;
    }

    var html = "";
    if (STATE.sub === "team") html = renderTeam(d);
    else if (STATE.sub === "settings") html = renderSettings(d);
    else html = renderCommand(d);

    body.innerHTML = html;
    wire();
  }

  /* ── Dialogs (sky-styled; never window.prompt/confirm) ─────────────────── */
  function opsConfirm(message, opts) {
    opts = opts || {};
    if (window.AODialog && typeof AODialog.confirm === "function") {
      return AODialog.confirm(message, opts);
    }
    return Promise.resolve(window.confirm(message));
  }

  function opsPrompt(message, value, opts) {
    opts = opts || {};
    if (window.AODialog && typeof AODialog.prompt === "function") {
      return AODialog.prompt(message, value || "", opts).then(function (v) {
        return v == null ? null : String(v).trim();
      });
    }
    var r = window.prompt(opts.title || message, value || "");
    return Promise.resolve(r == null ? null : String(r).trim());
  }

  function opsNoteModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (typeof openModal !== "function") {
        opsPrompt(opts.message || "Note", opts.value || "", {
          title: opts.title || "Note",
        }).then(resolve);
        return;
      }
      var settled = false;
      var settle = function (v) {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      openModal({
        title: opts.title || "Note",
        bodyHTML:
          '<p class="ao-dialog-msg" style="margin:0 0 12px;font-size:14px;line-height:1.5;">' +
          esc(opts.message || "Add a note for this case.") +
          "</p>" +
          '<textarea class="ao-input ops-note-ta" rows="5" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:9px;font-size:14px;resize:vertical;">' +
          esc(opts.value || "") +
          "</textarea>",
        footHTML:
          '<button type="button" class="ao-btn ao-btn-ghost" data-act="cancel" style="padding:10px 16px;border:1px solid #cdd7e0;border-radius:9px;background:#fff;cursor:pointer;font-weight:650;">Cancel</button>' +
          '<button type="button" class="ao-btn ao-btn-primary" data-act="save" style="padding:10px 18px;border:0;border-radius:9px;cursor:pointer;font-weight:650;">' +
          esc(opts.confirmLabel || "Save") +
          "</button>",
        onClose: function () {
          settle(null);
        },
        onMount: function (rootEl, close) {
          var ta = rootEl.querySelector(".ops-note-ta");
          var cancelBtn = rootEl.querySelector('[data-act="cancel"]');
          var saveBtn = rootEl.querySelector('[data-act="save"]');
          setTimeout(function () {
            try {
              if (ta) {
                ta.focus();
              }
            } catch (e) {}
          }, 30);
          if (cancelBtn)
            cancelBtn.onclick = function () {
              settle(null);
              close();
            };
          if (saveBtn)
            saveBtn.onclick = function () {
              var v = ta ? String(ta.value || "").trim() : "";
              settle(v || null);
              close();
            };
        },
      });
    });
  }

  function opsOpenTicketModal() {
    return new Promise(function (resolve) {
      if (typeof openModal !== "function") {
        resolve({ arrayId: null, title: "Manual repair ticket" });
        return;
      }
      var arrays = STATE.arrays || [];
      var optsHtml =
        '<option value="">General / no specific site</option>' +
        arrays
          .map(function (a) {
            var id = a.id || a.array_id || "";
            var name = a.name || a.array_name || "Array #" + id;
            return (
              '<option value="' +
              esc(String(id)) +
              '">' +
              esc(name) +
              "</option>"
            );
          })
          .join("");
      var settled = false;
      var settle = function (v) {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      openModal({
        title: "Open repair case",
        bodyHTML:
          '<p class="ao-dialog-msg" style="margin:0 0 14px;font-size:14px;line-height:1.55;">Log a field repair. EnergyAgent will draft outreach once a team contact is assigned.</p>' +
          '<div class="ao-field" style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:11px;font-weight:650;color:#5a6b7b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Site</label>' +
          '<select class="ao-input ops-ticket-array" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:9px;font-size:14px;background:#fff;">' +
          optsHtml +
          "</select></div>" +
          '<div class="ao-field">' +
          '<label style="display:block;font-size:11px;font-weight:650;color:#5a6b7b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Title</label>' +
          '<input class="ao-input ops-ticket-title" type="text" value="Manual repair ticket" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:9px;font-size:14px;">' +
          "</div>",
        footHTML:
          '<button type="button" class="ao-btn ao-btn-ghost" data-act="cancel" style="padding:10px 16px;border:1px solid #cdd7e0;border-radius:9px;background:#fff;cursor:pointer;font-weight:650;">Cancel</button>' +
          '<button type="button" class="ao-btn ao-btn-primary" data-act="create" style="padding:10px 18px;border:0;border-radius:9px;cursor:pointer;font-weight:650;">Open case</button>',
        onClose: function () {
          settle(null);
        },
        onMount: function (rootEl, close) {
          var sel = rootEl.querySelector(".ops-ticket-array");
          var titleIn = rootEl.querySelector(".ops-ticket-title");
          var cancelBtn = rootEl.querySelector('[data-act="cancel"]');
          var createBtn = rootEl.querySelector('[data-act="create"]');
          if (cancelBtn)
            cancelBtn.onclick = function () {
              settle(null);
              close();
            };
          if (createBtn)
            createBtn.onclick = function () {
              settle({
                arrayId:
                  sel && sel.value ? parseInt(sel.value, 10) : null,
                title:
                  (titleIn && titleIn.value.trim()) ||
                  "Manual repair ticket",
              });
              close();
            };
        },
      });
    });
  }

  function wire() {
    var el = root();
    if (!el) return;

    el.querySelectorAll("[data-ops-sub]").forEach(function (b) {
      b.onclick = function () {
        setSub(b.getAttribute("data-ops-sub"));
      };
    });
    el.querySelectorAll("[data-ops-sub-jump]").forEach(function (b) {
      b.onclick = function () {
        setSub(b.getAttribute("data-ops-sub-jump"));
      };
    });

    var refresh = document.getElementById("opsRefresh");
    if (refresh)
      refresh.onclick = function () {
        load(true);
      };

    el.querySelectorAll("[data-ops-expand]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-expand"), 10);
        STATE.expanded = STATE.expanded === id ? null : id;
        if (STATE.expanded && !STATE.checkins[id]) {
          api("/v1/array-owners/ops/tickets/" + id + "/checkins")
            .then(function (r) {
              STATE.checkins[id] = (r && (r.checkins || r.items)) || [];
              render();
            })
            .catch(function () {
              STATE.checkins[id] = [];
              render();
            });
        } else {
          render();
        }
      };
    });

    el.querySelectorAll("[data-ops-load-checkins]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-load-checkins"), 10);
        api("/v1/array-owners/ops/tickets/" + id + "/checkins")
          .then(function (r) {
            STATE.checkins[id] = (r && (r.checkins || r.items)) || [];
            STATE.expanded = id;
            render();
          })
          .catch(function (e) {
            toast(e.message || "Failed");
          });
      };
    });

    el.querySelectorAll("[data-ops-checkin]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-checkin"), 10);
        var t = (STATE.data.tickets || []).find(function (x) {
          return x.id === id;
        });
        var label =
          t && (t.pipeline_stage === "draft_ready" || t.pipeline_stage === "detected")
            ? "Send this outreach to the repair team now?"
            : "Send a follow-up check-in now?";
        var ok = await opsConfirm(label, {
          title: "Approve & send",
          confirmLabel: "Send",
        });
        if (!ok) return;
        b.disabled = true;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/checkin", {
            method: "POST",
            body: "{}",
          });
          toast("Outreach sent");
          load(true);
        } catch (e) {
          toast(e.message || "Send failed");
          b.disabled = false;
        }
      };
    });

    el.querySelectorAll("[data-ops-resolve]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-resolve"), 10);
        var ok = await opsConfirm(
          "Mark this case resolved? EnergyAgent also auto-closes when live data shows the inverter is healthy again.",
          { title: "Mark resolved?", confirmLabel: "Resolve" }
        );
        if (!ok) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id, {
            method: "PATCH",
            body: JSON.stringify({ status: "resolved" }),
          });
          toast("Case resolved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-note]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-note"), 10);
        var note = await opsNoteModal({
          title: "Log note",
          message: "Internal note on case #" + id,
          confirmLabel: "Save note",
        });
        if (!note) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/note", {
            method: "POST",
            body: JSON.stringify({ body: note }),
          });
          toast("Note saved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-phone-note]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-phone-note"), 10);
        var note = await opsNoteModal({
          title: "Phone note",
          message: "What did the tech say?",
          confirmLabel: "Save",
        });
        if (!note) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/phone-note", {
            method: "POST",
            body: JSON.stringify({ body: note }),
          });
          toast("Phone note saved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-sms]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-sms"), 10);
        var t = (STATE.data.tickets || []).find(function (x) {
          return x.id === id;
        });
        var phone = t && t.contact && t.contact.phone;
        if (!phone) {
          toast("No phone on contact");
          return;
        }
        try {
          var r = await api(
            "/v1/array-owners/ops/tickets/" + id + "/sms",
            {
              method: "POST",
              body: JSON.stringify({}),
            }
          );
          if (r && r.sms_uri) {
            window.open(r.sms_uri, "_blank");
          }
          toast(r && r.sent ? "SMS sent" : "Opened SMS app");
          load(true);
        } catch (e) {
          // Fallback: open sms: link
          if (t && t.sms_uri_base) window.location.href = t.sms_uri_base;
          else toast(e.message || "SMS failed");
        }
      };
    });

    var openT = document.getElementById("opsOpenTicket");
    if (openT) {
      openT.onclick = async function () {
        var picked = await opsOpenTicketModal();
        if (!picked) return;
        try {
          await api("/v1/array-owners/ops/tickets", {
            method: "POST",
            body: JSON.stringify({
              array_id: picked.arrayId || null,
              title: picked.title || "Manual repair ticket",
              fail_type: "other",
              source: "manual",
            }),
          });
          toast("Case opened");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    }

    // Team
    var addC = document.getElementById("opsAddContact");
    if (addC) {
      addC.onclick = function () {
        var f = document.getElementById("opsContactForm");
        if (!f) return;
        f.style.display = "block";
        document.getElementById("opsContactFormTitle").textContent =
          "Add contact";
        var form = document.getElementById("opsContactFormEl");
        form.reset();
        form.contact_id.value = "";
      };
    }
    var cancelC = document.getElementById("opsContactCancel");
    if (cancelC) {
      cancelC.onclick = function () {
        document.getElementById("opsContactForm").style.display = "none";
      };
    }
    var formC = document.getElementById("opsContactFormEl");
    if (formC) {
      formC.onsubmit = async function (e) {
        e.preventDefault();
        var fd = new FormData(formC);
        var body = {
          name: fd.get("name"),
          company: fd.get("company") || null,
          role: fd.get("role") || "om",
          email: fd.get("email") || null,
          phone: fd.get("phone") || null,
          notes: fd.get("notes") || null,
          is_default: !!fd.get("is_default"),
        };
        var cid = fd.get("contact_id");
        try {
          if (cid) {
            await api("/v1/array-owners/ops/contacts/" + cid, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
          } else {
            await api("/v1/array-owners/ops/contacts", {
              method: "POST",
              body: JSON.stringify(body),
            });
          }
          toast("Contact saved");
          load(true);
        } catch (err) {
          toast(err.message || "Failed");
        }
      };
    }
    el.querySelectorAll("[data-ops-edit-contact]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-edit-contact"), 10);
        var c = (STATE.data.contacts || []).find(function (x) {
          return x.id === id;
        });
        if (!c) return;
        var f = document.getElementById("opsContactForm");
        f.style.display = "block";
        document.getElementById("opsContactFormTitle").textContent =
          "Edit contact";
        var form = document.getElementById("opsContactFormEl");
        form.contact_id.value = c.id;
        form.name.value = c.name || "";
        form.company.value = c.company || "";
        form.role.value = c.role || "om";
        form.email.value = c.email || "";
        form.phone.value = c.phone || "";
        form.notes.value = c.notes || "";
        form.is_default.checked = !!c.is_default;
        f.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    });
    el.querySelectorAll("[data-ops-del-contact]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-del-contact"), 10);
        var ok = await opsConfirm(
          "They'll be removed from your repair team list.",
          { title: "Remove this contact?", danger: true, confirmLabel: "Remove" }
        );
        if (!ok) return;
        try {
          await api("/v1/array-owners/ops/contacts/" + id, {
            method: "DELETE",
          });
          toast("Contact removed");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });
    el.querySelectorAll("[data-ops-assign]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-assign"), 10);
        var f = document.getElementById("opsAssignForm");
        f.style.display = "block";
        document.getElementById("opsAssignFormEl").contact_id.value = id;
        f.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    });
    var cancelA = document.getElementById("opsAssignCancel");
    if (cancelA) {
      cancelA.onclick = function () {
        document.getElementById("opsAssignForm").style.display = "none";
      };
    }
    var formA = document.getElementById("opsAssignFormEl");
    if (formA) {
      formA.onsubmit = async function (e) {
        e.preventDefault();
        var fd = new FormData(formA);
        try {
          await api("/v1/array-owners/ops/assign", {
            method: "POST",
            body: JSON.stringify({
              contact_id: parseInt(fd.get("contact_id"), 10),
              array_id: parseInt(fd.get("array_id"), 10),
              kind: fd.get("kind") || "primary",
            }),
          });
          toast("Assigned");
          load(true);
        } catch (err) {
          toast(err.message || "Failed");
        }
      };
    }

    // Settings
    var sf = document.getElementById("opsSettingsForm");
    if (sf) {
      sf.onsubmit = async function (e) {
        e.preventDefault();
        var fd = new FormData(sf);
        try {
          await api("/v1/array-owners/ops/settings", {
            method: "POST",
            body: JSON.stringify({
              checkin_mode: fd.get("checkin_mode"),
              checkin_hours: parseInt(fd.get("checkin_hours"), 10),
              auto_open: !!fd.get("auto_open"),
            }),
          });
          toast("Settings saved");
          load(true);
        } catch (err) {
          toast(err.message || "Failed");
        }
      };
    }
  }

  window.__aoLoadOps = function () {
    if (location.hash === "#claims" || location.hash === "#repairs") {
      STATE.sub = "command";
    }
    load(false);
  };

  window.__aoOpsGoto = function (sub) {
    if (sub === "resources") {
      if (location.hash !== "#resources") location.hash = "#resources";
      else if (window.__aoLoadResources) window.__aoLoadResources();
      return;
    }
    if (sub === "team" || sub === "settings") STATE.sub = sub;
    else STATE.sub = "command";
    if (location.hash !== "#ops" && location.hash !== "#claims" && location.hash !== "#repairs") {
      location.hash = "#ops";
    } else {
      render();
      load(false);
    }
  };
})();
