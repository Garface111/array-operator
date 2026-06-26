/* ============================================================================
 * Array Operator — interactivity layer (app.js)
 *
 * NEW DOM injected from JS (appended to <body>) for the design agent to style.
 * All new UI lives inside a single overlay container so it never collides with
 * the index.html structure. New class names introduced here:
 *
 *   .ao-overlay        full-screen modal backdrop (fixed, dim)
 *   .ao-modal          the modal card itself
 *   .ao-modal-head     header row (title + close button)
 *   .ao-modal-title    modal heading
 *   .ao-modal-close    the × close button
 *   .ao-modal-body     scrollable body region
 *   .ao-modal-foot     footer / action-button row
 *   .ao-field          wrapper for a labelled input/textarea
 *   .ao-label          field label
 *   .ao-input          single-line text input (e.g. TO / SUBJECT / API key)
 *   .ao-textarea       multi-line editable email body
 *   .ao-btn            generic button
 *   .ao-btn-primary    primary action button
 *   .ao-btn-ghost      secondary / ghost button
 *   .ao-note           small helper / status note
 *   .ao-note.ok        success state note
 *   .ao-note.err       error state note
 *   .ao-evidence       evidence summary block in the claim modal
 *   .ao-diag-grid      diagnosis stat grid
 *   .ao-diag-stat      one stat tile in the diagnosis modal
 *   .ao-diag-num       big number in a diag stat tile
 *   .ao-diag-cap       caption under a diag number
 *   .ao-causes         likely-causes list
 *   .ao-sites          discovered-sites list
 *   .ao-site           one discovered site row (checkbox + label)
 *   .ao-spark-lg       larger sparkline wrapper inside the diagnosis modal
 *
 * Existing render() data flow + value math (ENERGY_RATE, REC_PER_MWH, val(),
 * invLostKwh(), spark(), STATUS_LABEL, FIX) are preserved unchanged. We only
 * add data-* hooks to the CTAs and wire click handlers via event delegation.
 * ==========================================================================*/

// ---- value model (transparent estimate; backend _value_model is source of truth) ----
// $/kWh comes from FleetStore.energyRate() — the owner's REAL billed rate when
// signed in — so the warranty-email lost-value figure matches what they invoice,
// not a hardcoded $0.21. Falls back to 0.21 for the demo/anon fleet.
const ENERGY_RATE_FALLBACK = 0.21;   // $/kWh blended residential offset (VT-ish)
const REC_PER_MWH = (window.FleetStore && window.FleetStore.REC_PER_MWH) || 38;  // $/MWh REC value
const energyRate = () => (window.FleetStore && window.FleetStore.energyRate) ? window.FleetStore.energyRate() : ENERGY_RATE_FALLBACK;
const val = kwh => kwh*energyRate() + (kwh/1000)*REC_PER_MWH;
const usd = n => n==null ? "—" : "$"+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const usd0 = n => "$"+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
const fmt = n => n==null ? "—" : Number(n).toLocaleString(undefined,{maximumFractionDigits:1});

