import { expect, it } from "vitest";
import type { IntentDraftV1 } from "../../packages/contracts/src/index.js";
import { INTENT_EVALUATION_CASES } from "./cases.js";
import { evaluateIntentDraft } from "./evaluator.js";
import type { IntentEvaluationCase } from "./types.js";

const inputText = "Acquire Northstar ETF for US$750 without using Rainy Day.";
const evaluationCase: IntentEvaluationCase = {
  id: "evaluator-unit",
  category: "REGRESSION",
  description: "Evaluator unit-test case.",
  inputText,
  expected: {
    goalType: "ACQUIRE_ASSET",
    goalFields: [{ field: "assetReference", value: "Northstar ETF" }],
    goalMoney: { field: "budget", currency: "USD", minorUnits: "75000" },
    requiredConstraints: [{ type: "EXCLUDED_ACCOUNT", accountReference: "Rainy Day" }],
    requiredReferences: [{ reference: "Northstar ETF", expectedEntityType: "ASSET" }],
    exactOriginalText: true,
  },
  forbidden: { goalTypes: ["DELIVER_MONEY"], constraintTypes: ["MAX_LOCK_IN_DAYS"], goalFields: ["amount"] },
};

function correctDraft(): IntentDraftV1 {
  return {
    schemaVersion: "1",
    originalText: inputText,
    goal: { type: "ACQUIRE_ASSET", assetReference: "Northstar ETF", budget: { currency: "USD", minorUnits: "75000" } },
    constraints: [{ type: "EXCLUDED_ACCOUNT", accountReference: "Rainy Day" }],
    preferences: [],
    references: [{ reference: "Northstar ETF", expectedEntityType: "ASSET" }, { reference: "Rainy Day", expectedEntityType: "ACCOUNT" }],
  };
}

it("passes a correct already-validated IntentDraft", () => {
  const result = evaluateIntentDraft(evaluationCase, correctDraft());
  expect(result.status).toBe("PASS");
  expect(result.failureReasons).toEqual([]);
  expect(result.assertions.every((assertion) => assertion.status === "PASS")).toBe(true);
});

it("fails the wrong goal type", () => {
  const draft = correctDraft();
  draft.goal = { type: "DELIVER_MONEY", recipientReference: "Northstar ETF", amount: { currency: "USD", minorUnits: "75000" } };
  const result = evaluateIntentDraft(evaluationCase, draft);
  expect(result.status).toBe("FAIL");
  expect(result.failureReasons).toContain("Expected goal type ACQUIRE_ASSET; received DELIVER_MONEY.");
  expect(result.failureReasons).toContain("Forbidden goal type DELIVER_MONEY was produced.");
});

it("fails a missing required constraint", () => {
  const draft = correctDraft();
  draft.constraints = [];
  expect(evaluateIntentDraft(evaluationCase, draft)).toMatchObject({ status: "FAIL" });
  expect(evaluateIntentDraft(evaluationCase, draft).failureReasons[0]).toContain("EXCLUDED_ACCOUNT");
});

it("fails an invented forbidden hard constraint", () => {
  const draft = correctDraft();
  draft.constraints.push({ type: "MAX_LOCK_IN_DAYS", days: 0 });
  const result = evaluateIntentDraft(evaluationCase, draft);
  expect(result.status).toBe("FAIL");
  expect(result.failureReasons).toContain("Forbidden constraint type MAX_LOCK_IN_DAYS was produced.");
});

it("fails the wrong currency or monetary value", () => {
  const wrongCurrency = correctDraft();
  wrongCurrency.goal = { type: "ACQUIRE_ASSET", assetReference: "Northstar ETF", budget: { currency: "SGD", minorUnits: "75000" } };
  expect(evaluateIntentDraft(evaluationCase, wrongCurrency).failureReasons[0]).toContain("USD 75000");

  const wrongValue = correctDraft();
  wrongValue.goal = { type: "ACQUIRE_ASSET", assetReference: "Northstar ETF", budget: { currency: "USD", minorUnits: "7500" } };
  expect(evaluateIntentDraft(evaluationCase, wrongValue).status).toBe("FAIL");
});

it("fails a forbidden semantic outcome", () => {
  const preferenceCase: IntentEvaluationCase = { ...evaluationCase, forbidden: { preferenceTypes: ["FASTEST"] } };
  const draft = correctDraft();
  draft.preferences = [{ type: "FASTEST" }];
  expect(evaluateIntentDraft(preferenceCase, draft).failureReasons).toContain("Forbidden preference type FASTEST was produced.");
});

it("allows extra harmless references unless they are explicitly forbidden", () => {
  const draft = correctDraft();
  draft.references.push({ reference: "Optional Context", expectedEntityType: "ACCOUNT" });
  expect(evaluateIntentDraft(evaluationCase, draft).status).toBe("PASS");

  const forbiddenReferenceCase: IntentEvaluationCase = { ...evaluationCase, forbidden: { references: ["Optional Context"] } };
  expect(evaluateIntentDraft(forbiddenReferenceCase, draft).status).toBe("FAIL");
});

it("ships at least 15 unique cases across all initial categories", () => {
  expect(INTENT_EVALUATION_CASES.length).toBeGreaterThanOrEqual(15);
  expect(new Set(INTENT_EVALUATION_CASES.map((entry) => entry.id)).size).toBe(INTENT_EVALUATION_CASES.length);
  expect(new Set(INTENT_EVALUATION_CASES.map((entry) => entry.category))).toEqual(new Set(["HAPPY_PATH", "CONSTRAINT_PRESERVATION", "ENTITY_ROLE_SEMANTICS", "REGRESSION"]));
});
