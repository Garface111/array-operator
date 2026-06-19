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
    bars:      "#3fd68a",
    monthly:   "#3fd68a",
    liquid:    "#3fd68a",
    spiral:    "#f5b942",
    ridgeline: "#5ec2ff",
    heatfield: "#ffd479",
  };

  // Views that need 2+ years of history to be meaningful (decorative multi-year
  // art). With a single year they render near-empty, so we caption them honestly
  // rather than letting them look broken.
  const MULTIYEAR_VIEWS = { liquid: 1, spiral: 1, ridgeline: 1, heatfield: 1 };

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function root() { return document.getElementById("trendsRoot"); }
  function savedView() { try { return localStorage.getItem(VIEW_KEY); } catch (e) { return null; } }
  function saveView(k) { try { localStorage.setItem(VIEW_KEY, k); } catch (e) {} }

  let _activeStops = [];    // cleanup fns for every mounted view (stacked column)
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
    for (const stop of _activeStops) { try { stop(); } catch (e) {} }
    _activeStops = [];
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

  // Data-freshness + coverage line — a power user wants to know "through when,
  // and how many arrays are actually reporting" before trusting the numbers.
  function freshnessLine(d) {
    const c = C();
    const daily = d.daily_recent || [];
    let lastDay = null;
    for (const pt of daily) { if (pt && pt.day) lastDay = pt.day; }
    const arrays = d.by_array || [];
    const reporting = arrays.filter(a => (a.lifetime_kwh || 0) > 0).length;
    const total = arrays.length;
    const parts = [];
    if (lastDay) {
      const dt = new Date(lastDay + "T00:00:00");
      const ago = Math.round((Date.now() - dt.getTime()) / 86400000);
      const when = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      parts.push(`Through <b>${c.esc(when)}</b>${ago > 1 ? ` (${ago}d ago)` : ago === 1 ? " (yesterday)" : " (today)"}`);
    }
    if (total) parts.push(`<b>${reporting}</b>/${total} array${total === 1 ? "" : "s"} reporting`);
    if (!parts.length) return "";
    return `<div class="tr-fresh">${parts.join(" · ")}
      <button class="tr-export" id="trExport" type="button" title="Download monthly + daily production as CSV">↓ Export CSV</button></div>`;
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
    // Best single month on record (a real, satisfying number even with 1 year).
    let bestKwh = null, bestLabel = "";
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const y of years) {
      for (const p of (d.monthly_by_year[String(y)] || [])) {
        if (bestKwh == null || (p.kwh || 0) > bestKwh) { bestKwh = p.kwh || 0; bestLabel = `${MON[p.month - 1]} ${y}`; }
      }
    }
    // Implied blended rate behind the savings number, for the tooltip.
    const rate = (d.ttm_savings_usd && d.ttm_kwh) ? (d.ttm_savings_usd / d.ttm_kwh) : null;
    const yoyTitle = yoyMonths > 0
      ? `${latestYr} vs ${prevYr}, same ${yoyMonths} month${yoyMonths === 1 ? "" : "s"}`
      : "Year-over-year appears once you have two years of history";
    const savTitle = rate ? `≈ $${rate.toFixed(3)}/kWh blended rate × trailing-12-mo kWh` : "Estimated value of the energy produced";

    const stat = (k, valHtml, extra) =>
      `<div class="tr-stat"${extra || ""}><span class="tr-glow"></span><div class="tr-k">${k}</div>${valHtml}</div>`;
    const num = (target, { dec = 0, pre = "", suf = "", sign = false, cls = "" } = {}) =>
      `<div class="tr-v ${cls}" data-target="${target}" data-dec="${dec}" data-pre="${pre}" data-suf="${suf}" data-sign="${sign ? 1 : 0}">${pre}0${suf}</div>`;
    const dash = `<div class="tr-v tr-v-dim">—</div>`;
    const txt = (s, cls) => `<div class="tr-v ${cls || ""}">${s}</div>`;

    // 4th tile is adaptive: show real YoY when we have 2+ years; otherwise show
    // BEST MONTH (a meaningful number) instead of a confusing "—".
    const fourth = latestYoY != null
      ? stat("LATEST YOY", num(latestYoY, { dec: 1, suf: "%", sign: true, cls: latestYoY < 0 ? "neg" : "pos" }), ` title="${yoyTitle}"`)
      : stat("BEST MONTH", (bestKwh != null
          ? `<div class="tr-v">${c.fmt0(bestKwh)}<span class="tr-v-unit"> kWh</span></div><div class="tr-v-sub">${c.esc(bestLabel)}</div>`
          : dash));

    return `<div class="tr-stats">
      ${stat("TRAILING 12 MO", d.ttm_kwh == null ? dash : `${num(d.ttm_kwh, { suf: " kWh" })}`)}
      ${stat("LIFETIME (FLEET)", d.lifetime_kwh == null ? dash : num(d.lifetime_kwh, { suf: " kWh" }))}
      ${stat("EST. VALUE (12 MO)", d.ttm_savings_usd == null ? dash : num(d.ttm_savings_usd, { pre: "$" }), ` title="${savTitle}"`)}
      ${fourth}
    </div>`;
  }

  // Build a CSV of monthly + daily production and trigger a download.
  function exportCsv(d) {
    const rows = [["section", "period", "kwh"]];
    const years = (d.years || []).slice().sort((a, b) => a - b);
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const y of years) {
      for (const p of (d.monthly_by_year[String(y)] || [])) {
        rows.push(["monthly", `${y}-${String(p.month).padStart(2, "0")} (${MON[p.month - 1]} ${y})`, p.kwh]);
      }
    }
    for (const pt of (d.daily_recent || [])) rows.push(["daily", pt.day, pt.kwh]);
    const csv = rows.map(r => r.map(v => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `array-operator-production-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    // Default sort: most production first (a power user scans top performers).
    const rows = byArray.slice().sort((a, b) => (b.lifetime_kwh || 0) - (a.lifetime_kwh || 0));
    const total = rows.reduce((s, a) => s + (a.lifetime_kwh || 0), 0) || 1;
    const body = rows.map((a, i) => {
      const kwh = a.lifetime_kwh || 0;
      const share = Math.round((kwh / total) * 100);
      const yrs = (a.years || []).join(", ");
      const dead = kwh <= 0;
      const status = dead
        ? `<span class="tr-astat tr-astat-none" title="No production on record yet — newly connected, or awaiting its first data pull">no data yet</span>`
        : `<span class="tr-astat tr-astat-ok">${share}% of fleet</span>`;
      return `<tr style="--ri:${i}" class="${dead ? "tr-arow-dim" : ""}">
        <td class="tr-aname">${c.esc(a.name)}</td>
        <td class="tr-anum">${dead ? "—" : c.fmt0(kwh) + " kWh"}</td>
        <td>${status}</td>
        <td class="tr-ayears">${yrs || "—"}</td></tr>`;
    }).join("");
    return `<div class="tr-block">
      <div class="tr-block-h">BY ARRAY</div>
      <div class="tr-block-sub">Lifetime production, share of fleet, and the years on record for each array — most productive first.</div>
      <div class="tr-tablewrap"><table class="tr-table">
        <thead><tr><th>Array</th><th class="tr-anum">Lifetime</th><th>Share</th><th>Years</th></tr></thead>
        <tbody>${body}</tbody>
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
    teardown();

    const views = c.listViews();   // ordered: bars, monthly, liquid, spiral, heatfield…
    const singleYear = years.length < 2;

    // Stat band + ONE block per visualization, stacked in a column. Each block
    // carries its own accent + ambient glow + title/description, and hosts its
    // own canvas. No switcher, no tabbing — the operator scrolls the column.
    // Multi-year art is captioned honestly when there's <2 years of history so
    // a near-empty chart reads as "needs more history", not "broken".
    const blocks = views.map(v => {
      const needsYears = singleYear && MULTIYEAR_VIEWS[v.key];
      const note = needsYears
        ? `<div class="tr-needyears">Fills in once you have a second year of history — comparing years is what this view is for.</div>`
        : "";
      return `
      <div class="tr-block tr-chartblock tr-stacked${needsYears ? " tr-dimmed" : ""}" style="--tr-accent:${ACCENT[v.key] || "#3fd68a"}">
        <span class="tr-ambient" aria-hidden="true"></span>
        <div class="tr-stack-head">
          <span class="tr-stack-dot" aria-hidden="true"></span>
          <h3 class="tr-stack-title">${c.esc(v.label)}</h3>
          ${needsYears ? `<span class="tr-stack-tag">needs 2+ years</span>` : ""}
        </div>
        <div class="tr-view-desc">${c.esc(v.describe || "")}</div>
        ${note}
        <div class="tr-chart-host" id="trHost_${v.key}"></div>
      </div>`;
    }).join("");

    r.innerHTML = `
      ${statBand(d)}
      ${freshnessLine(d)}
      ${blocks}
      ${byArrayTable(d.by_array)}
    `;

    // animate the stat numbers up
    r.querySelectorAll(".tr-v[data-target]").forEach(countUp);

    // wire the CSV export
    const ex = document.getElementById("trExport");
    if (ex) ex.addEventListener("click", () => exportCsv(d));

    // mount every view into its own host
    for (const v of views) {
      const host = document.getElementById("trHost_" + v.key);
      if (!host) continue;
      host.style.position = "relative";
      try {
        const stop = v.mount(host, _prepped, c);
        if (stop) _activeStops.push(stop);
      } catch (e) {
        host.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">This view hit an error.</div></div>`;
        if (window.console) console.error("trends view " + v.key + " failed", e);
      }
    }
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
