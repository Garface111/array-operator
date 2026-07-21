import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { AgentDock } from "./AgentDock";
import { AgentSheet } from "./AgentSheet";
import { BottomNav } from "./BottomNav";

export function AppShell() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);

  const openAgent = useCallback((prompt?: string) => {
    setSeed(prompt || null);
    setAgentOpen(true);
  }, []);

  const closeAgent = useCallback(() => {
    setAgentOpen(false);
    // Clear seed so next open without prompt is a fresh chat intro
    setTimeout(() => setSeed(null), 200);
  }, []);

  // Global swipe-up from bottom edge (thumb zone) opens agent when closed
  useEffect(() => {
    if (agentOpen) return;
    let startY = 0;
    let startX = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const h = window.innerHeight;
      // Only from bottom ~100px (above nav + dock)
      if (t.clientY < h - 120) return;
      startY = t.clientY;
      startX = t.clientX;
      tracking = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = startY - t.clientY; // up is positive
      const dx = Math.abs(t.clientX - startX);
      if (dy > 55 && dy > dx * 1.2) {
        tracking = false;
        openAgent();
      }
    };
    const onEnd = () => {
      tracking = false;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, [agentOpen, openAgent]);

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <header
        className="ao-chrome sticky top-0 z-30 border-b px-4"
        style={{ paddingTop: "max(8px, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-3 pb-2.5 pt-1">
          <div
            className="h-9 w-9 shrink-0 rounded-full shadow-md ring-2 ring-white/70"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-extrabold tracking-tight text-ink">
              Array Operator
            </div>
            <div className="text-[11px] font-semibold text-muted">
              Sky fleet · offtakers · Energy Agent
            </div>
          </div>
        </div>
      </header>

      <main
        className="flex-1 px-3.5 pt-3"
        style={{
          // Room for tab bar + floating Agent dock
          paddingBottom:
            "calc(var(--nav-h) + var(--agent-dock-h) + 28px + env(safe-area-inset-bottom))",
        }}
      >
        <Outlet context={{ openAgent }} />
      </main>

      {/* Bottom: Agent dock above tab nav — primary AI access */}
      {!agentOpen ? <AgentDock onOpen={() => openAgent()} /> : null}
      <BottomNav />
      <AgentSheet
        open={agentOpen}
        onClose={closeAgent}
        seedPrompt={seed}
      />
    </div>
  );
}

export type ShellOutlet = {
  openAgent: (prompt?: string) => void;
};
