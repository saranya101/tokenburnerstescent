import type { IntentDraftV1 } from "../../packages/contracts/src/index.js";
import {
  IntentInterpreterError,
  type IntentInterpreter,
  type IntentValidationIssue,
  type TokenHubConfig,
} from "../../packages/intent-engine/src/index.js";
import {
  ADVERSARIAL_INTENT_CASES,
  DEFAULT_ADVERSARIAL_FORBIDDEN_OUTCOMES,
  evaluateAdversarialCandidate,
  inspectUnsafeIntentCandidate,
  type AdversarialEvaluationCase,
  type RuntimeSafetyFinding,
} from "../adversarial/index.js";
import {
  INTENT_EVALUATION_CASES,
  evaluateIntentDraft,
  type IntentEvaluationAssertionResult,
  type IntentEvaluationCase,
} from "../intent/index.js";
import type {
  BenchmarkActualDisposition,
  BenchmarkAggregateMetrics,
  BenchmarkAssertionFailure,
  BenchmarkCaseResult,
  DatasetMetrics,
  LatencyMetrics,
  SafeBenchmarkConfiguration,
  SafeBenchmarkFailureDiagnostic,
  TokenHubIntentBenchmarkReport,
} from "./types.js";

export type SelectedBenchmarkFixture =
  | { readonly dataset: "semantic"; readonly evaluationCase: IntentEvaluationCase }
  | { readonly dataset: "adversarial"; readonly evaluationCase: AdversarialEvaluationCase };

export interface RunIntentBenchmarkOptions {
  readonly interpreter: IntentInterpreter;
  readonly selection?: string;
  readonly configuration: SafeBenchmarkConfiguration;
  readonly now?: () => number;
  readonly generatedAt?: string;
}

export class BenchmarkSelectionError extends Error {
  readonly name = "BenchmarkSelectionError";
}

export function selectBenchmarkFixtures(selection = "all"): readonly SelectedBenchmarkFixture[] {
  const semantic = INTENT_EVALUATION_CASES.map((evaluationCase) => ({ dataset: "semantic" as const, evaluationCase }));
  const adversarial = ADVERSARIAL_INTENT_CASES.map((evaluationCase) => ({ dataset: "adversarial" as const, evaluationCase }));
  if (selection === "all") return [...semantic, ...adversarial];
  if (selection === "semantic") return semantic;
  if (selection === "adversarial") return adversarial;
  const matches = [...semantic, ...adversarial].filter(({ evaluationCase }) => evaluationCase.id === selection);
  if (matches.length === 0) throw new BenchmarkSelectionError(`Unknown intent evaluation fixture: ${selection}`);
  if (matches.length > 1) throw new BenchmarkSelectionError(`Fixture ID is not unique across datasets: ${selection}`);
  return matches;
}

export function createSafeBenchmarkConfiguration(
  config: TokenHubConfig,
  promptVersion: string,
  selection: string,
): SafeBenchmarkConfiguration {
  return {
    provider: "TokenHub",
    model: config.model,
    thinking: config.thinking ?? "provider-default",
    promptVersion,
    selection,
  };
}

export async function runIntentBenchmark(options: RunIntentBenchmarkOptions): Promise<TokenHubIntentBenchmarkReport> {
  const selection = options.selection ?? "all";
  const fixtures = selectBenchmarkFixtures(selection);
  const now = options.now ?? (() => performance.now());
  const cases: BenchmarkCaseResult[] = [];
  const benchmarkStarted = now();

  for (const fixture of fixtures) {
    const started = now();
    try {
      const draft = await options.interpreter.interpretUserRequest({
        text: fixture.evaluationCase.inputText,
        userId: `intent-live-benchmark:${fixture.evaluationCase.id}`,
      });
      const latencyMs = elapsedMilliseconds(started, now());
      cases.push(evaluateValidatedDraft(fixture, draft, latencyMs));
    } catch (error) {
      const latencyMs = elapsedMilliseconds(started, now());
      cases.push(evaluateInterpreterFailure(fixture, error, latencyMs));
    }
  }

  return {
    schemaVersion: "1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration: { ...options.configuration, selection },
    aggregate: aggregateBenchmarkResults(cases),
    totalDurationMs: elapsedMilliseconds(benchmarkStarted, now()),
    cases,
  };
}

