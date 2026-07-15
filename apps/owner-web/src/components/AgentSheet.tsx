import { FormEvent, useEffect, useRef, useState } from "react";
import { agentChat, agentConfirm, startAgentSession } from "@/lib/api";
import type { AgentPending } from "@/lib/types";

type Msg = { role: "user" | "agent"; text: string };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

function pendingSummary(p: AgentPending): string {
  const args = p.args || {};
  const reason = String(args.reason || p.message || "").trim();
  if (reason) return reason;
  const body = (args.body || {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (p.type === "api_patch" && keys.length) {
    return `Apply ${keys.map((k) => `${k}=${JSON.stringify(body[k])}`).join(", ")}`;
  }
  return `${p.type || "action"} — confirm to run`;
}

/**
 * Compact Energy Agent sheet — primary place for small adjustments.
 * Handles pending write confirms via /v1/energy-agent/confirm.
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<AgentPending | null>(null);
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
  }, [msgs, busy, pending]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy || confirming) return;
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
      const pend = res.pending && typeof res.pending === "object"
        ? (res.pending as AgentPending)
        : null;
      setPending(pend?.needs_confirm !== false && pend ? pend : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setBusy(false);
    }
  }

  async function resolvePending(yes: boolean) {
    if (!sessionId || !pending || confirming) return;
    setConfirming(true);
    setErr(null);
    try {
      const res = await agentConfirm(sessionId, yes, pending.id);
      setPending(null);
      if (yes && !res.cancelled) {
        const body = (res.command as { args?: { body?: Record<string, unknown> } })
          ?.args?.body;
        const detail = body
          ? `Updated (${Object.entries(body)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ")}).`
          : "Change applied.";
        setMsgs((m) => [
          ...m,
          { role: "agent", text: `Done — ${detail}` },
        ]);
      } else {
        setMsgs((m) => [
          ...m,
          { role: "agent", text: "Okay — cancelled that change." },
        ]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setConfirming(false);
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
        className="relative z-10 mx-auto flex max-h-[min(78vh,600px)] w-full max-w-lg flex-col rounded-t-sheet border border-white/50 bg-white/55 shadow-sheet backdrop-blur-2xl backdrop-saturate-150"
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
            <h2 className="text-sm font-extrabold tracking-tight">
              Energy Agent
            </h2>
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

          {pending ? (
            <div className="rounded-2xl border border-amber-300/70 bg-amber-50/85 p-3 shadow-sm backdrop-blur-md">
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-amber-900">
                Confirm write
              </div>
              <p className="mt-1 text-[13px] font-semibold leading-snug text-amber-950">
                {pendingSummary(pending)}
              </p>
              {pending.type ? (
                <p className="mt-1 font-mono text-[10px] text-amber-900/70">
                  {pending.type}
                  {pending.args?.path
                    ? ` · ${String(pending.args.path)}`
                    : ""}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="ao-btn-ghost !min-h-10 !text-xs"
                  disabled={confirming}
                  onClick={() => void resolvePending(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ao-btn-primary !min-h-10 !text-xs"
                  disabled={confirming}
                  onClick={() => void resolvePending(true)}
                >
                  {confirming ? "Applying…" : "Confirm"}
                </button>
              </div>
            </div>
          ) : null}

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
              placeholder={
                pending
                  ? "Or type yes / no…"
                  : "Ask or adjust something…"
              }
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none placeholder:text-slate-500"
              autoComplete="off"
              disabled={confirming}
            />
            <button
              type="submit"
              disabled={busy || confirming || !input.trim()}
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
