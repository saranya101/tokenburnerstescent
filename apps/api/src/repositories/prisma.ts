import { Prisma, type PrismaClient } from "@parlance/db";
import { ApprovalV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, type CompilerResultV1 } from "@parlance/contracts";
import type { ParlanceRepository, StoredApproval, StoredExecution, StoredGoal, StoredPlan } from "../orchestration/ports.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

type GoalRow = Prisma.GoalContractGetPayload<{ include: { constraints: true; entityBindings: true } }>;
function mapGoal(row: GoalRow): StoredGoal {
  return { rowId: row.id, contract: GoalContractV1.parse({
    schemaVersion: row.schemaVersion, id: row.contractKey, userId: row.userId, version: row.version,
    ...(row.sourceIntentDraftId ? { sourceIntentDraftId: row.sourceIntentDraftId } : {}), goal: row.goalPayload,
    constraints: row.constraints.map((item) => ({ type: item.type, ...(item.payload as Record<string, unknown>) })), preferences: row.preferences,
    entityBindings: row.entityBindings.map((item) => ({ schemaVersion: "1", reference: item.reference, entityType: item.entityType, entityId: item.entityId, resolutionMethod: item.resolutionMethod, ...(item.confidence ? { confidence: item.confidence.toString() } : {}), confirmed: item.confirmed })),
    status: row.status, contractHash: row.contractHash, createdAt: row.createdAt.toISOString(), ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
  }) };
}

type PlanRow = Prisma.FinancialPlanGetPayload<{ include: { steps: true } }>;
function mapPlan(row: PlanRow): FinancialPlanV1 {
  return FinancialPlanV1.parse({ schemaVersion: row.schemaVersion, id: row.id, goalContractId: row.goalContractKey,
    goalContractVersion: row.goalContractVersion, bankStateVersion: row.bankStateVersion, compilerVersion: row.compilerVersion,
    policyVersion: row.policyVersion, operationLibraryVersion: row.operationLibraryVersion,
    steps: row.steps.sort((a, b) => a.sequence - b.sequence).map((step) => ({ id: step.stepKey, sequence: step.sequence, action: step.action, dependsOn: step.dependsOn, reversible: step.reversible, parameters: step.parameters })),
    validity: row.validity, projectedOutcome: row.projectedOutcome, planHash: row.planHash });
}

type ApprovalRow = Prisma.ApprovalGetPayload<Record<string, never>>;
function mapApproval(row: ApprovalRow): StoredApproval {
  return { approval: ApprovalV1.parse({ schemaVersion: "1", id: row.id, userId: row.userId, goalContractId: row.goalContractKey,
    goalContractVersion: row.goalContractVersion, goalContractHash: row.goalContractHash, financialPlanId: row.financialPlanId,
    financialPlanHash: row.financialPlanHash, bankStateVersion: row.bankStateVersion, method: row.method,
    approvedAt: row.approvedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), signatureReference: row.signatureReference }),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}) };
}

type ExecutionRow = Prisma.ExecutionRunGetPayload<{ include: { steps: { include: { planStep: true } } } }>;
function mapExecution(row: ExecutionRow): StoredExecution {
  const status = row.status === "AUTHORIZED" ? "PENDING" : row.status === "PAUSED" || row.status === "REAPPROVAL_REQUIRED" ? "UNKNOWN" : row.status;
  return { approvalId: row.approvalId, traceId: row.traceId, result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: row.id, planId: row.planId,
    status, startedStateVersion: row.startedStateVersion, ...(row.finalStateVersion === null ? {} : { finalStateVersion: row.finalStateVersion }),
    steps: row.steps.map((step) => ({ stepId: step.planStep.stepKey, status: step.status, idempotencyKey: step.idempotencyKey,
      ...(step.bankReference ? { bankReference: step.bankReference } : {}), ...(step.errorCode ? { errorCode: step.errorCode } : {}) })),
    goalOutcome: row.goalOutcome ?? { achieved: false, summary: "Execution has not completed." } }) };
}

