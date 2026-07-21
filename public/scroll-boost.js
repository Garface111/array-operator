/**
 * Site-wide scroll boost — makes wheel/trackpad travel farther without
 * killing OS momentum (which is what made a preventDefault multiplier feel
 * *slower* on trackpads).
 *
 * Strategy: leave the browser’s native scroll alone, then add EXTRA distance
 * so total ≈ MULT × the default step. No preventDefault → inertia stays.
 *
 * Default MULT = 3 (2× extra on top of native). Override: ?scroll=4 or
 * window.__AO_SCROLL_MULT = 4 before this script loads.
 */
(function () {
  "use strict";
  if (window.__AO_SCROLL_BOOST) return;
  window.__AO_SCROLL_BOOST = true;

  // Total intended multiple of native step. Extra applied = (MULT - 1).
  var MULT = 3;
  try {
    if (typeof window.__AO_SCROLL_MULT === "number" && window.__AO_SCROLL_MULT > 0) {
      MULT = window.__AO_SCROLL_MULT;
    } else {
      var q = new URLSearchParams(location.search).get("scroll");
      if (q != null && q !== "") MULT = parseFloat(q) || MULT;
    }
  } catch (e) {}
  MULT = Math.max(1, Math.min(6, MULT));

  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      MULT = 1;
    }
  } catch (e2) {}

  var EXTRA = MULT - 1; // e.g. MULT=3 → add 2× native on top of native = 3× total
  if (EXTRA < 0.05) return;

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
      // Allow boosting even near edges — browser may still move parent.
      return true;
    }
    return !!canX;
  }

  function findTarget(start, dx, dy) {
    var el = start && start.nodeType === 1 ? start : start && start.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el, dx, dy)) {
        // Prefer the element that can still move in the gesture direction.
        if (Math.abs(dy) >= Math.abs(dx)) {
          if (dy < 0 && el.scrollTop > 0) return el;
          if (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return el;
          // At edge: keep walking so we boost the parent that will actually move.
        } else {
          if (dx < 0 && el.scrollLeft > 0) return el;
          if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return el;
        }
      }
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
    if (t.closest(".sb-viewport, [data-wheel-zoom], [data-no-scroll-boost]")) return true;
    return false;
  }

  function onWheel(e) {
    if (shouldSkip(e)) return;

    var dx = e.deltaX;
    var dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= window.innerWidth || 800;
      dy *= window.innerHeight || 600;
    }
    if (!dx && !dy) return;

    // Extra only — native scroll still runs (no preventDefault).
    var addX = dx * EXTRA;
    var addY = dy * EXTRA;
    var target = findTarget(e.target, dx, dy);
    var root = document.scrollingElement || document.documentElement;

    if (target === root || target === document.documentElement || target === document.body) {
      // Instant extra jump (behavior:auto — never inherit html{scroll-behavior:smooth},
      // which made each wheel tick animate and felt *slower* than native).
      try {
        window.scrollBy({ left: addX, top: addY, behavior: "auto" });
      } catch (err) {
        window.scrollBy(addX, addY);
      }
    } else {
      target.scrollLeft += addX;
      target.scrollTop += addY;
    }
  }

  // passive:true — we never call preventDefault (critical for trackpad feel).
  window.addEventListener("wheel", onWheel, { passive: true, capture: false });
})();
