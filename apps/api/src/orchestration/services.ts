import { randomUUID } from "node:crypto";
import {
  CompileGoalBundleResultV1, CompilerResultV1, ExecutionResultV1, GoalContractV1,
  type BankStateSnapshotV1, type BundleSatisfactionProofV1, type FinancialPlanStepV1, type FinancialPlanV1, type GoalBundleContractV1,
} from "@parlance/contracts";
import { hashGoalBundleContract } from "@parlance/contracts/server";
import {
  DeterministicGoalContractBuilder, DeterministicIntentAmbiguityDetector, DeterministicReadOnlyIntentValidator, GoalContractCandidateV1, intentReferenceOccurrences,
  type ClarificationItem, type EntityGrounder, type EntityGroundingResult, type GoalContractBuilder, type GroundableEntityType, type IndependentIntentValidator, type IntentAmbiguityDetector, type IntentInterpreter,
} from "@parlance/intent-engine";
import { z } from "zod";
import { canonicalHash, hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { financialPlanExpired } from "../security/plan-validity.js";
import { bankOperation, ExecutionGateway, verifyExecutionApproval, verifyExecutionAuthorization } from "../execution/gateway.js";
import { assertCompilerBinding, materiallyEquivalentRoute, simulateFinancialStep, stepPreservesConstraints, terminalStepSatisfiesGoal, type RevalidationOutcome } from "../execution/goal-preservation.js";
import { BankOutcomeUnknownError, type BankPort, type BankWriteResult, type CompilerPort, type GoalConfirmationMetadata, type GoalConfirmationRepository, type ParlanceRepository } from "./ports.js";
import type { BundlePlanRepository } from "./ports.js";
import { verifyBundleCompilerResult } from "./bundle-compilation.js";
import { ConversationalMessageInput, inputProvenance, type ConversationalInputProvenance } from "./input-provenance.js";

const ClarificationAnswerInput = z.union([
  z.object({ selectedCandidateId: z.string().min(1) }).strict(),
  z.object({ answerText: z.string().trim().min(1) }).strict(),
]);
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
    private readonly intentValidator: IndependentIntentValidator = new DeterministicReadOnlyIntentValidator(),
  ) {}

  async receive(value: unknown, traceId: string) {
    const input = ConversationalMessageInput.parse(value);
    const provenance = inputProvenance(input);
    const intentDraft = await this.interpreter.interpretUserRequest(input);
    const grounder = this.grounderForUser(input.userId);
    const occurrences = [...new Map(intentReferenceOccurrences(intentDraft).map((item) => [`${item.reference}\u0000${item.expectedEntityType ?? ""}`, item])).values()];
    const groundingResults = await Promise.all(occurrences.map((item) => grounder.ground(item.expectedEntityType === undefined
      ? { reference: item.reference }
      : { reference: item.reference, expectedEntityType: item.expectedEntityType })));
    const ambiguity = this.ambiguityDetector.analyze({ draft: intentDraft, groundingResults });
    if (ambiguity.status === "NEEDS_CLARIFICATION") {
      const stored = await this.repository.saveClarification({
        clarificationId: this.newId(), goalContractId: this.newId(), userId: input.userId, version: 1,
        createdAt: this.now().toISOString(), originalText: input.text, intentDraft, groundingResults,
        clarifications: ambiguity.clarifications, inputProvenance: provenance, clarificationAnswers: [], traceId,
      });
      return { status: "NEEDS_CLARIFICATION" as const, clarificationId: stored.clarificationId, clarifications: stored.clarifications };
    }
    const candidate = GoalContractCandidateV1.parse(this.goalBuilder.build({ draft: intentDraft, groundingResults }));
    const candidateId = this.newId(); const goalContractId = this.newId(); const createdAt = this.now().toISOString();
    const validation = this.intentValidator.validate({ sourceText: input.text, draft: intentDraft, candidate });
    if (validation.status === "FAIL") {
      await this.repository.rejectSemanticValidation({ recordId: candidateId, userId: input.userId, schemaVersion: intentDraft.schemaVersion, createdAt, originalText: input.text, inputProvenance: provenance, validation: semanticValidationEvidence(validation, provenance), traceId });
      return semanticValidationFailed();
    }
    const stored = await this.repository.saveGoalCandidate({
      candidateId, goalContractId, userId: input.userId, version: 1,
      createdAt, candidate, originalText: input.text, intentDraft, inputProvenance: provenance, semanticValidation: semanticValidationEvidence(validation, provenance), traceId,
    });
    return { status: "AWAITING_GOAL_CONFIRMATION" as const, candidateId: stored.candidateId, goalCandidate: stored.candidate };
  }

  async answerClarification(clarificationId: string, value: unknown, traceId: string) {
    const answer = ClarificationAnswerInput.parse(value);
    const pending = await this.repository.getClarification(clarificationId);
    if (pending === null) {
      const completed = await this.repository.getGoalCandidate(clarificationId);
      if (completed !== null) return { status: "AWAITING_GOAL_CONFIRMATION" as const, candidateId: completed.candidateId, goalCandidate: completed.candidate };
      throw new Error("CLARIFICATION_NOT_FOUND");
    }
    const clarification = pending.clarifications[0];
    if (clarification === undefined) throw new Error("CLARIFICATION_NOT_ANSWERABLE");
    const requirement = intentReferenceOccurrences(pending.intentDraft).find((item) => item.field === clarification.field && item.reference === clarification.originalReference);
    if (requirement === undefined) throw new Error("CLARIFICATION_REQUIREMENT_NOT_FOUND");

    const grounder = this.grounderForUser(pending.userId);
    const resolved = "selectedCandidateId" in answer
      ? selectedGrounding(clarification, answer.selectedCandidateId, requirement.expectedEntityType)
      : rebaseGrounding(await grounder.ground(requirement.expectedEntityType === undefined
        ? { reference: answer.answerText }
        : { reference: answer.answerText, expectedEntityType: requirement.expectedEntityType }), clarification.originalReference, requirement.expectedEntityType);
    const groundingResults = replaceGrounding(pending.groundingResults, clarification, resolved);
    const ambiguity = this.ambiguityDetector.analyze({ draft: pending.intentDraft, groundingResults });
    const candidate = ambiguity.status === "CLEAR"
      ? GoalContractCandidateV1.parse(this.goalBuilder.build({ draft: pending.intentDraft, groundingResults }))
      : undefined;
    const answerText = "selectedCandidateId" in answer
      ? clarification.options.find((option) => option.entityId === answer.selectedCandidateId)?.displayName ?? answer.selectedCandidateId
      : answer.answerText;
    const provenance = pending.inputProvenance ?? { inputMode: "TYPED" as const, submittedText: pending.originalText, edited: false as const };
    const clarificationAnswers = [...(pending.clarificationAnswers ?? []), answerText];
    const validation = candidate === undefined ? undefined : this.intentValidator.validate({ sourceText: pending.originalText, draft: pending.intentDraft, candidate });
    if (validation?.status === "FAIL") {
      await this.repository.rejectSemanticValidation({ recordId: clarificationId, userId: pending.userId, schemaVersion: pending.intentDraft.schemaVersion, createdAt: pending.createdAt, originalText: pending.originalText, inputProvenance: provenance, answerText, validation: semanticValidationEvidence(validation, provenance, clarificationAnswers), traceId });
      return semanticValidationFailed();
    }
    const progress = await this.repository.advanceClarification({
      clarificationId, answerText, groundingResults,
      clarifications: ambiguity.status === "CLEAR" ? [] : ambiguity.clarifications,
      ...(candidate === undefined ? {} : { candidate, semanticValidation: semanticValidationEvidence(validation!, provenance, clarificationAnswers) }), traceId,
    });
    return progress.status === "AWAITING_GOAL_CONFIRMATION"
      ? { status: "AWAITING_GOAL_CONFIRMATION" as const, candidateId: progress.candidate.candidateId, goalCandidate: progress.candidate.candidate }
      : { status: "NEEDS_CLARIFICATION" as const, clarificationId: progress.request.clarificationId, clarifications: progress.request.clarifications };
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

function semanticValidationEvidence(result: ReturnType<IndependentIntentValidator["validate"]>, input: ConversationalInputProvenance, clarificationAnswers: readonly string[] = []) {
  return { decision: result.status, mismatches: result.mismatches.map(({ code, field }) => ({ code, field })), input, clarificationAnswers } as const;
}

function semanticValidationFailed() {
  return { status: "SEMANTIC_VALIDATION_FAILED" as const, message: "We couldn't safely verify that we understood your request. Please clarify or rephrase it." };
}

function selectedGrounding(clarification: ClarificationItem, entityId: string, expectedEntityType: GroundableEntityType | undefined): EntityGroundingResult {
  const option = clarification.options.find((item) => item.entityId === entityId && (expectedEntityType === undefined || item.entityType === expectedEntityType));
  if (option === undefined) throw new Error("CLARIFICATION_OPTION_INVALID");
  return { status: "RESOLVED", reference: clarification.originalReference, entityType: option.entityType, entityId: option.entityId, resolutionMethod: "USER_CONFIRMED" };
}

function rebaseGrounding(result: EntityGroundingResult, reference: string, expectedEntityType: GroundableEntityType | undefined): EntityGroundingResult {
  if (result.status === "RESOLVED") {
    if (expectedEntityType !== undefined && result.entityType !== expectedEntityType) return { status: "NOT_FOUND", reference, expectedEntityType };
    return { status: "RESOLVED", reference, entityType: result.entityType, entityId: result.entityId, resolutionMethod: "USER_CONFIRMED" };
  }
  if (result.status === "NOT_FOUND") return expectedEntityType === undefined ? { status: "NOT_FOUND", reference } : { status: "NOT_FOUND", reference, expectedEntityType };
  if (result.status === "AMBIGUOUS") return expectedEntityType === undefined
    ? { status: "AMBIGUOUS", reference, candidates: result.candidates }
    : { status: "AMBIGUOUS", reference, expectedEntityType, candidates: result.candidates };
  return expectedEntityType === undefined
    ? { status: "CANDIDATES", reference, candidates: result.candidates }
    : { status: "CANDIDATES", reference, expectedEntityType, candidates: result.candidates };
}

function replaceGrounding(results: readonly EntityGroundingResult[], clarification: ClarificationItem, replacement: EntityGroundingResult): EntityGroundingResult[] {
  let replaced = false;
  const next = results.map((result) => {
    if (!replaced && result.reference === clarification.originalReference && result.status !== "RESOLVED") { replaced = true; return replacement; }
    return result;
  });
  if (!replaced) next.push(replacement);
  return next;
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

function bankWriteResult(value: unknown): BankWriteResult {
  if (typeof value !== "object" || value === null) throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  const item = value as Record<string, unknown>;
  if (item.accepted !== true || typeof item.bankReference !== "string" || typeof item.stateVersion !== "number") throw new Error("IDEMPOTENCY_RESPONSE_INVALID");
  return { accepted: true, bankReference: item.bankReference, stateVersion: item.stateVersion };
}

export class ExecutionService {
  constructor(private readonly repository: ParlanceRepository, private readonly bank: BankPort, private readonly compiler: CompilerPort, private readonly now: () => Date = () => new Date()) {}
  async run(executionId: string, traceId: string) {
    const execution = await this.repository.getExecution(executionId); if (!execution) throw new Error("EXECUTION_NOT_FOUND");
    const recoveryErrors = new Set(["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE"]);
    const hasUnknownBankOutcome = execution.result.steps.some((step) => step.status === "UNKNOWN" && step.errorCode !== undefined && recoveryErrors.has(step.errorCode));
    if (["COMPLETED", "FAILED", "REAPPROVAL_REQUIRED"].includes(execution.executionState) || (execution.executionState === "PAUSED" && !hasUnknownBankOutcome)) return execution.result;
    const approval = await this.repository.getApproval(execution.approvalId); if (!approval) throw new Error("APPROVAL_NOT_FOUND");
    const storedPlan = await this.repository.getPlan(execution.result.planId); if (!storedPlan) throw new Error("PLAN_NOT_FOUND");
    const storedGoal = storedPlan.ownerType === "BUNDLE" ? null : await this.repository.getConfirmedGoal(storedPlan.plan.goalContractId);
    const bundleRepository = this.repository as ParlanceRepository & Partial<BundlePlanRepository>;
    const storedBundle = storedPlan.ownerType === "BUNDLE" && bundleRepository.getConfirmedGoalBundle ? await bundleRepository.getConfirmedGoalBundle(storedPlan.plan.goalContractId) : null;
    if (!storedGoal && !storedBundle) throw new Error(storedPlan.ownerType === "BUNDLE" ? "CONFIRMED_GOAL_BUNDLE_NOT_FOUND" : "CONFIRMED_GOAL_NOT_FOUND");
    if (storedGoal && hashGoalContract(storedGoal.contract) !== storedGoal.contract.contractHash) throw new Error("GOAL_HASH_MISMATCH");
    if (storedBundle && hashGoalBundleContract(storedBundle.contract) !== storedBundle.contract.contractHash) throw new Error("GOAL_BUNDLE_HASH_MISMATCH");
    if (hashFinancialPlan(storedPlan.plan) !== storedPlan.plan.planHash) throw new Error("PLAN_HASH_MISMATCH");
    const userId = storedGoal?.contract.userId ?? storedBundle!.userId;
    const authorizationSubject = storedGoal
      ? { status: "CONFIRMED" as const, userId, id: storedGoal.contract.id, version: storedGoal.contract.version, contractHash: storedGoal.contract.contractHash }
      : { status: "CONFIRMED" as const, userId, id: storedBundle!.contract.bundleId, version: storedBundle!.contract.bundleVersion, contractHash: storedBundle!.contract.contractHash };
    const audit = (eventType: string, payload: Record<string, unknown>) => this.repository.recordExecutionAudit({ executionId, eventType, traceId, payload: { timestamp: this.now().toISOString(), traceId, executionId, ...payload } });
    if (storedPlan.status !== "READY") {
      const explanation = "The approved plan is no longer active and must be reviewed and approved again.";
      const result = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "UNKNOWN", startedStateVersion: execution.result.startedStateVersion, steps: execution.result.steps, goalOutcome: { achieved: false, summary: explanation } });
      await audit("EXECUTION_BANK_OPERATION_PREVENTED", { category: "AUTHORIZATION", outcome: "REPLAN_REQUIRED", reason: "FINANCIAL_PLAN_NOT_READY", planStatus: storedPlan.status, explanation });
      await this.repository.blockExecution({ executionId, state: "REAPPROVAL_REQUIRED", reason: "FINANCIAL_PLAN_NOT_READY", explanation, result, traceId });
      return result;
    }
    if (financialPlanExpired(storedPlan.plan, this.now())) {
      const explanation = "The approved plan expired before execution and must be refreshed and approved again.";
      const result = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "UNKNOWN", startedStateVersion: execution.result.startedStateVersion, steps: execution.result.steps, goalOutcome: { achieved: false, summary: explanation } });
      await audit("EXECUTION_BANK_OPERATION_PREVENTED", { category: "EXECUTION", outcome: "REPLAN_REQUIRED", reason: "FINANCIAL_PLAN_EXPIRED", explanation });
      await this.repository.blockExecution({ executionId, state: "REAPPROVAL_REQUIRED", reason: "FINANCIAL_PLAN_EXPIRED", explanation, result, traceId });
      return result;
    }
    const executionState = execution.executionState === "EXECUTING" ? "EXECUTING" : "AUTHORIZED";
    const approvalVerification = { goal: authorizationSubject, plan: storedPlan.plan, planStatus: storedPlan.status, approval: approval.approval, ...(approval.evidence ? { approvalEvidence: approval.evidence } : {}), ...(approval.revokedAt ? { approvalRevokedAt: approval.revokedAt } : {}), executionState } as const;
    verifyExecutionApproval(approvalVerification);
    await audit("EXECUTION_GOAL_HASH_VERIFIED", { category: "AUTHORIZATION", outcome: "VERIFIED", goalHashVerified: true });
    await audit("EXECUTION_PLAN_HASH_VERIFIED", { category: "AUTHORIZATION", outcome: "VERIFIED", planHashVerified: true });
    let snapshot = await this.bank.getState(userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
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

    const pauseForReconciliation = async (step: FinancialPlanV1["steps"][number], idempotencyKey: string, reason: "BANK_RESPONSE_OUTCOME_UNKNOWN" | "BANK_LOOKUP_UNAVAILABLE" | "RECONCILIATION_CONFLICT") => {
      const explanation = reason === "RECONCILIATION_CONFLICT"
        ? "The bank result did not match the exact approved transaction. No further action will continue."
        : "We’re confirming this transaction’s status. Please don’t try again yet.";
      const unknownStep = { stepId: step.id, status: "UNKNOWN" as const, idempotencyKey, errorCode: reason };
      await this.repository.recordStep({ executionId, planStepId: step.id, stepId: `${executionId}:${step.id}`, idempotencyKey, status: "UNKNOWN", errorCode: reason, traceId });
      await audit(reason === "RECONCILIATION_CONFLICT" ? "RECONCILIATION_CONFLICT" : "BANK_RESPONSE_OUTCOME_UNKNOWN", { category: "RECONCILIATION", outcome: "PAUSED", stepKey: step.id, idempotencyKey, reason, explanation, severity: reason === "RECONCILIATION_CONFLICT" ? "HIGH" : "WARNING" });
      const result = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "UNKNOWN", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: snapshot.stateVersion, steps: [...stepResults, unknownStep], goalOutcome: { achieved: false, summary: explanation } });
      await this.repository.blockExecution({ executionId, state: "PAUSED", reason, explanation, result, traceId });
      return result;
    };

    for (const [index, step] of storedPlan.plan.steps.entries()) {
      if (stepResults.some((item) => item.stepId === step.id && item.status === "SETTLED")) continue;
      if (financialPlanExpired(storedPlan.plan, this.now())) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "FINANCIAL_PLAN_EXPIRED", "The approved plan expired before this step and must be refreshed and approved again.");
      const idempotencyKey = canonicalHash({ executionId, stepId: step.id }); const stepId = `${executionId}:${step.id}`;
      const operation = bankOperation(userId, step); const operationRequestHash = canonicalHash(operation.payload);
      const persistedUnknown = execution.result.steps.find((item) => item.stepId === step.id && item.status === "UNKNOWN" && item.errorCode !== undefined && recoveryErrors.has(item.errorCode));
      if (persistedUnknown) {
        try {
          await audit("RECONCILIATION_STARTED", { category: "RECONCILIATION", outcome: "STARTED", stepKey: step.id, idempotencyKey });
          const found = await this.bank.lookupByIdempotencyKey(idempotencyKey, traceId);
          if (found.status === "COMPLETED") {
            await audit("BANK_IDEMPOTENCY_RESULT_FOUND", { category: "RECONCILIATION", outcome: "FOUND", stepKey: step.id, idempotencyKey, bankReference: found.bankReference });
            if (found.idempotencyKey !== idempotencyKey || found.operation !== operation.path || found.requestHash !== operationRequestHash) return await pauseForReconciliation(step, idempotencyKey, "RECONCILIATION_CONFLICT");
            const recovered = { accepted: true as const, bankReference: found.bankReference, stateVersion: found.stateVersion };
            await this.repository.completeIdempotency(idempotencyKey, recovered);
            await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "ACCEPTED", bankReference: found.bankReference, resultingStateVersion: found.stateVersion, traceId });
            await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "SETTLED", bankReference: found.bankReference, resultingStateVersion: found.stateVersion, traceId });
            stepResults.push({ stepId: step.id, status: "SETTLED", idempotencyKey, bankReference: found.bankReference }); expectedStateVersion = found.stateVersion;
            await audit("RECONCILIATION_MATCHED", { category: "RECONCILIATION", outcome: "MATCHED", stepKey: step.id, idempotencyKey, bankReference: found.bankReference, resultingStateVersion: found.stateVersion });
            await audit("EXECUTION_RESUMED", { category: "RECONCILIATION", outcome: "RESUMED", stepKey: step.id, idempotencyKey });
            continue;
          }
          await audit("RECONCILIATION_NOT_FOUND", { category: "RECONCILIATION", outcome: "NOT_FOUND", stepKey: step.id, idempotencyKey });
        } catch (error) {
          if (error instanceof Error && error.message === "BANK_LOOKUP_UNAVAILABLE") return await pauseForReconciliation(step, idempotencyKey, "BANK_LOOKUP_UNAVAILABLE");
          throw error;
        }
      }
      snapshot = await this.bank.getState(userId, traceId); await this.repository.saveSnapshot(snapshot, traceId);
      await audit("EXECUTION_LATEST_STATE_LOADED", { category: "STATE_CHECK", outcome: "LOADED", stepKey: step.id, approvedStateVersion: approval.approval.bankStateVersion, expectedStateVersion, observedStateVersion: snapshot.stateVersion });
      const stateChanged = snapshot.stateVersion !== expectedStateVersion;
      let revalidationSucceeded = false;
      if (stateChanged) {
        let replannedSteps: FinancialPlanV1["steps"];
        if (storedBundle) {
          if (!this.compiler.compileBundle) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "BUNDLE_COMPILER_UNAVAILABLE", "The combined plan could not be safely revalidated and requires review again.");
          const replanned = await this.compiler.compileBundle({ goalBundle: storedBundle.contract, bankState: snapshot }, traceId);
          if ("status" in replanned) return stop(index, replanned.status === "POLICY_BLOCKED" ? "POLICY_BLOCKED" : "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", replanned.reason.code, "The latest account state can no longer satisfy the confirmed combined request.");
          const parsed = CompileGoalBundleResultV1.parse(replanned); verifyBundleCompilerResult(storedBundle.contract, snapshot.stateVersion, parsed.financialPlan, parsed.satisfactionProof); replannedSteps = parsed.financialPlan.steps;
        } else {
          const replanned = CompilerResultV1.parse(await this.compiler.compile(storedGoal!.contract, snapshot, traceId)); assertCompilerBinding(replanned, storedGoal!.contract.id, storedGoal!.contract.version, snapshot.stateVersion);
          if (replanned.status === "POLICY_BLOCKED") return stop(index, "POLICY_BLOCKED", "PAUSED", replanned.reason.code, "Policy no longer permits the approved route in the latest account state.");
          if (replanned.status === "UNSAT") return stop(index, "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", replanned.reason.code, "The latest account state can no longer satisfy the confirmed goal.");
          replannedSteps = replanned.plan.steps;
        }
        if (!materiallyEquivalentRoute(replannedSteps, storedPlan.plan.steps.slice(index))) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "MATERIAL_PLAN_CHANGE", "The safe route changed materially and requires your approval again.");
        revalidationSucceeded = true;
        await audit("EXECUTION_STATE_CHANGE_REVALIDATED", { category: "STATE_CHECK", outcome: "STATE_CHANGED", stepKey: step.id, approvedStateVersion: approval.approval.bankStateVersion, observedStateVersion: snapshot.stateVersion, reason: "MATERIALLY_EQUIVALENT_ROUTE", explanation: "State changed, but the approved financial route remains materially equivalent." });
      }
      const authoritativePlan = await this.repository.getPlan(storedPlan.plan.id);
      if (!authoritativePlan || authoritativePlan.status !== "READY" || authoritativePlan.plan.planHash !== storedPlan.plan.planHash) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "FINANCIAL_PLAN_NOT_READY", "The approved plan is no longer active and must be reviewed and approved again.");
      let authorization = { ...approvalVerification, executionState: executionStarted ? "EXECUTING" as const : "AUTHORIZED" as const, expectedStateVersion, currentStateVersion: snapshot.stateVersion, revalidationSucceeded, idempotencyKey, proposedStep: step };
      if (financialPlanExpired(storedPlan.plan, this.now())) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "FINANCIAL_PLAN_EXPIRED", "The approved plan expired before this step and must be refreshed and approved again.");
      verifyExecutionAuthorization(authorization);
      if (!executionStarted) { await this.repository.startExecution(executionId, traceId); executionStarted = true; authorization = { ...authorization, executionState: "EXECUTING" }; }
      await audit("GOAL_PRESERVATION_SIMULATION_STARTED", { category: "GOAL_PRESERVATION", outcome: "STARTED", stepKey: step.id, observedStateVersion: snapshot.stateVersion });
      const simulation = simulateFinancialStep(snapshot, step);
      if (simulation.outcome === "POLICY_BLOCKED") { await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: simulation.outcome, stepKey: step.id, reason: simulation.reason, explanation: simulation.explanation }); return stop(index, simulation.outcome, "PAUSED", simulation.reason, simulation.explanation); }
      const constraintsPreserved = storedBundle ? bundleStepPreservesConstraints(storedBundle.contract, step, simulation.snapshot, userId) : stepPreservesConstraints(storedGoal!.contract, step, simulation.snapshot);
      if (!constraintsPreserved) { const explanation = "Executing this step would violate or cannot prove a confirmed goal constraint."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "POLICY_BLOCKED", stepKey: step.id, reason: "GOAL_CONSTRAINT_VIOLATION", explanation }); return stop(index, "POLICY_BLOCKED", "PAUSED", "GOAL_CONSTRAINT_VIOLATION", explanation); }
      const remainingSteps = storedPlan.plan.steps.slice(index + 1);
      const terminalSatisfied = storedBundle ? bundleCoveredGoalsSatisfied(storedBundle.contract, storedPlan.satisfactionProof, step, simulation.snapshot, userId) : terminalStepSatisfiesGoal(storedGoal!.contract, step, simulation.snapshot);
      if ((storedBundle !== null || remainingSteps.length === 0) && !terminalSatisfied) { const explanation = "The approved step no longer completes its covered confirmed goal or constraints."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "GOAL_NO_LONGER_ACHIEVABLE", stepKey: step.id, reason: "TERMINAL_GOAL_CHECK_FAILED", explanation }); return stop(index, "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", "TERMINAL_GOAL_CHECK_FAILED", explanation); }
      if (remainingSteps.length > 0) {
        if (storedBundle) {
          if (!simulateRemainingBundle(storedBundle.contract, storedPlan.satisfactionProof, remainingSteps, simulation.snapshot, userId)) { const explanation = "Executing this step would leave part of the confirmed combined request no longer safely achievable."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "GOAL_NO_LONGER_ACHIEVABLE", stepKey: step.id, reason: "BUNDLE_REMAINDER_SIMULATION_FAILED", explanation }); return stop(index, "GOAL_NO_LONGER_ACHIEVABLE", "PAUSED", "BUNDLE_REMAINDER_SIMULATION_FAILED", explanation); }
        } else {
          const preservation = CompilerResultV1.parse(await this.compiler.compile(storedGoal!.contract, simulation.snapshot, traceId)); assertCompilerBinding(preservation, storedGoal!.contract.id, storedGoal!.contract.version, simulation.snapshot.stateVersion);
          if (preservation.status !== "SAT") { const outcome = preservation.status === "POLICY_BLOCKED" ? "POLICY_BLOCKED" : "GOAL_NO_LONGER_ACHIEVABLE"; const explanation = preservation.status === "POLICY_BLOCKED" ? "Executing this step would violate policy for the remaining confirmed goal." : "Executing this step would leave the remaining confirmed goal no longer achievable."; await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome, stepKey: step.id, reason: preservation.reason.code, explanation }); return stop(index, outcome, "PAUSED", preservation.reason.code, explanation); }
        }
      }
      await audit("GOAL_PRESERVATION_SIMULATION_RESULT", { category: "GOAL_PRESERVATION", outcome: "SAFE_TO_EXECUTE", stepKey: step.id, reason: "GOAL_REMAINS_SATISFIABLE", explanation: "The deterministic simulation confirms the remaining goal is still achievable." });
      await audit("EXECUTION_STEP_ALLOWED", { category: "EXECUTION", outcome: "SAFE_TO_EXECUTE", stepKey: step.id, idempotencyKey });
      const executablePlan = await this.repository.getPlan(storedPlan.plan.id);
      if (!executablePlan || executablePlan.status !== "READY" || executablePlan.plan.planHash !== storedPlan.plan.planHash) return stop(index, "REPLAN_REQUIRED", "REAPPROVAL_REQUIRED", "FINANCIAL_PLAN_NOT_READY", "The approved plan is no longer active and must be reviewed and approved again.");
      authorization = { ...authorization, planStatus: executablePlan.status };
      verifyExecutionAuthorization(authorization);
      const claim = await this.repository.claimIdempotency({ key: idempotencyKey, scope: "BANK_EXECUTION_STEP", requestHash: operationRequestHash });
      if (claim.status === "CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
      await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "PENDING", traceId });
      try {
        const lookup = async () => {
          await audit("RECONCILIATION_STARTED", { category: "RECONCILIATION", outcome: "STARTED", stepKey: step.id, idempotencyKey });
          const found = await this.bank.lookupByIdempotencyKey(idempotencyKey, traceId);
          if (found.status === "NOT_FOUND") { await audit("RECONCILIATION_NOT_FOUND", { category: "RECONCILIATION", outcome: "NOT_FOUND", stepKey: step.id, idempotencyKey }); return undefined; }
          await audit("BANK_IDEMPOTENCY_RESULT_FOUND", { category: "RECONCILIATION", outcome: "FOUND", stepKey: step.id, idempotencyKey, bankReference: found.bankReference });
          if (found.idempotencyKey !== idempotencyKey || found.operation !== operation.path || found.requestHash !== operationRequestHash) throw new Error("RECONCILIATION_CONFLICT");
          await audit("RECONCILIATION_MATCHED", { category: "RECONCILIATION", outcome: "MATCHED", stepKey: step.id, idempotencyKey, bankReference: found.bankReference });
          return { accepted: true as const, bankReference: found.bankReference, stateVersion: found.stateVersion };
        };
        const retryAfterUnknown = async () => {
          const found = await lookup();
          if (found) return found;
          await audit("BANK_WRITE_REQUESTED", { category: "EXECUTION", outcome: "RETRY_AFTER_AUTHORITATIVE_NOT_FOUND", stepKey: step.id, idempotencyKey });
          try { return await executionGateway.execute(authorization, traceId); }
          catch (error) {
            if (!(error instanceof BankOutcomeUnknownError)) throw error;
            await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "UNKNOWN", errorCode: "BANK_RESPONSE_OUTCOME_UNKNOWN", traceId });
            await audit("BANK_RESPONSE_OUTCOME_UNKNOWN", { category: "RECONCILIATION", outcome: "UNKNOWN", stepKey: step.id, idempotencyKey });
            return await lookup();
          }
        };
        let result: BankWriteResult | undefined;
        if (claim.status === "REPLAY" && claim.response !== undefined) result = bankWriteResult(claim.response);
        else if (claim.status === "REPLAY") result = await retryAfterUnknown();
        else {
          await audit("BANK_WRITE_REQUESTED", { category: "EXECUTION", outcome: "REQUESTED", stepKey: step.id, idempotencyKey });
          try { result = await executionGateway.execute(authorization, traceId); }
          catch (error) {
            if (!(error instanceof BankOutcomeUnknownError)) throw error;
            await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "UNKNOWN", errorCode: "BANK_RESPONSE_OUTCOME_UNKNOWN", traceId });
            await audit("BANK_RESPONSE_OUTCOME_UNKNOWN", { category: "RECONCILIATION", outcome: "UNKNOWN", stepKey: step.id, idempotencyKey });
            result = await retryAfterUnknown();
          }
        }
        if (!result) return await pauseForReconciliation(step, idempotencyKey, "BANK_RESPONSE_OUTCOME_UNKNOWN");
        await this.repository.completeIdempotency(idempotencyKey, result);
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "ACCEPTED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        await audit("EXECUTION_BANK_OPERATION_EXECUTED", { category: "EXECUTION", outcome: "EXECUTED", stepKey: step.id, idempotencyKey, bankReference: result.bankReference });
        snapshot = await this.bank.getState(userId, traceId); if (snapshot.stateVersion !== result.stateVersion) throw new Error("BANK_STATE_VERSION_MISMATCH");
        await this.repository.saveSnapshot(snapshot, traceId); await audit("EXECUTION_STATE_REFRESHED", { category: "STATE_CHECK", outcome: "REFRESHED", stepKey: step.id, observedStateVersion: snapshot.stateVersion });
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "SETTLED", bankReference: result.bankReference, resultingStateVersion: result.stateVersion, traceId });
        stepResults.push({ stepId: step.id, status: "SETTLED", idempotencyKey, bankReference: result.bankReference });
        expectedStateVersion = result.stateVersion; await audit("EXECUTION_RECONCILIATION_RESULT", { category: "RECONCILIATION", outcome: "MATCHED", stepKey: step.id, bankReference: result.bankReference, expectedStateVersion: result.stateVersion, observedStateVersion: snapshot.stateVersion });
      } catch (error) {
        const recoveryReason = error instanceof Error && error.message === "RECONCILIATION_CONFLICT" ? "RECONCILIATION_CONFLICT" as const
          : error instanceof Error && error.message === "BANK_LOOKUP_UNAVAILABLE" ? "BANK_LOOKUP_UNAVAILABLE" as const
          : undefined;
        if (recoveryReason) return await pauseForReconciliation(step, idempotencyKey, recoveryReason);
        const errorCode = error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : "BANK_WRITE_FAILED";
        await this.repository.recordStep({ executionId, planStepId: step.id, stepId, idempotencyKey, status: "FAILED", errorCode, traceId });
        const failed = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "FAILED", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: snapshot.stateVersion, steps: [...stepResults, { stepId: step.id, status: "FAILED", idempotencyKey, errorCode }], goalOutcome: { achieved: false, summary: `Execution failed at step ${step.id}.` } });
        await this.repository.finishExecution({ executionId, result: failed, traceId }); return failed;
      }
    }
    const completed = ExecutionResultV1.parse({ schemaVersion: "1", executionId, planId: storedPlan.plan.id, status: "COMPLETED", startedStateVersion: execution.result.startedStateVersion, finalStateVersion: expectedStateVersion, steps: stepResults, goalOutcome: storedBundle ? { achieved: true, summary: "All confirmed actions in the combined request were completed." } : outcome(storedGoal!.contract, storedPlan.plan) });
    await this.repository.finishExecution({ executionId, result: completed, traceId }); return completed;
  }
  get(id: string) { return this.repository.getExecution(id); }
  async detail(id: string) {
    const execution = await this.repository.getExecution(id); if (!execution) return null;
    const plan = await this.repository.getPlan(execution.result.planId);
    const goal = plan && plan.ownerType !== "BUNDLE" ? await this.repository.getConfirmedGoal(plan.plan.goalContractId) : null;
    const bundleRepository = this.repository as ParlanceRepository & Partial<BundlePlanRepository>;
    const goalBundle = plan?.ownerType === "BUNDLE" && bundleRepository.getConfirmedGoalBundle ? await bundleRepository.getConfirmedGoalBundle(plan.plan.goalContractId) : null;
    const audit = (await this.repository.listAudit()).filter((item) => typeof item === "object" && item !== null && (("aggregateId" in item && item.aggregateId === id) || ("traceId" in item && item.traceId === execution.traceId)));
    return { state: execution.executionState, traceId: execution.traceId, result: execution.result, goal: goal?.contract, goalBundle: goalBundle?.contract, plan: plan?.plan, audit };
  }
  list() { return this.repository.listExecutions(); }
  listRecoverable() { return this.repository.listRecoverableExecutions(); }
}

