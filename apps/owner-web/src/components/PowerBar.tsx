import { fmtKw, powerFrac } from "@/lib/format";

type Props = {
  powerW?: number | null;
  nameplateKw?: number | null;
  className?: string;
};

/** Horizontal live-output bar (graphical % of max). */
export function PowerBar({ powerW, nameplateKw, className = "" }: Props) {
  const frac = powerFrac(powerW, nameplateKw);
  const pct = frac == null ? 0 : Math.min(100, Math.round(frac * 100));
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-extrabold text-ink">{fmtKw(powerW)}</span>
        <span className="text-[10px] font-bold text-muted">
          {frac == null ? "of max n/a" : `${pct}% of max`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[rgba(20,60,120,0.1)]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${frac == null ? 0 : Math.min(100, frac * 100)}%`,
            background:
              frac == null
                ? "transparent"
                : "linear-gradient(90deg, #64B5F6, #2196F3 70%, #1976D2)",
          }}
        />
      </div>
    </div>
  );
}
