export function relTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return String(iso).slice(0, 16);
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  } catch {
    return "—";
  }
}

export function fmtKwh(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)} MWh`;
  if (Math.abs(v) < 10) return `${v.toFixed(1)} kWh`;
  return `${Math.round(v).toLocaleString()} kWh`;
}

export function fmtKw(w?: number | null): string {
  if (w == null || Number.isNaN(Number(w))) return "—";
  const kw = Number(w) / 1000;
  if (kw >= 100) return `${Math.round(kw)} kW`;
  if (kw >= 10) return `${kw.toFixed(1)} kW`;
  return `${kw.toFixed(2)} kW`;
}

export function fmtMoney(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function statusTone(
  status?: string | null
): "good" | "warn" | "bad" | "muted" {
  const s = String(status || "").toLowerCase();
  if (/dead|fault|offline|error/.test(s)) return "bad";
  if (/under|attn|warn|need|stale|gap|low/.test(s)) return "warn";
  if (/ok|good|healthy|producing|mppt|clear|all clear/.test(s)) return "good";
  return "muted";
}

export function chipClass(tone: ReturnType<typeof statusTone>): string {
  if (tone === "good") return "ao-chip ao-chip-good";
  if (tone === "warn") return "ao-chip ao-chip-warn";
  if (tone === "bad") return "ao-chip ao-chip-bad";
  return "ao-chip ao-chip-muted";
}

/** Live power as fraction of nameplate (0–1). */
export function powerFrac(
  powerW?: number | null,
  nameplateKw?: number | null
): number | null {
  if (powerW == null || nameplateKw == null || !(nameplateKw > 0)) return null;
  return Math.max(0, Math.min(1.25, powerW / (nameplateKw * 1000)));
}

export function brandLabel(v?: string | null): string {
  if (!v) return "—";
  const map: Record<string, string> = {
    solaredge: "SolarEdge",
    fronius: "Fronius",
    sma: "SMA",
    chint: "Chint",
    locus: "Locus",
    enphase: "Enphase",
  };
  const k = v.toLowerCase();
  return map[k] || v.charAt(0).toUpperCase() + v.slice(1);
}
