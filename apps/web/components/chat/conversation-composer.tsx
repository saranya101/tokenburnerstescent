"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../ui/icon";
import { suggestions } from "./demo-data";
import { VoiceInputController, type SpeechTranscript } from "../../lib/speech-recognition";

export type ComposerInput = { inputMode: "VOICE"; voice: SpeechTranscript } | { inputMode: "TYPED" };

export function ConversationComposer({ initialValue = "", compact = false, onSubmit, voiceController: providedVoiceController }: { initialValue?: string; compact?: boolean; onSubmit(message: string, input: ComposerInput): void; voiceController?: VoiceInputController }) {
  const [value, setValue] = useState(initialValue);
  const [voiceController] = useState(() => providedVoiceController ?? new VoiceInputController());
  const [voice, setVoice] = useState(voiceController.snapshot);
  const micButton = useRef<HTMLButtonElement>(null);
  useEffect(() => voiceController.subscribe((snapshot) => {
    setVoice(snapshot);
    if (snapshot.transcript) { setValue(snapshot.transcript.rawTranscript); requestAnimationFrame(() => micButton.current?.focus()); }
  }), [voiceController]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault(); const message = value.trim(); if (!message) return;
    onSubmit(message, voice.transcript ? { inputMode: "VOICE", voice: voice.transcript } : { inputMode: "TYPED" });
    voiceController.cancel(); setValue("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } };
  const active = voice.status === "REQUESTING_PERMISSION" || voice.status === "LISTENING" || voice.status === "PROCESSING";

  return <form className={`composer ${compact ? "composer-compact" : ""}`} onSubmit={submit}>
    <label className="sr-only" htmlFor="goal-message">Describe your financial goal</label>
    <div className="composer-field">
      <textarea id="goal-message" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} rows={compact ? 2 : 3} placeholder="Tell us what you’d like to do…" autoFocus={compact} />
      <button className="send-button" type="submit" disabled={!value.trim()} aria-label="Send message">
        <Icon name="send" />
      </button>
    </div>
    <div className="composer-voice-row">
      <button ref={micButton} className="voice-button" type="button" aria-label={active ? "Voice input active" : "Use microphone for voice input"} onClick={() => { if (voice.transcript) setValue(""); voiceController.start(); }} disabled={active}>
        <Icon name="mic" /> <span>{voice.status === "TRANSCRIPT_READY" ? "Record again" : "Voice input"}</span>
      </button>
      {voice.status === "LISTENING" && <button className="voice-action" type="button" onClick={() => voiceController.stop()}>Stop listening</button>}
      {active && <button className="voice-action" type="button" onClick={() => voiceController.cancel()}>Cancel</button>}
      <span className={`voice-status voice-status-${voice.status.toLowerCase()}`} role="status" aria-live="polite">{voiceStatusText(voice.status, voice.message)}</span>
    </div>
    {!compact && <div className="suggestion-row" aria-label="Example goals">
      {suggestions.map((suggestion) => <button key={suggestion.label} type="button" className="suggestion-chip" onClick={() => { voiceController.cancel(); setValue(suggestion.example); }}><Icon name={suggestion.label === "Send money" ? "transfer" : suggestion.label === "Pay a bill" ? "card" : suggestion.label === "Buy an investment" ? "invest" : "fx"} /><span><strong>{suggestion.label}</strong><small>{suggestion.example}</small></span></button>)}
    </div>}
    <p className="composer-hint">Press Enter to continue · Nothing moves without your approval</p>
  </form>;
}

function voiceStatusText(status: string, message?: string): string {
  if (message) return message;
  if (status === "REQUESTING_PERMISSION") return "Waiting for microphone permission…";
  if (status === "LISTENING") return "Listening… Speak your request, then stop when you're done.";
  if (status === "PROCESSING") return "Preparing your transcript…";
  if (status === "TRANSCRIPT_READY") return "Transcript ready. Review or edit it before you send.";
  return "";
}
