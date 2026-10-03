import { GoalContractV1, type GoalContractV1 as GoalContract } from "@parlance/contracts";
import { describe, expect, it } from "vitest";
import { canonicalGoalContractJson, canonicalHash, canonicalJson, hashGoalContract } from "./canonical-hash.js";

it("canonicalizes object keys while preserving array order", () => {
  expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
});

function goal(overrides: Partial<GoalContract> = {}): GoalContract {
  return GoalContractV1.parse({
    schemaVersion: "1", id: "goal-1", userId: "user-1", version: 1, sourceIntentDraftId: "intent-1",
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50000" }, recipientId: "ben-john" },
    constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "51000" } }],
    preferences: [{ type: "MINIMIZE_TOTAL_COST" }],
    entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confidence: "1.0", confirmed: true }],
    status: "CONFIRMED", contractHash: "0".repeat(64), createdAt: "2026-09-20T00:00:00Z", confirmedAt: "2026-09-20T00:01:00Z",
    ...overrides,
  });
}

describe("canonical GoalContract semantic hashing", () => {
  it("excludes every lifecycle and audit field", () => {
    const original = goal();
    const changed = goal({ status: "COMPLETED", contractHash: "f".repeat(64), createdAt: "2027-01-01T00:00:00Z", confirmedAt: "2027-01-02T00:00:00Z", sourceIntentDraftId: "intent-2" });
    expect(hashGoalContract(changed)).toBe(hashGoalContract(original));
  });

  it.each([
    ["goal", { goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50001" }, recipientId: "ben-john" } }],
    ["constraint", { constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "52000" } }] }],
    ["preference", { preferences: [{ type: "FASTEST" }] }],
    ["binding canonical ID", { entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-other", resolutionMethod: "EXACT", confidence: "1.0", confirmed: true }] }],
    ["binding confidence", { entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confidence: "0.9", confirmed: true }] }],
  ] as const)("changes when %s semantics change", (_label, mutation) => {
    expect(hashGoalContract(goal(mutation as Partial<GoalContract>))).not.toBe(hashGoalContract(goal()));
  });

  it("normalizes decimal confidence, object ordering, and preserves array ordering", () => {
    expect(hashGoalContract(goal({ entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confidence: "1", confirmed: true }] }))).toBe(hashGoalContract(goal()));
    expect(canonicalGoalContractJson(goal())).toBe(canonicalGoalContractJson(JSON.parse(JSON.stringify(goal())) as GoalContract));
    expect(hashGoalContract(goal({ preferences: [{ type: "MINIMIZE_TOTAL_COST" }, { type: "FASTEST" }] }))).not.toBe(hashGoalContract(goal({ preferences: [{ type: "FASTEST" }, { type: "MINIMIZE_TOTAL_COST" }] })));
  });
});
