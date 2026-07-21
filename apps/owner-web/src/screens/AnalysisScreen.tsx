import { useEffect, useMemo, useState } from "react";
import { OutputGauge } from "@/components/OutputGauge";
import { Sparkline } from "@/components/Sparkline";
import { StatCard } from "@/components/StatCard";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree, fetchOverview } from "@/lib/api";
import {
  chipClass,
  fmtKwh,
  fmtKw,
  fmtMoney,
  statusTone,
} from "@/lib/format";
import type { FleetArray, Overview } from "@/lib/types";

export function AnalysisScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, o] = await Promise.all([
          fetchFleetTree().catch(() => null),
          fetchOverview().catch(() => null),
        ]);
        if (cancelled) return;
        setOverview(o);
        setArrays(t?.arrays || []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ranked = useMemo(() => {
    return [...arrays]
      .map((a) => {
        const invs = a.inverters || [];
        const peers = invs
          .map((i) => i.peer_index)
          .filter((p): p is number => p != null && Number.isFinite(p));
        const avgPeer =
          peers.length > 0
            ? peers.reduce((s, p) => s + p, 0) / peers.length
            : null;
        return { a, avgPeer };
      })
      .sort((x, y) => {
        const tx = statusTone(x.a.status);
        const ty = statusTone(y.a.status);
        const rank = (t: string) => (t === "bad" ? 0 : t === "warn" ? 1 : 2);
        const d = rank(tx) - rank(ty);
        if (d !== 0) return d;
        return (x.avgPeer ?? 1) - (y.avgPeer ?? 1);
      });
  }, [arrays]);

  const fleetSpark = useMemo(() => {
    // Sum daily across arrays when present
    const byDate = new Map<string, number>();
    arrays.forEach((a) => {
      (a.daily || []).forEach((d) => {
        if (!d?.date) return;
        byDate.set(d.date, (byDate.get(d.date) || 0) + Number(d.kwh || 0));
      });
    });
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, kwh]) => ({ date, kwh }));
  }, [arrays]);

  const attn = ranked.filter(
    (r) => statusTone(r.a.status) === "warn" || statusTone(r.a.status) === "bad"
  ).length;

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Analysis</h1>
        <p className="text-sm font-medium text-muted">
          Health, peers, and production pulse
        </p>
      </div>

      {err ? <p className="text-xs font-semibold text-red-600">{err}</p> : null}

      <div className="ao-sheet p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-700">
            Fleet trend
          </div>
          <Sparkline series={fleetSpark} width={140} height={32} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            label="Today"
            value={fmtKwh(overview?.totals?.today_kwh)}
            meta={
              overview?.totals?.today_usd != null
                ? `~${fmtMoney(overview.totals.today_usd)}`
                : "Production"
            }
            tone="good"
          />
          <StatCard
            label="Attention"
            value={String(
              overview?.peer_summary?.arrays_attention ?? attn
            )}
            meta="Arrays flagged"
            tone={attn ? "warn" : "good"}
          />
        </div>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Site ranking</h2>
          <button
            type="button"
            className="text-xs font-extrabold text-sky-700"
            onClick={() =>
              openAgent(
                "Brief me on fleet analysis: underperformers, peers, and what to check first."
              )
            }
          >
            Ask Agent →
          </button>
        </div>
        <ul className="space-y-2">
          {ranked.slice(0, 12).map(({ a, avgPeer }) => {
            const nameplate =
              a.nameplate_kw ||
              (a.inverters || []).reduce((s, i) => s + (i.nameplate_kw || 0), 0) ||
              null;
            return (
              <li key={String(a.id)} className="ao-card flex items-center gap-3 p-3">
                <OutputGauge
                  powerW={a.current_power_w}
                  nameplateKw={nameplate}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-extrabold">{a.name}</div>
                  <div className="text-[11px] font-semibold text-muted">
                    {fmtKw(a.current_power_w)} · {fmtKwh(a.today_kwh)} today
                    {avgPeer != null ? ` · peer ${avgPeer.toFixed(2)}` : ""}
                  </div>
                  <Sparkline series={a.daily} width={100} height={22} />
                </div>
                <span className={chipClass(statusTone(a.status))}>
                  {a.status || "—"}
                </span>
              </li>
            );
          })}
          {!ranked.length ? (
            <li className="ao-card p-4 text-sm text-muted">
              No fleet data yet for analysis.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
