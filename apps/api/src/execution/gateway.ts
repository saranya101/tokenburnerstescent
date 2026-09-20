import type { ApprovalV1, FinancialActionV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
const ALLOWLIST = new Set<FinancialActionV1>(["TRANSFER", "FX_CONVERT", "MOVE_FUNDS", "PAY_BILL", "BUY_ASSET", "SELL_ASSET"]);
export interface ExecutionAuthorization { goal: GoalContractV1; plan: FinancialPlanV1; approval: ApprovalV1; currentStateVersion: number; revalidated: boolean; executionState: "AUTHORIZED" | "EXECUTING"; idempotencyKey: string; }
export function verifyExecutionAuthorization(input: ExecutionAuthorization): void {
  if (input.goal.status !== "CONFIRMED") throw new Error("Goal is not confirmed");
  if (Date.parse(input.approval.expiresAt) <= Date.now()) throw new Error("Approval expired");
  if (input.approval.goalContractHash !== input.goal.contractHash) throw new Error("Goal hash mismatch");
  if (input.approval.financialPlanHash !== input.plan.planHash) throw new Error("Plan hash mismatch");
  if (input.approval.bankStateVersion !== input.currentStateVersion && !input.revalidated) throw new Error("State version is stale");
  if (!input.idempotencyKey) throw new Error("Idempotency key required");
  if (!input.plan.steps.every((step) => ALLOWLIST.has(step.action))) throw new Error("Operation is not allowlisted");
  if (!(["AUTHORIZED", "EXECUTING"] as const).includes(input.executionState)) throw new Error("Invalid execution state");
  // TODO(security): require cryptographic/biometric approval evidence before production writes.
}
