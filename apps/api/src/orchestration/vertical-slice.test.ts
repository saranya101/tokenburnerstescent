import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, type CompilerResultV1 as CompilerResult } from "@parlance/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BankPort, ParlanceRepository, StoredApproval, StoredExecution, StoredGoal, StoredPlan } from "./ports.js";
import { ApprovalService, CompilationService, ExecutionService } from "./services.js";
import { hashGoalContract } from "../security/canonical-hash.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

class MemoryRepository implements ParlanceRepository {
  goal: StoredGoal; plan?: StoredPlan; approval?: StoredApproval; execution?: StoredExecution; audit: unknown[] = []; snapshot?: BankStateSnapshotV1; idempotency = new Map<string, { hash: string; response?: unknown }>();
  constructor(goal: GoalContractV1) { this.goal = { rowId: "goal-row", contract: goal }; }
  async getConfirmedGoal(id: string) { return id === this.goal.contract.id ? this.goal : null; }
  async saveSnapshot(value: BankStateSnapshotV1) { this.snapshot = value; }
  async savePlan(goalRowId: string, plan: FinancialPlanV1) { this.plan = { goalRowId, plan }; this.audit.push("PLAN_COMPILED"); }
  async saveCompilationFailure(_row: string, result: Exclude<CompilerResult, { status: "SAT" }>) { this.audit.push(result.status); }
  async getPlan(id: string) { return this.plan?.plan.id === id ? this.plan : null; }
  async approvePlan(input: { goalRowId: string; approval: ApprovalV1; executionId: string; traceId: string }) { this.approval = { approval: input.approval }; this.execution = { approvalId: input.approval.id, traceId: input.traceId, executionState: "AUTHORIZED", result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: input.executionId, planId: input.approval.financialPlanId, status: "PENDING", startedStateVersion: input.approval.bankStateVersion, steps: [], goalOutcome: { achieved: false, summary: "Execution has not completed." } }) }; this.audit.push("PLAN_APPROVED"); return this.execution; }
  async getApproval(id: string) { return this.approval?.approval.id === id ? this.approval : null; }
  async getExecution(id: string) { return this.execution?.result.executionId === id ? this.execution : null; }
  async claimIdempotency(input: { key: string; scope: string; requestHash: string }) { const prior = this.idempotency.get(input.key); if (!prior) { this.idempotency.set(input.key, { hash: input.requestHash }); return { status: "CLAIMED" as const }; } return prior.hash === input.requestHash ? { status: "REPLAY" as const, ...(prior.response === undefined ? {} : { response: prior.response }) } : { status: "CONFLICT" as const }; }
  async completeIdempotency(key: string, response: unknown) { const prior = this.idempotency.get(key); if (prior) prior.response = response; }
  async startExecution() { if (this.execution) { this.execution.result = { ...this.execution.result, status: "EXECUTING" }; this.execution.executionState = "EXECUTING"; } this.audit.push("EXECUTION_STARTED"); }
  async recordStep(input: Parameters<ParlanceRepository["recordStep"]>[0]) { if (!this.execution) return; const next = { stepId: input.planStepId, status: input.status, idempotencyKey: input.idempotencyKey, ...(input.bankReference ? { bankReference: input.bankReference } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}) }; this.execution.result = { ...this.execution.result, steps: [...this.execution.result.steps.filter((item) => item.stepId !== input.planStepId), next] }; this.audit.push(`STEP_${input.status}`); }
  async finishExecution(input: Parameters<ParlanceRepository["finishExecution"]>[0]) { if (this.execution) { this.execution.result = input.result; this.execution.executionState = input.result.status === "COMPLETED" ? "COMPLETED" : "FAILED"; } this.audit.push(`EXECUTION_${input.result.status}`); }
  async listExecutions() { return this.execution ? [this.execution] : []; }
  async listRecoverableExecutions() { return this.execution && !["COMPLETED", "FAILED"].includes(this.execution.executionState) ? [this.execution] : []; }
  async listAudit() { return this.audit; }
  async isReady() { return true; }
}

async function bankAdapter(): Promise<BankPort> {
  const modulePath = join(process.cwd(), "../../services/mock-bank/src/app.ts");
  const { buildApp } = await import(modulePath) as { buildApp(): FastifyInstance }; const app = buildApp();
  const WriteResult = z.object({ accepted: z.literal(true), bankReference: z.string(), stateVersion: z.number().int() });
  return { async getState(userId, traceId) { const response = await app.inject({ method: "GET", url: `/v1/state/${userId}`, headers: { "x-trace-id": traceId } }); return BankStateSnapshotV1.parse(response.json()); },
    async execute(path, payload, key, traceId) { const response = await app.inject({ method: "POST", url: `/v1/execute/${path}`, headers: { "idempotency-key": key, "x-trace-id": traceId, "content-type": "application/json" }, body: JSON.stringify(payload) }); if (response.statusCode >= 400) throw new Error(response.json().code); return WriteResult.parse(response.json()); } };
}

describe("NTU transfer vertical slice", () => {
  it("compiles, binds approval, executes exactly once, and records audit transitions", async () => {
    const rawGoal = GoalContractV1.parse(fixture("goal-contract.json")); const goal = { ...rawGoal, contractHash: hashGoalContract(rawGoal) }; const repository = new MemoryRepository(goal); const bank = await bankAdapter();
    const compiler = { async compile() { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: fixture("financial-plan.json") }); } };
    const compiled = await new CompilationService(repository, bank, compiler).compile(goal.id, "trace-ntu"); expect(compiled.status).toBe("SAT"); if (compiled.status !== "SAT") throw new Error("Expected SAT");
    const authorized = await new ApprovalService(repository).approve(compiled.plan.id, { userId: goal.userId, method: "PASSKEY", signatureReference: "sig-ntu" }, "trace-ntu");
    const executionService = new ExecutionService(repository, bank); const completed = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(completed.status).toBe("COMPLETED"); expect(completed.finalStateVersion).toBe(9); expect(completed.steps).toHaveLength(2);
    const repeated = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(repeated).toEqual(completed); expect(repository.audit.filter((item) => item === "EXECUTION_COMPLETED")).toHaveLength(1);
    expect(repository.snapshot?.stateVersion).toBe(7); expect(repository.audit).toContain("PLAN_APPROVED");
  });
  it("allows only one local claim for concurrent identical execution attempts", async () => { const raw = GoalContractV1.parse(fixture("goal-contract.json")); const repository = new MemoryRepository({ ...raw, contractHash: hashGoalContract(raw) }); const claims = await Promise.all([repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" }), repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" })]); expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(1); expect(claims.filter((claim) => claim.status === "REPLAY")).toHaveLength(1); });
});
