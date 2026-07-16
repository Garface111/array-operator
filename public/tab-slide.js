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

  var STAGE_IDS = [
    "panelDashboard","panelAccount","panelSovereign","panelArrays",
    "panelAnalysis","panelTrends","panelResources","panelReports","panelOps"
  ];
  var DUR_MS = 340;
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
      return s;
    }catch(e){ return null; }
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
      var enter = (dir >= 0 ? 100 : -100);   // incoming starts off this side (%)
      var exit  = (dir >= 0 ? -100 : 100);   // outgoing leaves to this side (%)

      // Reveal both via the slide classes (CSS forces display:block on each) and
      // hold the stage height at the taller of the two so it can't collapse while
      // both are position:absolute.
      s.classList.add("ao-sliding");
      fromEl.classList.add("ao-slide-from");
      toEl.classList.add("ao-slide-to");
      var h = Math.max(fromEl.offsetHeight || 0, toEl.offsetHeight || 0);
      if(h > 0) s.style.setProperty("--ao-stage-h", h + "px");
      // Commit the LOGICAL active state immediately — only `to` is .active. Both
      // panels stay visible during the slide via .ao-slide-from/.ao-slide-to, so a
      // rapid re-switch mid-slide reads `to` as the current panel (no two-active
      // limbo that would feed the wrong "from" into the next slide).
      toEl.classList.add("active");
      fromEl.classList.remove("active");

      // Place at start with transitions OFF, force a reflow, then play.
      fromEl.style.transition = "none";
      toEl.style.transition = "none";
      fromEl.style.transform = "translateX(0)";
      toEl.style.transform = "translateX(" + enter + "%)";
      void s.offsetWidth;                       // commit the start frame
      fromEl.style.transition = "";             // hand easing back to tab-slide.css
      toEl.style.transition = "";
      fromEl.style.transform = "translateX(" + exit + "%)";
      toEl.style.transform = "translateX(0)";

      var done = false, timer = 0;
      function cleanup(){
        if(done) return; done = true;
        try{ clearTimeout(timer); }catch(e){}
        try{ toEl.removeEventListener("transitionend", onEnd); }catch(e){}
        try{ s.classList.remove("ao-sliding"); s.style.removeProperty("--ao-stage-h"); }catch(e){}
        [fromEl, toEl].forEach(function(el){
          try{
            el.classList.remove("ao-slide-from","ao-slide-to");
            el.style.transform = ""; el.style.transition = "";
          }catch(e){}
        });
        // Final truth: only `to` is active.
        try{ fromEl.classList.remove("active"); toEl.classList.add("active"); }catch(e){}
        sliding = false; activeCleanup = null;
      }
      function onEnd(e){ if(e.target === toEl && e.propertyName === "transform") cleanup(); }
      activeCleanup = cleanup;
      toEl.addEventListener("transitionend", onEnd);
      timer = setTimeout(cleanup, DUR_MS + 140);   // safety net if transitionend misfires
    }catch(err){
      // Anything unexpected → guarantee correct final state instantly.
      try{
        if(s){ s.classList.remove("ao-sliding"); s.style.removeProperty("--ao-stage-h"); }
        [fromEl, toEl].forEach(function(el){
          el.classList.remove("ao-slide-from","ao-slide-to");
          el.style.transform = ""; el.style.transition = "";
        });
      }catch(e){}
      instant(fromEl, toEl);
      sliding = false; activeCleanup = null;
    }
  };
})();
