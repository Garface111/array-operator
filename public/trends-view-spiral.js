/* Trends view B — Solar Spiral. 12 months around a clock; each year a glowing
 * ring whose radius is that month's fleet kWh; central sun. */
(function () {
  "use strict";
  const C = window.AOTrends;
  C.registerView("spiral", {
    label: "Solar Spiral", badge: "B", order: 2,
    describe: "Twelve months wrap a clock; each year is a glowing ring whose radius is that month's production. Seasonality becomes a shape — the summer bulge.",
    mount(container, P, C) {
      const cv = C.createCanvas(container, { aspect: 1.5, maxHeight: 540, minHeight: 360 });
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      cv.start((ctx, w, h, t) => {
        if (reduce) t = 2000;
        const cx = w / 2, cy = h / 2 + 4;
        const Rmin = 56, Rmax = Math.min(w, h) / 2 - 56;
        const Rk = v => Rmin + (Rmax - Rmin) * (v / (P.peak * 1.05));
        const ang = m => (-Math.PI / 2) + (m - 1) / 12 * Math.PI * 2;

        // rings + spokes + month labels
        ctx.lineWidth = 1;
        for (let i = 1; i <= 4; i++) {
          const r = Rmin + (Rmax - Rmin) * i / 4;
          ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
        }
        ctx.font = "12px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (let m = 1; m <= 12; m++) {
          const a = ang(m);
          ctx.strokeStyle = "rgba(255,255,255,.05)";
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * Rmin, cy + Math.sin(a) * Rmin);
          ctx.lineTo(cx + Math.cos(a) * (Rmax + 6), cy + Math.sin(a) * (Rmax + 6)); ctx.stroke();
          const lr = Rmax + 22; ctx.fillStyle = C.COLORS.faint;
          ctx.fillText(C.MONTHS3[m - 1].toUpperCase(), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
        }
        // sun
        const pulse = reduce ? 1 : 1 + 0.08 * Math.sin(t * 0.004);
        const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Rmin * pulse);
        sg.addColorStop(0, C.hexA(C.COLORS.gold2, .9)); sg.addColorStop(.6, C.hexA(C.COLORS.gold, .25)); sg.addColorStop(1, C.hexA(C.COLORS.gold, 0));
        ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, Rmin * pulse, 0, 7); ctx.fill();

        const grow = reduce ? 1 : Math.min(1, t / 1400);
        P.years.forEach(y => {
          const pts = P.monthly[String(y)] || [];
          if (!pts.length) return;
          const full = pts.length === 12;
          const col = C.yearColor(y, P.years), isLatest = y === P.latestYear;
          const coords = pts.map(p => {
            const a = ang(p.month), r = Rk(p.kwh) * (0.4 + 0.6 * grow);
            return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
          });
          const loop = full ? [...coords, coords[0]] : coords;
          ctx.beginPath();
          loop.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
          ctx.save(); ctx.shadowColor = C.hexA(col, isLatest ? .85 : .4); ctx.shadowBlur = isLatest ? 16 : 8;
          ctx.strokeStyle = col; ctx.lineWidth = isLatest ? 3 : 1.8; ctx.globalAlpha = isLatest ? 1 : .78;
          ctx.stroke(); ctx.restore(); ctx.globalAlpha = 1;
          coords.forEach(p => { ctx.fillStyle = col; ctx.globalAlpha = isLatest ? 1 : .7; ctx.beginPath(); ctx.arc(p[0], p[1], isLatest ? 3 : 1.8, 0, 7); ctx.fill(); });
          ctx.globalAlpha = 1;
        });
        // legend top-left
        ctx.textAlign = "left"; ctx.font = "13px system-ui";
        [...P.years].sort((a, b) => b - a).forEach((y, i) => {
          const yy = 22 + i * 22;
          ctx.fillStyle = C.yearColor(y, P.years); ctx.beginPath(); ctx.arc(14, yy - 4, 6, 0, 7); ctx.fill();
          ctx.fillStyle = C.COLORS.muted; ctx.fillText(y + (y === P.latestYear ? " · live" : ""), 28, yy);
        });
      });
      return () => cv.stop();
    },
  });
})();
