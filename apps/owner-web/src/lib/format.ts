export function relTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return String(iso).slice(0, 16);
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 45) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d ago`;
    return new Date(t).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export function fmtKwh(n?: number | null, digits = 0): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)} MWh`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} MWh`;
  if (digits > 0) return `${v.toFixed(digits)} kWh`;
  return `${Math.round(v).toLocaleString()} kWh`;
}

export function fmtMoney(n?: number | null, cents = false): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = cents ? Number(n) / 100 : Number(n);
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: v < 10 && v % 1 !== 0 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Watts → human power string */
export function fmtPower(w?: number | null): string {
  if (w == null || Number.isNaN(Number(w))) return "—";
  const n = Number(w);
  if (Math.abs(n) >= 1000) {
    const kw = n / 1000;
    return `${kw >= 10 ? Math.round(kw) : kw.toFixed(1)} kW`;
  }
  return `${Math.round(n)} W`;
}

export function fmtPeer(p?: number | null): string {
  if (p == null || Number.isNaN(Number(p))) return "—";
  return Number(p).toFixed(2);
}

export function fmtPct(p?: number | null, digits = 0): string {
  if (p == null || Number.isNaN(Number(p))) return "—";
  return `${(Number(p) * (Number(p) <= 1.5 ? 100 : 1)).toFixed(digits)}%`;
}

/** % of nameplate from current power W and nameplate kW */
export function livePctOfNameplate(
  powerW?: number | null,
  nameplateKw?: number | null
): number | null {
  if (powerW == null || nameplateKw == null || !nameplateKw) return null;
  const pct = (Number(powerW) / (Number(nameplateKw) * 1000)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(120, pct));
}

export function statusTone(
  status?: string | null
): "good" | "warn" | "bad" | "muted" {
  const s = String(status || "").toLowerCase();
  if (/dead|fault|offline|error|critical|stopped|shutdown/.test(s))
    return "bad";
  if (/under|attn|warn|need|stale|gap|watch|quiet|comm/.test(s)) return "warn";
  if (/ok|good|healthy|producing|mppt|normal/.test(s)) return "good";
  return "muted";
}

export function statusLabel(status?: string | null): string {
  const s = String(status || "").trim();
  if (!s) return "Unknown";
  return s.replace(/_/g, " ");
}

export function toneClasses(
  tone: "good" | "warn" | "bad" | "muted"
): { chip: string; bar: string; text: string } {
  switch (tone) {
    case "good":
      return {
        chip: "bg-emerald-100/90 text-emerald-900",
        bar: "bg-emerald-500",
        text: "text-emerald-800",
      };
    case "warn":
      return {
        chip: "bg-amber-100/90 text-amber-950",
        bar: "bg-amber-500",
        text: "text-amber-900",
      };
    case "bad":
      return {
        chip: "bg-red-100/90 text-red-900",
        bar: "bg-red-500",
        text: "text-red-800",
      };
    default:
      return {
        chip: "bg-white/50 text-slate-700",
        bar: "bg-slate-300",
        text: "text-slate-700",
      };
  }
}
