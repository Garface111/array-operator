import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  agentChat,
  agentConfirm,
  startAgentSession,
} from "@/lib/api";
import type { EnergyAgentPending } from "@/lib/types";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { AgentMarkdown } from "./AgentMarkdown";

type Msg = { role: "user" | "agent"; text: string; tools?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

/**
 * Mobile chat sheet — designed to standard chat UX:
 * - Full visual-viewport height (keyboard-safe via visualViewport API)
 * - Fixed header + scrollable messages + sticky composer
 * - No autofocus on open (avoids iOS jump / “messages disappear”)
 * - Scroll pins to latest message; body scroll locked while open
 * - Swipe-down on handle to dismiss
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<EnergyAgentPending | null>(null);
  const [ready, setReady] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  const dragY = useRef(0);
  const dragging = useRef(false);
  const dragOffsetRef = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);

  const vv = useVisualViewport(open);

  // ── Body scroll lock while chat is open ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    const prevPos = document.body.style.position;
    const prevTop = document.body.style.top;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = prev;
      document.body.style.position = prevPos;
      document.body.style.top = prevTop;
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // ── Session bootstrap (no autofocus — user taps to type) ───────────────
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setPending(null);
      setDragOffset(0);
      setReady(false);
      setInput("");
      setErr(null);
      return;
    }
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet_mobile",
        });
        if (cancelled) return;
        setSessionId(s.session_id || null);
        const intro =
          s.intro ||
          "Hi — I'm **Energy Agent**. I can check fleet health, offtakers, repairs, marketplace vacancy, and run setup.\n\nAsk me anything on this account.";
        setMsgs([{ role: "agent", text: intro }]);
        setReady(true);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not start Agent");
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seeded prompt from dock CTAs
  useEffect(() => {
    if (!open || !seedPrompt || !sessionId || seeded.current || busy || !ready)
      return;
    seeded.current = true;
    void send(seedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedPrompt, sessionId, ready]);

  // ── Pin scroll to bottom (messages, keyboard, pending) ─────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (!el) return;
    const run = () => {
      el.scrollTop = el.scrollHeight;
      bottomRef.current?.scrollIntoView({
        block: "end",
        behavior: smooth ? "smooth" : "auto",
      });
    };
    // Double rAF: after layout / keyboard animation
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    scrollToBottom(false);
  }, [msgs, busy, pending, open, vv.height, vv.keyboardOpen, scrollToBottom]);

  // Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function applyUiCommands(
    cmds?: Array<{ type?: string; url?: string; hash?: string; label?: string }>
  ) {
    if (!cmds?.length) return;
    for (const c of cmds) {
      if (c.type === "open_url" && c.url) {
        try {
          window.open(c.url, "_blank", "noopener,noreferrer");
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    setErr(null);
    setPending(null);
    scrollToBottom(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet_mobile",
        });
        sid = s.session_id || null;
        setSessionId(sid);
      }
      if (!sid) throw new Error("No agent session");
      const res = await agentChat(sid, t, {
        client: "owner-web",
        surface: "agent_sheet_mobile",
        mobile: true,
      });
      const reply =
        res.reply ||
        res.speak ||
        res.message ||
        res.content ||
        "Done — anything else?";
      const tools = (res.tool_trace || [])
        .map((x) => x.name || x.tool || "")
        .filter(Boolean) as string[];
      setMsgs((m) => [
        ...m,
        {
          role: "agent",
          text: String(reply),
          tools: tools.length ? tools : undefined,
        },
      ]);
      const pend = res.pending as EnergyAgentPending | null | undefined;
      if (pend && typeof pend === "object") setPending(pend);
      applyUiCommands(res.ui_commands);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(yes: boolean) {
    if (!sessionId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await agentConfirm(sessionId, yes, pending?.id);
      setPending(null);
      if (res.cancelled) {
        setMsgs((m) => [
          ...m,
          { role: "agent", text: "Okay — cancelled that action." },
        ]);
      } else {
        const r = res.result as
          | { message?: string; error?: string; ok?: boolean }
          | undefined;
        const text =
          (typeof r?.message === "string" && r.message) ||
          (typeof r?.error === "string" && `Failed: ${r.error}`) ||
          res.message ||
          res.reply ||
          (yes ? "Done." : "Cancelled.");
        setMsgs((m) => [...m, { role: "agent", text: String(text) }]);
        applyUiCommands(res.ui_commands);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onInputChange(v: string) {
    setInput(v);
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // ── Swipe-down dismiss — large top hit zone, page scroll locked ────────
  useEffect(() => {
    if (!open) return;
    const el = handleRef.current;
    if (!el) return;

    const setOff = (y: number) => {
      dragOffsetRef.current = y;
      setDragOffset(y);
    };

    const onStart = (e: TouchEvent | PointerEvent) => {
      // Don't start drag from the close button
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-chat-close]")) return;

      const clientY =
        "touches" in e ? e.touches[0]?.clientY : (e as PointerEvent).clientY;
      if (clientY == null) return;
      dragging.current = true;
      dragY.current = clientY;
      setOff(0);
    };

    const onMove = (e: TouchEvent | PointerEvent) => {
      if (!dragging.current) return;
      const clientY =
        "touches" in e
          ? e.touches[0]?.clientY
          : (e as PointerEvent).clientY;
      if (clientY == null) return;
      const dy = Math.max(0, clientY - dragY.current);
      // Prevent page/sheet under-scroll while dragging the handle
      e.preventDefault();
      setOff(dy);
    };

    const onEnd = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const y = dragOffsetRef.current;
      if (y > 80) {
        setOff(0);
        onClose();
      } else {
        setOff(0);
      }
    };

    // Touch (non-passive for preventDefault)
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    // Pointer for desktop / stylus
    el.addEventListener("pointerdown", onStart as EventListener);
    el.addEventListener("pointermove", onMove as EventListener);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);

    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("pointerdown", onStart as EventListener);
      el.removeEventListener("pointermove", onMove as EventListener);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
    };
  }, [open, onClose]);

  if (!open) return null;

  // Sheet fills the *visual* viewport so keyboard never covers the composer.
  // offsetTop handles iOS visual viewport shift while focused.
  const sheetHeight = Math.max(280, vv.height || window.innerHeight);
  const sheetTop = vv.offsetTop || 0;

  return (
    <div
      className="ao-chat-root fixed inset-x-0 z-[60] flex justify-center"
      style={{
        top: sheetTop,
        height: sheetHeight,
        // Above everything; isolate layout from body
      }}
    >
      {/* Dim backdrop within visual viewport */}
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="Close Energy Agent"
        onClick={onClose}
        style={{
          opacity: 1 - Math.min(dragOffset / 240, 0.5),
        }}
      />

      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Energy Agent chat"
        className="ao-chat-sheet relative z-10 flex h-full w-full max-w-lg flex-col bg-[#F0F7FD] shadow-sheet"
        style={{
          transform: `translateY(${dragOffset}px)`,
          transition: dragging.current ? "none" : "transform 0.2s ease-out",
          // Safe areas: top notch when full-screen; bottom only if no keyboard
          paddingTop: "max(0px, env(safe-area-inset-top))",
          paddingBottom: vv.keyboardOpen
            ? 0
            : "max(0px, env(safe-area-inset-bottom))",
        }}
      >
        {/* ── Header + large swipe-down zone (entire top chrome is the grip) ── */}
        <header
          ref={handleRef}
          className="ao-chat-header ao-chat-handle shrink-0 border-b border-sky-200/60 bg-white/95 backdrop-blur-md select-none"
          style={{ touchAction: "none" }}
        >
          {/* Tall grab strip — easy swipe-down target */}
          <div className="flex w-full flex-col items-center justify-center pt-3 pb-1">
            <span className="block h-1.5 w-12 rounded-full bg-sky-300" />
            <span className="mt-1.5 text-[10px] font-extrabold uppercase tracking-wider text-sky-600/90">
              swipe down to close
            </span>
          </div>
          <div className="flex min-h-[56px] items-center gap-2.5 px-3.5 pb-3 pt-1">
            <div
              className="h-10 w-10 shrink-0 rounded-full shadow-md ring-2 ring-white"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
              }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-extrabold tracking-tight text-ink">
                Energy Agent
              </h2>
              <p className="truncate text-[11px] font-semibold text-muted">
                {busy
                  ? "Thinking…"
                  : vv.keyboardOpen
                    ? "Type your question"
                    : "Pull down on this header to close"}
              </p>
            </div>
            <button
              type="button"
              data-chat-close
              className="grid h-11 w-11 place-items-center rounded-full bg-sky-50 text-xl font-bold leading-none text-sky-800 ring-1 ring-sky-100"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label="Close chat"
            >
              ×
            </button>
          </div>
        </header>

        {/* ── Message list (only scroll region) ── */}
        <div
          ref={listRef}
          className="ao-chat-messages min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
          style={{
            WebkitOverflowScrolling: "touch",
            // Prevent iOS rubber-band from scrolling the page under us
            overscrollBehavior: "contain",
          }}
        >
          <div className="mx-auto flex max-w-lg flex-col gap-3">
            {!ready && !err ? (
              <div className="py-8 text-center text-sm font-semibold text-muted">
                Connecting…
              </div>
            ) : null}

            {msgs.map((m, i) => (
              <div
                key={i}
                className={[
                  "flex flex-col",
                  m.role === "user" ? "items-end" : "items-start",
                ].join(" ")}
              >
                <div
                  className={[
                    "max-w-[92%] rounded-[18px] px-3.5 py-2.5",
                    m.role === "user"
                      ? "rounded-br-md bg-sky-500 text-white shadow-md shadow-sky-500/20"
                      : "rounded-bl-md bg-white text-ink shadow-sm ring-1 ring-sky-100/90",
                  ].join(" ")}
                >
                  <AgentMarkdown
                    text={m.text}
                    variant={m.role === "user" ? "user" : "agent"}
                  />
                </div>
                {m.tools?.length ? (
                  <div className="mt-1 flex max-w-[92%] flex-wrap gap-1 px-0.5">
                    {m.tools.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {pending ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                <div className="text-xs font-extrabold text-amber-900">
                  Confirm action
                </div>
                <p className="mt-1 text-[13px] font-semibold leading-snug text-amber-950/90">
                  {pending.reason ||
                    pending.message ||
                    (pending.tool
                      ? `Run ${pending.tool}?`
                      : "Apply this change?")}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    className="ao-btn-primary !min-h-10 !flex-1 !text-xs"
                    disabled={busy}
                    onClick={() => void onConfirm(true)}
                  >
                    Yes, do it
                  </button>
                  <button
                    type="button"
                    className="ao-btn-ghost !min-h-10 !flex-1 !text-xs"
                    disabled={busy}
                    onClick={() => void onConfirm(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {busy ? (
              <div className="flex items-center gap-2 self-start rounded-2xl bg-white px-3.5 py-2.5 text-xs font-semibold text-muted shadow-sm ring-1 ring-sky-100">
                <span className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500 [animation-delay:120ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500 [animation-delay:240ms]" />
                </span>
                Thinking
              </div>
            ) : null}

            {err ? (
              <div className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 ring-1 ring-red-100">
                {err}
              </div>
            ) : null}

            {/* Scroll anchor */}
            <div ref={bottomRef} className="h-px w-full shrink-0" aria-hidden />
          </div>
        </div>

        {/* ── Composer (always at bottom of visual viewport) ── */}
        <form
          onSubmit={onSubmit}
          className="ao-chat-composer shrink-0 border-t border-sky-200/70 bg-white px-3 pt-2"
          style={{
            paddingBottom: vv.keyboardOpen
              ? 8
              : "max(10px, env(safe-area-inset-bottom))",
          }}
        >
          <div className="mx-auto flex max-w-lg items-end gap-2 rounded-[22px] border border-sky-200/80 bg-sky-50/50 p-1.5 shadow-sm">
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => onInputChange(e.target.value)}
              onFocus={() => {
                // After keyboard animates, pin to latest messages
                setTimeout(() => scrollToBottom(false), 80);
                setTimeout(() => scrollToBottom(false), 320);
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter newline
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Message Energy Agent…"
              enterKeyHint="send"
              className="max-h-[120px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-[16px] font-medium leading-snug text-ink outline-none placeholder:text-muted/70"
              // 16px prevents iOS zoom on focus
              style={{ fontSize: 16 }}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sky-500 text-white shadow-md shadow-sky-500/30 disabled:opacity-40"
              aria-label="Send"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="M3.4 20.4L21 12 3.4 3.6 3 10l12 2-12 2 .4 6.4z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
