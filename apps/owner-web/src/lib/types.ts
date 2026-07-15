/** Backend shapes — keep loose where the API is evolving; tighten as we port. */

export type PasswordLoginResult = {
  session_token?: string;
  tenant_id?: string;
  product?: string;
  email?: string;
  detail?: string;
};

export type OverviewArray = {
  id?: number | string;
  name?: string;
  status?: string;
  peer_index?: number | null;
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  diagnosis?: string | null;
  [key: string]: unknown;
};

export type Overview = {
  arrays?: OverviewArray[];
  totals?: {
    array_count?: number;
    today_kwh?: number;
    value_today?: number;
    [key: string]: unknown;
  };
  peer_summary?: {
    ok?: number;
    underperforming?: number;
    dead?: number;
    [key: string]: unknown;
  };
  source?: string;
  [key: string]: unknown;
};

export type FleetTree = {
  arrays?: Array<{
    id?: number | string;
    name?: string;
    status?: string;
    last_sync_at?: string | null;
    synced_at?: string | null;
    inverters?: Array<{
      id?: number | string;
      name?: string;
      status?: string;
      peer_index?: number | null;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type SendPipeline = {
  total_enabled?: number;
  default_delivery_mode?: string;
  last?: {
    delivered?: number;
    sent?: number;
    period_month?: string;
    period_label?: string;
    [key: string]: unknown;
  };
  previous?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AccountMe = {
  tenant_id?: string;
  name?: string;
  company_name?: string;
  email?: string;
  product?: string;
  capture_mode?: string | null;
  active?: boolean;
  is_demo?: boolean;
  plan_features?: {
    plan?: string;
    plan_chosen?: boolean;
    vendor_data?: boolean;
    invoicing?: boolean;
  };
  [key: string]: unknown;
};

export type CloudCredential = {
  provider?: string;
  username?: string;
  enabled?: boolean;
  last_harvest_at?: string | null;
  last_harvest_ok?: boolean | null;
  last_harvest_status?: string | null;
  harvest_fails?: number;
  [key: string]: unknown;
};

export type CloudStatus = {
  encryption_ready?: boolean;
  collection_enabled?: boolean;
  harvesting_enabled?: boolean;
  credentials?: CloudCredential[];
  [key: string]: unknown;
};

export type Subscription = {
  id?: number | string;
  name?: string;
  offtaker_name?: string;
  email?: string;
  to_email?: string;
  share_pct?: number | null;
  delivery_mode?: string | null;
  enabled?: boolean;
  utility_account_name?: string | null;
  [key: string]: unknown;
};

export type SubscriptionsList = {
  ok?: boolean;
  subscriptions?: Subscription[];
  [key: string]: unknown;
};

export type EnergyAgentSession = {
  session_id?: string;
  intro?: string;
  messages?: Array<{ role?: string; content?: string }>;
  welcome_back?: boolean;
  realtime_ready?: boolean;
  brain?: string;
  [key: string]: unknown;
};

export type EnergyAgentChatResponse = {
  reply?: string;
  message?: string;
  content?: string;
  session_id?: string;
  pending?: unknown[];
  [key: string]: unknown;
};
