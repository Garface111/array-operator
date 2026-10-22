/* Sample account · Fleet routes (loaded only for signed-out visitors by
 * demo-api.js). The Fleet tab itself runs on FleetStore's simulated fleet; this
 * file answers the per-inverter reads that fleet doesn't carry, shaped exactly
 * like the backend (api/inverter_outage_log.py build_outage_log). */
(function () {
  "use strict";
  var D = window.AO_DEMO_API;
  if (!D) return;

  var WINDOW_DAYS = 180;

  function findInv(id) {
    try {
      var hit = window.FleetStore && FleetStore.findInv && FleetStore.findInv(id);
      return hit ? { a: hit.a, i: hit.i } : null;
    } catch (e) { return null; }
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  // Past, closed episodes, chosen so the outage log never contradicts Repairs:
  //  · PINNED: the exact episodes the sample repairs book (demo/repairs.js)
  //    closed cases on, same inverter, same days, same ticket id.
  //  · Storms: a site-wide trip hits EVERY inverter on that site the same day.
  //  · Per-unit noise: only things that need no repair case (a grid fault the
  //    unit cleared itself, a vendor reporting gap). A dead unit with no case
  //    would be a story hole, so random "unit" outages are never invented.
  var PINNED = {
    14: { ago: 119, len: 4, kind: "unit", statuses: [], codes: [],
      cause: "This inverter alone read zero while its 11 neighbours produced normally, so it was the unit or its breaker, not the grid. Its AC breaker had tripped at the panel; the O&M tech reset it on the next site visit.",
      ticket: { id: 212, title: "Inverter down", severity: "critical", status: "resolved", note: "Closed when the unit came back" } },
    191: { ago: 38, len: 4, kind: "unit", statuses: ["Over-temperature"], codes: [],
      cause: "This inverter alone read zero while its 11 neighbours produced. It had shut down on over-temperature: a wasp nest was blocking the fan intake. Cleared and restarted on the next site visit.",
      ticket: { id: 333, title: "Inverter down", severity: "critical", status: "resolved", note: "Closed when the unit came back" } },
    9: { ago: 15, len: 1, kind: "vendor_code", statuses: ["Fault"], codes: ["GRID OV 3001"],
      cause: "The inverter reported a grid over-voltage fault and shut itself off; it reconnected on its own once the line settled.",
      ticket: { id: 371, title: "Inverter fault", severity: "warning", status: "resolved", note: "Cleared on its own before outreach" } },
  };
  var NOISE = [
    { kind: "vendor_code", codes: ["GRID OV 3001"], statuses: ["Fault"],
      cause: "The inverter reported a grid over-voltage fault and shut itself off; it reconnected on its own once the line settled." },
    { kind: "no_data", codes: [], statuses: [],
      cause: "The vendor portal sent no readings for this unit while its neighbours kept reporting. Production resumed with no gap in the utility meter, so this was a reporting outage, not lost energy." },
  ];
  var STORM_CAUSE = "Every inverter on the site stopped together, so this was the grid or the site's main breaker, not this unit. The utility logged a storm outage on the line that day.";

  function episode(ago, len, kind, cause, codes, statuses, lost, ticket) {
    return {
      started_on: D.isoDate(D.daysAgo(ago)), ended_on: D.isoDate(D.daysAgo(ago - len + 1)),
      days: len, ongoing: false, cause_kind: kind, cause: cause,
      vendor_codes: codes.slice(), vendor_statuses: statuses.slice(),
      lost_kwh_est: kind === "no_data" ? null : lost,
      lost_kwh_basis: kind === "no_data"
        ? "Not estimated: missing data is not zero production."
        : "Estimated from neighbouring inverters on the same site over the same days",
      ticket: ticket ? Object.assign({ created_at: D.isoDate(D.daysAgo(ago)) }, ticket) : null,
    };
  }

  function episodesFor(inv, arr) {
    var np = Number(inv.nameplate_kw) || 6;
    var perDay = np * 4.2;
    var eps = [];

    if (inv.status === "comm_gap") {
      var hrs = Number(inv.stale_hours) || 12;
      var days = Math.max(1, Math.round(hrs / 24));
      eps.push({
        started_on: D.isoDate(D.daysAgo(days)), ended_on: null, days: days, ongoing: true,
        cause_kind: "no_data",
        cause: "The vendor portal stopped sending readings for this unit " + hrs + " hours ago while the rest of " + arr.name + " kept reporting. That is usually the unit's comms card or its network link, not lost production; the next utility bill will confirm.",
        vendor_codes: [], vendor_statuses: [], lost_kwh_est: null,
        lost_kwh_basis: "Not estimated: missing data is not zero production.",
        ticket: null,
      });
    }

    // A site-wide storm trip (about a third of sites, one day each) lands on
    // EVERY inverter of that site, pinned ones included.
    var rs = D.rng("storm:" + arr.id);
    if (rs() < 0.3) {
      var sAgo = 20 + Math.floor(rs() * 140);
      eps.push(episode(sAgo, 1, "site_wide", STORM_CAUSE, [], [], D.round(perDay * 0.9, 1), null));
    }
    var pin = PINNED[inv.id];
    if (pin) {
      eps.push(episode(pin.ago, pin.len, pin.kind, pin.cause, pin.codes, pin.statuses,
        D.round(perDay * pin.len * 0.95, 1), pin.ticket));
    } else {
      // Occasional self-clearing noise on this unit.
      var r = D.rng("outages:" + inv.id);
      if (r() < 0.12) {
        var n = NOISE[r() < 0.5 ? 0 : 1];
        var nAgo = 10 + Math.floor(r() * 160);
        var nLen = n.kind === "no_data" ? 1 + Math.floor(r() * 2) : 1;
        eps.push(episode(nAgo, nLen, n.kind, n.cause, n.codes, n.statuses, D.round(perDay * nLen * 0.85, 1), null));
      }
    }
    // newest first, like the backend
    eps.sort(function (x, y) { return x.started_on < y.started_on ? 1 : -1; });
    return eps;
  }

  function summarize(eps) {
    if (!eps.length) {
      return {
        outage_days: 0, episode_count: 0, lost_kwh_est: null, lost_kwh_partial: false,
        longest: null, ongoing: false, ongoing_since: null,
        last_ended_on: null, days_since_last_outage: null,
        state: "clean",
        headline: "No outages in the last " + WINDOW_DAYS + " days — this inverter has run clean.",
      };
    }
    var total = 0, priced = [], longest = eps[0], live = null;
    eps.forEach(function (e) {
      total += e.days;
      if (e.lost_kwh_est != null) priced.push(e.lost_kwh_est);
      if (e.days > longest.days) longest = e;
      if (e.ongoing && !live) live = e;
    });
    var lost = priced.length ? D.round(priced.reduce(function (s, v) { return s + v; }, 0), 1) : null;
    var state, headline, lastEnded = null, since = null;
    if (live) {
      state = "ongoing";
      headline = "Offline now — down since " + live.started_on + " (" + plural(live.days, "day") + " and counting).";
    } else {
      state = "recovered";
      lastEnded = eps[0].ended_on;
      since = Math.round((Date.now() - new Date(lastEnded + "T12:00:00").getTime()) / 86400000);
      headline = "Running now — last outage ended " + lastEnded + " (" + plural(since, "day") + " ago).";
    }
    return {
      outage_days: total, episode_count: eps.length, lost_kwh_est: lost,
      lost_kwh_partial: priced.length !== eps.length,
      longest: { days: longest.days, started_on: longest.started_on, ended_on: longest.ended_on },
      ongoing: !!live, ongoing_since: live ? live.started_on : null,
      last_ended_on: lastEnded, days_since_last_outage: since,
      state: state, headline: headline,
    };
  }

  D.get(/^\/v1\/array-owners\/inverters\/(\d+)\/outages$/, function (req) {
    var hit = findInv(req.match[1]);
    if (!hit) return D.json({ detail: "Inverter not found" }, 404);
    var inv = hit.i, arr = hit.a;
    var eps = episodesFor(inv, arr);
    return {
      inverter: {
        id: inv.id, name: inv.name, serial: "NE" + (100000 + inv.id * 7919 % 900000),
        vendor: inv.vendor, nameplate_kw: inv.nameplate_kw,
        array_id: arr.id, array_name: arr.name,
      },
      window: {
        days: WINDOW_DAYS,
        start: D.isoDate(D.daysAgo(WINDOW_DAYS)), end: D.isoDate(D.daysAgo(1)),
        note: "Only complete days are judged — today is still in progress, and an inverter is legitimately dark every night.",
        first_data_on: D.isoDate(D.daysAgo(720)), evaluated_from: D.isoDate(D.daysAgo(WINDOW_DAYS)),
      },
      episodes: eps,
      peer_count: Math.max(0, (arr.inverters || []).length - 1),
      summary: summarize(eps),
    };
  });
})();
