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
      <main
        className="flex-1 px-4 pt-3"
        style={{
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingBottom:
            "calc(var(--nav-h) + 28px + env(safe-area-inset-bottom))",
        }}
      >
        <Outlet context={{ openAgent }} />
      </main>

      <BottomNav
        onAgent={() => openAgent()}
        agentOpen={agentOpen}
      />
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
