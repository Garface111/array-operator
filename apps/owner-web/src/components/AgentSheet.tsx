import { FormEvent, useEffect, useRef, useState } from "react";
import {
  agentChat,
  agentConfirm,
  startAgentSession,
} from "@/lib/api";
import type { EnergyAgentPending } from "@/lib/types";

type Msg = { role: "user" | "agent"; text: string; tools?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

/**
 * Compact Energy Agent sheet — primary place for small adjustments.
 * Talks to existing /v1/energy-agent/* (same FastAPI brain as desktop).
 * Handles pending confirms + open_url ui_commands from mobile tools.
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<EnergyAgentPending | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setPending(null);
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
          "Hi — I'm Energy Agent. I can check fleet health, offtakers, repairs, marketplace vacancy, and run setup. Ask me anything on this account.";
        setMsgs([{ role: "agent", text: intro }]);
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
      // Mobile SPA: hash navigate only works on desktop shell; skip or soft-note
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
        res.reply || res.speak || res.message || res.content || "Done — anything else?";
      const tools = (res.tool_trace || [])
        .map((x) => x.name || x.tool || "")
        .filter(Boolean) as string[];
      setMsgs((m) => [
        ...m,
        { role: "agent", text: String(reply), tools: tools.length ? tools : undefined },
      ]);
      const pend = res.pending as EnergyAgentPending | null | undefined;
      if (pend && typeof pend === "object") setPending(pend);
      applyUiCommands(res.ui_commands);
      // Also surface ui_command nested in tool results sometimes
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
        setMsgs((m) => [...m, { role: "agent", text: "Okay — cancelled that action." }]);
      } else {
        const r = res.result as { message?: string; error?: string; ok?: boolean } | undefined;
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/25"
        aria-label="Close Energy Agent"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-label="Energy Agent"
        className="ao-chrome relative z-10 mx-auto flex max-h-[min(78vh,600px)] w-full max-w-lg flex-col rounded-t-[28px] border shadow-sheet"
        style={{ paddingBottom: "max(10px, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 pb-3 pt-4">
          <div
            className="h-9 w-9 shrink-0 rounded-full shadow-md"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #fff7cc 0%, #fbbf24 28%, transparent 46%), radial-gradient(circle at 50% 55%, #38bdf8 0%, #2196f3 58%, #0369a1 100%)",
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-extrabold tracking-tight">Energy Agent</h2>
            <p className="truncate text-xs text-muted">
              Fleet · offtakers · repairs · marketplace
            </p>
          </div>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-xl text-xl text-muted"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
        >
          {msgs.map((m, i) => (
            <div key={i}>
              <div
                className={[
                  "max-w-[92%] rounded-2xl px-3 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap",
                  m.role === "user"
                    ? "ml-auto bg-sky-500 text-white"
                    : "bg-white/85 text-ink",
                ].join(" ")}
              >
                {m.text}
              </div>
              {m.tools?.length ? (
                <div className="mt-1 flex flex-wrap gap-1 px-1">
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
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3">
              <div className="text-xs font-extrabold text-amber-900">
                Confirm action
              </div>
              <p className="mt-1 text-[12px] font-semibold text-amber-950/90">
                {pending.reason ||
                  pending.message ||
                  (pending.tool
                    ? `Run ${pending.tool}?`
                    : "Apply this change?")}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="ao-btn-primary !min-h-9 !flex-1 !text-xs"
                  disabled={busy}
                  onClick={() => void onConfirm(true)}
                >
                  Yes, do it
                </button>
                <button
                  type="button"
                  className="ao-btn-ghost !min-h-9 !flex-1 !text-xs"
                  disabled={busy}
                  onClick={() => void onConfirm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {busy ? (
            <div className="text-xs font-semibold text-muted">Thinking…</div>
          ) : null}
          {err ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {err}
            </div>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="border-t border-line px-3 pt-2">
          <div className="flex gap-2 rounded-2xl border border-line bg-white/70 p-1.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask or adjust something…"
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="ao-btn-primary shrink-0 !min-h-10 !rounded-xl !px-3 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
