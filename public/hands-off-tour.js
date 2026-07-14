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
        "You made it past setup. Next is the only checklist that matters: connect the feeds once, so production and invoices keep moving without you babysitting a browser tab.",
      kind: "welcome",
    },
    {
      id: "arrays",
      rail: "Arrays live",
      railSub: "Production feed",
      kicker: "Step 1 of 4 · Hardware",
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
      kicker: "Step 2 of 4 · Capture",
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
      kicker: "Step 3 of 4 · Settlement",
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
      kicker: "Step 4 of 4 · Customers",
      title: "Add offtakers (if you invoice)",
      lede:
        "Each offtaker is a customer who gets a share of solar credits. Bind their share and bill source once; monthly drafts appear for your approval — or auto-send if you trust the path.",
      kind: "step",
      bullets: [
        "Invoices → <b>Add an offtaker</b>: name, email, share %, master/sub utility.",
        "Set master solar credit rate only if you want one fleet override; blank uses each bill’s own rate.",
        "Skip this step if you only monitor arrays — you can always come back.",
      ],
      cta: { label: "Set up offtakers →", hash: "#reports" },
      secondary: { label: "I only monitor — skip", skip: true },
      statusKey: "offtakers",
    },
    {
      id: "done",
      rail: "Hands-off",
      railSub: "You’re set",
      kicker: "You’re ready",
      title: "Set it once. Let it run.",
      lede:
        "When arrays, auto-refresh, and utility bills are green, Array Operator can keep production fresh and draft offtaker invoices without daily login theatre.",
      kind: "done",
    },
  ];

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
      /[?&]setup=autorefresh(&|$)/.test(q)
    );
  }

  function shouldAutoOpen() {
    // Explicit tour= link always opens (even if they finished before)
    if (/[?&]tour=hands-off(&|$)/.test(location.search || "")) return true;
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

  /** Required pillars for “hands-off” (offtakers optional). */
  function requiredRemaining(live) {
    live = live || state.live || {};
    var n = 0;
    if (!live.arrays) n++;
    if (!live.cloud) n++;
    if (!(live.utilWithBills > 0 || live.utilCount > 0)) n++;
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
    };
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
          live.cloudCreds = (cs.credentials || []).filter(function (c) {
            return c && c.enabled !== false;
          }).length;
          live.cloud = live.cloudCreds > 0;
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
    return false;
  }

  function progressPct(live) {
    var keys = ["arrays", "autorefresh", "utility", "offtakers"];
    var done = 0;
    keys.forEach(function (k) {
      if (k === "arrays" && live.arrays) done++;
      if (k === "autorefresh" && live.cloud) done++;
      if (k === "utility" && live.utilities) done++;
      if (k === "offtakers" && live.offtakers) done++;
    });
    return Math.round((done / 4) * 100);
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
    pill.setAttribute("aria-label", "Open hands-off setup checklist");
    document.body.appendChild(pill);
    pill.addEventListener("click", function () {
      openTour({ force: true, mode: "dock" });
    });
    return pill;
  }

  function updatePill() {
    var pill = ensurePill();
    if (!session() || isTourComplete()) {
      pill.classList.remove("ho-pill-show");
      return;
    }
    // Hide pill while modal/dock is open
    if (state.open) {
      pill.classList.remove("ho-pill-show");
      return;
    }
    var live = state.live || {};
    var left = requiredRemaining(live);
    pill.classList.add("ho-pill-show");
    if (left <= 0) {
      pill.classList.add("is-done");
      pill.innerHTML =
        '<span class="ho-pill-badge">✓</span>' +
        '<span class="ho-pill-txt">Hands-off ready' +
        '<span class="ho-pill-sub">Tap to review checklist</span></span>';
    } else {
      pill.classList.remove("is-done");
      pill.innerHTML =
        '<span class="ho-pill-badge">' +
        left +
        "</span>" +
        '<span class="ho-pill-txt">' +
        left +
        " step" +
        (left === 1 ? "" : "s") +
        " to complete" +
        '<span class="ho-pill-sub">Hands-off setup</span></span>';
    }
  }

  function setShellOpen(on) {
    try {
      document.body.classList.toggle("ho-shell-open", !!on);
    } catch (e) {}
  }

  function buildStepsHtml(live) {
    return STEPS.map(function (s, i) {
      var done = stepComplete(s, live) || (s.id === "done" && requiredRemaining(live) === 0);
      var active = i === state.idx;
      var num = s.id === "welcome" ? "★" : s.id === "done" ? "✓" : String(i);
      if (done && s.id !== "welcome") num = "✓";
      return (
        '<button type="button" class="ho-step' +
        (active ? " is-active" : "") +
        (done ? " is-done" : "") +
        '" data-idx="' +
        i +
        '">' +
        '<span class="ho-dot">' +
        num +
        "</span>" +
        "<span><div class=\"ho-step-t\">" +
        esc(s.rail) +
        '</div><div class="ho-step-s">' +
        esc(s.railSub) +
        "</div></span></button>"
      );
    }).join("");
  }

  function scoreLine(live) {
    var left = requiredRemaining(live);
    return left === 0
      ? "Core feeds look good"
      : left + " required step" + (left === 1 ? "" : "s") + " left";
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
    var pct = progressPct(live);
    var ring = root.querySelector(".ho-ring");
    var ringStrong = root.querySelector(".ho-ring strong");
    var scoreSpan = root.querySelector(".ho-score-copy span");
    if (ring) ring.style.setProperty("--p", String(pct));
    if (ringStrong) ringStrong.textContent = pct + "%";
    if (scoreSpan) scoreSpan.textContent = scoreLine(live);
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
      var step = STEPS[state.idx] || STEPS[0];
      main.innerHTML =
        '<button type="button" class="ho-close" data-ho="close" aria-label="Minimize">×</button>' +
        renderBody(step, live);
      wireActions(main);
      restoreLoginForm(main, formSnap);
    }
    updatePill();
  }

  function hardRender(opts) {
    opts = opts || {};
    var animate = !!opts.animate;
    var root = ensureRoot();
    var step = STEPS[state.idx] || STEPS[0];
    var live = state.live || {};
    var pct = progressPct(live);
    var mode = state.mode === "dock" ? "dock" : "modal";
    var foot =
      mode === "dock"
        ? "Use the site while this stays open — checklist updates live."
        : "Takes ~5 minutes. Close anytime — resume from the pill bottom-left.";

    var firstOpen = !state.open;
    var doAnim = animate && firstOpen;
    root.className =
      "ho-mode-" + mode + (firstOpen ? "" : " ho-open") + (doAnim ? " ho-anim" : "");
    root.setAttribute("aria-modal", mode === "modal" ? "true" : "false");
    root.innerHTML =
      '<div class="ho-backdrop" data-ho="backdrop"></div>' +
      '<div class="ho-sheet">' +
      '<aside class="ho-rail">' +
      '<div class="ho-brand"><div class="ho-brand-mark" aria-hidden="true"></div>' +
      "<div><b>Array Operator</b><span>Hands-off setup</span></div></div>" +
      '<div class="ho-score">' +
      '<div class="ho-ring" style="--p:' +
      pct +
      '"><strong>' +
      pct +
      "%</strong></div>" +
      '<div class="ho-score-copy"><b>Hands-off readiness</b><span>' +
      esc(scoreLine(live)) +
      "</span></div>" +
      "</div>" +
      '<div class="ho-steps" role="tablist">' +
      buildStepsHtml(live) +
      "</div>" +
      '<div class="ho-rail-foot">' +
      foot +
      "</div>" +
      "</aside>" +
      '<section class="ho-main">' +
      '<button type="button" class="ho-close" data-ho="close" aria-label="Minimize">×</button>' +
      renderBody(step, live) +
      "</section></div>";

    root.hidden = false;
    state.open = true;
    setShellOpen(mode === "dock");
    updatePill();
    wire(root);

    if (doAnim) {
      requestAnimationFrame(function () {
        root.classList.add("ho-open");
        setTimeout(function () {
          root.classList.remove("ho-anim");
        }, 420);
      });
    } else {
      root.classList.add("ho-open");
      root.classList.remove("ho-anim");
    }
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

  function loginFormHtml(kind) {
    var opts = kind === "utility" ? UTILITY_OPTS : INVERTER_OPTS;
    var options = opts
      .map(function (o) {
        return '<option value="' + esc(o.id) + '" data-ph="' + esc(o.ph) + '">' + esc(o.label) + "</option>";
      })
      .join("");
    var title =
      kind === "utility" ? "Add a utility login" : "Add a monitoring login";
    var sub =
      kind === "utility"
        ? "Encrypted on our servers · powers automatic offtaker invoices"
        : "Encrypted on our servers · keeps production fresh 24/7";
    return (
      '<div class="ho-login" data-ho-login="' +
      esc(kind) +
      '">' +
      '<div class="ho-login-hd"><b>' +
      esc(title) +
      "</b><span>" +
      esc(sub) +
      "</span></div>" +
      '<label class="ho-login-field"><span>Portal</span>' +
      '<select class="ho-login-provider" aria-label="Portal">' +
      options +
      "</select></label>" +
      '<label class="ho-login-field"><span>Username / email</span>' +
      '<input type="text" class="ho-login-user" autocomplete="username" spellcheck="false" placeholder="' +
      esc(opts[0].ph) +
      '"></label>' +
      '<label class="ho-login-field"><span>Password</span>' +
      '<input type="password" class="ho-login-pass" autocomplete="current-password" placeholder="Portal password"></label>' +
      '<label class="ho-login-consent">' +
      '<input type="checkbox" class="ho-login-consent-chk">' +
      "<span>I authorize Array Operator to store this login encrypted and sign in on my behalf to keep my data fresh.</span></label>" +
      '<div class="ho-login-actions">' +
      '<button type="button" class="ho-btn ho-btn-primary ho-login-save">Save login →</button>' +
      '<span class="ho-login-msg" aria-live="polite"></span>' +
      "</div>" +
      '<p class="ho-login-foot">Prefer device-only storage? Use Account → Auto-refresh → <b>Keep it on my computer</b> after you finish here.</p>' +
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
      html +=
        '<div class="ho-welcome-art" aria-hidden="true"><div class="ho-orbits"><span></span><span></span><span></span></div></div>';
      html +=
        '<div class="ho-hero">' +
        '<div class="ho-hero-card"><div class="ho-hero-ic">↻</div><b>Cloud auto-refresh</b><p>We sign in for you 24/7. No tab left open overnight.</p></div>' +
        '<div class="ho-hero-card ho-accent-green"><div class="ho-hero-ic">✓</div><b>Invoices on rails</b><p>Utility bills land → offtaker drafts ready when you are.</p></div>' +
        "</div>";
      html +=
        '<div class="ho-callout"><b>The promise:</b> spend one focused setup, then open Array Operator when something needs a human — not every morning to “check if it synced.”</div>';
    }

    if (step.kind === "step") {
      html += statusChips(step, live);
      // Inline vault form first on login steps — highest-friction thing to remove
      if (step.loginForm) {
        html += loginFormHtml(step.loginForm);
      }
      if (step.bullets && step.bullets.length) {
        html +=
          '<ul class="ho-bullets">' +
          step.bullets
            .map(function (b) {
              return "<li><span>" + b + "</span></li>";
            })
            .join("") +
          "</ul>";
      }
      if (step.callout) {
        html += '<div class="ho-callout">' + step.callout + "</div>";
      }
      if (stepComplete(step, live)) {
        html +=
          '<div class="ho-callout" style="background:var(--ho-green-soft);border-color:rgba(23,138,78,.22);color:var(--ho-green)"><b>Looks good on this step.</b> You can still add another login above, or continue.</div>';
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
        html +=
          '<button type="button" class="ho-btn ho-btn-primary" data-ho="cta" data-hash="' +
          esc(step.cta.hash) +
          '"' +
          (step.cta.openAr ? ' data-ar="1"' : "") +
          ">" +
          esc(step.cta.label) +
          "</button>";
      }
      html +=
        '<button type="button" class="ho-btn ho-btn-ghost" data-ho="next">Continue</button>';
      if (step.secondary && step.secondary.skip) {
        html +=
          '<button type="button" class="ho-btn ho-btn-text" data-ho="next">' +
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

  function goHash(hash, openAr) {
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
  }

  /** Close panel → pill stays for re-access (unless fully done). */
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
    probeLive().then(function () {
      // Auto-complete if required pillars are green
      if (requiredRemaining(state.live) === 0) {
        // Don't force done — let them mark done on finish screen; still show green pill
      }
      updatePill();
    });
  }

  function closeTourFinished() {
    markDone();
    minimizeTour();
    var pill = document.getElementById("hoPill");
    if (pill) pill.classList.remove("ho-pill-show");
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
      setMsg("✓ Saved — we’ll refresh this feed automatically.", true);
      btn.textContent = "✓ Saved";
      // Connecting… skeletons only for inverter portals (utility harvest is quieter)
      try {
        if (INVERTER_PENDING[provider] && window.__aoPendingFeeds) {
          window.__aoPendingFeeds.mark(provider, {
            label: label,
            note: "saved from hands-off setup",
          });
        }
      } catch (e) {}
      try {
        window.dispatchEvent(new Event("ao:vault-changed"));
      } catch (e) {}
      // Refresh live chips without full remount thrash
      setTimeout(function () {
        probeLive().then(function () {
          softUpdate();
          // softUpdate rewires the button — find it again and set "Save another"
          var root = document.getElementById("hoTour");
          var newBtn = root && root.querySelector(".ho-login-save");
          if (newBtn) {
            newBtn.disabled = false;
            newBtn.textContent = "Save another →";
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
      if (sel && userEl) {
        sel.addEventListener("change", function () {
          var opt = sel.options[sel.selectedIndex];
          var ph = opt && opt.getAttribute("data-ph");
          if (ph) userEl.placeholder = ph;
        });
      }
      var save = box.querySelector(".ho-login-save");
      if (save) {
        save.addEventListener("click", function () {
          saveLoginFromForm(box);
        });
      }
      // Enter in password field submits
      var pass = box.querySelector(".ho-login-pass");
      if (pass) {
        pass.addEventListener("keydown", function (e) {
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
          if (state.mode === "modal") minimizeTour();
          return;
        }
        if (act === "finish") {
          closeTourFinished();
          return;
        }
        if (act === "next") {
          if (state.idx < STEPS.length - 1) state.idx++;
          hardRender({ animate: false });
          return;
        }
        if (act === "back") {
          if (state.idx > 0) state.idx--;
          hardRender({ animate: false });
          return;
        }
        if (act === "cta") {
          var hash = btn.getAttribute("data-hash");
          var ar = btn.getAttribute("data-ar") === "1";
          if (state.mode === "modal") {
            markModalSeen();
            state.mode = "dock";
            hardRender({ animate: true });
          }
          goHash(hash, ar);
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

  async function openTour(opts) {
    opts = opts || {};
    // force: true bypasses complete flag (deep links / replay)
    if (!session()) {
      if (!opts.force && !queryWantsTour()) return;
      // wait briefly for session shim
      await new Promise(function (r) {
        setTimeout(r, 400);
      });
      if (!session() && !opts.force) return;
    }
    if (opts.mode === "modal" || opts.mode === "dock") {
      state.mode = opts.mode;
    } else if (modalAlreadySeen()) {
      state.mode = "dock";
    } else {
      state.mode = "modal";
    }
    if (opts.step != null) state.idx = opts.step;
    else if (!state.open) state.idx = 0;

    var firstPaint = !state.open;
    ensureRoot();
    ensurePill();
    await probeLive();
    hardRender({ animate: firstPaint });
    scheduleSoftProbe();
  }

  function tryAutoOpen(attempt) {
    attempt = attempt || 0;
    if (!shouldAutoOpen()) {
      // still show pill if signed in and incomplete
      if (session() && !isTourComplete()) probeLive().then(updatePill);
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
    scrubTourParams();
    // Explicit tour= always opens; prefer modal first time, dock after
    var forceModal = /[?&]tour=hands-off(&|$)/.test(location.search || "") || !modalAlreadySeen();
    // After scrub, search is gone — use whether modal was seen
    openTour({
      force: true,
      mode: modalAlreadySeen() ? "dock" : "modal",
    });
  }

  function boot() {
    window.__aoHandsOffTour = function (opts) {
      opts = opts || { force: true };
      if (!opts.mode) opts.mode = modalAlreadySeen() ? "dock" : "modal";
      openTour(opts);
    };
    window.__aoHandsOffTourProbe = probeLive;
    window.__aoHandsOffTourMinimize = minimizeTour;

    // Pill for incomplete signed-in accounts
    setTimeout(function () {
      if (!session() || isTourComplete()) return;
      probeLive().then(updatePill);
    }, 800);

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
