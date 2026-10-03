import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1, type BundleSatisfactionProofV1, type CompilerResultV1 as CompilerResult } from "@parlance/contracts";
import { hashGoalBundleContract } from "@parlance/contracts/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { BankOutcomeUnknownError, type BankLookupResult, type BankPort, type ParlanceRepository, type StoredApproval, type StoredExecution, type StoredGoal, type StoredGoalBundle, type StoredPlan } from "./ports.js";
import { CompilationService, ExecutionService } from "./services.js";
import type { StoredApprovalEvidence } from "../webauthn/types.js";
import { canonicalHash, hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { ExecutionGateway, verifyExecutionApproval } from "../execution/gateway.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

class MemoryRepository implements ParlanceRepository {
  goal: StoredGoal; plan?: StoredPlan; approval?: StoredApproval; execution?: StoredExecution; audit: unknown[] = []; snapshot?: BankStateSnapshotV1; idempotency = new Map<string, { hash: string; response?: unknown }>(); settledStateVersions = new Map<string, number>();
  bundle?: StoredGoalBundle;
  constructor(goal: GoalContractV1) { this.goal = { rowId: "goal-row", contract: goal }; }
  async getConfirmedGoal(id: string) { return id === this.goal.contract.id ? this.goal : null; }
  async getConfirmedGoalBundle(id: string) { return id === this.bundle?.contract.bundleId ? this.bundle : null; }
  async saveSnapshot(value: BankStateSnapshotV1) { this.snapshot = value; }
  async savePlan(goalRowId: string, plan: FinancialPlanV1) { if (this.plan?.status === "READY") this.plan.status = "SUPERSEDED"; this.plan = { goalRowId, status: "READY", plan }; this.audit.push("PLAN_COMPILED"); }
  async saveCompilationFailure(_row: string, result: Exclude<CompilerResult, { status: "SAT" }>) { this.audit.push(result.status); }
  async getPlan(id: string) { return this.plan?.plan.id === id ? this.plan : null; }
  async recordPlanAudit(input: Parameters<ParlanceRepository["recordPlanAudit"]>[0]) { this.audit.push(input); }
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
    async execute(path, payload, key, traceId) { const response = await app.inject({ method: "POST", url: `/v1/execute/${path}`, headers: { "idempotency-key": key, "x-trace-id": traceId, "content-type": "application/json" }, body: JSON.stringify(payload) }); if (response.statusCode >= 400) throw new Error(response.json().code); return WriteResult.parse(response.json()); },
    async lookupByIdempotencyKey(key, traceId) { const response = await app.inject({ method: "GET", url: `/v1/executions/idempotency/${key}`, headers: { "x-trace-id": traceId } }); return response.json(); } };
}

class ControlledBank implements BankPort {
  writes = 0;
  lastOperation?: { path: "fx" | "transfer" | "payment" | "buy"; payload: unknown; idempotencyKey: string; traceId: string };
  constructor(public snapshot: BankStateSnapshotV1) {}
  async getState() { return BankStateSnapshotV1.parse(this.snapshot); }
  async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string) { this.lastOperation = { path, payload, idempotencyKey, traceId }; this.writes += 1; this.snapshot = { ...this.snapshot, stateVersion: this.snapshot.stateVersion + 1, capturedAt: new Date(Date.parse(this.snapshot.capturedAt) + 1_000).toISOString() }; return { accepted: true as const, bankReference: `controlled-${this.writes}`, stateVersion: this.snapshot.stateVersion }; }
  async lookupByIdempotencyKey(idempotencyKey: string): Promise<BankLookupResult> { return { status: "NOT_FOUND", idempotencyKey }; }
}

