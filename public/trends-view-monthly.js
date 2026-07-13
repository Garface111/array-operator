/* Array Operator — Monthly Production bar chart (trends-view-monthly.js)
 *
 * The quantitative month-by-month view a power user actually reads: fleet kWh
 * per calendar month for the latest year, with prior years drawn as lighter
 * "ghost" bars behind for instant year-over-year comparison. Unlike the
 * decorative multi-year art (liquid/spiral/heatfield), this answers "how is each
 * month doing, and vs last year?" at a glance.
 *
 * Registered as a Trends view; reads prepped.monthly ({"2025":[{month,kwh}]}) +
 * prepped.years. Reuses AOTrends color tokens + the hi-DPI canvas helper.
 */
(function () {
  "use strict";
  const C = window.AOTrends;
  if (!C || !C.registerView) return;

  // SKY demo flag (2026-07-12): the night-first white-alpha hairlines are
  // invisible on the sky theme's light canvas — branch the constants only.
  // Flag off ⇒ the exact rgba strings hexA() produced before.
  const SKY = document.documentElement.classList.contains("sky");
  const GRID_LINE = SKY ? "rgba(14,20,32,.10)" : C.hexA("#ffffff", 0.05);
  const BASELINE  = SKY ? "rgba(14,20,32,.18)" : C.hexA("#ffffff", 0.14);

  const easeOut = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

  C.registerView("monthly", {
    label: "Monthly Production", badge: "mo", order: 0.7,
    describe: "Fleet kWh per calendar month — the latest year in bold, prior years ghosted behind for an instant year-over-year read.",
    mount(container, P, core) {
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.style.position = "relative";

      const years = (P.years || []).slice().sort((a, b) => a - b);
      if (!years.length) {
        container.innerHTML = `<div class="empty" style="padding:24px 0;color:var(--faint)">No monthly production yet.</div>`;
        return () => {};
      }
      const latest = years[years.length - 1];
      // monthly[year] -> {month: kwh}
      const byYear = {};
      let peak = 1;
      for (const y of years) {
        const m = {};
        for (const pt of (P.monthly[String(y)] || [])) {
          m[pt.month] = pt.kwh || 0;
          if (m[pt.month] > peak) peak = m[pt.month];
        }
        byYear[y] = m;
      }

      const cv = core.createCanvas(container, { aspect: 2.6, maxHeight: 340, minHeight: 220 });
      const tip = document.createElement("div");
      tip.className = "tr-tip"; container.appendChild(tip);
      let geo = null, hover = -1;

      cv.start((ctx, w, h, t) => {
        const k = clamp((w - 360) / 740, 0, 1);
        const fAxis = 9.5 + 1.5 * k;
        const padL = 46 + 6 * k, padR = 14, padT = 14, padB = 26;
        const top = padT, bottom = h - padB;
        const plotW = Math.max(10, w - padL - padR);
        const plotH = Math.max(10, bottom - top);
        const slot = plotW / 12;

        const ticks = niceTicks(peak, 4);
        const axMax = ticks[ticks.length - 1] || peak;
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.font = fAxis + "px system-ui,sans-serif";
        for (const tv of ticks) {
          const y = bottom - (tv / axMax) * plotH;
          ctx.strokeStyle = GRID_LINE; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
          ctx.fillStyle = core.COLORS.faint;
          ctx.fillText(core.kCompact(tv), padL - 7, y);
        }

        const grow = reduce ? 1 : easeOut(t / 850);
        const priorYears = years.filter(y => y !== latest);
        const bars = [];

        for (let mo = 1; mo <= 12; mo++) {
          const cx = padL + slot * (mo - 0.5);
          // prior-year ghost bars (thin, behind), one per prior year
          const nPrior = priorYears.length;
          priorYears.forEach((y, pi) => {
            const v = byYear[y][mo] || 0;
            if (v <= 0) return;
            const gw = Math.min(slot * 0.5, 16);
            const gx = cx - gw / 2 + (pi - (nPrior - 1) / 2) * 2;
            const bh = (v / axMax) * plotH * grow;
            ctx.fillStyle = core.hexA(core.yearColor(y, years), 0.22);
            ctx.fillRect(gx, bottom - bh, gw, bh);
          });
          // latest-year solid bar (the hero)
          const lv = byYear[latest][mo] || 0;
          const bw = Math.min(slot * 0.62, 30);
          const x = cx - bw / 2;
          const bh = (lv / axMax) * plotH * grow;
          const yy = bottom - bh;
          bars.push({ mo, cx, x, w: bw, y: yy, h: bh, kwh: lv });
          if (lv > 0) {
            const isHover = mo === hover;
            const grad = ctx.createLinearGradient(0, yy, 0, bottom);
            grad.addColorStop(0, core.hexA(isHover ? core.COLORS.good2 : core.COLORS.good, 0.95));
            grad.addColorStop(1, core.hexA(core.COLORS.good, 0.28));
            ctx.save();
            if (isHover) { ctx.shadowColor = core.hexA(core.COLORS.good2, 0.7); ctx.shadowBlur = 12; }
            ctx.fillStyle = grad; ctx.fillRect(x, yy, bw, bh);
            ctx.restore();
            ctx.strokeStyle = core.hexA(isHover ? core.COLORS.good2 : core.COLORS.good, 0.9);
            ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + bw, yy); ctx.stroke();
          }
        }

        ctx.strokeStyle = BASELINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, bottom); ctx.lineTo(padL + plotW, bottom); ctx.stroke();

        ctx.fillStyle = core.COLORS.faint; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.font = fAxis + "px system-ui,sans-serif";
        for (let mo = 1; mo <= 12; mo++) ctx.fillText(MONTHS3[mo - 1], padL + slot * (mo - 0.5), bottom + 5);

        geo = { bars, top, bottom, padL, plotW };
      });

      function onMove(e) {
        if (!geo) return;
        const rect = cv.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (mx < geo.padL || mx > geo.padL + geo.plotW || my < geo.top - 8 || my > geo.bottom + 8) return hide();
        const slot = geo.plotW / 12;
        const mo = clamp(Math.floor((mx - geo.padL) / slot) + 1, 1, 12);
        const b = geo.bars[mo - 1];
        if (!b || b.kwh <= 0) return hide();
        hover = mo;
        tip.innerHTML = `${MONTHS3[mo - 1]} ${latest} · <b>${core.fmt0(b.kwh)}</b> kWh`;
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
    },
  });
})();
