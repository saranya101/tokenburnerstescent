import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const quote = { quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" };
const validBuy = {
  userId: "buyer", sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "2", maximumSpend: { currency: "USD", minorUnits: "50000" },
  quoteId: quote.quoteId, settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "40100",
};
const buy = (app: ReturnType<typeof buildApp>, payload = validBuy, key = "buy-key") => app.inject({ method: "POST", url: "/v1/execute/buy", headers: { "idempotency-key": key }, payload });
const bankState = async (app: ReturnType<typeof buildApp>, userId = "buyer") => (await app.inject({ method: "GET", url: `/v1/state/${userId}` })).json();
const replaceQuotes = (app: ReturnType<typeof buildApp>, assetQuotes: unknown[]) => app.inject({ method: "PUT", url: "/v1/admin/asset-quotes/buyer", payload: { assetQuotes } });

async function expectRejectedWithoutMutation(app: ReturnType<typeof buildApp>, payload: typeof validBuy, code: string, key = `reject-${code}`) {
  const before = await bankState(app);
  const response = await buy(app, payload, key);
  const after = await bankState(app);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code });
  expect(after.stateVersion).toBe(before.stateVersion);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.holdings).toEqual(before.holdings);
}

describe("mock bank", () => {
  it("is healthy", async () => expect((await buildApp().inject({ method: "GET", url: "/health" })).statusCode).toBe(200));
  it("returns string minor units", async () => { const response = await buildApp().inject({ method: "GET", url: "/v1/state/u1" }); expect(response.json().accounts[0].availableMinorUnits).toBe("2000000"); });
  it("exposes every seeded demo beneficiary as an active USD transfer recipient", async () => {
    const response = await buildApp().inject({ method: "GET", url: "/v1/state/u1" });
    expect(response.json().beneficiaries).toEqual([
      { id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" },
      { id: "ben-john-1", name: "John Tan", supportedCurrencies: ["USD"], status: "ACTIVE" },
      { id: "ben-john-2", name: "John Lim", supportedCurrencies: ["USD"], status: "ACTIVE" },
    ]);
  });
  it("returns the active mock scenarios", async () => { const app = buildApp(); await app.inject({ method: "POST", url: "/v1/admin/scenarios/u1", payload: { scenarios: ["ASSET_UNAVAILABLE"] } }); const response = await app.inject({ method: "GET", url: "/v1/admin/scenarios/u1" }); expect(response.json()).toEqual({ scenarios: ["ASSET_UNAVAILABLE"] }); });
  it("does not mutate twice for one key", async () => { const app = buildApp(); const request = { method: "POST" as const, url: "/v1/execute/transfer", headers: { "idempotency-key": "same" }, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } }; const a = await app.inject(request); const b = await app.inject(request); expect(a.json().stateVersion).toBe(b.json().stateVersion); const state = await app.inject({ method: "GET", url: "/v1/state/u1" }); expect(state.json().accounts[1].availableMinorUnits).toBe("499000"); });
  it("rejects a key reused for a different request", async () => { const app = buildApp(); const base = { method: "POST" as const, url: "/v1/execute/transfer", headers: { "idempotency-key": "same" } }; await app.inject({ ...base, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } }); const response = await app.inject({ ...base, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "2000" } } }); expect(response.statusCode).toBe(409); });
  it("looks up a completed write without creating another financial effect", async () => {
    const app = buildApp(); const payload = { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } };
    const write = await app.inject({ method: "POST", url: "/v1/execute/transfer", headers: { "idempotency-key": "lookup-key" }, payload });
    const lookup = await app.inject({ method: "GET", url: "/v1/executions/idempotency/lookup-key" });
    expect(lookup.json()).toMatchObject({ status: "COMPLETED", idempotencyKey: "lookup-key", operation: "transfer", bankReference: write.json().bankReference, stateVersion: write.json().stateVersion });
    expect(lookup.json().requestHash).toMatch(/^[a-f0-9]{64}$/u);
    const state = await app.inject({ method: "GET", url: "/v1/state/u1" }); expect(state.json().accounts[1].availableMinorUnits).toBe("499000");
  });
  it("retains authoritative evidence when the response is lost after mutation", async () => {
    let effects = 0; const app = buildApp({ afterWrite: () => { effects += 1; throw new Error("simulated lost response"); } });
    const request = { method: "POST" as const, url: "/v1/execute/transfer", headers: { "idempotency-key": "lost-response" }, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } };
    expect((await app.inject(request)).statusCode).toBe(500);
    const lookup = await app.inject({ method: "GET", url: "/v1/executions/idempotency/lost-response" }); expect(lookup.json()).toMatchObject({ status: "COMPLETED", idempotencyKey: "lost-response", operation: "transfer", stateVersion: 8 });
    expect((await app.inject(request)).json()).toMatchObject({ accepted: true, stateVersion: 8 }); expect(effects).toBe(1);
    const state = await app.inject({ method: "GET", url: "/v1/state/u1" }); expect(state.json().accounts[1].availableMinorUnits).toBe("499000");
  });
  it("reports authoritative absence without mutating state", async () => {
    const app = buildApp(); const before = (await app.inject({ method: "GET", url: "/v1/state/u1" })).json();
    expect((await app.inject({ method: "GET", url: "/v1/executions/idempotency/missing" })).json()).toEqual({ status: "NOT_FOUND", idempotencyKey: "missing" });
    expect((await app.inject({ method: "GET", url: "/v1/state/u1" })).json().accounts).toEqual(before.accounts);
  });

  it("exposes authoritative asset quotes with the bank snapshot", async () => {
    const state = await bankState(buildApp());
    expect(state.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "asset-aapl", tradable: true })]));
    expect(state.assetQuotes).toEqual([quote]);
  });

  it("buys against a valid quote and debits exactly the authorized total", async () => {
    const app = buildApp();
    const response = await buy(app);
    const state = await bankState(app);
    expect(response.statusCode).toBe(200);
    expect(state.accounts.find((account: { id: string }) => account.id === "acc-usd").availableMinorUnits).toBe("459900");
    expect(state.holdings).toEqual([{ assetId: "asset-aapl", quantity: "2" }]);
  });

  it("rejects an unknown quote without mutation", async () => {
    const app = buildApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, quoteId: "missing" }, "ASSET_QUOTE_NOT_FOUND");
  });

  it("rejects an expired quote without mutation", async () => {
    const app = buildApp();
    await replaceQuotes(app, [{ ...quote, expiresAt: "2020-01-01T00:00:00.000Z" }]);
    await expectRejectedWithoutMutation(app, validBuy, "ASSET_QUOTE_EXPIRED");
  });

  it("rejects a changed quoted unit price without mutation", async () => {
    const app = buildApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, quotedUnitPriceMinor: "20001" }, "ASSET_QUOTE_UNIT_PRICE_MISMATCH");
  });

  it("rejects a changed quoted fee without mutation", async () => {
    const app = buildApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, quotedFeeMinor: "101" }, "ASSET_QUOTE_FEE_MISMATCH");
  });

  it("rejects an incorrect authorized total without mutation", async () => {
    const app = buildApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, authorizedTotalMinor: "40000" }, "AUTHORIZED_TOTAL_MISMATCH");
  });

  it("rejects exposure above maximum spend without mutation", async () => {
    const app = buildApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, maximumSpend: { currency: "USD", minorUnits: "40000" } }, "MAXIMUM_SPEND_EXCEEDED");
  });

  it("fails an old BUY binding after the authoritative quote changes", async () => {
    const app = buildApp();
    await replaceQuotes(app, [{ ...quote, unitPriceMinor: "21000" }]);
    await expectRejectedWithoutMutation(app, validBuy, "ASSET_QUOTE_UNIT_PRICE_MISMATCH", "old-plan");
  });

  it("applies the exact same valid idempotent retry only once", async () => {
    const app = buildApp();
    const first = await buy(app, validBuy, "same-buy");
    const second = await buy(app, validBuy, "same-buy");
    const state = await bankState(app);
    expect(first.json()).toEqual(second.json());
    expect(state.accounts.find((account: { id: string }) => account.id === "acc-usd").availableMinorUnits).toBe("459900");
    expect(state.holdings).toEqual([{ assetId: "asset-aapl", quantity: "2" }]);
  });

});
