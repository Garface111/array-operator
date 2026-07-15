import { FormEvent, useCallback, useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  connectSolarEdgeAccount,
  fetchAccount,
  fetchCloudStatus,
  fetchFleetTree,
  fetchLinkedSources,
  fetchOnboardingStatus,
  fetchPaymentsConnect,
  refreshCloudCapture,
  saveCloudCredential,
  startPaymentsConnect,
  toggleCloudCredential,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import { relTime } from "@/lib/format";
import type {
  AccountMe,
  CloudStatus,
  LinkedSources,
  OnboardingStatus,
  PaymentsConnectStatus,
} from "@/lib/types";

const CLOUD_PROVIDERS = [
  { id: "solaredge", label: "SolarEdge" },
  { id: "fronius", label: "Fronius" },
  { id: "sma", label: "SMA" },
  { id: "chint", label: "Chint / CPS" },
  { id: "gmp", label: "GMP (utility)" },
  { id: "smarthub", label: "SmartHub co-op" },
];

export function ConnectScreen() {
  const { openAgent } = useOutletAgent();
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [onb, setOnb] = useState<OnboardingStatus | null>(null);
  const [linked, setLinked] = useState<LinkedSources | null>(null);
  const [pay, setPay] = useState<PaymentsConnectStatus | null>(null);
  const [nArrays, setNArrays] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [seKey, setSeKey] = useState("");
  const [cloudForm, setCloudForm] = useState({
    provider: "chint",
    username: "",
    password: "",
    login_host: "",
    consent: true,
  });

  const reload = useCallback(async () => {
    const [a, c, o, l, p, t] = await Promise.all([
      fetchAccount().catch(() => null),
      fetchCloudStatus().catch(() => null),
      fetchOnboardingStatus().catch(() => null),
      fetchLinkedSources().catch(() => null),
      fetchPaymentsConnect().catch(() => null),
      fetchFleetTree().catch(() => null),
    ]);
    setAccount(a);
    setCloud(c);
    setOnb(o);
    setLinked(l);
    setPay(p);
    setNArrays(t?.arrays?.length || o?.arrays_total || 0);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const creds = cloud?.credentials || [];

  async function onConnectSolarEdge(e: FormEvent) {
    e.preventDefault();
    setBusy("se");
    setErr(null);
    setMsg(null);
    try {
      const r = await connectSolarEdgeAccount(seKey.trim());
      setMsg(
        `SolarEdge: ${r.connected ?? 0} connected · ${r.created ?? 0} new · ${r.matched ?? 0} matched`
      );
      setSeKey("");
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "SolarEdge connect failed");
    } finally {
      setBusy(null);
    }
  }

  async function onSaveCloud(e: FormEvent) {
    e.preventDefault();
    setBusy("cloud");
    setErr(null);
    setMsg(null);
    try {
      await saveCloudCredential({
        provider: cloudForm.provider,
        username: cloudForm.username.trim(),
        password: cloudForm.password || undefined,
        login_host: cloudForm.login_host.trim() || undefined,
        enable: true,
        consent: cloudForm.consent,
      });
      setMsg(`Saved ${cloudForm.provider} login for auto-refresh.`);
      setCloudForm((f) => ({ ...f, password: "" }));
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not save login");
    } finally {
      setBusy(null);
    }
  }

  async function onRefreshHarvest() {
    setBusy("refresh");
    setErr(null);
    try {
      await refreshCloudCapture();
      setMsg("Harvest kicked off — data will refresh shortly.");
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Refresh failed");
    } finally {
      setBusy(null);
    }
  }

  async function onPayConnect() {
    setBusy("pay");
    setErr(null);
    try {
      const url = await startPaymentsConnect();
      window.location.assign(url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Stripe Connect failed");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Demo connect status — sign in to attach real feeds.
        </div>
      ) : null}

      <div>
        <h1 className="text-lg font-extrabold">Connect</h1>
        <p className="text-sm text-slate-800/75">
          Live production, utility bills, auto-refresh, and pay links.
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

      {/* Status strip */}
      <div className="grid grid-cols-2 gap-2">
        <StatusChip
          label="Arrays"
          value={nArrays > 0 ? `${nArrays} live` : "None"}
          ok={nArrays > 0}
        />
        <StatusChip
          label="Setup"
          value={onb?.complete ? "Ready" : onb?.next_step || "Pending"}
          ok={!!onb?.complete}
        />
        <StatusChip
          label="Cloud harvest"
          value={
            creds.length
              ? `${creds.filter((c) => c.enabled).length} on`
              : "Off"
          }
          ok={creds.some((c) => c.enabled && c.last_harvest_ok !== false)}
        />
        <StatusChip
          label="Online pay"
          value={pay?.ready ? "Ready" : pay?.connected ? "Setup" : "Off"}
          ok={!!pay?.ready}
        />
      </div>

      {/* SolarEdge API key — one credential, all sites */}
      <section className="ao-card space-y-3 p-3.5">
        <div>
          <h2 className="text-sm font-extrabold">SolarEdge (API key)</h2>
          <p className="text-xs text-muted">
            Account-level key attaches every site in one shot.
          </p>
        </div>
        <form onSubmit={onConnectSolarEdge} className="space-y-2">
          <input
            className="ao-input font-mono text-sm"
            placeholder="SolarEdge API key"
            value={seKey}
            onChange={(e) => setSeKey(e.target.value)}
            autoComplete="off"
            disabled={isDemoMode()}
            required
          />
          <button
            type="submit"
            className="ao-btn-primary w-full !min-h-10 !text-xs"
            disabled={!!busy || isDemoMode() || !seKey.trim()}
          >
            {busy === "se" ? "Connecting…" : "Connect SolarEdge account"}
          </button>
        </form>
      </section>

      {/* Cloud capture logins */}
      <section className="ao-card space-y-3 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-extrabold">Auto-refresh logins</h2>
            <p className="text-xs text-muted">
              Server-side harvest (cloud mode). Requires consent to store
              password.
            </p>
          </div>
          {creds.length ? (
            <button
              type="button"
              className="text-[11px] font-bold text-sky-800"
              disabled={!!busy || isDemoMode()}
              onClick={() => void onRefreshHarvest()}
            >
              Harvest now
            </button>
          ) : null}
        </div>

        {creds.length ? (
          <ul className="space-y-2">
            {creds.map((c) => (
              <li
                key={`${c.provider}-${c.username}`}
                className="flex items-center justify-between gap-2 rounded-xl bg-white/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-extrabold">
                    {c.provider} · {c.username}
                  </div>
                  <div className="text-[10px] text-muted">
                    {c.last_harvest_ok === false ? "issue · " : ""}
                    {relTime(c.last_harvest_at)}
                    {c.last_harvest_status
                      ? ` · ${c.last_harvest_status}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className={[
                    "ao-chip",
                    c.enabled
                      ? "bg-emerald-100 text-emerald-900"
                      : "bg-slate-100 text-slate-600",
                  ].join(" ")}
                  disabled={isDemoMode() || !!busy}
                  onClick={() =>
                    void toggleCloudCredential({
                      provider: String(c.provider),
                      username: String(c.username),
                      enable: !c.enabled,
                    }).then(reload)
                  }
                >
                  {c.enabled ? "On" : "Off"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No cloud logins saved yet.</p>
        )}

        <form onSubmit={onSaveCloud} className="space-y-2 border-t border-white/40 pt-3">
          <select
            className="ao-input"
            value={cloudForm.provider}
            onChange={(e) =>
              setCloudForm((f) => ({ ...f, provider: e.target.value }))
            }
            disabled={isDemoMode()}
          >
            {CLOUD_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {cloudForm.provider === "smarthub" ? (
            <input
              className="ao-input"
              placeholder="Co-op host (e.g. vermontelectric.smarthub.coop)"
              value={cloudForm.login_host}
              onChange={(e) =>
                setCloudForm((f) => ({ ...f, login_host: e.target.value }))
              }
              required
            />
          ) : null}
          <input
            className="ao-input"
            placeholder="Username / email"
            value={cloudForm.username}
            onChange={(e) =>
              setCloudForm((f) => ({ ...f, username: e.target.value }))
            }
            autoComplete="username"
            required
            disabled={isDemoMode()}
          />
          <input
            className="ao-input"
            type="password"
            placeholder="Password"
            value={cloudForm.password}
            onChange={(e) =>
              setCloudForm((f) => ({ ...f, password: e.target.value }))
            }
            autoComplete="current-password"
            required
            disabled={isDemoMode()}
          />
          <label className="flex items-start gap-2 text-[11px] font-medium text-slate-800/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={cloudForm.consent}
              onChange={(e) =>
                setCloudForm((f) => ({ ...f, consent: e.target.checked }))
              }
            />
            I consent to Array Operator storing this login for hands-off
            harvest.
          </label>
          <button
            type="submit"
            className="ao-btn-primary w-full !min-h-10 !text-xs"
            disabled={
              !!busy ||
              isDemoMode() ||
              !cloudForm.username ||
              !cloudForm.password ||
              !cloudForm.consent
            }
          >
            {busy === "cloud" ? "Saving…" : "Save for auto-refresh"}
          </button>
        </form>
        {!cloud?.encryption_ready ? (
          <p className="text-[11px] font-semibold text-amber-900">
            Server encryption may not be armed — password save can fail until
            ops enables it. Extension capture still works on desktop.
          </p>
        ) : null}
      </section>

      {/* Linked sources */}
      {(linked?.sources || []).length > 0 ? (
        <section className="ao-card p-3.5">
          <h2 className="text-sm font-extrabold">Linked sources</h2>
          <ul className="mt-2 space-y-1.5">
            {(linked?.sources || []).map((s, i) => (
              <li
                key={i}
                className="flex justify-between text-xs font-semibold"
              >
                <span>{s.label || s.code || s.vendor || "Source"}</span>
                <span className="text-muted">
                  {s.detail ||
                    (s.count != null
                      ? `${s.count}`
                      : s.site_count != null
                        ? `${s.site_count} sites`
                        : "—")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Online pay */}
      <section className="ao-card space-y-2 p-3.5">
        <h2 className="text-sm font-extrabold">Online pay (Stripe Connect)</h2>
        <p className="text-xs text-muted">
          {pay?.ready
            ? "Offtaker invoices can include a pay link."
            : "Enable so offtakers can pay from the invoice email."}
        </p>
        {!pay?.ready ? (
          <button
            type="button"
            className="ao-btn-primary w-full !min-h-10 !text-xs"
            disabled={!!busy || isDemoMode()}
            onClick={() => void onPayConnect()}
          >
            {busy === "pay" ? "Opening Stripe…" : "Enable online pay"}
          </button>
        ) : (
          <span className="ao-chip bg-emerald-100 text-emerald-900">
            Charges enabled
          </span>
        )}
      </section>

      <div className="ao-card p-3.5 text-xs leading-relaxed text-muted">
        <strong className="text-ink">Capture mode:</strong>{" "}
        {account?.capture_mode || "not set"}
        . Portal vendors (Fronius / SMA / Chint) can also capture via the
        EnergyAgent Chrome extension from the desktop site.{" "}
        <button
          type="button"
          className="font-bold text-sky-800"
          onClick={() =>
            openAgent(
              "What's left to get fully hands-off on my feeds? Check cloud logins, utility, arrays, and pay."
            )
          }
        >
          Ask Agent →
        </button>
      </div>
    </div>
  );
}

function StatusChip({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="ao-card p-3">
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
        {label}
      </div>
      <div
        className={[
          "mt-0.5 text-sm font-extrabold",
          ok ? "text-emerald-800" : "text-slate-800",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}
