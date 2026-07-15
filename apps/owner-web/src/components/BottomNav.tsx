import { NavLink } from "react-router-dom";

/**
 * Four tabs + center Energy Agent control.
 */
const LEFT: Array<{
  to: string;
  label: string;
  short: string;
  icon: string;
  end?: boolean;
}> = [
  { to: "/triage", label: "Fleet Triage", short: "Triage", icon: "◎", end: true },
  { to: "/invoices", label: "Invoices", short: "Invoices", icon: "▤" },
];

const RIGHT: Array<{
  to: string;
  label: string;
  short: string;
  icon: string;
}> = [
  { to: "/resources", label: "Resources", short: "Resources", icon: "☰" },
  { to: "/account", label: "Account", short: "Account", icon: "◉" },
];

type Props = {
  onAgent: () => void;
  agentOpen?: boolean;
};

function TabLink({
  to,
  label,
  short,
  icon,
  end,
}: {
  to: string;
  label: string;
  short: string;
  icon: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        [
          "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-bold leading-tight",
          isActive
            ? "bg-white/60 text-sky-900 shadow-sm ring-1 ring-white/70"
            : "text-slate-700/80",
        ].join(" ")
      }
    >
      <span className="text-base leading-none" aria-hidden>
        {icon}
      </span>
      <span className="max-w-full truncate">{short}</span>
    </NavLink>
  );
}

export function BottomNav({ onAgent, agentOpen }: Props) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/45 bg-white/50 px-1.5 pt-1 shadow-[0_-8px_32px_-16px_rgba(15,50,110,0.35)] backdrop-blur-xl backdrop-saturate-150"
      style={{
        paddingBottom: "max(6px, env(safe-area-inset-bottom))",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
      }}
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-lg items-end justify-between gap-0.5">
        {LEFT.map((item) => (
          <TabLink key={item.to} {...item} />
        ))}

        {/* Center Agent — primary action, sits in the dock */}
        <div className="relative flex w-[4.5rem] shrink-0 flex-col items-center justify-end pb-0.5">
          <button
            type="button"
            onClick={onAgent}
            aria-label="Open Energy Agent"
            aria-pressed={!!agentOpen}
            className={[
              "grid h-12 w-12 place-items-center rounded-full shadow-lg ring-2 transition active:scale-95",
              agentOpen
                ? "ring-sky-300 shadow-sky-500/40"
                : "ring-white/80 shadow-sky-500/30",
            ].join(" ")}
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
            }}
          >
            <span className="sr-only">Agent</span>
          </button>
          <span
            className={[
              "mt-0.5 text-[10px] font-extrabold leading-none",
              agentOpen ? "text-sky-800" : "text-slate-700/85",
            ].join(" ")}
          >
            Agent
          </span>
        </div>

        {RIGHT.map((item) => (
          <TabLink key={item.to} {...item} />
        ))}
      </div>
    </nav>
  );
}
