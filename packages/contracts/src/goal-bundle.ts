import { createHash } from "node:crypto";
import { z } from "zod";
import { BankStateSnapshotV1 } from "./bank-state.js";
import { Hash, Id, SchemaVersionV1 } from "./common.js";
import { EntityBinding } from "./entities.js";
import { FinancialPlanV1 } from "./financial-plan.js";
import { ConstraintV1, GroundedGoalV1, PreferenceV1 } from "./goal-contract.js";
import { ConstraintDraftV1, IntentGoalV1, PreferenceDraftV1 } from "./intent.js";

export const IntentDependencyDraftV1 = z.object({
  beforeItemId: Id,
  afterItemId: Id,
  reason: z.literal("USER_EXPLICIT_ORDER"),
}).strict();
export type IntentDependencyDraftV1 = z.infer<typeof IntentDependencyDraftV1>;

export const IntentBundleItemDraftV1 = z.object({
  itemId: Id,
  goal: IntentGoalV1,
  constraints: z.array(ConstraintDraftV1),
  preferences: z.array(PreferenceDraftV1),
}).strict();
export type IntentBundleItemDraftV1 = z.infer<typeof IntentBundleItemDraftV1>;

export const IntentBundleDraftV1 = z.object({
  schemaVersion: SchemaVersionV1,
  items: z.array(IntentBundleItemDraftV1).min(1),
  globalConstraints: z.array(ConstraintDraftV1),
  explicitDependencies: z.array(IntentDependencyDraftV1),
}).strict().superRefine((bundle, context) => validateDependencyGraph(bundle.items, bundle.explicitDependencies, context));
export type IntentBundleDraftV1 = z.infer<typeof IntentBundleDraftV1>;

export const GoalDependencyV1 = z.object({
  beforeItemId: Id,
  afterItemId: Id,
  reason: z.literal("USER_EXPLICIT_ORDER"),
}).strict();
export type GoalDependencyV1 = z.infer<typeof GoalDependencyV1>;

export const GoalBundleItemV1 = z.object({
  itemId: Id,
  goal: GroundedGoalV1,
  constraints: z.array(ConstraintV1),
  preferences: z.array(PreferenceV1),
  bindings: z.array(EntityBinding),
}).strict();
export type GoalBundleItemV1 = z.infer<typeof GoalBundleItemV1>;

export const GoalBundleContractV1 = z.object({
  schemaVersion: SchemaVersionV1,
  bundleId: Id,
  bundleVersion: z.number().int().positive(),
  items: z.array(GoalBundleItemV1).min(1),
  globalConstraints: z.array(ConstraintV1),
  explicitDependencies: z.array(GoalDependencyV1),
  contractHash: Hash,
}).strict().superRefine((bundle, context) => validateDependencyGraph(bundle.items, bundle.explicitDependencies, context));
export type GoalBundleContractV1 = z.infer<typeof GoalBundleContractV1>;

export const CompileGoalBundleRequestV1 = z.object({
  goalBundle: GoalBundleContractV1,
  bankState: BankStateSnapshotV1,
}).strict();
export type CompileGoalBundleRequestV1 = z.infer<typeof CompileGoalBundleRequestV1>;

export const BundleSatisfactionProofV1 = z.object({
  schemaVersion: SchemaVersionV1,
  bundleId: Id,
  bundleContractHash: Hash,
  itemCoverage: z.array(z.object({
    itemId: Id,
    satisfiedByStepIds: z.array(Id),
  }).strict()),
  allItemsSatisfied: z.boolean(),
  allHardConstraintsSatisfied: z.boolean(),
  allExplicitDependenciesSatisfied: z.boolean(),
  allIrreversibleStepsJustified: z.boolean(),
}).strict();
export type BundleSatisfactionProofV1 = z.infer<typeof BundleSatisfactionProofV1>;

export const CompileGoalBundleResultV1 = z.object({
  financialPlan: FinancialPlanV1,
  satisfactionProof: BundleSatisfactionProofV1,
}).strict();
export type CompileGoalBundleResultV1 = z.infer<typeof CompileGoalBundleResultV1>;

