import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { expect, it } from "vitest";
import { DeterministicIntentAmbiguityDetector } from "../ambiguity/detector.js";
import { DbEntityRepository } from "./db-repository.js";
import type { GroundingRawQueryClient } from "./db-types.js";
import { DeterministicEntityGrounder } from "./grounder.js";
import { groundingRequirementsForIntent } from "./requirements.js";

function draft(
  goal: IntentDraft["goal"],
  constraints: IntentDraft["constraints"] = [],
  preferences: IntentDraft["preferences"] = [],
  references: IntentDraft["references"] = [],
  originalText = "synthetic",
): IntentDraft {
  return IntentDraftV1.parse({ schemaVersion: "1", originalText, goal, constraints, preferences, references });
}

it("uses the DELIVER_MONEY role over contradictory supplemental metadata in the exact NTU regression", async () => {
  const originalText = "Send USD 7000.00 to Nanyang Technological University";
  const value = draft(
    {
      type: "DELIVER_MONEY",
      amount: { currency: "USD", minorUnits: "700000" },
      recipientReference: "Nanyang Technological University",
    },
    [],
    [],
    [{ reference: "Nanyang Technological University", expectedEntityType: "ASSET" }],
    originalText,
  );
  const snapshot = structuredClone(value);
  const requirements = groundingRequirementsForIntent(value);
  expect(requirements).toEqual([{
    field: "goal.recipientReference",
    reference: "Nanyang Technological University",
    expectedEntityType: "BENEFICIARY",
    source: "SEMANTIC_FIELD",
  }]);

  const client: GroundingRawQueryClient = {
    $queryRawUnsafe: async <T>() => [{
      ownerUserId: "user-a",
      entityType: "BENEFICIARY",
      entityId: "ben-ntu",
      canonicalName: "Nanyang Technological University",
    }] as T,
  };
  const grounder = new DeterministicEntityGrounder(new DbEntityRepository(client, "user-a"));
  const groundingResults = await Promise.all(requirements.map(({ reference, expectedEntityType }) =>
    grounder.ground({ reference, ...(expectedEntityType === undefined ? {} : { expectedEntityType }) })
  ));
  expect(groundingResults).toEqual([{
    status: "RESOLVED",
    reference: "Nanyang Technological University",
    entityType: "BENEFICIARY",
    entityId: "ben-ntu",
    resolutionMethod: "EXACT",
  }]);
  expect(new DeterministicIntentAmbiguityDetector().analyze({ draft: value, groundingResults })).toEqual({ status: "CLEAR" });
  expect(value).toEqual(snapshot);
});

it.each([
  ["matching", { reference: "NTU", expectedEntityType: "BENEFICIARY" }],
  ["missing", { reference: "  ntu  " }],
  ["contradictory", { reference: "ntu", expectedEntityType: "ASSET" }],
] as const)("deduplicates %s supplemental metadata against a semantic requirement", (_name, supplemental) => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "NTU" },
    [],
    [],
    [supplemental],
  );
  expect(groundingRequirementsForIntent(value)).toEqual([{
    field: "goal.recipientReference",
    reference: "NTU",
    expectedEntityType: "BENEFICIARY",
    source: "SEMANTIC_FIELD",
  }]);
});

it("preserves the same text used in genuine semantic fields with different roles", () => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "Shared Name" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Shared Name" }],
    [],
    [{ reference: "Shared Name", expectedEntityType: "ASSET" }],
  );
  expect(groundingRequirementsForIntent(value)).toEqual([
    { field: "goal.recipientReference", reference: "Shared Name", expectedEntityType: "BENEFICIARY", source: "SEMANTIC_FIELD" },
    { field: "constraints[0].accountReference", reference: "Shared Name", expectedEntityType: "ACCOUNT", source: "SEMANTIC_FIELD" },
  ]);
});

it("derives ASSET and BILLER roles from their goal fields", () => {
  const asset = draft({ type: "ACQUIRE_ASSET", assetReference: "Example Fund", quantity: "1" });
  const bill = draft({ type: "PAY_BILL", billerReference: "Example Utilities" });
  expect(groundingRequirementsForIntent(asset)[0]).toMatchObject({ expectedEntityType: "ASSET", field: "goal.assetReference" });
  expect(groundingRequirementsForIntent(bill)[0]).toMatchObject({ expectedEntityType: "BILLER", field: "goal.billerReference" });
});

it("derives ACCOUNT roles from move fields, constraints, and preferences", () => {
  const value = draft(
    {
      type: "MOVE_FUNDS",
      amount: { currency: "SGD", minorUnits: "1000" },
      sourceAccountReference: "Main",
      destinationAccountReference: "Savings",
    },
    [
      { type: "EXCLUDED_ACCOUNT", accountReference: "Emergency" },
      { type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "50000" }, accountReference: "Reserve" },
    ],
    [{ type: "PREFER_ACCOUNT", accountReference: "Daily" }],
  );
  expect(groundingRequirementsForIntent(value).map(({ field, expectedEntityType }) => [field, expectedEntityType])).toEqual([
    ["goal.sourceAccountReference", "ACCOUNT"],
    ["goal.destinationAccountReference", "ACCOUNT"],
    ["constraints[0].accountReference", "ACCOUNT"],
    ["constraints[1].accountReference", "ACCOUNT"],
    ["preferences[0].accountReference", "ACCOUNT"],
  ]);
});

it("retains unrelated supplemental references under their existing metadata", () => {
  const value = draft(
    { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "Alex" },
    [],
    [],
    [{ reference: "Emergency Savings", expectedEntityType: "ACCOUNT" }],
  );
  expect(groundingRequirementsForIntent(value)[1]).toEqual({
    field: "references[0].reference",
    reference: "Emergency Savings",
    expectedEntityType: "ACCOUNT",
    source: "SUPPLEMENTAL_REFERENCE",
  });
});
