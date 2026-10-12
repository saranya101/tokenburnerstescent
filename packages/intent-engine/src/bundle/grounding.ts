import { IntentDraftV1, type IntentBundleDraftV1, type IntentBundleItemDraftV1 } from "@parlance/contracts";
import { groundingRequirementsForIntent } from "../grounding/requirements.js";
import type { IntentGroundingRequirement } from "../grounding/requirements.js";
import type { IntentBundleGroundingRequirement } from "./types.js";

/** Derives item-scoped and global grounding work without merging identity across bundle items. */
export function groundingRequirementsForIntentBundle(bundle: IntentBundleDraftV1): readonly IntentBundleGroundingRequirement[] {
  const requirements: IntentBundleGroundingRequirement[] = [];
  bundle.items.forEach((item, index) => {
    for (const requirement of groundingRequirementsForIntent(intentDraftForBundleItem(item))) {
      requirements.push({
        ...requirement,
        scope: "ITEM",
        itemId: item.itemId,
        field: `items[${index}].${requirement.field}`,
      });
    }
  });
  bundle.globalConstraints.forEach((constraint, index) => {
    const requirement = globalConstraintRequirement(constraint, index);
    if (requirement !== undefined) requirements.push({ ...requirement, scope: "GLOBAL" });
  });
  return requirements;
}

export function intentDraftForBundleItem(item: IntentBundleItemDraftV1): IntentDraftV1 {
  return IntentDraftV1.parse({
    schemaVersion: "1",
    originalText: `bundle:${item.itemId}`,
    goal: item.goal,
    constraints: item.constraints,
    preferences: item.preferences,
    references: [],
  });
}

function globalConstraintRequirement(
  constraint: IntentBundleDraftV1["globalConstraints"][number],
  index: number,
): IntentGroundingRequirement | undefined {
  if (constraint.type === "EXCLUDED_ACCOUNT") {
    return semantic(`globalConstraints[${index}].accountReference`, constraint.accountReference);
  }
  if (constraint.type === "MIN_AVAILABLE_BALANCE" && constraint.accountReference !== undefined) {
    return semantic(`globalConstraints[${index}].accountReference`, constraint.accountReference);
  }
  return undefined;
}

function semantic(field: string, reference: string): IntentGroundingRequirement {
  return { field, reference, expectedEntityType: "ACCOUNT", source: "SEMANTIC_FIELD" };
}
