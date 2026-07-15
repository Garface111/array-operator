import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { StatCard } from "@/components/StatCard";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  fetchAccount,
  fetchFleetTree,
  fetchOnboardingStatus,
  fetchOverview,
  fetchSendPipeline,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { fmtKwh, fmtMoney, statusTone } from "@/lib/format";
import type {
  AccountMe,
  FleetTree,
  OnboardingStatus,
  Overview,
  SendPipeline,
} from "@/lib/types";

export function HomeScreen() {
  const { openAgent } = useOutletAgent();
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tree, setTree] = useState<FleetTree | null>(null);
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [onb, setOnb] = useState<OnboardingStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [a, o, t, p, ob] = await Promise.all([
          fetchAccount().catch(() => null),
          fetchOverview().catch(() => null),
          fetchFleetTree().catch(() => null),
          fetchSendPipeline().catch(() => null),
          fetchOnboardingStatus().catch(() => null),
        ]);
        if (cancelled) return;
        setAccount(a);
        setOverview(o);
        setTree(t);
        setPipe(p);
        setOnb(ob);
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
      if (tone === "warn" || tone === "bad")
        rows.push({ name, status: st || "attention" });
      (
        a as { inverters?: Array<{ name?: string; status?: string }> }
      ).inverters?.forEach((inv) => {
        const t = statusTone(inv.status);
        if (t === "warn" || t === "bad")
          rows.push({
            name: `${name} · ${inv.name || "inverter"}`,
            status: String(inv.status || "attention"),
          });
      });
    });
    return rows.slice(0, 6);
  }, [tree, overview]);

  if (loading) {
    return (
      <div className="space-y-3 py-8 text-center text-sm font-semibold text-muted">
        Loading your fleet…
      </div>
    );
  }

  const company =
    account?.company_name || account?.name || "Your fleet";

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2.5 text-xs font-semibold text-amber-950 shadow-sm backdrop-blur-md">
          Demo data —{" "}
          <Link to="/login" className="underline">
            sign in
          </Link>{" "}
          for live fleet, invoices, and Agent tools.
        </div>
      ) : null}

      {!isDemoMode() && onb && !onb.complete ? (
        <Link
          to="/connect"
          className="block rounded-2xl border border-sky-300/60 bg-sky-50/60 px-3.5 py-2.5 text-xs font-semibold text-sky-950 shadow-sm backdrop-blur-md"
        >
          Finish setup — next: {onb.next_step || "connect a feed"} →
        </Link>
      ) : null}

      <section className="drop-shadow-sm">
        <p className="text-[11px] font-bold uppercase tracking-wider text-sky-800">
          Fleet triage
        </p>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
          {company}
        </h1>
        <p className="text-sm font-medium text-slate-800/75">
          Whole-fleet health, production pulse, and needs-attention queue.
        </p>
      </section>

      {err ? (
        <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700 backdrop-blur-sm">
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
              ? `~${fmtMoney(stats.valueToday)} value`
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
              "What needs attention on my fleet right now? Name arrays/inverters, why, and the next step."
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

      <section className="ao-card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-white/45 bg-white/25 px-3.5 py-3">
          <div
            className="h-10 w-10 shrink-0 rounded-full shadow-md ring-2 ring-white/50"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-extrabold">Energy Agent</div>
            <div className="text-xs text-muted">
              Small adjustments · fleet & invoices
            </div>
          </div>
          <button
            type="button"
            className="ao-btn-primary !min-h-9 !px-3 !text-xs"
            onClick={() => openAgent()}
          >
            Chat
          </button>
        </div>
        <div className="flex flex-wrap gap-2 p-3">
          {[
            "What's left for hands-off setup?",
            "Brief me on fleet health.",
            "How did offtaker invoices go?",
          ].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => openAgent(q)}
              className="rounded-full border border-white/55 bg-white/45 px-3 py-1.5 text-left text-[11px] font-semibold text-sky-950 shadow-sm backdrop-blur-md"
            >
              {q}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Attention queue</h2>
          <Link to="/inverters" className="text-xs font-bold text-sky-700">
            Inverters →
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
        <Link to="/inverters" className="ao-btn-ghost text-center text-xs">
          Inverters
        </Link>
        <Link to="/invoices" className="ao-btn-ghost text-center text-xs">
          Invoices
        </Link>
      </div>
    </div>
  );
}
