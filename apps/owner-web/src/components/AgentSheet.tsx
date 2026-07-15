import { FormEvent, useEffect, useRef, useState } from "react";
import { agentChat, agentConfirm, startAgentSession } from "@/lib/api";
import { agentVoice, type VoiceStatus } from "@/lib/agentVoice";
import { isDemoMode } from "@/lib/demoData";
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
    return `Apply ${keys
      .map((k) => `${k}=${JSON.stringify(body[k])}`)
      .join(", ")}`;
  }
  return `${p.type || "action"} — confirm to run`;
}

/**
 * Energy Agent sheet — text + verbal (GPT Realtime WebRTC) interface.
 */
export function AgentSheet({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<AgentPending | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setPending(null);
      agentVoice.stop(false);
      setVoice("idle");
      setVoiceDetail("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet_voice",
        });
        if (cancelled) return;
        const id = s.session_id || null;
        setSessionId(id);
        sessionRef.current = id;
        const intro =
          s.intro ||
          "Hi — I'm Energy Agent. Tap the mic to talk, or type below.";
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

  // Wire voice → chat while sheet is open
  useEffect(() => {
    if (!open) return;

    agentVoice.setHandlers({
      onStatus: (s, detail) => {
        setVoice(s);
        setVoiceDetail(detail || "");
      },
      onUserTranscript: (text) => {
        void send(text, { fromVoice: true });
      },
      onError: (message) => {
        setErr(message);
        setVoice("error");
      },
    });

    return () => {
      agentVoice.setHandlers({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !seedPrompt || !sessionId || seeded.current || busy) return;
    seeded.current = true;
    void send(seedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedPrompt, sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, busy, pending, voice]);

  // Escape closes the sheet (backdrop is full-screen but z-order can block clicks)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    agentVoice.stop(false);
    setVoice("idle");
    onClose();
  }

  async function send(
    text: string,
    opts?: { fromVoice?: boolean }
  ) {
    const t = text.trim();
    if (!t || busyRef.current || confirming) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    busyRef.current = true;
    setErr(null);
    try {
      let sid = sessionRef.current;
      if (!sid) {
        const s = await startAgentSession({
          client: "owner-web",
          surface: "agent_sheet_voice",
        });
        sid = s.session_id || null;
        setSessionId(sid);
        sessionRef.current = sid;
      }
      if (!sid) throw new Error("No agent session");
      const res = await agentChat(sid, t, {
        client: "owner-web",
        surface: opts?.fromVoice ? "voice" : "agent_sheet",
        input_mode: opts?.fromVoice ? "voice" : "text",
      });
      const reply =
        res.reply || res.message || res.content || "Done — anything else?";
      setMsgs((m) => [...m, { role: "agent", text: String(reply) }]);
      const pend =
        res.pending && typeof res.pending === "object"
          ? (res.pending as AgentPending)
          : null;
      setPending(pend?.needs_confirm !== false && pend ? pend : null);

      // Speak the reply when verbal mode is live
      if (agentVoice.isActive() && !pend) {
        agentVoice.speak(String(reply));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  async function toggleVoice() {
    if (isDemoMode()) {
      setErr("Sign in for live voice — demo is text only.");
      return;
    }
    if (agentVoice.isActive() || voice === "connecting") {
      agentVoice.stop(false);
      setVoice("idle");
      setVoiceDetail("");
      return;
    }
    try {
      setErr(null);
      setVoice("connecting");
      await agentVoice.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start voice";
      if (msg !== "cancelled") {
        setErr(msg);
        setVoice("error");
      } else {
        setVoice("idle");
      }
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
        const body = (
          res.command as { args?: { body?: Record<string, unknown> } }
        )?.args?.body;
        const detail = body
          ? `Updated (${Object.entries(body)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ")}).`
          : "Change applied.";
        const line = `Done — ${detail}`;
        setMsgs((m) => [...m, { role: "agent", text: line }]);
        if (agentVoice.isActive()) agentVoice.speak(line);
      } else {
        const line = "Okay — cancelled that change.";
        setMsgs((m) => [...m, { role: "agent", text: line }]);
        if (agentVoice.isActive()) agentVoice.speak(line);
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

  const voiceLive =
    voice === "listening" ||
    voice === "speaking" ||
    voice === "connecting";

  const statusLabel =
    voice === "connecting"
      ? voiceDetail || "Connecting voice…"
      : voice === "listening"
        ? "Listening…"
        : voice === "speaking"
          ? "Speaking…"
          : voice === "error"
            ? "Voice error"
            : busy
              ? "Thinking…"
              : "Type or tap mic";

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        aria-label="Close Energy Agent"
        onClick={handleClose}
      />
      <section
        role="dialog"
        aria-label="Energy Agent"
        className="relative z-10 mx-auto flex max-h-[min(82vh,640px)] w-full max-w-lg flex-col rounded-t-sheet border border-white/50 bg-white/55 shadow-sheet backdrop-blur-2xl backdrop-saturate-150"
        style={{
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          WebkitBackdropFilter: "blur(28px) saturate(1.45)",
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/40 px-4 pb-3 pt-4">
          <div
            className={[
              "h-9 w-9 shrink-0 rounded-full shadow-md ring-2 transition",
              voice === "listening"
                ? "ring-emerald-400/80 animate-pulse"
                : voice === "speaking"
                  ? "ring-sky-400/80"
                  : "ring-white/50",
            ].join(" ")}
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
            <p className="truncate text-xs font-semibold text-muted">
              {statusLabel}
            </p>
          </div>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-xl text-xl text-muted"
            onClick={handleClose}
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
              {voiceLive ? (
                <p className="mt-2 text-[10px] font-semibold text-amber-900/80">
                  Or say “yes” / “no”
                </p>
              ) : null}
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

        <form
          onSubmit={onSubmit}
          className="border-t border-white/40 px-3 pt-2"
        >
          <div className="flex items-center gap-2 rounded-2xl border border-white/50 bg-white/45 p-1.5 backdrop-blur-md">
            {/* Mic — user gesture starts WebRTC */}
            <button
              type="button"
              onClick={() => void toggleVoice()}
              aria-label={
                voiceLive ? "Stop listening" : "Start voice with Energy Agent"
              }
              aria-pressed={voiceLive}
              className={[
                "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-lg transition active:scale-95",
                voice === "listening"
                  ? "bg-emerald-500 text-white shadow-md shadow-emerald-500/30"
                  : voice === "speaking"
                    ? "bg-sky-500 text-white shadow-md shadow-sky-500/30"
                    : voice === "connecting"
                      ? "bg-amber-400 text-white"
                      : "bg-white/70 text-slate-700 ring-1 ring-white/60",
              ].join(" ")}
            >
              {voice === "connecting" ? "…" : voiceLive ? "◉" : "🎤"}
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                voiceLive
                  ? "Listening — or type…"
                  : pending
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
          <p className="mt-1.5 px-1 text-center text-[10px] font-semibold text-muted">
            {voiceLive
              ? "Verbal mode on · same Energy Agent brain as desktop"
              : "Tap mic for voice · text always works"}
          </p>
        </form>
      </section>
    </div>
  );
}
