import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompileGoalBundleRequestV1,
  GoalBundleContractV1,
  GoalContractV1,
  IntentBundleDraftV1,
  canonicalGoalBundleJson,
  hashGoalBundleContract,
  type GoalBundleContractV1 as GoalBundle,
} from "./index.js";

const transferDraftItem = {
  itemId: "send-ntu",
  goal: { type: "DELIVER_MONEY" as const, amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "NTU" },
  constraints: [],
  preferences: [],
};

const assetDraftItem = {
  itemId: "buy-apple",
  goal: { type: "ACQUIRE_ASSET" as const, assetReference: "Apple", quantity: "2" },
  constraints: [],
  preferences: [],
};

const transferItem = {
  itemId: "send-ntu",
  goal: { type: "DELIVER_MONEY" as const, amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" },
  constraints: [],
  preferences: [],
  bindings: [{ schemaVersion: "1" as const, reference: "NTU", entityType: "BENEFICIARY" as const, entityId: "ben-ntu", resolutionMethod: "EXACT" as const, confirmed: true }],
};

const assetItem = {
  itemId: "buy-apple",
  goal: { type: "ACQUIRE_ASSET" as const, assetId: "asset-aapl", quantity: "2" },
  constraints: [],
  preferences: [],
  bindings: [{ schemaVersion: "1" as const, reference: "Apple", entityType: "ASSET" as const, entityId: "asset-aapl", resolutionMethod: "EXACT" as const, confirmed: true }],
};

const dependency = { beforeItemId: "buy-apple", afterItemId: "send-ntu", reason: "USER_EXPLICIT_ORDER" as const };

function intentBundle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    items: [transferDraftItem, assetDraftItem],
    globalConstraints: [],
    explicitDependencies: [],
    ...overrides,
  };
}

function goalBundle(overrides: Partial<GoalBundle> = {}): GoalBundle {
  return GoalBundleContractV1.parse({
    schemaVersion: "1",
    bundleId: "bundle-1",
    bundleVersion: 1,
    items: [transferItem, assetItem],
    globalConstraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "900000" } }],
    explicitDependencies: [dependency],
    contractHash: "0".repeat(64),
    ...overrides,
  });
}

describe("multi-intent bundle structural validation", () => {
  it("accepts a one-item bundle", () => {
    expect(IntentBundleDraftV1.safeParse(intentBundle({ items: [transferDraftItem] })).success).toBe(true);
    expect(GoalBundleContractV1.safeParse(goalBundle({ items: [transferItem], explicitDependencies: [] })).success).toBe(true);
  });

  it("accepts a two-item bundle while preserving item order without implying a dependency", () => {
    const parsed = IntentBundleDraftV1.parse(intentBundle());
    expect(parsed.items.map(({ itemId }) => itemId)).toEqual(["send-ntu", "buy-apple"]);
    expect(parsed.explicitDependencies).toEqual([]);
    expect(GoalBundleContractV1.safeParse(goalBundle()).success).toBe(true);
  });

  it("rejects an empty bundle", () => {
    expect(IntentBundleDraftV1.safeParse(intentBundle({ items: [] })).success).toBe(false);
    expect(GoalBundleContractV1.safeParse({ ...goalBundle(), items: [], explicitDependencies: [] }).success).toBe(false);
  });

  it("accepts one explicit dependency", () => {
    expect(IntentBundleDraftV1.safeParse(intentBundle({ explicitDependencies: [dependency] })).success).toBe(true);
    expect(GoalBundleContractV1.safeParse(goalBundle()).success).toBe(true);
  });

  const bundles = [
    { label: "intent draft", schema: IntentBundleDraftV1, value: intentBundle() },
    { label: "goal contract", schema: GoalBundleContractV1, value: goalBundle() },
  ] as const;

  it.each(bundles)("rejects duplicate item IDs in $label", ({ schema, value }) => {
    const duplicate = structuredClone(value);
    duplicate.items[1]!.itemId = duplicate.items[0]!.itemId;
    expect(schema.safeParse(duplicate).success).toBe(false);
  });

  it.each(bundles)("rejects missing dependency endpoints in $label", ({ schema, value }) => {
    expect(schema.safeParse({ ...value, explicitDependencies: [{ beforeItemId: value.items[0]!.itemId, afterItemId: "missing-item", reason: "USER_EXPLICIT_ORDER" }] }).success).toBe(false);
  });

  it.each(bundles)("rejects self-dependencies in $label", ({ schema, value }) => {
    expect(schema.safeParse({ ...value, explicitDependencies: [{ beforeItemId: value.items[0]!.itemId, afterItemId: value.items[0]!.itemId, reason: "USER_EXPLICIT_ORDER" }] }).success).toBe(false);
  });

  it.each(bundles)("rejects duplicate dependency edges in $label", ({ schema, value }) => {
    expect(schema.safeParse({ ...value, explicitDependencies: [dependency, dependency] }).success).toBe(false);
  });

  it.each(bundles)("rejects dependency cycles in $label", ({ schema, value }) => {
    expect(schema.safeParse({ ...value, explicitDependencies: [
      dependency,
      { beforeItemId: dependency.afterItemId, afterItemId: dependency.beforeItemId, reason: "USER_EXPLICIT_ORDER" },
    ] }).success).toBe(false);
  });
});

