import { NavLink } from "react-router-dom";

/** Desktop tab order: Fleet · Analysis · Statements · Repairs · Marketplace · Account */
const ITEMS: Array<{ to: string; label: string; end?: boolean }> = [
  { to: "/fleet", label: "Fleet", end: true },
  { to: "/analysis", label: "Analysis" },
  { to: "/invoices", label: "Statements" },
  { to: "/repairs", label: "Repairs" },
  { to: "/marketplace", label: "Market" },
  { to: "/account", label: "Account" },
];

export function BottomNav() {
  return (
    <nav
      className="ao-chrome fixed inset-x-0 bottom-0 z-40 border-t px-1 pt-1"
      style={{ paddingBottom: "max(6px, env(safe-area-inset-bottom))" }}
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-0.5 overflow-x-auto">
        {ITEMS.map((item) => (
          <li key={item.to} className="min-w-0 flex-1">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  "flex min-h-[48px] flex-col items-center justify-center rounded-2xl px-0.5 py-1.5 text-[10px] font-extrabold tracking-tight",
                  isActive
                    ? "bg-white/90 text-sky-700 shadow-sm"
                    : "text-muted",
                ].join(" ")
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
