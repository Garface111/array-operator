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
  const ORDER_KEY = "ao_array_order";        // persisted column order (array_id strings) — harmless UI preference
  const RENAME_KEY = "ao_renames";           // persisted inline renames { arrays:{id:name}, inverters:{id:name} }
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

  // ---- saved inline renames (localStorage) ----
  // Owner-edited array / inverter names, keyed by stable id, re-applied every render.
  function loadRenames(){
    try {
      const v = JSON.parse(localStorage.getItem(RENAME_KEY)) || {};
      return { arrays: (v.arrays && typeof v.arrays==="object") ? v.arrays : {},
               inverters: (v.inverters && typeof v.inverters==="object") ? v.inverters : {} };
    } catch(e){ return { arrays:{}, inverters:{} }; }
  }
  function saveRename(kind, id, name){
    if(id==null || id==="") return;
    const all = loadRenames();
    const bucket = all[kind] || (all[kind] = {});
    const v = String(name==null ? "" : name).trim();
    if(v) bucket[String(id)] = v; else delete bucket[String(id)];
    try { localStorage.setItem(RENAME_KEY, JSON.stringify(all)); } catch(e){}
  }
  // Re-apply stored renames to the freshly-rendered DOM (runs on every render).
  function applyRenames(host){
    const all = loadRenames();
    host.querySelectorAll(".sb-col").forEach(col => {
      const nm = all.arrays[String(col.dataset.arrayId)];
      if(nm){ const t = col.querySelector(".sb-array-name"); if(t) t.textContent = nm; }
    });
    host.querySelectorAll(".sb-inv").forEach(card => {
      const nm = all.inverters[String(card.dataset.invId)];
      if(nm){
        const t = card.querySelector(".sb-inv-name");
        if(t) t.textContent = nm;
        card.dataset.name = nm;     // keep detail-line / alerts in sync with the rename
      }
    });
  }

  // ---- inline-rename editing for array & inverter names -------------------
  // Click a name → edit in place (contenteditable). Enter / blur saves the
  // trimmed value to localStorage; Escape or an empty value reverts. While
  // editing we disable the enclosing draggable so a click-to-edit never starts
  // an HTML5 drag, and stop pointer/mouse events from bubbling into drag wiring.
  function wireRenames(host){
    host.querySelectorAll(".sb-array-name").forEach(node =>
      makeEditable(node, "arrays", node.closest(".sb-col"), () =>
        (node.closest(".sb-col")||{}).dataset && node.closest(".sb-col").dataset.arrayId,
        node.closest(".sb-array")));
    host.querySelectorAll(".sb-inv-name").forEach(node => {
      const card = node.closest(".sb-inv");
      makeEditable(node, "inverters", card, () => card && card.dataset.invId, card);
    });
  }

  function makeEditable(node, kind, idEl, getId, dragEl){
    if(!node || node._editWired) return;
    node._editWired = true;
    node.classList.add("sb-editable");

    // don't let a click on the name select/drag the card or pan the canvas
    ["mousedown","pointerdown"].forEach(ev =>
      node.addEventListener(ev, e => e.stopPropagation()));

    node.addEventListener("click", e => {
      e.stopPropagation();
      if(node.isContentEditable) return;
      beginEdit();
    });

    function beginEdit(){
      const original = node.textContent;
      node.dataset.orig = original;
      if(dragEl) dragEl.setAttribute("draggable", "false");
      node.setAttribute("contenteditable", "true");
      node.classList.add("sb-editing");
      node.focus();
      // place caret at end / select all for quick overwrite
      try {
        const r = document.createRange(); r.selectNodeContents(node);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      } catch(_){}

      let done = false;
      const finish = (commit) => {
        if(done) return; done = true;
        node.removeAttribute("contenteditable");
        node.classList.remove("sb-editing");
        if(dragEl) dragEl.setAttribute("draggable", "true");
        node.removeEventListener("keydown", onKey);
        node.removeEventListener("blur", onBlur);
        const val = node.textContent.trim();
        if(commit && val){
          node.textContent = val;
          const id = getId && getId();
          saveRename(kind, id, val);
          if(kind === "inverters" && idEl) idEl.dataset.name = val;   // keep detail-line in sync
        } else {
          node.textContent = node.dataset.orig || original;           // revert (cancel / empty)
        }
        delete node.dataset.orig;
      };
      const onKey = e => {
        e.stopPropagation();
        if(e.key === "Enter"){ e.preventDefault(); node.blur(); }
        else if(e.key === "Escape"){ e.preventDefault(); finish(false); }
      };
      const onBlur = () => finish(true);
      node.addEventListener("keydown", onKey);
      node.addEventListener("blur", onBlur);
    }
  }

  // ---- backend writes (authed, same-origin relative) ----
  // Inverter arrangement is now persisted SERVER-SIDE (reassign/reorder/arrays/reset);
  // there is no browser-local layout. These helpers POST and resolve the JSON body.
  function apiPost(path, body){
    const session = getSession();
    if(!session) return Promise.reject(new Error("no session"));
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+session },
      body: body != null ? JSON.stringify(body) : "{}"
    }).then(r => { if(!r.ok) throw new Error(path + " " + r.status); return r.json().catch(() => ({})); });
  }

  // transient bottom-corner toast (errors / confirmations) — no framework needed
  function toast(msg, kind){
    let t = document.getElementById("sbToast");
    if(!t){ t = document.createElement("div"); t.id = "sbToast"; document.body.appendChild(t); }
    t.className = "sb-toast " + (kind || "") + " show";
    t.textContent = msg;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 3400);
  }

  // dim the canvas + show a "Saving…" note while a backend write is in flight
  function setSaving(msg){
    const canvas = document.querySelector("#sandbox .sb-canvas");
    if(canvas) canvas.classList.add("sb-busy");
    const foot = document.getElementById("sbFoot");
    if(foot) foot.innerHTML = `<span class="sb-saving-note">${esc(msg || "Saving…")}</span>`;
  }
  function clearSaving(){
    const canvas = document.querySelector("#sandbox .sb-canvas");
    if(canvas) canvas.classList.remove("sb-busy");
    setDefaultFoot();
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
    return `<div class="sb-pi"><div class="sb-pi-bar ${cls}" style="width:${pct}%"></div><span class="${cls}">${pi.toFixed(2)}</span></div>`;
  }

  // per-inverter vendor badge (smaller variant of the array brand chip) — empty if unknown
  function brandHTML(vendor){
    return (vendor && BRAND[vendor])
      ? `<span class="sb-brand sb-inv-brand ${esc(vendor)}">${esc(BRAND[vendor])}</span>` : "";
  }
  // refresh the "N inverters" count on a column from its live card count
  function updateColCount(col){
    const n = col.querySelectorAll(".sb-teeth .sb-inv").length;
    const c = col.querySelector(".sb-array-count");
    if(c) c.textContent = `${n} inverter${n===1?'':'s'}`;
  }

  // Footer is empty by default (tip removed — the section subtitle already explains dragging).
  // The #sbFoot element is reused to show a clicked inverter's diagnosis and the "Saving…" note;
  // when empty it collapses via `.sb-foot:empty { display:none }`.
  const DEFAULT_FOOT_HTML = "";
  function setDefaultFoot(){
    const foot = document.getElementById("sbFoot");
    if(foot) foot.innerHTML = DEFAULT_FOOT_HTML;
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
         <div class="sb-head-actions"><div class="sb-head-btns">
           <button class="sb-resetbtn" id="sbNewArray" type="button" title="Create an empty array to drag inverters into">New empty array</button>
           <span class="sb-cardbtn-wrap"><button class="sb-cardbtn" id="sbAddCard" type="button" title="Drop a note or live-metric card onto the canvas">+ Card</button></span>
           <button class="sb-addbtn" id="sbAddArray">+ Add array</button>
         </div></div></div>
         <div class="sb-empty">No arrays connected yet — hit <b>+ Add array</b> to bring your inverters in.</div>`;
      wireAddButton(host);
      wireNewArrayButton(host);
      wireCardButton(host); // "+ Card" menu (Note / Data)
      renderCards();        // fixed cards still show; free cards need a canvas (appear once arrays exist)
      return;
    }

    const summary = tree.summary || {};
    const head = `
      <div class="sb-head">
        <div></div>
        <div class="sb-head-actions">
          <div class="sb-head-btns">
            <button class="sb-resetbtn" id="sbNewArray" type="button" title="Create an empty array to drag inverters into">New empty array</button>
            <button class="sb-resetbtn" id="sbReset" type="button" title="Snap every inverter back to its discovered vendor grouping on the server">Reset layout</button>
            <span class="sb-cardbtn-wrap"><button class="sb-cardbtn" id="sbAddCard" type="button" title="Drop a note or live-metric card onto the canvas">+ Card</button></span>
            <button class="sb-addbtn" id="sbAddArray">+ Add array</button>
          </div>
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
      const srcTag = (col.inverter_source === "live" || col.inverter_source === "solaredge")
        ? `<span class="sb-srctag live">live · per-inverter</span>`
        : col.inverter_source === "array"
          ? `<span class="sb-srctag">array-level</span>`
          : col.inverter_count > 0
            ? `<span class="sb-srctag live">live · per-inverter</span>`
            : `<span class="sb-srctag off">empty</span>`;
      // tier-2 chip: single vendor when uniform, else a "mixed" chip listing the vendors
      // present (a column can now hold mixed-vendor inverters after owner moves).
      let brandChip = "";
      if(col.vendor){
        brandChip = `<span class="sb-brand ${esc(col.vendor)}">${esc(BRAND[col.vendor] || col.vendor)}</span>`;
      } else if(Array.isArray(col.vendors) && col.vendors.length){
        const labels = col.vendors.map(v => BRAND[v] || v).join(" · ");
        brandChip = `<span class="sb-brand mixed" title="${esc(labels)}">mixed · ${esc(labels)}</span>`;
      }

      // bottom comb — one prong per inverter (each individually drag-movable).
      // The drag id is the REAL, server-known inv.inverter_id (stable DB id); the
      // vendor badge is now per-inverter (inv.vendor), since an array can hold a
      // mixed-vendor cohort after owner moves.
      const teeth = invs.length ? invs.map(inv => {
        const sCls = STATUS_CLASS[inv.status] || "ok";
        const np = inv.nameplate_kw!=null ? `${inv.nameplate_kw} kW` : "";
        const power = inv.current_power_w!=null ? `${(inv.current_power_w/1000).toFixed(2)} kW now` : "";
        return `
          <div class="sb-inv ${sCls}" tabindex="0" draggable="true"
               data-inv-id="${esc(inv.inverter_id)}" data-array-id="${esc(col.array_id)}" data-vendor="${esc(inv.vendor||"")}"
               data-name="${esc(inv.name)}" data-status="${esc(inv.status)}"
               data-diag="${esc(inv.diagnosis||"")}" data-model="${esc(inv.model||"")}"
               data-np="${esc(np)}" data-win="${esc(inv.window_kwh!=null?inv.window_kwh+' kWh / 14d':'')}"
               data-mode="${esc(inv.last_mode||"")}" data-power="${esc(power)}">
            <div class="sb-inv-dot"></div>
            <div class="sb-inv-name">${esc(inv.name)}</div>
            <div class="sb-inv-now" data-basew="${inv.current_power_w!=null?inv.current_power_w:''}"><span class="sb-live-dot"></span><b class="sb-now-val">${inv.current_power_w!=null?(inv.current_power_w/1000).toFixed(1):'—'}</b> kW now</div>
            ${peerBar(inv.peer_index)}
            <div class="sb-inv-status ${sCls}">${esc(STATUS_LABEL[inv.status]||inv.status||"")}</div>
            ${brandHTML(inv.vendor)}
          </div>`;
      }).join("")
        : `<div class="sb-comb-empty">Empty array — drag inverters here</div>`;

      return `
        <div class="sb-col" data-array-id="${esc(col.array_id)}" data-vendor="${esc(col.vendor||"")}">
          <!-- TIER 1: Alert -->
          <div class="sb-alert ${aCls}">
            <div class="sb-alert-k">Alerts</div>
            <div class="sb-alert-h">${esc(a.headline||"All clear")}</div>
            <div class="sb-alert-c">${a.count? a.count+' inverter'+(a.count>1?'s':'')+' flagged' : 'nothing to do'}</div>
          </div>
          <div class="sb-link v1 ${aCls}"></div>

          <!-- TIER 2: Array (this node is the column drag handle) -->
          <div class="sb-array" draggable="true">
            <span class="sb-drag" title="Drag to reorder arrays" aria-hidden="true">⠿</span>
            <div class="sb-array-k">Array</div>
            <div class="sb-array-name">${esc(col.array_name)}</div>
            <div class="sb-array-meta"><span class="sb-array-count">${col.inverter_count} inverter${col.inverter_count===1?'':'s'}</span> ${srcTag} ${brandChip}</div>
          </div>
          <div class="sb-link v2"></div>

          <!-- TIER 3: Inverters comb -->
          <div class="sb-comb">
            <div class="sb-bus"></div>
            <div class="sb-teeth">${teeth}</div>
          </div>
        </div>`;
    }).join("");

    host.innerHTML = head + `<div class="sb-viewport"><div class="sb-canvas">${columns}</div></div>
      <div class="sb-foot" id="sbFoot">${DEFAULT_FOOT_HTML}</div>`;

    // click/keyboard → detail line + rich detail card
    host.querySelectorAll(".sb-inv").forEach(node => {
      const show = () => {
        // the rich detail card (showDetailCard) replaces the old one-line #sbFoot detail
        host.querySelectorAll(".sb-inv.sel").forEach(n=>n.classList.remove("sel"));
        node.classList.add("sel");
        showDetailCard(node);
      };
      node.addEventListener("click", show);
      node.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" ") { e.preventDefault(); show(); } });
    });

    wireAddButton(host);
    wireNewArrayButton(host);
    wireResetButton(host);
    wireDrag(host);       // whole-column reorder (drag the .sb-array node)
    wireInvDrag(host);    // per-inverter reorder + cross-array move (PERSISTED to backend)
    applyRenames(host);   // re-apply owner inline renames (array & inverter names)
    wireRenames(host);    // click-to-edit array & inverter names (persisted to localStorage)
    startLiveTicker();    // keep each card's "kW now" reading live
    wirePanZoom(host);    // drag empty space to pan, wheel to zoom the fleet canvas
    wireCardButton(host); // "+ Card" menu (Note / Data)
    renderCards();        // recreate free + fixed owner cards from localStorage (idempotent)
  }

  // ---- live output ticker: updates each card's "kW now" in place. With live
  // telemetry this reflects polled current_power_w; on demo data it drifts gently
  // (~1%) around the last-known value. Each tick also runs the peer-drop alert.
  let _liveTimer = null;
  function startLiveTicker(){
    if(_liveTimer) clearInterval(_liveTimer);
    _liveTimer = setInterval(() => {
      document.querySelectorAll("#sandbox .sb-inv-now").forEach(el => {
        const base = parseFloat(el.dataset.basew);
        if(!base) return;                          // not reporting → leave at — / 0
        const drift = base * (1 + Math.sin(Date.now()/2600 + base) * 0.009 + (Math.random()-0.5)*0.006);
        const v = el.querySelector(".sb-now-val");
        if(!v) return;
        v.textContent = (drift/1000).toFixed(1);
        v.classList.remove("tick"); void v.offsetWidth; v.classList.add("tick");
      });
      checkPeerDrops();
      refreshDataCards();      // keep live-metric data cards in step with the kW ticker
      refreshDetailCard();     // keep the open inverter detail card (kW + lost-$) live too
    }, 2600);
  }

  // ---- auto-alert: flag an inverter that drops beneath its array peers by a
  // significant margin. Specific output (live kW / nameplate kW) is compared to
  // the array's peer median; more than PEER_DROP_MARGIN below it -> alarm. Driven
  // by live telemetry in production, by the demo ticker here. State-tracked so it
  // fires once per drop event (never spams) and clears on recovery.
  const PEER_DROP_MARGIN = 0.25;
  const _dismissed = new Set();        // alert keys the user dismissed (re-armed on recovery)
  let _dropInit = false;               // first pass seeds the baseline silently
  function _liveKW(el){ const v = el.querySelector(".sb-now-val"); return v ? parseFloat(v.textContent) : NaN; }
  function _nameplateKW(el){ const m = (el.dataset.np||"").match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; }
  function checkPeerDrops(){
    const dropped = [];                            // {key,name,arrayName,pct}
    document.querySelectorAll("#sandbox .sb-col").forEach(col => {
      const rows = [...col.querySelectorAll(".sb-inv")].map(el => {
        const np = _nameplateKW(el), kw = _liveKW(el);
        const nowEl = el.querySelector(".sb-inv-now");
        const baseW = nowEl ? parseFloat(nowEl.dataset.basew) : NaN;
        return { el, name: el.dataset.name || "An inverter",
                 liveSO: (np > 0 && isFinite(kw))    ? kw / np           : null,
                 baseSO: (np > 0 && isFinite(baseW)) ? (baseW/1000) / np : null };
      }).filter(r => r.liveSO != null && r.baseSO != null);
      if(rows.length < 2) return;                  // need peers ("friends") to compare against
      // Stable baseline: peer median of NORMAL (base) output, so jitter and one
      // dipping inverter never drag the bar and trip false alarms.
      const baseline = rows.map(r => r.baseSO).sort((a,b) => a-b)[Math.floor(rows.length/2)];
      if(baseline <= 0) return;
      const arrName = (col.querySelector(".sb-array-name") || {}).textContent || "";
      rows.forEach(r => {
        const below = (baseline - r.liveSO) / baseline;   // how far live output is below the peer norm
        if(below >= PEER_DROP_MARGIN){
          r.el.classList.add("sb-inv-alarm");
          dropped.push({ key: arrName + "|" + r.name, name: r.name, arrayName: arrName, pct: Math.round(below*100) });
        } else {
          r.el.classList.remove("sb-inv-alarm");
        }
      });
    });
    reconcileAlertCards(dropped);
  }
  // Persistent alerts host: lives on #sbWrap (which render() never rebuilds), so
  // cards survive fleet re-renders.
  function alertHost(){
    let h = document.getElementById("sbAlerts");
    if(!h){
      h = document.createElement("div");
      h.id = "sbAlerts"; h.className = "sb-alerts"; h.setAttribute("aria-live", "polite");
      (document.getElementById("sbWrap") || document.body).appendChild(h);
    }
    return h;
  }
  // Declarative reconcile: #sbAlerts holds exactly one card per currently-dropped
  // inverter (keyed array|name). Idempotent — no duplicates, recovered drops clear,
  // a dismissed one stays gone until that inverter recovers and drops again.
  function reconcileAlertCards(dropped){
    const host = alertHost();
    const want = new Set(dropped.map(d => d.key));
    [...host.children].forEach(card => { if(!want.has(card.dataset.key)) card.remove(); });
    _dismissed.forEach(k => { if(!want.has(k)) _dismissed.delete(k); });   // recovered → re-arm
    const have = new Set([...host.children].map(c => c.dataset.key));
    dropped.forEach(d => {
      if(have.has(d.key) || _dismissed.has(d.key)) return;
      host.prepend(makeAlertCard(d));
      if(_dropInit) toast(`⚠️ ${d.name} dropped ${d.pct}% below its array peers`, "alert");
    });
    while(host.children.length > 4) host.lastElementChild.remove();
    _dropInit = true;
  }
  function makeAlertCard(d){
    const card = document.createElement("div");
    card.className = "sb-alert-card";
    card.dataset.key = d.key;
    card.innerHTML =
      `<span class="sb-ac-ic">⚠️</span>` +
      `<div class="sb-ac-body"><div class="sb-ac-h">${esc(d.name)} dropped <b>${d.pct}%</b> below its peers</div>` +
      `<div class="sb-ac-sub">${esc(d.arrayName)} · live telemetry</div></div>` +
      `<button class="sb-ac-x" type="button" title="Dismiss" aria-label="Dismiss alert">×</button>`;
    card.querySelector(".sb-ac-x").onclick = () => { _dismissed.add(d.key); card.remove(); };
    return card;
  }

  // ---- selected-inverter DETAIL CARD ----
  // Persistent host on #sbWrap (survives fleet re-renders, like #sbAlerts), pinned
  // bottom-RIGHT of the viewport so it never overlaps the bottom-left alert cards.
  function detailHost(){
    let h = document.getElementById("sbDetail");
    if(!h){
      h = document.createElement("div");
      h.id = "sbDetail"; h.className = "sb-detail-host"; h.setAttribute("aria-live", "polite");
      (document.getElementById("sbWrap") || document.body).appendChild(h);
    }
    return h;
  }
  // Which inverter the open detail card is bound to (matched by stable data-inv-id
  // so it survives fleet re-renders that re-create the .sb-inv element), plus the
  // live "lost so far" $ accumulator state for that card. Cleared when the card is
  // dismissed or its inverter disappears.
  let _detailInvId = null;
  let _detailLost = 0;            // running $ lost since this card opened
  let _detailLostTs = 0;         // last tick time (ms) the accumulator advanced

  // Statuses that always count as "losing money" for the lost-$ figure.
  const LOST_STATES = new Set(["underperforming", "comm_gap", "dead", "fault"]);
  // Demo energy value used to translate missing kW into $ lost. ~$0.24/kWh is a
  // believable blended retail + incentive value for residential/commercial solar.
  const LOST_RATE_PER_KWH = 0.24;
  // Demo time-compression: a real 2.6s tick advances the lost-$ clock by this many
  // simulated minutes so the figure visibly ticks upward instead of crawling at
  // wall-clock rate. (Demo only — production drives this from real elapsed energy.)
  const LOST_DEMO_MIN_PER_TICK = 6;

  // Find the currently-selected .sb-inv. The demo data has no unique inverter_id,
  // so we track by a stable (array name | inverter name) key instead.
  function _invKey(node){
    const col = node.closest(".sb-col");
    const arr = col ? ((col.querySelector(".sb-array-name")||{}).textContent || "") : "";
    const name = node.dataset.name || (node.querySelector(".sb-inv-name")||{}).textContent || "";
    return arr.trim() + " || " + name.trim();
  }
  function _selectedInv(){
    if(_detailInvId == null) return null;
    return [...document.querySelectorAll("#sandbox .sb-inv")].find(el => _invKey(el) === _detailInvId) || null;
  }

  // Estimate the kW this inverter is *missing* vs. where it should be: the most of
  // (peer-median expectation) and (nameplate-implied expectation), minus its live
  // output. A non-reporting inverter (dead / comm_gap → live "—") counts as 0 kW
  // out, so it's missing its whole expected production. Returns 0 for a healthy
  // inverter that's keeping up with its peers.
  function _missingKW(node, flagged){
    let live = _liveKW(node);                                    // live kW (from .sb-now-val)
    if(!isFinite(live)) live = 0;                                // not reporting → producing nothing
    const col = node.closest(".sb-col");
    let expected = live;
    if(col){
      // peer expectation: median live kW of same-array peers that are reporting
      const peers = [...col.querySelectorAll(".sb-inv")]
        .map(_liveKW).filter(v => isFinite(v) && v > 0).sort((a,b) => a-b);
      if(peers.length >= 2){
        const med = peers[Math.floor(peers.length/2)];
        if(med > expected) expected = med;
      }
    }
    // nameplate-implied floor (only for an inverter already flagged down): one with
    // no reporting peers should still show a loss. Assume a modest ~30% of nameplate
    // as the "should-be" mid-day baseline so the demo figure stays believable.
    if(flagged){
      const np = _nameplateKW(node);
      if(isFinite(np) && np > 0){
        const npExpected = np * 0.30;
        if(npExpected > expected) expected = npExpected;
      }
    }
    const miss = expected - live;
    return miss > 0.01 ? miss : 0;
  }

  // Build/replace the detail card for the clicked .sb-inv card. Owner-framed: what
  // an array owner wants to know about one inverter at a glance. The kW-now value,
  // status pill, peer index and "lost so far" $ are LIVE — refreshDetailCard()
  // (driven by startLiveTicker) updates them in place each tick.
  function showDetailCard(node){
    const host = detailHost();
    const d = node.dataset;
    const liveEl = node.querySelector(".sb-now-val");
    const live = liveEl ? liveEl.textContent : null;
    const liveStr = (live && live !== "—") ? `${live} kW now` : (d.power || "— kW now");
    const piEl = node.querySelector(".sb-pi span");
    const pi = piEl ? piEl.textContent.trim() : "";
    const col = node.closest(".sb-col");
    const arrayName = col ? (col.querySelector(".sb-array-name") || {}).textContent || "" : "";
    const sCls = STATUS_CLASS[d.status] || "ok";
    const sLabel = STATUS_LABEL[d.status] || d.status || "";

    // bind the live updater to this inverter and reset the lost-$ accumulator
    _detailInvId = _invKey(node);          // unique (array|name) key — demo has no unique inverter_id
    _detailLost = 0;
    _detailLostTs = Date.now();

    const rows = [
      pi && `<div class="sb-dc-row"><span class="sb-dc-k">Peer index</span><span class="sb-dc-v"><b class="dc-pi ${sCls}">${esc(pi)}</b> vs its peers</span></div>`,
      d.np && `<div class="sb-dc-row"><span class="sb-dc-k">Nameplate</span><span class="sb-dc-v">${esc(d.np)}</span></div>`,
      d.win && `<div class="sb-dc-row"><span class="sb-dc-k">Last 14 days</span><span class="sb-dc-v">${esc(d.win)}</span></div>`,
      d.mode && `<div class="sb-dc-row"><span class="sb-dc-k">Mode</span><span class="sb-dc-v">${esc(d.mode)}</span></div>`,
      d.model && `<div class="sb-dc-row"><span class="sb-dc-k">Model</span><span class="sb-dc-v">${esc(d.model)}</span></div>`,
    ].filter(Boolean).join("");

    const card = el(`
      <div class="sb-detail-card" role="dialog" aria-label="Inverter detail">
        <button class="sb-dc-x" type="button" title="Dismiss" aria-label="Close detail">×</button>
        <div class="sb-dc-head">
          <div class="sb-dc-name">${esc(d.name)}</div>
          <div class="sb-dc-array">${esc(arrayName)}</div>
        </div>
        <div class="sb-dc-now"><span class="sb-live-dot"></span><b class="dc-kw">${esc(liveStr)}</b></div>
        <div class="sb-dc-pill dc-pill ${sCls}">${esc(sLabel)}</div>
        <div class="sb-dc-lost" hidden><span class="sb-dc-lost-k">Lost so far</span><b class="dc-lost">$0</b></div>
        <div class="sb-dc-rows">${rows}</div>
        ${d.diag ? `<div class="sb-dc-diag">${esc(d.diag)}</div>` : ""}
      </div>`);
    card.querySelector(".sb-dc-x").onclick = () => {
      card.remove();
      _detailInvId = null;               // stop live updates for this card
      document.querySelectorAll("#sandbox .sb-inv.sel").forEach(n => n.classList.remove("sel"));
      setDefaultFoot();
    };
    host.innerHTML = "";
    host.appendChild(card);
    refreshDetailCard();                 // seed the live figures immediately
  }

  // Live-refresh the open detail card in place (called each ticker tick). Re-reads
  // the selected inverter's current kW / status / peer index and advances the
  // "lost so far" $ accumulator. No-op (and a graceful stop) when no card is open
  // or the selected inverter has gone away.
  function refreshDetailCard(){
    const host = document.getElementById("sbDetail");
    const card = host ? host.querySelector(".sb-detail-card") : null;
    if(!card){ _detailInvId = null; return; }      // card dismissed → nothing to update
    if(_detailInvId == null) return;               // no inverter bound

    const node = _selectedInv();
    if(!node){                                     // inverter removed / deselected → stop gracefully
      _detailInvId = null;
      return;
    }
    const d = node.dataset;

    // 1) live kW now
    const liveEl = node.querySelector(".sb-now-val");
    const live = liveEl ? liveEl.textContent : null;
    const kwEl = card.querySelector(".dc-kw");
    if(kwEl){
      const liveStr = (live && live !== "—") ? `${live} kW now` : (d.power || "— kW now");
      if(kwEl.textContent !== liveStr) kwEl.textContent = liveStr;
    }

    // 2) status pill (label + class) can change as the inverter recovers / drops
    const sCls = STATUS_CLASS[d.status] || "ok";
    const sLabel = STATUS_LABEL[d.status] || d.status || "";
    const pill = card.querySelector(".dc-pill");
    if(pill){
      pill.className = "sb-dc-pill dc-pill " + sCls;
      if(pill.textContent !== sLabel) pill.textContent = sLabel;
    }

    // 3) peer index value + class
    const piEl = node.querySelector(".sb-pi span");
    const pi = piEl ? piEl.textContent.trim() : "";
    const piOut = card.querySelector(".dc-pi");
    if(piOut && pi){
      piOut.className = "dc-pi " + sCls;
      if(piOut.textContent !== pi) piOut.textContent = pi;
    }

    // 4) live "lost so far" $ — accumulate missing kW × rate × elapsed hours.
    // Underperforming/down inverters (by status OR a live peer shortfall) tick up;
    // healthy ones show $0 and the row is hidden. Wall-clock elapsed is scaled by
    // the demo time-compression so the figure visibly advances each tick.
    const now = Date.now();
    const wallHr = Math.max(0, (now - _detailLostTs) / 3600000);
    _detailLostTs = now;
    // map ~2.6s of wall time onto LOST_DEMO_MIN_PER_TICK simulated minutes
    const dtHr = wallHr * ((LOST_DEMO_MIN_PER_TICK * 60) / 2.6);
    const flaggedByState = LOST_STATES.has(d.status) || node.classList.contains("sb-inv-alarm");
    const missKW = _missingKW(node, flaggedByState);
    // only accumulate when the inverter is genuinely under (flagged or a real shortfall)
    if(dtHr > 0 && missKW > 0 && (flaggedByState || missKW >= 0.5)){
      _detailLost += missKW * LOST_RATE_PER_KWH * dtHr;
    }
    const lostRow = card.querySelector(".sb-dc-lost");
    const lostOut = card.querySelector(".dc-lost");
    if(lostRow && lostOut){
      if(_detailLost > 0){
        lostRow.hidden = false;
        const txt = "$" + _detailLost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if(lostOut.textContent !== txt){
          lostOut.textContent = txt;
          lostOut.classList.remove("tick"); void lostOut.offsetWidth; lostOut.classList.add("tick");
        }
      } else {
        lostRow.hidden = true;       // healthy → omit the $ figure
      }
    }
  }


  /* ===========================================================================
   * FREE-FORM OWNER CARDS — note cards (editable sticky) + data cards (live
   * metric) the owner can drop onto the canvas. Two placement modes:
   *   free  → rendered INTO .sb-canvas, so the card pans/zooms WITH the fleet
   *           (x/y stored in canvas coordinates). Recreated at the end of every
   *           render() (the canvas is rebuilt each render — idempotent rebuild).
   *   fixed → rendered into a persistent #sbCardsFixed layer on #sbWrap, pinned
   *           to the panel (x/y in panel pixels); survives re-renders like #sbAlerts.
   * A pin toggle flips a card free↔fixed (its x/y is re-seeded near viewport
   * center on the flip so it never lands off-screen). All cards persist to
   * localStorage under CARDS_KEY as {id,kind,mode,x,y,text?,title?,metric?}.
   * ==========================================================================*/
  const CARDS_KEY = "ao_cards";
  // Live-fleet metrics, computed from the rendered .sb-inv DOM each tick.
  const ATTENTION_STATES = new Set(["warn","underperforming","comm_gap","dead","fault"]);
  const CARD_METRICS = {
    fleet_now:  { label:"Fleet output now", unit:"kW",   compute: fleetNowKW },
    attention:  { label:"Needs attention",  unit:"",     compute: needsAttention },
    capacity:   { label:"Total capacity",   unit:"kW",   compute: totalCapacityKW },
    arrays:     { label:"Arrays",           unit:"",     compute: arrayCount },
  };
  const METRIC_ORDER = ["fleet_now","attention","capacity","arrays"];

  function _invNowKW(inv){
    // Prefer the live ticker's displayed value; fall back to the seeded base watts.
    const v = inv.querySelector(".sb-now-val");
    const live = v ? parseFloat(v.textContent) : NaN;
    if(isFinite(live)) return live;
    const nowEl = inv.querySelector(".sb-inv-now");
    const baseW = nowEl ? parseFloat(nowEl.dataset.basew) : NaN;
    return isFinite(baseW) ? baseW/1000 : 0;
  }
  function _invNpKW(inv){ const m = (inv.dataset.np||"").match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; }
  function fleetNowKW(){
    let s = 0; document.querySelectorAll("#sandbox .sb-inv").forEach(inv => { const k = _invNowKW(inv); if(isFinite(k)) s += k; });
    return s.toFixed(1);
  }
  function needsAttention(){
    let n = 0; document.querySelectorAll("#sandbox .sb-inv").forEach(inv => { if(ATTENTION_STATES.has(inv.dataset.status)) n++; });
    return String(n);
  }
  function totalCapacityKW(){
    let s = 0; document.querySelectorAll("#sandbox .sb-inv").forEach(inv => { const k = _invNpKW(inv); if(isFinite(k)) s += k; });
    return (Math.round(s*10)/10).toString();
  }
  function arrayCount(){ return String(document.querySelectorAll("#sandbox .sb-col").length); }

  // ---- card storage (localStorage; mirrors saveOrder / saveRename style) ----
  function loadCards(){
    try {
      const v = JSON.parse(localStorage.getItem(CARDS_KEY));
      return Array.isArray(v) ? v.filter(c => c && c.id && (c.kind==="note"||c.kind==="data")) : [];
    } catch(e){ return []; }
  }
  function saveCards(cards){
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); } catch(e){}
  }
  function updateCard(id, patch){
    const cards = loadCards();
    const c = cards.find(x => x.id === id);
    if(!c) return;
    Object.assign(c, patch);
    saveCards(cards);
  }
  function removeCard(id){ saveCards(loadCards().filter(c => c.id !== id)); }
  function newCardId(){ return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

  // Persistent fixed-card layer on #sbWrap (survives re-renders, like #sbAlerts).
  function fixedCardHost(){
    let h = document.getElementById("sbCardsFixed");
    if(!h){
      h = document.createElement("div");
      h.id = "sbCardsFixed"; h.className = "sb-cards-fixed";
      (document.getElementById("sbWrap") || document.body).appendChild(h);
    }
    return h;
  }

  // Pick a sensible spawn point near the viewport center.
  // mode=free → canvas coords (invert the pan/zoom transform). mode=fixed → panel px.
  function centerFor(mode){
    const wrap = document.getElementById("sbWrap");
    const vp = document.querySelector("#sandbox .sb-viewport");
    if(mode === "fixed"){
      const wr = wrap ? wrap.getBoundingClientRect() : { width:600, height:400 };
      return { x: Math.max(12, wr.width/2 - 105), y: Math.max(12, wr.height/2 - 70) };
    }
    // free: map viewport-center screen point back through _view (translate+scale)
    if(vp){
      const cx = vp.clientWidth/2, cy = vp.clientHeight/2;
      return { x: (cx - _view.x)/_view.z - 105, y: (cy - _view.y)/_view.z - 70 };
    }
    return { x: 40, y: 40 };
  }

  // ---- "+ Card" head button → small Note/Data menu ----
  function wireCardButton(host){
    const btn = host.querySelector("#sbAddCard");
    if(!btn) return;
    const wrap = btn.closest(".sb-cardbtn-wrap") || btn.parentElement;
    btn.onclick = e => {
      e.stopPropagation();
      if(wrap.querySelector(".sb-card-menu")){ closeCardMenu(); return; }
      const menu = el(`<div class="sb-card-menu" role="menu">
        <button type="button" data-kind="note" role="menuitem">Note<span class="mk-sub">Editable sticky note</span></button>
        <button type="button" data-kind="data" role="menuitem">Data<span class="mk-sub">Live fleet metric</span></button>
      </div>`);
      menu.addEventListener("click", ev => ev.stopPropagation());
      menu.querySelectorAll("button[data-kind]").forEach(b => {
        b.onclick = () => { addCard(b.dataset.kind); closeCardMenu(); };
      });
      wrap.appendChild(menu);
      setTimeout(() => document.addEventListener("click", closeCardMenu, { once:true }), 0);
    };
  }
  function closeCardMenu(){
    document.querySelectorAll(".sb-card-menu").forEach(m => m.remove());
  }

  // Create a brand-new card (default free), persist it, and render it.
  function addCard(kind){
    const pos = centerFor("free");
    const card = {
      id: newCardId(), kind, mode: "free",
      x: Math.round(pos.x), y: Math.round(pos.y),
    };
    if(kind === "note"){ card.title = ""; card.text = ""; }
    else { card.metric = "fleet_now"; }
    const cards = loadCards(); cards.push(card); saveCards(cards);
    renderCards();
    refreshDataCards();
  }

  // ---- reconcile cards into the canvas (free) + fixed layer (idempotent) ----
  function renderCards(){
    const canvas = document.querySelector("#sandbox .sb-canvas");
    const fixed = fixedCardHost();
    const cards = loadCards();
    const wantFree = new Set(), wantFixed = new Set();
    cards.forEach(c => (c.mode === "fixed" ? wantFixed : wantFree).add(c.id));

    // drop stale nodes
    if(canvas) [...canvas.querySelectorAll(":scope > .sb-card")].forEach(n => { if(!wantFree.has(n.dataset.cardId)) n.remove(); });
    [...fixed.querySelectorAll(":scope > .sb-card")].forEach(n => { if(!wantFixed.has(n.dataset.cardId)) n.remove(); });

    cards.forEach(c => {
      const layer = c.mode === "fixed" ? fixed : canvas;
      if(!layer) return;                       // free card with no canvas yet (empty fleet) — skip
      let node = layer.querySelector(`:scope > .sb-card[data-card-id="${c.id}"]`);
      if(node){ positionCard(node, c); }       // already present → just keep position synced
      else { layer.appendChild(buildCardNode(c)); }
    });
    refreshDataCards();
  }

  function positionCard(node, c){
    node.style.left = (c.x||0) + "px";
    node.style.top  = (c.y||0) + "px";
  }

  function buildCardNode(c){
    const node = el(`<div class="sb-card" data-card-id="${esc(c.id)}" data-kind="${esc(c.kind)}" draggable="false"></div>`);
    // a pointerdown anywhere on a card must never reach the viewport pan handler
    node.addEventListener("pointerdown", e => e.stopPropagation());
    positionCard(node, c);
    const pinned = c.mode === "fixed";
    const bar = el(`<div class="sb-card-bar">
        <span class="sb-card-grip" aria-hidden="true">⠿</span>
        <span class="sb-card-kind">${c.kind === "note" ? "Note" : "Data"}</span>
        <button class="sb-card-btn sb-card-pin${pinned?" pinned":""}" type="button"
                title="${pinned?"Pinned to panel — click to free":"Floats with the fleet — click to pin"}"
                aria-label="Toggle pin">${pinned?"📌":"📍"}</button>
        <button class="sb-card-btn sb-card-x" type="button" title="Delete card" aria-label="Delete card">×</button>
      </div>`);
    const body = el(`<div class="sb-card-body"></div>`);
    if(c.kind === "note") buildNoteBody(body, c);
    else buildDataBody(body, c);
    node.appendChild(bar);
    node.appendChild(body);

    bar.querySelector(".sb-card-x").onclick = ev => { ev.stopPropagation(); removeCard(c.id); node.remove(); };
    bar.querySelector(".sb-card-pin").onclick = ev => { ev.stopPropagation(); togglePin(c.id); };
    wireCardDrag(node, bar, c.id);
    return node;
  }

  // Note card: editable title + body (contenteditable), debounced-persist on input.
  function buildNoteBody(body, c){
    const title = el(`<div class="sb-note-title" contenteditable="true" data-ph="Title"></div>`);
    const text  = el(`<div class="sb-note-text" contenteditable="true" data-ph="Write a note…"></div>`);
    title.textContent = c.title || "";
    text.textContent  = c.text  || "";
    [title, text].forEach(ed => {
      // editing/typing must never start a card drag or pan the canvas
      ["pointerdown","mousedown","click","dblclick"].forEach(ev => ed.addEventListener(ev, e => e.stopPropagation()));
      ed.addEventListener("keydown", e => e.stopPropagation());
    });
    title.addEventListener("input", () => updateCard(c.id, { title: title.textContent }));
    text.addEventListener("input",  () => updateCard(c.id, { text:  text.textContent  }));
    body.appendChild(title);
    body.appendChild(text);
  }

  // Data card: metric dropdown + live value (updated by the ticker via refreshDataCards).
  function buildDataBody(body, c){
    const metric = CARD_METRICS[c.metric] ? c.metric : "fleet_now";
    if(metric !== c.metric) updateCard(c.id, { metric });
    const opts = METRIC_ORDER.map(k =>
      `<option value="${k}"${k===metric?" selected":""}>${esc(CARD_METRICS[k].label)}</option>`).join("");
    const sel = el(`<select class="sb-data-pick" aria-label="Metric">${opts}</select>`);
    const valWrap = el(`<div class="sb-data-val"><span class="sb-data-num">—</span><span class="sb-data-unit"></span></div>`);
    const label = el(`<div class="sb-data-label">${esc(CARD_METRICS[metric].label)}</div>`);
    ["pointerdown","mousedown","click"].forEach(ev => sel.addEventListener(ev, e => e.stopPropagation()));
    sel.addEventListener("change", () => {
      updateCard(c.id, { metric: sel.value });
      label.textContent = CARD_METRICS[sel.value].label;
      refreshDataCards();
    });
    body.appendChild(sel);
    body.appendChild(valWrap);
    body.appendChild(label);
  }

  // Recompute every data card's value from the live fleet DOM (call each tick).
  function refreshDataCards(){
    document.querySelectorAll('.sb-card[data-kind="data"]').forEach(node => {
      const id = node.dataset.cardId;
      const sel = node.querySelector(".sb-data-pick");
      const metric = sel ? sel.value : "fleet_now";
      const def = CARD_METRICS[metric] || CARD_METRICS.fleet_now;
      const num = node.querySelector(".sb-data-num");
      const unit = node.querySelector(".sb-data-unit");
      if(num) num.textContent = def.compute();
      if(unit) unit.textContent = def.unit || "";
    });
  }

  // Flip a card free↔fixed. Re-seed its x/y near viewport center for the new
  // coordinate space so it never lands off-screen, persist, and re-render.
  function togglePin(id){
    const cards = loadCards();
    const c = cards.find(x => x.id === id);
    if(!c) return;
    c.mode = c.mode === "fixed" ? "free" : "fixed";
    const pos = centerFor(c.mode);
    c.x = Math.round(pos.x); c.y = Math.round(pos.y);
    saveCards(cards);
    renderCards();
  }

  // Pointer-drag a card by its title bar. For free cards the canvas is scaled by
  // _view.z, so divide pointer deltas by z to keep dragging 1:1 at any zoom. All
  // handlers stopPropagation so card drag never triggers canvas pan / inv drag.
  function wireCardDrag(node, handle, id){
    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
    handle.addEventListener("pointerdown", e => {
      if(e.button !== 0) return;
      if(e.target.closest("button")) return;        // pin / × buttons handle themselves
      e.stopPropagation();                          // never start a canvas pan
      e.preventDefault();
      const cards = loadCards(); const c = cards.find(x => x.id === id);
      if(!c) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = c.x || 0; origY = c.y || 0;
      node.classList.add("dragging");
      try { handle.setPointerCapture(e.pointerId); } catch(_){}
    });
    handle.addEventListener("pointermove", e => {
      if(!dragging) return;
      e.stopPropagation();
      const isFree = !node.parentElement || !node.parentElement.classList.contains("sb-cards-fixed");
      const z = isFree ? (_view.z || 1) : 1;        // free cards live in the scaled canvas
      const nx = origX + (e.clientX - startX)/z;
      const ny = origY + (e.clientY - startY)/z;
      node.style.left = nx + "px";
      node.style.top  = ny + "px";
    });
    const end = e => {
      if(!dragging) return;
      dragging = false;
      node.classList.remove("dragging");
      if(e){ e.stopPropagation(); try { handle.releasePointerCapture(e.pointerId); } catch(_){} }
      updateCard(id, { x: Math.round(parseFloat(node.style.left)||0), y: Math.round(parseFloat(node.style.top)||0) });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    // prevent the grip from initiating an HTML5 drag of any ancestor
    handle.addEventListener("dragstart", e => e.preventDefault());
  }

  // ---- pan + zoom the fleet canvas. Drag empty space to pan, wheel to zoom
  // (toward the cursor), double-click empty space to reset. View state persists
  // across re-renders. Inverters/arrays/buttons are excluded so the existing
  // HTML5 drag-to-rearrange and clicks keep working untouched.
  let _view = { x:0, y:0, z:1 }, _fitDone = false;
  function applyCanvasView(host){
    const c = (host||document).querySelector("#sandbox .sb-canvas");
    if(c) c.style.transform = `translate(${_view.x}px,${_view.y}px) scale(${_view.z})`;
  }
  // Auto-fit: scale + center the fleet so it fills the viewport (no empty void).
  function fitView(host){
    const vp = (host||document).querySelector(".sb-viewport");
    const c  = (host||document).querySelector("#sandbox .sb-canvas");
    if(!vp || !c) return;
    const prev = c.style.transform;
    c.style.transform = "none";                      // measure natural (unscaled) content
    const cr = c.getBoundingClientRect();
    const cw = cr.width, ch = cr.height;
    c.style.transform = prev;
    const vw = vp.clientWidth, vh = vp.clientHeight;
    if(!cw || !ch || !vw || !vh) return;
    const z = Math.max(0.4, Math.min(2.2, Math.min(vw/cw, vh/ch) * 0.92));
    _view = { z, x: (vw - cw*z)/2, y: Math.max(8, (vh - ch*z)/2) };
    applyCanvasView(host);
  }
  function wirePanZoom(host){
    const vp = host.querySelector(".sb-viewport");
    if(!vp) return;
    if(!_fitDone){ _fitDone = true; requestAnimationFrame(() => fitView(host)); }  // fit once layout settles
    else applyCanvasView(host);                         // keep the user's view across re-renders
    vp.addEventListener("wheel", e => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top, prev = _view.z;
      const next = Math.min(2.5, Math.max(0.4, prev * (e.deltaY < 0 ? 1.12 : 1/1.12)));
      _view.x = cx - (cx - _view.x) * (next/prev);
      _view.y = cy - (cy - _view.y) * (next/prev);
      _view.z = next; applyCanvasView(host);
    }, { passive:false });
    let panning=false, sx=0, sy=0;
    vp.addEventListener("pointerdown", e => {
      if(e.button!==0 || e.target.closest(".sb-inv,.sb-array,button,a,input,.sb-comb-empty")) return;
      panning=true; sx=e.clientX-_view.x; sy=e.clientY-_view.y;
      vp.classList.add("panning");
      try{ vp.setPointerCapture(e.pointerId); }catch(_){}
    });
    vp.addEventListener("pointermove", e => {
      if(!panning) return;
      _view.x = e.clientX - sx; _view.y = e.clientY - sy; applyCanvasView(host);
    });
    const end = () => { panning=false; vp.classList.remove("panning"); };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("dblclick", e => {
      if(e.target.closest(".sb-inv,.sb-array,button,a")) return;
      fitView(host);                                    // double-click empty space → re-fit to screen
    });
  }

  /* ---- '+ Add array' button wiring ---- */
  function wireAddButton(host){
    const btn = host.querySelector("#sbAddArray");
    if(btn) btn.onclick = openAddArrayModal;
  }

  /* ---- 'Reset layout' — POST /layout/reset: snap every inverter back to its
   * discovered (vendor) grouping on the SERVER, then reload the live tree. ---- */
  function wireResetButton(host){
    const btn = host.querySelector("#sbReset");
    if(!btn) return;
    btn.onclick = async () => {
      const session = getSession();
      if(!session){ load(); return; }   // demo / signed-out — nothing server-side to reset
      setSaving("Resetting to your discovered grouping…");
      try {
        const d = await apiPost("/v1/array-owners/layout/reset");
        toast(`Snapped ${d && d.reset!=null ? d.reset : "all"} inverters back to their vendor grouping.`, "ok");
        reload();
      } catch(e){
        toast("Couldn't reset the layout — please retry.", "err");
        reload();
      }
    };
  }

  /* ---- 'New empty array' — POST /arrays {name}: create an empty owner-defined
   * group to drag inverters into, then reload so the new column appears. ---- */
  function wireNewArrayButton(host){
    const btn = host.querySelector("#sbNewArray");
    if(!btn) return;
    btn.onclick = async () => {
      const session = getSession();
      if(!session){ toast("Sign in first to create an array.", "err"); return; }
      let name = window.prompt("Name your new array (then drag inverters into it):", "");
      if(name == null) return;                 // cancelled
      name = name.trim();
      if(!name){ toast("Enter a name for the new array.", "err"); return; }
      setSaving("Creating your new array…");
      try {
        await apiPost("/v1/array-owners/arrays", { name });
        reload();
      } catch(e){
        toast("Couldn't create that array — please retry.", "err");
        reload();
      }
    };
  }

  /* ---- HTML5 drag-to-reorder of array columns (drag the .sb-array node) ----
   * Scoped to the .sb-array node (not the whole column) so it never competes
   * with the per-inverter drag, whose source is the .sb-inv card. */
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
    canvas.querySelectorAll(".sb-array").forEach(arr => {
      arr.addEventListener("dragstart", e => {
        const col = arr.closest(".sb-col");
        if(!col) return;
        dragEl = col;
        canvas.classList.add("dragging-active");
        // let the lift styling paint before the drag image snapshots
        requestAnimationFrame(() => col.classList.add("dragging"));
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", col.dataset.arrayId || ""); } catch(_){}
      });
      arr.addEventListener("dragend", () => {
        if(dragEl) dragEl.classList.remove("dragging");
        canvas.classList.remove("dragging-active");
        dragEl = null;
        saveOrder(canvas);
      });
    });
    canvas.addEventListener("dragover", e => {
      if(!dragEl) return;                            // only columns handled here
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = getDragAfter(canvas, e.clientX);
      if(after == null) canvas.appendChild(dragEl);
      else if(after !== dragEl) canvas.insertBefore(dragEl, after);
    });
    canvas.addEventListener("drop", e => { if(dragEl) e.preventDefault(); });
  }

  /* ---- HTML5 drag of individual inverter cards → PERSISTED to the backend ----
   * (a) reorder within a comb  → POST /inverters/reorder  (peer cohort unchanged → trust optimistic)
   * (b) move across combs      → POST /inverters/reassign (changes the real peer cohort → reload to
   *     re-render peer-index / alerts / counts; revert by reloading on failure)
   * The dragged card lifts (opacity) and is moved live into the hovered .sb-teeth at the
   * computed slot; vendor badge is per-inverter so it travels with the card unchanged. */
  function getInvAfter(teeth, x, y){
    // 2-D nearest-center, so it works with the flex-wrapped comb
    const els = [...teeth.querySelectorAll(".sb-inv:not(.inv-dragging)")];
    if(!els.length) return null;
    let bestEl = null, bestBox = null, bestDist = Infinity;
    els.forEach(el => {
      const box = el.getBoundingClientRect();
      const dx = x - (box.left + box.width/2), dy = y - (box.top + box.height/2);
      const dist = dx*dx + dy*dy;
      if(dist < bestDist){ bestDist = dist; bestEl = el; bestBox = box; }
    });
    if(!bestEl) return null;
    // before this card if the pointer is left of its center, else after it
    return (x < bestBox.left + bestBox.width/2) ? bestEl : bestEl.nextElementSibling;
  }
  function wireInvDrag(host){
    let dragInv = null, originArrayId = null;

    host.querySelectorAll(".sb-inv").forEach(card => {
      card.addEventListener("dragstart", e => {
        e.stopPropagation();                          // never bubble into a column drag
        dragInv = card;
        originArrayId = card.dataset.arrayId;         // remember where it started for reassign vs reorder
        host.classList.add("inv-dragging-active");
        requestAnimationFrame(() => card.classList.add("inv-dragging"));
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", card.dataset.invId || ""); } catch(_){}
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("inv-dragging");
        host.classList.remove("inv-dragging-active");
        host.querySelectorAll(".sb-teeth.inv-drop").forEach(t => t.classList.remove("inv-drop"));
        const col = card.closest(".sb-col");
        const from = originArrayId;
        dragInv = null; originArrayId = null;
        if(!col) return;

        card.dataset.arrayId = col.dataset.arrayId;          // optimistic: its new home array
        host.querySelectorAll(".sb-col").forEach(updateColCount);

        const invId = parseInt(card.dataset.invId, 10);
        const destArrayId = parseInt(col.dataset.arrayId, 10);
        // No real id / no session (demo tree) → optimistic-only, nothing to persist.
        if(isNaN(invId) || !getSession()) return;

        if(String(col.dataset.arrayId) !== String(from)){
          persistReassign(card, invId, destArrayId);
        } else {
          persistReorder(col, destArrayId);
        }
      });
    });

    host.querySelectorAll(".sb-teeth").forEach(teeth => {
      teeth.addEventListener("dragover", e => {
        if(!dragInv) return;                          // not an inverter drag → let columns handle it
        e.preventDefault();
        e.stopPropagation();                          // keep the canvas column handler out of it
        e.dataTransfer.dropEffect = "move";
        teeth.classList.add("inv-drop");
        const after = getInvAfter(teeth, e.clientX, e.clientY);
        if(after == null) teeth.appendChild(dragInv);
        else if(after !== dragInv) teeth.insertBefore(dragInv, after);
      });
      teeth.addEventListener("dragleave", e => {
        if(!dragInv) return;
        if(!teeth.contains(e.relatedTarget)) teeth.classList.remove("inv-drop");
      });
      teeth.addEventListener("drop", e => {
        if(!dragInv) return;
        e.preventDefault();
        e.stopPropagation();
        teeth.classList.remove("inv-drop");
      });
    });
  }

  // Cross-array move: persist + RELOAD so peer-index / alerts / counts reflect the new
  // cohort (the whole point of a move). Cached reload is fast; reassign itself is instant.
  function persistReassign(card, invId, destArrayId){
    const teeth = card.closest(".sb-teeth");
    const position = teeth ? [...teeth.querySelectorAll(".sb-inv")].indexOf(card) : 0;
    setSaving("Moving inverter & re-measuring against new neighbors…");
    apiPost("/v1/array-owners/inverters/reassign",
            { inverter_id: invId, target_array_id: destArrayId, position: Math.max(0, position) })
      .then(() => reload())                               // reconcile with fresh peer math
      .catch(() => { toast("Couldn't move that inverter — putting it back.", "err"); reload(); });
  }

  // Within-array reorder: peer cohort is unchanged, so trust the optimistic DOM move and
  // just persist the new order. Revert by reloading only on failure.
  function persistReorder(col, arrayId){
    const teeth = col.querySelector(".sb-teeth");
    const ordered = teeth
      ? [...teeth.querySelectorAll(".sb-inv")].map(n => parseInt(n.dataset.invId, 10)).filter(n => !isNaN(n))
      : [];
    if(!ordered.length) return;
    setSaving("Saving order…");
    apiPost("/v1/array-owners/inverters/reorder", { array_id: arrayId, ordered_inverter_ids: ordered })
      .then(() => clearSaving())
      .catch(() => { toast("Couldn't save the new order — reloading.", "err"); reload(); });
  }

  // Re-fetch the live tree and re-render WITHOUT the full loading-state wipe (smoother than
  // load() after a write). Dims the canvas while in flight. Falls back to load() if signed out.
  function reload(opts){
    const host = document.getElementById("sandbox");
    if(!host) return;
    const session = getSession();
    if(!session){ load(); return; }
    const canvas = host.querySelector(".sb-canvas");
    if(canvas) canvas.classList.add("sb-busy");
    const url = "/v1/array-owners/fleet-tree" + (opts && opts.force ? "?force=1" : "");
    fetch(url, { headers: { Authorization: "Bearer " + session } })
      .then(r => { if(!r.ok) throw new Error("fleet-tree " + r.status); return r.json(); })
      .then(render)                                       // render() rebuilds innerHTML → busy class drops
      .catch(() => { if(canvas) canvas.classList.remove("sb-busy"); toast("Couldn't refresh the fleet tree — please retry.", "err"); });
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
    const basis = pick(summary, ["billing_basis"], null);
    // Amounts from billing-summary are in (possibly fractional) CENTS.
    const usdFromCents = c => (c==null ? "—" : "$" + (Number(c)/100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}));

    if(basis === "kwh"){
      // Array Operator — billed by generation.
      const mtdKwh   = pick(summary, ["mtd_kwh"], null);
      const rate     = pick(summary, ["rate_cents_per_kwh"], null);   // decimal cents/kWh
      const totalC   = pick(summary, ["total_cents"], null);          // month-to-date estimate, cents
      const arrays   = pick(summary, ["billable_arrays"], null);
      if(rate != null)    cards.push(plainCard("Rate", `${Number(rate).toLocaleString(undefined,{maximumFractionDigits:3})}&cent; <small>/ kWh · volume discounts</small>`));
      if(mtdKwh != null)  cards.push(plainCard("Generated this month", `${Number(mtdKwh).toLocaleString(undefined,{maximumFractionDigits:0})} <small>kWh</small>`));
      if(arrays != null)  cards.push(plainCard("Arrays connected", esc(String(arrays))));
      if(totalC != null)  cards.push(plainCard("This month so far", `${usdFromCents(totalC)} <small>· est.</small>`));
    } else {
      // NEPOOL Operator — billed per array (legacy shape kept for the verifier app).
      const arrayCount = pick(summary, ["billable_arrays","array_count","arrays_count","arrays"], null);
      const fullUnit   = pick(summary, ["full_unit_cents"], null);
      const totalC     = pick(summary, ["total_cents"], null);
      if(arrayCount != null) cards.push(plainCard("Arrays connected", esc(String(arrayCount))));
      if(fullUnit != null)   cards.push(plainCard("Price tier", `${usdFromCents(fullUnit)} <small>/ array / mo</small>`));
      if(totalC != null)     cards.push(plainCard("Monthly total", usdFromCents(totalC)));
    }

    const invAmt = invoice ? pick(invoice, ["amount_cents","amount_due","total","amount"], null) : null;
    if(invAmt != null){
      const invDate = pick(invoice, ["period_end","due_date","date","next_payment_date"], null);
      cards.push(plainCard("Next invoice", `${usdFromCents(invAmt)}${invDate ? ` <small>· ${fmtDate(invDate)}</small>` : ""}`));
    }

    box.innerHTML = cards.length ? cards.join("")
      : `<div class="acct-card"><div class="k">Billing</div><div class="v">You're on a free trial</div>
           <div class="sub">No invoices yet — you're only billed for the kWh your arrays generate, and never during your trial. Add a card whenever you're ready.</div></div>`;

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
