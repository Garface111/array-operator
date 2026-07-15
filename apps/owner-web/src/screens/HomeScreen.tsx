import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  DemoBanner,
  EmptyCard,
  KpiTile,
  MeterBar,
  SectionHead,
  StatusPill,
} from "@/components/ui";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  fetchAccount,
  fetchFleetTree,
  fetchOnboardingStatus,
  fetchOverview,
  fetchSendPipeline,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import {
  fmtKwh,
  fmtMoney,
  fmtPower,
  livePctOfNameplate,
  statusLabel,
  statusTone,
} from "@/lib/format";
import type {
  AccountMe,
  FleetTree,
  OnboardingStatus,
  Overview,
  SendPipeline,
} from "@/lib/types";

type AttnRow = {
  key: string;
  name: string;
  status: string;
  tone: ReturnType<typeof statusTone>;
  meta?: string;
  diagnosis?: string;
};

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
          setErr(e instanceof Error ? e.message : "Could not load fleet");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const kpis = useMemo(() => {
    const arrays = tree?.arrays || overview?.arrays || [];
    const nArrays =
      overview?.totals?.array_count ?? arrays.length;
    let inv = 0;
    let bad = 0;
    let warn = 0;
    let power = 0;
    let nameplate = 0;

    arrays.forEach((a) => {
      const invs =
        (a as { inverters?: Array<{ status?: string; current_power_w?: number }> })
          .inverters || [];
      if (invs.length) {
        invs.forEach((row) => {
          inv += 1;
          const t = statusTone(row.status || (a as { status?: string }).status);
          if (t === "bad") bad += 1;
          else if (t === "warn") warn += 1;
          if (row.current_power_w != null) power += Number(row.current_power_w);
        });
      } else {
        const t = statusTone((a as { status?: string }).status);
        if (t === "bad") bad += 1;
        else if (t === "warn") warn += 1;
      }
      const pw = (a as { current_power_w?: number }).current_power_w;
      if (pw != null && !invs.some((i) => i.current_power_w != null))
        power += Number(pw);
      const np = (a as { nameplate_kw?: number }).nameplate_kw;
      if (np) nameplate += Number(np);
    });

    const peer = overview?.peer_summary;
    if (peer) {
      // Prefer peer rollup when present (desktop does too)
      if (peer.dead != null) bad = peer.dead;
      if (peer.underperforming != null) warn = peer.underperforming;
      if (peer.ok != null && inv === 0) inv = (peer.ok || 0) + bad + warn;
    }

    const flagged = bad + warn;
    const gradeable = inv || nArrays;
    const healthyN = Math.max(0, gradeable - flagged);
    const healthyPct =
      gradeable > 0 ? Math.round((healthyN / gradeable) * 100) : null;

    const todayKwh = overview?.totals?.today_kwh;
    const valueToday = overview?.totals?.value_today as number | undefined;
    // Rough recoverable: value_today scaled by underperformance — honest when we
    // only have peer flags (desktop prices real loss; we show watch + $ today).
    const riskHint =
      bad > 0
        ? "Critical units may be losing production"
        : warn > 0
          ? "Soft flags — confirm before dispatch"
          : "No priced loss detected";

    const last = pipe?.last;
    const delivered = last?.delivered ?? last?.sent;

    return {
      nArrays,
      inv: inv || gradeable,
      bad,
      warn,
      flagged,
      healthyPct,
      healthyN,
      power: overview?.totals?.current_power_w != null
        ? Number(overview.totals.current_power_w)
        : power,
      nameplate,
      todayKwh,
      valueToday,
      riskHint,
      delivered,
      enabled: pipe?.total_enabled,
      mode: pipe?.default_delivery_mode || "—",
      period: last?.period_label || last?.period_month || null,
      source: overview?.source,
    };
  }, [overview, tree, pipe]);

  const attention = useMemo(() => {
    const rows: AttnRow[] = [];
    (tree?.arrays || overview?.arrays || []).forEach((a) => {
      const name = String(a.name || "Array");
      const st = String(a.status || "");
      const tone = statusTone(st);
      const diag = String(
        (a as { diagnosis?: string }).diagnosis ||
          (a as { peer?: { diagnosis?: string } }).peer?.diagnosis ||
          ""
      );
      if (tone === "warn" || tone === "bad") {
        rows.push({
          key: `a-${a.id || name}`,
          name,
          status: st || "attention",
          tone,
          meta: [
            (a as { today_kwh?: number }).today_kwh != null
              ? `${fmtKwh((a as { today_kwh?: number }).today_kwh)} today`
              : null,
            (a as { peer_index?: number }).peer_index != null
              ? `peer ${Number((a as { peer_index?: number }).peer_index).toFixed(2)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          diagnosis: diag || undefined,
        });
      }
      (
        a as {
          inverters?: Array<{
            id?: string | number;
            name?: string;
            status?: string;
            peer_index?: number | null;
            diagnosis?: string;
          }>;
        }
      ).inverters?.forEach((inv) => {
        const t = statusTone(inv.status);
        if (t === "warn" || t === "bad")
          rows.push({
            key: `i-${inv.id || inv.name}-${name}`,
            name: `${name} · ${inv.name || "inverter"}`,
            status: String(inv.status || "attention"),
            tone: t,
            meta:
              inv.peer_index != null
                ? `peer ${Number(inv.peer_index).toFixed(2)}`
                : undefined,
            diagnosis: inv.diagnosis,
          });
      });
    });
    // Worst first
    rows.sort((x, y) => {
      const rank = (t: string) => (t === "bad" ? 0 : t === "warn" ? 1 : 2);
      return rank(x.tone) - rank(y.tone);
    });
    return rows.slice(0, 12);
  }, [tree, overview]);

  if (loading) {
    return (
      <div className="space-y-3 py-8 text-center text-sm font-semibold text-muted">
        Loading fleet…
      </div>
    );
  }

  const company =
    account?.company_name || account?.name || "Your fleet";
  const healthTone =
    kpis.healthyPct == null
      ? "muted"
      : kpis.healthyPct > 80
        ? "good"
        : kpis.healthyPct > 50
          ? "warn"
          : "bad";
  const livePct = livePctOfNameplate(kpis.power, kpis.nameplate || null);

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <DemoBanner>
          Demo fleet —{" "}
          <Link to="/login" className="underline">
            sign in
          </Link>{" "}
          for live numbers.
        </DemoBanner>
      ) : null}

      {!isDemoMode() && onb && !onb.complete ? (
        <Link
          to="/connect"
          className="block rounded-2xl border border-sky-300/60 bg-sky-50/60 px-3.5 py-2.5 text-xs font-semibold text-sky-950 shadow-sm backdrop-blur-md"
        >
          Finish setup — next: {onb.next_step?.replace(/_/g, " ") || "connect a feed"} →
        </Link>
      ) : null}

      <section className="drop-shadow-sm">
        <p className="text-[11px] font-bold uppercase tracking-wider text-sky-800">
          Fleet
        </p>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
          {company}
        </h1>
        <p className="text-sm font-medium text-slate-800/75">
          {kpis.source === "live" || (!isDemoMode() && kpis.nArrays > 0)
            ? "Live from your connected arrays"
            : isDemoMode()
              ? "Sample data for review"
              : "Production health at a glance"}
        </p>
      </section>

      {err ? (
        <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700">
          {err}
        </div>
      ) : null}

      {/* Desktop-style commander KPI grid */}
      <div className="grid grid-cols-2 gap-2">
        <KpiTile
          label="Fleet healthy"
          value={
            kpis.healthyPct == null ? "—" : `${kpis.healthyPct}%`
          }
          meta={
            kpis.healthyPct == null
              ? "Collecting history"
              : `${kpis.healthyN} of ${kpis.inv} units clear`
          }
          tone={healthTone}
        />
        <div className="ao-card space-y-1.5 p-3">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Now · today
          </div>
          <div className="text-[17px] font-extrabold text-slate-900">
            {fmtPower(kpis.power)}
          </div>
          <div className="text-[11px] font-medium text-muted">
            {fmtKwh(kpis.todayKwh)}
            {kpis.valueToday != null
              ? ` · ~${fmtMoney(kpis.valueToday)} value`
              : ""}
          </div>
          <MeterBar
            pct={livePct}
            tone={
              livePct == null
                ? "muted"
                : livePct < 5
                  ? "muted"
                  : livePct < 40
                    ? "warn"
                    : "good"
            }
          />
          {livePct != null ? (
            <div className="text-[10px] font-semibold text-muted">
              {Math.round(livePct)}% of nameplate
              {kpis.nameplate ? ` · ${kpis.nameplate} kW` : ""}
            </div>
          ) : null}
        </div>
        <KpiTile label="Arrays" value={String(kpis.nArrays)} meta="on file" />
        <KpiTile
          label="Inverters"
          value={String(kpis.inv)}
          meta={`across ${kpis.nArrays} array${kpis.nArrays === 1 ? "" : "s"}`}
        />
        <KpiTile
          label="Flagged"
          value={String(kpis.flagged)}
          meta={kpis.flagged ? "need attention below" : "none right now"}
          tone={kpis.flagged ? "warn" : "good"}
          onClick={() =>
            openAgent(
              "What needs attention on my fleet right now? Name arrays/inverters, why, and the next step."
            )
          }
        />
        <KpiTile
          label="Critical"
          value={String(kpis.bad)}
          meta={kpis.bad ? "stopped or faulted" : "no hard outages"}
          tone={kpis.bad ? "bad" : "good"}
        />
        <KpiTile
          label="Watch"
          value={String(kpis.warn)}
          meta={kpis.warn ? "underperforming / quiet" : "nothing on watch"}
          tone={kpis.warn ? "warn" : "good"}
        />
        <KpiTile
          label="Offtaker send"
          value={
            kpis.enabled
              ? kpis.delivered != null
                ? `${kpis.delivered}/${kpis.enabled}`
                : `${kpis.enabled}`
              : "—"
          }
          meta={
            kpis.period
              ? `${kpis.period} · ${kpis.mode}`
              : `Mode · ${kpis.mode}`
          }
        />
      </div>

      <p className="text-[11px] font-medium text-muted px-0.5">
        {kpis.riskHint}
        {kpis.valueToday != null
          ? ` · Today’s production value ~${fmtMoney(kpis.valueToday)}.`
          : ""}
      </p>

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
              Brief fleet health or adjust offtakers
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
            "Brief me on fleet health.",
            "What's left for hands-off setup?",
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
        <SectionHead
          title={
            attention.length
              ? "Needs attention"
              : "No items need attention"
          }
          sub={
            attention.length
              ? "Worst first · tap for Agent"
              : "Fleet looks clear"
          }
          action={
            <button
              type="button"
              className="text-xs font-bold text-sky-800"
              onClick={() =>
                openAgent(
                  "Walk the full fleet: every array and inverter, peer index, and anything flagged."
                )
              }
            >
              Ask Agent →
            </button>
          }
        />
        {attention.length === 0 ? (
          <EmptyCard>
            Nothing flagged. Ask Agent anytime for a deeper fleet brief.
          </EmptyCard>
        ) : (
          <ul className="space-y-2">
            {attention.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  className="ao-card flex w-full flex-col gap-1 px-3.5 py-3 text-left"
                  onClick={() =>
                    openAgent(
                      `Help me with ${row.name} (status: ${row.status}). What's wrong and what should I do?`
                    )
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-bold leading-snug">
                      {row.name}
                    </span>
                    <StatusPill status={statusLabel(row.status)} tone={row.tone} />
                  </div>
                  {row.meta ? (
                    <div className="text-[11px] font-medium text-muted">
                      {row.meta}
                    </div>
                  ) : null}
                  {row.diagnosis ? (
                    <div className="text-[11px] leading-snug text-slate-800/85">
                      {row.diagnosis}
                    </div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
