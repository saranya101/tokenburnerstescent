import { describe, expect, it } from "vitest";
import { buildApp, resolveInitialStateConfiguration } from "./app.js";

const quote = { quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" };
const adminAuthorization = { demoMode: true, opsToken: "test-ops-token", demoUserId: "buyer" };
const adminHeaders = { "x-parlance-ops-token": "test-ops-token" };
const bankHeaders = { "x-parlance-bank-token": "test-bank-token" };
const bankApp = (options: Parameters<typeof buildApp>[0] = {}) => buildApp({ ...options, bankApiToken: "test-bank-token" });
const demoBank = () => bankApp({ adminAuthorization });
const validBuy = {
  userId: "buyer", sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "2", maximumSpend: { currency: "USD", minorUnits: "50000" },
  quoteId: quote.quoteId, settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "40100",
};
const buy = (app: ReturnType<typeof buildApp>, payload = validBuy, key = "buy-key") => app.inject({ method: "POST", url: "/v1/execute/buy", headers: { ...bankHeaders, "idempotency-key": key }, payload });
const bankState = async (app: ReturnType<typeof buildApp>, userId = "buyer") => (await app.inject({ method: "GET", url: `/v1/state/${userId}`, headers: bankHeaders })).json();
const executeFx = (app: ReturnType<typeof buildApp>, quoteId: string, fromAmount = { currency: "SGD", minorUnits: "26800" }, key = "fx-key") => app.inject({
  method: "POST", url: "/v1/execute/fx", headers: { ...bankHeaders, "idempotency-key": key },
  payload: { userId: "buyer", accountId: "acc-sgd", fromAmount, toCurrency: "USD", quoteId },
});
const replaceQuotes = (app: ReturnType<typeof buildApp>, assetQuotes: unknown[]) => app.inject({ method: "PUT", url: "/v1/admin/asset-quotes/buyer", headers: adminHeaders, payload: { assetQuotes } });

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
  it("uses the legacy initial version unless an explicit local-test override is supplied", async () => {
    expect(resolveInitialStateConfiguration({})).toEqual({ stateVersion: 7, balances: { "acc-sgd": 2_000_000n, "acc-usd": 500_000n }, holdings: {} });
    const app = bankApp({ initialState: { stateVersion: 10, balances: { "acc-sgd": 1_733_334n, "acc-usd": 0n }, holdings: { "asset-aapl": "1" } } });
    expect(await bankState(app)).toMatchObject({ stateVersion: 10, accounts: [{ id: "acc-sgd", availableMinorUnits: "1733334" }, { id: "acc-usd", availableMinorUnits: "0" }], holdings: [{ assetId: "asset-aapl", quantity: "1" }] });
  });
  it("rejects invalid or non-local initial-version overrides", () => {
    expect(() => resolveInitialStateConfiguration({ PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10" })).toThrow("MOCK_BANK_INITIAL_STATE_VERSION_OVERRIDE_FORBIDDEN");
    expect(() => resolveInitialStateConfiguration({ NODE_ENV: "production", PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10" })).toThrow("MOCK_BANK_INITIAL_STATE_VERSION_OVERRIDE_FORBIDDEN");
    for (const value of ["0", "-1", "1.5", "not-a-version", "9007199254740992"]) {
      expect(() => resolveInitialStateConfiguration({ PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: value, PARLANCE_MOCK_BANK_INITIAL_BALANCES: "{}" })).toThrow("MOCK_BANK_INITIAL_STATE_VERSION_INVALID");
    }
    expect(() => resolveInitialStateConfiguration({ PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10" })).toThrow("MOCK_BANK_INITIAL_BALANCES_REQUIRED");
    expect(() => resolveInitialStateConfiguration({ PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10", PARLANCE_MOCK_BANK_INITIAL_BALANCES: '{"acc-sgd":"1","acc-usd":"1"}' })).toThrow("MOCK_BANK_INITIAL_HOLDINGS_REQUIRED");
    expect(() => resolveInitialStateConfiguration({ PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10", PARLANCE_MOCK_BANK_INITIAL_BALANCES: '{"acc-sgd":"1"}', PARLANCE_MOCK_BANK_INITIAL_HOLDINGS: "{}" })).toThrow("MOCK_BANK_INITIAL_BALANCES_INVALID");
  });
  it("accepts a strictly validated local-test initial-version override", () => {
    expect(resolveInitialStateConfiguration({ PARLANCE_LOCAL_TEST_MODE: "true", PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: "10", PARLANCE_MOCK_BANK_INITIAL_BALANCES: '{"acc-sgd":"1733334","acc-usd":"0"}', PARLANCE_MOCK_BANK_INITIAL_HOLDINGS: '{"asset-aapl":"1"}' })).toEqual({ stateVersion: 10, balances: { "acc-sgd": 1_733_334n, "acc-usd": 0n }, holdings: { "asset-aapl": "1" } });
  });
  it("is healthy", async () => expect((await buildApp().inject({ method: "GET", url: "/health" })).statusCode).toBe(200));
  it("reports not ready when bank credentials are absent or collide with ops", async () => {
    expect((await buildApp().inject({ method: "GET", url: "/ready" })).json()).toEqual({ status: "not_ready" });
    const collision = buildApp({ bankApiToken: "shared", adminAuthorization: { demoMode: true, opsToken: "shared", demoUserId: "buyer" } });
    expect((await collision.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    expect((await collision.inject({ method: "GET", url: "/v1/state/buyer", headers: { "x-parlance-bank-token": "shared" } })).statusCode).toBe(401);
    expect((await collision.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", headers: { "x-parlance-ops-token": "shared" }, payload: { scenarios: [] } })).statusCode).toBe(401);
    const missingDemoAdmin = buildApp({ bankApiToken: "bank", adminAuthorization: { demoMode: true, demoUserId: "buyer" } });
    expect((await missingDemoAdmin.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
  });
  it("returns string minor units", async () => { const response = await bankApp().inject({ method: "GET", url: "/v1/state/u1", headers: bankHeaders }); expect(response.json().accounts[0].availableMinorUnits).toBe("2000000"); });
  it("exposes seeded beneficiaries with their authoritative supported currencies", async () => {
    const response = await bankApp().inject({ method: "GET", url: "/v1/state/u1", headers: bankHeaders });
    expect(response.json().beneficiaries).toEqual([
      { id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" },
      { id: "ben-john-tan", name: "John Tan", supportedCurrencies: ["SGD"], status: "ACTIVE" },
      { id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" },
    ]);
  });
  it("enforces the advertised beneficiary currencies before mutating a transfer", async () => {
    const accepted = bankApp();
    const johnTransfer = await accepted.inject({
      method: "POST",
      url: "/v1/execute/transfer",
      headers: { ...bankHeaders, "idempotency-key": "john-sgd" },
      payload: { userId: "u1", sourceAccountId: "acc-sgd", beneficiaryId: "ben-john-tan", amount: { currency: "SGD", minorUnits: "50000" } },
    });
    expect(johnTransfer.statusCode).toBe(200);
    expect((await bankState(accepted, "u1")).accounts[0].availableMinorUnits).toBe("1950000");

    for (const [idempotencyKey, beneficiaryId, currency, sourceAccountId, code] of [
      ["john-usd", "ben-john-tan", "USD", "acc-usd", "BENEFICIARY_CURRENCY_UNSUPPORTED"],
      ["unknown-beneficiary", "ben-missing", "SGD", "acc-sgd", "BENEFICIARY_NOT_FOUND"],
      ["source-currency", "ben-john-tan", "SGD", "acc-usd", "ACCOUNT_CURRENCY_MISMATCH"],
    ] as const) {
      const app = bankApp();
      const before = await bankState(app, "u1");
      const response = await app.inject({
        method: "POST",
        url: "/v1/execute/transfer",
        headers: { ...bankHeaders, "idempotency-key": idempotencyKey },
        payload: { userId: "u1", sourceAccountId, beneficiaryId, amount: { currency, minorUnits: "50000" } },
      });
      const after = await bankState(app, "u1");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code });
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.accounts).toEqual(before.accounts);
    }
  });
  it("returns the active mock scenarios to an authorized operator in demo mode", async () => { const app = demoBank(); await app.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", headers: adminHeaders, payload: { scenarios: ["ASSET_UNAVAILABLE"] } }); const response = await app.inject({ method: "GET", url: "/v1/admin/scenarios/buyer", headers: adminHeaders }); expect(response.json()).toEqual({ scenarios: ["ASSET_UNAVAILABLE"] }); });
  it("rejects missing, customer, disabled-mode, and out-of-scope mock-bank administration", async () => {
    const enabled = demoBank();
    expect((await enabled.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", payload: { scenarios: [] } })).statusCode).toBe(401);
    expect((await enabled.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", headers: { "x-parlance-internal-token": "customer" }, payload: { scenarios: [] } })).statusCode).toBe(401);
    expect((await enabled.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", headers: bankHeaders, payload: { scenarios: [] } })).statusCode).toBe(401);
    expect((await enabled.inject({ method: "POST", url: "/v1/%61dmin/scenarios/buyer", headers: bankHeaders, payload: { scenarios: ["ASSET_UNAVAILABLE"] } })).statusCode).toBe(401);
    expect((await enabled.inject({ method: "POST", url: "/v1/admin/scenarios/other-user", headers: adminHeaders, payload: { scenarios: [] } })).statusCode).toBe(404);
    const disabled = bankApp({ adminAuthorization: { ...adminAuthorization, demoMode: false } });
    expect((await disabled.inject({ method: "POST", url: "/v1/admin/scenarios/buyer", headers: adminHeaders, payload: { scenarios: [] } })).statusCode).toBe(404);
  });
  it("requires the distinct bank service credential for normal banking APIs", async () => {
    const app = bankApp(); const transfer = { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } };
    for (const headers of [{}, { "x-parlance-internal-token": "customer" }, { authorization: "Bearer human" }, { "x-parlance-bank-token": "wrong" }]) {
      expect((await app.inject({ method: "GET", url: "/v1/state/u1", headers })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/execute/transfer", headers: { ...headers, "idempotency-key": "blocked" }, payload: transfer })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/execute/buy", headers: { ...headers, "idempotency-key": "blocked-buy" }, payload: validBuy })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/v1/executions/idempotency/blocked", headers })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/v1/state/u1", headers: bankHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/service/ready", headers: bankHeaders })).statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "allowed" }, payload: transfer }); expect(write.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/executions/idempotency/allowed", headers: bankHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200); expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });
  it("does not mutate twice for one key", async () => { const app = bankApp(); const request = { method: "POST" as const, url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "same" }, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } }; const a = await app.inject(request); const b = await app.inject(request); expect(a.json().stateVersion).toBe(b.json().stateVersion); const state = await bankState(app, "u1"); expect(state.accounts[1].availableMinorUnits).toBe("499000"); });
  it("rejects a key reused for a different request", async () => { const app = bankApp(); const base = { method: "POST" as const, url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "same" } }; await app.inject({ ...base, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } }); const response = await app.inject({ ...base, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "2000" } } }); expect(response.statusCode).toBe(409); });
  it("looks up a completed write without creating another financial effect", async () => {
    const app = bankApp(); const payload = { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } };
    const write = await app.inject({ method: "POST", url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "lookup-key" }, payload });
    const lookup = await app.inject({ method: "GET", url: "/v1/executions/idempotency/lookup-key", headers: bankHeaders });
    expect(lookup.json()).toMatchObject({ status: "COMPLETED", idempotencyKey: "lookup-key", operation: "transfer", bankReference: write.json().bankReference, stateVersion: write.json().stateVersion });
    expect(lookup.json().requestHash).toMatch(/^[a-f0-9]{64}$/u);
    const state = await bankState(app, "u1"); expect(state.accounts[1].availableMinorUnits).toBe("499000");
  });
  it("retains authoritative evidence when the response is lost after mutation", async () => {
    let effects = 0; const app = bankApp({ afterWrite: () => { effects += 1; throw new Error("simulated lost response"); } });
    const request = { method: "POST" as const, url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "lost-response" }, payload: { userId: "u1", sourceAccountId: "acc-usd", beneficiaryId: "ben-ntu", amount: { currency: "USD", minorUnits: "1000" } } };
    expect((await app.inject(request)).statusCode).toBe(500);
    const lookup = await app.inject({ method: "GET", url: "/v1/executions/idempotency/lost-response", headers: bankHeaders }); expect(lookup.json()).toMatchObject({ status: "COMPLETED", idempotencyKey: "lost-response", operation: "transfer", stateVersion: 8 });
    expect((await app.inject(request)).json()).toMatchObject({ accepted: true, stateVersion: 8 }); expect(effects).toBe(1);
    const state = await bankState(app, "u1"); expect(state.accounts[1].availableMinorUnits).toBe("499000");
  });
  it("reports authoritative absence without mutating state", async () => {
    const app = bankApp(); const before = await bankState(app, "u1");
    expect((await app.inject({ method: "GET", url: "/v1/executions/idempotency/missing", headers: bankHeaders })).json()).toEqual({ status: "NOT_FOUND", idempotencyKey: "missing" });
    expect((await bankState(app, "u1")).accounts).toEqual(before.accounts);
  });

  it("retains the exact approved FX quote across transfer state changes and completes the dependent purchase", async () => {
    const app = bankApp({ initialState: { stateVersion: 7, balances: { "acc-sgd": 200_000n, "acc-usd": 0n }, holdings: { "asset-aapl": "2" } } });
    const initial = await bankState(app);
    const approvedQuote = initial.fxQuotes[0];
    expect(approvedQuote).toMatchObject({ fromCurrency: "SGD", toCurrency: "USD", rate: "0.75" });

    const transfer = await app.inject({
      method: "POST", url: "/v1/execute/transfer", headers: { ...bankHeaders, "idempotency-key": "bundle-transfer" },
      payload: { userId: "buyer", sourceAccountId: "acc-sgd", beneficiaryId: "ben-john-lim", amount: { currency: "SGD", minorUnits: "10000" } },
    });
    expect(transfer.json()).toMatchObject({ accepted: true, stateVersion: 8 });
    expect((await bankState(app)).fxQuotes).toContainEqual(approvedQuote);

    const fx = await executeFx(app, approvedQuote.id, undefined, "bundle-fx");
    expect(fx.json()).toMatchObject({ accepted: true, stateVersion: 9 });
    const purchase = await buy(app, { ...validBuy, quantity: "1", maximumSpend: { currency: "USD", minorUnits: "20100" }, authorizedTotalMinor: "20100" }, "bundle-buy");
    expect(purchase.json()).toMatchObject({ accepted: true, stateVersion: 10 });

    const final = await bankState(app);
    expect(final.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "acc-sgd", availableMinorUnits: "163200" }),
      expect.objectContaining({ id: "acc-usd", availableMinorUnits: "0" }),
    ]));
    expect(final.holdings).toEqual([{ assetId: "asset-aapl", quantity: "3" }]);
  });

  it("removes expired FX quotes from snapshots and rejects their exact IDs without mutation", async () => {
    let clock = new Date("2026-10-13T03:31:00.000Z");
    const app = bankApp({ now: () => clock });
    const before = await bankState(app);
    const expiredId = before.fxQuotes[0].id;
    clock = new Date("2026-10-13T03:32:01.000Z");
    const refreshed = await bankState(app);
    expect(refreshed.fxQuotes.some((item: { id: string }) => item.id === expiredId)).toBe(false);
    const response = await executeFx(app, expiredId, undefined, "expired-fx");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "QUOTE_EXPIRED" });
    const after = await bankState(app);
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.accounts).toEqual(before.accounts);
  });

  it("rejects unknown and amount-altered FX quotes without mutation", async () => {
    const app = bankApp();
    const before = await bankState(app);
    const unknown = await executeFx(app, "unknown-fx-quote", undefined, "unknown-fx");
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toEqual({ code: "FX_QUOTE_NOT_FOUND" });

    const issued = await app.inject({
      method: "POST", url: "/v1/fx/quote", headers: bankHeaders,
      payload: { userId: "buyer", fromCurrency: "SGD", toCurrency: "USD", amount: { currency: "SGD", minorUnits: "26800" } },
    });
    const altered = await executeFx(app, issued.json().id, { currency: "SGD", minorUnits: "26799" }, "altered-fx");
    expect(altered.statusCode).toBe(409);
    expect(altered.json()).toEqual({ code: "FX_QUOTE_AMOUNT_MISMATCH" });
    const after = await bankState(app);
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.accounts).toEqual(before.accounts);
  });

  it("exposes authoritative asset quotes with the bank snapshot", async () => {
    const state = await bankState(bankApp());
    expect(state.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "asset-aapl", tradable: true })]));
    expect(state.assetQuotes).toEqual([quote]);
  });

  it("buys against a valid quote and debits exactly the authorized total", async () => {
    const app = demoBank();
    const response = await buy(app);
    const state = await bankState(app);
    expect(response.statusCode).toBe(200);
    expect(state.accounts.find((account: { id: string }) => account.id === "acc-usd").availableMinorUnits).toBe("459900");
    expect(state.holdings).toEqual([{ assetId: "asset-aapl", quantity: "2" }]);
  });

  it("rejects an unknown quote without mutation", async () => {
    const app = demoBank();
    await expectRejectedWithoutMutation(app, { ...validBuy, quoteId: "missing" }, "ASSET_QUOTE_NOT_FOUND");
  });

  it("rejects an expired quote without mutation", async () => {
    const app = demoBank();
    await replaceQuotes(app, [{ ...quote, expiresAt: "2020-01-01T00:00:00.000Z" }]);
    await expectRejectedWithoutMutation(app, validBuy, "ASSET_QUOTE_EXPIRED");
  });

  it("rejects a changed quoted unit price without mutation", async () => {
    const app = bankApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, quotedUnitPriceMinor: "20001" }, "ASSET_QUOTE_UNIT_PRICE_MISMATCH");
  });

  it("rejects a changed quoted fee without mutation", async () => {
    const app = bankApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, quotedFeeMinor: "101" }, "ASSET_QUOTE_FEE_MISMATCH");
  });

  it("rejects an incorrect authorized total without mutation", async () => {
    const app = bankApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, authorizedTotalMinor: "40000" }, "AUTHORIZED_TOTAL_MISMATCH");
  });

  it("rejects exposure above maximum spend without mutation", async () => {
    const app = bankApp();
    await expectRejectedWithoutMutation(app, { ...validBuy, maximumSpend: { currency: "USD", minorUnits: "40000" } }, "MAXIMUM_SPEND_EXCEEDED");
  });

  it("fails an old BUY binding after the authoritative quote changes", async () => {
    const app = demoBank();
    await replaceQuotes(app, [{ ...quote, unitPriceMinor: "21000" }]);
    await expectRejectedWithoutMutation(app, validBuy, "ASSET_QUOTE_UNIT_PRICE_MISMATCH", "old-plan");
  });

  it("applies the exact same valid idempotent retry only once", async () => {
    const app = bankApp();
    const first = await buy(app, validBuy, "same-buy");
    const second = await buy(app, validBuy, "same-buy");
    const state = await bankState(app);
    expect(first.json()).toEqual(second.json());
    expect(state.accounts.find((account: { id: string }) => account.id === "acc-usd").availableMinorUnits).toBe("459900");
    expect(state.holdings).toEqual([{ assetId: "asset-aapl", quantity: "2" }]);
  });

});
