import { clearSession, getSession, SESSION_KEY, UNAUTHORIZED_EVENT } from "./session";
import {
  demoAccount,
  demoCloud,
  demoFleet,
  demoOverview,
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
  EnergyAgentSession,
  FleetTree,
  FleetTrends,
  LinkedSources,
  OnboardingStatus,
  Overview,
  PasswordLoginResult,
  PaymentsConnectStatus,
  SendPipeline,
  SolarEdgeConnectResult,
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

  const res = await fetch(path, { ...init, headers });
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

export async function fetchOverview(): Promise<Overview> {
  if (isDemoMode()) return demoOverview;
  return apiFetch<Overview>("/v1/array-owners/overview");
}

export async function fetchFleetTree(force = false): Promise<FleetTree> {
  if (isDemoMode()) return demoFleet;
  const q = force ? "?force=1" : "";
  return apiFetch<FleetTree>(`/v1/array-owners/fleet-tree${q}`);
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
    if (m.includes("attention") || m.includes("health"))
      reply =
        "Cover Rooftop is underperforming (peer ~0.78). Londonderry and West Glover look healthy. Next: check Cover’s inverter feed and shading/fault history.";
    if (m.includes("invoice") || m.includes("offtaker"))
      reply =
        "Last cycle Jun 2026: 13 of 14 offtaker reports sent. Fleet default is approve-to-send. Town Library, Fire Station, and School District are on the sample roster.";
    if (m.includes("hands-off") || m.includes("setup") || m.includes("connect"))
      reply =
        "Demo feeds look connected (Chint + GMP cloud logins). In a live account I’d check vault health, bill sources, send mode, and online pay.";
    return { reply, session_id: sessionId };
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
