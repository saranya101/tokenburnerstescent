import { expect, it } from "vitest";
import type { IntentDraftV1 } from "@parlance/contracts";
import { assertTokenHubSemanticSmokeDraft, TokenHubSemanticSmokeError } from "./smoke-fixture.js";

function validSmokeDraft(): IntentDraftV1 {
  return {
    schemaVersion: "1",
    originalText: "synthetic smoke input",
    goal: { type: "ACQUIRE_ASSET", assetReference: "NTU", budget: { currency: "USD", minorUnits: "500000" } },
    constraints: [
      { type: "MAX_TOTAL_COST", money: { currency: "SGD", minorUnits: "690000" } },
      { type: "EXCLUDED_ACCOUNT", accountReference: "Emergency Savings" },
    ],
    preferences: [],
    references: [],
  };
}

it("accepts the exact semantic smoke fixture", () => {
  expect(() => assertTokenHubSemanticSmokeDraft(validSmokeDraft())).not.toThrow();
});

it("rejects incorrect goal semantics", () => {
  const draft = validSmokeDraft();
  draft.goal = { type: "ACQUIRE_ASSET", assetReference: "XYZ", budget: { currency: "USD", minorUnits: "500000" } };
  expect(() => assertTokenHubSemanticSmokeDraft(draft)).toThrow(TokenHubSemanticSmokeError);
});

it("rejects missing, duplicate, or unexpected hard constraints", () => {
  const missing = validSmokeDraft();
  missing.constraints = missing.constraints.slice(0, 1);
  expect(() => assertTokenHubSemanticSmokeDraft(missing)).toThrow(/EXCLUDED_ACCOUNT/);

  const duplicate = validSmokeDraft();
  duplicate.constraints = [...duplicate.constraints, duplicate.constraints[0]!];
  expect(() => assertTokenHubSemanticSmokeDraft(duplicate)).toThrow(/exactly one MAX_TOTAL_COST/);

  const extra = validSmokeDraft();
  extra.constraints = [...extra.constraints, { type: "MAX_LOCK_IN_DAYS", days: 0 }];
  expect(() => assertTokenHubSemanticSmokeDraft(extra)).toThrow(/must not contain MAX_LOCK_IN_DAYS/);
});
