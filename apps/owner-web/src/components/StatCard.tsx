type Props = {
  label: string;
  value: string;
  meta?: string;
  tone?: "default" | "good" | "warn" | "bad";
  onClick?: () => void;
};

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  default: "",
  good: "ring-1 ring-emerald-300/50",
  warn: "ring-1 ring-amber-300/60",
  bad: "ring-1 ring-red-300/60",
};

export function StatCard({ label, value, meta, tone = "default", onClick }: Props) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`ao-card w-full p-3 text-left ${TONE[tone]} ${
        onClick ? "active:scale-[0.99]" : ""
      }`}
    >
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-700">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-extrabold tracking-tight text-ink">
        {value}
      </div>
      {meta ? <div className="mt-1 text-[11px] font-semibold text-muted">{meta}</div> : null}
    </Comp>
  );
}
