import type { ExecutionResultV1 } from "@parlance/contracts";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import type { DemoScenario } from "../chat/demo-data";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function SafeStopCard({ scenario, result, onDone, onStartOver, onShowRouteChange }: { scenario: DemoScenario; result?: ExecutionResultV1; onDone(): void; onStartOver(): void; onShowRouteChange(): void }) {
  const reasonCode = result?.steps.find((step) => step.status === "UNKNOWN" || step.status === "FAILED")?.errorCode;
  const stopMessage = customerExecutionMessage(reasonCode, "PAUSED");
  const states = scenario.steps.map((_, index) => index === scenario.steps.length - 1 ? "unavailable" as const : "not-executed" as const);
  const statusLabels = scenario.steps.map((_, index) => index === scenario.steps.length - 1 ? stopMessage : undefined);
  return <div className="safe-stop-layout">
    <section className="product-card stopped-plan-card" aria-labelledby="safe-stop-plan-heading"><div className="card-heading-row"><div><p className="eyebrow">Your approved plan</p><h2 id="safe-stop-plan-heading">{scenario.planTitle}</h2></div><span className="stopped-status"><Icon name="shield" />Stopped safely</span></div><PlanRoute scenario={scenario} states={states} statusLabels={statusLabels} /></section>
    <section className="product-card safe-stop-card" aria-labelledby="safe-stop-heading">
      <div className="safe-stop-symbol"><Icon name="shield" /></div><p className="eyebrow">Protected by Parlance</p><h2 id="safe-stop-heading">Execution stopped safely</h2>
      <p className="safe-stop-lead"><strong>{stopMessage}.</strong><br />Parlance stopped before any unapproved action could continue.</p>
      <div className="money-moved"><strong>S$0</strong><span>moved</span></div>
      <div className="safe-stop-detail"><p><Icon name="check" />No unapproved action will continue</p><p><Icon name="check" />Latest account state checked</p></div>
      <div className="safe-stop-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button><button className="button secondary" type="button" onClick={onStartOver}>Start another request</button><button className="text-button" type="button" onClick={onShowRouteChange}>See route-change protection</button></div>
    </section>
  </div>;
}
