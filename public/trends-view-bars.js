/* Array Operator — Daily Generation bar graph (trends-view-bars.js)
 *
 * A standalone, "cool" daily-production bar chart for the monthly/quarterly
 * report. Unlike the multi-year Trends views, this one is fed a DAILY series
 * straight from /subscriptions/{id}/daily-series (real DailyGeneration rows,
 * scaled to the offtaker's share) — so the bars are one-per-day for the period.
 *
 *   AOBars.mount(container, { points:[{day,kwh}], period_label, total_kwh }, core?)
 *     -> stopFn
 *
 * Design: vertical gradient bars (brand green, brighter toward the top), a soft
 * glow on the tallest day, faint weekend tinting, a baseline rail, a grow-in
 * animation, value axis ticks, day labels thinned to fit, and a hover tooltip.
 * Reuses window.AOTrends for color tokens + the hi-DPI canvas when present, but
 * falls back gracefully so it can render standalone.
 */
(function () {
  "use strict";
  const C = window.AOTrends || null;
  const COL = {
    good:  (C && C.COLORS.good)  || "#3fd68a",
    good2: (C && C.COLORS.good2) || "#7ff0bb",
    ink:   (C && C.COLORS.ink)   || "#eaf0f7",
    muted: (C && C.COLORS.muted) || "#8b97a8",
    faint: (C && C.COLORS.faint) || "#6b7686",
    bg:    (C && C.COLORS.bg)    || "#0a0e14",
  };
  const hexA = (C && C.hexA) || function (hex, a) {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.substr(0,2),16)},${parseInt(h.substr(2,2),16)},${parseInt(h.substr(4,2),16)},${a})`;
  };
  const fmt0 = (C && C.fmt0) || (n => Math.round(n).toLocaleString());
  // SKY demo flag (2026-07-12): the night-first white-alpha hairlines are
  // invisible on the sky theme's light canvas — branch the constants only.
  // Flag off ⇒ the exact rgba strings hexA() produced before.
  const SKY = document.documentElement.classList.contains("sky");
  const GRID_LINE    = SKY ? "rgba(14,20,32,.10)"   : hexA("#ffffff", 0.05);
  const WEEKEND_TINT = SKY ? "rgba(20,60,120,.05)"  : hexA("#ffffff", 0.025);
  const BASELINE     = SKY ? "rgba(14,20,32,.18)"   : hexA("#ffffff", 0.14);
  const easeOut = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const MONTHS3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function niceTicks(max, n) {
    if (max <= 0) return [0];
    const raw = max / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const top = Math.ceil(max / step) * step;
    const out = [];
    for (let v = 0; v <= top + 1e-6; v += step) out.push(v);
    return out;
  }

  // hi-DPI auto-animating canvas (reuse core's when available, else local)
  function makeCanvas(container, aspect, maxH, minH) {
    if (C && C.createCanvas) return C.createCanvas(container, { aspect, maxHeight: maxH, minHeight: minH });
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.display = "block"; canvas.style.borderRadius = "14px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let w = 0, h = 0, dpr = 1, raf = 0, drawFn = null, t0 = 0, stopped = false, ro = null;
    function fit() {
      const cssW = container.clientWidth || 720;
      let cssH = clamp(cssW / aspect, minH, maxH);
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      w = cssW; h = cssH; canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    }
    fit();
    if (window.ResizeObserver) { ro = new ResizeObserver(fit); ro.observe(container); }
    else window.addEventListener("resize", fit);
    function frame(now) {
      if (stopped) return;
      if (!t0) t0 = now;
      if (!container.isConnected) { stop(); return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (drawFn) drawFn(ctx, w, h, now - t0);
      raf = requestAnimationFrame(frame);
    }
    function start(fn) { drawFn = fn; if (!raf) raf = requestAnimationFrame(frame); return api; }
    function stop() { stopped = true; if (raf) cancelAnimationFrame(raf), raf = 0; if (ro) ro.disconnect(); else window.removeEventListener("resize", fit); }
    const api = { canvas, ctx, start, stop, get w(){return w;}, get h(){return h;} };
    return api;
  }

  function mount(container, data, _core) {
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const points = (data && data.points) || [];
    container.style.position = "relative";

    if (!points.length) {
      container.innerHTML = `<div class="empty" style="padding:26px 0;color:var(--faint)">
        No daily generation for ${data && data.period_label ? data.period_label : "this period"} yet —
        connect data or upload generation to see the daily bars.</div>`;
      return () => {};
    }

    const cv = makeCanvas(container, 2.4, 360, 220);
    const tip = document.createElement("div");
    tip.className = "tr-tip"; container.appendChild(tip);

    const days = points.map(p => {
      const d = new Date(p.day + "T00:00:00");
      return { date: d, dow: d.getDay(), dom: d.getDate(), kwh: p.kwh || 0, label: p.day };
    });
    const peak = Math.max(...days.map(d => d.kwh), 1);
    const peakIdx = days.reduce((bi, d, i, a) => d.kwh > a[bi].kwh ? i : bi, 0);

    let geo = null, hover = -1;

    cv.start((ctx, w, h, t) => {
      const k = clamp((w - 360) / 740, 0, 1);
      const fAxis = 9.5 + 1.5 * k;
      const padL = 44 + 6 * k, padR = 12, padT = 16, padB = 26;
      const top = padT, bottom = h - padB;
      const plotW = Math.max(10, w - padL - padR);
      const plotH = Math.max(10, bottom - top);
      const n = days.length;
      const slot = plotW / n;
      const bw = Math.max(2, Math.min(slot * 0.72, 34));

      // value axis ticks + gridlines
      const ticks = niceTicks(peak, 4);
      const axMax = ticks[ticks.length - 1] || peak;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.font = fAxis + "px system-ui,sans-serif";
      ticks.forEach(tv => {
        const y = bottom - (tv / axMax) * plotH;
        ctx.strokeStyle = GRID_LINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillStyle = COL.faint;
        ctx.fillText(fmt0(tv), padL - 7, y);
      });

      const grow = reduce ? 1 : easeOut(t / 900);

      // bars
      const bars = [];
      days.forEach((d, i) => {
        const cx = padL + slot * (i + 0.5);
        const x = cx - bw / 2;
        const fullH = (d.kwh / axMax) * plotH;
        const bh = fullH * grow;
        const y = bottom - bh;
        bars.push({ i, x, cx, w: bw, y, h: bh, d });

        // weekend tint behind the bar slot
        if (d.dow === 0 || d.dow === 6) {
          ctx.fillStyle = WEEKEND_TINT;
          ctx.fillRect(padL + slot * i, top, slot, plotH);
        }
      });

      // draw bars (rounded-top gradient; peak + hover glow)
      bars.forEach(b => {
        const isPeak = b.i === peakIdx, isHover = b.i === hover;
        const grad = ctx.createLinearGradient(0, b.y, 0, bottom);
        grad.addColorStop(0, hexA(isPeak || isHover ? COL.good2 : COL.good, 0.95));
        grad.addColorStop(1, hexA(COL.good, 0.28));
        ctx.save();
        if (isPeak || isHover) { ctx.shadowColor = hexA(COL.good2, 0.7); ctx.shadowBlur = 12; }
        ctx.fillStyle = grad;
        roundedTop(ctx, b.x, b.y, b.w, b.h, Math.min(4, b.w / 2));
        ctx.fill();
        ctx.restore();
        // bright cap line
        ctx.strokeStyle = hexA(isPeak || isHover ? COL.good2 : COL.good, 0.9);
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w, b.y); ctx.stroke();
      });

      // baseline
      ctx.strokeStyle = BASELINE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, bottom); ctx.lineTo(padL + plotW, bottom); ctx.stroke();

      // day labels — thin to fit (every kth so they never collide)
      ctx.fillStyle = COL.faint; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.font = fAxis + "px system-ui,sans-serif";
      const every = Math.ceil((n * 16) / Math.max(plotW, 1));
      bars.forEach(b => {
        if (b.i % every === 0 || b.i === peakIdx) ctx.fillText(String(b.d.dom), b.cx, bottom + 5);
      });

      geo = { bars, top, bottom, padL, plotW };
    });

    function onMove(e) {
      if (!geo) return;
      const rect = cv.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < geo.padL || mx > geo.padL + geo.plotW || my < geo.top - 8 || my > geo.bottom + 8) return hide();
      const slot = geo.plotW / geo.bars.length;
      const idx = clamp(Math.floor((mx - geo.padL) / slot), 0, geo.bars.length - 1);
      const b = geo.bars[idx];
      if (!b) return hide();
      hover = idx;
      const d = b.d;
      tip.innerHTML = `${MONTHS3[d.date.getMonth()]} ${d.dom} · <b>${fmt0(d.kwh)}</b> kWh`;
      tip.style.left = b.cx + "px";
      tip.style.top = (b.y - 6) + "px";
      tip.classList.add("on");
    }
    function hide() { hover = -1; tip.classList.remove("on"); }
    cv.canvas.addEventListener("mousemove", onMove);
    cv.canvas.addEventListener("mouseleave", hide);

    return () => {
      cv.canvas.removeEventListener("mousemove", onMove);
      cv.canvas.removeEventListener("mouseleave", hide);
      tip.remove(); cv.stop();
    };
  }

  function roundedTop(ctx, x, y, w, h, r) {
    r = Math.min(r, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  window.AOBars = { mount };

  // Register as a Trends-tab view so it appears in the switcher. The Trends
  // registry passes prepped data; we read the fleet's 30-day daily series
  // (prepped.dailyRecent) and render it as the daily bar graph.
  if (C && C.registerView) {
    C.registerView("bars", {
      label: "Daily Generation", badge: "30d", order: 0.5,
      describe: "Each day's fleet generation as a bar — the last 30 days of production at a glance.",
      mount(container, prepped, core) {
        const pts = (prepped && prepped.dailyRecent) || [];
        return mount(container, { points: pts, period_label: "last 30 days" }, core);
      },
    });
  }
})();
