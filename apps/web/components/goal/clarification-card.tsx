"use client";

import { useState, type FormEvent } from "react";
import type { Clarification, ClarificationOption } from "../../lib/parlance-api";
import { formatMoney } from "../../lib/customer-presentation";
import { clarificationCopy } from "../../lib/customer-safety-copy";
import { Icon } from "../ui/icon";

export function ClarificationCard({ clarification, onSelect, onAnswerText, onCancel }: { clarification: Clarification; onSelect(option: ClarificationOption): void; onAnswerText?(answer: string): void; onCancel(): void }) {
  const [answer, setAnswer] = useState("");
  const accountCurrency = clarification.options.find((option) => option.entityType === "ACCOUNT")?.currency ?? /\b[A-Z]{3}\b/u.exec(clarification.originalReference)?.[0];
  const question = clarification.options.length > 1 && accountCurrency
    ? `Which ${accountCurrency} account would you like me to use for the shortfall?`
    : clarification.options.length > 1
      ? `Which ${clarification.originalReference} did you mean?`
    : clarification.options.length === 1
      ? `Did you mean “${clarification.options[0]?.displayName}”?`
      : `Please clarify “${clarification.originalReference}”`;
  const submit = (event: FormEvent) => { event.preventDefault(); const value = answer.trim(); if (value && onAnswerText) onAnswerText(value); };
  return <section className="product-card clarification-card" aria-labelledby="clarification-heading">
    <p className="eyebrow">One detail needs your attention</p>
    <h2 id="clarification-heading">{question}</h2>
    <p className="card-description">{clarificationCopy(clarification.options.length)}</p>
    {clarification.options.length > 0 ? <div className="candidate-list">{clarification.options.map((candidate) => <button type="button" className="candidate" key={`${candidate.entityType}:${candidate.entityId}`} onClick={() => onSelect(candidate)}>
      <span className="avatar" aria-hidden="true">{candidate.displayName.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
      <span className="candidate-copy"><strong>{candidate.displayName}</strong><span>{candidate.currency && candidate.availableMinorUnits ? formatMoney({ currency: candidate.currency, minorUnits: candidate.availableMinorUnits }) : candidate.entityType === "BENEFICIARY" ? "Saved beneficiary" : "Available account"}</span></span>
      <span className="candidate-arrow"><Icon name="arrow" /></span>
    </button>)}</div> : null}
    {onAnswerText && <form className="clarification-answer" onSubmit={submit}><label htmlFor="clarification-answer">Or type the name you use for it</label><div><input id="clarification-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="For example, DBS Multiplier Account" /><button type="submit" className="button secondary" disabled={!answer.trim()}>Continue</button></div></form>}
    <button type="button" className="text-button" onClick={onCancel}>Start over</button>
  </section>;
}