export function aggregateBenchmarkResults(results: readonly BenchmarkCaseResult[]): BenchmarkAggregateMetrics {
  return {
    semantic: datasetMetrics(results, "semantic"),
    adversarial: datasetMetrics(results, "adversarial"),
    safety: {
      executableSemanticsViolations: countCasesWithFinding(results, ["EXECUTABLE_FIELD", "EXECUTABLE_OPERATION"]),
      approvalExecutionAuthorityViolations: countCasesWithFinding(results, ["APPROVAL_OR_EXECUTION_AUTHORITY"]),
      canonicalIdGroundingBypassViolations: countCasesWithFinding(results, ["CANONICAL_ID_FIELD", "FORBIDDEN_CANONICAL_IDENTIFIER"]),
      inventedForbiddenHardConstraints: results.filter((result) => result.semanticAssertionFailures.some((failure) => failure.assertion.includes("forbidden.constraintTypes."))).length,
      missingRequiredHardConstraints: results.filter((result) => result.semanticAssertionFailures.some((failure) => failure.assertion.includes("expected.requiredConstraints."))).length,
    },
    reliability: {
      invalidModelOutputCount: results.filter((result) => result.actualDisposition === "INVALID_MODEL_OUTPUT").length,
      providerModelErrorCount: results.filter((result) => result.actualDisposition === "PROVIDER_ERROR").length,
    },
    latency: calculateLatencyMetrics(results.map((result) => result.latencyMs)),
  };
}

export function calculateLatencyMetrics(durations: readonly number[]): LatencyMetrics {
  if (durations.length === 0) return { minMs: null, medianMs: null, p95Ms: null, maxMs: null };
  const sorted = durations.map((duration) => Math.max(0, Math.round(duration))).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    minMs: sorted[0] ?? null,
    medianMs,
    p95Ms: sorted[p95Index] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}

function evaluateValidatedDraft(
  fixture: SelectedBenchmarkFixture,
  draft: IntentDraftV1,
  latencyMs: number,
): BenchmarkCaseResult {
  if (fixture.dataset === "semantic") {
    const evaluation = evaluateIntentDraft(fixture.evaluationCase, draft);
    const failures = failedAssertions(evaluation.assertions);
    return caseResult({
      fixture,
      expectedDisposition: "VALID_INTENT",
      actualDisposition: "VALID_INTENT",
      passed: evaluation.status === "PASS",
      failures,
      safetyFindings: [],
      latencyMs,
      draft,
    });
  }

  const evaluation = evaluateAdversarialCandidate(fixture.evaluationCase, { candidate: draft });
  const failures = failedAssertions(evaluation.assertions);
  return caseResult({
    fixture,
    expectedDisposition: fixture.evaluationCase.expectedDisposition,
    actualDisposition: evaluation.actualDisposition,
    passed: evaluation.status === "PASS",
    failures,
    safetyFindings: evaluation.safetyFindings,
    latencyMs,
    draft,
  });
}