function spark(daily, color){
  if(!daily || !daily.length) return "";
  const w=300,h=40,max=Math.max(...daily.map(d=>d.kwh),0.001);
  // With a single day of history, daily.length-1 is 0 → x would be 0/0 = NaN (broken SVG).
  // Spread points across the full width, but pin a lone point to the left edge.
  const xAt=(i)=> daily.length>1 ? (i/(daily.length-1))*w : 0;
  const pts=daily.map((d,i)=>`${xAt(i)},${h-3-(d.kwh/max)*(h-8)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${daily.map((d,i)=>d.kwh===0?`<circle cx="${xAt(i)}" cy="${h-3}" r="2.2" fill="var(--bad)"/>`:"").join("")}
  </svg>`;
}

// estimate per-inverter window $ lost: how far below its fair share it ran
function invLostKwh(inv, fleetWindowKwh, totalNameplate){
  if(!inv.peer_index || inv.peer_index>=0.85 || inv.nameplate_kw==null) {
    if(inv.status==="dead"||inv.status==="fault"){ // dead: lost ~ what a healthy peer share would've made
      const fair = (inv.nameplate_kw||0)/totalNameplate*fleetWindowKwh;
      return Math.max(0, fair - (inv.window_kwh||0));
    }
    return 0;
  }
  const fair = (inv.nameplate_kw||0)/totalNameplate*fleetWindowKwh;
  return Math.max(0, fair/Math.max(inv.peer_index,0.01) - (inv.window_kwh||0));
}

// ---- keep last-rendered data so click handlers can look up inverters ----
let CURRENT = null;

function render(data){
  // The below-sandbox dashboard UI (hero, value cards, agent actions, inverter
  // grid, footer) was removed in the sandbox.js refactor — those DOM nodes
  // (#grid, #title, #meta, #todayValue, #actions, #foot, …) no longer exist.
  // We keep this entry point (and CURRENT) only so the data-loading flow can
  // stash the live fleet for the claim/diagnosis modals' fleetContext(). The
  // old render body was dead code (guarded by `if(!#grid) return;`) and has
  // been deleted; the helpers it shared (spark, invLostKwh, val…) live on for
  // the modals.
  CURRENT = data;
}

/* ===========================================================================
 * Reusable modal helper — overlay, Esc + backdrop close, focus restore.
 * openModal({title, bodyHTML, footHTML, onMount}) returns a controller with
 * { close, root } so callers can wire buttons inside onMount.
 * ==========================================================================*/
let _ovl = null;        // shared overlay node
let _escHandler = null;
let _lastFocus = null;

function ensureOverlay(){
  if(_ovl) return _ovl;
  _ovl = document.createElement("div");
  _ovl.className = "ao-overlay";
  _ovl.style.display = "none";
  // minimal inline layout so it's usable even before the designer styles it
  _ovl.setAttribute("style",
    "display:none;position:fixed;inset:0;z-index:9999;background:rgba(10,16,24,.62);"+
    "backdrop-filter:blur(2px);overflow:auto;padding:5vh 16px;");
  document.body.appendChild(_ovl);
  return _ovl;
}

function closeModal(){
  if(!_ovl) return;
  _ovl.style.display = "none";
  _ovl.innerHTML = "";
  if(_escHandler){ document.removeEventListener("keydown", _escHandler); _escHandler=null; }
  if(_lastFocus && _lastFocus.focus){ try{ _lastFocus.focus(); }catch(e){} }
}

function openModal({title, bodyHTML, footHTML, onMount}){
  _lastFocus = document.activeElement;
  const ovl = ensureOverlay();
  ovl.innerHTML =
    `<div class="ao-modal" role="dialog" aria-modal="true" aria-label="${(title||"").replace(/"/g,'&quot;')}"
        style="max-width:680px;margin:0 auto;background:#fff;color:#16202b;border-radius:14px;
               box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden;">
      <div class="ao-modal-head" style="display:flex;align-items:center;justify-content:space-between;
           padding:16px 20px;border-bottom:1px solid rgba(0,0,0,.08);">
        <div class="ao-modal-title" style="font-weight:700;font-size:18px;">${title||""}</div>
        <button class="ao-modal-close" aria-label="Close" type="button"
           style="border:0;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#5a6b7b;">&times;</button>
      </div>
      <div class="ao-modal-body" style="padding:20px;max-height:64vh;overflow:auto;">${bodyHTML||""}</div>
      ${footHTML?`<div class="ao-modal-foot" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;
           padding:14px 20px;border-top:1px solid rgba(0,0,0,.08);background:#f7f9fb;">${footHTML}</div>`:""}
    </div>`;
  ovl.style.display = "block";

  // close wiring: × button, backdrop click, Esc
  ovl.querySelector(".ao-modal-close").onclick = closeModal;
  ovl.onclick = e => { if(e.target === ovl) closeModal(); };
  _escHandler = e => { if(e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", _escHandler);

  const root = ovl.querySelector(".ao-modal");
  if(onMount) onMount(root, closeModal);
  // focus the first sensible control
  const firstFocus = root.querySelector("input,textarea,button.ao-btn-primary,.ao-modal-close");
  if(firstFocus) try{ firstFocus.focus(); }catch(e){}
  return { close: closeModal, root };
}

const esc = s => String(s==null?"":s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;");

// ---- helper math shared by the action modals ----
function fleetContext(){
  const s=CURRENT.summary, invs=CURRENT.inverters;
  const totalNameplate = invs.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;
  return {s, invs, totalNameplate};
}
// count trailing zero-production days in the daily series (the down-streak)
function zeroStreak(daily){
  if(!daily||!daily.length) return 0;
  let n=0;
  for(let i=daily.length-1;i>=0;i--){ if((daily[i].kwh||0)===0) n++; else break; }
  return n;
}

/* ---- 1. WARRANTY / SERVICE CLAIM MODAL ---- */
function openClaimModal(inv){
  const {s, totalNameplate} = fleetContext();
  const lostK = invLostKwh(inv, s.window_kwh, totalNameplate);
  const lostUsd = val(lostK);
  const streak = zeroStreak(inv.daily);
  const hours = inv.stale_hours!=null ? inv.stale_hours : null;
  const daysDown = streak>0 ? streak : (hours!=null ? Math.round(hours/24) : null);
  const isFault = inv.status==="fault";
  const vendorTitle = (inv.vendor||"manufacturer").replace(/\b\w/g,c=>c.toUpperCase());
  const today = new Date().toISOString().slice(0,10);

  const to = `support@${(inv.vendor||"installer").toLowerCase().replace(/[^a-z0-9]/g,"")}.com`;
  const subject = `${isFault?"Service request":"Warranty claim"} — ${inv.model} ${inv.serial}${inv.error_code?` (fault ${inv.error_code})`:""}`;

  const downLine = daysDown!=null
    ? `It has produced ZERO output for ${streak>0?`${streak} consecutive days`:`approximately ${daysDown} day(s)`}${hours!=null?` (last telemetry ${fmt(hours)} hours ago)`:""}.`
    : `It has stopped producing.`;

  const body =
`To whom it may concern,

I am writing to ${isFault?"request service for":"file a warranty claim on"} the following inverter on my solar array "${CURRENT.array.name}":

  • Serial number:   ${inv.serial}
  • Model:           ${inv.model}
  • Manufacturer:    ${vendorTitle}
  • Nameplate:       ${inv.nameplate_kw!=null?inv.nameplate_kw+" kW":"—"}
  • Reported status: ${isFault?"FAULT":"DEAD / not reporting"}${inv.error_code?`\n  • Fault code:      ${inv.error_code}`:""}

Issue:
${inv.diagnosis||"The inverter has stopped producing."}
${downLine}

Evidence (independently measured against ${s.inverters_total-1} peer inverters on the same array, under identical weather):
  • Peer index:            ${inv.peer_index!=null?inv.peer_index.toFixed(2):"—"} (1.00 = fair share; this unit is below par)
  • Production this window: ${fmt(inv.window_kwh)} kWh over ${s.window_days} days
  • Estimated lost output:  ${fmt(lostK)} kWh so far
  • Estimated lost value:   ${usd(lostUsd)} (at ${usd(energyRate())}/kWh offset + ${usd0(REC_PER_MWH)}/MWh RECs)

The neighboring inverters continued to produce normally over the same period, which rules out weather or shading as the cause. Please advise on next steps for repair or replacement under warranty.

Reported: ${today}

Thank you,
[Your name]
[Site address / system ID]
[Phone]`;

  const evidence =
    `<div class="ao-evidence" style="background:#f3f6f9;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5;">
      <b>${esc(inv.serial)}</b> · ${esc(inv.model)} · ${esc(vendorTitle)}<br>
      Status <b>${isFault?"FAULT":"DEAD"}</b>${inv.error_code?` · code <b>${esc(inv.error_code)}</b>`:""}
      ${daysDown!=null?` · down ~<b>${daysDown} day(s)</b>`:""}
      · est. loss so far <b>${usd(lostUsd)}</b>
    </div>`;

  openModal({
    title: isFault ? "Service request — ready to send" : "Warranty claim — ready to send",
    bodyHTML:
      evidence +
      `<div class="ao-field" style="margin-bottom:12px;">
        <label class="ao-label" style="display:block;font-size:12px;font-weight:600;color:#5a6b7b;margin-bottom:4px;">To (manufacturer / installer)</label>
        <input class="ao-input" id="ao-to" type="text" value="${esc(to)}"
          style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cdd7e0;border-radius:8px;font-size:14px;">
      </div>
      <div class="ao-field" style="margin-bottom:12px;">
        <label class="ao-label" style="display:block;font-size:12px;font-weight:600;color:#5a6b7b;margin-bottom:4px;">Subject</label>
        <input class="ao-input" id="ao-subj" type="text" value="${esc(subject)}"
          style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cdd7e0;border-radius:8px;font-size:14px;">
      </div>
      <div class="ao-field">
        <label class="ao-label" style="display:block;font-size:12px;font-weight:600;color:#5a6b7b;margin-bottom:4px;">Body (editable)</label>
        <textarea class="ao-textarea" id="ao-body" rows="16"
          style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #cdd7e0;border-radius:8px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;">${esc(body)}</textarea>
      </div>
      <div class="ao-note" id="ao-claim-note" style="font-size:12px;color:#5a6b7b;margin-top:8px;min-height:16px;"></div>`,
    footHTML:
      `<button class="ao-btn ao-btn-ghost" id="ao-copy" type="button"
         style="padding:10px 16px;border:1px solid #cdd7e0;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;">Copy to clipboard</button>
       <button class="ao-btn ao-btn-primary" id="ao-mail" type="button"
         style="padding:10px 16px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;">Open in email</button>`,
    onMount(root, close){
      const note = root.querySelector("#ao-claim-note");
      const getVals = () => ({
        to: root.querySelector("#ao-to").value,
        subj: root.querySelector("#ao-subj").value,
        body: root.querySelector("#ao-body").value
      });
      root.querySelector("#ao-copy").onclick = async () => {
        const v = getVals();
        const text = `To: ${v.to}\nSubject: ${v.subj}\n\n${v.body}`;
        try{
          await navigator.clipboard.writeText(text);
          note.textContent = "Copied — paste it into your email client.";
          note.className = "ao-note ok";
        }catch(e){
          // fallback: select the textarea contents (guard — the node may be gone
          // if the modal was torn down or the DOM changed under us)
          const ta = root.querySelector("#ao-body");
          if(ta){ ta.focus(); ta.select(); }
          note.textContent = "Couldn't auto-copy — the draft is selected, press ⌘/Ctrl-C.";
          note.className = "ao-note err";
        }
      };
      root.querySelector("#ao-mail").onclick = async () => {
        const v = getVals();
        const href = `mailto:${encodeURIComponent(v.to)}`+
          `?subject=${encodeURIComponent(v.subj)}`+
          `&body=${encodeURIComponent(v.body)}`;
        // Browsers silently drop overly-long mailto: URLs — exactly the dead/fault
        // inverters that matter most produce the longest drafts. When the href is
        // too long to open reliably, copy the full draft instead so it's never
        // lost, and keep the modal open so the user sees what happened.
        if(href.length > 1800){
          const text = `To: ${v.to}\nSubject: ${v.subj}\n\n${v.body}`;
          try{
            await navigator.clipboard.writeText(text);
            note.textContent = "This draft was too long to open in your email automatically — we copied it instead. Paste it into a new email.";
            note.className = "ao-note ok";
          }catch(e){
            const ta = root.querySelector("#ao-body");
            if(ta){ ta.focus(); ta.select(); }
            note.textContent = "This draft is too long to open automatically — it's selected, press ⌘/Ctrl-C to copy it.";
            note.className = "ao-note err";
          }
          return;
        }
        window.location.href = href;
        note.textContent = "Opening your email client…";
        note.className = "ao-note ok";
        // Hand off to the email client, then close the overlay so it doesn't sit
        // stuck on top blocking the page while the user finishes the email.
        setTimeout(() => { try{ close(); }catch(e){} }, 400);
      };
    }
  });
}

/* ---- 2. DIAGNOSIS MODAL (underperforming / comm_gap) ---- */
function openDiagModal(inv){
  const {s, invs, totalNameplate} = fleetContext();
  const peers = invs.filter(i=>i!==inv && i.status==="ok").length || (invs.length-1);
  const pi = inv.peer_index;
  const pct = pi!=null ? Math.round(pi*100) : null;
  const shortfall = pi!=null ? Math.round((1-pi)*100) : null;
  const lostK = invLostKwh(inv, s.window_kwh, totalNameplate);
  const yrLost = lostK/(s.window_days||14)*365;

  const isComm = inv.status==="comm_gap";
  const causes = isComm
    ? ["Gateway / Wi-Fi dropout (most common — power may be fine)",
       "Logger or revenue meter offline",
       "Router or ISP outage at the site"]
    : ["Partial shading creeping across the string (tree growth, new structure)",
       "Soiling — dust, pollen, or snow on the modules",
       "A failed module or string pulling the whole inverter down"];
  const nextAction = isComm
    ? "Power-cycle the inverter's gateway / data logger and confirm it rejoins the network. If telemetry doesn't return within a day, we escalate to a site visit."
    : "Schedule a quick visual + IV-curve check on this inverter's strings. If a module/string has failed, it's typically a warranty or cleaning fix that pays for itself fast.";

  const plain = isComm
    ? `We've had no telemetry from <b>${esc(inv.serial)}</b> for <b>${fmt(inv.stale_hours)} hours</b>. Its neighbors are still reporting, so this looks like a communications dropout rather than a power fault — but we can't confirm production until it checks back in.`
    : `Over the last <b>${s.window_days} days</b>, <b>${esc(inv.serial)}</b> made only <b>${pct}%</b> of its fair share compared with <b>${peers} healthy peer inverter${peers===1?"":"s"}</b> under the same sky. Because weather hits every inverter equally, that <b>${shortfall}% shortfall</b> is the unit itself — not a cloudy stretch.`;

  const statGrid = isComm
    ? `<div class="ao-diag-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0;">
         <div class="ao-diag-stat" style="background:#f3f6f9;border-radius:10px;padding:12px;">
           <div class="ao-diag-num" style="font-size:22px;font-weight:700;">${fmt(inv.stale_hours)}h</div>
           <div class="ao-diag-cap" style="font-size:12px;color:#5a6b7b;">since last telemetry</div></div>
         <div class="ao-diag-stat" style="background:#f3f6f9;border-radius:10px;padding:12px;">
           <div class="ao-diag-num" style="font-size:22px;font-weight:700;">${peers}</div>
           <div class="ao-diag-cap" style="font-size:12px;color:#5a6b7b;">peers still reporting</div></div>
       </div>`
    : `<div class="ao-diag-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0;">
         <div class="ao-diag-stat" style="background:#f3f6f9;border-radius:10px;padding:12px;">
           <div class="ao-diag-num" style="font-size:22px;font-weight:700;">${pct}%</div>
           <div class="ao-diag-cap" style="font-size:12px;color:#5a6b7b;">of fair share</div></div>
         <div class="ao-diag-stat" style="background:#f3f6f9;border-radius:10px;padding:12px;">
           <div class="ao-diag-num" style="font-size:22px;font-weight:700;">${peers}</div>
           <div class="ao-diag-cap" style="font-size:12px;color:#5a6b7b;">peers compared</div></div>
         <div class="ao-diag-stat" style="background:#f3f6f9;border-radius:10px;padding:12px;">
           <div class="ao-diag-num" style="font-size:22px;font-weight:700;">${usd0(yrLost)}</div>
           <div class="ao-diag-cap" style="font-size:12px;color:#5a6b7b;">slipping away / yr</div></div>
       </div>`;

  openModal({
    title: `${esc(inv.serial)} — ${isComm?"why it's gone quiet":"what's dragging it down"}`,
    bodyHTML:
      `<p style="margin:0 0 6px;line-height:1.55;">${plain}</p>
       ${statGrid}
       <div class="ao-spark-lg" style="background:#0e1620;border-radius:10px;padding:12px 8px;margin:12px 0;">
         ${spark(inv.daily, isComm?"#5ab0ff":"#ffb454")}
         <div style="font-size:11px;color:#8aa;text-align:center;margin-top:4px;">${s.window_days}-day production trend (kWh/day)</div>
       </div>
       <h4 style="margin:14px 0 6px;font-size:14px;">Likely cause${causes.length>1?"s":""}</h4>
       <ul class="ao-causes" style="margin:0 0 12px;padding-left:18px;line-height:1.6;font-size:14px;">
         ${causes.map(c=>`<li>${esc(c)}</li>`).join("")}
       </ul>
       <div class="ao-note" style="background:#eef6ff;border-left:3px solid #1f6feb;border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.5;">
         <b>Suggested next action:</b> ${esc(nextAction)}
       </div>`,
    footHTML:
      `<button class="ao-btn ao-btn-primary" id="ao-diag-ok" type="button"
         style="padding:10px 16px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;">Got it</button>`,
    onMount(root, close){
      root.querySelector("#ao-diag-ok").onclick = close;
    }
  });
}

/* ---- 3. ADD AN ARRAY / SolarEdge discover MODAL ---- */
// Same-origin via arrayoperator.com's /v1/* Netlify→Railway proxy.
const DISCOVER_URL = "/v1/array-owners/solaredge/discover";

function openAddArrayModal(){
  openModal({
    title: "Add an array — connect SolarEdge",
    bodyHTML:
      `<p style="margin:0 0 12px;line-height:1.55;font-size:14px;">
         Paste <b>one</b> SolarEdge <b>account-level API key</b> and we'll discover <b>every site on the account</b> at once —
         no per-site setup. You can find it in the SolarEdge monitoring portal under
         <i>Admin → Site Access → API Access</i>.
       </p>
       <div class="ao-field" style="margin-bottom:10px;">
         <label class="ao-label" style="display:block;font-size:12px;font-weight:600;color:#5a6b7b;margin-bottom:4px;">SolarEdge account API key</label>
         <input class="ao-input" id="ao-key" type="text" autocomplete="off" spellcheck="false"
            placeholder="e.g. ABCD1234EFGH5678IJKL9012MNOP3456"
            style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd7e0;border-radius:8px;font:14px ui-monospace,Menlo,monospace;">
       </div>
       <div class="ao-note" id="ao-disc-note" style="font-size:13px;color:#5a6b7b;min-height:18px;"></div>
       <div class="ao-sites" id="ao-sites" style="margin-top:8px;"></div>`,
    footHTML:
      `<button class="ao-btn ao-btn-primary" id="ao-discover" type="button"
         style="padding:10px 16px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;">Discover my arrays</button>`,
    onMount(root){
      const btn = root.querySelector("#ao-discover");
      const note = root.querySelector("#ao-disc-note");
      const sites = root.querySelector("#ao-sites");
      btn.onclick = async () => {
        const key = root.querySelector("#ao-key").value.trim();
        sites.innerHTML = "";
        if(!key){
          note.textContent = "Paste your account API key first.";
          note.className = "ao-note err";
          return;
        }
        note.textContent = "Discovering sites on this account…";
        note.className = "ao-note";
        btn.disabled = true;
        try{
          const r = await fetch(DISCOVER_URL, {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({api_key: key})
          });
          let data = {};
          try{ data = await r.json(); }catch(e){ data = {}; }
          if(r.ok && data.ok && Array.isArray(data.sites) && data.sites.length){
            note.textContent = `Found ${data.sites.length} site${data.sites.length>1?"s":""} on this account — pick the ones to add:`;
            note.className = "ao-note ok";
            sites.innerHTML = data.sites.map((st,i)=>{
              const name = esc(st.name || st.site_name || st.id || ("Site "+(i+1)));
              const sub = esc([st.id?("#"+st.id):"", st.capacity_kw?(st.capacity_kw+" kW"):"", st.location||""].filter(Boolean).join(" · "));
              return `<label class="ao-site" style="display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid #e1e8ef;border-radius:8px;margin-bottom:6px;cursor:pointer;">
                  <input type="checkbox" checked value="${esc(st.id||name)}">
                  <span><b>${name}</b>${sub?`<br><small style="color:#5a6b7b;">${sub}</small>`:""}</span>
                </label>`;
            }).join("");
          } else if(r.ok && data.ok){
            note.textContent = "Connected, but no SolarEdge sites were found on this account.";
            note.className = "ao-note err";
          } else {
            note.textContent = (data && data.message) ? data.message : `That key was rejected (HTTP ${r.status}). Double-check it's an account-level key.`;
            note.className = "ao-note err";
          }
        }catch(err){
          // CORS / network / offline — fail gracefully, never crash
          note.innerHTML = "We couldn't reach the discovery service from this preview "+
            "(that's expected from a static demo origin). <b>We'll connect this automatically when you sign in</b> — your key was not stored.";
          note.className = "ao-note err";
        }finally{
          btn.disabled = false;
        }
      };
    }
  });
}

