/* Trends view D — Production Heat-Field. month × year glow grid; green->gold
 * heat ramp; values on bright cells. Hover a cell for year/month/exact kWh and
 * the YoY delta vs the same month a year earlier. */
(function () {
  "use strict";
  const C = window.AOTrends;
  C.registerView("heatfield", {
    label: "Heat-Field", badge: "D", order: 4,
    describe: "A month × year grid where every cell glows with its production. Bright summer bands, the diagonal of fleet growth, and any dark down-month jump out instantly.",
    mount(container, P, C) {
      const years = [...P.years].sort((a, b) => b - a); // newest top
      const cv = C.createCanvas(container, { aspect: 3.4, maxHeight: 420, minHeight: 200 });
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

      // exact monthly values keyed by year -> month (for draw + hover)
      const series = {};
      years.forEach(y => {
        const row = (series[y] = {});
        (P.monthly[String(y)] || []).forEach(p => { row[p.month] = p.kwh; });
      });

      // ── tooltip + hover state ────────────────────────────────────────────
      const tip = document.createElement("div");
      tip.className = "tr-tip";
      container.appendChild(tip);
      let hover = null;            // {ri, m} of the cell under the cursor
      let layout = null;          // last computed geometry, for hit-testing

      function heat(f) {
        const stops = [[10, 30, 24], [63, 214, 138], [245, 185, 66], [255, 212, 121]];
        const seg = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), tt = seg - i;
        const a = stops[i], b = stops[i + 1];
        return `rgb(${a[0] + (b[0] - a[0]) * tt | 0},${a[1] + (b[1] - a[1]) * tt | 0},${a[2] + (b[2] - a[2]) * tt | 0})`;
      }
      function rr(c, x, y, ww, hh, r) {
        r = Math.max(0, Math.min(r, ww / 2, hh / 2));
        c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + ww, y, x + ww, y + hh, r);
        c.arcTo(x + ww, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + ww, y, r); c.closePath();
      }

      // Geometry scales with width so it reads from 360px → 1200px.
      function geom(w, h) {
        const s = Math.max(0.8, Math.min(1.15, w / 820));
        const PAD = {
          l: Math.round(40 + 16 * s),
          r: Math.round(14 + 8 * s),
          t: Math.round(30 + 12 * s),
          b: Math.round(14 + 8 * s),
        };
        const gridW = Math.max(1, w - PAD.l - PAD.r);
        const gridH = Math.max(1, h - PAD.t - PAD.b);
        const cw = gridW / 12, ch = gridH / Math.max(1, years.length);
        return { s, PAD, cw, ch };
      }

      // map a CSS-px point to a cell (or null)
      function cellAt(px, py) {
        if (!layout) return null;
        const { PAD, cw, ch } = layout;
        const m = Math.floor((px - PAD.l) / cw) + 1;
        const ri = Math.floor((py - PAD.t) / ch);
        if (m < 1 || m > 12 || ri < 0 || ri >= years.length) return null;
        const y = years[ri];
        if (series[y][m] == null) return null;
        return { ri, m };
      }

      function showTip(px, py) {
        const c = cellAt(px, py);
        if (!c) { hover = null; tip.classList.remove("on"); return; }
        hover = c;
        const y = years[c.ri], kwh = series[y][c.m];
        const multi = years.length > 1;
        const label = C.MONTHS3[c.m - 1] + (multi ? " " + y : "");
        let delta = "";
        const prev = years[c.ri + 1] != null ? series[years[c.ri + 1]][c.m] : null; // cell below = prior year
        if (prev != null && prev > 0) {
          const pct = (kwh - prev) / prev * 100;
          const up = pct >= 0;
          const col = up ? C.COLORS.good2 : "#f3a08a";
          delta = `<span class="trv-heatfield-d" style="color:${col}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% YoY</span>`;
        }
        tip.innerHTML = `<b>${C.esc(label)}</b> · ${C.fmt0(kwh)} kWh` + (delta ? "<br>" + delta : "");
        const { PAD, cw, ch } = layout;
        tip.style.left = (PAD.l + cw * (c.m - 0.5)) + "px";
        tip.style.top = (PAD.t + ch * c.ri + 4) + "px";
        tip.classList.add("on");
      }

      function onMove(e) {
        const r = cv.canvas.getBoundingClientRect();
        showTip(e.clientX - r.left, e.clientY - r.top);
      }
      function onLeave() { hover = null; tip.classList.remove("on"); }
      cv.canvas.addEventListener("mousemove", onMove);
      cv.canvas.addEventListener("mouseleave", onLeave);

      cv.start((ctx, w, h, t) => {
        const { s, PAD, cw, ch } = geom(w, h);
        layout = { PAD, cw, ch };
        const gap = Math.max(2, Math.round(3 * s));
        const radius = Math.max(4, Math.round(8 * s));
        const cwi = cw - gap * 2, chi = ch - gap * 2;
        const showVals = cwi > 30 && chi > 22;
        const narrow = cw < 34;

        // month headers
        ctx.font = Math.round(10 + 1.5 * s) + "px system-ui";
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = C.COLORS.faint;
        for (let m = 1; m <= 12; m++) {
          const lbl = narrow ? C.MONTHS[m - 1] : C.MONTHS3[m - 1].toUpperCase();
          ctx.fillText(lbl, PAD.l + cw * (m - 0.5), PAD.t - Math.round(13 * s));
        }

        const appear = reduce ? 1 : Math.min(1, t / 1200);
        years.forEach((y, ri) => {
          // year label
          ctx.fillStyle = y === P.latestYear ? C.COLORS.good2 : C.COLORS.muted;
          ctx.font = (y === P.latestYear ? "700 " : "") + Math.round(11 + 2 * s) + "px system-ui";
          ctx.textAlign = "right"; ctx.textBaseline = "middle";
          ctx.fillText(y, PAD.l - Math.round(8 * s), PAD.t + ch * (ri + 0.5));

          for (let m = 1; m <= 12; m++) {
            const x = PAD.l + cw * (m - 1) + gap, yy = PAD.t + ch * ri + gap;
            const v = series[y][m];
            if (v == null) {
              ctx.fillStyle = "rgba(255,255,255,.025)";
              rr(ctx, x, yy, cwi, chi, radius); ctx.fill();
              continue;
            }
            const f = Math.max(0, Math.min(1, v / P.peak));
            const shimmer = reduce ? 1 : 0.92 + 0.08 * Math.sin(t * 0.003 + m * 0.6 + ri);
            ctx.save();
            ctx.shadowColor = C.hexA(heat(f), 0.55 * f);
            ctx.shadowBlur = 18 * f * shimmer * s;
            ctx.fillStyle = heat(f);
            ctx.globalAlpha = (0.30 + 0.70 * f) * appear;
            rr(ctx, x, yy, cwi, chi, radius); ctx.fill();
            ctx.restore();

            if (showVals && f > 0.34) {
              const dark = f > 0.6; // bright cell -> dark text for contrast
              ctx.globalAlpha = appear;
              ctx.fillStyle = dark ? C.COLORS.bg : C.COLORS.ink;
              ctx.shadowColor = dark ? "rgba(255,255,255,.25)" : "rgba(0,0,0,.55)";
              ctx.shadowBlur = 2;
              ctx.font = "600 " + Math.round(10 + 2 * s) + "px system-ui";
              ctx.textAlign = "center"; ctx.textBaseline = "middle";
              ctx.fillText(C.kCompact(v), x + cwi / 2, yy + chi / 2);
              ctx.shadowBlur = 0; ctx.globalAlpha = 1;
            }
          }
        });

        // hovered-cell highlight ring (drawn on top)
        if (hover && years[hover.ri] != null && series[years[hover.ri]][hover.m] != null) {
          const x = PAD.l + cw * (hover.m - 1) + gap, yy = PAD.t + ch * hover.ri + gap;
          ctx.save();
          ctx.shadowColor = C.hexA(C.COLORS.good2, 0.5);
          ctx.shadowBlur = 10;
          ctx.lineWidth = 2;
          ctx.strokeStyle = C.COLORS.good2;
          rr(ctx, x - 0.5, yy - 0.5, cwi + 1, chi + 1, radius + 1);
          ctx.stroke();
          ctx.restore();
        }
      });

      return () => {
        cv.canvas.removeEventListener("mousemove", onMove);
        cv.canvas.removeEventListener("mouseleave", onLeave);
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        cv.stop();
      };
    },
  });
})();
