import type { IntentDraftV1 } from "../../packages/contracts/src/index.js";
import type { IntentValidationIssue, ModelClientDiagnostic, TokenHubThinkingMode } from "../../packages/intent-engine/src/index.js";
import type { RuntimeSafetyFinding } from "../adversarial/index.js";

export type BenchmarkDataset = "semantic" | "adversarial";
export type BenchmarkActualDisposition =
  | "VALID_INTENT"
  | "INVALID_MODEL_OUTPUT"
  | "NEEDS_CLARIFICATION"
  | "REJECT_EXECUTABLE_SEMANTICS"
  | "PROVIDER_ERROR";

export interface SafeBenchmarkConfiguration {
  readonly provider: "TokenHub";
  readonly model: string;
  readonly thinking: TokenHubThinkingMode | "provider-default";
  readonly promptVersion: string;
  readonly selection: string;
}

export interface BenchmarkAssertionFailure {
  readonly assertion: string;
  readonly reason: string;
}

export interface SafeBenchmarkFailureDiagnostic {
  readonly kind: "EMPTY_INPUT" | "INVALID_MODEL_OUTPUT" | "MODEL_ERROR" | "UNEXPECTED_ERROR";
  readonly message: string;
  readonly validationIssues?: readonly IntentValidationIssue[];
  readonly modelDiagnostic?: ModelClientDiagnostic;
}

export interface BenchmarkCaseResult {
  readonly fixtureId: string;
  readonly dataset: BenchmarkDataset;
  readonly category: string;
  readonly expectedDisposition: string;
  readonly actualDisposition: BenchmarkActualDisposition;
  readonly status: "PASS" | "FAIL";
  readonly semanticAssertionFailures: readonly BenchmarkAssertionFailure[];
  readonly safetyFindings: readonly RuntimeSafetyFinding[];
  readonly latencyMs: number;
  readonly diagnostic?: SafeBenchmarkFailureDiagnostic;
  /** Synthetic fixture language is retained only when a case fails. */
  readonly inputText?: string;
  /** This is validated IntentDraftV1 output, never a raw provider response. */
  readonly validatedIntent?: IntentDraftV1;
}

export interface DatasetMetrics {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRatePercent: number | null;
}

export interface SafetyMetrics {
  readonly executableSemanticsViolations: number;
  readonly approvalExecutionAuthorityViolations: number;
  readonly canonicalIdGroundingBypassViolations: number;
  readonly inventedForbiddenHardConstraints: number;
  readonly missingRequiredHardConstraints: number;
}

export interface ReliabilityMetrics {
  readonly invalidModelOutputCount: number;
  readonly providerModelErrorCount: number;
}

export interface LatencyMetrics {
  readonly minMs: number | null;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface BenchmarkAggregateMetrics {
  readonly semantic: DatasetMetrics;
  readonly adversarial: DatasetMetrics;
  readonly safety: SafetyMetrics;
  readonly reliability: ReliabilityMetrics;
  readonly latency: LatencyMetrics;
}

export interface TokenHubIntentBenchmarkReport {
  readonly schemaVersion: "1";
  readonly generatedAt: string;
  readonly configuration: SafeBenchmarkConfiguration;
  readonly aggregate: BenchmarkAggregateMetrics;
  readonly totalDurationMs: number;
  readonly cases: readonly BenchmarkCaseResult[];
}
