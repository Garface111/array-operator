/* ============================================================================
 * Array Operator — Production Analytics (trends-analytics.js)
 *
 * The KEYSTONE analytics surface for the Trends tab — a single, competitor-grade
 * instrument that does what GMP / SolarEdge / Fronius / SMA / CHINT each show in
 * their own portal, unified across the whole multi-vendor fleet (which none of
 * them can do, because each only sees its own ecosystem):
 *
 *   • Granularity toggle  Day · Month · Year · Lifetime   (SolarEdge/Fronius/SMA)
 *   • Period navigation    ‹ prev / next ›  within the active granularity
 *   • Prior-period comparison overlay + delta%             (all of them)
 *   • Multi-vendor data attribution bar                    (AO-only edge)
 *   • Environmental impact (CO₂ / trees / cars / homes)    (SolarEdge/Fronius/SMA/CHINT)
 *   • Specific yield kWh/kWp + system size                 (SolarEdge/SMA)
 *   • Production records (best day / best month / peak)    (SolarEdge/Fronius)
 *
 * Mounted by trends.js as the LEAD block (above the existing six views, which
 * are untouched). Self-contained vanilla JS; reuses window.AOTrends tokens.
 *
 * Public API:  window.AOAnalytics.mount(hostEl, payload, core) -> stopFn
 * ==========================================================================*/
