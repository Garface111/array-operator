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

/**
 * Magic-link / hand-off: `?token=` is a one-time login token, NOT a session.
 * Exchange via /v1/auth/verify, store session_token, scrub URL.
 * Returns a promise so AuthGate can wait before deciding redirect.
 */
export async function captureTokenFromUrl(): Promise<string | null> {
  try {
    const u = new URL(window.location.href);
    const token = u.searchParams.get("token");
    if (!token) return getSession();

    u.searchParams.delete("token");
    const next = u.pathname + (u.search ? u.search : "") + u.hash;
    window.history.replaceState(null, "", next);

    try {
      const res = await fetch("/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const data = (await res.json()) as { session_token?: string };
        if (data.session_token) {
          setSession(data.session_token);
          try {
            localStorage.removeItem("ao_owner_demo");
          } catch {
            /* ignore */
          }
          return data.session_token;
        }
      }
    } catch {
      /* network — fall through */
    }

    // Family launchers sometimes mint a ready session into ?token=.
    // If verify fails, try using the token as a session (probe /v1/account).
    setSession(token);
    try {
      const probe = await fetch("/v1/account", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (probe.ok) {
        try {
          localStorage.removeItem("ao_owner_demo");
        } catch {
          /* ignore */
        }
        return token;
      }
    } catch {
      /* ignore */
    }
    clearSession();
    return null;
  } catch {
    return null;
  }
}
