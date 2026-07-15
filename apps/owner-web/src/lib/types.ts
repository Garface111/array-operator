/** Backend shapes — keep loose where the API is evolving; tighten as we port. */

export type PasswordLoginResult = {
  session_token?: string;
  tenant_id?: string;
  product?: string;
  email?: string;
  detail?: string;
};

export type AuthVerifyResult = {
  ok?: boolean;
  session_token?: string;
  expires_in?: number;
};

export type OverviewArray = {
  id?: number | string;
  name?: string;
  status?: string;
  peer_index?: number | null;
  peer?: {
    peer_index?: number | null;
    status?: string | null;
    diagnosis?: string | null;
    [key: string]: unknown;
  };
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  diagnosis?: string | null;
  value_today?: number | null;
  [key: string]: unknown;
};

export type Overview = {
  arrays?: OverviewArray[];
  totals?: {
    array_count?: number;
    today_kwh?: number;
    value_today?: number;
    current_power_w?: number;
    month_kwh?: number;
    [key: string]: unknown;
  };
  peer_summary?: {
    ok?: number;
    underperforming?: number;
    dead?: number;
    arrays_attention?: number;
    [key: string]: unknown;
  };
  source?: string;
  [key: string]: unknown;
};

export type FleetInverter = {
  id?: number | string;
  inverter_id?: number | string;
  name?: string;
  status?: string;
  peer_index?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  today_kwh?: number | null;
  vendor?: string | null;
  model?: string | null;
  diagnosis?: string | null;
  [key: string]: unknown;
};

export type FleetArray = {
  id?: number | string;
  name?: string;
  status?: string;
  last_sync_at?: string | null;
  synced_at?: string | null;
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  peer_index?: number | null;
  diagnosis?: string | null;
  vendor?: string | null;
  vendors?: string[] | null;
  daily_split?: { has_vendor?: boolean; has_utility?: boolean } | null;
  inverters?: FleetInverter[];
  [key: string]: unknown;
};

export type FleetTree = {
  /** Normalized mobile shape (from columns or demo). */
  arrays?: FleetArray[];
  /** Raw sandbox shape from GET /v1/array-owners/fleet-tree. */
  columns?: Array<Record<string, unknown>>;
  summary?: {
    arrays_total?: number;
    inverters_total?: number;
    attention?: number;
    [key: string]: unknown;
  };
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
  tenant_key?: string;
  name?: string;
  company_name?: string;
  operator_name?: string;
  email?: string;
  product?: string;
  capture_mode?: string | null;
  active?: boolean;
  is_demo?: boolean;
  billing_plan?: string | null;
  subscription_status?: string | null;
  has_payment_method?: boolean;
  has_password?: boolean;
  trial_ends_at?: string | null;
  ai_pro?: boolean;
  plan_features?: {
    plan?: string;
    plan_chosen?: boolean;
    vendor_data?: boolean;
    invoicing?: boolean;
  };
  accounts_count?: number;
  bills_count?: number;
  clients_count?: number;
  connected_providers?: string[];
  extension_heartbeat_at?: string | null;
  last_pull_at?: string | null;
  [key: string]: unknown;
};

export type BillingSummary = {
  billing_basis?: "kwh" | "array" | string;
  billable_arrays?: number;
  mtd_kwh?: number;
  estimated_cents?: number;
  total_cents?: number;
  price_cents?: number;
  currency?: string;
  has_payment_method?: boolean;
  card_brand?: string | null;
  card_last4?: string | null;
  card_exp?: string | null;
  [key: string]: unknown;
};

export type CloudCredential = {
  provider?: string;
  username?: string;
  enabled?: boolean;
  login_host?: string | null;
  last_harvest_at?: string | null;
  last_harvest_ok?: boolean | null;
  last_harvest_status?: string | null;
  harvest_fails?: number;
  has_session?: boolean;
  [key: string]: unknown;
};

export type CloudStatus = {
  encryption_ready?: boolean;
  collection_enabled?: boolean;
  harvesting_enabled?: boolean;
  credentials?: CloudCredential[];
  [key: string]: unknown;
};

