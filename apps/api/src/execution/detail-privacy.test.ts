import { expect, it, vi } from "vitest";
import { ExecutionService } from "../orchestration/services.js";
import type { ParlanceRepository } from "../orchestration/ports.js";

it("returns only customer recovery data while retaining trace and audit for ops detail", async () => {
  const listAudit = vi.fn().mockResolvedValue([{ aggregateId: "execution-1", traceId: "trace-secret", payload: { internal: true } }]);
  const execution = {
    approvalId: "approval-1", traceId: "trace-secret", executionState: "AUTHORIZED" as const,
    result: { schemaVersion: "1" as const, executionId: "execution-1", planId: "plan-1", status: "PENDING" as const, startedStateVersion: 7, steps: [], goalOutcome: { achieved: false, summary: "Pending." } },
  };
  const repository = { getExecution: vi.fn().mockResolvedValue(execution), getPlan: vi.fn().mockResolvedValue(null), listAudit } as unknown as ParlanceRepository;
  const service = new ExecutionService(repository, {} as never, {} as never);
  const customer = await service.detail("execution-1");
  expect(customer).toEqual({ state: "AUTHORIZED", result: execution.result, goal: undefined, goalBundle: undefined, plan: undefined });
  expect(customer).not.toHaveProperty("traceId"); expect(customer).not.toHaveProperty("audit"); expect(listAudit).not.toHaveBeenCalled();
  const ops = await service.opsDetail("execution-1");
  expect(ops).toMatchObject({ traceId: "trace-secret", audit: [{ aggregateId: "execution-1" }] });
});
