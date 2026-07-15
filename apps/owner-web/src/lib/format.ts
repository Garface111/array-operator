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
  return `${Math.round(v).toLocaleString()} kWh`;
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
  if (/under|attn|warn|need|stale|gap/.test(s)) return "warn";
  if (/ok|good|healthy|producing|mppt/.test(s)) return "good";
  return "muted";
}
