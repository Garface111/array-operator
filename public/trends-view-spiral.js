/* Trends view B, Solar Spiral. Twelve months wrap a clock; each year is a
 * glowing ring whose radius is that month's fleet kWh; a tasteful central sun.
 * Seasonality becomes a shape, the summer bulge. */
(function () {
 "use strict";
 const C = window.AOTrends;
 const TAU = Math.PI * 2;
 const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
 // SKY demo flag (2026-07-12): reference rings/spokes are night-first white
 // alpha, invisible on the sky theme's light canvas. Constant branch only.
 const SKY = document.documentElement.classList.contains("sky");
 const RING = SKY ? "rgba(14,20,32,.10)" : "rgba(255,255,255,.05)";

 C.registerView("spiral", {
 label: "Solar Spiral", badge: "B", order: 2,
 describe: "Twelve months wrap a clock; each year is a glowing ring whose radius is that month's production. Seasonality becomes a shape, the summer bulge.",
 mount(container, P, C) {
 const cv = C.createCanvas(container, { aspect: 1.5, maxHeight: 540, minHeight: 360 });
 const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

 // ── tooltip ────────────────────────────────────────────────────────────
 const tip = document.createElement("div");
 tip.className = "tr-tip trv-spiral-tip";
 container.appendChild(tip);

 // shared geometry, refreshed every frame so hit-testing + tip tracking
 // always use what's actually on screen (handles resize + grow-in).
 let geom = null;
 let hoverMonth = 0; // 1..12, or 0 = none

 function presentAt(m) {
 const rows = [];
 [...P.years].sort((a, b) => b - a).forEach(y => {
 const p = (P.monthly[String(y)] || []).find(q => q.month === m);
 if (p) rows.push({ y, kwh: p.kwh, col: C.yearColor(y, P.years), latest: y === P.latestYear });
 });
 return rows;
 }

 function buildTip(m) {
 const rows = presentAt(m);
 if (!rows.length) { hoverMonth = 0; tip.classList.remove("on"); return; }
 const multi = P.years.length > 1;
 const body = rows.map(r =>
 `<div class="trv-spiral-tip-row">` +
 `<i style="background:${r.col}"></i>` +
 (multi ? `<span>${r.y}</span>` : `<span></span>`) +
 `<b>${C.fmt0(r.kwh)}</b><em>kWh</em>` +
 `</div>`).join("");
 tip.innerHTML = `<div class="trv-spiral-tip-h">${C.esc(C.MONTHS3[m - 1])}</div>${body}`;
 tip.classList.add("on");
 }

 function onMove(e) {
 if (!geom) return;
 const rect = cv.canvas.getBoundingClientRect();
 const x = e.clientX - rect.left, y = e.clientY - rect.top;
 const dx = x - geom.cx, dy = y - geom.cy;
 const rr = Math.hypot(dx, dy);
 // active band: from just outside the sun out to the month-label ring
 if (rr < geom.Rmin * 0.5 || rr > geom.Rmax + geom.labelGap + geom.fpx) {
 if (hoverMonth) { hoverMonth = 0; tip.classList.remove("on"); }
 return;
 }
 const a = Math.atan2(dy, dx);
 const idx = Math.round((a + Math.PI / 2) / (TAU / 12));
 const m = ((idx % 12) + 12) % 12 + 1;
 if (m !== hoverMonth) { hoverMonth = m; buildTip(m); }
 }
 function onLeave() { if (hoverMonth) { hoverMonth = 0; tip.classList.remove("on"); } }
 cv.canvas.addEventListener("mousemove", onMove);
 cv.canvas.addEventListener("mouseleave", onLeave);

 // ── draw ─────────────────────────────────────────────────────────────────
 cv.start((ctx, w, h, t) => {
 if (reduce) t = 2400; // freeze: grow-in done, no pulse
 const S = clamp(w / 820, 0.7, 1.12);
 const useShort = w < 520;
 const fpx = Math.max(9, Math.round((useShort ? 10.5 : 11.5) * S));
 const labelText = m => (useShort ? C.MONTHS[m - 1] : C.MONTHS3[m - 1].toUpperCase());

 const cx = w / 2, cy = h / 2 + Math.min(6, h * 0.012);
 const ang = m => (-Math.PI / 2) + (m - 1) / 12 * TAU;

 // reserve room for the month-label ring on every side so nothing clips
 ctx.font = fpx + "px system-ui";
 let maxLW = 0;
 for (let m = 1; m <= 12; m++) maxLW = Math.max(maxLW, ctx.measureText(labelText(m)).width);
 const edge = Math.round(8 * S) + 4;
 const halfH = fpx;
 const lr = Math.max(40, Math.min(
 w / 2 - maxLW / 2 - edge, // left/right labels
 (h - cy) - halfH - edge, // bottom label (Jul)
 cy - halfH - edge // top label (Jan)
 ));
 const labelGap = Math.round(20 * S);
 const Rmax = Math.max(60, lr - labelGap);
 const Rmin = clamp(Math.min(w, h) * 0.13, 26, Math.min(58, Rmax - 28));
 const denom = P.peak * 1.05;
 const Rk = v => Rmin + (Rmax - Rmin) * clamp(v, 0, denom) / denom;
 const grow = reduce ? 1 : Math.min(1, t / 1400);
 const growR = 0.4 + 0.6 * grow;

 geom = { cx, cy, Rmin, Rmax, labelGap, fpx };

 // concentric reference rings
 ctx.lineWidth = 1;
 for (let i = 1; i <= 4; i++) {
 const r = Rmin + (Rmax - Rmin) * i / 4;
 ctx.strokeStyle = RING;
 ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
 }

 // spokes + month labels
 ctx.textAlign = "center"; ctx.textBaseline = "middle";
 for (let m = 1; m <= 12; m++) {
 const a = ang(m), hot = m === hoverMonth;
 ctx.strokeStyle = hot ? C.hexA(C.COLORS.gold, .22) : RING;
 ctx.lineWidth = hot ? 1.6 : 1;
 ctx.beginPath();
 ctx.moveTo(cx + Math.cos(a) * Rmin, cy + Math.sin(a) * Rmin);
 ctx.lineTo(cx + Math.cos(a) * (Rmax + 6), cy + Math.sin(a) * (Rmax + 6));
 ctx.stroke();
 ctx.fillStyle = hot ? C.COLORS.gold2 : C.COLORS.faint;
 ctx.fillText(labelText(m), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
 }
 ctx.lineWidth = 1;

 // central sun
 const pulse = reduce ? 1 : 1 + 0.07 * Math.sin(t * 0.004);
 const sr = Rmin * pulse;
 const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, sr);
 sg.addColorStop(0, C.hexA(C.COLORS.gold2, .9));
 sg.addColorStop(.55, C.hexA(C.COLORS.gold, .26));
 sg.addColorStop(1, C.hexA(C.COLORS.gold, 0));
 ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, sr, 0, TAU); ctx.fill();
 ctx.fillStyle = C.hexA(C.COLORS.gold2, .9);
 ctx.beginPath(); ctx.arc(cx, cy, Math.max(2.5, Rmin * 0.12), 0, TAU); ctx.fill();

 // year rings
 P.years.forEach(y => {
 const pts = P.monthly[String(y)] || [];
 if (!pts.length) return;
 const full = pts.length === 12;
 const col = C.yearColor(y, P.years), isLatest = y === P.latestYear;
 const coords = pts.map(p => {
 const a = ang(p.month), r = Rk(p.kwh) * growR;
 return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, m: p.month };
 });
 if (coords.length >= 2) {
 const loop = full ? [...coords, coords[0]] : coords;
 ctx.beginPath();
 loop.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
 ctx.save();
 ctx.shadowColor = C.hexA(col, isLatest ? .8 : .38);
 ctx.shadowBlur = (isLatest ? 16 : 8) * S;
 ctx.strokeStyle = col;
 ctx.lineWidth = (isLatest ? 3 : 1.8) * S;
 ctx.globalAlpha = isLatest ? 1 : .76;
 ctx.stroke(); ctx.restore(); ctx.globalAlpha = 1;
 }
 // month dots (emphasize the hovered month)
 coords.forEach(p => {
 const hot = p.m === hoverMonth;
 const base = (isLatest ? 3 : 1.8) * S;
 ctx.fillStyle = col;
 ctx.globalAlpha = isLatest ? 1 : .7;
 ctx.beginPath(); ctx.arc(p.x, p.y, hot ? base + 1.6 : base, 0, TAU); ctx.fill();
 if (hot) {
 ctx.globalAlpha = 1;
 ctx.strokeStyle = C.hexA(C.COLORS.ink, .85);
 ctx.lineWidth = 1.4;
 ctx.beginPath(); ctx.arc(p.x, p.y, base + 4, 0, TAU); ctx.stroke();
 }
 ctx.globalAlpha = 1;
 });
 });

 // legend (top-left)
 ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
 const lf = Math.max(11, Math.round(12.5 * S));
 ctx.font = lf + "px system-ui";
 const showLive = w >= 420;
 [...P.years].sort((a, b) => b - a).forEach((y, i) => {
 const yy = (16 + lf) + i * (lf + 9);
 ctx.fillStyle = C.yearColor(y, P.years);
 ctx.beginPath(); ctx.arc(14, yy - 4, 5, 0, TAU); ctx.fill();
 ctx.fillStyle = C.COLORS.muted;
 ctx.fillText(y + (showLive && y === P.latestYear ? " · live" : ""), 26, yy);
 });

 // keep the tooltip pinned to the outermost present point at hoverMonth
 if (hoverMonth) {
 const rows = presentAt(hoverMonth);
 if (rows.length) {
 const a = ang(hoverMonth);
 let r = 0;
 rows.forEach(rw => { r = Math.max(r, Rk(rw.kwh) * growR); });
 r = Math.max(r, Rmin + 6);
 tip.style.left = (cx + Math.cos(a) * r) + "px";
 tip.style.top = (cy + Math.sin(a) * r) + "px";
 } else if (tip.classList.contains("on")) {
 tip.classList.remove("on");
 }
 }
 });

 return () => {
 cv.canvas.removeEventListener("mousemove", onMove);
 cv.canvas.removeEventListener("mouseleave", onLeave);
 cv.stop();
 if (tip.parentNode) tip.parentNode.removeChild(tip);
 };
 },
 });
})();
