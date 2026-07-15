import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { isDemoMode } from "@/lib/demoData";
import {
  captureTokenFromUrl,
  getSession,
  UNAUTHORIZED_EVENT,
} from "@/lib/session";

export function AuthGate() {
  const loc = useLocation();
  const [session, setSessionState] = useState<string | null>(() => {
    captureTokenFromUrl();
    if (isDemoMode()) return "demo";
    return getSession();
  });

  useEffect(() => {
    const onUnauthorized = () => {
      if (isDemoMode()) {
        setSessionState("demo");
        return;
      }
      setSessionState(null);
    };
    const onStorage = () =>
      setSessionState(isDemoMode() ? "demo" : getSession());
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("storage", onStorage);
    // ?demo=1 on any deep link
    if (isDemoMode()) setSessionState("demo");
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (!session) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <Outlet />;
}
