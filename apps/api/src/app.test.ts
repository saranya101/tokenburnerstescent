import { afterEach, describe, expect, it, vi } from "vitest";
import { BankStateSnapshotV1 } from "@parlance/contracts";
import { buildApp, type ApiServices } from "./app.js";

function services(input: { databaseReady?: boolean; compilerReady?: boolean; mockBankReady?: boolean; compileError?: string } = {}): ApiServices {
  const compile = input.compileError ? async () => { throw new Error(input.compileError); } : async () => ({ status: "UNSAT" });
  return {
    repository: { isReady: async () => input.databaseReady ?? true },
    messages: { receive: async () => ({}), answerClarification: async () => ({}), confirm: async () => ({}) }, compilation: { compile }, execution: {}, webauthn: {},
    dependencies: { compiler: { isReady: async () => input.compilerReady ?? true }, bank: { isReady: async () => input.mockBankReady ?? true } },
  } as unknown as ApiServices;
}

afterEach(() => vi.unstubAllEnvs());

describe("API status handling", () => {
  it("returns authoritative customer state only for the configured identity", async () => {
    vi.stubEnv("PARLANCE_CUSTOMER_USER_ID", "configured-user");
    const getState = vi.fn().mockResolvedValue(BankStateSnapshotV1.parse({
      schemaVersion: "1", userId: "configured-user", stateVersion: 7, capturedAt: "2026-10-03T00:00:00Z",
      accounts: [], beneficiaries: [], assets: [], holdings: [], obligations: [],
      serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [], assetQuotes: [],
    }));
    const injected = services(); injected.dependencies.bank = { ...injected.dependencies.bank, getState } as unknown as ApiServices["dependencies"]["bank"];
    const app = buildApp(injected);
    const response = await app.inject({ method: "GET", url: "/v1/customer/state?userId=attacker-selected" });
    expect(response.statusCode).toBe(200); expect(response.json().userId).toBe("configured-user");
    expect(getState).toHaveBeenCalledWith("configured-user", expect.any(String));
    expect(getState).not.toHaveBeenCalledWith("attacker-selected", expect.anything()); await app.close();
  });

  it("fails closed when the customer identity is not configured", async () => {
    vi.stubEnv("PARLANCE_CUSTOMER_USER_ID", ""); const injected = services(); const getState = vi.fn();
    injected.dependencies.bank = { ...injected.dependencies.bank, getState } as unknown as ApiServices["dependencies"]["bank"];
    const app = buildApp(injected); const response = await app.inject({ method: "GET", url: "/v1/customer/state" });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ code: "CUSTOMER_IDENTITY_NOT_CONFIGURED" });
    expect(getState).not.toHaveBeenCalled(); await app.close();
  });

  it("returns bounded customer-safe activity only for the configured identity", async () => {
    vi.stubEnv("PARLANCE_CUSTOMER_USER_ID", "configured-user"); const list = vi.fn().mockResolvedValue({ items: [] });
    const injected = services(); injected.customerActivity = { list };
    const app = buildApp(injected); const response = await app.inject({ method: "GET", url: "/v1/customer/activity?userId=attacker-selected" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ items: [] });
    expect(list).toHaveBeenCalledWith("configured-user"); expect(list).not.toHaveBeenCalledWith("attacker-selected"); await app.close();
  });

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

  it("rejects caller-supplied bundle authority and accepts only server-side confirmation", async () => {
    const confirm = vi.fn().mockResolvedValue({ status: "CONFIRMED" }); const injected = services();
    injected.bundles = { handles: () => true, receive: async () => ({}), answerClarification: async () => ({}), confirm } as unknown as ApiServices["bundles"];
    const app = buildApp(injected);
    const invalid = await app.inject({ method: "POST", url: "/v1/goal-bundle-candidates/candidate-1/confirm", payload: { bundleId: "caller", contractHash: "caller", items: [] } });
    expect(invalid.statusCode).toBe(400); expect(confirm).not.toHaveBeenCalled();
    const valid = await app.inject({ method: "POST", url: "/v1/goal-bundle-candidates/candidate-1/confirm", payload: {} });
    expect(valid.statusCode).toBe(200); expect(confirm).toHaveBeenCalledOnce(); await app.close();
  });

  it("keeps single requests on the legacy path and routes only composite requests to bundle orchestration", async () => {
    const receiveSingle = vi.fn().mockResolvedValue({ path: "single" }); const receiveBundle = vi.fn().mockResolvedValue({ path: "bundle" }); const injected = services();
    injected.messages = { receive: receiveSingle } as unknown as ApiServices["messages"];
    injected.bundles = { handles: (text: string) => text.includes(" and buy "), receive: receiveBundle } as unknown as ApiServices["bundles"];
    const app = buildApp(injected);
    expect((await app.inject({ method: "POST", url: "/v1/messages", payload: { userId: "user-1", text: "Send John USD 350." } })).json()).toEqual({ path: "single" });
    expect((await app.inject({ method: "POST", url: "/v1/messages", payload: { userId: "user-1", text: "Send John USD 300 and buy one Apple share." } })).json()).toEqual({ path: "bundle" });
    expect(receiveSingle).toHaveBeenCalledOnce(); expect(receiveBundle).toHaveBeenCalledOnce(); await app.close();
  });

  it("accepts voice evidence only as provenance on the same message route", async () => {
    const receive = vi.fn().mockResolvedValue({ status: "AWAITING_GOAL_CONFIRMATION" }); const injected = services();
    injected.messages = { receive } as unknown as ApiServices["messages"];
    injected.bundles = { handles: () => false } as unknown as ApiServices["bundles"];
    const app = buildApp(injected); const voice = { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" };
    const valid = await app.inject({ method: "POST", url: "/v1/messages", payload: { userId: "user-1", text: "Send John USD 3000", inputMode: "VOICE", voice } });
    const forged = await app.inject({ method: "POST", url: "/v1/messages", payload: { userId: "user-1", text: "Send John USD 3000", inputMode: "VOICE", voice, edited: false } });
    expect(valid.statusCode).toBe(200); expect(forged.statusCode).toBe(400);
    expect(receive).toHaveBeenCalledOnce(); expect(receive).toHaveBeenCalledWith({ userId: "user-1", text: "Send John USD 3000", inputMode: "VOICE", voice }, expect.any(String));
    await app.close();
  });

  it("accepts only a candidate choice or typed text for clarification continuation", async () => {
    const answerClarification = vi.fn().mockResolvedValue({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-1", clarifications: [] });
    const injected = services(); injected.messages = { receive: async () => ({}), answerClarification, confirm: async () => ({}) } as unknown as ApiServices["messages"];
    const app = buildApp(injected);
    const valid = await app.inject({ method: "POST", url: "/v1/clarifications/clarification-1/answer", payload: { selectedCandidateId: "acc-1" } });
    const invalid = await app.inject({ method: "POST", url: "/v1/clarifications/clarification-1/answer", payload: { selectedCandidateId: "acc-1", entityBinding: { entityId: "acc-1", confirmed: true }, goalContractHash: "caller" } });
    expect(valid.statusCode).toBe(200); expect(answerClarification).toHaveBeenCalledOnce(); expect(invalid.statusCode).toBe(400); await app.close();
  });

  it("exposes the ops projection as read-only", async () => {
    const injected = services(); injected.ops = { listRuns: async () => [] };
    const app = buildApp(injected);
    const read = await app.inject({ method: "GET", url: "/v1/ops/runs" });
    const mutation = await app.inject({ method: "POST", url: "/v1/ops/runs", payload: {} });
    expect(read.statusCode).toBe(200); expect(read.json()).toEqual([]);
    expect(mutation.statusCode).toBe(404);
    await app.close();
  });
});
