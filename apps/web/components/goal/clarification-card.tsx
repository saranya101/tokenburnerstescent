import type { Clarification, ClarificationOption } from "../../lib/parlance-api";
import { clarificationCopy } from "../../lib/customer-safety-copy";
import { Icon } from "../ui/icon";

export function ClarificationCard({ clarification, onSelect, onCancel }: { clarification: Clarification; onSelect(option: ClarificationOption): void; onCancel(): void }) {
  const question = clarification.options.length > 1
    ? `Which ${clarification.originalReference} did you mean?`
    : clarification.options.length === 1
      ? `Did you mean “${clarification.options[0]?.displayName}”?`
      : `Please clarify “${clarification.originalReference}”`;
  return <section className="product-card clarification-card" aria-labelledby="clarification-heading">
    <p className="eyebrow">One detail needs your attention</p>
    <h2 id="clarification-heading">{question}</h2>
    <p className="card-description">{clarificationCopy(clarification.options.length)}</p>
    {clarification.options.length > 0 ? <div className="candidate-list">{clarification.options.map((candidate) => <button type="button" className="candidate" key={`${candidate.entityType}:${candidate.entityId}`} onClick={() => onSelect(candidate)}>
      <span className="avatar" aria-hidden="true">{candidate.displayName.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
      <span className="candidate-copy"><strong>{candidate.displayName}</strong><span>{candidate.entityType.toLowerCase()}</span></span>
      <span className="candidate-arrow"><Icon name="arrow" /></span>
    </button>)}</div> : <p className="card-description">Try describing this detail more specifically in a new request.</p>}
    <button type="button" className="text-button" onClick={onCancel}>Cancel request</button>
  </section>;
}
