import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiServices } from "../app.js";

const authorization = { internalApiToken: "internal-test-token", opsApiToken: "ops-test-token" };
const headersFor = (userId: string) => ({ "x-parlance-internal-token": authorization.internalApiToken, "x-parlance-customer-id": userId });
const executionResult = { schemaVersion: "1", executionId: "execution-alice", planId: "plan-alice", status: "PENDING", startedStateVersion: 7, steps: [], goalOutcome: { achieved: false, summary: "Pending." } };
const credential = {
  id: "credential", rawId: "credential", type: "public-key", clientExtensionResults: {},
  response: { clientDataJSON: "client", authenticatorData: "authenticator", signature: "signature" },
};

function isolatedServices() {
  const compile = vi.fn().mockResolvedValue({ status: "UNSAT" });
  const compileBundle = vi.fn().mockResolvedValue({ status: "UNSAT" });
  const approvalOptions = vi.fn(); const verifyApproval = vi.fn(); const run = vi.fn(); const get = vi.fn(); const detail = vi.fn();
  const owner = (id: string) => id.endsWith("bob") ? "user-bob" : "user-alice";
  const repository = {
    getConfirmedGoal: vi.fn(async (id: string) => ({ rowId: `row-${id}`, contract: { id, userId: owner(id) } })),
    getConfirmedGoalBundle: vi.fn(async (id: string) => ({ rowId: `row-${id}`, userId: owner(id), contract: { bundleId: id } })),
    getPlan: vi.fn(async (id: string) => ({ ownerType: "GOAL", plan: { goalContractId: id.replace("plan-", "goal-") } })),
    getApproval: vi.fn(async (id: string) => ({ approval: { userId: owner(id), financialPlanId: id.replace("approval-", "plan-") } })),
    getExecution: vi.fn(async (id: string) => ({ approvalId: id.replace("execution-", "approval-"), result: { ...executionResult, executionId: id, planId: id.replace("execution-", "plan-") } })),
    getGoalCandidate: vi.fn(async (id: string) => ({ userId: owner(id) })),
    getBundleCandidate: vi.fn(async (id: string) => ({ userId: owner(id) })),
    getClarification: vi.fn(async (id: string) => ({ userId: owner(id) })),
    getBundleClarification: vi.fn(async (id: string) => ({ userId: owner(id) })),
    getWebAuthnChallenge: vi.fn(async (id: string) => ({ userId: owner(id) })),
  };
  const services = {
    repository,
    compilation: { compile }, bundleCompilation: { compile: compileBundle },
    webauthn: { approvalOptions, verifyApproval }, execution: { run, get, detail },
    messages: { answerClarification: vi.fn(), confirm: vi.fn() }, bundles: { answerClarification: vi.fn(), confirm: vi.fn() },
    customerActivity: { list: vi.fn(async (userId: string) => ({ userId, items: [] })) },
    dependencies: { bank: { getState: vi.fn(async (userId: string) => ({ userId })) } },
  } as unknown as ApiServices;
  return { services, compile, compileBundle, approvalOptions, verifyApproval, run, get, detail };
}

