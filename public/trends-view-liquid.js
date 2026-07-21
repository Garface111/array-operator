/* Trends view A, Liquid Energy. The current year rendered as a living gradient
 * fill with an undulating surface + meniscus orb; prior years ghosted behind as
 * fine ridgelines. Hover snaps to the current-year surface and reveals the
 * ghosted prior-year value at that month. Responsive 360→1200px; respects
 * prefers-reduced-motion (calm static frame). */
(function () {
 "use strict";
 const C = window.AOTrends;
 // Guard: if trends-core.js never ran (crawler partial exec, blocked script,
 // parse error) AOTrends is undefined and bare C.registerView is a TypeError.
 // monthly/bars already guard the same way. (Sentry PYTHON-FASTAPI-1G)
 if (!C || !C.registerView) return;

 C.registerView("liquid", {
 label: "Liquid Energy", badge: "A", order: 1,
 describe: "The current year rendered as living fluid, a flowing gradient with a bright leading edge; prior years ghosted behind.",
 mount(container, P, C) {
 const cv = C.createCanvas(container, { aspect: 2.85, maxHeight: 420 });
 const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

 // ── one shared tooltip div (removed in cleanup) ──────────────────────
 const tip = document.createElement("div");
 tip.className = "tr-tip trv-liquid-tip";
 container.appendChild(tip);

 const priorYears = P.years.filter(y => y !== P.latestYear).sort((a, b) => b - a);
 const cur = P.monthly[String(P.latestYear)] || [];
 let hoverMonth = null;

 // Geometry as a pure fn of canvas size so draw + hover stay consistent
 // across resize. Scale `s` drives fonts / padding for responsiveness.
 function geom(w, h) {
 const s = Math.max(0.74, Math.min(1.12, w / 820));
 const PAD = {
 l: Math.round(30 * s) + 12,
 r: Math.round(12 * s) + 8,
 t: Math.round(26 * s) + 10,
 b: Math.round(20 * s) + 12,
 };
 const plotW = Math.max(1, w - PAD.l - PAD.r);
 const plotH = Math.max(1, h - PAD.t - PAD.b);
 const top = P.peak * 1.12;
 const X = m => PAD.l + plotW * (m - 1) / 11;
 const Y = v => PAD.t + plotH * (1 - v / top);
 return { s, PAD, plotW, plotH, top, X, Y, baseY: Y(0) };
 }
 const fs = (px, s) => Math.max(9, px * s);

 cv.start((ctx, w, h, t) => {
 if (reduce) t = 1500; // freeze the surface waves
 const G = geom(w, h);
 const { PAD, top, X, Y, baseY, s } = G;

 // grid + y labels
 ctx.lineWidth = 1; ctx.font = fs(11, s) + "px system-ui";
 for (let i = 0; i <= 4; i++) {
 const val = top * i / 4, gy = Y(val);
 ctx.strokeStyle = C.COLORS.line;
 ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(w - PAD.r, gy); ctx.stroke();
 ctx.fillStyle = C.COLORS.faint; ctx.textAlign = "right"; ctx.textBaseline = "middle";
 ctx.fillText(C.kCompact(val), PAD.l - 7, gy);
 }
 // month labels
 ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
 for (let m = 1; m <= 12; m++) {
 ctx.fillStyle = C.COLORS.faint;
 ctx.fillText(C.MONTHS[m - 1], X(m), h - Math.round(10 * s) - 2);
 }

 // compact legend (year chips) top-left, only when >1 year
 if (P.years.length > 1) {
 ctx.font = fs(11.5, s) + "px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
 const ly = Math.max(11, PAD.t - Math.round(11 * s));
 const dot = Math.max(2.6, 3 * s);
 let lx = PAD.l;
 [P.latestYear, ...priorYears].forEach(y => {
 const isCur = y === P.latestYear;
 const col = isCur ? C.COLORS.good2 : C.yearColor(y, P.years);
 const txt = String(y);
 const tw = ctx.measureText(txt).width;
 if (lx + dot * 2 + 6 + tw > w - PAD.r) return; // never overflow
 ctx.fillStyle = isCur ? col : C.hexA(col, 0.85);
 ctx.beginPath(); ctx.arc(lx + dot, ly, dot, 0, 7); ctx.fill();
 ctx.fillStyle = isCur ? C.COLORS.ink : C.COLORS.muted;
 ctx.fillText(txt, lx + dot * 2 + 5, ly + 0.5);
 lx += dot * 2 + 5 + tw + 14;
 });
 }

 // ghost prior years, fine ridgelines so the liquid stays the hero
 priorYears.forEach(y => {
 const pts = (P.monthly[String(y)] || []).map(p => [X(p.month), Y(p.kwh)]);
 if (pts.length < 2) return;
 ctx.beginPath(); C.smoothPath(ctx, pts);
 ctx.strokeStyle = C.hexA(C.yearColor(y, P.years), 0.42);
 ctx.lineWidth = 1.6; ctx.stroke();
 });

 // ── liquid current year ──────────────────────────────────────────
 if (cur.length) {
 const surf = cur.map(p => {
 const x = X(p.month);
 const wave = reduce ? 0
 : Math.sin(x * 0.018 + t * 0.0016) * 4 + Math.sin(x * 0.05 - t * 0.0026) * 2.2;
 return [x, Y(p.kwh) + wave];
 });

 // body fill (gently breathing top alpha conveys "flow")
 const breathe = reduce ? 0 : 0.06 * Math.sin(t * 0.0009);
 ctx.beginPath(); C.smoothPath(ctx, surf);
 ctx.lineTo(surf[surf.length - 1][0], baseY);
 ctx.lineTo(surf[0][0], baseY); ctx.closePath();
 const g = ctx.createLinearGradient(0, PAD.t, 0, baseY);
 g.addColorStop(0, C.hexA(C.COLORS.good2, 0.52 + breathe));
 g.addColorStop(0.5, C.hexA(C.COLORS.good, 0.30));
 g.addColorStop(1, C.hexA(C.COLORS.good, 0.04));
 ctx.fillStyle = g; ctx.fill();

 // meniscus highlight (static surface-tension sheen just under the line)
 ctx.beginPath();
 C.smoothPath(ctx, surf.map(p => [p[0], p[1] + 3]));
 ctx.strokeStyle = C.hexA(C.COLORS.good2, 0.18); ctx.lineWidth = 1.4; ctx.stroke();

 // glowing surface line
 ctx.save();
 ctx.shadowColor = C.hexA(C.COLORS.good, 0.8); ctx.shadowBlur = 16;
 ctx.beginPath(); C.smoothPath(ctx, surf);
 ctx.strokeStyle = C.COLORS.good2; ctx.lineWidth = 2.6; ctx.stroke();
 ctx.restore();

 // meniscus orb at the leading edge
 const last = surf[surf.length - 1];
 const pulse = reduce ? 1 : 1 + 0.16 * Math.sin(t * 0.005);
 const rg = ctx.createRadialGradient(last[0], last[1], 0, last[0], last[1], 16 * pulse);
 rg.addColorStop(0, C.hexA(C.COLORS.good2, 0.95));
 rg.addColorStop(1, C.hexA(C.COLORS.good, 0));
 ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(last[0], last[1], 16 * pulse, 0, 7); ctx.fill();
 ctx.fillStyle = C.COLORS.good2; ctx.beginPath(); ctx.arc(last[0], last[1], 3.4, 0, 7); ctx.fill();
 }

 // ── hover overlay (guide + snapped dots) ─────────────────────────
 if (hoverMonth != null) {
 const cp = cur.find(p => p.month === hoverMonth);
 const gx = X(hoverMonth);
 ctx.strokeStyle = C.hexA(C.COLORS.ink, 0.14); ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(gx, PAD.t); ctx.lineTo(gx, baseY); ctx.stroke();
 priorYears.forEach(y => {
 const f = (P.monthly[String(y)] || []).find(q => q.month === hoverMonth);
 if (!f) return;
 ctx.fillStyle = C.hexA(C.yearColor(y, P.years), 0.95);
 ctx.beginPath(); ctx.arc(gx, Y(f.kwh), 3.2, 0, 7); ctx.fill();
 });
 if (cp) {
 ctx.save();
 ctx.shadowColor = C.hexA(C.COLORS.good, 0.9); ctx.shadowBlur = 12;
 ctx.fillStyle = C.COLORS.good2;
 ctx.beginPath(); ctx.arc(gx, Y(cp.kwh), 4.2, 0, 7); ctx.fill();
 ctx.restore();
 }
 }
 });

 // ── interaction ────────────────────────────────────────────────────
 function nearest(mx) {
 if (!cur.length) return null;
 const G = geom(cv.w, cv.h);
 let best = null, bd = Infinity;
 cur.forEach(p => { const d = Math.abs(G.X(p.month) - mx); if (d < bd) { bd = d; best = p; } });
 return best;
 }
 function showTip(p) {
 const G = geom(cv.w, cv.h);
 const x = G.X(p.month), y = G.Y(p.kwh);
 const multi = P.years.length > 1;
 let html = `${C.MONTHS3[p.month - 1]}${multi ? " " + P.latestYear : ""}<br><b>${C.fmt0(p.kwh)} kWh</b>`;
 priorYears.forEach(yr => {
 const f = (P.monthly[String(yr)] || []).find(q => q.month === p.month);
 if (!f) return;
 html += `<span class="trv-liquid-sub" style="color:${C.hexA(C.yearColor(yr, P.years), 0.95)}">${yr}: ${C.fmt0(f.kwh)} kWh</span>`;
 });
 tip.innerHTML = html;
 const half = tip.offsetWidth / 2;
 const lx = Math.max(half + 4, Math.min(cv.w - half - 4, x));
 const above = y > 70;
 tip.style.left = lx + "px";
 tip.style.top = y + "px";
 tip.style.transform = above ? "translate(-50%,-118%)" : "translate(-50%,26%)";
 tip.classList.add("on");
 }
 function hide() { hoverMonth = null; tip.classList.remove("on"); }

 function onMove(e) {
 const r = cv.canvas.getBoundingClientRect();
 const mx = e.clientX - r.left;
 const p = nearest(mx);
 if (!p) { hide(); return; }
 hoverMonth = p.month;
 showTip(p);
 }
 cv.canvas.addEventListener("mousemove", onMove);
 cv.canvas.addEventListener("mouseleave", hide);

 return () => {
 cv.canvas.removeEventListener("mousemove", onMove);
 cv.canvas.removeEventListener("mouseleave", hide);
 if (tip.parentNode) tip.parentNode.removeChild(tip);
 cv.stop();
 };
 },
 });
})();