function bundleItemGoal(bundle: GoalBundleContractV1, item: GoalBundleContractV1["items"][number], userId: string): GoalContractV1 {
  return GoalContractV1.parse({
    schemaVersion: "1", id: `${bundle.bundleId}:${item.itemId}`, userId, version: bundle.bundleVersion,
    goal: item.goal, constraints: [...bundle.globalConstraints, ...item.constraints], preferences: item.preferences,
    entityBindings: item.bindings, status: "CONFIRMED", contractHash: bundle.contractHash,
    createdAt: "1970-01-01T00:00:00.000Z", confirmedAt: "1970-01-01T00:00:00.000Z",
  });
}

function bundleStepPreservesConstraints(bundle: GoalBundleContractV1, step: FinancialPlanStepV1, snapshot: BankStateSnapshotV1, userId: string): boolean {
  return bundle.items.every((item) => {
    const goal = bundleItemGoal(bundle, item, userId);
    const stateDependent = goal.constraints.filter((constraint) => constraint.type === "EXCLUDED_ACCOUNT" || constraint.type === "MIN_AVAILABLE_BALANCE");
    return stepPreservesConstraints({ ...goal, constraints: stateDependent }, step, snapshot);
  });
}

function bundleCoveredGoalsSatisfied(bundle: GoalBundleContractV1, proof: BundleSatisfactionProofV1 | undefined, step: FinancialPlanStepV1, snapshot: BankStateSnapshotV1, userId: string): boolean {
  if (!proof || !proof.allHardConstraintsSatisfied) return false;
  const terminalItems = proof.itemCoverage.filter((coverage) => coverage.satisfiedByStepIds.at(-1) === step.id);
  return terminalItems.every((coverage) => {
    const item = bundle.items.find((candidate) => candidate.itemId === coverage.itemId);
    return item !== undefined && terminalStepSatisfiesGoal(bundleItemGoal(bundle, item, userId), step, snapshot);
  });
}

