import { GoalContractV1, type IntentDraftV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { DeterministicGoalContractBuilder } from "./builder.js";
import { GoalContractBuilderError } from "./errors.js";
import { GoalContractCandidateV1 } from "./types.js";
import type { EntityGroundingResult } from "../grounding/types.js";

const builder = new DeterministicGoalContractBuilder();
function intent(goal: unknown, constraints: unknown[] = [], preferences: unknown[] = [], references: unknown[] = []): IntentDraftV1 {
  return {
    schemaVersion: "1", originalText: "test", goal, constraints, preferences, references,
  } as IntentDraftV1;
}

function resolved(reference: string, entityType: "ACCOUNT" | "BENEFICIARY" | "ASSET" | "BILLER", entityId: string, resolutionMethod: "EXACT" | "ALIAS" = "EXACT"): EntityGroundingResult {
  return { status: "RESOLVED", reference, entityType, entityId, resolutionMethod };
}

function build(draft: IntentDraftV1, groundingResults: readonly EntityGroundingResult[]) {
  return builder.build({ draft, groundingResults });
}

it("maps DELIVER_MONEY to a canonical recipient ID and validates the lifecycle-free candidate", () => {
  const contract = build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientReference: "NTU" }), [resolved("NTU", "BENEFICIARY", "ben_ntu")]);
  expect(contract.goal).toEqual({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben_ntu" });
  expect(GoalContractCandidateV1.safeParse(contract).success).toBe(true);
  expect(GoalContractV1.safeParse(contract).success).toBe(false);
});

it("maps ACQUIRE_ASSET references while preserving budget-only and quantity forms", () => {
  const budgetOnly = build(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: { currency: "USD", minorUnits: "50000" } }), [resolved("Apple", "ASSET", "asset_aapl")]);
  expect(budgetOnly.goal).toEqual({ type: "ACQUIRE_ASSET", assetId: "asset_aapl", budget: { currency: "USD", minorUnits: "50000" } });
  const quantityAndBudget = build(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2", budget: { currency: "USD", minorUnits: "50000" } }), [resolved("Apple", "ASSET", "asset_aapl")]);
  expect(quantityAndBudget.goal).toEqual({ type: "ACQUIRE_ASSET", assetId: "asset_aapl", quantity: "2", budget: { currency: "USD", minorUnits: "50000" } });
});

it("maps PAY_BILL and MOVE_FUNDS account references to canonical IDs", () => {
  const bill = build(intent({ type: "PAY_BILL", billerReference: "SP", amount: { currency: "SGD", minorUnits: "1000" } }), [resolved("SP", "BILLER", "biller_sp")]);
  expect(bill.goal).toEqual({ type: "PAY_BILL", billerId: "biller_sp", amount: { currency: "SGD", minorUnits: "1000" } });
  const move = build(intent({ type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "1000" }, sourceAccountReference: "Main", destinationAccountReference: "Savings" }), [resolved("Main", "ACCOUNT", "acc_main"), resolved("Savings", "ACCOUNT", "acc_savings")]);
  expect(move.goal).toEqual({ type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "1000" }, sourceAccountId: "acc_main", destinationAccountId: "acc_savings" });
});

it("maps account-bearing constraints and preferences to canonical IDs", () => {
  const draft = intent(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Savings" }, { type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "500" }, accountReference: "Main" }],
    [{ type: "PREFER_ACCOUNT", accountReference: "Main" }],
  );
  const contract = build(draft, [resolved("NTU", "BENEFICIARY", "ben_ntu"), resolved("Savings", "ACCOUNT", "acc_savings"), resolved("Main", "ACCOUNT", "acc_main")]);
  expect(contract.constraints).toEqual([
    { type: "EXCLUDED_ACCOUNT", accountId: "acc_savings" }, { type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "500" }, accountId: "acc_main" },
  ]);
  expect(contract.preferences).toEqual([{ type: "PREFER_ACCOUNT", accountId: "acc_main" }]);
});

it("preserves original references in deterministic, deduplicated entity bindings", () => {
  const draft = intent(
    { type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "1000" }, sourceAccountReference: "Main", destinationAccountReference: "Main" }, [], [],
    [{ reference: "Main", expectedEntityType: "ACCOUNT" }],
  );
  const contract = build(draft, [resolved("Main", "ACCOUNT", "acc_main", "ALIAS"), resolved("Main", "ACCOUNT", "acc_main", "EXACT")]);
  expect(contract.entityBindings).toEqual([{ schemaVersion: "1", reference: "Main", entityType: "ACCOUNT", entityId: "acc_main", resolutionMethod: "EXACT", confirmed: false }]);
});