class RecoveringBank extends ControlledBank {
  attempts: Array<{ path: "fx" | "transfer" | "payment" | "buy"; payload: unknown; idempotencyKey: string }> = [];
  records = new Map<string, { operation: "fx" | "transfer" | "payment" | "buy"; requestHash: string; accepted: true; bankReference: string; stateVersion: number }>();
  failBeforeReceive = 0; loseAfterMutation = 0; rejectBeforeMutation = false; lookupUnavailable = false; conflictingLookup = false;
  override async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string) {
    this.attempts.push({ path, payload, idempotencyKey });
    if (this.rejectBeforeMutation) throw new Error("INSUFFICIENT_FUNDS");
    if (this.failBeforeReceive > 0) { this.failBeforeReceive -= 1; throw new BankOutcomeUnknownError(); }
    const prior = this.records.get(idempotencyKey); if (prior) return prior;
    const parameters = payload as Record<string, unknown>; const money = (parameters.fromAmount ?? parameters.sourceMoney ?? parameters.amount ?? parameters.maximumSpend) as { minorUnits: string };
    const sourceAccountId = (parameters.accountId ?? parameters.sourceAccountId) as string; const sourceAmount = BigInt(money.minorUnits);
    let accounts = this.snapshot.accounts.map((account) => account.id === sourceAccountId ? { ...account, ledgerMinorUnits: (BigInt(account.ledgerMinorUnits) - sourceAmount).toString(), availableMinorUnits: (BigInt(account.availableMinorUnits) - sourceAmount).toString() } : account);
    if (path === "fx") { const targetCurrency = parameters.toCurrency as string; const targetAmount = (sourceAmount * 75n + 50n) / 100n; accounts = accounts.map((account) => account.currency === targetCurrency ? { ...account, ledgerMinorUnits: (BigInt(account.ledgerMinorUnits) + targetAmount).toString(), availableMinorUnits: (BigInt(account.availableMinorUnits) + targetAmount).toString() } : account); }
    this.writes += 1; this.snapshot = { ...this.snapshot, accounts, stateVersion: this.snapshot.stateVersion + 1, capturedAt: new Date(Date.parse(this.snapshot.capturedAt) + 1_000).toISOString() };
    const result = { operation: path, requestHash: canonicalHash(payload), accepted: true as const, bankReference: `recovering-${this.writes}`, stateVersion: this.snapshot.stateVersion };
    this.records.set(idempotencyKey, result);
    if (this.loseAfterMutation > 0) { this.loseAfterMutation -= 1; throw new BankOutcomeUnknownError(); }
    return result;
  }
  override async lookupByIdempotencyKey(idempotencyKey: string) {
    if (this.lookupUnavailable) throw new Error("BANK_LOOKUP_UNAVAILABLE");
    const result = this.records.get(idempotencyKey); if (!result) return { status: "NOT_FOUND" as const, idempotencyKey };
    return { status: "COMPLETED" as const, idempotencyKey, ...result, ...(this.conflictingLookup ? { requestHash: "0".repeat(64) } : {}) };
  }
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
      { id: "buy-aapl", sequence: 1, action: "BUY_ASSET", dependsOn: ["fx-for-aapl"], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "150000" }, quoteId: "asset-quote-aapl-usd-v1", settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } },
    ], validity: { requiredQuoteIds: ["quote-sgd-usd-1", "asset-quote-aapl-usd-v1"] }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [{ assetId: "asset-aapl", quantity: "1" }], paidObligationIds: [], projectedAvailableBalances: [{ accountId: "acc-sgd", money: { currency: "SGD", minorUnits: "800000" } }], warnings: [] }, planHash: "0".repeat(64) });
  return { ...raw, planHash: hashFinancialPlan(raw) };
};

const planWithExpiry = (plan: FinancialPlanV1, validUntil: Date): FinancialPlanV1 => {
  const unhashed = FinancialPlanV1.parse({ ...plan, validity: { ...plan.validity, validUntil: validUntil.toISOString() }, planHash: "0".repeat(64) });
  return FinancialPlanV1.parse({ ...unhashed, planHash: hashFinancialPlan(unhashed) });
};

const appleState = (investments: boolean, stateVersion = 7): BankStateSnapshotV1 => BankStateSnapshotV1.parse({ ...(fixture("bank-state.json") as object), stateVersion,
  accounts: BankStateSnapshotV1.parse(fixture("bank-state.json")).accounts.map((account) => account.id === "acc-usd" ? { ...account, type: "BROKERAGE", capabilities: [...account.capabilities, "TRADE_ASSET"] } : account),
  assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: investments, settlementCurrency: "USD" }],
  assetQuotes: [{ quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" }],
  serviceAvailability: { transfers: true, fx: true, billPayments: true, investments } });

