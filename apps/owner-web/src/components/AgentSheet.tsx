import { FormEvent, useEffect, useRef, useState } from "react";
import {
  agentChat,
  agentConfirm,
  startAgentSession,
} from "@/lib/api";
import type { EnergyAgentPending } from "@/lib/types";
import { AgentMarkdown } from "./AgentMarkdown";

type Msg = { role: "user" | "agent"; text: string; tools?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

/**
 * Bottom sheet chat for Energy Agent.
 * - Markdown replies (bold / italic / lists / links)
 * - Drag handle: swipe down to dismiss, swipe-friendly open from dock
 * - Pending confirm for write tools
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<EnergyAgentPending | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);
  const dragY = useRef(0);
  const dragging = useRef(false);
  const [sheetOffset, setSheetOffset] = useState(0);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setPending(null);
      setSheetOffset(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet_mobile",
        });
        if (cancelled) return;
        const id = s.session_id || null;
        setSessionId(id);
        const intro =
          s.intro ||
          "Hi — I'm **Energy Agent**. I can check fleet health, offtakers, repairs, marketplace vacancy, and run setup. Ask me anything on this account.";
        setMsgs([{ role: "agent", text: intro }]);
        // Focus composer after open (mobile keyboard optional)
        setTimeout(() => inputRef.current?.focus(), 350);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not start Agent");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !seedPrompt || !sessionId || seeded.current || busy) return;
    seeded.current = true;
    void send(seedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedPrompt, sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, busy, pending]);

  // Escape to close
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
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    setErr(null);
    setPending(null);
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

  // ── Swipe-down dismiss on handle ───────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true;
    dragY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const dy = Math.max(0, e.clientY - dragY.current);
    setSheetOffset(dy);
  }
  function onPointerUp() {
    if (!dragging.current) return;
    dragging.current = false;
    if (sheetOffset > 110) {
      setSheetOffset(0);
      onClose();
    } else {
      setSheetOffset(0);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px] transition-opacity"
        style={{ opacity: 1 - Math.min(sheetOffset / 280, 0.6) }}
        aria-label="Close Energy Agent"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-label="Energy Agent"
        className="ao-chrome relative z-10 mx-auto flex h-[min(88vh,720px)] w-full max-w-lg flex-col rounded-t-[28px] border shadow-sheet"
        style={{
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          transform: `translateY(${sheetOffset}px)`,
          transition: dragging.current ? "none" : "transform 0.22s ease-out",
        }}
      >
        {/* Drag handle */}
        <div
          className="flex cursor-grab flex-col items-center touch-none select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="py-2.5">
            <span className="block h-1.5 w-11 rounded-full bg-sky-300/90" />
          </div>
          <div className="flex w-full items-center gap-2 border-b border-line px-4 pb-3">
            <div
              className="h-10 w-10 shrink-0 rounded-full shadow-md ring-2 ring-white/70"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
              }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-extrabold tracking-tight">
                Energy Agent
              </h2>
              <p className="truncate text-[11px] font-semibold text-muted">
                Swipe down to close · fleet · offtakers · repairs
              </p>
            </div>
            <button
              type="button"
              className="grid h-9 w-9 place-items-center rounded-xl bg-white/70 text-lg font-bold text-muted"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3.5 py-3"
        >
          {msgs.map((m, i) => (
            <div key={i}>
              <div
                className={[
                  "max-w-[94%] rounded-[20px] px-3.5 py-3",
                  m.role === "user"
                    ? "ml-auto bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-md shadow-sky-500/25"
                    : "bg-white/92 text-ink shadow-sm ring-1 ring-sky-100/80",
                ].join(" ")}
              >
                <AgentMarkdown
                  text={m.text}
                  variant={m.role === "user" ? "user" : "agent"}
                />
              </div>
              {m.tools?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1 px-1">
                  {m.tools.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-sky-100/90 px-2 py-0.5 text-[10px] font-bold text-sky-800"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {pending ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3 shadow-sm">
              <div className="text-xs font-extrabold text-amber-900">
                Confirm action
              </div>
              <p className="mt-1 text-[12.5px] font-semibold leading-snug text-amber-950/90">
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
            <div className="flex items-center gap-2 px-1 text-xs font-semibold text-muted">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              Thinking…
            </div>
          ) : null}
          {err ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {err}
            </div>
          ) : null}
        </div>

        <form
          onSubmit={onSubmit}
          className="border-t border-line bg-white/50 px-3 pt-2.5"
        >
          <div className="flex gap-2 rounded-2xl border border-line bg-white/90 p-1.5 shadow-sm">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Energy Agent…"
              className="min-w-0 flex-1 bg-transparent px-2.5 py-2.5 text-base font-medium outline-none placeholder:text-muted/80"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="ao-btn-primary shrink-0 !min-h-11 !rounded-xl !px-4 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
