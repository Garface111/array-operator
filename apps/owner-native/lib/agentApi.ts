import { API_BASE } from "./theme";
import { getSession } from "./session";

async function eaFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = await getSession();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* ignore */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function startAgentSession(context?: Record<string, unknown>) {
  return eaFetch<{ session_id?: string; intro?: string }>(
    "/v1/energy-agent/session",
    {
      method: "POST",
      body: JSON.stringify({
        context: context || { client: "owner-native", surface: "rn_agent" },
      }),
    }
  );
}

export async function agentChat(
  sessionId: string,
  message: string,
  context?: Record<string, unknown>
) {
  return eaFetch<{
    reply?: string;
    speak?: string;
    pending?: { id?: string; reason?: string; tool?: string } | null;
    tool_trace?: Array<{ name?: string }>;
    ui_commands?: Array<{ type?: string; url?: string }>;
  }>("/v1/energy-agent/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      message,
      context: context || { client: "owner-native", surface: "rn_agent", mobile: true },
    }),
  });
}

export async function agentConfirm(
  sessionId: string,
  confirm: boolean,
  pendingId?: string
) {
  return eaFetch<{
    result?: { message?: string; error?: string };
    cancelled?: boolean;
    message?: string;
  }>("/v1/energy-agent/confirm", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      confirm,
      pending_id: pendingId,
    }),
  });
}
