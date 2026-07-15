import { NavLink } from "react-router-dom";

const ITEMS: Array<{ to: string; label: string; icon: string; end?: boolean }> = [
  { to: "/", label: "Home", end: true, icon: "⌂" },
  { to: "/fleet", label: "Fleet", icon: "▣" },
  { to: "/invoices", label: "Invoices", icon: "▤" },
  { to: "/connect", label: "Connect", icon: "◎" },
  { to: "/more", label: "More", icon: "···" },
];

export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/45 bg-white/40 px-2 pt-1 shadow-[0_-8px_32px_-16px_rgba(15,50,110,0.35)] backdrop-blur-xl backdrop-saturate-150"
      style={{
        paddingBottom: "max(8px, env(safe-area-inset-bottom))",
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
              className={({ isActive }) =>
                [
                  "flex flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-bold",
                  isActive
                    ? "bg-white/55 text-sky-800 shadow-sm ring-1 ring-white/60"
                    : "text-slate-700/85",
                ].join(" ")
              }
            >
              <span className="text-base leading-none" aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
