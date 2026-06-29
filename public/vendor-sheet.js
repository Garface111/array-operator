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
  // Fronius/SMA/Chint expose only ONE site-level instantaneous power; the backend
  // splits it across inverters by today's energy share — so a per-inverter "kW now"
  // is an ESTIMATE, not a measured per-device reading (data-honesty audit #5). The
  // sandbox marks it "~" + a tip; the spreadsheet must apply the same treatment so it
  // can't read as an exact measured value. (A "% of rated" built on an estimated
  // numerator also reads as exact, so we drop it for these vendors.)
  function isAllocatedPower(iv) {
    return iv && iv.current_power_w != null &&
      (iv.vendor === "fronius" || iv.vendor === "sma" || iv.vendor === "chint");
  }
  const ALLOC_TIP = v =>
    `${vlabel(v)} reports one site-level power — we split it across inverters by today's energy share, so this per-inverter kW is an estimate.`;
  // The ARRAY-level kW is just the sum of those split per-inverter readings, so for
  // these vendors it's an estimate too. Mark it the same way so the array row (and the
  // per-vendor group total) can't read as an exact measured value.
  const ALLOC_VENDORS = { fronius: 1, sma: 1, chint: 1 };
  function isAllocatedVendor(v) { return !!ALLOC_VENDORS[(v || "").toLowerCase()]; }
  function isArrayAllocatedPower(c) {
    return c && c.current_power_w != null && isAllocatedVendor(c.vendor);
  }
  const ARR_ALLOC_TIP = v =>
    `${vlabel(v)} reports one site-level power that we split across inverters — this array total is the sum of those estimates, not a measured reading.`;
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
    // A stale source is a PAUSED feed (the portal session lapsed, not a vendor API
    // outage) — and the row offers an "Open portal to sync" recovery. "Source paused"
    // matches that recoverable state; "offline" wrongly implied a hard outage.
    if ((c.source_status || {}).state === "stale") return { label: "Source paused", cls: "warn" };
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
    // "Monitoring" = we're tracking it but don't yet have enough peer history to grade
    // it (new device, or a metering channel the vendor isn't populating) — so we make
    // no verdict rather than a false "OK"/flag. Spell that out; the bare word is opaque.
    if (s === "monitoring") return { label: "Monitoring", cls: "muted",
      tip: "Tracking this inverter, but not enough peer history yet to grade it — no verdict either way." };
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

  // ── Sync recency (OUR capture clock) vs source-data freshness ──────────────
  // The freshness COLUMN shows when WE last captured (sync_status.age_min) — which
  // advances on every auto-login / keep-warm / live capture, even overnight when the
  // vendor SOURCE's own clock is frozen because the panels are asleep. So a successful
  // sync is visible the instant it lands, faithfully mirroring the back end. "live"
  // still wins when the source data itself is current; the tooltip spells out BOTH
  // clocks so nothing is ambiguous. (freshness() above stays SOURCE-age — it's the
  // honest "this power reading is from X ago" basis, a different question.)
  function _fmtAge(min) {
    if (min == null) return "";
    if (min < 1) return "now";
    if (min < 90) return Math.round(min) + " min ago";
    if (min < 1440) return Math.round(min / 60) + "h ago";
    return Math.round(min / 1440) + "d ago";
  }
  function _syncAgeMin(c) { const m = (c.sync_status || {}).age_min; return m == null ? null : m; }
  // Compact age for the narrow freshness column: "now" / "3m" / "2h" / "1d".
  function _fmtAgeShort(min) {
    if (min == null) return "";
    if (min < 1) return "now";
    if (min < 60) return Math.round(min) + "m";
    if (min < 1440) return Math.round(min / 60) + "h";
    return Math.round(min / 1440) + "d";
  }
  // Our pipeline is "behind" when we haven't captured in ~3 keep-warm cycles (~30 min).
  function syncStale(c) { const s = _syncAgeMin(c); return s != null && s >= 30; }
  function syncFreshness(c) {
    const src = _ageMin(c), syn = _syncAgeMin(c);
    if (src != null && src < _liveWindowMin(c)) return "live";        // the source data itself is current
    if (syn != null) return syn < 1 ? "synced now" : "synced " + _fmtAgeShort(syn);  // our capture recency (updates every sync)
    if (src != null) return _fmtAgeShort(src) + " ago";              // legacy rows without a sync clock
    return "";
  }
  function freshTip(c) {
    const syn = _syncAgeMin(c), src = _ageMin(c), v = vlabel(c.vendor);
    const parts = [];
    if (syn != null) parts.push("We last synced this array " + _fmtAge(syn) + ".");
    if (src != null) {
      parts.push(src < _liveWindowMin(c)
        ? "The " + v + " data is live."
        : "The " + v + " portal's own data is from " + _fmtAge(src)
          + (c.is_daylight === false ? " — it pauses overnight while the panels aren't producing." : "."));
    }
    return parts.join(" ");
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

  // Per-vendor sync caveats shown under the group header (vnote). None currently:
  // Chint used to need a manual per-site click, but the extension now walks every
  // site automatically (background refresh + auto-login), so that caveat was removed.
  const SYNC_NOTE = {};

  // True when the EnergyAgent extension is detected on this page, so "Open to sync"
  // routes through it (opening the portal also arms a fresh capture) instead of a plain tab.
  function extPresent() { try { return _extPresent || !!window.__AO_EXT_PRESENT; } catch (_) { return _extPresent; } }

  const _expanded = {};                       // array_id -> bool (survives re-renders)
  const _invExpanded = {};                    // "array_id:inverter_id" -> bool (click an inverter for detail)
  let _query = "";                            // search filter (lowercased)

  // Shared y-scale + per-day neighbor average for one array's inverter cohort, so the
  // per-inverter sparkline can show an underperformer's bars sitting BELOW its peers.
  // (Each chart used to self-normalize to its own peak, which made very different output
  // render identically — the exact thing that hid why an inverter was flagged.)
  function cohortSpark(invs) {
    const byDate = {};
    let peak = 0;
    (invs || []).forEach(iv => (iv.daily || []).forEach(d => {
      if (!d || d.kwh == null) return;
      if (d.kwh > peak) peak = d.kwh;
      if (d.date == null) return;
      const k = String(d.date), e = byDate[k] || (byDate[k] = { sum: 0, n: 0 });
      e.sum += d.kwh; e.n += 1;
    }));
    return { peak, byDate };
  }
  // A tiny bar sparkline of an inverter's recent daily output (last ~14 days). When a
  // `cohort` is passed, bars are scaled to the COHORT peak (shared with its neighbors)
  // and a faint dashed line traces the neighbor average each day (excluding this unit),
  // so the gap that drives the underperforming verdict is visible across all weather.
  function sparkline(daily, cohort) {
    const pts = (daily || []).filter(d => d && d.kwh != null).slice(-14);
    if (pts.length < 2) return `<div class="vs-id-nospark">Not enough history yet — a sparkline needs a couple of days of capture.</div>`;
    const W = 240, H = 40, bw = W / pts.length;
    const ownMax = Math.max(...pts.map(p => p.kwh), 0.001);
    const max = (cohort && cohort.peak > 0) ? cohort.peak : ownMax;   // shared scale, else self
    const bars = pts.map((p, i) => {
      const bh = Math.max(1.5, (p.kwh / max) * (H - 6));
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
    }).join("");
    let peerLine = "";
    const by = cohort && cohort.byDate;
    if (by) {
      const xy = pts.map((p, i) => {
        const e = p.date != null ? by[String(p.date)] : null;
        if (!e || e.n < 2) return null;                         // need >= 1 neighbor that day
        const avg = (e.sum - p.kwh) / (e.n - 1);                // peers only (exclude self)
        const y = H - Math.max(1.5, (avg / max) * (H - 6));
        return `${(i * bw + bw / 2).toFixed(1)},${y.toFixed(1)}`;
      }).filter(Boolean);
      if (xy.length >= 2) peerLine = `<polyline class="vs-id-peerline" fill="none" points="${xy.join(" ")}"><title>Neighbor average</title></polyline>`;
    }
    return `<svg class="vs-id-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily output, last ${pts.length} days, against the neighbor average">${bars}${peerLine}</svg>`;
  }
  // The detail panel shown when an inverter row is clicked open.
  function invDetailHTML(iv, cohort) {
    const cell = (k, val) => (val == null || val === "") ? "" :
      `<div class="vs-id-cell"><span class="vs-id-k">${k}</span><span class="vs-id-v">${val}</span></div>`;
    const _alloc = isAllocatedPower(iv);
    // % of rated is only honest off a measured numerator — drop it for allocated vendors.
    const pct = (iv.nameplate_kw && iv.current_power_w != null && !_alloc)
      ? Math.round(iv.current_power_w / (iv.nameplate_kw * 1000) * 100) + "%" : null;
    const live = iv.current_power_w != null
      ? (_alloc
          ? `<span title="${esc(ALLOC_TIP(iv.vendor))}">~${esc(kw(iv.current_power_w))}</span>`
          : esc(kw(iv.current_power_w) + (pct ? ` · ${pct} of rated` : "")))
      : null;
    const peer = iv.peer_index != null ? esc(iv.peer_index.toFixed(2) + "× its neighbors") : null;
    const win = iv.window_kwh != null ? esc(Math.round(iv.window_kwh).toLocaleString() + " kWh") : null;
    const range = (iv.min_kwh != null && iv.peak_kwh != null)
      ? esc(Math.round(iv.min_kwh).toLocaleString() + "–" + Math.round(iv.peak_kwh).toLocaleString() + " kWh/day") : null;
    const cells = [
      cell("Live now", live),
      cell("vs. neighbors", peer),
      cell("14-day output", win),
      cell("Daily range", range),
      cell("Model", iv.model ? esc(iv.model) : null),
      cell("Rated", iv.nameplate_kw != null ? esc(iv.nameplate_kw + " kW") : null),
    ].join("");
    const diag = iv.diagnosis ? `<div class="vs-id-diag">${esc(iv.diagnosis)}</div>` : "";
    return `<div class="vs-inv-detail">${diag}
      <div class="vs-id-grid">${cells}</div>
      <div class="vs-id-sparkwrap"><div class="vs-id-sparklabel">Daily output · last 14 days${(cohort && cohort.peak > 0) ? ` <span class="vs-id-peerkey">— dashed: neighbor avg</span>` : ""}</div>${sparkline(iv.daily, cohort)}</div>
    </div>`;
  }
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

  // ── "Sync all vendors": refresh every vendor with one click ────────────────
  // Each vendor is recaptured through the extension — it opens the portal on the
  // existing signed-in session, grabs fresh readings, and CLOSES the surface itself.
  // Fronius/SMA/SolarEdge ride background tabs; Chint rides its v1.9.77 per-site route
  // walk in a minimized, unfocused popup (ext v1.9.80) — so it NO LONGER needs a
  // foreground "open its portal to finish" (which used to pull the operator to the Chint
  // tab). openChint() is kept only as the fallback for older extensions that can't.
  let _syncing = false;
  function recaptureVendorViaBridge(vendor, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const reqId = "vs-sync-" + vendor + "-" + Date.now();
      let settled = false;
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
        if (e.data.type === "SO_RECAPTURE_DONE" && e.data.reqId === reqId) {
          settled = true; window.removeEventListener("message", onMsg);
          resolve({ ok: !!e.data.ok, captured: !!e.data.captured, error: e.data.error || null });
        }
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ type: "SO_RECAPTURE", vendor, reqId }, window.location.origin); }
      catch (_) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "post-failed" }); return; }
      setTimeout(() => { if (!settled) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
    });
  }
  const openChint = () => { try { window.postMessage({ type: "SO_OPEN_PORTAL", url: VENDOR_PORTAL.chint,
    active: true, provider: "chint", vendor: "chint", reqId: "vs-sync-chint-" + Date.now() }, window.location.origin); } catch (_) {} };
  async function syncAllVendors(btn) {
    if (_syncing) return;
    if (!extPresent()) {
      const o = btn.innerHTML; btn.innerHTML = "Install the EnergyAgent extension to sync";
      setTimeout(() => { btn.innerHTML = o; }, 2600); return;
    }
    // The distinct vendors actually on screen (their per-vendor portal buttons).
    const present = [...new Set([...document.querySelectorAll("#vsBody [data-vportal]")]
      .map(b => b.getAttribute("data-vportal")))].filter(v => VENDOR_PORTAL[v]);
    if (!present.length) return;
    const silent = present.filter(v => v !== "chint");
    const hasChint = present.includes("chint");
    _syncing = true;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.classList.add("on");
    btn.innerHTML = `<span class="vs-spin"></span> Syncing all vendors…`;
    // Prefer the CONCURRENT path: extension v1.9.70+ opens every portal at ONCE and
    // auto-closes each as its data lands. Falls back to one-at-a-time on older versions.
    const concurrent = await tryConcurrentSync(present);
    if (concurrent) {
      btn.innerHTML = `✓ Syncing in background`;
      [6000, 14000, 25000].forEach(t => setTimeout(() => { try { if (window.FleetStore && FleetStore.load) FleetStore.load(); } catch (_) {} }, t));
    } else {
      let okCount = 0;
      for (let i = 0; i < silent.length; i++) {
        const v = silent[i];
        btn.innerHTML = `<span class="vs-spin"></span> Syncing ${esc(vlabel(v))}… (${i + 1}/${silent.length})`;
        const r = await recaptureVendorViaBridge(v);
        if (r.ok) okCount++;
        try { if (window.FleetStore && FleetStore.load) FleetStore.load(); } catch (_) {}  // surface fresh readings as they land
      }
      if (hasChint) { btn.innerHTML = "Opening Chint to finish…"; openChint(); }
      btn.innerHTML = `✓ Synced ${okCount}/${silent.length}${hasChint ? " · Chint opened" : ""}`;
    }
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; btn.classList.remove("on"); _syncing = false; }, 3500);
  }
  // Ask the extension to open ALL vendor portals at once + auto-close (v1.9.70+).
  // Resolves true if the extension acked (concurrent path taken), false → fall back.
  function tryConcurrentSync(vendors) {
    return new Promise((resolve) => {
      const reqId = "vs-syncall-" + Date.now();
      let settled = false;
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
        if (e.data.type === "SO_SYNC_ALL_DONE" && e.data.reqId === reqId) {
          settled = true; window.removeEventListener("message", onMsg); resolve(!!e.data.ok);
        }
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ type: "SO_SYNC_ALL", vendors, reqId }, window.location.origin); }
      catch (_) { window.removeEventListener("message", onMsg); resolve(false); return; }
      setTimeout(() => { if (!settled) { window.removeEventListener("message", onMsg); resolve(false); } }, 3000);
    });
  }
  // Close every open vendor portal tab (the extension queries + removes them).
  async function closeVendorTabs(btn) {
    if (!extPresent()) {
      const o = btn.innerHTML; btn.innerHTML = "Needs the EnergyAgent extension";
      setTimeout(() => { btn.innerHTML = o; }, 2400); return;
    }
    const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "Closing…";
    const closed = await new Promise((resolve) => {
      const reqId = "vs-close-" + Date.now();
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
        if (e.data.type === "SO_CLOSE_VENDOR_TABS_DONE" && e.data.reqId === reqId) {
          window.removeEventListener("message", onMsg); resolve(e.data.closed || 0);
        }
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ type: "SO_CLOSE_VENDOR_TABS", reqId }, window.location.origin); }
      catch (_) { window.removeEventListener("message", onMsg); resolve(0); return; }
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(0); }, 4000);
    });
    btn.innerHTML = `✓ Closed ${closed}`;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2400);
  }

  function buildShell(host) {
    const heads = COLS.map(col => {
      if (!col.key) return `<span class="${col.cls}">${col.label}</span>`;
      return `<span class="${col.cls} vs-sortable" data-sort="${col.key}" role="button" tabindex="0" title="Sort by ${col.label}">${col.label}<i class="vs-sc"></i></span>`;
    }).join("");
    host.innerHTML = `
      <div class="vs-topbar">
        <div class="vs-headrow"><h2>All vendor data</h2><div class="vs-sub" id="vsCount"></div>
          <div class="vs-hint">To refresh a vendor, open its portal — click its <strong>↗ Open to sync</strong> button and sign in. The EnergyAgent extension captures the latest readings automatically.</div></div>
        <div class="vs-actions">
          <button type="button" class="vs-addbtn" id="vsAddVendor">+ Add vendor</button>
          <div class="vs-actions-right">
            <button type="button" class="vs-syncall" id="vsSyncAll"
              title="Opens each vendor's portal in the background, captures the latest readings, and closes it — one click to refresh every vendor.">↻ Sync all vendors</button>
            <button type="button" class="vs-closetabs" id="vsCloseTabs"
              title="Closes every open vendor portal tab.">✕ Close all vendor tabs</button>
          </div>
        </div>
        <div class="vs-searchrow"><input type="search" class="vs-search" id="vsSearch"
          placeholder="Search arrays, vendors, or inverters…" autocomplete="off" spellcheck="false"></div>
      </div>
      <div class="vs-scroll" id="vsScroll">
        <div class="vs-table">
          <div class="vs-row vs-colhead">${heads}</div>
          <div id="vsBody"></div>
        </div>
      </div>
      <div id="vsInsights" class="vs-insights" hidden></div>`;
    const s = host.querySelector("#vsSearch");
    s.value = _query;
    s.addEventListener("input", () => { _query = s.value.trim().toLowerCase(); renderBody(); });
    // "+ Add vendor" → the SAME add-array modal the Sandbox view uses (one flow).
    const add = host.querySelector("#vsAddVendor");
    if (add) add.onclick = () => {
      if (window.__aoAddArray) window.__aoAddArray();
      else location.hash = "#arrays";   // defensive: sandbox owns the modal
    };
    const syncBtn = host.querySelector("#vsSyncAll");
    if (syncBtn) syncBtn.onclick = () => syncAllVendors(syncBtn);
    const closeBtn = host.querySelector("#vsCloseTabs");
    if (closeBtn) closeBtn.onclick = () => closeVendorTabs(closeBtn);
    host.querySelectorAll("[data-sort]").forEach(b => {
      const go = () => { setSort(b.getAttribute("data-sort")); renderBody(); };
      b.addEventListener("click", go);
      b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  // ==========================================================================
  // FLEET INSIGHTS — a tabbed strip BELOW the array rows answering the two
  // glances an owner has: "am I making money?" and "is everything doing well?"
  // — on their REAL fleet. Every $ + expected figure mirrors command-center.js /
  // FleetStore exactly (ONE source of truth for the rate + the model). Nothing is
  // invented: estimates are marked, un-gradeable arrays say so, and anything we
  // can't ground honestly is a setup/pointer state — never a fake number.
  // ==========================================================================
  let _insTab = "live";
  const FSI = () => window.FleetStore || null;
  const insRate = () => { const s = FSI(); return s && s.energyRate ? s.energyRate() : 0.21; };
  const insREC  = () => { const s = FSI(); return (s && s.REC_PER_MWH) || 38; };
  const insWIN  = () => { const s = FSI(); return (s && s.WINDOW_DAYS) || 14; };
  const insLive = () => { try { return !!(FSI() && FSI().isLive && FSI().isLive()); } catch (_) { return false; } };
  const insDemo = () => { try { return !!(FSI() && FSI().isSimulated && FSI().isSimulated()); } catch (_) { return false; } };
  const insVal  = kwh => kwh * insRate() + (kwh / 1000) * insREC();
  const usd0 = n => "$" + Math.round(Number(n) || 0).toLocaleString();
  const usd2 = n => "$" + (Number(n) || 0).toFixed(2);
  const INS_CF = [0.072,0.095,0.135,0.160,0.175,0.182,0.180,0.168,0.145,0.110,0.072,0.060];
  const insCF = () => INS_CF[new Date().getMonth()] || 0.14;
  const INS_MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const INS_SHORT = 0.18;
  const STAT_TXT = { dead:"stopped earning", fault:"hardware fault", underperforming:"below its peers", comm_gap:"gone quiet", live_dark:"not producing now" };
  function insLostKwh(inv, fleetWin, totalNp){
    const fair = (inv.nameplate_kw||0)/totalNp*fleetWin;
    if(inv.status==="dead"||inv.status==="fault") return Math.max(0, fair-(inv.window_kwh||0));
    if(inv.status==="underperforming" && inv.peer_index) return Math.max(0, fair/Math.max(inv.peer_index,0.01)-(inv.window_kwh||0));
    return 0;   // comm_gap / live_dark / ok / monitoring => $0 claimed
  }
  const insLossMo = lk => insVal(lk)/insWIN()*30;
  function insEff(inv, peers, day){ let s=inv.status; const fs=FSI(); if(s==="ok"&&fs&&fs.liveVerdict&&fs.liveVerdict(inv,peers,day)==="dark") s="live_dark"; return s; }
  function insModel(a){
    const invs=a.inverters||[]; const totalNp=invs.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;
    const fleetWin=invs.reduce((t,i)=>t+(i.window_kwh||0),0); const cf=insCF();
    let mK=0,tK=0,mc=0,lossMo=0,winKwh=0; const flags=[];
    let nDead=0,nUnder=0,nQuiet=0;
    invs.forEach(inv=>{
      winKwh += (inv.window_kwh||0);
      if(inv.nameplate_kw>0 && inv.window_kwh!=null && inv.window_kwh>0){ mK+=inv.window_kwh; tK+=inv.nameplate_kw*24*insWIN()*cf; mc++; }
      const s=insEff(inv,invs,a.is_daylight);
      if(s==="monitoring"||s==="ok") return;
      if(s==="dead"||s==="fault")nDead++; else if(s==="underperforming")nUnder++; else nQuiet++;
      const priced=(s==="dead"||s==="fault"||(s==="underperforming"&&inv.peer_index));
      const lk=priced?insLostKwh(inv,fleetWin,totalNp):0; const lm=insLossMo(lk); lossMo+=lm;
      flags.push({inv:inv.name||inv.sn||"Inverter", status:s, lossMo:lm, priced, noPeers:s==="underperforming"&&!inv.peer_index});
    });
    const ratio = tK>0? mK/tK : null;
    return {a, name:a.name, vendor:a.vendor, ratio, pct:ratio==null?null:Math.round(ratio*100),
      short:ratio!=null&&ratio<(1-INS_SHORT), lossMo, lossYr:lossMo*12, mK, tK, mc, winKwh, flags,
      counts:{dead:nDead,under:nUnder,quiet:nQuiet}};
  }
  function insVerdict(m){
    if(m.counts.dead>0) return {key:"fault",label:"Fault",rank:0,c:"#dc2626"};
    if(m.counts.under>0||m.short) return {key:"slipping",label:"Slipping",rank:1,c:"#d97706"};
    if(m.counts.quiet>0) return {key:"quiet",label:"Gone quiet",rank:2,c:"#d97706"};
    if(m.mc===0) return {key:"nograde",label:"No verdict yet",rank:3,c:"#94a3b8"};
    if(m.ratio!=null && m.ratio>=1.0) return {key:"thriving",label:"Thriving",rank:5,c:"#9333ea"};
    return {key:"steady",label:"Steady",rank:4,c:"#2f6fb3"};
  }
  function insReason(m,v){
    if(v.key==="fault"||v.key==="slipping"||v.key==="quiet"){
      const f=m.flags.slice().sort((a,b)=>b.lossMo-a.lossMo)[0];
      if(f) return esc(f.inv)+" — "+(STAT_TXT[f.status]||f.status);
    }
    if(v.key==="nograde") return "no 14-day history yet";
    if(m.pct!=null) return m.pct+"% of typical for "+INS_MON[new Date().getMonth()];
    return "";
  }
  function insTrend(daily){
    const d=(daily||[]).filter(x=>x&&x.kwh!=null);
    if(d.length<5) return null;
    const h=Math.floor(d.length/2); let a=0,b=0;
    for(let i=0;i<h;i++)a+=d[i].kwh; for(let i=d.length-h;i<d.length;i++)b+=d[i].kwh;
    a/=h; b/=h; const r=a>0?b/a:1;
    if(r>=1.06) return {a:"↗",c:"#9333ea",t:"trending up"};
    if(r<=0.94) return {a:"↘",c:"#d97706",t:"trending down"};
    return {a:"→",c:"#64748b",t:"steady"};
  }
  function insItems(){
    const fs=window.FleetStore; if(!fs||!fs.snapshot) return null;
    const snap=fs.snapshot(); const arrays=(snap&&snap.arrays)||[];
    if(!arrays.length) return null;
    const data=fs.toColumns(); const byId={};
    ((data&&data.columns)||[]).forEach(c=>{ byId[c.array_id]=c; });
    return arrays.map(a=>{ const m=insModel(a); return {m, v:insVerdict(m), c:byId[a.id]||{}}; });
  }
  function insRateTag(){
    if(!insLive()) return ' <span class="vsi-tag" title="Sign in and connect your utility so we use your real billed $/kWh. Until then these figures use a $0.21/kWh placeholder rate.">$0.21/kWh placeholder</span>';
    if(insDemo()) return ' <span class="vsi-tag">demo fleet</span>';
    return "";
  }
  function tabLive(items){
    let today=0,kwNow=0,winKwh=0,alloc=false,anyToday=false;
    items.forEach(({m,c})=>{
      if(c.produced_today_kwh!=null){ today+=c.produced_today_kwh; anyToday=true; }
      if(c.current_power_w!=null && !isStale(c)){ kwNow+=c.current_power_w; if(isAllocatedVendor(c.vendor)) alloc=true; }
      winKwh+=m.winKwh;
    });
    const perHr=(kwNow/1000)*insRate(); const perDay=winKwh>0?insVal(winKwh)/insWIN():null; const a=alloc?"~":"";
    let h='<div class="vsi-hero"><div><div class="vsi-k">Reported earned today'+insRateTag()+'</div><div class="vsi-big octd">'+(anyToday?usd0(insVal(today)):"—")+'</div></div><div class="vsi-hero-r">'
      +(kwNow>0?'<div class="oct">≈ '+a+usd2(perHr)+'/hr right now</div>':'<div class="dim">— nothing producing now</div>')
      +(perDay!=null?'<div class="dim">~'+usd0(perDay)+'/day · last 14 days</div>':'')+'</div></div>';
    items.slice().sort((x,y)=>(y.c.produced_today_kwh||0)-(x.c.produced_today_kwh||0)).forEach(({m,c,v})=>{
      const td=c.produced_today_kwh!=null?usd0(insVal(c.produced_today_kwh)):"—";
      // Only call it "now" when the feed is live — a stale/frozen reading is NOT current power.
      const fresh=(c.current_power_w!=null)&&!isStale(c);
      const kw=fresh?((isAllocatedVendor(c.vendor)?"~":"")+(c.current_power_w/1000).toFixed(1)+" kW"):"—";
      const kwlbl=fresh?"now":(isStale(c)?"paused":"");
      h+='<div class="vsi-row"><span class="vsi-sp" style="background:'+v.c+'"></span><div class="vsi-nm"><b>'+esc(m.name||"Array")+'</b><i>'+esc(vlabel(m.vendor))+'</i></div>'
        +'<div class="vsi-rc"><div class="dim">'+kwlbl+'</div><div class="vsi-num">'+kw+'</div></div>'
        +'<div class="vsi-rc" style="min-width:86px"><div class="vsi-num octd">'+td+'</div><div class="dim">reported today</div></div></div>';
    });
    h+='<div class="vsi-foot">“Reported today” comes straight from each vendor and can include a utility-bill estimate — it’s not a metered total. $ at '+usd2(insRate())+'/kWh + RECs; '+a+' = one site-level power split across inverters (estimate).</div>';
    return h;
  }
  function tabVerdict(items){
    const s=items.slice().sort((x,y)=>x.v.rank-y.v.rank || y.m.lossMo-x.m.lossMo);
    const cnt={thriving:0,steady:0,slipping:0,quiet:0,fault:0,nograde:0}; let risk=0;
    items.forEach(({m,v})=>{ cnt[v.key]++; risk+=m.lossMo; });
    const order=[['thriving','#9333ea'],['steady','#2f6fb3'],['slipping','#d97706'],['quiet','#d97706'],['fault','#dc2626'],['nograde','#94a3b8']];
    let h='<div class="vsi-hero"><div><div class="vsi-k">Fleet verdict</div><div class="vsi-sum">'
      +order.filter(([k])=>cnt[k]).map(([k,c])=>'<span style="color:'+c+'">'+cnt[k]+' '+k+'</span>').join(' · ')+'</div></div>'
      +(risk>0?'<div class="vsi-hero-r"><div class="red" style="font-size:15px;font-weight:500">'+usd0(risk)+'/mo at risk'+insRateTag()+'</div></div>':'')+'</div>';
    s.forEach(({m,v})=>{
      const tail=m.lossMo>0?'<div class="red">'+usd0(m.lossMo)+'/mo</div>':(v.key==="thriving"&&m.pct!=null?'<div class="oct">'+m.pct+'%</div>':'');
      h+='<div class="vsi-row"><span class="vsi-sp" style="background:'+v.c+(v.key==="thriving"?";box-shadow:0 0 7px rgba(147,51,234,.45)":"")+'"></span>'
        +'<div class="vsi-nm"><b>'+esc(m.name||"Array")+'</b><i><span style="color:'+v.c+'">'+v.label+'</span> · '+insReason(m,v)+'</i></div>'
        +'<div class="vsi-rc" style="min-width:64px">'+tail+'</div></div>';
    });
    return h;
  }
  function tabLeak(items){
    const rows=[]; items.forEach(({m})=>m.flags.forEach(f=>rows.push({arr:m.name,f})));
    if(!rows.length) return '<div class="vsi-clear"><i class="ti ti-circle-check" aria-hidden="true"></i> No priced leaks — every inverter is pulling its weight.</div>';
    const priced=rows.filter(r=>r.f.lossMo>0).sort((a,b)=>b.f.lossMo-a.f.lossMo);
    const quiet=rows.filter(r=>r.f.lossMo<=0);
    const total=priced.reduce((t,r)=>t+r.f.lossMo,0);
    let h='<div class="vsi-hero"><div><div class="vsi-k">Credit walking out until fixed'+insRateTag()+'</div><div class="vsi-big red">'+usd0(total)+'<span class="dim" style="font-size:14px;font-weight:400">/mo</span></div></div></div>';
    priced.forEach(r=>{
      h+='<div class="vsi-row"><span class="vsi-sp" style="background:'+((r.f.status==="dead"||r.f.status==="fault")?"#dc2626":"#d97706")+'"></span>'
        +'<div class="vsi-nm"><b>'+esc(r.arr)+' · '+esc(r.f.inv)+'</b><i>'+(STAT_TXT[r.f.status]||r.f.status)+'</i></div>'
        +'<div class="vsi-rc"><div class="vsi-num red">'+usd0(r.f.lossMo)+'/mo</div><div class="dim">'+usd0(r.f.lossMo*12)+'/yr</div></div></div>';
    });
    quiet.forEach(r=>{
      const why=r.f.noPeers?"below pace · no peer baseline to price it":(STAT_TXT[r.f.status]||r.f.status)+" — not billable until it checks back in";
      h+='<div class="vsi-row" style="opacity:.72"><span class="vsi-sp" style="background:#cbd5e1"></span><div class="vsi-nm"><b>'+esc(r.arr)+' · '+esc(r.f.inv)+'</b><i>'+why+'</i></div><div class="vsi-rc"><span class="vsi-pill">$0</span></div></div>';
    });
    return h;
  }
  function tabPerf(items){
    const gr=items.filter(x=>x.m.pct!=null);
    let mK=0,tK=0; gr.forEach(({m})=>{ mK+=m.mK; tK+=m.tK; });
    const fleetPct=tK>0?Math.round(mK/tK*100):null;
    let h='<div class="vsi-hero"><div><div class="vsi-k">Measured vs modelled-typical for '+INS_MON[new Date().getMonth()]+'</div><div class="vsi-big '+(fleetPct!=null&&fleetPct>=100?"octd":"")+'">'+(fleetPct!=null?fleetPct+"%":"—")+'</div></div></div>';
    if(!gr.length) return h+'<div class="vsi-note">A performance grade appears once an inverter has ~14 days of history.</div>';
    const ranked=gr.slice().sort((a,b)=>a.m.ratio-b.m.ratio); const showPct=ranked.length>=3;
    ranked.slice().sort((a,b)=>a.m.pct-b.m.pct).forEach(({m,c})=>{
      const cls=m.pct>=100?"octd":m.pct>=82?"cold":"amb"; const sp=m.pct>=100?"#9333ea":m.pct>=82?"#2f6fb3":"#d97706";
      const idx=ranked.indexOf(ranked.find(r=>r.m===m));   // 0 = worst, n-1 = best (ratio asc)
      const pctile=showPct?('P'+Math.round(idx/(ranked.length-1||1)*100)):"";   // P100 = top performer
      const tr=insTrend(c.daily); const leak=m.lossMo>0?'<div class="amb" style="font-size:11px">'+usd0(m.lossMo)+'/mo leak</div>':'';
      h+='<div class="vsi-row"><span class="vsi-sp" style="background:'+sp+'"></span><div class="vsi-nm"><b>'+esc(m.name)+'</b><i>'+esc(vlabel(m.vendor))+(tr?' · <span style="color:'+tr.c+'">'+tr.a+' '+tr.t+'</span>':'')+'</i></div>'
        +(pctile?'<div class="vsi-rc"><span class="vsi-pill">'+pctile+'</span></div>':'')
        +'<div class="vsi-rc" style="min-width:62px"><div class="vsi-num '+cls+'">'+m.pct+'%</div>'+leak+'</div></div>';
    });
    items.filter(x=>x.m.pct==null).forEach(({m})=>{ h+='<div class="vsi-row" style="opacity:.6"><span class="vsi-sp" style="background:#cbd5e1"></span><div class="vsi-nm"><b>'+esc(m.name)+'</b><i class="dim">grade appears after ~14 days of history</i></div></div>'; });
    h+='<div class="vsi-foot">“Typical” is a Northeast-US weather model (this month ≈'+Math.round(insCF()*100)+'% capacity factor), not a guarantee — only a sustained gap past 18% reads as slipping.</div>';
    return h;
  }
  function tabPayback(items){
    let winKwh=0; items.forEach(({m})=>winKwh+=m.winKwh);
    const earned14=insVal(winKwh); const perDay=insWIN()>0?earned14/insWIN():0;
    let cost=0; try{ cost=parseFloat(localStorage.getItem("ao_install_cost"))||0; }catch(_){}
    let h='<div class="vsi-hero"><div><div class="vsi-k">Earned in the last 14 days'+insRateTag()+'</div><div class="vsi-big octd">'+usd0(earned14)+'</div></div><div class="vsi-hero-r"><div class="dim">~'+usd0(perDay)+'/day at your recent pace</div></div></div>';
    if(cost>0 && perDay>0){
      const yrs=cost/(perDay*365);
      h+='<div class="vsi-payrow"><div class="vsi-k">Your system cost <span class="dim" style="text-transform:none">(your figure)</span></div><div class="vsi-num">'+usd0(cost)+' <button type="button" class="vsi-link" id="vsiCostEdit">change</button></div></div>';
      h+='<div class="vsi-est"><i class="ti ti-clock" aria-hidden="true"></i><div>At your recent pace, break-even in <b>≈ '+yrs.toFixed(1)+' years</b> <span class="dim">— an estimate that extrapolates the last 14 days; seasons and weather will move it.</span></div></div>';
    } else {
      h+='<div class="vsi-setup"><div class="vsi-k">See your payback</div><div class="vsi-setup-row"><input type="number" id="vsiCost" placeholder="Your install cost, e.g. 58000" min="0" step="100"><button type="button" class="vsi-btn" id="vsiCostSave">Show payback</button></div><div class="dim" style="font-size:11px;margin-top:5px">Stored only in your browser — we never auto-guess your cost.</div></div>';
    }
    h+='<div class="vsi-foot">Lifetime totals, records, and year-over-year live in the <a href="#trends" class="vsi-link">Trends</a> tab.</div>';
    return h;
  }
  function tabReceiv(items){
    let h='<div class="vsi-hero"><div><div class="vsi-k">Offtaker billing</div><div class="vsi-sum dim">If you sell your generation, your splits and invoices live in Reports.</div></div></div>';
    h+='<div class="vsi-note" style="text-align:left;padding:11px 0">Per-array offtaker splits and one-click invoices aren’t wired into this panel yet — they live in <a href="#reports" class="vsi-link">Reports</a>, priced off your real GMP bills.</div>';
    h+='<a href="#reports" class="vsi-btn" style="text-decoration:none;display:inline-block">Open Reports → offtakers</a>';
    return h;
  }
  function renderPanel(){
    const root=$("#vsInsights"); if(!root) return;
    const items=insItems();
    if(!items){ root.hidden=true; return; }
    root.hidden=false;
    const TABS=[["live","Live ledger"],["verdict","Verdict field"],["leak","Leak ledger"],["payback","Payback"],["perf","Performance"],["receiv","Receivables"]];
    const REND={live:tabLive,verdict:tabVerdict,leak:tabLeak,payback:tabPayback,perf:tabPerf,receiv:tabReceiv};
    if(!REND[_insTab]) _insTab="live";
    const tabs=TABS.map(([k,l])=>'<button type="button" class="vsi-tab'+(k===_insTab?" on":"")+'" data-instab="'+k+'">'+esc(l)+'</button>').join("");
    root.innerHTML='<div class="vsi-head"><div class="vsi-h2">Fleet insights</div><div class="vsi-tabs">'+tabs+'</div></div><div class="vsi-pane">'+REND[_insTab](items)+'</div>';
    root.querySelectorAll("[data-instab]").forEach(b=>b.onclick=()=>{ _insTab=b.getAttribute("data-instab"); renderPanel(); });
    const save=root.querySelector("#vsiCostSave");
    if(save) save.onclick=()=>{ const v=root.querySelector("#vsiCost"); const n=parseFloat(v&&v.value); if(n>0){ try{localStorage.setItem("ao_install_cost",String(n));}catch(_){ } renderPanel(); } };
    const edit=root.querySelector("#vsiCostEdit");
    if(edit) edit.onclick=()=>{ try{localStorage.removeItem("ao_install_cost");}catch(_){ } renderPanel(); };
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
    // Vendor-data spreadsheet = INVERTER arrays only. Drop utility-meter-only arrays
    // (GMP/VEC/SmartHub with no inverters / no vendor) — they belong to the offtaker +
    // NEPOOL views, not here. (Regression fix: the GMP bill-pull began creating
    // utility-only Array rows that leaked into this grid once the source filter was lost.)
    const all = ((data && data.columns) || []).filter(c => {
      const ds = (c && c.daily_split) || {};
      return !!ds.has_vendor || !!(c && c.vendor)
        || (Array.isArray(c && c.vendors) && c.vendors.length > 0)
        || (Array.isArray(c && c.inverters) && c.inverters.length > 0);
    });
    const cols = all.filter(c => matches(c, _query));
    const cnt = $("#vsCount");
    if (cnt) {
      const invShown = cols.reduce((t, c) => t + (c.inverter_count || 0), 0);
      cnt.textContent = _query
        ? `${cols.length} of ${all.length} arrays match "${_query}"`
        : `${all.length} array${all.length === 1 ? "" : "s"} · ${(data.summary || {}).inverters_total || invShown} inverters`;
    }
    if (!cols.length) {
      body.innerHTML = `<div class="vs-empty">${_query ? `No arrays match "${esc(_query)}".` : "No arrays connected yet — hit <b>+ Add vendor</b> above to connect one."}</div>`;
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
      // The vendor NAME opens that vendor's portal in a plain NEW TAB (data-vopen) — a normal
      // navigation that does NOT route through the extension, so it takes the owner to the
      // vendor site WITHOUT pulling them back to Array Operator. Only the "↗ Open <Vendor> to
      // sync" chip below (data-vportal) uses the extension flow that captures + syncs back here.
      const badge = _portal
        ? `<button type="button" class="vs-vbadge vs-vendor-${esc(v)}" data-vopen="${esc(v)}" title="Open the ${esc(vlabel(v))} portal in a new tab (just visit — won't sync or pull you back here)">${esc(vlabel(v))}</button>`
        : `<span class="vs-vbadge vs-vendor-${esc(v)}">${esc(vlabel(v))}</span>`;
      const vnote = SYNC_NOTE[v] ? `<div class="vs-vnote">ℹ ${esc(SYNC_NOTE[v])}</div>` : "";
      const vAlloc = isAllocatedVendor(v) && vtot > 0;
      h += `<div class="vs-vgroup">
        <div class="vs-vhead">${badge}
          <span class="vs-vcount">${list.length} array${list.length === 1 ? "" : "s"} · ${nInv} inverters</span>${lagChip}
          <span class="vs-vtot"${vAlloc ? ` title="${esc(ARR_ALLOC_TIP(v))}"` : ""}>${vAlloc ? "~" : ""}${kw(vtot)} now</span></div>${vnote}`;
      list.forEach(c => {
        const st = arrStatus(c);
        // Frozen feed: a reading older than the vendor's live window. Dim the (stale)
        // live number and flag its age so a paused feed never masquerades as current.
        const stale = isStale(c) && c.current_power_w != null;
        const allocArr = isArrayAllocatedPower(c);
        const staleMsg = stale ? `This live number is from ${freshness(c)} — it refreshes on the next auto-sync; open ${vlabel(v)} to refresh now.` : "";
        const powTitle = (allocArr || stale)
          ? ` title="${esc([allocArr ? ARR_ALLOC_TIP(c.vendor) : "", staleMsg].filter(Boolean).join(" "))}"`
          : "";
        const open = !!_expanded[c.array_id] || (!!_query && invMatch(c, _query) && !(c.array_name || "").toLowerCase().includes(_query));
        h += `<button type="button" class="vs-row vs-arr${open ? " open" : ""}" data-arr="${esc(String(c.array_id))}" aria-expanded="${open}">
          <span class="vs-c-name"><span class="vs-caret">▸</span>${esc(c.array_name || "Array")}</span>
          <span class="vs-c-vendor"><span class="vs-vchip">${esc(vlabel(v))}</span></span>
          <span class="vs-c-inv">${c.inverter_count != null ? c.inverter_count : "—"}</span>
          <span class="vs-c-pow${stale ? " vs-stale" : ""}"${powTitle}>${allocArr ? "~" : ""}${kw(c.current_power_w)}</span>
          <span class="vs-c-today">${kwh0(c.produced_today_kwh)}</span>
          <span class="vs-c-status"><span class="vs-pill ${st.cls}">${esc(st.label)}</span></span>
          <span class="vs-c-fresh${syncStale(c) ? " vs-stale-syn" : ""}" title="${esc(freshTip(c))}">${esc(syncFreshness(c))}</span>
        </button>`;
        if (open) {
          h += `<div class="vs-inv-wrap">`;
          // Stale feed recovery: when this array's source is paused, give a direct
          // path back to fresh data right where the owner notices it — open the
          // vendor portal (extension re-captures on open). Reuses the existing
          // [data-vportal] click delegation, so no extra handler is wired.
          if (syncStale(c) && _portal) {
            h += `<div class="vs-src-recover">
              <span class="vs-src-recover-txt">We haven't synced ${esc(vlabel(v))} in ${esc(_fmtAge(_syncAgeMin(c)))} — auto-sync may need a hand. Open the portal to capture the latest.</span>
              <button type="button" class="vs-src-recover-btn" data-vportal="${esc(v)}">↗ Open ${esc(vlabel(v))} to sync</button>
            </div>`;
          }
          const invs = c.inverters || [];
          if (!invs.length) {
            h += `<div class="vs-inv-empty">No inverters captured for this array yet.</div>`;
          } else {
            const cohortScale = cohortSpark(invs);   // shared y-scale across this array's inverters
            invs.forEach(iv => {
              const ist = invStatus(iv);
              const meta = [iv.model, iv.nameplate_kw != null ? iv.nameplate_kw + " kW" : null].filter(Boolean).join(" · ");
              const ikey = c.array_id + ":" + iv.inverter_id;
              const iopen = !!_invExpanded[ikey];
              h += `<div class="vs-row vs-inv vs-inv-click${iopen ? " open" : ""}" data-inv="${esc(ikey)}" role="button" tabindex="0" aria-expanded="${iopen}" title="Click for inverter detail">
                <span class="vs-c-name vs-inv-name"><span class="vs-caret vs-inv-caret">▸</span>${esc(iv.name || iv.sn || "Inverter")}${meta ? ` <span class="vs-inv-meta">${esc(meta)}</span>` : ""}</span>
                <span class="vs-c-vendor"></span><span class="vs-c-inv"></span>
                <span class="vs-c-pow${stale ? " vs-stale" : ""}"${isAllocatedPower(iv) ? ` title="${esc(ALLOC_TIP(iv.vendor))}"` : ""}>${isAllocatedPower(iv) ? "~" : ""}${kw(iv.current_power_w)}${(iv.nameplate_kw && iv.current_power_w != null && !isAllocatedPower(iv)) ? ` <span class="vs-pct-rated" title="Current power as a percent of this inverter's rated nameplate capacity">· ${Math.round(iv.current_power_w / (iv.nameplate_kw * 1000) * 100)}% of rated</span>` : ""}</span>
                <span class="vs-c-today"></span>
                <span class="vs-c-status"><span class="vs-pill ${ist.cls}"${ist.tip ? ` title="${esc(ist.tip)}"` : ""}>${esc(ist.label)}</span></span>
                <span class="vs-c-fresh"></span>
              </div>`;
              if (iopen) h += invDetailHTML(iv, cohortScale);
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
    // Click an inverter row → toggle its detail panel (diagnosis, peer comparison,
    // 14-day output + sparkline). Keyboard-accessible (Enter/Space).
    body.querySelectorAll("[data-inv]").forEach(b => {
      const go = () => { const k = b.getAttribute("data-inv"); _invExpanded[k] = !_invExpanded[k]; renderBody(); };
      b.onclick = go;
      b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    // The vendor NAME (data-vopen) opens the vendor's portal in a plain new tab — a normal
    // navigation, NOT the extension flow — so it takes the owner to the vendor site WITHOUT
    // pulling them back to Array Operator (even when the extension is installed).
    body.querySelectorAll("[data-vopen]").forEach(btn => btn.onclick = () => {
      const url = VENDOR_PORTAL[btn.getAttribute("data-vopen")];
      if (url) { try { window.open(url, "_blank", "noopener"); } catch (_) {} }
    });
    // The "↗ Open <Vendor> to sync" chip (data-vportal) opens the portal THROUGH the
    // extension when present (so it also arms a fresh capture and syncs back here);
    // otherwise it falls back to a plain new tab.
    body.querySelectorAll("[data-vportal]").forEach(btn => btn.onclick = () => {
      const v = btn.getAttribute("data-vportal");
      const url = VENDOR_PORTAL[v];
      if (!url) return;
      if (extPresent()) {
        try {
          window.postMessage({ type: "SO_OPEN_PORTAL", url, active: true, provider: v, vendor: v,
                               reqId: "vs-" + Date.now() }, window.location.origin);
          return;
        } catch (_) { /* fall through to a plain open */ }
      }
      try { window.open(url, "_blank", "noopener"); } catch (_) {}
    });
    renderPanel();   // tabbed Fleet-insights panel below the rows — re-renders with the fleet
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
      if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
      if (e.data.type === "SO_EXTENSION_PRESENT" || e.data.type === "SO_STATUS_ACK") _extPresent = true;
    });
    try { window.postMessage({ type: "SO_STATUS_REQUEST", reqId: "vs-detect-" + Date.now() }, window.location.origin); } catch (_) {}
    window.addEventListener("resize", sizeScroll);
    showView(_view);
  }

  window.__aoLoadVendorSheet = function () {
    if (_view === "spreadsheet" && window.FleetStore) {
      if (!FleetStore.isLoaded()) FleetStore.load();
      render();
    }
  };

  // Expose the canonical freshness check so other surfaces (e.g. the Dashboard's
  // "kW now" production strip in command-center.js) agree with the spreadsheet on
  // which feeds are frozen — a single source of truth for "is this reading stale".
  window.VendorSheet = window.VendorSheet || {};
  window.VendorSheet.isStale = isStale;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
