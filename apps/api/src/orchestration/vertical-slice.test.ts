import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, type CompilerResultV1 as CompilerResult } from "@parlance/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BankPort, ParlanceRepository, StoredApproval, StoredExecution, StoredGoal, StoredPlan } from "./ports.js";
import { ApprovalService, CompilationService, ExecutionService } from "./services.js";
import { hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { ExecutionGateway } from "../execution/gateway.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

class MemoryRepository implements ParlanceRepository {
  goal: StoredGoal; plan?: StoredPlan; approval?: StoredApproval; execution?: StoredExecution; audit: unknown[] = []; snapshot?: BankStateSnapshotV1; idempotency = new Map<string, { hash: string; response?: unknown }>(); settledStateVersions = new Map<string, number>();
  constructor(goal: GoalContractV1) { this.goal = { rowId: "goal-row", contract: goal }; }
  async getConfirmedGoal(id: string) { return id === this.goal.contract.id ? this.goal : null; }
  async saveSnapshot(value: BankStateSnapshotV1) { this.snapshot = value; }
  async savePlan(goalRowId: string, plan: FinancialPlanV1) { this.plan = { goalRowId, plan }; this.audit.push("PLAN_COMPILED"); }
  async saveCompilationFailure(_row: string, result: Exclude<CompilerResult, { status: "SAT" }>) { this.audit.push(result.status); }
  async getPlan(id: string) { return this.plan?.plan.id === id ? this.plan : null; }
  async approvePlan(input: { goalRowId: string; approval: ApprovalV1; executionId: string; traceId: string }) { this.approval = { approval: input.approval }; this.execution = { approvalId: input.approval.id, traceId: input.traceId, executionState: "AUTHORIZED", result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: input.executionId, planId: input.approval.financialPlanId, status: "PENDING", startedStateVersion: input.approval.bankStateVersion, steps: [], goalOutcome: { achieved: false, summary: "Execution has not completed." } }) }; this.audit.push("PLAN_APPROVED"); return this.execution; }
  async getApproval(id: string) { return this.approval?.approval.id === id ? this.approval : null; }
  async getExecution(id: string) { return this.execution?.result.executionId === id ? this.execution : null; }
  async getLatestSettledStateVersion(executionId: string) { return this.settledStateVersions.get(executionId) ?? null; }
  async claimIdempotency(input: { key: string; scope: string; requestHash: string }) { const prior = this.idempotency.get(input.key); if (!prior) { this.idempotency.set(input.key, { hash: input.requestHash }); return { status: "CLAIMED" as const }; } return prior.hash === input.requestHash ? { status: "REPLAY" as const, ...(prior.response === undefined ? {} : { response: prior.response }) } : { status: "CONFLICT" as const }; }
  async completeIdempotency(key: string, response: unknown) { const prior = this.idempotency.get(key); if (prior) prior.response = response; }
  async startExecution() { if (this.execution) { this.execution.result = { ...this.execution.result, status: "EXECUTING" }; this.execution.executionState = "EXECUTING"; } this.audit.push("EXECUTION_STARTED"); }
  async blockExecution(input: Parameters<ParlanceRepository["blockExecution"]>[0]) { if (this.execution) { this.execution.result = input.result; this.execution.executionState = input.state; } this.audit.push({ eventType: "EXECUTION_BLOCKED", ...input }); }
  async recordExecutionAudit(input: Parameters<ParlanceRepository["recordExecutionAudit"]>[0]) { this.audit.push(input); }
  async recordStep(input: Parameters<ParlanceRepository["recordStep"]>[0]) { if (!this.execution) return; const next = { stepId: input.planStepId, status: input.status, idempotencyKey: input.idempotencyKey, ...(input.bankReference ? { bankReference: input.bankReference } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}) }; this.execution.result = { ...this.execution.result, steps: [...this.execution.result.steps.filter((item) => item.stepId !== input.planStepId), next] }; if (input.status === "SETTLED" && input.resultingStateVersion !== undefined) this.settledStateVersions.set(input.executionId, input.resultingStateVersion); this.audit.push(`STEP_${input.status}`); }
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
  return { async getState(userId, traceId) { const response = await app.inject({ method: "GET", url: `/v1/state/${userId}`, headers: { "x-trace-id": traceId } }); const state = BankStateSnapshotV1.parse(response.json()); return BankStateSnapshotV1.parse({ ...state, fxQuotes: state.fxQuotes.map((quote, index) => index === 0 ? { ...quote, id: "quote-sgd-usd-1" } : quote) }); },
    async execute(path, payload, key, traceId) { const response = await app.inject({ method: "POST", url: `/v1/execute/${path}`, headers: { "idempotency-key": key, "x-trace-id": traceId, "content-type": "application/json" }, body: JSON.stringify(payload) }); if (response.statusCode >= 400) throw new Error(response.json().code); return WriteResult.parse(response.json()); } };
}

