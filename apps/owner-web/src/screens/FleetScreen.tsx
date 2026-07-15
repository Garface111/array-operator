import { useCallback, useEffect, useMemo, useState } from "react";
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
import { fetchFleetTree, fetchOverview } from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import {
  fmtKwh,
  fmtPeer,
  fmtPower,
  livePctOfNameplate,
  relTime,
  statusLabel,
  statusTone,
} from "@/lib/format";
import type { FleetArray, Overview, OverviewArray } from "@/lib/types";

type Filter = "all" | "flagged" | "ok";

function mergeArray(tree: FleetArray, ov?: OverviewArray): FleetArray {
  if (!ov) return tree;
  return {
    ...tree,
    status: tree.status || ov.status,
    today_kwh: tree.today_kwh ?? ov.today_kwh,
    current_power_w: tree.current_power_w ?? ov.current_power_w,
    nameplate_kw: tree.nameplate_kw ?? ov.nameplate_kw,
    peer_index:
      tree.peer_index ??
      ov.peer_index ??
      (ov.peer?.peer_index as number | null | undefined),
    diagnosis: tree.diagnosis ?? ov.diagnosis ?? ov.peer?.diagnosis,
  };
}

function rankTone(t: ReturnType<typeof statusTone>): number {
  return t === "bad" ? 0 : t === "warn" ? 1 : t === "good" ? 3 : 2;
}

