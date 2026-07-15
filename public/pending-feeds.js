/* ============================================================================
 * Pending feeds, optimistic "Connecting…" state after ANY inverter vendor connect.
 * Survives the onboarding → dashboard hop via localStorage, paints a loading
 * card on Inverters so a 30–60s portal walk / cloud harvest doesn't look like a
 * failure, and polls fleet-tree until arrays for that vendor appear (or we time out).
 *
 * Covered vendors: SolarEdge, Fronius, SMA, Chint, Locus, AlsoEnergy.
 *
 * Stability: mark() is idempotent. write() only notifies when the vendor set OR
 * status changes. NEVER silently vanish a pending card, after long wait we mark
 * status=stuck/failed so the operator sees an honest outcome.
 * ========================================================================== */
(function () {
  "use strict";

  var KEY = "ao_pending_feeds";
  var MAX_AGE_MS = 12 * 60 * 1000; // keep card up to 12 min
  var POLL_MS = 5000;
  var MAX_POLLS = 72; // ~6 min of aggressive poll, then stuck (not gone)
  var STUCK_AFTER_MS = 90 * 1000; // soft "taking longer" after 90s

  var _pollTimer = null;
  var _pollCount = 0;
  var _lastSig = null;

  var INVERTER_VENDORS = {
    chint: "Chint / CPS",
    fronius: "Fronius",
    sma: "SMA",
    solaredge: "SolarEdge",
    locus: "Locus",
    alsoenergy: "AlsoEnergy",
  };

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

  /** Signature includes status so stuck/failed re-paints without remount thrash. */
  function signature(list) {
    return (list || [])
      .map(function (p) {
        return p.vendor + ":" + (p.status || "connecting");
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
      // Re-saving same vendor re-arms connecting (not stuck)
      if (meta.rearm || existing.status === "stuck" || existing.status === "failed") {
        existing.status = "connecting";
        existing.stuckMsg = null;
        existing.at = _now(); // fresh clock for new attempt
        changed = true;
      }
      rest.push(existing);
      if (changed) write(rest, true);
      startPoll();
      return true;
    }

    rest.push({
      vendor: v,
      label: meta.label || labelFor(v),
      at: _now(),
      note: meta.note || null,
      sites: meta.sites != null ? meta.sites : null,
      status: "connecting", // connecting | stuck | failed
      stuckMsg: null,
    });
    write(rest, true);
    startPoll();
    return true;
  }

  function markInverter(vendor, meta) {
    if (!isInverter(vendor)) return false;
    meta = meta || {};
    if (!meta.label) meta.label = labelFor(vendor);
    return mark(vendor, meta);
  }

  function setStatus(vendor, status, msg) {
    var v = norm(vendor);
    if (!v) return;
    var list = read();
    var hit = false;
    list.forEach(function (p) {
      if (p.vendor !== v) return;
      hit = true;
      if (p.status !== status || p.stuckMsg !== (msg || null)) {
        p.status = status;
        p.stuckMsg = msg || null;
      }
    });
    if (hit) write(list, true);
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
      write(next, true);
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

  function session() {
    try {
      return localStorage.getItem("so_session") || "";
    } catch (e) {
      return "";
    }
  }

  /** Enrich pending cards from cloud harvest health, login_failed etc. */
  async function enrichFromCloudStatus() {
    var tok = session();
    if (!tok) return;
    var pending = read();
    if (!pending.length) return;
    try {
      var r = await fetch("/v1/cloud-capture/status", {
        headers: { Authorization: "Bearer " + tok },
      });
      if (!r.ok) return;
      var d = await r.json();
      var byProv = {};
      (d.credentials || []).forEach(function (c) {
        if (!c || !c.provider) return;
        var k = norm(c.provider);
        // Prefer enabled / most recent fail signal
        if (!byProv[k] || c.last_harvest_at) byProv[k] = c;
      });
      var changed = false;
      var now = _now();
      pending.forEach(function (p) {
        var c = byProv[p.vendor];
        if (!c) {
          // Soft "taking longer" after 90s with no harvest attempt yet
          if (p.status === "connecting" && now - (p.at || 0) > STUCK_AFTER_MS) {
            p.status = "stuck";
            p.stuckMsg =
              "Still waiting for the first cloud harvest (usually under 2 minutes). We keep trying automatically.";
            changed = true;
          }
          return;
        }
        var st = String(c.last_harvest_status || "").toLowerCase();
        if (st === "login_failed" || st === "auth_failed") {
          if (p.status !== "failed") {
            p.status = "failed";
            p.stuckMsg =
              "Login failed, check username/password for this portal, then save again.";
            changed = true;
          }
        } else if (st === "scrape_failed" || st === "error") {
          if (p.status !== "stuck") {
            p.status = "stuck";
            p.stuckMsg =
              "Signed in, but we couldn’t read sites yet. Retrying automatically, large fleets can take a few minutes.";
            changed = true;
          }
        } else if (c.last_harvest_ok === true && p.status !== "connecting") {
          // Harvest said ok but arrays not in fleet yet, keep connecting copy
          p.status = "connecting";
          p.stuckMsg = null;
          changed = true;
        } else if (
          p.status === "connecting" &&
          now - (p.at || 0) > STUCK_AFTER_MS &&
          !c.last_harvest_at
        ) {
          p.status = "stuck";
          p.stuckMsg =
            "Queued for cloud harvest, first pull usually lands within a couple minutes.";
          changed = true;
        }
      });
      if (changed) write(pending, true);
    } catch (e) {}
  }

  function _tick() {
    _pollCount++;
    var pending = read();
    if (!pending.length) {
      stopPoll();
      return;
    }
    // After long poll: mark stuck, NEVER silently delete
    if (_pollCount > MAX_POLLS) {
      var now = _now();
      var ch = false;
      pending.forEach(function (p) {
        if (p.status === "connecting") {
          p.status = "stuck";
          p.stuckMsg =
            "Taking longer than usual. Your login is saved, open Account → Auto-refresh to check harvest status, or save the login again to retry.";
          ch = true;
        }
      });
      if (ch) write(pending, true);
      // Keep a slow poll so arrays can still clear the card if they land late
      if (_pollCount > MAX_POLLS + 24) {
        stopPoll();
        return;
      }
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
    enrichFromCloudStatus();
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
    setStatus: setStatus,
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
