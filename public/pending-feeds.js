/* ============================================================================
 * Pending feeds — optimistic "connecting…" state after a vendor portal connect.
 * Survives the onboarding → dashboard hop via localStorage, paints a loading
 * card on Inverters so a 30–40s Chint walk doesn't look like a failure, and
 * polls fleet-tree until arrays for that vendor appear (or we time out).
 * ========================================================================== */
(function () {
  "use strict";

  var KEY = "ao_pending_feeds";
  var MAX_AGE_MS = 5 * 60 * 1000; // drop after 5 min
  var POLL_MS = 3000;
  var MAX_POLLS = 50; // ~2.5 min of aggressive refresh

  var _pollTimer = null;
  var _pollCount = 0;

  var LABELS = {
    chint: "Chint / CPS",
    fronius: "Fronius",
    sma: "SMA",
    solaredge: "SolarEdge",
    locus: "Locus",
    alsoenergy: "AlsoEnergy",
  };

  function _now() {
    return Date.now();
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
    var v = String(vendor || "")
      .toLowerCase()
      .trim();
    if (!v) return;
    var list = read().filter(function (p) {
      return p.vendor !== v;
    });
    list.push({
      vendor: v,
      label: meta.label || LABELS[v] || v,
      at: _now(),
      note: meta.note || null,
      sites: meta.sites != null ? meta.sites : null,
    });
    write(list);
    startPoll();
  }

  function clear(vendor) {
    var v = String(vendor || "")
      .toLowerCase()
      .trim();
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
    var v = String(vendor || "").toLowerCase();
    return read().some(function (p) {
      return p.vendor === v;
    });
  }

  /** Drop pending rows once that vendor has arrays in the live fleet. */
  function reconcile(arrays) {
    arrays = arrays || [];
    var present = {};
    arrays.forEach(function (a) {
      var v = (a.vendor || "").toLowerCase();
      if (v) present[v] = (present[v] || 0) + 1;
      // also count inverter vendors nested under arrays
      (a.inverters || []).forEach(function (inv) {
        var iv = (inv.vendor || "").toLowerCase();
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
    clear: clear,
    list: list,
    has: has,
    reconcile: reconcile,
    startPoll: startPoll,
    labels: LABELS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
