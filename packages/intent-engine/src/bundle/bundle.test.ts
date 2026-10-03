import { IntentBundleDraftV1, type IntentBundleDraftV1 as IntentBundleDraft } from "@parlance/contracts";
import { describe, expect, it, vi } from "vitest";
import { DeterministicIntentBundleAmbiguityDetector } from "./ambiguity.js";
import { groundingRequirementsForIntentBundle } from "./grounding.js";
import { ModelBackedIntentBundleInterpreter, replaceClarifiedIntentBundleItem } from "./interpreter.js";
import type { IntentBundleModelClient } from "./types.js";
import { DeterministicIntentBundleCoverageValidator } from "./validator.js";

const acceptanceText = "Send John USD 300 and then buy one Apple share, but keep at least S$1,000 available.";

function acceptanceBundle(dependencies = true): IntentBundleDraft {
  return IntentBundleDraftV1.parse({
    schemaVersion: "1",
    items: [
      {
        itemId: "item-1",
        goal: { type: "DELIVER_MONEY", recipientReference: "John", amount: { currency: "USD", minorUnits: "30000" } },
        constraints: [], preferences: [],
      },
      {
        itemId: "item-2",
        goal: { type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "1" },
        constraints: [], preferences: [],
      },
    ],
    globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" } }],
    explicitDependencies: dependencies
      ? [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }]
      : [],
  });
}

function modelClient(value: unknown): IntentBundleModelClient {
  return { generateIntentBundle: vi.fn().mockResolvedValue(value) };
}

