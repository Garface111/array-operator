import { clearSession, getSession, SESSION_KEY, UNAUTHORIZED_EVENT } from "./session";
import type {
  EnergyAgentChatResponse,
  EnergyAgentSession,
  FleetTree,
  Overview,
  PasswordLoginResult,
  SendPipeline,
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

// ── Fleet / offtakers ────────────────────────────────────────────────────

export function fetchOverview(): Promise<Overview> {
  return apiFetch<Overview>("/v1/array-owners/overview");
}

export function fetchFleetTree(force = false): Promise<FleetTree> {
  const q = force ? "?force=1" : "";
  return apiFetch<FleetTree>(`/v1/array-owners/fleet-tree${q}`);
}

export function fetchSendPipeline(): Promise<SendPipeline> {
  return apiFetch<SendPipeline>("/v1/array-operator/billing/send-pipeline");
}

// ── Energy Agent ─────────────────────────────────────────────────────────

export function startAgentSession(context?: Record<string, unknown>): Promise<EnergyAgentSession> {
  return apiFetch<EnergyAgentSession>("/v1/energy-agent/session", {
    method: "POST",
    body: JSON.stringify({ context: context || { client: "owner-web" } }),
  });
}

export function agentChat(
  sessionId: string,
  message: string,
  context?: Record<string, unknown>
): Promise<EnergyAgentChatResponse> {
  return apiFetch<EnergyAgentChatResponse>("/v1/energy-agent/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      message,
      context: context || { client: "owner-web", surface: "mobile_home" },
    }),
  });
}
