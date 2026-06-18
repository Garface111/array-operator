/* Trends view C — Energy Ridgeline. One glowing ridge per year, stacked
 * back-to-front; summer peaks form a mountain range. */
(function () {
  "use strict";
  const C = window.AOTrends;
  C.registerView("ridgeline", {
    label: "Energy Ridgeline", badge: "C", order: 3,
    describe: "One luminous ridge per year, stacked back-to-front — summer peaks become a mountain range; year-over-year growth reads as each ridge rising higher.",
    mount(container, P, C) {
      const cv = C.createCanvas(container, { aspect: 2.85, maxHeight: 420 });
      const PAD = { l: 58, r: 26, t: 30, b: 32 };
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      cv.start((ctx, w, h, t) => {
        const grow = reduce ? 1 : Math.min(1, t / 1300);
        const plotW = w - PAD.l - PAD.r;
        const years = [...P.years].sort((a, b) => a - b); // oldest back
        const rowGap = (h - PAD.t - PAD.b) / Math.max(1, years.length);
        const ridgeH = rowGap * 2.0;
        const X = m => PAD.l + plotW * (m - 1) / 11;
        years.forEach((y, idx) => {
          const baseY = PAD.t + rowGap * (idx + 0.7);
          const col = C.yearColor(y, P.years), isLatest = y === P.latestYear;
          const pts = (P.monthly[String(y)] || []).map(p => [X(p.month), baseY - (p.kwh / P.peak) * ridgeH * grow]);
          if (pts.length < 2) return;
          ctx.beginPath(); C.smoothPath(ctx, pts);
          ctx.lineTo(pts[pts.length - 1][0], baseY); ctx.lineTo(pts[0][0], baseY); ctx.closePath();
          const g = ctx.createLinearGradient(0, baseY - ridgeH, 0, baseY);
          g.addColorStop(0, C.hexA(col, .42)); g.addColorStop(1, C.hexA(col, .02));
          ctx.fillStyle = g; ctx.fill();
          ctx.save(); ctx.shadowColor = C.hexA(col, isLatest ? .8 : .45); ctx.shadowBlur = isLatest ? 14 : 8;
          ctx.beginPath(); C.smoothPath(ctx, pts);
          ctx.strokeStyle = isLatest ? C.COLORS.good2 : col; ctx.lineWidth = isLatest ? 2.6 : 1.8; ctx.stroke();
          ctx.restore();
          ctx.fillStyle = isLatest ? C.COLORS.good2 : C.COLORS.muted;
          ctx.font = (isLatest ? "700 " : "") + "14px system-ui"; ctx.textAlign = "right";
          ctx.fillText(y, PAD.l - 12, baseY - 2);
        });
        ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = C.COLORS.faint;
        for (let m = 1; m <= 12; m++) ctx.fillText(C.MONTHS[m - 1], X(m), h - 12);
      });
      return () => cv.stop();
    },
  });
})();
