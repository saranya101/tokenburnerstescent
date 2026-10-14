import type { InterpretedIntentDraftV1 } from "@parlance/contracts";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";

export type AmbiguityReasonCode =
  | "AMBIGUOUS_ENTITY"
  | "ENTITY_NOT_FOUND"
  | "MULTIPLE_SEMANTIC_CANDIDATES"
  | "MISSING_FIELD"
  | "INVALID_FIELD";

interface EntityClarificationOption {
  entityId: string;
  entityType: GroundableEntityType;
  displayName: string;
  currency?: string;
  availableMinorUnits?: string;
}

interface CurrencyClarificationOption {
  entityId: string;
  entityType: "CURRENCY";
  displayName: string;
  currency: "SGD" | "USD";
}

export type ClarificationOption = EntityClarificationOption | CurrencyClarificationOption;

/** Structured clarification data; UI wording can be localized without changing its meaning. */
export interface ClarificationItem {
  reason: AmbiguityReasonCode;
  field: string;
  originalReference: string;
  questionKey: "clarify.entity.ambiguous" | "clarify.entity.candidates" | "clarify.entity.not_found"
    | "clarify.transfer.recipient" | "clarify.transfer.amount" | "clarify.transfer.currency";
  options: readonly ClarificationOption[];
}

export type AmbiguityAnalysisResult =
  | { status: "CLEAR" }
  | { status: "NEEDS_CLARIFICATION"; clarifications: readonly ClarificationItem[] };

export interface IntentAmbiguityAnalysisInput {
  draft: InterpretedIntentDraftV1;
  groundingResults: readonly EntityGroundingResult[];
}

export interface IntentAmbiguityDetector {
  analyze(input: IntentAmbiguityAnalysisInput): AmbiguityAnalysisResult;
}
