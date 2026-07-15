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
  const [ready, setReady] = useState(false);
  const [session, setSessionState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await captureTokenFromUrl();
      if (cancelled) return;
      if (isDemoMode()) setSessionState("demo");
      else setSessionState(getSession());
      setReady(true);
    })();

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
    return () => {
      cancelled = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-16 text-sm font-semibold text-slate-800/80">
        Signing you in…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <Outlet />;
}
