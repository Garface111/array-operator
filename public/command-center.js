/* ============================================================================
 * Array Operator, Portfolio Command Center (command-center.js)
 *
 * The fleet-scale front door. For an owner running 100+ arrays / ~1,200
 * inverters, the per-site fleet tree (sandbox.js) doesn't scale, you can't
 * hand-scan 1,200 cards. This view answers the only questions that matter at
 * that scale, up front:
 *
 * • how many inverters are flagged right now, and
 * • how many dollars are leaking this month, across the WHOLE portfolio,
 * • sorted worst-first, each row carrying the verdict AND the action.
 *
 * Data: when signed in, the SAME /v1/array-owners/fleet-tree the sandbox reads.
 * Anonymous (marketing/preview), a deterministic 100-array simulated fleet so
 * the scale story is real. The fleet tree below becomes a per-site drill-down.
 * ==========================================================================*/
(function(){
 "use strict";

 // ---- value model: mirrors app.js (transparent estimate) ----
 // Rate comes from FleetStore.energyRate(), the owner's REAL billed $/kWh when
 // signed in (backend default_net_rate_per_kwh), so "$ at risk" matches invoices
 // instead of overstating ~14% with the old hardcoded $0.21. Falls back to 0.21
 // for the demo/anon fleet (and before the rate fetch returns).
 const FS = () => (window.FleetStore || null);
 const ENERGY_RATE_FALLBACK = 0.21; // $/kWh blended offset (demo/anon)
 const energyRate = () => { const s = FS(); return s && s.energyRate ? s.energyRate() : ENERGY_RATE_FALLBACK; };
 const REC_PER_MWH = (FS() && FS().REC_PER_MWH) || 38; // $/MWh REC value
 // The window every window_kwh-derived figure (CF, recoverable-$, days-down, the
 // emailed "Est. lost value") is normalized over. window_kwh is a SUM the backend
 // accumulates across peer_analysis.WINDOW_DAYS (=14) days, see array_owners.py
 // (window_start = today - timedelta(days=peer_analysis.WINDOW_DAYS)) and the
 // fleet payload summary.window_days (=14). The divisor MUST equal that span or
 // every derived figure inflates by span/divisor. Sourced from the shared
 // FleetStore constant so it can never drift from the simulator / sandbox / alarms.
 const WINDOW_DAYS = (FS() && FS().WINDOW_DAYS) || 14;

 // (The weather-adjusted modeled-production target lives on the Analysis tab's
 // forecast card, analysis-forecast.js, which does it properly against real
 // Open-Meteo irradiance. The old crude nameplate×CF estimate that used to live
 // here fed only a MODEL.production object nothing rendered, so it was removed.)
 const val = kwh => kwh*energyRate() + (kwh/1000)*REC_PER_MWH;
 const usd0 = n => "$"+Math.round(Number(n)||0).toLocaleString();
 const num = n => Number(n||0).toLocaleString();

 const SESSION_KEY = "so_session";
 const STATE_KEY = "cc_triage_state"; // {key: "progress"|"snoozed"}, local workflow memory
 const getSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } };
 const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));

 const STATUS_LABEL = {
 dead:"Stopped earning", fault:"Hardware fault",
 underperforming:"Below its neighbors", comm_gap:"Gone quiet", ok:"Pulling its weight",
 live_dark:"Not producing now", live_low:"Low vs peers now", monitoring:"Monitoring"
 };
 const SEV = { // status → triage severity bucket
 dead:"crit", fault:"crit", underperforming:"under", comm_gap:"quiet", ok:"ok",
 live_dark:"quiet", // live anomaly: real but unpriced, like a comms gap, watch bucket
 live_low:"quiet", // live peer-level gap: real but unpriced yet, watch bucket
 monitoring:"ok" // not enough evidence yet, not a flagged row
 };
 const SEV_RANK = { crit:0, under:1, quiet:2, ok:3 };
 const ACTION = {
 dead:"Draft warranty claim", fault:"Draft service request",
 underperforming:"See the diagnosis", comm_gap:"Bring it back online",
 live_dark:"Check why it stopped", live_low:"Check why it's low"
 };

 // Each vendor's monitoring portal - every flagged inverter deep-links out so the
 // operator can jump straight to the vendor's own site to investigate it.
 const VENDOR_PORTAL = {
 solaredge:"https://monitoring.solaredge.com/", fronius:"https://www.solarweb.com/",
 sma:"https://ennexos.sunnyportal.com/", chint:"https://monitor.chintpowersystems.com/",
 enphase:"https://enlighten.enphaseenergy.com/", locus:"https://app.locusenergy.com/",
 };
 const VENDOR_NAME = { solaredge:"SolarEdge", fronius:"Fronius", sma:"SMA", chint:"Chint",
 enphase:"Enphase", locus:"Locus", solis:"Solis", tigo:"Tigo", alsoenergy:"AlsoEnergy" };
 const vendorLabel = v => VENDOR_NAME[v] || (v ? v.charAt(0).toUpperCase()+v.slice(1) : "portal");
 function vendorLinkHTML(r){
 const v = (r.vendor||"").toLowerCase();
 const url = VENDOR_PORTAL[v];
 if(!url) return "";
 const lbl = vendorLabel(v);
 // Demo fleet is cloud-capture mode, no "Open portal to sync" CTAs.
 try {
 if(window.FleetStore && FleetStore.isSimulated && FleetStore.isSimulated()){
 return `<span class="cc-vendor-link ${esc(v)}" title="Cloud capture keeps this feed fresh in the demo">${esc(lbl)} · auto-refresh</span>`;
 }
 } catch(_){}
 return `<a class="cc-vendor-link ${esc(v)}" href="${esc(url)}" target="_blank" rel="noopener" title="Open the ${esc(lbl)} monitoring portal in a new tab">Open in ${esc(lbl)} ↗</a>`;
 }
 // Sibling to the vendor-portal link (Ford 2026-07-17): jump straight to THIS
 // inverter in OUR Inverters spreadsheet — expanded + scrolled + flashed — not
 // only the manufacturer's portal. vendor-sheet.js owns that DOM (focusInverter).
 function inverterViewLinkHTML(r){
 if(r.invId == null) return "";
 return `<button type="button" class="cc-vendor-link cc-inv-link" data-do="openinv" data-key="${esc(r.key)}" title="Open this inverter in the Inverters spreadsheet">Open in Inverters ↗</button>`;
 }
 // The vendor portal as a drawer toolbar button (mirrors the row's inline link).
 function vendorPortalBtnHTML(r){
 const v = (r.vendor||"").toLowerCase();
 const url = VENDOR_PORTAL[v];
 if(!url) return "";
 try { if(window.FleetStore && FleetStore.isSimulated && FleetStore.isSimulated()) return ""; } catch(_){}
 return `<a class="cc-act" href="${esc(url)}" target="_blank" rel="noopener">↗ Open in ${esc(vendorLabel(v))}</a>`;
 }
 // The single most useful action for a row, as a real button (was a dead label):
 // a money action for a stopped/faulted unit (draft the claim), otherwise hand it
 // to the Energy Agent to diagnose — the AI path Ford built for exactly this.
 function primaryActionBtnHTML(r){
 const isClaim = r.status==="dead" || r.status==="fault";
 if(isClaim){
 const lbl = r.status==="fault" ? "Draft service request" : "Draft warranty claim";
 return `<button type="button" class="cc-actbtn claim" data-do="claim" data-key="${esc(r.key)}">✉️ ${lbl}</button>`;
 }
 return `<button type="button" class="cc-actbtn ea" data-do="ea" data-key="${esc(r.key)}">🤖 Ask Energy Agent</button>`;
 }

 // Build a grounded, one-paragraph repair prompt for the Energy Agent from a
 // flagged row — everything the agent needs to speak to THIS unit without a tool
 // round-trip (it can still verify/expand via its fleet tools).
 function eaRepairPrompt(r){
 const p = [];
 p.push(`I need help with a flagged inverter on my "${r.site}" array${r.region&&r.region!=="—"?` (${r.region})`:""}.`);
 const spec = [vendorLabel(r.vendor), r.model].filter(Boolean).join(" ");
 p.push(`Inverter: ${r.inv}${spec?` — ${spec}`:""}${r.nameplate?`, ${r.nameplate} kW`:""}.`);
 p.push(`Our monitoring flags it as "${STATUS_LABEL[r.status]||r.status}".`);
 if(r.pi!=null) p.push(`Peer index ${r.pi.toFixed(2)} (~${Math.round((1-r.pi)*100)}% below its array neighbors over ${WINDOW_DAYS} days under the same sky).`);
 if(r.lossMo>=1) p.push(`About ${usd0(r.lossMo)}/mo at risk${r.lostKwh>=1?`, ~${Math.round(r.lostKwh)} kWh lost in ${WINDOW_DAYS} days`:""}.`);
 if(r.stale!=null) p.push(`No telemetry for about ${r.stale}h.`);
 p.push(`What's the most likely cause and what should I do next? If a warranty claim or service request is warranted, draft it. Keep it specific to this inverter.`);
 return p.join(" ");
 }
 // Open the Energy Agent dock and send the grounded repair turn. Falls back to
 // staging (composer only) then a bare open if the agent build is older.
 function askEnergyAgent(r){
 if(!r) return;
 const prompt = eaRepairPrompt(r);
 try {
 if(typeof window.__eaSendText === "function"){ window.__eaSendText(prompt, { source:"fleet-triage" }); return; }
 if(typeof window.__eaStagePrompt === "function"){ window.__eaStagePrompt(prompt); return; }
 if(typeof window.__eaOpen === "function"){ window.__eaOpen(); return; }
 } catch(_){}
 toast("Energy Agent isn't available on this page.");
 }
 // Deep-link into the Inverters tab, expanded + scrolled to this exact unit.
 function openInInverters(r){
 if(!r) return;
 try {
 if(window.VendorSheet && typeof window.VendorSheet.focusInverter === "function"){
 window.VendorSheet.focusInverter(r.arrayId, r.invId); return;
 }
 } catch(_){}
 try { location.hash = "#arrays"; } catch(_){}
 try { if(FleetStore.setFocus) FleetStore.setFocus([r.arrayId]); } catch(_){}
 }

 /* ===========================================================================
 * 1. DATA, normalize to a flat list of flagged inverters w/ $ at stake.
 * ==========================================================================*/

 // per-inverter lost-kWh estimate over the window (same logic family as app.js)
 function lostKwh(inv, fleetWindowKwh, totalNameplate){
 const fair = (inv.nameplate_kw||0)/totalNameplate*fleetWindowKwh;
 if(inv.status==="dead"||inv.status==="fault") return Math.max(0, fair-(inv.window_kwh||0));
 if(inv.status==="underperforming" && inv.peer_index) return Math.max(0, fair/Math.max(inv.peer_index,0.01)-(inv.window_kwh||0));
 if(inv.status==="comm_gap") return 0; // unknown until it reports, no $ claimed
 return 0;
 }

 // flatten → {rows:[…flagged…], kpis:{…}}
 function buildModel(fleet){
 const rows=[]; let invTotal=0, invHealthy=0, gradeable=0;
 fleet.arrays.forEach(a => {
 const totalNp = a.inverters.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;
 const fleetWin = a.inverters.reduce((t,i)=>t+(i.window_kwh||0),0);
 a.inverters.forEach(inv => {
 invTotal++;
 // Resolve the inverter's EFFECTIVE flagged-status. inv.status is the rolling
 // peer verdict; a fresh live anomaly (dark now, OR low vs peers, while >=2
 // daylight peers produce) isn't caught by it yet, so we promote a status:"ok"
 // inverter to a "live_dark"/"live_low" row. Shared FleetStore classifier →
 // same logic as the tree + grid, so the three surfaces never disagree.
 // NO ENERGY REGISTER (e.g. Tannery #7): live power but a dead cumulative-
 // energy meter, so it can't be peer-graded and its per-inverter power is an
 // unreliable energy-share split. It's a metering DEFECT at the vendor, not a
 // fleet-health fault, treat it like "monitoring": neutral, never a flagged
 // row, and out of BOTH sides of healthyPct so it can't fake a red OR green
 // verdict. (The digest already surfaces it as a metering nudge.)
 if(inv.no_energy_register){ return; }
 let status = inv.status;
 if(status === "ok" && window.FleetStore && FleetStore.liveVerdict){
 const _lv = FleetStore.liveVerdict(inv, a.inverters, a.is_daylight);
 if(_lv === "dark") status = "live_dark";
 else if(_lv === "low") status = "live_low";
 }
 if(status === "ok"){ invHealthy++; gradeable++; return; }
 // "monitoring" = not enough history to judge yet, neutral, never a flagged
 // row AND never graded. Excluded from BOTH sides of healthyPct (judge % over
 // gradeable units only) so a brand-new fleet where every unit is "Gathering
 // data" doesn't read a false "100% healthy" green tank. Skip the table too.
 if(status === "monitoring"){ return; }
 // Everything past here is a real, gradeable verdict that failed, count it
 // toward the denominator (but not the healthy numerator).
 gradeable++;
 // live_dark/live_low carry no priced loss yet (unconfirmed, like comm_gap) —
 // dollars are claimed once the peer-window health confirms it dead/underperforming.
 const lk = (status === "live_dark" || status === "live_low") ? 0 : lostKwh(inv, fleetWin, totalNp);
 const lossMo = val(lk)/WINDOW_DAYS*30;
 rows.push({
 key:`${a.id}|${inv.name}`, arrayId:a.id, invId:(inv.id!=null?inv.id:inv.inverter_id), site:a.name, region:a.region, host:a.host, vendor:a.vendor,
 inv:inv.name, model:inv.model, nameplate:inv.nameplate_kw, status,
 sev:SEV[status], pi:inv.peer_index, stale:inv.stale_hours,
 lossMo, lossYr:lossMo*12, lostKwh:lk, windowKwh:inv.window_kwh,
 live: status === "live_dark" || status === "live_low",
 });
 });
 });
 const flagged = rows.length;
 const riskMo = rows.reduce((t,r)=>t+r.lossMo,0);
 return {
 rows, recovered:fleet.recovered_ytd||0, simulated:fleet.simulated,
 kpis:{
 sites:fleet.arrays.length, inverters:invTotal,
 // Health % is judged over GRADEABLE units only (those with a real verdict).
 // "monitoring" (no history yet) units are excluded from both sides, so a
 // fleet with nothing yet gradeable reports null (→ handled as "gathering
 // data" by the tile), never a misleading 100% green.
 gradeable,
 healthyPct: gradeable ? Math.round(invHealthy/gradeable*100) : null,
 flagged, riskMo, crit: rows.filter(r=>r.sev==="crit").length
 }
 };
 }

 /* ===========================================================================
 * 2. STATE (filters / sort / selection / workflow)
 * ==========================================================================*/
 let MODEL=null;
 const UI = { q:"", sev:"all", region:"all", sort:"loss", dir:-1, expanded:null, selected:new Set() };
 // triage workflow state is shared via FleetStore so the rest of the app sees it
 const wfState = key => FleetStore.triageState(key);

 function filteredRows(){
 const q = UI.q.trim().toLowerCase();
 let rows = MODEL.rows.filter(r => {
 if(UI.sev!=="all" && r.sev!==UI.sev) return false;
 if(UI.region!=="all" && r.region!==UI.region) return false;
 if(q && !(r.site.toLowerCase().includes(q) || r.inv.toLowerCase().includes(q) || (r.host||"").toLowerCase().includes(q))) return false;
 return true;
 });
 const dir = UI.dir;
 rows.sort((a,b)=>{
 let d=0;
 if(UI.sort==="loss") d = a.lossMo-b.lossMo;
 else if(UI.sort==="sev") d = SEV_RANK[a.sev]-SEV_RANK[b.sev] || a.lossMo-b.lossMo;
 else if(UI.sort==="site") d = a.site.localeCompare(b.site);
 else if(UI.sort==="pi") d = (a.pi==null?-1:a.pi)-(b.pi==null?-1:b.pi);
 return d*dir;
 });
 return rows;
 }

 /* ===========================================================================
 * 3. RENDER
 * ==========================================================================*/
 function host(){ return document.getElementById("fleetCommander"); }

 // The money tile keeps the old right-cluster honesty states: a priced $/mo
 // when the model has real losses, flagged-but-unpriced live anomalies as an
 // amber "to check", and a clean fleet as a quiet $0 all-clear. Shared by the
 // full render() and the in-place live repaint (paintKpis).
 function riskTileHTML(k, riskMo){
 return riskMo >= 1
 ? `<div class="fcg-k">Recoverable</div>
 <div class="fcg-v"><b data-kpi="risk">${usd0(riskMo)}</b><span class="fcg-u">/mo</span></div>
 <div class="fcg-s">by fixing the flagged inverters</div>`
 : k.flagged
 ? `<div class="fcg-k">To check</div>
 <div class="fcg-v" data-kpi="watch"><b>${num(k.flagged)}</b></div>
 <div class="fcg-s">Live anomalies · no priced loss yet</div>`
 : `<div class="fcg-k">Recoverable</div>
 <div class="fcg-v"><b data-kpi="risk">$0</b><span class="fcg-u">/mo</span></div>
 <div class="fcg-s">No issues detected 🌞</div>`;
 }

 function render(){
 const h = host(); if(!h || !MODEL) return;
 const q = document.getElementById("ccQueue");
 const k = MODEL.kpis;
 // Fleet-health color (Ford, 2026-06-23): blue = good, all the way down to 80%;
 // at 80% and below it turns orange. Two states only, no red tier. When nothing
 // is gradeable yet (every unit still "monitoring"), health is UNKNOWN, not 100%
 //, a neutral "gathering data" tile, never a false green all-clear.
 const gathering = k.healthyPct == null;
 const healthCls = gathering ? "neutral" : (k.healthyPct > 80 ? "ok" : "warn");
 const riskMo = Math.round(MODEL.kpis.riskMo || 0);
 const simNote = MODEL.simulated
 ? `Demo fleet · sign in for your data`
 : `Live from your connected arrays`;

 // KPI TILE GRID, the old single hero bar broken out (Ford, 2026-07-01):
 // every fleet KPI in its own uniform tile, 4×2 on desktop / 2-up on phones.
 // Reading order: health → scale (arrays, inverters) → triage (flagged,
 // critical, watch) → money, with live monitoring status in the last tile.
 const invHealthy = Math.max(0, k.inverters - k.flagged);
 const watchN = Math.max(0, k.flagged - k.crit);
 h.innerHTML = `
 <div class="fcg" role="list" aria-label="Fleet health KPIs">
 <div class="fcg-tile fcg-tile--health ${healthCls}" role="listitem">
 <div class="fcg-k">Fleet healthy</div>
 <div class="fcg-v"><b data-kpi="healthy">${gathering ? "—" : k.healthyPct}</b>${gathering ? "" : `<span class="fcg-u">%</span>`}</div>
 <div class="fcg-s">${gathering ? "Collecting history" : `${num(invHealthy)} of ${num(k.inverters)} inverters`}</div>
 <div class="fcg-meter" aria-hidden="true"><span class="fcg-fill fcg-fill--${healthCls}" data-kpi="healthmeter" style="width:${gathering ? 0 : k.healthyPct}%"></span></div>
 </div>
 <div class="fcg-tile" role="listitem">
 <div class="fcg-k">Arrays</div>
 <div class="fcg-v"><b data-kpi="sites">${num(k.sites)}</b></div>
 <div class="fcg-s" title="Every array on file, including utility-meter-only ones with no live telemetry. The Vendor Data spreadsheet's 'monitored arrays' count is a narrower subset, those with a live vendor connection.">arrays on file</div>
 </div>
 <div class="fcg-tile" role="listitem">
 <div class="fcg-k">Inverters</div>
 <div class="fcg-v"><b data-kpi="inverters">${num(k.inverters)}</b></div>
 <div class="fcg-s">across ${num(k.sites)} array${k.sites===1?"":"s"}</div>
 </div>
 <div class="fcg-tile${k.flagged?" t-warn":""}" role="listitem">
 <div class="fcg-k">Flagged</div>
 <div class="fcg-v"><b data-kpi="flagged">${num(k.flagged)}</b></div>
 <div class="fcg-s">${k.flagged ? "need attention below" : "none right now"}</div>
 </div>
 <div class="fcg-tile${k.crit?" t-bad":""}" role="listitem">
 <div class="fcg-k">Critical</div>
 <div class="fcg-v"><b data-kpi="crit">${num(k.crit)}</b></div>
 <div class="fcg-s">${k.crit ? "stopped earning or faulted" : "no outages or faults"}</div>
 </div>
 <div class="fcg-tile${watchN?" t-warn":""}" role="listitem">
 <div class="fcg-k">Watch</div>
 <div class="fcg-v"><b data-kpi="watchcount">${num(watchN)}</b></div>
 <div class="fcg-s">${watchN ? "underperforming or gone quiet" : "nothing on watch"}</div>
 </div>
 <div class="fcg-tile fcg-tile--risk${riskMo>=1?"":k.flagged?" t-warn":""}" role="listitem">${riskTileHTML(k, riskMo)}</div>
 <div class="fcg-tile fcg-tile--alerts" role="listitem">
 <div class="fcg-k">Monitoring</div>
 <button class="fc-alerts-btn" id="fcAlerts" type="button" title="Email me when an inverter goes down or underperforms">🔔 Alerts</button>
 <div class="fc-asof fcg-s" id="ccAsof">${asofText()}</div>
 </div>
 </div>
 ${MODEL.simulated ? `<div class="fc-note">${esc(simNote)}</div>` : ``}`;

 // Wire the relocated Alerts button (moved here from the sandbox head). The
 // settings modal lives in sandbox.js and is exposed as window.__sbOpenAlerts.
 const alertsBtn = document.getElementById("fcAlerts");
 if(alertsBtn) alertsBtn.onclick = () => {
 if(typeof window.__sbOpenAlerts === "function") window.__sbOpenAlerts();
 };

 // Always keep the attention queue painted — even when Fleet Triage is not the
 // active tab. Emptying #ccQueue while inactive made the tab-slide measure a
 // short shell height, then __ccRender filled the table mid-slide and the panel
 // "grew to full length" (Ford 2026-07-17: Inverters → Fleet Triage). The panel
 // is display:none when off-tab so keeping the DOM costs nothing visible.
 renderProdKpis();
 // The weather-adjusted "Production vs expected" card moved to the Analysis tab
 // (analysis-forecast.js), Fleet Health now leads with the Needs-attention queue.
 // Relabel the attention header so a clean fleet doesn't sit under a "Needs
 // attention" heading over an empty list, read it as the all-clear it is.
 const attnH = document.getElementById("dashAttnH");
 if(attnH){
 const loaded = !(window.FleetStore && FleetStore.isLoaded && !FleetStore.isLoaded());
 attnH.textContent = !loaded ? "Needs attention"
 : (k.flagged ? "Needs attention" : "No items need attention 🌞");
 attnH.classList.toggle("all-clear", loaded && !k.flagged);
 }
 if(!q) return;
 renderQueueLEGACY();
 }

 // Active only when the owner is on the Dashboard tab.
 function _dashActive(){
 const p = document.getElementById("panelDashboard");
 return !!(p && p.classList.contains("active"));
 }

 // Live production strip on the Dashboard: fleet kW now · kWh today · arrays producing.
 // Reads the SAME FleetStore.toColumns() the spreadsheet uses, so the numbers agree.
 function kwFmt(w){
 const k = (Number(w)||0)/1000;
 return (k >= 10 ? Math.round(k) : Math.round(k*10)/10) + " kW";
 }
 // Is this array's reading frozen (feed paused, e.g. a lapsed portal session)?
 // Prefer the spreadsheet's canonical isStale so the two surfaces never disagree;
 // fall back to a self-contained check (vendor live-window vs source age) if the
 // vendor-sheet module hasn't loaded. A stale array's current_power_w is a frozen
 // number, not live output, it must not inflate the headline "kW now".
 const _CADENCE_MIN = { chint: 4, fronius: 6, sma: 6 };
 // Vendors that report ONE site-level power split across inverters, their kW is an
 // estimate, mirrored from vendor-sheet's isAllocatedPower (data-honesty audit #5).
 const _ALLOC_VENDOR = { fronius: 1, sma: 1, chint: 1 };
 function _isStale(c){
 if(window.VendorSheet && typeof window.VendorSheet.isStale === "function"){
 try { return window.VendorSheet.isStale(c); } catch(_){}
 }
 const h = (c.source_status || {}).age_hours;
 if(h == null) return false;
 const cad = _CADENCE_MIN[(c.vendor || "").toLowerCase()];
 const liveWindowMin = cad ? cad * 2 : 360;
 return h * 60 >= liveWindowMin;
 }
 function renderProdKpis(){
 const el = document.getElementById("dashProd");
 if(!el || !window.FleetStore || !FleetStore.toColumns) return;
 // Before the fleet tree lands, show a shimmer skeleton that mirrors the final
 // 3-segment layout (kW now · kWh today · arrays producing) instead of a blank
 // strip or a bare text line, so the loading state previews the shape that's
 // coming and the numbers don't jump the layout when they arrive. (The
 // FleetStore subscribe re-runs render() once data lands, replacing this.)
 if(FleetStore.isLoaded && !FleetStore.isLoaded()){
 el.innerHTML =
 `<span class="dp dp-skel" aria-hidden="true"><span class="dp-skel-bar w-kw"></span></span>` +
 `<span class="dp-dot">·</span>` +
 `<span class="dp dp-skel" aria-hidden="true"><span class="dp-skel-bar w-kwh"></span></span>` +
 `<span class="dp-dot">·</span>` +
 `<span class="dp dp-skel" aria-hidden="true"><span class="dp-skel-bar w-arr"></span></span>` +
 `<span class="dp-sr">Loading your fleet…</span>`;
 return;
 }
 let cols = [];
 try { cols = (FleetStore.toColumns().columns) || []; } catch(_){ return; }
 let kw = 0, kwh = 0, producing = 0, stale = 0, asleep = 0, allocKw = 0, estKwh = 0;
 cols.forEach(c => {
 // A frozen feed's reading isn't live power, exclude it from "kW now" and the
 // producing count so the headline matches the dimmed/stale rows in the sheet.
 // (kWh-today still accrues from the last real cumulative reading, so we keep
 // it, only the instantaneous "now" power is the one that goes false-live.)
 const frozen = _isStale(c);
 // Overnight the vendor's source clock is frozen for the WHOLE fleet, so a bare
 // age check would read every array as "paused", alarming, and wrong. When the
 // server says it's sun-down (is_daylight === false) a frozen feed is just
 // ASLEEP, matching the sandbox card's calm "Sleeping" state. Only a feed frozen
 // in DAYLIGHT is a genuine "paused" (a lapsed portal session / real dropout).
 if(frozen){ if(c.is_daylight === false) asleep++; else stale++; }
 // Array live power: prefer the array-level value (real backend), else sum the
 // array's inverters (the demo fleet only carries per-inverter watts).
 let p = c.current_power_w;
 if(p == null) p = (c.inverters || []).reduce((t,i)=>t+(i.current_power_w||0),0);
 // Clamp to >=0 before it enters the headline. SolarEdge reports a SIGNED
 // totalActivePower that can go negative at dawn/dusk or during a fault
 // (inverter drawing, not producing); an unclamped negative would silently
 // subtract real output from another array's contribution to "kW now". Mirror
 // the clamps used elsewhere (fair-share/lostKwh all Math.max(0,…)).
 p = Math.max(0, p || 0);
 if(!frozen){
 kw += p;
 if(p > 0) producing++;
 // Fronius/SMA/Chint expose ONE site-level power the backend splits across
 // inverters, so any kW they contribute to this headline is an estimate, not a
 // measured reading. Track how much of "kW now" came from those vendors so we
 // can mark the total with "~" when it's estimate-tainted.
 if(p > 0 && _ALLOC_VENDOR[(c.vendor || "").toLowerCase()]) allocKw += p;
 }
 if(c.produced_today_kwh != null){
 kwh += c.produced_today_kwh;
 // Track kWh whose source is an ESTIMATE (bill_prorate, a utility bill smeared
 // flat across the month), so the fleet "kWh today" total can be marked
 // when it's estimate-tainted instead of reading as fully metered production.
 if(c.produced_today_is_estimated || c.produced_today_source === "bill_prorate") estKwh += c.produced_today_kwh;
 }
 });
 // The sum is estimate-tainted when an allocated vendor contributes a meaningful
 // slice of it (>1%); a trivial rounding sliver shouldn't slap "~" on a real total.
 const kwEstimated = kw > 0 && allocKw > 0.01 * kw;
 // "kWh today" is estimate-tainted when a meaningful slice (>1%) was prorated from a
 // utility bill rather than measured, mark it with "~" + a tip, same honesty rule.
 const kwhEstimated = kwh > 0 && estKwh > 0.01 * kwh;
 el.innerHTML =
 `<span class="dp"${kwEstimated ? ` title="Some arrays (Fronius, SMA, Chint) report one site-level power we split across inverters, so this fleet 'kW now' total includes estimates, not purely measured readings."` : ``}><b>${kwEstimated ? "~" : ""}${esc(kwFmt(kw))}</b> now</span><span class="dp-dot">·</span>` +
 `<span class="dp"${kwhEstimated ? ` title="Some of today's kWh is estimated from a utility bill (spread evenly across the month), not a measured reading."` : ``}><b>${kwhEstimated ? "~" : ""}${Math.round(kwh).toLocaleString()}</b> kWh today</span><span class="dp-dot">·</span>` +
 `<span class="dp"><b>${producing}</b>/${cols.length} arrays producing</span>` +
 (stale ? `<span class="dp-dot">·</span><span class="dp dp-stale" title="${stale} feed${stale===1?"":"s"} paused, last reading is frozen in daylight, so it's left out of 'kW now'">${stale} feed${stale===1?"":"s"} paused</span>` : ``) +
 (asleep ? `<span class="dp-dot">·</span><span class="dp dp-asleep" title="${asleep} array${asleep===1?"":"s"} asleep, the sun is down at ${asleep===1?"its":"their"} site, so ${asleep===1?"it's":"they're"} resting, not down">${asleep} asleep 🌙</span>` : ``);
 }

 // The weather-aware "Production vs expected" card (loadForecast /
 // forecastHowHTML / renderProductionTarget) was RELOCATED to the Analysis tab
 // (public/analysis-forecast.js), Fleet Health now leads with the Needs-attention
 // queue. The Analysis orchestrator owns the forecast-fleet fetch + ctx.forecast.
 // legacy render kept for reference / other callers
 function renderQueueLEGACY(){
 const h = host(); if(!h || !MODEL) return;
 const q = document.getElementById("ccQueue");
 const k = MODEL.kpis;
 const regions = ["all", ...Array.from(new Set(MODEL.rows.map(r=>r.region))).filter(x=>x&&x!=="—").sort()];
 const simNote = MODEL.simulated
 ? `Simulated portfolio. Sign in to load your fleet.`
 : `Live from your connected arrays.`;
 if(!q) return;
 q.innerHTML = `
 <div class="cc-tools">
 <label class="cc-search"><input id="ccQ" type="text" placeholder="Search site, inverter, or host…" value="${esc(UI.q)}" autocomplete="off"></label>
 <div class="cc-chips" id="ccSev">
 ${chip("all","All",MODEL.rows.length,"")}
 ${chip("crit","Critical",MODEL.rows.filter(r=>r.sev==="crit").length,"crit")}
 ${chip("under","Underperforming",MODEL.rows.filter(r=>r.sev==="under").length,"under")}
 ${chip("quiet","Gone quiet",MODEL.rows.filter(r=>r.sev==="quiet").length,"quiet")}
 </div>
 ${regions.length>2 ? `<select class="cc-sel" id="ccRegion">${regions.map(rg=>`<option value="${esc(rg)}" ${UI.region===rg?"selected":""}>${rg==="all"?"All regions":esc(rg)}</option>`).join("")}</select>`:""}
 <div class="cc-spacer"></div>
 <div class="cc-bulk ${UI.selected.size?"show":""}" id="ccBulk">
 <span class="cnt"><b>${UI.selected.size}</b> selected</span>
 <button class="cc-btn primary" id="ccBulkClaim">Open ${UI.selected.size} warranty claim${UI.selected.size===1?"":"s"}</button>
 <button class="cc-btn ghost" id="ccBulkClear">Clear</button>
 </div>
 </div>

 <div class="cc-tablewrap">
 <table class="cc-table">
 <thead><tr>
 <th class="shrink"><input type="checkbox" class="cc-check" id="ccAll" title="Select all shown"></th>
 <th class="sortable" data-sort="site">Site${sortArrow("site")}</th>
 <th>Inverter</th>
 <th class="sortable" data-sort="sev">Verdict${sortArrow("sev")}</th>
 <th class="sortable num" data-sort="pi">vs peers${sortArrow("pi")}</th>
 <th class="sortable num" data-sort="loss">$ / mo${sortArrow("loss")}</th>
 <th>Recommended action</th>
 <th class="shrink">Status</th>
 </tr></thead>
 <tbody id="ccBody"></tbody>
 </table>
 </div>
 <div class="cc-foot">Showing flagged inverters only (${num(k.inverters-k.flagged)} healthy hidden). Peer-measured under the same sky. $ at ~$${energyRate().toFixed(2)}/kWh + ${REC_PER_MWH}/MWh RECs.</div>`;

 renderBody();
 wire();
 applyTriageState(); // keep the collapse pill's flagged-count fresh
 }

 function chip(id,label,n,dot){
 return `<button class="cc-chip ${UI.sev===id?"on":""}" data-sev="${id}">${dot?`<span class="d ${dot}"></span>`:""}${label} <span class="n">${n}</span></button>`;
 }
 function sortArrow(col){ return UI.sort===col ? `<span class="arrow">${UI.dir<0?"▾":"▴"}</span>` : ""; }

 function renderBody(){
 const body = document.getElementById("ccBody"); if(!body) return;
 const rows = filteredRows();
 if(!rows.length){ body.innerHTML = `<tr><td colspan="8" class="cc-empty">No matching inverters. 🌞</td></tr>`; return; }
 body.innerHTML = rows.map(r => {
 const piTxt = r.pi==null ? `<span class="cc-pi">—<small> no peers</small></span>`
 : `<span class="cc-pi">${r.pi.toFixed(2)}<small> · ${Math.round((1-r.pi)*100)}% low</small></span>`;
 const st = wfState(r.key);
 const sel = UI.selected.has(r.key);
 const main = `
 <tr class="row sev-${r.sev} ${sel?"sel":""}" data-key="${esc(r.key)}">
 <td class="shrink"><input type="checkbox" class="cc-check ccRow" data-key="${esc(r.key)}" ${sel?"checked":""}></td>
 <td><span class="cc-site">${esc(r.site)}</span><small>${esc(r.region)}${r.host?` · ${esc(r.host)}`:""}</small></td>
 <td class="cc-inv"><b>${esc(r.inv)}</b> · ${esc(r.model)}<span class="cc-inv-links">${vendorLinkHTML(r)}${inverterViewLinkHTML(r)}</span></td>
 <td><span class="cc-verdict ${r.sev}"><span class="cc-sevdot ${r.sev}"></span> ${STATUS_LABEL[r.status]}</span></td>
 <td class="num">${piTxt}</td>
 <td class="num">${r.lossMo>=1?`<span class="cc-loss">${usd0(r.lossMo)}</span>`:`<span style="color:var(--faint)">—</span>`}</td>
 <td class="cc-actcell">${primaryActionBtnHTML(r)}</td>
 <td class="shrink"><span class="cc-state ${st}">${st==="progress"?"In progress":st==="snoozed"?"Snoozed":"New"}</span></td>
 </tr>`;
 const drawer = UI.expanded===r.key ? drawerHTML(r) : "";
 return main + drawer;
 }).join("");
 wireBody();
 }

 function drawerHTML(r){
 const peers = "its array neighbors";
 const why = r.status==="comm_gap"
 ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> has gone quiet, no telemetry for <b>${r.stale!=null?r.stale+"h":"a while"}</b>. Its neighbors are still reporting, so this reads as a comms dropout, not a power fault. We can't bill lost output until it checks back in.`
 : r.status==="live_dark"
 ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is reading <b>zero output right now</b> while its array neighbors are actively producing under the same sky. This is a LIVE reading, the 10-day health hasn't flagged it yet, so it just stopped. Could be an early-stage fault, a tripped breaker, or a brief dropout; check before it becomes lost revenue.`
 : r.status==="live_low"
 ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is producing <b>well below its array neighbors right now</b>, more than 15% under the peer median for its nameplate, under the same sky. This is a LIVE reading the 10-day health hasn't flagged yet. Likely shading, a tripped string, or an early-stage fault; check before it becomes lost revenue.`
 : r.status==="dead"
 ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> has produced <b>zero</b> for ~${r.stale!=null?Math.round(r.stale/24):"a few"} days while ${peers} kept producing, that rules out weather. Warranty claim is ready with the fault dates and peer-measured lost-kWh evidence.`
 : r.status==="fault"
 ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is throwing a hardware fault and running at a fraction of ${peers}. Service request drafted with the evidence attached.`
 : `Over ${WINDOW_DAYS} days, <b>${esc(r.inv)}</b> made only <b>${r.pi!=null?Math.round(r.pi*100):"—"}%</b> of its fair share vs ${peers} under the same sky. That <b>${r.pi!=null?Math.round((1-r.pi)*100):"—"}% shortfall</b> is the unit, likely shading, soiling, or a tired string.`;
 const rec = r.status==="comm_gap"
 ? `Power-cycle the inverter's gateway / data logger and confirm it rejoins. No telemetry within a day → escalate to a site visit.`
 : r.status==="live_dark"
 ? `Confirm it's still dark (this is a live, possibly brief reading), then check the breaker/disconnect and the inverter's own fault log. If it stays at zero into tomorrow, the 10-day health will escalate it to a warranty-grade claim automatically.`
 : r.status==="live_low"
 ? `Check this inverter's strings for shading/soiling and confirm none have tripped, then review its fault log. If the gap vs its neighbors persists, the 10-day health will escalate it automatically.`
 : r.status==="underperforming"
 ? `Schedule a visual + IV-curve check on this inverter's strings. A failed module or cleaning is usually a fast-payback fix.`
 : `Send the drafted ${r.status==="fault"?"service request":"warranty claim"} to the manufacturer, evidence is attached and dated.`;
 const st = wfState(r.key);
 const isClaim = r.status==="dead" || r.status==="fault";
 return `
 <tr class="cc-drawer" data-key="${esc(r.key)}"><td colspan="8"><div class="inner">
 <div>
 <h4>Why it's flagged</h4>
 <p>${why}</p>
 <div class="cc-evidence">
 <div class="e"><div class="en">${r.pi!=null?r.pi.toFixed(2):"—"}</div><div class="ec">peer index</div></div>
 <div class="e"><div class="en">${r.lostKwh>=1?Math.round(r.lostKwh):"—"}</div><div class="ec">kWh lost / ${WINDOW_DAYS}d</div></div>
 <div class="e"><div class="en">${r.lossYr>=1?usd0(r.lossYr):"—"}</div><div class="ec">slipping / yr</div></div>
 </div>
 <div class="cc-rec"><span class="cc-rec-k">Recommended</span><span>${rec}</span></div>
 <div class="cc-actions">
 <button type="button" class="cc-act ea" data-do="ea" data-key="${esc(r.key)}">🤖 Repair with Energy Agent</button>
 ${r.invId!=null?`<button type="button" class="cc-act" data-do="openinv" data-key="${esc(r.key)}">🔍 Open in Inverters</button>`:""}
 ${vendorPortalBtnHTML(r)}
 ${isClaim?`<button type="button" class="cc-act" data-do="claim" data-key="${esc(r.key)}">✉️ ${r.status==="fault"?"Draft service request":"Draft warranty claim"}</button>`:""}
 <span class="cc-act-sp"></span>
 <button type="button" class="cc-act ghost${st==="progress"?" on":""}" data-do="progress" data-key="${esc(r.key)}">${st==="progress"?"In progress ✓":"Mark in progress"}</button>
 <button type="button" class="cc-act ghost${st==="snoozed"?" on":""}" data-do="snooze" data-key="${esc(r.key)}">${st==="snoozed"?"Snoozed ✓":"Snooze"}</button>
 </div>
 </div>
 </div></td></tr>`;
 }

 /* ===========================================================================
 * 4. WIRING
 * ==========================================================================*/
 // Re-render only the triage queue (#ccQueue), NOT the pinned commander card.
 // Filter/sort/selection changes affect only the table; rebuilding the whole
 // commander card (the big health tank + KPIs) on every chip/sort click is
 // wasteful and resets the card's CSS-animated meter. The commander card's
 // numbers don't depend on filter/sort state, so leave it untouched.
 function renderQueueOnly(){
 if(_dashActive()) renderQueueLEGACY();
 }

 function wire(){
 const q = document.getElementById("ccQ");
 if(q) q.oninput = () => { UI.q = q.value; renderBody(); };
 const sev = document.getElementById("ccSev");
 if(sev) sev.querySelectorAll(".cc-chip").forEach(c => c.onclick = () => { UI.sev=c.dataset.sev; UI.expanded=null; renderQueueOnly(); });
 const region = document.getElementById("ccRegion");
 if(region) region.onchange = () => { UI.region=region.value; UI.expanded=null; renderQueueOnly(); };
 document.querySelectorAll("#ccQueue th.sortable").forEach(th => th.onclick = () => {
 const col = th.dataset.sort;
 if(UI.sort===col) UI.dir*=-1; else { UI.sort=col; UI.dir = col==="site"?1:-1; }
 renderQueueOnly();
 });
 const all = document.getElementById("ccAll");
 if(all) all.onchange = () => {
 const rows = filteredRows();
 if(all.checked) rows.forEach(r=>UI.selected.add(r.key)); else rows.forEach(r=>UI.selected.delete(r.key));
 renderQueueOnly();
 };
 const bc = document.getElementById("ccBulkClaim"); if(bc) bc.onclick = bulkClaim;
 const bx = document.getElementById("ccBulkClear"); if(bx) bx.onclick = () => { UI.selected.clear(); renderQueueOnly(); };
 }

 function wireBody(){
 document.querySelectorAll("#ccBody tr.row").forEach(tr => {
 tr.onclick = e => {
 if(e.target.closest(".ccRow")) return; // checkbox handled separately
 const key = tr.dataset.key;
 UI.expanded = UI.expanded===key ? null : key;
 renderBody();
 };
 });
 document.querySelectorAll("#ccBody .ccRow").forEach(cb => cb.onclick = e => {
 e.stopPropagation();
 if(cb.checked) UI.selected.add(cb.dataset.key); else UI.selected.delete(cb.dataset.key);
 // refresh bulk bar + row highlight without collapsing the drawer, queue
 // only, so the commander card above doesn't flicker on a selection toggle
 renderQueueOnly();
 });
 document.querySelectorAll("#ccBody [data-do]").forEach(b => b.onclick = e => {
 e.stopPropagation();
 const key=b.dataset.key, act=b.dataset.do;
 const r = MODEL.rows.find(x=>x.key===key);
 // mutating shared state notifies the store → this view (and any other) re-renders
 if(act==="claim"){ openClaim(r); FleetStore.setTriage(key,"progress"); }
 else if(act==="ea" && r){ askEnergyAgent(r); FleetStore.setTriage(key,"progress"); }
 else if(act==="openinv" && r){ openInInverters(r); }
 else if(act==="progress"){ FleetStore.setTriage(key,"progress"); }
 else if(act==="snooze"){ FleetStore.setTriage(key,"snoozed"); }
 else if(act==="focus" && r){
 FleetStore.setFocus([r.arrayId]); // jump the fleet tree to this site
 const tree = document.getElementById("sbWrap");
 if(tree) tree.scrollIntoView({ behavior:"smooth", block:"start" });
 toast(`Fleet tree focused on ${r.site}.`);
 }
 });
 }

 function bulkClaim(){
 const keys=[...UI.selected];
 const claimable = keys.map(k=>MODEL.rows.find(r=>r.key===k)).filter(r=>r&&(r.status==="dead"||r.status==="fault"));
 toast(`${keys.length} item${keys.length===1?"":"s"} moved to In progress${claimable.length?` · opening ${claimable.length} claim${claimable.length===1?"":"s"}`:""}.`);
 if(claimable.length) openClaim(claimable[0]);
 UI.selected.clear();
 FleetStore.setTriageBatch(keys, "progress"); // one notify → re-render
 }

 // Known manufacturer support inboxes, guessing support@<slug>.com gets the wrong
 // address for several vendors (Fronius/SMA), and an unvalidated vendor string from the
 // backend could otherwise steer the draft to an attacker-chosen domain. Whitelist the
 // vendors we actually capture; anything else falls back to a sanitized slug guess.
 const VENDOR_SUPPORT = {
 solaredge: "support@solaredge.com",
 fronius: "pv-support-usa@fronius.com",
 sma: "service@sma-america.com",
 enphase: "support@enphase.com",
 chint: "service@chintpower.com",
 };
 function vendorSupportEmail(vendor){
 const key = (vendor||"").toLowerCase().replace(/[^a-z0-9]/g,"");
 if(VENDOR_SUPPORT[key]) return VENDOR_SUPPORT[key];
 return `support@${key||"installer"}.com`; // sanitized slug, no injectable chars survive
 }

 // lightweight mailto claim (self-contained; the per-site sandbox has the full editor)
 function openClaim(r){
 if(!r) return;
 const to = vendorSupportEmail(r.vendor);
 // An email Subject is a single header line: collapse any CR/LF/tabs from backend
 // fields so they can't break the mailto subject header or the copied draft.
 const subj = `${r.status==="fault"?"Service request":"Warranty claim"}, ${r.model} (${r.site} · ${r.inv})`.replace(/[\r\n\t]+/g," ").trim();
 const body =
`To whom it may concern,

I'm ${r.status==="fault"?"requesting service for":"filing a warranty claim on"} an inverter on my array "${r.site}":

 • Inverter: ${r.inv} (${r.model}${r.nameplate?`, ${r.nameplate} kW`:""})
 • Reported status: ${r.status==="fault"?"FAULT":"DEAD / not reporting"}
 • Peer index: ${r.pi!=null?r.pi.toFixed(2):"—"} (1.00 = fair share vs neighbors)
 • Est. lost output:${r.lostKwh>=1?` ${Math.round(r.lostKwh)} kWh over ${WINDOW_DAYS} days`:" —"}
 • Est. lost value: ${usd0(r.lossYr/12)} so far this month

Neighboring inverters produced normally over the same period, ruling out weather or shading. Please advise on repair or replacement under warranty.

Thank you,
[Your name]`;
 const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
 // Browsers silently drop overly-long mailto: URLs, exactly the dead/fault
 // inverters that matter most produce the longest drafts. When the href is too
 // long to open reliably, fall back to copying the full draft so it's never lost.
 if(href.length > 1800){
 const draft = `To: ${to}\nSubject: ${subj}\n\n${body}`;
 const done = () => toast("Draft copied, paste it into your email (it was too long to open automatically).");
 if(navigator.clipboard && navigator.clipboard.writeText){
 navigator.clipboard.writeText(draft).then(done).catch(()=>{
 try { window.location.href = href; } catch(e){} // last resort: try anyway
 });
 } else {
 try { window.location.href = href; } catch(e){}
 }
 return;
 }
 try { window.location.href = href; } catch(e){}
 }

 function toast(msg){
 let t=document.getElementById("ccToast");
 if(!t){ t=document.createElement("div"); t.id="ccToast";
 t.setAttribute("style","position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9998;background:#0e1620;border:1px solid var(--line);color:var(--ink);padding:11px 16px;border-radius:11px;font-size:13px;box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;");
 document.body.appendChild(t); }
 t.textContent=msg; t.style.opacity="1";
 clearTimeout(t._tm); t._tm=setTimeout(()=>t.style.opacity="0",3200);
 }

 /* ===========================================================================
 * 5. LIVE, KPIs reflect the fleet and keep updating. The store runs a
 * heartbeat (polls the backend when live, gently evolves the demo otherwise)
 * and emits kind "live"; we repaint the KPI numbers IN PLACE so the strip
 * stays current without rebuilding the triage queue under the user's hands.
 * ==========================================================================*/
 function asofText(){
 const t = (window.FleetStore && FleetStore.lastUpdate) ? FleetStore.lastUpdate() : 0;
 const s = t ? Math.max(0, Math.round((Date.now()-t)/1000)) : 0;
 // "checked", not "updated": this clock is when the BROWSER last polled the
 // store, it keeps ticking even when every feed is frozen, so calling it
 // "updated" let stale data read as current. When any feed is stale (same
 // VendorSheet.isStale gate as the sheet), append the oldest data age so a
 // frozen fleet's real freshness is on the tile too.
 return `<b>●</b> ${s<2 ? "checked just now" : "checked "+s+"s ago"}${_staleAsOf(t)}`;
 }
 function _ageTxt(min){
 if(min < 90) return Math.round(min)+" min ago";
 if(min < 1440) return Math.round(min/60)+"h ago";
 return Math.round(min/1440)+"d ago";
 }
 // Oldest data age across STALE columns (source_status.age_hours, else
 // sync_status.age_min), cached per store update, asofText repaints on a 1s
 // interval and mustn't rebuild toColumns() every tick.
 let _asofStale = "", _asofStaleAt = -1;
 function _staleAsOf(t){
 if(t === _asofStaleAt) return _asofStale;
 _asofStaleAt = t;
 let cols = [];
 try { cols = (FleetStore.toColumns().columns) || []; } catch(_){}
 let oldest = null;
 cols.forEach(c => {
 if(!_isStale(c)) return;
 const h = (c.source_status || {}).age_hours;
 const m = h != null ? h*60 : (c.sync_status || {}).age_min;
 if(m != null && (oldest == null || m > oldest)) oldest = m;
 });
 _asofStale = oldest == null ? `` : ` · data as of ${_ageTxt(oldest)}`;
 return _asofStale;
 }
 function setText(sel, val){ const el = document.querySelector(sel); if(el && el.textContent!==val) el.textContent = val; }

 // recompute KPIs from the store and write them into the existing tile grid
 // IN PLACE, values, subs, and tone classes, so the meter/sheen animations
 // never restart and the triage queue isn't rebuilt under the user's hands.
 function paintKpis(){
 if(!host()) return;
 MODEL = buildModel(FleetStore.snapshot()); // keep the model fresh for the queue too
 const k = MODEL.kpis;
 const watchN = Math.max(0, k.flagged - k.crit);
 setText('[data-kpi="sites"]', num(k.sites));
 setText('[data-kpi="inverters"]', num(k.inverters));
 const gathering = k.healthyPct == null; // nothing gradeable yet → unknown, not 100%
 setText('[data-kpi="healthy"]', gathering ? "—" : String(k.healthyPct)); // the tile's unit span owns the "%"
 setText('[data-kpi="flagged"]', num(k.flagged));
 setText('[data-kpi="crit"]', num(k.crit));
 setText('[data-kpi="watchcount"]', num(watchN));
 const healthCls = gathering ? "neutral" : (k.healthyPct > 80 ? "ok" : "warn");
 const meter = document.querySelector('[data-kpi="healthmeter"]');
 if(meter){
 meter.style.width = (gathering ? 0 : k.healthyPct) + "%";
 meter.classList.toggle("fcg-fill--warn", healthCls === "warn");
 }
 const tileOf = sel => { const el = document.querySelector(sel); return el ? el.closest(".fcg-tile") : null; };
 const setSub = (t, txt) => { const s = t && t.querySelector(".fcg-s"); if(s && s.textContent !== txt) s.textContent = txt; };
 const ht = tileOf('[data-kpi="healthy"]');
 if(ht){
 ht.classList.toggle("ok", healthCls === "ok");
 ht.classList.toggle("warn", healthCls === "warn");
 ht.classList.toggle("neutral", gathering);
 setSub(ht, gathering ? "Collecting history"
 : `${num(Math.max(0, k.inverters - k.flagged))} of ${num(k.inverters)} inverters`);
 }
 const ft = tileOf('[data-kpi="flagged"]');
 if(ft){ ft.classList.toggle("t-warn", !!k.flagged); setSub(ft, k.flagged ? "need attention below" : "none right now"); }
 const ct = tileOf('[data-kpi="crit"]');
 if(ct){ ct.classList.toggle("t-bad", !!k.crit); setSub(ct, k.crit ? "stopped earning or faulted" : "no outages or faults"); }
 const wt = tileOf('[data-kpi="watchcount"]');
 if(wt){ wt.classList.toggle("t-warn", !!watchN); setSub(wt, watchN ? "underperforming or gone quiet" : "nothing on watch"); }
 // the money tile can switch structure ($/mo ↔ to-check ↔ $0), rebuild just it
 const riskMo = Math.round(k.riskMo || 0);
 const rt = document.querySelector(".fcg-tile--risk");
 if(rt){
 rt.classList.toggle("t-warn", riskMo < 1 && !!k.flagged);
 const html = riskTileHTML(k, riskMo);
 if(rt.innerHTML !== html) rt.innerHTML = html;
 }
 const asof = document.getElementById("ccAsof"); if(asof) asof.innerHTML = asofText();
 renderProdKpis(); // keep the live production strip fresh on every beat
 }

 // React to the shared store: a "live" beat just repaints the numbers; any
 // structural change (load / drag / triage) does the full render.
 function onStore(state, kind){
 if(!host()) return;
 if(kind === "live" && document.querySelector('[data-kpi="flagged"]')){ paintKpis(); return; }
 MODEL = buildModel(FleetStore.snapshot());
 render();
 }

 /* ===========================================================================
 * 6. COLLAPSIBLE TRIAGE QUEUE, the header (#triageToggle, in index.html)
 * shows/hides #ccQueue. Starts COLLAPSED by default so the fleet tree leads;
 * the queue still renders into #ccQueue in the background, just hidden.
 * ==========================================================================*/
 function applyTriageState(){
 const head = document.getElementById("triageToggle");
 const queue = document.getElementById("ccQueue");
 if(!head || !queue) return;
 const collapsed = head.classList.contains("collapsed");
 queue.hidden = collapsed;
 head.setAttribute("aria-expanded", String(!collapsed));
 const hint = document.getElementById("triageHint");
 if(hint){
 const n = (MODEL && MODEL.kpis) ? MODEL.kpis.flagged : null;
 hint.textContent = collapsed
 ? (n ? `Show ${num(n)} flagged →` : "Show queue →")
 : "Hide queue";
 }
 }
 function toggleTriage(){
 const head = document.getElementById("triageToggle");
 if(!head) return;
 head.classList.toggle("collapsed");
 applyTriageState();
 }
 // Document-level delegation (matches app.js's CTA pattern) so the toggle works
 // regardless of when #triageToggle is parsed or the Arrays tab is activated.
 // The header starts COLLAPSED, the `collapsed` class is set in index.html.
 document.addEventListener("click", e => { if(e.target.closest("#triageToggle")) toggleTriage(); });
 document.addEventListener("keydown", e => {
 if((e.key==="Enter"||e.key===" ") && e.target.closest && e.target.closest("#triageToggle")){
 e.preventDefault(); toggleTriage();
 }
 });
 if(document.readyState!=="loading") applyTriageState();
 else document.addEventListener("DOMContentLoaded", applyTriageState);

 window.__ccLoad = () => FleetStore.load();
 // Expose the commander render so sandbox.js can (re)fill the in-canvas fleet
 // card after every canvas rebuild, the card now lives INSIDE .sb-canvas (a
 // card in the scene), so the rebuild would otherwise leave the #fleetCommander
 // placeholder empty. render() finds #fleetCommander by id wherever it lives.
 window.__ccRender = render;
 // Tab-slide calls this after marking the destination .active and before
 // measuring height, so Fleet Triage is full-length on the first animation frame.
 window.__aoTabBeforeSlide = function(toEl){
 try{
 if(toEl && toEl.id === "panelDashboard") render();
 }catch(e){}
 };
 FleetStore.subscribe(onStore);
 // tick the "updated Ns ago" label once a second (cheap, text-only)
 setInterval(() => { const a = document.getElementById("ccAsof"); if(a) a.innerHTML = asofText(); }, 1000);
 if(document.readyState!=="loading") FleetStore.load();
 else document.addEventListener("DOMContentLoaded", FleetStore.load);
})();
