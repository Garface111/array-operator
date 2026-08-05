import { useCallback, useEffect, useRef, useState } from "react";
import { apiOrigin } from "@/lib/api";
import { getSession } from "@/lib/session";

/**
 * GPT Realtime voice for the mobile web agent — the SAME AI system the desktop
 * site runs (public/energy-agent.js). WebRTC to OpenAI via our own server:
 * POST /v1/energy-agent/realtime-call proxies the SDP so the key never reaches
 * the client.
 *
 * Desktop's "Option D" weave, ported verbatim: Realtime owns the conversation
 * and gets exactly ONE tool — consult_deep_brain — which it is instructed to
 * call on essentially every turn. That tool round-trips through the normal
 * /v1/energy-agent/chat brain (full product map, fleet tools, invoices,
 * repairs), so the voice never answers product questions from its own head.
 */

export type VoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

/** Keep in sync with api/energy_agent._realtime_session_config and the desktop
 *  realtimeVadConfig(). Copied verbatim — do not re-tune here. */
const VAD = {
  type: "server_vad",
  threshold: 0.85,
  prefix_padding_ms: 320,
  silence_duration_ms: 1600,
  create_response: true,
  interrupt_response: true,
} as const;

/** Verbatim from desktop realtimeWeaveInstructions(). */
const WEAVE_INSTRUCTIONS =
  "You are Energy Agent — live voice of Array Operator. Warm, sharp, brief like GPT Live. " +
  "CRITICAL RULE — you are NOT smart enough alone about this product. Your intelligence " +
  "comes from consult_deep_brain. DEFAULT: call consult_deep_brain EVERY turn before " +
  "answering (walkthroughs, tabs, fleet, money, how-to). " +
  "SILENCE WHILE WORKING: when you need the tool, call it immediately and stay COMPLETELY " +
  "QUIET until the tool result arrives. Do NOT say 'one second', 'thinking', 'just a moment', " +
  "'let me check', or anything else while waiting. Do NOT narrate failures or 'that didn't work' " +
  "while a tool is in flight. After the tool returns, speak spoken_answer faithfully. " +
  "Never invent UI labels, buttons, steps, kWh, or $. " +
  "ONLY answer without the tool for pure social: hi, thanks, ok, mm-hmm, are you there, bye. " +
  "Never narrate tool names. Be one person.";

/** Verbatim from desktop realtimeWeaveTools(). */
const WEAVE_TOOLS = [
  {
    type: "function",
    name: "consult_deep_brain",
    description:
      "DEFAULT TOOL — call this on almost every turn. It is your smart brain for THIS " +
      "tenant: full product map, fleet tools, invoices, repairs, screen tours/navigation. " +
      "ALWAYS call for: walkthroughs, tabs (Analysis/Invoices/Inverters/etc), fleet health, " +
      "kWh/$, offtakers, repairs, how something works, what to do next, confirmations. " +
      "ONLY skip for pure social (hi/thanks/mm-hmm/are you there).",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What to investigate or do, in clear English. Include the owner's " +
            "exact ask and any tab/site names. For UI tours, say e.g. " +
            "'Walk the owner through the Analysis tab step by step using product_map.'",
        },
        reason: {
          type: "string",
          description: "Why (e.g. ui_tour, fleet_health, money, product_how).",
        },
      },
      required: ["question"],
    },
  },
];

type Options = {
  /** Final transcript of what the owner said (painted into the thread). */
  onUserTranscript?: (text: string) => void;
  /** consult_deep_brain — run the question through the real /chat brain and
   *  return the spoken answer. Realtime stays silent until this resolves. */
  onConsult: (question: string) => Promise<string>;
  /** What the voice actually said (painted into the thread). */
  onAgentTranscript?: (text: string) => void;
  onError?: (message: string) => void;
};

