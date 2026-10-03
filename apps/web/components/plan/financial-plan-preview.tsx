import type { PlanPresentation } from "../chat/presentation";
import { Icon } from "../ui/icon";
import { PlanRoute } from "./plan-route";

export function FinancialPlanPreview({ scenario, onApprove, onCancel, busy = false }: { scenario: PlanPresentation; onApprove(): void; onCancel(): void; busy?: boolean }) {
  const amount = scenario.goal.details.find((item) => item.label === "Amount")?.value;
  const recipient = scenario.goal.details.find((item) => item.label === "To" || item.label === "Recipient")?.value;
  return <section className="product-card plan-card" aria-labelledby="plan-heading">
    <div className="card-heading-row"><div><p className="eyebrow">Payment details</p><h2 id="plan-heading">{scenario.planTitle}</h2></div></div>
    <p className="card-description">{scenario.planSummary}</p>
    <div className="payment-hero"><small>{amount && recipient ? "You’ll send" : "You asked to"}</small><strong>{amount && recipient ? amount : scenario.goal.title}</strong>{recipient && <span>to {recipient}</span>}</div>
    {scenario.funding.length > 0 && <section className="funding-panel" aria-labelledby="funding-heading"><h3 id="funding-heading">How this payment will be funded</h3>{scenario.funding.map((item) => <div className="funding-row" key={`${item.account}:${item.amount}`}><span><Icon name="wallet" /></span><div><strong>{item.account}</strong><small>{item.detail}</small></div><b>{item.amount}</b></div>)}</section>}
    <div className="plan-composition">
      <div className="plan-route-column"><h3 className="section-heading">What will happen</h3><PlanRoute scenario={scenario} /></div>
      <aside className="transaction-summary" aria-label="Transaction summary"><div className="summary-heading"><span><Icon name="wallet" /></span><div><small>Payment</small><h3>Summary</h3></div></div><dl>{scenario.goal.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>{scenario.preservedConstraints[0] && <div className="summary-condition"><Icon name="shield" /><div><small>Protected condition</small><strong>{scenario.preservedConstraints[0]}</strong></div></div>}</aside>
    </div>
    {scenario.preservedConstraints.length > 1 && <div className="preserved-panel"><p>Also protected</p>{scenario.preservedConstraints.slice(1).map((constraint) => <span key={constraint}><Icon name="check" />{constraint}</span>)}</div>}
    <div className="approval-callout"><Icon name="shield" /><div><strong>Nothing moves until you confirm with your passkey.</strong><p>If these payment details change, you’ll be asked to review them again.</p></div></div>
    <div className="card-actions"><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="button bank-primary" type="button" onClick={onApprove} disabled={busy}>{busy ? "Waiting for passkey…" : "Confirm with passkey"}</button></div>
  </section>;
}
