/* ============================================================================
 * Array Operator, Trends tab orchestrator (trends.js)
 *
 * Fetches the portfolio-wide production payload and renders the whole Trends
 * tab as ONE crafted instrument:
 * - an animated count-up stat band (TTM / lifetime / latest YoY / savings)
 * - a segmented VIEW SWITCHER with a sliding indicator + per-view accent retint
 * - the active visualization (mounted from the registry in trends-core.js),
 * swapped with a calm crossfade
 * - the by-array drill-down table
 *
 * The four visualizations live in trends-view-*.js and self-register on
 * window.AOTrends. This file owns layout + data + which view is active + the
 * shared "sublime layer"; it does NOT know how any individual chart draws.
 *
 * Source: GET /v1/array-owners/fleet-trends. Contract: TRENDS-VIEWS-CONTRACT.md
 * ==========================================================================*/
(function () {
 "use strict";

 const API = "/v1/array-owners/fleet-trends";
 // Long downloads (master data zip / per-array packs) MUST NOT go through the
 // Netlify /v1/* proxy — it buffers and 504s at ~26s (same class as Energy Agent
 // chat). Hit Railway directly on the prod host; CORS already allows arrayoperator.com.
 const LONG_API_ORIGIN = (function () {
  if (typeof window.__AO_API_ORIGIN === "string") return window.__AO_API_ORIGIN;
  var h = (location.hostname || "").toLowerCase();
  if (h === "arrayoperator.com" || h === "www.arrayoperator.com") {
   return "https://web-production-49c83.up.railway.app";
  }
  return "";
 })();
 const VIEW_KEY = "ao_trends_view";
 const C = () => window.AOTrends;
 const REDUCE = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

 // Per-view accent hue, retints the switcher pill, ambient glow and frame so
 // each visualization feels like its own room while staying one family.
 const ACCENT = {
 bars: "#3fd68a",
 monthly: "#3fd68a",
 liquid: "#3fd68a",
 spiral: "#f5b942",
 ridgeline: "#5ec2ff",
 heatfield: "#ffd479",
 };

 // Views that need 2+ years of history to be meaningful (decorative multi-year
 // art). With a single year they render near-empty, so we caption them // rather than letting them look broken.
 const MULTIYEAR_VIEWS = { liquid: 1, spiral: 1, ridgeline: 1, heatfield: 1 };

 function session() { try { return localStorage.getItem("so_session"); } catch (e) { return null; } }
 function root() { return document.getElementById("trendsRoot"); }
 function savedView() { try { return localStorage.getItem(VIEW_KEY); } catch (e) { return null; } }
 function saveView(k) { try { localStorage.setItem(VIEW_KEY, k); } catch (e) {} }

 let _activeStops = []; // cleanup fns for every mounted view (stacked column)
 let _prepped = null; // prepared data for the current payload
 let _switching = false;
 let _arrayId = null; // current per-array filter scope (null = whole fleet)
 let _fleetArrays = []; // full array list for the filter dropdown (kept across scopes)

 function loading() {
 const r = root(); if (!r) return;
 r.innerHTML = '<div class="empty" style="padding:34px 0;color:var(--faint)">Loading trends…</div>';
 }
 function empty(msg) {
 const r = root(); if (!r) return;
 teardown();
 r.innerHTML = `<div class="tr-empty">
 <div class="tr-empty-ic" aria-hidden="true">📈</div>
 <div class="tr-empty-h">Not enough history yet</div>
 <div class="tr-empty-p">${C().esc(msg || "Multi-year trends appear once your arrays have logged a few months of production. Connect your arrays on the Arrays tab to start building history.")}</div>
 </div>`;
 }

 function teardown() {
 for (const stop of _activeStops) { try { stop(); } catch (e) {} }
 _activeStops = [];
 }

 // ── animated count-up ──────────────────────────────────────────────────────
 const easeOut = t => 1 - Math.pow(1 - t, 3);
 function countUp(el) {
 const target = parseFloat(el.getAttribute("data-target"));
 if (isNaN(target)) return;
 const dec = parseInt(el.getAttribute("data-dec") || "0", 10);
 const pre = el.getAttribute("data-pre") || "";
 const suf = el.getAttribute("data-suf") || "";
 const sign = el.getAttribute("data-sign") === "1";
 const dur = 1100;
 const fmt = v => {
 const s = sign && v > 0 ? "+" : "";
 const body = dec > 0
 ? Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
 : Math.round(Math.abs(v)).toLocaleString();
 return pre + (v < 0 ? "-" : s) + body + suf;
 };
 if (REDUCE) { el.textContent = fmt(target); return; }
 const t0 = performance.now();
 (function tick(now) {
 const p = Math.min(1, (now - t0) / dur);
 el.textContent = fmt(target * easeOut(p));
 if (p < 1) requestAnimationFrame(tick);
 else el.textContent = fmt(target);
 })(t0);
 }

 // Data-freshness + coverage line, a power user wants to know "through when,
 // and how many arrays are actually reporting" before trusting the numbers.
 function freshnessLine(d) {
 const c = C();
 const daily = d.daily_recent || [];
 let lastDay = null;
 for (const pt of daily) { if (pt && pt.day) lastDay = pt.day; }
 const arrays = d.by_array || [];
 const reporting = arrays.filter(a => (a.lifetime_kwh || 0) > 0).length;
 const total = arrays.length;
 const parts = [];
 if (lastDay) {
 const dt = new Date(lastDay + "T00:00:00");
 const ago = Math.round((Date.now() - dt.getTime()) / 86400000);
 const when = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
 parts.push(`Through <b>${c.esc(when)}</b>${ago > 1 ? ` (${ago}d ago)` : ago === 1 ? " (yesterday)" : " (today)"}`);
 }
 if (total) parts.push(`<b>${reporting}</b>/${total} array${total === 1 ? "" : "s"} reporting`);
 if (!parts.length) return "";
 return `<div class="tr-fresh">${parts.join(" · ")}
 <button class="tr-export" id="trExport" type="button" title="Download monthly + daily production as CSV">↓ Export CSV</button>
 <button class="tr-export tr-export-pack" id="trMasterPack" type="button" title="Download a master spreadsheet pack for every array: all utility bills, daily + monthly history, YoY / trailing 12 mo">↓ Master data (all arrays)</button></div>`;
 }

 function statBand(d) {
 const c = C();
 const years = d.years || [];
 const latestYr = years.length ? Math.max(...years) : null;
 let latestYoY = null, yoyMonths = 0, prevYr = null;
 if (years.length >= 2) {
 prevYr = years[years.length - 2];
 const cur = d.monthly_by_year[String(latestYr)] || [];
 const prev = d.monthly_by_year[String(prevYr)] || [];
 const prevByMonth = {}; prev.forEach(p => prevByMonth[p.month] = p.kwh || 0);
 // FULL MONTHS ONLY (Paul Bozuwa 2026-07-15): never compare a partial
 // current calendar month to the same month last year (full). Drop the
 // in-progress month from both sides of the YoY sum.
 const now = new Date();
 const curY = now.getFullYear(), curM = now.getMonth() + 1;
 const skipPartial = (m) => latestYr === curY && m === curM && now.getDate() < 28;
 let curSum = 0, prevSum = 0;
 cur.forEach(p => {
 if (skipPartial(p.month)) return;
 if (prevByMonth[p.month] != null) {
 curSum += (p.kwh || 0);
 prevSum += prevByMonth[p.month];
 yoyMonths++;
 }
 });
 if (prevSum > 0 && yoyMonths > 0) latestYoY = (100 * (curSum - prevSum) / prevSum);
 }
 // Best single month on record (a real, satisfying number even with 1 year).
 let bestKwh = null, bestLabel = "";
 const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
 for (const y of years) {
 for (const p of (d.monthly_by_year[String(y)] || [])) {
 if (bestKwh == null || (p.kwh || 0) > bestKwh) { bestKwh = p.kwh || 0; bestLabel = `${MON[p.month - 1]} ${y}`; }
 }
 }
 // Implied blended rate behind the savings number, for the tooltip.
 const rate = (d.ttm_savings_usd && d.ttm_kwh) ? (d.ttm_savings_usd / d.ttm_kwh) : null;
 const yoyTitle = yoyMonths > 0
 ? `${latestYr} vs ${prevYr}, same ${yoyMonths} full month${yoyMonths === 1 ? "" : "s"} (in-progress month excluded)`
 : "Year-over-year appears once you have two years of history";
 const savTitle = rate ? `≈ $${rate.toFixed(3)}/kWh blended rate × trailing-12-mo kWh` : "Estimated value of the energy produced";

 const stat = (k, valHtml, extra) =>
 `<div class="tr-stat"${extra || ""}><span class="tr-glow"></span><div class="tr-k">${k}</div>${valHtml}</div>`;
 const num = (target, { dec = 0, pre = "", suf = "", sign = false, cls = "" } = {}) =>
 `<div class="tr-v ${cls}" data-target="${target}" data-dec="${dec}" data-pre="${pre}" data-suf="${suf}" data-sign="${sign ? 1 : 0}">${pre}0${suf}</div>`;
 const dash = `<div class="tr-v tr-v-dim">—</div>`;
 const txt = (s, cls) => `<div class="tr-v ${cls || ""}">${s}</div>`;

 // 4th tile is adaptive: show real YoY when we have 2+ years; otherwise show
 // BEST MONTH (a meaningful number) instead of a confusing "—".
 const fourth = latestYoY != null
 ? stat("LATEST YOY", num(latestYoY, { dec: 1, suf: "%", sign: true, cls: latestYoY < 0 ? "neg" : "pos" }), ` title="${yoyTitle}"`)
 : stat("BEST MONTH", (bestKwh != null
 ? `<div class="tr-v">${c.fmt0(bestKwh)}<span class="tr-v-unit"> kWh</span></div><div class="tr-v-sub">${c.esc(bestLabel)}</div>`
 : dash));

 return `<div class="tr-stats">
 ${stat("TRAILING 12 MO", d.ttm_kwh == null ? dash : `${num(d.ttm_kwh, { suf: " kWh" })}`)}
 ${stat("LIFETIME (FLEET)", d.lifetime_kwh == null ? dash : num(d.lifetime_kwh, { suf: " kWh" }))}
 ${stat("EST. VALUE (12 MO)", d.ttm_savings_usd == null ? dash : num(d.ttm_savings_usd, { pre: "$" }), ` title="${savTitle}"`)}
 ${fourth}
 </div>`;
 }

 // Master Array Data Pack: zip of per-array xlsx (utility bills + full history).
 // Direct-to-Railway on prod so the Netlify proxy can't 504 a long build.
 async function downloadMasterPackZip(btn) {
  const tok = session();
  if (!tok) {
   try { window.AODialog && AODialog.alert("Sign in to download master data packs.", { title: "Sign in" }); } catch (e) {}
   return;
  }
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Building packs…"; }
  try {
   const url = LONG_API_ORIGIN + "/v1/array-owners/master-data.zip";
   const r = await fetch(url, {
    headers: { Authorization: "Bearer " + tok },
   });
   if (!r.ok) {
    let msg = "Download failed (" + r.status + ")";
    try { const j = await r.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
    if (r.status === 504 || r.status === 502) {
     msg = "That took too long through the edge proxy. Retrying direct…";
    }
    throw new Error(msg);
   }
   if (btn) btn.textContent = "Saving…";
   const blob = await r.blob();
   const cd = r.headers.get("Content-Disposition") || "";
   const mm = /filename="?([^"]+)"?/.exec(cd);
   const objectUrl = URL.createObjectURL(blob);
   const a = document.createElement("a");
   a.href = objectUrl;
   a.download = (mm && mm[1]) || "fleet-master-data.zip";
   document.body.appendChild(a); a.click(); a.remove();
   setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (e) {
   try {
    window.AODialog && AODialog.alert(String(e.message || e), { title: "Master data pack" });
   } catch (e2) { alert(String(e.message || e)); }
  } finally {
   if (btn) { btn.disabled = false; btn.textContent = label || "↓ Master data (all arrays)"; }
  }
 }

 // Single-array master pack (from by-array table row buttons).
 async function downloadArrayMasterPack(arrayId, arrayName, btn) {
  const tok = session();
  if (!tok || !arrayId) return;
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
   const url = LONG_API_ORIGIN + "/v1/array-owners/arrays/" + encodeURIComponent(arrayId) + "/master-data.xlsx";
   const r = await fetch(url, {
    headers: { Authorization: "Bearer " + tok },
   });
   if (!r.ok) throw new Error("Download failed (" + r.status + ")");
   const blob = await r.blob();
   const cd = r.headers.get("Content-Disposition") || "";
   const mm = /filename="?([^"]+)"?/.exec(cd);
   const objectUrl = URL.createObjectURL(blob);
   const a = document.createElement("a");
   a.href = objectUrl;
   a.download = (mm && mm[1]) || ((arrayName || "array") + "-master-data.xlsx");
   document.body.appendChild(a); a.click(); a.remove();
   setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (e) {
   try { window.AODialog && AODialog.alert(String(e.message || e), { title: "Master data" }); }
   catch (e2) { alert(String(e.message || e)); }
  } finally {
   if (btn) { btn.disabled = false; btn.textContent = label || "↓ Pack"; }
  }
 }

 // Build a CSV of monthly + daily production and trigger a download.
 function exportCsv(d) {
 const rows = [["section", "period", "kwh"]];
 const years = (d.years || []).slice().sort((a, b) => a - b);
 const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
 for (const y of years) {
 for (const p of (d.monthly_by_year[String(y)] || [])) {
 rows.push(["monthly", `${y}-${String(p.month).padStart(2, "0")} (${MON[p.month - 1]} ${y})`, p.kwh]);
 }
 }
 for (const pt of (d.daily_recent || [])) rows.push(["daily", pt.day, pt.kwh]);
 const csv = rows.map(r => r.map(v => {
 const s = String(v == null ? "" : v);
 return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
 }).join(",")).join("\n");
 const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
 const url = URL.createObjectURL(blob);
 const a = document.createElement("a");
 a.href = url;
 a.download = `array-operator-production-${new Date().toISOString().slice(0, 10)}.csv`;
 document.body.appendChild(a); a.click(); a.remove();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
 }

 function switcher(activeKey) {
 const views = C().listViews();
 return `<div class="tr-switch" role="tablist" aria-label="Chart style">
 <span class="tr-switch-ind" aria-hidden="true"></span>` + views.map(v =>
 `<button class="tr-seg ${v.key === activeKey ? "on" : ""}" data-view="${v.key}" role="tab" aria-selected="${v.key === activeKey}">
 <span class="tr-seg-b">${C().esc(v.badge || "")}</span><span class="tr-seg-lbl">${C().esc(v.label)}</span>
 </button>`).join("") + `</div>`;
 }

 // slide the indicator pill under the active segment
 function moveIndicator() {
 const sw = document.querySelector(".tr-switch");
 const ind = document.querySelector(".tr-switch-ind");
 const on = document.querySelector(".tr-seg.on");
 if (!sw || !ind || !on) return;
 const r = on.getBoundingClientRect(), pr = sw.getBoundingClientRect();
 ind.style.width = r.width + "px";
 ind.style.transform = `translateX(${r.left - pr.left - 4}px)`;
 ind.style.opacity = "1";
 }

 function byArrayTable(byArray) {
 const c = C();
 if (!byArray || !byArray.length) return "";
 // Default sort: most production first (a power user scans top performers).
 const rows = byArray.slice().sort((a, b) => (b.lifetime_kwh || 0) - (a.lifetime_kwh || 0));
 const total = rows.reduce((s, a) => s + (a.lifetime_kwh || 0), 0) || 1;
 const body = rows.map((a, i) => {
 const kwh = a.lifetime_kwh || 0;
 const share = Math.round((kwh / total) * 100);
 const yrs = (a.years || []).join(", ");
 const dead = kwh <= 0;
 const status = dead
 ? `<span class="tr-astat tr-astat-none" title="No production on record yet, newly connected, or awaiting its first data pull">no data yet</span>`
 : `<span class="tr-astat tr-astat-ok">${share}% of fleet</span>`;
 return `<tr style="--ri:${i}" class="${dead ? "tr-arow-dim" : ""}">
 <td class="tr-aname">${c.esc(a.name)}</td>
 <td class="tr-anum">${dead ? "—" : c.fmt0(kwh) + " kWh"}</td>
 <td>${status}</td>
 <td class="tr-ayears">${yrs || "—"}</td>
 <td class="tr-apack"><button type="button" class="tr-pack-btn" data-pack-id="${c.esc(String(a.array_id))}" data-pack-name="${c.esc(a.name || "")}" title="Download master data pack: all utility bills, daily + monthly history, YoY / trailing 12 mo">↓ Pack</button></td></tr>`;
 }).join("");
 return `<div class="tr-block">
 <div class="tr-block-h">BY ARRAY</div>
 <div class="tr-block-sub">Lifetime production, share of fleet, and the years on record for each array, most productive first. <b>↓ Pack</b> downloads the full multi-year master spreadsheet for that array (utility bills + daily history).</div>
 <div class="tr-tablewrap"><table class="tr-table">
 <thead><tr><th>Array</th><th class="tr-anum">Lifetime</th><th>Share</th><th>Years</th><th></th></tr></thead>
 <tbody>${body}</tbody>
 </table></div>
 </div>`;
 }

 // Year × array kWh matrix (Paul Bozuwa 2026-07-15): each array as a row,
 // calendar years as columns + trailing-12-mo (for YoY vs prior full year) +
 // lifetime. Current year column is YTD — incomplete, so TTM is the fair compare.
 // Production only — offtaker $ true-ups stay on Invoices when that history exists.
 function yearMatrix(byArray, fleetYears) {
 const c = C();
 if (!byArray || !byArray.length) return "";
 const yearSet = {};
 (fleetYears || []).forEach(y => { yearSet[String(y)] = 1; });
 byArray.forEach(a => {
 Object.keys(a.kwh_by_year || {}).forEach(y => { yearSet[y] = 1; });
 });
 const years = Object.keys(yearSet).map(Number).filter(n => n > 1990).sort((a, b) => a - b);
 if (!years.length) return "";
 const curY = new Date().getFullYear();
 const priorY = curY - 1;
 const rows = byArray.slice().sort((a, b) => (b.lifetime_kwh || 0) - (a.lifetime_kwh || 0));
 const colTot = {}; years.forEach(y => { colTot[y] = 0; });
 let lifeTot = 0;
 let ttmTot = 0;
 let priorTot = 0;
 const body = rows.map((a, i) => {
 const byY = a.kwh_by_year || {};
 const cells = years.map(y => {
 const v = Number(byY[String(y)] || 0);
 colTot[y] += v;
 return `<td class="tr-anum">${v > 0 ? c.fmt0(v) : "—"}</td>`;
 }).join("");
 const life = Number(a.lifetime_kwh || 0);
 lifeTot += life;
 const ttm = Number(a.kwh_ttm != null ? a.kwh_ttm : 0);
 ttmTot += ttm;
 const prior = Number(a.kwh_prior_year != null ? a.kwh_prior_year
  : (byY[String(priorY)] || 0));
 if (prior > 0) priorTot += prior;
 // YoY: trailing 12 mo vs prior full calendar year (apples-to-apples-ish)
 let yoyCell = `<td class="tr-anum tr-ym-yoy">—</td>`;
 const pct = a.ttm_vs_prior_year_pct;
 if (pct != null && isFinite(pct) && prior > 0 && ttm > 0) {
  const cls = pct < 0 ? "neg" : "pos";
  const sign = pct > 0 ? "+" : "";
  yoyCell = `<td class="tr-anum tr-ym-yoy ${cls}" title="Trailing 12 months vs full ${priorY}">${sign}${Number(pct).toFixed(1)}%</td>`;
 } else if (prior > 0 && ttm > 0) {
  const p = 100 * (ttm - prior) / prior;
  const cls = p < 0 ? "neg" : "pos";
  const sign = p > 0 ? "+" : "";
  yoyCell = `<td class="tr-anum tr-ym-yoy ${cls}" title="Trailing 12 months vs full ${priorY}">${sign}${p.toFixed(1)}%</td>`;
 }
 return `<tr style="--ri:${i}">
 <td class="tr-aname">${c.esc(a.name)}</td>
 ${cells}
 <td class="tr-anum tr-ym-ttm" title="Sum of the last 12 calendar months">${ttm > 0 ? c.fmt0(ttm) : "—"}</td>
 ${yoyCell}
 <td class="tr-anum tr-ym-life">${life > 0 ? c.fmt0(life) : "—"}</td>
 </tr>`;
 }).join("");
 let footYoy = `<td class="tr-anum tr-ym-yoy">—</td>`;
 if (priorTot > 0 && ttmTot > 0) {
  const p = 100 * (ttmTot - priorTot) / priorTot;
  const cls = p < 0 ? "neg" : "pos";
  const sign = p > 0 ? "+" : "";
  footYoy = `<td class="tr-anum tr-ym-yoy ${cls}"><b>${sign}${p.toFixed(1)}%</b></td>`;
 }
 const foot = `<tr class="tr-ym-tot">
 <td class="tr-aname"><b>Fleet total</b></td>
 ${years.map(y => `<td class="tr-anum"><b>${colTot[y] > 0 ? c.fmt0(colTot[y]) : "—"}</b></td>`).join("")}
 <td class="tr-anum tr-ym-ttm"><b>${ttmTot > 0 ? c.fmt0(ttmTot) : "—"}</b></td>
 ${footYoy}
 <td class="tr-anum tr-ym-life"><b>${lifeTot > 0 ? c.fmt0(lifeTot) : "—"}</b></td>
 </tr>`;
 const yHeads = years.map(y =>
 `<th class="tr-anum">${y}${y === curY ? " <span class=\"tr-ym-partial\" title=\"Calendar year to date — incomplete year\">YTD</span>" : ""}</th>`
 ).join("");
 return `<div class="tr-block tr-ymatrix" id="trYearMatrix">
 <div class="tr-block-h">PRODUCTION BY YEAR</div>
 <div class="tr-block-sub">kWh by array and calendar year. ${curY} is year-to-date (incomplete). <b>Trailing 12 mo</b> is the rolling last year — compare it to full ${priorY} via the YoY column.</div>
 <div class="tr-tablewrap tr-tablewrap-scroll"><table class="tr-table tr-ym-table">
 <thead><tr><th>Array</th>${yHeads}<th class="tr-anum tr-ym-ttm" title="Last 12 calendar months of production">Trailing 12 mo</th><th class="tr-anum tr-ym-yoy" title="Trailing 12 months vs full prior calendar year">vs ${priorY}</th><th class="tr-anum tr-ym-life">Lifetime</th></tr></thead>
 <tbody>${body}${foot}</tbody>
 </table></div>
 </div>`;
 }

 function applyAccent(key) {
 const block = document.querySelector(".tr-chartblock");
 if (block && ACCENT[key]) block.style.setProperty("--tr-accent", ACCENT[key]);
 }

 function doMount(key) {
 const c = C();
 const view = c.getView(key) || c.listViews()[0];
 if (!view) return;
 teardown();
 document.querySelectorAll(".tr-seg").forEach(b => {
 const on = b.getAttribute("data-view") === view.key;
 b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
 });
 moveIndicator();
 applyAccent(view.key);
 const desc = document.getElementById("trViewDesc");
 if (desc) { desc.textContent = view.describe || ""; }
 const host = document.getElementById("trChartHost");
 if (!host) return;
 host.innerHTML = "";
 host.style.position = "relative";
 saveView(view.key);
 try { _activeStop = view.mount(host, _prepped, c) || null; }
 catch (e) {
 host.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">This view hit an error. Try another style above.</div></div>`;
 if (window.console) console.error("trends view " + view.key + " failed", e);
 }
 }

 // crossfade: dim current out, swap, fade new in (calm, ~190ms each way)
 function mountView(key, opts) {
 opts = opts || {};
 const host = document.getElementById("trChartHost");
 const desc = document.getElementById("trViewDesc");
 if (!host || opts.immediate || REDUCE) { doMount(key); fadeIn(host, desc); return; }
 if (_switching) return;
 _switching = true;
 host.classList.add("tr-fading");
 if (desc) desc.classList.add("tr-fading");
 setTimeout(() => {
 doMount(key);
 fadeIn(host, desc);
 _switching = false;
 }, 190);
 }
 function fadeIn(host, desc) {
 if (!host) return;
 requestAnimationFrame(() => {
 host.classList.remove("tr-fading");
 if (desc) desc.classList.remove("tr-fading");
 });
 }

 // Per-array filter bar: a dropdown to scope every chart to one array (or the
 // whole fleet). The option list always comes from the full fleet (_fleetArrays
 // kept across scopes) so you can switch freely. Only shown when 2+ arrays.
 function filterBar() {
 const c = C();
 if (!_fleetArrays || _fleetArrays.length < 2) return "";
 const opts = [`<option value=""${_arrayId == null ? " selected" : ""}>All arrays (fleet)</option>`]
 .concat(_fleetArrays.map(a => {
 const dead = (a.lifetime_kwh || 0) <= 0;
 const label = c.esc(a.name) + (dead ? " (no data yet)" : "");
 return `<option value="${a.array_id}"${String(_arrayId) === String(a.array_id) ? " selected" : ""}>${label}</option>`;
 }))
 .join("");
 const scopedName = _arrayId != null
 ? (_fleetArrays.find(a => String(a.array_id) === String(_arrayId)) || {}).name
 : null;
 return `<div class="tr-filter">
 <label class="tr-filter-lbl" for="trArraySel">Showing</label>
 <div class="tr-select-wrap">
 <select id="trArraySel" class="tr-select" aria-label="Filter trends by array">${opts}</select>
 </div>
 ${scopedName ? `<span class="tr-filter-scope">one array</span>` : `<span class="tr-filter-scope">${_fleetArrays.length} arrays combined</span>`}
 </div>`;
 }

 function render(d) {
 const c = C();
 const r = root(); if (!r) return;
 // Keep the full fleet array list for the filter dropdown (it stays complete
 // even when the payload is scoped to one array). Only refresh it when we're
 // looking at the whole fleet, since a scoped payload still returns full
 // by_array, but guard anyway.
 if (Array.isArray(d.by_array) && d.by_array.length) _fleetArrays = d.by_array;
 _arrayId = d.selected_array_id != null ? d.selected_array_id : null;

 const years = d.years || [];
 // A scoped array with no data shouldn't blow away the filter, show an
 // inline empty state but keep the dropdown so the user can switch back.
 if (!years.length) {
 teardown();
 const scopedName = _arrayId != null
 ? ((_fleetArrays.find(a => String(a.array_id) === String(_arrayId)) || {}).name || "this array")
 : null;
 if (_arrayId != null) {
 r.innerHTML = `${filterBar()}
 <div class="tr-empty"><div class="tr-empty-ic" aria-hidden="true">📈</div>
 <div class="tr-empty-h">No production history for ${c.esc(scopedName)} yet</div>
 <div class="tr-empty-p">This array hasn't logged generation we can chart. Pick another array or “All arrays” above.</div></div>`;
 wireFilter(d);
 } else { empty(); }
 return;
 }
 _prepped = c.prep(d);
 teardown();

 const views = c.listViews(); // ordered: bars, monthly, liquid, spiral, heatfield…
 const singleYear = years.length < 2;

 // Stat band + ONE block per visualization, stacked in a column. Each block
 // carries its own accent + ambient glow + title/description, and hosts its
 // own canvas. No switcher, no tabbing, the operator scrolls the column.
 // Multi-year art is captioned when there's <2 years of history so
 // a near-empty chart reads as "needs more history", not "broken".
 const blocks = views.map(v => {
 const needsYears = singleYear && MULTIYEAR_VIEWS[v.key];
 const note = needsYears
 ? `<div class="tr-needyears">Fills in once you have a second year of history, comparing years is what this view is for.</div>`
 : "";
 return `
 <div class="tr-block tr-chartblock tr-stacked${needsYears ? " tr-dimmed" : ""}" style="--tr-accent:${ACCENT[v.key] || "#3fd68a"}">
 <span class="tr-ambient" aria-hidden="true"></span>
 <div class="tr-stack-head">
 <span class="tr-stack-dot" aria-hidden="true"></span>
 <h3 class="tr-stack-title">${c.esc(v.label)}</h3>
 ${needsYears ? `<span class="tr-stack-tag">needs 2+ years</span>` : ""}
 </div>
 <div class="tr-view-desc">${c.esc(v.describe || "")}</div>
 ${note}
 <div class="tr-chart-host" id="trHost_${v.key}"></div>
 </div>`;
 }).join("");

 r.innerHTML = `
 ${filterBar()}
 ${statBand(d)}
 ${freshnessLine(d)}
 <div id="rpHost" class="rp-host"></div>
 <div id="anHost" class="an-host"></div>
 <div class="tr-advanced">
 <button id="trAdvToggle" class="tr-adv-btn" type="button" aria-expanded="false">
 <span class="tr-adv-left">
 <span class="tr-adv-ic" aria-hidden="true">✦</span>
 <span class="tr-adv-txt">
 <span class="tr-adv-t">Advanced visualizations</span>
 <span class="tr-adv-hint">experimental ways to see your production, spirals, ridgelines, heat fields &amp; more</span>
 </span>
 </span>
 <span class="tr-adv-chev" aria-hidden="true">▸</span>
 </button>
 <div id="trAdvPanel" class="tr-adv-panel" hidden>${blocks}</div>
 </div>
 ${yearMatrix(d.by_array, d.years)}
 ${byArrayTable(d.by_array)}
 `;

 wireFilter(d);

 // animate the stat numbers up
 r.querySelectorAll(".tr-v[data-target]").forEach(countUp);

 // wire the CSV export
 const ex = document.getElementById("trExport");
 if (ex) ex.addEventListener("click", () => exportCsv(d));
 // Master data pack — zip of one mega-spreadsheet per array (bills + daily + YoY)
 const mp = document.getElementById("trMasterPack");
 if (mp) mp.addEventListener("click", () => downloadMasterPackZip(mp));
 r.querySelectorAll("[data-pack-id]").forEach(btn => {
  btn.addEventListener("click", () => {
   downloadArrayMasterPack(btn.getAttribute("data-pack-id"),
    btn.getAttribute("data-pack-name"), btn);
  });
 });

 // Professional REPORT, the headline of the tab: daily-output bar, YoY-growth
 // (graph #2), this-year-vs-last-year line, every one with LABELED AXES.
 const rpHost = document.getElementById("rpHost");
 if (rpHost && window.AOReport) {
 try {
 const stop = window.AOReport.mount(rpHost, d, c);
 if (stop) _activeStops.push(stop);
 } catch (e) {
 rpHost.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">Report charts hit an error.</div></div>`;
 if (window.console) console.error("report surface failed", e);
 }
 }

 // Production Analytics interactive explorer (preserved concurrent-thread work).
 const anHost = document.getElementById("anHost");
 if (anHost && window.AOAnalytics) {
 try {
 const stop = window.AOAnalytics.mount(anHost, d, c);
 if (stop) _activeStops.push(stop);
 } catch (e) {
 anHost.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">Analytics hit an error.</div></div>`;
 if (window.console) console.error("analytics surface failed", e);
 }
 }

 // Advanced (experimental) visualizations live behind a toggle now, mounted
 // LAZILY the first time it's expanded so their animation loops never run hidden.
 wireAdvanced(views);
 }

 // Reveal + lazily mount the experimental art views on first expand.
 function wireAdvanced(views) {
 const btn = document.getElementById("trAdvToggle");
 const panel = document.getElementById("trAdvPanel");
 if (!btn || !panel) return;
 let mounted = false;
 btn.addEventListener("click", () => {
 const opening = panel.hasAttribute("hidden");
 if (opening) {
 panel.removeAttribute("hidden");
 btn.setAttribute("aria-expanded", "true");
 btn.classList.add("open");
 if (!mounted) {
 mounted = true;
 for (const v of views) {
 const host = document.getElementById("trHost_" + v.key);
 if (!host) continue;
 host.style.position = "relative";
 try {
 const stop = v.mount(host, _prepped, C());
 if (stop) _activeStops.push(stop);
 } catch (e) {
 host.innerHTML = `<div class="tr-empty"><div class="tr-empty-p">This view hit an error.</div></div>`;
 if (window.console) console.error("trends view " + v.key + " failed", e);
 }
 }
 }
 // bring the freshly-revealed panel into view
 try { panel.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "nearest" }); } catch (e) {}
 } else {
 panel.setAttribute("hidden", "");
 btn.setAttribute("aria-expanded", "false");
 btn.classList.remove("open");
 }
 });
 }

 // Wire the array-filter dropdown: on change, re-fetch scoped to that array.
 function wireFilter(d) {
 const sel = document.getElementById("trArraySel");
 if (!sel) return;
 sel.addEventListener("change", () => {
 const v = sel.value;
 load(v === "" ? null : v);
 });
 }

 function load(arrayId) {
 const s = session();
 if (!s) { empty("Sign in to see your fleet's multi-year production trends."); return; }
 if (!window.AOTrends || !C().listViews().length) {
 return void setTimeout(() => load(arrayId), 60); // core/views not ready yet
 }
 if (arrayId !== undefined) _arrayId = arrayId; // explicit scope (incl. null = fleet)
 loading();
 const url = _arrayId != null ? `${API}?array_id=${encodeURIComponent(_arrayId)}` : API;
 fetch(url, { headers: { Authorization: "Bearer " + s } })
 .then(res => {
 if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.auth = true; throw e; }
 if (!res.ok) throw new Error("http " + res.status);
 return res.json();
 })
 .then(render)
 .catch(err => {
 if (err && err.auth) { empty("Your session expired, sign in again to see trends."); return; }
 teardown();
 const r = root();
 if (r) r.innerHTML = `<div class="tr-empty"><div class="tr-empty-ic">⚠️</div>
 <div class="tr-empty-h">Couldn't load trends</div>
 <div class="tr-empty-p">Something went wrong fetching your production history. <a href="#trends" onclick="window.__aoLoadTrends&&window.__aoLoadTrends();return false" style="color:var(--good)">Try again</a>.</div></div>`;
 });
 }

 window.__aoLoadTrends = load;

 // Theme switch (night⇄day) repaint is handled per-canvas: each chart helper
 // listens for the "ao-theme-change" event (dispatched by the toggle in index.html)
 // and redraws in place with the new palette. That's lighter + more robust than a
 // full re-render here (no refetch, no DOM rebuild, scroll + state preserved).
})();
