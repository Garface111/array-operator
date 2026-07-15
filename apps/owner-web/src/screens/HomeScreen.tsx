import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FleetSheet, mergeSheetArrays } from "@/components/FleetSheet";
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
import { countOnFile } from "@/lib/dataDomains";
import { readFleetCache, writeFleetCache } from "@/lib/fleetCache";
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

/**
 * Progressive load (speed):
 *  1. Paint from local cache immediately (if any)
 *  2. Overview first (array KPIs) — usually faster than fleet-tree
 *  3. Fleet-tree for inverter sheet (can be slower; never blocks first paint)
 *  4. Account / pipeline / onboarding deferred
 */
export function HomeScreen() {
  const { openAgent } = useOutletAgent();
  const cached = useMemo(() => (isDemoMode() ? null : readFleetCache()), []);

  const [account, setAccount] = useState<AccountMe | null>(null);
  const [overview, setOverview] = useState<Overview | null>(
    () => cached?.overview || null
  );
  const [tree, setTree] = useState<FleetTree | null>(
    () => cached?.tree || null
  );
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [onb, setOnb] = useState<OnboardingStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kpiLoading, setKpiLoading] = useState(!cached?.overview);
  const [sheetLoading, setSheetLoading] = useState(!cached?.tree);
  const [refreshing, setRefreshing] = useState(false);
  const [fromCache, setFromCache] = useState(!!cached);

  useEffect(() => {
    let cancelled = false;

    async function load(forceTree = false) {
      setErr(null);
      if (!overview) setKpiLoading(true);
      if (!tree) setSheetLoading(true);

      // Phase A — overview (KPIs) as soon as possible
      const ovP = fetchOverview()
        .then((o) => {
          if (cancelled) return;
          setOverview(o);
          setKpiLoading(false);
          setFromCache(false);
          writeFleetCache({ overview: o });
        })
        .catch((e) => {
          if (!cancelled && !overview)
            setErr(e instanceof Error ? e.message : "Could not load overview");
          if (!cancelled) setKpiLoading(false);
        });

      // Phase B — fleet-tree (inverter sheet) without blocking KPIs
      const treeP = fetchFleetTree(forceTree)
        .then((t) => {
          if (cancelled) return;
          setTree(t);
          setSheetLoading(false);
          setFromCache(false);
          writeFleetCache({ tree: t });
        })
        .catch(() => {
          if (!cancelled) setSheetLoading(false);
        });

      // Phase C — secondary, after a tick so A/B get network first
      const secondary = Promise.resolve().then(async () => {
        await Promise.all([
          fetchAccount()
            .then((a) => {
              if (!cancelled) setAccount(a);
            })
            .catch(() => null),
          fetchSendPipeline()
            .then((p) => {
              if (!cancelled) setPipe(p);
            })
            .catch(() => null),
          fetchOnboardingStatus()
            .then((o) => {
              if (!cancelled) setOnb(o);
            })
            .catch(() => null),
        ]);
      });

      await Promise.all([ovP, treeP, secondary]);
      if (!cancelled) setRefreshing(false);
    }

    void load(false);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    setSheetLoading(true);
    try {
      const [o, t] = await Promise.all([
        fetchOverview(),
        fetchFleetTree(true),
      ]);
      setOverview(o);
      setTree(t);
      writeFleetCache({ overview: o, tree: t });
      setFromCache(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
      setSheetLoading(false);
      setKpiLoading(false);
    }
  }

  // Vendor-monitored only — never utility-meter-only rows in Fleet / sheet
  const sheetArrays = useMemo(
    () => mergeSheetArrays(tree?.arrays, overview?.arrays),
    [tree, overview]
  );

  /** All arrays on file (vendor + utility) for "N of M" honesty, not for KPIs. */
  const onFileCount = useMemo(() => {
    const fromTree = countOnFile(tree?.arrays);
    const fromOv =
      overview?.totals?.array_count ?? countOnFile(overview?.arrays);
    return Math.max(fromTree, fromOv, sheetArrays.length);
  }, [tree, overview, sheetArrays.length]);

  const kpis = useMemo(() => {
    // Health / power / flags: vendor units only (desktop Fleet Health + Vendor Data)
    const arrays = sheetArrays;
    const nArrays = arrays.length;
    let inv = 0;
    let bad = 0;
    let warn = 0;
    let power = 0;
    let nameplate = 0;

    arrays.forEach((a) => {
      const invs = a.inverters || [];
      if (invs.length) {
        invs.forEach((row) => {
          inv += 1;
          const t = statusTone(row.status || a.status);
          if (t === "bad") bad += 1;
          else if (t === "warn") warn += 1;
          if (row.current_power_w != null) power += Number(row.current_power_w);
          if (row.nameplate_kw != null) nameplate += Number(row.nameplate_kw);
        });
      } else {
        const t = statusTone(a.status);
        if (t === "bad") bad += 1;
        else if (t === "warn") warn += 1;
        if (a.nameplate_kw) nameplate += Number(a.nameplate_kw);
      }
      if (
        a.current_power_w != null &&
        !invs.some((i) => i.current_power_w != null)
      ) {
        power += Number(a.current_power_w);
      }
    });

    const peer = overview?.peer_summary;
    // Prefer live inverter counts from the sheet; fall back to peer rollup
    if (inv === 0 && peer) {
      const ok = peer.ok ?? 0;
      const u = peer.underperforming ?? 0;
      const d = peer.dead ?? 0;
      inv = ok + u + d;
      if (peer.dead != null) bad = peer.dead;
      if (peer.underperforming != null) warn = peer.underperforming;
    }

    const flagged = bad + warn;
    const gradeable = inv || nArrays;
    const healthyN = Math.max(0, gradeable - flagged);
    const healthyPct =
      gradeable > 0 ? Math.round((healthyN / gradeable) * 100) : null;

    const totPower =
      overview?.totals?.current_power_w != null
        ? Number(overview.totals.current_power_w)
        : power;

    const last = pipe?.last;
    const delivered = last?.delivered ?? last?.sent;

    // Today kWh for VENDOR arrays only — don't smear utility bill estimates into fleet health
    const vendorToday = arrays.reduce(
      (s, a) => s + (Number(a.today_kwh) || 0),
      0
    );

    return {
      nArrays,
      onFile: onFileCount,
      inv: inv || gradeable,
      bad,
      warn,
      flagged,
      healthyPct,
      healthyN,
      power: totPower,
      nameplate,
      // Prefer sum of monitored arrays; fall back to overview total only if sheet empty
      todayKwh: arrays.length ? vendorToday : overview?.totals?.today_kwh,
      valueToday: overview?.totals?.value_today as number | undefined,
      delivered,
      enabled: pipe?.total_enabled,
      mode: pipe?.default_delivery_mode || "—",
      period: last?.period_label || last?.period_month || null,
      source: overview?.source,
    };
  }, [overview, sheetArrays, pipe, onFileCount]);

  const attention = useMemo(() => {
    // Attention queue is vendor/inverter only — utility offtaker issues live on Invoices
    const rows: AttnRow[] = [];
    sheetArrays.forEach((a) => {
      const name = String(a.name || "Array");
      const st = String(a.status || "");
      const tone = statusTone(st);
      const diag = String(a.diagnosis || "");
      if (tone === "warn" || tone === "bad") {
        rows.push({
          key: `a-${a.id || name}`,
          name,
          status: st || "attention",
          tone,
          meta: [
            a.today_kwh != null ? `${fmtKwh(a.today_kwh)} today` : null,
            a.peer_index != null
              ? `peer ${Number(a.peer_index).toFixed(2)}`
              : null,
            a.current_power_w != null ? fmtPower(a.current_power_w) : null,
          ]
            .filter(Boolean)
            .join(" · "),
          diagnosis: diag || undefined,
        });
      }
      (a.inverters || []).forEach((inv) => {
        const t = statusTone(inv.status);
        if (t === "warn" || t === "bad")
          rows.push({
            key: `i-${inv.id || inv.name}-${name}`,
            name: `${name} · ${inv.name || "inverter"}`,
            status: String(inv.status || "attention"),
            tone: t,
            meta: [
              inv.peer_index != null
                ? `peer ${Number(inv.peer_index).toFixed(2)}`
                : null,
              inv.current_power_w != null
                ? fmtPower(inv.current_power_w)
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
            diagnosis: inv.diagnosis ? String(inv.diagnosis) : undefined,
          });
      });
    });
    rows.sort((x, y) => {
      const r = (t: string) => (t === "bad" ? 0 : t === "warn" ? 1 : 2);
      return r(x.tone) - r(y.tone);
    });
    return rows.slice(0, 12);
  }, [sheetArrays]);

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
  const showSkeleton = kpiLoading && !overview && !tree;

  if (showSkeleton) {
    return (
      <div className="space-y-3 py-6 text-center text-sm font-semibold text-muted">
        Loading fleet…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <DemoBanner>
          Demo fleet —{" "}
          <Link to="/login" className="underline">
            sign in
          </Link>{" "}
          for live hardware numbers.
        </DemoBanner>
      ) : null}

      {!isDemoMode() && onb && !onb.complete ? (
        <Link
          to="/connect"
          className="block rounded-2xl border border-sky-300/60 bg-sky-50/60 px-3.5 py-2.5 text-xs font-semibold text-sky-950 shadow-sm backdrop-blur-md"
        >
          Finish setup — next:{" "}
          {onb.next_step?.replace(/_/g, " ") || "connect a feed"} →
        </Link>
      ) : null}

      <section className="flex items-start justify-between gap-2 drop-shadow-sm">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-sky-800">
            Fleet
          </p>
          <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
            {company}
          </h1>
          <p className="text-sm font-medium text-slate-800/75">
            {fromCache && (kpiLoading || sheetLoading)
              ? "Showing last snapshot · refreshing…"
              : isDemoMode()
                ? "Sample data for review"
                : overview || tree
                  ? "Live from your connected arrays"
                  : "Production health at a glance"}
          </p>
        </div>
        <button
          type="button"
          className="ao-btn-ghost !min-h-9 !px-3 !text-xs"
          disabled={refreshing || isDemoMode()}
          onClick={() => void onRefresh()}
        >
          {refreshing ? "…" : "Refresh"}
        </button>
      </section>

      {err ? (
        <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700">
          {err}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <KpiTile
          label="Fleet healthy"
          value={
            kpis.healthyPct == null ? "—" : `${kpis.healthyPct}%`
          }
          meta={
            kpis.healthyPct == null
              ? sheetLoading
                ? "Loading units…"
                : "Collecting history"
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
              {kpis.nameplate ? ` · ${kpis.nameplate.toFixed(0)} kW` : ""}
            </div>
          ) : null}
        </div>
        <KpiTile
          label="Monitored"
          value={String(kpis.nArrays)}
          meta={
            kpis.onFile > kpis.nArrays
              ? `${kpis.nArrays} vendor · ${kpis.onFile} on file`
              : "vendor arrays only"
          }
        />
        <KpiTile
          label="Inverters"
          value={String(kpis.inv)}
          meta={
            sheetLoading && !tree
              ? "Loading sheet…"
              : `across ${kpis.nArrays} vendor array${kpis.nArrays === 1 ? "" : "s"}`
          }
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

      {/* Spreadsheet-style inverter data (desktop Vendor Data) */}
      <FleetSheet
        arrays={sheetArrays}
        loading={sheetLoading && !sheetArrays.length}
        onAsk={(name, status) =>
          openAgent(
            `Help me with ${name} (status: ${status}). What's wrong and what should I do?`
          )
        }
      />

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
            Nothing flagged. Scroll the vendor sheet above for every unit.
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
                    <StatusPill
                      status={statusLabel(row.status)}
                      tone={row.tone}
                    />
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

      <section className="ao-card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-white/45 bg-white/25 px-3.5 py-3">
          <div
            className="h-9 w-9 shrink-0 rounded-full shadow-md ring-2 ring-white/50"
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
      </section>
    </div>
  );
}
