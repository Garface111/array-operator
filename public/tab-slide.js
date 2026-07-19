/* Tab pager — horizontal slide between top-tab content panels (Ford 2026-07-16).
 *
 * applyView() in sandbox.js calls window.__aoTabSlide(fromPanel, toPanel, dir)
 * instead of instantly toggling `.active` when the top content panel changes.
 * dir = +1 → moving to a tab further RIGHT (outgoing slides left, incoming enters
 * from the right); dir = -1 → the reverse.
 *
 * SAFETY: navigation must never break. Every path here is wrapped so that, no
 * matter what, the function ends with `to` active and `from` inactive. A kill
 * switch (localStorage ao_tabslide='0' or ?tabslide=0) forces instant switching.
 */
(function(){
  "use strict";

  /* Every top-level panel that participates in the pager. A panel missing from
     this list is NOT moved into the stage, so __aoTabSlide's parent check bails
     to instant() and that tab silently loses its animation.
     panelMarketplace was missing from the Marketplace launch until 2026-07-19:
     sandbox.js's direction map (_ord) got the new tab, this list did not, so
     every hop into or out of Marketplace snapped instead of sliding. If you add
     a top tab, add it BOTH places — the check below shouts if you forget. */
  var STAGE_IDS = [
    "panelDashboard","panelAccount","panelSovereign",
    "panelAnalysis","panelTrends","panelResources","panelReports",
    "panelMarketplace","panelOps"
  ];
  var DUR_MS = 500;
  var stage = null, sliding = false, activeCleanup = null;

  function disabled(){
    try{
      if(localStorage.getItem("ao_tabslide") === "0") return true;
      if(location.search.indexOf("tabslide=0") >= 0) return true;
    }catch(e){}
    // Desktop only — mobile keeps its existing instant switching + bottom nav.
    return (window.innerWidth || 0) < 961;
  }
  function reduced(){
    try{ return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){ return false; }
  }

  /* Move the panels into a no-padding stage once. Lazy + idempotent, so there is
     no dependency on script load order relative to sandbox.js. */
  function ensureStage(){
    try{
      if(stage && stage.isConnected) return stage;
      var panels = STAGE_IDS.map(function(id){ return document.getElementById(id); }).filter(Boolean);
      if(!panels.length) return null;
      // Already staged? (e.g. re-entry)
      if(panels[0].parentNode && panels[0].parentNode.classList &&
         panels[0].parentNode.classList.contains("panel-stage")){
        stage = panels[0].parentNode; return stage;
      }
      var s = document.createElement("div");
      s.className = "panel-stage";
      panels[0].parentNode.insertBefore(s, panels[0]);
      panels.forEach(function(p){ s.appendChild(p); });
      stage = s;
      warnUnstaged();
      return s;
    }catch(e){ return null; }
  }

  /* Drift alarm. The pager degrades SILENTLY: an unstaged panel just snaps, and
     nobody notices for weeks (Marketplace shipped 2026-07-19 with no slide and
     was only caught by eye). If a top-level panel exists in the DOM but is not
     in STAGE_IDS, say so out loud instead of quietly dropping its animation. */
  function warnUnstaged(){
    try{
      var missing = [];
      var els = document.querySelectorAll('[id^="panel"]');
      for(var i=0;i<els.length;i++){
        var id = els[i].id;
        // Only top-level tab panels live directly under the shell .wrap/stage.
        if(STAGE_IDS.indexOf(id) === -1 && els[i].parentNode === stage.parentNode){
          missing.push(id);
        }
      }
      if(missing.length && window.console && console.warn){
        console.warn("[tab-slide] these panels are NOT staged, so they will not "
          + "animate — add them to STAGE_IDS in tab-slide.js (and to _ord in "
          + "sandbox.js applyView): " + missing.join(", "));
      }
    }catch(e){}
  }
  try{ if(document.readyState !== "loading") ensureStage();
       else document.addEventListener("DOMContentLoaded", ensureStage); }catch(e){}

  function instant(fromEl, toEl){
    try{ if(toEl) toEl.classList.add("active"); }catch(e){}
    try{ if(fromEl && fromEl !== toEl) fromEl.classList.remove("active"); }catch(e){}
  }

  function finalizeInFlight(){
    if(activeCleanup){ try{ activeCleanup(); }catch(e){} }
  }

  window.__aoTabSlide = function(fromEl, toEl, dir){
    // Guard rails: any failure → instant, never a stuck/blank stage.
    if(!fromEl || !toEl || fromEl === toEl){ instant(fromEl, toEl); return; }
    if(disabled() || reduced()){ instant(fromEl, toEl); return; }

    var s = ensureStage();
    if(!s || fromEl.parentNode !== s || toEl.parentNode !== s){ instant(fromEl, toEl); return; }

    if(sliding) finalizeInFlight();  // snap any in-flight slide before starting a new one

    try{
      sliding = true;
      // Travel a FULL viewport width so panels enter/leave at the true screen
      // edges instead of the centered column's edge (Ford: "they spawn right next
      // to it"). <html>.ao-tab-sliding clips the off-screen travel (no scrollbar).
      var enter = (dir >= 0 ? "100vw" : "-100vw");   // incoming starts off this side
      var exit  = (dir >= 0 ? "-100vw" : "100vw");   // outgoing leaves to this side

      // Pin the content column width BEFORE the stage goes full-bleed, so the
      // absolutely-positioned panels stay their normal width (not stretched to
      // 100vw). Measured off the outgoing panel WHILE it is still in normal flow
      // (before .ao-sliding makes both absolute — absolute w/o width is shrink-to-fit).
      var pinW = fromEl.offsetWidth || toEl.offsetWidth || 0;

      // Commit the LOGICAL active state BEFORE measuring height. Only `to` is
      // .active. Active-gated content (Fleet Triage attention queue used to paint
      // only when .active) and display:flow-root on .panel.active must be in place
      // so toH is the real full-length height — not a short empty shell that then
      // "grows" mid-slide (Ford 2026-07-17: Inverters → Fleet Triage).
      toEl.classList.add("active");
      fromEl.classList.remove("active");
      // Optional last-paint hook for the destination (callers may fill lazy DOM).
      try{
        if(typeof window.__aoTabBeforeSlide === "function"){
          window.__aoTabBeforeSlide(toEl, fromEl);
        }
      }catch(e){}

      // Reveal both via the slide classes (CSS: stage full-bleed + clip both axes;
      // panels position:absolute, left:50%, transform-eased).
      s.classList.add("ao-sliding");
      fromEl.classList.add("ao-slide-from");
      toEl.classList.add("ao-slide-to");
      try{ document.documentElement.classList.add("ao-tab-sliding"); }catch(e){}
      // Pin width + center each panel (left:50% from CSS, negative half-width here).
      if(pinW > 0){
        [fromEl, toEl].forEach(function(el){
          el.style.width = pinW + "px";
          el.style.marginLeft = (-pinW / 2) + "px";
        });
      }
      // Measure heights now (both are display:block at the pinned width, active
      // content already painted). Stage height SNAP-locks to max(from, to) for the
      // whole slide — never eases. Horizontal transform only; panel arrives at
      // full size from frame 0.
      var fromH = fromEl.offsetHeight || 0, toH = toEl.offsetHeight || 0;
      var stageH = Math.max(fromH, toH);

      // Place at start with transitions OFF, force a reflow, then play transform only.
      fromEl.style.transition = "none";
      toEl.style.transition = "none";
      s.style.transition = "none";
      fromEl.style.transform = "translateX(0)";
      toEl.style.transform = "translateX(" + enter + ")";
      if(stageH > 0) s.style.height = stageH + "px";
      void s.offsetWidth;                       // commit the start frame
      fromEl.style.transition = "";             // hand easing back to tab-slide.css
      toEl.style.transition = "";
      // Stage height stays put (no transition) — only the panels move.
      fromEl.style.transform = "translateX(" + exit + ")";
      toEl.style.transform = "translateX(0)";

      var done = false, timer = 0;
      function cleanup(){
        if(done) return; done = true;
        try{ clearTimeout(timer); }catch(e){}
        try{ toEl.removeEventListener("transitionend", onEnd); }catch(e){}
        try{
          s.classList.remove("ao-sliding");
          s.style.height = ""; s.style.transition = "";
          s.style.removeProperty("--ao-stage-h");
        }catch(e){}
        try{ document.documentElement.classList.remove("ao-tab-sliding"); }catch(e){}
        [fromEl, toEl].forEach(function(el){
          try{
            el.classList.remove("ao-slide-from","ao-slide-to");
            el.style.transform = ""; el.style.transition = "";
            el.style.width = ""; el.style.marginLeft = "";
          }catch(e){}
        });
        // Final truth: only `to` is active.
        try{ fromEl.classList.remove("active"); toEl.classList.add("active"); }catch(e){}
        sliding = false; activeCleanup = null;
      }
      // Cleanup fires when the horizontal transform finishes.
      function onEnd(e){ if(e.target === toEl && e.propertyName === "transform") cleanup(); }
      activeCleanup = cleanup;
      toEl.addEventListener("transitionend", onEnd);
      timer = setTimeout(cleanup, DUR_MS + 140);   // safety net if transitionend misfires
    }catch(err){
      // Anything unexpected → guarantee correct final state instantly.
      try{
        if(s){ s.classList.remove("ao-sliding"); s.style.height = ""; s.style.transition = ""; s.style.removeProperty("--ao-stage-h"); }
        try{ document.documentElement.classList.remove("ao-tab-sliding"); }catch(e){}
        [fromEl, toEl].forEach(function(el){
          el.classList.remove("ao-slide-from","ao-slide-to");
          el.style.transform = ""; el.style.transition = "";
          el.style.width = ""; el.style.marginLeft = "";
        });
      }catch(e){}
      instant(fromEl, toEl);
      sliding = false; activeCleanup = null;
    }
  };
})();
