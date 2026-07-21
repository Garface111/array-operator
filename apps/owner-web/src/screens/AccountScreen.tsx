import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchAccount } from "@/lib/api";
import { clearSession } from "@/lib/session";
import type { AccountInfo } from "@/lib/types";

const FEEDS = [
  {
    title: "Arrays / inverters",
    blurb: "SolarEdge, Locus, portal capture…",
    prompt:
      "Help me get arrays talking. Prefer one-click portal login. What's missing?",
  },
  {
    title: "Auto-refresh",
    blurb: "Cloud capture 24/7 without a browser tab.",
    prompt: "I want cloud auto-refresh. Walk me through saving a monitoring login.",
  },
  {
    title: "Utility bills",
    blurb: "GMP / SmartHub source of truth for invoices.",
    prompt: "Help me link utility bills so offtaker invoices have a real bill source.",
  },
  {
    title: "Online pay",
    blurb: "Stripe Connect for offtaker pay links.",
    prompt: "Walk me through Stripe Connect for offtaker online pay.",
  },
] as const;

export function AccountScreen() {
  const { openAgent } = useOutletAgent();
  const nav = useNavigate();
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchAccount()
      .then(setAcct)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Account</h1>
        <p className="text-sm font-medium text-muted">
          Profile · feeds · sign out
        </p>
      </div>

      {err ? <p className="text-xs font-semibold text-red-600">{err}</p> : null}

      <div className="ao-sheet p-4">
        <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-700">
          Signed in
        </div>
        <div className="mt-1 text-base font-extrabold text-ink">
          {acct?.company_name || acct?.name || "—"}
        </div>
        <div className="text-sm font-semibold text-muted">{acct?.email || "—"}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {acct?.product ? (
            <span className="ao-chip ao-chip-sky">{acct.product}</span>
          ) : null}
          {acct?.is_demo ? (
            <span className="ao-chip ao-chip-warn">demo</span>
          ) : (
            <span className="ao-chip ao-chip-good">live</span>
          )}
          {acct?.subscription_status ? (
            <span className="ao-chip ao-chip-muted">
              {String(acct.subscription_status)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="mt-3 text-xs font-extrabold text-sky-700"
          onClick={() =>
            openAgent("Summarize my account plan, billing, and auto-refresh status.")
          }
        >
          Account brief with Agent →
        </button>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-extrabold">Connect feeds</h2>
        <ul className="space-y-2">
          {FEEDS.map((f) => (
            <li key={f.title} className="ao-card p-3.5">
              <div className="font-extrabold text-sm">{f.title}</div>
              <p className="mt-0.5 text-[11px] font-semibold text-muted">{f.blurb}</p>
              <button
                type="button"
                className="mt-2 text-xs font-extrabold text-sky-700"
                onClick={() => openAgent(f.prompt)}
              >
                Set up with Agent →
              </button>
            </li>
          ))}
        </ul>
      </section>

      <button
        type="button"
        className="ao-btn-ghost w-full !text-red-600"
        onClick={() => {
          clearSession();
          nav("/login", { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );
}