export function useRealtimeVoice({
  onUserTranscript,
  onConsult,
  onAgentTranscript,
  onError,
}: Options) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0);

  const cbRef = useRef({ onUserTranscript, onConsult, onAgentTranscript, onError });
  useEffect(() => {
    cbRef.current = { onUserTranscript, onConsult, onAgentTranscript, onError };
  }, [onUserTranscript, onConsult, onAgentTranscript, onError]);

  const teardown = useCallback(() => {
    genRef.current += 1;
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    try { micRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    micRef.current = null;
    if (audioRef.current) {
      try { audioRef.current.srcObject = null; } catch { /* noop */ }
    }
    setStatus("idle");
  }, []);

  useEffect(() => teardown, [teardown]);

  const dcSend = useCallback((obj: unknown) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    try { dc.send(JSON.stringify(obj)); } catch { /* channel closed */ }
  }, []);

  /** Mirrors desktop sendFunctionCallOutput(): hand the brain's answer back to
   *  Realtime, then let it speak. */
  const sendToolOutput = useCallback((callId: string, output: unknown) => {
    const out = typeof output === "string" ? output : JSON.stringify(output ?? {});
    dcSend({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: out.slice(0, 8000) },
    });
    dcSend({ type: "response.create" });
  }, [dcSend]);

  const handleEvent = useCallback(async (ev: {
    type?: string;
    transcript?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    error?: { message?: string };
  }) => {
    const t = ev?.type;
    if (!t) return;

    if (t === "conversation.item.input_audio_transcription.completed") {
      const text = String(ev.transcript || "").trim();
      if (text) cbRef.current.onUserTranscript?.(text);
      return;
    }
    if (t === "response.audio_transcript.done" || t === "response.output_audio_transcript.done") {
      const text = String(ev.transcript || "").trim();
      if (text) cbRef.current.onAgentTranscript?.(text);
      return;
    }
    if (t === "output_audio_buffer.started") { setStatus("speaking"); return; }
    if (t === "output_audio_buffer.stopped") { setStatus("listening"); return; }

    // The weave: Realtime asks our real brain, stays quiet until we answer.
    if (t === "response.function_call_arguments.done") {
      const nm = String(ev.name || "").toLowerCase();
      const callId = String(ev.call_id || "");
      if (!callId) return;
      if (nm !== "consult_deep_brain" && nm !== "consult_brain" && nm !== "deep_brain") {
        sendToolOutput(callId, { ok: false, spoken_answer: "" });
        return;
      }
      let question = "";
      try {
        const args = JSON.parse(ev.arguments || "{}") || {};
        question = args.question || args.query || args.message || "";
      } catch {
        question = String(ev.arguments || "");
      }
      setStatus("thinking");
      try {
        const answer = await cbRef.current.onConsult(question);
        sendToolOutput(callId, { ok: true, spoken_answer: String(answer || "") });
      } catch (e) {
        sendToolOutput(callId, {
          ok: false,
          spoken_answer: "Sorry — try that once more?",
          panel_text: String((e as Error)?.message || e || "error").slice(0, 200),
        });
      }
      return;
    }

    if (t === "error") {
      const msg = ev.error?.message || "Voice error";
      setError(msg);
      cbRef.current.onError?.(msg);
    }
  }, [sendToolOutput]);

  const start = useCallback(async () => {
    if (pcRef.current) return;
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;

    setError(null);
    setStatus("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser can't access the microphone.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (stale()) { stream.getTracks().forEach((t) => t.stop()); return; }
      micRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      if (!audioRef.current) {
        const el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("playsinline", "true");
        el.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
        document.body.appendChild(el);
        audioRef.current = el;
      }
      pc.ontrack = (e) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = e.streams[0];
        void audioRef.current.play().catch(() => { /* autoplay guard */ });
      };
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (e) => {
        try { void handleEvent(JSON.parse(e.data)); } catch { /* non-JSON frame */ }
      });
      dc.addEventListener("open", () => {
        dcSend({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: WEAVE_INSTRUCTIONS,
            tools: WEAVE_TOOLS,
            tool_choice: "required",
            audio: {
              input: {
                transcription: { model: "gpt-4o-mini-transcribe" },
                noise_reduction: { type: "near_field" },
                turn_detection: VAD,
              },
            },
          },
        });
      });

      const offer = await pc.createOffer();
      if (stale() || pcRef.current !== pc) { try { pc.close(); } catch { /* noop */ } return; }
      await pc.setLocalDescription(offer);
      if (stale() || pcRef.current !== pc) { try { pc.close(); } catch { /* noop */ } return; }

      const token = getSession();
      const res = await fetch(`${apiOrigin()}/v1/energy-agent/realtime-call`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (stale() || pcRef.current !== pc) { try { pc.close(); } catch { /* noop */ } return; }

      if (!res.ok) {
        const raw = await res.text();
        let detail: string = raw;
        try {
          const parsed = JSON.parse(raw);
          detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail ?? raw);
        } catch { /* plain text */ }
        if (res.status === 402) {
          throw new Error(
            "Weekly Energy Agent limit reached — voice pauses until next week (or the cap is raised)."
          );
        }
        if (/insufficient_quota|billing|credit|rate.?limit|exceeded/i.test(detail)) {
          throw new Error("The voice provider rejected the call (OpenAI billing/quota).");
        }
        throw new Error(detail || "Could not start voice");
      }

      const answer = await res.text();
      if (stale() || pcRef.current !== pc || pc.signalingState === "closed") {
        try { pc.close(); } catch { /* noop */ }
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (stale()) return;
      setStatus("listening");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start voice";
      setError(msg);
      cbRef.current.onError?.(msg);
      setStatus("error");
      teardown();
    }
  }, [handleEvent, dcSend, teardown]);

  return {
    status,
    error,
    start,
    stop: teardown,
    active: status !== "idle" && status !== "error",
  };
}
