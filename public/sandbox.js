/* ============================================================================
 * Array Operator — Sandbox view (sandbox.js)
 *
 * Renders the fleet as one ARRAY CARD per column. Each card has a two-column body:
 *
 *     ┌─ Array card ─────────────────────────────────┐
 *     │  Array details        │  Alerts              │
 *     │  name · N inverters   │  rolled-up headline  │
 *     │  live tag · brand     │  count flagged       │
 *     │  origin site links ↗  │  (tinted ok/warn/bad)│
 *     │  [{n} inverters ▸]    │                      │
 *     └───────────────────────┴──────────────────────┘
 *           └─ collapsible inverter comb (hidden until expanded) ─┐
 *              N real inverter prongs + SVG feeder wires          │
 *
 * The array card is the clean main view; its inverter comb is COLLAPSED by
 * default and expands per-array (persisted to localStorage). The alert that used
 * to ride on a separate top tier now lives in the card's right inner column.
 * Data: GET /v1/array-owners/fleet-tree (live per-inverter telemetry, peer-
 * analyzed within each site; origin_links deep-link to the vendor portal). The
 * organization of this canvas IS the schema: Tenant → Array → Inverter.
 * ==========================================================================*/
(function(){
  const SESSION_KEY = "so_session";
  const ORDER_KEY = "ao_array_order";        // persisted column order (array_id strings) — harmless UI preference
  const RENAME_KEY = "ao_renames";           // persisted inline renames { arrays:{id:name}, inverters:{id:name} }
  const EXPAND_KEY = "ao_array_expanded";    // persisted set of array_ids whose inverter comb is expanded (JSON array)
  const ORIENT_KEY = "ao_sandbox_orient";    // "vertical" (arrays side-by-side, inverters below) | "horizontal" (arrays stacked left, inverters spread right)
  const BRAND = { solaredge:"SolarEdge", locus:"Locus", alsoenergy:"AlsoEnergy", fronius:"Fronius", sma:"SMA", chint:"Chint", gmp:"GMP", vec:"VEC", wec:"WEC" };

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
    { code:"alsoenergy", label:"AlsoEnergy", meta:"PowerTrack", available:true, discover:false,
      note:"Sign in with your AlsoEnergy / PowerTrack portal login — the same username & password you use at hmi.alsoenergy.com. Add a Site ID to connect one site.",
      fields:[
        {name:"username", label:"AlsoEnergy username"},
        {name:"password", label:"AlsoEnergy password", secret:true},
        {name:"site_id", label:"Site ID", hint:"Found in your PowerTrack site URL."},
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
    { code:"chint", label:"Chint / CPS", meta:"Chint Connect", available:false, discover:false,
      note:"Chint/CPS has no key to paste — use the one-click 'Log in with Chint' option above. Support is in final verification against live accounts." },
  ];
  function vendorByCode(c){ return VENDORS.find(v=>v.code===c) || VENDORS[0]; }

  function getSession(){ try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } }

  /* ---- EnergyAgent extension bridge (one-click portal login) ----
   * The helper injects so_bridge.js on arrayoperator.com: it announces
   * SO_EXTENSION_PRESENT and relays SO_CAPTURE_LANDED. We ask the owner to log
   * into their monitoring portal the way they already do; the extension reads
   * their inverters and lands them here, and we attach to their account. */
  let EXT_PRESENT = false;
  const EXT_STORE_URL = "https://chromewebstore.google.com/detail/solar-operator-sync/ocohbimolfpnkjcjhiodopjjlhclinpl";
  // Portal URLs per vendor for the one-click login.
  const PORTAL_URL = {
    solaredge: "https://monitoring.solaredge.com/",
    fronius:   "https://www.solarweb.com/",
    sma:       "https://ennexos.sunnyportal.com/",
    chint:     "https://monitor.chintpowersystems.com/",
    gmp:       "https://greenmountainpower.com/",
    vec:       "https://vermontelectric.smarthub.coop/",
    wec:       "https://washingtonelectric.smarthub.coop/",
  };
  function extSend(type, extra){
    try { window.postMessage(Object.assign({ type, reqId: String(Date.now())+Math.random() }, extra||{}), "*"); } catch(e){}
  }
  function openPortalLogin(vendor){
    const url = PORTAL_URL[vendor];
    if(!url) return;
    const note = _ov && _ov.querySelector("#sbNote");
    const isMeter = vendor === "gmp" || vendor === "vec" || vendor === "wec";
    if(note){
      note.className = "sb-note";
      // Chint reports its inverters per SITE, and the extension only sees a
      // site's inverters once the owner OPENS that site. Multi-site owners (e.g.
      // Bruce/GMCS) must click into each site once — so spell that out here.
      const chintTip = vendor === "chint"
        ? ` <b>Open each of your sites once</b> — every site you open brings in all of its inverters automatically (you don't need to click into individual inverters). Visit every site so none are left behind.`
        : "";
      const what = isMeter ? "solar production" : "inverters";
      note.innerHTML = `<span class="sb-spin"></span> Opening ${esc(BRAND[vendor]||vendor)} — sign in there and your ${what} appear${isMeter?"s":""} here automatically.${chintTip}`;
    }
    // Pass the provider so the extension arms the right capture intent (a SmartHub
    // host serves many co-ops; vendor disambiguates vec vs wec vs a bill-only login).
    extSend("SO_OPEN_PORTAL", { url, active: true, provider: vendor, vendor: vendor });
  }
  // A capture landed from the extension. Owner is already signed in (dashboard),
  // so attach straight to their account: SolarEdge by its account key,
  // Fronius/SMA by ingesting the per-inverter readings the extension shipped.
  async function handleCaptureLanded(d){
    const session = getSession();
    const note = _ov && _ov.querySelector("#sbNote");
    if(!session){
      if(note){ note.className = "sb-note err"; note.innerHTML = `Please sign in first — <a href="onboarding.html">get started →</a>.`; }
      return;
    }
    const hdr = { "Content-Type":"application/json", "Authorization":"Bearer "+session };
    if(note){ note.className = "sb-note"; note.innerHTML = `<span class="sb-spin"></span> Got your ${esc(BRAND[d.provider]||d.provider)} account — bringing your inverters in…`; }
    try{
      let r, data;
      if(d.provider === "solaredge" && d.apiKey){
        r = await fetch("/v1/array-owners/solaredge/connect-account",
          { method:"POST", headers:hdr, body: JSON.stringify({ api_key: d.apiKey }) });
      } else if((d.provider === "fronius" || d.provider === "sma" || d.provider === "chint") && Array.isArray(d.sites) && d.sites.length){
        r = await fetch("/v1/array-owners/inverter-capture",
          { method:"POST", headers:hdr, body: JSON.stringify({ provider: d.provider, sites: d.sites }) });
      } else if((d.provider === "gmp" || d.provider === "vec" || d.provider === "wec") && Array.isArray(d.accounts) && d.accounts.length){
        // Utility-meter capture (GMP server-pull + VEC/WEC client-pull) all land
        // as a per-account daily[] payload → the one proven utility-meter endpoint.
        r = await fetch("/v1/array-owners/utility-meter-capture",
          { method:"POST", headers:hdr, body: JSON.stringify({ provider: d.provider, accounts: d.accounts }) });
      } else {
        if(note){ note.className = "sb-note err"; note.textContent = `We reached ${BRAND[d.provider]||d.provider} but couldn't read your inverters — make sure you're signed in there, then try again.`; }
        return;
      }
      data = {}; try { data = await r.json(); } catch(e){}
      const ok = r.ok && (data.ok || data.connected || data.created || data.matched || data.sites_captured || data.accounts_captured);
      const isMeter = d.provider === "gmp" || d.provider === "vec" || d.provider === "wec";
      if(ok){
        // Pull the freshly-attached array(s) from the server and re-render the
        // tree. load() short-circuits when the store is already loaded (it is, on
        // the dashboard), so we must force a real re-fetch.
        if(note){ note.className = "sb-note"; note.innerHTML = `<span class="sb-spin"></span> Bringing your ${isMeter?"meter production":"inverters"} onto the canvas…`; }
        try {
          if(window.FleetStore && FleetStore.refetch){
            await FleetStore.refetch();
            // Show the FULL fleet after a connect — the owner just added an array,
            // they want to see it alongside everything they already had, not a
            // curated "worst few" subset. (defaultFocusIds() collapses to flagged
            // arrays only, which would hide the rest — the opposite of "added".)
            if(FleetStore.setFocus && FleetStore.snapshot){
              const all = (FleetStore.snapshot().arrays || []).map(a => a.id);
              if(all.length) FleetStore.setFocus(all);
            }
          }
        } catch(e){}
        closeAddModal();
        if(typeof toast === "function"){
          if(isMeter){
            // Utility-meter capture: count accounts that actually had solar
            // production vs. ones with no generation (honest — don't imply solar
            // where there's none).
            const accts = Array.isArray(data.accounts) ? data.accounts : [];
            const withGen = accts.filter(a => a.has_generation).length;
            const noGen = accts.length - withGen;
            if(withGen) toast(`Connected — ${withGen} GMP account${withGen===1?"":"s"} with solar production on your canvas${noGen?` (${noGen} had no solar)`:""}.`, "ok");
            else toast(noGen ? `Connected GMP — but ${noGen} account${noGen===1?"":"s"} showed no solar production yet.` : `Connected your GMP meter data.`, "ok");
          } else {
            const n = (data.sites && data.sites.reduce ? data.sites.reduce((t,s)=>t+(s.inverters_persisted||0),0) : 0);
            toast(n ? `Connected — ${n} inverter${n===1?"":"s"} live on your canvas.` : `Connected — your inverters are on the canvas.`, "ok");
          }
        }
        load();   // re-render the (now refreshed) store
        return;
      }
      // A rotated/expired session surfaces as 401 OR 403 "Invalid or inactive
      // tenant key" — guide the owner to re-auth instead of showing the raw error.
      const authDead = r.status===401 ||
        (r.status===403 && /tenant key|sign in|session/i.test((data && (data.detail||data.message))||""));
      if(authDead){
        try { localStorage.removeItem("so_session"); } catch(e){}
        if(note){ note.className = "sb-note err"; note.innerHTML = `Your session expired — <a href="onboarding.html">sign in again →</a>, then reconnect. Your existing arrays are safe.`; }
        return;
      }
      if(note){ note.className = "sb-note err"; note.textContent = (data && (data.message||data.detail)) || `Couldn't bring in that ${BRAND[d.provider]||d.provider} account (HTTP ${r.status}).`; }
    }catch(err){
      if(note){ note.className = "sb-note err"; note.textContent = "We couldn't reach the connection service just now — check your network and try again."; }
    }
  }
  window.addEventListener("message", (e) => {
    if(e.source !== window) return;
    const d = e.data; if(!d || typeof d !== "object") return;
    if(d.type === "SO_EXTENSION_PRESENT" || (d.type === "SO_STATUS_ACK" && d.ok)){
      if(!EXT_PRESENT){ EXT_PRESENT = true; if(_ov && _ov.classList.contains("open")) renderAddModalBody(); }
    }
    if(d.type === "SO_CAPTURE_LANDED" && ["solaredge","fronius","sma","chint","gmp","vec","wec"].includes(d.provider)) handleCaptureLanded(d);
    if(d.type === "SO_CAPTURE_FAILED"){
      const note = _ov && _ov.querySelector("#sbNote");
      if(note){
        note.className = "sb-note err";
        note.textContent = `${BRAND[d.provider]||d.provider} didn't connect: ${d.reason||"unknown error"}. Make sure you're signed in on the portal tab, then click again.`;
      }
    }
  });
  extSend("SO_STATUS_REQUEST");   // ask explicitly in case the bridge announced before we listened


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
    comm_gap: "Gone quiet", dead: "Not coming home", fault: "Fault",
    monitoring: "Monitoring"
  };
  const STATUS_CLASS = {
    ok: "ok", underperforming: "warn", comm_gap: "warn", dead: "bad", fault: "bad",
    monitoring: "info"
  };
  const ALERT_CLASS = { ok: "ok", warn: "warn", critical: "bad" };

  // ---- value model (mirrors command-center.js / app.js) — $ at stake estimate ----
  const ENERGY_RATE = 0.21;       // $/kWh blended offset
  const REC_PER_MWH = 38;         // $/MWh REC value
  const SB_WINDOW_DAYS = 14;
  const dollarVal = kwh => kwh*ENERGY_RATE + (kwh/1000)*REC_PER_MWH;
  const usd0 = n => "$" + Math.round(Number(n)||0).toLocaleString();

  // Per-array health rollup for the OVERVIEW GRID. Returns the worst-case tone
  // (ok/warn/bad), flagged count, and estimated $/mo at stake across the array —
  // grounded in the same peer-shortfall math the command center uses.
  function arrayHealth(col){
    const invs = col.inverters || [];
    const totalNp = invs.reduce((t,i)=>t+(i.nameplate_kw||0),0) || 1;
    const fleetWin = invs.reduce((t,i)=>t+(i.window_kwh||0),0);
    let flagged = 0, crit = 0, lostKwh = 0, liveAnoms = 0;
    for(const inv of invs){
      // A LIVE anomaly (dark right now while peers produce) the 14-day health
      // hasn't flagged yet still counts as flagged here — otherwise the tile reads
      // "all good" while a card inside it shows "Not producing". Shared classifier.
      const liveBad = inv.status === "ok" && window.FleetStore && FleetStore.liveVerdict
        && FleetStore.liveVerdict(inv, invs, col.is_daylight) === "dark";
      if(inv.status === "ok"){
        if(liveBad){ flagged++; liveAnoms++; }
        continue;
      }
      // "monitoring" = not enough evidence to judge yet — neutral, never flagged.
      if(inv.status === "monitoring") continue;
      flagged++;
      if(inv.status === "dead" || inv.status === "fault") crit++;
      const fair = (inv.nameplate_kw||0)/totalNp*fleetWin;
      if(inv.status === "dead" || inv.status === "fault") lostKwh += Math.max(0, fair-(inv.window_kwh||0));
      else if(inv.status === "underperforming" && inv.peer_index) lostKwh += Math.max(0, fair/Math.max(inv.peer_index,0.01)-(inv.window_kwh||0));
      // comm_gap = unknown until it reports — no $ claimed
    }
    const lossMo = dollarVal(lostKwh)/SB_WINDOW_DAYS*30;
    const tone = crit ? "bad" : flagged ? "warn" : "ok";
    return { tone, flagged, crit, lossMo, total: invs.length, liveAnoms };
  }

  function el(html){ const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

  // ---- Weather badge above each array ----------------------------------------
  // WMO weather-code → emoji + label, plus a per-array weather state. Real arrays
  // with a lat/lng get a live Open-Meteo current-conditions pull (free, no key);
  // arrays with only a coarse region, or the demo fleet, get a STABLE synthetic
  // condition derived deterministically from the array id (so it doesn't flicker
  // on every re-render). The badge upgrades in place when the live fetch lands.
  const WX = {
    clear:   { icon:"☀️", label:"Clear" },
    pcloudy: { icon:"⛅", label:"Partly cloudy" },
    cloudy:  { icon:"☁️", label:"Cloudy" },
    fog:     { icon:"🌫️", label:"Fog" },
    rain:    { icon:"🌧️", label:"Rain" },
    snow:    { icon:"🌨️", label:"Snow" },
    storm:   { icon:"⛈️", label:"Thunderstorm" },
  };
  function wxFromWmo(code){
    if(code===0) return "clear";
    if(code<=2) return "pcloudy";
    if(code===3) return "cloudy";
    if(code===45||code===48) return "fog";
    if((code>=71&&code<=77)||(code>=85&&code<=86)) return "snow";
    if(code>=95) return "storm";
    if((code>=51&&code<=67)||(code>=80&&code<=82)) return "rain";
    return "cloudy";
  }
  const _wxCache = {};   // arrayId → {key, temp} resolved condition (persists across re-renders)
  function _hashStr(s){ let h=0; s=String(s); for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return Math.abs(h); }
  function synthWx(col){
    // deterministic per-array so the demo reads as "real, stable weather"
    const keys = ["clear","clear","pcloudy","pcloudy","cloudy","rain","snow"];
    const h = _hashStr(col.array_id != null ? col.array_id : col.array_name);
    return { key: keys[h % keys.length], temp: 40 + (h % 45) };  // 40–84°F
  }
  function weatherBadge(col){
    const cached = _wxCache[col.array_id] || synthWx(col);
    const w = WX[cached.key] || WX.cloudy;
    const tt = cached.temp != null ? `${w.label} · ${cached.temp}°F` : w.label;
    return ` <span class="sb-wx" data-array-id="${esc(col.array_id)}" title="${esc(tt)}" aria-label="Weather: ${esc(tt)}">${w.icon}</span>`;
  }
  // After render, kick a live pull for arrays that carry real coordinates, then
  // patch the badge in place. Demo/region-only arrays keep their stable synthetic icon.
  function refreshWeather(host){
    const cols = (window.FleetStore && FleetStore.focusColumns) ? (FleetStore.focusColumns().columns || []) : [];
    cols.forEach(col => {
      const lat = col.lat != null ? col.lat : col.latitude;
      const lng = col.lng != null ? col.lng : col.longitude;
      if(lat==null || lng==null) return;                 // no coords → keep synthetic
      if(_wxCache[col.array_id]){ paintWx(host, col.array_id); return; }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
      fetch(url).then(r=>r.ok?r.json():null).then(j=>{
        if(!j || !j.current) return;
        _wxCache[col.array_id] = { key: wxFromWmo(j.current.weather_code), temp: Math.round(j.current.temperature_2m) };
        paintWx(host, col.array_id);
      }).catch(()=>{});
    });
  }
  function paintWx(host, arrayId){
    const cached = _wxCache[arrayId]; if(!cached) return;
    const w = WX[cached.key] || WX.cloudy;
    const tt = cached.temp != null ? `${w.label} · ${cached.temp}°F` : w.label;
    (host||document).querySelectorAll(`.sb-wx[data-array-id="${CSS.escape(String(arrayId))}"]`).forEach(node => {
      node.textContent = w.icon; node.title = tt; node.setAttribute("aria-label", "Weather: "+tt);
    });
  }

  // peer-index bar (0..~1.2 clamped) — green at/above 1, amber/ red below
  function peerBar(pi){
    if(pi==null) return `<div class="sb-pi none">solo · no peers</div>`;
    const pct = Math.max(4, Math.min(100, Math.round(pi*100)));
    const cls = pi>=0.85 ? "ok" : pi>=0.6 ? "warn" : "bad";
    return `<div class="sb-pi"><div class="sb-pi-bar ${cls}" style="width:${pct}%"></div><span class="${cls}">${pi.toFixed(2)}</span></div>`;
  }

  // Mini output graph for an inverter card: an SVG area-line of its daily kWh
  // series (real backend telemetry for signed-in owners; synthetic for the demo
  // fleet). Zero-output days get a red dot so a dead/quiet streak reads instantly.
  // Returns "" when there's no series (then the card shows a "no history yet" note).
  function invSpark(daily, statusCls){
    if(!Array.isArray(daily) || daily.length < 2) return "";
    const w = 132, h = 34, pad = 3;
    const vals = daily.map(d => Math.max(0, +d.kwh || 0));
    const max = Math.max(...vals, 0.001);
    const stroke = statusCls === "bad" ? "var(--bad)" : statusCls === "warn" ? "var(--warn)" : "var(--good)";
    const X = i => pad + (i/(vals.length-1))*(w-2*pad);
    const Y = v => h-pad - (v/max)*(h-2*pad);
    const line = vals.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const area = `${X(0).toFixed(1)},${(h-pad).toFixed(1)} ${line} ${X(vals.length-1).toFixed(1)},${(h-pad).toFixed(1)}`;
    const zeros = vals.map((v,i)=> v===0 ? `<circle cx="${X(i).toFixed(1)}" cy="${(h-pad).toFixed(1)}" r="1.8" fill="var(--bad)"/>` : "").join("");
    // time scale: label the oldest (left), a midpoint, and the newest (right) day
    const last = daily.length - 1, mid = Math.floor(last/2);
    const lo = _sparkTimeLabel(daily[0].date, last, 0);
    const mp = _sparkTimeLabel(daily[mid].date, last, mid);
    const hi = _sparkTimeLabel(daily[last].date, last, last);
    const axis = `<div class="sb-spark-axis"><span>${esc(lo)}</span><span>${esc(mp)}</span><span>${esc(hi)}</span></div>`;
    return `<div class="sb-spark-wrap">
      <svg class="sb-inv-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${area}" fill="${stroke}" opacity="0.12"/>
        <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${zeros}
      </svg>${axis}</div>`;
  }
  // A short time-axis label for one point in the daily series. Real data carries
  // ISO dates ("2026-06-09") → "M/D"; the demo carries "d-N" (N days ago) → the
  // newest point is "now", the oldest "Nd", a midpoint "Nd". Falls back gracefully.
  function _sparkTimeLabel(date, lastIdx, idx){
    const isNewest = idx === lastIdx;
    if(typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)){
      const d = new Date(date + "T00:00:00");
      if(!isNaN(d)) return isNewest ? "now" : `${d.getMonth()+1}/${d.getDate()}`;
    }
    const m = typeof date === "string" ? date.match(/d-?(\d+)/) : null;
    if(m){ const n = +m[1]; return isNewest || n <= 1 ? "now" : `${n}d`; }
    return isNewest ? "now" : "";
  }
  // a kWh figure formatted compactly for the Min/Cur/Max stat row
  function kwhFmt(v){ return v==null ? "—" : (v>=100 ? Math.round(v) : (Math.round(v*10)/10)); }

  // ONE combined graph for the whole array: sum every inverter's daily kWh by date
  // into a single series, then draw it full-width with an area fill + time axis.
  // This is the ARRAY's own production history — "how's my array doing" at a glance —
  // not a grid of per-inverter minis. Tone tracks the array's live output vs its
  // combined rated capacity (green at/near max → amber → orange → idle when nothing
  // is reporting). Days where the whole array made nothing get a red dot.
  function arrayGraph(sortedInvs, arrayDaily){
    if(!sortedInvs || !sortedInvs.length) return "";
    // aggregate daily kWh across all inverters, keyed by date
    const byDate = new Map();
    sortedInvs.forEach(inv => {
      (inv.daily || []).forEach(d => {
        if(!d || d.date == null) return;
        const k = Math.max(0, +d.kwh || 0);
        byDate.set(d.date, (byDate.get(d.date) || 0) + k);
      });
    });
    // Fallback to the ARRAY's own production history (backend DailyGeneration)
    // when per-inverter series are sparse — e.g. Chint reports site-level daily
    // (weekETrend backfill) but no per-inverter history. This makes the graph
    // appear immediately on connect instead of waiting for days to accumulate.
    if(byDate.size < 2 && Array.isArray(arrayDaily)){
      arrayDaily.forEach(d => {
        if(!d || d.date == null) return;
        byDate.set(d.date, Math.max(byDate.get(d.date) || 0, Math.max(0, +d.kwh || 0)));
      });
    }
    // array-level live tone: combined current vs combined nameplate
    let curW = 0, maxW = 0, anyReporting = false;
    sortedInvs.forEach(inv => {
      if(inv.nameplate_kw != null) maxW += inv.nameplate_kw * 1000;
      if(inv.current_power_w != null){ curW += inv.current_power_w; anyReporting = true; }
    });
    const tone = (anyReporting && maxW) ? pctTone(Math.max(0, Math.min(100, Math.round((curW/maxW)*100)))) : "idle";
    const stroke = tone === "bad" ? "var(--bad)" : tone === "warn" ? "#ffb454" : tone === "idle" ? "var(--faint)" : "var(--good)";

    // sort the summed series by date (ISO sorts naturally; demo "d-N" handled too)
    const sortKey = s => {
      if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
      const m = String(s).match(/d-?(\d+)/);
      return m ? String(1e6 - (+m[1])).padStart(9,"0") : s;   // d-14 oldest → d-1 newest
    };
    const dates = [...byDate.keys()].sort((a,b)=> sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
    if(dates.length < 2){
      return `<div class="sb-ag"><div class="sb-ag-k">Array production · last 14 days</div>
        <div class="sb-ag-nodata">history building — graph appears once 2+ days are stored</div></div>`;
    }
    const vals = dates.map(d => byDate.get(d));
    const totalKwh = vals.reduce((s,v)=>s+v,0);
    const w = 300, h = 56, pad = 4;
    const max = Math.max(...vals, 0.001);
    const X = i => pad + (i/(vals.length-1))*(w-2*pad);
    const Y = v => h-pad - (v/max)*(h-2*pad);
    const line = vals.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const area = `${X(0).toFixed(1)},${(h-pad).toFixed(1)} ${line} ${X(vals.length-1).toFixed(1)},${(h-pad).toFixed(1)}`;
    const zeros = vals.map((v,i)=> v===0 ? `<circle cx="${X(i).toFixed(1)}" cy="${(h-pad).toFixed(1)}" r="2" fill="var(--bad)"/>` : "").join("");
    const last = dates.length-1, mid = Math.floor(last/2);
    const lo = _sparkTimeLabel(dates[0], last, 0);
    const mp = _sparkTimeLabel(dates[mid], last, mid);
    const hi = _sparkTimeLabel(dates[last], last, last);
    const totalLbl = totalKwh >= 1000 ? `${(totalKwh/1000).toFixed(1)} MWh` : `${Math.round(totalKwh)} kWh`;
    return `<div class="sb-ag">
      <div class="sb-ag-head">
        <span class="sb-ag-k">Array production · last ${dates.length} days</span>
        <span class="sb-ag-total">${totalLbl}</span>
      </div>
      <svg class="sb-ag-graph" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${area}" fill="${stroke}" opacity="0.13"/>
        <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
        ${zeros}
      </svg>
      <div class="sb-spark-axis"><span>${esc(lo)}</span><span>${esc(mp)}</span><span>${esc(hi)}</span></div>
    </div>`;
  }

  // Live output bar: current power as a % of the inverter's MAX (rated nameplate).
  // The bar fills to that %, and the card tints progressively orange the further
  // current drifts BELOW max (full green at/near max → amber → deep orange when
  // far below). Carries data-curw/data-maxw so the live ticker recomputes it in
  // place each tick. When the inverter isn't reporting (night/offline) we show a
  // dim idle bar rather than a false 0%-of-max alarm.
  function pctTone(pct){
    // pct 0..100 of max. >=80 green, scaling to deep orange near 0.
    if(pct == null) return "idle";
    if(pct >= 80) return "ok";
    if(pct >= 55) return "warn";
    return "bad";
  }
  // Single source of truth for an inverter's LIVE output state, used by both the
  // output bar and the whole-card tint so they never disagree.
  //  - A literal 0 (or a trickle below ~1% of rated / 25W) means the panels are
  //    idle RIGHT NOW — evening, night, or simply not generating. That is NOT an
  //    underperformance alarm, so it reads as "idle" (calm), never orange. This is
  //    the fix for healthy "All good" inverters glowing orange every evening when
  //    SolarEdge reports current_power_w: 0 instead of null.
  //  - The orange/red output tint only fires when the inverter's HEALTH status is
  //    already flagged (dead/fault/underperforming). A healthy inverter dipping
  //    under clouds is normal and shouldn't alarm — real underperformance is caught
  //    by the peer-based health status, which carries its own border + alert line.
  // Estimated rated max (W) from the observed peak daily kWh when the vendor
  // gives us no nameplate (e.g. some SolarEdge sites, Chint). Mirrors the
  // backend's peer_analysis._infer_nameplate EXACTLY (peak daily kWh / 4 ≈ kW
  // — a ~4 kWh/day-per-kW temperate ceiling) so the card's % matches the health
  // math. This lets EVERY producing card show the % owners actually read,
  // instead of some cards falling back to a bare kW. Always flagged estimated so
  // the UI marks it "~est. max" and never passes a guess off as a hardware spec.
  function estNameplateW(inv){
    const vals = (inv.daily || []).map(d => +d.kwh || 0).filter(v => v > 0);
    const peak = vals.length ? Math.max.apply(null, vals) : 0;
    return peak > 0 ? (peak / 4) * 1000 : null;
  }
  // A vendor with NO instantaneous power feed (Fronius via Solar.web exposes only
  // site-wide TotalPower, never per-inverter) leaves current_power_w == null on
  // every inverter — distinct from a numeric 0 (SolarEdge/SMA/Chint at night).
  // We must NOT paint those as the dead "not producing right now": they produced
  // today, we simply have no live wattage. Surface today's REAL kWh instead.
  function liveReadingMissing(inv){ return inv && inv.current_power_w == null; }
  // Today's produced kWh from the daily series (last point, if it's today's date).
  // Returns null when the series doesn't reach today.
  function todayKwh(inv){
    const d = inv && inv.daily;
    if(!Array.isArray(d) || !d.length) return null;
    const last = d[d.length - 1];
    if(!last || last.date == null) return null;
    const iso = new Date().toISOString().slice(0, 10);
    return String(last.date).slice(0, 10) === iso ? (+last.kwh || 0) : null;
  }
  function outputState(inv, statusCls){
    const realW = (inv.nameplate_kw != null) ? inv.nameplate_kw * 1000 : null;
    // No real nameplate → estimate one from production history so we can still
    // show a %. estimated=true drives the "~est. max" label downstream.
    const estW  = realW == null ? estNameplateW(inv) : null;
    const maxW  = realW != null ? realW : estW;
    const estimated = realW == null && estW != null;
    const curW = (inv.current_power_w != null) ? inv.current_power_w : null;
    // "Producing" needs only a real live reading. Below ~25W (or ~1% of the
    // rated/estimated max, when known) = genuinely idle.
    const floor = maxW != null ? Math.max(25, maxW * 0.01) : 25;
    const producing = curW != null && curW > floor;
    if(!producing) return { reporting: false, pct: null, tone: "idle", estimated, maxW };
    // The orange/red output tint only fires when HEALTH is already flagged
    // (underperforming/fault/dead → "warn"/"bad"). "ok" AND the neutral
    // "monitoring" (info) state are both calm — a healthy or not-yet-judged
    // inverter dipping under clouds must not paint the card as a problem.
    const calm = (statusCls === "ok" || statusCls === "info");
    if(maxW == null){
      // Real output but NO nameplate AND no history to estimate from — the only
      // case left without a %. Report absolute kW, calm tone.
      return { reporting: true, pct: null, tone: calm ? "ok" : pctTone(50), estimated: false, maxW: null };
    }
    const pct = Math.max(0, Math.min(100, Math.round((curW / maxW) * 100)));
    const tone = calm ? "ok" : pctTone(pct);
    return { reporting: true, pct, tone, estimated, maxW };
  }
  function outputBar(inv, statusCls){
    const os = outputState(inv, statusCls);
    const curW = (inv.current_power_w != null) ? inv.current_power_w : null;
    const curKw = curW != null ? (curW / 1000) : null;
    const maxKw = os.maxW != null ? (os.maxW / 1000) : null;
    let label;
    if(!os.reporting){
      // Distinguish "we have no live wattage feed for this vendor" (Fronius:
      // current_power_w == null) from "live feed says ~0 right now" (genuinely
      // idle). The former produced today — show its REAL kWh, never "not
      // producing right now", which reads as dead next to live-feed siblings.
      const tk = liveReadingMissing(inv) ? todayKwh(inv) : null;
      if(tk != null && tk > 0){
        label = `<b class="sb-ob-pct">${tk.toFixed(1)} kWh</b><span class="sb-ob-of">produced today · no live feed</span>`;
      } else if(liveReadingMissing(inv)){
        label = `<span class="sb-ob-idle">no live feed from this inverter</span>`;
      } else {
        label = `<span class="sb-ob-idle">not producing right now</span>`;
      }
    } else if(os.pct != null){
      // Mark an estimated denominator honestly ("of ~est. max"); a real
      // nameplate stays the plain "of max · cur/max kW".
      const ofTxt = os.estimated
        ? `<span title="No rated nameplate from this vendor — max estimated from peak production.">of ~est · <b class="sb-ob-cur">${curKw.toFixed(1)}</b>/~${maxKw.toFixed(1)} kW</span>`
        : `of max · <b class="sb-ob-cur">${curKw.toFixed(1)}</b>/${maxKw} kW`;
      label = `<b class="sb-ob-pct">${os.pct}%</b><span class="sb-ob-of">${ofTxt}</span>`;
    } else {
      // Producing, but no rated max AND no history to estimate from — last-resort
      // absolute kW (should be rare now that history backstops the estimate).
      label = `<b class="sb-ob-pct">${curKw.toFixed(1)} kW</b><span class="sb-ob-of">producing now</span>`;
    }
    const fillPct = os.reporting ? (os.pct != null ? os.pct : 100) : 0;
    return `<div class="sb-outbar ${os.tone}" data-curw="${curW!=null?curW:''}" data-maxw="${os.maxW!=null?os.maxW:''}"${os.estimated?' data-est="1"':''}>
      <div class="sb-ob-head"><span class="sb-ob-k">Output now</span>${label}</div>
      <div class="sb-ob-track"><div class="sb-ob-fill" style="width:${fillPct}%"></div></div>
    </div>`;
  }

  // ── Liquid-fill energy layer (design spec: liquid-cards/INTEGRATION-SPEC.md) ──
  // A bubbling green fill rises BEHIND the card content (the frosted .sb-inv-plate
  // sits above it, z-index 3, so text/sparkline never wash out). Fill height =
  // capacity factor = current/max — the SAME number behind "Output now %", so no
  // new data. The "Sleeping" night state (calm indigo pool) triggers ONLY on
  // (sun-down AND zero output) using the server is_daylight flag — never zero
  // alone, so a daytime fault that zeroes output stays alarming, not "asleep".
  // Tiny deterministic PRNG seeded by serial → bubble positions are STABLE across
  // the 60s poll re-render (spec bug #3: random re-roll makes bubbles teleport).
  function _seedRand(seed){
    let h = 2166136261 >>> 0;
    const s = String(seed);
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t>>>15, 1|t); t = (t + Math.imul(t ^ t>>>7, 61|t)) ^ t; return ((t ^ t>>>14) >>> 0) / 4294967296; };
  }
  function liquidState(inv, statusCls, isDaylight){
    const curW = (inv.current_power_w != null) ? inv.current_power_w : null;
    const sleeping = (isDaylight === false) && (curW == null || curW <= 1);
    if(sleeping) return "sleep";
    if(statusCls === "bad") return "fault";
    const os = outputState(inv, statusCls);
    if(os.pct != null && os.pct >= 98) return "clip";
    if(os.pct != null && os.pct < 35) return "low";
    return "ok";
  }
  // ── LIVE peer cross-check for the health badge ──────────────────────────────
  // inv.status is a 14-DAY peer verdict (backend peer_analysis): an inverter that
  // only just stalled keeps reading "ok" for up to DEAD_DAYS(=2) days. That is why
  // a card can show the green "All good" badge while OUTPUT NOW reads "not
  // producing right now" — the badge never consulted the live number. We close
  // that gap by applying the SAME peer-relative idea to the INSTANTANEOUS reading:
  // an inverter dark right now while a quorum of its daylight siblings produce is
  // a real-time anomaly the badge must not paper over.
  //   "ok"    → producing, OR calmly idle (night / peers also idle / too few lit
  //             peers to judge) — badge may say "All good"
  //   "dark"  → fresh live reading ~0 W while ≥2 peers produce in daylight — a
  //             real anomaly that the slow 14-day health hasn't caught yet (amber)
  //   "stale" → NO live reading while peers produce in daylight — unknown, could
  //             be a telemetry gap, not a confirmed power fault (neutral)
  // The classifier itself lives in FleetStore so the grid + command center share
  // the EXACT same logic (one source of truth — no drift across surfaces). This
  // thin wrapper keeps a self-contained fallback for any context where the store
  // isn't present (e.g. an isolated render test).
  function liveVerdict(inv, peers, isDaylight){
    if(window.FleetStore && FleetStore.liveVerdict)
      return FleetStore.liveVerdict(inv, peers, isDaylight);
    if(isDaylight === false) return "ok";
    const floorOf = i => (i.nameplate_kw != null) ? Math.max(25, i.nameplate_kw*1000*0.01) : 25;
    const producing = i => i.current_power_w != null && i.current_power_w > floorOf(i);
    if(producing(inv)) return "ok";
    const litPeers = peers.filter(p =>
      p.inverter_id !== inv.inverter_id && producing(p)).length;
    if(litPeers < 2) return "ok";
    return (inv.current_power_w != null) ? "dark" : "stale";
  }

  // ── NOW state — the card's explicit LIVENESS axis ───────────────────────────
  // A card carries TWO independent truths that must never masquerade as one:
  //   • NOW    — is it making power THIS INSTANT? (current_power_w)
  //   • HEALTH — is it pulling its weight over 14 days? (inv.status, peer_analysis)
  // Conflating them is what produced the "All good" badge on a dark inverter. So
  // we surface NOW as its own small color-coded chip and leave the health badge
  // to mean ONLY health. liveState maps the instantaneous reading (cross-checked
  // against peers) to a labelled, toned state for that chip.
  //   producing → green   making power now
  //   idle      → grey     not producing, but calm (peers idle too / too few lit
  //                        peers to judge) — nothing wrong
  //   dark      → amber    not producing while ≥2 daylight peers are — the anomaly
  //   stale     → blue     no live reading at all — unknown, not a confirmed fault
  //   asleep    → lavender sun-down resting state (owned by the Sleeping visuals)
  function liveState(inv, peers, isDaylight, sleeping){
    if(sleeping) return { key:"asleep", label:"Asleep", tone:"sleep" };
    if(outputState(inv, "ok").reporting)
      return { key:"producing", label:"Producing", tone:"ok" };
    const lv = liveVerdict(inv, peers, isDaylight);
    if(lv === "dark")  return { key:"dark",  label:"Not producing", tone:"warn",
                                title:"Dark right now while sibling inverters are producing." };
    if(lv === "stale") return { key:"stale", label:"No signal", tone:"info",
                                title:"No live reading from this inverter right now." };
    return { key:"idle", label:"Idle", tone:"idle",
             title:"Not producing right now — but its peers aren't either, so nothing's wrong." };
  }

  function liquidLayer(inv, statusCls, isDaylight){
    const st = liquidState(inv, statusCls, isDaylight);
    const sleeping = st === "sleep";
    const os = outputState(inv, statusCls);
    // Fill height: resting pool at night; capacity factor otherwise. With no
    // nameplate (Chint) but real output, show a calm mid pool so it reads "on".
    let pct;
    if(sleeping) pct = 14;
    else if(os.pct != null) pct = Math.max(0, Math.min(100, os.pct));
    else if(!os.reporting && liveReadingMissing(inv) && (todayKwh(inv) || 0) > 0) pct = 45;
    else pct = os.reporting ? 55 : 0;
    // bubbles: none when sleeping/fault/empty; capped at 6 (spec perf rule).
    let bubbles = "";
    if(!sleeping && st !== "fault" && pct > 0){
      const rnd = _seedRand(inv.inverter_id != null ? inv.inverter_id : inv.sn || inv.name);
      const n = Math.min(6, 3 + Math.round((pct/100) * 4));
      for(let i=0;i<n;i++){
        const sz = (4 + rnd()*7).toFixed(1);
        const left = (8 + rnd()*84).toFixed(1);
        const dur = (3 + rnd()*2.4).toFixed(2);
        const delay = (rnd()*3).toFixed(2);
        bubbles += `<span style="width:${sz}px;height:${sz}px;left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
      }
    }
    let stars = "";
    if(sleeping){
      const rnd = _seedRand((inv.inverter_id != null ? inv.inverter_id : inv.sn || inv.name) + "n");
      for(let i=0;i<5;i++){
        const sz = (1.5 + rnd()*2).toFixed(1);
        const left = (10 + rnd()*80).toFixed(1);
        const bottom = (2 + rnd()*9).toFixed(1);
        const dur = (2.5 + rnd()*2.5).toFixed(2);
        const delay = (rnd()*3).toFixed(2);
        stars += `<span style="width:${sz}px;height:${sz}px;left:${left}%;bottom:${bottom}px;animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
      }
    }
    const moon = sleeping ? `<span class="sb-liq-moon" aria-hidden="true">🌙</span>` : "";
    return `<div class="sb-liquid sb-liquid--${st}" style="height:${pct}%" aria-hidden="true">
        <div class="sb-liq-bubbles">${bubbles}</div>
        <div class="sb-liq-stars">${stars}</div>
      </div>${moon}`;
  }

  // per-inverter vendor badge (smaller variant of the array brand chip) — empty if unknown
  function brandHTML(vendor){
    return (vendor && BRAND[vendor])
      ? `<span class="sb-brand sb-inv-brand ${esc(vendor)}">${esc(BRAND[vendor])}</span>` : "";
  }

  // ── ARRAY-LEVEL mirrors of the inverter card's live axes ────────────────────
  // The array card is the inverter card's bigger sibling: SAME construction
  // (liquid fill behind a frosted plate, production graph, NOW chip, output bar,
  // health badge, vendor link) but every signal is the WHOLE ARRAY's aggregate.
  // The two-clocks rule still holds: NOW = instantaneous aggregate output;
  // HEALTH = the 14-day verdict (arrayHealth / shared FleetStore classifier).

  // Aggregate "output now" across an array: summed current ÷ summed rated max,
  // estimating a per-inverter max from production history when a vendor gives no
  // nameplate (mirrors outputState/estNameplateW). The pct IS the array's average
  // production level — its live output as a % of combined capacity. Tone stays
  // calm (green/idle) unless the array's 14-day health is already flagged, so a
  // passing cloud never turns the bar orange.
  function arrayOutputState(invs, healthTone){
    let curW = 0, maxW = 0, anyReporting = false, anyRealNp = false, anyMax = false;
    (invs || []).forEach(inv => {
      const realW = (inv.nameplate_kw != null) ? inv.nameplate_kw * 1000 : null;
      const m = realW != null ? realW : estNameplateW(inv);
      if(realW != null) anyRealNp = true;
      if(m != null){ maxW += m; anyMax = true; }
      if(inv.current_power_w != null){ curW += inv.current_power_w; anyReporting = true; }
    });
    const floor = anyMax ? Math.max(25, maxW * 0.01) : 25;
    const producing = anyReporting && curW > floor;
    const estimated = anyMax && !anyRealNp;
    if(!producing) return { reporting:false, pct:null, tone:"idle", curW:0, maxW: anyMax?maxW:null, estimated };
    if(!anyMax)    return { reporting:true, pct:null, tone:(healthTone==="ok"?"ok":pctTone(50)), curW, maxW:null, estimated:false };
    const pct = Math.max(0, Math.min(100, Math.round((curW / maxW) * 100)));
    const tone = (healthTone === "ok") ? "ok" : pctTone(pct);
    return { reporting:true, pct, tone, curW, maxW, estimated };
  }

  // The array's NOW chip state (its liveness axis) — mirrors liveState but for the
  // whole array. Producing when the array makes power; Asleep at night with zero
  // output; "Not producing" (amber) ONLY when daylight + zero AND the 14-day
  // health (shared arrayHealth classifier) already sees trouble — never an
  // independent cloud false-alarm; otherwise a calm "Idle".
  function arrayLiveState(col, os, healthTone, liveAnoms){
    const sleeping = (col.is_daylight === false) && !os.reporting;
    if(sleeping) return { key:"asleep", label:"Asleep", tone:"sleep" };
    if(os.reporting) return { key:"producing", label:"Producing", tone:"ok" };
    if(col.is_daylight === false)
      return { key:"idle", label:"Idle", tone:"idle", title:"The sun is down — the array is resting." };
    if(healthTone !== "ok" || liveAnoms > 0)
      return { key:"dark", label:"Not producing", tone:"warn",
               title:"This array isn't producing while the sun is up." };
    return { key:"idle", label:"Idle", tone:"idle",
             title:"Not producing right now — but nothing looks wrong." };
  }

  // Array output bar — mirrors outputBar(), but the % is the array's AVERAGE
  // production level (combined current ÷ combined rated max). Carries the same
  // data-curw/data-maxw so the live ticker breathes it in place like an inverter.
  function arrayOutputBar(os){
    const fmt = v => v >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
    const curKw = os.curW != null ? os.curW / 1000 : null;
    const maxKw = os.maxW != null ? os.maxW / 1000 : null;
    let label;
    if(!os.reporting){
      label = `<span class="sb-ob-idle">array not producing right now</span>`;
    } else if(os.pct != null){
      const ofTxt = os.estimated
        ? `<span title="No rated nameplate from this vendor — combined max estimated from peak production.">of ~est · <b class="sb-ob-cur">${fmt(curKw)}</b>/~${fmt(maxKw)} kW</span>`
        : `array avg · <b class="sb-ob-cur">${fmt(curKw)}</b>/${fmt(maxKw)} kW`;
      label = `<b class="sb-ob-pct">${os.pct}%</b><span class="sb-ob-of">${ofTxt}</span>`;
    } else {
      label = `<b class="sb-ob-pct">${fmt(curKw)} kW</b><span class="sb-ob-of">producing now</span>`;
    }
    const fillPct = os.reporting ? (os.pct != null ? os.pct : 100) : 0;
    return `<div class="sb-outbar ${os.tone}" data-curw="${os.curW!=null?os.curW:''}" data-maxw="${os.maxW!=null?os.maxW:''}"${os.estimated?' data-est="1"':''}>
      <div class="sb-ob-head"><span class="sb-ob-k">Output now</span>${label}</div>
      <div class="sb-ob-track"><div class="sb-ob-fill" style="width:${fillPct}%"></div></div>
    </div>`;
  }

  // Array liquid-fill layer — the SAME energy-as-liquid metaphor as the inverter
  // card, driven by the array's aggregate capacity factor. Bubbles/stars seeded by
  // array_id so they're stable across the 60s re-render (mirrors liquidLayer).
  function arrayLiquidLayer(col, os, healthTone){
    const sleeping = (col.is_daylight === false) && !os.reporting;
    let st;
    if(sleeping) st = "sleep";
    else if(healthTone === "bad") st = "fault";
    else if(os.pct != null && os.pct >= 98) st = "clip";
    else if(os.pct != null && os.pct < 35) st = "low";
    else st = "ok";
    let pct;
    if(sleeping) pct = 14;
    else if(os.pct != null) pct = Math.max(0, Math.min(100, os.pct));
    else pct = os.reporting ? 55 : 0;
    const seed = "a" + (col.array_id != null ? col.array_id : col.array_name);
    let bubbles = "";
    if(!sleeping && st !== "fault" && pct > 0){
      const rnd = _seedRand(seed);
      const n = Math.min(7, 3 + Math.round((pct / 100) * 4));
      for(let i=0;i<n;i++){
        const sz = (5 + rnd()*9).toFixed(1);
        const left = (8 + rnd()*84).toFixed(1);
        const dur = (3 + rnd()*2.4).toFixed(2);
        const delay = (rnd()*3).toFixed(2);
        bubbles += `<span style="width:${sz}px;height:${sz}px;left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
      }
    }
    let stars = "";
    if(sleeping){
      const rnd = _seedRand(seed + "n");
      for(let i=0;i<7;i++){
        const sz = (1.5 + rnd()*2.2).toFixed(1);
        const left = (8 + rnd()*84).toFixed(1);
        const bottom = (2 + rnd()*11).toFixed(1);
        const dur = (2.5 + rnd()*2.5).toFixed(2);
        const delay = (rnd()*3).toFixed(2);
        stars += `<span style="width:${sz}px;height:${sz}px;left:${left}%;bottom:${bottom}px;animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
      }
    }
    const moon = sleeping ? `<span class="sb-liq-moon" aria-hidden="true">🌙</span>` : "";
    return `<div class="sb-liquid sb-liquid--${st}" style="height:${pct}%" aria-hidden="true">
        <div class="sb-liq-bubbles">${bubbles}</div>
        <div class="sb-liq-stars">${stars}</div>
      </div>${moon}`;
  }

  // ---- per-array expanded state (which inverter combs are open) ----
  // Persisted as a JSON array of array_id strings under EXPAND_KEY; collapsed is
  // the default so the array cards stay the clean main view.
  function getExpandedSet(){
    try {
      const a = JSON.parse(localStorage.getItem(EXPAND_KEY) || "[]");
      return new Set(Array.isArray(a) ? a.map(String) : []);
    } catch(e){ return new Set(); }
  }
  function hasExpandPref(){
    try { return localStorage.getItem(EXPAND_KEY) != null; } catch(e){ return false; }
  }
  function saveExpandedSet(set){
    try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...set])); } catch(e){}
  }

  // ---- sandbox orientation (vertical = arrays side-by-side, inverters drop BELOW
  // each array; horizontal = arrays stacked on the LEFT, inverters spread out to
  // the RIGHT of their array). Persisted under ORIENT_KEY; DEFAULT horizontal. ----
  function getOrient(){
    try {
      const v = localStorage.getItem(ORIENT_KEY);
      // default to horizontal when the owner hasn't explicitly chosen vertical
      return v === "vertical" ? "vertical" : "horizontal";
    } catch(e){ return "horizontal"; }
  }
  function setOrient(o){
    try { localStorage.setItem(ORIENT_KEY, o === "horizontal" ? "horizontal" : "vertical"); } catch(e){}
  }

  // ---- view mode: "grid" (fleet OVERVIEW — health-tinted tile per array) vs
  // "canvas" (the interactive tree). Persisted; DEFAULT canvas so the owner lands
  // on the zoomed-out tree with every inverter revealed (quick whole-fleet picture). ----
  const VIEWMODE_KEY = "ao_sandbox_viewmode";
  function getViewMode(){
    try { return localStorage.getItem(VIEWMODE_KEY) === "grid" ? "grid" : "canvas"; }
    catch(e){ return "canvas"; }
  }
  function setViewMode(m){
    try { localStorage.setItem(VIEWMODE_KEY, m === "canvas" ? "canvas" : "grid"); } catch(e){}
  }

  // ---- origin-site deep links for an array's "Array details" column ----
  // Render column.origin_links when the backend supplies them; otherwise fall
  // back to a single base portal link derived from PORTAL_URL keyed by the array's
  // vendor (or the first of its vendors[]). Empty string when nothing resolves.
  // Resolve the deep-link rows for a column: backend-supplied origin_links when
  // present, else a single base portal link derived from PORTAL_URL keyed by the
  // array's vendor (or the first of its vendors[]). Returns [] when nothing resolves.
  function originLinks(col){
    let links = Array.isArray(col.origin_links) ? col.origin_links.slice() : [];
    if(!links.length){
      const v = col.vendor || (Array.isArray(col.vendors) && col.vendors[0]) || "";
      const url = PORTAL_URL[v];
      if(url) links = [{ vendor:v, label: BRAND[v] || v, url }];
    }
    return links;
  }
  function originLinksHTML(col){
    const links = originLinks(col);
    if(!links.length) return "";
    const rows = links.map(l => {
      const label = l.label || BRAND[l.vendor] || l.vendor || "portal";
      return `<a class="sb-origin" href="${esc(l.url)}" target="_blank" rel="noopener">Open in ${esc(label)} ↗</a>`;
    }).join("");
    return `<div class="sb-origins">${rows}</div>`;
  }
  // Single merged brand pill for a single-vendor array: a vendor-COLORED pill that
  // is ITSELF the portal link ("Open in SolarEdge ↗") when a URL resolves, else a
  // plain non-clickable brand pill. Returns "" when col has no single vendor.
  function brandLinkHTML(col){
    if(!col.vendor) return "";
    const v = col.vendor;
    const label = BRAND[v] || v;
    const links = originLinks(col);
    const url = links.length ? links[0].url : "";
    if(url){
      return `<a class="sb-brand sb-brandlink ${esc(v)}" href="${esc(url)}" target="_blank" rel="noopener">Open in ${esc(label)} ↗</a>`;
    }
    return `<span class="sb-brand ${esc(v)}">${esc(label)}</span>`;
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
        <div class="sb-head-left">
          <div class="sb-head-btns">
            <button class="sb-resetbtn sb-viewmode-btn" id="sbViewMode" type="button" title="Switch between the fleet OVERVIEW grid and the interactive tree">${getViewMode()==="grid" ? "⌗ Tree view" : "⊞ Overview"}</button>
            <button class="sb-resetbtn sb-showall" id="sbShowAll" type="button" title="Back to the fleet overview grid (you drilled into a single array)" hidden>⊞ All arrays</button>
          </div>
        </div>
        <div class="sb-head-actions">
          <div class="sb-head-btns">
            <button class="sb-resetbtn" id="sbUndo" type="button" title="Undo the last inverter move (Ctrl/Cmd+Z)" disabled>↶ Undo</button>
            <button class="sb-resetbtn" id="sbRedo" type="button" title="Redo (Ctrl/Cmd+Shift+Z)" disabled>↷ Redo</button>
            <button class="sb-resetbtn" id="sbFullscreen" type="button" title="Expand the fleet tree to full screen">⛶ Full screen</button>
            <button class="sb-resetbtn" id="sbOrient" type="button" title="Switch between stacked (arrays side-by-side) and horizontal (arrays on the left, inverters spreading right) layout">⬌ Horizontal</button>
            <button class="sb-resetbtn" id="sbExpandAll" type="button" title="Open every array's inverter list at once (click again to collapse them all)">⊕ Show all inverters</button>
            <button class="sb-resetbtn" id="sbNewArray" type="button" title="Create an empty array to drag inverters into">New empty array</button>
            <button class="sb-resetbtn" id="sbReset" type="button" title="Snap every inverter back to its discovered vendor grouping on the server">Reset layout</button>
            <button class="sb-addbtn" id="sbAddArray">+ Add array</button>
          </div>
          <div class="sb-legend">
            <span><i class="sw ok"></i>healthy</span>
            <span><i class="sw warn"></i>watch</span>
            <span><i class="sw bad"></i>critical</span>
          </div>
        </div>
      </div>`;

    // ---- OVERVIEW GRID mode: a health-tinted tile per array, the whole fleet at
    // a glance. Uses ALL arrays (not the focus subset), so an owner sees their
    // entire fleet's state spatially. Click a tile → drill into that array (canvas
    // view, focused + expanded). This is the default zoomed-out view. ----
    if(getViewMode() === "grid"){
      renderGrid(host, head);
      return;
    }

    // Source-data freshness banner for an array card. When the array's vendor
  // portal stopped receiving data from the site (backend source_status.state ===
  // "stale"), show an amber banner that makes the OWNERSHIP of the outage explicit:
  // it's the source/vendor that lost the data feed, NOT Array Operator. Renders ""
  // when data is fresh ("ok") or there's no live feed at all ("none").
  function fmtAge(h){
    if(h == null) return "";
    if(h < 1) return "under an hour ago";
    if(h < 48) return `${Math.round(h)} hour${Math.round(h)===1?"":"s"} ago`;
    return `${Math.round(h/24)} day${Math.round(h/24)===1?"":"s"} ago`;
  }
  function sourceStatusHTML(col){
    const ss = col && col.source_status;
    if(!ss || ss.state !== "stale") return "";
    const vlabel = col.vendor ? (BRAND[col.vendor] || col.vendor)
      : (Array.isArray(col.vendors) && col.vendors.length ? (BRAND[col.vendors[0]]||col.vendors[0]) : "the monitoring portal");
    const age = fmtAge(ss.age_hours);
    const ageTxt = age ? ` ${age}` : "";
    return `<div class="sb-srcout" role="status"
      title="This is a data outage at the source (${esc(String(vlabel))}), not in Array Operator. We'll show live data again as soon as ${esc(String(vlabel))} resumes reporting.">
      <span class="sb-srcout-ic" aria-hidden="true">⚠</span>
      <span class="sb-srcout-txt"><b>${esc(String(vlabel))} stopped reporting${ageTxt}.</b>
      This is a data outage at the source — not Array Operator. Live data resumes automatically when ${esc(String(vlabel))} reconnects.</span>
    </div>`;
  }

  const expanded = getExpandedSet();   // which arrays have their inverter comb open
    const expandAllDefault = !hasExpandPref();  // first visit → reveal every inverter
    const columns = cols.map(col => {
      const isOpen = expandAllDefault || expanded.has(String(col.array_id));
      const invs = col.inverters || [];
      // tier-2 chip:
      //  - single vendor → ONE merged, vendor-colored, clickable brand pill that
      //    is itself the portal link ("Open in SolarEdge ↗"); see brandLinkHTML.
      //  - mixed vendors → a "mixed · …" chip (origin link(s) render beneath it).
      let brandChip = "";
      if(col.vendor){
        brandChip = brandLinkHTML(col);
      } else if(Array.isArray(col.vendors) && col.vendors.length){
        const labels = col.vendors.map(v => BRAND[v] || v).join(" · ");
        brandChip = `<span class="sb-brand mixed" title="${esc(labels)}">mixed · ${esc(labels)}</span>`;
      }

      // bottom comb — one card per inverter (each individually drag-movable).
      // Sorted by SIZE (nameplate kW), biggest first, per Ford's design. The drag
      // id is the REAL server-known inv.inverter_id; vendor badge is per-inverter.
      const sortedInvs = invs.slice().sort((x, y) =>
        (y.nameplate_kw || 0) - (x.nameplate_kw || 0) || String(x.name).localeCompare(String(y.name)));
      const teeth = sortedInvs.length ? sortedInvs.map(inv => {
        const sCls = STATUS_CLASS[inv.status] || "ok";
        const np = inv.nameplate_kw!=null ? `${inv.nameplate_kw} kW` : "";
        const power = inv.current_power_w!=null ? `${(inv.current_power_w/1000).toFixed(2)} kW now` : "";
        const curKw = inv.current_power_w!=null ? (inv.current_power_w/1000) : null;
        // Min / Max are REAL lowest & highest DAILY kWh in the window (backend);
        // Current is the live kW reading. Max also falls back to nameplate (rated
        // ceiling) when there's no daily history yet.
        const maxKwh = inv.peak_kwh!=null ? inv.peak_kwh : null;
        const minKwh = inv.min_kwh!=null ? inv.min_kwh : null;
        const spark = invSpark(inv.daily, sCls);
        // output tone drives the bar AND the whole-card tint — see outputState():
        // a near-zero live reading (evening/night) is idle (no alarm), and the
        // orange tint only fires when health is already flagged.
        const obTone = outputState(inv, sCls).tone;
        const liqSt = liquidState(inv, sCls, col.is_daylight);
        const sleeping = liqSt === "sleep";
        // The card's two axes, kept SEPARATE and explicitly labelled:
        //  • HEALTH badge — purely the 14-day peer verdict (inv.status). It no
        //    longer second-guesses the live reading; that was the source of the
        //    "All good on a dark inverter" contradiction.
        //  • NOW chip — the instantaneous liveness state (liveState), peer-checked.
        const isAlert = sCls !== "ok";
        const isMonitoring = inv.status === "monitoring";
        const healthLabel = isMonitoring ? "Monitoring"
          : isAlert ? (STATUS_LABEL[inv.status] || inv.status || "Needs a look") : "All good";
        const healthTitle = isMonitoring
          ? "Gathering data — not enough history yet to compare this inverter against its neighbors."
          : "Health over the last 14 days vs its peers.";
        const healthBadge = `<div class="sb-inv-alert ${sCls}" title="${esc(healthTitle)}">${esc(healthLabel)}</div>`;
        const ls = liveState(inv, sortedInvs, col.is_daylight, sleeping);
        const nowChip = `<div class="sb-inv-now ${ls.tone}"${ls.title?` title="${esc(ls.title)}"`:""}><span class="sb-now-dot"></span>${esc(ls.label)}</div>`;
        // The whole-card tint: a live anomaly (dark while peers produce) edges the
        // card amber so it reads as needing a look even before 14-day health flags
        // it; otherwise the calm output tone drives it.
        const cardTone = (!isAlert && ls.key === "dark") ? "warn" : obTone;
        return `
          <div class="sb-inv ${sCls}${sleeping?' sleep':''}" tabindex="0" draggable="true" data-tone="${cardTone}"
               data-inv-id="${esc(inv.inverter_id)}" data-array-id="${esc(col.array_id)}" data-vendor="${esc(inv.vendor||"")}"
               data-name="${esc(inv.name)}" data-status="${esc(inv.status)}"
               data-diag="${esc(inv.diagnosis||"")}" data-model="${esc(inv.model||"")}"
               data-np="${esc(np)}" data-win="${esc(inv.window_kwh!=null?inv.window_kwh+' kWh / 14d':'')}"
               data-mode="${esc(inv.last_mode||"")}" data-power="${esc(power)}"
               data-np-kw="${esc(inv.nameplate_kw!=null?inv.nameplate_kw:'')}" data-win-kwh="${esc(inv.window_kwh!=null?inv.window_kwh:'')}"
               data-pi="${esc(inv.peer_index!=null?inv.peer_index:'')}" data-stale="${esc(inv.stale_hours!=null?inv.stale_hours:'')}"
               data-peak="${esc(inv.peak_kwh!=null?inv.peak_kwh:'')}" data-min="${esc(inv.min_kwh!=null?inv.min_kwh:'')}"
               data-origin-url="${esc(inv.origin_url||"")}" data-origin-label="${esc(inv.origin_label||"")}">
            ${liquidLayer(inv, sCls, col.is_daylight)}
            <div class="sb-inv-plate">
              <div class="sb-inv-top">
                <div class="sb-inv-name">${esc(inv.name)}</div>
                ${np ? `<span class="sb-inv-size">${esc(np)}</span>` : ""}
              </div>
              ${spark || `<div class="sb-inv-nospark">no history yet</div>`}
              ${nowChip}
              ${outputBar(inv, sCls)}
              ${healthBadge}
              ${brandHTML(inv.vendor)}
            </div>
          </div>`;
      }).join("")
        : `<div class="sb-comb-empty">Empty array — drag inverters here</div>`;

      const n = col.inverter_count;
      const countLbl = `${n} inverter${n===1?'':'s'}`;

      // ── ARRAY CARD: the inverter card's bigger sibling, SAME construction ──
      // (liquid fill → frosted plate → name/size → production graph → NOW chip →
      // output bar → health badge → vendor link + weather), every signal being
      // the WHOLE ARRAY's aggregate. Two clocks kept separate: NOW = aggregate
      // live output; HEALTH = the 14-day verdict (shared arrayHealth classifier).
      const h = arrayHealth(col);                       // {tone,flagged,crit,total,liveAnoms,...}
      const aOs = arrayOutputState(invs, h.tone);       // aggregate live output / capacity
      const aSleeping = (col.is_daylight === false) && !aOs.reporting;
      const aLs = arrayLiveState(col, aOs, h.tone, h.liveAnoms);
      const aNowChip = `<div class="sb-inv-now ${aLs.tone}"${aLs.title?` title="${esc(aLs.title)}"`:""}><span class="sb-now-dot"></span>${esc(aLs.label)}</div>`;
      const aHealthLabel = h.tone === "ok" ? "All good"
        : h.tone === "bad" ? `${h.crit||h.flagged} down`
        : `${h.flagged} to check`;
      const aHealthBadge = `<div class="sb-inv-alert ${h.tone}" title="Array health over the last 14 days (${h.flagged} of ${h.total} inverter${h.total===1?'':'s'} flagged).">${esc(aHealthLabel)}</div>`;
      // total rated size pill (sum of inverter nameplates), like the inverter's kW pill
      const totNp = invs.reduce((t,i)=> t + (i.nameplate_kw||0), 0);
      const sizePill = totNp > 0 ? `<span class="sb-inv-size">${totNp>=100?Math.round(totNp):(Math.round(totNp*10)/10)} kW</span>` : "";
      // the whole-card tint mirrors the inverter card: amber on a live anomaly the
      // 14-day health hasn't caught yet, else the calm aggregate output tone.
      const aCardTone = (h.tone === "ok" && aLs.key === "dark") ? "warn" : aOs.tone;
      // Source-data freshness banner: when the VENDOR portal (e.g. SolarEdge)
      // stopped receiving data from this site, say so plainly — it's a source-
      // side outage, not our system. Renders nothing when data is fresh.
      const srcStatusBanner = sourceStatusHTML(col);
      // where the array's data comes from: a single clickable vendor brand-link
      // when single-vendor, else the mixed chip + origin portal links beneath.
      const srcLinks = col.vendor ? brandLinkHTML(col) : (brandChip + originLinksHTML(col));

      return `
        <div class="sb-col${isOpen?' expanded':''}" data-array-id="${esc(col.array_id)}" data-vendor="${esc(col.vendor||"")}">
          <!-- ARRAY CARD — mirrors the inverter card's design, scaled to the array.
               Whole card is the expand affordance; the ⠿ grip reorders it. -->
          <div class="sb-array sb-array--card ${aSleeping?'sleep':''}" data-tone="${aCardTone}">
            <span class="sb-drag" draggable="true" role="button" title="Drag this grip to reorder the array">⠿</span>
            ${arrayLiquidLayer(col, aOs, h.tone)}
            <div class="sb-array-plate">
              <div class="sb-inv-top">
                <div class="sb-array-k">Array</div>
                ${sizePill}
              </div>
              <div class="sb-array-name">${esc(col.array_name)}${weatherBadge(col)}</div>
              ${srcStatusBanner}
              ${arrayGraph(sortedInvs, col.daily)}
              ${aNowChip}
              ${arrayOutputBar(aOs)}
              ${aHealthBadge}
              <div class="sb-array-src">${srcLinks}</div>
              <button class="sb-inv-toggle" type="button" aria-expanded="${isOpen?'true':'false'}"
                      title="Show or hide this array's inverters">
                <span class="sb-inv-toggle-chev" aria-hidden="true">▸</span>
                <span class="sb-array-count">${countLbl}</span>
              </button>
            </div>
          </div>

          <!-- Collapsible inverter comb — hidden until the array is expanded -->
          <div class="sb-comb">
            <div class="sb-teeth">${teeth}</div>
          </div>
        </div>`;
    }).join("");

    host.innerHTML = head + `<div class="sb-viewport"><div class="sb-canvas sb-orient-${getOrient()}">${columns}</div></div>
      <div class="sb-foot" id="sbFoot">${DEFAULT_FOOT_HTML}</div>`;
    host.classList.remove("sb-mode-grid");

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

    // right-click an array card → small "Delete array" menu (persisted via FleetStore)
    host.addEventListener("contextmenu", e => {
      const col = e.target.closest && e.target.closest(".sb-col");
      if(!col || !host.contains(col)) return;        // not on an array card → native menu
      e.preventDefault();
      const id = col.dataset.arrayId;
      const nameEl = col.querySelector(".sb-array-name");
      const name = nameEl ? nameEl.textContent.trim() : "this array";
      showArrayCtxMenu(e.clientX, e.clientY, id, name);
    });

    wireFullscreen(host);
    wireOrient(host);
    wireViewMode(host);   // ⊞ Overview ↔ ⌗ Tree-view toggle
    wireShowAll(host);    // ⊟ Show all arrays (visible only when drilled into a subset)
    wireAlerts(host);     // 🔔 inverter email alert settings
    wireUndoRedo(host);   // ↶ Undo / ↷ Redo for inverter moves (FleetStore history)
    wireExpandAll(host);  // "Show all inverters" — open/collapse every array's comb
    wireAddButton(host);
    wireNewArrayButton(host);
    wireResetButton(host);
    wireDrag(host);       // whole-column reorder (drag the .sb-array node)
    wireInvDrag(host);    // per-inverter reorder + cross-array move (PERSISTED to backend)
    wireInvToggle(host);  // expand/collapse each array's inverter comb (persisted)
    applyRenames(host);   // re-apply owner inline renames (array & inverter names)
    wireRenames(host);    // click-to-edit array & inverter names (persisted to localStorage)
    startLiveTicker();    // keep each card's "kW now" reading live
    wirePanZoom(host);    // drag empty space to pan, wheel to zoom the fleet canvas
    wireCardButton(host); // "+ Card" menu (Note / Data)
    renderCards();        // recreate free + fixed owner cards from localStorage (idempotent)
    drawFleetConnectors(host); // SVG converging feeders → trunk → array (replaces the comb bus)
    refreshWeather(host); // live Open-Meteo pull for arrays with coords; synthetic otherwise
  }

  // A tiny tile sparkline (no axis) of an array's summed daily production, tinted
  // by the array's worst health. Pure inline SVG — cheap to draw 100+ of.
  function tileSpark(col, tone){
    const invs = col.inverters || [];
    if(!invs.length) return "";
    // sum daily kWh across the array's inverters into one series
    const byDay = {};
    let order = [];
    for(const inv of invs){
      for(const d of (inv.daily || [])){
        if(!(d.date in byDay)){ byDay[d.date] = 0; order.push(d.date); }
        byDay[d.date] += Math.max(0, +d.kwh || 0);
      }
    }
    const vals = order.map(dt => byDay[dt]);
    if(vals.length < 2) return "";
    const w = 100, h = 26, pad = 2;
    const max = Math.max(...vals, 0.001);
    const stroke = tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--good)";
    const X = i => pad + (i/(vals.length-1))*(w-2*pad);
    const Y = v => h-pad - (v/max)*(h-2*pad);
    const line = vals.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const area = `${X(0).toFixed(1)},${(h-pad).toFixed(1)} ${line} ${X(vals.length-1).toFixed(1)},${(h-pad).toFixed(1)}`;
    return `<svg class="sb-tile-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${area}" fill="${stroke}" opacity="0.13"/>
      <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`;
  }

  // ---- OVERVIEW GRID: one health-tinted tile per array, packed to fill the width.
  // Sorted worst-first so problems surface top-left. Click a tile → drill into that
  // array on the canvas (focused + expanded). The whole fleet, understood at a glance.
  function renderGrid(host, head){
    const cols = (window.FleetStore && FleetStore.toColumns)
      ? (FleetStore.toColumns().columns || [])
      : [];
    // compute health once, sort worst-first (crit → warn → ok), then by $ at stake
    const rank = { bad:0, warn:1, ok:2 };
    const tiles = cols.map(col => ({ col, h: arrayHealth(col) }))
      .sort((a,b) => (rank[a.h.tone]-rank[b.h.tone]) || (b.h.lossMo-a.h.lossMo) || String(a.col.array_name).localeCompare(String(b.col.array_name)));

    const tilesHTML = tiles.map(({col, h}) => {
      const flaggedBadge = h.flagged
        ? `<span class="sb-tile-flag ${h.tone}">${h.flagged} flagged</span>`
        : `<span class="sb-tile-flag ok">all good</span>`;
      const risk = h.lossMo >= 1
        ? `<span class="sb-tile-risk">${usd0(h.lossMo)}<small>/mo</small></span>`
        : ``;
      return `
        <button type="button" class="sb-tile ${h.tone}" data-array-id="${esc(col.array_id)}"
                title="Open ${esc(col.array_name)} in the tree view">
          <span class="sb-tile-dot ${h.tone}"></span>
          <span class="sb-tile-name">${esc(col.array_name)}</span>
          <span class="sb-tile-sub">${h.total} inverter${h.total===1?"":"s"}${col.vendor?` · ${esc(BRAND[col.vendor]||col.vendor)}`:""}</span>
          ${tileSpark(col, h.tone)}
          <span class="sb-tile-foot">${flaggedBadge}${risk}</span>
        </button>`;
    }).join("");

    host.innerHTML = head +
      `<div class="sb-gridwrap"><div class="sb-grid">${tilesHTML}</div></div>`;
    host.classList.add("sb-mode-grid");

    // Click a tile → switch to canvas, focused on that array + expanded.
    host.querySelectorAll(".sb-tile").forEach(tile => {
      tile.addEventListener("click", () => {
        const id = tile.dataset.arrayId;
        if(id == null) return;
        setViewMode("canvas");
        if(window.FleetStore && FleetStore.setFocus){
          // try to coerce id back to the same type the store holds
          const all = FleetStore.snapshot().arrays.map(a => a.id);
          const match = all.find(x => String(x) === String(id));
          FleetStore.setFocus([match != null ? match : id]);
        }
        try {
          const set = getExpandedSet(); set.add(String(id)); saveExpandedSet(set);
        } catch(e){}
        renderFromStore();
      });
    });

    wireFullscreen(host);
    wireViewMode(host);
    wireShowAll(host);
    wireAlerts(host);
    wireUndoRedo(host);
    wireAddButton(host);
    wireNewArrayButton(host);
    wireResetButton(host);
    wireCardButton(host);
  }

  // Draw the converging feeder wires for every array: each inverter curves up into
  // a single central trunk that flows UP into its array card (replacing the old
  // horizontal comb/bus). The SVG lives inside .sb-teeth so it pans/zooms with the
  // canvas transform; positions use untransformed layout offsets. Redrawn after
  // each render and (debounced) on resize.
  const SB_SVGNS = "http://www.w3.org/2000/svg";
  function drawFleetConnectors(host){
    const root = (host && host.querySelectorAll) ? host : document;
    // The feeder wires model inverters flowing UP into the array (vertical layout).
    // In horizontal orientation the comb sits to the RIGHT of the card, so the
    // vertical wires don't apply — skip them cleanly.
    if(getOrient() === "horizontal"){
      root.querySelectorAll("svg.sb-wires").forEach(s => s.remove());
      return;
    }
    root.querySelectorAll(".sb-comb").forEach(comb => {
      // skip collapsed arrays — their teeth are display:none and unmeasurable
      const ownerCol = comb.closest(".sb-col");
      if(ownerCol && !ownerCol.classList.contains("expanded")) return;
      const teeth = comb.querySelector(".sb-teeth");
      if(!teeth) return;
      const invs = [...teeth.querySelectorAll(".sb-inv")];
      const old = teeth.querySelector("svg.sb-wires");
      if(old) old.remove();
      if(!invs.length) return;
      const W = teeth.clientWidth, H = teeth.clientHeight, cx = W / 2;
      const svg = document.createElementNS(SB_SVGNS, "svg");
      svg.setAttribute("class", "sb-wires");
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      const mk = (cls, d) => {
        const p = document.createElementNS(SB_SVGNS, "path");
        p.setAttribute("class", cls); p.setAttribute("d", d); return p;
      };
      // STRAIGHT vertical line up each column: every inverter connects straight up
      // to the card directly above it — or into the array, for the top row — with a
      // small gap at both ends so things "barely touch". No central trunk/funnel.
      const meta = invs.map(inv => ({
        x: inv.offsetLeft + inv.offsetWidth / 2,
        top: inv.offsetTop,
        bottom: inv.offsetTop + inv.offsetHeight,
      }));
      const GAP = 6;
      const segs = [];
      meta.forEach(m => {
        const above = meta
          .filter(o => Math.abs(o.x - m.x) < 16 && o.top < m.top - 2)
          .sort((a, b) => b.top - a.top)[0];
        const yTop = above ? above.bottom + GAP : -24;   // straight up into the array
        const yBot = m.top - GAP;
        if(yBot - yTop > 3) segs.push([m.x, yBot, yTop]);
      });
      segs.forEach((sg, i) => {
        const d = `M ${sg[0]} ${sg[1]} L ${sg[0]} ${sg[2]}`;
        svg.appendChild(mk("feed", d));
        // one phase-staggered mote rises straight up each line
        const p = mk("flow", d);
        const ph = ((i * 2654435761 >>> 0) % 1000) / 1000 * 3;
        p.style.animationDelay = (-ph).toFixed(2) + "s";
        svg.appendChild(p);
      });
      teeth.appendChild(svg);
    });
  }
  let _sbWireResize = null;
  window.addEventListener("resize", () => {
    clearTimeout(_sbWireResize);
    _sbWireResize = setTimeout(() => drawFleetConnectors(document), 150);
  });

  // ---- live output ticker: updates each card's "kW now" in place. With live
  // telemetry this reflects polled current_power_w; on demo data it drifts gently
  // (~1%) around the last-known value. Each tick also runs the peer-drop alert.
  let _liveTimer = null, _liveBeat = 0;
  function startLiveTicker(){
    if(_liveTimer) clearInterval(_liveTimer);
    _liveBeat = 0;
    _liveTimer = setInterval(() => {
      _liveBeat++;
      const t = Date.now();
      document.querySelectorAll("#sandbox .sb-outbar").forEach(bar => {
        const maxW = parseFloat(bar.dataset.maxw);
        const base = parseFloat(bar.dataset.curw);
        if(!maxW || !base) return;                 // idle / not reporting → leave as-is
        // Smoothly breathe the live current around its last REAL reading every second.
        // A slow continuous sine (no per-tick random jitter, so the 1s cadence glides
        // instead of twitching) — paired with the CSS width/color transition this reads
        // as a living, real-time bar while the actual number refreshes hourly underneath.
        const phase = t/9000 + (base % 997);       // unique, slow per-inverter phase
        const cur = base * (1 + Math.sin(phase) * 0.012);
        const pct = Math.max(0, Math.min(100, Math.round((cur/maxW)*100)));
        // Health-aware tone (mirrors outputState): a healthy inverter never goes
        // orange just because live output dips — only a flagged inverter does. This
        // keeps the 1s ticker from re-introducing the false-orange on "All good" cards.
        const card = bar.closest(".sb-inv, .sb-array");
        const statusCls = card ? (card.classList.contains("bad") ? "bad" : card.classList.contains("warn") ? "warn" : "ok") : "ok";
        const tone = (statusCls === "ok") ? "ok" : pctTone(pct);
        const fill = bar.querySelector(".sb-ob-fill");
        if(fill) fill.style.width = pct + "%";
        const pctEl = bar.querySelector(".sb-ob-pct");
        if(pctEl) pctEl.textContent = pct + "%";
        const curEl = bar.querySelector(".sb-ob-cur");
        if(curEl) curEl.textContent = (cur/1000).toFixed(1);
        // retone the bar + the whole card if the band changed
        if(!bar.classList.contains(tone)){
          bar.classList.remove("ok","warn","bad","idle"); bar.classList.add(tone);
        }
        if(card && card.dataset.tone !== tone) card.dataset.tone = tone;
      });
      // The heavier per-card / detail-card recomputes don't need 1s resolution —
      // run them every ~3rd beat so the 1-second bar animation stays cheap & smooth.
      if(_liveBeat % 3 === 0){
        refreshDataCards();      // keep live-metric data cards in step
        refreshDetailCard();     // keep the open inverter detail card (kW + lost-$) live too
      }
    }, 1000);
  }

  // ---- live-output helpers (used by the detail card's "lost so far" $ math).
  // The floating peer-drop alert cards that once also used these were removed —
  // each array's rolled-up alert now lives in its card's right inner column.
  function _liveKW(el){
    // live kW now reads from the output bar's live current figure (.sb-ob-cur),
    // falling back to its seeded data-curw watts. (The old .sb-now-val on the card
    // was replaced by the live output bar.)
    const c = el.querySelector(".sb-ob-cur");
    const live = c ? parseFloat(c.textContent) : NaN;
    if(isFinite(live)) return live;
    const bar = el.querySelector(".sb-outbar");
    const w = bar ? parseFloat(bar.dataset.curw) : NaN;
    return isFinite(w) ? w/1000 : NaN;
  }
  function _nameplateKW(el){ const m = (el.dataset.np||"").match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; }

  // ---- selected-inverter DETAIL CARD ----
  // Persistent host on #sbWrap (survives fleet re-renders), pinned bottom-RIGHT of
  // the viewport.
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
    const lk = _liveKW(node);                                    // live kW from the output bar
    const live = isFinite(lk) ? lk.toFixed(1) : null;
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

    // origin deep-link: jump to this inverter's source site (or its vendor's portal
    // as a fallback) to analyze it deeper in the monitoring tool that owns its data.
    let originUrl = d.originUrl || "";
    let originLabel = d.originLabel || "";
    if(!originUrl && d.vendor && PORTAL_URL[d.vendor]){
      originUrl = PORTAL_URL[d.vendor];
      originLabel = originLabel || BRAND[d.vendor] || d.vendor;
    }
    const originRow = originUrl
      ? `<a class="sb-origin sb-dc-origin" href="${esc(originUrl)}" target="_blank" rel="noopener">Open in ${esc(originLabel||"portal")} ↗</a>`
      : "";

    // ---- ENRICHED stats for the blown-up card: $ at stake, peer index, last-seen,
    // nameplate, 14-day kWh, peak/low day, model. $ at stake is computed from this
    // inverter's shortfall vs its FAIR SHARE of the array's production (same model
    // as the overview grid / command center).
    const npKw   = parseFloat(d.npKw) || 0;
    const winKwh = parseFloat(d.winKwh);
    const piNum  = parseFloat(d.pi);
    const stale  = parseFloat(d.stale);
    const peak   = parseFloat(d.peak);
    const minD   = parseFloat(d.min);

    // fair-share $ at stake from the array cohort (sum sibling inverter np + win)
    let lossMo = 0;
    if(col){
      const sibs = [...col.querySelectorAll(".sb-inv")];
      const totalNp  = sibs.reduce((t,n)=> t + (parseFloat(n.dataset.npKw)||0), 0) || 1;
      const fleetWin = sibs.reduce((t,n)=> t + (parseFloat(n.dataset.winKwh)||0), 0);
      const fair = npKw/totalNp*fleetWin;
      let lostKwh = 0;
      if(d.status==="dead" || d.status==="fault") lostKwh = Math.max(0, fair-(winKwh||0));
      else if(d.status==="underperforming" && piNum) lostKwh = Math.max(0, fair/Math.max(piNum,0.01)-(winKwh||0));
      lossMo = dollarVal(lostKwh)/SB_WINDOW_DAYS*30;
    }

    const lastSeen = (d.status==="comm_gap" && isFinite(stale) && stale>0)
      ? (stale>=48 ? `${Math.round(stale/24)} days ago` : `${Math.round(stale)} h ago`)
      : (d.status==="dead" ? "not reporting" : "live now");

    const stat = (k,v,cls) => v ? `<div class="sb-dc-stat"><span class="sb-dc-sk">${k}</span><span class="sb-dc-sv ${cls||""}">${v}</span></div>` : "";
    const statsHTML = [
      lossMo>=1 ? `<div class="sb-dc-stat hero"><span class="sb-dc-sk">$ at stake</span><span class="sb-dc-sv bad">${usd0(lossMo)}<small>/mo</small></span></div>` : "",
      stat("Peer index", isFinite(piNum) ? `${piNum.toFixed(2)} <small>vs neighbors</small>` : "", sCls),
      stat("Nameplate", npKw ? `${npKw} kW` : ""),
      stat("Last 14 days", isFinite(winKwh) ? `${winKwh.toLocaleString()} kWh` : ""),
      stat("Last seen", lastSeen, d.status==="comm_gap"||d.status==="dead" ? "warn" : "ok"),
      stat("Best day", isFinite(peak) ? `${peak} kWh` : ""),
      stat("Lowest day", isFinite(minD) ? `${minD} kWh` : ""),
      stat("Model", d.model || ""),
    ].filter(Boolean).join("");

    const diagHTML = d.diag
      ? `<div class="sb-dc-diag ${sCls}">${esc(d.diag)}</div>` : "";
    const arrayTag = arrayName
      ? `<div class="sb-dc-array">${esc(arrayName)}</div>` : "";

    // BLOWN-UP CARD = an exact clone of the small inverter card, just bigger.
    // Cloning the live .sb-inv node guarantees identical data + styling (name,
    // size, spark, output bar, alert line, brand) — no separate layout to drift.
    const clone = node.cloneNode(true);
    clone.classList.remove("sel", "inv-dragging");
    clone.removeAttribute("draggable");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("style");

    const card = el(`
      <div class="sb-dc-modal" role="dialog" aria-modal="true" aria-label="Inverter detail">
        ${arrayTag}
        <div class="sb-dc-bigcard"></div>
        ${diagHTML}
        <div class="sb-dc-stats">${statsHTML}</div>
        ${originRow ? `<div class="sb-dc-actions">${originRow}</div>` : ""}
      </div>`);
    card.querySelector(".sb-dc-bigcard").appendChild(clone);

    const close = () => {
      _detailInvId = null;               // stop live updates for this card
      document.querySelectorAll("#sandbox .sb-inv.sel").forEach(n => n.classList.remove("sel"));
      host.classList.remove("sb-dc-open");
      host.removeEventListener("click", close);   // don't stack listeners across opens
      host.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      setDefaultFoot();
    };
    const onKey = (e) => { if(e.key === "Escape") close(); };

    // Click anywhere that ISN'T the card's actual content closes it. The host
    // (.sb-dc-open) is a full-viewport flex layer. We DON'T blanket-stop clicks on
    // the modal, because its grid cells stretch — the empty space under the left
    // card (where the bigcard cell is taller than its content) is part of the modal
    // and was a dead zone. Instead: keep open ONLY when the click lands on real
    // content (the card clone, stats, diagnosis, array tag, or actions); otherwise
    // close. Backdrop + host clicks also close.
    const CONTENT_SEL = ".sb-inv, .sb-dc-stats, .sb-dc-diag, .sb-dc-array, .sb-dc-actions";
    const backdrop = el(`<div class="sb-dc-backdrop"></div>`);
    backdrop.addEventListener("click", close);
    card.addEventListener("click", e => {
      if(e.target.closest(CONTENT_SEL)) e.stopPropagation();   // real content → keep open
      else close();                                            // empty modal area → close
    });
    host.addEventListener("click", close);

    host.innerHTML = "";
    // #sbWrap has a CSS transform (translateX(-50%)), which would make the modal's
    // position:fixed center relative to #sbWrap instead of the viewport. Reparent
    // the host to <body> while open so the backdrop + card center to the real
    // viewport; close() puts it back so the default corner panel still anchors right.
    if(host.parentElement !== document.body) document.body.appendChild(host);
    host.classList.add("sb-dc-open");     // switches host to full-screen centering layer
    host.appendChild(backdrop);
    host.appendChild(card);
    document.addEventListener("keydown", onKey);
    // The blown-up card is a static snapshot clone, so there's nothing for the
    // live ticker to update in here — unbind it so refreshDetailCard() no-ops.
    _detailInvId = null;
  }

  // Make the floating inverter detail card movable: drag it by its header. We move
  // the HOST (#sbDetail), switching it from its default right/bottom anchor to an
  // explicit left/top once the owner starts dragging, and clamp it inside #sbWrap
  // so it can't be flung off-screen. Pointer events so it works with mouse + touch.
  function makeDetailDraggable(host, card){
    const handle = card.querySelector(".sb-dc-head");
    if(!handle) return;
    handle.classList.add("sb-dc-grab");
    handle.addEventListener("pointerdown", e => {
      if(e.target.closest("a, button")) return;          // links/close button keep their own behaviour
      e.preventDefault();
      const bounds = (document.getElementById("sbWrap") || document.body).getBoundingClientRect();
      const cr = host.getBoundingClientRect();
      // pin to left/top in the wrap's coordinate space (drop the right/bottom anchor)
      const startX = e.clientX, startY = e.clientY;
      let left = cr.left - bounds.left, top = cr.top - bounds.top;
      host.style.right = "auto"; host.style.bottom = "auto";
      host.style.left = left + "px"; host.style.top = top + "px";
      host.classList.add("sb-dragging");
      try { handle.setPointerCapture(e.pointerId); } catch(_){}
      const move = ev => {
        const nx = left + (ev.clientX - startX), ny = top + (ev.clientY - startY);
        const maxX = bounds.width - cr.width - 6, maxY = bounds.height - cr.height - 6;
        host.style.left = Math.max(6, Math.min(maxX, nx)) + "px";
        host.style.top  = Math.max(6, Math.min(maxY, ny)) + "px";
      };
      const up = ev => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        host.classList.remove("sb-dragging");
        try { handle.releasePointerCapture(ev.pointerId); } catch(_){}
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
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
    const lk = _liveKW(node);
    const live = isFinite(lk) ? lk.toFixed(1) : null;
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
    const flaggedByState = LOST_STATES.has(d.status);
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
    // Prefer the live output bar's displayed current; fall back to its seeded watts.
    const c = inv.querySelector(".sb-ob-cur");
    const live = c ? parseFloat(c.textContent) : NaN;
    if(isFinite(live)) return live;
    const bar = inv.querySelector(".sb-outbar");
    const baseW = bar ? parseFloat(bar.dataset.curw) : NaN;
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

  // ---- right-click array context menu → "Delete array" (persisted via FleetStore) ----
  // Self-contained: one menu in the DOM at a time, appended to <body> (absolute) so the
  // canvas overflow can't clip it. Dismissed on outside click / Escape / scroll / another
  // contextmenu. Confirming calls FleetStore.deleteArray(id) (optimistic + backend DELETE).
  function closeArrayCtxMenu(){
    document.querySelectorAll(".sb-ctxmenu").forEach(m => m.remove());
    document.removeEventListener("click", closeArrayCtxMenu, true);
    document.removeEventListener("keydown", _arrayCtxKey, true);
    document.removeEventListener("scroll", closeArrayCtxMenu, true);
    document.removeEventListener("contextmenu", _arrayCtxOther, true);
  }
  function _arrayCtxKey(e){ if(e.key === "Escape") closeArrayCtxMenu(); }
  function _arrayCtxOther(e){
    // a contextmenu landing on our own menu shouldn't dismiss it; anything else does
    if(!(e.target.closest && e.target.closest(".sb-ctxmenu"))) closeArrayCtxMenu();
  }
  function showArrayCtxMenu(x, y, id, name){
    closeArrayCtxMenu();                               // only ever one menu
    const menu = el(`<div class="sb-ctxmenu" role="menu">
      <button type="button" class="sb-ctxmenu-del" role="menuitem">Delete array</button>
    </div>`);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.addEventListener("click", ev => ev.stopPropagation());
    menu.querySelector(".sb-ctxmenu-del").onclick = () => {
      if(confirm(`Delete array "${name}"? You can undo this (↶ Undo or Ctrl/Cmd+Z) right after.`)){
        FleetStore.deleteArray(id);
        toast(`Deleted "${name}" — press ↶ Undo (Ctrl/Cmd+Z) to bring it back.`, "ok");
      }
      closeArrayCtxMenu();
    };
    document.body.appendChild(menu);
    // keep the menu inside the viewport if it would overflow the right/bottom edge
    const r = menu.getBoundingClientRect();
    if(r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + "px";
    if(r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + "px";
    // dismissers (capture phase so they fire before anything stops propagation)
    setTimeout(() => {
      document.addEventListener("click", closeArrayCtxMenu, true);
      document.addEventListener("keydown", _arrayCtxKey, true);
      document.addEventListener("scroll", closeArrayCtxMenu, true);
      document.addEventListener("contextmenu", _arrayCtxOther, true);
    }, 0);
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
  // Promote the canvas to its own GPU layer ONLY while the user is actively
  // panning/zooming (smooth), then drop the promotion shortly after so the browser
  // re-rasterizes it crisply at the current scale. A permanent will-change keeps a
  // single 1× texture that gets stretched on zoom — that's what looked fuzzy.
  let _interactTimer = null;
  function markInteracting(c){
    if(!c) return;
    c.classList.add("sb-interacting");
    clearTimeout(_interactTimer);
    _interactTimer = setTimeout(() => c.classList.remove("sb-interacting"), 200);
  }
  // promote=true only for ZOOM: it briefly GPU-layers the canvas (smooth, then
  // re-rasterizes crisp on de-promote). PAN must NOT promote — translating never
  // changes scale, so it needs no re-raster, and the promote→de-promote cycle is
  // exactly what made a finished pan visibly "snap"/relocate. Pan stays a plain,
  // rock-solid, main-painted transform that holds precisely where you drop it.
  function applyCanvasView(host, promote){
    const c = (host||document).querySelector("#sandbox .sb-canvas");
    if(!c) return;
    // round the pan offset to whole pixels so text/edges don't land on half-pixels
    c.style.transform = `translate(${Math.round(_view.x)}px,${Math.round(_view.y)}px) scale(${_view.z})`;
    if(promote) markInteracting(c);
  }
  // ---- Full-screen mode: maximize #sbWrap (the whole fleet-tree card) to fill
  // the viewport via a CSS overlay class (.sb-fs). We drive it with our own class
  // rather than the native Fullscreen API because that API silently no-ops inside
  // embedded webviews; a position:fixed overlay works everywhere. Esc exits. ----
  let _fsBound = false;
  function fsLabel(){
    const wrap = document.getElementById("sbWrap");
    const btn  = document.getElementById("sbFullscreen");
    if(btn) btn.textContent = (wrap && wrap.classList.contains("sb-fs")) ? "⤢ Exit full screen" : "⛶ Full screen";
  }
  function exitFs(){
    const wrap = document.getElementById("sbWrap");
    if(wrap && wrap.classList.contains("sb-fs")){
      wrap.classList.remove("sb-fs");
      document.body.classList.remove("sb-fs-lock");
      fsLabel();
      requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
    }
  }
  // Overview-grid ↔ tree-canvas toggle. Persists the mode and re-renders.
  function wireViewMode(host){
    const btn = host.querySelector("#sbViewMode");
    if(!btn) return;
    btn.onclick = () => {
      setViewMode(getViewMode() === "grid" ? "canvas" : "grid");
      renderFromStore();
      requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
    };
  }

  // 🔔 Inverter email alerts — a small settings modal: toggle on/off, set the
  // recipient email, the sensitivity threshold (alert under X% of peers), and a
  // grace window. Persists to the backend (/v1/array-owners/alert-settings).
  function wireAlerts(host){
    const btn = host.querySelector("#sbAlerts");
    if(!btn) return;
    btn.onclick = () => openAlertsModal();
  }
  function openAlertsModal(){
    document.querySelectorAll(".sb-alerts-back").forEach(n=>n.remove());
    const back = el(`<div class="sb-alerts-back" role="dialog" aria-modal="true" aria-label="Inverter alerts">
      <div class="sb-alerts-modal">
        <button class="sb-alerts-x" type="button" aria-label="Close">×</button>
        <div class="sb-alerts-title">🔔 Inverter down alerts</div>
        <div class="sb-alerts-sub">Get an email the moment an inverter goes dark or slips below its neighbors.</div>
        <label class="sb-alerts-toggle"><input type="checkbox" id="aaEnabled"> <span>Email me when an inverter needs attention</span></label>
        <div class="sb-alerts-fields">
          <label class="sb-alerts-field"><span>Send alerts to</span>
            <input type="email" id="aaEmail" placeholder="you@example.com"></label>
          <label class="sb-alerts-field"><span>Alert when output drops below <b id="aaThreshVal">50%</b> of its neighbors</span>
            <input type="range" id="aaThresh" min="10" max="95" step="5" value="50"></label>
          <label class="sb-alerts-field"><span>Wait <b id="aaGraceVal">12h</b> before alerting (ignore passing clouds)</span>
            <input type="range" id="aaGrace" min="0" max="48" step="2" value="12"></label>
        </div>
        <div class="sb-alerts-note" id="aaNote"></div>
        <div class="sb-alerts-actions">
          <button class="sb-resetbtn" id="aaCancel" type="button">Cancel</button>
          <button class="sb-addbtn" id="aaSave" type="button">Save</button>
        </div>
      </div></div>`);
    document.body.appendChild(back);
    const $ = id => back.querySelector(id);
    const close = () => back.remove();
    back.addEventListener("click", e => { if(e.target === back) close(); });
    $("#aaCancel").onclick = close; $(".sb-alerts-x").onclick = close;
    document.addEventListener("keydown", function esc(e){ if(e.key==="Escape"){ close(); document.removeEventListener("keydown", esc);} });

    const thresh = $("#aaThresh"), grace = $("#aaGrace");
    const syncLbls = () => { $("#aaThreshVal").textContent = thresh.value+"%"; $("#aaGraceVal").textContent = grace.value+"h"; };
    thresh.oninput = syncLbls; grace.oninput = syncLbls;

    // load current settings
    const session = getSession();
    if(!session){ $("#aaNote").innerHTML = `<a href="onboarding.html">Sign in</a> to set up alerts.`; }
    else {
      fetch("/v1/array-owners/alert-settings", { headers:{ "Authorization":"Bearer "+session } })
        .then(r=>r.ok?r.json():null).then(s=>{
          if(!s) return;
          $("#aaEnabled").checked = !!s.enabled;
          $("#aaEmail").value = s.email || "";
          thresh.value = s.threshold_pct || 50;
          grace.value = s.grace_hours != null ? s.grace_hours : 12;
          syncLbls();
        }).catch(()=>{});
    }
    syncLbls();

    $("#aaSave").onclick = () => {
      if(!session){ $("#aaNote").innerHTML = `<a href="onboarding.html">Sign in</a> first.`; return; }
      const body = {
        enabled: $("#aaEnabled").checked,
        email: $("#aaEmail").value.trim(),
        threshold_pct: parseInt(thresh.value,10),
        grace_hours: parseInt(grace.value,10),
      };
      $("#aaNote").textContent = "Saving…";
      fetch("/v1/array-owners/alert-settings", {
        method:"PUT", headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+session },
        body: JSON.stringify(body)
      }).then(r=>r.json().then(j=>({ok:r.ok, j}))).then(({ok,j})=>{
        if(!ok){ $("#aaNote").textContent = (j && j.detail) || "Couldn't save — check the email."; return; }
        close();
        toast(j.enabled ? `Alerts on — we'll email ${j.email} when an inverter needs you.` : "Inverter alerts turned off.", "ok");
      }).catch(()=>{ $("#aaNote").textContent = "Network error — try again."; });
    };
  }
  // "Show all arrays" — visible only in TREE view when the owner has drilled into a
  // narrowed subset (e.g. clicked one tile in the overview grid). The whole-fleet
  // view that actually works is the OVERVIEW GRID (the tree dumped 100 arrays into a
  // sparse single column), so this returns to the grid and clears the drill-in focus.
  function wireShowAll(host){
    const btn = host.querySelector("#sbShowAll");
    if(!btn) return;
    const narrowed = getViewMode() === "canvas" && window.FleetStore
      && FleetStore.focusIsNarrowed && FleetStore.focusIsNarrowed();
    btn.hidden = !narrowed;
    btn.onclick = () => {
      if(window.FleetStore && FleetStore.clearFocus) FleetStore.clearFocus();
      setViewMode("grid");                 // the grid IS the all-arrays view
      renderFromStore();
      requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
    };
  }

  function wireFullscreen(host){
    const btn  = host.querySelector("#sbFullscreen");
    const wrap = document.getElementById("sbWrap");
    if(!btn || !wrap) return;
    fsLabel();
    btn.onclick = () => {
      const on = wrap.classList.toggle("sb-fs");
      document.body.classList.toggle("sb-fs-lock", on);   // freeze the page behind it
      fsLabel();
      requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
    };
    if(!_fsBound){
      _fsBound = true;
      document.addEventListener("keydown", e => { if(e.key === "Escape") exitFs(); });
    }
  }

  // ↶ Undo / ↷ Redo for inverter moves. The history lives in FleetStore (command-
  // inverse for reassign/reorder; structural commits clear it). Buttons reflect
  // canUndo/canRedo, and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z are bound once globally.
  let _undoKeysBound = false;
  function syncUndoRedoButtons(){
    const u = document.getElementById("sbUndo"), r = document.getElementById("sbRedo");
    if(u) u.disabled = !(window.FleetStore && FleetStore.canUndo && FleetStore.canUndo());
    if(r) r.disabled = !(window.FleetStore && FleetStore.canRedo && FleetStore.canRedo());
  }
  function wireUndoRedo(host){
    const u = host.querySelector("#sbUndo"), r = host.querySelector("#sbRedo");
    if(u) u.onclick = () => { if(window.FleetStore) FleetStore.undo(); };
    if(r) r.onclick = () => { if(window.FleetStore) FleetStore.redo(); };
    syncUndoRedoButtons();
    if(!_undoKeysBound){
      _undoKeysBound = true;
      document.addEventListener("keydown", e => {
        // Only when the Arrays tab / sandbox is on screen and not editing text.
        if(!document.getElementById("sandbox")) return;
        const tag = (e.target && e.target.tagName) || "";
        if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
        const mod = e.metaKey || e.ctrlKey;
        if(mod && (e.key === "z" || e.key === "Z")){
          e.preventDefault();
          if(window.FleetStore){ e.shiftKey ? FleetStore.redo() : FleetStore.undo(); }
        } else if(mod && (e.key === "y" || e.key === "Y")){   // Ctrl+Y = redo (Windows convention)
          e.preventDefault();
          if(window.FleetStore) FleetStore.redo();
        }
      });
    }
  }

  // Orientation toggle: flips the persisted vertical/horizontal layout and re-renders
  // the fleet (the canvas orientation class is applied in render() from getOrient()).
  function wireOrient(host){
    const btn = host.querySelector("#sbOrient");
    if(!btn) return;
    const horiz = getOrient() === "horizontal";
    btn.textContent = horiz ? "⬍ Stacked" : "⬌ Horizontal";
    btn.onclick = () => {
      setOrient(getOrient() === "horizontal" ? "vertical" : "horizontal");
      renderFromStore();                                   // re-render with the new orientation
      requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
    };
  }

  // "Show all inverters" — open (or, when all are already open, collapse) EVERY
  // array's inverter comb in one click. Mirrors toggleArray's persisted-set logic
  // but batches the write + a single connector redraw + one re-fit so it stays
  // snappy across a big fleet instead of N separate redraws.
  function expandAllArrays(host, open){
    const cols = [...host.querySelectorAll(".sb-col")];
    if(!cols.length) return;
    const set = getExpandedSet();
    cols.forEach(col => {
      const id = String(col.dataset.arrayId);
      col.classList.toggle("expanded", open);
      const tog = col.querySelector(".sb-inv-toggle");
      if(tog) tog.setAttribute("aria-expanded", open ? "true" : "false");
      if(open) set.add(id); else set.delete(id);
    });
    saveExpandedSet(set);
    if(open) drawFleetConnectors(host);   // teeth measurable now → draw feeder wires once
    requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
  }
  function wireExpandAll(host){
    const btn = host.querySelector("#sbExpandAll");
    if(!btn) return;
    const allExpanded = () => {
      const cols = [...host.querySelectorAll(".sb-col")];
      return cols.length > 0 && cols.every(c => c.classList.contains("expanded"));
    };
    const syncLabel = () => { btn.textContent = allExpanded() ? "⊖ Collapse all" : "⊕ Show all inverters"; };
    syncLabel();   // reflect the persisted open/closed state on every render
    btn.onclick = () => { expandAllArrays(host, !allExpanded()); syncLabel(); };
  }

  // Auto-fit: scale + center the fleet so it fills the viewport (no empty void).
  function fitView(host){
    const vp = (host||document).querySelector(".sb-viewport");
    const c  = (host||document).querySelector("#sandbox .sb-canvas");
    if(!vp || !c) return;
    vp.style.height = "";                              // reset any prior shrink so we measure the full CSS height
    vp.style.minHeight = "";
    const prev = c.style.transform;
    c.style.transform = "none";                      // measure natural (unscaled) content
    const cr = c.getBoundingClientRect();
    const cw = cr.width, ch = cr.height;
    c.style.transform = prev;
    const vw = vp.clientWidth, vh = vp.clientHeight;
    if(!cw || !ch || !vw || !vh) return;
    // Fit so the whole fleet is visible, but never shrink so far it becomes a tiny
    // island in a sea of empty space — a glance at the zoomed-out view should read
    // instantly. Floor the zoom at 0.72 and let wide content scroll horizontally.
    const z = Math.max(0.72, Math.min(1.15, Math.min(vw/cw, vh/ch) * 0.98));
    const scaledW = cw * z, scaledH = ch * z;
    // Horizontal: center when the fleet is narrower than the viewport; otherwise
    // left-anchor (small margin) so it fills from the left and scrolls right —
    // never floating off to one side with a dead gap.
    const x = scaledW < vw - 32 ? (vw - scaledW)/2 : 48;
    // Vertical: top-anchor short (collapsed) fleets so they sit up top with room to
    // expand into; center tall ones.
    const y = scaledH < vh - 32 ? 40 : Math.max(8, (vh - scaledH)/2);
    _view = { z, x, y };
    applyCanvasView(host);

    // Collapse the empty void: when the fleet is much SHORTER than the viewport
    // (e.g. drilled into one array — a top band over a sea of black), shrink the
    // viewport to hug the content instead of holding the full calc(100vh-150px).
    // Never shrink below a sensible floor, and never grow past the CSS max.
    const vpEl = vp;
    const needed = scaledH + 64;                       // content + top/bottom breathing room
    if(needed < vh - 60){
      const hpx = Math.max(280, Math.round(needed)) + "px";
      vpEl.style.height = hpx;
      vpEl.style.minHeight = hpx;                       // beat the CSS min-height:520px floor
    } else {
      vpEl.style.height = "";
      vpEl.style.minHeight = "";                        // tall fleet → let CSS drive full height
    }
  }
  function wirePanZoom(host){
    const vp = host.querySelector(".sb-viewport");
    if(!vp) return;
    if(!_fitDone){ _fitDone = true; requestAnimationFrame(() => fitView(host)); }  // fit once layout settles
    else applyCanvasView(host);                         // keep the user's view across re-renders
    vp.addEventListener("wheel", e => {
      e.preventDefault();
      // Canvas convention: the wheel ZOOMS in/out, centered on the cursor — that's
      // the in/out depth gesture people expect on a map-style canvas. Pan the dense
      // fleet by dragging empty space, or middle-drag from anywhere (cards fill the
      // view), or hold Shift to nudge it sideways with the wheel.
      if(e.shiftKey){
        // Shift+wheel → horizontal pan (a useful escape hatch when zoomed in).
        _view.x -= (e.deltaX || e.deltaY);
        applyCanvasView(host);                          // pan → no promote (holds, crisp)
        return;
      }
      const r = vp.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top, prev = _view.z;
      const next = Math.min(2.5, Math.max(0.4, prev * (e.deltaY < 0 ? 1.12 : 1/1.12)));
      if(next === prev) return;                          // already at a zoom limit
      _view.x = cx - (cx - _view.x) * (next/prev);
      _view.y = cy - (cy - _view.y) * (next/prev);
      _view.z = next; applyCanvasView(host, true);       // zoom → promote + re-crisp
    }, { passive:false });
    // Suppress OS middle-click autoscroll so a middle-drag can pan instead.
    vp.addEventListener("mousedown", e => { if(e.button === 1) e.preventDefault(); });
    let panning=false, captured=false, pid=null, sx=0, sy=0;
    vp.addEventListener("pointerdown", e => {
      const onControl = e.target.closest("button,a,input");
      // MIDDLE button pans from ANYWHERE. LEFT button pans from the whole canvas
      // EXCEPT the things you grab to rearrange: inverter cards (.sb-inv), the
      // array reorder grip (.sb-drag), and empty-array drop zones. The array BODY
      // now pans (only its ⠿ grip reorders), so a packed fleet is movable.
      if(e.button === 1){
        if(onControl) return;
        e.preventDefault();
      } else if(e.button !== 0 || onControl || e.target.closest(".sb-inv,.sb-drag,.sb-comb-empty")){
        return;
      }
      panning=true; captured=false; pid=e.pointerId; sx=e.clientX-_view.x; sy=e.clientY-_view.y;
    });
    vp.addEventListener("pointermove", e => {
      if(!panning) return;
      // Defer pointer capture until the first real move, so a plain click still
      // reaches the element underneath (e.g. click an array name to rename it).
      if(!captured){ captured=true; vp.classList.add("panning"); try{ vp.setPointerCapture(pid); }catch(_){} }
      _view.x = e.clientX - sx; _view.y = e.clientY - sy; applyCanvasView(host);
    });
    const end = () => { panning=false; captured=false; vp.classList.remove("panning"); };
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

  /* ---- 'Reset layout' — snap inverters back to their discovered grouping.
   * Goes through the store (which persists to the server when live). ---- */
  function wireResetButton(host){
    const btn = host.querySelector("#sbReset");
    if(!btn) return;
    btn.onclick = () => {
      setSaving("Resetting to your discovered grouping…");
      FleetStore.resetLayout();           // store notifies → our subscription re-renders
    };
  }

  /* ---- 'New empty array' — create an owner-defined group to drag inverters
   * into. Goes through the store (persists when live). ---- */
  function wireNewArrayButton(host){
    const btn = host.querySelector("#sbNewArray");
    if(!btn) return;
    btn.onclick = () => {
      let name = window.prompt("Name your new array (then drag inverters into it):", "");
      if(name == null) return;                 // cancelled
      name = name.trim();
      if(!name){ toast("Enter a name for the new array.", "err"); return; }
      setSaving("Creating your new array…");
      const newId = FleetStore.createArray(name);
      // make sure the new (empty) column is visible in the focused subset
      const f = FleetStore.focusIds(); if(f.indexOf(newId)===-1) FleetStore.setFocus(f.concat([newId]));
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
    // Only the grip (⠿) starts an array-reorder drag — the array body is free to
    // pan. (The whole array node used to be draggable, which turned pan attempts
    // into accidental array moves.)
    canvas.querySelectorAll(".sb-array .sb-drag").forEach(grip => {
      grip.addEventListener("dragstart", e => {
        const col = grip.closest(".sb-col");
        if(!col) return;
        dragEl = col;
        canvas.classList.add("dragging-active");
        try { e.dataTransfer.setDragImage(col, 24, 18); } catch(_){}   // ghost the column, not the glyph
        // let the lift styling paint before the drag image snapshots
        requestAnimationFrame(() => col.classList.add("dragging"));
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", col.dataset.arrayId || ""); } catch(_){}
      });
      grip.addEventListener("dragend", () => {
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

  /* ---- expand/collapse an array's inverter comb ----
   * Collapsed by default (clean array-card view). Clicking ANYWHERE on the array
   * card toggles it (the small "N inverters" chevron is just an affordance now);
   * clicks on interactive bits inside the card (origin links, the rename field,
   * the drag grip) are excluded so they keep their own behaviour. Flips
   * .sb-col.expanded which CSS uses to show/hide the comb, and persists the open
   * set to localStorage. Expanding redraws the SVG feeder wires (teeth have no
   * measurable size while the comb is display:none, so they must be drawn once
   * it becomes visible). */
  function toggleArray(col, host, force){
    if(!col) return;
    const id = String(col.dataset.arrayId);
    const open = (force != null) ? force : !col.classList.contains("expanded");
    col.classList.toggle("expanded", open);
    const btn = col.querySelector(".sb-inv-toggle");
    if(btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    const set = getExpandedSet();
    if(open) set.add(id); else set.delete(id);
    saveExpandedSet(set);
    if(open) drawFleetConnectors(host);   // teeth now measurable → draw wires
  }
  function wireInvToggle(host){
    host.querySelectorAll(".sb-col").forEach(col => {
      const card = col.querySelector(".sb-array");
      if(!card) return;
      card.addEventListener("click", e => {
        // ignore clicks on interactive children (origin links, editable name,
        // drag grip, inputs) so they keep their own behaviour. The "N inverters"
        // chevron is a plain button INSIDE the card, so its clicks bubble here and
        // toggle too — no separate handler needed.
        if(e.target.closest("a, .sb-drag, [contenteditable='true'], input, textarea")) return;
        toggleArray(col, host);
      });
    });
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

        const invId = card.dataset.invId;
        const destArrayId = col.dataset.arrayId;
        if(invId==null || invId==="" || !window.FleetStore) return;

        // Route the move through the shared store. The store updates the
        // canonical fleet, recomputes peer indices for BOTH cohorts, and notifies
        // every subscriber — so the command center's KPIs + triage queue move in
        // the same frame, and our subscription re-renders this tree from truth.
        if(String(destArrayId) !== String(from)){
          const teeth = card.closest(".sb-teeth");
          const position = teeth ? [...teeth.querySelectorAll(".sb-inv")].indexOf(card) : 0;
          FleetStore.reassignInverter(invId, destArrayId, Math.max(0, position));
        } else {
          const teeth = col.querySelector(".sb-teeth");
          const ordered = teeth ? [...teeth.querySelectorAll(".sb-inv")].map(n => n.dataset.invId).filter(Boolean) : [];
          FleetStore.reorderInverters(destArrayId, ordered);
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

  // The fleet tree is now a VIEW over the shared FleetStore — it renders the
  // store's focused subset of arrays rather than fetching its own. Re-renders are
  // driven by the store subscription (below), so a change here OR in the command
  // center lands in both places in the same frame. The old per-write apiPost/
  // reload dance is gone: mutations go through FleetStore, which persists.
  function renderFromStore(){
    const host = document.getElementById("sandbox");
    if(!host || !window.FleetStore) return;
    if(!FleetStore.isLoaded()){
      // Kick the fetch immediately and show a light, unobtrusive skeleton (not a
      // big "Loading…" banner) so startup feels instant rather than blocked.
      host.innerHTML = `<div class="sb-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`;
      FleetStore.load();
      return;
    }
    render(FleetStore.focusColumns());
  }
  // names the rest of the file / tab system still call:
  function reload(){ renderFromStore(); }
  function load(){ renderFromStore(); }

  /* ===========================================================================
   * ADD-ARRAY MODAL — dark-skinned vendor picker. Mirrors the onboarding wizard's
   * connect step, but authed with the existing so_session and pointed at the
   * already-deployed connect endpoints. On success it re-loads the fleet tree.
   * ==========================================================================*/
  let _ov = null, _escH = null;
  let renderAddModalBody = null;   // assigned when the Add-array modal opens; the
                                   // extension-present listener calls it to re-render.
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
    let manual = false;                // false = one-click login view; true = paste-keys view
    const fields = {};                 // field name -> current value (manual mode)

    ov.innerHTML = `
      <div class="sb-modal" role="dialog" aria-modal="true" aria-label="Add an array">
        <div class="sb-modal-head">
          <div class="sb-modal-title">Add an array</div>
          <button class="sb-modal-x" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="sb-modal-body" id="sbModalBody"></div>
        <div class="sb-note" id="sbNote"></div>
        <div class="sb-modal-foot" id="sbModalFoot"></div>
      </div>`;
    ov.classList.add("open");

    const body = ov.querySelector("#sbModalBody");
    const foot = ov.querySelector("#sbModalFoot");
    const note = ov.querySelector("#sbNote");

    // Login-capable vendors (one-click via the helper).
    const LOGIN_VENDORS = ["solaredge","fronius","sma","chint","gmp","vec","wec"];

    // Render the modal body for the current mode. Exposed via closure so the
    // extension-present detector (handleCaptureLanded's sibling listener) can
    // re-render the moment the helper announces itself.
    renderAddModalBody = function(){
      note.className = "sb-note"; note.textContent = "";
      if(!manual){
        // ── One-click login view (the lead path) ──
        const loginBtns = LOGIN_VENDORS.map(code => `
          <button type="button" class="sb-login-btn" data-login="${code}">
            <span class="sb-login-brand sb-brand ${code}">${esc(BRAND[code]||code)}</span>
            <span class="sb-login-cta">Log in with ${esc(BRAND[code]||code)} →</span>
            ${code==="chint" ? `<span class="sb-login-tip">Open each of your sites once — all its inverters come in together.</span>` : ""}
            ${code==="gmp" ? `<span class="sb-login-tip">Your utility meter — brings in each account's solar production (whole-array, not per-inverter). Good when you have no inverter portal.</span>` : ""}
            ${(code==="vec"||code==="wec") ? `<span class="sb-login-tip">Your utility meter (SmartHub) — brings in each account's solar production (whole-array, not per-inverter). Good when you have no inverter portal.</span>` : ""}
          </button>`).join("");
        const extBlock = EXT_PRESENT
          ? `<p class="sb-modal-lede">Connect the easy way — log into the monitoring site you already use, and your inverters come in on their own. No keys to find.</p>
             <div class="sb-login-grid">${loginBtns}</div>`
          : `<p class="sb-modal-lede">Connect the easy way — add the free EnergyAgent helper, then log into the monitoring site you already use and your inverters come in on their own.</p>
             <a class="sb-mbtn primary sb-login-install" href="${EXT_STORE_URL}" target="_blank" rel="noopener">Add the 1-click helper — free →</a>
             <div class="sb-login-hint">Already added it? <button type="button" class="sb-linkbtn" id="sbRecheck">Re-check</button></div>`;
        body.innerHTML = extBlock +
          `<div class="sb-or"><span>or</span></div>
           <button type="button" class="sb-mbtn ghost sb-manual-toggle" id="sbManualToggle">Enter keys manually instead</button>`;
        foot.innerHTML = `<button class="sb-mbtn ghost" type="button" id="sbCancel">Close</button>`;

        body.querySelectorAll("[data-login]").forEach(b => {
          b.onclick = () => openPortalLogin(b.dataset.login);
        });
        const recheck = body.querySelector("#sbRecheck");
        if(recheck) recheck.onclick = () => extSend("SO_STATUS_REQUEST");
        body.querySelector("#sbManualToggle").onclick = () => { manual = true; renderAddModalBody(); };
      } else {
        // ── Manual key-entry view (buried behind the button) ──
        body.innerHTML = `
          <button type="button" class="sb-linkbtn sb-back" id="sbBackToLogin">← Back to one-click login</button>
          <p class="sb-modal-lede">Paste your monitoring credentials. SolarEdge unlocks every site on your account with one key; Locus, Fronius and SMA connect per array.</p>
          <div class="sb-vendgrid" id="sbVendGrid"></div>
          <div id="sbVendFields"></div>`;
        foot.innerHTML = `
          <button class="sb-mbtn ghost" type="button" id="sbCancel">Cancel</button>
          <button class="sb-mbtn primary" type="button" id="sbConnect" disabled>Connect</button>`;
        body.querySelector("#sbBackToLogin").onclick = () => { manual = false; renderAddModalBody(); };
        wireManualFlow();
        foot.querySelector("#sbConnect").onclick = submitConnect;
      }
      const cancel = foot.querySelector("#sbCancel");
      if(cancel) cancel.onclick = closeAddModal;
    };

    // ---- manual flow (the original grid + fields + validate) ----
    function wireManualFlow(){
      const grid = body.querySelector("#sbVendGrid");
      const fieldsBox = body.querySelector("#sbVendFields");
      const connectBtn = foot.querySelector("#sbConnect");

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
      renderGrid();
      renderFields();
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
      const config = {};
      (v.fields||[]).forEach(f => {
        const val = (fields[f.name]||"").trim();
        if(val) config[f.name==="apiKey" ? "api_key" : f.name] = val;
      });
      let url, body2;
      if(vendor==="solaredge"){
        url = "/v1/array-owners/solaredge/connect-account";
        body2 = { api_key: config.api_key };
      } else if(vendor==="locus" && (fields.partner_id||"").trim()){
        url = "/v1/array-owners/locus/connect-account";
        body2 = { client_id: fields.client_id, client_secret: fields.client_secret,
                 username: fields.username, password: fields.password,
                 partner_id: parseInt(fields.partner_id, 10) };
      } else {
        url = "/v1/array-owners/connect-single";
        body2 = { vendor, config };
      }
      const connectBtn = foot.querySelector("#sbConnect");
      note.className = "sb-note";
      note.textContent = v.discover ? `Reaching your ${v.label} account…` : `Connecting your ${v.label} system…`;
      if(connectBtn) connectBtn.disabled = true;
      try{
        const r = await fetch(url, {
          method:"POST",
          headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+session },
          body: JSON.stringify(body2)
        });
        let data = {}; try { data = await r.json(); } catch(e){}
        // A dead/rotated session can surface as 401 OR as 403 "Invalid or inactive
        // tenant key" (the backend falls through to the tenant-key auth path when
        // the session token no longer verifies). Treat BOTH as "please sign in
        // again" — never show the owner the raw tenant-key error.
        const authDead = r.status===401 ||
          (r.status===403 && /tenant key|sign in|session/i.test((data && (data.detail||data.message))||""));
        if(authDead){
          try { localStorage.removeItem("so_session"); } catch(e){}
          note.className = "sb-note err";
          note.innerHTML = `Your session expired — <a href="onboarding.html">sign in again →</a> to add this array. Your existing arrays are safe.`;
          if(connectBtn) connectBtn.disabled = false; return;
        }
        const ok = r.ok && (data.connected || data.created || data.matched || data.ok || data.array_id);
        if(ok){
          try {
            if(window.FleetStore && FleetStore.refetch){
              await FleetStore.refetch();
              // Show the full fleet (new array + everything already there).
              if(FleetStore.setFocus && FleetStore.snapshot){
                const all = (FleetStore.snapshot().arrays || []).map(a => a.id);
                if(all.length) FleetStore.setFocus(all);
              }
            }
          } catch(e){}
          closeAddModal(); load(); return;
        }
        note.className = "sb-note err";
        note.textContent = (data && (data.message || data.detail)) ||
          `Couldn't connect that ${v.label} account (HTTP ${r.status}). Double-check the credentials and try again.`;
        if(connectBtn) connectBtn.disabled = false;
      }catch(err){
        note.className = "sb-note err";
        note.textContent = "We couldn't reach the connection service just now — check your network and try again.";
        const cb = foot.querySelector("#sbConnect"); if(cb) cb.disabled = false;
      }
    }

    ov.querySelector(".sb-modal-x").onclick = closeAddModal;
    ov.onclick = e => { if(e.target === ov) closeAddModal(); };
    _escH = e => { if(e.key==="Escape") closeAddModal(); };
    document.addEventListener("keydown", _escH);

    renderAddModalBody();
  }

  /* ===========================================================================
   * MASTER ACCOUNT — profile + plan + billing. Fetches GET /v1/account and the
   * billing endpoints (which may 404/empty on a trial — handled gracefully).
   * company-name + email are inline-editable; everything else is display-only.
   * ==========================================================================*/
  let _account = null;                       // last-fetched account (shared with Reports prefill)

  function authHeaders(){ const s = getSession(); return s ? { Authorization: "Bearer " + s } : null; }
  function titleCase(s){ return String(s==null?"":s).replace(/_/g," ").replace(/\b\w/g, c => c.toUpperCase()); }
  function fmtDate(d){
    try {
      // A bare YYYY-MM-DD parses as UTC midnight, which renders a day early in
      // timezones behind UTC (trial-end / invoice dates). Pin those to local time.
      const m = (typeof d === "string") && d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const date = m ? new Date(+m[1], +m[2]-1, +m[3]) : new Date(d);
      return date.toLocaleDateString([], {month:"short",day:"numeric",year:"numeric"});
    } catch(e){ return String(d); }
  }
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

  /* ---- horizontal-row builders for the flat "all business" account list ---- */
  function rowStatic(label, valueHTML, subHTML, actionHTML){
    return `<div class="acct-row">
      <div class="r-k">${esc(label)}</div>
      <div class="r-v">${valueHTML}${subHTML ? `<span class="r-sub">${subHTML}</span>` : ""}</div>
      <div class="r-a">${actionHTML || ""}</div>
    </div>`;
  }
  function rowEdit(label, field, value, placeholder){
    return `<div class="acct-row acct-edit" data-field="${esc(field)}">
      <div class="r-k">${esc(label)}</div>
      <div class="r-v">
        <input type="text" autocomplete="off" spellcheck="false" value="${esc(value||"")}" placeholder="${esc(placeholder||"")}">
        <div class="acct-msg"></div>
      </div>
      <div class="r-a"><button class="acct-btn" type="button">Save</button></div>
    </div>`;
  }

  function renderAccountList(a){
    const list = document.getElementById("acctList");
    if(!list) return;
    const company  = pick(a, ["company_name","company"], "");
    const operator = pick(a, ["operator_name","name","owner_name"], "");
    const email    = pick(a, ["email","operator_email"], "");

    // One flat list of rows: identity → login & password → auto-refresh → bill → payment.
    list.innerHTML =
      rowStatic("Name", esc(operator || "—")) +
      rowEdit("Company", "company", company, "Add your company name") +
      rowEdit("Email", "email", email, "you@example.com") +
      rowStatic("Login", `<span id="loginEmail">${esc(email || "—")}</span>`, "the email you sign in with") +
      passwordRow(a) +
      autoRefreshRow() +
      rowStatic("Your bill",
        `<span class="r-big" id="billAmount">Loading…</span>`,
        `<span id="billWhy"></span>`) +
      rowStatic("Payment method",
        `<span id="payState">—</span><div class="acct-msg" id="billMsg"></div>`,
        null,
        `<button class="acct-btn primary" id="billManage" type="button">Add credit card</button>`);

    wireAcctEdits();
    wirePasswordRow();
    wireAutoRefreshRow();
  }

  /* ---- Auto-refresh row: manage the EnergyAgent extension's hourly auto-login
   * so live production stays fresh hands-free. Credentials are stored ENCRYPTED on
   * the owner's own machine (in the extension) and NEVER sent to our servers — this
   * row just reads/writes that local vault through the so_bridge postMessage relay.
   * Auto-refresh is ON by default (opt-out, per vendor). ---------------------- */
  const AR_VENDORS = [
    { id: "fronius", label: "Fronius (Solar.web)" },
    { id: "sma", label: "SMA (Sunny Portal)" },
    { id: "chint", label: "Chint" },
  ];
  let _vaultReq = {};                       // reqId → resolver, for bridge acks
  function vaultOp(op, extra){
    return new Promise((resolve) => {
      const reqId = "vault-" + Date.now() + Math.random();
      _vaultReq[reqId] = resolve;
      extSend("SO_VAULT", Object.assign({ op, reqId }, extra || {}));
      setTimeout(() => { if(_vaultReq[reqId]){ delete _vaultReq[reqId]; resolve({ ok:false, error:"timeout" }); } }, 4000);
    });
  }
  // Listen for vault acks (separate from the capture listener so it can't interfere).
  window.addEventListener("message", (e) => {
    if(e.source !== window) return;
    const d = e.data; if(!d || d.type !== "SO_VAULT_ACK" || !d.reqId) return;
    const r = _vaultReq[d.reqId]; if(r){ delete _vaultReq[d.reqId]; r(d); }
  });

  function autoRefreshRow(){
    return `<div class="acct-row" id="rowAutoRefresh">
      <div class="r-k">Auto-refresh</div>
      <div class="r-v">
        <span id="arState">Keeps your live production fresh automatically.</span>
        <span class="r-sub">Saved <b>only on this device</b>, encrypted — never sent to our servers. On by default; turn off any vendor anytime.</span>
        <div class="ar-list" id="arList"><div class="acct-msg" id="arMsg">Checking the EnergyAgent helper…</div></div>
      </div>
    </div>`;
  }

  async function wireAutoRefreshRow(){
    const listEl = document.getElementById("arList");
    if(!listEl) return;
    if(!EXT_PRESENT){
      listEl.innerHTML = `<div class="acct-msg">Install the free EnergyAgent helper to enable hands-free auto-refresh. <a href="onboarding.html" style="color:var(--good)">Get it →</a></div>`;
      return;
    }
    const resp = await vaultOp("status");
    if(!resp || !resp.ok){
      listEl.innerHTML = `<div class="acct-msg">Couldn't reach the EnergyAgent helper. Make sure it's installed and reload.</div>`;
      return;
    }
    const status = resp.status || {};
    listEl.innerHTML = AR_VENDORS.map(v => {
      const st = status[v.id] || { hasCreds:false, enabled:true };
      const on = st.hasCreds && st.enabled;
      const stateTxt = st.hasCreds ? (st.enabled ? "On" : "Off") : "Not set";
      const stateCls = on ? "on" : (st.hasCreds ? "off" : "");
      return `<div class="ar-row" data-vendor="${v.id}">
        <div class="ar-row-top">
          <span class="ar-vendor">${esc(v.label)}</span>
          <span class="ar-badge ${stateCls}">${stateTxt}</span>
          <label class="ar-switch"><input type="checkbox" class="ar-optout" ${st.hasCreds && !st.enabled ? "checked" : ""} ${st.hasCreds ? "" : "disabled"}><span>off</span></label>
        </div>
        <div class="ar-fields">
          <input class="ar-user" type="text" autocomplete="off" placeholder="Portal username / email">
          <input class="ar-pass" type="password" autocomplete="off" placeholder="${st.hasCreds ? "•••••••• (saved — type to replace)" : "Portal password"}">
          <div class="ar-actions">
            <button class="acct-btn primary ar-save" type="button">Save</button>
            ${st.hasCreds ? `<button class="acct-btn ar-clear" type="button">Remove</button>` : ""}
          </div>
        </div>
      </div>`;
    }).join("");

    listEl.querySelectorAll(".ar-row").forEach(row => {
      const vendor = row.dataset.vendor;
      const userEl = row.querySelector(".ar-user");
      const passEl = row.querySelector(".ar-pass");
      const saveBtn = row.querySelector(".ar-save");
      const clearBtn = row.querySelector(".ar-clear");
      const optEl = row.querySelector(".ar-optout");
      saveBtn.addEventListener("click", async () => {
        const u = (userEl.value||"").trim(), p = passEl.value||"";
        if(!u || !p){ saveBtn.textContent = "Enter both"; setTimeout(()=>saveBtn.textContent="Save",1500); return; }
        saveBtn.textContent = "Saving…";
        const r = await vaultOp("set", { vendor, username:u, password:p });
        saveBtn.textContent = r.ok ? "✓ Saved" : "Failed";
        passEl.value = "";
        setTimeout(wireAutoRefreshRow, 800);
      });
      if(clearBtn) clearBtn.addEventListener("click", async () => {
        await vaultOp("clear", { vendor });
        wireAutoRefreshRow();
      });
      if(optEl) optEl.addEventListener("change", async () => {
        await vaultOp("optout", { vendor, optedOut: optEl.checked });
        wireAutoRefreshRow();
      });
    });
  }

  /* ---- Password row: view (masked + show-as-you-type) and set/change it.
   * A stored password is hashed, so it can't be shown — "view" means reveal what
   * you type. Backend: GET /v1/account → has_password; POST /v1/auth/set-password
   * { password, current_password? } (current required only when one already exists;
   * rule: 10+ chars, a letter, a number). ------------------------------------ */
  function passwordRow(a){
    const hasPw = !!(a && a.has_password === true);
    const stateTxt = hasPw ? "Password set ••••••••" : "No password yet";
    const subTxt = hasPw
      ? "You can sign in with your email and password, or the emailed link."
      : "You currently sign in with the emailed magic link. Add a password to also sign in directly.";
    const btnLabel = hasPw ? "Change password" : "Set a password";
    const curField = hasPw ? `
          <label class="acct-pw-fld"><span class="acct-pw-lab">Current password</span>
            <input type="password" id="pwCurrent" autocomplete="current-password" placeholder="Current password"></label>` : "";
    return `<div class="acct-row" id="rowPassword" data-haspw="${hasPw}">
      <div class="r-k">Password</div>
      <div class="r-v">
        <span id="pwState">${stateTxt}</span>
        <span class="r-sub" id="pwSub">${subTxt}</span>
        <div class="acct-pw-edit" id="pwEdit" hidden>${curField}
          <label class="acct-pw-fld"><span class="acct-pw-lab">New password</span>
            <span class="acct-pw-wrap">
              <input type="password" id="pwNew" autocomplete="new-password" placeholder="At least 10 characters">
              <button type="button" class="acct-pw-eye" id="pwEye" aria-label="Show password">Show</button>
            </span></label>
          <label class="acct-pw-fld"><span class="acct-pw-lab">Confirm new password</span>
            <input type="password" id="pwConfirm" autocomplete="new-password" placeholder="Re-enter the new password"></label>
          <div class="acct-pw-hint">At least 10 characters, including a letter and a number.</div>
          <div class="acct-pw-actions">
            <button class="acct-btn primary" id="pwSave" type="button">Save password</button>
          </div>
          <div class="acct-msg" id="pwMsg"></div>
        </div>
      </div>
      <div class="r-a"><button class="acct-btn" id="pwToggle" type="button">${btnLabel}</button></div>
    </div>`;
  }

  function wirePasswordRow(){
    const toggle = document.getElementById("pwToggle");
    const editEl = document.getElementById("pwEdit");
    const row    = document.getElementById("rowPassword");
    if(!toggle || !editEl || !row) return;
    const hasPw = row.dataset.haspw === "true";
    const pwNew = document.getElementById("pwNew");
    const pwConfirm = document.getElementById("pwConfirm");
    const pwCurrent = document.getElementById("pwCurrent");
    const eye = document.getElementById("pwEye");
    const msg = document.getElementById("pwMsg");
    const baseLabel = hasPw ? "Change password" : "Set a password";
    const setMsg = (t, cls) => { if(msg){ msg.className = "acct-msg" + (cls ? " " + cls : ""); msg.textContent = t; } };
    const close = () => {
      editEl.setAttribute("hidden", ""); toggle.textContent = baseLabel;
      [pwNew, pwConfirm, pwCurrent].forEach(i => { if(i) i.value = ""; }); setMsg("");
    };

    toggle.onclick = () => {
      if(editEl.hasAttribute("hidden")){
        editEl.removeAttribute("hidden"); toggle.textContent = "Close";
        const first = pwCurrent || pwNew; if(first) try{ first.focus(); }catch(e){}
      } else close();
    };

    // The only honest "view your password": reveal what you're typing (the stored
    // one is hashed and unrecoverable). Toggles both new + confirm together.
    if(eye && pwNew) eye.onclick = () => {
      const show = pwNew.type === "password";
      pwNew.type = show ? "text" : "password";
      if(pwConfirm) pwConfirm.type = pwNew.type;
      eye.textContent = show ? "Hide" : "Show";
      eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
    };

    const save = document.getElementById("pwSave");
    if(save) save.onclick = async () => {
      const np = (pwNew && pwNew.value) || "", cf = (pwConfirm && pwConfirm.value) || "";
      if(np.length < 10 || !/[a-zA-Z]/.test(np) || !/[0-9]/.test(np)){
        setMsg("At least 10 characters, including a letter and a number.", "err"); return; }
      if(np !== cf){ setMsg("The two passwords don't match.", "err"); return; }
      if(hasPw && !(pwCurrent && pwCurrent.value)){ setMsg("Enter your current password to change it.", "err"); return; }
      const h = authHeaders();
      if(!h){ setMsg("Sign in first.", "err"); return; }
      const body = { password: np };
      if(hasPw) body.current_password = pwCurrent.value;
      save.disabled = true; setMsg("Saving…");
      try{
        const r = await fetch("/v1/auth/set-password", { method:"POST",
          headers: Object.assign({ "Content-Type":"application/json" }, h),
          body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if(r.ok && d.ok){
          if(_account) _account.has_password = true;
          setMsg(hasPw ? "Password changed." : "Password set.", "ok");
          // Re-render the row from the fresh state so a follow-up change correctly
          // asks for the (now-set) current password. Re-fill billing too, since a
          // full re-render resets the bill row to its loading state.
          setTimeout(() => { if(_account){ renderAccountList(_account); renderBilling(authHeaders()); } }, 1100);
        } else {
          setMsg((d && d.detail) ? d.detail : `Couldn't save (HTTP ${r.status}).`, "err");
          save.disabled = false;
        }
      }catch(e){ setMsg("Couldn't reach the server — check your connection.", "err"); save.disabled = false; }
    };
  }

  function wireAcctEdits(){
    document.querySelectorAll("#acctList .acct-edit").forEach(row => {
      const inp = row.querySelector("input");
      const btn = row.querySelector(".acct-btn");
      const msg = row.querySelector(".acct-msg");
      const field = row.dataset.field;             // "company" | "email"
      btn.onclick = async () => {
        const val = inp.value.trim();
        if(!val){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Enter a value first."; } return; }
        const h = authHeaders();
        if(!h){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Sign in first."; } return; }
        const url  = field === "company" ? "/v1/account/company-name" : "/v1/account/email";
        // Backend models: UpdateCompanyName{name}, UpdateEmail{email}. The
        // company endpoint wants `name` (not `company_name`) — sending the wrong
        // key 422s, which was the "Couldn't save (HTTP 422)" bug.
        const body = field === "company" ? { name: val } : { email: val };
        btn.disabled = true;
        if(msg){ msg.className = "acct-msg"; msg.textContent = "Saving…"; }
        try{
          const r = await fetch(url, { method:"POST",
            headers: Object.assign({ "Content-Type":"application/json" }, h),
            body: JSON.stringify(body) });
          if(r.ok){
            if(msg){ msg.className = "acct-msg ok"; msg.textContent = "Saved."; }
            if(_account) _account[field === "company" ? "company_name" : "email"] = val;
            // Email is also the login — keep the Login row in sync.
            if(field === "email"){ const lg = document.getElementById("loginEmail"); if(lg) lg.textContent = val; }
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

  // Passwordless sign-in: email the owner a fresh magic link from the account page.
  function wireLoginLink(){
    const btn = document.getElementById("loginLink");
    if(!btn) return;
    const sub = btn.closest(".acct-row").querySelector(".r-sub");
    btn.onclick = async () => {
      const h = authHeaders();
      if(!h){ if(sub) sub.textContent = "Sign in first."; return; }
      const email = (_account && pick(_account, ["email","operator_email"], "")) || "your email";
      btn.disabled = true;
      if(sub) sub.textContent = "Sending…";
      try{
        const r = await fetch("/v1/account/login-link", { method:"POST",
          headers: Object.assign({ "Content-Type":"application/json" }, h), body: "{}" });
        if(sub) sub.textContent = r.ok
          ? `Sent — check ${email} for your sign-in link.`
          : "Couldn't send a link right now — please try again shortly.";
      }catch(e){ if(sub) sub.textContent = "Couldn't reach the server — check your connection."; }
      btn.disabled = false;
    };
  }

  // Fill the "Your bill" + "Payment method" rows once billing data lands.
  async function renderBilling(h){
    const amtEl = document.getElementById("billAmount");
    const whyEl = document.getElementById("billWhy");
    if(!amtEl) return;

    let summary = null, invoice = null;
    try { const r = await fetch("/v1/account/billing-summary", { headers: h }); if(r.ok) summary = await r.json(); } catch(e){}
    try { const r = await fetch("/v1/account/next-invoice",   { headers: h }); if(r.ok) invoice = await r.json(); } catch(e){}

    // Amounts from billing-summary are in (possibly fractional) CENTS.
    const usdFromCents = c => (c==null ? "—" : "$" + (Number(c)/100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}));
    const basis  = pick(summary, ["billing_basis"], null);
    const status = pick(summary, ["subscription_status","status"], (_account && pick(_account, ["subscription_status","status"], "")) || "");
    const onTrial = (_account && (_account.on_trial === true || _account.trial === true)) || /trial/i.test(String(status));
    const trialEnds = _account ? pick(_account, ["trial_ends_at","trial_end","trial_expires_at"], null) : null;

    let amount = "—", why = "";
    if(basis === "kwh"){
      // Array Operator — billed by generation.
      const mtdKwh = pick(summary, ["mtd_kwh"], null);
      const rate   = pick(summary, ["rate_cents_per_kwh"], null);
      const totalC = pick(summary, ["total_cents"], null);
      const arrays = pick(summary, ["billable_arrays"], null);
      amount = `${usdFromCents(totalC)} <small>this month</small>`;
      const bits = [];
      if(rate != null && mtdKwh != null) bits.push(`${Number(rate).toLocaleString(undefined,{maximumFractionDigits:3})}&cent;/kWh × ${Number(mtdKwh).toLocaleString(undefined,{maximumFractionDigits:0})} kWh generated`);
      else if(rate != null)              bits.push(`${Number(rate).toLocaleString(undefined,{maximumFractionDigits:3})}&cent; per kWh your arrays generate`);
      if(arrays != null)                 bits.push(`across ${arrays} array${Number(arrays)===1?"":"s"}`);
      why = bits.join(" ");
    } else if(summary){
      // NEPOOL Operator — billed per array (legacy shape kept for the verifier app).
      const arrayCount = pick(summary, ["billable_arrays","array_count","arrays_count","arrays"], null);
      const fullUnit   = pick(summary, ["full_unit_cents"], null);
      const totalC     = pick(summary, ["total_cents"], null);
      amount = `${usdFromCents(totalC)} <small>this month</small>`;
      const bits = [];
      if(fullUnit != null)   bits.push(`${usdFromCents(fullUnit)} per array / mo`);
      if(arrayCount != null) bits.push(`× ${arrayCount} array${Number(arrayCount)===1?"":"s"}`);
      why = bits.join(" ");
    } else {
      amount = `$0.00 <small>this month</small>`;
      why = "You're only billed for the kWh your arrays generate.";
    }

    // Trial + next-invoice context appended to the "why".
    const ctx = [];
    if(onTrial) ctx.push(trialEnds ? `free trial through ${fmtDate(trialEnds)} — nothing charged yet` : "free trial — nothing charged yet");
    const invAmt = invoice ? pick(invoice, ["amount_cents","amount_due","total","amount"], null) : null;
    if(invAmt != null){
      const invDate = pick(invoice, ["period_end","due_date","date","next_payment_date"], null);
      ctx.push(`next invoice ${usdFromCents(invAmt)}${invDate ? ` on ${fmtDate(invDate)}` : ""}`);
    }
    if(ctx.length) why = why ? `${why} · ${ctx.join(" · ")}` : ctx.join(" · ");

    amtEl.innerHTML = amount;
    if(whyEl) whyEl.innerHTML = why || "—";

    // Payment state + button. A card exists only on a real paid/active status or an
    // explicit flag — a bare trial does NOT mean a card is on file (that's why the
    // default CTA is "Add credit card").
    const sStatus = String(status || "");
    const hasCard = (summary && (summary.has_payment_method === true || summary.has_card === true))
      || /active|past_due|paid/i.test(sStatus);
    const payState = document.getElementById("payState");
    const btn = document.getElementById("billManage");
    if(payState) payState.textContent = hasCard ? "Card on file" : "No card on file";
    if(btn){
      btn.textContent = hasCard ? "Update credit card" : "Add credit card";
      btn.onclick = () => manageBilling(hasCard);
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
    const list = document.getElementById("acctList");
    if(!list) return;
    const h = authHeaders();
    if(!h){ list.innerHTML = signInPrompt(); return; }
    list.innerHTML = `<div class="empty">Loading your account…</div>`;
    try{
      const r = await fetch("/v1/account", { headers: h });
      if(r.status === 401){ list.innerHTML = sessionExpired(); return; }
      if(!r.ok) throw new Error("account " + r.status);
      _account = await r.json();
      renderAccountList(_account);
    }catch(e){
      list.innerHTML = `<div class="empty">Couldn't load your account right now — please refresh.</div>`;
      return;
    }
    renderBilling(h);
  }

  /* ===========================================================================
   * REPORTS — honest placeholder. Prefills the send-to email from the account.
   * Nothing is sent; the cadence selector just records intent for later.
   * ==========================================================================*/
  function loadReports(){
    // The Reports tab is now the automatic-billing surface, owned by reports.js
    // (window.__aoLoadReports). Delegate to it; the legacy placeholder prefill
    // below only runs if reports.js failed to load (defensive).
    if(window.__aoLoadReports){ window.__aoLoadReports(); return; }
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
    audit:   { panel: "panelAudit",   tab: "tabAudit"   },
    trends:  { panel: "panelTrends",  tab: "tabTrends"  },
    reports: { panel: "panelReports", tab: "tabReports" },
  };
  function tabFromHash(){
    const h = location.hash;
    if(h === "#account") return "account";
    if(h === "#audit")   return "audit";
    if(h === "#trends")  return "trends";
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
    } else if(active === "trends"){
      if(window.__aoLoadTrends) window.__aoLoadTrends();
    } else if(active === "audit"){
      if(window.__aoLoadAudit) window.__aoLoadAudit();
    } else if(active === "reports"){
      loadReports();
    }
    _firstApply = false;
  }
  window.addEventListener("hashchange", applyView);
  document.addEventListener("DOMContentLoaded", applyView);
  // expose for external callers (and post-add reloads)
  window.__sbLoad = load;
  // expose the alerts settings modal so it can be opened from the top-bar
  // Fleet Commander button (moved out of the sandbox head, May 2026).
  window.__sbOpenAlerts = openAlertsModal;

  // ---- shared store: re-render the fleet tree whenever the canonical fleet (or
  // the focused subset) changes — including changes made from the command center.
  // Triage-only updates are ignored; they don't touch the tree.
  if(window.FleetStore){
    FleetStore.subscribe((s, kind) => {
      if(kind === "triage" || kind === "live") return;   // its own kW ticker handles live motion
      if(kind === "history"){ syncUndoRedoButtons(); return; }  // just refresh button state
      if(document.getElementById("sandbox")) renderFromStore();
    });
  }
})();
