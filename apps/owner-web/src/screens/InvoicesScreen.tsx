import { useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchSendPipeline, fetchSubscriptions } from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import type { SendPipeline, Subscription } from "@/lib/types";

export function InvoicesScreen() {
  const { openAgent } = useOutletAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchSendPipeline().catch(() => null),
      fetchSubscriptions().catch(() => null),
    ])
      .then(([p, s]) => {
        setPipe(p);
        setSubs(s?.subscriptions || []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-950">
          Demo offtaker roster
        </div>
      ) : null}
      <div>
        <h1 className="text-lg font-extrabold">Invoices</h1>
        <p className="text-sm text-muted">Offtaker pulse and send status.</p>
      </div>
      {err ? (
        <p className="text-xs font-semibold text-red-600">{err}</p>
      ) : null}

      <div className="ao-card space-y-3 p-4">
        <Row
          k="Enabled offtakers"
          v={
            pipe?.total_enabled != null
              ? String(pipe.total_enabled)
              : String(subs.filter((s) => s.enabled !== false).length || "—")
          }
        />
        <Row k="Delivery mode" v={pipe?.default_delivery_mode || "—"} />
        <Row
          k="Last cycle"
          v={
            last
              ? `${last.period_label || last.period_month || "period"} · ${
                  delivered != null ? delivered : "—"
                } sent`
              : "No send yet"
          }
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-extrabold">Roster</h2>
        {subs.length === 0 ? (
          <div className="ao-card p-4 text-sm text-muted">
            No offtakers yet.{" "}
            <button
              type="button"
              className="font-bold text-sky-700"
              onClick={() =>
                openAgent(
                  "Walk me through adding or bulk-importing offtakers on mobile."
                )
              }
            >
              Add with Agent →
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {subs.slice(0, 20).map((s) => {
              const name =
                s.offtaker_name || s.name || s.email || s.to_email || "Offtaker";
              const email = s.email || s.to_email || "";
              const share =
                s.share_pct != null ? `${Number(s.share_pct)}%` : "—";
              return (
                <li key={String(s.id || name)} className="ao-card px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-extrabold">{name}</div>
                      <div className="truncate text-xs text-muted">
                        {email || s.utility_account_name || "—"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-sky-800">{share}</div>
                      <div className="text-[10px] font-semibold uppercase text-muted">
                        {s.delivery_mode || pipe?.default_delivery_mode || "—"}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="ao-btn-primary w-full"
        onClick={() =>
          openAgent(
            "Summarize my offtaker invoice pipeline and anything I should fix."
          )
        }
      >
        Ask Agent about invoices
      </button>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="font-semibold text-muted">{k}</span>
      <span className="text-right font-bold text-ink">{v}</span>
    </div>
  );
}