describe("multi-intent bundle interpretation", () => {
  it("produces the frozen acceptance shape and application-owned stable IDs", async () => {
    const untrusted = {
      ...acceptanceBundle(),
      items: acceptanceBundle().items.map((item, index) => ({ ...item, itemId: `model-${index + 1}` })),
      explicitDependencies: [{ beforeItemId: "model-1", afterItemId: "model-2", reason: "USER_EXPLICIT_ORDER" }],
    };
    const client = modelClient(untrusted);
    const parser = new ModelBackedIntentBundleInterpreter(client);

    const parsed = await parser.interpretUserRequest({ text: acceptanceText, userId: "private-user" });

    expect(parsed).toEqual(acceptanceBundle());
    expect(new DeterministicIntentBundleCoverageValidator().validate({ sourceText: acceptanceText, bundle: parsed })).toEqual({ status: "PASS", mismatches: [] });
    expect(client.generateIntentBundle).toHaveBeenCalledWith(expect.objectContaining({ text: acceptanceText, promptVersion: "intent-bundle-v1" }));
    expect(JSON.stringify(vi.mocked(client.generateIntentBundle).mock.calls[0]?.[0])).not.toContain("private-user");
  });

  it("keeps a plain conjunction as two intents with no ordering edge", async () => {
    const text = "Send John USD 300 and buy Apple";
    const value = acceptanceBundle(false);
    const parsed = await new ModelBackedIntentBundleInterpreter(modelClient({
      ...value,
      globalConstraints: [],
    })).interpretUserRequest({ text, userId: "user" });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(({ goal }) => goal.type)).toEqual(["DELIVER_MONEY", "ACQUIRE_ASSET"]);
    expect(parsed.explicitDependencies).toEqual([]);
    expect(new DeterministicIntentBundleCoverageValidator().validate({ sourceText: text, bundle: parsed })).toEqual({ status: "PASS", mismatches: [] });
  });

  it.each([
    {
      label: "then",
      text: acceptanceText,
      items: acceptanceBundle().items,
      modelDependency: { beforeItemId: "item-2", afterItemId: "item-1", reason: "USER_EXPLICIT_ORDER" as const },
      expectedTypes: ["DELIVER_MONEY", "ACQUIRE_ASSET"],
      expectedDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
      globalConstraints: acceptanceBundle().globalConstraints,
    },
    {
      label: "after",
      text: "Buy one Apple share after sending John USD 300.",
      items: [acceptanceBundle().items[1], acceptanceBundle().items[0]],
      modelDependency: { beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" as const },
      expectedTypes: ["ACQUIRE_ASSET", "DELIVER_MONEY"],
      expectedDependencies: [{ beforeItemId: "item-2", afterItemId: "item-1", reason: "USER_EXPLICIT_ORDER" }],
      globalConstraints: [],
    },
    {
      label: "before",
      text: "Before buying one Apple share, send John USD 300.",
      items: [acceptanceBundle().items[1], acceptanceBundle().items[0]],
      modelDependency: { beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" as const },
      expectedTypes: ["ACQUIRE_ASSET", "DELIVER_MONEY"],
      expectedDependencies: [{ beforeItemId: "item-2", afterItemId: "item-1", reason: "USER_EXPLICIT_ORDER" }],
      globalConstraints: [],
    },
    {
      label: "plain and",
      text: "Send John USD 300 and buy one Apple share.",
      items: acceptanceBundle().items,
      modelDependency: undefined,
      expectedTypes: ["DELIVER_MONEY", "ACQUIRE_ASSET"],
      expectedDependencies: [],
      globalConstraints: [],
    },
  ])("normalizes source-supported $label ordering at the interpretation boundary", async ({ text, items, modelDependency, expectedTypes, expectedDependencies, globalConstraints }) => {
    const candidate = {
      schemaVersion: "1",
      items: items.map((item, index) => ({ ...item, itemId: `model-${index + 1}` })),
      globalConstraints,
      explicitDependencies: modelDependency === undefined ? [] : [{
        ...modelDependency,
        beforeItemId: modelDependency.beforeItemId.replace("item-", "model-"),
        afterItemId: modelDependency.afterItemId.replace("item-", "model-"),
      }],
    };
    const parsed = await new ModelBackedIntentBundleInterpreter(modelClient(candidate)).interpretUserRequest({ text, userId: "user" });

    expect(parsed.items.map(({ goal }) => goal.type)).toEqual(expectedTypes);
    expect(parsed.explicitDependencies).toEqual(expectedDependencies);
    expect(new DeterministicIntentBundleCoverageValidator().validate({ sourceText: text, bundle: parsed })).toEqual({ status: "PASS", mismatches: [] });
  });

  it("replaces only one clarified item without regenerating or dropping the other", () => {
    const original = acceptanceBundle();
    const firstItem = structuredClone(original.items[0]);
    const globalConstraints = structuredClone(original.globalConstraints);
    const dependencies = structuredClone(original.explicitDependencies);

    const clarified = replaceClarifiedIntentBundleItem(original, "item-2", {
      goal: { type: "ACQUIRE_ASSET", assetReference: "Apple Inc.", quantity: "1" },
      constraints: [],
      preferences: [{ type: "MINIMIZE_TOTAL_COST" }],
    });

    expect(clarified.items).toHaveLength(2);
    expect(clarified.items[0]).toEqual(firstItem);
    expect(clarified.items[1]).toEqual({
      itemId: "item-2",
      goal: { type: "ACQUIRE_ASSET", assetReference: "Apple Inc.", quantity: "1" },
      constraints: [], preferences: [{ type: "MINIMIZE_TOTAL_COST" }],
    });
    expect(clarified.globalConstraints).toEqual(globalConstraints);
    expect(clarified.explicitDependencies).toEqual(dependencies);
  });

  it.each([
    {
      text: "Send John USD 300 and buy one Apple share.",
      bundle: IntentBundleDraftV1.parse({ ...acceptanceBundle(false), globalConstraints: [] }),
    },
    {
      text: "Send John USD 300 and then buy one Apple share.",
      bundle: IntentBundleDraftV1.parse({ ...acceptanceBundle(true), globalConstraints: [] }),
    },
    {
      text: "Buy one Apple share after sending John USD 300.",
      bundle: IntentBundleDraftV1.parse({
        ...acceptanceBundle(true),
        items: [acceptanceBundle().items[1], acceptanceBundle().items[0]],
        globalConstraints: [],
      }),
    },
    {
      text: "Before buying one Apple share, send John USD 300.",
      bundle: IntentBundleDraftV1.parse({
        ...acceptanceBundle(true),
        items: [acceptanceBundle().items[1], acceptanceBundle().items[0]],
        globalConstraints: [],
      }),
    },
    { text: acceptanceText, bundle: acceptanceBundle(true) },
  ])("accepts the required dependency and global-constraint semantics for: $text", ({ text, bundle }) => {
    expect(bundle.items.map(({ goal }) => goal.type)).toEqual(
      text.startsWith("Send") ? ["DELIVER_MONEY", "ACQUIRE_ASSET"] : ["ACQUIRE_ASSET", "DELIVER_MONEY"],
    );
    expect(bundle.explicitDependencies).toEqual(
      text.includes(" and buy ")
        ? []
        : [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
    );
    expect(new DeterministicIntentBundleCoverageValidator().validate({ sourceText: text, bundle }))
      .toEqual({ status: "PASS", mismatches: [] });
  });
});

describe("bundle-scoped grounding and ambiguity", () => {
  it("keeps ambiguity independent per item", () => {
    const result = new DeterministicIntentBundleAmbiguityDetector().analyze({
      bundle: acceptanceBundle(),
      itemGroundingResults: [
        {
          itemId: "item-1",
          groundingResults: [{ status: "RESOLVED", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT" }],
        },
        {
          itemId: "item-2",
          groundingResults: [{
            status: "AMBIGUOUS", reference: "Apple", expectedEntityType: "ASSET",
            candidates: [
              { entityType: "ASSET", entityId: "asset-aapl", canonicalName: "Apple Inc." },
              { entityType: "ASSET", entityId: "asset-apple-bond", canonicalName: "Apple Bond" },
            ],
          }],
        },
      ],
      globalGroundingResults: [],
    });

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(result.items[0]).toEqual({ itemId: "item-1", status: "CLEAR" });
    expect(result.items[1]).toMatchObject({
      itemId: "item-2", status: "NEEDS_CLARIFICATION",
      clarifications: [{ field: "items[1].goal.assetReference", originalReference: "Apple" }],
    });
  });

  it("derives item roles and account-bearing global constraints separately", () => {
    const bundle = IntentBundleDraftV1.parse({
      ...acceptanceBundle(),
      globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" }, accountReference: "Reserve" }],
    });
    expect(groundingRequirementsForIntentBundle(bundle)).toEqual([
      expect.objectContaining({ scope: "ITEM", itemId: "item-1", field: "items[0].goal.recipientReference", expectedEntityType: "BENEFICIARY" }),
      expect.objectContaining({ scope: "ITEM", itemId: "item-2", field: "items[1].goal.assetReference", expectedEntityType: "ASSET" }),
      expect.objectContaining({ scope: "GLOBAL", field: "globalConstraints[0].accountReference", expectedEntityType: "ACCOUNT" }),
    ]);
  });

  it("clarifies an ambiguous John without regenerating the Apple sibling", () => {
    const original = IntentBundleDraftV1.parse({ ...acceptanceBundle(false), globalConstraints: [] });
    const appleItem = structuredClone(original.items[1]);
    const ambiguity = new DeterministicIntentBundleAmbiguityDetector().analyze({
      bundle: original,
      itemGroundingResults: [
        {
          itemId: "item-1",
          groundingResults: [{
            status: "AMBIGUOUS", reference: "John", expectedEntityType: "BENEFICIARY",
            candidates: [
              { entityType: "BENEFICIARY", entityId: "ben-john-tan", canonicalName: "John Tan" },
              { entityType: "BENEFICIARY", entityId: "ben-john-lee", canonicalName: "John Lee" },
            ],
          }],
        },
        {
          itemId: "item-2",
          groundingResults: [{ status: "RESOLVED", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT" }],
        },
      ],
      globalGroundingResults: [],
    });

    expect(ambiguity).toMatchObject({
      status: "NEEDS_CLARIFICATION",
      items: [
        { itemId: "item-1", status: "NEEDS_CLARIFICATION", clarifications: [{ field: "items[0].goal.recipientReference" }] },
        { itemId: "item-2", status: "CLEAR" },
      ],
    });

    const clarified = replaceClarifiedIntentBundleItem(original, "item-1", {
      goal: { type: "DELIVER_MONEY", recipientReference: "John Tan", amount: { currency: "USD", minorUnits: "30000" } },
      constraints: [], preferences: [],
    });
    expect(clarified.items[0]?.goal).toMatchObject({ type: "DELIVER_MONEY", recipientReference: "John Tan" });
    expect(clarified.items[1]).toEqual(appleItem);
  });
});

describe("bundle coverage validation", () => {
  it("detects missing and extra intents", () => {
    const validator = new DeterministicIntentBundleCoverageValidator();
    const missing = IntentBundleDraftV1.parse({ ...acceptanceBundle(false), items: [acceptanceBundle(false).items[0]], globalConstraints: [] });
    const extra = acceptanceBundle(false);

    expect(validator.validate({ sourceText: "Send John USD 300 and buy Apple", bundle: missing }).mismatches)
      .toContainEqual(expect.objectContaining({ code: "MISSING_INTENT" }));
    expect(validator.validate({ sourceText: "Send John USD 300", bundle: extra }).mismatches)
      .toContainEqual(expect.objectContaining({ code: "EXTRA_INTENT" }));
  });

  it("requires then-ordering and rejects an edge created from plain and", () => {
    const validator = new DeterministicIntentBundleCoverageValidator();
    const missingEdge = acceptanceBundle(false);
    const inventedEdge = acceptanceBundle(true);

    expect(validator.validate({ sourceText: acceptanceText, bundle: missingEdge }).mismatches)
      .toContainEqual(expect.objectContaining({ code: "MISSING_EXPLICIT_DEPENDENCY", expected: "item-1->item-2" }));
    expect(validator.validate({ sourceText: "Send John USD 300 and buy Apple", bundle: { ...inventedEdge, globalConstraints: [] } }).mismatches)
      .toContainEqual(expect.objectContaining({ code: "DEPENDENCY_NOT_SUPPORTED_BY_SOURCE" }));
  });

  it("recognizes explicit after and before directions", () => {
    const validator = new DeterministicIntentBundleCoverageValidator();
    const afterText = "Buy Apple after sending John USD 300";
    const afterBundle = IntentBundleDraftV1.parse({
      ...acceptanceBundle(), globalConstraints: [],
      items: [acceptanceBundle().items[1], acceptanceBundle().items[0]],
      explicitDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
    });
    const beforeText = "Send John USD 300 before buying Apple";

    expect(validator.validate({ sourceText: afterText, bundle: afterBundle })).toEqual({ status: "PASS", mismatches: [] });
    expect(validator.validate({ sourceText: beforeText, bundle: acceptanceBundle(true) }).mismatches)
      .not.toContainEqual(expect.objectContaining({ code: "DEPENDENCY_NOT_SUPPORTED_BY_SOURCE" }));
  });

  it("requires the unscoped trailing balance rule as a global constraint", () => {
    const withoutGlobal = IntentBundleDraftV1.parse({ ...acceptanceBundle(), globalConstraints: [] });
    expect(new DeterministicIntentBundleCoverageValidator().validate({ sourceText: acceptanceText, bundle: withoutGlobal }).mismatches)
      .toContainEqual(expect.objectContaining({ code: "MISSING_GLOBAL_CONSTRAINT", expected: "MIN_AVAILABLE_BALANCE" }));
  });
});
