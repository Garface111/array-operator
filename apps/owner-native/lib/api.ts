import { API_BASE } from "./theme";
import { clearSession, getSession } from "./session";
import type {
  AccountInfo,
  FleetArray,
  FleetInverter,
  FleetTree,
  OfftakerSub,
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

type FetchOpts = RequestInit & { logoutOn401?: boolean };

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (body?.error) return String(body.error);
    return res.statusText || "Request failed";
  } catch {
    return res.statusText || "Request failed";
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: FetchOpts = {}
): Promise<T> {
  const { logoutOn401 = true, ...req } = init;
  const headers = new Headers(req.headers || {});
  if (!headers.has("Content-Type") && req.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = await getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { ...req, headers });
  if (res.status === 401) {
    if (logoutOn401 && token) await clearSession();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function passwordLogin(
  email: string,
  password: string
): Promise<PasswordLoginResult> {
  return apiFetch("/v1/auth/password-login", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      product: "array_operator",
    }),
    logoutOn401: false,
  });
}

export async function requestMagicLink(email: string): Promise<void> {
  await apiFetch("/v1/auth/request", {
    method: "POST",
    body: JSON.stringify({ email, product: "array_operator" }),
    logoutOn401: false,
  });
}

type FleetTreeRaw = {
  columns?: Array<Record<string, unknown>>;
  arrays?: FleetArray[];
  summary?: FleetTree["summary"];
};

function adaptFleetTree(raw: FleetTreeRaw | null | undefined): FleetTree {
  if (!raw) return { arrays: [] };
  const cols = raw.columns || [];
  if (cols.length) {
    const arrays: FleetArray[] = cols.map((c) => {
      const invRaw = (c.inverters as Array<Record<string, unknown>>) || [];
      const invs: FleetInverter[] = invRaw.map((inv, idx) => ({
        id: (inv.inverter_id as string | number) ?? `inv-${idx}`,
        name: String(inv.name || "Inverter"),
        status: String(inv.status || "unknown"),
        peer_index: (inv.peer_index as number) ?? null,
        current_power_w: (inv.current_power_w as number) ?? null,
        nameplate_kw: (inv.nameplate_kw as number) ?? null,
        diagnosis: (inv.diagnosis as string) ?? null,
        daily: Array.isArray(inv.daily) ? (inv.daily as FleetInverter["daily"]) : [],
      }));
      const alert = c.alert as { status?: string; level?: string } | undefined;
      let status = String(alert?.status || alert?.level || "ok");
      if (!alert?.status || status === "ok") {
        const bad = invs.find((i) => /dead|fault|offline|error/i.test(i.status));
        const warn = invs.find((i) => /under|attn|warn|stale/i.test(i.status));
        if (bad) status = bad.status;
        else if (warn) status = warn.status;
      }
      const nameplate = invs.reduce(
        (s, i) => s + (i.nameplate_kw && i.nameplate_kw > 0 ? i.nameplate_kw : 0),
        0
      );
      return {
        id: (c.array_id as string | number) ?? String(c.array_name || "unknown"),
        name: String(c.array_name || "Array"),
        status,
        vendor: (c.vendor as string) ?? null,
        current_power_w: (c.current_power_w as number) ?? null,
        today_kwh: (c.produced_today_kwh as number) ?? null,
        nameplate_kw: nameplate > 0 ? nameplate : null,
        daily: Array.isArray(c.daily) ? (c.daily as FleetArray["daily"]) : [],
        inverters: invs,
      };
    });
    return { arrays, summary: raw.summary };
  }
  if (raw.arrays?.length) return { arrays: raw.arrays, summary: raw.summary };
  return { arrays: [], summary: raw.summary };
}

export async function fetchFleetTree(force = false): Promise<FleetTree> {
  const q = force ? "?force=1" : "";
  const raw = await apiFetch<FleetTreeRaw>(`/v1/array-owners/fleet-tree${q}`);
  return adaptFleetTree(raw);
}

export function fetchOverview(): Promise<Overview> {
  return apiFetch("/v1/array-owners/overview");
}

export function fetchSendPipeline(): Promise<SendPipeline> {
  return apiFetch("/v1/array-operator/billing/send-pipeline", {
    logoutOn401: false,
  });
}

export async function fetchSubscriptions(): Promise<{
  subscriptions: OfftakerSub[];
  arrays: Array<{ id?: number; name?: string }>;
}> {
  const b = await apiFetch<{
    subscriptions?: OfftakerSub[];
    arrays?: Array<{ id?: number; name?: string }>;
  }>("/v1/array-operator/billing/list-bundle", { logoutOn401: false });
  return {
    subscriptions: b.subscriptions || [],
    arrays: b.arrays || [],
  };
}

export function fetchAccount(): Promise<AccountInfo> {
  return apiFetch("/v1/account");
}
