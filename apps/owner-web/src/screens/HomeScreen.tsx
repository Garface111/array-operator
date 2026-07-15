import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { StatCard } from "@/components/StatCard";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree, fetchOverview, fetchSendPipeline } from "@/lib/api";
import { fmtKwh, fmtMoney, statusTone } from "@/lib/format";
import type { FleetTree, Overview, SendPipeline } from "@/lib/types";

export function HomeScreen() {
  const { openAgent } = useOutletAgent();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tree, setTree] = useState<FleetTree | null>(null);
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [o, t, p] = await Promise.all([
          fetchOverview().catch(() => null),
          fetchFleetTree().catch(() => null),
          fetchSendPipeline().catch(() => null),
        ]);
        if (cancelled) return;
        setOverview(o);
        setTree(t);
        setPipe(p);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not load home");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    const arrays = overview?.arrays || tree?.arrays || [];
    const nArrays = overview?.totals?.array_count ?? arrays.length;
    let inv = 0;
    let attn = 0;
    let dead = 0;
    (tree?.arrays || []).forEach((a) => {
      (a.inverters || []).forEach((invRow) => {
        inv += 1;
        const tone = statusTone(String(invRow.status || a.status || ""));
        if (tone === "bad") dead += 1;
        else if (tone === "warn") attn += 1;
      });
    });
    const peer = overview?.peer_summary;
    if (peer) {
      attn = peer.underperforming ?? attn;
      dead = peer.dead ?? dead;
    }
    const last = pipe?.last;
    const delivered = last?.delivered ?? last?.sent;
    const enabled = pipe?.total_enabled;
    return {
      nArrays,
      inv,
      attn,
      dead,
      todayKwh: overview?.totals?.today_kwh,
      valueToday: overview?.totals?.value_today,
      delivered,
      enabled,
      mode: pipe?.default_delivery_mode || "—",
      period: last?.period_label || last?.period_month || null,
    };
  }, [overview, tree, pipe]);

  const attention = useMemo(() => {
    const rows: { name: string; status: string }[] = [];
    (tree?.arrays || overview?.arrays || []).forEach((a) => {
      const name = String(a.name || "Array");
      const st = String(a.status || "");
      const tone = statusTone(st);
      if (tone === "warn" || tone === "bad") rows.push({ name, status: st || "attention" });
      (a as { inverters?: Array<{ name?: string; status?: string }> }).inverters?.forEach(
        (inv) => {
          const t = statusTone(inv.status);
          if (t === "warn" || t === "bad")
            rows.push({
              name: `${name} · ${inv.name || "inverter"}`,
              status: String(inv.status || "attention"),
            });
        }
      );
    });
    return rows.slice(0, 5);
  }, [tree, overview]);

  if (loading) {
    return (
      <div className="space-y-3 py-6 text-center text-sm font-semibold text-muted">
        Loading your fleet…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-lg font-extrabold tracking-tight">Overview</h1>
        <p className="text-sm text-muted">
          Current state of production and offtaker delivery.
        </p>
      </section>

      {err ? (
        <div className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          {err}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5">
        <StatCard
          label="Arrays"
          value={String(stats.nArrays)}
          meta={stats.inv ? `${stats.inv} inverters` : "Connect feeds"}
        />
        <StatCard
          label="Today"
          value={fmtKwh(stats.todayKwh)}
          meta={
            stats.valueToday != null
              ? `~${fmtMoney(stats.valueToday)} at stake`
              : "Production pulse"
          }
          tone={stats.dead ? "bad" : stats.attn ? "warn" : "good"}
        />
        <StatCard
          label="Needs attention"
          value={String(stats.attn + stats.dead)}
          meta={
            stats.dead
              ? `${stats.dead} hard · ${stats.attn} soft`
              : stats.attn
                ? "Underperforming / stale"
                : "All clear"
          }
          tone={stats.dead ? "bad" : stats.attn ? "warn" : "good"}
          onClick={() =>
            openAgent(
              "What needs attention on my fleet right now? Name arrays/inverters, why, and the next step. Use tools."
            )
          }
        />
        <StatCard
          label="Offtaker send"
          value={
            stats.enabled
              ? stats.delivered != null
                ? `${stats.delivered}/${stats.enabled}`
                : `${stats.enabled} live`
              : "—"
          }
          meta={
            stats.period
              ? `${stats.period} · ${stats.mode}`
              : `Mode · ${stats.mode}`
          }
        />
      </div>

      <section className="ao-card p-3.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-extrabold">Ask Energy Agent</h2>
          <button
            type="button"
            className="text-xs font-bold text-sky-700"
            onClick={() => openAgent()}
          >
            Open chat →
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            "What's left for hands-off setup?",
            "Brief me on fleet health.",
            "How did offtaker invoices go last cycle?",
          ].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => openAgent(q)}
              className="rounded-full border border-line bg-sky-50 px-3 py-1.5 text-left text-[11px] font-semibold text-sky-900"
            >
              {q}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Attention queue</h2>
          <Link to="/fleet" className="text-xs font-bold text-sky-700">
            Fleet →
          </Link>
        </div>
        {attention.length === 0 ? (
          <div className="ao-card px-3.5 py-4 text-sm text-muted">
            Nothing flagged. Open Agent anytime for a deeper brief.
          </div>
        ) : (
          <ul className="space-y-2">
            {attention.map((row) => (
              <li key={row.name}>
                <button
                  type="button"
                  className="ao-card flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
                  onClick={() =>
                    openAgent(
                      `Help me with ${row.name} (status: ${row.status}). What's wrong and what should I do?`
                    )
                  }
                >
                  <span className="text-sm font-bold">{row.name}</span>
                  <span className="ao-chip bg-amber-100 text-amber-900">
                    {row.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2 pb-2">
        <Link to="/connect" className="ao-btn-ghost text-center text-xs">
          Connect feeds
        </Link>
        <Link to="/invoices" className="ao-btn-ghost text-center text-xs">
          Invoices
        </Link>
      </div>
    </div>
  );
}