export type GoalBundleSemanticPayload = Pick<GoalBundleContractV1,
  "schemaVersion" | "bundleId" | "bundleVersion" | "items" | "globalConstraints" | "explicitDependencies"
>;

export function goalBundleSemanticPayload(bundle: GoalBundleContractV1): GoalBundleSemanticPayload {
  return {
    schemaVersion: bundle.schemaVersion,
    bundleId: bundle.bundleId,
    bundleVersion: bundle.bundleVersion,
    items: bundle.items.map((item) => ({
      ...item,
      bindings: item.bindings.map((binding) => ({
        ...binding,
        ...(binding.confidence === undefined ? {} : { confidence: canonicalDecimal(binding.confidence) }),
      })),
    })),
    globalConstraints: bundle.globalConstraints,
    explicitDependencies: bundle.explicitDependencies,
  };
}

export function canonicalGoalBundleJson(bundle: GoalBundleContractV1): string {
  return JSON.stringify(normalize(goalBundleSemanticPayload(bundle)));
}

export function hashGoalBundleContract(bundle: GoalBundleContractV1): string {
  return createHash("sha256").update(canonicalGoalBundleJson(bundle)).digest("hex");
}

type BundleItem = { readonly itemId: string };
type Dependency = { readonly beforeItemId: string; readonly afterItemId: string };

function validateDependencyGraph(items: readonly BundleItem[], dependencies: readonly Dependency[], context: z.RefinementCtx): void {
  const itemIds = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (itemIds.has(item.itemId)) context.addIssue({ code: "custom", path: ["items", index, "itemId"], message: "Bundle item IDs must be unique" });
    itemIds.add(item.itemId);
  }

  const edges = new Set<string>();
  for (const [index, dependency] of dependencies.entries()) {
    if (!itemIds.has(dependency.beforeItemId)) context.addIssue({ code: "custom", path: ["explicitDependencies", index, "beforeItemId"], message: "Dependency endpoint must reference an existing item" });
    if (!itemIds.has(dependency.afterItemId)) context.addIssue({ code: "custom", path: ["explicitDependencies", index, "afterItemId"], message: "Dependency endpoint must reference an existing item" });
    if (dependency.beforeItemId === dependency.afterItemId) context.addIssue({ code: "custom", path: ["explicitDependencies", index], message: "Self-dependencies are not allowed" });
    const edge = `${dependency.beforeItemId}\u0000${dependency.afterItemId}`;
    if (edges.has(edge)) context.addIssue({ code: "custom", path: ["explicitDependencies", index], message: "Duplicate dependency edges are not allowed" });
    edges.add(edge);
  }

  if (hasCycle(itemIds, dependencies)) context.addIssue({ code: "custom", path: ["explicitDependencies"], message: "Explicit dependency graph must be acyclic" });
}

function hasCycle(itemIds: ReadonlySet<string>, dependencies: readonly Dependency[]): boolean {
  const adjacency = new Map([...itemIds].map((itemId) => [itemId, [] as string[]]));
  for (const dependency of dependencies) {
    if (!itemIds.has(dependency.beforeItemId) || !itemIds.has(dependency.afterItemId) || dependency.beforeItemId === dependency.afterItemId) continue;
    adjacency.get(dependency.beforeItemId)?.push(dependency.afterItemId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): boolean => {
    if (visiting.has(itemId)) return true;
    if (visited.has(itemId)) return false;
    visiting.add(itemId);
    for (const next of adjacency.get(itemId) ?? []) if (visit(next)) return true;
    visiting.delete(itemId);
    visited.add(itemId);
    return false;
  };
  return [...itemIds].some(visit);
}

function canonicalDecimal(value: string): string {
  const [integer = "0", fraction] = value.split(".");
  const trimmedFraction = fraction?.replace(/0+$/, "");
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer === "-0" ? "0" : integer;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
