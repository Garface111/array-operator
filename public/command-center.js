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
          key:`${a.id}|${inv.name}`, arrayId:a.id, site:a.name, region:a.region, host:a.host, vendor:a.vendor,
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
        <div class="cc-headmain">
          <h2>Portfolio command center</h2>
          <p class="cc-summary">Managing <b data-kpi="sites">${num(k.sites)}</b> arrays and <b data-kpi="inverters">${num(k.inverters)}</b> inverters — <b class="ok" data-kpi="healthy">${k.healthyPct}%</b> healthy, <b class="warn" data-kpi="flagged">${num(k.flagged)}</b> flagged (<span class="cc-summary-sub" data-kpi="flaggedsub">${k.crit} critical · ${k.flagged-k.crit} watch</span>).</p>
          <div class="cc-sub">${esc(simNote)}</div>
        </div>
        <div class="cc-asof" id="ccAsof">${asofText()}</div>
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
            <button class="cc-btn ghost" data-do="focus" data-key="${esc(r.key)}">Open in fleet tree →</button>
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
  FleetStore.subscribe(onStore);
  // tick the "updated Ns ago" label once a second (cheap, text-only)
  setInterval(() => { const a = document.getElementById("ccAsof"); if(a) a.innerHTML = asofText(); }, 1000);
  if(document.readyState!=="loading") FleetStore.load();
  else document.addEventListener("DOMContentLoaded", FleetStore.load);
})();