async function authorize(repository: MemoryRepository, plan: FinancialPlanV1) {
  repository.plan = { goalRowId: repository.goal.rowId, status: "READY", plan };
  const approval = ApprovalV1.parse({ schemaVersion: "1", id: "verified-approval", userId: repository.goal.contract.userId, goalContractId: repository.goal.contract.id, goalContractVersion: repository.goal.contract.version, goalContractHash: repository.goal.contract.contractHash, financialPlanId: plan.id, financialPlanHash: plan.planHash, bankStateVersion: plan.bankStateVersion, method: "PASSKEY", approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), signatureReference: "verified-evidence" });
  const evidence: StoredApprovalEvidence = { id: "verified-evidence", approvalId: approval.id, userId: approval.userId, financialPlanId: plan.id, goalContractKey: repository.goal.contract.id, goalContractVersion: repository.goal.contract.version, goalContractHash: repository.goal.contract.contractHash, financialPlanHash: plan.planHash, bankStateVersion: plan.bankStateVersion, webAuthnCredentialId: "credential-row", challengeId: "challenge-row", approvalPayloadHash: "payload-hash", authenticatorCounterBefore: 0, authenticatorCounterAfter: 1, userVerified: true, rpId: "localhost", origin: "http://localhost:3000", verifiedAt: new Date().toISOString() };
  repository.approval = { approval, evidence }; repository.execution = { approvalId: approval.id, traceId: "trace-preservation", executionState: "AUTHORIZED", result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: "verified-execution", planId: plan.id, status: "PENDING", startedStateVersion: plan.bankStateVersion, steps: [], goalOutcome: { achieved: false, summary: "Execution has not completed." } }) }; repository.audit.push("PLAN_AUTHORIZED");
  return { approval, evidence, execution: repository.execution.result };
}

async function authorizeBundle(repository: MemoryRepository, plan: FinancialPlanV1, proof: BundleSatisfactionProofV1) {
  const bundle = repository.bundle!; repository.plan = { goalRowId: bundle.rowId, ownerType: "BUNDLE", status: "READY", plan, satisfactionProof: proof };
  const approval = ApprovalV1.parse({ schemaVersion: "1", id: "bundle-approval", userId: bundle.userId, goalContractId: bundle.contract.bundleId, goalContractVersion: bundle.contract.bundleVersion, goalContractHash: bundle.contract.contractHash, financialPlanId: plan.id, financialPlanHash: plan.planHash, bankStateVersion: plan.bankStateVersion, method: "PASSKEY", approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), signatureReference: "bundle-evidence" });
  const evidence: StoredApprovalEvidence = { id: "bundle-evidence", approvalId: approval.id, userId: bundle.userId, financialPlanId: plan.id, goalContractKey: bundle.contract.bundleId, goalContractVersion: bundle.contract.bundleVersion, goalContractHash: bundle.contract.contractHash, financialPlanHash: plan.planHash, bankStateVersion: plan.bankStateVersion, webAuthnCredentialId: "credential-row", challengeId: "challenge-row", approvalPayloadHash: "payload-hash", authenticatorCounterBefore: 0, authenticatorCounterAfter: 1, userVerified: true, rpId: "localhost", origin: "http://localhost:3000", verifiedAt: new Date().toISOString() };
  repository.approval = { approval, evidence }; repository.execution = { approvalId: approval.id, traceId: "trace-bundle-execution", executionState: "AUTHORIZED", result: ExecutionResultV1.parse({ schemaVersion: "1", executionId: "bundle-execution", planId: plan.id, status: "PENDING", startedStateVersion: plan.bankStateVersion, steps: [], goalOutcome: { achieved: false, summary: "Execution has not completed." } }) };
  return repository.execution.result;
}

