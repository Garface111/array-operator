import { powerFrac } from "@/lib/format";

type Props = {
  powerW?: number | null;
  nameplateKw?: number | null;
  /** compact = 44px; default 56 */
  size?: "sm" | "md";
  label?: string;
};

/**
 * Circular output gauge — % of nameplate right now.
 * Color follows health-ish intensity (blue sky brand, not false-alarm red).
 */
export function OutputGauge({ powerW, nameplateKw, size = "md", label }: Props) {
  const frac = powerFrac(powerW, nameplateKw);
  const pct = frac == null ? null : Math.round(frac * 100);
  const dim = size === "sm" ? 44 : 56;
  const stroke = size === "sm" ? 5 : 6;
  const r = (dim - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = frac == null ? 0 : Math.min(1, frac) * c;
  const tone =
    frac == null ? "#94a3b8" : frac >= 0.45 ? "#2196F3" : frac >= 0.15 ? "#38bdf8" : "#94a3b8";

  return (
    <div className="flex flex-col items-center gap-0.5" title={label || "Output now"}>
      <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} aria-hidden>
        <circle
          cx={dim / 2}
          cy={dim / 2}
          r={r}
          fill="none"
          stroke="rgba(20,60,120,0.1)"
          strokeWidth={stroke}
        />
        <circle
          cx={dim / 2}
          cy={dim / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          transform={`rotate(-90 ${dim / 2} ${dim / 2})`}
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={size === "sm" ? 10 : 12}
          fontWeight={800}
          fill="#0E1420"
        >
          {pct == null ? "—" : `${pct}%`}
        </text>
      </svg>
      {label ? (
        <span className="text-[9px] font-bold uppercase tracking-wide text-muted">
          {label}
        </span>
      ) : null}
    </div>
  );
}
