/* Trends view C — Energy Ridgeline. One glowing ridge per year, stacked
 * back-to-front (oldest behind, newest in front) — summer peaks form a
 * mountain range and year-over-year growth reads as each ridge rising higher.
 * A joyplot: ridge height is capped/scaled by year count so many years stay
 * legible, left year-labels never collide with the first data point, and a
 * hover tooltip reports the nearest ridge + month -> that year's kWh. */
(function () {
  "use strict";
  const C = window.AOTrends;

  const easeOut = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  C.registerView("ridgeline", {
    label: "Energy Ridgeline", badge: "C", order: 3,
    describe: "One luminous ridge per year, stacked back-to-front — summer peaks become a mountain range; year-over-year growth reads as each ridge rising higher.",
    mount(container, P, C) {
      const cv = C.createCanvas(container, { aspect: 2.85, maxHeight: 440, minHeight: 240 });
      const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

      // single tooltip div (container is position:relative; .tr-tip pre-styled)
      const tip = document.createElement("div");
      tip.className = "tr-tip";
      container.appendChild(tip);

      // geometry shared between the draw fn and the hover handler, refreshed
      // every frame so the marker stays glued to the live (animated/resized) ridges.
      let geo = null;       // { padL, plotW, top, bottom, pts:[{x,y,month,kwh,year,col,latest}] }
      let hover = null;     // { month, year } | null

      cv.start((ctx, w, h, t) => {
        const k = clamp((w - 360) / 740, 0, 1);          // 0 @360px … 1 @1100px+
        const fYear = 11.5 + 3 * k;
        const fMonth = 9.5 + 2 * k;

        const years = P.years;                           // ascending (oldest first)
        const n = Math.max(1, years.length);

        // left padding driven by the widest year label so labels never clip
        ctx.font = "700 " + fYear + "px system-ui,sans-serif";
        let maxLW = 0;
        for (const y of years) maxLW = Math.max(maxLW, ctx.measureText(String(y)).width);
        const padL = Math.max(40, maxLW + 18);
        const padR = 14 + 16 * k;
        const padT = 14 + 14 * k;
        const padB = 22 + 12 * k;

        const top = padT, bottom = h - padB;
        const band = Math.max(10, bottom - top);
        const plotW = Math.max(10, w - padL - padR);
        const colW = plotW / 11;
        const Xof = m => padL + colW * (m - 1);

        const step = band / n;
        const baseYof = idx => top + step * (idx + 0.82);
        // cap ridge height by year count so dense stacks stay legible, and never
        // let the tallest possible peak (a month == fleet peak) clip the top edge.
        const overlapK = n <= 2 ? 1.9 : n <= 4 ? 1.5 : n <= 6 ? 1.2 : 0.95;
        const ridgeH = Math.min(step * overlapK, baseYof(0) - 3);

        const pts = [];

        // ── ridges, back to front ───────────────────────────────────────────
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL - 3, 0, w - (padL - 3), bottom + 1);
        ctx.clip();

        years.forEach((y, idx) => {
          const baseY = baseYof(idx);
          const col = C.yearColor(y, P.years);
          const latest = y === P.latestYear;
          const g = reduce ? 1 : easeOut((t - idx * 100) / 850);

          // faint baseline rail (the joyplot stack)
          ctx.strokeStyle = C.hexA(col, .10);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, baseY); ctx.lineTo(padL + plotW, baseY); ctx.stroke();

          const series = P.monthly[String(y)] || [];
          const path = series.map(p => {
            const x = Xof(p.month);
            const yv = baseY - (p.kwh / P.peak) * ridgeH * g;
            pts.push({ x, y: yv, month: p.month, kwh: p.kwh, year: y, col, latest });
            return [x, yv];
          });
          if (path.length < 2) {
            // single visible point (e.g. very thin data): a soft marker, no area
            if (path.length === 1) {
              ctx.fillStyle = C.hexA(col, .8);
              ctx.beginPath(); ctx.arc(path[0][0], path[0][1], 3, 0, 7); ctx.fill();
            }
            return;
          }

          // filled area
          ctx.beginPath(); C.smoothPath(ctx, path);
          ctx.lineTo(path[path.length - 1][0], baseY);
          ctx.lineTo(path[0][0], baseY); ctx.closePath();
          const grad = ctx.createLinearGradient(0, baseY - ridgeH, 0, baseY);
          grad.addColorStop(0, C.hexA(latest ? C.COLORS.good2 : col, .44));
          grad.addColorStop(1, C.hexA(col, .02));
          ctx.fillStyle = grad; ctx.fill();

          // glowing crest
          ctx.save();
          ctx.shadowColor = C.hexA(col, latest ? .85 : .4);
          ctx.shadowBlur = (latest ? 14 : 8) * (0.7 + 0.3 * k);
          ctx.beginPath(); C.smoothPath(ctx, path);
          ctx.strokeStyle = latest ? C.COLORS.good2 : col;
          ctx.lineWidth = latest ? 2.6 : 1.7;
          ctx.stroke();
          ctx.restore();
        });

        // hover guide + marker (inside clip so it rides the ridges cleanly)
        if (hover) {
          const hp = pts.find(p => p.month === hover.month && p.year === hover.year);
          if (hp) {
            ctx.strokeStyle = C.hexA(hp.col, .35);
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(hp.x, top); ctx.lineTo(hp.x, hp.y); ctx.stroke();
            ctx.save();
            ctx.shadowColor = C.hexA(hp.col, .9); ctx.shadowBlur = 12;
            ctx.fillStyle = hp.latest ? C.COLORS.good2 : hp.col;
            ctx.beginPath(); ctx.arc(hp.x, hp.y, 4, 0, 7); ctx.fill();
            ctx.restore();
            ctx.fillStyle = C.COLORS.bg;
            ctx.beginPath(); ctx.arc(hp.x, hp.y, 1.6, 0, 7); ctx.fill();
          }
        }
        ctx.restore(); // unclip

        // ── year labels (second pass, left gutter — never under the ridges) ──
        years.forEach((y, idx) => {
          const baseY = baseYof(idx);
          const latest = y === P.latestYear;
          ctx.fillStyle = latest ? C.COLORS.good2 : C.COLORS.muted;
          ctx.font = (latest ? "700 " : "600 ") + fYear + "px system-ui,sans-serif";
          ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
          ctx.fillText(String(y), padL - 8, baseY - 2);
        });

        // ── month axis ──────────────────────────────────────────────────────
        ctx.font = fMonth + "px system-ui,sans-serif";
        ctx.textAlign = "center"; ctx.fillStyle = C.COLORS.faint;
        for (let m = 1; m <= 12; m++) ctx.fillText(C.MONTHS[m - 1], Xof(m), bottom + padB * 0.62);

        geo = { padL, plotW, top, bottom, pts };
      });

      // ── hover: snap to month column, pick nearest ridge in that column ─────
      function onMove(e) {
        if (!geo || !geo.pts.length) return;
        const rect = cv.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (mx < geo.padL - 12 || mx > geo.padL + geo.plotW + 12 ||
            my < geo.top - 14 || my > geo.bottom + 14) { return hide(); }

        const colW = geo.plotW / 11;
        const month = clamp(Math.round((mx - geo.padL) / colW) + 1, 1, 12);
        let best = null, bd = Infinity;
        for (const p of geo.pts) {
          if (p.month !== month) continue;
          const d = Math.abs(p.y - my);
          if (d < bd) { bd = d; best = p; }
        }
        if (!best) return hide();

        hover = { month: best.month, year: best.year };
        const multi = P.years.length > 1;
        tip.innerHTML =
          (multi ? '<span class="trv-ridgeline-ty" style="color:' + best.col + '">' + best.year + "</span> " : "") +
          C.MONTHS3[best.month - 1] + " · <b>" + C.fmt0(best.kwh) + "</b> kWh";
        tip.style.left = best.x + "px";
        tip.style.top = (best.y - 6) + "px";
        tip.classList.add("on");
      }
      function hide() { if (hover) hover = null; tip.classList.remove("on"); }

      cv.canvas.addEventListener("mousemove", onMove);
      cv.canvas.addEventListener("mouseleave", hide);

      return () => {
        cv.canvas.removeEventListener("mousemove", onMove);
        cv.canvas.removeEventListener("mouseleave", hide);
        tip.remove();
        cv.stop();
      };
    },
  });
})();
