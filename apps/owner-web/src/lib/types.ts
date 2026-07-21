/** Backend shapes — keep loose where the API is evolving; tighten as we port. */

export type PasswordLoginResult = {
  session_token?: string;
  tenant_id?: string;
  product?: string;
  email?: string;
  detail?: string;
};

/** Canonical array row used by Home / Fleet after adapting overview + fleet-tree. */
export type FleetArray = {
  id: number | string;
  name: string;
  status: string;
  vendor?: string | null;
  peer_index?: number | null;
  today_kwh?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  diagnosis?: string | null;
  inverters?: FleetInverter[];
  [key: string]: unknown;
};

export type FleetInverter = {
  id: number | string;
  name: string;
  status: string;
  peer_index?: number | null;
  current_power_w?: number | null;
  nameplate_kw?: number | null;
  diagnosis?: string | null;
  [key: string]: unknown;
};

/** Raw /v1/array-owners/overview payload (field names as the API sends them). */
export type Overview = {
  arrays?: Array<{
    array_id?: number | string;
    id?: number | string;
    name?: string;
    health?: { status?: string; message?: string; [key: string]: unknown };
    peer?: {
      peer_index?: number | null;
      status?: string;
      diagnosis?: string | null;
      underperforming?: number;
      dead?: number;
      [key: string]: unknown;
    };
    today?: { kwh?: number | null } | null;
    live?: { current_power_w?: number | null } | null;
    value?: { today_usd?: number | null; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  totals?: {
    array_count?: number;
    today_kwh?: number;
    today_usd?: number;
    value_today?: number;
    current_power_w?: number;
    [key: string]: unknown;
  };
  peer_summary?: {
    ok?: number;
    underperforming?: number;
    dead?: number;
    arrays_attention?: number;
    arrays_total?: number;
    [key: string]: unknown;
  };
  source?: string;
  [key: string]: unknown;
};

/**
 * Raw /v1/array-owners/fleet-tree payload.
 * Live API returns `columns[]` (sandbox shape), not `arrays[]`.
 * Always run through adaptFleetTree() before UI use.
 */
export type FleetTreeRaw = {
  columns?: Array<{
    array_id?: number | string;
    array_name?: string;
    vendor?: string | null;
    current_power_w?: number | null;
    produced_today_kwh?: number | null;
    alert?: { status?: string; level?: string; headline?: string; [key: string]: unknown };
    inverters?: Array<{
      inverter_id?: number | string;
      name?: string;
      status?: string;
      peer_index?: number | null;
      current_power_w?: number | null;
      nameplate_kw?: number | null;
      diagnosis?: string | null;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  /** Legacy / mistaken client shape — prefer columns. */
  arrays?: FleetArray[];
  summary?: {
    arrays_total?: number;
    inverters_total?: number;
    attention?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type FleetTree = {
  arrays: FleetArray[];
  summary?: FleetTreeRaw["summary"];
  raw?: FleetTreeRaw;
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
