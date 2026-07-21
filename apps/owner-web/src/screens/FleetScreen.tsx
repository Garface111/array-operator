import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree, fetchOverview, adaptOverviewArrays } from "@/lib/api";
import { fmtKwh, statusTone } from "@/lib/format";
import type { FleetArray } from "@/lib/types";

export function FleetScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // Primary: fleet-tree (columns → arrays via adapter).
        // Fallback: overview arrays if tree is empty or fails.
        let list: FleetArray[] = [];
        try {
          const tree = await fetchFleetTree();
          list = tree.arrays || [];
        } catch (e) {
          if (!cancelled)
            setErr(e instanceof Error ? e.message : "Fleet tree load failed");
        }
        if (!list.length) {
          try {
            const ov = await fetchOverview();
            list = adaptOverviewArrays(ov);
          } catch (e) {
            if (!cancelled && !list.length)
              setErr(e instanceof Error ? e.message : "Load failed");
          }
        }
        if (!cancelled) setArrays(list);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">Fleet</h1>
        <p className="text-sm text-muted">Arrays and inverter health at a glance.</p>
      </div>
      {err ? (
        <p className="text-xs font-semibold text-red-600">{err}</p>
      ) : null}
      {loading ? (
        <div className="py-6 text-center text-sm font-semibold text-muted">
          Loading fleet…
        </div>
      ) : null}
      {!loading && arrays.length === 0 && !err ? (
        <div className="ao-card p-4 text-sm text-muted">
          No arrays yet.{" "}
          <Link to="/connect" className="font-bold text-sky-700">
            Connect feeds →
          </Link>{" "}
          or{" "}
          <button
            type="button"
            className="font-bold text-sky-700"
            onClick={() =>
              openAgent("Help me connect my first array or inverter portal.")
            }
          >
            Ask Agent →
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
                <div className="min-w-0">
                  <div className="font-extrabold">{a.name || "Array"}</div>
                  <div className="text-xs text-muted">
                    {invs.length
                      ? `${invs.length} inverter${invs.length === 1 ? "" : "s"}`
                      : a.vendor
                        ? String(a.vendor)
                        : "Array"}
                    {a.today_kwh != null ? ` · ${fmtKwh(a.today_kwh)} today` : ""}
                  </div>
                </div>
                <span
                  className={[
                    "ao-chip shrink-0",
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
                  {invs.slice(0, 12).map((inv) => (
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
                  {invs.length > 12 ? (
                    <li className="text-[11px] text-muted">
                      +{invs.length - 12} more
                    </li>
                  ) : null}
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
