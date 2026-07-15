import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  fetchOnboardingStatus,
  fetchPaymentsConnect,
  fetchSendPipeline,
  fetchSubscriptions,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import type {
  OnboardingStatus,
  PaymentsConnectStatus,
  SendPipeline,
  Subscription,
} from "@/lib/types";

export function InvoicesScreen() {
  const { openAgent } = useOutletAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [onb, setOnb] = useState<OnboardingStatus | null>(null);
  const [pay, setPay] = useState<PaymentsConnectStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchSendPipeline().catch(() => null),
      fetchSubscriptions().catch(() => null),
      fetchOnboardingStatus().catch(() => null),
      fetchPaymentsConnect().catch(() => null),
    ])
      .then(([p, s, o, paySt]) => {
        setPipe(p);
        setSubs(s?.subscriptions || []);
        setOnb(o);
        setPay(paySt);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, []);

  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;
  const enabledCount =
    pipe?.total_enabled != null
      ? pipe.total_enabled
      : subs.filter((s) => s.enabled !== false).length;

  const needsUtility =
    onb && !onb.complete && !onb.has_utility_accounts && !isDemoMode();

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Demo offtaker roster — sign in for live invoices.
        </div>
      ) : null}

      <div>
        <h1 className="text-lg font-extrabold">Invoices</h1>
        <p className="text-sm text-slate-800/75">
          Offtaker pulse and send status.
        </p>
      </div>

      {needsUtility ? (
        <div className="rounded-2xl border border-amber-200/70 bg-amber-50/70 px-3.5 py-3 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Utility bills not linked yet — invoices need a real bill source.{" "}
          <Link to="/connect" className="underline">
            Connect utility →
          </Link>
        </div>
      ) : null}

      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}

      <div className="ao-card space-y-3 p-4">
        <Row k="Enabled offtakers" v={String(enabledCount || "—")} />
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
        <Row
          k="Online pay"
          v={
            pay?.ready
              ? "Ready"
              : pay?.connected
                ? "Connect setup incomplete"
                : "Off"
          }
        />
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">Roster</h2>
          <span className="text-[11px] font-bold text-muted">
            {subs.length} total
          </span>
        </div>
        {subs.length === 0 ? (
          <div className="ao-card p-4 text-sm text-muted">
            No offtakers yet.{" "}
            <button
              type="button"
              className="font-bold text-sky-800"
              onClick={() =>
                openAgent(
                  "Walk me through adding or bulk-importing offtakers. What's the fastest path on mobile?"
                )
              }
            >
              Add with Agent →
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {subs.map((s) => {
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
                      <div className="text-xs font-bold text-sky-900">
                        {share}
                      </div>
                      <div className="text-[10px] font-semibold uppercase text-muted">
                        {s.enabled === false
                          ? "off"
                          : s.delivery_mode ||
                            pipe?.default_delivery_mode ||
                            "—"}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Link to="/connect" className="ao-btn-ghost text-center text-xs">
          Connect feeds
        </Link>
        <button
          type="button"
          className="ao-btn-primary !text-xs"
          onClick={() =>
            openAgent(
              "Summarize my offtaker invoice pipeline, last send, and anything I should fix before the next cycle."
            )
          }
        >
          Ask Agent
        </button>
      </div>
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
