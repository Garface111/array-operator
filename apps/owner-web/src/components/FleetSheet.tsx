/**
 * Mobile spreadsheet of monitored arrays + inverters — same columns as
 * desktop Vendor Data sheet (Name · Status · kW now · Today · Peer · % max).
 */
import { useMemo, useState } from "react";
import {
  fmtKwh,
  fmtPeer,
  fmtPower,
  livePctOfNameplate,
  relTime,
  statusLabel,
  statusTone,
  toneClasses,
} from "@/lib/format";
import type { FleetArray, FleetInverter, OverviewArray } from "@/lib/types";
import { StatusPill } from "./ui";

export type SheetArray = FleetArray & {
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  peer_index?: number | null;
  diagnosis?: string | null;
  vendor?: string | null;
};

function isAllocatedPower(vendor?: string | null): boolean {
  const v = String(vendor || "").toLowerCase();
  return v === "fronius" || v === "sma" || v === "chint";
}

function invPowerDisplay(inv: FleetInverter): string {
  if (inv.current_power_w == null) return "—";
  const base = fmtPower(inv.current_power_w);
  return isAllocatedPower(inv.vendor) ? `~${base}` : base;
}

function arrPowerDisplay(a: SheetArray): string {
  if (a.current_power_w == null) {
    const sum = (a.inverters || []).reduce(
      (t, i) => t + (Number(i.current_power_w) || 0),
      0
    );
    if (!sum && !(a.inverters || []).some((i) => i.current_power_w != null))
      return "—";
    const v = (a.inverters || [])[0]?.vendor || a.vendor;
    const base = fmtPower(sum);
    return isAllocatedPower(v) ? `~${base}` : base;
  }
  return isAllocatedPower(a.vendor) ? `~${fmtPower(a.current_power_w)}` : fmtPower(a.current_power_w);
}

function pctMax(
  powerW?: number | null,
  nameplateKw?: number | null
): string {
  const p = livePctOfNameplate(powerW, nameplateKw);
  if (p == null) return "—";
  return `${Math.round(p)}%`;
}

function rank(a: SheetArray): number {
  const t = statusTone(String(a.status));
  return t === "bad" ? 0 : t === "warn" ? 1 : t === "good" ? 3 : 2;
}

type Props = {
  arrays: SheetArray[];
  loading?: boolean;
  onAsk?: (name: string, status: string) => void;
};

