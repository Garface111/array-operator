import { useEffect, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchSubscriptions } from "@/lib/api";
import { StatCard } from "@/components/StatCard";

export function MarketplaceScreen() {
  const { openAgent } = useOutletAgent();
  const [arrayCount, setArrayCount] = useState(0);
  const [subCount, setSubCount] = useState(0);

  useEffect(() => {
    fetchSubscriptions()
      .then((b) => {
        setArrayCount(b.arrays?.length || 0);
        setSubCount(b.subscriptions?.length || 0);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Marketplace</h1>
        <p className="text-sm font-medium text-muted">
          Offtaker exchange · vacancy & demand
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Arrays" value={String(arrayCount)} meta="In billing bundle" />
        <StatCard label="Offtakers" value={String(subCount)} meta="On file" />
      </div>

      <div className="ao-sheet space-y-3 p-4">
        <p className="text-sm font-semibold leading-relaxed text-ink">
          Surface unallocated group-net-metering excess and collect demand — same
          exchange as desktop Marketplace.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="ao-btn-primary"
            onClick={() =>
              openAgent(
                "Marketplace brief: any unallocated credits / vacancy on my fleet, and how to list demand?"
              )
            }
          >
            Ask Agent about vacancy
          </button>
          <button
            type="button"
            className="ao-btn-ghost"
            onClick={() =>
              openAgent(
                "Help me capture offtaker demand for excess credits. Keep it mobile-simple."
              )
            }
          >
            Capture demand
          </button>
        </div>
      </div>
    </div>
  );
}
