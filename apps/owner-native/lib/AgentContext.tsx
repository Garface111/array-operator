import React, { createContext, useContext, useMemo, useState } from "react";
import { AgentModal } from "@/components/AgentModal";

type Ctx = {
  openAgent: (prompt?: string) => void;
};

const AgentCtx = createContext<Ctx | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);

  const value = useMemo(
    () => ({
      openAgent: (prompt?: string) => {
        setSeed(prompt || null);
        setOpen(true);
      },
    }),
    []
  );

  return (
    <AgentCtx.Provider value={value}>
      {children}
      <AgentModal
        open={open}
        onClose={() => setOpen(false)}
        seedPrompt={seed}
      />
    </AgentCtx.Provider>
  );
}

export function useAgent(): Ctx {
  const v = useContext(AgentCtx);
  if (!v) throw new Error("useAgent outside AgentProvider");
  return v;
}
