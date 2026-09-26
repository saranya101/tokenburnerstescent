import type { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, IntentDraftV1 } from "@parlance/contracts";
import type { GoalContractCandidate } from "@parlance/intent-engine";

export interface StoredGoal { rowId: string; contract: GoalContractV1 }
export interface StoredPlan { goalRowId: string; plan: FinancialPlanV1 }
export interface StoredApproval { approval: ApprovalV1; revokedAt?: string }
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
}
export interface GoalConfirmationMetadata {
  schemaVersion: "1";
  goalContractId: string;
  goalContractVersion: number;
  contractHash: string;
  confirmedAt: string;
  confirmationType: "EXPLICIT_USER_CONFIRMATION";
}

export interface GoalConfirmationRepository {
  saveGoalCandidate(input: StoredGoalCandidate & { originalText: string; intentDraft: IntentDraftV1; traceId: string }): Promise<StoredGoalCandidate>;
  getGoalCandidate(candidateId: string): Promise<StoredGoalCandidate | null>;
  confirmGoal(input: { candidateId: string; contract: GoalContractV1; confirmation: GoalConfirmationMetadata; traceId: string }): Promise<StoredGoal>;
}

export interface ParlanceRepository {
  getConfirmedGoal(contractId: string): Promise<StoredGoal | null>;
  saveSnapshot(snapshot: BankStateSnapshotV1, traceId: string): Promise<void>;
  savePlan(goalRowId: string, plan: FinancialPlanV1, traceId: string): Promise<void>;
  saveCompilationFailure(goalRowId: string, result: Exclude<CompilerResultV1, { status: "SAT" }>, traceId: string): Promise<void>;
  getPlan(planId: string): Promise<StoredPlan | null>;
  approvePlan(input: { goalRowId: string; approval: ApprovalV1; executionId: string; traceId: string }): Promise<StoredExecution>;
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

export interface CompilerPort { compile(goal: GoalContractV1, state: BankStateSnapshotV1, traceId: string): Promise<CompilerResultV1> }
export interface BankWriteResult { accepted: true; bankReference: string; stateVersion: number }
export interface BankPort {
  getState(userId: string, traceId: string): Promise<BankStateSnapshotV1>;
  execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<BankWriteResult>;
}