class ControlledBank implements BankPort {
  writes = 0;
  lastOperation?: { path: "fx" | "transfer" | "payment" | "buy"; payload: unknown; idempotencyKey: string; traceId: string };
  constructor(public snapshot: BankStateSnapshotV1) {}
  async getState() { return BankStateSnapshotV1.parse(this.snapshot); }
  async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string) { this.lastOperation = { path, payload, idempotencyKey, traceId }; this.writes += 1; this.snapshot = { ...this.snapshot, stateVersion: this.snapshot.stateVersion + 1, capturedAt: new Date(Date.parse(this.snapshot.capturedAt) + 1_000).toISOString() }; return { accepted: true as const, bankReference: `controlled-${this.writes}`, stateVersion: this.snapshot.stateVersion }; }
}

const appleGoal = (): GoalContractV1 => {
  const raw = GoalContractV1.parse({ schemaVersion: "1", id: "goal-apple-preserved", userId: "user-1", version: 1,
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", budget: { currency: "USD", minorUnits: "150000" } },
    constraints: [{ type: "MIN_AVAILABLE_BALANCE", accountId: "acc-sgd", money: { currency: "SGD", minorUnits: "100000" } }], preferences: [],
    entityBindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: true }],
    status: "CONFIRMED", contractHash: "0".repeat(64), createdAt: "2026-09-20T02:00:00Z", confirmedAt: "2026-09-20T02:01:00Z" });
  return { ...raw, contractHash: hashGoalContract(raw) };
};

const applePlan = (stateVersion = 7): FinancialPlanV1 => {
  const raw = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan-apple-preserved", goalContractId: "goal-apple-preserved", goalContractVersion: 1, bankStateVersion: stateVersion,
    compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test",
    steps: [
      { id: "fx-for-aapl", sequence: 0, action: "FX_CONVERT", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd", sourceMoney: { currency: "SGD", minorUnits: "200000" }, targetCurrency: "USD", quoteId: "quote-sgd-usd-1" } },
      { id: "buy-aapl", sequence: 1, action: "BUY_ASSET", dependsOn: ["fx-for-aapl"], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "150000" } } },
    ], validity: { requiredQuoteIds: ["quote-sgd-usd-1"] }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [{ assetId: "asset-aapl", quantity: "1" }], paidObligationIds: [], projectedAvailableBalances: [{ accountId: "acc-sgd", money: { currency: "SGD", minorUnits: "800000" } }], warnings: [] }, planHash: "0".repeat(64) });
  return { ...raw, planHash: hashFinancialPlan(raw) };
};

const appleState = (investments: boolean, stateVersion = 7): BankStateSnapshotV1 => BankStateSnapshotV1.parse({ ...(fixture("bank-state.json") as object), stateVersion,
  accounts: BankStateSnapshotV1.parse(fixture("bank-state.json")).accounts.map((account) => account.id === "acc-usd" ? { ...account, type: "BROKERAGE", capabilities: [...account.capabilities, "TRADE_ASSET"] } : account),
  assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: investments, settlementCurrency: "USD" }], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments } });

