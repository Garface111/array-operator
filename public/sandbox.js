/* ============================================================================
 * Array Operator, Sandbox view (sandbox.js)
 *
 * Renders the fleet as one ARRAY CARD per column. Each card has a two-column body:
 *
 * ┌─ Array card ─────────────────────────────────┐
 * │ Array details │ Alerts │
 * │ name · N inverters │ rolled-up headline │
 * │ live tag · brand │ count flagged │
 * │ origin site links ↗ │ (tinted ok/warn/bad)│
 * │ [{n} inverters ▸] │ │
 * └───────────────────────┴──────────────────────┘
 * └─ collapsible inverter comb (hidden until expanded) ─┐
 * N real inverter prongs + SVG feeder wires │
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
 const ORDER_KEY = "ao_array_order"; // persisted column order (array_id strings), harmless UI preference
 const RENAME_KEY = "ao_renames"; // persisted inline renames { arrays:{id:name}, inverters:{id:name} }
 const EXPAND_KEY = "ao_array_expanded"; // persisted set of array_ids whose inverter comb is expanded (JSON array)
 const ORIENT_KEY = "ao_sandbox_orient"; // "vertical" (arrays side-by-side, inverters below) | "horizontal" (arrays stacked left, inverters spread right)
 const BRAND = { solaredge:"SolarEdge", locus:"Locus", alsoenergy:"AlsoEnergy", fronius:"Fronius", sma:"SMA", chint:"Chint", gmp:"GMP", vec:"VEC", wec:"WEC", eversource:"Eversource", eversource_ma:"Eversource", eversource_ct:"Eversource", cmp:"CMP" };
 // Surface (don't swallow) a corrupt localStorage preference. Each caller still
 // degrades to its safe default, this only makes a recurring poisoned/legacy value
 // diagnosable instead of vanishing silently.
 function _warnLS(key, e){ try { console.warn("[sandbox] ignoring unreadable localStorage '" + key + "':", e && e.message); } catch(_){} }

 // ---- memoized JSON-from-localStorage ---------------------------------------
 // The column order, renames, expanded set, and free cards are JSON.parsed from
 // localStorage on EVERY render (some loaders run per-array). Re-parsing an
 // unchanged blob is wasted synchronous work that blocks the paint. Cache the
 // parsed result keyed by storage key; reparse only when the raw string actually
 // changes. We compare the raw string (cheap) so a write from ANOTHER tab, which
 // doesn't go through our setter, still invalidates correctly; a same-tab write
 // calls _lsInvalidate() in its setter, so the next read re-parses immediately.
 const _lsCache = Object.create(null); // key -> { raw, val }
 function _lsReadJSON(key, parse){
 let raw = null;
 try { raw = localStorage.getItem(key); } catch(e){ _warnLS(key, e); return parse(null); }
 const hit = _lsCache[key];
 if(hit && hit.raw === raw) return hit.val;
 let val;
 try { val = parse(raw); }
 catch(e){ _warnLS(key, e); val = parse(null); } // parse() owns its own safe default
 _lsCache[key] = { raw, val };
 return val;
 }
 function _lsInvalidate(key){ delete _lsCache[key]; }

 // Vendor catalog, copied VERBATIM from public/onboarding.html so the add-array
 // picker offers the same brands + field logic the wizard does.
 // Default order = featured order in the picker. AlsoEnergy sits up front with
 // SolarEdge (one login → every site); newly live utilities are in utilFeatured.
 const VENDORS = [
 { code:"solaredge", label:"SolarEdge", meta:"One account key", available:true, discover:true,
 fields:[{name:"apiKey", label:"SolarEdge account API key", secret:true,
 hint:"The one key that unlocks every site on your account.",
 ph:"ABCD1234…", help:`Find it in your SolarEdge monitoring portal under <b>Admin → Site Access → API Access</b> (an <i>account</i>-level key, read-only). Don't have it handy? <a href="https://monitoring.solaredge.com" target="_blank" rel="noopener">Open the SolarEdge portal →</a>`}] },
 { code:"alsoenergy", label:"AlsoEnergy", meta:"PowerTrack · 1 login", available:true, discover:true,
 note:"One AlsoEnergy / PowerTrack login attaches every site on the account, same username & password you use at hmi.alsoenergy.com. Leave Site ID blank to connect them all.",
 fields:[
 {name:"username", label:"AlsoEnergy username (email)"},
 {name:"password", label:"AlsoEnergy password", secret:true},
 {name:"site_id", label:"Site ID (optional, leave blank for every site)", optional:true, hint:"Only if you want one site; otherwise we attach the whole account."},
 ] },
 { code:"fronius", label:"Fronius", meta:"Solar.web", available:true, discover:true,
 note:"One key unlocks every PV system on your Solar.web account, verified working for US arrays. Find it (or create one) at api-mgmt.solarweb.com, under your account's API keys.",
 fields:[
 {name:"access_key_id", label:"Access Key ID", hint:"36 characters, starts with “FKIA”."},
 {name:"access_key_value", label:"Access Key Value", secret:true},
 ] },
 { code:"sma", label:"SMA", meta:"Sunny Portal", available:true, discover:false,
 note:"Have your own SMA developer-app credentials? Paste them here. Everyone else: use the one-click SMA login above, no keys, no typing.",
 fields:[
 {name:"system_id", label:"Plant / System ID"},
 {name:"client_id", label:"Client ID (advanced, optional)", optional:true},
 {name:"client_secret", label:"Client Secret (advanced, optional)", secret:true, optional:true},
 ] },
 { code:"locus", label:"Locus Energy", meta:"SolarNOC", available:true, discover:false,
 note:"Locus needs API credentials (client ID/secret + your SolarNOC login) from your Locus account manager. Enter them and we'll connect your sites.",
 fields:[
 {name:"client_id", label:"Client ID"},
 {name:"client_secret", label:"Client Secret", secret:true},
 {name:"username", label:"SolarNOC username"},
 {name:"password", label:"SolarNOC password", secret:true},
 {name:"partner_id", label:"Partner ID (optional, shows every site at once)"},
 ] },
 { code:"chint", label:"Chint / CPS", meta:"Chint Connect", available:false, discover:false,
 note:"Chint/CPS has no key to paste, use the one-click 'Log in with Chint' option above. Support is in final verification against live accounts." },
 ];
 function vendorByCode(c){ return VENDORS.find(v=>v.code===c) || VENDORS[0]; }

 function getSession(){ try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } }

 /* ---- EnergyAgent extension bridge (one-click portal login) ----
 * The helper injects so_bridge.js on arrayoperator.com: it announces
 * SO_EXTENSION_PRESENT and relays SO_CAPTURE_LANDED. We ask the owner to log
 * into their monitoring portal the way they already do; the extension reads
 * their inverters and lands them here, and we attach to their account. */
 let EXT_PRESENT = false;
 let _vaultStatusCache = null; // populated lazily by wireAutoLoginHints()
 // A saved-login (auto-refresh) credential actually CHANGED: drop the cache AND tell
 // other views so they re-evaluate live, e.g. reports.js hides its "Set up
 // auto-refresh" nudge the moment a login is saved, without a reload (Ford 2026-07-10).
 function _notifyVaultChanged(){
 _vaultStatusCache = null;
 try { window.dispatchEvent(new Event("ao:vault-changed")); } catch(e){}
 }
 const EXT_STORE_URL = "https://chromewebstore.google.com/detail/solar-operator-sync/ocohbimolfpnkjcjhiodopjjlhclinpl";
 // Portal URLs per vendor for the one-click login.
 const PORTAL_URL = {
 solaredge: "https://monitoring.solaredge.com/",
 fronius: "https://www.solarweb.com/",
 sma: "https://ennexos.sunnyportal.com/",
 chint: "https://monitor.chintpowersystems.com/",
 alsoenergy:"https://hmi.alsoenergy.com/",
 locus: "https://hmi.alsoenergy.com/",
 gmp: "https://greenmountainpower.com/",
 vec: "https://vermontelectric.smarthub.coop/",
 wec: "https://washingtonelectric.smarthub.coop/",
 eversource: "https://www.eversource.com/security/account/login",
 eversource_ma: "https://www.eversource.com/security/account/login",
 eversource_ct: "https://www.eversource.com/security/account/login",
 cmp: "https://sso.cmpco.com/login",
 };
 function extSend(type, extra){
 // Target the page's own origin, never "*": SO_PAIR carries the tenant key and
 // SO_VAULT carries plaintext creds. so_bridge.js is injected into this same page
 // (same window, same origin), so location.origin reaches it and nothing else.
 try { window.postMessage(Object.assign({ type, reqId: String(Date.now())+Math.random() }, extra||{}), window.location.origin); } catch(e){}
 }
 // ── Supported-utility catalog, data-driven from the backend's GET /v1/providers,
 // the SAME single billing basis (api/data/providers/*.csv) the NEPOOL extension
 // uses. Lets an operator connect ANY LIVE utility (hundreds of NISC SmartHub co-ops
 // nationwide, count shown live via provCountLabel), not just the hardcoded VT trio.
 // The generic
 // SmartHub adapter + is_smarthub_provider offtaker routing already handle them
 // server-side, so the frontend just has to OFFER them + open the right portal.
 let _provCache = null, _provFetch = null;
 async function getProviders(){
 if(_provCache) return _provCache;
 if(_provFetch) return _provFetch;
 _provFetch = (async () => {
 try {
 const r = await fetch("/v1/providers");
 if(r.ok){
 const d = await r.json();
 const list = (d && d.providers) || (Array.isArray(d) ? d : []);
 _provCache = list.filter(p => p && p.code && p.scrape_status === "live" && (p.smarthub_host || p.portal_url));
 }
 } catch(_){}
 _provFetch = null;
 return _provCache || [];
 })();
 return _provFetch;
 }
 // Live, capturable-utility count for honest UI copy (no more hardcoded "~470").
 // Rounds DOWN to a clean floor so the number is never overstated as the catalog grows.
 function provCountLabel(){
 const n = (_provCache || []).length;
 if(!n) return "hundreds of";
 if(n < 50) return String(n);
 return (Math.floor(n / 10) * 10) + "+";
 }
 function providerByCode(code){ const c = String(code||"").toLowerCase(); return (_provCache||[]).find(p => p.code === c) || null; }
 function provLabel(code){ const c = String(code||"").toLowerCase(); return BRAND[c] || (providerByCode(c)||{}).label || c; }
 function providerUrl(code){
 const c = String(code||"").toLowerCase();
 if(PORTAL_URL[c]) return PORTAL_URL[c]; // inverter vendors + the VT trio
 const p = providerByCode(c);
 return p ? (p.portal_url || (p.smarthub_host ? "https://" + p.smarthub_host + "/" : null)) : null;
 }
 // AUTO-PAIR: the extension needs this tenant's long-lived key to capture/refresh
 // at all. A freshly-(re)loaded extension starts with EMPTY storage → "Not connected"
 // and the whole capture pipeline goes dark. So the dashboard re-pairs the extension
 // every time it announces itself: fetch the tenant key once (GET /v1/account, the
 // session we already hold), then SO_PAIR it across. This makes pairing self-heal —
 // no more manual reconnect after an extension update.
 let _pairKey = null, _pairFetching = false;
 async function fetchPairKey(){
 if(_pairKey) return _pairKey;
 if(_pairFetching) return null;
 const s = getSession(); if(!s) return null;
 _pairFetching = true;
 try {
 const r = await fetch("/v1/account", { headers:{ Authorization:"Bearer "+s } });
 // NEVER pair a demo/read-only account: its captures are refused server-side
 // (403 demo-read-only), so pairing the extension to it just breaks capture for
 // an operator who happens to also be viewing the demo, or is signed into two
 // accounts at once. Only a real account may become the extension's capture target.
 if(r.ok){ const a = await r.json(); if(a && a.tenant_key && !a.is_demo) _pairKey = a.tenant_key; }
 } catch(_){} finally { _pairFetching = false; }
 return _pairKey;
 }
 async function autoPairExtension(){
 try { const key = await fetchPairKey(); if(key) extSend("SO_PAIR", { tenantKey: key }); } catch(_){}
 }
 function openPortalLogin(vendor){
 const code = String(vendor||"").toLowerCase();
 const url = providerUrl(code);
 if(!url) return;
 const note = _ov && _ov.querySelector("#sbNote");
 // Every provider that ISN'T an inverter portal is a utility meter, derive it
 // instead of hardcoding the trio, so any of the ~470 utilities reads correctly.
 const isMeter = !["solaredge","fronius","sma","chint","locus","alsoenergy"].includes(code);
 if(note){
 note.className = "sb-note";
 const what = isMeter ? "solar production" : "inverters";
 note.innerHTML = `<span class="sb-spin"></span> Opening ${esc(provLabel(code))}, sign in there and your ${what} appear${isMeter?"s":""} here automatically.`;
 }
 // Optimistic Connecting… card on Inverters for EVERY inverter vendor (not just Chint).
 // Portal walks + first harvest can take 30–60s; without this the sheet looks empty/broken.
 if(!isMeter){
 try {
 if(window.__aoPendingFeeds){
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, code, {
 label: BRAND[code] || provLabel(code) || code,
 note: "portal open, waiting for capture",
 });
 }
 } catch(e){}
 }
 // Pass the provider CODE so the extension arms the right capture intent, a
 // single SmartHub host serves every co-op, so the code disambiguates which one.
 extSend("SO_OPEN_PORTAL", { url, active: true, provider: code, vendor: code });
 }
 // Exposed primitive so OTHER surfaces (e.g. the offtaker Re-sync-latest-bill banner
 // in reports.js) can open a utility portal directly, same SO_OPEN_PORTAL machinery
 // as "Link utility bills", but WITHOUT popping the Add-array modal. Loads the
 // providers catalog first so ANY connected co-op resolves its host, not just the VT
 // trio. (Ford 2026-07-09: Re-sync must OPEN the utility so the bill can be captured.)
 window.__aoOpenUtilityPortal = async function(code){
 try { await getProviders(); } catch(_){}
 try { openPortalLogin(code); } catch(_){}
 };
 // Tell the rest of the app the operator's set of UTILITY accounts may have
 // changed (a GMP/VEC bill-link capture just landed). The offtaker editor
 // (reports.js) listens for this and repopulates its #rbmUtility picker in place
 // if it's open, so a freshly-linked account appears without a page refresh.
 function notifyUtilityAccountsChanged(){
 try { window.dispatchEvent(new CustomEvent("ao:utility-accounts-changed")); } catch(_){}
 }

 // Zero-typing bridge to the official SMA cloud API. sunnyportal_content.js
 // (ext v1.9.114+) reads the owner's email straight off their OWN Bearer token
 // and rides it along on the capture that already gives the instant "Connected"
 // moment, this silently starts owner-consent (bc-authorize) in the background
 // so the SAME one-click portal login also migrates the account onto 24/7
 // server-side polling, matching how SolarEdge's captured key needs no further
 // action. Best-effort + fire-and-forget: never touches the visible modal state,
 // and a pre-1.9.114 extension (no ownerEmail) or any failure is a silent no-op.
 // Guarded to fire at most once per email per page load, the periodic
 // background sync tick re-captures every few minutes and bc-authorize doesn't
 // need re-arming once sent (SMA returns the current state, not a fresh prompt).
 const _smaConsentArmed = new Set();
 function armSmaOfficialApi(d, hdr){
 if(d.provider !== "sma" || !d.ownerEmail) return;
 const email = String(d.ownerEmail).trim().toLowerCase();
 if(!email || _smaConsentArmed.has(email)) return;
 _smaConsentArmed.add(email);
 fetch("/v1/array-owners/sma/consent", {
 method:"POST", headers:hdr, body: JSON.stringify({ owner_email: d.ownerEmail })
 }).catch(()=>{});
 }

 // A capture landed from the extension. Owner is already signed in (dashboard),
 // so attach straight to their account: SolarEdge by its account key,
 // Fronius/SMA by ingesting the per-inverter readings the extension shipped.
 async function handleCaptureLanded(d){
 const session = getSession();
 const note = _ov && _ov.querySelector("#sbNote");
 if(!session){
 if(note){ note.className = "sb-note err"; note.innerHTML = `Please sign in first, <a href="onboarding.html">get started →</a>.`; }
 return;
 }
 const hdr = { "Content-Type":"application/json", "Authorization":"Bearer "+session };
 // Optimistic UI: Connecting… for every inverter vendor (SE / Fronius / SMA / Chint / …)
 //, first fleet write can lag 30–60s after capture lands.
 try {
 const prov = (d.provider || "").toLowerCase();
 if(prov && window.__aoPendingFeeds){
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, prov, {
 label: BRAND[prov] || d.provider,
 note: "capture landed, syncing to your account",
 sites: Array.isArray(d.sites) ? d.sites.length : null,
 });
 }
 } catch(e){}
 if(note){ note.className = "sb-note"; note.innerHTML = `<span class="sb-spin"></span> Got your ${esc(BRAND[d.provider]||d.provider)} account, bringing your data in…`; }
 // ── GMP/VEC/WEC BILL-SYNC broadcast ──────────────────────────────────────
 // The bill-capture script (content.js → /v1/sync) already created the utility
 // accounts + queued the bill pull SERVER-SIDE; it broadcasts SO_CAPTURE_LANDED
 // with an accountCount but NO accounts[] (and no kind:"utility_meter"). That's
 // a SUCCESS for connecting GMP, not a failure. Recognize it, refresh, and let
 // the live-usage capture (which DOES carry accounts[]) flow through below.
 const isMeterProvider = !["solaredge","fronius","sma","chint","locus","alsoenergy"].includes(d.provider);
 const hasAccounts = Array.isArray(d.accounts) && d.accounts.length > 0;
 if(isMeterProvider && !hasAccounts && d.ok !== false && d.kind !== "utility_meter"){
 const nAcct = (typeof d.accountCount === "number") ? d.accountCount : 0;
 if(note){ note.className = "sb-note"; note.innerHTML = `<span class="sb-spin"></span> Connected your ${esc(BRAND[d.provider]||d.provider)} account${nAcct===1?"":"s"}, syncing your bills…`; }
 try {
 if(window.FleetStore && FleetStore.refetch){ await FleetStore.refetch(); }
 } catch(e){}
 try { if(typeof updateGmpGate === "function") updateGmpGate(getSession()); } catch(e){}
 try { if(window.__aoRefreshGmpGate) window.__aoRefreshGmpGate(); } catch(e){}
 notifyUtilityAccountsChanged(); // repopulate the offtaker utility picker if it's open
 closeAddModal();
 if(typeof toast === "function"){
 toast(nAcct ? `Connected ${nAcct} ${esc(BRAND[d.provider]||d.provider)} account${nAcct===1?"":"s"}, your bills are syncing in.` : `Connected your ${esc(BRAND[d.provider]||d.provider)} account, your bills are syncing in.`, "ok");
 }
 load();
 return;
 }
 try{
 let r, data;
 if(d.provider === "solaredge" && d.apiKey){
 r = await fetch("/v1/array-owners/solaredge/connect-account",
 { method:"POST", headers:hdr, body: JSON.stringify({ api_key: d.apiKey }) });
 } else if((d.provider === "fronius" || d.provider === "sma" || d.provider === "chint" || d.provider === "locus" || d.provider === "alsoenergy") && Array.isArray(d.sites) && d.sites.length){
 r = await fetch("/v1/array-owners/inverter-capture",
 { method:"POST", headers:hdr, body: JSON.stringify({ provider: d.provider, sites: d.sites }) });
 armSmaOfficialApi(d, hdr); // fire-and-forget; never blocks the visible "Connected" moment
 } else if(isMeterProvider && hasAccounts){
 // Utility-meter capture (GMP server-pull + VEC/WEC client-pull) all land
 // as a per-account daily[] payload → the one proven utility-meter endpoint.
 // auth is passed through (GMP only) so the backend can store a UtilitySession
 // and later pull bills autonomously via the scheduler.
 const meterBody = { provider: d.provider, accounts: d.accounts };
 if(d.auth && d.auth.apiToken) meterBody.auth = d.auth;
 r = await fetch("/v1/array-owners/utility-meter-capture",
 { method:"POST", headers:hdr, body: JSON.stringify(meterBody) });
 } else {
 // Honest, provider-appropriate message: GMP/VEC/WEC are utility METERS,
 // not inverters. Only reaches here when we truly got nothing usable.
 if(note){ note.className = "sb-note err"; note.textContent = isMeterProvider
 ? `We reached ${BRAND[d.provider]||d.provider} but couldn't read your account yet, make sure you're signed in there, then try again.`
 : `We reached ${BRAND[d.provider]||d.provider} but couldn't read your inverters, make sure you're signed in there, then try again.`; }
 return;
 }
 data = {}; try { data = await r.json(); } catch(e){}
 const ok = r.ok && (data.ok || data.connected || data.created || data.matched || data.sites_captured || data.accounts_captured);
 const isMeter = !["solaredge","fronius","sma","chint","locus","alsoenergy"].includes(d.provider);
 if(ok){
 // HONEST GATE: an inverter capture can return ok/200 with site(s) but ZERO
 // inverters persisted, e.g. the portal SPA hadn't loaded its device list
 // (busTypeDevices) when capture fired, so we saw the site but no inverters.
 // Don't claim "inverters on the canvas" when nothing landed; ask for a retry.
 // Only the EXTENSION-capture vendors (Fronius/SMA/Chint) return per-site
 // `inverters_persisted` in the SAME response, so a 0 there is a real "the
 // portal's device list hadn't loaded, retry" case. SolarEdge's account
 // connect ATTACHES the arrays and pulls inverters ASYNCHRONOUSLY (a
 // background job), so it never reports inverters_persisted and 0-right-now
 // is normal, gating on it here false-errored a successful connect (the
 // inverters "appear a little later"). So only gate when the response
 // actually carries per-site inverter counts.
 const _hasSiteCounts = Array.isArray(data.sites) && data.sites.some(s => s && s.inverters_persisted != null);
 if(!isMeter && _hasSiteCounts){
 const nInv = data.sites.reduce((t,s)=>t+(s.inverters_persisted||0),0);
 if(!nInv){
 const B = esc(BRAND[d.provider]||d.provider);
 if(note){ note.className = "sb-note err"; note.innerHTML =
 `We reached ${B} but didn't see any inverters yet, make sure you're signed in to ${B}, then sync again.`; }
 return; // keep the modal open for a retry; no false "on the canvas" toast
 }
 }
 // Pull the freshly-attached array(s) from the server and re-render the
 // tree. load() short-circuits when the store is already loaded (it is, on
 // the dashboard), so we must force a real re-fetch.
 if(note){ note.className = "sb-note"; note.innerHTML = `<span class="sb-spin"></span> Bringing your ${isMeter?"meter production":"inverters"} onto the canvas…`; }
 try {
 if(window.FleetStore && FleetStore.refetch){
 await FleetStore.refetch();
 // Show the FULL fleet after a connect, the owner just added an array,
 // they want to see it alongside everything they already had, not a
 // curated "worst few" subset. (defaultFocusIds() collapses to flagged
 // arrays only, which would hide the rest, the opposite of "added".)
 if(FleetStore.setFocus && FleetStore.snapshot){
 const all = (FleetStore.snapshot().arrays || []).map(a => a.id);
 if(all.length) FleetStore.setFocus(all);
 }
 try {
 if(window.__aoPendingFeeds){
 window.__aoPendingFeeds.reconcile((FleetStore.snapshot() || {}).arrays || []);
 // Keep polling if this vendor still hasn't shown (Chint multi-site lag)
 window.__aoPendingFeeds.startPoll();
 }
 } catch(e){}
 }
 } catch(e){}
 // A meter capture (GMP/VEC/WEC) may have added new utility accounts, let
 // the offtaker editor's utility picker repopulate in place if it's open.
 if(isMeter){
 notifyUtilityAccountsChanged();
 // Ford 2026-07-12: this is the SECOND capture broadcast for GMP, the one
 // that actually carries accounts[]/has_bill data (the first, above at
 // "syncing your bills…", only reports the account was created and already
 // triggers this refresh). Without it, the Offtaker Invoicing connection
 // rail (refreshGmpBillsStatus, via reports.js's __aoRefreshGmpGate patch)
 // stayed frozen on "connected, no bills yet" even after the real bill
 // landed, the operator had to reload to see "✓ N bill sources connected".
 try { if(window.__aoRefreshGmpGate) window.__aoRefreshGmpGate(); } catch(e){}
 }
 closeAddModal();
 if(typeof toast === "function"){
 if(isMeter){
 // Utility-meter capture: count accounts that actually had solar
 // production vs. ones with no generation (honest, don't imply solar
 // where there's none).
 const accts = Array.isArray(data.accounts) ? data.accounts : [];
 const withGen = accts.filter(a => a.has_generation).length;
 const noGen = accts.length - withGen;
 if(withGen) toast(`Connected, ${withGen} GMP account${withGen===1?"":"s"} with solar production on your canvas${noGen?` (${noGen} had no solar)`:""}.`, "ok");
 else toast(noGen ? `Connected GMP, but ${noGen} account${noGen===1?"":"s"} showed no solar production yet.` : `Connected your GMP meter data.`, "ok");
 } else {
 const n = (data.sites && data.sites.reduce ? data.sites.reduce((t,s)=>t+(s.inverters_persisted||0),0) : 0);
 if(n){
 toast(`Connected, ${n} inverter${n===1?"":"s"} live on your canvas.`, "ok");
 } else {
 // SolarEdge account-connect: arrays attached, inverters pull in the
 // background, say so instead of claiming they're already here.
 const nArr = ((data.connected&&data.connected.length)||0)
 + ((data.created&&data.created.length)||0)
 + ((data.matched&&data.matched.length)||0);
 toast(nArr
 ? `Connected ${nArr} array${nArr===1?"":"s"}, your inverters are syncing and will appear in a moment.`
 : `Connected, your inverters are syncing and will appear in a moment.`, "ok");
 // The inverters land on a background pull; re-fetch a couple of times
 // so they show up on their own without the owner hitting refresh.
 if(window.FleetStore && FleetStore.refetch){
 setTimeout(() => { try { FleetStore.refetch(); } catch(_){} }, 5000);
 setTimeout(() => { try { FleetStore.refetch(); } catch(_){} }, 15000);
 setTimeout(() => { try { FleetStore.refetch(); } catch(_){} }, 30000);
 }
 }
 }
 }
 load(); // re-render the (now refreshed) store
 return;
 }
 // A rotated/expired session surfaces as 401 OR 403 "Invalid or inactive
 // tenant key", guide the owner to re-auth instead of showing the raw error.
 const authDead = r.status===401 ||
 (r.status===403 && /tenant key|sign in|session/i.test((data && (data.detail||data.message))||""));
 if(authDead){
 try { localStorage.removeItem("so_session"); } catch(e){}
 if(note){ note.className = "sb-note err"; note.innerHTML = `Your session expired, <a href="onboarding.html">sign in again →</a>, then reconnect. Your existing arrays are safe.`; }
 return;
 }
 if(note){ note.className = "sb-note err"; note.textContent = (data && (data.message||data.detail)) || `Couldn't bring in that ${BRAND[d.provider]||d.provider} account (HTTP ${r.status}).`; }
 }catch(err){
 if(note){ note.className = "sb-note err"; note.textContent = "We couldn't reach the connection service just now, check your network and try again."; }
 }
 }
 window.addEventListener("message", (e) => {
 if(e.source !== window || e.origin !== window.location.origin) return;
 const d = e.data; if(!d || typeof d !== "object") return;
 if(d.type === "SO_EXTENSION_PRESENT" || (d.type === "SO_STATUS_ACK" && d.ok)){
 if(!EXT_PRESENT){ EXT_PRESENT = true; if(_ov && _ov.classList.contains("open")) renderAddModalBody(); }
 try { window.__AO_EXT_PRESENT = true; } catch(e){} // shared flag: the spreadsheet view's Refresh button uses it
 autoPairExtension(); // re-link the extension to this tenant's key, self-heals "Not connected"
 }
 if(d.type === "SO_CAPTURE_LANDED" && ["solaredge","fronius","sma","chint","gmp","vec","wec","eversource","eversource_ma","eversource_ct","cmp"].includes(d.provider)){
 // A sync for this vendor landed, clear its chip state; handleCaptureLanded
 // reloads the fleet so the chip re-renders fresh (or vanishes).
 if(_syncState[d.provider]){ delete _syncState[d.provider]; if(_syncTimers[d.provider]) clearTimeout(_syncTimers[d.provider]); }
 handleCaptureLanded(d);
 }
 // Portal says the owner isn't signed in → say exactly that on the sync chip and
 // offer a foreground "Open ↗" so they can log in (then the capture flows).
 if(d.type === "SO_LOGIN_STATE" && d.provider && (d.state === "login_required" || d.state === "signed_out")
 && _syncState[d.provider] && _syncState[d.provider].phase === "syncing"){
 if(_syncTimers[d.provider]) clearTimeout(_syncTimers[d.provider]);
 _syncState[d.provider] = { phase:"signin" };
 try { repaintFresh(d.provider); } catch(_){}
 }
 if(d.type === "SO_CAPTURE_FAILED"){
 // Sync chip: surface what a pull needs (usually a portal sign-in).
 if(d.provider && _syncState[d.provider]){
 if(_syncTimers[d.provider]) clearTimeout(_syncTimers[d.provider]);
 _syncState[d.provider] = { phase:"failed", msg:_friendlySyncFail(d.reason, BRAND[d.provider]||d.provider) };
 try { repaintFresh(d.provider); } catch(_){}
 }
 // Ford 2026-07-12: a background/other-tab SMA capture attempt (auto-refresh,
 // not anything the operator did in THIS modal) was landing its failure inside
 // the "Link utility bills" modal, which offers no SMA option at all, so "SMA
 // didn't connect" made no sense there. Only show the note if the failed
 // provider is actually offered by the currently-open modal.
 const irrelevant = _ovUtilityOnly && _INVERTER_VENDORS.includes(d.provider);
 const note = !irrelevant && _ov && _ov.querySelector("#sbNote");
 if(note){
 note.className = "sb-note err";
 note.textContent = `${BRAND[d.provider]||d.provider} didn't connect: ${d.reason||"unknown error"}. Make sure you're signed in on the portal tab, then click again.`;
 }
 }
 });
 extSend("SO_STATUS_REQUEST"); // ask explicitly in case the bridge announced before we listened

 // ── "Open in <Vendor>" buttons → arm a fresh extension capture ──────────────
 // The portal deep-links (.sb-brandlink / .sb-origin, data-portal=vendor) used to
 // be plain new-tab links, opening the portal did NOTHING, because every vendor
 // content script refuses to capture without an explicit AO "intent" (so_capture_
 // intent, 10-min TTL). So the card's own "open <vendor> to refresh" was a promise
 // it couldn't keep. Now, when the extension is present, a click ARMS that intent
 // and lets the extension open the portal (SO_OPEN_PORTAL → background sets the
 // intent + opens the tab), so the .58 content script captures live readings on
 // load and they sync straight back here (SO_CAPTURE_LANDED → handleCaptureLanded
 // → /inverter-capture). No extension → fall through to the plain link.
 document.addEventListener("click", (e) => {
 const a = e.target && e.target.closest && e.target.closest("a[data-portal]");
 if(!a) return;
 // Leave new-tab / modified clicks (middle, ⌘/ctrl/shift/alt) to the browser.
 if(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
 if(!EXT_PRESENT) return; // no extension installed → plain link opens the portal
 const vendor = a.getAttribute("data-portal");
 const url = a.getAttribute("href");
 if(!vendor || !url) return;
 e.preventDefault(); // the extension opens the tab, don't open a second one
 extSend("SO_OPEN_PORTAL", { url, active: true, provider: vendor, vendor });
 try { if(typeof toast === "function") toast(`Opening ${BRAND[vendor]||vendor}, your latest readings will sync back here.`, "ok"); } catch(_){}
 });

 // ── little click-to-sync button on a stale array's freshness chip ───────────
 // Pulls fresh via the extension (background tab → the dashboard keeps focus);
 // the "Open ↗" escalation (data-fresh-fg) foregrounds the portal for sign-in.
 // startSync handles the no-extension / sign-in / failure messaging.
 document.addEventListener("click", (e) => {
 const b = e.target && e.target.closest && e.target.closest("button.sb-fresh-sync");
 if(!b) return;
 e.preventDefault();
 const chip = b.closest(".sb-fresh");
 const vendor = chip && chip.getAttribute("data-fresh-vendor");
 if(!vendor) return;
 startSync(vendor, b.getAttribute("data-fresh-fg") === "1");
 });

 // ── freshness-chip sync engine (MODULE scope: reached by the handlers above AND
 // by render()'s freshnessHTML below) ────────────────────────────────────────
 const _syncState = {}; // vendor -> {phase:"syncing"|"signin"|"failed"|"needext", msg?}
 const _syncTimers = {}; // vendor -> setTimeout id
 const _SYNCABLE_VENDORS = new Set(["fronius","sma","chint"]); // extension-captured → user can sync
 const _POLLED_VENDORS = new Set(["solaredge","alsoenergy"]); // server-polled → passive "as of" only
 const REFRESH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

 function _friendlySyncFail(reason, vlabel){
 const r = String(reason || "").toLowerCase();
 if(r.includes("sign in") || r.includes("log in") || r.includes("login") || r.includes("signed"))
 return `sign in to ${vlabel}, then sync again`;
 return `open ${vlabel} and sign in, then sync again`;
 }

 // Inner content (class + html) of the freshness chip for a vendor's current state —
 // shared by the first render (freshnessHTML) and in-place repaints (repaintFresh).
 function freshInner(vendor, ageStr){
 const vlabel = BRAND[vendor] || vendor;
 const dot = '<span class="sb-fresh-dot" aria-hidden="true"></span>';
 // Demo fleet = cloud capture mode, never "Open portal to sync".
 try {
 if(window.FleetStore && FleetStore.isSimulated && FleetStore.isSimulated()){
 return { cls:"sb-fresh--live", html: dot +
 `<span class="sb-fresh-txt">Cloud capture · auto-refresh</span>` };
 }
 } catch(_){}
 // POLLED vendors (SolarEdge): refreshed server-side, nothing for the user to sync —
 // show an honest "Updated Xh ago" (audit #6) so an aging reading in the 15min–6h
 // window isn't read as live. No sync button (the poller handles it on its own).
 if(!_SYNCABLE_VENDORS.has(vendor)){
 return { cls:"sb-fresh--stale", html: dot +
 `<span class="sb-fresh-txt">Updated ${esc(String(ageStr))}</span>` };
 }
 const st = _syncState[vendor];
 const phase = st && st.phase;
 if(phase === "syncing"){
 return { cls:"sb-fresh--syncing", html:
 `<span class="sb-fresh-ic">${REFRESH_SVG}</span>`+
 `<span class="sb-fresh-txt">Syncing ${esc(String(vlabel))}…</span>` };
 }
 if(phase === "signin"){
 return { cls:"sb-fresh--warn", html: dot +
 `<span class="sb-fresh-txt">Sign in to ${esc(String(vlabel))} to sync</span>`+
 `<button class="sb-fresh-sync" type="button" data-fresh-fg="1" aria-label="Open ${esc(String(vlabel))} to sign in">Open&nbsp;↗</button>` };
 }
 if(phase === "needext"){
 return { cls:"sb-fresh--warn", html: dot +
 `<span class="sb-fresh-txt">Syncing needs the EnergyAgent extension</span>`+
 `<a class="sb-fresh-install" href="${esc(EXT_STORE_URL)}" target="_blank" rel="noopener">Add it&nbsp;→</a>` };
 }
 if(phase === "failed"){
 const msg = (st && st.msg) || _friendlySyncFail("", vlabel);
 return { cls:"sb-fresh--warn", html: dot +
 `<span class="sb-fresh-txt">Couldn't sync, ${esc(String(msg))}</span>`+
 `<button class="sb-fresh-sync" type="button" title="Try again" aria-label="Retry sync">${REFRESH_SVG}</button>` };
 }
 return { cls:"sb-fresh--stale", html: dot +
 `<span class="sb-fresh-txt">Last synced ${esc(String(ageStr))}</span>`+
 `<button class="sb-fresh-sync" type="button" title="Sync ${esc(String(vlabel))} now" aria-label="Sync ${esc(String(vlabel))} now">${REFRESH_SVG}</button>` };
 }

 // Repaint every freshness chip for a vendor IN PLACE (no fleet reload), so a sync
 // click / login-required / failure updates instantly. Success instead rides the
 // normal reload in handleCaptureLanded (the chip re-renders fresh, or vanishes).
 function repaintFresh(vendor){
 const sel = '.sb-fresh[data-fresh-vendor="' + (window.CSS && CSS.escape ? CSS.escape(vendor) : vendor) + '"]';
 document.querySelectorAll(sel).forEach(el => {
 const { cls, html } = freshInner(vendor, el.getAttribute("data-fresh-age") || "");
 el.className = "sb-fresh " + cls;
 el.innerHTML = html;
 });
 }

 // Pull fresh data for a vendor: arm the capture intent + open its portal so the
 // extension captures live readings that sync back here. Default sync click opens a
 // BACKGROUND tab (dashboard keeps focus); the "Open ↗" sign-in escalation passes
 // foreground=true so the owner can log in. Tells them what's missing when it can't.
 function startSync(vendor, foreground){
 const url = PORTAL_URL[vendor];
 const vlabel = BRAND[vendor] || vendor;
 if(!url) return;
 if(!EXT_PRESENT){ _syncState[vendor] = { phase:"needext" }; repaintFresh(vendor); return; }
 _syncState[vendor] = { phase:"syncing", startedAt: Date.now() };
 repaintFresh(vendor);
 extSend("SO_OPEN_PORTAL", { url, active: foreground === true, provider: vendor, vendor });
 if(_syncTimers[vendor]) clearTimeout(_syncTimers[vendor]);
 _syncTimers[vendor] = setTimeout(() => {
 if(_syncState[vendor] && _syncState[vendor].phase === "syncing"){
 _syncState[vendor] = { phase:"failed", msg:`open ${vlabel} and sign in, then sync again` };
 repaintFresh(vendor);
 }
 }, 75000);
 }


 // ---- saved column order (localStorage) ----
 function loadOrder(){
 return _lsReadJSON(ORDER_KEY, raw => {
 const v = raw == null ? null : JSON.parse(raw);
 return Array.isArray(v) ? v.map(String) : [];
 });
 }
 function saveOrder(canvas){
 const ids = [...canvas.querySelectorAll(".sb-col")].map(c => c.dataset.arrayId);
 try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); _lsInvalidate(ORDER_KEY); } catch(e){}
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
 // ---- ONE-TIME localStorage → backend rename migration --------------------
 // Renames used to live ONLY in localStorage (RENAME_KEY = "ao_renames"), so
 // they never reached the backend or the Spreadsheet view and didn't survive a
 // reload. Renames are now persisted server-side via FleetStore. On the first
 // LIVE load we push each still-relevant local rename to the backend (so Ford
 // doesn't lose his current custom names), then drop the local store. Guarded by
 // a one-time flag so it runs exactly once; after that the backend is the source
 // of truth and the local store is gone.
 const RENAME_MIGRATED_KEY = "ao_renames_migrated_v1";
 function migrateLocalRenames(){
 if(!(window.FleetStore && FleetStore.isLive && FleetStore.isLive())) return; // live only
 let migrated = false;
 try { migrated = localStorage.getItem(RENAME_MIGRATED_KEY) === "1"; } catch(_){}
 if(migrated) return;
 let raw = null;
 try { raw = localStorage.getItem(RENAME_KEY); } catch(e){ _warnLS(RENAME_KEY, e); }
 if(!raw){
 try { localStorage.setItem(RENAME_MIGRATED_KEY, "1"); } catch(_){}
 return;
 }
 let store = {};
 try { store = JSON.parse(raw) || {}; } catch(e){ _warnLS(RENAME_KEY, e); }
 const arrays = (store.arrays && typeof store.arrays === "object") ? store.arrays : {};
 const inverters = (store.inverters && typeof store.inverters === "object") ? store.inverters : {};
 const snap = (FleetStore.snapshot && FleetStore.snapshot().arrays) || [];
 // index current FleetStore names by id so we only push renames that (a) match
 // a real loaded array/inverter and (b) actually differ from the live name.
 const arrName = new Map(), invName = new Map();
 snap.forEach(a => {
 arrName.set(String(a.id), a.name);
 (a.inverters || []).forEach(iv => invName.set(String(iv.id), iv.name));
 });
 let pushed = 0;
 Object.keys(arrays).forEach(id => {
 const want = String(arrays[id] || "").trim();
 if(want && arrName.has(id) && arrName.get(id) !== want && FleetStore.renameArray){
 FleetStore.renameArray(id, want); pushed++;
 }
 });
 Object.keys(inverters).forEach(id => {
 const want = String(inverters[id] || "").trim();
 if(want && invName.has(id) && invName.get(id) !== want && FleetStore.renameInverter){
 FleetStore.renameInverter(id, want); pushed++;
 }
 });
 // Backend is now the authority, drop the local store + set the one-time flag.
 try { localStorage.removeItem(RENAME_KEY); } catch(_){}
 try { localStorage.setItem(RENAME_MIGRATED_KEY, "1"); } catch(_){}
 if(pushed){ try { console.info("[sandbox] migrated " + pushed + " local rename(s) to the backend"); } catch(_){} }
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
 // Persist through FleetStore → backend (was localStorage-only). This
 // updates shared state + notify()s, so the OTHER view (Spreadsheet)
 // repaints the new name instantly, and a reload reads it from the
 // backend. The store no-ops an unchanged value, so re-committing the
 // same text is harmless.
 if(id != null && id !== "" && window.FleetStore){
 if(kind === "arrays" && FleetStore.renameArray) FleetStore.renameArray(id, val);
 else if(kind === "inverters" && FleetStore.renameInverter) FleetStore.renameInverter(id, val);
 }
 if(kind === "inverters" && idEl) idEl.dataset.name = val; // keep detail-line in sync
 } else {
 node.textContent = node.dataset.orig || original; // revert (cancel / empty)
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

 // transient bottom-corner toast (errors / confirmations), no framework needed
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

 // ---- value model (mirrors command-center.js / app.js), $ at stake estimate ----
 // Rate from FleetStore.energyRate(): the owner's REAL billed $/kWh when signed
 // in (backend default_net_rate_per_kwh), so "$ at stake" matches their invoices
 // instead of overstating ~14% with a hardcoded $0.21. Falls back to 0.21 for the
 // demo/anon fleet and before the rate fetch returns.
 const ENERGY_RATE_FALLBACK = 0.21; // $/kWh blended offset (demo/anon)
 const energyRate = () => (window.FleetStore && window.FleetStore.energyRate) ? window.FleetStore.energyRate() : ENERGY_RATE_FALLBACK;
 const REC_PER_MWH = (window.FleetStore && window.FleetStore.REC_PER_MWH) || 38; // $/MWh REC value
 const SB_WINDOW_DAYS = 14;
 const dollarVal = kwh => kwh*energyRate() + (kwh/1000)*REC_PER_MWH;
 const usd0 = n => "$" + Math.round(Number(n)||0).toLocaleString();
 // Tooltip for the "$ at stake" estimates, names the rate actually used. When a
 // signed-in owner's real billed rate is loaded it's pinned to their tariff; the
 // demo/anon fallback still invites them to connect their tariff to pin it.
 const _hasLiveRate = () => !!(window.FleetStore && window.FleetStore.energyRate && window.FleetStore.isLive && window.FleetStore.isLive());
 const riskTip = () => `Estimate at $${energyRate().toFixed(2)}/kWh + $${REC_PER_MWH}/MWh RECs` + (_hasLiveRate() ? ", pinned to your billing rate." : ", connect your live tariff to pin it.");

 // Per-array health rollup for the OVERVIEW GRID. Returns the worst-case tone
 // (ok/warn/bad), flagged count, and estimated $/mo at stake across the array —
 // grounded in the same peer-shortfall math the command center uses.
 function arrayHealth(col){
 const invs = col.inverters || [];
 const totalNp = invs.reduce((t,i)=>t+(i.nameplate_kw||0),0) || 1;
 const fleetWin = invs.reduce((t,i)=>t+(i.window_kwh||0),0);
 let flagged = 0, crit = 0, lostKwh = 0, liveAnoms = 0;
 // Vendor-side outage (source_status.state === "stale" in daylight) is a real
 // problem even when every inverter's 14-day peer verdict still says "ok"
 // (frozen history). Without this the array card badges "All good" on a site
 // whose monitoring vendor stopped reporting (Londonderry SolarEdge, Ford
 // 2026-07-13). Overnight stale is "asleep", not flagged.
 const _srcStale = col && col.source_status && col.source_status.state === "stale";
 const _vendorOut = _srcStale && col.is_daylight !== false;
 if(_vendorOut){ flagged = Math.max(flagged, 1); }
 for(const inv of invs){
 // A LIVE anomaly (dark, OR low vs peers, right now while peers produce) the
 // 14-day health hasn't flagged yet still counts as flagged here, otherwise the
 // tile reads "all good" while a card inside shows "Not producing"/"Low vs peers".
 // Shared classifier.
 const _lvBad = inv.status === "ok" && window.FleetStore && FleetStore.liveVerdict
 ? FleetStore.liveVerdict(inv, invs, col.is_daylight) : null;
 const liveBad = _lvBad === "dark" || _lvBad === "low";
 if(inv.status === "ok"){
 if(liveBad){ flagged++; liveAnoms++; }
 continue;
 }
 // "monitoring" = not enough evidence to judge yet, neutral, never flagged.
 if(inv.status === "monitoring") continue;
 flagged++;
 if(inv.status === "dead" || inv.status === "fault") crit++;
 const fair = (inv.nameplate_kw||0)/totalNp*fleetWin;
 if(inv.status === "dead" || inv.status === "fault") lostKwh += Math.max(0, fair-(inv.window_kwh||0));
 else if(inv.status === "underperforming" && inv.peer_index) lostKwh += Math.max(0, fair/Math.max(inv.peer_index,0.01)-(inv.window_kwh||0));
 // comm_gap = unknown until it reports, no $ claimed
 }
 const lossMo = dollarVal(lostKwh)/SB_WINDOW_DAYS*30;
 const tone = crit ? "bad" : flagged ? "warn" : "ok";
 return { tone, flagged, crit, lossMo, total: invs.length, liveAnoms, vendorOut: !!_vendorOut };
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
 clear: { icon:"☀️", label:"Clear" },
 pcloudy: { icon:"⛅", label:"Partly cloudy" },
 cloudy: { icon:"☁️", label:"Cloudy" },
 fog: { icon:"🌫️", label:"Fog" },
 rain: { icon:"🌧️", label:"Rain" },
 snow: { icon:"🌨️", label:"Snow" },
 storm: { icon:"⛈️", label:"Thunderstorm" },
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
 const _wxCache = {}; // arrayId → {key, temp} resolved condition (persists across re-renders)
 function _hashStr(s){ let h=0; s=String(s); for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return Math.abs(h); }
 function synthWx(col){
 // deterministic per-array so the demo reads as "real, stable weather"
 const keys = ["clear","clear","pcloudy","pcloudy","cloudy","rain","snow"];
 const h = _hashStr(col.array_id != null ? col.array_id : col.array_name);
 return { key: keys[h % keys.length], temp: 40 + (h % 45) }; // 40–84°F
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
 if(lat==null || lng==null) return; // no coords → keep synthetic
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

 // peer-index bar (0..~1.2 clamped), green at/above 1, amber/ red below
 function peerBar(pi){
 if(pi==null) return `<div class="sb-pi none">solo · no peers</div>`;
 const pct = Math.max(4, Math.min(100, Math.round(pi*100)));
 const cls = pi>=0.85 ? "ok" : pi>=0.6 ? "warn" : "bad";
 return `<div class="sb-pi"><div class="sb-pi-bar ${cls}" style="width:${pct}%"></div><span class="${cls}">${pi.toFixed(2)}</span></div>`;
 }

 // Mini output graph for an inverter card: an SVG BAR chart of its daily kWh
 // series (real backend telemetry for signed-in owners; synthetic for the demo
 // fleet), one bar per day. Zero-output days get a red dot at the baseline so a
 // dead/quiet streak reads instantly. Returns "" when there's no series (then the
 // card shows a "no history yet" note).
 function invSpark(daily, statusCls){
 if(!Array.isArray(daily) || daily.length < 2) return "";
 const w = 132, h = 34, pad = 3;
 const vals = daily.map(d => Math.max(0, +d.kwh || 0));
 const max = Math.max(...vals, 0.001);
 const fill = statusCls === "bad" ? "var(--bad)" : statusCls === "warn" ? "var(--warn)" : "var(--good)";
 const baseY = h - pad;
 const slot = (w - 2*pad) / vals.length;
 const gap = Math.min(1.4, slot * 0.22);
 const bw = Math.max(0.8, slot - gap);
 const bars = vals.map((v,i)=>{
 const x = pad + i*slot + gap/2;
 if(v === 0){
 return `<circle cx="${(x+bw/2).toFixed(1)}" cy="${baseY.toFixed(1)}" r="1.6" fill="var(--bad)"/>`;
 }
 const bh = Math.max(0.8, (v/max)*(h-2*pad));
 return `<rect x="${x.toFixed(1)}" y="${(baseY-bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="0.5" fill="${fill}"/>`;
 }).join("");
 // time scale: label the oldest (left), a midpoint, and the newest (right) day
 const last = daily.length - 1, mid = Math.floor(last/2);
 const lo = _sparkTimeLabel(daily[0].date, last, 0);
 const mp = _sparkTimeLabel(daily[mid].date, last, mid);
 const hi = _sparkTimeLabel(daily[last].date, last, last);
 const axis = `<div class="sb-spark-axis"><span>${esc(lo)}</span><span>${esc(mp)}</span><span>${esc(hi)}</span></div>`;
 return `<div class="sb-spark-wrap">
 <svg class="sb-inv-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
 ${bars}
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
 // This is the ARRAY's own production history, "how's my array doing" at a glance —
 // not a grid of per-inverter minis. Tone tracks the array's live output vs its
 // combined rated capacity (green at/near max → amber → orange → idle when nothing
 // is reporting). Days where the whole array made nothing get a red dot.
 function arrayGraph(sortedInvs, arrayDaily, col, stream){
 stream = stream || "vendor";
 const split = (col && col.daily_split) || null;
 // ── UTILITY stream: show the meter's settled generation for this array. There
 // is no per-inverter meter data, so this reads the array-level utility series
 // straight from the backend split. ──
 if(stream === "utility"){
 const useries = (split && Array.isArray(split.utility)) ? split.utility : [];
 const byDate = new Map();
 useries.forEach(d => { if(d && d.date != null) byDate.set(d.date, Math.max(0, +d.kwh || 0)); });
 return _renderArraySeries(byDate, "Utility meter · last %d days",
 "var(--util, #5b8def)",
 "no utility-meter data yet, connect GMP to see settled generation");
 }
 if(!sortedInvs || !sortedInvs.length){
 // No inverters, but the array may still carry vendor-side history (csv/
 // extension at the array level), fall back to the vendor split series.
 const vseries = (split && Array.isArray(split.vendor)) ? split.vendor : (arrayDaily || []);
 const byDate = new Map();
 vseries.forEach(d => { if(d && d.date != null) byDate.set(d.date, Math.max(0, +d.kwh || 0)); });
 if(byDate.size < 2) return "";
 return _renderArraySeries(byDate, "Array production · last %d days", "var(--good)", "");
 }
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
 // when per-inverter series are sparse, e.g. Chint reports site-level daily
 // (weekETrend backfill) but no per-inverter history. This makes the graph
 // appear immediately on connect instead of waiting for days to accumulate.
 if(byDate.size < 2 && Array.isArray(arrayDaily)){
 arrayDaily.forEach(d => {
 if(!d || d.date == null) return;
 byDate.set(d.date, Math.max(byDate.get(d.date) || 0, Math.max(0, +d.kwh || 0)));
 });
 }
 // The 7-day PRODUCTION HISTORY is just data, color it the healthy brand
 // color (var(--good): blue in day, green at night), NOT the array's CURRENT
 // live tone. Tinting past production red because the array happens to be
 // asleep/idle right now (e.g. nighttime, 0% of nameplate) was misleading —
 // live health is already shown by the state pill + OUTPUT NOW bar + card
 // tone. Zero-output DAYS still flag individually as a red dot (in the renderer).
 return _renderArraySeries(byDate, "Array production · last %d days", "var(--good)", "");
 }

 // Shared renderer for the array-level daily series (used by both vendor and
 // utility streams). `byDate` = Map(dateISO → kWh). `labelTmpl` has a %d for the
 // day count. `emptyMsg` (when non-empty) renders instead of the "history
 // building" note, used to explain a stream that simply has no data yet.
 function _renderArraySeries(byDate, labelTmpl, stroke, emptyMsg){
 const sortKey = s => {
 if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
 const m = String(s).match(/d-?(\d+)/);
 return m ? String(1e6 - (+m[1])).padStart(9,"0") : s; // d-14 oldest → d-1 newest
 };
 const dates = [...byDate.keys()].sort((a,b)=> sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
 if(dates.length < 2){
 const msg = emptyMsg || "history building, graph appears once 2+ days are stored";
 return `<div class="sb-ag"><div class="sb-ag-k">${esc(labelTmpl.replace("· last %d days","").trim())}</div>
 <div class="sb-ag-nodata">${esc(msg)}</div></div>`;
 }
 const vals = dates.map(d => byDate.get(d));
 const totalKwh = vals.reduce((s,v)=>s+v,0);
 const w = 300, h = 56, pad = 4;
 const max = Math.max(...vals, 0.001);
 const baseY = h - pad;
 const slot = (w - 2*pad) / vals.length;
 const gap = Math.min(2, slot * 0.22);
 const bw = Math.max(1, slot - gap);
 const bars = vals.map((v,i)=>{
 const x = pad + i*slot + gap/2;
 if(v === 0){
 return `<circle cx="${(x+bw/2).toFixed(1)}" cy="${baseY.toFixed(1)}" r="2" fill="var(--bad)"/>`;
 }
 const bh = Math.max(1, (v/max)*(h-2*pad));
 return `<rect x="${x.toFixed(1)}" y="${(baseY-bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="0.7" fill="${stroke}"/>`;
 }).join("");
 const last = dates.length-1, mid = Math.floor(last/2);
 const lo = _sparkTimeLabel(dates[0], last, 0);
 const mp = _sparkTimeLabel(dates[mid], last, mid);
 const hi = _sparkTimeLabel(dates[last], last, last);
 const totalLbl = totalKwh >= 1000 ? `${(totalKwh/1000).toFixed(1)} MWh` : `${Math.round(totalKwh)} kWh`;
 return `<div class="sb-ag">
 <div class="sb-ag-head">
 <span class="sb-ag-k">${esc(labelTmpl.replace("%d", String(dates.length)))}</span>
 <span class="sb-ag-total">${totalLbl}</span>
 </div>
 <svg class="sb-ag-graph" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
 ${bars}
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
 // Single billing basis for an inverter's LIVE output state, used by both the
 // output bar and the whole-card tint so they never disagree.
 // - A literal 0 (or a trickle below ~1% of rated / 25W) means the panels are
 // idle RIGHT NOW, evening, night, or simply not generating. That is NOT an
 // underperformance alarm, so it reads as "idle" (calm), never orange. This is
 // the fix for healthy "All good" inverters glowing orange every evening when
 // SolarEdge reports current_power_w: 0 instead of null.
 // - The orange/red output tint only fires when the inverter's HEALTH status is
 // already flagged (dead/fault/underperforming). A healthy inverter dipping
 // under clouds is normal and shouldn't alarm, real underperformance is caught
 // by the peer-based health status, which carries its own border + alert line.
 // Estimated rated max (W) from the observed peak daily kWh when the vendor
 // gives us no nameplate (e.g. some SolarEdge sites, Chint). Mirrors the
 // backend's peer_analysis._infer_nameplate EXACTLY (peak daily kWh / 4 ≈ kW
 //, a ~4 kWh/day-per-kW temperate ceiling) so the card's % matches the health
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
 // every inverter, distinct from a numeric 0 (SolarEdge/SMA/Chint at night).
 // We must NOT paint those as the dead "not producing right now": they produced
 // today, we simply have no live wattage. Surface today's REAL kWh instead.
 function liveReadingMissing(inv){ return inv && inv.current_power_w == null; }
 // Local YYYY-MM-DD (NOT toISOString, which returns the UTC date). The daily series
 // is keyed by the site's LOCAL calendar day, so comparing it to a UTC date breaks
 // every evening for US owners: once local time crosses into the next UTC day, the
 // last point's local date no longer equals the UTC "today" and the card flips to
 // "no live feed" even though today's kWh is right there.
 function localDateStr(dt){
 const y = dt.getFullYear(), m = dt.getMonth() + 1, d = dt.getDate();
 return y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
 }
 // Today's produced kWh from the daily series (last point, if it's today's date).
 // Returns null when the series doesn't reach today.
 function todayKwh(inv){
 const d = inv && inv.daily;
 if(!Array.isArray(d) || !d.length) return null;
 const last = d[d.length - 1];
 if(!last || last.date == null) return null;
 const today = localDateStr(new Date());
 return String(last.date).slice(0, 10) === today ? (+last.kwh || 0) : null;
 }
 function outputState(inv, statusCls){
 const realW = (inv.nameplate_kw != null) ? inv.nameplate_kw * 1000 : null;
 // No real nameplate → estimate one from production history so we can still
 // show a %. estimated=true drives the "~est. max" label downstream.
 const estW = realW == null ? estNameplateW(inv) : null;
 const maxW = realW != null ? realW : estW;
 const estimated = realW == null && estW != null;
 const curW = (inv.current_power_w != null) ? inv.current_power_w : null;
 // "Producing" needs only a real live reading. Below ~25W (or ~1% of the
 // rated/estimated max, when known) = genuinely idle.
 const floor = maxW != null ? Math.max(25, maxW * 0.01) : 25;
 const producing = curW != null && curW > floor;
 if(!producing) return { reporting: false, pct: null, tone: "idle", estimated, maxW };
 // The orange/red output tint only fires when HEALTH is already flagged
 // (underperforming/fault/dead → "warn"/"bad"). "ok" AND the neutral
 // "monitoring" (info) state are both calm, a healthy or not-yet-judged
 // inverter dipping under clouds must not paint the card as a problem.
 const calm = (statusCls === "ok" || statusCls === "info");
 if(maxW == null){
 // Real output but NO nameplate AND no history to estimate from, the only
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
 // Fronius/SMA/Chint expose only ONE site-level instantaneous power; the backend
 // splits it across inverters by today's energy share, so a per-inverter "kW now"
 // is an ESTIMATE, not a measured per-device reading (audit #5). Mark it "~" + a tip.
 const _alloc = curKw != null && (inv.vendor === "fronius" || inv.vendor === "sma" || inv.vendor === "chint");
 const curB = (txt) => _alloc
 ? `<b class="sb-ob-cur" title="${esc(BRAND[inv.vendor]||inv.vendor)} reports one site-level power, we split it across inverters by today's energy share, so this per-inverter kW is an estimate.">~${txt}</b>`
 : `<b class="sb-ob-cur">${txt}</b>`;
 let label;
 if(!os.reporting){
 // Distinguish "we have no live wattage feed for this vendor" (Fronius:
 // current_power_w == null) from "live feed says ~0 right now" (genuinely
 // idle). The former produced today, show its REAL kWh, never "not
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
 // Mark an estimated denominator ("of ~est. max"); a real
 // nameplate stays the plain "of max · cur/max kW".
 const ofTxt = os.estimated
 ? `<span title="No rated nameplate from this vendor, max estimated from peak production.">of ~est · ${curB(curKw.toFixed(1))}/~${maxKw.toFixed(1)} kW</span>`
 : `of max · ${curB(curKw.toFixed(1))}/${maxKw} kW`;
 label = `<b class="sb-ob-pct">${os.pct}%</b><span class="sb-ob-of">${ofTxt}</span>`;
 } else {
 // Producing, but no rated max AND no history to estimate from, last-resort
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
 // capacity factor = current/max, the SAME number behind "Output now %", so no
 // new data. The "Sleeping" night state (calm indigo pool) triggers ONLY on
 // (sun-down AND zero output) using the server is_daylight flag, never zero
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
 // No-energy-register unit: its low/zero live split is an artifact of the dead
 // meter, not a real fault or low-output, keep the pool calm (never fault/low).
 if(inv && inv.no_energy_register) return "ok";
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
 // producing right now", the badge never consulted the live number. We close
 // that gap by applying the SAME peer-relative idea to the INSTANTANEOUS reading:
 // an inverter dark right now while a quorum of its daylight siblings produce is
 // a real-time anomaly the badge must not paper over.
 // "ok" → producing, OR calmly idle (night / peers also idle / too few lit
 // peers to judge), badge may say "All good"
 // "dark" → fresh live reading ~0 W while ≥2 peers produce in daylight, a
 // real anomaly that the slow 14-day health hasn't caught yet (amber)
 // "stale" → NO live reading while peers produce in daylight, unknown, could
 // be a telemetry gap, not a confirmed power fault (neutral)
 // The classifier itself lives in FleetStore so the grid + command center share
 // the EXACT same logic (one billing basis, no drift across surfaces). This
 // thin wrapper keeps a self-contained fallback for any context where the store
 // isn't present (e.g. an isolated render test).
 function liveVerdict(inv, peers, isDaylight){
 if(window.FleetStore && FleetStore.liveVerdict)
 return FleetStore.liveVerdict(inv, peers, isDaylight);
 // Fallback (FleetStore absent, isolated render test). Mirrors FleetStore.liveVerdict,
 // including the peer-level "low" check, so surfaces still agree without the store.
 if(isDaylight === false) return "ok";
 const floorOf = i => (i.nameplate_kw != null) ? Math.max(25, i.nameplate_kw*1000*0.01) : 25;
 const producing = i => i.current_power_w != null && i.current_power_w > floorOf(i);
 const pctOfMax = i => (i.nameplate_kw && i.current_power_w!=null) ? i.current_power_w/(i.nameplate_kw*1000) : null;
 if(producing(inv)){
 const lit = (peers||[]).filter(p => p.inverter_id !== inv.inverter_id && producing(p));
 if(lit.length < 2) return "ok";
 const myPct = pctOfMax(inv);
 if(myPct == null) return "ok";
 const peerPcts = lit.map(pctOfMax).filter(v => v != null).sort((a,b) => a-b);
 if(peerPcts.length < 2) return "ok";
 const med = peerPcts[Math.floor(peerPcts.length/2)];
 if(med < 0.30) return "ok";
 return myPct < med*0.85 ? "low" : "ok";
 }
 const litPeers = (peers||[]).filter(p =>
 p.inverter_id !== inv.inverter_id && producing(p)).length;
 if(litPeers < 2) return "ok";
 return (inv.current_power_w != null) ? "dark" : "stale";
 }

 // ── NOW state, the card's explicit LIVENESS axis ───────────────────────────
 // A card carries TWO independent truths that must never masquerade as one:
 // • NOW , is it making power THIS INSTANT? (current_power_w)
 // • HEALTH, is it pulling its weight over 14 days? (inv.status, peer_analysis)
 // Conflating them is what produced the "All good" badge on a dark inverter. So
 // we surface NOW as its own small color-coded chip and leave the health badge
 // to mean ONLY health. liveState maps the instantaneous reading (cross-checked
 // against peers) to a labelled, toned state for that chip.
 // producing → green making power now
 // idle → grey not producing, but calm (peers idle too / too few lit
 // peers to judge), nothing wrong
 // dark → amber not producing while ≥2 daylight peers are, the anomaly
 // stale → blue no live reading at all, unknown, not a confirmed fault
 // asleep → lavender sun-down resting state (owned by the Sleeping visuals)
 function liveState(inv, peers, isDaylight, sleeping){
 if(sleeping) return { key:"asleep", label:"Asleep", tone:"sleep" };
 const lv = liveVerdict(inv, peers, isDaylight);
 // A producing-but-low inverter is still "reporting", so surface the peer-level gap
 // as its NOW state BEFORE the plain green "Producing" chip, else a 42%-of-max unit
 // beside 101% peers would read a calm "Producing" (Ford's Waterford case).
 if(lv === "low") return { key:"low", label:"Low vs peers", tone:"warn",
 title:"Producing well below its sibling inverters right now (>15% under the peer median for its nameplate)." };
 if(outputState(inv, "ok").reporting)
 return { key:"producing", label:"Producing", tone:"ok" };
 if(lv === "dark") return { key:"dark", label:"Not producing", tone:"warn",
 title:"Dark right now while sibling inverters are producing." };
 if(lv === "stale") return { key:"stale", label:"No signal", tone:"info",
 title:"No live reading from this inverter right now." };
 return { key:"idle", label:"Idle", tone:"idle",
 title:"Not producing right now, but its peers aren't either, so nothing's wrong." };
 }

 // ── CONDENSED state, one honest word per inverter (Ford's redesign) ──────
 // HEALTH (14d peer) and NOW (live) must never contradict on the card.
 // Precedence: health fault → live shortfall (when health ok) → sleeping →
 // producing → offline. Never label "Error" while diagnosis says "pulling its
 // weight" (Bruce / Chester #4, 2026-07-15).
 function fourState(inv, peers, isDaylight, statusCls, sleeping){
 // NO ENERGY DATA (backend no_energy_register, e.g. Tannery #7, S/N 191213319):
 // the vendor streams this unit's live POWER but its cumulative-energy register
 // is dead, no daily history, no peer grade, and its per-inverter power is an
 // unreliable energy-share split. It is NOT offline and NOT a fault: it's a
 // metering defect at the source. So it gets its OWN honest, non-alarming state
 // (never Error/Offline), matching the morning digest's "SMA reports power but
 // no energy for this inverter, check its metering" flag. Checked FIRST so the
 // stale/comm-gap warn and the peer-low verdict can't drag it into red. Live
 // power (when present) still shows via perfBlock so it doesn't read as dead.
 if(inv && inv.no_energy_register)
 return { key:"nometer", word:"No energy data", tone:"info",
 title:"This inverter reports live power but no cumulative energy, a metering issue at the vendor, not an outage. Its output can't be peer-graded until the energy register is fixed." };
 const lv = liveVerdict(inv, peers, isDaylight);
 // HEALTH fault only (14-day peer / fault / comm_gap). Word = Error.
 // Live-only shortfalls use their own words so we never pair "Error" with a
 // healthy "Pulling its weight" diagnosis (inconsistent facts bug).
 if(statusCls === "bad" || statusCls === "warn")
 return { key:"error", word:"Error", tone:"bad",
 title: inv.diagnosis || "Flagged, producing less than it should." };
 // Live shortfall while 14d health is OK — honest NOW labels, not Error.
 if(lv === "low")
 return { key:"low", word:"Low vs peers", tone:"warn",
 title:"Producing well below its sibling inverters right now, even though its 14-day health looks fine." };
 if(lv === "dark")
 return { key:"dark", word:"Not producing", tone:"warn",
 title:"Dark right now while sibling inverters are producing. 14-day health may still look fine." };
 // SLEEPING: sun-down rest (never an alarm).
 if(sleeping) return { key:"sleeping", word:"Sleeping", tone:"sleep",
 title:"Resting, the sun is down." };
 // PRODUCING: a real live reading above the floor.
 if(outputState(inv, "ok").reporting)
 return { key:"producing", word:"Producing", tone:"ok", title:"Making power now." };
 // NO LIVE FEED (calm, NOT an alarm, audit #4): a healthy inverter whose vendor
 // exposes no per-inverter instantaneous power (Fronius/SMA report site-level only),
 // so current_power_w is null, yet its 14-day status is ok and/or it produced today.
 // That's a missing live FEED, not an outage; never paint it red "Offline" (tone
 // "info" also keeps it out of the bad cardTone tint, which keys off key error/offline).
 if(liveReadingMissing(inv) && (statusCls === "ok" || (todayKwh(inv) || 0) > 0))
 return { key:"nofeed", word:"No live feed", tone:"info",
 title:"No per-inverter live signal from this vendor, it's producing; output shows at the array level." };
 // OFFLINE: a usable live reading exists but it's dark/not producing in daylight
 // (genuinely making nothing right now), or no signal where there should be one.
 return { key:"offline", word:"Offline", tone:"bad",
 title:"No live signal from this inverter right now." };
 }

 // Instantaneous capacity factor = current W / nameplate W (estimated nameplate
 // when the vendor gives none). The building block for the peer-relative %.
 function liveCapFactor(i){
 const npW = (i.nameplate_kw != null) ? i.nameplate_kw * 1000 : estNameplateW(i);
 const w = i.current_power_w;
 if(npW == null || npW <= 0 || w == null) return null;
 return w / npW;
 }
 // PEER-RELATIVE LIVE PERFORMANCE, the honest "vs the platonic ideal" number.
 // There is no irradiance/clear-sky model, so the ideal is the COHORT: this
 // inverter's capacity factor vs its siblings' MEDIAN capacity factor, RIGHT NOW.
 // Peers share the same sky + instant, so weather and time-of-day cancel out —
 // what's left is the real, controllable loss (soiling, shade, a failing string).
 // kind:"peer" → 100% = pulling its fair share; <100% = unexplained real loss.
 // kind:"solo" → no producing sibling to compare against → fall back to raw
 // capacity factor of rated max, labelled (NEVER passed
 // off as weather-adjusted).
 function peerPerf(inv, peers){
 const me = liveCapFactor(inv);
 if(me == null) return null;
 const others = peers
 .filter(p => p.inverter_id !== inv.inverter_id)
 .map(liveCapFactor).filter(v => v != null && v > 0.02);
 if(!others.length) return { kind:"solo", pct: Math.round(Math.max(0, Math.min(150, me*100))) };
 others.sort((a, b) => a - b);
 const med = others[Math.floor(others.length/2)];
 if(med <= 0) return { kind:"solo", pct: Math.round(Math.max(0, Math.min(150, me*100))) };
 return { kind:"peer", pct: Math.round((me/med)*100), cohort: others.length };
 }
 // The big headline block under the state chip: the % (peer-relative) + production.
 // Only a PRODUCING inverter shows a %; the other states show an honest one-liner.
 function perfBlock(inv, peers, st){
 const curW = inv.current_power_w;
 const curKw = curW != null ? (curW/1000) : null;
 // audit #5: Fronius/SMA/Chint per-inverter power is a site-level split (an estimate).
 const _allocP = curKw != null && (inv.vendor === "fronius" || inv.vendor === "sma" || inv.vendor === "chint");
 const _allocTip = _allocP ? ` title="${esc(BRAND[inv.vendor]||inv.vendor)} reports one site-level power, split across inverters by today's energy share, so this per-inverter kW is an estimate."` : "";
 const nowKw = curKw != null ? `${_allocP?"~":""}${curKw.toFixed(1)} kW now` : "";
 if(st.key === "producing"){
 // Headline = live output as a % of the inverter's MAX possible production
 // (capacity factor = current ÷ rated nameplate, with an estimated max when
 // the vendor reports none). A genuine laggard is already flagged at the
 // STATE level ("error"), so a producing inverter keeps the calm OK tone —
 // a low % here just means low sun, never a fault.
 const npW = (inv.nameplate_kw != null) ? inv.nameplate_kw * 1000 : estNameplateW(inv);
 const cf = (npW && npW > 0 && curW != null) ? curW / npW : null;
 if(cf != null){
 const pct = Math.round(Math.max(0, Math.min(100, cf * 100)));
 const maxKw = npW / 1000;
 const est = inv.nameplate_kw == null;
 const maxStr = (maxKw % 1) ? maxKw.toFixed(1) : String(maxKw);
 const sub = est ? `of its ~${maxKw.toFixed(1)} kW est. max` : `of its ${maxStr} kW max`;
 return `<div class="sb-perf ok">
 <div class="sb-perf-main"><b class="sb-perf-pct">${pct}<span class="sb-perf-sym">%</span></b><span class="sb-perf-unit">of max</span></div>
 ${nowKw?`<div class="sb-perf-prod"${_allocTip}>${nowKw}</div>`:""}
 <div class="sb-perf-sub"${est?' title="Rated max estimated from peak production, this vendor reports no nameplate."':''}>${esc(sub)}</div>
 <div class="sb-ob-track"><div class="sb-ob-fill" style="width:${pct}%"></div></div>
 </div>`;
 }
 return `<div class="sb-perf ok"><div class="sb-perf-main"><b class="sb-perf-pct"${_allocTip}>${curKw!=null?(_allocP?"~":"")+curKw.toFixed(1):"—"}</b><span class="sb-perf-unit">kW now</span></div></div>`;
 }
 // NO ENERGY DATA: show the live power we DO have (so it never reads as dead)
 // plus the honest reason there's no %, the energy register isn't reporting.
 if(st.key === "nometer"){
 const line = nowKw ? `${nowKw} · no energy total` : "no energy total from this inverter";
 return `<div class="sb-perf info"><div class="sb-perf-sub sb-perf-sub--lone" title="The vendor reports this inverter's live power but not its cumulative energy, a metering issue to fix at the source.">${esc(line)}</div></div>`;
 }
 // Non-producing states: an honest line, no %.
 const tk = liveReadingMissing(inv) ? todayKwh(inv) : null;
 let sub;
 if(st.key === "sleeping") sub = (tk != null && tk > 0) ? `${tk.toFixed(1)} kWh produced today` : "resting until sunrise";
 else if(st.key === "low") sub = nowKw ? `${nowKw} · lagging peers` : "lagging siblings right now";
 else if(st.key === "dark") sub = nowKw ? `${nowKw} · peers still produce` : "peers are producing; this unit is dark";
 else if(st.key === "error"){
 // Never show a healthy 14d diagnosis under Error (contradiction Bruce hit).
 const diag = String(inv.diagnosis || "");
 const healthyDiag = /\bpulling its weight\b|\ball good\b|\bhealthy\b|\bok\b/i.test(diag);
 sub = (!healthyDiag && diag) ? diag
 : (nowKw ? `only ${nowKw}` : "producing less than it should");
 }
 else sub = liveReadingMissing(inv) ? (tk != null && tk > 0 ? `${tk.toFixed(1)} kWh today · no live feed` : "no live feed from this inverter") : "no live signal right now";
 return `<div class="sb-perf ${st.tone}"><div class="sb-perf-sub sb-perf-sub--lone">${esc(sub)}</div></div>`;
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

 // per-inverter vendor badge (smaller variant of the array brand chip), empty if unknown
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
 // production level, its live output as a % of combined capacity. Tone stays
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
 if(!anyMax) return { reporting:true, pct:null, tone:(healthTone==="ok"?"ok":pctTone(50)), curW, maxW:null, estimated:false };
 const pct = Math.max(0, Math.min(100, Math.round((curW / maxW) * 100)));
 const tone = (healthTone === "ok") ? "ok" : pctTone(pct);
 return { reporting:true, pct, tone, curW, maxW, estimated };
 }

 // The array's NOW chip state (its liveness axis), mirrors liveState but for the
 // whole array. Producing when the array makes power; Asleep at night with zero
 // output; "Not producing" (amber) ONLY when daylight + zero AND the 14-day
 // health (shared arrayHealth classifier) already sees trouble, never an
 // independent cloud false-alarm; otherwise a calm "Idle".
 function arrayLiveState(col, os, healthTone, liveAnoms){
 const sleeping = (col.is_daylight === false) && !os.reporting;
 if(sleeping) return { key:"asleep", label:"Asleep", tone:"sleep" };
 if(os.reporting) return { key:"producing", label:"Producing", tone:"ok" };
 if(col.is_daylight === false)
 return { key:"idle", label:"Idle", tone:"idle", title:"The sun is down, the array is resting." };
 // PRODUCED-TODAY guard (the live-feed whack-a-mole fix): the instantaneous
 // live reading is ~0 or absent, but the array's OWN daily history shows it
 // generated energy today. That's a flaky/late live feed, NOT a dead array —
 // so don't paint it "Not producing". Show it produced today (calm green) and
 // let the live number catch up. Server-computed col.produced_today_kwh is the
 // billing basis (independent of the jittery instantaneous feed).
 if(col.produced_today_kwh != null && col.produced_today_kwh > 0)
 return { key:"produced_today", label:"Produced today", tone:"ok",
 title:`Generated ${(+col.produced_today_kwh).toFixed(1)} kWh today, the live feed is updating.` };
 if(healthTone !== "ok" || liveAnoms > 0)
 return { key:"dark", label:"Not producing", tone:"warn",
 title:"This array isn't producing while the sun is up." };
 return { key:"idle", label:"Idle", tone:"idle",
 title:"Not producing right now, but nothing looks wrong." };
 }

 // Array output bar, mirrors outputBar(), but the % is the array's AVERAGE
 // production level (combined current ÷ combined rated max). Carries the same
 // data-curw/data-maxw so the live ticker breathes it in place like an inverter.
 function arrayOutputBar(os, col){
 const fmt = v => v >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
 const curKw = os.curW != null ? os.curW / 1000 : null;
 const maxKw = os.maxW != null ? os.maxW / 1000 : null;
 let label;
 if(!os.reporting){
 // Live≈0 but the array generated energy today (flaky/late live feed) →
 // surface today's REAL kWh instead of a misleading "not producing".
 const tk = col && col.produced_today_kwh;
 if(tk != null && tk > 0){
 label = `<b class="sb-ob-pct">${(+tk).toFixed(1)} kWh</b><span class="sb-ob-of">produced today · live feed updating</span>`;
 } else {
 label = `<span class="sb-ob-idle">array not producing right now</span>`;
 }
 } else if(os.pct != null){
 const ofTxt = os.estimated
 ? `<span title="No rated nameplate from this vendor, combined max estimated from peak production.">of ~est · <b class="sb-ob-cur">${fmt(curKw)}</b>/~${fmt(maxKw)} kW</span>`
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

 // Array liquid-fill layer, the SAME energy-as-liquid metaphor as the inverter
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
 // Cache the parsed ARRAY (the expensive part); build a FRESH Set per call so
 // callers can freely mutate their copy then saveExpandedSet() without poisoning
 // the cache.
 const ids = _lsReadJSON(EXPAND_KEY, raw => {
 const a = raw == null ? [] : JSON.parse(raw);
 return Array.isArray(a) ? a.map(String) : [];
 });
 return new Set(ids);
 }
 function hasExpandPref(){
 try { return localStorage.getItem(EXPAND_KEY) != null; } catch(e){ return false; }
 }
 function saveExpandedSet(set){
 try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...set])); _lsInvalidate(EXPAND_KEY); } catch(e){}
 }

 // ---- sandbox orientation (vertical = arrays side-by-side, inverters drop BELOW
 // each array; horizontal = arrays stacked on the LEFT, inverters spread out to
 // the RIGHT of their array). Persisted under ORIENT_KEY; DEFAULT horizontal. ----
 function getOrient(){
 // Orientation is LOCKED to horizontal, arrays in a column on the LEFT, each
 // array's inverters spreading to the RIGHT. The layout toggle was removed
 // (Ford's ask: one canonical view), so this no longer reads ORIENT_KEY, a
 // previously-persisted "vertical" can't strand an owner in a view they can no
 // longer switch out of.
 return "horizontal";
 }
 function setOrient(o){
 try { localStorage.setItem(ORIENT_KEY, o === "horizontal" ? "horizontal" : "vertical"); } catch(e){}
 }

 // ---- DATA-STREAM selector (Ford's dad's ask): the sandbox INTEGRATES vendor +
 // utility data, but the slider lets the owner VIEW one source stream at a time.
 // "vendor" → inverter telemetry (SolarEdge/Fronius/SMA/CHINT/extension). The
 // per-inverter comb + the array graph show vendor production.
 // "utility" → the utility meter's settled generation (GMP). The array graph
 // shows the meter stream; the inverter comb (a vendor-only concept)
 // collapses. Persisted under STREAM_KEY; DEFAULT vendor. ----
 const STREAM_KEY = "ao_sandbox_stream";
 function getStream(){
 // The Vendor/Utility data-source slider was removed (Ford's ask), the sandbox
 // shows the integrated fleet, so the stream is LOCKED to "vendor": inverter
 // combs stay visible and a previously-persisted "utility" can't strand an owner
 // in the meter-only view they could no longer switch out of.
 return "vendor";
 }
 function setStream(s){
 try { localStorage.setItem(STREAM_KEY, s === "utility" ? "utility" : "vendor"); } catch(e){}
 }

 // Each array belongs to EXACTLY ONE section, by where its data comes from:
 // • VENDOR , data from inverter telemetry (SolarEdge/Fronius/SMA/Chint/…):
 // the array has inverters / a vendor on it / a vendor daily stream.
 // • UTILITY, data from the utility meter (GMP/VEC/SmartHub): a utility daily
 // stream and NO inverter/vendor source.
 // Strict + mutually exclusive: a vendor-sourced array shows ONLY in the vendor
 // view, a utility-sourced array shows ONLY in the utility view. No array appears
 // in both, and there is no "show everything" fallback.
 function arrayStream(col){
 const ds = col.daily_split || {};
 const hasVendor =
 !!ds.has_vendor ||
 !!col.vendor ||
 (Array.isArray(col.vendors) && col.vendors.length > 0) ||
 (Array.isArray(col.inverters) && col.inverters.length > 0);
 if(hasVendor) return "vendor";
 if(ds.has_utility) return "utility";
 // No classified source at all → treat as utility (meter-only arrays that
 // haven't synced a daily row yet have no inverters, so they're not vendor).
 return "utility";
 }
 function filterColsByStream(cols){
 // The sandbox is LOCKED to the vendor stream (getStream), the integrated INVERTER
 // fleet. Show only vendor-sourced arrays (inverters / a vendor / a vendor daily
 // stream); utility-meter-only arrays (GMP/VEC/SmartHub with NO inverters) belong in
 // the offtaker/NEPOOL views, not the Inverter Dashboard. arrayStream() does the
 // strict classification and the empty-state hint below already assumes this filter.
 // (Regression fix: this had become a `return cols` pass-through, which leaked GMP
 // utility-only arrays in the moment the GMP bill-pull started creating Array rows.)
 const stream = getStream();
 return cols.filter(c => arrayStream(c) === stream);
 }

 // ---- view mode: "grid" (fleet OVERVIEW, health-tinted tile per array) vs
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
 // Marketing demo fleet is "cloud capture", no "Open portal to sync" CTAs.
 function isDemoSim(){
 try { return !!(window.FleetStore && FleetStore.isSimulated && FleetStore.isSimulated()); }
 catch(_){ return false; }
 }
 function originLinksHTML(col){
 if(isDemoSim()) return ""; // cloud-capture demo: no portal-open prompts
 const links = originLinks(col);
 if(!links.length) return "";
 const rows = links.map(l => {
 const label = l.label || BRAND[l.vendor] || l.vendor || "portal";
 return `<a class="sb-origin" data-portal="${esc(l.vendor||"")}" href="${esc(l.url)}" target="_blank" rel="noopener">Open in ${esc(label)} ↗</a>`;
 }).join("");
 return `<div class="sb-origins">${rows}</div>`;
 }
 // Single merged brand pill for a single-vendor array: a vendor-COLORED pill that
 // is ITSELF the portal link ("Open in SolarEdge ↗") when a URL resolves, else a
 // plain non-clickable brand pill. Returns "" when col has no single vendor.
 // Demo: always a plain brand chip + cloud-capture note (no open-to-sync).
 function brandLinkHTML(col){
 if(!col.vendor) return "";
 const v = col.vendor;
 const label = BRAND[v] || v;
 if(isDemoSim()){
 return `<span class="sb-brand ${esc(v)}" title="Cloud capture keeps this feed fresh in the demo">${esc(label)}</span>` +
 `<span class="sb-cloud-cap" title="Server-side cloud capture, no portal open required">☁ Auto-refresh</span>`;
 }
 const links = originLinks(col);
 const url = links.length ? links[0].url : "";
 if(url){
 return `<a class="sb-brand sb-brandlink ${esc(v)}" data-portal="${esc(v)}" href="${esc(url)}" target="_blank" rel="noopener">Open in ${esc(label)} ↗</a>`;
 }
 return `<span class="sb-brand ${esc(v)}">${esc(label)}</span>`;
 }
 // refresh the "N inverters" count on a column from its live card count
 function updateColCount(col){
 const n = col.querySelectorAll(".sb-teeth .sb-inv").length;
 const c = col.querySelector(".sb-array-count");
 if(c) c.textContent = `${n} inverter${n===1?'':'s'}`;
 }

 // Footer is empty by default (tip removed, the section subtitle already explains dragging).
 // The #sbFoot element is reused to show a clicked inverter's diagnosis and the "Saving…" note;
 // when empty it collapses via `.sb-foot:empty { display:none }`.
 const DEFAULT_FOOT_HTML = "";
 function setDefaultFoot(){
 const foot = document.getElementById("sbFoot");
 if(foot) foot.innerHTML = DEFAULT_FOOT_HTML;
 }

 // ── First-visit live reveal ────────────────────────────────────────────────
 // Arriving from onboarding (?fresh=1), a just-connected owner's arrays may still
 // be landing via async extension capture. Instead of the static empty invite,
 // show a "watching" state and ACCELERATE the refetch (~every 3s for ~60s) so the
 // arrays appear within seconds, then animate them in, the payoff is watching your
 // own fleet populate, not a punchlist. Backed by the real FleetStore.refetch.
 const FRESH_KEY = "ao_fresh_until";
 function freshWindowActive(){
 try{
 let until = Number(sessionStorage.getItem(FRESH_KEY) || 0);
 if((!until || Date.now() >= until) && new URLSearchParams(location.search).get("fresh") === "1"){
 until = Date.now() + 75000; // a fresh arrival (re)opens the 75s window
 sessionStorage.setItem(FRESH_KEY, String(until));
 }
 return !!until && Date.now() < until;
 }catch(e){ return false; }
 }
 function ensureRevealStyle(){
 if(document.getElementById("sbRevealStyle")) return;
 const st = document.createElement("style");
 st.id = "sbRevealStyle";
 st.textContent =
 "@keyframes sbArrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
 "#sandbox.sb-arrive .sb-col{animation:sbArrive .5s cubic-bezier(.22,1,.36,1) both}" +
 "@media (prefers-reduced-motion:reduce){#sandbox.sb-arrive .sb-col{animation:none}}";
 document.head.appendChild(st);
 }
 function revealArrays(){
 const host = document.getElementById("sandbox");
 if(!host) return;
 ensureRevealStyle();
 host.classList.add("sb-arrive");
 // Stagger the columns' arrival. Snapshot the NodeList once and apply all the
 // animation-delay writes inside a single requestAnimationFrame so the browser
 // coalesces them into one layout/paint instead of thrashing a reflow per column
 // (which mattered at ~100 columns). Same cleanup batching for the reset.
 const cols = host.querySelectorAll(".sb-col");
 requestAnimationFrame(() => {
 cols.forEach((c, i) => { c.style.animationDelay = Math.min(i * 0.07, 0.42) + "s"; });
 });
 setTimeout(() => {
 host.classList.remove("sb-arrive");
 cols.forEach(c => { c.style.animationDelay = ""; });
 }, 1400);
 }
 let _freshPollOn = false;
 let _revealedFresh = false; // one-shot: animate the fleet in once per fresh window
 function startFreshPoll(){
 if(_freshPollOn) return;
 if(!(window.FleetStore && FleetStore.refetch && FleetStore.focusColumns)) return;
 _freshPollOn = true;
 let tries = 0;
 const tick = () => {
 if(tries++ > 20 || !freshWindowActive()){ _freshPollOn = false; return; }
 Promise.resolve(FleetStore.refetch()).then(() => {
 const cols = (FleetStore.focusColumns().columns) || [];
 if(cols.length){
 _freshPollOn = false;
 renderFromStore(); // populated render fires the one-shot reveal itself
 return;
 }
 setTimeout(tick, 3000);
 }).catch(() => setTimeout(tick, 3000));
 };
 setTimeout(tick, 2500);
 }

 function render(tree){
 const host = document.getElementById("sandbox");
 if(!host) return;
 const allCols = applyOrder(tree.columns || []);
 const cols = filterColsByStream(allCols);
 if(!cols.length){
 // Distinguish "no arrays at all" from "this source section is empty but the
 // other has arrays", so the toggle stays visible and the message is honest.
 const stream = getStream();
 const other = stream === "vendor" ? "utility" : "vendor";
 const otherCount = allCols.filter(c => arrayStream(c) === other).length;
 if(allCols.length && otherCount){
 const here = stream === "vendor" ? "Vendor data" : "Utility data";
 const there = other === "vendor" ? "Vendor data" : "Utility data";
 host.innerHTML =
 `<div class="sb-head">
 <div class="sb-head-left"><div class="sb-streamtoggle" role="group" aria-label="Data source stream" title="Each array shows only in the section matching its data source.">
 <span class="sb-stream-cap">Showing</span>
 <button class="sb-stream-seg ${stream==="vendor"?"on":""}" id="sbStreamVendor" type="button" aria-pressed="${stream==="vendor"}">Vendor data</button>
 <button class="sb-stream-seg ${stream==="utility"?"on":""}" id="sbStreamUtility" type="button" aria-pressed="${stream==="utility"}">Utility data</button>
 </div></div>
 </div>
 <div class="sb-empty">No arrays get their data from a ${esc(here.toLowerCase().replace(" data",""))} source. ` +
 `${otherCount} array${otherCount===1?" is":"s are"} under <b>${esc(there)}</b>, switch above to see ${otherCount===1?"it":"them"}.</div>`;
 wireStreamToggle(host);
 renderCards();
 return;
 }
 const _head =
 `<div class="sb-head"><div>
 <div class="sb-tiers"><span class="sb-tier-tag b">Your fleet</span></div>
 <div class="sb-sub">${freshWindowActive() ? "Watching for your arrays…" : "Your live fleet tree is ready for its first array."}</div>
 </div>
 <div class="sb-head-actions"><div class="sb-head-btns">
 <button class="sb-resetbtn" id="sbNewArray" type="button" title="Create an empty array to drag inverters into">New empty array</button>
 <button class="sb-addbtn" id="sbAddArray">+ Add array</button>
 </div></div></div>`;
 // Any mid-connect inverter vendor → blue Connecting… cards (all vendors, not just Chint).
 // Soft-update if cards already painted, remounting every fleet poll made them glitch.
 let _pending = [];
 try {
 _pending = (window.__aoPendingFeeds && window.__aoPendingFeeds.list()) || [];
 } catch(e){ _pending = []; }
 if(_pending.length || freshWindowActive()){
 const sig = _pending.map(p => p.vendor).sort().join("|");
 const existing = host.querySelectorAll("[data-pending-vendor]");
 let softOk = false;
 if(_pending.length && existing.length === _pending.length){
 softOk = true;
 for(let i = 0; i < _pending.length; i++){
 if(existing[i].getAttribute("data-pending-vendor") !== _pending[i].vendor){ softOk = false; break; }
 }
 }
 if(softOk && host.querySelector(".sb-head")){
 _pending.forEach((p, i) => {
 const ageSec = Math.max(0, Math.round((Date.now() - (p.at || Date.now())) / 1000));
 const wait = ageSec < 20 ? "usually under a minute" : ageSec < 75 ? "still syncing…" : "almost there, large fleets can take a minute";
 const w = existing[i].querySelector("[data-pending-wait]");
 if(w && w.textContent !== wait) w.textContent = wait;
 existing[i].classList.remove("is-enter");
 });
 if(freshWindowActive()) startFreshPoll();
 try { if(window.__aoPendingFeeds && window.__aoPendingFeeds.startPoll) window.__aoPendingFeeds.startPoll(); } catch(e){}
 return;
 }
 const cards = _pending.length
 ? _pending.map(p => {
 const label = esc(p.label || p.vendor || "Vendor");
 const ageSec = Math.max(0, Math.round((Date.now() - (p.at || Date.now())) / 1000));
 const wait = ageSec < 20 ? "usually under a minute" : ageSec < 75 ? "still syncing…" : "almost there, large fleets can take a minute";
 return `<div class="vs-pending is-enter" data-pending-vendor="${esc(p.vendor)}">
 <div class="vs-pending-head">
 <span class="vs-pending-badge">${label}</span>
 <span class="vs-pending-pulse" aria-hidden="true"></span>
 <span class="vs-pending-stat">Connecting…</span>
 </div>
 <div class="vs-pending-body">
 <div class="vs-pending-skel"></div>
 <div class="vs-pending-skel vs-pending-skel-short"></div>
 <p class="vs-pending-copy">We got your <b>${label}</b> sign-in, arrays are landing on your account now (<span data-pending-wait>${esc(wait)}</span>). This page updates automatically.</p>
 </div>
 </div>`;
 }).join("")
 : `<div class="sb-empty"><span class="sb-spin"></span> Finishing the connection, sign into your monitoring portal in the other tab and your arrays appear here on their own, no refresh.</div>`;
 host.innerHTML = _head + cards;
 requestAnimationFrame(() => {
 host.querySelectorAll(".vs-pending.is-enter").forEach(el => el.classList.remove("is-enter"));
 });
 wireAddButton(host);
 wireNewArrayButton(host);
 wireCardButton(host);
 renderCards();
 if(freshWindowActive()) startFreshPoll();
 try {
 if(window.__aoPendingFeeds && window.__aoPendingFeeds.startPoll) window.__aoPendingFeeds.startPoll();
 } catch(e){}
 return;
 }
 host.innerHTML = _head +
 `<div class="sb-empty">Connect your first inverter or utility and it lands here on its own, live, per-inverter, in dollars. No spreadsheets, no refresh. Hit <b>+ Add array</b> to start.</div>`;
 wireAddButton(host);
 wireNewArrayButton(host);
 wireCardButton(host); // "+ Card" menu (Note / Data)
 renderCards(); // fixed cards still show; free cards need a canvas (appear once arrays exist)
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
 title="This is a data outage at the source (${esc(String(vlabel))}), not in Array Operator. The time below is when ${esc(String(vlabel))}'s INVERTER monitoring last reported, your utility's meter clock (e.g. GMP) tracks a different feed and may differ. We'll show live data again as soon as ${esc(String(vlabel))} resumes reporting.">
 <span class="sb-srcout-ic" aria-hidden="true">⚠</span>
 <span class="sb-srcout-txt"><b>${esc(String(vlabel))} inverter monitoring last reported${ageTxt}.</b>
 This is a data outage at the source, not Array Operator. (This is the inverter feed; your utility meter, e.g. GMP, tracks separately and may show a different time.) Live data resumes automatically when ${esc(String(vlabel))} reconnects.</span>
 </div>`;
 }

 // Auto-login hint: a subtle inline banner on extension-captured array cards
 // when the owner hasn't saved vault credentials yet. Async-filled by
 // wireAutoLoginHints() after the canvas renders.
 //
 // GAP-AWARE escalation: Fronius/SMA/Chint only sync when the owner opens the
 // portal (or an auto-login background tab fires). If creds aren't saved AND this
 // array's last capture is already stale (a real coverage gap → undercounting),
 // we upgrade the generic "save your login" nudge to name the gap directly. The
 // gap is read from the SAME source_status the freshness chip uses, so the two
 // surfaces agree. data-gap-age carries the stale age (empty = fresh, no gap).
 const _EXT_VAULT_VENDORS = new Set(["fronius","sma","chint"]);
 function autoLoginHintHTML(vendor, col){
 if(!vendor || !_EXT_VAULT_VENDORS.has(vendor)) return "";
 const ss = col && col.source_status;
 const age = ss ? ss.age_hours : null;
 // Only count it as a "gap" once we're past the live-fresh window (same gate as
 // freshnessHTML), a fresh array isn't undercounting and needs no urgency.
 const gapAge = (age != null && age > _LIVE_FRESH_H) ? fmtAge(age) : "";
 return `<div class="sb-autologin-hint" data-vendor="${esc(vendor)}" data-gap-age="${esc(gapAge)}" aria-live="polite"></div>`;
 }

 // Capture-freshness line for EXTENSION-captured array cards (Fronius/SMA/Chint).
 // These have NO server feed, their data is only as fresh as our last successful
 // scrape (an owner portal login or a background-tab refresh). So we say it plainly:
 // when our newest capture is older than the live window, show "Last synced Xh ago"
 // with a reconnect nudge instead of letting a frozen reading imply real-time data
 // (the West Chester bug). When fresh (≤ the window) we show nothing, the live kW
 // speaks for itself. The action is the existing vendor portal link at the card
 // foot (no separate mechanism). Polled vendors (SolarEdge) keep sourceStatusHTML's
 // amber source-outage banner; this is only the ext-capture story. (Ford.)
 const _LIVE_FRESH_H = 15 / 60; // 15 min, matches the backend _POWER_LIVE_FRESH gate
 function freshnessHTML(col){
 const vs = col && col.vendor ? [col.vendor]
 : (col && Array.isArray(col.vendors) ? col.vendors : []);
 // Demo: always show cloud-capture chip (no open-portal-to-sync story).
 if(isDemoSim() && vs.length){
 const vendor = vs[0];
 const { cls, html } = freshInner(vendor, "live");
 return `<div class="sb-fresh ${cls}" role="status" data-fresh-vendor="${esc(String(vendor))}" data-fresh-age="live"
 title="Demo fleet uses cloud capture, feeds stay fresh without opening a vendor portal.">${html}</div>`;
 }
 // Show for extension-captured (syncable) AND polled (SolarEdge) vendors, the
 // latter so an aging polled reading (15min–6h) gets an honest "Updated Xh ago"
 // instead of reading as live (audit #6).
 if(!vs.length || !vs.every(v => _SYNCABLE_VENDORS.has(v) || _POLLED_VENDORS.has(v))) return "";
 const ss = col && col.source_status;
 const age = ss ? ss.age_hours : null;
 if(age == null || age <= _LIVE_FRESH_H) return ""; // never captured, or live, say nothing
 const vendor = vs[0];
 const vlabel = BRAND[vendor] || vendor;
 const ageStr = fmtAge(age);
 const { cls, html } = freshInner(vendor, ageStr);
 const titleTxt = _SYNCABLE_VENDORS.has(vendor)
 ? `No live server feed for ${vlabel}, its data is only as fresh as the last sync. Click sync to pull the latest now.`
 : `${vlabel} is polled on our side, this is how fresh the reading is; it refreshes automatically.`;
 return `<div class="sb-fresh ${cls}" role="status" data-fresh-vendor="${esc(String(vendor))}" data-fresh-age="${esc(String(ageStr))}"
 title="${esc(titleTxt)}">${html}</div>`;
 }

 const expanded = getExpandedSet(); // which arrays have their inverter comb open
 // First login (fresh from onboarding) OR a never-customized fleet → open every
 // inverter comb so the new owner sees their WHOLE fleet at once. freshWindowActive()
 // wins over a stale ao_array_expanded pref (set by any prior collapse in this
 // browser) so a just-onboarded owner always lands on the full, expanded view.
 const expandAllDefault = freshWindowActive() || !hasExpandPref();
 const columns = cols.map(col => {
 const isOpen = expandAllDefault || expanded.has(String(col.array_id));
 const invs = col.inverters || [];
 // tier-2 chip:
 // - single vendor → ONE merged, vendor-colored, clickable brand pill that
 // is itself the portal link ("Open in SolarEdge ↗"); see brandLinkHTML.
 // - mixed vendors → a "mixed · …" chip (origin link(s) render beneath it).
 let brandChip = "";
 if(col.vendor){
 brandChip = brandLinkHTML(col);
 } else if(Array.isArray(col.vendors) && col.vendors.length){
 const labels = col.vendors.map(v => BRAND[v] || v).join(" · ");
 brandChip = `<span class="sb-brand mixed" title="${esc(labels)}">mixed · ${esc(labels)}</span>`;
 }

 // bottom comb, one card per inverter (each individually drag-movable).
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
 // output tone drives the bar AND the whole-card tint, see outputState():
 // a near-zero live reading (evening/night) is idle (no alarm), and the
 // orange tint only fires when health is already flagged.
 const obTone = outputState(inv, sCls).tone;
 const liqSt = liquidState(inv, sCls, col.is_daylight);
 const sleeping = liqSt === "sleep";
 // The card's two axes, kept SEPARATE and explicitly labelled:
 // • HEALTH badge, purely the 14-day peer verdict (inv.status). It no
 // longer second-guesses the live reading; that was the source of the
 // "All good on a dark inverter" contradiction.
 // • NOW chip, the instantaneous liveness state (liveState), peer-checked.
 // ── ONE honest state word (Ford's redesign): the live NOW chip + the
 // 14-day HEALTH badge collapse into a SINGLE four-state label —
 // producing / error / sleeping / offline. The vendor badge is gone from
 // the inverter card (it stays on the array card).
 const st4 = fourState(inv, sortedInvs, col.is_daylight, sCls, sleeping);
 const stateChip = `<div class="sb-state ${st4.tone}"${st4.title?` title="${esc(st4.title)}"`:""}><span class="sb-now-dot"></span>${esc(st4.word)}</div>`;
 // Whole-card tint: error/offline → red; no-energy-data stays calm info
 // (a metering defect must not tint the card red even if its low live split
 // makes obTone bad); otherwise the calm live output tone.
 const cardTone = (st4.key === "error" || st4.key === "offline") ? "bad"
 : (st4.key === "low" || st4.key === "dark") ? "warn"
 : st4.key === "nometer" ? "info" : obTone;
 // Cards are FIRM in place, not draggable until the owner picks "Move" from
 // the right-click menu (which sets draggable + .sb-movable). Re-locks on drop.
 return `
 <div class="sb-inv ${sCls}${sleeping?' sleep':''} st-${st4.key}" tabindex="0" data-tone="${cardTone}"
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
 ${stateChip}
 ${perfBlock(inv, sortedInvs, st4)}
 </div>
 </div>`;
 }).join("")
 : `<div class="sb-comb-empty">Empty array, drag inverters here</div>`;

 const n = col.inverter_count;
 const countLbl = `${n} inverter${n===1?'':'s'}`;

 // ── ARRAY CARD: the inverter card's bigger sibling, SAME construction ──
 // (liquid fill → frosted plate → name/size → production graph → NOW chip →
 // output bar → health badge → vendor link + weather), every signal being
 // the WHOLE ARRAY's aggregate. Two clocks kept separate: NOW = aggregate
 // live output; HEALTH = the 14-day verdict (shared arrayHealth classifier).
 const h = arrayHealth(col); // {tone,flagged,crit,total,liveAnoms,...}
 const aOs = arrayOutputState(invs, h.tone); // aggregate live output / capacity
 const aSleeping = (col.is_daylight === false) && !aOs.reporting;
 const aLs = arrayLiveState(col, aOs, h.tone, h.liveAnoms);
 const aNowChip = `<div class="sb-inv-now ${aLs.tone}"${aLs.title?` title="${esc(aLs.title)}"`:""}><span class="sb-now-dot"></span>${esc(aLs.label)}</div>`;
 // Vendor-side outage wins the badge copy, never "All good" / "N to check"
 // when the monitoring portal is the thing that's broken (Ford 2026-07-13).
 const aHealthLabel = h.vendorOut ? "Vendor issue"
 : h.tone === "ok" ? "All good"
 : h.tone === "bad" ? `${h.crit||h.flagged} down`
 : `${h.flagged} to check`;
 const aHealthTitle = h.vendorOut
 ? "The monitoring vendor has stopped reporting live data for this site, not an inverter fault. See the source banner above."
 : `Array health over the last 14 days (${h.flagged} of ${h.total} inverter${h.total===1?'':'s'} flagged).`;
 const aHealthBadge = `<div class="sb-inv-alert ${h.tone}" title="${esc(aHealthTitle)}">${esc(aHealthLabel)}</div>`;
 // total rated size pill (sum of inverter nameplates), like the inverter's kW pill
 const totNp = invs.reduce((t,i)=> t + (i.nameplate_kw||0), 0);
 const sizePill = totNp > 0 ? `<span class="sb-inv-size">${totNp>=100?Math.round(totNp):(Math.round(totNp*10)/10)} kW</span>` : "";
 // the whole-card tint mirrors the inverter card: amber on a live anomaly the
 // 14-day health hasn't caught yet, else the calm aggregate output tone.
 const aCardTone = (h.tone === "ok" && aLs.key === "dark") ? "warn" : aOs.tone;
 // Source-data freshness banner: when the VENDOR portal (e.g. SolarEdge)
 // stopped receiving data from this site, say so plainly, it's a source-
 // side outage, not our system. Renders nothing when data is fresh.
 const srcStatusBanner = sourceStatusHTML(col);
 // where the array's data comes from: a single clickable vendor brand-link
 // when single-vendor, else the mixed chip + origin portal links beneath.
 const srcLinks = col.vendor ? brandLinkHTML(col) : (brandChip + originLinksHTML(col));

 return `
 <div class="sb-col${isOpen?' expanded':''}" data-array-id="${esc(col.array_id)}" data-vendor="${esc(col.vendor||"")}">
 <!-- ARRAY CARD, mirrors the inverter card's design, scaled to the array.
 Whole card is the expand affordance; the ⠿ grip reorders it. -->
 <div class="sb-array sb-array--card ${aSleeping?'sleep':''}${(col.source_status&&col.source_status.state==='stale')?' sb-array--srcout':''}" data-tone="${aCardTone}">
 <span class="sb-drag" draggable="true" role="button" title="Drag this grip to reorder the array">⠿</span>
 ${arrayLiquidLayer(col, aOs, h.tone)}
 <div class="sb-array-plate">
 <div class="sb-inv-top">
 <div class="sb-array-k">Array</div>
 ${sizePill}
 </div>
 <div class="sb-array-name">${esc(col.array_name)}${weatherBadge(col)}</div>
 ${srcStatusBanner}
 ${freshnessHTML(col)}
 ${autoLoginHintHTML(col.vendor||"", col)}
 ${arrayGraph(sortedInvs, col.daily, col, getStream())}
 ${aNowChip}
 ${arrayOutputBar(aOs, col)}
 ${aHealthBadge}
 <div class="sb-array-src">${srcLinks}</div>
 <button class="sb-inv-toggle" type="button" aria-expanded="${isOpen?'true':'false'}"
 title="Show or hide this array's inverters">
 <span class="sb-inv-toggle-chev" aria-hidden="true">▸</span>
 <span class="sb-array-count">${countLbl}</span>
 </button>
 </div>
 </div>

 <!-- Collapsible inverter comb, hidden until the array is expanded -->
 <div class="sb-comb">
 <div class="sb-teeth">${teeth}</div>
 </div>
 </div>`;
 }).join("");

 // Fleet-health card moved to the dedicated DASHBOARD tab (#fleetCommander lives in
 // panelDashboard now). The sandbox is purely the spatial fleet tree.
 const fleetCard = "";
 host.innerHTML = head + `<div class="sb-viewport"><div class="sb-canvas sb-orient-${getOrient()} sb-stream-${getStream()}">${fleetCard}${columns}</div></div>
 <div class="sb-foot" id="sbFoot">${DEFAULT_FOOT_HTML}</div>`;
 host.classList.remove("sb-mode-grid");
 // Fill the in-canvas fleet card (no-op if command-center hasn't loaded yet;
 // its own store subscription will fill it once the model is ready).
 try { if(window.__ccRender) window.__ccRender(); } catch(e){}
 wireAutoLoginHints().catch(()=>{}); // fill vault-not-set hints on extension-captured arrays

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

 // right-click an inverter card → "Delete inverter"; else an array card →
 // "Delete array". Inverter is checked FIRST because an .sb-inv lives inside an
 // .sb-col, so closest(".sb-col") would also match, we want the more specific
 // target to win. Both persist via FleetStore (optimistic + backend) and are undoable.
 host.addEventListener("contextmenu", e => {
 const invCard = e.target.closest && e.target.closest(".sb-inv");
 if(invCard && host.contains(invCard)){
 e.preventDefault();
 const invId = invCard.dataset.invId;
 const nameEl = invCard.querySelector(".sb-inv-name");
 const name = nameEl ? nameEl.textContent.trim()
 : (invCard.dataset.name || "this inverter");
 showInvCtxMenu(e.clientX, e.clientY, invId, name, invCard);
 return;
 }
 const col = e.target.closest && e.target.closest(".sb-col");
 if(!col || !host.contains(col)) return; // not on an array card → native menu
 e.preventDefault();
 const id = col.dataset.arrayId;
 const nameEl = col.querySelector(".sb-array-name");
 const name = nameEl ? nameEl.textContent.trim() : "this array";
 showArrayCtxMenu(e.clientX, e.clientY, id, name);
 });

 wireFullscreen(host);
 wireOrient(host);
 wireStreamToggle(host); // Vendor⇄Utility data-stream slider
 wireViewMode(host); // ⊞ Overview ↔ ⌗ Tree-view toggle
 wireShowAll(host); // ⊟ Show all arrays (visible only when drilled into a subset)
 wireAlerts(host); // 🔔 inverter email alert settings
 wireUndoRedo(host); // ↶ Undo / ↷ Redo for inverter moves (FleetStore history)
 wireExpandAll(host); // "Show all inverters", open/collapse every array's comb
 wireAddButton(host);
 wireNewArrayButton(host);
 wireResetButton(host);
 wireDrag(host); // whole-column reorder (drag the .sb-array node)
 wireInvDrag(host); // per-inverter reorder + cross-array move (PERSISTED to backend)
 wireInvToggle(host); // expand/collapse each array's inverter comb (persisted)
 migrateLocalRenames(); // one-time: push legacy localStorage renames to the backend, then drop them
 wireRenames(host); // click-to-edit array & inverter names (persisted to the backend via FleetStore)
 startLiveTicker(); // keep each card's "kW now" reading live
 wirePanZoom(host); // drag empty space to pan, wheel to zoom the fleet canvas
 wireCardButton(host); // "+ Card" menu (Note / Data)
 renderCards(); // recreate free + fixed owner cards from localStorage (idempotent)
 drawFleetConnectors(host); // SVG converging feeders → trunk → array (replaces the comb bus)
 refreshWeather(host); // live Open-Meteo pull for arrays with coords; synthetic otherwise
 // First-visit reveal: when a just-onboarded owner's fleet first paints, whether
 // the arrays were already present OR just arrived via the fast poll, animate the
 // (now expanded) columns in, exactly once per fresh window.
 if(freshWindowActive() && !_revealedFresh){ _revealedFresh = true; revealArrays(); }
 }

 // A tiny tile sparkline (no axis) of an array's summed daily production, tinted
 // by the array's worst health. Pure inline SVG, cheap to draw 100+ of.
 function tileSpark(col, tone){
 const stream = getStream();
 const split = col.daily_split || null;
 // Stream-aware: in utility mode draw the meter series; in vendor mode sum the
 // per-inverter daily (falling back to the vendor split for inverter-less arrays).
 let series = [];
 if(stream === "utility"){
 series = (split && Array.isArray(split.utility)) ? split.utility : [];
 } else {
 const invs = col.inverters || [];
 if(invs.length){
 const byDay = {}; const order = [];
 for(const inv of invs){
 for(const d of (inv.daily || [])){
 if(!(d.date in byDay)){ byDay[d.date] = 0; order.push(d.date); }
 byDay[d.date] += Math.max(0, +d.kwh || 0);
 }
 }
 series = order.map(dt => ({ date: dt, kwh: byDay[dt] }));
 }
 if(series.length < 2 && split && Array.isArray(split.vendor)) series = split.vendor;
 }
 const vals = series.map(d => Math.max(0, +d.kwh || 0));
 if(vals.length < 2) return "";
 const w = 100, h = 26, pad = 2;
 const max = Math.max(...vals, 0.001);
 // utility stream → blue; vendor stream → health-tinted as before.
 const fill = stream === "utility" ? "var(--util, #5b8def)"
 : tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--good)";
 const baseY = h - pad;
 const slot = (w - 2*pad) / vals.length;
 const gap = Math.min(1, slot * 0.2);
 const bw = Math.max(0.6, slot - gap);
 const bars = vals.map((v,i)=>{
 if(v === 0) return "";
 const x = pad + i*slot + gap/2;
 const bh = Math.max(0.6, (v/max)*(h-2*pad));
 return `<rect x="${x.toFixed(1)}" y="${(baseY-bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}"/>`;
 }).join("");
 return `<svg class="sb-tile-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
 ${bars}
 </svg>`;
 }

 // ---- OVERVIEW GRID: one health-tinted tile per array, packed to fill the width.
 // Sorted worst-first so problems surface top-left. Click a tile → drill into that
 // array on the canvas (focused + expanded). The whole fleet, understood at a glance.
 function renderGrid(host, head){
 const cols = filterColsByStream((window.FleetStore && FleetStore.toColumns)
 ? (FleetStore.toColumns().columns || [])
 : []);
 // compute health once, sort worst-first (crit → warn → ok), then by $ at stake
 const rank = { bad:0, warn:1, ok:2 };
 const tiles = cols.map(col => ({ col, h: arrayHealth(col) }))
 .sort((a,b) => (rank[a.h.tone]-rank[b.h.tone]) || (b.h.lossMo-a.h.lossMo) || String(a.col.array_name).localeCompare(String(b.col.array_name)));

 const tilesHTML = tiles.map(({col, h}) => {
 const flaggedBadge = h.vendorOut
 ? `<span class="sb-tile-flag warn">vendor issue</span>`
 : h.flagged
 ? `<span class="sb-tile-flag ${h.tone}">${h.flagged} flagged</span>`
 : `<span class="sb-tile-flag ok">all good</span>`;
 const risk = h.lossMo >= 1
 ? `<span class="sb-tile-risk" title="${riskTip()}">${usd0(h.lossMo)}<small>/mo est.</small></span>`
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
 wireStreamToggle(host); // Vendor⇄Utility slider (also lives in grid header)
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
 // vertical wires don't apply, skip them cleanly.
 if(getOrient() === "horizontal"){
 root.querySelectorAll("svg.sb-wires").forEach(s => s.remove());
 return;
 }
 root.querySelectorAll(".sb-comb").forEach(comb => {
 // skip collapsed arrays, their teeth are display:none and unmeasurable
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
 // to the card directly above it, or into the array, for the top row, with a
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
 const yTop = above ? above.bottom + GAP : -24; // straight up into the array
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
 document.querySelectorAll("#sandbox .sb-outbar").forEach(bar => {
 const maxW = parseFloat(bar.dataset.maxw);
 const base = parseFloat(bar.dataset.curw);
 if(!maxW || !base) return; // idle / not reporting → leave as-is
 // HONESTY (audit #3): show the LAST REAL reading, NOT a fabricated per-second
 // wobble. current_power_w only refreshes every ~5min–hourly (polled SolarEdge)
 // or per capture (extension vendors), a second-by-second "breathing" bar read
 // as real-time telemetry it isn't. The bar now changes only when real data
 // refreshes (the FleetStore re-render + the CSS width transition animate it).
 const cur = base;
 const pct = Math.max(0, Math.min(100, Math.round((cur/maxW)*100)));
 // Health-aware tone (mirrors outputState): a healthy inverter never goes
 // orange just because live output dips, only a flagged inverter does. This
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
 refreshDataCards(); // keep live-metric data cards in step
 refreshDetailCard(); // keep the open inverter detail card (kW + lost-$) live too
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
 let _detailLost = 0; // running $ lost since this card opened
 let _detailLostTs = 0; // last tick time (ms) the accumulator advanced

 // Statuses that always count as "losing money" for the lost-$ figure.
 const LOST_STATES = new Set(["underperforming", "comm_gap", "dead", "fault"]);
 // Demo energy value used to translate missing kW into $ lost. ~$0.24/kWh is a
 // believable blended retail + incentive value for residential/commercial solar.
 const LOST_RATE_PER_KWH = 0.24;
 // Demo time-compression: a real 2.6s tick advances the lost-$ clock by this many
 // simulated minutes so the figure visibly ticks upward instead of crawling at
 // wall-clock rate. (Demo only, production drives this from real elapsed energy.)
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
 let live = _liveKW(node); // live kW (from .sb-now-val)
 if(!isFinite(live)) live = 0; // not reporting → producing nothing
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
 // status pill, peer index and "lost so far" $ are LIVE, refreshDetailCard()
 // (driven by startLiveTicker) updates them in place each tick.
 function showDetailCard(node){
 const host = detailHost();
 const d = node.dataset;
 const lk = _liveKW(node); // live kW from the output bar
 const live = isFinite(lk) ? lk.toFixed(1) : null;
 const liveStr = (live && live !== "—") ? `${live} kW now` : (d.power || "— kW now");
 const piEl = node.querySelector(".sb-pi span");
 const pi = piEl ? piEl.textContent.trim() : "";
 const col = node.closest(".sb-col");
 const arrayName = col ? (col.querySelector(".sb-array-name") || {}).textContent || "" : "";
 const sCls = STATUS_CLASS[d.status] || "ok";
 const sLabel = STATUS_LABEL[d.status] || d.status || "";

 // bind the live updater to this inverter and reset the lost-$ accumulator
 _detailInvId = _invKey(node); // unique (array|name) key, demo has no unique inverter_id
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
 ? `<a class="sb-origin sb-dc-origin" data-portal="${esc(d.vendor||"")}" href="${esc(originUrl)}" target="_blank" rel="noopener">Open in ${esc(originLabel||"portal")} ↗</a>`
 : "";

 // ---- ENRICHED stats for the blown-up card: $ at stake, peer index, last-seen,
 // nameplate, 14-day kWh, peak/low day, model. $ at stake is computed from this
 // inverter's shortfall vs its FAIR SHARE of the array's production (same model
 // as the overview grid / command center).
 const npKw = parseFloat(d.npKw) || 0;
 const winKwh = parseFloat(d.winKwh);
 const piNum = parseFloat(d.pi);
 const stale = parseFloat(d.stale);
 const peak = parseFloat(d.peak);
 const minD = parseFloat(d.min);

 // fair-share $ at stake from the array cohort (sum sibling inverter np + win)
 let lossMo = 0;
 if(col){
 const sibs = [...col.querySelectorAll(".sb-inv")];
 const totalNp = sibs.reduce((t,n)=> t + (parseFloat(n.dataset.npKw)||0), 0) || 1;
 const fleetWin = sibs.reduce((t,n)=> t + (parseFloat(n.dataset.winKwh)||0), 0);
 const fair = npKw/totalNp*fleetWin;
 let lostKwh = 0;
 if(d.status==="dead" || d.status==="fault") lostKwh = Math.max(0, fair-(winKwh||0));
 else if(d.status==="underperforming" && piNum) lostKwh = Math.max(0, fair/Math.max(piNum,0.01)-(winKwh||0));
 lossMo = dollarVal(lostKwh)/SB_WINDOW_DAYS*30;
 }

 // HONESTY (audit #7): "live now" ONLY when the card itself shows a live reading.
 // Derive from the card's own state key (st-producing / st-nofeed / st-offline / …) —
 // the truth the user sees beside this stat, so the modal can never claim "live now"
 // for an inverter the card calls "No live feed"/"Offline".
 const _cardKey = (((node && node.className) || "").match(/\bst-([a-z]+)\b/) || [])[1] || "";
 const lastSeen = (d.status==="comm_gap" && isFinite(stale) && stale>0)
 ? (stale>=48 ? `${Math.round(stale/24)} days ago` : `${Math.round(stale)} h ago`)
 : d.status==="dead" ? "not reporting"
 : _cardKey==="producing" ? "live now"
 : _cardKey==="sleeping" ? "asleep"
 : "no live reading";

 const stat = (k,v,cls) => v ? `<div class="sb-dc-stat"><span class="sb-dc-sk">${k}</span><span class="sb-dc-sv ${cls||""}">${v}</span></div>` : "";
 const statsHTML = [
 lossMo>=1 ? `<div class="sb-dc-stat hero" title="${riskTip()}"><span class="sb-dc-sk">$ at stake <small style="opacity:.65;font-weight:600">est.</small></span><span class="sb-dc-sv bad">${usd0(lossMo)}<small>/mo</small></span></div>` : "",
 stat("Peer index", isFinite(piNum) ? `${piNum.toFixed(2)} <small>vs neighbors</small>` : "", sCls),
 stat("Nameplate", npKw ? `${npKw} kW` : ""),
 stat("Last 14 days", isFinite(winKwh) ? `${winKwh.toLocaleString()} kWh` : ""),
 stat("Last seen", lastSeen, _cardKey==="producing" ? "ok" : (d.status==="comm_gap"||d.status==="dead") ? "warn" : ""),
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
 // size, spark, output bar, alert line, brand), no separate layout to drift.
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
 _detailInvId = null; // stop live updates for this card
 document.querySelectorAll("#sandbox .sb-inv.sel").forEach(n => n.classList.remove("sel"));
 host.classList.remove("sb-dc-open");
 host.removeEventListener("click", close); // don't stack listeners across opens
 host.innerHTML = "";
 document.removeEventListener("keydown", onKey);
 setDefaultFoot();
 };
 const onKey = (e) => { if(e.key === "Escape") close(); };

 // Click anywhere that ISN'T the card's actual content closes it. The host
 // (.sb-dc-open) is a full-viewport flex layer. We DON'T blanket-stop clicks on
 // the modal, because its grid cells stretch, the empty space under the left
 // card (where the bigcard cell is taller than its content) is part of the modal
 // and was a dead zone. Instead: keep open ONLY when the click lands on real
 // content (the card clone, stats, diagnosis, array tag, or actions); otherwise
 // close. Backdrop + host clicks also close.
 const CONTENT_SEL = ".sb-inv, .sb-dc-stats, .sb-dc-diag, .sb-dc-array, .sb-dc-actions";
 const backdrop = el(`<div class="sb-dc-backdrop"></div>`);
 backdrop.addEventListener("click", close);
 card.addEventListener("click", e => {
 if(e.target.closest(CONTENT_SEL)) e.stopPropagation(); // real content → keep open
 else close(); // empty modal area → close
 });
 host.addEventListener("click", close);

 host.innerHTML = "";
 // #sbWrap has a CSS transform (translateX(-50%)), which would make the modal's
 // position:fixed center relative to #sbWrap instead of the viewport. Reparent
 // the host to <body> while open so the backdrop + card center to the real
 // viewport; close() puts it back so the default corner panel still anchors right.
 if(host.parentElement !== document.body) document.body.appendChild(host);
 host.classList.add("sb-dc-open"); // switches host to full-screen centering layer
 host.appendChild(backdrop);
 host.appendChild(card);
 document.addEventListener("keydown", onKey);
 // The blown-up card is a static snapshot clone, so there's nothing for the
 // live ticker to update in here, unbind it so refreshDetailCard() no-ops.
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
 if(e.target.closest("a, button")) return; // links/close button keep their own behaviour
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
 host.style.top = Math.max(6, Math.min(maxY, ny)) + "px";
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
 if(!card){ _detailInvId = null; return; } // card dismissed → nothing to update
 if(_detailInvId == null) return; // no inverter bound

 const node = _selectedInv();
 if(!node){ // inverter removed / deselected → stop gracefully
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

 // 4) live "lost so far" $, accumulate missing kW × rate × elapsed hours.
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
 lostRow.hidden = true; // healthy → omit the $ figure
 }
 }
 }


 /* ===========================================================================
 * FREE-FORM OWNER CARDS, note cards (editable sticky) + data cards (live
 * metric) the owner can drop onto the canvas. Two placement modes:
 * free → rendered INTO .sb-canvas, so the card pans/zooms WITH the fleet
 * (x/y stored in canvas coordinates). Recreated at the end of every
 * render() (the canvas is rebuilt each render, idempotent rebuild).
 * fixed → rendered into a persistent #sbCardsFixed layer on #sbWrap, pinned
 * to the panel (x/y in panel pixels); survives re-renders like #sbAlerts.
 * A pin toggle flips a card free↔fixed (its x/y is re-seeded near viewport
 * center on the flip so it never lands off-screen). All cards persist to
 * localStorage under CARDS_KEY as {id,kind,mode,x,y,text?,title?,metric?}.
 * ==========================================================================*/
 const CARDS_KEY = "ao_cards";
 // Live-fleet metrics, computed from the rendered .sb-inv DOM each tick.
 const ATTENTION_STATES = new Set(["warn","underperforming","comm_gap","dead","fault"]);
 const CARD_METRICS = {
 fleet_now: { label:"Fleet output now", unit:"kW", compute: fleetNowKW },
 attention: { label:"Needs attention", unit:"", compute: needsAttention },
 capacity: { label:"Total capacity", unit:"kW", compute: totalCapacityKW },
 arrays: { label:"Arrays", unit:"", compute: arrayCount },
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

 // ---- card storage (localStorage; mirrors the saveOrder style) ----
 function loadCards(){
 // Cache the parsed+validated array; return a SHALLOW COPY so a caller that
 // push()es/filter()s the result can't mutate the cache. Writers immediately
 // saveCards() (which invalidates), so the next read re-parses fresh.
 const v = _lsReadJSON(CARDS_KEY, raw => {
 const a = raw == null ? null : JSON.parse(raw);
 return Array.isArray(a) ? a.filter(c => c && c.id && (c.kind==="note"||c.kind==="data")) : [];
 });
 return v.slice();
 }
 function saveCards(cards){
 try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); _lsInvalidate(CARDS_KEY); } catch(e){}
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
 return; // Note/Data card feature KILLED 2026-06-21 (Ford), no "+ Card" menu.
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
 closeArrayCtxMenu(); // only ever one menu
 const menu = el(`<div class="sb-ctxmenu" role="menu">
 <button type="button" class="sb-ctxmenu-del" role="menuitem">Delete array</button>
 </div>`);
 menu.style.left = x + "px";
 menu.style.top = y + "px";
 menu.addEventListener("click", ev => ev.stopPropagation());
 menu.querySelector(".sb-ctxmenu-del").onclick = async () => {
 closeArrayCtxMenu(); // don't leave the tiny menu floating behind the dialog
 const ok = await AODialog.confirm("You can undo this (↶ Undo or Ctrl/Cmd+Z) right after.", { title: `Delete array "${name}"?`, danger: true, confirmLabel: "Delete" });
 if(ok){
 FleetStore.deleteArray(id);
 toast(`Deleted "${name}", press ↶ Undo (Ctrl/Cmd+Z) to bring it back.`, "ok");
 }
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

 // right-click inverter context menu → "Delete inverter". Reuses the SAME menu
 // DOM/dismiss machinery as the array menu (one .sb-ctxmenu at a time, appended to
 // <body>, dismissed on outside click / Escape / scroll / another contextmenu).
 // Confirming calls FleetStore.deleteInverter(id), optimistic + backend DELETE,
 // undoable via ↶ Undo / Ctrl-Cmd+Z (single-inverter delete is NOT a history barrier).
 function showInvCtxMenu(x, y, id, name, node){
 closeArrayCtxMenu(); // only ever one menu
 const menu = el(`<div class="sb-ctxmenu" role="menu">
 <button type="button" class="sb-ctxmenu-move" role="menuitem">Move inverter</button>
 <button type="button" class="sb-ctxmenu-del" role="menuitem">Delete inverter</button>
 </div>`);
 menu.style.left = x + "px";
 menu.style.top = y + "px";
 menu.addEventListener("click", ev => ev.stopPropagation());
 // "Move" unlocks dragging for THIS card only (cards are firm by default). The
 // card becomes draggable + lifts (.sb-movable); wireInvDrag re-locks on drop.
 const moveBtn = menu.querySelector(".sb-ctxmenu-move");
 if(moveBtn) moveBtn.onclick = () => {
 if(node){
 node.setAttribute("draggable", "true");
 node.classList.add("sb-movable");
 if(node.focus) node.focus();
 toast(`"${name}" is unlocked, drag it to its new spot, then release to drop.`, "ok");
 }
 closeArrayCtxMenu();
 };
 menu.querySelector(".sb-ctxmenu-del").onclick = async () => {
 closeArrayCtxMenu(); // don't leave the tiny menu floating behind the dialog
 const ok = await AODialog.confirm("You can undo this (↶ Undo or Ctrl/Cmd+Z) right after.", { title: `Delete inverter "${name}"?`, danger: true, confirmLabel: "Delete" });
 if(ok){
 FleetStore.deleteInverter(id);
 toast(`Deleted "${name}", press ↶ Undo (Ctrl/Cmd+Z) to bring it back.`, "ok");
 }
 };
 document.body.appendChild(menu);
 // keep the menu inside the viewport if it would overflow the right/bottom edge
 const r = menu.getBoundingClientRect();
 if(r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + "px";
 if(r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + "px";
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
 // Note/Data owner cards KILLED 2026-06-21 (Ford), the free-form sticky-note +
 // live-metric card feature is removed from the sandbox. No-op so nothing renders;
 // the dead body below is kept for git history / possible revival.
 return;
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
 if(!layer) return; // free card with no canvas yet (empty fleet), skip
 let node = layer.querySelector(`:scope > .sb-card[data-card-id="${c.id}"]`);
 if(node){ positionCard(node, c); } // already present → just keep position synced
 else { layer.appendChild(buildCardNode(c)); }
 });
 refreshDataCards();
 }

 function positionCard(node, c){
 node.style.left = (c.x||0) + "px";
 node.style.top = (c.y||0) + "px";
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
 title="${pinned?"Pinned to panel, click to free":"Floats with the fleet, click to pin"}"
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
 const title = el(`<div class="sb-note-title" contenteditable="true" role="textbox" aria-label="Note title" data-ph="Title"></div>`);
 const text = el(`<div class="sb-note-text" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note body" data-ph="Write a note…"></div>`);
 title.textContent = c.title || "";
 text.textContent = c.text || "";
 [title, text].forEach(ed => {
 // editing/typing must never start a card drag or pan the canvas
 ["pointerdown","mousedown","click","dblclick"].forEach(ev => ed.addEventListener(ev, e => e.stopPropagation()));
 ed.addEventListener("keydown", e => e.stopPropagation());
 });
 title.addEventListener("input", () => updateCard(c.id, { title: title.textContent }));
 text.addEventListener("input", () => updateCard(c.id, { text: text.textContent }));
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
 return; // Note/Data card feature KILLED 2026-06-21 (Ford).
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
 if(e.target.closest("button")) return; // pin / × buttons handle themselves
 e.stopPropagation(); // never start a canvas pan
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
 const z = isFree ? (_view.z || 1) : 1; // free cards live in the scaled canvas
 const nx = origX + (e.clientX - startX)/z;
 const ny = origY + (e.clientY - startY)/z;
 node.style.left = nx + "px";
 node.style.top = ny + "px";
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
 // single 1× texture that gets stretched on zoom, that's what looked fuzzy.
 let _interactTimer = null;
 function markInteracting(c){
 if(!c) return;
 c.classList.add("sb-interacting");
 clearTimeout(_interactTimer);
 _interactTimer = setTimeout(() => c.classList.remove("sb-interacting"), 200);
 }
 // promote=true only for ZOOM: it briefly GPU-layers the canvas (smooth, then
 // re-rasterizes crisp on de-promote). PAN must NOT promote, translating never
 // changes scale, so it needs no re-raster, and the promote→de-promote cycle is
 // exactly what made a finished pan visibly "snap"/relocate. Pan stays a plain,
 // rock-solid, main-painted transform that holds precisely where you drop it.
 function applyCanvasView(host, promote){
 const c = (host||document).querySelector("#sandbox .sb-canvas");
 if(!c) return;
 // round the pan offset to whole pixels so text/edges don't land on half-pixels
 c.style.transform = `translate(${Math.round(_view.x)}px,${Math.round(_view.y)}px) scale(${_view.z})`;
 if(promote) markInteracting(c);
 // Glue the canvas DOT GRID to the SAME plane as the cards: the dots are a
 // background layer on the fixed .sb-viewport, so panning offsets that layer's
 // position by _view.x/y and zoom scales its 24px world period by _view.z, the
 // dots translate + scale in lockstep with the cards (like the NEPOOL board),
 // while the two ambient glow layers stay put (their position stays 0 0).
 // setProperty(...,"important") so it beats the theme-day.css !important defaults.
 const vp = c.closest(".sb-viewport");
 if(vp){
 const ds = (24 * (_view.z || 1)).toFixed(2);
 vp.style.setProperty("background-position",
 `0 0, 0 0, ${Math.round(_view.x)}px ${Math.round(_view.y)}px`, "important");
 vp.style.setProperty("background-size", `auto, auto, ${ds}px ${ds}px`, "important");
 }
 }
 // ---- Full-screen mode: maximize #sbWrap (the whole fleet-tree card) to fill
 // the viewport via a CSS overlay class (.sb-fs). We drive it with our own class
 // rather than the native Fullscreen API because that API silently no-ops inside
 // embedded webviews; a position:fixed overlay works everywhere. Esc exits. ----
 let _fsBound = false;
 function fsLabel(){
 const wrap = document.getElementById("sbWrap");
 const btn = document.getElementById("sbFullscreen");
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

 // ── Inverter alerts, a floating bottom-left widget (Ford 2026-07-10 redesign) ──
 // A persistent bell FAB that opens a light, powerful control panel: recipient(s),
 // what we watch, sensitivity + frequency (presets + fine slider), a live plain-English
 // preview, and a real "send test alert". Persists to /v1/array-owners/alert-settings;
 // the test button hits …/alert-settings/test. Replaces the old dark centered modal.
 const AL_API = "/v1/array-owners/alert-settings";
 const AL_BELL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
 const AL_SENS = [["Relaxed", 35], ["Balanced", 50], ["Sensitive", 70]];
 // Frequency = how soon we alert after a sustained issue (grace hours).
 // High frequency = alert sooner; rare = wait longer through weather/blips.
 const AL_PAT = [["Often", 2], ["Normal", 12], ["Rare", 24]];
 let _alPanelOpen = false;

 // The MONITORING-card / head "Alerts" button opens the same panel.
 function wireAlerts(host){
 const btn = host && host.querySelector("#sbAlerts");
 if(btn) btn.onclick = () => openAlertsPanel();
 }

 // The persistent floating widget (bottom-left). Created once; survives re-renders.
 function ensureAlertsWidget(){
 if(document.getElementById("aoAlertFab")) return;
 const fab = el(`<button type="button" id="aoAlertFab" class="ao-al-fab" aria-label="Fleet alerts" title="Fleet alerts">
 <span class="ao-al-fab-ic" aria-hidden="true">${AL_BELL}</span>
 <span class="ao-al-fab-txt">Alerts</span>
 <span class="ao-al-fab-dot" id="aoAlertFabDot" aria-hidden="true" title="Off"></span>
 </button>`);
 document.body.appendChild(fab);
 fab.onclick = () => _alPanelOpen ? closeAlertsPanel() : openAlertsPanel();
 _refreshAlertDot();
 }
 function _setDot(on){
 const d = document.getElementById("aoAlertFabDot");
 if(d){ d.classList.toggle("on", !!on); d.title = on ? "On" : "Off"; }
 }
 function _refreshAlertDot(){
 const session = getSession();
 if(!session || !document.getElementById("aoAlertFabDot")) return;
 fetch(AL_API, { headers:{ Authorization:"Bearer "+session } })
 .then(r=>r.ok?r.json():null).then(s=>{ if(s) _setDot(!!s.enabled); }).catch(()=>{});
 }
 function closeAlertsPanel(){
 _alPanelOpen = false;
 document.querySelectorAll(".ao-al-panel").forEach(n=>n.remove());
 const fab = document.getElementById("aoAlertFab"); if(fab) fab.classList.remove("open");
 }

 function openAlertsPanel(){
 ensureAlertsWidget();
 if(document.querySelector(".ao-al-panel")){ closeAlertsPanel(); return; }
 _alPanelOpen = true;
 const fab = document.getElementById("aoAlertFab"); if(fab) fab.classList.add("open");
 const seg = (arr, cur, unit) => arr.map(([lbl, v]) =>
 `<button type="button" class="ao-al-seg${v===cur?" on":""}" data-seg="${v}">${lbl}<small>${v}${unit}</small></button>`).join("");
 const panel = el(`<div class="ao-al-panel" role="dialog" aria-label="Fleet alerts">
 <div class="ao-al-head">
 <span class="ao-al-h-ic">${AL_BELL}</span>
 <div class="ao-al-h-tt"><b>Fleet alerts</b><span id="aoAlStatus">Email me when an inverter needs attention</span></div>
 <label class="ao-al-switch" title="Turn alerts on / off"><input type="checkbox" id="aoAlEnabled"><span class="ao-al-track"></span></label>
 <button type="button" class="ao-al-x" id="aoAlX" aria-label="Close">×</button>
 </div>
 <div class="ao-al-body">
 <div class="ao-al-sec">
 <div class="ao-al-lbl">Send alerts to</div>
 <input type="text" id="aoAlEmail" class="ao-al-input" placeholder="you@example.com" autocomplete="off" spellcheck="false">
 <div class="ao-al-hint">Add more addresses separated by commas, everyone gets the alert.</div>
 </div>
 <div class="ao-al-sec">
 <label class="ao-al-check" title="Fewer emails, fold inverter alerts into your daily fleet digest">
 <input type="checkbox" id="aoAlViaDigest">
 <span class="ao-al-check-box" aria-hidden="true"></span>
 <span class="ao-al-check-tt">
 <b>Attach to my morning digest</b>
 <small>Fewer emails, include inverter alerts in your daily fleet digest instead of sending them separately.</small>
 </span>
 </label>
 </div>
 <div class="ao-al-sec">
 <div class="ao-al-lbl">What we watch <span class="ao-al-lbl-note">every inverter, weighed against its neighbors</span></div>
 <div class="ao-al-watch">
 <div class="ao-al-w"><span class="ao-al-w-d dark"></span><div><b>Not producing</b><small>goes dark mid-day</small></div></div>
 <div class="ao-al-w"><span class="ao-al-w-d low"></span><div><b>Below its neighbors</b><small>underperforming its peers</small></div></div>
 <div class="ao-al-w"><span class="ao-al-w-d quiet"></span><div><b>Gone quiet</b><small>stopped reporting in</small></div></div>
 </div>
 </div>
 <div class="ao-al-sec">
 <div class="ao-al-lbl">Sensitivity <span class="ao-al-lbl-v">below <b id="aoAlThreshV">50%</b> of peers</span></div>
 <div class="ao-al-seg-row" id="aoAlSensSeg">${seg(AL_SENS, 50, "%")}</div>
 <input type="range" id="aoAlThresh" class="ao-al-range" min="10" max="95" step="5" value="50">
 </div>
 <div class="ao-al-sec">
 <div class="ao-al-lbl">Frequency <span class="ao-al-lbl-v">every <b id="aoAlGraceV">12h</b> · ignore passing clouds</span></div>
 <div class="ao-al-seg-row" id="aoAlPatSeg">${seg(AL_PAT, 12, "h")}</div>
 <input type="range" id="aoAlGrace" class="ao-al-range" min="0" max="48" step="1" value="12">
 </div>
 <div class="ao-al-preview" id="aoAlPreview"></div>
 <div class="ao-al-note" id="aoAlNote"></div>
 </div>
 <div class="ao-al-foot">
 <button type="button" class="ao-al-test" id="aoAlTest">Send a test alert</button>
 <button type="button" class="ao-al-save" id="aoAlSave">Save</button>
 </div>
 </div>`);
 document.body.appendChild(panel);
 const $ = id => panel.querySelector(id);
 const enabled = $("#aoAlEnabled"), email = $("#aoAlEmail"),
 viaDigest = $("#aoAlViaDigest"),
 thresh = $("#aoAlThresh"), grace = $("#aoAlGrace"), note = $("#aoAlNote");

 const sync = () => {
 $("#aoAlThreshV").textContent = thresh.value + "%";
 $("#aoAlGraceV").textContent = grace.value + "h";
 // highlight the preset the slider currently lands on (else none)
 $("#aoAlSensSeg").querySelectorAll(".ao-al-seg").forEach(b =>
 b.classList.toggle("on", String(b.getAttribute("data-seg")) === thresh.value));
 $("#aoAlPatSeg").querySelectorAll(".ao-al-seg").forEach(b =>
 b.classList.toggle("on", String(b.getAttribute("data-seg")) === grace.value));
 const recRaw = email.value.trim();
 const first = recRaw ? recRaw.split(",")[0].trim() : "you";
 const extra = recRaw.split(",").filter(x=>x.trim()).length - 1;
 const rec = extra > 0 ? `${first} +${extra} more` : (first || "you");
 const gr = grace.value === "0" ? "right away" : `within ${grace.value}h`;
 if(viaDigest.checked){
 $("#aoAlPreview").innerHTML =
 `We’ll include inverter issues for <b>${esc(rec)}</b> in your <b>morning fleet digest</b> when an inverter drops below <b>${thresh.value}%</b> of its neighbors, no separate alert emails.`;
 } else {
 $("#aoAlPreview").innerHTML =
 `We’ll email <b>${esc(rec)}</b> <b>${gr}</b> when an inverter drops below <b>${thresh.value}%</b> of its neighbors, and stays there.`;
 }
 // (Frequency label is the grace window: higher frequency = shorter wait.)
 panel.classList.toggle("off", !enabled.checked);
 $("#aoAlStatus").textContent = !enabled.checked
 ? "Off, no alerts sent"
 : (viaDigest.checked ? "On, via morning digest" : "On, watching your fleet");
 };
 thresh.oninput = sync; grace.oninput = sync; email.oninput = sync;
 enabled.onchange = sync; viaDigest.onchange = sync;
 panel.querySelectorAll("[data-seg]").forEach(b => b.onclick = () => {
 const v = b.getAttribute("data-seg");
 (b.closest("#aoAlSensSeg") ? thresh : grace).value = v;
 sync();
 });

 const close = closeAlertsPanel;
 $("#aoAlX").onclick = close;
 const onDoc = (e) => {
 if(panel.contains(e.target) || (fab && fab.contains(e.target))) return;
 close(); document.removeEventListener("pointerdown", onDoc, true);
 document.removeEventListener("keydown", onKey, true);
 };
 const onKey = (e) => { if(e.key==="Escape"){ close(); document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDoc, true); } };
 setTimeout(() => { document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onKey, true); }, 0);

 const session = getSession();
 if(!session){ note.innerHTML = `<a href="onboarding.html">Sign in</a> to set up alerts.`; }
 else {
 fetch(AL_API, { headers:{ Authorization:"Bearer "+session } })
 .then(r=>r.ok?r.json():null).then(s=>{
 if(!s) return;
 enabled.checked = !!s.enabled;
 email.value = s.email_is_default ? "" : (s.email || "");
 if(s.email_is_default && s.email) email.placeholder = s.email + " (account email)";
 thresh.value = s.threshold_pct || 50;
 grace.value = s.grace_hours != null ? s.grace_hours : 12;
 viaDigest.checked = !!s.via_digest;
 sync();
 }).catch(()=>{});
 }
 sync();

 $("#aoAlSave").onclick = () => {
 if(!session){ note.innerHTML = `<a href="onboarding.html">Sign in</a> first.`; return; }
 const body = { enabled: enabled.checked, email: email.value.trim(),
 threshold_pct: parseInt(thresh.value,10), grace_hours: parseInt(grace.value,10),
 via_digest: viaDigest.checked };
 note.textContent = "Saving…";
 fetch(AL_API, { method:"PUT",
 headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session },
 body: JSON.stringify(body) })
 .then(r=>r.json().then(j=>({ok:r.ok,j}))).then(({ok,j})=>{
 if(!ok){ note.textContent = (j && j.detail) || "Couldn’t save, check the email."; return; }
 _setDot(!!j.enabled);
 close();
 let msg = "Fleet alerts turned off.";
 if(j.enabled){
 msg = j.via_digest
 ? "Alerts on, inverter issues go in your morning digest (no separate emails)."
 : `Alerts on, we’ll email ${j.email} when an inverter needs you.`;
 }
 toast(msg, "ok");
 }).catch(()=>{ note.textContent = "Network error, try again."; });
 };

 const testBtn = $("#aoAlTest");
 testBtn.onclick = () => {
 if(!session){ note.innerHTML = `<a href="onboarding.html">Sign in</a> first.`; return; }
 testBtn.disabled = true; note.textContent = "Sending a test…";
 fetch(AL_API + "/test", { method:"POST", headers:{ Authorization:"Bearer "+session } })
 .then(r=>r.json().then(j=>({ok:r.ok,j}))).then(({ok,j})=>{
 testBtn.disabled = false;
 if(!ok){ note.textContent = (j && j.detail) || "Couldn’t send the test, try again."; return; }
 note.textContent = "";
 toast(`Test alert sent to ${(j.sent_to||[]).join(", ")}, check your inbox.`, "ok");
 }).catch(()=>{ testBtn.disabled=false; note.textContent = "Network error, try again."; });
 };
 }
 // "Show all arrays", visible only in TREE view when the owner has drilled into a
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
 setViewMode("grid"); // the grid IS the all-arrays view
 renderFromStore();
 requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
 };
 }

 function wireFullscreen(host){
 const btn = host.querySelector("#sbFullscreen");
 const wrap = document.getElementById("sbWrap");
 if(!btn || !wrap) return;
 fsLabel();
 btn.onclick = () => {
 const on = wrap.classList.toggle("sb-fs");
 document.body.classList.toggle("sb-fs-lock", on); // freeze the page behind it
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
 } else if(mod && (e.key === "y" || e.key === "Y")){ // Ctrl+Y = redo (Windows convention)
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
 renderFromStore(); // re-render with the new orientation
 requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
 };
 }

 // Vendor⇄Utility data-stream toggle. Flips the persisted stream and re-renders;
 // render() applies sb-stream-<stream> to the canvas (CSS collapses the inverter
 // comb in utility mode) and arrayGraph() draws the chosen source's series.
 //
 // Robustness: instead of per-button onclick (which a transparent canvas/pan
 // overlay floating over the header can intercept before the click lands, and
 // which is lost every re-render), we install ONE document-level listener in the
 // CAPTURE phase. Capture fires before any bubbling handler can stopPropagation,
 // and delegation by id survives the buttons being re-created on each render.
 let _streamWired = false;
 function applyStream(s){
 if(getStream() === s) return;
 setStream(s);
 renderFromStore();
 requestAnimationFrame(() => fitView(document.getElementById("sandbox")));
 }
 function wireStreamToggle(host){
 // Reflect current state on the freshly-rendered buttons (the listener below
 // does the actual switching, installed once).
 const vBtn = host.querySelector("#sbStreamVendor");
 const uBtn = host.querySelector("#sbStreamUtility");
 if(vBtn) vBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); applyStream("vendor"); };
 if(uBtn) uBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); applyStream("utility"); };
 if(_streamWired) return;
 _streamWired = true;
 // Capture-phase, document-level, beats any overlay that eats bubbling clicks.
 document.addEventListener("click", (e) => {
 const seg = e.target.closest && e.target.closest(".sb-stream-seg");
 if(!seg) return;
 e.preventDefault();
 e.stopPropagation();
 applyStream(seg.id === "sbStreamUtility" ? "utility" : "vendor");
 }, true);
 }

 // "Show all inverters", open (or, when all are already open, collapse) EVERY
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
 if(open) drawFleetConnectors(host); // teeth measurable now → draw feeder wires once
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
 syncLabel(); // reflect the persisted open/closed state on every render
 btn.onclick = () => { expandAllArrays(host, !allExpanded()); syncLabel(); };
 }

 // Auto-fit: scale + center the fleet so it fills the viewport (no empty void).
 function fitView(host){
 const vp = (host||document).querySelector(".sb-viewport");
 const c = (host||document).querySelector("#sandbox .sb-canvas");
 if(!vp || !c) return;
 vp.style.height = ""; // reset any prior shrink so we measure the full CSS height
 vp.style.minHeight = "";
 const prev = c.style.transform;
 c.style.transform = "none"; // measure natural (unscaled) content
 const cr = c.getBoundingClientRect();
 const cw = cr.width, ch = cr.height;
 c.style.transform = prev;
 const vw = vp.clientWidth, vh = vp.clientHeight;
 if(!cw || !ch || !vw || !vh) return;
 // Fit so the whole fleet is visible, but never shrink so far it becomes a tiny
 // island in a sea of empty space, a glance at the zoomed-out view should read
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
 // (e.g. drilled into one array, a top band over a sea of black), shrink the
 // viewport to hug the content instead of holding the full calc(100vh-150px).
 // Never shrink below a sensible floor, and never grow past the CSS max.
 const vpEl = vp;
 const needed = scaledH + 64; // content + top/bottom breathing room
 if(needed < vh - 60){
 const hpx = Math.max(280, Math.round(needed)) + "px";
 vpEl.style.height = hpx;
 vpEl.style.minHeight = hpx; // beat the CSS min-height:520px floor
 } else {
 vpEl.style.height = "";
 vpEl.style.minHeight = ""; // tall fleet → let CSS drive full height
 }
 }
 function wirePanZoom(host){
 const vp = host.querySelector(".sb-viewport");
 if(!vp) return;
 // MOBILE (see @media max-width:600px): the fleet is a normal VERTICAL SCROLL,
 // not a pan/zoom canvas, skip all pan/zoom wiring so a touch-drag never
 // captures the pointer and fights native scrolling on a phone.
 if(window.matchMedia && window.matchMedia("(max-width:600px)").matches) return;
 if(!_fitDone){ _fitDone = true; requestAnimationFrame(() => fitView(host)); } // fit once layout settles
 else applyCanvasView(host); // keep the user's view across re-renders
 vp.addEventListener("wheel", e => {
 e.preventDefault();
 // Canvas convention: the wheel ZOOMS in/out, centered on the cursor, that's
 // the in/out depth gesture people expect on a map-style canvas. Pan the dense
 // fleet by dragging empty space, or middle-drag from anywhere (cards fill the
 // view), or hold Shift to nudge it sideways with the wheel.
 if(e.shiftKey){
 // Shift+wheel → horizontal pan (a useful escape hatch when zoomed in).
 _view.x -= (e.deltaX || e.deltaY);
 applyCanvasView(host); // pan → no promote (holds, crisp)
 return;
 }
 const r = vp.getBoundingClientRect();
 const cx = e.clientX - r.left, cy = e.clientY - r.top, prev = _view.z;
 const next = Math.min(2.5, Math.max(0.4, prev * (e.deltaY < 0 ? 1.12 : 1/1.12)));
 if(next === prev) return; // already at a zoom limit
 _view.x = cx - (cx - _view.x) * (next/prev);
 _view.y = cy - (cy - _view.y) * (next/prev);
 _view.z = next; applyCanvasView(host, true); // zoom → promote + re-crisp
 }, { passive:false });
 // Suppress OS middle-click autoscroll so a middle-drag can pan instead.
 vp.addEventListener("mousedown", e => { if(e.button === 1) e.preventDefault(); });
 let panning=false, captured=false, pid=null, sx=0, sy=0, pinch=null;
 let _panStartX=0, _panStartY=0;
 const _PAN_THRESHOLD = 5; // px of movement before committing to a pan gesture
 vp.addEventListener("pointerdown", e => {
 const onControl = e.target.closest("button,a,input");
 // MIDDLE button pans from ANYWHERE. LEFT button pans from the whole canvas
 // EXCEPT the reorder grip (.sb-drag) and empty-array drop zones. Inverter
 // cards (.sb-inv) now ALSO pan, a movement threshold below distinguishes
 // a drag-to-pan from a tap-to-select so click still works.
 if(e.button === 1){
 if(onControl) return;
 e.preventDefault();
 } else if(e.button !== 0 || onControl || e.target.closest(".sb-drag,.sb-comb-empty")){
 return;
 }
 panning=true; captured=false; pid=e.pointerId; sx=e.clientX-_view.x; sy=e.clientY-_view.y;
 _panStartX=e.clientX; _panStartY=e.clientY;
 });
 vp.addEventListener("pointermove", e => {
 if(pinch) return;
 if(!panning) return;
 // Require a minimum drag distance before committing to a pan, this keeps
 // a plain click on an inverter card firing the click event normally, while
 // a deliberate drag pans the canvas instead.
 if(!captured){
 const dx=e.clientX-_panStartX, dy=e.clientY-_panStartY;
 if(dx*dx+dy*dy < _PAN_THRESHOLD*_PAN_THRESHOLD) return;
 captured=true; vp.classList.add("panning"); try{ vp.setPointerCapture(pid); }catch(_){}
 }
 _view.x = e.clientX - sx; _view.y = e.clientY - sy; applyCanvasView(host);
 });
 const end = () => { panning=false; captured=false; vp.classList.remove("panning"); };
 vp.addEventListener("pointerup", end);
 vp.addEventListener("pointercancel", end);
 // ---- Pinch-to-zoom (touch). Two fingers zoom toward the pinch midpoint,
 // mirroring the wheel zoom; single-finger pan still runs via the pointer
 // handlers above (stood down while two fingers are active). The viewport is
 // touch-action:none, so the browser won't steal the gesture.
 const _tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
 vp.addEventListener("touchstart", e => {
 if(e.touches.length === 2){
 panning=false; captured=false; vp.classList.remove("panning");
 pinch = { d:_tdist(e.touches), z:_view.z };
 e.preventDefault();
 }
 }, { passive:false });
 vp.addEventListener("touchmove", e => {
 if(!pinch || e.touches.length !== 2) return;
 e.preventDefault();
 const d = _tdist(e.touches);
 if(!pinch.d) return;
 const r = vp.getBoundingClientRect();
 const mx = (e.touches[0].clientX + e.touches[1].clientX)/2 - r.left;
 const my = (e.touches[0].clientY + e.touches[1].clientY)/2 - r.top;
 const prev = _view.z;
 const next = Math.min(2.5, Math.max(0.4, pinch.z * (d / pinch.d)));
 if(next === prev) return;
 _view.x = mx - (mx - _view.x) * (next/prev);
 _view.y = my - (my - _view.y) * (next/prev);
 _view.z = next; applyCanvasView(host, true);
 }, { passive:false });
 const _endPinch = e => { if(!e.touches || e.touches.length < 2) pinch = null; };
 vp.addEventListener("touchend", _endPinch);
 vp.addEventListener("touchcancel", _endPinch);
 vp.addEventListener("dblclick", e => {
 if(e.target.closest(".sb-inv,.sb-array,button,a")) return;
 fitView(host); // double-click empty space → re-fit to screen
 });
 }

 /* ---- '+ Add array' button wiring ---- */
 function wireAddButton(host){
 const btn = host.querySelector("#sbAddArray");
 if(btn) btn.onclick = openAddArrayModal;
 }

 // Global hook so the GMP-onboarding gate banner (app.js) can launch the REAL
 // connect flow directly, open the Add-array modal and, when the extension is
 // present, immediately fire the GMP portal login (opens greenmountainpower.com
 // in a new tab; the extension captures + lands the bills here). No detour back
 // to /onboarding. When the extension isn't installed yet, the modal shows the
 // "add the free helper" step instead, which is the correct next action.
 window.__aoConnectGmp = function(){
 openAddArrayModal();
 // Give the modal a tick to render, then either launch GMP or surface install.
 setTimeout(() => {
 if(EXT_PRESENT){
 try { openPortalLogin("gmp"); } catch(e){}
 }
 // If the extension isn't present, openAddArrayModal already rendered the
 // "add the 1-click helper" path, leave it so the owner installs it first.
 }, 60);
 };
 // Same flow for VEC (Vermont Electric Cooperative, on NISC SmartHub): opens the
 // VEC portal so the extension captures the owner's VEC accounts, which then show
 // up in the offtaker utility-account picker. When the extension isn't installed,
 // openAddArrayModal surfaces the install step (identical to the GMP path).
 window.__aoConnectVec = function(){
 openAddArrayModal();
 setTimeout(() => {
 if(EXT_PRESENT){
 try { openPortalLogin("vec"); } catch(e){}
 }
 }, 60);
 };

 // Generic global so other surfaces (the Vendor-data Spreadsheet view's
 // "+ Add vendor" button) open the SAME add-array modal, one flow, never a
 // parallel mechanism.
 window.__aoAddArray = function(){ openAddArrayModal(); };
 // The offtaker page's single "Link utility bills" button → the SAME modal in
 // utilities-only mode (every supported utility, searchable). One button replaces
 // the old hardcoded GMP + VEC pair, matching the NEPOOL Operator utility picker.
 window.__aoLinkUtility = function(){ openAddArrayModal({ utilityOnly: true }); };

 /* ---- 'Reset layout', snap inverters back to their discovered grouping.
 * Goes through the store (which persists to the server when live). ---- */
 function wireResetButton(host){
 const btn = host.querySelector("#sbReset");
 if(!btn) return;
 btn.onclick = () => {
 setSaving("Resetting to your discovered grouping…");
 FleetStore.resetLayout(); // store notifies → our subscription re-renders
 };
 }

 /* ---- 'New empty array', create an owner-defined group to drag inverters
 * into. Goes through the store (persists when live). ---- */
 function wireNewArrayButton(host){
 const btn = host.querySelector("#sbNewArray");
 if(!btn) return;
 btn.onclick = async () => {
 let name = await AODialog.prompt("Then drag inverters into it.", "", { title: "Name your new array", placeholder: "e.g. Rutland Community" });
 if(name == null) return; // cancelled
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
 const offset = x - box.left - box.width / 2; // negative = cursor left of this col's center
 if(offset < 0 && offset > best.dist) best = { dist: offset, el };
 });
 return best.el;
 }
 function wireDrag(host){
 const canvas = host.querySelector(".sb-canvas");
 if(!canvas) return;
 let dragEl = null;
 // Only the grip (⠿) starts an array-reorder drag, the array body is free to
 // pan. (The whole array node used to be draggable, which turned pan attempts
 // into accidental array moves.)
 canvas.querySelectorAll(".sb-array .sb-drag").forEach(grip => {
 grip.addEventListener("dragstart", e => {
 const col = grip.closest(".sb-col");
 if(!col) return;
 dragEl = col;
 canvas.classList.add("dragging-active");
 try { e.dataTransfer.setDragImage(col, 24, 18); } catch(_){} // ghost the column, not the glyph
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
 if(!dragEl) return; // only columns handled here
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
 if(open) drawFleetConnectors(host); // teeth now measurable → draw wires
 }
 function wireInvToggle(host){
 host.querySelectorAll(".sb-col").forEach(col => {
 const card = col.querySelector(".sb-array");
 if(!card) return;
 card.addEventListener("click", e => {
 // ignore clicks on interactive children (origin links, editable name,
 // drag grip, inputs) so they keep their own behaviour. The "N inverters"
 // chevron is a plain button INSIDE the card, so its clicks bubble here and
 // toggle too, no separate handler needed.
 if(e.target.closest("a, .sb-drag, [contenteditable='true'], input, textarea")) return;
 toggleArray(col, host);
 });
 });
 }

 /* ---- HTML5 drag of individual inverter cards → PERSISTED to the backend ----
 * (a) reorder within a comb → POST /inverters/reorder (peer cohort unchanged → trust optimistic)
 * (b) move across combs → POST /inverters/reassign (changes the real peer cohort → reload to
 * re-render peer-index / alerts / counts; revert by reloading on failure)
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
 e.stopPropagation(); // never bubble into a column drag
 dragInv = card;
 originArrayId = card.dataset.arrayId; // remember where it started for reassign vs reorder
 host.classList.add("inv-dragging-active");
 requestAnimationFrame(() => card.classList.add("inv-dragging"));
 e.dataTransfer.effectAllowed = "move";
 try { e.dataTransfer.setData("text/plain", card.dataset.invId || ""); } catch(_){}
 });
 card.addEventListener("dragend", () => {
 card.classList.remove("inv-dragging");
 card.classList.remove("sb-movable"); // re-lock, firm in place again
 card.removeAttribute("draggable");
 host.classList.remove("inv-dragging-active");
 host.querySelectorAll(".sb-teeth.inv-drop").forEach(t => t.classList.remove("inv-drop"));
 const col = card.closest(".sb-col");
 const from = originArrayId;
 dragInv = null; originArrayId = null;
 if(!col) return;

 card.dataset.arrayId = col.dataset.arrayId; // optimistic: its new home array
 host.querySelectorAll(".sb-col").forEach(updateColCount);

 const invId = card.dataset.invId;
 const destArrayId = col.dataset.arrayId;
 if(invId==null || invId==="" || !window.FleetStore) return;

 // Route the move through the shared store. The store updates the
 // canonical fleet, recomputes peer indices for BOTH cohorts, and notifies
 // every subscriber, so the command center's KPIs + triage queue move in
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
 if(!dragInv) return; // not an inverter drag → let columns handle it
 e.preventDefault();
 e.stopPropagation(); // keep the canvas column handler out of it
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

 // The fleet tree is now a VIEW over the shared FleetStore, it renders the
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
 * ADD-ARRAY MODAL, dark-skinned vendor picker. Mirrors the onboarding wizard's
 * connect step, but authed with the existing so_session and pointed at the
 * already-deployed connect endpoints. On success it re-loads the fleet tree.
 * ==========================================================================*/
 let _ov = null, _escH = null;
 let renderAddModalBody = null; // assigned when the Add-array modal opens; the
 // extension-present listener calls it to re-render.
 // Which mode the currently-open modal is in, "Add an array" offers inverter
 // AND utility vendors; the offtaker "Link utility bills" modal (utilityOnly)
 // offers ONLY utilities and never shows an inverter vendor as an option. The
 // module-level SO_CAPTURE_FAILED listener below needs this to avoid writing an
 // unrelated vendor's error into whatever modal happens to be open (see below).
 let _ovUtilityOnly = false;
 // Default inverter chips shown in Add-array (keys + one-click). AlsoEnergy is
 // API-login (opens credential form), not extension portal scrape.
 const _INVERTER_VENDORS = ["solaredge","alsoenergy","fronius","sma","chint"];
 // API-credential vendors: "Log in" opens the keys form for that brand instead
 // of a browser portal tab (no extension scrape path).
 const _API_KEY_VENDORS = new Set(["solaredge","alsoenergy","locus"]);
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

 function openAddArrayModal(opts){
 const ov = ensureOv();
 const utilityOnly = !!(opts && opts.utilityOnly); // offtaker "Link utility bills" → utilities only
 _ovUtilityOnly = utilityOnly;
 const _modalTitle = utilityOnly ? "Link utility bills" : "Add an array";
 let vendor = "solaredge";
 let manual = false; // false = one-click login view; true = paste-keys view
 const fields = {}; // field name -> current value (manual mode)

 ov.innerHTML = `
 <div class="sb-modal" role="dialog" aria-modal="true" aria-label="${_modalTitle}">
 <div class="sb-modal-head">
 <div class="sb-modal-title">${_modalTitle}</div>
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
 const LOGIN_VENDORS = ["solaredge","fronius","sma","chint","gmp","vec","wec","eversource","cmp"];

 // Render the modal body for the current mode. Exposed via closure so the
 // extension-present detector (handleCaptureLanded's sibling listener) can
 // re-render the moment the helper announces itself.
 renderAddModalBody = function(){
 note.className = "sb-note"; note.textContent = "";
 if(!manual){
 // ── One-click login view (the lead path) ──
 // Vendor picker, grouped (inverter monitoring vs utility meters), each a
 // clean row-card with a brand badge + chevron. The repetitive "utility
 // meter" copy now lives once in the section subtitle, not on every row.
 const ICONS = { solaredge:"SE", fronius:"Fr", sma:"SMA", chint:"Ch", alsoenergy:"AE", gmp:"GMP", vec:"VEC", wec:"WEC", eversource:"EV", cmp:"CM" };
 const SUBS = {
 alsoenergy: "1 PowerTrack login · every site",
 solaredge: "1 account key · every site",
 eversource: "CT · MA · NH",
 cmp: "Maine",
 };
 const card = code => `
 <button type="button" class="sb-login-btn" data-login="${code}">
 <span class="sb-login-ico ${code}">${esc(ICONS[code] || (BRAND[code]||code).slice(0,2))}</span>
 <span class="sb-login-main">
 <span class="sb-login-name">${esc(BRAND[code]||code)}</span>
 ${SUBS[code] ? `<span class="sb-login-sub">${SUBS[code]}</span>` : ""}
 </span>
 <span class="sb-login-go">Log in <span class="sb-login-arrow">→</span></span>
 </button>`;
 const section = (title, note, codes) => `
 <div class="sb-login-sec">
 <div class="sb-login-sec-h">${title}${note ? `<span>${note}</span>` : ""}</div>
 <div class="sb-login-grid">${codes.map(card).join("")}</div>
 </div>`;
 // Utility meter quick-picks, defaults always visible (incl. newly live
 // Eversource + CMP). Search covers the other ~470 live utilities.
 const utilFeatured = ["gmp","vec","wec","eversource","cmp"];
 const utilCard = p => `
 <button type="button" class="sb-login-btn" data-login="${esc(p.code)}">
 <span class="sb-login-ico" style="background:var(--accent,#2563eb);color:#fff">${esc(String(p.label||p.code).replace(/[^A-Za-z]/g,"").slice(0,2).toUpperCase())}</span>
 <span class="sb-login-main">
 <span class="sb-login-name">${esc(p.label||p.code)}</span>
 <span class="sb-login-sub">${esc(p.state||"")}${p.smarthub_host?" · SmartHub":""}</span>
 </span>
 <span class="sb-login-go">Log in <span class="sb-login-arrow">→</span></span>
 </button>`;
 const utilSection = `
 <div class="sb-login-sec">
 <div class="sb-login-sec-h">Utility meter<span>whole-array production · for arrays with no inverter portal</span></div>
 <div class="sb-login-grid">${utilFeatured.map(card).join("")}</div>
 <div style="margin-top:.55rem">
 <input type="text" id="sbUtilSearch" placeholder="Other utility? Search your co-op or company name…" autocomplete="off" spellcheck="false"
 style="width:100%;box-sizing:border-box;padding:.6rem .75rem;border:1px solid var(--line,#dbe4ee);border-radius:10px;font-size:14px;background:var(--card,#fff);color:var(--ink,#1e293b)">
 <div id="sbUtilResults" style="margin-top:.5rem"></div>
 </div>
 </div>`;
 // Default inverter chips, AlsoEnergy sits next to SolarEdge (1-login API).
 const invFeatured = ["solaredge","alsoenergy","fronius","sma","chint"];
 const loginSections = utilityOnly
 ? utilSection
 : section("Inverter monitoring", "", invFeatured) + utilSection;
 // Warm the catalog, then backfill the live utility count into the lede (no
 // hardcoded number, it grows as discovery wires more SmartHub hosts).
 getProviders().then(() => {
 const el = document.getElementById("sbUtilCount");
 if(el) el.textContent = provCountLabel();
 });
 // Cloud Capture owners don't use the browser helper at all, their utility logins
 // live in the SERVER-SIDE vault in Master Account. So "Link utility bills" must send
 // them there, not push the 1-click extension. (Ford 2026-07-12.)
 const _isCloud = (() => { try { return localStorage.getItem("ao_ar_mode") === "cloud"; } catch(e){ return false; } })();
 const cloudUtil = utilityOnly && _isCloud;
 const _lede = cloudUtil
 ? `You're on <b>Cloud Capture</b>, we sign in and refresh your utility bills around the clock on our servers, no browser helper needed. Add your utility login in <b>Account</b> and we pull the bills in automatically.`
 : utilityOnly
 ? (EXT_PRESENT
 ? `Connect the utility whose bills you invoice your offtakers against, we pull the bills in automatically. Pick yours below (any of <span id="sbUtilCount">hundreds of</span> supported utilities).`
 : "Connect the utility whose bills you invoice your offtakers against. Add the free helper, then pick your utility and we pull the bills in automatically.")
 : (EXT_PRESENT
 ? "Connect the easy way, log into the monitoring site you already use, and your inverters come in on their own. No keys to find."
 : "Connect the easy way, add the free EnergyAgent helper, then log into the monitoring site you already use and your inverters come in on their own.");
 const extBlock = cloudUtil
 ? `<p class="sb-modal-lede">${_lede}</p>
 <button type="button" class="sb-mbtn primary" id="sbCloudLink">Add a utility login in Account →</button>`
 : EXT_PRESENT
 ? `<p class="sb-modal-lede">${_lede}</p>
 ${loginSections}`
 : `<p class="sb-modal-lede">${_lede}</p>
 <a class="sb-mbtn primary sb-login-install" href="${EXT_STORE_URL}" target="_blank" rel="noopener">Add the 1-click helper, free →</a>
 <div class="sb-login-hint">Already added it? <button type="button" class="sb-linkbtn" id="sbRecheck">Re-check</button></div>`;
 // Utilities have no manual key-entry path (it's an inverter-API-key flow), so hide it.
 body.innerHTML = extBlock + (utilityOnly ? "" :
 `<div class="sb-or"><span>or</span></div>
 <button type="button" class="sb-mbtn ghost sb-manual-toggle" id="sbManualToggle">Enter keys manually instead</button>`);
 // Cloud path → close, jump to Master Account's vault, open the utility-login picker.
 const _cloudLink = body.querySelector("#sbCloudLink");
 if(_cloudLink) _cloudLink.onclick = () => {
 closeAddModal();
 location.hash = "#account";
 setTimeout(() => {
 const row = document.getElementById("rowAutoRefresh");
 if(row) row.scrollIntoView({ behavior:"smooth", block:"center" });
 const ab = document.querySelector(".ar-addutil-btn");
 if(ab) ab.click();
 }, 260);
 };
 foot.innerHTML = `<button class="sb-mbtn ghost" type="button" id="sbCancel">Close</button>`;

 body.querySelectorAll("[data-login]").forEach(b => {
 b.onclick = () => {
 const code = b.dataset.login;
 // API-credential vendors: jump straight to the keys form for that brand
 // (AlsoEnergy / SolarEdge / Locus) instead of a portal tab with no capture.
 if(_API_KEY_VENDORS.has(code)){
 manual = true;
 vendor = code;
 renderAddModalBody();
 return;
 }
 openPortalLogin(code);
 };
 });
 // Live utility search → render matching co-ops as the SAME login cards.
 const utilSearch = body.querySelector("#sbUtilSearch");
 const utilResults = body.querySelector("#sbUtilResults");
 if(utilSearch && utilResults){
 let _ut = null;
 utilSearch.addEventListener("input", () => {
 clearTimeout(_ut);
 _ut = setTimeout(async () => {
 const q = utilSearch.value.trim().toLowerCase();
 if(q.length < 2){ utilResults.innerHTML = ""; return; }
 const provs = await getProviders();
 const feat = new Set(utilFeatured);
 const m = provs.filter(p => !feat.has(p.code) &&
 ((p.label||"").toLowerCase().includes(q) || (p.code||"").includes(q) || (p.state||"").toLowerCase() === q)
 ).slice(0, 25);
 // Search miss → a REAL request path, not a dead end: one click files the
 // utility's name into the feature-suggestion pipeline (internal alert +
 // agent review queue), so demand for a new adapter is captured the moment
 // an operator hits the gap. Any *.smarthub.coop co-op already works even
 // unlisted (the extension mints sh_* on first login), this is for the
 // custom-portal utilities we'd have to build bespoke.
 utilResults.innerHTML = m.length
 ? `<div class="sb-login-grid">${m.map(utilCard).join("")}</div>`
 : `<div class="sb-login-sub" style="padding:.5rem .25rem">No live match for “${esc(utilSearch.value)}”.
 <button type="button" class="sb-linkbtn" id="sbUtilRequest" style="font-weight:650">Request ${esc(utilSearch.value)} →</button>
 <span style="display:block;margin-top:3px;opacity:.85">We'll add it and email you when it's live. (SmartHub co-ops usually work even when unlisted, try signing in via “Link utility bills” first.)</span></div>`;
 utilResults.querySelectorAll("[data-login]").forEach(b => { b.onclick = () => openPortalLogin(b.dataset.login); });
 const reqBtn = utilResults.querySelector("#sbUtilRequest");
 if(reqBtn) reqBtn.onclick = async () => {
 reqBtn.disabled = true; reqBtn.textContent = "Sending…";
 try {
 const s = localStorage.getItem("so_session") || "";
 const r = await fetch("/v1/feature-suggestion", {
 method: "POST",
 headers: Object.assign({ "Content-Type":"application/json" }, s ? { "Authorization":"Bearer "+s } : {}),
 body: JSON.stringify({ text: "UTILITY REQUEST: “" + utilSearch.value.trim() + "”, an operator searched for this utility in the Link-utility picker and it isn't supported yet. Evaluate: SmartHub deployment (promote to catalog) vs custom portal (bespoke adapter)." }),
 });
 reqBtn.textContent = r.ok ? "✓ Requested, we'll email you when it's live" : "Couldn't send, try again";
 if(!r.ok) reqBtn.disabled = false;
 } catch(e){ reqBtn.textContent = "Couldn't send, try again"; reqBtn.disabled = false; }
 };
 }, 180);
 });
 }
 const recheck = body.querySelector("#sbRecheck");
 if(recheck) recheck.onclick = () => extSend("SO_STATUS_REQUEST");
 const _mt = body.querySelector("#sbManualToggle"); // absent in utility-only mode
 if(_mt) _mt.onclick = () => { manual = true; renderAddModalBody(); };
 } else {
 // ── Manual key-entry view (buried behind the button) ──
 body.innerHTML = `
 <button type="button" class="sb-linkbtn sb-back" id="sbBackToLogin">← Back to one-click login</button>
 <p class="sb-modal-lede">Paste your monitoring credentials. SolarEdge and AlsoEnergy unlock every site on the account with one login; Fronius is one API key for the whole fleet; Locus / SMA can connect per array.</p>
 <div class="sb-vendgrid" id="sbVendGrid"></div>
 <div id="sbVendFields"></div>`;
 foot.innerHTML = `
 <button class="sb-mbtn ghost" type="button" id="sbCancel">Cancel</button>
 <button class="sb-mbtn primary" type="button" id="sbConnect" disabled>Connect</button>`;
 body.querySelector("#sbBackToLogin").onclick = () => { manual = false; renderAddModalBody(); };
 // Pre-select vendor when opened via an AlsoEnergy / SolarEdge chip.
 if(vendor && vendorByCode(vendor)){ /* keep */ } else { vendor = "solaredge"; }
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
 connectBtn.style.display = "";
 connectBtn.textContent = v.available ? (v.discover ? "Discover & connect" : "Connect array") : "Not available yet";
 connectBtn.onclick = submitConnect;
 validate();
 }
 function validate(){
 const v = vendorByCode(vendor);
 if(!v.available){ connectBtn.disabled = true; return; }
 // Discover-mode (SolarEdge, Fronius) and manual-connect vendors both just
 // need every non-optional field filled, one required field (SolarEdge's
 // apiKey) or several (Fronius's key id + value) work the same way.
 const ok = (v.fields||[]).every(f => /optional/i.test(f.label) || (fields[f.name]||"").trim().length > 0);
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
 note.innerHTML = `Please sign in first, <a href="onboarding.html">get started →</a>, then come back to add arrays.`;
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
 } else if(vendor==="fronius"){
 // One key, discover + attach every PV system on the account, same
 // "1 key" shape as SolarEdge (verified live against a real account
 // 2026-07-08; see /v1/array-owners/fronius/connect-account).
 url = "/v1/array-owners/fronius/connect-account";
 body2 = { access_key_id: config.access_key_id, access_key_value: config.access_key_value };
 } else if(vendor==="alsoenergy"){
 // One PowerTrack login → every site (REST API, not extension scrape).
 url = "/v1/array-owners/alsoenergy/connect-account";
 body2 = { username: config.username || fields.username,
 password: config.password || fields.password };
 if((config.site_id || fields.site_id || "").toString().trim()){
 body2.site_ids = [parseInt(config.site_id || fields.site_id, 10)];
 }
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
 // Connecting… skeleton on Inverters for every API vendor (SE / Fronius / AE / Locus / …)
 try {
 if(window.__aoPendingFeeds){
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, vendor, {
 label: v.label || BRAND[vendor] || vendor,
 note: "api connect, attaching sites",
 });
 }
 } catch(e){}
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
 // again", never show the owner the raw tenant-key error.
 const authDead = r.status===401 ||
 (r.status===403 && /tenant key|sign in|session/i.test((data && (data.detail||data.message))||""));
 if(authDead){
 try { localStorage.removeItem("so_session"); } catch(e){}
 try { if(window.__aoPendingFeeds) window.__aoPendingFeeds.clear(vendor); } catch(e){}
 note.className = "sb-note err";
 note.innerHTML = `Your session expired, <a href="onboarding.html">sign in again →</a> to add this array. Your existing arrays are safe.`;
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
 try {
 if(window.__aoPendingFeeds){
 window.__aoPendingFeeds.reconcile((FleetStore.snapshot() || {}).arrays || []);
 window.__aoPendingFeeds.startPoll();
 }
 } catch(e){}
 }
 } catch(e){}
 closeAddModal(); load(); return;
 }
 try { if(window.__aoPendingFeeds) window.__aoPendingFeeds.clear(vendor); } catch(e){}
 note.className = "sb-note err";
 note.textContent = (data && (data.message || data.detail)) ||
 `Couldn't connect that ${v.label} account (HTTP ${r.status}). Double-check the credentials and try again.`;
 if(connectBtn) connectBtn.disabled = false;
 }catch(err){
 try { if(window.__aoPendingFeeds) window.__aoPendingFeeds.clear(vendor); } catch(e){}
 note.className = "sb-note err";
 note.textContent = "We couldn't reach the connection service just now, check your network and try again.";
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
 * MASTER ACCOUNT, profile + plan + billing. Fetches GET /v1/account and the
 * billing endpoints (which may 404/empty on a trial, handled gracefully).
 * company-name + email are inline-editable; everything else is display-only.
 * ==========================================================================*/
 let _account = null; // last-fetched account (shared with Reports prefill)

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
 function signInPrompt(){ return `<div class="empty">Sign in to manage your account. <a href="onboarding.html" style="color:var(--good)">Get started →</a></div>`; }
 function sessionExpired(){ return `<div class="empty">Your session expired, <a href="onboarding.html" style="color:var(--good)">sign in again →</a></div>`; }

 /* ---- horizontal-row builders for the flat "all business" account list ---- */
 function rowStatic(label, valueHTML, subHTML, actionHTML){
 return `<div class="acct-row">
 <div class="r-k">${esc(label)}</div>
 <div class="r-v">${valueHTML}${subHTML ? `<span class="r-sub">${subHTML}</span>` : ""}</div>
 <div class="r-a">${actionHTML || ""}</div>
 </div>`;
 }
 function rowEdit(label, field, value, placeholder){
 // No Save button (Ford 2026-07-09): identity fields auto-save as you type —
 // wireAcctEdits debounces the write and shows a quiet "Saved ✓" in .acct-msg.
 return `<div class="acct-row acct-edit" data-field="${esc(field)}">
 <div class="r-k">${esc(label)}</div>
 <div class="r-v">
 <input type="text" autocomplete="off" spellcheck="false" value="${esc(value||"")}" placeholder="${esc(placeholder||"")}">
 <div class="acct-msg"></div>
 </div>
 <div class="r-a"></div>
 </div>`;
 }

 // ---- Master Account file library (the operator's stored files) ------------
 // The template, uploaded billing workbooks, and captured GMP utility-bill PDFs —
 // newest first, the latest upload featured center stage. Files open in a new tab
 // (fetched with the session bearer → blob). Reuses the .rb-files/.rb-file styles.
 function _flIcon(kind, name){ const n=String(name||"").toLowerCase();
 if(kind==="gmp_bill"||n.endsWith(".pdf"))return"🧾"; if(kind==="template")return"🧩";
 if(/\.(xlsx|xls|xlsm|csv)$/.test(n))return"📊"; if(/\.(docx?|html?|txt)$/.test(n))return"📄";
 if(/\.(png|jpe?g|gif|webp)$/.test(n))return"🖼️"; return"📁"; }
 function _flSize(b){ if(!b&&b!==0)return""; if(b<1024)return b+" B";
 if(b<1048576)return(b/1024).toFixed(0)+" KB"; return(b/1048576).toFixed(1)+" MB"; }
 function _flAgo(iso){ if(!iso)return""; const t=Date.parse(iso); if(isNaN(t))return"";
 const d=(Date.now()-t)/1000; if(d<90)return"just now"; if(d<3600)return Math.round(d/60)+" min ago";
 if(d<86400)return Math.round(d/3600)+"h ago"; if(d<86400*30)return Math.round(d/86400)+"d ago";
 try{ return new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"});}catch(e){return"";} }
 async function _flOpen(url, status){
 try{ const r=await fetch(url,{headers:authHeaders()});
 if(!r.ok){ if(status)status.textContent="Couldn't open that file."; return; }
 const u=URL.createObjectURL(await r.blob()); window.open(u,"_blank");
 setTimeout(()=>URL.revokeObjectURL(u),60000);
 }catch(e){ if(status)status.textContent="Couldn't open that file."; }
 }
 // Suggestion #16, directory view for the account "Your files" list.
 // Group by role/account (or kind), collapsible folders, live search. Marker: acctFilesSearch
 const _flDirCollapsed = Object.create(null); // session memory of which folders are shut

 function _flNaturalKey(s){
 return String(s || "").toLowerCase().replace(/(\d+)/g, (_, n) => n.padStart(8, "0"));
 }
 function _flFolderKey(f){
 const role = (f.role || "").trim();
 if(role) return role;
 const kind = (f.kind || "").trim();
 if(kind) return kind.charAt(0).toUpperCase() + kind.slice(1) + " files";
 return "Other files";
 }
 function _flTile(f, demo){
 const url = demo ? "" : (f.download || "");
 return `<button type="button" class="rb-file" data-url="${esc(url)}" data-fl-name="${esc(f.name||"")}" data-fl-role="${esc(f.role||"")}" title="${esc(f.name)}"><span class="ico">${_flIcon(f.kind,f.name)}</span><span class="meta"><b>${esc(f.name)}</b><small>${esc(f.role||"")}</small></span><span class="when">${esc(_flAgo(f.uploaded_at))}${f.size?" · "+_flSize(f.size):""}</span></button>`;
 }
 function _flDirHtml(files, demo){
 // Bucket rest-of-list (not the hero) into labeled folders.
 const map = new Map();
 for(const f of files){
 const k = _flFolderKey(f);
 if(!map.has(k)) map.set(k, []);
 map.get(k).push(f);
 }
 const keys = [...map.keys()].sort((a, b) => {
 if(a === "Other files") return 1;
 if(b === "Other files") return -1;
 return _flNaturalKey(a).localeCompare(_flNaturalKey(b));
 });
 return keys.map(k => {
 const list = map.get(k);
 const closed = !!_flDirCollapsed[k];
 return `<div class="rb-files-dir${closed?" is-collapsed":""}" data-fl-folder="${esc(k)}">` +
 `<button type="button" class="rb-files-dir-head" aria-expanded="${closed?"false":"true"}">` +
 `<span class="rb-files-dir-chev" aria-hidden="true">▾</span>` +
 `<span class="rb-files-dir-name">${esc(k)}</span>` +
 `<span class="rb-files-dir-count">${list.length}</span>` +
 `</button>` +
 `<div class="rb-files-dir-body" ${closed?'hidden':''}>${list.map(f => _flTile(f, demo)).join("")}</div>` +
 `</div>`;
 }).join("");
 }
 function _flWireDir(body, demo){
 body.querySelectorAll(".rb-files-dir-head").forEach(btn => {
 btn.onclick = () => {
 const dir = btn.closest(".rb-files-dir");
 if(!dir) return;
 const key = dir.getAttribute("data-fl-folder") || "";
 const open = btn.getAttribute("aria-expanded") !== "true";
 btn.setAttribute("aria-expanded", open ? "true" : "false");
 dir.classList.toggle("is-collapsed", !open);
 const bodyEl = dir.querySelector(".rb-files-dir-body");
 if(bodyEl) bodyEl.hidden = !open;
 if(key) _flDirCollapsed[key] = !open;
 };
 });
 const search = body.querySelector("#acctFilesSearch");
 const empty = body.querySelector("#acctFilesSearchEmpty");
 if(search){
 const apply = () => {
 const q = (search.value || "").trim().toLowerCase();
 let hits = 0;
 body.querySelectorAll(".rb-files-dir").forEach(dir => {
 let dirHits = 0;
 dir.querySelectorAll(".rb-file").forEach(tile => {
 const hay = ((tile.getAttribute("data-fl-name") || "") + " " +
 (tile.getAttribute("data-fl-role") || "")).toLowerCase();
 const ok = !q || hay.includes(q);
 tile.hidden = !ok;
 if(ok) dirHits++;
 });
 hits += dirHits;
 dir.hidden = q ? dirHits === 0 : false;
 if(q && dirHits > 0){
 // Auto-open folders that match while searching.
 dir.classList.remove("is-collapsed");
 const btn = dir.querySelector(".rb-files-dir-head");
 const bodyEl = dir.querySelector(".rb-files-dir-body");
 if(btn) btn.setAttribute("aria-expanded", "true");
 if(bodyEl) bodyEl.hidden = false;
 }
 });
 if(empty) empty.hidden = !(q && hits === 0);
 };
 search.oninput = apply;
 search.onkeydown = e => { if(e.key === "Escape"){ search.value = ""; apply(); } };
 }
 body.querySelectorAll(".rb-file[data-url]").forEach(b => {
 b.onclick = () => {
 if(demo){
 const s = document.getElementById("acctFilesStatus");
 if(s) s.textContent = "Sign in to open your own files.";
 return;
 }
 _flOpen(b.getAttribute("data-url"), document.getElementById("acctFilesStatus"));
 };
 });
 }
 function _flRenderList(body, files, demo){
 const feat = files[0], rest = files.slice(1);
 const featUrl = demo ? "" : (feat.download || "");
 body.innerHTML =
 `<button type="button" class="rb-file-feat" data-url="${esc(featUrl)}" title="${esc(feat.name)}">` +
 `<span class="badge">Latest upload</span>` +
 `<span class="ico">${_flIcon(feat.kind, feat.name)}</span>` +
 `<span class="name">${esc(feat.name)}</span>` +
 `<span class="role">${esc(feat.role || "")}</span>` +
 `<span class="meta">${esc(_flAgo(feat.uploaded_at))}${feat.size ? " · " + _flSize(feat.size) : ""}${demo ? " · demo" : " · open ↗"}</span>` +
 `</button>` +
 (rest.length
 ? `<div class="rb-files-toolbar">` +
 `<input type="search" id="acctFilesSearch" class="rb-files-search" placeholder="Search files by name or account…" autocomplete="off" />` +
 `</div>` +
 `<div class="rb-files-dirlist" id="acctFilesDir">${_flDirHtml(rest, demo)}</div>` +
 `<div class="rb-files-empty" id="acctFilesSearchEmpty" hidden>No files match your search.</div>`
 : "") +
 `<div class="rb-files-status" id="acctFilesStatus"></div>`;
 // Hero click
 const hero = body.querySelector(".rb-file-feat");
 if(hero){
 hero.onclick = () => {
 if(demo){
 const s = document.getElementById("acctFilesStatus");
 if(s) s.textContent = "Sign in to open your own files.";
 return;
 }
 _flOpen(hero.getAttribute("data-url"), document.getElementById("acctFilesStatus"));
 };
 }
 _flWireDir(body, demo);
 }
 async function loadAcctFiles(){
 const body=document.getElementById("acctFilesBody"), countEl=document.getElementById("acctFilesCount");
 if(!body) return;
 let files=[], failed=false;
 // Signed-out DEMO: show the canned file set (no fetch, which would 401).
 if(!authHeaders() && window.AO_DEMO && Array.isArray(window.AO_DEMO.files)){
 files = window.AO_DEMO.files;
 if(countEl)countEl.textContent=files.length?`${files.length} file${files.length===1?"":"s"}`:"";
 if(!files.length){ body.innerHTML=`<div class="rb-files-empty">No demo files.</div>`; return; }
 _flRenderList(body, files, true);
 return;
 }
 try{ const r=await fetch("/v1/array-operator/billing/files",{headers:authHeaders()});
 const d=await r.json().catch(()=>({})); if(r.ok)files=Array.isArray(d.files)?d.files:[]; else failed=true;
 }catch(e){ failed=true; }
 // Hard fetch failure (network / 5xx) must NOT read as "No files yet", show an
 // honest error with an inline retry (re-runs loadAcctFiles, no page refresh).
 if(failed){
 if(countEl)countEl.textContent="";
 body.innerHTML=`<div class="rb-files-empty">Couldn't load your files, <a href="#" onclick="window.__aoReloadFiles && window.__aoReloadFiles(); return false;">try again</a>.</div>`;
 return;
 }
 if(countEl)countEl.textContent=files.length?`${files.length} file${files.length===1?"":"s"}`:"";
 if(!files.length){ body.innerHTML=`<div class="rb-files-empty">No files yet. Upload an invoice template on the Reports tab, add a billing workbook, or connect GMP, your invoice, workbook, and utility-bill files collect here.</div>`; return; }
 _flRenderList(body, files, false);
 }
 window.__aoReloadFiles = loadAcctFiles;

 function renderAccountList(a){
 const list = document.getElementById("acctList");
 if(!list) return;
 // Keep the global entitlement in sync with the freshly-fetched account, so the
 // Plan row + tab gating show the REAL plan even when the initial loadEntitlement
 // ran before the session was ready (else the Plan row read null → "Choose your
 // plan" for an operator who's already on Both).
 try {
 if(a && a.plan_features){ _entitlement = a.plan_features; applyTabGating(); }
 } catch(e){}
 const operator = pick(a, ["operator_name","name","owner_name"], "");
 const email = pick(a, ["email","operator_email"], "");
 // Company starts BLANK until the owner fills it in (Ford). New signups no longer
 // seed it, but accounts created by the old onboarding carry a derived junk value
 // ("<Vendor> owner", or the email-derived operator name). Treat those as unset so
 // the field shows its "Add your company name" prompt instead of junk to clear.
 let company = pick(a, ["company_name","company"], "");
 if(company && (/^\s*(SolarEdge|Fronius|SMA|Chint|Locus|Enphase|Solis|Tigo|AlsoEnergy)\s+owner\s*$/i.test(company)
 || (operator && company.trim() === operator.trim()))){
 company = "";
 }

 // Auto-refresh LEADS (Ford: it's the heart of the service) as a full-width panel, then
 // the identity → login & password → plan → bill → payment rows below it.
 // Build identity FIRST so a throw in autoRefreshRow never leaves a blank Account tab.
 let arHtml = "";
 try { arHtml = autoRefreshRow(); } catch(e){
 arHtml = `<section class="ar-stack" id="rowAutoRefresh"><div class="ar-card"><div class="acct-msg err">Auto-refresh panel failed to render, refresh the page. (${esc(String(e && e.message || e).slice(0,80))})</div></div></section>`;
 }
 let rest = "";
 try {
 rest =
 rowEdit("Name", "name", operator, "Your name") +
 rowEdit("Company", "company", company, "Add your company name") +
 rowEdit("Email", "email", email, "you@example.com") +
 rowStatic("Login", `<span id="loginEmail">${esc(email || "—")}</span>`, "the email you sign in with") +
 passwordRow(a) +
 planRow() +
 rowStatic("Your bill",
 `<div class="ao-bill" id="aoBill"><span class="ao-bill-load">Loading…</span></div>`) +
 rowStatic("Payment method",
 `<span id="payState">—</span><div class="acct-msg" id="billMsg"></div>`,
 null,
 `<button class="acct-btn primary" id="billManage" type="button">Add credit card</button>`) +
 `<div class="acct-row acct-pay-setup" id="aoPaySetup">
 <div class="ao-pay-card" id="aoPayCard">
 <div class="ao-pay-card-load">Checking online payments…</div>
 </div>
 </div>` +
 `<div class="acct-row acct-files-row">
 <div class="r-k">Your files <span class="rb-files-count" id="acctFilesCount"></span></div>
 <div class="r-v"><div class="rb-files-body" id="acctFilesBody"><div class="rb-files-empty">Loading…</div></div></div>
 <div class="r-a"></div>
 </div>` +
 cancelRow(a);
 } catch(e){
 rest = `<div class="empty">Part of Account failed to render, <button type="button" class="acct-btn" id="acctRetryLoad">Try again</button></div>`;
 }
 list.innerHTML = arHtml + rest;
 const retry = document.getElementById("acctRetryLoad");
 if(retry) retry.onclick = () => loadAccount();

 // Secondary wiring never blocks identity paint, each call is isolated
 try { wireAcctEdits(); } catch(e){}
 try { wirePlanRow(); } catch(e){}
 try { wirePasswordRow(); } catch(e){}
 try { wireAutoRefreshRow(); } catch(e){
 const listEl = document.getElementById("arList");
 if(listEl) listEl.innerHTML = `<div class="acct-msg err">Couldn't load portal vault, tap ↻ or try again. (${esc(String(e && e.message || e).slice(0,60))})</div>`;
 }
 try { wireCancelRow(); } catch(e){}
 try { loadAcctFiles(); } catch(e){}
 try { renderConnectPayouts(authHeaders()); } catch(e){}
 }

 /** Hand-holding online-pay setup for offtaker invoices.
 * Owner path: one big button → Stripe secure form (bank/card) → back here → done.
 * We create the Connect account, mint Account Links, attach pay URLs to invoices. */
 async function renderConnectPayouts(h){
 const card = document.getElementById("aoPayCard");
 if(!card) return;
 const feeFallback = "0.5%";

 function paint(html){ card.innerHTML = html; }

 // Demo (signed-out)
 if(!h && window.AO_DEMO){
 paint(_payCardHTML({
 state: "ready",
 feeTxt: feeFallback,
 title: "Online payments on (demo)",
 body: "In a real account, every offtaker invoice would include a Pay button. We keep " + feeFallback + "; the rest lands in your bank.",
 cta: null,
 }));
 return;
 }
 if(!h){
 paint(_payCardHTML({
 state: "off",
 feeTxt: feeFallback,
 title: "Get paid online",
 body: "Sign in to turn on pay links for your offtaker invoices.",
 cta: null,
 }));
 return;
 }

 paint(`<div class="ao-pay-card-load">Checking online payments…</div>`);
 let st = null;
 try {
 const r = await fetch("/v1/array-operator/billing/payments/connect", { headers: h });
 if(r.ok) st = await r.json();
 } catch(e){ st = null; }

 // Returning from Stripe Account Link, poll until ready or give a soft nudge.
 let justReturned = false;
 try {
 const q = new URLSearchParams(location.search || "");
 if(q.get("connect") === "return" || q.get("connect") === "refresh"){
 justReturned = true;
 try {
 const u = new URL(location.href);
 u.searchParams.delete("connect");
 history.replaceState({}, "", u.pathname + u.search + (u.hash || "#account"));
 } catch(_){}
 }
 } catch(_){}

 if(!st || !st.ok){
 paint(_payCardHTML({
 state: "err",
 feeTxt: feeFallback,
 title: "Couldn't check payment setup",
 body: "Refresh the page, or try again in a moment.",
 cta: { label: "Try again", action: "retry" },
 }));
 _wirePayCard();
 return;
 }

 const feePct = (st.fee_percent != null ? Number(st.fee_percent) : (Number(st.fee_bps || 50) / 100));
 const feeTxt = (Math.round(feePct * 100) / 100) + "%";

 if(st.ready || st.charges_enabled){
 paint(_payCardHTML({
 state: "ready",
 feeTxt,
 title: "You're set, offtakers can pay online",
 body: "Every invoice email we send now includes a secure <b>Pay</b> button. Money goes to your bank. We keep " + feeTxt + " per payment, that's it.",
 steps: null,
 cta: { label: "Update bank details", action: "update", secondary: true },
 }));
 _wirePayCard();
 return;
 }

 if(st.connected || st.account_id){
 // Mid-flow: they started but didn't finish Stripe's form.
 paint(_payCardHTML({
 state: justReturned ? "almost" : "almost",
 feeTxt,
 title: justReturned ? "Almost done, finish bank details" : "Continue bank setup",
 body: justReturned
 ? "Stripe still needs a couple of details. One more click, enter your bank info, then you're done. We handle the rest."
 : "You're halfway there. Finish entering your bank details on Stripe's secure page. Bank details stay on Stripe.",
 steps: [
 { n: "1", t: "Click below", d: "Opens Stripe's secure form" },
 { n: "2", t: "Enter bank info", d: "Routing + account (or debit card)" },
 { n: "3", t: "We do the rest", d: "Pay buttons appear on every invoice" },
 ],
 cta: { label: "Continue, enter bank info", action: "start" },
 }));
 _wirePayCard();
 // Soft auto-poll a few times if they just returned (webhook lag).
 if(justReturned) _pollConnectReady(8);
 return;
 }

 // Fresh: never started.
 paint(_payCardHTML({
 state: "off",
 feeTxt,
 title: "Get paid online, one setup",
 body: "Offtakers click <b>Pay</b> on their invoice. You get the money in your bank. We keep " + feeTxt + ". Takes about two minutes.",
 steps: [
 { n: "1", t: "Click the button", d: "We open Stripe securely" },
 { n: "2", t: "Enter bank or debit card", d: "You type it once, we never store it" },
 { n: "3", t: "Done forever", d: "Every future invoice gets a Pay button automatically" },
 ],
 cta: { label: "Set up payouts, takes ~2 min", action: "start" },
 }));
 _wirePayCard();
 }

 function _payCardHTML({ state, feeTxt, title, body, steps, cta }){
 const stateCls = state === "ready" ? "is-ready"
 : state === "almost" ? "is-almost"
 : state === "err" ? "is-err" : "is-off";
 const badge = state === "ready" ? "ON"
 : state === "almost" ? "ALMOST"
 : state === "err" ? "RETRY" : "OFF";
 const stepsHtml = (steps && steps.length)
 ? `<ol class="ao-pay-steps">${steps.map(s =>
 `<li><span class="ao-pay-step-n">${s.n}</span><span class="ao-pay-step-t"><b>${s.t}</b><small>${s.d}</small></span></li>`
 ).join("")}</ol>`
 : "";
 const ctaHtml = cta
 ? `<button type="button" class="acct-btn ${cta.secondary ? "" : "primary"} ao-pay-cta" data-pay-action="${cta.action}">${esc(cta.label)}</button>`
 : "";
 return `
 <div class="ao-pay-inner ${stateCls}">
 <div class="ao-pay-head">
 <span class="ao-pay-badge">${badge}</span>
 <div class="ao-pay-titles">
 <div class="ao-pay-k">Collect offtaker payments</div>
 <div class="ao-pay-title">${title}</div>
 </div>
 </div>
 <div class="ao-pay-body">${body}</div>
 ${stepsHtml}
 <div class="ao-pay-foot">
 ${ctaHtml}
 <span class="ao-pay-fee" title="Platform fee on each offtaker card payment">Fee ${esc(feeTxt || "0.5%")} · powered by Stripe</span>
 </div>
 <div class="acct-msg" id="connectMsg"></div>
 </div>`;
 }

 function _wirePayCard(){
 const card = document.getElementById("aoPayCard");
 if(!card) return;
 card.querySelectorAll("[data-pay-action]").forEach(btn => {
 btn.onclick = () => {
 const act = btn.getAttribute("data-pay-action");
 if(act === "retry") renderConnectPayouts(authHeaders());
 else startConnectOnboarding(act !== "update");
 };
 });
 }

 let _connectPollTimer = null;
 function _pollConnectReady(maxTries){
 if(_connectPollTimer) clearInterval(_connectPollTimer);
 let n = 0;
 _connectPollTimer = setInterval(async () => {
 n++;
 try {
 const h = authHeaders();
 if(!h){ clearInterval(_connectPollTimer); return; }
 const r = await fetch("/v1/array-operator/billing/payments/connect", { headers: h });
 if(r.ok){
 const st = await r.json();
 if(st.ready || st.charges_enabled){
 clearInterval(_connectPollTimer);
 renderConnectPayouts(h);
 return;
 }
 }
 } catch(_){}
 if(n >= (maxTries || 8)) clearInterval(_connectPollTimer);
 }, 2500);
 }

 async function startConnectOnboarding(primary){
 const h = authHeaders();
 const msg = document.getElementById("connectMsg");
 const btn = document.querySelector(".ao-pay-cta") || document.getElementById("connectManage");
 if(!h){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Sign in first."; } return; }
 if(msg){ msg.className = "acct-msg"; msg.textContent = "Opening Stripe’s secure bank form…"; }
 if(btn){ btn.disabled = true; btn.textContent = "Opening Stripe…"; }
 try {
 const r = await fetch("/v1/array-operator/billing/payments/connect", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, h),
 body: "{}",
 });
 const d = await r.json().catch(() => ({}));
 // FastAPI HTTPException wraps structured detail.
 const detail = (d && typeof d.detail === "object") ? d.detail : d;
 if(r.ok && d.already_ready){
 if(msg){ msg.className = "acct-msg"; msg.textContent = "Already set up, you're good."; }
 renderConnectPayouts(h);
 return;
 }
 if(r.ok && d.url){
 if(msg){ msg.className = "acct-msg"; msg.textContent = "Redirecting to Stripe, enter your bank, then you'll land back here."; }
 window.location = d.url;
 return;
 }
 const errMsg = (detail && detail.error) || (typeof d.detail === "string" ? d.detail : null)
 || d.error || "Couldn't open bank setup, please try again shortly.";
 if(msg){ msg.className = "acct-msg err"; msg.textContent = errMsg; }
 if(btn){
 btn.disabled = false;
 btn.textContent = (detail && detail.retryable) ? "Try again" : "Set up payouts, takes ~2 min";
 }
 } catch(e){
 if(msg){ msg.className = "acct-msg err"; msg.textContent = "Couldn't reach Stripe, check your connection."; }
 if(btn){ btn.disabled = false; btn.textContent = "Try again"; }
 }
 }

 /* ---- Danger zone: cancel the account.
 * Shown ONLY while trialing (mirrors the NEPOOL React DangerZoneCard gating).
 * Cancelling during a trial is free + immediate: POST /v1/onboarding/cancel-trial
 * flips the tenant to cancelled/active=false, after which the full-page
 * cancelled gate (app.js) takes over on the next load. Post-trial accounts
 * manage cancellation through the Stripe billing portal (Payment method row),
 * so we don't show a separate cancel button for them. ---------------------- */
 function cancelRow(a){
 const st = String((a && (a.subscription_status || a.status)) || "").toLowerCase();
 const onTrial = (a && (a.on_trial === true || a.trial === true)) || st === "trialing";
 if(!onTrial) return "";
 return `<div class="acct-row" id="rowCancel">
 <div class="r-k" style="color:#b4361f;">Cancel account</div>
 <div class="r-v">
 <span>Cancel during your trial, you won't be charged.</span>
 <span class="r-sub">Your data is kept; the dashboard turns off. This can't be undone from here.</span>
 <div class="acct-msg" id="cancelMsg"></div>
 <div id="cancelConfirm" style="display:none;margin-top:8px;">
 <button class="acct-btn" id="cancelKeep" type="button">Keep my account</button>
 <button class="acct-btn" id="cancelYes" type="button"
 style="background:#b4361f;border-color:#b4361f;color:#fff;">Yes, cancel my account</button>
 </div>
 </div>
 <div class="r-a">
 <button class="acct-btn" id="cancelStart" type="button"
 style="color:#b4361f;border-color:#e6b3a8;">Cancel my account</button>
 </div>
 </div>`;
 }

 function wireCancelRow(){
 const start = document.getElementById("cancelStart");
 const confirm = document.getElementById("cancelConfirm");
 const keep = document.getElementById("cancelKeep");
 const yes = document.getElementById("cancelYes");
 const msg = document.getElementById("cancelMsg");
 if(!start || !confirm) return;
 start.addEventListener("click", () => {
 start.style.display = "none";
 confirm.style.display = "";
 });
 if(keep) keep.addEventListener("click", () => {
 confirm.style.display = "none";
 start.style.display = "";
 if(msg){ msg.className = "acct-msg"; msg.textContent = ""; }
 });
 if(yes) yes.addEventListener("click", async () => {
 const h = authHeaders();
 if(!h){ if(msg){ msg.className = "acct-msg err"; msg.textContent = "Please sign in again."; } return; }
 yes.disabled = true; if(keep) keep.disabled = true;
 yes.textContent = "Cancelling…";
 try{
 const r = await fetch("/v1/onboarding/cancel-trial", { method: "POST", headers: h });
 const d = await r.json().catch(() => ({}));
 if(r.ok && (d.ok || d.ok === undefined)){
 // Backend flipped the tenant to cancelled, hand off to the full-page gate.
 if(window.aoShowCancelledGate){ window.aoShowCancelledGate(); }
 else { try { localStorage.removeItem("so_session"); } catch(e){} location.href = "/login"; }
 } else {
 if(msg){ msg.className = "acct-msg err"; msg.textContent = (d && d.detail) ? d.detail : `Couldn't cancel (HTTP ${r.status}).`; }
 yes.disabled = false; if(keep) keep.disabled = false; yes.textContent = "Yes, cancel my account";
 }
 }catch(e){
 if(msg){ msg.className = "acct-msg err"; msg.textContent = "Couldn't reach the server, try again."; }
 yes.disabled = false; if(keep) keep.disabled = false; yes.textContent = "Yes, cancel my account";
 }
 });
 }

 /* ---- Auto-refresh row: manage the EnergyAgent extension's saved portal logins
 * so BOTH live production (inverter portals) and utility bills (GMP / SmartHub
 * co-ops, what powers automatic offtaker invoices + billing reports) stay fresh
 * hands-free. Credentials are stored ENCRYPTED on the owner's own machine (in the
 * extension) and NEVER sent to our servers, this row just reads/writes that local
 * vault through the so_bridge postMessage relay. The vault accepts inverter vendor
 * ids AND utility codes (gmp / vec / wec / discovered sh_* co-ops) with the same
 * set/clear/optout ops; saving a utility login arms its DAILY background bill
 * refresh in the extension. Auto-refresh is ON by default (opt-out, per portal). */
 // Inverter portals are the only three vendors we integrate, so they stay a
 // fixed list. Utility portals are DYNAMIC, we support GMP + ~1,600 SmartHub
 // co-ops/munis (GET /v1/providers), and the extension vault accepts any of
 // them (and multiple logins per utility). See renderUtilityPortals below.
 // Extension-vault / cloud-harvester password portals (browser login). AlsoEnergy
 // + SolarEdge use their own API cards below, not these scrape rows.
 const AR_INVERTERS = [
 { id: "fronius", label: "Fronius (Solar.web)", ph: "Solar.web username / email" },
 { id: "sma", label: "SMA (Sunny Portal)", ph: "Sunny Portal username / email" },
 { id: "chint", label: "Chint", ph: "Chint username / email" },
 ];

 // The utility-provider catalog (code -> label), fetched once from the same
 // registry the extension uses. Powers the "add a utility login" search over
 // every co-op we support, not just a hardcoded three.
 let _utilCatalog = null; // { code: { label, host, state } }
 async function loadUtilCatalog(){
 if(_utilCatalog) return _utilCatalog;
 const map = {};
 try {
 const r = await fetch("/v1/providers", { credentials: "same-origin" });
 const j = await r.json();
 (j && j.providers || []).forEach(p => {
 // Only offer utilities the extension can ACTUALLY capture + auto-refresh:
 // scrape_status "live" == a real SmartHub host (530) or GMP's own adapter.
 // The catalog also lists ~1,092 "in-progress"/"manual" targets that have no
 // portal wired yet, the vault would reject their code, so offering them
 // would be a dead "Failed". (Not-listed utilities go through the "tell us"
 // hint instead.)
 if(p && p.code && p.scrape_status === "live") {
 map[p.code] = { label: p.label || p.code, host: p.smarthub_host || "", state: p.state || "" };
 }
 });
 } catch(e){ /* offline / not present, fall back to code-derived labels */ }
 if(!map.gmp) map.gmp = { label: "Green Mountain Power" }; // GMP isn't a co-op registry row
 // Eversource is a live bespoke Cloud Capture utility (CT/MA/NH); ensure the
 // primary code is always pickable even if a providers fetch lags.
 if(!map.eversource) map.eversource = { label: "Eversource Energy" };
 if(!map.cmp) map.cmp = { label: "Central Maine Power" };
 _utilCatalog = map;
 return map;
 }
 function utilLabelFor(code, catalog){
 const c = catalog && catalog[code];
 if(c && c.label) return c.label + (catalog[code].host ? " (SmartHub)" : "");
 if(code === "gmp") return "Green Mountain Power";
 if(code === "eversource" || code === "eversource_ma" || code === "eversource_ct")
 return "Eversource Energy";
 if(code === "cmp") return "Central Maine Power";
 if(/^sh_/.test(code)) return code.replace(/^sh_/, "").replace(/[-_]/g, " ").toUpperCase() + " (SmartHub)";
 return code.toUpperCase();
 }
 const _arAddedUtils = new Set(); // utility codes the operator picked this session (show an empty card to fill)
 // Utilities the operator asked us to ADD (not in the catalog yet). Queued locally so
 // they can fire off a bunch fast, then submitted as one batch to /v1/utility-requests
 // → an agent researches + wires each one in. Persisted so a reload doesn't lose them.
 let _arUtilReqQueue = (() => {
 try { return JSON.parse(localStorage.getItem("ao_util_req_queue") || "[]"); } catch (e) { return []; }
 })();
 function _saveUtilReqQueue() {
 try { localStorage.setItem("ao_util_req_queue", JSON.stringify(_arUtilReqQueue)); } catch (e) {}
 }
 let _vaultReq = {}; // reqId → resolver, for bridge acks
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
 if(e.source !== window || e.origin !== window.location.origin) return;
 const d = e.data; if(!d || d.type !== "SO_VAULT_ACK" || !d.reqId) return;
 const r = _vaultReq[d.reqId]; if(r){ delete _vaultReq[d.reqId]; r(d); }
 });

 // ── Cloud Capture: the SERVER-SIDE alternative to the on-device extension vault.
 // Same panel, same cred cards, but in "cloud" mode a saved login is stored
 // (encrypted) on our servers and refreshed by a headless-browser farm 24/7, so
 // the owner never has to keep a tab open. cloudOp mirrors vaultOp's shape so the
 // render + row wiring are reused; only the data source + destination differ.
 const AR_MODE_KEY = "ao_ar_mode";
 let _arWantOpen = false; // set by __aoOpenCredentialVault → wireAutoRefreshRow opens+scrolls the panel
 let _arWantFocus = null; // "inverter" | "utility" | null
 function _arGetMode(){ try { return localStorage.getItem(AR_MODE_KEY) === "cloud" ? "cloud" : "device"; } catch(e){ return "device"; } }
 function _arSetMode(m){
 const mode = m === "cloud" ? "cloud" : "device";
 try { localStorage.setItem(AR_MODE_KEY, mode); } catch(e){}
 // Persist server-side too, so the choice follows the owner across browsers/devices
 // (the whole reason a cloud onboarding could read as "extension" elsewhere).
 const h = authHeaders();
 if(h){ try { fetch("/v1/account/capture-mode", { method:"POST",
 headers: Object.assign({ "Content-Type":"application/json" }, h),
 body: JSON.stringify({ mode }) }).catch(()=>{}); } catch(e){} }
 }
 // Reconcile the capture mode with the SERVER on account load: the server value is
 // authoritative (survives devices); if the server has none yet but this device does,
 // push the local choice up so it persists. Called with the fetched /v1/account.
 function _arSyncModeFromAccount(a){
 try {
 const srv = a && a.capture_mode;
 if(srv === "cloud" || srv === "device"){
 if(localStorage.getItem(AR_MODE_KEY) !== srv) localStorage.setItem(AR_MODE_KEY, srv);
 } else {
 const local = localStorage.getItem(AR_MODE_KEY);
 const h = authHeaders();
 if((local === "cloud" || local === "device") && h){
 fetch("/v1/account/capture-mode", { method:"POST",
 headers: Object.assign({ "Content-Type":"application/json" }, h),
 body: JSON.stringify({ mode: local }) }).catch(()=>{});
 }
 }
 } catch(e){}
 }
 const AR_INVERTER_IDS = new Set((typeof AR_INVERTERS !== "undefined" ? AR_INVERTERS : []).map(v => v.id));

 async function cloudOp(op, extra){
 const h = authHeaders();
 if(!h) return { ok:false, error:"signin" };
 const H = Object.assign({ "Content-Type":"application/json" }, h);
 try {
 if(op === "status"){
 const r = await fetch("/v1/cloud-capture/status", { headers:h });
 if(!r.ok) return { ok:false, error:"http_"+r.status };
 return Object.assign({ ok:true }, await r.json());
 }
 if(op === "set"){
 const r = await fetch("/v1/cloud-capture/credentials", { method:"POST", headers:H, body:JSON.stringify({
 provider: extra.provider, username: extra.username, password: extra.password,
 login_host: extra.login_host || null, enable: true, consent: extra.consent === true }) });
 const d = await r.json().catch(()=>({}));
 return { ok: r.ok, error: r.ok ? null : (typeof d.detail === "string" ? d.detail : "http_"+r.status) };
 }
 if(op === "clear"){
 const r = await fetch("/v1/cloud-capture/credentials", { method:"DELETE", headers:H, body:JSON.stringify({
 provider: extra.provider, username: extra.username }) });
 return { ok: r.ok };
 }
 if(op === "toggle"){
 const r = await fetch("/v1/cloud-capture/toggle", { method:"POST", headers:H, body:JSON.stringify({
 provider: extra.provider, username: extra.username, enable: extra.enable }) });
 return { ok: r.ok };
 }
 if(op === "refresh"){
 const r = await fetch("/v1/cloud-capture/refresh", { method:"POST", headers:H });
 const d = await r.json().catch(()=>({}));
 return { ok: r.ok, queued: d.queued || 0 };
 }
 } catch(e){ return { ok:false, error:String(e) }; }
 return { ok:false, error:"bad_op" };
 }
 // Cloud "Sync all" for the vendor spreadsheet (vendor-sheet.js lives in another
 // module, so expose the op as a global). Forces a fresh server-side capture NOW.
 window.__aoCloudRefresh = () => cloudOp("refresh");
 // Per-login cloud harvest health, so other surfaces (the vendor sheet) can tell a
 // real login failure apart from a source pause/night, and only accuse the password
 // when the login is genuinely failing (Ford 2026-07-13).
 window.__aoCloudStatus = () => cloudOp("status");
 // "+ Add vendor" in cloud mode → the Credential Vault is where a server-side login
 // is added, so jump straight there (Master Account → Auto-refresh, cloud mode,
 // expanded + scrolled). Reuses the panel's own open/scroll/flash via _arWantOpen.
 // focus: "inverter" | "utility" | null — scroll to that portal group in Account vault
 window.__aoOpenCredentialVault = function(focus){
 _arSetMode("cloud");
 _arWantOpen = true;
 _arWantFocus = focus === "utility" ? "utility" : (focus === "inverter" ? "inverter" : null);
 if(location.hash !== "#account"){ location.hash = "#account"; }
 else { try { wireAutoRefreshRow(); } catch(e){} }
 };

 // Adapt the cloud /status payload onto the SAME shape the extension vault status
 // uses, so credRow/utilByCode render identically. Utility logins key on a slot
 // ("code" for the first, "code::username" for extra); inverters key on the id.
 function cloudStatusToShape(cs){
 const shape = {};
 const seen = {};
 (cs.credentials || []).forEach(c => {
 const code = (c.provider || "").toLowerCase();
 const isInv = AR_INVERTER_IDS.has(code);
 const uKey = (c.username || "").toLowerCase();
 // Slot EVERY provider's 2nd+ login under "code::username", inverters too
 // (Ford 2026-07-10: link N SMA/Fronius/Chint accounts under one master).
 // The backend already stores N per (provider, username); this stops the
 // inverter rows collapsing onto one bare-code slot.
 const slot = seen[code] ? (code + "::" + uKey) : code; seen[code] = true;
 shape[slot] = {
 hasCreds: true, enabled: c.enabled !== false, username: c.username || "",
 utility: !isInv, inverter: isInv, code: code, host: c.login_host || "",
 // extra cloud-only health, surfaced by the card as a freshness hint.
 // _cloudStatus is the RAW harvest outcome (ok|login_failed|scrape_failed|…)
 //, needed so the status line can tell "wrong password" (login_failed, the
 // only real credential issue) apart from a post-login data-pull hiccup
 // (scrape_failed etc.) that a bare ok/not-ok boolean can't distinguish
 // (Ford 2026-07-12: Chint kept saying "check the password" on a correct
 // password because of exactly this, see solar-operator cloud_capture.py).
 _cloudOk: c.last_harvest_ok, _cloudAt: c.last_harvest_at, _cloudFails: c.harvest_fails || 0,
 _cloudStatus: c.last_harvest_status || null,
 };
 });
 return shape;
 }

 // Paint the device/cloud segmented control: mark the active option, swap the
 // header's privacy copy to be HONEST about where the password lives in each
 // mode, and (once) wire the clicks to switch mode + re-render.
 const AR_COPY = {
 device: `Keeps your live production and utility bills fresh automatically. Saved <b>only on this device</b>, encrypted, never sent to our servers. On by default; turn off any portal anytime.`,
 cloud: `Your <b>Credential Vault</b>. Each login you add is <b>stored on our servers</b>, encrypted, so we sign in for you and refresh your data <b>around the clock, no browser tab needed</b>. Live inverter production is kept <b>under 5 minutes old</b>; utility bills refresh daily. Remove any login anytime.`,
 };
 function _arWireModeSwitch(){
 const wrap = document.getElementById("arMode");
 const sub = document.getElementById("arPanelSub");
 if(!wrap) return;
 const mode = _arGetMode();
 wrap.querySelectorAll(".ar-mode-opt").forEach(b => {
 b.classList.toggle("active", b.dataset.mode === mode);
 b.setAttribute("aria-selected", String(b.dataset.mode === mode));
 });
 if(sub) sub.innerHTML = AR_COPY[mode] || AR_COPY.device;
 if(!wrap._wired){
 wrap._wired = true;
 wrap.addEventListener("click", (e) => {
 const b = e.target.closest(".ar-mode-opt"); if(!b) return;
 e.preventDefault();
 e.stopPropagation();
 if(b.dataset.mode === _arGetMode()) return;
 _arSetMode(b.dataset.mode);
 _vaultStatusCache = null;
 // Mode flip MUST keep logins visible, collapsing here felt like "everything
 // disappeared" (only Name/Company/Email left below). Force open every switch.
 try {
 if(typeof _arSetBodyOpen === "function") _arSetBodyOpen(true);
 else {
 const body = document.getElementById("arBody");
 if(body) body.classList.remove("ar-collapsed");
 localStorage.setItem("ao_ar_open", "1");
 }
 } catch(_){}
 // Optimistic paint so the vault never goes blank mid-fetch
 try {
 const listEl = document.getElementById("arList");
 if(listEl){
 listEl.innerHTML = `<div class="acct-msg" id="arMsg">Switching capture mode, loading portals…</div>`;
 }
 } catch(_){}
 wireAutoRefreshRow();
 });
 }
 }

 // Explicit opt-in consent gate for cloud mode: no password is stored on our
 // servers until the owner ticks this box (mirrored by the backend, which 422s a
 // password save without consent=true). Persisted so it stays ticked.
 const AR_CONSENT_KEY = "ao_cc_consent";
 function _arConsentOk(){
 const chk = document.getElementById("arConsentChk");
 if(chk) return chk.checked;
 try { return localStorage.getItem(AR_CONSENT_KEY) === "1"; } catch(e){ return false; }
 }
 function _arConsentHTML(){
 let saved = false; try { saved = localStorage.getItem(AR_CONSENT_KEY) === "1"; } catch(e){}
 return `<label class="ar-consent" id="arConsent">
 <input type="checkbox" id="arConsentChk" ${saved ? "checked" : ""}>
 <span>I authorize EnergyAgent to securely store my portal passwords on its servers and sign in
 on my behalf to keep my data fresh. I agree to the
 <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and
 <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
 </label>`;
 }
 function _arCloudWarnHTML(){
 return `<div class="ar-cloud-warn">⚠ <b>Heads up:</b> because we sign in from our servers,
 your provider (Google, or the portal itself) may send a one-time
 &ldquo;suspicious sign-in&rdquo; security alert the first time. That&rsquo;s expected, it&rsquo;s
 us signing in on your behalf, and it&rsquo;s safe to approve. Prefer no alerts? Use
 <b>&ldquo;Keep it on my computer&rdquo;</b> instead.</div>`;
 }
 function _arWireConsent(){
 const chk = document.getElementById("arConsentChk");
 if(chk && !chk._wired){
 chk._wired = true;
 chk.addEventListener("change", () => {
 try { localStorage.setItem(AR_CONSENT_KEY, chk.checked ? "1" : "0"); } catch(e){}
 });
 }
 }

 // Extension v1.9.109+: a page-initiated credential save waits for a one-click
 // confirm in the extension popup. Watch the vault until that vendor's creds
 // appear (the owner confirmed), then re-render so the row flips to "On" live —
 // no reload, no extra clicks here. Bounded (~2 min), one watcher per vendor.
 const _vaultWatch = {};
 function watchVaultConfirm(vendor){
 if(_vaultWatch[vendor]) return;
 let ticks = 0;
 _vaultWatch[vendor] = setInterval(async () => {
 ticks++;
 const resp = await vaultOp("status");
 const st = resp && resp.ok && resp.status && resp.status[vendor];
 if(st && st.hasCreds){
 clearInterval(_vaultWatch[vendor]); delete _vaultWatch[vendor];
 _notifyVaultChanged();
 wireAutoRefreshRow(); wireAutoLoginHints().catch(()=>{});
 } else if(ticks >= 40){ // ~2 min, stop polling quietly, the note stays
 clearInterval(_vaultWatch[vendor]); delete _vaultWatch[vendor];
 }
 }, 3000);
 }

 // Shared vault-status read for OTHER modules (reports.js's invoice-generator
 // automation cue), same cached channel this panel uses, so one query serves
 // the whole page. Resolves {} when the extension isn't present/reachable, so
 // callers can distinguish "no creds" from "can't know" via EXT_PRESENT.
 window.__aoVaultStatus = async function(){
 if(!EXT_PRESENT) return null;
 if(_vaultStatusCache) return _vaultStatusCache;
 const resp = await vaultOp("status");
 if(resp && resp.ok){ _vaultStatusCache = resp.status || {}; return _vaultStatusCache; }
 return null;
 };

 // Live-sync with the EnergyAgent popup (Ford 2026-07-10: "fill it in one place, it
 // should show in the other"). The popup writes the SAME vault, but it lives in a
 // separate window, the page never hears about a save/remove made there. So whenever
 // this tab regains focus (returning from the popup) and the Auto-refresh panel is on
 // screen, drop the cached status and re-query, so a login just saved in the extension
 // appears here without a manual reload. Debounced; a no-op when the panel isn't shown.
 let _arFocusQueued = false;
 function _arRefreshOnFocus(){
 if(_arFocusQueued) return;
 if(location.hash !== "#account" || !document.getElementById("arList")) return;
 _arFocusQueued = true;
 setTimeout(() => {
 _arFocusQueued = false;
 _vaultStatusCache = null;
 if(location.hash === "#account" && document.getElementById("arList")) wireAutoRefreshRow();
 }, 150);
 }
 document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") _arRefreshOnFocus(); });
 window.addEventListener("focus", _arRefreshOnFocus);

 // Fill the auto-login hint placeholders on every extension-captured array card.
 // Runs after each canvas render; cached so vault is only queried once per session
 // (invalidated by vault save so the hints disappear immediately after credentials are saved).
 async function wireAutoLoginHints(){
 if(!EXT_PRESENT) return;
 if(!_vaultStatusCache){
 const resp = await vaultOp("status");
 if(resp && resp.ok) _vaultStatusCache = resp.status || {};
 else return;
 }
 document.querySelectorAll(".sb-autologin-hint[data-vendor]").forEach(el => {
 const vendor = el.dataset.vendor;
 if(!vendor || !_EXT_VAULT_VENDORS.has(vendor)) return;
 const st = (_vaultStatusCache[vendor]) || { hasCreds:false };
 if(st.hasCreds){ el.innerHTML = ""; el.style.display = "none"; return; }
 if(el.innerHTML) return; // already filled this render
 const label = (typeof BRAND !== "undefined" && BRAND[vendor]) || vendor;
 // A coverage gap (stale capture) turns the gentle nudge into a specific one:
 // name the gap, explain it's how this vendor undercounts, and offer the fix.
 const gapAge = el.dataset.gapAge || "";
 el.style.display = "";
 el.classList.toggle("gap", !!gapAge);
 el.innerHTML = gapAge
 ? `<span class="sb-al-ic" aria-hidden="true">⚡</span>` +
 `<span><b>${esc(label)}</b> last synced ${esc(gapAge)}, it only updates when you open the portal. ` +
 `Save your login so it refreshes itself and stops missing production, ` +
 `<a href="#account" class="sb-al-link">set up auto-login →</a></span>`
 : `<span class="sb-al-ic" aria-hidden="true">⚡</span>` +
 `<span>Save your <b>${esc(label)}</b> login for hands-free live updates, ` +
 `<a href="#account" class="sb-al-link">set up auto-login →</a></span>`;
 el.querySelector(".sb-al-link").addEventListener("click", e => {
 e.preventDefault();
 location.hash = "#account";
 setTimeout(() => {
 const row = document.getElementById("rowAutoRefresh");
 if(row) row.scrollIntoView({ behavior:"smooth", block:"center" });
 }, 120);
 });
 });
 }

 // ── The LIVE data board: "what we have + what we're doing" (Ford 2026-07-11).
 // One dense row per saved login, a pulsing GREEN dot when it's live, the last
 // refresh in tabular figures, so a curious operator can literally watch us
 // pulling their data. Cloud mode carries real server freshness
 // (_cloudAt/_cloudOk/_cloudFails); device mode has no server timestamps, so it
 // reads "on device / refreshes on open". Octarine frames it (the vault's
 // signature); green/amber/red are reserved strictly for live STATE.
 function _arLiveRank(dot){ return dot === "err" ? 0 : dot === "warn" ? 1 : dot === "live" ? 2 : 3; }
 // Labels for LIVE-board rows (vault + API-linked sources).
 const _AR_LIVE_LABELS = {
 solaredge: "SolarEdge", alsoenergy: "AlsoEnergy (PowerTrack)", locus: "Locus Energy",
 fronius: "Fronius (Solar.web)", sma: "SMA (Sunny Portal)", chint: "Chint",
 enphase: "Enphase", solis: "Solis", tigo: "Tigo",
 gmp: "Green Mountain Power (GMP)", vec: "Vermont Electric Cooperative (SmartHub)",
 wec: "Washington Electric Coop (SmartHub)",
 eversource: "Eversource Energy", eversource_ma: "Eversource Energy (MA)",
 eversource_ct: "Eversource Energy (CT)", cmp: "Central Maine Power",
 };
 // API-polled vendors (no vault password), always use server freshness branch.
 const _AR_API_VENDORS = new Set(["solaredge","alsoenergy","locus","enphase","solis","tigo"]);

 // Merge GET /linked-sources into the vault/cloud status map so the LIVE board
 // lists every linked vendor + utility, not only harvester/vault logins.
 async function _arMergeLinkedSources(status){
 const out = Object.assign({}, status || {});
 try{
 const r = await fetch("/v1/array-owners/linked-sources", { headers: authHeaders() });
 if(!r.ok) return out;
 const d = await r.json().catch(() => ({}));
 (d.sources || []).forEach(src => {
 const code = (src.code || "").toLowerCase();
 if(!code) return;
 const isInv = src.kind === "inverter";
 const existing = out[code];
 // Prefer a richer vault row when it already has a real username; only
 // fill gaps (API vendors / utilities never stored in the vault).
 if(existing && existing.hasCreds && (existing.username || "").trim()
 && !(existing.username || "").includes(" array")){
 // Still upgrade freshness if linked-sources is newer
 if(src.last_synced_at && (!existing._cloudAt
 || Date.parse(src.last_synced_at) > Date.parse(existing._cloudAt))){
 existing._cloudAt = src.last_synced_at;
 if(existing._cloudOk == null) existing._cloudOk = true;
 }
 return;
 }
 out[code] = {
 hasCreds: true,
 enabled: true,
 code,
 inverter: isInv,
 utility: !isInv,
 username: src.detail || (src.count ? `${src.count} linked` : "linked"),
 _cloudOk: !!src.last_synced_at,
 _cloudAt: src.last_synced_at || null,
 _cloudFails: 0,
 _cloudStatus: src.last_synced_at ? "ok" : null,
 _fromLinked: true,
 };
 });
 }catch(e){ /* best-effort */ }
 // Keep the existing SolarEdge keys injection as a richer override when present
 try{
 const seR = await fetch("/v1/array-owners/solaredge/keys", { headers: authHeaders() });
 if(seR.ok){
 const seD = await seR.json().catch(() => ({}));
 const seKeys = seD.keys || [];
 if(seKeys.length){
 const seArrays = new Set(); seKeys.forEach(k => (k.arrays || []).forEach(a => seArrays.add(a)));
 out.solaredge = {
 hasCreds: true, enabled: true, code: "solaredge", inverter: true, utility: false,
 username: `${seKeys.length} key${seKeys.length === 1 ? "" : "s"} · ${seArrays.size} array${seArrays.size === 1 ? "" : "s"}`,
 _cloudOk: !!seD.last_synced_at, _cloudAt: seD.last_synced_at || null, _cloudFails: 0,
 _cloudStatus: seD.last_synced_at ? "ok" : null,
 };
 }
 }
 }catch(e){}
 return out;
 }

 function buildLiveBoardHTML(status, mode, catalog){
 const rows = [];
 let live = 0, inv = 0, util = 0, freshest = 0;
 Object.keys(status).forEach(k => {
 const s = status[k]; if(!s || !s.hasCreds) return;
 const code = (s.code || k).toLowerCase();
 // Skip multi-login vault slots (code::username), base code already listed,
 // or include them as separate rows only when username differs from the base.
 if(code.includes("::") && status[code.split("::")[0]] && status[code.split("::")[0]].hasCreds){
 // still show multi-login extras under the same board as separate rows
 }
 const isInv = !!s.inverter || AR_INVERTER_IDS.has(code) || _AR_API_VENDORS.has(code)
 || !!(s.code && _AR_LIVE_LABELS[s.code] && !s.utility);
 let name;
 if(_AR_LIVE_LABELS[code]) name = _AR_LIVE_LABELS[code];
 else if(isInv){
 const v = AR_INVERTERS.find(x => x.id === code);
 name = v ? v.label : code.toUpperCase();
 } else { name = utilLabelFor(code, catalog); }
 const enabled = s.enabled !== false;
 const fails = s._cloudFails || 0, at = s._cloudAt || null, ok = s._cloudOk, hStatus = s._cloudStatus;
 let dot, stag, stxt, tTxt;
 if(!enabled){ dot = "off"; stag = "off"; stxt = "Paused"; tTxt = "—"; }
 // API vendors + cloud mode use server freshness (never "on device only").
 else if(mode === "cloud" || _AR_API_VENDORS.has(code) || s._fromLinked){
 // Only a REAL login_failed is a credential problem, a bare ok===false also
 // covers scrape_failed (signed in fine, the data pull hit a transient snag,
 // doesn't count toward `fails`) and shouldn't blame the password. See the
 // matching fix in credRow's cloudLine (Ford 2026-07-12, Chint).
 if(fails >= 3){ dot = "err"; stag = "err"; stxt = "Sign-in failed"; tTxt = at ? _flAgo(at) : "—"; }
 else if(at && ok === false && hStatus === "login_failed"){ dot = "err"; stag = "err"; stxt = "Check password"; tTxt = _flAgo(at); }
 else if(at && ok === false){ dot = "warn"; stag = "warn"; stxt = "Retrying"; tTxt = _flAgo(at); }
 else if(at){ dot = "live"; stag = "live"; stxt = "Live"; tTxt = _flAgo(at); }
 else { dot = "warn"; stag = "warn"; stxt = "Starting"; tTxt = "queued"; }
 } else {
 dot = "live"; stag = "live"; stxt = "On device"; tTxt = "on open";
 }
 if(dot === "live"){ live++; if(at){ const t = Date.parse(at); if(t && t > freshest) freshest = t; } }
 if(isInv) inv++; else util++;
 rows.push({ name, user: s.username || "", dot, stag, stxt, tTxt, isInv, rank: _arLiveRank(dot) });
 });
 const n = rows.length;
 rows.sort((a, b) => a.rank - b.rank || (a.isInv === b.isInv ? 0 : (a.isInv ? -1 : 1)) || a.name.localeCompare(b.name));
 const parts = [];
 if(inv) parts.push(`<b>${inv}</b> inverter${inv === 1 ? "" : "s"}`);
 if(util) parts.push(`<b>${util}</b> utilit${util === 1 ? "y" : "ies"}`);
 const countHTML = n ? `<b>${n}</b> connected${parts.length ? " · " + parts.join(" · ") : ""}` : "No portals connected";
 let freshHTML;
 if(mode === "cloud") freshHTML = freshest ? `Updated <b>${_flAgo(new Date(freshest).toISOString())}</b>` : (n ? "First refresh queued" : "");
 else freshHTML = n ? "Refreshes while a tab is open" : "";
 const rowsHTML = rows.map(r =>
 `<div class="ar-live-row">
 <span class="ar-live-dot ${r.dot}"></span>
 <span class="ar-live-name"><b>${esc(r.name)}</b><span class="mono">${esc(r.user || "—")}</span></span>
 <span class="ar-live-meta"><span class="t">${esc(r.tTxt)}</span><span class="s ${r.stag}">${esc(r.stxt)}</span></span>
 </div>`).join("");
 return `<div class="ar-live ${n ? "" : "empty"}" id="arLiveBoard">
 <div class="ar-live-head">
 <span class="ar-live-badge"><span class="ar-live-dot ${live > 0 ? "live" : "off"}"></span>Live</span>
 <span class="ar-live-count">${countHTML}</span>
 ${freshHTML ? `<span class="ar-live-fresh">${freshHTML}</span>` : ""}
 </div>
 ${n ? `<div class="ar-live-rows">${rowsHTML}</div>`
 : `<div class="ar-live-empty">Nothing connected yet, <b>add a login below</b> and it comes online here, with a live status you can watch.</div>`}
 </div>`;
 }

 // Keep the board alive: in cloud mode (real server freshness) re-query status every
 // 30s and repaint ONLY the board, timestamps tick, dots flip, without disturbing a
 // half-typed credential. One interval; pauses when the panel is hidden/collapsed or a
 // field is focused. Device mode has no server clock, so no tick (the board is static).
 let _arLiveTick = null;
 // ADAPTIVE cadence (Ford 2026-07-12, live: "these need to load faster"): while any login
 // is still spinning up (queued / starting, not yet live), poll every 4s so the board flips
 // to live the moment the server captures. Once everything is live it backs off to 30s (just
 // ticking timestamps). Fires an IMMEDIATE poll on start instead of waiting a full interval.
 function _arStopLiveTick(){ if(_arLiveTick){ clearTimeout(_arLiveTick); _arLiveTick = null; } }
 function _arStartLiveTick(){
 _arStopLiveTick();
 if(_arGetMode() !== "cloud") return;
 const step = async () => {
 _arLiveTick = null;
 const board = document.getElementById("arLiveBoard");
 if(!board) return; // board gone → stop the loop
 let delay = 30000;
 const body = document.getElementById("arBody");
 const ae = document.activeElement;
 const paused = location.hash !== "#account"
 || (body && body.classList.contains("ar-collapsed"))
 || (ae && ae.closest && ae.closest(".ar-fields"));
 if(!paused){
 const cs = await cloudOp("status");
 const cur = document.getElementById("arLiveBoard");
 if(cur && cs && cs.ok){
 let shape = cloudStatusToShape(cs);
 shape = await _arMergeLinkedSources(shape);
 const catalog = await loadUtilCatalog();
 cur.outerHTML = buildLiveBoardHTML(shape, "cloud", catalog);
 // Anything not yet live (queued/starting/warn) → keep polling fast.
 const spinning = Object.keys(shape || {}).some(k => {
 const s = shape[k]; return s && s.hasCreds && s._cloudOk !== true;
 });
 delay = spinning ? 4000 : 30000;
 } else if(!cur){ return; }
 } else { delay = 4000; } // paused → re-check soon
 _arLiveTick = setTimeout(step, delay);
 };
 step(); // immediate first poll
 }

 // Auto-refresh is the heart of the service, so it leads the Master Account tab.
 // Stack of separate glass cards (Ford 2026-07-13): head / live / consent /
 // inverter group / utility group, gaps between them let the sky bleed through
 // instead of one monolithic vault slab. #rowAutoRefresh wraps the stack for
 // scroll/flash targets; #arBody holds the body cards (collapse target).
 function autoRefreshRow(){
 return `<section class="ar-stack" id="rowAutoRefresh">
 <div class="ar-panel ar-card ar-card-head">
 <div class="ar-panel-head">
 <button type="button" class="ar-panel-ic" id="arRefreshBtn" title="Refresh now" aria-label="Refresh cloud status now">↻</button>
 <div class="ar-panel-hd">
 <h3>Auto-refresh<span class="ar-panel-stat" id="arPanelStat"></span>
 <button type="button" class="ar-toggle open" id="arToggle" aria-expanded="true" title="Show or hide logins">
 <span class="ar-caret" aria-hidden="true">▸</span>
 <span class="ar-toggle-lab">Hide logins</span>
 </button>
 </h3>
 <p id="arPanelSub">Keeps your live production and utility bills fresh automatically. Saved <b>only on this device</b>, encrypted, never sent to our servers. On by default; turn off any portal anytime.</p>
 <div class="ar-mode" id="arMode" role="tablist" aria-label="How we keep your data fresh">
 <button type="button" class="ar-mode-opt" data-mode="cloud" role="tab" aria-selected="false">
 <b>Store it with us</b>
 <span>Encrypted on our servers. Live data 24/7, no tab or computer needed.</span>
 </button>
 <button type="button" class="ar-mode-opt" data-mode="device" role="tab" aria-selected="false">
 <b>Keep it on my computer</b>
 <span>Passwords stay in the browser extension. Refreshes while a tab is open.</span>
 </button>
 </div>
 </div>
 </div>
 </div>
 <div class="ar-body" id="arBody">
 <div class="ar-list" id="arList"><div class="acct-msg" id="arMsg">Loading portals…</div></div>
 </div>
 <button type="button" class="ar-show-logins" id="arShowLogins" hidden>
 Show inverter &amp; utility logins →
 </button>
 </section>`;
 }

 // Serialize concurrent status pulls so a slow cloud/device flip can't wipe a
 // newer render (or leave the vault looking "gone").
 let _arWireGen = 0;

 function _arSetBodyOpen(open){
 const body = document.getElementById("arBody");
 const toggle = document.getElementById("arToggle");
 const showBtn = document.getElementById("arShowLogins");
 if(body) body.classList.toggle("ar-collapsed", !open);
 if(toggle){
 toggle.classList.toggle("open", open);
 toggle.setAttribute("aria-expanded", String(open));
 const lab = toggle.querySelector(".ar-toggle-lab");
 if(lab) lab.textContent = open ? "Hide logins" : "Show logins";
 }
 if(showBtn) showBtn.hidden = !!open;
 try { localStorage.setItem("ao_ar_open", open ? "1" : "0"); } catch(e){}
 }

 async function wireAutoRefreshRow(){
 const gen = ++_arWireGen;
 // Collapsible ONLY via the explicit Show/Hide control, never by clicking the
 // whole Auto-refresh card. Dogfood: clicking near "Store it with us" collapsed
 // arBody (display:none) and every portal/LIVE row vanished, leaving only Name/Email.
 const row = document.getElementById("rowAutoRefresh");
 const toggle = document.getElementById("arToggle");
 const body = document.getElementById("arBody");
 const showBtn = document.getElementById("arShowLogins");
 // Hands-off walkthrough lives as the bottom-left Setup FAB (hands-off-tour.js),
 // not a second link under Auto-refresh (Ford 2026-07-14).
 if(toggle && !toggle._wired){
 toggle._wired = true;
 toggle.addEventListener("click", (e) => {
 e.preventDefault(); e.stopPropagation();
 const currentlyOpen = body && !body.classList.contains("ar-collapsed");
 _arSetBodyOpen(!currentlyOpen);
 });
 }
 if(showBtn && !showBtn._wired){
 showBtn._wired = true;
 showBtn.addEventListener("click", (e) => {
 e.preventDefault(); e.stopPropagation();
 _arSetBodyOpen(true);
 try { body && body.scrollIntoView({ behavior:"smooth", block:"nearest" }); } catch(err){}
 });
 }
 // Default OPEN unless the user explicitly hid logins (and never leave a
 // "vanished vault" after mode switch, see _arWireModeSwitch).
 try {
 const pref = localStorage.getItem("ao_ar_open");
 if(pref === "0") _arSetBodyOpen(false);
 else _arSetBodyOpen(true);
 } catch(e){ _arSetBodyOpen(true); }
 // Kill any legacy whole-card collapse handler (older builds attached it to #rowAutoRefresh).
 if(row && row._wiredCollapse){
 try { row.removeEventListener("click", row._wiredCollapse); } catch(e){}
 row._wiredCollapse = null;
 }
 row && (row._wired = true);
 // Arrived from onboarding's "skip for now" (cloud path, no logins added yet) —
 // open, scroll to, and flash the Auto-refresh panel so they land exactly where
 // credentials get added (Ford 2026-07-11). One-shot; strips the param after.
 try{
 const _sp = new URLSearchParams(location.search);
 // Open + scroll + flash the panel when arriving from onboarding's "skip for
 // now" (?setup=autorefresh) OR from the spreadsheet's "+ Add vendor" in cloud
 // mode (_arWantOpen, set by __aoOpenCredentialVault), both land the operator
 // exactly where a login gets added.
 const _fromParam = _sp.get("setup") === "autorefresh" && !window._arSetupHandled;
 if(_fromParam || _arWantOpen){
 if(_fromParam) window._arSetupHandled = true;
 const _focus = _arWantFocus;
 _arWantOpen = false;
 _arWantFocus = null;
 const _row = document.getElementById("rowAutoRefresh");
 const _body = document.getElementById("arBody");
 _arSetBodyOpen(true); // ensure logins visible
 // Prefer the real portal sections (Inverter / Utility) — not the setup rail form
 const _scrollTarget = () => {
 const list = document.getElementById("arList");
 if(_focus === "utility"){
 return list && (list.querySelector(".ar-group-util") || list.querySelector(".ar-group:not(.ar-group-inv)"));
 }
 if(_focus === "inverter"){
 return list && list.querySelector(".ar-group-inv");
 }
 return _row;
 };
 setTimeout(() => {
 const t = _scrollTarget() || _row;
 if(t) t.scrollIntoView({ behavior:"smooth", block:"start" });
 if(_row){
 _row.classList.add("ar-flash");
 setTimeout(() => _row.classList.remove("ar-flash"), 2600);
 }
 // Pulse the target portal group so "type here" is obvious
 try{
 const g = _scrollTarget();
 if(g && g.classList){
 g.classList.add("ar-group-focus");
 setTimeout(() => g.classList.remove("ar-group-focus"), 2800);
 }
 }catch(e){}
 }, 80);
 if(_fromParam){
 _sp.delete("setup");
 history.replaceState(null, "", location.pathname + (_sp.toString() ? "?"+_sp.toString() : "") + location.hash);
 }
 }
 }catch(e){}
 const listEl = document.getElementById("arList");
 if(!listEl) return;
 // Mode: on-device (extension vault) vs hands-off cloud (server-side harvest).
 _arWireModeSwitch();
 // The header ↻ is a LIVE refresh button (Ford 2026-07-11): it spins while a
 // status pull is in flight, so a slow load reads as "working", not "stuck" —
 // and re-pulls on click. Wired once; the spin is driven by every load below.
 const _arRefreshBtn = document.getElementById("arRefreshBtn");
 if(_arRefreshBtn && !_arRefreshBtn._wired){
 _arRefreshBtn._wired = true;
 _arRefreshBtn.addEventListener("click", (e) => {
 e.stopPropagation(); // don't collapse the panel
 if(_arRefreshBtn.classList.contains("ar-spinning")) return; // a pull is already running
 _vaultStatusCache = null; // force a fresh pull, not the cache
 wireAutoRefreshRow(); // re-fetch + re-render (spins itself)
 });
 }
 const _arStopSpin = () => { if(_arRefreshBtn) setTimeout(() => _arRefreshBtn.classList.remove("ar-spinning"), 450); };
 if(_arRefreshBtn) _arRefreshBtn.classList.add("ar-spinning"); // spin while THIS load runs
 const mode = _arGetMode();
 let status = {};
 if(mode === "cloud"){
 const cs = await cloudOp("status");
 if(gen !== _arWireGen){ _arStopSpin(); return; } // superseded by a newer wire
 if(!cs || !cs.ok){
 // Keep any existing portal markup if we already painted once, only replace
 // with a soft error strip, never a blank Account tab.
 const err = (cs && cs.error === "signin")
 ? `Sign in to set up hands-off cloud refresh.`
 : `Couldn't load cloud refresh status, tap ↻ to retry.`;
 if(!listEl.querySelector(".ar-card-group")){
 listEl.innerHTML = `<div class="acct-msg err">${err}</div>`;
 } else {
 let banner = listEl.querySelector(".ar-load-err");
 if(!banner){
 banner = document.createElement("div");
 banner.className = "acct-msg err ar-load-err";
 listEl.prepend(banner);
 }
 banner.textContent = err;
 }
 _arStopSpin();
 return;
 }
 status = cloudStatusToShape(cs);
 } else {
 if(!EXT_PRESENT){
 if(gen !== _arWireGen){ _arStopSpin(); return; }
 // Still show the portal shells empty + install CTA (don't blank the vault)
 listEl.innerHTML =
 `<div class="acct-msg">Install the free EnergyAgent helper for on-device auto-refresh, or switch back to <b>Store it with us</b> above (no helper needed). <a href="onboarding.html" style="color:var(--good)">Get the helper →</a></div>` +
 `<div class="ar-card ar-card-group"><div class="ar-group ar-group-inv">
 <div class="ar-group-head"><span class="ar-group-title">Inverter portals</span><span class="ar-group-sub">Available after the helper is installed, or switch to cloud mode.</span></div>
 </div></div>`;
 _arStopSpin();
 return;
 }
 const resp = await vaultOp("status");
 if(gen !== _arWireGen){ _arStopSpin(); return; }
 if(!resp || !resp.ok){
 const err = `Couldn't reach the EnergyAgent helper. Make sure it's installed and tap ↻ to retry.`;
 if(!listEl.querySelector(".ar-card-group")){
 listEl.innerHTML = `<div class="acct-msg err">${err}</div>`;
 } else {
 let banner = listEl.querySelector(".ar-load-err");
 if(!banner){
 banner = document.createElement("div");
 banner.className = "acct-msg err ar-load-err";
 listEl.prepend(banner);
 }
 banner.textContent = err;
 }
 _arStopSpin();
 return;
 }
 status = resp.status || {};
 }
 const catalog = await loadUtilCatalog();
 if(gen !== _arWireGen){ _arStopSpin(); return; }

 // Merge every linked inverter/API/utility source (AlsoEnergy, SolarEdge,
 // Locus, GMP bill accounts, …) into `status` so the LIVE board lists them
 // even when they aren't portal-vault logins (Ford 2026-07-13).
 status = await _arMergeLinkedSources(status);
 if(gen !== _arWireGen){ _arStopSpin(); return; }

 // ── a single credential row (save/replace + optional remove) ──
 // key = the vault key clear/optout act on (an inverter id, or a utility slot).
 // saveCode = the code `set` writes under (a utility's base code, or the id).
 // prefillUser = a saved login's username (shown so multiple logins are distinct).
 const credRow = (opts) => {
 const { key, saveCode, label, ph, hasCreds, enabled, prefillUser, addLabel, cloudStat } = opts;
 const on = hasCreds && enabled;
 const stateTxt = hasCreds ? (enabled ? "On" : "Off") : "";
 const stateCls = on ? "on" : (hasCreds ? "off" : "");
 const userVal = prefillUser ? ` value="${esc(prefillUser)}"` : "";
 // Cloud mode: an explicit status line so a saved login is unmistakable and
 // its refresh state is visible (saved → first pull → connected, or an issue).
 let cloudLine = "";
 if(mode === "cloud" && hasCreds){
 const cs = cloudStat || {};
 if((cs.fails || 0) >= 3) cloudLine = `<div class="ar-cloud-stat err">⚠ Paused, re-enter your password to retry</div>`;
 else if(cs.at && cs.ok === false && cs.status === "login_failed") cloudLine = `<div class="ar-cloud-stat err">⚠ Couldn't sign in, check the password</div>`;
 else if(cs.at && cs.ok === false) cloudLine = `<div class="ar-cloud-stat err">⚠ Signed in fine, the last data pull hit a snag, retrying automatically</div>`;
 else if(cs.at) cloudLine = `<div class="ar-cloud-stat ok">✓ Connected, refreshing automatically</div>`;
 else cloudLine = `<div class="ar-cloud-stat ok">✓ Saved, first refresh starting…</div>`;
 }
 // data-origuser = the username this row already owns (case-insensitive match
 // skips self when checking for a duplicate against other saved logins).
 const origUser = hasCreds && prefillUser ? ` data-origuser="${esc((prefillUser || "").trim().toLowerCase())}"` : "";
 return `<div class="ar-row" data-key="${esc(key)}" data-savecode="${esc(saveCode)}" data-hascreds="${hasCreds ? "1" : "0"}"${origUser}>
 <div class="ar-row-top">
 ${label ? `<span class="ar-vendor">${esc(label)}</span>` : ""}
 ${hasCreds ? `<span class="ar-badge ${stateCls}">${stateTxt}</span>
 <label class="ar-switch"><input type="checkbox" class="ar-optout" ${!enabled ? "checked" : ""}><span>off</span></label>` : ""}
 </div>
 ${cloudLine}
 <div class="ar-dup-hint" hidden aria-live="polite"></div>
 <div class="ar-fields">
 <input class="ar-user" type="text" autocomplete="off"${userVal} placeholder="${esc(ph || "Portal username / email")}">
 <input class="ar-pass" type="password" autocomplete="off" placeholder="${hasCreds ? "•••••••• (saved, type to replace)" : "Portal password"}">
 <div class="ar-actions">
 <button class="acct-btn primary ar-save" type="button">${hasCreds ? "Save" : (addLabel || "Save")}</button>
 ${hasCreds ? `<button class="acct-btn ar-clear" type="button">Remove</button>` : ""}
 </div>
 </div>
 </div>`;
 };

 // Group saved UTILITY logins by their base code (multi-login: a code can own
 // several "code::username" slots, the vault reports each as its own entry).
 const utilByCode = {}; // code -> [{ slot, username, enabled }]
 Object.keys(status).forEach(k => {
 const s = status[k];
 if(!s || !s.utility || !s.hasCreds) return;
 const code = s.code || k;
 (utilByCode[code] = utilByCode[code] || []).push({ slot: k, username: s.username || "", enabled: s.enabled !== false, ok: s._cloudOk, at: s._cloudAt, fails: s._cloudFails, status: s._cloudStatus });
 });
 // Same grouping for INVERTER logins so a vendor card can list N logins (Ford
 // 2026-07-10). Only cloud mode reports slotted inverter entries; on-device
 // (extension) mode still returns one bare-code inverter entry (single login
 // until the extension supports slots), so invByCode is empty there and the
 // inverter section falls back to the single-row render below.
 const invByCode = {}; // code -> [{ slot, username, enabled }]
 Object.keys(status).forEach(k => {
 const s = status[k];
 if(!s || !s.inverter || !s.hasCreds) return;
 const code = s.code || k;
 (invByCode[code] = invByCode[code] || []).push({ slot: k, username: s.username || "", enabled: s.enabled !== false, ok: s._cloudOk, at: s._cloudAt, fails: s._cloudFails, status: s._cloudStatus });
 });
 // Which utilities to show as cards: GMP + Eversource (common defaults) + every
 // one with a saved login + anything the operator just picked this session.
 const shownCodes = [];
 const pushCode = (c) => { if(c && shownCodes.indexOf(c) === -1) shownCodes.push(c); };
 pushCode("gmp");
 pushCode("eversource");
 pushCode("cmp");
 Object.keys(utilByCode).sort().forEach(pushCode);
 (_arAddedUtils || []).forEach(pushCode);

 const utilCard = (code) => {
 const logins = utilByCode[code] || [];
 const name = utilLabelFor(code, catalog);
 const savedRows = logins.map(l => credRow({
 key: l.slot, saveCode: code, label: "", ph: "username / email",
 hasCreds: true, enabled: l.enabled, prefillUser: l.username,
 cloudStat: { ok: l.ok, at: l.at, fails: l.fails, status: l.status },
 })).join("");
 const addRow = credRow({
 key: code + "::__new__", saveCode: code, label: "",
 ph: logins.length ? "another username / email" : "portal username / email",
 hasCreds: false, addLabel: logins.length ? "Add login" : "Save",
 });
 return `<div class="ar-util" data-code="${esc(code)}">
 <div class="ar-util-name">${esc(name)}</div>
 ${savedRows}${addRow}
 </div>`;
 };

 // An inverter-vendor card with N logins + an "add another" row, the same
 // multi-login UX as utilities (Ford 2026-07-10: 10 SMA accounts under one
 // master). Cloud mode only; each saved login is its own username-keyed row,
 // and one login already covers all plants under that portal account.
 const invCard = (v) => {
 const logins = invByCode[v.id] || [];
 const savedRows = logins.map(l => credRow({
 key: l.slot, saveCode: v.id, label: "", ph: "username / email",
 hasCreds: true, enabled: l.enabled, prefillUser: l.username,
 cloudStat: { ok: l.ok, at: l.at, fails: l.fails, status: l.status },
 })).join("");
 const addRow = credRow({
 key: v.id + "::__new__", saveCode: v.id, label: "",
 ph: logins.length ? "another username / email" : v.ph,
 hasCreds: false, addLabel: logins.length ? "Add login" : "Save",
 });
 return `<div class="ar-util" data-code="${esc(v.id)}">
 <div class="ar-util-name">${esc(v.label)}</div>
 ${savedRows}${addRow}
 </div>`;
 };

 // SolarEdge is deliberately absent from AR_INVERTERS: it connects with its
 // OWN monitoring API key, not a portal username/password, so it never had a
 // vault entry, and so it never had ANY row in this panel at all (Ford
 // 2026-07-12: "no option to put in your SolarEdge login", there truly wasn't
 // one). It's mode-independent (the key lives with SolarEdge's own servers,
 // not our extension vault or cloud-capture harvester), so it renders the
 // SAME regardless of the Device/Cloud toggle above. Reuses the existing
 // connect-account endpoint (same one "Add an array" already calls), this
 // is just giving it a visible home next to the other portals instead of only
 // being reachable through a different modal.
 const seCount = (() => {
 try { return (window.FleetStore && FleetStore.snapshot().arrays || []).filter(a => a.vendor === "solaredge").length; }
 catch (e) { return 0; }
 })();
 // The connected keys list (.ar-se-keys) is filled async by loadSolarEdgeKeys()
 // below; "+ Add another key" reveals the key input (.ar-se-add), matching how
 // the other vendor cards reveal an "add login" field (Ford 2026-07-10).
 const solarEdgeCardHTML = () => `<div class="ar-util" data-code="solaredge">
 <div class="ar-util-name">SolarEdge</div>
 <div class="ar-cloud-stat" style="color:var(--faint)">API key · every site on the account</div>
 <div class="ar-se-keys" aria-live="polite"></div>
 <button type="button" class="acct-btn ar-se-addbtn" hidden>+ Add another key</button>
 <div class="ar-fields ar-se-add" hidden>
 <input class="ar-se-key" type="text" autocomplete="off" placeholder="SolarEdge API key">
 <div class="ar-actions">
 <button class="acct-btn primary ar-se-save" type="button">Connect</button>
 <button class="acct-btn ar-se-cancel" type="button" hidden>Cancel</button>
 </div>
 </div>
 <div class="ar-se-stat ar-cloud-stat" aria-live="polite"></div>
 </div>`;

 // AlsoEnergy PowerTrack, username+password API (not extension vault). Same
 // home as SolarEdge so it's "right there" with the other inverter sources.
 const alsoEnergyCardHTML = () => {
 let nAe = 0;
 try {
 nAe = (window.FleetStore && FleetStore.snapshot().arrays || [])
 .filter(a => (a.vendor || a.source_vendor) === "alsoenergy").length;
 } catch (e) {}
 const stat = nAe
 ? `<div class="ar-cloud-stat" style="color:var(--good,#0a7d4f)">${nAe} array${nAe===1?"":"s"} connected</div>`
 : `<div class="ar-cloud-stat" style="color:var(--faint)">One login · every site on the account</div>`;
 return `<div class="ar-util" data-code="alsoenergy">
 <div class="ar-util-name">AlsoEnergy (PowerTrack)</div>
 ${stat}
 <div class="ar-fields ar-ae-add">
 <input class="ar-ae-user" type="email" autocomplete="username" placeholder="PowerTrack username (email)">
 <input class="ar-ae-pass" type="password" autocomplete="current-password" placeholder="PowerTrack password">
 <div class="ar-actions">
 <button class="acct-btn primary ar-ae-save" type="button">Connect all sites</button>
 </div>
 </div>
 <div class="ar-ae-stat ar-cloud-stat" aria-live="polite"></div>
 </div>`;
 };

 // Vault inverter cards (Fronius / SMA / Chint), same markup for cloud vs device.
 const vaultInvHTML = mode === "cloud"
 ? AR_INVERTERS.map(invCard).join("")
 : AR_INVERTERS.map(v => {
 const st = status[v.id] || { hasCreds:false, enabled:true };
 return credRow({ key: v.id, saveCode: v.id, label: v.label, ph: v.ph, hasCreds: !!st.hasCreds, enabled: st.enabled !== false, prefillUser: st.username || "", cloudStat: { ok: st._cloudOk, at: st._cloudAt, fails: st._cloudFails, status: st._cloudStatus } });
 }).join("");

 listEl.innerHTML = `
 <div class="ar-card ar-card-live">${buildLiveBoardHTML(status, mode, catalog)}</div>
 ${mode === "cloud" ? `<div class="ar-card ar-card-consent">${_arConsentHTML()}${_arCloudWarnHTML()}</div>` : ""}
 <div class="ar-card ar-card-group">
 <div class="ar-group ar-group-inv">
 <div class="ar-group-head"><span class="ar-group-title">Inverter portals</span><span class="ar-group-sub">${mode === "cloud" ? "Live production, pulled server-side and kept under 5 minutes old. Add a login for each portal account; link several under one vendor." : "Live production, refreshed automatically every few minutes."}</span></div>
 <div class="ar-inv-row ar-inv-api">
 ${alsoEnergyCardHTML()}
 ${solarEdgeCardHTML()}
 </div>
 <div class="ar-inv-row ar-inv-vault">
 ${vaultInvHTML}
 </div>
 </div>
 </div>
 <div class="ar-card ar-card-group">
 <div class="ar-group ar-group-util">
 <div class="ar-group-head"><span class="ar-group-title">Utility portals</span><span class="ar-group-sub">Utility bills, refreshed daily, powers automatic offtaker invoices and billing reports. Add a login for each utility you bill through.</span></div>
 ${shownCodes.map(utilCard).join("")}
 <div class="ar-addutil">
 <button type="button" class="acct-btn ar-addutil-btn">+ Add a utility login</button>
 <div class="ar-picker" hidden>
 <div class="ar-picker-shell">
 <input type="text" class="ar-picker-search" autocomplete="off" placeholder="Search your utility, GMP, a co-op, a city…" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="arPickerList">
 <div class="ar-req-queue" hidden></div>
 <div class="ar-picker-results" id="arPickerList" role="listbox"></div>
 </div>
 </div>
 </div>
 </div>
 </div>`;

 // Panel stat, how many portals are actively refreshing (a quiet health signal).
 const statEl = document.getElementById("arPanelStat");
 if(statEl){
 let on = 0;
 // Count every saved + enabled login (each is a refreshing portal), one loop
 // now that inverters are slotted like utilities in cloud mode.
 Object.keys(status).forEach(k => { const s = status[k]; if(s && s.hasCreds && s.enabled !== false) on++; });
 statEl.textContent = on ? `${on} portal${on === 1 ? "" : "s"} refreshing` : "";
 statEl.className = "ar-panel-stat" + (on ? " on" : "");
 }

 _arWireConsent();
 // ── SolarEdge: connect with an API key, straight to the same endpoint
 // "Add an array" uses (/v1/array-owners/solaredge/connect-account). No vault,
 // no on/off toggle, no username, it's not a saved-login credential, it's a
 // direct key-based connection that discovers + attaches every site on the
 // account (matching existing arrays, creating new ones for the rest).
 const seSave = listEl.querySelector(".ar-se-save");
 if (seSave) {
 const seKeyEl = listEl.querySelector(".ar-se-key");
 const seStat = listEl.querySelector(".ar-se-stat");
 const seLabel = seSave.textContent;
 seSave.addEventListener("click", async () => {
 const key = (seKeyEl.value || "").trim();
 if (!key) { seSave.textContent = "Paste a key"; setTimeout(() => seSave.textContent = seLabel, 1500); return; }
 seSave.disabled = true; seSave.textContent = "Connecting…";
 if (seStat) { seStat.className = "ar-se-stat ar-cloud-stat"; seStat.textContent = ""; }
 try {
 if (window.__aoPendingFeeds) {
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, "solaredge", {
 label: "SolarEdge",
 note: "api key connect, discovering sites",
 });
 }
 const r = await fetch("/v1/array-owners/solaredge/connect-account", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ api_key: key }),
 });
 const d = await r.json().catch(() => ({}));
 if (r.ok && d.ok) {
 seKeyEl.value = "";
 if (seStat) { seStat.className = "ar-se-stat ar-cloud-stat ok"; seStat.textContent = d.message || "Connected."; }
 try {
 if (window.FleetStore && FleetStore.refetch) await FleetStore.refetch();
 if (window.__aoPendingFeeds) {
 window.__aoPendingFeeds.reconcile((FleetStore.snapshot() || {}).arrays || []);
 window.__aoPendingFeeds.startPoll();
 }
 } catch (e) {}
 setTimeout(() => { wireAutoRefreshRow(); }, 900);
 } else {
 try { if (window.__aoPendingFeeds) window.__aoPendingFeeds.clear("solaredge"); } catch (e) {}
 const msg = (d && d.detail) ? d.detail : ("Couldn't connect (HTTP " + r.status + ").");
 if (seStat) { seStat.className = "ar-se-stat ar-cloud-stat err"; seStat.textContent = msg; }
 seSave.disabled = false; seSave.textContent = seLabel;
 }
 } catch (e) {
 try { if (window.__aoPendingFeeds) window.__aoPendingFeeds.clear("solaredge"); } catch (e2) {}
 if (seStat) { seStat.className = "ar-se-stat ar-cloud-stat err"; seStat.textContent = "Network error. Try again."; }
 seSave.disabled = false; seSave.textContent = seLabel;
 }
 });
 }
 // ── AlsoEnergy PowerTrack: username+password → connect-account (all sites)
 const aeSave = listEl.querySelector(".ar-ae-save");
 if (aeSave) {
 const aeUser = listEl.querySelector(".ar-ae-user");
 const aePass = listEl.querySelector(".ar-ae-pass");
 const aeStat = listEl.querySelector(".ar-ae-stat");
 const aeLabel = aeSave.textContent;
 aeSave.addEventListener("click", async () => {
 const username = (aeUser && aeUser.value || "").trim();
 const password = (aePass && aePass.value) || "";
 if (!username || !password) {
 aeSave.textContent = "Enter login";
 setTimeout(() => aeSave.textContent = aeLabel, 1500);
 return;
 }
 aeSave.disabled = true; aeSave.textContent = "Connecting…";
 if (aeStat) { aeStat.className = "ar-ae-stat ar-cloud-stat"; aeStat.textContent = ""; }
 try {
 if (window.__aoPendingFeeds) {
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, "alsoenergy", {
 label: "AlsoEnergy",
 note: "api connect, discovering sites",
 });
 }
 const r = await fetch("/v1/array-owners/alsoenergy/connect-account", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: JSON.stringify({ username, password }),
 });
 const d = await r.json().catch(() => ({}));
 if (r.ok && d.ok) {
 if (aePass) aePass.value = "";
 if (aeStat) {
 aeStat.className = "ar-ae-stat ar-cloud-stat ok";
 aeStat.textContent = d.message || "Connected.";
 }
 try {
 if (window.FleetStore && FleetStore.refetch) await FleetStore.refetch();
 if (window.__aoPendingFeeds) {
 window.__aoPendingFeeds.reconcile((FleetStore.snapshot() || {}).arrays || []);
 window.__aoPendingFeeds.startPoll();
 }
 } catch (e) {}
 setTimeout(() => { wireAutoRefreshRow(); }, 900);
 } else {
 try { if (window.__aoPendingFeeds) window.__aoPendingFeeds.clear("alsoenergy"); } catch (e) {}
 const msg = (d && d.detail) ? d.detail : ("Couldn't connect (HTTP " + r.status + ").");
 if (aeStat) { aeStat.className = "ar-ae-stat ar-cloud-stat err"; aeStat.textContent = msg; }
 aeSave.disabled = false; aeSave.textContent = aeLabel;
 }
 } catch (e) {
 try { if (window.__aoPendingFeeds) window.__aoPendingFeeds.clear("alsoenergy"); } catch (e2) {}
 if (aeStat) { aeStat.className = "ar-ae-stat ar-cloud-stat err"; aeStat.textContent = "Network error. Try again."; }
 aeSave.disabled = false; aeSave.textContent = aeLabel;
 }
 });
 }
 // Show the SolarEdge key(s) already connected (masked, with a reveal toggle), and
 // make "+ Add another key" reveal the key input, like the other cards' add-login.
 (async function loadSolarEdgeKeys(){
 const keysEl = listEl.querySelector(".ar-se-keys");
 const addBtn = listEl.querySelector(".ar-se-addbtn");
 const addWrap = listEl.querySelector(".ar-se-add");
 const cancel = addWrap && addWrap.querySelector(".ar-se-cancel");
 if (!keysEl || !addBtn || !addWrap) return;
 let keys = [];
 try {
 const r = await fetch("/v1/array-owners/solaredge/keys", { headers: authHeaders() });
 if (r.ok) { const d = await r.json().catch(()=>({})); keys = d.keys || []; }
 } catch(e) {}
 if (keys.length) {
 keysEl.innerHTML = keys.map(k => `<div class="ar-se-krow">
 <span class="ar-se-kdot">✓</span>
 <code class="ar-se-kval" data-full="${esc(k.key)}" data-masked="${esc(k.masked)}">${esc(k.masked)}</code>
 <button type="button" class="ar-se-reveal" title="Show / hide the full key">show</button>
 <span class="ar-se-karr" title="${esc(k.arrays.join(', '))}">${k.array_count} array${k.array_count===1?"":"s"}</span>
 </div>`).join("");
 addBtn.hidden = false; addWrap.hidden = true;
 if (cancel) cancel.hidden = false;
 keysEl.querySelectorAll(".ar-se-reveal").forEach(btn => btn.onclick = () => {
 const code = btn.parentElement.querySelector(".ar-se-kval");
 const masked = code.textContent === code.dataset.masked;
 code.textContent = masked ? code.dataset.full : code.dataset.masked;
 btn.textContent = masked ? "hide" : "show";
 });
 } else {
 keysEl.innerHTML = "";
 addBtn.hidden = true; addWrap.hidden = false;
 if (cancel) cancel.hidden = true;
 }
 addBtn.onclick = () => { addBtn.hidden = true; addWrap.hidden = false;
 const inp = addWrap.querySelector(".ar-se-key"); if (inp) inp.focus(); };
 if (cancel) cancel.onclick = () => { addWrap.hidden = true; addBtn.hidden = false;
 const inp = addWrap.querySelector(".ar-se-key"); if (inp) inp.value = ""; };
 })();
 // Known usernames per provider, live duplicate detection on the add-login
 // row (and when a saved row's username is retargeted onto another login).
 // Backend keys PortalCredential on (tenant, provider, username_lc), so a
 // second save with the same username silently upserts; surface that here.
 const knownUsersByCode = {};
 Object.keys(status).forEach(k => {
 const s = status[k];
 if(!s || !s.hasCreds) return;
 const code = s.code || k;
 const u = (s.username || "").trim();
 if(!u) return;
 (knownUsersByCode[code] = knownUsersByCode[code] || []).push({
 username: u, usernameLc: u.toLowerCase(), slot: k,
 });
 });

 // ── wire credential rows (inverter + utility) ──
 listEl.querySelectorAll(".ar-row").forEach(row => {
 const key = row.dataset.key;
 const saveCode = row.dataset.savecode;
 const userEl = row.querySelector(".ar-user");
 const passEl = row.querySelector(".ar-pass");
 const saveBtn = row.querySelector(".ar-save");
 const clearBtn = row.querySelector(".ar-clear");
 const optEl = row.querySelector(".ar-optout");
 const dupHint = row.querySelector(".ar-dup-hint");
 const baseLabel = saveBtn.textContent;
 let savedLabel = baseLabel;
 // Co-op logins need their portal host so the cloud farm knows which
 // *.smarthub.coop to open; the catalog carries it.
 const cloudHost = (catalog[saveCode] && catalog[saveCode].host) || "";
 const origUserLc = (row.dataset.origuser || "").trim().toLowerCase();
 const isAddRow = row.dataset.hascreds !== "1";
 // True when the typed username already exists under this provider as a
 // DIFFERENT login (self-match on a saved row is not a duplicate).
 const findDup = () => {
 const uLc = (userEl.value || "").trim().toLowerCase();
 if(!uLc) return null;
 const known = knownUsersByCode[saveCode] || [];
 return known.find(k => k.usernameLc === uLc && k.usernameLc !== origUserLc) || null;
 };
 const paintDup = () => {
 if(!dupHint) return false;
 const hit = findDup();
 if(hit){
 row.classList.add("ar-row-dup");
 userEl.classList.add("ar-user-dup");
 dupHint.hidden = false;
 dupHint.innerHTML = isAddRow
 ? `⚠ <b>Already in your vault</b>, <code>${esc(hit.username)}</code> is saved for this portal. Saving updates that login’s password (doesn’t add a second copy).`
 : `⚠ <b>Duplicate username</b>, <code>${esc(hit.username)}</code> is already saved for this portal. Saving updates that existing login instead.`;
 if(isAddRow){
 savedLabel = "Update existing";
 if(saveBtn.textContent === baseLabel || saveBtn.textContent === "Add login" || saveBtn.textContent === "Save"){
 saveBtn.textContent = savedLabel;
 }
 }
 return true;
 }
 row.classList.remove("ar-row-dup");
 userEl.classList.remove("ar-user-dup");
 dupHint.hidden = true;
 dupHint.textContent = "";
 if(isAddRow){
 savedLabel = baseLabel;
 if(saveBtn.textContent === "Update existing") saveBtn.textContent = baseLabel;
 }
 return false;
 };
 userEl.addEventListener("input", paintDup);
 userEl.addEventListener("blur", paintDup);
 paintDup();
 saveBtn.addEventListener("click", async () => {
 const u = (userEl.value||"").trim(), p = passEl.value||"";
 if(!u || !p){ saveBtn.textContent = "Enter both"; setTimeout(()=>saveBtn.textContent=savedLabel,1500); return; }
 const isDup = !!findDup();
 paintDup();
 saveBtn.textContent = isDup ? "Updating…" : "Saving…";
 if(mode === "cloud"){
 if(!_arConsentOk()){
 saveBtn.textContent = "Check the box ↑";
 const c = document.getElementById("arConsent");
 if(c){ c.classList.add("ar-consent-flash"); setTimeout(()=>c.classList.remove("ar-consent-flash"), 1500); c.scrollIntoView({behavior:"smooth", block:"nearest"}); }
 setTimeout(()=>saveBtn.textContent=savedLabel, 1800);
 return;
 }
 const r = await cloudOp("set", { provider: saveCode, username:u, password:p, login_host: cloudHost, consent: true });
 passEl.value = "";
 if(r.ok){
 saveBtn.textContent = isDup ? "✓ Updated" : "✓ Saved";
 saveBtn.classList.add("ar-saved-ok");
 // Every inverter portal harvest can take 30–60s, Connecting… for all vendors
 try {
 if(window.__aoPendingFeeds){
 const mark = window.__aoPendingFeeds.markInverter || window.__aoPendingFeeds.mark;
 mark.call(window.__aoPendingFeeds, saveCode, {
 label: (BRAND[saveCode] || saveCode),
 note: "cloud harvest starting",
 rearm: true,
 });
 }
 } catch(e){}
 // Kick harvester so the login doesn't sit until the next cron tick
 try {
 await cloudOp("refresh");
 } catch(e){
 try {
 await fetch("/v1/cloud-capture/refresh", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
 body: "{}",
 });
 } catch(e2){}
 }
 // Re-render so the row flips to the saved "On" state with a status line.
 setTimeout(() => { wireAutoRefreshRow(); }, 700);
 } else {
 const msg = (r.error === "http_403") ? "Not enabled yet"
 : (r.error && r.error.length && r.error.length < 60) ? r.error : "Couldn't save, try again";
 saveBtn.textContent = "✕ " + msg;
 saveBtn.classList.add("ar-save-err");
 setTimeout(() => { saveBtn.textContent = savedLabel; saveBtn.classList.remove("ar-save-err"); }, 4000);
 }
 return;
 }
 // Always set() under the base code + username: the vault matches an existing
 // username to overwrite its slot, or mints a new "code::username" slot for a
 // NEW login, so "add another login" and "replace password" are the same call.
 const r = await vaultOp("set", { vendor: saveCode, username:u, password:p });
 passEl.value = "";
 if(r && r.pending){
 saveBtn.textContent = "One step left";
 let note = row.querySelector(".ar-pending-note");
 if(!note){
 note = document.createElement("div");
 note.className = "ar-pending-note";
 const fields = row.querySelector(".ar-fields");
 if(fields) fields.appendChild(note); else row.appendChild(note);
 }
 note.innerHTML = `Click the <b>EnergyAgent</b> icon in your browser toolbar and press <b>Save &amp; turn on</b>, your password stays encrypted on this device.`;
 _vaultStatusCache = null;
 watchVaultConfirm(saveCode);
 return;
 }
 saveBtn.textContent = r.ok ? (isDup ? "✓ Updated" : "✓ Saved") : "Failed";
 if(r.ok) _notifyVaultChanged(); else _vaultStatusCache = null;
 setTimeout(() => { wireAutoRefreshRow(); wireAutoLoginHints().catch(()=>{}); }, 800);
 });
 if(clearBtn) clearBtn.addEventListener("click", async () => {
 if(mode === "cloud"){
 await cloudOp("clear", { provider: saveCode, username: (userEl.value||"").trim() });
 wireAutoRefreshRow();
 return;
 }
 await vaultOp("clear", { vendor: key });
 _notifyVaultChanged();
 wireAutoRefreshRow(); wireAutoLoginHints().catch(()=>{});
 });
 if(optEl) optEl.addEventListener("change", async () => {
 if(mode === "cloud"){
 await cloudOp("toggle", { provider: saveCode, username: (userEl.value||"").trim(), enable: !optEl.checked });
 wireAutoRefreshRow();
 return;
 }
 await vaultOp("optout", { vendor: key, optedOut: optEl.checked });
 wireAutoRefreshRow();
 });
 });

 // ── wire the "add a utility login" searchable picker over the whole catalog ──
 // Combobox UX (Ford 2026-07-13): the results panel ALWAYS stays a real list —
 // never swaps into a vanishing strip. No-match → a pickable "Request …" row
 // in the same style as catalog hits; keyboard ↑↓/Enter works; queueing shows
 // a clear ✓ flash so it feels like the action landed.
 const addBtn = listEl.querySelector(".ar-addutil-btn");
 const picker = listEl.querySelector(".ar-picker");
 const searchEl = listEl.querySelector(".ar-picker-search");
 const resultsEl = listEl.querySelector(".ar-picker-results");
 const queueEl = listEl.querySelector(".ar-req-queue");
 const codes = Object.keys(catalog);
 let _pickIdx = -1; // keyboard highlight index into current .ar-picker-item nodes
 let _flashTimer = null;

 if(addBtn && picker){
 addBtn.addEventListener("click", () => {
 picker.hidden = !picker.hidden;
 if(!picker.hidden){
 setTimeout(() => searchEl && searchEl.focus(), 30);
 renderReqQueue();
 renderResults();
 }
 });
 }

 // Queue a "please add this utility" request. One click / Enter → chip; Send batch.
 function _queueUtilReq(name){
 const n = (name || "").trim();
 if(!n || !resultsEl) return;
 const key = n.toLowerCase();
 const already = _arUtilReqQueue.some(r => (r.name || "").toLowerCase() === key);
 if(!already){
 _arUtilReqQueue.push({ name: n.slice(0, 120) });
 _saveUtilReqQueue();
 }
 // Visible confirmation INSIDE the list (old UX cleared the field with no flash
 //, felt like the dropdown ate the action).
 if(_flashTimer) clearTimeout(_flashTimer);
 resultsEl.innerHTML =
 `<div class="ar-picker-queued" role="status">` +
 `<span class="ar-picker-queued-check">✓</span>` +
 (already
 ? `<span><b>${esc(n)}</b> is already on your request list</span>`
 : `<span>Queued <b>${esc(n)}</b>, keep typing to add more, then Send</span>`) +
 `</div>`;
 searchEl.value = "";
 renderReqQueue();
 searchEl.focus();
 _flashTimer = setTimeout(() => { renderResults(); }, 1100);
 }
 function renderReqQueue(){
 if(!queueEl) return;
 const q = _arUtilReqQueue;
 if(!q.length){ queueEl.hidden = true; queueEl.innerHTML = ""; return; }
 queueEl.hidden = false;
 queueEl.innerHTML =
 `<div class="ar-req-head">${q.length} utilit${q.length === 1 ? "y" : "ies"} to request</div>` +
 `<div class="ar-req-chips">` +
 q.map((r, i) => `<span class="ar-req-chip">${esc(r.name)}<button type="button" class="ar-req-x" data-i="${i}" title="Remove" aria-label="Remove">×</button></span>`).join("") +
 `</div>` +
 `<div class="ar-req-actions"><button type="button" class="ar-req-send">Send ${q.length} request${q.length === 1 ? "" : "s"} →</button></div>`;
 queueEl.querySelectorAll(".ar-req-x").forEach(x => x.addEventListener("click", (e) => {
 e.stopPropagation();
 _arUtilReqQueue.splice(+x.dataset.i, 1); _saveUtilReqQueue(); renderReqQueue();
 }));
 const sendBtn = queueEl.querySelector(".ar-req-send");
 if(sendBtn) sendBtn.addEventListener("click", (e) => { e.stopPropagation(); _sendUtilReqs(sendBtn); });
 }
 async function _sendUtilReqs(btn){
 if(!_arUtilReqQueue.length) return;
 btn.disabled = true; btn.textContent = "Sending…";
 const payload = { requests: _arUtilReqQueue.map(r => ({ name: r.name })) };
 const s = (() => { try { return localStorage.getItem("so_session") || ""; } catch(e){ return ""; } })();
 try{
 const r = await fetch("/v1/utility-requests", {
 method: "POST",
 headers: Object.assign({ "Content-Type":"application/json" }, s ? { Authorization: "Bearer " + s } : {}),
 body: JSON.stringify(payload),
 });
 const d = await r.json().catch(() => ({}));
 if(!r.ok || d.ok === false) throw new Error("bad response");
 const n = d.count || _arUtilReqQueue.length;
 _arUtilReqQueue = []; _saveUtilReqQueue();
 queueEl.hidden = false;
 queueEl.innerHTML = `<div class="ar-req-done">✓ On it, an agent is wiring up ${n} utilit${n === 1 ? "y" : "ies"}. We’ll email you as each goes live; connect it here the moment it does.</div>`;
 }catch(e){
 btn.disabled = false; btn.textContent = `Send ${_arUtilReqQueue.length} request${_arUtilReqQueue.length === 1 ? "" : "s"} →`;
 let err = queueEl.querySelector(".ar-req-err");
 if(!err){ err = document.createElement("div"); err.className = "ar-req-err"; queueEl.appendChild(err); }
 err.textContent = "Couldn’t send just now, your list is saved, try Send again.";
 }
 }

 function _matchCodes(ql){
 if(!ql) return [];
 return codes.filter(c => {
 const l = (catalog[c].label || "").toLowerCase();
 return l.includes(ql) || c.includes(ql) || (catalog[c].state || "").toLowerCase() === ql;
 }).slice(0, 25);
 }
 function _popularCodes(){
 const pref = ["gmp", "vec", "wec", "cmp", "eversource", "nationalgrid", "unitil"];
 const out = [];
 pref.forEach(c => { if(catalog[c] && !out.includes(c)) out.push(c); });
 // Fill with a few more alphabetically so the empty state never looks blank.
 codes.slice().sort((a,b) => (catalog[a].label||a).localeCompare(catalog[b].label||b))
 .forEach(c => { if(out.length < 12 && !out.includes(c)) out.push(c); });
 return out;
 }
 function _itemHTML(c){
 return `<button type="button" class="ar-picker-item" role="option" data-code="${esc(c)}">` +
 `<span class="ar-picker-item-name">${esc(catalog[c].label)}</span>` +
 (catalog[c].state ? `<span class="ar-picker-state">${esc(catalog[c].state)}</span>` : "") +
 `</button>`;
 }
 function _requestRowHTML(q, primary){
 // Same shape as a catalog hit so the list never "disappears" into a strip.
 return `<button type="button" class="ar-picker-item ar-picker-request${primary ? " ar-picker-request-primary" : ""}" role="option" data-req="1" data-name="${esc(q)}">` +
 `<span class="ar-picker-req-ico" aria-hidden="true">＋</span>` +
 `<span class="ar-picker-item-body">` +
 `<span class="ar-picker-item-name">Request “${esc(q)}”</span>` +
 `<span class="ar-picker-req-sub">${primary ? "Not in our list yet, we’ll wire it up for you" : "Can’t find it? Ask us to add this utility"}</span>` +
 `</span></button>`;
 }
 function _wireResultClicks(){
 resultsEl.querySelectorAll(".ar-picker-item[data-code]").forEach(it => {
 it.addEventListener("click", () => {
 _arAddedUtils.add(it.dataset.code);
 _vaultStatusCache = null;
 // Brief “selected” feel before the card lands.
 it.classList.add("ar-picker-item-picked");
 wireAutoRefreshRow().then(() => {
 const card = listEl.querySelector(`.ar-util[data-code="${CSS.escape(it.dataset.code)}"]`);
 if(card){
 card.scrollIntoView({ behavior:"smooth", block:"center" });
 const u = card.querySelector(".ar-row:last-child .ar-user");
 if(u) u.focus();
 }
 });
 });
 });
 resultsEl.querySelectorAll(".ar-picker-item[data-req]").forEach(it => {
 it.addEventListener("click", () => _queueUtilReq(it.dataset.name || searchEl.value));
 });
 }
 function _setHighlight(idx){
 const items = resultsEl.querySelectorAll(".ar-picker-item");
 if(!items.length){ _pickIdx = -1; return; }
 _pickIdx = Math.max(0, Math.min(idx, items.length - 1));
 items.forEach((el, i) => {
 el.classList.toggle("ar-picker-item-on", i === _pickIdx);
 if(i === _pickIdx) el.setAttribute("aria-selected", "true");
 else el.removeAttribute("aria-selected");
 });
 const on = items[_pickIdx];
 if(on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
 }
 function _activateHighlight(){
 const items = resultsEl.querySelectorAll(".ar-picker-item");
 if(!items.length) return false;
 const el = items[_pickIdx >= 0 ? _pickIdx : 0];
 if(!el) return false;
 el.click();
 return true;
 }

 function renderResults(){
 if(!searchEl || !resultsEl) return;
 const q = (searchEl.value || "").trim();
 const ql = q.toLowerCase();
 _pickIdx = -1;

 if(!ql){
 // Open state: always show a real list (popular + hint) so the control
 // never looks broken/empty when first expanded.
 const pop = _popularCodes();
 resultsEl.innerHTML =
 `<div class="ar-picker-hint">Popular utilities, or type a name, co-op, city, or state</div>` +
 pop.map(_itemHTML).join("");
 _wireResultClicks();
 return;
 }

 const hits = _matchCodes(ql);
 let html = "";
 if(!hits.length){
 html += `<div class="ar-picker-hint">No match for “${esc(q)}”</div>`;
 html += _requestRowHTML(q, true);
 } else {
 html += hits.map(_itemHTML).join("");
 // Always offer request as a stable last row, never a mode-swap.
 html += _requestRowHTML(q, false);
 }
 resultsEl.innerHTML = html;
 _wireResultClicks();
 // Highlight first actionable row so Enter works immediately.
 _setHighlight(hits.length ? 0 : 0);
 }

 if(searchEl && resultsEl){
 searchEl.addEventListener("input", renderResults);
 searchEl.addEventListener("keydown", (e) => {
 const items = resultsEl.querySelectorAll(".ar-picker-item");
 if(e.key === "ArrowDown"){
 e.preventDefault();
 if(!items.length) return;
 _setHighlight(_pickIdx < 0 ? 0 : _pickIdx + 1);
 } else if(e.key === "ArrowUp"){
 e.preventDefault();
 if(!items.length) return;
 _setHighlight(_pickIdx < 0 ? items.length - 1 : _pickIdx - 1);
 } else if(e.key === "Enter"){
 e.preventDefault();
 if(_activateHighlight()) return;
 // Fallback: queue free-text if nothing highlighted.
 const q = (searchEl.value || "").trim();
 if(q) _queueUtilReq(q);
 } else if(e.key === "Escape"){
 e.preventDefault();
 searchEl.value = "";
 renderResults();
 }
 });
 renderResults();
 renderReqQueue();
 }

 // Keep the board's freshness ticking while it's on screen (cloud mode).
 _arStartLiveTick();
 _arStopSpin(); // render done → let the ↻ settle
 }

 /* ---- Password row: view (masked + show-as-you-type) and set/change it.
 * A stored password is hashed, so it can't be shown, "view" means reveal what
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
 const row = document.getElementById("rowPassword");
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
 }catch(e){ setMsg("Couldn't reach the server, check your connection.", "err"); save.disabled = false; }
 };
 }

 // Identity fields (Name / Company / Email) auto-save as you type, no Save button
 // (Ford 2026-07-09: "remove the save button and have things auto save as you type").
 // Each keystroke debounces a write (750ms after you stop); leaving the field or
 // pressing Enter saves immediately. Unchanged or empty values never fire (so a
 // required field is never wiped), and a partial email waits until it looks valid.
 // A monotonic seq guards against out-of-order responses when you keep typing.
 function wireAcctEdits(){
 document.querySelectorAll("#acctList .acct-edit").forEach(row => {
 const inp = row.querySelector("input");
 const msg = row.querySelector(".acct-msg");
 const field = row.dataset.field; // "name" | "company" | "email"
 let saved = inp.value.trim(); // last value successfully stored
 let timer = null, seq = 0;
 const setMsg = (t, cls) => { if(msg){ msg.className = "acct-msg" + (cls ? " " + cls : ""); msg.textContent = t; } };
 const looksLikeEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

 const save = async () => {
 const val = inp.value.trim();
 if(val === saved) return; // nothing changed since last save
 if(!val){ setMsg("", ""); return; } // never wipe a required field to blank
 if(field === "email" && !looksLikeEmail(val)){ setMsg("Keep typing your email…", ""); return; }
 const h = authHeaders();
 if(!h){ setMsg("Sign in first.", "err"); return; }
 const url = field === "company" ? "/v1/account/company-name"
 : field === "name" ? "/v1/account/name"
 : "/v1/account/email";
 // Backend models: UpdateName{name}, UpdateCompanyName{name}, UpdateEmail{email}.
 // The name + company endpoints want `name` (not `company_name`), sending the
 // wrong key 422s, which was the "Couldn't save (HTTP 422)" bug.
 const body = (field === "company" || field === "name") ? { name: val } : { email: val };
 const mine = ++seq; // supersede any in-flight save
 setMsg("Saving…", "");
 try{
 const r = await fetch(url, { method:"POST",
 headers: Object.assign({ "Content-Type":"application/json" }, h),
 body: JSON.stringify(body) });
 if(mine !== seq) return; // a newer keystroke already fired a save
 if(r.ok){
 saved = val;
 setMsg("Saved ✓", "ok");
 if(_account){ _account[field === "company" ? "company_name" : field === "name" ? "operator_name" : "email"] = val; }
 // Email is also the login, keep the Login row in sync.
 if(field === "email"){ const lg = document.getElementById("loginEmail"); if(lg) lg.textContent = val; }
 // Fade the confirmation after a beat so the row stays quiet.
 setTimeout(() => { if(mine === seq && inp.value.trim() === saved) setMsg("", ""); }, 2200);
 } else {
 const d = await r.json().catch(() => ({}));
 setMsg((d && d.detail) ? d.detail : `Couldn't save (HTTP ${r.status}), still trying as you type.`, "err");
 }
 }catch(e){
 if(mine === seq) setMsg("Couldn't save, check your connection.", "err");
 }
 };

 inp.addEventListener("input", () => { setMsg("", ""); clearTimeout(timer); timer = setTimeout(save, 750); });
 inp.addEventListener("blur", () => { clearTimeout(timer); save(); });
 inp.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); clearTimeout(timer); save(); inp.blur(); } });
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
 ? `Sent, check ${email} for your sign-in link.`
 : "Couldn't send a link right now, please try again shortly.";
 }catch(e){ if(sub) sub.textContent = "Couldn't reach the server, check your connection."; }
 btn.disabled = false;
 };
 }

 // Fill the "Your bill" + "Payment method" rows once billing data lands.
 async function renderBilling(h){
 const box = document.getElementById("aoBill");
 if(!box) return;

 let summary = null, invoice = null;
 // Track HARD failures (network / 5xx) separately from a legit empty bill. A
 // 200 with no charges is "No charges yet"; a thrown fetch / !ok on BOTH calls
 // is a real load failure and must not masquerade as "No charges yet."
 let sumFailed = false, invFailed = false;
 // Signed-out DEMO: serve the canned bill from AO_DEMO (no fetch, which would
 // 401). This MUST come first so the demo path returns demo data before any
 // network call. Real owners pass real headers and hit the live endpoints below.
 if(!h && window.AO_DEMO && window.AO_DEMO.billingSummary){
 summary = window.AO_DEMO.billingSummary;
 invoice = window.AO_DEMO.nextInvoice || null;
 } else {
 // Bound each call so a HANGING endpoint (no response, no 5xx) is treated as a
 // failure and routes into the recovery UI below instead of leaving the billing
 // box blank forever. AbortSignal.timeout is used when available, with a manual
 // AbortController fallback for older engines.
 const _timeoutSignal = (ms) => {
 try { if(typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms); } catch(_){}
 try { const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal; } catch(_){ return undefined; }
 };
 const _fetchBill = (url) => fetch(url, { headers: h, signal: _timeoutSignal(8000) });
 try { const r = await _fetchBill("/v1/account/billing-summary"); if(r.ok) summary = await r.json(); else sumFailed = true; } catch(e){ sumFailed = true; }
 try { const r = await _fetchBill("/v1/account/next-invoice"); if(r.ok) invoice = await r.json(); else invFailed = true; } catch(e){ invFailed = true; }
 }

 // Both endpoints failed → show an honest error + retry instead of a misleading
 // "No charges yet." Retry re-runs renderBilling with fresh headers, so the
 // owner recovers without a full page refresh.
 if(sumFailed && invFailed){
 window.__aoRetryBilling = () => { try { renderBilling(authHeaders()); } catch(e){} };
 box.innerHTML =
 `<div class="ao-bill-empty">Couldn't load billing, <a href="#" onclick="window.__aoRetryBilling && window.__aoRetryBilling(); return false;">refresh to retry</a>.</div>`;
 return;
 }

 // Amounts from billing-summary are in (possibly fractional) CENTS.
 const usdFromCents = c => (c==null ? "—" : "$" + (Number(c)/100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}));
 const basis = pick(summary, ["billing_basis"], null);
 const status = pick(summary, ["subscription_status","status"], (_account && pick(_account, ["subscription_status","status"], "")) || "");
 const onTrial = (_account && (_account.on_trial === true || _account.trial === true)) || /trial/i.test(String(status));
 const trialEnds = _account ? pick(_account, ["trial_ends_at","trial_end","trial_expires_at"], null) : null;

 // ── Unified monthly bill (Account Billing section).
 // Array Operator: monitoring (kW) + offtaker invoices (count) + optional AI Pro.
 // Prefer server `unified` block; fall back to legacy dual-model fields.
 const feats = (_account && _account.plan_features) || {};
 const isAO = (basis === "kwh" || basis === "invoicing" || basis === "both" || (summary && summary.unified));
 const billLine = (kind, calc, amt, desc) =>
 `<div class="ao-bill-line"><span class="bl-k"><b>${esc(kind)}</b><span class="bl-calc">${calc}</span>${desc?`<span class="bl-desc">${esc(desc)}</span>`:""}</span><span class="bl-v">${amt}</span></div>`;
 const periodStart = pick(summary, ["period_start"], null);
 const sinceTxt = periodStart ? ` (since ${fmtDate(periodStart)})` : "";
 let lines = "", total = 0, aiUpgradeHtml = "";
 if(summary && isAO && summary.unified && Array.isArray(summary.unified.lines)){
 const u = summary.unified;
 // Regular product + optional Pro, no monitoring/invoicing plan split
 const planTag = (u.plan_label === "Regular" || u.plan === "regular")
 ? (summary.ai_pro ? "Regular + AI Pro" : "Regular")
 : (u.plan_label || "Regular");
 lines += `<div class="ao-bill-plan-tag">Plan · ${esc(planTag)}</div>`;
 u.lines.forEach(ln => {
 if(!ln) return;
 if(ln.id === "ai_pro" && !ln.included){
 // Free AI sample, show as a soft row + upgrade CTA, not a $0 charge line
 const freeW = (u.ai && u.ai.free_weekly_usd) || 2.5;
 const proMo = (u.ai && u.ai.monthly_usd) || 50;
 lines += billLine("Energy Agent",
 `Free sample · $${Number(freeW).toFixed(2)}/week`,
 `<span class="ao-bill-soft">included</span>`,
 `Integrated AI (chat + voice) with a small weekly sample so you can try it. Upgrade for unlimited.`);
 aiUpgradeHtml =
 `<div class="ao-bill-ai">` +
 `<div class="ao-bill-ai-h"><b>Energy Agent Pro</b> · $${Number(proMo).toFixed(0)}/mo</div>` +
 `<div class="ao-bill-ai-s">Unlimited thinking + voice. The rest of the site stays simple until you need deeper AI help.</div>` +
 `<button type="button" class="ao-btn ao-btn-primary ao-bill-ai-btn" id="aoAiProUpgrade">Upgrade to Pro →</button>` +
 `</div>`;
 return;
 }
 if(ln.id === "ai_pro" && ln.included){
 total += Number(ln.amount_cents || 0);
 lines += billLine(ln.kind || "Energy Agent Pro",
 "Unlimited AI",
 usdFromCents(ln.amount_cents),
 ln.desc || "Unlimited integrated AI this month.");
 return;
 }
 // Collection skim, transparency only, never in monthly total
 if(ln.id === "collection_fee" || ln.basis === "percent_of_collected"){
 const pct = (ln.fee_percent != null)
 ? Number(ln.fee_percent)
 : (Number(ln.fee_bps || 50) / 100);
 const pctTxt = (Math.round(pct * 100) / 100) + "%";
 lines +=
 `<div class="ao-bill-line ao-bill-collect">` +
 `<span class="bl-k"><b>${esc(ln.kind || "Online offtaker payments")}</b>` +
 `<span class="bl-calc">${esc(pctTxt)} of each online payment</span>` +
 `<span class="bl-desc">${esc(ln.desc || ("When offtakers pay an invoice online, we keep " + pctTxt + ". Not part of your monthly bill. Offline/check payments: no fee."))}</span></span>` +
 `<span class="bl-v ao-bill-collect-v"><span class="ao-bill-soft">not monthly</span></span>` +
 `</div>`;
 return;
 }
 const amt = Number(ln.amount_cents || 0);
 // Skip null amount lines (shouldn't reach here)
 if(ln.amount_cents == null && ln.included_in_monthly_total === false) return;
 // Only sum lines that are actually on-plan / charged
 const billed = (ln.billed !== false) && (ln.included_in_monthly_total !== false);
 if(billed) total += amt;
 let calc = "";
 if(ln.basis === "nameplate_kw"){
 const q = Number(ln.quantity || 0);
 const rate = Number(ln.unit_cents || 15);
 const full = Number(ln.full_unit_cents || rate);
 const disc = full > 0 && rate < full - 0.001;
 calc = `${q.toLocaleString(undefined,{maximumFractionDigits:0})} kW × ${disc?"≈ ":""}${usdFromCents(rate)}/kW`;
 } else if(ln.basis === "offtaker_count"){
 const q = Number(ln.quantity || 0);
 const rate = Number(ln.unit_cents || 1500);
 const full = Number(ln.full_unit_cents || rate);
 const disc = full > 0 && rate < full - 0.001;
 // Always show the per-offtaker math so the rate is obvious
 calc = `${q} offtaker${q===1?"":"s"} × ${disc?"≈ ":""}${usdFromCents(rate)}`
 + (full && !disc ? ` · $${(full/100).toFixed(0)}/ea` : "");
 } else {
 calc = ln.unit_label || "";
 }
 const amtHtml = billed
 ? usdFromCents(amt)
 : `<span class="ao-bill-soft" title="Not charged on your current plan">${usdFromCents(amt)} · not on plan</span>`;
 lines += billLine(ln.kind || "Charge", calc, amtHtml, ln.desc || "");
 });
 if(u.model_note){
 lines += `<div class="ao-bill-model-note">${esc(u.model_note)}</div>`;
 }
 } else if(summary && isAO){
 // Legacy dual-model fallback when unified block missing
 const showMon = feats.plan_chosen ? !!feats.vendor_data : (basis === "kwh");
 const showInv = feats.plan_chosen ? !!feats.invoicing : (basis === "invoicing");
 if(showMon){
 const c = Number(pick(summary, ["monitoring_total_cents"], 0));
 total += c;
 if(pick(summary, ["monitoring_basis"], "kwh") === "nameplate"){
 const kw = Number(pick(summary, ["nameplate_kw"], 0));
 const rate = Number(pick(summary, ["rate_cents_per_kw"], 15));
 const full = Number(pick(summary, ["full_rate_cents_per_kw"], rate));
 const discounted = full > 0 && rate < full - 0.001;
 lines += billLine("Fleet monitoring",
 `${kw.toLocaleString(undefined,{maximumFractionDigits:0})} kW × ${discounted?"≈ ":""}${usdFromCents(rate)}/kW`,
 usdFromCents(c),
 discounted
 ? `Live fleet monitoring, billed on your registered nameplate capacity, volume discount applied (headline rate ${usdFromCents(full)}/kW). Charged monthly to your card.`
 : `Live fleet monitoring, billed on your registered nameplate capacity. Charged monthly to your card.`);
 } else {
 const kwh = Number(pick(summary, ["mtd_kwh"], 0));
 const rate = Number(pick(summary, ["blended_cents_per_kwh"], pick(summary, ["rate_cents_per_kwh"], 0.5)));
 lines += billLine("Generation",
 `${kwh.toLocaleString(undefined,{maximumFractionDigits:0})} kWh × ${rate.toLocaleString(undefined,{maximumFractionDigits:3})}&cent;/kWh`,
 usdFromCents(c),
 `Live fleet monitoring, metered on every kWh your arrays produced this billing month${sinceTxt}. Charged monthly to your card.`);
 }
 }
 if(showInv){
 const n = Number(pick(summary, ["offtaker_count"], 0));
 const full = Number(pick(summary, ["invoicing_per_offtaker_cents"], 1500));
 const per = Number(pick(summary, ["invoicing_blended_cents_per_offtaker"], full));
 const c = Number(pick(summary, ["invoicing_total_cents"], 0));
 const discounted = full > 0 && per < full - 0.001;
 total += c;
 lines += billLine("Offtaker invoices",
 `${n} offtaker${n===1?"":"s"} × ${discounted?"≈ ":""}${usdFromCents(per)}`, usdFromCents(c),
 discounted
 ? `Volume discount applied (headline rate ${usdFromCents(full)}/offtaker). Charged monthly to your card.`
 : `${usdFromCents(full)} per offtaker you invoice. Charged monthly to your card.`);
 // Collection fee transparency (legacy path)
 const cf = summary.collection_fee || (summary.unified && summary.unified.collection_fee);
 {
 const pct = cf && cf.fee_percent != null ? Number(cf.fee_percent) : 0.5;
 const pctTxt = (Math.round(pct * 100) / 100) + "%";
 lines +=
 `<div class="ao-bill-line ao-bill-collect">` +
 `<span class="bl-k"><b>Online offtaker payments</b>` +
 `<span class="bl-calc">${esc(pctTxt)} of each online payment</span>` +
 `<span class="bl-desc">When offtakers pay an invoice online, we keep ${esc(pctTxt)}. Not part of your monthly bill. Offline/check: no fee.</span></span>` +
 `<span class="bl-v ao-bill-collect-v"><span class="ao-bill-soft">not monthly</span></span>` +
 `</div>`;
 }
 }
 } else if(summary){
 // NEPOOL, per array.
 const n = pick(summary, ["billable_arrays","array_count","arrays_count","arrays"], 0);
 const full = pick(summary, ["full_unit_cents"], null);
 const c = Number(pick(summary, ["total_cents"], 0));
 total = c;
 lines += billLine("Arrays",
 `${n} array${Number(n)===1?"":"s"}${full!=null?` × ${usdFromCents(full)}`:""}`, usdFromCents(c));
 }

 // ── Trial / complimentary banner, a PROMINENT element in the bill (Ford).
 // Two states: a regular trial COUNTS DOWN to its end date; an indefinite tester
 // (comped, or a trial with no end date) reads as complimentary with no clock —
 // "trial" undersells an open-ended tester account (Lester / Paul).
 const isComped = /comped/i.test(String(status)) || (_account && _account.plan === "comped");
 const daysLeft = (iso) => { const t = new Date(iso).getTime(); return isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null; };
 const dLeft = trialEnds ? daysLeft(trialEnds) : null;
 // "Indefinite tester" = comped, a trial with NO end, OR a trial whose end is so far
 // out (> 60d, vs the real 14-day trial) that it's effectively open-ended, so a
 // tester never sees an absurd "800 days left" countdown, however they're modeled.
 const indefinite = isComped || (onTrial && (!trialEnds || (dLeft != null && dLeft > 60)));
 let trialBanner = "";
 if(indefinite){
 // Indefinite tester, no time limit, never charged. The Monthly bill below is
 // the plan's list price for reference; the banner makes clear it isn't billed.
 trialBanner =
 `<div class="ao-bill-trial ao-bill-trial--comp">` +
 `<span class="ao-bill-trial-ic" aria-hidden="true">✦</span>` +
 `<span class="ao-bill-trial-tx"><b>Complimentary access</b>` +
 `<span>No time limit, nothing charged. You're set up as an EnergyAgent tester.</span></span>` +
 `<span class="ao-bill-trial-badge">COMPLIMENTARY</span>` +
 `</div>`;
 } else if(onTrial && trialEnds){
 const d = dLeft;
 if(d != null && d > 0){
 trialBanner =
 `<div class="ao-bill-trial">` +
 `<span class="ao-bill-trial-ic" aria-hidden="true">🎁</span>` +
 `<span class="ao-bill-trial-tx"><b>Free trial, ${d === 1 ? "1 day" : d + " days"} left</b>` +
 `<span>Through ${fmtDate(trialEnds)}, then ${usdFromCents(total)}/mo. Nothing charged yet.</span></span>` +
 `<span class="ao-bill-trial-badge">TRIAL</span>` +
 `</div>`;
 } else if(d != null && d === 0){
 trialBanner =
 `<div class="ao-bill-trial">` +
 `<span class="ao-bill-trial-ic" aria-hidden="true">🎁</span>` +
 `<span class="ao-bill-trial-tx"><b>Free trial, ends today</b>` +
 `<span>Add a card to keep your fleet live, then ${usdFromCents(total)}/mo.</span></span>` +
 `<span class="ao-bill-trial-badge">TRIAL</span>` +
 `</div>`;
 }
 }

 // Context line: next-invoice date only (the trial line is now the banner above).
 // Show the next billing DATE only, NOT a separate Stripe amount, which can lag
 // the computed plan total during a usage-report / plan-change sync gap and read
 // as two disagreeing bills. The "Monthly bill" above is the honest plan estimate.
 // Comped testers are never charged, so no next-charge date for them.
 const ctx = [];
 const invDate = invoice ? pick(invoice, ["period_end","due_date","date","next_payment_date"], null) : null;
 if(invDate && !indefinite) ctx.push(`next charge on ${fmtDate(invDate)}`);

 box.innerHTML =
 trialBanner +
 (lines || `<div class="ao-bill-empty">No charges yet.</div>`) +
 `<div class="ao-bill-total"><span>Monthly bill</span><span class="ao-bill-tot-v">${usdFromCents(total)}<small>/mo</small></span></div>` +
 (ctx.length ? `<div class="ao-bill-ctx">${ctx.join(" · ")}</div>` : "") +
 (aiUpgradeHtml || "");

 // Energy Agent Pro upgrade (Account Billing section)
 const aiBtn = box.querySelector("#aoAiProUpgrade");
 if(aiBtn){
 aiBtn.onclick = async () => {
 aiBtn.disabled = true;
 aiBtn.textContent = "Opening…";
 try {
 const r = await fetch("/v1/account/ai-pro/checkout", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, h || {}),
 });
 const d = await r.json().catch(() => ({}));
 if(d && d.checkout_url){ window.location.href = d.checkout_url; return; }
 if(d && d.already_pro){
 aiBtn.textContent = "Already on Pro";
 return;
 }
 // Stripe price not minted yet, honest message, no fake charge
 const msg = (d && d.message) || "Pro checkout isn't live yet, contact us to enable unlimited AI.";
 aiBtn.disabled = false;
 aiBtn.textContent = "Upgrade to Pro →";
 try { if(window.toast) toast(msg, "ok"); else alert(msg); } catch(_){ alert(msg); }
 } catch(e){
 aiBtn.disabled = false;
 aiBtn.textContent = "Upgrade to Pro →";
 try { if(window.toast) toast("Couldn't start checkout, try again.", "err"); } catch(_){}
 }
 };
 }

 // Payment state + button. A card exists only on a real paid/active status or an
 // explicit flag, a bare trial does NOT mean a card is on file (that's why the
 // default CTA is "Add credit card").
 //
 // The status regex is a FALLBACK ONLY for when the backend hasn't told us either
 // way (has_payment_method/has_card both missing), it must never override an
 // EXPLICIT false. Without this guard, an operator who added a card mid-trial
 // (status still "trialing", so the regex alone would say no) reads correctly —
 // but the reverse case (a payload that explicitly says has_payment_method:false
 // while status happens to read "active", e.g. a lapsed/edge subscription) would
 // have shown a hard "Card on file" the operator knows is false. Trust an explicit
 // signal over an inferred one, always.
 const sStatus = String(status || "");
 const pmField = summary && (summary.has_payment_method === true || summary.has_card === true) ? true
 : summary && (summary.has_payment_method === false || summary.has_card === false) ? false
 : null; // backend didn't say, fall back to the status inference below
 const hasCard = pmField != null ? pmField : /active|past_due|paid/i.test(sStatus);
 const payState = document.getElementById("payState");
 const btn = document.getElementById("billManage");
 if(payState){
 if(hasCard){
 const bMap = {visa:"Visa",mastercard:"Mastercard",amex:"Amex","american express":"Amex",discover:"Discover",diners:"Diners",jcb:"JCB",unionpay:"UnionPay"};
 const bRaw = String(pick(summary, ["card_brand"], "") || "");
 const brand = bMap[bRaw.toLowerCase()] || (bRaw ? bRaw.charAt(0).toUpperCase()+bRaw.slice(1) : "");
 const last4 = pick(summary, ["card_last4"], null);
 const exp = pick(summary, ["card_exp"], null);
 payState.textContent = last4
 ? `${brand ? brand + " " : ""}•••• ${last4}${exp ? " · exp " + exp : ""}`
 : "Card on file";
 } else {
 payState.textContent = "No card on file";
 }
 }
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
 if(msg){ msg.className = "acct-msg err"; msg.textContent = "Billing isn't available just yet, please try again shortly."; }
 }catch(e){
 if(msg){ msg.className = "acct-msg err"; msg.textContent = "Couldn't reach billing, check your connection and try again."; }
 }
 if(btn) btn.disabled = false;
 }

 async function loadAccount(){
 const list = document.getElementById("acctList");
 if(!list) return;
 const h = authHeaders();
 if(!h){
 // Signed-out DEMO: render a fully-populated Master Account for the fake
 // operator (Catamount Community Solar) instead of the sign-in wall, so a
 // cold visitor sees every account row + the dual bill + a card on file.
 // Gated on the demo module existing; real signed-in flow is untouched (h set).
 if(window.AO_DEMO && window.AO_DEMO.account){
 _account = window.AO_DEMO.account;
 renderAccountList(_account);
 try { if(window.__aoPaintWhoami) window.__aoPaintWhoami(_account); } catch(e){}
 renderBilling(null); // null headers → renderBilling reads AO_DEMO
 return;
 }
 list.innerHTML = signInPrompt();
 return;
 }
 list.innerHTML = `<div class="empty">Loading your account…</div>`;
 // Hard timeout: when the API is wedged (DB pool / hung workers), browsers wait
 // forever on TCP. 8s is short enough to show Retry before customers bounce.
 // 2026-07-14: full Railway hang, health timed out; Account sat on "Loading…".
 const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
 const to = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch(e){} }, 8000) : null;
 try{
 const r = await fetch("/v1/account", {
 headers: h,
 signal: ctrl ? ctrl.signal : undefined,
 });
 if(to) clearTimeout(to);
 if(r.status === 401){ list.innerHTML = sessionExpired(); return; }
 // 503 = API intentionally fail-fast under DB pool pressure, ask them to retry.
 // 502/504 = reverse-proxy timeout while Railway workers are wedged.
 if(r.status === 503 || r.status === 502 || r.status === 504){
 list.innerHTML = `<div class="empty">
 <b>Server is recovering</b><br>
 <span style="color:var(--muted);font-size:13px;line-height:1.45">Our API is busy (not your data, nothing was deleted). Wait a few seconds and try again.</span><br>
 <button type="button" class="acct-btn primary" id="acctRetryLoad" style="margin-top:12px">Try again</button>
 </div>`;
 const b503 = document.getElementById("acctRetryLoad");
 if(b503) b503.onclick = () => loadAccount();
 return;
 }
 if(!r.ok) throw new Error("account " + r.status);
 _account = await r.json();
 // Keep the top-bar identity chip in sync (app.js may have been stuck on "…").
 try { if(window.__aoPaintWhoami) window.__aoPaintWhoami(_account); } catch(e){}
 // Server is authoritative for the auto-refresh mode → reconcile local + re-run the
 // extension "keep a tab open" nudge (it reads the mode) so a cloud owner never sees it.
 try { _arSyncModeFromAccount(_account); } catch(e){}
 try { if(window.updateExtLiveNudge) window.updateExtLiveNudge(); } catch(e){}
 if(window.aoIsCancelled && window.aoIsCancelled(_account)){
 try { window.aoShowCancelledGate(); } catch(e){}
 }
 try {
 renderAccountList(_account);
 } catch(paintErr){
 list.innerHTML = `<div class="empty">Account loaded but the page failed to paint, <button type="button" class="acct-btn" id="acctRetryLoad">Try again</button></div>`;
 const b = document.getElementById("acctRetryLoad");
 if(b) b.onclick = () => loadAccount();
 return;
 }
 }catch(e){
 if(to) clearTimeout(to);
 const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
 list.innerHTML = aborted
 ? `<div class="empty">
 <b>Account is taking too long</b><br>
 <span style="color:var(--muted);font-size:13px;line-height:1.45">Usually a brief API blip, your logins and arrays are safe. Retry in a few seconds.</span><br>
 <button type="button" class="acct-btn primary" id="acctRetryLoad" style="margin-top:12px">Try again</button>
 </div>`
 : `<div class="empty">
 <b>Couldn't reach the server</b><br>
 <span style="color:var(--muted);font-size:13px;line-height:1.45">Check your connection, then retry. Nothing was deleted from your account.</span><br>
 <button type="button" class="acct-btn primary" id="acctRetryLoad" style="margin-top:12px">Try again</button>
 </div>`;
 const btn = document.getElementById("acctRetryLoad");
 if(btn) btn.onclick = () => loadAccount();
 return;
 }
 try { renderBilling(h); } catch(e){}
 }

 /* ===========================================================================
 * REPORTS, honest placeholder. Prefills the send-to email from the account.
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
 * THREE-TAB SYSTEM, Master Account (#account) · Arrays (#arrays, DEFAULT) ·
 * Reports (#reports). Anything else (empty hash, old #sandbox / #dashboard /
 * #fleet / #pricing links) resolves to Arrays for backward compatibility.
 * ==========================================================================*/
 const TABS = {
 dashboard: { panel: "panelDashboard", tab: "tabDashboard" },
 account: { panel: "panelAccount", tab: "tabAccount" },
 arrays: { panel: "panelArrays", tab: "tabArrays" },
 analysis:{ panel: "panelAnalysis",tab: "tabAnalysis"},
 /* Trends is a SUB-VIEW of Analysis now (Ford 2026-07-13), panelTrends is
 toggled manually inside the analysis branch of applyView, not via this map. */
 reports: { panel: "panelReports", tab: "tabReports" },
 ops: { panel: "panelOps", tab: "tabOps" },
 /* Resources is a SUB-VIEW of Operations (#resources → ops + resources sub). */
 };
 function tabFromHash(){
 const h = location.hash;
 if(h === "#account") return "account";
 if(h === "#ops" || h === "#claims" || h === "#repairs" || h === "#resources") return "ops";
 if(h === "#arrays" || h === "#sandbox") return "arrays";
 if(h === "#analysis") return "analysis";
 if(h === "#trends") return "analysis"; // Trends is a sub-view of Analysis now
 if(h === "#reports") return "reports";
 if(h === "#dashboard") return "dashboard"; // explicit deep-link → owner health home
 // Empty/legacy hash → land on the Inverter Dashboard (Spreadsheet sub-view) per Ford,
 // not Fleet Health. applyTabGating() bounces a plan that can't use it to an allowed tab.
 return "arrays";
 }

 // Master Account "you have something to do here" dot. Shown only to a SIGNED-IN
 // owner who hasn't opened Master Account yet (e.g. to add a card / set their
 // company name); cleared the first time they open the tab (ao_seen_account).
 function updateAccountDot(){
 const dot = document.getElementById("acctDot");
 if(!dot) return;
 let signedIn = false, seen = false;
 try { signedIn = !!localStorage.getItem("so_session"); } catch(_){}
 try { seen = localStorage.getItem("ao_seen_account") === "1"; } catch(_){}
 dot.classList.toggle("tab-dot--on", signedIn && !seen);
 }
 try { window.__aoUpdateAccountDot = updateAccountDot; } catch(_){}

 /* Analysis ⇄ Trends sub-view (Ford 2026-07-13). #analysis shows the fleet NOC,
 #trends shows Paul's multi-year trends, both under the Analysis top tab, via
 the .an-sub-seg segmented control duplicated in each panel. */
 function subFromHash(){ return location.hash === "#trends" ? "trends" : "analysis"; }
 function applyAnalysisSub(){
 const trendsSub = subFromHash() === "trends";
 const pA = document.getElementById("panelAnalysis");
 const pT = document.getElementById("panelTrends");
 if(pA) pA.classList.toggle("active", !trendsSub);
 if(pT) pT.classList.toggle("active", trendsSub);
 document.querySelectorAll(".an-sub-seg [data-ansub]").forEach(b => {
 const on = (b.getAttribute("data-ansub") === "trends") === trendsSub;
 b.classList.toggle("on", on);
 b.setAttribute("aria-pressed", on ? "true" : "false");
 });
 if(trendsSub){ if(window.__aoLoadTrends) window.__aoLoadTrends(); }
 else { if(window.__aoLoadAnalysis) window.__aoLoadAnalysis(); }
 }
 // The segmented buttons just set the hash; hashchange → applyView → applyAnalysisSub.
 document.addEventListener("click", function(e){
 const b = e.target && e.target.closest ? e.target.closest(".an-sub-seg [data-ansub]") : null;
 if(!b) return;
 const target = b.getAttribute("data-ansub") === "trends" ? "#trends" : "#analysis";
 if(location.hash === target) applyAnalysisSub(); // same hash → still (re)apply
 else location.hash = target;
 });

 let _firstApply = true;
 function applyView(){
 const active = tabFromHash();
 Object.keys(TABS).forEach(name => {
 const t = TABS[name];
 const panel = document.getElementById(t.panel);
 const tab = document.getElementById(t.tab);
 if(panel) panel.classList.toggle("active", name === active);
 if(tab) tab.classList.toggle("active", name === active);
 });
 // Trends panel isn't in TABS (it's an Analysis sub-view); hide it on other tabs.
 if(active !== "analysis"){
 const _pT = document.getElementById("panelTrends");
 if(_pT) _pT.classList.remove("active");
 }

 if(active === "dashboard"){
 // Owner health home, command-center.js fills #fleetCommander + #ccQueue + the
 // production strip (#dashProd) from the shared FleetStore.
 if(window.FleetStore) FleetStore.load();
 if(window.__ccRender) window.__ccRender();
 } else if(active === "arrays"){
 load(); // sandbox fleet tree
 // app.js auto-runs loadDashboard() once on parse; only re-run on later switches.
 if(!_firstApply && window.__aoLoadDashboard) window.__aoLoadDashboard();
 } else if(active === "account"){
 loadAccount();
 // They've now seen Master Account, clear the "something to do here" dot.
 try { localStorage.setItem("ao_seen_account", "1"); } catch(_){}
 updateAccountDot();
 } else if(active === "analysis"){
 applyAnalysisSub(); // shows the Fleet-analysis OR Trends sub-view + loads it
 } else if(active === "reports"){
 loadReports();
 } else if(active === "ops"){
 // Deep-links: #claims / #repairs / #resources → Operations sub-views
 try {
 if(location.hash === "#claims" && window.__aoOpsGoto) window.__aoOpsGoto("claims");
 else if(location.hash === "#repairs" && window.__aoOpsGoto) window.__aoOpsGoto("repairs");
 else if(location.hash === "#resources" && window.__aoOpsGoto) window.__aoOpsGoto("resources");
 else if(window.__aoLoadOps) window.__aoLoadOps();
 } catch(_){ if(window.__aoLoadOps) window.__aoLoadOps(); }
 // Clear ops attention dot once opened
 try {
 var od = document.getElementById("opsDot");
 if(od) od.classList.remove("tab-dot--on");
 localStorage.setItem("ao_seen_ops", "1");
 } catch(_){}
 }
 applyTabGating(); // keep tab locks fresh + bounce off a tab the plan doesn't include
 _firstApply = false;
 }
 /* ==========================================================================
 * PRODUCT SURFACE, Jul 2026: no monitoring/invoicing plan picker.
 * Regular AO = full product (fleet + offtaker invoices). AI Pro is the only add-on.
 * ========================================================================== */
 let _entitlement = { plan: "regular", plan_chosen: true, vendor_data: true, invoicing: true };
 const TAB_FEATURE = {}; // no tab locks
 const PLAN_LABEL = { regular: "Regular", monitoring: "Regular", invoicing: "Regular", both: "Regular" };

 function tabAllowed(name){ return true; }

 async function loadEntitlement(){
 const h = authHeaders();
 if(!h) return;
 try{
 const r = await fetch("/v1/account", { headers: h });
 if(!r.ok) return;
 const a = await r.json().catch(()=>null);
 if(!a) return;
 _account = a;
 try { if(window.__aoPaintWhoami) window.__aoPaintWhoami(a); } catch(e){}
 // Always full access; never show plan picker.
 _entitlement = a.plan_features || _entitlement;
 if(_entitlement){
 _entitlement.plan_chosen = true;
 _entitlement.vendor_data = true;
 _entitlement.invoicing = true;
 _entitlement.plan = "regular";
 }
 applyTabGating();
 // Tell Energy Agent UI about Pro for the Go Pro / Unlimited badge
 try {
 if(window.__eaSetProState) window.__eaSetProState(!!a.ai_pro);
 } catch(e){}
 }catch(e){}
 }

 function applyTabGating(){
 // Clear any leftover lock UI from older sessions
 Object.keys(TABS || {}).forEach(name => {
 const t = TABS[name]; if(!t) return;
 const btn = document.getElementById(t.tab); if(!btn) return;
 btn.classList.remove("locked");
 const has = btn.querySelector(".tab-lock");
 if(has) has.remove();
 });
 }

 function wireTabGateClicks(){ /* no plan gates */ }
 function showPlanPicker(){ /* retired */ }
 function showUpgradePopup(){ /* retired */ }
 async function applyPlan(){ return true; }

 // Master Account "Plan" row, Regular product + AI Pro status only.
 function planRow(){
 const pro = !!( _account && _account.ai_pro );
 const label = pro ? "Regular + Energy Agent Pro" : "Regular";
 const sub = pro
 ? "Fleet monitoring (kW) · offtaker invoices · unlimited AI"
 : "Fleet monitoring (kW) · offtaker invoices · AI sample ($2.50/wk)";
 const btn = pro
 ? ""
 : `<button class="acct-btn primary" id="acctChangePlan" type="button">Get AI Pro →</button>`;
 return rowStatic("Plan",
 `<span class="r-big" id="acctPlanVal">${esc(label)}</span>`, sub, btn);
 }
 function wirePlanRow(){
 const b = document.getElementById("acctChangePlan");
 if(!b) return;
 b.onclick = async () => {
 b.disabled = true; b.textContent = "Opening…";
 try{
 const h = authHeaders();
 const r = await fetch("/v1/account/ai-pro/checkout", {
 method: "POST",
 headers: Object.assign({ "Content-Type": "application/json" }, h || {}),
 });
 const d = await r.json().catch(()=>({}));
 if(d && d.checkout_url){ window.location.href = d.checkout_url; return; }
 if(d && d.already_pro){ b.textContent = "Already Pro"; return; }
 const msg = (d && d.message) || "Couldn't start Pro checkout.";
 b.disabled = false; b.textContent = "Get AI Pro →";
 try { if(window.toast) toast(msg, "ok"); else alert(msg); } catch(_){ alert(msg); }
 }catch(e){
 b.disabled = false; b.textContent = "Get AI Pro →";
 }
 };
 }

 window.__aoSetEntitlement = (e) => { _entitlement = e; applyTabGating(); };
 window.__aoShowPlanPicker = () => {};
 window.__aoLoadEntitlement = loadEntitlement;

 window.addEventListener("hashchange", applyView);
 // First-visit landing: with NO explicit hash (no deep-link), a brand-new owner
 // should land on the Inverter Dashboard (#arrays → Spreadsheet sub-view), not Fleet
 // Health, that's where they see their arrays appear. An explicit #dashboard /
 // #account / #reports deep-link is always respected (we only default the EMPTY hash).
 function landDefaultTab(){
 if(!location.hash){
 try {
 // Onboarding "Upload offtaker spreadsheet" → Invoices bulk import
 const q = new URLSearchParams(location.search || "");
 if (q.get("setup") === "offtakers" || q.get("bulk") === "1") {
 location.replace("#reports");
 } else {
 location.replace("#arrays"); // replace → no extra Back-button history entry
 }
 } catch(_){ location.hash = "#arrays"; }
 }
 }
 document.addEventListener("DOMContentLoaded", () => { landDefaultTab(); applyView(); wireTabGateClicks(); loadEntitlement(); updateAccountDot(); ensureAlertsWidget(); });
 // expose for external callers (and post-add reloads)
 window.__sbLoad = load;
 // QA/debug hook: render a fleet-tree payload directly (used by the offline
 // visual-QA harness to exercise the Vendor⇄Utility slider without hitting prod).
 window.__sbRenderTree = render;
 // expose the alerts settings modal so it can be opened from the top-bar
 // Fleet Commander button (moved out of the sandbox head, May 2026).
 window.__sbOpenAlerts = openAlertsPanel;

 // ---- shared store: re-render the fleet tree whenever the canonical fleet (or
 // the focused subset) changes, including changes made from the command center.
 // Triage-only updates are ignored; they don't touch the tree.
 if(window.FleetStore){
 FleetStore.subscribe((s, kind) => {
 if(kind === "triage" || kind === "live") return; // its own kW ticker handles live motion
 if(kind === "history"){ syncUndoRedoButtons(); return; } // just refresh button state
 if(document.getElementById("sandbox")) renderFromStore();
 });
 }
})();
