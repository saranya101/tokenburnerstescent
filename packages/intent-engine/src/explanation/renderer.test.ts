import {
  CompilerResultV1,
  ExecutionResultV1,
  FinancialPlanV1,
  GoalContractV1,
  type GoalContractV1 as GoalContract,
} from "@parlance/contracts";
import { expect, it } from "vitest";
import { ExplanationInputError } from "./errors.js";
import { DeterministicExplanationRenderer, renderExplanationText } from "./renderer.js";

const renderer = new DeterministicExplanationRenderer();
const hash = "a".repeat(64);

function binding(reference: string, entityType: "ACCOUNT" | "BENEFICIARY" | "ASSET" | "BILLER" | "OBLIGATION", entityId: string) {
  return { schemaVersion: "1" as const, reference, entityType, entityId, resolutionMethod: "EXACT" as const, confirmed: true };
}

function acquireGoal(): GoalContract {
  return GoalContractV1.parse({
    schemaVersion: "1",
    id: "goal-acquire",
    userId: "user-1",
    version: 1,
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-ntu", budget: { currency: "USD", minorUnits: "500000" } },
    constraints: [
      { type: "MAX_TOTAL_COST", money: { currency: "SGD", minorUnits: "690000" } },
      { type: "EXCLUDED_ACCOUNT", accountId: "acc-emergency" },
    ],
    preferences: [],
    entityBindings: [
      binding("NTU", "ASSET", "asset-ntu"),
      binding("Emergency Savings", "ACCOUNT", "acc-emergency"),
    ],
    status: "CONFIRMED",
    contractHash: hash,
    createdAt: "2026-09-29T00:00:00Z",
    confirmedAt: "2026-09-29T00:01:00Z",
  });
}

function deliveryGoal(): GoalContract {
  return GoalContractV1.parse({
    schemaVersion: "1",
    id: "goal-delivery",
    userId: "user-1",
    version: 1,
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben-ntu" },
    constraints: [],
    preferences: [],
    entityBindings: [
      binding("NTU", "BENEFICIARY", "ben-ntu"),
      binding("Main Wallet", "ACCOUNT", "acc-sgd"),
      binding("USD Wallet", "ACCOUNT", "acc-usd"),
    ],
    status: "CONFIRMED",
    contractHash: hash,
    createdAt: "2026-09-29T00:00:00Z",
    confirmedAt: "2026-09-29T00:01:00Z",
  });
}

function deliveryPlan() {
  return FinancialPlanV1.parse({
    schemaVersion: "1",
    id: "plan-delivery",
    goalContractId: "goal-delivery",
    goalContractVersion: 1,
    bankStateVersion: 7,
    compilerVersion: "1.0.0",
    policyVersion: "1.0.0",
    operationLibraryVersion: "1.0.0",
    steps: [
      {
        id: "step-fx",
        sequence: 0,
        action: "FX_CONVERT",
        dependsOn: [],
        reversible: false,
        parameters: {
          sourceAccountId: "acc-sgd",
          destinationAccountId: "acc-usd",
          sourceMoney: { currency: "SGD", minorUnits: "666667" },
          targetCurrency: "USD",
          quoteId: "quote-1",
        },
      },
      {
        id: "step-transfer",
        sequence: 1,
        action: "TRANSFER",
        dependsOn: ["step-fx"],
        reversible: false,
        parameters: {
          sourceAccountId: "acc-usd",
          beneficiaryId: "ben-ntu",
          amount: { currency: "USD", minorUnits: "500000" },
        },
      },
    ],
    validity: { validUntil: "2026-09-29T00:10:00Z", requiredQuoteIds: ["quote-1"] },
    projectedOutcome: {
      goalSatisfied: true,
      deliveredMoney: { currency: "USD", minorUnits: "500000" },
      acquiredAssets: [],
      paidObligationIds: [],
      projectedAvailableBalances: [],
      warnings: [],
    },
    planHash: hash,
  });
}

it("explains a grounded acquisition using human references and exact money values", () => {
  const explanation = renderer.explain({ subject: "GOAL", goal: acquireGoal() });
  const text = renderExplanationText(explanation);
  expect(text).toContain("Acquire NTU with a budget of USD 5,000.00.");
  expect(text).toContain("Keep the total cost at or below SGD 6,900.00.");
  expect(text).toContain("Do not use Emergency Savings.");
  expect(text).not.toContain("asset-ntu");
  expect(text).not.toContain("acc-emergency");
});