async function authorize(repository: MemoryRepository, plan: FinancialPlanV1) {
  repository.plan = { goalRowId: repository.goal.rowId, plan };
  return new ApprovalService(repository).approve(plan.id, { userId: repository.goal.contract.userId, method: "PASSKEY", signatureReference: "test-signature", expiresAt: new Date(Date.now() + 60_000).toISOString() }, "trace-preservation");
}

describe("NTU transfer vertical slice", () => {
  it("compiles, binds approval, executes exactly once, and records audit transitions", async () => {
    const rawGoal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), constraints: [], contractHash: "0".repeat(64) }); const goal = { ...rawGoal, contractHash: hashGoalContract(rawGoal) }; const repository = new MemoryRepository(goal); const bank = await bankAdapter();
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...(fixture("financial-plan.json") as object), bankStateVersion: state.stateVersion } }); } };
    const compiled = await new CompilationService(repository, bank, compiler).compile(goal.id, "trace-ntu"); expect(compiled.status).toBe("SAT"); if (compiled.status !== "SAT") throw new Error("Expected SAT");
    const authorized = await new ApprovalService(repository).approve(compiled.plan.id, { userId: goal.userId, method: "PASSKEY", signatureReference: "sig-ntu" }, "trace-ntu");
    const executionService = new ExecutionService(repository, bank, compiler); const completed = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(completed.status).toBe("COMPLETED"); expect(completed.finalStateVersion).toBe(9); expect(completed.steps).toHaveLength(2);
    const repeated = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(repeated).toEqual(completed); expect(repository.audit.filter((item) => item === "EXECUTION_COMPLETED")).toHaveLength(1);
    expect(repository.snapshot?.stateVersion).toBe(9); expect(repository.audit).toContain("PLAN_APPROVED");
  });
  it("allows only one local claim for concurrent identical execution attempts", async () => { const raw = GoalContractV1.parse(fixture("goal-contract.json")); const repository = new MemoryRepository({ ...raw, contractHash: hashGoalContract(raw) }); const claims = await Promise.all([repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" }), repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" })]); expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(1); expect(claims.filter((claim) => claim.status === "REPLAY")).toHaveLength(1); });

  it("blocks FX before mutation when AAPL becomes unavailable and the remaining goal is unsatisfiable", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(false)); const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return state.serviceAvailability.investments
      ? CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) })
      : CompilerResultV1.parse({ schemaVersion: "1", status: "UNSAT", reason: { code: "ASSET_UNAVAILABLE", message: "AAPL is unavailable." }, relaxations: [] }); } };
    const before = bank.snapshot; const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-preservation");
    expect(result.status).toBe("UNKNOWN"); expect(result.goalOutcome.summary).toMatch(/remaining confirmed goal/i); expect(bank.writes).toBe(0); expect(bank.snapshot).toEqual(before); expect(repository.execution?.executionState).toBe("PAUSED");
    expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_BANK_OPERATION_PREVENTED", payload: expect.objectContaining({ outcome: "GOAL_NO_LONGER_ACHIEVABLE", stepKey: "fx-for-aapl" }) }));
  });

  it("continues after a harmless state-version change when the route remains materially equivalent", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const state = appleState(true, 8); const bank = new ControlledBank(BankStateSnapshotV1.parse({ ...state, accounts: state.accounts.map((account) => account.id === "acc-usd" ? { ...account, ledgerMinorUnits: "150000", availableMinorUnits: "150000" } : account) })); const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-equivalent");
    expect(result.status).toBe("COMPLETED"); expect(bank.writes).toBe(2); expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_STATE_CHANGE_REVALIDATED" }));
  });

  it("requires reapproval without mutation when recompilation changes the financial route", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true, 8)); const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { const changed = applePlan(state.stateVersion); const first = changed.steps[0]!; if (first.action !== "FX_CONVERT") throw new Error("Expected FX"); return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...changed, steps: [{ ...first, parameters: { ...first.parameters, sourceMoney: { currency: "SGD", minorUnits: "210000" } } }, ...changed.steps.slice(1)] } }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-reapproval");
    expect(result.status).toBe("UNKNOWN"); expect(bank.writes).toBe(0); expect(repository.execution?.executionState).toBe("REAPPROVAL_REQUIRED"); expect(result.goalOutcome.summary).toMatch(/approval again/i);
  });

  it("recovers the last settled state version and revalidates external drift after restart", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const state = appleState(true, 9); const bank = new ControlledBank(BankStateSnapshotV1.parse({ ...state, accounts: state.accounts.map((account) => account.id === "acc-usd" ? { ...account, ledgerMinorUnits: "150000", availableMinorUnits: "150000" } : account) })); const approved = await authorize(repository, plan);
    const executionId = approved.execution.executionId; repository.execution = { ...repository.execution!, executionState: "EXECUTING", result: { ...repository.execution!.result, status: "EXECUTING", steps: [{ stepId: "fx-for-aapl", status: "SETTLED", idempotencyKey: "settled-fx", bankReference: "bank-fx" }] } }; repository.settledStateVersions.set(executionId, 8);
    let revalidations = 0;
    const compiler = { async compile(_goal: GoalContractV1, current: BankStateSnapshotV1) { revalidations += 1; const replanned = applePlan(current.stateVersion); return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...replanned, steps: replanned.steps.slice(1) } }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(executionId, "trace-restart-drift");
    expect(revalidations).toBe(1); expect(bank.writes).toBe(1); expect(result.status).toBe("COMPLETED");
    expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_LATEST_STATE_LOADED", payload: expect.objectContaining({ stepKey: "buy-aapl", expectedStateVersion: 8, observedStateVersion: 9 }) }));
    expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_STATE_CHANGE_REVALIDATED", payload: expect.objectContaining({ stepKey: "buy-aapl", observedStateVersion: 9 }) }));
  });

  it("rejects a mutated action at the bank gateway with zero writes", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan); const step = plan.steps[0]!;
    if (step.action !== "FX_CONVERT") throw new Error("Expected FX");
    const gateway = new ExecutionGateway(bank);
    await expect(gateway.execute({ goal, plan, approval: approved.approval, executionState: "EXECUTING", expectedStateVersion: 7, currentStateVersion: 7, revalidationSucceeded: false, idempotencyKey: "mutated-action", proposedStep: { ...step, parameters: { ...step.parameters, sourceMoney: { currency: "SGD", minorUnits: "210000" } } } }, "trace-injection")).rejects.toThrow("UNAPPROVED_EXECUTABLE_ACTION");
    expect(bank.writes).toBe(0);
  });

  it("derives the bank path and payload from the exact approved proposed step", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan); const step = plan.steps[0]!;
    await new ExecutionGateway(bank).execute({ goal, plan, approval: approved.approval, executionState: "EXECUTING", expectedStateVersion: 7, currentStateVersion: 7, revalidationSucceeded: false, idempotencyKey: "bound-operation", proposedStep: step }, "trace-bound-operation");
    expect(bank.lastOperation).toEqual({ path: "fx", payload: { userId: goal.userId, accountId: "acc-sgd", fromAmount: { currency: "SGD", minorUnits: "200000" }, toCurrency: "USD", quoteId: "quote-sgd-usd-1" }, idempotencyKey: "bound-operation", traceId: "trace-bound-operation" });
  });

  it("fails closed with zero writes for a hard constraint the runtime cannot prove", async () => {
    const base = appleGoal(); const raw = GoalContractV1.parse({ ...base, constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 1 }], contractHash: "0".repeat(64) }); const goal = { ...raw, contractHash: hashGoalContract(raw) };
    const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-unsupported-constraint");
    expect(result.status).toBe("UNKNOWN"); expect(result.steps[0]?.errorCode).toBe("GOAL_CONSTRAINT_VIOLATION"); expect(bank.writes).toBe(0);
  });
});
