import { FinancialPlanV1, GoalBundleContractV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { formatMoney, presentBundle, presentPlan } from "./customer-presentation";

it("renders exact minor-unit amounts without floating point coercion", () => {
  expect(formatMoney({ currency: "USD", minorUnits: "900719925474099312" })).toBe("USD 9,007,199,254,740,993.12");
  expect(formatMoney({ currency: "JPY", minorUnits: "5000" })).toBe("JPY 5,000");
});

it("derives account, recipient, FX quote, and latest-state presentation from contract data", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-0000001", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben" }, constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "Everyday Account", entityType: "ACCOUNT", entityId: "sgd", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "USD Wallet", entityType: "ACCOUNT", entityId: "usd", resolutionMethod: "EXACT", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan", goalContractId: "goal", goalContractVersion: 1, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-0000001", steps: [{ id: "fx", sequence: 0, dependsOn: [], reversible: false, action: "FX_CONVERT", parameters: { sourceAccountId: "sgd", destinationAccountId: "usd", sourceMoney: { currency: "SGD", minorUnits: "690000" }, targetCurrency: "USD", quoteId: "quote-1" } }, { id: "send", sequence: 1, dependsOn: ["fx"], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "usd", beneficiaryId: "ben", amount: { currency: "USD", minorUnits: "500000" } } }], validity: { requiredQuoteIds: ["quote-1"] }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "USD", minorUnits: "500000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] } });
  const presentation = presentPlan(goal, plan);
  expect(presentation.planSummary).toContain("latest account information");
  expect(presentation.planTitle).toBe("Review payment details");
  expect(presentation.funding).toEqual([{ account: "Everyday Account", amount: "SGD 6,900.00", detail: "Converted to USD" }]);
  expect(presentation.steps[0]).toMatchObject({ title: "Convert SGD 6,900.00 to USD", summary: "Everyday Account to USD Wallet" });
  expect(presentation.steps[0]?.meta).not.toEqual(expect.arrayContaining([{ label: "Quote", value: "quote-1" }]));
  expect(presentation.steps[1]).toMatchObject({ title: "Send USD 5,000.00", summary: "USD Wallet to NTU" });
});

it("uses customer account and recipient names instead of raw financial identifiers", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-0000001", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" }, constraints: [], preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd" }], entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan", goalContractId: "goal", goalContractVersion: 1, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-0000001", steps: [{ id: "fx", sequence: 0, dependsOn: [], reversible: false, action: "FX_CONVERT", parameters: { sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd", sourceMoney: { currency: "SGD", minorUnits: "266666" }, targetCurrency: "USD", quoteId: "quote-private" } }, { id: "send", sequence: 1, dependsOn: ["fx"], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "700000" } } }], validity: { requiredQuoteIds: ["quote-private"] }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "USD", minorUnits: "700000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] } });
  const rendered = JSON.stringify(presentPlan(goal, plan));
  expect(rendered).toContain("DBS Multiplier Account");
  expect(rendered).toContain("USD Account");
  expect(rendered).toContain("Nanyang Technological University");
  expect(rendered).not.toMatch(/acc-sgd|acc-usd|ben-ntu|quote-private|FX_CONVERT|TRANSFER/u);
});

it("shows ordering only for an explicit bundle dependency and presents global constraints", () => {
  const base = {
    schemaVersion: "1" as const, bundleId: "bundle-1", bundleVersion: 1, contractHash: "a".repeat(64),
    items: [
      { itemId: "item-1", goal: { type: "DELIVER_MONEY" as const, amount: { currency: "USD", minorUnits: "30000" }, recipientId: "ben-john-tan" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1" as const, reference: "John Tan", entityType: "BENEFICIARY" as const, entityId: "ben-john-tan", resolutionMethod: "USER_CONFIRMED" as const, confirmed: true }] },
      { itemId: "item-2", goal: { type: "ACQUIRE_ASSET" as const, assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1" as const, reference: "Apple", entityType: "ASSET" as const, entityId: "asset-aapl", resolutionMethod: "EXACT" as const, confirmed: true }] },
    ],
    globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE" as const, money: { currency: "SGD", minorUnits: "100000" } }],
  };
  const unordered = GoalBundleContractV1.parse({ ...base, explicitDependencies: [] });
  const ordered = GoalBundleContractV1.parse({ ...base, explicitDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }] });
  expect(presentBundle(unordered)).toMatchObject({ items: [{ ordered: false }, { ordered: false }], constraints: ["Keep at least SGD 1,000.00 available"] });
  expect(presentBundle(ordered)).toMatchObject({ items: [{ text: "Send USD 300.00 to John Tan", ordered: false }, { text: "Buy 1 Apple share", ordered: true }] });
});
