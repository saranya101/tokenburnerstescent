import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
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
});