/* ---- 4. comm_gap inline helper (reuses the diagnosis modal) ---- */

// ---- event delegation for every CTA / fix link ----
function findInv(serial){ return CURRENT && CURRENT.inverters.find(i=>i.serial===serial); }

document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]");
  if(!t) return;
  const act = t.getAttribute("data-act");
  if(!act) return;
  const serial = t.getAttribute("data-serial");
  const inv = serial ? findInv(serial) : null;
  if(act==="claim" && inv){ e.preventDefault(); openClaimModal(inv); }
  else if((act==="diag"||act==="comm") && inv){ e.preventDefault(); openDiagModal(inv); }
});

// ---- '+ Add an array' nav link (only present on the in-app dashboard view) ----
const _addArray = document.getElementById("addArray");
if(_addArray) _addArray.onclick = e => { e.preventDefault(); openAddArrayModal(); };

// ============================================================================
// DATA LOADING
// If the owner is signed in (same-origin so_session, shared with the onboarding
// wizard + dashboard on arrayoperator.com), pull their LIVE per-array data from
// /v1/array-owners/overview and adapt it to render()'s shape. Otherwise fall
// back to the static demo file (the marketing/preview experience).
// ============================================================================

// Map a peer-status + health block from /overview onto the dashboard's inverter
// status vocabulary (ok | underperforming | comm_gap | dead | fault).
function _statusFromOverview(a){
  const peer = a.peer || {};
  if(peer.status === "dead") return "dead";
  if(peer.status === "underperforming") return "underperforming";
  const h = (a.health && (a.health.state || a.health.status)) || "";
  if(h === "stale" || h === "comm_gap") return "comm_gap";
  if(h === "no_source") return "comm_gap";
  return "ok";
}

