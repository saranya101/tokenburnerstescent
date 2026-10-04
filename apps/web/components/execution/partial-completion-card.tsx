import type { ExecutionResultV1 } from "@parlance/contracts";
import type { PlanPresentation } from "../chat/presentation";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function PartialCompletionCard({ scenario, result, onDone }: { scenario: PlanPresentation; result: ExecutionResultV1; onDone(): void }) {
  const stepResults = scenario.steps.map((step) => result.steps.find((item) => item.stepId === step.id));
  const states = stepResults.map((step) => step?.status === "SETTLED" ? "complete" as const : "unavailable" as const);
  const labels = stepResults.map((step) => step?.status === "SETTLED" ? "Completed" : "Not completed");
  return <div className="safe-stop-layout">
    <section className="product-card stopped-plan-card" aria-labelledby="partial-plan-heading">
      <div className="card-heading-row"><div><p className="eyebrow">Your approved plan</p><h2 id="partial-plan-heading">Some actions completed</h2></div><span className="stopped-status"><Icon name="warning" />Partially completed</span></div>
      <PlanRoute scenario={scenario} states={states} statusLabels={labels} />
    </section>
    <section className="product-card safe-stop-card" aria-labelledby="partial-heading">
      <div className="safe-stop-symbol"><Icon name="shield" /></div><h2 id="partial-heading">Review what completed</h2>
      <p className="safe-stop-lead"><strong>Do not repeat the whole request.</strong><br />Make a new request only for an action marked Not completed.</p>
      <div className="card-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button></div>
    </section>
  </div>;
}
