import type { ApprovalV1, BankStateSnapshotV1, BundleSatisfactionProofV1, CompileGoalBundleRequestV1, CompileGoalBundleResultV1, CompilerResultV1, ConstraintV1, ExecutionResultV1, FinancialPlanV1, GoalBundleContractV1, GoalBundleItemV1, GoalContractV1, GoalDependencyV1, IntentBundleDraftV1, IntentDraftV1 } from "@parlance/contracts";
import type { ClarificationItem, EntityGroundingResult, GoalContractCandidate, IntentBundleItemGroundingResults, IntentValidationMismatch } from "@parlance/intent-engine";
import type { StoredApprovalEvidence } from "../webauthn/types.js";
import type { ConversationalInputProvenance } from "./input-provenance.js";

export interface StoredGoal { rowId: string; contract: GoalContractV1 }
export interface StoredGoalBundle { rowId: string; userId: string; contract: GoalBundleContractV1 }
export type StoredPlanStatus = "DRAFT" | "READY" | "SUPERSEDED" | "FAILED";
export interface StoredPlan { goalRowId: string; ownerType?: "GOAL" | "BUNDLE"; status: StoredPlanStatus; plan: FinancialPlanV1; satisfactionProof?: BundleSatisfactionProofV1 }
export interface StoredApproval { approval: ApprovalV1; evidence?: StoredApprovalEvidence; revokedAt?: string }
export type RecoverableExecutionState = "AUTHORIZED" | "EXECUTING" | "PAUSED" | "REAPPROVAL_REQUIRED";
export interface StoredExecution { result: ExecutionResultV1; approvalId: string; traceId: string; executionState: RecoverableExecutionState | "COMPLETED" | "FAILED" }
export type IdempotencyClaim = { status: "CLAIMED" } | { status: "REPLAY"; response?: unknown } | { status: "CONFLICT" };
export interface StoredGoalCandidate {
  candidateId: string;
  goalContractId: string;
  userId: string;
  version: number;
  createdAt: string;
  candidate: GoalContractCandidate;
  inputProvenance?: ConversationalInputProvenance;
}
export interface StoredClarificationRequest {
  clarificationId: string;
  goalContractId: string;
  userId: string;
  version: number;
  createdAt: string;
  originalText: string;
  intentDraft: IntentDraftV1;
  groundingResults: readonly EntityGroundingResult[];
  clarifications: readonly ClarificationItem[];
  inputProvenance?: ConversationalInputProvenance;
  clarificationAnswers?: readonly string[];
}
export type ClarificationProgress =
  | { status: "NEEDS_CLARIFICATION"; request: StoredClarificationRequest }
  | { status: "AWAITING_GOAL_CONFIRMATION"; candidate: StoredGoalCandidate };
export interface GoalConfirmationMetadata {
  schemaVersion: "1";
  goalContractId: string;
  goalContractVersion: number;
  contractHash: string;
  confirmedAt: string;
  confirmationType: "EXPLICIT_USER_CONFIRMATION";
}
export interface SemanticValidationEvidence {
  decision: "PASS" | "FAIL";
  mismatches: readonly Pick<IntentValidationMismatch, "code" | "field">[];
  input: ConversationalInputProvenance;
  clarificationAnswers: readonly string[];
}

export interface GoalBundleCandidate {
  schemaVersion: "1";
  items: GoalBundleItemV1[];
  globalConstraints: ConstraintV1[];
  explicitDependencies: GoalDependencyV1[];
}
export interface BundleClarificationAnswer { field: string; originalReference: string; answer: string }
export interface StoredBundleCandidate {
  candidateId: string;
  bundleId: string;
  userId: string;
  version: number;
  createdAt: string;
  originalText: string;
  intentBundle: IntentBundleDraftV1;
  candidate: GoalBundleCandidate;
  clarificationAnswers: readonly BundleClarificationAnswer[];
  inputProvenance?: ConversationalInputProvenance;
}
export interface StoredBundleClarification {
  clarificationId: string;
  bundleId: string;
  userId: string;
  version: number;
  createdAt: string;
  originalText: string;
  intentBundle: IntentBundleDraftV1;
  itemGroundingResults: readonly IntentBundleItemGroundingResults[];
  globalGroundingResults: readonly EntityGroundingResult[];
  clarifications: readonly ClarificationItem[];
  clarificationAnswers: readonly BundleClarificationAnswer[];
  inputProvenance?: ConversationalInputProvenance;
}
export type BundleClarificationProgress =
  | { status: "NEEDS_CLARIFICATION"; request: StoredBundleClarification }
  | { status: "AWAITING_BUNDLE_CONFIRMATION"; candidate: StoredBundleCandidate };

export interface BundleConfirmationRepository {
  saveBundleClarification(input: StoredBundleClarification & { inputProvenance: ConversationalInputProvenance; traceId: string }): Promise<StoredBundleClarification>;
  getBundleClarification(clarificationId: string): Promise<StoredBundleClarification | null>;
  advanceBundleClarification(input: StoredBundleClarification & { candidate?: GoalBundleCandidate; semanticValidation?: SemanticValidationEvidence; answerText: string; traceId: string }): Promise<BundleClarificationProgress>;
  saveBundleCandidate(input: StoredBundleCandidate & { inputProvenance: ConversationalInputProvenance; semanticValidation: SemanticValidationEvidence; traceId: string }): Promise<StoredBundleCandidate>;
  getBundleCandidate(candidateId: string): Promise<StoredBundleCandidate | null>;
  rejectBundleSemanticValidation(input: { recordId: string; userId: string; schemaVersion: string; createdAt: string; originalText: string; inputProvenance: ConversationalInputProvenance; answerText?: string; validation: SemanticValidationEvidence; traceId: string }): Promise<void>;
  confirmGoalBundle(input: { candidateId: string; userId: string; contract: GoalBundleContractV1; confirmedAt: string; traceId: string }): Promise<StoredGoalBundle>;
}

