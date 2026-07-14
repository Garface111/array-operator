/* ============================================================================
 * Pending feeds — optimistic "Connecting…" state after ANY inverter vendor connect.
 * Survives the onboarding → dashboard hop via localStorage, paints a loading
 * card on Inverters so a 30–60s portal walk / cloud harvest doesn't look like a
 * failure, and polls fleet-tree until arrays for that vendor appear (or we time out).
 *
 * Covered vendors: SolarEdge, Fronius, SMA, Chint, Locus, AlsoEnergy (and any
 * future inverter code registered in INVERTER_VENDORS). Utility meters are NOT
 * pending-feed cards — they refresh bills, not the Inverters sheet.
 *
 * Stability: mark() is idempotent (won't reset `at` or re-fire UI thrash if the
 * vendor is already pending). write() only notifies when the vendor set changes.
 * ========================================================================== */
(function () {
  "use strict";

  var KEY = "ao_pending_feeds";
  var MAX_AGE_MS = 5 * 60 * 1000; // drop after 5 min
  var POLL_MS = 5000; // calm poll — UI no longer remounts on each tick
  var MAX_POLLS = 36; // ~3 min

  var _pollTimer = null;
  var _pollCount = 0;
  var _lastSig = null; // last notified vendor set signature

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

  function signature(list) {
    return (list || [])
      .map(function (p) {
        return p.vendor;
      })
      .sort()
      .join("|");
  }

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      var now = _now();
      var keep = raw.filter(function (p) {
        return p && p.vendor && now - (p.at || 0) < MAX_AGE_MS;
      });
      // Expire silently — don't notify (would flash empty/full). Callers poll.
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

  /**
   * Persist + notify UI only when the *set of vendors* changes.
   * Quiet ticks (same vendors still pending) never remount the Connecting card.
   */
  function write(list, forceNotify) {
    _writeSilent(list);
    var sig = signature(list);
    if (!forceNotify && sig === _lastSig) return;
    _lastSig = sig;
    try {
      window.dispatchEvent(
        new CustomEvent("ao:pending-feeds", { detail: { list: list, sig: sig } })
      );
    } catch (e) {}
    try {
      if (window.__aoLoadVendorSheet) window.__aoLoadVendorSheet();
    } catch (e) {}
  }

  function mark(vendor, meta) {
    meta = meta || {};
    var v = norm(vendor);
    if (!v) return false;
    var list = read();
    var existing = null;
    var rest = [];
    list.forEach(function (p) {
      if (p.vendor === v) existing = p;
      else rest.push(p);
    });

    // Already pending for this vendor — keep original `at` so the card doesn't
    // re-enter / re-shimmer, and skip a UI notify if nothing meaningful changed.
    if (existing) {
      var changed = false;
      if (meta.label && meta.label !== existing.label) {
        existing.label = meta.label;
        changed = true;
      }
      if (meta.note != null && meta.note !== existing.note) {
        existing.note = meta.note;
        changed = true;
      }
      if (meta.sites != null && meta.sites !== existing.sites) {
        existing.sites = meta.sites;
        changed = true;
      }
      rest.push(existing);
      if (changed) {
        // Force notify only for label/note changes — still same vendor set so
        // vendor-sheet will in-place update rather than remount if it can.
        write(rest, true);
      }
      startPoll();
      return true;
    }

    rest.push({
      vendor: v,
      label: meta.label || labelFor(v),
      at: _now(),
      note: meta.note || null,
      sites: meta.sites != null ? meta.sites : null,
    });
    write(rest, true); // new vendor → must paint card
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
      write([], true);
      stopPoll();
      return;
    }
    var next = read().filter(function (p) {
      return p.vendor !== v;
    });
    write(next, true);
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
      write(next, true); // set changed → drop card(s)
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
    _tick();
    _pollTimer = setInterval(_tick, POLL_MS);
  }

  function _tick() {
    _pollCount++;
    var pending = read();
    if (!pending.length || _pollCount > MAX_POLLS) {
      stopPoll();
      if (_pollCount > MAX_POLLS && pending.length) {
        write([], true);
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

  function boot() {
    _lastSig = signature(read());
    if (read().length) startPoll();
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
    signature: signature,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
