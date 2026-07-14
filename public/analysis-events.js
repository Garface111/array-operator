/* ============================================================================
 * Array Operator — Analysis › Event log  (analysis-events.js)
 *
 * PowerTrack's Operations event HISTORY with a lightweight O&M ticket lifecycle.
 *
 * The sibling "Operations" section (order 40) is the LIVE alarm rollup — the
 * fleet's current state, recomputed from ctx.columns every paint. THIS section
 * (order 45, right below it) is the historical, ACTIONABLE ledger: every alert
 * that has fired over time, each a ticket you move open → acknowledged → resolved.
 *
 *   1. status filter chips (All / Open / Acknowledged / Resolved) with counts
 *   2. a dense ledger, newest first — severity dot + badge, site · inverter,
 *      title, the note, created / updated (relative), and a per-row status control
 *   3. resolved rows render dimmed + struck; calm empty state when nothing fired
 *
 * Data — this section fetches its OWN data (it does NOT lean on ctx.columns for
 * the live path):
 *   • signed in  → GET  /v1/array-owners/alert-events           (Bearer so_session)
 *                  PATCH /v1/array-owners/alert-events/{id}  {status,note}
 *     Cached module-level; refetched after a successful status change.
 *   • demo/anon  → SYNTHESIZE sample events from the demo fleet's flagged
 *     inverters (walk ctx.columns). Clearly labelled sample data; status
 *     controls are disabled — we NEVER present demo tickets as a real log.
 *
 * Honesty (Ford's hard rule): the endpoints may not exist in local preview yet
 * (backend ships in parallel) — any non-200 / network error is treated as
 * "no events / log unavailable", never thrown. Demo events are always badged
 * as samples. Timestamps are ISO strings; we parse to ms for ctx.fmt.ago and
 * fall back to the raw string when unparseable. Idempotent: rebuilds innerHTML
 * on every call, re-renders live from the module-level cache.
 * ========================================================================== */
