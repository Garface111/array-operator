/* ============================================================================
 * Array Operator — Layout view (layout-view.js)
 *
 * The SECOND sub-view of the Arrays tab, alongside the default inverter comb
 * (sandbox.js). Where the comb shows the Tenant → Array → Inverter SCHEMA, the
 * Layout tab is a free-form SPATIAL map: one draggable node per array, dropped
 * wherever the owner wants so the canvas mirrors the real physical site —
 * SolarEdge + Fronius + SMA inverters in one vendor-agnostic map, color-coded by
 * live production/status. Think SolarEdge "site layout", but per-INVERTER (we
 * have no per-panel data) and across every vendor at once.
 *
 * Data comes from the SAME source the comb reads — window.FleetStore (read-only
 * here). Node POSITIONS are a new, purely-client concern: persisted in
 * localStorage (ao_layout_positions_v1) behind loadPositions()/savePositions(),
 * mirroring how sandbox.js saves column order and renames. No backend table —
 * if a layout endpoint lands later it can replace that one small pair.
 *
 * Public API (window.LayoutView): mount(), render(), isActive().
 * ==========================================================================*/
window.LayoutView = (function(){
  "use strict";

  const VIEW_KEY = "ao_sb_view_v1";              // "inverters" | "layout" — remembered across reloads
  const POS_KEY  = "ao_layout_positions_v1";     // { [arrayId]: {x,y} } in canvas pixels

  // Brand labels for the vendor chip — same set sandbox.js / fleet-store.js use.
  const BRAND = { solaredge:"SolarEdge", locus:"Locus", alsoenergy:"AlsoEnergy", fronius:"Fronius", sma:"SMA", chint:"Chint" };
  // status → swatch class / owner-framed label (kept in step with sandbox.js).
  const STATUS_CLASS = { ok:"ok", underperforming:"warn", comm_gap:"warn", dead:"bad", fault:"bad" };
  const STATUS_LABEL = {
    ok:"Pulling its weight", underperforming:"Below its neighbors",
    comm_gap:"Gone quiet", dead:"Not coming home", fault:"Fault"
  };

  // node + grid geometry (px). NODE_W/H drive both the auto-grid and drag clamps.
  const NODE_W = 196, NODE_H = 104, GAP = 18, PAD = 18;

  let _mounted = false;
  let _dragging = false;        // suppress structural re-renders while a node is being dragged
  let _openArrayId = null;      // array whose detail panel is open (null = none)

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

  function activeView(){
    try { return localStorage.getItem(VIEW_KEY) === "layout" ? "layout" : "inverters"; }
    catch(e){ return "inverters"; }
  }
  function isActive(){ return activeView() === "layout"; }

  /* ---- position persistence (swap this one pair for a backend later) ---- */
  function loadPositions(){
    try { const v = JSON.parse(localStorage.getItem(POS_KEY)); return (v && typeof v === "object") ? v : {}; }
    catch(e){ return {}; }
  }
  function savePositions(p){ try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch(e){} }

  /* ---- derived node facts ---- */
  // Health color: any dead/fault → red, any underperforming/comm_gap → amber, else green.
  function healthClass(arr){
    const st = (arr.inverters || []).map(i => i.status);
    if(st.some(s => s === "dead" || s === "fault")) return "bad";
    if(st.some(s => s === "underperforming" || s === "comm_gap")) return "warn";
    return "ok";
  }
  // Sum of live current_power_w (W) → kW. Non-reporting inverters count as 0.
  function liveKW(arr){
    let w = 0;
    (arr.inverters || []).forEach(i => { if(i.current_power_w != null) w += i.current_power_w; });
    return w / 1000;
  }
  function vendorChip(arr){
    const v = arr.vendor;
    if(v && BRAND[v]) return `<span class="sb-brand ${esc(v)}">${esc(BRAND[v])}</span>`;
    return `<span class="sb-brand mixed">unlinked</span>`;
  }

  /* ---- DOM hosts ---- */
  function host(){ return document.getElementById("sbLayout"); }
  function canvasEl(){ const h = host(); return h ? h.querySelector(".lay-canvas") : null; }

  // Columns that fit across the current canvas width (≥1).
  function gridCols(){
    const c = canvasEl();
    const w = (c && c.clientWidth) ? c.clientWidth : 900;
    return Math.max(1, Math.floor((w - PAD) / (NODE_W + GAP)));
  }
  function gridXY(slot){
    const cols = gridCols();
    const row = Math.floor(slot / cols), col = slot % cols;
    return { x: PAD + col * (NODE_W + GAP), y: PAD + row * (NODE_H + GAP) };
  }

  // Resolve a {arrayId: {x,y}} map for the current fleet: keep saved positions,
  // auto-place any array without one on a tidy grid APPENDED after the saved set
  // (so a newly-added array slots in without overlapping). Auto positions are
  // persisted so they stay put across reloads until the owner drags or resets.
  function resolvePositions(arrays){
    const pos = loadPositions();
    let slot = Object.keys(pos).length;     // append new arrays after what's already placed
    let added = false;
    arrays.forEach(a => {
      const id = String(a.id);
      if(!pos[id] || typeof pos[id].x !== "number" || typeof pos[id].y !== "number"){
        pos[id] = gridXY(slot++);
        added = true;
      }
    });
    if(added) savePositions(pos);
    return pos;
  }

  /* ---- build one node ---- */
  function nodeHTML(arr){
    const cls = healthClass(arr);
    const n = (arr.inverters || []).length;
    const kw = liveKW(arr).toFixed(1);
    return `
      <div class="lay-node ${cls}" data-array-id="${esc(arr.id)}" tabindex="0" role="button"
           title="${esc(arr.name)} — click for detail, drag to move">
        <div class="lay-node-top">
          <span class="sw ${cls}"></span>
          <div class="lay-node-name">${esc(arr.name)}</div>
        </div>
        <div class="lay-node-meta">${vendorChip(arr)}<span class="lay-node-count">${n} inverter${n===1?"":"s"}</span></div>
        <div class="lay-node-kw"><span class="sb-live-dot"></span><b class="lay-kw-val">${kw}</b> kW now</div>
      </div>`;
  }

  /* ---- full render: rebuild the canvas + all nodes from the store ---- */
  function render(){
    const h = host();
    if(!h || !window.FleetStore) return;
    if(!FleetStore.isLoaded()){
      h.innerHTML = `<div class="sb-empty">Loading your fleet tree…</div>`;
      FleetStore.load();
      return;   // the store subscription re-renders once loaded
    }
    const arrays = (FleetStore.snapshot().arrays || []);

    if(!arrays.length){
      h.innerHTML =
        `<div class="lay-toolbar">
           <button class="sb-resetbtn" id="layReset" type="button" title="Clear saved positions and re-grid">Reset positions</button>
         </div>
         <div class="sb-empty">No arrays connected yet — add one from the Inverters tab and it appears here.</div>`;
      wireToolbar();
      return;
    }

    const nodes = arrays.map(nodeHTML).join("");
    h.innerHTML =
      `<div class="lay-toolbar">
         <span class="lay-hint">Drag each array into place — it mirrors your real site. Positions save automatically.</span>
         <span class="sb-spacerflex"></span>
         <div class="sb-legend">
           <span><i class="sw ok"></i>healthy</span>
           <span><i class="sw warn"></i>watch</span>
           <span><i class="sw bad"></i>critical</span>
         </div>
         <button class="sb-resetbtn" id="layReset" type="button" title="Clear saved positions and re-grid">Reset positions</button>
       </div>
       <div class="lay-viewport"><div class="lay-canvas">${nodes}</div></div>`;

    placeNodes(arrays);
    wireToolbar();
    wireNodes();
    if(_openArrayId != null) syncDetail();   // re-bind an open panel after a rebuild
  }

  // Apply resolved positions to the absolute nodes and size the canvas to hold them.
  function placeNodes(arrays){
    const c = canvasEl();
    if(!c) return;
    const pos = resolvePositions(arrays);
    let maxBottom = 0;
    c.querySelectorAll(".lay-node").forEach(node => {
      const p = pos[node.dataset.arrayId];
      if(!p) return;
      node.style.left = p.x + "px";
      node.style.top  = p.y + "px";
      maxBottom = Math.max(maxBottom, p.y + NODE_H);
    });
    // grow the canvas so every node (and a little breathing room) is reachable
    c.style.height = Math.max(maxBottom + PAD + 40, c.parentElement.clientHeight) + "px";
  }

  /* ---- live sync: refresh colors + kW + open panel WITHOUT moving nodes ---- */
  function sync(){
    const c = canvasEl();
    if(!c || !window.FleetStore || !FleetStore.isLoaded()) return;
    const byId = {};
    (FleetStore.snapshot().arrays || []).forEach(a => byId[String(a.id)] = a);
    let structural = false;
    c.querySelectorAll(".lay-node").forEach(node => {
      const a = byId[node.dataset.arrayId];
      if(!a){ structural = true; return; }       // array vanished → needs a rebuild
      const cls = healthClass(a);
      node.classList.remove("ok","warn","bad");
      node.classList.add(cls);
      const sw = node.querySelector(".sw");
      if(sw){ sw.className = "sw " + cls; }
      const kw = node.querySelector(".lay-kw-val");
      if(kw) kw.textContent = liveKW(a).toFixed(1);
    });
    // a brand-new array (more in the store than on the canvas) also needs a rebuild
    if(structural || Object.keys(byId).length !== c.querySelectorAll(".lay-node").length){
      if(!_dragging) render();
      return;
    }
    if(_openArrayId != null) syncDetail();
  }

  /* ---- pointer drag: free 2D move, click-vs-drag by movement threshold ---- */
  function wireNodes(){
    const c = canvasEl();
    if(!c) return;
    c.querySelectorAll(".lay-node").forEach(node => {
      node.addEventListener("pointerdown", e => onPointerDown(e, node));
      node.addEventListener("keydown", e => {
        if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openDetail(node.dataset.arrayId); }
      });
    });
  }

  function onPointerDown(e, node){
    if(e.button != null && e.button !== 0) return;       // primary button only
    const c = canvasEl();
    if(!c) return;
    const startX = e.clientX, startY = e.clientY;
    const origLeft = parseFloat(node.style.left) || 0;
    const origTop  = parseFloat(node.style.top)  || 0;
    let moved = false;
    try { node.setPointerCapture(e.pointerId); } catch(_){}
    node.classList.add("dragging");
    _dragging = true;

    const onMove = ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if(!moved && Math.hypot(dx, dy) < 5) return;       // below threshold → still a click
      moved = true;
      const maxX = Math.max(0, c.clientWidth  - node.offsetWidth);
      const maxY = Math.max(0, c.clientHeight - node.offsetHeight);
      node.style.left = Math.max(0, Math.min(origLeft + dx, maxX)) + "px";
      node.style.top  = Math.max(0, Math.min(origTop  + dy, maxY)) + "px";
    };
    const onUp = () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
      node.classList.remove("dragging");
      _dragging = false;
      try { node.releasePointerCapture(e.pointerId); } catch(_){}
      if(moved){
        const pos = loadPositions();
        pos[node.dataset.arrayId] = { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0 };
        savePositions(pos);
      } else {
        openDetail(node.dataset.arrayId);                // a real click → detail
      }
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
  }

  /* ---- inline array detail panel (pinned bottom-right of the canvas) ---- */
  function openDetail(arrayId){
    _openArrayId = String(arrayId);
    const h = host();
    if(h) h.querySelectorAll(".lay-node.sel").forEach(n => n.classList.remove("sel"));
    const node = h && h.querySelector(`.lay-node[data-array-id="${cssEsc(_openArrayId)}"]`);
    if(node) node.classList.add("sel");
    syncDetail();
  }
  // minimal attribute-selector escaping for ids (digits/letters/dashes in practice)
  function cssEsc(s){ return String(s).replace(/["\\]/g, "\\$&"); }

  function detailHost(){
    const h = host();
    if(!h) return null;
    let d = h.querySelector(".lay-detail");
    if(!d){
      d = document.createElement("div");
      d.className = "lay-detail";
      d.setAttribute("aria-live", "polite");
      h.appendChild(d);
    }
    return d;
  }

  // Rebuild the open panel from the live store (called on open + every sync).
  function syncDetail(){
    if(_openArrayId == null) return;
    const arr = window.FleetStore && FleetStore.isLoaded()
      ? (FleetStore.snapshot().arrays || []).find(a => String(a.id) === _openArrayId) : null;
    const d = detailHost();
    if(!d) return;
    if(!arr){ closeDetail(); return; }                  // array gone → drop the panel
    const cls = healthClass(arr);
    const rows = (arr.inverters || []).map(inv => {
      const sc = STATUS_CLASS[inv.status] || "ok";
      const kw = inv.current_power_w != null ? (inv.current_power_w/1000).toFixed(1) + " kW" : "—";
      return `<div class="lay-d-row">
          <span class="sw ${sc}"></span>
          <span class="lay-d-mid">
            <span class="lay-d-name">${esc(inv.name)}</span>
            <span class="lay-d-stat ${sc}">${esc(STATUS_LABEL[inv.status] || inv.status || "")}</span>
          </span>
          <span class="lay-d-kw">${esc(kw)}</span>
        </div>`;
    }).join("") || `<div class="lay-d-empty">Empty array — no inverters yet.</div>`;
    d.innerHTML =
      `<button class="lay-d-x" type="button" title="Close" aria-label="Close detail">×</button>
       <div class="lay-d-head"><span class="sw ${cls}"></span><b>${esc(arr.name)}</b></div>
       <div class="lay-d-sub">${vendorChip(arr)}<span>${liveKW(arr).toFixed(1)} kW now · ${(arr.inverters||[]).length} inverter${(arr.inverters||[]).length===1?"":"s"}</span></div>
       <div class="lay-d-rows">${rows}</div>`;
    d.querySelector(".lay-d-x").onclick = closeDetail;
  }
  function closeDetail(){
    _openArrayId = null;
    const h = host();
    if(!h) return;
    const d = h.querySelector(".lay-detail");
    if(d) d.remove();
    h.querySelectorAll(".lay-node.sel").forEach(n => n.classList.remove("sel"));
  }

  /* ---- toolbar ---- */
  function wireToolbar(){
    const h = host();
    const reset = h && h.querySelector("#layReset");
    if(reset) reset.onclick = () => {
      try { localStorage.removeItem(POS_KEY); } catch(e){}
      closeDetail();
      render();        // re-grid from scratch
    };
  }

  /* ---- tab switching (Inverters ⇄ Layout) ---- */
  function setView(view){
    const sandbox = document.getElementById("sandbox");
    const layout  = host();
    const tabInv  = document.getElementById("sbTabInverters");
    const tabLay  = document.getElementById("sbTabLayout");
    const layoutOn = view === "layout";
    try { localStorage.setItem(VIEW_KEY, layoutOn ? "layout" : "inverters"); } catch(e){}
    if(sandbox) sandbox.hidden = layoutOn;
    if(layout)  layout.hidden  = !layoutOn;
    if(tabInv){ tabInv.classList.toggle("active", !layoutOn); tabInv.setAttribute("aria-selected", String(!layoutOn)); }
    if(tabLay){ tabLay.classList.toggle("active",  layoutOn); tabLay.setAttribute("aria-selected", String(layoutOn)); }
    if(layoutOn) render();
  }

  function mount(){
    if(_mounted) return;
    const tabInv = document.getElementById("sbTabInverters");
    const tabLay = document.getElementById("sbTabLayout");
    if(!tabInv || !tabLay || !host()) return;     // shell not present yet
    _mounted = true;
    tabInv.addEventListener("click", () => setView("inverters"));
    tabLay.addEventListener("click", () => setView("layout"));

    // keep the layout map live + structurally fresh off the shared store
    if(window.FleetStore){
      FleetStore.subscribe((s, kind) => {
        if(kind === "triage" || kind === "focus") return;   // not spatial concerns
        if(!isActive()) return;                              // hidden → nothing to paint
        if(kind === "live") sync(); else render();           // live = in-place; load/fleet = rebuild
      });
    }
    // restore the remembered view (default: inverters)
    setView(activeView());
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  return { mount, render, isActive };
})();
