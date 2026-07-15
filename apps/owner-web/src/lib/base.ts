/** Vite base path — `/m/` in production, `/` in local dev without base override. */
export const APP_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

/** Absolute path under this app (for window.location, not react-router Link). */
export function appPath(path = "/"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!APP_BASE) return p;
  if (p === "/") return `${APP_BASE}/`;
  return `${APP_BASE}${p}`;
}
