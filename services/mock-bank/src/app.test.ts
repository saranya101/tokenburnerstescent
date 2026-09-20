import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
describe("mock bank", () => {
  it("is healthy", async () => expect((await buildApp().inject({ method: "GET", url: "/health" })).statusCode).toBe(200));
  it("does not mutate twice for one key", async () => { const app = buildApp(); const request = { method: "POST" as const, url: "/v1/execute/transfer", headers: { "idempotency-key": "same" }, payload: { userId: "u1", amount: 10, currency: "USD" } }; const a = await app.inject(request); const b = await app.inject(request); expect(a.json().stateVersion).toBe(b.json().stateVersion); });
});