export interface GoalConfirmationRepository {
  saveClarification(input: StoredClarificationRequest & { inputProvenance: ConversationalInputProvenance; traceId: string }): Promise<StoredClarificationRequest>;
  getClarification(clarificationId: string): Promise<StoredClarificationRequest | null>;
  advanceClarification(input: { clarificationId: string; answerText: string; groundingResults: readonly EntityGroundingResult[]; clarifications: readonly ClarificationItem[]; candidate?: GoalContractCandidate; semanticValidation?: SemanticValidationEvidence; traceId: string }): Promise<ClarificationProgress>;
  saveGoalCandidate(input: StoredGoalCandidate & { originalText: string; inputProvenance: ConversationalInputProvenance; intentDraft: IntentDraftV1; semanticValidation: SemanticValidationEvidence; traceId: string }): Promise<StoredGoalCandidate>;
  rejectSemanticValidation(input: { recordId: string; userId: string; schemaVersion: string; createdAt: string; originalText: string; inputProvenance: ConversationalInputProvenance; answerText?: string; validation: SemanticValidationEvidence; traceId: string }): Promise<void>;
  getGoalCandidate(candidateId: string): Promise<StoredGoalCandidate | null>;
  confirmGoal(input: { candidateId: string; contract: GoalContractV1; confirmation: GoalConfirmationMetadata; traceId: string }): Promise<StoredGoal>;
}

export interface ParlanceRepository {
  getConfirmedGoal(contractId: string): Promise<StoredGoal | null>;
  saveSnapshot(snapshot: BankStateSnapshotV1, traceId: string): Promise<void>;
  savePlan(goalRowId: string, plan: FinancialPlanV1, traceId: string): Promise<void>;
  saveCompilationFailure(goalRowId: string, result: Exclude<CompilerResultV1, { status: "SAT" }>, traceId: string): Promise<void>;
  getPlan(planId: string): Promise<StoredPlan | null>;
  recordPlanAudit(input: { planId: string; eventType: string; traceId: string; payload: Record<string, unknown> }): Promise<void>;
  getApproval(approvalId: string): Promise<StoredApproval | null>;
  getExecution(executionId: string): Promise<StoredExecution | null>;
  getLatestSettledStateVersion(executionId: string): Promise<number | null>;
  claimIdempotency(input: { key: string; scope: string; requestHash: string }): Promise<IdempotencyClaim>;
  completeIdempotency(key: string, response: unknown): Promise<void>;
  startExecution(executionId: string, traceId: string): Promise<void>;
  blockExecution(input: { executionId: string; state: "PAUSED" | "REAPPROVAL_REQUIRED"; reason: string; explanation: string; result: ExecutionResultV1; traceId: string }): Promise<void>;
  recordExecutionAudit(input: { executionId: string; eventType: string; traceId: string; payload: Record<string, unknown> }): Promise<void>;
  recordStep(input: { executionId: string; planStepId: string; stepId: string; idempotencyKey: string; status: "PENDING" | "ACCEPTED" | "SETTLED" | "FAILED" | "UNKNOWN"; bankReference?: string; errorCode?: string; resultingStateVersion?: number; traceId: string }): Promise<void>;
  finishExecution(input: { executionId: string; result: ExecutionResultV1; traceId: string }): Promise<void>;
  listExecutions(): Promise<StoredExecution[]>;
  listRecoverableExecutions(): Promise<StoredExecution[]>;
  listAudit(): Promise<unknown[]>;
  isReady(): Promise<boolean>;
}

export interface BundlePlanRepository {
  getConfirmedGoalBundle(bundleId: string): Promise<StoredGoalBundle | null>;
  saveBundlePlan(bundleRowId: string, plan: FinancialPlanV1, proof: BundleSatisfactionProofV1, traceId: string): Promise<void>;
  saveBundleCompilationFailure(bundleRowId: string, result: Exclude<CompilerResultV1, { status: "SAT" }>, traceId: string): Promise<void>;
}

export type BundleCompilerResult = CompileGoalBundleResultV1 | Exclude<CompilerResultV1, { status: "SAT" }>;
export interface CompilerPort {
  compile(goal: GoalContractV1, state: BankStateSnapshotV1, traceId: string): Promise<CompilerResultV1>;
  compileBundle?(request: CompileGoalBundleRequestV1, traceId: string): Promise<BundleCompilerResult>;
}
export interface BankWriteResult { accepted: true; bankReference: string; stateVersion: number }
export interface BankCompletedWrite extends BankWriteResult { idempotencyKey: string; operation: "fx" | "transfer" | "payment" | "buy"; requestHash: string }
export type BankLookupResult = { status: "NOT_FOUND"; idempotencyKey: string } | ({ status: "COMPLETED" } & BankCompletedWrite);
export class BankOutcomeUnknownError extends Error {
  constructor() { super("BANK_RESPONSE_OUTCOME_UNKNOWN"); this.name = "BankOutcomeUnknownError"; }
}
export interface BankPort {
  getState(userId: string, traceId: string): Promise<BankStateSnapshotV1>;
  execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<BankWriteResult>;
  lookupByIdempotencyKey(idempotencyKey: string, traceId: string): Promise<BankLookupResult>;
}
