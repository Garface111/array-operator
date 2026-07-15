/** Same key as vanilla Array Operator + NEPOOL SPA — shared backend sessions. */
export const SESSION_KEY = "so_session";
export const UNAUTHORIZED_EVENT = "ao-owner-unauthorized";

export function getSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string): void {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Minted ?token= handoff (magic link / onboarding) → localStorage, scrub URL. */
export function captureTokenFromUrl(): string | null {
  try {
    const u = new URL(window.location.href);
    const token = u.searchParams.get("token");
    if (!token) return null;
    setSession(token);
    u.searchParams.delete("token");
    const next = u.pathname + (u.search ? u.search : "") + u.hash;
    window.history.replaceState(null, "", next);
    return token;
  } catch {
    return null;
  }
}
