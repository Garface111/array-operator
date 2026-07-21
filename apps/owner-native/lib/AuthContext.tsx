import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { clearSession, getSession, setSession } from "./session";
import { passwordLogin as apiLogin, requestMagicLink } from "./api";

type AuthCtx = {
  ready: boolean;
  token: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  magicLink: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const t = await getSession();
    setToken(t);
  }, []);

  useEffect(() => {
    (async () => {
      await refresh();
      setReady(true);
    })();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email.trim(), password);
    if (!res.session_token) throw new Error("No session returned");
    await setSession(res.session_token);
    setToken(res.session_token);
  }, []);

  const magicLink = useCallback(async (email: string) => {
    await requestMagicLink(email.trim());
  }, []);

  const signOut = useCallback(async () => {
    await clearSession();
    setToken(null);
  }, []);

  const value = useMemo(
    () => ({ ready, token, signIn, magicLink, signOut, refresh }),
    [ready, token, signIn, magicLink, signOut, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
