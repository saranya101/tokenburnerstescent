import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@parlance/db";
import { BankStateSnapshotV1, CompilerResultV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalService, CompilationService, ExecutionService } from "../orchestration/services.js";
import type { BankPort } from "../orchestration/ports.js";
import { canonicalGoalContractJson, hashGoalContract } from "../security/canonical-hash.js";
import { PrismaParlanceRepository } from "./prisma.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));
const ids = { user: "it-user-ntu", goalRow: "it-goal-row-ntu", goal: "it-goal-ntu", trace: "it-trace-ntu" };

async function mockBank(): Promise<BankPort> {
  const modulePath = join(process.cwd(), "../../services/mock-bank/src/app.ts"); const { buildApp } = await import(modulePath) as { buildApp(): FastifyInstance }; const app = buildApp();
  return { async getState(userId, traceId) { const response = await app.inject({ method: "GET", url: `/v1/state/${userId}`, headers: { "x-trace-id": traceId } }); const state = BankStateSnapshotV1.parse(response.json()); return BankStateSnapshotV1.parse({ ...state, fxQuotes: state.fxQuotes.map((quote, index) => index === 0 ? { ...quote, id: "quote-sgd-usd-1" } : quote) }); },
    async execute(path, payload, key, traceId) { const response = await app.inject({ method: "POST", url: `/v1/execute/${path}`, headers: { "idempotency-key": key, "x-trace-id": traceId, "content-type": "application/json" }, body: JSON.stringify(payload) }); if (response.statusCode >= 400) throw new Error(response.json().code); return response.json(); } };
}

async function cleanup(db: PrismaClient): Promise<void> {
  const runs = await db.executionRun.findMany({ where: { userId: ids.user }, select: { id: true } }); const runIds = runs.map((row) => row.id); const stepKeys = (await db.executionStep.findMany({ where: { executionRunId: { in: runIds } }, select: { idempotencyKey: true } })).map((row) => row.idempotencyKey);
  await db.executionStep.deleteMany({ where: { executionRunId: { in: runIds } } }); await db.executionRun.deleteMany({ where: { userId: ids.user } }); await db.approval.deleteMany({ where: { userId: ids.user } });
  await db.financialPlanStep.deleteMany({ where: { plan: { goalContractKey: ids.goal } } }); await db.financialPlan.deleteMany({ where: { goalContractKey: ids.goal } }); await db.bankStateSnapshot.deleteMany({ where: { userId: ids.user } });
  await db.goalEntityBinding.deleteMany({ where: { goalContractId: ids.goalRow } }); await db.goalConstraint.deleteMany({ where: { goalContractId: ids.goalRow } }); await db.goalContract.deleteMany({ where: { id: ids.goalRow } });
  await db.account.deleteMany({ where: { userId: ids.user } }); await db.beneficiary.deleteMany({ where: { userId: ids.user } }); await db.idempotencyRecord.deleteMany({ where: { OR: [{ scope: { startsWith: "IT_" } }, { key: { in: stepKeys } }] } });
  await db.auditEvent.deleteMany({ where: { traceId: ids.trace } }); await db.outboxEvent.deleteMany({ where: { traceId: ids.trace } }); await db.user.deleteMany({ where: { id: ids.user } });
}

