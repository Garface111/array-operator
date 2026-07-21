import { useEffect, useState } from "react";

export type VisualViewportState = {
  /** Visible height (excludes keyboard on most mobile browsers). */
  height: number;
  /** Offset of visual viewport top relative to layout (iOS keyboard scroll). */
  offsetTop: number;
  /** Approx keyboard height = layout height − visual height. */
  keyboardHeight: number;
  /** True when keyboard is likely open. */
  keyboardOpen: boolean;
};

/**
 * Track the mobile visual viewport so fixed chat UIs can sit above the keyboard.
 * iOS Safari: layout viewport stays large; visual viewport shrinks — we size to visual.
 */
export function useVisualViewport(active = true): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    height: typeof window !== "undefined" ? window.innerHeight : 0,
    offsetTop: 0,
    keyboardHeight: 0,
    keyboardOpen: false,
  }));

  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    const vv = window.visualViewport;
    const read = () => {
      const layoutH = window.innerHeight;
      const h = vv?.height ?? layoutH;
      const offsetTop = vv?.offsetTop ?? 0;
      // Small threshold: avoid treating browser chrome as keyboard
      const keyboardHeight = Math.max(0, layoutH - h - offsetTop);
      const keyboardOpen = keyboardHeight > 80;
      setState({
        height: Math.round(h),
        offsetTop: Math.round(offsetTop),
        keyboardHeight: Math.round(keyboardHeight),
        keyboardOpen,
      });
    };

    read();
    vv?.addEventListener("resize", read);
    vv?.addEventListener("scroll", read);
    window.addEventListener("resize", read);
    // iOS focus/blur can lag behind visualViewport events
    window.addEventListener("focusin", read);
    window.addEventListener("focusout", read);

    return () => {
      vv?.removeEventListener("resize", read);
      vv?.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      window.removeEventListener("focusin", read);
      window.removeEventListener("focusout", read);
    };
  }, [active]);

  return state;
}
