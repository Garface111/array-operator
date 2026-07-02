/* ============================================================================
 * Array Operator — Analysis tab › Hardware list  (analysis-hardware.js)
 *
 * PowerTrack's right-hand "Hardware" device tree, adapted HONESTLY to Array
 * Operator's data. PowerTrack enumerates INV/WS/GW/CON/SUB/EMS… because it
 * talks to the plant's own data acquisition hardware. AO's model is portal
 * scraping — it sees INVERTERS (and utility meters, not in this ctx), nothing
 * else. So we show the one device class we genuinely have, group it by site,
 * and state plainly (one quiet note) what the portal model can't see. We never
 * render placeholder WS/GW/EMS rows with fake/zero data to mimic the screenshot.
 *
 * Self-contained: registers on window.AnalysisSections, injects its own scoped
 * <style id="anhw-css"> once, namespaces every class anhw-*. render() is called
 * on first show AND every live FleetStore repaint — it rebuilds container.
 * innerHTML each time (idempotent) and reads which groups are open from a
 * module-level Set so a live re-render never collapses what the user expanded.
 * ========================================================================== */
(function () {
  "use strict";

  // module-level open/closed state, keyed by array_id, survives live re-renders
  var EXPANDED = Object.create(null);   // {array_id: true} once user has toggled
  var TOUCHED = false;                  // has the user toggled anything yet?

  // status → label/tone, mirrors sandbox.js so the pill vocab never drifts
  var STATUS_LABEL = {
    ok: "Pulling its weight", underperforming: "Below its neighbors",
    comm_gap: "Gone quiet", dead: "Not coming home", fault: "Fault",
    monitoring: "Monitoring"
  };
  var STATUS_TONE = {
    ok: "ok", underperforming: "warn", comm_gap: "warn", dead: "bad",
    fault: "bad", monitoring: "info"
  };

  // ---- helpers ---------------------------------------------------------------
  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  // Fronius/SMA/Chint expose only ONE site-level instantaneous power; the backend
  // splits it across inverters by today's energy share — so a per-inverter "kW now"
  // is an ESTIMATE, not a measured per-device reading (data-honesty audit #5). Mirror
  // sandbox.js / vendor-sheet.js: mark the kW "~" + an explanatory tip. The per-inverter
  // `vendor` isn't always populated, so fall back to the site (group) vendor.
  var ALLOC_VENDORS = { fronius: 1, sma: 1, chint: 1 };
  function isAllocatedPower(inv, siteVendor) {
    if (!inv || inv.current_power_w == null) return false;
    var v = String(inv.vendor || siteVendor || "").toLowerCase();
    return !!ALLOC_VENDORS[v];
  }
  function allocTip(inv, siteVendor) {
    var v = String(inv.vendor || siteVendor || "vendor");
    var label = v.charAt(0).toUpperCase() + v.slice(1);
    return label + " reports one site-level power — we split it across inverters by today's energy share, so this per-inverter kW is an estimate.";
  }

  // measured capacity factor % over the analysis window; null when un-computable
  function cfPct(inv, windowDays) {
    var kwh = num(inv.window_kwh), np = num(inv.nameplate_kw), d = num(windowDays);
    if (kwh == null || np == null || !d || np <= 0) return null;
    var denom = np * d * 24;
    if (denom <= 0) return null;
    return (kwh / denom) * 100;
  }

  // per-inverter "last comm" from stale_hours (hours since last reading)
  function commFromHours(h) {
    var v = num(h); if (v == null) return null;
    if (v < 1) return Math.max(0, Math.round(v * 60)) + "m ago";
    if (v < 48) return Math.round(v) + "h ago";
    return Math.round(v / 24) + "d ago";
  }

  // site freshness: prefer the captured sync age, fall back to source feed age
  function siteComm(col) {
    var s = col.sync_status, src = col.source_status;
    if (s && num(s.age_min) != null) {
      var m = Math.round(s.age_min);
      if (m < 60) return m + "m ago";
      if (m < 60 * 48) return Math.round(m / 60) + "h ago";
      return Math.round(m / 60 / 24) + "d ago";
    }
    if (src && num(src.age_hours) != null) {
      var h = src.age_hours;
      if (h < 48) return Math.round(h) + "h ago";
      return Math.round(h / 24) + "d ago";
    }
    return null;
  }

  function invCount(col) {
    var c = num(col.inverter_count);
    if (c != null) return c;
    return Array.isArray(col.inverters) ? col.inverters.length : 0;
  }

  // ---- one-time scoped CSS ---------------------------------------------------
  function ensureCss() {
    if (document.getElementById("anhw-css")) return;
    var st = document.createElement("style");
    st.id = "anhw-css";
    st.textContent = [
      /* device-type summary strip */
      ".anhw-strip{display:flex;align-items:stretch;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line)}",
      ".anhw-chip{display:flex;align-items:center;gap:11px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:9px 13px;min-width:0}",
      ".anhw-chip-ico{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;background:rgba(37,99,235,.12);color:var(--good)}",
      ".anhw-chip-ico svg{width:17px;height:17px;display:block}",
      ".anhw-chip-meta{min-width:0;line-height:1.15}",
      ".anhw-chip-n{font-size:17px;font-weight:760;color:var(--ink);font-variant-numeric:tabular-nums}",
      ".anhw-chip-l{font-size:11.5px;color:var(--muted);font-weight:600}",
      ".anhw-note{display:flex;align-items:center;gap:9px;background:transparent;border:1px dashed var(--line);border-radius:12px;padding:9px 13px;color:var(--faint);font-size:12px;line-height:1.4;max-width:46ch}",
      ".anhw-note svg{width:14px;height:14px;flex:0 0 auto;opacity:.7}",

      /* tree */
      ".anhw-tree{display:flex;flex-direction:column}",
      ".anhw-grp{border-bottom:1px solid var(--line)}",
      ".anhw-grp:last-child{border-bottom:0}",
      ".anhw-ghead{display:flex;align-items:center;gap:12px;width:100%;background:transparent;border:0;text-align:left;padding:12px 18px;cursor:pointer;color:var(--ink);font:inherit}",
      ".anhw-ghead:hover{background:var(--bg2)}",
      ".anhw-chev{flex:0 0 auto;width:14px;height:14px;color:var(--faint);transition:transform .15s ease}",
      ".anhw-grp.open .anhw-chev{transform:rotate(90deg)}",
      ".anhw-gname{font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
      ".anhw-vtag{flex:0 0 auto;font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 7px}",
      ".anhw-gcount{flex:0 0 auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}",
      ".anhw-gspacer{flex:1 1 auto}",
      ".anhw-gcomm{flex:0 0 auto;font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".anhw-gcomm b{font-weight:600;color:var(--muted)}",

      /* inverter rows */
      ".anhw-rows{display:none}",
      ".anhw-grp.open .anhw-rows{display:block}",
      ".anhw-sort{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);padding:6px 18px 6px 44px;background:var(--card2);border-top:1px solid var(--line)}",
      ".anhw-row{display:grid;grid-template-columns:minmax(0,1.6fr) 84px minmax(0,1.5fr) 132px;align-items:center;gap:14px;padding:9px 18px 9px 44px;border-top:1px solid var(--line)}",
      ".anhw-row:hover{background:var(--bg2)}",
      ".anhw-dev{min-width:0;line-height:1.25}",
      ".anhw-dname{font-size:13px;font-weight:640;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".anhw-dmodel{font-size:11px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".anhw-cf{font-variant-numeric:tabular-nums;text-align:right}",
      ".anhw-cf-n{font-size:14px;font-weight:700;color:var(--ink)}",
      ".anhw-cf-l{font-size:10px;color:var(--faint);letter-spacing:.04em;text-transform:uppercase}",
      ".anhw-cf.na .anhw-cf-n{color:var(--faint);font-weight:600}",
      ".anhw-cap{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:0}",
      ".anhw-cap b{color:var(--ink);font-weight:680}",
      ".anhw-cap .anhw-of{color:var(--faint);font-weight:500}",
      ".anhw-end{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}",
      ".anhw-pill{flex:0 0 auto;font-size:11px;font-weight:680;padding:3px 9px;border-radius:999px;white-space:nowrap;border:1px solid transparent}",
      ".anhw-pill.ok{color:var(--good);background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.22)}",
      ".anhw-pill.warn{color:var(--warn);background:rgba(217,119,6,.10);border-color:rgba(217,119,6,.24)}",
      ".anhw-pill.bad{color:var(--bad);background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.24)}",
      ".anhw-pill.info{color:var(--sky);background:rgba(8,145,178,.10);border-color:rgba(8,145,178,.22)}",
      ".anhw-rcomm{flex:0 0 auto;font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:58px;text-align:right}",
      ".anhw-empty{padding:30px 18px;text-align:center;color:var(--muted);font-size:13px}",

      "@media (max-width:760px){",
      "  .anhw-row{grid-template-columns:minmax(0,1fr) 70px;gap:8px 12px;padding-left:38px}",
      "  .anhw-cap{grid-column:1 / -1;padding-left:0}",
      "  .anhw-end{grid-column:1 / -1;justify-content:flex-start}",
      "  .anhw-sort{padding-left:38px}",
      "  .anhw-gcomm{display:none}",
      "}"
    ].join("\n");
    document.head.appendChild(st);
  }

  // ---- svg snippets (no emoji-as-data) --------------------------------------
  var CHEVRON = '<svg class="anhw-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';
  var ICO_INV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3"></path><line x1="13" y1="15" x2="17" y2="15"></line></svg>';
  var ICO_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="7.5" r=".6" fill="currentColor"></circle></svg>';

  // ---- one inverter device row ----------------------------------------------
  function rowHtml(inv, cf, ctx, siteVendor) {
    var esc = ctx.esc, fmt = ctx.fmt;
    var name = esc(inv.name || inv.inverter_id || "Inverter");
    var model = inv.model ? esc(inv.model) : "";

    // capacity factor cell
    var cfCell;
    if (cf == null) {
      cfCell = '<div class="anhw-cf na"><div class="anhw-cf-n">—</div><div class="anhw-cf-l">CF</div></div>';
    } else {
      cfCell = '<div class="anhw-cf"><div class="anhw-cf-n">' + (Math.round(cf * 10) / 10) +
        '%</div><div class="anhw-cf-l">CF</div></div>';
    }

    // live vs capacity. For allocated vendors (Fronius/SMA/Chint) the per-inverter
    // live power is a site-level reading split by energy share — mark it "~" + tip so
    // it never reads as an exact measured per-device value (audit #5).
    var liveKw = fmt.kwFromW(inv.current_power_w);
    var capKw = num(inv.nameplate_kw);
    var alloc = isAllocatedPower(inv, siteVendor);
    var allocTitle = alloc ? ' title="' + esc(allocTip(inv, siteVendor)) + '"' : '';
    var allocMark = alloc ? '~' : '';
    var capCell;
    if (liveKw != null && capKw != null) {
      capCell = '<div class="anhw-cap"' + allocTitle + '><b>' + allocMark + esc(fmt.kw(liveKw)) + '</b> <span class="anhw-of">/ ' +
        esc(fmt.kw(capKw)) + ' cap</span></div>';
    } else if (capKw != null) {
      capCell = '<div class="anhw-cap"><span class="anhw-of">' + esc(fmt.kw(capKw)) + ' capacity</span></div>';
    } else {
      capCell = '<div class="anhw-cap"><span class="anhw-of">—</span></div>';
    }

    // status pill
    var st = String(inv.status || "monitoring");
    var tone = STATUS_TONE[st] || "info";
    var label = STATUS_LABEL[st] || (st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " "));
    var pill = '<span class="anhw-pill ' + tone + '">' + esc(label) + '</span>';

    // per-inverter last comm
    var comm = commFromHours(inv.stale_hours);
    var commCell = comm ? '<span class="anhw-rcomm" title="Last reading">' + esc(comm) + '</span>' : '<span class="anhw-rcomm"></span>';

    return '<div class="anhw-row">' +
      '<div class="anhw-dev"><div class="anhw-dname">' + name + '</div>' +
      (model ? '<div class="anhw-dmodel">' + model + '</div>' : '') + '</div>' +
      cfCell + capCell +
      '<div class="anhw-end">' + pill + commCell + '</div>' +
      '</div>';
  }

  // ---- one site group --------------------------------------------------------
  function groupHtml(col, ctx, open) {
    var esc = ctx.esc;
    var aid = String(col.array_id);
    var invs = Array.isArray(col.inverters) ? col.inverters.slice() : [];

    // sort by capacity factor desc, nulls last (PowerTrack: "Sorted by Capacity Factor")
    var withCf = invs.map(function (inv) { return { inv: inv, cf: cfPct(inv, ctx.windowDays) }; });
    withCf.sort(function (a, b) {
      if (a.cf == null && b.cf == null) return 0;
      if (a.cf == null) return 1;
      if (b.cf == null) return -1;
      return b.cf - a.cf;
    });

    var n = invCount(col);
    var comm = siteComm(col);
    var vendor = col.vendor ? esc(col.vendor) : "";

    var head = '<button type="button" class="anhw-ghead" data-aid="' + esc(aid) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
      CHEVRON +
      '<span class="anhw-gname">' + esc(col.array_name || ("Array " + aid)) + '</span>' +
      (vendor ? '<span class="anhw-vtag">' + vendor + '</span>' : '') +
      '<span class="anhw-gcount">' + n + (n === 1 ? ' inverter' : ' inverters') + '</span>' +
      '<span class="anhw-gspacer"></span>' +
      (comm ? '<span class="anhw-gcomm"><b>Last comm</b> ' + esc(comm) + '</span>' : '') +
      '</button>';

    var rows;
    if (!withCf.length) {
      rows = '<div class="anhw-rows"><div class="anhw-empty">No inverter detail captured for this site yet.</div></div>';
    } else {
      var body = withCf.map(function (x) { return rowHtml(x.inv, x.cf, ctx, col.vendor); }).join("");
      rows = '<div class="anhw-rows"><div class="anhw-sort">Sorted by capacity factor</div>' + body + '</div>';
    }

    return '<div class="anhw-grp' + (open ? ' open' : '') + '" data-grp="' + esc(aid) + '">' + head + rows + '</div>';
  }

  // ---- render (idempotent: full rebuild each call) ---------------------------
  function render(container, ctx) {
    ensureCss();

    var cols = Array.isArray(ctx.columns) ? ctx.columns : [];

    // first paint (user hasn't touched anything): expand all if few sites,
    // else just the first group — keeps a big fleet tidy.
    if (!TOUCHED) {
      if (cols.length <= 3) {
        cols.forEach(function (c) { EXPANDED[String(c.array_id)] = true; });
      } else if (cols.length) {
        EXPANDED[String(cols[0].array_id)] = true;
      }
    }

    var totalInv = cols.reduce(function (s, c) { return s + invCount(c); }, 0);
    var siteWord = cols.length === 1 ? "site" : "sites";

    var strip =
      '<div class="anhw-strip">' +
      '  <div class="anhw-chip">' +
      '    <div class="anhw-chip-ico">' + ICO_INV + '</div>' +
      '    <div class="anhw-chip-meta">' +
      '      <div class="anhw-chip-n">' + ctx.fmt.num(totalInv) + '</div>' +
      '      <div class="anhw-chip-l">Inverters · ' + cols.length + ' ' + siteWord + '</div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="anhw-note">' + ICO_INFO +
      '    <span>Array Operator monitors at the inverter level via the manufacturer portal. ' +
      'String/sub-array monitors, weather stations, gateways and battery/EMS controllers ' +
      'aren’t part of this model.</span>' +
      '  </div>' +
      '</div>';

    var tree;
    if (!cols.length) {
      tree = '<div class="anhw-empty">No arrays connected yet. Once a site syncs, its inverters appear here.</div>';
    } else {
      tree = '<div class="anhw-tree">' + cols.map(function (col) {
        return groupHtml(col, ctx, !!EXPANDED[String(col.array_id)]);
      }).join("") + '</div>';
    }

    container.innerHTML =
      '<div class="an-card">' +
      '  <div class="an-card-head">' +
      '    <h3>Hardware</h3>' +
      '    <span class="an-card-sub">Inverter fleet · grouped by site</span>' +
      '  </div>' +
      strip + tree +
      '</div>';

    // delegate toggle handling (re-bound each render; one listener on container)
    if (container._anhwBound !== true) {
      container.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".anhw-ghead") : null;
        if (!btn || !container.contains(btn)) return;
        var aid = btn.getAttribute("data-aid");
        if (!aid) return;
        TOUCHED = true;
        EXPANDED[aid] = !EXPANDED[aid];
        var grp = btn.parentNode;       // .anhw-grp
        if (grp && grp.classList) {
          grp.classList.toggle("open", !!EXPANDED[aid]);
          btn.setAttribute("aria-expanded", EXPANDED[aid] ? "true" : "false");
        }
      });
      container._anhwBound = true;
    }
  }

  window.AnalysisSections = window.AnalysisSections || [];
  window.AnalysisSections.push({ id: "hardware", title: "Hardware", order: 50, render: render });
})();