const event = (eventType: string, aggregateType: string, aggregateId: string, traceId: string, payload: unknown) => ({
  audit: { eventType, aggregateType, aggregateId, traceId, payload: json(payload) },
  outbox: { topic: eventType, aggregateId, traceId, payload: json(payload) },
});

export class PrismaParlanceRepository implements ParlanceRepository {
  constructor(private readonly db: PrismaClient) {}

  async getConfirmedGoal(contractId: string): Promise<StoredGoal | null> {
    const row = await this.db.goalContract.findFirst({ where: { contractKey: contractId, status: "CONFIRMED" }, orderBy: { version: "desc" }, include: { constraints: true, entityBindings: true } });
    return row ? mapGoal(row) : null;
  }
  async saveSnapshot(snapshot: Parameters<ParlanceRepository["saveSnapshot"]>[0], traceId: string): Promise<void> {
    await this.db.bankStateSnapshot.upsert({ where: { userId_stateVersion: { userId: snapshot.userId, stateVersion: snapshot.stateVersion } },
      create: { userId: snapshot.userId, schemaVersion: snapshot.schemaVersion, stateVersion: snapshot.stateVersion, snapshot: json(snapshot), capturedAt: new Date(snapshot.capturedAt), traceId }, update: {} });
  }
  async savePlan(goalRowId: string, plan: FinancialPlanV1, traceId: string): Promise<void> {
    const e = event("PLAN_COMPILED", "FinancialPlan", plan.id, traceId, { planId: plan.id, planHash: plan.planHash });
    await this.db.$transaction(async (tx) => {
      await tx.financialPlan.create({ data: { id: plan.id, goalContractRowId: goalRowId, goalContractKey: plan.goalContractId, status: "READY", schemaVersion: plan.schemaVersion,
        goalContractVersion: plan.goalContractVersion, bankStateVersion: plan.bankStateVersion, compilerVersion: plan.compilerVersion, policyVersion: plan.policyVersion,
        operationLibraryVersion: plan.operationLibraryVersion, validity: json(plan.validity), projectedOutcome: json(plan.projectedOutcome), planHash: plan.planHash, traceId,
        steps: { create: plan.steps.map((step) => ({ stepKey: step.id, sequence: step.sequence, action: step.action, dependsOn: json(step.dependsOn), reversible: step.reversible, parameters: json(step.parameters) })) } } });
      await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox });
    });
  }
  async saveCompilationFailure(goalRowId: string, result: Exclude<CompilerResultV1, { status: "SAT" }>, traceId: string): Promise<void> {
    const e = event(`COMPILATION_${result.status}`, "GoalContract", goalRowId, traceId, result);
    await this.db.$transaction(async (tx) => { await tx.goalContract.update({ where: { id: goalRowId }, data: { status: "FAILED" } }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); });
  }
  async getPlan(planId: string): Promise<StoredPlan | null> {
    const row = await this.db.financialPlan.findUnique({ where: { id: planId }, include: { steps: true } });
    return row ? { goalRowId: row.goalContractRowId, plan: mapPlan(row) } : null;
  }
  async approvePlan(input: { goalRowId: string; approval: ApprovalV1; executionId: string; traceId: string }): Promise<StoredExecution> {
    const { approval, executionId, traceId } = input; const e = event("PLAN_APPROVED", "Approval", approval.id, traceId, { approvalId: approval.id, executionId });
    await this.db.$transaction(async (tx) => { await tx.approval.create({ data: { id: approval.id, userId: approval.userId, goalContractRowId: input.goalRowId, goalContractKey: approval.goalContractId,
      goalContractVersion: approval.goalContractVersion, goalContractHash: approval.goalContractHash, financialPlanId: approval.financialPlanId, financialPlanHash: approval.financialPlanHash,
      bankStateVersion: approval.bankStateVersion, method: approval.method, signatureReference: approval.signatureReference, approvedAt: new Date(approval.approvedAt), expiresAt: new Date(approval.expiresAt), traceId } });
      await tx.executionRun.create({ data: { id: executionId, userId: approval.userId, planId: approval.financialPlanId, approvalId: approval.id, status: "AUTHORIZED", startedStateVersion: approval.bankStateVersion, traceId } });
      await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); });
    const stored = await this.getExecution(executionId); if (!stored) throw new Error("Execution was not persisted"); return stored;
  }
  async getApproval(id: string): Promise<StoredApproval | null> { const row = await this.db.approval.findUnique({ where: { id } }); return row ? mapApproval(row) : null; }
  async getExecution(id: string): Promise<StoredExecution | null> { const row = await this.db.executionRun.findUnique({ where: { id }, include: { steps: { include: { planStep: true } } } }); return row ? mapExecution(row) : null; }
  async claimIdempotency(input: { key: string; scope: string; requestHash: string }): Promise<"CLAIMED" | "REPLAY" | "CONFLICT"> { const prior = await this.db.idempotencyRecord.findUnique({ where: { key: input.key } }); if (prior) return prior.scope === input.scope && prior.requestHash === input.requestHash ? "REPLAY" : "CONFLICT"; try { await this.db.idempotencyRecord.create({ data: input }); return "CLAIMED"; } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error; const raced = await this.db.idempotencyRecord.findUniqueOrThrow({ where: { key: input.key } }); return raced.scope === input.scope && raced.requestHash === input.requestHash ? "REPLAY" : "CONFLICT"; } }
  async completeIdempotency(key: string, response: unknown): Promise<void> { await this.db.idempotencyRecord.update({ where: { key }, data: { response: json(response) } }); }
  async startExecution(id: string, traceId: string): Promise<void> { const e = event("EXECUTION_STARTED", "ExecutionRun", id, traceId, { status: "EXECUTING" }); await this.db.$transaction(async (tx) => { await tx.executionRun.update({ where: { id }, data: { status: "EXECUTING" } }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); }); }
  async recordStep(input: Parameters<ParlanceRepository["recordStep"]>[0]): Promise<void> {
    const planStep = await this.db.financialPlanStep.findFirstOrThrow({ where: { plan: { executionRuns: { some: { id: input.executionId } } }, stepKey: input.planStepId } });
    const data = { status: input.status, ...(input.bankReference ? { bankReference: input.bankReference } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}), ...(input.resultingStateVersion === undefined ? {} : { resultingStateVersion: input.resultingStateVersion }), traceId: input.traceId };
    const e = event("EXECUTION_STEP_UPDATED", "ExecutionRun", input.executionId, input.traceId, { stepId: input.planStepId, status: input.status, resultingStateVersion: input.resultingStateVersion });
    await this.db.$transaction(async (tx) => { await tx.executionStep.upsert({ where: { executionRunId_planStepId: { executionRunId: input.executionId, planStepId: planStep.id } }, create: { id: input.stepId, executionRunId: input.executionId, planStepId: planStep.id, idempotencyKey: input.idempotencyKey, ...data }, update: data }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); });
  }
  async finishExecution(input: Parameters<ParlanceRepository["finishExecution"]>[0]): Promise<void> { const status = input.result.status === "COMPLETED" ? "COMPLETED" : input.result.status === "FAILED" ? "FAILED" : "PAUSED"; const e = event(`EXECUTION_${input.result.status}`, "ExecutionRun", input.executionId, input.traceId, input.result); await this.db.$transaction(async (tx) => { await tx.executionRun.update({ where: { id: input.executionId }, data: { status, ...(input.result.finalStateVersion === undefined ? {} : { finalStateVersion: input.result.finalStateVersion }), goalOutcome: json(input.result.goalOutcome) } }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); }); }
  async listExecutions(): Promise<StoredExecution[]> { const rows = await this.db.executionRun.findMany({ orderBy: { createdAt: "desc" }, include: { steps: { include: { planStep: true } } }, take: 100 }); return rows.map(mapExecution); }
  async listAudit(): Promise<unknown[]> { return this.db.auditEvent.findMany({ orderBy: { occurredAt: "desc" }, take: 100 }); }
}
