/* Resources briefing, New England edition (Ford 2026-07-10; REC market + daily data 2026-07-13).
 One shared module that BOTH the standalone resources.html AND the in-app #panelResources
 render from, so the state picker / per-state reference / REC market / location-filtered news
 live in a single place (the SPA panel strips resources.html's own inline scripts, so shared
 logic must be here).

 Data sources (refreshed daily by the news/resources curator):
 /news.json , live regulatory / rate-case headlines
 /resources-data.json , per-state net-metering briefing + REC market figures

 State detection: the operator's own arrays (their service-address state) → a remembered
 picker choice → Vermont. No external geo calls (the site CSP forbids them). Every figure
 is sourced + dated; always verify against the linked authority before relying on it.
 Array Operator's invoices bill from the offtaker's real settled-bill rate regardless. */
(function () {
 var ORDER = ["vt", "nh", "me", "ma", "ct", "ri"];

 // Embedded fallback so the panel still paints if resources-data.json fails to load.
 // The live file (public/resources-data.json) is the billing basis once fetched.
 var FALLBACK_STATES = {
 vt: {
 name: "Vermont",
 comp: "Blended residential ≈ $0.1839/kWh; Category I (≤15 kW) effective ≈ $0.1439/kWh after the Aug 1, 2026 siting charge rose 4¢ → 5¢.",
 how: "Rates are set by the PUC's biennial update; an array's rate locks ~10 years from its permit, then rolls to the blended rate. Small systems add +$0.01/kWh, or +$0.03/kWh if RECs go to the utility.",
 note: "Group / offsite (community) net metering is being phased out under H.289, existing arrays keep running.",
 utils: ["Green Mountain Power", "Vermont Electric Cooperative"],
 reg: "PUC Case 26-0291-INV, 2026 biennial update, order May 29, 2026 (the 7th consecutive Category I cut).",
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
 how: "The NEM 2.0 credit formula is locked through Jan 1, 2041 (Docket DE 16-576), unusually long-term stability for the region.",
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
 comp: "Net Energy Billing (NEB), 1:1 retail-rate credits for rooftop solar. CMP ≈ $0.27/kWh, Versant ≈ $0.32/kWh; credits roll monthly and true up annually.",
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
 comp: "1:1 retail-rate net metering for residential ≤ 25 kW (Class I), credits ≈ $0.2836/kWh (Eversource), ≈ $0.32/kWh (National Grid).",
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
 comp: "No net metering, the RRES Netting Tariff (PURA). Pick Netting (retail-rate credits, 20 yr) or Buy-All (fixed ≈ $0.3289/kWh for 2026 enrollments, 20 yr). Plus a +$0.0402/kWh Solar Energy Adjustment in 2026.",
 how: "Whichever option you choose at enrollment is locked for 20 years; Eversource and United Illuminating administer it identically.",
 note: "",
 utils: ["Eversource", "United Illuminating (UI)"],
 reg: "Public Utilities Regulatory Authority (PURA), RRES replaced net metering in 2022.",
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

 // Live data pack (states + rec_market). Populated by loadData(); falls back to embedded.
 var DATA = { updated: null, states: FALLBACK_STATES, rec_market: null };
 var dataPromise = null;

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
 function NE(k) { return (DATA.states && DATA.states[k]) || FALLBACK_STATES[k]; }

 // Which state to show: a remembered picker choice → the operator's own arrays (their
 // service-address state, in-app only) → Vermont. No external geo (blocked by the CSP).
 function detectState() {
 try { var saved = localStorage.getItem("ao_res_state"); if (saved && NE(saved)) return saved; } catch (e) {}
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

 function loadData() {
 if (dataPromise) return dataPromise;
 dataPromise = fetch("/resources-data.json?cb=" + Date.now())
 .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
 .then(function (d) {
 if (d && d.states && typeof d.states === "object") {
 // Merge so a partial daily update never blanks a known state.
 var merged = {};
 ORDER.forEach(function (k) {
 merged[k] = Object.assign({}, FALLBACK_STATES[k] || {}, d.states[k] || {});
 });
 DATA.states = merged;
 }
 if (d && d.rec_market) DATA.rec_market = d.rec_market;
 if (d && d.updated) DATA.updated = d.updated;
 return DATA;
 })
 .catch(function () {
 // Keep embedded fallback; don't break the panel.
 return DATA;
 });
 return dataPromise;
 }

 function pickerHTML(cur) {
 return '<div class="res-picker" role="group" aria-label="Choose your state">' +
 '<span class="res-picker-lab">Your state</span>' +
 ORDER.map(function (k) {
 var s = NE(k);
 return '<button type="button" class="res-state' + (k === cur ? " on" : "") +
 '" data-state="' + k + '">' + esc(s ? s.name : k.toUpperCase()) + "</button>";
 }).join("") + "</div>";
 }

 function srcLinks(list) {
 return (list || []).map(function (x) {
 return '<a href="' + esc(x.u) + '" target="_blank" rel="noopener">' + esc(x.l) + " ↗</a>";
 }).join("");
 }

 function refHTML(k) {
 var s = NE(k);
 if (!s) return "";
 var utils = (s.utils || []).map(function (u) { return '<span class="res-util">' + esc(u) + "</span>"; }).join("");
 var srcs = srcLinks(s.sources);
 return '<section>' +
 '<h2>' + esc(s.name) + " net-metering, at a glance</h2>" +
 '<div class="card">' +
 '<div class="res-comp">' + esc(s.comp) + "</div>" +
 "<p>" + esc(s.how) + "</p>" +
 (s.note ? '<div class="res-note">' + esc(s.note) + "</div>" : "") +
 '<div class="res-kv"><span class="res-k">Key utilities</span><div class="res-utils">' + utils + "</div></div>" +
 '<div class="res-kv"><span class="res-k">Regulatory status</span><p class="res-reg">' + esc(s.reg) + "</p></div>" +
 "</div>" +
 '<div class="disc">Reference only, always confirm the current figure against the utility’s filed tariff or the offtaker’s bill before relying on it. Array Operator’s invoices already read the bill’s own rate.</div>' +
 "</section>" +
 '<section><h2>Go to the source</h2><div class="card"><div class="srcs">' + srcs + "</div></div></section>";
 }

 // Renewable Energy Credits market, region strip + per-state owner path.
 function recHTML(k) {
 var m = DATA.rec_market;
 var s = NE(k);
 var rec = (s && s.rec) || null;
 if (!m && !rec) return "";

 var asOf = (m && m.as_of) || DATA.updated || "";
 var classI = (m && m.class_i) || {};
 var price = (rec && rec.price_display) || classI.price_display || "—";
 var headline = (m && m.headline) || "Renewable Energy Credits";

 var products = ((m && m.products) || []).map(function (p) {
 return '<div class="res-rec-prod">' +
 '<div class="res-rec-prod-name">' + esc(p.name) + "</div>" +
 '<div class="res-rec-prod-price">' + esc(p.price_display || "—") + "</div>" +
 (p.note ? '<div class="res-rec-prod-note">' + esc(p.note) + "</div>" : "") +
 "</div>";
 }).join("");

 var stateBlock = "";
 if (rec) {
 stateBlock =
 '<div class="res-kv"><span class="res-k">' + esc((s && s.name) || k.toUpperCase()) + ", your path</span>" +
 '<p class="res-reg"><strong>' + esc(rec.program || "REC program") + "</strong></p>" +
 (rec.owner_path ? "<p>" + esc(rec.owner_path) + "</p>" : "") +
 (rec.how ? "<p>" + esc(rec.how) + "</p>" : "") +
 (rec.acp_or_cap ? '<p class="muted" style="margin-top:6px">Ceiling / ACP: ' + esc(rec.acp_or_cap) + "</p>" : "") +
 "</div>";
 }

 var marketSrcs = srcLinks((rec && rec.sources && rec.sources.length ? rec.sources : null) || (m && m.sources) || []);

 return '<section class="res-rec-sec">' +
 "<h2>" + esc(headline) +
 (asOf ? ' <span class="res-rec-asof">as of ' + esc(asOf) + "</span>" : "") +
 "</h2>" +
 '<div class="card res-rec-card">' +
 '<div class="res-rec-hero">' +
 '<div class="res-rec-price-block">' +
 '<div class="res-rec-price-lab">Indicative Class I</div>' +
 '<div class="res-rec-price">' + esc(price) + "</div>" +
 '<div class="res-rec-price-sub">' + esc(classI.label || "NEPOOL-GIS tracked") + "</div>" +
 "</div>" +
 '<div class="res-rec-blurb">' +
 (m && m.summary ? "<p>" + esc(m.summary) + "</p>" : "") +
 (classI.mint_lag ? '<p class="muted">Mint lag: ' + esc(classI.mint_lag) + "</p>" : "") +
 (classI.note ? '<div class="res-note" style="margin-top:10px">' + esc(classI.note) + "</div>" : "") +
 "</div>" +
 "</div>" +
 (products ? '<div class="res-rec-prods">' + products + "</div>" : "") +
 stateBlock +
 (m && m.operator_tip ? '<div class="res-note" style="margin-top:14px">' + esc(m.operator_tip) + "</div>" : "") +
 (marketSrcs ? '<div class="res-kv" style="margin-top:14px"><span class="res-k">Market sources</span><div class="srcs">' + marketSrcs + "</div></div>" : "") +
 "</div>" +
 '<div class="disc">REC prices are broker-quoted ranges, not executable bids. Who owns the certificates on your arrays depends on the program (net metering, SMART, REG, PPA). Confirm before you count the dollars.</div>' +
 "</section>";
 }

 // News feed: show items tagged for the selected state, plus region-wide ("region"/"ne")
 // and untagged legacy items. Newest first.
 function loadFeed(k, feedEl, metaEl) {
 if (!feedEl) return;
 fetch("/news.json?cb=" + Date.now()).then(function (r) { return r.json(); }).then(function (data) {
 var all = (data && data.items) || [];
 // STRICTLY the operator's OWN state + genuinely New-England-wide items (ISO-NE,
 // federal, region tags). Other states' state-specific headlines never appear here:
 // a New Hampshire operator sees New Hampshire (and region-wide) news, not Vermont's
 // (Ford 2026-07-11). NO all-states fallback, an honest empty beats a misleading
 // dump of another state's rate cases under your state's briefing.
 var items = all.filter(function (it) {
 var st = (it.state || "").toLowerCase();
 return !st || st === k || st === "region" || st === "ne" || st === "all" || st === "rec";
 });
 items.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
 var stateName = (NE(k) && NE(k).name) || "your state";
 if (metaEl) {
 if (!items.length) {
 metaEl.innerHTML = "We're tracking " + esc(stateName) + "'s utility-commission dockets, rate cases, and REC market moves, no " +
 esc(stateName) + " headlines yet. Nothing here means nothing has changed for your " + esc(stateName) + " arrays.";
 } else {
 var updatedBits = [];
 if (data.updated) updatedBits.push("news " + fmtDate(data.updated));
 if (DATA.updated) updatedBits.push("state/REC data " + fmtDate(DATA.updated));
 metaEl.innerHTML = (updatedBits.length ? "Updated " + esc(updatedBits.join(" · ")) + " · " : "") +
 items.length + " update" + (items.length === 1 ? "" : "s") + " for " + esc(stateName) +
 ' <span class="res-daily-pill">daily refresh</span>';
 }
 }
 if (!items.length) {
 feedEl.innerHTML = '<div class="disc">Nothing to report for ' + esc(stateName) +
 ' right now. We watch the public commission dockets, REC market, and reporting daily and will surface any ' +
 esc(stateName) + ' rate case, net-metering change, REC move, or filing deadline here the moment it moves.</div>';
 return;
 }
 feedEl.innerHTML = items.map(function (it) {
 var alert = /rule|cut|phase|deadline|case|alert/i.test((it.tag || "") + " " + (it.title || ""));
 var stc = (it.state || "").toLowerCase();
 // Only region-wide / REC-market items get a chip (to read as New-England-wide
 // context, not your state), the operator's own-state items need no chip.
 var isRegional = (stc === "region" || stc === "ne" || stc === "all" || stc === "rec");
 var stChip = isRegional
 ? '<span class="res-stchip">' + (stc === "rec" ? "REC market" : "New England") + "</span>"
 : "";
 return '<div class="item"><div class="when">' + esc(fmtDate(it.date)) + "</div><div>" +
 stChip +
 '<span class="tag' + (alert ? " alert" : "") + '">' + esc(it.tag || "Update") + "</span>" +
 "<h4>" + esc(it.title) + "</h4>" +
 (it.summary ? "<p>" + esc(it.summary) + "</p>" : "") +
 (it.url ? '<div class="src"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' +
 esc(it.source || "Read more") + " ↗</a></div>" : "") +
 "</div></div>";
 }).join("");
 }).catch(function () {
 if (metaEl) metaEl.textContent = "Couldn’t load the latest updates right now, see the sources below.";
 });
 }

 function bodyHTML(k) {
 return '<section>' +
 '<div class="newshead"><h2 style="margin-bottom:0">Latest &amp; live <span class="livedot"><i></i>daily</span></h2></div>' +
 '<p class="muted" id="resNewsMeta" style="margin:8px 0 2px">Loading the latest…</p>' +
 '<div class="feed" id="resFeed"></div></section>' +
 recHTML(k) +
 refHTML(k);
 }

 function render(host, k) {
 var app = host.querySelector("#resApp");
 if (!app) return;
 app.innerHTML = pickerHTML(k) + '<div id="resBody">' + bodyHTML(k) + "</div>";
 app.querySelectorAll("[data-state]").forEach(function (b) {
 b.onclick = function () {
 var ns = b.getAttribute("data-state");
 if (!NE(ns)) return;
 try { localStorage.setItem("ao_res_state", ns); } catch (e) {}
 render(host, ns);
 };
 });
 loadFeed(k, host.querySelector("#resFeed"), host.querySelector("#resNewsMeta"));
 // Title carries the state; the old grandiose eyebrow is gone (see resources.html).
 // Kept tolerant of both: an older cached shell may still have #resEyebrow.
 var title = host.querySelector("#resTitle");
 if (title) title.textContent = "What’s happening in " + ((NE(k) && NE(k).name) || "New England");
 var eb = host.querySelector("#resEyebrow");
 if (eb) eb.remove();
 }

 // Styles for the NEW bits (picker + per-state reference + REC market cards). Injected once
 // so BOTH the standalone page and the in-app panel get them without maintaining CSS in two
 // files. Shared .card/.feed/.item/.disc/table classes are already styled by page/panel sheets.
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
 '.res-reg{margin:0;font-size:13.5px;color:var(--muted,#475569);line-height:1.55}' +
 '.res-stchip{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;' +
 'padding:2px 8px;border-radius:6px;margin:6px 8px 0 0;vertical-align:middle;' +
 'background:rgba(15,23,42,.06);color:var(--muted,#475569)}' +
 '.res-daily-pill{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;' +
 'padding:2px 7px;border-radius:999px;margin-left:6px;vertical-align:middle;' +
 'background:var(--livebg,#ecfdf5);color:var(--live,#059669);border:1px solid #a7f3d0}' +
 '.res-rec-asof{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:none;color:var(--faint,#94a3b8);margin-left:8px}' +
 '.res-rec-hero{display:grid;grid-template-columns:minmax(140px,200px) 1fr;gap:18px;align-items:start}' +
 '@media(max-width:560px){.res-rec-hero{grid-template-columns:1fr;gap:12px}}' +
 '.res-rec-price-block{background:linear-gradient(165deg,rgba(5,150,105,.12),rgba(5,150,105,.04));' +
 'border:1px solid rgba(5,150,105,.22);border-radius:12px;padding:14px 16px;text-align:center}' +
 '.res-rec-price-lab{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--live,#059669)}' +
 '.res-rec-price{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--ink,#0f172a);margin:6px 0 4px;line-height:1.15}' +
 '.res-rec-price-sub{font-size:11.5px;color:var(--muted,#475569);line-height:1.35}' +
 '.res-rec-blurb p{margin:.35em 0;font-size:13.5px;line-height:1.55}' +
 '.res-rec-prods{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:16px 0 4px}' +
 '.res-rec-prod{border:1px solid var(--line,#e2e8f0);border-radius:10px;padding:11px 13px;background:rgba(15,23,42,.02)}' +
 '.res-rec-prod-name{font-size:12.5px;font-weight:700;color:var(--ink,#0f172a)}' +
 '.res-rec-prod-price{font-size:13.5px;font-weight:700;color:var(--live,#059669);margin:4px 0 6px}' +
 '.res-rec-prod-note{font-size:12px;color:var(--muted,#475569);line-height:1.45}';

 function injectStyles() {
 if (document.getElementById("ao-res-styles")) return;
 var st = document.createElement("style");
 st.id = "ao-res-styles";
 st.textContent = STYLES;
 document.head.appendChild(st);
 }

 // mount(host): host must contain a `#resEyebrow` (hero label) + a `#resApp` container.
 // Loads resources-data.json first so REC market + any daily state edits paint immediately.
 window.AOResources = {
 mount: function (host) {
 if (!host || !host.querySelector("#resApp")) return;
 injectStyles();
 var k = detectState();
 // Paint fallback shell immediately, then re-render once live data arrives.
 render(host, k);
 loadData().then(function () {
 // Re-render with live state/REC data (same selected state).
 var cur = detectState();
 render(host, cur);
 });
 }
 };
})();
