type Props = {
  onOpen: () => void;
};

/**
 * Always-visible bottom access for Energy Agent — sits above the tab bar.
 * Tap or swipe-up hint opens the full chat sheet (handled by parent).
 */
export function AgentDock({ onOpen }: Props) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[45] flex justify-center px-3"
      style={{
        bottom: "calc(var(--nav-h) + env(safe-area-inset-bottom, 0px) + 6px)",
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="pointer-events-auto ao-chrome group flex w-full max-w-lg items-center gap-3 rounded-[22px] border px-3.5 py-2.5 shadow-sheet active:scale-[0.99]"
        aria-label="Open Energy Agent — swipe up or tap"
      >
        {/* Grip / swipe affordance */}
        <div className="flex w-7 flex-col items-center gap-1" aria-hidden>
          <span className="h-1 w-8 rounded-full bg-sky-300/90" />
          <span className="text-[9px] font-extrabold uppercase tracking-wider text-sky-600/80">
            up
          </span>
        </div>

        <div
          className="h-10 w-10 shrink-0 rounded-full shadow-md ring-2 ring-white/80"
          style={{
            background:
              "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
          }}
          aria-hidden
        />

        <div className="min-w-0 flex-1 text-left">
          <div className="text-[13px] font-extrabold tracking-tight text-ink">
            Energy Agent
          </div>
          <div className="truncate text-[11px] font-semibold text-muted">
            Ask about fleet, invoices, repairs…
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-sky-500 px-3 py-1.5 text-[11px] font-extrabold text-white shadow-md shadow-sky-500/30 group-active:bg-sky-600">
          Chat
        </span>
      </button>
    </div>
  );
}