(function () {
  "use strict";

  var SESSION_KEY = "so_session";
  function getSession() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }

  // ---- persisted state (module-level → survives the orchestrator's re-renders) -
  var selectedStatus = "all";      // "all" | "open" | "ack" | "resolved"
  var resolvingId = null;          // event id whose inline resolve-note field is open

  // live-log cache (real, signed-in path only)
  var liveEvents = null;           // null = not fetched yet; [] = fetched, empty
  var liveTried = false;           // we've completed at least one fetch attempt
  var liveUnavailable = false;     // last fetch returned non-200 / errored
  var fetchInFlight = false;
  var patchInFlight = {};          // { [id]: true } — disable a row mid-PATCH

  // ---- one-time scoped styles ------------------------------------------------
  function injectCss() {
    if (document.getElementById("anevents-css")) return;
    var s = document.createElement("style");
    s.id = "anevents-css";
    s.textContent = [
      ".anevents-body{padding:14px 16px 16px;}",

      /* demo sample banner */
      ".anevents-demo{display:flex;align-items:center;gap:9px;margin-bottom:12px;padding:8px 12px;",
      "  border:1px dashed var(--line);border-radius:11px;background:var(--bg2);",
      "  font-size:12px;color:var(--muted);}",
      ".anevents-demo b{color:var(--ink);font-weight:700;}",
      ".anevents-demo .dot{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none;}",

      /* filter chip row */
      ".anevents-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}",
      ".anevents-chip{display:inline-flex;align-items:center;gap:8px;padding:7px 13px;",
      "  border:1px solid var(--line);border-radius:999px;background:var(--card);cursor:pointer;",
      "  font-size:12.5px;font-weight:640;color:var(--muted);transition:border-color .12s,color .12s,box-shadow .12s,transform .06s;}",
      ".anevents-chip:hover{border-color:var(--good);color:var(--ink);}",
      ".anevents-chip:active{transform:translateY(1px);}",
      ".anevents-chip.on{color:var(--ink);border-color:var(--good);box-shadow:0 0 0 2px var(--good) inset;}",
      ".anevents-chip .c{font-variant-numeric:tabular-nums;font-weight:800;color:var(--ink);}",
      ".anevents-chip.on[data-st='open'] .c{color:var(--warn);}",
      ".anevents-chip .st{width:8px;height:8px;border-radius:50%;flex:none;}",
      ".anevents-chip[data-st='open']  .st{background:var(--warn);}",
      ".anevents-chip[data-st='ack']   .st{background:var(--sky);}",
      ".anevents-chip[data-st='resolved'] .st{background:var(--good);}",

      /* ledger */
      ".anevents-list{display:flex;flex-direction:column;border:1px solid var(--line);",
      "  border-radius:13px;overflow:hidden;background:var(--card);}",
      ".anevents-row{display:grid;grid-template-columns:4px minmax(0,1fr) auto;gap:0 14px;",
      "  align-items:start;padding:12px 15px 12px 0;border-top:1px solid var(--line);}",
      ".anevents-row:first-child{border-top:0;}",
      ".anevents-row:hover{background:var(--bg2);}",
      ".anevents-accent{grid-row:1/3;width:4px;align-self:stretch;}",
      ".anevents-row.sev-critical .anevents-accent{background:var(--bad);}",
      ".anevents-row.sev-warning  .anevents-accent{background:var(--warn);}",
      ".anevents-row.sev-info     .anevents-accent{background:var(--sky);}",
      ".anevents-row.is-resolved  .anevents-accent{background:var(--faint);}",

      ".anevents-main{min-width:0;}",
      ".anevents-titleline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}",
      ".anevents-title{font-size:13.5px;font-weight:730;color:var(--ink);letter-spacing:-.005em;}",
      ".anevents-loc{font-size:12.5px;color:var(--muted);margin-top:3px;}",
      ".anevents-loc .site{font-weight:640;color:var(--ink);}",
      ".anevents-loc .sep{color:var(--faint);margin:0 5px;}",
      ".anevents-note{font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.45;max-width:76ch;}",
      ".anevents-times{font-size:11px;color:var(--faint);margin-top:6px;font-variant-numeric:tabular-nums;}",
      ".anevents-times .u{margin-left:10px;}",

      /* resolved rows dimmed + struck */
      ".anevents-row.is-resolved .anevents-title,",
      ".anevents-row.is-resolved .anevents-loc .site{text-decoration:line-through;text-decoration-thickness:1px;}",
      ".anevents-row.is-resolved .anevents-main{opacity:.6;}",

      /* severity badge */
      ".anevents-badge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:720;",
      "  letter-spacing:.03em;padding:3px 9px;border-radius:999px;white-space:nowrap;text-transform:uppercase;}",
      ".anevents-badge .d{width:6px;height:6px;border-radius:50%;}",
      ".anevents-badge.sev-critical{color:var(--bad); background:rgba(220,38,38,.10);}",
      ".anevents-badge.sev-warning {color:var(--warn);background:rgba(217,119,6,.12);}",
      ".anevents-badge.sev-info    {color:var(--sky); background:rgba(8,145,178,.12);}",
      ".anevents-badge.sev-critical .d{background:var(--bad);}",
      ".anevents-badge.sev-warning  .d{background:var(--warn);}",
      ".anevents-badge.sev-info     .d{background:var(--sky);}",

      /* status pill (current lifecycle state) */
      ".anevents-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;",
      "  letter-spacing:.02em;padding:2px 8px;border-radius:6px;white-space:nowrap;}",
      ".anevents-status .d{width:6px;height:6px;border-radius:50%;}",
      ".anevents-status.s-open{color:var(--warn);background:rgba(217,119,6,.10);}",
      ".anevents-status.s-ack {color:var(--sky); background:rgba(8,145,178,.10);}",
      ".anevents-status.s-resolved{color:var(--faint);background:var(--bg2);}",
      ".anevents-status.s-open .d{background:var(--warn);}",
      ".anevents-status.s-ack  .d{background:var(--sky);}",
      ".anevents-status.s-resolved .d{background:var(--faint);}",

      /* right rail: status pill + lifecycle controls */
      ".anevents-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;",
      "  white-space:nowrap;padding-top:1px;}",
      ".anevents-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;}",
      ".anevents-btn{border:1px solid var(--line);background:var(--card);color:var(--ink);",
      "  font-size:11.5px;font-weight:660;padding:5px 11px;border-radius:8px;cursor:pointer;",
      "  transition:border-color .12s,background .12s,transform .06s;}",
      ".anevents-btn:hover{border-color:var(--good);}",
      ".anevents-btn:active{transform:translateY(1px);}",
      ".anevents-btn.primary{border-color:var(--good);color:var(--good);}",
      ".anevents-btn[disabled]{opacity:.5;cursor:default;}",
      ".anevents-btn[disabled]:hover{border-color:var(--line);}",

      /* inline resolve-note editor */
      ".anevents-resolve{grid-column:2/4;margin-top:10px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;}",
      ".anevents-resolve textarea{flex:1 1 240px;min-width:180px;min-height:38px;resize:vertical;",
      "  border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);",
      "  font:inherit;font-size:12.5px;padding:7px 10px;line-height:1.4;}",
      ".anevents-resolve textarea:focus{outline:none;border-color:var(--good);box-shadow:0 0 0 2px var(--good) inset;}",
      ".anevents-resolve .btns{display:flex;gap:7px;}",

      /* empty / unavailable states */
      ".anevents-empty{display:flex;align-items:center;gap:14px;padding:26px 20px;",
      "  border:1px solid var(--line);border-radius:13px;",
      "  background:linear-gradient(168deg,rgba(37,99,235,.05),rgba(14,165,233,.03));}",
      ".anevents-empty .ico{width:38px;height:38px;border-radius:50%;flex:none;display:flex;",
      "  align-items:center;justify-content:center;background:rgba(37,99,235,.12);color:var(--good);}",
      ".anevents-empty h4{margin:0;font-size:15px;font-weight:740;color:var(--ink);}",
      ".anevents-empty p{margin:3px 0 0;font-size:12.5px;color:var(--muted);}",

      /* header count */
      ".anevents-hcount{font-size:12px;font-weight:680;color:var(--muted);font-variant-numeric:tabular-nums;}",
      ".anevents-hcount .open{color:var(--warn);font-weight:760;}",

      "@media (max-width:680px){",
      "  .anevents-row{grid-template-columns:4px minmax(0,1fr);}",
      "  .anevents-right{grid-column:2;align-items:flex-start;margin-top:9px;}",
      "  .anevents-actions{justify-content:flex-start;}",
      "  .anevents-resolve{grid-column:2;}",
      "}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- ISO → ms (for ctx.fmt.ago). null when unparseable so we can show raw ----
  function toMs(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  // ---- lifecycle vocabulary --------------------------------------------------
  var STATUS_LABEL = { open: "Open", ack: "Acknowledged", resolved: "Resolved" };
  function normStatus(st) {
    if (st === "ack" || st === "acknowledged") return "ack";
    if (st === "resolved" || st === "closed") return "resolved";
    return "open";
  }
  function normSeverity(sev) {
    if (sev === "critical") return "critical";
    if (sev === "info") return "info";
    return "warning";
  }

  // ---- live fetch (signed-in) ------------------------------------------------
  function loadEvents(ctx) {
    var s = getSession();
    if (!s) { liveEvents = null; return; }
    if (fetchInFlight) return;
    fetchInFlight = true;
    fetch("/v1/array-owners/alert-events", { headers: { Authorization: "Bearer " + s } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        fetchInFlight = false; liveTried = true;
        if (d && Array.isArray(d.events)) { liveEvents = d.events; liveUnavailable = false; }
        else { liveEvents = liveEvents || []; liveUnavailable = true; }   // non-200/shape → unavailable, keep prior if any
        repaint(ctx);
      })
      .catch(function () {
        fetchInFlight = false; liveTried = true; liveUnavailable = true;
        if (liveEvents == null) liveEvents = [];
        repaint(ctx);
      });
  }

  // PATCH a ticket, then refetch the log on success.
  function patchEvent(ctx, id, status, note) {
    var s = getSession();
    if (!s || patchInFlight[id]) return;
    patchInFlight[id] = true;
    resolvingId = null;
    repaint(ctx);   // reflect the disabled/in-flight state immediately
    var body = { status: status };
    if (note != null) body.note = note;
    fetch("/v1/array-owners/alert-events/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + s },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        delete patchInFlight[id];
        if (d && d.ok) {
          // optimistic local merge so the row updates even before the refetch lands
          if (d.event && Array.isArray(liveEvents)) {
            for (var i = 0; i < liveEvents.length; i++) {
              if (String(liveEvents[i].id) === String(id)) { liveEvents[i] = d.event; break; }
            }
          }
          fetchInFlight = false; loadEvents(ctx);   // refresh from source of truth
        } else {
          repaint(ctx);   // failed silently → leave the ticket as-is, re-enable
        }
      })
      .catch(function () { delete patchInFlight[id]; repaint(ctx); });
  }

  // ---- demo synthesis (anonymous / simulated fleet) --------------------------
  // Walk the demo fleet's flagged inverters and mint a plausible, DETERMINISTIC
  // sample ticket for each. Clearly sample data — controls disabled downstream.
  var DEMO_TITLE = {
    dead: "Inverter stopped",
    fault: "Fault reported",
    underperforming: "Underperforming",
    comm_gap: "Gone quiet"
  };
  function demoSeverity(st) { return (st === "dead" || st === "fault") ? "critical" : "warning"; }
  // deterministic 0..1 from a string seed
  function _h(str) {
    var x = 0; str = String(str);
    for (var i = 0; i < str.length; i++) { x = (x * 31 + str.charCodeAt(i)) >>> 0; }
    return (x % 1000) / 1000;
  }
  function buildDemoEvents(ctx) {
    var cols = ctx.columns || [];
    var out = [];
    var now = Date.now();
    cols.forEach(function (col) {
      (col.inverters || []).forEach(function (inv) {
        var st = inv.status;
        if (st !== "dead" && st !== "fault" && st !== "underperforming" && st !== "comm_gap") return;
        var seed = String(col.array_id) + ":" + (inv.sn || inv.name || "");
        var r = _h(seed);
        // deterministic lifecycle spread: some open, some ack, some resolved
        var status = r < 0.5 ? "open" : (r < 0.78 ? "ack" : "resolved");
        // stagger fake timestamps: created 2h..18d ago, updated between then & now
        var createdMs = now - Math.round((2 + r * 430) * 3600 * 1000);
        var updatedMs = status === "open" ? createdMs
          : createdMs + Math.round((now - createdMs) * (0.4 + _h(seed + "u") * 0.55));
        out.push({
          id: "demo-" + seed,
          array_id: col.array_id,
          array_name: col.array_name || "Site",
          inverter_name: inv.name || "Inverter",
          title: DEMO_TITLE[st] || "Event",
          severity: demoSeverity(st),
          status: status,
          note: inv.diagnosis || "",
          created_at: new Date(createdMs).toISOString(),
          updated_at: new Date(updatedMs).toISOString(),
          _demo: true
        });
      });
    });
    return out;
  }

  // ---- pick the event set for the current mode -------------------------------
  // Returns { events:[…normalized…], demo:bool, unavailable:bool }
  function resolveEvents(ctx) {
    if (ctx.signedIn && !ctx.simulated) {
      var evs = (liveEvents || []).map(normalize);
      return { events: evs, demo: false, unavailable: liveUnavailable && evs.length === 0 };
    }
    // demo / anonymous
    return { events: buildDemoEvents(ctx).map(normalize), demo: true, unavailable: false };
  }
  function normalize(e) {
    return {
      id: e.id,
      array_name: e.array_name,
      inverter_name: e.inverter_name,
      title: e.title || "Event",
      severity: normSeverity(e.severity),
      status: normStatus(e.status),
      note: e.note || "",
      created_at: e.created_at,
      updated_at: e.updated_at,
      createdMs: toMs(e.created_at),
      updatedMs: toMs(e.updated_at),
      _demo: !!e._demo
    };
  }

  // ---- render ----------------------------------------------------------------
  var _lastCtx = null;
  function repaint(ctx) {
    if (!_container || !document.body.contains(_container)) return;
    render(_container, ctx);
  }
  var _container = null;

  function render(container, ctx) {
    injectCss();
    _container = container; _lastCtx = ctx;
    var esc = ctx.esc, ago = ctx.fmt.ago;

    // kick off the live fetch once (per session presence); demo needs no fetch
    if (ctx.signedIn && !ctx.simulated && liveEvents == null && !fetchInFlight) {
      loadEvents(ctx);
    }

    var res = resolveEvents(ctx);
    var all = res.events;
    var canAct = !res.demo && ctx.signedIn;   // status controls only on the real log

    // counts by status
    var counts = { open: 0, ack: 0, resolved: 0 };
    all.forEach(function (e) { counts[e.status]++; });
    var total = all.length;

    // reset a stale filter whose bucket is now empty
    if (selectedStatus !== "all" && counts[selectedStatus] === 0) selectedStatus = "all";

    // newest first (updated, then created); fall back to insertion order
    var sorted = all.slice().sort(function (a, b) {
      var av = a.updatedMs || a.createdMs || 0, bv = b.updatedMs || b.createdMs || 0;
      return bv - av;
    });
    var visible = sorted.filter(function (e) {
      return selectedStatus === "all" || e.status === selectedStatus;
    });

    var html = '';
    html += '<div class="an-card">';
    html += '  <div class="an-card-head">';
    html += '    <h3>Event log</h3>';
    html += '    <div class="an-card-sub"><span class="anevents-hcount">' +
              (total
                ? (counts.open
                    ? '<span class="open">' + counts.open + ' open</span> · ' + total + ' event' + (total === 1 ? '' : 's') + ' · rolling history'
                    : total + ' event' + (total === 1 ? '' : 's') + ' · all handled · rolling history')
                : 'No events yet · opens as issues are detected') +
              '</span></div>';
    html += '  </div>';
    html += '  <div class="anevents-body">';

    if (res.demo) {
      html += '<div class="anevents-demo"><span class="dot"></span>' +
              '<span><b>Sample events</b> — sign in for your live log. These tickets are ' +
              'synthesized from the demo fleet and can\'t be updated.</span></div>';
    }

    // filter chips
    html += '<div class="anevents-chips">';
    html += chip("all", "All", total, false);
    html += chip("open", "Open", counts.open, true);
    html += chip("ack", "Acknowledged", counts.ack, true);
    html += chip("resolved", "Resolved", counts.resolved, true);
    html += '</div>';

    // list / empty / unavailable
    if (total === 0) {
      html += emptyState(res, ctx);
    } else if (visible.length === 0) {
      html += '<div class="anevents-empty"><div class="ico">' + checkSvg() + '</div>' +
              '<div><h4>Nothing here</h4><p>No ' + esc(STATUS_LABEL[selectedStatus] || selectedStatus).toLowerCase() +
              ' events right now. Pick another filter above.</p></div></div>';
    } else {
      html += '<div class="anevents-list">';
      visible.forEach(function (e) { html += rowHtml(e, esc, ago, canAct); });
      html += '</div>';
    }

    html += '  </div>';   // .anevents-body
    html += '</div>';     // .an-card
    container.innerHTML = html;

    wire(container, ctx);
  }

  function chip(st, label, n, dot) {
    var on = (st === selectedStatus) ? " on" : "";
    return '<button class="anevents-chip' + on + '" data-st="' + st + '">' +
             (dot ? '<span class="st"></span>' : '') +
             '<span>' + label + '</span><span class="c">' + n + '</span>' +
           '</button>';
  }

  function rowHtml(e, esc, ago, canAct) {
    var resolved = e.status === "resolved";
    var h = '<div class="anevents-row sev-' + e.severity + (resolved ? ' is-resolved' : '') + '" data-id="' + esc(e.id) + '">';
    h += '<span class="anevents-accent"></span>';

    // main
    h += '<div class="anevents-main">';
    h += '  <div class="anevents-titleline">';
    h += '    <span class="anevents-badge sev-' + e.severity + '"><span class="d"></span>' + esc(e.severity) + '</span>';
    h += '    <span class="anevents-title">' + esc(e.title) + '</span>';
    h += '  </div>';
    h += '  <div class="anevents-loc"><span class="site">' + esc(e.array_name || "Site") + '</span>' +
         '<span class="sep">·</span>' + esc(e.inverter_name || "Inverter") + '</div>';
    if (e.note) h += '  <div class="anevents-note">' + esc(e.note) + '</div>';
    h += '  <div class="anevents-times">' + timeLabel("Opened", e.created_at, e.createdMs, ago, esc);
    if (e.updatedMs !== e.createdMs || e.updated_at !== e.created_at) {
      h += '<span class="u">' + timeLabel("Updated", e.updated_at, e.updatedMs, ago, esc) + '</span>';
    }
    h += '  </div>';
    h += '</div>';

    // right rail: current status pill + lifecycle controls
    h += '<div class="anevents-right">';
    h += '  <span class="anevents-status s-' + e.status + '"><span class="d"></span>' +
         esc(STATUS_LABEL[e.status]) + '</span>';
    if (canAct && !resolved) {
      var busy = !!patchInFlight[e.id];
      h += '  <div class="anevents-actions">';
      if (e.status === "open") {
        h += '<button class="anevents-btn" data-act="ack" ' + (busy ? 'disabled' : '') + '>Acknowledge</button>';
      }
      h += '<button class="anevents-btn primary" data-act="resolve" ' + (busy ? 'disabled' : '') + '>Resolve</button>';
      h += '  </div>';
    }
    h += '</div>';

    // inline resolve-note editor (only for the row currently being resolved)
    if (canAct && !resolved && String(resolvingId) === String(e.id)) {
      h += '<div class="anevents-resolve">' +
             '<textarea data-note placeholder="Resolution note (optional) — what fixed it?"></textarea>' +
             '<div class="btns">' +
               '<button class="anevents-btn primary" data-act="resolve-confirm">Mark resolved</button>' +
               '<button class="anevents-btn" data-act="resolve-cancel">Cancel</button>' +
             '</div>' +
           '</div>';
    }

    h += '</div>';
    return h;
  }

  function timeLabel(prefix, raw, ms, ago, esc) {
    var when = (ms != null) ? ago(ms) : (raw ? esc(raw) : "—");
    return esc(prefix) + ' ' + when;
  }

  function emptyState(res, ctx) {
    var esc = ctx.esc;
    if (res.unavailable) {
      return '<div class="anevents-empty"><div class="ico">' + clockSvg() + '</div>' +
             '<div><h4>Event log unavailable</h4>' +
             '<p>The operations history isn\'t reachable right now. Alerts will appear here once the log is online.</p></div></div>';
    }
    return '<div class="anevents-empty"><div class="ico">' + checkSvg() + '</div>' +
           '<div><h4>No events yet</h4>' +
           '<p>Alerts will appear here as they fire — each one a ticket you can acknowledge and resolve.</p></div></div>';
  }

  function checkSvg() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }
  function clockSvg() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  }

  // ---- events (delegated; re-attached each render) ---------------------------
  function wire(container, ctx) {
    container.onclick = function (e) {
      var t = e.target;
      // filter chip
      var chipEl = t.closest && t.closest(".anevents-chip");
      if (chipEl) {
        var st = chipEl.getAttribute("data-st");
        selectedStatus = st;
        render(container, ctx);
        return;
      }
      // row action button
      var btn = t.closest && t.closest("[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      var row = btn.closest("[data-id]");
      var id = row && row.getAttribute("data-id");
      if (!id) return;

      if (act === "ack") { patchEvent(ctx, id, "ack", null); return; }
      if (act === "resolve") { resolvingId = id; render(container, ctx); return; }
      if (act === "resolve-cancel") { resolvingId = null; render(container, ctx); return; }
      if (act === "resolve-confirm") {
        var ta = row.querySelector("[data-note]");
        var note = ta ? ta.value.trim() : "";
        patchEvent(ctx, id, "resolved", note);   // resolvingId cleared inside patchEvent
        return;
      }
    };
  }

  // ---- register --------------------------------------------------------------
  window.AnalysisSections = window.AnalysisSections || [];
  window.AnalysisSections.push({
    id: "events",
    title: "Event log",
    order: 45,
    render: render
  });
})();