function simulateRemainingBundle(bundle: GoalBundleContractV1, proof: BundleSatisfactionProofV1 | undefined, steps: readonly FinancialPlanStepV1[], initialSnapshot: BankStateSnapshotV1, userId: string): boolean {
  if (!proof) return false;
  let snapshot = initialSnapshot;
  for (const step of steps) {
    const simulation = simulateFinancialStep(snapshot, step);
    if (simulation.outcome !== "SAFE_TO_EXECUTE" || !bundleStepPreservesConstraints(bundle, step, simulation.snapshot, userId)
      || !bundleCoveredGoalsSatisfied(bundle, proof, step, simulation.snapshot, userId)) return false;
    snapshot = simulation.snapshot;
  }
  return true;
}

function outcome(goal: GoalContractV1, plan: FinancialPlanV1): ExecutionResultV1["goalOutcome"] {
  if (goal.goal.type === "DELIVER_MONEY") return { achieved: true, summary: "Requested funds were delivered.", deliveredMoney: goal.goal.amount };
  if (goal.goal.type === "ACQUIRE_ASSET") { const acquired = plan.projectedOutcome.acquiredAssets[0]; return acquired ? { achieved: true, summary: "Requested asset was acquired.", acquiredAsset: acquired } : { achieved: true, summary: "Asset acquisition plan completed." }; }
  return { achieved: true, summary: "The confirmed financial goal was completed." };
}
