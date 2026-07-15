import type { ReactNode } from "react";
import { toneClasses } from "@/lib/format";

type Tone = "good" | "warn" | "bad" | "muted";

export function StatusPill({
  status,
  tone,
  children,
}: {
  status?: string | null;
  tone?: Tone;
  children?: ReactNode;
}) {
  const t = tone || "muted";
  const c = toneClasses(t);
  return (
    <span className={`ao-chip shrink-0 capitalize ${c.chip}`}>
      {children ?? status ?? "—"}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  meta,
  tone = "muted",
  onClick,
  wide,
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: Tone;
  onClick?: () => void;
  wide?: boolean;
}) {
  const t = toneClasses(tone);
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`ao-card p-3 text-left ${wide ? "col-span-2" : ""} ${
        onClick ? "active:scale-[0.99]" : ""
      } ${
        tone === "warn"
          ? "ring-1 ring-amber-200/80"
          : tone === "bad"
            ? "ring-1 ring-red-200/80"
            : ""
      }`}
    >
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
        {label}
      </div>
      <div className={`mt-0.5 text-[17px] font-extrabold tracking-tight ${t.text}`}>
        {value}
      </div>
      {meta ? (
        <div className="mt-0.5 text-[11px] font-medium leading-snug text-muted">
          {meta}
        </div>
      ) : null}
    </Comp>
  );
}

/** Thin fill bar 0–100+ */
export function MeterBar({
  pct,
  tone = "good",
  className = "",
}: {
  pct: number | null | undefined;
  tone?: Tone;
  className?: string;
}) {
  if (pct == null || !Number.isFinite(pct)) {
    return (
      <div
        className={`h-1.5 w-full overflow-hidden rounded-full bg-white/40 ${className}`}
      />
    );
  }
  const c = toneClasses(tone);
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-white/45 ${className}`}
      role="meter"
      aria-valuenow={Math.round(w)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all ${c.bar}`}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

export function SectionHead({
  title,
  action,
  sub,
}: {
  title: string;
  action?: ReactNode;
  sub?: string;
}) {
  return (
    <div className="flex items-end justify-between gap-2">
      <div>
        <h2 className="text-sm font-extrabold text-slate-900">{title}</h2>
        {sub ? (
          <p className="text-[11px] font-medium text-muted">{sub}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyCard({ children }: { children: ReactNode }) {
  return (
    <div className="ao-card px-3.5 py-4 text-sm leading-relaxed text-muted">
      {children}
    </div>
  );
}

export function DemoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
      {children}
    </div>
  );
}