export function FleetScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async (force = false) => {
    setErr(null);
    try {
      const [tree, ov] = await Promise.all([
        fetchFleetTree(force),
        fetchOverview().catch(() => null),
      ]);
      setOverview(ov);
      const byName = new Map(
        (ov?.arrays || []).map((a) => [String(a.name || "").toLowerCase(), a])
      );
      const byId = new Map((ov?.arrays || []).map((a) => [String(a.id), a]));
      const merged = (tree.arrays || []).map((a) =>
        mergeArray(
          a,
          byId.get(String(a.id)) ||
            byName.get(String(a.name || "").toLowerCase())
        )
      );
      const treeIds = new Set(merged.map((a) => String(a.id || a.name)));
      (ov?.arrays || []).forEach((a) => {
        const key = String(a.id || a.name);
        if (!treeIds.has(key)) {
          merged.push({
            id: a.id,
            name: a.name,
            status: a.status,
            today_kwh: a.today_kwh,
            current_power_w: a.current_power_w,
            nameplate_kw: a.nameplate_kw,
            peer_index: a.peer_index ?? a.peer?.peer_index,
            diagnosis: a.diagnosis ?? a.peer?.diagnosis,
            inverters: [],
          });
        }
      });
      // Worst first (desktop overview grid is worst-first too)
      merged.sort(
        (a, b) =>
          rankTone(statusTone(String(a.status))) -
          rankTone(statusTone(String(b.status)))
      );
      setArrays(merged);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const totals = useMemo(() => {
    let inv = 0;
    let flagged = 0;
    let power = 0;
    let nameplate = 0;
    arrays.forEach((a) => {
      const invs = a.inverters || [];
      if (invs.length) {
        invs.forEach((i) => {
          inv += 1;
          const t = statusTone(String(i.status || a.status));
          if (t === "bad" || t === "warn") flagged += 1;
          if (i.current_power_w != null) power += Number(i.current_power_w);
        });
      } else {
        const t = statusTone(String(a.status));
        if (t === "bad" || t === "warn") flagged += 1;
      }
      if (a.current_power_w != null) {
        const hasInvPower = (a.inverters || []).some(
          (i) => i.current_power_w != null
        );
        if (!hasInvPower) power += Number(a.current_power_w);
      }
      if (a.nameplate_kw) nameplate += Number(a.nameplate_kw);
    });
    const today =
      overview?.totals?.today_kwh ??
      arrays.reduce((s, a) => s + (Number(a.today_kwh) || 0), 0);
    return {
      n: arrays.length,
      inv,
      flagged,
      power,
      nameplate,
      today,
    };
  }, [arrays, overview]);

  const visible = useMemo(() => {
    if (filter === "all") return arrays;
    return arrays.filter((a) => {
      const t = statusTone(String(a.status));
      const invFlag = (a.inverters || []).some((i) => {
        const it = statusTone(String(i.status));
        return it === "bad" || it === "warn";
      });
      const flagged = t === "bad" || t === "warn" || invFlag;
      return filter === "flagged" ? flagged : !flagged;
    });
  }, [arrays, filter]);

  async function onRefresh() {
    setRefreshing(true);
    await load(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-extrabold text-slate-900">Inverters</h1>
          <p className="text-sm text-slate-800/75">
            Every array · worst first · tap to expand units
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
      </div>

      {isDemoMode() ? (
        <DemoBanner>Demo fleet — sign in for live arrays.</DemoBanner>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <KpiTile label="Arrays" value={String(totals.n)} meta="on file" />
        <KpiTile
          label="Inverters"
          value={String(totals.inv || "—")}
          meta={totals.flagged ? `${totals.flagged} flagged` : "all clear"}
          tone={totals.flagged ? "warn" : "good"}
        />
        <KpiTile
          label="Now"
          value={fmtPower(totals.power)}
          meta={
            totals.nameplate
              ? `${totals.nameplate} kW nameplate`
              : "Live power"
          }
        />
        <KpiTile
          label="Today"
          value={fmtKwh(totals.today)}
          meta="Fleet generation"
        />
      </div>

      <div className="flex gap-1.5">
        {(
          [
            ["all", "All"],
            ["flagged", "Flagged"],
            ["ok", "Healthy"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={[
              "rounded-full px-3 py-1 text-[11px] font-extrabold",
              filter === id
                ? "bg-sky-500 text-white shadow"
                : "bg-white/45 text-slate-800 ring-1 ring-white/55",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}
      {loading ? (
        <p className="text-sm font-semibold text-muted">Loading inverters…</p>
      ) : null}

      {!loading && visible.length === 0 ? (
        <EmptyCard>
          {arrays.length === 0 ? (
            <>
              No arrays yet.{" "}
              <Link to="/connect" className="font-bold text-sky-800">
                Connect a feed →
              </Link>
            </>
          ) : (
            "Nothing in this filter."
          )}
        </EmptyCard>
      ) : null}

      <ul className="space-y-2.5">
        {visible.map((a) => {
          const key = String(a.id || a.name);
          const tone = statusTone(String(a.status || ""));
          const invs = a.inverters || [];
          const open = openId === key;
          const livePct = livePctOfNameplate(
            a.current_power_w,
            a.nameplate_kw
          );
          const peer = a.peer_index != null ? Number(a.peer_index) : null;
          const sync = a.last_sync_at || a.synced_at;
          return (
            <li key={key} className="ao-card overflow-hidden">
              <button
                type="button"
                className="w-full space-y-2 p-3.5 text-left"
                onClick={() => setOpenId(open ? null : key)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-extrabold leading-snug">
                      {a.name || "Array"}
                    </div>
                    <div className="mt-0.5 text-[11px] font-medium text-muted">
                      {[
                        a.vendor || null,
                        a.nameplate_kw != null
                          ? `${a.nameplate_kw} kW`
                          : null,
                        invs.length
                          ? `${invs.length} inv`
                          : null,
                        sync ? relTime(sync) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <StatusPill
                    status={statusLabel(a.status)}
                    tone={tone}
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[9px] font-extrabold uppercase text-muted">
                      Now
                    </div>
                    <div className="text-xs font-extrabold">
                      {fmtPower(a.current_power_w)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-extrabold uppercase text-muted">
                      Today
                    </div>
                    <div className="text-xs font-extrabold">
                      {fmtKwh(a.today_kwh)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-extrabold uppercase text-muted">
                      Peer
                    </div>
                    <div className="text-xs font-extrabold">
                      {fmtPeer(peer)}
                    </div>
                  </div>
                </div>

                {livePct != null ? (
                  <div>
                    <MeterBar
                      pct={livePct}
                      tone={
                        livePct < 2
                          ? "muted"
                          : livePct < 35
                            ? "warn"
                            : "good"
                      }
                    />
                    <div className="mt-0.5 text-[10px] font-semibold text-muted">
                      {Math.round(livePct)}% of rated output
                    </div>
                  </div>
                ) : null}

                {a.diagnosis ? (
                  <div className="text-[11px] leading-snug text-slate-800/85">
                    {a.diagnosis}
                  </div>
                ) : null}
              </button>

              {open ? (
                <div className="border-t border-white/40 px-3.5 pb-3.5 pt-2">
                  <SectionHead
                    title="Inverters"
                    sub={
                      invs.length
                        ? `${invs.length} units on this array`
                        : "Array-level only"
                    }
                  />
                  {invs.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {invs.map((inv) => {
                        const it = statusTone(String(inv.status));
                        const ipct = livePctOfNameplate(
                          inv.current_power_w,
                          inv.nameplate_kw
                        );
                        return (
                          <li
                            key={String(
                              inv.id || inv.inverter_id || inv.name
                            )}
                            className="rounded-xl bg-white/40 px-2.5 py-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-extrabold">
                                  {inv.name || "Inverter"}
                                </div>
                                <div className="text-[10px] text-muted">
                                  {[inv.vendor, inv.model, inv.nameplate_kw != null ? `${inv.nameplate_kw} kW` : null]
                                    .filter(Boolean)
                                    .join(" · ") || "—"}
                                </div>
                              </div>
                              <StatusPill
                                status={statusLabel(inv.status)}
                                tone={it}
                              />
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-semibold text-slate-700">
                              <span>Now {fmtPower(inv.current_power_w)}</span>
                              <span>Today {fmtKwh(inv.today_kwh)}</span>
                              <span>Peer {fmtPeer(inv.peer_index)}</span>
                            </div>
                            {ipct != null ? (
                              <MeterBar
                                pct={ipct}
                                tone={
                                  ipct < 2
                                    ? "muted"
                                    : ipct < 35
                                      ? "warn"
                                      : "good"
                                }
                                className="mt-1.5"
                              />
                            ) : null}
                            {inv.diagnosis ? (
                              <div className="mt-1 text-[10px] leading-snug text-muted">
                                {inv.diagnosis}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted">
                      No per-inverter rows yet — production still tracks at
                      array level.
                    </p>
                  )}
                  <button
                    type="button"
                    className="mt-3 text-xs font-bold text-sky-800"
                    onClick={() =>
                      openAgent(
                        `Focus on array ${a.name}. Summarize health, peer index, live power, and anything I should do.`
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
    </div>
  );
}
