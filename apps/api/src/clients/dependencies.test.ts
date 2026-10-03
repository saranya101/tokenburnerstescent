import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BankStateSnapshotV1, GoalContractV1 } from "@parlance/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { CompilerClient } from "./compiler.js";
import { MockBankClient } from "./mock-bank.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

afterEach(() => vi.unstubAllGlobals());

describe("dependency clients", () => {
  it("identifies compiler network failures without exposing its URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(new CompilerClient("http://compiler.internal").compile(GoalContractV1.parse(fixture("goal-contract.json")), BankStateSnapshotV1.parse(fixture("bank-state.json")), "trace-compiler")).rejects.toThrow("COMPILER_UNAVAILABLE");
  });

  it("identifies mock-bank network failures without exposing its URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(new MockBankClient("http://bank.internal").getState("user-1", "trace-bank")).rejects.toThrow("MOCK_BANK_UNAVAILABLE");
  });

  it("distinguishes an ambiguous bank write from a definite dependency read failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("response lost")));
    const client = new MockBankClient("http://bank.internal");
    await expect(client.execute("transfer", {}, "same-key", "trace-bank-write")).rejects.toThrow("BANK_RESPONSE_OUTCOME_UNKNOWN");
    await expect(client.lookupByIdempotencyKey("same-key", "trace-bank-lookup")).rejects.toThrow("BANK_LOOKUP_UNAVAILABLE");
  });

  it("treats a bank 5xx after dispatch as outcome-unknown but preserves definite 4xx rejection", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "internal" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "INSUFFICIENT_FUNDS" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "FX_UNAVAILABLE" }), { status: 503 }));
    vi.stubGlobal("fetch", request); const client = new MockBankClient("http://bank.internal");
    await expect(client.execute("transfer", {}, "same-key", "trace-500")).rejects.toThrow("BANK_RESPONSE_OUTCOME_UNKNOWN");
    await expect(client.execute("transfer", {}, "other-key", "trace-409")).rejects.toThrow("INSUFFICIENT_FUNDS");
    await expect(client.execute("fx", {}, "fx-key", "trace-503")).rejects.toThrow("FX_UNAVAILABLE");
  });

  it("preserves an explicit compiler URL and omits a null optional validity timestamp", async () => {
    const result = fixture("compiler-result.json") as { plan: { validity: { validUntil?: string | null } } }; result.plan.validity.validUntil = null;
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", request);
    const parsed = await new CompilerClient("http://configured-compiler:9000").compile(GoalContractV1.parse(fixture("goal-contract.json")), BankStateSnapshotV1.parse(fixture("bank-state.json")), "trace-config");
    expect(parsed.status).toBe("SAT"); if (parsed.status !== "SAT") throw new Error("Expected SAT"); expect(parsed.plan.validity).not.toHaveProperty("validUntil");
    expect(request).toHaveBeenCalledWith("http://configured-compiler:9000/v1/compile", expect.anything());
  });

  it("does not repair another malformed compiler field", async () => {
    const result = fixture("compiler-result.json") as { plan: { goalContractVersion: unknown } }; result.plan.goalContractVersion = "invalid";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new CompilerClient("http://compiler.internal").compile(GoalContractV1.parse(fixture("goal-contract.json")), BankStateSnapshotV1.parse(fixture("bank-state.json")), "trace-invalid")).rejects.toBeInstanceOf(ZodError);
  });
});
