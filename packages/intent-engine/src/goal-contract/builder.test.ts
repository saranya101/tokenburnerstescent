import type { IntentDraftV1 } from "@parlance/contracts";
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

it("maps DELIVER_MONEY to a canonical recipient ID and validates the final contract", () => {
  const contract = build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientReference: "NTU" }), [resolved("NTU", "BENEFICIARY", "ben_ntu")]);
  expect(contract.goal).toEqual({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben_ntu" });
  expect(GoalContractCandidateV1.safeParse(contract).success).toBe(true);
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

it("returns semantic candidate data only and never authors lifecycle or hash fields", () => {
  const candidate = build(intent({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }), [resolved("NTU", "BENEFICIARY", "ben_ntu")]);
  expect(candidate).not.toHaveProperty("contractHash");
  expect(candidate).not.toHaveProperty("status");
  expect(candidate).not.toHaveProperty("createdAt");
  expect(candidate).not.toHaveProperty("confirmedAt");
  expect(candidate.entityBindings[0]?.confirmed).toBe(false);
});
