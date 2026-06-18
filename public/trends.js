/* ============================================================================
 * Array Operator — Trends tab (trends.js)
 *
 * Paul Bozuwa's "macro-level tab for multi-year trend lines." Shows
 * PORTFOLIO-WIDE production: every array the owner has, summed, drawn as one
 * line per year over Jan–Dec so seasonality + year-over-year growth read at a
 * glance — plus a seasonal YoY strip and a per-array drill-down.
 *
 * Self-contained: exposes window.__aoLoadTrends(); sandbox.js's applyView()
 * calls it when the #trends tab is active. Same-origin /v1/* → Railway backend.
 * Dependency-free inline SVG chart (matches the app's no-build vanilla stack).
 *
 * Source: GET /v1/array-owners/fleet-trends.
 * ==========================================================================*/
(function () {
  "use strict";

  const API = "/v1/array-owners/fleet-trends";
  const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

  // 8 distinct hues so up to 8 years never share a color; latest = bold green.
  const PALETTE = [
    "#3fd68a", // good green — latest year (bold)
    "#e6a23c", // amber
    "#5aa9e6", // sky
    "#c9772e", // wood
    "#2bb6a8", // teal
    "#9aa0aa", // slate
    "#b07cf0", // violet
    "#d4a017", // gold
  ];

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmt0 = n => n == null ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const kCompact = n => {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  };

  function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
  function root() { return document.getElementById("trendsRoot"); }

  /** Deterministic color: newest year = boldest palette entry. */
  function yearColor(year, years) {
    const desc = [...years].sort((a, b) => b - a);
    const i = desc.indexOf(year);
    return PALETTE[(i < 0 ? years.length : i) % PALETTE.length];
  }

  function loading() {
    const r = root(); if (!r) return;
    r.innerHTML = '<div class="empty" style="padding:34px 0;color:var(--faint)">Loading trends…</div>';
  }

  function empty(msg) {
    const r = root(); if (!r) return;
    r.innerHTML = `<div class="tr-empty">
      <div class="tr-empty-ic" aria-hidden="true">📈</div>
      <div class="tr-empty-h">Not enough history yet</div>
      <div class="tr-empty-p">${esc(msg || "Multi-year trends appear once your arrays have logged a few months of production. Connect your arrays on the Arrays tab to start building history.")}</div>
    </div>`;
  }

  // ── multi-year line chart (inline SVG) ─────────────────────────────────────
  function lineChart(monthlyByYear, years) {
    const VB_W = 760, VB_H = 320;
    const PAD = { top: 18, right: 18, bottom: 28, left: 44 };
    const plotW = VB_W - PAD.left - PAD.right;
    const plotH = VB_H - PAD.top - PAD.bottom;

    // peak across all years/months for the y-scale
    let peak = 0;
    years.forEach(y => (monthlyByYear[String(y)] || []).forEach(p => {
      if (p.kwh > peak) peak = p.kwh;
    }));
    if (peak <= 0) peak = 1;
    const niceTop = peak * 1.08;

    const x = m => PAD.left + (plotW * (m - 1)) / 11;       // month 1..12
    const y = v => PAD.top + plotH * (1 - v / niceTop);

    // gridlines + y labels (4 steps)
    let grid = "";
    for (let i = 0; i <= 4; i++) {
      const val = (niceTop * i) / 4;
      const gy = y(val);
      grid += `<line x1="${PAD.left}" y1="${gy}" x2="${VB_W - PAD.right}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>`;
      grid += `<text x="${PAD.left - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--faint)">${kCompact(val)}</text>`;
    }
    // month labels
    let xlabels = "";
    for (let m = 1; m <= 12; m++) {
      xlabels += `<text x="${x(m)}" y="${VB_H - 8}" text-anchor="middle" font-size="9" fill="var(--faint)">${MONTHS[m - 1]}</text>`;
    }
    // one polyline per year (oldest first so latest draws on top)
    const ordered = [...years].sort((a, b) => a - b);
    let lines = "";
    ordered.forEach(yr => {
      const pts = (monthlyByYear[String(yr)] || []);
      if (!pts.length) return;
      const isLatest = yr === Math.max(...years);
      const c = yearColor(yr, years);
      const d = pts.map(p => `${x(p.month).toFixed(1)},${y(p.kwh).toFixed(1)}`).join(" ");
      lines += `<polyline points="${d}" fill="none" stroke="${c}" stroke-width="${isLatest ? 2.6 : 1.5}" stroke-linejoin="round" stroke-linecap="round" opacity="${isLatest ? 1 : 0.85}"/>`;
      pts.forEach(p => {
        lines += `<circle cx="${x(p.month).toFixed(1)}" cy="${y(p.kwh).toFixed(1)}" r="${isLatest ? 2.6 : 1.8}" fill="${c}"/>`;
      });
    });

    return `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="tr-svg" role="img" aria-label="Monthly kWh by year">
      ${grid}${lines}${xlabels}
    </svg>`;
  }

  function legend(years) {
    const desc = [...years].sort((a, b) => b - a);
    return `<div class="tr-legend">` + desc.map(yr =>
      `<span class="tr-leg"><span class="tr-dot" style="background:${yearColor(yr, years)}"></span>${yr}</span>`
    ).join("") + `</div>`;
  }

  function seasonalGrid(seasonal) {
    if (!seasonal || !seasonal.length) return "";
    const cards = seasonal.map(s => {
      const years = Object.keys(s.by_year).map(Number).sort((a, b) => b - a);
      const latestYr = years[0];
      const latestVal = s.by_year[String(latestYr)];
      const d = s.latest_delta_pct;
      let delta = "";
      if (d != null) {
        const up = d >= 0;
        delta = `<span class="tr-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}%</span>`;
      } else {
        delta = `<span class="tr-delta flat">—</span>`;
      }
      return `<div class="tr-scard">
        <div class="tr-sm">${esc(s.label).toUpperCase()}</div>
        <div class="tr-sv">${fmt0(latestVal)}</div>
        ${delta}
      </div>`;
    }).join("");
    return `<div class="tr-block">
      <div class="tr-block-h">SEASONAL YEAR-OVER-YEAR</div>
      <div class="tr-block-sub">Latest year's fleet total per month, with the change vs the prior year.</div>
      <div class="tr-sgrid">${cards}</div>
    </div>`;
  }

  function byArrayTable(byArray) {
    if (!byArray || !byArray.length) return "";
    const rows = byArray.map(a =>
      `<tr><td class="tr-aname">${esc(a.name)}</td>
        <td class="tr-anum">${fmt0(a.lifetime_kwh)} kWh</td>
        <td class="tr-ayears">${(a.years || []).join(", ") || "—"}</td></tr>`
    ).join("");
    return `<div class="tr-block">
      <div class="tr-block-h">BY ARRAY</div>
      <div class="tr-block-sub">Lifetime production and the years on record for each array in your fleet.</div>
      <div class="tr-tablewrap"><table class="tr-table">
        <thead><tr><th>Array</th><th class="tr-anum">Lifetime</th><th>Years</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  function render(d) {
    const r = root(); if (!r) return;
    const years = d.years || [];
    if (!years.length) { empty(); return; }

    const latestYr = Math.max(...years);
    // latest fleet YoY (sum of seasonal latest deltas isn't right; derive from
    // Latest fleet YoY — compare ONLY the months present in BOTH the latest and
    // prior year (apples-to-apples). A partial current year (e.g. Jan–Jun) must
    // not be compared against a full prior year, or the headline reads a scary
    // false -47%. Null when there's no overlapping month.
    let latestYoY = null;
    let yoyMonths = 0;
    if (years.length >= 2) {
      const prevYr = years[years.length - 2];
      const cur = d.monthly_by_year[String(latestYr)] || [];
      const prev = d.monthly_by_year[String(prevYr)] || [];
      const prevByMonth = {};
      prev.forEach(p => { prevByMonth[p.month] = p.kwh || 0; });
      let curSum = 0, prevSum = 0;
      cur.forEach(p => {
        if (prevByMonth[p.month] != null) {
          curSum += (p.kwh || 0);
          prevSum += prevByMonth[p.month];
          yoyMonths++;
        }
      });
      if (prevSum > 0 && yoyMonths > 0) latestYoY = (100 * (curSum - prevSum) / prevSum);
    }
    const yoyTitle = yoyMonths > 0
      ? `${latestYr} vs ${years[years.length - 2]}, same ${yoyMonths} month${yoyMonths === 1 ? "" : "s"}`
      : "year over year";

    r.innerHTML = `
      <div class="tr-stats">
        <div class="tr-stat"><div class="tr-k">TRAILING 12 MO</div><div class="tr-v">${fmt0(d.ttm_kwh)} kWh</div></div>
        <div class="tr-stat"><div class="tr-k">LIFETIME (FLEET)</div><div class="tr-v">${fmt0(d.lifetime_kwh)} kWh</div></div>
        <div class="tr-stat" title="${yoyTitle}"><div class="tr-k">LATEST YOY</div><div class="tr-v ${latestYoY != null && latestYoY < 0 ? "neg" : "pos"}">${latestYoY == null ? "—" : (latestYoY >= 0 ? "+" : "") + latestYoY.toFixed(1) + "%"}</div></div>
        <div class="tr-stat"><div class="tr-k">EST. SAVINGS (12 MO)</div><div class="tr-v">${d.ttm_savings_usd == null ? "—" : "$" + fmt0(d.ttm_savings_usd)}</div></div>
      </div>

      <div class="tr-block">
        <div class="tr-block-h">MONTHLY KWH BY YEAR — WHOLE FLEET</div>
        <div class="tr-block-sub">Each line is a year, Jan–Dec, summed across all your arrays.</div>
        ${legend(years)}
        ${lineChart(d.monthly_by_year || {}, years)}
      </div>

      ${seasonalGrid(d.seasonal_yoy)}
      ${byArrayTable(d.by_array)}
    `;
  }

  function load() {
    const s = session();
    if (!s) { empty("Sign in to see your fleet's multi-year production trends."); return; }
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
        const r = root();
        if (r) r.innerHTML = `<div class="tr-empty"><div class="tr-empty-ic">⚠️</div>
          <div class="tr-empty-h">Couldn't load trends</div>
          <div class="tr-empty-p">Something went wrong fetching your production history. <a href="#trends" onclick="window.__aoLoadTrends&&window.__aoLoadTrends();return false" style="color:var(--good)">Try again</a>.</div></div>`;
      });
  }

  window.__aoLoadTrends = load;
})();
