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
    <div className="ao-app-shell">
      {/* Only this region scrolls — dock stays put on iOS */}
      <main
        className="ao-app-main px-4"
        style={{
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingBottom: 16,
        }}
      >
        <Outlet context={{ openAgent }} />
      </main>

      <BottomNav onAgent={() => openAgent()} agentOpen={agentOpen} />
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
