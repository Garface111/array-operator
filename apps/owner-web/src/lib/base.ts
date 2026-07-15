/** Vite base path — `/m/` in production web beta, `./` or `/` for native store builds. */
export const APP_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

/**
 * Absolute origin for API + static site assets when the app is not same-origin
 * (Capacitor WebView loads from https://localhost or capacitor://).
 * Web beta leaves this empty so `/v1/*` stays same-origin via Netlify proxy.
 */
export const API_ORIGIN = String(import.meta.env.VITE_API_BASE || "").replace(
  /\/$/,
  ""
);

/** Public site origin for static JSON (resources, news) when bundled in native. */
export const SITE_ORIGIN = String(
  import.meta.env.VITE_SITE_ORIGIN || API_ORIGIN || ""
).replace(/\/$/, "");

export function isNativeShell(): boolean {
  try {
    // Capacitor injects this; also detect custom scheme / localhost WebView
    const w = window as Window & {
      Capacitor?: { isNativePlatform?: () => boolean };
    };
    if (w.Capacitor?.isNativePlatform?.()) return true;
  } catch {
    /* ignore */
  }
  return !!API_ORIGIN;
}

/** Absolute path under this app (for window.location, not react-router Link). */
export function appPath(path = "/"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!APP_BASE || APP_BASE === ".") {
    // Relative base (native): stay on hash-less paths under WebView root
    return p === "/" ? "/" : p;
  }
  if (p === "/") return `${APP_BASE}/`;
  return `${APP_BASE}${p}`;
}

/** Resolve API or site-relative path for fetch(). */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_ORIGIN}${p}`;
}

/** Resolve public site assets (resources-data.json, fonts, etc.). */
export function siteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  if (SITE_ORIGIN) return `${SITE_ORIGIN}${p}`;
  return p;
}
