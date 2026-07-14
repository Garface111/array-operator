/* ============================================================================
 * Array Operator — Analysis tab › Hardware list  (analysis-hardware.js)
 *
 * PowerTrack's right-hand "Hardware" device tree, adapted HONESTLY to Array
 * Operator's data. AO's model is portal scraping — it sees INVERTERS, nothing
 * else. Grouped by site; status combines 14-day peer health WITH live feed
 * honesty (a unit Solar.web calls dead must not read "Pulling its weight"
 * just because its 14-day peer index is still fine).
 *
 * Every metric carries an explicit time frame (14d CF, live kW, last reading)
 * so operators never confuse peer health with "right now".
 * ========================================================================== */
(function () {
  "use strict";

  var EXPANDED = Object.create(null);
  var TOUCHED = false;

  // 14-day peer status → label/tone (sandbox vocab)
  var STATUS_LABEL = {
    ok: "Pulling its weight", underperforming: "Below its neighbors",
    comm_gap: "Gone quiet", dead: "Not coming home", fault: "Fault",
    monitoring: "Monitoring"
  };
  var STATUS_TONE = {
    ok: "ok", underperforming: "warn", comm_gap: "warn", dead: "bad",
    fault: "bad", monitoring: "info"
  };

  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  var ALLOC_VENDORS = { fronius: 1, sma: 1, chint: 1 };
  function isAllocatedPower(inv, siteVendor) {
    if (!inv || inv.current_power_w == null) return false;
    var v = String(inv.vendor || siteVendor || "").toLowerCase();
    return !!ALLOC_VENDORS[v];
  }
  function allocTip(inv, siteVendor) {
    var v = String(inv.vendor || siteVendor || "vendor");
    var label = v.charAt(0).toUpperCase() + v.slice(1);
    return label + " reports one site-level power — we split it across inverters by today's energy share, so this per-inverter kW is an estimate (live).";
  }

  function winDays(ctx) {
    var d = num(ctx && ctx.windowDays);
    return (d && d >= 3 && d <= 30) ? d : 14;
  }

  // measured capacity factor % over the analysis window; null when un-computable
  function cfPct(inv, windowDays) {
    var kwh = num(inv.window_kwh), np = num(inv.nameplate_kw), d = num(windowDays);
    if (kwh == null || np == null || !d || np <= 0) return null;
    var denom = np * d * 24;
    if (denom <= 0) return null;
    return (kwh / denom) * 100;
  }

  function commFromHours(h) {
    var v = num(h); if (v == null) return null;
    if (v < 1) return Math.max(0, Math.round(v * 60)) + "m ago";
    if (v < 48) return Math.round(v) + "h ago";
    return Math.round(v / 24) + "d ago";
  }

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

  /**
   * Resolve the status pill: peer (14d) first, then LIVE overlay so a unit that
   * Fronius/Solar.web flags as dead/dark is not green-washed by a healthy
   * 14-day peer index (Ford dogfood 2026-07-13 — Danville Primo #54).
   *
   * Returns { label, tone, basis, tip }
   *   basis: "live" | "peer" | "monitoring"
   */
  function resolveStatus(inv, cohort, col) {
    var peer = String(inv.status || "monitoring");
    var isDay = col && col.is_daylight !== false;
    var peerLabel = STATUS_LABEL[peer] || (peer.charAt(0).toUpperCase() + peer.slice(1).replace(/_/g, " "));
    var peerTone = STATUS_TONE[peer] || "info";
    var peerTip = "14-day peer health vs its neighbors at this site.";

    // Hard peer faults always win (real dead/fault over a brief live blip).
    if (peer === "dead" || peer === "fault") {
      return {
        label: peerLabel, tone: peerTone, basis: "peer",
        tip: peerTip + " Window: last 14 measured days."
      };
    }

    // LIVE overlay via shared FleetStore classifier (same as vendor sheet).
    if (peer === "ok" && cohort && window.FleetStore && FleetStore.liveVerdict) {
      var lv = FleetStore.liveVerdict(inv, cohort, col && col.is_daylight);
      if (lv === "dark") {
        return {
          label: "Dark now", tone: "warn", basis: "live",
          tip: "Producing nothing right now while neighbors are — live anomaly. 14-day peer health is still “ok”; if it stays dark the peer verdict escalates. (Solar.web may already flag this unit.)"
        };
      }
      if (lv === "low") {
        return {
          label: "Low vs peers", tone: "warn", basis: "live",
          tip: "Live output well below neighbors for its nameplate (>15% under peer median). 14-day peer health hasn’t escalated yet."
        };
      }
    }

    // No live reading in daylight while the rest of the site reports power —
    // honest "missing live" rather than green "Pulling its weight".
    var liveW = num(inv.current_power_w);
    if (isDay && liveW == null && peer === "ok" && cohort && cohort.length) {
      var peersLive = cohort.some(function (o) {
        return o && o !== inv && num(o.current_power_w) != null && num(o.current_power_w) > 25;
      });
      if (peersLive) {
        return {
          label: "No live reading", tone: "warn", basis: "live",
          tip: "No instantaneous power from this inverter while others on the same site report live kW. Check Solar.web — the 14-day peer score can still look fine on frozen history."
        };
      }
    }

    // Site feed stale in daylight → don't green-badge healthy peers on a frozen snapshot.
    var src = col && col.source_status;
    if (isDay && src && src.state === "stale" && (peer === "ok" || peer === "monitoring")) {
      return {
        label: "Vendor issue", tone: "warn", basis: "live",
        tip: "Site feed is stale — live readings may not reflect the plant right now. Peer status below is from the last 14 days of history."
      };
    }

    if (peer === "ok") {
      return {
        label: peerLabel, tone: peerTone, basis: "peer",
        tip: peerTip + " Live feed looks fine right now."
      };
    }
    if (peer === "underperforming" || peer === "comm_gap") {
      return {
        label: peerLabel, tone: peerTone, basis: "peer",
        tip: peerTip + " Window: last 14 measured days."
      };
    }
    return {
      label: peerLabel, tone: peerTone, basis: peer === "monitoring" ? "monitoring" : "peer",
      tip: peer === "monitoring"
        ? "Too new for a 14-day peer grade — waiting on enough measured days."
        : peerTip
    };
  }

  function ensureCss() {
    if (document.getElementById("anhw-css")) return;
    var st = document.createElement("style");
    st.id = "anhw-css";
    st.textContent = [
      ".anhw-strip{display:flex;align-items:stretch;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line)}",
      ".anhw-chip{display:flex;align-items:center;gap:11px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:9px 13px;min-width:0}",
      ".anhw-chip-ico{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;background:rgba(37,99,235,.12);color:var(--good)}",
      ".anhw-chip-ico svg{width:17px;height:17px;display:block}",
      ".anhw-chip-meta{min-width:0;line-height:1.15}",
      ".anhw-chip-n{font-size:17px;font-weight:760;color:var(--ink);font-variant-numeric:tabular-nums}",
      ".anhw-chip-l{font-size:11.5px;color:var(--muted);font-weight:600}",
      ".anhw-note{display:flex;align-items:center;gap:9px;background:transparent;border:1px dashed var(--line);border-radius:12px;padding:9px 13px;color:var(--faint);font-size:12px;line-height:1.4;max-width:52ch}",
      ".anhw-note svg{width:14px;height:14px;flex:0 0 auto;opacity:.7}",

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

      ".anhw-rows{display:none}",
      ".anhw-grp.open .anhw-rows{display:block}",
      ".anhw-sort{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);padding:6px 18px 6px 44px;background:var(--card2);border-top:1px solid var(--line)}",
      ".anhw-cols{display:grid;grid-template-columns:minmax(0,1.6fr) 88px minmax(0,1.5fr) minmax(140px,1.1fr);align-items:center;gap:14px;padding:4px 18px 4px 44px;font-size:10px;font-weight:720;letter-spacing:.05em;text-transform:uppercase;color:var(--faint)}",
      ".anhw-row{display:grid;grid-template-columns:minmax(0,1.6fr) 88px minmax(0,1.5fr) minmax(140px,1.1fr);align-items:center;gap:14px;padding:9px 18px 9px 44px;border-top:1px solid var(--line)}",
      ".anhw-row:hover{background:var(--bg2)}",
      ".anhw-row.live-warn{background:rgba(217,119,6,.04)}",
      ".anhw-dev{min-width:0;line-height:1.25}",
      ".anhw-dname{font-size:13px;font-weight:640;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".anhw-dmodel{font-size:11px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".anhw-cf{font-variant-numeric:tabular-nums;text-align:right}",
      ".anhw-cf-n{font-size:14px;font-weight:700;color:var(--ink)}",
      ".anhw-cf-l{font-size:10px;color:var(--faint);letter-spacing:.04em;text-transform:uppercase}",
      ".anhw-cf.na .anhw-cf-n{color:var(--faint);font-weight:600}",
      ".anhw-cap{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:0;line-height:1.3}",
      ".anhw-cap b{color:var(--ink);font-weight:680}",
      ".anhw-cap .anhw-of{color:var(--faint);font-weight:500}",
      ".anhw-cap .anhw-live-tag{display:inline-block;font-size:9.5px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin-left:4px}",
      ".anhw-end{display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:0}",
      ".anhw-end-top{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}",
      ".anhw-pill{flex:0 0 auto;font-size:11px;font-weight:680;padding:3px 9px;border-radius:999px;white-space:nowrap;border:1px solid transparent}",
      ".anhw-pill.ok{color:var(--good);background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.22)}",
      ".anhw-pill.warn{color:var(--warn);background:rgba(217,119,6,.10);border-color:rgba(217,119,6,.24)}",
      ".anhw-pill.bad{color:var(--bad);background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.24)}",
      ".anhw-pill.info{color:var(--sky);background:rgba(8,145,178,.10);border-color:rgba(8,145,178,.22)}",
      ".anhw-basis{font-size:10px;color:var(--faint);font-weight:600;letter-spacing:.02em}",
      ".anhw-rcomm{flex:0 0 auto;font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".anhw-empty{padding:30px 18px;text-align:center;color:var(--muted);font-size:13px}",

      "@media (max-width:760px){",
      "  .anhw-row,.anhw-cols{grid-template-columns:minmax(0,1fr) 70px;gap:8px 12px;padding-left:38px}",
      "  .anhw-cap{grid-column:1 / -1;padding-left:0}",
      "  .anhw-end{grid-column:1 / -1;align-items:flex-start}",
      "  .anhw-sort,.anhw-cols{padding-left:38px}",
      "  .anhw-gcomm{display:none}",
      "  .anhw-cols .anhw-c-live,.anhw-cols .anhw-c-status{display:none}",
      "}"
    ].join("\n");
    document.head.appendChild(st);
  }

  var CHEVRON = '<svg class="anhw-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';
  var ICO_INV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3"></path><line x1="13" y1="15" x2="17" y2="15"></line></svg>';
  var ICO_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="7.5" r=".6" fill="currentColor"></circle></svg>';

  function rowHtml(inv, cf, ctx, col, win) {
    var esc = ctx.esc, fmt = ctx.fmt;
    var siteVendor = col && col.vendor;
    var cohort = Array.isArray(col.inverters) ? col.inverters : [];
    var name = esc(inv.name || inv.inverter_id || "Inverter");
    var model = inv.model ? esc(inv.model) : "";

    // CF over analysis window (explicit label)
    var cfCell;
    if (cf == null) {
      cfCell = '<div class="anhw-cf na" title="Need measured kWh over the last ' + win + ' days"><div class="anhw-cf-n">—</div><div class="anhw-cf-l">' + win + 'd CF</div></div>';
    } else {
      cfCell = '<div class="anhw-cf" title="Capacity factor over the last ' + win + ' days = measured kWh ÷ (nameplate × ' + win + ' × 24h)"><div class="anhw-cf-n">' + (Math.round(cf * 10) / 10) +
        '%</div><div class="anhw-cf-l">' + win + 'd CF</div></div>';
    }

    // Live kW vs capacity
    var liveKw = fmt.kwFromW(inv.current_power_w);
    var capKw = num(inv.nameplate_kw);
    var alloc = isAllocatedPower(inv, siteVendor);
    var allocTitle = alloc ? ' title="' + esc(allocTip(inv, siteVendor)) + '"' : ' title="Live instantaneous power right now"';
    var allocMark = alloc ? '~' : '';
    var capCell;
    if (liveKw != null && capKw != null) {
      capCell = '<div class="anhw-cap"' + allocTitle + '><b>' + allocMark + esc(fmt.kw(liveKw)) + '</b> <span class="anhw-of">/ ' +
        esc(fmt.kw(capKw)) + ' cap</span><span class="anhw-live-tag">live</span></div>';
    } else if (capKw != null) {
      capCell = '<div class="anhw-cap" title="No live power reading for this unit right now"><span class="anhw-of">' + esc(fmt.kw(capKw)) + ' capacity</span><span class="anhw-live-tag">no live kW</span></div>';
    } else {
      capCell = '<div class="anhw-cap"><span class="anhw-of">—</span></div>';
    }

    var st = resolveStatus(inv, cohort, col);
    var pill = '<span class="anhw-pill ' + st.tone + '" title="' + esc(st.tip) + '">' + esc(st.label) + '</span>';
    var basisLab = st.basis === "live" ? "live now"
      : st.basis === "monitoring" ? "awaiting data"
      : "14-day peer";
    var basis = '<span class="anhw-basis" title="' + esc(st.tip) + '">' + esc(basisLab) + '</span>';

    var comm = commFromHours(inv.stale_hours);
    var commCell = comm
      ? '<span class="anhw-rcomm" title="Last reading from this inverter">Last ' + esc(comm) + '</span>'
      : '';

    var rowCls = "anhw-row" + (st.tone === "warn" || st.tone === "bad" ? " live-warn" : "");
    return '<div class="' + rowCls + '">' +
      '<div class="anhw-dev"><div class="anhw-dname">' + name + '</div>' +
      (model ? '<div class="anhw-dmodel">' + model + '</div>' : '') + '</div>' +
      cfCell + capCell +
      '<div class="anhw-end"><div class="anhw-end-top">' + pill + '</div>' + basis + commCell + '</div>' +
      '</div>';
  }

  function groupHtml(col, ctx, open, win) {
    var esc = ctx.esc;
    var aid = String(col.array_id);
    var invs = Array.isArray(col.inverters) ? col.inverters.slice() : [];

    var withCf = invs.map(function (inv) { return { inv: inv, cf: cfPct(inv, win) }; });
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
      (comm ? '<span class="anhw-gcomm" title="When this site last synced from the vendor portal"><b>Last sync</b> ' + esc(comm) + '</span>' : '') +
      '</button>';

    var rows;
    if (!withCf.length) {
      rows = '<div class="anhw-rows"><div class="anhw-empty">No inverter detail captured for this site yet.</div></div>';
    } else {
      var colsHead =
        '<div class="anhw-cols" aria-hidden="true">' +
        '<span>Inverter</span>' +
        '<span style="text-align:right">' + win + 'd CF</span>' +
        '<span class="anhw-c-live">Live / cap</span>' +
        '<span class="anhw-c-status" style="text-align:right">Status</span>' +
        '</div>';
      var body = withCf.map(function (x) { return rowHtml(x.inv, x.cf, ctx, col, win); }).join("");
      rows = '<div class="anhw-rows">' +
        '<div class="anhw-sort">Sorted by ' + win + '-day capacity factor · status = 14-day peer + live check</div>' +
        colsHead + body + '</div>';
    }

    return '<div class="anhw-grp' + (open ? ' open' : '') + '" data-grp="' + esc(aid) + '">' + head + rows + '</div>';
  }

  function render(container, ctx) {
    ensureCss();
    var win = winDays(ctx);
    var cols = Array.isArray(ctx.columns) ? ctx.columns : [];

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
      '    <span><b>' + win + '-day CF</b> is measured energy vs nameplate. ' +
      '<b>Status</b> starts from 14-day peer health, then overlays live dark/low/missing so a unit Solar.web flags isn’t green-washed. ' +
      'String/WS/GW/EMS devices aren’t in this model.</span>' +
      '  </div>' +
      '</div>';

    var tree;
    if (!cols.length) {
      tree = '<div class="anhw-empty">No arrays connected yet. Once a site syncs, its inverters appear here.</div>';
    } else {
      tree = '<div class="anhw-tree">' + cols.map(function (col) {
        return groupHtml(col, ctx, !!EXPANDED[String(col.array_id)], win);
      }).join("") + '</div>';
    }

    container.innerHTML =
      '<div class="an-card">' +
      '  <div class="an-card-head">' +
      '    <h3>Hardware</h3>' +
      '    <span class="an-card-sub">Inverter fleet · ' + win + '-day CF · 14-day peer + live status · grouped by site</span>' +
      '  </div>' +
      strip + tree +
      '</div>';

    if (container._anhwBound !== true) {
      container.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".anhw-ghead") : null;
        if (!btn || !container.contains(btn)) return;
        var aid = btn.getAttribute("data-aid");
        if (!aid) return;
        TOUCHED = true;
        EXPANDED[aid] = !EXPANDED[aid];
        var grp = btn.parentNode;
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
