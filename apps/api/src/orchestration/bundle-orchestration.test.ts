import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BankStateSnapshotV1, FinancialPlanV1, GoalBundleContractV1, IntentBundleDraftV1,
  type BundleSatisfactionProofV1, type CompileGoalBundleRequestV1, type GoalBundleContractV1 as GoalBundleContract,
} from "@parlance/contracts";
import { hashGoalBundleContract } from "@parlance/contracts/server";
import { ModelBackedIntentBundleInterpreter, type EntityGrounder, type IntentBundleModelClient } from "@parlance/intent-engine";
import { describe, expect, it, vi } from "vitest";
import { hashFinancialPlan } from "../security/canonical-hash.js";
import { BundleCompilationService, verifyBundleCompilerResult } from "./bundle-compilation.js";
import { BundleMessageOrchestrationService } from "./bundle-services.js";
import type {
  BundleClarificationProgress, BundleConfirmationRepository, BundlePlanRepository, GoalBundleCandidate, ParlanceRepository,
  StoredBundleCandidate, StoredBundleClarification, StoredGoalBundle,
} from "./ports.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));
const acceptanceText = "Send John USD 300 and then buy one Apple share, but keep at least S$1,000 available.";

function draft(text: string): IntentBundleDraftV1 {
  const plain = /\band buy\b/iu.test(text); const reversed = /^(?:Buy|Before buying)/u.test(text); const withReserve = /keep at least/iu.test(text);
  const transfer = { itemId: "model-transfer", goal: { type: "DELIVER_MONEY" as const, recipientReference: "John", amount: { currency: "USD", minorUnits: "30000" } }, constraints: [], preferences: [] };
  const asset = { itemId: "model-asset", goal: { type: "ACQUIRE_ASSET" as const, assetReference: "Apple", quantity: "1" }, constraints: [], preferences: [] };
  return IntentBundleDraftV1.parse({
    schemaVersion: "1", items: reversed ? [asset, transfer] : [transfer, asset],
    globalConstraints: withReserve ? [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" } }] : [],
    explicitDependencies: plain ? [] : [{ beforeItemId: "model-transfer", afterItemId: "model-asset", reason: "USER_EXPLICIT_ORDER" }],
  });
}

class MemoryBundleRepository implements BundleConfirmationRepository {
  clarification: StoredBundleClarification | undefined; candidate: StoredBundleCandidate | undefined; confirmed: StoredGoalBundle | undefined;
  rejected = 0; lastValidation: unknown;
  async saveBundleClarification(input: Parameters<BundleConfirmationRepository["saveBundleClarification"]>[0]) { this.clarification = input; return input; }
  async getBundleClarification(id: string) { return this.clarification?.clarificationId === id ? this.clarification : null; }
  async advanceBundleClarification(input: Parameters<BundleConfirmationRepository["advanceBundleClarification"]>[0]): Promise<BundleClarificationProgress> {
    if (input.candidate) {
      this.candidate = { candidateId: input.clarificationId, bundleId: input.bundleId, userId: input.userId, version: input.version, createdAt: input.createdAt, originalText: input.originalText, intentBundle: input.intentBundle, candidate: input.candidate, clarificationAnswers: input.clarificationAnswers, ...(input.inputProvenance ? { inputProvenance: input.inputProvenance } : {}) };
      this.clarification = undefined; return { status: "AWAITING_BUNDLE_CONFIRMATION", candidate: this.candidate! };
    }
    this.clarification = input; return { status: "NEEDS_CLARIFICATION", request: input };
  }
  async saveBundleCandidate(input: Parameters<BundleConfirmationRepository["saveBundleCandidate"]>[0]) { this.candidate = input; return input; }
  async getBundleCandidate(id: string) { return this.candidate?.candidateId === id ? this.candidate : null; }
  async rejectBundleSemanticValidation(input: Parameters<BundleConfirmationRepository["rejectBundleSemanticValidation"]>[0]) { this.rejected += 1; this.lastValidation = input.validation; this.clarification = undefined; }
  async confirmGoalBundle(input: Parameters<BundleConfirmationRepository["confirmGoalBundle"]>[0]) { this.confirmed = { rowId: "bundle-row", userId: input.userId, contract: input.contract }; return this.confirmed; }
}

function interpreter(value: unknown) {
  const client: IntentBundleModelClient = { generateIntentBundle: vi.fn().mockResolvedValue(value) };
  return new ModelBackedIntentBundleInterpreter(client);
}

function grounder(ambiguousJohn = false): EntityGrounder {
  return { async ground(input) {
    if (input.reference === "John" && ambiguousJohn) return { status: "AMBIGUOUS" as const, reference: "John", expectedEntityType: "BENEFICIARY" as const, candidates: [
      { entityType: "BENEFICIARY" as const, entityId: "ben-john-tan", canonicalName: "John Tan" },
      { entityType: "BENEFICIARY" as const, entityId: "ben-john-lee", canonicalName: "John Lee" },
    ] };
    if (input.reference === "John" || input.reference === "John Tan") return { status: "RESOLVED" as const, reference: input.reference, entityType: "BENEFICIARY" as const, entityId: "ben-john-tan", resolutionMethod: "EXACT" as const };
    if (input.reference === "Apple") return { status: "RESOLVED" as const, reference: "Apple", entityType: "ASSET" as const, entityId: "asset-aapl", resolutionMethod: "EXACT" as const };
    return { status: "NOT_FOUND" as const, reference: input.reference, ...(input.expectedEntityType ? { expectedEntityType: input.expectedEntityType } : {}) };
  } };
}

const exactCases = [
  ["Send John USD 300 and buy one Apple share.", false, false],
  ["Send John USD 300 and then buy one Apple share.", true, false],
  ["Buy one Apple share after sending John USD 300.", true, true],
  ["Before buying one Apple share, send John USD 300.", true, true],
  [acceptanceText, true, false],
] as const;

describe("production bundle message orchestration", () => {
  it.each(exactCases)("creates one confirmation candidate for %s", async (text, ordered, reversed) => {
    const repository = new MemoryBundleRepository();
    const service = new BundleMessageOrchestrationService(repository, interpreter(draft(text)), () => grounder(), undefined, undefined, undefined, undefined, () => new Date("2026-10-02T12:00:00Z"), (() => { let id = 0; return () => `server-${++id}`; })());
    const result = await service.receive({ userId: "user-1", text }, "trace-bundle");
    expect(result, JSON.stringify(repository.lastValidation)).toMatchObject({ status: "AWAITING_BUNDLE_CONFIRMATION", candidateId: "server-1" });
    expect(repository.candidate?.candidate.items.map(({ itemId }) => itemId)).toEqual(["item-1", "item-2"]);
    expect(repository.candidate?.candidate.items.map(({ goal }) => goal.type)).toEqual(reversed ? ["ACQUIRE_ASSET", "DELIVER_MONEY"] : ["DELIVER_MONEY", "ACQUIRE_ASSET"]);
    expect(repository.candidate?.candidate.explicitDependencies).toEqual(ordered ? [{ beforeItemId: reversed ? "item-2" : "item-1", afterItemId: reversed ? "item-1" : "item-2", reason: "USER_EXPLICIT_ORDER" }] : []);
    expect(repository.candidate?.candidate.globalConstraints).toEqual(text === acceptanceText ? [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" } }] : []);
  });

  it("clarifies only John, preserves Apple and stable IDs, then confirms one authoritative hash", async () => {
    const text = "Send John USD 300 and buy Apple."; const repository = new MemoryBundleRepository();
    const service = new BundleMessageOrchestrationService(repository, interpreter(draft(text)), () => grounder(true), undefined, undefined, undefined, undefined, () => new Date("2026-10-02T12:00:00Z"), (() => { let id = 0; return () => `server-${++id}`; })());
    const pending = await service.receive({ userId: "user-1", text }, "trace-clarify");
    expect(pending).toMatchObject({ status: "NEEDS_BUNDLE_CLARIFICATION", clarifications: [{ field: "items[0].goal.recipientReference", originalReference: "John" }] });
    const appleBefore = structuredClone(repository.clarification!.intentBundle.items[1]);
    const continued = await service.answerClarification("server-1", { selectedCandidateId: "ben-john-tan" }, "trace-answer");
    expect(continued).toMatchObject({ status: "AWAITING_BUNDLE_CONFIRMATION", goalBundleCandidate: { items: [{ itemId: "item-1", goal: { recipientId: "ben-john-tan" } }, { itemId: "item-2", goal: { assetId: "asset-aapl" } }] } });
    expect(repository.candidate?.intentBundle.items[1]).toEqual(appleBefore);
    expect(repository.candidate?.clarificationAnswers).toEqual([{ field: "items[0].goal.recipientReference", originalReference: "John", answer: "John Tan" }]);
    const confirmed = await service.confirm("server-1", "trace-confirm");
    expect(confirmed.goalBundleContract.contractHash).toBe(hashGoalBundleContract(confirmed.goalBundleContract));
    expect(confirmed.goalBundleContract.items.every((item) => item.bindings.every((binding) => binding.confirmed))).toBe(true);
  });

  it("routes the headline voice transcript through the existing bundle and targeted clarification path", async () => {
    const repository = new MemoryBundleRepository();
    const modelBundle = draft(acceptanceText);
    const reversedModelBundle = IntentBundleDraftV1.parse({ ...modelBundle, items: [...modelBundle.items].reverse() });
    const service = new BundleMessageOrchestrationService(repository, interpreter(reversedModelBundle), () => grounder(true), undefined, undefined, undefined, undefined, () => new Date("2026-10-03T10:00:00Z"), (() => { let id = 0; return () => `voice-${++id}`; })());
    const result = await service.receive({ userId: "user-1", text: acceptanceText, inputMode: "VOICE", voice: { rawTranscript: acceptanceText, provider: "browser-web-speech", transcribedAt: "2026-10-03T09:59:00.000Z" } }, "trace-voice-bundle");
    expect(result).toMatchObject({ status: "NEEDS_BUNDLE_CLARIFICATION", clarifications: [{ originalReference: "John" }] });
    expect(repository.clarification?.inputProvenance).toMatchObject({ inputMode: "VOICE", rawTranscript: acceptanceText, submittedText: acceptanceText, edited: false });
    expect(repository.clarification?.intentBundle.items.map(({ goal }) => goal.type)).toEqual(["DELIVER_MONEY", "ACQUIRE_ASSET"]);
    expect(repository.clarification?.intentBundle.explicitDependencies).toHaveLength(1);
    expect(repository.clarification?.intentBundle.globalConstraints).toEqual([{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" } }]);
  });

  it("freezes on coverage validation failure before candidate, contract, compiler or bank authority", async () => {
    const repository = new MemoryBundleRepository(); const malformed = { ...draft("Send John USD 300 and buy one Apple share."), items: [draft("Send John USD 300 and buy one Apple share.").items[0]] };
    const result = await new BundleMessageOrchestrationService(repository, interpreter(malformed), () => grounder()).receive({ userId: "user-1", text: "Send John USD 300 and buy one Apple share." }, "trace-reject");
    expect(result.status).toBe("SEMANTIC_VALIDATION_FAILED"); expect(repository.rejected).toBe(1); expect(repository.candidate).toBeUndefined(); expect(repository.confirmed).toBeUndefined();
  });
});

function confirmedBundle(): GoalBundleContract {
  const repository = new MemoryBundleRepository();
  const candidate: GoalBundleCandidate = {
    schemaVersion: "1",
    items: [
      { itemId: "item-1", goal: { type: "DELIVER_MONEY", recipientId: "ben-john-tan", amount: { currency: "USD", minorUnits: "30000" } }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "John Tan", entityType: "BENEFICIARY", entityId: "ben-john-tan", resolutionMethod: "USER_CONFIRMED", confirmed: true }] },
      { itemId: "item-2", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: true }] },
    ], globalConstraints: [], explicitDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
  };
  const unhashed = GoalBundleContractV1.parse({ ...candidate, bundleId: "bundle-1", bundleVersion: 1, contractHash: "0".repeat(64) });
  void repository; return GoalBundleContractV1.parse({ ...unhashed, contractHash: hashGoalBundleContract(unhashed) });
}

function compositePlan(stateVersion = 7) {
  const raw = FinancialPlanV1.parse({
    schemaVersion: "1", id: "plan-bundle", goalContractId: "bundle-1", goalContractVersion: 1, bankStateVersion: stateVersion,
    compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "0".repeat(64),
    steps: [
      { id: "transfer", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-john-tan", amount: { currency: "USD", minorUnits: "30000" } } },
      { id: "buy", sequence: 1, action: "BUY_ASSET", dependsOn: ["transfer"], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "25000" }, quoteId: "asset-quote-aapl-usd-v1", settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } },
    ], validity: { requiredQuoteIds: ["asset-quote-aapl-usd-v1"] }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [{ assetId: "asset-aapl", quantity: "1" }], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] },
  });
  return { ...raw, planHash: hashFinancialPlan(raw) };
}

