/**
 * Bifurcated data domains (same rule as desktop vendor-sheet.js / FleetStore):
 *
 *  VENDOR  — inverter telemetry (SolarEdge, Fronius, SMA, Chint, …)
 *            → Fleet health, Vendor Data sheet, inverter viewers ONLY
 *
 *  UTILITY — meter/bills (GMP, SmartHub co-ops, …)
 *            → Offtaker invoice generator / bill sources ONLY
 *
 * Never mix: utility-meter-only arrays must not appear as "inverters",
 * and vendor production must not drive invoice bill lines.
 */

export type DomainArray = {
  id?: number | string;
  name?: string;
  vendor?: string | null;
  vendors?: string[] | null;
  inverters?: unknown[] | null;
  /** Present on some fleet-tree / overview rows */
  daily_split?: { has_vendor?: boolean; has_utility?: boolean } | null;
  source?: string | null;
  /** Utility-only arrays often lack inverter connections */
  solaredge_site_id?: string | number | null;
  [key: string]: unknown;
};

const UTILITY_PROVIDERS = new Set([
  "gmp",
  "vec",
  "wec",
  "smarthub",
  "eversource",
  "eversource_ma",
  "eversource_ct",
  "cmp",
  "utility",
  "utility_meter",
]);

const VENDOR_PROVIDERS = new Set([
  "solaredge",
  "fronius",
  "sma",
  "chint",
  "locus",
  "enphase",
  "alsoenergy",
  "solis",
  "tigo",
]);

function norm(s: unknown): string {
  return String(s || "")
    .trim()
    .toLowerCase();
}

/** True when this array has (or is) a monitoring vendor / inverter source. */
export function isVendorMonitoredArray(a: DomainArray | null | undefined): boolean {
  if (!a) return false;

  const ds = a.daily_split;
  if (ds && ds.has_vendor) return true;

  const v = norm(a.vendor);
  if (v && VENDOR_PROVIDERS.has(v)) return true;
  // Any non-utility vendor string counts as monitored
  if (v && !UTILITY_PROVIDERS.has(v) && v !== "other" && v !== "unknown")
    return true;

  if (Array.isArray(a.vendors) && a.vendors.some((x) => {
    const n = norm(x);
    return n && !UTILITY_PROVIDERS.has(n);
  })) {
    return true;
  }

  if (Array.isArray(a.inverters) && a.inverters.length > 0) return true;

  // Legacy SolarEdge column without a vendor string
  if (a.solaredge_site_id != null && a.solaredge_site_id !== "") return true;

  return false;
}

/**
 * Utility-meter-only array: bills/meters, no inverter vendor feed.
 * Belongs on invoice / offtaker side, not Vendor Data.
 */
export function isUtilityOnlyArray(a: DomainArray | null | undefined): boolean {
  if (!a) return false;
  if (isVendorMonitoredArray(a)) return false;
  const ds = a.daily_split;
  if (ds && ds.has_utility && !ds.has_vendor) return true;
  const v = norm(a.vendor);
  if (v && UTILITY_PROVIDERS.has(v)) return true;
  const src = norm(a.source);
  if (/utility|gmp|smarthub|bill_prorate|meter/.test(src)) return true;
  // No vendor, no inverters → treat as non-vendor (utility or empty)
  return true;
}

/** Arrays for Fleet KPIs + Vendor Data sheet (desktop `_monitoredCols`). */
export function filterVendorMonitored<T extends DomainArray>(
  arrays: T[] | null | undefined
): T[] {
  return (arrays || []).filter(isVendorMonitoredArray);
}

/** Count of all arrays on file (including utility-only) for "N of M" labels. */
export function countOnFile(arrays: DomainArray[] | null | undefined): number {
  return (arrays || []).length;
}

/** Utility account-ish rows for invoice bill-source pickers only. */
export function isUtilityProvider(code: string | null | undefined): boolean {
  const n = norm(code);
  if (!n) return false;
  if (UTILITY_PROVIDERS.has(n)) return true;
  // SmartHub co-ops often use sh_* or bare subdomain labels
  if (n.startsWith("sh_")) return true;
  return false;
}
