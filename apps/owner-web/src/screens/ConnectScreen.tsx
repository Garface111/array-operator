import { useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchAccount, fetchCloudStatus, fetchFleetTree } from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { relTime } from "@/lib/format";
import type { AccountMe, CloudStatus, FleetTree } from "@/lib/types";

export function ConnectScreen() {
  const { openAgent } = useOutletAgent();
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [tree, setTree] = useState<FleetTree | null>(null);

  useEffect(() => {
    Promise.all([
      fetchAccount().catch(() => null),
      fetchCloudStatus().catch(() => null),
      fetchFleetTree().catch(() => null),
    ]).then(([a, c, t]) => {
      setAccount(a);
      setCloud(c);
      setTree(t);
    });
  }, []);

  const creds = cloud?.credentials || [];
  const invLogins = creds.filter((c) =>
    /chint|fronius|sma|solaredge|locus/i.test(String(c.provider || ""))
  );
  const utilLogins = creds.filter((c) =>
    /gmp|vec|wec|smarthub|utility/i.test(String(c.provider || ""))
  );
  const nArrays = tree?.arrays?.length || 0;
  const mode = account?.capture_mode || "—";

  const cards = [
    {
      id: "arrays",
      title: "Arrays / inverters",
      status: nArrays > 0 ? `${nArrays} sites` : "Not connected",
      ok: nArrays > 0,
      blurb: "Live production feed from vendor portals or API keys.",
      prompt:
        "Help me get arrays talking. Prefer one-click portal login. What's missing?",
    },
    {
      id: "autorefresh",
      title: "Auto-refresh",
      status:
        invLogins.length > 0
          ? `${invLogins.length} login${invLogins.length === 1 ? "" : "s"} · ${mode}`
          : `Off · mode ${mode}`,
      ok: invLogins.some((c) => c.enabled && c.last_harvest_ok !== false),
      blurb: "Cloud capture so data stays fresh without a browser tab.",
      prompt:
        "I want cloud auto-refresh. Walk me through saving a monitoring login.",
      detail: invLogins
        .map(
          (c) =>
            `${c.provider}: ${c.last_harvest_ok === false ? "issue" : "ok"} · ${relTime(c.last_harvest_at)}`
        )
        .join(" · "),
    },
    {
      id: "utility",
      title: "Utility bills",
      status:
        utilLogins.length > 0
          ? `${utilLogins.length} utility login${utilLogins.length === 1 ? "" : "s"}`
          : "No utility linked",
      ok: utilLogins.length > 0,
      blurb: "Source of truth for offtaker invoices (GMP / SmartHub).",
      prompt:
        "Help me link utility bills so invoices have a real bill source.",
    },
    {
      id: "pay",
      title: "Online pay",
      status: "Ask Agent",
      ok: false,
      blurb: "Stripe Connect so offtakers can pay from the email.",
      prompt:
        "Do I need online pay enabled? Check status and walk me through Connect if needed.",
    },
  ];

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-950">
          Demo connect status
        </div>
      ) : null}
      <div>
        <h1 className="text-lg font-extrabold">Connect</h1>
        <p className="text-sm text-muted">
          Hands-off feeds. Green means live data is landing.
        </p>
      </div>
      <ul className="space-y-2.5">
        {cards.map((f) => (
          <li key={f.id} className="ao-card p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="font-extrabold">{f.title}</div>
              <span
                className={[
                  "ao-chip",
                  f.ok
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-100 text-slate-600",
                ].join(" ")}
              >
                {f.status}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{f.blurb}</p>
            {f.detail ? (
              <p className="mt-1 text-[11px] font-medium text-sky-800/80">
                {f.detail}
              </p>
            ) : null}
            <button
              type="button"
              className="mt-3 text-xs font-bold text-sky-700"
              onClick={() => openAgent(f.prompt)}
            >
              Set up with Agent →
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
