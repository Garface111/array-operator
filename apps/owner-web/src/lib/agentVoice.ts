/**
 * Energy Agent verbal interface — GPT Realtime over WebRTC.
 * Same server path as desktop energy-agent.js:
 *   POST /v1/energy-agent/realtime-call  (SDP offer → SDP answer)
 * Mic + speaker; user transcripts call into app chat for tool-using mind.
 *
 * Browser rules (Chrome / Safari / mobile):
 *  - getUserMedia ONLY works after a user gesture (mic button tap).
 *  - First time: OS/browser permission prompt. Deny → site must re-allow in settings.
 *  - Mute mic while agent speaks so speaker bleed doesn't trip VAD / cut speech.
 */
import { apiUrl } from "./base";
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

function micErrorMessage(err: unknown): string {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: string }).name || "")
      : "";
  const msg =
    err instanceof Error ? err.message : String(err || "Microphone error");
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return (
      "Microphone is blocked for this site. Tap the lock / site settings in " +
      "your browser → Microphone → Allow, then tap the mic again. " +
      "You can still type."
    );
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Microphone is busy (another app may be using it). Close that app and try again.";
  }
  if (/getUserMedia|mediaDevices|Permission/i.test(msg)) {
    return msg + " — allow microphone when the browser asks, then tap mic again.";
  }
  return msg;
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
  /** Hold mic muted through greeting (desktop parity — stops speaker barge-in). */
  private holdMicMuted = false;

  setHandlers(h: VoiceHandlers) {
    this.handlers = h;
  }

  isActive() {
    return this.active;
  }

  /** Live mic stream currently held (permission already granted). */
  hasLiveMic(): boolean {
    return !!this.mic?.getTracks().some((t) => t.readyState === "live");
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

  private setMicEnabled(on: boolean) {
    if (!this.mic) return;
    try {
      this.mic.getTracks().forEach((t) => {
        t.enabled = on;
      });
    } catch {
      /* ignore */
    }
  }

  private wireMicTrackEnded() {
    if (!this.mic) return;
    this.mic.getTracks().forEach((t) => {
      t.onended = () => {
        if (!this.active) return;
        this.handlers.onError?.(
          "Microphone stopped (permission revoked or device unplugged). Tap the mic to reconnect."
        );
        this.setStatus("error", "Mic stopped");
        this.stop(true);
      };
    });
  }

  /**
   * Request mic. MUST be called from a click/tap handler (user gesture).
   * Chrome will show the Allow/Block dialog on first use.
   */
  async ensureMic(): Promise<MediaStream> {
    if (this.mic) {
      const live = this.mic.getTracks().some((t) => t.readyState === "live");
      if (live) {
        if (!this.holdMicMuted && !this.speaking) {
          this.setMicEnabled(true);
        }
        return this.mic;
      }
      // Dead tracks — drop and re-prompt
      try {
        this.mic.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      this.mic = null;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser cannot access the microphone. Try Chrome or Safari on HTTPS."
      );
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      throw new Error(micErrorMessage(e));
    }
    this.wireMicTrackEnded();
    return this.mic;
  }

  async start(): Promise<void> {
    if (this.active && this.pc) {
      this.holdMicMuted = false;
      this.setMicEnabled(true);
      this.setStatus("listening");
      return;
    }

    const g = ++this.gen;
    this.setStatus("connecting", "Allow mic if asked…");

    // 1) Mic FIRST while the tap is still a valid user gesture (Chrome drops
    //    getUserMedia if we await network/session first).
    let stream: MediaStream;
    try {
      stream = await this.ensureMic();
    } catch (e) {
      this.setStatus("error");
      throw e;
    }
    if (this.stale(g)) throw new Error("cancelled");

    const token = getSession();
    if (!token) {
      throw new Error("Sign in to use voice.");
    }

    this.setStatus("connecting", "Connecting voice…");
    this.teardownPeer(false);

    // Prefer default ICE; OpenAI answer carries remote candidates.
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc = pc;

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected") {
        if (!this.active) return;
        this.handlers.onError?.(
          "Voice connection dropped. Tap the mic to reconnect."
        );
        this.setStatus("error", "Connection dropped");
        this.stop(false);
      }
    };

    if (!this.audioEl) {
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.setAttribute("playsinline", "true");
      // iOS: help audio play after gesture
      this.audioEl.setAttribute("webkit-playsinline", "true");
      (this.audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline =
        true;
      this.audioEl.style.cssText =
        "position:fixed;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(this.audioEl);
    }

    // Unlock audio pipeline on the same user gesture chain
    try {
      this.audioEl.muted = false;
      void this.audioEl.play().catch(() => undefined);
    } catch {
      /* ignore */
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
      // VAD slightly more sensitive than desktop default on phones (closer mic,
      // more hand noise). create_response false = app chat is the brain.
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
                threshold: 0.65,
                prefix_padding_ms: 300,
                silence_duration_ms: 1100,
                create_response: false,
                interrupt_response: false,
              },
            },
          },
        },
      });
      // Greeting: mute mic while agent speaks so speaker bleed cannot barge-in
      // and cut the intro or fire a false user transcript (desktop parity).
      setTimeout(() => {
        if (this.stale(g) || !this.active) return;
        this.holdMicMuted = true;
        this.setMicEnabled(false);
        this.speak(
          "Hi, Energy Agent here. I'm listening whenever you're ready.",
          { isGreeting: true }
        );
      }, 400);
    });

    const offer = await pc.createOffer();
    if (this.stale(g)) {
      pc.close();
      throw new Error("cancelled");
    }
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(apiUrl("/v1/energy-agent/realtime-call"), {
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
    // Stay "connecting" until greeting finishes or session is up without greet
    this.setStatus("listening", "Listening…");
  }

  private handleEvent(ev: {
    type?: string;
    transcript?: string;
    [k: string]: unknown;
  }) {
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
      // Mute mic while agent talks — phone speaker → mic feedback cuts speech
      this.setMicEnabled(false);
      this.setStatus("speaking");
    }

    if (
      ev.type === "output_audio_buffer.stopped" ||
      ev.type === "response.done" ||
      ev.type === "response.cancelled"
    ) {
      this.speaking = false;
      this.holdMicMuted = false;
      if (this.active) {
        this.setMicEnabled(true);
        this.setStatus("listening");
      }
    }

    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      const text = String(ev.transcript || "").trim();
      if (text && this.active) {
        this.handlers.onUserTranscript?.(text);
      }
    }

    if (
      ev.type === "response.audio_transcript.done" ||
      ev.type === "response.output_audio_transcript.done"
    ) {
      const text = String(
        (ev as { transcript?: string }).transcript || ""
      ).trim();
      if (text) this.handlers.onAgentTranscript?.(text);
    }

    if (ev.type === "error") {
      const msg = String(
        (ev as { error?: { message?: string } }).error?.message ||
          (ev as { message?: string }).message ||
          "Voice error"
      );
      // Benign cancel noise
      if (/cancel|nothing to cancel|no active/i.test(msg)) return;
      this.handlers.onError?.(msg);
    }
  }

  /** Speak text via Realtime mouth (response.create). */
  speak(text: string, opts?: { isGreeting?: boolean }) {
    const plain = stripMd(text);
    if (!plain || !this.dc || this.dc.readyState !== "open") return;

    const send = () => {
      try {
        if (this.speaking) {
          this.dcSend({ type: "response.cancel" });
        }
        // Hold mic muted while we talk
        this.setMicEnabled(false);
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
        if (opts?.isGreeting) this.holdMicMuted = true;
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
    this.holdMicMuted = false;
    if (this.active) {
      this.setMicEnabled(true);
      this.setStatus("listening");
    }
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
    this.holdMicMuted = false;
    if (stopMic && this.mic) {
      try {
        this.mic.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      this.mic = null;
    } else if (this.mic) {
      // Keep permission; mute tracks until next start
      this.setMicEnabled(false);
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
