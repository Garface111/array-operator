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

function render(data){
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
      <span class="cta">Review &amp; send the claim</span></div></div>`);
  }
  if(under.length){
    const uLostYr = under.reduce((t,i)=>t+invLostKwh(i,s.window_kwh,totalNameplate),0)/(s.window_days||14)*365;
    acts.push(`<div class="act">
      <div class="ic">🔍</div>
      <div><h3>Found a quiet money leak <span class="tag">diagnosed</span></h3>
      <p><b>${under.length} inverter${under.length>1?"s are":" is"}</b> running below ${under.length>1?"their":"its"} fair share — likely shading, soiling, or a tired string. Left alone that's about <b>${usd0(val(uLostYr))}/yr</b> slipping away. We've pinpointed which one and why.</p>
      <span class="cta">See the diagnosis</span></div></div>`);
  }
  acts.push(`<div class="act win">
    <div class="ic">💰</div>
    <div><h3>You may be sitting on REC money <span class="tag">opportunity</span></h3>
    <p>Your array minted roughly <b>${Math.floor(s.window_kwh/1000*26)} RECs</b> worth of renewable credits this year. Many owners never sell these — the installer keeps them. We can hand you to a <b>NEPOOL Operator</b> who files them for you.</p>
    <a class="cta" href="https://solaroperator.org">Explore selling your RECs</a></div></div>`);

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
        ${FIX[inv.status]?`<br><span class="${fixCls}">${FIX[inv.status]} →</span>`:""}</div>
    </div>`;
  }).join("");

  document.getElementById("foot").innerHTML =
    `<b>How we know:</b> every inverter's share of the harvest is weighed against its share of the hardware — `+
    `1.00 means it's pulling its weight. Below <b>${data.thresholds.underperform_peer_index}</b> it's working hard but falling short; `+
    `<b>${data.thresholds.dead_days}</b> zero-days while its neighbors produce and we call it home; quiet for <b>${data.thresholds.comm_gap_hours}h</b> and we flag the silence. `+
    `Readings come straight from your hardware — SolarEdge, Enphase, and Fronius. `+
    `Value figures are estimates at ${usd(ENERGY_RATE)}/kWh + ${usd0(REC_PER_MWH)}/MWh REC; connect live to pin them exactly.`;
}

document.getElementById("addArray").onclick=e=>{e.preventDefault();alert("Connect flow: paste one SolarEdge account key and every array you own appears at once. (Wired on the backend: /v1/array-owners/solaredge/discover)")};

fetch("inverter-truth.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render)
  .catch(()=>{document.getElementById("grid").innerHTML=
    `<div class="empty">No array data yet. Warm it up:<br><code>python3 capture/inverters.py --demo</code></div>`});
