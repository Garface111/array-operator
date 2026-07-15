import { NavLink } from "react-router-dom";

/**
 * Four tabs + center Energy Agent control (subtle, same row alignment).
 */
const LEFT: Array<{
  to: string;
  label: string;
  short: string;
  icon: string;
  end?: boolean;
}> = [
  { to: "/fleet", label: "Fleet", short: "Fleet", icon: "◎", end: true },
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

const tabClass =
  "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-bold leading-tight";

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
          tabClass,
          isActive
            ? "bg-white/60 text-sky-900 shadow-sm ring-1 ring-white/70"
            : "text-slate-700/80",
        ].join(" ")
      }
    >
      <span className="grid h-5 place-items-center text-base leading-none" aria-hidden>
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
      <div className="mx-auto flex max-w-lg items-stretch justify-between gap-0.5">
        {LEFT.map((item) => (
          <TabLink key={item.to} {...item} />
        ))}

        {/* Same column geometry as tabs so label lines up */}
        <button
          type="button"
          onClick={onAgent}
          aria-label="Open Energy Agent"
          aria-pressed={!!agentOpen}
          title="Energy Agent"
          className={[
            tabClass,
            "min-w-0 flex-[0.9]",
            agentOpen
              ? "bg-white/50 text-sky-900"
              : "text-slate-700/80",
          ].join(" ")}
        >
          <span
            className={[
              "grid h-5 w-5 place-items-center rounded-full opacity-90 ring-1 transition active:scale-95",
              agentOpen
                ? "ring-sky-400/50 opacity-100"
                : "ring-white/60",
            ].join(" ")}
            style={{
              background:
                "radial-gradient(circle at 35% 30%, rgba(255,247,204,0.95) 0%, rgba(251,191,36,0.75) 32%, transparent 48%), radial-gradient(circle at 50% 55%, rgba(56,189,248,0.9) 0%, rgba(33,150,243,0.85) 55%, rgba(3,105,161,0.75) 100%)",
            }}
            aria-hidden
          />
          <span className="max-w-full truncate">Agent</span>
        </button>

        {RIGHT.map((item) => (
          <TabLink key={item.to} {...item} />
        ))}
      </div>
    </nav>
  );
}
