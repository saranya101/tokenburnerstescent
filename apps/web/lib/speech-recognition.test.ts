import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceInputController, browserSpeechRecognitionAdapter, type SpeechRecognitionHandlers, type SpeechToTextAdapter } from "./speech-recognition";

afterEach(() => vi.unstubAllGlobals());

function harness(supported = true) {
  let handlers: SpeechRecognitionHandlers | undefined;
  const stop = vi.fn(); const cancel = vi.fn();
  const adapter: SpeechToTextAdapter = { isSupported: () => supported, start: vi.fn((value) => { handlers = value; return { stop, cancel }; }) };
  const controller = new VoiceInputController(adapter); const snapshots = [controller.snapshot]; controller.subscribe((snapshot) => snapshots.push(snapshot));
  return { controller, adapter, stop, cancel, snapshots, handlers: () => handlers! };
}

describe("voice input control", () => {
  it("uses the browser's real SpeechRecognition constructor and returns its exact transcript", () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = true; interimResults = true; lang = ""; onstart: (() => void) | null = null; onresult: ((event: never) => void) | null = null; onerror = null; onend = null;
      start = vi.fn(() => this.onstart?.()); stop = vi.fn(); abort = vi.fn();
      constructor() { instances.push(this); }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition }); vi.stubGlobal("document", { documentElement: { lang: "en-SG" } }); vi.stubGlobal("navigator", { language: "en-US" });
    const result = vi.fn(); const listening = vi.fn();
    browserSpeechRecognitionAdapter.start({ onListening: listening, onResult: result, onError: vi.fn() });
    const instance = instances[0]!;
    instance.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "  Send John USD 300  " } }] } as never);
    expect(instance.start).toHaveBeenCalledOnce(); expect(listening).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ rawTranscript: "Send John USD 300", provider: "browser-web-speech" }));
  });

  it("shows an unsupported fallback and creates no speech session", () => {
    const values = harness(false); values.controller.start();
    expect(values.controller.snapshot).toEqual({ status: "UNSUPPORTED", message: "Voice input isn't available in this browser. You can still type your request." });
    expect(values.adapter.start).not.toHaveBeenCalled();
  });

  it("reports permission denial safely and submits nothing", () => {
    const values = harness(); const submit = vi.fn(); values.controller.start(); values.handlers().onError("PERMISSION_DENIED");
    expect(values.controller.snapshot).toMatchObject({ status: "PERMISSION_DENIED", message: expect.stringContaining("Microphone access is off") });
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not fabricate or submit text for an empty recognition result", () => {
    const values = harness(); const submit = vi.fn(); values.controller.start(); values.handlers().onListening(); values.handlers().onError("NO_SPEECH");
    expect(values.controller.snapshot).toMatchObject({ status: "ERROR", message: expect.stringContaining("didn't hear anything") });
    expect(values.controller.snapshot.transcript).toBeUndefined(); expect(submit).not.toHaveBeenCalled();
  });

  it("exposes a real adapter transcript for review without auto-submitting", () => {
    const values = harness(); const submit = vi.fn(); const transcript = { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" };
    values.controller.start(); expect(values.controller.snapshot.status).toBe("REQUESTING_PERMISSION");
    values.handlers().onListening(); expect(values.controller.snapshot.status).toBe("LISTENING");
    values.controller.stop(); expect(values.stop).toHaveBeenCalledOnce(); expect(values.controller.snapshot.status).toBe("PROCESSING");
    values.handlers().onResult(transcript);
    expect(values.controller.snapshot).toEqual({ status: "TRANSCRIPT_READY", transcript }); expect(submit).not.toHaveBeenCalled();
  });

  it("cancels the microphone session without creating financial authority", () => {
    const values = harness(); values.controller.start(); values.handlers().onListening(); values.controller.cancel();
    expect(values.cancel).toHaveBeenCalledOnce(); expect(values.controller.snapshot).toEqual({ status: "IDLE" });
  });
});
