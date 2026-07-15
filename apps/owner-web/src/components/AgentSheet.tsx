import { FormEvent, useEffect, useRef, useState } from "react";
import { agentChat, startAgentSession } from "@/lib/api";

type Msg = { role: "user" | "agent"; text: string };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

/**
 * Compact Energy Agent sheet — primary place for small adjustments.
 * Talks to existing /v1/energy-agent/* (same FastAPI brain as desktop).
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet",
        });
        if (cancelled) return;
        const id = s.session_id || null;
        setSessionId(id);
        const intro =
          s.intro ||
          "Hi — I'm Energy Agent. Ask about fleet health, offtakers, or small setup fixes.";
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
  }, [msgs, busy]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    setErr(null);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await startAgentSession({ client: "owner-web" });
        sid = s.session_id || null;
        setSessionId(sid);
      }
      if (!sid) throw new Error("No agent session");
      const res = await agentChat(sid, t, {
        client: "owner-web",
        surface: "agent_sheet",
      });
      const reply =
        res.reply || res.message || res.content || "Done — anything else?";
      setMsgs((m) => [...m, { role: "agent", text: String(reply) }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
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
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        aria-label="Close Energy Agent"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-label="Energy Agent"
        className="relative z-10 mx-auto flex max-h-[min(72vh,560px)] w-full max-w-lg flex-col rounded-t-sheet border border-white/50 bg-white/55 shadow-sheet backdrop-blur-2xl backdrop-saturate-150"
        style={{
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          WebkitBackdropFilter: "blur(28px) saturate(1.45)",
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/40 px-4 pb-3 pt-4">
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
              Small adjustments · fleet & offtakers
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
            <div
              key={i}
              className={[
                "max-w-[92%] rounded-2xl px-3 py-2.5 text-[13.5px] leading-relaxed",
                m.role === "user"
                  ? "ml-auto bg-sky-500 text-white shadow-md shadow-sky-500/25"
                  : "border border-white/50 bg-white/55 text-ink backdrop-blur-md",
              ].join(" ")}
            >
              {m.text}
            </div>
          ))}
          {busy ? (
            <div className="text-xs font-semibold text-muted">Thinking…</div>
          ) : null}
          {err ? (
            <div className="rounded-xl border border-red-200/60 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700 backdrop-blur-sm">
              {err}
            </div>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="border-t border-white/40 px-3 pt-2">
          <div className="flex gap-2 rounded-2xl border border-white/50 bg-white/45 p-1.5 backdrop-blur-md">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask or adjust something…"
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none placeholder:text-slate-500"
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
