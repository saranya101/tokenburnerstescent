import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@parlance/db";
import { ApprovalV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, IntentDraftV1, type CompilerResultV1 } from "@parlance/contracts";
import { GoalContractCandidateV1 } from "@parlance/intent-engine";
import type { GoalConfirmationRepository, ParlanceRepository, StoredApproval, StoredExecution, StoredGoal, StoredGoalCandidate, StoredPlan } from "../orchestration/ports.js";
import type { ApprovalPayload, NewWebAuthnChallenge, NewWebAuthnCredential, StoredWebAuthnChallenge, StoredWebAuthnCredential, WebAuthnRepository } from "../webauthn/types.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

function transports(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type CredentialRow = Prisma.WebAuthnCredentialGetPayload<Record<string, never>>;
function mapWebAuthnCredential(row: CredentialRow): StoredWebAuthnCredential {
  return { ...row, signCount: Number(row.signCount), publicKey: bytes(row.publicKey), userHandle: bytes(row.userHandle), transports: transports(row.transports) };
}

type ChallengeRow = Prisma.WebAuthnChallengeGetPayload<Record<string, never>>;
function mapWebAuthnChallenge(row: ChallengeRow): StoredWebAuthnChallenge {
  return {
    ...row,
    userHandle: row.userHandle ? bytes(row.userHandle) : null,
    approvalPayload: row.approvalPayload as ApprovalPayload | null,
  };
}

type GoalRow = Prisma.GoalContractGetPayload<{ include: { constraints: true; entityBindings: true } }>;
function mapGoal(row: GoalRow): StoredGoal {
  const constraints = row.constraints.slice().sort((left, right) => constraintSequence(left.payload) - constraintSequence(right.payload) || left.id.localeCompare(right.id)).map((item) => {
    const payload = item.payload as Record<string, unknown>;
    const semanticPayload = { ...payload };
    delete semanticPayload.__sequence;
    return { type: item.type, ...semanticPayload };
  });
  return { rowId: row.id, contract: GoalContractV1.parse({
    schemaVersion: row.schemaVersion, id: row.contractKey, userId: row.userId, version: row.version,
    ...(row.sourceIntentDraftId ? { sourceIntentDraftId: row.sourceIntentDraftId } : {}), goal: row.goalPayload,
    constraints, preferences: row.preferences,
    entityBindings: row.entityBindings.slice().sort((left, right) => left.reference.localeCompare(right.reference) || left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId)).map((item) => ({ schemaVersion: "1", reference: item.reference, entityType: item.entityType, entityId: item.entityId, resolutionMethod: item.resolutionMethod, ...(item.confidence ? { confidence: item.confidence.toString() } : {}), confirmed: item.confirmed })),
    status: row.status, contractHash: row.contractHash, createdAt: row.createdAt.toISOString(), ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
  }) };
}

function constraintSequence(value: Prisma.JsonValue): number {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.__sequence === "number" ? value.__sequence : Number.MAX_SAFE_INTEGER;
}

type IntentDraftRow = Prisma.IntentDraftRecordGetPayload<Record<string, never>>;
function mapGoalCandidate(row: IntentDraftRow): StoredGoalCandidate {
  if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) throw new Error("GOAL_CANDIDATE_INVALID");
  const payload = row.payload as Record<string, unknown>;
  if (payload.kind !== "GOAL_CANDIDATE_V1" || typeof payload.goalContractId !== "string" || typeof payload.version !== "number") throw new Error("GOAL_CANDIDATE_INVALID");
  return {
    candidateId: row.id, goalContractId: payload.goalContractId, userId: row.userId, version: payload.version,
    createdAt: row.createdAt.toISOString(), candidate: GoalContractCandidateV1.parse(payload.candidate),
  };
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
  return { approvalId: row.approvalId, traceId: row.traceId, executionState: row.status, result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: row.id, planId: row.planId,
    status, startedStateVersion: row.startedStateVersion, ...(row.finalStateVersion === null ? {} : { finalStateVersion: row.finalStateVersion }),
    steps: row.steps.map((step) => ({ stepId: step.planStep.stepKey, status: step.status, idempotencyKey: step.idempotencyKey,
      ...(step.bankReference ? { bankReference: step.bankReference } : {}), ...(step.errorCode ? { errorCode: step.errorCode } : {}) })),
    goalOutcome: row.goalOutcome ?? { achieved: false, summary: "Execution has not completed." } }) };
}

const event = (eventType: string, aggregateType: string, aggregateId: string, traceId: string, payload: unknown) => ({
  audit: { eventType, aggregateType, aggregateId, traceId, payload: json(payload) },
  outbox: { topic: eventType, aggregateId, traceId, payload: json(payload) },
});

