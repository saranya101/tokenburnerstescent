import { describe, expect, it } from "vitest";
import { GoalContractV1, IntentDraftV1 } from "./index.js";

const money = { currency: "USD", minorUnits: "250000" } as const;
const intent = (goal: Record<string, unknown>) => ({
  schemaVersion: "1", originalText: "Invest in Apple", goal,
  constraints: [], preferences: [], references: [{ reference: "Apple", expectedEntityType: "ASSET" }],
});
const contract = (goal: Record<string, unknown>) => ({
  schemaVersion: "1", id: "goal-apple", userId: "user-1", version: 1, goal,
  constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "USER_CONFIRMED", confirmed: true }],
  status: "CONFIRMED", contractHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createdAt: "2026-09-20T00:00:00Z", confirmedAt: "2026-09-20T00:01:00Z",
});

describe("ACQUIRE_ASSET correction", () => {
  it("accepts budget only", () => {
    expect(IntentDraftV1.safeParse(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: money })).success).toBe(true);
    expect(GoalContractV1.safeParse(contract({ type: "ACQUIRE_ASSET", assetId: "asset-aapl", budget: money })).success).toBe(true);
  });
  it("accepts quantity only", () => {
    expect(IntentDraftV1.safeParse(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "10.5" })).success).toBe(true);
    expect(GoalContractV1.safeParse(contract({ type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "10.5" })).success).toBe(true);
  });
  it("accepts budget and quantity", () => {
    expect(IntentDraftV1.safeParse(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: money, quantity: "10.5" })).success).toBe(true);
    expect(GoalContractV1.safeParse(contract({ type: "ACQUIRE_ASSET", assetId: "asset-aapl", budget: money, quantity: "10.5" })).success).toBe(true);
  });
  it("rejects neither budget nor quantity", () => {
    expect(IntentDraftV1.safeParse(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple" })).success).toBe(false);
    expect(GoalContractV1.safeParse(contract({ type: "ACQUIRE_ASSET", assetId: "asset-aapl" })).success).toBe(false);
  });
});

describe("grounding boundary", () => {
  it("allows human references in IntentDraftV1", () => expect(IntentDraftV1.safeParse(intent({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: money })).success).toBe(true));
  it("requires canonical IDs in GoalContractV1", () => {
    expect(GoalContractV1.safeParse(contract({ type: "DELIVER_MONEY", amount: money, recipientId: "ben-mum" })).success).toBe(true);
    expect(GoalContractV1.safeParse(contract({ type: "DELIVER_MONEY", amount: money, recipientReference: "Mum" })).success).toBe(false);
  });
});
