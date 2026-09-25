import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { expect, it } from "vitest";
import { DeterministicIntentAmbiguityDetector } from "./detector.js";
import type { EntityGroundingResult } from "../grounding/types.js";

const detector = new DeterministicIntentAmbiguityDetector();

function draft(goal: IntentDraft["goal"], constraints: IntentDraft["constraints"] = [], preferences: IntentDraft["preferences"] = [], references: IntentDraft["references"] = []): IntentDraft {
  return IntentDraftV1.parse({ schemaVersion: "1", originalText: "test", goal, constraints, preferences, references });
}

function resolved(reference: string, entityType: "ACCOUNT" | "BENEFICIARY" | "ASSET" | "BILLER", entityId: string): EntityGroundingResult {
  return { status: "RESOLVED", reference, entityType, entityId, resolutionMethod: "EXACT" };
}

it("returns CLEAR when all financially material references are resolved", () => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50000" }, recipientReference: "NTU" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Emergency Savings" }],
    [{ type: "PREFER_ACCOUNT", accountReference: "Main" }],
  );
  expect(detector.analyze({ draft: value, groundingResults: [
    resolved("NTU", "BENEFICIARY", "ben_ntu"), resolved("Emergency Savings", "ACCOUNT", "acc_emergency"), resolved("Main", "ACCOUNT", "acc_main"),
  ] })).toEqual({ status: "CLEAR" });
});

it("requires clarification for ambiguous beneficiaries with deterministic options", () => {
  const value = draft({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50000" }, recipientReference: "John" });
  const result = detector.analyze({ draft: value, groundingResults: [{
    status: "AMBIGUOUS", reference: "John", expectedEntityType: "BENEFICIARY", candidates: [
      { entityId: "ben_john_tan", entityType: "BENEFICIARY", canonicalName: "John Tan" },
      { entityId: "ben_john_lim", entityType: "BENEFICIARY", canonicalName: "John Lim" },
    ],
  }] });
  expect(result).toEqual({ status: "NEEDS_CLARIFICATION", clarifications: [{
    reason: "AMBIGUOUS_ENTITY", field: "goal.recipientReference", originalReference: "John", questionKey: "clarify.entity.ambiguous", options: [
      { entityId: "ben_john_lim", entityType: "BENEFICIARY", displayName: "John Lim" },
      { entityId: "ben_john_tan", entityType: "BENEFICIARY", displayName: "John Tan" },
    ],
  }] });
});

it("requires clarification for semantic candidates even at 0.99 similarity", () => {
  const value = draft({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: { currency: "USD", minorUnits: "50000" } });
  const result = detector.analyze({ draft: value, groundingResults: [{
    status: "CANDIDATES", reference: "Apple", expectedEntityType: "ASSET", candidates: [
      { entityId: "asset_aapl", entityType: "ASSET", canonicalName: "Apple Inc.", similarityScore: 0.99 },
    ],
  }] });
  expect(result).toMatchObject({ status: "NEEDS_CLARIFICATION", clarifications: [{
    reason: "MULTIPLE_SEMANTIC_CANDIDATES", field: "goal.assetReference", originalReference: "Apple",
  }] });
});

it("preserves NOT_FOUND references for clarification", () => {
  const value = draft({ type: "PAY_BILL", billerReference: "My power company" });
  expect(detector.analyze({ draft: value, groundingResults: [{ status: "NOT_FOUND", reference: "My power company", expectedEntityType: "BILLER" }] })).toEqual({
    status: "NEEDS_CLARIFICATION", clarifications: [{
      reason: "ENTITY_NOT_FOUND", field: "goal.billerReference", originalReference: "My power company", questionKey: "clarify.entity.not_found", options: [],
    }],
  });
});

it("requires clarification for ambiguous MOVE_FUNDS accounts", () => {
  const value = draft({ type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "100000" }, destinationAccountReference: "Savings" });
  expect(detector.analyze({ draft: value, groundingResults: [{
    status: "AMBIGUOUS", reference: "Savings", expectedEntityType: "ACCOUNT", candidates: [
      { entityId: "acc_save_a", entityType: "ACCOUNT", canonicalName: "Savings A" }, { entityId: "acc_save_b", entityType: "ACCOUNT", canonicalName: "Savings B" },
    ],
  }] })).toMatchObject({ status: "NEEDS_CLARIFICATION", clarifications: [{ field: "goal.destinationAccountReference", reason: "AMBIGUOUS_ENTITY" }] });
});

it("does not return CLEAR when constraints or preferences remain unresolved", () => {
  const withConstraint = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Savings" }],
  );
  const withPreference = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" }, [],
    [{ type: "PREFER_ACCOUNT", accountReference: "Main" }],
  );
  expect(detector.analyze({ draft: withConstraint, groundingResults: [resolved("NTU", "BENEFICIARY", "ben_ntu"), { status: "AMBIGUOUS", reference: "Savings", expectedEntityType: "ACCOUNT", candidates: [] }] })).toMatchObject({ status: "NEEDS_CLARIFICATION", clarifications: [{ field: "constraints[0].accountReference" }] });
  expect(detector.analyze({ draft: withPreference, groundingResults: [resolved("NTU", "BENEFICIARY", "ben_ntu"), { status: "AMBIGUOUS", reference: "Main", expectedEntityType: "ACCOUNT", candidates: [] }] })).toMatchObject({ status: "NEEDS_CLARIFICATION", clarifications: [{ field: "preferences[0].accountReference" }] });
});

it("does not re-ask resolved fields and orders independent clarifications by field priority", () => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "John" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Savings" }],
    [{ type: "PREFER_ACCOUNT", accountReference: "Main" }],
    [{ reference: "NTU", expectedEntityType: "BENEFICIARY" }],
  );
  const result = detector.analyze({ draft: value, groundingResults: [
    { status: "AMBIGUOUS", reference: "John", expectedEntityType: "BENEFICIARY", candidates: [] },
    { status: "NOT_FOUND", reference: "Savings", expectedEntityType: "ACCOUNT" },
    { status: "CANDIDATES", reference: "Main", expectedEntityType: "ACCOUNT", candidates: [{ entityId: "acc_main", entityType: "ACCOUNT", canonicalName: "Main", similarityScore: 0.9 }] },
    resolved("NTU", "BENEFICIARY", "ben_ntu"),
  ] });
  expect(result).toMatchObject({ status: "NEEDS_CLARIFICATION", clarifications: [
    { field: "goal.recipientReference" }, { field: "constraints[0].accountReference" }, { field: "preferences[0].accountReference" },
  ] });
});

it("does not ask when a hard exclusion overrides a resolved soft account preference", () => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Main" }], [{ type: "PREFER_ACCOUNT", accountReference: "Main" }],
  );
  expect(detector.analyze({ draft: value, groundingResults: [resolved("NTU", "BENEFICIARY", "ben_ntu"), resolved("Main", "ACCOUNT", "acc_main")] })).toEqual({ status: "CLEAR" });
});
