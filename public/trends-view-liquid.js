/* Trends view A — Liquid Energy. Current year as a living gradient fill with an
 * undulating surface + meniscus orb; prior years as ghost ridgelines. */
(function () {
  "use strict";
  const C = window.AOTrends;
  C.registerView("liquid", {
    label: "Liquid Energy", badge: "A", order: 1,
    describe: "The current year rendered as living fluid — a flowing gradient with a bright leading edge; prior years ghosted behind.",
    mount(container, P, C) {
      const cv = C.createCanvas(container, { aspect: 2.85, maxHeight: 420 });
      const PAD = { l: 50, r: 22, t: 26, b: 34 };
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

      cv.start((ctx, w, h, t) => {
        if (reduce) t = 1500; // freeze waves
        const plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
        const top = P.peak * 1.12;
        const X = m => PAD.l + plotW * (m - 1) / 11;
        const Y = v => PAD.t + plotH * (1 - v / top);
        const baseY = Y(0);

        // grid + y labels
        ctx.lineWidth = 1; ctx.font = "11px system-ui";
        for (let i = 0; i <= 4; i++) {
          const val = top * i / 4, gy = Y(val);
          ctx.strokeStyle = C.COLORS.line;
          ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(w - PAD.r, gy); ctx.stroke();
          ctx.fillStyle = C.COLORS.faint; ctx.textAlign = "right";
          ctx.fillText(C.kCompact(val), PAD.l - 8, gy + 4);
        }
        ctx.textAlign = "center";
        for (let m = 1; m <= 12; m++) { ctx.fillStyle = C.COLORS.faint; ctx.fillText(C.MONTHS[m - 1], X(m), h - 12); }

        // ghost prior years
        P.years.filter(y => y !== P.latestYear).forEach(y => {
          const pts = (P.monthly[String(y)] || []).map(p => [X(p.month), Y(p.kwh)]);
          if (pts.length < 2) return;
          ctx.beginPath(); C.smoothPath(ctx, pts);
          ctx.strokeStyle = C.hexA(C.yearColor(y, P.years), .5); ctx.lineWidth = 2; ctx.stroke();
        });

        // liquid current year
        const cur = P.monthly[String(P.latestYear)] || [];
        if (cur.length) {
          const surf = cur.map(p => {
            const x = X(p.month);
            const wave = Math.sin(x * 0.018 + t * 0.0016) * 4 + Math.sin(x * 0.05 - t * 0.0026) * 2.2;
            return [x, Y(p.kwh) + wave];
          });
          ctx.beginPath(); C.smoothPath(ctx, surf);
          ctx.lineTo(surf[surf.length - 1][0], baseY); ctx.lineTo(surf[0][0], baseY); ctx.closePath();
          const g = ctx.createLinearGradient(0, PAD.t, 0, baseY);
          g.addColorStop(0, C.hexA(C.COLORS.good2, .55));
          g.addColorStop(.5, C.hexA(C.COLORS.good, .32));
          g.addColorStop(1, C.hexA(C.COLORS.good, .04));
          ctx.fillStyle = g; ctx.fill();
          ctx.save(); ctx.shadowColor = C.hexA(C.COLORS.good, .8); ctx.shadowBlur = 16;
          ctx.beginPath(); C.smoothPath(ctx, surf); ctx.strokeStyle = C.COLORS.good2; ctx.lineWidth = 2.6; ctx.stroke();
          ctx.restore();
          // meniscus orb
          const last = surf[surf.length - 1];
          const pulse = reduce ? 1 : 1 + 0.18 * Math.sin(t * 0.005);
          const rg = ctx.createRadialGradient(last[0], last[1], 0, last[0], last[1], 16 * pulse);
          rg.addColorStop(0, C.hexA(C.COLORS.good2, .95)); rg.addColorStop(1, C.hexA(C.COLORS.good, 0));
          ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(last[0], last[1], 16 * pulse, 0, 7); ctx.fill();
          ctx.fillStyle = C.COLORS.good2; ctx.beginPath(); ctx.arc(last[0], last[1], 3.4, 0, 7); ctx.fill();
        }
      });
      return () => cv.stop();
    },
  });
})();
