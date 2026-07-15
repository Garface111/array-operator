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
