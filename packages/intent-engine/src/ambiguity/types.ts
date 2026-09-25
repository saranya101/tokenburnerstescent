import type { IntentDraftV1 } from "@parlance/contracts";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";

export type AmbiguityReasonCode =
  | "AMBIGUOUS_ENTITY"
  | "ENTITY_NOT_FOUND"
  | "MULTIPLE_SEMANTIC_CANDIDATES";

export interface ClarificationOption {
  entityId: string;
  entityType: GroundableEntityType;
  displayName: string;
}

/** Structured clarification data; UI wording can be localized without changing its meaning. */
export interface ClarificationItem {
  reason: AmbiguityReasonCode;
  field: string;
  originalReference: string;
  questionKey: "clarify.entity.ambiguous" | "clarify.entity.candidates" | "clarify.entity.not_found";
  options: readonly ClarificationOption[];
}

export type AmbiguityAnalysisResult =
  | { status: "CLEAR" }
  | { status: "NEEDS_CLARIFICATION"; clarifications: readonly ClarificationItem[] };

export interface IntentAmbiguityAnalysisInput {
  draft: IntentDraftV1;
  groundingResults: readonly EntityGroundingResult[];
}

export interface IntentAmbiguityDetector {
  analyze(input: IntentAmbiguityAnalysisInput): AmbiguityAnalysisResult;
}
