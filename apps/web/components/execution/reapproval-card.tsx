import type { DemoScenario } from "../chat/demo-data";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function ReapprovalCard({ scenario, onReview, onCancel }: { scenario: DemoScenario; onReview(): void; onCancel(): void }) {
  return <section className="product-card reapproval-card" aria-labelledby="reapproval-heading">
    <div className="reapproval-heading"><span><Icon name="warning" /></span><div><p className="eyebrow">Your decision is needed</p><h2 id="reapproval-heading">The route changed</h2><p>No further action will occur until you review and approve an updated plan.</p></div></div>
    <div className="route-comparison"><div><small>Original route</small><PlanRoute scenario={scenario} compact states={scenario.steps.map(() => "not-executed")} /></div><div className="updated-route"><small>Updated route</small><span><Icon name="spark" /></span><strong>Updated route ready for review</strong><p>Banking systems found a meaningful change. Review the exact details before approving.</p></div></div>
    <div className="card-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button bank-primary" onClick={onReview}>Review updated plan</button></div>
  </section>;
}
