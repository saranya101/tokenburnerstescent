import { randomUUID } from "node:crypto";
import { ApprovalV1, CompilerResultV1, ExecutionResultV1, type FinancialPlanStepV1, type FinancialPlanV1, type GoalContractV1 } from "@parlance/contracts";
import { canonicalHash, hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { verifyExecutionAuthorization } from "../execution/gateway.js";
import type { BankPort, BankWriteResult, CompilerPort, ParlanceRepository } from "./ports.js";

export class CompilationService {
  constructor(private readonly repository: ParlanceRepository, private readonly bank: BankPort, private readonly compiler: CompilerPort) {}
  async compile(goalId: string, traceId: string): Promise<CompilerResultV1> {
    const stored = await this.repository.getConfirmedGoal(goalId); if (!stored) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    if (hashGoalContract(stored.contract) !== stored.contract.contractHash) throw new Error("GOAL_HASH_MISMATCH");
    const snapshot = await this.bank.getState(stored.contract.userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
    const result = CompilerResultV1.parse(await this.compiler.compile(stored.contract, snapshot, traceId));
    if (result.status !== "SAT") { await this.repository.saveCompilationFailure(stored.rowId, result, traceId); return result; }
    if (result.plan.goalContractId !== stored.contract.id || result.plan.goalContractVersion !== stored.contract.version || result.plan.bankStateVersion !== snapshot.stateVersion) throw new Error("COMPILER_RESULT_BINDING_MISMATCH");
    const plan: FinancialPlanV1 = { ...result.plan, planHash: hashFinancialPlan(result.plan) };
    await this.repository.savePlan(stored.rowId, plan, traceId); return { ...result, plan };
  }
}

export class ApprovalService {
  constructor(private readonly repository: ParlanceRepository) {}
  async approve(planId: string, input: { userId: string; method: "BIOMETRIC" | "PASSKEY" | "PIN" | "EXTERNAL_SIGNATURE"; signatureReference: string; expiresAt?: string }, traceId: string) {
    const storedPlan = await this.repository.getPlan(planId); if (!storedPlan) throw new Error("PLAN_NOT_FOUND");
    const storedGoal = await this.repository.getConfirmedGoal(storedPlan.plan.goalContractId); if (!storedGoal) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    if (input.userId !== storedGoal.contract.userId) throw new Error("USER_MISMATCH");
    if (hashGoalContract(storedGoal.contract) !== storedGoal.contract.contractHash || hashFinancialPlan(storedPlan.plan) !== storedPlan.plan.planHash) throw new Error("APPROVAL_HASH_MISMATCH");
    const now = new Date(); const expiresAt = input.expiresAt ?? new Date(now.getTime() + 10 * 60_000).toISOString(); if (Date.parse(expiresAt) <= now.getTime()) throw new Error("APPROVAL_EXPIRY_INVALID"); const approval = ApprovalV1.parse({ schemaVersion: "1", id: randomUUID(), userId: input.userId,
      goalContractId: storedGoal.contract.id, goalContractVersion: storedGoal.contract.version, goalContractHash: storedGoal.contract.contractHash,
      financialPlanId: storedPlan.plan.id, financialPlanHash: storedPlan.plan.planHash, bankStateVersion: storedPlan.plan.bankStateVersion,
      method: input.method, approvedAt: now.toISOString(), expiresAt, signatureReference: input.signatureReference });
    const execution = await this.repository.approvePlan({ goalRowId: storedGoal.rowId, approval, executionId: randomUUID(), traceId });
    return { approval, execution: execution.result };
  }
}

function bankOperation(userId: string, step: FinancialPlanStepV1): { path: "fx" | "transfer" | "payment" | "buy"; payload: unknown } {
  if (step.action === "FX_CONVERT") return { path: "fx", payload: { userId, ...step.parameters } };
  if (step.action === "TRANSFER") return { path: "transfer", payload: { userId, ...step.parameters } };
  if (step.action === "MOVE_FUNDS") return { path: "transfer", payload: { userId, ...step.parameters } };
  if (step.action === "PAY_BILL") return { path: "payment", payload: { userId, ...step.parameters } };
  if (step.action === "BUY_ASSET") return { path: "buy", payload: { userId, ...step.parameters } };
  throw new Error("UNSUPPORTED_OPERATION");
}

function bankWriteResult(value: unknown): BankWriteResult {
  if (typeof value !== "object" || value === null) throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  const item = value as Record<string, unknown>;
  if (item.accepted !== true || typeof item.bankReference !== "string" || typeof item.stateVersion !== "number") throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  return { accepted: true, bankReference: item.bankReference, stateVersion: item.stateVersion };
}

export class ExecutionService {
  constructor(private readonly repository: ParlanceRepository, private readonly bank: BankPort) {}
  async run(executionId: string, traceId: string) {
    const execution = await this.repository.getExecution(executionId); if (!execution) throw new Error("EXECUTION_NOT_FOUND");
    if (["COMPLETED", "FAILED"].includes(execution.result.status)) return execution.result;
    const approval = await this.repository.getApproval(execution.approvalId); if (!approval) throw new Error("APPROVAL_NOT_FOUND");
    const storedPlan = await this.repository.getPlan(execution.result.planId); if (!storedPlan) throw new Error("PLAN_NOT_FOUND");
    const storedGoal = await this.repository.getConfirmedGoal(storedPlan.plan.goalContractId); if (!storedGoal) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    let snapshot = await this.bank.getState(storedGoal.contract.userId, traceId);
    const firstStep = storedPlan.plan.steps[0];
    if (firstStep) verifyExecutionAuthorization({ goal: storedGoal.contract, plan: storedPlan.plan, approval: approval.approval, ...(approval.revokedAt ? { approvalRevokedAt: approval.revokedAt } : {}), currentStateVersion: snapshot.stateVersion, revalidated: false, executionState: "AUTHORIZED", idempotencyKey: canonicalHash({ executionId, stepId: firstStep.id }) });
    await this.repository.startExecution(executionId, traceId);
    const stepResults: ExecutionResultV1["steps"] = [];
    for (const [index, step] of storedPlan.plan.steps.entries()) {
      const idempotencyKey = canonicalHash({ executionId, stepId: step.id }); const stepId = `${executionId}:${step.id}`;
      verifyExecutionAuthorization({ goal: storedGoal.contract, plan: storedPlan.plan, approval: approval.approval, ...(approval.revokedAt ? { approvalRevokedAt: approval.revokedAt } : {}), currentStateVersion: snapshot.stateVersion, revalidated: index > 0, executionState: "EXECUTING", idempotencyKey });
      const operation = bankOperation(storedGoal.contract.userId, step); const claim = await this.repository.claimIdempotency({ key: idempotencyKey, scope: "BANK_EXECUTION_STEP", requestHash: canonicalHash(operation.payload) });
      if (claim.status === "CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
      if (claim.status === "REPLAY" && claim.response === undefined) throw new Error("IDEMPOTENCY_IN_PROGRESS");
      await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "PENDING", traceId });
      try {
        const result = claim.status === "REPLAY" ? bankWriteResult(claim.response) : await this.bank.execute(operation.path, operation.payload, idempotencyKey, traceId);
        if (claim.status === "CLAIMED") await this.repository.completeIdempotency(idempotencyKey, result);
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "ACCEPTED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        snapshot = await this.bank.getState(storedGoal.contract.userId, traceId); if (snapshot.stateVersion !== result.stateVersion) throw new Error("BANK_STATE_VERSION_MISMATCH");
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "SETTLED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        stepResults.push({ stepId: step.id, status: "SETTLED", idempotencyKey, bankReference: result.bankReference });
        // Revalidation hook: replace this trusted post-write refresh with compiler revalidation when that contract exists.
      } catch (error) {
        const errorCode = error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : "BANK_WRITE_FAILED";
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "FAILED", errorCode, traceId });
        const failed = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "FAILED", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: snapshot.stateVersion, steps: [...stepResults, { stepId: step.id, status: "FAILED", idempotencyKey, errorCode }], goalOutcome: { achieved: false, summary: `Execution failed at step ${step.id}.` } });
        await this.repository.finishExecution({ executionId, result: failed, traceId }); return failed;
      }
    }
    const completed = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "COMPLETED", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: snapshot.stateVersion, steps: stepResults, goalOutcome: outcome(storedGoal.contract, storedPlan.plan) });
    await this.repository.finishExecution({ executionId, result: completed, traceId }); return completed;
  }
  get(id: string) { return this.repository.getExecution(id); }
  list() { return this.repository.listExecutions(); }
  listRecoverable() { return this.repository.listRecoverableExecutions(); }
}

function outcome(goal: GoalContractV1, plan: FinancialPlanV1): ExecutionResultV1["goalOutcome"] {
  if (goal.goal.type === "DELIVER_MONEY") return { achieved: true, summary: "Requested funds were delivered.", deliveredMoney: goal.goal.amount };
  if (goal.goal.type === "ACQUIRE_ASSET") { const acquired = plan.projectedOutcome.acquiredAssets[0]; return acquired ? { achieved: true, summary: "Requested asset was acquired.", acquiredAsset: acquired } : { achieved: true, summary: "Asset acquisition plan completed." }; }
  return { achieved: true, summary: "The confirmed financial goal was completed." };
}
