/* ============================================================================
 * Array Operator — Analysis › Operations / Alarms  (analysis-alarms.js)
 *
 * A read-only fleet NOC rollup — PowerTrack's "Operations" alarm badge + per-site
 * alarm list, computed ENTIRELY from ctx.columns (no fetch, no command-center).
 *
 *   1. severity rollup chips (Critical / Warning / Healthy) — click to filter
 *   2. dense alarm list, worst-first, every flagged inverter in the fleet
 *   3. calm "all clear" empty state when nothing is flagged
 *
 * Severity model (mirrors the brief):
 *   critical = status dead | fault
 *   warning  = status underperforming | comm_gap  +  live-dark "ok" inverters
 *              (an ok-status inverter whose ctx.live.liveVerdict() === "dark" now)
 *   healthy  = the rest
 *
 * Honesty (Ford's hard rule): $ impact is ALWAYS an estimate ("~"), shown only
 * when derivable from real fields (peer_index/window_kwh, or nameplate share) —
 * never fabricated. Live-dark uses ctx.live.liveVerdict, not a hand-rolled
 * threshold. Re-renders on every live update; idempotent (rebuild innerHTML).
 * ========================================================================== */
(function () {
  "use strict";

  // ---- persisted filter (module-level so it survives re-renders) -------------
  var selectedSeverity = "all";   // "all" | "critical" | "warning"

  // ---- one-time scoped styles ------------------------------------------------
  function injectCss() {
    if (document.getElementById("analm-css")) return;
    var s = document.createElement("style");
    s.id = "analm-css";
    s.textContent = [
      ".analm-body{padding:14px 16px 16px;}",

      /* rollup chip row */
      ".analm-chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}",
      ".analm-chip{flex:1 1 0;min-width:150px;display:flex;align-items:center;gap:12px;",
      "  padding:11px 14px;border:1px solid var(--line);border-radius:13px;background:var(--card);",
      "  cursor:pointer;text-align:left;transition:border-color .12s,box-shadow .12s,transform .06s;",
      "  position:relative;overflow:hidden;}",
      ".analm-chip:hover{border-color:var(--good);}",
      ".analm-chip:active{transform:translateY(1px);}",
      ".analm-chip.on{box-shadow:0 0 0 2px var(--good) inset;border-color:var(--good);}",
      ".analm-chip[data-sev='critical'].on{box-shadow:0 0 0 2px var(--bad) inset;border-color:var(--bad);}",
      ".analm-chip[data-sev='warning'].on{box-shadow:0 0 0 2px var(--warn) inset;border-color:var(--warn);}",
      ".analm-chip-dot{width:9px;height:9px;border-radius:50%;flex:none;}",
      ".analm-chip-n{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1;color:var(--ink);}",
      ".analm-chip-meta{min-width:0;}",
      ".analm-chip-lbl{font-size:12px;font-weight:680;color:var(--ink);letter-spacing:.01em;}",
      ".analm-chip-sub{font-size:11px;color:var(--faint);margin-top:1px;}",
      ".analm-chip.sev-critical .analm-chip-dot{background:var(--bad);}",
      ".analm-chip.sev-warning  .analm-chip-dot{background:var(--warn);}",
      ".analm-chip.sev-healthy  .analm-chip-dot{background:var(--good);}",
      ".analm-chip.sev-critical .analm-chip-n{color:var(--bad);}",
      ".analm-chip.sev-warning  .analm-chip-n{color:var(--warn);}",

      /* filter hint / clear */
      ".analm-filterbar{display:flex;align-items:center;gap:8px;margin:-4px 0 10px;font-size:12px;color:var(--muted);}",
      ".analm-clear{border:0;background:none;color:var(--good);font-weight:640;cursor:pointer;font-size:12px;padding:2px 4px;}",
      ".analm-clear:hover{text-decoration:underline;}",

      /* alarm list */
      ".analm-list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:13px;overflow:hidden;background:var(--card);}",
      ".analm-row{display:grid;grid-template-columns:4px minmax(0,1.6fr) auto;gap:0 14px;align-items:start;",
      "  padding:11px 14px 11px 0;border-top:1px solid var(--line);position:relative;}",
      ".analm-row:first-child{border-top:0;}",
      ".analm-row:hover{background:var(--bg2);}",
      ".analm-accent{grid-row:1/3;width:4px;align-self:stretch;border-radius:0;}",
      ".analm-row.sev-critical .analm-accent{background:var(--bad);}",
      ".analm-row.sev-warning  .analm-accent{background:var(--warn);}",
      ".analm-main{min-width:0;}",
      ".analm-titleline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}",
      ".analm-site{font-size:13.5px;font-weight:720;color:var(--ink);letter-spacing:-.005em;}",
      ".analm-sep{color:var(--faint);font-size:12px;}",
      ".analm-inv{font-size:13px;font-weight:600;color:var(--ink);}",
      ".analm-model{font-size:11.5px;color:var(--faint);}",
      ".analm-diag{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.4;max-width:74ch;}",
      ".analm-faultcode{display:inline-block;font-size:11px;font-weight:700;color:var(--bad);",
      "  background:rgba(220,38,38,.09);border:1px solid rgba(220,38,38,.22);border-radius:6px;",
      "  padding:1px 6px;margin-top:5px;font-variant-numeric:tabular-nums;}",

      /* badge */
      ".analm-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:720;",
      "  letter-spacing:.02em;padding:3px 9px;border-radius:999px;white-space:nowrap;text-transform:uppercase;}",
      ".analm-badge .d{width:6px;height:6px;border-radius:50%;}",
      ".analm-badge.b-dead   {color:var(--bad); background:rgba(220,38,38,.10);}",
      ".analm-badge.b-fault  {color:var(--bad); background:rgba(220,38,38,.10);}",
      ".analm-badge.b-under  {color:var(--warn);background:rgba(217,119,6,.12);}",
      ".analm-badge.b-comm   {color:var(--sky); background:rgba(8,145,178,.12);}",
      ".analm-badge.b-dark   {color:var(--warn);background:rgba(217,119,6,.12);}",
      ".analm-badge.b-new    {color:var(--sky); background:rgba(8,145,178,.12);}",
      ".analm-badge.b-dead   .d{background:var(--bad);}",
      ".analm-badge.b-fault  .d{background:var(--bad);}",
      ".analm-badge.b-under  .d{background:var(--warn);}",
      ".analm-badge.b-comm   .d{background:var(--sky);}",
      ".analm-badge.b-dark   .d{background:var(--warn);}",
      ".analm-badge.b-new    .d{background:var(--sky);}",

      /* right rail: $ impact + last-seen */
      ".analm-right{text-align:right;white-space:nowrap;padding-top:1px;}",
      ".analm-cost{font-size:13px;font-weight:760;color:var(--ink);font-variant-numeric:tabular-nums;}",
      ".analm-cost .t{font-size:10px;font-weight:640;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:1px;}",
      ".analm-seen{font-size:11px;color:var(--faint);margin-top:6px;font-variant-numeric:tabular-nums;}",

      /* empty / all-clear */
      ".analm-clear-state{display:flex;align-items:center;gap:14px;padding:26px 20px;",
      "  border:1px solid var(--line);border-radius:13px;",
      "  background:linear-gradient(168deg,rgba(37,99,235,.05),rgba(14,165,233,.03));}",
      ".analm-check{width:40px;height:40px;border-radius:50%;flex:none;display:flex;align-items:center;",
      "  justify-content:center;background:rgba(37,99,235,.12);color:var(--good);}",
      ".analm-clear-state h4{margin:0;font-size:15px;font-weight:740;color:var(--ink);}",
      ".analm-clear-state p{margin:3px 0 0;font-size:12.5px;color:var(--muted);}",

      /* count in header */
      ".analm-hcount{font-size:12px;font-weight:680;color:var(--bad);font-variant-numeric:tabular-nums;}",
      ".analm-hcount.zero{color:var(--good);}",

      "@media (max-width:680px){",
      "  .analm-row{grid-template-columns:4px minmax(0,1fr);}",
      "  .analm-right{grid-column:2;text-align:left;margin-top:8px;display:flex;gap:18px;align-items:baseline;}",
      "  .analm-seen{margin-top:0;}",
      "  .analm-chip{min-width:120px;}",
      "}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- severity classification -----------------------------------------------
  // Returns "critical" | "warning" | "healthy" for an inverter, given its array
  // context (peers + daylight) so live-dark can be detected via liveVerdict.
  function severityOf(inv, peers, isDaylight, live) {
    var st = inv.status;
    if (st === "dead" || st === "fault") return "critical";
    if (st === "underperforming" || st === "comm_gap") return "warning";
    // "monitoring" = too new for 14-day grading (no history yet) — the same
    // vocabulary as Hardware's neutral "Monitoring" pill. It matches none of the
    // branches above, so without this it silently counted as "healthy" — a
    // brand-new, never-verified device inflating "All systems nominal" (found
    // live: Paul's West Glover array reads 0W in daylight, only signal is
    // status=monitoring). Never let an unverified device read as graded-healthy.
    if (st === "monitoring") return "warning";
    // live-dark: an ok-status inverter dark right now while peers produce
    if (st === "ok" && live && typeof live.liveVerdict === "function") {
      try {
        if (live.liveVerdict(inv, peers, isDaylight) === "dark") return "warning";
      } catch (e) { /* tolerate nulls — fall through to healthy */ }
    }
    return "healthy";
  }

  // Badge spec per the worst real signal for a row.
  // isDark = live-dark override (ok status, but dark now).
  function badgeFor(inv, isDark) {
    if (isDark && inv.status === "ok") return { cls: "b-dark", label: "Dark now" };
    switch (inv.status) {
      case "dead":           return { cls: "b-dead",  label: "Stopped" };
      case "fault":          return { cls: "b-fault", label: "Fault" };
      case "underperforming":return { cls: "b-under", label: "Underperforming" };
      case "comm_gap":       return { cls: "b-comm",  label: "Gone quiet" };
      case "monitoring":     return { cls: "b-new",   label: "Too new to grade" };
      default:               return { cls: "b-dark",  label: "Dark now" };
    }
  }

  // Pull a vendor fault code out of the diagnosis text if one reads like a code
  // (e.g. "Error 17", "Code F048", "AC-Overvoltage"). Best-effort, honest: only
  // surface when it clearly looks like a code, never invent one.
  function faultCodeFrom(diag) {
    if (!diag) return null;
    var m = diag.match(/\b(?:error|code|fault|err)\s*[:#]?\s*([A-Z]?\-?\d{2,5}[A-Z]?)\b/i);
    if (m) return m[0].trim();
    return null;
  }

  // ---- $ impact estimate (always "~", only when derivable) -------------------
  // Returns a positive dollar number, or null when we can't estimate cleanly.
  function lostDollars(inv, peers, energyRate, windowDays) {
    var rate = (typeof energyRate === "number" && energyRate > 0) ? energyRate : 0.21;
    var days = (typeof windowDays === "number" && windowDays > 0) ? windowDays : 14;

    // underperformer: lost kWh ≈ window_kwh × (1/peer_index − 1), capped sane.
    if (inv.status === "underperforming" &&
        typeof inv.peer_index === "number" && inv.peer_index > 0 && inv.peer_index < 1 &&
        typeof inv.window_kwh === "number" && inv.window_kwh > 0) {
      var shortfall = inv.window_kwh * (1 / inv.peer_index - 1);
      // cap: an underperformer can't have lost more than ~3× what it made (peer_index≥0.25)
      var cap = inv.window_kwh * 3;
      if (shortfall > cap) shortfall = cap;
      var d = shortfall * rate;
      return d >= 0.5 ? d : null;
    }

    // dead / quiet / dark: lost ≈ fair daily share × days down.
    if (inv.status === "dead" || inv.status === "comm_gap" ||
        (inv.status === "ok")) {  // ok here only reached for live-dark rows
      // prefer the array's healthy-peer average daily kWh as the fair share
      var fair = healthyPeerDaily(inv, peers);
      // fall back to nameplate (kW × ~4.2 sun-hours/day) when no peer signal
      if (fair == null && typeof inv.nameplate_kw === "number" && inv.nameplate_kw > 0) {
        fair = inv.nameplate_kw * 4.2;
      }
      if (fair == null || fair <= 0) return null;

      // days down from stale_hours when present; else assume the window for a
      // confirmed-dead inverter, a conservative 1 day for a live-dark blip.
      var daysDown;
      if (typeof inv.stale_hours === "number" && inv.stale_hours > 0) {
        daysDown = inv.stale_hours / 24;
      } else if (inv.status === "dead") {
        daysDown = days;
      } else if (inv.status === "comm_gap") {
        daysDown = 1;       // unknown gap length → conservative single day
      } else {
        daysDown = 0.5;     // live-dark right now → partial day
      }
      // cap at the analysis window — never claim losses beyond what we measure
      if (daysDown > days) daysDown = days;
      var dd = fair * daysDown * rate;
      return dd >= 0.5 ? dd : null;
    }

    return null;
  }

  // Average daily kWh of this inverter's HEALTHY peers (ok status, has window_kwh).
  function healthyPeerDaily(inv, peers) {
    if (!peers || !peers.length) return null;
    var vals = [];
    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (p === inv) continue;
      if (p.status === "ok" && typeof p.window_kwh === "number" && p.window_kwh > 0 &&
          typeof p.nameplate_kw === "number" && p.nameplate_kw > 0) {
        vals.push(p.window_kwh);
      }
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    var med = vals[Math.floor(vals.length / 2)];
    // window_kwh is total over the window — normalize to per-day (14d default upstream)
    var wd = (window.FleetStore && window.FleetStore.WINDOW_DAYS) || 14;
    return med / wd;
  }

  // "last seen" from stale_hours (hours → Xh/Xd ago)
  function lastSeen(inv) {
    if (typeof inv.stale_hours !== "number" || inv.stale_hours <= 0) return null;
    var h = inv.stale_hours;
    if (h < 1) return Math.round(h * 60) + "m ago";
    if (h < 48) return Math.round(h) + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  // ---- collect every flagged inverter across the fleet -----------------------
  function collect(ctx) {
    var cols = ctx.columns || [];
    var out = [];
    var counts = { critical: 0, warning: 0, healthy: 0 };

    cols.forEach(function (col) {
      var peers = col.inverters || [];
      var isDay = col.is_daylight;
      peers.forEach(function (inv) {
        var sev = severityOf(inv, peers, isDay, ctx.live);
        counts[sev]++;
        if (sev === "healthy") return;
        var isDark = (inv.status === "ok");   // only ok-status rows reach warning via live-dark
        out.push({
          sev: sev,
          isDark: isDark,
          col: col,
          inv: inv,
          cost: lostDollars(inv, peers, ctx.energyRate, ctx.windowDays),
          seen: lastSeen(inv)
        });
      });
    });

    // worst-first: critical before warning; within a tier, biggest $ impact first
    var rank = { critical: 0, warning: 1 };
    out.sort(function (a, b) {
      if (rank[a.sev] !== rank[b.sev]) return rank[a.sev] - rank[b.sev];
      return (b.cost || 0) - (a.cost || 0);
    });
    return { rows: out, counts: counts };
  }

  // ---- render ----------------------------------------------------------------
  function render(container, ctx) {
    injectCss();
    var esc = ctx.esc, money = ctx.fmt.money;
    var data = collect(ctx);
    var c = data.counts;
    var totalFlagged = c.critical + c.warning;

    // honor a stale filter selection if its bucket is now empty → reset to all
    if ((selectedSeverity === "critical" && c.critical === 0) ||
        (selectedSeverity === "warning" && c.warning === 0)) {
      selectedSeverity = "all";
    }

    // A cold sign-in's ctx.columns is empty for the exact same shape as a fleet
    // with nothing flagged — without this the panel races FleetStore.load() and
    // paints "All systems nominal" before a single inverter has been checked.
    var notLoadedYet = !ctx.loaded && ctx.columns.length === 0;

    var html = '';
    html += '<div class="an-card">';
    html += '  <div class="an-card-head">';
    html += '    <h3>Operations</h3>';
    html += '    <div class="an-card-sub">' +
            (notLoadedYet
              ? '<span class="analm-hcount">Checking your fleet…</span>'
              : totalFlagged
              ? '<span class="analm-hcount">' + totalFlagged + ' inverter' + (totalFlagged === 1 ? '' : 's') + ' need attention · live + 14-day peer</span>'
              : '<span class="analm-hcount zero">All systems nominal · live + 14-day peer</span>') +
            '</div>';
    html += '  </div>';
    html += '  <div class="analm-body">';

    // ---- rollup chips ----
    html += '<div class="analm-chips">';
    html += chip("critical", "Critical", c.critical, "Stopped or faulted");
    html += chip("warning",  "Warning",  c.warning,  "Underperforming, quiet or dark");
    html += chip("healthy",  "Healthy",  c.healthy,  "Producing as expected");
    html += '</div>';

    // ---- filter bar (only when a filter is active) ----
    if (selectedSeverity !== "all") {
      var fcount = (selectedSeverity === "critical") ? c.critical : c.warning;
      html += '<div class="analm-filterbar">' +
              'Showing ' + fcount + ' ' + esc(selectedSeverity) + ' alarm' + (fcount === 1 ? '' : 's') +
              ' <button class="analm-clear" data-clear="1">Show all</button></div>';
    }

    // ---- list or empty state ----
    if (notLoadedYet) {
      html += loadingState();
    } else if (totalFlagged === 0) {
      html += emptyState();
    } else {
      var visible = data.rows.filter(function (r) {
        return selectedSeverity === "all" || r.sev === selectedSeverity;
      });
      html += '<div class="analm-list">';
      visible.forEach(function (r) { html += rowHtml(r, esc, money); });
      html += '</div>';
    }

    html += '  </div>';   // .analm-body
    html += '</div>';     // .an-card

    container.innerHTML = html;

    // ---- handlers (delegate on container; re-attached each render) ----
    container.onclick = function (e) {
      var chipEl = e.target.closest && e.target.closest(".analm-chip");
      if (chipEl) {
        var sev = chipEl.getAttribute("data-sev");
        if (sev === "healthy") { selectedSeverity = "all"; }   // healthy isn't a filterable list
        else { selectedSeverity = (selectedSeverity === sev) ? "all" : sev; }
        render(container, ctx);
        return;
      }
      if (e.target.closest && e.target.closest("[data-clear]")) {
        selectedSeverity = "all";
        render(container, ctx);
      }
    };
  }

  function chip(sev, label, n, sub) {
    var on = (sev === selectedSeverity) ? " on" : "";
    return '<button class="analm-chip sev-' + sev + on + '" data-sev="' + sev + '">' +
             '<span class="analm-chip-dot"></span>' +
             '<span class="analm-chip-n">' + n + '</span>' +
             '<span class="analm-chip-meta">' +
               '<span class="analm-chip-lbl">' + label + '</span>' +
               '<span class="analm-chip-sub">' + sub + '</span>' +
             '</span>' +
           '</button>';
  }

  function rowHtml(r, esc, money) {
    var inv = r.inv, col = r.col;
    var badge = badgeFor(inv, r.isDark);
    var fault = (inv.status === "fault") ? faultCodeFrom(inv.diagnosis) : null;

    var h = '<div class="analm-row sev-' + r.sev + '">';
    h += '<span class="analm-accent"></span>';

    // main column
    h += '<div class="analm-main">';
    h += '  <div class="analm-titleline">';
    h += '    <span class="analm-site">' + esc(col.array_name || "Site") + '</span>';
    h += '    <span class="analm-sep">›</span>';
    h += '    <span class="analm-inv">' + esc(inv.name || "Inverter") + '</span>';
    if (inv.model) h += '    <span class="analm-model">' + esc(inv.model) + '</span>';
    h += '    <span class="analm-badge ' + badge.cls + '"><span class="d"></span>' + esc(badge.label) + '</span>';
    h += '  </div>';
    if (inv.diagnosis) h += '  <div class="analm-diag">' + esc(inv.diagnosis) + '</div>';
    if (fault) h += '  <div class="analm-faultcode">' + esc(fault) + '</div>';
    h += '</div>';

    // right rail: $ impact (estimate) + last-seen
    h += '<div class="analm-right">';
    if (r.cost != null) {
      h += '<div class="analm-cost"><span class="t">Est. lost</span>~' + esc(money(r.cost)) + '</div>';
    }
    if (r.seen) {
      h += '<div class="analm-seen">Last seen ' + esc(r.seen) + '</div>';
    }
    h += '</div>';

    h += '</div>';
    return h;
  }

  function emptyState() {
    return '<div class="analm-clear-state">' +
             '<span class="analm-check">' +
               '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
               'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
             '</span>' +
             '<div>' +
               '<h4>All clear</h4>' +
               '<p>Every inverter is producing as expected — no active alarms across the fleet.</p>' +
             '</div>' +
           '</div>';
  }

  // Neutral "still checking" — NEVER the green checkmark. A cold sign-in races
  // FleetStore.load(); this is what renders until the first real fleet snapshot
  // lands, so "All clear" is never claimed before anything's actually been checked.
  function loadingState() {
    return '<div class="analm-clear-state analm-loading-state">' +
             '<div>' +
               '<h4>Checking your fleet…</h4>' +
               '<p>Pulling the latest reading from every inverter — this takes a few seconds.</p>' +
             '</div>' +
           '</div>';
  }

  // ---- register --------------------------------------------------------------
  window.AnalysisSections = window.AnalysisSections || [];
  window.AnalysisSections.push({
    id: "alarms",
    title: "Operations",
    order: 40,
    render: render
  });
})();
