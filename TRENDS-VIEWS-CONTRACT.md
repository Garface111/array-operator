# Trends Views — Contract (Array Operator)

The Trends tab renders four interchangeable visualizations of the SAME fleet
production data, chosen by a segmented switcher. Each view is ONE self-contained
file that registers itself on a shared registry. **One agent owns one view file.
Do not touch any other view file, trends-core.js, or trends.js.**

## Files (ownership)
- `trends-core.js`   — shared helpers + registry + responsive canvas. OWNED BY KEYSTONE. Do not edit.
- `trends.js`        — orchestrator: fetch, stat band, switcher, by-array table, state. OWNED BY KEYSTONE. Do not edit.
- `trends-view-liquid.js`    — Concept A "Liquid Energy"  (key `liquid`)
- `trends-view-spiral.js`    — Concept B "Solar Spiral"   (key `spiral`)
- `trends-view-ridgeline.js` — Concept C "Energy Ridgeline" (key `ridgeline`)
- `trends-view-heatfield.js` — Concept D "Production Heat-Field" (key `heatfield`)
- `trends.css`       — scoped styles. You MAY append rules prefixed with your view's
  key (e.g. `.trv-liquid-*`). Do not modify other views' rules.

## How a view registers
```js
(function () {
  "use strict";
  const C = window.AOTrends;            // the core (see trends-core.js)
  C.registerView("liquid", {
    label: "Liquid Energy",
    badge: "A",
    order: 1,                            // switcher order
    describe: "Current year as living fluid; prior years ghosted behind.",
    // container: an empty <div> sized to the chart area (full width).
    // prepped:   output of C.prep(data) — see shape below.
    // returns:   a cleanup fn that stops animation / removes listeners.
    mount(container, prepped, C) {
      const cv = C.createCanvas(container, { aspect: 2.8 });
      cv.start((ctx, w, h, t) => { /* draw in CSS px; t = ms */ });
      return () => cv.stop();
    },
  });
})();
```

## Data shape (`prepped` = C.prep(payload))
```
{
  years: [2024,2025,2026],            // ascending
  latestYear: 2026,
  monthly: { "2025":[{month:1,kwh:..},..], .. },  // month 1..12, may be partial
  peak: 10421,                        // max monthly kwh across all years (>=1)
  seasonal: [{month,label,by_year,latest_delta_pct}],
  byArray: [{array_id,name,lifetime_kwh,years:[..]}],
  raw: <original payload>             // ttm_kwh, lifetime_kwh, ttm_savings_usd here
}
```
The current year (`latestYear`) is usually PARTIAL (e.g. Jan–Jul only). Handle it.

## Core helpers (window.AOTrends)
- `MONTHS` (["J".."D"]), `MONTHS3` (["Jan".."Dec"])
- `COLORS` (.good/.good2/.gold/.gold2/.sky/.vio/.ink/.muted/.faint/.bg/.line) — live brand tokens
- `yearColor(year, years)` — newest year = bold green
- `fmt0(n)`, `kCompact(n)`, `esc(s)`, `hexA(hex, alpha)`
- `smoothPath(ctx, [[x,y],..])` — catmull-rom into current path
- `createCanvas(container, {aspect,maxHeight,minHeight})` — responsive hi-DPI animated canvas;
  `.start(draw)`, `.stop()`. Auto-stops when detached from DOM.

## Your job (per view)
Take the QA'd baseline already in your file and ELEVATE it for production:
1. **Empty/thin data:** `years.length===0` → the orchestrator shows an empty state, so you
   won't be mounted; BUT handle 1 year, and a partial latest year, gracefully.
2. **Responsive:** must look right from 360px (mobile) to 1200px wide. Use the canvas w/h
   passed to your draw fn — never hardcode pixel widths.
3. **Hover tooltip:** add a tooltip showing the month + exact kWh (+ year) for the data point
   nearest the cursor. Use a single absolutely-positioned `<div>` you create in `container`
   (`position:relative` is already set on it). Remove it in your cleanup fn.
4. **Polish:** match the brand (deep navy bg, green/gold glow). Keep the animation smooth and
   CALM — subtle, not seizure-inducing. Respect `prefers-reduced-motion` (skip the animated
   wobble, draw a static frame).
5. **Legend/labels:** legible at all sizes; don't clip month labels at edges.

## Hard rules
- Vanilla JS only. No build step, no new dependencies, no CDN. (matches the app's stack)
- Edit ONLY your `trends-view-<key>.js` and append-only CSS in `trends.css` prefixed `.trv-<key>-`.
- Do NOT run a server on ports 8899 (preview) or anything bound already. Test by opening
  `trends-concepts-live.html` (a standalone harness that loads core + all views against a
  built-in demo dataset) via `file://` or your own throwaway port.
- Verify your view renders with NO console errors before finishing. Report what you changed.
