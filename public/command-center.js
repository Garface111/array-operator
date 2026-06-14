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
  const ENERGY_RATE = 0.21;       // $/kWh blended offset
  const REC_PER_MWH = 38;         // $/MWh REC value
  const WINDOW_DAYS = 14;
  const val  = kwh => kwh*ENERGY_RATE + (kwh/1000)*REC_PER_MWH;
  const usd0 = n => "$"+Math.round(Number(n)||0).toLocaleString();
  const num  = n => Number(n||0).toLocaleString();

  const SESSION_KEY = "so_session";
  const STATE_KEY = "cc_triage_state";   // {key: "progress"|"snoozed"} — local workflow memory
  const getSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } };
  const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));

  const STATUS_LABEL = {
    dead:"Stopped earning", fault:"Hardware fault",
    underperforming:"Below its neighbors", comm_gap:"Gone quiet", ok:"Pulling its weight"
  };
  const SEV = {                                   // status → triage severity bucket
    dead:"crit", fault:"crit", underperforming:"under", comm_gap:"quiet", ok:"ok"
  };
  const SEV_RANK = { crit:0, under:1, quiet:2, ok:3 };
  const ACTION = {
    dead:"Draft warranty claim", fault:"Draft service request",
    underperforming:"See the diagnosis", comm_gap:"Bring it back online"
  };

  /* ===========================================================================
   * 1. DATA — normalize to a flat list of flagged inverters w/ $ at stake.
   * ==========================================================================*/

  // deterministic PRNG so the simulated fleet is stable across renders
  function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

  const REGIONS = ["Northern VT","Mad River Valley","Champlain Islands","NH Upper Valley","The Berkshires","Central VT"];
  const HOSTS   = ["Green Mountain Solar","Catamount Energy Co-op","Maple Ridge Community","Sugarbush Holdings","Lakeside Dairy LLC","Riverbend Schools","Northfield Municipal","Birchwood Properties"];
  const PLACES  = ["Londonderry","Maple Street","Cover Catamount","Stowe Hollow","Waitsfield","Bristol Cliffs","Hinesburg Flats","Richmond Bridge","Underhill","Jericho Center","Cabot Creamery","Hardwick","Craftsbury","Greensboro Bend","Morrisville","Johnson Mill","Enosburg Falls","Swanton Yard","Grand Isle","Vergennes","Middlebury","Brandon Depot","Rutland Yard","Killington Base","Ludlow Mill","Chester Depot","Springfield Works","Bellows Falls","Brattleboro","Wilmington Ridge","Dover Notch","Manchester Center","Bennington Mill","Pownal Flats","Arlington","Dorset Quarry","Pawlet","Poultney","Fair Haven","Castleton"];
  const NAMEPLATES = [10,11.4,20,33.3];

  // simulate a 100-array fleet (1,196 inverters) — stable via seeded RNG
  function simulateFleet(){
    const rng = mulberry32(0x5ECA11);
    const pick = arr => arr[Math.floor(rng()*arr.length)];
    const arrays = [];
    const N_ARRAYS = 100;
    for(let i=0;i<N_ARRAYS;i++){
      const invCount = 8 + Math.floor(rng()*9);        // 8..16, ~12 avg
      const place = PLACES[i % PLACES.length];
      const name = i < PLACES.length ? place : `${place} ${Math.floor(i/PLACES.length)+1}`;
      const inverters = [];
      for(let j=0;j<invCount;j++){
        const r = rng();
        let status="ok";
        if(r<0.020) status="dead";
        else if(r<0.030) status="fault";
        else if(r<0.085) status="underperforming";
        else if(r<0.115) status="comm_gap";
        const np = pick(NAMEPLATES);
        // fair-share window kWh for a healthy unit of this nameplate (14d, ~VT June)
        const fair = np * 4.6 * WINDOW_DAYS;            // ~4.6 kWh/kW/day
        let pi=1+(rng()-0.5)*0.06, win=fair*pi, power=np*1000*(0.55+rng()*0.25);
        if(status==="underperforming"){ pi=0.55+rng()*0.27; win=fair*pi; power=np*1000*(0.30+rng()*0.20); }
        else if(status==="comm_gap"){ pi=null; win=fair*(0.6+rng()*0.3); power=null; }
        else if(status==="dead"){ pi=null; win=0; power=0; }
        else if(status==="fault"){ pi=0.18+rng()*0.18; win=fair*pi; power=np*1000*0.12; }
        inverters.push({
          name:`Inverter ${j+1}`, model:`SE${np}K`, nameplate_kw:np,
          peer_index:pi, status, window_kwh:Math.round(win*10)/10,
          current_power_w: power==null?null:Math.round(power),
          stale_hours: status==="comm_gap" ? Math.round(12+rng()*60) : (status==="dead"? Math.round(48+rng()*120):null)
        });
      }
      arrays.push({ id:i+1, name, region:pick(REGIONS), host:pick(HOSTS), vendor:"solaredge", inverters });
    }
    return { arrays, simulated:true, recovered_ytd: 18450 };   // recovered $ is tracked server-side in prod
  }

  // adapt the live fleet-tree shape (sandbox's columns) → internal arrays
  function adaptTree(tree){
    const arrays = (tree.columns||[]).map(c => ({
      id:c.array_id, name:c.array_name, region:"—", host:c.client_name||"",
      vendor:c.vendor||"", inverters:(c.inverters||[]).map(inv => ({
        name:inv.name, model:inv.model, nameplate_kw:inv.nameplate_kw,
        peer_index:inv.peer_index, status:inv.status, window_kwh:inv.window_kwh,
        current_power_w:inv.current_power_w, stale_hours:inv.stale_hours
      }))
    }));
    return { arrays, simulated:false, recovered_ytd:(tree.summary&&tree.summary.recovered_ytd)||0 };
  }

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
    fleet.arrays.forEach(a => {
      const totalNp = a.inverters.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;
      const fleetWin = a.inverters.reduce((t,i)=>t+(i.window_kwh||0),0);
      a.inverters.forEach(inv => {
        invTotal++;
        if(inv.status==="ok"){ invHealthy++; return; }
        const lk = lostKwh(inv, fleetWin, totalNp);
        const lossMo = val(lk)/WINDOW_DAYS*30;
        rows.push({
          key:`${a.id}|${inv.name}`, site:a.name, region:a.region, host:a.host, vendor:a.vendor,
          inv:inv.name, model:inv.model, nameplate:inv.nameplate_kw, status:inv.status,
          sev:SEV[inv.status], pi:inv.peer_index, stale:inv.stale_hours,
          lossMo, lossYr:lossMo*12, lostKwh:lk, windowKwh:inv.window_kwh,
        });
      });
    });
    const flagged = rows.length;
    const riskMo = rows.reduce((t,r)=>t+r.lossMo,0);
    return {
      rows, recovered:fleet.recovered_ytd||0, simulated:fleet.simulated,
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
  function loadWf(){ try { return JSON.parse(localStorage.getItem(STATE_KEY))||{}; } catch(e){ return {}; } }
  function saveWf(m){ try { localStorage.setItem(STATE_KEY, JSON.stringify(m)); } catch(e){} }
  let WF = loadWf();
  const wfState = key => WF[key] || "new";

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
  function host(){ return document.getElementById("commandCenter"); }

  function render(){
    const h = host(); if(!h || !MODEL) return;
    const q = document.getElementById("ccQueue");
    const k = MODEL.kpis;
    const regions = ["all", ...Array.from(new Set(MODEL.rows.map(r=>r.region))).filter(x=>x&&x!=="—").sort()];
    const simNote = MODEL.simulated
      ? `Simulated 100-array portfolio — sign in to load your live fleet.`
      : `Live from your connected arrays.`;

    h.innerHTML = `
      <div class="cc-head">
        <div>
          <h2>Portfolio command center</h2>
          <div class="cc-sub">${esc(simNote)}</div>
        </div>
        <div class="cc-asof"><b>●</b> updated just now</div>
      </div>

      <div class="cc-kpis">
        <div class="cc-kpi"><div class="k">Sites</div><div class="v">${num(k.sites)}</div><div class="s">arrays under management</div></div>
        <div class="cc-kpi"><div class="k">Inverters</div><div class="v">${num(k.inverters)}</div><div class="s">monitored across the fleet</div></div>
        <div class="cc-kpi healthy"><div class="k">Healthy</div><div class="v">${k.healthyPct}%</div>
          <div class="cc-meter"><i style="width:${k.healthyPct}%"></i></div></div>
        <div class="cc-kpi risk"><div class="k">At risk / mo</div><div class="v">${usd0(k.riskMo)}</div><div class="s">leaking right now</div></div>
        <div class="cc-kpi flagged"><div class="k">Flagged now</div><div class="v">${num(k.flagged)}</div><div class="s">${k.crit} critical · ${k.flagged-k.crit} watch</div></div>
        <div class="cc-kpi recovered"><div class="k">Recovered YTD</div><div class="v">${usd0(MODEL.recovered)}</div><div class="s">claims & fixes you've banked</div></div>
      </div>`;

    // the triage queue (toolbar + table + foot) renders into its own container
    // below the fleet tree — gracefully no-op if that container isn't present.
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
      <div class="cc-foot">Showing flagged inverters only — the ${num(k.inverters-k.flagged)} healthy units are hidden by design. Verdicts are peer-measured: each inverter weighed against its neighbors under the same sky, so weather cancels out. $ figures estimate at ${usd0(ENERGY_RATE).replace("$","$0").slice(0,5)}/kWh + ${REC_PER_MWH}/MWh RECs.</div>`;

    renderBody();
    wire();
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
        <tr class="row ${sel?"sel":""}" data-key="${esc(r.key)}">
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
      : r.status==="dead"
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> has produced <b>zero</b> for ~${r.stale!=null?Math.round(r.stale/24):"a few"} days while ${peers} kept producing — that rules out weather. Warranty claim is ready with the fault dates and peer-measured lost-kWh evidence.`
      : r.status==="fault"
      ? `<b>${esc(r.inv)}</b> at <b>${esc(r.site)}</b> is throwing a hardware fault and running at a fraction of ${peers}. Service request drafted with the evidence attached.`
      : `Over ${WINDOW_DAYS} days, <b>${esc(r.inv)}</b> made only <b>${r.pi!=null?Math.round(r.pi*100):"—"}%</b> of its fair share vs ${peers} under the same sky. That <b>${r.pi!=null?Math.round((1-r.pi)*100):"—"}% shortfall</b> is the unit — likely shading, soiling, or a tired string.`;
    const rec = r.status==="comm_gap"
      ? `Power-cycle the inverter's gateway / data logger and confirm it rejoins. No telemetry within a day → escalate to a site visit.`
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
          </div>
        </div>
      </div></td></tr>`;
  }

  /* ===========================================================================
   * 4. WIRING
   * ==========================================================================*/
  function wire(){
    const q = document.getElementById("ccQ");
    if(q) q.oninput = () => { UI.q = q.value; renderBody(); };
    const sev = document.getElementById("ccSev");
    if(sev) sev.querySelectorAll(".cc-chip").forEach(c => c.onclick = () => { UI.sev=c.dataset.sev; UI.expanded=null; render(); });
    const region = document.getElementById("ccRegion");
    if(region) region.onchange = () => { UI.region=region.value; UI.expanded=null; render(); };
    document.querySelectorAll("#ccQueue th.sortable").forEach(th => th.onclick = () => {
      const col = th.dataset.sort;
      if(UI.sort===col) UI.dir*=-1; else { UI.sort=col; UI.dir = col==="site"?1:-1; }
      render();
    });
    const all = document.getElementById("ccAll");
    if(all) all.onchange = () => {
      const rows = filteredRows();
      if(all.checked) rows.forEach(r=>UI.selected.add(r.key)); else rows.forEach(r=>UI.selected.delete(r.key));
      render();
    };
    const bc = document.getElementById("ccBulkClaim"); if(bc) bc.onclick = bulkClaim;
    const bx = document.getElementById("ccBulkClear"); if(bx) bx.onclick = () => { UI.selected.clear(); render(); };
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
      // refresh bulk bar + row highlight without collapsing the drawer
      render();
    });
    document.querySelectorAll("#ccBody [data-do]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      const key=b.dataset.key, act=b.dataset.do;
      const r = MODEL.rows.find(x=>x.key===key);
      if(act==="claim"){ openClaim(r); WF[key]="progress"; saveWf(WF); }
      else if(act==="progress"){ WF[key]="progress"; saveWf(WF); }
      else if(act==="snooze"){ WF[key]="snoozed"; saveWf(WF); }
      render();
    });
  }

  function bulkClaim(){
    const keys=[...UI.selected];
    const claimable = keys.map(k=>MODEL.rows.find(r=>r.key===k)).filter(r=>r&&(r.status==="dead"||r.status==="fault"));
    keys.forEach(k=>{ WF[k]="progress"; }); saveWf(WF);
    toast(`${keys.length} item${keys.length===1?"":"s"} moved to In progress${claimable.length?` · opening ${claimable.length} claim${claimable.length===1?"":"s"}`:""}.`);
    if(claimable.length) openClaim(claimable[0]);
    UI.selected.clear(); render();
  }

  // lightweight mailto claim (self-contained; the per-site sandbox has the full editor)
  function openClaim(r){
    if(!r) return;
    const to = `support@${(r.vendor||"installer").toLowerCase().replace(/[^a-z0-9]/g,"")||"installer"}.com`;
    const subj = `${r.status==="fault"?"Service request":"Warranty claim"} — ${r.model} (${r.site} · ${r.inv})`;
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
   * 5. LOAD
   * ==========================================================================*/
  function load(){
    if(!host()) return;
    const session = getSession();
    if(session){
      fetch("/v1/array-owners/fleet-tree", { headers:{ Authorization:"Bearer "+session } })
        .then(r => { if(!r.ok) throw 0; return r.json(); })
        .then(t => { MODEL = buildModel((t.columns&&t.columns.length)?adaptTree(t):simulateFleet()); render(); })
        .catch(() => { MODEL = buildModel(simulateFleet()); render(); });
    } else {
      MODEL = buildModel(simulateFleet());
      render();
    }
  }

  window.__ccLoad = load;
  if(document.readyState!=="loading") load();
  else document.addEventListener("DOMContentLoaded", load);
})();