it("builds from the semantic role when supplemental metadata contradicts it", () => {
  const draft = intent(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "Nanyang Technological University" },
    [],
    [],
    [{ reference: "Nanyang Technological University", expectedEntityType: "ASSET" }],
  );
  const contract = build(draft, [
    resolved("Nanyang Technological University", "BENEFICIARY", "ben-ntu"),
    { status: "NOT_FOUND", reference: "Nanyang Technological University", expectedEntityType: "ASSET" },
  ]);
  expect(contract.goal).toMatchObject({ type: "DELIVER_MONEY", recipientId: "ben-ntu" });
  expect(contract.entityBindings).toEqual([{
    schemaVersion: "1",
    reference: "Nanyang Technological University",
    entityType: "BENEFICIARY",
    entityId: "ben-ntu",
    resolutionMethod: "EXACT",
    confirmed: false,
  }]);
});

it("allows one normalized phrase to bind independently in distinct semantic roles", () => {
  const draft = intent(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "Shared Name" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Shared Name" }],
  );
  const contract = build(draft, [
    resolved("Shared Name", "BENEFICIARY", "ben-shared"),
    resolved("Shared Name", "ACCOUNT", "acc-shared"),
  ]);
  expect(contract.goal).toMatchObject({ recipientId: "ben-shared" });
  expect(contract.constraints).toEqual([{ type: "EXCLUDED_ACCOUNT", accountId: "acc-shared" }]);
  expect(contract.entityBindings).toHaveLength(2);
});

it("requires and audits declared references even when their expected type is omitted", () => {
  const draft = intent(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }, [], [],
    [{ reference: "Emergency Savings" }],
  );
  const contract = build(draft, [resolved("NTU", "BENEFICIARY", "ben_ntu"), resolved("Emergency Savings", "ACCOUNT", "acc_emergency")]);
  expect(contract.entityBindings.map((binding) => binding.reference)).toEqual(["Emergency Savings", "NTU"]);
});

it.each([
  ["AMBIGUOUS", { status: "AMBIGUOUS", reference: "NTU", expectedEntityType: "BENEFICIARY", candidates: [] }],
  ["CANDIDATES", { status: "CANDIDATES", reference: "NTU", expectedEntityType: "BENEFICIARY", candidates: [] }],
  ["NOT_FOUND", { status: "NOT_FOUND", reference: "NTU", expectedEntityType: "BENEFICIARY" }],
])("refuses %s grounding results", (_status, grounding) => {
  expect(() => build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }), [grounding as EntityGroundingResult])).toThrow(GoalContractBuilderError);
});

it("fails deterministically for missing, wrong-type, and inconsistent groundings", () => {
  const value = intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" });
  expect(() => build(value, [])).toThrow(expect.objectContaining({ code: "MISSING_GROUNDING" }));
  expect(() => build(value, [resolved("NTU", "ACCOUNT", "acc_ntu")])).toThrow(expect.objectContaining({ code: "TYPE_MISMATCH" }));
  expect(() => build(value, [resolved("NTU", "BENEFICIARY", "ben_one"), resolved("NTU", "BENEFICIARY", "ben_two")])).toThrow(expect.objectContaining({ code: "INCONSISTENT_BINDING" }));
});

it("leaves lifecycle ownership and confirmation exclusively to Person A", () => {
  const contract = build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }), [resolved("NTU", "BENEFICIARY", "ben_ntu")]);
  expect(Object.keys(contract).sort()).toEqual(["constraints", "entityBindings", "goal", "preferences", "schemaVersion"]);
  expect(contract.entityBindings[0]?.confirmed).toBe(false);
  expect(contract).not.toHaveProperty("id");
  expect(contract).not.toHaveProperty("userId");
  expect(contract).not.toHaveProperty("version");
  expect(contract).not.toHaveProperty("status");
  expect(contract).not.toHaveProperty("contractHash");
  expect(contract).not.toHaveProperty("createdAt");
  expect(contract).not.toHaveProperty("confirmedAt");
});

it("rejects confirmed bindings at the candidate schema boundary", () => {
  const contract = build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }), [resolved("NTU", "BENEFICIARY", "ben_ntu")]);
  const confirmed = { ...contract, entityBindings: contract.entityBindings.map((binding) => ({ ...binding, confirmed: true })) };
  expect(GoalContractCandidateV1.safeParse(confirmed).success).toBe(false);
});