describe("customer object isolation", () => {
  it("does not let Bob operate on Alice's opaque IDs", async () => {
    const values = isolatedServices(); const app = buildApp(values.services, authorization); const headers = headersFor("user-bob");
    const requests = [
      { method: "POST" as const, url: "/v1/goals/goal-alice/compile" },
      { method: "POST" as const, url: "/v1/goal-bundles/bundle-alice/compile" },
      { method: "POST" as const, url: "/v1/plans/plan-alice/approval-options", payload: {} },
      { method: "POST" as const, url: "/v1/plans/plan-alice/approval-verify", payload: { challengeId: "challenge-alice", credential } },
      { method: "POST" as const, url: "/v1/executions/execution-alice/run" },
      { method: "GET" as const, url: "/v1/executions/execution-alice" },
      { method: "GET" as const, url: "/v1/executions/execution-alice/detail" },
      { method: "POST" as const, url: "/v1/goal-candidates/candidate-alice/confirm", payload: {} },
      { method: "POST" as const, url: "/v1/goal-bundle-candidates/candidate-alice/confirm", payload: {} },
      { method: "POST" as const, url: "/v1/clarifications/clarification-alice/answer", payload: { answerText: "answer" } },
      { method: "POST" as const, url: "/v1/bundle-clarifications/clarification-alice/answer", payload: { answerText: "answer" } },
    ];
    for (const request of requests) expect((await app.inject({ ...request, headers })).statusCode, request.url).toBe(404);
    expect(values.compile).not.toHaveBeenCalled(); expect(values.compileBundle).not.toHaveBeenCalled();
    expect(values.approvalOptions).not.toHaveBeenCalled(); expect(values.verifyApproval).not.toHaveBeenCalled();
    expect(values.run).not.toHaveBeenCalled(); expect(values.get).not.toHaveBeenCalled(); expect(values.detail).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses the authenticated Bob principal for customer state and activity", async () => {
    const values = isolatedServices(); const app = buildApp(values.services, authorization); const headers = headersFor("user-bob");
    expect((await app.inject({ method: "GET", url: "/v1/customer/state?userId=user-alice", headers })).json()).toEqual({ userId: "user-bob" });
    expect((await app.inject({ method: "GET", url: "/v1/customer/activity?userId=user-alice", headers })).json()).toEqual({ userId: "user-bob", items: [] });
    await app.close();
  });

  it("allows a valid internal credential to act only on Bob's owned goal", async () => {
    const values = isolatedServices(); values.get.mockResolvedValue({ result: executionResult }); const app = buildApp(values.services, authorization);
    const response = await app.inject({ method: "POST", url: "/v1/goals/goal-bob/compile", headers: headersFor("user-bob") });
    expect(response.statusCode).toBe(200); expect(values.compile).toHaveBeenCalledWith("goal-bob", expect.any(String));
    const execution = await app.inject({ method: "GET", url: "/v1/executions/execution-bob", headers: headersFor("user-bob") });
    expect(execution.statusCode).toBe(200); expect(values.get).toHaveBeenCalledWith("execution-bob");
    await app.close();
  });

  it("fails closed when an execution's approval and plan links do not agree", async () => {
    const values = isolatedServices();
    values.services.repository.getApproval = vi.fn().mockResolvedValue({ approval: { userId: "user-bob", financialPlanId: "plan-alice" } });
    const app = buildApp(values.services, authorization);
    const response = await app.inject({ method: "GET", url: "/v1/executions/execution-bob", headers: headersFor("user-bob") });
    expect(response.statusCode).toBe(404);
    expect(values.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let Bob traverse Alice's bundle-owned plan, approval, and execution chain", async () => {
    const values = isolatedServices();
    values.services.repository.getPlan = vi.fn().mockResolvedValue({ ownerType: "BUNDLE", plan: { goalContractId: "bundle-alice" } });
    values.services.repository.getConfirmedGoalBundle = vi.fn().mockResolvedValue({ userId: "user-alice", contract: { bundleId: "bundle-alice" } });
    values.services.repository.getApproval = vi.fn().mockResolvedValue({ approval: { userId: "user-alice", financialPlanId: "plan-alice" } });
    values.services.repository.getExecution = vi.fn().mockResolvedValue({ approvalId: "approval-alice", result: { ...executionResult, executionId: "execution-alice", planId: "plan-alice" } });
    const app = buildApp(values.services, authorization); const headers = headersFor("user-bob");
    const requests = [
      { method: "POST" as const, url: "/v1/plans/plan-alice/approval-options", payload: {} },
      { method: "POST" as const, url: "/v1/plans/plan-alice/approval-verify", payload: { challengeId: "challenge-alice", credential } },
      { method: "POST" as const, url: "/v1/executions/execution-alice/run" },
      { method: "GET" as const, url: "/v1/executions/execution-alice" },
      { method: "GET" as const, url: "/v1/executions/execution-alice/detail" },
    ];
    for (const request of requests) expect((await app.inject({ ...request, headers })).statusCode, request.url).toBe(404);
    expect(values.approvalOptions).not.toHaveBeenCalled(); expect(values.verifyApproval).not.toHaveBeenCalled(); expect(values.run).not.toHaveBeenCalled(); expect(values.get).not.toHaveBeenCalled(); expect(values.detail).not.toHaveBeenCalled();
    await app.close();
  });
});
