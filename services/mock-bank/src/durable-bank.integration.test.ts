import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@parlance/db";
import { buildApp } from "./app.js";
import { PrismaDurableBank, durableBankEnabled } from "./durable-bank.js";

const url = process.env.PARLANCE_DURABLE_DB_TEST_URL;
const local = (() => {
  if (!url) return false;
  try { const parsed = new URL(url); return ["localhost", "127.0.0.1"].includes(parsed.hostname) && /^\/parlance_test_[a-z0-9_]+$/u.test(parsed.pathname); }
  catch { return false; }
})();
const userId = "durable-test-customer";
const headers = { "x-parlance-bank-token": "durable-test-bank-token" };

describe.runIf(local)("durable synthetic bank against disposable local PostgreSQL", () => {
  const db = new PrismaClient({ datasourceUrl: url! });
  const app = () => buildApp({ bankApiToken: "durable-test-bank-token", durableBank: new PrismaDurableBank(db) });
  const state = async (bank: ReturnType<typeof app>) => {
    const response = await bank.inject({ method: "GET", url: `/v1/state/${userId}`, headers });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const transfer = (bank: ReturnType<typeof app>, key: string, version: number, amount = "1000") => bank.inject({
    method: "POST", url: "/v1/execute/transfer",
    headers: { ...headers, "idempotency-key": key, "x-expected-bank-state-version": String(version) },
    payload: { userId, sourceAccountId: "acc-sgd", beneficiaryId: "ben-john-lim", amount: { currency: "SGD", minorUnits: amount } },
  });

  beforeAll(async () => {
    await db.user.create({ data: { id: userId } });
    await db.account.createMany({ data: [
      { id: "acc-sgd", providerRef: "acc-sgd", userId, type: "CHECKING", currency: "SGD", ledgerMinorUnits: 2_000_000n, availableMinorUnits: 2_000_000n, status: "ACTIVE", capabilities: ["SEND_TRANSFER", "CONVERT_FX", "TRADE_ASSET"], stateVersion: 7 },
      { id: "acc-usd", providerRef: "acc-usd", userId, type: "CHECKING", currency: "USD", ledgerMinorUnits: 500_000n, availableMinorUnits: 500_000n, status: "ACTIVE", capabilities: ["SEND_TRANSFER", "CONVERT_FX", "TRADE_ASSET"], stateVersion: 7 },
    ] });
    await db.beneficiary.create({ data: { id: "ben-john-lim", userId, name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" } });
    await db.asset.create({ data: { id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" } });
    await db.holding.create({ data: { userId, assetId: "asset-aapl", quantity: "2", stateVersion: 7 } });
  });
  afterAll(async () => { await db.$disconnect(); });

  it("requires a matching approved local target before durable mode can start", () => {
    expect(() => durableBankEnabled({ PARLANCE_BANK_DURABLE_EXECUTION: "true", DATABASE_URL: url })).toThrow("DURABLE_BANK_TARGET_NOT_APPROVED");
    expect(durableBankEnabled({ PARLANCE_BANK_DURABLE_EXECUTION: "true", PARLANCE_ISOLATED_SYNTHETIC_EXECUTION_APPROVED: "true", PARLANCE_LOCAL_TEST_MODE: "true", NODE_ENV: "test", DATABASE_URL: url, DIRECT_URL: url })).toBe(true);
  });

  it("persists one transfer and its idempotency result across app restart", async () => {
    const first = app();
    const before = await state(first);
    expect(before.stateVersion).toBe(7);
    const accepted = await transfer(first, "durable-transfer-1", 7);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().stateVersion).toBe(8);
    await first.close();
    const restarted = app();
    const repeated = await transfer(restarted, "durable-transfer-1", 7);
    expect(repeated.json()).toEqual(accepted.json());
    const lookup = await restarted.inject({ method: "GET", url: "/v1/executions/idempotency/durable-transfer-1", headers });
    expect(lookup.json()).toMatchObject({ status: "COMPLETED", idempotencyKey: "durable-transfer-1", stateVersion: 8 });
    expect((await state(restarted)).accounts[0].availableMinorUnits).toBe("1999000");
    expect((await transfer(restarted, "durable-transfer-1", 8, "2000")).json()).toEqual({ code: "IDEMPOTENCY_KEY_REUSED" });
    await restarted.close();
  });

  it("serializes concurrent transfers so one stale balance snapshot fails", async () => {
    const bank = app();
    const [left, right] = await Promise.all([transfer(bank, "durable-concurrent-a", 8, "1000"), transfer(bank, "durable-concurrent-b", 8, "1000")]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    expect((await state(bank)).accounts[0].availableMinorUnits).toBe("1998000");
    await bank.close();
  });

  it("rejects stale versions, zero amounts and cross-customer reads without a write", async () => {
    const bank = app();
    const before = await state(bank);
    expect((await transfer(bank, "durable-stale", 7)).json()).toEqual({ code: "BALANCE_CHANGED" });
    expect((await transfer(bank, "durable-zero", before.stateVersion, "0")).json()).toEqual({ code: "AMOUNT_MUST_BE_POSITIVE" });
    expect((await bank.inject({ method: "GET", url: "/v1/state/other-customer", headers })).statusCode).toBe(404);
    expect((await state(bank)).accounts).toEqual(before.accounts);
    await bank.close();
  });

  it("retains exact unexpired quotes through transfer, FX and AAPL purchase", async () => {
    const bank = app();
    const before = await state(bank);
    const assetQuote = before.assetQuotes[0];
    const issued = await bank.inject({ method: "POST", url: "/v1/fx/quote", headers,
      payload: { userId, fromCurrency: "SGD", toCurrency: "USD", amount: { currency: "SGD", minorUnits: "10000" } } });
    expect(issued.statusCode).toBe(200);
    const transferResult = await transfer(bank, "durable-sequence-transfer", before.stateVersion);
    expect(transferResult.statusCode).toBe(200);
    const fxResult = await bank.inject({ method: "POST", url: "/v1/execute/fx",
      headers: { ...headers, "idempotency-key": "durable-sequence-fx", "x-expected-bank-state-version": String(before.stateVersion + 1) },
      payload: { userId, accountId: "acc-sgd", fromAmount: { currency: "SGD", minorUnits: "10000" }, toCurrency: "USD", quoteId: issued.json().id } });
    expect(fxResult.statusCode).toBe(200);
    const buyResult = await bank.inject({ method: "POST", url: "/v1/execute/buy",
      headers: { ...headers, "idempotency-key": "durable-sequence-buy", "x-expected-bank-state-version": String(before.stateVersion + 2) },
      payload: { userId, sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1",
        maximumSpend: { currency: "USD", minorUnits: "20100" }, quoteId: assetQuote.quoteId,
        settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } });
    expect(buyResult.statusCode).toBe(200);
    const after = await state(bank);
    expect(after.stateVersion).toBe(before.stateVersion + 3);
    expect(after.accounts.find((item: { currency: string }) => item.currency === "SGD").availableMinorUnits).toBe("1987000");
    expect(after.accounts.find((item: { currency: string }) => item.currency === "USD").availableMinorUnits).toBe("487400");
    expect(after.holdings).toEqual([{ assetId: "asset-aapl", quantity: "3" }]);
    expect((await bank.inject({ method: "GET", url: "/v1/executions/idempotency/durable-sequence-buy", headers })).json()).toMatchObject({ status: "COMPLETED", bankReference: "mock-durable-sequence-buy" });
    await bank.close();
  });

  it("reconciles a lost response after a committed bank transfer without repeating its effect", async () => {
    const interrupted = buildApp({ bankApiToken: "durable-test-bank-token", durableBank: new PrismaDurableBank(db),
      afterWrite: () => { throw new Error("SIMULATED_RESPONSE_LOSS_AFTER_COMMIT"); } });
    const before = await state(interrupted);
    const response = await transfer(interrupted, "durable-lost-response", before.stateVersion);
    expect(response.statusCode).toBe(500);
    await interrupted.close();
    const recovered = app();
    const lookup = await recovered.inject({ method: "GET", url: "/v1/executions/idempotency/durable-lost-response", headers });
    expect(lookup.json()).toMatchObject({ status: "COMPLETED", stateVersion: before.stateVersion + 1 });
    expect((await transfer(recovered, "durable-lost-response", before.stateVersion)).statusCode).toBe(200);
    const after = await state(recovered);
    expect(BigInt(before.accounts[0].availableMinorUnits) - BigInt(after.accounts[0].availableMinorUnits)).toBe(1_000n);
    expect(after.stateVersion).toBe(before.stateVersion + 1);
    await recovered.close();
  });

  it("rolls back account and operation rows when persistence fails before commit", async () => {
    const interrupted = buildApp({ bankApiToken: "durable-test-bank-token", durableBank: new PrismaDurableBank(db, () => new Date(),
      () => { throw new Error("SIMULATED_PERSISTENCE_INTERRUPTION"); }) });
    const before = await state(interrupted);
    expect((await transfer(interrupted, "durable-rolled-back", before.stateVersion)).statusCode).toBe(500);
    await interrupted.close();
    const recovered = app();
    expect((await state(recovered)).accounts).toEqual(before.accounts);
    expect((await recovered.inject({ method: "GET", url: "/v1/executions/idempotency/durable-rolled-back", headers })).json()).toEqual({ status: "NOT_FOUND", idempotencyKey: "durable-rolled-back" });
    await recovered.close();
  });

  it("allows only one concurrent AAPL purchase against a reviewed state version", async () => {
    const bank = app();
    const before = await state(bank);
    const quote = before.assetQuotes[0];
    const buy = (key: string) => bank.inject({ method: "POST", url: "/v1/execute/buy",
      headers: { ...headers, "idempotency-key": key, "x-expected-bank-state-version": String(before.stateVersion) },
      payload: { userId, sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1",
        maximumSpend: { currency: "USD", minorUnits: "20100" }, quoteId: quote.quoteId,
        settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } });
    const results = await Promise.all([buy("durable-concurrent-buy-a"), buy("durable-concurrent-buy-b")]);
    expect(results.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const after = await state(bank);
    expect(after.stateVersion).toBe(before.stateVersion + 1);
    expect(BigInt(before.accounts[1].availableMinorUnits) - BigInt(after.accounts[1].availableMinorUnits)).toBe(20_100n);
    expect(after.holdings).toEqual([{ assetId: "asset-aapl", quantity: "4" }]);
    await bank.close();
  });
});
