import { BankStateSnapshotV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { formatMoney, presentBundle, presentGoal, presentPlan } from "./customer-presentation";

it("renders exact minor-unit amounts without floating point coercion", () => {
  expect(formatMoney({ currency: "USD", minorUnits: "900719925474099312" })).toBe("USD 9,007,199,254,740,993.12");
  expect(formatMoney({ currency: "JPY", minorUnits: "5000" })).toBe("JPY 5,000");
});

it("derives account, recipient, FX quote, and latest-state presentation from contract data", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-0000001", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "ben" }, constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "Everyday Account", entityType: "ACCOUNT", entityId: "sgd", resolutionMethod: "EXACT", confirmed: true }, { schemaVersion: "1", reference: "USD Wallet", entityType: "ACCOUNT", entityId: "usd", resolutionMethod: "EXACT", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan", goalContractId: "goal", goalContractVersion: 1, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-0000001", steps: [{ id: "fx", sequence: 0, dependsOn: [], reversible: false, action: "FX_CONVERT", parameters: { sourceAccountId: "sgd", destinationAccountId: "usd", sourceMoney: { currency: "SGD", minorUnits: "690000" }, targetCurrency: "USD", quoteId: "quote-1" } }, { id: "send", sequence: 1, dependsOn: ["fx"], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "usd", beneficiaryId: "ben", amount: { currency: "USD", minorUnits: "500000" } } }], validity: { requiredQuoteIds: ["quote-1"], validUntil: "2099-01-01T00:00:00.000Z" }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "USD", minorUnits: "500000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [{ accountId: "sgd", money: { currency: "SGD", minorUnits: "310000" } }, { accountId: "usd", money: { currency: "USD", minorUnits: "17500" } }], warnings: [] } });
  const state = BankStateSnapshotV1.parse({ schemaVersion: "1", userId: "user", stateVersion: 7, capturedAt: "2026-09-28T00:00:00.000Z", accounts: [{ id: "sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "1000000", availableMinorUnits: "1000000", status: "ACTIVE", capabilities: ["CONVERT_FX"] }, { id: "usd", type: "WALLET", currency: "USD", ledgerMinorUnits: "0", availableMinorUnits: "0", status: "ACTIVE", capabilities: ["RECEIVE_TRANSFER", "SEND_TRANSFER"] }], beneficiaries: [], assets: [], holdings: [], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [{ id: "quote-1", fromCurrency: "SGD", toCurrency: "USD", rate: "0.75", fee: { currency: "SGD", minorUnits: "50" }, expiresAt: "2099-01-01T00:00:00.000Z" }], assetQuotes: [] });
  const presentation = presentPlan(goal, plan, state);
  expect(presentation.planSummary).toContain("latest account information");
  expect(presentation.planTitle).toBe("Review payment details");
  expect(presentation.funding).toEqual([{ account: "Everyday Account", amount: "SGD 6,900.00", detail: "Rate 1 SGD = 0.75 USD · fee SGD 0.50" }]);
  expect(presentation.steps[0]).toMatchObject({ title: "Convert SGD 6,900.00 to USD", summary: "Everyday Account to USD Wallet" });
  expect(presentation.steps[0]?.meta).not.toEqual(expect.arrayContaining([{ label: "Quote", value: "quote-1" }]));
  expect(presentation.steps[0]?.meta).toEqual(expect.arrayContaining([{ label: "Exchange rate", value: "1 SGD = 0.75 USD" }, { label: "Conversion fee", value: "SGD 0.50" }, { label: "USD proceeds", value: "USD 5,175.00" }]));
  expect(presentation.steps[1]).toMatchObject({ title: "Send USD 5,000.00", summary: "USD Wallet to NTU" });
  expect(presentation.projectedBalances).toEqual([{ account: "Everyday Account", amount: "SGD 3,100.00" }, { account: "USD Wallet", amount: "USD 175.00" }]);
  expect(presentation.validUntil).toBe("2099-01-01T00:00:00.000Z");
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

it("uses the authoritative saved-payee name after an ambiguous reference is confirmed", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal-john", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-john-0001", createdAt: "2026-10-11T00:00:00.000Z", confirmedAt: "2026-10-11T00:01:00.000Z", goal: { type: "DELIVER_MONEY", amount: { currency: "SGD", minorUnits: "50000" }, recipientId: "ben-john-lim" }, constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john-lim", resolutionMethod: "USER_CONFIRMED", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan-john", goalContractId: "goal-john", goalContractVersion: 1, bankStateVersion: 12, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-john-0001", steps: [{ id: "send", sequence: 0, dependsOn: [], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "acc-sgd", beneficiaryId: "ben-john-lim", amount: { currency: "SGD", minorUnits: "50000" } } }], validity: { requiredQuoteIds: [] }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "SGD", minorUnits: "50000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [{ accountId: "acc-sgd", money: { currency: "SGD", minorUnits: "1655201" } }], warnings: [] } });
  const state = BankStateSnapshotV1.parse({ schemaVersion: "1", userId: "user", stateVersion: 12, capturedAt: "2026-10-11T00:00:00.000Z", accounts: [{ id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "1705201", availableMinorUnits: "1705201", status: "ACTIVE", capabilities: ["SEND_TRANSFER"] }], beneficiaries: [{ id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" }], assets: [], holdings: [], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [], assetQuotes: [] });

  const presentation = presentPlan(goal, plan, state);
  expect(presentation.goal).toMatchObject({ title: "Send SGD 500.00 to John Lim", details: expect.arrayContaining([{ label: "To", value: "John Lim" }]) });
  expect(presentation.steps[0]).toMatchObject({ summary: "DBS Multiplier Account to John Lim", meta: expect.arrayContaining([{ label: "To", value: "John Lim" }]) });
});

it("presents the authoritative stock price, fee, total, and funding account", () => {
  const goal = GoalContractV1.parse({ schemaVersion: "1", id: "goal-stock", userId: "user", version: 1, status: "CONFIRMED", contractHash: "goal-hash-stock-1", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: true }] });
  const plan = FinancialPlanV1.parse({ schemaVersion: "1", id: "plan-stock", goalContractId: "goal-stock", goalContractVersion: 1, bankStateVersion: 10, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-stock-1", steps: [{ id: "buy", sequence: 0, dependsOn: [], reversible: false, action: "BUY_ASSET", parameters: { sourceAccountId: "acc-brokerage", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "20100" }, quoteId: "quote-private", settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } }], validity: { requiredQuoteIds: ["quote-private"], validUntil: "2099-01-01T00:00:00.000Z" }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [{ assetId: "asset-aapl", quantity: "1" }], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] } });
  const state = BankStateSnapshotV1.parse({ schemaVersion: "1", userId: "user", stateVersion: 10, capturedAt: "2026-09-28T00:00:00.000Z", accounts: [{ id: "acc-brokerage", type: "BROKERAGE", currency: "USD", ledgerMinorUnits: "500000", availableMinorUnits: "500000", status: "ACTIVE", capabilities: ["TRADE_ASSET"] }], beneficiaries: [], assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }], holdings: [{ assetId: "asset-aapl", quantity: "2.25" }], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [], assetQuotes: [{ quoteId: "quote-private", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" }] });
  const presentation = presentPlan(goal, plan, state);
  expect(presentation.planTitle).toBe("Review your investment");
  expect(presentation.steps[0]).toMatchObject({
    title: "1 Apple",
    summary: "Investment Account → Investment holding",
    meta: [
      { label: "From", value: "Investment Account" },
      { label: "Quantity", value: "1" },
      { label: "Unit price", value: "USD 200.00" },
      { label: "Fee", value: "USD 1.00" },
      { label: "Total", value: "USD 201.00" },
    ],
  });
  expect(presentation.projectedHoldings).toEqual([{ assetId: "asset-aapl", asset: "Apple", quantity: "3.25" }]);
  expect(JSON.stringify(presentation)).not.toContain("quote-private");
});

it("shows confirmed conditional funding and its reserve together in investment meaning review", () => {
  const summary = presentGoal(GoalContractV1.parse({
    schemaVersion: "1", id: "goal-funded-stock", userId: "user", version: 1, status: "CONFIRMED",
    contractHash: "goal-hash-funded-stock", createdAt: "2026-10-10T00:00:00.000Z", confirmedAt: "2026-10-10T00:01:00.000Z",
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" },
    constraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" }, accountId: "acc-sgd" }],
    preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd" }],
    entityBindings: [
      { schemaVersion: "1", reference: "Apple (AAPL)", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "ALIAS", confirmed: true },
      { schemaVersion: "1", reference: "my SGD account", entityType: "ACCOUNT", entityId: "acc-sgd", resolutionMethod: "ALIAS", confirmed: true },
    ],
  }));
  expect(summary).toMatchObject({
    title: "Buy 1 Apple share",
    constraints: ["Keep at least SGD 1,000.00 in DBS Multiplier Account"],
    preferences: ["Use DBS Multiplier Account for the remaining amount"],
  });
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