export type OnboardingStatus = {
  ok?: boolean;
  connected?: boolean;
  complete?: boolean;
  next_step?: string;
  has_inverter?: boolean;
  has_utility_accounts?: boolean;
  gmp_connected?: boolean;
  arrays_total?: number;
  linked_arrays?: number;
  unlinked_accounts?: number;
  [key: string]: unknown;
};

export type LinkedSources = {
  sources?: Array<{
    code?: string;
    kind?: string;
    vendor?: string;
    label?: string;
    count?: number;
    detail?: string;
    site_count?: number;
    last_synced_at?: string | null;
    [key: string]: unknown;
  }>;
  count?: number;
  [key: string]: unknown;
};

export type PaymentsConnectStatus = {
  ok?: boolean;
  enabled?: boolean;
  connected?: boolean;
  charges_enabled?: boolean;
  ready?: boolean;
  fee_percent?: number;
  url?: string;
  [key: string]: unknown;
};

export type Subscription = {
  id?: number | string;
  name?: string;
  customer_name?: string;
  offtaker_name?: string;
  email?: string;
  client_email?: string;
  to_email?: string;
  share_pct?: number | null;
  allocation_pct?: number | null;
  array_share_pct?: number | null;
  delivery_mode?: string | null;
  send_mode?: string | null;
  cadence?: string | null;
  enabled?: boolean;
  array_id?: number | null;
  utility_account_id?: number | null;
  utility_account_name?: string | null;
  rate_per_kwh?: number | null;
  last_sent_at?: string | null;
  next_send_at?: string | null;
  [key: string]: unknown;
};

export type SubscriptionsList = {
  ok?: boolean;
  subscriptions?: Subscription[];
  crosscheck_threshold_default_pct?: number;
  [key: string]: unknown;
};

export type OfftakerArrayOption = {
  id?: number;
  array_id?: number;
  name?: string;
  client_name?: string | null;
};

export type UtilityAccountOption = {
  account_id?: number;
  provider?: string;
  account_number?: string | null;
  nickname?: string | null;
  linked_array_id?: number | null;
  linked_array_name?: string | null;
  bill_count?: number;
};

export type ListBundle = {
  ok?: boolean;
  subscriptions?: Subscription[];
  arrays?: OfftakerArrayOption[];
  utility_accounts?: UtilityAccountOption[];
  crosscheck_threshold_default_pct?: number;
};

export type AgentPending = {
  id?: string;
  type?: string;
  args?: Record<string, unknown>;
  needs_confirm?: boolean;
  message?: string;
  [key: string]: unknown;
};

export type FleetForecast = {
  available?: boolean;
  window_days?: number;
  expected_kwh?: number | null;
  actual_kwh?: number | null;
  expected_matched_kwh?: number | null;
  ratio?: number | null;
  kwh_per_kw_day?: number | null;
  arrays?: Array<{
    array_id?: number;
    array_name?: string;
    available?: boolean;
    expected_kwh?: number | null;
    actual_kwh?: number | null;
    ratio?: number | null;
    kwh_per_kw_day?: number | null;
    reason?: string;
    [key: string]: unknown;
  }>;
  skipped?: Array<{
    array_id?: number;
    array_name?: string;
    reason?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type FleetTrends = {
  years?: number[];
  ttm_kwh?: number | null;
  ttm_savings_usd?: number | null;
  lifetime_kwh?: number | null;
  by_array?: Array<{
    array_id?: number;
    name?: string;
    lifetime_kwh?: number | null;
    [key: string]: unknown;
  }>;
  seasonal_yoy?: Array<{
    month?: number;
    label?: string;
    latest_delta_pct?: number | null;
    [key: string]: unknown;
  }>;
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
  pending?: AgentPending | null;
  ui_commands?: Array<Record<string, unknown>>;
  tool_trace?: unknown[];
  [key: string]: unknown;
};

export type EnergyAgentConfirmResponse = {
  ok?: boolean;
  command?: Record<string, unknown> | null;
  extra_commands?: Array<Record<string, unknown>>;
  cancelled?: boolean;
  note?: string;
  [key: string]: unknown;
};

export type SolarEdgeConnectResult = {
  connected?: number;
  created?: number;
  matched?: number;
  arrays?: unknown[];
  detail?: string;
  message?: string;
  [key: string]: unknown;
};