describe("canonical GoalBundleContract semantic hashing", () => {
  const original = goalBundle();
  const addedItem = { ...assetItem, itemId: "buy-more-apple", goal: { ...assetItem.goal, quantity: "1" } };

  it.each([
    ["amount", { items: [{ ...transferItem, goal: { ...transferItem.goal, amount: { currency: "USD", minorUnits: "700001" } } }, assetItem] }],
    ["beneficiary", { items: [{ ...transferItem, goal: { ...transferItem.goal, recipientId: "ben-other" } }, assetItem] }],
    ["binding", { items: [{ ...transferItem, bindings: [{ ...transferItem.bindings[0]!, entityId: "ben-other" }] }, assetItem] }],
    ["asset quantity", { items: [transferItem, { ...assetItem, goal: { ...assetItem.goal, quantity: "3" } }] }],
    ["item added", { items: [transferItem, assetItem, addedItem] }],
    ["item removed", { items: [transferItem], explicitDependencies: [] }],
    ["global constraint", { globalConstraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "900001" } }] }],
    ["explicit dependency", { explicitDependencies: [] }],
    ["item ordering", { items: [assetItem, transferItem] }],
  ] as const)("changes when %s changes", (_label, mutation) => {
    expect(hashGoalBundleContract(goalBundle(mutation as unknown as Partial<GoalBundle>))).not.toBe(hashGoalBundleContract(original));
  });

  it("excludes contractHash itself from the hash", () => {
    expect(hashGoalBundleContract(goalBundle({ contractHash: "f".repeat(64) }))).toBe(hashGoalBundleContract(original));
  });

  it("canonicalizes object keys while keeping array order material", () => {
    expect(canonicalGoalBundleJson(original)).toBe(canonicalGoalBundleJson(JSON.parse(JSON.stringify(original)) as GoalBundle));
    expect(hashGoalBundleContract(goalBundle({ items: [assetItem, transferItem] }))).not.toBe(hashGoalBundleContract(original));
  });
});

it("keeps existing single-goal contracts valid unchanged", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "fixtures/01-ntu-transfer/goal-contract.json"), "utf8"));
  expect(GoalContractV1.safeParse(fixture).success).toBe(true);
});

it("accepts only the grounded bundle and authoritative bank state for compilation", () => {
  const bankState = JSON.parse(readFileSync(join(process.cwd(), "fixtures/01-ntu-transfer/bank-state.json"), "utf8"));
  const request = { goalBundle: goalBundle(), bankState };
  expect(CompileGoalBundleRequestV1.safeParse(request).success).toBe(true);
  expect(CompileGoalBundleRequestV1.safeParse({ ...request, rawText: "not part of the compiler boundary" }).success).toBe(false);
});
