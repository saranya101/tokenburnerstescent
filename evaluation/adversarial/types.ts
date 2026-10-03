import type {
  ForbiddenIntentOutcomes,
  IntentEvaluationAssertionResult,
  IntentEvaluationResult,
  IntentSemanticRequirements,
} from "../intent/index.js";

export type AdversarialCategory =
  | "PROMPT_INJECTION"
  | "ACTION_SMUGGLING"
  | "ROLE_CONFUSION"
  | "CONSTRAINT_OVERRIDE"
  | "STRUCTURED_OUTPUT_ATTACK"
  | "MALFORMED_INPUT";

export type AdversarialDisposition =
  | "VALID_INTENT"
  | "INVALID_MODEL_OUTPUT"
  | "NEEDS_CLARIFICATION"
  | "REJECT_EXECUTABLE_SEMANTICS";

export type ExecutableOperationName =
  | "TRANSFER"
  | "FX_CONVERT"
  | "MOVE_FUNDS"
  | "PAY_BILL"
  | "BUY_ASSET"
  | "SELL_ASSET";

export interface AdversarialForbiddenOutcomes {
  /** B4a semantic assertions applied after successful IntentDraftV1 validation. */
  readonly semantic?: ForbiddenIntentOutcomes;
  readonly executableOperations?: readonly ExecutableOperationName[];
  readonly approvalOrExecutionAuthority?: boolean;
  readonly canonicalIdFields?: boolean;
  /** Exact invented IDs which must not replace human references in a valid draft. */
  readonly canonicalIdentifiers?: readonly string[];
  readonly unexpectedTrustedFields?: boolean;
}

export interface AdversarialEvaluationCase {
  readonly id: string;
  readonly category: AdversarialCategory;
  readonly description: string;
  readonly inputText: string;
  readonly expected?: IntentSemanticRequirements;
  readonly forbidden: AdversarialForbiddenOutcomes;
  readonly expectedDisposition: AdversarialDisposition;
  /** Additional equally safe outcomes accepted for this adversarial input. */
  readonly acceptedDispositions?: readonly AdversarialDisposition[];
  /** Interpreter-stage expectation when the main disposition depends on later orchestration. */
  readonly interpreterExpectedDisposition?: "VALID_INTENT" | "INVALID_MODEL_OUTPUT" | "REJECT_EXECUTABLE_SEMANTICS";
}

export interface AdversarialEvaluationObservation {
  readonly candidate: unknown;
  /** Supplied by orchestration; this evaluator does not reproduce ambiguity detection. */
  readonly disposition?: "VALID_INTENT" | "NEEDS_CLARIFICATION";
}

export type RuntimeSafetyFindingKind =
  | "EXECUTABLE_FIELD"
  | "EXECUTABLE_OPERATION"
  | "APPROVAL_OR_EXECUTION_AUTHORITY"
  | "CANONICAL_ID_FIELD"
  | "FORBIDDEN_CANONICAL_IDENTIFIER";

export interface RuntimeSafetyFinding {
  readonly kind: RuntimeSafetyFindingKind;
  readonly path: string;
  readonly message: string;
}

export interface TrustBoundaryIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AdversarialEvaluationResult {
  readonly caseId: string;
  readonly status: "PASS" | "FAIL";
  readonly expectedDisposition: AdversarialDisposition;
  readonly actualDisposition: AdversarialDisposition;
  readonly assertions: readonly IntentEvaluationAssertionResult[];
  readonly failureReasons: readonly string[];
  readonly safetyFindings: readonly RuntimeSafetyFinding[];
  readonly trustBoundaryIssues: readonly TrustBoundaryIssue[];
  readonly semanticEvaluation?: IntentEvaluationResult;
}
