/* ============================================================================
 * Hands-Off Walkthrough — post-onboarding product tour
 * Shows after first onboarding lands on the real site (?fresh=1 / ?tour=hands-off).
 * Goal: make "set and forget" concrete — cloud auto-refresh, utility bills,
 * offtakers — with a beautiful sky-glass UI and live completion chips.
 * ========================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "ao_hands_off_tour"; // "done" when fully finished
  var MODAL_SEEN_KEY = "ao_hands_off_modal_seen"; // first-time modal shown/closed

  var STEPS = [
    {
      id: "welcome",
      rail: "Welcome",
      railSub: "Why hands-off",
      kicker: "Your first hour",
      title: "Build a hands-off Array Operator",
      lede:
        "You made it past setup. Next is the only checklist that matters: connect the feeds once — then we’ll show you one offtaker invoice with its bill lined up and ask how you want reports to leave. After that, the machine runs.",
      kind: "welcome",
    },
    {
      id: "arrays",
      rail: "Arrays live",
      railSub: "Production feed",
      kicker: "Step 1 of 6 · Hardware",
      title: "Get every array talking",
      lede:
        "Hands-off starts with a live production feed. SolarEdge/Locus poll server-side; Fronius, SMA, and Chint need a portal login so we can keep reading them.",
      kind: "step",
      bullets: [
        "Open <b>Inverters</b> and confirm every site you care about is listed.",
        "Missing a vendor? Use <b>Add array</b> or Account → Auto-refresh to attach the portal.",
        "Healthy cards mean we can detect downtime and write offtaker invoices from real generation context.",
      ],
      cta: { label: "Open Inverters →", hash: "#arrays" },
      statusKey: "arrays",
    },
    {
      id: "autorefresh",
      rail: "Auto-refresh",
      railSub: "The hands-off switch",
      kicker: "Step 2 of 6 · Capture",
      title: "Save a portal login here",
      lede:
        "This is the hands-off switch. Drop a monitoring login below — we store it encrypted and refresh your data around the clock. No hunting through Account.",
      kind: "step",
      loginForm: "inverter",
      bullets: [
        "Add every inverter portal you use (Chint, Fronius, SMA…). SolarEdge can use an API key later in Account if you prefer.",
        "We switch you to <b>Store it with us</b> automatically when you save here.",
        "You can add more logins anytime from Account → Auto-refresh — or right here.",
      ],
      callout:
        "<b>Hands-off rule:</b> if a login isn’t saved, that feed only updates when someone opens the portal manually.",
      cta: { label: "Open full Auto-refresh →", hash: "#account", openAr: true },
      statusKey: "autorefresh",
    },
    {
      id: "utility",
      rail: "Utility bills",
      railSub: "Invoice source of truth",
      kicker: "Step 3 of 6 · Settlement",
      title: "Save your utility login",
      lede:
        "Offtaker invoices use utility bills as source of truth. Save GMP or your co-op login here so bills keep landing without a portal tab.",
      kind: "step",
      loginForm: "utility",
      bullets: [
        "Green Mountain Power, Vermont Electric Co-op, Washington Electric, and other live SmartHub utilities work here.",
        "After the first successful harvest you’ll see bill sources on Invoices.",
        "Need a utility we don’t list? Tell us from Account — we’ll wire it.",
      ],
      cta: { label: "Open Invoices →", hash: "#reports" },
      statusKey: "utility",
    },
    {
      id: "offtakers",
      rail: "Offtakers",
      railSub: "Who you bill",
      kicker: "Step 4 of 6 · Customers",
      title: "Add offtakers (if you invoice)",
      lede:
        "Each offtaker is a customer who gets a share of solar credits. Bind their share and bill source once — next we’ll line up a real invoice preview with its bill and ask how you want drafts to leave.",
      kind: "step",
      bullets: [
        "Invoices → <b>Add an offtaker</b>: name, email, share %, master/sub utility.",
        "Set master solar credit rate only if you want one fleet override; blank uses each bill’s own rate.",
        "After this: preview one offtaker with the bill, then choose <b>approve-to-send</b> or <b>auto-send</b>.",
      ],
      cta: { label: "Set up offtakers →", hash: "#reports" },
      secondary: { label: "I only monitor — skip", skip: true },
      statusKey: "offtakers",
    },
    {
      id: "autosend",
      rail: "Send mode",
      railSub: "Preview + approve",
      kicker: "Step 5 of 6 · The payoff",
      title: "Peek one offtaker invoice — then approve how reports leave",
      lede:
        "This is the dream: draft + utility bill + amount due, all lined up. Open the full preview on Invoices, then choose whether each report waits for your OK — or auto-sends when the bill settles.",
      kind: "dream",
      bullets: [
        "Open <b>one offtaker</b> on Invoices to see the draft email, math, and source bill together.",
        "Pick a fleet default: <b>Approve to send</b> (you OK each cycle) or <b>Auto-send</b> (hands-off).",
        "You can still override any single offtaker later — this is the starting posture, not a lock.",
      ],
      callout:
        "<b>Nothing emails a customer until a draft exists and send mode allows it.</b> Demo/fake figures never leave your account.",
      cta: { label: "Open offtaker preview →", hash: "#reports", openPreview: true },
      secondary: { label: "I’ll decide later — continue", skip: true },
      statusKey: "autosend",
    },
    {
      id: "onlinepay",
      rail: "Online pay",
      railSub: "Collect without chasing",
      kicker: "Step 6 of 6 · Payouts",
      title: "Enable online pay for offtakers",
      lede:
        "Hands-off invoicing isn’t finished until offtakers can pay from the email. One ~2‑minute Stripe bank setup — then every invoice gets a secure <b>Pay</b> button and money lands in your bank.",
      kind: "step",
      bullets: [
        "We use Stripe Connect Express — you type bank (or debit) details once on Stripe’s secure page. We never see your bank login.",
        "After you’re live, every offtaker invoice email can include a pay link automatically.",
        "Platform fee is a small % per payment (shown on Account). The rest is yours.",
      ],
      callout:
        "<b>Hands-off rule:</b> offtakers without online pay still need you to collect — drafts alone aren’t set-and-forget.",
      cta: { label: "Enable online pay — ~2 min →", action: "start-connect" },
      secondaryCta: { label: "Open Account pay setup →", hash: "#account", openPay: true },
      secondary: { label: "I only monitor / collect offline — skip", skip: true },
      statusKey: "onlinepay",
    },
    {
      id: "done",
      rail: "Hands-off",
      railSub: "You’re set",
      kicker: "You’re ready",
      title: "Set it once. Let it run.",
      lede:
        "When arrays, auto-refresh, utility bills, send mode, and (if you invoice) online pay are green, Array Operator can keep production fresh and offtaker invoices collect without daily login theatre.",
      kind: "done",
    },
  ];

  var DELIVERY_CHOSEN_KEY = "ao_ho_delivery_chosen"; // "auto" | "approval" once operator decides in tour

  var state = {
    open: false,
    mode: "modal", // "modal" | "dock"
    idx: 0,
    live: {},
    _probeTimer: null,
    _fleetSub: false,
    _bootTried: false,
  };

  function session() {
    try {
      return localStorage.getItem("so_session") || "";
    } catch (e) {
      return "";
    }
  }

  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = session();
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }

  function isTourComplete() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "done";
    } catch (e) {
      return false;
    }
  }

  function modalAlreadySeen() {
    try {
      return localStorage.getItem(MODAL_SEEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function markModalSeen() {
    try {
      localStorage.setItem(MODAL_SEEN_KEY, "1");
    } catch (e) {}
  }

  function queryWantsTour() {
    var q = location.search || "";
    return (
      /[?&]tour=hands-off(&|$)/.test(q) ||
      /[?&]fresh=1(&|$)/.test(q) ||
      /[?&]setup=autorefresh(&|$)/.test(q) ||
      // Returning from Stripe Connect bank setup
      /[?&]connect=(return|refresh)(&|$)/.test(q)
    );
  }

  function queryConnectReturn() {
    return /[?&]connect=(return|refresh)(&|$)/.test(location.search || "");
  }

  function shouldAutoOpen() {
    // Explicit tour= link always opens (even if they finished before)
    if (/[?&]tour=hands-off(&|$)/.test(location.search || "")) return true;
    // Always re-open after Stripe Connect so they see Online pay turn green
    if (queryConnectReturn() && session()) return true;
    if (!session()) return false;
    if (isTourComplete()) return false;
    return queryWantsTour();
  }

  function scrubTourParams() {
    try {
      var u = new URL(location.href);
      var changed = false;
      if (u.searchParams.has("fresh")) {
        u.searchParams.delete("fresh");
        changed = true;
      }
      if (u.searchParams.has("tour")) {
        u.searchParams.delete("tour");
        changed = true;
      }
      // keep setup=autorefresh for AR open intent
      if (changed) {
        history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
      }
    } catch (e) {}
  }

  function markDone() {
    try {
      localStorage.setItem(STORAGE_KEY, "done");
      localStorage.setItem(MODAL_SEEN_KEY, "1");
    } catch (e) {}
  }

  /**
   * Required pillars for “hands-off”.
   * Offtakers alone are optional — but once you have offtakers:
   *   · send-mode must be chosen (approve vs auto-send)
   *   · online pay is required (otherwise invoices still need manual collection)
   */
  function requiredRemaining(live) {
    live = live || state.live || {};
    var n = 0;
    if (!live.arrays) n++;
    if (!live.cloud) n++;
    if (!(live.utilWithBills > 0 || live.utilCount > 0)) n++;
    if (live.offtakers && !live.deliveryChosen) n++;
    if (live.offtakers && !live.onlinePay) n++;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── live status probes ───────────────────────────────────────────────────
  async function probeLive() {
    var live = {
      arrays: null,
      arrayCount: 0,
      cloud: null,
      cloudCreds: 0,
      captureMode: null,
      utilities: null,
      utilCount: 0,
      utilWithBills: 0,
      offtakers: null,
      offtakerCount: 0,
      deliveryMode: "approval",
      deliveryChosen: false,
      modeSplit: { auto: 0, approval: 0 },
      samplePreview: null,
      onlinePay: null,
      onlinePayConnected: false,
      onlinePayFee: null,
      cloudLogins: [],
    };
    try {
      var chosen = localStorage.getItem(DELIVERY_CHOSEN_KEY);
      if (chosen === "auto" || chosen === "approval") {
        live.deliveryChosen = true;
        live.deliveryMode = chosen;
      }
    } catch (e) {}
    // arrays via FleetStore if ready
    try {
      if (window.FleetStore && FleetStore.isLoaded && FleetStore.isLoaded()) {
        var snap = FleetStore.snapshot() || {};
        var arr = snap.arrays || [];
        live.arrayCount = arr.length;
        live.arrays = arr.length > 0;
      }
    } catch (e) {}

    if (!session()) {
      state.live = live;
      return live;
    }

    try {
      var aRes = await fetch("/v1/account", { headers: authHeaders() });
      if (aRes.ok) {
        var acct = await aRes.json();
        live.captureMode = acct.capture_mode || null;
        try {
          if (acct.capture_mode === "cloud" || acct.capture_mode === "device") {
            localStorage.setItem("ao_ar_mode", acct.capture_mode);
          }
        } catch (e) {}
      }
    } catch (e) {}

    try {
      var mode = null;
      try {
        mode = localStorage.getItem("ao_ar_mode");
      } catch (e) {}
      if (!mode) mode = live.captureMode;
      if (mode === "cloud" || typeof window.__aoCloudStatus === "function") {
        var cs = null;
        if (typeof window.__aoCloudStatus === "function") {
          cs = await window.__aoCloudStatus();
        } else {
          var cr = await fetch("/v1/cloud-capture/status", { headers: authHeaders() });
          if (cr.ok) cs = await cr.json();
        }
        if (cs && cs.credentials) {
          var creds = (cs.credentials || []).filter(function (c) {
            return c && c.enabled !== false;
          });
          live.cloudCreds = creds.length;
          live.cloud = live.cloudCreds > 0;
          live.cloudLogins = creds.map(function (c) {
            return {
              provider: String(c.provider || "").toLowerCase(),
              username: c.username || "",
              lastOk: c.last_harvest_ok,
              lastStatus: c.last_harvest_status || null,
            };
          });
        }
      }
      // device vault as alternate green
      if (!live.cloud && typeof window.__aoVaultStatus === "function") {
        var vs = await window.__aoVaultStatus();
        if (vs && typeof vs === "object") {
          var n = 0;
          Object.keys(vs).forEach(function (k) {
            if (vs[k] && vs[k].hasCreds) n++;
          });
          if (n > 0) {
            live.cloud = true; // “auto-refresh configured” broadly
            live.cloudCreds = n;
            live.captureMode = live.captureMode || "device";
          }
        }
      }
    } catch (e) {}

    try {
      var ur = await fetch("/v1/array-operator/billing/utility-accounts", {
        headers: authHeaders(),
      });
      if (ur.ok) {
        var ud = await ur.json();
        var list = ud.utility_accounts || [];
        live.utilCount = list.length;
        live.utilWithBills = list.filter(function (x) {
          return x.has_bill;
        }).length;
        live.utilities = live.utilWithBills > 0 || live.utilCount > 0;
      }
    } catch (e) {}

    try {
      var sr = await fetch("/v1/array-operator/billing/subscriptions", {
        headers: authHeaders(),
      });
      if (sr.ok) {
        var sd = await sr.json();
        var subs = sd.subscriptions || [];
        live.offtakerCount = subs.length;
        live.offtakers = subs.length > 0;
        // Sample offtaker for the dream step — first enabled with a name
        if (subs.length) {
          var sample =
            subs.find(function (s) {
              return s && s.enabled !== false && (s.customer_name || s.name);
            }) || subs[0];
          if (sample) {
            live.samplePreview = {
              id: sample.id,
              name: sample.customer_name || sample.name || "Offtaker",
              email: sample.client_email || sample.email || "",
              // allocation_pct is 0–100 on the API (or already a fraction in rare paths)
              share:
                sample.allocation_pct != null
                  ? sample.allocation_pct
                  : sample.array_share_pct != null
                    ? sample.array_share_pct
                    : null,
              amount: null,
              kwh: null,
              rate: null,
              period: null,
              billLabel: null,
              hasMath: false,
            };
            // Per-offtaker mode is a useful hint before pipeline load
            if (!live.deliveryChosen && sample.delivery_mode) {
              live.deliveryMode =
                sample.delivery_mode === "auto" ? "auto" : "approval";
            }
          }
        }
      }
    } catch (e) {}

    // Send-pipeline posture + enrich sample with real bill math when possible
    try {
      var pipeR = await fetch("/v1/array-operator/billing/send-pipeline", {
        headers: authHeaders(),
      });
      if (pipeR.ok) {
        var pipe = await pipeR.json();
        if (pipe && pipe.default_delivery_mode) {
          // Prefer explicit tour choice; otherwise mirror fleet dominant mode
          if (!live.deliveryChosen) {
            live.deliveryMode =
              pipe.default_delivery_mode === "auto" ? "auto" : "approval";
          }
        }
        if (pipe && pipe.mode_split) {
          live.modeSplit = {
            auto: pipe.mode_split.auto || 0,
            approval: pipe.mode_split.approval || 0,
          };
        }
      }
    } catch (e) {}

    if (live.samplePreview && live.samplePreview.id) {
      try {
        var mathR = await fetch(
          "/v1/array-operator/billing/subscriptions/" +
            encodeURIComponent(live.samplePreview.id) +
            "/preview-math",
          { headers: authHeaders() }
        );
        if (mathR.ok) {
          var math = await mathR.json();
          if (math && math.has_data) {
            live.samplePreview.hasMath = true;
            live.samplePreview.amount = math.amount_usd;
            live.samplePreview.kwh = math.customer_kwh;
            live.samplePreview.rate = math.rate;
            live.samplePreview.period =
              (math.period_start || "") +
              (math.period_start && math.period_end ? " → " : "") +
              (math.period_end || "");
            live.samplePreview.billLabel =
              math.kwh_source === "gmp_api"
                ? "GMP metered"
                : math.kwh_source === "utility_bill"
                  ? "Utility bill"
                  : math.kwh_source === "bill_prorate"
                    ? "Bill (prorated)"
                    : math.kwh_source === "daily_csv"
                      ? "Metered series"
                      : "Best available";
          } else if (math) {
            live.samplePreview.period =
              (math.period_start || math.period_label || "") || null;
            live.samplePreview.billLabel = "Waiting on settled bill";
          }
        }
      } catch (e) {}
    }

    try {
      var pr = await fetch("/v1/array-operator/billing/payments/connect", {
        headers: authHeaders(),
      });
      if (pr.ok) {
        var pd = await pr.json();
        live.onlinePayConnected = !!(pd.connected || pd.account_id);
        live.onlinePay = !!(pd.ready || pd.charges_enabled);
        if (pd.fee_percent != null) {
          live.onlinePayFee = (Math.round(Number(pd.fee_percent) * 100) / 100) + "%";
        } else if (pd.fee_bps != null) {
          live.onlinePayFee = Number(pd.fee_bps) / 100 + "%";
        }
      }
    } catch (e) {}

    // fallback array count from overview if FleetStore empty
    if (live.arrays == null) {
      try {
        var or = await fetch("/v1/array-owners/overview", { headers: authHeaders() });
        if (or.ok) {
          var od = await or.json();
          var aa = od.arrays || [];
          live.arrayCount = aa.length;
          live.arrays = aa.length > 0;
        }
      } catch (e) {}
    }

    state.live = live;
    return live;
  }

  function stepComplete(step, live) {
    if (!step.statusKey) return false;
    if (step.statusKey === "arrays") return !!live.arrays;
    if (step.statusKey === "autorefresh") return !!live.cloud;
    if (step.statusKey === "utility") return !!(live.utilities && (live.utilWithBills > 0 || live.utilCount > 0));
    if (step.statusKey === "offtakers") return !!live.offtakers;
    // Autosend is complete once they've made a posture choice (or skipped).
    // Without offtakers it's optional — mark done so the rail doesn't stall.
    if (step.statusKey === "autosend") {
      if (!live.offtakers) return true;
      return !!live.deliveryChosen;
    }
    if (step.statusKey === "onlinepay") return !!live.onlinePay;
    return false;
  }

  function progressPct(live) {
    var keys = ["arrays", "autorefresh", "utility", "offtakers", "autosend", "onlinepay"];
    var done = 0;
    keys.forEach(function (k) {
      if (k === "arrays" && live.arrays) done++;
      if (k === "autorefresh" && live.cloud) done++;
      if (k === "utility" && live.utilities) done++;
      if (k === "offtakers" && live.offtakers) done++;
      if (k === "autosend" && (live.deliveryChosen || !live.offtakers)) done++;
      if (k === "onlinepay" && live.onlinePay) done++;
    });
    return Math.round((done / keys.length) * 100);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  function ensureRoot() {
    var el = document.getElementById("hoTour");
    if (el) return el;
    el = document.createElement("div");
    el.id = "hoTour";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Hands-off setup walkthrough");
    document.body.appendChild(el);
    return el;
  }

  function ensurePill() {
    var pill = document.getElementById("hoPill");
    if (pill) return pill;
    pill = document.createElement("button");
    pill.type = "button";
    pill.id = "hoPill";
    pill.className = "ho-pill-fab";
    pill.setAttribute("aria-label", "Hands-off setup walkthrough");
    pill.title = "Hands-off setup walkthrough";
    document.body.appendChild(pill);
    pill.addEventListener("click", function (e) {
      try {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
      } catch (err) {}
      // Synchronous paint — never wait on network for the shell to appear
      try {
        openTourInstant({
          force: true,
          mode: modalAlreadySeen() || isTourComplete() ? "dock" : "modal",
        });
      } catch (err) {
        try {
          console.error("[hands-off] open failed", err);
        } catch (e2) {}
      }
    });
    return pill;
  }

  /**
   * Persistent bottom-left FAB (mirrors Alerts bottom-right). Always available
   * for signed-in owners so they can replay hands-off setup anytime — not buried
   * in Account → Auto-refresh (Ford 2026-07-14). Hidden only while the tour is
   * open; closing the tour brings the pill back.
   */
  function updatePill() {
    var pill = ensurePill();
    if (!session()) {
      pill.classList.remove("ho-pill-show");
      return;
    }
    // Hide pill while modal/dock is open — returns on minimize/close
    if (state.open) {
      pill.classList.remove("ho-pill-show");
      return;
    }
    var live = state.live || {};
    var left = requiredRemaining(live);
    var incomplete = left > 0 && !isTourComplete();
    pill.classList.add("ho-pill-show");
    pill.classList.toggle("is-done", !incomplete);
    pill.classList.toggle("is-progress", !!incomplete);
    // Single-line Alerts-style pill (no cramped two-line label)
    if (incomplete) {
      pill.innerHTML =
        '<span class="ho-pill-ic" aria-hidden="true">' +
        left +
        "</span>" +
        '<span class="ho-pill-lab">Setup</span>';
      pill.setAttribute(
        "aria-label",
        "Hands-off setup — " + left + " step" + (left === 1 ? "" : "s") + " left"
      );
      pill.title =
        left + " step" + (left === 1 ? "" : "s") + " left · open hands-off setup";
    } else {
      pill.innerHTML =
        '<span class="ho-pill-ic ho-pill-play" aria-hidden="true">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' +
        "</span>" +
        '<span class="ho-pill-lab">Setup</span>';
      pill.setAttribute("aria-label", "Replay hands-off setup walkthrough");
      pill.title = "Replay hands-off setup walkthrough";
    }
  }

  function setShellOpen(on) {
    try {
      document.body.classList.toggle("ho-shell-open", !!on);
    } catch (e) {}
  }

  /** Compact horizontal stepper (was a tall vertical checklist that crushed the form). */
  function buildStepsHtml(live) {
    var cur = STEPS[state.idx] || STEPS[0];
    var pills = STEPS.map(function (s, i) {
      var done = stepComplete(s, live) || (s.id === "done" && requiredRemaining(live) === 0);
      var active = i === state.idx;
      var num = s.id === "welcome" ? "★" : s.id === "done" ? "✓" : String(i);
      if (done && s.id !== "welcome" && !active) num = "✓";
      return (
        '<button type="button" class="ho-sp' +
        (active ? " is-active" : "") +
        (done ? " is-done" : "") +
        '" data-idx="' +
        i +
        '" title="' +
        esc(s.rail + " — " + s.railSub) +
        '" aria-label="' +
        esc(s.rail) +
        '" aria-current="' +
        (active ? "step" : "false") +
        '">' +
        num +
        "</button>"
      );
    }).join('<span class="ho-sp-line" aria-hidden="true"></span>');
    return (
      '<div class="ho-stepper" role="tablist">' +
      pills +
      "</div>" +
      '<div class="ho-stepper-now">' +
      "<b>" +
      esc(cur.rail) +
      "</b>" +
      "<span>" +
      esc(cur.railSub) +
      "</span>" +
      "</div>"
    );
  }

  function scoreLine(live) {
    live = live || {};
    var left = requiredRemaining(live);
    if (left === 0) {
      if (live.offtakers && live.onlinePay) return "Invoicing is hands-off ready";
      return "Core feeds look good";
    }
    if (live.offtakers && !live.deliveryChosen && left >= 1) {
      return "Approve how offtaker reports leave";
    }
    if (live.offtakers && !live.onlinePay && left === 1) {
      return "Enable online pay to finish offtaker setup";
    }
    return left + " required step" + (left === 1 ? "" : "s") + " left";
  }

  /** Soft update: progress + step states + body — no full remount, no re-animation. */
  function softUpdate() {
    if (!state.open) {
      updatePill();
      return;
    }
    var root = document.getElementById("hoTour");
    if (!root) return;
    var live = state.live || {};
    var brandSub = root.querySelector(".ho-brand span");
    if (brandSub) brandSub.textContent = scoreLine(live);
    var stepsHost = root.querySelector(".ho-steps");
    if (stepsHost) {
      stepsHost.innerHTML = buildStepsHtml(live);
      stepsHost.querySelectorAll("[data-idx]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.idx = parseInt(btn.getAttribute("data-idx"), 10) || 0;
          hardRender({ animate: false });
        });
      });
    }
    var main = root.querySelector(".ho-main");
    if (main) {
      var formSnap = snapshotLoginForm(main);
      // Don't remount the main panel while the operator is typing logins — only
      // refresh status chips in place. Full rewrite caused a glitchy flicker.
      var formDirty =
        formSnap &&
        (formSnap.user ||
          formSnap.pass ||
          formSnap.consent ||
          formSnap.focus ||
          (formSnap.msg && formSnap.msg.length));
      var step = STEPS[state.idx] || STEPS[0];
      if (formDirty && step.loginForm && main.querySelector("[data-ho-login]")) {
        var chipHost = main.querySelector(".ho-status-row");
        if (chipHost) {
          var tmp = document.createElement("div");
          tmp.innerHTML = statusChips(step, live);
          var nextChips = tmp.firstChild;
          if (nextChips) chipHost.replaceWith(nextChips);
        }
        // Optional completion callout — leave form untouched
      } else {
        main.innerHTML =
          renderBody(step, live);
        wireActions(main);
        restoreLoginForm(main, formSnap);
      }
    }
    updatePill();
  }

  function hardRender(opts) {
    opts = opts || {};
    var animate = !!opts.animate;
    var root = ensureRoot();
    var step = STEPS[state.idx] || STEPS[0];
    var live = state.live || {};
    var mode = state.mode === "dock" ? "dock" : "modal";
    // Instant show — no entrance animation (Ford: load instantly on Setup click)
    root.className = "ho-mode-" + mode + " ho-open";
    root.setAttribute("aria-modal", mode === "modal" ? "true" : "false");
    // Clean header: brand + close only (100% ring removed — cramped next to ×,
    // readiness already reads in the subtitle + step pills; Ford 2026-07-14).
    root.innerHTML =
      '<div class="ho-backdrop" data-ho="backdrop"></div>' +
      '<div class="ho-sheet">' +
      '<header class="ho-top">' +
      '<div class="ho-brand"><div class="ho-brand-mark" aria-hidden="true"></div>' +
      "<div><b>Hands-off setup</b><span>" +
      esc(scoreLine(live)) +
      "</span></div></div>" +
      "</header>" +
      '<div class="ho-steps">' +
      buildStepsHtml(live) +
      "</div>" +
      '<section class="ho-main">' +
      renderBody(step, live) +
      "</section></div>";

    root.hidden = false;
    try {
      root.style.display = "flex";
      root.style.opacity = "1";
      root.style.pointerEvents = "auto";
    } catch (e) {}
    state.open = true;
    setShellOpen(mode === "dock");
    updatePill();
    wire(root);
  }

  function statusChips(step, live) {
    if (!step.statusKey) return "";
    var chips = [];
    if (step.statusKey === "arrays") {
      chips.push(chip(live.arrays, live.arrays ? live.arrayCount + " arrays connected" : "No arrays yet"));
    }
    if (step.statusKey === "autorefresh") {
      var mode = live.captureMode || "";
      try {
        mode = mode || localStorage.getItem("ao_ar_mode") || "";
      } catch (e) {}
      if (live.cloud) {
        chips.push(
          chip(
            true,
            (mode === "device" ? "Device vault" : "Cloud capture") +
              " · " +
              (live.cloudCreds || 0) +
              " login" +
              (live.cloudCreds === 1 ? "" : "s")
          )
        );
      } else {
        chips.push(chip(false, "Auto-refresh not configured"));
      }
    }
    if (step.statusKey === "utility") {
      if (live.utilWithBills > 0) {
        chips.push(chip(true, live.utilWithBills + " bill source" + (live.utilWithBills === 1 ? "" : "s")));
      } else if (live.utilCount > 0) {
        chips.push(chip(false, live.utilCount + " accounts · no bills yet"));
      } else {
        chips.push(chip(false, "No utility linked"));
      }
    }
    if (step.statusKey === "offtakers") {
      chips.push(
        chip(
          !!live.offtakers,
          live.offtakers
            ? live.offtakerCount + " offtaker" + (live.offtakerCount === 1 ? "" : "s")
            : "No offtakers yet (optional)"
        )
      );
    }
    if (step.statusKey === "autosend") {
      if (!live.offtakers) {
        chips.push(chip(true, "Optional until you invoice offtakers"));
      } else if (live.deliveryChosen) {
        chips.push(
          chip(
            true,
            live.deliveryMode === "auto"
              ? "Auto-send approved"
              : "Approve-to-send chosen"
          )
        );
      } else {
        chips.push(chip(false, "Choose how reports leave"));
      }
      if (live.samplePreview && live.samplePreview.name) {
        chips.push(
          chip(
            !!live.samplePreview.hasMath,
            live.samplePreview.hasMath
              ? "Preview ready · " + String(live.samplePreview.name).slice(0, 22)
              : "Preview · " + String(live.samplePreview.name).slice(0, 22)
          )
        );
      }
    }
    if (step.statusKey === "onlinepay") {
      if (live.onlinePay) {
        chips.push(
          chip(
            true,
            "Online pay ON" + (live.onlinePayFee ? " · fee " + live.onlinePayFee : "")
          )
        );
      } else if (live.onlinePayConnected) {
        chips.push(chip(false, "Started — finish bank details on Stripe"));
      } else {
        chips.push(
          chip(
            false,
            live.offtakers
              ? "Required for hands-off offtaker invoices"
              : "Not enabled yet"
          )
        );
      }
    }
    if (!chips.length) return "";
    return '<div class="ho-status-row">' + chips.join("") + "</div>";
  }

  function chip(ok, label) {
    return (
      '<span class="ho-chip ' +
      (ok ? "is-ok" : "is-miss") +
      '"><span class="ho-chip-dot"></span>' +
      esc(label) +
      "</span>"
    );
  }

  var INVERTER_OPTS = [
    { id: "chint", label: "Chint / CPS", ph: "Chint username / email" },
    { id: "fronius", label: "Fronius (Solar.web)", ph: "Solar.web username / email" },
    { id: "sma", label: "SMA (Sunny Portal)", ph: "Sunny Portal username / email" },
    { id: "solaredge", label: "SolarEdge portal", ph: "Monitoring username / email" },
  ];
  var UTILITY_OPTS = [
    { id: "gmp", label: "Green Mountain Power", ph: "GMP username / email", host: "" },
    // SmartHub co-ops need login_host (backend rejects without it)
    {
      id: "vec",
      label: "Vermont Electric Co-op",
      ph: "VEC SmartHub email",
      host: "vermontelectric.smarthub.coop",
    },
    {
      id: "wec",
      label: "Washington Electric Co-op",
      ph: "WEC SmartHub email",
      host: "washingtonelectric.smarthub.coop",
    },
  ];
  var INVERTER_PENDING = { chint: 1, fronius: 1, sma: 1, solaredge: 1, locus: 1, alsoenergy: 1 };

  /** Keep typed credentials across softUpdate re-renders (probe every ~1.2s). */
  function snapshotLoginForm(main) {
    var box = main && main.querySelector("[data-ho-login]");
    if (!box) return null;
    var active = document.activeElement;
    var focus = null;
    if (active && box.contains(active)) {
      if (active.classList.contains("ho-login-provider")) focus = "provider";
      else if (active.classList.contains("ho-login-user")) focus = "user";
      else if (active.classList.contains("ho-login-pass")) focus = "pass";
      else if (active.classList.contains("ho-login-consent-chk")) focus = "consent";
    }
    var sel = box.querySelector(".ho-login-provider");
    var userEl = box.querySelector(".ho-login-user");
    var passEl = box.querySelector(".ho-login-pass");
    var consent = box.querySelector(".ho-login-consent-chk");
    var msg = box.querySelector(".ho-login-msg");
    var btn = box.querySelector(".ho-login-save");
    var selStart = null;
    var selEnd = null;
    if (active && (active === userEl || active === passEl) && typeof active.selectionStart === "number") {
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    }
    return {
      provider: (sel && sel.value) || "",
      user: (userEl && userEl.value) || "",
      pass: (passEl && passEl.value) || "",
      consent: !!(consent && consent.checked),
      msg: (msg && msg.textContent) || "",
      msgClass: (msg && msg.className) || "ho-login-msg",
      btnText: (btn && btn.textContent) || "",
      btnDisabled: !!(btn && btn.disabled),
      focus: focus,
      selStart: selStart,
      selEnd: selEnd,
    };
  }

  function restoreLoginForm(main, snap) {
    if (!snap || !main) return;
    var box = main.querySelector("[data-ho-login]");
    if (!box) return;
    var sel = box.querySelector(".ho-login-provider");
    var userEl = box.querySelector(".ho-login-user");
    var passEl = box.querySelector(".ho-login-pass");
    var consent = box.querySelector(".ho-login-consent-chk");
    var msg = box.querySelector(".ho-login-msg");
    var btn = box.querySelector(".ho-login-save");
    if (sel && snap.provider) {
      sel.value = snap.provider;
      var opt = sel.options[sel.selectedIndex];
      var ph = opt && opt.getAttribute("data-ph");
      if (ph && userEl) userEl.placeholder = ph;
    }
    if (userEl) userEl.value = snap.user || "";
    if (passEl) passEl.value = snap.pass || "";
    if (consent) consent.checked = !!snap.consent;
    if (msg) {
      msg.textContent = snap.msg || "";
      msg.className = snap.msgClass || "ho-login-msg";
    }
    if (btn) {
      if (snap.btnText) btn.textContent = snap.btnText;
      btn.disabled = !!snap.btnDisabled;
    }
    var focusEl = null;
    if (snap.focus === "provider") focusEl = sel;
    else if (snap.focus === "user") focusEl = userEl;
    else if (snap.focus === "pass") focusEl = passEl;
    else if (snap.focus === "consent") focusEl = consent;
    if (focusEl) {
      try {
        focusEl.focus();
        if (
          (focusEl === userEl || focusEl === passEl) &&
          snap.selStart != null &&
          typeof focusEl.setSelectionRange === "function"
        ) {
          focusEl.setSelectionRange(snap.selStart, snap.selEnd != null ? snap.selEnd : snap.selStart);
        }
      } catch (e) {}
    }
  }

  function loginFormHtml(kind, live) {
    live = live || state.live || {};
    var opts = kind === "utility" ? UTILITY_OPTS : INVERTER_OPTS;
    var options = opts
      .map(function (o) {
        return '<option value="' + esc(o.id) + '" data-ph="' + esc(o.ph) + '" data-label="' + esc(o.label) + '">' + esc(o.label) + "</option>";
      })
      .join("");
    var title =
      kind === "utility" ? "Add a utility login" : "Add a monitoring login";
    var sub =
      kind === "utility"
        ? "Encrypted on our servers · powers automatic offtaker invoices"
        : "Encrypted on our servers · keeps production fresh 24/7";
    // Saved logins chips — makes multi-vendor clear (what's already in vs what you're adding)
    var invSet = { chint: 1, fronius: 1, sma: 1, solaredge: 1, locus: 1, alsoenergy: 1 };
    var utilSet = { gmp: 1, vec: 1, wec: 1 };
    var chips = "";
    var logins = live.cloudLogins || [];
    var relevant = logins.filter(function (c) {
      if (kind === "utility") return utilSet[c.provider] || !invSet[c.provider];
      return invSet[c.provider];
    });
    if (relevant.length) {
      chips =
        '<div class="ho-login-saved" aria-label="Saved logins">' +
        '<div class="ho-login-saved-lab">Already saved</div>' +
        '<div class="ho-login-chips">' +
        relevant
          .map(function (c) {
            var lab = c.provider;
            for (var i = 0; i < opts.length; i++) {
              if (opts[i].id === c.provider) {
                lab = opts[i].label;
                break;
              }
            }
            var userShort = (c.username || "").length > 28
              ? (c.username || "").slice(0, 26) + "…"
              : c.username || "";
            return (
              '<span class="ho-login-chip" data-provider="' +
              esc(c.provider) +
              '" title="' +
              esc(c.username || "") +
              '"><i>✓</i><b>' +
              esc(lab) +
              "</b>" +
              (userShort ? "<em>" + esc(userShort) + "</em>" : "") +
              "</span>"
            );
          })
          .join("") +
        "</div></div>";
    }
    var firstLabel = opts[0].label;
    return (
      '<div class="ho-login" data-ho-login="' +
      esc(kind) +
      '">' +
      '<div class="ho-login-hd"><b>' +
      esc(title) +
      "</b><span>" +
      esc(sub) +
      "</span></div>" +
      chips +
      '<div class="ho-login-now" data-ho-now>' +
      "Now adding: <b>" +
      esc(firstLabel) +
      "</b> — enter <em>that portal’s</em> username &amp; password below" +
      "</div>" +
      '<label class="ho-login-field"><span>Portal</span>' +
      '<select class="ho-login-provider" aria-label="Portal">' +
      options +
      "</select></label>" +
      '<label class="ho-login-field"><span>Username / email for this portal</span>' +
      '<input type="text" class="ho-login-user" autocomplete="username" spellcheck="false" placeholder="' +
      esc(opts[0].ph) +
      '"></label>' +
      '<label class="ho-login-field"><span>Password for this portal</span>' +
      '<input type="password" class="ho-login-pass" autocomplete="current-password" placeholder="Portal password"></label>' +
      '<label class="ho-login-consent">' +
      '<input type="checkbox" class="ho-login-consent-chk">' +
      "<span>I authorize Array Operator to store this login encrypted and sign in on my behalf to keep my data fresh.</span></label>" +
      '<div class="ho-login-actions">' +
      '<button type="button" class="ho-btn ho-btn-primary ho-login-save">Save ' +
      esc(firstLabel) +
      " login →</button>" +
      '<span class="ho-login-msg" aria-live="polite"></span>' +
      "</div>" +
      '<p class="ho-login-foot">Switch the portal above to add another vendor. Each portal keeps its own username &amp; password. Prefer device-only storage? Account → Auto-refresh → <b>Keep it on my computer</b>.</p>' +
      "</div>"
    );
  }

  function moneyFmt(n) {
    if (n == null || n === "" || isNaN(Number(n))) return "—";
    try {
      return (
        "$" +
        Number(n).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      );
    } catch (e) {
      return "$" + Number(n).toFixed(2);
    }
  }

  function kwhFmt(n) {
    if (n == null || n === "" || isNaN(Number(n))) return "—";
    try {
      return Math.round(Number(n)).toLocaleString() + " kWh";
    } catch (e) {
      return Math.round(Number(n)) + " kWh";
    }
  }

  function shareFmt(frac) {
    if (frac == null || frac === "" || isNaN(Number(frac))) return "—";
    var n = Number(frac);
    // Accept either 0–1 fraction or already 0–100 percent
    if (n > 0 && n <= 1) n = n * 100;
    return (Math.round(n * 10) / 10) + "%";
  }

  /** Mini offtaker invoice + bill strip — the dreamland payoff card. */
  function renderDreamPreview(live) {
    var p = live.samplePreview;
    var hasReal = !!(p && p.name);
    var name = hasReal ? p.name : "Sample offtaker";
    var email = hasReal && p.email ? p.email : "customer@example.com";
    var share = hasReal ? shareFmt(p.share) : "12.5%";
    var period =
      hasReal && p.period
        ? p.period
        : "Latest settled bill";
    var amount = hasReal && p.hasMath ? moneyFmt(p.amount) : hasReal ? "—" : "$184.20";
    var kwh = hasReal && p.hasMath ? kwhFmt(p.kwh) : hasReal ? "—" : "1,228 kWh";
    var rate =
      hasReal && p.rate != null
        ? "$" + Number(p.rate).toFixed(3) + "/kWh"
        : hasReal
          ? "bill rate"
          : "$0.150/kWh";
    var bill =
      hasReal && p.billLabel
        ? p.billLabel
        : hasReal
          ? "Utility bill"
          : "GMP bill · Jun 2026";
    var badge = hasReal
      ? p.hasMath
        ? "Live draft math"
        : "Your offtaker · waiting on bill"
      : "Example layout";
    return (
      '<div class="ho-dream">' +
      '<div class="ho-dream-glow" aria-hidden="true"></div>' +
      '<div class="ho-dream-paper">' +
      '<div class="ho-dream-badge">' +
      esc(badge) +
      "</div>" +
      '<div class="ho-dream-from">Invoice for</div>' +
      '<div class="ho-dream-name">' +
      esc(name) +
      "</div>" +
      '<div class="ho-dream-email">' +
      esc(email) +
      "</div>" +
      '<div class="ho-dream-row">' +
      "<span>Period</span><b>" +
      esc(period) +
      "</b></div>" +
      '<div class="ho-dream-row"><span>Your share</span><b>' +
      esc(share) +
      "</b></div>" +
      '<div class="ho-dream-row"><span>Production</span><b>' +
      esc(kwh) +
      "</b></div>" +
      '<div class="ho-dream-row"><span>Rate</span><b>' +
      esc(rate) +
      "</b></div>" +
      '<div class="ho-dream-total"><span>Amount due</span><strong>' +
      esc(amount) +
      "</strong></div>" +
      '<div class="ho-dream-bill">' +
      '<span class="ho-dream-bill-ic" aria-hidden="true">☰</span>' +
      "<div><b>Source bill lined up</b><span>" +
      esc(bill) +
      " · used for kWh &amp; rate</span></div></div>" +
      "</div></div>"
    );
  }

  function renderModePicker(live) {
    var mode = live.deliveryMode === "auto" ? "auto" : "approval";
    var chosen = !!live.deliveryChosen;
    return (
      '<div class="ho-mode-pick" role="group" aria-label="How offtaker reports leave">' +
      '<div class="ho-mode-pick-lab">How should drafts leave once a bill settles?</div>' +
      '<div class="ho-mode-cards">' +
      '<button type="button" class="ho-mode-card' +
      (mode === "approval" ? " is-on" : "") +
      (chosen && mode === "approval" ? " is-chosen" : "") +
      '" data-ho="set-mode" data-mode="approval">' +
      '<span class="ho-mode-tag">Trust anchor</span>' +
      "<b>Approve to send</b>" +
      "<p>Each draft waits for your OK. Best while you’re still verifying shares and bills.</p>" +
      "</button>" +
      '<button type="button" class="ho-mode-card ho-mode-dream' +
      (mode === "auto" ? " is-on" : "") +
      (chosen && mode === "auto" ? " is-chosen" : "") +
      '" data-ho="set-mode" data-mode="auto">' +
      '<span class="ho-mode-tag is-rec">Hands-off · recommended</span>' +
      "<b>Auto-send</b>" +
      "<p>When the utility bill settles, drafts email themselves. You stay in control of the pause switch.</p>" +
      "</button>" +
      "</div>" +
      (chosen
        ? '<div class="ho-mode-confirm is-ok">' +
          (mode === "auto"
            ? "<b>Auto-send is on</b> for enabled offtakers. Per-offtaker overrides still work on Invoices."
            : "<b>Approve to send</b> is set. Open Invoices anytime to flip the fleet to auto-send.") +
          "</div>"
        : live.offtakers
          ? '<div class="ho-mode-confirm">Tap a card to lock in your fleet default — you can change it later on Invoices.</div>'
          : '<div class="ho-mode-confirm">No offtakers yet — pick a default now so you’re ready when the first one lands.</div>') +
      "</div>"
    );
  }

  function renderBody(step, live) {
    var html = "";
    html +=
      '<div class="ho-kicker"><i></i>' +
      esc(step.kicker) +
      "</div>";
    html += '<h2 class="ho-title">' + esc(step.title) + "</h2>";
    html += '<p class="ho-lede">' + step.lede + "</p>";

    if (step.kind === "welcome") {
      // Three benefit cards — tease the invoice dream moment
      html +=
        '<div class="ho-hero ho-hero-3">' +
        '<div class="ho-hero-card"><div class="ho-hero-ic">↻</div><b>Live data 24/7</b><p>Cloud auto-refresh keeps production fresh.</p></div>' +
        '<div class="ho-hero-card ho-accent-green"><div class="ho-hero-ic">▤</div><b>Bill + invoice lined up</b><p>See one offtaker draft with its utility bill.</p></div>' +
        '<div class="ho-hero-card"><div class="ho-hero-ic">✓</div><b>Send on rails</b><p>Approve each draft — or auto-send when ready.</p></div>' +
        "</div>";
    }

    if (step.kind === "dream") {
      html += statusChips(step, live);
      html += renderDreamPreview(live);
      html += renderModePicker(live);
      if (step.bullets && step.bullets.length) {
        html +=
          '<details class="ho-details">' +
          "<summary>What you’re looking at</summary>" +
          '<ul class="ho-bullets">' +
          step.bullets
            .map(function (b) {
              return "<li><span>" + b + "</span></li>";
            })
            .join("") +
          "</ul></details>";
      }
      if (step.callout) {
        html += '<div class="ho-callout">' + step.callout + "</div>";
      }
      if (stepComplete(step, live) && live.offtakers && live.deliveryChosen) {
        html +=
          '<div class="ho-callout" style="background:var(--ho-green-soft);border-color:rgba(23,138,78,.22);color:var(--ho-green)">' +
          (live.deliveryMode === "auto"
            ? "<b>You’re in dreamland.</b> Drafts will auto-send when bills settle — open the full preview anytime."
            : "<b>Approve mode locked in.</b> Open the offtaker preview, then flip to auto-send when you trust the path.") +
          "</div>";
      }
    }

    if (step.kind === "step") {
      html += statusChips(step, live);
      // Inline vault form first — highest-friction; bullets collapse so form has room
      if (step.loginForm) {
        html += loginFormHtml(step.loginForm, live);
      }
      if (step.bullets && step.bullets.length) {
        html +=
          '<details class="ho-details"' +
          (step.loginForm ? "" : " open") +
          ">" +
          "<summary>Tips for this step</summary>" +
          '<ul class="ho-bullets">' +
          step.bullets
            .map(function (b) {
              return "<li><span>" + b + "</span></li>";
            })
            .join("") +
          "</ul></details>";
      }
      if (step.callout) {
        html += '<div class="ho-callout">' + step.callout + "</div>";
      }
      if (stepComplete(step, live)) {
        var doneMsg =
          step.statusKey === "onlinepay"
            ? "<b>Online pay is live.</b> Future offtaker invoices can include a Pay button."
            : step.loginForm
              ? "<b>Looks good on this step.</b> You can still add another login above, or continue."
              : "<b>Looks good on this step.</b> Continue when you’re ready.";
        html +=
          '<div class="ho-callout" style="background:var(--ho-green-soft);border-color:rgba(23,138,78,.22);color:var(--ho-green)">' +
          doneMsg +
          "</div>";
      }
    }

    if (step.kind === "done") {
      html +=
        '<div class="ho-done-grid">' +
        '<div class="ho-done-card"><b>Arrays</b><span>' +
        (live.arrays ? "✓ " + live.arrayCount + " connected" : "Still open — add from Inverters") +
        "</span></div>" +
        '<div class="ho-done-card"><b>Auto-refresh</b><span>' +
        (live.cloud
          ? "✓ " + (live.cloudCreds || "") + " login(s) saved"
          : "Add cloud (or device) vault logins") +
        "</span></div>" +
        '<div class="ho-done-card"><b>Utility bills</b><span>' +
        (live.utilWithBills
          ? "✓ " + live.utilWithBills + " with bills"
          : live.utilCount
            ? live.utilCount + " linked — waiting on bills"
            : "Link GMP / co-op for invoicing") +
        "</span></div>" +
        '<div class="ho-done-card"><b>Offtakers</b><span>' +
        (live.offtakers
          ? "✓ " + live.offtakerCount + " ready"
          : "Optional — for credit invoices") +
        "</span></div>" +
        '<div class="ho-done-card"><b>Send mode</b><span>' +
        (live.deliveryChosen
          ? live.deliveryMode === "auto"
            ? "✓ Auto-send"
            : "✓ Approve to send"
          : live.offtakers
            ? "Choose approve vs auto-send"
            : "Optional until you invoice") +
        "</span></div>" +
        '<div class="ho-done-card"><b>Online pay</b><span>' +
        (live.onlinePay
          ? "✓ Pay links on invoices" +
            (live.onlinePayFee ? " · fee " + live.onlinePayFee : "")
          : live.offtakers
            ? "Needed — enable so offtakers can pay"
            : "Optional until you invoice offtakers") +
        "</span></div>" +
        "</div>";
      html +=
        '<div class="ho-callout"><b>Tip:</b> open the Energy Agent orb anytime and ask “what still needs setup for hands-off?” — it can walk the live UI with you.</div>';
    }

    // actions
    html += '<div class="ho-actions">';
    if (step.kind === "welcome") {
      html +=
        '<button type="button" class="ho-btn ho-btn-primary" data-ho="next">Start hands-off setup →</button>';
      html +=
        '<button type="button" class="ho-btn ho-btn-text" data-ho="minimize">Explore site — keep checklist</button>';
    } else if (step.kind === "done") {
      html +=
        '<button type="button" class="ho-btn ho-btn-primary" data-ho="finish">Done — enter dashboard →</button>';
      html +=
        '<button type="button" class="ho-btn ho-btn-ghost" data-ho="cta" data-hash="#account" data-ar="1">Review Auto-refresh</button>';
    } else {
      if (step.cta) {
        if (step.cta.action === "start-connect") {
          html +=
            '<button type="button" class="ho-btn ho-btn-primary" data-ho="start-connect">' +
            esc(step.cta.label) +
            "</button>";
        } else {
          html +=
            '<button type="button" class="ho-btn ho-btn-primary" data-ho="cta" data-hash="' +
            esc(step.cta.hash || "") +
            '"' +
            (step.cta.openAr ? ' data-ar="1"' : "") +
            (step.cta.openPay ? ' data-pay="1"' : "") +
            (step.cta.openPreview ? ' data-preview="1"' : "") +
            ">" +
            esc(step.cta.label) +
            "</button>";
        }
      }
      if (step.secondaryCta) {
        html +=
          '<button type="button" class="ho-btn ho-btn-ghost" data-ho="cta" data-hash="' +
          esc(step.secondaryCta.hash || "") +
          '"' +
          (step.secondaryCta.openAr ? ' data-ar="1"' : "") +
          (step.secondaryCta.openPay ? ' data-pay="1"' : "") +
          ">" +
          esc(step.secondaryCta.label) +
          "</button>";
      }
      // Dream step: Continue advances only after a mode choice (or skip)
      if (step.kind === "dream" && live.offtakers && !live.deliveryChosen) {
        html +=
          '<button type="button" class="ho-btn ho-btn-ghost" data-ho="next" data-mark-mode="approval">Continue with approve-to-send</button>';
      } else {
        html +=
          '<button type="button" class="ho-btn ho-btn-ghost" data-ho="next">Continue</button>';
      }
      if (step.secondary && step.secondary.skip) {
        html +=
          '<button type="button" class="ho-btn ho-btn-text" data-ho="next"' +
          (step.kind === "dream" ? ' data-mark-mode="approval"' : "") +
          ">" +
          esc(step.secondary.label) +
          "</button>";
      }
      html += '<span class="ho-actions-sp"></span>';
      if (state.idx > 0) {
        html +=
          '<button type="button" class="ho-btn ho-btn-text" data-ho="back">Back</button>';
      }
    }
    html += "</div>";
    return html;
  }

  function scrollToOnlinePay() {
    var tries = 0;
    function attempt() {
      tries++;
      var el =
        document.getElementById("aoPaySetup") ||
        document.getElementById("aoPayCard") ||
        document.querySelector(".acct-pay-setup");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        try {
          el.classList.add("ho-pay-pulse");
          setTimeout(function () {
            el.classList.remove("ho-pay-pulse");
          }, 2200);
        } catch (e) {}
        return;
      }
      if (tries < 12) setTimeout(attempt, 180);
    }
    setTimeout(attempt, 220);
  }

  function openOfftakerPreview() {
    var live = state.live || {};
    var sid =
      (live.samplePreview && live.samplePreview.id) ||
      null;
    // Prefer the reports helper (expands accordion + flashes card)
    setTimeout(function () {
      try {
        if (typeof window.__aoOpenOfftakerPreview === "function") {
          window.__aoOpenOfftakerPreview(sid);
          return;
        }
      } catch (e) {}
      // Fallback: scroll list + try deep-link style open
      var list =
        document.getElementById("rbList") ||
        document.querySelector(".rb2-listwrap");
      if (list) list.scrollIntoView({ behavior: "smooth", block: "start" });
      if (sid) {
        var acc = document.querySelector(
          '.rb-acc[data-id="' + String(sid).replace(/"/g, "") + '"]'
        );
        if (acc) {
          var head = acc.querySelector(".rb-acc-head");
          if (head) head.click();
          try {
            acc.classList.add("rb-acc-flash");
            setTimeout(function () {
              acc.classList.remove("rb-acc-flash");
            }, 2600);
          } catch (e2) {}
        }
      }
    }, 380);
  }

  function goHash(hash, openAr, openPay, openPreview) {
    if (hash) {
      if (location.hash !== hash) location.hash = hash;
      else {
        try {
          window.dispatchEvent(new Event("hashchange"));
        } catch (e) {}
      }
    }
    if (openAr) {
      setTimeout(function () {
        try {
          if (typeof window.__aoOpenCredentialVault === "function") {
            window.__aoOpenCredentialVault();
            return;
          }
        } catch (e) {}
        var row = document.getElementById("rowAutoRefresh");
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          var body = document.getElementById("arBody");
          if (body) body.classList.remove("ar-collapsed");
        }
      }, 220);
    }
    if (openPay) scrollToOnlinePay();
    if (openPreview) openOfftakerPreview();
  }

  function markDeliveryChosen(mode) {
    mode = mode === "auto" ? "auto" : "approval";
    try {
      localStorage.setItem(DELIVERY_CHOSEN_KEY, mode);
    } catch (e) {}
    state.live = state.live || {};
    state.live.deliveryMode = mode;
    state.live.deliveryChosen = true;
  }

  async function setTourDeliveryMode(mode, btn) {
    mode = mode === "auto" ? "auto" : "approval";
    markDeliveryChosen(mode);
    // Optimistic UI
    softUpdate();
    if (btn) {
      try {
        btn.classList.add("is-busy");
      } catch (e) {}
    }
    if (!session()) return;
    try {
      var r = await fetch(
        "/v1/array-operator/billing/subscriptions/bulk-delivery-mode",
        {
          method: "POST",
          headers: Object.assign(
            { "Content-Type": "application/json" },
            authHeaders()
          ),
          body: JSON.stringify({ mode: mode }),
        }
      );
      // Also nudge reports UI if it's already painted
      try {
        if (typeof window.__aoSetDeliveryMode === "function") {
          window.__aoSetDeliveryMode(mode);
        }
      } catch (e) {}
      if (!r.ok) {
        // Still keep local choice — operator intent is recorded; reports slider may re-sync
        console.warn("[hands-off] bulk-delivery-mode", r.status);
      }
    } catch (e) {
      console.warn("[hands-off] bulk-delivery-mode network", e);
    }
    await probeLive();
    softUpdate();
  }

  async function startConnectFromTour(btn) {
    if (!session()) {
      if (btn) {
        btn.textContent = "Sign in first";
        setTimeout(function () {
          btn.textContent = "Enable online pay — ~2 min →";
        }, 1800);
      }
      return;
    }
    var label = (btn && btn.textContent) || "Enable online pay — ~2 min →";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Opening Stripe…";
    }
    try {
      var r = await fetch("/v1/array-operator/billing/payments/connect", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: "{}",
      });
      var d = {};
      try {
        d = await r.json();
      } catch (e) {}
      var detail = d && typeof d.detail === "object" ? d.detail : d;
      if (r.ok && d.already_ready) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "✓ Already set up";
        }
        await probeLive();
        softUpdate();
        return;
      }
      if (r.ok && d.url) {
        if (btn) btn.textContent = "Redirecting to Stripe…";
        // Remember to resume this step after Stripe Account Link return
        try {
          sessionStorage.setItem("ao_ho_resume_step", "onlinepay");
        } catch (e) {}
        window.location = d.url;
        return;
      }
      var errMsg =
        (detail && detail.error) ||
        (typeof d.detail === "string" ? d.detail : null) ||
        d.error ||
        "Couldn't open bank setup";
      if (btn) {
        btn.disabled = false;
        btn.textContent = String(errMsg).slice(0, 42);
        setTimeout(function () {
          btn.textContent = label;
        }, 2800);
      }
      // Fall back to Account pay card so they still have a path
      goHash("#account", false, true);
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Network error — try again";
        setTimeout(function () {
          btn.textContent = label;
        }, 2200);
      }
      goHash("#account", false, true);
    }
  }

  /** Close panel → pill returns immediately (don't wait on network). */
  function minimizeTour() {
    markModalSeen();
    var root = document.getElementById("hoTour");
    if (root) {
      root.classList.remove("ho-open");
      setTimeout(function () {
        if (!state.open) {
          root.hidden = true;
          root.innerHTML = "";
        }
      }, 280);
    }
    state.open = false;
    setShellOpen(false);
    // Instant FAB restore — was waiting on probeLive() so the pill lagged after ×
    updatePill();
    // Refresh step counts in the background without blocking the pill
    probeLive()
      .then(function () {
        if (!state.open) updatePill();
      })
      .catch(function () {});
  }

  function closeTourFinished() {
    markDone();
    // minimizeTour → updatePill restores the bottom-left Replay FAB (always accessible)
    minimizeTour();
  }

  async function ensureCloudMode() {
    try {
      localStorage.setItem("ao_ar_mode", "cloud");
    } catch (e) {}
    var h = authHeaders();
    if (!h.Authorization) return;
    try {
      await fetch("/v1/account/capture-mode", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, h),
        body: JSON.stringify({ mode: "cloud" }),
      });
    } catch (e) {}
  }

  function loginHostFor(provider, kind) {
    var opts = kind === "utility" ? UTILITY_OPTS : INVERTER_OPTS;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].id === provider) return opts[i].host || "";
    }
    return "";
  }

  async function saveLoginFromForm(box) {
    var kind = (box.getAttribute("data-ho-login") || "").trim();
    var sel = box.querySelector(".ho-login-provider");
    var userEl = box.querySelector(".ho-login-user");
    var passEl = box.querySelector(".ho-login-pass");
    var consent = box.querySelector(".ho-login-consent-chk");
    var msg = box.querySelector(".ho-login-msg");
    var btn = box.querySelector(".ho-login-save");
    var provider = (sel && sel.value) || "";
    var user = (userEl && userEl.value) || "";
    user = user.trim();
    var pass = (passEl && passEl.value) || "";
    var label =
      (sel && sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].text) ||
      provider;
    var loginHost = loginHostFor(provider, kind);

    function setMsg(t, ok) {
      if (!msg) return;
      msg.textContent = t || "";
      msg.className = "ho-login-msg" + (ok === true ? " is-ok" : ok === false ? " is-err" : "");
    }

    if (!provider) {
      setMsg("Pick a portal.", false);
      return;
    }
    if (!user || !pass) {
      setMsg("Enter username and password.", false);
      return;
    }
    if (!consent || !consent.checked) {
      setMsg("Tick the authorization box first.", false);
      return;
    }
    if (!session()) {
      setMsg("Sign in to your account first.", false);
      return;
    }

    btn.disabled = true;
    btn.textContent = "Saving…";
    setMsg("");
    await ensureCloudMode();
    try {
      var body = {
        provider: provider,
        username: user,
        password: pass,
        enable: true,
        consent: true,
      };
      if (loginHost) body.login_host = loginHost;
      var r = await fetch("/v1/cloud-capture/credentials", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      });
      var d = {};
      try {
        d = await r.json();
      } catch (e) {}
      if (!r.ok) {
        var detail =
          (typeof d.detail === "string" && d.detail) ||
          (r.status === 403 ? "Cloud capture not enabled yet" : "Couldn't save — try again");
        setMsg(detail.slice(0, 80), false);
        btn.disabled = false;
        btn.textContent = "Save login →";
        return;
      }
      if (passEl) passEl.value = "";
      setMsg(
        "✓ " + label + " saved — starting cloud harvest. Watch Inverters for Connecting…",
        true
      );
      btn.textContent = "✓ " + label + " saved";
      // Connecting… skeletons for every inverter portal (SE/Fronius/SMA/Chint/…)
      try {
        if (window.__aoPendingFeeds) {
          if (typeof window.__aoPendingFeeds.markInverter === "function") {
            window.__aoPendingFeeds.markInverter(provider, {
              label: label,
              note: "saved from hands-off setup",
              rearm: true,
            });
          } else if (INVERTER_PENDING[provider]) {
            window.__aoPendingFeeds.mark(provider, {
              label: label,
              note: "saved from hands-off setup",
              rearm: true,
            });
          }
        }
      } catch (e) {}
      // Kick harvester to pick this login up on the next tick (≤90s) — don't wait for cron
      try {
        fetch("/v1/cloud-capture/refresh", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: "{}",
        }).catch(function () {});
      } catch (e) {}
      try {
        window.dispatchEvent(new Event("ao:vault-changed"));
      } catch (e) {}
      // Refresh live chips without full remount thrash
      setTimeout(function () {
        probeLive().then(function () {
          softUpdate();
          var root = document.getElementById("hoTour");
          var box2 = root && root.querySelector("[data-ho-login]");
          var newBtn = box2 && box2.querySelector(".ho-login-save");
          var sel2 = box2 && box2.querySelector(".ho-login-provider");
          var lab2 =
            (sel2 && sel2.options[sel2.selectedIndex] && sel2.options[sel2.selectedIndex].text) ||
            "next";
          if (newBtn) {
            newBtn.disabled = false;
            newBtn.textContent = "Add another portal →";
          }
          // Nudge operator to pick a different portal for multi-vendor
          var nowEl = box2 && box2.querySelector("[data-ho-now]");
          if (nowEl) {
            nowEl.innerHTML =
              "<b>✓ " +
              esc(label) +
              " is saved.</b> Pick another portal above to add the next login, or continue.";
            nowEl.classList.add("ho-login-now-ok");
          }
        });
      }, 600);
    } catch (e) {
      setMsg("Network error — try again.", false);
      btn.disabled = false;
      btn.textContent = "Save login →";
    }
  }

  function wireLoginForms(scope) {
    (scope || document).querySelectorAll("[data-ho-login]").forEach(function (box) {
      if (box._hoLoginWired) return;
      box._hoLoginWired = true;
      var sel = box.querySelector(".ho-login-provider");
      var userEl = box.querySelector(".ho-login-user");
      var passEl = box.querySelector(".ho-login-pass");
      var msg = box.querySelector(".ho-login-msg");
      var save = box.querySelector(".ho-login-save");
      var nowEl = box.querySelector("[data-ho-now]");
      var prevProvider = (sel && sel.value) || "";

      function applyProvider(opt, opts) {
        opts = opts || {};
        var ph = opt && opt.getAttribute("data-ph");
        var lab = (opt && (opt.getAttribute("data-label") || opt.text)) || "portal";
        if (ph && userEl) userEl.placeholder = ph;
        if (passEl && opts.clearPass !== false) passEl.value = "";
        if (msg) {
          msg.textContent = "";
          msg.className = "ho-login-msg";
        }
        if (save) {
          save.disabled = false;
          // If this portal is already saved, say Update
          var already = false;
          try {
            var logins = (state.live && state.live.cloudLogins) || [];
            var code = (opt && opt.value) || "";
            already = logins.some(function (c) {
              return c.provider === code;
            });
          } catch (e) {}
          save.textContent = already
            ? "Update " + lab + " login →"
            : "Save " + lab + " login →";
        }
        if (nowEl) {
          nowEl.classList.remove("ho-login-now-ok");
          nowEl.innerHTML =
            "Now adding: <b>" +
            esc(lab) +
            "</b> — enter <em>that portal’s</em> username &amp; password below" +
            (opts.flash
              ? ' <span class="ho-login-switched">switched</span>'
              : "");
          if (opts.flash) {
            nowEl.classList.remove("ho-login-now-flash");
            // reflow to restart CSS animation
            void nowEl.offsetWidth;
            nowEl.classList.add("ho-login-now-flash");
            setTimeout(function () {
              nowEl.classList.remove("ho-login-now-flash");
              var sw = nowEl.querySelector(".ho-login-switched");
              if (sw) sw.remove();
            }, 1600);
          }
        }
        // Clicking a saved chip can prefill username
        if (opts.prefillUser != null && userEl) userEl.value = opts.prefillUser;
      }

      if (sel) {
        sel.addEventListener("change", function () {
          var opt = sel.options[sel.selectedIndex];
          var code = opt && opt.value;
          // Switching portal = new form fill — clear password so we never
          // silently reuse the previous vendor's secret.
          applyProvider(opt, {
            flash: code !== prevProvider,
            clearPass: true,
          });
          prevProvider = code || "";
        });
      }
      // Saved chips → jump to that portal for update
      box.querySelectorAll(".ho-login-chip[data-provider]").forEach(function (chip) {
        chip.addEventListener("click", function () {
          var code = chip.getAttribute("data-provider");
          if (!sel || !code) return;
          sel.value = code;
          var opt = sel.options[sel.selectedIndex];
          var userHint = "";
          try {
            var logins = (state.live && state.live.cloudLogins) || [];
            var hit = logins.find(function (c) {
              return c.provider === code;
            });
            if (hit) userHint = hit.username || "";
          } catch (e) {}
          applyProvider(opt, { flash: true, clearPass: true, prefillUser: userHint });
          prevProvider = code;
          if (passEl) passEl.focus();
        });
      });
      if (save) {
        save.addEventListener("click", function () {
          saveLoginFromForm(box);
        });
      }
      if (passEl) {
        passEl.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            saveLoginFromForm(box);
          }
        });
      }
    });
  }

  function wireActions(scope) {
    wireLoginForms(scope);
    (scope || document).querySelectorAll("[data-ho]").forEach(function (btn) {
      if (btn._hoWired) return;
      btn._hoWired = true;
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-ho");
        if (act === "close" || act === "minimize") {
          minimizeTour();
          return;
        }
        if (act === "backdrop") {
          // Modal + dock: dimmed overlay click closes (dock now shows a light scrim)
          minimizeTour();
          return;
        }
        if (act === "finish") {
          closeTourFinished();
          return;
        }
        if (act === "set-mode") {
          var mode = btn.getAttribute("data-mode") || "approval";
          setTourDeliveryMode(mode, btn);
          return;
        }
        if (act === "next") {
          var markMode = btn.getAttribute("data-mark-mode");
          if (markMode && !(state.live && state.live.deliveryChosen)) {
            markDeliveryChosen(markMode);
          }
          if (state.idx < STEPS.length - 1) state.idx++;
          hardRender({ animate: false });
          return;
        }
        if (act === "back") {
          if (state.idx > 0) state.idx--;
          hardRender({ animate: false });
          return;
        }
        if (act === "start-connect") {
          if (state.mode === "modal") {
            markModalSeen();
            state.mode = "dock";
            hardRender({ animate: true });
            // Re-find button after re-render
            setTimeout(function () {
              var b = document.querySelector('#hoTour [data-ho="start-connect"]');
              startConnectFromTour(b || btn);
            }, 80);
          } else {
            startConnectFromTour(btn);
          }
          return;
        }
        if (act === "cta") {
          var hash = btn.getAttribute("data-hash");
          var ar = btn.getAttribute("data-ar") === "1";
          var pay = btn.getAttribute("data-pay") === "1";
          var preview = btn.getAttribute("data-preview") === "1";
          if (state.mode === "modal") {
            markModalSeen();
            state.mode = "dock";
            hardRender({ animate: true });
          }
          goHash(hash, ar, pay, preview);
          // Preview CTA: stay on dream step so they can still pick send mode
          // Pay/AR: stay so they finish those surfaces
          if (pay || ar || preview) {
            scheduleSoftProbe();
            return;
          }
          if (state.idx < STEPS.length - 1) {
            setTimeout(function () {
              state.idx++;
              probeLive().then(function () {
                hardRender({ animate: false });
              });
            }, 350);
          } else {
            scheduleSoftProbe();
          }
        }
      });
    });
  }

  function wire(root) {
    root.querySelectorAll("[data-idx]").forEach(function (btn) {
      if (btn._hoStepWired) return;
      btn._hoStepWired = true;
      btn.addEventListener("click", function () {
        state.idx = parseInt(btn.getAttribute("data-idx"), 10) || 0;
        hardRender({ animate: false });
      });
    });
    wireActions(root);
  }

  function scheduleSoftProbe() {
    if (state._probeTimer) clearTimeout(state._probeTimer);
    state._probeTimer = setTimeout(function () {
      state._probeTimer = null;
      if (!session()) return;
      probeLive().then(function () {
        if (state.open) softUpdate();
        else updatePill();
      });
    }, 1200);
  }

  /**
   * Instant open — ZERO network awaits before paint.
   * Status chips refresh in the background once probeLive finishes.
   */
  function openTourInstant(opts) {
    opts = opts || {};
    if (!session() && !opts.force && !queryWantsTour()) return;

    if (opts.mode === "modal" || opts.mode === "dock") {
      state.mode = opts.mode;
    } else if (modalAlreadySeen()) {
      state.mode = "dock";
    } else {
      state.mode = "modal";
    }

    if (opts.step != null) {
      state.idx = opts.step;
    } else if (!state.open) {
      var resumeIdx = null;
      try {
        var resumeId = sessionStorage.getItem("ao_ho_resume_step");
        if (resumeId) {
          sessionStorage.removeItem("ao_ho_resume_step");
          for (var ri = 0; ri < STEPS.length; ri++) {
            if (STEPS[ri].id === resumeId) {
              resumeIdx = ri;
              break;
            }
          }
        }
      } catch (e) {}
      if (resumeIdx == null && queryConnectReturn()) {
        for (var ci = 0; ci < STEPS.length; ci++) {
          if (STEPS[ci].id === "onlinepay") {
            resumeIdx = ci;
            break;
          }
        }
      }
      if (opts.force && isTourComplete() && resumeIdx == null && !queryConnectReturn()) {
        state.idx = 0;
      } else {
        state.idx = resumeIdx != null ? resumeIdx : state.idx || 0;
      }
    }

    ensureRoot();
    ensurePill();
    // No entrance animation — instant show
    hardRender({ animate: false });

    // Background status only — never blocks the shell
    if (session()) {
      probeLive()
        .then(function () {
          if (state.open) softUpdate();
          else updatePill();
        })
        .catch(function () {});
    }
    scheduleSoftProbe();

    if (opts.pollConnect || queryConnectReturn()) {
      var polls = 0;
      var pollT = setInterval(function () {
        polls++;
        probeLive().then(function () {
          if (state.open) softUpdate();
          else updatePill();
          if (state.live && state.live.onlinePay) clearInterval(pollT);
        });
        if (polls >= 10) clearInterval(pollT);
      }, 2500);
    }
  }

  /** Async wrapper kept for callers that still await openTour (auto-open, deep links). */
  async function openTour(opts) {
    opts = opts || {};
    // Only wait for session when we truly have none yet (onboarding hand-off)
    if (!session() && (opts.force || queryWantsTour())) {
      await new Promise(function (r) {
        setTimeout(r, 200);
      });
    }
    openTourInstant(opts);
  }

  function tryAutoOpen(attempt) {
    attempt = attempt || 0;
    if (!shouldAutoOpen()) {
      // Always paint the bottom-left FAB for signed-in owners (replay anytime)
      if (session()) probeLive().then(updatePill);
      else updatePill();
      return;
    }
    if (!session()) {
      if (attempt < 12) {
        setTimeout(function () {
          tryAutoOpen(attempt + 1);
        }, 350);
      }
      return;
    }
    var fromConnect = queryConnectReturn();
    scrubTourParams();
    // Explicit tour= always opens; prefer modal first time, dock after
    // After Stripe bank setup, always dock so they see the checklist update
    openTour({
      force: true,
      mode: fromConnect || modalAlreadySeen() ? "dock" : "modal",
      pollConnect: fromConnect,
    });
  }

  function boot() {
    window.__aoHandsOffTour = function (opts) {
      opts = opts || { force: true };
      if (!opts.mode) {
        opts.mode =
          modalAlreadySeen() || isTourComplete() ? "dock" : "modal";
      }
      openTour(opts);
    };
    window.__aoHandsOffTourProbe = probeLive;
    window.__aoHandsOffTourMinimize = minimizeTour;
    window.__aoHandsOffTourUpdatePill = updatePill;

    // Persistent bottom-left FAB for every signed-in owner (Ford 2026-07-14)
    setTimeout(function () {
      if (!session()) return;
      probeLive().then(updatePill);
    }, 600);
    // Session can land a beat after first paint (magic link / onboarding)
    setTimeout(function () {
      if (session()) probeLive().then(updatePill);
    }, 2200);

    // Soft-refresh only (no full remount / re-animation) when fleet data lands
    try {
      if (window.FleetStore && FleetStore.subscribe && !state._fleetSub) {
        state._fleetSub = true;
        FleetStore.subscribe(function () {
          if (!session()) return;
          scheduleSoftProbe();
        });
      }
    } catch (e) {}

    // Auto-open with session retries (session-tabscope can land after first paint)
    setTimeout(function () {
      tryAutoOpen(0);
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
