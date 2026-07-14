/* ============================================================================
 * Hands-Off Walkthrough — post-onboarding product tour
 * Shows after first onboarding lands on the real site (?fresh=1 / ?tour=hands-off).
 * Goal: make "set and forget" concrete — cloud auto-refresh, utility bills,
 * offtakers — with a beautiful sky-glass UI and live completion chips.
 * ========================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "ao_hands_off_tour";
  var DISMISS_KEY = "ao_hands_off_tour_dismiss";

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
      title: "Turn on 24/7 auto-refresh",
      lede:
        "This is the difference between “I have an account” and “it runs without me.” Choose <b>Store it with us</b> so passwords stay encrypted on our servers and we harvest around the clock.",
      kind: "step",
      bullets: [
        "Account → <b>Auto-refresh</b> → <b>Store it with us — live data</b>.",
        "Save logins for every inverter portal and utility you use (GMP, co-ops, etc.).",
        "Prefer passwords only on your PC? Device mode works — but needs a browser open. Cloud is true hands-off.",
      ],
      callout:
        "<b>Hands-off rule:</b> if a login isn’t saved here, that feed only updates when someone opens the portal manually.",
      cta: { label: "Set up Auto-refresh →", hash: "#account", openAr: true },
      statusKey: "autorefresh",
    },
    {
      id: "utility",
      rail: "Utility bills",
      railSub: "Invoice source of truth",
      kicker: "Step 3 of 4 · Settlement",
      title: "Link utility bills",
      lede:
        "Offtaker invoices are priced from utility paper bills — never from inverter guesswork. Connect GMP (or your co-op) so periods settle automatically.",
      kind: "step",
      bullets: [
        "Same Auto-refresh vault: add your utility portal login under cloud capture.",
        "Or use <b>Link utility bills</b> from the Invoices toolbar.",
        "You’ll see “✓ N bill sources” when bills are flowing — that’s the green light for invoicing.",
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
    idx: 0,
    live: {
      arrays: null,
      cloud: null,
      deviceMode: null,
      utilities: null,
      offtakers: null,
    },
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

  function shouldAutoOpen() {
    if (!session()) return false;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return false;
      if (localStorage.getItem(STORAGE_KEY) === "done") return false;
    } catch (e) {}
    var q = location.search || "";
    if (/[?&]tour=hands-off(&|$)/.test(q)) return true;
    if (/[?&]fresh=1(&|$)/.test(q)) return true;
    if (/[?&]setup=autorefresh(&|$)/.test(q)) return true;
    return false;
  }

  function scrubTourParams() {
    try {
      var u = new URL(location.href);
      var changed = false;
      ["tour", "fresh", "setup"].forEach(function (k) {
        if (u.searchParams.has(k)) {
          // keep setup=autorefresh intent by opening AR when we land — still scrub fresh/tour noise
          if (k === "setup" && u.searchParams.get(k) === "autorefresh") return;
          u.searchParams.delete(k);
          changed = true;
        }
      });
      // Always drop fresh=1 after we've consumed it
      if (u.searchParams.has("fresh")) {
        u.searchParams.delete("fresh");
        changed = true;
      }
      if (u.searchParams.has("tour")) {
        u.searchParams.delete("tour");
        changed = true;
      }
      if (changed) {
        history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
      }
    } catch (e) {}
  }

  function markDone() {
    try {
      localStorage.setItem(STORAGE_KEY, "done");
    } catch (e) {}
  }

  function markDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
      localStorage.setItem(STORAGE_KEY, "done");
    } catch (e) {}
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
    // offtakers optional for pure monitors — weight first 3 heavier in display
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
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Hands-off setup walkthrough");
    document.body.appendChild(el);
    return el;
  }

  function render() {
    var root = ensureRoot();
    var step = STEPS[state.idx] || STEPS[0];
    var live = state.live || {};
    var pct = progressPct(live);

    var rail = STEPS.map(function (s, i) {
      var done = stepComplete(s, live) || (s.id === "done" && pct >= 75);
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

    var body = renderBody(step, live);

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
      '<div class="ho-score-copy"><b>Hands-off readiness</b><span>Live check of your feeds</span></div>' +
      "</div>" +
      '<div class="ho-steps" role="tablist">' +
      rail +
      "</div>" +
      '<div class="ho-rail-foot">Takes ~5 minutes. You can reopen anytime from Account.</div>' +
      "</aside>" +
      '<section class="ho-main">' +
      '<button type="button" class="ho-close" data-ho="close" aria-label="Close">×</button>' +
      body +
      "</section></div>";

    root.hidden = false;
    requestAnimationFrame(function () {
      root.classList.add("ho-open");
    });
    state.open = true;
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
          '<div class="ho-callout" style="background:var(--ho-green-soft);border-color:rgba(23,138,78,.22);color:var(--ho-green)"><b>Looks good on this step.</b> You can still review the screen, or continue.</div>';
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
        '<button type="button" class="ho-btn ho-btn-text" data-ho="dismiss">Explore on my own</button>';
    } else if (step.kind === "done") {
      html +=
        '<button type="button" class="ho-btn ho-btn-primary" data-ho="finish">Enter dashboard →</button>';
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

  function closeTour(permanent) {
    var root = document.getElementById("hoTour");
    if (!root) return;
    root.classList.remove("ho-open");
    setTimeout(function () {
      root.hidden = true;
      root.innerHTML = "";
    }, 280);
    state.open = false;
    if (permanent) markDone();
  }

  function wire(root) {
    root.querySelectorAll("[data-idx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.idx = parseInt(btn.getAttribute("data-idx"), 10) || 0;
        render();
      });
    });
    root.querySelectorAll("[data-ho]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var act = btn.getAttribute("data-ho");
        if (act === "close" || act === "backdrop") {
          // backdrop soft-dismiss without permanent? permanent for close X after welcome
          if (act === "backdrop") return; // require explicit close — less accidental
          markDismissed();
          closeTour(true);
          return;
        }
        if (act === "dismiss") {
          markDismissed();
          closeTour(true);
          return;
        }
        if (act === "finish") {
          markDone();
          closeTour(true);
          return;
        }
        if (act === "next") {
          if (state.idx < STEPS.length - 1) state.idx++;
          render();
          return;
        }
        if (act === "back") {
          if (state.idx > 0) state.idx--;
          render();
          return;
        }
        if (act === "cta") {
          var hash = btn.getAttribute("data-hash");
          var ar = btn.getAttribute("data-ar") === "1";
          // Stay open so they can continue after doing the action — or soft-minimize
          goHash(hash, ar);
          // Advance to next so returning feels progressive
          if (state.idx < STEPS.length - 1) {
            setTimeout(function () {
              state.idx++;
              probeLive().then(render);
            }, 400);
          }
        }
      });
    });
  }

  async function openTour(opts) {
    opts = opts || {};
    if (!session() && !opts.force) return;
    state.idx = opts.step != null ? opts.step : 0;
    ensureRoot();
    await probeLive();
    render();
    // refresh live status once more after fleet store may load
    setTimeout(function () {
      if (!state.open) return;
      probeLive().then(function () {
        if (state.open) render();
      });
    }, 1800);
  }

  function boot() {
    // Expose for Account deep-link / Energy Agent
    window.__aoHandsOffTour = function (opts) {
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch (e) {}
      openTour(opts || { force: true });
    };
    window.__aoHandsOffTourProbe = probeLive;

    if (!shouldAutoOpen()) return;
    // Wait a beat for session + sky paint + fleet cache
    setTimeout(function () {
      if (!session()) return;
      scrubTourParams();
      openTour();
    }, 700);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
