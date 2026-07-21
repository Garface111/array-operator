import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  captureTokenFromUrl,
  getSession,
  UNAUTHORIZED_EVENT,
} from "@/lib/session";

export function AuthGate() {
  const loc = useLocation();
  const [session, setSessionState] = useState<string | null>(() => {
    captureTokenFromUrl();
    return getSession();
  });

  // Re-read after navigation (magic-link ?token= on a deep link) and on focus
  // so a desktop login in another tab/shell is picked up on the phone app.
  useEffect(() => {
    captureTokenFromUrl();
    setSessionState(getSession());
  }, [loc.pathname, loc.search]);

  useEffect(() => {
    const onUnauthorized = () => setSessionState(null);
    const onStorage = () => setSessionState(getSession());
    const onFocus = () => setSessionState(getSession());
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  if (!session) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <Outlet />;
}
