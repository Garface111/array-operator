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
  uploadAgentFile,
  type AgentUploadAsset,
} from "@/lib/api";
import type { EnergyAgentPending } from "@/lib/types";
import { SetupWidget, type SetupWidgetSpec } from "./SetupWidget";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { AgentMarkdown } from "./AgentMarkdown";
import { useRealtimeVoice } from "@/hooks/useRealtimeVoice";

type Msg = {
  role: "user" | "agent";
  text: string;
  tools?: string[];
  attachments?: string[];
  /** Interactive setup card the agent opened (open_setup_widget). Rendered
   *  under the message so the owner finishes the job in the conversation. */
  widget?: SetupWidgetSpec;
};

type PendingAttach = AgentUploadAsset & { localName: string };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

const MOBILE_CTX = {
  client: "owner-web",
  surface: "agent_sheet_mobile",
  mobile: true,
} as const;

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "Fleet brief",
    prompt: "Give me a quick fleet health brief for mobile — what needs attention?",
  },
  {
    label: "Vacancy",
    prompt: "Any unallocated credits / marketplace vacancy on my fleet?",
  },
  {
    label: "Repairs",
    prompt: "Repair system status and O&M roster — what's open and who do we contact?",
  },
  {
    label: "Invoices",
    prompt: "Offtaker invoice pipeline status — drafted, waiting on bills, next send?",
  },
];

