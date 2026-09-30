import type { IntentDraftV1 } from "@parlance/contracts";
import { groundingRequirementsForIntent } from "./grounding/requirements.js";
import type { GroundableEntityType } from "./grounding/types.js";

export interface IntentReferenceOccurrence {
  readonly field: string;
  readonly reference: string;
  readonly expectedEntityType?: GroundableEntityType;
}

/**
 * Compatibility view for candidate-confirmation consumers. Grounding requirements remain the
 * single source of truth, so semantic goal/constraint/preference roles are authoritative and a
 * contradictory supplemental references[] entry cannot override or duplicate them.
 */
export function intentReferenceOccurrences(draft: IntentDraftV1): readonly IntentReferenceOccurrence[] {
  return groundingRequirementsForIntent(draft).map(({ field, reference, expectedEntityType }) =>
    expectedEntityType === undefined
      ? { field, reference }
      : { field, reference, expectedEntityType }
  );
}
