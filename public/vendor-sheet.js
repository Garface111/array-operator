/* ============================================================================
 * Array Operator — Vendor-data SPREADSHEET view (vendor-sheet.js)
 *
 * A structured, spreadsheet-style sibling to the Sandbox under the "Vendor data"
 * tab: every array as a row, grouped by vendor; click a row to expand its
 * inverters; SEARCH to filter; click a column header to SORT (within each vendor
 * group). Reads the SAME canonical fleet as the sandbox (FleetStore) so the two
 * views never drift. The persistent header (search + sortable headers) is built
 * once and only the table BODY re-renders — so typing never loses focus.
 * ==========================================================================*/
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  const BRAND = {
    solaredge: "SolarEdge", fronius: "Fronius", sma: "SMA", chint: "Chint",
    locus: "Locus", enphase: "Enphase", solis: "Solis", tigo: "Tigo",
    alsoenergy: "AlsoEnergy",
  };
  const vlabel = v => BRAND[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : "Other");
  function kw(w) {
    if (w == null) return "—";
    const k = w / 1000;
    return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + " kW";
  }
  function kwh0(n) { return n == null ? "—" : Math.round(n).toLocaleString() + " kWh"; }

  function arrStatus(c) {
    const a = c.alert || {};
    if (a.level === "critical") return { label: a.headline || "Fault", cls: "bad" };
    if (a.level === "warn") return { label: a.count ? a.count + " need attention" : (a.headline || "Attention"), cls: "warn" };
    if ((c.source_status || {}).state === "stale") return { label: "Source offline", cls: "warn" };
    return { label: "All clear", cls: "ok" };
  }
  function statusRank(c) {
    const a = c.alert || {};
    if (a.level === "critical") return 3;
    if (a.level === "warn" || (c.source_status || {}).state === "stale") return 2;
    return 0;
  }
  function invStatus(iv) {
    const s = iv.status || "ok";
    if (s === "dead") return { label: "Stopped", cls: "bad" };
    if (s === "fault") return { label: "Fault", cls: "bad" };
    if (s === "underperforming") return { label: "Underperforming", cls: "warn" };
    if (s === "comm_gap") return { label: "Quiet", cls: "warn" };
    if (s === "monitoring") return { label: "Monitoring", cls: "muted" };
    return { label: "OK", cls: "ok" };
  }
  function _ageMin(c) {
    const h = (c.source_status || {}).age_hours;
    return h == null ? null : h * 60;
  }
  // How recent a reading must be to still count as "live", per vendor. Extension-
  // captured vendors promise a tight cadence (Chint ~4 min, Fronius/SMA ~6); allow
  // ~2x before we call a reading stale. SolarEdge is API-pulled and its lastUpdateTime
  // routinely lags 15-30 min behind a live currentPower, and the BACKEND still serves
  // it as live until 6h (_SOURCE_STALE_HOURS) — so match that (360 min) for non-cadence
  // vendors, else a healthy SolarEdge array shows a false "stale"/dimmed reading that
  // contradicts the backend.
  function _liveWindowMin(c) {
    const cad = CADENCE_MIN[(c.vendor || "").toLowerCase()];
    return cad ? cad * 2 : 360;
  }
  // A reading is STALE when it's older than its vendor's live window — i.e. the feed
  // has paused (e.g. the portal session lapsed) and the number on screen is frozen.
  function isStale(c) {
    const a = _ageMin(c);
    return a != null && a >= _liveWindowMin(c);
  }
  function freshness(c) {
    const a = _ageMin(c);
    if (a == null) return "";
    if (a < _liveWindowMin(c)) return "live";
    if (a < 90) return Math.round(a) + " min ago";
    if (a < 1440) return Math.round(a / 60) + "h ago";
    return Math.round(a / 1440) + "d ago";
  }

  // Per-vendor live-refresh cadence (minutes), from the EnergyAgent extension's
  // recapture alarms — surfaced so owners know how far behind real time a reading
  // can be. Chint recaptures every ~4 min; Fronius/SMA every ~6 min.
  const CADENCE_MIN = { chint: 4, fronius: 6, sma: 6 };

  // Each vendor's monitoring portal — clicking the vendor name opens it (via the
  // extension when present, so opening it also arms a fresh capture; else a new tab).
  const VENDOR_PORTAL = {
    solaredge: "https://monitoring.solaredge.com/",
    fronius: "https://www.solarweb.com/",
    sma: "https://ennexos.sunnyportal.com/",
    chint: "https://monitor.chintpowersystems.com/",
    enphase: "https://enlighten.enphaseenergy.com/",
    locus: "https://app.locusenergy.com/",
  };

  // Per-vendor sync caveats shown under the group header. Chint reports inverters
  // PER SITE — the portal only loads a site's inverters once you open that site, so
  // landing on the dashboard alone won't sync them.
  const SYNC_NOTE = {
    chint: "Chint syncs per site: after you open the portal, click into each of your sites so its inverters load.",
  };

  // True when the EnergyAgent extension is detected on this page, so "Open to sync"
  // routes through it (opening the portal also arms a fresh capture) instead of a plain tab.
  function extPresent() { try { return _extPresent || !!window.__AO_EXT_PRESENT; } catch (_) { return _extPresent; } }

  const _expanded = {};                       // array_id -> bool (survives re-renders)
  let _query = "";                            // search filter (lowercased)
  let _sort = { key: "name", dir: "asc" };    // sort within each vendor group
  let _view = (() => { try { return localStorage.getItem("ao_vendor_view") || "spreadsheet"; } catch (e) { return "spreadsheet"; } })();

  let _extPresent = false;        // EnergyAgent extension detected on this page (routes "Open to sync" through it)

  // The sortable columns (Vendor is the grouping, not sortable).
  const COLS = [
    { key: "name", cls: "vs-c-name", label: "Array" },
    { key: null, cls: "vs-c-vendor", label: "Vendor" },
    { key: "inv", cls: "vs-c-inv", label: "Inverters" },
    { key: "pow", cls: "vs-c-pow", label: "Live now" },
    { key: "today", cls: "vs-c-today", label: "Today" },
    { key: "status", cls: "vs-c-status", label: "Status" },
    { key: "fresh", cls: "vs-c-fresh", label: "Synced" },
  ];
  function sortVal(c, key) {
    switch (key) {
      case "inv": return c.inverter_count || 0;
      case "pow": return c.current_power_w == null ? -1 : c.current_power_w;
      case "today": return c.produced_today_kwh == null ? -1 : c.produced_today_kwh;
      case "status": return statusRank(c);
      case "fresh": { const h = (c.source_status || {}).age_hours; return h == null ? Infinity : h; }
      default: return (c.array_name || "").toLowerCase();
    }
  }
  function sortCols(list) {
    const m = _sort.dir === "desc" ? -1 : 1;
    return list.slice().sort((a, b) => {
      const va = sortVal(a, _sort.key), vb = sortVal(b, _sort.key);
      if (va < vb) return -1 * m;
      if (va > vb) return 1 * m;
      return String(a.array_name || "").localeCompare(String(b.array_name || ""));   // stable tiebreak
    });
  }
  function setSort(key) {
    if (!key) return;
    if (_sort.key === key) _sort.dir = _sort.dir === "asc" ? "desc" : "asc";
    else _sort = { key, dir: key === "name" ? "asc" : "desc" };   // numbers default biggest-first
  }
  function invMatch(c, q) {
    return (c.inverters || []).some(iv =>
      ((iv.name || "") + " " + (iv.model || "") + " " + (iv.sn || "")).toLowerCase().includes(q));
  }
  function matches(c, q) {
    if (!q) return true;
    if ((c.array_name || "").toLowerCase().includes(q)) return true;
    if (vlabel((c.vendor || "").toLowerCase()).toLowerCase().includes(q)) return true;
    return invMatch(c, q);
  }

  function buildShell(host) {
    const heads = COLS.map(col => {
      if (!col.key) return `<span class="${col.cls}">${col.label}</span>`;
      return `<span class="${col.cls} vs-sortable" data-sort="${col.key}" role="button" tabindex="0" title="Sort by ${col.label}">${col.label}<i class="vs-sc"></i></span>`;
    }).join("");
    host.innerHTML = `
      <div class="vs-topbar">
        <div class="vs-headrow"><h2>All vendor data</h2><div class="vs-sub" id="vsCount"></div>
          <div class="vs-hint">To refresh a vendor, open its portal — click the vendor name or its <strong>↗ Open to sync</strong> button and sign in. The EnergyAgent extension captures the latest readings automatically.</div></div>
        <div class="vs-searchwrap"><input type="search" class="vs-search" id="vsSearch"
          placeholder="Search arrays, vendors, or inverters…" autocomplete="off" spellcheck="false"></div>
      </div>
      <div class="vs-scroll" id="vsScroll">
        <div class="vs-table">
          <div class="vs-row vs-colhead">${heads}</div>
          <div id="vsBody"></div>
        </div>
      </div>`;
    const s = host.querySelector("#vsSearch");
    s.value = _query;
    s.addEventListener("input", () => { _query = s.value.trim().toLowerCase(); renderBody(); });
    host.querySelectorAll("[data-sort]").forEach(b => {
      const go = () => { setSort(b.getAttribute("data-sort")); renderBody(); };
      b.addEventListener("click", go);
      b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function renderBody() {
    const body = $("#vsBody");
    if (!body || !window.FleetStore) return;
    // refresh the sort-caret indicators on the persistent header
    document.querySelectorAll("#vendorSheet [data-sort]").forEach(h => {
      const on = h.getAttribute("data-sort") === _sort.key;
      h.classList.toggle("on", on);
      const i = h.querySelector(".vs-sc");
      if (i) i.textContent = on ? (_sort.dir === "asc" ? " ▲" : " ▼") : "";
    });
    const data = FleetStore.toColumns();
    const all = (data && data.columns) || [];
    const cols = all.filter(c => matches(c, _query));
    const cnt = $("#vsCount");
    if (cnt) {
      const invShown = cols.reduce((t, c) => t + (c.inverter_count || 0), 0);
      cnt.textContent = _query
        ? `${cols.length} of ${all.length} arrays match "${_query}"`
        : `${all.length} array${all.length === 1 ? "" : "s"} · ${(data.summary || {}).inverters_total || invShown} inverters`;
    }
    if (!cols.length) {
      body.innerHTML = `<div class="vs-empty">${_query ? `No arrays match "${esc(_query)}".` : "No arrays connected yet — add one from the Sandbox view."}</div>`;
      return;
    }
    const byVendor = {};
    cols.forEach(c => { const v = (c.vendor || "other").toLowerCase(); (byVendor[v] = byVendor[v] || []).push(c); });
    const vendors = Object.keys(byVendor).sort((a, b) => vlabel(a).localeCompare(vlabel(b)));
    let h = "";
    vendors.forEach(v => {
      const list = sortCols(byVendor[v]);
      const vtot = list.reduce((t, c) => t + (c.current_power_w || 0), 0);
      const nInv = list.reduce((t, c) => t + (c.inverter_count || 0), 0);
      // Data syncs when the owner OPENS the vendor portal (signing in there lets the
      // EnergyAgent extension capture the latest readings) — that's the reliable path,
      // not a background re-scrape. So the per-vendor chip OPENS the portal.
      const _portal = VENDOR_PORTAL[v];
      // Only the extension-scraped vendors (Chint/Fronius/SMA) sync by opening the portal;
      // SolarEdge is pulled server-side via API, so it needs no "open to sync" prompt.
      const lagChip = (_portal && CADENCE_MIN[v])
        ? `<button type="button" class="vs-vlag" data-vportal="${esc(v)}" title="Opens your ${esc(vlabel(v))} portal in a new tab. Sign in there and your latest readings sync here automatically — the EnergyAgent extension captures them.">↗ Open ${esc(vlabel(v))} to sync</button>`
        : "";
      const badge = _portal
        ? `<button type="button" class="vs-vbadge vs-vendor-${esc(v)}" data-vportal="${esc(v)}" title="Open the ${esc(vlabel(v))} portal">${esc(vlabel(v))}</button>`
        : `<span class="vs-vbadge vs-vendor-${esc(v)}">${esc(vlabel(v))}</span>`;
      const vnote = SYNC_NOTE[v] ? `<div class="vs-vnote">ℹ ${esc(SYNC_NOTE[v])}</div>` : "";
      h += `<div class="vs-vgroup">
        <div class="vs-vhead">${badge}
          <span class="vs-vcount">${list.length} array${list.length === 1 ? "" : "s"} · ${nInv} inverters</span>${lagChip}
          <span class="vs-vtot">${kw(vtot)} now</span></div>${vnote}`;
      list.forEach(c => {
        const st = arrStatus(c);
        // Frozen feed: a reading older than the vendor's live window. Dim the (stale)
        // live number and flag its age so a paused feed never masquerades as current.
        const stale = isStale(c) && c.current_power_w != null;
        const staleTitle = stale ? ` title="Last reading ${esc(freshness(c))} — live feed may be paused (sign back into the vendor portal, or hit ${esc(vlabel(v))}'s refresh)"` : "";
        const open = !!_expanded[c.array_id] || (!!_query && invMatch(c, _query) && !(c.array_name || "").toLowerCase().includes(_query));
        h += `<button type="button" class="vs-row vs-arr${open ? " open" : ""}" data-arr="${esc(String(c.array_id))}" aria-expanded="${open}">
          <span class="vs-c-name"><span class="vs-caret">▸</span>${esc(c.array_name || "Array")}</span>
          <span class="vs-c-vendor"><span class="vs-vchip">${esc(vlabel(v))}</span></span>
          <span class="vs-c-inv">${c.inverter_count != null ? c.inverter_count : "—"}</span>
          <span class="vs-c-pow${stale ? " vs-stale" : ""}"${staleTitle}>${kw(c.current_power_w)}</span>
          <span class="vs-c-today">${kwh0(c.produced_today_kwh)}</span>
          <span class="vs-c-status"><span class="vs-pill ${st.cls}">${esc(st.label)}</span></span>
          <span class="vs-c-fresh${isStale(c) ? " vs-stale-syn" : ""}">${esc(freshness(c))}</span>
        </button>`;
        if (open) {
          h += `<div class="vs-inv-wrap">`;
          const invs = c.inverters || [];
          if (!invs.length) {
            h += `<div class="vs-inv-empty">No inverters captured for this array yet.</div>`;
          } else {
            invs.forEach(iv => {
              const ist = invStatus(iv);
              const meta = [iv.model, iv.nameplate_kw != null ? iv.nameplate_kw + " kW" : null].filter(Boolean).join(" · ");
              h += `<div class="vs-row vs-inv">
                <span class="vs-c-name vs-inv-name">${esc(iv.name || iv.sn || "Inverter")}${meta ? ` <span class="vs-inv-meta">${esc(meta)}</span>` : ""}</span>
                <span class="vs-c-vendor"></span><span class="vs-c-inv"></span>
                <span class="vs-c-pow${stale ? " vs-stale" : ""}">${kw(iv.current_power_w)}</span>
                <span class="vs-c-today">${(iv.nameplate_kw && iv.current_power_w != null) ? Math.round(iv.current_power_w / (iv.nameplate_kw * 1000) * 100) + "% of rated" : ""}</span>
                <span class="vs-c-status"><span class="vs-pill ${ist.cls}">${esc(ist.label)}</span></span>
                <span class="vs-c-fresh"></span>
              </div>`;
            });
          }
          h += `</div>`;
        }
      });
      h += `</div>`;
    });
    body.innerHTML = h;
    body.querySelectorAll("[data-arr]").forEach(b => b.onclick = () => {
      const id = b.getAttribute("data-arr");
      _expanded[id] = !_expanded[id];
      renderBody();
    });
    // Clicking a vendor NAME (badge) or its "Open to sync" chip opens that vendor's
    // monitoring portal. With the extension
    // present, route through it (so opening the portal also arms a fresh capture);
    // otherwise open the site in a new tab.
    body.querySelectorAll("[data-vportal]").forEach(btn => btn.onclick = () => {
      const v = btn.getAttribute("data-vportal");
      const url = VENDOR_PORTAL[v];
      if (!url) return;
      if (extPresent()) {
        try {
          window.postMessage({ type: "SO_OPEN_PORTAL", url, active: true, provider: v, vendor: v,
                               reqId: "vs-" + Date.now() }, "*");
          return;
        } catch (_) { /* fall through to a plain open */ }
      }
      try { window.open(url, "_blank", "noopener"); } catch (_) {}
    });
  }

  // Size the scroll region to fill the viewport below it, so the column header can
  // stay sticky at its top while the rows scroll. Recomputed on render + window resize.
  function sizeScroll() {
    const sc = $("#vsScroll");
    if (!sc || (sc.closest("[hidden]"))) return;       // skip while the sheet is hidden (no layout)
    const top = sc.getBoundingClientRect().top;
    sc.style.height = Math.max(260, window.innerHeight - top - 18) + "px";
  }

  function render() {
    const host = $("#vendorSheet");
    if (!host || !window.FleetStore) return;
    const data = FleetStore.toColumns();
    if (!((data && data.columns) || []).length) {
      // Spreadsheet is the DEFAULT view, so it renders during the initial fleet load —
      // show a neutral "loading" state, not the misleading "no arrays", until data lands
      // (the FleetStore subscribe re-renders this once the tree arrives).
      const loading = !!(FleetStore.isLoaded && !FleetStore.isLoaded());
      host.innerHTML = `<div class="vs-empty">${loading ? "Loading your fleet…" : "No arrays connected yet — add one from the Sandbox view, then they'll appear here."}</div>`;
      return;
    }
    if (!host.querySelector("#vsSearch")) buildShell(host);   // build the persistent shell once
    renderBody();
    sizeScroll();
  }

  function showView(v) {
    _view = v;
    try { localStorage.setItem("ao_vendor_view", v); } catch (e) {}
    const sb = $("#sbWrap"), sheet = $("#sheetWrap");
    const segSb = $("#vsSegSandbox"), segSheet = $("#vsSegSheet");
    if (sb) sb.hidden = (v !== "sandbox");
    if (sheet) sheet.hidden = (v !== "spreadsheet");
    [["sandbox", segSb], ["spreadsheet", segSheet]].forEach(([name, el]) => {
      if (el) { el.classList.toggle("on", v === name); el.setAttribute("aria-pressed", String(v === name)); }
    });
    if (v === "spreadsheet" && window.FleetStore) {
      if (!FleetStore.isLoaded()) FleetStore.load();
      render();
    }
  }

  function init() {
    const segSb = $("#vsSegSandbox"), segSheet = $("#vsSegSheet");
    if (!segSb || !segSheet) return;
    segSb.onclick = () => showView("sandbox");
    segSheet.onclick = () => showView("spreadsheet");
    if (window.FleetStore && FleetStore.subscribe) {
      // Re-render on real fleet changes; skip the high-frequency "live" beat + triage so
      // the body doesn't rebuild every few seconds. renderBody() leaves the search input
      // (in the persistent shell) untouched, so a live refresh never steals focus.
      FleetStore.subscribe((s, kind) => {
        if (_view !== "spreadsheet" || kind === "live" || kind === "triage") return;
        if ($("#vsSearch")) renderBody(); else render();
      });
    }
    // Detect the EnergyAgent extension so the Refresh button can re-scrape. so_bridge
    // announces SO_EXTENSION_PRESENT at page load (we may have loaded after it), so we
    // both listen for it AND ask for status to prompt a fresh announce. Belt + the global.
    if (window.__AO_EXT_PRESENT) _extPresent = true;
    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.type === "SO_EXTENSION_PRESENT" || e.data.type === "SO_STATUS_ACK") _extPresent = true;
    });
    try { window.postMessage({ type: "SO_STATUS_REQUEST", reqId: "vs-detect-" + Date.now() }, "*"); } catch (_) {}
    window.addEventListener("resize", sizeScroll);
    showView(_view);
  }

  window.__aoLoadVendorSheet = function () {
    if (_view === "spreadsheet" && window.FleetStore) {
      if (!FleetStore.isLoaded()) FleetStore.load();
      render();
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
