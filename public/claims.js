/* ============================================================================
 * Array Operator — Automatic Warranty Claims (claims.js)
 *
 * The product promise, made literal: "not a dashboard — an agent that watches
 * your panels and brings the verdict AND the paperwork." This is the paperwork
 * arm. The agent watches the fleet (via FleetStore), and the moment an inverter
 * goes DEAD or throws a hardware FAULT — the two warrantable failures — it
 * AUTOMATICALLY opens a warranty claim: drafts the manufacturer email, attaches
 * the peer-measured evidence (so weather can't be blamed), and moves it through
 * a lifecycle pipeline you watch and control:
 *
 *     Drafted (ready) ──▶ Sent ──▶ Resolved ($ recovered)
 *
 * SEND POLICY — full control from the owner's end (per Ford):
 *   • Review & approve  — agent drafts, you click to send. Nothing leaves on its
 *                         own. (default)
 *   • Auto-send         — agent files the claim the instant it's confirmed.
 *   • Auto-send + grace — agent queues it and sends after N hours unless you
 *                         cancel. The safety net with the leverage.
 * The mode is a global default AND overridable per-claim, so a single high-value
 * claim can be held back (or fast-tracked) without changing the policy.
 *
 * This module is self-contained: it READS the canonical fleet from FleetStore
 * and persists its own claim ledger to localStorage, so it can't destabilise the
 * live Arrays view. In a signed-in/live deployment the lifecycle transitions
 * also POST to the shared backend (optimistic; best-effort).
 * ==========================================================================*/
