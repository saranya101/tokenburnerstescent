import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type ApiServices } from "./app.js";

function services(input: { databaseReady?: boolean; compilerReady?: boolean; mockBankReady?: boolean; compileError?: string } = {}): ApiServices {
  const compile = input.compileError ? async () => { throw new Error(input.compileError); } : async () => ({ status: "UNSAT" });
  return {
    repository: { isReady: async () => input.databaseReady ?? true },
    messages: { receive: async () => ({}), confirm: async () => ({}) }, compilation: { compile }, execution: {}, webauthn: {},
    dependencies: { compiler: { isReady: async () => input.compilerReady ?? true }, bank: { isReady: async () => input.mockBankReady ?? true } },
  } as unknown as ApiServices;
}

afterEach(() => vi.unstubAllEnvs());

describe("API status handling", () => {
  it("exposes health and trace ID", async () => { const app = buildApp(services()); const response = await app.inject({ method: "GET", url: "/health" }); expect(response.statusCode).toBe(200); expect(response.headers["x-trace-id"]).toBeTruthy(); await app.close(); });

  it.each(["COMPILER_UNAVAILABLE", "MOCK_BANK_UNAVAILABLE"])("returns 503 without changing the %s error code", async (code) => {
    const app = buildApp(services({ compileError: code })); const response = await app.inject({ method: "POST", url: "/v1/goals/goal-1/compile" });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ code }); await app.close();
  });

  it.each([
    { compilerReady: false, mockBankReady: true },
    { compilerReady: true, mockBankReady: false },
  ])("returns 503 when a dependency is unavailable", async (readiness) => {
    vi.stubEnv("DATABASE_URL", "configured"); vi.stubEnv("DIRECT_URL", "configured"); vi.stubEnv("COMPILER_URL", "configured"); vi.stubEnv("MOCK_BANK_URL", "configured");
    const app = buildApp(services(readiness)); const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual(expect.objectContaining({ status: "not_ready" })); await app.close();
  });

  it("returns 200 when the database, compiler, and mock bank are ready", async () => {
    vi.stubEnv("DATABASE_URL", "configured"); vi.stubEnv("DIRECT_URL", "configured"); vi.stubEnv("COMPILER_URL", "configured"); vi.stubEnv("MOCK_BANK_URL", "configured");
    const app = buildApp(services()); const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ status: "ready", database: "ready", dependencies: { compiler: "ready", mockBank: "ready" } }); await app.close();
  });

  it("rejects caller-supplied confirmation authority fields before invoking confirmation", async () => {
    const confirm = vi.fn(); const injected = services(); injected.messages = { receive: async () => ({}), confirm } as unknown as ApiServices["messages"];
    const app = buildApp(injected); const response = await app.inject({ method: "POST", url: "/v1/goal-candidates/candidate-1/confirm", payload: { contractHash: "caller", status: "CONFIRMED", confirmedAt: "2026-09-25T00:00:00Z", recipientId: "ben-other" } });
    expect(response.statusCode).toBe(400); expect(confirm).not.toHaveBeenCalled(); await app.close();
  });
});
