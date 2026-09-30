import { IntentDraftV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { intentReferenceOccurrences } from "./references.js";

it("projects authoritative grounding requirements for candidate-flow consumers", () => {
  const draft = IntentDraftV1.parse({
    schemaVersion: "1",
    originalText: "Send NTU USD 5",
    goal: {
      type: "DELIVER_MONEY",
      amount: { currency: "USD", minorUnits: "500" },
      recipientReference: "NTU",
    },
    constraints: [],
    preferences: [],
    references: [
      { reference: "  ntu ", expectedEntityType: "ASSET" },
      { reference: "Emergency Savings", expectedEntityType: "ACCOUNT" },
    ],
  });

  expect(intentReferenceOccurrences(draft)).toEqual([
    { field: "goal.recipientReference", reference: "NTU", expectedEntityType: "BENEFICIARY" },
    { field: "references[1].reference", reference: "Emergency Savings", expectedEntityType: "ACCOUNT" },
  ]);
});
