import { apiUrl } from "./base";
import { clearSession, getSession, SESSION_KEY, UNAUTHORIZED_EVENT } from "./session";
import {
  demoAccount,
  demoCloud,
  demoCreateSubscription,
  demoFleet,
  demoOverview,
  demoPatchSubscription,
  demoPipeline,
  demoSubs,
  isDemoMode,
} from "./demoData";
import type {
  AccountMe,
  AuthVerifyResult,
  BillingSummary,
  CloudStatus,
  EnergyAgentChatResponse,
  EnergyAgentConfirmResponse,
  EnergyAgentSession,
  FleetArray,
  FleetForecast,
  FleetTree,
  FleetTrends,
  LinkedSources,
  ListBundle,
  OnboardingStatus,
  Overview,
  PasswordLoginResult,
  PaymentsConnectStatus,
  SendPipeline,
  SolarEdgeConnectResult,
  Subscription,
  SubscriptionsList,
} from "./types";

export class UnauthorizedError extends Error {
  constructor() {
    super("Session expired — sign in again");
    this.name = "UnauthorizedError";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let unauthorizedNotified = false;

function notifyUnauthorizedOnce(): void {
  clearSession();
  if (unauthorizedNotified) return;
  unauthorizedNotified = true;
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

export function rearmUnauthorized(): void {
  unauthorizedNotified = false;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail))
      return body.detail.map((d: { msg?: string }) => d.msg || "").join("; ");
    if (body?.error) return String(body.error);
    if (body?.message) return String(body.message);
    return res.statusText || "Request failed";
  } catch {
    return res.statusText || "Request failed";
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(apiUrl(path), { ...init, headers });
  if (res.status === 401) {
    notifyUnauthorizedOnce();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────

export async function passwordLogin(
  email: string,
  password: string,
  product = "array_operator"
): Promise<PasswordLoginResult> {
  const data = await apiFetch<PasswordLoginResult>("/v1/auth/password-login", {
    method: "POST",
    body: JSON.stringify({ email, password, product }),
  });
  if (data.session_token) {
    localStorage.setItem(SESSION_KEY, data.session_token);
    rearmUnauthorized();
  }
  return data;
}

export async function requestMagicLink(email: string): Promise<{ ok?: boolean }> {
  return apiFetch("/v1/auth/request", {
    method: "POST",
    body: JSON.stringify({ email, product: "array_operator" }),
  });
}

export async function verifyLoginToken(
  token: string
): Promise<AuthVerifyResult> {
  return apiFetch<AuthVerifyResult>("/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

// ── Fleet / offtakers / account ──────────────────────────────────────────

/**
 * Live fleet-tree is sandbox-shaped: `{ columns: [{ array_id, array_name, … }] }`.
 * Mobile UI (and demo fixtures) expect `{ arrays: [{ id, name, … }] }` — same
 * adapt as desktop `fleet-store.js` `adaptTree`. Without this, signed-in Fleet
 * paints empty KPIs/sheet even when the API returns a full tree.
 */
export function normalizeFleetTree(raw: FleetTree | null | undefined): FleetTree {
  if (!raw || typeof raw !== "object") return { arrays: [] };
  const cols = (raw as { columns?: unknown[] }).columns;
  if (!Array.isArray(cols) || !cols.length) {
    // Already arrays-shaped (demo) or empty
    if (Array.isArray(raw.arrays)) return raw;
    return { ...raw, arrays: raw.arrays || [] };
  }

  const arrays: FleetArray[] = cols.map((c) => {
    const col = c as Record<string, unknown>;
    const alert = (col.alert || {}) as Record<string, unknown>;
    const sync = (col.sync_status || {}) as Record<string, unknown>;
    const invs = Array.isArray(col.inverters) ? col.inverters : [];
    return {
      id: (col.array_id ?? col.id) as number | string | undefined,
      name: String(col.array_name ?? col.name ?? "Array"),
      vendor: (col.vendor as string | null) ?? null,
      vendors: col.vendors as string[] | undefined,
      status: String(alert.status || col.status || "ok"),
      diagnosis: String(alert.headline || col.diagnosis || "") || null,
      current_power_w:
        col.current_power_w != null ? Number(col.current_power_w) : null,
      today_kwh:
        col.produced_today_kwh != null
          ? Number(col.produced_today_kwh)
          : col.today_kwh != null
            ? Number(col.today_kwh)
            : null,
      nameplate_kw:
        col.nameplate_kw != null ? Number(col.nameplate_kw) : null,
      peer_index:
        col.peer_index != null ? Number(col.peer_index) : null,
      last_sync_at:
        (sync.synced_at as string | null) ||
        (col.last_sync_at as string | null) ||
        null,
      synced_at: (sync.synced_at as string | null) || null,
      daily_split: col.daily_split as FleetArray["daily_split"],
      source_status: col.source_status,
      portfolio_name: col.portfolio_name,
      inverters: invs.map((inv) => {
        const i = inv as Record<string, unknown>;
        return {
          id: (i.inverter_id ?? i.id) as number | string | undefined,
          inverter_id: i.inverter_id as number | string | undefined,
          name: String(i.name || "Inverter"),
          model: (i.model as string) || null,
          status: String(i.status || "ok"),
          peer_index: i.peer_index != null ? Number(i.peer_index) : null,
          current_power_w:
            i.current_power_w != null ? Number(i.current_power_w) : null,
          nameplate_kw:
            i.nameplate_kw != null ? Number(i.nameplate_kw) : null,
          today_kwh:
            i.today_kwh != null
              ? Number(i.today_kwh)
              : i.window_kwh != null
                ? Number(i.window_kwh)
                : null,
          diagnosis: (i.diagnosis as string) || null,
          vendor: (i.vendor as string) || null,
          stale_hours: i.stale_hours,
          no_energy_register: !!i.no_energy_register,
        };
      }),
    } as FleetArray;
  });

  return {
    ...raw,
    arrays,
    summary: (raw as FleetTree).summary,
  };
}

export async function fetchOverview(): Promise<Overview> {
  if (isDemoMode()) return demoOverview;
  return apiFetch<Overview>("/v1/array-owners/overview");
}

export async function fetchFleetTree(force = false): Promise<FleetTree> {
  if (isDemoMode()) return demoFleet;
  const q = force ? "?force=1" : "";
  const raw = await apiFetch<FleetTree>(`/v1/array-owners/fleet-tree${q}`);
  return normalizeFleetTree(raw);
}

export async function fetchFleetTrends(): Promise<FleetTrends> {
  if (isDemoMode()) {
    return {
      years: [2025, 2026],
      ttm_kwh: 412000,
      ttm_savings_usd: 61800,
      lifetime_kwh: 1280000,
      by_array: [
        { array_id: 1, name: "Londonderry", lifetime_kwh: 890000 },
        { array_id: 2, name: "Cover Rooftop", lifetime_kwh: 280000 },
        { array_id: 3, name: "West Glover Barn", lifetime_kwh: 110000 },
      ],
      seasonal_yoy: [
        { month: 6, label: "Jun", latest_delta_pct: 4.2 },
        { month: 5, label: "May", latest_delta_pct: -1.1 },
      ],
    };
  }
  return apiFetch<FleetTrends>("/v1/array-owners/fleet-trends");
}

export async function fetchSendPipeline(): Promise<SendPipeline> {
  if (isDemoMode()) return demoPipeline;
  return apiFetch<SendPipeline>("/v1/array-operator/billing/send-pipeline");
}

export async function fetchAccount(): Promise<AccountMe> {
  if (isDemoMode()) return demoAccount;
  return apiFetch<AccountMe>("/v1/account");
}

export async function fetchBillingSummary(): Promise<BillingSummary> {
  if (isDemoMode()) {
    return {
      billing_basis: "kwh",
      mtd_kwh: 18420,
      estimated_cents: 9210,
      has_payment_method: true,
      card_brand: "visa",
      card_last4: "4242",
    };
  }
  return apiFetch<BillingSummary>("/v1/account/billing-summary");
}

export async function fetchBillingPortalUrl(): Promise<string> {
  if (isDemoMode()) throw new ApiError(400, "Billing portal unavailable in demo");
  const r = await apiFetch<{ url?: string }>("/v1/account/billing-portal");
  if (!r.url) throw new ApiError(502, "No portal URL returned");
  return r.url;
}

export async function fetchAddPaymentUrl(): Promise<string> {
  if (isDemoMode()) throw new ApiError(400, "Add card unavailable in demo");
  const r = await apiFetch<{ url?: string; checkout_url?: string }>(
    "/v1/account/add-payment-method",
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
  const url = r.checkout_url || r.url;
  if (!url) throw new ApiError(502, "No checkout URL returned");
  return url;
}

export async function updateCompanyName(company_name: string): Promise<void> {
  if (isDemoMode()) return;
  await apiFetch("/v1/account/company-name", {
    method: "POST",
    body: JSON.stringify({ name: company_name }),
  });
}

export async function setCaptureMode(mode: "cloud" | "device"): Promise<void> {
  if (isDemoMode()) return;
  await apiFetch("/v1/account/capture-mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function fetchCloudStatus(): Promise<CloudStatus> {
  if (isDemoMode()) return demoCloud;
  return apiFetch<CloudStatus>("/v1/cloud-capture/status");
}

export async function saveCloudCredential(body: {
  provider: string;
  username: string;
  password?: string;
  login_host?: string;
  enable?: boolean;
  consent?: boolean;
}): Promise<{ ok?: boolean }> {
  if (isDemoMode()) throw new ApiError(400, "Sign in to save cloud logins");
  return apiFetch("/v1/cloud-capture/credentials", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function toggleCloudCredential(body: {
  provider: string;
  username: string;
  enable: boolean;
}): Promise<void> {
  if (isDemoMode()) return;
  await apiFetch("/v1/cloud-capture/toggle", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function refreshCloudCapture(): Promise<void> {
  if (isDemoMode()) return;
  await apiFetch("/v1/cloud-capture/refresh", { method: "POST", body: "{}" });
}

export async function fetchOnboardingStatus(): Promise<OnboardingStatus> {
  if (isDemoMode()) {
    return {
      ok: true,
      connected: true,
      complete: true,
      next_step: "done",
      has_inverter: true,
      has_utility_accounts: true,
      arrays_total: 3,
    };
  }
  return apiFetch<OnboardingStatus>("/v1/array-owners/onboarding-status");
}

export async function fetchLinkedSources(): Promise<LinkedSources> {
  if (isDemoMode()) {
    return {
      sources: [
        {
          code: "chint",
          kind: "inverter",
          label: "Chint",
          count: 2,
          detail: "2 arrays",
        },
        {
          code: "solaredge",
          kind: "inverter",
          label: "SolarEdge",
          count: 1,
          detail: "1 array",
        },
      ],
      count: 2,
    };
  }
  return apiFetch<LinkedSources>("/v1/array-owners/linked-sources");
}

export async function connectSolarEdgeAccount(
  apiKey: string
): Promise<SolarEdgeConnectResult> {
  if (isDemoMode()) throw new ApiError(400, "Sign in to connect SolarEdge");
  return apiFetch<SolarEdgeConnectResult>(
    "/v1/array-owners/solaredge/connect-account",
    {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey }),
    }
  );
}

export async function fetchSubscriptions(): Promise<SubscriptionsList> {
  if (isDemoMode()) return demoSubs;
  return apiFetch<SubscriptionsList>("/v1/array-operator/billing/subscriptions");
}

export async function fetchListBundle(): Promise<ListBundle> {
  if (isDemoMode()) {
    return {
      ok: true,
      subscriptions: demoSubs.subscriptions || [],
      arrays: [
        { id: 1, name: "Londonderry" },
        { id: 2, name: "Cover Rooftop" },
        { id: 3, name: "West Glover Barn" },
      ],
      utility_accounts: [
        {
          account_id: 11,
          provider: "gmp",
          nickname: "GMP master",
          account_number: "12345",
          bill_count: 12,
        },
      ],
    };
  }
  return apiFetch<ListBundle>("/v1/array-operator/billing/list-bundle");
}

/** Manual offtaker create (multipart form, no workbook). */
export async function createSubscription(fields: {
  customer_name: string;
  client_email?: string;
  array_id?: number | null;
  utility_account_id?: number | null;
  allocation_pct?: number | null;
  delivery_mode?: string;
  send_mode?: string;
  cadence?: string;
  enabled?: boolean;
}): Promise<{ ok?: boolean; subscription?: Subscription }> {
  if (isDemoMode()) {
    return demoCreateSubscription(fields) as {
      ok?: boolean;
      subscription?: Subscription;
    };
  }
  const fd = new FormData();
  fd.set("customer_name", fields.customer_name);
  if (fields.client_email) fd.set("client_email", fields.client_email);
  if (fields.array_id != null) fd.set("array_id", String(fields.array_id));
  if (fields.utility_account_id != null)
    fd.set("utility_account_id", String(fields.utility_account_id));
  if (fields.allocation_pct != null)
    fd.set("allocation_pct", String(fields.allocation_pct));
  fd.set("delivery_mode", fields.delivery_mode || "approval");
  fd.set("send_mode", fields.send_mode || "to_me");
  fd.set("cadence", fields.cadence || "monthly");
  fd.set("enabled", fields.enabled === false ? "false" : "true");

  const headers = new Headers();
  const token = getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Do NOT set Content-Type — browser sets multipart boundary.
  const res = await fetch(apiUrl("/v1/array-operator/billing/subscriptions"), {
    method: "POST",
    headers,
    body: fd,
  });
  if (res.status === 401) {
    notifyUnauthorizedOnce();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  return (await res.json()) as { ok?: boolean; subscription?: Subscription };
}

export async function patchSubscription(
  subId: number | string,
  body: Record<string, unknown>
): Promise<{ ok?: boolean; subscription?: Subscription }> {
  if (isDemoMode()) {
    const r = demoPatchSubscription(subId, body);
    if (!r.ok || !r.subscription)
      throw new ApiError(404, "Demo offtaker not found");
    return { ok: true, subscription: r.subscription as Subscription };
  }
  return apiFetch(`/v1/array-operator/billing/subscriptions/${subId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Open invoice/summary PDF in a new tab (blob URL). */
export async function openSubscriptionPreview(
  subId: number | string,
  kind: "invoice" | "summary" = "invoice",
  fmt: "pdf" | "xlsx" = "pdf"
): Promise<void> {
  if (isDemoMode()) {
    // Sample HTML stand-in so the Preview button is fully exercisable in demo.
    const sub =
      (demoSubs.subscriptions || []).find((s) => String(s.id) === String(subId)) ||
      null;
    const name =
      sub?.customer_name ||
      sub?.offtaker_name ||
      sub?.name ||
      `Offtaker #${subId}`;
    const share =
      sub?.allocation_pct != null
        ? `${(Number(sub.allocation_pct) * 100).toFixed(1)}%`
        : sub?.share_pct != null
          ? `${sub.share_pct}%`
          : "—";
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Demo ${kind} — ${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#0f172a}
h1{font-size:1.25rem} .muted{color:#64748b;font-size:.875rem} .box{border:1px solid #cbd5e1;border-radius:12px;padding:1rem;margin-top:1rem}</style>
</head><body>
<h1>Demo ${kind === "summary" ? "summary" : "invoice"} preview</h1>
<p class="muted">Sample only — sign in for a real PDF from your utility bills.</p>
<div class="box">
  <div><strong>${name}</strong></div>
  <div class="muted">Share ${share} · offtaker id ${subId}</div>
  <p style="margin-top:1rem">Green Mountain Community Solar · period sample</p>
  <p class="muted">This is not a bill. Live accounts open a generated PDF here.</p>
</div>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const token = getSession();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(
    apiUrl(
      `/v1/array-operator/billing/subscriptions/${subId}/preview?kind=${kind}&fmt=${fmt}`
    ),
    { headers }
  );
  if (res.status === 401) {
    notifyUnauthorizedOnce();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  // Revoke later so the tab still has time to load.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function fetchFleetForecast(
  windowDays = 14
): Promise<FleetForecast> {
  if (isDemoMode()) {
    return {
      available: true,
      window_days: windowDays,
      expected_kwh: 18500,
      actual_kwh: 17240,
      expected_matched_kwh: 18500,
      ratio: 0.932,
      kwh_per_kw_day: 3.4,
      arrays: [
        {
          array_id: 1,
          array_name: "Londonderry",
          available: true,
          actual_kwh: 9800,
          expected_kwh: 10200,
          ratio: 0.96,
          kwh_per_kw_day: 3.6,
        },
        {
          array_id: 2,
          array_name: "Cover Rooftop",
          available: true,
          actual_kwh: 4200,
          expected_kwh: 5100,
          ratio: 0.82,
          kwh_per_kw_day: 2.9,
        },
        {
          array_id: 3,
          array_name: "West Glover Barn",
          available: true,
          actual_kwh: 3240,
          expected_kwh: 3200,
          ratio: 1.01,
          kwh_per_kw_day: 3.5,
        },
      ],
      skipped: [],
    };
  }
  return apiFetch<FleetForecast>(
    `/v1/array-owners/forecast-fleet?window_days=${windowDays}`
  );
}

export async function fetchPaymentsConnect(): Promise<PaymentsConnectStatus> {
  if (isDemoMode()) {
    return { ok: true, enabled: true, connected: false, ready: false };
  }
  return apiFetch<PaymentsConnectStatus>(
    "/v1/array-operator/billing/payments/connect"
  );
}

export async function startPaymentsConnect(): Promise<string> {
  if (isDemoMode()) throw new ApiError(400, "Sign in for Stripe Connect");
  const r = await apiFetch<{ url?: string }>(
    "/v1/array-operator/billing/payments/connect",
    { method: "POST", body: "{}" }
  );
  if (!r.url) throw new ApiError(502, "No Connect URL returned");
  return r.url;
}

// ── Energy Agent ─────────────────────────────────────────────────────────

export async function startAgentSession(
  context?: Record<string, unknown>
): Promise<EnergyAgentSession> {
  if (isDemoMode()) {
    return {
      session_id: "demo_session",
      intro:
        "Hi — demo mode Energy Agent. I'm showing sample fleet data. Sign in with a real account for live tools.",
      brain: "demo",
    };
  }
  return apiFetch<EnergyAgentSession>("/v1/energy-agent/session", {
    method: "POST",
    body: JSON.stringify({ context: context || { client: "owner-web" } }),
  });
}

export async function agentChat(
  sessionId: string,
  message: string,
  context?: Record<string, unknown>
): Promise<EnergyAgentChatResponse> {
  if (isDemoMode()) {
    await new Promise((r) => setTimeout(r, 450));
    const m = message.toLowerCase();
    let reply =
      "In demo mode I summarize sample data: 3 arrays, Cover Rooftop underperforming, 13/14 offtaker invoices sent last cycle. Sign in for live actions.";
    let pending: EnergyAgentChatResponse["pending"] = null;
    if (m.includes("attention") || m.includes("health"))
      reply =
        "Cover Rooftop is underperforming (peer ~0.78). Londonderry and West Glover look healthy. Next: check Cover’s inverter feed and shading/fault history.";
    if (
      m.includes("investigat") ||
      m.includes("offline") ||
      m.includes("inverter") ||
      m.includes("fault") ||
      m.includes("underperform")
    )
      reply =
        "Investigation (demo): Cover Rooftop SE10K is the unit to check — peer ~0.78, 3.2 kW now vs site nameplate. Likely causes: partial string offline, communications lag, or shading. I’d pull last-24h power curve, fault codes, and peer delta next. Londonderry (4 inv) and West Glover look clear.";
    if (m.includes("invoice") || m.includes("offtaker"))
      reply =
        "Last cycle Jun 2026: 13 of 14 offtaker reports sent. Fleet default is approve-to-send. Town Library, Fire Station, and School District are on the sample roster.";
    if (m.includes("hands-off") || m.includes("setup") || m.includes("connect"))
      reply =
        "Demo feeds look connected (Chint + GMP cloud logins). In a live account I’d check vault health, bill sources, send mode, and online pay.";
    // Demo confirm card so UI can be exercised without a live session.
    if (m.includes("change") || m.includes("set ") || m.includes("update")) {
      reply =
        "Ready to update Town Library allocation to 15%. Confirm to apply (demo — no write).";
      pending = {
        id: "demo_pending",
        type: "api_patch",
        needs_confirm: true,
        args: {
          path: "/v1/array-operator/billing/subscriptions/1",
          body: { allocation_pct: 0.15 },
          reason: "Set Town Library to 15%",
        },
      };
    }
    return { reply, session_id: sessionId, pending };
  }
  return apiFetch<EnergyAgentChatResponse>("/v1/energy-agent/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      message,
      context: context || { client: "owner-web", surface: "mobile_home" },
    }),
  });
}

export async function agentConfirm(
  sessionId: string,
  confirm: boolean,
  pendingId?: string | null
): Promise<EnergyAgentConfirmResponse> {
  if (isDemoMode()) {
    await new Promise((r) => setTimeout(r, 300));
    return {
      ok: true,
      cancelled: !confirm,
      command: confirm
        ? {
            type: "api_patch",
            args: { body: { allocation_pct: 0.15 } },
          }
        : null,
    };
  }
  return apiFetch<EnergyAgentConfirmResponse>("/v1/energy-agent/confirm", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      confirm,
      pending_id: pendingId || undefined,
    }),
  });
}
