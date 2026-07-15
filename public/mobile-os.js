/* ============================================================================
 * Mobile OS, Energy Agent is the home surface on phones / foldables (≤960px).
 *
 * Setup is woven into the Agent home (not a bolted-on tour modal):
 *   · Hands-off pillars (arrays → auto-refresh → utility → offtakers → send → pay)
 *   · Product learn path (triage, analysis, trends, alerts, invoices tools, resources…)
 *   · Each step: Talk to Agent + Open surface (Detail when needed) + smart CTAs
 *   · Inline actions: delivery mode, Stripe Connect, deep-open vault/import/etc.
 * Running phase: systems overview + quick agent briefs
 * Detail mode: full tab UI + compact FAB tray
 * ========================================================================== */
(function () {
  "use strict";

  var MQ = "(max-width: 960px)";
  var DETAIL_KEY = "ao_mh_detail";
  var STORY_KEY = "ao_mh_story";
  var SKIP_KEY = "ao_mh_skip"; // JSON {stepId: true}
  var VISIT_KEY = "ao_mh_visited"; // JSON string[] of learn step ids

  var state = {
    active: false,
    mode: "ai", // ai | detail
    live: null,
    pipeline: null,
    fleet: null,
    phase: "setup", // setup | running
    story: "hands_off", // hands_off | fleet | invoices | learn
    focusStep: null,
    probeTimer: null,
    expanded: false, // show all pillar cards vs progressive
  };

  // ── Hands-off pillars (must turn green for "running") ───────────────────
  var PILLARS = [
    {
      id: "arrays",
      story: "hands_off",
      label: "Arrays live",
      sub: "Production feed connected",
      why: "Hands-off starts with a live feed. SolarEdge/Locus poll server-side; Fronius/SMA/Chint need a portal login.",
      prompt:
        "Help me get every array talking. Walk me through connecting my inverter portals so production stays live hands-off. Prefer one-click login over pasting keys.",
      hash: "#arrays",
      detailHint: "Inverters",
      open: { openSandbox: true, openAddArray: true },
      openLabel: "Add array",
      statusLine: function (L) {
        if (L && L.arrays)
          return (L.arrayCount || 0) + " array" + ((L.arrayCount || 0) === 1 ? "" : "s") + " connected";
        return "No arrays yet";
      },
      done: function (L) {
        return !!(L && L.arrays);
      },
    },
    {
      id: "autorefresh",
      story: "hands_off",
      label: "Auto-refresh",
      sub: "Cloud capture on 24/7",
      why: "Save a monitoring login encrypted with us, we refresh live data without a browser tab.",
      prompt:
        "I want cloud auto-refresh so data stays fresh without a browser tab. Help me save a portal login for 24/7 capture (Store it with us). Walk me through Chint/Fronius/SMA/SolarEdge.",
      hash: "#account",
      detailHint: "Account · Auto-refresh",
      open: { openAr: true },
      openLabel: "Open vault",
      statusLine: function (L) {
        if (L && L.cloud)
          return (
            "On · " +
            (L.cloudCreds || 0) +
            " login" +
            ((L.cloudCreds || 0) === 1 ? "" : "s")
          );
        return "Not configured";
      },
      done: function (L) {
        return !!(L && L.cloud);
      },
    },
    {
      id: "utility",
      story: "hands_off",
      label: "Utility bills",
      sub: "Invoice source of truth",
      why: "Offtaker invoices use utility bills, not raw inverter kWh alone. Save GMP or co-op login so bills keep landing.",
      prompt:
        "Help me save my utility login (GMP or SmartHub co-op) so bills keep landing for offtaker invoices without opening the portal.",
      hash: "#reports",
      detailHint: "Invoices · bill sources",
      open: {},
      openLabel: "Bill sources",
      statusLine: function (L) {
        if (L && L.utilWithBills > 0)
          return L.utilWithBills + " bill source" + (L.utilWithBills === 1 ? "" : "s");
        if (L && L.utilCount > 0) return L.utilCount + " accounts · waiting on bills";
        return "No utility linked";
      },
      done: function (L) {
        return !!(L && (L.utilities || L.utilWithBills > 0 || L.utilCount > 0));
      },
    },
    {
      id: "offtakers",
      story: "hands_off",
      label: "Offtakers",
      sub: "Who you bill (optional)",
      why: "If you invoice customers, add offtakers with share % and bill source once.",
      prompt:
        "Help me set up offtakers for solar-credit invoices, name, email, share %, bill source. If I only monitor, tell me how to skip. Offer bulk import if I have a spreadsheet.",
      hash: "#reports",
      detailHint: "Invoices · Offtakers",
      open: { openOfftakers: true },
      openLabel: "Open roster",
      optional: true,
      statusLine: function (L) {
        if (L && L.offtakers)
          return (L.offtakerCount || 0) + " offtaker" + ((L.offtakerCount || 0) === 1 ? "" : "s");
        if (isSkipped("offtakers")) return "Skipped · monitor only";
        return "Optional · for credit invoices";
      },
      done: function (L) {
        return !!(L && L.offtakers) || isSkipped("offtakers");
      },
      skipLabel: "I only monitor",
    },
    {
      id: "autosend",
      story: "hands_off",
      label: "Send mode",
      sub: "Approve vs auto-send",
      why: "Choose fleet default: preview each invoice, or auto-send when the bill settles.",
      prompt:
        "Help me choose invoice send mode: Approve to send vs Auto-send when a utility bill settles. Explain tradeoffs briefly, then guide me.",
      hash: "#reports",
      detailHint: "Invoices · pipeline",
      open: { openPreview: true },
      openLabel: "Preview invoice",
      needsOfftakers: true,
      special: "delivery",
      statusLine: function (L) {
        if (!(L && L.offtakers)) return "Optional until you invoice";
        if (L.deliveryChosen)
          return L.deliveryMode === "auto" ? "Auto-send on" : "Approve to send";
        return "Choose how reports leave";
      },
      done: function (L) {
        if (!(L && L.offtakers)) return true;
        return !!(L && L.deliveryChosen) || isSkipped("autosend");
      },
    },
    {
      id: "onlinepay",
      story: "hands_off",
      label: "Online pay",
      sub: "Collect without chasing",
      why: "Stripe Connect puts a Pay button on offtaker emails so money lands in your bank.",
      prompt:
        "Enable online pay for offtakers via Stripe Connect so invoice emails can collect payment automatically. Walk me through the ~2 min setup.",
      hash: "#account",
      detailHint: "Account · online pay",
      open: { openPay: true },
      openLabel: "Account pay",
      needsOfftakers: true,
      special: "connect",
      statusLine: function (L) {
        if (!(L && L.offtakers)) return "Optional until you invoice";
        if (L.onlinePay) return "Online pay ON";
        if (L.onlinePayConnected) return "Finish bank on Stripe";
        if (isSkipped("onlinepay")) return "Collect offline";
        return "Not enabled";
      },
      done: function (L) {
        if (!(L && L.offtakers)) return true;
        return !!(L && L.onlinePay) || isSkipped("onlinepay");
      },
      skipLabel: "Collect offline",
    },
  ];

  // Product surfaces woven as story chips (not required for hands-off green)
  var LEARN = [
    {
      id: "triage",
      story: "fleet",
      label: "Fleet Triage",
      sub: "Who needs me now",
      why: "Fleet summary and priority attention list.",
      prompt:
        "Walk me through Fleet Triage, what the health cards mean and how I drill into a problem array.",
      hash: "#dashboard",
      openLabel: "Open Triage",
    },
    {
      id: "alerts",
      story: "fleet",
      label: "Alerts",
      sub: "Email when it slips",
      why: "Configure Alerts so issues are delivered without continuous monitoring.",
      prompt:
        "Help me set up inverter alerts: who gets email, grace window, and when to stay quiet after recovery.",
      hash: "#dashboard",
      open: { openAlerts: true },
      openLabel: "Open Alerts",
    },
    {
      id: "spreadsheet",
      story: "fleet",
      label: "Spreadsheet",
      sub: "Vendor table view",
      why: "Same fleet as rows, every vendor, live now, today kWh, status.",
      prompt:
        "Show me the Spreadsheet view under Inverters and when it's better than the Sandbox map.",
      hash: "#arrays",
      open: { openSheet: true },
      openLabel: "Open sheet",
    },
    {
      id: "addarray",
      story: "fleet",
      label: "Add array",
      sub: "Connect more sites",
      why: "Prefer one-click portal login; keys stay behind Enter manually.",
      prompt:
        "I want to add another array or vendor. Walk me through + Add array with the easiest path for my vendor.",
      hash: "#arrays",
      open: { openAddArray: true },
      openLabel: "Add array",
    },
    {
      id: "analysis",
      story: "fleet",
      label: "Analysis",
      sub: "Weather vs yield",
      why: "NOC view: expected vs actual, sites, hardware.",
      prompt:
        "Show me how to use Analysis when yield feels off, weather-expected, sites grid, what to check first.",
      hash: "#analysis",
      openLabel: "Open Analysis",
    },
    {
      id: "trends",
      story: "fleet",
      label: "Trends",
      sub: "Through time",
      why: "Daily bars, monthly, liquid, spiral, lenses on real generation history.",
      prompt:
        "Open Trends under Analysis and explain which view to use for a board vs day-to-day ops.",
      hash: "#trends",
      openLabel: "Open Trends",
    },
    {
      id: "bulkimport",
      story: "invoices",
      label: "Bulk import",
      sub: "Whole roster at once",
      why: "Import offtaker spreadsheets instead of typing dozens of rows.",
      prompt:
        "I have a spreadsheet of offtakers. Walk me through bulk import on Invoices, what columns you need and how review works.",
      hash: "#reports",
      open: { openBulk: true },
      openLabel: "Bulk import",
    },
    {
      id: "billaudit",
      story: "invoices",
      label: "Bill audit",
      sub: "Share vs utility",
      why: "Compare utility-credited allocation to your offtaker shares.",
      prompt:
        "Explain Bill audit on Invoices, when it runs, what a mismatch means, and how I fix shares.",
      hash: "#reports",
      open: { openAudit: true },
      openLabel: "Bill audit",
    },
    {
      id: "resources",
      story: "learn",
      label: "Resources",
      sub: "Rates & rules",
      why: "Net-metering rates and local context before you set credit rates (Repairs → Resources).",
      prompt:
        "What does Repairs → Resources help with for VT/New England operators, and when should I open it?",
      hash: "#resources",
      openLabel: "Open Resources",
    },
    {
      id: "ops",
      story: "fleet",
      label: "Repairs",
      sub: "Command center",
      why: "Battle cards for every active repair: detect fault, draft outreach, coordinate with tech, verify recovery, close.",
      prompt:
        "Walk me through the Repairs command center: how cases open when an inverter faults, how I approve outreach, and how EnergyAgent closes a case when hardware recovers.",
      hash: "#ops",
      openLabel: "Open Repairs",
    },
    {
      id: "account",
      story: "learn",
      label: "Account",
      sub: "Plan, card, vault",
      why: "Company profile, plan, billing, Auto-refresh home, online pay status.",
      prompt:
        "Walk me through Account: plan gates, billing card, Auto-refresh vault, and online pay status.",
      hash: "#account",
      openLabel: "Account",
    },
    {
      id: "agent",
      story: "learn",
      label: "Energy Agent",
      sub: "You are here",
      why: "Talk to me for setup, fleet status, offtaker edits, and escalations to Ford.",
      prompt:
        "What can you do for me as Energy Agent on mobile? Give a short capability map focused on hands-off setup and day-to-day ops.",
      hash: null,
      openLabel: null,
    },
  ];

  var STORIES = [
    { id: "hands_off", label: "Go hands-off", desc: "Required path to automatic" },
    { id: "fleet", label: "Know the fleet", desc: "Triage, alerts, analysis" },
    { id: "invoices", label: "Invoice tools", desc: "Import & audit" },
    { id: "learn", label: "More", desc: "Resources & account" },
  ];

  // ── helpers ──────────────────────────────────────────────────────────────
  function isMobile() {
    try {
      return !!(window.matchMedia && matchMedia(MQ).matches);
    } catch (e) {
      return innerWidth <= 960;
    }
  }
  function session() {
    try {
      return localStorage.getItem("so_session") || "";
    } catch (e) {
      return "";
    }
  }
  function signedIn() {
    return !!session();
  }
  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = session();
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }
  function tourDone() {
    try {
      return localStorage.getItem("ao_hands_off_tour") === "done";
    } catch (e) {
      return false;
    }
  }
  function wantsDetail() {
    try {
      return localStorage.getItem(DETAIL_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function setDetailPref(on) {
    try {
      if (on) localStorage.setItem(DETAIL_KEY, "1");
      else localStorage.removeItem(DETAIL_KEY);
    } catch (e) {}
  }
  function loadSkip() {
    try {
      return JSON.parse(localStorage.getItem(SKIP_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function isSkipped(id) {
    return !!loadSkip()[id];
  }
  function setSkipped(id) {
    var o = loadSkip();
    o[id] = true;
    try {
      localStorage.setItem(SKIP_KEY, JSON.stringify(o));
    } catch (e) {}
  }
  function loadVisited() {
    try {
      var raw = localStorage.getItem(VISIT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  function markVisited(id) {
    if (!id) return;
    try {
      var v = loadVisited();
      if (v.indexOf(id) < 0) {
        v.push(id);
        localStorage.setItem(VISIT_KEY, JSON.stringify(v));
      }
    } catch (e) {}
  }
  function isVisited(id) {
    return loadVisited().indexOf(id) >= 0;
  }
  function loadStory() {
    try {
      return localStorage.getItem(STORY_KEY) || "hands_off";
    } catch (e) {
      return "hands_off";
    }
  }
  function saveStory(id) {
    try {
      localStorage.setItem(STORY_KEY, id);
    } catch (e) {}
    state.story = id;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function requiredLeft(L) {
    L = L || {};
    var n = 0;
    if (!L.arrays) n++;
    if (!L.cloud) n++;
    if (!(L.utilities || L.utilWithBills > 0 || L.utilCount > 0)) n++;
    if (L.offtakers && !L.deliveryChosen && !isSkipped("autosend")) n++;
    if (L.offtakers && !L.onlinePay && !isSkipped("onlinepay")) n++;
    return n;
  }

  function progressPct(L) {
    L = L || {};
    var done = 0;
    var total = 0;
    PILLARS.forEach(function (p) {
      if (p.needsOfftakers && !L.offtakers) return;
      if (p.optional && !L.offtakers) {
        total++;
        if (p.done(L)) done++;
        return;
      }
      total++;
      if (p.done(L)) done++;
    });
    if (!total) return 100;
    return Math.round((done / total) * 100);
  }

  function nextPillar(L) {
    for (var i = 0; i < PILLARS.length; i++) {
      var p = PILLARS[i];
      if (p.needsOfftakers && !(L && L.offtakers)) continue;
      if (!p.done(L)) return p;
    }
    return null;
  }

  function isHandsOffReady(L) {
    return requiredLeft(L) === 0 && !!(L && L.arrays && L.cloud);
  }

  // ── probes ───────────────────────────────────────────────────────────────
  async function probeLive() {
    if (typeof window.__aoHandsOffTourProbe === "function") {
      try {
        state.live = await window.__aoHandsOffTourProbe();
        // Normalize utilities flag for pillar done()
        if (state.live) {
          state.live.utilities = !!(
            state.live.utilities ||
            state.live.utilWithBills > 0 ||
            state.live.utilCount > 0
          );
        }
        return state.live;
      } catch (e) {}
    }
    var live = {
      arrays: false,
      arrayCount: 0,
      cloud: false,
      cloudCreds: 0,
      utilities: false,
      utilCount: 0,
      utilWithBills: 0,
      offtakers: false,
      offtakerCount: 0,
      deliveryChosen: false,
      deliveryMode: "approval",
      onlinePay: false,
      cloudLogins: [],
    };
    try {
      if (window.FleetStore && FleetStore.isLoaded && FleetStore.isLoaded()) {
        var arr = (FleetStore.snapshot() || {}).arrays || [];
        live.arrayCount = arr.length;
        live.arrays = arr.length > 0;
      }
    } catch (e) {}
    state.live = live;
    return live;
  }

  async function probePipeline() {
    if (!signedIn()) return null;
    try {
      var r = await fetch("/v1/array-operator/billing/send-pipeline", {
        headers: authHeaders(),
      });
      if (!r.ok) return null;
      state.pipeline = await r.json();
      return state.pipeline;
    } catch (e) {
      return null;
    }
  }

  function fleetRollup() {
    var out = {
      arrays: 0,
      inverters: 0,
      ok: 0,
      attn: 0,
      dead: 0,
      lastSync: null,
    };
    try {
      if (!window.FleetStore || !FleetStore.snapshot) return out;
      var arr = (FleetStore.snapshot() || {}).arrays || [];
      out.arrays = arr.length;
      arr.forEach(function (a) {
        var invs = (a && a.inverters) || [];
        out.inverters += invs.length;
        invs.forEach(function (inv) {
          var st = String(
            (inv && (inv.status || inv.health || inv.peer_status)) || ""
          ).toLowerCase();
          if (/dead|fault|offline|comm/.test(st)) out.dead++;
          else if (/under|attn|warn|need/.test(st)) out.attn++;
          else out.ok++;
        });
        var ts = a.last_sync_at || a.synced_at || a.updated_at || null;
        if (ts && (!out.lastSync || String(ts) > String(out.lastSync)))
          out.lastSync = ts;
      });
    } catch (e) {}
    state.fleet = out;
    return out;
  }

  function offtakerRollup(L, pipe) {
    L = L || state.live || {};
    pipe = pipe || state.pipeline || {};
    var total = L.offtakerCount || 0;
    var last = pipe.last || pipe.previous || null;
    var delivered =
      last && (last.delivered != null ? last.delivered : last.sent);
    var enabled = pipe.total_enabled != null ? pipe.total_enabled : total;
    var mode = pipe.default_delivery_mode || L.deliveryMode || "approval";
    var period =
      (last && (last.period_month || last.period_label)) || null;
    var rate =
      enabled > 0 && delivered != null
        ? Math.round((Number(delivered) / Number(enabled)) * 100)
        : null;
    return {
      total: total,
      delivered: delivered != null ? Number(delivered) : null,
      enabled: enabled,
      successPct: rate,
      mode: mode,
      period: period,
      onlinePay: !!L.onlinePay,
    };
  }

  function relTime(iso) {
    if (!iso) return "—";
    try {
      var t = new Date(iso).getTime();
      if (!isFinite(t)) return String(iso).slice(0, 16);
      var sec = Math.round((Date.now() - t) / 1000);
      if (sec < 60) return "just now";
      if (sec < 3600) return Math.floor(sec / 60) + "m ago";
      if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
      return Math.floor(sec / 86400) + "d ago";
    } catch (e) {
      return "—";
    }
  }

  // ── surface open (Detail + deep links shared with hands-off tour) ────────
  function openSurface(step) {
    if (!step) return;
    markVisited(step.id);
    // Agent-only step: stay on AI
    if (!step.hash && !step.open) {
      if (step.prompt) askAgent(step.prompt);
      return;
    }
    enterDetail();
    var open = step.open || {};
    var opts = {
      hash: step.hash || "",
      openAr: !!open.openAr,
      openPay: !!open.openPay,
      openPreview: !!open.openPreview,
      openSheet: !!open.openSheet,
      openSandbox: !!open.openSandbox,
      openAddArray: !!open.openAddArray,
      openAlerts: !!open.openAlerts,
      openBulk: !!open.openBulk,
      openAudit: !!open.openAudit,
      openOfftakers: !!open.openOfftakers,
      openAgent: !!open.openAgent,
    };
    if (typeof window.__aoHandsOffGoSurface === "function") {
      window.__aoHandsOffGoSurface(opts);
      return;
    }
    // Fallback without tour helper
    if (opts.hash) {
      try {
        location.hash = opts.hash;
      } catch (e) {}
    }
  }

  async function setDeliveryMode(mode, btn) {
    mode = mode === "auto" ? "auto" : "approval";
    if (typeof window.__aoHandsOffSetDeliveryMode === "function") {
      await window.__aoHandsOffSetDeliveryMode(mode, btn);
      await refresh();
      return;
    }
    try {
      localStorage.setItem("ao_ho_delivery_chosen", mode);
    } catch (e) {}
    if (state.live) {
      state.live.deliveryMode = mode;
      state.live.deliveryChosen = true;
    }
    try {
      await fetch("/v1/array-operator/billing/subscriptions/bulk-delivery-mode", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ mode: mode }),
      });
    } catch (e) {}
    await refresh();
  }

  async function startConnect(btn) {
    if (typeof window.__aoHandsOffStartConnect === "function") {
      await window.__aoHandsOffStartConnect(btn);
      return;
    }
    // Minimal fallback
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Opening Stripe…";
      }
      var r = await fetch("/v1/array-operator/billing/payments/connect", {
        method: "POST",
        headers: authHeaders(),
        body: "{}",
      });
      var d = {};
      try {
        d = await r.json();
      } catch (e) {}
      if (r.ok && d.url) {
        try {
          sessionStorage.setItem("ao_ho_resume_step", "onlinepay");
        } catch (e) {}
        window.location = d.url;
        return;
      }
      openSurface({ id: "onlinepay", hash: "#account", open: { openPay: true } });
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    }
  }

  // ── context for Energy Agent ─────────────────────────────────────────────
  function buildOsContext() {
    var L = state.live || {};
    var fl = state.fleet || fleetRollup();
    var of = offtakerRollup(L);
    var next = nextPillar(L);
    var phase =
      isHandsOffReady(L) || (tourDone() && L.arrays && L.cloud)
        ? "running"
        : "setup";
    if (tourDone() && requiredLeft(L) > 0) phase = "setup";
    state.phase = phase;
    return {
      mobile_os: true,
      mobile_mode: state.mode,
      phase: phase,
      story: state.story,
      hands_off_ready: isHandsOffReady(L),
      setup_progress_pct: progressPct(L),
      setup_required_left: requiredLeft(L),
      next_setup_step: next
        ? { id: next.id, label: next.label, prompt: next.prompt }
        : null,
      pillars: PILLARS.map(function (p) {
        return {
          id: p.id,
          label: p.label,
          done: p.done(L),
          optional: !!p.optional,
          skipped: isSkipped(p.id),
        };
      }),
      product_surfaces: LEARN.map(function (s) {
        return { id: s.id, label: s.label, story: s.story, visited: isVisited(s.id) };
      }),
      live: {
        arrays: !!L.arrays,
        array_count: L.arrayCount || fl.arrays || 0,
        inverter_count: fl.inverters || 0,
        cloud_auto_refresh: !!L.cloud,
        cloud_logins: L.cloudCreds || 0,
        utilities: !!(L.utilities || L.utilWithBills || L.utilCount),
        utility_accounts: L.utilCount || 0,
        bills_on_file: L.utilWithBills || 0,
        offtakers: !!L.offtakers,
        offtaker_count: L.offtakerCount || 0,
        delivery_chosen: !!L.deliveryChosen,
        delivery_mode: L.deliveryMode || null,
        online_pay: !!L.onlinePay,
      },
      systems: {
        inverters: {
          ok: fl.ok,
          attention: fl.attn,
          dead: fl.dead,
          last_sync_rel: relTime(fl.lastSync),
          cadence: "Inverters ~3 min when cloud capture is on; utility bills ~12h",
        },
        offtakers: {
          count: of.total,
          last_period: of.period,
          sent: of.delivered,
          enabled: of.enabled,
          success_pct: of.successPct,
          delivery_mode: of.mode,
          online_pay: of.onlinePay,
        },
      },
      ui_contract: {
        role: "You ARE the operating layer on mobile. Owner talks to you to finish setup and run the fleet.",
        setup_goal:
          "Get them hands-off automatic: arrays → auto-refresh → utility bills → offtakers (optional) → send mode → online pay.",
        weave:
          "When they open a step, stay on that step until green. Offer Detail mode only for deep forms (bulk import, Stripe bank, vault). Product surfaces (Triage, Analysis, Alerts…) live under story chips, introduce them after pillars are underway, not before arrays are live.",
        actions:
          "Prefer Talk-to-Agent guidance. When they need a form, tell them to tap Open surface / the step CTA. Delivery mode and Stripe Connect can be done from the checklist chips without leaving Agent home.",
      },
    };
  }

  window.__aoMobileOsContext = buildOsContext;
  window.__aoMobileOsIsActive = function () {
    return !!(state.active && state.mode === "ai");
  };
  window.__aoMobileOsPhase = function () {
    return state.phase;
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  function ensureShell() {
    if (!document.getElementById("mhOs")) {
      var root = document.createElement("div");
      root.id = "mhOs";
      root.setAttribute("aria-hidden", "true");
      root.innerHTML =
        '<div class="mh-top" id="mhTop">' +
        '  <div class="mh-brand">' +
        '    <span class="mh-orb" aria-hidden="true"></span>' +
        '    <div class="mh-brand-tx">' +
        '      <b id="mhTitle">Energy Agent</b>' +
        '      <small id="mhSub">Your operating layer</small>' +
        "    </div>" +
        "  </div>" +
        '  <div class="mh-meter" id="mhMeter" hidden>' +
        '    <span class="mh-meter-lab" id="mhMeterLab">Setup</span>' +
        '    <span class="mh-meter-track"><i id="mhMeterFill" style="width:0%"></i></span>' +
        '    <span class="mh-meter-pct" id="mhMeterPct">0%</span>' +
        "  </div>" +
        "</div>" +
        '<div class="mh-ops" id="mhOps" role="region" aria-label="Setup and status"></div>' +
        '<div class="mh-actions" id="mhActions" role="toolbar" aria-label="Quick actions"></div>';
      document.body.appendChild(root);
    }
    if (!document.getElementById("mhDock")) {
      var dock = document.createElement("nav");
      dock.id = "mhDock";
      dock.className = "mh-dock";
      dock.setAttribute("aria-label", "Mobile mode");
      dock.innerHTML =
        '<button type="button" class="mh-dock-btn on" id="mhDockAi">' +
        '<span class="mh-dock-ic" aria-hidden="true">☀</span><span>Agent</span></button>' +
        '<button type="button" class="mh-dock-btn" id="mhDockDetail">' +
        '<span class="mh-dock-ic" aria-hidden="true">☰</span><span>Detail</span></button>';
      document.body.appendChild(dock);
    } else if (document.getElementById("mhDock").parentElement !== document.body) {
      document.body.appendChild(document.getElementById("mhDock"));
    }
    var aiB = document.getElementById("mhDockAi");
    var dB = document.getElementById("mhDockDetail");
    if (aiB && !aiB._mhBound) {
      aiB._mhBound = true;
      aiB.onclick = function () {
        enterAi();
      };
    }
    if (dB && !dB._mhBound) {
      dB._mhBound = true;
      dB.onclick = function () {
        enterDetail();
      };
    }
  }

  function measureChrome() {
    try {
      var h = 0;
      ["mhTop", "mhOps", "mhActions"].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || el.hidden) return;
        var st = getComputedStyle(el);
        if (st.display === "none") return;
        h += el.offsetHeight || 0;
      });
      if (h > 40) {
        document.documentElement.style.setProperty("--mh-chrome-h", h + "px");
      }
      document.body.classList.toggle("mh-phase-setup", state.phase === "setup");
      document.body.classList.toggle("mh-phase-running", state.phase === "running");
    } catch (e) {}
  }

  function stepsForStory(story, L) {
    if (story === "hands_off") {
      return PILLARS.filter(function (p) {
        if (p.needsOfftakers && !(L && L.offtakers)) return false;
        return true;
      });
    }
    return LEARN.filter(function (s) {
      return s.story === story;
    });
  }

  function trailHtml(L) {
    var parts = [];
    PILLARS.forEach(function (p) {
      if (p.needsOfftakers && !(L && L.offtakers)) return;
      var ok = p.done(L);
      var next = nextPillar(L);
      var isN = next && next.id === p.id;
      parts.push(
        '<button type="button" class="mh-trail-dot' +
          (ok ? " ok" : "") +
          (isN ? " next" : "") +
          '" data-focus="' +
          esc(p.id) +
          '" title="' +
          esc(p.label) +
          '" aria-label="' +
          esc(p.label + (ok ? " done" : isN ? " next" : "")) +
          '">' +
          (ok ? "✓" : isN ? "→" : "·") +
          "</button>"
      );
    });
    if (!parts.length) return "";
    return (
      '<div class="mh-trail" role="list" aria-label="Hands-off progress">' +
      parts.join('<span class="mh-trail-line" aria-hidden="true"></span>') +
      "</div>"
    );
  }

  function paintOps() {
    var ops = document.getElementById("mhOps");
    var actions = document.getElementById("mhActions");
    var meter = document.getElementById("mhMeter");
    var title = document.getElementById("mhTitle");
    var sub = document.getElementById("mhSub");
    var L = state.live || {};
    if (!ops) return;

    var phase = state.phase;
    if (phase === "setup") {
      if (title) title.textContent = "Get hands-off";
      if (sub) sub.textContent = "Complete setup with the agent";
      if (meter) {
        meter.hidden = false;
        var pct = progressPct(L);
        var fill = document.getElementById("mhMeterFill");
        var pctEl = document.getElementById("mhMeterPct");
        var lab = document.getElementById("mhMeterLab");
        if (fill) fill.style.width = pct + "%";
        if (pctEl) pctEl.textContent = pct + "%";
        if (lab) {
          var left = requiredLeft(L);
          lab.textContent = left ? left + " left" : "Almost!";
        }
      }

      var storyHtml =
        '<div class="mh-story" role="tablist" aria-label="Setup paths">';
      STORIES.forEach(function (s) {
        var on = state.story === s.id ? " on" : "";
        var cls = on;
        if (s.id === "hands_off" && isHandsOffReady(L)) cls += " done";
        storyHtml +=
          '<button type="button" class="mh-story-chip' +
          cls +
          '" data-story="' +
          esc(s.id) +
          '">' +
          esc(s.label) +
          "</button>";
      });
      storyHtml += "</div>";

      var steps = stepsForStory(state.story, L);
      var next = nextPillar(L);
      var stepsHtml = "";

      if (state.story === "hands_off") {
        stepsHtml += trailHtml(L);
        steps.forEach(function (p) {
          var ok = p.done(L);
          var isNext = next && next.id === p.id;
          var focused = state.focusStep === p.id;
          // Progressive: next always, done as compact, +1 ahead, or expanded / focused
          if (!state.expanded && !focused) {
            if (ok && !isNext) {
              // compact done row only if recently completed chain, show all done compact
              stepsHtml += renderStepCard(p, L, ok, false, true, true);
              return;
            }
            if (!ok && !isNext) {
              var ni = next ? steps.indexOf(next) : 0;
              var pi = steps.indexOf(p);
              if (pi > ni + 1) return; // hide far future
            }
          }
          stepsHtml += renderStepCard(p, L, ok, isNext || focused, true, false);
        });
        if (!state.expanded && steps.length > 3) {
          stepsHtml +=
            '<button type="button" class="mh-expand" id="mhExpandAll">Show all steps</button>';
        } else if (state.expanded) {
          stepsHtml +=
            '<button type="button" class="mh-expand" id="mhExpandAll">Show fewer</button>';
        }
      } else {
        steps.forEach(function (s) {
          stepsHtml += renderStepCard(s, L, isVisited(s.id), true, false, false);
        });
      }

      ops.innerHTML = storyHtml + stepsHtml;

      var nxt = nextPillar(L);
      if (state.story === "hands_off" && nxt) {
        actions.className = "mh-actions mh-actions-setup";
        actions.innerHTML =
          '<button type="button" class="mh-cta mh-cta-wide" id="mhPrimaryCta">Continue · ' +
          esc(nxt.label) +
          " →</button>" +
          '<button type="button" class="mh-cta ghost" id="mhAskStatus">What\'s left?</button>' +
          '<button type="button" class="mh-cta ghost" id="mhOpenDetailSoft">Open ' +
          esc(nxt.detailHint || "Detail") +
          "</button>";
      } else if (state.story === "hands_off" && !nxt) {
        actions.className = "mh-actions";
        actions.innerHTML =
          '<button type="button" class="mh-cta mh-cta-wide" id="mhPrimaryCta">Hands-off ready · overview →</button>' +
          '<button type="button" class="mh-cta ghost" id="mhExploreFleet">Explore fleet surfaces</button>';
      } else {
        actions.className = "mh-actions mh-actions-grid";
        actions.innerHTML =
          '<button type="button" class="mh-cta" id="mhPrimaryCta">Ask Agent</button>' +
          '<button type="button" class="mh-cta ghost" id="mhBackHandsOff">← Hands-off path</button>';
      }
    } else {
      // running
      if (title) title.textContent = "Hands-off running";
      if (sub) sub.textContent = "Ask Agent anything · Detail for deep edits";
      if (meter) meter.hidden = true;

      var fl = fleetRollup();
      var of = offtakerRollup(L);
      var invHealth =
        fl.inverters > 0
          ? Math.round((fl.ok / Math.max(1, fl.ok + fl.attn + fl.dead)) * 100)
          : null;
      ops.innerHTML =
        '<div class="mh-cards">' +
        '<div class="mh-card" data-run="fleet"><div class="mh-card-k">Inverters</div>' +
        '<div class="mh-card-v">' +
        esc(String(fl.inverters || L.arrayCount || 0)) +
        " <small>units · " +
        esc(String(fl.arrays || 0)) +
        " sites</small></div>" +
        '<div class="mh-card-meta">' +
        (invHealth != null
          ? invHealth + "% healthy · " + fl.attn + " need attention"
          : "Connect feeds") +
        " · " +
        esc(relTime(fl.lastSync)) +
        "</div>" +
        '<div class="mh-card-cad">Cadence · live ≤5 min on cloud capture</div></div>' +
        '<div class="mh-card" data-run="feeds"><div class="mh-card-k">Auto-refresh</div>' +
        '<div class="mh-card-v">' +
        esc(String(L.cloudCreds || 0)) +
        " login" +
        ((L.cloudCreds || 0) === 1 ? "" : "s") +
        (L.cloud ? " · on" : " · off") +
        "</div>" +
        '<div class="mh-card-meta">Bills: ' +
        esc(String(L.utilWithBills || 0)) +
        " · accounts " +
        esc(String(L.utilCount || 0)) +
        "</div>" +
        '<div class="mh-card-cad">Utilities ~12h · inverters ~3 min</div></div>' +
        '<div class="mh-card" data-run="invoices"><div class="mh-card-k">Offtakers</div>' +
        '<div class="mh-card-v">' +
        (of.total === 0
          ? "Monitor-only"
          : of.delivered != null
            ? of.delivered +
              "/" +
              of.enabled +
              " sent" +
              (of.successPct != null ? " · " + of.successPct + "%" : "")
            : of.total + " offtakers") +
        "</div>" +
        '<div class="mh-card-meta">' +
        (of.onlinePay ? "Online pay ON" : of.total ? "Pay offline / setup pay" : "No roster yet") +
        (of.mode ? " · " + of.mode : "") +
        "</div>" +
        '<div class="mh-card-cad">Send window · monthly pipeline</div></div>' +
        "</div>" +
        '<div class="mh-run-links">' +
        '<button type="button" class="mh-story-chip" data-story="fleet">Fleet tools</button>' +
        '<button type="button" class="mh-story-chip" data-story="invoices">Invoice tools</button>' +
        '<button type="button" class="mh-story-chip" data-story="learn">More</button>' +
        "</div>";

      actions.className = "mh-actions mh-actions-grid";
      actions.innerHTML =
        '<button type="button" class="mh-cta" id="mhPrimaryCta">Status brief</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskAttention">Needs attention</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskInvoices">Invoices</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskFeeds">Feeds &amp; sync</button>';
    }

    wireOps(L);
    requestAnimationFrame(function () {
      measureChrome();
      setTimeout(measureChrome, 60);
    });
  }

  function renderStepCard(p, L, ok, isNext, isPillar, compact) {
    if (compact && ok) {
      return (
        '<button type="button" class="mh-step mh-step-compact is-done" data-focus="' +
        esc(p.id) +
        '">' +
        '<span class="mh-step-mark" aria-hidden="true">✓</span>' +
        "<b>" +
        esc(p.label) +
        "</b>" +
        "<small>" +
        esc(p.statusLine ? p.statusLine(L) : "Done") +
        "</small></button>"
      );
    }

    var mark = ok ? "✓" : isNext ? "→" : "○";
    var cls =
      "mh-step" +
      (ok ? " is-done" : "") +
      (isNext ? " is-next" : "") +
      (isVisited(p.id) && !isPillar ? " is-seen" : "");

    var status = "";
    if (p.statusLine) {
      status =
        '<div class="mh-step-status' +
        (ok ? " ok" : "") +
        '">' +
        esc(p.statusLine(L)) +
        "</div>";
    }

    var special = "";
    if (isPillar && !ok && isNext && p.special === "delivery" && L.offtakers) {
      special =
        '<div class="mh-mode-pick" role="group" aria-label="Send mode">' +
        '<button type="button" class="mh-mode-btn" data-mode="approval">' +
        "<b>Approve to send</b><span>Review each draft</span></button>" +
        '<button type="button" class="mh-mode-btn rec" data-mode="auto">' +
        "<b>Auto-send</b><span>When bill settles</span></button></div>";
    }
    if (isPillar && !ok && isNext && p.special === "connect" && L.offtakers) {
      special =
        '<div class="mh-step-acts mh-step-acts-1">' +
        '<button type="button" class="mh-cta" data-connect="1">Enable online pay · ~2 min →</button></div>';
    }

    var acts = "";
    if (!ok || !isPillar) {
      acts =
        '<div class="mh-step-acts">' +
        '<button type="button" class="mh-cta" data-prompt="' +
        esc(p.prompt) +
        '">Talk to Agent</button>';
      if (p.hash || p.open) {
        acts +=
          '<button type="button" class="mh-cta ghost" data-open="' +
          esc(p.id) +
          '">' +
          esc(p.openLabel || "Open surface") +
          "</button>";
      } else {
        acts +=
          '<button type="button" class="mh-cta ghost" data-prompt="' +
          esc(p.prompt) +
          '">Ask more</button>';
      }
      acts += "</div>";
      if (isPillar && p.skipLabel && !ok) {
        acts +=
          '<div class="mh-step-acts mh-step-acts-1">' +
          '<button type="button" class="mh-cta ghost" data-skip="' +
          esc(p.id) +
          '">' +
          esc(p.skipLabel) +
          "</button></div>";
      }
    } else if (ok && isNext) {
      acts =
        '<div class="mh-step-why mh-step-ok">Complete. Use the agent for further help.</div>';
    } else if (ok) {
      // full done card when expanded
      acts =
        '<div class="mh-step-why mh-step-ok">' +
        esc(p.statusLine ? p.statusLine(L) : "Complete") +
        "</div>";
    }

    return (
      '<div class="' +
      cls +
      '" data-step="' +
      esc(p.id) +
      '">' +
      '<div class="mh-step-head">' +
      '<span class="mh-step-mark" aria-hidden="true">' +
      mark +
      "</span>" +
      '<div class="mh-step-tx"><b>' +
      esc(p.label) +
      "</b><small>" +
      esc(p.sub) +
      "</small></div></div>" +
      status +
      (p.why && (isNext || !ok)
        ? '<div class="mh-step-why">' + esc(p.why) + "</div>"
        : "") +
      special +
      acts +
      "</div>"
    );
  }

  function findStep(id) {
    var i;
    for (i = 0; i < PILLARS.length; i++) if (PILLARS[i].id === id) return PILLARS[i];
    for (i = 0; i < LEARN.length; i++) if (LEARN[i].id === id) return LEARN[i];
    return null;
  }

  function wireOps(L) {
    var ops = document.getElementById("mhOps");
    if (ops) {
      ops.querySelectorAll("[data-story]").forEach(function (btn) {
        btn.onclick = function () {
          // From running overview, flip back to setup stories temporarily
          if (state.phase === "running") {
            state.phase = "setup";
          }
          saveStory(btn.getAttribute("data-story"));
          paintOps();
        };
      });
      ops.querySelectorAll("[data-prompt]").forEach(function (btn) {
        btn.onclick = function () {
          var stepEl = btn.closest("[data-step]");
          if (stepEl) markVisited(stepEl.getAttribute("data-step"));
          askAgent(btn.getAttribute("data-prompt"));
        };
      });
      ops.querySelectorAll("[data-open]").forEach(function (btn) {
        btn.onclick = function () {
          var id = btn.getAttribute("data-open");
          var step = findStep(id);
          if (step) openSurface(step);
        };
      });
      ops.querySelectorAll("[data-skip]").forEach(function (btn) {
        btn.onclick = function () {
          setSkipped(btn.getAttribute("data-skip"));
          paintOps();
        };
      });
      ops.querySelectorAll("[data-focus]").forEach(function (btn) {
        btn.onclick = function () {
          state.focusStep = btn.getAttribute("data-focus");
          state.expanded = true;
          paintOps();
        };
      });
      ops.querySelectorAll("[data-mode]").forEach(function (btn) {
        btn.onclick = function () {
          setDeliveryMode(btn.getAttribute("data-mode"), btn).catch(function () {});
        };
      });
      ops.querySelectorAll("[data-connect]").forEach(function (btn) {
        btn.onclick = function () {
          startConnect(btn).catch(function () {});
        };
      });
      var exp = document.getElementById("mhExpandAll");
      if (exp) {
        exp.onclick = function () {
          state.expanded = !state.expanded;
          paintOps();
        };
      }
    }

    var cta = document.getElementById("mhPrimaryCta");
    if (cta) {
      cta.onclick = function () {
        if (state.phase === "setup") {
          if (state.story !== "hands_off") {
            askAgent(
              "I'm exploring " +
                state.story +
                " on mobile. Give me the most useful next tip for that area, and which surface to open in Detail."
            );
            return;
          }
          var n = nextPillar(L);
          if (n) {
            state.focusStep = n.id;
            askAgent(n.prompt);
          } else {
            state.phase = "running";
            try {
              localStorage.setItem("ao_hands_off_tour", "done");
            } catch (e) {}
            paintOps();
            askAgent(
              "Setup looks complete. Give a short hands-off status: arrays, auto-refresh, utility bills, offtakers, send mode, online pay, and anything still yellow. Mention fleet surfaces I should know (Triage, Analysis, Alerts)."
            );
          }
        } else {
          askAgent(
            "Give me a concise fleet brief: inverter health, last sync, auto-refresh, utility bills, offtaker send success. Use tools, use live tools."
          );
        }
      };
    }
    var askSt = document.getElementById("mhAskStatus");
    if (askSt) {
      askSt.onclick = function () {
        askAgent(
          "What's left on my hands-off checklist and the fastest path to green? Be specific to my live status."
        );
      };
    }
    var det = document.getElementById("mhOpenDetailSoft");
    if (det) {
      det.onclick = function () {
        var n = nextPillar(L);
        if (n) openSurface(n);
        else enterDetail();
      };
    }
    var back = document.getElementById("mhBackHandsOff");
    if (back) {
      back.onclick = function () {
        saveStory("hands_off");
        if (isHandsOffReady(L) && requiredLeft(L) === 0) state.phase = "running";
        paintOps();
      };
    }
    var explore = document.getElementById("mhExploreFleet");
    if (explore) {
      explore.onclick = function () {
        saveStory("fleet");
        paintOps();
      };
    }
    var askAtt = document.getElementById("mhAskAttention");
    if (askAtt) {
      askAtt.onclick = function () {
        askAgent(
          "What needs attention right now? Name underperforming or stale arrays, why, and next step. Use tools."
        );
      };
    }
    var askInv = document.getElementById("mhAskInvoices");
    if (askInv) {
      askInv.onclick = function () {
        askAgent(
          "Summarize offtaker invoice pipeline: count, last period sent/success, delivery mode, online pay. Short."
        );
      };
    }
    var askFeeds = document.getElementById("mhAskFeeds");
    if (askFeeds) {
      askFeeds.onclick = function () {
        askAgent(
          "How are my data feeds? Cloud logins health, utility bill freshness, anything not syncing."
        );
      };
    }
  }

  function askAgent(text) {
    enterAi();
    if (typeof window.__eaOpen === "function") window.__eaOpen();
    if (typeof window.__eaSendText === "function") {
      window.__eaSendText(text, { source: "mobile_os" });
    } else {
      var input = document.getElementById("eaInput");
      var send = document.getElementById("eaSend");
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (send) send.click();
    }
  }

  // ── modes ────────────────────────────────────────────────────────────────
  function enterAi() {
    state.mode = "ai";
    setDetailPref(false);
    applyMode();
    if (typeof window.__eaOpen === "function") {
      try {
        window.__eaOpen();
      } catch (e) {}
    }
  }

  function enterDetail() {
    state.mode = "detail";
    setDetailPref(true);
    applyMode();
    if (typeof window.__eaClose === "function") {
      try {
        window.__eaClose();
      } catch (e) {}
    }
  }

  function ensureFabTray() {
    var tray = document.getElementById("mhFabTray");
    if (tray) return tray;
    tray = document.createElement("div");
    tray.id = "mhFabTray";
    tray.className = "mh-fab-tray";
    tray.hidden = true;
    document.body.appendChild(tray);
    return tray;
  }

  function packFloatingIcons() {
    var tray = ensureFabTray();
    var pack = state.active && state.mode === "detail";
    var fabs = [];
    var al =
      document.getElementById("aoAlertFab") ||
      document.querySelector(".ao-al-fab");
    if (al) fabs.push(al);
    var ho = document.getElementById("hoPill");
    if (ho) fabs.push(ho);
    if (!pack) {
      fabs.forEach(function (el) {
        if (el.parentElement === tray) document.body.appendChild(el);
        el.style.display = "";
      });
      tray.hidden = true;
      return;
    }
    tray.hidden = false;
    fabs.forEach(function (el) {
      if (el.parentElement !== tray) tray.appendChild(el);
      if (el.id === "hoPill" && !el.classList.contains("ho-pill-show")) {
        el.style.display = "none";
      } else el.style.display = "";
    });
  }

  function applyMode() {
    var mobile = isMobile() && signedIn();
    state.active = mobile;
    document.body.classList.toggle("mh-os", mobile && state.mode === "ai");
    document.body.classList.toggle(
      "mh-detail",
      mobile && state.mode === "detail"
    );
    document.body.classList.toggle("mh-active", mobile);

    var root = document.getElementById("mhOs");
    if (root) {
      root.hidden = !mobile;
      root.setAttribute("aria-hidden", mobile ? "false" : "true");
    }
    var dock = document.getElementById("mhDock");
    if (dock) {
      dock.hidden = !mobile;
      dock.style.display = mobile ? "flex" : "none";
      if (dock.parentElement !== document.body) document.body.appendChild(dock);
    }
    var aiBtn = document.getElementById("mhDockAi");
    var dBtn = document.getElementById("mhDockDetail");
    if (aiBtn) aiBtn.classList.toggle("on", state.mode === "ai");
    if (dBtn) dBtn.classList.toggle("on", state.mode === "detail");

    // Suppress hands-off modal competition on mobile AI home
    if (mobile && state.mode === "ai") {
      try {
        var ho = document.getElementById("hoTour");
        if (ho) {
          ho.hidden = true;
          ho.classList.remove("ho-open");
        }
        document.body.classList.remove("ho-shell-open", "ho-ea-sidebyside");
        var pill = document.getElementById("hoPill");
        if (pill) pill.classList.remove("ho-pill-show");
      } catch (e) {}
    }

    try {
      packFloatingIcons();
    } catch (e) {}
    if (mobile) paintOps();
  }

  async function refresh() {
    if (!signedIn() || !isMobile()) return;
    await probeLive();
    fleetRollup();
    await probePipeline();
    var L = state.live || {};
    state.phase =
      isHandsOffReady(L) && requiredLeft(L) === 0 ? "running" : "setup";
    if (tourDone() && requiredLeft(L) > 0) state.phase = "setup";
    // After Stripe return, focus online pay
    try {
      if (/setup=connect|connect=return|stripe/i.test(location.search || "")) {
        state.focusStep = "onlinepay";
        state.story = "hands_off";
        if (state.phase === "running" && !L.onlinePay) state.phase = "setup";
      }
    } catch (e) {}
    paintOps();
  }

  function scheduleRefresh() {
    if (state.probeTimer) clearTimeout(state.probeTimer);
    state.probeTimer = setTimeout(function () {
      refresh().catch(function () {});
    }, 400);
  }

  function boot() {
    if (!signedIn()) {
      document.body.classList.remove("mh-os", "mh-detail", "mh-active");
      return;
    }
    ensureShell();
    state.story = loadStory();
    state.mode = wantsDetail() ? "detail" : "ai";
    applyMode();
    refresh().then(function () {
      if (state.active && state.mode === "ai") {
        setTimeout(function () {
          if (state.mode === "ai" && isMobile()) {
            try {
              if (typeof window.__eaOpen === "function") window.__eaOpen();
            } catch (e) {}
          }
        }, 700);
      }
    });

    try {
      var mql = matchMedia(MQ);
      var onChange = function () {
        applyMode();
        scheduleRefresh();
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    } catch (e) {}

    try {
      if (window.FleetStore && FleetStore.subscribe) {
        FleetStore.subscribe(function () {
          scheduleRefresh();
        });
      }
    } catch (e) {}

    setTimeout(packFloatingIcons, 1200);
    setTimeout(packFloatingIcons, 3500);
    window.addEventListener("ea:data-changed", scheduleRefresh);
    window.addEventListener("ao:vault-changed", scheduleRefresh);
    setInterval(function () {
      if (state.active) scheduleRefresh();
    }, 60000);
  }

  window.__aoMobileOsBoot = boot;
  window.__aoMobileOsEnterAi = enterAi;
  window.__aoMobileOsEnterDetail = enterDetail;
  window.__aoMobileOsRefresh = refresh;
  window.__aoMobileOsOpenSurface = openSurface;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(boot, 220);
    });
  } else {
    setTimeout(boot, 220);
  }
})();
