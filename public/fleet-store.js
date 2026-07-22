/* ============================================================================
 * Array Operator, FleetStore (fleet-store.js)
 *
 * THE single source of truth for the whole Arrays tab. Both the per-site fleet
 * tree (sandbox.js) and the portfolio command center (command-center.js) read
 * the SAME canonical fleet from here and route EVERY mutation through here, so a
 * change in one view (drag an inverter, create an array, mark a claim) updates
 * the other instantly, no second fetch, no drift.
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

  // ---- absolute modeled-target check (for arrays with NO usable peer cohort) ----
  // Peer analysis needs >=2 inverters with history; a LONE inverter (or one whose
  // siblings have no history) can never be peer-judged, so without this it would
  // read "All clear"/"monitoring" forever even while sagging badly. For those units
  // we fall back to an ABSOLUTE model: compare real production to what this nameplate
  // typically makes here. Deliberately conservative, a single unit has no weather
  // control group, so we only flag a CLEAR, LARGE shortfall (well past normal model
  // + weather noise), never a marginal dip.
  //
  // Typical Northeast-US fixed-tilt PV AC capacity factor by month (NREL PVWatts-
  // class: ~13-14% annual, summer peak ~18%, winter trough ~7%). A MODEL, not a
  // measurement, hence the wide shortfall band below.
  const CF_BY_MONTH = [0.072,0.095,0.135,0.160,0.175,0.182,0.180,0.168,0.145,0.110,0.072,0.060];
  const seasonalCF = () => CF_BY_MONTH[new Date().getMonth()] || 0.14;
  // Solo units get a much wider tolerance than the peer path (0.85): only below ~55%
  // of the modeled target, a ~45% shortfall no cloudy fortnight explains, trips it.
  const SOLO_TARGET_RATIO = 0.55;
  // Live (instantaneous) absolute floor for a peerless unit: below ~20% of nameplate
  // at solar noon is a clear sag; we gate it to mid-day (see liveVerdict) so morning/
  // evening ramp never false-flags.
  const SOLO_LIVE_PCT = 0.20;

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
        // v:2 — cache includes inverter/array `daily` for 14-day sparklines
        // (v:1 sanitize stripped them → flat Waterford graphs on cold load).
        v: 2, at: Date.now(), recovered: recovered||0, arrays: arrays
      }));
    } catch(e){ /* quota/serialise, non-fatal, just lose the fast path */ }
  }
  // Sanitize a single inverter object from the cache. localStorage is same-origin
  // writable, so a hijacked/XSS-poisoned entry could carry hostile shapes; coerce to
  // the fields recompute()/alertFor()/renderers actually read and drop anything that
  // isn't a plain object. Strings are bounded so a giant injected serial can't bloat
  // the DOM. Unknown extra keys are dropped (not spread) so nothing rides along.
  const _str = (x, max) => (typeof x === "string" ? x.slice(0, max || 120) : (x == null ? "" : String(x).slice(0, max || 120)));
  const _num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
  function sanitizeDaily(pts){
    // Keep 14-day sparkline history through the instant-reload cache.
    // Without this, sanitizeInverter dropped `daily` on every cold paint so
    // Waterford (and any extension-captured site) showed flat "no history"
    // sparklines until/unless the live fleet-tree returned — and a failed or
    // slow live pull left the table stuck empty even when DB had good kWh.
    if(!Array.isArray(pts)) return [];
    const out = [];
    for(let i = 0; i < pts.length && out.length < 32; i++){
      const d = pts[i];
      if(!d || typeof d !== "object") continue;
      const kwh = _num(d.kwh);
      if(kwh == null || kwh < 0) continue;
      const date = d.date != null ? _str(d.date, 32) : null;
      if(!date) continue;
      out.push({ date, kwh });
    }
    return out;
  }
  function sanitizeInverter(iv){
    if(!iv || typeof iv !== "object" || Array.isArray(iv)) return null;
    const out = {
      id: iv.id != null ? _str(iv.id, 64) : ("iv" + (_invSeq++)),
      name: _str(iv.name, 80),
      serial: _str(iv.serial, 80),
      vendor: _str(iv.vendor, 40),
      status: _str(iv.status, 24),
      nameplate_kw: _num(iv.nameplate_kw),
      current_power_w: _num(iv.current_power_w),
      window_kwh: _num(iv.window_kwh),
      produced_today_kwh: _num(iv.produced_today_kwh),
      peer_index: _num(iv.peer_index),
      min_kwh: _num(iv.min_kwh),
      peak_kwh: _num(iv.peak_kwh),
      last_seen: iv.last_seen != null ? _str(iv.last_seen, 40) : null,
      // Live-reading provenance — MUST survive the cache/allow-list or liveVerdict
      // goes blind to estimated splits + stale readings and re-flags them (the bug).
      power_estimated: iv.power_estimated === true,
      power_age_hours: _num(iv.power_age_hours),
      no_energy_register: !!iv.no_energy_register,
      // Owner-confirmed expected-low (shading): judged against its own baseline, so
      // it must NOT be re-flagged "underperforming"/"low" here. Carry through.
      expected_low: iv.expected_low === true,
      expected_low_reason: iv.expected_low_reason != null ? _str(iv.expected_low_reason, 240) : null,
      expected_low_baseline: _num(iv.expected_low_baseline),
      expected_low_breach: iv.expected_low_breach === true,
      // 14-day history for Table/Sandbox sparklines (was dropped — Waterford bug).
      daily: sanitizeDaily(iv.daily),
    };
    return out;
  }
  function sanitizeArray(a){
    if(!a || typeof a !== "object" || Array.isArray(a)) return null;
    if(a.id == null) return null;                          // the id is load-bearing (focus, findArray, dedupe)
    const invs = Array.isArray(a.inverters)
      ? a.inverters.map(sanitizeInverter).filter(Boolean)
      : [];
    // Ford 2026-07-09: organize the inverters in each array by size (kW), smallest
    // at the top. This is the default presentation order everywhere they're listed
    // (vendor sheet, fleet cards, inverter detail). Unknown-size units sort last;
    // ties break by name then id so the order is stable across reloads.
    invs.sort((x, y) => {
      const xk = x.nameplate_kw == null ? Infinity : x.nameplate_kw;
      const yk = y.nameplate_kw == null ? Infinity : y.nameplate_kw;
      if (xk !== yk) return xk - yk;
      return String(x.name || x.id).localeCompare(String(y.name || y.id));
    });
    return {
      id: _str(a.id, 64),
      name: _str(a.name, 120),
      region: a.region != null ? _str(a.region, 80) : "—",
      host: _str(a.host, 200),
      vendor: _str(a.vendor, 40),
      portfolio_name: a.portfolio_name != null ? _str(a.portfolio_name, 80) : null,
      reminder: a.reminder != null ? _str(a.reminder, 2000) : null,
      daily: sanitizeDaily(a.daily),
      produced_today_kwh: _num(a.produced_today_kwh),
      current_power_w: _num(a.current_power_w),
      inverters: invs,
    };
  }
  function readFleetCache(){
    const s = getSession(); if(!s) return null;
    try {
      const raw = localStorage.getItem(cacheKeyFor(s));
      if(!raw) return null;
      const c = JSON.parse(raw);
      // Accept v1 (no daily) and v2 (with daily); both go through sanitize.
      if(!c || typeof c !== "object" || (c.v !== 1 && c.v !== 2) || !Array.isArray(c.arrays)) return null;
      // Validate + coerce each cached array to the known shape; drop malformed ones
      // rather than trusting the blob wholesale. A poisoned cache degrades to a network
      // load, never to executing/rendering attacker-shaped data.
      const arrays = c.arrays.map(sanitizeArray).filter(Boolean);
      const recovered = _num(c.recovered) || 0;
      return { v: 1, at: _num(c.at) || 0, recovered, arrays };
    } catch(e){
      // Corrupt/poisoned cache: degrade to a network load (return null), but say so —
      // a silent swallow hides a recurring poisoned-cache bug. Behavior is unchanged.
      try { console.warn("[fleet-cache] discarding unreadable fleet cache:", e && e.message); } catch(_){}
      return null;
    }
  }

  // ---- state ----
  const state = {
    arrays: [],
    loaded: false,
    simulated: false,
    recovered: 0,
    focus: [],                 // arrayIds the sandbox shows (subset, keeps it from being 100 columns)
    triage: loadTriage(),      // shared workflow state, keyed by `${arrayId}|${invName}`
    energyRate: null,          // $/kWh the owner is actually billed at (backend default_net_rate_per_kwh); null until fetched
    liveReady: false,          // true once the LIVE (not stored/lite) fleet-tree has landed
    refreshingLive: false,     // true while background live enrichment is in flight after stored paint
  };
  // The dashboard "$ at risk / recoverable" figures must reflect what the owner
  // actually bills, not a marketing-blended guess. reports.js bills from the
  // backend's configured default_net_rate_per_kwh; the loss math used a hardcoded
  // $0.21/kWh, overstating recoverable dollars ~14% for a typical ~$0.184 rate.
  // We fetch the real rate once per signed-in load and expose it via energyRate();
  // consumers fall back to ENERGY_RATE_FALLBACK so demo/anon math is unchanged.
  const ENERGY_RATE_FALLBACK = 0.21;   // $/kWh, blended VT-ish offset (demo + pre-fetch)
  function energyRate(){ return state.energyRate != null ? state.energyRate : ENERGY_RATE_FALLBACK; }
  function fetchEnergyRate(){
    const s = getSession(); if(!s) return;                 // demo/anon keeps the fallback
    fetch("/v1/array-operator/billing/global-rate", { headers:{ Authorization:"Bearer "+s } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const n = d && Number(d.default_net_rate_per_kwh);
        if(n != null && isFinite(n) && n > 0 && n < 5){   // sane $/kWh guard
          if(state.energyRate !== n){ state.energyRate = n; notify("rate"); }
        }
      })
      .catch(()=>{ /* transient, keep fallback, retried on next load/refetch */ });
  }
  let _invSeq = 1;             // unique inverter id allocator (demo + new)

  const subs = new Set();
  // kind ∈ "load" | "fleet" | "triage" | "focus" | "history", lets a subscriber
  // ignore changes it doesn't care about (e.g. the fleet tree skips triage-only).
  function subscribe(fn){ subs.add(fn); if(state.loaded){ try{ fn(state,"load"); }catch(e){} } return () => subs.delete(fn); }
  function notify(kind){ subs.forEach(fn => { try{ fn(state, kind||"fleet"); }catch(e){} }); }

  /* ---- UNDO / REDO -----------------------------------------------------------
   * Command-inverse history for the DRAG operations (reassign + reorder). These
   * invert exactly (stable inverter/array ids) and their inverses call the same
   * store mutators, so the backend stays in sync (each replays the real endpoint).
   * Structural commits, createArray, deleteArray, resetLayout, and any fresh
   * load/ingest, are BARRIERS that clear history, so we never offer a broken
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
   * DERIVED HELPERS, peer-index recompute + per-array alert rollup
   * ==========================================================================*/

  // Recompute each producing inverter's peer_index (share of harvest vs share of
  // hardware) against its CURRENT array cohort, and refresh ok/underperforming.
  // Intrinsic states (dead/fault/comm_gap) are hardware/comms facts, left as-is.
  //
  // EVIDENCE GUARD: a peer verdict ("Below its neighbors") is only honest when we
  // actually have the history to back it. When an inverter has no usable 14-day
  // window (freshly connected, no daily history yet) OR there are fewer than 2
  // producing peers with history to compare against (degenerate cohort), we can't
  // judge it, so it gets the neutral "monitoring" status instead of a green/amber
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
      if(i.expected_low){
        // Owner-confirmed expected-low (shading): the BACKEND already re-baselined
        // this unit against its own recorded level (peer_analysis) and set its
        // status/diagnosis/expected_low_breach accordingly. Never override that here
        // with a raw peer comparison — that would re-introduce the false
        // "underperforming". Just refresh peer_index for display.
        if(i.nameplate_kw>0 && i.window_kwh!=null && median>0)
          i.peer_index = Math.round((i.window_kwh/i.nameplate_kw)/median*100)/100;
        return;
      }
      const hasHistory = i.nameplate_kw>0 && i.window_kwh!=null && i.window_kwh>0;
      if(!hasHistory){
        // No usable window at all, show neutral, claim nothing.
        i.status = "monitoring";
        i.peer_index = null;
        i.diagnosis = "Gathering data, not enough history yet to compare against its neighbors.";
        return;
      }
      if(!haveCohort){
        // We have THIS unit's history but no peer cohort (lone inverter, or siblings
        // with no history), peer analysis can't run. Instead of leaving it
        // "monitoring" forever (blind to a real sag), judge it against an ABSOLUTE
        // modeled target. Conservative by design: only a clear, large shortfall flags.
        const target = i.nameplate_kw * 24 * WINDOW_DAYS * seasonalCF();  // typical kWh over the window
        i.peer_index = null;   // no peer index, this is a model verdict, not a peer one
        if(target > 0 && i.window_kwh < target * SOLO_TARGET_RATIO){
          const short = Math.round((1 - i.window_kwh/target) * 100);
          i.status = "underperforming";
          i.diagnosis = `Producing ~${short}% below what a ${i.nameplate_kw} kW system typically makes here this month, with no sibling inverter to compare against, this is measured vs a seasonal model. Worth a look: shading, soiling, snow, or a tired string.`;
        } else {
          i.status = "ok";
          i.diagnosis = "Pulling its weight (measured against a seasonal model, no sibling inverter to compare against).";
        }
        return;
      }
      const pi = (i.window_kwh / i.nameplate_kw) / median;
      i.peer_index = Math.round(pi*100)/100;
      i.status = pi >= UNDERPERF_PI ? "ok" : "underperforming";
      i.diagnosis = i.status==="ok"
        ? "Pulling its weight."
        : `Running ~${Math.round((1-pi)*100)}% below its neighbors under the same sky, likely shading, soiling, or a tired string.`;
    });
  }

  function alertFor(a){
    const f = a.inverters;
    const dead = f.some(i => i.status==="dead" || i.status==="fault");
    const under = f.filter(i => i.status==="underperforming").length;
    const quiet = f.some(i => i.status==="comm_gap");
    // "monitoring" is neutral (not enough evidence), it is NOT a flag.
    const flagged = f.filter(i => i.status!=="ok" && i.status!=="monitoring").length;
    if(dead)  return { level:"critical", count:flagged, status:"dead",            headline:"An inverter stopped earning" };
    if(under) return { level:"warn",     count:flagged, status:"underperforming", headline:"A money leak caught early" };
    if(quiet) return { level:"warn",     count:flagged, status:"comm_gap",        headline:"An inverter has gone quiet" };
    return      { level:"ok",       count:0,       status:"ok",             headline:"All clear" };
  }

  /* ===========================================================================
   * LIVE LIVENESS, the SINGLE shared classifier for "is this inverter dark
   * right now?". The fleet tree (sandbox.js), the overview grid, and the command
   * center ALL call this, so the three surfaces can never again disagree about a
   * live anomaly the way they did when each derived health from inv.status alone.
   *
   * This is deliberately SEPARATE from inv.status (the 14-day peer_analysis
   * verdict). status answers "healthy over the window?"; liveVerdict answers
   * "producing this instant, vs its daylight peers?". An inverter that just
   * stalled reads status:"ok" for up to ~2 days, liveVerdict catches it now.
   *   "ok"    producing at a healthy level, OR calmly idle (night / peers idle / <2 lit peers)
   *   "low"   producing but >15% below its live peers' output-per-nameplate, a peer-level gap
   *   "dark"  fresh reading ~0 W while >=2 daylight peers produce, a real anomaly
   *   "stale" NO live reading while peers produce, unknown, not a confirmed fault
   * ==========================================================================*/
  const LIVE_FLOOR_W = 25;   // below this (or 1% of rated) = idle, not "producing"
  const LOW_PEER_GAP = 0.15; // >15% below the peer median pct-of-max = "low" (Ford's threshold)
  const LIVE_MAX_AGE_H = 2;  // a captured power reading older than this is not "now"
  // Mirror backend LIVE_COMPARE_MIN_ELEVATION_DEG: below this, dusk/dawn shading
  // makes peer gaps untrustworthy — never flag live dark/low (Ford 2026-07-21).
  const LIVE_COMPARE_MIN_ELEV = 12;
  // A per-inverter live reading we can TRUST for a dark/low verdict — and trust as
  // peer evidence. Mirrors the backend alert sweep's _has_fresh_real_reading
  // ([[inverter-alerting]] 98941d3): NEVER an estimated site-total split
  // (Fronius/SMA/Chint report ONE site wattage; the backend divides it by energy
  // share — a fabricated per-device number), and freshly captured. A null age means
  // a polled vendor (SolarEdge) whose poll IS the freshness, so null passes on age.
  // This is the gate that was fixed for the emails but never ported to the dashboard,
  // which is why Bruce's cards flipped "lagging"/"dark" every capture.
  function _freshReal(inv){
    if(!inv || inv.power_estimated === true) return false;   // fabricated split, not a device reading
    if(inv.current_power_w == null) return false;            // no reading at all
    return inv.power_age_hours == null || inv.power_age_hours <= LIVE_MAX_AGE_H;
  }
  function _liveFloor(inv){
    return inv.nameplate_kw!=null ? Math.max(LIVE_FLOOR_W, inv.nameplate_kw*1000*0.01) : LIVE_FLOOR_W;
  }
  function isProducing(inv){
    return inv && inv.current_power_w!=null && inv.current_power_w > _liveFloor(inv);
  }
  // Live output as a fraction of nameplate (W ÷ rated W), the peer-comparable
  // "how hard is it working" figure. Null when we can't compute it.
  function _pctOfMax(inv){
    return (inv && inv.nameplate_kw && inv.current_power_w!=null)
      ? inv.current_power_w/(inv.nameplate_kw*1000) : null;
  }
  // peers identity: same array of inverter objects across all callers, so
  // reference equality is the primary test; id is a defensive fallback.
  function _samePeer(a,b){
    return a===b
      || (a.inverter_id!=null && a.inverter_id===b.inverter_id)
      || (a.id!=null && a.id===b.id);
  }
  // A peerless unit has no live control group, so the ONLY conservative live signal
  // we trust is: it reads a fresh ~0 W in daylight while its OWN history proves it's
  // normally a real producer (a healthy daily peak). That's a clear "stopped at
  // noon", not weather (which never zeroes a working array in daylight). We do NOT
  // attempt a solo "low" verdict live, a partly-cloudy dip on one unit with no
  // control group is exactly the false alarm to avoid; the 14-day absolute check in
  // recompute() catches a sustained solo sag instead.
  function _provenProducer(inv){
    const vals = (inv.daily || []).map(d => +d.kwh || 0).filter(v => v > 0);
    if(!vals.length || inv.nameplate_kw == null) return false;
    const peak = Math.max.apply(null, vals);
    // A day that reached even a quarter of a typical full day (nameplate*~4.6 kWh/kW)
    // proves the hardware works, so a current hard zero in daylight is anomalous.
    return peak >= inv.nameplate_kw * 4.6 * 0.25;
  }
  // srcOk (optional, default true): the array's VENDOR FEED is itself fresh. When a
  // caller knows the source is stale/unpolled (source_status), it passes false so a
  // stale reading can never masquerade as a live fault — the honest signal there is
  // "vendor feed is behind", surfaced separately, not "this inverter went dark".
  function liveVerdict(inv, peers, isDaylight, srcOk, solarElev){
    // NO ENERGY REGISTER (backend no_energy_register, e.g. Tannery #7): the unit
    // streams live power but has a dead cumulative-energy register, so it has no
    // gradeable history AND its per-inverter power is a bogus energy-share split
    // (zero energy → zero/low share). Neither basis is trustworthy, so we make NO
    // live verdict on it, a metering defect must never masquerade as a dark/low
    // FAULT. Surfaces render its own honest "no energy data" state instead.
    if(inv && inv.no_energy_register) return "ok";
    if(isDaylight === false) return "ok";          // night: zero is expected (Sleeping)
    // Dusk/dawn shoulder: sun still "up" for Sleeping UI, but too low for peer
    // compare — orientation/shade zeros one unit while neighbors still produce.
    if(solarElev != null && isFinite(+solarElev) && +solarElev < LIVE_COMPARE_MIN_ELEV) return "ok";
    if(srcOk === false) return "ok";               // vendor feed stale → don't trust live readings
    // Peers only count as live evidence when THEIR reading is fresh + real — an
    // estimated site-split can never be fake peer-proof (was Bruce's phantom "dark").
    const litReal = (peers||[]).filter(p => !_samePeer(p, inv) && _freshReal(p) && isProducing(p));
    const siblings = (peers||[]).filter(p => !_samePeer(p, inv));
    // This unit's reading isn't trustworthy (estimated split, stale, or absent):
    // never a live FAULT. If real peers clearly produce while THIS unit has no
    // reading at all, surface the honest info-state "No signal" — not dark/low.
    if(!_freshReal(inv)){
      if(inv && inv.current_power_w == null && litReal.length >= 2) return "stale";
      return "ok";
    }
    if(isProducing(inv)){
      // Producing, but is it keeping pace with its array peers? An inverter running
      // far below its neighbors (Ford: >15% under) is underperforming even if it's on.
      if(litReal.length < 2) return "ok";          // not enough real peer signal to judge live "low"
      const myPct = _pctOfMax(inv);
      if(myPct == null) return "ok";               // no nameplate → can't compare
      const peerPcts = litReal.map(_pctOfMax).filter(v => v != null).sort((a,b) => a-b);
      if(peerPcts.length < 2) return "ok";
      const med = peerPcts[Math.floor(peerPcts.length/2)];   // peer median pct-of-max
      if(med < 0.30) return "ok";                  // cohort not genuinely producing (dawn/dusk) → don't judge
      // Owner-confirmed expected-low (shading): running below its peers is the WHOLE
      // POINT — never a live "low" on it. The backend 14-day re-baseline still catches
      // a drop below its baseline; live "dark" (a fresh 0 W below) still applies since
      // going fully dark isn't expected even for a shaded unit.
      if(inv && inv.expected_low) return "ok";
      if(myPct < med*(1-LOW_PEER_GAP)) return "low";  // >15% below the peer median → underperforming live
      return "ok";
    }
    // Not producing, with a fresh REAL ~0 reading:
    if(litReal.length >= 2) return "dark";         // >=2 real peers produce while I read a fresh 0 = anomaly
    // No real producing peers. A whole multi-inverter cohort reading ~0 is a feed
    // gap (they never all fail at once), NOT N simultaneous dead inverters — this was
    // the "all 20 Primos dark" false alarm. Only a GENUINELY solo array is judged dark.
    if(siblings.length === 0 && _provenProducer(inv)) return "dark";
    return "ok";                                   // otherwise not enough signal to judge
  }
  // True when an inverter that 14-day health calls "ok" is actually a live
  // anomaly RIGHT NOW (dark, or low vs its peers, while peers produce). Cross-surface flag.
  function isLiveAnomaly(inv, peers, isDaylight, srcOk, solarElev){
    return inv.status === "ok" && ["dark","low"].includes(liveVerdict(inv, peers, isDaylight, srcOk, solarElev));
  }

  /* ===========================================================================
   * ARRAY-LEVEL STATUS — the SINGLE canonical rollup that BOTH the overview grid
   * (sandbox.js) and the spreadsheet (vendor-sheet.js) render, so the two views
   * can never again disagree about an array (Ford: "the two should show the same
   * information"). One classifier, one label, one tone. Worst-first tiers:
   *   down    ≥1 confirmed 14-day fault (dead/fault)              cls "bad"
   *   under   ≥1 confirmed 14-day underperformer / gone-quiet     cls "warn"
   *   asleep  night, nothing producing, no flags                  cls "muted"
   *   feed    vendor feed behind (stale source in daylight)       cls "watch"  (soft — data, not fault)
   *   watch   ≥1 LIVE-only dip (dark/low now, 14-day still ok)    cls "watch"  (soft — momentary)
   *   new     brand-new array, hard 0 W, nothing gradeable yet    cls "warn"
   *   ok      everything pulling its weight                       cls "ok"
   * The soft "watch" tone (cyan) is what keeps a passing-cloud dip or a lagging
   * feed from wearing the same alarm colour as a confirmed fault — the exact
   * conflation that made Bruce's cards contradict each other and his own eyes.
   * ==========================================================================*/
  // The monitoring FEED is behind — a DATA problem, not a hardware fault. Kept in
  // sync with vendor-sheet.js's old _vendorIssue so the overview and the spreadsheet
  // agree on "feed behind": (1) source clock stale in daylight, incl. the SolarEdge/
  // Locus ≥6h age belt (their state flag lags), and (2) a whole array dark in daylight
  // while OTHER fleet arrays produce (feed lying/broken, never a green "all clear").
  function _liveCompareOk(col){
    if(!col || col.is_daylight === false) return false;
    if(col.live_compare_ok === false) return false;
    if(col.live_compare_ok === true) return true;
    const elev = col.solar_elevation_deg;
    if(elev != null && isFinite(+elev)) return +elev >= LIVE_COMPARE_MIN_ELEV;
    return true; // unknown elev → leave to other gates
  }
  function _feedBehind(col){
    if(col.is_daylight === false) return false;      // night = asleep, handled separately
    const ss = col.source_status;
    if(ss && ss.state === "stale") return true;
    const v = (col.vendor || "").toLowerCase();
    if((v === "solaredge" || v === "locus") && ss && ss.age_hours != null && ss.age_hours >= 6) return true;
    // Whole-array dark while fleet peers produce: only in solid daytime. At dusk
    // a shaded site going dark while another still produces is not a feed fault.
    const liveDead = col.current_power_w == null || col.current_power_w <= 25;
    const todayDead = col.produced_today_kwh == null || col.produced_today_kwh <= 0.05;
    if(liveDead && todayDead && _liveCompareOk(col)){
      const peers = (state.arrays || []).some(a =>
        a && a.id !== col.array_id && _liveCompareOk(a)
        && a.current_power_w != null && a.current_power_w > 100);
      if(peers) return true;
    }
    return false;
  }
  function arrayStatus(col){
    const invs = col.inverters || [];
    const daylight = col.is_daylight !== false;
    const vendorOut = _feedBehind(col);
    const srcOk = !vendorOut;
    const elev = col.solar_elevation_deg;
    let hard = 0, crit = 0, under = 0, quiet = 0, watch = 0;
    for(const inv of invs){
      const s = inv.status;
      if(s === "ok"){
        const lv = liveVerdict(inv, invs, col.is_daylight, srcOk, elev);
        if(lv === "dark" || lv === "low") watch++;
        continue;
      }
      if(s === "monitoring") continue;               // neutral — never a flag
      hard++;
      if(s === "dead" || s === "fault") crit++;
      else if(s === "underperforming") under++;
      else if(s === "comm_gap") quiet++;
    }
    const total = invs.length;
    const mk = (key, cls, label, count, tip) =>
      ({ key, cls, label, count, tip, hard, crit, under, quiet, watch, vendorOut, total });
    if(crit)   return mk("down",  "bad",  `${crit} down`, crit,
      `${crit} inverter${crit===1?"":"s"} stopped earning — a confirmed fault over the last 14 days.`);
    if(hard)   return mk("under", "warn",
      under ? `${hard} underperforming` : `${hard} gone quiet`, hard,
      `${hard} of ${total} inverter${total===1?"":"s"} flagged over the last 14 days.`);
    // A normal night (nothing producing) is rest, not an issue — checked before feed/watch.
    if(!daylight && !invs.some(isProducing))
      return mk("asleep", "muted", "Asleep", 0, "The sun is down — the array is resting.");
    if(vendorOut) return mk("feed", "watch", "Feed behind", 1,
      "The monitoring vendor has stopped sending fresh data for this site. That's a data-freshness gap, not a hardware fault — live status is paused until the feed catches up.");
    if(watch)  return mk("watch", "watch", `Watching ${watch}`, watch,
      `${watch} inverter${watch===1?"":"s"} dipped below ${watch===1?"its":"their"} neighbors in the latest reading — a momentary live watch, not a confirmed problem. The 14-day health still looks healthy.`);
    // Unverified new zero: a brand-new array reading a hard 0 W in daylight with no
    // gradeable peer yet — "All clear" there would be a false green.
    const anyOk = invs.some(iv => iv.status === "ok");
    const newZero = !anyOk && invs.some(iv =>
      iv.status === "monitoring" && iv.current_power_w === 0 && !iv.no_energy_register);
    if(newZero && daylight)
      return mk("new", "warn", "New, no output yet", 0,
        "Freshly connected and reading 0 W in daylight — not enough history to grade it yet.");
    return mk("ok", "ok", "All clear", 0, "Every inverter is pulling its weight over the last 14 days.");
  }

  /* ===========================================================================
   * SELECTORS, shape the canonical fleet for each consumer
   * ==========================================================================*/

  // sandbox shape: { columns:[…], summary:{…} }. `ids` optional → focus subset.
  function toColumns(ids){
    const list = (ids && ids.length) ? state.arrays.filter(a => ids.includes(a.id)) : state.arrays;
    const columns = list.map(a => ({
      array_id: a.id, array_name: a.name, vendor: a.vendor || null,
      portfolio_name: a.portfolio_name || null,   // Analysis-tab grouping label
      reminder: a.reminder || null,               // Analysis-tab O&M note
      inverter_source: a.vendor || null, inverter_count: a.inverters.length,
      alert: alertFor(a),
      daily: a.daily || [],   // array-level production history (Chint weekETrend backfill etc.)
      is_daylight: a.is_daylight !== false,   // sun-up flag for the card "Sleeping" state
      solar_elevation_deg: a.solar_elevation_deg != null ? +a.solar_elevation_deg : null,
      live_compare_ok: a.live_compare_ok !== false && (a.live_compare_ok === true
        || a.solar_elevation_deg == null
        || +a.solar_elevation_deg >= LIVE_COMPARE_MIN_ELEV),
      source_status: a.source_status || null,  // vendor-side data freshness → outage banner
      sync_status: a.sync_status || null,       // OUR capture recency → "synced Xm ago" column
      // Server-computed array live power + today's kWh (forwarded so the card
      // reads ONE authoritative number and can show "produced today" when live≈0).
      current_power_w: (a.current_power_w != null ? a.current_power_w : null),
      produced_today_kwh: (a.produced_today_kwh != null ? a.produced_today_kwh : null),
      // Provenance for "today" so consumers can mark an estimate (bill_prorate)
      // distinctly from a measured reading (audit-style data honesty).
      produced_today_source: (a.produced_today_source != null ? a.produced_today_source : null),
      produced_today_is_estimated: a.produced_today_is_estimated === true,
      inverters: a.inverters.map(i => ({
        inverter_id: i.id, sn: i.serial, name: i.name, model: i.model, nameplate_kw: i.nameplate_kw,
        peer_index: i.peer_index, status: i.status, diagnosis: i.diagnosis,
        window_kwh: i.window_kwh, produced_today_kwh: i.produced_today_kwh, current_power_w: i.current_power_w,
        daily: i.daily || [], min_kwh: i.min_kwh, peak_kwh: i.peak_kwh,
        // Live-reading provenance — liveVerdict trusts a dark/low ONLY on a fresh,
        // real reading. Without these the overview re-flags estimated splits + stale
        // readings (Bruce's cards that flipped every capture). Carry them through.
        power_estimated: i.power_estimated === true,
        power_age_hours: i.power_age_hours,
        // Owner-confirmed expected-low (shading) — carried so the card shows the calm
        // "expected lower" state and the live overlay never re-flags a shaded unit.
        expected_low: i.expected_low === true,
        expected_low_reason: i.expected_low_reason || null,
        expected_low_baseline: i.expected_low_baseline != null ? i.expected_low_baseline : null,
        expected_low_breach: i.expected_low_breach === true,
        // Dead-energy-register flag (live power, no cumulative energy), MUST ride
        // through or every surface loses the honest "no energy data" state and #7
        // falls back to Error/Offline (the bug). Carried like status/peer_index.
        no_energy_register: !!i.no_energy_register,
        last_mode: i.status==="dead" ? "SHUTDOWN" : i.status==="comm_gap" ? "" : "PRODUCING",
        vendor: a.vendor || null,
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
    // Never blank the tree while arrays exist, if a stale/empty focus filtered
    // everything out, fall back to the default focus so the sandbox always shows
    // something (mirrors the command center, which renders all arrays).
    if(!out.columns.length && state.arrays.length) return toColumns(defaultFocusIds());
    return out;
  }
  function focusIds(){ return state.focus.length ? state.focus.slice() : defaultFocusIds(); }
  // True when the tree is showing a NARROWED subset (owner drilled into one/few
  // arrays from the overview grid) rather than the full default focus, drives the
  // sandbox "Show all arrays" button.
  function focusIsNarrowed(){
    if(!state.focus.length) return false;          // empty focus = default (all/worst-few)
    return state.focus.length < state.arrays.length;
  }
  function clearFocus(){ state.focus = []; notify("focus"); }

  // Default sandbox focus.
  // A REAL signed-in owner ALWAYS sees EVERY array, never a subset. Hiding any of
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
   * MUTATIONS, update in-memory, notify SYNC, persist async when live
   * ==========================================================================*/
  const isLive = () => !!getSession();
  // In-flight write tracking. A background refetch (auto-refresh, tab refocus)
  // or a closely-following drag must NEVER re-ingest the server tree while a
  // mutation (reassign/reorder/create/delete) is still in flight, doing so
  // pulls STALE state and clobbers the optimistic local move, which is exactly
  // the "inverters jump back to the wrong array" glitch. Every write bumps this;
  // refetch() bails (and self-reschedules) while it's > 0.
  let _pendingWrites = 0;
  let _refetchQueued = false;
  function _trackWrite(p){
    _pendingWrites++;
    const done = () => {
      _pendingWrites = Math.max(0, _pendingWrites - 1);
      // If a refetch was suppressed while writes were in flight, run it once the
      // last write settles so we still converge on authoritative server state.
      if(_pendingWrites === 0 && _refetchQueued){
        _refetchQueued = false;
        setTimeout(() => refetch(), 150);
      }
    };
    return p.then(v => { done(); return v; }, e => { done(); throw e; });
  }
  function apiPost(path, body){
    const s = getSession();
    return _trackWrite(fetch(path, { method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+s },
      body: body!=null ? JSON.stringify(body) : "{}" })
      .then(async r => {
        if(!r.ok){
          let detail = "";
          try {
            const j = await r.json();
            detail = (j && (j.detail || j.error || j.message)) || "";
            if(Array.isArray(detail)) detail = detail.map(x => x.msg || x).join("; ");
          } catch(_){ /* ignore */ }
          const err = new Error((detail ? String(detail) : path) + " " + r.status);
          err.status = r.status;
          throw err;
        }
        return r.json().catch(()=>({}));
      }));
  }
  function apiDelete(path){
    const s = getSession();
    return _trackWrite(fetch(path, { method:"DELETE", headers:{ "Authorization":"Bearer "+s } })
      .then(r => { if(!r.ok) throw new Error(path+" "+r.status); return r.json().catch(()=>({})); }));
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

  // Normalize owner-facing names: keep internal spaces (incl. multi-word), trim
  // ends, convert NBSP from paste/contenteditable, drop zero-width junk.
  function _normName(name){
    return String(name == null ? "" : name)
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
      .replace(/[ \t\f\v]+/g, " ")   // collapse runs of horizontal space to one
      .replace(/^\s+|\s+$/g, "");
  }

  // Rename an array (inline edit in EITHER dashboard view). Optimistic local
  // update + notify (so the OTHER view repaints the new name instantly), records
  // an undoable inverse, then persists to the backend; a refetch reconciles to
  // the authoritative name. No-op when empty or unchanged. Mirrors the backend's
  // per-tenant name-uniqueness, a 409 clash reverts via the catch→refetch.
  // Returns a Promise<{ok,name?,error?}> so the spreadsheet UI can toast failures.
  function renameArray(id, name, opts){
    opts = opts || {};
    const a = findArray(id); if(!a) return Promise.resolve({ ok:false, error:"Array not found" });
    const next = _normName(name).slice(0, 200);
    if(!next) return Promise.resolve({ ok:false, error:"Name cannot be empty" });
    if(next === a.name) return Promise.resolve({ ok:true, name: next, unchanged:true });
    const prev = a.name;
    a.name = next;
    notify();
    if(!opts.skipHistory){
      pushHistory({
        redo: () => renameArray(id, next, { skipHistory: true }),
        undo: () => renameArray(id, prev, { skipHistory: true }),
      });
    }
    if(!isLive()) return Promise.resolve({ ok:true, name: next });
    return apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/name", { name: next })
      .then((body) => {
        if(body && body.name) a.name = body.name;
        // Soft reconcile without yanking mid-session — full refetch still queued
        // after writes settle. Prefer returned name.
        return { ok:true, name: a.name };
      })
      .catch((err) => {
        a.name = prev;
        notify();
        const msg = (err && err.message) || "Rename failed";
        // 409 clash → friendlier copy
        const friendly = /409/.test(msg)
          ? "Another array already has that name"
          : (/400/.test(msg) ? "Couldn't save that name" : "Couldn't save that name — check your connection");
        return { ok:false, error: friendly };
      });
  }

  // Rename an inverter (inline edit in EITHER view). Same optimistic-then-persist
  // shape as renameArray. Inverter names may repeat across arrays, so there is no
  // uniqueness check; the backend marks the name owner-set so a telemetry sync
  // never clobbers it.
  function renameInverter(id, name, opts){
    opts = opts || {};
    const hit = findInv(id); if(!hit) return Promise.resolve({ ok:false, error:"Inverter not found" });
    const { i } = hit;
    const next = _normName(name).slice(0, 200);
    if(!next) return Promise.resolve({ ok:false, error:"Name cannot be empty" });
    if(next === i.name) return Promise.resolve({ ok:true, name: next, unchanged:true });
    const prev = i.name;
    i.name = next;
    notify();
    if(!opts.skipHistory){
      pushHistory({
        redo: () => renameInverter(id, next, { skipHistory: true }),
        undo: () => renameInverter(id, prev, { skipHistory: true }),
      });
    }
    if(!isLive()) return Promise.resolve({ ok:true, name: next });
    return apiPost("/v1/array-owners/inverters/" + encodeURIComponent(id) + "/name", { name: next })
      .then((body) => {
        if(body && body.name) i.name = body.name;
        return { ok:true, name: i.name };
      })
      .catch((err) => {
        i.name = prev;
        notify();
        const msg = (err && err.message) || "Rename failed";
        const friendly = /400|409/.test(msg)
          ? "Couldn't save that name"
          : "Couldn't save that name — check your connection";
        return { ok:false, error: friendly };
      });
  }

  // Assign/clear an array's portfolio label (Analysis-tab grouping). Optimistic
  // local update + notify (both views repaint), then persist; a refetch reconciles
  // to the authoritative value. Empty string clears it. Mirrors renameArray's shape
  // but carries no uniqueness constraint (many arrays share one portfolio).
  function setArrayPortfolio(id, name){
    const a = findArray(id); if(!a) return;
    const next = String(name == null ? "" : name).trim().slice(0,80) || null;
    if(next === (a.portfolio_name || null)) return;          // unchanged → no-op
    a.portfolio_name = next;
    notify();
    if(isLive()){
      apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/portfolio",
              { portfolio_name: next })
        .then(() => refetch()).catch(() => refetch());
    }
  }

  // Assign/clear an array's O&M reminder note (Analysis Sites "Reminder" column).
  // Optimistic + persist, mirroring setArrayPortfolio. Empty clears.
  function setArrayReminder(id, note){
    const a = findArray(id); if(!a) return;
    const next = String(note == null ? "" : note).trim().slice(0,2000) || null;
    if(next === (a.reminder || null)) return;                // unchanged → no-op
    a.reminder = next;
    notify();
    if(isLive()){
      apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/reminder",
              { reminder: next })
        .then(() => refetch()).catch(() => refetch());
    }
  }

  function createArray(name){
    const id = "new-" + (_invSeq++);
    state.arrays.push({ id, name, region:"—", host:"", vendor:"", inverters:[] });
    notify();
    clearHistory();   // structural commit, a barrier (drag history doesn't cross it)
    if(isLive()){ apiPost("/v1/array-owners/arrays", { name }).then(()=>refetch()).catch(()=>refetch()); }
    return id;
  }

  // Hide a personal/non-business array from the fleet without soft-deleting it
  // (POST /exclude). Same optimistic remove as deleteArray, but history stays
  // on the server and re-include is available via excluded:false.
  function excludeArray(id){
    const idx = state.arrays.findIndex(a => String(a.id) === String(id));
    if(idx === -1) return;
    const removed = state.arrays[idx];
    const wasFocused = state.focus.some(f => String(f) === String(id));
    state.arrays = state.arrays.filter(a => String(a.id) !== String(id));
    state.focus = state.focus.filter(f => String(f) !== String(id));
    notify();
    if(isLive()){
      apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/exclude",
              { excluded: true })
        .then(()=>refetch()).catch(()=>refetch());
    }
    pushHistory({
      undo: () => {
        if(!state.arrays.some(a => String(a.id) === String(id))){
          const at = Math.min(idx, state.arrays.length);
          state.arrays.splice(at, 0, removed);
          if(wasFocused && !state.focus.some(f => String(f) === String(id))) state.focus.push(id);
        }
        notify();
        if(isLive()){
          apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/exclude",
                  { excluded: false })
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
      redo: () => {
        state.arrays = state.arrays.filter(a => String(a.id) !== String(id));
        state.focus = state.focus.filter(f => String(f) !== String(id));
        notify();
        if(isLive()){
          apiPost("/v1/array-owners/arrays/" + encodeURIComponent(id) + "/exclude",
                  { excluded: true })
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
    });
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

  // Soft-delete ONE inverter (the owner's right-click "Delete inverter"). Mirrors
  // deleteArray: optimistic local removal + backend DELETE, recorded as an UNDOABLE
  // command (undo re-inserts locally at its old spot AND revives it server-side via
  // the restore endpoint; redo re-deletes). Unlike createArray/deleteArray this is
  // NOT a structural barrier, a single-inverter remove inverts exactly by stable
  // id, so it can sit in the same history stack as drag moves.
  function deleteInverter(invId){
    const hit = findInv(invId);
    if(!hit) return;                                       // nothing matched
    const { a: from, i: removed } = hit;
    const fromArrayId = from.id;
    const fromPos = from.inverters.indexOf(removed);       // remember slot for undo
    from.inverters.splice(fromPos, 1);
    recompute(from);
    notify();                                              // optimistic, sync cross-view update
    if(isLive()){
      apiDelete("/v1/array-owners/inverters/" + encodeURIComponent(invId))
        .then(()=>refetch()).catch(()=>refetch());
    }
    pushHistory({
      undo: () => {
        const dest = findArray(fromArrayId);
        if(dest && !dest.inverters.some(x => String(x.id) === String(invId))){
          const at = Math.min(fromPos, dest.inverters.length);
          dest.inverters.splice(at, 0, removed);
          recompute(dest);
        }
        notify();
        if(isLive()){
          apiPost("/v1/array-owners/inverters/" + encodeURIComponent(invId) + "/restore")
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
      redo: () => {
        const dest = findArray(fromArrayId);
        if(dest){
          dest.inverters = dest.inverters.filter(x => String(x.id) !== String(invId));
          recompute(dest);
        }
        notify();
        if(isLive()){
          apiDelete("/v1/array-owners/inverters/" + encodeURIComponent(invId))
            .then(()=>refetch()).catch(()=>refetch());
        }
      },
    });
  }

  function resetLayout(){
    clearHistory();   // server regroups everything, a barrier
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
   * LOAD, one fetch (live) or one simulated fleet (demo), shared by both views
   * ==========================================================================*/
  let _lastUpdate = 0;
  function ingest(arrays, opts){
    state.arrays = arrays;
    state.simulated = !!(opts && opts.simulated);
    state.recovered = (opts && opts.recovered) || 0;
    // liveReady = full live tree has landed at least once this session.
    // refreshingLive = background live pull still in flight (stored painted first).
    if(opts && opts.liveReady){ state.liveReady = true; state.refreshingLive = false; }
    if(opts && opts.fromStored){ state.refreshingLive = !state.liveReady; }
    if(opts && opts.refreshingLive != null) state.refreshingLive = !!opts.refreshingLive;
    state.arrays.forEach(recompute);
    // Reconcile the sandbox focus against the NEW array set. Drop any focused ids
    // that no longer exist (demo→live swap, or arrays the extension added after a
    // prior load), otherwise a stale focus filters every real array out and the
    // fleet tree renders blank while the command center (which reads ALL arrays)
    // shows them. If nothing valid remains, fall back to the default focus.
    const liveIds = new Set(state.arrays.map(a => a.id));
    state.focus = state.focus.filter(id => liveIds.has(id));
    if(!state.focus.length) state.focus = defaultFocusIds();
    state.loaded = true;
    _lastUpdate = Date.now();
    // Snapshot real, signed-in fleet data for an instant paint on the next reload.
    // (Skip the simulated demo and the hydrate path itself, which pass fromCache.)
    // Prefer live snapshots over stored so the next cold load has richer kW/daily.
    if(!state.simulated && !(opts && opts.fromCache) && getSession()){
      if(!(opts && opts.fromStored) || !state.liveReady){
        saveFleetCache(arrays, state.recovered);
      }
    }
    startHeartbeat();
    notify(opts && opts.fromStored ? "stored" : "load");
  }

  /* ---- live heartbeat: keeps the dashboard genuinely live ----
   * Real data → poll the backend every ~45s and re-ingest. Simulated demo →
   * gently evolve the fleet so the KPIs visibly breathe. Either way we stamp
   * _lastUpdate and emit "live" (a lightweight beat the command center repaints
   * in place; the fleet tree ignores it, its own kW ticker handles motion). */
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

  function refetch(opts){
    const s = getSession(); if(!s) return Promise.resolve();
    // Never overwrite local state while a write is in flight, defer until the
    // last one settles (see _trackWrite). This is what stops a background pull
    // from clobbering an optimistic reassign and snapping inverters back.
    if(_pendingWrites > 0){ _refetchQueued = true; return Promise.resolve(); }
    const mode = (opts && opts.mode) || "live";
    const q = mode && mode !== "live" ? ("?mode=" + encodeURIComponent(mode)) : "";
    return fetch("/v1/array-owners/fleet-tree" + q, { headers:{ Authorization:"Bearer "+s } })
      .then(r => {
        if(r.status === 401 || r.status === 403){ const e = new Error("auth"); e.auth = true; throw e; }
        if(!r.ok) throw 0;
        return r.json();
      })
      // A signed-in owner's REAL tree, ingest it even when empty (no columns),
      // so a freshly-added-but-still-empty array is reflected, NOT masked by demo.
      // stored/lite must NEVER clobber a fresher live tree (would blank live kW).
      .then(t => {
        const isStored = (t && t.mode === "stored") || mode === "stored" || mode === "lite";
        if(isStored && state.liveReady) return; // keep authoritative live snapshot
        ingest(adaptTree(t), {
          recovered:(t.summary&&t.summary.recovered_ytd)||0,
          fromStored: !!isStored,
          liveReady: !isStored,
        });
      })
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
  // ── background auto-refresh ────────────────────────────────────────────────
  // Without this, an open sandbox NEVER re-pulls the tree, so a source-outage
  // banner (source_status.state === "stale") would linger forever after the
  // vendor's feed comes back, the data is fresh server-side but the page still
  // shows the old snapshot. A gentle periodic refetch re-ingests the authoritative
  // tree, flipping source_status back to "ok" and clearing the banner on its own.
  // Guards: only when live + tab visible + the user isn't mid-drag / mid-edit
  // (so a refresh-driven re-render never yanks the canvas out from under them).
  const AUTO_REFRESH_MS = 5 * 60 * 1000;   // 5 min, well under the 6h stale window
  let _autoTimer = null;
  function _userBusy(){
    try {
      return !!document.querySelector(
        ".dragging-active, .inv-dragging-active, .sb-editing, [contenteditable='true']:focus"
      );
    } catch(e){ return false; }
  }
  function startAutoRefresh(){
    if(_autoTimer) return;                 // already running
    _autoTimer = setInterval(() => {
      if(!isLive()) return;                // demo/anon: nothing to refresh
      if(document.hidden) return;          // tab backgrounded, skip, refresh on return
      if(_userBusy()) return;              // don't interrupt a drag/edit
      refetch();                           // re-ingest → notify → views re-render
    }, AUTO_REFRESH_MS);
    // Also refresh the moment the tab is brought back to the foreground, so a
    // recovered source clears promptly instead of waiting for the next tick.
    try {
      document.addEventListener("visibilitychange", () => {
        if(!document.hidden && isLive() && !_userBusy()) refetch();
      });
    } catch(e){}
  }
  function load(){
    if(state.loaded || _loading) return;     // single shared bootstrap, both views may call it
    _loading = true;
    if(getSession()){
      fetchEnergyRate();   // pull the owner's real billed $/kWh so loss math is honest
      // INSTANT PAINT: if we have a cached snapshot of this owner's real tree,
      // ingest it immediately so the sandbox renders with zero network wait, then
      // refresh from the backend in the background and re-ingest the authoritative
      // tree when it arrives. No cache (first ever load) → fall through to fetch.
      const cached = readFleetCache();
      if(cached){
        ingest(cached.arrays, { recovered: cached.recovered, fromCache: true, refreshingLive: true });
      }
      // TWO-PHASE LOAD (kills the 60–90s blank "Loading your fleet…" cliff):
      //   1) mode=stored — DB-only structure, provider groups paint in <1s so the
      //      post-onboarding spreadsheet streams in as the fleet is already known.
      //   2) mode=live   — full vendor enrichment in the background; upgrades the
      //      same rows when ready (never blocks first paint).
      const hdrs = { Authorization:"Bearer "+getSession() };
      const pull = (mode) => fetch("/v1/array-owners/fleet-tree" + (mode === "live" ? "" : ("?mode=" + mode)), { headers: hdrs })
        .then(r => {
          if(r.status === 401 || r.status === 403){ const e = new Error("auth"); e.auth = true; throw e; }
          if(!r.ok) throw 0;
          return r.json();
        });
      // Phase 1: stored skeleton (always attempt; even with cache this re-syncs structure)
      pull("stored")
        .then(t => {
          // Don't regress a liveReady snapshot with a thinner stored one mid-session
          // (e.g. heartbeat race). First paint + onboarding growth still apply.
          if(state.liveReady) return;
          ingest(adaptTree(t), {
            recovered:(t.summary&&t.summary.recovered_ytd)||0,
            fromStored: true,
            refreshingLive: true,
          });
        })
        .catch((err) => {
          if(err && err.auth){ onAuthExpired(); return; }
          // stored failed: keep cache if any; live phase may still save us
        });
      // Phase 2: live enrichment
      pull("live")
        .then(t => {
          // Signed in → always show the owner's REAL tree, even if it's empty.
          // Empty means "you haven't connected/added anything yet" (honest empty
          // state), NEVER the fake 100-array demo, that's only for anon visitors.
          ingest(adaptTree(t), {
            recovered:(t.summary&&t.summary.recovered_ytd)||0,
            liveReady: true,
          });
          startAutoRefresh();   // keep the open tree fresh (clears recovered-source banners)
        })
        .catch((err) => {
          if(err && err.auth){ onAuthExpired(); return; }
          // Transient (network/5xx) for a signed-in owner: keep the cached/stored
          // tree if we painted one; otherwise show an honest empty tree (never a fake fleet).
          state.refreshingLive = false;
          notify("load");
          if(!state.loaded){
            if(!cached) ingest([], {});
          }
        })
        .finally(() => { _loading = false; });
    } else {
      // Anonymous visitor (marketing/preview), the simulated fleet tells the story.
      // Big-operator demo: ~20 sites / 200 inverters; recovered_ytd is a
      // narrative KPI for the command-center hero (not a real ledger figure).
      ingest(simulateFleet(), { simulated:true, recovered:248600, liveReady:true });
      _loading = false;
    }
  }

  // adapt the live fleet-tree (sandbox columns) → canonical arrays
  function adaptTree(t){
    return (t.columns||[]).map(c => ({
      id: c.array_id, name: c.array_name, region:"—", host: c.client_name||"",
      // Honest unknown, never a guessed vendor: a freshly-connected array with
      // no inverters polled yet (fleet-tree derives `vendor` from the inverter
      // rows) reports null here, defaulting that to "solaredge" mislabeled
      // every non-SolarEdge connection's portal link ("Open in SolarEdge ↗")
      // until its first poll populated real inverters. Found 2026-07-08 while
      // verifying the Fronius account-connect flow live.
      vendor: c.vendor || null,
      // Operator-assigned portfolio/group label (Analysis-tab fleet hierarchy);
      // null until grouped. Carried through so both the canonical array and
      // toColumns expose it without a second fetch.
      portfolio_name: c.portfolio_name || null,
      reminder: c.reminder || null,   // Analysis Sites O&M "Reminder" note
      // Array-level production history (backend DailyGeneration), used by the
      // array graph when inverters carry site-level history but no per-inverter
      // series (e.g. Chint weekETrend backfill).
      daily: c.daily || [],
      // Server-computed sun-up flag (real solar elevation), gates the card's
      // calm "Sleeping" night state on (night AND zero output), never zero alone.
      is_daylight: c.is_daylight !== false,
      // Degrees above horizon + solid-day gate for live peer-compare (dusk shoulder).
      solar_elevation_deg: c.solar_elevation_deg != null ? +c.solar_elevation_deg : null,
      live_compare_ok: c.live_compare_ok !== false,
      // Source-data freshness {state:ok|stale|none,last_report,age_hours}. Carried
      // through so the card can flag a VENDOR-side reporting outage (not ours).
      source_status: c.source_status || null,
      // OUR capture recency {synced_at, age_min}, advances every successful capture
      // (incl. overnight) so the freshness column shows "synced Xm" distinct from the
      // vendor source age. Forwarded from the backend; FleetStore must carry it through
      // or vendor-sheet falls back to source age and never shows "synced".
      sync_status: c.sync_status || null,
      // Server-computed ARRAY live power (W, sum of live inverters; null = no live
      // feed) + today's generated kWh from daily history. The card uses the latter
      // to show "produced today" instead of "not producing" when live≈0 (a flaky
      // instantaneous feed must not make a healthy array read IDLE).
      current_power_w: (c.current_power_w != null ? c.current_power_w : null),
      produced_today_kwh: (c.produced_today_kwh != null ? c.produced_today_kwh : null),
      // Provenance for produced_today_kwh so the dashboard + spreadsheet can be
      // honest about whether today's kWh is MEASURED (vendor/csv/gmp/live) or an
      // ESTIMATE smeared from a utility bill (bill_prorate). Backend sends both;
      // we forward them. Absent → treated as unknown, never asserted as measured.
      produced_today_source: (c.produced_today_source != null ? c.produced_today_source : null),
      produced_today_is_estimated: c.produced_today_is_estimated === true,
      inverters: (c.inverters||[]).map(inv => ({
        id: inv.inverter_id!=null ? inv.inverter_id : ("inv-"+(_invSeq++)),
        name: inv.name, model: inv.model, nameplate_kw: inv.nameplate_kw,
        peer_index: inv.peer_index, status: inv.status, window_kwh: inv.window_kwh,
        current_power_w: inv.current_power_w, stale_hours: inv.stale_hours,
        // Live-reading provenance (backend inverter_fleet build): power_estimated =
        // this per-device wattage is a site-total split, not a real reading;
        // power_age_hours = how long ago we captured it. liveVerdict needs both to
        // avoid flagging fabricated/stale readings — carry them through.
        power_estimated: inv.power_estimated === true,
        power_age_hours: inv.power_age_hours,
        // Owner-confirmed expected-low (shading), from the backend verdict.
        expected_low: inv.expected_low === true,
        expected_low_reason: inv.expected_low_reason || null,
        expected_low_baseline: inv.expected_low_baseline != null ? inv.expected_low_baseline : null,
        expected_low_breach: inv.expected_low_breach === true,
        daily: inv.daily || [], min_kwh: inv.min_kwh, peak_kwh: inv.peak_kwh,
        // Dead-energy-register flag from the backend (live power but no cumulative
        // energy), carry it through so the card/spreadsheet/command-center all
        // render the honest "no energy data" state instead of Error/Offline.
        no_energy_register: !!inv.no_energy_register,
        diagnosis: inv.diagnosis || "",
      })),
    }));
  }

  /* ---- deterministic 20-array / ~200-inverter demo fleet (marketing preview) ----
     Sized to match AO_DEMO (demo-data.js): a real-feeling NE community-solar book,
     multi-vendor, mostly healthy with a few live issues so the fleet feels alive. */
  function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
  const DEMO_SITES = [
    { name:"Londonderry",           region:"Southern VT",      host:"Northeast Community Solar", vendor:"solaredge", inv:12, np:8.25 },
    { name:"Starlake",              region:"Central VT",       host:"Northeast Community Solar", vendor:"solaredge", inv:12, np:7.5 },
    { name:"Timberworks",           region:"Northern VT",      host:"Northeast Community Solar", vendor:"fronius",   inv:10, np:6.2 },
    { name:"Waterford",             region:"Northeast Kingdom", host:"Northeast Community Solar", vendor:"solaredge", inv:8,  np:6.0 },
    { name:"Tannery Brook",         region:"Central VT",       host:"Northeast Community Solar", vendor:"sma",       inv:10, np:5.5 },
    { name:"Chester Commons",       region:"Southern VT",      host:"Northeast Community Solar", vendor:"solaredge", inv:8,  np:5.0 },
    { name:"Cover Catamount",       region:"Southern VT",      host:"Northeast Community Solar", vendor:"solaredge", inv:8,  np:5.3 },
    { name:"West Glover Ridge",     region:"Northeast Kingdom", host:"Northeast Community Solar", vendor:"chint",     inv:8,  np:6.25 },
    { name:"Danville Big Buck",     region:"Northeast Kingdom", host:"Northeast Community Solar", vendor:"fronius",   inv:14, np:7.1 },
    { name:"Norwich Union Village", region:"Upper Valley",     host:"Northeast Community Solar", vendor:"solaredge", inv:10, np:5.6 },
    { name:"Hardwick Field",        region:"Northeast Kingdom", host:"Northeast Community Solar", vendor:"locus",     inv:8,  np:4.75 },
    { name:"Craftsbury Common",     region:"Northeast Kingdom", host:"Northeast Community Solar", vendor:"fronius",   inv:8,  np:4.7 },
    { name:"Mad River School",      region:"Mad River Valley", host:"Northeast Community Solar", vendor:"sma",       inv:8,  np:4.4 },
    { name:"Waitsfield Flats",      region:"Mad River Valley", host:"Northeast Community Solar", vendor:"solaredge", inv:10, np:4.2 },
    { name:"Enosburg Dairy",        region:"Northwest VT",     host:"Northeast Community Solar", vendor:"chint",     inv:10, np:6.0 },
    { name:"Swanton Yard",          region:"Northwest VT",     host:"Northeast Community Solar", vendor:"sma",       inv:8,  np:6.5 },
    { name:"Lebanon Crossing",      region:"NH Upper Valley",  host:"Northeast Community Solar", vendor:"solaredge", inv:12, np:5.8 },
    { name:"Hanover Meadows",       region:"NH Upper Valley",  host:"Northeast Community Solar", vendor:"fronius",   inv:10, np:5.5 },
    { name:"Brunswick Landing",     region:"Coastal ME",       host:"Northeast Community Solar", vendor:"alsoenergy",inv:12, np:6.7 },
    { name:"Augusta Commons",       region:"Central ME",       host:"Northeast Community Solar", vendor:"chint",     inv:12, np:5.4 },
  ];
  function simulateFleet(){
    const rng = mulberry32(0xC0FFEE42);
    const modelFor = (vendor, np) => { const r = Math.round(np); return ({
      solaredge:`SE${np}K`, fronius:`Symo ${r}.0-3-M`, sma:`STP ${r}.0-3AV-40`,
      chint:`CPS SCA${r}KTL-DO`, locus:`LGate ${r}`, alsoenergy:`AE ${r}kW`,
    }[vendor] || `SE${np}K`); };
    const arrays = [];
    // One deliberate "story" site with a live issue so Analysis isn't all green
    const storyIdx = 7; // West Glover, underperforming Chint site
    DEMO_SITES.forEach((site, n) => {
      const invCount = site.inv;
      const vendor = site.vendor;
      const inverters = [];
      for(let j=0;j<invCount;j++){
        const r = rng(); let status="ok";
        // Mostly healthy fleet (cool big-account vibe); a few live issues
        if(n===storyIdx && j===0) status="underperforming";
        else if(n===storyIdx && j===1) status="comm_gap";
        else if(r<0.012) status="underperforming";
        else if(r<0.018) status="comm_gap";
        else if(r<0.022) status="fault";
        // nameplate per inverter, site total ~ site.np * invCount
        const np = site.np;
        const fair = np * 4.6 * WINDOW_DAYS;
        let pi=1+(rng()-0.5)*0.05, win=fair*pi, power=np*1000*(0.55+rng()*0.28);
        if(status==="underperforming"){ pi=0.58+rng()*0.22; win=fair*pi; power=np*1000*(0.28+rng()*0.18); }
        else if(status==="comm_gap"){ pi=null; win=fair*(0.65+rng()*0.25); power=null; }
        else if(status==="fault"){ pi=0.2+rng()*0.15; win=fair*pi; power=np*1000*0.1; }
        const fairDay = np * 4.6;
        const daily = [];
        for(let day=0; day<WINDOW_DAYS; day++){
          let kwh;
          if(status==="comm_gap") kwh = day < WINDOW_DAYS-2 ? fairDay*(0.82+rng()*0.28) : 0;
          else if(status==="underperforming") kwh = fairDay*(0.48+rng()*0.22);
          else if(status==="fault") kwh = fairDay*(0.12+rng()*0.18);
          else kwh = fairDay*(0.82+rng()*0.32);
          daily.push({ date:`d-${WINDOW_DAYS-day}`, kwh: Math.round(kwh*10)/10 });
        }
        const kwhVals = daily.map(d=>d.kwh);
        inverters.push({
          id: _invSeq++, name:`Inverter ${j+1}`, model:modelFor(vendor, np), nameplate_kw:np, vendor,
          peer_index:pi, status, window_kwh:Math.round(win*10)/10,
          current_power_w: power==null?null:Math.round(power),
          daily, min_kwh: Math.round(Math.min(...kwhVals)*10)/10, peak_kwh: Math.round(Math.max(...kwhVals)*10)/10,
          stale_hours: status==="comm_gap" ? Math.round(8+rng()*40) : null,
          diagnosis: status==="underperforming" ? "Pulling below peer cohort, check DC string / soiling." : "",
        });
      }
      arrays.push({
        id: n+1, name: site.name, region: site.region, host: site.host, vendor,
        portfolio_name: site.region,
        inverters,
      });
    });
    return arrays;
  }

  // ---- public API ----
  return {
    subscribe, load, refetch, startAutoRefresh,
    snapshot, toColumns, focusColumns, focusIds, setFocus, defaultFocusIds,
    focusIsNarrowed, clearFocus,
    reassignInverter, reorderInverters, createArray, deleteArray, excludeArray, deleteInverter, resetLayout,
    renameArray, renameInverter, setArrayPortfolio, setArrayReminder,
    findArray, findInv,
    setTriage, setTriageBatch, triageState, isLive,
    liveVerdict, isProducing, isLiveAnomaly,   // shared live-liveness classifier (all 3 surfaces)
    arrayStatus,   // shared array-level rollup — overview grid + spreadsheet render THIS one
    undo, redo, canUndo, canRedo, clearHistory,
    isLoaded: () => state.loaded,
    isSimulated: () => !!state.simulated,
    isRefreshingLive: () => !!state.refreshingLive && !state.liveReady,
    isLiveReady: () => !!state.liveReady,
    lastUpdate: () => _lastUpdate,
    energyRate,             // effective $/kWh for loss/value math (real billed rate when signed in, else fallback)
    REC_PER_MWH: 38,        // $/MWh REC value, shared so consumers don't drift
    WINDOW_DAYS,
  };
})();
