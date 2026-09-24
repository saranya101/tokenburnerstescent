import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";
import type { ClarificationItem, ClarificationOption } from "./types.js";

export function clarificationFor(field: string, reference: string, expectedEntityType: GroundableEntityType | undefined, grounding: EntityGroundingResult | undefined): ClarificationItem {
  if (grounding?.status === "AMBIGUOUS") {
    return {
      reason: "AMBIGUOUS_ENTITY", field, originalReference: reference, questionKey: "clarify.entity.ambiguous",
      options: optionsFor(grounding.candidates, expectedEntityType),
    };
  }
  if (grounding?.status === "CANDIDATES") {
    return {
      reason: "MULTIPLE_SEMANTIC_CANDIDATES", field, originalReference: reference, questionKey: "clarify.entity.candidates",
      options: optionsFor(grounding.candidates, expectedEntityType),
    };
  }
  return {
    reason: "ENTITY_NOT_FOUND", field, originalReference: reference, questionKey: "clarify.entity.not_found", options: [],
  };
}

function optionsFor(candidates: readonly { entityId: string; entityType: GroundableEntityType; canonicalName: string }[], expectedEntityType: GroundableEntityType | undefined): readonly ClarificationOption[] {
  const unique = new Map<string, ClarificationOption>();
  for (const candidate of candidates) {
    if (expectedEntityType === undefined || candidate.entityType === expectedEntityType) {
      unique.set(`${candidate.entityType}\u0000${candidate.entityId}`, {
        entityId: candidate.entityId, entityType: candidate.entityType, displayName: candidate.canonicalName,
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
}