// Adapt /v1/array-owners/overview → the {summary, array, inverters, thresholds}
// object render() consumes. Each array becomes one "inverter" card (per-array is
// the live resolution today; per-inverter capture lights up later).
function adaptOverview(o){
  const arrays = o.arrays || [];
  const t = o.totals || {};
  const ps = o.peer_summary || {};
  const inverters = arrays.map(a => {
    const peer = a.peer || {};
    const daily = (a._daily || []).map(d => ({kwh: d.kwh}));
    return {
      serial: a.name || ("Array " + a.array_id),
      model: a.client_name ? a.client_name : (a.fuel_type || "solar"),
      vendor: (a.live && a.live.source) ? a.live.source : "",
      nameplate_kw: null,
      ac_power_w: a.live ? a.live.current_power_w : null,
      status: _statusFromOverview(a),
      peer_index: peer.peer_index != null ? peer.peer_index : null,
      panel_resolution: "string",
      daily: daily,
      diagnosis: peer.diagnosis || (a.health && a.health.message) || "",
      stale_hours: (a.health && a.health.stale_hours != null) ? a.health.stale_hours : null,
      window_kwh: peer.window_kwh != null ? peer.window_kwh : null,
    };
  });
  const windowDays = ps.window_days || 14;
  // window_kwh for the value blurbs: prefer the summed peer window, else month.
  const windowKwh = inverters.reduce((s,i)=>s+(i.window_kwh||0),0) || (t.month_kwh || 0);
  const anyLive = arrays.some(a => a.live && a.live.source);
  return {
    source: anyLive ? "live" : "demo",
    generated_at: o.generated_at || new Date().toISOString(),
    array: {
      name: arrays.length === 1 ? arrays[0].name : "Your fleet",
      capacity_kw: null,
      vendor_mix: [...new Set(arrays.map(a => a.live && a.live.source).filter(Boolean))].join(" + "),
      module_count: null,
    },
    summary: {
      today_kwh: t.today_kwh || 0,
      window_kwh: windowKwh,
      window_days: windowDays,
      inverters_total: inverters.length,
      inverters_attention: ps.arrays_attention || 0,
    },
    inverters: inverters,
    thresholds: { underperform_peer_index: 0.85, dead_days: 3, comm_gap_hours: 36 },
  };
}

