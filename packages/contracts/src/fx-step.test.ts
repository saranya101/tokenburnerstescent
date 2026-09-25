import { describe, expect, it } from "vitest";
import { FinancialPlanStepV1 } from "./index.js";

const step = {
  id: "step-fx", sequence: 0, action: "FX_CONVERT", dependsOn: [], reversible: false,
  parameters: {
    sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd",
    sourceMoney: { currency: "SGD", minorUnits: "100" },
    targetCurrency: "USD", quoteId: "quote-sgd-usd-1",
  },
};

describe("executable FX destination binding", () => {
  it("accepts a step with both canonical accounts", () => {
    expect(FinancialPlanStepV1.parse(step)).toEqual(step);
  });
  it("rejects an unbound destination", () => {
    const parameters: Record<string, unknown> = { ...step.parameters };
    delete parameters.destinationAccountId;
    expect(FinancialPlanStepV1.safeParse({ ...step, parameters }).success).toBe(false);
  });
  it("rejects the previous source-only fields", () => {
    expect(FinancialPlanStepV1.safeParse({ ...step, parameters: {
      accountId: "acc-sgd", fromAmount: step.parameters.sourceMoney,
      toCurrency: "USD", quoteId: "quote-sgd-usd-1",
    } }).success).toBe(false);
  });
});
