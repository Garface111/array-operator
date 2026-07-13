/* ============================================================================
 * Array Operator — Trends shared CORE (trends-core.js)
 *
 * The keystone for the multi-view Trends tab. Owns everything the four
 * concept renderers SHARE so they stay visually consistent and can't drift:
 *   - brand color tokens (read from CSS vars, with hard fallbacks)
 *   - per-year color assignment (newest year = bold green)
 *   - number formatting
 *   - a responsive, hi-DPI, auto-animating <canvas> helper
 *   - data preparation (years, peak, normalized monthly series)
 *   - a smooth (catmull-rom) path helper
 *   - the VIEW REGISTRY: window.AOTrends.registerView(key, def)
 *
 * Loaded BEFORE trends.js and the four trends-view-*.js files.
 * Contract doc: TRENDS-VIEWS-CONTRACT.md
 * ==========================================================================*/
(function () {
  "use strict";

  const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const MONTHS3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  // SKY demo flag (flag-gated "Sky" redesign, 2026-07-12). Canvas draw code
  // can't be re-themed from CSS, so palette CONSTANTS branch on the flag here.
  // Flag off ⇒ every value below is byte-identical to stock.
  const SKY = document.documentElement.classList.contains("sky");

  // Brand palette — pulled live from styles.css :root, with fallbacks so the
  // renderers work even if loaded standalone (e.g. an agent's test harness).
  const COLORS = {
    get good()  { return cssVar("--good", "#3fd68a"); },
    get good2() { return cssVar("--good2", "#7ff0bb"); },
    get gold()  { return cssVar("--gold", "#f5b942"); },
    get gold2() { return cssVar("--gold2", "#ffd479"); },
    get sky()   { return cssVar("--sky", "#5ec2ff"); },
    get vio()   { return cssVar("--vio", "#b07cf0"); },
    get ink()   { return cssVar("--ink", "#eaf0f7"); },
    get muted() { return cssVar("--muted", "#8b97a8"); },
    get faint() { return cssVar("--faint", "#6b7686"); },
    get bg()    { return cssVar("--bg", "#0a0e14"); },
    line: SKY ? "rgba(14,20,32,.10)" : "rgba(255,255,255,.08)",
  };

  // Deterministic year -> hue. Newest year = boldest green; then gold, sky,
  // violet, gold, teal… Up to 8 distinct years before repeating.
  // Sky theme: newest year = the action blue, prior year = deep sky-700 (the
  // day theme's ratified readable blue — year colors also render as 11px
  // tooltip TEXT, where the brief's light #56B4F0 fails contrast on white),
  // then day-legible amber/violet/teal — same hue ROLES, re-cut for light.
  const YEAR_PALETTE = SKY
    ? ["#2196F3", "#0369A1", "#D97706", "#7C3AED",
       "#0D9488", "#B45309", "#64748B", "#A16207"]
    : ["#3fd68a", "#f5b942", "#5ec2ff", "#b07cf0",
       "#2bb6a8", "#e6a23c", "#9aa0aa", "#d4a017"];
  function yearColor(year, years) {
    const desc = [...years].sort((a, b) => b - a);
    const i = desc.indexOf(year);
    return YEAR_PALETTE[(i < 0 ? years.length : i) % YEAR_PALETTE.length];
  }

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmt0 = n => n == null ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  function kCompact(n) {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }
  function hexA(hex, a) {
    if (!hex) hex = "#3fd68a";
    if (hex[0] !== "#") return hex; // already rgba/named — pass through
    const h = hex.replace("#", "");
    const r = parseInt(h.substr(0, 2), 16),
          g = parseInt(h.substr(2, 2), 16),
          b = parseInt(h.substr(4, 2), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Normalize the /fleet-trends payload into the shape every renderer wants. */
  function prep(data) {
    const years = (data.years || []).slice().sort((a, b) => a - b);
    const monthly = data.monthly_by_year || {};
    let peak = 0;
    years.forEach(y => (monthly[String(y)] || []).forEach(p => {
      if (p && p.kwh > peak) peak = p.kwh;
    }));
    if (peak <= 0) peak = 1;
    return {
      years,
      latestYear: years.length ? Math.max(...years) : null,
      monthly,                       // {"2025":[{month,kwh}]}
      peak,
      seasonal: data.seasonal_yoy || [],
      dailyRecent: data.daily_recent || [],
      byArray: data.by_array || [],
      raw: data,
    };
  }

  /** Smooth a polyline (array of [x,y]) into the current path via catmull-rom. */
  function smoothPath(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i],
            p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]);
    }
  }

  /**
   * Responsive, hi-DPI, auto-animating canvas inside `container`.
   *   const c = core.createCanvas(container, { aspect: 2.8 });
   *   c.start((ctx, w, h, t) => { ...draw in CSS pixels... });
   *   // later: c.stop();  (also auto-stops if the canvas leaves the DOM)
   * w/h are LOGICAL (CSS) pixels; DPI scaling is handled for you. t = ms since start.
   */
  function createCanvas(container, opts) {
    opts = opts || {};
    const aspect = opts.aspect || 2.8;     // width / height
    const maxH = opts.maxHeight || 560;
    const minH = opts.minHeight || 220;
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.display = "block";
    canvas.style.borderRadius = "14px";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let w = 0, h = 0, dpr = 1, raf = 0, drawFn = null, t0 = 0, stopped = false;

    function fit() {
      const cssW = container.clientWidth || 760;
      let cssH = cssW / aspect;
      cssH = Math.max(minH, Math.min(maxH, cssH));
      dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      w = cssW; h = cssH;
      canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    fit();

    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => fit());
      ro.observe(container);
    } else {
      window.addEventListener("resize", fit);
    }

    function frame(now) {
      if (stopped) return;
      if (!t0) t0 = now;
      // auto-stop if detached from the document (view switched away)
      if (!container.isConnected) { stop(); return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (drawFn) drawFn(ctx, w, h, now - t0);
      raf = requestAnimationFrame(frame);
    }
    function start(fn) { drawFn = fn; if (!raf) raf = requestAnimationFrame(frame); return api; }
    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", fit);
    }
    const api = { canvas, ctx, start, stop, get w() { return w; }, get h() { return h; } };
    return api;
  }

  // ── VIEW REGISTRY ──────────────────────────────────────────────────────────
  // Each trends-view-*.js calls AOTrends.registerView(key, def). `def`:
  //   { key, label, badge, order, describe, mount(container, prepped, core) -> stopFn }
  const _views = {};
  function registerView(key, def) {
    _views[key] = Object.assign({ key }, def);
  }
  function listViews() {
    return Object.values(_views).sort((a, b) => (a.order || 99) - (b.order || 99));
  }
  function getView(key) { return _views[key]; }

  window.AOTrends = {
    MONTHS, MONTHS3, COLORS, YEAR_PALETTE,
    yearColor, esc, fmt0, kCompact, hexA,
    prep, smoothPath, createCanvas,
    registerView, listViews, getView,
  };
})();
