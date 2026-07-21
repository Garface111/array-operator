/* ============================================================================
 * Energy Agent, voice-first orb + browser driver (Array Operator)
 * Backend: /v1/energy-agent/*
 * ========================================================================== */
(function () {
 "use strict";

 // Build stamp — so "am I on stale code?" is never a guess again. Prints on
 // load and is readable any time via window.__EA_BUILD. Bump BUILD with the
 // ?v= token in index.html. If the console shows an OLD build while voice
 // misbehaves (freestyle lines like "let me think about that" / "I didn't catch
 // that" that are NOT in this code), the tab is stale — reload. (Ford 2026-07-16.)
 var EA_BUILD = "20260721opsWide1";

 // Domain vocabulary fed to the speech-to-text so it transcribes the product's
 // own terms instead of phonetic neighbors ("Array Operator" -> "ray operator",
 // "offtaker" -> "off taker", vendor names, etc.). Ford 2026-07-17.
 var EA_STT_PROMPT =
 "Array Operator is a solar fleet platform; its AI is the Energy Agent. " +
 "Expect these terms: Array Operator, Energy Agent, offtaker, offtakers, " +
 "NEPOOL, REC, RECs, generation report, net metering, solar credit, kWh, " +
 "kW nameplate, inverter, array, fleet, specific yield, SolarEdge, Fronius, " +
 "Chint, SMA, Enphase, Locus, GMP, Green Mountain Power, VEC, SmartHub.";
 try {
 window.__EA_BUILD = EA_BUILD;
 // voice mode is decided below; log it too once VOICE_WEAVE is known.
 console.info("[EnergyAgent] build " + EA_BUILD + " loaded");
 } catch (e) {}

 /**
  * Long turns MUST NOT go through the Netlify proxy.
  *
  * public/_redirects proxies /v1/* -> Railway, and that proxy BUFFERS the
  * upstream response and abandons it at ~26s with a bare "HTTP 504". Measured
  * live 2026-07-16 with one heavy repair question:
  *   through Netlify : 504 @ 28-32s, ZERO bytes delivered (buffered, then binned)
  *   direct to Railway: 200 @ 43s, 9 heartbeats, full tool-grounded answer
  * So the cap is on total duration, not time-to-first-byte — streaming through
  * the proxy does not help. The API already sends
  * `access-control-allow-origin: https://arrayoperator.com`, so the browser can
  * talk to Railway directly (same as the extension and Stripe webhooks do).
  *
  * ONLY the known prod host bypasses. Staging/preview/dev stay same-origin so a
  * preview can never be pointed at the production API by accident.
  */
 var LONG_API_ORIGIN = (function () {
 if (typeof window.__EA_API_ORIGIN === "string") return window.__EA_API_ORIGIN;
 var h = (location.hostname || "").toLowerCase();
 if (h === "arrayoperator.com" || h === "www.arrayoperator.com") {
 return "https://web-production-49c83.up.railway.app";
 }
 return "";
 })();

 var API = {
 session: "/v1/energy-agent/session",
 // These three can outrun the proxy's ~26s cap → go straight to the API.
 chat: LONG_API_ORIGIN + "/v1/energy-agent/chat",
 chatStream: LONG_API_ORIGIN + "/v1/energy-agent/chat-stream",
 voiceConsultStream: LONG_API_ORIGIN + "/v1/energy-agent/voice-consult-stream",
 upload: "/v1/energy-agent/upload",
 confirm: "/v1/energy-agent/confirm",
 realtime: "/v1/energy-agent/realtime-session",
 realtimeCall: "/v1/energy-agent/realtime-call",
 transcript: "/v1/energy-agent/transcript",
 uiResult: "/v1/energy-agent/ui-result",
 budget: "/v1/energy-agent/budget",
 // Operating mind, continuous cognition event stream
 mind: "/v1/energy-agent/mind",
 mindEvents: "/v1/energy-agent/mind/events",
 mindConsume: "/v1/energy-agent/mind/events/consume",
 mindTick: "/v1/energy-agent/mind/tick",
 mindWake: "/v1/energy-agent/mind/wake",
 mindMetrics: "/v1/energy-agent/mind/metrics",
 // Deep mind steers the Realtime mouth (interim lines while tools run)
 mindVoiceSteer: "/v1/energy-agent/mind/voice-steer",
 };

 // Option D (Ford 2026-07-16): Realtime owns live voice; consult_deep_brain → Claude.
 // TEMPORARILY DEFAULT OFF (2026-07-16): the weave leaked GPT's own instruction
 // recitations into chat and blocked audio — reverted to the reliable mouth-only
 // path (brain authors the [SPOKEN] line) while the weave is hardened. Opt back
 // in per-session with window.__EA_VOICE_WEAVE = true.
 var VOICE_WEAVE = (function () {
 try {
 if (typeof window.__EA_VOICE_WEAVE === "boolean") return window.__EA_VOICE_WEAVE;
 } catch (e) {}
 return false;
 })();
 try {
 window.__EA_VOICE_MODE = VOICE_WEAVE ? "weave" : "mouth-only";
 console.info("[EnergyAgent] voice mode: " + window.__EA_VOICE_MODE +
 (VOICE_WEAVE ? "" : " (the mouth cannot author; it only reads driven lines)"));
 } catch (e) {}

 // Live thinking-narration (Ford 2026-07-16): stream the deep brain's real tool
 // calls and speak them out loud AS it works, then the answer. __EA_VOICE_NARRATE
 // = false → single-shot consult (no narration). Only active under the weave.
 var VOICE_NARRATE = (function () {
 try {
 if (typeof window.__EA_VOICE_NARRATE === "boolean") return window.__EA_VOICE_NARRATE;
 } catch (e) {}
 return true;
 })();

 var state = {
 open: false,
 sessionId: null,
 listening: false,
 thinking: false,
 speaking: false,
 pending: null,
 // File / image attachments for the next chat turn
 attachments: [], // {id, filename, mime, size, preview}
 recog: null,
 budget: null,
 brain: null,
 realtimeReady: false,
 // Operating mind (one continuous mind, not agent swarm UI)
 mindSinceId: 0,
 mindPollTimer: null,
 mindBusy: false,
 mindOpenTasks: 0,
 _lastMindSpeak: "",
 _lastMindSpeakAt: 0,
 _mindInjecting: false,
 // GPT Realtime WebRTC
 pc: null,
 dc: null,
 micStream: null,
 audioEl: null,
 voiceMode: "none", // realtime | webspeech | none
 rtResponseActive: false, // track open Realtime response, avoid cancel noise
 greeted: false, // one Realtime greeting per panel session
 _greetingPlaying: false, // protect intro voice from barge-in / mind interrupts
 _sessionUpdated: false, // Realtime session.update applied
 _pendingGreetingText: null,
 _thinkingFillerActive: false, // interim "one second" voice while mind works
 _interimSpoken: false,
 _interimSteerTimer: null,
 touring: false,
 // Speech pipeline, one mouth at a time
 _onSpeakDone: null,
 _speakQueue: Promise.resolve(),
 _speakSeq: 0,
 _lastSpokenPlain: "",
 _speakEndedAt: 0, // ms of last speech-end — echo filter only guards a brief tail after this
 // Mic hold during TTS attack only (guarded barge-in after ~0.5s)
 _micHeldForSpeak: false,
 _unmuteAfterSpeakTimer: null,
 _speakStartedAt: 0,
 // Debounce duplicate ghost transcripts
 _lastUserSaid: "",
 _lastUserSaidAt: 0,
 // Weekly usage meter soft-warn once per panel session
 _budgetWarned: false,
 _budgetExhausted: false,
 // Speaker mute, kill agent voice (Realtime + browser TTS); text still paints.
 // Persisted so it sticks across panel open/close (Ford 2026-07-13).
 voiceMuted: (function () {
 try { return localStorage.getItem("ea_voice_muted") === "1"; } catch (e) { return false; }
 })(),
 // Bumped on every stopVoice/mute so in-flight WebRTC connects abort quietly
 // instead of dumping "signalingState is closed" chat bubbles (Ford 2026-07-14).
 _voiceConnectGen: 0,
 // Abort in-flight chat/LLM turns when user says "stop" (Ford 2026-07-14).
 _turnAbortGen: 0,
 _chatAbort: null,
 // Serializes voice/text turns so double STT events can't start two replies
 _turnBusy: false,
 // Owner barged mid-turn (voice or text) — next packContext flags user_interrupted
 _userInterrupted: false,
 _userInterruptedReason: null,
 _userInterruptedAt: 0,
 // True after we sent response.cancel until audio is confirmed stopped
 _rtCancelPending: false,
 _budgetPollTimer: null,
 // Single-flight session start + history paint (hard-refresh race)
 _sessionPromise: null,
 _historyPainted: false,
 };

 function token() {
 try { return localStorage.getItem("so_session") || ""; } catch (e) { return ""; }
 }
 function authHeaders() {
 var h = { "Content-Type": "application/json" };
 var t = token();
 if (t) h.Authorization = "Bearer " + t;
 return h;
 }
 function signedIn() { return !!token(); }

 function packContext() {
 var sel = null;
 try {
 var ae = document.activeElement;
 if (ae && ae.closest) {
 var card = ae.closest("[data-sub-id], [data-array-id], .rb-offtaker, .ansg-table tr");
 if (card) {
 sel = {
 subId: card.getAttribute("data-sub-id") || null,
 arrayId: card.getAttribute("data-array-id") || null,
 text: (card.innerText || "").slice(0, 200),
 };
 }
 }
 } catch (e) {}
 var hash = location.hash || "#dashboard";
 // Live extension + capture-mode awareness (so the agent doesn't invent "cloud
 // must have the SMA password" when arrays came from extension auto-capture).
 var extPresent = false;
 try {
 extPresent = !!(window.__AO_EXT_PRESENT || window.__aoExtPresent);
 } catch (e) {}
 var captureMode = null;
 try {
 captureMode = localStorage.getItem("ao_ar_mode") || null;
 } catch (e) {}
 var fleetVendors = [];
 var fleetAttentionSnapshot = null;
 try {
 if (window.FleetStore && FleetStore.snapshot) {
 var snap = FleetStore.snapshot() || {};
 var seen = {};
 var attnArrays = [];
 var totals = {
 arrays: 0,
 inverters: 0,
 attention_arrays: 0,
 attention_units_14d: 0,
 attention_units_live: 0,
 };
 (snap.arrays || []).forEach(function (a) {
 if (!a) return;
 totals.arrays += 1;
 var v = String(a.vendor || "").toLowerCase();
 if (v) seen[v] = true;
 var invs = a.inverters || [];
 totals.inverters += invs.length;
 var issues = [];
 invs.forEach(function (inv) {
 if (!inv) return;
 var iv = String(inv.vendor || "").toLowerCase();
 if (iv) seen[iv] = true;
 var st = inv.status || "ok";
 if (st !== "ok" && st !== "monitoring") {
 issues.push({
 name: inv.name || inv.sn || "inverter",
 kind: "health_14d",
 status: st,
 });
 } else if (st === "ok" && FleetStore.liveVerdict) {
 var lv = FleetStore.liveVerdict(inv, invs, a.is_daylight !== false);
 if (lv === "dark" || lv === "low") {
 issues.push({
 name: inv.name || inv.sn || "inverter",
 kind: "live",
 status: lv,
 power_w: inv.current_power_w,
 });
 }
 }
 if (inv.no_energy_register) {
 issues.push({
 name: inv.name || inv.sn || "inverter",
 kind: "meter",
 status: "no_energy_register",
 });
 }
 });
 var srcSt = ((a.source_status || {}).state || "").toLowerCase();
 var isDay = a.is_daylight !== false;
 // Night: overnight source quiet is sleep (matches FleetStore._feedBehind).
 // Only multi-day silence (>36h) is a real overnight data problem.
 var srcAgeH = (a.source_status || {}).age_hours;
 if (srcSt === "stale" || srcSt === "dark" || srcSt === "offline") {
 var ageNum = typeof srcAgeH === "number" ? srcAgeH : parseFloat(srcAgeH);
 if (isDay || (isFinite(ageNum) && ageNum >= 36)) {
 issues.push({
 name: a.name || "array",
 kind: "source",
 status: srcSt,
 age_hours: srcAgeH,
 });
 }
 }
 if (issues.length) {
 var n14 = issues.filter(function (x) { return x.kind === "health_14d"; }).length;
 var nLive = issues.filter(function (x) { return x.kind === "live"; }).length;
 totals.attention_arrays += 1;
 totals.attention_units_14d += n14;
 totals.attention_units_live += nLive;
 attnArrays.push({
 name: a.name,
 vendor: a.vendor || null,
 power_w: a.current_power_w,
 today_kwh: a.produced_today_kwh,
 is_daylight: isDay,
 solar_state: isDay ? "daylight" : "night",
 issue_count: issues.length,
 issues: issues.slice(0, 16),
 });
 }
 });
 fleetVendors = Object.keys(seen);
 // Sort worst-first by issue count
 attnArrays.sort(function (x, y) {
 return (y.issue_count || 0) - (x.issue_count || 0);
 });
 var anyDay = (snap.arrays || []).some(function (a) {
 return a && a.is_daylight !== false;
 });
 fleetAttentionSnapshot = {
 totals: totals,
 attention: attnArrays.slice(0, 24),
 solar_state: anyDay ? "daylight" : "night",
 note:
 "Matches Spreadsheet NEED ATTENTION: 14-day peer health + live dark/low overlays. " +
 "Use this as ground truth for 'how is my fleet' answers. " +
 "When solar_state is night: zero live power is normal sleep — not an outage. " +
 "Overnight source quiet is NOT attention unless age is multi-day.",
 };
 }
 } catch (e) {}
 // Macro/meso mental model for the open tab (server product_map surface_* is deeper)
 var SURFACE_MESO = {
 "#dashboard": {
 macro: "Morning brief, who needs a human today across the fleet.",
 meso: "Scan health tiles, open Needs attention, configure Alerts.",
 surface_topic: "surface_fleet_triage",
 },
 "#arrays": {
 // Legacy hash — Inverters now live under Fleet (#dashboard).
 macro: "Equipment map under Fleet, Tenant→Array→Inverter made visible and rearrangeable.",
 meso: "Scroll past Needs attention; Sandbox spatial vs Table rows; Add array.",
 surface_topic: "surface_inverters",
 },
 "#analysis": {
 macro: "Engineering NOC, weather-expected vs actual, sites, hardware.",
 meso: "Explain yield vs sun; open Trends for multi-year shape.",
 surface_topic: "surface_analysis",
 },
 "#trends": {
 macro: "Long-run portfolio analytics (sub-view of Analysis, not a top tab).",
 meso: "Compare years/arrays; export CSV.",
 surface_topic: "surface_analysis",
 },
 "#reports": {
 macro: "Bill offtakers for solar credits from settled utility bills × share.",
 meso: "Pipeline, rates, offtaker list; Bill audit for GMP share check. Not AO subscription.",
 surface_topic: "surface_invoices",
 },
 "#resources": {
 macro: "Regulatory/market context for credits and rates by state (Analysis sub-view).",
 meso: "Pick state; scan news + REC; open sources.",
 surface_topic: "surface_resources",
 },
 "#ops": {
 macro: "Automated O&M: detect faults, draft outreach, coordinate tech, close on recovery.",
 meso: "HUNGRY for a complete O&M roster in THIS chat. Call list_service_contacts first. On any name/email scrap, upsert_service_contact immediately (needs_confirm=false). Never reply Done. while phone/arrays/extra teammates still unknown — always ask the next missing field.",
 surface_topic: "surface_repairs",
 },
 "#account": {
 macro: "Identity, AO subscription bill, and Auto-refresh data plumbing.",
 meso: "Cloud/device capture, plan, card, offtaker payouts, files.",
 surface_topic: "surface_account",
 },
 };
 var hKey = String(hash || "").toLowerCase();
 if (hKey.charAt(0) !== "#") hKey = "#" + hKey;
 var surface = SURFACE_MESO[hKey] || SURFACE_MESO["#dashboard"] || SURFACE_MESO["#arrays"];

 var ctx = {
 hash: hash,
 tab_label: tabLabel(hash),
 // Always remind the model of live nav labels (hashes are internal only)
 nav_tabs: [
 { label: "Fleet", hash: "#dashboard", note: "Sub-views: Triage · Table · Sandbox" },
 { label: "Analysis", hash: "#analysis", note: "Sub-views: Fleet analysis, Trends, Resources" },
 { label: "Invoices", hash: "#reports" },
 { label: "Marketplace", hash: "#marketplace", note: "Credit Exchange + Array Market" },
 { label: "Repairs", hash: "#ops", note: "Chat-first O&M — hunger for full repair roster; agent watches faults" },
 { label: "Account", hash: "#account" },
 ],
 // 3-level page understanding for this hash (see product_map topic=surface)
 surface: surface,
 product_jobs: [
 "Watch the fleet (Fleet: Triage/Table/Sandbox + Analysis)",
 "Invoice offtakers (Invoices; utility bills × share)",
 "Complete O&M roster + heal down sites (Repairs)",
 ],
 // Extra steer when owner is on Repairs: agent must fill the contact sheet
 repair_roster_drive: (function () {
 var h = String(hash || location.hash || "").toLowerCase();
 if (h.indexOf("#ops") === 0 || h === "#repairs" || h === "#claims") {
 return {
 priority: "high",
 rule:
 "You want a complete O&M roster (name, email, phone, array coverage, other teammates). " +
 "Call list_service_contacts first. Save scraps immediately with upsert_service_contact. " +
 "Never end a turn with only 'Done.' while the roster is incomplete — always ask the next missing field.",
 };
 }
 return null;
 })(),
 path: location.pathname,
 title: document.title,
 selection: sel,
 viewport: { w: innerWidth, h: innerHeight },
 // What is actually rendered right now (cards/chips/tables) — not just tab/hash
 live_ui_digest: buildLiveUiDigest(hash),
 // Mid-turn barge-in: owner interrupted Realtime / prior answer
 user_interrupted: !!state._userInterrupted,
 voice_interrupted: !!state._userInterrupted,
 barge_in: !!state._userInterrupted,
 // Capture / extension ground truth for this browser session
 extension_present: extPresent,
 extension_name: "EnergyAgent",
 capture_mode_client: captureMode,
 fleet_vendors_client: fleetVendors,
 // Live fleet attention (same classifiers as Spreadsheet / sandbox cards)
 fleet_attention_snapshot: fleetAttentionSnapshot,
 capture_paths_reminder: {
 cloud: "Account Auto-refresh 'Store it with us', server holds encrypted portal passwords, harvester 24/7",
 device: "Account Auto-refresh 'Keep it on my computer', passwords in extension vault",
 extension_one_click:
 "Log in with SMA/Fronius/Chint… arms the EnergyAgent extension, opens the vendor site, auto-captures after sign-in, POSTs arrays. Does NOT create a cloud vault login. Fleet SMA arrays with only a Chint cloud login almost always came this way.",
 api_keys: "SolarEdge/Locus/AlsoEnergy API keys, server poll, not portal scrape",
 },
 };
 // Mobile OS: AI is the operating layer (setup checklist → systems overview).
 // Inject live setup/ops context so the brain drives hands-off, not tab tourism.
 try {
 if (typeof window.__aoMobileOsContext === "function") {
 var mos = window.__aoMobileOsContext();
 if (mos && mos.mobile_os) {
 ctx.mobile_os = mos;
 ctx.is_mobile_os_home = !!(
 typeof window.__aoMobileOsIsActive === "function" &&
 window.__aoMobileOsIsActive()
 );
 }
 }
 } catch (e) {}
 // One-shot: clear interrupt flag after packaging so only the next turn sees it
 if (state._userInterrupted) {
   try { state._userInterrupted = false; } catch (e) {}
 }
 return ctx;
 }

 /**
  * Compact digest of ON-SCREEN cards / chips / table rows so the agent can see
  * broken inverter cards, status chips, and table cells the owner is looking at.
  * Prefer data-* attributes + short innerText; cap size hard for the prompt budget.
  */
 function buildLiveUiDigest(hash) {
   var out = {
     hash: hash || (location.hash || ""),
     cards: [],
     chips: [],
     table_rows: [],
     panels: [],
     note: "Visible UI text/status on the active surface — trust for 'what am I looking at'.",
   };
   try {
     var roots = [];
     var activePanel = document.querySelector(".panel.active") || document.querySelector("[data-panel].active");
     if (activePanel) roots.push(activePanel);
     // Sandbox / triage always worth sampling when present
     ["#sandbox", "#sbWrap", "#ftDash", "#vendorSheet", "#panelDashboard", "#panelReports",
      "#panelOps", "#panelAccount", "#analysisRoot", ".cc-root", ".ops-root"].forEach(function (sel) {
       var el = document.querySelector(sel);
       if (el && roots.indexOf(el) < 0) roots.push(el);
     });
     if (!roots.length) roots.push(document.body);

     function pushUnique(arr, item, key) {
       var k = key || JSON.stringify(item);
       if (arr._seen && arr._seen[k]) return;
       if (!arr._seen) arr._seen = {};
       arr._seen[k] = 1;
       arr.push(item);
     }

     var cardSels = [
       "[data-array-id]", "[data-inverter-id]", "[data-inv-id]",
       ".sb-card", ".sb-inv", ".fc-tile", ".cc-row", ".ops-case",
       ".ops-ticket", ".rb-offtaker", ".ansg-table tr",
       "[data-status]", ".inv-card", ".array-card",
     ].join(",");
     var chipSels = [
       ".status-chip", ".pill", ".badge", "[data-tone]",
       ".sb-status", ".fc-pill", ".ops-stage", ".ea-chip",
     ].join(",");

     roots.forEach(function (root) {
       if (!root || !root.querySelectorAll) return;
       // Cards
       try {
         root.querySelectorAll(cardSels).forEach(function (el) {
           if (out.cards.length >= 24) return;
           // Skip hidden
           try {
             var r = el.getBoundingClientRect();
             if (r.width < 4 || r.height < 4) return;
             if (r.bottom < 0 || r.top > (window.innerHeight || 800) + 40) return;
           } catch (e) {}
           var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
           if (!text || text.length < 2) return;
           pushUnique(out.cards, {
             array_id: el.getAttribute("data-array-id") || null,
             inverter_id: el.getAttribute("data-inverter-id") || el.getAttribute("data-inv-id") || null,
             status: el.getAttribute("data-status") || el.getAttribute("data-tone") || null,
             text: text.slice(0, 220),
           }, text.slice(0, 80));
         });
       } catch (e) {}
       // Status chips
       try {
         root.querySelectorAll(chipSels).forEach(function (el) {
           if (out.chips.length >= 20) return;
           var t = (el.innerText || "").replace(/\s+/g, " ").trim();
           if (!t || t.length > 80) return;
           try {
             var r2 = el.getBoundingClientRect();
             if (r2.width < 2 || r2.bottom < 0 || r2.top > (window.innerHeight || 800)) return;
           } catch (e) {}
           pushUnique(out.chips, {
             text: t.slice(0, 60),
             tone: el.getAttribute("data-tone") || el.className || null,
           }, t);
         });
       } catch (e) {}
       // Table body rows (Analysis sites, spreadsheet, invoices)
       try {
         root.querySelectorAll("table tbody tr, .ss-row, .ansg-table tbody tr").forEach(function (tr) {
           if (out.table_rows.length >= 16) return;
           var cells = [];
           tr.querySelectorAll("td, th").forEach(function (td) {
             var c = (td.innerText || "").replace(/\s+/g, " ").trim();
             if (c) cells.push(c.slice(0, 40));
           });
           if (!cells.length) return;
           try {
             var r3 = tr.getBoundingClientRect();
             if (r3.height < 2 || r3.bottom < 0 || r3.top > (window.innerHeight || 800)) return;
           } catch (e) {}
           pushUnique(out.table_rows, { cells: cells.slice(0, 8) }, cells.join("|").slice(0, 100));
         });
       } catch (e) {}
     });

     // Panel headings / empty states
     try {
       document.querySelectorAll(".panel.active h1, .panel.active h2, .panel.active .empty, .panel.active .lede").forEach(function (el) {
         if (out.panels.length >= 6) return;
         var t = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
         if (t) out.panels.push(t);
       });
     } catch (e) {}
   } catch (e) {
     out.error = String(e && e.message || e).slice(0, 80);
   }
   // Drop internal _seen
   delete out.cards._seen;
   delete out.chips._seen;
   delete out.table_rows._seen;
   return out;
 }

 // ── DOM ──────────────────────────────────────────────────────────────────
 function ensureUi() {
 if (document.getElementById("eaPanel")) return;

 // Tab-style control: inject at LEFT of #tabbar (in line with Fleet)
 // Desktop entry point. On mobile this is CSS-hidden; #eaFab is the bubble.
 var tabbar = document.getElementById("tabbar");
 var orb = document.getElementById("eaOrb");
 if (!orb) {
 orb = document.createElement("button");
 orb.type = "button";
 orb.id = "eaOrb";
 orb.className = "tab ea-tab";
 orb.setAttribute("role", "tab");
 orb.setAttribute("aria-label", "Open Energy Agent");
 orb.title = "Energy Agent, click to talk";
 orb.innerHTML =
 '<span class="ea-tab-ic" aria-hidden="true"></span>' +
 '<span class="ea-tab-label">Energy Agent</span>' +
 '<span class="ea-pro-badge" id="eaProBadgeTab" hidden></span>';
 if (tabbar) {
 tabbar.insertBefore(orb, tabbar.firstChild);
 } else {
 // Fallback if tabbar not present yet
 var rootF = document.createElement("div");
 rootF.id = "eaRoot";
 rootF.className = "ea-floating";
 rootF.appendChild(orb);
 document.body.appendChild(rootF);
 }
 } else if (orb && !document.getElementById("eaProBadgeTab")) {
 var b1 = document.createElement("span");
 b1.className = "ea-pro-badge";
 b1.id = "eaProBadgeTab";
 b1.hidden = true;
 orb.appendChild(b1);
 }

 // Mobile floating chat bubble, follows the user (position:fixed). Collapses
 // the open sheet; expands it. Desktop CSS hides this node.
 if (!document.getElementById("eaFab")) {
 var fab = document.createElement("button");
 fab.type = "button";
 fab.id = "eaFab";
 fab.setAttribute("aria-label", "Open Energy Agent");
 fab.title = "Energy Agent, chat";
 fab.innerHTML =
 '<span class="ea-fab-ic" aria-hidden="true"></span>' +
 '<span class="ea-fab-label">Energy Agent</span>' +
 '<span class="ea-pro-badge" id="eaProBadgeFab" hidden></span>';
 document.body.appendChild(fab);
 } else if (!document.getElementById("eaProBadgeFab")) {
 var b2 = document.createElement("span");
 b2.className = "ea-pro-badge";
 b2.id = "eaProBadgeFab";
 b2.hidden = true;
 document.getElementById("eaFab").appendChild(b2);
 }

 // Dim page while chat sheet is open on mobile (tap to collapse)
 if (!document.getElementById("eaBackdrop")) {
 var bd = document.createElement("button");
 bd.type = "button";
 bd.id = "eaBackdrop";
 bd.setAttribute("aria-label", "Close Energy Agent");
 bd.tabIndex = -1;
 document.body.appendChild(bd);
 }

 // Mic gate + left-rail panel live on body (fixed)
 var gate = document.getElementById("eaMicGate");
 if (!gate) {
 gate = document.createElement("button");
 gate.type = "button";
 gate.id = "eaMicGate";
 gate.className = "ea-mic-gate";
 gate.hidden = true;
 gate.innerHTML =
 '<span class="ea-mic-gate-ic" aria-hidden="true">🎙</span>' +
 '<span class="ea-mic-gate-txt">Allow microphone</span>';
 document.body.appendChild(gate);
 }

 var panel = document.createElement("div");
 panel.id = "eaPanel";
 panel.setAttribute("role", "dialog");
 panel.setAttribute("aria-label", "Energy Agent");
 panel.innerHTML =
 ' <div class="ea-head">' +
 ' <div><h3>Energy Agent</h3></div>' +
 ' <button type="button" class="ea-x" id="eaClose" aria-label="Close">×</button>' +
 " </div>" +
 ' <div class="ea-tools" id="eaTools" hidden aria-hidden="true"></div>' +
 ' <div class="ea-tour-cap" id="eaTourCap" hidden>' +
 ' <span class="ea-tour-kicker" id="eaTourKicker">Tour</span>' +
 ' <span id="eaTourCapText"></span></div>' +
 ' <div class="ea-msgs" id="eaMsgs"></div>' +
 ' <div class="ea-pending" id="eaPending" hidden></div>' +
 // Site-improve compose (screenshot markup → describe → judge pipeline)
 ' <div class="ea-improve" id="eaImprove" hidden>' +
 ' <div class="ea-improve-head"><b>Improve this site</b>' +
 ' <button type="button" class="ea-improve-x" id="eaImproveCancel" aria-label="Cancel improve">×</button></div>' +
 ' <p class="ea-improve-lead" id="eaImproveLead">Circle the spot on the page, then describe the change.</p>' +
 ' <div class="ea-improve-thumb" id="eaImproveThumb" hidden>' +
 ' <img id="eaImproveImg" alt="Your marked screenshot">' +
 ' <button type="button" id="eaImproveRemark">Re-circle</button></div>' +
 ' <textarea id="eaImproveText" rows="3" maxlength="1600" placeholder="Describe the change, or let Energy Agent fill this from your ask"></textarea>' +
 ' <div class="ea-improve-row">' +
 ' <button type="button" class="ea-improve-mark" id="eaImproveMark">Circle the spot</button>' +
 ' <button type="button" class="ea-improve-send" id="eaImproveSend">Build this →</button>' +
 ' </div>' +
 ' <div class="ea-improve-msg" id="eaImproveMsg"></div>' +
 " </div>" +
 ' <div class="ea-journey" id="eaJourney" hidden role="status" aria-live="polite"></div>' +
 ' <div class="ea-footer">' +
 // Status sits ABOVE the input so voice-off / thinking / mind is always in view
 ' <div class="ea-status ea-status-dock" role="status" aria-live="polite">' +
 ' <i class="ea-dot" id="eaDot"></i>' +
 ' <span id="eaStatusText">Ready</span>' +
 ' <span class="ea-mind" id="eaMind" hidden title="Background work, still one mind">' +
 ' <i class="ea-mind-pulse" aria-hidden="true"></i>' +
 ' <span id="eaMindText">Working…</span></span>' +
 ' <span class="ea-budget" id="eaBudget" aria-label="Weekly AI usage">' +
 ' <span class="ea-usage ea-usage-ok">' +
 ' <span class="ea-usage-label">Weekly</span>' +
 ' <span class="ea-usage-track" aria-hidden="true">' +
 ' <span class="ea-usage-fill" id="eaUsageFill" style="width:0%"></span>' +
 ' </span>' +
 ' </span>' +
 ' </span>' +
 ' </div>' +
 ' <div class="ea-compose" id="eaCompose">' +
 ' <div class="ea-attach-row" id="eaAttachRow" hidden></div>' +
 ' <div class="ea-compose-shell">' +
 ' <textarea id="eaInput" rows="1" placeholder="Message Energy Agent"></textarea>' +
 ' <input type="file" id="eaFile" multiple accept="image/*,.pdf,.txt,.md,.csv,.json,.xlsx,.xls,.log" hidden />' +
 ' <div class="ea-compose-bar">' +
 // Icon-only chips (labels cut off in the rail). Hover/title + aria-label carry
 // the name; Send keeps written label (Ford 2026-07-16).
 ' <button type="button" class="ea-chip ea-attach ea-chip-icon" id="eaAttach" title="Attach a file or image" aria-label="Attach a file or image">' +
 ' <span class="ea-chip-ic ea-chip-ic-svg" aria-hidden="true">' +
 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
 'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
 '<path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.5 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/>' +
 '</svg></span><span class="ea-chip-lbl">Attach</span></button>' +
 ' <button type="button" class="ea-chip ea-chip-icon" id="eaImproveOpen" title="Improve this site — mark up and ship a small change" aria-label="Improve this site">' +
 ' <span class="ea-chip-ic" aria-hidden="true">✦</span><span class="ea-chip-lbl">Improve</span></button>' +
 ' <button type="button" class="ea-chip ea-mic ea-chip-icon" id="eaMic" title="Turn microphone on" aria-label="Microphone">' +
 ' <span class="ea-chip-ic ea-chip-ic-svg" aria-hidden="true">' +
 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
 'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
 '<rect x="9" y="2.5" width="6" height="11" rx="3"/>' +
 '<path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/>' +
 '<path d="M12 17v4.5"/><path d="M8.5 21.5h7"/>' +
 '</svg></span><span class="ea-chip-lbl">Mic</span></button>' +
 ' <button type="button" class="ea-chip ea-mute ea-chip-icon" id="eaMute" title="Mute agent voice" aria-label="Mute agent voice">' +
 ' <span class="ea-chip-ic" aria-hidden="true">🔊</span><span class="ea-chip-lbl">Mute</span></button>' +
 ' <button type="button" class="ea-chip ea-screen ea-chip-icon" id="eaScreenBtn" title="Let Energy Agent see your screen" aria-label="Let Energy Agent see your screen" aria-pressed="false">' +
 ' <span class="ea-chip-ic" aria-hidden="true">👁</span><span class="ea-chip-lbl">See screen</span></button>' +
 ' <span class="ea-compose-spacer"></span>' +
 ' <button type="button" class="ea-send" id="eaSend" title="Send message" aria-label="Send message">' +
 ' <span class="ea-send-lbl">Send</span><span class="ea-send-ic" aria-hidden="true">↑</span></button>' +
 ' </div>' +
 ' </div>' +
 ' </div>' +
 // ea-legal footer removed (Ford 2026-07-15): "Only your account · one mind ·
 // $0.45/win · tasks ok · updates useful" read as noise under the composer.
 ' </div>';
 document.body.appendChild(panel);

 // Lightweight marker root for status hooks that still look for #eaRoot
 if (!document.getElementById("eaRoot")) {
 var root = document.createElement("div");
 root.id = "eaRoot";
 root.setAttribute("aria-hidden", "true");
 root.style.cssText = "display:none";
 document.body.appendChild(root);
 }

 orb.onclick = function (e) {
 e.preventDefault();
 e.stopPropagation();
 toggle(); // async; mic requested first inside toggle (user gesture)
 };
 var fabEl = document.getElementById("eaFab");
 if (fabEl) {
 fabEl.onclick = function (e) {
 e.preventDefault();
 e.stopPropagation();
 toggle();
 };
 }
 var backdrop = document.getElementById("eaBackdrop");
 if (backdrop) {
 backdrop.onclick = function (e) {
 e.preventDefault();
 setOpen(false); // collapse chat sheet → bubble stays
 };
 }
 gate.onclick = function (e) {
 e.preventDefault();
 e.stopPropagation();
 requestMicFromClick();
 };
 // Close X — must always dismiss the side rail (stopPropagation so nothing
 // re-opens; larger hit target in CSS). Ford 2026-07-21: button looked dead.
 var eaCloseBtn = document.getElementById("eaClose");
 if (eaCloseBtn) {
 eaCloseBtn.onclick = function (e) {
 if (e) { e.preventDefault(); e.stopPropagation(); }
 setOpen(false);
 };
 }
 // Escape always closes the dock (desktop + mobile sheet)
 if (!window.__eaEscWired) {
 window.__eaEscWired = true;
 document.addEventListener("keydown", function (e) {
 if (e.key !== "Escape") return;
 if (!state.open) return;
 // Don't steal Escape from nested modals/detail sheets with higher priority
 try {
 if (document.querySelector(".vs-dc-open, .sb-ov.show, .rb-modal.open, [aria-modal='true']")) return;
 } catch (e2) {}
 e.preventDefault();
 setOpen(false);
 }, true);
 }
 document.getElementById("eaSend").onclick = sendText;
 document.getElementById("eaMic").onclick = function (e) {
 e.preventDefault();
 toggleMic();
 };
 document.getElementById("eaMute").onclick = function (e) {
 e.preventDefault();
 setVoiceMuted(!state.voiceMuted);
 };
 var screenBtn = document.getElementById("eaScreenBtn");
 if (screenBtn) {
 screenBtn.onclick = function (e) {
 e.preventDefault();
 if (screenVisionLive()) { stopScreenVision(); }
 else {
 grantScreenVision().then(function (ok) {
 if (ok) addMsg("agent", "I can see your screen now. Ask me about anything on it, or say “take a look.”");
 });
 }
 };
 }
 syncScreenBtn();
 syncMuteBtn();
 syncMicBtn();
 applyVoiceMuteToAudio();
 wireEaAttachments();
 var eaIn = document.getElementById("eaInput");
 eaIn.addEventListener("keydown", function (e) {
 if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
 });
 // Auto-grow the composer: one clean line at rest, grows with content (~5 max)
 function growInput() {
 eaIn.style.height = "auto";
 var h = Math.min(120, Math.max(40, eaIn.scrollHeight));
 eaIn.style.height = h + "px";
 }
 eaIn.addEventListener("input", growInput);
 setTimeout(growInput, 0);
 // Site improve (merged "Wish this was better")
 document.getElementById("eaImproveOpen").onclick = function (e) {
 e.preventDefault();
 openImproveFlow({ markFirst: true });
 };
 document.getElementById("eaImproveCancel").onclick = function () { closeImproveCompose(); };
 document.getElementById("eaImproveMark").onclick = function () { launchMarkCapture(); };
 document.getElementById("eaImproveRemark").onclick = function () { launchMarkCapture(); };
 document.getElementById("eaImproveSend").onclick = function () { submitImprove(); };
 document.getElementById("eaImproveText").addEventListener("keydown", function (e) {
 if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitImprove(); }
 });
 }

 function escHtml(s) {
 return String(s == null ? "" : s)
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
 }

 /** Attach / drag-drop / paste images into EA chat for agent analysis. */
 function wireEaAttachments() {
 var attachBtn = document.getElementById("eaAttach");
 var fileInput = document.getElementById("eaFile");
 if (attachBtn && fileInput && !attachBtn._wired) {
 attachBtn._wired = true;
 attachBtn.onclick = function (e) {
 e.preventDefault();
 fileInput.click();
 };
 fileInput.onchange = function () {
 var files = fileInput.files;
 if (!files || !files.length) return;
 for (var i = 0; i < files.length; i++) eaUploadFile(files[i]);
 fileInput.value = "";
 };
 }
 var panel = document.getElementById("eaPanel");
 var compose = document.getElementById("eaCompose");
 var dropTargets = [panel, compose].filter(Boolean);
 dropTargets.forEach(function (el) {
 if (el._dropWired) return;
 el._dropWired = true;
 ["dragenter", "dragover"].forEach(function (ev) {
 el.addEventListener(ev, function (e) {
 e.preventDefault();
 e.stopPropagation();
 el.classList.add("ea-drop-hot");
 if (compose) compose.classList.add("ea-drop-hot");
 });
 });
 ["dragleave", "drop"].forEach(function (ev) {
 el.addEventListener(ev, function (e) {
 e.preventDefault();
 e.stopPropagation();
 el.classList.remove("ea-drop-hot");
 if (compose) compose.classList.remove("ea-drop-hot");
 });
 });
 el.addEventListener("drop", function (e) {
 var dt = e.dataTransfer;
 if (!dt || !dt.files || !dt.files.length) return;
 for (var i = 0; i < dt.files.length; i++) eaUploadFile(dt.files[i]);
 });
 });
 var ta = document.getElementById("eaInput");
 if (ta && !ta._pasteWired) {
 ta._pasteWired = true;
 ta.addEventListener("paste", function (e) {
 var items = e.clipboardData && e.clipboardData.items;
 if (!items) return;
 for (var i = 0; i < items.length; i++) {
 var it = items[i];
 if (it.kind === "file") {
 var f = it.getAsFile();
 if (f) {
 e.preventDefault();
 eaUploadFile(f);
 }
 }
 }
 });
 }
 renderEaAttachments();
 }

 function renderEaAttachments() {
 var row = document.getElementById("eaAttachRow");
 if (!row) return;
 if (!state.attachments || !state.attachments.length) {
 row.hidden = true;
 row.innerHTML = "";
 return;
 }
 row.hidden = false;
 row.innerHTML = state.attachments
 .map(function (a, idx) {
 var size =
 a.size > 1024 * 1024
 ? (a.size / (1024 * 1024)).toFixed(1) + " MB"
 : a.size > 1024
 ? Math.round(a.size / 1024) + " KB"
 : (a.size || 0) + " B";
 return (
 '<span class="ea-attach-chip" data-idx="' +
 idx +
 '">' +
 '<span class="ea-attach-name">' +
 escHtml(a.filename || "file") +
 "</span>" +
 '<span class="ea-attach-size">' +
 escHtml(size) +
 "</span>" +
 '<button type="button" class="ea-attach-x" data-rm="' +
 idx +
 '" aria-label="Remove">×</button>' +
 "</span>"
 );
 })
 .join("");
 row.querySelectorAll("[data-rm]").forEach(function (btn) {
 btn.onclick = function () {
 var i = parseInt(btn.getAttribute("data-rm"), 10);
 if (!isNaN(i)) {
 state.attachments.splice(i, 1);
 renderEaAttachments();
 }
 };
 });
 }

 async function eaUploadFile(file) {
 if (!file) return;
 if (!signedIn()) {
 addMsg("agent", "Sign in to attach files for analysis.");
 return;
 }
 var row = document.getElementById("eaAttachRow");
 if (row) {
 row.hidden = false;
 row.innerHTML =
 (row.innerHTML || "") +
 '<span class="ea-attach-chip ea-attach-uploading">Uploading ' +
 escHtml(file.name || "file") +
 "…</span>";
 }
 try {
 var fd = new FormData();
 fd.append("file", file, file.name || "upload.bin");
 var headers = authHeaders();
 delete headers["Content-Type"];
 var r = await fetch(API.upload, {
 method: "POST",
 headers: headers,
 body: fd,
 });
 var d = await r.json().catch(function () { return {}; });
 if (!r.ok) throw new Error((d && d.detail) || "upload failed");
 if (d.asset) {
 if (!state.attachments) state.attachments = [];
 if (state.attachments.length >= 8) {
 addMsg("agent", "You can attach up to 8 files per message.");
 } else {
 state.attachments.push(d.asset);
 }
 }
 } catch (e) {
 addMsg("agent", "Upload failed: " + ((e && e.message) || e));
 }
 renderEaAttachments();
 }

 // ── Improve-the-site (merged with feature-suggestion + judge pipeline) ──
 var improve = {
 shot: null,
 activeId: null,
 poll: null,
 since: 0,
 prefilledPrompt: null, // agent-written Build-it text survives mark/recircle
 // Journey can collapse to a reopenable bubble (not gone forever)
 journeyCollapsed: false,
 lastSt: "new",
 lastFailed: false,
 lastDetail: "",
 };

 function stashImprovePrompt(t) {
 t = String(t || "").trim().slice(0, 1600);
 if (!t) return "";
 improve.prefilledPrompt = t;
 try { sessionStorage.setItem("ea_improve_prompt", t); } catch (e) {}
 return t;
 }
 function readStashedImprovePrompt() {
 if (improve.prefilledPrompt) return improve.prefilledPrompt;
 try { return sessionStorage.getItem("ea_improve_prompt") || ""; } catch (e) { return ""; }
 }
 function lastUserAsk() {
 var host = document.getElementById("eaMsgs");
 if (!host) return "";
 var nodes = host.querySelectorAll(".ea-msg.user");
 if (!nodes.length) return "";
 var el = nodes[nodes.length - 1];
 return (el.getAttribute("data-raw") || el.textContent || "").trim();
 }

 /**
 * Prefill the Improve compose box with an agent-written build prompt so the
 * owner can circle the spot and hit Build it (Ford 2026-07-14).
 */
 function fillImprovePrompt(text, opts) {
 opts = opts || {};
 var ta = document.getElementById("eaImproveText");
 if (!ta) return false;
 var t = String(text || "").trim();
 if (!t) return false;
 // Don't clobber a longer user edit unless forced
 if (!opts.force && ta.value && ta.value.trim().length > t.length + 20) {
 return false;
 }
 ta.value = t.slice(0, 1600);
 try {
 ta.dispatchEvent(new Event("input", { bubbles: true }));
 } catch (e) {}
 stashImprovePrompt(t);
 var lead = document.getElementById("eaImproveLead");
 if (lead && opts.updateLead !== false) {
 lead.textContent = opts.lead ||
 "Prompt ready, circle the spot, then tap Build it (edit the text anytime).";
 }
 return true;
 }

 function openImproveFlow(opts) {
 opts = opts || {};
 ensureUi();
 if (!state.open) {
 // Open dock without killing mic if already open path
 state.open = true;
 var panel = document.getElementById("eaPanel");
 var orb = document.getElementById("eaOrb");
 if (panel) panel.classList.add("open");
 if (orb) { orb.classList.add("open", "active"); }
 document.body.classList.add("ea-shell-open");
 }
 showImproveCompose(true);
 // Agent-written (or user-ask) prompt for the Build box, never leave empty
 // when we know what they asked for.
 var prefill =
 opts.hint || opts.prompt || opts.text || opts.build_prompt ||
 readStashedImprovePrompt() || "";
 if (!prefill && lastUserAsk()) {
 prefill = craftImprovePrompt(lastUserAsk());
 }
 if (prefill) {
 fillImprovePrompt(prefill, { force: true });
 if (!opts.silentMsg) {
 addMsg("agent",
 "I filled the build prompt from what you asked. Circle the spot on the page, " +
 "tweak the text if you want, then hit **Build it**. " +
 "An AI judge reviews it; small UI ships live, billing math never auto-ships.");
 }
 } else if (!opts.silentMsg) {
 addMsg("agent",
 "Let's improve the site. I'll freeze the page so you can circle the spot, " +
 "then type one short sentence. An AI judge reviews it; small UI changes can ship live. " +
 "Billing and money math never auto-ship.");
 }
 // Re-apply after mark overlay paints (markup path can remount focus)
 setTimeout(function () {
 var st = readStashedImprovePrompt();
 var ta = document.getElementById("eaImproveText");
 if (st && ta && !ta.value.trim()) fillImprovePrompt(st, { force: true, updateLead: false });
 }, 500);
 if (opts.markFirst !== false) {
 setTimeout(launchMarkCapture, 350);
 } else {
 setTimeout(function () {
 var ta = document.getElementById("eaImproveText");
 if (ta) ta.focus();
 }, 80);
 }
 }

 function showImproveCompose(show) {
 var box = document.getElementById("eaImprove");
 if (box) box.hidden = !show;
 }

 function closeImproveCompose() {
 showImproveCompose(false);
 improve.shot = null;
 improve.prefilledPrompt = null;
 var img = document.getElementById("eaImproveImg");
 var thumb = document.getElementById("eaImproveThumb");
 var ta = document.getElementById("eaImproveText");
 var msg = document.getElementById("eaImproveMsg");
 if (img) img.removeAttribute("src");
 if (thumb) thumb.hidden = true;
 if (ta) ta.value = "";
 if (msg) msg.textContent = "";
 }

 function launchMarkCapture() {
 if (!window.__aoImprove || typeof window.__aoImprove.startMark !== "function") {
 addMsg("agent", "Markup tools aren't loaded yet, refresh the page once and try Improve again.");
 return;
 }
 setStatus("Circle the spot on the page…", "think");
 window.__aoImprove.startMark({ viaAgent: true });
 }

 /** Called by the feature-wish markup script after the user circles a spot. */
 window.__eaOpenImprove = function (payload) {
 payload = payload || {};
 ensureUi();
 if (!state.open) {
 state.open = true;
 var panel = document.getElementById("eaPanel");
 var orb = document.getElementById("eaOrb");
 if (panel) panel.classList.add("open");
 if (orb) { orb.classList.add("open", "active"); }
 document.body.classList.add("ea-shell-open");
 }
 showImproveCompose(true);
 improve.shot = payload.screenshot_b64 || null;
 var thumb = document.getElementById("eaImproveThumb");
 var img = document.getElementById("eaImproveImg");
 var lead = document.getElementById("eaImproveLead");
 var msg = document.getElementById("eaImproveMsg");
 if (improve.shot && img && thumb) {
 img.src = "data:image/png;base64," + improve.shot;
 thumb.hidden = false;
 } else if (thumb) {
 thumb.hidden = true;
 }
 // Keep agent prefilled prompt after mark, restore from memory/session if empty
 var ta0 = document.getElementById("eaImproveText");
 var stashed = readStashedImprovePrompt();
 if (stashed && ta0 && !String(ta0.value || "").trim()) {
 fillImprovePrompt(stashed, { force: true, updateLead: false });
 }
 var hasPrompt = !!(ta0 && ta0.value && ta0.value.trim()) || !!stashed;
 if (lead) {
 if (hasPrompt || (ta0 && ta0.value.trim())) {
 lead.textContent = improve.shot
 ? "Marked. Prompt is ready, tap Build it (edit first if you want)."
 : (payload.skipped_mark
 ? "Prompt ready, tap Build it, or re-circle a spot first."
 : "Prompt ready, circle a spot or Build it as-is.");
 } else {
 lead.textContent = improve.shot
 ? "Marked. One short sentence, what should be there?"
 : (payload.skipped_mark
 ? "No mark, describe the change in a sentence."
 : "Describe the change (you can re-circle anytime).");
 }
 }
 if (msg) msg.textContent = "";
 setStatus(
 (ta0 && ta0.value.trim()) ? "Ready to Build it…" : "Describe the change…",
 "on"
 );
 setTimeout(function () {
 var ta = document.getElementById("eaImproveText");
 if (ta) {
 // Focus Build path: select end of prefilled text so user can tweak
 ta.focus();
 try {
 var len = ta.value.length;
 ta.setSelectionRange(len, len);
 } catch (e) {}
 }
 }, 80);
 };

 async function submitImprove() {
 var ta = document.getElementById("eaImproveText");
 var msg = document.getElementById("eaImproveMsg");
 var text = (ta && ta.value || "").trim();
 if (!text) {
 if (msg) {
 msg.style.color = "#b45309";
 msg.textContent = improve.shot
 ? "One short sentence, what should be at the spot you circled?"
 : "Type a short wish first.";
 }
 return;
 }
 if (msg) { msg.style.color = ""; msg.textContent = "Sending to the AI engineer + judge…"; }
 var sendBtn = document.getElementById("eaImproveSend");
 if (sendBtn) sendBtn.disabled = true;
 try {
 var d = null;
 if (window.__aoImprove && typeof window.__aoImprove.submitWish === "function") {
 d = await window.__aoImprove.submitWish(text, improve.shot);
 } else {
 // Fallback direct API
 var r = await fetch("/v1/feature-suggestion", {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({ text: text, screenshot_b64: improve.shot || undefined }),
 });
 d = await r.json().catch(function () { return null; });
 if (!(d && d.id) || !r.ok) {
 var detail = (d && (d.detail || d.message)) || ("HTTP " + r.status);
 throw new Error(detail);
 }
 }
 if (!d || !d.id) throw new Error("submit failed — no id");
 if (ta) ta.value = "";
 closeImproveCompose();
 addMsg("user", "Improve site: " + text);
 var claimed = !!(d.sovereign && d.sovereign.claimed) || d.status === "building";
 addMsg(
  "agent",
  claimed || d.status === "building"
   ? "Got it — **Energy Agent** has this in mind and is building it now. I'll track progress here."
   : "Got it — Energy Agent is taking this into mind. I'll update you as it builds."
 );
 watchBuild(d.id, { initialStatus: d.status || (claimed ? "building" : "new") });
 } catch (e) {
 if (msg) {
 msg.style.color = "#b45309";
 msg.textContent =
 "Couldn't send" +
 (e && e.message ? " (" + String(e.message).slice(0, 120) + ")" : "") +
 ". Try again in a moment.";
 }
 } finally {
 if (sendBtn) sendBtn.disabled = false;
 }
 }

 function ensureEaJourneyMini() {
 var mini = document.getElementById("eaJourneyMini");
 if (mini) return mini;
 mini = document.createElement("button");
 mini.type = "button";
 mini.id = "eaJourneyMini";
 mini.className = "ea-journey-mini";
 mini.hidden = true;
 mini.setAttribute("aria-label", "Reopen build progress");
 mini.title = "Show build progress";
 mini.innerHTML =
 '<i class="ea-j-mini-dot" aria-hidden="true"></i>' +
 '<span id="eaJourneyMiniLabel">Building your change…</span>';
 mini.onclick = function () {
 expandEaJourney();
 };
 document.body.appendChild(mini);
 return mini;
 }

 function showEaJourneyMini(show) {
 var mini = ensureEaJourneyMini();
 var label = document.getElementById("eaJourneyMiniLabel");
 if (!show) {
 mini.hidden = true;
 mini.classList.remove("show", "live", "fail");
 return;
 }
 mini.hidden = false;
 mini.classList.add("show");
 mini.classList.toggle("live", improve.lastSt === "shipped");
 mini.classList.toggle("fail", !!improve.lastFailed);
 if (label) {
 label.textContent =
 improve.lastSt === "shipped"
 ? "Your change is live — open"
 : improve.lastFailed
 ? "Build finished — open"
 : improve.lastSt === "building"
 ? "Building… tap to follow"
 : "Change in progress — tap to follow";
 }
 }

 function collapseEaJourney() {
 // Hide the big journey card; keep a bubble so Hide is recoverable.
 improve.journeyCollapsed = true;
 var host = document.getElementById("eaJourney");
 if (host) {
 host.hidden = true;
 }
 document.body.classList.remove("ea-journey-open");
 showEaJourneyMini(true);
 }

 function expandEaJourney() {
 improve.journeyCollapsed = false;
 showEaJourneyMini(false);
 // Reopen EA dock so the journey is actually visible
 try {
 if (!state.open) {
 state.open = true;
 var panel = document.getElementById("eaPanel");
 var orb = document.getElementById("eaOrb");
 if (panel) panel.classList.add("open");
 if (orb) {
 orb.classList.add("open", "active");
 }
 document.body.classList.add("ea-shell-open");
 }
 } catch (e) {}
 renderEaJourney(improve.lastSt || "new", {
 failed: !!improve.lastFailed,
 detail: improve.lastDetail || "",
 forceExpand: true,
 canEscalate: !!improve._pendingEscalateId,
 });
 }

 function watchBuild(id, opts) {
 opts = opts || {};
 improve.activeId = id;
 improve.since = Date.now();
 improve._toldFail = false;
 improve._pendingEscalateId = null;
 improve.journeyCollapsed = false;
 improve.lastSt = opts.initialStatus || "new";
 improve.lastFailed = false;
 improve.lastDetail =
  improve.lastSt === "building"
   ? "Energy Agent claimed this and is building it now."
   : improve.lastSt === "shipped"
   ? "Live on the site — refresh to see it."
   : "Energy Agent is taking this into mind now.";
 // Ensure dock is open so journey is visible (not the old floating card)
 if (!state.open) {
 state.open = true;
 var panel = document.getElementById("eaPanel");
 var orb = document.getElementById("eaOrb");
 if (panel) panel.classList.add("open");
 if (orb) { orb.classList.add("open", "active"); }
 document.body.classList.add("ea-shell-open");
 }
 // Kill residual floating wish chrome
 try {
 var wrap = document.getElementById("fsWrap");
 if (wrap) wrap.style.display = "none";
 var fj = document.getElementById("fsJourney");
 if (fj) fj.classList.remove("open");
 var mini = document.getElementById("fsMini");
 if (mini) mini.classList.remove("show");
 } catch (e) {}
 showEaJourneyMini(false);
 renderEaJourney(improve.lastSt, { detail: improve.lastDetail });
 if (improve.poll) clearInterval(improve.poll);
 improve.poll = setInterval(tickBuildStatus, 4000);
 setTimeout(tickBuildStatus, 800);
 }
 window.__eaBuildWatch = watchBuild;

 function tickBuildStatus() {
 if (!improve.activeId) return;
 fetch("/v1/feature-suggestion/" + encodeURIComponent(improve.activeId) + "/status")
 .then(function (r) {
 if (r.status === 404) {
 renderEaJourney("reviewed", {
 failed: true,
 detail: "Request not found, it may have expired. Want me to escalate to the developer?",
 });
 stopBuildWatch();
 return null;
 }
 return r.ok ? r.json() : null;
 })
 .then(function (d) {
 if (!d || !d.status) { renderEaJourney("new"); return; }
 if (d.status === "shipped") {
 renderEaJourney("shipped", { detail: d.detail });
 addMsg("agent", d.detail || "Your site change is live, refresh to see it.");
 if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
 } else if (d.status === "reviewed") {
 var elapsed = Math.floor((Date.now() - improve.since) / 1000);
 // Surface held outcome as soon as the judge finishes (don't wait 90s)
 var held = d.can_escalate || d.outcome === "passed" || d.outcome === "branched"
 || d.outcome === "backlog" || d.outcome === "failed_ship" || d.outcome === "held";
 if (held || elapsed > 25) {
 var why = d.detail || "The judge did not auto-ship this change.";
 renderEaJourney("reviewed", { failed: true, detail: why, canEscalate: true });
 if (!improve._toldFail) {
 improve._toldFail = true;
 addMsg("agent",
 "**Why this didn't auto-ship:** " + why + "\n\n" +
 "A pure color/CSS tweak should usually go through, this may have been " +
 "misclassified, the review agent may still be catching up, or the judge " +
 "wanted a human look.\n\n" +
 "Want me to **escalate this to the developer (Ford)** so it gets a human review?");
 improve._pendingEscalateId = improve.activeId;
 }
 if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
 } else {
 renderEaJourney("reviewed", { detail: d.detail });
 }
 } else {
 renderEaJourney(d.status, { detail: d.detail });
 }
 })
 .catch(function () {});
 }

 function clearFsPending(dropId) {
 // index.html resume() re-opens the journey from localStorage.fsPending after
 // every hard refresh. Dismiss/stop must drop the id or "It's live" comes back
 // forever (shipped status stays terminal; the card re-attaches on load).
 try {
  var pend = JSON.parse(localStorage.getItem("fsPending") || "[]");
  if (!Array.isArray(pend)) pend = [];
  if (dropId != null) {
   pend = pend.filter(function (p) {
    return p && p.id !== dropId && String(p.id) !== String(dropId);
   });
  }
  localStorage.setItem("fsPending", JSON.stringify(pend));
 } catch (e) {}
 }

 function stopBuildWatch() {
 var dropId = improve.activeId;
 improve.activeId = null;
 if (improve.poll) { clearInterval(improve.poll); improve.poll = null; }
 improve.journeyCollapsed = false;
 document.body.classList.remove("ea-journey-open");
 showEaJourneyMini(false);
 clearFsPending(dropId);
 }

 var JOURNEY_STEPS = [
 { key: "received", label: "Received" },
 { key: "mind", label: "In mind" },
 { key: "building", label: "Building" },
 { key: "deploying", label: "Deploying" },
 { key: "live", label: "Live" },
 ];

 function mapBuildStep(st, elapsedSec) {
 // Claims on submit → building almost immediately.
 if (st === "shipped") return 4;
 if (st === "building") return elapsedSec > 90 ? 3 : 2;
 if (st === "reviewed") return 1; // held / human look after mind saw it
 if (elapsedSec < 4) return 0;
 return 1; // status still "new" briefly while claim lands
 }

 function renderEaJourney(st, opts) {
 opts = opts || {};
 var host = document.getElementById("eaJourney");
 if (!host) return;
 improve.lastSt = st || "new";
 improve.lastFailed = !!opts.failed;
 if (opts.detail != null) improve.lastDetail = opts.detail || "";
 var elapsed = improve.since ? Math.floor((Date.now() - improve.since) / 1000) : 0;
 var stepIdx = mapBuildStep(improve.lastSt, elapsed);
 var failed = improve.lastFailed;
 var detail = improve.lastDetail || "";

 // Collapsed: keep polling, only refresh the bubble — unless terminal, then re-expand.
 if (improve.journeyCollapsed && !opts.forceExpand) {
 if (improve.lastSt === "shipped" || failed) {
 improve.journeyCollapsed = false;
 showEaJourneyMini(false);
 } else {
 showEaJourneyMini(true);
 return;
 }
 }

 host.hidden = false;
 document.body.classList.add("ea-journey-open");
 showEaJourneyMini(false);
 var title = improve.lastSt === "shipped"
  ? "It's live."
  : failed
  ? "Couldn't auto-ship."
  : improve.lastSt === "building"
  ? "Building your change…"
  : "Working on your change…";
 var lead = improve.lastSt === "shipped"
 ? (detail || "Your change is on the site. Refresh to see it.")
 : failed
 ? (detail || "Held for a human look. Nothing was lost.")
 : (detail || "Energy Agent has this in mind — pure UI usually ships live.");
 // Compact horizontal stepper (avoids tall list crushing the chat rail)
 var html =
 '<div class="ea-j-top">' +
 "<h4>" + esc(title) + "</h4>" +
 '<p class="ea-j-lead">' + esc(lead) + "</p>" +
 "</div>" +
 '<ol class="ea-j-steps" aria-label="Build progress">';
 JOURNEY_STEPS.forEach(function (s, i) {
 var cls = "todo";
 if (improve.lastSt === "shipped" || i < stepIdx) cls = "done";
 else if (i === stepIdx) cls = failed ? "fail" : "active";
 var icon = cls === "done" ? "✓" : cls === "fail" ? "!" : String(i + 1);
 html +=
 '<li class="' + cls + '">' +
 '<span class="ea-j-ic" aria-hidden="true">' + icon + "</span>" +
 "<b>" + esc(s.label) + "</b>" +
 "</li>";
 });
 html += "</ol><div class=\"ea-j-actions\">";
 if (improve.lastSt === "shipped") {
 html += '<button type="button" id="eaJReload">Refresh page</button>';
 }
 if (failed || opts.canEscalate) {
 html += '<button type="button" id="eaJEscalate" class="ea-j-esc">Escalate to developer</button>';
 }
 // Hide = collapse to bubble (recoverable). Dismiss only when terminal.
 html += '<button type="button" id="eaJDismiss">' +
 (improve.lastSt === "shipped" || failed ? "Dismiss" : "Hide") +
 "</button></div>";
 host.innerHTML = html;
 var reload = document.getElementById("eaJReload");
 if (reload) reload.onclick = function () {
  // Clear pending before reload so the journey doesn't re-attach as "It's live".
  stopBuildWatch();
  host.hidden = true;
  host.innerHTML = "";
  location.reload();
 };
 var escBtn = document.getElementById("eaJEscalate");
 if (escBtn) escBtn.onclick = function () {
 addMsg("user", "Yes, escalate this site change to the developer.");
 turn(
 "Please escalate_to_ford: site improvement request #" +
 (improve.activeId || improve._pendingEscalateId || "?") +
 " was held by the judge. Detail: " + (detail || "not auto-shipped") +
 ". User wants a human developer review.",
 "text",
 { userAlreadyShown: true }
 );
 };
 var dismiss = document.getElementById("eaJDismiss");
 if (dismiss) dismiss.onclick = function () {
 if (improve.lastSt === "shipped" || failed) {
 // Done — clear watch and bubble.
 stopBuildWatch();
 host.hidden = true;
 host.innerHTML = "";
 document.body.classList.remove("ea-journey-open");
 } else {
 // Still building — collapse to reopenable bubble; poll keeps running.
 collapseEaJourney();
 }
 };
 }

 function showMicGate(show, reason) {
 var gate = document.getElementById("eaMicGate");
 if (!gate) return;
 if (show) {
 gate.hidden = false;
 var t = gate.querySelector(".ea-mic-gate-txt");
 if (t) t.textContent = reason || "Allow microphone";
 } else {
 gate.hidden = true;
 }
 }

 /** Must run from a click handler so Chrome shows the permission prompt. */
 async function requestMicFromClick() {
 try {
 await ensureMicStream();
 showMicGate(false);
 setStatus("Mic allowed, opening agent…", "on");
 // If panel closed, open it and connect voice
 if (!state.open) await setOpen(true);
 else if (!state.listening) await startVoice(true);
 return true;
 } catch (err) {
 var name = (err && err.name) || "";
 if (name === "NotAllowedError" || name === "PermissionDeniedError") {
 showMicGate(true, "Mic blocked, click to retry");
 setStatus("Mic blocked", "warn");
 addMsg("agent",
 "Chrome blocked the mic. Click the lock/tune icon in the address bar → " +
 "Microphone → Allow, then click “Allow microphone” again.");
 } else {
 showMicGate(true, "Mic error, retry");
 addMsg("agent", "Mic error: " + ((err && err.message) || err));
 }
 return false;
 }
 }

 function setStatus(text, mode) {
 var el = document.getElementById("eaStatusText");
 var dot = document.getElementById("eaDot");
 var orb = document.getElementById("eaOrb");
 var fab = document.getElementById("eaFab");
 var statusRow = document.getElementById("eaStatus") || (el && el.closest(".ea-status"));
 // Never paint theater status lines into the main dock (they used to float as chips)
 var statusText = String(text == null ? "" : text).trim();
 if (mode === "think" && isFakeMindLabel(statusText)) {
 statusText = "Thinking…";
 } else if (isFakeMindLabel(statusText) && mode !== "listen" && mode !== "speak") {
 // Keep honest voice-off / ready lines; drop vague "looking into it"
 if (!/text only|voice|ready|muted|listening|speaking/i.test(statusText)) {
 statusText = mode === "think" ? "Thinking…" : (el && el.textContent) || "Ready";
 }
 }
 if (el) el.textContent = statusText;
 if (dot) {
 dot.className = "ea-dot" + (
 mode === "on" || mode === "sov" ? " on" :
 mode === "warn" ? " warn" : ""
 );
 if (mode === "sov") dot.classList.add("sov");
 }
 if (statusRow) {
 statusRow.classList.toggle("sov", mode === "sov");
 }
 function paintOrb(node) {
 if (!node) return;
 node.classList.toggle("listening", mode === "listen");
 node.classList.toggle("thinking", mode === "think");
 node.classList.toggle("speaking", mode === "speak");
 node.classList.toggle("open", state.open);
 node.classList.toggle("sov", mode === "sov");
 }
 paintOrb(orb);
 paintOrb(fab);
 }

 /**
 * Pro state only — no tab/FAB badges (Ford 2026-07-14/15: remove Go Pro and
 * Unlimited from Energy Agent; upgrade lives on Account / budget meter).
 */
 function setProBadge(isPro) {
 state._isPro = !!isPro;
 function hide(id) {
 var badge = document.getElementById(id);
 if (!badge) return;
 badge.hidden = true;
 badge.textContent = "";
 badge.removeAttribute("aria-label");
 badge.onclick = null;
 badge.classList.remove("ea-pro-badge--go", "ea-pro-badge--ok");
 badge.style.pointerEvents = "none";
 }
 hide("eaProBadgeTab");
 hide("eaProBadgeFab");
 }
 window.__eaSetProState = setProBadge;

 /**
 * Weekly AI usage meter (thinking + voice combined).
 * Fills 0→100% as spend approaches the cap. Must always reflect exhausted
 * state (Ford 2026-07-14: bar stayed low while voice died on 402).
 */
 function setBudget(b) {
 state.budget = b;
 var el = document.getElementById("eaBudget");
 if (!el || !b) return;
 var spent = Number(b.spent_usd) || 0;
 var proUsd = Number(b.pro_monthly_usd) || 50;
 // Pro / unlimited, calm green meter, no paywall
 if (b.unlimited || b.tier === "pro" || b.weekly_budget_usd == null) {
 el.innerHTML =
 '<span class="ea-usage ea-usage-ok" title="Energy Agent Pro, unlimited thinking + voice">' +
 '<span class="ea-usage-label">Pro</span>' +
 '<span class="ea-usage-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
 '<span class="ea-usage-fill" id="eaUsageFill" style="width:8%"></span>' +
 "</span></span>";
 el.setAttribute("aria-label", "Energy Agent Pro, unlimited");
 el.classList.remove("ea-budget-exhausted");
 state._budgetExhausted = false;
 try { setProBadge(true); } catch (_) {}
 return;
 }
 try { setProBadge(false); } catch (_) {}
 var cap = Number(b.weekly_budget_usd);
 if (!(cap > 0)) cap = 2.5;
 var pct = b.pct_used != null
 ? Number(b.pct_used)
 : Math.min(100, (spent / cap) * 100);
 if (!(pct >= 0)) pct = 0;
 // Hard-exhausted: always paint full red, even if ledger rounding left pct at 99
 if (b.ok === false) pct = Math.max(pct, 100);
 if (pct > 100) pct = 100;
 var exhausted = b.ok === false || pct >= 99.5;
 var level = exhausted ? "full" : (b.warn || pct >= 80) ? "warn" : "ok";
 var bd = b.breakdown || {};
 var tip =
 "Free weekly sample (thinking + voice) · " +
 Math.round(pct) + "% · $" + spent.toFixed(2) + " of $" + cap.toFixed(2) +
 " · resets each Monday UTC · Pro $" + proUsd.toFixed(0) + "/mo unlimited";
 if (bd.thinking_usd != null || bd.voice_usd != null) {
 tip +=
 " · Thinking ~$" + (Number(bd.thinking_usd) || 0).toFixed(2) +
 " · Voice ~$" + (Number(bd.voice_usd) || 0).toFixed(2);
 }
 if (exhausted) {
 tip = "Free sample used up, upgrade to Pro on Account for unlimited AI. " + tip;
 }
 var label = exhausted
 ? "Limit"
 : pct >= 50
 ? Math.round(pct) + "%"
 : "Sample";
 el.innerHTML =
 '<span class="ea-usage ea-usage-' + level + '" title="' + esc(tip) + '">' +
 '<span class="ea-usage-label">' + esc(label) + "</span>" +
 '<span class="ea-usage-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
 'aria-valuenow="' + Math.round(pct) + '" aria-label="Weekly sample ' + Math.round(pct) + ' percent">' +
 '<span class="ea-usage-fill" id="eaUsageFill" style="width:' + pct.toFixed(1) + '%"></span>' +
 "</span></span>";
 el.setAttribute(
 "aria-label",
 exhausted
 ? "Free weekly AI sample used up"
 : "Weekly AI sample " + Math.round(pct) + " percent of $" + cap.toFixed(2)
 );
 el.classList.toggle("ea-budget-exhausted", exhausted);
 if (b.warn && b.ok !== false && !state._budgetWarned) {
 state._budgetWarned = true;
 try {
 addMsg(
 "agent",
 "Heads up, you're past 80% of this week's free Energy Agent sample " +
 "($" + cap.toFixed(2) + " for thinking + voice). " +
 "At 100% deep AI pauses until next week, or upgrade to Pro " +
 "($" + proUsd.toFixed(0) + "/mo unlimited) on Account → Billing."
 );
 } catch (e) {}
 }
 if (exhausted && !state._budgetExhausted) {
 state._budgetExhausted = true;
 setStatus("Free sample used up", "warn");
 try {
 addMsg(
 "agent",
 "This week's free Energy Agent sample is used up " +
 "($" + spent.toFixed(2) + " of $" + cap.toFixed(2) +
 "). Voice and deep thinking pause until next Monday UTC. " +
 "For unlimited AI, open Account → Billing and upgrade to " +
 "Energy Agent Pro ($" + proUsd.toFixed(0) + "/mo)."
 );
 } catch (e) {}
 }
 if (!exhausted) {
 state._budgetExhausted = false;
 }
 }

 async function refreshBudget() {
 if (!signedIn()) return null;
 try {
 var r = await fetch(API.budget, { headers: authHeaders() });
 if (!r.ok) return null;
 var b = await r.json().catch(function () { return null; });
 if (b && (b.weekly_budget_usd != null || b.spent_usd != null)) {
 setBudget(b);
 return b;
 }
 } catch (e) {}
 return null;
 }

 function startBudgetPoll() {
 if (state._budgetPollTimer) return;
 refreshBudget().catch(function () {});
 state._budgetPollTimer = setInterval(function () {
 if (!state.open || !signedIn()) return;
 refreshBudget().catch(function () {});
 }, 45000);
 }

 function stopBudgetPoll() {
 if (state._budgetPollTimer) {
 clearInterval(state._budgetPollTimer);
 state._budgetPollTimer = null;
 }
 }

 /**
 * Pre-normalize model prose so list rendering is consistent.
 * Models often emit * bullets, unicode markers, (1)/(2), or inline "1) a 2) b".
 */
 function normalizeChatMarkdown(raw) {
 var s = String(raw == null ? "" : raw);
 // Line endings + fancy quotes
 s = s.replace(/\r\n?/g, "\n");
 s = s.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'");
 // Collapse 3+ blank lines
 s = s.replace(/\n{3,}/g, "\n\n");

 var lines = s.split("\n");
 var out = [];
 for (var i = 0; i < lines.length; i++) {
 var line = lines[i];
 var trimmed = line.replace(/[ \t]+$/g, "");

 // Skip restructuring inside fenced blocks (handled later; keep as-is)
 // Bullet chars → "- "  (• ● ○ ▪ ▸ ► ◆ ► and en/em dashes used as bullets)
 trimmed = trimmed.replace(
 /^(\s*)([-*+]|[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u25CB\u25A0\u25B8\u25B6\u25C6]|[–—])\s+/,
 "$1- "
 );
 // Asterisk bullet already covered by [-*+]; ensure "*item" without space stays non-list

 // (1) item / (12) item at line start → "1. item"
 trimmed = trimmed.replace(/^(\s*)\((\d{1,3})\)\s+/, "$1$2. ");
 // "1 - item" / "1 – item" → "1. item"
 trimmed = trimmed.replace(/^(\s*)(\d{1,3})\s*[-–—]\s+/, "$1$2. ");
 // "Step 1:" / "Step 1." at line start → keep as bold-friendly heading-ish list
 trimmed = trimmed.replace(/^(\s*)Step\s+(\d{1,3})\s*[:.\-–—]\s+/i, "$1$2. ");

 // Inline multi-item: "…: 1) foo 2) bar 3) baz" or "1. foo 2. bar" on ONE line
 // Split into real list lines when ≥2 numbered markers appear.
 var inlineNum = trimmed.match(/(?:^|[\s:;])\d{1,3}[.)]\s+\S/);
 if (inlineNum) {
 var markers = trimmed.match(/\d{1,3}[.)]\s+/g);
 if (markers && markers.length >= 2) {
 // Optional lead-in before first number
 var firstIdx = trimmed.search(/\d{1,3}[.)]\s+/);
 var lead = firstIdx > 0 ? trimmed.slice(0, firstIdx).trim() : "";
 // Drop trailing ":" from lead ("Here are three:" → own paragraph)
 if (lead) {
 lead = lead.replace(/[:：]\s*$/, "");
 if (lead) out.push(lead);
 }
 var rest = trimmed.slice(firstIdx);
 var parts = rest.split(/(?=\d{1,3}[.)]\s+)/);
 for (var p = 0; p < parts.length; p++) {
 var part = parts[p].trim();
 if (!part) continue;
 part = part.replace(/^(\d{1,3})[.)]\s+/, "$1. ");
 // Strip trailing separators often left between inline items
 part = part.replace(/[;·|]\s*$/, "").trim();
 if (part) out.push(part);
 }
 continue;
 }
 }

 // Inline multi-bullet with " • " / " · " / " | " as item separators when dense
 // Only when the line has 3+ separator-delimited chunks and no existing list mark.
 if (
 !/^\s*(-|\d+[.)])\s+/.test(trimmed) &&
 /(?:\s[•·|]\s.+){2,}/.test(trimmed)
 ) {
 var chunks = trimmed.split(/\s+[•·|]\s+/).map(function (c) {
 return c.trim();
 }).filter(Boolean);
 if (chunks.length >= 3 && chunks.every(function (c) { return c.length < 80; })) {
 for (var c = 0; c < chunks.length; c++) {
 out.push("- " + chunks[c].replace(/^[-–—]\s+/, ""));
 }
 continue;
 }
 }

 out.push(trimmed);
 }
 return out.join("\n");
 }

 /**
 * Safe lightweight markdown for chat bubbles.
 * Supports: bold, italic, code, fenced blocks, headers, nested bullet/numbered
 * lists, blockquotes, hr, links, line breaks. Escapes HTML first so model
 * output cannot inject tags. Pre-normalizes messy model patterns (unicode
 * bullets, "(1)" markers, inline "1) 2) 3)" runs).
 */
 function formatMsg(text) {
 var raw = normalizeChatMarkdown(text);

 // Protect fenced code blocks before escaping line structure
 var blocks = [];
 raw = raw.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
 var i = blocks.length;
 blocks.push(
 '<pre class="ea-code"' +
 (lang ? ' data-lang="' + esc(lang) + '"' : "") +
 "><code>" +
 esc(code.replace(/^\n+|\n+$/g, "")) +
 "</code></pre>"
 );
 return "\n%%EA_BLOCK_" + i + "%%\n";
 });

 // Protect inline code
 var inlines = [];
 raw = raw.replace(/`([^`\n]+)`/g, function (_, code) {
 var i = inlines.length;
 inlines.push('<code class="ea-icode">' + esc(code) + "</code>");
 return "%%EA_CODE_" + i + "%%";
 });

 // Escape the rest
 var s = esc(raw);

 // Headings (line-start)
 s = s.replace(/^######\s+(.+)$/gm, '<div class="ea-h ea-h6">$1</div>');
 s = s.replace(/^#####\s+(.+)$/gm, '<div class="ea-h ea-h5">$1</div>');
 s = s.replace(/^####\s+(.+)$/gm, '<div class="ea-h ea-h4">$1</div>');
 s = s.replace(/^###\s+(.+)$/gm, '<div class="ea-h ea-h3">$1</div>');
 s = s.replace(/^##\s+(.+)$/gm, '<div class="ea-h ea-h2">$1</div>');
 s = s.replace(/^#\s+(.+)$/gm, '<div class="ea-h ea-h1">$1</div>');

 // Horizontal rules
 s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="ea-hr">');

 // Blockquotes (simple single-line)
 s = s.replace(/^&gt;\s?(.+)$/gm, '<div class="ea-quote">$1</div>');

 // Bold then italic (** before *)
 s = s.replace(/\*\*([^*\n][\s\S]*?[^*\n]|\S)\*\*/g, "<strong>$1</strong>");
 s = s.replace(/__([^_\n][\s\S]*?[^_\n]|\S)__/g, "<strong>$1</strong>");
 s = s.replace(/(^|[^*\\])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

 // Links
 s = s.replace(
 /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
 '<a class="ea-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
 );
 s = s.replace(
 /(^|[^"'>=])(https?:\/\/[^\s<]+[^\s<.,);:'"!])/g,
 function (_, pre, url) {
 return pre + '<a class="ea-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
 }
 );

 // Restore inline code
 s = s.replace(/%%EA_CODE_(\d+)%%/g, function (_, i) {
 return inlines[Number(i)] || "";
 });

 // Line-based lists (valid nested HTML: sublists live inside parent <li>)
 var lines = s.split("\n");
 var out = [];
 // stack entries: { type: 'ul'|'ol', indent: n }
 var stack = [];
 var openLi = false; // true while an <li> is open at the current list depth

 function openList(type, indent) {
 var cls = type === "ol" ? "ea-ol" : "ea-ul";
 var depth = stack.length;
 var tag = type === "ol" ? "ol" : "ul";
 out.push(
 "<" + tag + ' class="' + cls + (depth ? " ea-nested" : "") +
 '" data-depth="' + depth + '">'
 );
 stack.push({ type: type, indent: indent });
 }
 function closeLiIfOpen() {
 if (openLi) {
 out.push("</li>");
 openLi = false;
 }
 }
 function closeOneList() {
 if (!stack.length) return;
 closeLiIfOpen();
 var top = stack.pop();
 out.push(top.type === "ol" ? "</ol>" : "</ul>");
 // After closing a nested list, parent <li> is still open
 if (stack.length) openLi = true;
 }
 function closeToIndent(indent) {
 // Close lists strictly deeper than indent
 while (stack.length && stack[stack.length - 1].indent > indent) {
 closeOneList();
 }
 }
 function closeAllLists() {
 while (stack.length) closeOneList();
 openLi = false;
 }
 function ensureList(type, indent) {
 if (!stack.length) {
 openList(type, indent);
 return;
 }
 var top = stack[stack.length - 1];
 if (indent > top.indent) {
 // Nest inside current open <li>
 if (!openLi) {
 // No open li to nest under — open sibling list instead
 closeLiIfOpen();
 if (top.type !== type) {
 closeOneList();
 openList(type, indent);
 }
 return;
 }
 openList(type, indent);
 openLi = false;
 return;
 }
 if (indent < top.indent) {
 closeToIndent(indent);
 top = stack[stack.length - 1];
 if (!top) {
 openList(type, indent);
 return;
 }
 // Same indent as remaining top?
 if (top.indent === indent) {
 closeLiIfOpen();
 if (top.type !== type) {
 closeOneList();
 openList(type, indent);
 }
 return;
 }
 openList(type, indent);
 return;
 }
 // Same indent
 closeLiIfOpen();
 if (top.type !== type) {
 closeOneList();
 openList(type, indent);
 }
 }

 var liReTyped = /^(\s*)(?:([-+•])|(\d+)[.)])\s+(.+)$/;

 for (var i = 0; i < lines.length; i++) {
 var line = lines[i];

 var blockM = line.match(/^%%EA_BLOCK_(\d+)%%$/);
 if (blockM) {
 closeAllLists();
 out.push(blocks[Number(blockM[1])] || "");
 continue;
 }
 if (/^<div class="ea-h/.test(line) || /^<div class="ea-quote">/.test(line) || /^<hr class="ea-hr">/.test(line)) {
 closeAllLists();
 out.push(line);
 continue;
 }

 var m = line.match(liReTyped);
 if (m) {
 var indent = m[1].replace(/\t/g, "  ").length;
 var type = m[2] ? "ul" : "ol";
 var body = m[4];
 ensureList(type, indent);
 out.push("<li>" + body);
 openLi = true;
 continue;
 }

 // Continuation line: indented prose while a list item is open
 if (stack.length && openLi && /^\s+\S/.test(line) && !liReTyped.test(line)) {
 out.push(" " + line.trim());
 continue;
 }

 closeAllLists();
 if (/^\s*$/.test(line)) {
 out.push('<div class="ea-sp"></div>');
 } else {
 out.push('<p class="ea-p">' + line + "</p>");
 }
 }
 closeAllLists();

 var html = out.join("");
 html = html.replace(/%%EA_BLOCK_(\d+)%%/g, function (_, idx) {
 return blocks[Number(idx)] || "";
 });
 html = html.replace(/<\/(ul|ol)><div class="ea-sp"><\/div><(ul|ol)/g, "</$1><$2");
 return html || "";
 }

 /** Single chat log for voice + text. Returns false if this is a near-duplicate of the last bubble. */
 function copyIconSvg() {
 return (
 '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" ' +
 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
 '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
 '<path d="M5 15V5a2 2 0 0 1 2-2h10"/>' +
 "</svg>"
 );
 }

 function copyMessageText(text, btn) {
 var raw = String(text == null ? "" : text);
 function flash(ok) {
 if (!btn) return;
 btn.classList.toggle("copied", !!ok);
 btn.classList.toggle("copy-fail", !ok);
 btn.title = ok ? "Copied" : (ok === false ? "Copy failed" : "Copy message");
 btn.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
 setTimeout(function () {
 btn.classList.remove("copied", "copy-fail");
 btn.title = "Copy message";
 btn.setAttribute("aria-label", "Copy message");
 }, 1200);
 }
 function fallback() {
 try {
 var ta = document.createElement("textarea");
 ta.value = raw;
 ta.setAttribute("readonly", "");
 ta.style.cssText = "position:fixed;left:-9999px;top:0";
 document.body.appendChild(ta);
 ta.select();
 var ok = document.execCommand("copy");
 document.body.removeChild(ta);
 flash(ok);
 } catch (e) {
 flash(false);
 }
 }
 if (navigator.clipboard && navigator.clipboard.writeText) {
 navigator.clipboard.writeText(raw).then(function () { flash(true); }, fallback);
 } else {
 fallback();
 }
 }

 function wireEaCopyDelegation(host) {
 if (!host || host._copyWired) return;
 host._copyWired = true;
 host.addEventListener("click", function (e) {
 var btn = e.target && e.target.closest ? e.target.closest(".chat-msg-copy") : null;
 if (!btn || !host.contains(btn)) return;
 e.preventDefault();
 e.stopPropagation();
 var bubble = btn.closest("[data-raw]");
 var raw = bubble ? bubble.getAttribute("data-raw") || "" : "";
 copyMessageText(raw, btn);
 });
 }

 function makeCopyBtn() {
 var copyBtn = document.createElement("button");
 copyBtn.type = "button";
 copyBtn.className = "chat-msg-copy";
 copyBtn.title = "Copy message";
 copyBtn.setAttribute("aria-label", "Copy message");
 copyBtn.innerHTML = copyIconSvg() + '<span class="chat-msg-copy-lbl">Copy</span>';
 return copyBtn;
 }

 // Normalize a line for spoken-vs-panel comparison: strip light markdown,
 // collapse whitespace, drop trailing punctuation, lowercase. Used to skip the
 // 🔊 block when the narrated line is just the panel text repeated.
 function normSpokenLine(s) {
 return String(s == null ? "" : s)
 .replace(/[*_`#>~]/g, "")
 .replace(/\s+/g, " ")
 .replace(/[.!?…]+$/, "")
 .trim()
 .toLowerCase();
 }
 function spokenIsDistinct(spoken, body) {
 var a = normSpokenLine(spoken);
 return !!a && a !== normSpokenLine(body);
 }

 /** True when the mouth is actually live for this turn: the owner is in voice
  * (mic open, or the turn itself came from voice) and the speaker isn't muted.
  * The 🔊 "what I said" block is a VOICE artifact — in a typed conversation
  * nothing was said aloud, so showing it just duplicates the written answer.
  * Same predicate that decides chatCtx.voice_active on the turn path. */
 function voiceOutputLive(isVoiceTurn) {
 return !state.voiceMuted && !!(state.listening || state.micStream || isVoiceTurn);
 }

 function addMsg(role, text, opts) {
 opts = opts || {};
 var host = document.getElementById("eaMsgs");
 if (!host) return false;
 wireEaCopyDelegation(host);
 var t = String(text || "").trim();
 if (!t) return false;
 // Dedupe: voice transcript path + turn() used to double-post the same line.
 // NEVER apply when painting server history (prefix-match was collapsing threads).
 if (!opts.history && !opts.skipDedup) {
 var last = host.lastElementChild;
 // Skip action-chip rows when finding last real bubble
 while (last && last.classList && last.classList.contains("ea-mind-actions")) {
 last = last.previousElementSibling;
 }
 if (last && last.getAttribute("data-role") === role) {
 var prev = (last.getAttribute("data-raw") || "").trim();
 // Exact match only, indexOf prefix was dropping distinct long replies
 if (prev && prev === t) {
 return false;
 }
 }
 }
 if (opts.skipIfDup && state._lastUserSaid === t && role === "user") return false;
 if (role === "user" && !opts.history) state._lastUserSaid = t;
 var d = document.createElement("div");
 var isSovereign = !!(opts.sovereign || opts.origin === "sovereign");
 var isRepairEmail = !!(
 opts.origin === "repair" ||
 opts.channel === "email" ||
 opts.repairEmail
 );
 d.className = "ea-msg " + (role === "user" ? "user" : "agent") +
 (opts.mindUpdate ? " mind-update" : "") +
 (isRepairEmail ? " repair-email" : "") +
 (isSovereign ? " sovereign" : "") +
 (opts.history ? " history" : "");
 d.setAttribute("data-role", role);
 d.setAttribute("data-raw", t);
 if (opts.mindUpdate) d.setAttribute("data-mind", "1");
 if (isSovereign) d.setAttribute("data-origin", "sovereign");
 else if (isRepairEmail) d.setAttribute("data-origin", "repair");
 // Agent replies get full markdown; user bubbles stay plain (they typed it)
 // unless they include obvious markdown markers (lists, bold, code, headers).
 var rich = role === "agent" || isSovereign ||
 /\*\*|__|`|^#\s|^\s*[-*+•]\s|^\s*\d+[.)]\s|^\s*\(\d+\)\s/m.test(t);

 // Copy whole message — same control as Sovereign desk
 d.appendChild(makeCopyBtn());

 if (isRepairEmail && role !== "user") {
 var elab = document.createElement("div");
 elab.className = "ea-email-label";
 elab.textContent = opts.kind === "repair_inbound" ? "Email · tech replied" : "Email · Energy Agent";
 d.appendChild(elab);
 }
 if (isSovereign) {
 // Label so it's obvious the product mind is talking
 var label = document.createElement("div");
 label.className = "ea-sov-label";
 label.textContent = "Energy Agent · Array Operator";
 d.appendChild(label);
 var body = document.createElement("div");
 body.className = "ea-sov-body ea-msg-body";
 if (rich) body.innerHTML = formatMsg(t);
 else body.textContent = t;
 d.appendChild(body);
 } else if (isRepairEmail) {
 // Append body without wiping the Email · label
 var rbody = document.createElement("div");
 rbody.className = "ea-email-body ea-msg-body";
 if (rich) rbody.innerHTML = formatMsg(t);
 else rbody.textContent = t;
 d.appendChild(rbody);
 } else {
 // Spoken conclusion vs panel detail: when the mind narrated a tight line
 // distinct from the written answer, lift it into a 🔊 block on top so the
 // owner immediately sees "what was said" above the supporting detail.
 var spokenLine = String(opts.spoken == null ? "" : opts.spoken).trim();
 // Only when it was really spoken aloud. Callers that know the turn's voice
 // state pass spokenAloud; anything else falls back to the live mic/mute check
 // (history repaint passes no `spoken` at all, so it never renders this).
 var spokenAloud = opts.spokenAloud === undefined
 ? voiceOutputLive()
 : !!opts.spokenAloud;
 if (role === "agent" && spokenAloud && spokenIsDistinct(spokenLine, t)) {
 var sb = document.createElement("div");
 sb.className = "ea-spoken-block";
 var sbIc = document.createElement("span");
 sbIc.className = "ea-spoken-ic";
 sbIc.setAttribute("aria-hidden", "true");
 sbIc.textContent = "🔊";
 var sbTx = document.createElement("span");
 sbTx.className = "ea-spoken-text";
 sbTx.textContent = spokenLine;
 sb.appendChild(sbIc);
 sb.appendChild(sbTx);
 d.appendChild(sb);
 }
 var bodyWrap = document.createElement("div");
 bodyWrap.className = "ea-msg-body";
 if (rich) bodyWrap.innerHTML = formatMsg(t);
 else bodyWrap.textContent = t;
 d.appendChild(bodyWrap);
 }
 host.appendChild(d);
 if (!opts.history) {
 host.scrollTop = host.scrollHeight;
 }
 return true;
 }

 function clearTools() {
 var host = document.getElementById("eaTools");
 if (!host) return;
 host.innerHTML = "";
 host.hidden = true;
 }

 /** Tool dump UI removed (Ford 2026-07-14), answers only; tools still run server-side. */
 function addTool(/* name, detail */) {
 return;
 }

 function esc(s) {
 return String(s == null ? "" : s)
 .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
 }

 function showPending(p) {
 state.pending = p;
 var box = document.getElementById("eaPending");
 if (!box) return;
 if (!p) { box.hidden = true; box.innerHTML = ""; return; }
 var reason = (p.reason || p.type || "action") +
 (p.args && p.args.hash ? " → " + p.args.hash : "") +
 (p.args && p.args.selector ? " · " + p.args.selector : "") +
 (p.args && p.args.path ? " · " + p.args.path : "");
 box.hidden = false;
 box.innerHTML =
 "<div><b>Confirm</b>, " + esc(reason) + "</div>" +
 '<div class="ea-pending-actions">' +
 '<button type="button" class="ea-yes" id="eaYes">Yes, do it</button>' +
 '<button type="button" class="ea-no" id="eaNo">Cancel</button></div>';
 document.getElementById("eaYes").onclick = function () { confirmPending(true); };
 document.getElementById("eaNo").onclick = function () { confirmPending(false); };
 }

 // ── Operating mind stream (seamless updates, one voice) ──────────────────
 // Status chip only for REAL, user-visible events (e.g. repair mail).
 // Never show theater like "Looking into it…" — Ford 2026-07-15/16: not real work.
 // Also matches unicode ellipsis (…) and "Looking into it..." variants.
 var _FAKE_MIND_LABELS =
 /looking\s*into|still\s*working|working\s*in\s*background|working[\s.…·]*$|one\s*second|hang\s*tight|bear\s*with/i;
 function isFakeMindLabel(label) {
 var lab = String(label || "").trim();
 if (!lab) return true;
 if (_FAKE_MIND_LABELS.test(lab)) return true;
 // Very short vague status chrome
 if (/^(working|busy|thinking|loading)[\s.…·!]*$/i.test(lab)) return true;
 return false;
 }
 function setMindActivity(on, label) {
 var el = document.getElementById("eaMind");
 var txt = document.getElementById("eaMindText");
 if (!el) return;
 var lab = String(label || "").trim();
 // Hard block fake background-work chrome (and never leave a stale chip visible)
 if (on && isFakeMindLabel(lab)) {
 on = false;
 }
 state.mindBusy = !!on;
 if (on) {
 el.hidden = false;
 el.classList.add("on");
 el.setAttribute("aria-hidden", "false");
 if (txt) txt.textContent = lab;
 // Auto-clear after a few seconds so chips don't stick forever
 if (state._mindChipTimer) {
 try { clearTimeout(state._mindChipTimer); } catch (e) {}
 }
 state._mindChipTimer = setTimeout(function () {
 setMindActivity(false);
 }, 4500);
 } else {
 el.hidden = true;
 el.classList.remove("on");
 el.setAttribute("aria-hidden", "true");
 if (txt) txt.textContent = "";
 if (state._mindChipTimer) {
 try { clearTimeout(state._mindChipTimer); } catch (e) {}
 state._mindChipTimer = null;
 }
 }
 }

 function mindPollMs() {
 // On Repairs, poll hard so tech email replies surface in chat within seconds
 try {
 var h = String(location.hash || "").toLowerCase();
 if (h === "#ops" || h === "#repairs" || h === "#claims") return 3500;
 } catch (e) {}
 return 15000;
 }

 function startMindAwareness() {
 if (state.mindPollTimer) return;
 // Soft poll, cheap event cursor; heavy work only on backend when tasks exist
 // Faster on Repairs so inbound tech email hits the chat almost immediately
 // Self-rescheduling poll so cadence can tighten on #ops without a full restart
 function mindTick() {
 pollMindEvents().catch(function () {});
 state.mindPollTimer = setTimeout(mindTick, mindPollMs());
 }
 state.mindPollTimer = setTimeout(mindTick, mindPollMs());
 // First pull soon after open / chat plan
 setTimeout(function () { pollMindEvents().catch(function () {}); }, 900);
 // Wake the long-term mind after the intro has had time to finish
 // (was 900ms, collided with first greeting and cut the voice).
 if (!state._mindWokeThisOpen) {
 state._mindWokeThisOpen = true;
 setTimeout(function () {
 if (state._greetingPlaying) {
 // Defer until greeting ends (polled lightly)
 var tries = 0;
 var waitG = setInterval(function () {
 tries++;
 if (!state._greetingPlaying || tries > 40) {
 clearInterval(waitG);
 fetch(API.mindWake, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 reason: "session_open",
 session_id: state.sessionId || null,
 }),
 }).then(function () { return pollMindEvents(); }).catch(function () {});
 }
 }, 400);
 return;
 }
 fetch(API.mindWake, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 reason: "session_open",
 session_id: state.sessionId || null,
 }),
 }).then(function () { return pollMindEvents(); }).catch(function () {});
 }, 4500);
 }
 }

 function stopMindAwareness() {
 if (state.mindPollTimer) {
 clearTimeout(state.mindPollTimer);
 clearInterval(state.mindPollTimer);
 state.mindPollTimer = null;
 }
 setMindActivity(false);
 }

 /**
 * Repair mail loop update — always a chat bubble (inbound tech reply or outbound send).
 * Owner asked for unprompted updates when email arrives.
 */
 function injectRepairUpdate(text, opts) {
 opts = opts || {};
 var t = String(text || "").trim();
 if (!t) return false;
 try {
 addMsg("agent", t, {
 mindUpdate: true,
 origin: "repair",
 channel: "email",
 repairEmail: true,
 kind: opts.kind || "repair_outbound",
 skipDedup: true,
 });
 setMindActivity(true, opts.kind === "repair_inbound" ? "Tech replied…" : "Emailed tech…");
 setStatus(
 opts.kind === "repair_inbound" ? "Repair team replied" : "Outreach sent",
 "on"
 );
 // Soft-open the agent if closed so the owner sees it
 if (!state.open && typeof setOpen === "function") {
 setOpen(true).catch(function () {});
 }
 return true;
 } catch (e) {
 return false;
 }
 }

 /**
 * Seamless mind awareness.
 * - Tenant mind (default): status chip only — never pollutes the chat transcript.
 * - Sovereign (product mind, opts.origin === "sovereign"): deep-blue special bubble
 *   in the chat so it's clear who is talking, plus the mind activity chip.
 */
 function injectMindSpeak(text, opts) {
 opts = opts || {};
 var t = String(text || "").trim();
 if (!t) return false;
 var isSovereign = opts.origin === "sovereign" || opts.sovereign === true;
 var now = Date.now();
 // Never interrupt the first voice intro
 if (state._greetingPlaying && !opts.force) return false;
 // Rate-limit identical / near-identical seamless updates (fleet nags)
 var fp = t.slice(0, 96).toLowerCase().replace(/\s+/g, " ");
 var isFleetNag = !isSovereign && /\bneed attention\b|\bfleet looks clear\b|\bmoney leak\b/i.test(t);
 var coolMs = isFleetNag ? 4 * 3600 * 1000 : (isSovereign ? 45 * 1000 : 90 * 1000);
 if (
 state._lastMindSpeakFp === fp &&
 (now - (state._lastMindSpeakAt || 0)) < coolMs
 ) {
 return false;
 }
 if (
 isFleetNag &&
 state._lastFleetNagFp === fp &&
 (now - (state._lastFleetNagAt || 0)) < coolMs
 ) {
 return false;
 }
 // Don't stomp while the user is mid-turn thinking (sovereign may force)
 if (state.thinking && !opts.force && !isSovereign) return false;
 state._lastMindSpeak = t;
 state._lastMindSpeakFp = fp;
 state._lastMindSpeakAt = now;
 if (isFleetNag) {
 state._lastFleetNagFp = fp;
 state._lastFleetNagAt = now;
 }
 state._mindInjecting = true;
 try {
 var short = t.length > 72 ? t.slice(0, 69).replace(/\s+\S*$/, "") + "…" : t;
 // Theater labels: never open the mind chip (layout used to float over Pro)
 if (!isFakeMindLabel(short)) {
 setMindActivity(true, isSovereign ? ("Product · " + short) : short);
 }
 if (!state.thinking && !state.speaking && !isFakeMindLabel(short)) {
 setStatus(short, isSovereign ? "sov" : "on");
 }
 if (isSovereign) {
 // Product mind: special chat bubble (deep blue) so the speaker is obvious
 addMsg("agent", t, {
 sovereign: true,
 origin: "sovereign",
 skipDedup: true,
 });
 if (opts.eventId) {
 try { addMindActionChips(opts.eventId, t); } catch (e) {}
 }
 }
 // Tenant mind: never addMsg — chat stays for real turns only
 return true;
 } finally {
 state._mindInjecting = false;
 }
 }

 function addMindActionChips(eventId, speakText) {
 var host = document.getElementById("eaMsgs");
 if (!host) return;
 var row = document.createElement("div");
 row.className = "ea-mind-actions";
 row.setAttribute("data-event-id", String(eventId));
 var wantsProposal = /proposal|open a|want me/i.test(speakText || "");
 if (wantsProposal) {
 row.innerHTML =
 '<button type="button" class="ea-mind-act yes" data-act="accepted">Yes, open it</button>' +
 '<button type="button" class="ea-mind-act no" data-act="dismissed">Not now</button>';
 } else {
 row.innerHTML =
 '<button type="button" class="ea-mind-act yes" data-act="accepted">Sounds good</button>' +
 '<button type="button" class="ea-mind-act no" data-act="dismissed">Got it</button>';
 }
 host.appendChild(row);
 host.scrollTop = host.scrollHeight;
 row.querySelectorAll(".ea-mind-act").forEach(function (btn) {
 btn.onclick = function () {
 var act = btn.getAttribute("data-act") || "shown";
 consumeMindEvents([eventId], act).catch(function () {});
 row.remove();
 if (act === "accepted" && wantsProposal) {
 // Also drive the chat path so the mind plans propose_ui
 turn("yes open proposal", "text").catch(function () {});
 }
 };
 });
 }

 async function consumeMindEvents(ids, outcome) {
 if (!ids || !ids.length) return;
 await fetch(API.mindConsume, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 event_ids: ids,
 outcome: outcome || "shown",
 }),
 });
 }

 async function pollMindEvents() {
 if (!signedIn() || !state.open) return;
 var url = API.mindEvents + "?since_id=" + encodeURIComponent(state.mindSinceId || 0);
 if (state.sessionId) {
 url += "&session_id=" + encodeURIComponent(state.sessionId);
 }
 var r = await fetch(url, { headers: authHeaders() });
 if (!r.ok) return;
 var d = await r.json().catch(function () { return null; });
 if (!d || !d.events) return;

 var toConsume = [];
 for (var i = 0; i < d.events.length; i++) {
 var ev = d.events[i];
 if (!ev || !ev.id) continue;
 if (ev.id > state.mindSinceId) state.mindSinceId = ev.id;

 // task_queued / plan_created: consume silently — do NOT show "Looking into it"
 // theater (not real owner-visible work).
 if (ev.kind === "task_queued" || ev.kind === "plan_created") {
 toConsume.push(ev.id);
 continue;
 }

 // Mind events: interrupt candidates may speak; voice_steer is status-only
 // (final mouth line comes once from /chat, speaking interim here caused double replies).
 if (ev.kind === "voice_steer" && ev.speak_as_mind && !ev.consumed) {
 // Never surface fake "Looking into it…" theater in the dock
 if (state.thinking && !isFakeMindLabel(ev.speak_as_mind)) {
 setStatus(ev.speak_as_mind, "think");
 } else if (state.thinking) {
 setStatus("Thinking…", "think");
 }
 toConsume.push(ev.id);
 } else if (
 (ev.kind === "repair_inbound" || ev.kind === "repair_outbound") &&
 ev.speak_as_mind &&
 !ev.consumed
 ) {
 // Repair mail loop: always show in chat (owner asked for unprompted updates)
 injectRepairUpdate(ev.speak_as_mind, {
 eventId: ev.id,
 kind: ev.kind,
 importance: ev.importance || 90,
 });
 // Refresh Repairs panel cases/log if present
 try {
 if (typeof window.__aoRefreshRepairs === "function") window.__aoRefreshRepairs();
 } catch (e) {}
 toConsume.push(ev.id);
 } else if (
 ev.kind === "interrupt_candidate" &&
 ev.speak_as_mind &&
 !ev.consumed &&
 ev.origin !== "sovereign"
 ) {
 // Tenant mind only — status chip. Sovereign never uses EA chat (desk instead).
 injectMindSpeak(ev.speak_as_mind, {
 eventId: ev.id,
 importance: ev.importance,
 origin: "mind",
 });
 toConsume.push(ev.id);
 } else if (
 (ev.kind === "sovereign_interrupt" || ev.origin === "sovereign") &&
 !ev.consumed
 ) {
 // Swallow leftover sovereign EA injects — conversation lives on #sovereign desk
 toConsume.push(ev.id);
 } else if (!ev.consumed) {
 // Unknown / noise — consume so it doesn't pile up
 toConsume.push(ev.id);
 }
 }

 if (toConsume.length) {
 try {
 await consumeMindEvents(toConsume, "shown");
 } catch (e) {}
 }

 // Occasional mind snapshot for insights only — never a fake "Looking into it" chip.
 var now = Date.now();
 if (!state._lastMindSnapAt || now - state._lastMindSnapAt > 45000) {
 state._lastMindSnapAt = now;
 try {
 var snap = await fetch(API.mind, { headers: authHeaders() });
 if (snap.ok) {
 var mind = await snap.json().catch(function () { return null; });
 state.mindOpenTasks = (mind && mind.open_tasks && mind.open_tasks.length) || 0;
 // Soft-surface latest proactive insight only for spikes / first notice
 // (importance >= 65 server-side). Client fleet-nag cool-down is 4h.
 var ins = mind && mind.insights && mind.insights[0];
 if (ins && ins.headline && ins.id && state._lastInsightId !== ins.id) {
 state._lastInsightId = ins.id;
 if (Number(ins.importance || 0) >= 65 && !state.thinking) {
 var line = ins.headline + (ins.detail ? ", " + String(ins.detail).slice(0, 160) : "");
 injectMindSpeak(line, { force: false });
 }
 }
 }
 } catch (e) {}
 }
 }

 /** Soft metrics line (Phase D), cost per win when available. */
 async function refreshMindMetrics() {
 // Footer metrics strip removed (Ford 2026-07-15). Keep the hook as a no-op
 // so callers of refreshMindMetrics() still resolve cleanly.
 return;
 }

 /** After chat returns a mind plan — poll for real events only (no fake chip). */
 function onMindPlanFromChat(mind) {
 if (!mind) return;
 startMindAwareness();
 // Background drain after the spoken reply path has room (don't race the chat)
 setTimeout(function () {
 fetch(API.mindTick, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({ session_id: state.sessionId || null }),
 }).then(function () {
 return pollMindEvents();
 }).catch(function () {});
 }, 2500);
 }

 // ── session (server-persisted, survives refresh; mind survives cache clear) ──
 function storedSessionId() {
 try { return localStorage.getItem("ea_session_id") || ""; } catch (e) { return ""; }
 }
 function persistSessionId(id) {
 try {
 if (id) localStorage.setItem("ea_session_id", id);
 else localStorage.removeItem("ea_session_id");
 } catch (e) {}
 }

 function msgsHostEmpty() {
 var host = document.getElementById("eaMsgs");
 if (!host) return true;
 return !host.querySelector(".ea-msg");
 }

 function scrollMsgsToEnd() {
 var host = document.getElementById("eaMsgs");
 if (!host) return;
 // Double rAF: first open after hard refresh often paints before flex
 // finishes laying out the rail — second frame lands scroll correctly.
 requestAnimationFrame(function () {
 requestAnimationFrame(function () {
 try {
 host.scrollTop = host.scrollHeight;
 void host.offsetHeight;
 } catch (e) {}
 });
 });
 }

 /**
  * Internal steering text must NEVER render as a user bubble. Two leaks seen
  * live (Ford 2026-07-19): (1) the tour-wrap instruction ("Call ONLY
  * account_summary…") is sent as a plain message so it lands in history and
  * repaints as "you"; (2) on SILENCE the transcriber hallucinates its own
  * vocabulary prompt (EA_STT_PROMPT) as if the owner spoke it. Filter both by
  * signature here — also hides ones already stored in old history.
  */
 function isInternalSteeringText(t) {
 t = String(t || "");
 if (!t) return false;
 if (/Call ONLY account_summary|Do NOT call ui_navigate|visual .*tour just finished/i.test(t)) return true;
 if (/Expect these terms:|is a solar fleet platform; its AI/i.test(t)) return true;
 if (/^\[SPOKEN\]|^\[PANEL\]/i.test(t)) return true;
 if (/^Analysis only - do NOT send/i.test(t)) return true;
 // Heavy overlap with the STT vocab prompt = hallucinated prompt echo
 try {
 if (typeof EA_STT_PROMPT === "string" &&
 transcriptOverlapsSpeech(t, EA_STT_PROMPT, 0.6) && t.length > 60) return true;
 } catch (e) {}
 return false;
 }

 /** Paint prior turns from the server (no TTS spam on restore). */
 function paintHistory(messages) {
 var host = document.getElementById("eaMsgs");
 if (!host) return 0;
 // Full replace so resume never stacks on a partial local thread
 host.innerHTML = "";
 var n = 0;
 (messages || []).forEach(function (m) {
 if (!m || !m.content) return;
 // Server uses "assistant"; accept either for safety
 var role = m.role === "user" ? "user" : "agent";
 // Internal steering prompts stored in history must not repaint as "you"
 if (role === "user" && isInternalSteeringText(m.content)) return;
 // Email-channel turns (repair mailbox) are the same mind surface as chat
 var fromEmail = m.channel === "email" || m.origin === "repair" || !!m.mindUpdate;
 // skipDedup + history: every server turn is kept
 if (addMsg(role, m.content, {
 history: true,
 skipDedup: true,
 mindUpdate: !!fromEmail,
 origin: m.origin || (fromEmail ? "repair" : undefined),
 channel: m.channel || (fromEmail ? "email" : undefined),
 repairEmail: fromEmail,
 kind: m.kind,
 })) n += 1;
 });
 state._historyPainted = n > 0;
 scrollMsgsToEnd();
 // Subtle cue when there's scrollback
 if (n > 4) {
 setStatus("Restored " + n + " messages, scroll up for earlier", "on");
 }
 return n;
 }

 /** Re-fetch history when the thread is empty but we already have a session id. */
 async function reloadSessionHistory() {
 if (!state.sessionId || !signedIn()) return 0;
 try {
 var r = await fetch(API.session + "/" + encodeURIComponent(state.sessionId), {
 headers: authHeaders(),
 });
 var d = await r.json().catch(function () { return null; });
 if (!r.ok || !d) return 0;
 var msgs = d.messages || [];
 if (!msgs.length) return 0;
 return paintHistory(msgs);
 } catch (e) {
 return 0;
 }
 }

 async function ensureSession() {
 // Single-flight: mic+tab can call setOpen twice on first gesture
 if (state._sessionPromise) return state._sessionPromise;

 // Already have a session — still restore history if the rail is empty
 // (hard-refresh race: sessionId set before paint, or paint lost).
 if (state.sessionId) {
 if (msgsHostEmpty() && signedIn()) {
 state._sessionPromise = reloadSessionHistory()
 .then(function () { return state.sessionId; })
 .finally(function () { state._sessionPromise = null; });
 return state._sessionPromise;
 }
 return state.sessionId;
 }

 if (!signedIn()) {
 addMsg("agent", "Sign in to use Energy Agent, I only work inside your own account.");
 return null;
 }

 state._sessionPromise = (async function () {
 setStatus("Starting…", "think");
 // resume:true → server returns the open conversation + history from the DB.
 // preferred_session_id is a local hint only; if cache was cleared, server
 // still finds the latest open session for this signed-in tenant.
 var r = await fetch(API.session, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 context: packContext(),
 resume: true,
 preferred_session_id: storedSessionId() || null,
 }),
 });
 var d = await r.json().catch(function () { return null; });
 if (!r.ok || !d || !d.session_id) {
 addMsg("agent", (d && d.detail) || "Couldn't start Energy Agent. Try again.");
 setStatus("Error", "warn");
 return null;
 }
 state.sessionId = d.session_id;
 persistSessionId(d.session_id);
 state.brain = d.brain;
 state.realtimeReady = !!d.realtime_ready;
 setBudget(d.budget);

 var resumed = !!d.resumed && (d.messages || []).length > 0;
 if (resumed) {
 paintHistory(d.messages);
 setStatus("Picked up where we left off", "on");
 } else {
 // Fresh conversation, intro as before
 var intro = d.intro || "Hi, I'm Energy Agent.";
 try {
 if (
 typeof window.__aoMobileOsIsActive === "function" &&
 window.__aoMobileOsIsActive() &&
 typeof window.__aoMobileOsContext === "function"
 ) {
 var mos = window.__aoMobileOsContext() || {};
 if (mos.phase === "setup" && mos.next_setup_step) {
 intro =
 "I'm your operating layer on mobile. Let's get you hands-off. " +
 "Next up: **" +
 (mos.next_setup_step.label || "setup") +
 "**. Tap a checklist chip or tell me what vendor/utility you use, " +
 "I'll drive the fastest path.";
 } else if (mos.phase === "running" || mos.hands_off_ready) {
 intro =
 "Hands-off is the goal and you're in ops mode. " +
 "Ask for a status brief anytime, inverters, last sync, offtaker send rates. " +
 "Need spreadsheets and deep edits? Tap **Detail** at the bottom.";
 }
 }
 } catch (e) {}
 addMsg("agent", intro);
 state._historyPainted = true;
 }

 if (d.realtime_ready) {
 if (!resumed) setStatus("GPT voice ready, connecting mic…", "on");
 else setStatus("Ready, conversation restored", "on");
 } else {
 setStatus("Text ready (no OPENAI_API_KEY for GPT voice yet)", "warn");
 if (!resumed) {
 addMsg("agent",
 "Voice needs OPENAI_API_KEY on the server for the latest GPT Realtime model. " +
 "You can still type. Brain: " + (d.brain || "stub") + ".");
 }
 }
 // Layout can settle after first paint on hard refresh — re-scroll once open
 scrollMsgsToEnd();
 return state.sessionId;
 })();

 try {
 return await state._sessionPromise;
 } finally {
 state._sessionPromise = null;
 }
 }

 async function toggle() {
 ensureUi();
 if (!state.open) {
 // Text-only mode (muted): open panel, no mic / no GPT voice, saves credits.
 if (signedIn() && state.voiceMuted) {
 await setOpen(true);
 setStatus("Text only, voice off", "on");
 return;
 }
 // First click on the sun: request mic IMMEDIATELY (user gesture), then open.
 // Do not await session/network before getUserMedia, that can drop the gesture
 // in some browsers and skip the permission dialog.
 if (signedIn()) {
 var micOk = false;
 try {
 await ensureMicStream();
 showMicGate(false);
 micOk = true;
 } catch (err) {
 var name = (err && err.name) || "";
 var blocked = name === "NotAllowedError" || name === "PermissionDeniedError";
 showMicGate(true, blocked ? "Mic blocked, fix & retry" : "Allow microphone");
 await setOpen(true);
 if (blocked) {
 addMsg("agent",
 "Microphone is blocked for this site. " +
 "Click the lock icon in the address bar → Site settings → Microphone → Allow, " +
 "then click the sun (or “Allow microphone”) again. " +
 "You can still type below.");
 } else {
 addMsg("agent", "Mic error: " + ((err && err.message) || err) + ", you can still type.");
 }
 return;
 }
 await setOpen(true);
 // startVoice uses the stream we already have (skipped when muted)
 if (micOk && !state.listening && !state.voiceMuted) {
 try { await startVoice(true); } catch (e) {}
 }
 } else {
 await setOpen(true);
 }
 } else {
 await setOpen(false);
 }
 }

 async function setOpen(o) {
 ensureUi();
 // Mobile OS home: agent IS the shell, refuse hard-close (Detail mode exits OS).
 var osHome = false;
 try {
 osHome = !!(
 typeof window.__aoMobileOsIsActive === "function" &&
 window.__aoMobileOsIsActive()
 );
 } catch (e) {}
 if (!o && osHome) {
 o = true;
 }
 state.open = !!o;
 var panel = document.getElementById("eaPanel");
 var orb = document.getElementById("eaOrb");
 var fab = document.getElementById("eaFab");
 if (panel) panel.classList.toggle("open", state.open);
 if (orb) {
 orb.classList.toggle("open", state.open);
 orb.classList.toggle("active", state.open);
 orb.setAttribute("aria-pressed", state.open ? "true" : "false");
 orb.setAttribute("aria-label", state.open ? "Close Energy Agent" : "Open Energy Agent");
 orb.title = state.open ? "Close Energy Agent" : "Energy Agent, click to talk";
 }
 if (fab) {
 fab.classList.toggle("open", state.open);
 fab.setAttribute("aria-pressed", state.open ? "true" : "false");
 fab.setAttribute("aria-label", state.open ? "Minimize Energy Agent" : "Open Energy Agent");
 fab.title = state.open ? "Minimize chat" : "Energy Agent, chat";
 }
 // Notify host surfaces (Repairs pill, etc.) so their buttons become Close when open
 try {
 document.dispatchEvent(new CustomEvent("ea-open-change", { detail: { open: state.open } }));
 } catch (e3) {}
 // Desktop: shift site content right. Mobile CSS zeroes the margin.
 document.body.classList.toggle("ea-shell-open", state.open);
 // Hands-off setup open? Dock EA to the RIGHT of the setup rail (don't cover it).
 var tourOpen = false;
 try {
 var ho = document.getElementById("hoTour");
 tourOpen = !!(ho && ho.classList.contains("ho-open") && !ho.hidden);
 } catch (e) {}
 document.body.classList.toggle("ho-ea-sidebyside", !!(state.open && tourOpen));
 // Repairs dual-pane: widen rail + tuck under tabbar when on #ops
 try { syncOpsWideClass(); } catch (eOps) {}
 // Table view densifies on ea-shell-open — remeasure scroll + let layout settle
 try {
 requestAnimationFrame(function () {
 try { window.dispatchEvent(new Event("resize")); } catch (e2) {}
 });
 } catch (e) {}
 if (state.open) {
 await ensureSession();
 // Hard-refresh fix: if the rail is still empty after session attach, force
 // a history reload (close→reopen used to be the only way to see chat).
 if (signedIn() && state.sessionId && msgsHostEmpty()) {
 await reloadSessionHistory();
 }
 scrollMsgsToEnd();
 // Continuous mind awareness while the conversation window is open
 if (signedIn()) {
 startMindAwareness();
 startBudgetPoll();
 refreshMindMetrics().catch(function () {});
 }
 // Voice usually already starting from toggle(); only start here if mic ready
 // and we aren't listening yet (e.g. re-open after close). Never when muted.
 if (signedIn() && !state.voiceMuted && !state.listening && state.micStream) {
 try { await startVoice(true); } catch (e) {}
 } else if (state.voiceMuted) {
 setStatus("Text only, voice off", "on");
 }
 } else {
 // Full teardown on panel close only (kills GPT voice pipe)
 stopMindAwareness();
 stopBudgetPoll();
 stopVoice(true);
 state.greeted = false;
 state._greetingPlaying = false;
 state._sessionUpdated = false;
 state._pendingGreetingSend = null;
 }
 }

 /** Soft-refresh live surfaces after agent data writes (no full page reload). */
 function softRefreshUi(detail) {
 detail = detail || {};
 try {
 if (typeof window.__aoLoadReports === "function") {
 window.__aoLoadReports();
 }
 } catch (e) {}
 try {
 // Repairs panel data only — never re-stage the composer prompt here
 if (typeof window.__aoRefreshRepairs === "function") {
 window.__aoRefreshRepairs();
 }
 } catch (e) {}
 try {
 if (window.FleetStore && typeof window.FleetStore.refetch === "function") {
 window.FleetStore.refetch();
 }
 } catch (e) {}
 try {
 window.dispatchEvent(new CustomEvent("ea:data-changed", { detail: detail }));
 } catch (e) {
 try { window.dispatchEvent(new Event("ea:data-changed")); } catch (e2) {}
 }
 // Nudge any open offtaker accordion inputs if share changed
 try {
 if (detail && detail.subscription_id != null && detail.allocation_pct != null) {
 var pct = Number(detail.allocation_pct);
 if (pct <= 1) pct = pct * 100;
 var sel = '[data-sub-id="' + detail.subscription_id + '"] input[data-of="allocation_pct"],' +
 '#rbAccBody-' + detail.subscription_id + ' input[data-of="allocation_pct"]';
 document.querySelectorAll(sel).forEach(function (inp) {
 inp.value = String(Math.round(pct * 1000) / 1000);
 inp.dispatchEvent(new Event("input", { bubbles: true }));
 });
 }
 } catch (e) {}
 }

 /**
 * Hard-stop the Realtime mouth. ALWAYS send cancel when the data channel is
 * open — do not gate on rtResponseActive. stopSpeak used to clear that flag
 * first, so cancel never ran → double speech + stuck barges (Ford 2026-07-15).
 */
 function cancelRealtimeIfActive() {
 if (!(state.dc && state.dc.readyState === "open")) {
 state.rtResponseActive = false;
 state._rtCancelPending = false;
 return false;
 }
 var sent = false;
 try {
 state.dc.send(JSON.stringify({ type: "response.cancel" }));
 sent = true;
 } catch (e) {}
 // Drop any residual outbound audio so the ear hears silence immediately
 try {
 state.dc.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
 } catch (e2) {}
 state.rtResponseActive = false;
 state._rtCancelPending = sent;
 return sent;
 }

 function isBenignVoiceError(msg) {
 var s = String(msg || "").toLowerCase();
 return (
 s.indexOf("no active response") !== -1 ||
 s.indexOf("cancellation failed") !== -1 ||
 s.indexOf("response_cancel") !== -1 ||
 s.indexOf("already has an active response") !== -1 ||
 s.indexOf("no active response to cancel") !== -1 ||
 s.indexOf("output_audio_buffer") !== -1 ||
 s.indexOf("buffer clear") !== -1
 );
 }

 /**
 * Abort an in-flight LLM/voice turn without painting "Stopped." Used when the
 * user barges in with a NEW question mid-think / mid-speech.
 * Sets user_interrupted so the next turn's context tells the model to course-correct.
 */
 function abortInFlightTurn(reason) {
 state._turnAbortGen = (state._turnAbortGen || 0) + 1;
 state._userInterrupted = true;
 state._userInterruptedReason = reason || "barge_in";
 state._userInterruptedAt = Date.now();
 if (state._chatAbort) {
 try { state._chatAbort.abort(); } catch (e) {}
 state._chatAbort = null;
 }
 cancelThinkingFiller();
 state.thinking = false;
 state._thinkingFillerActive = false;
 state._interimSpoken = false;
 state._turnBusy = false;
 if (state.touring) state.touring = false;
 // Always cancel Realtime so the mouth stops; model will see user_interrupted next turn
 try { cancelRealtimeIfActive(); } catch (e) {}
 stopSpeak({ reason: reason || "barge_in" });
 }

 // ── chat ─────────────────────────────────────────────────────────────────
 async function sendText() {
 var input = document.getElementById("eaInput");
 var text = (input && input.value || "").trim();
 var hasAttach = state.attachments && state.attachments.length > 0;
 if (!text && !hasAttach) return;
 if (input) input.value = "";
 await turn(text || "Please analyze the attached file(s).", "text");
 }

 /**
 * One conversation turn for BOTH voice and text.
 * opts.userAlreadyShown, voice path already painted the user bubble from transcript.
 */
 /** Local short-circuit: user asks to improve the UI → markup flow, no LLM needed. */
 function isImproveIntent(text) {
 var t = String(text || "").toLowerCase().trim();
 if (!t) return false;
 return /^(improve|fix|change|redesign|update)\s+(this\s+)?(site|page|ui|screen|layout)\b/.test(t)
 || /\b(wish this was better|make this better|improve the site|change the ui|mark.?up)\b/.test(t)
 || /^(can you |please )?(improve|fix) (this|the) (site|page|ui)\??$/.test(t);
 }

 function isEscalateYes(text) {
 var t = String(text || "").toLowerCase().trim();
 if (!t) return false;
 if (improve._pendingEscalateId == null && !improve.activeId) return false;
 return /^(yes|yep|yeah|please|do it|escalate|send it|tell ford|notify|go ahead)\b/.test(t)
 || /\b(escalate|developer|ford)\b/.test(t);
 }

 function tourIdFromHash(hash) {
 var h = String(hash != null ? hash : location.hash || "").toLowerCase();
 if (h.charAt(0) !== "#") h = "#" + h;
 if (h === "#account") return "master_account";
 if (h === "#reports") return "reports";
 if (h === "#arrays" || h === "#sandbox") return "arrays";
 if (h === "#analysis" || h === "#trends") return "analysis";
 if (h === "#resources") return "resources";
 if (h === "#dashboard" || h === "" || h === "#") return "dashboard";
 return null;
 }

 function detectTourId(text) {
 var t = String(text || "").toLowerCase();
 // "what are the tabs" is not a tour, LLM answers from persona map
 if (/\bwhat (are|is) (all )?(the )?(different )?tabs\b/.test(t)) return null;
 var wantsTour =
 /\b(walk\s*me|walk\s*us|walkthrough|show\s+me|show\s+us|tour|guide\s+me|take\s+me\s+through|walk\s+through|show\s+me\s+around|look\s+around)\b/.test(t)
 || /\bexplain\b.*\b(tab|page|screen|section|panel)\b/.test(t)
 || /\b(explain|describe|overview)\b.*\b(invoices?|account|inverters?|analysis|resources|triage|offtakers?)\b/.test(t)
 || /\bgive\s+me\s+a\s+(walkthrough|tour|overview|rundown)\b/.test(t)
 || /\bhow\s+does\s+(the\s+)?(account|invoices?|inverters?|analysis|resources|fleet\s+triage|this)\b/.test(t)
 || /\bhow\s+(do|does)\s+(invoices?|offtakers?|this\s+tab|this\s+page)\b/.test(t)
 || /\borient\s+me\b/.test(t)
 || /\bwhat('?s| is) on (the )?(invoices?|account|inverters?|analysis|resources|triage)\b/.test(t);
 // Named tab + walk/show/explain intent
 var tabHit =
 /\b(master\s*account|account\s+tab|invoices?\s+tab|inverters?\s+tab|fleet\s+triage|arrays?\s+tab|resources?\s+tab|analysis\s+tab)\b/.test(t);
 if (!wantsTour && !(tabHit && /\b(show|open|explain|walk|through|around|tour|guide)\b/.test(t))) {
 return null;
 }
 // Prefer specific tab mentions (order matters when multiple words appear)
 if (/\b(invoices?|offtakers?|billing\s+report|credit\s+invoices?)\b/.test(t)
 || (/\breports?\b/.test(t) && /\btab\b/.test(t))) {
 return "reports";
 }
 if (/\b(master\s*account|account\s+tab|#account)\b/.test(t)
 || (/\baccount\b/.test(t) && /\b(walk|tour|show|explain|through|around|guide)\b/.test(t))) {
 return "master_account";
 }
 if (/\bfleet\s+triage\b/.test(t) || (/\btriage\b/.test(t) && /\b(walk|tour|show|around)\b/.test(t))) {
 return "dashboard";
 }
 if (/\b(inverters?|spreadsheet|sandbox|fleet\s+canvas)\b/.test(t)
 || (/\barrays?\b/.test(t) && /\b(tab|walk|tour|show|around)\b/.test(t))) {
 return "arrays";
 }
 if (/\banalysis\b/.test(t) || /\btrends?\b/.test(t) || /\bthrough\s+time\b/.test(t)) {
 return "analysis";
 }
 if (/\bresources?\b/.test(t) || /\bnet.?meter|rates?\s+and\s+news|briefing\b/.test(t)
 || /\brec\s+market\b/.test(t)) {
 return "resources";
 }
 // Generic "walk me through this tab / the page" → current hash
 if (wantsTour) return tourIdFromHash();
 return null;
 }

 /** Local answer when user asks what the tabs are, never invent old names. */
 function tabsCheatSheet() {
 return (
 "**Array Operator tabs** — exactly as labeled in the top bar:\n\n" +
 "1. **Fleet** — fleet health at a glance; who needs attention\n" +
 "2. **Inverters** — live canvas of every inverter; columns are sites\n" +
 "3. **Analysis** — deeper digs; *Through time* / trends live here as a sub-view. " +
 "There is no separate Trends tab.\n" +
 "4. **Invoices** — offtaker invoices, drafts, send pipeline\n" +
 "5. **Resources** — net-metering rates and regulatory news\n" +
 "6. **Account** — company, email, plan, card, auto-refresh, files\n\n" +
 "Want me to open one and walk you through it?"
 );
 }

 /**
  * POST a chat turn and return {httpOk, status, d} — same shape a plain
  * fetch+json gave, so callers are unchanged.
  *
  * Goes through the STREAMING endpoint. /v1/* reaches the API via the Netlify
  * proxy, which abandons a blocking upstream at ~26s and hands back a bare
  * "HTTP 504" — and a heavy turn (several Claude tool rounds) routinely runs
  * longer, so a finished answer got thrown away after the brain had already
  * done the work (Ford 2026-07-16: the voice, which streams, spoke a full
  * answer while the text died at 504). Streaming keeps first byte immediate
  * and heartbeats the wire, so long turns survive the proxy.
  *
  * Falls back to the blocking endpoint if chat-stream isn't there yet.
  */
 async function postChatTurn(chatBody, fetchOpts) {
 var opts = Object.assign({}, fetchOpts || {}, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify(chatBody),
 });
 var r;
 try {
 r = await fetch(API.chatStream, opts);
 } catch (e) {
 if (e && e.name === "AbortError") throw e;
 r = null;
 }
 // Older backend (no chat-stream yet) → blocking endpoint, still better than nothing
 if (!r || r.status === 404 || r.status === 405) {
 var rb = await fetch(API.chat, opts);
 var db_ = await rb.json().catch(function () { return null; });
 return { httpOk: rb.ok, status: rb.status, d: db_ };
 }
 if (!r.ok || !r.body || typeof r.body.getReader !== "function") {
 var d0 = await r.json().catch(function () { return null; });
 return { httpOk: r.ok, status: r.status, d: d0 };
 }
 var reader = r.body.getReader();
 var dec = new TextDecoder();
 var buf = "";
 var out = null;
 var errEv = null;
 for (;;) {
 var step = await reader.read();
 if (step.done) break;
 buf += dec.decode(step.value, { stream: true });
 var lines = buf.split("\n");
 buf = lines.pop(); // trailing partial line
 for (var i = 0; i < lines.length; i++) {
 var line = lines[i].trim();
 if (!line) continue;
 var ev;
 try { ev = JSON.parse(line); } catch (e2) { continue; }
 if (!ev || ev.type === "ping") continue; // heartbeat, keeps the proxy open
 if (ev.type === "done") out = ev.payload || {};
 else if (ev.type === "error") errEv = ev;
 }
 }
 if (errEv) {
 return {
 httpOk: false,
 status: errEv.status || 500,
 d: { detail: errEv.detail },
 };
 }
 if (out) return { httpOk: true, status: 200, d: out };
 // Stream ended with no answer — say so honestly, don't fake success
 return { httpOk: false, status: 502, d: { detail: "The answer stream ended early — try that once more?" } };
 }

 async function turn(text, source, opts) {
 opts = opts || {};
 var pendingAttach = (state.attachments || []).slice();
 if (!text && !pendingAttach.length) return;
 if (!text && pendingAttach.length) {
 text = "Please analyze the attached file(s).";
 }
 // Hard stop first, works even if a previous turn is still thinking/speaking
 if (isStopCommand(text)) {
 if (!opts.userAlreadyShown) addMsg("user", text);
 handleStopCommand();
 return;
 }
 // If a prior turn is still running (or double STT fired), abort it so we
 // never run two LLM replies / two mouths in parallel.
 if (state.thinking || state._turnBusy) {
 abortInFlightTurn("new_turn");
 } else if (state._chatAbort) {
 // Stale controller from a finished turn — don't treat as in-flight work
 try { state._chatAbort.abort(); } catch (e) {}
 state._chatAbort = null;
 }
 // Lock immediately (before any await) so a second transcript can't start
 // another turn while we ensureSession().
 state.thinking = true;
 state._turnBusy = true;
 var turnGen = state._turnAbortGen || 0;

 var sid = await ensureSession();
 if (turnGen !== (state._turnAbortGen || 0)) {
 state.thinking = false;
 state._turnBusy = false;
 return;
 }
 if (!sid) {
 state.thinking = false;
 state._turnBusy = false;
 return;
 }
 // Live screen vision (request 60): when the owner has granted screen access,
 // AUTO-ATTACH a fresh screenshot to this turn so the brain ALWAYS sees the
 // current screen — no see_screen round-trip, no "want me to look?" (Ford
 // 2026-07-17: vision was granted but she answered from the text digest and
 // only OFFERED to look). Skip the see_screen re-turn (already carries a shot)
 // and any turn where the owner attached their own file. Marked _autoScreen so
 // it feeds vision but never shows as a 📎 chip in the message.
 if (source !== "screen_vision" && !pendingAttach.length && screenVisionLive()) {
 setStatus("Looking at your screen…", "think");
 try {
 var _shotBlob = await captureScreenBlob();
 if (turnGen === (state._turnAbortGen || 0) && _shotBlob) {
 var _shotAsset = await uploadScreenBlob(_shotBlob);
 if (_shotAsset && turnGen === (state._turnAbortGen || 0)) {
 _shotAsset._autoScreen = true;
 pendingAttach.push(_shotAsset);
 }
 }
 } catch (e) {}
 }
 // Capture attachments for this turn, clear UI immediately so a retry doesn't double-send
 var attachIds = pendingAttach.map(function (a) { return a.id; }).filter(Boolean);
 var attachNames = pendingAttach
 .filter(function (a) { return !a._autoScreen; })
 .map(function (a) { return a.filename || "file"; });
 if (attachIds.length) {
 state.attachments = [];
 renderEaAttachments();
 }
 if (!opts.userAlreadyShown) {
 var userLine = text;
 if (attachNames.length) {
 userLine = text + "\n\n📎 " + attachNames.join(", ");
 }
 addMsg("user", userLine);
 }
 // Seamless merge: site-improve intent opens mark-up with their ask prefilled
 // (skip when attachments present — owner wants analysis, not markup)
 if (!attachIds.length && isImproveIntent(text)) {
 openImproveFlow({
 markFirst: true,
 hint: craftImprovePrompt(text),
 });
 state.thinking = false;
 state._turnBusy = false;
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 return;
 }
 // Visual / color / button look-and-feel: short ack + quiet improve path.
 // Do NOT dump design-token lectures or multi-tool cascades (Ford 2026-07-14).
 // Skip when attachments need real analysis.
 if (!attachIds.length && isVisualFixIntent(text)) {
 try {
 await handleVisualFixFast(text, sid, source);
 } finally {
 if (turnGen === (state._turnAbortGen || 0)) {
 state.thinking = false;
 state._turnBusy = false;
 }
 }
 return;
 }
 // Tab names must match the top bar, answer locally so the model can't invent Dashboard/Arrays/Reports
 if (!attachIds.length && (/\bwhat (are|is) (all )?(the )?(different )?tabs\b/i.test(text)
 || /\b(list|name|explain) (all )?(the )?tabs\b/i.test(text)
 || /\btabs (do i|are there|in (the )?(app|nav|bar))\b/i.test(text))) {
 addMsg("agent", tabsCheatSheet());
 try {
 enqueueSpeak(
 "Those are the tabs in the top bar: Fleet, Analysis, Invoices, Repairs, Marketplace, and Account.",
 { source: "chat", force: true }
 );
 } catch (e) {}
 state.thinking = false;
 state._turnBusy = false;
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 return;
 }
 // Show-and-tell tours: fully client-side, real DOM selectors, voice lockstep.
 // NEVER call the LLM for freehand highlights (hallucinated boxes / desync).
 var tourId = attachIds.length ? null : detectTourId(text);
 if (tourId) {
 setStatus("Walking you through…", "think");
 try {
 var okTour = await runTour({ tour_id: tourId });
 if (turnGen !== (state._turnAbortGen || 0)) {
 state.thinking = false;
 state._turnBusy = false;
 return;
 }
 if (!okTour) {
 addMsg(
 "agent",
 "I don't have a guided walkthrough for that surface yet, open the tab and ask a specific question about a control you see."
 );
 }
 } catch (e) {
 addMsg("agent", "Couldn't run the visual tour, open the tab and ask about a section you see.");
 }
 // Optional short facts wrap-up for Account only (no UI driver commands)
 if (tourId === "master_account" || tourId === "account") {
 try {
 await postTourAccountFacts(sid);
 } catch (e2) {}
 }
 state.thinking = false;
 state._turnBusy = false;
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 return;
 }
 // After a held ship, "yes escalate" → Ford without full LLM loop
 if (isEscalateYes(text)) {
 var eid = improve._pendingEscalateId || improve.activeId;
 improve._pendingEscalateId = null;
 // fall through to LLM with clear escalate instruction
 text = "Call escalate_to_ford now. Summary: site improvement #" + eid +
 " was held by the auto-ship judge; user wants developer review. " +
 "Original user message about the UI change was recently submitted.";
 }
 setStatus("Thinking…", "think");
 // Fresh turn: drop prior tool dump so the answer has room
 clearTools();
 // Barge-in: stop leftover speech so we don't double-talk (cancel now works)
 if (!state.touring) stopSpeak({ reason: "new_turn" });
 // turnGen may have advanced via abortInFlightTurn at start — re-read
 turnGen = state._turnAbortGen || 0;
 state._chatAbort = typeof AbortController !== "undefined" ? new AbortController() : null;

 // GPT-Voice style: short interim line while the mind works, then hard-cut
 // when the real answer lands (self-interrupt). Voice turns only.
 var isVoice = (source || "") === "voice";
 startThinkingFiller(text, turnGen, isVoice);

 try {
 var isVoiceTurn = (source || "") === "voice";
 var chatCtx = packContext() || {};
 // Backend uses source + voice_source for tight spoken replies (less barge-in cutoffs)
 if (isVoiceTurn) chatCtx.voice_source = true;
 // Live screen vision: the attached image IS the owner's current screen — tell
 // the brain so it LOOKS and answers directly instead of offering to look.
 if (pendingAttach.some(function (a) { return a && a._autoScreen; })) {
 chatCtx.screen_vision_active = true;
 }
 // Voice OUTPUT live (spoken aloud) even for a typed turn → backend spends the
 // humanizer pass so the mouth gets a real one-liner, not a truncated wall.
 var voiceLive = voiceOutputLive(isVoiceTurn);
 if (voiceLive) {
   chatCtx.voice_active = true;
 }
 var chatBody = {
 session_id: sid,
 message: text,
 context: chatCtx,
 source: source || "text",
 };
 if (attachIds.length) chatBody.attachment_ids = attachIds;
 var fetchOpts = {};
 if (state._chatAbort) fetchOpts.signal = state._chatAbort.signal;
 var pack = await postChatTurn(chatBody, fetchOpts);
 // Aborted by "stop" while waiting on the model
 if (turnGen !== (state._turnAbortGen || 0)) return;
 var d = pack.d;
 if (turnGen !== (state._turnAbortGen || 0)) return;
 if (!pack.httpOk) {
 var err = (d && (d.detail || d.error)) || ("HTTP " + pack.status);
 if (pack.status === 402 || /budget|allowance|weekly/i.test(String(err))) {
 var eb = d && d.budget ? d.budget : (d && d.detail && d.detail.budget);
 if (eb) setBudget(Object.assign({}, eb, { ok: false, pct_used: 100 }));
 else refreshBudget().then(function (rb) {
 if (rb) setBudget(Object.assign({}, rb, { ok: false, pct_used: 100 }));
 });
 }
 addMsg("agent", typeof err === "string" ? err : (err && err.error) || JSON.stringify(err));
 clearTools();
 setStatus(pack.status === 402 ? "Weekly limit reached" : "Error", "warn");
 return;
 }
 setBudget(d.budget);
 // tool_trace intentionally not rendered, keeps chat readable (tools still ran)
 clearTools();
 // Operating mind: background plan started, same mind steers voice
 if (d.mind) onMindPlanFromChat(d.mind);
 if (d.pending) showPending(d.pending);
 else showPending(null);

 var reply = ownerFacingText(d.reply || "…");
 // Mind-steered mouth line (prefer speak); never speak raw #selectors
 var mouthLine = ownerFacingSpeak(
 (d.speak && String(d.speak).trim()) || reply
 );
 addMsg("agent", reply, { spoken: mouthLine, spokenAloud: voiceLive });
 clearTools();

 // Cut interim "one second…" filler, then deliver the real answer immediately
 var speakP = finishThinkingAndSpeak(mouthLine, turnGen);

 var cmds = d.ui_commands || [];
 // Kill freehand multi-highlight "tours" from the LLM, replace with a real
 // preset for the named/current tab so we never box invented UI.
 cmds = coerceTourCommands(cmds, text);
 for (var i = 0; i < cmds.length; i++) {
 if (turnGen !== (state._turnAbortGen || 0)) return;
 // Don't run a full tour while the mouth is still delivering this turn's answer
 if (cmds[i] && cmds[i].type === "tour" && state.speaking) {
 continue;
 }
 await runCommand(cmds[i]);
 }
 // Also execute navigates that arrived as pending by mistake (legacy)
 if (d.pending && d.pending.type === "navigate") {
 await runCommand(Object.assign({}, d.pending, { needs_confirm: false }));
 showPending(null);
 }
 if (turnGen !== (state._turnAbortGen || 0)) return;
 await speakP;
 if (turnGen !== (state._turnAbortGen || 0)) return;
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 } catch (e) {
 cancelThinkingFiller();
 if (e && (e.name === "AbortError" || String(e.message || "").indexOf("abort") !== -1)) {
 // User said stop / barged in — leave status to the interrupt path
 return;
 }
 if (turnGen === (state._turnAbortGen || 0)) {
 addMsg("agent", "Network error, try again.");
 setStatus("Error", "warn");
 }
 } finally {
 if (turnGen === (state._turnAbortGen || 0)) {
 state.thinking = false;
 state._thinkingFillerActive = false;
 state._turnBusy = false;
 state._chatAbort = null;
 // After a finished reply, make sure mic is open for the next ask
 if (state.listening && state.micStream && !state.speaking && !state._micHeldForSpeak) {
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 }
 }
 }
 }

 /**
 * GPT-Voice style thinking fillers: short mouth line while tools run, then
 * hard-cut when the real answer is ready. Audio only, never a chat bubble.
 */
 function pickThinkingFiller(userText) {
 var t = String(userText || "").toLowerCase();
 if (/\b(rate|bill|invoice|\$|kwh|price|credit)\b/.test(t)) {
 return "Pulling that up, one second.";
 }
 if (/\b(fleet|inverter|attention|health|underperform|fault|dead)\b/.test(t)) {
 return "Checking the fleet, one second.";
 }
 if (/\b(improve|fix|change|button|layout|ugly|look)\b/.test(t)) {
 return "Got it, one second.";
 }
 if (/\b(walk|tour|show me|how does)\b/.test(t)) {
 return "Okay, one second.";
 }
 var pool = [
 "One second.",
 "Okay.",
 "One moment.",
 "On it.",
 ];
 return pool[Math.floor(Math.random() * pool.length)];
 }

 function cancelThinkingFiller() {
 if (state._interimSteerTimer) {
 try { clearTimeout(state._interimSteerTimer); } catch (e) {}
 state._interimSteerTimer = null;
 }
 }

 function startThinkingFiller(userText, turnGen, isVoice) {
 cancelThinkingFiller();
 state._interimSpoken = false;
 state._thinkingFillerActive = false;
 if (!isVoice || state.voiceMuted) return;

 // Local filler fast, GPT Voice feel without waiting on the network
 state._interimSteerTimer = setTimeout(function () {
 state._interimSteerTimer = null;
 if (turnGen !== (state._turnAbortGen || 0)) return;
 if (!state.thinking || state.voiceMuted) return;
 if (state._interimSpoken) return;
 var line = pickThinkingFiller(userText);
 setStatus(line, "think");
 // VOICE FILLER OFF by default (Ford 2026-07-16). Speaking a contextual
 // "one second" line and then cancelling it for the real answer was the
 // "dumb blonde, then smart restart": a SECOND driven response per turn,
 // stacking up over the conversation ("start clean, later chaos"). The log
 // proved every response was weSent=true — us, not the pure-voice model.
 // Show the line as status TEXT; never speak it. One spoken response per
 // turn = the answer. window.__EA_VOICE_FILLER=true re-arms spoken fillers.
 if (window.__EA_VOICE_FILLER !== true) return;
 state._interimSpoken = true;
 state._thinkingFillerActive = true;
 enqueueSpeak(line, {
 source: "thinking_filler",
 force: true,
 holdMicFull: true,
 })
 .then(function () {
 // Filler finished before answer, still thinking
 if (state.thinking && turnGen === (state._turnAbortGen || 0)) {
 state._thinkingFillerActive = false;
 setStatus("Thinking…", "think");
 }
 })
 .catch(function () {
 state._thinkingFillerActive = false;
 });
 }, 420);

 // Optional smarter line from mind (replaces local if it arrives first)
 try {
 fetch(API.mindVoiceSteer, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 message: userText,
 context: packContext(),
 }),
 })
 .then(function (sr) { return sr.ok ? sr.json() : null; })
 .then(function (sd) {
 if (turnGen !== (state._turnAbortGen || 0)) return;
 if (!sd || !sd.speak) return;
 if (sd.mind) onMindPlanFromChat(sd.mind);
 // Only use mind line if we haven't started a filler yet
 if (!state.thinking || state.voiceMuted) return;
 // Voice filler OFF (see above): show the mind's steer line as status TEXT,
 // never speak it — a spoken filler here is the same second-response bug.
 if (window.__EA_VOICE_FILLER !== true) {
 setStatus(sd.speak, "think");
 return;
 }
 if (state._interimSpoken || state._thinkingFillerActive) {
 setStatus(sd.speak, "think");
 return;
 }
 cancelThinkingFiller();
 state._interimSpoken = true;
 state._thinkingFillerActive = true;
 setStatus(sd.speak, "think");
 enqueueSpeak(String(sd.speak).trim(), {
 source: "thinking_filler",
 force: true,
 holdMicFull: true,
 })
 .then(function () {
 if (state.thinking && turnGen === (state._turnAbortGen || 0)) {
 state._thinkingFillerActive = false;
 setStatus("Thinking…", "think");
 }
 })
 .catch(function () {
 state._thinkingFillerActive = false;
 });
 })
 .catch(function () {});
 } catch (e) {}
 }

 /** Cut filler mid-sentence (like GPT Voice) and speak the real answer. */
 function finishThinkingAndSpeak(mouthLine, turnGen) {
 cancelThinkingFiller();
 // Hard-cut interim audio immediately (cancel must run before the next create)
 var hadMouth =
 state._thinkingFillerActive ||
 state.speaking ||
 state.rtResponseActive ||
 state._rtCancelPending;
 stopSpeak({ reason: "answer_ready" });
 state._thinkingFillerActive = false;
 state._interimSpoken = false;
 // Settle so response.cancel lands; too short → "already has active response"
 // and/or stacked audio (double speak).
 var settleMs = hadMouth ? 180 : 60;
 return new Promise(function (resolve) {
 setTimeout(function () {
 if (turnGen !== (state._turnAbortGen || 0)) {
 resolve();
 return;
 }
 // Attack mute only — mic reopens so the owner can barge-in (GPT Live).
 enqueueSpeak(mouthLine, { source: "chat", force: true, holdMicFull: false })
 .then(resolve)
 .catch(function () { resolve(); });
 }, settleMs);
 });
 }

 /** Turn a casual user ask into a clear Build-it prompt for the judge. */
 function craftImprovePrompt(userText) {
 var t = String(userText || "").trim().replace(/\s+/g, " ");
 if (!t) return "";
 // Already imperative / design-spec-ish, use as-is
 if (/^(add|put|make|change|move|upgrade|replace|show|hide|fix|redesign|create)\b/i.test(t)
 && t.length > 20) {
 return t.slice(0, 1600);
 }
 return (
 "Build this UI improvement from the owner's request: " + t.slice(0, 1400) +
 " Prefer a clear, scannable visual treatment that matches Array Operator " +
 "(black/green energy aesthetic). Small pure-UI change that can auto-ship; " +
 "do not alter billing math or Stripe."
 ).slice(0, 1600);
 }

 /**
 * Optional soft length hint for tours/acks only. Normal chat speaks FULL reply
 * (user can talk as long as needed, Ford 2026-07-14).
 */
 function shortVoiceReply(text, maxChars) {
 var plain = stripMd(String(text || "")).replace(/\s+/g, " ").trim();
 if (!plain) return plain;
 maxChars = maxChars || 800;
 if (plain.length <= maxChars) return plain;
 var parts = plain.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [plain];
 var out = "";
 for (var i = 0; i < parts.length; i++) {
 var bit = (parts[i] || "").trim();
 if (!bit) continue;
 var next = out ? out + " " + bit : bit;
 if (next.length > maxChars && out) break;
 out = next;
 }
 return out || plain.slice(0, maxChars);
 }

 /** Color / look / button styling, not data edits, not fleet. */
 function isVisualFixIntent(text) {
 var t = String(text || "").toLowerCase();
 if (!t || t.length < 8) return false;
 // A QUESTION about the UI ("what's the point of this button", "what does X
 // do", "why is this here") is an ASK, not a fix request — let the agent
 // answer it (with screen vision), never auto-open the build flow.
 // Ford 2026-07-17: asked what a button did and it kicked off an improvement.
 if (/(^|\b)(what('?s| is| are| does| do)?|why|how|where|which|who|explain|describe|tell me|point of|purpose of)\b/.test(t)) {
 return false;
 }
 // Exclude pure data/ops asks
 if (/\b(share|percent|kwh|invoice|offtaker|underperform|fault|login password)\b/.test(t)
 && !/\b(button|color|colour|look|ugly|style|design|theme)\b/.test(t)) {
 return false;
 }
 var visual =
 /\b(color|colour|look(s|ing)?|ugly|pretty|style|styling|theme|contrast|font|spacing|layout|clutter|busy|overwhelming)\b/.test(t)
 || /\b(button|chip|badge|card|banner|header|nav).{0,40}(bad|ugly|wrong|fix|change|hard to|doesn.?t look)\b/.test(t)
 || /\b(doesn.?t|does not|don.?t).{0,20}look (good|right|great)\b/.test(t)
 || /\b(can we|could you|please).{0,20}fix.{0,30}(color|colour|button|look|style)\b/.test(t)
 || /\bfix (the )?(color|colour|button|styling|look)\b/.test(t);
 return visual;
 }

 async function handleVisualFixFast(text, sid, source) {
 var turnGen = state._turnAbortGen || 0;
 state.thinking = true;
 setStatus("On it…", "think");
 if (!state.touring) stopSpeak({ reason: "new_turn" });
 var reply =
 "Oh I see, I'll fix that. Working on it in the background; " +
 "I'll nudge you when there's something to refresh and check.";
 try {
 // Prefer server path so mind + judge pipeline stay one brain
 var r = await fetch(API.chat, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: sid,
 message: text,
 context: Object.assign({}, packContext(), {
 visual_fix_fast: true,
 prefer_short_reply: true,
 voice_source: (source || "") === "voice",
 }),
 source: source || "text",
 }),
 });
 if (turnGen !== (state._turnAbortGen || 0)) return;
 var d = await r.json().catch(function () { return null; });
 if (d && d.ok !== false && d.reply) {
 reply = d.reply;
 if (d.mind) onMindPlanFromChat(d.mind);
 setBudget(d.budget);
 var cmds = d.ui_commands || [];
 for (var i = 0; i < cmds.length; i++) {
 if (turnGen !== (state._turnAbortGen || 0)) return;
 await runCommand(cmds[i]);
 }
 } else {
 // Offline fallback: open improve flow with crafted build prompt
 openImproveFlow({ markFirst: true, hint: craftImprovePrompt(text) });
 }
 } catch (e) {
 openImproveFlow({ markFirst: true, hint: craftImprovePrompt(text) });
 }
 if (turnGen !== (state._turnAbortGen || 0)) return;
 addMsg("agent", reply);
 // Full reply, same long-form voice path as main chat
 await enqueueSpeak(reply, { source: "chat" });
 state.thinking = false;
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 }

 async function confirmPending(yes) {
 if (!state.sessionId) return;
 var r = await fetch(API.confirm, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 confirm: !!yes,
 pending_id: state.pending && state.pending.id,
 }),
 });
 var d = await r.json().catch(function () { return null; });
 showPending(null);
 if (d && d.cancelled) {
 addMsg("agent", "Cancelled.");
 return;
 }
 if (d && d.command) {
 addMsg("agent", yes ? "On it, applying now." : "Cancelled.");
 await runCommand(d.command);
 var extras = d.extra_commands || [];
 for (var i = 0; i < extras.length; i++) await runCommand(extras[i]);
 // Soft-refresh after any confirmed write
 softRefreshUi((d.command.args && d.command.args.body) || {});
 }
 }

 /**
 * If the model tried a freehand multi-step highlight tour (or mixed tour_id with
 * extra guessed highlights), collapse to a single preset tour. Never invent UI.
 */
 function coerceTourCommands(cmds, userText) {
 cmds = cmds || [];
 var tourCmd = null;
 var hlCount = 0;
 for (var i = 0; i < cmds.length; i++) {
 var c = cmds[i];
 if (!c) continue;
 var ty = String(c.type || "").toLowerCase();
 if (ty === "tour" || ty === "walkthrough" || ty === "ui_tour") {
 tourCmd = c;
 }
 if (ty === "highlight" || ty === "ui_highlight") hlCount++;
 }
 var forcedId =
 (tourCmd && tourCmd.args && (tourCmd.args.tour_id || tourCmd.args.id)) ||
 detectTourId(userText) ||
 null;
 // 2+ freehand highlights = the model is inventing a walkthrough
 if (hlCount >= 2 || (tourCmd && hlCount >= 1)) {
 var tid = forcedId || tourIdFromHash();
 if (tid && presetTour(tid)) {
 return [{ type: "tour", args: { tour_id: tid }, id: "coerce-tour" }];
 }
 }
 // Single ui_tour without freehand is fine, normalize type
 if (tourCmd && hlCount === 0) {
 return cmds.map(function (c) {
 if (!c) return c;
 var ty = String(c.type || "").toLowerCase();
 if (ty === "ui_tour" || ty === "walkthrough") {
 return Object.assign({}, c, { type: "tour" });
 }
 return c;
 });
 }
 return cmds;
 }

 // ── Live screen vision (request 60, the agent's own capability request) ────
 // Grant screen-share ONCE, keep the stream, snapshot a frame on demand and hand
 // it to the brain as an image (Claude vision) so she SEES the rendered UI instead
 // of guessing from a text digest. Fully opt-in: nothing is captured until the
 // owner approves the browser prompt, and the see_screen tool is a dormant skill.
 function screenVisionLive() {
 try {
 return !!(state.screenStream &&
 state.screenStream.getVideoTracks().some(function (t) { return t.readyState === "live"; }));
 } catch (e) { return false; }
 }
 async function grantScreenVision() {
 if (screenVisionLive()) return true;
 if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
 addMsg("agent", "This browser can't share the screen for me to see — try Chrome or Edge.");
 return false;
 }
 try {
 var stream = await navigator.mediaDevices.getDisplayMedia({
 video: { frameRate: 2 },
 audio: false,
 preferCurrentTab: true, // Chrome hint: default to THIS tab
 selfBrowserSurface: "include",
 });
 state.screenStream = stream;
 var vt = stream.getVideoTracks()[0];
 if (vt) vt.addEventListener("ended", function () { state.screenStream = null; syncScreenBtn(); });
 syncScreenBtn();
 return true;
 } catch (e) {
 return false; // denied / cancelled
 }
 }
 function stopScreenVision() {
 try { state.screenStream && state.screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
 state.screenStream = null;
 syncScreenBtn();
 }
 async function captureScreenBlob() {
 if (!screenVisionLive()) return null;
 var track = state.screenStream.getVideoTracks()[0];
 var src = null, vw = 0, vh = 0, videoEl = null;
 try {
 if (window.ImageCapture) {
 var bmp = await new window.ImageCapture(track).grabFrame();
 src = bmp; vw = bmp.width; vh = bmp.height;
 }
 } catch (e) { src = null; }
 if (!src) {
 videoEl = document.createElement("video");
 videoEl.muted = true; videoEl.srcObject = state.screenStream;
 try { await videoEl.play(); } catch (e) {}
 await new Promise(function (res) {
 if (videoEl.videoWidth) return res();
 videoEl.onloadedmetadata = res; setTimeout(res, 700);
 });
 src = videoEl; vw = videoEl.videoWidth || 1280; vh = videoEl.videoHeight || 720;
 }
 if (!vw || !vh) return null;
 var maxW = 1400;
 var scale = vw > maxW ? maxW / vw : 1;
 var cw = Math.max(1, Math.round(vw * scale)), ch = Math.max(1, Math.round(vh * scale));
 var canvas = document.createElement("canvas");
 canvas.width = cw; canvas.height = ch;
 try { canvas.getContext("2d").drawImage(src, 0, 0, cw, ch); } catch (e) { return null; }
 if (videoEl) { try { videoEl.pause(); videoEl.srcObject = null; } catch (e) {} }
 return await new Promise(function (res) {
 try { canvas.toBlob(function (b) { res(b); }, "image/jpeg", 0.75); }
 catch (e) { res(null); }
 });
 }
 async function uploadScreenBlob(blob) {
 var fd = new FormData();
 fd.append("file", blob, "screen-" + Date.now() + ".jpg");
 var headers = authHeaders(); delete headers["Content-Type"];
 try {
 var r = await fetch(API.upload, { method: "POST", headers: headers, body: fd });
 var d = await r.json().catch(function () { return {}; });
 return (r.ok && d && d.asset) ? d.asset : null;
 } catch (e) { return null; }
 }
 /** Full flow: ensure grant → capture → upload → re-invoke the brain WITH the image. */
 async function runSeeScreen(reason) {
 var ok = screenVisionLive() || (await grantScreenVision());
 if (!ok) {
 addMsg("agent", "I need permission to see your screen — click the 👁 button below and choose “This Tab.”");
 return;
 }
 setStatus("Looking at your screen…", "think");
 var blob = await captureScreenBlob();
 if (!blob) { addMsg("agent", "I couldn't grab the screen just now — try once more?"); return; }
 var asset = await uploadScreenBlob(blob);
 if (!asset) { addMsg("agent", "The screen capture didn't upload — try once more?"); return; }
 if (!state.attachments) state.attachments = [];
 state.attachments.push(asset);
 var note = "Here's my screen right now — take a look" + (reason ? (" (" + reason + ")") : "") + ".";
 turn(note, "screen_vision", {}).catch(function () {});
 }
 function syncScreenBtn() {
 var btn = document.getElementById("eaScreenBtn");
 if (!btn) return;
 var on = screenVisionLive();
 btn.classList.toggle("ea-screen-on", on);
 btn.setAttribute("aria-pressed", on ? "true" : "false");
 btn.title = on ? "Energy Agent can see your screen — click to stop" : "Let Energy Agent see your screen";
 // Octarine "live" glow when granted (no separate stylesheet needed).
 try {
 btn.style.color = on ? "#7b5cff" : "";
 btn.style.borderColor = on ? "rgba(123,92,255,.55)" : "";
 btn.style.boxShadow = on ? "0 0 0 1px rgba(123,92,255,.35), 0 0 12px -4px rgba(123,92,255,.6)" : "";
 } catch (e) {}
 }

 // ── browser driver ───────────────────────────────────────────────────────
 async function runCommand(cmd) {
 if (!cmd) return;
 addTool("ui." + (cmd.type || "?"), JSON.stringify(cmd.args || {}).slice(0, 100));
 var ok = false, detail = {};
 try {
 if (cmd.type === "navigate") {
 var hash = (cmd.args && cmd.args.hash) || "#dashboard";
 if (hash.charAt(0) !== "#") hash = "#" + hash;
 // Normalize aliases → real hashes. User-facing labels are separate (TAB_LABELS).
 var aliases = {
 "#invoice": "#reports", "#invoices": "#reports", "#billing": "#reports",
 "#offtaker": "#reports", "#offtakers": "#reports",
 "#inverter": "#arrays", "#inverters": "#arrays",
 "#fleet": "#dashboard", "#triage": "#dashboard",
 "#fleettriage": "#dashboard", "#fleet-triage": "#dashboard",
 "#master": "#account", "#settings": "#account",
 "#masteraccount": "#account", "#master-account": "#account",
 "#trends": "#analysis", "#trend": "#analysis", "#through-time": "#analysis",
 "#om": "#ops", "#repair": "#ops", "#repairs": "#ops", "#claims": "#ops",
 };
 var h = hash.toLowerCase().replace(/\s+/g, "");
 if (aliases[h]) hash = aliases[h];
 // Spoken/legacy names without #
 var nameAlias = {
 dashboard: "#dashboard", "fleet triage": "#dashboard", fleettriage: "#dashboard",
 arrays: "#arrays", inverters: "#arrays",
 analysis: "#analysis", trends: "#analysis",
 reports: "#reports", invoices: "#reports",
 account: "#account", "master account": "#account",
 resources: "#resources",
 ops: "#ops", operations: "#ops", repairs: "#ops", claims: "#ops", om: "#ops",
 };
 var rawName = String((cmd.args && (cmd.args.tab || cmd.args.name || cmd.args.label)) || "")
 .toLowerCase().trim();
 if (nameAlias[rawName]) hash = nameAlias[rawName];
 location.hash = hash;
 // Help sandbox router if it listens to hashchange
 try {
 window.dispatchEvent(new HashChangeEvent("hashchange"));
 } catch (e) {
 try { window.dispatchEvent(new Event("hashchange")); } catch (e2) {}
 }
 ok = true;
 detail = { hash: hash, tab: tabLabel(hash) };
 // Tours pass silent, avoid spamming "Opening…" over the guided narration
 if (!(cmd.args && cmd.args.silent) && !state.touring) {
 addMsg("agent", "Opening **" + tabLabel(hash) + "**…");
 }
 } else if (cmd.type === "highlight" || cmd.type === "ui_highlight") {
 // Never box a selector that isn't actually on screen (kills hallucinated targets)
 var hsel = cmd.args && cmd.args.selector;
 var hel = hsel ? queryFirst(hsel) : null;
 if (!hel || !isTourVisible(hel)) {
 ok = false;
 detail = { selector: hsel, error: "not_visible" };
 } else {
 ok = highlight(
 hsel,
 (cmd.args && cmd.args.ms) || 4500,
 cmd.args && (cmd.args.say || cmd.args.label)
 );
 detail = { selector: hsel };
 }
 } else if (cmd.type === "tour" || cmd.type === "walkthrough" || cmd.type === "ui_tour") {
 // Prefer preset tour_id; drop freehand custom steps that invent selectors
 var targs = Object.assign({}, cmd.args || {});
 if (targs.tour_id || targs.id) {
 targs.tour_id = targs.tour_id || targs.id;
 delete targs.steps; // never mix guessed steps with a preset
 } else if (targs.steps && targs.steps.length) {
 var bad = targs.steps.some(function (s) {
 return s && s.selector && !queryFirst(s.selector);
 });
 if (bad) {
 var fb = tourIdFromHash();
 targs = fb ? { tour_id: fb } : targs;
 }
 } else {
 var fb2 = tourIdFromHash();
 if (fb2) targs = { tour_id: fb2 };
 }
 ok = await runTour(targs);
 detail = { tour_id: targs.tour_id || null, steps: (targs.steps || []).length };
 } else if (cmd.type === "fill") {
 ok = fill(cmd.args && cmd.args.selector, cmd.args && cmd.args.value);
 } else if (cmd.type === "click") {
 ok = clickEl(cmd.args && cmd.args.selector);
 } else if (cmd.type === "api_patch" || cmd.type === "api") {
 ok = await apiProxy(cmd.args || {});
 detail = cmd.args || {};
 if (ok) softRefreshUi(detail.body || detail);
 } else if (cmd.type === "open_url" || cmd.type === "ui_open_url") {
 // Open vendor/utility portal in a new tab (Paul: SmartHub / Solar.web links)
 var ou = (cmd.args && (cmd.args.url || cmd.args.href)) || "";
 if (/^https?:\/\//i.test(ou)) {
 try { window.open(ou, "_blank", "noopener,noreferrer"); ok = true; }
 catch (e) { ok = false; }
 detail = { url: ou };
 if (ok && !(cmd.args && cmd.args.silent)) {
 addMsg("agent", "Opening [" + (cmd.args.label || "portal") + "](" + ou + ").");
 }
 } else {
 ok = false;
 detail = { error: "bad_url" };
 }
 } else if (cmd.type === "ui_refresh" || cmd.type === "refresh") {
 softRefreshUi(cmd.args || {});
 ok = true;
 detail = cmd.args || {};
 } else if (cmd.type === "improve_site" || cmd.type === "site_improve") {
 // Freeze → circle → Build it. Prefill agent-written prompt from tool args.
 var a = cmd.args || {};
 openImproveFlow({
 markFirst: a.mark_first !== false && a.markFirst !== false,
 hint: a.hint || a.prompt || a.build_prompt || a.text || "",
 prompt: a.build_prompt || a.prompt || a.hint || a.text || "",
 });
 if (a.suggestion_id) {
 watchBuild(a.suggestion_id);
 }
 ok = true;
 detail = a;
 } else if (cmd.type === "watch_build") {
 if (cmd.args && cmd.args.suggestion_id) watchBuild(cmd.args.suggestion_id);
 ok = true;
 detail = cmd.args || {};
 } else if (cmd.type === "see_screen") {
 // Brain asked to see the screen: capture → upload → re-turn with the image.
 runSeeScreen(cmd.reason || (cmd.args && cmd.args.reason) || "");
 ok = true;
 detail = { reason: cmd.reason || "" };
 } else {
 detail = { error: "unknown command type" };
 }
 } catch (e) {
 detail = { error: String(e && e.message || e) };
 }
 try {
 await fetch(API.uiResult, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 command_id: cmd.id || "x",
 ok: ok,
 detail: detail,
 }),
 });
 } catch (e) {}
 }

 function clearHighlights() {
 try {
 document.querySelectorAll(".ea-hl, .ea-hl-pulse").forEach(function (el) {
 el.classList.remove("ea-hl", "ea-hl-pulse");
 });
 } catch (e) {}
 }

 function queryFirst(sel) {
 if (!sel) return null;
 // Prefer matches inside the active panel so tours don't box unrelated chrome
 var roots = [];
 try {
 var active = document.querySelector(".panel.active");
 if (active) roots.push(active);
 } catch (e) {}
 roots.push(document);
 var el = null;
 String(sel).split(",").some(function (part) {
 var p = part.trim();
 if (!p) return false;
 for (var r = 0; r < roots.length; r++) {
 try {
 el = roots[r].querySelector(p);
 } catch (e) {
 el = null;
 }
 if (el) return true;
 }
 return false;
 });
 return el;
 }

 /** True only for on-screen tour targets (never box [hidden] / display:none). */
 function isTourVisible(el) {
 if (!el || !el.isConnected) return false;
 try {
 if (el.hidden) return false;
 if (el.getAttribute("aria-hidden") === "true") return false;
 if (el.closest && el.closest("[hidden]")) return false;
 var st = window.getComputedStyle(el);
 if (!st || st.display === "none" || st.visibility === "hidden") return false;
 var r = el.getBoundingClientRect();
 // zero-size = not painted (e.g. display:none parent we missed)
 if (r.width < 2 && r.height < 2) return false;
 } catch (e) {
 return false;
 }
 return true;
 }

 async function waitForSelector(sel, timeoutMs) {
 var t0 = Date.now();
 var limit = timeoutMs || 4000;
 while (Date.now() - t0 < limit) {
 var el = queryFirst(sel);
 if (el && isTourVisible(el)) return el;
 await sleep(120);
 }
 var last = queryFirst(sel);
 return last && isTourVisible(last) ? last : null;
 }

 function highlight(sel, ms, say) {
 if (!sel) return false;
 clearHighlights();
 var el = queryFirst(sel);
 if (!el) return false;
 el.classList.add("ea-hl", "ea-hl-pulse");
 try { el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch (e) {}
 // say is handled by the tour sequencer (speakAndWait), keep highlight pure
 if (say && !state.touring) {
 addMsg("agent", say);
 try { speak(say); } catch (e) {}
 }
 setTimeout(function () {
 el.classList.remove("ea-hl", "ea-hl-pulse");
 }, ms || 4500);
 return true;
 }

 function sleep(ms) {
 return new Promise(function (resolve) { setTimeout(resolve, ms); });
 }

 function stripMd(text) {
 return String(text || "")
 .replace(/\*\*([^*]+)\*\*/g, "$1")
 .replace(/\*([^*]+)\*/g, "$1")
 .replace(/`([^`]+)`/g, "$1")
 .replace(/#{1,6}\s+/g, "")
 .replace(/^\s*[-*+•]\s+/gm, "")
 .replace(/^\s*\d+[.)]\s+/gm, "")
 .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
 .replace(/\n+/g, " ")
 .replace(/\s{2,}/g, " ")
 .trim();
 }

 /**
 * Owner-facing copy must not expose CSS/DOM selectors (#reports, #rbBulkImport).
 * Voice was reading them as "hash reports" / "hash rb bulk import", weird flow.
 * Map known hashes to tab/control labels; drop the rest.
 */
 var HASH_LABELS = {
 "#dashboard": "Fleet",
 "#arrays": "Inverters",
 "#sandbox": "Inverters",
 "#analysis": "Analysis",
 "#trends": "Trends",
 "#reports": "Invoices",
 "#resources": "Resources",
 "#ops": "Repairs",
 "#claims": "Repairs",
 "#account": "Account",
 "#rbbulkimport": "Bulk import",
 "#rbcustadd": "Add an offtaker",
 "#rb2exportbtn": "Export",
 "#rblinkutility": "Link utility bills",
 "#rbemailstudio": "Customize email",
 "#rbgentabs": "Offtakers",
 "#vssegsandbox": "Sandbox",
 "#vssegsheet": "Spreadsheet",
 "#sbaddarray": "Add array",
 "#fleetcommander": "fleet health tiles",
 "#ccqueue": "attention queue",
 };

 function stripTechIds(text) {
 var s = String(text || "");
 // Parenthetical selectors: ( #rbBulkImport ) or (#reports)
 s = s.replace(/\s*[\(（]\s*#[a-zA-Z][\w-]*\s*[\)）]/g, "");
 // Markdown-ish **#foo** leftovers
 s = s.replace(/\*\*#(reports|arrays|dashboard|analysis|resources|account|trends)\*\*/gi, function (_, t) {
 var key = "#" + String(t).toLowerCase();
 return HASH_LABELS[key] || t;
 });
 // Bare #id tokens
 s = s.replace(/#[a-zA-Z][\w-]*/g, function (m) {
 var key = m.toLowerCase();
 if (HASH_LABELS[key]) return HASH_LABELS[key];
 // camelCase / snake id → human-ish drop (don't invent jargon)
 return "";
 });
 // Clean gaps left by removals
 s = s
 .replace(/\s+([,.;:!?])/g, "$1")
 .replace(/\(\s*\)/g, "")
 .replace(/\s{2,}/g, " ")
 .replace(/\s+via the\s+/gi, " via the ")
 .trim();
 return s;
 }

 /** Text for chat bubble: friendly, no raw selectors. */
 function ownerFacingText(text) {
 return stripTechIds(String(text || ""));
 }

 /** Text for TTS: no markdown, no selectors. */
 function ownerFacingSpeak(text) {
 return stripTechIds(stripMd(text));
 }

 function setTourCaption(text, stepIdx, total) {
 var cap = document.getElementById("eaTourCap");
 var body = document.getElementById("eaTourCapText");
 var kicker = document.getElementById("eaTourKicker");
 if (!cap || !body) return;
 if (!text) {
 cap.hidden = true;
 body.textContent = "";
 return;
 }
 cap.hidden = false;
 if (kicker) {
 kicker.textContent = total
 ? ("Tour · " + (stepIdx + 1) + " of " + total)
 : "Tour";
 }
 // light markdown bold for caption
 body.innerHTML = formatMsg(text).replace(/<\/?p[^>]*>/g, " ").replace(/<div class="ea-sp"><\/div>/g, " ");
 }

 /**
 * How long a tour step should stay on screen so the eye can follow the
 * narration. Tuned slightly slower than average speaking (~130–150 wpm) so
 * visuals never race ahead of the description (Ford 2026-07-14).
 */
 function estimateTourDwellMs(text) {
 var plain = stripMd(text);
 var words = plain.split(/\s+/).filter(Boolean).length;
 // ~420ms/word + lead-in for scroll/highlight settle; floor 2.8s, cap 50s
 return Math.min(50000, Math.max(2800, Math.round(words * 420) + 1600));
 }

 /**
 * Tour lockstep: speak the line (when voice is on), then hold the highlight
 * until either speech finishes OR a reading-paced dwell, whichever is longer.
 * When muted / no mouth, we still wait the full dwell so the UI stays in sync
 * with what the caption is describing.
 */
 function speakAndWait(text) {
 var plain = stripMd(text);
 var minMs = estimateTourDwellMs(plain);
 var t0 = Date.now();
 var speakP;
 if (state.voiceMuted) {
 // Don't force-unmute; caption carries the line, pace by reading time
 speakP = Promise.resolve();
 } else {
 // force:true so tour lines aren't deduped against a prior chat reply
 speakP = enqueueSpeak(text, { source: "tour", force: true });
 }
 return speakP
 .catch(function () {})
 .then(function () {
 var elapsed = Date.now() - t0;
 // Speech done (or silent): keep the highlight up until min dwell, then
 // a short settle beat so the next jump never feels snappy.
 var remain = Math.max(0, minMs - elapsed);
 var settle = state.voiceMuted ? 400 : 900;
 return sleep(remain + settle);
 });
 }

 /** User-visible tab names, must match the top tabbar labels exactly. */
 var TAB_LABELS = {
 "#dashboard": "Fleet",
 "#arrays": "Inverters",
 "#analysis": "Analysis",
 "#reports": "Invoices",
 "#ops": "Repairs",
 "#claims": "Repairs",
 "#resources": "Resources",
 "#account": "Account",
 };
 function tabLabel(hash) {
 var h = String(hash || "").toLowerCase();
 if (h.charAt(0) !== "#") h = "#" + h;
 return TAB_LABELS[h] || hash;
 }

 function panelSelectorForHash(hash) {
 var map = {
 "#dashboard": "#panelDashboard",
 "#arrays": "#panelDashboard",
 "#sandbox": "#panelDashboard",
 "#analysis": "#panelAnalysis",
 "#reports": "#panelReports",
 "#ops": "#panelOps",
 "#claims": "#panelOps",
 "#resources": "#panelResources",
 "#account": "#panelAccount",
 };
 var h = String(hash || "").toLowerCase();
 if (h.charAt(0) !== "#") h = "#" + h;
 return map[h] || null;
 }

 async function scrollPanelTop(hash) {
 var panelSel = panelSelectorForHash(hash);
 var panel = panelSel ? document.querySelector(panelSel) : null;
 try {
 window.scrollTo({ top: 0, behavior: "smooth" });
 } catch (e) {
 try { window.scrollTo(0, 0); } catch (e2) {}
 }
 if (panel) {
 try {
 panel.scrollIntoView({ behavior: "smooth", block: "start" });
 } catch (e) {}
 // Inner scroll containers (acct list)
 var list = panel.querySelector("#acctList, .acct-list, .dash-wrap, #sbWrap");
 if (list) {
 try { list.scrollTop = 0; } catch (e) {}
 }
 try { panel.scrollTop = 0; } catch (e) {}
 }
 // Also pin the tabbar active visual
 try {
 var tab = document.querySelector('#tabbar a[href="' + (hash || "") + '"]');
 if (tab) tab.classList.add("ea-hl");
 setTimeout(function () { if (tab) tab.classList.remove("ea-hl"); }, 2800);
 } catch (e) {}
 // Give smooth-scroll time to land before we talk about the panel
 await sleep(900);
 }

 /** Show-and-tell: top-to-bottom, one step at a time, visuals stay on the
 * current target for the full spoken line (+ reading dwell when muted). */
 async function runTour(args) {
 args = args || {};
 var steps = args.steps || [];
 if (!steps.length && args.tour_id) {
 steps = presetTour(args.tour_id) || [];
 }
 if (!steps.length) return false;
 if (state.touring) return false; // one tour at a time
 state.touring = true;
 state.thinking = true; // block concurrent voice turns mid-tour
 addTool("ui.tour", (args.tour_id || steps.length + " steps"));
 setStatus("Guided tour…", "think");

 // Count narrated steps for caption
 var narrated = steps.filter(function (s) { return s && (s.say || s.selector); });
 var nIdx = 0;

 try {
 for (var i = 0; i < steps.length; i++) {
 if (!state.touring) break; // cancelled
 var s = steps[i] || {};
 var hash = s.hash || (s.navigate && s.navigate.hash);

 if (hash || s.type === "navigate") {
 var h = hash || (s.args && s.args.hash) || "#dashboard";
 if (h.charAt(0) !== "#") h = "#" + h;
 await runCommand({
 type: "navigate",
 args: { hash: h, silent: true },
 id: "tour-nav-" + i,
 });
 // Wait for the panel to mount, then always start at the TOP
 var psel = panelSelectorForHash(h) || "body";
 await waitForSelector(psel + ".active, " + psel, 3500);
 await sleep(700); // let tab transition + paint finish
 await scrollPanelTop(h);
 if (s.say) {
 setTourCaption(s.say, nIdx, narrated.length);
 nIdx++;
 await speakAndWait(s.say);
 } else {
 setTourCaption("Opened **" + tabLabel(h) + "**, starting at the top.", nIdx, narrated.length);
 nIdx++;
 await speakAndWait("Opened " + tabLabel(h) + ". Starting at the top.");
 }
 // Pause before jumping to the next control so the tab still feels settled
 await sleep(500);
 continue;
 }

 if (s.selector || s.type === "highlight") {
 // Scope wait to the active panel; never box a random/hidden match.
 var el = await waitForSelector(s.selector, s.waitMs || 4500);
 if (!el) {
 // optional steps (pipeline/KPIs that only appear with data) skip quietly
 if (s.optional) continue;
 // Skip missing sections don't invent a highlight
 if (s.say) {
 setTourCaption(s.say + " _(not on screen yet)_", nIdx, narrated.length);
 nIdx++;
 await speakAndWait(
 stripMd(s.say) + " That section isn't on the page yet."
 );
 }
 continue;
 }
 try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
 // Wait for scroll to finish BEFORE highlight + narration
 await sleep(650);
 clearHighlights();
 el.classList.add("ea-hl", "ea-hl-pulse");
 // Brief beat so the pulse is seen before the voice starts
 await sleep(400);
 var line = s.say || s.label || "";
 if (line) {
 setTourCaption(line, nIdx, narrated.length);
 nIdx++;
 // Speak ONLY while this element is highlighted (lockstep + dwell)
 await speakAndWait(line);
 } else {
 await sleep(s.ms || 3200);
 }
 // Hold the glow a moment after speech ends, then soft clear
 await sleep(550);
 clearHighlights();
 await sleep(350);
 continue;
 }

 if (s.say) {
 setTourCaption(s.say, nIdx, narrated.length);
 nIdx++;
 await speakAndWait(s.say);
 await sleep(400);
 }
 }
 } finally {
 state.touring = false;
 state.thinking = false;
 clearHighlights();
 setTourCaption(null);
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 }
 return true;
 }

 /**
 * After a visual tour, optionally pull one factual account_summary for a short
 * spoken wrap-up, strip ALL ui_commands so the model cannot re-highlight junk.
 */
 async function postTourAccountFacts(sid) {
 if (!sid) return;
 var r = await fetch(API.chat, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: sid,
 message: (
 "The visual Account tour just finished on the user's screen. " +
 "Call ONLY account_summary (include_billing true). " +
 "Reply in 2 short sentences with real values: company, email/contact_email, " +
 "plan, card-on-file. Do NOT call ui_navigate, ui_highlight, ui_tour, or ui_fill. " +
 "Do NOT invent null email."
 ),
 context: packContext(),
 source: "tour_wrap",
 }),
 });
 var d = await r.json().catch(function () { return null; });
 if (!r.ok || !d) return;
 // Explicitly ignore any UI driver commands, tour is over
 var reply = (d.reply || "").trim();
 if (!reply) return;
 addMsg("agent", reply);
 try {
 await enqueueSpeak(reply, { source: "tour_wrap" });
 } catch (e) {}
 }

 /**
 * Preset show-and-tell tours, ONE per top-bar tab.
 * Rules (non-negotiable):
 * 1. Selectors MUST match live DOM in index.html + the panel's render JS.
 * 2. Order is top → bottom of what the owner actually sees.
 * 3. optional:true for sections that only appear with data (pipeline, KPI flags).
 * 4. Never invent labels that aren't on screen (no "Reports", "Dashboard", etc.).
 */
 function presetTour(id) {
 var key = String(id || "").toLowerCase().replace(/[^a-z0-9_]/g, "");

 // ── Account (#account), sandbox.js renderAccountList ──────────────────
 // Order: Auto-refresh → Name → Company → Email → Password → Plan → Bill →
 // Payment → Online pay → Files.
 if (key === "master_account" || key === "account") {
 return [
 {
 hash: "#account",
 say: "Account. Top to bottom, auto-refresh first, then profile, plan, billing, and files.",
 },
 {
 selector: "#tabAccount",
 say: "You're on **Account** in the top bar, company, sign-in, plan, and payment live here.",
 },
 {
 selector: "#rowAutoRefresh",
 say: "**Auto-refresh** leads the page, cloud vault or this computer. That's how production and utility bills stay fresh without you babysitting logins.",
 waitMs: 6000,
 },
 {
 selector: "#panelAccount .acct-edit[data-field='name']",
 say: "**Name**, the operator on this account. Click to edit; it saves as you type.",
 optional: true,
 },
 {
 selector: "#panelAccount .acct-edit[data-field='company']",
 say: "**Company**, your business name on this account.",
 optional: true,
 },
 {
 selector: "#panelAccount .acct-edit[data-field='email'], #loginEmail",
 say: "**Email**, contact and sign-in address for this account.",
 optional: true,
 },
 {
 selector: "#rowPassword",
 say: "**Password**, set one for email login, or keep using magic links.",
 optional: true,
 },
 {
 selector: "#acctPlanVal, #acctChangePlan",
 say: "**Plan**, Live vendor data, Offtaker invoices, or Both. Change it anytime.",
 optional: true,
 },
 {
 selector: "#aoBill",
 say: "**Your bill**, what Array Operator charges *you* for this subscription. Not the offtaker invoices on the Invoices tab.",
 optional: true,
 },
 {
 selector: "#billManage, #payState",
 say: "**Payment method**, add or manage the card on file for Array Operator.",
 optional: true,
 },
 {
 selector: "#aoPaySetup, #aoPayCard",
 say: "**Online payments**, optional Stripe Connect so offtaker invoices can include a Pay button.",
 optional: true,
 },
 {
 selector: "#panelAccount .acct-files-row, #acctFilesBody",
 say: "**Your files**, templates, workbooks, and captured utility PDFs.",
 optional: true,
 },
 {
 say: "That's Account. Ask about any row if you want to dig in.",
 },
 ];
 }

 // ── Invoices (#reports), reports.js shell() ───────────────────────────
 // Real surface: Offtaker invoicing head → Offtakers/Bill audit tabs →
 // send pipeline → master rate → offtaker list + toolbar (Export, email,
 // link utility, bulk import, add offtaker).
 if (key === "reports" || key === "invoices" || key === "offtakers") {
 return [
 {
 hash: "#reports",
 say: "Invoices, offtaker solar-credit billing. Nothing emails until you approve it.",
 },
 {
 selector: "#tabReports",
 say: "You're on **Invoices** in the top bar. An offtaker is a customer who gets a share of your solar credits.",
 },
 {
 selector: "#panelReports .rb2-head, #rbSubInvoice",
 say: "This is **Offtaker invoicing**, every offtaker's credit invoice, generated from settled utility bills.",
 waitMs: 8000,
 },
 {
 selector: "#rb2Sub, #panelReports .rb2-id p, #panelReports .rb2-head",
 say: "The rule up top: invoices draft from bills, but **review before you send**, unless you flip an offtaker to auto-send later.",
 },
 {
 selector: "#rbGenTabs",
 say: "Two views here: **Offtakers** (the roster and drafts) and **Bill audit** (does GMP's allocation match the shares you entered?).",
 },
 {
 selector: "#rb2Kpis",
 say: "This glance line is the one signal the pipeline doesn't carry, whether utility bills **reconcile with GMP**.",
 optional: true,
 },
 {
 selector: "#rb2Pipe",
 say: "The **send pipeline**, last cycle delivered, this cycle's drafts waiting on bills or approval, and the next scheduled run. It appears once billing data is live.",
 optional: true,
 },
 {
 selector: "#rbGlobalRate",
 say: "**Master solar credit rate**, optional fleet override. Leave blank and each offtaker is priced from *their own* utility bill credit rate.",
 },
 {
 selector: "#panelReports .rb2-controls",
 say: "**Your offtakers** toolbar, export, email template, link utility bills, bulk import, and add offtaker all live on this row.",
 },
 {
 selector: "#rb2ExportBtn",
 say: "**Export**, download a batch for QuickBooks Online, Desktop, or Xero.",
 },
 {
 selector: "#rbEmailStudio",
 say: "**Customize email**, greeting, wording, and sign-off for every offtaker invoice, with merge tags.",
 },
 {
 selector: "#rbLinkUtility",
 say: "**Link utility bills**, connect GMP, VEC, or any of hundreds of co-ops. Offtakers invoice from these bills.",
 },
 {
 selector: "#rbBulkImport",
 say: "**Bulk import**, drop any offtaker roster spreadsheet (utility export, Excel, Google Sheets). We detect columns, match each row to an array, and you review before anything is created. Template is optional.",
 },
 {
 selector: "#rbCustAdd",
 say: "**Add an offtaker**, one at a time when you're not bulk-importing.",
 },
 {
 selector: "#rbOSearch, #rbList .rb-acc-lead, #rbList",
 say: "Search and the **offtaker list** sit below. Each card is a customer: share, rate, draft invoices, template, and send mode.",
 waitMs: 6000,
 },
 {
 selector: "#rbList .rb-acc, #rbList .rb-grp, #rbList .rb-prov",
 say: "Open any offtaker card to review their draft, edit share or rate, upload a template, and approve send.",
 optional: true,
 },
 {
 say: "That's Invoices end to end, real controls only, top to bottom. Say *Bill audit* or name an offtaker if you want to go deeper.",
 },
 ];
 }

 // ── Fleet sub-views: Triage | Table | Sandbox ───────────────
 if (key === "arrays" || key === "inverters" || key === "sandbox" || key === "spreadsheet" || key === "dashboard") {
 return [
 {
 hash: "#dashboard",
 say: "**Fleet** has three sub-views: **Triage** (who needs attention), **Table** (rows by vendor), and **Sandbox** (spatial fleet tree).",
 },
 {
 selector: "#tabDashboard",
 say: "You're on **Fleet** in the top bar.",
 },
 {
 selector: "#panelDashboard .ft-sub-seg, #panelDashboard .vs-seg",
 say: "Sub-views: **Triage** · **Table** · **Sandbox**. Same fleet data, different lenses.",
 },
 {
 selector: "#vsSegDashboard",
 say: "**Triage**, whole-fleet health and the Needs attention queue.",
 optional: true,
 },
 {
 selector: "#vsSegSandbox",
 say: "**Sandbox**, columns are sites, prongs are real inverters. Drag to rearrange how *you* think about the fleet.",
 },
 {
 selector: "#vsSegSheet",
 say: "**Table**, every vendor and array as expandable rows: today, peers, status.",
 },
 {
 selector: "#sbWrap .sb-head, #sbViewMode",
 say: "The toolbar: **Overview** grid versus **Tree** drill-in, undo/redo, full screen, show all inverters, and reset layout.",
 optional: true,
 },
 {
 selector: "#sbAddArray",
 say: "**Add array**, one-click vendor login or link a utility. Manual keys stay behind a secondary option.",
 optional: true,
 },
 {
 selector: "#sandbox .sb-tile, #sandbox .sb-col, #sandbox",
 say: "The canvas itself, click a site to zoom in; inverter cards show live output, peer health, and dollars at stake.",
 waitMs: 6000,
 },
 {
 selector: "#vendorSheet .vs-headrow, #vendorSheet",
 say: "If you're on Spreadsheet, this header is search, add vendor, and sync, rows expand to every inverter.",
 optional: true,
 },
 {
 say: "That's Inverters. Name a site, or say *switch to spreadsheet*, if you want a closer look.",
 },
 ];
 }

 // ── Analysis (#analysis), analysis.js shell + sections ────────────────
 if (key === "analysis" || key === "trends" || key === "fleet_analysis") {
 return [
 {
 hash: "#analysis",
 say: "Analysis, deeper fleet digs. Trends is a sub-view here, not its own top tab.",
 },
 {
 selector: "#tabAnalysis",
 say: "You're on **Analysis** in the top bar.",
 },
 {
 selector: "#panelAnalysis .an-sub-seg, #panelAnalysis .vs-seg",
 say: "Segmented control: **Fleet analysis** (NOC), **Trends** (multi-year), and **Resources** (rates & news).",
 },
 {
 selector: "#analysisRoot .an-head, #analysisRoot .an-wrap",
 say: "**Fleet analysis** header, portfolio performance, weather-adjusted, with a live-or-stale data stamp.",
 waitMs: 7000,
 },
 {
 selector: "#anSections [data-section='fleet-summary'], #anSections [data-section='health-kwhkw'], #anSections",
 say: "Sections stack below: portfolio rollup, health, through-time, sites grid, performance, hardware, alarms, scroll the page.",
 optional: true,
 },
 {
 selector: "#anSections [data-section='sites-grid']",
 say: "**Sites**, every array weather-adjusted actual versus expected. Sort and search to find underperformers.",
 optional: true,
 },
 {
 selector: "#anSections [data-section='performance']",
 say: "**Performance**, performance index and capacity factor across the fleet.",
 optional: true,
 },
 {
 selector: "#panelAnalysis [data-ansub='trends']",
 say: "Tap **Trends** anytime for long-run portfolio charts. There is no separate Trends tab in the top bar.",
 },
 {
 say: "That's Analysis. Ask about a section by name if you want detail.",
 },
 ];
 }

 // ── Fleet (#dashboard), command-center.js ──────────────────────
 if (key === "dashboard" || key === "fleet_triage" || key === "triage" || key === "fleet") {
 return [
 {
 hash: "#dashboard",
 say: "Fleet → Triage, who needs attention across the whole fleet, worst first.",
 },
 {
 selector: "#tabDashboard",
 say: "You're on **Fleet** in the top bar.",
 },
 {
 selector: "#panelDashboard .dash-head, #dashProd",
 say: "The header is **Triage** plus a live production strip, kilowatts now, kilowatt-hours today, arrays producing.",
 waitMs: 6000,
 },
 {
 selector: "#fleetCommander .fcg, #fleetCommander",
 say: "KPI tiles, fleet healthy percent, array and inverter counts, flagged, critical, watch, recoverable dollars, and monitoring.",
 },
 {
 selector: "#fleetCommander .fcg-tile--health, #fleetCommander .fcg-tile",
 say: "**Fleet healthy** leads, blue when the fleet is in good shape, orange when health drops.",
 optional: true,
 },
 {
 selector: "#fleetCommander .fcg-tile--risk",
 say: "**Recoverable**, monthly dollars you can get back by fixing flagged inverters. Zero means all clear.",
 optional: true,
 },
 {
 selector: "#fcAlerts",
 say: "**Alerts**, email when an inverter goes down or underperforms. Sensitivity and frequency live in that panel.",
 optional: true,
 },
 {
 selector: "#dashAttnH",
 say: "Below the tiles: **Needs attention** when something is flagged, or **All clear** when the fleet is clean.",
 },
 {
 selector: "#ccQueue",
 say: "The attention queue, search, severity chips, and every flagged inverter worst-first. Open a row to jump into that site.",
 optional: true,
 },
 {
 say: "That's Fleet. Ask about a flagged site if you want a diagnosis.",
 },
 ];
 }

 // ── Resources (#resources), Analysis third sub-view ──────────────────
 if (key === "resources" || key === "briefing" || key === "rates") {
 return [
 {
 hash: "#resources",
 say: "Resources lives under **Analysis** — net-metering context, REC market, and regulatory news for your state.",
 },
 {
 selector: '#tabAnalysis, .an-sub-seg [data-ansub="resources"]',
 say: "Open **Analysis**, then the **Resources** segment.",
 },
 {
 selector: "#panelResources #rsHost, #resApp",
 say: "The briefing shell loads here, state picker, live news, REC market, and reference cards.",
 waitMs: 8000,
 },
 {
 selector: "#resEyebrow",
 say: "The eyebrow names which state's operator briefing you're reading.",
 optional: true,
 },
 {
 selector: "#panelResources .res-picker, #rsHost .res-picker",
 say: "**Your state**, pick Vermont, New Hampshire, and the other New England states. News and rates follow that choice.",
 optional: true,
 },
 {
 selector: "#resFeed, #resNewsMeta, #panelResources .newshead",
 say: "**Latest and live**, commission dockets, rate cases, and REC moves for *your* state, refreshed daily.",
 optional: true,
 },
 {
 selector: "#panelResources .res-rec-sec, #panelResources .res-rec-card",
 say: "**REC market**, indicative Class I pricing and how certificates work in your state. Reference only, confirm before counting dollars.",
 optional: true,
 },
 {
 selector: "#panelResources .card, #rsHost .card",
 say: "Reference cards cover compensation style, key utilities, regulatory status, and links to primary sources.",
 optional: true,
 },
 {
 say: "That's Analysis → Resources. Change the state chip anytime to re-scope the briefing.",
 },
 ];
 }

 return null;
 }
 function fill(sel, value) {
 if (!sel) return false;
 var el = document.querySelector(sel);
 if (!el) return false;
 el.focus();
 if ("value" in el) {
 el.value = value == null ? "" : String(value);
 el.dispatchEvent(new Event("input", { bubbles: true }));
 el.dispatchEvent(new Event("change", { bubbles: true }));
 }
 highlight(sel);
 return true;
 }
 function clickEl(sel) {
 if (!sel) return false;
 var el = document.querySelector(sel);
 if (!el) return false;
 highlight(sel);
 el.click();
 return true;
 }
 async function apiProxy(args) {
 var path = args.path;
 if (!path) return false;
 var r = await fetch(path, {
 method: args.method || "GET",
 headers: authHeaders(),
 body: args.body ? JSON.stringify(args.body) : undefined,
 });
 var d = null;
 try { d = await r.clone().json(); } catch (e) { d = null; }
 if (args.open_url_field) {
 var url = d && (d[args.open_url_field] || d.url || d.portal_url);
 if (url) window.open(url, "_blank", "noopener");
 }
 if (r.ok) {
 softRefreshUi(Object.assign({}, args.body || {}, d && d.subscription ? {
 subscription_id: d.subscription.id,
 allocation_pct: d.subscription.allocation_pct,
 array_share_pct: d.subscription.array_share_pct,
 } : {}));
 } else {
 var errDetail = (d && d.detail) || ("HTTP " + r.status);
 addMsg("agent", "Couldn't save that change: " + String(errDetail).slice(0, 180));
 }
 return r.ok;
 }

 window.__eaDriver = {
 navigate: function (h) { return runCommand({ type: "navigate", args: { hash: h }, id: "drv" }); },
 highlight: highlight,
 fill: fill,
 click: clickEl,
 };

 // ── Voice: GPT Realtime WebRTC (primary) + Web Speech fallback ───────────
 // Latest model (server-side): gpt-realtime-2.1 via /v1/energy-agent/realtime-call

 function syncMicBtn() {
 var b = document.getElementById("eaMic");
 if (!b) return;
 b.classList.toggle("on", state.listening);
 // NEVER set b.textContent — that wipes the SVG mic icon (Ford 2026-07-16)
 var lbl = b.querySelector(".ea-chip-lbl");
 if (lbl) lbl.textContent = state.listening ? "Live" : "Mic";
 var tip = state.listening ? "Microphone on — click to turn off" : "Turn microphone on";
 b.title = tip;
 b.setAttribute("aria-label", tip);
 b.setAttribute("aria-pressed", state.listening ? "true" : "false");
 }

 function syncMuteBtn() {
 var b = document.getElementById("eaMute");
 if (!b) return;
 var muted = !!state.voiceMuted;
 b.classList.toggle("on", muted);
 b.setAttribute("aria-pressed", muted ? "true" : "false");
 var ic = b.querySelector(".ea-chip-ic");
 var lbl = b.querySelector(".ea-chip-lbl");
 if (ic) ic.textContent = muted ? "🔇" : "🔊";
 if (lbl) lbl.textContent = muted ? "Muted" : "Mute";
 var tip = muted
 ? "Voice muted (text only) — click to turn agent voice back on"
 : "Mute agent voice (text only, saves credits)";
 b.title = tip;
 b.setAttribute("aria-label", tip);
 }

 /** Soft-mute Realtime <audio> element without tearing down the WebRTC pipe. */
 function applyVoiceMuteToAudio() {
 if (state.audioEl) {
 try {
 state.audioEl.muted = !!state.voiceMuted;
 state.audioEl.volume = state.voiceMuted ? 0 : 1;
 } catch (e) {}
 }
 }

 /**
 * Mute = TEXT ONLY. Tear down GPT Realtime entirely so we don't burn OpenAI
 * credits on a silent voice pipe (mic VAD / transcription / session).
 * Unmute reconnects voice if the panel is open.
 */
 function setVoiceMuted(muted) {
 state.voiceMuted = !!muted;
 try { localStorage.setItem("ea_voice_muted", state.voiceMuted ? "1" : "0"); } catch (e) {}
 if (state.voiceMuted) {
 // Full teardown of Realtime + browser TTS, not soft mute on the <audio> tag
 try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
 try { cancelRealtimeIfActive(); } catch (e) {}
 state.speaking = false;
 state.rtResponseActive = false;
 state._speakSeq++;
 if (typeof state._onSpeakDone === "function") {
 try { state._onSpeakDone(); } catch (e) {}
 }
 // Drop WebRTC / Realtime session completely (credits stop here)
 try { stopVoice(false); } catch (e) {}
 state.realtimeReady = false;
 if (state.open && !state.touring) {
 setStatus("Text only, voice off", "on");
 }
 } else {
 applyVoiceMuteToAudio();
 if (state.open && signedIn() && !state.touring) {
 setStatus("Connecting voice…", "think");
 // Fire-and-forget reconnect
 startVoice(true).then(function () {
 if (!state.voiceMuted && state.open) {
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 }
 }).catch(function () {
 if (!state.voiceMuted && state.open) setStatus("Ready", "on");
 });
 } else if (state.open && !state.touring) {
 setStatus("Ready", "on");
 }
 }
 syncMuteBtn();
 syncMicBtn();
 }

 function isVoiceMuted() { return !!state.voiceMuted; }

 /**
 * Mute/unmute mic tracks WITHOUT tearing down WebRTC.
 * Killing the data channel was forcing TTS into robotic browser speechSynthesis.
 */
 function setMicListening(on) {
 if (state.micStream) {
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = !!on; });
 } catch (e) {}
 }
 state.listening = !!on;
 // User explicitly muted, cancel any hold-for-speak so we don't re-open
 if (!on) state._micHeldForSpeak = false;
 if (state._unmuteAfterSpeakTimer) {
 try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
 state._unmuteAfterSpeakTimer = null;
 }
 if (state.voiceMode === "webspeech") {
 if (!on && state.recog) {
 try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
 state.recog = null;
 }
 }
 // Clear any residual input buffer on mute so VAD doesn't fire ghosts
 if (!on && state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 syncMicBtn();
 }

 /**
 * Guarded barge-in (GPT Live style — Ford 2026-07-16):
 * - Short attack mute so speaker lead-in doesn't self-interrupt.
 * - Then mic OPEN so the owner can cut in mid-sentence (real conversation).
 * - Greeting only: full hold (intro was always killed by bleed).
 * - Echo / backchannels filtered in acceptUserTranscript, not by muting forever.
 */
 function holdMicWhileSpeaking(hold, opts) {
 opts = opts || {};
 if (state._unmuteAfterSpeakTimer) {
 try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
 state._unmuteAfterSpeakTimer = null;
 }
 if (hold) {
 state._speakStartedAt = Date.now();
 state._micHeldForSpeak = true;
 // Full hold ONLY for the short greeting intro — never for normal answers
 // (that killed GPT-Live interruptibility).
 // Full-hold the mic for the WHOLE utterance in mouth-only mode. Her own
 // speaker audio was bleeding into the mic (reopened ~550ms in), getting
 // transcribed as GARBLED "user" speech that slipped past the echo filter and
 // self-interrupted her mid-sentence — "the mouth pops, then it just gives up"
 // (Ford 2026-07-16). Turn-taking, not barge-in: the mic reopens 400ms after
 // she finishes. Greeting always full-holds; weave keeps GPT-Live barge-in.
 // window.__EA_MIC_BARGE_IN=true restores the old reopen-mid-answer behavior.
 var _forceBarge = (window.__EA_MIC_BARGE_IN === true);
 state._holdMicFull = !_forceBarge && (
 opts.source === "greeting" || !VOICE_WEAVE || opts.holdMicFull === true
 );
 try {
 if (state.micStream) {
 state.micStream.getTracks().forEach(function (t) { t.enabled = false; });
 }
 } catch (e) {}
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 if (state._holdMicFull) return;
 // Attack mute only (~0.55s), then open for real barge-in
 var muteMs = parseInt(window.__EA_ATTACK_MUTE_MS, 10);
 if (!muteMs || muteMs < 200) muteMs = 550;
 if (muteMs > 2000) muteMs = 2000;
 state._unmuteAfterSpeakTimer = setTimeout(function () {
 state._unmuteAfterSpeakTimer = null;
 state._micHeldForSpeak = false;
 if (!state.listening || !state.micStream) return;
 // Don't reopen mic while deep brain is thinking-silent (we open there explicitly)
 if (state._silenceUntilDeepAnswer) return;
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 }, muteMs);
 return;
 }
 // Speech finished, ensure mic is open after a short settle (room reverb)
 state._micHeldForSpeak = false;
 state._holdMicFull = false;
 state._unmuteAfterSpeakTimer = setTimeout(function () {
 state._unmuteAfterSpeakTimer = null;
 if (!state.listening || !state.micStream) return;
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 }, 400);
 }

 /** True while agent audio is playing (informational, does not alone block barge-in). */
 function isAgentMouthBusy() {
 return !!(state.speaking || state.rtResponseActive);
 }

 // ── Pure-voice freestyle backstop (mouth-only) ────────────────────────
 // Silence the WEBRTC audio element itself, so a freestyle is never HEARD even
 // if the Realtime API ignores response.cancel or create_response leaked ON.
 function _muteMouthEl() {
 try { if (state.audioEl) { state.audioEl.muted = true; state.audioEl.volume = 0; } } catch (e) {}
 }
 function _unmuteMouthEl() {
 // Respect the user's own voice-mute; otherwise restore audible.
 try {
 if (state.audioEl) {
 state.audioEl.muted = !!state.voiceMuted;
 state.audioEl.volume = state.voiceMuted ? 0 : 1;
 }
 } catch (e) {}
 }
 function _killFreestyle(rid) {
 _muteMouthEl();
 try {
 if (state.dc && state.dc.readyState === "open") {
 state.dc.send(JSON.stringify({ type: "response.cancel" }));
 state.dc.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
 }
 } catch (e) {}
 state.rtResponseActive = false;
 state.speaking = false;
 state._freestyleId = rid || state._freestyleId || null;
 if (window.console && console.warn) {
 console.warn("[EA] muted+killed undriven pure-voice response", rid || "");
 }
 }

 /** Hard stop / hold phrases, always interrupt, even mid-think / mid-tour / mid-speech. */
 function isStopCommand(said) {
 var t = String(said || "")
 .replace(/[^\w\s']/g, " ")
 .replace(/\s+/g, " ")
 .trim()
 .toLowerCase();
 if (!t) return false;
 if (
 /^(stop|wait|cancel|pause|enough|quiet|silence|hold on|hold up|shut up|never mind|nevermind|forget it)$/.test(
 t
 )
 ) {
 return true;
 }
 if (
 /^(stop (it|please|talking|now|that)|please stop|just stop|can you stop|shut up)$/.test(t)
 ) {
 return true;
 }
 if (/\b(stop talking|stop please|please stop|just stop)\b/.test(t)) return true;
 return false;
 }

 /**
 * Abort speech, in-flight chat, and tours. Same mind, just stops the mouth/work
 * the user can hear. Background mind tasks may still finish quietly.
 */
 function handleStopCommand() {
 abortInFlightTurn("stop");
 if (state._interimSteerTimer) {
 try { clearTimeout(state._interimSteerTimer); } catch (e) {}
 state._interimSteerTimer = null;
 }
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 // Ensure mic is live after stop so the next ask is heard
 if (state.listening && state.micStream) {
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 }
 state._micHeldForSpeak = false;
 addMsg("agent", "Stopped.");
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 // Short ack only — settle after cancel so we don't stack on residual audio
 setTimeout(function () {
 if ((state._turnAbortGen || 0) && state.speaking) return;
 enqueueSpeak("Okay, stopped.", { source: "stop", force: true }).catch(function () {});
 }, 150);
 }

 /**
 * Whether a user transcript should start a turn (incl. mid-agent-speech barge-in).
 * Harder bar while the agent is talking so speaker bleed / room noise don't cut it off.
 * STOP always wins. Mid-think real questions also barge in (abort prior work).
 */
 function acceptUserTranscript(said) {
 if (!said || !state.listening) return false;
 // Stop / wait / cancel: always accept (even mid-think / mid-tour)
 if (isStopCommand(said)) return true;
 // First intro must finish, speaker bleed was cutting it every time
 if (state._greetingPlaying) return false;
 var now = Date.now();
 // Echo is our OWN audio bleeding into the mic — physically possible only while
 // she is speaking or within a brief tail after playback stops. Outside that
 // window a transcript is the user genuinely talking, even an on-topic follow-up
 // that reuses words from the long answer she just gave. Time-box the echo
 // filter so real follow-ups are never eaten as "echo." (Bug, Ford 2026-07-16:
 // _lastSpokenPlain was never cleared, so every topical follow-up matched the
 // whole prior answer at 40% word-overlap and was dropped — while off-topic
 // complaints, which don't overlap, were the only thing getting through.)
 var echoGuardMs = parseInt(window.__EA_ECHO_GUARD_MS, 10);
 if (!echoGuardMs || echoGuardMs < 300) echoGuardMs = 1200;
 var withinEchoWindow =
 isAgentMouthBusy() ||
 state._micHeldForSpeak ||
 (state._speakEndedAt && now - state._speakEndedAt < echoGuardMs);
 if (withinEchoWindow && looksLikeEchoOfLastSpeech(said)) return false;
 if (isGarbageTranscript(said)) return false;
 // On SILENCE the transcriber can hallucinate its own vocabulary prompt
 // (EA_STT_PROMPT) as if the owner spoke it — Ford opened the panel, said
 // nothing, and the whole vocab list posted as "him" (2026-07-19). Reject any
 // transcript that is really the prompt echoing back.
 if (isInternalSteeringText(said)) return false;
 var saidKey = said.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
 // Stronger dedupe: double STT events were starting two full replies
 if (
 state._lastUserSaid &&
 saidKey === state._lastUserSaid &&
 now - (state._lastUserSaidAt || 0) < 2800
 ) {
 return false;
 }
 var words = said.trim().split(/\s+/).filter(Boolean);
 // Mid-think: allow a real multi-word redirect (not noise). Abort prior turn in handler.
 if (state.thinking || state._turnBusy) {
 if (words.length < 3 && said.trim().length < 16) return false;
 return true;
 }
 // Mid-tour: allow barge-in with real speech so user can redirect
 if (state.touring) {
 if (words.length < 2 && said.trim().length < 12) return false;
 return true;
 }
 // Mid-speech / mid-think: GPT Live interruptibility — real speech cuts in.
 // Backchannels + echo still blocked so speaker bleed doesn't self-cancel.
 if (
 isAgentMouthBusy() ||
 state._micHeldForSpeak ||
 state._silenceUntilDeepAnswer ||
 state._consultInFlight
 ) {
 var t = said.trim().replace(/[.!?]+$/, "").toLowerCase();
 var isBackchannel = /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|k|sure|right|alright|uh ?huh|mm ?hmm|mhm|hmm|got it|i see|gotcha|makes sense|nice|cool|wow|nvm|hey|go on|keep going|continue|and\??|so\??|uh|um|ah)$/.test(t);
 if (isBackchannel) return false;
 // Weave: lower bar (3 words) so natural cut-ins work. Override if needed.
 var defWords = VOICE_WEAVE ? 3 : 5;
 var defChars = VOICE_WEAVE ? 10 : 18;
 var minWords = parseInt((window.__EA_BARGE_MIN_WORDS || defWords), 10) || defWords;
 var minChars = parseInt((window.__EA_BARGE_MIN_CHARS || defChars), 10) || defChars;
 if (words.length < minWords || said.trim().length < minChars) {
 return false;
 }
 if (transcriptOverlapsSpeech(said, state._lastSpokenPlain, 0.5)) {
 return false;
 }
 return true;
 }
 return true;
 }

 /** Drop echo transcripts that closely match what we just spoke. */
 function looksLikeEchoOfLastSpeech(said) {
 var a = String(said || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
 var b = String(state._lastSpokenPlain || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
 if (!a || !b) return false;
 if (a === b) return true;
 if (a.length >= 12 && (b.indexOf(a) !== -1 || a.indexOf(b) !== -1)) return true;
 // Overlap on first ~6 words
 var aw = a.split(" ").slice(0, 8).join(" ");
 var bw = b.split(" ").slice(0, 8).join(" ");
 if (aw.length >= 10 && (bw.indexOf(aw) !== -1 || aw.indexOf(bw) !== -1)) return true;
 // Word-set overlap (mid-utterance bleed often matches later words, not the lead)
 if (transcriptOverlapsSpeech(a, b, 0.4)) return true;
 return false;
 }

 /** True when ≥frac of transcript content-words appear in the spoken line. */
 function transcriptOverlapsSpeech(said, spoken, frac) {
 var aw = String(said || "")
 .toLowerCase()
 .replace(/[^\w\s']/g, " ")
 .replace(/\s+/g, " ")
 .trim()
 .split(" ")
 .filter(function (w) {
 return w.length > 2 && !/^(the|and|for|that|this|with|you|your|are|was|has|have|its|from|into|about)$/.test(w);
 });
 var bw = String(spoken || "")
 .toLowerCase()
 .replace(/[^\w\s']/g, " ")
 .replace(/\s+/g, " ")
 .trim()
 .split(" ")
 .filter(Boolean);
 if (aw.length < 2 || !bw.length) return false;
 var set = {};
 for (var i = 0; i < bw.length; i++) set[bw[i]] = true;
 var hit = 0;
 for (var j = 0; j < aw.length; j++) {
 if (set[aw[j]]) hit++;
 }
 return hit / aw.length >= (frac || 0.45);
 }

 /**
 * Drop ghost VAD turns: empty-ish, filler-only, or noise that transcription
 * turns into a single throwaway word. Still allows short real acks (yes/no/ok).
 */
 function isGarbageTranscript(said) {
 var clean = String(said || "")
 .replace(/[^\w\s']/g, " ")
 .replace(/\s+/g, " ")
 .trim()
 .toLowerCase();
 if (!clean) return true;
 var words = clean.split(" ").filter(Boolean);
 if (!words.length) return true;
 // Explicit short confirmations / greetings, keep
 var ack =
 /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|go|please|thanks|thank you|hi|hello|hey|ready|stop|cancel|wait|help)$/;
 var joined = words.join(" ");
 if (
 ack.test(joined) ||
 /^(go ahead|do it|yes please|no thanks|never mind|nevermind)$/.test(joined)
 ) {
 return false;
 }
 // Filler / breathing noise
 if (words.every(function (w) {
 return /^(um+|uh+|ah+|er+|hm+|hmm+|mm+|m+|huh|eh+)$/.test(w);
 })) {
 return true;
 }
 // One tiny token that isn't an ack (clicks often become "a", "i", "the")
 if (words.length === 1 && words[0].length <= 2) return true;
 // Single very short mystery word from room noise (allow ≥4 chars, real words)
 if (words.length === 1 && words[0].length < 3) return true;
 return false;
 }

 /** Shared VAD knobs, keep in sync with api/energy_agent._realtime_session_config */
 function realtimeVadConfig() {
 return {
 type: "server_vad",
 // Higher = less sensitive (default 0.5 is jumpy with fans/keys/speakers).
 // 0.85 ignores more room hiss / speaker bleed ghosts (Ford 2026-07-16 mid-cut).
 threshold: 0.85,
 prefix_padding_ms: 320,
 // Wait longer before declaring end-of-speech so multi-clause asks
 // ("I'm looking at X and Y and it doesn't look good, can we fix…")
 // aren't cut mid-thought (Ford 2026-07-14).
 silence_duration_ms: 1600,
 // Option D weave: Realtime answers on its own; legacy mouth-only = false
 create_response: !!VOICE_WEAVE,
 interrupt_response: !!VOICE_WEAVE,
 };
 }

 /** Option D Realtime session tools — one tool: consult the deep Claude brain. */
 function realtimeWeaveTools() {
 return [
 {
 type: "function",
 name: "consult_deep_brain",
 description:
 "DEFAULT TOOL — call this on almost every turn. It is your smart brain for THIS " +
 "tenant: full product map, fleet tools, invoices, repairs, screen tours/navigation. " +
 "ALWAYS call for: walkthroughs, tabs (Analysis/Invoices/Inverters/etc), fleet health, " +
 "kWh/$, offtakers, repairs, how something works, what to do next, confirmations. " +
 "ONLY skip for pure social (hi/thanks/mm-hmm/are you there).",
 parameters: {
 type: "object",
 properties: {
 question: {
 type: "string",
 description:
 "What to investigate or do, in clear English. Include the owner's " +
 "exact ask and any tab/site names. For UI tours, say e.g. " +
 "'Walk the owner through the Analysis tab step by step using product_map.'",
 },
 reason: {
 type: "string",
 description: "Why (e.g. ui_tour, fleet_health, money, product_how).",
 },
 },
 required: ["question"],
 },
 },
 ];
 }

 function realtimeWeaveInstructions() {
 return (
 "You are Energy Agent — live voice of Array Operator. Warm, sharp, brief like GPT Live. " +
 "CRITICAL RULE — you are NOT smart enough alone about this product. Your intelligence " +
 "comes from consult_deep_brain. DEFAULT: call consult_deep_brain EVERY turn before " +
 "answering (walkthroughs, tabs, fleet, money, how-to). " +
 "SILENCE WHILE WORKING: when you need the tool, call it immediately and stay COMPLETELY " +
 "QUIET until the tool result arrives. Do NOT say 'one second', 'thinking', 'just a moment', " +
 "'let me check', or anything else while waiting. Do NOT narrate failures or 'that didn't work' " +
 "while a tool is in flight. After the tool returns, speak spoken_answer faithfully. " +
 "Never invent UI labels, buttons, steps, kWh, or $. " +
 "ONLY answer without the tool for pure social: hi, thanks, ok, mm-hmm, are you there, bye. " +
 "Never narrate tool names. Be one person."
 );
 }

 /** Pure social — Realtime may answer alone. Everything else → deep brain. */
 function isPureSocialVoice(said) {
 var t = String(said || "")
 .toLowerCase()
 .replace(/[^\w\s']/g, " ")
 .replace(/\s+/g, " ")
 .trim();
 if (!t) return true;
 if (isStopCommand(said)) return false;
 // Explicit social / presence / backchannels only
 if (
 /^(hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|bye|goodbye|see you|good night|good morning|good evening|are you there|you there|can you hear me|you hear me|still there|got it|gotcha|i see|mm hmm|mhm|uh huh|yeah|yep|yup|nah|nope|hmm|hm)$/.test(
 t
 )
 ) {
 return true;
 }
 // 1–2 word pure acks
 var words = t.split(" ").filter(Boolean);
 if (words.length <= 2 && /^(yes|no|ok|okay|sure|thanks|hi|hey|hello|right|alright)$/.test(words[0])) {
 return true;
 }
 return false;
 }

 /** Quiet while deep brain runs — no filler, no fake "didn't work" monologues.
 * Mic stays OPEN so the owner can barge-in mid-think (GPT Live). */
 function beginDeepThinkSilence() {
 state._silenceUntilDeepAnswer = true;
 state._clientForcedConsult = true;
 state._consultInFlight = true;
 // Kill freestyle / "one second" / panic-recovery speech
 try {
 cancelRealtimeIfActive();
 } catch (e) {}
 try {
 stopSpeak({ reason: "deep_think_silence" });
 } catch (e2) {}
 // Mic live for interrupts while she thinks
 state._micHeldForSpeak = false;
 state._holdMicFull = false;
 if (state.listening && state.micStream) {
 try {
 state.micStream.getTracks().forEach(function (t) {
 t.enabled = true;
 });
 } catch (eMic) {}
 }
 // Re-cancel freestyle races only (do not re-mute mic)
 if (state._silenceCancelTimer) {
 try {
 clearTimeout(state._silenceCancelTimer);
 } catch (e3) {}
 }
 var n = 0;
 function poke() {
 if (!state._silenceUntilDeepAnswer) return;
 // Don't cancel OUR own driven narration/answer — only GPT freestyle.
 if (!state._drivenSpeak) {
 try {
 cancelRealtimeIfActive();
 } catch (e4) {}
 }
 n += 1;
 if (n < 6) {
 state._silenceCancelTimer = setTimeout(poke, 150);
 } else {
 state._silenceCancelTimer = null;
 }
 }
 state._silenceCancelTimer = setTimeout(poke, 80);
 setStatus("Thinking…", "think");
 }

 function endDeepThinkSilence() {
 state._silenceUntilDeepAnswer = false;
 state._clientForcedConsult = false;
 state._consultInFlight = false;
 if (state._silenceCancelTimer) {
 try {
 clearTimeout(state._silenceCancelTimer);
 } catch (e) {}
 state._silenceCancelTimer = null;
 }
 }

 /**
 * Handle one streamed consult event: a "thinking" line (spoken live in GPT's
 * voice as the brain works) or the final "answer" (paint panel + speak + drive UI).
 */
 function handleConsultEvent(ev, gen) {
 if (!ev || gen !== state._consultGen) return;
 if (ev.type === "thinking") {
 var txt = ownerFacingSpeak(ev.text || "");
 if (!txt) return;
 setStatus("Thinking…", "think");
 // Driven speech: the silence guard lets this play (state._drivenSpeak).
 enqueueSpeak(txt, { source: "narration", force: true, holdMicFull: false })
 .catch(function () {});
 } else if (ev.type === "answer") {
 if (ev.budget) setBudget(ev.budget);
 if (ev.pending) showPending(ev.pending);
 else showPending(null);
 var reply = ownerFacingText(ev.panel || "");
 var spoken =
 ownerFacingSpeak((ev.spoken && String(ev.spoken).trim()) || reply) || reply;
 if (reply) {
 addMsg("agent", reply, { spoken: spoken });
 state._lastAgentBubble = reply.slice(0, 200);
 state._suppressNextAgentTranscript = true;
 }
 clearTools();
 var cmds = ev.ui_commands || [];
 cmds = coerceTourCommands(cmds, "");
 (async function () {
 for (var i = 0; i < cmds.length; i++) {
 try {
 await runCommand(cmds[i]);
 } catch (e) {}
 }
 })();
 if (spoken) {
 enqueueSpeak(String(spoken).slice(0, 1400), {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 }
 }
 }

 /**
 * Streamed deep consult (Option D + live narration). NDJSON: "thinking" lines
 * are spoken as the brain calls each tool; the final "answer" is Claude's
 * tool-grounded reply. Returns a promise that resolves when the stream ends.
 */
 function consultDeepBrainStream(q, gen) {
 var question = String(q || "").trim() || "Help with what the owner just asked.";
 if (!state.sessionId) {
 return consultDeepBrain(question).then(function (res) {
 var line = (res && res.spoken_answer) || (res && res.panel_text) || "";
 if (line && gen === state._consultGen) {
 enqueueSpeak(String(line).slice(0, 1400), { source: "chat", force: true });
 }
 });
 }
 setStatus("Thinking…", "think");
 state.thinking = true;
 state._turnBusy = true;
 state._consultInFlight = true;
 var chatCtx = packContext() || {};
 chatCtx.voice_active = true;
 chatCtx.voice_weave = true;
 var gotAnswer = false;
 return fetch(API.voiceConsultStream, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 message: question,
 context: chatCtx,
 source: "voice_consult",
 }),
 })
 .then(function (r) {
 if (!r.ok || !r.body || !r.body.getReader) {
 // Stream unsupported/failed → single-shot fallback
 return consultDeepBrain(question).then(function (res) {
 if (gen !== state._consultGen) return;
 var line = (res && res.spoken_answer) || (res && res.panel_text) || "";
 if (line) enqueueSpeak(String(line).slice(0, 1400), { source: "chat", force: true });
 });
 }
 var reader = r.body.getReader();
 var dec = new TextDecoder();
 var buf = "";
 function pump() {
 return reader.read().then(function (res) {
 if (res.done) return;
 if (gen !== state._consultGen) {
 try { reader.cancel(); } catch (e) {}
 return;
 }
 buf += dec.decode(res.value, { stream: true });
 var lines = buf.split("\n");
 buf = lines.pop();
 for (var i = 0; i < lines.length; i++) {
 var ln = (lines[i] || "").trim();
 if (!ln) continue;
 var ev;
 try { ev = JSON.parse(ln); } catch (e) { continue; }
 if (ev.type === "answer") gotAnswer = true;
 handleConsultEvent(ev, gen);
 }
 return pump();
 });
 }
 return pump();
 })
 .catch(function () {
 if (gen === state._consultGen && !gotAnswer) {
 enqueueSpeak("Sorry — try that once more?", { source: "chat", force: true })
 .catch(function () {});
 }
 })
 .then(function () {
 state.thinking = false;
 state._turnBusy = false;
 state._consultInFlight = false;
 });
 }

 /**
 * Client-enforced deep consult (Option D hard mode). Realtime freestyles too often;
 * for any non-social ask we stay quiet, call Claude, then speak only the result.
 * Barge-in bumps _consultGen so a superseded fetch never speaks late.
 */
 function weaveForceDeepConsult(userSaid) {
 var q = String(userSaid || "").trim();
 if (!q) return;
 // Allow barge-in mid-consult: supersede the in-flight one
 state._consultGen = (state._consultGen || 0) + 1;
 var gen = state._consultGen;
 beginDeepThinkSilence();
 // Live thinking-narration: stream the brain's real tool calls and speak them
 // out loud AS it works, then the answer. Falls back to single-shot on error.
 if (VOICE_NARRATE) {
 consultDeepBrainStream(q, gen)
 .then(function () {
 if (gen !== state._consultGen) return;
 endDeepThinkSilence();
 })
 .catch(function () {
 if (gen !== state._consultGen) return;
 endDeepThinkSilence();
 });
 return;
 }
 consultDeepBrain(q)
 .then(function (result) {
 if (gen !== state._consultGen) return; // interrupted by newer ask
 endDeepThinkSilence();
 if (result && result.ok === false && !result.spoken_answer) {
 enqueueSpeak("Sorry — I didn't get that through. Try once more?", {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 return;
 }
 var line =
 (result && result.spoken_answer) ||
 (result && result.panel_text) ||
 "";
 if (!line) return;
 enqueueSpeak(String(line).slice(0, 1400), {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 })
 .catch(function () {
 if (gen !== state._consultGen) return;
 endDeepThinkSilence();
 enqueueSpeak("Sorry — try that once more?", {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 });
 }

 /**
 * Option D: deep brain consult. Paints the panel from Claude, returns a compact
 * payload for Realtime to speak — never starts a second parallel monologue.
 */
 function consultDeepBrain(question, callId) {
 var q = String(question || "").trim();
 if (!q) q = "Help with what the owner just asked.";
 if (!state.sessionId) {
 return Promise.resolve({
 spoken_answer: "I need a session first — open the panel and try again.",
 panel_text: "",
 ok: false,
 });
 }
 // Status only — never voice filler while tools run
 setStatus("Thinking…", "think");
 state.thinking = true;
 state._turnBusy = true;
 var chatCtx = packContext() || {};
 chatCtx.voice_active = true;
 chatCtx.voice_weave = true;
 return postChatTurn({
 session_id: state.sessionId,
 message: q,
 context: chatCtx,
 source: "voice_consult",
 })
 .then(function (pack) {
 state.thinking = false;
 state._turnBusy = false;
 var d = pack.d || {};
 if (!pack.httpOk) {
 var err = (d && (d.detail || d.error)) || ("HTTP " + pack.status);
 if (typeof err !== "string") err = JSON.stringify(err);
 // Short spoken line only on real HTTP failure (no "snag/hiccup" theater)
 return {
 ok: false,
 spoken_answer: "Sorry — try that once more?",
 panel_text: String(err).slice(0, 400),
 };
 }
 if (d.budget) setBudget(d.budget);
 if (d.mind) onMindPlanFromChat(d.mind);
 if (d.pending) showPending(d.pending);
 else showPending(null);
 var reply = ownerFacingText(d.reply || "…");
 var spoken =
 ownerFacingSpeak((d.speak && String(d.speak).trim()) || reply) || reply;
 // Panel gets the full deep-brain write-up once; suppress Realtime's re-spoken
 // transcript bubble so we don't double-post (weave fix).
 if (reply) {
 addMsg("agent", reply, { spoken: spoken });
 state._lastAgentBubble = reply.slice(0, 200);
 state._suppressNextAgentTranscript = true;
 }
 clearTools();
 var cmds = d.ui_commands || [];
 cmds = coerceTourCommands(cmds, q);
 // Run UI commands without blocking the function-output ack too long
 (async function () {
 for (var i = 0; i < cmds.length; i++) {
 try {
 await runCommand(cmds[i]);
 } catch (e) {}
 }
 })();
 return {
 ok: true,
 spoken_answer: spoken.slice(0, 1200),
 panel_text: reply.slice(0, 2000),
 pending: !!d.pending,
 };
 })
 .catch(function (e) {
 state.thinking = false;
 state._turnBusy = false;
 return {
 ok: false,
 spoken_answer: "Sorry — try that once more?",
 panel_text: String((e && e.message) || e || "error").slice(0, 200),
 };
 });
 }

 function sendFunctionCallOutput(callId, outputObj, opts) {
 opts = opts || {};
 if (!callId || !state.dc || state.dc.readyState !== "open") return;
 var out =
 typeof outputObj === "string" ? outputObj : JSON.stringify(outputObj || {});
 try {
 state.dc.send(
 JSON.stringify({
 type: "conversation.item.create",
 item: {
 type: "function_call_output",
 call_id: callId,
 output: out.slice(0, 8000),
 },
 })
 );
 // Client-forced path already speaks via enqueueSpeak — don't double-talk
 if (opts.createResponse === false) return;
 state.dc.send(JSON.stringify({ type: "response.create" }));
 } catch (e) {}
 }

 function handleRealtimeFunctionCall(name, argsStr, callId) {
 var args = {};
 try {
 args = JSON.parse(argsStr || "{}") || {};
 } catch (e) {
 args = { question: String(argsStr || "") };
 }
 var nm = String(name || "").toLowerCase();
 if (nm === "consult_deep_brain" || nm === "consult_brain" || nm === "deep_brain") {
 // Client already force-consulted this user turn — ack tool, stay silent
 if (state._clientForcedConsult || state._silenceUntilDeepAnswer) {
 sendFunctionCallOutput(
 callId,
 {
 ok: true,
 spoken_answer: "",
 note: "Client handling; stay silent until spoken_answer is delivered by the app.",
 },
 { createResponse: false }
 );
 return;
 }
 var question = args.question || args.query || args.message || "";
 // Realtime-initiated consult: silent until result, then speak once
 beginDeepThinkSilence();
 consultDeepBrain(question, callId)
 .then(function (result) {
 endDeepThinkSilence();
 // Prefer app-side speak so we don't get a double monologue
 var line =
 (result && result.spoken_answer) ||
 (result && result.panel_text) ||
 "";
 sendFunctionCallOutput(
 callId,
 {
 ok: !!(result && result.ok !== false),
 spoken_answer: line,
 note: "App will speak; stay silent.",
 },
 { createResponse: false }
 );
 if (line) {
 enqueueSpeak(String(line).slice(0, 1400), {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 }
 })
 .catch(function () {
 endDeepThinkSilence();
 sendFunctionCallOutput(
 callId,
 { ok: false, spoken_answer: "", note: "failed" },
 { createResponse: false }
 );
 enqueueSpeak("Sorry — try that once more?", {
 source: "chat",
 force: true,
 holdMicFull: false,
 }).catch(function () {});
 });
 return;
 }
 sendFunctionCallOutput(callId, {
 ok: false,
 spoken_answer: "I can't use that tool from here.",
 });
 }

 function stopVoice(keepMic) {
 state.listening = false;
 state.speaking = false;
 state.rtResponseActive = false;
 // Invalidate any in-flight startRealtimeVoice (mute toggle race)
 state._voiceConnectGen = (state._voiceConnectGen || 0) + 1;
 // Abort any waiting speak queue callbacks
 var cb = state._onSpeakDone;
 state._onSpeakDone = null;
 state._speakSeq++;
 if (typeof cb === "function") {
 try { cb(); } catch (e) {}
 }
 // WebRTC
 try {
 if (state.dc) { state.dc.close(); }
 } catch (e) {}
 state.dc = null;
 try {
 if (state.pc) { state.pc.close(); }
 } catch (e) {}
 state.pc = null;
 if (state.micStream) {
 if (keepMic) {
 try { state.micStream.getTracks().forEach(function (t) { t.enabled = false; }); } catch (e) {}
 } else {
 try { state.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
 state.micStream = null;
 }
 }
 if (state.audioEl) {
 try { state.audioEl.pause(); state.audioEl.srcObject = null; } catch (e) {}
 }
 if (state.recog) {
 try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
 state.recog = null;
 }
 try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
 state.voiceMode = "none";
 syncMicBtn();
 }

 function stopSpeak(opts) {
 opts = opts || {};
 // Restore the speaker each turn so a freestyle-mute can never get stuck if
 // our own answer never arrives (respects the user's voice-mute).
 try { _unmuteMouthEl(); } catch (e) {}
 // Protect first intro: only hard "stop" / panel close may cut it
 if (
 state._greetingPlaying &&
 opts.reason === "barge_in"
 ) {
 return;
 }
 // Cancel Realtime FIRST (while we still know audio may be live). Clearing
 // rtResponseActive before cancel made cancel a no-op → double voice.
 cancelRealtimeIfActive();
 try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
 state.speaking = false;
 state.rtResponseActive = false;
 state._speakStartedAt = 0;
 state._speakEndedAt = Date.now();
 if (
 opts.reason === "barge_in" ||
 opts.reason === "new_turn" ||
 opts.reason === "stop"
 ) {
 state._greetingPlaying = false;
 }
 if (opts.reason === "answer_ready") {
 state._thinkingFillerActive = false;
 }
 // Release any attack-mute so mic is live for the next user turn
 if (state._unmuteAfterSpeakTimer) {
 try { clearTimeout(state._unmuteAfterSpeakTimer); } catch (e) {}
 state._unmuteAfterSpeakTimer = null;
 }
 state._micHeldForSpeak = false;
 // Keep mic muted if cutting filler to answer, next speakNow re-arms
 var keepMicDown = opts.reason === "answer_ready";
 if (state.listening && state.micStream && !state._greetingPlaying && !keepMicDown) {
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 }
 var cb = state._onSpeakDone;
 state._onSpeakDone = null;
 // Bump seq so any in-flight enqueueSpeak step is abandoned
 if (
 opts.reason === "new_turn" ||
 opts.reason === "barge_in" ||
 opts.reason === "answer_ready" ||
 opts.reason === "stop"
 ) {
 state._speakSeq++;
 }
 // Resolve any waiter without restarting mic logic (already handled above)
 if (typeof cb === "function") {
 try { cb(); } catch (e) {}
 }
 }

 function realtimeMouthOpen() {
 return !!(state.dc && state.dc.readyState === "open");
 }

 /**
 * Split long replies into speakable chunks (sentence-aware).
 * Realtime response.create is happier with shorter payloads; the queue plays
 * them back-to-back so explanations can run as long as needed.
 */
 function chunkForSpeech(plain, maxChars) {
 maxChars = maxChars || 900;
 var text = String(plain || "").replace(/\s+/g, " ").trim();
 if (!text) return [];
 if (text.length <= maxChars) return [text];
 // Sentence-ish split without lookbehind (older browsers)
 var parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
 var chunks = [];
 var buf = "";
 function flush() {
 var t = buf.trim();
 if (t) chunks.push(t);
 buf = "";
 }
 for (var i = 0; i < parts.length; i++) {
 var p = (parts[i] || "").trim();
 if (!p) continue;
 // Hard-split an oversized sentence on spaces
 if (p.length > maxChars) {
 flush();
 var rest = p;
 while (rest.length > maxChars) {
 var cut = rest.lastIndexOf(" ", maxChars);
 if (cut < maxChars * 0.4) cut = maxChars;
 chunks.push(rest.slice(0, cut).trim());
 rest = rest.slice(cut).trim();
 }
 if (rest) buf = rest;
 continue;
 }
 if (buf && (buf.length + 1 + p.length) > maxChars) {
 flush();
 }
 buf = buf ? buf + " " + p : p;
 }
 flush();
 return chunks.length ? chunks : [text.slice(0, maxChars)];
 }

 /**
 * Serialize agent voice so we never stack multiple response.create calls.
 * GPT Realtime only, never fall back to robotic browser speechSynthesis
 * (Ford 2026-07-14: if the mouth breaks, go silent; text stays on screen).
 * Long explanations are chunked and spoken sequentially, no hard 20s cutoff.
 */
 function enqueueSpeak(text, opts) {
 opts = opts || {};
 // Always strip DOM ids / #hashes so the mouth never says "hash reports"
 var plain = ownerFacingSpeak(text);
 if (!plain) return Promise.resolve();
 // Speaker mute: text already on screen; resolve immediately so tours don't stall.
 if (state.voiceMuted && !opts.force) {
 return Promise.resolve();
 }
 // Dedupe identical consecutive lines (double chat + tour wrap-up)
 if (plain === state._lastSpokenPlain && !opts.force) {
 return Promise.resolve();
 }
 state._lastSpokenPlain = plain;
 _lastSpoken = plain;

 // Larger chunks = fewer seams; Realtime can hold multi-minute scripts
 var chunks = chunkForSpeech(plain, 1400);
 var seq = ++state._speakSeq;
 // Track in-flight speak so response.done can't kill long audio early
 state._speakHardDeadline = Date.now() + Math.max(120000, plain.split(/\s+/).length * 600 + 30000);
 chunks.forEach(function (chunk, i) {
 var isLast = i === chunks.length - 1;
 state._speakQueue = state._speakQueue
 .catch(function () {})
 .then(function () {
 if (seq !== state._speakSeq) return; // superseded by newer speech/barge-in
 if (state.voiceMuted && !opts.force) return;
 return speakNow(chunk, {
 source: opts.source,
 force: true, // chunks must not dedupe against each other
 holdMicFull: !!opts.holdMicFull || opts.source === "greeting",
 // Keep mic held across multi-chunk explanations
 keepMicHeld: !isLast,
 speakSeq: seq,
 });
 });
 });
 return state._speakQueue;
 }

 function speakNow(plain, opts) {
 opts = opts || {};
 return new Promise(function (resolve) {
 var settled = false;
 var words = plain.split(/\s+/).filter(Boolean).length;
 // Generous: ~550ms/word + headroom; floor 20s, ceiling 10 min per chunk
 var fallbackMs = Math.min(600000, Math.max(20000, Math.round(words * 550) + 8000));
 var maxArm = Math.min(900000, fallbackMs * 3); // hard hang recovery
 var timer = null;
 var earlyDoneTimer = null;
 var totalArmed = 0;

 function clearTimers() {
 if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
 if (earlyDoneTimer) { try { clearTimeout(earlyDoneTimer); } catch (e) {} earlyDoneTimer = null; }
 }

 function done() {
 if (settled) return;
 settled = true;
 clearTimers();
 state._onSpeakDone = null;
 state._speakEarlyDoneTimer = null;
 state.speaking = false;
 state.rtResponseActive = false;
 state._drivenSpeak = false;
 if (opts.source === "greeting") {
 state._greetingPlaying = false;
 state._pendingGreetingSend = null;
 }
 // Only settle mic after the LAST chunk of a long explanation
 if (!opts.keepMicHeld) {
 holdMicWhileSpeaking(false);
 if (state.listening && !state.touring) {
 setStatus(state.voiceMuted ? "Listening (voice muted)" : "Listening…", "listen");
 }
 } else {
 // Next chunk will re-arm attack mute; keep status as speaking
 setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
 }
 resolve();
 }
 // Speaker mute, never start audio
 if (state.voiceMuted && !opts.force) {
 done();
 return;
 }

 function armFallback(ms) {
 if (timer) clearTimeout(timer);
 timer = setTimeout(function () {
 totalArmed += ms;
 // Still playing, keep waiting until hard hang limit
 if ((state.speaking || state.rtResponseActive) && totalArmed < maxArm) {
 armFallback(Math.min(120000, ms));
 return;
 }
 done();
 }, ms);
 }
 armFallback(fallbackMs);

 // Called when audio truly ends (buffer stopped) OR confirmed cancel
 state._onSpeakDone = function () {
 clearTimers();
 done();
 };
 // Exposed so response.done can schedule a LONG safety drain, not 1.2s
 state._scheduleSpeakSafetyDrain = function (delayMs) {
 if (earlyDoneTimer) clearTimeout(earlyDoneTimer);
 // Only force-end if buffer.stopped never arrives, wait based on remaining words
 var wait = Math.max(delayMs || 0, Math.min(fallbackMs, 180000));
 earlyDoneTimer = setTimeout(function () {
 earlyDoneTimer = null;
 // If still actively receiving audio deltas, keep going
 if (state.speaking || state.rtResponseActive) {
 if (Date.now() < (state._speakHardDeadline || 0)) {
 state._scheduleSpeakSafetyDrain(30000);
 return;
 }
 }
 if (typeof state._onSpeakDone === "function") {
 try { state._onSpeakDone(); } catch (e) {}
 }
 }, wait);
 state._speakEarlyDoneTimer = earlyDoneTimer;
 };

 // Attack mute: full hold ONLY for greeting. Chat/answers reopen mic for barge-in.
 var isGreeting = opts.source === "greeting";
 var isFiller = opts.source === "thinking_filler";
 if (isGreeting) state._greetingPlaying = true;
 holdMicWhileSpeaking(true, {
 holdMicFull: isGreeting ? true : !!opts.holdMicFull && isGreeting,
 source: opts.source,
 wordCount: words,
 });

 // ── GPT Realtime mouth ────────────────────────────────────────────
 if (realtimeMouthOpen()) {
 try {
 // Verbatim full read, do not summarize or stop early
 var speakScript =
 "Read the following aloud VERBATIM in natural English, starting from " +
 "the FIRST word and continuing until the LAST word. " +
 "Do not skip, summarize, reorder, or stop early. " +
 "Do not add greetings or questions. Take as long as you need:\n\n" +
 plain;
 var sendCreate = function () {
 if (opts.speakSeq != null && opts.speakSeq !== state._speakSeq) {
 done();
 return;
 }
 if (!state.dc || state.dc.readyState !== "open") {
 state.rtResponseActive = false;
 if (isGreeting) state._greetingPlaying = false;
 done();
 return;
 }
 try {
 state.rtResponseActive = true;
 state.speaking = true;
 state._speakStartedAt = Date.now();
 state._rtCancelPending = false;
 // Mark THIS response as our own driven speech so the deep-think silence
 // guard lets narration/answers play while still killing GPT freestyle.
 state._drivenSpeak = true;
 // One-shot: the VERY NEXT response.created is ours (we're sending it now).
 // Set synchronously right before the send so no freestyle can slip a
 // response.created in between — the mouth guard consumes this flag.
 state._weSentCreate = true;
 state.dc.send(JSON.stringify({
 type: "response.create",
 response: {
 instructions: speakScript,
 },
 }));
 } catch (e2) {
 state.rtResponseActive = false;
 if (isGreeting) state._greetingPlaying = false;
 done();
 }
 };
 // Cancel any stale mouth first, then settle before create. Skipping cancel
 // when flags were already cleared left residual audio playing under a new
 // response (double speak). Greeting: never cancel mid-intro.
 var needCancel = !isGreeting && (
 state.rtResponseActive || state.speaking || state._rtCancelPending
 );
 if (needCancel) {
 cancelRealtimeIfActive();
 }
 var armCreate = function () {
 if (opts.speakSeq != null && opts.speakSeq !== state._speakSeq) {
 done();
 return;
 }
 if (isGreeting && !state._sessionUpdated) {
 state._pendingGreetingSend = sendCreate;
 setTimeout(function () {
 if (state._pendingGreetingSend) {
 var fn = state._pendingGreetingSend;
 state._pendingGreetingSend = null;
 fn();
 }
 }, 1000);
 } else if (isGreeting) {
 setTimeout(sendCreate, 180);
 } else {
 sendCreate();
 }
 };
 if (needCancel) {
 setTimeout(armCreate, 140);
 } else {
 armCreate();
 }
 setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
 return;
 } catch (e) {
 state.rtResponseActive = false;
 if (isGreeting) state._greetingPlaying = false;
 }
 }

 // No Realtime mouth → silent. Never use browser speechSynthesis (robot voice).
 // Text is already painted; tours still pace via speakAndWait dwell.
 try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
 if (state.touring) {
 setStatus("Tour… (voice silent)", "think");
 } else {
 setStatus(state.listening ? "Listening…" : "Ready", state.listening ? "listen" : "on");
 }
 done();
 });
 }

 /** @deprecated path, route through enqueueSpeak so the queue stays single-threaded */
 function speak(text, opts) {
 opts = opts || {};
 var plain = opts.awaitable ? stripMd(text) : stripMd(text);
 if (!plain) return;
 // Legacy direct callers: still go through the queue
 enqueueSpeak(plain, opts);
 }

 function dcSend(obj) {
 if (state.dc && state.dc.readyState === "open") {
 try { state.dc.send(JSON.stringify(obj)); } catch (e) {}
 }
 }

 function handleRealtimeEvent(ev) {
 if (!ev || !ev.type) return;
 // Session config applied, safe to start first greeting response
 if (ev.type === "session.updated" || ev.type === "session.created") {
 state._sessionUpdated = true;
 if (state._pendingGreetingSend) {
 var gfn = state._pendingGreetingSend;
 state._pendingGreetingSend = null;
 try { gfn(); } catch (e) {}
 }
 }
 // While deep brain is working: kill any GPT freestyle / filler / fake-fail
 // speech — but let OUR driven narration/answer (state._drivenSpeak) play.
 if (
 state._silenceUntilDeepAnswer &&
 !state._drivenSpeak &&
 (ev.type === "response.created" ||
 ev.type === "response.output_item.added" ||
 ev.type === "output_audio_buffer.started" ||
 ev.type === "response.output_audio.delta")
 ) {
 try {
 cancelRealtimeIfActive();
 } catch (eSil) {}
 // Keep thinking status; do not flip to Speaking
 if (state.thinking || state._consultInFlight) {
 setStatus("Thinking…", "think");
 }
 return;
 }
 // ── The mouth may not author ──────────────────────────────────────────
 // Mouth-only: every legitimate line is driven by us through speakNow, which
 // sets _drivenSpeak. A response we did NOT drive is GPT answering on its
 // own — it has no tools and no fleet data, so it guesses, and the guess
 // contradicts the brain: it denied sending emails the brain had just sent,
 // and spoke while the panel read "Text only, voice off" (Ford 2026-07-16).
 // Config cannot prevent this on its own — session.update is fire-and-forget,
 // and if it never lands the session keeps OpenAI's create_response default
 // (ON); the "only speak lines the app sends" instruction is persuasion, not
 // enforcement. So kill any undriven response before a word reaches the ear.
 // Track OUR response by ID, not a race-prone flag. sendCreate sets
 // _weSentCreate synchronously right before response.create, so the very next
 // response.created is ours — we record its id. EVERY response/audio event for
 // any OTHER id is the pure-voice model authoring on its own: cancel it AND
 // mute the audio element so it's never heard, even if the API ignores cancel
 // or create_response leaked ON. Diagnostics logged so the event stream is
 // visible in the console (Ford 2026-07-16 — freestyle still slipping through).
 if (!VOICE_WEAVE && (/^response[.]/.test(ev.type) || /^output_audio/.test(ev.type))) {
 var _rid = (ev.response && ev.response.id) || ev.response_id ||
 (ev.item && ev.item.id) || null;
 if (window.__EA_VOICE_DIAG !== false && window.console) {
 try {
 console.log("[EA-DIAG]", ev.type, "rid=" + _rid,
 "weSent=" + !!state._weSentCreate, "ourId=" + (state._ourResponseId || "-"),
 "driven=" + !!state._drivenSpeak);
 } catch (eD) {}
 }
 if (ev.type === "response.created") {
 if (state._weSentCreate) {
 state._weSentCreate = false; // consume — this response is ours
 state._ourResponseId = _rid;
 _unmuteMouthEl(); // our own answer must be audible
 } else {
 // Pure-voice model authoring on its own → mute the speaker + cancel.
 // The mute persists (nothing un-mutes it) until OUR next answer's
 // response.created fires above, so even a cancel the API ignores is
 // never heard.
 _killFreestyle(_rid);
 return;
 }
 } else if (ev.type === "output_audio_buffer.started" &&
 !state._weSentCreate && _rid && _rid !== state._ourResponseId) {
 // Backstop: freestyle audio whose response.created we somehow missed.
 _killFreestyle(_rid);
 return;
 }
 }
 // Track whether a Realtime response is in flight (so cancel is safe)
 if (ev.type === "response.created" || ev.type === "response.output_item.added") {
 state.rtResponseActive = true;
 }
 // Model audio lifecycle
 if (ev.type === "output_audio_buffer.started") {
 state.speaking = true;
 state.rtResponseActive = true;
 // Mark speak start once; attack mute already armed in speakNow, don't re-mute forever
 if (!state._speakStartedAt) state._speakStartedAt = Date.now();
 // Weave: short attack mute then open mic for barge-in (not full hold)
 if (VOICE_WEAVE && !state._silenceUntilDeepAnswer) {
 holdMicWhileSpeaking(true, { holdMicFull: false, source: "chat" });
 }
 setStatus(state.touring ? "Tour… speaking" : "Speaking…", "speak");
 }
 if (ev.type === "response.output_audio.delta") {
 state.speaking = true;
 state.rtResponseActive = true;
 }
 // Prefer audio-buffer stopped (playback drained), this is when the ear hears silence
 if (ev.type === "output_audio_buffer.stopped") {
 state.speaking = false;
 state.rtResponseActive = false;
 state._rtCancelPending = false;
 state._speakEndedAt = Date.now();
 if (state._greetingPlaying) state._greetingPlaying = false;
 if (typeof state._onSpeakDone === "function") {
 try { state._onSpeakDone(); } catch (e) {}
 } else {
 holdMicWhileSpeaking(false);
 // Weave: Realtime owns mic; just re-enable tracks after speech
 if (VOICE_WEAVE && state.listening && state.micStream) {
 try {
 state.micStream.getTracks().forEach(function (t) {
 t.enabled = true;
 });
 } catch (e) {}
 }
 if (state.listening && !state.touring) {
 setStatus("Listening…", "listen");
 }
 }
 }
 if (ev.type === "response.cancelled" || ev.type === "response.failed") {
 state.speaking = false;
 state.rtResponseActive = false;
 state._rtCancelPending = false;
 state._speakEndedAt = Date.now();
 if (typeof state._onSpeakDone === "function") {
 try { state._onSpeakDone(); } catch (e) {}
 } else {
 holdMicWhileSpeaking(false);
 // After cancel, make sure mic is open for the next ask
 if (state.listening && state.micStream && !state._micHeldForSpeak) {
 try {
 state.micStream.getTracks().forEach(function (t) { t.enabled = true; });
 } catch (e) {}
 }
 if (state.listening && !state.touring && !state.thinking) {
 setStatus("Listening…", "listen");
 }
 }
 }
 if (ev.type === "response.done") {
 // Model finished *generating*, audio often still playing for a long time.
 // NEVER force-end in ~1s (that cut mid-answer). Wait for buffer.stopped,
 // or a long word-based safety drain only if buffer.stopped never arrives.
 if (!state.speaking && !state.rtResponseActive) {
 if (typeof state._onSpeakDone === "function") {
 try { state._onSpeakDone(); } catch (e) {}
 } else if (state.listening && !state.touring) {
 setStatus("Listening…", "listen");
 }
 } else if (typeof state._scheduleSpeakSafetyDrain === "function") {
 // Long safety only, do not clip multi-minute speech
 state._scheduleSpeakSafetyDrain(45000);
 }
 }
 // ── Option D: Realtime function calls → deep brain ───────────────────
 // response.function_call_arguments.done (common) or item-done with function_call
 if (ev.type === "response.function_call_arguments.done") {
 var fcName = ev.name || (ev.item && ev.item.name) || "";
 var fcArgs = ev.arguments != null ? ev.arguments : "";
 var fcId = ev.call_id || (ev.item && ev.item.call_id) || ev.id;
 if (fcId) handleRealtimeFunctionCall(fcName, fcArgs, fcId);
 }
 if (
 ev.type === "response.output_item.done" &&
 ev.item &&
 (ev.item.type === "function_call" || ev.item.type === "function_call_output")
 ) {
 if (ev.item.type === "function_call") {
 handleRealtimeFunctionCall(
 ev.item.name,
 ev.item.arguments || "",
 ev.item.call_id || ev.item.id
 );
 }
 }
 // Assistant speech transcript → panel (weave: Realtime is the speaker of record)
 if (
 VOICE_WEAVE &&
 (ev.type === "response.audio_transcript.done" ||
 ev.type === "response.output_audio_transcript.done")
 ) {
 var agentSaid = (ev.transcript || "").trim();
 if (agentSaid) {
 state._lastSpokenPlain = agentSaid;
 state._lastAgentTranscript = agentSaid;
 state._suppressNextAgentTranscript = false;
 // In weave mode the PANEL is authored by the deep brain (addMsg from the
 // consult) — never post GPT's own audio transcript to chat. GPT sometimes
 // verbalizes its instructions ("I'll stay quiet…") or freestyle recovery
 // lines; those must NEVER pollute the panel (Ford 2026-07-16 screenshot).
 // The audio still plays; we just don't bubble the Realtime transcript.
 }
 if (state._greetingPlaying) {
 state._greetingPlaying = false;
 }
 }

 // User finished speaking.
 // Option D weave: Realtime answers (create_response true) — do NOT call turn().
 // That dual path was the "two agents fighting" Ford saw (2026-07-16).
 // Legacy: transcription → turn() → force-speak.
 if (ev.type === "conversation.item.input_audio_transcription.completed") {
 var said = (ev.transcript || "").trim();
 if (!acceptUserTranscript(said)) return;
 var nowTs = Date.now();
 var saidKey = said.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
 state._lastUserSaid = saidKey;
 state._lastUserSaidAt = nowTs;
 var wasSpeaking = isAgentMouthBusy();
 var wasThinking = !!(state.thinking || state._turnBusy);

 // Hard stop always (both modes)
 if (isStopCommand(said)) {
 stopSpeak({ reason: "barge_in" });
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 addMsg("user", said);
 handleStopCommand();
 return;
 }

 if (VOICE_WEAVE) {
 // Barge-in: cut her speech / mid-think work immediately (GPT Live feel)
 if (
 wasSpeaking ||
 wasThinking ||
 state._silenceUntilDeepAnswer ||
 state._consultInFlight ||
 state.speaking ||
 state.rtResponseActive
 ) {
 // Invalidate any in-flight deep consult so it can't speak after redirect
 state._consultGen = (state._consultGen || 0) + 1;
 try {
 stopSpeak({ reason: "barge_in" });
 } catch (eBi) {}
 try {
 endDeepThinkSilence();
 } catch (eEd) {}
 try {
 abortInFlightTurn("barge_in");
 } catch (eAb) {}
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 // Native Realtime interrupt (create_response sessions)
 try {
 state.dc.send(JSON.stringify({ type: "response.cancel" }));
 } catch (eRc) {}
 } catch (eCl) {}
 }
 if (state.listening && state.micStream) {
 try {
 state.micStream.getTracks().forEach(function (t) {
 t.enabled = true;
 });
 } catch (eM) {}
 }
 setStatus("Listening…", "listen");
 }
 addMsg("user", said);
 if (state.sessionId) {
 fetch(API.transcript, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 lines: [{ role: "user", text: said }],
 voice_seconds: Math.max(4, said.split(/\s+/).length * 0.55 + 2),
 }),
 })
 .then(function (r) {
 return r.json().catch(function () {
 return null;
 });
 })
 .then(function (d) {
 if (d && d.budget) setBudget(d.budget);
 })
 .catch(function () {});
 }
 if (state.touring) state.touring = false;
 // Non-social → deep brain. Social → Realtime answers alone (create_response).
 if (!isPureSocialVoice(said)) {
 weaveForceDeepConsult(said);
 }
 return;
 }

 // ── Legacy mouth-only path ──────────────────────────────────────────
 // Defense in depth: while SHE is delivering a driven read, a transcript is
 // almost certainly her own speaker audio bleeding back (garbled STT that slips
 // past the echo filter). Do NOT let that self-interrupt her — she must finish
 // the thought. A real "stop" already returned above (isStopCommand).
 if (state._drivenSpeak && isAgentMouthBusy()) {
 if (state.dc && state.dc.readyState === "open") {
 try { state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" })); } catch (e) {}
 }
 return;
 }
 stopSpeak({ reason: "barge_in" });
 if (state.dc && state.dc.readyState === "open") {
 try {
 state.dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
 } catch (e) {}
 }
 if (wasSpeaking) {
 setStatus("Listening…", "listen");
 }
 if (wasThinking || wasSpeaking) {
 abortInFlightTurn("barge_in");
 }
 if (state.touring) state.touring = false;
 addMsg("user", said);
 if (state.sessionId) {
 fetch(API.transcript, {
 method: "POST",
 headers: authHeaders(),
 body: JSON.stringify({
 session_id: state.sessionId,
 lines: [{ role: "user", text: said }],
 voice_seconds: Math.max(4, said.split(/\s+/).length * 0.55 + 2),
 }),
 })
 .then(function (r) { return r.json().catch(function () { return null; }); })
 .then(function (d) {
 if (d && d.budget) setBudget(d.budget);
 })
 .catch(function () {});
 }
 turn(said, "voice", { userAlreadyShown: true }).catch(function () {});
 }
 if (ev.type === "error") {
 var msg = (ev.error && (ev.error.message || ev.error)) || "Realtime error";
 // Benign: cancel when nothing is speaking, ignore, do not alarm the user
 if (isBenignVoiceError(msg)) {
 state.rtResponseActive = false;
 return;
 }
 addMsg("agent", "Voice error: " + String(msg).slice(0, 200));
 setStatus("Voice error", "warn");
 }
 }

 async function ensureMicStream() {
 if (state.micStream) {
 var live = state.micStream.getTracks().some(function (t) { return t.readyState === "live"; });
 if (live) {
 // Re-enable if we muted them after the startup permission grant
 try { state.micStream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}
 return state.micStream;
 }
 }
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
 throw new Error("This browser cannot access the microphone.");
 }
 var stream = await navigator.mediaDevices.getUserMedia({
 audio: {
 echoCancellation: true,
 noiseSuppression: true,
 autoGainControl: true,
 },
 });
 state.micStream = stream;
 return stream;
 }

 // Avoid double-adding chat reply when Realtime is also speaking
 var _lastSpoken = "";

 function _voiceConnectStale(gen) {
 return !!state.voiceMuted || gen !== state._voiceConnectGen;
 }

 /** Primary: GPT Realtime over WebRTC via our server (unified /realtime-call). */
 async function startRealtimeVoice() {
 if (state.voiceMuted) {
 throw new Error("voice_muted");
 }
 // Already connected, just re-enable the mic (don't renegotiate / double-greet)
 if (realtimeMouthOpen() && state.pc) {
 try { state.micStream && state.micStream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}
 state.listening = true;
 state.voiceMode = "realtime";
 syncMicBtn();
 setStatus("Listening…", "listen");
 return;
 }

 // Generation token: if mute/stopVoice runs mid-connect, we abort quietly
 // instead of setRemoteDescription on a closed PC + chat spam.
 var gen = state._voiceConnectGen;
 setStatus("Connecting GPT voice…", "think");
 var stream = await ensureMicStream();
 if (_voiceConnectStale(gen)) throw new Error("voice_muted");
 try { stream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}

 // Tear down prior peer connection but KEEP the mic stream (permission)
 // Use internal teardown without wiping voiceMode preference
 try { if (state.dc) state.dc.close(); } catch (e) {}
 state.dc = null;
 try { if (state.pc) state.pc.close(); } catch (e) {}
 state.pc = null;
 if (state.recog) {
 try { state.recog.onend = null; state.recog.stop(); } catch (e) {}
 state.recog = null;
 }
 if (_voiceConnectStale(gen)) throw new Error("voice_muted");

 stream = await ensureMicStream();
 if (_voiceConnectStale(gen)) throw new Error("voice_muted");
 try { stream.getTracks().forEach(function (t) { t.enabled = true; }); } catch (e) {}

 var pc = new RTCPeerConnection();
 state.pc = pc;

 // Play model audio
 if (!state.audioEl) {
 state.audioEl = document.createElement("audio");
 state.audioEl.autoplay = true;
 state.audioEl.setAttribute("playsinline", "true");
 state.audioEl.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
 document.body.appendChild(state.audioEl);
 applyVoiceMuteToAudio();
 }
 pc.ontrack = function (e) {
 state.audioEl.srcObject = e.streams[0];
 var p = state.audioEl.play();
 if (p && p.catch) p.catch(function () {});
 };

 stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });

 var dc = pc.createDataChannel("oai-events");
 state.dc = dc;
 dc.addEventListener("message", function (e) {
 try { handleRealtimeEvent(JSON.parse(e.data)); } catch (err) {}
 });
 dc.addEventListener("open", function () {
 // Option D (default): Realtime owns the conversation + consult_deep_brain.
 // Legacy: mouth-only, create_response false, app drives every reply via /chat.
 state._sessionUpdated = false;
 var sess = {
 type: "realtime",
 instructions: VOICE_WEAVE
 ? realtimeWeaveInstructions()
 : "You are Energy Agent's MOUTH only, continuous cognition steers you. " +
 "Only speak lines the app sends via response.create. " +
 "Do not invent answers; the deeper mind reasons with tools and steers what you say. " +
 "Start from the first word, speak completely, never speak over yourself. " +
 "Never cut yourself off mid-sentence.",
 audio: {
 input: {
 transcription: {
 model: "gpt-4o-mini-transcribe",
 // Bias the STT toward product vocabulary so it stops hearing
 // "Array Operator" as "ray operator" and mangling vendor names
 // (Ford 2026-07-17). gpt-4o-mini-transcribe takes a prompt hint.
 prompt: EA_STT_PROMPT,
 },
 noise_reduction: { type: "near_field" },
 turn_detection: realtimeVadConfig(),
 },
 },
 };
 if (VOICE_WEAVE) {
 sess.tools = realtimeWeaveTools();
 // Prefer tool use when Realtime answers alone (client also force-consults non-social).
 sess.tool_choice = "required";
 }
 dcSend({ type: "session.update", session: sess });
 // session.update is fire-and-forget over the data channel. If it never lands,
 // the session silently keeps OpenAI's defaults — including create_response ON,
 // which turns the mouth into a second, tool-less author that contradicts the
 // brain. Re-send until the server confirms session.updated; say so loudly if
 // it never does (the undriven-response guard above is the backstop).
 (function ensureSessionUpdate(tries) {
 if (state._sessionUpdated) return;
 if (tries >= 6) {
 if (window.console && console.warn) {
 console.warn("[EA] session.update never confirmed — mouth config unverified; " +
 "undriven-response guard is holding the line");
 }
 return;
 }
 setTimeout(function () {
 if (state._sessionUpdated) return;
 if (state.dc && state.dc.readyState === "open") {
 try { state.dc.send(JSON.stringify({ type: "session.update", session: sess })); } catch (e) {}
 }
 ensureSessionUpdate(tries + 1);
 }, 700);
 })(0);
 // Single greeting per panel open
 if (!state.greeted && !state.voiceMuted) {
 state.greeted = true;
 state._greetingPlaying = true;
 try {
 if (state.micStream) {
 state.micStream.getTracks().forEach(function (t) {
 t.enabled = false;
 });
 }
 } catch (e) {}
 if (VOICE_WEAVE) {
 // Native Realtime greeting — one mind, no forced script fight
 var greetCreate = function () {
 if (!state.dc || state.dc.readyState !== "open") {
 state._greetingPlaying = false;
 return;
 }
 try {
 state.rtResponseActive = true;
 state.speaking = true;
 state.dc.send(
 JSON.stringify({
 type: "response.create",
 response: {
 instructions:
 "Greet the owner in one short friendly line as Energy Agent. " +
 "Say you're listening whenever they're ready. Then stop and wait.",
 },
 })
 );
 } catch (e2) {
 state._greetingPlaying = false;
 }
 };
 if (state._sessionUpdated) setTimeout(greetCreate, 180);
 else state._pendingGreetingSend = greetCreate;
 setStatus("Speaking…", "speak");
 // Safety: clear greeting flag when audio ends (also handled by buffer events)
 setTimeout(function () {
 if (state._greetingPlaying && !state.rtResponseActive) {
 state._greetingPlaying = false;
 }
 }, 12000);
 } else {
 enqueueSpeak(
 "Hi, Energy Agent here. I'm listening whenever you're ready.",
 { source: "greeting", force: true, holdMicFull: true }
 )
 .then(function () {
 state._greetingPlaying = false;
 if (state.listening && !state.voiceMuted) {
 setStatus("Listening…", "listen");
 }
 })
 .catch(function () {
 state._greetingPlaying = false;
 });
 setStatus("Speaking…", "speak");
 }
 } else if (state.voiceMuted) {
 setStatus("Text only, voice off", "on");
 } else {
 setStatus("Listening…", "listen");
 }
 });

 var offer = await pc.createOffer();
 if (_voiceConnectStale(gen) || state.pc !== pc) {
 try { pc.close(); } catch (e) {}
 throw new Error("voice_muted");
 }
 await pc.setLocalDescription(offer);
 if (_voiceConnectStale(gen) || state.pc !== pc) {
 try { pc.close(); } catch (e) {}
 throw new Error("voice_muted");
 }

 var sdpRes = await fetch(API.realtimeCall, {
 method: "POST",
 headers: {
 Authorization: "Bearer " + token(),
 "Content-Type": "application/sdp",
 },
 body: offer.sdp,
 });
 if (_voiceConnectStale(gen) || state.pc !== pc) {
 try { pc.close(); } catch (e) {}
 throw new Error("voice_muted");
 }
 if (!sdpRes.ok) {
 var errText = await sdpRes.text();
 var detail = errText;
 var parsed = null;
 try { parsed = JSON.parse(errText); detail = parsed.detail || errText; } catch (e) {}
 // Budget exhausted, paint the meter full + clear message (don't leave bar empty)
 if (sdpRes.status === 402) {
 var bud = parsed && parsed.detail && parsed.detail.budget
 ? parsed.detail.budget
 : null;
 if (bud) setBudget(Object.assign({}, bud, { ok: false, pct_used: 100 }));
 else {
 try {
 var rb = await refreshBudget();
 if (rb) setBudget(Object.assign({}, rb, { ok: false, pct_used: 100 }));
 else {
 setBudget({
 ok: false,
 weekly_budget_usd: (state.budget && state.budget.weekly_budget_usd) || 50,
 spent_usd: (state.budget && state.budget.weekly_budget_usd) || 50,
 pct_used: 100,
 warn: false,
 });
 }
 } catch (e2) {}
 }
 throw new Error(
 "Weekly Energy Agent limit reached, the red meter is full. " +
 "Voice pauses until next week (or the cap is raised)."
 );
 }
 // OpenAI org billing / key issues, distinct from our weekly meter
 var dstr = typeof detail === "string" ? detail : JSON.stringify(detail || "");
 if (/insufficient_quota|billing|credit|rate.?limit|exceeded/i.test(dstr)) {
 throw new Error(
 "GPT voice provider rejected the call (billing/quota on the OpenAI side). " +
 "Our weekly meter is separate, Ford may need to top up the OpenAI account."
 );
 }
 throw new Error(typeof detail === "string" ? detail : dstr);
 }
 var answerSdp = await sdpRes.text();
 if (_voiceConnectStale(gen) || state.pc !== pc) {
 try { pc.close(); } catch (e) {}
 throw new Error("voice_muted");
 }
 // Guard closed PC (mute mid-fetch), never surface this as a chat bubble
 if (pc.signalingState === "closed") throw new Error("voice_muted");
 await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
 if (_voiceConnectStale(gen) || state.pc !== pc) {
 try { pc.close(); } catch (e) {}
 throw new Error("voice_muted");
 }

 state.listening = true;
 state.voiceMode = "realtime";
 state.realtimeReady = true;
 syncMicBtn();
 setStatus("Listening…", "listen");
 // No chat bubble for voice-connect, status pill already shows Listening…
 }

 /**
 * Mic-only fallback when Realtime WebRTC fails: browser SpeechRecognition
 * for listening. Agent replies stay silent (no speechSynthesis robot voice).
 */
 function startWebSpeechFallback(fromOpen) {
 if (state.voiceMuted) {
 setStatus("Text only, voice off", "on");
 return;
 }
 var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
 if (!SR) {
 if (!fromOpen) {
 addMsg("agent", "Voice mouth offline, type instead. (No robot reader.)");
 }
 setStatus("Type to chat", "warn");
 return;
 }
 stopVoice();
 // Kill any leftover browser reader from older sessions
 try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
 // Keep mic permission warm
 ensureMicStream().catch(function () {});

 var recog = new SR();
 recog.continuous = true;
 recog.interimResults = true;
 recog.lang = "en-US";
 var finalBuf = "";
 recog.onresult = function (ev) {
 var interim = "";
 for (var i = ev.resultIndex; i < ev.results.length; i++) {
 var t = ev.results[i][0].transcript;
 if (ev.results[i].isFinal) finalBuf += t + " ";
 else interim += t;
 }
 if (finalBuf.trim()) {
 var said = finalBuf.trim();
 finalBuf = "";
 if (!acceptUserTranscript(said)) return;
 if (isStopCommand(said)) {
 addMsg("user", said);
 handleStopCommand();
 return;
 }
 if (state.thinking || state._turnBusy) {
 abortInFlightTurn("barge_in");
 }
 stopSpeak({ reason: "barge_in" });
 turn(said, "voice").catch(function () {});
 } else if (interim) {
 setStatus("Hearing: " + interim.slice(0, 40), "listen");
 }
 };
 recog.onerror = function (e) {
 if (e.error === "not-allowed") {
 addMsg("agent", "Microphone blocked, click the lock icon in the address bar → allow mic, then Mic on.");
 setStatus("Mic blocked", "warn");
 state.listening = false;
 syncMicBtn();
 }
 };
 recog.onend = function () {
 if (state.open && state.listening && state.voiceMode === "webspeech") {
 try { recog.start(); } catch (e) {}
 }
 };
 try {
 recog.start();
 state.recog = recog;
 state.listening = true;
 state.voiceMode = "webspeech";
 syncMicBtn();
 setStatus("Listening (replies silent until voice reconnects)…", "listen");
 } catch (e) {
 setStatus("Mic error", "warn");
 }
 }

 async function startVoice(fromOpen) {
 if (!signedIn()) {
 addMsg("agent", "Sign in first.");
 return;
 }
 // Muted = text only, never open Realtime / burn voice credits
 if (state.voiceMuted) {
 setStatus("Text only, voice off", "on");
 syncMicBtn();
 return;
 }
 try {
 // Always request mic first (shows Chrome prompt if needed)
 await ensureMicStream();
 } catch (err) {
 var name = (err && err.name) || "";
 if (name === "NotAllowedError" || name === "PermissionDeniedError") {
 addMsg("agent", "Microphone permission denied. In Chrome: address bar lock → Site settings → Microphone → Allow, then click Mic.");
 setStatus("Mic blocked", "warn");
 } else {
 // Status only, avoid technical error bubbles on mute/reconnect races
 setStatus("Mic error", "warn");
 }
 return;
 }

 // Prefer GPT Realtime if server has OPENAI_API_KEY
 try {
 await startRealtimeVoice();
 return;
 } catch (e) {
 var msg = String(e.message || e);
 if (state.voiceMuted || /voice_muted/i.test(msg)) {
 setStatus("Text only, voice off", "on");
 return;
 }
 // Transient WebRTC race (mute mid-connect, closed PC), quiet status + one retry
 if (/signalingState|closed|InvalidStateError|AbortError/i.test(msg) && state.open && !state.voiceMuted) {
 setStatus("Reconnecting voice…", "think");
 try {
 await startRealtimeVoice();
 return;
 } catch (e2) {
 var msg2 = String(e2.message || e2);
 if (state.voiceMuted || /voice_muted/i.test(msg2)) {
 setStatus("Text only, voice off", "on");
 return;
 }
 }
 }
 // Never dump stack/API messages into the chat, status line only.
 // Mic can still use browser SpeechRecognition for *listening*; agent
 // replies stay silent if Realtime is down (no robot TTS).
 if (/not configured|OPENAI_API_KEY|503/i.test(msg)) {
 setStatus("Voice unavailable, type instead", "warn");
 } else {
 setStatus("Mic only, agent voice offline", "warn");
 }
 if (state.voiceMuted) return;
 startWebSpeechFallback(fromOpen);
 }
 }

 function toggleMic() {
 if (state.voiceMuted) {
 // Voice fully off, Live mic would only burn credits with nowhere to send audio
 setStatus("Unmute first for voice · text still works", "on");
 return;
 }
 if (state.listening) {
 // Mute only, keep WebRTC data channel so GPT voice still speaks replies.
 // (Old path called stopVoice and fell back to robotic browser TTS.)
 setMicListening(false);
 setStatus("Mic muted · GPT voice still on for replies", "on");
 } else {
 // Click path, safe for permission prompt / reconnect
 if (realtimeMouthOpen()) {
 setMicListening(true);
 setStatus("Listening…", "listen");
 } else {
 requestMicFromClick();
 }
 }
 }

 // ── boot: show mic CTA (browsers block silent getUserMedia on load) ──────
 function refreshMicGate() {
 if (!signedIn()) {
 showMicGate(false);
 return;
 }
 // If we already hold a live stream, hide the gate
 if (state.micStream && state.micStream.getTracks().some(function (t) {
 return t.readyState === "live";
 })) {
 showMicGate(false);
 setStatus("Mic ready, click the sun to talk", "on");
 return;
 }
 // Permissions API (Chrome): show CTA when still "prompt" or "denied"
 if (navigator.permissions && navigator.permissions.query) {
 navigator.permissions.query({ name: "microphone" }).then(function (p) {
 if (p.state === "granted") {
 showMicGate(false);
 setStatus("Mic ready, click the sun to talk", "on");
 // Warm stream without needing another click when already granted
 ensureMicStream().then(function () {
 try { state.micStream.getTracks().forEach(function (t) { t.enabled = false; }); } catch (e) {}
 }).catch(function () {});
 } else if (p.state === "denied") {
 showMicGate(true, "Mic blocked, fix in browser settings");
 setStatus("Mic blocked", "warn");
 } else {
 // "prompt", must click to trigger the browser dialog
 showMicGate(true, "Allow microphone");
 setStatus("Click “Allow microphone” to enable voice", "warn");
 }
 try {
 p.onchange = function () { refreshMicGate(); };
 } catch (e) {}
 }).catch(function () {
 // Safari etc., always show the click-to-allow chip
 showMicGate(true, "Allow microphone");
 });
 } else {
 showMicGate(true, "Allow microphone");
 }
 }

 /** Body class for Repairs dual-pane CSS (wide chat under full tabbar). */
 function syncOpsWideClass() {
 var onOps = false;
 try {
 var h = String(location.hash || "").toLowerCase();
 if (h === "#ops" || h === "#claims" || h === "#repairs") onOps = true;
 if (!onOps) {
 var p = document.getElementById("panelOps");
 if (p && p.classList.contains("active")) onOps = true;
 }
 } catch (e) {}
 try {
 document.body.classList.toggle("ea-on-ops", !!onOps);
 } catch (e2) {}
 }

 // ── boot ─────────────────────────────────────────────────────────────────
 function boot() {
 ensureUi();
 // Hide orb on pure login pages
 if (/\/login/i.test(location.pathname) && !signedIn()) {
 var r = document.getElementById("eaRoot");
 if (r) r.style.display = "none";
 return;
 }
 // Seamless merge: hide residual floating "Wish this was better" chrome —
 // Improve lives entirely inside Energy Agent now.
 try {
 document.documentElement.classList.add("ea-merged");
 var wrap = document.getElementById("fsWrap");
 if (wrap && signedIn()) wrap.style.display = "none";
 } catch (e) {}
 // Keep ea-on-ops in sync so opening EA on Repairs gets the wide dual-pane.
 try {
 syncOpsWideClass();
 window.addEventListener("hashchange", syncOpsWideClass);
 // Sandbox may flip .panel.active without a hash tick in some paths
 document.addEventListener("ao-view-change", syncOpsWideClass);
 } catch (eSync) {}
 if (signedIn()) {
 // Don't call getUserMedia here, Chrome ignores it without a user gesture.
 // Show the clickable gate so the user can grant mic with one click.
 setTimeout(refreshMicGate, 400);
 }
 }

 if (document.readyState === "loading") {
 document.addEventListener("DOMContentLoaded", boot);
 } else {
 boot();
 }

 window.__eaOpen = function () { setOpen(true); };
 window.__eaClose = function () { setOpen(false); };
 /**
 * Open the agent and put text in the composer WITHOUT sending.
 * Used by Repairs tab: staged "tell me about my repair system" prompt.
 */
 window.__eaStagePrompt = function (text) {
 text = String(text || "");
 return setOpen(true).then(function () {
 return new Promise(function (resolve) {
 // Wait a frame so #eaInput exists after ensureUi
 requestAnimationFrame(function () {
 setTimeout(function () {
 try {
 var input = document.getElementById("eaInput");
 if (input) {
 input.value = text;
 try {
 input.dispatchEvent(new Event("input", { bubbles: true }));
 } catch (e) {}
 try {
 input.focus();
 // Place caret at end
 var n = input.value.length;
 input.setSelectionRange(n, n);
 } catch (e2) {}
 }
 } catch (e3) {}
 resolve();
 }, 40);
 });
 });
 });
 };
 /** Programmatic user turn (mobile OS chips, quick actions). */
 window.__eaSendText = function (text, opts) {
 opts = opts || {};
 text = String(text || "").trim();
 if (!text) return Promise.resolve();
 return setOpen(true).then(function () {
 return turn(text, opts.source || "programmatic", opts);
 });
 };
})();
