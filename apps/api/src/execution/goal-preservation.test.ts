import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { BankStateSnapshotV1, FinancialPlanStepV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { describe, expect, it } from "vitest";
import { materiallyEquivalentRoute, simulateFinancialStep, stepPreservesConstraints, terminalStepSatisfiesGoal } from "./goal-preservation.js";
import { bankOperation } from "./gateway.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

describe("goal-preservation primitives", () => {
  it("simulates FX without mutating input and uses integer-safe amount, rate, and fee arithmetic", () => {
    const snapshot = BankStateSnapshotV1.parse(fixture("bank-state.json")); const before = JSON.stringify(snapshot); const step = FinancialPlanV1.parse(fixture("financial-plan.json")).steps[0]!;
    const result = simulateFinancialStep(snapshot, step);
    expect(JSON.stringify(snapshot)).toBe(before); expect(result.outcome).toBe("SAFE_TO_EXECUTE");
    if (result.outcome !== "SAFE_TO_EXECUTE") throw new Error("Expected safe simulation");
    expect(result.snapshot.stateVersion).toBe(snapshot.stateVersion);
    expect(result.snapshot.accounts.find((account) => account.id === "acc-sgd")?.availableMinorUnits).toBe("333233");
    expect(result.snapshot.accounts.find((account) => account.id === "acc-usd")?.availableMinorUnits).toBe("500000");
  });

  it("credits only the explicitly approved FX destination account", () => {
    const base = BankStateSnapshotV1.parse(fixture("bank-state.json"));
    const snapshot = BankStateSnapshotV1.parse({ ...base, accounts: [...base.accounts, { id: "acc-usd-approved", type: "WALLET", currency: "USD", ledgerMinorUnits: "0", availableMinorUnits: "0", status: "ACTIVE", capabilities: ["RECEIVE_TRANSFER"] }] });
    const step = FinancialPlanStepV1.parse({ id: "fx-explicit-destination", sequence: 0, action: "FX_CONVERT", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd-approved", sourceMoney: { currency: "SGD", minorUnits: "100" }, targetCurrency: "USD", quoteId: "quote-sgd-usd-1" } });
    const result = simulateFinancialStep(snapshot, step); expect(result.outcome).toBe("SAFE_TO_EXECUTE"); if (result.outcome !== "SAFE_TO_EXECUTE") throw new Error("Expected safe simulation");
    expect(result.snapshot.accounts.find((account) => account.id === "acc-usd")?.availableMinorUnits).toBe("0");
    expect(result.snapshot.accounts.find((account) => account.id === "acc-usd-approved")?.availableMinorUnits).toBe("75");
  });

  it("preserves route order and compares every executable action parameter", () => {
    const steps = FinancialPlanV1.parse(fixture("financial-plan.json")).steps; const first = steps[0]!;
    if (first.action !== "FX_CONVERT") throw new Error("Expected FX");
    const changed = [{ ...first, parameters: { ...first.parameters, sourceMoney: { currency: "SGD" as const, minorUnits: "666668" } } }, ...steps.slice(1)];
    expect(materiallyEquivalentRoute(steps, [...steps])).toBe(true);
    expect(materiallyEquivalentRoute(steps, [...steps].reverse())).toBe(false);
    expect(materiallyEquivalentRoute(steps, changed)).toBe(false);
  });

  it("treats sequence, dependency order, and reversibility as material", () => {
    const steps = FinancialPlanV1.parse(fixture("financial-plan.json")).steps; const first = steps[0]!; const second = steps[1]!;
    expect(materiallyEquivalentRoute(steps, [{ ...first, sequence: first.sequence + 1 }, second])).toBe(false);
    expect(materiallyEquivalentRoute(steps, [first, { ...second, dependsOn: [...second.dependsOn, "another-step"] }])).toBe(false);
    expect(materiallyEquivalentRoute(steps, [{ ...first, reversible: !first.reversible }, second])).toBe(false);
  });

  it("fails closed for unsupported constraints and MAX_TOTAL_COST", () => {
    const snapshot = BankStateSnapshotV1.parse(fixture("bank-state.json"));
    const transfer = FinancialPlanStepV1.parse({ id: "one", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "60" } } });
    const maxCost = GoalContractV1.parse({ schemaVersion: "1", id: "goal-cost", userId: "user-1", version: 1, goal: { type: "DELIVER_MONEY", recipientId: "ben-ntu", amount: { currency: "USD", minorUnits: "60" } }, constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "100" } }], preferences: [], entityBindings: [], status: "CONFIRMED", contractHash: "0".repeat(64), createdAt: "2026-09-20T00:00:00Z" });
    const unsupported = GoalContractV1.parse({ ...maxCost, id: "goal-lock", constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 1 }] });
    expect(stepPreservesConstraints(maxCost, transfer, snapshot)).toBe(false);
    expect(stepPreservesConstraints(unsupported, transfer, snapshot)).toBe(false);
  });

  it("requires exact acquisition quantity and exact PAY_BILL canonical identity", () => {
    const snapshot = BankStateSnapshotV1.parse(fixture("bank-state.json"));
    const acquire = GoalContractV1.parse({ schemaVersion: "1", id: "goal-quantity", userId: "user-1", version: 1, goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], entityBindings: [], status: "CONFIRMED", contractHash: "0".repeat(64), createdAt: "2026-09-20T00:00:00Z" });
    const buy = FinancialPlanStepV1.parse({ id: "buy", sequence: 0, action: "BUY_ASSET", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1.1", maximumSpend: { currency: "USD", minorUnits: "100" } } });
    expect(terminalStepSatisfiesGoal(acquire, buy, snapshot)).toBe(false);
    const bill = GoalContractV1.parse({ ...acquire, id: "goal-bill", goal: { type: "PAY_BILL", billerId: "biller-electricity", amount: { currency: "USD", minorUnits: "100" } } });
    const payment = FinancialPlanStepV1.parse({ id: "pay", sequence: 0, action: "PAY_BILL", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", obligationId: "biller-water", amount: { currency: "USD", minorUnits: "100" } } });
    expect(terminalStepSatisfiesGoal(bill, payment, snapshot)).toBe(false);
  });

  it("blocks a BUY_ASSET settlement-currency mismatch", () => {
    const base = BankStateSnapshotV1.parse(fixture("bank-state.json"));
    const snapshot = BankStateSnapshotV1.parse({ ...base, accounts: base.accounts.map((account) => account.id === "acc-usd" ? { ...account, capabilities: [...account.capabilities, "TRADE_ASSET"] } : account), assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple", assetType: "EQUITY", tradable: true, settlementCurrency: "SGD" }] });
    const buy = FinancialPlanStepV1.parse({ id: "buy", sequence: 0, action: "BUY_ASSET", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "100" } } });
    expect(simulateFinancialStep(snapshot, buy)).toEqual(expect.objectContaining({ outcome: "POLICY_BLOCKED", reason: "INVESTMENT_ACCOUNT_INELIGIBLE" }));
  });

  it("matches the mock bank FX balance transition", async () => {
    const modulePath = join(process.cwd(), "../../services/mock-bank/src/app.ts"); const { buildApp } = await import(modulePath) as { buildApp(): FastifyInstance }; const app = buildApp();
    const before = BankStateSnapshotV1.parse((await app.inject({ method: "GET", url: "/v1/state/parity-user" })).json()); const quote = before.fxQuotes[0]!;
    const step = FinancialPlanStepV1.parse({ id: "fx-parity", sequence: 0, action: "FX_CONVERT", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd", sourceMoney: { currency: "SGD", minorUnits: "100001" }, targetCurrency: "USD", quoteId: quote.id } });
    const simulated = simulateFinancialStep(before, step); expect(simulated.outcome).toBe("SAFE_TO_EXECUTE"); if (simulated.outcome !== "SAFE_TO_EXECUTE") throw new Error("Expected safe simulation");
    const operation = bankOperation("parity-user", step); const response = await app.inject({ method: "POST", url: `/v1/execute/${operation.path}`, headers: { "idempotency-key": "fx-parity", "content-type": "application/json" }, body: JSON.stringify(operation.payload) }); expect(response.statusCode).toBe(200);
    const actual = BankStateSnapshotV1.parse((await app.inject({ method: "GET", url: "/v1/state/parity-user" })).json());
    const balances = (state: BankStateSnapshotV1) => state.accounts.map(({ id, ledgerMinorUnits, availableMinorUnits }) => ({ id, ledgerMinorUnits, availableMinorUnits }));
    expect(balances(simulated.snapshot)).toEqual(balances(actual)); await app.close();
  });

  it("matches the mock bank additive BUY_ASSET holding transition", async () => {
    const modulePath = join(process.cwd(), "../../services/mock-bank/src/app.ts"); const { buildApp } = await import(modulePath) as { buildApp(): FastifyInstance }; const app = buildApp();
    const userId = "buy-parity-user"; const seed = { userId, sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "2.25", maximumSpend: { currency: "USD", minorUnits: "100" } };
    expect((await app.inject({ method: "POST", url: "/v1/execute/buy", headers: { "idempotency-key": "buy-parity-seed" }, payload: seed })).statusCode).toBe(200);
    const before = BankStateSnapshotV1.parse((await app.inject({ method: "GET", url: `/v1/state/${userId}` })).json());
    const step = FinancialPlanStepV1.parse({ id: "buy-parity", sequence: 0, action: "BUY_ASSET", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "100" } } });
    const simulated = simulateFinancialStep(before, step); expect(simulated.outcome).toBe("SAFE_TO_EXECUTE"); if (simulated.outcome !== "SAFE_TO_EXECUTE") throw new Error("Expected safe simulation");
    expect((await app.inject({ method: "POST", url: "/v1/execute/buy", headers: { "idempotency-key": "buy-parity" }, payload: { userId, ...step.parameters } })).statusCode).toBe(200);
    const actual = BankStateSnapshotV1.parse((await app.inject({ method: "GET", url: `/v1/state/${userId}` })).json());
    expect(simulated.snapshot.holdings.find((holding) => holding.assetId === "asset-aapl")?.quantity).toBe("3.25");
    expect(actual.holdings.find((holding) => holding.assetId === "asset-aapl")?.quantity).toBe("3.25");
    await app.close();
  });
});
