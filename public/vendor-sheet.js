/* ============================================================================
 * Array Operator, Vendor-data SPREADSHEET view (vendor-sheet.js)
 *
 * A structured, spreadsheet-style sibling to the Sandbox under the "Vendor data"
 * tab: every array as a row, grouped by vendor; click a row to expand its
 * inverters; SEARCH to filter; click a column header to SORT (within each vendor
 * group). Reads the SAME canonical fleet as the sandbox (FleetStore) so the two
 * views never drift. The persistent header (search + sortable headers) is built
 * once and only the table BODY re-renders, so typing never loses focus.
 * ==========================================================================*/
(function () {
 "use strict";
 const $ = (s, r) => (r || document).querySelector(s);
 function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"]/g,
 c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
 }
 const BRAND = {
 solaredge: "SolarEdge", fronius: "Fronius", sma: "SMA", chint: "Chint",
 locus: "Locus", enphase: "Enphase", solis: "Solis", tigo: "Tigo",
 alsoenergy: "AlsoEnergy",
 };
 const vlabel = v => BRAND[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : "Other");
 // Tiny row-TYPE glyphs so you can see what you're looking at at a glance (Ford 2026-07-13:
 // "a little array icon next to arrays, a little inverter icon next to inverters"). Inline
 // SVG, no external fetch. ARRAY = a 2×2 grid of panels (a field of modules); INVERTER =
 // a device box with an AC sine wave (what an inverter does: DC→AC). Muted via CSS so they
 // read as quiet structural cues, not decoration.
 const ICON_ARRAY = '<svg class="vs-rowicon vs-rowicon-array" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.6" y="1.6" width="5.3" height="5.3" rx="1.1"/><rect x="9.1" y="1.6" width="5.3" height="5.3" rx="1.1"/><rect x="1.6" y="9.1" width="5.3" height="5.3" rx="1.1"/><rect x="9.1" y="9.1" width="5.3" height="5.3" rx="1.1"/></g></svg>';
 const ICON_INVERTER = '<svg class="vs-rowicon vs-rowicon-inv" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.7" y="3.3" width="12.6" height="9.4" rx="2"/><path d="M4.3 9q1.35-2.6 2.85 0t2.85 0"/></g></svg>';
 // Vendor subtree accent. Ford 2026-07-12: the per-vendor RAINBOW (a different hue per
 // vendor) "looks weird and unprofessional, doesn't match our thing." Removed. No inline
 // --vc is emitted anymore, so every vendor group falls back to ONE neutral slate spine +
 // a barely-there header shade (the --vc fallbacks in command-center.css / theme-sky-
 // triage.css), the vendor → array → inverter levels still read as distinct containers,
 // just monochrome instead of a clashing multi-color rainbow.
 // Fronius/SMA/Chint expose only ONE site-level instantaneous power; the backend
 // splits it across inverters by today's energy share, so a per-inverter "kW now"
 // is an ESTIMATE, not a measured per-device reading (data-honesty audit #5). The
 // sandbox marks it "~" + a tip; the spreadsheet must apply the same treatment so it
 // can't read as an exact measured value.
 function isAllocatedPower(iv) {
 return iv && iv.current_power_w != null &&
 (iv.vendor === "fronius" || iv.vendor === "sma" || iv.vendor === "chint");
 }
 // Current power as a % of the inverter's rated nameplate, "% of max", mirroring the
 // Sandbox card (Ford/Bruce: show it in the spreadsheet rows too). Shown for ALLOCATED
 // vendors (Chint/Fronius/SMA) as well, the ~ on the kW + the allocated tooltip already
 // flag the reading as a split estimate, exactly as the sandbox does (which is why this
 // is honest to show). null when no nameplate is known. The allocation is by ENERGY
 // share, not nameplate, so the % varies per inverter and is meaningful.
 function pctOfMax(iv) {
 return (iv && iv.nameplate_kw && iv.current_power_w != null)
 ? Math.round(iv.current_power_w / (iv.nameplate_kw * 1000) * 100) + "% of max" : null;
 }
 // ── Output gauges ────────────────────────────────────────────────────────────
 // A little speedometer per row: how hard is this inverter / array / vendor running
 // RIGHT NOW as a fraction of its nameplate. Glanceable, green needle swung right =
 // near capacity, amber straight up = middling, red swung left = barely producing.
 function _capW(iv) { return (iv && iv.nameplate_kw) ? iv.nameplate_kw * 1000 : 0; }
 function _arrCapW(c) { return (c.inverters || []).reduce((t, iv) => t + _capW(iv), 0); }
 function _arrPowW(c) {
 return c.current_power_w != null ? c.current_power_w
 : (c.inverters || []).reduce((t, iv) => t + (iv.current_power_w || 0), 0);
 }
 function _frac(powW, capW) { return (capW > 0 && powW != null) ? Math.max(0, powW / capW) : null; }
 function invFrac(iv) { return _frac(iv.current_power_w, _capW(iv)); }
 function arrFrac(c) { return _frac(_arrPowW(c), _arrCapW(c)); }
 function vendorFrac(list) {
 let p = 0, cap = 0;
 list.forEach(c => { cap += _arrCapW(c); p += _arrPowW(c); });
 return _frac(p, cap);
 }
 // Status → gauge color. A raw "% of nameplate" threshold used to pick this instead
 // (green >=66%, amber >=33%, red below), but nameplate output swings normally all
 // day (time of day, cloud cover, a smaller string) and has nothing to do with actual
 // health. That painted a perfectly healthy "OK" inverter amber for hours at a time,
 // the SAME color the real peer-verified "Low vs peers" warning uses right next to it
 // in the status column, a false alarm dressed as a data bug (Ford 2026-07-12: two
 // "OK" inverters at 60% and 66% of nameplate got orange vs green for no health reason
 // anyone could see). The gauge still shows the true output fraction via needle
 // position + fill, but its COLOR now matches the row's own verdict (ok/warn/bad/
 // muted), the same classification already driving the status pill beside it.
 const GAUGE_STATUS_COLOR = { ok: "#16a34a", warn: "#d97706", bad: "#dc2626", watch: "#0891b2", muted: "#94a3b8" };
 function gauge(frac, opts) {
 opts = opts || {};
 if (frac == null) return `<span class="vs-gauge vs-gauge-empty" title="No nameplate on file, can't gauge output"></span>`;
 const f = Math.max(0, Math.min(1, frac));
 const pct = Math.round(f * 100);
 const cx = 50, cy = 46, r = 38;
 const ang = Math.PI * (1 - f); // 0% → π (left), 100% → 0 (right)
 const dx = Math.cos(ang), dy = -Math.sin(ang); // needle direction (SVG y points down)
 const px = -dy, py = dx; // perpendicular, for the needle base
 const len = r - 2.5, hb = 2.7;
 const tx = cx + len * dx, ty = cy + len * dy;
 const ax = cx + hb * px, ay = cy + hb * py;
 const bx = cx - hb * px, by = cy - hb * py;
 const zc = GAUGE_STATUS_COLOR[opts.statusCls] || "#2563eb";
 const idle = opts.idle ? " vs-gauge-idle" : "";
 const title = (opts.label ? opts.label + " · " : "") + pct + "% of nameplate output"
 + (opts.statusLabel ? " · " + opts.statusLabel : "");
 const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
 // The arc has pathLength 100, so the FILLED portion is just the first `f×100` units —
 // the colored energy fills from the left (0%) up to the needle; the rest stays a faint
 // empty track. The static offset below is the resting state; when the sheet scrolls into
 // view a `.vs-sweep` class animates the fill up from empty (0→off) and the needle from
 // the left (--gg-rot) to its value, so the dial "fills with energy" right as you look.
 const off = (100 * (1 - f)).toFixed(2); // dash offset that reveals fraction f
 return `<span class="vs-gauge${idle}" title="${esc(title)}">` +
 `<svg viewBox="0 0 100 52" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">` +
 `<path class="vs-gg-track" d="${arc}" fill="none" stroke-width="7" stroke-linecap="round"/>` +
 `<path class="vs-gg-fill" d="${arc}" fill="none" stroke="${zc}" stroke-width="7" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${off}" style="--gg-off:${off}"/>` +
 `<g class="vs-gg-nwrap" style="--gg-rot:${(-f * 180).toFixed(1)}deg">` +
 `<polygon class="vs-gg-needle" points="${ax.toFixed(1)},${ay.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" fill="${zc}"/>` +
 `<circle cx="${cx}" cy="${cy}" r="4" fill="${zc}"/><circle cx="${cx}" cy="${cy}" r="1.6" fill="#fff"/>` +
 `</g></svg></span>`;
 }
 const ALLOC_TIP = v =>
 `${vlabel(v)} reports one site-level power, we split it across inverters by today's energy share, so this per-inverter kW is an estimate.`;
 // The ARRAY-level kW is just the sum of those split per-inverter readings, so for
 // these vendors it's an estimate too. Mark it the same way so the array row (and the
 // per-vendor group total) can't read as an exact measured value.
 const ALLOC_VENDORS = { fronius: 1, sma: 1, chint: 1 };
 function isAllocatedVendor(v) { return !!ALLOC_VENDORS[(v || "").toLowerCase()]; }
 function isArrayAllocatedPower(c) {
 return c && c.current_power_w != null && isAllocatedVendor(c.vendor);
 }
 const ARR_ALLOC_TIP = v =>
 `${vlabel(v)} reports one site-level power that we split across inverters, this array total is the sum of those estimates, not a measured reading.`;
 function kw(w) {
 if (w == null) return "—";
 const k = w / 1000;
 return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + " kW";
 }
 // Empty cells stay blank (not "—") so missing today/kWh never clutters the row
 // next to the sparklines (Ford 2026-07-14: little dashes in the way of the graphs).
 function kwh0(n) { return n == null ? "" : Math.round(n).toLocaleString() + " kWh"; }

 // When a LIVE-NOW or TODAY cell is blank ("—"), say WHY on hover so it reads as a known
 // state, not a broken feed. OVERNIGHT the panels are down and live power is intentionally
 // blank (the backend's daylight honesty gate, a stale midday reading must never show as
 // "producing 17 kW at 2am"), and today's total is 0 until the sun is up; BY DAY a blank
 // just means we haven't captured a fresh reading yet. Ford 2026-07-12 ("why isn't data
 // showing under live now / today"), it was the middle of the night; this makes the blank
 // explain itself instead of looking broken.
 function liveEmptyTip(isDaylight) {
 return isDaylight === false
 ? "The panels are down for the night, live output is paused until sunrise."
 : "No live reading captured yet, it fills in on the next sync.";
 }
 function todayEmptyTip(isDaylight) {
 return isDaylight === false
 ? "Nothing produced yet today, today's total starts building after sunrise."
 : "No production captured yet today.";
 }

 // "Today" provenance. The backend marks an array's today-kWh as an ESTIMATE when
 // it was smeared from a utility bill (produced_today_source === "bill_prorate"),
 // vs a MEASURED reading (vendor telemetry / CSV / GMP / summed live). Surface that
 // so a prorated estimate can't read as a metered total, same data-honesty rule as
 // the allocated per-inverter power. Returns {est, tip}.
 function todayProvenance(c) {
 const est = !!(c && (c.produced_today_is_estimated || c.produced_today_source === "bill_prorate"))
 && c.produced_today_kwh != null;
 return {
 est,
 tip: est
 ? "Estimated from your utility bill (spread evenly across the month), not a measured reading."
 : "",
 };
 }


 // Each return carries `count` = how many inverters this array is flagging, so the
 // vendor-group rollup (vendorStatusSummary) can total REAL inverter counts instead
 // of scraping a leading digit off the display string. Critical headlines like "An
 // inverter stopped earning" have no digit but alert.count knows the true number
 // (e.g. 3 dead), so scraping undercounted multi-dead arrays to 1.
 //
 // VENDOR ISSUE (Ford 2026-07-13): when the MONITORING VENDOR is the problem, SolarEdge
 // source clock stale (Londonderry 15h+ with no live power), Chint harvesting zeros /
 // failing harvest while the rest of the fleet produces, NEVER badge "All clear".
 // The 14-day peer verdict can still say "ok" on frozen history; the status column
 // must read the LIVE feed honesty layer and name the vendor.
 // The array's Status pill is the SHARED FleetStore.arrayStatus — the exact same
 // classifier + label + tone the Sandbox OVERVIEW grid renders, so the spreadsheet
 // and the overview can never disagree about an array (Ford: "the two should show the
 // same information"). down/under (14-day) · asleep · feed behind · watching N (soft
 // cyan live-only) · new · all clear. The vendor-issue breadth Ford added 2026-07-13
 // (stale SolarEdge, dark-while-fleet-peers) lives in arrayStatus's _feedBehind now.
 function arrStatus(c) {
 if (window.FleetStore && FleetStore.arrayStatus) {
 const s = FleetStore.arrayStatus(c);
 return { label: s.label, cls: s.cls, count: s.count, tip: s.tip };
 }
 // Fallback only when FleetStore is absent (isolated render test).
 const a = c.alert || {};
 if (a.level === "critical") return { label: (a.count || 1) + " down", cls: "bad", count: a.count || 1 };
 if (a.level === "warn") return { label: (a.count || 1) + " underperforming", cls: "warn", count: a.count || 1 };
 return { label: "All clear", cls: "ok", count: 0 };
 }
 const _CLS_RANK = { bad: 3, warn: 2, watch: 1, muted: 0, ok: 0 };
 function statusRank(c) {
 const cls = (window.FleetStore && FleetStore.arrayStatus) ? FleetStore.arrayStatus(c).cls : "ok";
 return _CLS_RANK[cls] || 0;
 }
 function invStatus(iv, cohort, isDaylight, parentCol) {
 const s = iv.status || "ok";
 // EXPECTED-LOW (owner-confirmed shading/obstruction): this unit is SUPPOSED to run
 // below its peers, so it reads calm — never "underperforming" — while it holds its
 // baseline. A breach (dropped below the baseline) flips it back to a real warn.
 if (iv.expected_low && !iv.expected_low_breach) {
 const pct = iv.expected_low_baseline != null ? Math.round(iv.expected_low_baseline * 100) : null;
 return { label: "Expected lower", cls: "muted",
 tip: "Marked expected-low" + (iv.expected_low_reason ? " — " + iv.expected_low_reason : "")
 + (pct != null ? ". Held to ~" + pct + "% of peers" : "")
 + "; not a fault. We still alert if it drops below that level." };
 }
 if (iv.expected_low && iv.expected_low_breach) {
 return { label: "Below its baseline", cls: "warn",
 tip: "This unit is marked expected-low, but it has dropped BELOW its established level — a new issue on top of the known shading. Worth a look." };
 }
 // NO ENERGY REGISTER (e.g. Tannery #7): live power but a dead cumulative-energy
 // meter → ungradeable, and its per-inverter power is an unreliable energy-share
 // split. A metering DEFECT at the vendor, not an outage, its own neutral label,
 // never "Stopped"/"Quiet"/a red fault. Checked FIRST so a comm_gap/stale status
 // can't drag it into a warn. Mirrors the card's "No energy data" + the digest.
 if (iv.no_energy_register) return { label: "No energy data", cls: "muted",
 tip: "Reports live power but no cumulative energy, a metering issue at the vendor, not an outage. Can't be peer-graded until the energy register is fixed." };
 // Parent array's feed is behind → don't leave inverters as green "OK" (Londonderry
 // SolarEdge: 6× OK while the source clock is 15h stale). Uses the SAME shared
 // arrayStatus feed detection the array pill shows, so row and array agree, and the
 // SAME soft "watch" (cyan) tone as the array's "Feed behind" pill.
 const _pStat = (parentCol && window.FleetStore && FleetStore.arrayStatus) ? FleetStore.arrayStatus(parentCol) : null;
 if (_pStat && _pStat.key === "feed") {
 return { label: "Feed behind", cls: "watch",
 tip: "The monitoring vendor isn't delivering a usable live feed for this array right now, a data-freshness gap, not an inverter fault we can grade." };
 }
 // LIVE-DARK / LIVE-LOW overlay: an inverter the 14-day verdict calls "ok" but that is
 // dark or >15% below its live peers RIGHT NOW. Shared FleetStore.liveVerdict — same
 // gated classifier as the overview + command center. Deliberately a soft WATCH-level
 // "watch" (cyan), NOT amber: the 14-day health is still fine, so it's momentary/likely
 // brief — the same soft tone the overview's "Watching N" tile uses.
 if (s === "ok" && cohort && window.FleetStore && FleetStore.liveVerdict) {
 const _srcOk = !(_pStat && _pStat.vendorOut);
 const _lv = FleetStore.liveVerdict(iv, cohort, isDaylight, _srcOk);
 if (_lv === "dark") {
 return { label: "Dark now", cls: "watch",
 tip: "Producing nothing right now while its neighbors are, the live anomaly we flagged. Its 14-day output is still healthy, so this is likely a brief outage; if it stays dark into tomorrow the health verdict escalates automatically." };
 }
 if (_lv === "low") {
 return { label: "Low vs peers", cls: "watch",
 tip: "Producing well below its neighbors right now (>15% under the peer median for its nameplate), check for shading, a tripped string, or a failing inverter. Its 14-day health hasn't flagged yet; if the gap persists the verdict escalates." };
 }
 }
 if (s === "dead") return { label: "Stopped", cls: "bad" };
 if (s === "fault") return { label: "Fault", cls: "bad" };
 if (s === "underperforming") return { label: "Underperforming", cls: "warn" };
 if (s === "comm_gap") return { label: "Quiet", cls: "warn" };
 // "Monitoring" = we're tracking it but don't yet have enough peer history to grade
 // it (new device, or a metering channel the vendor isn't populating), so we make
 // no verdict rather than a false "OK"/flag. Spell that out; the bare word is opaque.
 if (s === "monitoring") return { label: "Monitoring", cls: "muted",
 tip: "Tracking this inverter, but not enough peer history yet to grade it, no verdict either way." };
 return { label: "OK", cls: "ok" };
 }
 function _ageMin(c) {
 const h = (c.source_status || {}).age_hours;
 return h == null ? null : h * 60;
 }
 // How recent a reading must be to still count as "live", per vendor. Extension-
 // captured vendors promise a tight cadence (Chint ~4 min, Fronius/SMA ~6); allow
 // ~2x before we call a reading stale. SolarEdge is API-pulled and its lastUpdateTime
 // routinely lags 15-30 min behind a live currentPower, and the BACKEND still serves
 // it as live until 6h (_SOURCE_STALE_HOURS), so match that (360 min) for non-cadence
 // vendors, else a healthy SolarEdge array shows a false "stale"/dimmed reading that
 // contradicts the backend.
 function _liveWindowMin(c) {
 const cad = CADENCE_MIN[(c.vendor || "").toLowerCase()];
 return cad ? cad * 2 : 360;
 }
 // A reading is STALE when it's older than its vendor's live window, i.e. the feed
 // has paused (e.g. the portal session lapsed) and the number on screen is frozen.
 function isStale(c) {
 const a = _ageMin(c);
 return a != null && a >= _liveWindowMin(c);
 }
 function freshness(c) {
 const a = _ageMin(c);
 if (a == null) return "";
 if (a < _liveWindowMin(c)) return "live";
 if (a < 90) return Math.round(a) + " min ago";
 if (a < 1440) return Math.round(a / 60) + "h ago";
 return Math.round(a / 1440) + "d ago";
 }

 // ── Sync recency (OUR capture clock) vs source-data freshness ──────────────
 // The freshness COLUMN shows when WE last captured (sync_status.age_min), which
 // advances on every auto-login / keep-warm / live capture, even overnight when the
 // vendor SOURCE's own clock is frozen because the panels are asleep. So a successful
 // sync is visible the instant it lands, faithfully mirroring the back end. "live"
 // still wins when the source data itself is current; the tooltip spells out BOTH
 // clocks so nothing is ambiguous. (freshness() above stays SOURCE-age, it's the
 // honest "this power reading is from X ago" basis, a different question.)
 // Human age as "... ago" (e.g. "48 min ago", "now"). Fine for "last seen X" /
 // "synced X" but NEVER splice into "in ${age}", that produces "in now" /
 // "in 48 min ago" (Ford screenshot 2026-07-13: "hasn't published new readings
 // in now"). Use _ageSincePhrase for that.
 function _fmtAge(min) {
 if (min == null) return "";
 if (min < 1) return "now";
 if (min < 90) return Math.round(min) + " min ago";
 if (min < 1440) return Math.round(min / 60) + "h ago";
 return Math.round(min / 1440) + "d ago";
 }
 // Duration for "hasn't done X since …" / "last did X …" sentences. Returns a
 // full natural phrase so callers don't glue "in " onto an "… ago" string.
 // 0.3 → "just now"
 // 48 → "48 minutes ago"
 // 90 → "about 2 hours ago"
 // 1500 → "about 1 day ago"
 function _ageSincePhrase(min) {
 if (min == null) return null;
 if (min < 1) return "just now";
 if (min < 90) {
 const m = Math.max(1, Math.round(min));
 return m + (m === 1 ? " minute ago" : " minutes ago");
 }
 if (min < 1440) {
 const h = Math.max(1, Math.round(min / 60));
 return "about " + h + (h === 1 ? " hour ago" : " hours ago");
 }
 const d = Math.max(1, Math.round(min / 1440));
 return "about " + d + (d === 1 ? " day ago" : " days ago");
 }
 function _syncAgeMin(c) { const m = (c.sync_status || {}).age_min; return m == null ? null : m; }
 // Compact age for the narrow freshness column: "now" / "3m" / "2h" / "1d".
 function _fmtAgeShort(min) {
 if (min == null) return "";
 if (min < 1) return "now";
 if (min < 60) return Math.round(min) + "m";
 if (min < 1440) return Math.round(min / 60) + "h";
 return Math.round(min / 1440) + "d";
 }
 // The freshness column is AMBER when the SOURCE data itself is stale (the honest
 // "this data is old" signal, matching the array card's source-age banner) OR when
 // our capture pipeline has fallen behind (~3 keep-warm cycles). Keying the amber on
 // SOURCE staleness is what stops "synced now" from reading fresh beside the card's
 // "last reported 21h ago" (Bruce's contradiction), the two surfaces now agree.
 function syncStale(c) {
 if (isStale(c)) return true; // the vendor's OWN data is stale
 const s = _syncAgeMin(c); return s != null && s >= 30; // our pipeline is behind
 }
 // Freshness label. THE HONEST RULE: never imply the data is fresh ("synced now")
 // while the vendor's own data is stale. When the SOURCE data is current we show
 // "live"; the moment it goes stale we lead with the SOURCE age ("SMA 21h old") —
 // the SAME truth the array card's banner shows, so the spreadsheet and the card
 // can't contradict. Our capture recency ("synced Xm") only shows while the source
 // is NOT stale (a normal overnight pause), so a successful keep-warm sync is still
 // visible without ever masking stale source data as fresh.
 function syncFreshness(c) {
 const src = _ageMin(c), syn = _syncAgeMin(c);
 if (src != null && src < _liveWindowMin(c)) return "live"; // the source data itself is current
 // Source is STALE → lead with SOURCE age (never "synced now"). Column is narrow
 // (especially with EA rail open), so keep the visible label short; full honesty
 // lives in the tooltip via freshTip(). e.g. "21h ago" not "latest data 21h ago".
 if (isStale(c)) {
 return _fmtAgeShort(src) + " ago";
 }
 if (syn != null) return syn < 1 ? "synced now" : "synced " + _fmtAgeShort(syn); // our capture recency (updates every sync)
 if (src != null) return _fmtAgeShort(src) + " ago"; // legacy rows without a sync clock
 return "";
 }
 function freshTip(c) {
 const syn = _syncAgeMin(c), src = _ageMin(c), v = vlabel(c.vendor);
 const parts = [];
 // When the source is stale, LEAD with the source-data age (the honest headline,
 // matching the card) so the tooltip can't read as "all fresh" either. Our capture
 // recency follows as the secondary "we did check recently" reassurance.
 if (src != null && src >= _liveWindowMin(c)) {
 const when = _ageSincePhrase(src) || _fmtAge(src);
 parts.push((syn != null ? "We're syncing this every few minutes, but the " : "The ")
 + v + " portal's own data last updated " + when
 + (c.is_daylight === false ? "; it pauses overnight while the panels aren't producing." : "."));
 return parts.join(" ");
 }
 const synWhen = syn != null ? (_ageSincePhrase(syn) || _fmtAge(syn)) : null;
 parts.push("The " + v + " data is live" + (synWhen ? ", synced " + synWhen : "") + ".");
 return parts.join(" ");
 }
 // Vendor-GROUP sync summary for the collapsed header row (Ford: "the vendor was
 // synced, on the collapsed view, so you can see when without expanding it"). Shows
 // the OLDEST (least-recently-synced) array in the group, not the newest, a lagging
 // array should surface here even while its siblings are fresh, matching this app's
 // "flag problems, don't hide them" rule (same reasoning as syncStale's per-array amber).
 function vendorSyncSummary(list) {
 // If ANY array in the group has stale SOURCE data, the collapsed header must say
 // so, otherwise "Synced 2m" at the group level hides a 21h-stale array inside
 // (same contradiction, one level up). Lead with the oldest stale source age so
 // the collapsed row agrees with both the card and the expanded freshness column.
 const staleSrc = list.map(_ageMin).filter((a, i) => a != null && isStale(list[i]));
 if (staleSrc.length) {
 const oldestSrc = Math.max(...staleSrc);
 const n = staleSrc.length;
 // Long-form duration WITHOUT the "ago" suffix (_fmtAge appends it) so the title
 // reads "…is 21h old", not "…is 21h ago old".
 const longAge = _fmtAge(oldestSrc).replace(/ ago$/, "");
 return {
 // Compact cell label (EA rail + 9-col grid); full sentence stays in title.
 text: _fmtAgeShort(oldestSrc) + " ago",
 stale: true,
 title: (list.length > 1
 ? "We sync these every few minutes, but the " + n + " of " + list.length
 + " arrays' own portals haven't published new readings; the oldest is "
 : "We sync this every few minutes, the latest reading its portal has published is ") + longAge + " old.",
 };
 }
 const ages = list.map(_syncAgeMin).filter(a => a != null);
 if (!ages.length) return null;
 const oldest = Math.max(...ages);
 return {
 // Short form matches per-array cells ("synced 3m") — "Synced 48 min ago" clipped under EA.
 text: oldest < 1 ? "synced now" : "synced " + _fmtAgeShort(oldest),
 stale: oldest >= 30,
 title: (list.length > 1
 ? "Oldest sync among these " + list.length + " arrays: "
 : "Last synced: ") + _fmtAge(oldest) + ".",
 };
 }
 // Vendor-GROUP status rollup for the collapsed header row (Ford: "if one of the
 // inverters is down, if two of the inverters is down per the vendor, we need to
 // figure this out", WITHOUT expanding every array). Sums each array's OWN attention
 // count (arrStatus already resolves inverter-level dark/low/fault down to a per-array
 // label like "2 dark now") rather than re-deriving inverter state a second way, so this
 // can never drift from what expanding the row actually shows.
 // Collapsed vendor-row STATUS: surface the actual issue(s) so the operator can
 // read them WITHOUT expanding (Ford 2026-07-13: "1 issue" hid that it was a
 // Vendor issue; the specific label belongs on the group row).
 // • one type → that label ("Vendor issue", "2 dark now", "Stopped", …)
 // • multi type → compact join ("Vendor issue · Dark now")
 // • all clear → "All clear"
 function vendorStatusSummary(list) {
 let worstCls = "ok";
 const issues = [];
 list.forEach(c => {
 const st = arrStatus(c);
 if (st.cls === "ok" || st.cls === "muted") return; // "muted" = Asleep overnight, not an issue
 // Precedence bad > warn > watch (soft): a live/feed watch must not lift the whole
 // vendor row to amber when nothing is actually a confirmed 14-day problem.
 if (st.cls === "bad") worstCls = "bad";
 else if (st.cls === "warn" && worstCls !== "bad") worstCls = "warn";
 else if (st.cls === "watch" && worstCls !== "bad" && worstCls !== "warn") worstCls = "watch";
 issues.push(st);
 });
 if (!issues.length) return { label: "All clear", cls: "ok", pills: [{ label: "All clear", cls: "ok" }] };

 // Tally by display label (already human-readable from arrStatus).
 const byLabel = {};
 const clsByLabel = {};
 const tipByLabel = {};
 const tips = [];
 issues.forEach(st => {
 const lab = (st.label || "Issue").trim();
 byLabel[lab] = (byLabel[lab] || 0) + 1;
 if (st.cls === "bad") clsByLabel[lab] = "bad";
 else if (clsByLabel[lab] !== "bad") clsByLabel[lab] = st.cls || "warn";
 if (st.tip && !tipByLabel[lab]) tipByLabel[lab] = st.tip;
 if (st.tip) tips.push(st.tip);
 });
 const keys = Object.keys(byLabel);
 // One pill per distinct issue type (Ford 2026-07-15: a single "A · B" string
 // wrapped into two overlapping orange capsules when EA squeezed the table).
 const pills = keys.map(lab => {
 const n = byLabel[lab];
 let label = lab;
 if (n > 1 && !/^\d+\s/.test(lab) && !/^\d+\s*×/i.test(lab)) {
 label = n + " × " + lab;
 }
 if (label.length > 28) label = label.slice(0, 26).replace(/\s+\S*$/, "") + "…";
 return {
 label,
 cls: clsByLabel[lab] || worstCls,
 tip: tipByLabel[lab] || "",
 };
 });
 let label;
 if (keys.length === 1) {
 label = pills[0].label;
 } else {
 label = pills.map(p => p.label).join(" · ");
 }
 if (label.length > 42) label = label.slice(0, 40).replace(/\s+\S*$/, "") + "…";
 return {
 label,
 pills,
 cls: worstCls,
 tip: tips[0] || ("Issues on " + issues.length + " array" + (issues.length === 1 ? "" : "s")),
 };
 }

 /** Render one or more status pills. Multi-issue vendors get separate capsules
  *  so they never wrap into two overlapping half-pills (Ford 2026-07-15). */
 function statusPillsHtml(st) {
 const pills = (st && st.pills && st.pills.length) ? st.pills
  : [{ label: (st && st.label) || "—", cls: (st && st.cls) || "muted", tip: (st && st.tip) || "" }];
 return pills.map(p =>
  `<span class="vs-pill ${esc(p.cls || "muted")}"${p.tip ? ` title="${esc(p.tip)}"` : (st && st.tip && pills.length === 1 ? ` title="${esc(st.tip)}"` : "")}>${esc(p.label)}</span>`
 ).join("");
 }

 // Per-vendor live-refresh cadence (minutes), from the EnergyAgent extension's
 // recapture alarms, surfaced so owners know how far behind real time a reading
 // can be. Chint recaptures every ~4 min; Fronius/SMA every ~6 min.
 // A vendor's own publish cadence, how often ITS inverters push new readings to
 // its portal. The live window is 2x this: within it, the data is as fresh as that
 // vendor gets, so we call it "live". Fronius/Solar.web lags most (some systems push
 // only every ~15-18 min), so a tight window made a healthy Fronius array read stale.
 const CADENCE_MIN = { chint: 4, fronius: 15, sma: 6 };

 // Each vendor's monitoring portal, clicking the vendor name opens it (via the
 // extension when present, so opening it also arms a fresh capture; else a new tab).
 const VENDOR_PORTAL = {
 solaredge: "https://monitoring.solaredge.com/",
 fronius: "https://www.solarweb.com/",
 sma: "https://ennexos.sunnyportal.com/",
 chint: "https://monitor.chintpowersystems.com/",
 enphase: "https://enlighten.enphaseenergy.com/",
 locus: "https://app.locusenergy.com/",
 };

 // Per-vendor sync caveats shown under the group header (vnote). None currently:
 // Chint used to need a manual per-site click, but the extension now walks every
 // site automatically (background refresh + auto-login), so that caveat was removed.
 const SYNC_NOTE = {};

 // True when the EnergyAgent extension is detected on this page, so "Open to sync"
 // routes through it (opening the portal also arms a fresh capture) instead of a plain tab.
 function extPresent() { try { return _extPresent || !!window.__AO_EXT_PRESENT; } catch (_) { return _extPresent; } }

 const _expanded = {}; // array_id -> bool (survives re-renders)
 const _vendorCollapsed = {}; // vendor code -> bool, collapses ALL its arrays at once
 // (Ford: "I have 56 arrays in Chint, I should be able to
 // click next to Chint and collapse all of them")
 const _invByKey = {}; // "array_id:inverter_id" -> {iv, cohort, peers, isDaylight} for the Details modal
 let _sweepBody = null, _sweepIO = null; // gauges sweep up when the sheet scrolls into view (per body build)
 let _query = ""; // search filter (lowercased)

 // Shared y-scale + per-day neighbor average for one array's inverter cohort.
 // ALWAYS in nameplate-normalized units (kWh per kW that day) so a 20 kW and a
 // 10 kW on the same site compare fairly, absolute kWh made the big unit look
 // "healthier" even when both were at the same % of capacity (Ford 2026-07-14).
 function _nameplateKw(iv) {
 const n = iv && iv.nameplate_kw;
 return (typeof n === "number" && isFinite(n) && n > 0) ? n : null;
 }
 function _dayYield(kwh, np) {
 if (kwh == null || np == null || !(np > 0)) return null;
 return kwh / np; // kWh per kW nameplate that calendar day
 }
 function cohortSpark(invs) {
 const byDate = {};
 let peak = 0;
 let anyNorm = false;
 (invs || []).forEach(iv => {
 const np = _nameplateKw(iv);
 if (!np) return;
 (iv.daily || []).forEach(d => {
 if (!d || d.kwh == null) return;
 const y = _dayYield(d.kwh, np);
 if (y == null) return;
 anyNorm = true;
 if (y > peak) peak = y;
 if (d.date == null) return;
 const k = String(d.date);
 const e = byDate[k] || (byDate[k] = { sumY: 0, n: 0 });
 e.sumY += y;
 e.n += 1;
 });
 });
 // Fallback: no nameplates on file → absolute kWh (legacy). Prefer normalized.
 if (!anyNorm) {
 (invs || []).forEach(iv => (iv.daily || []).forEach(d => {
 if (!d || d.kwh == null) return;
 if (d.kwh > peak) peak = d.kwh;
 if (d.date == null) return;
 const k = String(d.date), e = byDate[k] || (byDate[k] = { sumY: 0, n: 0 });
 e.sumY += d.kwh; e.n += 1;
 }));
 return { peak, byDate, unit: "kwh" };
 }
 return { peak, byDate, unit: "kwh_per_kw" };
 }
 // A tiny bar sparkline of an inverter's recent daily yield (last ~14 days).
 // Bars are scaled to the cohort peak of kWh/kW (not raw kWh) so mixed-nameplate
 // sites compare fairly. Dashed line = neighbor average yield that day.
 // Always render N=14 columns (Ford 2026-07-12). A shorter history LEFT-PADS with
 // empty slots so the last real day sits at the far right.
 function _slots14(daily) {
 const pts = (daily || []).filter(d => d && d.kwh != null).slice(-14);
 const pad = 14 - pts.length;
 return pts.length ? Array.from({ length: pad }, () => null).concat(pts) : null;
 }
 function sparkline(daily, cohort, opts) {
 opts = opts || {};
 const cls = opts.cls || "vs-id-spark";
 const slots = _slots14(daily);
 const real = slots ? slots.filter(Boolean) : [];
 if (real.length < 1) return opts.mini
 ? `<span class="vs-inv-nospark" title="A sparkline needs a day of capture">no history yet</span>`
 : `<div class="vs-id-nospark">Not enough history yet, a sparkline needs a day of capture.</div>`;
 const W = opts.w || 240, H = opts.h || 40, N = 14, bw = W / N;
 const np = _nameplateKw({ nameplate_kw: opts.nameplate_kw });
 // Same unit as the cohort peak, or self-scale if this unit has no nameplate.
 const useYield = !!(cohort && cohort.unit === "kwh_per_kw" && np);
 const shareScale = !!(cohort && cohort.peak > 0 && (
 (cohort.unit === "kwh_per_kw" && useYield) ||
 (cohort.unit === "kwh" && !useYield)
 ));
 const valOf = (p) => {
 if (!p || p.kwh == null) return null;
 return useYield ? _dayYield(p.kwh, np) : p.kwh;
 };
 const ownMax = Math.max(...real.map(p => valOf(p) || 0), 0.001);
 const max = shareScale ? cohort.peak : ownMax;
 // Skip empty-day ticks entirely, the tiny gray dashes were visual noise next to
 // real bars and read as data when they aren't (Ford 2026-07-14).
 const bars = slots.map((p, i) => {
 if (!p) return "";
 const v = valOf(p);
 if (v == null) return "";
 const bh = Math.max(1.5, (v / max) * (H - 6));
 return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
 }).join("");
 let peerLine = "";
 // Peer line only when we're on the shared scale (same units as byDate averages).
 const by = shareScale && cohort && cohort.byDate;
 if (by) {
 const xy = slots.map((p, i) => {
 if (!p) return null;
 const e = p.date != null ? by[String(p.date)] : null;
 if (!e || e.n < 2) return null;
 const selfY = valOf(p);
 if (selfY == null) return null;
 const avg = (e.sumY - selfY) / (e.n - 1); // peers only, same unit as bars
 const y = H - Math.max(1.5, (avg / max) * (H - 6));
 return `${(i * bw + bw / 2).toFixed(1)},${y.toFixed(1)}`;
 }).filter(Boolean);
 if (xy.length >= 2) {
 const tip = useYield ? "Neighbor average (kWh per kW)" : "Neighbor average";
 peerLine = `<polyline class="vs-id-peerline" fill="none" points="${xy.join(" ")}"><title>${tip}</title></polyline>`;
 }
 }
 const aria = useYield
 ? "Daily yield (kWh per kW nameplate), last 14 days, vs neighbor average"
 : "Daily output, last 14 days, against the neighbor average";
 return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${aria}">${bars}${peerLine}</svg>`;
 }
 // ── Full-screen inverter detail (Ford + Martin 2026-07-12): each inverter row has a
 // "Details" button that opens a big, interactive 14-column daily-output chart the owner
 // can hover, plus the stats + live diagnosis. Replaces the cramped inline panel; the
 // rows themselves stay aligned to the table grid.
 function _dayLabel(dateStr) {
 if (dateStr == null) return "";
 const s = String(dateStr);
 // Relative "d-N" (N days ago, the sample/demo shape) → resolve to a calendar date.
 const m = s.match(/^d-?(\d+)$/);
 let d;
 if (m) { d = new Date(); d.setDate(d.getDate() - parseInt(m[1], 10)); }
 else { d = new Date(s.length <= 10 ? s + "T00:00:00" : s); if (isNaN(d.getTime())) d = new Date(s); }
 return isNaN(d.getTime()) ? "" : (d.getMonth() + 1) + "/" + d.getDate();
 }
 function _kwhShort(v) { if (v == null) return ""; return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)); }
 function _yieldShort(v) {
 if (v == null) return "";
 if (v >= 10) return v.toFixed(1);
 return v.toFixed(2);
 }
 // Peer average for a day in the chart's unit (kWh/kW when normalized, else kWh).
 function _peerAvgFor(cohort, p, selfY) {
 const by = cohort && cohort.byDate; if (!by || !p || p.date == null) return null;
 const e = by[String(p.date)]; if (!e || e.n < 2) return null;
 if (selfY == null) return null;
 return (e.sumY - selfY) / (e.n - 1);
 }
 // Interactive 14-column chart. Bars = daily kWh per kW nameplate (when known)
 // so mixed capacities share one scale. Tooltips still show absolute kWh.
 function invChartHTML(iv, cohort) {
 const slots = _slots14(iv.daily);
 if (!slots || !slots.filter(Boolean).length)
 return `<div class="vs-dc-nohist">No daily history captured yet, this fills in as we pull each day.</div>`;
 const real = slots.filter(Boolean);
 const np = _nameplateKw(iv);
 const useYield = !!(cohort && cohort.unit === "kwh_per_kw" && np);
 const shareScale = !!(cohort && cohort.peak > 0 && (
 (cohort.unit === "kwh_per_kw" && useYield) ||
 (cohort.unit === "kwh" && !useYield)
 ));
 const valOf = (p) => {
 if (!p || p.kwh == null) return null;
 return useYield ? _dayYield(p.kwh, np) : p.kwh;
 };
 const ownMax = Math.max(...real.map(p => valOf(p) || 0), 0.001);
 const max = shareScale ? cohort.peak : ownMax;
 const W = 720, H = 300, mL = 52, mR = 16, mT = 16, mB = 34;
 const pw = W - mL - mR, ph = H - mT - mB, bw = pw / 14;
 const y = v => mT + ph - Math.max(0, v / max) * ph;
 const axisFmt = useYield ? _yieldShort : _kwhShort;
 const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
 const gy = y(max * f);
 return `<line class="vs-dc-grid" x1="${mL}" y1="${gy.toFixed(1)}" x2="${W - mR}" y2="${gy.toFixed(1)}"/>` +
 `<text class="vs-dc-ylab" x="${mL - 7}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${axisFmt(max * f)}</text>`;
 }).join("");
 const bars = slots.map((p, i) => {
 const x = mL + i * bw;
 if (!p) return `<rect class="vs-dc-bar vs-dc-empty" x="${(x + 2).toFixed(1)}" y="${(mT + ph - 1.5).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="1.5" rx="1"/>`;
 const v = valOf(p);
 if (v == null) return `<rect class="vs-dc-bar vs-dc-empty" x="${(x + 2).toFixed(1)}" y="${(mT + ph - 1.5).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="1.5" rx="1"/>`;
 const by = y(v), bh = mT + ph - by;
 const peer = shareScale ? _peerAvgFor(cohort, p, v) : null;
 let tip = `${_dayLabel(p.date)} · ${_kwhShort(p.kwh)} kWh`;
 if (useYield) {
 tip += ` · ${ _yieldShort(v) } kWh/kW`;
 if (peer != null) tip += ` · peers ${_yieldShort(peer)} kWh/kW`;
 } else if (peer != null) {
 tip += ` · peers ${_kwhShort(peer)} kWh`;
 }
 const lab = (i % 2 === 0 || i === 13) && p.date != null
 ? `<text class="vs-dc-xlab" x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${_dayLabel(p.date)}</text>` : "";
 return `<rect class="vs-dc-bar" x="${(x + 2).toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="2"><title>${esc(tip)}</title></rect>${lab}`;
 }).join("");
 let peerLine = "";
 if (shareScale && cohort && cohort.byDate) {
 const xy = slots.map((p, i) => {
 const selfY = valOf(p);
 const pv = _peerAvgFor(cohort, p, selfY); if (pv == null) return null;
 return `${(mL + i * bw + bw / 2).toFixed(1)},${y(pv).toFixed(1)}`;
 }).filter(Boolean);
 if (xy.length >= 2) {
 peerLine = `<polyline class="vs-dc-peer" points="${xy.join(" ")}"><title>Neighbor average${useYield ? " (kWh per kW)" : ""}</title></polyline>`;
 }
 }
 const aria = useYield
 ? "Daily yield in kWh per kW nameplate, last 14 days"
 : "Daily output, last 14 days";
 return `<svg class="vs-dc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">${grid}${bars}${peerLine}</svg>`;
 }
 // The stats grid for ONE inverter (Live now / vs neighbors / 14-day / range / model / rated).
 function _invStats(iv) {
 const _alloc = isAllocatedPower(iv);
 const _pm = pctOfMax(iv);
 const live = iv.current_power_w != null
 ? `${_alloc ? "~" : ""}${esc(kw(iv.current_power_w))}${_pm ? ` · ${_pm}` : ""}` : "—";
 const stat = (k, v) => (v == null || v === "") ? "" :
 `<div class="vs-dc-stat"><span class="vs-dc-k">${k}</span><span class="vs-dc-v">${v}</span></div>`;
 return [
 stat("Live now", live),
 stat("vs. neighbors", iv.peer_index != null ? esc(iv.peer_index.toFixed(2) + "×") : null),
 stat("14-day output", iv.window_kwh != null ? esc(Math.round(iv.window_kwh).toLocaleString() + " kWh") : null),
 stat("Daily range", (iv.min_kwh != null && iv.peak_kwh != null)
 ? esc(Math.round(iv.min_kwh).toLocaleString() + "–" + Math.round(iv.peak_kwh).toLocaleString() + " kWh") : null),
 stat("Model", iv.model ? esc(iv.model) : null),
 stat("Rated", iv.nameplate_kw != null ? esc(iv.nameplate_kw + " kW") : null),
 ].join("");
 }
 // The inverter detail body: its header + live diagnosis + stats + the 14-day chart.
 function focusHTML(iv, cohort, peers, isDaylight) {
 const _lv = (iv.status === "ok" || iv.status == null) && peers && window.FleetStore && FleetStore.liveVerdict
 ? FleetStore.liveVerdict(iv, peers, isDaylight) : null;
 const diag = _lv === "dark"
 ? `<div class="vs-dc-diag warn">⚠ Dark right now, no output while its neighbors are producing. Its 14-day output is still healthy, so this is likely a brief outage; if it stays dark into tomorrow the verdict escalates.</div>`
 : _lv === "low"
 ? `<div class="vs-dc-diag warn">⚠ Low vs peers right now, producing well below its neighbors (>15% under the peer median for its nameplate). Check for shading, a tripped string, or a failing inverter.</div>`
 : (iv.diagnosis ? `<div class="vs-dc-diag">${esc(iv.diagnosis)}</div>` : "");
 const sub = [iv.model, iv.nameplate_kw != null ? iv.nameplate_kw + " kW" : null, iv.sn ? "SN " + iv.sn : null]
 .filter(Boolean).map(esc).join(" · ");
 return `<div class="vs-dc-head"><h3>${esc(iv.name || iv.sn || "Inverter")}</h3>${sub ? `<span class="vs-dc-sub">${sub}</span>` : ""}</div>
 ${diag}
 <div class="vs-dc-stats">${_invStats(iv)}</div>
 <div class="vs-dc-chartwrap">
 <div class="vs-dc-chart-h">${
 (cohort && cohort.unit === "kwh_per_kw" && _nameplateKw(iv))
 ? "Daily yield · kWh per kW nameplate · last 14 days"
 : "Daily output · kWh · last 14 days"
 }${(cohort && cohort.peak > 0) ? ` <span class="vs-dc-legend">— dashed line: neighbor average (same units)</span>` : ""}</div>
 ${invChartHTML(iv, cohort)}
 </div>`;
 }
 // Build + open the full-screen detail overlay for one inverter: its header + live
 // diagnosis + stats + the 14-day daily-output chart (with the neighbor-average line).
 // The per-inverter "Compare the array" card deck was REMOVED (Ford 2026-07-13, it
 // didn't land); the neighbor comparison still lives in the "vs. neighbors" stat and the
 // dashed average line on the chart.
 function openInvDetail(iv, cohort, peers, isDaylight) {
 const ov = document.createElement("div");
 ov.className = "vs-dc-ov";
 ov.innerHTML =
 `<div class="vs-dc-modal" role="dialog" aria-modal="true" aria-label="Inverter detail">
 <button type="button" class="vs-dc-x" aria-label="Close">✕</button>
 <div class="vs-dc-focus" id="vsDcFocus">${focusHTML(iv, cohort, peers, isDaylight)}</div>
 </div>`;
 const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
 const onKey = e => { if (e.key === "Escape") close(); };
 ov.addEventListener("click", e => { if (e.target === ov) close(); });
 ov.querySelector(".vs-dc-x").addEventListener("click", close);
 document.addEventListener("keydown", onKey);
 document.body.appendChild(ov);
 }
 let _sort = { key: "name", dir: "asc" }; // sort within each vendor group
 // "table" is the product name (was "spreadsheet"); keep reading the old key.
 let _view = (() => {
   try {
     const v = localStorage.getItem("ao_vendor_view") || "table";
     return v === "spreadsheet" ? "table" : v;
   } catch (e) { return "table"; }
 })();

 let _extPresent = false; // EnergyAgent extension detected on this page (routes "Open to sync" through it)
 // Cloud Capture mode (server-side harvest) vs device mode (extension). Shares the
 // Auto-refresh panel's single preference (sandbox.js AR_MODE_KEY). In cloud mode the
 // server refreshes 24/7, so extension-only refresh affordances (per-vendor "Open to
 // sync", tab-opening "Sync all") swap to cloud variants, but "Close all vendor tabs"
 // ALWAYS stays visible: owners still open portals by hand (or leave tabs from a prior
 // device-mode sync) and need a one-click cleanup (Ford 2026-07-13).
 function _cloudMode(){ try { return localStorage.getItem("ao_ar_mode") === "cloud"; } catch(e){ return false; } }
 // Cloud harvest health, pulled from the Auto-refresh vault via sandbox.js's
 // __aoCloudStatus. Per provider we track:
 // fails , harvest_fails (>=3 = login paused; re-enter password)
 // ok , last_harvest_ok (false = last harvest failed, even if fails still 0)
 // Cached 60s; a fresh load re-renders.
 let _cloudHealth = {}, _cloudHealthAt = 0;
 async function _loadCloudHealth(){
 if (!_cloudMode() || typeof window.__aoCloudStatus !== "function") return;
 if (Date.now() - _cloudHealthAt < 60000) return;
 _cloudHealthAt = Date.now();
 try {
 const cs = await window.__aoCloudStatus();
 if (cs && cs.ok && Array.isArray(cs.credentials)) {
 const m = {};
 cs.credentials.forEach(c => {
 const p = (c.provider || "").toLowerCase();
 const prev = m[p] || { fails: 0, ok: true };
 m[p] = {
 fails: Math.max(prev.fails, c.harvest_fails || 0),
 // any credential for this vendor reporting a failed harvest is a problem
 ok: prev.ok && (c.last_harvest_ok !== false),
 };
 });
 _cloudHealth = m;
 renderBody();
 }
 } catch(_) {}
 }
 function _cloudHealthEntry(vendor){ return _cloudHealth[(vendor || "").toLowerCase()] || null; }
 function _cloudLoginFailed(vendor){
 const e = _cloudHealthEntry(vendor);
 return !!(e && e.fails >= 3);
 }
 function _cloudHarvestBad(vendor){
 const e = _cloudHealthEntry(vendor);
 if (!e) return false;
 return e.fails >= 3 || e.ok === false;
 }
 // A stale source is only an ISSUE when it isn't simply overnight, a dark array at
 // night is ASLEEP, not broken (Ford 2026-07-13). A genuine login failure is always an
 // issue; a stale feed in daylight is an issue; a stale feed overnight with a healthy
 // login is just "Asleep" (not counted in the vendor's issue tally, not a warn).
 function _sourceStale(c){
 const ss = c && c.source_status;
 if (ss && ss.state === "stale") return true;
 // Belt for API-polled vendors only (SolarEdge/Locus): age past the 6h backend
 // SOURCE-OFFLINE window even if state wasn't flipped, never green-light a
 // 15h-old SolarEdge clock. Do NOT use the short extension live-window here
 // (Chint ~8 min), a brief capture lag is not a vendor outage.
 const v = ((c && c.vendor) || "").toLowerCase();
 if (v === "solaredge" || v === "locus") {
 const h = ss && ss.age_hours;
 if (h != null && h >= 6) return true;
 }
 return false;
 }
 function _nightAsleep(c){ return _sourceStale(c) && c.is_daylight === false && !(_cloudMode() && _cloudLoginFailed(c.vendor)); }
 function _sourceIssue(c){ return _sourceStale(c) && !_nightAsleep(c); }

 // True when OTHER arrays in the fleet are producing live power right now
 // (used to tell "whole site dark" from "whole fleet asleep / no sun").
 function _fleetPeersProducing(c){
 try {
 const cols = (window.FleetStore && FleetStore.toColumns && (FleetStore.toColumns().columns || [])) || [];
 return cols.some(o =>
 o && o.array_id !== c.array_id
 && o.is_daylight !== false
 && o.current_power_w != null
 && o.current_power_w > 100);
 } catch (_) { return false; }
 }
 // Whole array has no usable live output AND no measured today total.
 function _arrayNoLiveOutput(c){
 const live = c.current_power_w;
 const today = c.produced_today_kwh;
 const liveDead = live == null || live <= 25; // null or ~0 W
 const todayDead = today == null || today <= 0.05; // nothing today
 return liveDead && todayDead;
 }
 // VENDOR ISSUE, the monitoring vendor (SolarEdge / Chint / …) is the problem,
 // not a single inverter fault and not "all clear". Returns a tip string when
 // true, or null when the array is fine / just asleep.
 // Cases (Ford 2026-07-13 screenshot: Londonderry SE "ALL CLEAR" with blank live
 // + Chint at 0 kW while Fronius/SMA produce hundreds of kW):
 // 1. Source clock stale in daylight (SolarEdge site stopped reporting to SE)
 // 2. Cloud harvest failing / login broken for this vendor
 // 3. Whole array dark in daylight while OTHER arrays in the fleet produce —
 // the vendor feed is lying or broken (or the site is offline; either way
 // we must NOT green-badge "All clear")
 function _vendorIssue(c){
 if (!c) return null;
 const vl = vlabel(c.vendor);
 // Overnight with a healthy login is asleep, not a vendor outage.
 if (_nightAsleep(c)) return null;
 if (_sourceIssue(c)) {
 const age = _fmtAge(_ageMin(c));
 return {
 tip: (vl || "The monitoring vendor") + " last reported"
 + (age ? " " + age : "")
 + ", a data outage at the source, not Array Operator. Live data resumes when "
 + (vl || "the vendor") + " reconnects.",
 };
 }
 if (_cloudMode() && c.vendor && _cloudHarvestBad(c.vendor)) {
 if (_cloudLoginFailed(c.vendor)) {
 return { tip: "We can't sign in to " + (vl || "this vendor") + ", the saved password may have changed. Re-enter it in the Credential Vault." };
 }
 return { tip: "The last cloud harvest from " + (vl || "this vendor") + " failed. We're still retrying automatically." };
 }
 // Daylight + no live output + no today kWh + fleet peers ARE producing →
 // this is not "all clear". Name it as a vendor/feed problem so the operator
 // checks the portal rather than trusting a green badge on a dark site.
 if (c.is_daylight !== false && _arrayNoLiveOutput(c) && _fleetPeersProducing(c)) {
 return {
 tip: (vl || "This vendor") + " is reporting no live output for this array while other arrays in your fleet are producing. Check the vendor portal, this is almost certainly a vendor-side feed issue, not a healthy clear site.",
 };
 }
 return null;
 }

 // Column order (Ford 2026-07-16): Vendor first (grouping), then Name, then
 // metrics that line up for vendor / array / inverter rows. Every row MUST emit
 // the same 9 cells (incl. empty placeholders) or Live kW etc. drift sideways.
 // Labels are short so headers never clip to "INVE…".
 const COLS = [
 { key: null, cls: "vs-c-vendor", label: "Vendor", tip: "Monitoring brand (grouping)" },
 { key: "name", cls: "vs-c-name", label: "Name", tip: "Array or inverter name — click to rename" },
 { key: null, cls: "vs-c-gauge", label: "Output", tip: "Live output as % of nameplate" },
 { key: "inv", cls: "vs-c-inv", label: "Units", tip: "Inverter count (array) · peer index (inverter)" },
 { key: "pow", cls: "vs-c-pow", label: "Live kW", tip: "Instant power now (— at night or when feed is offline)" },
 { key: "today", cls: "vs-c-today", label: "Today", tip: "Energy produced today (kWh)" },
 { key: null, cls: "vs-c-spark", label: "14-day", tip: "Daily yield sparkline (last 14 days)" },
 { key: "status", cls: "vs-c-status", label: "Status", tip: "Health: 14-day peer + live anomalies" },
 { key: "fresh", cls: "vs-c-fresh", label: "Synced", tip: "When we last received data" },
 ];
 function sortVal(c, key) {
 switch (key) {
 case "inv": return c.inverter_count || 0;
 case "pow": return c.current_power_w == null ? -1 : c.current_power_w;
 case "today": return c.produced_today_kwh == null ? -1 : c.produced_today_kwh;
 case "status": return statusRank(c);
 case "fresh": { const h = (c.source_status || {}).age_hours; return h == null ? Infinity : h; }
 default: return (c.array_name || "").toLowerCase();
 }
 }
 function sortCols(list) {
 const m = _sort.dir === "desc" ? -1 : 1;
 return list.slice().sort((a, b) => {
 const va = sortVal(a, _sort.key), vb = sortVal(b, _sort.key);
 if (va < vb) return -1 * m;
 if (va > vb) return 1 * m;
 return String(a.array_name || "").localeCompare(String(b.array_name || "")); // stable tiebreak
 });
 }
 function setSort(key) {
 if (!key) return;
 if (_sort.key === key) _sort.dir = _sort.dir === "asc" ? "desc" : "asc";
 else _sort = { key, dir: key === "name" ? "asc" : "desc" }; // numbers default biggest-first
 }
 // Sort an array's INVERTER rows by the active column, so a header click reorders the
 // rows the operator is actually looking at (Ford 2026-07-11, before this the sort only
 // reordered the array-level rows, so with a single array clicking a header "did nothing").
 // Only columns that vary per inverter reorder them; Synced is array-level (uniform across
 // an array's inverters) and Inverters is a count, so those leave the captured order.
 const _INV_SORT_KEYS = { pow: 1, today: 1, status: 1, name: 1 };
 const _INV_STATUS_RANK = { bad: 4, warn: 3, watch: 2, muted: 1, ok: 0 };
 function invSortVal(iv, key, cohort, isDaylight) {
 switch (key) {
 case "pow": return iv.current_power_w == null ? -1 : iv.current_power_w;
 case "today": return iv.produced_today_kwh == null ? -1 : iv.produced_today_kwh;
 case "status": return _INV_STATUS_RANK[invStatus(iv, cohort, isDaylight, /*parent*/null).cls] || 0;
 default: return (iv.name || iv.sn || "").toLowerCase(); // name
 }
 }
 function sortInvs(invs, isDaylight) {
 if (!_INV_SORT_KEYS[_sort.key] || (invs || []).length < 2) return invs;
 const m = _sort.dir === "desc" ? -1 : 1;
 return invs.slice().sort((a, b) => {
 const va = invSortVal(a, _sort.key, invs, isDaylight), vb = invSortVal(b, _sort.key, invs, isDaylight);
 if (va < vb) return -1 * m;
 if (va > vb) return 1 * m;
 return String(a.name || a.sn || "").localeCompare(String(b.name || b.sn || "")); // stable tiebreak
 });
 }
 function invMatch(c, q) {
 return (c.inverters || []).some(iv =>
 ((iv.name || "") + " " + (iv.model || "") + " " + (iv.sn || "")).toLowerCase().includes(q));
 }
 function matches(c, q) {
 if (!q) return true;
 if ((c.array_name || "").toLowerCase().includes(q)) return true;
 if (vlabel((c.vendor || "").toLowerCase()).toLowerCase().includes(q)) return true;
 return invMatch(c, q);
 }

 // ── "Sync all vendors": refresh every vendor with one click ────────────────
 // Each vendor is recaptured through the extension, it opens the portal on the
 // existing signed-in session, grabs fresh readings, and CLOSES the surface itself.
 // Fronius/SMA/SolarEdge ride background tabs; Chint rides its v1.9.77 per-site route
 // walk in a minimized, unfocused popup (ext v1.9.80), so it NO LONGER needs a
 // foreground "open its portal to finish" (which used to pull the operator to the Chint
 // tab). openChint() is kept only as the fallback for older extensions that can't.
 let _syncing = false;
 // Cloud-mode "Refresh from cloud": ask the server to capture every enabled login
 // NOW, then re-pull the fleet so the freshest readings render. No tabs, no
 // extension, the server-side counterpart of Sync-all (Ford 2026-07-11).
 let _cloudRefreshing = false;
 async function cloudRefreshAll(btn) {
 if (_cloudRefreshing) return;
 _cloudRefreshing = true;
 const orig = btn ? btn.innerHTML : "";
 if (btn) { btn.disabled = true; btn.classList.add("vs-syncing"); btn.innerHTML = "↻ Refreshing…"; }
 let queued = 0, ok = false;
 try {
 if (window.__aoCloudRefresh) { const r = await window.__aoCloudRefresh(); ok = !!(r && r.ok); queued = (r && r.queued) || 0; }
 // Re-pull the fleet so the view reflects the server's latest. The forced capture
 // lands within ~90s; the live FleetStore beat then paints it without another click.
 if (window.FleetStore && FleetStore.load) { try { await FleetStore.load(); } catch (_) {} }
 } catch (_) { ok = false; }
 if (btn) btn.innerHTML = ok ? (queued ? `✓ Refreshing ${queued} vendor${queued === 1 ? "" : "s"}…` : "✓ Up to date") : "Couldn't refresh, try again";
 setTimeout(() => { if (btn) { btn.disabled = false; btn.classList.remove("vs-syncing"); btn.innerHTML = orig; } _cloudRefreshing = false; }, 2400);
 }
 function recaptureVendorViaBridge(vendor, timeoutMs = 120000) {
 return new Promise((resolve) => {
 const reqId = "vs-sync-" + vendor + "-" + Date.now();
 let settled = false;
 const onMsg = (e) => {
 if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
 if (e.data.type === "SO_RECAPTURE_DONE" && e.data.reqId === reqId) {
 settled = true; window.removeEventListener("message", onMsg);
 resolve({ ok: !!e.data.ok, captured: !!e.data.captured, error: e.data.error || null });
 }
 };
 window.addEventListener("message", onMsg);
 try { window.postMessage({ type: "SO_RECAPTURE", vendor, reqId }, window.location.origin); }
 catch (_) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "post-failed" }); return; }
 setTimeout(() => { if (!settled) { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
 });
 }
 const openChint = () => { try { window.postMessage({ type: "SO_OPEN_PORTAL", url: VENDOR_PORTAL.chint,
 active: true, provider: "chint", vendor: "chint", reqId: "vs-sync-chint-" + Date.now() }, window.location.origin); } catch (_) {} };
 async function syncAllVendors(btn) {
 if (_syncing) return;
 if (!extPresent()) {
 const o = btn.innerHTML; btn.innerHTML = "Install the EnergyAgent extension to sync";
 setTimeout(() => { btn.innerHTML = o; }, 2600); return;
 }
 // The distinct vendors actually on screen (their per-vendor portal buttons).
 const present = [...new Set([...document.querySelectorAll("#vsBody [data-vportal]")]
 .map(b => b.getAttribute("data-vportal")))].filter(v => VENDOR_PORTAL[v]);
 if (!present.length) return;
 const silent = present.filter(v => v !== "chint");
 const hasChint = present.includes("chint");
 _syncing = true;
 const orig = btn.innerHTML;
 btn.disabled = true; btn.classList.add("on");
 btn.innerHTML = `<span class="vs-spin"></span> Syncing all vendors…`;
 // Prefer the CONCURRENT path: extension v1.9.70+ opens every portal at ONCE and
 // auto-closes each as its data lands. Falls back to one-at-a-time on older versions.
 const concurrent = await tryConcurrentSync(present);
 if (concurrent) {
 // v1.9.104: the sweep is now a VISIBLE, sequential cycle, hidden tabs captured nothing, so
 // the extension opens each vendor's portal in a foreground tab, captures, and returns here
 // when done. Refresh the fleet as readings land AND the moment this tab regains focus.
 btn.innerHTML = `✓ Syncing, opening each portal…`;
 const _reload = () => { try { if (window.FleetStore && FleetStore.load) FleetStore.load(); } catch (_) {} };
 [8000, 20000, 40000, 70000, 110000, 160000].forEach(t => setTimeout(_reload, t));
 const _onVis = () => { if (document.visibilityState === "visible") { _reload(); setTimeout(_reload, 1500); } };
 document.addEventListener("visibilitychange", _onVis);
 setTimeout(() => document.removeEventListener("visibilitychange", _onVis), 200000);
 } else {
 let okCount = 0;
 for (let i = 0; i < silent.length; i++) {
 const v = silent[i];
 btn.innerHTML = `<span class="vs-spin"></span> Syncing ${esc(vlabel(v))}… (${i + 1}/${silent.length})`;
 const r = await recaptureVendorViaBridge(v);
 if (r.ok) okCount++;
 try { if (window.FleetStore && FleetStore.load) FleetStore.load(); } catch (_) {} // surface fresh readings as they land
 }
 if (hasChint) { btn.innerHTML = "Opening Chint to finish…"; openChint(); }
 btn.innerHTML = `✓ Synced ${okCount}/${silent.length}${hasChint ? " · Chint opened" : ""}`;
 }
 setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; btn.classList.remove("on"); _syncing = false; }, 3500);
 }
 // Ask the extension to open ALL vendor portals at once + auto-close (v1.9.70+).
 // Resolves true if the extension acked (concurrent path taken), false → fall back.
 function tryConcurrentSync(vendors) {
 return new Promise((resolve) => {
 const reqId = "vs-syncall-" + Date.now();
 let settled = false;
 const onMsg = (e) => {
 if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
 if (e.data.type === "SO_SYNC_ALL_DONE" && e.data.reqId === reqId) {
 settled = true; window.removeEventListener("message", onMsg); resolve(!!e.data.ok);
 }
 };
 window.addEventListener("message", onMsg);
 try { window.postMessage({ type: "SO_SYNC_ALL", vendors, reqId }, window.location.origin); }
 catch (_) { window.removeEventListener("message", onMsg); resolve(false); return; }
 setTimeout(() => { if (!settled) { window.removeEventListener("message", onMsg); resolve(false); } }, 3000);
 });
 }
 // Close every open vendor portal tab (the extension queries + removes them).
 async function closeVendorTabs(btn) {
 if (!extPresent()) {
 const o = btn.innerHTML; btn.innerHTML = "Needs the EnergyAgent extension";
 setTimeout(() => { btn.innerHTML = o; }, 2400); return;
 }
 const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "Closing…";
 const closed = await new Promise((resolve) => {
 const reqId = "vs-close-" + Date.now();
 const onMsg = (e) => {
 if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
 if (e.data.type === "SO_CLOSE_VENDOR_TABS_DONE" && e.data.reqId === reqId) {
 window.removeEventListener("message", onMsg); resolve(e.data.closed || 0);
 }
 };
 window.addEventListener("message", onMsg);
 try { window.postMessage({ type: "SO_CLOSE_VENDOR_TABS", reqId }, window.location.origin); }
 catch (_) { window.removeEventListener("message", onMsg); resolve(0); return; }
 setTimeout(() => { window.removeEventListener("message", onMsg); resolve(0); }, 4000);
 });
 btn.innerHTML = `✓ Closed ${closed}`;
 setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2400);
 }

 // The monitored-array columns (inverter arrays only), the SAME set rendered in the
 // body, factored out so "Expand all" can iterate every vendor + array (even ones a
 // collapsed vendor hasn't rendered). Pre-query filter; renderBody narrows to matches.
 function _monitoredCols() {
 const data = window.FleetStore ? FleetStore.toColumns() : null;
 return ((data && data.columns) || []).filter(c => {
 const ds = (c && c.daily_split) || {};
 return !!ds.has_vendor || !!(c && c.vendor)
 || (Array.isArray(c && c.vendors) && c.vendors.length > 0)
 || (Array.isArray(c && c.inverters) && c.inverters.length > 0);
 });
 }
 // Is every vendor group + every array currently expanded? (drives the toggle's label)
 function _allExpanded() {
 const cols = _monitoredCols();
 return cols.length > 0 && cols.every(c =>
 _expanded[c.array_id] && !_vendorCollapsed[(c.vendor || "other").toLowerCase()]);
 }
 // Expand (or collapse) EVERY vendor group and array at once, so all inverter rows
 // show with one click (Ford 2026-07-10). Inverter DETAIL panels are left as-is.
 function setAllExpanded(expand) {
 _monitoredCols().forEach(c => {
 _vendorCollapsed[(c.vendor || "other").toLowerCase()] = !expand;
 _expanded[c.array_id] = !!expand;
 });
 renderBody();
 }

 function buildShell(host) {
 const heads = COLS.map(col => {
 const tip = col.tip ? ` title="${esc(col.tip)}"` : "";
 // Name header carries Expand-all so it sits with the hierarchy column.
 if (col.cls === "vs-c-name") {
 const lbl = col.key
 ? `<span class="vs-sortable" data-sort="${col.key}" role="button" tabindex="0" title="${esc(col.tip || ("Sort by " + col.label))}">${col.label}<i class="vs-sc"></i></span>`
 : `<span${tip}>${col.label}</span>`;
 return `<span class="${col.cls} vs-namehead">${lbl}<button type="button" class="vs-expandall" id="vsExpandAll" title="Expand every vendor and array to show all inverters">Expand all</button></span>`;
 }
 if (!col.key) return `<span class="${col.cls}"${tip}>${col.label}</span>`;
 return `<span class="${col.cls} vs-sortable" data-sort="${col.key}" role="button" tabindex="0" title="${esc(col.tip || ("Sort by " + col.label))}">${col.label}<i class="vs-sc"></i></span>`;
 }).join("");
 const _cloud = _cloudMode();
 const _hint = _cloud
 ? `Your vendor data refreshes automatically on our servers, no portal to open, no browser tab needed. Live production stays under 5 minutes old; utility bills refresh daily.`
 : `To refresh a vendor, open its portal, click its <strong>↗ Open to sync</strong> button and sign in. The EnergyAgent extension captures the latest readings automatically.`;
 const _syncLabel = _cloud ? "↻ Refresh from cloud" : "↻ Sync all vendors";
 const _syncTitle = _cloud
 ? "Tells our servers to pull fresh readings from every vendor now, then updates this view, no tabs opened."
 : "Opens each vendor's portal in the background, captures the latest readings, and closes it, one click to refresh every vendor.";
 host.innerHTML = `
 <div class="vs-topbar">
 <div class="vs-headrow"><h2>Table view</h2><div class="vs-sub" id="vsCount"></div>
 <div class="vs-hint">${_hint}</div></div>
 <div class="vs-actions">
 <button type="button" class="vs-addbtn" id="vsAddVendor">+ Add vendor</button>
 <div class="vs-actions-right">
 <button type="button" class="vs-closetabs" id="vsCloseTabs"
 title="Closes every open vendor portal tab (SolarEdge, Fronius, SMA, Chint, utility portals, etc.).">✕ Close all vendor tabs</button>
 <button type="button" class="vs-syncall" id="vsSyncAll"
 title="${_syncTitle}">${_syncLabel}</button>
 </div>
 </div>
 <div class="vs-searchrow"><input type="search" class="vs-search" id="vsSearch"
 placeholder="Search arrays, vendors, or inverters…" autocomplete="off" spellcheck="false"></div>
 </div>
 <div class="vs-scroll" id="vsScroll">
 <div class="vs-table">
 <div class="vs-row vs-colhead">${heads}</div>
 <div id="vsBody"></div>
 </div>
 </div>`;
 const s = host.querySelector("#vsSearch");
 s.value = _query;
 s.addEventListener("input", () => { _query = s.value.trim().toLowerCase(); renderBody(); });
 // "+ Add vendor" → cloud mode adds a SERVER-SIDE login (Credential Vault); device
 // mode opens the SAME add-array modal the Sandbox view uses (one flow) (Ford 2026-07-11).
 const add = host.querySelector("#vsAddVendor");
 if (add) add.onclick = () => {
 if (_cloudMode()) {
 if (window.__aoOpenCredentialVault) window.__aoOpenCredentialVault();
 else location.hash = "#account";
 return;
 }
 if (window.__aoAddArray) window.__aoAddArray();
 else location.hash = "#arrays"; // defensive: sandbox owns the modal
 };
 // "Sync all" → cloud mode forces a fresh server-side capture + re-pulls; device
 // mode opens each vendor's portal through the extension.
 const syncBtn = host.querySelector("#vsSyncAll");
 if (syncBtn) syncBtn.onclick = () => _cloudMode() ? cloudRefreshAll(syncBtn) : syncAllVendors(syncBtn);
 const closeBtn = host.querySelector("#vsCloseTabs");
 if (closeBtn) closeBtn.onclick = () => closeVendorTabs(closeBtn);
 const expBtn = host.querySelector("#vsExpandAll");
 if (expBtn) expBtn.onclick = () => setAllExpanded(!_allExpanded());
 host.querySelectorAll("[data-sort]").forEach(b => {
 const go = () => { setSort(b.getAttribute("data-sort")); renderBody(); };
 b.addEventListener("click", go);
 b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
 });
 }

 // Play the gauge fill/needle sweep ONCE, the moment the sheet first scrolls into view —
 // not on every re-render (that would re-sweep on each expand/refresh) and not silently on
 // load below the fold. Respects reduced-motion. #vsBody is stable across renders, so we
 // observe it once; the `.vs-sweep` class it toggles drives the CSS keyframes on the gauges.
 function armGaugeSweep(body) {
 if (!body || body === _sweepBody) return; // same body already handled, don't re-sweep on re-render
 _sweepBody = body;
 if (_sweepIO) { try { _sweepIO.disconnect(); } catch (e) {} _sweepIO = null; }
 try { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) {}
 const play = () => {
 body.classList.add("vs-sweep");
 setTimeout(() => body.classList.remove("vs-sweep"), 1300);
 };
 if (typeof IntersectionObserver === "undefined") { play(); return; }
 _sweepIO = new IntersectionObserver(ents => {
 if (ents.some(e => e.isIntersecting)) { if (_sweepIO) _sweepIO.disconnect(); _sweepIO = null; play(); }
 }, { threshold: 0.12 });
 _sweepIO.observe(body);
 }
 function renderBody() {
 const body = $("#vsBody");
 if (!body || !window.FleetStore) return;
 // refresh the sort-caret indicators on the persistent header
 document.querySelectorAll("#vendorSheet [data-sort]").forEach(h => {
 const on = h.getAttribute("data-sort") === _sort.key;
 h.classList.toggle("on", on);
 const i = h.querySelector(".vs-sc");
 if (i) i.textContent = on ? (_sort.dir === "asc" ? " ▲" : " ▼") : "";
 });
 const data = FleetStore.toColumns();
 // Vendor-data spreadsheet = INVERTER arrays only. Drop utility-meter-only arrays
 // (GMP/VEC/SmartHub with no inverters / no vendor), they belong to the offtaker +
 // NEPOOL views, not here. (Regression fix: the GMP bill-pull began creating
 // utility-only Array rows that leaked into this grid once the source filter was lost.)
 const all = _monitoredCols();
 const cols = all.filter(c => matches(c, _query));
 // Keep the header's Expand-all / Collapse-all toggle in sync with the live state.
 const _expBtn = document.querySelector("#vsExpandAll");
 if (_expBtn) {
 const allOpen = all.length > 0 && all.every(c =>
 _expanded[c.array_id] && !_vendorCollapsed[(c.vendor || "other").toLowerCase()]);
 _expBtn.textContent = allOpen ? "Collapse all" : "Expand all";
 _expBtn.title = allOpen
 ? "Collapse every vendor and array"
 : "Expand every vendor and array to show all inverters";
 }
 const cnt = $("#vsCount");
 if (cnt) {
 const invShown = cols.reduce((t, c) => t + (c.inverter_count || 0), 0);
 // Reconcile "monitored" against the whole fleet on the SAME line (sim #7: an operator
 // saw "2 monitored" here, "3 billed" on invoices, "4" in reality across tabs and
 // couldn't tell if an array had dropped out). The canonical total is FleetStore's
 // array count (same source Fleet Health's "arrays on file" uses); when it's larger
 // than the monitored subset, say "N monitored of M on file" so nothing looks missing.
 const onFile = (window.FleetStore && FleetStore.snapshot
 && (FleetStore.snapshot().arrays || []).length) || 0;
 const monitoredTxt = onFile > all.length
 ? `${all.length} monitored of ${onFile} on file`
 : `${all.length} monitored array${all.length === 1 ? "" : "s"}`;
 cnt.textContent = _query
 ? `${cols.length} of ${all.length} monitored arrays match "${_query}"`
 : `${monitoredTxt} · ${(data.summary || {}).inverters_total || invShown} inverters`;
 }
 const pending = _pendingFeeds().filter(p => {
 // Still pending if no column for that vendor yet
 return !cols.some(c => (c.vendor || "").toLowerCase() === p.vendor);
 });
 if (!cols.length && !pending.length) {
 _paintedPendingSig = "";
 body.innerHTML = `<div class="vs-empty">${_query ? `No arrays match "${esc(_query)}".` : "No arrays connected yet, hit <b>+ Add vendor</b> above to connect one."}</div>`;
 return;
 }
 // Pending-only (still waiting on first arrays), stable paint, no full remount thrash
 if (!cols.length && pending.length) {
 paintPendingBody(body, pending);
 return;
 }
 const byVendor = {};
 cols.forEach(c => { const v = (c.vendor || "other").toLowerCase(); (byVendor[v] = byVendor[v] || []).push(c); });
 const vendors = Object.keys(byVendor).sort((a, b) => vlabel(a).localeCompare(vlabel(b)));
 let h = "";
 // Pending vendors first (just-connected, user is watching for them).
 // Animate only newly appeared pending vendors.
 const prevSig = _paintedPendingSig;
 pending.forEach(p => {
 const isNew = !prevSig || !prevSig.split("|").includes(p.vendor);
 h += pendingVendorHtml(p, { animate: isNew });
 });
 _paintedPendingSig = _pendingSig(pending);
 vendors.forEach(v => {
 const list = sortCols(byVendor[v]);
 // Honest rollups: sum only arrays that actually carry a reading, and show null → "—"
 // when NONE do (mirroring the array-level rule). The old `|| 0` sum printed a fake
 // "0.0 kW / 0 kWh" on the vendor header while every array row under it read
 // "—" (the overnight contradiction Ford flagged 2026-07-12).
 const _powVals = list.map(c => c.current_power_w).filter(x => x != null);
 const vtot = _powVals.length ? Math.round(_powVals.reduce((t, x) => t + x, 0) * 10) / 10 : null;
 const _todayVals = list.map(c => c.produced_today_kwh).filter(x => x != null);
 const vTodayTot = _todayVals.length ? _todayVals.reduce((t, x) => t + x, 0) : null;
 const _vDay = list.some(c => c.is_daylight !== false); // vendor is in daylight if any array is
 const nInv = list.reduce((t, c) => t + (c.inverter_count || 0), 0);
 // Data syncs when the owner OPENS the vendor portal (signing in there lets the
 // EnergyAgent extension capture the latest readings), that's the reliable path,
 // not a background re-scrape. So the per-vendor chip OPENS the portal.
 const _portal = VENDOR_PORTAL[v];
 // Only the extension-scraped vendors (Chint/Fronius/SMA) sync by opening the portal;
 // SolarEdge is pulled server-side via API, so it needs no "open to sync" prompt.
 // Cloud mode: the server signs in and refreshes on its own, so there's no
 // "Open to sync" portal chip, it would only confuse (Ford 2026-07-11).
 const lagChip = (!_cloudMode() && _portal && CADENCE_MIN[v])
 ? `<button type="button" class="vs-vlag" data-vportal="${esc(v)}" title="Opens your ${esc(vlabel(v))} portal in a new tab. Sign in there and your latest readings sync here automatically, the EnergyAgent extension captures them.">↗ Open ${esc(vlabel(v))} to sync</button>`
 : "";
 // The vendor NAME opens that vendor's portal in a plain NEW TAB (data-vopen), a normal
 // navigation that does NOT route through the extension, so it takes the owner to the
 // vendor site WITHOUT pulling them back to Array Operator. Only the "↗ Open <Vendor> to
 // sync" chip below (data-vportal) uses the extension flow that captures + syncs back here.
 const badge = _portal
 ? `<button type="button" class="vs-vbadge vs-vendor-${esc(v)}" data-vopen="${esc(v)}" title="Open the ${esc(vlabel(v))} portal in a new tab (just visit, won't sync or pull you back here)">${esc(vlabel(v))}</button>`
 : `<span class="vs-vbadge vs-vendor-${esc(v)}">${esc(vlabel(v))}</span>`;
 const vnote = SYNC_NOTE[v] ? `<div class="vs-vnote">ℹ ${esc(SYNC_NOTE[v])}</div>` : "";
 const vAlloc = isAllocatedVendor(v) && vtot != null && vtot > 0;
 const vStatus = vendorStatusSummary(list);
 // Vendors DEFAULT to collapsed (Ford: the spreadsheet should "start much less
 // overwhelming", a fresh view is just the vendor headers, expand what you want).
 // First-seen vendor inits to collapsed; the toggle owns it after. An ACTIVE SEARCH
 // overrides collapse so matching arrays are actually visible (cols is already
 // filtered to matches above, so only vendors that HAVE a match render here).
 if (_vendorCollapsed[v] === undefined) _vendorCollapsed[v] = true;
 const vCollapsed = !_query && !!_vendorCollapsed[v];
 const vSync = vendorSyncSummary(list);
 // The WHOLE header row toggles collapse (Ford: "click anywhere in the row of the
 // vendor and have it expand or collapse, not just this tiny button"). The portal
 // buttons inside (vendor-name [data-vopen], the ↗ "Open to sync" [data-vportal]
 // chip) stopPropagation in their own handlers so a sync-click never also collapses.
 // The header row shares the SAME 7-column grid + column classes as a per-array row
 // (vs-c-name/vendor/inv/pow/today/status/fresh), Ford: collapsed you couldn't see
 // inverter count, live now, today, or status at all, and Synced read cramped against
 // the kW total. Every column is now a real ROLLUP across the vendor's arrays, so the
 // collapsed row reads as a genuine summary, not just a label.
 h += `<div class="vs-vgroup${vCollapsed ? " collapsed" : ""}">
 <div class="vs-row vs-vhead" data-vcollapse="${esc(v)}" role="button" tabindex="0"
 aria-expanded="${!vCollapsed}" title="${vCollapsed ? "Expand" : "Collapse"} every ${esc(vlabel(v))} array">
 <span class="vs-c-vendor"><span class="vs-caret vs-vcollapse-caret" aria-hidden="true">▸</span>${badge}</span>
 <span class="vs-c-name"><span class="vs-vcount">${list.length} array${list.length === 1 ? "" : "s"}</span>${lagChip ? ` ${lagChip}` : ""}</span>
 <span class="vs-c-gauge">${gauge(vendorFrac(list), { idle: !list.some(c => c.is_daylight !== false), label: vlabel(v) + " fleet", statusCls: vStatus.cls, statusLabel: vStatus.label })}</span>
 <span class="vs-c-inv">${nInv}</span>
 <span class="vs-c-pow"${vtot == null ? ` title="${esc(liveEmptyTip(_vDay))}"` : (vAlloc ? ` title="${esc(ARR_ALLOC_TIP(v))}"` : "")}>${vAlloc ? "~" : ""}${kw(vtot)}</span>
 <span class="vs-c-today"${vTodayTot == null ? ` title="${esc(todayEmptyTip(_vDay))}"` : ""}>${kwh0(vTodayTot)}</span>
 <span class="vs-c-spark" aria-hidden="true"></span>
 <span class="vs-c-status">${statusPillsHtml(vStatus)}</span>
 <span class="vs-c-fresh${vSync && vSync.stale ? " vs-stale-syn" : ""}" title="${vSync ? esc(vSync.title) : ""}">${vSync ? esc(vSync.text) : ""}</span>
 </div>${vnote}
 <div class="vs-vgroup-rows"${vCollapsed ? " hidden" : ""}>`;
 list.forEach(c => {
 const st = arrStatus(c);
 // Frozen feed: a reading older than the vendor's live window. Dim the (stale)
 // live number and flag its age so a paused feed never masquerades as current.
 const stale = isStale(c) && c.current_power_w != null;
 const allocArr = isArrayAllocatedPower(c);
 const staleMsg = stale ? `This live number is from ${freshness(c)}, it refreshes on the next auto-sync; open ${vlabel(v)} to refresh now.` : "";
 const powTitle = (allocArr || stale)
 ? ` title="${esc([allocArr ? ARR_ALLOC_TIP(c.vendor) : "", staleMsg].filter(Boolean).join(" "))}"`
 : "";
 const open = !!_expanded[c.array_id] || (!!_query && invMatch(c, _query) && !(c.array_name || "").toLowerCase().includes(_query));
 h += `<button type="button" class="vs-row vs-arr${open ? " open" : ""}" data-arr="${esc(String(c.array_id))}" aria-expanded="${open}">
 <span class="vs-c-vendor"><span class="vs-vchip">${esc(vlabel(v))}</span></span>
 <span class="vs-c-name"><span class="vs-caret">▸</span>${ICON_ARRAY}<span class="vs-editable vs-name-edit" data-edit-arr="${esc(String(c.array_id))}" title="Click to rename this array">${esc(c.array_name || "Array")}</span></span>
 <span class="vs-c-gauge">${gauge(arrFrac(c), { idle: c.is_daylight === false, label: esc(c.array_name || "Array"), statusCls: st.cls, statusLabel: st.label })}</span>
 <span class="vs-c-inv">${c.inverter_count != null ? c.inverter_count : "—"}</span>
 <span class="vs-c-pow${stale ? " vs-stale" : ""}"${c.current_power_w == null ? ` title="${esc(liveEmptyTip(c.is_daylight))}"` : powTitle}>${c.current_power_w == null ? "—" : ((allocArr ? "~" : "") + kw(c.current_power_w))}</span>
 ${(() => { const tp = todayProvenance(c); const _t = c.produced_today_kwh == null ? ` title="${esc(todayEmptyTip(c.is_daylight))}"` : (tp.est ? ` title="${esc(tp.tip)}"` : ""); return `<span class="vs-c-today${tp.est ? " vs-est" : ""}"${_t}>${tp.est ? "~" : ""}${kwh0(c.produced_today_kwh)}${tp.est ? ` <span class="vs-est-tag">est.</span>` : ""}</span>`; })()}
 <span class="vs-c-spark" aria-hidden="true"></span>
 <span class="vs-c-status"><span class="vs-pill ${st.cls}"${st.tip ? ` title="${esc(st.tip)}"` : ""}>${esc(st.label)}</span></span>
 <span class="vs-c-fresh${syncStale(c) ? " vs-stale-syn" : ""}" title="${esc(freshTip(c))}">${esc(syncFreshness(c))}</span>
 </button>`;
 if (open) {
 h += `<div class="vs-inv-wrap">`;
 // Stale feed recovery: when this array's source is paused, give a direct
 // path back to fresh data right where the owner notices it, open the
 // vendor portal (extension re-captures on open). Reuses the existing
 // [data-vportal] click delegation, so no extra handler is wired.
 if (syncStale(c) && _cloudMode()) {
 // Only accuse the password on a REAL login failure. The harvester pauses a
 // login (harvest_fails>=3) when the saved password genuinely stops working;
 // a stale feed with a HEALTHY login is a source/overnight issue, NOT the
 // password (Ford 2026-07-13: it wrongly blamed the password when Fronius was
 // just dark at 3am, harvest_fails=0).
 if (_cloudLoginFailed(v)) {
 h += `<div class="vs-src-recover">
 <span class="vs-src-recover-txt">We can't sign in to ${esc(vlabel(v))}, the saved password may have changed. Re-enter it in your Credential Vault to resume automatic refresh.</span>
 <button type="button" class="vs-src-recover-btn" onclick="window.__aoOpenCredentialVault && window.__aoOpenCredentialVault()">Open Credential Vault</button>
 </div>`;
 } else if (c.is_daylight !== false) {
 // Login is fine; stale during daylight → a calm, honest note. Use the
 // SOURCE data age (when the vendor last published), not our sync age
 // (which can be "now" while the vendor data is 48 min old, Ford's
 // "hasn't published new readings in now" screenshot, 2026-07-13).
 const since = _ageSincePhrase(_ageMin(c)) || _ageSincePhrase(_syncAgeMin(c));
 const when = since || "a while ago";
 h += `<div class="vs-src-recover">
 <span class="vs-src-recover-txt">${esc(vlabel(v))} last published new readings ${esc(when)}, our servers keep checking automatically.</span>
 </div>`;
 }
 // else overnight + login healthy → show nothing (expected pause).
 } else if (syncStale(c) && _portal) {
 const since = _ageSincePhrase(_syncAgeMin(c)) || _ageSincePhrase(_ageMin(c));
 const when = since || "a while ago";
 h += `<div class="vs-src-recover">
 <span class="vs-src-recover-txt">We last synced ${esc(vlabel(v))} ${esc(when)}, auto-sync may need a hand. Open the portal to capture the latest.</span>
 <button type="button" class="vs-src-recover-btn" data-vportal="${esc(v)}">↗ Open ${esc(vlabel(v))} to sync</button>
 </div>`;
 }
 const invs = c.inverters || [];
 if (!invs.length) {
 h += `<div class="vs-inv-empty">No inverters captured for this array yet.</div>`;
 } else {
 const cohortScale = cohortSpark(invs); // shared y-scale across this array's inverters (order-independent)
 sortInvs(invs, c.is_daylight).forEach(iv => {
 const ist = invStatus(iv, invs, c.is_daylight, c);
 const ikey = c.array_id + ":" + iv.inverter_id;
 _invByKey[ikey] = { iv, cohort: cohortScale, peers: invs, isDaylight: c.is_daylight };
 // Name vs. model: many inverters default their name TO the model string, so the
 // sub-line only carries what the name doesn't already say (a distinct model,
 // the nameplate, the serial). Shown inline so the row stays ONE aligned line.
 const _nm = iv.name || iv.sn || "Inverter";
 const _model = iv.model || "";
 const _nameIsModel = _model && _nm.trim().toLowerCase() === _model.trim().toLowerCase();
 // Second line only — never cram model+SN into the primary name (was clipping
 // as "S/N 1912… · STP 20KTL-US-…" mid-glyph, Ford 2026-07-16).
 const _subParts = [
 (_model && !_nameIsModel) ? _model : null,
 iv.nameplate_kw != null ? (iv.nameplate_kw + " kW") : null,
 iv.sn ? ("SN " + iv.sn) : null,
 ].filter(Boolean);
 const _sub = _subParts.map(esc).join(" · ");
 const _al = isAllocatedPower(iv);
 const _live = iv.current_power_w != null ? `${_al ? "~" : ""}${kw(iv.current_power_w)}` : "—";
 const _today = iv.produced_today_kwh != null ? kwh0(iv.produced_today_kwh) : "—";
 // Peer index only when we have one; "—" keeps the Units column aligned.
 const _peer = iv.peer_index != null ? iv.peer_index.toFixed(2) + "×" : "—";
 const _liveTip = _al ? ` title="${esc(ALLOC_TIP(iv.vendor))}"`
 : (iv.current_power_w == null ? ` title="${esc(liveEmptyTip(c.is_daylight))}"` : "");
 const _peerTip = iv.peer_index != null
 ? ` title="14-day peer index vs neighbors (1.00× = median)"`
 : ` title="Peer index needs a few days of history"`;
 // Inverter rows MUST emit all 9 cells (incl. empty Vendor) so Live kW / Today
 // line up under the header — missing Vendor used to shift every column left.
 const _rowspark = sparkline(iv.daily, cohortScale, {
 cls: "vs-inv-rowspark", w: 132, h: 28, mini: true,
 nameplate_kw: iv.nameplate_kw,
 });
 h += `<div class="vs-row vs-inv" data-inv-row="${esc(ikey)}" role="button" tabindex="0" aria-label="Open ${esc(_nm)} performance detail">
 <span class="vs-c-vendor vs-c-vendor-empty" aria-hidden="true"></span>
 <span class="vs-c-name vs-inv-name">${ICON_INVERTER}<span class="vs-inv-name-stack"><span class="vs-editable vs-name-edit" data-edit-inv="${esc(String(iv.inverter_id))}" title="Click to rename this inverter">${esc(_nm)}</span>${_sub ? `<span class="vs-inv-sub" title="${esc(_subParts.join(" · "))}">${_sub}</span>` : ""}</span></span>
 <span class="vs-c-gauge">${gauge(invFrac(iv), { idle: c.is_daylight === false, label: esc(_nm), statusCls: ist.cls, statusLabel: ist.label })}</span>
 <span class="vs-c-inv vs-inv-peercol"${_peerTip}>${esc(_peer)}</span>
 <span class="vs-c-pow${stale ? " vs-stale" : ""}"${_liveTip}>${_live}</span>
 <span class="vs-c-today"${iv.produced_today_kwh == null ? ` title="${esc(todayEmptyTip(c.is_daylight))}"` : ""}>${_today}</span>
 <span class="vs-c-spark"><span class="vs-inv-rowspark-wrap" title="14-day daily yield (kWh per kW nameplate) vs neighbors, fair across different inverter sizes. Click for the full chart.">${_rowspark}</span></span>
 <span class="vs-c-status"><span class="vs-pill ${ist.cls}"${ist.tip ? ` title="${esc(ist.tip)}"` : ""}>${esc(ist.label)}</span></span>
 <span class="vs-c-fresh"><button type="button" class="vs-inv-details" data-inv-detail="${esc(ikey)}" title="Open the full 14-day chart + array comparison">Details →</button></span>
 </div>`;
 });
 }
 h += `</div>`;
 }
 });
 h += `</div></div>`; // close .vs-vgroup-rows, then .vs-vgroup
 });
 body.innerHTML = h;
 armGaugeSweep(body);
 body.querySelectorAll("[data-arr]").forEach(b => b.onclick = () => {
 const id = b.getAttribute("data-arr");
 _expanded[id] = !_expanded[id];
 renderBody();
 });
 // Collapse/expand every array under one vendor at once. The WHOLE header row is the
 // target now (Ford: "click anywhere in the row of the vendor... not just this tiny
 // button"); the portal buttons inside it stopPropagation below so they still work.
 // Keyboard-accessible (Enter/Space), matching the inverter-row affordance.
 body.querySelectorAll("[data-vcollapse]").forEach(b => {
 const go = () => {
 const v = b.getAttribute("data-vcollapse");
 _vendorCollapsed[v] = !_vendorCollapsed[v];
 renderBody();
 };
 b.onclick = go;
 b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
 });
 // "Details" → open the full-screen interactive 14-day chart for that inverter.
 body.querySelectorAll("[data-inv-detail]").forEach(b => {
 const go = (e) => {
 if (e) e.stopPropagation();
 const rec = _invByKey[b.getAttribute("data-inv-detail")];
 if (rec) openInvDetail(rec.iv, rec.cohort, rec.peers, rec.isDaylight);
 };
 b.onclick = go;
 b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
 });
 // The WHOLE inverter row opens the same Details view (Ford 2026-07-13: "re-add the
 // ability to click on the inverter and see the graph"). The editable name swallows its
 // own clicks (wireVsEditable stopPropagation), and the "Details →" button stops
 // propagation too, so neither double-fires. Keyboard: Enter/Space on the row itself.
 body.querySelectorAll("[data-inv-row]").forEach(row => {
 const go = (e) => {
 const rec = _invByKey[row.getAttribute("data-inv-row")];
 if (rec) openInvDetail(rec.iv, rec.cohort, rec.peers, rec.isDaylight);
 };
 row.onclick = go;
 row.onkeydown = (e) => {
 if ((e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); go(e); }
 };
 });
 // The vendor NAME (data-vopen) opens the vendor's portal in a plain new tab, a normal
 // navigation, NOT the extension flow, so it takes the owner to the vendor site WITHOUT
 // pulling them back to Array Operator (even when the extension is installed).
 body.querySelectorAll("[data-vopen]").forEach(btn => btn.onclick = (e) => {
 e.stopPropagation(); // inside the now-clickable vendor header, don't also collapse
 const url = VENDOR_PORTAL[btn.getAttribute("data-vopen")];
 if (url) { try { window.open(url, "_blank", "noopener"); } catch (_) {} }
 });
 // The "↗ Open <Vendor> to sync" chip (data-vportal) opens the portal THROUGH the
 // extension when present (so it also arms a fresh capture and syncs back here);
 // otherwise it falls back to a plain new tab.
 body.querySelectorAll("[data-vportal]").forEach(btn => btn.onclick = (e) => {
 e.stopPropagation(); // inside the now-clickable vendor header, don't also collapse
 const v = btn.getAttribute("data-vportal");
 const url = VENDOR_PORTAL[v];
 if (!url) return;
 if (extPresent()) {
 try {
 window.postMessage({ type: "SO_OPEN_PORTAL", url, active: true, provider: v, vendor: v,
 reqId: "vs-" + Date.now() }, window.location.origin);
 return;
 } catch (_) { /* fall through to a plain open */ }
 }
 try { window.open(url, "_blank", "noopener"); } catch (_) {}
 });
 // Inline rename: click an array or inverter name → edit in place. Persists
 // through FleetStore (→ backend), so the rename also shows in the Sandbox view
 // and survives a reload. stopPropagation keeps the click from toggling the
 // row's expand/collapse.
 body.querySelectorAll("[data-edit-arr]").forEach(node =>
 wireVsEditable(node, "arrays", node.getAttribute("data-edit-arr")));
 body.querySelectorAll("[data-edit-inv]").forEach(node =>
 wireVsEditable(node, "inverters", node.getAttribute("data-edit-inv")));
 }

 // ── Rename (Spreadsheet) ─────────────────────────────────────────────────
 // contenteditable was unreliable: Space got eaten by row key handlers, mid-
 // edit FleetStore re-renders destroyed the caret, and multi-word names were
 // awkward with select-all. Use a real <input type="text"> overlay instead.
 let _vsRenameActive = false;
 try { window.__vsRenameActive = false; } catch (_) {}

 function _normalizeName(s) {
 // Preserve internal spaces (incl. multiple); only trim ends.
 // contenteditable / paste often leaves NBSP — normalize to regular space.
 return String(s == null ? "" : s)
 .replace(/\u00a0/g, " ")
 .replace(/[\u200b\u200c\u200d\ufeff]/g, "") // zero-width junk
 .replace(/\s+$/g, "")
 .replace(/^\s+/g, "");
 }

 function _vsToast(msg, kind) {
 try {
 if (window.__aoToast) return window.__aoToast(msg, kind || "err");
 } catch (_) {}
 // Lightweight fallback
 let t = document.getElementById("vsToast");
 if (!t) {
 t = document.createElement("div");
 t.id = "vsToast";
 t.setAttribute("role", "status");
 t.style.cssText = "position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);" +
 "z-index:9999;padding:.55rem 1rem;border-radius:10px;font:600 13px/1.3 system-ui,sans-serif;" +
 "background:#0f172a;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:min(90vw,28rem);" +
 "opacity:0;transition:opacity .15s";
 document.body.appendChild(t);
 }
 t.textContent = msg;
 t.style.background = kind === "ok" ? "#065f46" : "#0f172a";
 t.style.opacity = "1";
 clearTimeout(t._hide);
 t._hide = setTimeout(() => { t.style.opacity = "0"; }, 3200);
 }

 // Make one name cell editable in place via a text input (spaces + paste work).
 // mousedown/pointerdown/click/keydown are stopped so editing never toggles the
 // enclosing row's expand/collapse or opens inverter Details.
 function wireVsEditable(node, kind, id) {
 if (!node || node._editWired) return;
 node._editWired = true;
 node.setAttribute("tabindex", "0");
 node.setAttribute("role", "button");
 node.setAttribute("aria-label", "Rename " + (kind === "arrays" ? "array" : "inverter"));

 ["mousedown", "pointerdown"].forEach(ev =>
 node.addEventListener(ev, e => e.stopPropagation()));
 node.addEventListener("click", e => {
 e.stopPropagation();
 e.preventDefault();
 if (_vsRenameActive) return;
 beginEdit();
 });
 // Row is keyboard-activatable (Enter/Space); swallow those on the name when
 // idle so focus landing here doesn't open Details / toggle expand.
 node.addEventListener("keydown", e => {
 if (_vsRenameActive) return;
 if (e.key === "Enter" || e.key === " ") {
 e.stopPropagation();
 e.preventDefault();
 beginEdit();
 }
 });

 function beginEdit() {
 if (_vsRenameActive || !node.isConnected) return;
 // Prefer live FleetStore name over DOM text (DOM can lag or include junk)
 let original = node.textContent || "";
 try {
 if (window.FleetStore) {
 if (kind === "arrays" && FleetStore.findArray) {
 const a = FleetStore.findArray(id);
 if (a && a.name) original = a.name;
 } else if (kind === "inverters" && FleetStore.findInv) {
 const hit = FleetStore.findInv(id);
 if (hit && hit.i && hit.i.name) original = hit.i.name;
 }
 }
 } catch (_) {}
 original = _normalizeName(original);

 const input = document.createElement("input");
 input.type = "text";
 input.className = "vs-name-input";
 input.value = original;
 input.setAttribute("aria-label", "Rename");
 input.autocomplete = "off";
 input.spellcheck = true;
 // Size roughly to content so layout doesn't jump
 input.style.width = Math.max(8, Math.min(42, (original.length || 8) + 2)) + "ch";

 _vsRenameActive = true;
 try { window.__vsRenameActive = true; } catch (_) {}
 node.classList.add("vs-editing");
 node.replaceWith(input);
 input.focus();
 // Caret at END so multi-word names are easy to extend (not select-all)
 try {
 const len = input.value.length;
 input.setSelectionRange(len, len);
 } catch (_) {}

 let done = false;
 const finish = (commit) => {
 if (done) return;
 done = true;
 input.removeEventListener("keydown", onKey);
 input.removeEventListener("blur", onBlur);
 input.removeEventListener("input", onInput);

 let val = _normalizeName(input.value);
 // Allow internal spaces; reject empty
 if (commit && val && val !== original) {
 // Put a span back with optimistic name before store notify repaints
 const next = document.createElement("span");
 next.className = node.className.replace(/\bvs-editing\b/g, "").trim();
 if (kind === "arrays") next.setAttribute("data-edit-arr", String(id));
 else next.setAttribute("data-edit-inv", String(id));
 next.title = node.title || "Click to rename";
 next.textContent = val;
 if (input.isConnected) input.replaceWith(next);
 // Re-wire the replacement (render may also replace it shortly)
 try { wireVsEditable(next, kind, id); } catch (_) {}

 if (id != null && id !== "" && window.FleetStore) {
 const ren = kind === "arrays" ? FleetStore.renameArray : FleetStore.renameInverter;
 if (typeof ren === "function") {
 Promise.resolve(ren(id, val)).then((res) => {
 if (res && res.ok === false) {
 _vsToast(res.error || "Couldn't save that name", "err");
 }
 }).catch((err) => {
 _vsToast((err && err.message) || "Couldn't save that name", "err");
 });
 }
 }
 } else {
 // Cancel / empty / unchanged — restore original label
 const next = document.createElement("span");
 next.className = node.className.replace(/\bvs-editing\b/g, "").trim();
 if (kind === "arrays") next.setAttribute("data-edit-arr", String(id));
 else next.setAttribute("data-edit-inv", String(id));
 next.title = node.title || "Click to rename";
 next.textContent = original;
 if (input.isConnected) input.replaceWith(next);
 try { wireVsEditable(next, kind, id); } catch (_) {}
 }

 _vsRenameActive = false;
 try { window.__vsRenameActive = false; } catch (_) {}
 };

 const onKey = e => {
 // Critical: stop Space/Enter from bubbling to the row (which opens Details)
 e.stopPropagation();
 if (e.key === "Enter") {
 e.preventDefault();
 finish(true);
 } else if (e.key === "Escape") {
 e.preventDefault();
 finish(false);
 }
 // Space and all other typing: let the input handle natively
 };
 const onBlur = () => finish(true);
 const onInput = () => {
 // Grow field as the owner types multi-word names
 const n = Math.max(8, Math.min(48, (input.value.length || 8) + 2));
 input.style.width = n + "ch";
 };

 input.addEventListener("keydown", onKey);
 input.addEventListener("blur", onBlur);
 input.addEventListener("input", onInput);
 // Swallow pointer events so parent row never sees them mid-edit
 ["mousedown", "pointerdown", "click"].forEach(ev =>
 input.addEventListener(ev, e => e.stopPropagation()));
 }
 }

 // Size the scroll region to fill the viewport below it, so the column header can
 // stay sticky at its top while the rows scroll. Recomputed on render + window resize.
 function sizeScroll() {
 const sc = $("#vsScroll");
 if (!sc || (sc.closest("[hidden]"))) return; // skip while the sheet is hidden (no layout)
 const top = sc.getBoundingClientRect().top;
 const avail = window.innerHeight - top - 14; // room from the box top to the viewport bottom
 // Fill to the bottom of the screen so the pane is as tall as it can be. BUT when the
 // header eats the viewport (short window / zoomed in), DON'T pin a cramped scroll box —
 // that traps the user in a sliver with no way past it (Ford 2026-07-11). Below a usable
 // threshold, drop the fixed height entirely so the WHOLE page scrolls naturally instead.
 if (avail >= 340) {
 sc.style.height = avail + "px";
 sc.style.overflowY = "auto";
 } else {
 sc.style.height = "auto";
 sc.style.overflowY = "visible";
 }
 }
 // Keep the pane filling the screen bottom as the page scrolls/zooms (rAF-throttled).
 let _sizeRaf = 0;
 function sizeScrollSoon() { if (_sizeRaf) return; _sizeRaf = requestAnimationFrame(() => { _sizeRaf = 0; sizeScroll(); }); }

 function _pendingFeeds() {
 try {
 return (window.__aoPendingFeeds && window.__aoPendingFeeds.list()) || [];
 } catch (e) { return []; }
 }

 function _pendingSig(pending) {
 return (pending || []).map(p => p.vendor).sort().join("|");
 }

 function _waitPhrase(p) {
 const ageSec = Math.max(0, Math.round((Date.now() - (p.at || Date.now())) / 1000));
 // Coarse buckets so the line doesn't thrash every second
 if (ageSec < 20) return "usually under a minute";
 if (ageSec < 75) return "still syncing…";
 return "almost there, large fleets can take a minute";
 }

 function _pendingCopy(p, label) {
 const st = p.status || "connecting";
 if (st === "failed") {
 return p.stuckMsg ||
 `We couldn’t sign into <b>${label}</b> with the saved login. Check the password under Account → Auto-refresh, then save again.`;
 }
 if (st === "stuck") {
 return p.stuckMsg ||
 `Still working on <b>${label}</b>, your login is saved and we keep retrying. Large fleets can take a few minutes.`;
 }
 const wait = _waitPhrase(p);
 return `We got your <b>${label}</b> sign-in, arrays are landing on your account now (<span data-pending-wait>${esc(wait)}</span>). This page updates automatically.`;
 }

 function _pendingStat(p) {
 const st = p.status || "connecting";
 if (st === "failed") return "Login issue";
 if (st === "stuck") return "Still working…";
 return "Connecting…";
 }

 /** Skeleton vendor block while a just-connected portal is still landing.
 * Used for every inverter vendor (SolarEdge, Fronius, SMA, Chint, Locus, AlsoEnergy). */
 function pendingVendorHtml(p, opts) {
 opts = opts || {};
 const label = esc(p.label || (window.__aoPendingFeeds && window.__aoPendingFeeds.labelFor
 ? window.__aoPendingFeeds.labelFor(p.vendor) : null) || p.vendor || "Vendor");
 const st = p.status || "connecting";
 const enterCls = opts.animate === false ? "" : " is-enter";
 const stCls = st === "failed" ? " is-failed" : st === "stuck" ? " is-stuck" : "";
 const skel = st === "failed"
 ? ""
 : `<div class="vs-pending-skel"></div><div class="vs-pending-skel vs-pending-skel-short"></div>`;
 return `<div class="vs-pending${enterCls}${stCls}" data-pending-vendor="${esc(p.vendor)}" data-pending-status="${esc(st)}">
 <div class="vs-pending-head">
 <span class="vs-pending-badge">${label}</span>
 <span class="vs-pending-pulse" aria-hidden="true"></span>
 <span class="vs-pending-stat" data-pending-stat>${esc(_pendingStat(p))}</span>
 </div>
 <div class="vs-pending-body">
 ${skel}
 <p class="vs-pending-copy" data-pending-copy>${_pendingCopy(p, label)}</p>
 </div>
 </div>`;
 }

 /** In-place update of wait copy / status, never remount (avoids enter anim + shimmer restart). */
 function softUpdatePendingCards(root, pending) {
 if (!root || !pending || !pending.length) return false;
 const nodes = root.querySelectorAll("[data-pending-vendor]");
 if (nodes.length !== pending.length) return false;
 for (let i = 0; i < pending.length; i++) {
 if (nodes[i].getAttribute("data-pending-vendor") !== pending[i].vendor) return false;
 }
 pending.forEach((p, i) => {
 const el = nodes[i];
 const st = p.status || "connecting";
 const prev = el.getAttribute("data-pending-status") || "connecting";
 // Status class change needs a light rebuild of that card only
 if (prev !== st) {
 const label = esc(p.label || p.vendor || "Vendor");
 el.setAttribute("data-pending-status", st);
 el.classList.toggle("is-failed", st === "failed");
 el.classList.toggle("is-stuck", st === "stuck");
 const stat = el.querySelector("[data-pending-stat]");
 if (stat) stat.textContent = _pendingStat(p);
 const copy = el.querySelector("[data-pending-copy]");
 if (copy) copy.innerHTML = _pendingCopy(p, label);
 const body = el.querySelector(".vs-pending-body");
 if (body && st === "failed") {
 body.querySelectorAll(".vs-pending-skel").forEach(s => s.remove());
 }
 } else if (st === "connecting") {
 const waitEl = el.querySelector("[data-pending-wait]");
 const phrase = _waitPhrase(p);
 if (waitEl && waitEl.textContent !== phrase) waitEl.textContent = phrase;
 } else {
 const copy = el.querySelector("[data-pending-copy]");
 const label = esc(p.label || p.vendor || "Vendor");
 if (copy && p.stuckMsg) {
 const next = _pendingCopy(p, label);
 if (copy.innerHTML !== next) copy.innerHTML = next;
 }
 }
 el.classList.remove("is-enter");
 });
 return true;
 }

 // Track last painted pending signature so fleet-poll re-renders don't rebuild HTML
 let _paintedPendingSig = "";

 function paintPendingBody(bodyEl, pending, { force } = {}) {
 if (!bodyEl) return;
 const sig = _pendingSig(pending);
 if (!force && sig === _paintedPendingSig && softUpdatePendingCards(bodyEl, pending)) {
 return;
 }
 // If DOM already has the same cards, soft-update even when force is false
 if (!force && softUpdatePendingCards(bodyEl, pending)) {
 _paintedPendingSig = sig;
 return;
 }
 bodyEl.innerHTML = pending.map(p => pendingVendorHtml(p, { animate: _paintedPendingSig !== sig })).join("");
 _paintedPendingSig = sig;
 // Drop enter class after first paint so a later full rebuild stays calm
 requestAnimationFrame(() => {
 bodyEl.querySelectorAll(".vs-pending.is-enter").forEach(el => {
 el.classList.remove("is-enter");
 });
 });
 }

 function render() {
 const host = $("#vendorSheet");
 if (!host || !window.FleetStore) return;
 const data = FleetStore.toColumns();
 const pending = _pendingFeeds();
 if (!((data && data.columns) || []).length) {
 // Spreadsheet is the DEFAULT view, so it renders during the initial fleet load —
 // show a neutral "loading" state, not the misleading "no arrays", until data lands
 // (the FleetStore subscribe re-renders this once the tree arrives).
 const loading = !!(FleetStore.isLoaded && !FleetStore.isLoaded());
 if (pending.length) {
 if (!host.querySelector("#vsSearch")) buildShell(host);
 const bodyEl = host.querySelector("#vsBody");
 if (bodyEl) {
 paintPendingBody(bodyEl, pending);
 } else {
 host.innerHTML = pending.map(p => pendingVendorHtml(p)).join("");
 _paintedPendingSig = _pendingSig(pending);
 }
 const cnt = host.querySelector("#vsCount");
 if (cnt) {
 const txt = "Connecting " + pending.map(p => p.label || p.vendor).join(", ") + "…";
 if (cnt.textContent !== txt) cnt.textContent = txt;
 }
 sizeScroll();
 return;
 }
 _paintedPendingSig = "";
 host.innerHTML = `<div class="vs-empty">${loading ? "Loading your fleet…" : "No arrays connected yet, hit <b>+ Add vendor</b> above to connect one."}</div>`;
 return;
 }
 if (!host.querySelector("#vsSearch")) buildShell(host); // build the persistent shell once
 renderBody();
 sizeScroll();
 // In cloud mode, pull the per-login harvest health so the banner + statuses can tell
 // a real login failure apart from a source pause/overnight (fire-and-forget, cached).
 if (_cloudMode()) void _loadCloudHealth();
 }

 function showView(v) {
 // Accept legacy "spreadsheet" as "table"
 if (v === "spreadsheet") v = "table";
 _view = v;
 try { localStorage.setItem("ao_vendor_view", v); } catch (e) {}
 const sb = $("#sbWrap"), sheet = $("#sheetWrap");
 const segSb = $("#vsSegSandbox"), segSheet = $("#vsSegSheet");
 if (sb) sb.hidden = (v !== "sandbox");
 if (sheet) sheet.hidden = (v !== "table");
 [["sandbox", segSb], ["table", segSheet]].forEach(([name, el]) => {
 if (el) { el.classList.toggle("on", v === name); el.setAttribute("aria-pressed", String(v === name)); }
 });
 if (v === "table" && window.FleetStore) {
 if (!FleetStore.isLoaded()) FleetStore.load();
 render();
 }
 }

 function init() {
 const segSb = $("#vsSegSandbox"), segSheet = $("#vsSegSheet");
 if (!segSb || !segSheet) return;
 segSb.onclick = () => showView("sandbox");
 segSheet.onclick = () => showView("table");
 if (window.FleetStore && FleetStore.subscribe) {
 // Re-render on real fleet changes; skip the high-frequency "live" beat + triage so
 // the body doesn't rebuild every few seconds. renderBody() leaves the search input
 // (in the persistent shell) untouched, so a live refresh never steals focus.
 FleetStore.subscribe((s, kind) => {
 if (_view !== "table" || kind === "live" || kind === "triage") return;
 // Never rebuild the body mid-rename — that kills the input and drops multi-word
 // names mid-type (Ford 2026-07-16).
 if (_vsRenameActive || window.__vsRenameActive) return;
 // While only showing Connecting… skeletons, soft-update, don't rebuild HTML.
 const pending = _pendingFeeds();
 const mon = _monitoredCols();
 if (pending.length && !mon.length) {
 const bodyEl = $("#vsBody");
 if (bodyEl && softUpdatePendingCards(bodyEl, pending)) return;
 }
 if ($("#vsSearch")) renderBody(); else render();
 });
 }
 // Pending vendor cards, only when the vendor set changes (mark/clear/reconcile).
 // Quiet poll ticks no longer fire this event (pending-feeds.js write signature).
 window.addEventListener("ao:pending-feeds", () => {
 if (_view !== "table") return;
 if ($("#vsSearch")) renderBody(); else render();
 });
 // Soft-refresh wait-copy every ~8s without remounting the card
 setInterval(() => {
 if (_view !== "table") return;
 const pending = _pendingFeeds();
 if (!pending.length) return;
 const bodyEl = $("#vsBody");
 if (bodyEl) softUpdatePendingCards(bodyEl, pending);
 }, 8000);
 // Detect the EnergyAgent extension so the Refresh button can re-scrape. so_bridge
 // announces SO_EXTENSION_PRESENT at page load (we may have loaded after it), so we
 // both listen for it AND ask for status to prompt a fresh announce. Belt + the global.
 if (window.__AO_EXT_PRESENT) _extPresent = true;
 window.addEventListener("message", (e) => {
 if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
 if (e.data.type === "SO_EXTENSION_PRESENT" || e.data.type === "SO_STATUS_ACK") _extPresent = true;
 });
 try { window.postMessage({ type: "SO_STATUS_REQUEST", reqId: "vs-detect-" + Date.now() }, window.location.origin); } catch (_) {}
 window.addEventListener("resize", sizeScroll);
 window.addEventListener("scroll", sizeScrollSoon, { passive: true });
 showView(_view);
 }

 window.__aoLoadVendorSheet = function () {
 if (_view === "table" && window.FleetStore) {
 if (!FleetStore.isLoaded()) FleetStore.load();
 render();
 }
 };

 // Expose the canonical freshness check so other surfaces (e.g. the Dashboard's
 // "kW now" production strip in command-center.js) agree with the spreadsheet on
 // which feeds are frozen, a single billing basis for "is this reading stale".
 window.VendorSheet = window.VendorSheet || {};
 window.VendorSheet.isStale = isStale;
 // …and the freshness texts, so those surfaces annotate a frozen reading with the
 // SAME clocks the sheet renders instead of reinventing them: freshness(c) is the
 // source-data age ("this reading is from X ago"), syncFreshness(c) is the capture
 // recency ("live" / "synced Xm").
 window.VendorSheet.freshness = freshness;
 window.VendorSheet.syncFreshness = syncFreshness;

 if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
 else init();
})();