function executableBundle() {
  const unhashed = GoalBundleContractV1.parse({
    schemaVersion: "1", bundleId: "bundle-execution", bundleVersion: 1, contractHash: "0".repeat(64), globalConstraints: [], explicitDependencies: [{ beforeItemId: "item-transfer", afterItemId: "item-buy", reason: "USER_EXPLICIT_ORDER" }],
    items: [
      { itemId: "item-transfer", goal: { type: "DELIVER_MONEY", recipientId: "ben-john", amount: { currency: "USD", minorUnits: "30000" } }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "John Tan", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "USER_CONFIRMED", confirmed: true }] },
      { itemId: "item-buy", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: true }] },
    ],
  });
  const bundle = GoalBundleContractV1.parse({ ...unhashed, contractHash: hashGoalBundleContract(unhashed) });
  const rawPlan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan-bundle-execution", goalContractId: bundle.bundleId, goalContractVersion: bundle.bundleVersion, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "0".repeat(64), validity: { requiredQuoteIds: ["asset-quote-aapl-usd-v1"] }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [{ assetId: "asset-aapl", quantity: "1" }], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] }, steps: [
    { id: "transfer-john", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-john", amount: { currency: "USD", minorUnits: "30000" } } },
    { id: "buy-apple", sequence: 1, action: "BUY_ASSET", dependsOn: ["transfer-john"], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "150000" }, quoteId: "asset-quote-aapl-usd-v1", settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } },
  ] });
  const plan = FinancialPlanV1.parse({ ...rawPlan, planHash: hashFinancialPlan(rawPlan) });
  const proof: BundleSatisfactionProofV1 = { schemaVersion: "1", bundleId: bundle.bundleId, bundleContractHash: bundle.contractHash, itemCoverage: [{ itemId: "item-transfer", satisfiedByStepIds: ["transfer-john"] }, { itemId: "item-buy", satisfiedByStepIds: ["buy-apple"] }], allItemsSatisfied: true, allHardConstraintsSatisfied: true, allExplicitDependenciesSatisfied: true, allIrreversibleStepsJustified: true };
  return { bundle, plan, proof };
}

