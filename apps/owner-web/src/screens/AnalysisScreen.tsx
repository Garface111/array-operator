import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  fetchFleetForecast,
  fetchFleetTrends,
  fetchOverview,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { fmtKwh, fmtMoney } from "@/lib/format";
import type { FleetForecast, FleetTrends, Overview } from "@/lib/types";

export function AnalysisScreen() {
  const { openAgent } = useOutletAgent();
  const [trends, setTrends] = useState<FleetTrends | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [forecast, setForecast] = useState<FleetForecast | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchFleetTrends().catch((e) => {
        throw e;
      }),
      fetchOverview().catch(() => null),
      fetchFleetForecast(14).catch(() => null),
    ])
      .then(([t, o, f]) => {
        setTrends(t);
        setOverview(o);
        setForecast(f);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  const peer = overview?.peer_summary;
  const yoy = (trends?.seasonal_yoy || []).slice(0, 6);
  const ratio =
    forecast?.ratio != null ? Number(forecast.ratio) : null;
  const ratioPct =
    ratio != null && Number.isFinite(ratio)
      ? `${(ratio * 100).toFixed(0)}%`
      : null;
  const ratioTone =
    ratio == null
      ? "muted"
      : ratio >= 0.95
        ? "good"
        : ratio >= 0.85
          ? "warn"
          : "bad";

  const rows = (forecast?.arrays || [])
    .filter((a) => a.available !== false)
    .slice()
    .sort((a, b) => (Number(a.ratio) || 99) - (Number(b.ratio) || 99))
    .slice(0, 12);

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
          Production vs expected · trends · peer health.
        </p>
      </div>

      {loading ? (
        <p className="text-sm font-semibold text-muted">Loading analysis…</p>
      ) : null}
      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}

      {/* NOC: production vs expected */}
      <section className="ao-card space-y-3 p-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Production vs expected</h2>
          <span className="text-[10px] font-bold uppercase text-muted">
            {forecast?.window_days || 14}d
          </span>
        </div>
        {forecast?.available === false ||
        (forecast &&
          forecast.expected_kwh == null &&
          !rows.length &&
          (forecast.skipped || []).length > 0) ? (
          <p className="text-xs text-muted">
            Forecast not fully available yet — need nameplate + location (or
            expected kWh/kW) on arrays.{" "}
            <button
              type="button"
              className="font-bold text-sky-800"
              onClick={() =>
                openAgent(
                  "Help me get production-vs-expected working. What's missing — location, nameplate, or expected ratio?"
                )
              }
            >
              Ask Agent →
            </button>
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] font-extrabold uppercase text-muted">
                  Actual
                </div>
                <div className="mt-0.5 text-sm font-extrabold">
                  {fmtKwh(forecast?.actual_kwh)}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-extrabold uppercase text-muted">
                  Expected
                </div>
                <div className="mt-0.5 text-sm font-extrabold">
                  {fmtKwh(
                    forecast?.expected_matched_kwh ?? forecast?.expected_kwh
                  )}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-extrabold uppercase text-muted">
                  Ratio
                </div>
                <div
                  className={[
                    "mt-0.5 text-sm font-extrabold",
                    ratioTone === "good"
                      ? "text-emerald-800"
                      : ratioTone === "warn"
                        ? "text-amber-800"
                        : ratioTone === "bad"
                          ? "text-red-800"
                          : "",
                  ].join(" ")}
                >
                  {ratioPct || "—"}
                </div>
              </div>
            </div>
            {forecast?.kwh_per_kw_day != null ? (
              <p className="text-[11px] font-medium text-muted">
                Fleet ~{Number(forecast.kwh_per_kw_day).toFixed(2)} kWh/kW/day
              </p>
            ) : null}
          </>
        )}
      </section>

      {rows.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-extrabold">Sites (worst first)</h2>
          <ul className="space-y-2">
            {rows.map((a) => {
              const r = a.ratio != null ? Number(a.ratio) : null;
              const tone =
                r == null
                  ? "muted"
                  : r >= 0.95
                    ? "good"
                    : r >= 0.85
                      ? "warn"
                      : "bad";
              return (
                <li
                  key={String(a.array_id || a.array_name)}
                  className="ao-card flex items-center justify-between gap-2 px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">
                      {a.array_name || "Array"}
                    </div>
                    <div className="text-[11px] text-muted">
                      {fmtKwh(a.actual_kwh)} / {fmtKwh(a.expected_kwh)}
                      {a.kwh_per_kw_day != null
                        ? ` · ${Number(a.kwh_per_kw_day).toFixed(1)} kWh/kW`
                        : ""}
                    </div>
                  </div>
                  <span
                    className={[
                      "ao-chip shrink-0",
                      tone === "good"
                        ? "bg-emerald-100 text-emerald-900"
                        : tone === "warn"
                          ? "bg-amber-100 text-amber-950"
                          : tone === "bad"
                            ? "bg-red-100 text-red-900"
                            : "bg-white/50 text-slate-700",
                    ].join(" ")}
                  >
                    {r != null ? `${(r * 100).toFixed(0)}%` : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
          {(forecast?.skipped || []).length > 0 ? (
            <p className="text-[11px] text-muted">
              {forecast!.skipped!.length} site
              {forecast!.skipped!.length === 1 ? "" : "s"} skipped (no model
              inputs).
            </p>
          ) : null}
        </section>
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
          <h2 className="text-sm font-extrabold">Lifetime by array</h2>
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
            "Brief me on fleet analysis: production vs expected, underperformers, and what to check first."
          )
        }
      >
        Ask Agent for analysis brief
      </button>
    </div>
  );
}
