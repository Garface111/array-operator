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
  CloudStatus,
  EnergyAgentChatResponse,
  EnergyAgentSession,
  FleetTree,
  Overview,
  PasswordLoginResult,
  SendPipeline,
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

export async function fetchSendPipeline(): Promise<SendPipeline> {
  if (isDemoMode()) return demoPipeline;
  return apiFetch<SendPipeline>("/v1/array-operator/billing/send-pipeline");
}

export async function fetchAccount(): Promise<AccountMe> {
  if (isDemoMode()) return demoAccount;
  return apiFetch<AccountMe>("/v1/account");
}

export async function fetchCloudStatus(): Promise<CloudStatus> {
  if (isDemoMode()) return demoCloud;
  return apiFetch<CloudStatus>("/v1/cloud-capture/status");
}

export async function fetchSubscriptions(): Promise<SubscriptionsList> {
  if (isDemoMode()) return demoSubs;
  return apiFetch<SubscriptionsList>("/v1/array-operator/billing/subscriptions");
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
