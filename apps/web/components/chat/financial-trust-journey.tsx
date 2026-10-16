import type { CustomerFlowState } from "../../lib/customer-flow";

export type TrustStageStatus = "complete" | "active" | "waiting" | "stopped";

export type TrustStage = {
  id: "interpretation" | "meaning" | "plan" | "authorization" | "execution" | "outcome";
  label: string;
  detail: string;
  status: TrustStageStatus;
};

type TrustJourneyState = {
  phase: CustomerFlowState["phase"];
  reasonCode?: string;
};

const labels: Array<Pick<TrustStage, "id" | "label">> = [
  { id: "interpretation", label: "AI interpretation" },
  { id: "meaning", label: "Meaning confirmation" },
  { id: "plan", label: "Deterministic plan" },
  { id: "authorization", label: "Passkey authorization" },
  { id: "execution", label: "Bank execution" },
  { id: "outcome", label: "Verified outcome" },
];

const details: Record<TrustStage["id"], Record<TrustStageStatus, string>> = {
  interpretation: { complete: "Request understood", active: "Understanding your request", waiting: "Not started", stopped: "Needs a clearer request" },
  meaning: { complete: "Meaning confirmed", active: "Waiting for your confirmation", waiting: "Not reached", stopped: "Confirmation not recorded" },
  plan: { complete: "Plan checks passed", active: "Checking rules and balances", waiting: "Not reached", stopped: "Plan safely declined" },
  authorization: { complete: "Exact plan authorized", active: "Waiting for your passkey", waiting: "Not reached", stopped: "Not authorized" },
  execution: { complete: "Bank actions completed", active: "Bank actions in progress", waiting: "Not reached", stopped: "Execution safely stopped" },
  outcome: { complete: "Final state verified", active: "Checking authoritative status", waiting: "Not reached", stopped: "Outcome needs attention" },
};

function stages(statuses: TrustStageStatus[]): TrustStage[] {
  return labels.map((stage, index) => ({ ...stage, status: statuses[index]!, detail: details[stage.id][statuses[index]!] }));
}

export function trustJourneyForState(state: TrustJourneyState): TrustStage[] {
  switch (state.phase) {
    case "INTERPRETING": return stages(["active", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    case "CLARIFICATION": return stages(["active", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    case "SEMANTIC_VALIDATION_FAILED": return stages(["stopped", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    case "GOAL_REVIEW":
    case "BUNDLE_REVIEW": return stages(["complete", "active", "waiting", "waiting", "waiting", "waiting"]);
    case "CONFIRMING_GOAL":
    case "CONFIRMING_BUNDLE": return stages(["complete", "active", "waiting", "waiting", "waiting", "waiting"]);
    case "GOAL_CONFIRMATION_FAILED":
    case "BUNDLE_CONFIRMATION_FAILED": return stages(["complete", "stopped", "waiting", "waiting", "waiting", "waiting"]);
    case "COMPILING":
    case "COMPILING_BUNDLE": return stages(["complete", "complete", "active", "waiting", "waiting", "waiting"]);
    case "UNAVAILABLE": {
      const result = stages(["complete", "complete", "stopped", "waiting", "waiting", "waiting"]);
      if (state.reasonCode === "MIN_AVAILABLE_BALANCE_VIOLATED") result[2] = { ...result[2]!, detail: "Protected balance preserved" };
      return result;
    }
    case "PLAN_REVIEW": return stages(["complete", "complete", "complete", "waiting", "waiting", "waiting"]);
    case "PASSKEY_REQUIRED":
    case "AUTHORIZING": return stages(["complete", "complete", "complete", "active", "waiting", "waiting"]);
    case "PASSKEY_CANCELLED":
    case "APPROVAL_FAILED":
    case "RISK_REVIEW":
    case "RISK_BLOCKED": return stages(["complete", "complete", "complete", "stopped", "waiting", "waiting"]);
    case "AUTHORIZED": return stages(["complete", "complete", "complete", "complete", "waiting", "waiting"]);
    case "EXECUTING": return stages(["complete", "complete", "complete", "complete", "active", "waiting"]);
    case "COMPLETED": return stages(["complete", "complete", "complete", "complete", "complete", "complete"]);
    case "RECOVERY_PENDING": return stages(["complete", "complete", "complete", "complete", "active", "active"]);
    case "PAUSED": return stages(["complete", "complete", "complete", "complete", "stopped", "active"]);
    case "REAPPROVAL_REQUIRED": {
      const result = stages(["complete", "complete", "complete", "stopped", "stopped", "active"]);
      result[3] = { ...result[3]!, detail: "New approval required" };
      return result;
    }
    case "PARTIALLY_COMPLETED": {
      const result = stages(["complete", "complete", "complete", "complete", "stopped", "stopped"]);
      result[4] = { ...result[4]!, detail: "Some actions completed" };
      return result;
    }
    case "EXECUTION_ERROR": return stages(["complete", "complete", "complete", "complete", "stopped", "stopped"]);
    case "ERROR": return stages(["stopped", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    case "RESTORING_EXECUTION": return stages(["complete", "complete", "complete", "complete", "active", "active"]);
    case "COMPOSE": return stages(["waiting", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  }
}

const statusText: Record<TrustStageStatus, string> = {
  complete: "Complete",
  active: "In progress",
  waiting: "Not reached",
  stopped: "Stopped safely",
};

export function FinancialTrustJourney({ state, deterministicDemo = false }: { state: TrustJourneyState; deterministicDemo?: boolean }) {
  const items = trustJourneyForState(state).map((item) => item.id === "interpretation" && deterministicDemo ? { ...item, label: "Demo interpretation" } : item);
  return <section className="trust-journey" aria-labelledby="trust-journey-heading">
    <header>
      <div><p>Parlance trust journey</p><h2 id="trust-journey-heading">Every step is independently verified</h2></div>
      <span>{deterministicDemo ? "Demo journey status" : "Live transaction state"}</span>
    </header>
    <ol>
      {items.map((item, index) => <li key={item.id} className={`is-${item.status}`} aria-current={item.status === "active" ? "step" : undefined}>
        <span className="trust-stage-marker" aria-hidden="true">{item.status === "complete" ? "✓" : item.status === "stopped" ? "!" : index + 1}</span>
        <div><strong>{item.label}</strong><small>{item.detail}</small></div>
        <em>{statusText[item.status]}</em>
      </li>)}
    </ol>
  </section>;
}
