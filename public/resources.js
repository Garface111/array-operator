/* Resources briefing — New England edition (Ford 2026-07-10). One shared module that
   BOTH the standalone resources.html AND the in-app #panelResources render from, so the
   state picker / per-state reference / location-filtered news live in a single place
   (the SPA panel strips resources.html's own inline scripts, so shared logic must be here).

   State detection: the operator's own arrays (their service-address state) → a remembered
   picker choice → Vermont. No external geo calls (the site CSP forbids them). Every figure
   below is sourced + dated; always verify against the linked authority before relying on it.
   Array Operator's invoices bill from the offtaker's real settled-bill rate regardless. */
(function () {
  var ORDER = ["vt", "nh", "me", "ma", "ct", "ri"];
  var NE = {
    vt: {
      name: "Vermont",
      comp: "Blended residential ≈ $0.1839/kWh; Category I (≤15 kW) effective ≈ $0.1439/kWh after the Aug 1, 2026 siting charge rose 4¢ → 5¢.",
      how: "Rates are set by the PUC's biennial update; an array's rate locks ~10 years from its permit, then rolls to the blended rate. Small systems add +$0.01/kWh, or +$0.03/kWh if RECs go to the utility.",
      note: "Group / offsite (community) net metering is being phased out under H.289 — existing arrays keep running.",
      utils: ["Green Mountain Power", "Vermont Electric Cooperative"],
      reg: "PUC Case 26-0291-INV — 2026 biennial update, order May 29, 2026 (the 7th consecutive Category I cut).",
      sources: [
        { l: "Vermont PUC · Net-Metering", u: "https://puc.vermont.gov/electric/net-metering" },
        { l: "ePUC · case filings", u: "https://epuc.vermont.gov/" },
        { l: "Dept. of Public Service", u: "https://publicservice.vermont.gov/renewables" },
        { l: "Renewable Energy Vermont", u: "https://www.revermont.org/" }
      ]
    },
    nh: {
      name: "New Hampshire",
      comp: "NEM 2.0 credits exports at ≈ 85% of retail (100% of supply + transmission + 25% of distribution). Eversource retail ≈ $0.25/kWh.",
      how: "The NEM 2.0 credit formula is locked through Jan 1, 2041 (Docket DE 16-576) — unusually long-term stability for the region.",
      note: "",
      utils: ["Eversource", "Liberty Utilities", "New Hampshire Electric Cooperative", "Unitil"],
      reg: "NH PUC affirmed the Eversource rate case (monthly customer charge ≈ $14 → $19.81, ROE 9.5%) but threw out automatic annual increases; a 2026 docket will examine alternative regulation.",
      sources: [
        { l: "NH PUC", u: "https://www.puc.nh.gov/" },
        { l: "NH Dept. of Energy", u: "https://www.energy.nh.gov/" },
        { l: "Office of the Consumer Advocate", u: "https://www.oca.nh.gov/" }
      ]
    },
    me: {
      name: "Maine",
      comp: "Net Energy Billing (NEB) — 1:1 retail-rate credits for rooftop solar. CMP ≈ $0.27/kWh, Versant ≈ $0.32/kWh; credits roll monthly and true up annually.",
      how: "Rooftop NEB is protected; LD 1777 reformed only community-solar NEB (slowing its cost growth), with a successor program to be designed in 2026.",
      note: "",
      utils: ["Central Maine Power (CMP)", "Versant Power"],
      reg: "Maine PUC (MPUC). LD 1792 reversed a 2025 cost-allocation increase; tariff rates are set through 2046 (Dockets 2019-00197, 2022-00185).",
      sources: [
        { l: "Maine PUC · Net Energy Billing", u: "https://www.maine.gov/mpuc/regulated-utilities/electricity/neb" },
        { l: "Maine PUC", u: "https://www.maine.gov/mpuc/" }
      ]
    },
    ma: {
      name: "Massachusetts",
      comp: "1:1 retail-rate net metering for residential ≤ 25 kW (Class I) — credits ≈ $0.2836/kWh (Eversource), ≈ $0.32/kWh (National Grid).",
      how: "On top of net metering, SMART 3.0 (PY2026) pays a flat $0.03/kWh incentive (residential ≤ 25 kW; $0.06/kWh low-income).",
      note: "",
      utils: ["Eversource", "National Grid", "Unitil"],
      reg: "MA Dept. of Public Utilities (DPU); the SMART incentive is administered by DOER.",
      sources: [
        { l: "MA DPU", u: "https://www.mass.gov/orgs/department-of-public-utilities" },
        { l: "SMART Program (DOER)", u: "https://www.mass.gov/info-details/solar-massachusetts-renewable-target-smart-program" }
      ]
    },
    ct: {
      name: "Connecticut",
      comp: "No net metering — the RRES Netting Tariff (PURA). Pick Netting (retail-rate credits, 20 yr) or Buy-All (fixed ≈ $0.3289/kWh for 2026 enrollments, 20 yr). Plus a +$0.0402/kWh Solar Energy Adjustment in 2026.",
      how: "Whichever option you choose at enrollment is locked for 20 years; Eversource and United Illuminating administer it identically.",
      note: "",
      utils: ["Eversource", "United Illuminating (UI)"],
      reg: "Public Utilities Regulatory Authority (PURA) — RRES replaced net metering in 2022.",
      sources: [
        { l: "CT PURA", u: "https://portal.ct.gov/pura" },
        { l: "Office of Consumer Counsel", u: "https://portal.ct.gov/occ" }
      ]
    },
    ri: {
      name: "Rhode Island",
      comp: "Net metering ≈ 80% of retail (≈ $0.232/kWh) for new systems, 125% annual cap, protected through 2039. The separate REG program pays ≈ $0.2723/kWh for 15 years.",
      how: "Net metering credits your excess up to 125% of on-site use; the Renewable Energy Growth (REG) program pays a fixed rate for all production instead.",
      note: "The OER and PUC are reviewing both programs; a CRNM v2 community-solar tier (40 MW cap) is expected in 2026–2027.",
      utils: ["Rhode Island Energy"],
      reg: "RI PUC + Office of Energy Resources (OER).",
      sources: [
        { l: "RI PUC", u: "https://ripuc.ri.gov/" },
        { l: "Office of Energy Resources", u: "https://energy.ri.gov/renewable-energy/net-metering" }
      ]
    }
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtDate(iso) {
    try {
      return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) { return iso; }
  }

  // Which state to show: a remembered picker choice → the operator's own arrays (their
  // service-address state, in-app only) → Vermont. No external geo (blocked by the CSP).
  function detectState() {
    try { var saved = localStorage.getItem("ao_res_state"); if (saved && NE[saved]) return saved; } catch (e) {}
    try {
      if (window.FleetStore && FleetStore.snapshot) {
        var arrs = (FleetStore.snapshot().arrays) || [];
        var counts = {};
        arrs.forEach(function (a) {
          var addr = ((a && (a.service_address || a.address || a.nickname)) || "") + "";
          var m = addr.match(/(?:^|[\s,])(VT|NH|ME|MA|CT|RI)(?:[\s,]|$)/);
          if (m) { var st = m[1].toLowerCase(); counts[st] = (counts[st] || 0) + 1; }
        });
        var best = null, bn = 0;
        Object.keys(counts).forEach(function (k) { if (counts[k] > bn) { bn = counts[k]; best = k; } });
        if (best) return best;
      }
    } catch (e) {}
    return "vt";
  }

  function pickerHTML(cur) {
    return '<div class="res-picker" role="group" aria-label="Choose your state">' +
      '<span class="res-picker-lab">Your state</span>' +
      ORDER.map(function (k) {
        return '<button type="button" class="res-state' + (k === cur ? " on" : "") +
          '" data-state="' + k + '">' + esc(NE[k].name) + "</button>";
      }).join("") + "</div>";
  }

  function refHTML(k) {
    var s = NE[k];
    var utils = s.utils.map(function (u) { return '<span class="res-util">' + esc(u) + "</span>"; }).join("");
    var srcs = s.sources.map(function (x) {
      return '<a href="' + esc(x.u) + '" target="_blank" rel="noopener">' + esc(x.l) + " ↗</a>";
    }).join("");
    return '<section>' +
      '<h2>' + esc(s.name) + " net-metering — at a glance</h2>" +
      '<div class="card">' +
      '<div class="res-comp">' + esc(s.comp) + "</div>" +
      "<p>" + esc(s.how) + "</p>" +
      (s.note ? '<div class="res-note">' + esc(s.note) + "</div>" : "") +
      '<div class="res-kv"><span class="res-k">Key utilities</span><div class="res-utils">' + utils + "</div></div>" +
      '<div class="res-kv"><span class="res-k">Regulatory status</span><p class="res-reg">' + esc(s.reg) + "</p></div>" +
      "</div>" +
      '<div class="disc">Reference only — always confirm the current figure against the utility’s filed tariff or the offtaker’s bill before relying on it. Array Operator’s invoices already read the bill’s own rate.</div>' +
      "</section>" +
      '<section><h2>Go to the source</h2><div class="card"><div class="srcs">' + srcs + "</div></div></section>";
  }

  // News feed: show items tagged for the selected state, plus region-wide ("region"/"ne")
  // and untagged legacy items. Newest first.
  function loadFeed(k, feedEl, metaEl) {
    if (!feedEl) return;
    fetch("/news.json?cb=" + Date.now()).then(function (r) { return r.json(); }).then(function (data) {
      var items = ((data && data.items) || []).filter(function (it) {
        var st = (it.state || "").toLowerCase();
        return !st || st === k || st === "region" || st === "ne" || st === "all";
      });
      items.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
      if (metaEl) {
        metaEl.innerHTML = items.length
          ? "Last updated " + esc(fmtDate(data.updated || items[0].date)) + " · " + items.length +
            " item" + (items.length === 1 ? "" : "s") + " for " + esc(NE[k].name)
          : "No " + esc(NE[k].name) + " updates yet — check back soon.";
      }
      feedEl.innerHTML = items.map(function (it) {
        var alert = /rule|cut|phase|deadline|case|alert/i.test((it.tag || "") + " " + (it.title || ""));
        return '<div class="item"><div class="when">' + esc(fmtDate(it.date)) + "</div><div>" +
          '<span class="tag' + (alert ? " alert" : "") + '">' + esc(it.tag || "Update") + "</span>" +
          "<h4>" + esc(it.title) + "</h4>" +
          (it.summary ? "<p>" + esc(it.summary) + "</p>" : "") +
          (it.url ? '<div class="src"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' +
            esc(it.source || "Read more") + " ↗</a></div>" : "") +
          "</div></div>";
      }).join("");
    }).catch(function () {
      if (metaEl) metaEl.textContent = "Couldn’t load the latest updates right now — see the sources below.";
    });
  }

  function bodyHTML(k) {
    return '<section>' +
      '<div class="newshead"><h2 style="margin-bottom:0">Latest &amp; live <span class="livedot"><i></i>updating</span></h2></div>' +
      '<p class="muted" id="resNewsMeta" style="margin:8px 0 2px">Loading the latest…</p>' +
      '<div class="feed" id="resFeed"></div></section>' +
      refHTML(k);
  }

  function render(host, k) {
    var app = host.querySelector("#resApp");
    if (!app) return;
    app.innerHTML = pickerHTML(k) + '<div id="resBody">' + bodyHTML(k) + "</div>";
    app.querySelectorAll("[data-state]").forEach(function (b) {
      b.onclick = function () {
        var ns = b.getAttribute("data-state");
        if (!NE[ns]) return;
        try { localStorage.setItem("ao_res_state", ns); } catch (e) {}
        render(host, ns);
      };
    });
    loadFeed(k, host.querySelector("#resFeed"), host.querySelector("#resNewsMeta"));
    var eb = host.querySelector("#resEyebrow");
    if (eb) eb.textContent = "The " + NE[k].name + " solar operator’s briefing";
  }

  // Styles for the NEW bits (picker + per-state reference cards). Injected once so BOTH the
  // standalone page and the in-app panel get them without maintaining CSS in two files. The
  // shared .card/.feed/.item/.disc/table classes are already styled by the page/panel sheets.
  var STYLES = '' +
    '.res-picker{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 22px}' +
    '.res-picker-lab{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint,#94a3b8);margin-right:4px}' +
    '.res-state{font-size:13px;font-weight:600;padding:7px 14px;border-radius:999px;cursor:pointer;' +
      'border:1px solid var(--line,#e2e8f0);background:var(--card,#fff);color:var(--muted,#475569);' +
      'font-family:inherit;transition:border-color .12s,color .12s,background .12s}' +
    '.res-state:hover{border-color:var(--good,#2563eb);color:var(--good,#2563eb)}' +
    '.res-state.on{background:var(--good,#2563eb);border-color:var(--good,#2563eb);color:#fff}' +
    '.res-comp{font-size:15px;font-weight:600;color:var(--ink,#0f172a);line-height:1.5;' +
      'padding:12px 14px;border-radius:10px;background:var(--tint,#eff6ff);border:1px solid var(--tintln,#bfdbfe);margin:0 0 12px}' +
    '.res-note{font-size:13px;color:var(--amber,#b45309);background:var(--amberbg,#fff7ed);' +
      'border:1px solid var(--amberln,#fed7aa);border-radius:10px;padding:10px 13px;margin:10px 0 2px;line-height:1.5}' +
    '.res-kv{margin-top:13px}' +
    '.res-k{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint,#94a3b8);margin-bottom:6px}' +
    '.res-utils{display:flex;flex-wrap:wrap;gap:8px}' +
    '.res-util{font-size:12.5px;font-weight:600;color:var(--ink,#0f172a);background:rgba(15,23,42,.05);border-radius:8px;padding:5px 11px}' +
    '.res-reg{margin:0;font-size:13.5px;color:var(--muted,#475569);line-height:1.55}';

  function injectStyles() {
    if (document.getElementById("ao-res-styles")) return;
    var st = document.createElement("style");
    st.id = "ao-res-styles";
    st.textContent = STYLES;
    document.head.appendChild(st);
  }

  // mount(host): host must contain a `#resEyebrow` (hero label) + a `#resApp` container.
  window.AOResources = {
    mount: function (host) {
      if (!host || !host.querySelector("#resApp")) return;
      injectStyles();
      render(host, detectState());
    }
  };
})();
