import { useCallback, useEffect, useMemo, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree, fetchOverview } from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { fmtKwh, statusTone } from "@/lib/format";
import type { FleetArray, Overview, OverviewArray } from "@/lib/types";

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

export function FleetScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
      const byId = new Map(
        (ov?.arrays || []).map((a) => [String(a.id), a])
      );
      const merged = (tree.arrays || []).map((a) =>
        mergeArray(
          a,
          byId.get(String(a.id)) ||
            byName.get(String(a.name || "").toLowerCase())
        )
      );
      // Overview-only arrays not in tree yet
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
    const today =
      overview?.totals?.today_kwh ??
      arrays.reduce((s, a) => s + (Number(a.today_kwh) || 0), 0);
    const power = arrays.reduce(
      (s, a) => s + (Number(a.current_power_w) || 0),
      0
    );
    return { today, power, n: arrays.length };
  }, [arrays, overview]);

  async function onRefresh() {
    setRefreshing(true);
    await load(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-extrabold text-slate-900">Fleet</h1>
          <p className="text-sm text-slate-800/75">
            Live arrays and inverter health.
          </p>
        </div>
        <button
          type="button"
          className="ao-btn-ghost !min-h-9 !px-3 !text-xs"
          disabled={refreshing || isDemoMode()}
          onClick={() => void onRefresh()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Demo fleet — sign in for your live arrays.
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <div className="ao-card p-3 text-center">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Arrays
          </div>
          <div className="mt-0.5 text-base font-extrabold">{totals.n}</div>
        </div>
        <div className="ao-card p-3 text-center">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Today
          </div>
          <div className="mt-0.5 text-base font-extrabold">
            {fmtKwh(totals.today)}
          </div>
        </div>
        <div className="ao-card p-3 text-center">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
            Now
          </div>
          <div className="mt-0.5 text-base font-extrabold">
            {totals.power > 0
              ? totals.power >= 1000
                ? `${(totals.power / 1000).toFixed(1)} kW`
                : `${Math.round(totals.power)} W`
              : "—"}
          </div>
        </div>
      </div>

      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}
      {loading ? (
        <p className="text-sm font-semibold text-muted">Loading fleet…</p>
      ) : null}

      {arrays.length === 0 && !err && !loading ? (
        <div className="ao-card p-4 text-sm text-muted">
          No arrays yet.{" "}
          <a href="/connect" className="font-bold text-sky-800">
            Connect a feed →
          </a>
        </div>
      ) : null}

      <ul className="space-y-2.5">
        {arrays.map((a) => {
          const key = String(a.id || a.name);
          const tone = statusTone(String(a.status || ""));
          const invs = a.inverters || [];
          const open = openId === key;
          const peer =
            a.peer_index != null ? Number(a.peer_index).toFixed(2) : null;
          return (
            <li key={key} className="ao-card overflow-hidden">
              <button
                type="button"
                className="flex w-full items-start justify-between gap-2 p-3.5 text-left"
                onClick={() => setOpenId(open ? null : key)}
              >
                <div className="min-w-0">
                  <div className="font-extrabold">{a.name || "Array"}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {fmtKwh(a.today_kwh)} today
                    {peer ? ` · peer ${peer}` : ""}
                    {invs.length
                      ? ` · ${invs.length} inv`
                      : a.nameplate_kw
                        ? ` · ${a.nameplate_kw} kW`
                        : ""}
                  </div>
                  {a.diagnosis ? (
                    <div className="mt-1 text-[11px] font-medium text-slate-700/80">
                      {a.diagnosis}
                    </div>
                  ) : null}
                </div>
                <span
                  className={[
                    "ao-chip shrink-0",
                    tone === "good"
                      ? "bg-emerald-100/90 text-emerald-900"
                      : tone === "warn"
                        ? "bg-amber-100/90 text-amber-950"
                        : tone === "bad"
                          ? "bg-red-100/90 text-red-900"
                          : "bg-white/50 text-slate-700",
                  ].join(" ")}
                >
                  {a.status || "unknown"}
                </span>
              </button>
              {open ? (
                <div className="border-t border-white/40 px-3.5 pb-3.5 pt-2">
                  {invs.length ? (
                    <ul className="space-y-1.5">
                      {invs.map((inv) => (
                        <li
                          key={String(inv.id || inv.inverter_id || inv.name)}
                          className="flex items-center justify-between gap-2 rounded-xl bg-white/35 px-2.5 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-bold">
                              {inv.name || "Inverter"}
                            </div>
                            <div className="text-[10px] text-muted">
                              {[inv.vendor, inv.model]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                              {inv.peer_index != null
                                ? ` · peer ${Number(inv.peer_index).toFixed(2)}`
                                : ""}
                            </div>
                          </div>
                          <span className="shrink-0 font-semibold text-slate-700">
                            {inv.status || "—"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">
                      No per-inverter rows yet — production still tracks at
                      array level.
                    </p>
                  )}
                  <button
                    type="button"
                    className="mt-3 text-xs font-bold text-sky-800"
                    onClick={() =>
                      openAgent(
                        `Focus on array ${a.name}. Summarize health, peer index, and anything I should do.`
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
