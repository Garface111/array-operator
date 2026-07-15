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

  useEffect(() => {
    const onUnauthorized = () => setSessionState(null);
    const onStorage = () => setSessionState(getSession());
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("storage", onStorage);
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