(function(){
  "use strict";

  /* ---- value model: mirrors command-center.js / app.js ---- */
  const ENERGY_RATE = 0.21;      // $/kWh blended offset
  const REC_PER_MWH = 38;        // $/MWh REC value
  const WINDOW_DAYS = 14;
  const val  = kwh => kwh*ENERGY_RATE + (kwh/1000)*REC_PER_MWH;
  const usd0 = n => "$"+Math.round(Number(n)||0).toLocaleString();
  const num  = n => Number(n||0).toLocaleString();
  const esc  = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));

  const SESSION_KEY  = "so_session";
  const CLAIMS_KEY   = "ao_claims";            // {key: claim}
  const SETTINGS_KEY = "ao_claims_settings";   // {sendMode, graceHours}
  const getSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } };
  const isLive = () => !!getSession();
  const now = () => Date.now();

  /* ===========================================================================
   * 0. PERSISTED STATE — the claim ledger + the owner's send policy
   * ==========================================================================*/
  function loadClaims(){ try { return JSON.parse(localStorage.getItem(CLAIMS_KEY)) || {}; } catch(e){ return {}; } }
  function saveClaims(){ try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(CLAIMS)); } catch(e){} }
  function loadSettings(){
    try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if(s && s.sendMode) return s; } catch(e){}
    return { sendMode:"manual", graceHours:24 };
  }
  function saveSettings(){ try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch(e){} }

  let CLAIMS   = loadClaims();
  let SETTINGS = loadSettings();

  const SEND_MODE_LABEL = {
    manual:"Review & approve",
    auto:"Auto-send on detection",
    delay:"Auto-send after grace period",
  };
  // effective mode for a claim = its override, else the global default
  const effMode = c => (c.mode || SETTINGS.sendMode);

  /* ===========================================================================
   * 1. EVIDENCE + DRAFT — peer-measured, manufacturer-ready
   * ==========================================================================*/
  function lostKwh(inv, fleetWindowKwh, totalNameplate){
    const fair = (inv.nameplate_kw||0)/totalNameplate*fleetWindowKwh;
    return Math.max(0, fair - (inv.window_kwh||0));     // dead/fault → almost the whole fair share
  }

  // build the immutable evidence snapshot captured at the moment of detection
  function buildEvidence(inv, arr){
    const totalNp  = arr.inverters.reduce((t,i)=>t+(i.nameplate_kw||0),0) || 1;
    const fleetWin = arr.inverters.reduce((t,i)=>t+(i.window_kwh||0),0);
    const lk    = lostKwh(inv, fleetWin, totalNp);
    const lostMo = val(lk)/WINDOW_DAYS*30;
    const peers = arr.inverters.filter(i=>i!==inv).length;
    const daysDown = inv.stale_hours!=null ? Math.round(inv.stale_hours/24) : null;
    return {
      peerIndex: inv.peer_index!=null ? Math.round(inv.peer_index*100)/100 : null,
      lostKwh: Math.round(lk), lostMo, lostYr: lostMo*12,
      daysDown, peers, windowDays: WINDOW_DAYS,
    };
  }

  function buildDraft(c){
    const isFault = c.failType==="fault";
    const vendorTitle = (c.vendor||"manufacturer").replace(/\b\w/g, ch=>ch.toUpperCase());
    const to = `support@${(c.vendor||"installer").toLowerCase().replace(/[^a-z0-9]/g,"")||"installer"}.com`;
    const subject = `${isFault?"Service request":"Warranty claim"} — ${c.model} (${c.site} · ${c.inv})`;
    const e = c.evidence;
    const downLine = e.daysDown!=null
      ? `It has produced no usable output for approximately ${e.daysDown} day(s).`
      : `It has stopped producing.`;
    const body =
`To whom it may concern,

I am ${isFault?"requesting service for":"filing a warranty claim on"} the following inverter on my solar array "${c.site}":

  • Inverter:        ${c.inv}
  • Model:           ${c.model}${c.nameplate?` (${c.nameplate} kW nameplate)`:""}
  • Manufacturer:    ${vendorTitle}
  • Reported status: ${isFault?"HARDWARE FAULT":"DEAD / not reporting"}

Issue:
${downLine}

Evidence (independently measured against ${e.peers} peer inverter${e.peers===1?"":"s"} on the same array, under identical weather):
  • Peer index:            ${e.peerIndex!=null?e.peerIndex.toFixed(2):"—"} (1.00 = fair share; this unit is far below par)
  • Estimated lost output: ${num(e.lostKwh)} kWh over the last ${e.windowDays} days
  • Estimated lost value:   ${usd0(e.lostMo)} so far this month (at ${val(1).toFixed(2)}/kWh offset incl. RECs)

The neighboring inverters produced normally over the same period, which rules out weather or shading as the cause. Please advise on next steps for repair or replacement under warranty.

Thank you,
[Your name]
[Site address / system ID]`;
    return { to, subject, body };
  }

  /* ===========================================================================
   * 2. THE ENGINE — reconcile the ledger against the live fleet every beat
   *
   * • A dead/fault inverter with no claim  → OPEN one (auto-draft, apply policy).
   * • A claim whose inverter recovered     → CLOSE it (auto-resolve if it had been
   *   filed; otherwise mark it cleared — the agent caught a blip, no paperwork
   *   needed). The owner can always reopen.
   * ==========================================================================*/
  function reconcile(){
    const snap = FleetStore.snapshot();
    const live = new Map();                     // key → {inv, arr}
    snap.arrays.forEach(a => a.inverters.forEach(inv => {
      if(inv.status==="dead" || inv.status==="fault"){
        live.set(`${a.id}|${inv.name}`, { inv, arr:a });
      }
    }));

    let changed = false;

    // open new claims for freshly-failed inverters
    live.forEach((hit, key) => {
      if(CLAIMS[key] && CLAIMS[key].stage!=="cleared") return;   // already tracked
      const { inv, arr } = hit;
      const c = {
        key, arrayId:arr.id, site:arr.name, region:arr.region||"—", host:arr.host||"",
        vendor:arr.vendor||"solaredge",
        inv:inv.name, model:inv.model, nameplate:inv.nameplate_kw,
        failType: inv.status,
        evidence: buildEvidence(inv, arr),
        mode:"",                                 // inherit global default
        stage:"ready", createdAt:now(),
        sendAt:null, sentAt:null, sentVia:null, resolvedAt:null, recoveredUsd:0,
      };
      c.draft = buildDraft(c);
      applyPolicy(c);                            // ready → queued/sent per the owner's mode
      CLAIMS[key] = c; changed = true;
    });

    // close claims whose underlying inverter is healthy again / gone
    Object.values(CLAIMS).forEach(c => {
      if(c.stage==="resolved" || c.stage==="dismissed" || c.stage==="cleared") return;
      if(live.has(c.key)) return;                // still failed → leave the claim open
      if(c.stage==="sent"){                      // we'd filed it; the fix landed → bank it
        c.stage="resolved"; c.resolvedAt=now();
        c.recoveredUsd = Math.round(c.evidence.lostYr || c.evidence.lostMo*12 || 0);
        c.autoResolved = true;
      } else {                                   // never filed → the agent caught a blip
        c.stage="cleared"; c.clearedAt=now();
      }
      changed = true;
    });

    if(changed) persistAndPaint();
  }

  // place a freshly-opened (or re-activated) claim per the effective send policy
  function applyPolicy(c){
    const mode = effMode(c);
    if(mode==="auto"){ fileClaim(c, "auto"); }
    else if(mode==="delay"){ c.stage="queued"; c.sendAt = now() + (SETTINGS.graceHours||24)*3600*1000; }
    else { c.stage="ready"; c.sendAt=null; }
  }

  // tick queued claims whose grace window has elapsed
  function tickQueue(){
    let changed=false;
    Object.values(CLAIMS).forEach(c => {
      if(c.stage==="queued" && c.sendAt && now()>=c.sendAt){ fileClaim(c, "auto"); changed=true; }
    });
    if(changed) persistAndPaint();
  }

  /* ===========================================================================
   * 3. LIFECYCLE TRANSITIONS — every one the owner (or the agent) can make
   * ==========================================================================*/
  // file the claim with the manufacturer. via: "auto" (agent) | "owner" (approved).
  function fileClaim(c, via){
    c.stage="sent"; c.sentAt=now(); c.sentVia=via||"owner"; c.sendAt=null;
    if(isLive()) backend("/v1/array-owners/claims/send", { key:c.key, draft:c.draft });
  }
  function resolveClaim(c, recoveredUsd){
    c.stage="resolved"; c.resolvedAt=now(); c.autoResolved=false;
    c.recoveredUsd = recoveredUsd!=null ? Math.round(recoveredUsd) : Math.round(c.evidence.lostYr||0);
    if(isLive()) backend("/v1/array-owners/claims/resolve", { key:c.key, recovered:c.recoveredUsd });
  }
  function dismissClaim(c){ c.stage="dismissed"; c.dismissedAt=now(); }
  function reopenClaim(c){
    c.recoveredUsd=0; c.resolvedAt=null; c.sentAt=null; c.sentVia=null; c.dismissedAt=null;
    applyPolicy(c);                              // back to ready/queued/sent per policy
  }
  function cancelAutoSend(c){ c.mode="manual"; c.stage="ready"; c.sendAt=null; }   // hold this one back
  function setClaimMode(c, mode){
    c.mode = mode;
    if(c.stage==="ready" || c.stage==="queued") applyPolicy(c);   // re-place under the new rule
  }

  function backend(path, body){
    const s = getSession(); if(!s) return;
    fetch(path, { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+s },
      body: JSON.stringify(body||{}) }).catch(()=>{});
  }

  function persistAndPaint(){ saveClaims(); render(); }

  /* ===========================================================================
   * 4. DERIVED — pipeline buckets + KPIs
   * ==========================================================================*/
  const ACTIVE = c => c.stage==="ready" || c.stage==="queued" || c.stage==="sent";
  function buckets(){
    const all = Object.values(CLAIMS);
    return {
      ready:    all.filter(c => c.stage==="ready" || c.stage==="queued")
                   .sort((a,b)=> (b.evidence.lostYr||0)-(a.evidence.lostYr||0)),
      sent:     all.filter(c => c.stage==="sent").sort((a,b)=> (b.sentAt||0)-(a.sentAt||0)),
      resolved: all.filter(c => c.stage==="resolved").sort((a,b)=> (b.resolvedAt||0)-(a.resolvedAt||0)),
      dismissed:all.filter(c => c.stage==="dismissed"),
    };
  }
  function kpis(){
    const all = Object.values(CLAIMS);
    return {
      open:     all.filter(ACTIVE).length,
      awaiting: all.filter(c => c.stage==="ready").length,
      queued:   all.filter(c => c.stage==="queued").length,
      sent:     all.filter(c => c.stage==="sent").length,
      atStake:  all.filter(ACTIVE).reduce((t,c)=>t+(c.evidence.lostYr||0),0),
      recovered:all.filter(c=>c.stage==="resolved").reduce((t,c)=>t+(c.recoveredUsd||0),0),
      resolved: all.filter(c=>c.stage==="resolved").length,
    };
  }

  /* ===========================================================================
   * 5. RENDER
   * ==========================================================================*/
  let showDismissed = false;
  function host(){ return document.getElementById("claimsRoot"); }

  function render(){
    const h = host(); if(!h) return;
    const k = kpis();
    const b = buckets();
    const liveNote = FleetStore.snapshot().simulated
      ? "Simulated portfolio — sign in to file claims against your live fleet."
      : "Watching your connected arrays live.";

    h.innerHTML = `
      <div class="cl-head">
        <div>
          <h2>Automatic warranty claims</h2>
          <div class="cl-sub">Your agent opens a claim the moment an inverter dies — peer-measured evidence attached, so weather can't be blamed. ${esc(liveNote)}</div>
        </div>
      </div>

      ${policyBar(k)}

      <div class="cl-kpis">
        <div class="cl-kpi"><div class="k">Open claims</div><div class="v">${num(k.open)}</div><div class="s">${k.awaiting} awaiting you · ${k.sent} filed</div></div>
        <div class="cl-kpi atstake"><div class="k">$ at stake / yr</div><div class="v">${usd0(k.atStake)}</div><div class="s">across all open claims</div></div>
        <div class="cl-kpi queued"><div class="k">Auto-queued</div><div class="v">${num(k.queued)}</div><div class="s">sending on the grace timer</div></div>
        <div class="cl-kpi recovered"><div class="k">Recovered</div><div class="v">${usd0(k.recovered)}</div><div class="s">${k.resolved} claim${k.resolved===1?"":"s"} banked</div></div>
      </div>

      <div class="cl-board">
        ${column("Ready to file", "ready", b.ready, "Drafted by your agent — peer-evidence attached")}
        ${column("Filed", "sent", b.sent, "With the manufacturer, awaiting repair")}
        ${column("Resolved", "resolved", b.resolved, "Fixed — value recovered")}
      </div>

      ${b.dismissed.length ? `
        <div class="cl-dismissed">
          <button class="cl-disc-toggle" id="clDismToggle">${showDismissed?"▾":"▸"} Dismissed (${b.dismissed.length})</button>
          ${showDismissed ? `<div class="cl-disc-list">${b.dismissed.map(c=>dismissedRow(c)).join("")}</div>` : ""}
        </div>` : ""}

      <div class="cl-foot">Claims open automatically for the two warrantable failures — an inverter that has <b>died</b> or thrown a <b>hardware fault</b>. Underperformance and comms gaps are handled as diagnoses in the Arrays triage queue, not warranty claims. $ figures estimate the annualised loss at ${val(1).toFixed(2)}/kWh (offset + RECs).</div>
    `;
    wire();
  }

  function policyBar(k){
    const sm = SETTINGS.sendMode;
    return `
      <div class="cl-policy">
        <div class="cl-policy-l">
          <span class="cl-policy-icon">⚙</span>
          <div>
            <div class="cl-policy-t">Send policy</div>
            <div class="cl-policy-d">${policyDesc()}</div>
          </div>
        </div>
        <div class="cl-policy-r">
          <div class="cl-seg" id="clModeSeg">
            ${segBtn("manual","Review &amp; approve", sm)}
            ${segBtn("delay","Auto-send + grace", sm)}
            ${segBtn("auto","Auto-send", sm)}
          </div>
          <label class="cl-grace ${sm==="delay"?"on":""}">
            grace <input type="number" id="clGrace" min="1" max="168" value="${SETTINGS.graceHours}"> h
          </label>
        </div>
      </div>`;
  }
  function segBtn(id,label,cur){ return `<button class="cl-segbtn ${cur===id?"on":""}" data-mode="${id}">${label}</button>`; }
  function policyDesc(){
    if(SETTINGS.sendMode==="auto") return "The agent files every confirmed claim immediately. You stay in control — hold back or reopen any one.";
    if(SETTINGS.sendMode==="delay") return `The agent queues each claim and files it after ${SETTINGS.graceHours}h unless you cancel. Cancel any one before it sends.`;
    return "The agent drafts every claim and waits for your one-click approval. Nothing leaves on its own.";
  }

  function column(title, kind, list, blurb){
    const body = list.length
      ? list.map(c => card(c, kind)).join("")
      : `<div class="cl-col-empty">${kind==="ready"?"Nothing waiting — your fleet's clean. 🌞":kind==="sent"?"No open filings.":"Nothing recovered yet."}</div>`;
    return `
      <div class="cl-col ${kind}">
        <div class="cl-col-h"><span class="cl-col-t">${title}</span><span class="cl-col-n">${list.length}</span></div>
        <div class="cl-col-blurb">${blurb}</div>
        <div class="cl-col-body">${body}</div>
      </div>`;
  }

  function failBadge(c){
    return c.failType==="fault"
      ? `<span class="cl-badge fault">Hardware fault</span>`
      : `<span class="cl-badge dead">Stopped earning</span>`;
  }
  function evidenceChips(c){
    const e = c.evidence;
    return `<div class="cl-chips">
      <span class="cl-chip"><b>${e.peerIndex!=null?e.peerIndex.toFixed(2):"—"}</b> peer index</span>
      <span class="cl-chip"><b>${num(e.lostKwh)}</b> kWh lost</span>
      <span class="cl-chip risk"><b>${usd0(e.lostYr)}</b>/yr at stake</span>
    </div>`;
  }
  function graceLeft(c){
    if(c.stage!=="queued"||!c.sendAt) return "";
    const ms = c.sendAt - now();
    if(ms<=0) return "sending…";
    const h = Math.floor(ms/3600000), m = Math.round((ms%3600000)/60000);
    return h>=1 ? `sends in ${h}h ${m}m` : `sends in ${m}m`;
  }

  function card(c, kind){
    const k = esc(c.key);
    const ovr = c.mode ? `<span class="cl-ovr" title="Per-claim override">${SEND_MODE_LABEL[c.mode]}</span>` : "";
    let foot = "";
    if(kind==="ready"){
      if(c.stage==="queued"){
        foot = `
          <div class="cl-queued">⏱ ${graceLeft(c)}</div>
          <div class="cl-acts">
            <button class="cl-btn primary" data-do="sendnow" data-key="${k}">Send now</button>
            <button class="cl-btn ghost" data-do="cancel" data-key="${k}">Cancel auto-send</button>
            <button class="cl-btn ghost" data-do="view" data-key="${k}">View draft</button>
            ${moreMenu(c)}
          </div>`;
      } else {
        foot = `
          <div class="cl-acts">
            <button class="cl-btn primary" data-do="approve" data-key="${k}">Approve &amp; send</button>
            <button class="cl-btn ghost" data-do="view" data-key="${k}">View / edit draft</button>
            ${moreMenu(c)}
          </div>`;
      }
    } else if(kind==="sent"){
      const via = c.sentVia==="auto" ? "filed automatically" : "you approved";
      foot = `
        <div class="cl-meta">Filed ${ago(c.sentAt)} · ${via}</div>
        <div class="cl-acts">
          <button class="cl-btn primary" data-do="resolve" data-key="${k}">Mark resolved</button>
          <button class="cl-btn ghost" data-do="view" data-key="${k}">View draft</button>
          <button class="cl-btn ghost" data-do="reopen" data-key="${k}">Reopen</button>
        </div>`;
    } else { // resolved
      foot = `
        <div class="cl-recovered">＋${usd0(c.recoveredUsd)} recovered${c.autoResolved?" · auto-detected fix":""}</div>
        <div class="cl-acts">
          <button class="cl-btn ghost" data-do="reopen" data-key="${k}">Reopen</button>
        </div>`;
    }
    return `
      <div class="cl-card ${c.failType}">
        <div class="cl-card-h">
          <div class="cl-card-id"><b>${esc(c.site)}</b> · ${esc(c.inv)}</div>
          ${failBadge(c)}
        </div>
        <div class="cl-card-sub">${esc(c.model)}${c.nameplate?` · ${c.nameplate} kW`:""}${c.host?` · ${esc(c.host)}`:""} ${ovr}</div>
        ${evidenceChips(c)}
        ${foot}
      </div>`;
  }

  function moreMenu(c){
    const k = esc(c.key);
    return `
      <div class="cl-more">
        <button class="cl-btn ghost cl-more-btn" data-key="${k}">⋯</button>
        <div class="cl-menu" data-key="${k}" hidden>
          <div class="cl-menu-h">Send rule for this claim</div>
          ${["manual","delay","auto"].map(m=>`<button class="cl-menu-i ${effMode(c)===m?"on":""}" data-do="mode" data-mode="${m}" data-key="${k}">${SEND_MODE_LABEL[m]}</button>`).join("")}
          <div class="cl-menu-sep"></div>
          <button class="cl-menu-i danger" data-do="dismiss" data-key="${k}">Dismiss claim</button>
        </div>
      </div>`;
  }

  function dismissedRow(c){
    return `<div class="cl-disc-row">
      <span><b>${esc(c.site)}</b> · ${esc(c.inv)} — ${esc(c.model)}</span>
      <button class="cl-btn ghost" data-do="restore" data-key="${esc(c.key)}">Restore</button>
    </div>`;
  }

  function ago(t){
    if(!t) return "just now";
    const s = Math.max(0, Math.round((now()-t)/1000));
    if(s<60) return "just now";
    const m=Math.round(s/60); if(m<60) return m+"m ago";
    const h=Math.round(m/60); if(h<24) return h+"h ago";
    return Math.round(h/24)+"d ago";
  }

  /* ===========================================================================
   * 6. WIRING
   * ==========================================================================*/
  function wire(){
    // send-policy segmented control
    const seg = document.getElementById("clModeSeg");
    if(seg) seg.querySelectorAll(".cl-segbtn").forEach(btn => btn.onclick = () => {
      SETTINGS.sendMode = btn.dataset.mode; saveSettings();
      // re-place every still-pending claim under the new default (those without an override)
      Object.values(CLAIMS).forEach(c => { if(!c.mode && (c.stage==="ready"||c.stage==="queued")) applyPolicy(c); });
      persistAndPaint();
      toast(`Send policy: ${SEND_MODE_LABEL[SETTINGS.sendMode]}.`);
    });
    const grace = document.getElementById("clGrace");
    if(grace) grace.onchange = () => {
      const v = Math.max(1, Math.min(168, parseInt(grace.value,10)||24));
      SETTINGS.graceHours = v; saveSettings();
      Object.values(CLAIMS).forEach(c => { if(!c.mode && c.stage==="queued") applyPolicy(c); });
      persistAndPaint();
    };

    const dt = document.getElementById("clDismToggle");
    if(dt) dt.onclick = () => { showDismissed=!showDismissed; render(); };

    // per-claim actions (event-delegated through each button)
    host().querySelectorAll("[data-do]").forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const c = CLAIMS[btn.dataset.key]; if(!c && btn.dataset.do!=="mode") return;
      act(btn.dataset.do, c, btn);
    });
    // ⋯ menus
    host().querySelectorAll(".cl-more-btn").forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const menu = host().querySelector(`.cl-menu[data-key="${cssEsc(btn.dataset.key)}"]`);
      host().querySelectorAll(".cl-menu").forEach(m => { if(m!==menu) m.hidden=true; });
      if(menu) menu.hidden = !menu.hidden;
    });
  }
  // close any open ⋯ menu on outside click
  document.addEventListener("click", e => {
    if(e.target.closest && e.target.closest(".cl-more")) return;
    const h = host(); if(h) h.querySelectorAll(".cl-menu").forEach(m => m.hidden=true);
  });
  const cssEsc = s => String(s).replace(/["\\]/g, "\\$&");

  function act(doWhat, c, btn){
    switch(doWhat){
      case "approve":  fileClaim(c, "owner"); toast(`Claim filed for ${c.site} · ${c.inv}.`); openMail(c); break;
      case "sendnow":  fileClaim(c, "owner"); toast(`Sent now — ${c.site} · ${c.inv}.`); openMail(c); break;
      case "cancel":   cancelAutoSend(c); toast("Auto-send cancelled — held for your approval."); break;
      case "view":     openDraftModal(c); return;        // modal handles its own re-render
      case "resolve":  promptResolve(c); return;
      case "reopen":   reopenClaim(c); toast("Claim reopened."); break;
      case "dismiss":  dismissClaim(c); toast("Claim dismissed."); break;
      case "restore":  reopenClaim(c); toast("Claim restored."); break;
      case "mode":     setClaimMode(c, btn.dataset.mode); toast(`This claim: ${SEND_MODE_LABEL[btn.dataset.mode]}.`); break;
      default: return;
    }
    persistAndPaint();
  }

  // open the user's mail client with the draft (the real-world send path)
  function openMail(c){
    const d = c.draft;
    const href = `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
    try { window.open(href, "_blank"); } catch(e){}
  }

  /* ===========================================================================
   * 7. DRAFT MODAL — view / edit / send a single claim's paperwork
   * ==========================================================================*/
  function openDraftModal(c){
    const d = c.draft;
    const back = document.createElement("div"); back.className="cl-modal-back";
    back.innerHTML = `
      <div class="cl-modal" role="dialog" aria-label="Warranty claim draft">
        <div class="cl-modal-h">
          <div>
            <h3>${c.failType==="fault"?"Service request":"Warranty claim"} — ${esc(c.site)} · ${esc(c.inv)}</h3>
            <div class="cl-modal-sub">${esc(c.model)} · evidence below is locked to detection-time</div>
          </div>
          <button class="cl-x" aria-label="Close">✕</button>
        </div>
        <div class="cl-modal-body">
          ${evidenceChips(c)}
          <label class="cl-fld"><span>To (manufacturer / installer)</span>
            <input id="clTo" type="text" value="${esc(d.to)}"></label>
          <label class="cl-fld"><span>Subject</span>
            <input id="clSubj" type="text" value="${esc(d.subject)}"></label>
          <label class="cl-fld"><span>Body</span>
            <textarea id="clBody" rows="15">${esc(d.body)}</textarea></label>
          <div class="cl-modal-note" id="clNote"></div>
        </div>
        <div class="cl-modal-foot">
          <button class="cl-btn ghost" id="clCopy">Copy to clipboard</button>
          <span class="cl-modal-spacer"></span>
          ${c.stage==="ready"||c.stage==="queued"
            ? `<button class="cl-btn primary" id="clSend">Approve &amp; send</button>`
            : `<button class="cl-btn ghost" id="clMail">Open in email</button>`}
        </div>
      </div>`;
    document.body.appendChild(back);
    const q = sel => back.querySelector(sel);
    const note = q("#clNote");
    const sync = () => { d.to=q("#clTo").value; d.subject=q("#clSubj").value; d.body=q("#clBody").value; saveClaims(); };
    [ "#clTo","#clSubj","#clBody" ].forEach(s => q(s).oninput = sync);
    const close = () => back.remove();
    q(".cl-x").onclick = close;
    back.onclick = e => { if(e.target===back) close(); };
    document.addEventListener("keydown", function onEsc(ev){ if(ev.key==="Escape"){ close(); document.removeEventListener("keydown", onEsc); } });
    q("#clCopy").onclick = async () => {
      sync();
      const text = `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body}`;
      try { await navigator.clipboard.writeText(text); note.textContent="Copied — paste it into your email client."; note.className="cl-modal-note ok"; }
      catch(e){ const ta=q("#clBody"); ta.focus(); ta.select(); note.textContent="Couldn't auto-copy — the draft is selected, press Ctrl/⌘-C."; note.className="cl-modal-note err"; }
    };
    const mail = q("#clMail"); if(mail) mail.onclick = () => { sync(); openMail(c); note.textContent="Opening your email client…"; note.className="cl-modal-note ok"; };
    const send = q("#clSend"); if(send) send.onclick = () => { sync(); fileClaim(c,"owner"); openMail(c); toast(`Claim filed for ${c.site} · ${c.inv}.`); close(); persistAndPaint(); };
  }

  // quick resolve prompt — confirm the recovered value before banking it
  function promptResolve(c){
    const def = Math.round(c.evidence.lostYr||0);
    const v = window.prompt(`Mark this claim resolved.\n\nValue recovered (annualised $ this fix returns to you):`, String(def));
    if(v===null) return;                 // cancelled
    const amt = Math.max(0, Math.round(parseFloat(String(v).replace(/[^0-9.]/g,""))||0));
    resolveClaim(c, amt);
    toast(`Recovered ${usd0(amt)} — banked.`);
    persistAndPaint();
  }

  /* ===========================================================================
   * 8. TOAST (shared visual language with the command center)
   * ==========================================================================*/
  function toast(msg){
    let t=document.getElementById("ccToast");
    if(!t){ t=document.createElement("div"); t.id="ccToast";
      t.setAttribute("style","position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9998;background:#0e1620;border:1px solid var(--line);color:var(--ink);padding:11px 16px;border-radius:11px;font-size:13px;box-shadow:0 14px 40px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;");
      document.body.appendChild(t); }
    t.textContent=msg; t.style.opacity="1";
    clearTimeout(t._tm); t._tm=setTimeout(()=>t.style.opacity="0",3200);
  }

  /* ===========================================================================
   * 9. LIFECYCLE — load, subscribe to the fleet, tick the queue + grace labels
   * ==========================================================================*/
  function boot(){
    if(!host()) return;
    if(FleetStore.isLoaded()) reconcile(); else FleetStore.load();
    render();
  }
  if(window.FleetStore){
    FleetStore.subscribe((s, kind) => {
      if(kind==="live"){                  // a heartbeat: just refresh grace countdowns if visible
        if(host() && document.querySelector(".cl-queued")) render();
        return;
      }
      reconcile();                        // load / fleet / triage / focus → re-check the ledger
    });
    setInterval(tickQueue, 15000);        // promote queued → sent when the grace timer elapses
    setInterval(() => { if(host() && document.querySelector(".cl-queued")) render(); }, 60000); // tick "sends in …"
  }

  // exposed so the tab system (sandbox.js) can kick a load/paint when Claims opens
  window.__claimsLoad = boot;
})();
