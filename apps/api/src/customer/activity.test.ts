import { describe, expect, it, vi } from "vitest";
import { presentCustomerActivity, PrismaCustomerActivityReadService } from "./activity.js";

describe("customer activity projection", () => {
  const occurredAt = new Date("2026-10-03T10:00:00.000Z");

  it("projects settled plan semantics without operator-only fields", () => {
    const transfer = presentCustomerActivity({ occurredAt, step: { id: "transfer", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-john-1", amount: { currency: "USD", minorUnits: "30000" } } } }, new Map([["ben-john-1", "John Tan"]]), new Map());
    const buy = presentCustomerActivity({ occurredAt, step: { id: "buy", sequence: 1, action: "BUY_ASSET", dependsOn: ["transfer"], reversible: false, parameters: { sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "25000" }, quoteId: "asset-quote-aapl-usd-v1", settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "20100" } } }, new Map(), new Map([["asset-aapl", "AAPL"]]));
    expect(transfer).toEqual(expect.objectContaining({ description: "Transfer to John Tan", accountLabel: "USD Account", amount: { currency: "USD", minorUnits: "30000" }, status: "COMPLETED" }));
    expect(buy).toEqual(expect.objectContaining({ description: "Buy 1 AAPL", accountLabel: "USD Account", amount: { currency: "USD", minorUnits: "20100" }, status: "COMPLETED" }));
    expect(JSON.stringify([transfer, buy])).not.toMatch(/idempotency|bankReference|planHash|traceId/u);
  });

  it("does not expose unsupported plan actions", () => {
    expect(presentCustomerActivity({ occurredAt, step: { id: "fx", sequence: 0, action: "FX_CONVERT", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-sgd", destinationAccountId: "acc-usd", from: { currency: "SGD", minorUnits: "100" }, toCurrency: "USD", quoteId: "quote" } } }, new Map(), new Map())).toBeUndefined();
  });

  it("queries only completed runs for the configured user and returns settled steps newest first", async () => {
    const findMany = vi.fn().mockResolvedValue([{ steps: [{ updatedAt: occurredAt, planStep: { stepKey: "transfer", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-usd", beneficiaryId: "ben-john-1", amount: { currency: "USD", minorUnits: "30000" } } } }] }]);
    const db = { executionRun: { findMany }, beneficiary: { findMany: vi.fn().mockResolvedValue([{ id: "ben-john-1", providerRef: "ben-john-1", name: "John Tan" }]) }, asset: { findMany: vi.fn().mockResolvedValue([]) } };
    const result = await new PrismaCustomerActivityReadService(db as never).list("configured-user");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "configured-user", status: "COMPLETED" }, take: 10 }));
    expect(result.items).toEqual([expect.objectContaining({ description: "Transfer to John Tan", amount: { currency: "USD", minorUnits: "30000" } })]);
  });
});