function evaluateInterpreterFailure(
  fixture: SelectedBenchmarkFixture,
  error: unknown,
  latencyMs: number,
): BenchmarkCaseResult {
  const expectedDisposition = fixture.dataset === "semantic" ? "VALID_INTENT" : fixture.evaluationCase.expectedDisposition;
  if (error instanceof IntentInterpreterError) {
    const diagnostic: SafeBenchmarkFailureDiagnostic = {
      kind: error.code,
      message: error.message,
      ...(error.validationIssues === undefined ? {} : { validationIssues: error.validationIssues }),
      ...(error.modelDiagnostic === undefined ? {} : { modelDiagnostic: error.modelDiagnostic }),
    };
    const safetyFindings = error.code === "INVALID_MODEL_OUTPUT"
      ? findingsFromValidationIssues(error.validationIssues ?? [], fixture)
      : [];
    const hasExecutableOrAuthorityFinding = safetyFindings.some((finding) =>
      finding.kind === "EXECUTABLE_FIELD"
      || finding.kind === "EXECUTABLE_OPERATION"
      || finding.kind === "APPROVAL_OR_EXECUTION_AUTHORITY"
    );
    const actualDisposition: BenchmarkActualDisposition = error.code === "MODEL_ERROR"
      ? "PROVIDER_ERROR"
      : hasExecutableOrAuthorityFinding
        ? "REJECT_EXECUTABLE_SEMANTICS"
        : "INVALID_MODEL_OUTPUT";
    const passed = actualDisposition === expectedDisposition;
    return {
      fixtureId: fixture.evaluationCase.id,
      dataset: fixture.dataset,
      category: fixture.evaluationCase.category,
      expectedDisposition,
      actualDisposition,
      status: passed ? "PASS" : "FAIL",
      semanticAssertionFailures: [],
      safetyFindings,
      latencyMs,
      diagnostic,
      ...(passed ? {} : { inputText: fixture.evaluationCase.inputText }),
    };
  }

  return {
    fixtureId: fixture.evaluationCase.id,
    dataset: fixture.dataset,
    category: fixture.evaluationCase.category,
    expectedDisposition,
    actualDisposition: "PROVIDER_ERROR",
    status: "FAIL",
    semanticAssertionFailures: [],
    safetyFindings: [],
    latencyMs,
    diagnostic: { kind: "UNEXPECTED_ERROR", message: "The benchmark case failed without a sanitized interpreter diagnostic." },
    inputText: fixture.evaluationCase.inputText,
  };
}

function findingsFromValidationIssues(
  issues: readonly IntentValidationIssue[],
  fixture: SelectedBenchmarkFixture,
): readonly RuntimeSafetyFinding[] {
  const keys = issues.flatMap((issue) => issue.keys ?? []);
  if (keys.length === 0) return [];
  const diagnosticShape = Object.fromEntries(keys.map((key) => [key, true]));
  const forbidden = fixture.dataset === "adversarial"
    ? fixture.evaluationCase.forbidden
    : DEFAULT_ADVERSARIAL_FORBIDDEN_OUTCOMES;
  return inspectUnsafeIntentCandidate(diagnosticShape, forbidden);
}

function caseResult(input: {
  readonly fixture: SelectedBenchmarkFixture;
  readonly expectedDisposition: string;
  readonly actualDisposition: BenchmarkActualDisposition;
  readonly passed: boolean;
  readonly failures: readonly BenchmarkAssertionFailure[];
  readonly safetyFindings: readonly RuntimeSafetyFinding[];
  readonly latencyMs: number;
  readonly draft: IntentDraftV1;
}): BenchmarkCaseResult {
  return {
    fixtureId: input.fixture.evaluationCase.id,
    dataset: input.fixture.dataset,
    category: input.fixture.evaluationCase.category,
    expectedDisposition: input.expectedDisposition,
    actualDisposition: input.actualDisposition,
    status: input.passed ? "PASS" : "FAIL",
    semanticAssertionFailures: input.failures,
    safetyFindings: input.safetyFindings,
    latencyMs: input.latencyMs,
    ...(input.passed ? {} : { inputText: input.fixture.evaluationCase.inputText, validatedIntent: input.draft }),
  };
}

function failedAssertions(assertions: readonly IntentEvaluationAssertionResult[]): BenchmarkAssertionFailure[] {
  return assertions.flatMap((assertion) => assertion.status === "PASS" ? [] : [{
    assertion: assertion.assertion,
    reason: assertion.failureReason ?? "Assertion failed.",
  }]);
}

function datasetMetrics(results: readonly BenchmarkCaseResult[], dataset: "semantic" | "adversarial"): DatasetMetrics {
  const selected = results.filter((result) => result.dataset === dataset);
  const passed = selected.filter((result) => result.status === "PASS").length;
  return {
    total: selected.length,
    passed,
    failed: selected.length - passed,
    passRatePercent: selected.length === 0 ? null : Math.round((passed / selected.length) * 1000) / 10,
  };
}

function countCasesWithFinding(
  results: readonly BenchmarkCaseResult[],
  kinds: readonly RuntimeSafetyFinding["kind"][],
): number {
  const expected = new Set(kinds);
  return results.filter((result) => result.safetyFindings.some((finding) => expected.has(finding.kind))).length;
}

function elapsedMilliseconds(started: number, ended: number): number {
  return Math.max(0, Math.round(ended - started));
}
