/* Per-tab auth session (Array Operator).
 * so_session lived in localStorage, which is SHARED across all tabs of the origin
 * -- signing into a second account in a new tab clobbered the first tab's account,
 * and a logout in one tab switched the others. This routes the so_session key to
 * per-tab sessionStorage, seeded once from the shared localStorage default so a
 * fresh tab still inherits your current login, but each tab can hold a DIFFERENT
 * account. MUST load before any other script that touches so_session. */
(function () {
  var KEY = "so_session", LS, SS;
  try { LS = window.localStorage; SS = window.sessionStorage; } catch (e) { return; }
  if (!LS || !SS) return;
  try { if (SS.getItem(KEY) == null && LS.getItem(KEY) != null) SS.setItem(KEY, LS.getItem(KEY)); } catch (e) {}
  var _get = LS.getItem.bind(LS), _set = LS.setItem.bind(LS), _rm = LS.removeItem.bind(LS);
  LS.getItem = function (k) { return k === KEY ? SS.getItem(KEY) : _get(k); };
  LS.setItem = function (k, v) { if (k === KEY) { try { SS.setItem(KEY, v); } catch (e) {} try { _set(KEY, v); } catch (e) {} } else _set(k, v); };
  LS.removeItem = function (k) { if (k === KEY) { try { SS.removeItem(KEY); } catch (e) {} try { _rm(KEY); } catch (e) {} } else _rm(k); };
})();