(function () {
  "use strict";

  const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Stable color per data-source family for the attribution layer.
  const SRC_COLOR = {
    gmp:       "#5ec2ff",  // utility meter — sky
    solaredge: "#3fd68a",  // brand green
    fronius:   "#f5b942",  // gold
    sma:       "#b07cf0",  // violet
    chint:     "#2bb6a8",  // teal
    inverter:  "#7ff0bb",  // light green (generic extension feed)
    csv:       "#9aa0aa",  // gray
    manual:    "#8b97a8",
    bill:      "#6b7686",
    other:     "#566072",
  };

  function fmt0(n) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
  function fmt1(n) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function kCompact(n) {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e6) return (n/1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/,"") + "M";
    if (a >= 1e3) return (n/1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/,"") + "k";
    return String(Math.round(n));
  }
  function hexA(hex, a) {
    if (!hex || hex[0] !== "#") return hex || "rgba(63,214,138," + a + ")";
    const h = hex.replace("#",""); 
    const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── data shaping ───────────────────────────────────────────────────────────
  // Build the canonical structures every granularity needs from the raw payload.
  function shape(d) {
    const years = (d.years || []).slice().sort((a,b)=>a-b);
    const monthly = d.monthly_by_year || {};
    // annual totals
    const annual = years.map(y => ({
      year: y,
      kwh: (monthly[String(y)] || []).reduce((s,p)=>s+(p.kwh||0), 0),
    }));
    // month lookup: {year: {month: kwh}}
    const mlut = {};
    years.forEach(y => {
      mlut[y] = {};
      (monthly[String(y)] || []).forEach(p => { mlut[y][p.month] = p.kwh || 0; });
    });
    // daily series → sorted [{date, kwh}]
    const daily = (d.daily_series && d.daily_series.length ? d.daily_series : (d.daily_recent || []))
      .map(p => ({ date: p.day, kwh: p.kwh || 0 }))
      .filter(p => p.date)
      .sort((a,b) => a.date < b.date ? -1 : 1);
    const dlut = {}; daily.forEach(p => dlut[p.date] = p.kwh);
    // months that actually have daily data (YYYY-MM keys) — for Day nav
    const dayMonths = [];
    const seenDM = {};
    daily.forEach(p => { const k = p.date.slice(0,7); if (!seenDM[k]) { seenDM[k]=1; dayMonths.push(k); } });
    return { years, monthly, annual, mlut, daily, dlut, dayMonths,
             sources: d.source_breakdown || [],
             capacity: d.capacity_kw, capacityArrays: d.capacity_known_arrays || 0,
             specYield: d.specific_yield_ttm_kwh_per_kwp,
             env: d.environmental, rate: d.blended_rate_usd_per_kwh,
             ttm: d.ttm_kwh, lifetime: d.lifetime_kwh };
  }

  // Records computed honestly from the data we hold.
  function records(S) {
    let bestMonth = null, bestDay = null;
    S.years.forEach(y => MON3.forEach((lbl,i) => {
      const k = (S.mlut[y]||{})[i+1];
      if (k != null && (bestMonth == null || k > bestMonth.kwh)) bestMonth = { kwh: k, label: `${lbl} ${y}` };
    }));
    S.daily.forEach(p => { if (bestDay == null || p.kwh > bestDay.kwh) bestDay = { kwh: p.kwh, label: p.date }; });
    return { bestMonth, bestDay };
  }

  // ── tiny canvas helper (hi-DPI, redraw-on-demand, hover) ────────────────────
  function makeCanvas(host, aspect) {
    const cv = document.createElement("canvas");
    cv.style.width = "100%"; cv.style.display = "block"; cv.style.borderRadius = "12px";
    cv.style.cursor = "crosshair";
    host.appendChild(cv);
    const ctx = cv.getContext("2d");
    let w=0,h=0,dpr=1,drawFn=null;
    function fit() {
      const cssW = host.clientWidth || 720;
      let cssH = Math.max(220, Math.min(420, cssW / (aspect||2.6)));
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      w=cssW; h=cssH;
      cv.style.height = cssH+"px"; cv.width = Math.round(cssW*dpr); cv.height = Math.round(cssH*dpr);
      redraw();
    }
    function redraw() {
      if (!ctx) return;
      ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
      if (drawFn) drawFn(ctx,w,h);
    }
    let ro=null;
    if (window.ResizeObserver) { ro=new ResizeObserver(fit); ro.observe(host); }
    else window.addEventListener("resize", fit);
    fit();
    return {
      cv, ctx, get w(){return w;}, get h(){return h;},
      set draw(fn){ drawFn=fn; redraw(); },
      redraw,
      destroy(){ if (ro) ro.disconnect(); else window.removeEventListener("resize", fit); }
    };
  }

  // ── chart drawing: a grouped/comparison bar chart ───────────────────────────
  // series = [{label, kwh, sub}], cmp = optional [{kwh}] aligned by index.
  function drawBars(ctx, w, h, series, cmp, accent, hoverIdx) {
    const padL = 46, padR = 12, padT = 16, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    let peak = 1;
    series.forEach(s => { if (s.kwh > peak) peak = s.kwh; });
    if (cmp) cmp.forEach(c => { if (c && c.kwh > peak) peak = c.kwh; });
    peak *= 1.12;
    // gridlines + y labels
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    const lines = 4;
    for (let i=0;i<=lines;i++){
      const yv = peak * i/lines;
      const y = padT + plotH - (yv/peak)*plotH;
      ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
      ctx.fillStyle = "#6b7686"; ctx.textAlign = "right";
      ctx.fillText(kCompact(yv), padL-8, y);
    }
    const n = series.length || 1;
    const slot = plotW / n;
    const hasCmp = cmp && cmp.some(c => c && c.kwh > 0);
    const barW = Math.min(hasCmp ? slot*0.30 : slot*0.6, 46);
    series.forEach((s,i) => {
      const cx = padL + slot*i + slot/2;
      // comparison (prior period) — ghosted bar behind/left
      if (hasCmp && cmp[i]) {
        const cv = cmp[i].kwh || 0;
        const ch = (cv/peak)*plotH;
        const cxb = cx - barW*0.6;
        ctx.fillStyle = "rgba(255,255,255,.16)";
        roundRect(ctx, cxb - barW/2, padT+plotH-ch, barW, ch, 3); ctx.fill();
      }
      const v = s.kwh || 0;
      const bh = (v/peak)*plotH;
      const xb = hasCmp ? cx + barW*0.6 : cx;
      const on = i === hoverIdx;
      const g = ctx.createLinearGradient(0, padT+plotH-bh, 0, padT+plotH);
      g.addColorStop(0, on ? "#ffffff" : accent);
      g.addColorStop(1, hexA(accent, on ? 0.65 : 0.42));
      ctx.fillStyle = g;
      ctx.shadowColor = hexA(accent, 0.5); ctx.shadowBlur = on ? 16 : 8;
      roundRect(ctx, xb - barW/2, padT+plotH-bh, barW, Math.max(bh,1.5), 3); ctx.fill();
      ctx.shadowBlur = 0;
      // x label (skip some when crowded)
      const everyN = n > 16 ? Math.ceil(n/12) : 1;
      if (i % everyN === 0 || on) {
        ctx.fillStyle = on ? "#eaf0f7" : "#8b97a8";
        ctx.textAlign = "center"; ctx.font = (on?"600 ":"")+"11px system-ui, sans-serif";
        ctx.fillText(s.label, cx, h - padB + 14);
      }
    });
    return { padL, padR, padT, padB, plotW, plotH, slot, n };
  }

  function roundRect(ctx,x,y,w,h,r){
    r = Math.min(r, w/2, h/2); if (r<0) r=0;
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }

  // ── the surface ─────────────────────────────────────────────────────────────
  function mount(host, payload, core) {
    const S = shape(payload);
    const accentFor = { day:"#5ec2ff", month:"#3fd68a", year:"#f5b942", lifetime:"#7ff0bb" };

    // available granularities (don't offer Day if we have no daily data)
    const grans = [];
    if (S.daily.length) grans.push(["day","Day"]);
    grans.push(["month","Month"], ["year","Year"], ["lifetime","Lifetime"]);

    // restore last granularity
    let gran = "month";
    try { const sv = localStorage.getItem("ao_analytics_gran"); if (sv && grans.some(g=>g[0]===sv)) gran = sv; } catch(e){}
    // period cursors
    let yearIdx = S.years.length - 1;          // for Month granularity
    let dayMonthIdx = S.dayMonths.length - 1;   // for Day granularity
    let compare = true;                         // prior-period overlay toggle

    const rec = records(S);

    // ----- DOM scaffold -----
    const el = document.createElement("div");
    el.className = "an-wrap";
    el.innerHTML = `
      <div class="an-head">
        <div class="an-titlewrap">
          <h3 class="an-title">Production Analytics</h3>
          <div class="an-sub">Day · Month · Year · Lifetime — comparison, vendor attribution, environmental impact &amp; specific yield, the whole fleet in one view.</div>
        </div>
        <div class="an-gran" role="tablist" aria-label="Granularity">
          ${grans.map(g=>`<button class="an-g ${g[0]===gran?"on":""}" data-g="${g[0]}" role="tab" aria-selected="${g[0]===gran}">${g[1]}</button>`).join("")}
        </div>
      </div>
      <div class="an-navrow">
        <div class="an-nav">
          <button class="an-navbtn" data-nav="prev" aria-label="Previous period">‹</button>
          <span class="an-period" id="anPeriod">—</span>
          <button class="an-navbtn" data-nav="next" aria-label="Next period">›</button>
        </div>
        <label class="an-cmp"><input type="checkbox" id="anCmp" ${compare?"checked":""}> <span>Compare prior period</span></label>
      </div>
      <div class="an-deltarow" id="anDelta"></div>
      <div class="an-chart" id="anChart"></div>
      <div class="an-kpis" id="anKpis"></div>
      <div class="an-grid">
        <div class="an-card an-attr">
          <div class="an-card-h">Data sources <span class="an-card-tag">where every kWh comes from</span></div>
          <div id="anAttr"></div>
        </div>
        <div class="an-card an-env">
          <div class="an-card-h">Environmental impact</div>
          <div id="anEnv"></div>
        </div>
      </div>
      <div class="an-records" id="anRecords"></div>
    `;
    host.appendChild(el);

    const chartHost = el.querySelector("#anChart");
    const cvs = makeCanvas(chartHost, 2.6);
    const tip = document.createElement("div");
    tip.className = "an-tip"; tip.style.display = "none";
    chartHost.style.position = "relative";
    chartHost.appendChild(tip);

    let hoverIdx = -1;
    let curSeries = [], curCmp = null, curAccent = "#3fd68a";

    // ----- series builders per granularity -----
    function buildSeries() {
      const accent = accentFor[gran] || "#3fd68a";
      let series = [], cmp = null, periodLabel = "", cmpLabel = "";
      if (gran === "year") {
        series = S.annual.map(a => ({ label: String(a.year), kwh: a.kwh, sub: `${a.year}` }));
        periodLabel = S.years.length ? `${S.years[0]}–${S.years[S.years.length-1]}` : "All years";
      } else if (gran === "lifetime") {
        // cumulative monthly running total across all years
        let run = 0; series = [];
        S.years.forEach(y => MON3.forEach((lbl,i) => {
          const k = (S.mlut[y]||{})[i+1];
          if (k != null) { run += k; series.push({ label: `${lbl.slice(0,1)}${String(y).slice(2)}`, kwh: run, sub: `${lbl} ${y} cumulative` }); }
        }));
        periodLabel = "Cumulative to date";
      } else if (gran === "month") {
        const y = S.years[yearIdx];
        series = MON3.map((lbl,i) => ({ label: lbl, kwh: (S.mlut[y]||{})[i+1] || 0, sub: `${lbl} ${y}` }));
        periodLabel = String(y);
        if (compare && yearIdx > 0) {
          const py = S.years[yearIdx-1];
          cmp = MON3.map((lbl,i) => ({ kwh: (S.mlut[py]||{})[i+1] || 0 }));
          cmpLabel = String(py);
        }
      } else if (gran === "day") {
        const ym = S.dayMonths[dayMonthIdx];        // "YYYY-MM"
        const [yy,mm] = ym.split("-").map(Number);
        const dim = new Date(yy, mm, 0).getDate();
        series = [];
        for (let dd=1; dd<=dim; dd++) {
          const key = `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
          series.push({ label: String(dd), kwh: S.dlut[key] || 0, sub: `${MON3[mm-1]} ${dd}, ${yy}` });
        }
        periodLabel = `${MON3[mm-1]} ${yy}`;
        if (compare) {
          // prior month with data, aligned by day-of-month
          const pIdx = dayMonthIdx - 1;
          if (pIdx >= 0) {
            const pym = S.dayMonths[pIdx]; const [pyy,pmm] = pym.split("-").map(Number);
            cmp = series.map((s,i) => {
              const dd = i+1; const key = `${pyy}-${String(pmm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
              return { kwh: S.dlut[key] || 0 };
            });
            cmpLabel = `${MON3[pmm-1]} ${pyy}`;
          }
        }
      }
      return { series, cmp, accent, periodLabel, cmpLabel };
    }

    function navVisible() { return gran === "month" || gran === "day"; }
    function canPrev() { return gran === "month" ? yearIdx > 0 : gran === "day" ? dayMonthIdx > 0 : false; }
    function canNext() { return gran === "month" ? yearIdx < S.years.length-1 : gran === "day" ? dayMonthIdx < S.dayMonths.length-1 : false; }

    function renderDelta(b) {
      const dEl = el.querySelector("#anDelta");
      // For a PARTIAL current period (e.g. Jan–Aug of this year), only compare
      // against the SAME months of the prior period — never partial-vs-full,
      // which would understate the current period. Align by the months that
      // actually carry data in the current series.
      let curSum = 0, csum = 0, cmpMonths = 0;
      const hasData = b.series.map(s => (s.kwh || 0) > 0);
      const lastWithData = hasData.lastIndexOf(true);
      b.series.forEach((x,i) => {
        if (gran === "lifetime") return;
        curSum += (x.kwh || 0);
        if (b.cmp && b.cmp[i] && i <= lastWithData) { csum += (b.cmp[i].kwh || 0); cmpMonths++; }
      });
      const totalVal = gran === "lifetime"
        ? (b.series.length ? b.series[b.series.length-1].kwh : 0)
        : curSum;
      let html = `<span class="an-total">${fmt0(totalVal)}<span class="an-unit"> kWh</span></span>`;
      if (b.cmp && b.cmpLabel && csum > 0) {
        const delta = 100*(curSum-csum)/csum;
        const cls = delta >= 0 ? "pos" : "neg";
        const partial = lastWithData >= 0 && lastWithData < b.series.length-1;
        const unit = gran === "day" ? "day" : "mo";
        html += `<span class="an-delta ${cls}">${delta>=0?"▲":"▼"} ${Math.abs(delta).toFixed(1)}%</span>
                 <span class="an-vslabel">vs ${esc(b.cmpLabel)}${partial?` (same ${cmpMonths} ${unit}${cmpMonths===1?"":"s"})`:""}</span>`;
      } else if (gran === "year" && S.annual.length >= 2) {
        // YoY must be honest when the latest year is PARTIAL: compare the latest
        // year against the SAME number of months of the prior year, not its full
        // total (else a mid-year fleet looks like a ~50% collapse).
        const ly = S.years[S.years.length-1], py = S.years[S.years.length-2];
        const lyMonths = Object.keys(S.mlut[ly] || {}).map(Number);
        const nMo = lyMonths.length;
        const partialYear = nMo > 0 && nMo < 12;
        let last = 0, prev = 0;
        if (partialYear) {
          lyMonths.forEach(m => { last += (S.mlut[ly]||{})[m] || 0; prev += (S.mlut[py]||{})[m] || 0; });
        } else {
          last = S.annual[S.annual.length-1].kwh; prev = S.annual[S.annual.length-2].kwh;
        }
        if (prev > 0) {
          const dl = 100*(last-prev)/prev;
          html += `<span class="an-delta ${dl>=0?"pos":"neg"}">${dl>=0?"▲":"▼"} ${Math.abs(dl).toFixed(1)}% YoY</span>`;
          if (partialYear) html += `<span class="an-vslabel">${ly} vs ${py} (same ${nMo} mo${nMo===1?"":"s"})</span>`;
        }
      }
      dEl.innerHTML = html;
    }

    function renderChart() {
      const b = buildSeries();
      curSeries = b.series; curCmp = b.cmp; curAccent = b.accent;
      el.querySelector("#anPeriod").textContent = b.periodLabel;
      el.style.setProperty("--an-accent", b.accent);
      // nav buttons
      const nav = el.querySelector(".an-nav");
      nav.style.visibility = navVisible() ? "visible" : "hidden";
      el.querySelector('[data-nav="prev"]').disabled = !canPrev();
      el.querySelector('[data-nav="next"]').disabled = !canNext();
      // compare toggle only meaningful for month/day
      el.querySelector(".an-cmp").style.visibility = (gran==="month"||gran==="day") ? "visible" : "hidden";
      renderDelta(b);
      cvs.draw = (ctx,w,h) => drawBars(ctx,w,h, curSeries, curCmp, curAccent, hoverIdx);
    }

    // ----- hover tooltip -----
    cvs.cv.addEventListener("mousemove", (ev) => {
      const r = cvs.cv.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const padL = 46, padR = 12;
      const plotW = cvs.w - padL - padR;
      const n = curSeries.length || 1;
      const slot = plotW / n;
      const i = Math.floor((x - padL) / slot);
      if (i >= 0 && i < n) {
        if (i !== hoverIdx) { hoverIdx = i; cvs.redraw(); }
        const s = curSeries[i];
        let html = `<div class="an-tip-h">${esc(s.sub||s.label)}</div><div class="an-tip-v">${fmt1(s.kwh)} kWh</div>`;
        if (curCmp && curCmp[i] && curCmp[i].kwh > 0) {
          const cv = curCmp[i].kwh; const dl = cv>0 ? 100*(s.kwh-cv)/cv : 0;
          html += `<div class="an-tip-cmp">prior: ${fmt1(cv)} kWh <span class="${dl>=0?"pos":"neg"}">${dl>=0?"+":""}${dl.toFixed(0)}%</span></div>`;
        }
        tip.innerHTML = html; tip.style.display = "block";
        const tx = Math.min(Math.max(x, 60), cvs.w - 60);
        tip.style.left = tx + "px"; tip.style.top = "8px";
      } else if (hoverIdx !== -1) { hoverIdx = -1; cvs.redraw(); tip.style.display="none"; }
    });
    cvs.cv.addEventListener("mouseleave", () => { if (hoverIdx!==-1){ hoverIdx=-1; cvs.redraw(); } tip.style.display="none"; });

    // ----- KPI strip (specific yield etc.) -----
    function renderKpis() {
      const k = el.querySelector("#anKpis");
      const cards = [];
      cards.push(kpi("Trailing 12 mo", fmt0(S.ttm), "kWh"));
      cards.push(kpi("Lifetime", kCompact(S.lifetime), "kWh"));
      if (S.capacity != null) {
        cards.push(kpi("System size", fmt1(S.capacity), "kWp", `summed from ${S.capacityArrays} array${S.capacityArrays===1?"":"s"} with nameplate on record`));
        if (S.specYield != null) cards.push(kpi("Specific yield", fmt0(S.specYield), "kWh/kWp", "trailing-12-mo production ÷ system size"));
      } else {
        cards.push(kpiPrompt("Specific yield", "Add panel nameplate (kW) on the Arrays tab to unlock kWh/kWp"));
      }
      if (S.rate != null) cards.push(kpi("Blended rate", "$"+S.rate.toFixed(3), "/kWh", "measured from your billing data"));
      k.innerHTML = cards.join("");
    }
    function kpi(label, val, unit, title) {
      return `<div class="an-kpi"${title?` title="${esc(title)}"`:""}><div class="an-kpi-k">${esc(label)}</div>
        <div class="an-kpi-v">${esc(val)}<span class="an-kpi-u"> ${esc(unit)}</span></div></div>`;
    }
    function kpiPrompt(label, msg) {
      return `<div class="an-kpi an-kpi-prompt"><div class="an-kpi-k">${esc(label)}</div>
        <div class="an-kpi-prompt-msg">${esc(msg)}</div></div>`;
    }

    // ----- vendor attribution -----
    function renderAttr() {
      const a = el.querySelector("#anAttr");
      const srcs = (S.sources || []).filter(s => (s.lifetime_kwh||0) > 0);
      if (!srcs.length) { a.innerHTML = `<div class="an-empty-sm">No attributed production yet.</div>`; return; }
      const seg = srcs.map(s => {
        const c = SRC_COLOR[s.key] || SRC_COLOR.other;
        return `<span class="an-seg" style="width:${Math.max(s.share_pct,0.6)}%;background:${c}" title="${esc(s.label)}: ${fmt0(s.lifetime_kwh)} kWh (${s.share_pct}%)"></span>`;
      }).join("");
      const legend = srcs.map(s => {
        const c = SRC_COLOR[s.key] || SRC_COLOR.other;
        return `<div class="an-leg"><span class="an-dot" style="background:${c}"></span>
          <span class="an-leg-lbl">${esc(s.label)}</span>
          <span class="an-leg-val">${fmt0(s.lifetime_kwh)} kWh · ${s.share_pct}%</span></div>`;
      }).join("");
      a.innerHTML = `<div class="an-bar">${seg}</div><div class="an-legend">${legend}</div>
        <div class="an-attr-note">One fleet, every vendor — attributed to the exact feed each kWh came from. Single-vendor portals can't show this.</div>`;
    }

    // ----- environmental impact -----
    function renderEnv() {
      const e = el.querySelector("#anEnv");
      const env = S.env;
      if (!env) { e.innerHTML = `<div class="an-empty-sm">Logs a few months of production to see avoided emissions.</div>`; return; }
      const tiles = [
        ["🌍", fmt0(env.co2_avoided_tonnes), "tonnes CO₂ avoided"],
        ["🌳", fmt0(env.trees_equiv), "tree-years of sequestration"],
        ["🚗", fmt1(env.cars_year_equiv), "cars off the road for a year"],
        ["🏠", fmt1(env.homes_year_equiv), "homes powered for a year"],
      ];
      e.innerHTML = `<div class="an-envgrid">` + tiles.map(t =>
        `<div class="an-envtile"><div class="an-envic" aria-hidden="true">${t[0]}</div>
          <div class="an-envv">${t[1]}</div><div class="an-envl">${esc(t[2])}</div></div>`).join("") +
        `</div><div class="an-attr-note">${esc(env.basis)}</div>`;
    }

    // ----- records -----
    function renderRecords() {
      const r = el.querySelector("#anRecords");
      const tiles = [];
      if (rec.bestMonth) tiles.push(["Best month", fmt0(rec.bestMonth.kwh)+" kWh", rec.bestMonth.label]);
      if (rec.bestDay) {
        const dt = new Date(rec.bestDay.label+"T00:00:00");
        const lbl = isNaN(dt) ? rec.bestDay.label : dt.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
        tiles.push(["Best day", fmt1(rec.bestDay.kwh)+" kWh", lbl]);
      }
      if (S.annual.length) {
        const top = S.annual.slice().sort((a,b)=>b.kwh-a.kwh)[0];
        tiles.push(["Best year", kCompact(top.kwh)+" kWh", String(top.year)]);
      }
      if (!tiles.length) { r.innerHTML=""; return; }
      r.innerHTML = `<div class="an-rec-h">Records</div><div class="an-recgrid">` + tiles.map(t =>
        `<div class="an-rectile"><div class="an-recl">${esc(t[0])}</div>
          <div class="an-recv">${esc(t[1])}</div><div class="an-recwhen">${esc(t[2])}</div></div>`).join("") + `</div>`;
    }

    // ----- wire controls -----
    el.querySelectorAll(".an-g").forEach(btn => btn.addEventListener("click", () => {
      gran = btn.getAttribute("data-g");
      try { localStorage.setItem("ao_analytics_gran", gran); } catch(e){}
      el.querySelectorAll(".an-g").forEach(b => { const on=b===btn; b.classList.toggle("on",on); b.setAttribute("aria-selected",on); });
      hoverIdx = -1; tip.style.display="none";
      renderChart();
    }));
    el.querySelector('[data-nav="prev"]').addEventListener("click", () => {
      if (gran==="month" && yearIdx>0) yearIdx--;
      else if (gran==="day" && dayMonthIdx>0) dayMonthIdx--;
      hoverIdx=-1; tip.style.display="none"; renderChart();
    });
    el.querySelector('[data-nav="next"]').addEventListener("click", () => {
      if (gran==="month" && yearIdx<S.years.length-1) yearIdx++;
      else if (gran==="day" && dayMonthIdx<S.dayMonths.length-1) dayMonthIdx++;
      hoverIdx=-1; tip.style.display="none"; renderChart();
    });
    el.querySelector("#anCmp").addEventListener("change", (ev) => { compare = ev.target.checked; renderChart(); });

    // ----- initial paint -----
    renderChart();
    renderKpis();
    renderAttr();
    renderEnv();
    renderRecords();

    // cleanup
    return function stop() {
      try { cvs.destroy(); } catch(e){}
      try { el.remove(); } catch(e){}
    };
  }

  window.AOAnalytics = { mount };
})();