function loadDashboard(){
  // A magic-link (or hand-off) may drop a ONE-TIME login token in the URL as
  // ?token=. Exchange it for a real session via /v1/auth/verify (it is NOT a
  // ready session — storing it raw would 401), scrub it from the address bar,
  // then render. Password sign-in (login.html) stores so_session directly.
  let u = null;
  try { u = new URL(window.location.href); } catch(e){}
  const urlTok = u && u.searchParams.get("token");
  if(urlTok){
    try {
      u.searchParams.delete("token");
      window.history.replaceState({}, "", u.pathname + (u.search || "") + u.hash);
    } catch(e){}
    fetch("/v1/auth/verify", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: urlTok }) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d && d.session_token){ try { localStorage.setItem("so_session", d.session_token); } catch(e){} } })
      .finally(renderFromSession);
    return;
  }
  renderFromSession();
}
// Drive the GMP-onboarding gate banner. A signed-in owner is NOT done until
// GMP is connected AND ≥1 array is linked. next_step from the backend:
//   connect_gmp   → amber "Connect GMP to finish setting up"
//   link_accounts → green "almost there — link your captured GMP accounts"
//   done          → hide the bar entirely.
function updateGmpGate(session){
  const gate = document.getElementById("gmpGate");
  if(!gate) return;
  if(!session){ gate.hidden = true; return; }
  fetch("/v1/array-owners/onboarding-status", { headers: { Authorization: "Bearer " + session } })
    .then(r => r.ok ? r.json() : null)
    .then(s => {
      if(!s || !s.ok || s.complete){ gate.hidden = true; return; }
      const title = document.getElementById("gmpGateTitle");
      const sub   = document.getElementById("gmpGateSub");
      const badge = document.getElementById("gmpGateBadge");
      const cta   = document.getElementById("gmpGateCta");
      if(s.next_step === "link_accounts"){
        gate.classList.add("almost");
        badge.textContent = "ALMOST DONE";
        title.textContent = "Link your GMP accounts to finish";
        sub.innerHTML = "We captured " + s.unlinked_accounts + " GMP account" +
          (s.unlinked_accounts === 1 ? "" : "s") + " but " +
          (s.unlinked_accounts === 1 ? "it isn't" : "they aren't") +
          " linked to an array yet — so their bills can't flow in. <b>You're not done yet.</b>";
        cta.textContent = "Link accounts →";
        cta.onclick = null;
        cta.setAttribute("href", "#account");
      } else {
        gate.classList.remove("almost");
        badge.textContent = "FINISH SETUP";
        title.textContent = "Connect GMP to finish setting up";
        sub.innerHTML = "Your arrays are in, but Array Operator can't audit, reconcile, or bill them until your Green Mountain Power bills are connected. <b>You're not done yet.</b>";
        cta.textContent = "Connect GMP →";
        // Launch the REAL connect flow: opens greenmountainpower.com in a new tab
        // and the extension grabs the bills. NO detour back to onboarding.
        cta.removeAttribute("href");
        cta.setAttribute("role", "button");
        cta.style.cursor = "pointer";
        cta.onclick = (e) => {
          e.preventDefault();
          // Make sure we're on the Arrays tab (where the sandbox + modal live).
          if(location.hash !== "#arrays"){ location.hash = "#arrays"; }
          if(window.__aoConnectGmp){ window.__aoConnectGmp(); }
          else { location.href = "/onboarding#connect-gmp"; }  // defensive fallback
        };
      }
      gate.hidden = false;
    })
    .catch(() => { /* never block the dashboard on the gate */ });
}
// Expose for sandbox.js to re-check the gate after a GMP capture lands.
try {
  window.updateGmpGate = updateGmpGate;
  window.__aoRefreshGmpGate = function(){
    let s = null; try { s = localStorage.getItem("so_session"); } catch(e){}
    updateGmpGate(s);
  };
} catch(e){}

