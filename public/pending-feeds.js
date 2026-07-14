/* ============================================================================
 * Pending feeds — optimistic "Connecting…" state after ANY inverter vendor connect.
 * Survives the onboarding → dashboard hop via localStorage, paints a loading
 * card on Inverters so a 30–60s portal walk / cloud harvest doesn't look like a
 * failure, and polls fleet-tree until arrays for that vendor appear (or we time out).
 *
 * Covered vendors: SolarEdge, Fronius, SMA, Chint, Locus, AlsoEnergy (and any
 * future inverter code registered in INVERTER_VENDORS). Utility meters are NOT
 * pending-feed cards — they refresh bills, not the Inverters sheet.
 * ========================================================================== */
(function () {
  "use strict";

  var KEY = "ao_pending_feeds";
  var MAX_AGE_MS = 5 * 60 * 1000; // drop after 5 min
  var POLL_MS = 3000;
  var MAX_POLLS = 50; // ~2.5 min of aggressive refresh

  var _pollTimer = null;
  var _pollCount = 0;

  /** Inverter monitoring portals only — utility meters use a different UX. */
  var INVERTER_VENDORS = {
    chint: "Chint / CPS",
    fronius: "Fronius",
    sma: "SMA",
    solaredge: "SolarEdge",
    locus: "Locus",
    alsoenergy: "AlsoEnergy",
  };

  // Back-compat alias used by older call sites
  var LABELS = INVERTER_VENDORS;

  function _now() {
    return Date.now();
  }

  function norm(vendor) {
    return String(vendor || "")
      .toLowerCase()
      .trim();
  }

  function isInverter(vendor) {
    return !!INVERTER_VENDORS[norm(vendor)];
  }

  function labelFor(vendor) {
    var v = norm(vendor);
    return INVERTER_VENDORS[v] || v || "Vendor";
  }

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      var now = _now();
      var keep = raw.filter(function (p) {
        return p && p.vendor && now - (p.at || 0) < MAX_AGE_MS;
      });
      if (keep.length !== raw.length) _writeSilent(keep);
      return keep;
    } catch (e) {
      return [];
    }
  }

  function _writeSilent(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function write(list) {
    _writeSilent(list);
    try {
      window.dispatchEvent(new CustomEvent("ao:pending-feeds", { detail: { list: list } }));
    } catch (e) {}
    try {
      if (window.__aoLoadVendorSheet) window.__aoLoadVendorSheet();
    } catch (e) {}
  }

  function mark(vendor, meta) {
    meta = meta || {};
    var v = norm(vendor);
    if (!v) return false;
    var list = read().filter(function (p) {
      return p.vendor !== v;
    });
    list.push({
      vendor: v,
      label: meta.label || labelFor(v),
      at: _now(),
      note: meta.note || null,
      sites: meta.sites != null ? meta.sites : null,
    });
    write(list);
    startPoll();
    return true;
  }

  /** Prefer this from connect UIs — skips utilities so Inverters doesn't show a GMP skeleton. */
  function markInverter(vendor, meta) {
    if (!isInverter(vendor)) return false;
    meta = meta || {};
    if (!meta.label) meta.label = labelFor(vendor);
    return mark(vendor, meta);
  }

  function clear(vendor) {
    var v = norm(vendor);
    if (!v) {
      write([]);
      stopPoll();
      return;
    }
    var next = read().filter(function (p) {
      return p.vendor !== v;
    });
    write(next);
    if (!next.length) stopPoll();
  }

  function list() {
    return read();
  }

  function has(vendor) {
    var v = norm(vendor);
    return read().some(function (p) {
      return p.vendor === v;
    });
  }

  /** Drop pending rows once that vendor has arrays (or inverters) in the live fleet. */
  function reconcile(arrays) {
    arrays = arrays || [];
    var present = {};
    arrays.forEach(function (a) {
      var v = norm(a.vendor);
      if (v) present[v] = (present[v] || 0) + 1;
      // also count inverter vendors nested under arrays
      (a.inverters || []).forEach(function (inv) {
        var iv = norm(inv.vendor);
        if (iv) present[iv] = (present[iv] || 0) + 1;
      });
    });
    var before = read();
    var next = before.filter(function (p) {
      return !present[p.vendor];
    });
    if (next.length !== before.length) {
      write(next);
      if (!next.length) stopPoll();
    }
  }

  function stopPoll() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    _pollCount = 0;
  }

  function startPoll() {
    if (_pollTimer) return;
    if (!read().length) return;
    _pollCount = 0;
    // Immediate pull — capture may already have landed
    _tick();
    _pollTimer = setInterval(_tick, POLL_MS);
  }

  function _tick() {
    _pollCount++;
    var pending = read();
    if (!pending.length || _pollCount > MAX_POLLS) {
      stopPoll();
      if (_pollCount > MAX_POLLS) {
        // Expire leftovers so we don't spin forever
        write([]);
      }
      return;
    }
    try {
      if (window.FleetStore && typeof FleetStore.refetch === "function") {
        FleetStore.refetch().then(function () {
          try {
            var snap = FleetStore.snapshot && FleetStore.snapshot();
            reconcile((snap && snap.arrays) || []);
          } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // Boot: if page loads mid-connect, keep polling
  function boot() {
    if (read().length) startPoll();
    // Reconcile whenever fleet store notifies
    try {
      if (window.FleetStore && FleetStore.subscribe) {
        FleetStore.subscribe(function (s, kind) {
          if (kind === "live" || kind === "triage") return;
          try {
            reconcile((s && s.arrays) || (FleetStore.snapshot() || {}).arrays || []);
          } catch (e) {}
        });
      }
    } catch (e) {}
  }

  window.__aoPendingFeeds = {
    mark: mark,
    markInverter: markInverter,
    clear: clear,
    list: list,
    has: has,
    isInverter: isInverter,
    labelFor: labelFor,
    reconcile: reconcile,
    startPoll: startPoll,
    labels: LABELS,
    inverterVendors: INVERTER_VENDORS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