export function FleetSheet({ arrays, loading, onAsk }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [expandAll, setExpandAll] = useState(false);

  const rows = useMemo(() => {
    const list = arrays.slice().sort((a, b) => rank(a) - rank(b));
    const qq = q.trim().toLowerCase();
    if (!qq) return list;
    return list.filter((a) => {
      const hay = [
        a.name,
        a.vendor,
        a.status,
        ...(a.inverters || []).map((i) =>
          [i.name, i.vendor, i.model, i.status].join(" ")
        ),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(qq);
    });
  }, [arrays, q]);

  const invTotal = arrays.reduce(
    (t, a) => t + (a.inverters?.length || 0),
    0
  );

  function isOpen(id: string) {
    if (expandAll) return open[id] !== false;
    return !!open[id];
  }

  function toggle(id: string) {
    setOpen((o) => ({ ...o, [id]: !isOpen(id) }));
  }

  if (!arrays.length && loading) {
    return (
      <div className="ao-card px-3.5 py-4 text-sm font-semibold text-muted">
        Loading inverter sheet…
      </div>
    );
  }

  if (!arrays.length) {
    return (
      <div className="ao-card px-3.5 py-4 text-sm text-muted">
        No monitored arrays yet — connect a vendor under Account → Connect.
      </div>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-extrabold text-slate-900">
            Vendor data
          </h2>
          <p className="text-[11px] font-medium text-muted">
            {arrays.length} array{arrays.length === 1 ? "" : "s"} · {invTotal}{" "}
            inverter{invTotal === 1 ? "" : "s"} · same fields as desktop sheet
          </p>
        </div>
        <button
          type="button"
          className="text-[11px] font-bold text-sky-800"
          onClick={() => {
            setExpandAll((e) => !e);
            setOpen({});
          }}
        >
          {expandAll ? "Collapse" : "Expand all"}
        </button>
      </div>

      <input
        type="search"
        className="ao-input !py-2 text-sm"
        placeholder="Search arrays or inverters…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />

      {/* Column headers — match desktop: Name Status kW Today Peer % */}
      <div className="ao-card overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1.4fr)_auto_auto] gap-x-2 border-b border-white/40 bg-white/30 px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-sky-900/80 sm:grid-cols-[minmax(0,1.6fr)_0.7fr_0.7fr_0.55fr_0.5fr_0.45fr]">
          <span>Name</span>
          <span className="hidden text-right sm:block">Status</span>
          <span className="hidden text-right sm:block">kW now</span>
          <span className="hidden text-right sm:block">Today</span>
          <span className="hidden text-right sm:block">Peer</span>
          <span className="text-right">% max</span>
        </div>

        <ul className="divide-y divide-white/35">
          {rows.map((a) => {
            const id = String(a.id || a.name);
            const expanded = isOpen(id);
            const tone = statusTone(String(a.status));
            const invs = a.inverters || [];
            const arrPow =
              a.current_power_w ??
              invs.reduce((t, i) => t + (Number(i.current_power_w) || 0), 0);
            const invNpSum = invs.reduce(
              (t, i) => t + (Number(i.nameplate_kw) || 0),
              0
            );
            const arrNp =
              a.nameplate_kw ?? (invNpSum > 0 ? invNpSum : null);
            const pct = pctMax(
              a.current_power_w ?? arrPow,
              a.nameplate_kw ?? arrNp
            );
            const barPct = livePctOfNameplate(
              a.current_power_w ?? arrPow,
              a.nameplate_kw ?? arrNp
            );
            const bar = toneClasses(tone);

            return (
              <li key={id}>
                <button
                  type="button"
                  className="w-full px-2.5 py-2.5 text-left active:bg-white/25"
                  onClick={() => toggle(id)}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,1.6fr)_0.7fr_0.7fr_0.55fr_0.5fr_0.45fr]">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted" aria-hidden>
                          {expanded ? "▾" : "▸"}
                        </span>
                        <span className="truncate text-[13px] font-extrabold text-slate-900">
                          {a.name || "Array"}
                        </span>
                      </div>
                      <div className="mt-0.5 pl-4 text-[10px] font-medium text-muted">
                        {[
                          a.vendor || null,
                          invs.length ? `${invs.length} inv` : null,
                          a.last_sync_at || a.synced_at
                            ? relTime(a.last_sync_at || a.synced_at)
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      {/* Phone: secondary metrics under name */}
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 pl-4 text-[10px] font-semibold text-slate-700 sm:hidden">
                        <StatusPill
                          status={statusLabel(a.status)}
                          tone={tone}
                        />
                        <span>{arrPowerDisplay(a)}</span>
                        <span>{fmtKwh(a.today_kwh)}</span>
                        <span>peer {fmtPeer(a.peer_index)}</span>
                      </div>
                    </div>
                    <span className="hidden text-right text-[11px] font-bold capitalize sm:block">
                      <span className={bar.text}>{statusLabel(a.status)}</span>
                    </span>
                    <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                      {arrPowerDisplay(a)}
                    </span>
                    <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                      {fmtKwh(a.today_kwh)}
                    </span>
                    <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                      {fmtPeer(a.peer_index)}
                    </span>
                    <span className="text-right text-[11px] font-extrabold tabular-nums text-slate-800">
                      {pct}
                    </span>
                  </div>
                  {barPct != null ? (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/40">
                      <div
                        className={`h-full rounded-full ${bar.bar}`}
                        style={{
                          width: `${Math.min(100, barPct)}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </button>

                {expanded && invs.length > 0 ? (
                  <ul className="border-t border-white/30 bg-white/20">
                    {invs.map((inv) => {
                      const it = statusTone(String(inv.status));
                      const ic = toneClasses(it);
                      const ip = livePctOfNameplate(
                        inv.current_power_w,
                        inv.nameplate_kw
                      );
                      return (
                        <li
                          key={String(inv.id || inv.inverter_id || inv.name)}
                          className="border-t border-white/25 px-2.5 py-2 pl-6"
                          onClick={() =>
                            onAsk?.(
                              `${a.name} · ${inv.name || "inverter"}`,
                              String(inv.status || "")
                            )
                          }
                        >
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1.6fr)_0.7fr_0.7fr_0.55fr_0.5fr_0.45fr]">
                            <div className="min-w-0">
                              <div className="truncate text-[12px] font-bold text-slate-800">
                                {inv.name || "Inverter"}
                              </div>
                              <div className="text-[10px] text-muted">
                                {[inv.vendor || a.vendor, inv.model]
                                  .filter(Boolean)
                                  .join(" · ")}
                                {isAllocatedPower(inv.vendor || a.vendor)
                                  ? " · kW estimated"
                                  : ""}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] font-semibold sm:hidden">
                                <span className={ic.text}>
                                  {statusLabel(inv.status)}
                                </span>
                                <span>{invPowerDisplay(inv)}</span>
                                <span>{fmtKwh(inv.today_kwh)}</span>
                              </div>
                            </div>
                            <span
                              className={`hidden text-right text-[11px] font-bold capitalize sm:block ${ic.text}`}
                            >
                              {statusLabel(inv.status)}
                            </span>
                            <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                              {invPowerDisplay(inv)}
                            </span>
                            <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                              {fmtKwh(inv.today_kwh)}
                            </span>
                            <span className="hidden text-right text-[11px] font-bold tabular-nums sm:block">
                              {fmtPeer(inv.peer_index)}
                            </span>
                            <span className="text-right text-[11px] font-extrabold tabular-nums">
                              {pctMax(inv.current_power_w, inv.nameplate_kw)}
                            </span>
                          </div>
                          {ip != null ? (
                            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/35">
                              <div
                                className={`h-full rounded-full ${ic.bar}`}
                                style={{ width: `${Math.min(100, ip)}%` }}
                              />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                {expanded && !invs.length ? (
                  <div className="border-t border-white/30 bg-white/15 px-3 py-2 pl-6 text-[11px] text-muted">
                    Array-level only (no per-inverter rows yet).
                    {a.diagnosis ? ` ${a.diagnosis}` : ""}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {q && !rows.length ? (
        <p className="text-xs font-semibold text-muted">
          No rows match “{q}”.
        </p>
      ) : null}
    </section>
  );
}

/** Merge overview array metrics onto fleet-tree rows for the sheet. */
export function mergeSheetArrays(
  treeArrays: FleetArray[] | undefined,
  overviewArrays: OverviewArray[] | undefined
): SheetArray[] {
  const byId = new Map(
    (overviewArrays || []).map((a) => [String(a.id), a])
  );
  const byName = new Map(
    (overviewArrays || []).map((a) => [
      String(a.name || "").toLowerCase(),
      a,
    ])
  );
  const fromTree = (treeArrays || []).map((a) => {
    const ov =
      byId.get(String(a.id)) ||
      byName.get(String(a.name || "").toLowerCase());
    return {
      ...a,
      status: a.status || ov?.status,
      today_kwh: a.today_kwh ?? ov?.today_kwh,
      current_power_w: a.current_power_w ?? ov?.current_power_w,
      nameplate_kw: a.nameplate_kw ?? ov?.nameplate_kw,
      peer_index:
        a.peer_index ?? ov?.peer_index ?? ov?.peer?.peer_index ?? null,
      diagnosis: a.diagnosis ?? ov?.diagnosis ?? ov?.peer?.diagnosis,
    } as SheetArray;
  });
  const seen = new Set(fromTree.map((a) => String(a.id || a.name)));
  (overviewArrays || []).forEach((a) => {
    const key = String(a.id || a.name);
    if (seen.has(key)) return;
    fromTree.push({
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
  });
  return fromTree;
}
