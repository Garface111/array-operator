import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DemoBanner, KpiTile, SectionHead } from "@/components/ui";
import {
  fetchAccount,
  fetchAddPaymentUrl,
  fetchBillingPortalUrl,
  fetchBillingSummary,
  setCaptureMode,
  updateCompanyName,
} from "@/lib/api";
import { disableDemoMode, isDemoMode } from "@/lib/demoData";
import { fmtKwh, fmtMoney, relTime } from "@/lib/format";
import { clearSession } from "@/lib/session";
import type { AccountMe, BillingSummary } from "@/lib/types";

export function AccountScreen() {
  const nav = useNavigate();
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchAccount().catch(() => null),
      fetchBillingSummary().catch(() => null),
    ]).then(([a, b]) => {
      setAccount(a);
      setBilling(b);
      setCompany(a?.company_name || a?.name || "");
    });
  }, []);

  async function onSaveCompany(e: FormEvent) {
    e.preventDefault();
    setBusy("company");
    setErr(null);
    setMsg(null);
    try {
      await updateCompanyName(company.trim());
      setMsg("Company name saved.");
      const a = await fetchAccount();
      setAccount(a);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function openBillingPortal() {
    setBusy("portal");
    setErr(null);
    try {
      const url = await fetchBillingPortalUrl();
      window.location.assign(url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Billing portal failed");
      setBusy(null);
    }
  }

  async function openAddCard() {
    setBusy("card");
    setErr(null);
    try {
      const url = await fetchAddPaymentUrl();
      window.location.assign(url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Add card failed");
      setBusy(null);
    }
  }

  async function onMode(mode: "cloud" | "device") {
    setBusy("mode");
    setErr(null);
    try {
      await setCaptureMode(mode);
      setMsg(`Capture mode → ${mode}`);
      setAccount(await fetchAccount());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not set mode");
    } finally {
      setBusy(null);
    }
  }

  function copyKey() {
    const k = account?.tenant_key;
    if (!k) return;
    void navigator.clipboard.writeText(k).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const est =
    billing?.estimated_cents != null
      ? billing.estimated_cents
      : billing?.total_cents;
  const estDollars = est != null ? fmtMoney(est, true) : "—";
  const providers = account?.connected_providers || [];

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <DemoBanner>
          Demo account — sign in for live billing and settings.
        </DemoBanner>
      ) : null}

      <div>
        <h1 className="text-lg font-extrabold">Account</h1>
        <p className="text-sm text-slate-800/75">
          {account?.company_name || account?.name || "Profile"} · billing ·
          capture
        </p>
      </div>

      {err ? (
        <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-800">
          {err}
        </div>
      ) : null}
      {msg ? (
        <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/80 px-3 py-2 text-xs font-semibold text-emerald-900">
          {msg}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <KpiTile
          label="Plan"
          value={String(
            account?.plan_features?.plan ||
              account?.billing_plan ||
              account?.subscription_status ||
              "—"
          )}
          meta={
            account?.active === false
              ? "Inactive"
              : account?.subscription_status || "Active"
          }
          tone={account?.active === false ? "bad" : "good"}
        />
        <KpiTile
          label="Est. bill"
          value={estDollars}
          meta={
            billing?.billing_basis === "kwh"
              ? `${fmtKwh(billing.mtd_kwh)} MTD`
              : billing?.billable_arrays != null
                ? `${billing.billable_arrays} arrays`
                : "This period"
          }
        />
        <KpiTile
          label="Bills on file"
          value={String(account?.bills_count ?? "—")}
          meta={
            account?.accounts_count != null
              ? `${account.accounts_count} utility accts`
              : "Utility history"
          }
        />
        <KpiTile
          label="Capture"
          value={String(account?.capture_mode || "—")}
          meta={
            account?.extension_heartbeat_at
              ? `Ext ${relTime(account.extension_heartbeat_at)}`
              : "No extension beat"
          }
        />
      </div>

      <section className="ao-card space-y-2 p-3.5">
        <SectionHead title="Profile" />
        <Row k="Email" v={account?.email || "—"} />
        <Row k="Company" v={account?.company_name || account?.name || "—"} />
        <Row k="Product" v={account?.product || "array_operator"} />
        <Row
          k="Trial ends"
          v={
            account?.trial_ends_at
              ? new Date(account.trial_ends_at).toLocaleDateString()
              : "—"
          }
        />
        <Row k="Last data pull" v={relTime(account?.last_pull_at)} />
        <Row
          k="Connected portals"
          v={
            providers.length
              ? providers.join(", ")
              : "None yet — open Connect"
          }
        />
      </section>

      <form onSubmit={onSaveCompany} className="ao-card space-y-2 p-3.5">
        <label className="block">
          <span className="text-xs font-bold text-muted">Company name</span>
          <input
            className="ao-input mt-1"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="ao-btn-primary w-full !min-h-10 !text-xs"
          disabled={!!busy || !company.trim()}
        >
          {busy === "company" ? "Saving…" : "Save company"}
        </button>
      </form>

      <section className="ao-card space-y-3 p-3.5">
        <SectionHead
          title="Billing"
          sub={
            billing?.billing_basis === "kwh"
              ? "Metered per kWh generated"
              : "Array-based pricing"
          }
        />
        {billing?.billing_basis === "kwh" ? (
          <Row k="MTD generation" v={fmtKwh(billing.mtd_kwh)} />
        ) : (
          <Row
            k="Billable arrays"
            v={
              billing?.billable_arrays != null
                ? String(billing.billable_arrays)
                : "—"
            }
          />
        )}
        <Row k="Est. this period" v={estDollars} />
        <Row
          k="Card on file"
          v={
            billing?.card_last4 || account?.has_payment_method
              ? [
                  billing?.card_brand,
                  billing?.card_last4
                    ? `•••• ${billing.card_last4}`
                    : "on file",
                  billing?.card_exp,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "No card"
          }
        />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            className="ao-btn-ghost !min-h-10 !text-xs"
            disabled={!!busy}
            onClick={() => void openAddCard()}
          >
            {busy === "card" ? "…" : "Add card"}
          </button>
          <button
            type="button"
            className="ao-btn-primary !min-h-10 !text-xs"
            disabled={!!busy}
            onClick={() => void openBillingPortal()}
          >
            {busy === "portal" ? "…" : "Billing portal"}
          </button>
        </div>
      </section>

      <section className="ao-card space-y-3 p-3.5">
        <h2 className="text-sm font-extrabold">Capture mode</h2>
        <p className="text-xs text-muted">
          Cloud = server harvests portals. Device = extension on your machine.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(["cloud", "device"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={!!busy}
              onClick={() => void onMode(m)}
              className={[
                "rounded-xl border px-3 py-2.5 text-xs font-extrabold capitalize",
                account?.capture_mode === m
                  ? "border-sky-400 bg-sky-100/80 text-sky-900"
                  : "border-white/50 bg-white/35 text-slate-800",
              ].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      {account?.tenant_key ? (
        <section className="ao-card space-y-2 p-3.5">
          <h2 className="text-sm font-extrabold">Extension activation</h2>
          <p className="text-xs text-muted">
            Paste into EnergyAgent Chrome extension to pair this account.
          </p>
          <code className="block break-all rounded-xl bg-white/45 px-3 py-2 font-mono text-[11px]">
            {account.tenant_key}
          </code>
          <button
            type="button"
            className="ao-btn-ghost w-full !min-h-9 !text-xs"
            onClick={copyKey}
          >
            {copied ? "Copied" : "Copy key"}
          </button>
        </section>
      ) : null}

      {/* Desktop Account also hosts connect / auto-refresh surfaces */}
      <section className="ao-card space-y-2 p-3.5">
        <h2 className="text-sm font-extrabold">Connect feeds</h2>
        <p className="text-xs text-muted">
          SolarEdge API, cloud harvest, utility, online pay — same as desktop
          Account / Connect.
        </p>
        <Link
          to="/connect"
          className="ao-btn-primary flex w-full !min-h-10 !text-xs"
        >
          Open connect →
        </Link>
      </section>

      <section className="ao-card divide-y divide-white/40 overflow-hidden">
        <a
          href="/?desktop=1"
          className="flex w-full items-center justify-between px-4 py-3.5 text-sm font-bold"
        >
          Desktop site
          <span className="text-[11px] font-semibold text-muted">Full canvas</span>
        </a>
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm font-bold text-red-700"
          onClick={() => {
            clearSession();
            disableDemoMode();
            nav("/login", { replace: true });
          }}
        >
          {isDemoMode() ? "Exit demo" : "Sign out"}
        </button>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="font-semibold text-muted">{k}</span>
      <span className="max-w-[60%] text-right font-bold text-ink">{v}</span>
    </div>
  );
}