/**
 * Mobile chat sheet — designed to standard chat UX:
 * - Full visual-viewport height (keyboard-safe via visualViewport API)
 * - Fixed header + scrollable messages + sticky composer
 * - No autofocus on open (avoids iOS jump / “messages disappear”)
 * - Scroll pins to latest message; body scroll locked while open
 * - Swipe-down on handle to dismiss
 * - At top of thread: one more scroll-up (overscroll) closes the whole chat
 * - Mobile attach: camera / library / file → upload → attachment chips
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<EnergyAgentPending | null>(null);
  const [ready, setReady] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttach[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);
  const dragY = useRef(0);
  const dragging = useRef(false);
  const dragOffsetRef = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);

  const vv = useVisualViewport(open);

  // Voice: Realtime is ears+mouth only. A finished utterance goes through the
  // SAME send() as typing, so spoken answers use the same tools, the same
  // confirm-before-write gate, and the same DB-backed thread.
  // Voice: Realtime is ears + mouth ONLY. A finished utterance runs through
  // the deep brain, which authors both halves of the turn (speak + reply).
  const voice = useRealtimeVoice({
    onUserTranscript: (t) => {
      void voiceTurn(t);
    },
    onError: (m) => setErr(m),
  });

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
      voice.stop();
      seeded.current = false;
      setPending(null);
      setDragOffset(0);
      setReady(false);
      setInput("");
      setErr(null);
      setAttachments([]);
      setShowAttachMenu(false);
      setUploading(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({ ...MOBILE_CTX });
        if (cancelled) return;
        setSessionId(s.session_id || null);
        // Restore the conversation. The server resumes the tenant's open session
        // by default and returns its turns on THIS call (intro is null on resume),
        // so the thread survives close/reopen and is the SAME thread as desktop.
        // Painting the intro unconditionally here is what used to wipe history.
        const restored: Msg[] = (s.messages || [])
          .map((m) => ({
            role: (m.role === "user" ? "user" : "agent") as Msg["role"],
            text: String(m.content ?? "").trim(),
          }))
          .filter((m) => m.text.length > 0);
        if (restored.length) {
          setMsgs(restored);
        } else {
          const intro =
            s.intro ||
            "Hi — **Energy Agent on mobile**. Fleet, offtakers, repairs, marketplace — ask me. Tap **+** to attach a photo or file.";
          setMsgs([{ role: "agent", text: intro }]);
        }
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
    cmds?: Array<Record<string, unknown>>
  ) {
    if (!cmds?.length) return;
    for (const c of cmds) {
      if (c.type === "open_url" && typeof c.url === "string") {
        try {
          window.open(c.url, "_blank", "noopener,noreferrer");
        } catch {
          /* ignore */
        }
        continue;
      }
      // The agent opened a real setup form. Attach it to the message it just
      // sent so it renders inline, right under what the agent said about it.
      if (c.type === "setup_widget") {
        const spec = c as unknown as SetupWidgetSpec;
        setMsgs((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "agent") {
              next[i] = { ...next[i], widget: spec };
              return next;
            }
          }
          return [...next, { role: "agent", text: "", widget: spec }];
        });
      }
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length || busy || uploading) return;
    setShowAttachMenu(false);
    setUploading(true);
    setErr(null);
    try {
      const next: PendingAttach[] = [];
      for (const file of Array.from(fileList).slice(0, 8)) {
        if (attachments.length + next.length >= 8) break;
        const asset = await uploadAgentFile(file);
        next.push({
          ...asset,
          localName: file.name || asset.filename || "file",
        });
      }
      if (next.length) setAttachments((a) => [...a, ...next].slice(0, 8));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      // reset inputs so the same file can be re-picked
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (libraryInputRef.current) libraryInputRef.current.value = "";
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttach(id: string) {
    setAttachments((a) => a.filter((x) => x.id !== id));
  }

  async function send(text: string) {
    const t = text.trim();
    const pendingAttach = attachments.slice();
    const attachIds = pendingAttach.map((a) => a.id).filter(Boolean);
    if ((!t && !attachIds.length) || busy || uploading) return;
    const display =
      t ||
      (attachIds.length
        ? `Please analyze the attached file${attachIds.length > 1 ? "s" : ""}.`
        : "");
    setInput("");
    setAttachments([]);
    setShowAttachMenu(false);
    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setMsgs((m) => [
      ...m,
      {
        role: "user",
        text: display,
        attachments: pendingAttach.map((a) => a.localName || a.filename || a.id),
      },
    ]);
    setBusy(true);
    setErr(null);
    setPending(null);
    scrollToBottom(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await startAgentSession({ ...MOBILE_CTX });
        sid = s.session_id || null;
        setSessionId(sid);
      }
      if (!sid) throw new Error("No agent session");
      const res = await agentChat(sid, display, { ...MOBILE_CTX }, attachIds);
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

  /**
   * One spoken turn — desktop parity (consultDeepBrain).
   * The deep brain authors BOTH halves: res.speak is what the mouth says,
   * res.reply is the written write-up that goes in the panel. Realtime never
   * composes; it only reads the line we hand it.
   */
  async function voiceTurn(said: string) {
    const t = said.trim();
    if (!t) return;
    setMsgs((m) => [...m, { role: "user", text: t }]);
    voice.cancelSpeech();
    voice.setThinking();
    setErr(null);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await startAgentSession({ ...MOBILE_CTX });
        sid = s.session_id || null;
        setSessionId(sid);
      }
      if (!sid) throw new Error("No agent session");
      const res = await agentChat(
        sid,
        t,
        { ...MOBILE_CTX, voice_active: true, voice_weave: true },
        []
      );
      const written = String(res.reply || res.message || res.content || "");
      const spokenLine = String(res.speak || "").trim() || written;
      if (written) setMsgs((m) => [...m, { role: "agent", text: written }]);
      if (spokenLine) voice.speak(spokenLine);
      const pend = res.pending as EnergyAgentPending | null | undefined;
      if (pend && typeof pend === "object") setPending(pend);
      applyUiCommands(res.ui_commands);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Voice turn failed");
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

  const setOff = useCallback((y: number) => {
    dragOffsetRef.current = y;
    setDragOffset(y);
  }, []);

  // ── Swipe-down dismiss — large top hit zone, page scroll locked ────────
  useEffect(() => {
    if (!open) return;
    const el = handleRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent | PointerEvent) => {
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

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
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
  }, [open, onClose, setOff]);

  /**
   * At max scroll-up (top of thread): one more "scroll up" closes the chat.
   * Finger continues past the top (pull down overscroll) → whole sheet dismisses.
   * When the thread is short (nothing to scroll), same pull works on the list.
   */
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;

    let startY = 0;
    let armed = false; // finger down while at top
    let pulling = false; // actively past-top overscroll
    let pull = 0;
    const CLOSE_PX = 90;

    const atTop = () => el.scrollTop <= 2;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      armed = atTop();
      pulling = false;
      pull = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - startY; // finger down → positive → past top when atTop

      // Hit top mid-gesture while scrolling toward older messages
      if (!armed && atTop() && dy > 0) {
        armed = true;
        startY = y;
        pull = 0;
      }

      if (!armed) return;

      // Left the top — cancel overscroll-close, let normal scroll work
      if (!atTop() && !pulling) {
        armed = false;
        pulling = false;
        pull = 0;
        setOff(0);
        return;
      }

      // At top: further "scroll up" = finger moves down (dy > 0)
      if (atTop() && dy > 0) {
        pulling = true;
        pull = dy;
        // Stop rubber-band / page fight; sheet follows the pull
        e.preventDefault();
        setOff(Math.min(dy * 0.85, 220));
      } else if (pulling && dy <= 0) {
        // Reversed back into content
        pulling = false;
        pull = 0;
        setOff(0);
        armed = atTop();
        startY = y;
      }
    };

    const onTouchEnd = () => {
      if (pulling && pull >= CLOSE_PX) {
        setOff(0);
        onClose();
      } else {
        setOff(0);
      }
      armed = false;
      pulling = false;
      pull = 0;
    };

    // Desktop / trackpad: scroll up (deltaY < 0) while at top closes
    let wheelAcc = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!atTop()) {
        wheelAcc = 0;
        return;
      }
      // Negative deltaY = scroll up (toward past top)
      if (e.deltaY < 0) {
        e.preventDefault();
        wheelAcc += -e.deltaY;
        setOff(Math.min(wheelAcc * 0.4, 180));
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
          if (wheelAcc > 140) {
            setOff(0);
            onClose();
          } else {
            setOff(0);
          }
          wheelAcc = 0;
        }, 120);
      } else {
        wheelAcc = 0;
        setOff(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
      if (wheelTimer) clearTimeout(wheelTimer);
    };
  }, [open, onClose, setOff, ready, msgs.length]);

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
                    : "At top of chat, scroll up again to close"}
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
          className="ao-chat-messages min-h-0 flex-1 overflow-y-auto px-3 py-3"
          style={{
            WebkitOverflowScrolling: "touch",
            // We handle top overscroll ourselves (close chat); block browser rubber-band
            overscrollBehaviorY: "none",
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
                  {m.attachments?.length ? (
                    <div
                      className={[
                        "mt-2 flex flex-wrap gap-1",
                        m.role === "user" ? "text-white/90" : "text-muted",
                      ].join(" ")}
                    >
                      {m.attachments.map((name) => (
                        <span
                          key={name}
                          className={[
                            "inline-flex max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-bold",
                            m.role === "user"
                              ? "bg-white/20"
                              : "bg-sky-50 text-sky-800",
                          ].join(" ")}
                        >
                          📎 {name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                {m.widget ? (
                  <SetupWidget
                    spec={m.widget}
                    onResult={(line) =>
                      setMsgs((prev) => [...prev, { role: "agent", text: line }])
                    }
                  />
                ) : null}
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
          {/* Quick action chips — mobile-centric shortcuts */}
          {!busy && ready && msgs.length <= 2 && !attachments.length ? (
            <div className="mx-auto mb-2 flex max-w-lg gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(q.prompt)}
                  className="shrink-0 rounded-full bg-sky-100/90 px-3 py-2 text-[11px] font-extrabold text-sky-800 ring-1 ring-sky-200/80 active:bg-sky-200"
                >
                  {q.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Pending attachment chips */}
          {attachments.length || uploading ? (
            <div className="mx-auto mb-2 flex max-w-lg flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex max-w-[70%] items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-bold text-sky-900 ring-1 ring-sky-200"
                >
                  <span className="truncate">
                    {a.localName || a.filename || a.id}
                  </span>
                  <button
                    type="button"
                    className="grid h-5 w-5 place-items-center rounded-full text-sky-700 hover:bg-sky-200"
                    aria-label="Remove attachment"
                    onClick={() => removeAttach(a.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {uploading ? (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200">
                  Uploading…
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Attach action sheet */}
          {showAttachMenu ? (
            <div className="mx-auto mb-2 grid max-w-lg grid-cols-3 gap-2">
              <button
                type="button"
                className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl bg-sky-50 text-[11px] font-extrabold text-sky-900 ring-1 ring-sky-200 active:bg-sky-100"
                onClick={() => cameraInputRef.current?.click()}
              >
                <span className="text-lg" aria-hidden>
                  📷
                </span>
                Camera
              </button>
              <button
                type="button"
                className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl bg-sky-50 text-[11px] font-extrabold text-sky-900 ring-1 ring-sky-200 active:bg-sky-100"
                onClick={() => libraryInputRef.current?.click()}
              >
                <span className="text-lg" aria-hidden>
                  🖼
                </span>
                Photos
              </button>
              <button
                type="button"
                className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl bg-sky-50 text-[11px] font-extrabold text-sky-900 ring-1 ring-sky-200 active:bg-sky-100"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="text-lg" aria-hidden>
                  📄
                </span>
                File
              </button>
            </div>
          ) : null}

          {/* Hidden pickers — camera uses capture for mobile-centric UX */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.csv,.json,.xlsx,.xls,.log"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />

          <div className="mx-auto flex max-w-lg items-end gap-1.5 rounded-[22px] border border-sky-200/80 bg-sky-50/50 p-1.5 shadow-sm">
            <button
              type="button"
              disabled={busy || uploading}
              onClick={() => setShowAttachMenu((v) => !v)}
              className={[
                "mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl font-bold leading-none ring-1 transition",
                showAttachMenu
                  ? "bg-sky-500 text-white ring-sky-500"
                  : "bg-white text-sky-700 ring-sky-200 active:bg-sky-100",
              ].join(" ")}
              aria-label={showAttachMenu ? "Close attach menu" : "Attach photo or file"}
              aria-expanded={showAttachMenu}
            >
              {showAttachMenu ? "×" : "+"}
            </button>
            <button
              type="button"
              disabled={busy || uploading}
              onClick={() => (voice.active ? voice.stop() : void voice.start())}
              className={[
                "mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg leading-none ring-1 transition",
                voice.active
                  ? "bg-rose-500 text-white ring-rose-500"
                  : "bg-white text-sky-700 ring-sky-200 active:bg-sky-100",
              ].join(" ")}
              aria-label={voice.active ? "Stop voice" : "Talk to Energy Agent"}
              aria-pressed={voice.active}
            >
              {voice.status === "connecting" ? "\u2026" : "\ud83c\udfa4"}
            </button>
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => onInputChange(e.target.value)}
              onFocus={() => {
                setShowAttachMenu(false);
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
              placeholder={
                attachments.length
                  ? "Add a note about the file…"
                  : "Message Energy Agent…"
              }
              enterKeyHint="send"
              className="max-h-[120px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[16px] font-medium leading-snug text-ink outline-none placeholder:text-muted/70"
              // 16px prevents iOS zoom on focus
              style={{ fontSize: 16 }}
            />
            <button
              type="submit"
              disabled={
                busy ||
                uploading ||
                (!input.trim() && attachments.length === 0)
              }
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
          <p className="mx-auto mt-1.5 max-w-lg px-1 text-center text-[10px] font-semibold text-muted">
            + attaches camera, photos, or files for the Agent
          </p>
        </form>
      </section>
    </div>
  );
}
