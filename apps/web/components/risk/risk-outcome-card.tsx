import { Icon } from "../ui/icon";

export function RiskOutcomeCard({ decision, onDone }: { decision: "REVIEW" | "BLOCK"; onDone(): void }) {
  const content = decision === "REVIEW"
    ? {
        title: "Additional review required",
        detail: "We need to review this transaction before it can continue. No money has moved.",
      }
    : {
        title: "Transaction can’t continue",
        detail: "We can’t complete this transaction under the current safety checks. No money has moved.",
      };

  return <section className="product-card safe-stop-card">
    <div className="safe-stop-symbol"><Icon name="shield" /></div>
    <h2>{content.title}</h2>
    <p className="card-description">{content.detail}</p>
    <div className="card-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button></div>
  </section>;
}
