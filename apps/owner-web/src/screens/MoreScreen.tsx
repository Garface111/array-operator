import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { clearSession } from "@/lib/session";
import { useNavigate } from "react-router-dom";

export function MoreScreen() {
  const { openAgent } = useOutletAgent();
  const nav = useNavigate();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">More</h1>
        <p className="text-sm text-muted">Analysis, account, and sign-out.</p>
      </div>
      <ul className="ao-card divide-y divide-line overflow-hidden">
        <li>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold"
            onClick={() =>
              openAgent(
                "Open Analysis for me conceptually: weather-expected vs actual, what to check first if yield feels off."
              )
            }
          >
            Analysis / Trends
            <span className="text-muted">Agent</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold"
            onClick={() =>
              openAgent("Summarize my account plan, billing, and auto-refresh status.")
            }
          >
            Account
            <span className="text-muted">Agent</span>
          </button>
        </li>
        <li>
          <Link
            to="/"
            className="flex w-full items-center justify-between px-4 py-3.5 text-sm font-bold"
          >
            Home overview
            <span className="text-muted">→</span>
          </Link>
        </li>
        <li>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold text-red-600"
            onClick={() => {
              clearSession();
              nav("/login", { replace: true });
            }}
          >
            Sign out
          </button>
        </li>
      </ul>
      <p className="text-[11px] leading-relaxed text-muted">
        This React app is on branch <code className="font-mono">feat/owner-react</code>{" "}
        under <code className="font-mono">apps/owner-web</code>. Production desktop{" "}
        <code className="font-mono">public/</code> is unchanged.
      </p>
    </div>
  );
}
