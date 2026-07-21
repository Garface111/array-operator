import { clearSession, getSession, SESSION_KEY, UNAUTHORIZED_EVENT } from "./session";
import type {
  AccountInfo,
  EnergyAgentChatResponse,
  EnergyAgentSession,
  FleetArray,
  FleetInverter,
  FleetTree,
  FleetTreeRaw,
  Overview,
  PasswordLoginResult,
  SendPipeline,
  SubscriptionsPayload,
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

/**
 * Absolute API origin for Capacitor/native shells (local WebView origin has no
 * /v1 proxy). Same-origin browser deploys (arrayoperator.com/m) and local web
 * preview use "" so /v1 stays on the page origin (Netlify or dev proxy).
 */
export function apiOrigin(): string {
  try {
    const { protocol, hostname } = window.location;
    if (protocol === "capacitor:" || protocol === "ionic:") {
      return "https://arrayoperator.com";
    }
    // Capacitor Android/iOS often load as https://localhost — but only when the
    // Capacitor bridge is present. Plain localhost web preview must stay relative
    // (otherwise CORS blocks arrayoperator.com and the fleet looks empty).
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
      .Capacitor;
    if (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
      return "https://arrayoperator.com";
    }
    if (cap && (hostname === "localhost" || hostname === "127.0.0.1")) {
      return "https://arrayoperator.com";
    }
  } catch {
    /* ignore */
  }
  return "";
}

function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = apiOrigin();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
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

export type ApiFetchOptions = RequestInit & {
  /**
   * When true (default for most calls), a 401 clears so_session and routes to login.
   * Set false for optional/secondary endpoints so a billing 401 cannot wipe a good session.
   */
  logoutOn401?: boolean;
};

export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchOptions = {}
): Promise<T> {
  const { logoutOn401 = true, ...req } = init;
  const headers = new Headers(req.headers || {});
  if (!headers.has("Content-Type") && req.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(apiUrl(path), { ...req, headers });
  if (res.status === 401) {
    if (logoutOn401 && token) {
      notifyUnauthorizedOnce();
    }
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
  // Login itself must not clear a stale token mid-request.
  const data = await apiFetch<PasswordLoginResult>("/v1/auth/password-login", {
    method: "POST",
    body: JSON.stringify({ email, password, product }),
    logoutOn401: false,
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
    logoutOn401: false,
  });
}

// ── Adapters (API shape → UI shape) ──────────────────────────────────────

/** Map overview arrays (array_id / health / peer) → FleetArray[]. */
export function adaptOverviewArrays(overview: Overview | null | undefined): FleetArray[] {
  if (!overview?.arrays?.length) return [];
  return overview.arrays.map((a) => {
    const id = a.array_id ?? a.id ?? a.name ?? "unknown";
    const status =
      (a.health && typeof a.health.status === "string" && a.health.status) ||
      (a.peer && typeof a.peer.status === "string" && a.peer.status) ||
      (typeof a.status === "string" ? a.status : "") ||
      "unknown";
    const today =
      a.today && typeof a.today === "object" && a.today.kwh != null
        ? Number(a.today.kwh)
        : null;
    const liveW =
      a.live && typeof a.live === "object" && a.live.current_power_w != null
        ? Number(a.live.current_power_w)
        : null;
    return {
      id,
      name: String(a.name || "Array"),
      status: String(status),
      peer_index: a.peer?.peer_index ?? null,
      diagnosis: a.peer?.diagnosis ?? a.health?.message ?? null,
      today_kwh: today,
      current_power_w: liveW,
      inverters: [],
    };
  });
}

/**
 * Live fleet-tree returns { columns: [...] } (sandbox shape). Desktop
 * fleet-store.js adaptTree() is the source of truth — mirror it here.
 */
export function adaptFleetTree(raw: FleetTreeRaw | null | undefined): FleetTree {
  if (!raw) return { arrays: [] };

  // Prefer columns (real API). Fall back to arrays only if already canonical.
  const fromColumns = (raw.columns || []).map((c): FleetArray => {
    const invs: FleetInverter[] = (c.inverters || []).map((inv, idx) => ({
      id: inv.inverter_id != null ? inv.inverter_id : `inv-${idx}`,
      name: String(inv.name || "Inverter"),
      status: String(inv.status || "unknown"),
      peer_index: inv.peer_index ?? null,
      current_power_w: inv.current_power_w ?? null,
      nameplate_kw: inv.nameplate_kw ?? null,
      diagnosis: inv.diagnosis ?? null,
      daily: Array.isArray(inv.daily) ? inv.daily : [],
    }));
    const alertStatus =
      (c.alert && (c.alert.status || c.alert.level || c.alert.headline)) || "";
    // Roll up worst inverter status when array alert is quiet.
    let status = String(alertStatus || "ok");
    if (!alertStatus || alertStatus === "ok") {
      const bad = invs.find((i) => /dead|fault|offline|error/i.test(i.status));
      const warn = invs.find((i) => /under|attn|warn|stale|gap/i.test(i.status));
      if (bad) status = bad.status;
      else if (warn) status = warn.status;
    }
    const nameplate = invs.reduce(
      (s, inv) => s + (inv.nameplate_kw && inv.nameplate_kw > 0 ? inv.nameplate_kw : 0),
      0
    );
    return {
      id: c.array_id ?? c.array_name ?? "unknown",
      name: String(c.array_name || "Array"),
      status,
      vendor: c.vendor ?? null,
      current_power_w: c.current_power_w ?? null,
      today_kwh: c.produced_today_kwh ?? null,
      nameplate_kw: nameplate > 0 ? nameplate : null,
      daily: Array.isArray(c.daily) ? c.daily : [],
      is_daylight: c.is_daylight !== false,
      inverters: invs,
    };
  });

  if (fromColumns.length) {
    return { arrays: fromColumns, summary: raw.summary, raw };
  }

  // Legacy shape already using arrays[]
  if (Array.isArray(raw.arrays) && raw.arrays.length) {
    return {
      arrays: raw.arrays.map((a) => ({
        id: a.id ?? a.name ?? "unknown",
        name: String(a.name || "Array"),
        status: String(a.status || "unknown"),
        inverters: (a.inverters || []).map((inv, idx) => ({
          id: inv.id ?? `inv-${idx}`,
          name: String(inv.name || "Inverter"),
          status: String(inv.status || "unknown"),
          peer_index: inv.peer_index ?? null,
          current_power_w: inv.current_power_w ?? null,
          nameplate_kw: inv.nameplate_kw ?? null,
          diagnosis: inv.diagnosis ?? null,
        })),
      })),
      summary: raw.summary,
      raw,
    };
  }

  return { arrays: [], summary: raw.summary, raw };
}

// ── Fleet / offtakers ────────────────────────────────────────────────────

export function fetchOverview(): Promise<Overview> {
  return apiFetch<Overview>("/v1/array-owners/overview");
}

export async function fetchFleetTree(force = false): Promise<FleetTree> {
  const q = force ? "?force=1" : "";
  const raw = await apiFetch<FleetTreeRaw>(`/v1/array-owners/fleet-tree${q}`);
  return adaptFleetTree(raw);
}

export function fetchSendPipeline(): Promise<SendPipeline> {
  // Optional pulse — never log the owner out if billing auth disagrees.
  return apiFetch<SendPipeline>("/v1/array-operator/billing/send-pipeline", {
    logoutOn401: false,
  });
}

export function fetchSubscriptions(): Promise<SubscriptionsPayload> {
  return apiFetch<SubscriptionsPayload>("/v1/array-operator/billing/list-bundle", {
    logoutOn401: false,
  });
}

export function fetchAccount(): Promise<AccountInfo> {
  return apiFetch<AccountInfo>("/v1/account");
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
  context?: Record<string, unknown>,
  attachmentIds?: string[]
): Promise<EnergyAgentChatResponse> {
  return apiFetch<EnergyAgentChatResponse>("/v1/energy-agent/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      message,
      context: context || {
        client: "owner-web",
        surface: "agent_sheet_mobile",
        mobile: true,
      },
      attachment_ids: attachmentIds?.length ? attachmentIds : undefined,
    }),
  });
}

