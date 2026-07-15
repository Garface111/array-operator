import { NavLink } from "react-router-dom";

/**
 * Mobile primary tabs (4) — desktop still has Inverters + Analysis;
 * those surfaces fold into Triage on phone.
 */
const ITEMS: Array<{
  to: string;
  label: string;
  short: string;
  icon: string;
  end?: boolean;
}> = [
  { to: "/triage", label: "Fleet Triage", short: "Triage", icon: "◎", end: true },
  { to: "/invoices", label: "Invoices", short: "Invoices", icon: "▤" },
  { to: "/resources", label: "Resources", short: "Resources", icon: "☰" },
  { to: "/account", label: "Account", short: "Account", icon: "◉" },
];

export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/45 bg-white/45 px-1.5 pt-1 shadow-[0_-8px_32px_-16px_rgba(15,50,110,0.35)] backdrop-blur-xl backdrop-saturate-150"
      style={{
        paddingBottom: "max(6px, env(safe-area-inset-bottom))",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
      }}
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-0.5">
        {ITEMS.map((item) => (
          <li key={item.to} className="min-w-0 flex-1">
            <NavLink
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                [
                  "flex flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-bold leading-tight",
                  isActive
                    ? "bg-white/60 text-sky-900 shadow-sm ring-1 ring-white/70"
                    : "text-slate-700/80",
                ].join(" ")
              }
            >
              <span className="text-base leading-none" aria-hidden>
                {item.icon}
              </span>
              <span className="max-w-full truncate">{item.short}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
