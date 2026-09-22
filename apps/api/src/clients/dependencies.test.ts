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
