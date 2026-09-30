import type { IntentDraftV1 } from "@parlance/contracts";
import { normalizeEntityReference } from "./normalizer.js";
import type { GroundableEntityType } from "./types.js";

export interface IntentGroundingRequirement {
  readonly field: string;
  readonly reference: string;
  readonly expectedEntityType?: GroundableEntityType;
  readonly source: "SEMANTIC_FIELD" | "SUPPLEMENTAL_REFERENCE";
}

/**
 * Derives identity requirements from validated field roles. Supplemental reference metadata is
 * retained only when it does not duplicate any semantic-field reference after B3 normalization.
 */
export function groundingRequirementsForIntent(draft: IntentDraftV1): readonly IntentGroundingRequirement[] {
  const semantic = semanticRequirements(draft);
  const semanticReferences = new Set(semantic.map(({ reference }) => normalizeEntityReference(reference)));
  const supplemental: IntentGroundingRequirement[] = [];
  const seenSupplemental = new Set<string>();

  draft.references.forEach((reference, index) => {
    const normalized = normalizeEntityReference(reference.reference);
    if (semanticReferences.has(normalized)) return;
    const key = `${normalized}\u0000${reference.expectedEntityType ?? ""}`;
    if (seenSupplemental.has(key)) return;
    seenSupplemental.add(key);
    supplemental.push({
      field: `references[${index}].reference`,
      reference: reference.reference,
      ...(reference.expectedEntityType === undefined ? {} : { expectedEntityType: reference.expectedEntityType }),
      source: "SUPPLEMENTAL_REFERENCE",
    });
  });

  return [...semantic, ...supplemental];
}

function semanticRequirements(draft: IntentDraftV1): IntentGroundingRequirement[] {
  const requirements: IntentGroundingRequirement[] = [];
  switch (draft.goal.type) {
    case "DELIVER_MONEY":
      requirements.push(semantic("goal.recipientReference", draft.goal.recipientReference, "BENEFICIARY"));
      break;
    case "ACQUIRE_ASSET":
      requirements.push(semantic("goal.assetReference", draft.goal.assetReference, "ASSET"));
      break;
    case "PAY_BILL":
      requirements.push(semantic("goal.billerReference", draft.goal.billerReference, "BILLER"));
      break;
    case "MOVE_FUNDS":
      if (draft.goal.sourceAccountReference !== undefined) {
        requirements.push(semantic("goal.sourceAccountReference", draft.goal.sourceAccountReference, "ACCOUNT"));
      }
      requirements.push(semantic("goal.destinationAccountReference", draft.goal.destinationAccountReference, "ACCOUNT"));
      break;
  }
  draft.constraints.forEach((constraint, index) => {
    if (constraint.type === "EXCLUDED_ACCOUNT") {
      requirements.push(semantic(`constraints[${index}].accountReference`, constraint.accountReference, "ACCOUNT"));
    }
    if (constraint.type === "MIN_AVAILABLE_BALANCE" && constraint.accountReference !== undefined) {
      requirements.push(semantic(`constraints[${index}].accountReference`, constraint.accountReference, "ACCOUNT"));
    }
  });
  draft.preferences.forEach((preference, index) => {
    if (preference.type === "PREFER_ACCOUNT") {
      requirements.push(semantic(`preferences[${index}].accountReference`, preference.accountReference, "ACCOUNT"));
    }
  });
  return requirements;
}

function semantic(field: string, reference: string, expectedEntityType: GroundableEntityType): IntentGroundingRequirement {
  return { field, reference, expectedEntityType, source: "SEMANTIC_FIELD" };
}
