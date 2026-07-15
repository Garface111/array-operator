import { Link, useNavigate } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { disableDemoMode, isDemoMode } from "@/lib/demoData";
import { clearSession } from "@/lib/session";

const LINKS: Array<{ to: string; label: string; hint: string }> = [
  { to: "/account", label: "Account & billing", hint: "Plan · card · key" },
  { to: "/analysis", label: "Analysis", hint: "Trends · peer" },
  { to: "/connect", label: "Connect feeds", hint: "API · cloud · pay" },
  { to: "/fleet", label: "Fleet", hint: "Arrays · inverters" },
  { to: "/invoices", label: "Invoices", hint: "Offtakers" },
  { to: "/", label: "Home overview", hint: "Pulse" },
];

export function MoreScreen() {
  const { openAgent } = useOutletAgent();
  const nav = useNavigate();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">More</h1>
        <p className="text-sm text-slate-800/75">
          Account, analysis, and sign-out.
        </p>
      </div>
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          You are in demo mode —{" "}
          <Link to="/login" className="underline">
            sign in
          </Link>{" "}
          for live data.
        </div>
      ) : null}

      <ul className="ao-card divide-y divide-white/40 overflow-hidden">
        {LINKS.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="flex w-full items-center justify-between px-4 py-3.5 text-sm font-bold"
            >
              {item.label}
              <span className="text-[11px] font-semibold text-muted">
                {item.hint}
              </span>
            </Link>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold"
            onClick={() =>
              openAgent(
                "What's left for hands-off setup on my account? Check arrays, cloud, utility, invoices, and pay."
              )
            }
          >
            Hands-off checklist
            <span className="text-[11px] font-semibold text-muted">Agent</span>
          </button>
        </li>
        <li>
          <a
            href="/?desktop=1"
            className="flex w-full items-center justify-between px-4 py-3.5 text-sm font-bold"
          >
            Desktop site
            <span className="text-[11px] font-semibold text-muted">
              Full canvas
            </span>
          </a>
        </li>
        <li>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold text-red-700"
            onClick={() => {
              clearSession();
              disableDemoMode();
              nav("/login", { replace: true });
            }}
          >
            {isDemoMode() ? "Exit demo" : "Sign out"}
          </button>
        </li>
      </ul>
      <p className="text-[11px] leading-relaxed text-muted">
        Mobile beta at <code className="font-mono">/m</code>. Same account and
        API as desktop.
      </p>
    </div>
  );
}
