/* ============================================================================
 * Array Operator — Sandbox view (sandbox.js)
 *
 * Renders the three-tier fleet structure that mirrors the backend data model:
 *
 *     Alerts   (top row)    — one per array, rolled-up worst inverter state
 *       │
 *     Arrays   (middle row) — one column per array
 *       │
 *     Inverters(bottom row) — the "comb": N real inverter prongs per array
 *
 * Top controls bottom: each Alert sits above its Array, each Array fans out to
 * its inverters. Data: GET /v1/array-owners/fleet-tree (live SolarEdge per-
 * inverter telemetry, peer-analyzed within each site). The organization of this
 * canvas IS the schema: Tenant → Array → Inverter, with alerts riding on top.
 * ==========================================================================*/
(function(){
  const SESSION_KEY = "so_session";
  const ORDER_KEY = "ao_array_order";        // persisted column order (array_id strings)
  const BRAND = { solaredge:"SolarEdge", locus:"Locus", fronius:"Fronius", sma:"SMA", chint:"Chint" };

  // Vendor catalog — copied VERBATIM from public/onboarding.html so the add-array
  // picker offers the same brands + field logic the wizard does.
  const VENDORS = [
    { code:"solaredge", label:"SolarEdge", meta:"One account key", available:true, discover:true,
      fields:[{name:"apiKey", label:"SolarEdge account API key", secret:true,
               hint:"The one key that unlocks every site on your account.",
               ph:"ABCD1234…", help:`Find it in your SolarEdge monitoring portal under <b>Admin → Site Access → API Access</b> (an <i>account</i>-level key, read-only). Don't have it handy? <a href="https://monitoring.solaredge.com" target="_blank" rel="noopener">Open the SolarEdge portal →</a>`}] },
    { code:"locus", label:"Locus Energy", meta:"SolarNOC", available:true, discover:false,
      note:"Locus needs API credentials (client ID/secret + your SolarNOC login) from your Locus account manager. Enter them and we'll connect your sites.",
      fields:[
        {name:"client_id", label:"Client ID"},
        {name:"client_secret", label:"Client Secret", secret:true},
        {name:"username", label:"SolarNOC username"},
        {name:"password", label:"SolarNOC password", secret:true},
        {name:"partner_id", label:"Partner ID (optional — shows every site at once)"},
      ] },
    { code:"fronius", label:"Fronius", meta:"Solar.web", available:true, discover:false,
      note:"Fronius Solar.web is a paid business API and isn't offered in the USA yet — US arrays may need the local LAN path. Enter your Solar.web keys to try the cloud connection.",
      fields:[
        {name:"access_key_id", label:"Access Key ID"},
        {name:"access_key_value", label:"Access Key Value", secret:true},
        {name:"pv_system_id", label:"PV System ID"},
      ] },
    { code:"sma", label:"SMA", meta:"Sunny Portal", available:true, discover:false,
      note:"SMA needs a developer app registration + owner consent. Endpoints are still being verified — enter your credentials and we'll take it from here.",
      fields:[
        {name:"client_id", label:"Client ID"},
        {name:"client_secret", label:"Client Secret", secret:true},
        {name:"system_id", label:"Plant / System ID"},
      ] },
    { code:"chint", label:"Chint / CPS", meta:"CSV for now", available:false, discover:false,
      note:"Chint/CPS has no public API yet, so there's nothing to paste — connect by uploading a production CSV from your dashboard after setup. We're tracking their FlexOM gateway for direct support." },
  ];
  function vendorByCode(c){ return VENDORS.find(v=>v.code===c) || VENDORS[0]; }

  function getSession(){ try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } }

  // ---- saved column order (localStorage) ----
  function loadOrder(){
    try { const v = JSON.parse(localStorage.getItem(ORDER_KEY)); return Array.isArray(v) ? v.map(String) : []; }
    catch(e){ return []; }
  }
  function saveOrder(canvas){
    const ids = [...canvas.querySelectorAll(".sb-col")].map(c => c.dataset.arrayId);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch(e){}
  }
  // Stable-sort fetched columns by the saved order; unknown/new arrays fall to the end.
  function applyOrder(cols){
    const order = loadOrder();
    if(!order.length) return cols;
    const rank = id => { const i = order.indexOf(String(id)); return i === -1 ? Infinity : i; };
    return cols.map((c,i)=>[c,i]).sort((a,b)=>{
      const d = rank(a[0].array_id) - rank(b[0].array_id);
      return d !== 0 ? d : a[1] - b[1];
    }).map(x=>x[0]);
  }

  const STATUS_LABEL = {
    ok: "Pulling its weight", underperforming: "Below its neighbors",
    comm_gap: "Gone quiet", dead: "Not coming home", fault: "Fault"
  };
  const STATUS_CLASS = {
    ok: "ok", underperforming: "warn", comm_gap: "warn", dead: "bad", fault: "bad"
  };
  const ALERT_CLASS = { ok: "ok", warn: "warn", critical: "bad" };

  function el(html){ const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

  // peer-index bar (0..~1.2 clamped) — green at/above 1, amber/ red below
  function peerBar(pi){
    if(pi==null) return `<div class="sb-pi none">solo · no peers</div>`;
    const pct = Math.max(4, Math.min(100, Math.round(pi*100)));
    const cls = pi>=0.85 ? "ok" : pi>=0.6 ? "warn" : "bad";
    return `<div class="sb-pi"><div class="sb-pi-bar ${cls}" style="width:${pct}%"></div><span>${pi.toFixed(2)}</span></div>`;
  }

  function render(tree){
    const host = document.getElementById("sandbox");
    if(!host) return;
    const cols = applyOrder(tree.columns || []);
    if(!cols.length){
      host.innerHTML =
        `<div class="sb-head"><div>
           <div class="sb-tiers"><span class="sb-tier-tag b">Your fleet</span></div>
           <div class="sb-sub">Nothing connected yet — add your first array to build your live fleet tree.</div>
         </div>
         <div class="sb-head-actions"><button class="sb-addbtn" id="sbAddArray">+ Add array</button></div></div>
         <div class="sb-empty">No arrays connected yet — hit <b>+ Add array</b> to bring your inverters in.</div>`;
      wireAddButton(host);
      return;
    }

    const summary = tree.summary || {};
    const head = `
      <div class="sb-head">
        <div>
          <div class="sb-tiers">
            <span class="sb-tier-tag a">Alerts</span>
            <span class="sb-arrow">→ control →</span>
            <span class="sb-tier-tag b">Arrays</span>
            <span class="sb-arrow">→ control →</span>
            <span class="sb-tier-tag c">Inverters</span>
          </div>
          <div class="sb-sub">${summary.arrays_total||0} arrays · ${summary.inverters_total||0} inverters · ${summary.attention||0} need a look — this layout is your live system, top controls bottom</div>
        </div>
        <div class="sb-head-actions">
          <button class="sb-addbtn" id="sbAddArray">+ Add array</button>
          <div class="sb-legend">
            <span><i class="sw ok"></i>healthy</span>
            <span><i class="sw warn"></i>watch</span>
            <span><i class="sw bad"></i>critical</span>
          </div>
        </div>
      </div>`;

    const columns = cols.map(col => {
      const a = col.alert || {level:"ok"};
      const aCls = ALERT_CLASS[a.level] || "ok";
      const invs = col.inverters || [];
      const srcTag = col.inverter_source === "solaredge"
        ? `<span class="sb-srctag live">live · per-inverter</span>`
        : col.inverter_source === "array"
          ? `<span class="sb-srctag">array-level</span>`
          : `<span class="sb-srctag off">no data</span>`;
      const brandChip = col.vendor
        ? `<span class="sb-brand ${esc(col.vendor)}">${esc(BRAND[col.vendor] || col.vendor)}</span>`
        : "";

      // bottom comb — one prong per inverter
      const teeth = invs.map(inv => {
        const sCls = STATUS_CLASS[inv.status] || "ok";
        const np = inv.nameplate_kw!=null ? `${inv.nameplate_kw} kW` : "";
        const power = inv.current_power_w!=null ? `${(inv.current_power_w/1000).toFixed(2)} kW now` : "";
        return `
          <div class="sb-inv ${sCls}" tabindex="0"
               data-name="${esc(inv.name)}" data-status="${esc(inv.status)}"
               data-diag="${esc(inv.diagnosis||"")}" data-model="${esc(inv.model||"")}"
               data-np="${esc(np)}" data-win="${esc(inv.window_kwh!=null?inv.window_kwh+' kWh / 14d':'')}"
               data-mode="${esc(inv.last_mode||"")}" data-power="${esc(power)}">
            <div class="sb-inv-dot"></div>
            <div class="sb-inv-name">${esc(inv.name)}</div>
            <div class="sb-inv-meta">${esc(np)}</div>
            ${peerBar(inv.peer_index)}
            <div class="sb-inv-status ${sCls}">${esc(STATUS_LABEL[inv.status]||inv.status||"")}</div>
          </div>`;
      }).join("");

      return `
        <div class="sb-col" draggable="true" data-array-id="${esc(col.array_id)}">
          <!-- TIER 1: Alert -->
          <div class="sb-alert ${aCls}">
            <div class="sb-alert-k">Alerts</div>
            <div class="sb-alert-h">${esc(a.headline||"All clear")}</div>
            <div class="sb-alert-c">${a.count? a.count+' inverter'+(a.count>1?'s':'')+' flagged' : 'nothing to do'}</div>
          </div>
          <div class="sb-link v1 ${aCls}"></div>

          <!-- TIER 2: Array -->
          <div class="sb-array">
            <span class="sb-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
            <div class="sb-array-k">Array</div>
            <div class="sb-array-name">${esc(col.array_name)}</div>
            <div class="sb-array-meta">${col.inverter_count} inverter${col.inverter_count===1?'':'s'} ${srcTag} ${brandChip}</div>
          </div>
          <div class="sb-link v2"></div>

          <!-- TIER 3: Inverters comb -->
          <div class="sb-comb">
            <div class="sb-bus"></div>
            <div class="sb-teeth">${teeth}</div>
          </div>
        </div>`;
    }).join("");

    host.innerHTML = head + `<div class="sb-canvas">${columns}</div>
      <div class="sb-foot" id="sbFoot">Tip: click any inverter for its diagnosis. The three rows are the three layers of our backend — Alert → Array → Inverter.</div>`;

    // click/keyboard → detail line
    host.querySelectorAll(".sb-inv").forEach(node => {
      const show = () => {
        const d = node.dataset;
        const bits = [
          d.model && `model ${d.model}`, d.np, d.power,
          d.win, d.mode && `mode ${d.mode}`,
          d.diag
        ].filter(Boolean).join(" · ");
        const foot = document.getElementById("sbFoot");
        if(foot) foot.innerHTML = `<b>${esc(d.name)}</b> — <span class="sb-foot-status ${STATUS_CLASS[d.status]||'ok'}">${esc(STATUS_LABEL[d.status]||d.status)}</span> · ${esc(bits)}`;
        host.querySelectorAll(".sb-inv.sel").forEach(n=>n.classList.remove("sel"));
        node.classList.add("sel");
      };
      node.addEventListener("click", show);
      node.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" ") { e.preventDefault(); show(); } });
    });

    wireAddButton(host);
    wireDrag(host);
  }

  /* ---- '+ Add array' button wiring ---- */
  function wireAddButton(host){
    const btn = host.querySelector("#sbAddArray");
    if(btn) btn.onclick = openAddArrayModal;
  }

  /* ---- HTML5 drag-to-reorder of array columns (whole column moves) ---- */
  function getDragAfter(canvas, x){
    const els = [...canvas.querySelectorAll(".sb-col:not(.dragging)")];
    let best = { dist: -Infinity, el: null };
    els.forEach(el => {
      const box = el.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;   // negative = cursor left of this col's center
      if(offset < 0 && offset > best.dist) best = { dist: offset, el };
    });
    return best.el;
  }
  function wireDrag(host){
    const canvas = host.querySelector(".sb-canvas");
    if(!canvas) return;
    let dragEl = null;
    canvas.querySelectorAll(".sb-col").forEach(col => {
      col.addEventListener("dragstart", e => {
        dragEl = col;
        canvas.classList.add("dragging-active");
        // let the lift styling paint before the drag image snapshots
        requestAnimationFrame(() => col.classList.add("dragging"));
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", col.dataset.arrayId || ""); } catch(_){}
      });
      col.addEventListener("dragend", () => {
        col.classList.remove("dragging");
        canvas.classList.remove("dragging-active");
        dragEl = null;
        saveOrder(canvas);
      });
    });
    canvas.addEventListener("dragover", e => {
      if(!dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = getDragAfter(canvas, e.clientX);
      if(after == null) canvas.appendChild(dragEl);
      else if(after !== dragEl) canvas.insertBefore(dragEl, after);
    });
    canvas.addEventListener("drop", e => e.preventDefault());
  }

  function load(){
    const host = document.getElementById("sandbox");
    if(!host) return;
    let session = null;
    try { session = localStorage.getItem(SESSION_KEY); } catch(e){}
    host.innerHTML = `<div class="sb-empty">Loading your fleet tree…</div>`;

    if(!session){
      // Anonymous — show the demo tree so the structure still reads.
      fetch("fleet-tree-demo.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render)
        .catch(()=>{ host.innerHTML = `<div class="sb-empty">Sign in to see your live fleet tree. <a href="onboarding.html" style="color:var(--good)">Get started →</a></div>`; });
      return;
    }
    fetch("/v1/array-owners/fleet-tree", { headers: { Authorization: "Bearer " + session } })
      .then(r => { if(!r.ok) throw new Error("fleet-tree " + r.status); return r.json(); })
      .then(render)
      .catch(() => {
        fetch("fleet-tree-demo.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render)
          .catch(()=>{ host.innerHTML = `<div class="sb-empty">Couldn't load your fleet tree — please refresh.</div>`; });
      });
  }

  /* ===========================================================================
   * ADD-ARRAY MODAL — dark-skinned vendor picker. Mirrors the onboarding wizard's
   * connect step, but authed with the existing so_session and pointed at the
   * already-deployed connect endpoints. On success it re-loads the fleet tree.
   * ==========================================================================*/
  let _ov = null, _escH = null;
  function ensureOv(){
    if(_ov) return _ov;
    _ov = document.createElement("div");
    _ov.className = "sb-ov";
    document.body.appendChild(_ov);
    return _ov;
  }
  function closeAddModal(){
    if(!_ov) return;
    _ov.classList.remove("open");
    _ov.innerHTML = "";
    if(_escH){ document.removeEventListener("keydown", _escH); _escH = null; }
  }

  function openAddArrayModal(){
    const ov = ensureOv();
    let vendor = "solaredge";
    const fields = {};                 // field name -> current value

    ov.innerHTML = `
      <div class="sb-modal" role="dialog" aria-modal="true" aria-label="Add an array">
        <div class="sb-modal-head">
          <div class="sb-modal-title">Add an array</div>
          <button class="sb-modal-x" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="sb-modal-body">
          <p class="sb-modal-lede">Pick your monitoring platform and connect. SolarEdge unlocks every site on your account with one key; Locus, Fronius and SMA connect per array.</p>
          <div class="sb-vendgrid" id="sbVendGrid"></div>
          <div id="sbVendFields"></div>
          <div class="sb-note" id="sbNote"></div>
        </div>
        <div class="sb-modal-foot">
          <button class="sb-mbtn ghost" type="button" id="sbCancel">Cancel</button>
          <button class="sb-mbtn primary" type="button" id="sbConnect" disabled>Connect</button>
        </div>
      </div>`;
    ov.classList.add("open");

    const grid = ov.querySelector("#sbVendGrid");
    const fieldsBox = ov.querySelector("#sbVendFields");
    const note = ov.querySelector("#sbNote");
    const connectBtn = ov.querySelector("#sbConnect");

    function renderGrid(){
      grid.innerHTML = VENDORS.map(vd => {
        const sel = vd.code===vendor ? " sel" : "";
        const soon = vd.available ? "" : " soon";
        const tag = vd.discover ? `<span class="vtag">1 key</span>` : (vd.available ? "" : `<span class="vtag">soon</span>`);
        return `<button type="button" class="sb-vend${sel}${soon}" data-code="${esc(vd.code)}" ${vd.available?"":'aria-disabled="true"'}>
          ${tag}<span class="vn">${esc(vd.label)}</span><span class="vmeta">${esc(vd.meta||"")}</span>
        </button>`;
      }).join("");
      grid.querySelectorAll(".sb-vend").forEach(b => {
        b.onclick = () => {
          const vd = vendorByCode(b.dataset.code);
          if(!vd.available) return;
          vendor = vd.code;
          note.className = "sb-note"; note.textContent = "";
          renderGrid(); renderFields();
        };
      });
    }

    function renderFields(){
      const v = vendorByCode(vendor);
      // f.help / v.note carry trusted markup copied from onboarding — inject raw.
      const flds = (v.fields||[]).map(f => `
        <label class="sb-fld">
          <span class="lab">${esc(f.label)}</span>
          ${f.hint?`<span class="hint">${esc(f.hint)}</span>`:""}
          <input type="text" autocomplete="off" spellcheck="false" data-name="${esc(f.name)}"
                 placeholder="${esc(f.ph||"")}" value="${esc(fields[f.name]||"")}">
          ${f.help?`<div class="help">${f.help}</div>`:""}
        </label>`).join("");
      fieldsBox.innerHTML = flds + (v.note ? `<div class="sb-vendnote">${v.note}</div>` : "");
      fieldsBox.querySelectorAll("input[data-name]").forEach(inp => {
        inp.oninput = () => { fields[inp.dataset.name] = inp.value; validate(); };
      });
      connectBtn.textContent = v.available ? (v.discover ? "Discover & connect" : "Connect array") : "Not available yet";
      validate();
    }

    function validate(){
      const v = vendorByCode(vendor);
      if(!v.available){ connectBtn.disabled = true; return; }
      let ok;
      if(v.discover) ok = (fields.apiKey||"").trim().length > 3;
      else ok = (v.fields||[]).every(f => /optional/i.test(f.label) || (fields[f.name]||"").trim().length > 0);
      connectBtn.disabled = !ok;
    }

    async function submitConnect(){
      const v = vendorByCode(vendor);
      if(!v.available) return;
      const session = getSession();
      if(!session){
        note.className = "sb-note err";
        note.innerHTML = `Please sign in first — <a href="onboarding.html">get started →</a>, then come back to add arrays.`;
        return;
      }
      // build config (apiKey -> api_key), mirroring onboarding
      const config = {};
      (v.fields||[]).forEach(f => {
        const val = (fields[f.name]||"").trim();
        if(val) config[f.name==="apiKey" ? "api_key" : f.name] = val;
      });

      let url, body;
      if(vendor==="solaredge"){
        url = "/v1/array-owners/solaredge/connect-account";
        body = { api_key: config.api_key };
      } else if(vendor==="locus" && (fields.partner_id||"").trim()){
        url = "/v1/array-owners/locus/connect-account";
        body = { client_id: fields.client_id, client_secret: fields.client_secret,
                 username: fields.username, password: fields.password,
                 partner_id: parseInt(fields.partner_id, 10) };
      } else {
        url = "/v1/array-owners/connect-single";
        body = { vendor, config };
      }

      note.className = "sb-note";
      note.textContent = v.discover ? `Reaching your ${v.label} account…` : `Connecting your ${v.label} system…`;
      connectBtn.disabled = true;
      try{
        const r = await fetch(url, {
          method:"POST",
          headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+session },
          body: JSON.stringify(body)
        });
        let data = {}; try { data = await r.json(); } catch(e){}
        if(r.status===401){
          note.className = "sb-note err";
          note.innerHTML = `Your session expired — <a href="onboarding.html">sign in again →</a> to add this array.`;
          connectBtn.disabled = false; return;
        }
        const ok = r.ok && (data.connected || data.created || data.matched || data.ok || data.array_id);
        if(ok){
          closeAddModal();
          load();   // re-fetch + re-render so the new array column appears immediately
          return;
        }
        note.className = "sb-note err";
        note.textContent = (data && (data.message || data.detail)) ||
          `Couldn't connect that ${v.label} account (HTTP ${r.status}). Double-check the credentials and try again.`;
        connectBtn.disabled = false;
      }catch(err){
        note.className = "sb-note err";
        note.textContent = "We couldn't reach the connection service just now — check your network and try again.";
        connectBtn.disabled = false;
      }
    }

    ov.querySelector(".sb-modal-x").onclick = closeAddModal;
    ov.querySelector("#sbCancel").onclick = closeAddModal;
    connectBtn.onclick = submitConnect;
    ov.onclick = e => { if(e.target === ov) closeAddModal(); };
    _escH = e => { if(e.key==="Escape") closeAddModal(); };
    document.addEventListener("keydown", _escH);

    renderGrid();
    renderFields();
    const first = ov.querySelector(".sb-vend");
    if(first) try { first.focus(); } catch(e){}
  }

  /* ===========================================================================
   * MASTER ACCOUNT — profile + plan + billing. Fetches GET /v1/account and the
   * billing endpoints (which may 404/empty on a trial — handled gracefully).
   * company-name + email are inline-editable; everything else is display-only.
   * ==========================================================================*/
  let _account = null;                       // last-fetched account (shared with Reports prefill)

  function authHeaders(){ const s = getSession(); return s ? { Authorization: "Bearer " + s } : null; }
  function titleCase(s){ return String(s==null?"":s).replace(/_/g," ").replace(/\b\w/g, c => c.toUpperCase()); }
  function fmtDate(d){ try { return new Date(d).toLocaleDateString([], {month:"short",day:"numeric",year:"numeric"}); } catch(e){ return String(d); } }
  function usdMaybe(n){
    if(n==null) return "—";
    const num = Number(n);
    if(isNaN(num)) return esc(String(n));
    return "$" + num.toLocaleString(undefined, {maximumFractionDigits:2});
  }
  function pick(obj, keys, dflt){
    if(!obj) return dflt;
    for(const k of keys){ if(obj[k]!=null && obj[k]!=="") return obj[k]; }
    return dflt;
  }
  function signInPrompt(){ return `<div class="empty">Sign in to manage your master account. <a href="onboarding.html" style="color:var(--good)">Get started →</a></div>`; }
  function sessionExpired(){ return `<div class="empty">Your session expired — <a href="onboarding.html" style="color:var(--good)">sign in again →</a></div>`; }

  function plainCard(label, valueHTML, subHTML, cls){
    return `<div class="acct-card ${cls||""}">
      <div class="k">${esc(label)}</div>
      <div class="v">${valueHTML}</div>
      ${subHTML ? `<div class="sub">${subHTML}</div>` : ""}
    </div>`;
  }
  function editCard(label, field, value, placeholder){
    return `<div class="acct-card">
      <div class="k">${esc(label)}</div>
      <div class="acct-edit" data-field="${esc(field)}">
        <input type="text" autocomplete="off" spellcheck="false" value="${esc(value||"")}" placeholder="${esc(placeholder||"")}">
        <button class="acct-btn" type="button">Save</button>
      </div>
      <div class="acct-msg"></div>
    </div>`;
  }

  function renderAccount(a){
    const cards = document.getElementById("acctCards");
    if(!cards) return;
    const company  = pick(a, ["company_name","company"], "");
    const operator = pick(a, ["operator_name","name","owner_name"], "");
    const email    = pick(a, ["email","operator_email"], "");
    const plan     = pick(a, ["plan","plan_name","tier"], "Free");
    const status   = pick(a, ["subscription_status","status"], "trial");
    const trialEnds = pick(a, ["trial_ends_at","trial_end","trial_expires_at"], null);
    const onTrial  = a.on_trial === true || a.trial === true || /trial/i.test(String(status));

    let subSub = "", subCls = "";
    if(onTrial){ subCls = "warn"; subSub = trialEnds ? `Free trial — ends ${fmtDate(trialEnds)}` : "Free trial in progress"; }
    else if(/active|paid/i.test(String(status))){ subCls = "good"; subSub = "Subscription active"; }

    cards.innerHTML = [
      editCard("Company", "company", company, "Add your company name"),
      plainCard("Operator", esc(operator || "—")),
      editCard("Email", "email", email, "you@example.com"),
      plainCard("Plan", esc(titleCase(plan)), null, /free/i.test(String(plan)) ? "good" : ""),
      plainCard("Subscription", esc(titleCase(status) || "Active"), subSub, subCls),
    ].join("");
    wireAcctEdits();
  }

  function wireAcctEdits(){
    document.querySelectorAll("#acctCards .acct-edit").forEach(row => {
      const inp = row.querySelector("input");
      const btn = row.querySelector(".acct-btn");
      const msg = row.parentElement.querySelector(".acct-msg");
      const field = row.dataset.field;             // "company" | "email"
      btn.onclick = async () => {
        const val = inp.value.trim();
        if(!val){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Enter a value first."; } return; }
        const h = authHeaders();
        if(!h){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Sign in first."; } return; }
        const url  = field === "company" ? "/v1/account/company-name" : "/v1/account/email";
        const body = field === "company" ? { company_name: val } : { email: val };
        btn.disabled = true;
        if(msg){ msg.className = "acct-msg"; msg.textContent = "Saving…"; }
        try{
          const r = await fetch(url, { method:"POST",
            headers: Object.assign({ "Content-Type":"application/json" }, h),
            body: JSON.stringify(body) });
          if(r.ok){
            if(msg){ msg.className = "acct-msg ok"; msg.textContent = "Saved."; }
            if(_account) _account[field === "company" ? "company_name" : "email"] = val;
          } else {
            if(msg){ msg.className = "acct-msg err"; msg.textContent = `Couldn't save (HTTP ${r.status}) — try again.`; }
          }
        }catch(e){
          if(msg){ msg.className = "acct-msg err"; msg.textContent = "Couldn't save — check your connection."; }
        }
        btn.disabled = false;
      };
    });
  }

  async function renderBilling(h){
    const box = document.getElementById("billingCards");
    const actions = document.getElementById("billingActions");
    if(!box) return;
    box.innerHTML = `<div class="empty">Loading billing…</div>`;

    let summary = null, invoice = null;
    try { const r = await fetch("/v1/account/billing-summary", { headers: h }); if(r.ok) summary = await r.json(); } catch(e){}
    try { const r = await fetch("/v1/account/next-invoice",   { headers: h }); if(r.ok) invoice = await r.json(); } catch(e){}

    const cards = [];
    const plan       = pick(summary, ["plan","plan_name"], null);
    const arrayCount = pick(summary, ["array_count","arrays_count","arrays"], null);
    const tier       = pick(summary, ["per_array_price","price_tier","tier","rate"], null);
    const monthly    = pick(summary, ["monthly_total","amount_due","total","mrr"], null);

    if(plan != null)       cards.push(plainCard("Plan", esc(titleCase(String(plan)))));
    if(arrayCount != null) cards.push(plainCard("Arrays connected", esc(String(arrayCount))));
    if(tier != null)       cards.push(plainCard("Price tier", typeof tier === "number" ? `${usdMaybe(tier)} <small>/ array / mo</small>` : esc(String(tier))));
    if(monthly != null)    cards.push(plainCard("Monthly total", usdMaybe(monthly)));

    const invAmt = invoice ? pick(invoice, ["amount_due","total","amount"], null) : null;
    if(invAmt != null){
      const invDate = pick(invoice, ["due_date","date","next_payment_date","period_end"], null);
      cards.push(plainCard("Next invoice", `${usdMaybe(invAmt)}${invDate ? ` <small>· ${fmtDate(invDate)}</small>` : ""}`));
    }

    box.innerHTML = cards.length ? cards.join("")
      : `<div class="acct-card"><div class="k">Billing</div><div class="v">You're on a free trial</div>
           <div class="sub">No invoices yet — your first array is free, and we only bill from the second. Add a card whenever you're ready to scale.</div></div>`;

    // Manage-billing button: portal if a card already exists, otherwise add-payment-method.
    const sStatus = String(pick(summary, ["subscription_status","status"], "") || "");
    const hasCard = (summary && (summary.has_payment_method === true || summary.has_card === true))
      || /active|past_due|paid|trialing/i.test(sStatus);
    if(actions){
      actions.innerHTML = `<button class="acct-btn primary" id="billManage" type="button">${hasCard ? "Manage billing / update card" : "Manage billing / add card"}</button>
        <div class="acct-msg" id="billMsg"></div>`;
      const btn = document.getElementById("billManage");
      if(btn) btn.onclick = () => manageBilling(hasCard);
    }
  }

  async function manageBilling(hasCard){
    const h = authHeaders();
    const msg = document.getElementById("billMsg");
    const btn = document.getElementById("billManage");
    if(!h){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Sign in first."; } return; }
    if(msg){ msg.className = "acct-msg"; msg.textContent = "Opening secure billing…"; }
    if(btn) btn.disabled = true;
    try{
      let url = null;
      if(hasCard){
        const r = await fetch("/v1/account/billing-portal", { headers: h });
        const d = await r.json().catch(() => ({}));
        if(r.ok) url = pick(d, ["url","portal_url","checkout_url"], null);
      } else {
        const r = await fetch("/v1/account/add-payment-method", { method:"POST",
          headers: Object.assign({ "Content-Type":"application/json" }, h), body: "{}" });
        const d = await r.json().catch(() => ({}));
        if(r.ok) url = pick(d, ["checkout_url","url"], null);
      }
      if(url){ window.location = url; return; }
      if(msg){ msg.className = "acct-msg err"; msg.textContent = "Billing isn't available just yet — please try again shortly."; }
    }catch(e){
      if(msg){ msg.className = "acct-msg err"; msg.textContent = "Couldn't reach billing — check your connection and try again."; }
    }
    if(btn) btn.disabled = false;
  }

  async function loadAccount(){
    const cards = document.getElementById("acctCards");
    if(!cards) return;
    const h = authHeaders();
    if(!h){
      cards.innerHTML = signInPrompt();
      const box = document.getElementById("billingCards"); if(box) box.innerHTML = "";
      const act = document.getElementById("billingActions"); if(act) act.innerHTML = "";
      return;
    }
    cards.innerHTML = `<div class="empty">Loading your account…</div>`;
    try{
      const r = await fetch("/v1/account", { headers: h });
      if(r.status === 401){ cards.innerHTML = sessionExpired(); return; }
      if(!r.ok) throw new Error("account " + r.status);
      _account = await r.json();
      renderAccount(_account);
    }catch(e){
      cards.innerHTML = `<div class="empty">Couldn't load your account right now — please refresh.</div>`;
    }
    renderBilling(h);
  }

  /* ===========================================================================
   * REPORTS — honest placeholder. Prefills the send-to email from the account.
   * Nothing is sent; the cadence selector just records intent for later.
   * ==========================================================================*/
  function loadReports(){
    const email = document.getElementById("repEmail");
    if(!email) return;
    const apply = a => { if(a && !email.value){ const e = pick(a, ["email","operator_email"], ""); if(e) email.value = e; } };
    if(_account){ apply(_account); return; }
    const h = authHeaders();
    if(!h) return;
    fetch("/v1/account", { headers: h }).then(r => r.ok ? r.json() : null)
      .then(a => { if(a){ _account = a; apply(a); } }).catch(() => {});
  }

  /* ===========================================================================
   * THREE-TAB SYSTEM — Master Account (#account) · Arrays (#arrays, DEFAULT) ·
   * Reports (#reports). Anything else (empty hash, old #sandbox / #dashboard /
   * #fleet / #pricing links) resolves to Arrays for backward compatibility.
   * ==========================================================================*/
  const TABS = {
    account: { panel: "panelAccount", tab: "tabAccount" },
    arrays:  { panel: "panelArrays",  tab: "tabArrays"  },
    reports: { panel: "panelReports", tab: "tabReports" },
  };
  function tabFromHash(){
    const h = location.hash;
    if(h === "#account") return "account";
    if(h === "#reports") return "reports";
    return "arrays";   // #arrays + empty + legacy #sandbox/#dashboard/#fleet/#pricing
  }

  let _firstApply = true;
  function applyView(){
    const active = tabFromHash();
    Object.keys(TABS).forEach(name => {
      const t = TABS[name];
      const panel = document.getElementById(t.panel);
      const tab   = document.getElementById(t.tab);
      if(panel) panel.classList.toggle("active", name === active);
      if(tab)   tab.classList.toggle("active",   name === active);
    });

    if(active === "arrays"){
      load();                                       // sandbox fleet tree
      // app.js auto-runs loadDashboard() once on parse; only re-run on later switches.
      if(!_firstApply && window.__aoLoadDashboard) window.__aoLoadDashboard();
    } else if(active === "account"){
      loadAccount();
    } else if(active === "reports"){
      loadReports();
    }
    _firstApply = false;
  }
  window.addEventListener("hashchange", applyView);
  document.addEventListener("DOMContentLoaded", applyView);
  // expose for external callers (and post-add reloads)
  window.__sbLoad = load;
})();
