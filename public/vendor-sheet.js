/* ============================================================================
 * Array Operator — Vendor-data SPREADSHEET view (vendor-sheet.js)
 *
 * A structured, spreadsheet-style sibling to the Sandbox under the "Vendor data"
 * tab: every array as a row, grouped by vendor; click a row to expand its
 * inverters. Reads the SAME canonical fleet as the sandbox (FleetStore) so the
 * two views never drift, and re-renders on every fleet change. The Sandbox |
 * Spreadsheet sub-toggle (in index.html, #panelArrays) flips between them.
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
  function invStatus(iv) {
    const s = iv.status || "ok";
    if (s === "dead") return { label: "Stopped", cls: "bad" };
    if (s === "fault") return { label: "Fault", cls: "bad" };
    if (s === "underperforming") return { label: "Underperforming", cls: "warn" };
    if (s === "comm_gap") return { label: "Quiet", cls: "warn" };
    if (s === "monitoring") return { label: "Monitoring", cls: "muted" };
    return { label: "OK", cls: "ok" };
  }
  function freshness(c) {
    const h = (c.source_status || {}).age_hours;
    if (h == null) return "";
    if (h < 1) return "live";
    if (h < 24) return Math.round(h) + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  const _expanded = {};                       // array_id -> bool (survives re-renders)
  let _view = (() => { try { return localStorage.getItem("ao_vendor_view") || "sandbox"; } catch (e) { return "sandbox"; } })();

  function render() {
    const host = $("#vendorSheet");
    if (!host || !window.FleetStore) return;
    const data = FleetStore.toColumns();      // ALL arrays, same shape the sandbox uses
    const cols = (data && data.columns) || [];
    if (!cols.length) {
      host.innerHTML = '<div class="vs-empty">No arrays connected yet — add one from the Sandbox view, then they\'ll appear here.</div>';
      return;
    }
    const byVendor = {};
    cols.forEach(c => { const v = (c.vendor || "other").toLowerCase(); (byVendor[v] = byVendor[v] || []).push(c); });
    const vendors = Object.keys(byVendor).sort((a, b) => vlabel(a).localeCompare(vlabel(b)));

    let h = `<div class="vs-headrow">
      <div><h2>All vendor data</h2>
      <div class="vs-sub">${cols.length} array${cols.length === 1 ? "" : "s"} · ${data.summary.inverters_total} inverters · ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}</div></div>
    </div>
    <div class="vs-table">
      <div class="vs-row vs-colhead">
        <span class="vs-c-name">Array</span><span class="vs-c-vendor">Vendor</span>
        <span class="vs-c-inv">Inverters</span><span class="vs-c-pow">Live now</span>
        <span class="vs-c-today">Today</span><span class="vs-c-status">Status</span>
        <span class="vs-c-fresh">Synced</span>
      </div>`;

    vendors.forEach(v => {
      const list = byVendor[v].slice().sort((a, b) => String(a.array_name || "").localeCompare(String(b.array_name || "")));
      const vtot = list.reduce((t, c) => t + (c.current_power_w || 0), 0);
      const nInv = list.reduce((t, c) => t + (c.inverter_count || 0), 0);
      h += `<div class="vs-vgroup">
        <div class="vs-vhead"><span class="vs-vbadge vs-vendor-${esc(v)}">${esc(vlabel(v))}</span>
          <span class="vs-vcount">${list.length} array${list.length === 1 ? "" : "s"} · ${nInv} inverters</span>
          <span class="vs-vtot">${kw(vtot)} now</span></div>`;
      list.forEach(c => {
        const st = arrStatus(c);
        const open = !!_expanded[c.array_id];
        h += `<button type="button" class="vs-row vs-arr${open ? " open" : ""}" data-arr="${esc(String(c.array_id))}" aria-expanded="${open}">
          <span class="vs-c-name"><span class="vs-caret">▸</span>${esc(c.array_name || "Array")}</span>
          <span class="vs-c-vendor"><span class="vs-vchip">${esc(vlabel(v))}</span></span>
          <span class="vs-c-inv">${c.inverter_count != null ? c.inverter_count : "—"}</span>
          <span class="vs-c-pow">${kw(c.current_power_w)}</span>
          <span class="vs-c-today">${kwh0(c.produced_today_kwh)}</span>
          <span class="vs-c-status"><span class="vs-pill ${st.cls}">${esc(st.label)}</span></span>
          <span class="vs-c-fresh">${esc(freshness(c))}</span>
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
                <span class="vs-c-pow">${kw(iv.current_power_w)}</span>
                <span class="vs-c-today">${iv.peer_index != null ? Math.round(iv.peer_index * 100) + "% of peers" : ""}</span>
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
    h += `</div>`;
    host.innerHTML = h;
    host.querySelectorAll("[data-arr]").forEach(b => b.onclick = () => {
      const id = b.getAttribute("data-arr");
      _expanded[id] = !_expanded[id];
      render();
    });
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
    if (v === "spreadsheet") {
      if (window.FleetStore) { if (!FleetStore.isLoaded()) FleetStore.load(); render(); }
    }
  }

  function init() {
    const segSb = $("#vsSegSandbox"), segSheet = $("#vsSegSheet");
    if (!segSb || !segSheet) return;          // markup not present (older index.html)
    segSb.onclick = () => showView("sandbox");
    segSheet.onclick = () => showView("spreadsheet");
    if (window.FleetStore && FleetStore.subscribe) {
      // Re-render on real fleet changes; skip the high-frequency "live" beat + triage
      // so the table doesn't rebuild (and lose scroll) every few seconds.
      FleetStore.subscribe((s, kind) => {
        if (_view === "spreadsheet" && kind !== "live" && kind !== "triage") render();
      });
    }
    showView(_view);                          // apply the persisted choice
  }

  // Called by the tab system when the Vendor-data tab is (re)entered.
  window.__aoLoadVendorSheet = function () {
    if (_view === "spreadsheet" && window.FleetStore) {
      if (!FleetStore.isLoaded()) FleetStore.load();
      render();
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
