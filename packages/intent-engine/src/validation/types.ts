export type IntentValidationMismatchCode =
  | "EMPTY_SOURCE_TEXT"
  | "SOURCE_TEXT_MISMATCH"
  | "INVALID_INTENT_DRAFT"
  | "INVALID_GOAL_CANDIDATE"
  | "GOAL_TYPE_MISMATCH"
  | "GOAL_TYPE_NOT_SUPPORTED_BY_SOURCE"
  | "MONEY_MISMATCH"
  | "MONEY_NOT_SUPPORTED_BY_SOURCE"
  | "QUANTITY_MISMATCH"
  | "REFERENCE_NOT_SUPPORTED_BY_SOURCE"
  | "CANONICAL_IDENTIFIER_REFERENCE"
  | "BINDING_MISSING"
  | "BINDING_ENTITY_MISMATCH"
  | "DUPLICATE_BINDING"
  | "UNEXPECTED_BINDING"
  | "CONSTRAINT_COUNT_MISMATCH"
  | "CONSTRAINT_MISMATCH"
  | "CONSTRAINT_NOT_SUPPORTED_BY_SOURCE"
  | "OMITTED_EXPLICIT_CONSTRAINT"
  | "PREFERENCE_COUNT_MISMATCH"
  | "PREFERENCE_MISMATCH"
  | "PREFERENCE_NOT_SUPPORTED_BY_SOURCE"
  | "OMITTED_EXPLICIT_PREFERENCE";

export interface IntentValidationMismatch {
  readonly code: IntentValidationMismatchCode;
  readonly field: string;
  readonly expected?: string;
  readonly observed?: string;
}

export type IndependentIntentValidationResult =
  | { readonly status: "PASS"; readonly mismatches: readonly [] }
  | { readonly status: "FAIL"; readonly mismatches: readonly IntentValidationMismatch[] };

/**
 * Minimum read-only input at the Person B -> Person A boundary. Unknown values are accepted so the
 * validator can fail closed at runtime instead of trusting caller-side TypeScript assertions.
 */
export interface IndependentIntentValidationInput {
  readonly sourceText: string;
  readonly draft: unknown;
  readonly candidate: unknown;
}

export interface IndependentIntentValidator {
  validate(input: IndependentIntentValidationInput): IndependentIntentValidationResult;
}