// -- Trial card-capture nudge ------------------------------------------------
// Quiet, dismissible bar for a signed-in trialing owner with NO card on file,
// within ~7 days of trial end. Surfaces the deferred-billing reminder in the UI
// so engaged owners can add a card at the moment of intent. Dismiss hides it; it
// reappears ONCE when the trial turns urgent (<=2 days). Never nags daily.
function updateTrialNudge(session){
  const bar = document.getElementById("trialNudge");
  if(!bar) return;
  if(!session){ bar.hidden = true; return; }
  fetch("/v1/account", { headers: { Authorization: "Bearer " + session } })
    .then(r => r.ok ? r.json() : null)
    .then(a => {
      if(!a){ bar.hidden = true; return; }
      try { if(window.aoIsCancelled && window.aoIsCancelled(a)){ bar.hidden = true; return; } } catch(e){}
      const hasCard = a.has_payment_method === true;
      const ends = a.trial_ends_at ? new Date(a.trial_ends_at) : null;
      if(hasCard || !ends || isNaN(ends.getTime())){ bar.hidden = true; return; }
      const days = Math.ceil((ends.getTime() - Date.now()) / 86400000);
      if(days < 0 || days > 7){ bar.hidden = true; return; }
      const tier = days <= 2 ? "urgent" : "soft";
      let dis = null;
      try {
        const parsed = JSON.parse(localStorage.getItem("ao_trialnudge_dismiss") || "null");
        // Only accept the exact shape we wrote ({ends, tier}); localStorage is same-origin
        // writable, so a poisoned/wrong-typed value (array, primitive, hostile object) must
        // not slip past the property reads below — coerce or discard.
        if(parsed && typeof parsed === "object" && !Array.isArray(parsed)
           && typeof parsed.ends === "string" && typeof parsed.tier === "string"){
          dis = { ends: parsed.ends, tier: parsed.tier };
        }
      } catch(e){}
      if(dis && dis.ends === a.trial_ends_at){
        if(dis.tier === "urgent"){ bar.hidden = true; return; }
        if(tier === "soft"){ bar.hidden = true; return; }
      }
      const when = days <= 0 ? "today" : (days === 1 ? "tomorrow" : "in " + days + " days");
      const copy = document.getElementById("trialNudgeCopy");
      if(copy){
        copy.innerHTML = (tier === "urgent")
          ? "<b>Your free trial ends " + when + ".</b> Add a card to keep your reports running."
          : "Your free trial ends " + when + ". Add a card whenever you're ready to keep your reports running after it.";
      }
      bar.classList.toggle("urgent", tier === "urgent");
      const cta = document.getElementById("trialNudgeCta");
      if(cta){
        cta.onclick = function(e){
          e.preventDefault();
          cta.textContent = "Opening...";
          fetch("/v1/account/add-payment-method", { method:"POST",
            headers: { "Content-Type":"application/json", Authorization: "Bearer " + session }, body: "{}" })
            .then(r => r.ok ? r.json() : null)
            .then(d => { const u = d && (d.checkout_url || d.url); if(u){ window.location = u; } else { cta.textContent = "Add a card"; } })
            .catch(() => { cta.textContent = "Add a card"; });
        };
      }
      const x = document.getElementById("trialNudgeX");
      if(x){
        x.onclick = function(){
          try { localStorage.setItem("ao_trialnudge_dismiss", JSON.stringify({ ends: a.trial_ends_at, tier: tier })); } catch(e){}
          bar.hidden = true;
        };
      }
      bar.hidden = false;
    })
    .catch(() => { /* never block the dashboard on the nudge */ });
}
try { window.updateTrialNudge = updateTrialNudge; } catch(e){}