describe("NTU transfer vertical slice", () => {
  it("executes a bundle-owned plan through the existing gateway and reconciliation stack", async () => {
    const values = executableBundle(); const repository = new MemoryRepository(appleGoal()); repository.bundle = { rowId: "bundle-row", userId: "user-1", contract: values.bundle };
    const baseState = appleState(true); const bank = new ControlledBank(BankStateSnapshotV1.parse({ ...baseState, accounts: baseState.accounts.map((account) => account.id === "acc-usd" ? { ...account, ledgerMinorUnits: "1000000", availableMinorUnits: "1000000" } : account), beneficiaries: [...baseState.beneficiaries, { id: "ben-john", name: "John Tan", supportedCurrencies: ["USD"], status: "ACTIVE" }] }));
    const execution = await authorizeBundle(repository, values.plan, values.proof);
    const result = await new ExecutionService(repository, bank, { compile: async () => { throw new Error("single compiler must not run"); } }).run(execution.executionId, "trace-bundle-execution");
    expect(result, JSON.stringify(result)).toMatchObject({ status: "COMPLETED", goalOutcome: { achieved: true } }); expect(result.steps).toHaveLength(2);
    expect(bank.writes).toBe(2); expect(repository.plan).toMatchObject({ ownerType: "BUNDLE", status: "READY" });
    expect(bank.lastOperation).toMatchObject({ path: "buy", payload: {
      userId: "user-1", sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1",
      maximumSpend: { currency: "USD", minorUnits: "150000" }, quoteId: "asset-quote-aapl-usd-v1",
      settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100",
    } });
  });

  it("stops the bundle before any write when the approved asset quote has changed", async () => {
    const values = executableBundle(); const repository = new MemoryRepository(appleGoal()); repository.bundle = { rowId: "bundle-row", userId: "user-1", contract: values.bundle };
    const baseState = appleState(true); const bank = new ControlledBank(BankStateSnapshotV1.parse({ ...baseState, accounts: baseState.accounts.map((account) => account.id === "acc-usd" ? { ...account, ledgerMinorUnits: "1000000", availableMinorUnits: "1000000" } : account), beneficiaries: [...baseState.beneficiaries, { id: "ben-john", name: "John Tan", supportedCurrencies: ["USD"], status: "ACTIVE" }], assetQuotes: baseState.assetQuotes.map((quote) => ({ ...quote, unitPriceMinor: "20001" })) }));
    const execution = await authorizeBundle(repository, values.plan, values.proof);
    const result = await new ExecutionService(repository, bank, { compile: async () => { throw new Error("single compiler must not run"); } }).run(execution.executionId, "trace-changed-asset-quote");
    expect(result).toMatchObject({ status: "UNKNOWN", steps: [{ errorCode: "BUNDLE_REMAINDER_SIMULATION_FAILED" }] });
    expect(repository.execution?.executionState).toBe("PAUSED"); expect(bank.writes).toBe(0);
  });

  it("compiles, binds approval, executes exactly once, and records audit transitions", async () => {
    const rawGoal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), constraints: [], contractHash: "0".repeat(64) }); const goal = { ...rawGoal, contractHash: hashGoalContract(rawGoal) }; const repository = new MemoryRepository(goal); const bank = await bankAdapter();
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { const fixturePlan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), bankStateVersion: state.stateVersion }); return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...fixturePlan, validity: { ...fixturePlan.validity, validUntil: new Date(Date.now() + 60_000).toISOString() } } }); } };
    const compiled = await new CompilationService(repository, bank, compiler).compile(goal.id, "trace-ntu"); expect(compiled.status).toBe("SAT"); if (compiled.status !== "SAT") throw new Error("Expected SAT");
    const authorized = await authorize(repository, compiled.plan);
    const executionService = new ExecutionService(repository, bank, compiler); const completed = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(completed.status).toBe("COMPLETED"); expect(completed.finalStateVersion).toBe(9); expect(completed.steps).toHaveLength(2);
    const repeated = await executionService.run(authorized.execution.executionId, "trace-ntu"); expect(repeated).toEqual(completed); expect(repository.audit.filter((item) => item === "EXECUTION_COMPLETED")).toHaveLength(1);
    expect(repository.snapshot?.stateVersion).toBe(9); expect(repository.audit).toContain("PLAN_AUTHORIZED");
  });
  it("allows only one local claim for concurrent identical execution attempts", async () => { const raw = GoalContractV1.parse(fixture("goal-contract.json")); const repository = new MemoryRepository({ ...raw, contractHash: hashGoalContract(raw) }); const claims = await Promise.all([repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" }), repository.claimIdempotency({ key: "same-step", scope: "BANK_EXECUTION_STEP", requestHash: "same-request" })]); expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(1); expect(claims.filter((claim) => claim.status === "REPLAY")).toHaveLength(1); });

  it("retries the exact approved step with the same key only after authoritative NOT_FOUND", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new RecoveringBank(appleState(true)); bank.failBeforeReceive = 1; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-not-found-retry");
    expect(result.status).toBe("COMPLETED"); expect(bank.writes).toBe(2); expect(bank.attempts[0]).toEqual(bank.attempts[1]);
  });

  it("persists an unknown outcome and blocks the dependent step while lookup is unavailable", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new RecoveringBank(appleState(true)); bank.loseAfterMutation = 1; bank.lookupUnavailable = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-unknown");
    expect(result.status).toBe("UNKNOWN"); expect(result.steps).toEqual([expect.objectContaining({ stepId: "fx-for-aapl", status: "UNKNOWN", errorCode: "BANK_LOOKUP_UNAVAILABLE" })]);
    expect(repository.execution?.executionState).toBe("PAUSED"); expect(bank.writes).toBe(1); expect(bank.attempts).toHaveLength(1);
  });

  it("records a definite pre-mutation bank rejection as failed with zero effects", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new RecoveringBank(appleState(true)); bank.rejectBeforeMutation = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-rejected");
    expect(result.status).toBe("FAILED"); expect(result.steps[0]).toMatchObject({ status: "FAILED", errorCode: "INSUFFICIENT_FUNDS" }); expect(bank.writes).toBe(0);
  });

  it("keeps a pre-receipt network failure unknown with zero writes when lookup is unavailable", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new RecoveringBank(appleState(true)); bank.failBeforeReceive = 1; bank.lookupUnavailable = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-before-receipt");
    expect(result.status).toBe("UNKNOWN"); expect(repository.execution?.executionState).toBe("PAUSED"); expect(bank.writes).toBe(0); expect(bank.attempts).toHaveLength(1);
  });

  it("recovers an unknown FX after restart and runs its dependent transfer exactly once", async () => {
    const rawGoal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), constraints: [], contractHash: "0".repeat(64) }); const goal = { ...rawGoal, contractHash: hashGoalContract(rawGoal) };
    const rawPlan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), validity: { requiredQuoteIds: ["quote-sgd-usd-1"] }, planHash: "0".repeat(64) }); const plan = { ...rawPlan, planHash: hashFinancialPlan(rawPlan) };
    const repository = new MemoryRepository(goal); const bank = new RecoveringBank(BankStateSnapshotV1.parse(fixture("bank-state.json"))); bank.loseAfterMutation = 1; bank.lookupUnavailable = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...plan, bankStateVersion: state.stateVersion } }); } };
    const paused = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-restart-1"); expect(paused.status).toBe("UNKNOWN"); expect(bank.writes).toBe(1);
    bank.lookupUnavailable = false;
    const completed = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-restart-2");
    expect(completed.status).toBe("COMPLETED"); expect(completed.finalStateVersion).toBe(9); expect(bank.writes).toBe(2); expect(bank.attempts.map((attempt) => attempt.path)).toEqual(["fx", "transfer"]); expect(completed.steps).toHaveLength(2);
    const repeated = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-restart-3"); expect(repeated).toEqual(completed); expect(bank.writes).toBe(2);
  });

  it("fails closed when authoritative lookup identity conflicts", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new RecoveringBank(appleState(true)); bank.loseAfterMutation = 1; bank.conflictingLookup = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: applePlan(state.stateVersion) }); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-conflict");
    expect(result.status).toBe("UNKNOWN"); expect(result.steps[0]?.errorCode).toBe("RECONCILIATION_CONFLICT"); expect(bank.writes).toBe(1); expect(bank.attempts).toHaveLength(1);
    const repeated = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-conflict-repeat");
    expect(repeated).toEqual(result); expect(bank.writes).toBe(1); expect(bank.attempts).toHaveLength(1);
  });

  it("allows concurrent reconciliation without duplicating either approved effect", async () => {
    const rawGoal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), constraints: [], contractHash: "0".repeat(64) }); const goal = { ...rawGoal, contractHash: hashGoalContract(rawGoal) };
    const rawPlan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), validity: { requiredQuoteIds: ["quote-sgd-usd-1"] }, planHash: "0".repeat(64) }); const plan = { ...rawPlan, planHash: hashFinancialPlan(rawPlan) };
    const repository = new MemoryRepository(goal); const bank = new RecoveringBank(BankStateSnapshotV1.parse(fixture("bank-state.json"))); bank.loseAfterMutation = 1; bank.lookupUnavailable = true; const approved = await authorize(repository, plan);
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...plan, bankStateVersion: state.stateVersion } }); } };
    await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-concurrent-pause"); bank.lookupUnavailable = false;
    const results = await Promise.all([new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-concurrent-a"), new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-concurrent-b")]);
    expect(results.every((result) => result.status === "COMPLETED")).toBe(true); expect(bank.writes).toBe(2); expect(new Set(bank.attempts.map((attempt) => `${attempt.path}:${attempt.idempotencyKey}`)).size).toBe(2);
  });

  it("blocks an authorized plan that expires before execution with zero bank writes", async () => {
    const goal = appleGoal(); const expiredAt = new Date("2026-09-30T06:00:00.000Z"); const plan = planWithExpiry(applePlan(), expiredAt);
    const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan); const before = bank.snapshot;
    const compiler = { async compile() { throw new Error("compiler must not run for an expired plan"); } };
    const result = await new ExecutionService(repository, bank, compiler, () => new Date(expiredAt.getTime() + 1)).run(approved.execution.executionId, "trace-expired-execution");
    expect(result).toMatchObject({ status: "UNKNOWN", goalOutcome: { achieved: false } }); expect(repository.execution?.executionState).toBe("REAPPROVAL_REQUIRED");
    expect(bank.writes).toBe(0); expect(bank.snapshot).toEqual(before);
    expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_BANK_OPERATION_PREVENTED", payload: expect.objectContaining({ reason: "FINANCIAL_PLAN_EXPIRED" }) }));
  });

  it("blocks an approved plan superseded before execution with zero bank writes", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan); const before = bank.snapshot;
    repository.plan!.status = "SUPERSEDED";
    const compiler = { async compile() { throw new Error("compiler must not run for a superseded plan"); } };
    const result = await new ExecutionService(repository, bank, compiler).run(approved.execution.executionId, "trace-superseded-execution");
    expect(result).toMatchObject({ status: "UNKNOWN", goalOutcome: { achieved: false } }); expect(repository.execution?.executionState).toBe("REAPPROVAL_REQUIRED");
    expect(bank.writes).toBe(0); expect(bank.snapshot).toEqual(before);
    expect(repository.audit).toContainEqual(expect.objectContaining({ eventType: "EXECUTION_BANK_OPERATION_PREVENTED", payload: expect.objectContaining({ reason: "FINANCIAL_PLAN_NOT_READY", planStatus: "SUPERSEDED" }) }));
  });

  it("recompiles an expired confirmed goal into a fresh plan without transferring the old approval", async () => {
    const goal = appleGoal(); const oldPlan = planWithExpiry(applePlan(), new Date(Date.now() - 1)); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const oldAuthorization = await authorize(repository, oldPlan);
    const freshPlan = planWithExpiry(FinancialPlanV1.parse({ ...applePlan(), id: "plan-apple-refreshed", planHash: "0".repeat(64) }), new Date(Date.now() + 60_000));
    const compiler = { async compile(_goal: GoalContractV1, state: BankStateSnapshotV1) { return CompilerResultV1.parse({ schemaVersion: "1", status: "SAT", plan: { ...freshPlan, bankStateVersion: state.stateVersion } }); } };
    const result = await new CompilationService(repository, bank, compiler).compile(goal.id, "trace-refresh"); if (result.status !== "SAT") throw new Error("Expected SAT");
    expect(result.plan.id).toBe("plan-apple-refreshed"); expect(result.plan.id).not.toBe(oldPlan.id);
    expect(() => verifyExecutionApproval({ goal, plan: result.plan, planStatus: "READY", approval: oldAuthorization.approval, approvalEvidence: oldAuthorization.evidence, executionState: "AUTHORIZED" })).toThrow("Approval is for a different plan");
    expect(bank.writes).toBe(0);
  });

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
    await expect(gateway.execute({ goal, plan, planStatus: "READY", approval: approved.approval, approvalEvidence: approved.evidence, executionState: "EXECUTING", expectedStateVersion: 7, currentStateVersion: 7, revalidationSucceeded: false, idempotencyKey: "mutated-action", proposedStep: { ...step, parameters: { ...step.parameters, sourceMoney: { currency: "SGD", minorUnits: "210000" } } } }, "trace-injection")).rejects.toThrow("UNAPPROVED_EXECUTABLE_ACTION");
    expect(bank.writes).toBe(0);
  });

  it("derives the bank path and payload from the exact approved proposed step", async () => {
    const goal = appleGoal(); const plan = applePlan(); const repository = new MemoryRepository(goal); const bank = new ControlledBank(appleState(true)); const approved = await authorize(repository, plan); const step = plan.steps[0]!;
    await new ExecutionGateway(bank).execute({ goal, plan, planStatus: "READY", approval: approved.approval, approvalEvidence: approved.evidence, executionState: "EXECUTING", expectedStateVersion: 7, currentStateVersion: 7, revalidationSucceeded: false, idempotencyKey: "bound-operation", proposedStep: step }, "trace-bound-operation");
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
