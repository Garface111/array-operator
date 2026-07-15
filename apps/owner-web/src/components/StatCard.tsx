type Props = {
  label: string;
  value: string;
  meta?: string;
  tone?: "default" | "good" | "warn" | "bad";
  onClick?: () => void;
};

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  default: "",
  good: "!border-emerald-200/70 !bg-emerald-50/45",
  warn: "!border-amber-200/70 !bg-amber-50/45",
  bad: "!border-red-200/70 !bg-red-50/45",
};

export function StatCard({ label, value, meta, tone = "default", onClick }: Props) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`ao-card w-full p-3.5 text-left ${TONE[tone]} ${
        onClick ? "active:scale-[0.99]" : ""
      }`}
    >
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-700">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-extrabold tracking-tight text-ink">
        {value}
      </div>
      {meta ? <div className="mt-1 text-xs font-medium text-muted">{meta}</div> : null}
    </Comp>
  );
}
