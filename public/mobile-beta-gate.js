/**
 * Mobile beta gate — phones land on the React owner app at /m/.
 *
 * - max-width 960px (same band as mobile-os.js)
 * - Skip: ?desktop=1 (sticky), localStorage ao_force_desktop=1
 * - Force: ?mobile=1 clears desktop sticky
 * - Preserves query (?token=, ?demo=1) and hash
 * - Never redirects if already under /m/
 */
(function () {
  try {
    var path = location.pathname || "/";
    if (path === "/m" || path.indexOf("/m/") === 0) return;

    // Paths that stay on the vanilla site even on phones
    if (
      path.indexOf("/onboarding") === 0 ||
      path.indexOf("/paid") === 0 ||
      path.indexOf("/accounts") === 0
    ) {
      return;
    }

    var params = new URLSearchParams(location.search || "");
    if (params.get("mobile") === "1" || params.get("m") === "1") {
      try {
        localStorage.removeItem("ao_force_desktop");
      } catch (e) {}
      params.delete("mobile");
      params.delete("m");
    }
    if (params.get("desktop") === "1") {
      try {
        localStorage.setItem("ao_force_desktop", "1");
      } catch (e) {}
      // Stay on desktop; scrub flag from URL for cleanliness
      params.delete("desktop");
      var clean =
        location.pathname +
        (params.toString() ? "?" + params.toString() : "") +
        (location.hash || "");
      if (clean !== location.pathname + location.search + location.hash) {
        history.replaceState(null, "", clean);
      }
      return;
    }

    try {
      if (localStorage.getItem("ao_force_desktop") === "1") return;
    } catch (e) {}

    var narrow = false;
    try {
      narrow = !!(
        window.matchMedia &&
        window.matchMedia("(max-width: 960px)").matches
      );
    } catch (e) {
      narrow = Math.min(screen.width || 9999, window.innerWidth || 9999) <= 960;
    }
    if (!narrow) return;

    var q = params.toString();
    // Map vanilla entry routes onto the React app
    var destPath = "/m/";
    if (path === "/login" || path === "/signin" || path.indexOf("/login.") === 0) {
      destPath = "/m/login";
    }
    var dest = destPath + (q ? "?" + q : "") + (location.hash || "");
    location.replace(dest);
  } catch (e) {
    /* never block the desktop app */
  }
})();
