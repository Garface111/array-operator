/* Sample account · Repairs routes (loaded only for signed-out visitors by
 * demo-api.js). Answers the Repairs tab's reads (ops.js) with a sample O&M book
 * shaped exactly like the backend: api/repair_ops.py ops_overview_ep,
 * list_tickets_ep, list_contacts_ep and list_checkins_ep (serialize_ticket,
 * serialize_contact, serialize_checkin, recent_agent_activity,
 * build_checkin_draft), plus the warranty_claims.serialize rollup.
 *
 * The story matches FleetStore's simulated fleet (fleet-store.js simulateFleet):
 * every live flag there has its case here, with the same inverter names, peer
 * indices and stale hours, and the serials demo/fleet.js shows.
 *   8  North Branch Ridge  Inverter 1 string fault (headline: tech visit booked)
 *                          Inverter 2 comm gap (watch item, opened by the agent)
 *   12 Blue Spruce Common  Inverter 3 underperforming (chasing the contractor)
 *   3  Sawmill Ridge       Inverter 1 underperforming (waiting on a date)
 *   17 Ferry Crossing      Inverter 4 underperforming (shading vs weak string)
 * Blue Spruce's Inverter 7 comm gap has no case on purpose: the real reconcile
 * never auto-opens comm gaps (repair_ops.AUTO_OPEN_FAILS); North Branch's only
 * has one because the agent opened it while a visit is already booked there.
 *
 * Closed history sits on healthy sites; dead-unit cases reuse the outage
 * episodes demo/fleet.js derives for the same inverters, so the per-inverter
 * outage log and this book agree on what happened and when.
 *
 * Contacts are fictional (.example domains, 555-01xx numbers). Writes are NOT
 * registered: Approve & send, add contact, etc. fall through to the shim's
 * read-only 403 + shared nudge.
 */
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  var OWNER = "Northeast Community Solar";
  var CHECKIN_HOURS = 72; // tenant follow-up cadence (repair_checkin_hours)
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  var ACTIVE = ["open", "waiting_reply", "scheduled", "in_progress"];
  var TERMINAL = ["resolved", "cancelled", "cleared"];
  var VALID_STATUSES = ACTIVE.concat(TERMINAL);
  var STAGES = ["detected", "draft_ready", "coordinating", "scheduled", "in_progress", "closed"];
  var STAGE_LABELS = {
    detected: "Detected",
    draft_ready: "Outreach ready",
    coordinating: "Coordinating",
    scheduled: "Visit scheduled",
    in_progress: "Repair underway",
    closed: "Closed",
  };

  // ── small helpers ──────────────────────────────────────────────────────
  function ownerEmail() { return D.account().email || "dana@northeastsolar.coop"; }
  function has(arr, v) { return arr.indexOf(v) >= 0; }
  function iso(d) { return d ? d.toISOString() : null; }
  // warranty_claims.serialize: second precision + "Z"
  function isoZ(d) { return d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null; }
  function at(days, h, m) { return D.daysAgo(days, h, m); }
  function hoursAgo(h) { return new Date(Date.now() - h * 3600000); }
  function addHours(d, h) { return new Date(d.getTime() + h * 3600000); }
  // Same serial scheme demo/fleet.js shows on the inverter outage log.
  function serialFor(invId) { return "NE" + (100000 + (invId * 7919) % 900000); }
  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function dayName(d) { return WEEKDAYS[d.getDay()]; }
  function dayLabel(d) { return WEEKDAYS[d.getDay()] + " the " + ordinal(d.getDate()); }
  // North Branch Ridge visit: the first weekday at least two days out, 9:00.
  function visitDate() {
    var d = D.daysAgo(-2, 9, 0);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }
  function staleHours(arrayId, invName, fallback) {
    // Live stale_hours from FleetStore when it has loaded, so "quiet about N h"
    // matches the Fleet tab; FleetStore's simulated value is otherwise fixed.
    try {
      var snap = window.FleetStore && FleetStore.snapshot && FleetStore.snapshot();
      var arrs = (snap && snap.arrays) || [];
      for (var i = 0; i < arrs.length; i++) {
        if (Number(arrs[i].id) !== arrayId) continue;
        var invs = arrs[i].inverters || [];
        for (var j = 0; j < invs.length; j++) {
          if (invs[j].name === invName && invs[j].stale_hours != null) return Number(invs[j].stale_hours);
        }
      }
    } catch (e) {}
    return fallback;
  }

  // ~3 months of North Branch Ridge's string fault, from the SAME monthly
  // history every other tab reads (demo-api.js monthly(): last 3 settled
  // months at the story perf, healthy before that).
  function nbrLoss() {
    var m = D.monthly(8, 24);
    var low = m.slice(-3);
    var factor = 0.985 / D.sitePerf(8) - 1;
    var kwh = 0;
    low.forEach(function (x) { kwh += x.kwh * factor; });
    var rate = (window.AO_DEMO && window.AO_DEMO.creditRate) || 0.2576;
    return {
      since: low.length ? MONTHS[low[0].month_num - 1] : "the summer",
      kwh: Math.round(kwh / 10) * 10,
      usd: Math.round((kwh * rate) / 10) * 10,
    };
  }

  // ── O&M roster ─────────────────────────────────────────────────────────
  function contactsRaw() {
    return [
      {
        id: 57, name: "Marcus Hale", company: "Ridgeline Electric", role: "electrician",
        email: "marcus@ridgeline.example", phone: "802-555-0142",
        notes: "Licensed electrician, primary for the Vermont sites. Prefers email; text for same-day issues.",
        is_default: true, active: true, trusted_at: at(104, 9, 5),
        created_at: at(160, 14, 20), updated_at: at(104, 9, 5),
      },
      {
        id: 58, name: "Jen Albright", company: "Green Peak O&M", role: "om",
        email: "jen@greenpeak.example", phone: "603-555-0178",
        notes: "O&M contractor for the New Hampshire and Maine sites, plus Long Pasture and Blue Spruce Common. Backup in the Northeast Kingdom.",
        is_default: false, active: true, trusted_at: at(41, 16, 45),
        created_at: at(158, 10, 5), updated_at: at(41, 16, 45),
      },
      {
        id: 64, name: "Sam Okafor", company: OWNER, role: "technician",
        email: "sam@northeastsolar.coop", phone: "802-555-0119",
        notes: "In-house site lead. Breaker resets, fault clears and walk-throughs at the central and northwest Vermont sites.",
        is_default: false, active: true, trusted_at: at(119, 10, 22),
        created_at: at(150, 9, 30), updated_at: at(119, 10, 22),
      },
    ];
  }

  // array_id → [primary contact, backup contact]
  var COVERAGE = {
    1: [57], 3: [57], 4: [57], 6: [57], 7: [57], 10: [57], 15: [57],
    8: [57, 58], 9: [57, 58],
    2: [64, 57], 5: [64, 57], 13: [64, 57], 14: [64, 57], 16: [64, 57],
    11: [58, 57], 12: [58, 57],
    17: [58], 18: [58], 19: [58], 20: [58],
  };

  function siteName(id) { var s = D.site(id); return s ? s.name : "Array #" + id; }

  function assignments(contactsById) {
    var out = [];
    Object.keys(COVERAGE).map(Number).sort(function (a, b) { return a - b; }).forEach(function (aid) {
      COVERAGE[aid].forEach(function (cid, k) {
        var c = contactsById[cid];
        out.push({
          array_id: aid,
          array_name: siteName(aid),
          contact_id: cid,
          contact_name: c ? c.name : null,
          kind: k === 0 ? "primary" : "backup",
        });
      });
    });
    return out;
  }

  // repair_ops.resolve_contact_for_array: primary → any assignment → default.
  function resolveContact(aid, contactsById, contacts) {
    var cov = COVERAGE[aid] || [];
    for (var i = 0; i < cov.length; i++) if (contactsById[cov[i]]) return contactsById[cov[i]];
    for (var j = 0; j < contacts.length; j++) if (contacts[j].is_default) return contacts[j];
    return null;
  }

  // ── repair_ops.build_checkin_draft, line for line ──────────────────────
  var FAIL_PLAIN = {
    underperforming: "this unit is underperforming relative to peer inverters on the same site " +
      "(possible string, shading, soiling, or hardware issue)",
    dead: "this unit shows no production while peer inverters continued producing",
    fault: "this unit is reporting a fault or error state",
    comm_gap: "this unit has stopped reporting (communication gap)",
  };
  function buildDraft(t, contact, seq) {
    var owner = OWNER, oEmail = ownerEmail();
    var site = t.site_name || (t.array_id ? "Array #" + t.array_id : "the site");
    var inv = t.inv_name || t.serial || "inverter";
    var fail = String(t.fail_type || "issue").toLowerCase();
    var n = seq != null ? seq : (t.checkin_count || 0) + 1;
    var first = contact && contact.name ? contact.name.split(" ")[0] : "there";
    var failPlain = FAIL_PLAIN[fail] || "an issue was detected (" + fail + ")";
    var equip = [site, inv];
    if (t.serial && inv.indexOf(t.serial) < 0) equip.push("serial " + t.serial);
    if (t.vendor) equip.push(String(t.vendor).toUpperCase());
    var ev = t.evidence || {};
    var lines = [];
    if (ev.diagnosis) lines.push(String(ev.diagnosis).trim());
    if (ev.peer_index != null) lines.push("Peer index: " + Number(ev.peer_index).toFixed(2));
    if (ev.window_kwh != null) lines.push("Recent window production: ~" + ev.window_kwh + " kWh");
    if (t.description) lines.push(String(t.description).trim());

    var subject, body;
    if (n <= 1) {
      subject = site + " — repair request (" + inv + ")";
      body = "Hello " + first + ",\n\n" +
        "I am Energy Agent, writing on behalf of " + owner + " regarding their solar " +
        "fleet. Monitoring has flagged a unit that needs attention.\n\n" +
        "Site / equipment: " + equip.join(", ") + "\n" +
        "Issue: " + failPlain + ".\n";
    } else {
      subject = "Re: " + site + " — repair status check-in (" + inv + ")";
      body = "Hello " + first + ",\n\n" +
        "Following up on the open repair for " + owner + " at " + site + " (" + inv + "). " +
        "This is check-in #" + n + ".\n\n";
    }
    if (lines.length) {
      body += "\nDetails:\n" + lines.map(function (l) { return "  • " + l; }).join("\n") + "\n";
    }
    body += "\nWhen you have a moment, please reply to this email with a brief status:\n" +
      "  • Acknowledged, with an expected site-visit date if known\n" +
      "  • Parts on order (and ETA if available)\n" +
      "  • Repair completed\n" +
      "  • Needs owner action (access, warranty RMA, etc.)\n\n" +
      "You can reply directly to this message; it reaches Energy Agent and is " +
      "logged on the case.\n";
    if (oEmail) body += "\nOwner contact (if you need them directly): " + oEmail + "\n";
    body += "\nReference: [AO-TICKET-" + t.id + "]\n" +
      "\nThank you,\nEnergy Agent\non behalf of " + owner + "\n";
    var to = (contact && contact.email) || oEmail;
    return { to: to, subject: subject, body: body };
  }

  var FAIL_LABEL = { underperforming: "Underperforming", dead: "Dead", fault: "Fault", comm_gap: "Comm gap" };
  function defaultTitle(t) {
    var label = FAIL_LABEL[t.fail_type] || "Issue";
    var who = t.inv_name || t.serial;
    return label + " — " + (t.site_name || "site") + (who ? " / " + who : "");
  }

  // Agent's conversational replies (via="conversation") carry the case ref so
  // the next tech reply threads back onto the right ticket.
  function signed(t, text) {
    return text + "\n\nReference: [AO-TICKET-" + t.id + "]\n\nEnergy Agent\non behalf of " + OWNER;
  }

  // ── the book ───────────────────────────────────────────────────────────
  // Each case: ticket snapshot + an ordered script of what happened on it.
  //   approve = owner clicked Approve & send (via owner), auto = scheduled
  //   follow-up (via auto), reply = tech email in, agent = Energy Agent's
  //   conversational reply (via conversation).
  function book() {
    var contacts = contactsRaw();
    var byId = {};
    contacts.forEach(function (c) { byId[c.id] = c; });

    var visit = visitDate();
    var loss = nbrLoss();
    var nbr2Stale = staleHours(8, "Inverter 2", 10);

    var cases = [
      // ── closed history (healthy sites) ──────────────────────────────────
      {
        // demo/fleet.js: Kettle Pond Inverter 2, dark 119→116 days ago,
        // "came back after the O&M tech power-cycled it on the next site visit".
        t: {
          id: 212, array_id: 2, inverter_id: 14, contact_id: 64, inv_name: "Inverter 2",
          vendor: "solaredge", fail_type: "dead", severity: "critical", source: "auto", status: "resolved",
          opened_at: at(119, 10, 5), resolved_at: at(116, 10, 41),
          evidence: {
            status: "dead",
            diagnosis: "Reading 0 W in full sun since mid-morning while its 11 neighbors produce normally, so it is the unit or its breaker, not the grid.",
            peer_index: null, window_kwh: null, nameplate_kw: 6.25,
          },
        },
        script: [
          ["approve", at(119, 10, 22)],
          ["reply", at(119, 14, 10), "Saw it. I'm tied up at Cobble Hill today, but I can be there " + dayName(at(116)) + " morning."],
          ["agent", at(119, 14, 18), "Thanks, Sam. " + dayName(at(116)) + " morning is logged on the case. Inverter 2 is dark while the other 11 units on the site keep producing, so start with its AC breaker and the unit itself."],
          ["reply", at(116, 10, 40), "AC breaker for Inverter 2 was tripped at the panel. Reset it and the unit is back producing. Breaker and wiring look fine; I'll keep an eye on it."],
          ["agent", at(116, 10, 52), "Thanks, Sam. Inverter 2 is back in line with its neighbors, so I've closed the case."],
        ],
      },
      {
        // Hilltop Dairy: failing unit swapped under warranty. Intermittent
        // morning trips + a same-day swap never zeroed a full day, so the
        // inverter's outage log stays clean (matches demo/fleet.js).
        t: {
          id: 247, array_id: 15, inverter_id: 142, contact_id: 57, inv_name: "Inverter 8",
          vendor: "chint", fail_type: "fault", severity: "critical", source: "auto", status: "resolved",
          opened_at: at(104, 8, 40), resolved_at: at(90, 15, 11), warranty_claim_id: 18,
          evidence: {
            status: "fault",
            diagnosis: "Tripping on an isolation fault most mornings and restarting by midday; its 9 neighbors run through the same hours without a trip.",
            peer_index: 0.61, window_kwh: 236.4, nameplate_kw: 6.0,
          },
        },
        script: [
          ["approve", at(104, 9, 5)],
          ["reply", at(103, 7, 30), "Pulled the event log remotely. Inverter 8 trips on an isolation fault most mornings and restarts by noon. The strings test fine from the portal, so the unit itself is failing. It's under warranty: I've asked the manufacturer for a replacement inverter and will swap it when it arrives."],
          ["agent", at(103, 7, 41), "Thanks, Marcus. I drafted the warranty claim with Inverter 8's fault history attached and sent it to Dana to forward. Send me the swap date once the replacement ships."],
          ["reply", at(90, 15, 10), "Replacement inverter installed and commissioned this morning; it's back producing. Old unit is boxed for the return."],
          ["agent", at(90, 15, 22), "Confirmed: the new Inverter 8 is producing in line with its 9 neighbors. Closing the case. Thanks, Marcus."],
        ],
      },
      {
        // Harbor Landing: the whole site's data link dropped (cellular modem),
        // production never stopped. Opened by the agent at site level.
        t: {
          id: 318, array_id: 19, inverter_id: null, contact_id: 58, inv_name: null, serial: null,
          vendor: "alsoenergy", fail_type: "comm_gap", severity: "critical", source: "agent", status: "resolved",
          opened_at: at(41, 16, 20), resolved_at: at(40, 9, 41),
          description: "All 12 inverters stopped reporting at 3:40 pm at the same moment. The utility meter still shows export, so the site is producing; this is the data link (gateway or modem), not hardware.",
          evidence: {},
        },
        script: [
          ["approve", at(41, 16, 45)],
          ["reply", at(40, 9, 40), "The cellular modem at the site gateway was hung. Power-cycled it and all 12 inverters are back online. Signal is weak in that corner of the lot, so I'll send over a quote for an external antenna."],
          ["agent", at(40, 9, 52), "Thanks, Jen. All 12 are reporting again, and the utility meter kept counting through the gap, so no production was lost. I'll pass the antenna quote to Dana when it arrives."],
        ],
      },
      {
        // demo/fleet.js: Pine Commons Inverter 5, dark 38→35 days ago, power-cycled.
        t: {
          id: 333, array_id: 20, inverter_id: 191, contact_id: 58, inv_name: "Inverter 5",
          vendor: "chint", fail_type: "dead", severity: "critical", source: "auto", status: "resolved",
          opened_at: at(38, 10, 30), resolved_at: at(35, 13, 21),
          evidence: {
            status: "dead",
            diagnosis: "Reading 0 W through midday while its 11 neighbors produce normally. The unit shut itself down; no grid event on the feeder.",
            peer_index: null, window_kwh: null, nameplate_kw: 5.4,
          },
        },
        script: [
          ["approve", at(38, 10, 52)],
          ["reply", at(37, 8, 15), "We'll have a crew nearby that week. I can be there " + dayName(at(35)) + "."],
          ["agent", at(37, 8, 26), "Thanks, Jen. " + dayName(at(35)) + " is logged on the case. Inverter 5 is dark while its 11 neighbors produce, so it's the unit itself rather than the grid."],
          ["reply", at(35, 13, 20), "Inverter 5 had shut down on over-temperature. A wasp nest was blocking the fan intake. Cleared it, power-cycled the unit, and it's back producing."],
        ],
      },
      {
        // demo/fleet.js: Birch Hollow Inverter 9, grid over-voltage fault 15 days
        // ago that "reconnected on its own once the line settled". Never emailed:
        // reconcile cleared it (status cleared → activity only, not a ticket row).
        t: {
          id: 371, array_id: 1, inverter_id: 9, contact_id: 57, inv_name: "Inverter 9",
          vendor: "solaredge", fail_type: "fault", severity: "critical", source: "auto", status: "cleared",
          opened_at: at(15, 10, 40), cleared_at: at(14, 9, 30),
          evidence: {
            status: "fault",
            diagnosis: "Reporting a grid over-voltage fault and shut itself off.",
            peer_index: null, window_kwh: null, nameplate_kw: 8.25,
          },
        },
        script: [],
      },
      {
        // Rail Yard: grid-fault latch after co-op line work, cleared the same
        // morning (partial day, so no outage-log episode).
        t: {
          id: 413, array_id: 16, inverter_id: 150, contact_id: 64, inv_name: "Inverter 6",
          vendor: "sma", fail_type: "fault", severity: "critical", source: "auto", status: "resolved",
          opened_at: at(4, 8, 10), resolved_at: at(4, 11, 6),
          evidence: {
            status: "fault",
            diagnosis: "Latched a grid fault at 7:52 am and has not restarted; its 7 neighbors reconnected on their own.",
            peer_index: null, window_kwh: null, nameplate_kw: 6.5,
          },
        },
        script: [
          ["approve", at(4, 8, 24)],
          ["reply", at(4, 11, 5), "The co-op had a line crew on the feeder this morning. Inverter 6 latched a grid fault and didn't restart on its own. I was nearby, cleared the fault at the unit, and it's back producing."],
          ["agent", at(4, 11, 14), "Thanks, Sam. Inverter 6 is producing in line with its 7 neighbors again, so I've closed the case."],
        ],
      },

      // ── active cases (the four flagged sites) ───────────────────────────
      {
        t: {
          id: 384, array_id: 17, inverter_id: 156, contact_id: 58, inv_name: "Inverter 4",
          vendor: "solaredge", fail_type: "underperforming", severity: "warning", source: "auto", status: "waiting_reply",
          opened_at: at(12, 7, 20), checkin_interval_hours: 168,
          evidence: {
            status: "underperforming",
            diagnosis: "Running at 72% of its 11 neighbors, with the gap widest in late afternoon. Could be shading from the west tree line or a weak string.",
            peer_index: 0.72, window_kwh: 266.0, nameplate_kw: 5.8,
          },
        },
        script: [
          ["approve", at(12, 8, 40)],
          ["reply", at(11, 15, 5), "Looked at the module-level data. Three panels at the end of string 2 drop off every afternoon around 3, which looks like shade from the tree line on the west side at that sun angle. I'd rather confirm before rolling a truck: can you send me Inverter 4's numbers for a couple of clear mornings?"],
          ["agent", at(11, 15, 18), "Here you go: on the last three clear mornings Inverter 4 ran within 4% of its neighbors, and the gap opens after about 2 pm. That fits shading. If it's confirmed, Dana can take the trimming up with the landowner; a quick look at string 2 would rule out a weak connector."],
          ["reply", at(6, 10, 30), "Thanks, that helps. I'll have the crew look at the tree line and string 2 when they're at Elm Meadows next week; it's 20 minutes away."],
          ["agent", at(6, 10, 41), "Sounds good. I'll keep watching Inverter 4's afternoons and check back after the Elm Meadows visit."],
        ],
        next_checkin_at: addHours(at(6, 10, 41), 168),
      },
      {
        t: {
          id: 392, array_id: 12, inverter_id: 111, contact_id: 58, inv_name: "Inverter 3",
          vendor: "fronius", fail_type: "underperforming", severity: "warning", source: "auto", status: "waiting_reply",
          opened_at: at(8, 6, 55),
          evidence: {
            status: "underperforming",
            diagnosis: "Running at 60% of its 7 neighbors over the last 14 days, the weakest unit in the fleet. A steady gap on clear days points to a string or connector fault, not soiling.",
            peer_index: 0.6, window_kwh: 131.7, nameplate_kw: 3.5,
          },
        },
        script: [
          ["approve", at(8, 9, 30)],
          ["auto", at(5, 9, 30)],
          ["auto", at(2, 9, 30)],
          ["reply", at(1, 9, 50), "Sorry, this one got buried under the New Hampshire work. I can get a tech to Blue Spruce next week and will confirm the day in the next couple of days."],
          ["agent", at(1, 10, 2), "Thanks, Jen. Next week works. Inverter 3 is the weakest unit in the fleet right now, so earlier in the week is better. I'll look for your date in the next couple of days."],
        ],
        next_checkin_at: addHours(at(1, 10, 2), CHECKIN_HOURS),
      },
      {
        t: {
          id: 398, array_id: 3, inverter_id: 25, contact_id: 57, inv_name: "Inverter 1",
          vendor: "fronius", fail_type: "underperforming", severity: "warning", source: "auto", status: "waiting_reply",
          opened_at: at(7, 7, 10), checkin_interval_hours: 120,
          evidence: {
            status: "underperforming",
            diagnosis: "Running at 63% of its 9 neighbors over the last 14 days. The gap holds on clear days, so a string or connector fault is likelier than soiling.",
            peer_index: 0.63, window_kwh: 255.9, nameplate_kw: 6.2,
          },
        },
        script: [
          ["approve", at(7, 9, 45)],
          ["auto", at(4, 9, 45)],
          ["reply", at(4, 16, 20), "Got it. Sawmill is the opposite direction from North Branch, so it'll be a separate trip. Let me look at my calendar and get back to you with a date."],
          ["agent", at(4, 16, 31), "Thanks, Marcus. Inverter 1 is giving up roughly a third of its output, so sooner is better, but any day next week works. I'll check back " + dayName(addHours(at(4, 16, 31), 120)) + " if I haven't seen a date."],
        ],
        next_checkin_at: addHours(at(4, 16, 31), 120),
      },
      {
        // THE headline: ~3 months of string-fault loss, outreach approved,
        // tech replied and booked the visit.
        t: {
          id: 405, array_id: 8, inverter_id: 69, contact_id: 57, inv_name: "Inverter 1",
          vendor: "chint", fail_type: "underperforming", severity: "warning", source: "auto", status: "scheduled",
          opened_at: at(6, 6, 40), scheduled_for: visit,
          evidence: {
            status: "underperforming",
            diagnosis: "Dipping on and off since " + loss.since + ", now steady at 67% of its 7 neighbors on sunny and cloudy days alike: the signature of a DC string down, not soiling. About " +
              loss.kwh.toLocaleString("en-US") + " kWh ($" + loss.usd + ") lost so far.",
            peer_index: 0.67, window_kwh: 269.6, nameplate_kw: 6.25,
          },
        },
        script: [
          ["approve", at(6, 8, 12)],
          ["reply", at(5, 7, 48), "Thanks. Pulled it up in the Chint portal and you're right: Inverter 1 is down about a third every day, sun or clouds. My bet is a blown string fuse or a cooked connector at the combiner. I can be there " + dayLabel(visit) + " around 9 with a meter and spare fuses."],
          ["agent", at(5, 8, 5), "Thanks, Marcus. " + dayLabel(visit) + " at 9 is on the case. After the fix I'll compare Inverter 1 with its neighbors over two sunny days and close the case once it's back in line."],
        ],
        // Follow-up pushed past the visit (agent set the per-case cadence).
        next_checkin_at: addHours(visit, 25),
      },
      {
        // Watch item the agent opened ~an hour after Inverter 2 went quiet:
        // the tech is on site soon anyway. Agent-opened tickets carry the
        // agent's description and empty evidence (energy_agent open_repair_ticket).
        t: {
          id: 431, array_id: 8, inverter_id: 70, contact_id: 57, inv_name: "Inverter 2",
          vendor: "chint", fail_type: "comm_gap", severity: "critical", source: "agent", status: "open",
          opened_at: hoursAgo(Math.max(1, nbr2Stale - 1)),
          description: "Stopped reporting about " + nbr2Stale + " h ago while the other 7 units kept reporting. Output was normal right up to the gap, so this looks like the data link, not hardware. Marcus is on site " + dayLabel(visit) + " anyway.",
          evidence: {},
        },
        script: [],
      },
    ];

    // Materialize tickets + check-ins in creation order.
    var tickets = [], checkins = [];
    var nextCheckinId = 2140;
    cases.forEach(function (cs) {
      var t = cs.t;
      t.site_name = siteName(t.array_id);
      if (t.inverter_id && t.serial === undefined) t.serial = serialFor(t.inverter_id);
      if (t.serial === undefined) t.serial = null;
      if (!t.title) t.title = defaultTitle(t);
      if (t.description === undefined) t.description = null;
      var contact = t.contact_id ? byId[t.contact_id] : null;
      var out = 0, last = null, lastAny = t.opened_at, techNote = null;
      cs.script.forEach(function (step) {
        var kind = step[0], when = step[1], text = step[2];
        var c = {
          id: 0, ticket_id: t.id, contact_id: t.contact_id, channel: "email",
          direction: "outbound", subject: null, body: null, sent_to: null,
          cc_emails: null, sent_ok: true, via: "agent", created_at: when,
        };
        var firstSubj = t.site_name + " — repair request (" + (t.inv_name || t.serial || "inverter") + ")";
        if (kind === "approve" || kind === "auto") {
          var dr = buildDraft(t, contact, out + 1);
          c.via = kind === "approve" ? "owner" : "auto";
          c.subject = dr.subject; c.body = dr.body; c.sent_to = dr.to;
          out++; last = when;
        } else if (kind === "reply") {
          c.direction = "inbound"; c.via = "inbound_email";
          c.subject = "Re: " + firstSubj; c.body = text;
          c.sent_to = contact ? contact.email : null;
          techNote = text;
        } else {
          c.via = "conversation";
          c.subject = "Re: " + firstSubj; c.body = signed(t, text);
          c.sent_to = contact ? contact.email : ownerEmail();
          out++; last = when;
        }
        checkins.push(c);
        if (when > lastAny) lastAny = when;
      });
      t.checkin_count = out;
      t.last_checkin_at = last;
      t.tech_note = techNote;
      t.next_checkin_at = has(ACTIVE, t.status) ? (cs.next_checkin_at || null) : null;
      if (t.checkin_interval_hours === undefined) t.checkin_interval_hours = null;
      if (t.scheduled_for === undefined) t.scheduled_for = null;
      t.resolved_at = t.resolved_at || null;
      t.cancelled_at = t.cancelled_at || null;
      t.cleared_at = t.cleared_at || null;
      t.warranty_claim_id = t.warranty_claim_id || null;
      var end = t.resolved_at || t.cleared_at;
      if (end && end > lastAny) lastAny = end;
      t.updated_at = lastAny;
      // ops_overview keeps active drafts fresh: the NEXT letter (first contact
      // for a new case, a numbered follow-up once outreach has gone out).
      t.draft_checkin = buildDraft(t, contact, out + 1);
      tickets.push(t);
    });
    checkins.sort(function (a, b) { return a.created_at - b.created_at; });
    checkins.forEach(function (c) { c.id = nextCheckinId++; });

    // list_tickets: newest opened first
    tickets.sort(function (a, b) { return b.opened_at - a.opened_at; });

    return { contacts: contacts, byId: byId, tickets: tickets, checkins: checkins };
  }

  // ── serializers (repair_ops.py) ────────────────────────────────────────
  function serializeContact(c) {
    return {
      id: c.id, name: c.name, company: c.company, role: c.role,
      email: c.email, phone: c.phone, notes: c.notes,
      is_default: !!c.is_default, active: !!c.active,
      trusted: !!c.trusted_at, trusted_at: iso(c.trusted_at),
      created_at: iso(c.created_at), updated_at: iso(c.updated_at),
    };
  }

  function pipelineStage(t) {
    var st = String(t.status || "open").toLowerCase();
    if (has(TERMINAL, st)) return "closed";
    if (st === "in_progress") return "in_progress";
    if (st === "scheduled") return "scheduled";
    if (st === "waiting_reply" || (t.checkin_count || 0) > 0) return "coordinating";
    var d = t.draft_checkin || {};
    if (d.body || d.subject) return "draft_ready";
    return "detected";
  }

  function nextAction(t, contact) {
    var stage = pipelineStage(t);
    if (stage === "closed") return "Case closed";
    if (stage === "detected") return "Add a service contact so EnergyAgent can draft outreach";
    if (stage === "draft_ready") return "Approve & send outreach to " + ((contact && contact.name) || "your repair team");
    if (stage === "coordinating") return "Waiting on the repair team — log a reply or follow up";
    if (stage === "scheduled") return "Visit scheduled — EnergyAgent will verify when hardware recovers";
    if (stage === "in_progress") return "Repair underway — watching live vendor data for recovery";
    return "Review case";
  }

  function stageList() {
    return STAGES.map(function (s) { return { id: s, label: STAGE_LABELS[s] }; });
  }

  function serializeTicket(t, contact, claim) {
    var stage = pipelineStage(t);
    var ev = t.evidence || {};
    var phone = contact && contact.phone ? String(contact.phone).trim() : "";
    return {
      id: t.id,
      array_id: t.array_id,
      inverter_id: t.inverter_id,
      contact_id: t.contact_id,
      warranty_claim_id: t.warranty_claim_id,
      warranty_claim: claim || null,
      site_name: t.site_name,
      inv_name: t.inv_name,
      serial: t.serial,
      vendor: t.vendor,
      fail_type: t.fail_type,
      title: t.title,
      description: t.description,
      diagnosis: ev.diagnosis || ev.why || t.description || t.title,
      status: t.status,
      severity: t.severity,
      source: t.source,
      pipeline_stage: stage,
      pipeline_label: STAGE_LABELS[stage] || stage,
      pipeline_index: Math.max(0, STAGES.indexOf(stage)),
      pipeline_stages: stageList(),
      next_action: nextAction(t, contact),
      evidence: ev,
      draft_checkin: t.draft_checkin || {},
      next_checkin_at: iso(t.next_checkin_at),
      last_checkin_at: iso(t.last_checkin_at),
      checkin_count: t.checkin_count || 0,
      checkin_interval_hours: t.checkin_interval_hours,
      scheduled_for: iso(t.scheduled_for),
      tech_note: t.tech_note,
      owner_looped_in_at: null,
      owner_looped_in: false,
      owner_loop_reason: null,
      opened_at: iso(t.opened_at),
      resolved_at: iso(t.resolved_at),
      cancelled_at: iso(t.cancelled_at),
      cleared_at: iso(t.cleared_at),
      created_at: iso(t.opened_at),
      updated_at: iso(t.updated_at),
      contact: contact ? serializeContact(contact) : null,
      tel_uri: phone ? "tel:" + phone : null,
      sms_uri_base: phone ? "sms:" + phone : null,
    };
  }

  function serializeCheckin(c) {
    return {
      id: c.id, ticket_id: c.ticket_id, contact_id: c.contact_id,
      channel: c.channel, direction: c.direction, subject: c.subject, body: c.body,
      sent_to: c.sent_to, cc_emails: c.cc_emails, sent_ok: !!c.sent_ok, via: c.via,
      created_at: iso(c.created_at),
    };
  }

  // repair_ops.recent_agent_activity
  function activity(B, limit) {
    var byT = {};
    B.tickets.forEach(function (t) { byT[t.id] = t; });
    var out = [];
    B.checkins.slice().sort(function (a, b) { return b.created_at - a.created_at; }).slice(0, limit).forEach(function (c) {
      var t = byT[c.ticket_id];
      var site = (t && t.site_name) || "";
      var inv = (t && (t.inv_name || t.serial)) || "";
      var ch = String(c.channel || "email").toLowerCase();
      var dir = String(c.direction || "outbound").toLowerCase();
      var via = String(c.via || "agent").toLowerCase();
      var verb;
      if (dir === "inbound") verb = "Repair team replied";
      else if (ch === "phone_note" || ch === "phone") verb = "Phone note logged";
      else if (ch === "sms") verb = "SMS logged";
      else if (dir === "note" || ch === "internal") verb = "Internal note";
      else if (via === "auto") verb = "Auto check-in sent";
      else if (via === "owner") verb = "You approved outreach";
      else verb = "Outreach sent";
      var summary = verb;
      if (site) summary += " · " + site;
      if (inv) summary += " / " + inv;
      if (c.sent_to && dir !== "inbound") summary += " → " + c.sent_to;
      out.push({
        id: c.id, ticket_id: c.ticket_id, at: iso(c.created_at), verb: verb, summary: summary,
        channel: ch, direction: dir, via: via, body_preview: String(c.body || "").slice(0, 240),
        site_name: site || null, sent_ok: !!c.sent_ok,
      });
    });
    B.tickets.slice().sort(function (a, b) { return b.updated_at - a.updated_at; }).slice(0, 30).forEach(function (t) {
      var site = t.site_name || "site";
      var inv = t.inv_name || t.serial || "inverter";
      if (t.opened_at && (t.source === "auto" || t.source === "agent")) {
        out.push({
          id: "open-" + t.id, ticket_id: t.id, at: iso(t.opened_at), verb: "Issue detected",
          summary: "Issue detected · " + site + " / " + inv + " (" + (t.fail_type || "fault") + ")",
          channel: "system", direction: "note", via: t.source || "auto",
          body_preview: t.title || "", site_name: t.site_name, sent_ok: true,
        });
      }
      if (t.resolved_at) {
        out.push({
          id: "resolve-" + t.id, ticket_id: t.id, at: iso(t.resolved_at), verb: "Case closed",
          summary: "Case closed · " + site + " / " + inv + " — repair verified or marked done",
          channel: "system", direction: "note", via: "agent",
          body_preview: String(t.tech_note || "").slice(0, 240), site_name: t.site_name, sent_ok: true,
        });
      } else if (t.cleared_at) {
        out.push({
          id: "clear-" + t.id, ticket_id: t.id, at: iso(t.cleared_at), verb: "Auto-cleared",
          summary: "Auto-cleared · " + site + " / " + inv + " — hardware recovered before outreach",
          channel: "system", direction: "note", via: "auto",
          body_preview: "", site_name: t.site_name, sent_ok: true,
        });
      }
    });
    out.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    return out.slice(0, limit);
  }

  function summarize(tickets) {
    var now = Date.now();
    var active = tickets.filter(function (t) { return has(ACTIVE, t.status); });
    var by = {};
    VALID_STATUSES.forEach(function (s) {
      var n = tickets.filter(function (t) { return t.status === s; }).length;
      if (n) by[s] = n;
    });
    return {
      open: active.length,
      by_status: by,
      awaiting_reply: tickets.filter(function (t) { return t.status === "waiting_reply"; }).length,
      scheduled: tickets.filter(function (t) { return t.status === "scheduled"; }).length,
      overdue_checkin: active.filter(function (t) { return t.next_checkin_at && t.next_checkin_at.getTime() <= now; }).length,
    };
  }

  // Hilltop Dairy's warranty claim (warranty_claims.build_evidence math with
  // the sample credit rate + FleetStore's $38/MWh REC value). Default send
  // mode files to the OWNER to forward (go_direct off), so sentTo is Dana.
  function hilltopClaim(t) {
    var rate = (window.AO_DEMO && window.AO_DEMO.creditRate) || 0.2576;
    var lostKwh = 151;
    var val = lostKwh * rate + (lostKwh / 1000) * 38;
    var lostMo = D.round(val / 14 * 30, 2), lostYr = D.round(val / 14 * 365, 2);
    return {
      id: 18, inverter_id: t.inverter_id, array_id: t.array_id,
      site: t.site_name, inv: t.inv_name, serial: t.serial,
      model: "CPS SCA6KTL-DO", vendor: "chint", nameplate: 6.0,
      failType: "fault", stage: "resolved", mode: "",
      evidence: { peerIndex: 0.61, lostKwh: lostKwh, lostMo: lostMo, lostYr: lostYr, daysDown: 0, peers: 9, windowDays: 14 },
      draft: {},
      recoveredUsd: Math.round(lostYr), autoResolved: false,
      sentVia: "manual", sentTo: ownerEmail(), sentDirect: false,
      sendAt: null, sentAt: isoZ(at(103, 7, 40)), resolvedAt: isoZ(t.resolved_at), createdAt: isoZ(at(104, 8, 41)),
      repair_ticket_id: t.id, repair_ticket_status: t.status,
    };
  }

  function claimsFor(B) {
    var t = null;
    B.tickets.forEach(function (x) { if (x.warranty_claim_id === 18) t = x; });
    if (!t) return { list: [], byId: {} };
    var c = hilltopClaim(t);
    var mini = {};
    mini[18] = { id: 18, stage: c.stage, fail_type: c.failType, site: c.site, inv: c.inv, serial: c.serial };
    return { list: [c], byId: mini };
  }

  // ── GET /v1/array-owners/ops ───────────────────────────────────────────
  function overview() {
    var B = book();
    var contacts = B.contacts.filter(function (c) { return c.active; });
    var claims = claimsFor(B);

    var rows = [];
    B.tickets.forEach(function (t) {
      if (t.status === "cleared") return;
      var contact = t.contact_id ? B.byId[t.contact_id] : null;
      var claim = t.warranty_claim_id ? claims.byId[t.warranty_claim_id] || null : null;
      rows.push(serializeTicket(t, contact, claim));
    });
    var activeRows = rows.filter(function (r) { return has(ACTIVE, r.status); });
    var closedRows = rows.filter(function (r) { return r.status === "resolved" || r.status === "cancelled"; }).slice(0, 12);

    // DB-only stand-in for sites_needing_repair (no fleet-tree on tab open).
    var needs = [], order = [], groups = {};
    B.tickets.forEach(function (t) {
      if (!has(ACTIVE, t.status)) return;
      if (!groups[t.array_id]) { groups[t.array_id] = []; order.push(t.array_id); }
      groups[t.array_id].push(t);
    });
    order.forEach(function (aid) {
      var ts = groups[aid];
      var contact = resolveContact(aid, B.byId, contacts);
      needs.push({
        array_id: aid,
        array_name: ts[0].site_name || "Array #" + aid,
        alert: { status: ts[0].fail_type || "open" },
        problem_inverters: ts.slice(0, 12).map(function (t) {
          return { inverter_id: t.inverter_id, name: t.inv_name, sn: t.serial, status: t.fail_type, diagnosis: t.title };
        }),
        contact: contact ? serializeContact(contact) : null,
        open_tickets: ts.map(function (t) { return serializeTicket(t, null, null); }),
        next_step: contact ? "Send check-in to assigned tech" : "Add a service contact then check in",
      });
    });

    var claimSummary = {
      open: 0, awaiting: 0, queued: 0, sent: 0, atStakeYr: 0,
      recovered: claims.list.reduce(function (s, c) { return s + (c.stage === "resolved" ? c.recoveredUsd : 0); }, 0),
      resolved: claims.list.filter(function (c) { return c.stage === "resolved"; }).length,
    };

    var arrays = D.sites().map(function (s) { return { id: s.id, name: s.name }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

    return {
      ok: true,
      settings: {
        checkin_mode: "manual",
        checkin_hours: CHECKIN_HOURS,
        auto_open: true,
        claim_send_mode: "manual",
        claim_grace_hours: 24,
      },
      contacts: contacts.map(serializeContact),
      assignments: assignments(B.byId),
      arrays: arrays,
      tickets: rows,
      active_cases: activeRows,
      recently_closed: closedRows,
      activity: activity(B, 50),
      pipeline_stages: stageList(),
      summary: summarize(B.tickets),
      sites_needing_repair: needs,
      warranty_claims: { claims: claims.list, summary: claimSummary },
      fleet_needs_included: false,
    };
  }

  D.get(/^\/v1\/array-owners\/ops$/, function () { return overview(); });

  // GET /v1/array-owners/ops/contacts (also read by hands-off-tour.js)
  D.get(/^\/v1\/array-owners\/ops\/contacts$/, function () {
    var B = book();
    return {
      ok: true,
      contacts: B.contacts.filter(function (c) { return c.active; }).map(serializeContact),
      assignments: assignments(B.byId),
    };
  });

  // GET /v1/array-owners/ops/tickets?status=&array_id=&active_only=
  D.get(/^\/v1\/array-owners\/ops\/tickets$/, function (req) {
    var B = book();
    var q = req.query;
    var status = q.get("status");
    var aid = Number(q.get("array_id")) || null;
    var activeOnly = q.get("active_only") && q.get("active_only") !== "0";
    var ts = B.tickets.filter(function (t) {
      if (activeOnly && !has(ACTIVE, t.status)) return false;
      if (status && t.status !== status) return false;
      if (aid && t.array_id !== aid) return false;
      return true;
    });
    return {
      ok: true,
      tickets: ts.map(function (t) { return serializeTicket(t, null, null); }),
      summary: summarize(ts),
    };
  });

  // GET /v1/array-owners/ops/tickets/{id}/checkins (the full email thread)
  D.get(/^\/v1\/array-owners\/ops\/tickets\/(\d+)\/checkins$/, function (req) {
    var B = book();
    var id = Number(req.match[1]);
    var found = B.tickets.some(function (t) { return t.id === id; });
    if (!found) return D.json({ detail: "Ticket not found" }, 404);
    var rows = B.checkins.filter(function (c) { return c.ticket_id === id; })
      .sort(function (a, b) { return b.created_at - a.created_at; })
      .slice(0, 100);
    return { ok: true, checkins: rows.map(serializeCheckin) };
  });
})();
