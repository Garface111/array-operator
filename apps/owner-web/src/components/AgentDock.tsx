import { useEffect, useRef } from "react";

type Props = {
  onOpen: () => void;
};

/**
 * Thumb-zone access for Energy Agent — sits above the tab bar.
 *
 * Large hit target (dock + extended zone above). Touch on this surface:
 * - preventDefault so the page does NOT scroll
 * - swipe up OR tap opens chat
 */
export function AgentDock({ onOpen }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const startX = useRef(0);
  const tracking = useRef(false);
  const moved = useRef(false);
  const opened = useRef(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startY.current = t.clientY;
      startX.current = t.clientX;
      tracking.current = true;
      moved.current = false;
      opened.current = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = startY.current - t.clientY; // up positive
      const dx = Math.abs(t.clientX - startX.current);

      // As soon as there's any vertical intent, lock page scroll
      if (Math.abs(dy) > 4 || dx > 4) {
        moved.current = true;
        // Critical: stop the document from scrolling under the gesture
        e.preventDefault();
      }

      // Swipe up enough → open (once)
      if (!opened.current && dy > 28 && dy > dx * 0.85) {
        opened.current = true;
        e.preventDefault();
        onOpen();
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking.current) return;
      tracking.current = false;
      if (opened.current) {
        e.preventDefault();
        return;
      }
      // Tap (little movement) → open
      if (!moved.current) {
        onOpen();
      } else {
        const t = e.changedTouches[0];
        const dy = startY.current - t.clientY;
        const dx = Math.abs(t.clientX - startX.current);
        if (dy > 24 && dy > dx) {
          e.preventDefault();
          onOpen();
        }
      }
    };

    // non-passive so preventDefault works
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [onOpen]);

  return (
    <div
      ref={rootRef}
      className="ao-agent-dock-hit pointer-events-auto fixed inset-x-0 z-[45] flex justify-center px-2"
      style={{
        // Tall hit zone: from above the visible bar down toward the tab bar
        bottom: "calc(var(--nav-h) + env(safe-area-inset-bottom, 0px))",
        // ~110px tall touch target (bar ~64 + padding above/below)
        height: "var(--agent-dock-hit-h, 110px)",
        touchAction: "none", // CSS: browser should not pan the page on this surface
      }}
      role="button"
      tabIndex={0}
      aria-label="Open Energy Agent chat — tap or swipe up"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* Visual dock aligned to bottom of hit zone */}
      <div className="ao-chrome mt-auto mb-1.5 flex w-full max-w-lg items-center gap-3 rounded-[22px] border px-3.5 py-3.5 shadow-sheet">
        <div className="flex w-9 flex-col items-center gap-1.5" aria-hidden>
          <span className="h-1.5 w-10 rounded-full bg-sky-300" />
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-sky-600">
            swipe up
          </span>
        </div>

        <div
          className="h-11 w-11 shrink-0 rounded-full shadow-md ring-2 ring-white/80"
          style={{
            background:
              "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
          }}
          aria-hidden
        />

        <div className="min-w-0 flex-1 text-left">
          <div className="text-[14px] font-extrabold tracking-tight text-ink">
            Energy Agent
          </div>
          <div className="truncate text-[12px] font-semibold text-muted">
            Tap or swipe up to chat
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-sky-500 px-3.5 py-2 text-[12px] font-extrabold text-white shadow-md shadow-sky-500/30">
          Chat
        </span>
      </div>
    </div>
  );
}