// ── Cancelled-account lockout ──────────────────────────────────────────────
// A cancelled account (subscription_status "cancelled"/"canceled" + active===false)
// must NOT be able to use the dashboard — otherwise cancelling appears to do
// nothing. This renders a full-viewport overlay that covers EVERY tab/panel and
// blocks interaction. Data is preserved server-side; reactivation is a human step.
// Mirrors the NEPOOL Operator React SPA's CancelledGate for product parity.
function aoIsCancelled(a){
  if(!a) return false;
  const st = String(a.subscription_status || a.status || "").toLowerCase();
  return a.active === false && (st === "cancelled" || st === "canceled");
}
function aoShowCancelledGate(){
  if(document.getElementById("aoCancelledGate")) return;   // already shown
  const el = document.createElement("div");
  el.id = "aoCancelledGate";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Subscription cancelled");
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
    "justify-content:center;padding:24px;background:rgba(8,12,18,.86);" +
    "backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);";
  el.innerHTML =
    '<div style="width:100%;max-width:440px;background:#fff;color:#16202b;' +
      'border-radius:18px;padding:34px 30px;text-align:center;' +
      'box-shadow:0 30px 90px rgba(0,0,0,.5);font-family:inherit;">' +
      '<div style="margin:0 auto 18px;width:56px;height:56px;border-radius:999px;' +
        'background:#eef1f4;display:flex;align-items:center;justify-content:center;">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#6b7785" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="11" width="18" height="11" rx="2"></rect>' +
          '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></div>' +
      '<h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#101820;">' +
        'Your subscription is cancelled</h1>' +
      '<p style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#4a5663;">' +
        "Your dashboard and automatic data pulls are turned off. Start your " +
        "subscription again to pick up right where you left off.</p>" +
      '<p style="margin:0 0 22px;font-size:14px;line-height:1.5;font-weight:600;color:#137a4a;">' +
        "Your data is safe — we haven't deleted anything.</p>" +
      '<button type="button" id="aoReactivateBtn" ' +
        'style="display:block;width:100%;box-sizing:border-box;padding:13px 16px;border:none;' +
        'border-radius:12px;background:#137a4a;color:#fff;font-size:14px;font-weight:700;' +
        'cursor:pointer;">Start my subscription →</button>' +
      '<div id="aoReactivateMsg" style="margin-top:10px;font-size:12px;color:#b4361f;min-height:14px;"></div>' +
      '<p style="margin:14px 0 0;font-size:12px;color:#9aa6b2;">' +
        "Billing starts today — your free trial has already been used. Cancel anytime.</p>" +
      '<button type="button" id="aoCancelledSignOut" ' +
        'style="margin-top:16px;background:none;border:none;color:#9aa6b2;font-size:12px;' +
        'cursor:pointer;text-decoration:underline;text-underline-offset:2px;">Sign out</button>' +
    '</div>';
  document.body.appendChild(el);
  // Kill scrolling/interaction with anything behind the gate.
  try { document.body.style.overflow = "hidden"; } catch(e){}
  const out = document.getElementById("aoCancelledSignOut");
  if(out) out.addEventListener("click", () => { aoSignOut(); });
  // Reactivate: start a fresh PAID subscription (no trial). POST /v1/account/reactivate
  // returns a Stripe Checkout (setup) URL; the webhook then creates the subscription
  // and flips the tenant back to active.
  const reBtn = document.getElementById("aoReactivateBtn");
  const reMsg = document.getElementById("aoReactivateMsg");
  if(reBtn) reBtn.addEventListener("click", async () => {
    let session = null;
    try { session = localStorage.getItem("so_session"); } catch(e){}
    if(!session){ if(reMsg) reMsg.textContent = "Please sign in again."; return; }
    reBtn.disabled = true; reBtn.textContent = "Opening secure checkout…";
    if(reMsg) reMsg.textContent = "";
    try{
      const r = await fetch("/v1/account/reactivate", {
        method: "POST",
        headers: { Authorization: "Bearer " + session },
      });
      const d = await r.json().catch(() => ({}));
      if(r.ok && d.checkout_url){ location.href = d.checkout_url; return; }
      if(reMsg) reMsg.textContent = (d && d.detail) ? d.detail : ("Couldn't start checkout (HTTP " + r.status + ").");
      reBtn.disabled = false; reBtn.textContent = "Start my subscription →";
    }catch(e){
      if(reMsg) reMsg.textContent = "Couldn't reach the server — try again.";
      reBtn.disabled = false; reBtn.textContent = "Start my subscription →";
    }
  });
}
// Expose so sandbox.js (the #account tab) and any other surface can trigger it
// from their own /v1/account reads without duplicating the logic.
try {
  window.aoIsCancelled = aoIsCancelled;
  window.aoShowCancelledGate = aoShowCancelledGate;
} catch(e){}

// Canonical sign-out — clear the session token AND this session's cached fleet
// tree (so a shared browser never shows the previous owner's arrays after
// logout), then return to /login. Exposed on window so every surface (the header
// chip, the #account tab in sandbox.js, the cancelled gate) tears down the SAME
// way instead of a partial localStorage.removeItem that leaves cached data behind.
function aoSignOut(){
  let s = null;
  try { s = localStorage.getItem("so_session"); } catch(e){}
  try { localStorage.removeItem("so_session"); } catch(e){}
  try {
    if(s) localStorage.removeItem("ao_fleet_cache:" + s.slice(0, 12));
    // Sweep any stray fleet-cache entries (other sessions on this browser) so no
    // signed-in fleet data lingers in localStorage after logout.
    for(let i = localStorage.length - 1; i >= 0; i--){
      const k = localStorage.key(i);
      if(k && k.indexOf("ao_fleet_cache:") === 0) localStorage.removeItem(k);
    }
  } catch(e){}
  location.href = "/login";
}
try { window.aoSignOut = aoSignOut; } catch(e){}

