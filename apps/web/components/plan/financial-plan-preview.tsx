import type { DemoScenario } from "../chat/demo-data";
import { Icon } from "../ui/icon";
import { PlanRoute } from "./plan-route";

export function FinancialPlanPreview({ scenario, onApprove, onCancel }: { scenario: DemoScenario; onApprove(): void; onCancel(): void }) {
  const source = scenario.steps[0]?.meta.find((item) => item.label === "Source")?.value ?? scenario.steps[0]?.summary.split("→")[0]?.trim();
  return <section className="product-card plan-card" aria-labelledby="plan-heading">
    <div className="card-heading-row"><div><p className="eyebrow">Your transaction plan</p><h2 id="plan-heading">{scenario.planTitle}</h2></div><span className="plan-state"><Icon name="check" />Ready for review</span></div>
    <p className="card-description">{scenario.planSummary}</p>
    <div className="plan-composition">
      <div className="plan-route-column"><PlanRoute scenario={scenario} /></div>
      <aside className="transaction-summary" aria-label="Transaction summary"><div className="summary-heading"><span><Icon name="wallet" /></span><div><small>Review</small><h3>Transaction summary</h3></div></div><dl>{scenario.goal.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}{source && <div><dt>Source</dt><dd>{source}</dd></div>}</dl>{scenario.preservedConstraints[0] && <div className="summary-condition"><Icon name="shield" /><div><small>Protected condition</small><strong>{scenario.preservedConstraints[0]}</strong></div></div>}</aside>
    </div>
    {scenario.preservedConstraints.length > 1 && <div className="preserved-panel"><p>Also protected</p>{scenario.preservedConstraints.slice(1).map((constraint) => <span key={constraint}><Icon name="check" />{constraint}</span>)}</div>}
    <div className="approval-callout"><Icon name="shield" /><div><strong>Nothing moves until you approve this exact plan.</strong><p>Any meaningful change requires your approval again.</p></div></div>
    <div className="card-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button bank-primary" type="button" onClick={onApprove}>Review &amp; approve</button></div>
  </section>;
}