it("summarizes only existing plan steps in their supplied order", () => {
  const explanation = renderer.explain({ subject: "PLAN", plan: deliveryPlan(), goal: deliveryGoal() });
  const steps = explanation.statements.filter(({ kind }) => kind === "PLAN_STEP");
  expect(steps).toHaveLength(2);
  expect(steps.map(({ operation }) => operation)).toEqual(["FX_CONVERT", "TRANSFER"]);
  expect(steps[0]?.text).toContain("Step 1: Convert SGD 6,666.67");
  expect(steps[1]?.text).toContain("Step 2: Transfer USD 5,000.00");
  expect(renderExplanationText(explanation)).not.toMatch(/BUY_ASSET|PAY_BILL|SELL_ASSET/);
});

it("does not expose plan IDs when no human label is available", () => {
  const explanation = renderer.explain({ subject: "PLAN", plan: deliveryPlan() });
  const text = renderExplanationText(explanation);
  expect(text).not.toContain("acc-sgd");
  expect(text).not.toContain("acc-usd");
  expect(text).not.toContain("ben-ntu");
  expect(text).not.toContain("quote-1");
  expect(text).toContain("a source account");
  expect(text).toContain("the selected recipient");
});

it("describes a plan as proposed and never implies that it has executed", () => {
  const text = renderExplanationText(renderer.explain({ subject: "PLAN", plan: deliveryPlan(), goal: deliveryGoal() }));
  expect(text).toContain("This is a proposed 2-step plan");
  expect(text).toContain("does not say that any step has executed");
  expect(text).not.toContain("Execution completed");
  expect(text).not.toContain("status: SETTLED");
});

it("uses only supplied UNSAT reasons and compiler-provided relaxation suggestions", () => {
  const result = CompilerResultV1.parse({
    schemaVersion: "1",
    status: "UNSAT",
    reason: {
      code: "INSUFFICIENT_AVAILABLE_BALANCE",
      message: "No account can fund the goal while preserving the required available balance.",
      details: { stateVersion: 11, internalAccountId: "acc-secret" },
    },
    relaxations: [{ constraintType: "MIN_AVAILABLE_BALANCE", suggestion: "Lower the minimum available balance." }],
  });
  const text = renderExplanationText(renderer.explain({ subject: "COMPILER_RESULT", result }));
  expect(text).toContain("No account can fund the goal while preserving the required available balance.");
  expect(text).toContain("Compiler-provided option: Lower the minimum available balance.");
  expect(text).not.toContain("volatile");
  expect(text).not.toContain("stateVersion");
  expect(text).not.toContain("acc-secret");
});

it("does not invent options or reasons when optional compiler data is empty", () => {
  const result = CompilerResultV1.parse({
    schemaVersion: "1",
    status: "UNSAT",
    reason: { code: "NO_ROUTE", message: "No supported route was found." },
    relaxations: [],
  });
  const explanation = renderer.explain({ subject: "COMPILER_RESULT", result });
  expect(explanation.statements).toEqual([expect.objectContaining({ kind: "REASON", text: "No supported route was found." })]);
  expect(renderExplanationText(explanation)).not.toMatch(/option|recommend|try|market/i);
});

it("renders policy blocking from the compiler reason only", () => {
  const result = CompilerResultV1.parse({
    schemaVersion: "1",
    status: "POLICY_BLOCKED",
    reason: { code: "BENEFICIARY_BLOCKED", message: "The selected beneficiary is blocked by policy." },
  });
  const explanation = renderer.explain({ subject: "COMPILER_RESULT", result });
  expect(explanation.kind).toBe("POLICY_BLOCKED");
  expect(renderExplanationText(explanation)).toContain("The selected beneficiary is blocked by policy.");
  expect(explanation.statements).toHaveLength(1);
});

it("states execution only from a supplied ExecutionResult and omits bank references", () => {
  const result = ExecutionResultV1.parse({
    schemaVersion: "1",
    executionId: "exec-1",
    planId: "plan-delivery",
    status: "COMPLETED",
    startedStateVersion: 7,
    finalStateVersion: 9,
    steps: [{ stepId: "step-transfer", status: "SETTLED", idempotencyKey: "secret-idempotency", bankReference: "bank-secret" }],
    goalOutcome: {
      achieved: true,
      summary: "Internal summary mentioning asset-secret must not be copied.",
      deliveredMoney: { currency: "USD", minorUnits: "500000" },
    },
  });
  const text = renderExplanationText(renderer.explain({ subject: "EXECUTION_RESULT", result }));
  expect(text).toContain("Execution completed.");
  expect(text).toContain("Execution step 1 status: SETTLED.");
  expect(text).toContain("The recorded delivered amount is USD 5,000.00.");
  expect(text).not.toContain("bank-secret");
  expect(text).not.toContain("secret-idempotency");
  expect(text).not.toContain("asset-secret");
});

it("rejects a mismatched goal instead of applying its labels to another plan", () => {
  expect(() => renderer.explain({ subject: "PLAN", plan: deliveryPlan(), goal: acquireGoal() }))
    .toThrow(ExplanationInputError);
});
