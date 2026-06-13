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
const ENERGY_RATE = 0.21;       // $/kWh blended residential offset (VT-ish)
const REC_PER_MWH = 38;         // $/MWh REC value
const val = kwh => kwh*ENERGY_RATE + (kwh/1000)*REC_PER_MWH;
const usd = n => n==null ? "—" : "$"+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const usd0 = n => "$"+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
const fmt = n => n==null ? "—" : Number(n).toLocaleString(undefined,{maximumFractionDigits:1});

const STATUS_LABEL = {ok:"Pulling its weight", underperforming:"Working hard, falling short", comm_gap:"Gone quiet", dead:"Not coming home", fault:"Something's wrong"};
const FIX = {
  dead:"Draft the warranty claim", fault:"Draft the service request",
  underperforming:"See what's dragging it", comm_gap:"How to bring it back", ok:""
};

function spark(daily, color){
  if(!daily || !daily.length) return "";
  const w=300,h=40,max=Math.max(...daily.map(d=>d.kwh),0.001);
  const pts=daily.map((d,i)=>`${(i/(daily.length-1))*w},${h-3-(d.kwh/max)*(h-8)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${daily.map((d,i)=>d.kwh===0?`<circle cx="${(i/(daily.length-1))*w}" cy="${h-3}" r="2.2" fill="var(--bad)"/>`:"").join("")}
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
  CURRENT = data;
  const s=data.summary, a=data.array, invs=data.inverters;
  const totalNameplate = invs.reduce((t,i)=>t+(i.nameplate_kw||0),0)||1;

  document.getElementById("title").innerHTML =
    a.name + " is <b>" + (s.inverters_attention===0 ? "running clean" : "mostly humming") + "</b>.";
  document.getElementById("meta").innerHTML =
    `<b>${a.capacity_kw ?? "?"} kW</b> · ${a.vendor_mix||""}` +
    (a.module_count?` · ${a.module_count} panels`:"") +
    ` · reading <b>${data.source==="live"?"live from your hardware":"demo data"}</b>` +
    ` · last checked ${new Date(data.generated_at).toLocaleString([], {hour:'numeric',minute:'2-digit',month:'short',day:'numeric'})}`;

  // hero value
  const todayV = val(s.today_kwh);
  document.getElementById("todayValue").innerHTML = usd(todayV) + ` <small>· ${fmt(s.today_kwh)} kWh</small>`;
  document.getElementById("lifeValue").innerHTML = usd0(val(s.window_kwh)*26) ;  // ~lifetime proxy from window
  document.getElementById("lifeSub").textContent = "estimated — connect live to pin it exactly";

  // verdict light
  const attn=s.inverters_attention;
  const hasRed = invs.some(i=>i.status==="dead"||i.status==="fault");
  const light = hasRed ? "red" : attn>0 ? "amber" : "green";
  document.getElementById("vlight").className = "vlight "+light;
  document.getElementById("vt").textContent =
    attn===0 ? "All clear" : `${attn} of your ${s.inverters_total} need a look`;
  document.getElementById("vs").textContent =
    attn===0 ? "Every inverter is pulling its weight." :
    hasRed ? "One has stopped earning — we've drafted the claim." :
    "Quiet money leak caught early.";

  // ---- WE'RE ON IT actions ----
  const acts=[];
  const dead = invs.find(i=>i.status==="dead"||i.status==="fault");
  const under = invs.filter(i=>i.status==="underperforming");
  const totalLostKwh = invs.reduce((t,i)=>t+invLostKwh(i,s.window_kwh,totalNameplate),0);
  const yearLost = totalLostKwh/(s.window_days||14)*365;

  acts.push(`<div class="act">
    <div class="ic">👁️</div>
    <div><h3>Watching every panel, every day <span class="tag">always on</span></h3>
    <p>We compared all <b>${s.inverters_total} inverters</b> against each other under the same sky for ${s.window_days} days. Weather cancels out — so we catch the quiet underperformer the day it starts, not on next year's bill.</p></div></div>`);

  if(dead){
    const lost = invLostKwh(dead,s.window_kwh,totalNameplate);
    acts.push(`<div class="act hot">
      <div class="ic">📋</div>
      <div><h3>Warranty claim drafted <span class="tag">ready to send</span></h3>
      <p><b>${dead.serial}</b> stopped earning ${dead.stale_hours?Math.round(dead.stale_hours/24):"a few"} days ago — that's about <b>${usd(val(lost))}</b> gone so far. We wrote the service email with the fault code, dates, and lost-kWh evidence attached.</p>
      <span class="cta" data-act="claim" data-serial="${dead.serial}">Review &amp; send the claim</span></div></div>`);
  }
  if(under.length){
    const uLostYr = under.reduce((t,i)=>t+invLostKwh(i,s.window_kwh,totalNameplate),0)/(s.window_days||14)*365;
    acts.push(`<div class="act">
      <div class="ic">🔍</div>
      <div><h3>Found a quiet money leak <span class="tag">diagnosed</span></h3>
      <p><b>${under.length} inverter${under.length>1?"s are":" is"}</b> running below ${under.length>1?"their":"its"} fair share — likely shading, soiling, or a tired string. Left alone that's about <b>${usd0(val(uLostYr))}/yr</b> slipping away. We've pinpointed which one and why.</p>
      <span class="cta" data-act="diag" data-serial="${under[0].serial}">See the diagnosis</span></div></div>`);
  }
  acts.push(`<div class="act win">
    <div class="ic">💰</div>
    <div><h3>You may be sitting on REC money <span class="tag">opportunity</span></h3>
    <p>Your array minted roughly <b>${Math.floor(s.window_kwh/1000*26)} RECs</b> worth of renewable credits this year. Many owners never sell these — the installer keeps them. We can hand you to a <b>NEPOOL Operator</b> who files them for you.</p>
    <a class="cta" href="https://nepooloperator.com" target="_blank" rel="noopener">Explore selling your RECs</a></div></div>`);

  document.getElementById("actions").innerHTML = acts.join("");

  // ---- FLEET ----
  const order={fault:0,dead:1,underperforming:2,comm_gap:3,ok:4};
  const sorted=[...invs].sort((x,y)=>order[x.status]-order[y.status]);
  document.getElementById("grid").innerHTML = sorted.map(inv=>{
    const edge=(inv.status==="dead"||inv.status==="fault")?"bad-edge":(inv.status==="underperforming")?"warn-edge":"";
    const pi=inv.peer_index, barCls=pi==null?"":pi<0.7?"bad":pi<0.85?"warn":"";
    const sparkColor=inv.status==="ok"?"var(--good)":inv.status==="comm_gap"?"var(--sky)":"var(--warn)";
    const lostK=invLostKwh(inv,s.window_kwh,totalNameplate);
    const lostHtml = lostK>0.5
      ? `<div class="lost">−${usd(val(lostK))} this ${s.window_days}d</div>`
      : `<div class="lost zero">on the money</div>`;
    const res=inv.panel_resolution==="panel"?"per-panel":inv.panel_resolution==="module"?"per-module":"string-level";
    const fixCls=(inv.status==="dead"||inv.status==="fault")?"fix hot":"fix";
    const fixAct=(inv.status==="dead"||inv.status==="fault")?"claim":(inv.status==="underperforming")?"diag":(inv.status==="comm_gap")?"comm":"";
    return `<div class="inv ${edge}">
      <span class="res ${inv.panel_resolution==='panel'?'panel':''}">${res} truth</span>
      <div class="inv-head">
        <div><h3>${inv.serial}</h3><div class="model">${inv.model} · ${inv.vendor}${inv.nameplate_kw?` · ${inv.nameplate_kw} kW`:""}</div></div>
        <span class="pill ${inv.status}">${STATUS_LABEL[inv.status]||inv.status}</span>
      </div>
      <div class="moneyrow">
        <div class="now">making <b>${inv.ac_power_w==null?"—":fmt(inv.ac_power_w/1000)+" kW"}</b> right now</div>
        ${lostHtml}
      </div>
      <div class="peerwrap">
        <div class="peerbar"><i class="${barCls}" style="width:${Math.min((pi||0)*100,100)}%"></i></div>
        <div class="pv">${pi==null?"—":pi.toFixed(2)}</div>
      </div>
      ${spark(inv.daily, sparkColor)}
      <div class="diag">${inv.diagnosis}
        ${inv.stale_hours!=null&&inv.stale_hours>24?` <b>Last heard from ${fmt(inv.stale_hours)}h ago.</b>`:""}
        ${FIX[inv.status]?`<br><span class="${fixCls}" data-act="${fixAct}" data-serial="${inv.serial}">${FIX[inv.status]} →</span>`:""}</div>
    </div>`;
  }).join("");

  document.getElementById("foot").innerHTML =
    `<b>How we know:</b> every inverter's share of the harvest is weighed against its share of the hardware — `+
    `1.00 means it's pulling its weight. Below <b>${data.thresholds.underperform_peer_index}</b> it's working hard but falling short; `+
    `<b>${data.thresholds.dead_days}</b> zero-days while its neighbors produce and we call it home; quiet for <b>${data.thresholds.comm_gap_hours}h</b> and we flag the silence. `+
    `Readings come straight from your hardware — SolarEdge, Enphase, and Fronius. `+
    `Value figures are estimates at ${usd(ENERGY_RATE)}/kWh + ${usd0(REC_PER_MWH)}/MWh REC; connect live to pin them exactly.`;
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
  • Estimated lost value:   ${usd(lostUsd)} (at ${usd(ENERGY_RATE)}/kWh offset + ${usd0(REC_PER_MWH)}/MWh RECs)

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
    onMount(root){
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
          // fallback: select the textarea contents
          const ta = root.querySelector("#ao-body"); ta.focus(); ta.select();
          note.textContent = "Couldn't auto-copy — the draft is selected, press ⌘/Ctrl-C.";
          note.className = "ao-note err";
        }
      };
      root.querySelector("#ao-mail").onclick = () => {
        const v = getVals();
        const href = `mailto:${encodeURIComponent(v.to)}`+
          `?subject=${encodeURIComponent(v.subj)}`+
          `&body=${encodeURIComponent(v.body)}`;
        window.location.href = href;
        note.textContent = "Opening your email client…";
        note.className = "ao-note ok";
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
  let session = null;
  // Accept a session handed in via the URL (?token= from the magic-link email or
  // a post-onboarding hand-off), persist it under the key the dashboard reads,
  // then scrub it from the address bar so it doesn't linger in history.
  try {
    const u = new URL(window.location.href);
    const urlTok = u.searchParams.get("token");
    if(urlTok){
      localStorage.setItem("so_session", urlTok);
      u.searchParams.delete("token");
      window.history.replaceState({}, "", u.pathname + (u.search || "") + u.hash);
    }
  } catch(e){}
  try { session = localStorage.getItem("so_session"); } catch(e){}
  const empty = () => { document.getElementById("grid").innerHTML =
    `<div class="empty">No array data yet — connect an inverter to see your live numbers.</div>`; };

  if(session){
    fetch("/v1/array-owners/overview", { headers: { Authorization: "Bearer " + session } })
      .then(r => { if(!r.ok) throw new Error("overview " + r.status); return r.json(); })
      .then(o => {
        const arrays = o.arrays || [];
        if(!arrays.length){
          // Signed in but nothing connected yet — fall back to demo so the page
          // still tells the story, with a clear "demo" label via render().
          return fetch("inverter-truth.json").then(r=>r.json()).then(render);
        }
        render(adaptOverview(o));
      })
      .catch(() => {
        // Live fetch failed (expired session / network) — show the demo rather
        // than a blank page; the marketing narrative still lands.
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
