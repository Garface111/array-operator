import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { passwordLogin, rearmUnauthorized, requestMagicLink } from "@/lib/api";
import { appPath } from "@/lib/base";
import { enableDemoMode } from "@/lib/demoData";
import { setSession } from "@/lib/session";

export function LoginScreen() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
        try {
          localStorage.removeItem("ao_owner_demo");
        } catch {
          /* ignore */
        }
        nav("/", { replace: true });
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  function enterDemo() {
    enableDemoMode();
    // Full navigation so AuthGate re-reads demo flag under /m base
    window.location.assign(appPath("/?demo=1"));
  }

  return (
    <div
      className="mx-auto flex h-full max-w-md flex-col justify-center overflow-y-auto px-5 py-10"
      style={{
        WebkitOverflowScrolling: "touch",
        paddingTop: "max(24px, env(safe-area-inset-top))",
        paddingBottom: "max(24px, env(safe-area-inset-bottom))",
      }}
    >
      <div className="mb-8 text-center drop-shadow-sm">
        <div
          className="mx-auto mb-4 h-14 w-14 rounded-full shadow-lg ring-2 ring-white/50"
          style={{
            background:
              "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
          }}
        />
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">
          Array Operator
        </h1>
        <p className="mt-1 text-sm font-medium text-slate-800/80">
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
            className="ao-input mt-1"
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
              className="ao-input mt-1"
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

      <button
        type="button"
        onClick={enterDemo}
        className="ao-card mt-4 w-full p-4 text-left transition active:scale-[0.99]"
      >
        <div className="text-sm font-extrabold text-sky-800">
          Preview demo fleet →
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Explore the phone UI with sample arrays, offtakers, and Agent — no
          account required. Production desktop site is unchanged.
        </p>
      </button>

      <p className="mt-6 text-center text-[11px] text-muted">
        Same account as arrayoperator.com · React app on feat/owner-react
      </p>
    </div>
  );
}
