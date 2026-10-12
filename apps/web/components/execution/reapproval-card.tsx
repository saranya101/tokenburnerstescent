import type { PlanPresentation } from "../chat/presentation";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function ReapprovalCard({ scenario, onReview, onCancel }: { scenario: PlanPresentation; onReview(): void; onCancel(): void }) {
  const investment = scenario.goal.details.some((detail) => detail.label === "Investment");
  const noun = investment ? "investment" : "payment";
  return <section className="product-card reapproval-card" aria-labelledby="reapproval-heading">
    <div className="reapproval-heading"><span><Icon name="warning" /></span><div><p className="eyebrow">Review needed</p><h2 id="reapproval-heading">Your {noun} details have changed</h2><p>We used the latest account information. Please review the {noun} and authorise it again.</p></div></div>
    <div className="route-comparison"><div><small>Previously reviewed {noun}</small><PlanRoute scenario={scenario} compact states={scenario.steps.map(() => "not-executed")} /></div><div className="updated-route"><small>{investment ? "Investment" : "Payment"} paused</small><span><Icon name="shield" /></span><strong>{customerExecutionMessage(undefined, "REAPPROVAL_REQUIRED")}</strong><p>Your previous authorisation was not reused.</p></div></div>
    <div className="card-actions"><button type="button" className="button secondary" onClick={onCancel}>Done</button><button type="button" className="button bank-primary" onClick={onReview}>Review updated plan</button></div>
  </section>;
}