describe.skipIf(!testDatabaseUrl)("Prisma PostgreSQL restart safety", () => {
  let db: PrismaClient; let executionId = ""; let approvalId = ""; let originalGoal: GoalContractV1;
  beforeAll(async () => { db = new PrismaClient({ datasourceUrl: testDatabaseUrl! }); await cleanup(db); await db.user.create({ data: { id: ids.user } }); await db.account.createMany({ data: [{ id: "it-db-acc-sgd", userId: ids.user, providerRef: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: 2_000_000n, availableMinorUnits: 2_000_000n, status: "ACTIVE", capabilities: ["SEND_TRANSFER", "CONVERT_FX"] }, { id: "it-db-acc-usd", userId: ids.user, providerRef: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: 500_000n, availableMinorUnits: 500_000n, status: "ACTIVE", capabilities: ["SEND_TRANSFER"] }] }); await db.beneficiary.create({ data: { id: "it-db-ben-ntu", userId: ids.user, providerRef: "ben-ntu", name: "NTU", supportedCurrencies: ["USD"], status: "ACTIVE" } });
    const fixtureGoal = GoalContractV1.parse(fixture("goal-contract.json")); const unhashed = GoalContractV1.parse({ ...fixtureGoal, id: ids.goal, userId: ids.user, sourceIntentDraftId: undefined, constraints: [], contractHash: "0".repeat(64) }); originalGoal = GoalContractV1.parse({ ...unhashed, contractHash: hashGoalContract(unhashed) });
    await db.goalContract.create({ data: { id: ids.goalRow, contractKey: originalGoal.id, version: originalGoal.version, userId: originalGoal.userId, status: "CONFIRMED", schemaVersion: originalGoal.schemaVersion, goalPayload: originalGoal.goal, preferences: originalGoal.preferences, contractHash: originalGoal.contractHash, createdAt: new Date(originalGoal.createdAt), confirmedAt: new Date(originalGoal.confirmedAt!), constraints: { create: originalGoal.constraints.map(({ type, ...payload }) => ({ type, payload })) }, entityBindings: { create: originalGoal.entityBindings.map((binding) => ({ reference: binding.reference, entityType: binding.entityType, entityId: binding.entityId, resolutionMethod: binding.resolutionMethod, ...(binding.confidence === undefined ? {} : { confidence: binding.confidence }), confirmed: binding.confirmed })) } } }); });
  afterAll(async () => { if (db) { await cleanup(db); await db.$disconnect(); } });

  it("persists the NTU pipeline, rolls transactions back, enforces idempotency, and reconstructs after reconnect", async () => {
    const repository = new PrismaParlanceRepository(db); const reloadedGoal = await repository.getConfirmedGoal(ids.goal); expect(reloadedGoal).not.toBeNull(); expect(canonicalGoalContractJson(reloadedGoal!.contract)).toBe(canonicalGoalContractJson(originalGoal)); expect(hashGoalContract(reloadedGoal!.contract)).toBe(hashGoalContract(originalGoal)); expect(hashGoalContract(reloadedGoal!.contract)).toBe(originalGoal.contractHash);
    const bank = await mockBank(); const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { const plan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), id: "it-plan-ntu", goalContractId: ids.goal, bankStateVersion: state.stateVersion }); return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan }); } };
    const compiled = await new CompilationService(repository, bank, compiler).compile(ids.goal, ids.trace); if (compiled.status !== "SAT") throw new Error("Expected SAT");
    const approved = await new ApprovalService(repository).approve(compiled.plan.id, { userId: ids.user, method: "PASSKEY", signatureReference: "it-signature" }, ids.trace); executionId = approved.execution.executionId; approvalId = approved.approval.id;
    const failing = new PrismaParlanceRepository(db, { afterExecutionUpdate() { throw new Error("injected transaction failure"); } }); await expect(failing.startExecution(executionId, ids.trace)).rejects.toThrow("injected"); expect((await db.executionRun.findUniqueOrThrow({ where: { id: executionId } })).status).toBe("AUTHORIZED"); expect(await db.auditEvent.count({ where: { aggregateId: executionId, eventType: "EXECUTION_STARTED" } })).toBe(0);
    const claims = await Promise.all([repository.claimIdempotency({ key: "it-concurrent-key", scope: "IT_CONCURRENCY", requestHash: "same-hash" }), repository.claimIdempotency({ key: "it-concurrent-key", scope: "IT_CONCURRENCY", requestHash: "same-hash" })]); expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(1); expect(claims.filter((claim) => claim.status === "REPLAY")).toHaveLength(1);
    const execution = await new ExecutionService(repository, bank, compiler).run(executionId, ids.trace); expect(execution.status).toBe("COMPLETED"); const beforeReplay = await bank.getState(ids.user, ids.trace); expect((await new ExecutionService(repository, bank, compiler).run(executionId, ids.trace)).status).toBe("COMPLETED"); expect((await bank.getState(ids.user, ids.trace)).stateVersion).toBe(beforeReplay.stateVersion);
    expect(await db.auditEvent.count({ where: { traceId: ids.trace } })).toBeGreaterThan(0); expect(await db.outboxEvent.count({ where: { traceId: ids.trace } })).toBeGreaterThan(0);
    await db.$disconnect(); db = new PrismaClient({ datasourceUrl: testDatabaseUrl! }); const restarted = new PrismaParlanceRepository(db); const restored = await restarted.getExecution(executionId); expect(restored?.result.status).toBe("COMPLETED"); expect(restored?.result.steps).toHaveLength(2); expect(await restarted.getLatestSettledStateVersion(executionId)).toBe(9); expect((await restarted.getApproval(approvalId))?.approval.financialPlanId).toBe(compiled.plan.id); expect(await restarted.listAudit()).not.toHaveLength(0); expect(await restarted.listRecoverableExecutions()).toEqual([]);
  }, 30_000);
});
