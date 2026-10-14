"use client";

import { useState, type FormEvent } from "react";
import type { BankStateSnapshotV1 } from "@parlance/contracts";
import type { Clarification, ClarificationOption } from "../../lib/parlance-api";
import { formatMoney } from "../../lib/customer-presentation";
import { clarificationCopy } from "../../lib/customer-safety-copy";
import { Icon } from "../ui/icon";

type Beneficiary = BankStateSnapshotV1["beneficiaries"][number];

export function ClarificationCard({ clarification, beneficiaries = [], busy = false, error, onSelect, onAnswerText, onCancel }: { clarification: Clarification; beneficiaries?: readonly Beneficiary[]; busy?: boolean; error?: string; onSelect(option: ClarificationOption): void; onAnswerText?(answer: string): void; onCancel(): void }) {
  const [answer, setAnswer] = useState("");
  const isAsset = clarification.field.includes("assetReference") || clarification.options.some((option) => option.entityType === "ASSET");
  const isBeneficiary = clarification.field.includes("recipientReference") || clarification.options.some((option) => option.entityType === "BENEFICIARY");
  const isTransferAmount = clarification.questionKey === "clarify.transfer.amount";
  const isTransferCurrency = clarification.questionKey === "clarify.transfer.currency";
  const isTransferRecipient = clarification.questionKey === "clarify.transfer.recipient";
  const accountCurrency = clarification.options.find((option) => option.entityType === "ACCOUNT")?.currency ?? /\b[A-Z]{3}\b/u.exec(clarification.originalReference)?.[0];
  const question = isTransferAmount
    ? "How much would you like to send, and in which currency?"
    : isTransferCurrency
      ? clarification.options.length === 2
        ? `Do you mean ${clarification.options[0]?.displayName} or ${clarification.options[1]?.displayName} for the ${clarification.originalReference}?`
        : "Which currency should I use for this transfer?"
    : isTransferRecipient
      ? "Who would you like to send money to?"
    : clarification.options.length > 1 && accountCurrency
    ? `Which ${accountCurrency} account would you like me to use for the shortfall?`
    : clarification.options.length > 1 && isBeneficiary
      ? `Which ${clarification.originalReference} would you like to pay?`
    : clarification.options.length > 1
      ? `Which ${clarification.originalReference} did you mean?`
    : clarification.options.length === 1
      ? `Did you mean “${clarification.options[0]?.displayName}”?`
      : `Please clarify “${clarification.originalReference}”`;
  const submit = (event: FormEvent) => { event.preventDefault(); const value = answer.trim(); if (!busy && value && onAnswerText) onAnswerText(value); };
  return <section className="product-card clarification-card" aria-labelledby="clarification-heading">
    <p className="eyebrow">One detail needs your attention</p>
    <h2 id="clarification-heading">{question}</h2>
    <p className="card-description">{isTransferAmount
      ? clarification.reason === "INVALID_FIELD" ? "Enter a positive amount together with SGD or USD. No amount will be assumed." : "Include the amount and currency so I can preserve the exact transfer you intend."
      : isTransferCurrency
        ? clarification.reason === "INVALID_FIELD" ? "Enter SGD or USD. No currency will be assumed." : "The amount is saved, but I still need the currency before I can continue."
      : isTransferRecipient
        ? "Enter the name of a saved payee. I’ll check it against your beneficiaries before continuing."
      : isBeneficiary && clarification.options.length > 1 ? `We found more than one saved payee matching ${clarification.originalReference}. Choose the correct recipient to continue.` : clarificationCopy(clarification.options.length)}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {clarification.options.length > 0 ? <div className="candidate-list">{clarification.options.map((candidate) => <button type="button" className="candidate" key={`${candidate.entityType}:${candidate.entityId}`} disabled={busy} onClick={() => onSelect(candidate)}>
      <span className="avatar" aria-hidden="true">{candidate.displayName.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
      <span className="candidate-copy"><strong>{candidate.displayName}</strong><span>{candidateDetail(candidate, beneficiaries)}</span></span>
      <span className="candidate-arrow"><Icon name="arrow" /></span>
    </button>)}</div> : null}
    {onAnswerText && <form className="clarification-answer" onSubmit={submit}><label htmlFor="clarification-answer">{isTransferAmount ? "Amount and currency" : isTransferCurrency ? "Transfer currency" : isAsset ? "Enter a company name or ticker" : isBeneficiary ? "Enter a saved payee name" : "Or type the name you use for it"}</label><div><input id="clarification-answer" value={answer} disabled={busy} onChange={(event) => setAnswer(event.target.value)} placeholder={isTransferAmount ? "For example, S$500 or USD 500" : isTransferCurrency ? "Enter SGD or USD" : isAsset ? "Enter a company name or ticker, e.g. AAPL" : isBeneficiary ? "For example, John Tan" : "For example, DBS Multiplier Account"} /><button type="submit" className="button secondary" disabled={busy || !answer.trim()}>{busy ? "Checking…" : "Continue"}</button></div></form>}
    <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Start over</button>
  </section>;
}

function candidateDetail(candidate: ClarificationOption, beneficiaries: readonly Beneficiary[]): string {
  if (candidate.entityType === "CURRENCY") return "Choose this exact transfer currency";
  if (candidate.currency && candidate.availableMinorUnits) return formatMoney({ currency: candidate.currency, minorUnits: candidate.availableMinorUnits });
  if (candidate.entityType === "BENEFICIARY") {
    const beneficiary = beneficiaries.find((item) => item.id === candidate.entityId);
    return beneficiary?.supportedCurrencies.length ? `Saved payee · ${beneficiary.supportedCurrencies.join(", ")} transfers` : "Saved payee";
  }
  return candidate.entityType === "ASSET" ? "Supported investment" : "Available account";
}