function proof(overrides: Partial<BundleSatisfactionProofV1> = {}): BundleSatisfactionProofV1 {
  const bundle = confirmedBundle();
  return { schemaVersion: "1", bundleId: bundle.bundleId, bundleContractHash: bundle.contractHash, itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer"] }, { itemId: "item-2", satisfiedByStepIds: ["buy"] }], allItemsSatisfied: true, allHardConstraintsSatisfied: true, allExplicitDependenciesSatisfied: true, allIrreversibleStepsJustified: true, ...overrides };
}

describe("bundle compiler trust boundary", () => {
  it.each([
    ["wrong bundle id", { bundleId: "bundle-other" }, "BUNDLE_SATISFACTION_PROOF_BINDING_MISMATCH"],
    ["missing coverage", { itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer"] }] }, "BUNDLE_PROOF_MISSING_ITEM_COVERAGE"],
    ["unknown coverage", { itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer"] }, { itemId: "unknown", satisfiedByStepIds: ["buy"] }] }, "BUNDLE_PROOF_UNKNOWN_ITEM"],
    ["duplicate item coverage", { itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer"] }, { itemId: "item-1", satisfiedByStepIds: ["buy"] }] }, "BUNDLE_PROOF_DUPLICATE_ITEM"],
    ["false satisfied", { allItemsSatisfied: false }, "BUNDLE_ITEMS_NOT_SATISFIED"],
    ["wrong hash", { bundleContractHash: "f".repeat(64) }, "BUNDLE_SATISFACTION_PROOF_BINDING_MISMATCH"],
    ["unknown step", { itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["missing"] }, { itemId: "item-2", satisfiedByStepIds: ["buy"] }] }, "BUNDLE_PROOF_UNKNOWN_STEP"],
    ["unsatisfied global constraint", { allHardConstraintsSatisfied: false }, "BUNDLE_HARD_CONSTRAINTS_NOT_SATISFIED"],
    ["unsatisfied explicit dependency", { allExplicitDependenciesSatisfied: false }, "BUNDLE_DEPENDENCIES_NOT_SATISFIED"],
    ["unjustified irreversible step", { allIrreversibleStepsJustified: false }, "BUNDLE_IRREVERSIBLE_STEPS_NOT_JUSTIFIED"],
  ] as const)("blocks %s", (_label, overrides, code) => {
    expect(() => verifyBundleCompilerResult(confirmedBundle(), 7, compositePlan(), proof(overrides as Partial<BundleSatisfactionProofV1>))).toThrow(code);
  });

  it("uses only the persisted confirmed bundle plus fresh authoritative bank state", async () => {
    const bundle = confirmedBundle(); const state = BankStateSnapshotV1.parse({ ...(fixture("bank-state.json") as object), userId: "user-1", stateVersion: 19, assetQuotes: [{ quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00Z" }] });
    let saved: { plan: FinancialPlanV1; proof: BundleSatisfactionProofV1 } | undefined; let request: CompileGoalBundleRequestV1 | undefined;
    const repository = {
      async getConfirmedGoalBundle() { return { rowId: "bundle-row", userId: "user-1", contract: bundle }; }, async saveSnapshot() {},
      async saveBundlePlan(_row: string, plan: FinancialPlanV1, satisfaction: BundleSatisfactionProofV1) { saved = { plan, proof: satisfaction }; }, async saveBundleCompilationFailure() {},
    } as unknown as ParlanceRepository & BundlePlanRepository;
    const bank = { getState: vi.fn().mockResolvedValue(state) };
    const compiler = { compile: vi.fn(), compileBundle: vi.fn().mockImplementation(async (value: CompileGoalBundleRequestV1) => { request = value; return { financialPlan: compositePlan(value.bankState.stateVersion), satisfactionProof: proof() }; }) };
    const result = await new BundleCompilationService(repository, bank as never, compiler).compile(bundle.bundleId, "trace-compile");
    expect(request).toEqual({ goalBundle: bundle, bankState: state }); expect(JSON.stringify(request)).not.toContain("originalText");
    expect(request?.bankState.assetQuotes).toEqual(state.assetQuotes);
    expect(saved?.plan.planHash).toBe(hashFinancialPlan(saved!.plan)); expect("financialPlan" in result).toBe(true);
  });

  it("does not compile an unconfirmed bundle", async () => {
    const compiler = { compile: vi.fn(), compileBundle: vi.fn() };
    const repository = { getConfirmedGoalBundle: vi.fn().mockResolvedValue(null) } as unknown as ParlanceRepository & BundlePlanRepository;
    await expect(new BundleCompilationService(repository, {} as never, compiler).compile("bundle-1", "trace")).rejects.toThrow("CONFIRMED_GOAL_BUNDLE_NOT_FOUND");
    expect(compiler.compileBundle).not.toHaveBeenCalled();
  });

  it("does not persist an approval-eligible plan when proof verification fails", async () => {
    const bundle = confirmedBundle(); const state = BankStateSnapshotV1.parse({ ...(fixture("bank-state.json") as object), userId: "user-1", stateVersion: 7 });
    const repository = {
      getConfirmedGoalBundle: vi.fn().mockResolvedValue({ rowId: "bundle-row", userId: "user-1", contract: bundle }), saveSnapshot: vi.fn(),
      saveBundlePlan: vi.fn(), saveBundleCompilationFailure: vi.fn(),
    } as unknown as ParlanceRepository & BundlePlanRepository;
    const compiler = { compile: vi.fn(), compileBundle: vi.fn().mockResolvedValue({ financialPlan: compositePlan(), satisfactionProof: proof({ itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer"] }] }) }) };
    await expect(new BundleCompilationService(repository, { getState: vi.fn().mockResolvedValue(state) } as never, compiler).compile(bundle.bundleId, "trace-invalid-proof")).rejects.toThrow("BUNDLE_PROOF_MISSING_ITEM_COVERAGE");
    expect(repository.saveBundlePlan).not.toHaveBeenCalled();
  });
});
