/* Trends view D — Production Heat-Field. month × year glow grid; green->gold
 * heat ramp; values on bright cells. */
(function () {
  "use strict";
  const C = window.AOTrends;
  C.registerView("heatfield", {
    label: "Heat-Field", badge: "D", order: 4,
    describe: "A month × year grid where every cell glows with its production. Bright summer bands, the diagonal of fleet growth, and any dark down-month jump out instantly.",
    mount(container, P, C) {
      const years = [...P.years].sort((a, b) => b - a); // newest top
      const cv = C.createCanvas(container, { aspect: 3.4, maxHeight: 420, minHeight: 200 });
      const PAD = { l: 58, r: 20, t: 40, b: 22 };
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      function heat(f) {
        const stops = [[10, 30, 24], [63, 214, 138], [245, 185, 66], [255, 212, 121]];
        const seg = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), tt = seg - i;
        const a = stops[i], b = stops[i + 1];
        return `rgb(${a[0] + (b[0] - a[0]) * tt | 0},${a[1] + (b[1] - a[1]) * tt | 0},${a[2] + (b[2] - a[2]) * tt | 0})`;
      }
      function rr(c, x, y, ww, hh, r) {
        c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + ww, y, x + ww, y + hh, r);
        c.arcTo(x + ww, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + ww, y, r); c.closePath();
      }
      cv.start((ctx, w, h, t) => {
        const gridW = w - PAD.l - PAD.r, gridH = h - PAD.t - PAD.b;
        const cw = gridW / 12, ch = gridH / Math.max(1, years.length);
        ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = C.COLORS.faint; ctx.textBaseline = "middle";
        for (let m = 1; m <= 12; m++) ctx.fillText(C.MONTHS3[m - 1].toUpperCase(), PAD.l + cw * (m - 0.5), PAD.t - 16);
        const appear = reduce ? 1 : Math.min(1, t / 1200);
        years.forEach((y, ri) => {
          ctx.fillStyle = y === P.latestYear ? C.COLORS.good2 : C.COLORS.muted;
          ctx.font = (y === P.latestYear ? "700 " : "") + "13px system-ui"; ctx.textAlign = "right";
          ctx.fillText(y, PAD.l - 10, PAD.t + ch * (ri + 0.5));
          const series = {}; (P.monthly[String(y)] || []).forEach(p => series[p.month] = p.kwh);
          for (let m = 1; m <= 12; m++) {
            const x = PAD.l + cw * (m - 1) + 3, yy = PAD.t + ch * ri + 3, cwi = cw - 6, chi = ch - 6;
            if (series[m] == null) { ctx.fillStyle = "rgba(255,255,255,.025)"; rr(ctx, x, yy, cwi, chi, 8); ctx.fill(); continue; }
            const f = series[m] / P.peak;
            const shimmer = reduce ? 1 : 0.92 + 0.08 * Math.sin(t * 0.003 + m * 0.6 + ri);
            ctx.save();
            ctx.shadowColor = C.hexA(heat(f), 0.55 * f); ctx.shadowBlur = 18 * f * shimmer;
            ctx.fillStyle = heat(f); ctx.globalAlpha = (0.30 + 0.70 * f) * appear;
            rr(ctx, x, yy, cwi, chi, 8); ctx.fill(); ctx.restore();
            if (f > 0.34 && chi > 22 && cwi > 30) {
              ctx.globalAlpha = appear; ctx.fillStyle = f > 0.62 ? C.COLORS.bg : C.COLORS.ink;
              ctx.font = "600 12px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
              ctx.fillText(C.kCompact(series[m]), x + cwi / 2, yy + chi / 2); ctx.globalAlpha = 1;
            }
          }
        });
      });
      return () => cv.stop();
    },
  });
})();
