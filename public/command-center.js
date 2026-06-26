/* ============================================================================
 * Array Operator — Portfolio Command Center (command-center.js)
 *
 * The fleet-scale front door. For an owner running 100+ arrays / ~1,200
 * inverters, the per-site fleet tree (sandbox.js) doesn't scale — you can't
 * hand-scan 1,200 cards. This view answers the only questions that matter at
 * that scale, up front:
 *
 *     • how many inverters are flagged right now, and
 *     • how many dollars are leaking this month — across the WHOLE portfolio,
 *     • sorted worst-first, each row carrying the verdict AND the action.
 *
 * Data: when signed in, the SAME /v1/array-owners/fleet-tree the sandbox reads.
 * Anonymous (marketing/preview), a deterministic 100-array simulated fleet so
 * the scale story is real. The fleet tree below becomes a per-site drill-down.
 * ==========================================================================*/
(function(){
  "use strict";

  // ---- value model: mirrors app.js (transparent estimate) ----
  // Rate comes from FleetStore.energyRate() — the owner's REAL billed $/kWh when
  // signed in (backend default_net_rate_per_kwh), so "$ at risk" matches invoices
  // instead of overstating ~14% with the old hardcoded $0.21. Falls back to 0.21
  // for the demo/anon fleet (and before the rate fetch returns).
  const FS = () => (window.FleetStore || null);
  const ENERGY_RATE_FALLBACK = 0.21;   // $/kWh blended offset (demo/anon)
  const energyRate = () => { const s = FS(); return s && s.energyRate ? s.energyRate() : ENERGY_RATE_FALLBACK; };
  const REC_PER_MWH = (FS() && FS().REC_PER_MWH) || 38;   // $/MWh REC value
  const WINDOW_DAYS = 14;

  // ---- modeled production target (expected vs actual) ----
  // Peer analysis catches ONE inverter lagging its neighbors, but it's blind to a
  // whole fleet sagging together — soiling after a dry spell, snow, smoke, or
  // slow degradation hits every panel under the same sky, so peers all match and
  // nothing flags. A modeled target catches that: compare measured production to
  // what this nameplate SHOULD make in this month.
  //
  // Target = nameplate_kW × 24h × days × monthly capacity factor. The CF table is
  // a typical Northeast-US fixed-tilt PV AC capacity factor by month (NREL PVWatts-
  // class numbers: ~13-14% annual, summer peak ~18%, winter trough ~7%). It is a
  // MODEL, never a measurement — the UI labels it "modeled / typical" and the
  // shortfall flag stays conservative (only a sustained, sizable gap trips it).
  const CF_BY_MONTH = [0.072,0.095,0.135,0.160,0.175,0.182,0.180,0.168,0.145,0.110,0.072,0.060];
  const seasonalCF = () => CF_BY_MONTH[new Date().getMonth()] || 0.14;
  // A gap only reads as a problem past this band — below it is normal model/weather
  // noise (a clear-vs-cloudy fortnight easily moves ±15%). 18% under target = real.
  const TARGET_SHORTFALL_PCT = 0.18;
  const val  = kwh => kwh*energyRate() + (kwh/1000)*REC_PER_MWH;
  const usd0 = n => "$"+Math.round(Number(n)||0).toLocaleString();
  const num  = n => Number(n||0).toLocaleString();

  const SESSION_KEY = "so_session";
  const STATE_KEY = "cc_triage_state";   // {key: "progress"|"snoozed"} — local workflow memory
  const getSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } };
  const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));

  const STATUS_LABEL = {
    dead:"Stopped earning", fault:"Hardware fault",
    underperforming:"Below its neighbors", comm_gap:"Gone quiet", ok:"Pulling its weight",
    live_dark:"Not producing now", monitoring:"Monitoring"
  };
  const SEV = {                                   // status → triage severity bucket
    dead:"crit", fault:"crit", underperforming:"under", comm_gap:"quiet", ok:"ok",
    live_dark:"quiet",   // live anomaly: real but unpriced, like a comms gap — watch bucket
    monitoring:"ok"      // not enough evidence yet — not a flagged row
  };
  const SEV_RANK = { crit:0, under:1, quiet:2, ok:3 };
  const ACTION = {
    dead:"Draft warranty claim", fault:"Draft service request",
    underperforming:"See the diagnosis", comm_gap:"Bring it back online",
    live_dark:"Check why it stopped"
  };

  /* ===========================================================================
   * 1. DATA — normalize to a flat list of flagged inverters w/ $ at stake.
   * ==========================================================================*/

  // per-inverter lost-kWh estimate over the window (same logic family as app.js)
  function lostKwh(inv, fleetWindowKwh, totalNameplate){
    const fair = (inv.nameplate_kw||0)/totalNameplate*fleetWindowKwh;
    if(inv.status==="dead"||inv.status==="fault") return Math.max(0, fair-(inv.window_kwh||0));
    if(inv.status==="underperforming" && inv.peer_index) return Math.max(0, fair/Math.max(inv.peer_index,0.01)-(inv.window_kwh||0));
    if(inv.status==="comm_gap") return 0;          // unknown until it reports — no $ claimed
    return 0;
  }

  // flatten → {rows:[…flagged…], kpis:{…}}
  function buildModel(fleet){
    const rows=[]; let invTotal=0, invHealthy=0;
    // modeled-target accumulators — only over inverters with REAL window history,
    // so a freshly-connected (no-history) unit never drags the fleet's actual %.
    const cf = seasonalCF();
    let measuredKwh = 0, targetKwh = 0, measuredCount = 0;
    fleet.arrays.forEach(a => {
      const totalNp = a.inverters.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;
      const fleetWin = a.inverters.reduce((t,i)=>t+(i.window_kwh||0),0);
      a.inverters.forEach(inv => {
        invTotal++;
        // Production target: only when we have a real measured window for this unit.
        if(inv.nameplate_kw > 0 && inv.window_kwh != null && inv.window_kwh > 0){
          measuredKwh += inv.window_kwh;
          targetKwh   += inv.nameplate_kw * 24 * WINDOW_DAYS * cf;
          measuredCount++;
        }
        // Resolve the inverter's EFFECTIVE flagged-status. inv.status is the 14-day
        // peer verdict; a fresh live anomaly (dark now while >=2 daylight peers
        // produce) isn't caught by it yet, so we promote a status:"ok" inverter to
        // a "live_dark" row. Shared FleetStore classifier → same logic as the tree
        // + grid, so the three surfaces never disagree.
        let status = inv.status;
        if(status === "ok" && window.FleetStore && FleetStore.liveVerdict
           && FleetStore.liveVerdict(inv, a.inverters, a.is_daylight) === "dark"){
          status = "live_dark";
        }
        if(status === "ok"){ invHealthy++; return; }
        // "monitoring" = not enough history to judge yet — neutral, never a flagged
        // row. Count it as not-flagged (don't drag the healthy %) and skip the table.
        if(status === "monitoring"){ invHealthy++; return; }
        // live_dark carries no priced loss yet (unconfirmed, like comm_gap) — the
        // dollars are claimed once 14-day health confirms it dead/underperforming.
        const lk = (status === "live_dark") ? 0 : lostKwh(inv, fleetWin, totalNp);
        const lossMo = val(lk)/WINDOW_DAYS*30;
        rows.push({
          key:`${a.id}|${inv.name}`, arrayId:a.id, site:a.name, region:a.region, host:a.host, vendor:a.vendor,
          inv:inv.name, model:inv.model, nameplate:inv.nameplate_kw, status,
          sev:SEV[status], pi:inv.peer_index, stale:inv.stale_hours,
          lossMo, lossYr:lossMo*12, lostKwh:lk, windowKwh:inv.window_kwh,
          live: status === "live_dark",
        });
      });
    });
    const flagged = rows.length;
    const riskMo = rows.reduce((t,r)=>t+r.lossMo,0);
    // pct of modeled target the fleet actually made over the window (real measured
    // kWh ÷ modeled target kWh). null when no unit has window history yet.
    const ratio = targetKwh > 0 ? measuredKwh / targetKwh : null;
    const production = {
      ready: measuredCount > 0 && targetKwh > 0,
      measuredKwh, targetKwh, ratio, cf,
      pct: ratio == null ? null : Math.round(ratio * 100),
      coveredInverters: measuredCount,
      // shortfall is a SUSTAINED, sizable gap (past the noise band) — not a blip
      short: ratio != null && ratio < (1 - TARGET_SHORTFALL_PCT),
    };
    return {
      rows, recovered:fleet.recovered_ytd||0, simulated:fleet.simulated, production,
      kpis:{
        sites:fleet.arrays.length, inverters:invTotal,
        healthyPct: invTotal? Math.round(invHealthy/invTotal*100):100,
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

  function render(){
    const h = host(); if(!h || !MODEL) return;
    const q = document.getElementById("ccQueue");
    const k = MODEL.kpis;
    // Fleet-health color (Ford, 2026-06-23): blue = good, all the way down to 80%;
    // at 80% and below it turns orange. Two states only — no red tier.
    const healthCls = k.healthyPct > 80 ? "ok" : "warn";
    const riskMo = Math.round(MODEL.kpis.riskMo || 0);
    const simNote = MODEL.simulated
      ? `Demo fleet — sign in to load yours`
      : `Live from your connected arrays`;

    // PINNED COMMANDER CARD — whole-fleet health at a single glance. Big health %,
    // a status-colored meter, the counts, the flagged breakdown, $/mo at stake,
    // and a live "updated Ns ago". No table, no extra chrome.
    h.innerHTML = `
      <div class="fc-card ${healthCls}">
        <div class="fc-tank fc-tank--${healthCls}" data-kpi="healthmeter" style="width:${k.healthyPct}%" aria-hidden="true">
          <span class="fc-liq-bubbles">
            <span style="left:9%;width:5px;height:5px;animation-duration:3.4s;animation-delay:.0s"></span>
            <span style="left:24%;width:4px;height:4px;animation-duration:4.1s;animation-delay:.7s"></span>
            <span style="left:41%;width:6px;height:6px;animation-duration:3.0s;animation-delay:1.3s"></span>
            <span style="left:58%;width:4px;height:4px;animation-duration:4.6s;animation-delay:.4s"></span>
            <span style="left:73%;width:5px;height:5px;animation-duration:3.7s;animation-delay:1.0s"></span>
            <span style="left:88%;width:4px;height:4px;animation-duration:4.3s;animation-delay:1.6s"></span>
          </span>
        </div>
        <div class="fc-plate">
        <div class="fc-health">
          <div class="fc-health-num"><b data-kpi="healthy">${k.healthyPct}</b><span>%</span></div>
          <div class="fc-health-lbl">fleet healthy</div>
        </div>
        <div class="fc-mid">
          <div class="fc-stats">
            <span class="fc-stat"><b data-kpi="sites">${num(k.sites)}</b> arrays</span>
            <span class="fc-dot">·</span>
            <span class="fc-stat"><b data-kpi="inverters">${num(k.inverters)}</b> inverters</span>
            <span class="fc-dot">·</span>
            <span class="fc-stat ${k.flagged?"flag":""}"><b data-kpi="flagged">${num(k.flagged)}</b> flagged</span>
            <span class="fc-sub" data-kpi="flaggedsub">${k.crit} critical · ${k.flagged-k.crit} watch</span>
          </div>
        </div>
        <div class="fc-right">
          ${riskMo>=1
            ? `<div class="fc-risk"><span class="fc-risk-k">recoverable</span><b data-kpi="risk">${usd0(riskMo)}</b><span class="fc-risk-u">/mo</span><span class="fc-risk-sub">by fixing the flagged inverters</span></div>`
            : k.flagged
              ? `<div class="fc-watch" data-kpi="watch"><b>${num(k.flagged)}</b> to check<span class="fc-risk-sub">live anomalies — no $ lost yet</span></div>`
              : `<div class="fc-allclear">All clear 🌞</div>`}
          <div class="fc-asof" id="ccAsof">${asofText()}</div>
          <button class="fc-alerts-btn" id="fcAlerts" type="button" title="Email me when an inverter goes down or underperforms">🔔 Alerts</button>
        </div>
        </div>
      </div>
      ${MODEL.simulated ? `<div class="fc-note">${esc(simNote)}</div>` : ``}`;

    // Wire the relocated Alerts button (moved here from the sandbox head). The
    // settings modal lives in sandbox.js and is exposed as window.__sbOpenAlerts.
    const alertsBtn = document.getElementById("fcAlerts");
    if(alertsBtn) alertsBtn.onclick = () => {
      if(typeof window.__sbOpenAlerts === "function") window.__sbOpenAlerts();
    };

    // On the DASHBOARD tab, surface the combined attention queue (every flagged
    // inverter across the fleet, worst-first); elsewhere keep it empty.
    renderProdKpis();
    renderProductionTarget();   // modeled expected-vs-actual card (Dashboard only)
    // Relabel the attention header so a clean fleet doesn't sit under a "Needs
    // attention" heading over an empty list — read it as the all-clear it is.
    const attnH = document.getElementById("dashAttnH");
    if(attnH){
      const loaded = !(window.FleetStore && FleetStore.isLoaded && !FleetStore.isLoaded());
      attnH.textContent = !loaded ? "Needs attention"
        : (k.flagged ? "Needs attention" : "All clear — nothing needs attention 🌞");
      attnH.classList.toggle("all-clear", loaded && !k.flagged);
    }
    if(!q) return;
    if(_dashActive()) renderQueueLEGACY(); else q.innerHTML = "";
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
  // number, not live output — it must not inflate the headline "kW now".
  const _CADENCE_MIN = { chint: 4, fronius: 6, sma: 6 };
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
    // Before the fleet tree lands, show a calm "loading" line instead of a blank
    // strip that reads as a broken/empty dashboard. (The FleetStore subscribe
    // re-runs render() once data arrives, replacing this.)
    if(FleetStore.isLoaded && !FleetStore.isLoaded()){
      el.innerHTML = `<span class="dp dp-loading">Loading your fleet…</span>`;
      return;
    }
    let cols = [];
    try { cols = (FleetStore.toColumns().columns) || []; } catch(_){ return; }
    let kw = 0, kwh = 0, producing = 0, stale = 0;
    cols.forEach(c => {
      // A frozen feed's reading isn't live power — exclude it from "kW now" and the
      // producing count so the headline matches the dimmed/stale rows in the sheet.
      // (kWh-today still accrues from the last real cumulative reading, so we keep
      // it — only the instantaneous "now" power is the one that goes false-live.)
      const frozen = _isStale(c);
      if(frozen) stale++;
      // Array live power: prefer the array-level value (real backend), else sum the
      // array's inverters (the demo fleet only carries per-inverter watts).
      let p = c.current_power_w;
      if(p == null) p = (c.inverters || []).reduce((t,i)=>t+(i.current_power_w||0),0);
      if(!frozen){
        kw += (p || 0);
        if((p || 0) > 0) producing++;
      }
      if(c.produced_today_kwh != null) kwh += c.produced_today_kwh;
    });
    el.innerHTML =
      `<span class="dp"><b>${esc(kwFmt(kw))}</b> now</span><span class="dp-dot">·</span>` +
      `<span class="dp"><b>${Math.round(kwh).toLocaleString()}</b> kWh today</span><span class="dp-dot">·</span>` +
      `<span class="dp"><b>${producing}</b>/${cols.length} arrays producing</span>` +
      (stale ? `<span class="dp-dot">·</span><span class="dp dp-stale" title="${stale} feed${stale===1?"":"s"} paused — last reading is frozen, so it's left out of 'kW now'">${stale} feed${stale===1?"":"s"} paused</span>` : ``);
  }

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  // Modeled production target card — actual measured kWh vs what this nameplate
  // typically makes this month. Honest by construction: "actual" is real measured
  // window production; "target" is explicitly labeled a typical/seasonal model,
  // and we only show it once at least one unit has real history. The shortfall
  // flag is conservative (sustained gap past the noise band).
  function renderProductionTarget(){
    const el = document.getElementById("fleetTarget");
    if(!el) return;
    // Only on the Dashboard tab + after the fleet loads; otherwise leave it empty.
    if(!_dashActive() || !MODEL){ el.innerHTML = ""; return; }
    if(window.FleetStore && FleetStore.isLoaded && !FleetStore.isLoaded()){ el.innerHTML = ""; return; }
    const p = MODEL.production;
    if(!p || !p.ready){ el.innerHTML = ""; return; }   // no window history yet → say nothing

    const pct = p.pct;                                  // % of modeled target made
    // bar fills to actual %, capped at 120% so an over-target fleet still reads;
    // the 100% target line is drawn as a marker on the track.
    const fill = Math.max(0, Math.min(pct, 120));
    const tone = p.short ? "warn" : (pct >= 92 ? "ok" : "soft");
    const month = MONTHS[new Date().getMonth()];
    const verdict = p.short
      ? `${100 - pct}% under its typical ${month} output`
      : pct >= 100
        ? `on track — at or above typical ${month} output`
        : `tracking near typical ${month} output`;
    el.innerHTML = `
      <div class="ft-card ${tone}">
        <div class="ft-head">
          <div class="ft-title">Production vs target</div>
          <div class="ft-pct"><b>${pct}<span>%</span></b><small>of typical</small></div>
        </div>
        <div class="ft-track" role="img" aria-label="Fleet made ${pct}% of its modeled ${esc(month)} target">
          <div class="ft-fill ${tone}" style="width:${fill}%"></div>
          <span class="ft-mark" style="left:${100/1.2}%" title="100% = typical ${esc(month)} output"></span>
        </div>
        <div class="ft-row">
          <span class="ft-verdict ${tone}">${p.short?"⚠ ":""}${esc(verdict)}</span>
          <span class="ft-nums">${Math.round(p.measuredKwh).toLocaleString()} kWh measured · ${Math.round(p.targetKwh).toLocaleString()} kWh typical</span>
        </div>
        <div class="ft-note">${p.short
          ? `A whole-fleet shortfall like this is what peer checks miss — every panel's down together (soiling, snow, smoke, or aging), so neighbors still match. Worth a fleet-wide clean/inspection.`
          : `Target is a <b>typical-weather model</b> for ${esc(month)} (nameplate × seasonal capacity factor, ${Math.round(p.cf*100)}%), not a guarantee — a cloudy fortnight runs under, a sunny one over. Catches sustained fleet-wide drops peer checks can't.`}
          <span class="ft-cov">Across ${num(p.coveredInverters)} inverter${p.coveredInverters===1?"":"s"} with ${WINDOW_DAYS}-day history.</span>
        </div>
      </div>`;
  }

  // legacy render kept for reference / other callers
  function renderQueueLEGACY(){
    const h = host(); if(!h || !MODEL) return;
    const q = document.getElementById("ccQueue");
    const k = MODEL.kpis;
    const regions = ["all", ...Array.from(new Set(MODEL.rows.map(r=>r.region))).filter(x=>x&&x!=="—").sort()];
    const simNote = MODEL.simulated
      ? `Simulated 100-array portfolio — sign in to load your live fleet.`
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
      <div class="cc-foot">Showing flagged inverters only — the ${num(k.inverters-k.flagged)} healthy units are hidden by design. Verdicts are peer-measured: each inverter weighed against its neighbors under the same sky, so weather cancels out. $ figures estimate at $${energyRate().toFixed(2)}/kWh + ${REC_PER_MWH}/MWh RECs.</div>`;

    renderBody();
    wire();
    applyTriageState();   // keep the collapse pill's flagged-count fresh
  }

  function chip(id,label,n,dot){
    return `<button class="cc-chip ${UI.sev===id?"on":""}" data-sev="${id}">${dot?`<span class="d ${dot}"></span>`:""}${label} <span class="n">${n}</span></button>`;
  }
  function sortArrow(col){ return UI.sort===col ? `<span class="arrow">${UI.dir<0?"▾":"▴"}</span>` : ""; }

  function renderBody(){
    const body = document.getElementById("ccBody"); if(!body) return;
    const rows = filteredRows();
    if(!rows.length){ body.innerHTML = `<tr><td colspan="8" class="cc-empty">No inverters match — your fleet's clean here. 🌞</td></tr>`; return; }
    body.innerHTML = rows.map(r => {
      const piTxt = r.pi==null ? `<span class="cc-pi">—<small> no peers</small></span>`
        : `<span class="cc-pi">${r.pi.toFixed(2)}<small> · ${Math.round((1-r.pi)*100)}% low</small></span>`;
      const st = wfState(r.key);
      const sel = UI.selected.has(r.key);
      const main = `
        <tr class="row sev-${r.sev} ${sel?"sel":""}" data-key="${esc(r.key)}">
          <td class="shrink"><input type="checkbox" class="cc-check ccRow" data-key="${esc(r.key)}" ${sel?"checked":""}></td>
          <td><span class="cc-site">${esc(r.site)}</span><small>${esc(r.region)}${r.host?` · ${esc(r.host)}`:""}</small></td>
          <td class="cc-inv"><b>${esc(r.inv)}</b> · ${esc(r.model)}</td>
          <td><span class="cc-verdict ${r.sev}"><span class="cc-sevdot ${r.sev}"></span> ${STATUS_LABEL[r.status]}</span></td>
          <td class="num">${piTxt}</td>
          <td class="num">${r.lossMo>=1?`<span class="cc-loss">${usd0(r.lossMo)}</span>`:`<span style="color:var(--faint)">—</span>`}</td>
          <td><span class="cc-verdict ${r.sev}" style="font-weight:650">${ACTION[r.status]} →</span></td>
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
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> has gone quiet — no telemetry for <b>${r.stale!=null?r.stale+"h":"a while"}</b>. Its neighbors are still reporting, so this reads as a comms dropout, not a power fault. We can't bill lost output until it checks back in.`
      : r.status==="live_dark"
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is reading <b>zero output right now</b> while its array neighbors are actively producing under the same sky. This is a LIVE reading — the 14-day health hasn't flagged it yet, so it just stopped. Could be an early-stage fault, a tripped breaker, or a brief dropout; check before it becomes lost revenue.`
      : r.status==="dead"
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> has produced <b>zero</b> for ~${r.stale!=null?Math.round(r.stale/24):"a few"} days while ${peers} kept producing — that rules out weather. Warranty claim is ready with the fault dates and peer-measured lost-kWh evidence.`
      : r.status==="fault"
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is throwing a hardware fault and running at a fraction of ${peers}. Service request drafted with the evidence attached.`
      : `Over ${WINDOW_DAYS} days, <b>${esc(r.inv)}</b> made only <b>${r.pi!=null?Math.round(r.pi*100):"—"}%</b> of its fair share vs ${peers} under the same sky. That <b>${r.pi!=null?Math.round((1-r.pi)*100):"—"}% shortfall</b> is the unit — likely shading, soiling, or a tired string.`;
    const rec = r.status==="comm_gap"
      ? `Power-cycle the inverter's gateway / data logger and confirm it rejoins. No telemetry within a day → escalate to a site visit.`
      : r.status==="live_dark"
      ? `Confirm it's still dark (this is a live, possibly brief reading), then check the breaker/disconnect and the inverter's own fault log. If it stays at zero into tomorrow, the 14-day health will escalate it to a warranty-grade claim automatically.`
      : r.status==="underperforming"
      ? `Schedule a visual + IV-curve check on this inverter's strings. A failed module or cleaning is usually a fast-payback fix.`
      : `Send the drafted ${r.status==="fault"?"service request":"warranty claim"} to the manufacturer — evidence is attached and dated.`;
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
        </div>
        <div>
          <h4>Recommended next action</h4>
          <div class="cc-rec"><b>Do this:</b> ${rec}</div>
          <div class="cc-actions">
            ${(r.status==="dead"||r.status==="fault")
              ? `<button class="cc-btn primary" data-do="claim" data-key="${esc(r.key)}">${r.status==="fault"?"Draft service request":"Draft warranty claim"}</button>`
              : `<button class="cc-btn primary" data-do="progress" data-key="${esc(r.key)}">Start working it</button>`}
            <button class="cc-btn ghost" data-do="progress" data-key="${esc(r.key)}">Mark in progress</button>
            <button class="cc-btn ghost" data-do="snooze" data-key="${esc(r.key)}">Snooze</button>
            <button class="cc-btn ghost" data-do="focus" data-key="${esc(r.key)}">Open in fleet tree →</button>
          </div>
        </div>
      </div></td></tr>`;
  }

  /* ===========================================================================
   * 4. WIRING
   * ==========================================================================*/
  // Re-render only the triage queue (#ccQueue) — NOT the pinned commander card.
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
        if(e.target.closest(".ccRow")) return;                 // checkbox handled separately
        const key = tr.dataset.key;
        UI.expanded = UI.expanded===key ? null : key;
        renderBody();
      };
    });
    document.querySelectorAll("#ccBody .ccRow").forEach(cb => cb.onclick = e => {
      e.stopPropagation();
      if(cb.checked) UI.selected.add(cb.dataset.key); else UI.selected.delete(cb.dataset.key);
      // refresh bulk bar + row highlight without collapsing the drawer — queue
      // only, so the commander card above doesn't flicker on a selection toggle
      renderQueueOnly();
    });
    document.querySelectorAll("#ccBody [data-do]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      const key=b.dataset.key, act=b.dataset.do;
      const r = MODEL.rows.find(x=>x.key===key);
      // mutating shared state notifies the store → this view (and any other) re-renders
      if(act==="claim"){ openClaim(r); FleetStore.setTriage(key,"progress"); }
      else if(act==="progress"){ FleetStore.setTriage(key,"progress"); }
      else if(act==="snooze"){ FleetStore.setTriage(key,"snoozed"); }
      else if(act==="focus" && r){
        FleetStore.setFocus([r.arrayId]);            // jump the fleet tree to this site
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
    FleetStore.setTriageBatch(keys, "progress");   // one notify → re-render
  }

  // Known manufacturer support inboxes — guessing support@<slug>.com gets the wrong
  // address for several vendors (Fronius/SMA), and an unvalidated vendor string from the
  // backend could otherwise steer the draft to an attacker-chosen domain. Whitelist the
  // vendors we actually capture; anything else falls back to a sanitized slug guess.
  const VENDOR_SUPPORT = {
    solaredge: "support@solaredge.com",
    fronius:   "pv-support-usa@fronius.com",
    sma:       "service@sma-america.com",
    enphase:   "support@enphase.com",
    chint:     "service@chintpower.com",
  };
  function vendorSupportEmail(vendor){
    const key = (vendor||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    if(VENDOR_SUPPORT[key]) return VENDOR_SUPPORT[key];
    return `support@${key||"installer"}.com`;   // sanitized slug — no injectable chars survive
  }

  // lightweight mailto claim (self-contained; the per-site sandbox has the full editor)
  function openClaim(r){
    if(!r) return;
    const to = vendorSupportEmail(r.vendor);
    // An email Subject is a single header line: collapse any CR/LF/tabs from backend
    // fields so they can't break the mailto subject header or the copied draft.
    const subj = `${r.status==="fault"?"Service request":"Warranty claim"} — ${r.model} (${r.site} · ${r.inv})`.replace(/[\r\n\t]+/g," ").trim();
    const body =
`To whom it may concern,

I'm ${r.status==="fault"?"requesting service for":"filing a warranty claim on"} an inverter on my array "${r.site}":

  • Inverter:        ${r.inv} (${r.model}${r.nameplate?`, ${r.nameplate} kW`:""})
  • Reported status: ${r.status==="fault"?"FAULT":"DEAD / not reporting"}
  • Peer index:      ${r.pi!=null?r.pi.toFixed(2):"—"} (1.00 = fair share vs neighbors)
  • Est. lost output:${r.lostKwh>=1?` ${Math.round(r.lostKwh)} kWh over ${WINDOW_DAYS} days`:" —"}
  • Est. lost value: ${usd0(r.lossYr/12)} so far this month

Neighboring inverters produced normally over the same period, ruling out weather or shading. Please advise on repair or replacement under warranty.

Thank you,
[Your name]`;
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
    // Browsers silently drop overly-long mailto: URLs — exactly the dead/fault
    // inverters that matter most produce the longest drafts. When the href is too
    // long to open reliably, fall back to copying the full draft so it's never lost.
    if(href.length > 1800){
      const draft = `To: ${to}\nSubject: ${subj}\n\n${body}`;
      const done = () => toast("Draft copied — paste it into your email (it was too long to open automatically).");
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(draft).then(done).catch(()=>{
          try { window.location.href = href; } catch(e){}  // last resort: try anyway
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
   * 5. LIVE — KPIs reflect the fleet and keep updating. The store runs a
   * heartbeat (polls the backend when live, gently evolves the demo otherwise)
   * and emits kind "live"; we repaint the KPI numbers IN PLACE so the strip
   * stays current without rebuilding the triage queue under the user's hands.
   * ==========================================================================*/
  function asofText(){
    const t = (window.FleetStore && FleetStore.lastUpdate) ? FleetStore.lastUpdate() : 0;
    const s = t ? Math.max(0, Math.round((Date.now()-t)/1000)) : 0;
    return `<b>●</b> ${s<2 ? "updated just now" : "updated "+s+"s ago"}`;
  }
  function setText(sel, val){ const el = document.querySelector(sel); if(el && el.textContent!==val) el.textContent = val; }

  // recompute KPIs from the store and write them into the existing strip
  function paintKpis(){
    if(!host()) return;
    MODEL = buildModel(FleetStore.snapshot());   // keep the model fresh for the queue too
    const k = MODEL.kpis;
    setText('[data-kpi="sites"]', num(k.sites));
    setText('[data-kpi="inverters"]', num(k.inverters));
    setText('[data-kpi="healthy"]', k.healthyPct+"%");
    const meter = document.querySelector('[data-kpi="healthmeter"]'); if(meter) meter.style.width = k.healthyPct+"%";
    setText('[data-kpi="flagged"]', num(k.flagged));
    setText('[data-kpi="flaggedsub"]', `${k.crit} critical · ${k.flagged-k.crit} watch`);
    const asof = document.getElementById("ccAsof"); if(asof) asof.innerHTML = asofText();
    renderProdKpis();           // keep the live production strip fresh on every beat
    renderProductionTarget();   // and the modeled expected-vs-actual card
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
   * 6. COLLAPSIBLE TRIAGE QUEUE — the header (#triageToggle, in index.html)
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
  // The header starts COLLAPSED — the `collapsed` class is set in index.html.
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
  // card after every canvas rebuild — the card now lives INSIDE .sb-canvas (a
  // card in the scene), so the rebuild would otherwise leave the #fleetCommander
  // placeholder empty. render() finds #fleetCommander by id wherever it lives.
  window.__ccRender = render;
  FleetStore.subscribe(onStore);
  // tick the "updated Ns ago" label once a second (cheap, text-only)
  setInterval(() => { const a = document.getElementById("ccAsof"); if(a) a.innerHTML = asofText(); }, 1000);
  if(document.readyState!=="loading") FleetStore.load();
  else document.addEventListener("DOMContentLoaded", FleetStore.load);
})();
