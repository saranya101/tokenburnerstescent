import type { PrismaClient } from "@parlance/db";
import { describe, expect, it, vi } from "vitest";
import { PrismaParlanceRepository } from "./prisma.js";

describe("Prisma repository readiness", () => {
  it.each([
    ["both owners", { goalContractRowId: "goal-row", goalBundleRowId: "bundle-row" }],
    ["no owner", { goalContractRowId: null, goalBundleRowId: null }],
  ])("rejects a FinancialPlan with %s", async (_label, owners) => {
    const repository = new PrismaParlanceRepository({ financialPlan: { findUnique: vi.fn().mockResolvedValue({ ...owners, steps: [] }) } } as unknown as PrismaClient);
    await expect(repository.getPlan("plan-invalid")).rejects.toThrow("FINANCIAL_PLAN_OWNER_INVARIANT_VIOLATION");
  });

  it("reports ready only when an essential application table is queryable", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new PrismaParlanceRepository({ user: { findFirst } } as unknown as PrismaClient);

    await expect(repository.isReady()).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
  });

  it("reports not ready when the application schema is missing", async () => {
    const repository = new PrismaParlanceRepository({
      user: { findFirst: vi.fn().mockRejectedValue(new Error("relation public.User does not exist")) },
    } as unknown as PrismaClient);

    await expect(repository.isReady()).resolves.toBe(false);
  });
});
