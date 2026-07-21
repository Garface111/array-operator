import { useRef } from "react";

type Props = {
  onOpen: () => void;
};

/**
 * Thumb-zone access for Energy Agent — sits above the tab bar.
 * Tap anywhere, or swipe up on the dock, to open chat.
 */
export function AgentDock({ onOpen }: Props) {
  const startY = useRef(0);
  const startX = useRef(0);

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
        onTouchStart={(e) => {
          const t = e.touches[0];
          startY.current = t.clientY;
          startX.current = t.clientX;
        }}
        onTouchEnd={(e) => {
          const t = e.changedTouches[0];
          const dy = startY.current - t.clientY;
          const dx = Math.abs(t.clientX - startX.current);
          // Swipe up on the dock opens chat (in addition to tap)
          if (dy > 36 && dy > dx) {
            e.preventDefault();
            onOpen();
          }
        }}
        className="pointer-events-auto ao-chrome group flex w-full max-w-lg items-center gap-3 rounded-[22px] border px-3.5 py-2.5 shadow-sheet active:scale-[0.99]"
        aria-label="Open Energy Agent chat"
      >
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
            Tap or swipe up to chat
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-sky-500 px-3 py-1.5 text-[11px] font-extrabold text-white shadow-md shadow-sky-500/30 group-active:bg-sky-600">
          Chat
        </span>
      </button>
    </div>
  );
}
