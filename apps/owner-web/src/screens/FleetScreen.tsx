import { useEffect, useMemo, useState } from "react";
import { OutputGauge } from "@/components/OutputGauge";
import { PowerBar } from "@/components/PowerBar";
import { Sparkline } from "@/components/Sparkline";
import { StatCard } from "@/components/StatCard";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  adaptOverviewArrays,
  fetchFleetTree,
  fetchOverview,
} from "@/lib/api";
import {
  brandLabel,
  chipClass,
  fmtKwh,
  fmtKw,
  fmtMoney,
  statusTone,
} from "@/lib/format";
import type { FleetArray, Overview } from "@/lib/types";

type ViewMode = "cards" | "table";

export function FleetScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>("cards");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [tree, ov] = await Promise.all([
          fetchFleetTree().catch((e) => {
            if (!cancelled) setErr(e instanceof Error ? e.message : "Fleet load failed");
            return null;
          }),
          fetchOverview().catch(() => null),
        ]);
        if (cancelled) return;
        setOverview(ov);
        const list =
          tree?.arrays?.length ? tree.arrays : adaptOverviewArrays(ov);
        setArrays(list);
        if (!list.length && !err)
          setErr(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return arrays;
    return arrays.filter((a) => {
      const hay = [
        a.name,
        a.vendor,
        a.status,
        ...(a.inverters || []).map((i) => i.name),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(s);
    });
  }, [arrays, q]);

  const stats = useMemo(() => {
    let inv = 0;
    let attn = 0;
    let liveW = 0;
    filtered.forEach((a) => {
      inv += a.inverters?.length || 0;
      const t = statusTone(a.status);
      if (t === "warn" || t === "bad") attn += 1;
      if (a.current_power_w != null) liveW += a.current_power_w;
    });
    return {
      n: overview?.totals?.array_count ?? overview?.peer_summary?.arrays_total ?? filtered.length,
      inv,
      attn,
      liveW,
      todayKwh: overview?.totals?.today_kwh,
      valueToday: overview?.totals?.today_usd ?? overview?.totals?.value_today,
    };
  }, [filtered, overview]);

  return (
    <div className="space-y-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-ink">Fleet</h1>
          <p className="text-sm font-medium text-muted">
            Live arrays · table view from desktop
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          label="Arrays"
          value={String(stats.n)}
          meta={stats.inv ? `${stats.inv} inverters` : "Connect feeds"}
        />
        <StatCard
          label="Live now"
          value={fmtKw(stats.liveW || overview?.totals?.current_power_w)}
          meta={
            stats.valueToday != null
              ? `${fmtKwh(stats.todayKwh)} · ~${fmtMoney(stats.valueToday)}`
              : fmtKwh(stats.todayKwh)
          }
          tone="good"
        />
        <StatCard
          label="Needs eyes"
          value={String(stats.attn)}
          meta={stats.attn ? "Status warn / bad" : "All clear"}
          tone={stats.attn ? "warn" : "good"}
          onClick={() =>
            openAgent(
              "What needs attention on my fleet right now? Name arrays and inverters."
            )
          }
        />
        <StatCard
          label="Today"
          value={fmtKwh(stats.todayKwh)}
          meta="Fleet production"
        />
      </div>

      {/* Cards | Table — mirrors desktop Triage vs Table */}
      <div className="ao-seg">
        <button type="button" data-on={mode === "cards" ? 1 : 0} onClick={() => setMode("cards")}>
          Cards
        </button>
        <button type="button" data-on={mode === "table" ? 1 : 0} onClick={() => setMode("table")}>
          Table
        </button>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search arrays or inverters…"
        className="w-full rounded-2xl border border-line bg-white/80 px-3.5 py-2.5 text-sm font-semibold outline-none ring-sky-500 focus:ring-2"
      />

      {err ? (
        <p className="text-xs font-semibold text-red-600">{err}</p>
      ) : null}
      {loading ? (
        <div className="py-8 text-center text-sm font-bold text-muted">
          Loading fleet…
        </div>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <div className="ao-sheet p-5 text-sm text-muted">
          No arrays match.{" "}
          <button
            type="button"
            className="font-extrabold text-sky-700"
            onClick={() => openAgent("Help me connect my first array.")}
          >
            Connect with Agent →
          </button>
        </div>
      ) : null}

      {mode === "cards" ? (
        <ul className="space-y-2.5">
          {filtered.map((a) => {
            const id = String(a.id);
            const open = openId === id;
            const tone = statusTone(a.status);
            const invs = a.inverters || [];
            const nameplate =
              a.nameplate_kw ||
              invs.reduce((s, i) => s + (i.nameplate_kw || 0), 0) ||
              null;
            return (
              <li key={id} className="ao-card overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-start gap-3 p-3.5 text-left"
                  onClick={() => setOpenId(open ? null : id)}
                >
                  <OutputGauge
                    powerW={a.current_power_w}
                    nameplateKw={nameplate}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-extrabold text-ink">
                          {a.name}
                        </div>
                        <div className="mt-0.5 text-[11px] font-semibold text-muted">
                          {brandLabel(a.vendor)}
                          {invs.length ? ` · ${invs.length} inv` : ""}
                          {a.today_kwh != null ? ` · ${fmtKwh(a.today_kwh)} today` : ""}
                        </div>
                      </div>
                      <span className={chipClass(tone)}>{a.status || "—"}</span>
                    </div>
                    <div className="mt-2.5">
                      <PowerBar powerW={a.current_power_w} nameplateKw={nameplate} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <Sparkline series={a.daily} width={120} height={26} />
                      <span className="text-[10px] font-bold text-muted">
                        {open ? "Hide ▴" : "Inverters ▾"}
                      </span>
                    </div>
                  </div>
                </button>
                {open ? (
                  <div className="border-t border-line bg-white/40 px-3.5 py-3">
                    {invs.length === 0 ? (
                      <p className="text-xs text-muted">No inverter rows yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {invs.map((inv) => (
                          <li
                            key={String(inv.id)}
                            className="flex items-center gap-2.5 rounded-xl bg-white/70 px-2.5 py-2"
                          >
                            <OutputGauge
                              powerW={inv.current_power_w}
                              nameplateKw={inv.nameplate_kw}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-extrabold">
                                {inv.name}
                              </div>
                              <div className="text-[10px] font-semibold text-muted">
                                {fmtKw(inv.current_power_w)}
                                {inv.peer_index != null
                                  ? ` · peer ${inv.peer_index.toFixed(2)}`
                                  : ""}
                              </div>
                            </div>
                            <span className={chipClass(statusTone(inv.status))}>
                              {inv.status || "—"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="mt-3 text-xs font-extrabold text-sky-700"
                      onClick={() =>
                        openAgent(
                          `Focus on array ${a.name}. Summarize health and next steps.`
                        )
                      }
                    >
                      Ask Agent about this array →
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <InverterTable arrays={filtered} openAgent={openAgent} />
      )}
    </div>
  );
}

function InverterTable({
  arrays,
  openAgent,
}: {
  arrays: FleetArray[];
  openAgent: (p?: string) => void;
}) {
  const [expand, setExpand] = useState<Record<string, boolean>>({});

  return (
    <div className="ao-table-wrap">
      <table className="ao-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Now</th>
            <th>% max</th>
            <th>Today</th>
            <th>Trend</th>
            <th>Vendor</th>
          </tr>
        </thead>
        <tbody>
          {arrays.map((a) => {
            const id = String(a.id);
            const invs = a.inverters || [];
            const open = expand[id] === true;
            const nameplate =
              a.nameplate_kw ||
              invs.reduce((s, i) => s + (i.nameplate_kw || 0), 0) ||
              null;
            const frac =
              a.current_power_w != null && nameplate
                ? Math.round((a.current_power_w / (nameplate * 1000)) * 100)
                : null;
            return (
              <ArrayRows
                key={id}
                a={a}
                open={open}
                frac={frac}
                nameplate={nameplate}
                onToggle={() => setExpand((e) => ({ ...e, [id]: !open }))}
                openAgent={openAgent}
              />
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-[10px] font-semibold text-muted">
        Spreadsheet view ported from desktop Vendor Table — expand arrays for
        per-inverter rows.
      </p>
    </div>
  );
}

function ArrayRows({
  a,
  open,
  frac,
  nameplate,
  onToggle,
  openAgent,
}: {
  a: FleetArray;
  open: boolean;
  frac: number | null;
  nameplate: number | null;
  onToggle: () => void;
  openAgent: (p?: string) => void;
}) {
  const invs = a.inverters || [];
  return (
    <>
      <tr className="ao-array-row">
        <td>
          <button
            type="button"
            className="flex items-center gap-1.5 text-left font-extrabold text-ink"
            onClick={onToggle}
          >
            <span className="text-muted">{open ? "▾" : "▸"}</span>
            <span>
              ▦ {a.name}
              <span className="ml-1 font-semibold text-muted">
                ({invs.length})
              </span>
            </span>
          </button>
        </td>
        <td>
          <span className={chipClass(statusTone(a.status))}>{a.status || "—"}</span>
        </td>
        <td className="font-bold tabular-nums">{fmtKw(a.current_power_w)}</td>
        <td>
          <div className="flex items-center gap-2">
            <OutputGauge powerW={a.current_power_w} nameplateKw={nameplate} size="sm" />
            <span className="font-bold tabular-nums text-muted">
              {frac == null ? "—" : `${frac}%`}
            </span>
          </div>
        </td>
        <td className="font-bold tabular-nums">{fmtKwh(a.today_kwh)}</td>
        <td>
          <Sparkline series={a.daily} width={72} height={22} />
        </td>
        <td className="font-semibold text-muted">{brandLabel(a.vendor)}</td>
      </tr>
      {open
        ? invs.map((inv) => {
            const ip =
              inv.current_power_w != null && inv.nameplate_kw
                ? Math.round(
                    (inv.current_power_w / (inv.nameplate_kw * 1000)) * 100
                  )
                : null;
            return (
              <tr key={String(inv.id)} className="ao-inv-row">
                <td className="pl-7 font-semibold text-ink">
                  ⌁ {inv.name}
                  <button
                    type="button"
                    className="ml-2 text-[10px] font-bold text-sky-700"
                    onClick={() =>
                      openAgent(`Help with inverter ${inv.name} on ${a.name}.`)
                    }
                  >
                    Agent
                  </button>
                </td>
                <td>
                  <span className={chipClass(statusTone(inv.status))}>
                    {inv.status || "—"}
                  </span>
                </td>
                <td className="tabular-nums">{fmtKw(inv.current_power_w)}</td>
                <td className="tabular-nums font-semibold text-muted">
                  {ip == null ? "—" : `${ip}%`}
                </td>
                <td className="text-muted">
                  {inv.peer_index != null ? `peer ${inv.peer_index.toFixed(2)}` : "—"}
                </td>
                <td>
                  <Sparkline series={inv.daily} width={72} height={22} />
                </td>
                <td className="text-muted">—</td>
              </tr>
            );
          })
        : null}
    </>
  );
}
