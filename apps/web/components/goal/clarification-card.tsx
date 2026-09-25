const candidates = [
  { id: "john-tan", name: "John Tan", bank: "DBS beneficiary", account: "•••• 2841" },
  { id: "john-lim", name: "John Lim", bank: "DBS beneficiary", account: "•••• 9920" },
];

export function ClarificationCard({ onSelect, onCancel }: { onSelect(candidate: typeof candidates[number]): void; onCancel(): void }) {
  return <section className="product-card clarification-card" aria-labelledby="clarification-heading">
    <p className="eyebrow">One detail needs your attention</p>
    <h2 id="clarification-heading">Which John did you mean?</h2>
    <p className="card-description">These beneficiaries could lead to different financial outcomes, so Parlance will never choose silently.</p>
    <div className="candidate-list">{candidates.map((candidate) => <button type="button" className="candidate" key={candidate.id} onClick={() => onSelect(candidate)}>
      <span className="avatar" aria-hidden="true">{candidate.name.split(" ").map((part) => part[0]).join("")}</span>
      <span className="candidate-copy"><strong>{candidate.name}</strong><span>{candidate.bank}</span></span>
      <span className="candidate-account">{candidate.account}</span><span className="candidate-arrow"><Icon name="arrow" /></span>
    </button>)}</div>
    <button type="button" className="text-button" onClick={onCancel}>Cancel request</button>
  </section>;
}
import { Icon } from "../ui/icon";