function renderFromSession(){
  let session = null;
  try { session = localStorage.getItem("so_session"); } catch(e){}
  // Surface a "Sign in" link to signed-out visitors (hidden once authed).
  try { const si = document.getElementById("tabSignIn"); if(si) si.style.display = session ? "none" : ""; } catch(e){}
  // Big demo→signup conversion banner: shown ONLY to anonymous visitors, hidden
  // the instant a session exists so signed-in owners never see it.
  try { const db = document.getElementById("demoBanner"); if(db) db.hidden = !!session; } catch(e){}
  // GMP-onboarding gate: a signed-in owner isn't DONE until GMP is connected.
  // Poll the onboarding-status endpoint and show the "you're not done" bar until
  // GMP is connected + at least one array is linked. Signed-out → always hidden.
  try { updateGmpGate(session); } catch(e){}
  try { updateTrialNudge(session); } catch(e){}
  // Onboarding GMP handoff: an owner who chose 'Log in with Green Mountain
  // Power' in onboarding lands here signed in; auto-open the proven GMP connect.
  try {
    if(session && localStorage.getItem("ao_pending_gmp_connect") === "1"){
      localStorage.removeItem("ao_pending_gmp_connect");
      if(location.hash !== "#arrays"){ location.hash = "#arrays"; }
      let _t = 0;
      const _launchGmp = () => {
        if(window.__aoConnectGmp){ window.__aoConnectGmp(); }
        else if(_t++ < 20){ setTimeout(_launchGmp, 300); }
      };
      setTimeout(_launchGmp, 600);
    }
  } catch(e){}
  // Signed-in identity chip (top-right): show which account this session is in.
  // One lightweight /v1/account read fills the email; hidden when signed out or
  // if the session is stale (so it never claims an account we can't confirm).
  try {
    const who = document.getElementById("tabWhoami");
    const whoEmail = document.getElementById("whoamiEmail");
    if(who){
      if(session){
        who.style.display = "";
        if(whoEmail && !whoEmail.dataset.real) whoEmail.textContent = "…";
        fetch("/v1/account", { headers: { Authorization: "Bearer " + session } })
          .then(r => r.ok ? r.json() : null)
          .then(a => {
            if(a && aoIsCancelled(a)){ aoShowCancelledGate(); }
            if(a && a.email && whoEmail){
              whoEmail.textContent = a.email;
              whoEmail.dataset.real = "1";
              who.title = "Signed in as " + a.email + " — view your master account";
            } else { who.style.display = "none"; }
          })
          .catch(() => { who.style.display = "none"; });
      } else {
        who.style.display = "none";
      }
    }
  } catch(e){}
  // Sign-out control (top-right, just past the identity chip): visible whenever a
  // session token exists — you can always sign out, even if the token turns out
  // stale. Wired ONCE to the canonical aoSignOut (clears token + cached tree).
  try {
    const so = document.getElementById("tabSignOut");
    if(so){
      so.style.display = session ? "" : "none";
      if(!so._wired){
        so._wired = 1;
        so.addEventListener("click", (e) => { e.preventDefault(); aoSignOut(); });
      }
    }
  } catch(e){}
  const empty = () => { const g = document.getElementById("grid"); if(g) g.innerHTML =
    `<div class="empty">No array data yet — connect an inverter to see your live numbers.</div>`; };
  // Session expired / invalid → DON'T silently show demo (that made owners think
  // their real arrays were "forgotten" when in fact they were just logged out by a
  // server-side session-secret rotation). Clear the dead token and prompt re-auth.
  const reauth = () => {
    try { localStorage.removeItem("so_session"); } catch(e){}
    const g = document.getElementById("grid");
    if(g) g.innerHTML =
      `<div class="empty">Your session expired — <a href="/login">sign back in</a> to see your arrays. ` +
      `Your data is safe; you've just been signed out.</div>`;
    try { const si = document.getElementById("tabSignIn"); if(si) si.style.display = ""; } catch(e){}
    try { const who = document.getElementById("tabWhoami"); if(who) who.style.display = "none"; } catch(e){}
    try { const db = document.getElementById("demoBanner"); if(db) db.hidden = true; } catch(e){}
  };

  if(session){
    fetch("/v1/array-owners/overview", { headers: { Authorization: "Bearer " + session } })
      .then(r => {
        // An invalid/expired session is an AUTH failure (401/403), not a data
        // outage — handle it distinctly so we never paint demo over a logout.
        if(r.status === 401 || r.status === 403){ const e = new Error("auth"); e.auth = true; throw e; }
        if(!r.ok) throw new Error("overview " + r.status);
        return r.json();
      })
      .then(o => {
        const arrays = o.arrays || [];
        if(!arrays.length){
          // Signed in, genuinely nothing connected yet — show the honest empty
          // state, NOT demo (demo numbers on a real account read as fake data).
          return empty();
        }
        render(adaptOverview(o));
      })
      .catch((err) => {
        if(err && err.auth){ reauth(); return; }   // expired session → re-auth prompt
        // Transient (network / 5xx) — keep the page useful with demo rather than a
        // blank panel, but only for NON-auth errors so a logout never shows demo.
        fetch("inverter-truth.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render).catch(empty);
      });
  } else {
    // Anonymous visitor (marketing view) — static demo data.
    fetch("inverter-truth.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render).catch(empty);
  }
}

// Expose for the tab system (sandbox.js) so switching back to the Arrays tab can
// refresh the hero+grid. Runs once here on parse so the panel is populated even
// before any tab interaction.
window.__aoLoadDashboard = loadDashboard;
loadDashboard();
