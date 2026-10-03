import type { PlanPresentation } from "../chat/presentation";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function ReapprovalCard({ scenario, onStartOver, onCancel }: { scenario: PlanPresentation; onStartOver(): void; onCancel(): void }) {
  return <section className="product-card reapproval-card" aria-labelledby="reapproval-heading">
    <div className="reapproval-heading"><span><Icon name="warning" /></span><div><p className="eyebrow">Your decision is needed</p><h2 id="reapproval-heading">The route changed</h2><p>No further action will occur until you review and approve an updated plan.</p></div></div>
    <div className="route-comparison"><div><small>Previously approved route</small><PlanRoute scenario={scenario} compact states={scenario.steps.map(() => "not-executed")} /></div><div className="updated-route"><small>Protection applied</small><span><Icon name="spark" /></span><strong>{customerExecutionMessage(undefined, "REAPPROVAL_REQUIRED")}</strong><p>No changed route has been authorized. Start a new request to review a newly compiled plan.</p></div></div>
    <div className="card-actions"><button type="button" className="button secondary" onClick={onCancel}>Done</button><button type="button" className="button bank-primary" onClick={onStartOver}>Start a new request</button></div>
  </section>;
}
