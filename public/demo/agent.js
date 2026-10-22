/* ============================================================================
 * Energy Agent on the sample account (demo/agent.js)
 *
 * Signed out, energy-agent.js runs its normal path: POST /session for a fresh
 * conversation, then every turn POSTs /chat-stream and parses the NDJSON wire
 * format the backend emits (energy_agent.py chat_stream): {"type":"ping"}
 * heartbeats, then ONE {"type":"done","payload":{...}} whose payload is exactly
 * what /chat returns. These routes answer that path with scripted replies that
 * are grounded in the live sample data, so every number ties out with the tabs:
 *   FleetStore.snapshot()          status, peer index, 14-day kWh, live watts (Fleet)
 *   GET /v1/array-owners/ops       the repair book: cases, stages, contacts (Repairs)
 *   GET .../billing/send-pipeline  last cycle, queue, next run (Statements)
 *   GET .../billing/portfolio-gains  per-offtaker last statement (Statements)
 *   AO_DEMO                        offtakers, drafts, credit rate
 *   AO_DEMO_API.monthly()          24 settled months per array (Analysis)
 * The three GETs go through the same demo-api.js shim the tabs use, so the
 * agent can never disagree with them. No LLM is called and nothing is stored
 * server-side: each page load starts a fresh sample session and the memory
 * below lives only in this tab. Replies draft and explain; they never claim an
 * action happened (nothing can be sent, opened or changed in the sample).
 * ==========================================================================*/
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  var WINDOW_DAYS = 14;               // FleetStore / peer_analysis window
  var UNDERPERF_PI = 0.85;            // FleetStore healthy cut-off
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var VENDOR = { solaredge: "SolarEdge", fronius: "Fronius", sma: "SMA", chint: "Chint",
    locus: "Locus", alsoenergy: "AlsoEnergy", enphase: "Enphase" };
  var UTIL = { gmp: "GMP", vec: "VEC", wec: "WEC", eversource: "Eversource", cmp: "CMP" };
  // Short names people actually type ("north branch", "ferry"), by array name.
  var ALIASES = {
    "Birch Hollow": ["birch"], "Kettle Pond": ["kettle"], "Sawmill Ridge": ["sawmill"],
    "Heron Flats": ["heron"], "Cobble Hill": ["cobble"], "Maple Run Commons": ["maple run"],
    "Fox Meadow": ["fox meadow"], "North Branch Ridge": ["north branch"],
    "Granite Notch": ["granite"], "Old Mill Village": ["old mill"], "Long Pasture": ["long pasture"],
    "Blue Spruce Common": ["blue spruce"], "Riverbend School": ["riverbend"],
    "Clover Flats": ["clover"], "Hilltop Dairy": ["hilltop"], "Rail Yard": ["rail yard"],
    "Ferry Crossing": ["ferry"], "Elm Meadows": ["elm meadow"], "Harbor Landing": ["harbor"],
    "Pine Commons": ["pine common"],
  };
  // Used only if the Repairs routes didn't load: the sample's default contact.
  var FALLBACK_CONTACT = { name: "Marcus Hale", company: "Ridgeline Electric", email: "marcus@ridgeline.example" };

  var VOICE_DETAIL = "Voice runs on the live model, so it's off in the sample account. " +
    "Start free to talk to Energy Agent about your own fleet.";
  var UPLOAD_DETAIL = "File analysis needs your own account, so uploads are off in the sample. " +
    "Start free to have Energy Agent read your bills and files.";

  // ── formatting ────────────────────────────────────────────────────────────
  function num(x) { return Number(x) || 0; }
  function n0(x) { return Math.round(num(x)).toLocaleString("en-US"); }
  function n1(x) {
    return (Math.round(num(x) * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function usd0(x) { return "$" + n0(x); }
  function usd2(x) {
    return "$" + num(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct0(x) { return Math.round(num(x) * 100) + "%"; }
  function kwStr(w) { return n1(num(w) / 1000) + " kW"; }
  // Inverter nameplate as rated (6.25, not 6.3).
  function npStr(kw) { return String(Math.round(num(kw) * 100) / 100); }
  function pi2(x) { return x == null ? "n/a" : num(x).toFixed(2); }
  function median(list) {
    var s = list.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;   // same pick as FleetStore.recompute
  }
  function mean(a) { return a.length ? a.reduce(function (t, x) { return t + x; }, 0) / a.length : 0; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function monthLabel(ym) {
    var p = String(ym || "").split("-");
    return MONTHS[(+p[1] || 1) - 1] + " " + p[0];
  }
  function monthOnly(ym) { return MONTHS[(+String(ym).split("-")[1] || 1) - 1]; }
  // "YYYY-MM-DD" as a LOCAL calendar date (Date("YYYY-MM-DD") would be UTC).
  function shortDate(s) {
    var m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return MON[+m[2] - 1] + " " + (+m[3]);
    var d = new Date(s);
    return isNaN(d) ? "" : MON[d.getMonth()] + " " + d.getDate();
  }
  function dayShort(s) {
    var d = new Date(s);
    return isNaN(d) ? "" : WEEKDAYS[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate();
  }
  function clock(d) {
    d = new Date(d);
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + (m ? ":" + (m < 10 ? "0" : "") + m : "") + (h < 12 ? " am" : " pm");
  }
  // Daylight is judged on the sites' clock (VT / NH / ME), not the visitor's.
  function siteHour(d) {
    try {
      return +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d) % 24;
    } catch (e) { return d.getHours(); }
  }
  function firstName(c) { return String((c && c.name) || "the tech").split(" ")[0]; }
  function list(items) { return items.map(function (s) { return "- " + s; }).join("\n"); }
  function joinAnd(items) {
    if (items.length <= 1) return items.join("");
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }
  function excerpt(s, max) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    var cut = s.slice(0, max);
    var stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    return stop > 40 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  // energy-agent.js formatMsg turns a prose line holding two " N. " patterns
  // into a numbered list. Guard prose lines so "Inverter 1. Then…" stays prose.
  function guardProse(text) {
    return String(text).split("\n").map(function (line) {
      if (/^\s*(-|\d{1,3}[.)])\s+/.test(line)) return line;
      return line.replace(/(\s\d{1,3})\.(\s)/g, "$1.​$2");
    }).join("\n");
  }

  // ── data access ───────────────────────────────────────────────────────────
  function demo() { return window.AO_DEMO || {}; }
  function store() { return window.FleetStore || null; }
  function fleet() {
    var F = store();
    if (!F || !F.snapshot) return [];
    var s = F.snapshot() || {};
    if ((!s.arrays || !s.arrays.length) && F.load) {
      try { F.load(); } catch (e) {}
      s = F.snapshot() || {};
    }
    return s.arrays || [];
  }
  function energyRate() {
    var F = store();
    try { return F && F.energyRate ? num(F.energyRate()) || 0.21 : 0.21; } catch (e) { return 0.21; }
  }
  function recPerMwh() { var F = store(); return (F && F.REC_PER_MWH) || 38; }
  // Same value model the Fleet tab prices losses with (command-center.js val()).
  function val(kwh) { return kwh * energyRate() + (kwh / 1000) * recPerMwh(); }
  function creditRate() { return num(demo().creditRate) || 0.2576; }
  function vendorOf(a, inv) { var v = String((inv && inv.vendor) || a.vendor || "").toLowerCase(); return VENDOR[v] || v; }
  function npKw(a) { return (a.inverters || []).reduce(function (t, i) { return t + num(i.nameplate_kw); }, 0); }
  function demoArray(id) { return D.site(id) || {}; }
  // Same serial scheme demo/fleet.js and demo/repairs.js show.
  function serialOf(inv) { return typeof inv.id === "number" ? "NE" + (100000 + inv.id * 7919 % 900000) : null; }

  // Per-turn context read through the shim (see header). Missing routes → null,
  // and every reply below degrades to fleet-only facts.
  var CTX = { ops: null, pipe: null, gains: null };
  function getJson(path) {
    try {
      return fetch(path, { headers: { "Content-Type": "application/json" } })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function loadCtx() {
    return Promise.all([
      getJson("/v1/array-owners/ops"),
      getJson("/v1/array-operator/billing/send-pipeline"),
      getJson("/v1/array-operator/billing/portfolio-gains"),
    ]).then(function (r) {
      CTX = { ops: r[0] && r[0].ok !== false ? r[0] : null, pipe: r[1] && r[1].ok ? r[1] : null, gains: r[2] && r[2].ok ? r[2] : null };
    }, function () { CTX = { ops: null, pipe: null, gains: null }; });
  }

  // ── repair book (Repairs tab) ─────────────────────────────────────────────
  var ACTIVE = { open: 1, waiting_reply: 1, scheduled: 1, in_progress: 1 };
  function cases() { var o = CTX.ops; return (o && (o.active_cases || o.tickets)) || []; }
  function caseFor(a, inv) {
    var cs = cases();
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (ACTIVE[c.status] && Number(c.array_id) === Number(a.id) && c.inv_name === inv.name) return c;
    }
    return null;
  }
  function contactForArray(arrayId) {
    var o = CTX.ops || {};
    var all = o.contacts || [];
    var asg = (o.assignments || []).filter(function (x) { return Number(x.array_id) === Number(arrayId); });
    asg.sort(function (x, y) { return (x.kind === "primary" ? 0 : 1) - (y.kind === "primary" ? 0 : 1); });
    for (var i = 0; i < asg.length; i++) {
      for (var j = 0; j < all.length; j++) if (all[j].id === asg[i].contact_id) return all[j];
    }
    for (var k = 0; k < all.length; k++) if (all[k].is_default) return all[k];
    return all[0] || FALLBACK_CONTACT;
  }
  function who(c) { return c ? c.name + (c.company ? " (" + c.company + ")" : "") : "your repair team"; }
  function overdue(c) { return c.next_checkin_at && new Date(c.next_checkin_at).getTime() <= Date.now(); }
  // One line on where the case stands, straight from the repair book.
  function caseLine(c) {
    var ct = c.contact;
    switch (c.pipeline_stage) {
      case "scheduled":
        return "**Repair case:** visit scheduled. " + who(ct) + " is booked for " +
          (c.scheduled_for ? dayShort(c.scheduled_for) + " at " + clock(c.scheduled_for) : "a confirmed date") + ".";
      case "in_progress":
        return "**Repair case:** repair underway with " + who(ct) + ".";
      case "coordinating":
        return "**Repair case:** coordinating with " + who(ct) + "." +
          (c.tech_note ? " Latest from " + firstName(ct) + ": \"" + excerpt(c.tech_note, 190) + "\"" : "");
      case "draft_ready":
        return "**Repair case:** opened" + (c.source === "agent" ? " by Energy Agent" : "") + "; outreach to " + who(ct) +
          " is drafted and waiting for your approval on the Repairs tab.";
      default:
        return "**Repair case:** open; it needs a service contact before outreach can go.";
    }
  }
  function caseShort(c) {
    var f = firstName(c.contact);
    switch (c.pipeline_stage) {
      case "scheduled": return "visit booked " + (c.scheduled_for ? dayShort(c.scheduled_for) : "") + " with " + (c.contact ? c.contact.name : "the tech");
      case "in_progress": return "repair underway with " + f;
      case "coordinating": return "coordinating with " + (c.contact ? c.contact.name : "the tech") + (overdue(c) ? ", check-in overdue" : "");
      case "draft_ready": return "outreach drafted, waiting for your approval";
      default: return "case open, no contact yet";
    }
  }
  function sameSiteVisit(a) {
    var cs = cases();
    for (var i = 0; i < cs.length; i++) {
      if (Number(cs[i].array_id) === Number(a.id) && cs[i].pipeline_stage === "scheduled" && cs[i].scheduled_for) return cs[i];
    }
    return null;
  }
  function caseNext(c, a, inv) {
    var f = firstName(c.contact);
    switch (c.pipeline_stage) {
      case "scheduled":
        return "Nothing new to send: " + f + " is on site " + (c.scheduled_for ? dayShort(c.scheduled_for) : "soon") +
          ". The case closes once " + inv.name + " runs in line with its neighbors over two sunny days.";
      case "in_progress":
        return "Let the repair finish; the case closes once " + inv.name + " runs in line with its neighbors.";
      case "coordinating":
        return overdue(c)
          ? "The check-in with " + f + " is overdue. A short nudge for a date is the next move."
          : "Waiting on " + f + "'s date" + (c.next_checkin_at ? "; the next check-in is " + dayShort(c.next_checkin_at) : "") + ".";
      case "draft_ready":
        var v = sameSiteVisit(a);
        return "Approve the drafted outreach on the Repairs tab" +
          (v ? ". " + firstName(v.contact) + " is already on site " + dayShort(v.scheduled_for) + ", so it can ride the same visit." : ".");
      default:
        return "Add a service contact on the Repairs tab so outreach can go.";
    }
  }

  function effStatus(inv, a) {
    var st = inv.status || "ok";
    if (st === "ok") {
      var F = store();
      try {
        var lv = F && F.liveVerdict ? F.liveVerdict(inv, a.inverters, a.is_daylight) : "ok";
        if (lv === "dark") st = "live_dark";
        else if (lv === "low") st = "live_low";
      } catch (e) {}
    }
    return st;
  }
  // Median kWh per kW of the array's producing inverters over the window.
  function medianSo(a, exclude) {
    var so = (a.inverters || []).filter(function (i) {
      return i !== exclude && (i.status === "ok" || i.status === "underperforming" || i.status === "monitoring") &&
        num(i.nameplate_kw) > 0 && num(i.window_kwh) > 0;
    }).map(function (i) { return i.window_kwh / i.nameplate_kw; });
    return median(so);
  }
  // kWh short over the 14-day window, measured against the array's own typical
  // inverter: peer_index = (this unit's kWh/kW) / (array median kWh/kW), so the
  // expected output is window_kwh / peer_index.
  function shortfallKwh(inv, a) {
    if (inv.status === "underperforming" && num(inv.peer_index) > 0 && inv.window_kwh != null) {
      return Math.max(0, inv.window_kwh / inv.peer_index - inv.window_kwh);
    }
    if (inv.status === "dead" || inv.status === "fault") {
      return Math.max(0, medianSo(a, inv) * num(inv.nameplate_kw) - num(inv.window_kwh));
    }
    return 0;
  }
  var SEV = { dead: 0, fault: 0, underperforming: 1, comm_gap: 2, live_dark: 3, live_low: 4 };

  // Flat, worst-first list of every flagged inverter (same classifier and the
  // same "monitoring is neutral" rule as the Fleet triage table).
  function triage() {
    var arrays = fleet();
    var rows = [], invTotal = 0, healthy = 0, gradeable = 0, np = 0;
    arrays.forEach(function (a) {
      (a.inverters || []).forEach(function (inv) {
        invTotal++;
        np += num(inv.nameplate_kw);
        if (inv.no_energy_register) return;
        var st = effStatus(inv, a);
        if (st === "ok") { healthy++; gradeable++; return; }
        if (st === "monitoring") return;
        gradeable++;
        var lk = shortfallKwh(inv, a);
        rows.push({ a: a, inv: inv, status: st, lostKwh: lk, lossMo: val(lk) / WINDOW_DAYS * 30, kase: caseFor(a, inv) });
      });
    });
    rows.sort(function (x, y) {
      return (SEV[x.status] - SEV[y.status]) || (y.lossMo - x.lossMo) ||
        (num(y.inv.stale_hours) - num(x.inv.stale_hours)) || (x.a.id - y.a.id);
    });
    return {
      arrays: arrays, rows: rows, inverters: invTotal, np: np,
      healthyPct: gradeable ? Math.round(healthy / gradeable * 100) : null,
      priced: rows.filter(function (r) { return SEV[r.status] <= 1; }),
      quiet: rows.filter(function (r) { return r.status === "comm_gap"; }),
      live: rows.filter(function (r) { return r.status === "live_low" || r.status === "live_dark"; }),
    };
  }
  function unitName(a, inv) { return a.name + ", " + inv.name; }

  // Live output vs the array's healthy, reporting peers (latest reading).
  function liveCompare(a, inv) {
    var np = num(inv.nameplate_kw);
    var peers = (a.inverters || []).filter(function (p) {
      return p !== inv && p.status === "ok" && p.current_power_w != null && num(p.nameplate_kw) > 0;
    });
    var med = median(peers.map(function (p) { return p.current_power_w / (p.nameplate_kw * 1000); }));
    var mine = inv.current_power_w != null && np ? inv.current_power_w / (np * 1000) : null;
    return { mine: mine, med: med, gapKw: mine != null && med ? Math.max(0, (med - mine) * np) : 0, peers: peers.length };
  }
  // Day-by-day vs the median healthy peer on the same day.
  function dailyCompare(a, inv) {
    var np = num(inv.nameplate_kw) || 1;
    var peers = (a.inverters || []).filter(function (p) {
      return p !== inv && p.status === "ok" && (p.daily || []).length && num(p.nameplate_kw) > 0;
    });
    var days = (inv.daily || []).map(function (d, k) {
      var pm = median(peers.map(function (p) { var pd = p.daily[k]; return pd ? pd.kwh / p.nameplate_kw : 0; }));
      return { date: d.date, kwh: d.kwh, ratio: pm > 0 ? (d.kwh / np) / pm : null, peerKwh: pm * np };
    }).filter(function (d) { return d.ratio != null; });
    var ratios = days.map(function (d) { return d.ratio; });
    return {
      days: days,
      below: days.filter(function (d) { return d.ratio < 0.95; }).length,
      min: ratios.length ? Math.min.apply(null, ratios) : null,
      max: ratios.length ? Math.max.apply(null, ratios) : null,
    };
  }

  // Array kWh/kW vs the fleet median kWh/kW, month by month (settled series).
  function relYield(id) {
    var ids = D.sites().map(function (s) { return s.id; });
    var series = {};
    ids.forEach(function (i) { series[i] = D.monthly(i); });
    var mine = series[id] || [];
    var kwMine = num(demoArray(id).nameplate_kw) || 1;
    return mine.map(function (m, k) {
      var others = ids.filter(function (i) { return i !== id; }).map(function (i) {
        var e = series[i][k];
        return e ? e.kwh / (num(demoArray(i).nameplate_kw) || 1) : 0;
      });
      var med = median(others);
      return med > 0 ? (m.kwh / kwMine) / med : 1;
    });
  }

  // North Branch Ridge's string fault: the settled series (demo-api monthly())
  // steps down for the last three months. Same math and rounding as the
  // Repairs case (demo/repairs.js nbrLoss), so both say the same kWh and $.
  function nbrFault() {
    var hit = D.monthly(8, 24).slice(-3);
    var factor = 0.985 / D.sitePerf(8) - 1;
    var kwh = hit.reduce(function (t, e) { return t + e.kwh * factor; }, 0);
    return {
      since: hit.length ? hit[0].month : null, months: hit,
      lostKwh: Math.round(kwh / 10) * 10, lostUsd: Math.round(kwh * creditRate() / 10) * 10,
    };
  }
  function isStoryUnit(a, inv) { return Number(a.id) === 8 && inv.name === "Inverter 1" && inv.status === "underperforming"; }

  // ── diagnosis per flagged unit (used when the repair book has no case) ────
  function diagnose(a, inv, status) {
    var vendor = vendorOf(a, inv);
    var invs = a.inverters || [];
    var quietSib = invs.filter(function (i) { return i !== inv && i.status === "comm_gap"; })[0];
    if (status === "underperforming" && isStoryUnit(a, inv)) {
      var f = nbrFault();
      return {
        short: "a DC string fault since " + monthOnly(f.since),
        cause: "**Likely cause:** one DC string has dropped out: a blown string fuse, a failed MC4 connector, or a damaged homerun. " +
          "A fixed slice of output missing every day, sun or clouds, starting abruptly, is the string-fault signature. Soiling creeps in gradually and shading moves with the sun.",
        next: "One truck roll: measure open-circuit voltage and current on each string at " + inv.name +
          ", check the string fuses and connectors, and pull the inverter's event log for ground-fault or insulation alarms." +
          (quietSib ? " While on site, reseat " + quietSib.name + "'s comms cable (no data for ~" + n0(quietSib.stale_hours) + " h)." : ""),
      };
    }
    if (status === "underperforming") {
      var rel = mean(relYield(Number(a.id)));
      var longStanding = rel > 0 && rel < 0.98;
      return {
        short: longStanding ? "long-standing, likely shading, soiling or a weak string" : "shading, soiling or a weak string",
        cause: longStanding
          ? "**Likely cause:** this array has run about " + Math.round((1 - rel) * 100) + "% under its fleet peers across the settled months, so this isn't brand new. " +
            "That points to shading, heavy soiling, or a weak or mismatched string."
          : "**Likely cause:** shading, soiling, or a weak string. The array's settled months don't show a clear step, so I can't date the start from billing-grade data.",
        next: "Pull a morning-versus-afternoon comparison in the " + vendor + " portal: shading hits one end of the day, a weak string costs output all day. " +
          "Then an IV-curve trace on its strings at the next visit.",
      };
    }
    if (status === "comm_gap") {
      var reporting = invs.filter(function (i) { return i !== inv && i.current_power_w != null; }).length;
      return {
        short: "no data for ~" + n0(inv.stale_hours) + " h",
        cause: "**Likely cause:** the inverter's own comms (a loose RS485 or Ethernet cable, or a dropped Wi-Fi or cell link), not the site internet: " +
          plural(reporting, "other inverter is", "other inverters are") + " still reporting. Up to the gap it was producing normally, so I'm not assuming lost kWh, only lost visibility.",
        next: "Check its last check-in in the " + vendor + " portal. If the portal is silent too, have the tech reseat the comms cable or power-cycle its data logger on the next visit. " +
          "Most inverters keep logging locally, so the missing hours usually backfill once it reconnects.",
      };
    }
    if (status === "live_low" || status === "live_dark") {
      return {
        short: status === "live_dark" ? "reading ~0 W while its neighbors produce" : "low on the latest reading, healthy over 14 days",
        cause: status === "live_dark"
          ? "**Likely cause:** a trip (a grid-fault or ground-fault shutdown). Its 14-day record is healthy, so this is new."
          : "**Likely cause:** nothing wrong yet. Over the last 14 days it has kept pace with its neighbors (peer index " + pi2(inv.peer_index) +
            "), so a single low reading is usually a passing cloud edge or a reading taken mid-ramp, not hardware.",
        next: status === "live_dark"
          ? "Check the " + vendor + " portal for an error code and try a remote restart. If it's still dark in an hour, book a tech."
          : "No truck roll. I'd look again at midday tomorrow and only escalate if it's still 15% or more under its neighbors, or its 14-day peer index drops below " + UNDERPERF_PI.toFixed(2) + ".",
      };
    }
    return {
      short: "hardware fault",
      cause: "**Likely cause:** a hardware fault: it's producing a fraction of what its neighbors make under the same sky.",
      next: "Pull the error code from the " + vendor + " portal and draft a warranty claim or service request with the evidence below.",
    };
  }

  function findRow(t, a, inv) {
    var rows = t.rows;
    for (var i = 0; i < rows.length; i++) if (rows[i].a === a && rows[i].inv === inv) return rows[i];
    return null;
  }

  // ── replies: fleet ────────────────────────────────────────────────────────
  function inverterReply(a, inv, mem, opts) {
    opts = opts || {};
    var t = triage();
    var status = effStatus(inv, a);
    var row = findRow(t, a, inv);
    var dx = diagnose(a, inv, status);
    var kase = caseFor(a, inv);
    var vendor = vendorOf(a, inv);
    var head = "**" + unitName(a, inv) + "** (" + vendor + " " + (inv.model || "") + ", " + npStr(inv.nameplate_kw) + " kW)";
    var out = [];
    var lc = liveCompare(a, inv);
    mem.focus = { arrayId: a.id, inv: inv.name };
    (mem.seen = mem.seen || {})[a.id + "|" + inv.name] = 1;

    if (status === "ok" || status === "monitoring") {
      out.push(head + " is pulling its weight. Over the last 14 days it made " + n0(inv.window_kwh) + " kWh, a peer index of " +
        pi2(inv.peer_index) + " against its neighbors under the same sky (" + UNDERPERF_PI.toFixed(2) + " is the cut-off).");
      if (lc.mine != null) out.push("On the latest reading it's at " + kwStr(inv.current_power_w) + " (" + pct0(lc.mine) + " of its rating) with its neighbors at a median of " + pct0(lc.med) + ".");
      out.push("Nothing to do here. Want the units on " + a.name + " that do need a look?");
      return done(out, [
        { label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" },
        { label: a.name + " production", prompt: "How much did " + a.name + " produce over the last 12 months?" },
      ], { offer: "array:" + a.id });
    }

    if (status === "underperforming" || status === "dead" || status === "fault") {
      var gap = Math.round((1 - num(inv.peer_index)) * 100);
      var dc = dailyCompare(a, inv);
      var expected = inv.window_kwh / (num(inv.peer_index) || 1);
      out.push(head + " is running **" + gap + "% below its neighbors** over the last 14 days (peer index " + pi2(inv.peer_index) + ").");
      out.push("");
      out.push("**Evidence**");
      var ev = [
        "14-day output: " + n0(inv.window_kwh) + " kWh, against about " + n0(expected) + " kWh for a typical inverter on this array under the same sky.",
      ];
      if (dc.days.length) {
        ev.push("It came in under the array's median inverter on " + dc.below + " of " + dc.days.length + " days, between " +
          pct0(dc.min) + " and " + pct0(dc.max) + " of it, on strong days and weak ones alike.");
      }
      if (lc.mine != null) ev.push("Latest reading: " + kwStr(inv.current_power_w) + " (" + pct0(lc.mine) + " of its rating) while its neighbors sit at a median of " + pct0(lc.med) + ".");
      if (isStoryUnit(a, inv)) {
        var f = nbrFault();
        ev.push("The array's settled monthly production stepped down starting in " + monthOnly(f.since) + " and has stayed there: about " +
          n0(f.lostKwh) + " kWh (" + usd0(f.lostUsd) + " in credits) lost across " + joinAnd(f.months.map(function (m) { return monthOnly(m.month); })) + ".");
      }
      out.push(list(ev));
      out.push("");
      // The repair book's diagnosis is canonical when a case exists (it's what
      // the Repairs tab and the tech's emails say); North Branch's matches ours.
      out.push(kase && !isStoryUnit(a, inv) && kase.diagnosis ? "**Diagnosis on the case:** " + kase.diagnosis : dx.cause);
      if (row && row.lostKwh > 0) {
        out.push("");
        out.push("**At stake:** about " + n0(row.lostKwh) + " kWh short in 14 days, roughly " + usd0(row.lossMo) + "/mo until it's fixed.");
      }
      out.push("");
      if (kase) {
        out.push(caseLine(kase));
        out.push("");
        out.push("**Next step:** " + caseNext(kase, a, inv));
      } else {
        out.push("**Next step:** " + dx.next);
      }
      if (opts.deep && dc.days.length) {
        out.push("");
        out.push("**Last 7 days, this unit vs the array's median inverter**");
        out.push(list(dc.days.slice(-7).map(function (d) {
          return shortDate(d.date) + ": " + n1(d.kwh) + " kWh vs " + n1(d.peerKwh) + " kWh (" + pct0(d.ratio) + ")";
        })));
      }
      out.push("");
      if (kase) {
        if (opts.fromCard) out.push("A service request is warranted, and this one is already in motion on the Repairs tab, so I haven't drafted a duplicate.");
        if (kase.pipeline_stage === "coordinating") {
          out.push("Want me to draft a follow-up to " + firstName(kase.contact) + " asking for a date?");
          return done(out, [
            { label: "Draft a follow-up", prompt: "Draft a follow-up email to " + firstName(kase.contact) + " about " + unitName(a, inv) + "." },
            { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
          ], { offer: "draft_repair" });
        }
        return done(out, [
          { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
          { label: a.name + " production", prompt: "How much did " + a.name + " produce over the last 12 months?" },
        ], { offer: null });
      }
      if (opts.fromCard) {
        // The Fleet card asks to draft one when warranted, and no case exists.
        out.push("A service request is warranted, so here it is, **drafted and not sent**:");
        out.push("");
        out.push(repairEmailLines(a, inv, status).join("\n"));
        out.push("");
        out.push("Nothing was sent. In your own account I'd send it from your repair mailbox and track the reply on the Repairs tab.");
        return done(out, [
          { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
          { label: a.name + " production", prompt: "How much did " + a.name + " produce over the last 12 months?" },
        ], { offer: null });
      }
      out.push("Want me to draft the service request to " + who(contactForArray(a.id)) + "?");
      return done(out, [
        { label: "Draft the service request", prompt: "Draft a service request email to our O&M tech for " + unitName(a, inv) + "." },
        { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
        { label: a.name + " production", prompt: "How much did " + a.name + " produce over the last 12 months?" },
      ], { offer: "draft_repair" });
    }

    if (status === "comm_gap") {
      out.push(head + " has **gone quiet**: no telemetry for about " + n0(inv.stale_hours) + " h.");
      out.push("");
      out.push("**Evidence**");
      var dq = dailyCompare(a, inv);
      var seen = dq.days.filter(function (d) { return d.kwh > 0; });
      var ev2 = [seen.length
        ? "On the " + seen.length + " days it reported, it made " + pct0(mean(seen.map(function (d) { return d.ratio; }))) + " of what its neighbors did, so it was healthy up to the gap."
        : "It made " + n0(inv.window_kwh) + " kWh in the window before the gap."];
      var sibs = (a.inverters || []).filter(function (i) { return i !== inv && i.current_power_w != null; });
      if (sibs.length) ev2.push(plural(sibs.length, "other inverter", "other inverters") + " on " + a.name + " are reporting right now, so the site's internet is up.");
      out.push(list(ev2));
      out.push("");
      out.push(dx.cause);
      out.push("");
      if (kase) {
        out.push(caseLine(kase));
        out.push("");
        out.push("**Next step:** " + caseNext(kase, a, inv));
      } else {
        out.push("**Next step:** " + dx.next + " There's no repair case for it yet; the Repairs tab doesn't auto-open one for a comms gap.");
      }
      out.push("");
      if (opts.fromCard) out.push("A warranty claim or service request isn't warranted: nothing says the hardware failed, only the link.");
      if (kase && kase.pipeline_stage === "draft_ready") {
        out.push("Want to see the drafted outreach?");
        return done(out, [
          { label: "See the drafted outreach", prompt: "Pull up the drafted outreach for " + unitName(a, inv) + "." },
          { label: "Real dropout or night?", prompt: "Be strict: is anything gone quiet a real dropout or just overnight silence?" },
        ], { offer: "draft_repair" });
      }
      out.push("Want me to draft a note to " + who(contactForArray(a.id)) + " asking them to check it?");
      return done(out, [
        { label: "Draft a note to the tech", prompt: "Draft an email to our O&M tech about " + unitName(a, inv) + " going quiet." },
        { label: "Real dropout or night?", prompt: "Be strict: is anything gone quiet a real dropout or just overnight silence?" },
        { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
      ], { offer: "draft_repair" });
    }

    // live_low / live_dark
    out.push(head + (status === "live_dark"
      ? " is **reading about 0 W** on the latest capture while its neighbors produce."
      : " is **reading low right now**: " + (lc.mine != null ? kwStr(inv.current_power_w) + " (" + pct0(lc.mine) + " of its rating) against a neighbor median of " + pct0(lc.med) + "." : "below its neighbors on the latest reading.")));
    out.push("");
    out.push("**Evidence**");
    out.push(list([
      "Over the last 14 days it made " + n0(inv.window_kwh) + " kWh, a peer index of " + pi2(inv.peer_index) + ". Healthy is " + UNDERPERF_PI.toFixed(2) + " or better.",
      "The 14-day check hasn't flagged it, so no dollars are claimed against it yet.",
    ]));
    out.push("");
    out.push(dx.cause);
    out.push("");
    out.push("**Next step:** " + dx.next);
    if (opts.fromCard && status === "live_low") {
      out.push("");
      out.push("No warranty claim or service request is warranted on one reading, so I haven't drafted one.");
    }
    return done(out, [
      { label: "What actually needs a tech?", prompt: "What needs attention on my fleet right now, worst first?" },
      { label: "What's dragging today?", prompt: "What's dragging today's production across the fleet?" },
    ], { offer: null });
  }

  function arrayReply(a, mem) {
    var d = demoArray(a.id);
    var invs = a.inverters || [];
    var vendor = vendorOf(a, invs[0]);
    var flagged = [];
    invs.forEach(function (inv) {
      var st = effStatus(inv, a);
      if (st === "ok" || st === "monitoring") return;
      var dx = diagnose(a, inv, st);
      var kase = caseFor(a, inv);
      var label = st === "underperforming" ? "underperforming, " + Math.round((1 - num(inv.peer_index)) * 100) + "% below its neighbors"
        : st === "comm_gap" ? "gone quiet, no data for ~" + n0(inv.stale_hours) + " h"
        : st === "live_low" ? "low on the latest reading, healthy over 14 days"
        : st === "live_dark" ? "reading ~0 W on the latest capture"
        : "hardware fault";
      if (kase) label += " (" + caseShort(kase) + ")";
      else if (st === "underperforming") label += " (" + dx.short + ")";
      flagged.push({ inv: inv, st: st, text: "**" + inv.name + ":** " + label });
    });
    var m = D.monthly(a.id);
    var last = m[m.length - 1];
    var y12 = m.slice(-12).reduce(function (s, e) { return s + e.kwh; }, 0);
    var out = ["**" + a.name + "** (" + (a.region || "") + "): " + plural(invs.length, vendor + " inverter") + ", " + n1(npKw(a)) + " kW" +
      (d.primary_utility ? ", on " + (UTIL[d.primary_utility] || d.primary_utility) : "") + "."];
    out.push("");
    if (flagged.length) {
      var lines = flagged.map(function (f) { return f.text; });
      var okN = invs.length - flagged.length;
      if (okN) lines.push("The other " + okN + " are pulling their weight.");
      out.push(list(lines));
    } else {
      out.push("All " + invs.length + " inverters are pulling their weight: every one is at a peer index of " + UNDERPERF_PI.toFixed(2) + " or better over 14 days.");
    }
    if (last) {
      out.push("");
      out.push("**Production:** " + n0(last.kwh) + " kWh in " + monthLabel(last.month) + ", and " + n0(y12) + " kWh over the last 12 settled months (about " +
        usd0(y12 * creditRate()) + " in credits at $" + creditRate().toFixed(4) + "/kWh).");
    }
    var worst = flagged.filter(function (f) { return SEV[f.st] <= 2; })[0];
    mem.focus = worst ? { arrayId: a.id, inv: worst.inv.name } : { arrayId: a.id, inv: null };
    if (worst) {
      out.push("");
      out.push("Want the full diagnosis on " + worst.inv.name + "?");
      return done(out, [
        { label: "Diagnose " + worst.inv.name, prompt: "What's the evidence on " + a.name + " " + worst.inv.name + "? Likely cause and next step." },
        { label: a.name + " this year", prompt: "How much has " + a.name + " produced this year?" },
      ], { offer: "diagnose" });
    }
    return done(out, [
      { label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" },
      { label: a.name + " this year", prompt: "How much has " + a.name + " produced this year?" },
    ], { offer: null });
  }

  // Who has to do what, from the repair book: the human actions vs what's moving.
  function humanActions(t) {
    var needs = [], moving = [];
    t.priced.concat(t.quiet).forEach(function (r) {
      var c = r.kase, nm = unitName(r.a, r.inv);
      if (!c) {
        needs.push(nm + (r.status === "comm_gap"
          ? " has gone quiet with no repair case. Check its comms in the " + vendorOf(r.a, r.inv) + " portal, or open a case."
          : " has no repair case yet. Want a service request drafted?"));
      } else if (c.pipeline_stage === "draft_ready") {
        var v = sameSiteVisit(r.a);
        needs.push("Approve the drafted outreach for " + nm + " on the Repairs tab" +
          (v ? ". " + firstName(v.contact) + " is on site " + dayShort(v.scheduled_for) + " anyway." : "."));
      } else if (c.pipeline_stage === "coordinating" && overdue(c)) {
        needs.push(nm + ": the check-in with " + firstName(c.contact) + " is overdue. Nudge for a date.");
      } else {
        moving.push(nm + " (" + caseShort(c) + ")");
      }
    });
    return { needs: needs, moving: moving };
  }

  function attentionReply(mem, flavor) {
    var t = triage();
    var out = [];
    var sites = {};
    t.live.forEach(function (r) { sites[r.a.id] = 1; });
    var liveSites = Object.keys(sites).length;
    if (!t.rows.length) {
      return done(["All " + n0(t.inverters) + " inverters across " + t.arrays.length + " arrays are pulling their weight right now. Nothing needs a human today."],
        [{ label: "Fleet production", prompt: "How much did the whole fleet produce last month?" }], { offer: null });
    }
    if (flavor === "rank") {
      out.push("**Lost production, ranked by dollars** (14-day window, valued the way the Fleet tab values it):");
      out.push("");
      out.push(t.priced.map(function (r, i) {
        return (i + 1) + ". **" + unitName(r.a, r.inv) + "**: " + n0(r.lostKwh) + " kWh short in 14 days, about " +
          usd0(r.lossMo / 30 * 7) + " this week (" + usd0(r.lossMo) + "/mo)" + (r.kase ? ". Repairs: " + caseShort(r.kase) : "");
      }).join("\n"));
      out.push("");
      out.push("Gone-quiet units (" + joinAnd(t.quiet.map(function (r) { return unitName(r.a, r.inv); })) + ") aren't priced: their output is unknown, not zero.");
      var topR = t.priced[0];
      if (topR) {
        out.push("");
        var v = sameSiteVisit(topR.a);
        if (v) {
          // The biggest leak already has a truck booked: spend tomorrow's roll
          // on the biggest leak that doesn't.
          var quietSame = t.quiet.filter(function (r) { return r.a === topR.a; }).map(function (r) { return r.inv.name + "'s comms"; });
          var nextR = t.priced.filter(function (r) { return !sameSiteVisit(r.a); })[0];
          out.push("**If you only get one truck roll:** " + topR.a.name + " is the biggest leak, but it's already booked: " + firstName(v.contact) +
            " is on site " + dayShort(v.scheduled_for) + (quietSame.length ? " and can cover " + joinAnd(quietSame) + " too" : "") + ". " +
            (nextR ? "So tomorrow's roll goes to **" + unitName(nextR.a, nextR.inv) + "**, the next biggest" + (nextR.kase ? " (" + caseShort(nextR.kase) + ")" : "") + "." : ""));
          if (nextR) topR = nextR;
        } else {
          out.push("**If you only get one truck roll:** " + unitName(topR.a, topR.inv) + ", the biggest leak.");
        }
      }
      mem.focus = topR ? { arrayId: topR.a.id, inv: topR.inv.name } : mem.focus;
      return done(out, [
        topR ? { label: "Why " + topR.a.name + " " + topR.inv.name + "?", prompt: "What's the evidence on " + topR.a.name + " " + topR.inv.name + "? Likely cause and next step." } : null,
        { label: "What needs a human?", prompt: "What needs a human on my fleet today, worst first?" },
      ], { offer: "diagnose" });
    }

    out.push("**Worst first, across " + t.arrays.length + " arrays and " + n0(t.inverters) + " inverters**" +
      (t.healthyPct != null ? " (" + t.healthyPct + "% healthy on the 14-day check):" : ":"));
    out.push("");
    out.push(t.priced.map(function (r, i) {
      var dx = diagnose(r.a, r.inv, r.status);
      var lead = r.status === "underperforming"
        ? Math.round((1 - num(r.inv.peer_index)) * 100) + "% below its neighbors for 14 days" + (isStoryUnit(r.a, r.inv) ? ", " + dx.short : "")
        : dx.short;
      return (i + 1) + ". **" + unitName(r.a, r.inv) + "**: " + lead + ", about " + usd0(r.lossMo) + "/mo." +
        (r.kase ? " Repairs: " + caseShort(r.kase) + "." : "");
    }).join("\n"));
    if (t.quiet.length) {
      out.push("");
      out.push("**Gone quiet** (output unknown, so no dollars claimed):");
      out.push(list(t.quiet.map(function (r) {
        return unitName(r.a, r.inv) + ": no data for ~" + n0(r.inv.stale_hours) + " h" + (r.kase ? " (" + caseShort(r.kase) + ")" : ", no case");
      })));
    }
    if (t.live.length) {
      out.push("");
      out.push(flavor === "stress"
        ? "**What the 14-day badge misses:** " + plural(t.live.length, "inverter") + " on " + plural(liveSites, "array") +
          " read 15% or more under their neighbors on the latest capture while their 14-day record is healthy. One reading is usually a cloud edge; they only become real if they persist."
        : "**Live dips to watch:** " + plural(t.live.length, "inverter") + " on " + plural(liveSites, "array") +
          " read low on the latest capture but are healthy over 14 days. No truck roll for those unless it persists.");
    }
    out.push("");
    out.push("Everything else is pulling its weight.");
    var ha = humanActions(t);
    if (ha.needs.length) {
      out.push("");
      out.push("**What needs you:**");
      out.push(list(ha.needs));
    }
    if (ha.moving.length) {
      out.push("");
      out.push("**Already moving:** " + ha.moving.join("; ") + ".");
    }
    var top = t.priced[0] || t.rows[0];
    mem.focus = { arrayId: top.a.id, inv: top.inv.name };
    var draftCase = t.rows.filter(function (r) { return r.kase && r.kase.pipeline_stage === "draft_ready"; })[0];
    var noCase = t.priced.concat(t.quiet).filter(function (r) { return !r.kase; })[0];
    out.push("");
    if (draftCase) {
      out.push("Want to see the drafted outreach for " + unitName(draftCase.a, draftCase.inv) + "?");
    } else if (noCase) {
      out.push("Want me to draft a note to " + who(contactForArray(noCase.a.id)) + " about " + unitName(noCase.a, noCase.inv) + "?");
      mem.focus = { arrayId: noCase.a.id, inv: noCase.inv.name };
    }
    return done(out, [
      { label: "Why " + top.a.name + " " + top.inv.name + "?", prompt: "What's the evidence on " + top.a.name + " " + top.inv.name + "? Likely cause and next step." },
      draftCase ? { label: "See the drafted outreach", prompt: "Pull up the drafted outreach for " + unitName(draftCase.a, draftCase.inv) + "." } : null,
      { label: "Real dropout or night?", prompt: "Be strict: is anything gone quiet a real dropout or just overnight silence?" },
    ], { offer: draftCase ? "draft_case:" + draftCase.a.id + ":" + draftCase.inv.name : (noCase ? "draft_repair" : null) });
  }

  function quietReply(mem) {
    var t = triage();
    var now = new Date();
    if (!t.quiet.length && !t.live.some(function (r) { return r.status === "live_dark"; })) {
      return done(["Nothing is gone quiet right now: every inverter has reported recently."],
        [{ label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" }], { offer: null });
    }
    var out = ["Being strict about it:"];
    out.push("");
    var lines = t.quiet.map(function (r) {
      var h = num(r.inv.stale_hours);
      var from = new Date(now.getTime() - h * 3600e3);
      var daylight = 0;
      for (var x = new Date(from.getTime()); x < now; x = new Date(x.getTime() + 3600e3)) {
        var hr = siteHour(x);
        if (hr >= 8 && hr < 17) daylight++;
      }
      var sibs = (r.a.inverters || []).filter(function (i) { return i !== r.inv && i.current_power_w != null; }).length;
      var verdict = daylight >= 3
        ? "**real dropout.** It missed about " + daylight + " daylight hours while " + plural(sibs, "neighbor") + " kept reporting, and night can't explain that."
        : "**can't call it yet.** Most of that gap is overnight, when every inverter goes quiet. If it hasn't reported by late morning, it's real.";
      return "**" + unitName(r.a, r.inv) + "**, silent ~" + n0(h) + " h (last heard " + shortDate(D.isoDate(from)) + " around " +
        clock(from) + "): " + verdict + (r.kase ? " Repairs: " + caseShort(r.kase) + "." : " No repair case yet.");
    });
    out.push(list(lines));
    out.push("");
    out.push("Neither is priced as lost kWh: a quiet inverter usually keeps producing, we just can't see it. The fix is the comms link, not the hardware.");
    var target = t.quiet.filter(function (r) { return !r.kase; })[0] || t.quiet[0];
    if (target) mem.focus = { arrayId: target.a.id, inv: target.inv.name };
    out.push("");
    if (target && !target.kase) {
      out.push("Want me to draft a note to " + who(contactForArray(target.a.id)) + " to check the comms on " + unitName(target.a, target.inv) + "?");
      return done(out, [
        { label: "Draft a note to the tech", prompt: "Draft an email to our O&M tech about " + unitName(target.a, target.inv) + " going quiet." },
        { label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" },
      ], { offer: "draft_repair" });
    }
    return done(out, [{ label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" }], { offer: null });
  }

  function todayReply(mem) {
    var t = triage();
    var watts = 0, np = 0;
    t.arrays.forEach(function (a) {
      (a.inverters || []).forEach(function (i) {
        np += num(i.nameplate_kw);
        if (i.current_power_w != null) watts += i.current_power_w;
      });
    });
    var hw = t.priced.map(function (r) { return { r: r, c: liveCompare(r.a, r.inv) }; });
    var hwKw = hw.reduce(function (s, x) { return s + x.c.gapKw; }, 0);
    var liveKw = t.live.reduce(function (s, r) { return s + liveCompare(r.a, r.inv).gapKw; }, 0);
    var out = ["**Latest readings:** the fleet is putting out " + n0(watts / 1000) + " kW across " + n0(np) + " kW of nameplate (" + pct0(watts / 1000 / (np || 1)) + "). Here's what's dragging it:"];
    out.push("");
    var lines = [];
    if (hw.length) {
      lines.push("**Real hardware, about " + n1(hwKw) + " kW:** " + joinAnd(hw.map(function (x) {
        return unitName(x.r.a, x.r.inv) + " (" + n1(x.c.gapKw) + " kW under its neighbors)";
      })) + ". These are low on the 14-day check too, so it isn't weather.");
    }
    if (t.quiet.length) {
      lines.push("**Feed lag:** " + joinAnd(t.quiet.map(function (r) { return unitName(r.a, r.inv) + " (~" + n0(r.inv.stale_hours) + " h)"; })) +
        " haven't reported. Their output is unknown, not zero.");
    }
    if (t.live.length) {
      lines.push("**Live dips, about " + n1(liveKw) + " kW:** " + plural(t.live.length, "inverter") + " are 15% or more under their neighbors on this reading but healthy over 14 days. A cloud edge or a mid-ramp reading looks exactly like this.");
    }
    lines.push("**Weather:** everything else is moving together, which is what weather looks like. The sample doesn't carry an irradiance feed, so I can't put a number on cloud cover.");
    out.push(list(lines));
    var top = t.priced[0];
    if (top) {
      mem.focus = { arrayId: top.a.id, inv: top.inv.name };
      out.push("");
      out.push("The biggest single drag is " + unitName(top.a, top.inv) + ". Want the evidence?");
    }
    return done(out, [
      top ? { label: "Evidence on " + top.inv.name, prompt: "What's the evidence on " + top.a.name + " " + top.inv.name + "? Likely cause and next step." } : null,
      { label: "Rank by lost dollars", prompt: "Rank my fleet by lost production dollars this week." },
    ], { offer: "diagnose" });
  }

  function biggestReply(mem) {
    var arrays = fleet().slice().sort(function (x, y) { return npKw(y) - npKw(x); });
    var a = arrays[0];
    if (!a) return fallbackReply();
    var invs = a.inverters || [];
    var under = [], low = [];
    var lines = invs.map(function (inv) {
      var st = effStatus(inv, a);
      if (st === "underperforming" || st === "dead" || st === "fault") under.push(inv);
      if (st === "live_low" || st === "live_dark") low.push(inv);
      var tag = st === "ok" ? "" : st === "live_low" ? " (low on the latest reading)" : st === "comm_gap" ? " (gone quiet)" : st === "underperforming" ? " (underperforming)" : " (" + st + ")";
      return inv.name + ": " + pi2(inv.peer_index) + tag;
    });
    var out = ["**" + a.name + "** is your biggest array: " + plural(invs.length, vendorOf(a, invs[0]) + " inverter") + ", " + n1(npKw(a)) + " kW."];
    out.push("");
    out.push("Peer index over the last 14 days (1.00 = the array's typical inverter, under " + UNDERPERF_PI.toFixed(2) + " = underperforming):");
    out.push(list(lines));
    out.push("");
    if (under.length) {
      out.push(joinAnd(under.map(function (i) { return i.name; })) + (under.length === 1 ? " is" : " are") + " underperforming against neighbors under the same sky.");
    } else {
      out.push("None are underperforming on the 14-day check.");
    }
    if (low.length) {
      out.push(joinAnd(low.map(function (i) { return i.name; })) + (low.length === 1 ? " reads" : " read") +
        " low on the latest capture, but with 14-day indexes near 1.00 that's a live dip, not a fault.");
    }
    out.push("");
    out.push("**What to check if one slips under " + UNDERPERF_PI.toFixed(2) + ":** compare its morning and afternoon output in the " + vendorOf(a, invs[0]) +
      " portal (shading hits one end of the day), look for soiling or snow on that row, then an IV-curve trace on its strings.");
    mem.focus = { arrayId: a.id, inv: (under[0] || low[0] || {}).name || null };
    return done(out, [
      { label: "Fleet-wide, worst first", prompt: "What needs attention on my fleet right now, worst first?" },
      { label: a.name + " production", prompt: "How much did " + a.name + " produce over the last 12 months?" },
    ], { offer: null });
  }

  // ── replies: drafts and write requests ────────────────────────────────────
  function arrayById(id) {
    var arrays = fleet();
    for (var i = 0; i < arrays.length; i++) if (Number(arrays[i].id) === Number(id)) return arrays[i];
    return null;
  }
  function invByName(a, name) {
    var invs = (a && a.inverters) || [];
    for (var i = 0; i < invs.length; i++) if (invs[i].name === name) return invs[i];
    return null;
  }
  function repairTarget(text, mem, preferWorst) {
    var t = triage();
    var hit = unitFromText(text);
    if (hit && hit.inv) return { a: hit.a, inv: hit.inv, status: effStatus(hit.inv, hit.a) };
    if (hit && hit.a) {
      var onSite = t.rows.filter(function (r) { return r.a === hit.a; })[0];
      if (onSite) return { a: onSite.a, inv: onSite.inv, status: onSite.status };
    }
    if (!preferWorst && mem.focus && mem.focus.inv) {
      var fa = arrayById(mem.focus.arrayId);
      var fi = fa && invByName(fa, mem.focus.inv);
      if (fi) return { a: fa, inv: fi, status: effStatus(fi, fa) };
    }
    var worst = t.priced[0] || t.rows[0];
    return worst ? { a: worst.a, inv: worst.inv, status: worst.status } : null;
  }

  var FOOTER = "Nothing was sent. In your own account I'd send this from your repair mailbox and track the reply on the Repairs tab.";

  function repairDraftReply(text, mem) {
    var tl = text.toLowerCase();
    var preferWorst = /\bworst\b/.test(tl) && !/\b(we discussed|we were|that unit|this unit)\b/.test(tl);
    var tg = repairTarget(text, mem, preferWorst);
    if (!tg) return fallbackReply();
    var a = tg.a, inv = tg.inv, st = tg.status;
    var dx = diagnose(a, inv, st);
    var kase = caseFor(a, inv);
    mem.focus = { arrayId: a.id, inv: inv.name };
    var nexts = [
      { label: "Who needs an invoice?", prompt: "Who still needs an offtaker invoice this cycle?" },
      { label: "Fleet production", prompt: "How much did the fleet produce last month?" },
    ];
    var out;
    if (kase && kase.pipeline_stage === "draft_ready" && kase.draft_checkin && kase.draft_checkin.body) {
      // The Repairs tab already holds this letter: show it rather than a rival.
      out = ["The outreach for " + unitName(a, inv) + " is already drafted on the Repairs tab, waiting for your approval:", "",
        "**To:** " + who(kase.contact) + (kase.contact && kase.contact.email ? " <" + kase.contact.email + ">" : ""),
        "**Subject:** " + kase.draft_checkin.subject, "",
        String(kase.draft_checkin.body).trim(), "", "---",
        "Approving sends it, so it's off in the sample. In your own account it's one click on Repairs (or tell me to)."];
      return closeDraft(out, nexts);
    }
    if (kase && kase.pipeline_stage === "scheduled") {
      var ct = kase.contact || contactForArray(a.id);
      var quiet = (a.inverters || []).filter(function (i) { return i !== inv && i.status === "comm_gap"; })[0];
      out = [firstName(ct) + " is already booked for " + inverterVisit(kase) + ", so a new service request would be a duplicate. Here's a short confirmation note instead, **drafted and not sent**:", "",
        "**To:** " + who(ct) + (ct.email ? " <" + ct.email + ">" : ""),
        "**Subject:** Re: " + a.name + " visit " + dayShort(kase.scheduled_for), "",
        "Hi " + firstName(ct) + ",", "",
        "Confirming " + dayShort(kase.scheduled_for) + " at " + clock(kase.scheduled_for) + " for " + inv.name + " at " + a.name + ". It's still running about " +
          Math.round((1 - num(inv.peer_index)) * 100) + "% below its neighbors every day." +
          (quiet ? " While you're there, please also check " + quiet.name + ": it stopped reporting about " + n0(quiet.stale_hours) + " hours ago, so it's likely its comms cable or data logger." : ""),
        "", "Thanks,"].concat(signature()).concat(["", "---", FOOTER]);
      return closeDraft(out, nexts);
    }
    if (kase && kase.pipeline_stage === "coordinating") {
      var c2 = kase.contact || contactForArray(a.id);
      out = ["**Follow-up, drafted and not sent**", "",
        "**To:** " + who(c2) + (c2.email ? " <" + c2.email + ">" : ""),
        "**Subject:** Re: " + a.name + ": " + inv.name + " visit date", "",
        "Hi " + firstName(c2) + ",", "",
        "Following up on " + inv.name + " at " + a.name + ". It's still running about " + Math.round((1 - num(inv.peer_index)) * 100) +
          "% below its neighbors, so it's giving up production every day. Please send a date for the visit when you have one.",
        "", "Thanks,"].concat(signature()).concat(["", "---", FOOTER]);
      return closeDraft(out, nexts);
    }
    out = ["**Draft, not sent**", ""].concat(repairEmailLines(a, inv, st)).concat(["", "---", FOOTER]);
    if (st === "live_low") out.push("Honestly, I'd hold this one until the dip persists: " + dx.next.replace(/^No truck roll\. /, ""));
    return closeDraft(out, nexts);
  }
  // Every draft ends on my own offer, so the client's "Yes, do that" chip never
  // picks up a question from inside the email body.
  function closeDraft(out, nexts) {
    out.push("");
    out.push("Want the next unit on the list?");
    return done(out, nexts, { offer: "next_unit" });
  }
  // The next flagged unit after the one we just discussed, worst first.
  function nextUnitReply(mem) {
    var tr = triage();
    var seen = mem.seen || {};
    var rest = tr.rows.filter(function (r) {
      return !seen[r.a.id + "|" + r.inv.name] && !(mem.focus && r.a.id === mem.focus.arrayId && r.inv.name === mem.focus.inv);
    });
    return rest[0] ? inverterReply(rest[0].a, rest[0].inv, mem) : attentionReply(mem, "triage");
  }
  function inverterVisit(kase) { return dayShort(kase.scheduled_for) + " at " + clock(kase.scheduled_for); }
  function signature() {
    var acct = D.account();
    return [(acct.operator_name || "Dana Whitcomb") + ", " + (acct.company_name || "Northeast Community Solar"), acct.email || "dana@northeastsolar.coop"];
  }

  // A fresh service request (To / Subject / body) for a unit with no case.
  function repairEmailLines(a, inv, st) {
    var ct = contactForArray(a.id);
    var serial = serialOf(inv);
    var spec = vendorOf(a, inv) + " " + (inv.model || "") + ", " + npStr(inv.nameplate_kw) + " kW" + (serial ? ", serial " + serial : "");
    var subject, para, asks;
    if (st === "comm_gap") {
      subject = "Comms check: " + unitName(a, inv) + " not reporting";
      para = inv.name + " at " + a.name + " (" + spec + ") stopped reporting data about " + n0(inv.stale_hours) +
        " hours ago. The other inverters on the site are reporting, so we think it's the unit's own comms link rather than the site internet.";
      asks = ["Check the inverter's comms connection (RS485 or Ethernet) and reseat or replace the cable",
        "Power-cycle its data logger if the link doesn't come back",
        "Confirm it shows as online in the " + vendorOf(a, inv) + " portal before you leave"];
    } else if (st === "live_low" || st === "live_dark") {
      subject = "Please check on your next visit: " + unitName(a, inv);
      para = inv.name + " at " + a.name + " (" + spec + ") read " + (st === "live_dark" ? "about 0 W" : "noticeably below its neighbors") +
        " on our latest capture. Its 14-day record is healthy, so this isn't urgent.";
      asks = ["Check the inverter display and event log for any recent error codes",
        "Look for new shading, soiling or snow on its rows"];
    } else {
      var story = isStoryUnit(a, inv);
      subject = "Service request: " + unitName(a, inv) + (story ? " (suspected DC string fault)" : " (underperforming)");
      para = "We're seeing " + inv.name + " at " + a.name + " (" + spec + ") running about " + Math.round((1 - num(inv.peer_index)) * 100) +
        "% below the other inverters on the array, every day for the last two weeks." +
        (story ? " The drop started in " + monthOnly(nbrFault().since) + " and looks like one DC string offline." : " We suspect shading, soiling or a weak string.");
      asks = story
        ? ["Measure open-circuit voltage and operating current on each string at " + inv.name,
          "Check the string fuses, MC4 connectors and homeruns on that inverter",
          "Pull the inverter's event log for ground-fault or insulation alarms"]
        : ["Run an IV-curve trace on " + inv.name + "'s strings",
          "Check for shading from new growth and for soiling on its rows",
          "Pull the inverter's event log for recent alarms"];
      var quietSib = (a.inverters || []).filter(function (i) { return i !== inv && i.status === "comm_gap"; })[0];
      if (quietSib) asks.push("While on site: " + quietSib.name + " hasn't reported data for about " + n0(quietSib.stale_hours) + " hours, please reseat its comms cable");
    }
    return [
      "**To:** " + who(ct) + (ct.email ? " <" + ct.email + ">" : ""),
      "**Subject:** " + subject,
      "",
      "Hi " + firstName(ct) + ",",
      "",
      para,
      "",
      "Could you schedule a visit to:",
      list(asks),
      "",
      "Please reply with the earliest date you can get a crew out.",
      "",
      "Thanks,",
    ].concat(signature());
  }

  function repairCaseReply(text, mem) {
    var tl = text.toLowerCase();
    var tg = repairTarget(text, mem, /\b(worst|loudest|faulted|dead)\b/.test(tl));
    if (!tg) return fallbackReply();
    var a = tg.a, inv = tg.inv;
    var t = triage();
    var faulted = t.rows.filter(function (r) { return r.status === "dead" || r.status === "fault"; });
    var out = [];
    if (/\b(fault(ed)?|dead)\b/.test(tl) && !faulted.length) {
      out.push("Nothing is faulted or dead right now. The loudest real problem is " + unitName(a, inv) + ".");
      out.push("");
    }
    mem.focus = { arrayId: a.id, inv: inv.name };
    var kase = caseFor(a, inv);
    if (kase) {
      out.push("There's already a case for it on the Repairs tab, so I wouldn't open a second one:");
      out.push("");
      out.push(list([
        "**Case:** #" + kase.id + " on the Repairs tab, " + unitName(a, inv),
        "**Serial:** " + (kase.serial || serialOf(inv) || "on the unit label"),
        "**Diagnosis:** " + (kase.diagnosis || "see the case"),
        "**Stage:** " + (kase.pipeline_label || kase.pipeline_stage) + ", with " + who(kase.contact),
        "**Next step:** " + caseNext(kase, a, inv),
      ]));
      return done(out, [
        { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
      ], { offer: null });
    }
    var dx = diagnose(a, inv, tg.status);
    var row = findRow(t, a, inv);
    D.nudge("Opening repair cases needs your own account. Start free to track repairs on your arrays.");
    out.push("The sample account is read-only, so I can't open the case, but here's exactly what it would hold:");
    out.push("");
    out.push(list([
      "**Unit:** " + unitName(a, inv) + " (" + vendorOf(a, inv) + " " + (inv.model || "") + ", " + npStr(inv.nameplate_kw) + " kW)",
      "**Serial:** " + (serialOf(inv) || "on the unit label"),
      "**Diagnosis:** " + dx.cause.replace(/^\*\*Likely cause:\*\* /, ""),
      "**Evidence:** " + (tg.status === "comm_gap" ? "no telemetry for ~" + n0(inv.stale_hours) + " h while its neighbors report"
        : "peer index " + pi2(inv.peer_index) + " over 14 days" + (row && row.lostKwh > 0 ? ", about " + n0(row.lostKwh) + " kWh short (" + usd0(row.lossMo) + "/mo)" : "")),
      "**Next step:** " + dx.next,
      "**Assigned to:** " + who(contactForArray(a.id)),
    ]));
    out.push("");
    out.push("In your own account this opens on the Repairs tab, emails the tech, and threads their reply back into this chat. Want the service request email drafted?");
    return done(out, [
      { label: "Draft the service request", prompt: "Draft a service request email to our O&M tech for " + unitName(a, inv) + "." },
      { label: "What else needs attention?", prompt: "What else needs attention on my fleet, worst first?" },
    ], { offer: "draft_repair" });
  }

  function writeRefusal(text) {
    D.nudge();
    var t = text.toLowerCase();
    var what = /\b(invoice|statement|draft|offtaker)s?\b/.test(t) ? "send or approve statements"
      : /\b(email|message|tech|technician|service request|outreach|request|note)\b/.test(t) ? "send email"
      : "change anything";
    var out = ["I can't " + what + " from the sample account: it's read-only, so nothing here goes out or changes. " +
      "In your own account I'd do it after you confirm, and you'd see it land on the right tab.",
      "",
      "What I can do here is draft it or go through the numbers. Want that?"];
    return done(out, [
      { label: "Draft repair outreach", prompt: "Draft a repair outreach email for the worst unit." },
      { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
    ], { offer: null });
  }

  // ── replies: production / revenue ─────────────────────────────────────────
  function pickPeriod(t, series) {
    var n = series.length, last = series[n - 1], m;
    var now = new Date();
    function out(sel, label) { return { sel: sel, label: label }; }
    if (!n) return out([], "");
    if (/\b(this year|ytd|year to date|so far this year)\b/.test(t)) {
      var y = now.getFullYear();
      return out(series.filter(function (e) { return e.year === y; }), y + " so far (through " + monthLabel(last.month) + ")");
    }
    if ((m = t.match(/\bq([1-4])\b(?:\s*(?:of\s*)?(20\d\d))?/))) {
      var q = +m[1], qy = m[2] ? +m[2] : null;
      var cand = series.filter(function (e) { return Math.ceil(e.month_num / 3) === q && (!qy || e.year === qy); });
      if (!qy && cand.length) { var ly = cand[cand.length - 1].year; cand = cand.filter(function (e) { return e.year === ly; }); qy = ly; }
      return out(cand, "Q" + q + " " + qy + (cand.length && cand.length < 3 ? " (" + cand.length + " settled months so far)" : ""));
    }
    if (/\bquarter\b/.test(t)) {
      // Last complete calendar quarter in the settled series.
      for (var k = n - 1; k >= 2; k--) {
        if (series[k].month_num % 3 === 0) {
          return out(series.slice(k - 2, k + 1), "Q" + (series[k].month_num / 3) + " " + series[k].year);
        }
      }
    }
    if ((m = t.match(/\b(?:last|past|previous|trailing)\s+(\d{1,2}|two|three|six|twelve)\s+months\b/))) {
      var words = { two: 2, three: 3, six: 6, twelve: 12 };
      var nm = Math.max(1, Math.min(n, words[m[1]] || +m[1]));
      return out(series.slice(-nm), "the last " + nm + " settled months");
    }
    if (/\b(past year|past 12 months|trailing 12|last twelve months|annual|a year)\b/.test(t)) {
      return out(series.slice(-12), "the last 12 settled months");
    }
    if ((m = t.match(/\b(?:in\s+)?(20\d\d)\b/)) || /\blast year\b/.test(t)) {
      var yy = m ? +m[1] : now.getFullYear() - 1;
      var sel = series.filter(function (e) { return e.year === yy; });
      return out(sel, String(yy) + (sel.length && sel.length < 12 ? " (the " + sel.length + " settled months in the sample)" : ""));
    }
    if (/\b(last|previous|this past) month\b/.test(t)) return out([last], monthLabel(last.month));
    for (var i = 0; i < 12; i++) {
      var re = new RegExp("\\b(" + MONTHS[i].toLowerCase() + (MONTHS[i].length > 4 ? "|" + MON[i].toLowerCase() : "") + ")\\b");
      if (re.test(t)) {
        for (var j = n - 1; j >= 0; j--) if (series[j].month_num === i + 1) return out([series[j]], monthLabel(series[j].month));
      }
    }
    return out(series.slice(-12), "the last 12 settled months");
  }

  function productionReply(text, arraysHit, mem) {
    var t = text.toLowerCase();
    var ids = arraysHit.length ? arraysHit.map(function (a) { return Number(a.id); }) : D.sites().map(function (s) { return s.id; });
    var fleetWide = !arraysHit.length;
    var template = D.monthly(ids[0]);
    var per = pickPeriod(t, template);
    if (!per.sel.length) {
      return done(["The sample's settled history runs from " + monthLabel(template[0].month) + " to " + monthLabel(template[template.length - 1].month) +
        ", so I don't have that period. Want the last 12 months instead?"],
        [{ label: "Last 12 months", prompt: "How much did the fleet produce over the last 12 months?" }], { offer: null });
    }
    var keys = {};
    per.sel.forEach(function (e) { keys[e.month] = 1; });
    var monthTotals = per.sel.map(function (e) { return { month: e.month, kwh: 0 }; });
    var perArray = ids.map(function (id) {
      var s = D.monthly(id);
      var kwh = 0;
      s.forEach(function (e) {
        if (!keys[e.month]) return;
        kwh += e.kwh;
        monthTotals.forEach(function (mt) { if (mt.month === e.month) mt.kwh += e.kwh; });
      });
      var site = demoArray(id);
      // Same months one year earlier, when the 24-month series has them.
      var prior = 0, priorN = 0;
      per.sel.forEach(function (e) {
        var py = (e.year - 1) + "-" + (e.month_num < 10 ? "0" : "") + e.month_num;
        s.forEach(function (x) { if (x.month === py) { prior += x.kwh; priorN++; } });
      });
      return { id: id, name: site.name, kw: num(site.nameplate_kw), kwh: kwh, prior: priorN === per.sel.length ? prior : null };
    });
    var total = perArray.reduce(function (s, x) { return s + x.kwh; }, 0);
    var priorAll = perArray.every(function (x) { return x.prior != null; }) ? perArray.reduce(function (s, x) { return s + x.prior; }, 0) : null;
    var scope = fleetWide ? "The fleet (" + ids.length + " arrays)" : joinAnd(perArray.map(function (x) { return "**" + x.name + "**"; }));
    var out = [];
    out.push(scope + " produced **" + n0(total) + " kWh** (" + n1(total / 1000) + " MWh) over " + per.label + ", worth about **" +
      usd0(total * creditRate()) + "** in net-metering credits at the sample's $" + creditRate().toFixed(4) + "/kWh.");
    if (priorAll) {
      var ch = (total - priorAll) / priorAll;
      out.push("");
      out.push("That's " + (ch >= 0 ? "up " : "down ") + Math.abs(Math.round(ch * 1000) / 10) + "% on the same months a year earlier (" + n0(priorAll) + " kWh).");
    }
    if (per.sel.length > 1 && per.sel.length <= 6) {
      out.push("");
      out.push(list(monthTotals.map(function (mt) { return monthLabel(mt.month) + ": " + n0(mt.kwh) + " kWh"; })));
    }
    if (fleetWide) {
      var ranked = perArray.slice().sort(function (x, y) { return y.kwh / y.kw - x.kwh / x.kw; });
      out.push("");
      out.push("**Best per kW:** " + ranked.slice(0, 3).map(function (x) { return x.name + " (" + n0(x.kwh / x.kw) + " kWh/kW)"; }).join(", ") + ".");
      out.push("**Weakest per kW:** " + ranked.slice(-3).reverse().map(function (x) { return x.name + " (" + n0(x.kwh / x.kw) + " kWh/kW)"; }).join(", ") + ".");
    } else if (perArray.length === 1) {
      var x0 = perArray[0];
      out.push("");
      out.push("That's " + n0(x0.kwh / (x0.kw || 1)) + " kWh per kW of nameplate (" + n1(x0.kw) + " kW).");
    }
    // The period includes North Branch Ridge's string-fault months: say so,
    // since those totals are lower than the array should have made.
    var f = nbrFault();
    if (ids.indexOf(8) !== -1 && f.since && per.sel.some(function (e) { return e.month >= f.since; })) {
      out.push("");
      out.push("North Branch Ridge has carried a string fault on Inverter 1 since " + monthOnly(f.since) + "; about " + n0(f.lostKwh) + " kWh lost so far.");
    }
    var nextArr = fleetWide ? null : perArray[0];
    if (nextArr) mem.focus = { arrayId: nextArr.id, inv: mem.focus && mem.focus.arrayId === nextArr.id ? mem.focus.inv : null };
    var scopeName = fleetWide ? "the fleet" : nextArr.name;
    var askedQuarter = /^Q\d/.test(per.label);
    return done(out, [
      fleetWide ? { label: "Which arrays lag?", prompt: "What needs attention on my fleet right now, worst first?" }
        : { label: nextArr.name + " status", prompt: "How is " + nextArr.name + " doing right now?" },
      askedQuarter ? { label: "This year so far", prompt: "How much has " + scopeName + " produced this year?" }
        : { label: "Last quarter", prompt: "What did " + scopeName + " produce last quarter?" },
      (askedQuarter || /so far/.test(per.label)) ? { label: "Last 12 months", prompt: "How much did " + scopeName + " produce over the last 12 months?" }
        : { label: "This year so far", prompt: "How much has " + scopeName + " produced this year?" },
    ], { offer: null });
  }

  // ── replies: offtaker billing (Statements tab numbers) ────────────────────
  function offtakers() { return demo().offtakers || []; }
  function draftFor(o) {
    var ds = demo().drafts || [];
    for (var i = 0; i < ds.length; i++) {
      if (ds[i].customer_name === o.customer_name && ds[i].client_email === o.client_email && ds[i].customer_kwh === o._demo_kwh) return ds[i];
    }
    return null;
  }
  function subForDraft(d) {
    return offtakers().filter(function (x) {
      return x.customer_name === d.customer_name && x.client_email === d.client_email && x._demo_kwh === d.customer_kwh;
    })[0] || null;
  }
  function gainsFor(o) {
    var g = CTX.gains && CTX.gains.offtakers;
    if (!g) return null;
    for (var i = 0; i < g.length; i++) if (g[i].id === o.id) return g[i];
    return null;
  }
  // Statements' send pipeline when its routes loaded, else AO_DEMO's snapshot.
  function pipe() {
    var p = CTX.pipe, A = demo().pipeline || {};
    var src = p || A;
    var last = src.last || {}, nm = src.next_monthly || {}, inf = src.inflight || {}, ms = src.mode_split || {};
    var lm = last.period_month;
    var lastLabel = typeof lm === "string" ? monthLabel(lm) : (lm ? MONTHS[lm - 1] : "");
    return {
      lastLabel: lastLabel, delivered: num(last.delivered), dollars: num(last.dollars),
      totalEnabled: num(src.total_enabled),
      pendingDrafts: inf.pending_drafts != null ? num(inf.pending_drafts) : num(inf.ready),
      pendingApproval: inf.pending_approval != null ? num(inf.pending_approval) : null,
      pendingAuto: inf.pending_auto != null ? num(inf.pending_auto) : null,
      waiting: inf.waiting != null ? num(inf.waiting) : null,
      firesAt: nm.fires_at || null, scheduled: num(nm.scheduled), nmAuto: num(nm.auto), nmApproval: num(nm.approval),
      modeAuto: num(ms.auto), modeApproval: num(ms.approval),
    };
  }
  function firesText(P) {
    if (!P.firesAt) return "the 1st";
    var d = new Date(P.firesAt);
    return dayShort(d) + " at " + clock(d);
  }
  function amountMath(kwh, disc, amount) {
    disc = num(disc);
    return n0(kwh) + " kWh × $" + creditRate().toFixed(4) + "/kWh" + (disc > 0 ? ", less a " + Math.round(disc * 100) + "% discount" : "") + " = **" + usd2(amount) + "**";
  }
  function offtakerState(o) {
    var dr = draftFor(o);
    var period = demo().periodLabel || "this period";
    if (!o.enabled) return { key: "paused", text: "paused: still in the book, but every run skips it until you resume it" };
    if (dr && o.delivery_mode === "draft") return { key: "approval", text: "draft ready and **waiting for your approval** (" + dr.invoice_number + ")", draft: dr };
    if (dr) return { key: "ready", text: "drafted from the settled bill; it auto-sends on the next run (" + dr.invoice_number + ")", draft: dr };
    if (o.delivery_mode === "auto") return { key: "auto", text: "auto-send; its " + period + " statement goes out on the next run" };
    return { key: "approval_nodraft", text: "approve-to-send; no " + period + " draft in the inbox yet" };
  }
  // Ways people type a name: as billed ("Felix P. Thatcher", "Granite Notch
  // Ski Club (Barn)"), and without the middle initial or building suffix the
  // sample adds to keep same-named offtakers distinct.
  function normName(s) {
    return String(s || "").toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9&()]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function nameForms(o) {
    var nm = normName(o.customer_name);
    var forms = [nm];
    var bare = nm.replace(/\s*\([^)]*\)$/, "").replace(/^(\S+) [a-z] /, "$1 ");
    if (bare && bare !== nm) forms.push(bare);
    return forms;
  }
  function findOfftakers(text) {
    var t = " " + normName(text) + " ";
    var best = 0, hits = [];
    offtakers().forEach(function (o) {
      var len = 0;
      nameForms(o).forEach(function (f) {
        // whole words only, so "Ada Frost" never matches inside "Ada Frosty"
        if (f && t.indexOf(" " + f + " ") !== -1) len = Math.max(len, f.length);
      });
      if (!len) return;
      if (len > best) { best = len; hits = [o]; }
      else if (len === best) hits.push(o);
    });
    return hits;
  }
  // Last-name-only lookups ("what does Ashworth owe?"), billing context only.
  function findByLastName(text) {
    var t = text.toLowerCase();
    var by = {};
    offtakers().forEach(function (o) {
      var nm = String(o.customer_name || "");
      if (/\(/.test(nm)) return;                       // organisations, not people
      var parts = nm.split(" ");
      if (parts.length < 2 || parts.length > 3) return;
      var ln = parts[parts.length - 1].toLowerCase();
      if (ln.length < 4) return;
      if (new RegExp("\\b" + ln + "\\b").test(t)) (by[ln] = by[ln] || []).push(o);
    });
    var keys = Object.keys(by);
    return keys.length === 1 ? by[keys[0]] : [];
  }

  function offtakerReply(hits, mem) {
    var period = demo().periodLabel || "";
    var P = pipe();
    var out = [];
    if (hits.length > 1) {
      out.push("There are " + hits.length + " offtakers by that name:");
      out.push("");
    }
    hits.slice(0, 4).forEach(function (o, idx) {
      var st = offtakerState(o);
      var g = gainsFor(o);
      var util = UTIL[o._provider] || o._provider || "";
      if (idx) out.push("");
      out.push("**" + o.customer_name + "** is on **" + (o.array_name || "an array") + "** (" + Math.round(num(o.allocation_pct) * 1000) / 10 + "% share" + (util ? ", " + util : "") + "), billed " + (o.cadence || "monthly") + ".");
      out.push("");
      var lines = [
        "**" + period + " statement:** " + amountMath(o._demo_kwh, o.resolved_discount_pct, o._demo_amount),
        "**Status:** " + st.text,
        "**Delivery:** " + (o.delivery_mode === "auto" ? "auto-send" : "approve-to-send") + ", to " + o.client_email,
      ];
      if (g && g.last_sent_amount_usd != null) {
        lines.push("**Last statement:** " + usd2(g.last_sent_amount_usd) + " for " + monthLabel(String(g.last_sent_period_end).slice(0, 7)) +
          (g.last_sent_at ? ", sent " + shortDate(g.last_sent_at) : ""));
      }
      if (o.enabled) lines.push("**Next run:** " + firesText(P));
      out.push(list(lines));
    });
    var o0 = hits[0];
    mem.offtaker = o0 ? { id: o0.id } : null;
    var st0 = o0 ? offtakerState(o0) : {};
    if (st0.draft) {
      out.push("");
      out.push("Want to see the full draft?");
    }
    return done(out, [
      st0.draft ? { label: "See the full draft", prompt: "Pull up the full invoice draft for " + o0.customer_name + "." } : null,
      { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
      { label: "What goes out next run?", prompt: "What goes out on the next billing run?" },
    ], { offer: st0.draft ? "show_draft" : null });
  }
  function rememberedOfftaker(mem) {
    if (!mem.offtaker) return null;
    return offtakers().filter(function (o) { return o.id === mem.offtaker.id; })[0] || null;
  }

  function invoiceDraftReply(o, mem) {
    var dr = o ? draftFor(o) : null;
    var biggest = (demo().drafts || []).slice().sort(function (x, y) { return y.amount_usd - x.amount_usd; })[0];
    if (!dr) dr = biggest;
    if (!dr) return billingReply("overview", mem);
    var sub = subForDraft(dr) || {};
    var acct = D.account();
    mem.offtaker = sub.id != null ? { id: sub.id } : mem.offtaker;
    var out = [];
    if (o && !draftFor(o)) out.push(o.customer_name + " doesn't have a draft in the inbox, so here's the biggest one waiting instead.", "");
    out.push("**Draft " + dr.invoice_number + "** for " + dr.customer_name + ", " + dr.period_label + " (not sent):");
    out.push("");
    out.push(list([
      "**From:** " + (acct.company_name || "Northeast Community Solar") + " <" + (acct.email || "dana@northeastsolar.coop") + ">",
      "**To:** " + dr.client_email,
      "**Array:** " + (sub.array_name || "") + ", " + Math.round(num(dr.allocation_pct) * 1000) / 10 + "% share of " + n0(dr.array_total_kwh) + " kWh",
      "**Credits:** " + amountMath(dr.customer_kwh, dr.discount_pct, dr.amount_usd),
      "**Attached:** the " + (UTIL[dr.attach_provider] || "utility") + " bill PDF for the period" + (dr.has_gmp_pdf ? " (ready)" : ""),
    ]));
    out.push("");
    out.push("Approving it is a write, so it's off in the sample. In your own account you'd approve it on Statements (or tell me to), and it goes out with the next run.");
    return done(out, [
      { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
      { label: "What goes out next run?", prompt: "What goes out on the next billing run?" },
    ], { offer: null });
  }

  function billingReply(kind, mem) {
    var A = demo();
    var P = pipe();
    var drafts = (A.drafts || []).slice();
    var offs = offtakers();
    var period = A.periodLabel || "";
    var queued = drafts.filter(function (d) { var s = subForDraft(d); return !s || s.enabled; });
    var draftUsd = queued.reduce(function (s, d) { return s + num(d.amount_usd); }, 0);
    var approvalN = queued.filter(function (d) { var s = subForDraft(d); return !s || s.delivery_mode !== "auto"; }).length;
    var autoN = queued.length - approvalN;
    var paused = offs.filter(function (o) { return !o.enabled; });
    var out = [];
    var top = queued.slice().sort(function (x, y) { return y.amount_usd - x.amount_usd; });

    if (kind === "pending") {
      out.push("**" + plural(queued.length, "draft") + " for " + period + " are in the queue**, " + usd2(draftUsd) + " in total, drafted from settled utility bills" +
        (autoN ? " (" + approvalN + " wait for your approval; " + autoN + " are auto-send and will go on their own)" : "") + ".");
      out.push("");
      out.push("Biggest first:");
      out.push(list(top.slice(0, 6).map(function (d) {
        var o = subForDraft(d) || {};
        return "**" + d.customer_name + "** (" + (o.array_name || "") + "): " + n0(d.customer_kwh) + " kWh, " + usd2(d.amount_usd);
      })));
      out.push("");
      out.push("Each one is a " + period + " credit statement: the offtaker's share of the array's settled kWh × $" + creditRate().toFixed(4) +
        "/kWh, less their discount, with the utility bill PDF attached. The next run is " + firesText(P) + ".");
      if (top[0]) {
        out.push("");
        out.push("Want to see the full draft for " + top[0].customer_name + "?");
        var s0 = subForDraft(top[0]); if (s0) mem.offtaker = { id: s0.id };
      }
      return done(out, [
        top[0] ? { label: "See " + top[0].customer_name + "'s draft", prompt: "Pull up the full invoice draft for " + top[0].customer_name + "." } : null,
        { label: "What goes out next run?", prompt: "What goes out on the next billing run?" },
        { label: "Who's paused?", prompt: "Which offtakers are paused?" },
      ], { offer: top[0] ? "show_draft" : null });
    }
    if (kind === "next") {
      out.push("**Next run: " + firesText(P) + "**, " + plural(P.scheduled, "offtaker") + " scheduled.");
      out.push("");
      out.push(list([
        "**" + n0(P.nmAuto) + " auto-send:** they email themselves on schedule",
        "**" + n0(P.nmApproval) + " approve-to-send:** they only go once you approve the draft (" + approvalN + " drafts are waiting now)",
        "**" + plural(paused.length, "paused offtaker") + "** stay out of the run until resumed",
      ]));
      out.push("");
      out.push("Want the drafts that still need your OK?");
      return done(out, [
        { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
        { label: "Who's paused?", prompt: "Which offtakers are paused?" },
      ], { offer: "pending" });
    }
    if (kind === "paused") {
      out.push("**" + plural(paused.length, "offtaker") + " are paused**, still in the book but skipped by every run until you resume them:");
      out.push("");
      out.push(list(paused.slice(0, 12).map(function (o) { return o.customer_name + " (" + o.array_name + ")"; })));
      return done(out, [
        { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
        { label: "What goes out next run?", prompt: "What goes out on the next billing run?" },
      ], { offer: null });
    }
    // overview / who's billed
    out.push("**Offtaker billing** (" + plural(offs.length, "offtaker") + " across " + D.sites().length + " arrays):");
    out.push("");
    out.push(list([
      "**Last cycle out" + (P.lastLabel ? " (" + P.lastLabel + ")" : "") + ":** " + n0(P.delivered) + " of " + n0(P.totalEnabled) + " statements accepted by the provider" + (P.dollars ? ", " + usd2(P.dollars) : ""),
      "**In the queue:** " + plural(queued.length, "draft") + " for " + period + ", " + usd2(draftUsd) + (approvalN ? " (" + approvalN + " need your approval)" : ""),
      "**Next run:** " + firesText(P) + ", " + n0(P.scheduled) + " scheduled",
      "**Mode split:** " + n0(P.modeAuto) + " auto-send, " + n0(P.modeApproval) + " approve-to-send; " + plural(paused.length, "paused offtaker"),
    ]));
    out.push("");
    out.push("Want the drafts that need your approval, or any offtaker by name?");
    return done(out, [
      { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
      { label: "What goes out next run?", prompt: "What goes out on the next billing run?" },
      top[0] ? { label: "Look up " + top[0].customer_name, prompt: "What's the status of " + top[0].customer_name + "?" } : null,
    ], { offer: "pending" });
  }

  // ── replies: misc ─────────────────────────────────────────────────────────
  function capabilitiesReply(prefix) {
    var out = [];
    if (prefix) { out.push(prefix); out.push(""); }
    out.push("Here's what I can dig into on this fleet:");
    out.push("");
    out.push(list([
      "**Any array or inverter by name**, for example North Branch Ridge Inverter 1",
      "**What needs attention**, worst first, with the evidence, the repair status and the next step",
      "**Production or credit value** for an array or the whole fleet: last month, a quarter, this year, the last 12 months",
      "**Offtaker billing:** drafts waiting for approval, what goes out on the next run, any offtaker by name",
      "**Drafting emails** to your O&M contacts, or a service request for a problem inverter",
    ]));
    out.push("");
    out.push("Voice, file analysis and anything that changes data (sending, approving, editing) need your own account.");
    return done(out, [
      { label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" },
      { label: "North Branch Ridge Inverter 1", prompt: "What's wrong with North Branch Ridge Inverter 1?" },
      { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
    ], { offer: null });
  }
  function fallbackReply() {
    return capabilitiesReply("That's outside what I can answer from the sample account's data, so I won't guess.");
  }
  function accountFactsReply() {
    var acct = D.account();
    var bs = demo().billingSummary || {};
    var card = bs.card_brand ? (bs.card_brand.charAt(0).toUpperCase() + bs.card_brand.slice(1)) + " ending " + bs.card_last4 : "no card";
    return done([
      "This is **" + (acct.company_name || "Northeast Community Solar") + "**, run by " + (acct.operator_name || "Dana Whitcomb") +
        " (" + (acct.email || "") + "), on fleet monitoring plus offtaker invoicing, with a " + card + " on file.",
    ], [], { offer: null });
  }
  function visualFixReply() {
    D.nudge("Site changes need your own account. Start free to use Improve on your workspace.");
    return done([
      "Design changes go through **Improve** (the ✦ button below): you circle the spot, describe the change, and it ships to your own workspace after review. " +
        "That needs your own account, so it's off in the sample.",
    ], [], { offer: null });
  }

  // ── routing ───────────────────────────────────────────────────────────────
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Arrays named in the message, in order of appearance. Offtaker names that
  // carry their array's town ("Ferry Crossing Food Shelf") are matched first.
  function arraysFromText(text, skipAliases) {
    var t = text.toLowerCase();
    var arrays = fleet();
    var hits = [];
    var quoted = text.match(/flagged inverter on my "([^"]+)" array/i);
    arrays.forEach(function (a) {
      var name = String(a.name || "");
      var pats = [name.toLowerCase()].concat(skipAliases ? [] : (ALIASES[name] || []));
      var at = -1;
      if (quoted && quoted[1].toLowerCase() === name.toLowerCase()) at = 0;
      pats.forEach(function (p) {
        var m = new RegExp("\\b" + escRe(p) + "\\b").exec(t);
        if (m && (at === -1 || m.index < at)) at = m.index;
      });
      if (at !== -1) hits.push({ a: a, at: at });
    });
    hits.sort(function (x, y) { return x.at - y.at; });
    return hits.map(function (h) { return h.a; });
  }
  function invNumFromText(text) {
    var m = text.match(/\b(?:inverter|inv|unit)\s*#?\s*(\d{1,2})\b/i) || text.match(/#(\d{1,2})\b/);
    return m ? +m[1] : null;
  }
  function unitFromText(text, skipAliases) {
    var arrays = arraysFromText(text, skipAliases);
    if (!arrays.length) return null;
    var a = arrays[0];
    var n = invNumFromText(text);
    if (n == null) return { a: a, inv: null, arrays: arrays };
    return { a: a, inv: invByName(a, "Inverter " + n), n: n, arrays: arrays };
  }

  function route(msg, ctx, source, mem) {
    var raw = String(msg || "").trim();
    var t = raw.toLowerCase();
    ctx = ctx || {};

    if (source === "tour_wrap" || /visual account tour just finished/i.test(raw)) return accountFactsReply();
    if (ctx.visual_fix_fast) return visualFixReply();

    // "Yes. <the question I asked>" from the next-step chip, or a bare yes.
    var yes = t.match(/^(yes|yep|yeah|sure|ok(ay)?|please|do it|go ahead)\b[\s.,!—-]*/);
    if (yes) {
      var rest = raw.slice(yes[0].length).trim();
      if (rest.length < 4) {
        if (mem.offer === "draft_repair") return repairDraftReply("", mem);
        if (mem.offer === "next_unit") return nextUnitReply(mem);
        if (/^draft_case:/.test(mem.offer || "")) {
          var pc = mem.offer.split(":"), ca = arrayById(pc[1]), ci = ca && invByName(ca, pc.slice(2).join(":"));
          if (ci) { mem.focus = { arrayId: ca.id, inv: ci.name }; return repairDraftReply("", mem); }
        }
        if (mem.offer === "show_draft") return invoiceDraftReply(rememberedOfftaker(mem), mem);
        if (mem.offer === "pending") return billingReply("pending", mem);
        if (mem.offer === "diagnose" && mem.focus) { var fa0 = arrayById(mem.focus.arrayId); var fi0 = fa0 && invByName(fa0, mem.focus.inv); if (fi0) return inverterReply(fa0, fi0, mem); }
        return attentionReply(mem, "triage");
      }
      raw = rest; t = rest.toLowerCase();
      if (/^want me to /.test(t) || /^want (the|to see)/.test(t)) {
        // The chip echoes my own offer back; act on the offer.
        if (/\bdraft(ed)?\b.*\b(service request|note|email|outreach|follow.?up)\b/.test(t)) return repairDraftReply(raw, mem);
        if (/\bfull draft\b/.test(t) || /\bdraft for\b/.test(t)) return invoiceDraftReply(findOfftakers(raw)[0] || rememberedOfftaker(mem), mem);
        if (/\bdrafts that\b|\bneed your (ok|approval)\b/.test(t)) return billingReply("pending", mem);
        if (/\bfull diagnosis\b|\bevidence\b/.test(t)) { var u0 = unitFromText(raw); if (u0 && u0.inv) return inverterReply(u0.a, u0.inv, mem); }
        if (/\bunits on\b/.test(t)) { var ua = unitFromText(raw); if (ua) return arrayReply(ua.a, mem); }
        if (/\bnext unit\b/.test(t)) return nextUnitReply(mem);
      }
    }
    if ((/^no\b/.test(t) && /something else|next highest|another/.test(t)) ||
        (/\bnext (unit|one|problem|inverter)\b/.test(t) && !/\bnext run\b/.test(t))) {
      return nextUnitReply(mem);
    }

    if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo)\b[!. ]*$/.test(t)) {
      return capabilitiesReply("Hi! I'm looking at Northeast Community Solar's fleet and billing.");
    }
    if (/^(thanks|thank you|thx|great|perfect|awesome|cool|got it)\b[!. ]*$/.test(t)) {
      return done(["Anytime. Want to look at anything else on the fleet or billing?"], [
        { label: "What needs attention?", prompt: "What needs attention on my fleet right now, worst first?" },
        { label: "Drafts awaiting approval", prompt: "Which offtaker drafts are waiting for my approval?" },
      ], { offer: null });
    }
    if (/\b(what can you do|what do you do|what can you help|capabilities|top three things|what else can you)\b/.test(t) ||
        /^(help|help me)[ !?.]*$/.test(t)) {
      return capabilitiesReply("");
    }

    // Offtaker by full name wins over the array it is named after ("Ferry Crossing Food Shelf").
    var offHits = findOfftakers(raw);
    var billingWords = /\b(invoice|invoices|offtaker|offtakers|bill|billed|billing|statement|statements|subscriber|owe|owes|amount due|draft for|approval|approve|next run|send pipeline|paused)\b/;
    if (!offHits.length && billingWords.test(t)) offHits = findByLastName(raw);

    var unit = unitFromText(raw, offHits.length > 0);
    var arraysHit = unit ? unit.arrays : [];

    // A Fleet-triage "Ask Energy Agent" card (command-center.js eaRepairPrompt):
    // diagnose THAT unit, drafting the service request inline when warranted.
    if (/flagged inverter on my "/i.test(raw) && unit && unit.inv) {
      return inverterReply(unit.a, unit.inv, mem, { fromCard: true });
    }

    // Write requests: the sample is read-only. Drafting is fine.
    var wantsDraft = /\b(draft|write|compose|prepare)\b/.test(t) || /^(email|message)\b/.test(t);
    if (!wantsDraft && (/^(please\s+)?(send|approve|schedule|dispatch|pause|resume|delete|remove|cancel|mark|change|update|set|book|call|text)\b/.test(t) ||
        /\b(send (it|that|this|them|all)|approve (it|that|this|them|all)|go ahead and send)\b/.test(t))) {
      return writeRefusal(raw);
    }

    // Drafts: repair outreach / service request vs an offtaker invoice.
    if (wantsDraft || /\b(repair case|open (a |the )?case|service request|warranty claim|drafted outreach|outreach|follow.?up email)\b/.test(t)) {
      if (/\b(invoice|statement)\b/.test(t) || (offHits.length && !/\b(tech|technician|repair|service|o&m|inverter)\b/.test(t))) {
        return invoiceDraftReply(offHits[0] || rememberedOfftaker(mem), mem);
      }
      if (/\b(open|create|log)\b.*\bcase\b|\brepair case\b/.test(t) && !/\bemail\b/.test(t)) return repairCaseReply(raw, mem);
      if (/\b(tech|technician|o&m|installer|contractor|repair|service|outreach|warranty|inverter|case|crew|follow.?up)\b/.test(t) || unit ||
          /\b(marcus|jen|sam)\b/.test(t)) {
        return repairDraftReply(raw, mem);
      }
    }

    // Offtaker billing.
    if (offHits.length) {
      if (/\b(full draft|invoice draft)\b/.test(t)) return invoiceDraftReply(offHits[0], mem);
      return offtakerReply(offHits, mem);
    }
    if (billingWords.test(t) || /\b(who('s| is| has been) billed|who gets billed|credits? (to|for) offtakers)\b/.test(t)) {
      if (/\b(full draft|invoice draft)\b/.test(t)) return invoiceDraftReply(rememberedOfftaker(mem), mem);
      if (/\bpaused\b/.test(t)) return billingReply("paused", mem);
      if (/\b(next run|next billing run|goes out|go out|going out|next send|upcoming|scheduled)\b/.test(t)) return billingReply("next", mem);
      if (/\b(pending|approval|approve|waiting|still needs?|need(s)? an invoice|drafts?|inbox|queue|haven'?t (been )?(sent|billed))\b/.test(t)) return billingReply("pending", mem);
      return billingReply("overview", mem);
    }

    // Fleet-wide asks that also mention "production" / "silent" go first.
    if (!unit && /\b(biggest|largest) (array|site)\b/.test(t)) return biggestReply(mem);
    var lossQ = /\b(rank\w*|lost production|truck roll|leak\w*|at risk|losing (money|production)|lost (dollars|money|kwh))\b/.test(t);
    if (lossQ && !(unit && unit.inv)) return attentionReply(mem, /\b(rank\w*|dollars|money)\b|\$/.test(t) ? "rank" : "triage");
    if (!(unit && unit.inv) && /\b(single|one thing|one problem|highest.priority|best next action|next action|fix first)\b/.test(t)) {
      var tr2 = triage();
      var top = tr2.priced[0] || tr2.rows[0];
      if (top) {
        var r = inverterReply(top.a, top.inv, mem);
        r.reply = "The single highest-priority problem is **" + unitName(top.a, top.inv) + "**.\n\n" + r.reply;
        return r;
      }
    }
    if (!unit && /\b(stress.?test|skeptical|badge is missing|hardest)\b/.test(t)) return attentionReply(mem, "stress");

    // Production / revenue for an array or the fleet.
    var prodWords = /\b(produc(e|ed|es|ing|tion)|generat(e|ed|ion)|kwh|mwh|output|revenue|earn(ed|ings)?|yield|made|make|how much (did|has|have|energy|power))\b/;
    if (prodWords.test(t) && !/\b(today|right now|dragging)\b/.test(t)) {
      return productionReply(raw, arraysHit, mem);
    }

    // Today / live drag.
    if (!unit && /\b(today|right now|dragging|this morning|this afternoon)\b/.test(t) && /\b(production|producing|output|dragging|generation|kw)\b/.test(t)) {
      return todayReply(mem);
    }

    // Gone quiet / dropout / night.
    if (/\b(gone quiet|quiet|comm(s|unications?)? gap|dropout|drop.?out|offline|not reporting|no data|no telemetry|silent|silence|overnight|night)\b/.test(t) && !(unit && unit.inv)) {
      return quietReply(mem);
    }

    // A specific inverter or array.
    if (unit && unit.inv) {
      return inverterReply(unit.a, unit.inv, mem, { deep: /\b(deeper|evidence|day.by.day|daily)\b/.test(t) });
    }
    if (unit && unit.n != null && !unit.inv) {
      return done([unit.a.name + " has " + plural((unit.a.inverters || []).length, "inverter") + ", so there's no Inverter " + unit.n + " there. Want the rundown on " + unit.a.name + "?"],
        [{ label: unit.a.name + " rundown", prompt: "How is " + unit.a.name + " doing right now?" }], { offer: null });
    }
    if (unit && unit.a) return arrayReply(unit.a, mem);

    // Follow-ups about "the unit we discussed" / "go deeper".
    if (/\b(deeper|evidence|what you just said|that unit|the problem unit|we discussed|it again|more detail)\b/.test(t)) {
      var fa = mem.focus && mem.focus.inv ? arrayById(mem.focus.arrayId) : null;
      var fi = fa && invByName(fa, mem.focus.inv);
      if (fi) return inverterReply(fa, fi, mem, { deep: true });
      return attentionReply(mem, "triage");
    }

    if (/\b(repairs?|cases?|tickets?|technicians?|techs?|o&m|contractors?)\b/.test(t)) return attentionReply(mem, "triage");
    if (/\b(attention|needs? a human|need(s)? (me|fixing|work)|worst|how('s| is) (my|the) fleet|fleet (health|status)|status|health|priority|problems?|issues?|wrong|underperform\w*|fault\w*|broken|down|flagged|alerts?)\b/.test(t)) {
      return attentionReply(mem, "triage");
    }
    if (/\b(fleet|inverters?|arrays?|sites?)\b/.test(t)) return attentionReply(mem, "triage");

    return fallbackReply();
  }

  function done(lines, nextSteps, extra) {
    extra = extra || {};
    return {
      reply: lines.join("\n"),
      next_steps: (nextSteps || []).filter(Boolean),
      offer: extra.offer === undefined ? null : extra.offer,
    };
  }

  function budget() {
    // The sample tenant is on the free AI tier (billingSummary ai_pro false), so
    // the meter reads "Sample" at 0%; it never moves because nothing is spent.
    return {
      weekly_budget_usd: 2.5, spent_usd: 0, remaining_usd: 2.5, pct_used: 0, warn: false,
      week_start: D.isoDate(D.daysAgo((new Date().getDay() + 6) % 7)) + "T00:00:00Z",
      ok: true, unlimited: false, tier: "free", pro_monthly_usd: 50, covers: "thinking+voice",
      breakdown: { thinking_usd: 0, voice_usd: 0 },
      upgrade: null,
    };
  }

  var SESS = {};
  function newMem() { return { n: 0, focus: null, offtaker: null, offer: null }; }
  function memFor(sid) {
    if (!sid) sid = "ea_sample_anon";
    if (!SESS[sid]) SESS[sid] = newMem();
    return SESS[sid];
  }
  function onboardingUrl() {
    try { return location.origin + "/onboarding"; } catch (e) { return "https://arrayoperator.com/onboarding"; }
  }

  // One turn → the exact payload /chat returns (and chat-stream wraps in "done").
  // The first reply in a conversation carries one honest line that this is the
  // sample, with the path to connect a real fleet.
  function turnPayload(body) {
    body = body || {};
    var sid = body.session_id || null;
    var mem = memFor(sid);
    var out;
    try {
      out = route(body.message, body.context, body.source, mem);
    } catch (e) {
      try { console.warn("[sample agent] reply failed", e); } catch (e2) {}
      out = fallbackReply();
    }
    var reply = guardProse(out.reply);
    if (!mem.n && body.source !== "tour_wrap") {
      reply += "\n\n*This is the sample account, so I'm answering from Northeast Community Solar's sample data. " +
        "[Start free](" + onboardingUrl() + ") to connect your own fleet.*";
    }
    mem.n += 1;
    mem.offer = out.offer;
    var first = String(out.reply).split("\n")[0].replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    return {
      ok: true,
      session_id: sid,
      reply: reply,
      speak: first.length > 220 ? first.slice(0, 217).replace(/\s+\S*$/, "") + "…" : first,
      ui_commands: [],
      pending: null,
      tool_trace: [],
      budget: budget(),
      provider: "sample",
      mind: null,
      cost_usd: 0,
      voice_turn: false,
      next_steps: out.next_steps,
    };
  }
  function answer(body) { return loadCtx().then(function () { return turnPayload(body); }); }

  // chat-stream wire format (energy_agent.py chat_stream): NDJSON, a ping right
  // away, pings while "thinking", then the done line. The done line is split
  // across several reads at byte level so the client's partial-line buffer and
  // streaming TextDecoder run exactly as they do on a real network stream.
  function streamResponse(payload) {
    var enc = new TextEncoder();
    var bytes = enc.encode(JSON.stringify({ type: "done", payload: payload }) + "\n");
    var think = 700 + Math.min(1100, String(payload.reply || "").length * 0.8) + Math.random() * 300;
    var cancelled = false;
    var body = new ReadableStream({
      start: function (c) {
        function push(chunk) { if (!cancelled) { try { c.enqueue(chunk); } catch (e) {} } }
        push(enc.encode(JSON.stringify({ type: "ping" }) + "\n"));
        setTimeout(function () { push(enc.encode(JSON.stringify({ type: "ping" }) + "\n")); }, Math.round(think / 2));
        setTimeout(function () {
          var size = Math.max(64, Math.ceil(bytes.length / 4));
          var i = 0;
          (function next() {
            if (cancelled) return;
            if (i >= bytes.length) { try { c.close(); } catch (e) {} return; }
            push(bytes.subarray(i, i + size));
            i += size;
            setTimeout(next, 25 + Math.random() * 35);
          })();
        }, Math.round(think));
      },
      cancel: function () { cancelled = true; },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson", "X-AO-Sample": "1" },
    });
  }

  function intro() {
    return "Hi, I'm Energy Agent. I can see this account's " + D.sites().length + " arrays, every inverter on them, the repair book and " +
      n0(offtakers().length) + " offtakers. Ask about any array or inverter, what needs attention, production, or billing. What should we tackle?";
  }

  // ── routes ────────────────────────────────────────────────────────────────
  // Fresh conversation every time: there is no server state and never another
  // visitor's chat.
  D.post(/^\/v1\/energy-agent\/session$/, function () {
    var sid = "ea_sample_" + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6);
    SESS[sid] = newMem();
    return {
      ok: true, session_id: sid, resumed: false, messages: [], message_count: 0,
      budget: budget(), intro: intro(), realtime_ready: false, brain: "sample",
    };
  });
  D.get(/^\/v1\/energy-agent\/session\/([^/]+)$/, function (req) {
    return {
      session: { id: decodeURIComponent(req.match[1]), status: "open", cost_usd: 0, pending: null },
      messages: [],
      budget: budget(),
    };
  });
  D.post(/^\/v1\/energy-agent\/session\/([^/]+)\/end$/, function (req) {
    delete SESS[decodeURIComponent(req.match[1])];
    return { ok: true, session_id: decodeURIComponent(req.match[1]), status: "ended" };
  });
  D.get(/^\/v1\/energy-agent\/budget$/, function () { return budget(); });

  D.post(/^\/v1\/energy-agent\/chat-stream$/, function (req) {
    return answer(req.body).then(streamResponse);
  });
  D.post(/^\/v1\/energy-agent\/chat$/, function (req) {
    return answer(req.body);
  });

  // Background bookkeeping the client fires on its own: accept quietly (no
  // sample nudge for writes the visitor didn't ask for).
  D.post(/^\/v1\/energy-agent\/(ui-result|transcript)$/, function () { return { ok: true }; });

  // Needs the real backend: friendly read-only answer + the shared nudge.
  D.post(/^\/v1\/energy-agent\/upload$/, function () { return D.readOnly(UPLOAD_DETAIL); });
  D.post(/^\/v1\/energy-agent\/(realtime-session|realtime-call|voice-consult-stream)$/, function () {
    return D.readOnly(VOICE_DETAIL);
  });

  // energy-agent.js reads the two details for its signed-out degrade notes;
  // _answer is for the harness and console debugging.
  D.agent = { VOICE_DETAIL: VOICE_DETAIL, UPLOAD_DETAIL: UPLOAD_DETAIL, _answer: answer };
})();
