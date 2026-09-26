import { randomUUID } from "node:crypto";
import { ApprovalV1, CompilerResultV1, ExecutionResultV1, GoalContractV1, type FinancialPlanV1 } from "@parlance/contracts";
import {
  DeterministicGoalContractBuilder, DeterministicIntentAmbiguityDetector, GoalContractCandidateV1, intentReferenceOccurrences,
  type EntityGrounder, type GoalContractBuilder, type IntentAmbiguityDetector, type IntentInterpreter,
} from "@parlance/intent-engine";
import { z } from "zod";
import { canonicalHash, hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { bankOperation, ExecutionGateway, verifyExecutionApproval, verifyExecutionAuthorization } from "../execution/gateway.js";
import { assertCompilerBinding, materiallyEquivalentRoute, simulateFinancialStep, stepPreservesConstraints, terminalStepSatisfiesGoal, type RevalidationOutcome } from "../execution/goal-preservation.js";
import type { BankPort, BankWriteResult, CompilerPort, GoalConfirmationMetadata, GoalConfirmationRepository, ParlanceRepository } from "./ports.js";

const MessageInput = z.object({ userId: z.string().min(1), text: z.string().min(1) }).strict();
export type EntityGrounderFactory = (userId: string) => EntityGrounder;

export class MessageOrchestrationService {
  constructor(
    private readonly repository: GoalConfirmationRepository,
    private readonly interpreter: IntentInterpreter,
    private readonly grounderForUser: EntityGrounderFactory,
    private readonly ambiguityDetector: IntentAmbiguityDetector = new DeterministicIntentAmbiguityDetector(),
    private readonly goalBuilder: GoalContractBuilder = new DeterministicGoalContractBuilder(),
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async receive(value: unknown, traceId: string) {
    const input = MessageInput.parse(value);
    const intentDraft = await this.interpreter.interpretUserRequest(input);
    const grounder = this.grounderForUser(input.userId);
    const occurrences = [...new Map(intentReferenceOccurrences(intentDraft).map((item) => [`${item.reference}\u0000${item.expectedEntityType ?? ""}`, item])).values()];
    const groundingResults = await Promise.all(occurrences.map((item) => grounder.ground(item.expectedEntityType === undefined
      ? { reference: item.reference }
      : { reference: item.reference, expectedEntityType: item.expectedEntityType })));
    const ambiguity = this.ambiguityDetector.analyze({ draft: intentDraft, groundingResults });
    if (ambiguity.status === "NEEDS_CLARIFICATION") {
      return { status: "NEEDS_CLARIFICATION" as const, intentDraft, clarifications: ambiguity.clarifications };
    }
    const candidate = GoalContractCandidateV1.parse(this.goalBuilder.build({ draft: intentDraft, groundingResults }));
    const stored = await this.repository.saveGoalCandidate({
      candidateId: this.newId(), goalContractId: this.newId(), userId: input.userId, version: 1,
      createdAt: this.now().toISOString(), candidate, originalText: input.text, intentDraft, traceId,
    });
    return { status: "AWAITING_GOAL_CONFIRMATION" as const, candidateId: stored.candidateId, goalCandidate: stored.candidate };
  }

  async confirm(candidateId: string, traceId: string) {
    const stored = await this.repository.getGoalCandidate(candidateId);
    if (!stored) throw new Error("GOAL_CANDIDATE_NOT_FOUND");
    const candidate = GoalContractCandidateV1.parse(stored.candidate);
    const confirmedAt = this.now().toISOString();
    const unhashed = GoalContractV1.parse({
      ...candidate, id: stored.goalContractId, userId: stored.userId, version: stored.version,
      sourceIntentDraftId: stored.candidateId, status: "CONFIRMED", contractHash: "0".repeat(64),
      createdAt: stored.createdAt, confirmedAt,
      entityBindings: candidate.entityBindings.map((binding) => ({ ...binding, confirmed: true })),
    });
    const contract = GoalContractV1.parse({ ...unhashed, contractHash: hashGoalContract(unhashed) });
    const confirmation: GoalConfirmationMetadata = {
      schemaVersion: "1", goalContractId: contract.id, goalContractVersion: contract.version,
      contractHash: contract.contractHash, confirmedAt: contract.confirmedAt!, confirmationType: "EXPLICIT_USER_CONFIRMATION",
    };
    const confirmed = await this.repository.confirmGoal({ candidateId, contract, confirmation, traceId });
    const authoritativeConfirmation: GoalConfirmationMetadata = {
      schemaVersion: "1", goalContractId: confirmed.contract.id, goalContractVersion: confirmed.contract.version,
      contractHash: confirmed.contract.contractHash, confirmedAt: confirmed.contract.confirmedAt!, confirmationType: "EXPLICIT_USER_CONFIRMATION",
    };
    return { status: "CONFIRMED" as const, goalContract: confirmed.contract, confirmation: authoritativeConfirmation };
  }
}

export class CompilationService {
  constructor(private readonly repository: ParlanceRepository, private readonly bank: BankPort, private readonly compiler: CompilerPort) {}
  async compile(goalId: string, traceId: string): Promise<CompilerResultV1> {
    const stored = await this.repository.getConfirmedGoal(goalId); if (!stored) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    const contract = GoalContractV1.parse(stored.contract);
    if (contract.status !== "CONFIRMED" || contract.confirmedAt === undefined) throw new Error("GOAL_NOT_CONFIRMED");
    if (contract.entityBindings.some((binding) => !binding.confirmed)) throw new Error("GOAL_BINDING_NOT_CONFIRMED");
    if (hashGoalContract(contract) !== contract.contractHash) throw new Error("GOAL_HASH_MISMATCH");
    const snapshot = await this.bank.getState(contract.userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
    const result = CompilerResultV1.parse(await this.compiler.compile(contract, snapshot, traceId));
    if (result.status !== "SAT") { await this.repository.saveCompilationFailure(stored.rowId, result, traceId); return result; }
    if (result.plan.goalContractId !== contract.id || result.plan.goalContractVersion !== contract.version || result.plan.bankStateVersion !== snapshot.stateVersion) throw new Error("COMPILER_RESULT_BINDING_MISMATCH");
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

function bankWriteResult(value: unknown): BankWriteResult {
  if (typeof value !== "object" || value === null) throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  const item = value as Record<string, unknown>;
  if (item.accepted !== true || typeof item.bankReference !== "string" || typeof item.stateVersion !== "number") throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  return { accepted: true, bankReference: item.bankReference, stateVersion: item.stateVersion };
}

export class ExecutionService {
  constructor(private readonly repository: ParlanceRepository, private readonly bank: BankPort, private readonly compiler: CompilerPort) {}
  async run(executionId: string, traceId: string) {
    const execution = await this.repository.getExecution(executionId); if (!execution) throw new Error("EXECUTION_NOT_FOUND");
    if (["COMPLETED", "FAILED", "PAUSED", "REAPPROVAL_REQUIRED"].includes(execution.executionState)) return execution.result;
    const approval = await this.repository.getApproval(execution.approvalId); if (!approval) throw new Error("APPROVAL_NOT_FOUND");
    const storedPlan = await this.repository.getPlan(execution.result.planId); if (!storedPlan) throw new Error("PLAN_NOT_FOUND");
    const storedGoal = await this.repository.getConfirmedGoal(storedPlan.plan.goalContractId); if (!storedGoal) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    if (hashGoalContract(storedGoal.contract) !== storedGoal.contract.contractHash) throw new Error("GOAL_HASH_MISMATCH");
    if (hashFinancialPlan(storedPlan.plan) !== storedPlan.plan.planHash) throw new Error("PLAN_HASH_MISMATCH");
    const executionState = execution.executionState === "EXECUTING" ? "EXECUTING" : "AUTHORIZED";
    const approvalVerification = { goal: storedGoal.contract, plan: storedPlan.plan, approval: approval.approval, ...(approval.revokedAt ? { approvalRevokedAt: approval.revokedAt } : {}), executionState } as const;
    verifyExecutionApproval(approvalVerification);
    const audit = (eventType: string, payload: Record<string, unknown>) => this.repository.recordExecutionAudit({ executionId, eventType, traceId, payload: { timestamp: new Date().toISOString(), traceId, executionId, ...payload } });
    await audit("EXECUTION_GOAL_HASH_VERIFIED", { category: "AUTHORIZATION", outcome: "VERIFIED", goalHashVerified: true });
    await audit("EXECUTION_PLAN_HASH_VERIFIED", { category: "AUTHORIZATION", outcome: "VERIFIED", planHashVerified: true });
    let snapshot = await this.bank.getState(storedGoal.contract.userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
    await audit("EXECUTION_LATEST_STATE_LOADED", { category: "STATE_CHECK", outcome: "LOADED", approvedStateVersion: approval.approval.bankStateVersion, observedStateVersion: snapshot.stateVersion });
    await audit("EXECUTION_APPROVAL_VERIFIED", { category: "AUTHORIZATION", outcome: "VERIFIED", approvalVerified: true, approvedStateVersion: approval.approval.bankStateVersion });
    const stepResults: ExecutionResultV1["steps"] = [...execution.result.steps.filter((item) => item.status === "SETTLED")];
    const persistedSettledStateVersion = await this.repository.getLatestSettledStateVersion(executionId);
    let expectedStateVersion = persistedSettledStateVersion ?? approval.approval.bankStateVersion;
    let executionStarted = execution.executionState === "EXECUTING";
    const executionGateway = new ExecutionGateway(this.bank);

    const stop = async (index: number, outcome: RevalidationOutcome, state: "PAUSED" | "REAPPROVAL_REQUIRED", reason: string, explanation: string) => {
      const step = storedPlan.plan.steps[index]!; const idempotencyKey = canonicalHash({ executionId, stepId: step.id });
      const blockedStep = { stepId: step.id, status: "UNKNOWN" as const, idempotencyKey, errorCode: reason };
      await this.repository.recordStep({ executionId, planStepId: step.id, stepId: `${executionId}:${step.id}`, idempotencyKey, status: "UNKNOWN", errorCode: reason, traceId });
      await audit("EXECUTION_BANK_OPERATION_PREVENTED", { category: "EXECUTION", outcome, stepKey: step.id, reason, explanation });
      const result = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "UNKNOWN", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: snapshot.stateVersion, steps: [...stepResults, blockedStep], goalOutcome: { achieved: false, summary: explanation } });
      await this.repository.blockExecution({ executionId, state, reason, explanation, result, traceId }); return result;
    };

    for (const [index, step] of storedPlan.plan.steps.entries()) {
      if (stepResults.some((item) => item.stepId === step.id && item.status === "SETTLED")) continue;
      snapshot = await this.bank.getState(storedGoal.contract.userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
      await audit("EXECUTION_LATEST_STATE_LOADED", { category: "STATE_CHECK", outcome: "LOADED", stepKey: step.id, approvedStateVersion: approval.approval.bankStateVersion, expectedStateVersion, observedStateVersion: snapshot.stateVersion });
      const stateChanged = snapshot.stateVersion !== expectedStateVersion;
      let revalidationSucceeded = false;
      if (stateChanged) {
        const replanned = CompilerResultV1.parse(await this.compiler.compile(storedGoal.contract, snapshot, traceId)); assertCompilerBinding(replanned, storedGoal.contract.id, storedGoal.contract.version, snapshot.stateVersion);
        if (replanned.status === "POLICY_BLOCKED") return stop(index, "POLICY_BLOCKED", "PAUSED", replanned.reason.code, "Policy no longer permits the approved route in the latest account state.");
        if (replanned.status === "UNSAT") return stop(index, "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", replanned.reason.code, "The latest account state can no longer satisfy the confirmed goal.");
        if (!materiallyEquivalentRoute(replanned.plan.steps, storedPlan.plan.steps.slice(index))) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "MATERIAL_PLAN_CHANGE", "The safe route changed materially and requires your approval again.");
        revalidationSucceeded = true;
        await audit("EXECUTION_STATE_CHANGE_REVALIDATED", { category: "STATE_CHECK", outcome: "STATE_CHANGED", stepKey: step.id, approvedStateVersion: approval.approval.bankStateVersion, observedStateVersion: snapshot.stateVersion, reason: "MATERIALLY_EQUIVALENT_ROUTE", explanation: "State changed, but the approved financial route remains materially equivalent." });
      }
      const idempotencyKey = canonicalHash({ executionId, stepId: step.id }); const stepId = `${executionId}:${step.id}`;
      let authorization = { ...approvalVerification, executionState: executionStarted ? "EXECUTING" as const : "AUTHORIZED" as const, expectedStateVersion, currentStateVersion: snapshot.stateVersion, revalidationSucceeded, idempotencyKey, proposedStep: step };
      verifyExecutionAuthorization(authorization);
      if (!executionStarted) { await this.repository.startExecution(executionId, traceId); executionStarted = true; authorization = { ...authorization, executionState: "EXECUTING" }; }
      await audit("GOAL_PRESERVATION_SIMULATION_STARTED", { category: "GOAL_PRESERVATION", outcome: "STARTED", stepKey: step.id, observedStateVersion: snapshot.stateVersion });
      const simulation = simulateFinancialStep(snapshot, step);
      if (simulation.outcome === "POLICY_BLOCKED") { await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: simulation.outcome, stepKey: step.id, reason: simulation.reason, explanation: simulation.explanation }); return stop(index, simulation.outcome, "PAUSED", simulation.reason, simulation.explanation); }
      if (!stepPreservesConstraints(storedGoal.contract, step, simulation.snapshot)) { const explanation = "Executing this step would violate or cannot prove a confirmed goal constraint."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "POLICY_BLOCKED", stepKey: step.id, reason: "GOAL_CONSTRAINT_VIOLATION", explanation }); return stop(index, "POLICY_BLOCKED", "PAUSED", "GOAL_CONSTRAINT_VIOLATION", explanation); }
      const remainingSteps = storedPlan.plan.steps.slice(index + 1);
      if (remainingSteps.length === 0 && !terminalStepSatisfiesGoal(storedGoal.contract, step, simulation.snapshot)) { const explanation = "The final approved step no longer completes the confirmed goal or its constraints."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "GOAL_NO_LONGER_ACHIEVABLE", stepKey: step.id, reason: "TERMINAL_GOAL_CHECK_FAILED", explanation }); return stop(index, "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", "TERMINAL_GOAL_CHECK_FAILED", explanation); }
      if (remainingSteps.length > 0) {
        const preservation = CompilerResultV1.parse(await this.compiler.compile(storedGoal.contract, simulation.snapshot, traceId)); assertCompilerBinding(preservation, storedGoal.contract.id, storedGoal.contract.version, simulation.snapshot.stateVersion);
        if (preservation.status !== "SAT") { const outcome = preservation.status === "POLICY_BLOCKED" ? "POLICY_BLOCKED" : "GOAL_NO_LONGER_ACHIEVABLE"; const explanation = preservation.status === "POLICY_BLOCKED" ? "Executing this step would violate policy for the remaining confirmed goal." : "Executing this step would leave the remaining confirmed goal no longer achievable."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome, stepKey: step.id, reason: preservation.reason.code, explanation }); return stop(index, outcome, "PAUSED", preservation.reason.code, explanation); }
      }
      await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "SAFE_TO_EXECUTE", stepKey: step.id, reason: "GOAL_REMAINS_SATISFIABLE", explanation: "The deterministic simulation confirms the remaining goal is still achievable." });
      await audit("EXECUTION_STEP_ALLOWED", { category: "EXECUTION", outcome: "SAFE_TO_EXECUTE", stepKey: step.id, idempotencyKey });
      const operation = bankOperation(storedGoal.contract.userId, step); const claim = await this.repository.claimIdempotency({ key: idempotencyKey, scope: "BANK_EXECUTION_STEP", requestHash: canonicalHash(operation.payload) });
      if (claim.status === "CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
      if (claim.status === "REPLAY" && claim.response === undefined) throw new Error("IDEMPOTENCY_IN_PROGRESS");
      await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "PENDING", traceId });
      try {
        const result = claim.status === "REPLAY" ? bankWriteResult(claim.response) : await executionGateway.execute(authorization, traceId);
        if (claim.status === "CLAIMED") await this.repository.completeIdempotency(idempotencyKey, result);
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "ACCEPTED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        await audit("EXECUTION_BANK_OPERATION_EXECUTED", { category: "EXECUTION", outcome: "EXECUTED", stepKey: step.id, idempotencyKey, bankReference: result.bankReference });
        snapshot = await this.bank.getState(storedGoal.contract.userId, traceId); if (snapshot.stateVersion !== result.stateVersion) throw new Error("BANK_STATE_VERSION_MISMATCH");
        await this.repository.saveSnapshot(snapshot, traceId); await audit("EXECUTION_STATE_REFRESHED", { category: "STATE_CHECK", outcome: "REFRESHED", stepKey: step.id, observedStateVersion: snapshot.stateVersion });
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "SETTLED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        stepResults.push({ stepId: step.id, status: "SETTLED", idempotencyKey, bankReference: result.bankReference });
        expectedStateVersion = result.stateVersion; await audit("EXECUTION_RECONCILIATION_RESULT", { category: "RECONCILIATION", outcome: "MATCHED", stepKey: step.id, bankReference: result.bankReference, expectedStateVersion: result.stateVersion, observedStateVersion: snapshot.stateVersion });
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
  async detail(id: string) {
    const execution = await this.repository.getExecution(id); if (!execution) return null;
    const plan = await this.repository.getPlan(execution.result.planId); const goal = plan ? await this.repository.getConfirmedGoal(plan.plan.goalContractId) : null;
    const audit = (await this.repository.listAudit()).filter((item) => typeof item === "object" && item !== null && (("aggregateId" in item && item.aggregateId === id) || ("traceId" in item && item.traceId === execution.traceId)));
    return { state: execution.executionState, traceId: execution.traceId, result: execution.result, goal: goal?.contract, plan: plan?.plan, audit };
  }
  list() { return this.repository.listExecutions(); }
  listRecoverable() { return this.repository.listRecoverableExecutions(); }
}

function outcome(goal: GoalContractV1, plan: FinancialPlanV1): ExecutionResultV1["goalOutcome"] {
  if (goal.goal.type === "DELIVER_MONEY") return { achieved: true, summary: "Requested funds were delivered.", deliveredMoney: goal.goal.amount };
  if (goal.goal.type === "ACQUIRE_ASSET") { const acquired = plan.projectedOutcome.acquiredAssets[0]; return acquired ? { achieved: true, summary: "Requested asset was acquired.", acquiredAsset: acquired } : { achieved: true, summary: "Asset acquisition plan completed." }; }
  return { achieved: true, summary: "The confirmed financial goal was completed." };
}
