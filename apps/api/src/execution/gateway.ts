import type { ApprovalV1, FinancialActionV1, FinancialPlanStepV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { canonicalJson } from "../security/canonical-hash.js";
import type { BankPort, BankWriteResult } from "../orchestration/ports.js";
import type { StoredApprovalEvidence } from "../webauthn/types.js";
const ALLOWLIST = new Set<FinancialActionV1>(["TRANSFER", "FX_CONVERT", "MOVE_FUNDS", "PAY_BILL", "BUY_ASSET", "SELL_ASSET"]);
export interface ExecutionApproval { goal: GoalContractV1; plan: FinancialPlanV1; approval: ApprovalV1; approvalEvidence?: StoredApprovalEvidence; approvalRevokedAt?: string; executionState: "AUTHORIZED" | "EXECUTING" }
export interface ExecutionAuthorization extends ExecutionApproval { expectedStateVersion: number; currentStateVersion: number; revalidationSucceeded: boolean; idempotencyKey: string; proposedStep: FinancialPlanStepV1 }
export interface BankOperation { path: "fx" | "transfer" | "payment" | "buy"; payload: unknown }

export function verifyExecutionApproval(input: ExecutionApproval): void {
  if (input.goal.status !== "CONFIRMED") throw new Error("Goal is not confirmed");
  if (input.approvalRevokedAt) throw new Error("Approval revoked");
  if (Date.parse(input.approval.approvedAt) > Date.now()) throw new Error("Approval is not active yet");
  if (Date.parse(input.approval.expiresAt) <= Date.now()) throw new Error("Approval expired");
  if (input.approval.financialPlanId !== input.plan.id) throw new Error("Approval is for a different plan");
  if (input.approval.userId !== input.goal.userId) throw new Error("User binding mismatch");
  if (input.approval.goalContractId !== input.goal.id || input.plan.goalContractId !== input.goal.id) throw new Error("Goal binding mismatch");
  if (input.approval.goalContractVersion !== input.goal.version || input.plan.goalContractVersion !== input.goal.version) throw new Error("Goal version mismatch");
  if (input.approval.goalContractHash !== input.goal.contractHash) throw new Error("Goal hash mismatch");
  if (input.approval.financialPlanHash !== input.plan.planHash) throw new Error("Plan hash mismatch");
  if (input.approval.bankStateVersion !== input.plan.bankStateVersion) throw new Error("Bank state binding mismatch");
  if (input.approval.method !== "PASSKEY") throw new Error("CRYPTOGRAPHIC_APPROVAL_EVIDENCE_REQUIRED");
  const evidence = input.approvalEvidence;
  if (!evidence || input.approval.signatureReference !== evidence.id || evidence.approvalId !== input.approval.id || !evidence.userVerified
    || evidence.userId !== input.approval.userId || evidence.financialPlanId !== input.plan.id
    || evidence.goalContractKey !== input.goal.id || evidence.goalContractVersion !== input.goal.version
    || evidence.goalContractHash !== input.goal.contractHash || evidence.financialPlanHash !== input.plan.planHash
    || evidence.bankStateVersion !== input.approval.bankStateVersion) throw new Error("CRYPTOGRAPHIC_APPROVAL_EVIDENCE_INVALID");
  if (!input.plan.steps.every((step) => ALLOWLIST.has(step.action))) throw new Error("Operation is not allowlisted");
  if (!(["AUTHORIZED", "EXECUTING"] as const).includes(input.executionState)) throw new Error("Invalid execution state");
}

export function verifyExecutionAuthorization(input: ExecutionAuthorization): void {
  verifyExecutionApproval(input);
  if (input.expectedStateVersion !== input.currentStateVersion && !input.revalidationSucceeded) throw new Error("State version is stale");
  if (!input.idempotencyKey) throw new Error("Idempotency key required");
  const approvedStep = input.plan.steps.find((step) => step.id === input.proposedStep.id);
  if (!approvedStep || canonicalJson(approvedStep) !== canonicalJson(input.proposedStep)) throw new Error("UNAPPROVED_EXECUTABLE_ACTION");
}

export function bankOperation(userId: string, step: FinancialPlanStepV1): BankOperation {
  if (step.action === "FX_CONVERT") return { path: "fx", payload: {
    userId, accountId: step.parameters.sourceAccountId, fromAmount: step.parameters.sourceMoney,
    toCurrency: step.parameters.targetCurrency, quoteId: step.parameters.quoteId,
  } };
  if (step.action === "TRANSFER" || step.action === "MOVE_FUNDS") return { path: "transfer", payload: { userId, ...step.parameters } };
  if (step.action === "PAY_BILL") return { path: "payment", payload: { userId, ...step.parameters } };
  if (step.action === "BUY_ASSET") return { path: "buy", payload: { userId, ...step.parameters } };
  throw new Error("UNSUPPORTED_OPERATION");
}

export class ExecutionGateway {
  constructor(private readonly bank: BankPort) {}
  async execute(input: ExecutionAuthorization, traceId: string): Promise<BankWriteResult> {
    verifyExecutionAuthorization(input);
    const operation = bankOperation(input.goal.userId, input.proposedStep);
    return this.bank.execute(operation.path, operation.payload, input.idempotencyKey, traceId);
  }
}
