"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../ui/icon";
import { suggestions } from "./demo-data";

export function ConversationComposer({ initialValue = "", compact = false, onSubmit }: { initialValue?: string; compact?: boolean; onSubmit(message: string): void }) {
  const [value, setValue] = useState(initialValue);
  const submit = (event?: FormEvent) => { event?.preventDefault(); const message = value.trim(); if (!message) return; onSubmit(message); setValue(""); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } };

  return <form className={`composer ${compact ? "composer-compact" : ""}`} onSubmit={submit}>
    <label className="sr-only" htmlFor="goal-message">Describe your financial goal</label>
    <div className="composer-field">
      <textarea id="goal-message" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} rows={compact ? 2 : 3} placeholder="Describe a financial goal in your own words…" autoFocus={compact} />
      <button className="voice-button" type="button" aria-label="Use voice input (prototype only)" title="Voice input is a prototype affordance"><Icon name="mic" /></button>
      <button className="send-button" type="submit" disabled={!value.trim()} aria-label="Send message">
        <Icon name="send" />
      </button>
    </div>
    {!compact && <div className="suggestion-row" aria-label="Example goals">
      {suggestions.map((suggestion) => <button key={suggestion} type="button" className="suggestion-chip" onClick={() => { setValue(suggestion); onSubmit(suggestion); }}>{suggestion}</button>)}
    </div>}
    <p className="composer-hint">Press Enter to continue · Shift + Enter for a new line · Voice is a prototype affordance</p>
  </form>;
}
