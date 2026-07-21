export type DailyPt = { date?: string; kwh?: number | null };

export type FleetInverter = {
  id: number | string;
  name: string;
  status: string;
  peer_index?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  diagnosis?: string | null;
  daily?: DailyPt[];
};

export type FleetArray = {
  id: number | string;
  name: string;
  status: string;
  vendor?: string | null;
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  daily?: DailyPt[];
  inverters?: FleetInverter[];
};

export type FleetTree = {
  arrays: FleetArray[];
  summary?: { arrays_total?: number; inverters_total?: number; attention?: number };
};

export type Overview = {
  arrays?: Array<Record<string, unknown>>;
  totals?: {
    array_count?: number;
    today_kwh?: number;
    today_usd?: number;
    current_power_w?: number;
    [key: string]: unknown;
  };
  peer_summary?: {
    arrays_attention?: number;
    arrays_total?: number;
    [key: string]: unknown;
  };
};

export type SendPipeline = {
  total_enabled?: number;
  default_delivery_mode?: string;
  last?: {
    delivered?: number;
    sent?: number;
    period_month?: string;
    period_label?: string;
    dollars?: number;
  };
  inflight?: {
    pending_drafts?: number;
    pending_approval?: number;
    waiting?: number;
  };
};

export type OfftakerSub = {
  id?: number | string;
  name?: string;
  customer_name?: string | null;
  email?: string;
  client_email?: string | null;
  enabled?: boolean;
  share_pct?: number | null;
  array_share_pct?: number | null;
  allocation_pct?: number | null;
  array_name?: string | null;
  array_id?: number | string | null;
  delivery_mode?: string | null;
  status?: string | null;
};

export type AccountInfo = {
  tenant_id?: string;
  email?: string;
  name?: string;
  company_name?: string;
  product?: string;
  is_demo?: boolean;
  subscription_status?: string | null;
};

export type PasswordLoginResult = {
  session_token?: string;
  detail?: string;
};