export class PrismaParlanceRepository implements ParlanceRepository, GoalConfirmationRepository, WebAuthnRepository {
  constructor(private readonly db: PrismaClient, private readonly options: { afterExecutionUpdate?: () => void } = {}) {}

  async getConfirmedGoal(contractId: string): Promise<StoredGoal | null> {
    const row = await this.db.goalContract.findFirst({ where: { contractKey: contractId, status: "CONFIRMED" }, orderBy: { version: "desc" }, include: { constraints: true, entityBindings: true } });
    return row ? mapGoal(row) : null;
  }
  async saveGoalCandidate(input: Parameters<GoalConfirmationRepository["saveGoalCandidate"]>[0]): Promise<StoredGoalCandidate> {
    const intentDraft = IntentDraftV1.parse(input.intentDraft);
    const candidate = GoalContractCandidateV1.parse(input.candidate);
    const createdAt = new Date(input.createdAt);
    const row = await this.db.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({ data: { userId: input.userId, createdAt, messages: { create: { role: "USER", content: input.originalText, traceId: input.traceId, createdAt } } } });
      return tx.intentDraftRecord.create({ data: {
        id: input.candidateId, userId: input.userId, conversationId: conversation.id, schemaVersion: intentDraft.schemaVersion,
        payload: json({ kind: "GOAL_CANDIDATE_V1", goalContractId: input.goalContractId, version: input.version, intentDraft, candidate }),
        status: "AWAITING_GOAL_CONFIRMATION", createdAt,
      } });
    });
    return mapGoalCandidate(row);
  }
  async getGoalCandidate(candidateId: string): Promise<StoredGoalCandidate | null> {
    const row = await this.db.intentDraftRecord.findUnique({ where: { id: candidateId } });
    return row ? mapGoalCandidate(row) : null;
  }
  async confirmGoal(input: Parameters<GoalConfirmationRepository["confirmGoal"]>[0]): Promise<StoredGoal> {
    const contract = GoalContractV1.parse(input.contract);
    if (contract.status !== "CONFIRMED" || contract.confirmedAt === undefined || contract.sourceIntentDraftId !== input.candidateId) throw new Error("GOAL_CONFIRMATION_INVALID");
    const confirmedAt = contract.confirmedAt;
    const row = await this.db.$transaction(async (tx) => {
      const claimed = await tx.intentDraftRecord.updateMany({ where: { id: input.candidateId, userId: contract.userId, status: "AWAITING_GOAL_CONFIRMATION" }, data: { status: "CONFIRMED" } });
      if (claimed.count === 0) {
        const existing = await tx.goalContract.findFirst({ where: { sourceIntentDraftId: input.candidateId, contractKey: contract.id, version: contract.version, status: "CONFIRMED" }, include: { constraints: true, entityBindings: true } });
        if (existing) return existing;
        throw new Error("GOAL_CANDIDATE_NOT_CONFIRMABLE");
      }
      const goalRowId = randomUUID();
      const created = await tx.goalContract.create({ data: {
        id: goalRowId, contractKey: contract.id, version: contract.version, userId: contract.userId, sourceIntentDraftId: input.candidateId,
        status: "CONFIRMED", schemaVersion: contract.schemaVersion, goalPayload: json(contract.goal), preferences: json(contract.preferences),
        contractHash: contract.contractHash, createdAt: new Date(contract.createdAt), confirmedAt: new Date(confirmedAt),
        constraints: { create: contract.constraints.map(({ type, ...payload }, index) => ({ type, payload: json({ ...payload, __sequence: index }) })) },
        entityBindings: { create: contract.entityBindings.map((binding) => ({ reference: binding.reference, entityType: binding.entityType, entityId: binding.entityId, resolutionMethod: binding.resolutionMethod, ...(binding.confidence === undefined ? {} : { confidence: binding.confidence }), confirmed: binding.confirmed })) },
      }, include: { constraints: true, entityBindings: true } });
      const e = event("GOAL_CONFIRMED", "GoalContract", contract.id, input.traceId, input.confirmation);
      await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox });
      return created;
    });
    return mapGoal(row);
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
  async getLatestSettledStateVersion(executionId: string): Promise<number | null> { const step = await this.db.executionStep.findFirst({ where: { executionRunId: executionId, status: "SETTLED", resultingStateVersion: { not: null } }, orderBy: { planStep: { sequence: "desc" } }, select: { resultingStateVersion: true } }); return step?.resultingStateVersion ?? null; }
  async claimIdempotency(input: { key: string; scope: string; requestHash: string }): ReturnType<ParlanceRepository["claimIdempotency"]> { const prior = await this.db.idempotencyRecord.findUnique({ where: { key: input.key } }); if (prior) return prior.scope === input.scope && prior.requestHash === input.requestHash ? { status: "REPLAY", ...(prior.response === null ? {} : { response: prior.response }) } : { status: "CONFLICT" }; try { await this.db.idempotencyRecord.create({ data: input }); return { status: "CLAIMED" }; } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error; const raced = await this.db.idempotencyRecord.findUniqueOrThrow({ where: { key: input.key } }); return raced.scope === input.scope && raced.requestHash === input.requestHash ? { status: "REPLAY", ...(raced.response === null ? {} : { response: raced.response }) } : { status: "CONFLICT" }; } }
  async completeIdempotency(key: string, response: unknown): Promise<void> { await this.db.idempotencyRecord.update({ where: { key }, data: { response: json(response) } }); }
  async startExecution(id: string, traceId: string): Promise<void> { const e = event("EXECUTION_STARTED", "ExecutionRun", id, traceId, { status: "EXECUTING" }); await this.db.$transaction(async (tx) => { await tx.executionRun.update({ where: { id }, data: { status: "EXECUTING" } }); this.options.afterExecutionUpdate?.(); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); }); }
  async blockExecution(input: Parameters<ParlanceRepository["blockExecution"]>[0]): Promise<void> {
    const payload = { state: input.state, reason: input.reason, explanation: input.explanation };
    const e = event("EXECUTION_BLOCKED", "ExecutionRun", input.executionId, input.traceId, payload);
    await this.db.$transaction(async (tx) => {
      await tx.executionRun.update({ where: { id: input.executionId }, data: { status: input.state, ...(input.result.finalStateVersion === undefined ? {} : { finalStateVersion: input.result.finalStateVersion }), goalOutcome: json(input.result.goalOutcome) } });
      await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox });
    });
  }
  async recordExecutionAudit(input: Parameters<ParlanceRepository["recordExecutionAudit"]>[0]): Promise<void> {
    await this.db.auditEvent.create({ data: { eventType: input.eventType, aggregateType: "ExecutionRun", aggregateId: input.executionId, traceId: input.traceId, payload: json(input.payload) } });
  }
  async recordStep(input: Parameters<ParlanceRepository["recordStep"]>[0]): Promise<void> {
    const planStep = await this.db.financialPlanStep.findFirstOrThrow({ where: { plan: { executionRuns: { some: { id: input.executionId } } }, stepKey: input.planStepId } });
    const data = { status: input.status, ...(input.bankReference ? { bankReference: input.bankReference } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}), ...(input.resultingStateVersion === undefined ? {} : { resultingStateVersion: input.resultingStateVersion }), traceId: input.traceId };
    const e = event("EXECUTION_STEP_UPDATED", "ExecutionRun", input.executionId, input.traceId, { stepId: input.planStepId, status: input.status, resultingStateVersion: input.resultingStateVersion });
    await this.db.$transaction(async (tx) => { await tx.executionStep.upsert({ where: { executionRunId_planStepId: { executionRunId: input.executionId, planStepId: planStep.id } }, create: { id: input.stepId, executionRunId: input.executionId, planStepId: planStep.id, idempotencyKey: input.idempotencyKey, ...data }, update: data }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); });
  }
  async finishExecution(input: Parameters<ParlanceRepository["finishExecution"]>[0]): Promise<void> { const status = input.result.status === "COMPLETED" ? "COMPLETED" : input.result.status === "FAILED" ? "FAILED" : "PAUSED"; const e = event(`EXECUTION_${input.result.status}`, "ExecutionRun", input.executionId, input.traceId, input.result); await this.db.$transaction(async (tx) => { await tx.executionRun.update({ where: { id: input.executionId }, data: { status, ...(input.result.finalStateVersion === undefined ? {} : { finalStateVersion: input.result.finalStateVersion }), goalOutcome: json(input.result.goalOutcome) } }); await tx.auditEvent.create({ data: e.audit }); await tx.outboxEvent.create({ data: e.outbox }); }); }
  async listExecutions(): Promise<StoredExecution[]> { const rows = await this.db.executionRun.findMany({ orderBy: { createdAt: "desc" }, include: { steps: { include: { planStep: true } } }, take: 100 }); return rows.map(mapExecution); }
  async listRecoverableExecutions(): Promise<StoredExecution[]> { const rows = await this.db.executionRun.findMany({ where: { status: { in: ["AUTHORIZED", "EXECUTING", "PAUSED", "REAPPROVAL_REQUIRED"] } }, orderBy: { updatedAt: "asc" }, include: { steps: { include: { planStep: true } } } }); return rows.map(mapExecution); }
  async listAudit(): Promise<unknown[]> { return this.db.auditEvent.findMany({ orderBy: { occurredAt: "desc" }, take: 100 }); }
  async isReady(): Promise<boolean> { try { await this.db.$queryRaw`SELECT 1`; return true; } catch { return false; } }

  async webAuthnUserExists(userId: string): Promise<boolean> {
    return (await this.db.user.count({ where: { id: userId } })) === 1;
  }
  async createWebAuthnChallenge(input: NewWebAuthnChallenge): Promise<StoredWebAuthnChallenge> {
    const row = await this.db.webAuthnChallenge.create({ data: {
      id: input.id, userId: input.userId, purpose: input.purpose, challenge: input.challenge,
      ...(input.userHandle ? { userHandle: bytes(input.userHandle) } : {}), expectedRpId: input.expectedRpId,
      expectedOrigin: input.expectedOrigin, ...(input.financialPlanId ? { financialPlanId: input.financialPlanId } : {}),
      ...(input.approvalPayload ? { approvalPayload: json(input.approvalPayload) } : {}),
      ...(input.approvalPayloadHash ? { approvalPayloadHash: input.approvalPayloadHash } : {}), expiresAt: input.expiresAt,
    } });
    return mapWebAuthnChallenge(row);
  }
  async getWebAuthnChallenge(id: string): Promise<StoredWebAuthnChallenge | null> {
    const row = await this.db.webAuthnChallenge.findUnique({ where: { id } });
    return row ? mapWebAuthnChallenge(row) : null;
  }
  async expireWebAuthnChallenge(id: string, now: Date): Promise<boolean> {
    const result = await this.db.webAuthnChallenge.updateMany({ where: { id, status: "ISSUED", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
    return result.count === 1;
  }
  async revokeWebAuthnChallenge(id: string, now: Date): Promise<boolean> {
    const result = await this.db.webAuthnChallenge.updateMany({ where: { id, status: "ISSUED" }, data: { status: "REVOKED", revokedAt: now } });
    return result.count === 1;
  }
  async consumeRegistrationChallenge(input: { challengeId: string; userId: string; now: Date; credential: NewWebAuthnCredential }): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const claimed = await tx.webAuthnChallenge.updateMany({ where: {
          id: input.challengeId, userId: input.userId, purpose: "REGISTRATION", status: "ISSUED",
          revokedAt: null, expiresAt: { gt: input.now },
        }, data: { status: "CONSUMED", consumedAt: input.now } });
        if (claimed.count !== 1) return false;
        await tx.webAuthnCredential.create({ data: {
          id: input.credential.id, userId: input.credential.userId, credentialId: input.credential.credentialId,
          publicKey: bytes(input.credential.publicKey), userHandle: bytes(input.credential.userHandle),
          signCount: BigInt(input.credential.signCount), transports: json(input.credential.transports),
          deviceType: input.credential.deviceType, backedUp: input.credential.backedUp,
        } });
        return true;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new Error("WEBAUTHN_CREDENTIAL_ALREADY_REGISTERED");
      throw error;
    }
  }
  async saveWebAuthnCredential(input: NewWebAuthnCredential): Promise<StoredWebAuthnCredential> {
    const row = await this.db.webAuthnCredential.create({ data: {
      id: input.id, userId: input.userId, credentialId: input.credentialId, publicKey: bytes(input.publicKey),
      userHandle: bytes(input.userHandle), signCount: BigInt(input.signCount), transports: json(input.transports),
      deviceType: input.deviceType, backedUp: input.backedUp,
    } });
    return mapWebAuthnCredential(row);
  }
  async getWebAuthnCredential(credentialId: string): Promise<StoredWebAuthnCredential | null> {
    const row = await this.db.webAuthnCredential.findUnique({ where: { credentialId } });
    return row ? mapWebAuthnCredential(row) : null;
  }
  async listActiveWebAuthnCredentials(userId: string): Promise<StoredWebAuthnCredential[]> {
    return (await this.db.webAuthnCredential.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: "asc" } })).map(mapWebAuthnCredential);
  }
  async revokeWebAuthnCredential(credentialId: string, userId: string, now: Date): Promise<boolean> {
    const result = await this.db.webAuthnCredential.updateMany({ where: { credentialId, userId, revokedAt: null }, data: { revokedAt: now } });
    return result.count === 1;
  }
}
