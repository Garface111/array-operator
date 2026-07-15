import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTrends, fetchOverview } from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { fmtKwh, fmtMoney } from "@/lib/format";
import type { FleetTrends, Overview } from "@/lib/types";

export function AnalysisScreen() {
  const { openAgent } = useOutletAgent();
  const [trends, setTrends] = useState<FleetTrends | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchFleetTrends().catch((e) => {
        throw e;
      }),
      fetchOverview().catch(() => null),
    ])
      .then(([t, o]) => {
        setTrends(t);
        setOverview(o);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  const peer = overview?.peer_summary;
  const yoy = (trends?.seasonal_yoy || []).slice(0, 6);

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Demo analysis — sign in for your production history.
        </div>
      ) : null}

      <div>
        <h1 className="text-lg font-extrabold">Analysis</h1>
        <p className="text-sm text-slate-800/75">
          Portfolio production and peer health.
        </p>
      </div>

      {loading ? (
        <p className="text-sm font-semibold text-muted">Loading trends…</p>
      ) : null}
      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5">
        <div className="ao-card p-3.5">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Trailing 12 mo
          </div>
          <div className="mt-1 text-[15px] font-extrabold">
            {fmtKwh(trends?.ttm_kwh)}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {trends?.ttm_savings_usd != null
              ? `~${fmtMoney(trends.ttm_savings_usd)} value`
              : "Production"}
          </div>
        </div>
        <div className="ao-card p-3.5">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Lifetime
          </div>
          <div className="mt-1 text-[15px] font-extrabold">
            {fmtKwh(trends?.lifetime_kwh)}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {(trends?.years || []).join(" · ") || "Years of data"}
          </div>
        </div>
      </div>

      <section className="ao-card space-y-2 p-3.5">
        <h2 className="text-sm font-extrabold">Peer health</h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-lg font-extrabold text-emerald-800">
              {peer?.ok ?? "—"}
            </div>
            <div className="text-[10px] font-bold uppercase text-muted">OK</div>
          </div>
          <div>
            <div className="text-lg font-extrabold text-amber-800">
              {peer?.underperforming ?? peer?.arrays_attention ?? "—"}
            </div>
            <div className="text-[10px] font-bold uppercase text-muted">
              Soft
            </div>
          </div>
          <div>
            <div className="text-lg font-extrabold text-red-800">
              {peer?.dead ?? "—"}
            </div>
            <div className="text-[10px] font-bold uppercase text-muted">
              Hard
            </div>
          </div>
        </div>
        <Link to="/fleet" className="block text-xs font-bold text-sky-800">
          Open fleet →
        </Link>
      </section>

      {yoy.length ? (
        <section className="ao-card p-3.5">
          <h2 className="text-sm font-extrabold">Recent YoY</h2>
          <ul className="mt-2 space-y-1.5">
            {yoy.map((row) => (
              <li
                key={row.month || row.label}
                className="flex justify-between text-xs font-semibold"
              >
                <span>{row.label || `M${row.month}`}</span>
                <span
                  className={
                    row.latest_delta_pct != null && row.latest_delta_pct < 0
                      ? "text-amber-800"
                      : "text-emerald-800"
                  }
                >
                  {row.latest_delta_pct != null
                    ? `${row.latest_delta_pct > 0 ? "+" : ""}${Number(row.latest_delta_pct).toFixed(1)}%`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(trends?.by_array || []).length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-extrabold">By array</h2>
          <ul className="space-y-2">
            {(trends?.by_array || []).slice(0, 12).map((a) => (
              <li
                key={String(a.array_id || a.name)}
                className="ao-card flex items-center justify-between px-3.5 py-3"
              >
                <span className="text-sm font-bold">{a.name || "Array"}</span>
                <span className="text-xs font-semibold text-muted">
                  {fmtKwh(a.lifetime_kwh)} life
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <button
        type="button"
        className="ao-btn-primary w-full"
        onClick={() =>
          openAgent(
            "Brief me on fleet analysis: weather-expected vs actual if available, underperformers, and what to check first."
          )
        }
      >
        Ask Agent for analysis brief
      </button>
    </div>
  );
}
