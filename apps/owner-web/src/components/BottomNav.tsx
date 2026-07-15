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
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 px-2 pt-1 backdrop-blur-md"
      style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
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
                  isActive ? "bg-sky-50 text-sky-700" : "text-muted",
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
