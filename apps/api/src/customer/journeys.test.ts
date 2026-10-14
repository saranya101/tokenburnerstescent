import { describe, expect, it, vi } from "vitest";
import { PrismaCustomerJourneysReadService } from "./journeys.js";

describe("customer journey recovery", () => {
  it("reads only the requested customer's persisted pending request", async () => {
    const updatedAt = new Date("2026-10-14T08:00:00.000Z");
    const draftQuery = vi.fn(async () => [{ id: "candidate-a", status: "AWAITING_GOAL_CONFIRMATION", updatedAt, payload: { kind: "GOAL_CANDIDATE_V1", originalText: "Buy one Apple share" } }]);
    const planQuery = vi.fn(async () => []);
    const repository = { getGoalCandidate: vi.fn(async () => ({ candidate: { goal: { type: "ACQUIRE_ASSET", assetId: "aapl" } } })) };
    const db = { intentDraftRecord: { findMany: draftQuery }, financialPlan: { findMany: planQuery } };
    const service = new PrismaCustomerJourneysReadService(db as never, repository as never);
    const result = await service.list("customer-a");
    expect(draftQuery).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "customer-a" }) }));
    expect(planQuery).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ goalContract: { userId: "customer-a" } }, { goalBundle: { userId: "customer-a" } }] }) }));
    expect(result.items).toMatchObject([{ id: "candidate-a", request: "Buy one Apple share", flow: { phase: "MEANING", data: { candidateId: "candidate-a", status: "AWAITING_GOAL_CONFIRMATION" } } }]);
  });
});
