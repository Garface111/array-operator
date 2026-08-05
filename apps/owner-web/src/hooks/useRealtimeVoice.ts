import { useCallback, useEffect, useRef, useState } from "react";
import { apiOrigin } from "@/lib/api";
import { getSession } from "@/lib/session";

/**
 * GPT Realtime voice for the phone site — the SAME system the desktop runs
 * (public/energy-agent.js). WebRTC to OpenAI via our own server
 * (POST /v1/energy-agent/realtime-call proxies the SDP, so the key never
 * reaches the client).
 *
 * ARCHITECTURE (desktop parity — do not "improve" this):
 *   Realtime is the EARS and the MOUTH. It never composes answers.
 *   The deep brain (/v1/energy-agent/chat) authors BOTH halves of a turn:
 *     d.speak  → the spoken line, sent to the mouth via response.create
 *     d.reply  → the written write-up, painted in the chat panel
 *   The app speaks `speak` and paints `reply`.
 *
 * WHY the mouth must stay shut on its own (Ford, screenshot 2026-08-04):
 *   With tools + create_response:true, Realtime answers by itself and emits
 *   filler ("I'm here and ready to help.") over and over, and its own audio
 *   transcript gets bubbled alongside the real answer — the quadruple-reply
 *   bug. Desktop guards this two ways and so do we:
 *     1. create_response:false  → Realtime never starts a turn on its own
 *     2. its audio transcript is NEVER painted into the panel
 */

export type VoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

/** Keep in sync with api/energy_agent._realtime_session_config and desktop
 *  realtimeVadConfig(). Copied verbatim — do not re-tune here. */
const VAD = {
  type: "server_vad",
  threshold: 0.85,
  prefix_padding_ms: 320,
  silence_duration_ms: 1600,
  // The app drives every reply. Realtime must not self-start.
  create_response: false,
  interrupt_response: false,
} as const;

/** Verbatim from desktop's non-weave (mouth-only) session instructions. */
const MOUTH_INSTRUCTIONS =
  "You are Energy Agent's MOUTH only, continuous cognition steers you. " +
  "Only speak lines the app sends via response.create. " +
  "Do not invent answers; the deeper mind reasons with tools and steers what you say. " +
  "Start from the first word, speak completely, never speak over yourself. " +
  "Never cut yourself off mid-sentence.";

type Options = {
  /** A finished utterance from the owner. Run it through the deep brain. */
  onUserTranscript: (text: string) => void;
  onError?: (message: string) => void;
};

export function useRealtimeVoice({ onUserTranscript, onError }: Options) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0);
  const lastSpokenRef = useRef("");

  const cbRef = useRef({ onUserTranscript, onError });
  useEffect(() => {
    cbRef.current = { onUserTranscript, onError };
  }, [onUserTranscript, onError]);

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
    lastSpokenRef.current = "";
    setStatus("idle");
  }, []);

  useEffect(() => teardown, [teardown]);

  const dcSend = useCallback((obj: unknown) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    try { dc.send(JSON.stringify(obj)); return true; } catch { return false; }
  }, []);

  const handleEvent = useCallback((ev: {
    type?: string;
    transcript?: string;
    error?: { message?: string };
  }) => {
    const t = ev?.type;
    if (!t) return;

    if (t === "conversation.item.input_audio_transcription.completed") {
      const text = String(ev.transcript || "").trim();
      if (text) cbRef.current.onUserTranscript(text);
      return;
    }
    // DELIBERATELY IGNORED: response.audio_transcript.done /
    // response.output_audio_transcript.done. The panel is authored by the deep
    // brain; bubbling the mouth's own transcript is what produced the repeated
    // "I'm here and ready to help." bubbles.
    if (t === "output_audio_buffer.started") { setStatus("speaking"); return; }
    if (t === "output_audio_buffer.stopped") { setStatus("listening"); return; }
    if (t === "error") {
      const msg = ev.error?.message || "Voice error";
      // "no active response to cancel" and friends are benign chatter.
      if (/no active response|cancellation failed|already has an active response/i.test(msg)) return;
      setError(msg);
      cbRef.current.onError?.(msg);
    }
  }, []);

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
        try { handleEvent(JSON.parse(e.data)); } catch { /* non-JSON frame */ }
      });
      dc.addEventListener("open", () => {
        dcSend({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: MOUTH_INSTRUCTIONS,
            // No tools: the brain is /chat, not this model.
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
          throw new Error("Weekly Energy Agent limit reached — voice pauses until next week.");
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

  /** Speak a line the deep brain authored (d.speak). Mirrors desktop speakNow(). */
  const speak = useCallback((text: string) => {
    const plain = String(text || "").replace(/\s+/g, " ").trim();
    if (!plain) return;
    // Dedupe identical consecutive lines (desktop enqueueSpeak does the same).
    if (plain === lastSpokenRef.current) return;
    lastSpokenRef.current = plain;
    dcSend({ type: "response.create", response: { instructions: plain } });
  }, [dcSend]);

  /** Barge-in: stop the mouth mid-sentence. */
  const cancelSpeech = useCallback(() => {
    dcSend({ type: "response.cancel" });
    dcSend({ type: "output_audio_buffer.clear" });
  }, [dcSend]);

  const setThinking = useCallback(() => setStatus("thinking"), []);

  return {
    status,
    error,
    start,
    stop: teardown,
    speak,
    cancelSpeech,
    setThinking,
    active: status !== "idle" && status !== "error",
  };
}
