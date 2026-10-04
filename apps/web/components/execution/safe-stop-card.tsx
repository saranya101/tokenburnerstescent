import type { ExecutionResultV1 } from "@parlance/contracts";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import type { PlanPresentation } from "../chat/presentation";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function SafeStopCard({ scenario, result, onDone, onStartOver, onCheckStatus }: { scenario: PlanPresentation; result: ExecutionResultV1; onDone(): void; onStartOver(): void; onCheckStatus(): void }) {
  const stepResults = scenario.steps.map((step) => result.steps.find((item) => item.stepId === step.id));
  const states = stepResults.map((stepResult) => {
    const status = stepResult?.status;
    if (status === "SETTLED") return "complete" as const;
    if (status === "ACCEPTED") return "active" as const;
    if (status === "UNKNOWN" || status === "FAILED") return "unavailable" as const;
    return "pending" as const;
  });
  const confirmingReasons = new Set(["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE", "BANK_ACCEPTED_CONFIRMATION_PENDING", "SETTLED_BOOKKEEPING_PENDING"]);
  const definitivePreWriteReasons = new Set(["GOAL_CONSTRAINT_VIOLATION", "FINANCIAL_PLAN_EXPIRED", "FINANCIAL_PLAN_NOT_READY", "MATERIAL_PLAN_CHANGE", "BUNDLE_COMPILER_UNAVAILABLE", "TERMINAL_GOAL_CHECK_FAILED", "BUNDLE_REMAINDER_SIMULATION_FAILED", "QUOTE_EXPIRED", "FX_QUOTE_INVALID", "FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "POLICY_BLOCKED"]);
  const confirmingStep = stepResults.find((stepResult) => stepResult?.errorCode !== undefined && confirmingReasons.has(stepResult.errorCode));
  const stoppedStep = confirmingStep ?? stepResults.find((stepResult) => stepResult?.status === "UNKNOWN" || stepResult?.status === "FAILED");
  const confirming = confirmingStep !== undefined;
  const bankEffect = stepResults.some((stepResult) => stepResult?.status === "ACCEPTED" || stepResult?.status === "SETTLED");
  const definitivePreWriteStop = !bankEffect && stoppedStep?.errorCode !== undefined && definitivePreWriteReasons.has(stoppedStep.errorCode);
  const retryAllowed = definitivePreWriteStop;
  const reconciliationConflict = stoppedStep?.errorCode === "RECONCILIATION_CONFLICT";
  const completedBankEffect = stepResults.length > 0 && stepResults.every((stepResult) => stepResult?.status === "SETTLED");
  const statusText = confirming
    ? "Status pending"
    : definitivePreWriteStop
      ? "Stopped safely"
      : reconciliationConflict
        ? "Status needs review"
        : completedBankEffect
          ? "Completed"
          : "Status needs review";
  const headingText = confirming
    ? "Confirming transaction status"
    : definitivePreWriteStop
      ? "Payment stopped safely"
      : reconciliationConflict
        ? "Bank result could not be confirmed"
        : completedBankEffect
          ? "Payment completed"
          : "Transaction status needs review";
  const stopMessage = customerExecutionMessage(stoppedStep?.errorCode, "PAUSED");
  const statusLabels = stepResults.map((stepResult) => {
    if (stepResult?.errorCode && confirmingReasons.has(stepResult.errorCode)) return customerExecutionMessage(stepResult.errorCode, "PAUSED");
    return stepResult?.status === "UNKNOWN" || stepResult?.status === "FAILED" ? customerExecutionMessage(stepResult.errorCode, "PAUSED") : undefined;
  });
  return <div className="safe-stop-layout">
    <section className="product-card stopped-plan-card" aria-labelledby="safe-stop-plan-heading"><div className="card-heading-row"><div><p className="eyebrow">Your approved plan</p><h2 id="safe-stop-plan-heading">{scenario.planTitle}</h2></div><span className="stopped-status"><Icon name="shield" />{statusText}</span></div><PlanRoute scenario={scenario} states={states} statusLabels={statusLabels} /></section>
    <section className="product-card safe-stop-card" aria-labelledby="safe-stop-heading">
      <div className="safe-stop-symbol"><Icon name="shield" /></div><p className="eyebrow">Payment protection</p><h2 id="safe-stop-heading">{headingText}</h2>
      <p className="safe-stop-lead"><strong>{stopMessage}.</strong>{definitivePreWriteStop && <><br />We stopped before any unapproved action could continue.</>}</p>
      <div className="safe-stop-detail"><p><Icon name="check" />No unapproved action will continue</p><p><Icon name="check" />Latest account state checked</p></div>
      <div className="safe-stop-actions">{confirming ? <button className="button bank-primary" type="button" onClick={onCheckStatus}>Check status</button> : <><button className="button bank-primary" type="button" onClick={onDone}>Done</button>{retryAllowed && <button className="button secondary" type="button" onClick={onStartOver}>Start another request</button>}</>}</div>
    </section>
  </div>;
}
