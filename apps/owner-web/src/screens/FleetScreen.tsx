import { useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree } from "@/lib/api";
import { statusTone } from "@/lib/format";
import type { FleetTree } from "@/lib/types";

export function FleetScreen() {
  const { openAgent } = useOutletAgent();
  const [tree, setTree] = useState<FleetTree | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchFleetTree()
      .then(setTree)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  const arrays = tree?.arrays || [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">Fleet</h1>
        <p className="text-sm text-muted">Arrays and inverter health at a glance.</p>
      </div>
      {err ? (
        <p className="text-xs font-semibold text-red-600">{err}</p>
      ) : null}
      {arrays.length === 0 && !err ? (
        <div className="ao-card p-4 text-sm text-muted">
          No arrays yet.{" "}
          <button
            type="button"
            className="font-bold text-sky-700"
            onClick={() =>
              openAgent("Help me connect my first array or inverter portal.")
            }
          >
            Ask Agent to connect →
          </button>
        </div>
      ) : null}
      <ul className="space-y-2.5">
        {arrays.map((a) => {
          const tone = statusTone(String(a.status || ""));
          const invs = a.inverters || [];
          return (
            <li key={String(a.id || a.name)} className="ao-card p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-extrabold">{a.name || "Array"}</div>
                  <div className="text-xs text-muted">
                    {invs.length} inverter{invs.length === 1 ? "" : "s"}
                  </div>
                </div>
                <span
                  className={[
                    "ao-chip",
                    tone === "good"
                      ? "bg-emerald-100 text-emerald-800"
                      : tone === "warn"
                        ? "bg-amber-100 text-amber-900"
                        : tone === "bad"
                          ? "bg-red-100 text-red-800"
                          : "bg-slate-100 text-slate-600",
                  ].join(" ")}
                >
                  {a.status || "unknown"}
                </span>
              </div>
              {invs.length ? (
                <ul className="mt-3 space-y-1.5 border-t border-line pt-2">
                  {invs.slice(0, 8).map((inv) => (
                    <li
                      key={String(inv.id || inv.name)}
                      className="flex justify-between gap-2 text-xs"
                    >
                      <span className="font-semibold text-ink">
                        {inv.name || "Inverter"}
                      </span>
                      <span className="text-muted">{inv.status || "—"}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                className="mt-3 text-xs font-bold text-sky-700"
                onClick={() =>
                  openAgent(
                    `Focus on array ${a.name}. Summarize health and anything I should do.`
                  )
                }
              >
                Ask Agent about this array →
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
