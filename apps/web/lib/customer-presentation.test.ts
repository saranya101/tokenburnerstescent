import { FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { formatMoney, presentPlan } from "./customer-presentation";

it("renders exact minor-unit amounts without floating point coercion", () => {
  expect(formatMoney({ currency: "USD", minorUnits: "900719925474099312" })).toBe("USD 9,007,199,254,740,993.12");
  expect(formatMoney({ currency: "JPY", minorUnits: "5000" })).toBe("JPY 5,000");
});

it("derives account, recipient, FX quote, and latest-state presentation from contract data", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-0000001", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben" }, constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "Everyday Account", entityType: "ACCOUNT", entityId: "sgd", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "USD Wallet", entityType: "ACCOUNT", entityId: "usd", resolutionMethod: "EXACT", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan", goalContractId: "goal", goalContractVersion: 1, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-0000001", steps: [{ id: "fx", sequence: 0, dependsOn: [], reversible: false, action: "FX_CONVERT", parameters: { sourceAccountId: "sgd", destinationAccountId: "usd", sourceMoney: { currency: "SGD", minorUnits: "690000" }, targetCurrency: "USD", quoteId: "quote-1" } }, { id: "send", sequence: 1, dependsOn: ["fx"], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "usd", beneficiaryId: "ben", amount: { currency: "USD", minorUnits: "500000" } } }], validity: { requiredQuoteIds: ["quote-1"] }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "USD", minorUnits: "500000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] } });
  const presentation = presentPlan(goal, plan);
  expect(presentation.planSummary).toContain("Latest account state checked");
  expect(presentation.steps[0]).toMatchObject({ title: "SGD 6,900.00 → USD", summary: "Everyday Account → USD Wallet", meta: expect.arrayContaining([{ label: "Quote", value: "quote-1" }]) });
  expect(presentation.steps[1]).toMatchObject({ title: "Send USD 5,000.00", summary: "USD Wallet → NTU" });
});
