export type VoiceInputStatus = "IDLE" | "REQUESTING_PERMISSION" | "LISTENING" | "PROCESSING" | "TRANSCRIPT_READY" | "UNSUPPORTED" | "PERMISSION_DENIED" | "ERROR";
export type SpeechTranscript = { rawTranscript: string; provider: string; transcribedAt: string };
export type SpeechRecognitionFailure = "PERMISSION_DENIED" | "NO_SPEECH" | "TRANSCRIPTION_ERROR";
export type SpeechRecognitionHandlers = {
  onListening(): void;
  onResult(result: SpeechTranscript): void;
  onError(error: SpeechRecognitionFailure): void;
};
export type SpeechRecognitionSession = { stop(): void; cancel(): void };
export interface SpeechToTextAdapter {
  isSupported(): boolean;
  start(handlers: SpeechRecognitionHandlers): SpeechRecognitionSession;
}

type BrowserRecognitionResult = { isFinal: boolean; 0?: { transcript?: string } };
type BrowserRecognitionEvent = { resultIndex: number; results: ArrayLike<BrowserRecognitionResult> };
type BrowserRecognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onstart: (() => void) | null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type BrowserRecognitionConstructor = new () => BrowserRecognition;

function recognitionConstructor(): BrowserRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const browser = window as typeof window & { SpeechRecognition?: BrowserRecognitionConstructor; webkitSpeechRecognition?: BrowserRecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export const browserSpeechRecognitionAdapter: SpeechToTextAdapter = {
  isSupported: () => recognitionConstructor() !== undefined,
  start(handlers) {
    const Constructor = recognitionConstructor();
    if (!Constructor) throw new Error("SPEECH_RECOGNITION_UNSUPPORTED");
    const recognition = new Constructor();
    let finished = false; let cancelled = false;
    recognition.continuous = false; recognition.interimResults = false; recognition.lang = document.documentElement.lang || navigator.language || "en-US";
    recognition.onstart = () => handlers.onListening();
    recognition.onresult = (event) => {
      const parts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]; const transcript = result?.[0]?.transcript;
        if (result?.isFinal && transcript) parts.push(transcript);
      }
      const rawTranscript = parts.join(" ").trim();
      if (!rawTranscript) return;
      finished = true;
      handlers.onResult({ rawTranscript, provider: "browser-web-speech", transcribedAt: new Date().toISOString() });
    };
    recognition.onerror = (event) => {
      if (cancelled || finished) return;
      finished = true;
      handlers.onError(event.error === "not-allowed" || event.error === "service-not-allowed" ? "PERMISSION_DENIED" : event.error === "no-speech" ? "NO_SPEECH" : "TRANSCRIPTION_ERROR");
    };
    recognition.onend = () => { if (!cancelled && !finished) { finished = true; handlers.onError("NO_SPEECH"); } };
    recognition.start();
    return { stop: () => recognition.stop(), cancel: () => { cancelled = true; recognition.abort(); } };
  },
};

export type VoiceInputSnapshot = { status: VoiceInputStatus; transcript?: SpeechTranscript; message?: string };
export class VoiceInputController {
  snapshot: VoiceInputSnapshot = { status: "IDLE" };
  private session: SpeechRecognitionSession | undefined;
  private listeners = new Set<(snapshot: VoiceInputSnapshot) => void>();
  constructor(private readonly adapter: SpeechToTextAdapter = browserSpeechRecognitionAdapter) {}
  subscribe(listener: (snapshot: VoiceInputSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private update(snapshot: VoiceInputSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener(snapshot); }
  start(): void {
    if (!this.adapter.isSupported()) { this.update({ status: "UNSUPPORTED", message: "Voice input isn't available in this browser. You can still type your request." }); return; }
    this.session?.cancel(); this.update({ status: "REQUESTING_PERMISSION" });
    try {
      this.session = this.adapter.start({
        onListening: () => this.update({ status: "LISTENING" }),
        onResult: (transcript) => { this.session = undefined; this.update({ status: "TRANSCRIPT_READY", transcript }); },
        onError: (error) => { this.session = undefined; this.update(error === "PERMISSION_DENIED"
          ? { status: "PERMISSION_DENIED", message: "Microphone access is off. You can enable it in your browser settings or type your request instead." }
          : { status: "ERROR", message: error === "NO_SPEECH" ? "We didn't hear anything. Try again or type your request instead." : "We couldn't transcribe that. Try again or type your request instead." }); },
      });
    } catch { this.session = undefined; this.update({ status: "ERROR", message: "We couldn't start voice input. Try again or type your request instead." }); }
  }
  stop(): void { if (!this.session) return; this.update({ status: "PROCESSING" }); this.session.stop(); }
  cancel(): void { this.session?.cancel(); this.session = undefined; this.update({ status: "IDLE" }); }
}
