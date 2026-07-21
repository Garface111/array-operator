import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { passwordLogin, requestMagicLink, rearmUnauthorized } from "@/lib/api";
import { getSession, setSession } from "@/lib/session";

export function LoginScreen() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Already signed in (e.g. phone handoff from desktop so_session) → go home.
  useEffect(() => {
    if (getSession()) nav("/", { replace: true });
  }, [nav]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (mode === "magic") {
        await requestMagicLink(email.trim());
        setMsg("Check your email for a sign-in link.");
      } else {
        const res = await passwordLogin(email.trim(), password);
        if (!res.session_token) throw new Error("No session returned");
        setSession(res.session_token);
        rearmUnauthorized();
        nav("/", { replace: true });
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <div
          className="mx-auto mb-4 h-14 w-14 rounded-full shadow-lg"
          style={{
            background:
              "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
          }}
        />
        <h1 className="text-xl font-extrabold tracking-tight">Array Operator</h1>
        <p className="mt-1 text-sm text-muted">
          Phone-first fleet & offtaker ops · Energy Agent
        </p>
      </div>

      <form onSubmit={onSubmit} className="ao-card space-y-3 p-4">
        <label className="block">
          <span className="text-xs font-bold text-muted">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 outline-none ring-sky-500 focus:ring-2"
          />
        </label>
        {mode === "password" ? (
          <label className="block">
            <span className="text-xs font-bold text-muted">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 outline-none ring-sky-500 focus:ring-2"
            />
          </label>
        ) : null}
        <button type="submit" disabled={busy} className="ao-btn-primary w-full">
          {busy
            ? "Working…"
            : mode === "password"
              ? "Sign in"
              : "Email me a link"}
        </button>
        <button
          type="button"
          className="ao-btn-ghost w-full !text-xs"
          onClick={() =>
            setMode((m) => (m === "password" ? "magic" : "password"))
          }
        >
          {mode === "password" ? "Use magic link instead" : "Use password instead"}
        </button>
        {msg ? (
          <p className="text-center text-xs font-semibold text-emerald-700">{msg}</p>
        ) : null}
        {err ? (
          <p className="text-center text-xs font-semibold text-red-600">{err}</p>
        ) : null}
      </form>

      <p className="mt-6 text-center text-[11px] text-muted">
        Same account as arrayoperator.com · does not replace the desktop site
      </p>
    </div>
  );
}
