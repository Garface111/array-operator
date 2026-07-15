/* ============================================================================
 * Mobile OS — Energy Agent IS the operating layer on phones / foldables.
 *
 * Design (research-backed + Ford direction 2026-07-14):
 *   · Progressive checklist until hands-off is complete (one primary CTA)
 *   · After setup: systems overview (feeds + offtakers, cadence, success)
 *   · AI is the home surface — chat/voice drive setup and ops
 *   · "Detail mode" unlocks the full desktop tab UI for deep edits
 *
 * Activates ≤960px when signed in. Desktop unchanged.
 * ========================================================================== */
(function () {
  "use strict";

  var MQ = "(max-width: 960px)";
  var DETAIL_KEY = "ao_mh_detail";
  var state = {
    active: false,
    mode: "ai", // "ai" | "detail"
    live: null,
    pipeline: null,
    fleet: null,
    phase: "setup", // "setup" | "running"
    probeTimer: null,
  };

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
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── pillar model (mirrors hands-off-tour) ──────────────────────────────
  var PILLARS = [
    {
      id: "arrays",
      label: "Arrays live",
      sub: "Production feed",
      prompt: "Help me get every array talking — walk me through connecting my inverter feeds so production stays live.",
      hash: "#arrays",
      done: function (L) {
        return !!(L && L.arrays);
      },
    },
    {
      id: "autorefresh",
      label: "Auto-refresh",
      sub: "Hands-off switch",
      prompt:
        "I want cloud auto-refresh so data stays fresh without a browser tab. Help me save a portal login for 24/7 capture.",
      hash: "#account",
      done: function (L) {
        return !!(L && L.cloud);
      },
    },
    {
      id: "utility",
      label: "Utility bills",
      sub: "Invoice truth",
      prompt:
        "Help me save my utility login so bills keep landing for offtaker invoices without opening the portal.",
      hash: "#reports",
      done: function (L) {
        return !!(L && L.utilities);
      },
    },
    {
      id: "offtakers",
      label: "Offtakers",
      sub: "Who you bill",
      prompt:
        "Help me add offtakers (customers who get solar-credit invoices). If I only monitor, say so and skip.",
      hash: "#reports",
      done: function (L) {
        return !!(L && L.offtakers);
      },
      optional: true,
    },
    {
      id: "onlinepay",
      label: "Online pay",
      sub: "Collect without chasing",
      prompt:
        "Enable online pay for offtakers via Stripe Connect so invoice emails can collect payment automatically.",
      hash: "#account",
      done: function (L) {
        return !!(L && L.onlinePay);
      },
      optionalUntilOfftakers: true,
    },
  ];

  function requiredLeft(L) {
    L = L || {};
    var n = 0;
    if (!L.arrays) n++;
    if (!L.cloud) n++;
    if (!L.utilities) n++;
    if (L.offtakers && !L.onlinePay) n++;
    return n;
  }

  function progressPct(L) {
    L = L || {};
    var keys = ["arrays", "cloud", "utilities", "offtakers", "onlinePay"];
    var done = 0;
    keys.forEach(function (k) {
      if (L[k]) done++;
    });
    return Math.round((done / keys.length) * 100);
  }

  function nextPillar(L) {
    for (var i = 0; i < PILLARS.length; i++) {
      var p = PILLARS[i];
      if (p.optionalUntilOfftakers && !(L && L.offtakers)) continue;
      if (!p.done(L)) return p;
    }
    return null;
  }

  function isHandsOffReady(L) {
    return requiredLeft(L) === 0 && !!(L && L.arrays && L.cloud);
  }

  // ── live probes ──────────────────────────────────────────────────────────
  async function probeLive() {
    if (typeof window.__aoHandsOffTourProbe === "function") {
      try {
        var L = await window.__aoHandsOffTourProbe();
        state.live = L;
        return L;
      } catch (e) {}
    }
    // Minimal fallback if tour not loaded
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
      var d = await r.json();
      state.pipeline = d;
      return d;
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
      vendors: {},
      lastSync: null,
    };
    try {
      if (!window.FleetStore || !FleetStore.snapshot) return out;
      var snap = FleetStore.snapshot() || {};
      var arr = snap.arrays || [];
      out.arrays = arr.length;
      arr.forEach(function (a) {
        var v = String((a && a.vendor) || "unknown").toLowerCase();
        out.vendors[v] = (out.vendors[v] || 0) + 1;
        var invs = (a && a.inverters) || [];
        out.inverters += invs.length;
        invs.forEach(function (inv) {
          var st = String((inv && (inv.status || inv.health || inv.peer_status)) || "").toLowerCase();
          if (/dead|fault|offline|comm/.test(st)) out.dead++;
          else if (/under|attn|warn|need/.test(st)) out.attn++;
          else out.ok++;
        });
        var ts = a.last_sync_at || a.synced_at || a.updated_at || null;
        if (ts && (!out.lastSync || String(ts) > String(out.lastSync))) out.lastSync = ts;
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
    var delivered = last && (last.delivered != null ? last.delivered : last.sent);
    var enabled = pipe.total_enabled != null ? pipe.total_enabled : total;
    var mode = pipe.default_delivery_mode || "approval";
    var period = last && (last.period_month || last.period_label) || null;
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

  // ── context for Energy Agent brain ───────────────────────────────────────
  function buildOsContext() {
    var L = state.live || {};
    var fl = state.fleet || fleetRollup();
    var of = offtakerRollup(L);
    var next = nextPillar(L);
    var phase = isHandsOffReady(L) || (tourDone() && L.arrays) ? "running" : "setup";
    state.phase = phase;
    return {
      mobile_os: true,
      mobile_mode: state.mode,
      phase: phase,
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
          optional: !!p.optional || !!p.optionalUntilOfftakers,
        };
      }),
      live: {
        arrays: !!L.arrays,
        array_count: L.arrayCount || fl.arrays || 0,
        inverter_count: fl.inverters || 0,
        cloud_auto_refresh: !!L.cloud,
        cloud_logins: L.cloudCreds || 0,
        utilities: !!L.utilities,
        utility_accounts: L.utilCount || 0,
        bills_on_file: L.utilWithBills || 0,
        offtakers: !!L.offtakers,
        offtaker_count: L.offtakerCount || 0,
        online_pay: !!L.onlinePay,
      },
      systems: {
        inverters: {
          ok: fl.ok,
          attention: fl.attn,
          dead: fl.dead,
          last_sync: fl.lastSync,
          last_sync_rel: relTime(fl.lastSync),
          cadence: "Inverters refresh ~every 3 min when cloud capture is on; utility bills ~12h",
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
        cloud_logins: (L.cloudLogins || []).slice(0, 12).map(function (c) {
          return {
            provider: c.provider,
            last_ok: c.lastOk,
            last_status: c.lastStatus,
          };
        }),
      },
      ui_contract: {
        role: "You ARE the operating layer on mobile. Owner talks to you to finish setup and run the fleet — not a pile of tabs.",
        setup_goal: "Get them to hands-off automatic as fast as possible: arrays → auto-refresh → utility bills → offtakers (if billing) → online pay.",
        running_goal: "Give status, success rates, last sync, next send window. Offer Detail mode only when they need deep edits.",
        detail_mode: "When they need spreadsheet-level edits, say they can tap Detail at the bottom — don't dump desktop navigation jargon first.",
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

  // ── DOM shell ────────────────────────────────────────────────────────────
  function ensureShell() {
    if (document.getElementById("mhOs") && document.getElementById("mhDock")) {
      // Migrate legacy dock nested inside #mhOs (full-height pill bug)
      var nested = document.querySelector("#mhOs > .mh-dock, #mhOs > #mhDock");
      var dockEl = document.getElementById("mhDock");
      if (nested && dockEl && nested === dockEl && dockEl.parentElement !== document.body) {
        document.body.appendChild(dockEl);
      }
      return;
    }
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
        '<div class="mh-ops" id="mhOps" role="region" aria-label="Systems status"></div>' +
        '<div class="mh-actions" id="mhActions" role="toolbar" aria-label="Quick actions"></div>';
      document.body.appendChild(root);
    }
    // Dock is a BODY sibling — never a child of #mhOs (avoids stretched pill)
    if (!document.getElementById("mhDock")) {
      var dock = document.createElement("nav");
      dock.id = "mhDock";
      dock.className = "mh-dock";
      dock.setAttribute("aria-label", "Mobile mode");
      dock.innerHTML =
        '  <button type="button" class="mh-dock-btn on" data-mh="ai" id="mhDockAi">' +
        '    <span class="mh-dock-ic" aria-hidden="true">☀</span><span>Agent</span></button>' +
        '  <button type="button" class="mh-dock-btn" data-mh="detail" id="mhDockDetail">' +
        '    <span class="mh-dock-ic" aria-hidden="true">☰</span><span>Detail</span></button>';
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
      var top = document.getElementById("mhTop");
      var ops = document.getElementById("mhOps");
      var act = document.getElementById("mhActions");
      var h = 0;
      [top, ops, act].forEach(function (el) {
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

  function paintOps() {
    var ops = document.getElementById("mhOps");
    var actions = document.getElementById("mhActions");
    var meter = document.getElementById("mhMeter");
    var L = state.live || {};
    var phase = state.phase;
    var title = document.getElementById("mhTitle");
    var sub = document.getElementById("mhSub");
    if (!ops) return;

    if (phase === "setup") {
      if (title) title.textContent = "Get hands-off";
      if (sub) sub.textContent = "Talk to Energy Agent — finish setup once";
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
          lab.textContent = left ? left + " required left" : "Almost there";
        }
      }
      ops.innerHTML = PILLARS.map(function (p) {
        if (p.optionalUntilOfftakers && !L.offtakers && !p.done(L)) {
          return "";
        }
        var ok = p.done(L);
        var next = nextPillar(L);
        var isNext = next && next.id === p.id;
        return (
          '<button type="button" class="mh-pill' +
          (ok ? " is-done" : "") +
          (isNext ? " is-next" : "") +
          '" data-pillar="' +
          esc(p.id) +
          '">' +
          '<span class="mh-pill-mark" aria-hidden="true">' +
          (ok ? "✓" : isNext ? "→" : "○") +
          "</span>" +
          '<span class="mh-pill-tx"><b>' +
          esc(p.label) +
          "</b><small>" +
          esc(p.sub) +
          "</small></span>" +
          "</button>"
        );
      }).join("");

      var nxt = nextPillar(L);
      // Setup: full-width primary + equal secondary (2-col when both present)
      if (nxt) {
        actions.innerHTML =
          '<button type="button" class="mh-cta mh-cta-wide" id="mhPrimaryCta">' +
          "Continue · " +
          esc(nxt.label) +
          " →</button>" +
          '<button type="button" class="mh-cta ghost" id="mhAskStatus">What\'s left?</button>';
        actions.classList.add("mh-actions-setup");
      } else {
        actions.innerHTML =
          '<button type="button" class="mh-cta mh-cta-wide" id="mhPrimaryCta">You\'re hands-off · show overview →</button>';
        actions.classList.remove("mh-actions-setup", "mh-actions-grid");
      }
    } else {
      if (title) title.textContent = "Hands-off running";
      if (sub) sub.textContent = "Ask Energy Agent anything about your fleet";
      if (meter) meter.hidden = true;

      var fl = fleetRollup();
      var of = offtakerRollup(L);
      var invHealth =
        fl.inverters > 0
          ? Math.round((fl.ok / Math.max(1, fl.ok + fl.attn + fl.dead)) * 100)
          : null;
      var cloudLine =
        (L.cloudCreds || 0) +
        " login" +
        ((L.cloudCreds || 0) === 1 ? "" : "s") +
        (L.cloud ? " · cloud on" : " · not set");
      var offtLine =
        of.total === 0
          ? "No offtakers yet"
          : of.delivered != null && of.enabled
            ? of.delivered +
              " of " +
              of.enabled +
              " sent" +
              (of.period ? " · " + of.period : "") +
              (of.successPct != null ? " · " + of.successPct + "%" : "")
            : of.total + " offtakers · " + (of.mode === "auto" ? "auto-send" : "approve to send");

      ops.innerHTML =
        '<div class="mh-card">' +
        '  <div class="mh-card-k">Inverters</div>' +
        '  <div class="mh-card-v">' +
        esc(String(fl.inverters || L.arrayCount || 0)) +
        ' <small>units · ' +
        esc(String(fl.arrays || L.arrayCount || 0)) +
        " sites</small></div>" +
        '  <div class="mh-card-meta">' +
        (invHealth != null
          ? invHealth + "% healthy · " + fl.attn + " need attention"
          : "Connect feeds in setup") +
        " · sync " +
        esc(relTime(fl.lastSync)) +
        "</div>" +
        '  <div class="mh-card-cad">Cadence · live power ≤5 min when cloud capture is on</div>' +
        "</div>" +
        '<div class="mh-card">' +
        '  <div class="mh-card-k">Auto-refresh</div>' +
        '  <div class="mh-card-v">' +
        esc(cloudLine) +
        "</div>" +
        '  <div class="mh-card-meta">Utilities: ' +
        esc(String(L.utilWithBills || 0)) +
        " bills · " +
        esc(String(L.utilCount || 0)) +
        " accounts</div>" +
        '  <div class="mh-card-cad">Cadence · utilities ~every 12h · inverters ~3 min</div>' +
        "</div>" +
        '<div class="mh-card">' +
        '  <div class="mh-card-k">Offtakers</div>' +
        '  <div class="mh-card-v">' +
        esc(offtLine) +
        "</div>" +
        '  <div class="mh-card-meta">' +
        (of.onlinePay ? "Online pay ON" : of.total ? "Online pay off — collections manual" : "Monitor-only OK") +
        "</div>" +
        '  <div class="mh-card-cad">Send window · monthly on your pipeline schedule</div>' +
        "</div>";

      // 2×2 equal grid — fills the chrome with no orphan half-row dead space.
      // (Detail lives in the bottom dock; don't duplicate it here.)
      actions.innerHTML =
        '<button type="button" class="mh-cta" id="mhPrimaryCta">Status brief</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskAttention">Needs attention</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskInvoices">Invoices</button>' +
        '<button type="button" class="mh-cta ghost" id="mhAskFeeds">Feeds &amp; sync</button>';
      actions.classList.add("mh-actions-grid");
    }

    if (phase === "setup") {
      var actEl = document.getElementById("mhActions");
      if (actEl) actEl.classList.remove("mh-actions-grid");
    }

    // wire ops + actions
    ops.querySelectorAll("[data-pillar]").forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute("data-pillar");
        var p = PILLARS.filter(function (x) {
          return x.id === id;
        })[0];
        if (p) askAgent(p.prompt, { focus: p.id });
      };
    });
    var cta = document.getElementById("mhPrimaryCta");
    if (cta) {
      cta.onclick = function () {
        if (phase === "setup") {
          var n = nextPillar(L);
          if (n) askAgent(n.prompt, { focus: n.id });
          else {
            // Force refresh phase
            state.phase = "running";
            paintOps();
            askAgent(
              "Setup looks complete. Give me a short hands-off status: arrays, auto-refresh, utility bills, offtakers, and anything still yellow."
            );
          }
        } else {
          askAgent(
            "Give me a concise fleet brief: inverter health, last sync, auto-refresh logins, utility bills, and offtaker send success for the last period. Use tools — don't invent numbers."
          );
        }
      };
    }
    var askSt = document.getElementById("mhAskStatus");
    if (askSt) {
      askSt.onclick = function () {
        askAgent(
          "What's left on my hands-off checklist and what's the fastest path to green?"
        );
      };
    }
    var askInv = document.getElementById("mhAskInvoices");
    if (askInv) {
      askInv.onclick = function () {
        askAgent(
          "Summarize my offtaker invoice pipeline: how many offtakers, last period sent/success rate, delivery mode, and online pay status. Keep it short."
        );
      };
    }
    var askAtt = document.getElementById("mhAskAttention");
    if (askAtt) {
      askAtt.onclick = function () {
        askAgent(
          "What needs attention right now? Name underperforming or stale arrays/inverters, why, and the next step. Use investigate_attention / fleet tools — no invented numbers."
        );
      };
    }
    var askFeeds = document.getElementById("mhAskFeeds");
    if (askFeeds) {
      askFeeds.onclick = function () {
        askAgent(
          "How are my data feeds? Cloud auto-refresh logins (last harvest ok/fail), utility bill freshness, and anything not syncing. Short checklist answer."
        );
      };
    }
    // After paint, size the full-screen agent under the ops chrome
    requestAnimationFrame(function () {
      measureChrome();
      setTimeout(measureChrome, 50);
    });
  }

  function askAgent(text, opts) {
    opts = opts || {};
    enterAi();
    // Ensure panel open, then send
    if (typeof window.__eaOpen === "function") window.__eaOpen();
    if (typeof window.__eaSendText === "function") {
      window.__eaSendText(text, { source: "mobile_os" });
    } else {
      // Fallback: fill input + click send
      var input = document.getElementById("eaInput");
      var send = document.getElementById("eaSend");
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (send) send.click();
    }
  }

  // ── mode enter/exit ──────────────────────────────────────────────────────
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
    // Soft-close agent sheet so full UI is usable (can reopen via dock Agent)
    if (typeof window.__eaClose === "function") {
      try {
        window.__eaClose();
      } catch (e) {}
    }
  }

  /** Collect floating FABs into one tray so they don't scatter over UI. */
  function ensureFabTray() {
    var tray = document.getElementById("mhFabTray");
    if (tray) return tray;
    tray = document.createElement("div");
    tray.id = "mhFabTray";
    tray.className = "mh-fab-tray";
    tray.setAttribute("aria-label", "Quick tools");
    tray.hidden = true;
    document.body.appendChild(tray);
    return tray;
  }

  function fabCandidates() {
    var list = [];
    var al = document.getElementById("aoAlertFab") || document.querySelector(".ao-al-fab");
    if (al) list.push(al);
    var ho = document.getElementById("hoPill");
    if (ho) list.push(ho);
    return list;
  }

  function packFloatingIcons() {
    var tray = ensureFabTray();
    var pack = state.active && state.mode === "detail";
    if (!pack) {
      // Restore FABs to body; free absolute positioning again
      fabCandidates().forEach(function (el) {
        if (el.parentElement === tray) document.body.appendChild(el);
        // Clear tray-only inline overrides
        el.style.display = "";
        el.style.position = "";
        el.style.left = "";
        el.style.right = "";
        el.style.bottom = "";
        el.style.top = "";
      });
      tray.hidden = true;
      tray.setAttribute("aria-hidden", "true");
      return;
    }
    tray.hidden = false;
    tray.setAttribute("aria-hidden", "false");
    // Order bottom→top (column-reverse): Alerts nearest thumb, then Setup
    fabCandidates().forEach(function (el) {
      if (el.parentElement !== tray) tray.appendChild(el);
      // Setup pill only when tour wants it visible
      if (el.id === "hoPill" && !el.classList.contains("ho-pill-show")) {
        el.style.display = "none";
      } else {
        el.style.display = "";
      }
    });
  }

  function applyMode() {
    var mobile = isMobile() && signedIn();
    state.active = mobile;
    document.body.classList.toggle("mh-os", mobile && state.mode === "ai");
    document.body.classList.toggle("mh-detail", mobile && state.mode === "detail");
    document.body.classList.toggle("mh-active", mobile);

    var root = document.getElementById("mhOs");
    if (root) {
      root.hidden = !mobile;
      root.setAttribute("aria-hidden", mobile ? "false" : "true");
      root.classList.toggle("is-ai", state.mode === "ai");
      root.classList.toggle("is-detail", state.mode === "detail");
    }
    var dock = document.getElementById("mhDock");
    if (dock) {
      dock.hidden = !mobile;
      dock.style.display = mobile ? "flex" : "none";
      dock.setAttribute("aria-hidden", mobile ? "false" : "true");
      // Belt: never leave dock nested under #mhOs
      if (dock.parentElement !== document.body) document.body.appendChild(dock);
    }

    var aiBtn = document.getElementById("mhDockAi");
    var dBtn = document.getElementById("mhDockDetail");
    if (aiBtn) aiBtn.classList.toggle("on", state.mode === "ai");
    if (dBtn) dBtn.classList.toggle("on", state.mode === "detail");

    // Hide legacy hands-off modal/dock competition on mobile AI mode
    if (mobile && state.mode === "ai") {
      try {
        var ho = document.getElementById("hoTour");
        if (ho) {
          ho.hidden = true;
          ho.classList.remove("ho-open");
        }
        document.body.classList.remove("ho-shell-open");
      } catch (e) {}
    }

    // Neat FAB tray on Detail; restore floaters on Agent / desktop
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
      isHandsOffReady(L) || (tourDone() && L.arrays && L.cloud) ? "running" : "setup";
    // If they finished tour earlier but pillars incomplete, stay in setup
    if (tourDone() && requiredLeft(L) > 0) state.phase = "setup";
    paintOps();
  }

  function scheduleRefresh() {
    if (state.probeTimer) clearTimeout(state.probeTimer);
    state.probeTimer = setTimeout(function () {
      refresh().catch(function () {});
    }, 400);
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot() {
    if (!signedIn()) {
      // Demo/anon keeps normal mobile tabs
      document.body.classList.remove("mh-os", "mh-detail", "mh-active");
      return;
    }
    ensureShell();
    state.mode = wantsDetail() ? "detail" : "ai";
    applyMode();
    refresh().then(function () {
      if (state.active && state.mode === "ai") {
        // Open agent as home after short settle (session + UI ready)
        setTimeout(function () {
          if (state.mode === "ai" && isMobile()) {
            try {
              if (typeof window.__eaOpen === "function") window.__eaOpen();
            } catch (e) {}
          }
        }, 700);
      }
    });

    // Resize / orientation
    try {
      var mql = matchMedia(MQ);
      var onChange = function () {
        applyMode();
        scheduleRefresh();
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    } catch (e) {}

    // Fleet updates
    try {
      if (window.FleetStore && FleetStore.subscribe) {
        FleetStore.subscribe(function () {
          scheduleRefresh();
        });
      }
    } catch (e) {}

    // Alerts / Setup FABs may mount after us — re-pack when they appear
    setTimeout(function () {
      try {
        packFloatingIcons();
      } catch (e) {}
    }, 1200);
    setTimeout(function () {
      try {
        packFloatingIcons();
      } catch (e) {}
    }, 3500);

    window.addEventListener("ea:data-changed", scheduleRefresh);
    window.addEventListener("hashchange", function () {
      // If user navigates deep links while in AI mode, stay AI unless detail
    });

    // Periodic soft refresh of status cards
    setInterval(function () {
      if (state.active) scheduleRefresh();
    }, 60000);
  }

  // Public: hands-off tour can ask mobile OS to own setup
  window.__aoMobileOsBoot = boot;
  window.__aoMobileOsEnterAi = enterAi;
  window.__aoMobileOsEnterDetail = enterDetail;
  window.__aoMobileOsRefresh = refresh;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(boot, 200);
    });
  } else {
    setTimeout(boot, 200);
  }
})();
