import { describe, expect, it, vi } from "vitest";
import { PrismaCustomerOperationsReadService } from "./operations.js";

describe("customer operation read model", () => {
  it("queries only the authenticated user's executions and returns status evidence", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "run-1", planId: "plan-1", status: "PAUSED", createdAt: new Date("2026-10-14T00:00:00Z"), updatedAt: new Date("2026-10-14T00:01:00Z"), finalStateVersion: null, steps: [{ status: "UNKNOWN", bankReference: null, errorCode: "BANK_LOOKUP_UNAVAILABLE", planStep: { action: "TRANSFER", sequence: 0 } }] }]);
    const service = new PrismaCustomerOperationsReadService({ executionRun: { findMany } } as never);
    const result = await service.list("customer-a");
    expect(findMany.mock.calls[0]?.[0].where).toEqual({ userId: "customer-a" });
    expect(result.items[0]).toMatchObject({ executionId: "run-1", status: "PAUSED", steps: [{ status: "UNKNOWN", errorCode: "BANK_LOOKUP_UNAVAILABLE" }] });
  });
});
