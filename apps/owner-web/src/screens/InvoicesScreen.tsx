import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import {
  createSubscription,
  fetchListBundle,
  fetchOnboardingStatus,
  fetchPaymentsConnect,
  fetchSendPipeline,
  openSubscriptionPreview,
  patchSubscription,
} from "@/lib/api";
import { isDemoMode } from "@/lib/demoData";
import type {
  OfftakerArrayOption,
  OnboardingStatus,
  PaymentsConnectStatus,
  SendPipeline,
  Subscription,
  UtilityAccountOption,
} from "@/lib/types";

function displayName(s: Subscription): string {
  return (
    s.customer_name ||
    s.offtaker_name ||
    s.name ||
    s.client_email ||
    s.email ||
    "Offtaker"
  );
}

function shareLabel(s: Subscription): string {
  if (s.allocation_pct != null) return `${(Number(s.allocation_pct) * 100).toFixed(1)}%`;
  if (s.share_pct != null) return `${Number(s.share_pct)}%`;
  return "—";
}

export function InvoicesScreen() {
  const { openAgent } = useOutletAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [arrays, setArrays] = useState<OfftakerArrayOption[]>([]);
  const [utilities, setUtilities] = useState<UtilityAccountOption[]>([]);
  const [onb, setOnb] = useState<OnboardingStatus | null>(null);
  const [pay, setPay] = useState<PaymentsConnectStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [form, setForm] = useState({
    customer_name: "",
    client_email: "",
    array_id: "",
    utility_account_id: "",
    allocation_pct: "10",
    delivery_mode: "approval",
  });

  const reload = useCallback(async () => {
    const [bundle, p, o, paySt] = await Promise.all([
      fetchListBundle().catch(() => null),
      fetchSendPipeline().catch(() => null),
      fetchOnboardingStatus().catch(() => null),
      fetchPaymentsConnect().catch(() => null),
    ]);
    if (bundle) {
      setSubs(bundle.subscriptions || []);
      setArrays(bundle.arrays || []);
      setUtilities(
        (bundle.utility_accounts as UtilityAccountOption[]) || []
      );
    }
    setPipe(p);
    setOnb(o);
    setPay(paySt);
  }, []);

  useEffect(() => {
    reload().catch((e) =>
      setErr(e instanceof Error ? e.message : "Load failed")
    );
  }, [reload]);

  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;
  const enabledCount =
    pipe?.total_enabled != null
      ? pipe.total_enabled
      : subs.filter((s) => s.enabled !== false).length;

  const needsUtility =
    onb && !onb.complete && !onb.has_utility_accounts && !isDemoMode();

  const editing = subs.find((s) => String(s.id) === editId) || null;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    setErr(null);
    setMsg(null);
    try {
      const pct = Number(form.allocation_pct);
      // API wants fraction in (0, 1]
      const allocation =
        pct > 1 ? pct / 100 : pct > 0 ? pct : undefined;
      await createSubscription({
        customer_name: form.customer_name.trim(),
        client_email: form.client_email.trim() || undefined,
        array_id: form.array_id ? Number(form.array_id) : null,
        utility_account_id: form.utility_account_id
          ? Number(form.utility_account_id)
          : null,
        allocation_pct: allocation,
        delivery_mode: form.delivery_mode,
      });
      setMsg(`Added ${form.customer_name.trim()}`);
      setForm({
        customer_name: "",
        client_email: "",
        array_id: "",
        utility_account_id: "",
        allocation_pct: "10",
        delivery_mode: "approval",
      });
      setShowCreate(false);
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Create failed");
    } finally {
      setBusy(null);
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing?.id) return;
    setBusy("edit");
    setErr(null);
    setMsg(null);
    try {
      const fd = new FormData(e.target as HTMLFormElement);
      const name = String(fd.get("customer_name") || "").trim();
      const email = String(fd.get("client_email") || "").trim();
      const mode = String(fd.get("delivery_mode") || "approval");
      const enabled = fd.get("enabled") === "on";
      const rawPct = String(fd.get("allocation_pct") || "").trim();
      const body: Record<string, unknown> = {
        customer_name: name || undefined,
        client_email: email || null,
        delivery_mode: mode,
        enabled,
      };
      if (rawPct) {
        const n = Number(rawPct);
        body.allocation_pct = n > 1 ? n / 100 : n;
      }
      const arr = String(fd.get("array_id") || "");
      if (arr) body.array_id = Number(arr);
      const ua = String(fd.get("utility_account_id") || "");
      if (ua) body.utility_account_id = Number(ua);

      await patchSubscription(editing.id, body);
      setMsg("Offtaker saved");
      setEditId(null);
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function onPreview(sub: Subscription) {
    setBusy(`prev-${sub.id}`);
    setErr(null);
    try {
      await openSubscriptionPreview(sub.id!, "invoice", "pdf");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Demo offtaker roster — sign in to create, edit, and preview PDFs.
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-extrabold">Invoices</h1>
          <p className="text-sm text-slate-800/75">
            Offtakers, send pulse, and invoice preview.
          </p>
        </div>
        <button
          type="button"
          className="ao-btn-primary !min-h-9 !px-3 !text-xs"
          disabled={isDemoMode()}
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? "Close" : "Add"}
        </button>
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
        <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-800">
          {err}
        </div>
      ) : null}
      {msg ? (
        <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/80 px-3 py-2 text-xs font-semibold text-emerald-900">
          {msg}
        </div>
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

      {showCreate ? (
        <form onSubmit={onCreate} className="ao-card space-y-2.5 p-3.5">
          <h2 className="text-sm font-extrabold">New offtaker</h2>
          <input
            className="ao-input"
            placeholder="Customer name"
            required
            value={form.customer_name}
            onChange={(e) =>
              setForm((f) => ({ ...f, customer_name: e.target.value }))
            }
          />
          <input
            className="ao-input"
            type="email"
            placeholder="Email (optional)"
            value={form.client_email}
            onChange={(e) =>
              setForm((f) => ({ ...f, client_email: e.target.value }))
            }
          />
          <label className="block text-xs font-bold text-muted">
            Share %
            <input
              className="ao-input mt-1"
              inputMode="decimal"
              placeholder="10"
              value={form.allocation_pct}
              onChange={(e) =>
                setForm((f) => ({ ...f, allocation_pct: e.target.value }))
              }
            />
          </label>
          <label className="block text-xs font-bold text-muted">
            Array
            <select
              className="ao-input mt-1"
              value={form.array_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, array_id: e.target.value }))
              }
            >
              <option value="">— optional —</option>
              {arrays.map((a) => (
                <option key={a.id ?? a.array_id} value={a.id ?? a.array_id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-bold text-muted">
            Utility bill
            <select
              className="ao-input mt-1"
              value={form.utility_account_id}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  utility_account_id: e.target.value,
                }))
              }
            >
              <option value="">— optional —</option>
              {utilities.map((u) => (
                <option key={u.account_id} value={u.account_id}>
                  {u.nickname ||
                    `${u.provider} ${u.account_number || ""}`.trim()}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-bold text-muted">
            Delivery
            <select
              className="ao-input mt-1"
              value={form.delivery_mode}
              onChange={(e) =>
                setForm((f) => ({ ...f, delivery_mode: e.target.value }))
              }
            >
              <option value="approval">Approve to send</option>
              <option value="auto">Auto-send</option>
            </select>
          </label>
          <button
            type="submit"
            className="ao-btn-primary w-full !min-h-10 !text-xs"
            disabled={!!busy || !form.customer_name.trim()}
          >
            {busy === "create" ? "Creating…" : "Create offtaker"}
          </button>
        </form>
      ) : null}

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
                isDemoMode()
                  ? openAgent(
                      "Walk me through adding offtakers. What's the fastest path?"
                    )
                  : setShowCreate(true)
              }
            >
              {isDemoMode() ? "Ask Agent →" : "Add one →"}
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {subs.map((s) => {
              const name = displayName(s);
              const email = s.client_email || s.email || s.to_email || "";
              const isEdit = String(s.id) === editId;
              return (
                <li key={String(s.id || name)} className="ao-card overflow-hidden">
                  <div className="flex items-start justify-between gap-2 px-3.5 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-extrabold">{name}</div>
                      <div className="truncate text-xs text-muted">
                        {email || s.utility_account_name || "—"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-sky-900">
                        {shareLabel(s)}
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
                  <div className="flex flex-wrap gap-2 border-t border-white/40 px-3.5 py-2.5">
                    <button
                      type="button"
                      className="text-xs font-bold text-sky-800"
                      disabled={!!busy || isDemoMode()}
                      onClick={() => void onPreview(s)}
                    >
                      {busy === `prev-${s.id}` ? "Opening…" : "Preview PDF"}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-bold text-sky-800"
                      disabled={isDemoMode()}
                      onClick={() =>
                        setEditId(isEdit ? null : String(s.id))
                      }
                    >
                      {isEdit ? "Close" : "Edit"}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-bold text-sky-800"
                      onClick={() =>
                        openAgent(
                          `Help me with offtaker ${name}: delivery, share, and next invoice.`
                        )
                      }
                    >
                      Agent
                    </button>
                  </div>
                  {isEdit ? (
                    <form
                      onSubmit={onSaveEdit}
                      className="space-y-2 border-t border-white/40 px-3.5 py-3"
                    >
                      <input
                        name="customer_name"
                        className="ao-input"
                        defaultValue={name}
                        required
                      />
                      <input
                        name="client_email"
                        type="email"
                        className="ao-input"
                        defaultValue={email}
                        placeholder="Email"
                      />
                      <input
                        name="allocation_pct"
                        className="ao-input"
                        defaultValue={
                          s.allocation_pct != null
                            ? String(Number(s.allocation_pct) * 100)
                            : s.share_pct != null
                              ? String(s.share_pct)
                              : ""
                        }
                        placeholder="Share %"
                      />
                      <select
                        name="array_id"
                        className="ao-input"
                        defaultValue={s.array_id ?? ""}
                      >
                        <option value="">Array —</option>
                        {arrays.map((a) => (
                          <option
                            key={a.id ?? a.array_id}
                            value={a.id ?? a.array_id}
                          >
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <select
                        name="utility_account_id"
                        className="ao-input"
                        defaultValue={s.utility_account_id ?? ""}
                      >
                        <option value="">Utility —</option>
                        {utilities.map((u) => (
                          <option key={u.account_id} value={u.account_id}>
                            {u.nickname ||
                              `${u.provider} ${u.account_number || ""}`.trim()}
                          </option>
                        ))}
                      </select>
                      <select
                        name="delivery_mode"
                        className="ao-input"
                        defaultValue={s.delivery_mode || "approval"}
                      >
                        <option value="approval">Approve to send</option>
                        <option value="auto">Auto-send</option>
                      </select>
                      <label className="flex items-center gap-2 text-xs font-semibold">
                        <input
                          type="checkbox"
                          name="enabled"
                          defaultChecked={s.enabled !== false}
                        />
                        Enabled
                      </label>
                      <button
                        type="submit"
                        className="ao-btn-primary w-full !min-h-10 !text-xs"
                        disabled={!!busy}
                      >
                        {busy === "edit" ? "Saving…" : "Save changes"}
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="ao-btn-ghost w-full !text-xs"
        onClick={() =>
          openAgent(
            "Summarize my offtaker invoice pipeline, last send, and anything I should fix before the next cycle."
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
