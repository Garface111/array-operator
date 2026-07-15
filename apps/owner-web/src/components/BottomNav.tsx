import { NavLink } from "react-router-dom";

/**
 * Same primary tabs as desktop (index.html tabbar), mobile-sized bottom dock.
 * Desktop: Fleet Triage · Inverters · Analysis · Invoices · Resources · Account
 */
const ITEMS: Array<{
  to: string;
  label: string;
  short: string;
  icon: string;
  end?: boolean;
}> = [
  { to: "/triage", label: "Fleet Triage", short: "Triage", icon: "◎" },
  { to: "/inverters", label: "Inverters", short: "Inverters", icon: "▣", end: true },
  { to: "/analysis", label: "Analysis", short: "Analysis", icon: "◫" },
  { to: "/invoices", label: "Invoices", short: "Invoices", icon: "▤" },
  { to: "/resources", label: "Resources", short: "Resources", icon: "☰" },
  { to: "/account", label: "Account", short: "Account", icon: "◉" },
];

export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/45 bg-white/45 px-1 pt-1 shadow-[0_-8px_32px_-16px_rgba(15,50,110,0.35)] backdrop-blur-xl backdrop-saturate-150"
      style={{
        paddingBottom: "max(6px, env(safe-area-inset-bottom))",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
      }}
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-0">
        {ITEMS.map((item) => (
          <li key={item.to} className="min-w-0 flex-1">
            <NavLink
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                [
                  "flex flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1.5 text-[9px] font-bold leading-tight tracking-tight",
                  isActive
                    ? "bg-white/60 text-sky-900 shadow-sm ring-1 ring-white/70"
                    : "text-slate-700/80",
                ].join(" ")
              }
            >
              <span className="text-[15px] leading-none" aria-hidden>
                {item.icon}
              </span>
              <span className="max-w-full truncate px-0.5">{item.short}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
