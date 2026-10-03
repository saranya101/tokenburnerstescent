import type { ExecutionResultV1 } from "@parlance/contracts";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import type { PlanPresentation } from "../chat/presentation";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function SafeStopCard({ scenario, result, onDone, onStartOver }: { scenario: PlanPresentation; result: ExecutionResultV1; onDone(): void; onStartOver(): void }) {
  const stepResults = scenario.steps.map((step) => result.steps.find((item) => item.stepId === step.id));
  const states = stepResults.map((stepResult) => {
    const status = stepResult?.status;
    return status === "SETTLED" ? "complete" as const : status === "UNKNOWN" || status === "FAILED" ? "unavailable" as const : "not-executed" as const;
  });
  const stoppedStep = stepResults.find((stepResult) => stepResult?.status === "UNKNOWN" || stepResult?.status === "FAILED");
  const stopMessage = customerExecutionMessage(stoppedStep?.errorCode, "PAUSED");
  const statusLabels = stepResults.map((stepResult) => stepResult?.status === "UNKNOWN" || stepResult?.status === "FAILED" ? customerExecutionMessage(stepResult.errorCode, "PAUSED") : undefined);
  return <div className="safe-stop-layout">
    <section className="product-card stopped-plan-card" aria-labelledby="safe-stop-plan-heading"><div className="card-heading-row"><div><p className="eyebrow">Your approved plan</p><h2 id="safe-stop-plan-heading">{scenario.planTitle}</h2></div><span className="stopped-status"><Icon name="shield" />Stopped safely</span></div><PlanRoute scenario={scenario} states={states} statusLabels={statusLabels} /></section>
    <section className="product-card safe-stop-card" aria-labelledby="safe-stop-heading">
      <div className="safe-stop-symbol"><Icon name="shield" /></div><p className="eyebrow">Protected by Parlance</p><h2 id="safe-stop-heading">Execution stopped safely</h2>
      <p className="safe-stop-lead"><strong>{stopMessage}.</strong><br />Parlance stopped before any unapproved action could continue.</p>
      <div className="safe-stop-detail"><p><Icon name="check" />No unapproved action will continue</p><p><Icon name="check" />Latest account state checked</p></div>
      <div className="safe-stop-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button><button className="button secondary" type="button" onClick={onStartOver}>Start another request</button></div>
    </section>
  </div>;
}
