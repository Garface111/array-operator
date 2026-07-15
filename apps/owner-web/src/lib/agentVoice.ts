/**
 * Energy Agent verbal interface — GPT Realtime over WebRTC.
 * Same server path as desktop energy-agent.js:
 *   POST /v1/energy-agent/realtime-call  (SDP offer → SDP answer)
 * Mic + speaker; user transcripts call into app chat for tool-using mind.
 */
import { getSession } from "./session";

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type VoiceHandlers = {
  onStatus?: (s: VoiceStatus, detail?: string) => void;
  onUserTranscript?: (text: string) => void;
  onAgentTranscript?: (text: string) => void;
  onError?: (message: string) => void;
};

function stripMd(s: string): string {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class AgentVoice {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private gen = 0;
  private handlers: VoiceHandlers = {};
  private speaking = false;
  private active = false;
  private sessionReady = false;
  private pendingSpeak: (() => void) | null = null;

  setHandlers(h: VoiceHandlers) {
    this.handlers = h;
  }

  isActive() {
    return this.active;
  }

  private setStatus(s: VoiceStatus, detail?: string) {
    this.handlers.onStatus?.(s, detail);
  }

  private stale(g: number) {
    return g !== this.gen;
  }

  private dcSend(obj: unknown) {
    if (this.dc && this.dc.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  async ensureMic(): Promise<MediaStream> {
    if (this.mic) {
      const live = this.mic.getTracks().some((t) => t.readyState === "live");
      if (live) {
        this.mic.getTracks().forEach((t) => {
          t.enabled = true;
        });
        return this.mic;
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access the microphone.");
    }
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return this.mic;
  }

  async start(): Promise<void> {
    if (this.active && this.pc) {
      this.mic?.getTracks().forEach((t) => {
        t.enabled = true;
      });
      this.setStatus("listening");
      return;
    }

    const g = ++this.gen;
    this.setStatus("connecting", "Connecting voice…");

    const token = getSession();
    if (!token) throw new Error("Sign in to use voice.");

    const stream = await this.ensureMic();
    if (this.stale(g)) throw new Error("cancelled");

    this.teardownPeer(false);

    const pc = new RTCPeerConnection();
    this.pc = pc;

    if (!this.audioEl) {
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.setAttribute("playsinline", "true");
      this.audioEl.style.cssText =
        "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(this.audioEl);
    }

    pc.ontrack = (e) => {
      if (!this.audioEl) return;
      this.audioEl.srcObject = e.streams[0];
      void this.audioEl.play().catch(() => undefined);
    };

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;

    dc.addEventListener("message", (e) => {
      try {
        this.handleEvent(JSON.parse(String(e.data)));
      } catch {
        /* ignore */
      }
    });

    dc.addEventListener("open", () => {
      this.sessionReady = false;
      this.dcSend({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are Energy Agent's MOUTH only. Only speak lines the app sends " +
            "via response.create. Do not invent answers. Speak completely from " +
            "the first word. Never speak over yourself.",
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.78,
                prefix_padding_ms: 320,
                silence_duration_ms: 1400,
                create_response: false,
                interrupt_response: false,
              },
            },
          },
        },
      });
      // Short greeting once voice is up
      setTimeout(() => {
        if (this.stale(g) || !this.active) return;
        this.speak(
          "Hi, Energy Agent here. I'm listening whenever you're ready."
        );
      }, 400);
    });

    const offer = await pc.createOffer();
    if (this.stale(g)) {
      pc.close();
      throw new Error("cancelled");
    }
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch("/v1/energy-agent/realtime-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp || "",
    });

    if (this.stale(g)) {
      pc.close();
      throw new Error("cancelled");
    }

    if (!sdpRes.ok) {
      let detail = await sdpRes.text();
      try {
        const j = JSON.parse(detail);
        detail =
          typeof j.detail === "string"
            ? j.detail
            : j.detail?.error || detail;
      } catch {
        /* keep text */
      }
      if (sdpRes.status === 402) {
        throw new Error(
          "Weekly Energy Agent limit reached. Voice pauses until next week."
        );
      }
      if (sdpRes.status === 503) {
        throw new Error(
          "Voice not configured on the server yet. Text chat still works."
        );
      }
      throw new Error(detail || `Voice connect failed (${sdpRes.status})`);
    }

    const answerSdp = await sdpRes.text();
    if (pc.signalingState === "closed" || this.stale(g)) {
      throw new Error("cancelled");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    this.active = true;
    this.setStatus("listening");
  }

  private handleEvent(ev: { type?: string; transcript?: string; [k: string]: unknown }) {
    if (!ev?.type) return;

    if (ev.type === "session.updated" || ev.type === "session.created") {
      this.sessionReady = true;
      if (this.pendingSpeak) {
        const fn = this.pendingSpeak;
        this.pendingSpeak = null;
        fn();
      }
    }

    if (
      ev.type === "output_audio_buffer.started" ||
      ev.type === "response.output_audio.delta"
    ) {
      this.speaking = true;
      this.setStatus("speaking");
    }

    if (
      ev.type === "output_audio_buffer.stopped" ||
      ev.type === "response.done" ||
      ev.type === "response.cancelled"
    ) {
      this.speaking = false;
      if (this.active) this.setStatus("listening");
    }

    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      const text = String(ev.transcript || "").trim();
      if (text && this.active) {
        this.handlers.onUserTranscript?.(text);
      }
    }

    if (ev.type === "response.audio_transcript.done" || ev.type === "response.output_audio_transcript.done") {
      const text = String(
        (ev as { transcript?: string }).transcript || ""
      ).trim();
      if (text) this.handlers.onAgentTranscript?.(text);
    }

    if (ev.type === "error") {
      const msg =
        String(
          (ev as { error?: { message?: string } }).error?.message ||
            (ev as { message?: string }).message ||
            "Voice error"
        );
      this.handlers.onError?.(msg);
    }
  }

  /** Speak text via Realtime mouth (response.create). */
  speak(text: string) {
    const plain = stripMd(text);
    if (!plain || !this.dc || this.dc.readyState !== "open") return;

    const send = () => {
      try {
        // Cancel any in-flight speech so we don't stack
        if (this.speaking) {
          this.dcSend({ type: "response.cancel" });
        }
        this.dcSend({
          type: "response.create",
          response: {
            instructions:
              "Read the following aloud VERBATIM in natural English, starting from " +
              "the FIRST word and continuing until the LAST word. " +
              "Do not skip, summarize, or add greetings:\n\n" +
              plain,
          },
        });
        this.speaking = true;
        this.setStatus("speaking");
      } catch {
        /* ignore */
      }
    };

    if (!this.sessionReady) {
      this.pendingSpeak = send;
      setTimeout(() => {
        if (this.pendingSpeak) {
          const fn = this.pendingSpeak;
          this.pendingSpeak = null;
          fn();
        }
      }, 1200);
    } else {
      send();
    }
  }

  stopSpeaking() {
    this.dcSend({ type: "response.cancel" });
    this.speaking = false;
    if (this.active) this.setStatus("listening");
  }

  private teardownPeer(stopMic: boolean) {
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.sessionReady = false;
    this.pendingSpeak = null;
    this.speaking = false;
    if (stopMic && this.mic) {
      try {
        this.mic.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      this.mic = null;
    } else if (this.mic) {
      try {
        this.mic.getTracks().forEach((t) => {
          t.enabled = false;
        });
      } catch {
        /* ignore */
      }
    }
  }

  stop(full = false) {
    this.gen += 1;
    this.active = false;
    this.teardownPeer(full);
    this.setStatus("idle");
  }
}

export const agentVoice = new AgentVoice();
