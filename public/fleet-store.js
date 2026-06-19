/* ============================================================================
 * Array Operator — FleetStore (fleet-store.js)
 *
 * THE single source of truth for the whole Arrays tab. Both the per-site fleet
 * tree (sandbox.js) and the portfolio command center (command-center.js) read
 * the SAME canonical fleet from here and route EVERY mutation through here, so a
 * change in one view (drag an inverter, create an array, mark a claim) updates
 * the other instantly — no second fetch, no drift.
 *
 * Canonical shape:
 *   array = { id, name, region, host, vendor, inverters:[ inv ] }
 *   inv   = { id, name, model, nameplate_kw, peer_index, status, window_kwh,
 *             current_power_w, stale_hours, diagnosis }
 *
 * Reactivity: subscribe(fn) → fn(state) on every change. Mutations update the
 * in-memory model + notify SYNCHRONOUSLY (instant cross-view update), then
 * persist to the backend in the background when signed in (optimistic; reverts
 * by re-fetching on failure). Peer indices are recomputed locally on structural
 * changes so the demo is genuinely reactive; the live backend stays the
 * authority and its values overwrite on the post-write refetch.
 * ==========================================================================*/
window.FleetStore = (function(){
  "use strict";

  const SESSION_KEY = "so_session";
  const TRIAGE_KEY  = "cc_triage_state";   // {rowKey: "progress"|"snoozed"}
  const CACHE_KEY   = "ao_fleet_cache";    // last real fleet tree, for instant paint on reload
  const WINDOW_DAYS = 14;
  const UNDERPERF_PI = 0.85;               // at/above = healthy
  const getSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch(e){ return null; } };

  // ---- instant-reload cache --------------------------------------------------
  // The first paint used to BLOCK on the /fleet-tree round-trip, so a slow/cold
  // backend left the sandbox blank for seconds. We now snapshot a signed-in
  // owner's real tree to localStorage and hydrate from it INSTANTLY on reload,
  // then refresh from the network in the background. Keyed per-session so a
  // different login can't read the previous owner's cached fleet.
  function cacheKeyFor(sess){ return CACHE_KEY + ":" + (sess ? sess.slice(0,12) : "anon"); }
  function saveFleetCache(arrays, recovered){
    const s = getSession(); if(!s) return;                 // only cache real, signed-in data
    try {
      localStorage.setItem(cacheKeyFor(s), JSON.stringify({
        v: 1, at: Date.now(), recovered: recovered||0, arrays: arrays
      }));
    } catch(e){ /* quota/serialise — non-fatal, just lose the fast path */ }
  }
  function readFleetCache(){
    const s = getSession(); if(!s) return null;
    try {
      const raw = localStorage.getItem(cacheKeyFor(s));
      if(!raw) return null;
      const c = JSON.parse(raw);
      if(!c || c.v !== 1 || !Array.isArray(c.arrays)) return null;
      return c;
    } catch(e){ return null; }
  }

  // ---- state ----
  const state = {
    arrays: [],
    loaded: false,
    simulated: false,
    recovered: 0,
    focus: [],                 // arrayIds the sandbox shows (subset, keeps it from being 100 columns)
    triage: loadTriage(),      // shared workflow state, keyed by `${arrayId}|${invName}`
  };
  let _invSeq = 1;             // unique inverter id allocator (demo + new)

  const subs = new Set();
  // kind ∈ "load" | "fleet" | "triage" | "focus" | "history" — lets a subscriber
  // ignore changes it doesn't care about (e.g. the fleet tree skips triage-only).
  function subscribe(fn){ subs.add(fn); if(state.loaded){ try{ fn(state,"load"); }catch(e){} } return () => subs.delete(fn); }
  function notify(kind){ subs.forEach(fn => { try{ fn(state, kind||"fleet"); }catch(e){} }); }

  /* ---- UNDO / REDO -----------------------------------------------------------
   * Command-inverse history for the DRAG operations (reassign + reorder). These
   * invert exactly (stable inverter/array ids) and their inverses call the same
   * store mutators, so the backend stays in sync (each replays the real endpoint).
   * Structural commits — createArray, deleteArray, resetLayout, and any fresh
   * load/ingest — are BARRIERS that clear history, so we never offer a broken
   * undo across an add/delete/reset. Each entry = { undo(), redo() } closures. */
  const HISTORY_LIMIT = 100;
  let _undoStack = [], _redoStack = [], _applyingHistory = false;
  function pushHistory(entry){
    if(_applyingHistory) return;            // don't record while replaying history
    _undoStack.push(entry);
    if(_undoStack.length > HISTORY_LIMIT) _undoStack.shift();
    _redoStack = [];                        // a new action invalidates the redo branch
    notify("history");
  }
  function clearHistory(){
    if(_applyingHistory) return;
    if(!_undoStack.length && !_redoStack.length) return;
    _undoStack = []; _redoStack = [];
    notify("history");
  }
  function canUndo(){ return _undoStack.length > 0; }
  function canRedo(){ return _redoStack.length > 0; }
  function undo(){
    const e = _undoStack.pop(); if(!e) return;
    _applyingHistory = true;
    try { e.undo(); } finally { _applyingHistory = false; }
    _redoStack.push(e);
    notify("history");
  }
  function redo(){
    const e = _redoStack.pop(); if(!e) return;
    _applyingHistory = true;
    try { e.redo(); } finally { _applyingHistory = false; }
    _undoStack.push(e);
    notify("history");
  }

  function loadTriage(){ try { return JSON.parse(localStorage.getItem(TRIAGE_KEY))||{}; } catch(e){ return {}; } }
  function saveTriage(){ try { localStorage.setItem(TRIAGE_KEY, JSON.stringify(state.triage)); } catch(e){} }

  /* ===========================================================================
   * DERIVED HELPERS — peer-index recompute + per-array alert rollup
   * ==========================================================================*/

  // Recompute each producing inverter's peer_index (share of harvest vs share of
  // hardware) against its CURRENT array cohort, and refresh ok/underperforming.
  // Intrinsic states (dead/fault/comm_gap) are hardware/comms facts — left as-is.
  //
  // EVIDENCE GUARD: a peer verdict ("Below its neighbors") is only honest when we
  // actually have the history to back it. When an inverter has no usable 14-day
  // window (freshly connected, no daily history yet) OR there are fewer than 2
  // producing peers with history to compare against (degenerate cohort), we can't
  // judge it — so it gets the neutral "monitoring" status instead of a green/amber
  // verdict it hasn't earned. This is what fixes cards reading "Below its
  // neighbors" while showing "no history yet" and a healthy live output %.
  function recompute(a){
    const producing = a.inverters.filter(i => i.status==="ok" || i.status==="underperforming" || i.status==="monitoring");
    const eligible = producing.filter(i => i.nameplate_kw>0 && i.window_kwh!=null && i.window_kwh>0);
    const so = eligible.map(i => i.window_kwh / i.nameplate_kw);
    let median = 0;
    if(so.length){ const s=[...so].sort((x,y)=>x-y); median = s[Math.floor(s.length/2)]; }
    // Need at least 2 inverters WITH history to have a real peer comparison.
    const haveCohort = eligible.length >= 2 && median > 0;
    producing.forEach(i => {
      const hasHistory = i.nameplate_kw>0 && i.window_kwh!=null && i.window_kwh>0;
      if(!haveCohort || !hasHistory){
        // Not enough evidence to judge — show neutral, claim nothing.
        i.status = "monitoring";
        i.peer_index = null;
        i.diagnosis = "Gathering data — not enough history yet to compare against its neighbors.";
        return;
      }
      const pi = (i.window_kwh / i.nameplate_kw) / median;
      i.peer_index = Math.round(pi*100)/100;
      i.status = pi >= UNDERPERF_PI ? "ok" : "underperforming";
      i.diagnosis = i.status==="ok"
        ? "Pulling its weight."
        : `Running ~${Math.round((1-pi)*100)}% below its neighbors under the same sky — likely shading, soiling, or a tired string.`;
    });
  }

  function alertFor(a){
    const f = a.inverters;
    const dead = f.some(i => i.status==="dead" || i.status==="fault");
    const under = f.filter(i => i.status==="underperforming").length;
    const quiet = f.some(i => i.status==="comm_gap");
    // "monitoring" is neutral (not enough evidence) — it is NOT a flag.
    const flagged = f.filter(i => i.status!=="ok" && i.status!=="monitoring").length;
    if(dead)  return { level:"critical", count:flagged, status:"dead",            headline:"An inverter stopped earning" };
    if(under) return { level:"warn",     count:flagged, status:"underperforming", headline:"A money leak caught early" };
    if(quiet) return { level:"warn",     count:flagged, status:"comm_gap",        headline:"An inverter has gone quiet" };
    return      { level:"ok",       count:0,       status:"ok",             headline:"All clear" };
  }

  /* ===========================================================================
   * LIVE LIVENESS — the SINGLE shared classifier for "is this inverter dark
   * right now?". The fleet tree (sandbox.js), the overview grid, and the command
   * center ALL call this, so the three surfaces can never again disagree about a
   * live anomaly the way they did when each derived health from inv.status alone.
   *
   * This is deliberately SEPARATE from inv.status (the 14-day peer_analysis
   * verdict). status answers "healthy over the window?"; liveVerdict answers
   * "producing this instant, vs its daylight peers?". An inverter that just
   * stalled reads status:"ok" for up to ~2 days — liveVerdict catches it now.
   *   "ok"    producing, OR calmly idle (night / peers idle too / <2 lit peers)
   *   "dark"  fresh reading ~0 W while >=2 daylight peers produce — a real anomaly
   *   "stale" NO live reading while peers produce — unknown, not a confirmed fault
   * ==========================================================================*/
  const LIVE_FLOOR_W = 25;   // below this (or 1% of rated) = idle, not "producing"
  function _liveFloor(inv){
    return inv.nameplate_kw!=null ? Math.max(LIVE_FLOOR_W, inv.nameplate_kw*1000*0.01) : LIVE_FLOOR_W;
  }
  function isProducing(inv){
    return inv && inv.current_power_w!=null && inv.current_power_w > _liveFloor(inv);
  }
  // peers identity: same array of inverter objects across all callers, so
  // reference equality is the primary test; id is a defensive fallback.
  function _samePeer(a,b){
    return a===b
      || (a.inverter_id!=null && a.inverter_id===b.inverter_id)
      || (a.id!=null && a.id===b.id);
  }
  function liveVerdict(inv, peers, isDaylight){
    if(isDaylight === false) return "ok";          // night: zero is expected (Sleeping)
    if(isProducing(inv)) return "ok";              // making power — clearly fine
    const lit = (peers||[]).filter(p => !_samePeer(p, inv) && isProducing(p)).length;
    if(lit < 2) return "ok";                       // not enough peer signal to judge
    return (inv.current_power_w != null) ? "dark" : "stale";
  }
  // True when an inverter that 14-day health calls "ok" is actually a live
  // anomaly RIGHT NOW (dark while peers produce). This is the cross-surface flag.
  function isLiveAnomaly(inv, peers, isDaylight){
    return inv.status === "ok" && liveVerdict(inv, peers, isDaylight) === "dark";
  }

  /* ===========================================================================
   * SELECTORS — shape the canonical fleet for each consumer
   * ==========================================================================*/

  // sandbox shape: { columns:[…], summary:{…} }. `ids` optional → focus subset.
  function toColumns(ids){
    const list = (ids && ids.length) ? state.arrays.filter(a => ids.includes(a.id)) : state.arrays;
    const columns = list.map(a => ({
      array_id: a.id, array_name: a.name, vendor: a.vendor || "solaredge",
      inverter_source: "solaredge", inverter_count: a.inverters.length,
      alert: alertFor(a),
      daily: a.daily || [],   // array-level production history (Chint weekETrend backfill etc.)
      is_daylight: a.is_daylight !== false,   // sun-up flag for the card "Sleeping" state
      source_status: a.source_status || null,  // vendor-side data freshness → outage banner
      inverters: a.inverters.map(i => ({
        inverter_id: i.id, name: i.name, model: i.model, nameplate_kw: i.nameplate_kw,
        peer_index: i.peer_index, status: i.status, diagnosis: i.diagnosis,
        window_kwh: i.window_kwh, current_power_w: i.current_power_w,
        daily: i.daily || [], min_kwh: i.min_kwh, peak_kwh: i.peak_kwh,
        last_mode: i.status==="dead" ? "SHUTDOWN" : i.status==="comm_gap" ? "" : "PRODUCING",
        vendor: a.vendor || "solaredge",
      })),
    }));
    const invTotal = list.reduce((t,a)=>t+a.inverters.length,0);
    return { tiers:["alerts","arrays","inverters"],
             summary:{ arrays_total:list.length, inverters_total:invTotal,
                       attention:list.filter(a=>alertFor(a).level!=="ok").length },
             columns };
  }

  // command-center shape: the raw canonical arrays + meta (it computes its own KPIs)
  function snapshot(){ return { arrays: state.arrays, simulated: state.simulated, recovered_ytd: state.recovered }; }

  function focusColumns(){
    const out = toColumns(state.focus.length ? state.focus : defaultFocusIds());
    // Never blank the tree while arrays exist — if a stale/empty focus filtered
    // everything out, fall back to the default focus so the sandbox always shows
    // something (mirrors the command center, which renders all arrays).
    if(!out.columns.length && state.arrays.length) return toColumns(defaultFocusIds());
    return out;
  }
  function focusIds(){ return state.focus.length ? state.focus.slice() : defaultFocusIds(); }
  // True when the tree is showing a NARROWED subset (owner drilled into one/few
  // arrays from the overview grid) rather than the full default focus — drives the
  // sandbox "Show all arrays" button.
  function focusIsNarrowed(){
    if(!state.focus.length) return false;          // empty focus = default (all/worst-few)
    return state.focus.length < state.arrays.length;
  }
  function clearFocus(){ state.focus = []; notify("focus"); }

  // Default sandbox focus.
  // A REAL signed-in owner ALWAYS sees EVERY array — never a subset. Hiding any of
  // an owner's real arrays reads as "the app forgot my arrays" (it never lost them;
  // the data is persisted server-side). This is a hard product invariant.
  // The "worst few" narrowing exists ONLY to keep the ANONYMOUS 100-array SIMULATED
  // demo fleet from opening as 100 columns for a marketing visitor.
  function defaultFocusIds(){
    // Real owner (signed-in, non-simulated): show all arrays, no exceptions.
    if(!state.simulated) return state.arrays.map(a => a.id);
    // Anonymous demo only: open on the worst few sites so it isn't 100 columns.
    const scored = state.arrays.map(a => {
      const flagged = a.inverters.filter(i=>i.status!=="ok").length;
      return { id:a.id, flagged };
    }).sort((x,y)=> y.flagged - x.flagged);
    const worst = scored.filter(s=>s.flagged>0).slice(0,4).map(s=>s.id);
    return worst.length ? worst : state.arrays.slice(0,3).map(a=>a.id);
  }

  /* ===========================================================================
   * MUTATIONS — update in-memory, notify SYNC, persist async when live
   * ==========================================================================*/
  const isLive = () => !!getSession();
  function apiPost(path, body){
    const s = getSession();
    return fetch(path, { method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+s },
      body: body!=null ? JSON.stringify(body) : "{}" })
      .then(r => { if(!r.ok) throw new Error(path+" "+r.status); return r.json().catch(()=>({})); });
  }
  function apiDelete(path){
    const s = getSession();
    return fetch(path, { method:"DELETE", headers:{ "Authorization":"Bearer "+s } })
      .then(r => { if(!r.ok) throw new Error(path+" "+r.status); return r.json().catch(()=>({})); });
  }

  function findArray(id){ return state.arrays.find(a => String(a.id)===String(id)); }
  function findInv(invId){
    for(const a of state.arrays){ const i=a.inverters.find(x=>String(x.id)===String(invId)); if(i) return {a,i}; }
    return null;
  }

  // move an inverter to another array at `position`; recompute BOTH cohorts.
  function reassignInverter(invId, toArrayId, position){
    const hit = findInv(invId); const dest = findArray(toArrayId);
    if(!hit || !dest) return;
    const { a:from, i } = hit;
    const fromArrayId = from.id;                          // capture origin for the inverse
    const fromPos = from.inverters.indexOf(i);
    from.inverters = from.inverters.filter(x => x !== i);
    const pos = Math.max(0, Math.min(position==null?dest.inverters.length:position, dest.inverters.length));
    dest.inverters.splice(pos, 0, i);
    recompute(from); recompute(dest);
    notify();
    // Record an exact inverse (stable ids) for undo/redo. A move BACK to the same
    // array is just a no-op origin; skip pushing history then.
    if(String(fromArrayId) !== String(toArrayId)){
      pushHistory({
        redo: () => reassignInverter(invId, toArrayId, pos),
        undo: () => reassignInverter(invId, fromArrayId, fromPos),
      });
    }
    if(isLive()){
      apiPost("/v1/array-owners/inverters/reassign",
              { inverter_id: invId, target_array_id: toArrayId, position: pos })
        .then(() => refetch()).catch(() => refetch());
    }
  }

  function reorderInverters(arrayId, orderedIds){
    const a = findArray(arrayId); if(!a) return;
    const oldOrder = a.inverters.map(i => String(i.id));  // capture for the inverse
    const byId = new Map(a.inverters.map(i => [String(i.id), i]));
    const next = orderedIds.map(id => byId.get(String(id))).filter(Boolean);
    a.inverters.forEach(i => { if(!next.includes(i)) next.push(i); });
    a.inverters = next;
    const newOrder = a.inverters.map(i => String(i.id));
    notify();
    // Only record if the order actually changed.
    if(oldOrder.join(",") !== newOrder.join(",")){
      pushHistory({
        redo: () => reorderInverters(arrayId, newOrder),
        undo: () => reorderInverters(arrayId, oldOrder),
      });
    }
    if(isLive()){
      apiPost("/v1/array-owners/inverters/reorder", { array_id: arrayId, ordered_inverter_ids: orderedIds })
        .catch(() => refetch());
    }
  }

  function createArray(name){
    const id = "new-" + (_invSeq++);
    state.arrays.push({ id, name, region:"—", host:"", vendor:"", inverters:[] });
    notify();
    clearHistory();   // structural commit — a barrier (drag history doesn't cross it)
    if(isLive()){ apiPost("/v1/array-owners/arrays", { name }).then(()=>refetch()).catch(()=>refetch()); }
    return id;
  }

  function deleteArray(id){
    const idx = state.arrays.findIndex(a => String(a.id) === String(id));
    if(idx === -1) return;                                 // nothing matched
    const removed = state.arrays[idx];                     // keep full data for undo
    const wasFocused = state.focus.some(f => String(f) === String(id));
    state.arrays = state.arrays.filter(a => String(a.id) !== String(id));
    state.focus = state.focus.filter(f => String(f) !== String(id));
    notify();                                              // optimistic, sync cross-view update
    // Persist the soft-delete. (refetch re-ingests the authoritative tree.)
    if(isLive()){
      apiDelete("/v1/array-owners/arrays/" + encodeURIComponent(id))
        .then(()=>refetch()).catch(()=>refetch());
    }
    // Record an UNDOABLE delete: undo re-inserts the array locally at its old spot
    // AND revives it server-side via the restore endpoint; redo re-deletes it.
    pushHistory({
      undo: () => {
        // re-insert locally at the original index (clamped)
        if(!state.arrays.some(a => String(a.id) === String(id))){
          const at = Math.min(idx, state.arrays.length);
          state.arrays.splice(at, 0, removed);
          if(wasFocused && !state.focus.some(f => String(f) === String(id))) state.focus.push(id);
        }
        notify();
        if(isLive()){
          apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/restore")
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
      redo: () => {
        state.arrays = state.arrays.filter(a => String(a.id) !== String(id));
        state.focus = state.focus.filter(f => String(f) !== String(id));
        notify();
        if(isLive()){
          apiDelete("/v1/array-owners/arrays/" + encodeURIComponent(id))
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
    });
  }

  function resetLayout(){
    clearHistory();   // server regroups everything — a barrier
    if(isLive()){ apiPost("/v1/array-owners/layout/reset").then(()=>refetch()).catch(()=>refetch()); }
    else { notify(); }   // demo has no server grouping to snap back to
  }

  function setTriage(key, st){
    if(st==="new") delete state.triage[key]; else state.triage[key]=st;
    saveTriage(); notify("triage");
  }
  function setTriageBatch(keys, st){
    keys.forEach(k => { if(st==="new") delete state.triage[k]; else state.triage[k]=st; });
    saveTriage(); notify("triage");
  }
  function triageState(key){ return state.triage[key] || "new"; }

  function setFocus(ids){ state.focus = (ids||[]).map(x=>x); notify("focus"); }

  /* ===========================================================================
   * LOAD — one fetch (live) or one simulated fleet (demo), shared by both views
   * ==========================================================================*/
  let _lastUpdate = 0;
  function ingest(arrays, opts){
    state.arrays = arrays;
    state.simulated = !!(opts && opts.simulated);
    state.recovered = (opts && opts.recovered) || 0;
    state.arrays.forEach(recompute);
    // Reconcile the sandbox focus against the NEW array set. Drop any focused ids
    // that no longer exist (demo→live swap, or arrays the extension added after a
    // prior load) — otherwise a stale focus filters every real array out and the
    // fleet tree renders blank while the command center (which reads ALL arrays)
    // shows them. If nothing valid remains, fall back to the default focus.
    const liveIds = new Set(state.arrays.map(a => a.id));
    state.focus = state.focus.filter(id => liveIds.has(id));
    if(!state.focus.length) state.focus = defaultFocusIds();
    state.loaded = true;
    _lastUpdate = Date.now();
    // Snapshot real, signed-in fleet data for an instant paint on the next reload.
    // (Skip the simulated demo and the hydrate path itself, which pass fromCache.)
    if(!state.simulated && !(opts && opts.fromCache) && getSession()){
      saveFleetCache(arrays, state.recovered);
    }
    startHeartbeat();
    notify("load");
  }

  /* ---- live heartbeat: keeps the dashboard genuinely live ----
   * Real data → poll the backend every ~45s and re-ingest. Simulated demo →
   * gently evolve the fleet so the KPIs visibly breathe. Either way we stamp
   * _lastUpdate and emit "live" (a lightweight beat the command center repaints
   * in place; the fleet tree ignores it — its own kW ticker handles motion). */
  let _hb = null, _beat = 0;
  function startHeartbeat(){
    if(_hb) return;
    _hb = setInterval(() => {
      _beat++;
      if(state.simulated){
        liveDrift();
        _lastUpdate = Date.now();
        notify("live");
      } else if(_beat % 9 === 0){           // ~45s
        refetch();                          // real telemetry refresh (ingest stamps _lastUpdate)
      }
    }, 5000);
  }
  // bounded random-walk on the demo fleet: underperformers' recent output and the
  // recovered total drift a little each beat. No status flips → no structural churn.
  function liveDrift(){
    state.arrays.forEach(a => {
      a.inverters.forEach(i => {
        if(i.current_power_w != null && i.current_power_w > 0){
          if(i._baseP == null) i._baseP = i.current_power_w;
          i.current_power_w = Math.max(0, Math.round(i._baseP * (1 + (Math.random()-0.5)*0.03)));
        }
        if(i.status === "underperforming" && i.window_kwh){
          i.window_kwh = Math.max(1, i.window_kwh * (1 + (Math.random()-0.5)*0.012));
        }
      });
    });
    if(Math.random() < 0.3) state.recovered += Math.round(10 + Math.random()*60);
  }

  function refetch(){
    const s = getSession(); if(!s) return Promise.resolve();
    return fetch("/v1/array-owners/fleet-tree", { headers:{ Authorization:"Bearer "+s } })
      .then(r => {
        if(r.status === 401 || r.status === 403){ const e = new Error("auth"); e.auth = true; throw e; }
        if(!r.ok) throw 0;
        return r.json();
      })
      // A signed-in owner's REAL tree — ingest it even when empty (no columns),
      // so a freshly-added-but-still-empty array is reflected, NOT masked by demo.
      .then(t => { ingest(adaptTree(t), { recovered:(t.summary&&t.summary.recovered_ytd)||0 }); })
      .catch((err)=>{ if(err && err.auth) onAuthExpired(); /* transient: keep current state */ });
  }

  // Session expired/invalid while signed in. Clear the dead token and flip the
  // store to a signed-out state so views prompt re-auth instead of showing the
  // simulated demo fleet over the owner's real (still-persisted) arrays.
  function onAuthExpired(){
    const s = getSession();
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
    try { if(s) localStorage.removeItem(cacheKeyFor(s)); } catch(e){}
    state.arrays = []; state.simulated = false; state.authExpired = true;
    state.loaded = true; state.focus = [];
    notify("auth");
  }

  let _loading = false;
  function load(){
    if(state.loaded || _loading) return;     // single shared bootstrap — both views may call it
    _loading = true;
    if(getSession()){
      // INSTANT PAINT: if we have a cached snapshot of this owner's real tree,
      // ingest it immediately so the sandbox renders with zero network wait, then
      // refresh from the backend in the background and re-ingest the authoritative
      // tree when it arrives. No cache (first ever load) → fall through to fetch.
      const cached = readFleetCache();
      if(cached){
        ingest(cached.arrays, { recovered: cached.recovered, fromCache: true });
      }
      fetch("/v1/array-owners/fleet-tree", { headers:{ Authorization:"Bearer "+getSession() } })
        .then(r => {
          // 401/403 = expired/invalid session, NOT a data outage. Do not paint
          // the simulated demo fleet over the owner's real arrays.
          if(r.status === 401 || r.status === 403){ const e = new Error("auth"); e.auth = true; throw e; }
          if(!r.ok) throw 0;
          return r.json();
        })
        .then(t => {
          // Signed in → always show the owner's REAL tree, even if it's empty.
          // Empty means "you haven't connected/added anything yet" (honest empty
          // state), NEVER the fake 100-array demo — that's only for anon visitors.
          ingest(adaptTree(t), { recovered:(t.summary&&t.summary.recovered_ytd)||0 });
        })
        .catch((err) => {
          if(err && err.auth){ onAuthExpired(); return; }
          // Transient (network/5xx) for a signed-in owner: keep the cached tree if
          // we painted one; otherwise show an honest empty tree (never a fake fleet).
          if(!cached) ingest([], {});
        });
    } else {
      // Anonymous visitor (marketing/preview) — the simulated fleet tells the story.
      ingest(simulateFleet(), { simulated:true, recovered:18450 });
    }
  }

  // adapt the live fleet-tree (sandbox columns) → canonical arrays
  function adaptTree(t){
    return (t.columns||[]).map(c => ({
      id: c.array_id, name: c.array_name, region:"—", host: c.client_name||"",
      vendor: c.vendor||"solaredge",
      // Array-level production history (backend DailyGeneration) — used by the
      // array graph when inverters carry site-level history but no per-inverter
      // series (e.g. Chint weekETrend backfill).
      daily: c.daily || [],
      // Server-computed sun-up flag (real solar elevation) — gates the card's
      // calm "Sleeping" night state on (night AND zero output), never zero alone.
      is_daylight: c.is_daylight !== false,
      // Source-data freshness {state:ok|stale|none,last_report,age_hours}. Carried
      // through so the card can flag a VENDOR-side reporting outage (not ours).
      source_status: c.source_status || null,
      inverters: (c.inverters||[]).map(inv => ({
        id: inv.inverter_id!=null ? inv.inverter_id : ("inv-"+(_invSeq++)),
        name: inv.name, model: inv.model, nameplate_kw: inv.nameplate_kw,
        peer_index: inv.peer_index, status: inv.status, window_kwh: inv.window_kwh,
        current_power_w: inv.current_power_w, stale_hours: inv.stale_hours,
        daily: inv.daily || [], min_kwh: inv.min_kwh, peak_kwh: inv.peak_kwh,
        diagnosis: inv.diagnosis || "",
      })),
    }));
  }

  /* ---- deterministic 100-array simulated fleet (demo / preview) ---- */
  function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
  const REGIONS = ["Northern VT","Mad River Valley","Champlain Islands","NH Upper Valley","The Berkshires","Central VT"];
  const HOSTS   = ["Green Mountain Solar","Catamount Energy Co-op","Maple Ridge Community","Sugarbush Holdings","Lakeside Dairy LLC","Riverbend Schools","Northfield Municipal","Birchwood Properties"];
  const PLACES  = ["Londonderry","Maple Street","Cover Catamount","Stowe Hollow","Waitsfield","Bristol Cliffs","Hinesburg Flats","Richmond Bridge","Underhill","Jericho Center","Cabot Creamery","Hardwick","Craftsbury","Greensboro Bend","Morrisville","Johnson Mill","Enosburg Falls","Swanton Yard","Grand Isle","Vergennes","Middlebury","Brandon Depot","Rutland Yard","Killington Base","Ludlow Mill","Chester Depot","Springfield Works","Bellows Falls","Brattleboro","Wilmington Ridge","Dover Notch","Manchester Center","Bennington Mill","Pownal Flats","Arlington","Dorset Quarry","Pawlet","Poultney","Fair Haven","Castleton"];
  const NAMEPLATES = [10,11.4,20,33.3];
  function simulateFleet(){
    const rng = mulberry32(0x5ECA11);
    const pick = arr => arr[Math.floor(rng()*arr.length)];
    const arrays = [];
    for(let n=0;n<100;n++){
      const invCount = 8 + Math.floor(rng()*9);
      const place = PLACES[n % PLACES.length];
      const name = n < PLACES.length ? place : `${place} ${Math.floor(n/PLACES.length)+1}`;
      const inverters = [];
      for(let j=0;j<invCount;j++){
        const r = rng(); let status="ok";
        if(r<0.020) status="dead"; else if(r<0.030) status="fault";
        else if(r<0.085) status="underperforming"; else if(r<0.115) status="comm_gap";
        const np = pick(NAMEPLATES);
        const fair = np * 4.6 * WINDOW_DAYS;
        let pi=1+(rng()-0.5)*0.06, win=fair*pi, power=np*1000*(0.55+rng()*0.25);
        if(status==="underperforming"){ pi=0.55+rng()*0.27; win=fair*pi; power=np*1000*(0.30+rng()*0.20); }
        else if(status==="comm_gap"){ pi=null; win=fair*(0.6+rng()*0.3); power=null; }
        else if(status==="dead"){ pi=null; win=0; power=0; }
        else if(status==="fault"){ pi=0.18+rng()*0.18; win=fair*pi; power=np*1000*0.12; }
        // synthetic 14-day daily kWh series for the demo card graph (demo fleet only;
        // a real signed-in owner gets the backend's real per-inverter daily series).
        const fairDay = np * 4.6;            // a "fair" day's kWh for this nameplate
        const daily = [];
        for(let day=0; day<WINDOW_DAYS; day++){
          let kwh;
          if(status==="dead") kwh = day < WINDOW_DAYS-3 ? fairDay*(0.85+rng()*0.3) : 0;       // recently died
          else if(status==="comm_gap") kwh = day < WINDOW_DAYS-2 ? fairDay*(0.8+rng()*0.3) : 0; // went quiet
          else if(status==="underperforming") kwh = fairDay*(0.45+rng()*0.25);
          else if(status==="fault") kwh = fairDay*(0.1+rng()*0.2);
          else kwh = fairDay*(0.8+rng()*0.35);
          daily.push({ date:`d-${WINDOW_DAYS-day}`, kwh: Math.round(kwh*10)/10 });
        }
        const kwhVals = daily.map(d=>d.kwh);
        inverters.push({
          id: _invSeq++, name:`Inverter ${j+1}`, model:`SE${np}K`, nameplate_kw:np,
          peer_index:pi, status, window_kwh:Math.round(win*10)/10,
          current_power_w: power==null?null:Math.round(power),
          daily, min_kwh: Math.round(Math.min(...kwhVals)*10)/10, peak_kwh: Math.round(Math.max(...kwhVals)*10)/10,
          stale_hours: status==="comm_gap" ? Math.round(12+rng()*60) : (status==="dead"? Math.round(48+rng()*120):null),
          diagnosis: "",
        });
      }
      arrays.push({ id:n+1, name, region:pick(REGIONS), host:pick(HOSTS), vendor:"solaredge", inverters });
    }
    return arrays;
  }

  // ---- public API ----
  return {
    subscribe, load, refetch,
    snapshot, toColumns, focusColumns, focusIds, setFocus, defaultFocusIds,
    focusIsNarrowed, clearFocus,
    reassignInverter, reorderInverters, createArray, deleteArray, resetLayout,
    setTriage, setTriageBatch, triageState, isLive,
    liveVerdict, isProducing, isLiveAnomaly,   // shared live-liveness classifier (all 3 surfaces)
    undo, redo, canUndo, canRedo, clearHistory,
    isLoaded: () => state.loaded,
    isSimulated: () => !!state.simulated,
    lastUpdate: () => _lastUpdate,
    WINDOW_DAYS,
  };
})();
