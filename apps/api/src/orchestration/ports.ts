import type { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";

export interface StoredGoal { rowId: string; contract: GoalContractV1 }
export interface StoredPlan { goalRowId: string; plan: FinancialPlanV1 }
export interface StoredApproval { approval: ApprovalV1; revokedAt?: string }
export interface StoredExecution { result: ExecutionResultV1; approvalId: string; traceId: string }

export interface ParlanceRepository {
  getConfirmedGoal(contractId: string): Promise<StoredGoal | null>;
  saveSnapshot(snapshot: BankStateSnapshotV1, traceId: string): Promise<void>;
  savePlan(goalRowId: string, plan: FinancialPlanV1, traceId: string): Promise<void>;
  saveCompilationFailure(goalRowId: string, result: Exclude<CompilerResultV1, { status: "SAT" }>, traceId: string): Promise<void>;
  getPlan(planId: string): Promise<StoredPlan | null>;
  approvePlan(input: { goalRowId: string; approval: ApprovalV1; executionId: string; traceId: string }): Promise<StoredExecution>;
  getApproval(approvalId: string): Promise<StoredApproval | null>;
  getExecution(executionId: string): Promise<StoredExecution | null>;
  claimIdempotency(input: { key: string; scope: string; requestHash: string }): Promise<"CLAIMED" | "REPLAY" | "CONFLICT">;
  completeIdempotency(key: string, response: unknown): Promise<void>;
  startExecution(executionId: string, traceId: string): Promise<void>;
  recordStep(input: { executionId: string; planStepId: string; stepId: string; idempotencyKey: string; status: "PENDING" | "ACCEPTED" | "SETTLED" | "FAILED" | "UNKNOWN"; bankReference?: string; errorCode?: string; resultingStateVersion?: number; traceId: string }): Promise<void>;
  finishExecution(input: { executionId: string; result: ExecutionResultV1; traceId: string }): Promise<void>;
  listExecutions(): Promise<StoredExecution[]>;
  listAudit(): Promise<unknown[]>;
}

export interface CompilerPort { compile(goal: GoalContractV1, state: BankStateSnapshotV1, traceId: string): Promise<CompilerResultV1> }
export interface BankWriteResult { accepted: true; bankReference: string; stateVersion: number }
export interface BankPort {
  getState(userId: string, traceId: string): Promise<BankStateSnapshotV1>;
  execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<BankWriteResult>;
}
