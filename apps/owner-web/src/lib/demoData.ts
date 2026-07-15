/**
 * Realistic demo snapshot so we can show the UI without a live session.
 * Enable with ?demo=1 or localStorage ao_owner_demo=1
 */
import type {
  AccountMe,
  CloudStatus,
  FleetTree,
  Overview,
  SendPipeline,
  Subscription,
  SubscriptionsList,
} from "./types";

/** True on the dedicated preview host so testers land in the app without a login. */
export function isPreviewHost(): boolean {
  try {
    const h = location.hostname || "";
    // Standalone preview site only — NOT arrayoperator.com/m (beta uses real auth).
    return (
      h === "ao-owner-web-preview.netlify.app" ||
      h.endsWith("--ao-owner-web-preview.netlify.app")
    );
  } catch {
    return false;
  }
}

export function isDemoMode(): boolean {
  try {
    if (localStorage.getItem("ao_owner_demo") === "0") return false;
    if (localStorage.getItem("ao_owner_demo") === "1") return true;
    if (/[?&]demo=1(&|$)/.test(location.search || "")) return true;
    // Preview site defaults to demo so Ford can open the URL and test immediately.
    // Real sign-in still works and clears demo (see LoginScreen).
    if (isPreviewHost() && !localStorage.getItem("so_session")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Stick demo on once detected (e.g. ?demo=1). React Router tab links drop the
 * query string; without localStorage the next screen would call live APIs → 401.
 * Safe to call often — only writes when already in demo and not sticky yet.
 */
export function ensureDemoSticky(): void {
  try {
    if (localStorage.getItem("ao_owner_demo") === "0") return;
    if (localStorage.getItem("ao_owner_demo") === "1") return;
    if (
      /[?&]demo=1(&|$)/.test(location.search || "") ||
      (isPreviewHost() && !localStorage.getItem("so_session"))
    ) {
      localStorage.setItem("ao_owner_demo", "1");
      localStorage.removeItem("so_session");
    }
  } catch {
    /* ignore */
  }
}

export function enableDemoMode(): void {
  try {
    localStorage.setItem("ao_owner_demo", "1");
    localStorage.removeItem("so_session");
  } catch {
    /* ignore */
  }
}

export function disableDemoMode(): void {
  try {
    localStorage.removeItem("ao_owner_demo");
  } catch {
    /* ignore */
  }
}

export const demoAccount: AccountMe = {
  tenant_id: "ten_demo_owner_web",
  tenant_key: "sol_live_demo_preview_only",
  name: "Green Mountain Community Solar",
  company_name: "Green Mountain Community Solar",
  email: "demo@arrayoperator.com",
  product: "array_operator",
  capture_mode: "cloud",
  active: true,
  is_demo: true,
  has_payment_method: true,
  subscription_status: "active",
  plan_features: {
    plan: "both",
    plan_chosen: true,
    vendor_data: true,
    invoicing: true,
  },
};

export const demoOverview: Overview = {
  source: "demo",
  totals: {
    array_count: 3,
    today_kwh: 1842,
    value_today: 276,
    current_power_w: 62400,
  },
  peer_summary: { ok: 9, underperforming: 1, dead: 0 },
  arrays: [
    {
      id: 1,
      name: "Londonderry",
      status: "ok",
      today_kwh: 980,
      nameplate_kw: 99,
      current_power_w: 52000,
      peer_index: 1.02,
    },
    {
      id: 2,
      name: "Cover Rooftop",
      status: "underperforming",
      today_kwh: 412,
      nameplate_kw: 10,
      current_power_w: 3200,
      peer_index: 0.78,
      diagnosis: "Below peer cohort for 3 days",
    },
    {
      id: 3,
      name: "West Glover Barn",
      status: "ok",
      today_kwh: 450,
      nameplate_kw: 28,
      current_power_w: 7200,
      peer_index: 0.99,
    },
  ],
};

export const demoFleet: FleetTree = {
  arrays: [
    {
      id: 1,
      name: "Londonderry",
      status: "ok",
      last_sync_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      inverters: [
        { id: 11, name: "SE33.3K A", status: "ok", peer_index: 1.01, current_power_w: 18000, nameplate_kw: 33.3, today_kwh: 260 },
        { id: 12, name: "SE33.3K B", status: "ok", peer_index: 1.0, current_power_w: 17500, nameplate_kw: 33.3, today_kwh: 255 },
        { id: 13, name: "SE20K C", status: "ok", peer_index: 1.04, current_power_w: 11000, nameplate_kw: 20, today_kwh: 190 },
        { id: 14, name: "SE10K D", status: "ok", peer_index: 0.98, current_power_w: 5500, nameplate_kw: 10, today_kwh: 95 },
      ],
    },
    {
      id: 2,
      name: "Cover Rooftop",
      status: "underperforming",
      last_sync_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      inverters: [
        {
          id: 21,
          name: "SE10K",
          status: "underperforming",
          peer_index: 0.78,
          current_power_w: 3200,
          nameplate_kw: 10,
          today_kwh: 412,
          diagnosis: "Below peer cohort for 3 days",
        },
      ],
    },
    {
      id: 3,
      name: "West Glover Barn",
      status: "ok",
      last_sync_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      inverters: [
        { id: 31, name: "String 1", status: "ok", peer_index: 1.0 },
        { id: 32, name: "String 2", status: "ok", peer_index: 0.97 },
      ],
    },
  ],
};

export const demoPipeline: SendPipeline = {
  total_enabled: 14,
  default_delivery_mode: "approval",
  last: {
    delivered: 13,
    sent: 13,
    period_label: "Jun 2026",
    period_month: "2026-06",
  },
};

export const demoCloud: CloudStatus = {
  encryption_ready: true,
  collection_enabled: true,
  harvesting_enabled: true,
  credentials: [
    {
      provider: "chint",
      username: "ops@gmcs.example",
      enabled: true,
      last_harvest_ok: true,
      last_harvest_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      last_harvest_status: "ok",
    },
    {
      provider: "gmp",
      username: "bills@gmcs.example",
      enabled: true,
      last_harvest_ok: true,
      last_harvest_at: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
      last_harvest_status: "ok",
    },
  ],
};

/** Mutable demo roster so Add/Edit offtaker can be dogfooded without a live session. */
export const demoSubs: SubscriptionsList = {
  ok: true,
  subscriptions: [
    {
      id: 1,
      offtaker_name: "Town Library",
      customer_name: "Town Library",
      email: "lib@example.org",
      client_email: "lib@example.org",
      share_pct: 12.5,
      allocation_pct: 0.125,
      delivery_mode: "approval",
      enabled: true,
      utility_account_name: "GMP master",
      array_id: 1,
    },
    {
      id: 2,
      offtaker_name: "Fire Station",
      customer_name: "Fire Station",
      email: "fire@example.org",
      client_email: "fire@example.org",
      share_pct: 8,
      allocation_pct: 0.08,
      delivery_mode: "auto",
      enabled: true,
      utility_account_name: "GMP master",
      array_id: 1,
    },
    {
      id: 3,
      offtaker_name: "School District",
      customer_name: "School District",
      email: "biz@schools.example",
      client_email: "biz@schools.example",
      share_pct: 22,
      allocation_pct: 0.22,
      delivery_mode: "approval",
      enabled: true,
      utility_account_name: "GMP master",
      array_id: 2,
    },
  ],
};

let demoSubSeq = 100;

export function demoCreateSubscription(fields: {
  customer_name: string;
  client_email?: string;
  array_id?: number | null;
  utility_account_id?: number | null;
  allocation_pct?: number | null;
  delivery_mode?: string;
  enabled?: boolean;
}): { ok: boolean; subscription: Subscription } {
  const id = ++demoSubSeq;
  const alloc =
    fields.allocation_pct != null && fields.allocation_pct > 0
      ? fields.allocation_pct > 1
        ? fields.allocation_pct / 100
        : fields.allocation_pct
      : 0.1;
  const sub: Subscription = {
    id,
    offtaker_name: fields.customer_name,
    customer_name: fields.customer_name,
    email: fields.client_email || "",
    client_email: fields.client_email || "",
    share_pct: Math.round(alloc * 1000) / 10,
    allocation_pct: alloc,
    delivery_mode: fields.delivery_mode || "approval",
    enabled: fields.enabled !== false,
    utility_account_name:
      fields.utility_account_id != null ? "GMP master" : undefined,
    array_id: fields.array_id ?? null,
  };
  demoSubs.subscriptions = [...(demoSubs.subscriptions || []), sub];
  return { ok: true, subscription: sub };
}

export function demoPatchSubscription(
  subId: number | string,
  body: Record<string, unknown>
): { ok: boolean; subscription: Subscription | null } {
  const list = [...(demoSubs.subscriptions || [])];
  const idx = list.findIndex((s) => String(s.id) === String(subId));
  if (idx < 0) return { ok: false, subscription: null };
  const cur: Subscription = { ...list[idx] };
  if (body.customer_name != null) {
    cur.customer_name = String(body.customer_name);
    cur.offtaker_name = String(body.customer_name);
  }
  if (body.client_email !== undefined) {
    cur.client_email = body.client_email == null ? "" : String(body.client_email);
    cur.email = cur.client_email;
  }
  if (body.delivery_mode != null) cur.delivery_mode = String(body.delivery_mode);
  if (body.enabled !== undefined) cur.enabled = Boolean(body.enabled);
  if (body.allocation_pct != null) {
    let n = Number(body.allocation_pct);
    if (n > 1) n = n / 100;
    cur.allocation_pct = n;
    cur.share_pct = Math.round(n * 1000) / 10;
  }
  if (body.array_id != null) cur.array_id = Number(body.array_id);
  list[idx] = cur;
  demoSubs.subscriptions = list;
  return { ok: true, subscription: cur };
}
