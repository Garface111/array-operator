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
  SubscriptionsList,
} from "./types";

/** True on the dedicated preview host so testers land in the app without a login. */
export function isPreviewHost(): boolean {
  try {
    const h = location.hostname || "";
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
  name: "Green Mountain Community Solar",
  company_name: "Green Mountain Community Solar",
  email: "demo@arrayoperator.com",
  product: "array_operator",
  capture_mode: "cloud",
  active: true,
  is_demo: true,
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
  },
  peer_summary: { ok: 9, underperforming: 1, dead: 0 },
  arrays: [
    {
      id: 1,
      name: "Londonderry",
      status: "ok",
      today_kwh: 980,
      nameplate_kw: 99,
      peer_index: 1.02,
    },
    {
      id: 2,
      name: "Cover Rooftop",
      status: "underperforming",
      today_kwh: 412,
      nameplate_kw: 10,
      peer_index: 0.78,
      diagnosis: "Below peer cohort for 3 days",
    },
    {
      id: 3,
      name: "West Glover Barn",
      status: "ok",
      today_kwh: 450,
      nameplate_kw: 28,
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
        { id: 11, name: "SE33.3K A", status: "ok", peer_index: 1.01 },
        { id: 12, name: "SE33.3K B", status: "ok", peer_index: 1.0 },
        { id: 13, name: "SE20K C", status: "ok", peer_index: 1.04 },
        { id: 14, name: "SE10K D", status: "ok", peer_index: 0.98 },
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

export const demoSubs: SubscriptionsList = {
  ok: true,
  subscriptions: [
    {
      id: 1,
      offtaker_name: "Town Library",
      email: "lib@example.org",
      share_pct: 12.5,
      delivery_mode: "approval",
      enabled: true,
      utility_account_name: "GMP master",
    },
    {
      id: 2,
      offtaker_name: "Fire Station",
      email: "fire@example.org",
      share_pct: 8,
      delivery_mode: "auto",
      enabled: true,
      utility_account_name: "GMP master",
    },
    {
      id: 3,
      offtaker_name: "School District",
      email: "biz@schools.example",
      share_pct: 22,
      delivery_mode: "approval",
      enabled: true,
      utility_account_name: "GMP master",
    },
  ],
};
