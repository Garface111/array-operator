/* ============================================================================
 * Array Operator — Trends tab orchestrator (trends.js)
 *
 * Fetches the portfolio-wide production payload and renders:
 *   - the stat band (TTM / lifetime / latest YoY / est. savings)
 *   - a segmented VIEW SWITCHER (Liquid / Spiral / Ridgeline / Heat-Field)
 *   - the active visualization (mounted from the view registry in trends-core.js)
 *   - the by-array drill-down table
 *
 * The four visualizations live in trends-view-*.js and self-register on
 * window.AOTrends. This file owns layout + data + which view is active; it does
 * NOT know how any individual chart draws. Chosen view persists in localStorage.
 *
 * Source: GET /v1/array-owners/fleet-trends.   Contract: TRENDS-VIEWS-CONTRACT.md
 * ==========================================================================*/
(function () {
  "use strict";

  const API = "/v1/array-owners/fleet-trends";
  const VIEW_KEY = "ao_trends_view";
  const C = () => window.AOTrends;

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function root() { return document.getElementById("trendsRoot"); }
  function savedView() { try { return localStorage.getItem(VIEW_KEY); } catch (e) { return null; } }
  function saveView(k) { try { localStorage.setItem(VIEW_KEY, k); } catch (e) {} }

  let _activeStop = null;   // cleanup fn for the currently-mounted view
  let _prepped = null;      // prepared data for the current payload

  function loading() {
    const r = root(); if (!r) return;
    r.innerHTML = '<div class="empty" style="padding:34px 0;color:var(--faint)">Loading trends…</div>';
  }
  function empty(msg) {
    const r = root(); if (!r) return;
    teardown();
    r.innerHTML = `<div class="tr-empty">
      <div class="tr-empty-ic" aria-hidden="true">📈</div>
      <div class="tr-empty-h">Not enough history yet</div>
      <div class="tr-empty-p">${C().esc(msg || "Multi-year trends appear once your arrays have logged a few months of production. Connect your arrays on the Arrays tab to start building history.")}</div>
    </div>`;
  }

  function teardown() {
    if (_activeStop) { try { _activeStop(); } catch (e) {} _activeStop = null; }
  }

  function statBand(d) {
    const c = C();
    const years = d.years || [];
    const latestYr = years.length ? Math.max(...years) : null;
    // Latest fleet YoY — compare ONLY months present in BOTH latest & prior year.
    let latestYoY = null, yoyMonths = 0, prevYr = null;
    if (years.length >= 2) {
      prevYr = years[years.length - 2];
      const cur = d.monthly_by_year[String(latestYr)] || [];
      const prev = d.monthly_by_year[String(prevYr)] || [];
      const prevByMonth = {}; prev.forEach(p => prevByMonth[p.month] = p.kwh || 0);
      let curSum = 0, prevSum = 0;
      cur.forEach(p => { if (prevByMonth[p.month] != null) { curSum += (p.kwh || 0); prevSum += prevByMonth[p.month]; yoyMonths++; } });
      if (prevSum > 0 && yoyMonths > 0) latestYoY = (100 * (curSum - prevSum) / prevSum);
    }
    const yoyTitle = yoyMonths > 0
      ? `${latestYr} vs ${prevYr}, same ${yoyMonths} month${yoyMonths === 1 ? "" : "s"}`
      : "year over year";
    return `<div class="tr-stats">
      <div class="tr-stat"><span class="tr-glow"></span><div class="tr-k">TRAILING 12 MO</div><div class="tr-v">${c.fmt0(d.ttm_kwh)} kWh</div></div>
      <div class="tr-stat"><span class="tr-glow"></span><div class="tr-k">LIFETIME (FLEET)</div><div class="tr-v">${c.fmt0(d.lifetime_kwh)} kWh</div></div>
      <div class="tr-stat" title="${yoyTitle}"><span class="tr-glow"></span><div class="tr-k">LATEST YOY</div><div class="tr-v ${latestYoY != null && latestYoY < 0 ? "neg" : "pos"}">${latestYoY == null ? "—" : (latestYoY >= 0 ? "+" : "") + latestYoY.toFixed(1) + "%"}</div></div>
      <div class="tr-stat"><span class="tr-glow"></span><div class="tr-k">EST. SAVINGS (12 MO)</div><div class="tr-v">${d.ttm_savings_usd == null ? "—" : "$" + c.fmt0(d.ttm_savings_usd)}</div></div>
    </div>`;
  }

  function switcher(activeKey) {
    const views = C().listViews();
    return `<div class="tr-switch" role="tablist" aria-label="Chart style">` + views.map(v =>
      `<button class="tr-seg ${v.key === activeKey ? "on" : ""}" data-view="${v.key}" role="tab" aria-selected="${v.key === activeKey}">
        <span class="tr-seg-b">${C().esc(v.badge || "")}</span>${C().esc(v.label)}
      </button>`).join("") + `</div>`;
  }

  function byArrayTable(byArray) {
    const c = C();
    if (!byArray || !byArray.length) return "";
    const rows = byArray.map(a =>
      `<tr><td class="tr-aname">${c.esc(a.name)}</td>
        <td class="tr-anum">${c.fmt0(a.lifetime_kwh)} kWh</td>
        <td class="tr-ayears">${(a.years || []).join(", ") || "—"}</td></tr>`).join("");
    return `<div class="tr-block">
      <div class="tr-block-h">BY ARRAY</div>
      <div class="tr-block-sub">Lifetime production and the years on record for each array in your fleet.</div>
      <div class="tr-tablewrap"><table class="tr-table">
        <thead><tr><th>Array</th><th class="tr-anum">Lifetime</th><th>Years</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function mountView(key) {
    const c = C();
    const view = c.getView(key) || c.listViews()[0];
    if (!view) return;
    teardown();
    // active state on segments
    document.querySelectorAll(".tr-seg").forEach(b => {
      const on = b.getAttribute("data-view") === view.key;
      b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
    });
    const desc = document.getElementById("trViewDesc");
    if (desc) desc.textContent = view.describe || "";
    const host = document.getElementById("trChartHost");
    if (!host) return;
    host.innerHTML = "";
    host.style.position = "relative";
    saveView(view.key);
    try { _activeStop = view.mount(host, _prepped, c) || null; }
    catch (e) {
      host.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">This view hit an error. Try another style above.</div></div>`;
      if (window.console) console.error("trends view " + view.key + " failed", e);
    }
  }

  function render(d) {
    const c = C();
    const r = root(); if (!r) return;
    const years = d.years || [];
    if (!years.length) { empty(); return; }
    _prepped = c.prep(d);

    const views = c.listViews();
    let active = savedView();
    if (!active || !c.getView(active)) active = (views[0] && views[0].key) || "liquid";

    r.innerHTML = `
      ${statBand(d)}
      <div class="tr-block tr-chartblock">
        <div class="tr-chart-head">
          ${switcher(active)}
        </div>
        <div class="tr-view-desc" id="trViewDesc"></div>
        <div class="tr-chart-host" id="trChartHost"></div>
      </div>
      ${byArrayTable(d.by_array)}
    `;

    // wire switcher
    r.querySelectorAll(".tr-seg").forEach(btn => {
      btn.addEventListener("click", () => mountView(btn.getAttribute("data-view")));
    });
    mountView(active);
  }

  function load() {
    const s = session();
    if (!s) { empty("Sign in to see your fleet's multi-year production trends."); return; }
    if (!window.AOTrends || !C().listViews().length) {
      // core/views not ready yet — retry shortly (script order safety)
      return void setTimeout(load, 60);
    }
    loading();
    fetch(API, { headers: { Authorization: "Bearer " + s } })
      .then(res => {
        if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.auth = true; throw e; }
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(render)
      .catch(err => {
        if (err && err.auth) { empty("Your session expired — sign in again to see trends."); return; }
        teardown();
        const r = root();
        if (r) r.innerHTML = `<div class="tr-empty"><div class="tr-empty-ic">⚠️</div>
          <div class="tr-empty-h">Couldn't load trends</div>
          <div class="tr-empty-p">Something went wrong fetching your production history. <a href="#trends" onclick="window.__aoLoadTrends&&window.__aoLoadTrends();return false" style="color:var(--good)">Try again</a>.</div></div>`;
      });
  }

  window.__aoLoadTrends = load;
})();