export function agentConfirm(
  sessionId: string,
  confirm: boolean,
  pendingId?: string | null
): Promise<EnergyAgentChatResponse & { result?: unknown; cancelled?: boolean }> {
  return apiFetch("/v1/energy-agent/confirm", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      confirm,
      pending_id: pendingId || undefined,
    }),
  });
}

/** Uploaded chat asset returned by POST /v1/energy-agent/upload */
export type AgentUploadAsset = {
  id: string;
  filename?: string;
  mime?: string;
  size?: number;
  kind?: string;
  preview?: string | null;
};

/**
 * Attach a file/image for the next Energy Agent chat turn.
 * Uses multipart FormData — do not set Content-Type (browser sets boundary).
 */
export async function uploadAgentFile(file: File): Promise<AgentUploadAsset> {
  const fd = new FormData();
  fd.append("file", file, file.name || "upload.bin");
  const headers = new Headers();
  const token = getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(apiUrl("/v1/energy-agent/upload"), {
    method: "POST",
    headers,
    body: fd,
  });
  if (res.status === 401) {
    notifyUnauthorizedOnce();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }
  const data = (await res.json()) as { ok?: boolean; asset?: AgentUploadAsset };
  if (!data?.asset?.id) {
    throw new ApiError(500, "Upload succeeded but no asset id returned");
  }
  return data.asset;
}
