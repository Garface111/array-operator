import { useEffect, useMemo, useState } from "react";
import { StatCard } from "@/components/StatCard";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchSendPipeline, fetchSubscriptions } from "@/lib/api";
import { chipClass, fmtMoney, statusTone } from "@/lib/format";
import type { OfftakerSub, SendPipeline } from "@/lib/types";

export function InvoicesScreen() {
  const { openAgent } = useOutletAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [subs, setSubs] = useState<OfftakerSub[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, bundle] = await Promise.all([
          fetchSendPipeline().catch(() => null),
          fetchSubscriptions().catch((e) => {
            throw e;
          }),
        ]);
        if (cancelled) return;
        setPipe(p);
        setSubs(bundle.subscriptions || []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return subs;
    return subs.filter((o) =>
      [
        o.name,
        o.customer_name,
        o.email,
        o.client_email,
        o.array_name,
        o.status,
        o.delivery_mode,
      ]
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [subs, q]);

  const enabled = subs.filter((s) => s.enabled !== false).length;
  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;
  const inflight = pipe?.inflight as
    | { pending_drafts?: number; pending_approval?: number; waiting?: number }
    | undefined;

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Invoices</h1>
        <p className="text-sm font-medium text-muted">
          Offtakers · send pipeline · desktop parity
        </p>
      </div>

      {err ? <p className="text-xs font-semibold text-red-600">{err}</p> : null}

      <div className="grid grid-cols-2 gap-2">
        <StatCard
          label="Offtakers"
          value={String(pipe?.total_enabled ?? enabled)}
          meta={`${subs.length} on file`}
        />
        <StatCard
          label="Mode"
          value={String(pipe?.default_delivery_mode || "—")}
          meta="Delivery default"
        />
        <StatCard
          label="Last cycle"
          value={
            delivered != null ? String(delivered) : "—"
          }
          meta={
            last?.period_label || last?.period_month
              ? String(last.period_label || last.period_month)
              : "No send yet"
          }
          tone={delivered ? "good" : "default"}
        />
        <StatCard
          label="In flight"
          value={String(
            (inflight?.pending_drafts || 0) +
              (inflight?.pending_approval || 0) +
              (inflight?.waiting || 0)
          )}
          meta={
            last && "dollars" in last && last.dollars != null
              ? `${fmtMoney(Number(last.dollars))} last $`
              : "Drafts / waiting"
          }
        />
      </div>

      <div className="ao-sheet flex flex-wrap gap-2 p-3">
        <button
          type="button"
          className="ao-btn-primary !min-h-10 !text-xs"
          onClick={() =>
            openAgent(
              "Summarize my offtaker invoice pipeline: shares, send mode, online pay, anything broken."
            )
          }
        >
          Pipeline brief
        </button>
        <button
          type="button"
          className="ao-btn-ghost !min-h-10 !text-xs"
          onClick={() =>
            openAgent(
              "Help me add or bulk-import offtakers on mobile. Keep steps short."
            )
          }
        >
          Add offtakers
        </button>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Offtaker list</h2>
          <span className="text-[11px] font-bold text-muted">
            {filtered.length} shown
          </span>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search offtakers…"
          className="mb-2.5 w-full rounded-2xl border border-line bg-white/80 px-3.5 py-2.5 text-sm font-semibold outline-none ring-sky-500 focus:ring-2"
        />
        {filtered.length === 0 ? (
          <div className="ao-card p-4 text-sm text-muted">
            {subs.length === 0
              ? "No offtakers yet — Agent can walk setup, or use desktop bulk import."
              : "No matches."}
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((o, idx) => {
              const st =
                o.enabled === false
                  ? "paused"
                  : String(o.status || o.delivery_mode || "active");
              const share =
                o.share_pct ?? o.array_share_pct ?? o.allocation_pct ?? null;
              const displayName = String(
                o.name || o.customer_name || ""
              ).trim();
              const displayEmail = String(
                o.email || o.client_email || ""
              ).trim();
              return (
                <li
                  key={String(o.id ?? displayEmail ?? displayName ?? idx)}
                  className="ao-card p-3.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold">
                        {displayName || `Offtaker ${idx + 1}`}
                      </div>
                      <div className="truncate text-[11px] font-semibold text-muted">
                        {displayEmail || "—"}
                        {o.array_name ? ` · ${o.array_name}` : ""}
                      </div>
                    </div>
                    <span className={chipClass(statusTone(st))}>{st}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-muted">
                    {share != null ? (
                      <span className="ao-chip ao-chip-sky">
                        {Number(share) <= 1
                          ? `${Math.round(Number(share) * 1000) / 10}% share`
                          : `${Number(share)}% share`}
                      </span>
                    ) : null}
                    {o.delivery_mode ? (
                      <span className="ao-chip ao-chip-muted">
                        {String(o.delivery_mode)}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
