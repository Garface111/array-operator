import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AgentSheet } from "./AgentSheet";
import { BottomNav } from "./BottomNav";

export function AppShell() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);

  function openAgent(prompt?: string) {
    setSeed(prompt || null);
    setAgentOpen(true);
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <header
        className="sticky top-0 z-30 border-b border-white/40 bg-white/35 px-4 shadow-sm backdrop-blur-xl backdrop-saturate-150"
        style={{
          paddingTop: "max(10px, env(safe-area-inset-top))",
          WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        }}
      >
        <div className="flex items-center gap-3 pb-3 pt-1">
          <div
            className="h-9 w-9 shrink-0 rounded-full shadow-md ring-2 ring-white/50"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-extrabold tracking-tight text-slate-900 drop-shadow-sm">
              Array Operator
            </div>
            <div className="text-[11px] font-semibold text-slate-700/80">
              Fleet · offtakers · Agent
            </div>
          </div>
          <button
            type="button"
            onClick={() => openAgent()}
            className="ao-btn-primary !min-h-9 !rounded-full !px-3 !text-xs"
          >
            Agent
          </button>
        </div>
      </header>

      <main
        className="flex-1 px-4 pt-4"
        style={{ paddingBottom: "calc(var(--nav-h) + 24px + env(safe-area-inset-bottom))" }}
      >
        <Outlet context={{ openAgent }} />
      </main>

      <BottomNav />
      <AgentSheet
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        seedPrompt={seed}
      />
    </div>
  );
}

export type ShellOutlet = {
  openAgent: (prompt?: string) => void;
};
