import { useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchSendPipeline } from "@/lib/api";
import type { SendPipeline } from "@/lib/types";

export function InvoicesScreen() {
  const { openAgent } = useOutletAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchSendPipeline()
      .then(setPipe)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">Invoices</h1>
        <p className="text-sm text-muted">
          Offtaker pulse — full workspace grows here without touching desktop.
        </p>
      </div>
      {err ? (
        <p className="text-xs font-semibold text-red-600">{err}</p>
      ) : null}
      <div className="ao-card space-y-3 p-4">
        <Row
          k="Enabled offtakers"
          v={pipe?.total_enabled != null ? String(pipe.total_enabled) : "—"}
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
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="ao-btn-primary"
          onClick={() =>
            openAgent(
              "Summarize my offtaker invoice pipeline and anything I should fix (shares, send mode, online pay)."
            )
          }
        >
          Ask Agent about invoices
        </button>
        <button
          type="button"
          className="ao-btn-ghost"
          onClick={() =>
            openAgent(
              "Walk me through adding or bulk-importing offtakers. Keep it mobile-simple."
            )
          }
        >
          Help add offtakers
        </button>
      </div>
      <p className="text-[11px] text-muted">
        Deep tools (bulk import, bill audit, per-offtaker edit) land next on this
        branch — Agent can guide interim actions against the live API.
      </p>
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
