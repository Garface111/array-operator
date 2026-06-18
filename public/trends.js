/* ============================================================================
 * Array Operator — Trends tab orchestrator (trends.js)
 *
 * Fetches the portfolio-wide production payload and renders the whole Trends
 * tab as ONE crafted instrument:
 *   - an animated count-up stat band (TTM / lifetime / latest YoY / savings)
 *   - a segmented VIEW SWITCHER with a sliding indicator + per-view accent retint
 *   - the active visualization (mounted from the registry in trends-core.js),
 *     swapped with a calm crossfade
 *   - the by-array drill-down table
 *
 * The four visualizations live in trends-view-*.js and self-register on
 * window.AOTrends. This file owns layout + data + which view is active + the
 * shared "sublime layer"; it does NOT know how any individual chart draws.
 *
 * Source: GET /v1/array-owners/fleet-trends.   Contract: TRENDS-VIEWS-CONTRACT.md
 * ==========================================================================*/
(function () {
  "use strict";

  const API = "/v1/array-owners/fleet-trends";
  const VIEW_KEY = "ao_trends_view";
  const C = () => window.AOTrends;
  const REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Per-view accent hue — retints the switcher pill, ambient glow and frame so
  // each visualization feels like its own room while staying one family.
  const ACCENT = {
    liquid:    "#3fd68a",
    spiral:    "#f5b942",
    ridgeline: "#5ec2ff",
    heatfield: "#ffd479",
  };

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function root() { return document.getElementById("trendsRoot"); }
  function savedView() { try { return localStorage.getItem(VIEW_KEY); } catch (e) { return null; } }
  function saveView(k) { try { localStorage.setItem(VIEW_KEY, k); } catch (e) {} }

  let _activeStop = null;   // cleanup fn for the currently-mounted view
  let _prepped = null;      // prepared data for the current payload
  let _switching = false;

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

  // ── animated count-up ──────────────────────────────────────────────────────
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  function countUp(el) {
    const target = parseFloat(el.getAttribute("data-target"));
    if (isNaN(target)) return;
    const dec = parseInt(el.getAttribute("data-dec") || "0", 10);
    const pre = el.getAttribute("data-pre") || "";
    const suf = el.getAttribute("data-suf") || "";
    const sign = el.getAttribute("data-sign") === "1";
    const dur = 1100;
    const fmt = v => {
      const s = sign && v > 0 ? "+" : "";
      const body = dec > 0
        ? Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
        : Math.round(Math.abs(v)).toLocaleString();
      return pre + (v < 0 ? "-" : s) + body + suf;
    };
    if (REDUCE) { el.textContent = fmt(target); return; }
    const t0 = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(target * easeOut(p));
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    })(t0);
  }

  function statBand(d) {
    const c = C();
    const years = d.years || [];
    const latestYr = years.length ? Math.max(...years) : null;
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
    const stat = (k, valHtml, extra) =>
      `<div class="tr-stat"${extra || ""}><span class="tr-glow"></span><div class="tr-k">${k}</div>${valHtml}</div>`;
    const num = (target, { dec = 0, pre = "", suf = "", sign = false, cls = "" } = {}) =>
      `<div class="tr-v ${cls}" data-target="${target}" data-dec="${dec}" data-pre="${pre}" data-suf="${suf}" data-sign="${sign ? 1 : 0}">${pre}0${suf}</div>`;
    const dash = `<div class="tr-v">—</div>`;
    return `<div class="tr-stats">
      ${stat("TRAILING 12 MO", d.ttm_kwh == null ? dash : num(d.ttm_kwh, { suf: " kWh" }))}
      ${stat("LIFETIME (FLEET)", d.lifetime_kwh == null ? dash : num(d.lifetime_kwh, { suf: " kWh" }))}
      ${stat("LATEST YOY", latestYoY == null ? dash : num(latestYoY, { dec: 1, suf: "%", sign: true, cls: latestYoY < 0 ? "neg" : "pos" }), ` title="${yoyTitle}"`)}
      ${stat("EST. SAVINGS (12 MO)", d.ttm_savings_usd == null ? dash : num(d.ttm_savings_usd, { pre: "$" }))}
    </div>`;
  }

  function switcher(activeKey) {
    const views = C().listViews();
    return `<div class="tr-switch" role="tablist" aria-label="Chart style">
      <span class="tr-switch-ind" aria-hidden="true"></span>` + views.map(v =>
      `<button class="tr-seg ${v.key === activeKey ? "on" : ""}" data-view="${v.key}" role="tab" aria-selected="${v.key === activeKey}">
        <span class="tr-seg-b">${C().esc(v.badge || "")}</span><span class="tr-seg-lbl">${C().esc(v.label)}</span>
      </button>`).join("") + `</div>`;
  }

  // slide the indicator pill under the active segment
  function moveIndicator() {
    const sw = document.querySelector(".tr-switch");
    const ind = document.querySelector(".tr-switch-ind");
    const on = document.querySelector(".tr-seg.on");
    if (!sw || !ind || !on) return;
    const r = on.getBoundingClientRect(), pr = sw.getBoundingClientRect();
    ind.style.width = r.width + "px";
    ind.style.transform = `translateX(${r.left - pr.left - 4}px)`;
    ind.style.opacity = "1";
  }

  function byArrayTable(byArray) {
    const c = C();
    if (!byArray || !byArray.length) return "";
    const rows = byArray.map((a, i) =>
      `<tr style="--ri:${i}"><td class="tr-aname">${c.esc(a.name)}</td>
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

  function applyAccent(key) {
    const block = document.querySelector(".tr-chartblock");
    if (block && ACCENT[key]) block.style.setProperty("--tr-accent", ACCENT[key]);
  }

  function doMount(key) {
    const c = C();
    const view = c.getView(key) || c.listViews()[0];
    if (!view) return;
    teardown();
    document.querySelectorAll(".tr-seg").forEach(b => {
      const on = b.getAttribute("data-view") === view.key;
      b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
    });
    moveIndicator();
    applyAccent(view.key);
    const desc = document.getElementById("trViewDesc");
    if (desc) { desc.textContent = view.describe || ""; }
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

  // crossfade: dim current out, swap, fade new in (calm, ~190ms each way)
  function mountView(key, opts) {
    opts = opts || {};
    const host = document.getElementById("trChartHost");
    const desc = document.getElementById("trViewDesc");
    if (!host || opts.immediate || REDUCE) { doMount(key); fadeIn(host, desc); return; }
    if (_switching) return;
    _switching = true;
    host.classList.add("tr-fading");
    if (desc) desc.classList.add("tr-fading");
    setTimeout(() => {
      doMount(key);
      fadeIn(host, desc);
      _switching = false;
    }, 190);
  }
  function fadeIn(host, desc) {
    if (!host) return;
    requestAnimationFrame(() => {
      host.classList.remove("tr-fading");
      if (desc) desc.classList.remove("tr-fading");
    });
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
      <div class="tr-block tr-chartblock" style="--tr-accent:${ACCENT[active] || "#3fd68a"}">
        <span class="tr-ambient" aria-hidden="true"></span>
        <div class="tr-chart-head">
          ${switcher(active)}
        </div>
        <div class="tr-view-desc" id="trViewDesc"></div>
        <div class="tr-chart-host" id="trChartHost"></div>
      </div>
      ${byArrayTable(d.by_array)}
    `;

    // animate the stat numbers up
    r.querySelectorAll(".tr-v[data-target]").forEach(countUp);

    // wire switcher
    r.querySelectorAll(".tr-seg").forEach(btn => {
      btn.addEventListener("click", () => mountView(btn.getAttribute("data-view")));
    });
    // keep the indicator glued to the active segment on resize
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => moveIndicator());
      const sw = r.querySelector(".tr-switch"); if (sw) ro.observe(sw);
    } else {
      window.addEventListener("resize", moveIndicator);
    }

    mountView(active, { immediate: true });
    // indicator needs layout; nudge after paint + on web-font settle
    requestAnimationFrame(moveIndicator);
    setTimeout(moveIndicator, 220);
  }

  function load() {
    const s = session();
    if (!s) { empty("Sign in to see your fleet's multi-year production trends."); return; }
    if (!window.AOTrends || !C().listViews().length) {
      return void setTimeout(load, 60);   // core/views not ready yet
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
