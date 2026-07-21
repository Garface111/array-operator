/**
 * Site-wide scroll boost — wheel/trackpad moves farther per gesture than the
 * OS default, so long pages (fleet, invoices, analysis) feel snappy.
 *
 * Multiplier: 2.25× (override with ?scroll=1.5 … 4, or window.__AO_SCROLL_MULT).
 * Skips: browser zoom (ctrl/meta+wheel), form fields, sandbox canvas zoom,
 *        [data-no-scroll-boost], prefers-reduced-motion.
 */
(function () {
  "use strict";
  if (window.__AO_SCROLL_BOOST) return;
  window.__AO_SCROLL_BOOST = true;

  var MULT = 2.25;
  try {
    if (typeof window.__AO_SCROLL_MULT === "number" && window.__AO_SCROLL_MULT > 0) {
      MULT = window.__AO_SCROLL_MULT;
    } else {
      var q = new URLSearchParams(location.search).get("scroll");
      if (q != null && q !== "") MULT = parseFloat(q) || MULT;
    }
  } catch (e) {}
  MULT = Math.max(1, Math.min(4, MULT));

  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      MULT = 1; // no artificial boost when the OS asks for less motion
    }
  } catch (e2) {}

  if (MULT <= 1.001) return;

  function isScrollable(el, dx, dy) {
    if (!el || el.nodeType !== 1) return false;
    var st = window.getComputedStyle(el);
    var oy = st.overflowY;
    var ox = st.overflowX;
    var canY =
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      el.scrollHeight > el.clientHeight + 1;
    var canX =
      (ox === "auto" || ox === "scroll" || ox === "overlay") &&
      el.scrollWidth > el.clientWidth + 1;
    if (Math.abs(dy) >= Math.abs(dx)) {
      if (!canY) return false;
      if (dy < 0 && el.scrollTop <= 0) return false;
      if (dy > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return false;
      return true;
    }
    if (!canX) return false;
    if (dx < 0 && el.scrollLeft <= 0) return false;
    if (dx > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1) return false;
    return true;
  }

  function findTarget(start, dx, dy) {
    var el = start && start.nodeType === 1 ? start : start && start.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el, dx, dy)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function shouldSkip(e) {
    if (e.ctrlKey || e.metaKey) return true;
    if (e.defaultPrevented) return true;
    var t = e.target;
    if (!t || typeof t.closest !== "function") return false;
    if (t.closest("textarea, select, [contenteditable='true'], [contenteditable='']")) return true;
    var inp = t.closest("input");
    if (inp) {
      var typ = (inp.type || "text").toLowerCase();
      if (typ === "number" || typ === "range" || typ === "date" || typ === "time" || typ === "month") {
        return true;
      }
    }
    // Sandbox fleet canvas uses wheel to zoom — leave native/handler alone.
    if (t.closest(".sb-viewport, [data-wheel-zoom], [data-no-scroll-boost]")) return true;
    return false;
  }

  function onWheel(e) {
    if (shouldSkip(e)) return;

    var dx = e.deltaX;
    var dy = e.deltaY;
    // Normalize line/page modes to roughly pixel scale before multiplying.
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= window.innerWidth || 800;
      dy *= window.innerHeight || 600;
    }
    if (!dx && !dy) return;

    var target = findTarget(e.target, dx, dy);
    e.preventDefault();

    var left = dx * MULT;
    var top = dy * MULT;
    var root = document.scrollingElement || document.documentElement;
    if (target === root || target === document.documentElement || target === document.body) {
      window.scrollBy(left, top);
    } else {
      target.scrollLeft += left;
      target.scrollTop += top;
    }
  }

  // Bubble phase: let element-level handlers (sandbox zoom, maps) run first.
  window.addEventListener("wheel", onWheel, { passive: false, capture: false });
})();
