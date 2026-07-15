/* Ops tab — service contacts, repair tickets, warranty claims, phone/SMS notes.
 * Loads via #ops hash; data from /v1/array-owners/ops* (+ claims). */
(function () {
  "use strict";

  var STATE = {
    data: null,
    sub: "repairs", // repairs | team | claims | settings
    expanded: null,
    checkins: {},
    arrays: [],
    busy: false,
    loadGen: 0,
    bgReconcileAt: 0,
  };

  var CACHE_KEY = "ao_ops_cache_v1";
  var FETCH_MS = 20000; // hard cap — never leave the tab spinning

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
    el._t = setTimeout(function () { el.classList.remove("on"); }, 3200);
  }

  function root() {
    return document.getElementById("opsRoot");
  }

  function hasSession() {
    try { return !!localStorage.getItem("so_session"); } catch (e) { return false; }
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.data) return null;
      // discard after 30 min
      if (o.ts && Date.now() - o.ts > 30 * 60 * 1000) return null;
      return o.data;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  async function api(path, opts) {
    opts = opts || {};
    var ctrl = opts.signal ? null : new AbortController();
    var signal = opts.signal || (ctrl && ctrl.signal);
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () {
        try { ctrl.abort(); } catch (e) {}
      }, opts.timeoutMs || FETCH_MS);
    }
    try {
      var r = await fetch(
        path,
        Object.assign({ headers: authHeaders() }, opts, { signal: signal })
      );
      var d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      if (!r.ok) {
        var err = (d && (d.detail || d.error || d.message)) || ("HTTP " + r.status);
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
          if (snap && snap.arrays && snap.arrays.length) STATE.arrays = snap.arrays;
        }
      } catch (e) {}
    }
    writeCache(d);
    render();
  }

  /** Non-blocking ticket reconcile — never blocks tab paint. */
  function bgReconcile() {
    var now = Date.now();
    // at most once per 5 min per session visit
    if (now - (STATE.bgReconcileAt || 0) < 5 * 60 * 1000) return;
    STATE.bgReconcileAt = now;
    api("/v1/array-owners/ops/reconcile", { method: "POST", timeoutMs: 90000 })
      .then(function (r) {
        if (r && r.ok && ((r.opened || 0) > 0 || (r.closed || 0) > 0)) {
          // silent refresh of list after real changes
          return api("/v1/array-owners/ops?reconcile_first=0", { timeoutMs: FETCH_MS });
        }
        return null;
      })
      .then(function (d) {
        if (d && d.ok) applyData(d);
      })
      .catch(function () { /* ignore — tab already usable */ });
  }

  async function load(force) {
    var el = root();
    if (!el) return;
    if (!hasSession()) {
      // Resources briefing is public; other Operations sub-tabs need auth
      if (STATE.sub === "resources" || location.hash === "#resources") {
        STATE.sub = "resources";
        render();
        return;
      }
      el.innerHTML =
        '<div class="ops-empty"><b>Sign in to use Operations</b>' +
        "Track your O&M team, open repair tickets when sites go down, and check in by email, SMS, or phone. " +
        'Rates &amp; news: open the <button type="button" class="ops-link" id="opsGoResources">Resources</button> sub-tab anytime.</div>';
      var go = document.getElementById("opsGoResources");
      if (go) go.onclick = function () { setSub("resources"); };
      return;
    }

    // Stale-while-revalidate: paint cache immediately so the tab never feels stuck
    if (!STATE.data) {
      var cached = readCache();
      if (cached) {
        STATE.data = cached;
        if (cached.arrays && cached.arrays.length) STATE.arrays = cached.arrays;
        render();
      }
    }

    // Allow overlapping forced refresh; ignore duplicate background loads
    if (STATE.busy && !force) return;
    var gen = ++STATE.loadGen;
    STATE.busy = true;
    if (!STATE.data) {
      el.innerHTML =
        '<div class="empty" style="padding:28px 0;color:var(--faint)">Loading operations…</div>';
    }
    try {
      // FAST path only — no fleet-tree / SolarEdge on tab open
      var d = await api("/v1/array-owners/ops?reconcile_first=0", { timeoutMs: FETCH_MS });
      if (gen !== STATE.loadGen) return; // superseded
      applyData(d);
      // After paint: optional background reconcile (does not block UI)
      bgReconcile();
    } catch (e) {
      if (gen !== STATE.loadGen) return;
      if (STATE.data) {
        // Keep last good view; toast the error
        toast(e.message || "Refresh failed");
        render();
      } else {
        el.innerHTML =
          '<div class="ops-empty"><b>Couldn\'t load Operations</b>' +
          esc(e.message || e) +
          '<div style="margin-top:12px"><button type="button" class="ops-btn primary" id="opsRetryLoad">Retry</button></div></div>';
        var btn = document.getElementById("opsRetryLoad");
        if (btn) btn.onclick = function () { load(true); };
      }
    } finally {
      if (gen === STATE.loadGen) STATE.busy = false;
    }
  }

  var SUBS = ["repairs", "team", "claims", "resources", "settings"];
  var SUB_LABELS = {
    repairs: "Repairs",
    team: "Team",
    claims: "Claims",
    resources: "Resources",
    settings: "Settings",
  };

  function setSub(name) {
    if (SUBS.indexOf(name) < 0) name = "repairs";
    STATE.sub = name;
    // Keep URL honest for deep-links / back button
    try {
      var want =
        name === "resources" ? "#resources"
          : name === "claims" ? "#claims"
            : name === "repairs" ? "#ops"
              : "#ops";
      if (name === "resources" || name === "claims") {
        if (location.hash !== want) {
          history.replaceState({}, "", want);
        }
      } else if (location.hash === "#resources" || location.hash === "#claims" || location.hash === "#repairs") {
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
      // Stable host for Resources — never wiped when other sub-tabs re-render
      '<div id="opsResourcesPane" class="ops-resources-pane" hidden>' +
      '<div id="rsHost"><p class="ao-res-loading">Loading the briefing…</p></div>' +
      "</div></div>";
  }

  function renderChrome(d) {
    var chrome = document.getElementById("opsChrome");
    if (!chrome) return;
    var sum = (d && d.summary) || {};
    var csum = (d && d.warranty_claims && d.warranty_claims.summary) || {};
    var html = "";
    html += '<div class="ops-head"><div>';
    html += "<h2>Operations</h2>";
    html +=
      '<div class="ops-sub">O&amp;M team, field repairs, manufacturer claims, rates &amp; news</div>';
    html += '</div><div class="ops-kpis" id="opsKpis">';
    if (d) {
      html += kpi(sum.open || 0, "Open tickets", sum.open ? "warn" : "good");
      html += kpi(sum.awaiting_reply || 0, "Awaiting reply", sum.awaiting_reply ? "warn" : "");
      html += kpi(sum.overdue_checkin || 0, "Overdue", sum.overdue_checkin ? "bad" : "");
      html += kpi(csum.open || 0, "Open claims", csum.open ? "warn" : "");
    }
    html += "</div></div>";
    html += '<div class="ops-seg" role="tablist">';
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

  function render() {
    var el = root();
    if (!el) return;
    ensureShell(el);
    var d = STATE.data;
    renderChrome(d);

    var body = document.getElementById("opsBody");
    var resPane = document.getElementById("opsResourcesPane");
    if (!body || !resPane) return;

    if (STATE.sub === "resources") {
      body.hidden = true;
      body.innerHTML = "";
      resPane.hidden = false;
      try {
        if (window.__aoLoadResources) window.__aoLoadResources();
      } catch (e) {}
      return;
    }

    resPane.hidden = true;
    body.hidden = false;

    if (!d) {
      body.innerHTML =
        '<div class="empty" style="padding:28px 0;color:var(--faint)">Loading operations…</div>';
      return;
    }

    var html = "";
    if (STATE.sub === "repairs") html = renderRepairs(d);
    else if (STATE.sub === "team") html = renderTeam(d);
    else if (STATE.sub === "claims") html = renderClaims(d);
    else html = renderSettings(d);

    body.innerHTML = html;
    wire();
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

  function renderRepairs(d) {
    var tickets = d.tickets || [];
    var needs = d.sites_needing_repair || [];
    var html = '<div class="ops-toolbar">';
    html += '<button type="button" class="ops-btn primary" id="opsOpenTicket">+ Open ticket</button>';
    html += '<button type="button" class="ops-btn" id="opsRefresh">Refresh</button>';
    html += "</div>";

    if (needs.length) {
      html += '<div class="ops-card" style="margin-bottom:12px">';
      html += "<h3>Sites needing attention</h3>";
      html += '<div class="ops-meta" style="margin-top:8px;display:grid;gap:8px">';
      needs.slice(0, 8).forEach(function (s) {
        html +=
          "<div><b style='color:var(--ink)'>" +
          esc(s.array_name || "Site") +
          "</b> · " +
          esc(s.next_step || "") +
          (s.contact
            ? " · tech: " + esc(s.contact.name)
            : ' · <span style="color:var(--warn)">no contact assigned</span>') +
          "</div>";
      });
      html += "</div></div>";
    }

    if (!tickets.length) {
      html +=
        '<div class="ops-empty"><b>No repair tickets yet</b>Add a service contact on the Team tab. When an inverter goes dead or faults, tickets open automatically if a contact is known.</div>';
      return html;
    }

    html += '<div class="ops-grid">';
    tickets.forEach(function (t) {
      var open = STATE.expanded === t.id;
      var cls = [t.status, t.severity].filter(Boolean).join(" ");
      html += '<div class="ops-card ' + esc(cls) + '" data-ticket="' + t.id + '">';
      html += '<div class="ops-card-top"><div>';
      html += "<h3>" + esc(t.title || "Ticket #" + t.id) + "</h3>";
      html += '<div class="ops-meta">';
      html += '<span class="ops-pill ' + esc(t.status) + '">' + esc(t.status) + "</span>";
      html += '<span class="ops-pill ' + esc(t.fail_type) + '">' + esc(t.fail_type) + "</span>";
      if (t.site_name) html += "<span>" + esc(t.site_name) + "</span>";
      if (t.inv_name || t.serial)
        html += "<span>" + esc(t.inv_name || t.serial) + "</span>";
      if (t.contact) html += "<span>Tech: " + esc(t.contact.name) + "</span>";
      if (t.checkin_count) html += "<span>" + t.checkin_count + " check-in" + (t.checkin_count === 1 ? "" : "s") + "</span>";
      html += "</div>";
      if (t.warranty_claim_id || (t.warranty_claim && t.warranty_claim.id)) {
        var cid = t.warranty_claim_id || t.warranty_claim.id;
        var st = (t.warranty_claim && t.warranty_claim.stage) || "";
        html +=
          '<div class="ops-claim-link">Linked warranty claim #' +
          cid +
          (st ? " · " + esc(st) : "") +
          ' · <a class="ops-link" data-ops-goto-claims="1">view Claims</a></div>';
      }
      html += "</div>";
      html +=
        '<button type="button" class="ops-btn ghost" data-ops-expand="' +
        t.id +
        '">' +
        (open ? "Hide" : "Open") +
        "</button>";
      html += "</div>";

      html += '<div class="ops-actions">';
      html +=
        '<button type="button" class="ops-btn primary" data-ops-checkin="' +
        t.id +
        '">Email check-in</button>';
      if (t.contact && t.contact.phone) {
        html +=
          '<a class="ops-btn" href="tel:' +
          esc(t.contact.phone) +
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
      html += "</div>";

      if (open) {
        html += '<div class="ops-detail">';
        if (t.draft_checkin && t.draft_checkin.body) {
          html += "<div class='ops-meta' style='margin-bottom:6px'>Draft check-in → " + esc(t.draft_checkin.to || "") + "</div>";
          html += "<pre>" + esc(t.draft_checkin.body) + "</pre>";
        }
        if (t.tech_note) {
          html += '<div class="ops-meta" style="margin-top:8px">Last note: ' + esc(t.tech_note) + "</div>";
        }
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
              "</b> " +
              esc(c.created_at || "") +
              "<br>" +
              esc((c.body || "").slice(0, 400)) +
              "</div>";
          });
          html += "</div>";
        } else {
          html +=
            '<button type="button" class="ops-btn ghost" data-ops-load-checkins="' +
            t.id +
            '" style="margin-top:8px">Load check-in history</button>';
        }
        html += "</div>";
      }
      html += "</div>";
    });
    html += "</div>";
    return html;
  }

  function renderTeam(d) {
    var contacts = d.contacts || [];
    var assigns = d.assignments || [];
    var html = '<div class="ops-toolbar"><button type="button" class="ops-btn primary" id="opsAddContact">+ Add contact</button></div>';
    html += '<div class="ops-grid">';
    if (!contacts.length) {
      html +=
        '<div class="ops-empty"><b>No service contacts yet</b>Add your installer, O&amp;M tech, or electrician. Mark one as default so new tickets route automatically.</div>';
    }
    contacts.forEach(function (c) {
      var myAssigns = assigns.filter(function (a) { return a.contact_id === c.id; });
      html += '<div class="ops-card" data-contact="' + c.id + '">';
      html += '<div class="ops-card-top"><div>';
      html += "<h3>" + esc(c.name) + (c.is_default ? ' <span class="ops-pill ok">default</span>' : "") + "</h3>";
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
              return esc(a.array_name || "#" + a.array_id) + " (" + esc(a.kind) + ")";
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
      if (c.phone) {
        html += '<a class="ops-btn" href="tel:' + esc(c.phone) + '">Call</a>';
        html +=
          '<a class="ops-btn" href="sms:' +
          esc(c.phone) +
          '">SMS app</a>';
      }
      html +=
        '<button type="button" class="ops-btn ghost" data-ops-del-contact="' +
        c.id +
        '">Remove</button>';
      html += "</div></div>";
    });
    html += "</div>";

    // Inline form shell
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
      '<div class="ops-field"><label>Phone (SMS / call)</label><input name="phone" placeholder="+1 802 555 0100"></div></div>' +
      '<div class="ops-field"><label>Notes</label><textarea name="notes" placeholder="Covers southern sites weekdays"></textarea></div>' +
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
      '<div class="ops-field"><label>Array</label><select name="array_id" required>' +
      arrayOptions() +
      "</select></div>" +
      '<div class="ops-field"><label>Kind</label><select name="kind"><option value="primary">Primary</option><option value="backup">Backup</option></select></div>' +
      '<div class="ops-actions"><button type="submit" class="ops-btn primary">Assign</button>' +
      '<button type="button" class="ops-btn ghost" id="opsAssignCancel">Cancel</button></div>' +
      "</form></div>";

    return html;
  }

  function roleOptions(sel) {
    var roles = [
      ["om", "O&M"],
      ["installer", "Installer"],
      ["electrician", "Electrician"],
      ["technician", "Technician"],
      ["general_contractor", "General contractor"],
      ["other", "Other"],
    ];
    return roles
      .map(function (r) {
        return (
          '<option value="' +
          r[0] +
          '"' +
          (sel === r[0] ? " selected" : "") +
          ">" +
          r[1] +
          "</option>"
        );
      })
      .join("");
  }

  function arrayOptions() {
    var opts = '<option value="">Select array…</option>';
    (STATE.arrays || []).forEach(function (a) {
      var id = a.id || a.array_id;
      var name = a.name || a.array_name || ("#" + id);
      if (!id) return;
      opts += '<option value="' + id + '">' + esc(name) + "</option>";
    });
    return opts;
  }

  function renderClaims(d) {
    var pack = d.warranty_claims || {};
    var claims = pack.claims || [];
    var html = '<div class="ops-toolbar">';
    html += '<button type="button" class="ops-btn" id="opsRefreshClaims">Refresh claims</button>';
    html +=
      '<span class="ops-meta">Manufacturer warranty paperwork · linked to field repair tickets when an O&amp;M contact exists</span>';
    html += "</div>";
    if (!claims.length) {
      html +=
        '<div class="ops-empty"><b>No warranty claims</b>Dead or faulted inverters open claims automatically. Field repair tickets appear on the Repairs tab and link here.</div>';
      return html;
    }
    html += '<div class="ops-grid">';
    claims.forEach(function (c) {
      html += '<div class="ops-card">';
      html += '<div class="ops-card-top"><div>';
      html +=
        "<h3>" +
        esc(c.site || "Site") +
        " · " +
        esc(c.inv || c.serial || "Inverter") +
        "</h3>";
      html += '<div class="ops-meta">';
      html += '<span class="ops-pill ' + esc(c.stage) + '">' + esc(c.stage) + "</span>";
      html += '<span class="ops-pill ' + esc(c.failType) + '">' + esc(c.failType) + "</span>";
      if (c.vendor) html += "<span>" + esc(c.vendor) + "</span>";
      if (c.serial) html += "<span>" + esc(c.serial) + "</span>";
      html += "</div>";
      if (c.repair_ticket_id) {
        html +=
          '<div class="ops-claim-link">Field repair ticket #' +
          c.repair_ticket_id +
          (c.repair_ticket_status ? " · " + esc(c.repair_ticket_status) : "") +
          ' · <a class="ops-link" data-ops-goto-ticket="' +
          c.repair_ticket_id +
          '">open in Repairs</a></div>';
      } else {
        html +=
          '<div class="ops-meta" style="margin-top:8px">No field ticket linked yet' +
          (STATE.data.contacts && STATE.data.contacts.length
            ? ' · <a class="ops-link" data-ops-ensure-ticket="' + c.id + '">create / link repair ticket</a>'
            : " · add a Team contact first") +
          "</div>";
      }
      html += "</div></div>";
      html += '<div class="ops-actions">';
      if (c.stage === "ready" || c.stage === "queued") {
        html +=
          '<button type="button" class="ops-btn primary" data-ops-send-claim="' +
          c.id +
          '">Send claim</button>';
        html +=
          '<button type="button" class="ops-btn" data-ops-dismiss-claim="' +
          c.id +
          '">Dismiss</button>';
      }
      if (c.stage === "sent") {
        html +=
          '<button type="button" class="ops-btn" data-ops-resolve-claim="' +
          c.id +
          '">Mark resolved</button>';
      }
      if (c.draft && c.draft.body) {
        html +=
          '<button type="button" class="ops-btn ghost" data-ops-show-draft="' +
          c.id +
          '">View draft</button>';
      }
      html += "</div>";
      html +=
        '<div class="ops-detail" id="opsClaimDraft' +
        c.id +
        '" style="display:none"><pre>' +
        esc((c.draft && c.draft.body) || "") +
        "</pre></div>";
      html += "</div>";
    });
    html += "</div>";
    return html;
  }

  function renderSettings(d) {
    var s = d.settings || {};
    var html = '<div class="ops-card"><h3>Check-in policy</h3>';
    html += '<form class="ops-form" id="opsSettingsForm" style="margin-top:12px">';
    html +=
      '<div class="ops-field"><label>Auto check-in mode</label><select name="checkin_mode">' +
      opt("manual", "Manual — draft only, you approve", s.checkin_mode) +
      opt("auto", "Auto — email tech on schedule", s.checkin_mode) +
      opt("delay", "Delay — wait N hours before first send", s.checkin_mode) +
      opt("off", "Off — tickets only, no auto email", s.checkin_mode) +
      "</select></div>";
    html +=
      '<div class="ops-field"><label>Check-in interval (hours)</label><input name="checkin_hours" type="number" min="6" max="336" value="' +
      esc(s.checkin_hours || 48) +
      '"></div>';
    html +=
      '<label style="font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center">' +
      '<input type="checkbox" name="auto_open"' +
      (s.auto_open !== false ? " checked" : "") +
      "> Auto-open tickets when hardware is dead/fault and a contact is known</label>";
    html += '<div class="ops-actions"><button type="submit" class="ops-btn primary">Save ops settings</button></div>';
    html += "</form></div>";

    html += '<div class="ops-card" style="margin-top:12px"><h3>Warranty claim policy</h3>';
    html += '<form class="ops-form" id="opsClaimSettingsForm" style="margin-top:12px">';
    html +=
      '<div class="ops-field"><label>Claim send mode</label><select name="sendMode">' +
      opt("manual", "Manual — approve each manufacturer send", s.claim_send_mode) +
      opt("auto", "Auto — file when confirmed dead/fault", s.claim_send_mode) +
      opt("delay", "Delay — grace hours before auto-file", s.claim_send_mode) +
      "</select></div>";
    html +=
      '<div class="ops-field"><label>Claim grace hours</label><input name="graceHours" type="number" min="1" max="168" value="' +
      esc(s.claim_grace_hours || 24) +
      '"></div>';
    html += '<div class="ops-actions"><button type="submit" class="ops-btn primary">Save claim settings</button></div>';
    html += "</form></div>";
    html +=
      '<p class="ops-meta" style="margin-top:14px">Inbound tech email replies that include <code>[AO-TICKET-#]</code> (or Ticket #N) are parsed automatically and logged on the ticket. SMS uses Twilio when configured; otherwise the SMS button opens your phone\'s messages app.</p>';
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

  /* Sky-styled dialogs — never window.prompt / window.confirm (Chrome-native).
   * Prefer AODialog (app.js) so notes/confirms match the rest of the product glass.
   * Fallbacks only if app.js failed to load. */
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

  /** Multiline note entry (phone / log) — frosted modal + textarea, not a one-liner prompt. */
  function opsNoteModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (typeof openModal !== "function") {
        opsPrompt(opts.message || "", opts.value || "", { title: opts.title || "Note" }).then(resolve);
        return;
      }
      var id = "opsNote" + Date.now();
      var settled = false;
      var settle = function (v) {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      openModal({
        title: opts.title || "Note",
        bodyHTML:
          (opts.message
            ? '<p class="ao-dialog-msg" style="margin:0 0 12px;font-size:14px;line-height:1.55;">' +
              esc(opts.message) +
              "</p>"
            : "") +
          '<div class="ao-field">' +
          '<textarea class="ao-input ops-note-ta" id="' +
          id +
          '" rows="5" placeholder="' +
          esc(opts.placeholder || "") +
          '" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #cdd7e0;border-radius:12px;font-size:14px;line-height:1.5;resize:vertical;min-height:120px;font-family:inherit;">' +
          esc(opts.value || "") +
          "</textarea></div>",
        footHTML:
          '<button type="button" class="ao-btn ao-btn-ghost" data-act="cancel" style="padding:10px 16px;border:1px solid #cdd7e0;border-radius:9px;background:#fff;cursor:pointer;font-weight:650;">Cancel</button>' +
          '<button type="button" class="ao-btn ao-btn-primary" data-act="save" style="padding:10px 18px;border:0;border-radius:9px;cursor:pointer;font-weight:650;">' +
          esc(opts.confirmLabel || "Save note") +
          "</button>",
        onClose: function () {
          settle(null);
        },
        onMount: function (root, close) {
          var ta = root.querySelector("#" + id);
          var cancelBtn = root.querySelector('[data-act="cancel"]');
          var saveBtn = root.querySelector('[data-act="save"]');
          setTimeout(function () {
            try {
              if (ta) {
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
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

  /** Open a repair ticket — pick site + optional title (no free-text substring prompt). */
  function opsOpenTicketModal() {
    return new Promise(function (resolve) {
      if (typeof openModal !== "function") {
        opsPrompt("Array name (substring) or leave blank", "", {
          title: "Open repair ticket",
        }).then(function (name) {
          resolve({ arrayName: name || "", title: "Manual repair ticket" });
        });
        return;
      }
      var arrays = STATE.arrays || [];
      var optsHtml =
        '<option value="">General / no specific site</option>' +
        arrays
          .map(function (a) {
            var id = a.id || a.array_id || "";
            var name = a.name || a.array_name || ("Array #" + id);
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
        title: "Open repair ticket",
        bodyHTML:
          '<p class="ao-dialog-msg" style="margin:0 0 14px;font-size:14px;line-height:1.55;">Log a field repair so your O&amp;M tech can check in by email or SMS.</p>' +
          '<div class="ao-field" style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:11px;font-weight:650;color:#5a6b7b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Site</label>' +
          '<select class="ao-input ops-ticket-array" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:9px;font-size:14px;background:#fff;">' +
          optsHtml +
          "</select></div>" +
          '<div class="ao-field">' +
          '<label style="display:block;font-size:11px;font-weight:650;color:#5a6b7b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Title</label>' +
          '<input class="ao-input ops-ticket-title" type="text" value="Manual repair ticket" placeholder="e.g. Inverter offline — needs site visit" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:9px;font-size:14px;">' +
          "</div>",
        footHTML:
          '<button type="button" class="ao-btn ao-btn-ghost" data-act="cancel" style="padding:10px 16px;border:1px solid #cdd7e0;border-radius:9px;background:#fff;cursor:pointer;font-weight:650;">Cancel</button>' +
          '<button type="button" class="ao-btn ao-btn-primary" data-act="create" style="padding:10px 18px;border:0;border-radius:9px;cursor:pointer;font-weight:650;">Open ticket</button>',
        onClose: function () {
          settle(null);
        },
        onMount: function (root, close) {
          var sel = root.querySelector(".ops-ticket-array");
          var titleIn = root.querySelector(".ops-ticket-title");
          var cancelBtn = root.querySelector('[data-act="cancel"]');
          var createBtn = root.querySelector('[data-act="create"]');
          setTimeout(function () {
            try {
              if (titleIn) {
                titleIn.focus();
                titleIn.select();
              }
            } catch (e) {}
          }, 30);
          if (cancelBtn)
            cancelBtn.onclick = function () {
              settle(null);
              close();
            };
          if (createBtn)
            createBtn.onclick = function () {
              settle({
                arrayId: sel && sel.value ? parseInt(sel.value, 10) : null,
                title: (titleIn && titleIn.value.trim()) || "Manual repair ticket",
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
      b.onclick = function () { setSub(b.getAttribute("data-ops-sub")); };
    });

    var refresh = document.getElementById("opsRefresh");
    if (refresh) refresh.onclick = function () { load(true); };
    var refreshC = document.getElementById("opsRefreshClaims");
    if (refreshC) refreshC.onclick = function () { load(true); };

    el.querySelectorAll("[data-ops-goto-claims]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); setSub("claims"); };
    });
    el.querySelectorAll("[data-ops-goto-ticket]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        STATE.expanded = parseInt(a.getAttribute("data-ops-goto-ticket"), 10);
        setSub("repairs");
      };
    });

    el.querySelectorAll("[data-ops-expand]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.getAttribute("data-ops-expand"), 10);
        STATE.expanded = STATE.expanded === id ? null : id;
        render();
      };
    });

    el.querySelectorAll("[data-ops-load-checkins]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-load-checkins"), 10);
        try {
          var d = await api("/v1/array-owners/ops/tickets/" + id + "/checkins");
          STATE.checkins[id] = d.checkins || [];
          STATE.expanded = id;
          render();
        } catch (e) {
          toast(e.message || "Failed to load check-ins");
        }
      };
    });

    el.querySelectorAll("[data-ops-checkin]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-checkin"), 10);
        var ok = await opsConfirm(
          "We'll email the assigned tech a check-in request for this ticket.",
          { title: "Send email check-in?", confirmLabel: "Send check-in" }
        );
        if (!ok) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/checkin", {
            method: "POST",
            body: "{}",
          });
          toast("Check-in sent");
          load(true);
        } catch (e) {
          toast(e.message || "Send failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-sms]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-sms"), 10);
        try {
          var out = await api("/v1/array-owners/ops/tickets/" + id + "/sms", {
            method: "POST",
            body: "{}",
          });
          if (out.sent_via_twilio) {
            toast("SMS sent via Twilio");
          } else if (out.sms_uri) {
            toast("Opening Messages… (Twilio not configured)");
            window.location.href = out.sms_uri;
          } else {
            toast("SMS drafted");
          }
          load(true);
        } catch (e) {
          toast(e.message || "SMS failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-phone-note]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-phone-note"), 10);
        var note = await opsNoteModal({
          title: "Phone note · ticket #" + id,
          message: "What did you cover on the call?",
          value: "Spoke with tech — ",
          placeholder: "e.g. Spoke with tech — ETA Friday, needs ladder access",
          confirmLabel: "Save phone note",
        });
        if (!note) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/phone-note", {
            method: "POST",
            body: JSON.stringify({ note: note }),
          });
          toast("Phone note saved");
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
          title: "Log note · ticket #" + id,
          message: "Status update for the repair log.",
          value: "",
          placeholder: "e.g. Parts ordered, waiting on SMA RMA #…",
          confirmLabel: "Save note",
        });
        if (!note) return;
        try {
          await api("/v1/array-owners/ops/tickets/" + id + "/note", {
            method: "POST",
            body: JSON.stringify({ note: note }),
          });
          toast("Note saved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

    el.querySelectorAll("[data-ops-resolve]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-resolve"), 10);
        try {
          await api("/v1/array-owners/ops/tickets/" + id, {
            method: "PATCH",
            body: JSON.stringify({ status: "resolved" }),
          });
          toast("Ticket resolved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

    var openT = document.getElementById("opsOpenTicket");
    if (openT) {
      openT.onclick = async function () {
        var picked = await opsOpenTicketModal();
        if (!picked) return;
        var body = {
          fail_type: "other",
          title: picked.title || "Manual repair ticket",
        };
        if (picked.arrayId) body.array_id = picked.arrayId;
        else if (picked.arrayName) body.description = "Array: " + picked.arrayName;
        try {
          await api("/v1/array-owners/ops/tickets", {
            method: "POST",
            body: JSON.stringify(body),
          });
          toast("Ticket opened");
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
        document.getElementById("opsContactFormTitle").textContent = "Add contact";
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
        var payload = {
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
              body: JSON.stringify(payload),
            });
          } else {
            await api("/v1/array-owners/ops/contacts", {
              method: "POST",
              body: JSON.stringify(payload),
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
        var c = (STATE.data.contacts || []).find(function (x) { return x.id === id; });
        if (!c) return;
        var f = document.getElementById("opsContactForm");
        f.style.display = "block";
        document.getElementById("opsContactFormTitle").textContent = "Edit contact";
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
        var ok = await opsConfirm("They'll be removed from your O&M team list.", {
          title: "Remove this contact?",
          danger: true,
          confirmLabel: "Remove",
        });
        if (!ok) return;
        try {
          await api("/v1/array-owners/ops/contacts/" + id, { method: "DELETE" });
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

    // Claims actions
    el.querySelectorAll("[data-ops-send-claim]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-send-claim"), 10);
        var ok = await opsConfirm(
          "This emails the manufacturer claim package for claim #" + id + ".",
          { title: "Send warranty claim?", confirmLabel: "Send claim" }
        );
        if (!ok) return;
        try {
          await api("/v1/array-owners/claims/" + id + "/send", {
            method: "POST",
            body: "{}",
          });
          toast("Claim sent");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });
    el.querySelectorAll("[data-ops-dismiss-claim]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-dismiss-claim"), 10);
        try {
          await api("/v1/array-owners/claims/" + id + "/dismiss", { method: "POST" });
          toast("Claim dismissed");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });
    el.querySelectorAll("[data-ops-resolve-claim]").forEach(function (b) {
      b.onclick = async function () {
        var id = parseInt(b.getAttribute("data-ops-resolve-claim"), 10);
        try {
          await api("/v1/array-owners/claims/" + id + "/resolve", {
            method: "POST",
            body: "{}",
          });
          toast("Claim resolved");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });
    el.querySelectorAll("[data-ops-show-draft]").forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-ops-show-draft");
        var box = document.getElementById("opsClaimDraft" + id);
        if (box) box.style.display = box.style.display === "none" ? "block" : "none";
      };
    });
    el.querySelectorAll("[data-ops-ensure-ticket]").forEach(function (b) {
      b.onclick = async function () {
        var claimId = parseInt(b.getAttribute("data-ops-ensure-ticket"), 10);
        var claim = ((STATE.data.warranty_claims || {}).claims || []).find(function (c) {
          return c.id === claimId;
        });
        if (!claim) return;
        try {
          var t = await api("/v1/array-owners/ops/tickets", {
            method: "POST",
            body: JSON.stringify({
              array_id: claim.array_id || null,
              inverter_id: claim.inverter_id || null,
              fail_type: claim.failType || "dead",
              title:
                "Field repair · " +
                (claim.site || "site") +
                " / " +
                (claim.inv || claim.serial || "inverter"),
            }),
          });
          if (t.ticket && t.ticket.id) {
            await api("/v1/array-owners/ops/tickets/" + t.ticket.id + "/link-claim", {
              method: "POST",
              body: JSON.stringify({ claim_id: claimId }),
            });
          }
          toast("Repair ticket linked");
          load(true);
        } catch (e) {
          toast(e.message || "Failed");
        }
      };
    });

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
          toast("Operations settings saved");
          load(true);
        } catch (err) {
          toast(err.message || "Failed");
        }
      };
    }
    var cf = document.getElementById("opsClaimSettingsForm");
    if (cf) {
      cf.onsubmit = async function (e) {
        e.preventDefault();
        var fd = new FormData(cf);
        try {
          await api("/v1/array-owners/claims/settings", {
            method: "POST",
            body: JSON.stringify({
              sendMode: fd.get("sendMode"),
              graceHours: parseInt(fd.get("graceHours"), 10),
            }),
          });
          toast("Claim settings saved");
          load(true);
        } catch (err) {
          toast(err.message || "Failed");
        }
      };
    }
  }

  window.__aoLoadOps = function () {
    // Resources deep-link can show without waiting on ops API
    if (STATE.sub === "resources" || location.hash === "#resources") {
      STATE.sub = "resources";
      render();
    }
    load(false);
  };

  // Deep-link helpers for Energy Agent / other surfaces
  window.__aoOpsGoto = function (sub) {
    if (sub && SUBS.indexOf(sub) >= 0) STATE.sub = sub;
    var hash =
      STATE.sub === "resources" ? "#resources"
        : STATE.sub === "claims" ? "#claims"
          : "#ops";
    if (location.hash !== hash) {
      location.hash = hash;
    } else {
      // Already on ops — render + ensure data
      render();
      if (STATE.sub !== "resources") load(false);
    }
  };
})();
